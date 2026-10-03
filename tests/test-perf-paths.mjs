// The fast paths added for heavy accounts (AUDIT-4 P1/P2) must give exactly what the slow paths gave.
// Every check here compares bit-for-bit (JSON of the full result, numbers included) against the code
// the fast path replaced, rebuilt from the shipped functions:
//   · diagMCCompute — the Diagnostic's Monte Carlo batch (sync path and worker 'diagmc' both run it):
//     its walk-forward CI and change point equal walkForward / changePoint seeded the way the
//     Diagnostic used to call them inline, and the rest equals the original inline sequence
//   · taHistory — near-linear now; equals traderAge per day over the trailing window, as it used to be
//   · isoWeekOfKey's per-key cache, _tradesMemo / computeStatsMemo (hit only on the very same trades)
import { t, ok, eq, report, makeExtractor } from './harness.mjs';
import { readAppSource } from '../app-source.js';
import { readFileSync } from 'node:fs';

const htmlPath = new URL('../ledger.html', import.meta.url).pathname;
const src = readAppSource(htmlPath);
const { grabFn, evalModule } = makeExtractor(src);
const same = (a, b, m) => eq(a, b, m);   // JSON equality: every number to the last bit (JSON prints shortest round-trip)

// ---- the Diagnostic's Monte Carlo batch ----
const D = await evalModule(
  ['_srand', '_hashSeed', '_erf', '_lgamma', '_ibetaReg', '_tCdf', 'bootstrapMeanCI', 'mcMaxDD', 'fwdMaxDD', 'cusumDrift', 'edgeSignificance',
    'walkForward', '_maxSplitT', 'changePoint', 'diagMCCompute'],
  ['_srand', '_hashSeed', 'bootstrapMeanCI', 'mcMaxDD', 'fwdMaxDD', 'edgeSignificance', 'walkForward', 'changePoint', 'diagMCCompute'],
  'let _rng=Math.random;\nconst _avg=a=>a.length?a.reduce((x,y)=>x+y,0)/a.length:0;\n' +
  src.match(/^const _std=.*$/m)[0] + '\n' + src.match(/^const _normCdf=.*$/m)[0]);

// a deterministic synthetic history: a drifting edge with fat tails, equal close times included
const mkTrades = (N, seed) => { let x = seed >>> 0 || 1; const r = () => ((x = (x * 1664525 + 1013904223) >>> 0) / 4294967296);
  const out = []; let t0 = 1.7e12;
  for (let i = 0; i < N; i++) { if (r() > 0.1) t0 += Math.floor(r() * 3600e3); // ~10% share a close time with the trade before
    const edge = i < N / 2 ? 8 : -3; out.push({ id: 'T' + i, closeTime: t0, net: Math.round((edge + (r() - 0.5) * 200 * (r() < 0.05 ? 8 : 1)) * 100) / 100, isOpen: false }); }
  // the Diagnostic's closed set isn't in close order: shuffle deterministically
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  return out; };
// the input exactly as _diagMCInput builds it (that function needs the page's globals, so it's mirrored here
// and pinned against the source below)
const mcInput = closed => { const N = closed.length, chronT = [...closed].sort((a, b) => a.closeTime - b.closeTime), chron = chronT.map(t => t.net);
  return { nets: closed.map(t => t.net), chron, times: chronT.map(t => t.closeTime), seed: D._hashSeed('diag|' + N + '|' + (N ? closed[0].id + '|' + closed[N - 1].id : '')),
    B: N > 3000 ? 800 : 2000, MCI: N > 3000 ? 500 : 1500, HZN: Math.min(200, Math.max(50, N)), FI: N > 3000 ? 400 : 800, be: 50,
    wfSeed: D._hashSeed('wf:' + N), cpSeed: D._hashSeed('dist|' + N + '|' + (N ? closed[0].id + '|' + closed[N - 1].id : '')) }; };
// what the Diagnostic computed before the batch absorbed the walk-forward CI and the change point
const legacy = (closed, p) => {
  D._srand(p.seed);
  const o = { boot: p.nets.length >= 5 ? D.bootstrapMeanCI(p.nets, p.B) : null, esig: p.nets.length >= 5 ? D.edgeSignificance(p.nets) : null,
    mcdd: p.chron.length >= 5 ? D.mcMaxDD(p.chron, p.MCI) : null, fdd: p.chron.length >= 10 ? D.fwdMaxDD(p.chron, p.HZN, p.FI) : null };
  D._srand(D._hashSeed('wf:' + closed.length)); const wf = D.walkForward(closed); o.wfCI = wf ? wf.wfCI : null;    // renderDiagnostic, inline
  D._srand(p.cpSeed); o.cp = D.changePoint(closed);                                                              // renderDistribution, inline
  return o; };

for (const [N, seed] of [[12, 3], [64, 5], [400, 7], [1600, 11], [3300, 13]]) {
  t(`diagMCCompute equals the inline sequence it replaced, every number (${N} trades)`, () => {
    const closed = mkTrades(N, seed), p = mcInput(closed);
    same(D.diagMCCompute(p), legacy(closed, p));
  });
}
t('the batch survives a structured clone (what the worker receives) with identical results', () => {
  const closed = mkTrades(900, 17), p = mcInput(closed);
  same(D.diagMCCompute(structuredClone(p)), D.diagMCCompute(p));
});
t('walkForward {ci:false} is walkForward minus the CI, and draws nothing from the PRNG', () => {
  const closed = mkTrades(500, 19);
  D._srand(42); const a = D.walkForward(closed); D._srand(42); const b = D.walkForward(closed, { ci: false });
  ok(a.wfCI && b.wfCI === null); same({ ...a, wfCI: null }, b);
  D._srand(42); D.walkForward(closed, { ci: false }); const after = D.bootstrapMeanCI([1, 2, 3, 4, 5], 50); D._srand(42);
  same(after, D.bootstrapMeanCI([1, 2, 3, 4, 5], 50), 'the stream is where _srand left it');
});
t('the page builds the batch input the way this suite mirrors it, and both paths run the one function', () => {
  const inp = grabFn('_diagMCInput'), dg = readFileSync(new URL('../app/diagnostic.js', import.meta.url), 'utf8');
  for (const s of ["_hashSeed('diag|'+N+'|'+(N?closed[0].id+'|'+closed[N-1].id:''))", "B:N>3000?800:2000", "MCI:N>3000?500:1500", "HZN:Math.min(200,Math.max(50,N))",
    "FI:N>3000?400:800", "wfSeed:_hashSeed('wf:'+N)", "cpSeed:_distSeed(closed)", 'times:chronT.map(t=>t.closeTime)'])
    ok(inp.includes(s), '_diagMCInput: ' + s);
  ok(grabFn('_distSeed').includes("_hashSeed('dist|'+closed.length+'|'+(closed.length?closed[0].id+'|'+closed[closed.length-1].id:''))"));
  ok(grabFn('_diagMCSync').includes('diagMCCompute(I.mcIn)'), 'sync path');
  ok(dg.includes("else if(d.kind==='diagmc'){if(d.payload.be!=null)_be=d.payload.be;out=diagMCCompute(d.payload);}"), 'worker path');
  ok(/_WORKER_LIB=\(\)=>\(\{[^}]*walkForward,diagMCCompute,/.test(dg), 'shipped into the worker');
  ok(grabFn('_diagCP').includes('_srand(_distSeed(closed)); return changePoint(closed);'), 'distribution fallback seeds as before');
  ok(grabFn('renderDistribution').includes('const cp=_diagCP(closed);'));
  ok(grabFn('renderDiagnostic').includes("walkForward(closed,{ci:false})"));
});

// ---- Trader Age history ----
const consts = ['taRatingFor', 'TA_SLIPS'].map(n => src.match(new RegExp('^const ' + n + '=.*$', 'm'))[0]).join('\n');
const A = await evalModule(['taConf', 'taYears', 'taDayN', 'taPrep', 'taCheckin', 'traderAge', 'isoWeekOfKey', 'taHistory'], ['traderAge', 'taHistory', 'isoWeekOfKey'],
  'const TA=taConf();\n' + consts);
// what taHistory was: traderAge per day over the trailing 200 days
const taHistoryRef = (days, J, opts) => { opts = opts || {};
  const all = (days || []).filter(d => d && d.key && isFinite(d.score)).slice().sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  return all.map((d, i) => { const X = A.traderAge(all.slice(Math.max(0, i - 199), i + 1), J, { now: Date.parse(d.key + 'T23:59:59Z'), dayOf: opts.dayOf, firstAt: opts.firstAt });
    return { key: d.key, n: X.n, rating: X.rating, age: X.building ? null : X.age, tradingYears: X.tradingYears }; }); };
const DAY = 864e5, kd = ms => new Date(ms).toISOString().slice(0, 10);
const mkDays = (n, seed, o = {}) => { let x = seed; const r = () => ((x = (x * 1103515245 + 12345) % 2147483648) / 2147483648);
  const days = [], J = {}; let at = Date.parse('2023-01-02T12:00:00Z');
  for (let i = 0; i < n; i++) { at += DAY * (r() < (o.gapP || 0) ? 30 + Math.floor(r() * 200) : 1 + Math.floor(r() * (o.every || 2)));
    const k = kd(at), tr = Math.floor(r() * 6);
    const d = { key: k, score: Math.round(r() * 100), n: tr, parts: { limit: [0, 1, null][Math.floor(r() * 3)], plan: [0, 0.5, 1][Math.floor(r() * 3)], journal: r() }, behavior: { n: tr, flags: {} } };
    if (r() < 0.1) d.n = 0; if (r() < 0.05) delete d.parts;
    days.push(d); if (r() < 0.3) J['day:' + k] = { sleep: 3 };
    if (o.dupes && r() < 0.05) days.push(Object.assign({}, d, { score: Math.round(r() * 100) })); }   // a repeated key
  if (o.junk) days.push(null, { key: kd(at + DAY), score: NaN }, { score: 50 });
  // fed in any order
  for (let i = days.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [days[i], days[j]] = [days[j], days[i]]; }
  return { days, J }; };
for (const [label, n, seed, o, opts] of [
  ['a few days, still building', 9, 1, {}, {}],
  ['daily trading, past the 200-day cap', 520, 2, { every: 1 }, { firstAt: Date.parse('2022-12-01T00:00:00Z') }],
  ['sparse, with breaks longer than the 6-month window', 300, 3, { every: 4, gapP: 0.04 }, {}],
  ['repeated keys, junk rows, a tz day function', 260, 4, { dupes: true, junk: true }, { dayOf: ms => new Date(ms + 5.5 * 3600e3).toISOString().slice(0, 10), firstAt: 1 }],
]) {
  t('taHistory equals traderAge per day, every number: ' + label, () => {
    const { days, J } = mkDays(n, seed, o);
    const fast = A.taHistory(days, J, opts), ref = taHistoryRef(days, J, opts);
    eq(fast.length, ref.length); same(fast, ref);
    for (let i = 0; i < fast.length; i++) ok(Object.is(fast[i].rating, ref[i].rating), 'rating bits, day ' + i);
  });
}
t('taHistory still reads each day through traderAge (one rating formula) and keeps its signature', () => {
  const f = grabFn('taHistory'); ok(f.startsWith('function taHistory(days, J, opts){')); ok(f.includes('traderAge(all.slice(a,b+1), J, {now, dayOf:opts.dayOf, raw:true})'));
  ok(grabFn('traderAge').startsWith('function traderAge(days, J, opts){'));
});
t('isoWeekOfKey: cached per key, the same answers', () => {
  const plain = new Function('return ' + grabFn('isoWeekOfKey').replace(/const C=[^\n]*\n/, '').replace(/\n\s*if\(C\.size[^\n]*/, '\n  return w;'))();
  for (let ms = Date.parse('2019-12-20'); ms < Date.parse('2027-01-10'); ms += DAY) { const k = kd(ms); eq(A.isoWeekOfKey(k), plain(k)); eq(A.isoWeekOfKey(k), plain(k)); }
  eq(A.isoWeekOfKey('2020-12-31'), '2020-W53'); eq(A.isoWeekOfKey('2021-01-03'), '2020-W53'); eq(A.isoWeekOfKey('2021-01-04'), '2021-W01');
});

// ---- the trade-list memo ----
const M = await evalModule(['_sameTrades', '_tradesMemo'], ['_sameTrades', '_tradesMemo']);
t('_tradesMemo hits only on the very same trade objects, in order, with the same version', () => {
  let calls = 0; const f = () => ++calls;
  const a = [{ id: 1 }, { id: 2 }], b = a.slice(), c = [{ id: 1 }, { id: 2 }];
  eq(M._tradesMemo('x', a, 'v', f), 1); eq(M._tradesMemo('x', b, 'v', f), 1, 'a new array of the same objects hits');
  eq(M._tradesMemo('x', c, 'v', f), 2, 'equal-looking copies miss (results can hold trade references)');
  eq(M._tradesMemo('x', [a[1], a[0]], 'v', f), 3, 'order matters');
  eq(M._tradesMemo('x', a, 'w', f), 4, 'another version misses');
  eq(M._tradesMemo('y', a, 'v', f, [a[0]]), 5); eq(M._tradesMemo('y', a, 'v', f, [a[0]]), 5); eq(M._tradesMemo('y', a, 'v', f, [a[1]]), 6, 'allv is compared too');
  a.push({ id: 3 }); eq(M._tradesMemo('x', a, 'v', f), 7, 'the list it saw was copied: a push misses');
});
t('the memoized panels are keyed on everything they read', () => {
  const k = grabFn('computeStatsMemo'); for (const s of ['_be', '_oneR', '_jrev', 'settings.tz', 'settings.tzZone', 'dayKey(Date.now())']) ok(k.includes(s), 'computeStatsMemo: ' + s);
  const d = grabFn('_diagDataKey'); for (const s of ['_diagMCKey(closed)', '_oneR', '_jrev', 'settings.tz', 'settings.tzZone', 'settings.coachMode', '_excM', 'spotMaps']) ok(d.includes(s), '_diagDataKey: ' + s);
  ok(grabFn('_diagMCKey').includes('_be'));
  ok(grabFn('behaviorSignalsMemo').includes('[s.net,s.fees,s.fund,s.expectancy]'));
});
report('perf paths');
