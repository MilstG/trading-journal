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
