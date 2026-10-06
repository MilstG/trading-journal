// What the data says, the parts worked out from your own trades on the device: your luck, measured
// (app/features/luck.js: the average trade's range from resampling, the window without the trade it leans on), the
// crowd at your entry (crowd.js: each entry against its hour's group flow) and your rules, replayed (rule-replay.js).
import { createRequire } from 'node:module';
import { t, ok, eq, near, report, makeExtractor } from './harness.mjs';

const require = createRequire(import.meta.url);
const { readAppSource } = require('../app-source.js');
const { evalModule } = makeExtractor(readAppSource(new URL('../ledger.html', import.meta.url).pathname));
const { luckOf } = await evalModule(['luckOf']);
const { crowdAtEntry } = await evalModule(['crowdAtEntry']);
const { rrReplay } = await evalModule(['rrReplay', 'evaluateRules', 'whatIfModel', 'whatIfStats', 'addedToLoser'], ['rrReplay'],
  'let _be=1; const isWin=n=>n>0&&n>=_be, isLoss=n=>n<0&&-n>=_be; const nfDayKey=ms=>new Date(ms).toISOString().slice(0,10); const fmtUsd=x=>"$"+x;');
const T0 = Date.parse('2026-09-01T00:00:00Z');
const tr = nets => nets.map((net, i) => ({ id: 'x' + i, net, closeTime: T0 + i * 3600000, coin: 'BTC', dir: 'Long' }));

t('under 5 closed trades: too few to say', () => eq(luckOf(tr([1, 2, 3, 4])), { n: 4, few: true }));
t('a month that rests on one trade: the result without it, and its share', () => {
  const L = luckOf(tr([4000, -100, 50, -200, 80, -30, 100]));
  eq([L.n, L.net, L.lean.net, L.without, Math.round(L.share * 100)], [7, 3900, 4000, -100, 103]);
  ok(L.lo < L.avg && L.avg < L.hi, 'the range brackets the average');
  ok(L.pPos > 0.5 && L.pPos < 0.95, 'one big winner among small losers: not sure — ' + L.pPos);
});
t('a steady edge is probably real; a losing week leans on its worst trade', () => {
  const L = luckOf(tr(Array.from({ length: 60 }, (_, i) => (i % 4 ? 30 : -20))));
  ok(L.pPos >= 0.95, 'steady: ' + L.pPos);
  const W = luckOf(tr([-3000, 100, 120, -50, 90]));
  eq([W.lean.net, W.without], [-3000, 260]); near(W.share, -3000 / -2740, 1e-9);
});
t('the same trades give the same range (a seeded resample)', () => eq(luckOf(tr([5, -3, 8, 1, -2, 7])), luckOf(tr([5, -3, 8, 1, -2, 7]))));

console.log('\nThe crowd at your entry');
t('each entry against its hour’s flow: with, against, balanced; outside the span or the coins, or an unread hour, nothing', () => {
  const H = 3600000, C = { from: T0, hours: 4, groups: ['all', 'tier:top'], coins: { BTC: { all: '4203', 'tier:top': '0.2.' } } };
  const e = (h, dir, net, coin) => ({ coin: coin || 'BTC', dir, net, openTime: T0 + h * H + 60000, closeTime: T0 + h * H + 120000 });
  const r = crowdAtEntry([e(0, 'Long', 10), e(1, 'Short', -5), e(2, 'Long', 3), e(3, 'Long', 7), e(3, 'Long', 1, 'ETH'), e(9, 'Long', 1)], C);
  // all: hour 0 buying hard (a long with it), 1 balanced (the short neither), 2 selling hard (a long against), 3 buying
  eq(r.groups.all, { with: { n: 2, net: 17 }, against: { n: 1, net: 3 }, flat: 1, read: 4 });
  eq(r.groups['tier:top'], { with: { n: 0, net: 0 }, against: { n: 1, net: 10 }, flat: 1, read: 2 });
  eq(r.coins, ['BTC']); eq(crowdAtEntry([], null), null);
});

console.log('\nYour rules, replayed');
t('trades that broke your own rules come out; the rest stay; the six slips replayed the same way', () => {
  const H = 3600000, D0 = Date.parse('2026-09-01T00:00:00Z'), now = D0 + 20 * 86400000, closed = [], bd = [];
  // 10 days: a loss, a quick re-entry 5 minutes later that loses again (a revenge slip, and a broken cool-down), a winner
  for (let d = 0; d < 10; d++) { const b = D0 + d * 86400000;
    closed.push({ id: d + 'a', net: -10, openTime: b + 9 * H, closeTime: b + 10 * H }, { id: d + 'b', net: -20, openTime: b + 10 * H + 300000, closeTime: b + 11 * H },
      { id: d + 'c', net: 50, openTime: b + 13 * H, closeTime: b + 14 * H });
    bd.push({ slips: [{ id: d + 'b', f: ['revenge'] }] }); }
  const x = rrReplay(closed, bd, { now, rules: { cooldownMin: 30 } });
  eq([x.n, x.net, x.rules.n, x.rules.net, x.rules.cut, x.slips.n, x.slips.net], [30, 200, 10, 400, -200, 10, 400]);
  eq(x.rules.which, { '30-min cooldown after a loss': 10 });
  const p = rrReplay(closed, bd, { now, plugs: ['revenge'] }); eq([p.rules.n, p.rules.which], [10, { 'plug:revenge': 10 }], 'a plugged leak is a rule of yours');
  const none = rrReplay(closed, bd, { now }); eq([none.hasRules, none.rules], [false, null]);
  eq(rrReplay(closed.slice(0, 5), bd, { now }).few, true);
});
report('data screen');
