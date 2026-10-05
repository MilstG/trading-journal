// The discipline measurements XP is built on (AUDIT-4 E1–E5, X4, X10): the routine score that
// "Does discipline pay?" correlates with results must be outcome-blind (no link found on coin flips,
// a real one still found); the loss-limit part sees every entry after the breach and partial closes;
// a stop-out with normal slippage is a stop honored; a revenge entry or a size-up is caught whatever
// closed in between; the day's first entry includes trades still open; logging typed onto an old day
// mints no XP; and the game's context ignores the view and dex filters.
import vm from 'node:vm';
import { t, ok, eq, near, report, makeExtractor } from './harness.mjs';
import { readAppSource } from '../app-source.js';

const html = readAppSource(new URL('../ledger.html', import.meta.url).pathname);
const { grabFn } = makeExtractor(html);
const grabConst = name => { const i = html.indexOf('const ' + name + '='); if (i < 0) throw new Error('const not found: ' + name); return html.slice(i, html.indexOf(';\n', i) + 1); };
const dayOf = ms => new Date(ms).toISOString().slice(0, 10);
const ctx = { Math, Object, Array, String, JSON, Set, Map, Number, Date, isFinite, Infinity, console, dcoin: x => x.coin, nfDayKey: dayOf };
vm.createContext(ctx);
const CONSTS = ['PROCESS_W', 'RV_BLIND', 'RV_CHANCE', 'RV_HABITS', 'HL_MIN', 'HL_BANDS', 'HL_SURE'];
const FNS = ['nfMedian', 'hasAdd', 'addedToLoser', 'pzBehaviorDays', '_spearmanWith', '_seededRnd', 'routineVsResults', 'isoWeekOfKey',
  'rvRoutineOf', 'rvChanceSplit', 'habitLink', 'hlSummary', 'hlLinkWords', 'nfPlan', 'planStopBand', 'planAdherence', 'planVerdict',
  'processDays', 'realizedByDay', 'isJournaled', 'pzBonus', 'nextDayEntry', 'pzRisk', 'dailyLossToday'];
vm.runInContext(CONSTS.map(grabConst).join('\n') + '\n' + FNS.map(grabFn).join('\n') + '\n' + FNS.concat(CONSTS).map(f => 'this.' + f + '=' + f + ';').join(''), ctx);
const C = ctx, M = 60000, H = 3600e3, DAY = 864e5;

/* ---------------- E1: the routine score is outcome-blind ---------------- */
// 140 trading days of 4 trades, ±1R. mode 'same': every entry 5 minutes after the previous close
// (the audit's repro); 'null': 5 or 30 minutes at random, unrelated to results; 'planted': on tilt
// days (40%) every entry after a loss comes 5 minutes later and those revenge entries win 20% of the time.
function sim(seed, mode) {
  const rnd = C._seededRnd(seed), T0 = Date.UTC(2026, 0, 5, 9), trades = []; let id = 0;
  for (let d = 0; d < 140; d++) { let tm = T0 + d * DAY, prevLoss = false; const tilt = rnd() < 0.4;
    for (let k = 0; k < 4; k++) { let rev = false;
      if (k > 0) { const quick = mode === 'same' ? true : mode === 'null' ? rnd() < 0.5 : prevLoss && tilt; rev = quick && prevLoss; tm += quick ? 5 * M : 30 * M; }
      const win = rnd() < (mode === 'planted' && rev ? 0.2 : 0.5), net = win ? 100 : -100, o = tm, c = tm + 30 * M;
      trades.push({ id: 't' + (id++), coin: 'BTC', dir: 'Long', openTime: o, closeTime: c, net, maxSize: 1, avgEntry: 1000, events: [[o, 1000, 1, 1], [c, 1000, 1, -1]] });
      tm = c; prevLoss = !win; } }
  const days = C.pzBehaviorDays(trades, { dayOf, isLoss: n => n < -1 }).map(b => ({ key: b.key, behavior: b, score: b.score, parts: {} }));
  const byDay = {}; for (const x of trades) (byDay[dayOf(x.closeTime)] = byDay[dayOf(x.closeTime)] || []).push(x);
  const r = C.routineVsResults(days, byDay, { rOf: x => x.net / 100, weekOf: k => C.isoWeekOfKey(k), seed: 7 });
  const L = C.habitLink(days, byDay, { rOf: x => x.net / 100, unit: 'R' });
  return { r, L, S: C.hlSummary(L), W: C.hlLinkWords(L.corr) };
}
console.log('\nE1 · does discipline pay, on coin flips');
t('identical behaviour, coin-flip results: no link, no dividend, no "strong link" (was ρ 0.87, p 0.001, +0.81R)', () => {
  const { r, L, S, W } = sim(12345, 'same');
  ok(!r.corr || r.corr.p > 0.2, 'weekly link: ' + JSON.stringify(r.corr));
  ok(!r.dividend || (r.dividend.lo < 0 && r.dividend.hi > 0), 'dividend: ' + JSON.stringify(r.dividend));
  const rev = r.habits.find(h => h.key === 'revenge');
  ok(rev.p == null || rev.p > 0.05, 'revenge habit: ' + JSON.stringify(rev));
  ok(!W || !/^Strong/.test(W.text), 'habitLink: ' + (W && W.text));
  ok(S.verdict !== 'pays', 'no "yes, your habits pay": ' + S.verdict);
  ok(r.weeks.every(w => w.score === r.weeks[0].score), 'the same behaviour every week scores the same every week');
});
t('random timing unrelated to results: links and dividends turn up no more than chance allows', () => {
  let corr = 0, div = 0, hl = 0, rev = 0; const N = 20;
  for (let i = 1; i <= N; i++) { const { r, L } = sim(5000 + 13 * i, 'null');
    if (r.corr && r.corr.p < 0.05) corr++; if (r.dividend && (r.dividend.lo > 0 || r.dividend.hi < 0)) div++;
    if (L.corr && L.corr.p < 0.05) hl++; const h = r.habits.find(x => x.key === 'revenge'); if (h.q != null && h.q < 0.1) rev++; }
  // 5% / 10% expected by chance; before the fix the dividend excluded zero in about half of these
  ok(corr <= 3 && hl <= 3 && rev <= 3 && div <= 4, JSON.stringify({ corr, hl, rev, div }));
});
t('a planted effect (revenge entries lose more) is still found: the habit trade by trade, and the dividend', () => {
  let rev = 0, div = 0, hl = 0; const N = 10;
  for (let i = 1; i <= N; i++) { const { r, S } = sim(5000 + 13 * i, 'planted');
    const h = r.habits.find(x => x.key === 'revenge');
    eq(h.per, 'trade', 'post-loss entries, slipped vs kept');
    if (h.q < 0.1 && h.diff > 0) rev++; if (r.dividend && r.dividend.lo > 0) div++; if (S.verdict === 'pays') hl++; }
  eq(rev, N, 'the revenge habit pays, every time');
  ok(div >= 5 && hl >= 5, JSON.stringify({ div, hl }));
});
t('the score conditions on chances: kept ÷ chances per check, your usual rate on a day without one', () => {
  const b = k => ({ key: k, behavior: { chances: { revenge: 2, sizeUp: 0 }, kept: { revenge: 1 } } });
  const none = { key: 'x', behavior: { chances: {}, kept: {} } };
  const RT = C.rvRoutineOf([b('a'), b('b'), none]);
  eq(RT(b('a')).score, 50); eq(RT(none).score, 50, 'no loss to react to: the usual rate, not a free 100');
  eq(RT(b('a')).stratum, '2:0'); eq(RT(none).stratum, '0:0');
  eq(C.rvRoutineOf([none])(none).score, 100, 'nothing ever testable');
});

/* ---------------- E4: every close in the window ---------------- */
console.log('\nE4 · revenge and sizing up see every close in the window');
const T = Date.UTC(2026, 5, 1, 10);
const mk = (id, o, c, net, x) => Object.assign({ id, coin: 'BTC', dir: 'Long', openTime: T + o * M, closeTime: T + c * M, net, maxSize: 1, avgEntry: 100, events: [[T + o * M, 100, 1, 1], [T + c * M, 100, 1, -1]] }, x || {});
t('a loss at 10:00, a winner closing 10:05, a new entry 10:06: a revenge entry (was missed, score 100)', () => {
  const d = C.pzBehaviorDays([mk('L', -60, 0, -200), mk('W', -30, 5, 50), mk('N', 6, 30, -10)], { dayOf, isLoss: n => n < -1 })[0];
  eq(d.flags.revenge, 1); eq(d.slips.map(s => s.id), ['N']); eq(d.score, 67);
  eq(d.tests.revenge, ['N'], 'the entry is recorded as a chance at revenge');
});
t('sizing up after a loss with a winner closing in between is caught too', () => {
  const prior = Array.from({ length: 6 }, (_, i) => mk('p' + i, -2000 + i * 100, -1950 + i * 100, 5));
  const d = C.pzBehaviorDays([...prior, mk('L', -60, 0, -200), mk('W', -30, 40, 50), mk('N', 50, 80, 5, { maxSize: 3 })], { dayOf, isLoss: n => n < -1 }).pop();
  ok(d.flags.sizeUp === 1 && d.flags.revenge === 0, JSON.stringify(d.flags));
});

/* ---------------- E3: stop slippage ---------------- */
console.log('\nE3 · a stop-out with normal slippage is a stop honored');
t('long, stop 90, out at 89.9: honored, as planVerdict says "followed"; past 10% of the risk it is not', () => {
  const tr = x => ({ id: 'C', coin: 'BTC', dir: 'Long', openTime: T, closeTime: T + H, net: -101, avgEntry: 100, avgExit: x, maxSize: 10 });
  const J = { C: { plan: { entry: 100, stop: 90, at: T - 1000 } } };
  eq(C.planAdherence([tr(89.9)], J, {}).items[0].stopHonored, true);
  eq(C.planVerdict(tr(89.9), C.nfPlan(J.C), null).v, 'followed');
  eq(C.planAdherence([tr(88.5)], J, {}).items[0].stopHonored, false);
  eq(C.planVerdict(tr(88.5), C.nfPlan(J.C), null).v, 'moved');
  eq(C.processDays([tr(89.9)], J, { dayOf, rulesActive: false })[0].parts.stops, 1, 'the stops part (was 0, process 30)');
  // shorts mirror; a wick inside the band is not "held through"
  const s = { ...tr(110.5), dir: 'Short' }, JS = { C: { plan: { entry: 100, stop: 110, at: T - 1000 } } };
  eq(C.planAdherence([s], JS, {}).items[0].stopHonored, true);
  eq(C.planAdherence([tr(95)], J, { C: { maePct: 10.5 } }).items[0].heldThrough, false, 'traded to 89.5: inside the band');
  eq(C.planAdherence([tr(95)], J, { C: { maePct: 12 } }).items[0].heldThrough, true, 'traded to 88: through the stop');
});

/* ---------------- E2 / E5: all trades, open ones included; realized fill by fill ---------------- */
console.log('\nE2 · E5 · entries and results from all trades');
const D0 = Date.UTC(2026, 5, 1);
const lim = (at) => ({ 'day:2026-06-01': { maxLoss: 100, limitAt: at, updatedAt: at } });
t('limit $100: −$150 closes 10:00, B opens 10:30 and closes tomorrow (or is still open): the limit part is 0', () => {
  const A = { id: 'A', openTime: D0 + 9 * H, closeTime: D0 + 10 * H, net: -150 };
  const B = { id: 'B', openTime: D0 + 10.5 * H, closeTime: D0 + DAY + H, net: 20 };
  let d = C.processDays([A, B], lim(D0), { dayOf, rulesActive: false });
  eq([d[0].parts.limit, d[0].breached], [0, true], 'was limit 1: "Respected your loss limit" paid +10');
  eq(C.pzBonus(d[0], lim(D0)['day:2026-06-01']).parts.limit, undefined);
  const Bopen = { id: 'B', openTime: D0 + 10.5 * H, isOpen: true, net: 0 };
  d = C.processDays([A], lim(D0), { dayOf, rulesActive: false, trades: [A, Bopen] });
  eq(d[0].parts.limit, 0, 'a position opened after the breach and still open');
  d = C.processDays([A], lim(D0), { dayOf, rulesActive: false, trades: [A] });
  eq(d[0].parts.limit, 1, 'nothing opened after it: respected');
});
t('a −$300 partial close of a position still open breaches a $200 limit, by its realized fills', () => {
  const P = { id: 'P', openTime: D0 + 8 * H, isOpen: true, net: -300, rz: [[D0 + 9 * H, -300]] };
  const W = { id: 'W', openTime: D0 + 8.5 * H, closeTime: D0 + 9.5 * H, net: 10, rz: [[D0 + 9.5 * H, 10]] };
  const N = { id: 'N', openTime: D0 + 11 * H, closeTime: D0 + 12 * H, net: 5, rz: [[D0 + 12 * H, 5]] };
  const J = { 'day:2026-06-01': { maxLoss: 200, limitAt: D0, updatedAt: D0 } };
  const d = C.processDays([W, N], J, { dayOf, rulesActive: false, trades: [P, W, N] })[0];
  eq([d.breached, d.parts.limit], [true, 0], 'was: no breach seen (only whole closed trades counted)');
  // and a trade closing today doesn't bring yesterday's partial loss into today
  const Y = { id: 'Y', openTime: D0 - DAY, closeTime: D0 + 10 * H, net: -250, rz: [[D0 - DAY + H, -240], [D0 + 10 * H, -10]] };
  const d2 = C.processDays([Y, N], J, { dayOf, rulesActive: false, trades: [Y, N] }).find(x => x.key === '2026-06-01');
  eq(d2.breached, false, 'only −$10 of it was realized today');
});
t('Pulse’s risk dial reads the same realized fills as the tripwire', () => {
  const now = Date.now(), k = dayOf(now), P = { id: 'P', openTime: now - 3 * H, closeTime: now - M, isOpen: true, net: -300, rz: [[now - M, -300]] };
  const r = C.pzRisk([P], { maxLoss: 200 }, {}, k, dayOf);
  eq([r.net, r.loss, r.used], [-300, 300, 1.5], 'was 0 / 0 / 0 while the tripwire fired');
  eq(r.net, C.dailyLossToday([P]).net);
  const Q = { id: 'Q', openTime: now - 3 * H, closeTime: now - M, net: -50 };
  eq(C.pzRisk([Q], null, { dailyLossLimit: 100 }, k, dayOf).loss, 50, 'a trade without per-fill results counts whole on its close day');
});
t('the day’s first entry includes a trade that closes tomorrow (plan at 09:00, entries 08:00 and 10:00 → half)', () => {
  const A = { id: 'A', openTime: D0 + 8 * H, closeTime: D0 + 26 * H, net: 5 }, B = { id: 'B', openTime: D0 + 10 * H, closeTime: D0 + 11 * H, net: 5 };
  const J = { 'day:2026-06-01': { plan: 'x', plannedAt: D0 + 9 * H } };
  const d = C.processDays([A, B], J, { dayOf, rulesActive: false });
  eq(d[0].parts.plan, 0.5, 'was 1 (+15 XP)'); eq(d[0].first, A.openTime);
  eq(C.pzBonus(d[0], J['day:2026-06-01']).parts.plan, 8);
  const Aopen = { ...A, isOpen: true, closeTime: undefined };
  eq(C.processDays([B], J, { dayOf, rulesActive: false, trades: [Aopen, B] })[0].parts.plan, 0.5, 'a position still open counts too');
});

/* ---------------- X4: no backdated bonus XP ---------------- */
console.log('\nX4 · logging typed onto an old day journals it but mints no XP');
const S1 = Date.UTC(2026, 8, 1, 14), K1 = '2026-09-01';
const old = [{ id: 'a', openTime: S1, closeTime: S1 + H, net: -500 }, { id: 'b', openTime: S1 + 2 * H, closeTime: S1 + 3 * H, net: -800 }];
const run = J => { const p = C.processDays(old, J, { dayOf })[0]; return { parts: p.parts, bonus: C.pzBonus(p, J['day:' + K1]) }; };
t('a month later: plan text, max loss 1e9 and sleep 5 on a red day earn nothing (was +28 XP)', () => {
  eq(run({}).bonus.total, 0);
  const e = C.nextDayEntry(undefined, { plan: 'x', maxLoss: 1e9, sleep: 5 }, Date.UTC(2026, 9, 3));
  ok(e.plannedAt && e.limitAt && e.checkinAt, 'each one stamped when it was set');
  const r = run({ ['day:' + K1]: e });
  eq(r.bonus.parts, {}, JSON.stringify(r)); eq(r.parts.plan, 0); eq(r.parts.limit, undefined, 'the late limit is ignored (no standing limit either)');
});
t('the same logging done that morning earns all of it; done after the first entry the same day, plan half and no limit', () => {
  const early = C.nextDayEntry(undefined, { plan: 'x', maxLoss: 2000, sleep: 5 }, S1 - H);
  eq(run({ ['day:' + K1]: early }).bonus.parts, { checkin: 10, plan: 15, limit: 10 });
  const late = C.nextDayEntry(undefined, { plan: 'x', maxLoss: 2000, sleep: 5 }, S1 + 30 * M);
  eq(run({ ['day:' + K1]: late }).bonus.parts, { checkin: 10, plan: 8 }, 'the check-in counts on its own day');
});
t('loosening the limit after the first entry restamps it; tightening keeps the stamp', () => {
  const e0 = C.nextDayEntry(undefined, { plan: 'x', maxLoss: 1000 }, S1 - H);
  eq(run({ ['day:' + K1]: e0 }).parts.limit, 1, 'limit $1,000: breached at b’s close, nothing opened after');
  const looser = C.nextDayEntry(e0, { plan: 'x', maxLoss: 1e9 }, S1 + 4 * H);
  eq(looser.limitAt, S1 + 4 * H); eq(run({ ['day:' + K1]: looser }).parts.limit, undefined, 'raising it after trading doesn’t dodge the breach');
  const tighter = C.nextDayEntry(e0, { plan: 'x', maxLoss: 400 }, S1 + 4 * H);
  eq(tighter.limitAt, S1 - H); eq(tighter.plannedAt, S1 - H);
  eq(run({ ['day:' + K1]: tighter }).parts.limit, 0, 'tightened to $400: breached at a’s close, b came after — it can only cost');
  const ck = C.nextDayEntry(C.nextDayEntry(undefined, { sleep: 3 }, S1 - H), { sleep: 4, plan: 'y' }, S1 + DAY * 30);
  eq(ck.checkinAt, S1 - H, 'editing a check-in keeps when it was first done');
});
t('entries from before the stamps keep the benefit of the doubt; re-saving them never costs credit', () => {
  const sameDay = { plan: 'x', maxLoss: 2000, sleep: 4, updatedAt: S1 + 5 * H };
  eq(run({ ['day:' + K1]: sameDay }).bonus.parts, { checkin: 10, plan: 15, limit: 10 });
  const later = { plan: 'x', maxLoss: 2000, sleep: 4, updatedAt: S1 + 30 * DAY };
  eq(run({ ['day:' + K1]: later }).bonus.parts, { checkin: 10, plan: 15, limit: 10 }, 'a next-day edit of an old entry keeps what it earned');
  // re-saving a legacy entry leaves its old fields unstamped instead of stamping them "now"
  const re = C.nextDayEntry(sameDay, { plan: 'x', maxLoss: 2000, sleep: 4, review: 'ok' }, S1 + 30 * DAY);
  eq([re.plannedAt, re.limitAt, re.checkinAt], [undefined, undefined, undefined]);
  eq(run({ ['day:' + K1]: re }).bonus.parts, { checkin: 10, plan: 15, limit: 10 });
  // but anything newly set on an old day is stamped now and earns nothing: the backdating hole stays shut
  const bare = { review: 'old notes', updatedAt: S1 + 5 * H };
  const added = C.nextDayEntry(bare, { review: 'old notes', plan: 'x', maxLoss: 1e9, sleep: 5 }, S1 + 30 * DAY);
  eq([added.plannedAt, added.limitAt, added.checkinAt], [S1 + 30 * DAY, S1 + 30 * DAY, S1 + 30 * DAY]);
  eq(run({ ['day:' + K1]: added }).bonus.parts, {});
  const loosened = C.nextDayEntry(sameDay, { plan: 'x', maxLoss: 1e9, sleep: 4 }, S1 + 30 * DAY);
  eq(loosened.limitAt, S1 + 30 * DAY, 'loosening an old limit restamps it');
  eq(run({ ['day:' + K1]: loosened }).bonus.parts.limit, undefined);
});
t('the posted prep flag (Trader Age’s o.p) follows the credited check-in, not the raw entry', () => {
  ok(grabFn('pzSocialStats').includes('if(d.checkin)o.p=1'), 'pulse-social posts d.checkin');
  ok(grabFn('gameContext').includes('checkin:!!(p&&p.credit&&p.credit.checkin)'));
});

/* ---------------- X10: the game ignores the view and dex filters ---------------- */
console.log('\nX10 · XP doesn’t depend on the view or dex filter');
t('coachContext(true) reads every trade but orphans; the view one follows the filters; separate memos', () => {
  const X = { Math, Object, Array, String, JSON, Set, Map, Number, Date, isFinite, console,
    view: 'perp', dexView: 'main', settings: { tz: 'utc', rules: {}, habits: [] }, _jrev: 1, _excM: {}, _be: 50,
    dayKey: dayOf, customRules: () => [], habitsList: () => [], processContext: tr => ({ days: tr.map(x => x.id) }) };
  X.viewFilter = x => !x.orphan && x.market === X.view && !x.coin.includes(':'); X.tradeRow = x => !x.spotRz;
  const at = Date.UTC(2026, 5, 1, 9);
  X.allTrades = [{ id: 'p', market: 'perp', coin: 'BTC' }, { id: 's', market: 'spot', coin: 'PURR' }, { id: 'x', market: 'perp', coin: 'xyz:TSLA' }, { id: 'o', market: 'perp', coin: 'ETH', orphan: true, isOpen: true }]
    .map(x => ({ openTime: at, closeTime: at + H, net: 1, ...x }));
  vm.createContext(X);
  vm.runInContext('var _coachMemo={key:null,ctx:null}, _coachMemoAll={key:null,ctx:null};' + grabFn('_coachKey') + grabFn('coachContext') + ';this.coachContext=coachContext;', X);
  eq(X.coachContext(true).trades.map(x => x.id), ['p', 's', 'x']);
  eq(X.coachContext().trades.map(x => x.id), ['p']);
  X.view = 'spot'; X.dexView = 'all';
  eq(X.coachContext(true).trades.map(x => x.id), ['p', 's', 'x'], 'switching the view leaves the game alone');
  eq(X.coachContext().trades.map(x => x.id), ['s']);
  ok(grabFn('gameContext').includes('coachContext(true)') && grabFn('_gameKey').includes('_coachMemoAll.key'));
  ok(grabFn('rvModel').includes('ctx=g.ctx') && grabFn('hlModel').includes('ctx=g.ctx'), 'Review’s routine vs results reads the same trades as the days it scores');
});

report('discipline measures');
