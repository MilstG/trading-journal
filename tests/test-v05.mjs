// v0.5 in the app: the tilt reading, market regimes, lessons resurfacing, process goals and
// fee/funding efficiency — the pure functions behind each, run in a bare context.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { t, ok, eq, report, makeExtractor } from './harness.mjs';

const html = readFileSync(new URL('../ledger.html', import.meta.url).pathname, 'utf8');
const { grabFn } = makeExtractor(html);
const grabConst = (name) => { const i = html.indexOf('const ' + name + '='); if (i < 0) throw new Error(name);
  return html.slice(i, html.indexOf(';\n', i) + 1); };
const ctx = { Math, Object, Array, String, Number, JSON, isFinite, Date, Set, Map };
vm.createContext(ctx);
const load = (consts, fns) => vm.runInContext(consts.map(grabConst).join('\n') + '\n' + fns.map(grabFn).join('\n'), ctx);
load(['PZ_LOSS', 'PZ_TILT_W', 'PZ_TILT_HOT', 'PZ_VOL'], ['pzTilt', 'nfMedian', 'pzRegimes', 'pzRegimeInsight', 'pzLessonTag', 'pzLessonList', 'pzLessonDue', 'pzLessonFor']);
load([], ['pzCostStats', 'pzSnapSvg', 'pzLessonsNorm', '_syncMerge']);
ctx.usdPlain = v => '$' + Math.abs(v).toFixed(2); ctx.esc = x => String(x); ctx.dispMarket = x => x; ctx.dcoin = t => t.coin; ctx.dayLabel = k => k; ctx.dayKey = ms => new Date(ms).toISOString().slice(0, 10);
load(['PZ_LESSON_STEPS', 'PZ_LESSON_TAGS', 'PZ_TILT_SLIP', 'PZ_SLIP_TOPIC', 'pzMonthEnd', 'pzDaysBetween'], ['pzGoalEval']);
ctx.signedPlain = v => (v < 0 ? '−$' : '+$') + Math.abs(Math.round(v));

const M = 60000, NOW = Date.UTC(2026, 9, 1, 15);
console.log('\nTilt');
t('a quiet day reads calm, with nothing to explain', () => {
  const r = ctx.pzTilt({ now: NOW, closed: [{ net: 40, closeTime: NOW - 90 * M }], opened: [{ openTime: NOW - 120 * M }] });
  eq([r.score, r.band, r.reasons.length], [0, 'calm', 0]);
});
t('losses in a row, a fresh loss and size-ups add up past the hot line', () => {
  const closed = [{ net: -50, closeTime: NOW - 40 * M }, { net: -60, closeTime: NOW - 20 * M }, { net: -30, closeTime: NOW - 5 * M }];
  const r = ctx.pzTilt({ now: NOW, closed, opened: [1, 2, 3].map(i => ({ openTime: NOW - i * 10 * M })), sizeX: 1.6, used: 0.8, ready: 70 });
  eq(r.run, 3); ok(r.score >= 65 && r.band === 'hot', 'score ' + r.score);
  eq(r.reasons[0].k, 'streak', 'the biggest push comes first');
  eq(r.key, NOW - 5 * M, 'the episode is keyed to its latest event');
});
t('a win breaks the run; the re-entry window fades after 30 minutes', () => {
  const r = ctx.pzTilt({ now: NOW, closed: [{ net: -50, closeTime: NOW - 50 * M }, { net: 30, closeTime: NOW - 45 * M }] });
  eq([r.run, r.score], [0, 0]);
  eq(ctx.pzTilt({ now: NOW, closed: [{ net: -50, closeTime: NOW - 20 * M }] }).reasons.find(x => x.k === 'revenge').pts, 10);
});
t('low readiness and a spent risk budget count even before a loss', () => {
  const r = ctx.pzTilt({ now: NOW, closed: [], opened: [], used: 1.1, ready: 30 });
  eq(r.score, 20); eq(r.band, 'calm');
});

console.log('\nMarket regimes');
const D = 86400000, T0 = Date.UTC(2026, 0, 1);
const flat = (n, rng = 0.02, step = 0) => Array.from({ length: n }, (_, i) => { const c = 100 + step * i; return [T0 + i * D, c * (1 + rng / 2), c * (1 - rng / 2), c]; });
t('a day with twice the usual range is volatile; half the range is quiet', () => {
  const c = flat(40); c[35] = [c[35][0], 103, 97, 100]; c[36] = [c[36][0], 100.4, 99.6, 100];
  const r = ctx.pzRegimes(c);
  eq(r['2026-02-05'].vol, 'high'); eq(r['2026-02-06'].vol, 'low'); eq(r['2026-01-31'].vol, 'normal');
  eq(r['2026-01-05'].vol, null, 'needs ten days of history first');
});
t('a steady climb is a trend; back-and-forth is chop', () => {
  eq(ctx.pzRegimes(flat(20, 0.02, 1))['2026-01-15'].trend, 'up');
  const zig = flat(20).map((x, i) => [x[0], x[1], x[2], i % 2 ? 101 : 99]);
  eq(ctx.pzRegimes(zig)['2026-01-15'].trend, 'chop');
});
t('the insight names the losing regime only when one loses and another pays, five trades each', () => {
  const rows = [{ k: 'high', n: 6, avg: -40 }, { k: 'normal', n: 12, avg: 25 }, { k: 'low', n: 2, avg: -90 }];
  ok(/lose on volatile days.*normal days/.test(ctx.pzRegimeInsight(rows, vm.runInContext('PZ_VOL', ctx)).text));
  eq(ctx.pzRegimeInsight([{ k: 'high', n: 6, avg: 10 }, { k: 'normal', n: 12, avg: 25 }], vm.runInContext('PZ_VOL', ctx)), null);
});

console.log('\nLessons');
const J = {
  'day:2026-09-20': { eod: { at: T0 + 300 * D, lesson: 'No re-entry within 15 minutes of a loss', answers: { 'The one mistake not to repeat tomorrow': 'Doubled size after a red trade' } } },
  'day:2026-09-25': { eod: { at: T0 + 305 * D, lesson: 'Wait for the retest' } },
  'day:2026-09-26': { eod: { at: T0 + 306 * D, lesson: '' } }, 'tradeid': { notes: 'x' },
};
t('reviews become lessons — the lesson line and the mistake answer — tagged by what they’re about', () => {
  const L = ctx.pzLessonList(J, {}, k => k === '2026-09-25' ? { overtrade: 2 } : null);
  eq(L.map(l => l.kind), ['lesson', 'lesson', 'mistake']);
  eq(L.map(l => l.tag), ['overtrade', 'revenge', 'sizeUp'], 'a line with no keyword takes its day’s main slip');
  eq(L[0].due, T0 + 306 * D, 'first back a day after it was written');
});
t('the schedule: due ones come oldest-first; kept and removed ones stay out', () => {
  const st = { items: { 'd:2026-09-20:l': { step: 2, due: T0 + 400 * D }, 'd:2026-09-20:m': { off: true } } };
  const L = ctx.pzLessonList(J, st);
  eq(L.length, 2); eq(ctx.pzLessonDue(L, T0 + 310 * D).id, 'd:2026-09-25:l');
  eq(ctx.pzLessonDue(L, T0 + 300 * D), null);
  eq(ctx.pzLessonDue(L.filter(l => l.id !== 'd:2026-09-25:l'), T0 + 401 * D).id, 'd:2026-09-20:l', 'back once its next step comes round');
});
t('a hot tilt brings back the lesson written about that slip', () => {
  const L = ctx.pzLessonList(J, {});
  eq(ctx.pzLessonFor({ reasons: [{ k: 'revenge' }] }, null, L).text, 'No re-entry within 15 minutes of a loss');
  eq(ctx.pzLessonFor({ reasons: [{ k: 'size' }] }, null, L).kind, 'mistake');
  eq(ctx.pzLessonFor({ reasons: [{ k: 'ready' }] }, null, L), null);
});

console.log('\nProcess goals');
const day = (key, score, flags = {}, parts = {}) => ({ key, score, behavior: { flags }, parts });
const X = (days, extra) => Object.assign({ days, J: {}, closed: [], today: '2026-10-20', dayOf: ms => new Date(ms).toISOString().slice(0, 10), journaled: j => !!(j && j.notes), label: k => k }, extra || {});
t('a month’s Discipline average: behind, on track, then reached or missed when the month ends', () => {
  const g = { kind: 'disc', target: 80, month: '2026-10', start: '2026-10-01' };
  const ds = ['01', '02', '05', '06', '07'].map((d, i) => day('2026-10-' + d, i < 1 ? 60 : 90));
  eq(ctx.pzGoalEval(g, X(ds.slice(0, 2))).status, 'behind');
  eq(ctx.pzGoalEval(g, X(ds)).status, 'on');
  eq(ctx.pzGoalEval(g, X(ds, { today: '2026-11-02' })).status, 'done');
  eq(ctx.pzGoalEval(g, X(ds.slice(0, 3), { today: '2026-11-02' })).status, 'missed', 'needs five trading days');
});
t('weeks without a slip: the clock restarts after one and finishes at the target', () => {
  const g = { kind: 'noslip', slip: 'revenge', target: 2, start: '2026-10-01' };
  const six = ['02', '03', '06', '07', '08', '09'].map(d => day('2026-10-' + d, 90));
  eq(ctx.pzGoalEval(g, X(six, { today: '2026-10-15' })).status, 'done', 'two weeks and six trading days');
  eq(ctx.pzGoalEval(g, X([day('2026-10-03', 90)], { today: '2026-10-15' })).status, 'on', 'not trading doesn’t finish it');
  const r = ctx.pzGoalEval(g, X([day('2026-10-03', 90), day('2026-10-13', 50, { revenge: 1 })], { today: '2026-10-15' }));
  eq([r.status, r.now], ['behind', '2 of 14 days · 0 of 6 trading days · restarted 2026-10-13']);
  eq(ctx.pzGoalEval(g, X([day('2026-10-03', 90), day('2026-10-10', 50, { revenge: 1 })], { today: '2026-10-15' })).status, 'on', 'back on track three days after a restart');
});
t('the loss-limit goal: a breached day restarts it, and days without a limit don’t count', () => {
  const g = { kind: 'limit', target: 2, start: '2026-10-01' }, lim = (k, breached) => Object.assign(day(k, 80, {}, { limit: 1 }), { breached });
  eq(ctx.pzGoalEval(g, X([day('2026-10-02', 80)], { today: '2026-10-20' })).note, 'Counts the days you trade with a loss limit set in your check-in.');
  const r = ctx.pzGoalEval(g, X([lim('2026-10-02', false), lim('2026-10-05', true)], { today: '2026-10-06' }));
  eq(r.status, 'behind', 'one trade past the limit is a break, even with nothing opened after it');
});
t('check-ins and journaling count the month; a check-in goal is missed once it can’t be reached', () => {
  const J = { 'day:2026-10-01': { sleep: 4 }, 'day:2026-10-02': { focus: 3 }, 'day:2026-09-30': { sleep: 5 }, 'abc': { notes: 'x' } };
  eq(ctx.pzGoalEval({ kind: 'checkin', target: 10, month: '2026-10' }, X([], { J })).now, '2 of 10 check-ins');
  eq(ctx.pzGoalEval({ kind: 'checkin', target: 20, month: '2026-10' }, X([], { J, today: '2026-10-25' })).status, 'missed');
  const closed = [{ id: 'abc', closeTime: Date.UTC(2026, 9, 3) }, { id: 'def', closeTime: Date.UTC(2026, 9, 4) }];
  eq(ctx.pzGoalEval({ kind: 'journal', target: 80, month: '2026-10' }, X([], { J, closed })).now, '50% · 1 of 2 trades');
});

console.log('\nCosts and charts');
t('mostly taker volume, fees eating the price result, funding paid: one line of advice each', () => {
  const tr = [{ pnl: 400, fees: 120, funding: -60, takerNotional: 200000, takerFee: 90, makerNotional: 20000, makerFee: 3 }];
  const c = ctx.pzCostStats(tr);
  eq([Math.round(c.makerShare * 100), Math.round(c.drag * 100), c.paid], [9, 30, 60]);
  eq(c.advice.length, 3); ok(/91% of your volume paid taker fees.*\$30\.00/.test(c.advice[0]), c.advice[0]);
  eq(ctx.pzCostStats([{ pnl: 400, fees: 20, funding: 5, makerNotional: 90000, makerFee: 13, takerNotional: 10000, takerFee: 4.5 }]).advice, ['Costs are in hand, and funding paid you $5.00.']);
});
t('the trade chart draws candles, entry and exit, and the written stop and target', () => {
  const T1 = Date.UTC(2026, 9, 1, 10), c = Array.from({ length: 30 }, (_, i) => [T1 + i * 3e5, 101 + i * 0.1, 99 + i * 0.1, 100 + i * 0.1, 100 + i * 0.1 - 0.05]);
  const svg = ctx.pzSnapSvg({ coin: 'SOL', avgEntry: 100.5, avgExit: 102, openTime: T1 + 3e6, closeTime: T1 + 6e6, net: 30 }, c, 3e5, { stop: 99, target: 103 });
  ok(svg.startsWith('<svg') && (svg.match(/<rect/g) || []).length === 30);
  for (const lab of ['in 100.5', 'out 102', 'stop', 'target']) ok(svg.includes('>' + lab + '<'), lab);
  eq(ctx.pzSnapSvg({}, [c[0]], 3e5, null), '', 'no chart from one candle');
});

console.log('\nReview fixes');
t('a sync conflict merges goals and lessons by id instead of one device’s copy replacing the other', () => {
  const g = ctx._syncMerge('pzGoals', [{ id: 'a', kind: 'disc', at: 5, createdAt: 1 }, { id: 'c', kind: 'checkin', createdAt: 3 }], [{ id: 'a', kind: 'disc', at: 2, dropped: 9, createdAt: 1 }, { id: 'b', kind: 'journal', createdAt: 2 }]);
  eq(g.map(x => x.id), ['a', 'b', 'c']); eq(g[0].dropped, 9, 'a removal sticks');
  const l = ctx._syncMerge('pzLessons', { items: { x: { step: 2, at: 10 } }, own: [{ id: 'u1', text: 'mine' }] }, { items: { x: { step: 1, at: 5 }, y: { off: true, at: 1 } }, own: [{ id: 'u2', text: 'theirs' }] });
  eq([l.items.x.step, l.items.y.off, l.own.map(o => o.id)], [2, true, ['u2', 'u1']]);
  eq(ctx._syncMerge('tz', 'utc', 'local'), 'utc', 'other fields: this device’s edit, as before');
});
t('lessons from before resurfacing started come back one a day, not all at once', () => {
  const since = T0 + 310 * D, L = ctx.pzLessonList(J, { since });
  eq(L.filter(l => ctx.pzLessonDue(L.filter(x => x === l), since + 0.5 * D)).length, 1);
  eq(L.map(l => (l.due - since) / D).sort(), [0, 1, 2]);
});
t('today’s half-formed candle is scaled to the part of the day that has passed', () => {
  const c = flat(40); const day = c[39][0];
  c[39] = [day, 100.5, 99.5, 100]; // half the usual range…
  eq(ctx.pzRegimes(c)['2026-02-09'].vol, 'low');
  eq(ctx.pzRegimes(c, day + 0.1 * D)['2026-02-09'].vol, 'high', '…in the first tenth of the day is a fast one');
  eq(ctx.pzRegimes(c, day + 0.3 * D)['2026-02-09'].vol, 'normal');
});
t('fees per $10k count fills with no maker/taker flag; the maker share only those that have one', () => {
  const c = ctx.pzCostStats([{ pnl: 100, fees: 10, makerNotional: 5000, takerNotional: 5000, unkNotional: 10000 }]);
  eq([c.feeBps, c.makerShare], [5, 0.5]);
});

report('v05');
