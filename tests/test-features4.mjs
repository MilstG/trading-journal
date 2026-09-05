// Unit tests for the second features build: setup scorecards, correlation-cluster
// exposure, scenario shock, monthly goals, CSV fill import. Same pattern as every suite:
// extract the pure functions from ledger.html, pin behaviour against hand-computed values.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { t, ok, eq, near, report, makeExtractor } from './harness.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '..', 'ledger.html'), 'utf8');
const { evalModule } = makeExtractor(html);

const PRELUDE = `
const _be=50; const isWin=n=>n>_be; const isLoss=n=>n<-_be;
const _avg=a=>a.length?a.reduce((x,y)=>x+y,0)/a.length:0;
`;

const { setupScorecards } = await evalModule(['setupScorecards'], ['setupScorecards'], PRELUDE);
const { csvParseRows, parseFillsCsv, reconstructTrades } = await evalModule(
  ['csvParseRows', 'parseFillsCsv', 'isPerp', 'newTrade', 'tallyFill', 'reconstructTrades'],
  ['csvParseRows', 'parseFillsCsv', 'reconstructTrades'], PRELUDE);

const DAY = 86400000, T0 = 1700000000000;
const mk = (setup, net, i) => ({ id: setup + i, net, closeTime: T0 + i * DAY, isOpen: false });

console.log('\nsetup scorecards');
t('needs 5 trades per setup; groups by journaled setup', () => {
  const trades = []; const J = {};
  for (let i = 0; i < 6; i++) { const tr = mk('breakout', 100, i); trades.push(tr); J[tr.id] = { setup: 'breakout' }; }
  for (let i = 0; i < 3; i++) { const tr = mk('fade', 100, i); trades.push(tr); J[tr.id] = { setup: 'fade' }; }
  const cards = setupScorecards(trades, J);
  eq(cards.length, 1); eq(cards[0].name, 'breakout'); eq(cards[0].n, 6);
});
t('equity curve is cumulative in close-time order', () => {
  const J = {}; const trades = [300, -100, 200, -100, 100, 100].map((net, i) => {
    const tr = mk('s', net, i); J[tr.id] = { setup: 's' }; return tr; });
  const c = setupScorecards(trades, J)[0];
  eq(c.curve, [300, 200, 400, 300, 400, 500]); near(c.net, 500);
});
t('trend: recent third beats early two-thirds → improving', () => {
  const J = {}; const trades = [10, 10, 10, 10, 300, 300].map((net, i) => {
    const tr = mk('s', net, i); J[tr.id] = { setup: 's' }; return tr; });
  eq(setupScorecards(trades, J)[0].trend, 'improving');
});
t('trend: positive start, negative recent third → flipped', () => {
  const J = {}; const trades = [200, 200, 200, 200, -300, -300].map((net, i) => {
    const tr = mk('s', net, i); J[tr.id] = { setup: 's' }; return tr; });
  eq(setupScorecards(trades, J)[0].trend, 'flipped');
});
t('trend: still positive but decaying → fading', () => {
  const J = {}; const trades = [400, 400, 400, 400, 100, 100].map((net, i) => {
    const tr = mk('s', net, i); J[tr.id] = { setup: 's' }; return tr; });
  eq(setupScorecards(trades, J)[0].trend, 'fading');
});
t('capped at 6 setups, ranked by |net|', () => {
  const J = {}; const trades = [];
  for (let s = 0; s < 8; s++) for (let i = 0; i < 5; i++) {
    const tr = { id: 's' + s + '_' + i, net: (s + 1) * 100, closeTime: T0 + i * DAY, isOpen: false };
    trades.push(tr); J[tr.id] = { setup: 'setup' + s };
  }
  const cards = setupScorecards(trades, J);
  eq(cards.length, 6); eq(cards[0].name, 'setup7'); // biggest |net| first
});

const { coinCorrelations, exposureClusters, scenarioShock } = await evalModule(
  ['coinCorrelations', 'exposureClusters', 'scenarioShock'],
  ['coinCorrelations', 'exposureClusters', 'scenarioShock'], PRELUDE);

console.log('\ncorrelation clusters');
// 30 days of candles: A and B move in lockstep, C is independent noise
const mkCandles = (seed, follow) => {
  let px = 100; const rows = [[T0, 0, 0, px, 0]];
  let s = seed;
  for (let i = 1; i <= 30; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    const r = follow ? follow[i] : ((s / 0x7fffffff) - 0.5) * 0.04;
    px *= 1 + r; rows.push([T0 + i * DAY, 0, 0, px, 0]);
  }
  return rows;
};
const drift = []; { let s = 7; for (let i = 0; i <= 30; i++) { s = (s * 48271) % 2147483647; drift.push(((s / 2147483647) - 0.5) * 0.05); } }
const A = mkCandles(1, drift), B = mkCandles(2, drift.map(r => r * 1.1)), C = mkCandles(3, null);
t('lockstep coins report high rho; independent one does not cluster', () => {
  const corr = coinCorrelations({ A, B, C });
  ok(corr['A|B'] > 0.95, 'A|B rho=' + corr['A|B']);
  ok(Math.abs(corr['A|C']) < 0.6, 'A|C rho=' + corr['A|C']);
});
t('pairs need 20 overlapping days', () => {
  const corr = coinCorrelations({ A, D: A.slice(0, 10) });
  eq(corr['A|D'], undefined);
});
t('exposureClusters nets within a cluster and reports the diversification gap', () => {
  const corr = { 'A|B': 0.9, 'A|C': 0.1, 'B|C': 0.05 };
  const res = exposureClusters([
    { coin: 'A', net: 10000 }, { coin: 'B', net: -4000 }, { coin: 'C', net: 3000 },
  ], corr, 0.7);
  eq(res.clusters.length, 1);
  eq(res.clusters[0].coins.sort(), ['A', 'B']);
  near(res.clusters[0].net, 6000); near(res.clusters[0].gross, 14000);
  near(res.naiveDirectional, 17000);   // 10k + 4k + 3k independently
  near(res.effectiveDirectional, 9000); // |10k-4k| + 3k
});
t('no strong pairs → no clusters, both totals equal', () => {
  const res = exposureClusters([{ coin: 'A', net: 5000 }, { coin: 'B', net: 5000 }], { 'A|B': 0.2 }, 0.7);
  eq(res.clusters.length, 0);
  near(res.naiveDirectional, res.effectiveDirectional);
});

console.log('\nmonthly goals');
{
  const { monthlyGoalModel } = await evalModule(['monthlyGoalModel'], ['monthlyGoalModel'],
    PRELUDE + "const settings={tz:'utc'}; const tzParts=ms=>{const d=new Date(ms);return {y:d.getUTCFullYear(),mo:d.getUTCMonth(),day:d.getUTCDate(),h:0,min:0,dow:d.getUTCDay()};};");
  const NOW = Date.UTC(2026, 8, 15, 12); // Sep 15 2026 — day 15 of a 30-day month
  const MSTART = Date.UTC(2026, 8, 1);
  const tr = (net, day) => ({ isOpen: false, closeTime: Date.UTC(2026, 8, day, 6), net });
  t('net, projection, and pace against the target', () => {
    const m = monthlyGoalModel([tr(600, 3), tr(-100, 8), tr(500, 12), tr(1000, 33)], { monthlyTarget: 3000 }, NOW);
    near(m.net, 1000);            // the day-33 trade is October's
    eq(m.dayOf, 15); eq(m.daysIn, 30);
    near(m.projected, 2000);      // 1000/15*30
    near(m.paceNeeded, 2000 / 16); // (3000-1000) over the 16 remaining days
    eq(m.mStart, MSTART);
  });
  t('intramonth drawdown is peak-to-trough of the month cum', () => {
    const m = monthlyGoalModel([tr(500, 2), tr(-800, 5), tr(200, 9)], { maxDD: 500 }, NOW);
    near(m.intraDD, -800);
  });
  t('trades/week vs cap', () => {
    const m = monthlyGoalModel([tr(100, 2), tr(100, 3), tr(100, 4), tr(100, 5)], { maxTradesWeek: 1 }, NOW);
    near(m.tradesPerWeek, 4 / (14.5 / 7), 0.01); // 4 trades over ~2.07 weeks
  });
  t('no goals set → null (section shows the prompt instead)', () => {
    eq(monthlyGoalModel([tr(1, 1)], {}, NOW), null);
    eq(monthlyGoalModel([tr(1, 1)], null, NOW), null);
  });
}

console.log('\nscenario shock');
const BOOK = [
  { coin: 'BTC', side: 'long',  notional: 10000, mark: 100, liq: 85 },
  { coin: 'ETH', side: 'short', notional: 5000,  mark: 50,  liq: 58 },
];
t('signed PnL: -10% hurts longs, helps shorts', () => {
  const sc = scenarioShock(BOOK, 20000, -10);
  near(sc.pnl, -10000 * 0.1 + 5000 * 0.1); // -1000 + 500
  near(sc.acctPct, -500 / 20000, 1e-9);
  eq(sc.liqs.length, 0); // BTC shocked to 90, liq 85 — survives
});
t('a deep enough shock crosses liquidation', () => {
  const sc = scenarioShock(BOOK, 20000, -20);
  eq(sc.liqs.length, 1); eq(sc.liqs[0].coin, 'BTC'); // 100→80 ≤ 85
});
t('upside shock can liquidate the short', () => {
  const sc = scenarioShock(BOOK, 20000, 20);
  eq(sc.liqs.length, 1); eq(sc.liqs[0].coin, 'ETH'); // 50→60 ≥ 58
});

console.log('\ngeneric CSV fill import');
t('csvParseRows: quotes, doubled quotes, CRLF', () => {
  eq(csvParseRows('a,b\r\n"x,1","he said ""hi"""\n'), [['a', 'b'], ['x,1', 'he said "hi"']]);
});
t('header aliases map loosely; ISO and epoch-seconds times both parse', () => {
  const { fills, derived } = parseFillsCsv(
    'Date,Symbol,Direction,Price,Quantity,Commission\n'
    + '2026-01-02T00:00:00Z,BTC,buy,100,2,0.5\n'
    + '1767312000,BTC,sell,110,2,0.5\n'); // 2026-01-02T00:40-ish, epoch seconds
  eq(fills.length, 2);
  eq(fills[0].side, 'B'); eq(fills[1].side, 'A');
  eq(fills[0].time, Date.parse('2026-01-02T00:00:00Z'));
  eq(fills[1].time, 1767312000000);
  ok(derived, 'startPosition/closedPnl were derived');
});
t('derived fills reconstruct into a correct round trip', () => {
  const { fills } = parseFillsCsv(
    'time,coin,side,px,sz,fee\n'
    + '1700000000000,ETH,buy,1000,1,1\n'
    + '1700000100000,ETH,sell,1100,1,1\n');
  const trades = reconstructTrades(fills, 'csv', 'perp');
  eq(trades.length, 1);
  near(trades[0].pnl, 100);   // average-cost realization on the close
  near(trades[0].fees, 2);
  ok(!trades[0].isOpen);
});
t('average-cost derivation handles scale-in and a flip', () => {
  const { fills } = parseFillsCsv(
    'time,coin,side,px,sz\n'
    + '1700000000000,SOL,buy,100,1\n'
    + '1700000001000,SOL,buy,110,1\n'   // avg now 105
    + '1700000002000,SOL,sell,120,3\n'  // closes 2 @ +15 avg = +30, flips short 1 @ 120
    + '1700000003000,SOL,buy,110,1\n'); // closes the short: +10
  const trades = reconstructTrades(fills, 'csv', 'perp');
  eq(trades.length, 2);
  const long = trades.find(t => t.dir === 'Long'), short = trades.find(t => t.dir === 'Short');
  near(long.pnl, 30); near(short.pnl, 10);
});
t('explicit closedPnl / startPosition columns win over derivation', () => {
  const { fills, derived } = parseFillsCsv(
    'time,coin,side,px,sz,closedPnl,startPosition\n'
    + '1700000000000,ETH,buy,1000,1,0,0\n'
    + '1700000100000,ETH,sell,1100,1,42,1\n');
  eq(fills[1].closedPnl, '42'); ok(!derived);
});
t('missing required columns → specific error', () => {
  let msg = '';
  try { parseFillsCsv('when,what\n1,2\n'); } catch (e) { msg = e.message; }
  ok(msg.includes('could not find column(s)'));
  ok(msg.includes('coin'));
});
t('junk rows are skipped and counted, not imported', () => {
  const { fills, skipped } = parseFillsCsv(
    'time,coin,side,px,sz\n'
    + '1700000000000,ETH,buy,1000,1\n'
    + 'not-a-date,ETH,buy,1000,1\n'
    + '1700000000000,ETH,hold,1000,1\n');
  eq(fills.length, 1); eq(skipped, 2);
});

report('features4');
