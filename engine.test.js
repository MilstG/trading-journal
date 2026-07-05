#!/usr/bin/env node
/*
 * Ledger — engine unit tests.
 *
 * These run the REAL functions out of the single-file app (index.html) in Node, with
 * browser globals stubbed. Nothing is re-implemented, so the tests can't silently drift
 * from the source: point this at your index.html and it exercises exactly what ships.
 *
 *   node engine.test.js [path-to-index.html]
 *
 * Exit code is non-zero if any test fails (CI-friendly).
 */
'use strict';
const fs = require('fs');
const path = require('path');

/* ---------- locate + extract the app script ---------- */
function findHtml() {
  const arg = process.argv[2];
  const candidates = arg ? [arg]
    : ['index.html', 'ledger.html',
       path.join(__dirname, 'index.html'),
       '/mnt/user-data/outputs/index.html'];
  for (const c of candidates) { try { if (fs.statSync(c).isFile()) return c; } catch (e) {} }
  throw new Error('Could not find index.html (pass a path as the first arg).');
}
const HTML_PATH = findHtml();
const html = fs.readFileSync(HTML_PATH, 'utf8');
// grab the largest <script> block (the app), ignoring small inline ones
let scriptSrc = null;
{ const re = /<script>([\s\S]*?)<\/script>/g; let m;
  while ((m = re.exec(html))) { if (!scriptSrc || m[1].length > scriptSrc.length) scriptSrc = m[1]; } }
if (!scriptSrc) throw new Error('No <script> block found.');

/* ---------- browser-global stubs ---------- */
const noop = () => {};
function elProxy() {
  const target = function () { return target; };
  return new Proxy(target, {
    get(_, p) {
      if (p === 'classList') return { add: noop, remove: noop, toggle: noop, contains: () => false };
      if (p === 'style') return {};
      if (p === 'dataset') return {};
      if (p === 'files') return [];
      if (p === 'value' || p === 'textContent' || p === 'innerHTML' || p === 'className') return '';
      if (p === 'querySelectorAll') return () => [];
      if (p === 'querySelector' || p === 'getElementById') return () => elProxy();
      if (p === Symbol.toPrimitive) return () => '';
      if (typeof p === 'symbol') return undefined;
      return elProxy(); // methods + nested props all absorb
    },
    set() { return true; },
    apply() { return elProxy(); }
  });
}
const documentStub = {
  addEventListener: noop, removeEventListener: noop,
  querySelector: () => elProxy(), querySelectorAll: () => [],
  getElementById: () => elProxy(), createElement: () => elProxy(),
  body: elProxy(), documentElement: elProxy()
};
const windowStub = { addEventListener: noop, removeEventListener: noop };
const matchMediaStub = () => ({ matches: false, addEventListener: noop, addListener: noop });
const localStorageStub = { getItem: () => null, setItem: noop, removeItem: noop };
const navigatorStub = { serviceWorker: { register: () => Promise.reject(new Error('stub')) } };
const locationStub = { protocol: 'file:', href: 'file:///' };
function ChartStub() { return { destroy: noop, update: noop }; }
function nestProxy() { return new Proxy({}, { get(t, p) { if (!(p in t)) t[p] = nestProxy(); return t[p]; }, set() { return true; } }); }
ChartStub.defaults = nestProxy();
ChartStub.register = noop;
const fetchStub = () => Promise.reject(new Error('no network in tests'));

// swallow async boot rejections (the app's boot IIFE runs but has nothing to load here)
process.on('unhandledRejection', () => {});

/* ---------- instantiate: run the real script, capture the engine bindings ---------- */
const EXPORT_NAMES = [
  'isPerp', 'newTrade', 'tallyFill', 'reconstructTrades', 'attributeFunding',
  'isWin', 'isLoss', 'isBE', 'riskFor', 'rFor', 'retPct',
  '_avg', '_std', '_skew', 'dailyPnl', 'dailySeriesCalendar', 'sharpeStats', 'sortinoAnnual',
  'computeStats',
  'makerTakerStats', 'executionStats', 'liqStats', 'drawdownEpisodes',
  'worstLossStreakDepth', 'feeDragByMonth', 'netExposureByCoin', 'sizingFromStats',
  'minerFams', 'mineInsights'
];
const footer = `
;return {
  ${EXPORT_NAMES.join(', ')},
  __setBe:(v)=>{_be=v},
  __setJournal:(v)=>{journal=v},
  __setSettings:(v)=>{settings=v},
  __setOpenPositions:(v)=>{openPositions=v},
  __setAllTrades:(v)=>{allTrades=v}
};`;
let E;
try {
  const factory = new Function(
    'document', 'window', 'matchMedia', 'localStorage', 'navigator', 'location',
    'Chart', 'fetch', 'requestAnimationFrame', 'cancelAnimationFrame', 'alert', 'confirm',
    scriptSrc + footer
  );
  E = factory(documentStub, windowStub, matchMediaStub, localStorageStub, navigatorStub,
    locationStub, ChartStub, fetchStub, noop, noop, noop, () => true);
} catch (e) {
  console.error('Failed to instantiate the app script in Node:\n', e);
  process.exit(2);
}
E.__setBe(0); // default: no break-even band, so win=net>0 / loss=net<0

/* ---------- tiny test runner ---------- */
let pass = 0, fail = 0; const failures = [];
function test(name, fn) { try { fn(); pass++; process.stdout.write('.'); }
  catch (e) { fail++; failures.push([name, e.message]); process.stdout.write('X'); } }
function ok(c, m) { if (!c) throw new Error(m || 'expected truthy'); }
function eq(a, b, m) { if (a !== b) throw new Error((m || 'eq') + ` — got ${fmt(a)}, want ${fmt(b)}`); }
function approx(a, b, eps, m) { eps = eps == null ? 1e-6 : eps; if (a == null || Math.abs(a - b) > eps)
  throw new Error((m || 'approx') + ` — got ${fmt(a)}, want ~${fmt(b)}`); }
function fmt(x) { return typeof x === 'number' ? (Number.isInteger(x) ? x : x.toFixed(6)) : JSON.stringify(x); }

/* ---------- fixtures ---------- */
let _tid = 0;
function fill(o) { _tid++; return Object.assign({
  coin: 'BTC', sz: '1', side: 'B', startPosition: '0', px: '100',
  fee: '0', closedPnl: '0', time: _tid * 1000, tid: _tid, oid: _tid, crossed: true
}, o); }
// build a closed-trade object as computeStats/analytics expect (post-attributeFunding)
function trade(o) { const t = Object.assign({
  coin: 'BTC', dir: 'Long', isOpen: false, pnl: 0, fees: 0, funding: 0,
  maxSize: 1, avgEntry: 100, avgExit: 110, openTime: 0, closeTime: 1000, durationMs: 1000,
  makerFills: 0, takerFills: 0, makerFee: 0, takerFee: 0, makerNotional: 0, takerNotional: 0,
  liquidated: false, entryDrift: null
}, o); if (t.net == null) t.net = t.pnl - t.fees + t.funding; return t; }

/* ================= RECONSTRUCTION ================= */
test('isPerp classifies perps vs spot', () => {
  ok(E.isPerp('BTC')); ok(E.isPerp('kPEPE'));
  ok(!E.isPerp('@1')); ok(!E.isPerp('PURR/USDC'));
});

test('simple long round-trip', () => {
  const fills = [
    fill({ side: 'B', startPosition: '0', px: '100', fee: '0.1', time: 1000, crossed: true }),
    fill({ side: 'A', startPosition: '1', px: '110', fee: '0.1', closedPnl: '10', time: 2000, crossed: false })
  ];
  const tr = E.reconstructTrades(fills, 'w', 'perp');
  eq(tr.length, 1, 'one closed trade');
  const t = tr[0];
  eq(t.isOpen, undefined, 'not open'); eq(t.dir, 'Long');
  approx(t.avgEntry, 100); approx(t.avgExit, 110);
  approx(t.pnl, 10); approx(t.fees, 0.2); eq(t.fills, 2);
  eq(t.durationMs, 1000);
});

test('short round-trip', () => {
  const fills = [
    fill({ side: 'A', startPosition: '0', px: '100', closedPnl: '0', time: 1000 }),
    fill({ side: 'B', startPosition: '-1', px: '90', closedPnl: '10', time: 2000 })
  ];
  const tr = E.reconstructTrades(fills, 'w', 'perp');
  eq(tr.length, 1); eq(tr[0].dir, 'Short'); approx(tr[0].pnl, 10);
  approx(tr[0].avgEntry, 100); approx(tr[0].avgExit, 90);
});

test('scale-in computes size-weighted entry + entryDrift', () => {
  const fills = [
    fill({ side: 'B', startPosition: '0', px: '100', time: 1000 }),
    fill({ side: 'B', startPosition: '1', px: '120', time: 2000 }),
    fill({ side: 'A', startPosition: '2', px: '130', sz: '2', closedPnl: '40', time: 3000 })
  ];
  const t = E.reconstructTrades(fills, 'w', 'perp')[0];
  approx(t.avgEntry, 110, 1e-6, 'avg of 100 & 120');
  approx(t.firstEntryPx, 100);
  approx(t.entryDrift, 0.10, 1e-9, 'scaled in 10% worse than first fill');
  approx(t.maxSize, 2);
});

test('maker/taker + notional split retained', () => {
  const fills = [
    fill({ side: 'B', startPosition: '0', px: '100', fee: '0.05', crossed: true, time: 1000 }),
    fill({ side: 'A', startPosition: '1', px: '110', fee: '0.04', crossed: false, closedPnl: '10', time: 2000 })
  ];
  const t = E.reconstructTrades(fills, 'w', 'perp')[0];
  eq(t.takerFills, 1); eq(t.makerFills, 1);
  approx(t.takerFee, 0.05); approx(t.makerFee, 0.04);
  approx(t.takerNotional, 100); approx(t.makerNotional, 110);
});

test('liquidation fill flags the trade', () => {
  const fills = [
    fill({ side: 'B', startPosition: '0', px: '100', time: 1000 }),
    fill({ side: 'A', startPosition: '1', px: '80', closedPnl: '-20', time: 2000, liquidation: { method: 'market' } })
  ];
  ok(E.reconstructTrades(fills, 'w', 'perp')[0].liquidated);
});

test('open position => isOpen, null avgExit', () => {
  const t = E.reconstructTrades([fill({ side: 'B', startPosition: '0', px: '100', time: 1000 })], 'w', 'perp')[0];
  ok(t.isOpen); eq(t.avgExit, null); ok(t.durationMs > 0);
});

test('flip long->short yields closed long + open short, pnl conserved', () => {
  const fills = [
    fill({ side: 'B', startPosition: '0', px: '100', time: 1000 }),
    fill({ side: 'A', startPosition: '1', px: '110', sz: '3', closedPnl: '10', time: 2000 })
  ];
  const tr = E.reconstructTrades(fills, 'w', 'perp').sort((a, b) => a.openTime - b.openTime);
  eq(tr.length, 2, 'a closed leg and a reopened leg');
  const closed = tr.find(t => !t.isOpen), open = tr.find(t => t.isOpen);
  ok(closed && open, 'one closed, one open');
  eq(closed.dir, 'Long'); eq(open.dir, 'Short'); approx(open.maxSize, 2, 1e-9);
  approx(closed.pnl + open.pnl, 10, 1e-9, 'closedPnl conserved across the flip');
});

test('market filter separates spot from perp', () => {
  const fills = [
    fill({ coin: 'BTC', side: 'B', startPosition: '0', px: '100', time: 1000 }),
    fill({ coin: 'BTC', side: 'A', startPosition: '1', px: '110', closedPnl: '10', time: 2000 }),
    fill({ coin: '@1', side: 'B', startPosition: '0', px: '2', time: 1500 })
  ];
  eq(E.reconstructTrades(fills, 'w', 'perp').filter(t => !t.isOpen).length, 1, 'one perp round-trip');
  eq(E.reconstructTrades(fills, 'w', 'spot').length, 1, 'one spot (open) trade');
});

test('attributeFunding sets funding within the trade window and net', () => {
  const trades = [{ coin: 'BTC', openTime: 1000, closeTime: 3000, isOpen: false, pnl: 10, fees: 1 }];
  const fund = [
    { coin: 'BTC', time: 500, usdc: -5 },   // before open — excluded
    { coin: 'BTC', time: 2000, usdc: -2 },   // inside window
    { coin: 'BTC', time: 2500, usdc: 1 },    // inside window
    { coin: 'BTC', time: 9000, usdc: -9 }    // after close — excluded
  ];
  const t = E.attributeFunding(trades, fund)[0];
  approx(t.funding, -1, 1e-9); approx(t.net, 10 - 1 + (-1), 1e-9);
});

test('short-side entryDrift uses inverted sign', () => {
  const fills = [
    fill({ side: 'A', startPosition: '0', px: '100', time: 1000 }),   // sell to open @100
    fill({ side: 'A', startPosition: '-1', px: '90', time: 2000 }),    // add short @90 (worse fill)
    fill({ side: 'B', startPosition: '-2', px: '80', sz: '2', closedPnl: '30', time: 3000 })
  ];
  const t = E.reconstructTrades(fills, 'w', 'perp')[0];
  eq(t.dir, 'Short'); approx(t.avgEntry, 95, 1e-9); approx(t.firstEntryPx, 100);
  approx(t.entryDrift, 100 / 95 - 1, 1e-9, 'selling into weakness = adverse (positive) drift');
});

/* ================= STATS HELPERS ================= */
test('_avg and _std', () => {
  approx(E._avg([2, 4, 6]), 4);
  approx(E._std([2, 4, 6]), 2, 1e-9); // sample sd of {2,4,6} = 2
  eq(E._std([5]), 0, 'sd of single element is 0');
});
test('_skew: 0 for tiny samples, signed for skewed data', () => {
  eq(E._skew([1, 2]), 0);
  ok(E._skew([1, 1, 1, 1, 10]) > 0, 'right tail => positive skew');
});
test('win/loss/break-even band honors _be', () => {
  E.__setBe(50);
  ok(E.isWin(60) && !E.isWin(50)); ok(E.isLoss(-60) && !E.isLoss(-50)); ok(E.isBE(25));
  E.__setBe(0);
  ok(E.isWin(1) && E.isLoss(-1) && E.isBE(0));
});
test('retPct = net / (maxSize*avgEntry) * 100', () => {
  approx(E.retPct(trade({ net: 50, maxSize: 1, avgEntry: 100 })), 50);
  eq(E.retPct(trade({ maxSize: 0, avgEntry: 0, net: 5 })), null);
});
test('sharpeStats sane on constant-positive vs null on zero-variance', () => {
  eq(E.sharpeStats([1]), null, 'need >=2 points');
  eq(E.sharpeStats([3, 3, 3]), null, 'zero variance => null');
  const s = E.sharpeStats([1, -1, 2, -2, 3]); ok(s && isFinite(s.sr) && s.lo < s.hi, 'CI ordered');
});

/* ================= computeStats ================= */
test('computeStats aggregates PnL, win rate, PF, expectancy', () => {
  E.__setBe(0);
  const nets = [100, -50, 30, -20, 40];
  const closed = nets.map((n, i) => trade({ pnl: n, fees: 0, funding: 0, net: n, closeTime: (i + 1) * 86400000 }));
  const s = E.computeStats(closed, closed);
  eq(s.n, 5); approx(s.net, 100); eq(s.wins, 3); eq(s.losses, 2);
  approx(s.winRate, 0.6); approx(s.profitFactor, 170 / 70, 1e-9);
  approx(s.expectancy, 20);
});
test('computeStats drawdown vs PnL high-water mark', () => {
  E.__setBe(0);
  const nets = [100, -50, 30, -20, 40]; // cum: 100,50,80,60,100 ; peak 100 ; worst dd -50
  const closed = nets.map((n, i) => trade({ pnl: n, net: n, closeTime: (i + 1) * 86400000 }));
  const s = E.computeStats(closed, closed);
  approx(s.maxDD, -50, 1e-9); approx(s.maxDDpct, 0.5, 1e-9);
});
test('computeStats streaks (scratches neutral)', () => {
  E.__setBe(10);
  const nets = [50, 50, 50, -30, -30, 5, 80]; // W W W L L (scratch) W  => longW=3, longL=2
  const closed = nets.map((n, i) => trade({ pnl: n, net: n, closeTime: (i + 1) * 86400000 }));
  const s = E.computeStats(closed, closed);
  eq(s.longW, 3); eq(s.longL, 2);
  E.__setBe(0);
});

/* ================= EXTRA ANALYTICS ================= */
test('makerTakerStats shares + savings estimate', () => {
  const t = trade({ makerFills: 1, takerFills: 1, makerFee: 0.1, takerFee: 0.1, makerNotional: 110, takerNotional: 100 });
  const m = E.makerTakerStats([t]);
  eq(m.totF, 2); approx(m.takerShareFills, 0.5);
  approx(m.takerRate, 0.001, 1e-9); approx(m.makerRate, 0.1 / 110, 1e-9);
  approx(m.savings, 0.1 - 100 * (0.1 / 110), 1e-9, 'taker volume at your maker rate');
});
test('executionStats medians', () => {
  const ts = [
    trade({ entryDrift: 0.02, net: 10, maxSize: 1, avgEntry: 100, durationMs: 86400000 }),
    trade({ entryDrift: -0.01, net: 20, maxSize: 1, avgEntry: 100, durationMs: 86400000 }),
    trade({ entryDrift: 0.05, net: -5, maxSize: 1, avgEntry: 100, durationMs: 86400000 })
  ];
  const x = E.executionStats(ts);
  approx(x.medDrift, 0.02, 1e-9); approx(x.adverseShare, 2 / 3, 1e-9);
});
test('liqStats counts liquidations + their net', () => {
  const r = E.liqStats([trade({ liquidated: true, net: -30 }), trade({ liquidated: false, net: 5 })]);
  eq(r.n, 1); approx(r.net, -30);
});
test('drawdownEpisodes: recovery length + depth', () => {
  const nets = [50, -30, -20, 60]; // one dip fully recovered on trade #4
  const closed = nets.map((n, i) => trade({ net: n, closeTime: (i + 1) * 1000 }));
  const d = E.drawdownEpisodes(closed);
  eq(d.episodes, 1); eq(d.medRecover, 3); eq(d.underwaterTrades, 0);
  approx(d.deepest, -50, 1e-9);
});
test('worstLossStreakDepth: dollars + count of worst run', () => {
  const nets = [10, -5, -8, 3, -20];
  const closed = nets.map((n, i) => trade({ net: n, closeTime: (i + 1) * 1000 }));
  const w = E.worstLossStreakDepth(closed);
  approx(w.depth, -20, 1e-9); eq(w.count, 1);
});
test('feeDragByMonth buckets by calendar month', () => {
  const jan = Date.UTC(2026, 0, 15), feb = Date.UTC(2026, 1, 15);
  const ts = [
    trade({ closeTime: jan, pnl: 100, fees: 5, funding: 0 }),
    trade({ closeTime: feb, pnl: 100, fees: 20, funding: 0 })
  ];
  const rows = E.feeDragByMonth(ts);
  eq(rows.length, 2);
  const janRow = rows.find(r => r.k.endsWith('-01')), febRow = rows.find(r => r.k.endsWith('-02'));
  approx(janRow.drag, 0.05, 1e-9); approx(febRow.drag, 0.20, 1e-9);
});
test('netExposureByCoin nets longs vs shorts across wallets', () => {
  E.__setOpenPositions([
    { coin: 'BTC', szi: 1, value: 1000, wallet: { address: 'a' } },
    { coin: 'BTC', szi: -1, value: 400, wallet: { address: 'b' } },
    { coin: 'ETH', szi: 1, value: 500, wallet: { address: 'a' } }
  ]);
  const ne = E.netExposureByCoin();
  const btc = ne.find(x => x.coin === 'BTC');
  approx(btc.net, 600, 1e-9, '1000 long - 400 short'); eq(btc.wallets, 2);
  E.__setOpenPositions([]);
});
test('sizingFromStats: Kelly + half-Kelly', () => {
  // win 0.6, payoff 2 => kelly = 0.6 - 0.4/2 = 0.4
  const s = E.sizingFromStats({ winRate: 0.6, payoff: 2 });
  approx(s.kelly, 0.4, 1e-9); approx(s.half, 0.2, 1e-9);
  const none = E.sizingFromStats({ winRate: 0.3, payoff: 0.5 }); // negative edge => clamped 0
  eq(none.kelly, 0);
});

/* ================= MINER (smoke, seeded) ================= */
test('mineInsights runs and surfaces a strongly-separated pattern', () => {
  // deterministic RNG so permutation p-values are reproducible
  const realRandom = Math.random; let seed = 12345;
  Math.random = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  try {
    const ts = [];
    // "A-setup" trades win big; everything else loses — an obvious edge the miner should find
    for (let i = 0; i < 40; i++) {
      const good = i % 2 === 0;
      ts.push(trade({
        net: good ? 100 : -100, pnl: good ? 100 : -100,
        coin: good ? 'BTC' : 'ETH', dir: good ? 'Long' : 'Short',
        closeTime: (i + 1) * 3600000
      }));
    }
    const res = E.mineInsights(ts, t => t.net);
    ok(res && Array.isArray(res.validated), 'returns {validated:[...], ...}');
    ok(res.tested > 0, 'candidates were permutation-tested');
    ok(typeof res.mAll === 'number', 'reports baseline mean');
    ok(res.validated.length >= 1, 'the obvious edge clears BH-FDR');
    const top = res.validated[0];
    ok('n' in top && 'exp' in top && 'p' in top, 'insight carries n/exp/p');
    ok(top.exp > res.mAll, 'winning pattern beats the baseline');
  } finally { Math.random = realRandom; }
});

/* ---------- summary ---------- */
process.stdout.write('\n\n');
if (failures.length) {
  console.log('FAILURES:');
  for (const [n, m] of failures) console.log('  ✗ ' + n + '\n      ' + m);
  console.log('');
}
console.log(`${pass} passed, ${fail} failed  (source: ${path.relative(process.cwd(), HTML_PATH) || HTML_PATH})`);
process.exit(fail ? 1 : 0);
