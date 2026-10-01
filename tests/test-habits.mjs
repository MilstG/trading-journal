// Habit & process features: rules made from findings (+ did the rule change anything), live
// plans and the held-through-stop check, session check-in conditions, the journal inbox and
// streak, the daily process score, replay extremes, and the server's end-of-day nudge.
// Same pattern as the other suites: pure functions extracted straight from ledger.html and
// evaluated in a stubbed sandbox, so the tests exercise exactly what ships.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { t, ok, eq, near, report, makeExtractor } from './harness.mjs';
import { nudgeFrom, zonedDayHour } from '../server.js';

const html = readFileSync(new URL('../ledger.html', import.meta.url), 'utf8');
const { grabFn } = makeExtractor(html);
// multi-line const literals (arrays / objects) — not brace-extractable as functions
const grabConst = (name) => {
  const i = html.indexOf('const ' + name + '=');
  if (i < 0) throw new Error('const not found: ' + name);
  return html.slice(i, html.indexOf(';\n', i) + 1);
};

const FNS = ['nfMedian', 'nfRules', 'evaluateRules', 'nfPlan', 'planAdherence', 'nextPlan', 'nextDayEntry',
  'addedToLoser', 'tradeStates', 'checkinPred', 'minerFams', 'resolvePinPred', 'ruleIsLive', 'customRulePreds', 'customRulePredsNow',
  'ruleFollowThrough', 'liveRuleHits', 'isJournaled', 'journalInbox', 'journalStreak', 'processDays',
  'processQuadrants', 'processTrend', 'replayExtremes', '_erf'];
const CONSTS = ['CHECKIN_CONDS', 'PROCESS_W'];

const DAY = 86400000;
const ctx = { _be: 50, journal: {}, _excM: {}, settings: { rules: {} }, Date, Math, console, Set, Map, Object, JSON, isFinite };
ctx.tzMidnight = ms => Math.floor(ms / DAY) * DAY;
ctx.tzHour = ms => new Date(ms).getUTCHours();
ctx.tzDow = ms => new Date(ms).getUTCDay();
ctx.tzLabel = () => 'UTC';
ctx.dayKey = ms => new Date(ms).toISOString().slice(0, 10);
ctx.dayJKey = ms => 'day:' + ctx.dayKey(ms);
ctx.nfDayKey = ms => ctx.tzMidnight(ms);
ctx.isWin = n => n > ctx._be; ctx.isLoss = n => n < -ctx._be;
ctx.dcoin = x => x.symbol || x.coin; ctx.dispMarket = c => c;
ctx._avg = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;
ctx.fmtUsd = n => (n < 0 ? '-$' : '$') + Math.abs(n).toFixed(2);
vm.createContext(ctx);
vm.runInContext(CONSTS.map(grabConst).join('\n') + '\nconst _normCdf=z=>0.5*(1+_erf(z/Math.SQRT2));\n'
  + FNS.map(grabFn).join('\n') + '\nthis.CHECKIN_CONDS=CHECKIN_CONDS; this.PROCESS_W=PROCESS_W; this._normCdf=_normCdf;', ctx);

const T0 = Date.UTC(2026, 5, 1, 9);
const mk = (id, i, net, extra) => Object.assign({ id, coin: 'BTC', symbol: 'BTC', dir: 'Long', market: 'perp',
  openTime: T0 + i * DAY, closeTime: T0 + i * DAY + 3600e3, durationMs: 3600e3,
  avgEntry: 100, avgExit: 100 + net / 10, maxSize: 10, net }, extra || {});

console.log('\nRules from findings');
t('evaluateRules reports the violating trade ids (and marks the loss-limit rule)', () => {
  const b = T0;
  const closed = [0, 1, 2, 3].map(i => ({ id: 'r' + i, openTime: b + i * 6e4, closeTime: b + i * 6e4 + 1e3, net: -100 }));
  const r = ctx.evaluateRules(closed, { maxPerDay: 2, dailyLossLimit: 150 });
  eq(r.find(x => x.rule.startsWith('Max')).ids, ['r2', 'r3']);
  const dll = r.find(x => x.kind === 'dll');
  eq(dll.ids, ['r2', 'r3']); // trades closed after the day crossed -150
});
t('ruleIsLive: entry-knowable conditions only, pairs need both halves', () => {
  ok(ctx.ruleIsLive('mkt:ETH')); ok(ctx.ruleIsLive('st:loss2&dir:Short')); ok(ctx.ruleIsLive('ck:focusLo'));
  ok(!ctx.ruleIsLive('hold:lo')); ok(!ctx.ruleIsLive('exc:maeHi')); ok(!ctx.ruleIsLive('sess:0&dir:Long'));
});
t('customRulePreds judges an OPEN trade on its entry state (after 2 losses)', () => {
  ctx.journal = {};
  const closed = [mk('a', 0, -200), mk('b', 1, -300)];
  const open = { id: 'o', coin: 'BTC', symbol: 'BTC', dir: 'Short', market: 'perp', isOpen: true,
    openTime: T0 + 2 * DAY, avgEntry: 100, maxSize: 5, net: 0 };
  const preds = ctx.customRulePreds(closed.concat([open]), [{ pid: 'st:loss2', name: 'Avoid: after 2 losses', params: {}, createdAt: T0 }]);
  ok(preds[0].pred && preds[0].live);
  const hits = ctx.liveRuleHits([open], preds);
  eq(hits.length, 1); eq(hits[0].t.id, 'o');
  eq(preds[0].pred(closed[0]), false); // the first loss had no streak behind it
});
t('customRulePreds: unresolvable pid yields no predicate instead of throwing', () => {
  const preds = ctx.customRulePreds([mk('a', 0, 100)], [{ pid: 'nope:x', name: 'x', createdAt: T0 }]);
  eq(preds[0].pred, null);
});
t('ruleFollowThrough: fewer breaks after the rule reads as working', () => {
  const closed = [];
  for (let i = 0; i < 40; i++) closed.push(mk('f' + i, i, i % 2 ? 100 : -100, { coin: i < 20 ? (i % 2 ? 'ETH' : 'BTC') : (i === 25 ? 'ETH' : 'BTC') }));
  const pred = x => x.coin === 'ETH';
  const ft = ctx.ruleFollowThrough(closed, pred, T0 + 20 * DAY);
  eq(ft.before.n, 20); eq(ft.before.v, 10); eq(ft.after.v, 1);
  ok(ft.p < 0.01, 'p ' + ft.p); eq(ft.status, 'working');
});
t('ruleFollowThrough: statuses for too-new, clean and unchanged rules', () => {
  const closed = []; for (let i = 0; i < 30; i++) closed.push(mk('g' + i, i, 100, { coin: i % 3 ? 'BTC' : 'ETH' }));
  eq(ctx.ruleFollowThrough(closed, x => x.coin === 'ETH', T0 + 25 * DAY).status, 'collecting');
  eq(ctx.ruleFollowThrough(closed, () => false, T0 + 10 * DAY).status, 'clean');
  eq(ctx.ruleFollowThrough(closed, x => x.coin === 'ETH', T0 + 12 * DAY).status, 'not yet');
});

console.log('\nLive plans + the held-through-stop check');
t('nextPlan stamps changes, keeps the stamp on an unchanged re-save, leaves legacy plans unstamped', () => {
  const p1 = ctx.nextPlan(null, 100, 95, 110, 1000); eq(p1.at, 1000);
  eq(ctx.nextPlan(p1, 100, 95, 110, 5000).at, 1000);
  eq(ctx.nextPlan(p1, 100, 94, 110, 5000).at, 5000);
  eq(ctx.nextPlan({ entry: 100, stop: 95, target: 110 }, 100, 95, 110, 5000).at, undefined);
  eq(ctx.nextPlan(p1, NaN, NaN, NaN, 5000), null);
});
t('planAdherence: price through the stop while holding is a broken stop, even on a winning exit', () => {
  const tr = mk('h', 0, 50, { avgEntry: 100, avgExit: 105 });
  const J = { h: { plan: { entry: 100, stop: 97, target: 110, at: tr.openTime + 1 } } };
  const noExc = ctx.planAdherence([tr], J, {});
  eq(noExc.items[0].stopHonored, true);
  const pa = ctx.planAdherence([tr], J, { h: { maePct: 4.5 } }); // traded down to 95.5, stop 97
  eq(pa.items[0].heldThrough, true); eq(pa.items[0].stopHonored, false); eq(pa.heldThroughN, 1);
  eq(ctx.planAdherence([tr], J, { h: { maePct: 4.5, coarse: true } }).items[0].heldThrough, false); // approximate candles don't convict
});
t('planAdherence splits plans written live from hindsight plans', () => {
  const a = mk('l1', 0, 100), b = mk('l2', 1, -100, { avgExit: 90 });
  const J = { l1: { plan: { entry: 100, stop: 95, at: a.openTime + 60e3 } },
              l2: { plan: { entry: 100, stop: 95, at: b.closeTime + 60e3 } } };
  const pa = ctx.planAdherence([a, b], J, {});
  eq(pa.liveN, 1); eq(pa.hindsightN, 1); eq(pa.liveHonoredRate, 1); eq(pa.hindsightHonoredRate, 0);
});

console.log('\nSession check-in');
t('nextDayEntry keeps the first plannedAt and drops empty entries', () => {
  const e1 = ctx.nextDayEntry(null, { plan: 'fade the open', sleep: 2 }, 1000);
  eq(e1.plannedAt, 1000); eq(e1.sleep, 2);
  eq(ctx.nextDayEntry(e1, { plan: 'fade the open', review: 'ok' }, 9000).plannedAt, 1000);
  eq(ctx.nextDayEntry(null, { focus: 4 }, 1000).plannedAt, undefined); // a check-in alone is not a plan
  eq(ctx.nextDayEntry(e1, {}, 9000), null);
});
t('check-in conditions read the entry day and join the miner once 10 trades carry one', () => {
  const tr = []; for (let i = 0; i < 12; i++) tr.push(mk('c' + i, i, i % 2 ? 80 : -80));
  ctx.journal = {};
  let fams = ctx.minerFams(tr, ctx.tradeStates(tr));
  ok(!fams.mood, 'no check-ins yet → no family');
  for (let i = 0; i < 12; i++) ctx.journal[ctx.dayJKey(tr[i].openTime)] = { sleep: i < 6 ? 2 : 4, focus: 3 };
  fams = ctx.minerFams(tr, ctx.tradeStates(tr));
  ok(fams.mood, 'family present');
  eq(fams.mood.map(x => x[2]), ctx.CHECKIN_CONDS.map(x => x[1]));
  const sleepLo = fams.mood.find(x => x[2] === 'ck:sleepLo')[1];
  eq(tr.filter(sleepLo).length, 6);
  // pinned check-in conditions resolve by id even when the family would be absent
  const pred = ctx.resolvePinPred({ pid: 'ck:sleepLo', params: {} }, tr.slice(0, 2), ctx.tradeStates(tr));
  eq(tr.filter(pred).length, 6);
  ctx.journal = {};
});

console.log('\nJournal inbox + streak');
t('inbox lists unjournaled closed trades from the window, newest first', () => {
  const now = T0 + 10 * DAY;
  const tr = [mk('i1', 9, 10), mk('i2', 8, 10), mk('i3', 7, 10), mk('old', -40, 10), { ...mk('op', 9, 0), isOpen: true }];
  const J = { i2: { rating: 3 } };
  eq(ctx.journalInbox(tr, J, now, 30).map(x => x.id), ['i1', 'i3']);
});
t('streak counts fully journaled trading days; an unfinished today does not break it', () => {
  const tr = [mk('s1', 0, 1), mk('s2', 1, 1), mk('s3', 2, 1), mk('s4', 3, 1), mk('s5', 4, 1)];
  const J = { s1: { setup: 'x' }, s3: { rating: 4 }, s4: { tags: ['a'] } };
  const today = ctx.dayKey(tr[4].closeTime);
  const st = ctx.journalStreak(tr, J, ctx.dayKey, today);
  eq(st.current, 2); // days 3 and 4 (index 2,3); today (index 4) still open
  eq(st.best, 2);
  eq(ctx.journalStreak(tr, J, ctx.dayKey, 'some-other-day').current, 0); // a finished unjournaled day breaks it
});

console.log('\nProcess score');
t('a clean, planned, journaled day scores 100; parts that do not apply drop out', () => {
  const a = mk('p1', 0, 100);
  const k = ctx.dayKey(a.closeTime);
  const J = { ['day:' + k]: { plan: 'x', plannedAt: a.openTime - 1 },
              p1: { setup: 'breakout', plan: { entry: 100, stop: 95, at: a.openTime + 1 } } };
  const d = ctx.processDays([a], J, { dayOf: ctx.dayKey, violIds: new Set() })[0];
  eq(d.score, 100); eq(d.parts.limit, undefined); eq(d.parts.stops, 1);
});
t('late plan, broken rule, no journal, trading past the loss limit all cost points', () => {
  const a = mk('q1', 0, -300), b = mk('q2', 0, -100, { openTime: T0 + 3601e3 + 60e3, closeTime: T0 + 3 * 3600e3 });
  const k = ctx.dayKey(a.closeTime);
  const J = { ['day:' + k]: { plan: 'x', plannedAt: a.openTime + 1, maxLoss: 250 } };
  const d = ctx.processDays([a, b], J, { dayOf: ctx.dayKey, violIds: new Set(['q2']) })[0];
  eq(d.parts.plan, 0.5); eq(d.parts.rules, 0.5); eq(d.parts.limit, 0); eq(d.parts.journal, 0);
  eq(d.parts.planned, undefined); // no trade plan ever written yet → not graded
  const W = ctx.PROCESS_W;
  eq(d.score, Math.round(100 * (W.plan * 0.5 + W.rules * 0.5) / (W.plan + W.rules + W.limit + W.journal)));
});
t('planning habits are graded only from the first day they were used', () => {
  const d0 = mk('u0', 0, 50), d1 = mk('u1', 1, 50), d2 = mk('u2', 2, 50);
  const J = { ['day:' + ctx.dayKey(d1.closeTime)]: { plan: 'x', plannedAt: d1.openTime - 1 },
              u1: { plan: { entry: 100, stop: 95, at: d1.openTime + 1 } } };
  const days = ctx.processDays([d0, d1, d2], J, { dayOf: ctx.dayKey, violIds: new Set() });
  eq(days[0].parts.plan, undefined); eq(days[0].parts.planned, undefined); // before either habit existed
  eq(days[1].parts.plan, 1); eq(days[1].parts.planned, 1);
  eq(days[2].parts.plan, 0); eq(days[2].parts.planned, 0);               // skipped once the habit exists
});
t('quadrants and trend', () => {
  const days = [{ score: 90, net: 10 }, { score: 80, net: -5 }, { score: 40, net: 20 }, { score: 30, net: -7 }, { score: 75, net: 1 }];
  const q = ctx.processQuadrants(days, 70);
  eq([q.earned.n, q.goodLoss.n, q.lucky.n, q.deserved.n], [2, 1, 1, 1]);
  near(q.earned.net, 11);
  const tr = ctx.processTrend(days, 2);
  near(tr.avg, 52.5); near(tr.prevAvg, 60); eq(tr.streak, 1);
});

console.log('\nReplay extremes');
t('worst and best prices while on, side-aware', () => {
  const tr = { avgEntry: 100, openTime: 0, closeTime: 10, dir: 'Long' };
  const candles = [[0, 104, 99, 101], [5, 108, 97, 106], [20, 150, 50, 100]]; // last candle is after the close
  const ex = ctx.replayExtremes(tr, candles, 5);
  eq(ex.worst.y, 97); near(ex.worst.pct, -3); eq(ex.best.y, 108);
  const sh = ctx.replayExtremes({ ...tr, dir: 'Short' }, candles, 5);
  eq(sh.worst.y, 108); eq(sh.best.y, 97);
});

console.log('\nEnd-of-day nudge (server)');
t('zonedDayHour follows the configured zone', () => {
  const ms = Date.UTC(2026, 8, 30, 2, 30); // 02:30 UTC = 22:30 previous day in New York
  eq(zonedDayHour(ms, 'UTC'), { day: '2026-09-30', hour: 2 });
  eq(zonedDayHour(ms, 'America/New_York'), { day: '2026-09-29', hour: 22 });
});
t('nudge fires after the hour, once per day key, only when something is missing', () => {
  const cfg = { hour: 18 };
  const st = { dayKey: '2026-09-30', hour: 19, tradesToday: 4, unjournaled: 3, hasReview: false };
  const n = nudgeFrom(st, cfg);
  eq(n.key, 'nudge:2026-09-30'); ok(n.text.includes('3 of 4 trades not journaled')); ok(n.text.includes('no end-of-day review'));
  eq(nudgeFrom({ ...st, hour: 17 }, cfg), null);
  eq(nudgeFrom({ ...st, tradesToday: 0, unjournaled: 0 }, cfg), null);
  eq(nudgeFrom({ ...st, unjournaled: 0, hasReview: true }, cfg), null);
  eq(nudgeFrom(st, { hour: null }), null);
});

report('habits');
