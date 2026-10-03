// Plan vs outcome and the fill-by-fill replay: pending plans attaching to (and expiring before)
// trades, planned R:R and achieved R, the verdicts, the aggregate card numbers, and the replay's
// per-fill position/P&L steps. Pure functions extracted from the shipped app, as in every suite.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { t, ok, eq, near, report, makeExtractor } from './harness.mjs';
import { readAppSource } from '../app-source.js';

const here = dirname(fileURLToPath(import.meta.url));
const html = readAppSource(join(here, '..', 'ledger.html'));
const { evalModule } = makeExtractor(html);

const PRELUDE = `
const settings={tz:'utc'};
const _be=50; const isWin=n=>n>_be; const isLoss=n=>n<-_be;
let _rng=Math.random;
`;
const M = await evalModule(
  ['planCoinKey', 'pplanCheck', 'planPzPx', 'pzPx', 'pplanList', 'pplanStatus', 'pplanMatches', 'nfPlan', 'planStopBand', 'planVerdict', 'planWords', 'planStats',
   'replayFillSteps', 'replayPnlAt', 'nextPlan', '_srand', '_hashSeed', 'demoFills', 'isPerp', 'newTrade', 'tallyFill', 'reconstructTrades'],
  ['planCoinKey', 'pplanCheck', 'pplanList', 'pplanStatus', 'pplanMatches', 'nfPlan', 'planVerdict', 'planWords', 'planStats',
   'replayFillSteps', 'replayPnlAt', 'nextPlan', 'demoFills', 'reconstructTrades'], PRELUDE);
const { planCoinKey, pplanCheck, pplanList, pplanStatus, pplanMatches, nfPlan, planVerdict, planWords, planStats, replayFillSteps, replayPnlAt } = M;

const H = 3600e3, T0 = Date.UTC(2026, 8, 20, 12);

console.log('\npending plans: form check, attach, expiry');
t('market names compare without case, dex prefix or spot quote', () => {
  eq(planCoinKey(' btc '), 'BTC'); eq(planCoinKey('xyz:TSLA'), 'TSLA'); eq(planCoinKey('purr/usdc'), 'PURR'); eq(planCoinKey(null), '');
});
t('the form check: a market and a stop are required, prices must sit on the right sides', () => {
  ok(pplanCheck({ coin: '', stop: 1 }).includes('market'));
  ok(pplanCheck({ coin: 'BTC', dir: 'Long', stop: null }).includes('stop'));
  ok(pplanCheck({ coin: 'BTC', dir: 'Long', entry: 100, stop: 105 }).includes('below'), 'long stop above entry');
  ok(pplanCheck({ coin: 'BTC', dir: 'Short', entry: 100, stop: 95 }).includes('above'), 'short stop below entry');
  ok(pplanCheck({ coin: 'BTC', dir: 'Long', stop: 90, target: 80 }).includes('above'), 'long target under the stop');
  ok(pplanCheck({ coin: 'BTC', dir: 'Short', entry: 100, stop: 110, target: 101 }).includes('below'), 'short target above entry');
  eq(pplanCheck({ coin: 'BTC', dir: 'Long', stop: 90 }), '', 'entry and target are optional');
  eq(pplanCheck({ coin: 'BTC', dir: 'Short', entry: 100, stop: 110, target: 80 }), '');
});
t('the form check refuses markets nobody knows and prices that aren’t prices', () => {
  const known = { BTC: 62000, ETH: 0, SOL: 150 };
  ok(/No market called ZZZNOTACOIN/.test(pplanCheck({ coin: 'zzznotacoin', dir: 'Long', stop: 1 }, known)));
  eq(pplanCheck({ coin: 'xyz:eth', dir: 'Long', stop: 3000 }, known), '', 'a known market (any spelling), no price known: fine');
  for (const big of [1e300, 1e308, Infinity, NaN]) ok(/isn’t a price/.test(pplanCheck({ coin: 'ETH', dir: 'Long', stop: big }, known)), String(big));
  ok(/isn’t a price/.test(pplanCheck({ coin: 'ETH', dir: 'Long', stop: 90, target: 1e300 }, known)), 'a target too');
  ok(/far from BTC’s price \(62,000\.00\)/.test(pplanCheck({ coin: 'BTC', dir: 'Long', stop: 600 }, known)), 'a stop off by a few zeros');
  ok(/target is far from BTC/.test(pplanCheck({ coin: 'BTC', dir: 'Long', stop: 60000, target: 6400000 }, known)));
  ok(/entry is far from SOL/.test(pplanCheck({ coin: 'SOL', dir: 'Short', entry: 15000, stop: 16000 }, known)));
  ok(/far from your entry/.test(pplanCheck({ coin: 'ETH', dir: 'Long', entry: 3000, stop: 2 }, known)), 'no price known: held against the entry');
  ok(/far from your stop/.test(pplanCheck({ coin: 'ETH', dir: 'Long', stop: 3000, target: 90000 }, known)), 'nor an entry: target against stop');
  eq(pplanCheck({ coin: 'BTC', dir: 'Long', entry: 61000, stop: 59000, target: 70000 }, known), '');
  eq(pplanCheck({ coin: 'ANY', dir: 'Long', stop: 90 }), '', 'without the list the name isn’t checked');
});
const tr = (id, coin, dir, openTime, extra) => Object.assign({ id, coin, dir, openTime, closeTime: openTime + H, isOpen: false }, extra || {});
t('a plan attaches to the NEXT trade on its market and side within 24h', () => {
  const J = { 'pplan:a': { coin: 'BTC', dir: 'Long', stop: 90, at: T0 } };
  const trades = [tr('eth', 'ETH', 'Long', T0 + H), tr('short', 'BTC', 'Short', T0 + H), tr('late', 'BTC', 'Long', T0 + 3 * H), tr('next', 'BTC', 'Long', T0 + 2 * H)];
  eq(pplanMatches(J, trades, T0 + 5 * H), [{ key: 'pplan:a', tid: 'next' }]);
});
t('a trade opened a few minutes BEFORE the plan still counts (typed just after the click); earlier ones do not', () => {
  const J = { 'pplan:a': { coin: 'btc', dir: 'Long', stop: 90, at: T0 } };
  eq(pplanMatches(J, [tr('x', 'BTC', 'Long', T0 - 2 * 60e3)], T0), [{ key: 'pplan:a', tid: 'x' }]);
  eq(pplanMatches(J, [tr('x', 'BTC', 'Long', T0 - 10 * 60e3)], T0), []);
});
t('no trade within 24h: the plan expires and never attaches to a later trade', () => {
  const J = { 'pplan:a': { coin: 'BTC', dir: 'Short', stop: 110, at: T0 } };
  eq(pplanMatches(J, [tr('x', 'BTC', 'Short', T0 + 25 * H)], T0 + 26 * H), []);
  eq(pplanStatus(pplanList(J)[0], T0 + 23 * H), 'pending');
  eq(pplanStatus(pplanList(J)[0], T0 + 25 * H), 'expired');
  eq(pplanStatus({ at: T0, tid: 'x' }, T0 + 99 * H), 'attached');
});
t('a trade that already has a plan keeps it; two plans take two trades, oldest plan first; an attached plan holds its trade', () => {
  const J = {
    'pplan:b': { coin: 'SOL', dir: 'Long', stop: 9, at: T0 + 60e3 },
    'pplan:a': { coin: 'SOL', dir: 'Long', stop: 8, at: T0 },
    'pplan:c': { coin: 'SOL', dir: 'Long', stop: 8, at: T0, tid: 't3' },
    t1: { plan: { stop: 7 } },
  };
  const trades = [tr('t1', 'SOL', 'Long', T0 + H), tr('t2', 'SOL', 'Long', T0 + 2 * H), tr('t3', 'SOL', 'Long', T0 + 3 * H), tr('t4', 'SOL', 'Long', T0 + 4 * H)];
  eq(pplanMatches(J, trades, T0 + 5 * H), [{ key: 'pplan:a', tid: 't2' }, { key: 'pplan:b', tid: 't4' }]);
});
t('a HIP-3 / spot symbol matches the plan’s plain market name; non-plan journal keys are ignored', () => {
  const J = { 'pplan:a': { coin: 'TSLA', dir: 'Long', stop: 1, at: T0 }, 'day:2026-09-20': { plan: 'x' }, 'pplan:bad': { coin: 'X', at: T0 } };
  eq(pplanList(J).map(p => p.key), ['pplan:a'], 'entries without a stop are not plans');
  eq(pplanMatches(J, [tr('h', 'xyz:TSLA', 'Long', T0 + H)], T0), [{ key: 'pplan:a', tid: 'h' }]);
  eq(pplanMatches({ 'pplan:a': { coin: 'PURR', dir: 'Long', stop: 1, at: T0 } }, [tr('s', '@107', 'Long', T0 + H, { symbol: 'PURR/USDC' })], T0), [{ key: 'pplan:a', tid: 's' }]);
});
t('a Long plan attaches to a spot buy (spot trades carry dir "Spot"); a Short plan never does (audit 4 E7)', () => {
  const spot = tr('s', '@107', 'Spot', T0 + H, { symbol: 'PURR/USDC' });
  eq(pplanMatches({ 'pplan:a': { coin: 'PURR', dir: 'Long', stop: 1, at: T0 } }, [spot], T0 + 2 * H), [{ key: 'pplan:a', tid: 's' }]);
  eq(pplanMatches({ 'pplan:a': { coin: 'PURR', dir: 'Short', stop: 1, at: T0 } }, [spot], T0 + 2 * H), []);
});

console.log('\nplanned R:R, achieved R, verdicts');
const L = (exit, extra) => Object.assign({ id: 'L', dir: 'Long', avgEntry: 100, avgExit: exit, maxSize: 2, isOpen: false, events: [] }, extra || {});
const P = { entry: 100, stop: 90, target: 120 };
t('out at the target: followed, planned 1:2, achieved +2.1R', () => {
  const r = planVerdict(L(121), P);
  eq(r.v, 'followed'); near(r.rr, 2); near(r.R, 2.1); near(r.R$, 20); eq(r.cost, 0);
});
t('out at the stop (and within 10% of 1R of slippage past it): followed, −1R', () => {
  const r = planVerdict(L(90), P); eq(r.v, 'followed'); near(r.R, -1);
  eq(planVerdict(L(89.2), P).v, 'followed');
});
t('a loss bigger than the stop: "moved", priced against the −1R the plan allowed', () => {
  const r = planVerdict(L(85), P);
  eq(r.v, 'moved'); near(r.R, -1.5); near(r.costR, -0.5); near(r.cost, -10); ok(r.priced);
});
t('out before the target: "early" — costed only when the target printed while held', () => {
  const r = planVerdict(L(110), P);
  eq(r.v, 'early'); near(r.R, 1); ok(!r.priced); eq(r.cost, 0);
  const r2 = planVerdict(L(110), P, { maePct: 2, mfePct: 21, coarse: false });   // best price 121 ≥ target
  eq(r2.v, 'early'); ok(r2.priced); near(r2.costR, -1); near(r2.cost, -20);
  const r3 = planVerdict(L(110), P, { maePct: 2, mfePct: 21, coarse: true });    // coarse candles: not trusted
  ok(!r3.priced);
});
t('price through the stop while in, exit back above it: "held past the stop" (MAE or a fill beyond the stop)', () => {
  const r = planVerdict(L(105), P, { maePct: 15, mfePct: 5 });           // worst 85 < stop 90
  eq(r.v, 'held'); ok(r.thru); near(r.R, 0.5); near(r.costR, 1.5, 1e-9, 'held and got lucky: positive against the plan');
  eq(planVerdict(L(105), P, { maePct: 9.5, mfePct: 5 }).v, 'early', 'a wick inside the slippage band is not a breach');
  const ev = [[1, 100, 1, 1], [2, 88, 1, 1], [3, 104, 2, -1]];         // an add at 88, below the stop
  eq(planVerdict(L(104, { events: ev }), P).v, 'held');
});
t('no target: any exit that respects the stop is followed', () => {
  eq(planVerdict(L(95), { entry: null, stop: 90, target: null }).v, 'followed');
  eq(planVerdict(L(95), { entry: null, stop: 90, target: null }).rr, null);
});
t('shorts mirror longs', () => {
  const S = x => ({ id: 'S', dir: 'Short', avgEntry: 100, avgExit: x, maxSize: 1, isOpen: false, events: [] }), p = { entry: 100, stop: 110, target: 80 };
  const a = planVerdict(S(80), p); eq(a.v, 'followed'); near(a.R, 2); near(a.rr, 2);
  const b = planVerdict(S(112), p); eq(b.v, 'moved'); near(b.R, -1.2);
  eq(planVerdict(S(90), p).v, 'early');
  eq(planVerdict(S(95), p, { maePct: 12, mfePct: 6 }).v, 'held');
});
t('1R is the entry-to-stop distance actually carried: a worse fill than planned still stops out at −1R', () => {
  const r = planVerdict(L(90), { entry: 98, stop: 90, target: 114 });
  eq(r.v, 'followed'); near(r.R, -1); near(r.rr, 2, 1e-9, 'planned R:R uses the planned entry');
});
t('editing an attached plan on the journal row keeps its one-line reason and, unchanged, its time', () => {
  const prev = { entry: '', stop: 90, target: 120, at: T0, why: 'Breakout' };
  eq(M.nextPlan(prev, NaN, 90, 120, T0 + H), { entry: '', stop: 90, target: 120, at: T0, why: 'Breakout' });
  eq(M.nextPlan(prev, NaN, 92, 120, T0 + H).at, T0 + H);
});
t('no plan → "none"; an open trade has no verdict yet; nfPlan needs a stop', () => {
  eq(planVerdict(L(100), null).v, 'none');
  eq(planVerdict(L(100, { isOpen: true }), P), null);
  eq(nfPlan({ plan: { entry: 100, target: 120 } }), null);
  eq(nfPlan({ plan: { entry: '', stop: '90', target: '' } }), { entry: null, stop: 90, target: null });
  for (const v of ['followed', 'early', 'moved', 'held', 'none']) ok(planWords(v)[0] && planWords(v)[1] && planWords(v)[2], v);
});

console.log('\naggregate: the Pulse card and the Diagnostic table');
t('share planned, adherence, average R followed vs not, cost by deviation, worst deviation, by setup', () => {
  const mk = (id, exit, setup, plan) => ({ t: L(exit, { id }), j: plan === null ? { setup } : { setup, plan: plan || { entry: 100, stop: 90, target: 120 } } });
  const rows = [mk('a', 121, 'Breakout'), mk('b', 90, 'Breakout'), mk('c', 85, 'Breakout'), mk('d', 110, 'Fade'),
    mk('e', 105, 'Fade'), mk('f', 130, 'Fade', null), mk('g', 70, '', null)];
  const J = Object.fromEntries(rows.map(r => [r.t.id, r.j])), closed = rows.map(r => r.t);
  const excM = { d: { maePct: 1, mfePct: 25 }, e: { maePct: 20, mfePct: 3 } };
  const S = planStats(closed, J, excM);
  eq(S.n, 7); eq(S.planned, 5); near(S.share, 5 / 7);
  eq(S.followed, 2); near(S.adherence, 0.4);
  eq([S.by.early.n, S.by.moved.n, S.by.held.n], [1, 1, 1]);
  near(S.by.moved.cost, -10); near(S.by.early.cost, -20); near(S.by.held.cost, (0.5 + 1) * 20);
  near(S.avgRFollowed, (2.1 - 1) / 2); near(S.avgRBroke, (-1.5 + 1 + 0.5) / 3);
  eq(S.worst.k, 'early'); near(S.worst.cost, -20);
  near(S.devCost, -10 - 20 + 30);
  const bo = S.bySetup.find(x => x.k === 'Breakout'), fa = S.bySetup.find(x => x.k === 'Fade');
  eq([bo.n, fa.n], [3, 2]); near(bo.rr, 2); near(bo.R, (2.1 - 1 - 1.5) / 3); near(bo.adherence, 2 / 3); eq(fa.adherence, 0);
});
t('nothing planned: no adherence, no worst; open trades are not counted', () => {
  const S = planStats([L(110, { id: 'x' }), L(110, { id: 'o', isOpen: true })], {}, {});
  eq([S.n, S.planned, S.adherence, S.worst], [1, 0, null, null]);
});

console.log('\nreplay: one step per fill');
t('long: entry, add, partial close, exit — size, average, banked and open P&L after each fill', () => {
  const st = replayFillSteps('Long', [[3, 120, 1, -1], [1, 100, 1, 1], [2, 110, 1, 1], [4, 100, 1, -1]]);
  eq(st.map(s => s.what), ['entry', 'add', 'partial close', 'exit']);
  eq(st.map(s => s.pos), [1, 2, 1, 0]);
  near(st[1].avg, 105); near(st[1].open, 10, 1e-9, 'marked at the add price: (110−105)×2');
  near(st[2].real, 15); near(st[2].open, 15); near(st[3].real, 10); eq(st[3].avg, null); eq(st[3].open, 0);
});
t('short: profit when price falls; matches the bar replay’s P&L at the same moment', () => {
  const ev = [[1, 100, 2, 1], [2, 90, 1, -1], [3, 95, 1, -1]], st = replayFillSteps('Short', ev);
  near(st[1].real, 10); near(st[1].open, 10); near(st[2].real, 15);
  const p = replayPnlAt('Short', ev, 2, 90); near(p.realized, st[1].real); near(p.open, st[1].open); eq(p.pos, st[1].pos);
});
t('replaying reconstructed trades: the banked P&L at the last fill equals the trade’s own gross realized P&L', () => {
  const NOW = Date.UTC(2026, 8, 24, 15), trades = M.reconstructTrades(M.demoFills(1, NOW), 'demo', 'perp').filter(x => !x.isOpen && !x.partialHistory);
  ok(trades.length > 20, 'demo history has trades: ' + trades.length);
  let checked = 0;
  for (const x of trades) { const st = replayFillSteps(x.dir, x.events), last = st[st.length - 1];
    eq(last.pos, 0, 'flat after the last fill: ' + x.id);
    near(last.real, x.pnl, Math.max(0.05, Math.abs(x.pnl) * 1e-6), 'realized ' + x.id); checked++; }
  ok(checked === trades.length);
});
t('no events: no steps', () => { eq(replayFillSteps('Long', null), []); });

report('plans');
