#!/usr/bin/env node
// research-run.js — the owner's research runs (research.js does the arithmetic; this file does the I/O).
//
// Collects a set of Hyperliquid wallets, reads their public fills (the exchange's API, or the archive's
// index by wallet when one is configured), rebuilds their trades with the app's own engine (the same
// functions server.js extracts from ledger.html), and writes one report:
//   1. what each of the six slips costs, measured inside each wallet (slipped vs not, same situation)
//   2. whether results persist from one quarter to the next (skill or luck), and how many trades a
//      ranking needs before it means something; whether Discipline this month predicts next month
//   4. "traders like you who improved", rebuilt from fill histories (weekly 90-day summaries, the
//      same peerSummary and Bench.buildImprovers the server uses), and whether the improvement lasted
//   8. market views: how the sample is positioned per coin over time, by size group and by skill tier,
//      how they trade around liquidation clusters, and whether a skill tier's net flow led the price
//
// Usage:
//   node research-run.js --sample 600                     # random wallets from Hyperliquid's leaderboard
//   node research-run.js --addresses wallets.txt          # every 0x address in a text file
//   node research-run.js --data-dir ./data                # the server's seed wallets, entered wallets, members
//   options: --days 300 (look-back)  --cache DIR (default ./research-cache)  --out DIR (default the cache)
//            --delay 1200 (ms between exchange requests)  --source api|index  --fetch-only  --analyze-only
//            --seed 1 (the sampler's seed)  --max-fills 20000 (more is a bot or market maker; left out)
// The archive index needs ARCHIVE_AWS_KEY_ID, ARCHIVE_AWS_SECRET and ARCHIVE_INDEX_BUCKET (see archive.js).
// Everything read is cached under --cache, so a run can stop and pick up where it left off.
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const R = require(path.join(__dirname, 'research.js'));

const DAY = 86400000, API = 'https://api.hyperliquid.xyz/info', ADDR_RE = /0x[0-9a-fA-F]{40}/g;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = ms => new Promise(r => setTimeout(r, ms));

function args(argv) {
  const o = { days: 300, delay: 1200, source: 'api', seed: 1, maxFills: 20000 };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i].replace(/^--/, ''), v = argv[i + 1];
    if (k === 'fetch-only') o.fetchOnly = true; else if (k === 'analyze-only') o.analyzeOnly = true; else if (k === 'offline') o.offline = true;
    else if (k === 'sample') { o.sample = +v; i++; } else if (k === 'addresses') { o.addresses = v; i++; }
    else if (k === 'data-dir') { o.dataDir = v; i++; } else if (k === 'days') { o.days = +v; i++; }
    else if (k === 'cache') { o.cache = v; i++; } else if (k === 'out') { o.out = v; i++; }
    else if (k === 'delay') { o.delay = +v; i++; } else if (k === 'source') { o.source = v; i++; }
    else if (k === 'seed') { o.seed = +v; i++; } else if (k === 'max-fills') { o.maxFills = +v; i++; }
    else if (k === 'help' || k === 'h') o.help = true;
    else throw new Error('unknown option --' + k);
  }
  o.cache = path.resolve(o.cache || 'research-cache'); o.out = path.resolve(o.out || o.cache);
  return o;
}

const gzWrite = (file, obj) => { const tmp = file + '.tmp'; fs.writeFileSync(tmp, zlib.gzipSync(JSON.stringify(obj))); fs.renameSync(tmp, file); };
const gzRead = file => { try { return JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8')); } catch (e) { return null; } };

// one request to the exchange's info endpoint, paced: every call waits its turn, and a 429 or 5xx backs off
let nextAt = 0;
async function info(body, delay) {
  for (let attempt = 0; ; attempt++) {
    const wait = nextAt - Date.now(); if (wait > 0) await sleep(wait); nextAt = Date.now() + delay;
    let res; try { res = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(60000) }); }
    catch (e) { if (attempt < 5) { await sleep(2000 * (attempt + 1)); continue; } throw e; }
    if (res.ok) return res.json();
    if ((res.status === 429 || res.status >= 500) && attempt < 6) { const back = Math.min(60000, 5000 * 2 ** attempt); log('exchange said ' + res.status + ', waiting ' + back / 1000 + 's'); nextAt = Date.now() + back; continue; }
    throw new Error('API ' + res.status);
  }
}

/* ---------------- which wallets ---------------- */
// a seeded shuffle, so a sample can be drawn again
function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
async function sampleLeaderboard(o) {
  const file = path.join(o.cache, 'leaderboard.json'); let rows = null;
  try { rows = JSON.parse(fs.readFileSync(file, 'utf8')).leaderboardRows; } catch (e) {}
  if (!rows) { log('reading the leaderboard (every account with recent activity)…');
    const res = await fetch('https://stats-data.hyperliquid.xyz/Mainnet/leaderboard', { signal: AbortSignal.timeout(120000) });
    if (!res.ok) throw new Error('leaderboard ' + res.status); const txt = await res.text(); fs.writeFileSync(file, txt); rows = JSON.parse(txt).leaderboardRows; }
  // accounts that traded in the last month: the population the sample is drawn from (an account that stopped
  // trading before that can't be sampled, so blow-ups older than a month are under-represented)
  const vol = x => { const p = (x.windowPerformances || []).find(y => y[0] === 'month'); return p ? +p[1].vlm || 0 : 0; };
  const pool = rows.filter(x => vol(x) > 0).map(x => String(x.ethAddress).toLowerCase()).filter(a => /^0x[0-9a-f]{40}$/.test(a));
  const r = rng(o.seed); for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  log('sampled ' + Math.min(o.sample, pool.length) + ' of ' + pool.length + ' accounts active in the last month');
  return { addresses: pool.slice(0, o.sample), frame: { kind: 'leaderboard', population: pool.length, seed: o.seed } };
}
// the server's own wallets: seed wallets, wallets entered in the app, and members' wallets (DATA_DIR/pulse.db, read only)
function fromDataDir(dir) {
  const emit = process.emitWarning; process.emitWarning = () => {};
  let D; try { D = require('node:sqlite').DatabaseSync; } finally { process.emitWarning = emit; }
  const db = new D(path.join(dir, 'pulse.db'), { readOnly: true }), out = new Set();
  try {
    const kv = k => { const r = db.prepare('SELECT v FROM kv WHERE k = ?').get(k); try { return r ? JSON.parse(r.v) : null; } catch (e) { return null; } };
    for (const k of ['benchSeeds', 'walletsSeen']) for (const a of Object.keys(kv(k) || {})) out.add(a.toLowerCase());
    for (const a of Object.keys(kv('wallets') || {})) out.add(a.toLowerCase()); // wallets mapped to members
    for (const r of db.prepare('SELECT data FROM members').all()) { try { const m = JSON.parse(r.data);
      for (const a of [m.address, m.claimed, ...(Array.isArray(m.wallets) ? m.wallets : [])]) if (typeof a === 'string') out.add(a.toLowerCase()); } catch (e) {} }
  } finally { db.close(); }
  return [...out].filter(a => /^0x[0-9a-f]{40}$/.test(a));
}
async function addressesFor(o) {
  const set = new Map(); let frame = null;
  if (o.addresses) for (const a of (fs.readFileSync(o.addresses, 'utf8').match(ADDR_RE) || [])) set.set(a.toLowerCase(), 'file');
  if (o.dataDir) for (const a of fromDataDir(o.dataDir)) set.set(a, 'server');
  if (o.sample > 0) { const s = await sampleLeaderboard(o); frame = s.frame; for (const a of s.addresses) if (!set.has(a)) set.set(a, 'sample'); }
  return { list: [...set.keys()], from: Object.fromEntries(set), frame };
}

/* ---------------- fills ---------------- */
// a wallet's fills over the look-back, oldest first. The API serves the newest 10,000 fills of an address at
// most: a wallet that hits that has its window cut short (`from` says where its history really starts).
async function fillsFromApi(a, o) {
  const t = Date.now(), fills = [], seen = new Set(); let start = t - o.days * DAY, pages = 0;
  for (;;) {
    if (fills.length > o.maxFills) return { bot: true, n: fills.length };
    const batch = await info({ type: 'userFillsByTime', user: a, startTime: start, aggregateByTime: true }, o.delay); pages++;
    if (!Array.isArray(batch) || !batch.length) break;
    for (const f of batch) { const id = f.tid + '-' + f.oid + '-' + f.time; if (!seen.has(id)) { seen.add(id); fills.push(f); } }
    if (batch.length < 2000) break;
    const mx = Math.max(...batch.map(f => f.time)); start = mx > start ? mx : mx + 1;
    if (pages > 30) break;
  }
  fills.sort((x, y) => x.time - y.time);
  const cut = fills.length >= 9900; // the API's cap: older fills exist that it no longer serves
  return { fills, from: cut && fills.length ? fills[0].time : t - o.days * DAY, to: t, cut };
}
let archive = null;
async function fillsFromIndex(a, o) {
  if (!archive) { const A = require(path.join(__dirname, 'archive.js')); archive = A.createArchive({ env: process.env, fetchImpl: (...x) => globalThis.fetch(...x), now: Date.now, engine: {} }); }
  const t = Date.now(), fromDay = new Date(t - o.days * DAY).toISOString().slice(0, 10).replace(/-/g, '');
  const r = await archive.indexFills(a, fromDay), fills = (r && r.fills || []).slice().sort((x, y) => x.time - y.time);
  if (fills.length > o.maxFills * (o.days / 90)) return { bot: true, n: fills.length };
  return { fills, from: t - o.days * DAY, to: t, cut: false };
}
async function collect(o, list) {
  const dir = path.join(o.cache, 'fills'); fs.mkdirSync(dir, { recursive: true });
  let done = 0, bots = 0, fresh = 0;
  for (const a of list) {
    const file = path.join(dir, a + '.json.gz'), have = fs.existsSync(file) ? gzRead(file) : null;
    if (have && Date.now() - (have.at || 0) < 7 * DAY) { done++; continue; }
    try {
      const r = o.source === 'index' ? await fillsFromIndex(a, o) : await fillsFromApi(a, o);
      gzWrite(file, Object.assign({ addr: a, at: Date.now(), days: o.days }, r)); fresh++;
      if (r.bot) bots++;
    } catch (e) { log(a + ': ' + e.message); }
    done++;
    if (done % 25 === 0) log(done + '/' + list.length + ' wallets read (' + fresh + ' new, ' + bots + ' left out as bots)');
  }
  log('fills: ' + done + ' wallets, ' + fresh + ' read now, ' + bots + ' bots or market makers');
}
// hourly candles for the coins the market views look at (cached per coin)
async function candles(o, coins, from, to) {
  const dir = path.join(o.cache, 'candles'); fs.mkdirSync(dir, { recursive: true }); const out = {};
  for (const c of coins) {
    const file = path.join(dir, encodeURIComponent(c) + '.json.gz'), have = gzRead(file);
    if (have && have.from <= from && have.to >= to - 2 * 3600000) { out[c] = have.rows; continue; }
    const rows = []; let s = from;
    while (s < to) { const e = Math.min(to, s + 4000 * 3600000);
      const b = await info({ type: 'candleSnapshot', req: { coin: c, interval: '1h', startTime: s, endTime: e } }, o.delay).catch(() => []);
      for (const k of Array.isArray(b) ? b : []) rows.push([k.t, +k.c]); s = e; }
    const uniq = [...new Map(rows.map(r => [r[0], r])).values()].sort((x, y) => x[0] - y[0]);
    gzWrite(file, { from, to, rows: uniq }); out[c] = uniq;
  }
  return out;
}

/* ---------------- trades, with the app's own engine ---------------- */
function engine() {
  const { buildEngine } = require(path.join(__dirname, 'server.js'));
  const e = buildEngine(path.join(__dirname, 'ledger.html'), () => { throw new Error('no network in the engine'); });
  if (!e.ok) throw new Error('the engine could not be built: ' + e.missing.join(', '));
  return e.ctx;
}
function tradesOf(E, rec) {
  const built = [...E.attributeFunding(E.reconstructTrades(rec.fills, rec.addr, 'perp'), []), ...E.attributeFunding(E.reconstructTrades(rec.fills, rec.addr, 'spot'), [])];
  return built.filter(t => E.tradeRow(t) && !t.movedOut && !t.isOpen && t.closeTime);
}

async function main() {
  const o = args(process.argv);
  if (o.help || (!o.sample && !o.addresses && !o.dataDir && !o.analyzeOnly)) { console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(1, 25).map(l => l.replace(/^\/\/ ?/, '')).join('\n')); return; }
  fs.mkdirSync(o.cache, { recursive: true }); fs.mkdirSync(o.out, { recursive: true });
  const listFile = path.join(o.cache, 'wallets.json');
  let W = null; try { W = JSON.parse(fs.readFileSync(listFile, 'utf8')); } catch (e) {}
  if (!o.analyzeOnly) { const got = await addressesFor(o);
    W = { list: [...new Set([...(W ? W.list : []), ...got.list])], from: Object.assign({}, W && W.from, got.from), frame: got.frame || (W && W.frame) || null };
    fs.writeFileSync(listFile, JSON.stringify(W)); await collect(o, got.list); }
  if (o.fetchOnly) return;
  if (!W || !W.list.length) throw new Error('no wallets yet: run with --sample, --addresses or --data-dir first');

  log('rebuilding trades…'); const E = engine(), records = [];
  let bots = 0, empty = 0;
  for (const a of W.list) {
    const rec = gzRead(path.join(o.cache, 'fills', a + '.json.gz')); if (!rec) continue;
    if (rec.bot) { bots++; continue; } if (!rec.fills || !rec.fills.length) { empty++; continue; }
    let trades; try { trades = tradesOf(E, rec); } catch (e) { log(a + ': trades failed: ' + e.message); continue; }
    const r = R.walletRecord(trades, { addr: a, from: rec.from, to: rec.to, cut: rec.cut, fills: rec.fills, pzBehaviorDays: E.pzBehaviorDays, peerSummary: E.peerSummary, notionalOf: E.notionalOf, hasAdd: E.hasAdd });
    if (r) records.push(r);
  }
  log(records.length + ' wallets with trades (' + bots + ' bots left out, ' + empty + ' with no fills)');
  const mv = R.marketCoins(records, { top: 12 }), span = R.spanOf(records);
  const px = mv.length && !o.offline ? await candles(o, mv, span.from, span.to) : {};
  const report = R.buildReport(records, { prices: px, frame: W.frame, bots, empty, sources: W.from });
  const json = path.join(o.out, 'research-report.json'), html = path.join(o.out, 'research-report.html');
  fs.writeFileSync(json, JSON.stringify(report, null, 1)); fs.writeFileSync(html, R.reportHtml(report));
  console.log('\n' + R.reportText(report) + '\n');
  log('wrote ' + json + ' and ' + html);
}
if (require.main === module) main().catch(e => { console.error(e.stack || e.message); process.exit(1); });
module.exports = { args, sampleLeaderboard, fromDataDir, tradesOf };
