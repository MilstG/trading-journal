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

report('features4');
