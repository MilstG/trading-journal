// Automatic metrics (useful with zero effort): the six Discipline checks read from fills, the
// logging bonus that can only add XP, Form against your own baseline, and Load against your
// usual day. pzBehaviorDays also runs on the server to verify the social boards.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { t, ok, eq, report, makeExtractor } from './harness.mjs';
import { readAppSource } from '../app-source.js'; // ledger.html with its app/*.js inlined, in load order

const html = readAppSource(new URL('../ledger.html', import.meta.url).pathname);
const { grabFn } = makeExtractor(html);
const ctx = { Math, Object, Array, String, JSON, Set, Map };
vm.createContext(ctx);
vm.runInContext(['nfMedian', 'hasAdd', 'addedToLoser', 'pzBehaviorDays', 'pzBonus', 'pzForm', 'pzLoad', 'pzDeepStats', 'pzSlipCost'].map(grabFn).join('\n'), ctx);

const MIN = 60000, DAY = 86400000, T0 = Date.UTC(2026, 8, 1);
const dayOf = ms => new Date(ms).toISOString().slice(0, 10);
const loss = n => n < -1;
let seq = 0;
// a trade on day d, opened at hh:mm, held `hold` minutes
const tr = (d, hh, mm, hold, net, extra) => { const o = T0 + d * DAY + (hh * 60 + mm) * MIN;
  return Object.assign({ id: 't' + (seq++), openTime: o, closeTime: o + hold * MIN, net, maxSize: 1, avgEntry: 100, dir: 'Long', isOpen: false }, extra || {}); };
const days = arr => ctx.pzBehaviorDays(arr, { dayOf, isLoss: loss });
const today = arr => days(arr).slice(-1)[0];

console.log('\nDiscipline checks');
t('a clean day scores 100', () => { const d = today([tr(0, 9, 0, 30, 50), tr(0, 11, 0, 30, -20)]); eq(d.score, 100); eq(d.clean, 2); });
t('re-entering within 15 minutes of a loss is a revenge entry', () => {
  const d = today([tr(0, 9, 0, 60, -40), tr(0, 10, 10, 30, 20)]);
  eq(d.flags.revenge, 1); eq(d.score, 50);
  eq(today([tr(0, 9, 0, 60, -40), tr(0, 10, 20, 30, 20)]).flags.revenge, 0, '20 minutes later is fine');
  eq(today([tr(0, 9, 0, 60, 40), tr(0, 10, 5, 30, 20)]).flags.revenge, 0, 'after a win is fine');
});
t('trading on after two losses in a row the same day', () => {
  const d = today([tr(0, 9, 0, 30, -10), tr(0, 10, 0, 30, -10), tr(0, 12, 0, 30, 5)]);
  eq(d.flags.afterTwo, 1);
  eq(today([tr(-1, 22, 0, 30, -10), tr(0, 9, 0, 30, -10), tr(0, 12, 0, 30, 5)]).flags.afterTwo, 0, 'yesterday’s loss doesn’t count');
});
t('a stop-and-reverse right after a loss is a revenge entry (close and entry share a millisecond)', () => {
  const a = tr(0, 9, 0, 60, -40), b = tr(0, 10, 0, 30, 20); b.openTime = a.closeTime;
  eq(today([a, b]).flags.revenge, 1);
});
t('trades cut off at the start of the history are skipped, not judged', () => {
  const d = today([tr(0, 9, 0, 0, -40, { partialHistory: true }), tr(0, 9, 5, 30, 20)]);
  eq(d.n, 1); eq(d.flags.revenge, 0);
});
t('sizing up right after a loss, against your recent median size', () => {
  const prior = [0, 1, 2, 3, 4].map(i => tr(-1, 9 + i, 0, 20, 5));
  const d = today([...prior, tr(0, 9, 0, 30, -30), tr(0, 10, 0, 30, 10, { maxSize: 2 })]);
  eq(d.flags.sizeUp, 1);
  eq(today([...prior, tr(0, 9, 0, 30, -30), tr(0, 10, 0, 30, 10, { maxSize: 1.4 })]).flags.sizeUp, 0, 'under 1.5× is fine');
});
t('overtrading counts trades past 1.5× your usual day (minimum 3), judged against earlier days only', () => {
  const prior = []; for (let d = -6; d < 0; d++) prior.push(tr(d, 9, 0, 20, 5), tr(d, 11, 0, 20, 5));
  const d = today([...prior, ...[0, 1, 2, 3, 4].map(i => tr(0, 8 + i * 2, 30, 20, 5))]);
  eq(d.flags.overtrade, 2); eq(d.score, 60);
  eq(today([tr(0, 9, 0, 20, 5), tr(0, 10, 0, 20, 5), tr(0, 11, 0, 20, 5), tr(0, 12, 0, 20, 5)]).flags.overtrade, 0, 'no history: no cap');
});
t('holding a loser more than 3× your usual winner hold', () => {
  const prior = [0, 1, 2].map(i => tr(-1, 9 + i, 0, 10, 20));
  eq(today([...prior, tr(0, 9, 0, 45, -30)]).flags.heldLoser, 1);
  eq(today([...prior, tr(0, 9, 0, 25, -30)]).flags.heldLoser, 0);
});
t('adding to a losing position, from the fill events', () => {
  const o = T0 + 9 * 60 * MIN;
  const added = tr(0, 9, 0, 60, -50, { events: [[o, 100, 1, 1], [o + MIN, 95, 1, 1], [o + 2 * MIN, 96, 2, -1]] });
  eq(today([added]).flags.addLoser, 1);
});

console.log('\nBonus XP');
t('logging only ever adds: check-in 10, plan 15, journal 15, stops 10, limit 10 — prorated, never negative', () => {
  eq(ctx.pzBonus(null, null), { parts: {}, total: 0 });
  eq(ctx.pzBonus({ parts: { plan: 0, journal: 0, limit: 0 } }, {}).total, 0, 'a missed plan or a blown limit costs nothing');
  const b = ctx.pzBonus({ parts: { plan: 1, journal: 0.5, planned: 1, limit: 1 }, credit: { checkin: true } }, { sleep: 3 });
  eq(b.parts, { checkin: 10, plan: 15, journal: 8, stops: 10, limit: 10 }); eq(b.total, 53);
  // the check-in pays only when processDays credited it (done on or before the day, AUDIT-4 X4)
  eq(ctx.pzBonus({ parts: {}, credit: { checkin: false } }, { sleep: 3 }).parts, {}, 'a check-in typed in after the day earns nothing');
  eq(ctx.pzBonus(null, { sleep: 3 }).parts, {}, 'no process day to vouch for it: nothing');
  eq(ctx.pzBonus({ parts: { plan: 0.5 } }, null).parts.plan, 8, 'a plan written after the first entry earns half');
});

console.log('\nForm and Load');
const hist = (nets, dFrom) => nets.map((n, i) => tr(dFrom + i, 10, 0, 30, n));
t('Form needs 15 trades and something in the last 30 days; 50 is your usual', () => {
  const now = T0 + 120 * DAY;
  const base = hist(Array.from({ length: 30 }, (_, i) => (i % 3 === 0 ? -40 : 30)), 80);
  eq(ctx.pzForm(base.slice(0, 12), now, { isWin: n => n > 1, isLoss: loss }).score, null, 'under 15 trades');
  eq(ctx.pzForm(hist(Array.from({ length: 30 }, () => 20), 20), now, { isWin: n => n > 1, isLoss: loss }).stale, true, 'nothing in 30 days');
  const slow = ctx.pzForm(base, now, { isWin: n => n > 1, isLoss: loss });
  ok(slow.score != null && slow.window === 'last 5 trades', 'a slow trader still gets a reading');
  const same = [...base, ...[30, -40, 30].map((n, i) => tr(115 + i, 10, 0, 30, n))];
  const f0 = ctx.pzForm(same, now, { isWin: n => n > 1, isLoss: loss });
  ok(f0.score >= 40 && f0.score <= 62, 'usual week near 50: ' + f0.score);
  const hot = [...base, ...[60, 70, 50].map((n, i) => tr(115 + i, 10, 0, 30, n))];
  const cold = [...base, ...[-60, -70, -50].map((n, i) => tr(115 + i, 10, 0, 30, n))];
  const fh = ctx.pzForm(hot, now, { isWin: n => n > 1, isLoss: loss }).score, fc = ctx.pzForm(cold, now, { isWin: n => n > 1, isLoss: loss }).score;
  ok(fh > f0.score && f0.score > fc, `hot ${fh} > usual ${f0.score} > cold ${fc}`);
  ok(fc < 40, 'a losing week reads as a slump');
});
t('Load: 50 is your usual day, 100 is twice it, and it needs 5 earlier trading days', () => {
  const prior = []; for (let d = 0; d < 6; d++) prior.push(tr(d, 9, 0, 20, 5), tr(d, 11, 0, 20, 5));
  const k = dayOf(T0 + 6 * DAY);
  eq(ctx.pzLoad(prior.slice(0, 8), k, dayOf).score, null);
  eq(ctx.pzLoad([...prior, tr(6, 9, 0, 20, 5), tr(6, 10, 0, 20, 5)], k, dayOf).score, 50);
  eq(ctx.pzLoad([...prior, ...[0, 1, 2, 3].map(i => tr(6, 9 + i, 0, 20, 5))], k, dayOf).score, 100);
  const big = ctx.pzLoad([...prior, tr(6, 9, 0, 20, 5, { maxSize: 6 })], k, dayOf);
  eq(big.rN, 0.5); eq(big.rV, 3); eq(big.score, 100, 'size counts as much as the number of trades');
  eq(ctx.pzLoad(prior, k, dayOf).score, 0);
});
t('the app and the server use one fixed loss rule, not the personal break-even setting', () => {
  ok(html.includes('const PZ_LOSS=n=>n<-1;'));
  ok(grabFn('gameContext').includes('isLoss:PZ_LOSS'));
  ok(readFileSync(new URL('../server.js', import.meta.url).pathname, 'utf8').includes("isLoss: n => n < -1"));
});

console.log('\nIn-depth stats');
t('each slip keeps its trades, so Stats can show what slips cost against clean trades', () => {
  const d = today([tr(0, 9, 0, 60, -40), tr(0, 10, 10, 30, -20), tr(0, 12, 0, 30, 30)]);
  eq(d.slips.map(x => [x.net, x.f]), [[-20, ['revenge']], [30, ['afterTwo']]]);
  const c = ctx.pzSlipCost([{ behavior: d }]);
  eq([c.slipN, c.slipNet, c.cleanN, c.cleanNet, c.by.revenge], [2, 10, 1, -40, { n: 1, net: -20 }]);
});
t('breakdowns: equity and drawdown, streaks, after a loss, sides, hours, size quarters, holding time, spread', () => {
  const nets = [50, -30, -20, -10, 40, 60, -5, 30, 20, -50];
  const T = nets.map((n, i) => tr(i, 9 + (i % 3), 0, 10 + i * 30, n, { dir: i % 2 ? 'Short' : 'Long', maxSize: i + 1, coin: i < 5 ? 'BTC' : 'ETH' }));
  const X = ctx.pzDeepStats(T, { isWin: n => n > 1, isLoss: loss, coin: t => t.coin, hourOf: ms => new Date(ms).getUTCHours(), dowOf: ms => new Date(ms).getUTCDay(), monthOf: ms => dayOf(ms).slice(0, 7) });
  eq(X.all.n, 10); eq(X.all.net, 85); eq(X.curve.at(-1).cum, 85);
  eq(X.maxDD, -60, 'from +50 down to −10');
  eq([X.streaks.bestW, X.streaks.bestL, X.streaks.current], [2, 3, -1]);
  eq(X.after.loss.n, 4); eq(X.after.win.n, 5);
  eq(X.side.map(r => [r.k, r.n]), [['Long', 5], ['Short', 5]]);
  eq(X.markets.map(r => r.k), ['ETH', 'BTC']);
  eq(X.hours.map(r => r.k), [9, 10, 11]);
  eq(X.bySize.map(r => r.n), [3, 2, 3, 2], 'quarters by rank');
  eq(X.byHold.map(r => r.label), ['5–60 min', '1–4 hours', '4–24 hours']);
  eq(X.dist.reduce((s, b) => s + b.n, 0), 10, 'every trade lands in one bucket');
  eq([X.best, X.worst], [60, -50]);
  eq(ctx.pzDeepStats([], {}), null);
});
const O = { isWin: n => n > 1, isLoss: loss, coin: () => 'X', hourOf: () => 0, dowOf: () => 0, monthOf: () => '2026-09' };
t('size quarters stay quarters when many trades share a size', () => {
  const T = Array.from({ length: 12 }, (_, i) => tr(i, 9, 0, 10, 5, { maxSize: i < 9 ? 1 : 2 + i }));
  eq(ctx.pzDeepStats(T, O).bySize.map(r => r.n), [3, 3, 3, 3]);
});
t('break-even trades neither extend nor break a run', () => {
  const X = ctx.pzDeepStats([10, 10, 0, 10, -10, -10, 0, -10].map((n, i) => tr(i, 9, 0, 10, n)), O);
  eq([X.streaks.bestW, X.streaks.bestL, X.streaks.current], [3, 3, -3]);
});
t('the trade after a loss is found even with another position open in between', () => {
  const A = tr(0, 9, 0, 70, -40), B = tr(0, 8, 59, 91, 20), C = tr(0, 10, 15, 30, 10); // A closes 10:10, B closes 10:30, C opens 10:15
  eq(ctx.pzDeepStats([A, B, C], O).after.loss.n, 1);
});
t('break-even trades get their own row in how trades land', () => {
  const X = ctx.pzDeepStats([0, 0, 0, 10, -10, 20, -20].map((n, i) => tr(i, 9, 0, 10, n)), O);
  eq(X.dist.find(b => b.kind === 'even').n, 3); eq(X.dist.filter(b => b.kind === 'loss').reduce((s, b) => s + b.n, 0), 2);
});

report('auto');
