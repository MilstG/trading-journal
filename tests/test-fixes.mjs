// Regression tests for the third review round: DST-safe day stepping, flip fills split between
// trades, the exchange's 10k-fill window, coin-name validation, attachment ids, process-score
// gating by rule and habit dates, "journaled" including mistakes, per-wallet spot lots,
// inclusive API date bounds, and the model-gated coach letter request.
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import zlib from 'node:zlib';
import vm from 'node:vm';
import { t, ok, eq, near, report, makeExtractor } from './harness.mjs';
import { readAppSource } from '../app-source.js'; // ledger.html with its app/*.js inlined, in load order

const require = createRequire(import.meta.url);
const server = require('../server.js');
const htmlPath = new URL('../ledger.html', import.meta.url).pathname;
const html = readAppSource(htmlPath);
const { grabFn } = makeExtractor(html);

const DAY = 86400000;

console.log('\nDay stepping across DST');
// runs in a child so TZ can be set: Santiago's DST starts at midnight, so that day begins at 01:00
const dstScript = `
  const html = require(${JSON.stringify(new URL('../app-source.js', import.meta.url).pathname)}).readAppSource(${JSON.stringify(htmlPath)});
  const grab = n => { const i = html.indexOf('function ' + n + '('); let d = 0, j = html.indexOf('{', i);
    for (;; j++) { if (html[j] === '{') d++; else if (html[j] === '}' && --d === 0) break; } return (0, eval)('(' + html.slice(i, j + 1) + ')'); };
  globalThis.settings = { tz: 'local' };
  for (const n of ['tzParts', 'tzMidnight', 'addDays', 'dailySeriesCalendar']) globalThis[n] = grab(n);
  globalThis.dayKey = ms => { const p = tzParts(ms); return p.y + '-' + String(p.mo + 1).padStart(2, '0') + '-' + String(p.day).padStart(2, '0'); };
  const tr = [5, 6, 7, 8, 9, 10].map(d => ({ closeTime: new Date(2025, 8, d, 15).getTime(), net: 10, isOpen: false }));
  process.stdout.write(JSON.stringify(dailySeriesCalendar(tr)));`;
for (const tz of ['America/Santiago', 'Europe/Berlin', 'UTC']) {
  t('daily series keeps every day in ' + tz, () => {
    const r = spawnSync(process.execPath, ['-e', dstScript], { env: { ...process.env, TZ: tz }, encoding: 'utf8' });
    eq(JSON.parse(r.stdout || 'null'), [10, 10, 10, 10, 10, 10], r.stderr);
  });
}

console.log('\nReconstruction: flip fills');
const recon = { Date, Math, parseFloat, isFinite, Object, Array };
recon.isPerp = c => !/[/@]/.test(c);
vm.createContext(recon);
vm.runInContext(['newTrade', 'tallyFill', 'reconstructTrades'].map(grabFn).join('\n'), recon);
t('a flip fill splits notional and fee by size between the trade it closes and the one it opens', () => {
  const T = Date.UTC(2026, 0, 1);
  const f = (side, sz, px, startPosition, fee, time) => ({ coin: 'ETH', side, sz: String(sz), px: String(px), startPosition: String(startPosition), fee: String(fee), closedPnl: '0', crossed: true, time, tid: time, oid: time });
  const tr = recon.reconstructTrades([f('B', 1, 100, 0, 1, T), f('A', 2, 110, 1, 4, T + 1000), f('B', 1, 105, -1, 1, T + 2000)], 'x', 'perp');
  const byOpen = [...tr].sort((a, b) => a.openTime - b.openTime);
  near(byOpen[0].takerNotional, 100 + 110, 1e-9); near(byOpen[1].takerNotional, 110 + 105, 1e-9);
  near(tr.reduce((s, x) => s + x.takerNotional, 0), 100 + 220 + 105, 1e-9, 'total notional = what actually traded');
  near(byOpen[0].fees, 1 + 2, 1e-9); near(byOpen[1].fees, 2 + 1, 1e-9);
  near(tr.reduce((s, x) => s + x.fees, 0), 6, 1e-9, 'fees are not double counted');
});

console.log('\nFill window');
await t('a fetch that reaches the exchange’s 10,000-fill window is flagged as possibly truncated', async () => {
  const ctx = { Math, Set, Array, setStatus: () => {}, sleep: async () => {} };
  let page = 0;
  ctx.hlPost = async (req) => { if (req.type !== 'userFillsByTime') return [];
    const n = page < 5 ? 2000 : 0; const b = Array.from({ length: n }, (_, i) => ({ tid: page * 2000 + i, oid: 1, time: 1000 + page * 2000 + i })); page++; return b; };
  vm.createContext(ctx); vm.runInContext(grabFn('fetchAllFills') + '\n' + grabFn('fetchTwapFills'), ctx); // the TWAP slices ride along with the fills
  const r = await ctx.fetchAllFills('0xabc', 0);
  eq(r.fills.length, 10000); eq(r.truncated, true);
  page = 4; const small = await ctx.fetchAllFills('0xabc', 0);
  eq(small.fills.length, 2000); eq(small.truncated, false);
});

console.log('\nUntrusted ids');
t('coin names outside exchange-style symbols are refused at import', () => {
  const safeCoin = (0, eval)('(' + grabFn('safeCoin') + ')');
  for (const c of ['ETH', 'kPEPE', '@210', 'PURR/USDC', 'xyz:MU']) ok(safeCoin(c), c);
  for (const c of ['X"><img src=x>', "a'b", 'a b', '', 'x'.repeat(60), null]) ok(!safeCoin(c), String(c));
});
t('trade ids never enter markup unescaped, and attachment delete splits on the LAST colon', () => {
  ok(!/data-(id|save|att|replay|att-view|att-del)="\$\{(t\.)?id\}/.test(html));
  ok(html.includes("const v=del.dataset.attDel, k=v.lastIndexOf(':'); removeAttachment(v.slice(0,k),+v.slice(k+1));"));
});

console.log('\nProcess score gating');
const pctx = { Date, Math, Object, Set, Map, JSON, isFinite, journal: {}, _excM: {} };
Object.assign(pctx, { isWin: n => n > 50, isLoss: n => n < -50, dcoin: x => x.coin, _avg: a => a.reduce((s, x) => s + x, 0) / a.length });
vm.createContext(pctx);
const grabConst = (name) => { const i = html.indexOf('const ' + name + '='); return html.slice(i, html.indexOf(';\n', i) + 1); };
vm.runInContext(grabConst('PROCESS_W') + '\n' + ['nfPlan', 'nfMedian', 'planAdherence', 'isJournaled', 'processDays'].map(grabFn).join('\n'), pctx);
const dayKey = ms => new Date(ms).toISOString().slice(0, 10);
const mk = (id, d, extra) => Object.assign({ id, coin: 'BTC', dir: 'Long', openTime: Date.UTC(2026, 5, d, 9), closeTime: Date.UTC(2026, 5, d, 10), avgEntry: 100, avgExit: 101, maxSize: 1, net: 10 }, extra || {});
t('"rules kept" starts on the first custom rule’s day; earlier days are not regraded', () => {
  const days = pctx.processDays([mk('a', 1), mk('b', 3)], {}, { dayOf: dayKey, violIds: new Set(), rulesActive: true, rulesFrom: '2026-06-02' });
  eq(days[0].parts.rules, undefined); eq(days[1].parts.rules, 1);
});
t('an adopted planning habit is graded from its adoption day, even with no plan ever written', () => {
  const days = pctx.processDays([mk('a', 1), mk('b', 3)], {}, { dayOf: dayKey, violIds: new Set(), rulesActive: false, planFrom: { plan: '2026-06-02', planned: '2026-06-02' } });
  eq(days[0].parts.plan, undefined); eq(days[1].parts.plan, 0); eq(days[1].parts.planned, 0);
});
t('flagging a mistake counts as journaling', () => {
  ok(pctx.isJournaled({ mistakes: ['Chased'] })); ok(!pctx.isJournaled({ mistakes: [] })); ok(!pctx.isJournaled({}));
});
t('habits built from a bucket leak are worded the way they are scored', () => {
  ok(!/half size/.test(grabFn('bucketHabit')));
});

console.log('\nServer');
t('the coach letter request only carries options the chosen model accepts', () => {
  const r1 = server.coachLetterRequest({}, 'claude-opus-5-5');
  eq(r1.output_config, { effort: 'medium' }); eq(r1.fallbacks, 'default');
  const r2 = server.coachLetterRequest({}, 'claude-haiku-4-5');
  ok(!('output_config' in r2) && !('fallbacks' in r2) && !('betas' in r2));
  const r3 = server.coachLetterRequest({}, 'claude-opus-4-8');
  ok(r3.output_config && !r3.fallbacks);
});
const listen = app => new Promise(res => app.listen(0, () => res('http://127.0.0.1:' + app.address().port)));
await t('spot lots run FIFO per wallet: one wallet’s sale never consumes another wallet’s lot', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ledger-fix-'));
  const A = '0x' + 'a'.repeat(40), B = '0x' + 'b'.repeat(40);
  mkdirSync(join(dataDir, 'fills'), { recursive: true });
  const T = Date.UTC(2026, 0, 5);
  const f = (side, sz, px, time) => ({ coin: 'PURR/USDC', side, sz: String(sz), px: String(px), time, fee: '0', startPosition: '0', closedPnl: '0', tid: time, oid: time });
  const put = (addr, fills) => writeFileSync(join(dataDir, 'fills', addr + '.json.gz'), zlib.gzipSync(JSON.stringify({ v: 1, last: T + 9e6, count: fills.length, fills })));
  put(A, [f('B', 1, 10, T)]);
  put(B, [f('B', 1, 20, T + 1e6), f('A', 1, 30, T + 2e6)]);
  const app = server.createApp({ dataDir, auth: '', htmlPath });
  const b = await listen(app);
  try {
    const r = await fetch(b + '/api/data', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ rev: 0, snapshot: { app: 'ledger', wallets: [{ address: A }, { address: B }], settings: {}, journal: {} } }) });
    eq(r.status, 200);
    const body = await (await fetch(b + '/api/v1/spot/lots')).json();
    const rows = body.lots.rows;
    eq(rows.length, 1); eq(rows[0].wallet, B);
    near(rows[0].basis, 20, 1e-9, 'basis from wallet B’s own purchase, not A’s cheaper lot');
    eq(body.fills, 3);
  } finally { await new Promise(res => app.close(res)); }
});

report('fixes');
