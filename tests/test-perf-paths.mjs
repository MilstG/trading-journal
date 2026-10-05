// The fast paths added for heavy accounts (AUDIT-4 P1/P2) must give exactly what the slow paths gave.
// Every check here compares bit-for-bit (JSON of the full result, numbers included) against the code
// the fast path replaced, rebuilt from the shipped functions:
//   · diagMCCompute — the Diagnostic's Monte Carlo batch (sync path and worker 'diagmc' both run it):
//     its walk-forward CI and change point equal walkForward / changePoint seeded the way the
//     Diagnostic used to call them inline, and the rest equals the original inline sequence
//   · taHistory — near-linear now; equals traderAge per day over the trailing window, as it used to be
//   · isoWeekOfKey's per-key cache, _tradesMemo / computeStatsMemo (hit only on the very same trades)
//   · habitProgress's memo, and pzBadgeCatalog's second pass equal to a fresh run
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

// ---- habitProgress, memoized per coach context ----
{
  const vm = await import('node:vm');
  const ctx = vm.createContext({ Math, JSON, Map, WeakMap, Object, dayKey: ms => new Date(ms).toISOString().slice(0, 10), habitSummary: r => ({ kept: r.length }) });
  vm.runInContext('var journal={}, _jrev=0, _pzSlipDays=new Map(), calls=0; function habitDayResults(h,days,byDay,pred,fromKey,J){ calls++; return days.filter(d=>d.key>=fromKey).map(d=>({key:d.key,kept:true})); }\n' + grabFn('habitProgress'), ctx);
  const hp = vm.runInContext('habitProgress', ctx), calls = () => vm.runInContext('calls', ctx);
  t('habitProgress: one computation per habit, start and data version within a coach context', () => {
    const c1 = { days: [{ key: '2026-01-01' }, { key: '2026-02-01' }], byDay: {}, preds: {} }, h = { id: 'a', kind: 'tpl', createdAt: 0 };
    const a = hp(h, c1), b = hp({ ...h }, c1); ok(a === b && calls() === 1, 'the same habit (by content) hits');
    eq(hp(h, c1, Date.parse('2026-01-15')).kept, 1); eq(calls(), 2, 'another start day is its own entry');
    hp(h, { ...c1 }); eq(calls(), 3, 'another context misses');
    vm.runInContext('_jrev++', ctx); hp(h, c1); eq(calls(), 4, 'a journal edit misses');
    vm.runInContext('_pzSlipDays=new Map()', ctx); hp(h, c1); eq(calls(), 5, 'new slip days (a game rebuild) miss');
    vm.runInContext('journal={}', ctx); hp(h, c1); eq(calls(), 6, 'a replaced journal misses');
    hp({ ...h, then: 'x' }, c1); eq(calls(), 7, 'an edited habit misses');
  });
}

// ---- the badge catalog's second pass ----
// gameContext runs pzBadgeCatalog twice per rebuild; the second reuses the first's XP-independent
// families. It must equal a fresh run with the second pass's inputs, and anything else changing between
// the passes must make it work everything out again.
{
  const vm = await import('node:vm');
  const grabConst = name => { const i = src.indexOf('const ' + name + '='); if (i < 0) throw new Error(name); const j = name === 'PZ_FAMILIES' ? src.indexOf('];\n', i) + 2 : src.indexOf(';\n', i) + 1; return src.slice(i, j); };
  const DAYK = ms => new Date(ms).toISOString().slice(0, 10);
  const ctx = vm.createContext({ Math, console, Set, Map, Object, JSON, Array, String, Date, isFinite, Infinity, Number,
    dayKey: DAYK, _avg: a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0, nfMedian: a => { if (!a || !a.length) return null; const q = [...a].sort((x, y) => x - y), n = q.length; return n % 2 ? q[(n - 1) / 2] : (q[n / 2 - 1] + q[n / 2]) / 2; },
    isJournaled: j => !!(j && (j.notes || j.setup)), pzReadinessManual: () => null, habitsList: () => [], habitProgress: () => ({ res: [] }), pzPlugs: () => [], pzXpCfg: () => ({ achievement: 50 }) });
  vm.runInContext(['LEVELS', 'PZ_LOSS', 'pzAddDays', 'PZ_TIERS', 'PZ_TIER_XP', 'pzN', 'pzUsd', 'PZ_FAMILIES'].map(grabConst).join('\n') +
    '\nvar settings={}, journal={}, _jrev=0, _pzSlipDays=new Map(), PZ_CFG={levels:null};\n' + ['pzLevelCfg', 'levelFor', 'isoWeekOfKey', 'disciplineStreak', 'pzGoalKeys', 'pzAdoptKeys', 'pzPluggedKeys', 'pzBadgeCatalog'].map(grabFn).join('\n') +
    '\nlet _pzCatPass=null; function __reset(){ _pzCatPass=null; }', ctx);
  const day0 = Date.parse('2026-03-02T12:00:00Z'), closed = [], byDay = {}, D = [];
  for (let i = 0; i < 160; i++) { const at = day0 + i * 864e5, k = DAYK(at), tr = [];
    for (let j = 0; j < 3; j++) { const tt = { id: k + j, openTime: at + j * 36e5, closeTime: at + j * 36e5 + 18e5, net: ((i * 37 + j * 11) % 23 - 9) * 40 }; tr.push(tt); closed.push(tt); }
    byDay[k] = tr; D.push({ key: k, score: (i * 29) % 101, n: 3, net: tr.reduce((a, x) => a + x.net, 0), parts: { plan: i % 3 ? 1 : 0, limit: i % 4 ? 1 : null }, breached: false, behavior: { flags: i % 5 ? {} : { revenge: 1 } } }); }
  const now = day0 + 170 * 864e5, nowWeek = vm.runInContext(`isoWeekOfKey('${DAYK(now)}')`, ctx);
  const streak = vm.runInContext('disciplineStreak', ctx)(D, nowWeek);
  const G0 = { ctx: { byDay, closed }, days: D, streak, pa: { items: [] }, achievements: [], challenges: [], journalBest: 0, stopsBest: 0, now, nowWeek };
  const xpOf = b => { const by = {}; D.forEach((d, i) => { by[d.key] = d.score + (i === 50 ? b : 0); }); return { xp: Object.values(by).reduce((a, v) => a + v, 0), xpByDay: by }; };
  const cat = (b, reset) => { if (reset) vm.runInContext('__reset()', ctx); return vm.runInContext('pzBadgeCatalog', ctx)(Object.assign({}, G0, xpOf(b), { level: 3 })); };
  t('the badge catalog: the second pass of a rebuild equals a fresh run, and a change in between is noticed', () => {
    cat(0, true); const second = cat(50000), fresh = cat(50000, true);
    ok(second.earned.length > 10, 'badges were earned'); same(second, fresh);
    ok(fresh.families.find(f => f.id === 'xp').value !== cat(0, true).families.find(f => f.id === 'xp').value, 'the XP family did change with the XP');
    cat(0, true); vm.runInContext("journal={'day:" + D[3].key + "':{sleep:3}}; _jrev++", ctx);
    const after = cat(50000); same(after, cat(50000, true), 'a journal change between the passes: worked out again');
    ok(after.families.find(f => f.id === 'checkin').value === 1, 'and it shows');
    // and the reuse really happens: a trade slipped into the very same list in between (nothing a rebuild
    // does — it builds new lists) only shows in a fresh run
    cat(0, true); closed.push({ id: 'x', openTime: now - 1e6, closeTime: now - 5e5, net: 1 });
    ok(cat(0).families.find(f => f.id === 'trades').value === closed.length - 1, 'the second pass reused the first');
    closed.pop();
  });
}

// ---- fetchPositions: every clearinghouse at once, read in the old order ----
// The sequential version it replaced, as it shipped: the result (positions in order, account value, the
// dexes that answered) must be the same whatever order the answers arrive in and whichever of them fail.
{
  const SEQ = `async function fetchPositionsSeq(addr, hip3Dexs){
  let positions=[], accountValue=null; const okDex=new Set();
  try{ const s=await hlPost({type:'clearinghouseState',user:addr}); positions=mapClearinghouse(s,''); okDex.add('');
    accountValue=s.marginSummary?parseFloat(s.marginSummary.accountValue):null; }catch(e){}
  for(const dex of (hip3Dexs||[])){ try{ const s=await hlPost({type:'clearinghouseState',user:addr,dex}); positions=positions.concat(mapClearinghouse(s,dex)); okDex.add(dex); }catch(e){} }
  return {positions,accountValue,okDex}; }`;
  const mk = (seed) => { let x = seed; const r = () => ((x = (x * 1664525 + 1013904223) >>> 0) / 4294967296);
    const book = {}, fail = new Set();
    for (const dex of ['', 'xyz', 'flx', 'vntl']) { if (r() < 0.25) fail.add(dex);
      book[dex] = { marginSummary: dex ? undefined : { accountValue: String(1000 + Math.round(r() * 1e5) / 100) },
        assetPositions: Array.from({ length: Math.floor(r() * 4) }, (_, i) => ({ position: { coin: (dex && r() < 0.5 ? dex + ':' : '') + 'C' + i, szi: String(Math.round((r() - 0.5) * 100) / 10), entryPx: String(10 + i), unrealizedPnl: String(r() * 10 - 5), returnOnEquity: '0.01', positionValue: String(r() * 1000), leverage: { value: 1 + i } } })) }; }
    // answers arrive out of order: each after its own random delay
    const hlPost = b => new Promise((res, rej) => setTimeout(() => fail.has(b.dex || '') ? rej(new Error('down')) : res(JSON.parse(JSON.stringify(book[b.dex || '']))), Math.floor(r() * 20)));
    return hlPost; };
  const load = async (hlPost) => {
    const mod = await import('data:text/javascript;base64,' + Buffer.from('let hlPost;export const set=f=>{hlPost=f;};\n' + grabFn('mapClearinghouse') + '\n' + grabFn('fetchPositions') + '\n' + SEQ + '\nexport { fetchPositions, fetchPositionsSeq };').toString('base64'));
    mod.set(hlPost); return mod; };
  await t('fetchPositions asks every clearinghouse at once and returns what the one-by-one version did, failures and order included', async () => {
    for (let seed = 1; seed <= 40; seed++) {
      const m = await load(mk(seed)), dexes = seed % 5 ? ['xyz', 'flx', 'vntl'].slice(0, seed % 4) : [];
      const a = await m.fetchPositions('0xabc', dexes); m.set(mk(seed)); const b = await m.fetchPositionsSeq('0xabc', dexes);
      same([a.positions, a.accountValue, [...a.okDex]], [b.positions, b.accountValue, [...b.okDex]], 'seed ' + seed);
    }
  });
}
report('perf paths');
