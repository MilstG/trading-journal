// Forward pattern tracker, sequence-risk, and sparkline-series tests.
// Functions are extracted from ledger.html itself so the tests exercise exactly what ships.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '..', 'ledger.html'), 'utf8');

import { t, ok, eq, near, report, makeExtractor } from './harness.mjs';
const { grabBlock, grabFn, evalFn, evalClass } = makeExtractor(html);

// globals the extracted functions expect
globalThis.settings = { tz: 'local', pins: [] };
globalThis.journal = {};
globalThis._excM = {};
globalThis._rng = (() => { let s = 42; return () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff; })();
globalThis.tzHour = t2 => new Date(t2).getUTCHours();
globalThis.tzDow  = t2 => new Date(t2).getUTCDay();
globalThis.tzLabel = () => 'UTC';
globalThis.tzMidnight = t2 => { const d = new Date(t2); d.setUTCHours(0,0,0,0); return d.getTime(); };
globalThis.isWin  = n => n > 50;
globalThis.isLoss = n => n < -50;
globalThis.dcoin = t2 => t2.symbol || t2.coin;
const dmLine = html.split('\n').find(l => l.startsWith('const dispMarket='));
globalThis.dispMarket = (0, eval)('(' + dmLine.replace('const dispMarket=','').replace(/;\s*$/,'') + ')');
globalThis._avg = a => a.reduce((s,x)=>s+x,0)/a.length;
globalThis.retPct = t2 => { const n=(t2.maxSize||0)*(t2.avgEntry||0); return n>0 ? t2.net/n*100 : null; };
globalThis.fmtUsd = n => (n<0?'-':'')+'$'+Math.abs(n).toFixed(2);
globalThis.Store = { set: async () => {} };
globalThis.S_KEY = 'test_settings';
globalThis._maxSplitT = evalFn('_maxSplitT') || null;

globalThis.tradeStates = evalFn('tradeStates');
globalThis.minerFams   = evalFn('minerFams');
globalThis.underwaterStats = evalFn('underwaterStats');
globalThis.fwdMaxDD    = evalFn('fwdMaxDD');
globalThis.changePoint = evalFn('changePoint');
globalThis.resolvePinPred = evalFn('resolvePinPred');
globalThis.pinsList    = evalFn('pinsList');
globalThis.addPin      = evalFn('addPin');

// synthetic trades: 120 trades, HIP-3 market mixed in
const T = [];
for (let i = 0; i < 120; i++){
  T.push({ id: 't'+i, symbol: i % 6 === 0 ? 'xyz:MU' : (i % 2 ? 'HYPE' : 'BTC'),
    dir: i % 3 ? 'Long' : 'Short',
    openTime: Date.UTC(2026,0,1) + i*7200000, closeTime: Date.UTC(2026,0,1) + i*7200000 + 3600000,
    durationMs: (i % 10 + 1) * 9 * 60000,
    maxSize: i + 1, avgEntry: 100,
    net: (i % 4 ? 1 : -1) * (60 + i),
    makerNotional: i % 2 ? 100 : 0, takerNotional: i % 2 ? 0 : 100, entryDrift: i / 120 });
}
const ST = tradeStates(T);

console.log('\nForward pattern tracker');
await t('every family entry carries a stable id', () => {
  const fams = minerFams(T, ST);
  for (const f in fams) for (const e of fams[f]) ok(typeof e[2] === 'string' && e[2].length > 0, f + ' entry missing id');
});
await t('__params captured and non-enumerable', () => {
  const fams = minerFams(T, ST);
  ok(fams.__params && typeof fams.__params.nq3 === 'number', 'params missing');
  for (const f in fams) ok(f !== '__params', '__params leaked into for..in');
});
await t('frozen thresholds override recomputation', () => {
  const fams = minerFams(T, ST, { nq3: 5000, nq1: 500, hq3: 3600000, hq1: 60000 });
  const sizeHi = fams.size.find(e => e[2] === 'size:hi')[1];
  // notional 5100 (>=5000 frozen) matches even though live q75 differs
  ok(sizeHi({ maxSize: 51, avgEntry: 100 }) === true, 'frozen nq3 not applied');
  ok(sizeHi({ maxSize: 49, avgEntry: 100 }) === false, 'frozen nq3 boundary wrong');
});
await t('resolvePinPred resolves singles, pairs, and dropped-out markets', () => {
  const fams = minerFams(T, ST);
  const params = fams.__params;
  // single
  const p1 = resolvePinPred({ pid: 'size:hi', params }, T, ST);
  ok(p1 && T.some(p1), 'single unresolved');
  // pair
  const p2 = resolvePinPred({ pid: 'dir:Long&sess:1', params }, T, ST);
  ok(p2, 'pair unresolved');
  const fLong = fams.dir.find(e => e[2] === 'dir:Long')[1], fS1 = fams.session.find(e => e[2] === 'sess:1')[1];
  for (const tr of T) ok(p2(tr) === (fLong(tr) && fS1(tr)), 'pair predicate diverges from AND of parts');
  // market absent from top-12 slice still resolves via fallback
  const p3 = resolvePinPred({ pid: 'mkt:ghost:COIN', params }, T, ST);
  ok(p3 && !T.some(p3), 'fallback market predicate wrong');
});
await t('resolved predicate agrees with minerFams predicate for every id', () => {
  const fams = minerFams(T, ST);
  const params = fams.__params;
  for (const f in fams) for (const [nm, fn, cid] of fams[f]){
    const rp = resolvePinPred({ pid: cid, params }, T, ST);
    ok(rp, cid + ' unresolved');
    for (const tr of T) ok(rp(tr) === fn(tr), cid + ' diverges');
  }
});
await t('addPin stores frozen params and dedupes', async () => {
  settings.pins = [];
  const fams = minerFams(T, ST);
  const v = { pid: 'size:hi', name: 'largest 25%', exp: 12, n: 30, uplift: 360 };
  ok(await addPin(v, 'usd', fams.__params) === true);
  ok(await addPin(v, 'usd', fams.__params) === false, 'dedupe failed');
  ok(pinsList().length === 1 && pinsList()[0].params.nq3 === fams.__params.nq3);
});

console.log('\nSequence risk');
await t('underwaterStats measures the longest peak-to-recovery span', () => {
  const mk = (net, h) => ({ net, closeTime: Date.UTC(2026,0,1) + h*3600000 });
  // peak at h0, underwater h1..h3, recover h4; second dip h5.. never recovers (ongoing)
  const s = underwaterStats([mk(100,0), mk(-50,1), mk(-10,2), mk(20,3), mk(60,4), mk(-80,5), mk(10,6)]);
  ok(s.ongoingMs === 2*3600000, 'ongoing span wrong: ' + s.ongoingMs);
  ok(s.maxSpanMs === 4*3600000, 'max span wrong: ' + s.maxSpanMs);
});
await t('underwaterStats: never underwater', () => {
  const mk = (net, h) => ({ net, closeTime: h*3600000 });
  const s = underwaterStats([mk(10,0), mk(20,1), mk(5,2)]);
  ok(s.maxSpanMs === 0 && s.ongoingMs === null);
});
await t('fwdMaxDD is deterministic under seeded rng and ordered p50<=p75<=p95', () => {
  const nets = T.map(x => x.net);
  let s1 = 7; globalThis._rng = () => (s1 = (s1*1103515245+12345)&0x7fffffff)/0x7fffffff;
  const a = fwdMaxDD(nets, 100, 300);
  let s2 = 7; globalThis._rng = () => (s2 = (s2*1103515245+12345)&0x7fffffff)/0x7fffffff;
  const b = fwdMaxDD(nets, 100, 300);
  ok(a.median === b.median && a.p95 === b.p95, 'not deterministic');
  ok(a.median <= a.p75 && a.p75 <= a.p95, 'quantiles unordered');
  ok(a.median >= 0, 'drawdown must be non-negative magnitude');
});

console.log('\nRegime sparkline series');
await t('changePoint returns a bounded, ordered series covering the sequence', () => {
  // construct a clear regime break: first 60 lose, last 60 win
  const R = T.map((x,i) => ({ ...x, net: i < 60 ? -100 : 120 }));
  globalThis._rng = (() => { let s = 3; return () => (s = (s*1103515245+12345)&0x7fffffff)/0x7fffffff; })();
  const c = changePoint(R);
  ok(c && c.series && c.series.length >= 3 && c.series.length <= 130, 'series size wrong: ' + (c && c.series && c.series.length));
  ok(c.series[0].i === 0 && c.series[c.series.length-1].i === R.length-1, 'series endpoints wrong');
  ok(c.series.every(p => typeof p.v === 'number' && typeof p.t === 'number'), 'series point shape wrong');
  ok(typeof c.win === 'number' && c.win >= 10, 'window missing');
  ok(c.sig === true && Math.abs(c.k - 60) <= 6, 'break not detected near 60: k=' + c.k);
});

console.log('\nMiner worker-safety');
globalThis._progress = null;
globalThis._std = a => { const m=_avg(a); return Math.sqrt(_avg(a.map(x=>(x-m)*(x-m)))); };
globalThis.bootstrapMeanCI = evalFn('bootstrapMeanCI');
globalThis.mineInsights = evalFn('mineInsights');
await t('mineInsights output survives structuredClone and carries pid + famParams', () => {
  globalThis._rng = (() => { let s = 11; return () => (s = (s*1103515245+12345)&0x7fffffff)/0x7fffffff; })();
  const r = mineInsights(T);
  ok(r, 'null result');
  const clone = structuredClone(r); // throws on functions => worker postMessage would fail
  ok(clone.famParams && typeof clone.famParams.nq3 === 'number', 'famParams missing');
  for (const v of r.validated.concat(r.suggestive)){
    ok(typeof v.pid === 'string' && v.pid.length > 0, 'pid missing on ' + v.name);
    ok(!('pred' in v) && !('idx' in v), 'non-cloneable fields left on ' + v.name);
  }
});

report();
