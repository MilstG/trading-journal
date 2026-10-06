'use strict';
// research-job.js — the research report (research.js) run by the server on its own wallets, from Admin → Research.
//
// One run at a time. The main thread reads each wallet's public fills from the exchange, one request at a time and
// a little apart (as the seed wallets are read), and keeps them in DATA_DIR/research/fills for a day; then hourly
// candles for the coins the market views look at. The heavy part — trades rebuilt with the app's engine, the
// weekly summaries, every bootstrap — runs in a worker thread, so the server keeps answering while it works.
// The finished report is kept in DATA_DIR/research (report.json.gz and report.html) and survives a restart.
// research-run.js, the command-line runner, shares the readers below.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

const DAY = 86400000, HOUR = 3600000;
const gzWrite = (file, obj) => { const tmp = file + '.tmp'; fs.writeFileSync(tmp, zlib.gzipSync(JSON.stringify(obj))); fs.renameSync(tmp, file); };
const gzRead = file => { try { return JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8')); } catch (e) { return null; } };

/* ---------------- readers (post: one call to the exchange's info endpoint) ---------------- */
// a wallet's fills over the look-back, oldest first. The exchange serves an address's newest 10,000 fills at most:
// a wallet that hits that has its window cut short (`from` says where its history really starts). More than
// maxFills is a bot or a market maker, left out.
async function fillsFor(post, addr, o) {
  o = Object.assign({ days: 300, maxFills: 20000, now: Date.now() }, o || {});
  const t = o.now, fills = [], seen = new Set(); let start = t - o.days * DAY, pages = 0;
  for (;;) {
    if (fills.length > o.maxFills) return { bot: true, n: fills.length };
    const batch = await post({ type: 'userFillsByTime', user: addr, startTime: start, aggregateByTime: true }); pages++;
    if (!Array.isArray(batch) || !batch.length) break;
    for (const f of batch) { const id = f.tid + '-' + f.oid + '-' + f.time; if (!seen.has(id)) { seen.add(id); fills.push(f); } }
    if (batch.length < 2000 || pages > 30) break;
    const mx = Math.max(...batch.map(f => f.time)); start = mx > start ? mx : mx + 1;
  }
  fills.sort((x, y) => x.time - y.time);
  const cut = fills.length >= 9900;
  return { fills, from: cut && fills.length ? fills[0].time : t - o.days * DAY, to: t, cut };
}
// hourly closes [[open ms, close]] for one coin (the exchange serves the newest 5,000)
async function candlesFor(post, coin, from, to) {
  const rows = []; let s = from;
  while (s < to) { const e = Math.min(to, s + 4000 * HOUR);
    const b = await post({ type: 'candleSnapshot', req: { coin, interval: '1h', startTime: s, endTime: e } }).catch(() => []);
    for (const k of Array.isArray(b) ? b : []) rows.push([k.t, +k.c]); s = e; }
  return [...new Map(rows.map(r => [r[0], r])).values()].sort((x, y) => x[0] - y[0]);
}
// a cached wallet -> its closed trades, rebuilt with the engine the server extracts from ledger.html
function tradesOf(E, rec) {
  const built = [...E.attributeFunding(E.reconstructTrades(rec.fills, rec.addr, 'perp'), []), ...E.attributeFunding(E.reconstructTrades(rec.fills, rec.addr, 'spot'), [])];
  return built.filter(t => E.tradeRow(t) && !t.movedOut && !t.isOpen && t.closeTime);
}
function recordOf(R, E, rec) {
  return R.walletRecord(tradesOf(E, rec), { addr: rec.addr, from: rec.from, to: rec.to, cut: rec.cut, fills: rec.fills,
    pzBehaviorDays: E.pzBehaviorDays, peerSummary: E.peerSummary, notionalOf: E.notionalOf, hasAdd: E.hasAdd });
}

/* ---------------- the worker: cached fills -> records -> report ---------------- */
// d: {files: [fill cache paths], prices: {coin: rows} | null, pricesFor: true when the coins are still to be chosen,
// members, frame, htmlPath, iters}. With pricesFor, it answers {coins, span} first and waits for {prices}.
function workerMain(d) {
  const R = require(path.join(__dirname, 'research.js'));
  const { buildEngine } = require(path.join(__dirname, 'server.js'));
  const eng = buildEngine(d.htmlPath, () => { throw new Error('no network in the research worker'); });
  if (!eng.ok) { parentPort.postMessage({ error: 'the trade engine is missing: ' + eng.missing.join(', ') }); return; }
  const records = []; let bots = 0, empty = 0;
  d.files.forEach((f, i) => { const rec = gzRead(f); if (!rec) return;
    if (rec.bot) bots++; else if (!rec.fills || !rec.fills.length) empty++;
    else { try { const r = recordOf(R, eng.ctx, rec); if (r) records.push(r); } catch (e) { /* one bad history doesn't stop the run */ } }
    if (i % 10 === 9) parentPort.postMessage({ progress: i + 1 }); });
  const finish = prices => {
    const report = R.buildReport(records, { prices, members: d.members, frame: d.frame, bots, empty, iters: d.iters });
    parentPort.postMessage({ report, html: R.reportHtml(report), text: R.reportText(report) });
  };
  parentPort.postMessage({ coins: R.marketCoins(records, { top: 12 }), span: R.spanOf(records) });
  parentPort.once('message', m => { try { finish(m.prices || {}); } catch (e) { parentPort.postMessage({ error: e.message }); } });
}
if (!isMainThread && workerData && workerData.researchJob) { try { workerMain(workerData); } catch (e) { parentPort.postMessage({ error: e.message }); } }

/* ---------------- the job ---------------- */
// deps: {dataDir, post (the exchange, with retries), htmlPath, now, delay (ms between requests), sleep, iters}
function createResearchJob(deps) {
  const dir = path.join(deps.dataDir, 'research'), fdir = path.join(dir, 'fills'), cdir = path.join(dir, 'candles');
  const now = deps.now || Date.now, sleep = deps.sleep || (ms => new Promise(r => setTimeout(r, ms)));
  const delay = deps.delay != null ? deps.delay : 1500;
  let st = { state: 'idle' }, stopped = false, worker = null;
  // the last finished report, kept across restarts
  let last = gzRead(path.join(dir, 'report.json.gz'));
  if (last && last.status) st = Object.assign({}, last.status, { state: last.status.state === 'running' ? 'idle' : last.status.state });
  const paced = async body => { await sleep(delay); return deps.post(body); };
  const fileOf = a => path.join(fdir, a + '.json.gz');
  async function run(addresses, o) {
    fs.mkdirSync(fdir, { recursive: true }); fs.mkdirSync(cdir, { recursive: true });
    const t = now(), files = [];
    for (const a of addresses) {
      if (stopped) throw Object.assign(new Error('stopped'), { stopped: true });
      const f = fileOf(a), have = gzRead(f);
      if (!(have && t - (have.at || 0) < DAY)) {
        try { const r = await fillsFor(paced, a, { days: o.days, now: t }); gzWrite(f, Object.assign({ addr: a, at: now(), days: o.days }, r)); if (r.bot) st.bots++; }
        catch (e) { st.failed++; st.done++; continue; }
      } else if (have.bot) st.bots++;
      files.push(f); st.done++;
    }
    st.phase = 'analysis';
    const out = await new Promise((resolve, reject) => {
      worker = new Worker(__filename, { workerData: { researchJob: true, files, members: o.members, frame: o.frame, htmlPath: deps.htmlPath, iters: deps.iters || 500 } });
      worker.on('message', async m => {
        if (m.error) return reject(new Error(m.error));
        if (m.progress) { st.analysed = m.progress; return; }
        if (m.coins) { // the coins to price: hourly candles, cached for a day
          st.phase = 'prices'; const prices = {};
          for (const c of m.coins) { if (stopped) break;
            const cf = path.join(cdir, encodeURIComponent(c) + '.json.gz'), have = gzRead(cf);
            if (have && now() - (have.at || 0) < DAY && have.from <= m.span.from) { prices[c] = have.rows; continue; }
            try { const rows = await candlesFor(paced, c, m.span.from, m.span.to); gzWrite(cf, { at: now(), from: m.span.from, to: m.span.to, rows }); prices[c] = rows; } catch (e) {} }
          st.phase = 'analysis'; worker.postMessage({ prices }); return; }
        if (m.report) resolve(m);
      });
      worker.on('error', reject);
      worker.on('exit', code => { worker = null; if (code) reject(new Error(stopped ? 'stopped' : 'the analysis stopped (exit ' + code + ')')); });
    });
    return out;
  }
  function status() { return Object.assign({}, st, { hasReport: !!(last && last.report) }); }
  function start(o) {
    if (st.state === 'running') throw Object.assign(new Error('A run is already going.'), { code: 409 });
    const addresses = [...new Set((o.addresses || []).map(a => String(a).toLowerCase()).filter(a => /^0x[0-9a-f]{40}$/.test(a)))];
    if (!addresses.length) throw Object.assign(new Error('There are no wallets to read.'), { code: 400 });
    stopped = false;
    st = { state: 'running', phase: 'fills', scope: o.scope || 'members', by: o.by || null, total: addresses.length, done: 0, bots: 0, failed: 0, analysed: 0, startedAt: now() };
    run(addresses, { days: o.days || 300, members: o.members || null, frame: { kind: o.scope || 'members', wallets: addresses.length } })
      .then(m => { st = Object.assign({}, st, { state: 'done', phase: null, finishedAt: now() });
        last = { status: st, report: m.report, text: m.text }; fs.mkdirSync(dir, { recursive: true });
        gzWrite(path.join(dir, 'report.json.gz'), last); fs.writeFileSync(path.join(dir, 'report.html'), m.html); })
      .catch(e => { st = Object.assign({}, st, { state: e.stopped || stopped ? 'stopped' : 'error', phase: null, finishedAt: now(), error: e.stopped || stopped ? null : String(e.message || e).slice(0, 200) });
        if (last) last.status = st; });
    return status();
  }
  function stop() { stopped = true; if (worker) worker.terminate().catch(() => {}); }
  return { start, stop, status, report: () => last && last.report ? { report: last.report, text: last.text, status: last.status } : null,
    html: () => { try { return fs.readFileSync(path.join(dir, 'report.html'), 'utf8'); } catch (e) { return null; } } };
}

module.exports = { createResearchJob, fillsFor, candlesFor, tradesOf, recordOf };
