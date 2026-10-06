// Trader Age (app/features/trader-age.js): the daily rating, the 6-month weighted norm, years from a
// rating, pace against this week, breaks that freeze it, and how the feature plugs into Keel.
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { t, ok, eq, near, report, makeExtractor } from './harness.mjs';

const require = createRequire(import.meta.url);
const htmlPath = new URL('../ledger.html', import.meta.url).pathname;
const { readAppSource } = require('../app-source.js');
const src = readAppSource(htmlPath);
const { grabFn, evalModule } = makeExtractor(src);
const consts = ['taRatingFor', 'TA_SLIPS'].map(n => src.match(new RegExp('^const ' + n + '=.*$', 'm'))[0]).join('\n');
const { traderAge, taYears, taRatingFor, taFmtYears, taFmtDelta, taWeeks, taMultStep, taMultOf, taMultDefaults, taStanding, taStandingDefaults, taHistory, taWhatIf, taHabits, taThenNow, pzBehaviorDays } = await evalModule(
  ['taConf', 'taYears', 'taDayN', 'taPrep', 'taCheckin', 'traderAge', 'isoWeekOfKey', 'taFmtYears', 'taFmtDelta', 'taMultDefaults', 'taWeeks', 'taMultTier', 'taMultStep', 'taMultOf', 'taStandingDefaults', 'taStanding', 'taHistory',
    'taDayWithoutSlip', 'taDayWithoutKept', 'taWhatIf', 'taHabitList', 'taHabitDay', 'taHabitAlt', 'taHabits', 'taThenNow', 'nfMedian', 'hasAdd', 'addedToLoser', 'pzBehaviorDays'],
  ['traderAge', 'taYears', 'taRatingFor', 'taFmtYears', 'taFmtDelta', 'taWeeks', 'taMultStep', 'taMultOf', 'taMultDefaults', 'taStanding', 'taStandingDefaults', 'taHistory', 'taWhatIf', 'taHabits', 'taThenNow', 'pzBehaviorDays'],
  'const TA=taConf();\nconst TA_HABITS=taHabitList();\n' + consts);

const DAY = 864e5, NOW = Date.parse('2026-10-20T12:00:00Z');
const key = ms => new Date(ms).toISOString().slice(0, 10);
// n trading days ending `endBack` days before NOW, one every `every` days
const run = (n, f, o = {}) => Array.from({ length: n }, (_, i) => { const at = NOW - ((o.endBack || 0) + (n - 1 - i) * (o.every || 1)) * DAY;
  return Object.assign({ key: key(at), score: 80, parts: {}, behavior: { flags: {} } }, f(i, at)); });
const age = (days, J, o) => traderAge(days, J || {}, Object.assign({ now: NOW }, o));

t('years from a rating: every 10 points doubles it, capped at 20', () => {
  eq([taYears(50), taYears(60), taYears(70), taYears(80), taYears(40)], [1, 2, 4, 8, 0.5]);
  eq(taYears(100), 20); near(taRatingFor(2), 60, 1e-9);
  eq([taFmtYears(0.5), taFmtYears(1 / 12), taFmtYears(5.71), taFmtYears(12.4)], ['6 months', '1 month', '5.7 years', '12 years']);
});
t('fewer than 15 trading days: still building, with how many to go', () => {
  const A = age(run(9, () => ({})));
  eq([A.building, A.need, A.n], [true, 6, 9]); ok(A.rating > 0, 'the number exists, it just isn’t shown yet');
});
t('the daily mix: 65% Discipline, 15% steadiness, 10% loss limit, 10% prep and journal', () => {
  // flat 50s, no limit set (70), nothing logged: 0.65·50 + 0.15·100 + 0.10·70 + 0 = 54.5
  const A = age(run(20, () => ({ score: 50 })));
  near(A.raw, 54.5, 1e-9); eq(A.drag, 'discipline');
  // perfect days: limit kept, a plan before the first trade, every trade journaled → 100, Trader Age at its cap
  const J = {}; const days = run(20, (i, at) => { J['day:' + key(at)] = { sleep: 4 }; return { score: 100, parts: { limit: 1, journal: 1, plan: 1 } }; });
  const B = age(days, J); near(B.raw, 100, 1e-9);
  // prep: the plan is the thing (half for a late one); a check-in alone counts half, and never adds to a plan
  const log = (parts, e) => age(run(20, (i, at) => { if (e) J['day:' + key(at)] = e; return { score: 100, parts }; }), e ? J : {}).parts.log;
  eq([log({ plan: 1 }), log({ plan: 0.5 }), log({}, { sleep: 4 }), log({ plan: 1 }, { sleep: 4 }), log({ plan: 0.5 }, { focus: 2 }), log({ journal: 1 })], [50, 25, 25, 50, 25, 50]);
  // a day traded past the limit scores 0 on that part
  near(age(run(20, () => ({ score: 50, parts: { limit: 0 } }))).raw, 47.5, 1e-9);
});
t('confidence: under 60 trading days the rating is held toward 50 (1 year), so 15 perfect days aren’t 20 years', () => {
  const perfect = n => { const J = {}; return age(run(n, (i, at) => { J['day:' + key(at)] = { sleep: 4 }; return { score: 100, parts: { limit: 1, journal: 1, plan: 1 } }; }), J); };
  const a15 = perfect(15), a30 = perfect(30), a60 = perfect(60);
  near(a15.raw, 100, 1e-9); ok(a15.age < 8 && a15.age > 6, 'about 7 years at 15 days: ' + a15.age);
  ok(a30.age > a15.age && a30.age < 20, '30 days: ' + a30.age); eq([a60.age, a60.sure], [20, 1], 'fully trusted from 60');
  // a weak record is held up toward 1 year the same way
  ok(age(run(15, () => ({ score: 10 }))).age > age(run(60, () => ({ score: 10 }))).age);
  // the likely range: around the number, wider when the days swing
  const even = age(run(40, () => ({ score: 70 }))), swing = age(run(40, i => ({ score: i % 2 ? 100 : 40 })));
  ok(even.range[0] <= even.age && even.range[1] >= even.age);
  ok(swing.range[1] / swing.range[0] > even.range[1] / even.range[0], 'wider when it swings');
});
t('steadiness: the same average Discipline scores lower when it swings', () => {
  const even = age(run(30, () => ({ score: 70 }))), swing = age(run(30, i => ({ score: i % 2 ? 100 : 40 })));
  ok(swing.parts.steadiness < 50, JSON.stringify(swing.parts)); near(even.parts.steadiness, 100, 1e-9);
  ok(swing.rating < even.rating);
  // a day's score is pulled toward the 20-day average by how few trades it has: one-trade days (0 or 100 by
  // construction) read as fairly steady, the same swing over 20-trade days as unsteady
  const one = age(run(30, i => ({ score: i % 2 ? 100 : 0, n: 1 }))), twenty = age(run(30, i => ({ score: i % 2 ? 100 : 0, n: 20 })));
  near(one.parts.steadiness, 75, 1); ok(twenty.parts.steadiness < 20, '' + twenty.parts.steadiness);
  eq(age(run(30, i => ({ score: i % 2 ? 100 : 0, behavior: { n: 1 } }))).parts.steadiness, one.parts.steadiness, 'the count can ride on the behavior');
});
t('recent days count more: a 30-trading-day half-life', () => {
  const days = [...run(60, () => ({ score: 40 }), { endBack: 30 }), ...run(30, () => ({ score: 90 }))];
  const A = age(days), plain = (60 * 40 + 30 * 90) / 90;
  ok(A.parts.discipline > plain + 5, `weighted ${A.parts.discipline.toFixed(1)} vs plain ${plain.toFixed(1)}`);
});
t('only the last 6 months count, and a break freezes it', () => {
  const old = run(40, () => ({ score: 20 }), { endBack: 200 }), recent = run(20, () => ({ score: 80 }));
  near(age([...old, ...recent]).rating, age(recent).rating, 1e-9, 'days older than 6 months are out');
  // a month with no trading: nothing new comes in, nothing decays (the days are still inside the window)
  const days = run(30, i => ({ score: 60 + (i % 3) * 10 }), { endBack: 40 });
  near(age(days).rating, age(days, {}, { now: NOW - 30 * DAY }).rating, 1e-9);
});
t('pace: this week against the norm, between 0× and 3×, once there are 3 trading days in it', () => {
  const norm = run(40, () => ({ score: 60 }), { endBack: 8 });
  eq(age([...norm, ...run(2, () => ({ score: 100 }))]).pace, undefined, 'two days aren’t a week');
  const good = age([...norm, ...run(4, () => ({ score: 95 }))]); ok(good.pace > 1.5 && good.pace <= 3, String(good.pace));
  const bad = age([...norm, ...run(4, () => ({ score: 10, behavior: { flags: { revenge: 3, sizeUp: 1 } } }))]);
  ok(bad.pace < 0.5, String(bad.pace)); eq(bad.week.slip, 'revenge', 'and which slip cost the most');
});
t('trading age from the first fill, and a week-by-week history (last 12 weeks with trading)', () => {
  const A = age(run(120, () => ({})), {}, { firstAt: NOW - 2 * 365.25 * DAY });
  near(A.tradingYears, 2, 1e-9); eq(A.weeks.length, 12); ok(A.weeks.every(w => w.age > 0 && w.n > 0));
});
// the multiplier: weeks of the form {week, weekRating, norm}
const W = (i, wr, norm = 80) => ({ week: '2026-W' + String(i).padStart(2, '0'), weekRating: wr, norm });
const walk = (weeks, cfg) => weeks.reduce((st, w) => taMultStep(st, w, cfg), null);
t('the multiplier climbs with good weeks: ×1.05 at 2, ×1.1 at 4, ×1.2 at 8, ×1.3 at 13, ×1.5 at 26', () => {
  const at = n => taMultOf(walk(Array.from({ length: n }, (_, i) => W(i + 1, 80))));
  eq([at(1), at(2), at(3), at(4), at(8), at(12), at(13), at(25), at(26), at(40)], [1, 1.05, 1.05, 1.1, 1.2, 1.2, 1.3, 1.3, 1.5, 1.5]);
});
t('a week under the bar drops one tier, never back to the start; a week with a low norm neither counts nor drops', () => {
  const good = Array.from({ length: 10 }, (_, i) => W(i + 1, 80)); // 10 good weeks: ×1.2
  const st = walk([...good, W(11, 60)]); eq([st.count, taMultOf(st)], [4, 1.1], 'down to the 4-week tier');
  eq(taMultOf(walk([...good, W(11, 60), W(12, 60)])), 1.05, 'a second bad week: one more tier');
  eq(walk([W(1, 60)]).count, 0, 'nothing to lose yet');
  const neutral = walk([...good, W(11, 85, 65)]); eq(neutral.count, 10, 'the week was fine but the 6-month norm under the bar: no climb, no drop');
  eq(walk([...good, W(11, 85, null)]).count, 10, 'not enough days for a norm yet: no climb');
});
t('each week counts once, and the owner’s tiers can change without stranding anyone', () => {
  const st = walk(Array.from({ length: 5 }, (_, i) => W(i + 1, 80)));
  eq(taMultStep(st, W(3, 20)).count, 5, 'a week already counted is skipped');
  eq(taMultOf(st, { on: true, bar: 70, tiers: [[1, 1.2], [5, 2]] }), 2, 'the same 5 weeks read against new tiers');
  eq(taMultOf(st, Object.assign(taMultDefaults(), { on: false })), 1, 'off: no multiplier');
});
t('weeks from days: each trading week’s own rating, and the 6-month norm once there are 15 days', () => {
  const days = run(25, () => ({ score: 90 }));
  const ws = taWeeks(days, {}, {});
  ok(ws.length >= 4); ok(ws.every(w => w.weekRating > 70));
  eq(ws[0].norm, null, 'the first week has too few days for a norm'); ok(ws[ws.length - 1].norm > 70);
  eq(taWeeks(days, {}, { after: ws[1].week }).length, ws.length - 2, 'it can start after the last week already counted');
});
t('standing reads the last 20 trading days: a plain average of their ratings', () => {
  // 40 days at 50 then 20 at 90: the 6-month rating mixes them, the 20-day one is the 90s alone
  const A = age([...run(40, () => ({ score: 50 }), { endBack: 20 }), ...run(20, () => ({ score: 90 }))]);
  eq(A.recentN, 20); const daily = traderAge([...run(20, () => ({ score: 90 }))], {}, { now: NOW, raw: true }).daily;
  ok(A.recent > A.rating, 'recent above the 6-month norm'); near(A.recent, daily.reduce((a, x) => a + x.r, 0) / 20, 6, 'about the 90s’ own rating');
  eq(age(run(5, () => ({}))).recentN, 5, 'fewer days: all of them');
});
// standing: x = {verified, building, recent, lastDay}
const D14 = 14 * DAY, kd = ms => key(ms);
const stand = (prev, x, now = NOW, cfg) => taStanding(prev, x, cfg || taStandingDefaults(), now, kd);
t('standing: at the bar (60 = 2 years) is good, fewer than 15 days is building, both clear the clock', () => {
  eq(taStandingDefaults(), { on: true, bar: 60, grace: 14 });
  eq(stand(null, { verified: true, recent: 60 }).state, 'good');
  eq(stand({ state: 'slipping', since: NOW - DAY }, { verified: true, recent: 75 }), { state: 'good', since: null });
  eq(stand({ state: 'slipping', since: NOW - DAY }, { verified: true, building: true, recent: 20 }), { state: 'building', since: null });
  eq(stand(null, { verified: true, recent: 20 }, NOW, { on: false, bar: 60, grace: 14 }).state, 'off');
});
t('under the bar: 14 days of grace, then a lapse only once a day has been traded since it began', () => {
  const s0 = stand(null, { verified: true, recent: 55, lastDay: kd(NOW) });
  eq([s0.state, s0.since, s0.deadline], ['slipping', NOW, NOW + D14]);
  eq(stand(s0, { verified: true, recent: 55, lastDay: kd(NOW + 13 * DAY) }, NOW + 13 * DAY).state, 'slipping', 'still in grace');
  // past the deadline without trading since: the clock waits
  eq(stand(s0, { verified: true, recent: 55, lastDay: kd(NOW) }, NOW + 30 * DAY).state, 'slipping', 'a break freezes it');
  const L = stand(s0, { verified: true, recent: 55, lastDay: kd(NOW + 20 * DAY) }, NOW + 20 * DAY);
  eq([L.state, L.why, L.since], ['lapsed', 'rating', NOW]);
  eq(stand(L, { verified: true, recent: 61, lastDay: kd(NOW + 21 * DAY) }, NOW + 21 * DAY).state, 'good', 'back at the bar: open again');
});
t('unverified: the same 14 days, with no trading needed to lapse, and switching doesn’t restart the clock', () => {
  const u = stand(null, { verified: false }); eq([u.state, u.deadline], ['unverified', NOW + D14]);
  eq(stand(u, { verified: false }, NOW + D14).state, 'lapsed'); eq(stand(u, { verified: false }, NOW + D14).why, 'unverified');
  // slipping → turns verification off → back on: the clock started at the first slip
  const s = stand(null, { verified: true, recent: 50, lastDay: kd(NOW) }), off = stand(s, { verified: false }, NOW + 5 * DAY);
  eq(off.since, NOW); eq(stand(off, { verified: true, recent: 50, lastDay: kd(NOW + 15 * DAY) }, NOW + 15 * DAY).state, 'lapsed');
});
t('a slip isn’t cleared by building again (a fresh wallet): only a rating back at the bar clears it', () => {
  const s = stand(null, { verified: true, recent: 50, lastDay: kd(NOW) }); eq(s.slip, true);
  const fresh = stand(s, { verified: true, building: true, lastDay: kd(NOW + 16 * DAY) }, NOW + 16 * DAY);
  eq([fresh.state, fresh.why, fresh.since], ['lapsed', 'rating', NOW]);
  eq(stand(fresh, { verified: true, recent: 65, lastDay: kd(NOW + 40 * DAY) }, NOW + 40 * DAY), { state: 'good', since: null });
  // someone who was only ever unverified and then verifies a new wallet is building, and good
  eq(stand(stand(null, { verified: false }), { verified: true, building: true }, NOW + 20 * DAY).state, 'building');
});
t('the history: Trader Age at the end of each trading day, each reading only the days up to it', () => {
  const days = [...run(30, () => ({ score: 90 }), { endBack: 30 }), ...run(30, () => ({ score: 40 }))];
  const H = taHistory(days, {}, {});
  eq(H.length, 60); eq(H.slice(0, 14).every(h => h.age == null), true, 'building for the first 14');
  near(H[29].age, traderAge(days.slice(0, 30), {}, { now: Date.parse(days[29].key + 'T23:59:59Z') }).age, 1e-9, 'day 30 sees only its 30 days');
  ok(H[59].age < H[29].age, 'a bad month brings it down');
});
// days as the game builds them: behavior with flags, clean count and each slipped trade's flags
const slipDay = (at, slips) => { const n = 4, clean = n - slips.length, flags = {}; for (const f of slips) for (const k of f) flags[k] = (flags[k] || 0) + 1;
  return { key: key(at), n, score: Math.round(100 * clean / n), parts: {}, behavior: { n, clean, flags, slips: slips.map((f, i) => ({ id: i, net: -10, f })) } }; };
t('what each slip costs: Trader Age again with those trades clean, biggest gain first', () => {
  const days = Array.from({ length: 30 }, (_, i) => slipDay(NOW - (29 - i) * DAY, i % 2 ? [['revenge'], ['revenge']] : [['sizeUp']]));
  const W = taWhatIf(days, {}, { now: NOW });
  eq(W.map(x => x.k), ['revenge', 'sizeUp']); eq(W[0].n, 30); ok(W[0].gain > W[1].gain && W[1].gain > 0);
  near(W[0].age - traderAge(days, {}, { now: NOW }).age, W[0].gain, 1e-9);
  // a trade with two slips isn't made clean by taking one away
  const both = Array.from({ length: 20 }, (_, i) => slipDay(NOW - (19 - i) * DAY, [['revenge', 'sizeUp']]));
  eq(taWhatIf(both, {}, { now: NOW }), [], 'nothing gained by removing either alone');
  eq(taWhatIf(run(5, () => ({})), {}, { now: NOW }), [], 'still building: nothing to say');
});
// the scorer counts the chances a habit had, not only the slips. The day before: a loss and a 30-minute
// winner (the usual size and hold). The day: a loss, an entry 30 minutes later (waited), a loss, then an
// entry 5 minutes later (revenge); both losses were cut as fast as the winner, every entry kept its size
const T = (id, open, close, net, o = {}) => Object.assign({ id, openTime: open, closeTime: close, net, maxSize: 1, avgEntry: 100 }, o);
t('the scorer: every habit is a chance kept or slipped; a slip of one kind keeps the others', () => {
  const d0 = NOW - 6 * DAY, m = 60000, p0 = d0 - DAY;
  const days = pzBehaviorDays([T('p', p0, p0 + 30 * m, -10), T('q', p0 + 60 * m, p0 + 90 * m, 5),
    T('a', d0, d0 + 30 * m, -10), T('b', d0 + 60 * m, d0 + 90 * m, 5), T('c', d0 + 120 * m, d0 + 150 * m, -10), T('d', d0 + 155 * m, d0 + 180 * m, 2)], { dayOf: key, isLoss: n => n < -1 });
  eq(days.length, 2); const d = days[1];
  eq([d.n, d.clean, d.score, d.flags.revenge], [4, 3, 75, 1]);
  // sizing up is tested on every entry within 2 hours of ANY loss, not only when the last close lost
  // (AUDIT-4 E4): c opens 90 minutes after a's loss with b's win in between, so it's a third chance
  eq(d.chances, { revenge: 2, afterTwo: 0, sizeUp: 3, addLoser: 0, overtrade: 0, heldLoser: 2 }, 'two entries after a loss, three within 2 hours of one, two losers to cut');
  eq(d.kept, { revenge: 1, afterTwo: 0, sizeUp: 3, addLoser: 0, overtrade: 0, heldLoser: 2 });
  eq(d.keptClean, { revenge: 1, afterTwo: 0, sizeUp: 2, addLoser: 0, overtrade: 0, heldLoser: 2 }, 'the revenge entry kept its size, but it isn’t a clean trade');
  eq(days[0].chances, { revenge: 1, afterTwo: 0, sizeUp: 0, addLoser: 0, overtrade: 0, heldLoser: 0 }, 'the first day has no usual size or hold to test against; its winner did wait');
  // two losses in a row closed in the day: a chance to stop, kept when nothing was opened after them
  const two = pzBehaviorDays([T('a', d0, d0 + 30 * m, -10), T('b', d0 + 60 * m, d0 + 90 * m, -10)], { dayOf: key, isLoss: n => n < -1 })[0];
  eq([two.chances.afterTwo, two.kept.afterTwo, two.flags.afterTwo], [1, 1, 0]);
  const three = pzBehaviorDays([T('a', d0, d0 + 30 * m, -10), T('b', d0 + 60 * m, d0 + 90 * m, -10), T('c', d0 + 120 * m, d0 + 150 * m, 1)], { dayOf: key, isLoss: n => n < -1 })[0];
  eq([three.chances.afterTwo, three.kept.afterTwo, three.flags.afterTwo], [1, 0, 1]);
});
// a day with 4 trades: two entries after a loss, one of them a revenge entry (the other kept, clean)
const habitDay = (at, o = {}) => Object.assign({ key: key(at), n: 4, score: 75, parts: {}, behavior: { n: 4, clean: 3, flags: { revenge: 1 }, chances: { revenge: 2 }, kept: { revenge: 1 }, keptClean: { revenge: 1 }, slips: [{ id: 1, net: -5, f: ['revenge'] }] } }, o);
t('each habit: kept over 6 months and the last 30 trading days, what the kept ones earn and the slips cost', () => {
  const J = {}; const days = Array.from({ length: 40 }, (_, i) => { const at = NOW - (39 - i) * DAY; J['day:' + key(at)] = { sleep: 3 }; return habitDay(at, { parts: { limit: 1, plan: 1, journal: 0.5 } }); });
  const H = taHabits(days, J, { now: NOW }), by = Object.fromEntries(H.map(h => [h.k, h])), A = traderAge(days, J, { now: NOW });
  eq(H.map(h => h.k), ['revenge', 'steadiness', 'limit', 'plan', 'checkin', 'journal'], 'only habits the days say something about');
  eq([by.revenge.chances, by.revenge.kept, by.revenge.share, by.revenge.share30], [80, 40, 0.5, 0.5]);
  ok(by.revenge.earn > 0 && by.revenge.cost > 0, 'the kept entries earn, the revenge ones cost: ' + JSON.stringify(by.revenge));
  near(by.revenge.cost, traderAge(days.map(d => Object.assign({}, d, { score: 100, behavior: Object.assign({}, d.behavior, { flags: {} }) })), J, { now: NOW }).age - A.age, 0.01, 'cost = Trader Age with those trades clean');
  near(by.revenge.earn, A.age - traderAge(days.map(d => Object.assign({}, d, { score: 50 })), J, { now: NOW }).age, 0.01, 'earn = Trader Age with the kept ones slipped too');
  eq([by.limit.kept, by.limit.chances, by.limit.cost], [40, 40, 0]); ok(by.limit.earn > 0, 'a limit kept every day: earns, costs nothing');
  eq([by.plan.share, by.plan.cost], [1, 0]); ok(by.plan.earn > 0);
  eq([by.checkin.share, by.checkin.earn, by.checkin.cost], [1, 0, 0], 'a check-in next to a plan adds nothing, so it earns nothing');
  eq([by.journal.chances, by.journal.kept, by.journal.share], [160, 80, 0.5]); ok(by.journal.earn > 0 && by.journal.cost > 0);
  eq([by.steadiness.value, by.steadiness.cost], [100, 0]);
  eq(taHabits(days.slice(-5), J, { now: NOW }), [], 'still building: nothing to say');
  // the last 30 trading days can differ from the 6 months: recent days all kept
  const better = days.map((d, i) => i < 10 ? d : habitDay(Date.parse(d.key + 'T12:00:00Z'), { score: 100, parts: d.parts, behavior: Object.assign({}, d.behavior, { clean: 4, flags: {}, kept: { revenge: 2 }, keptClean: { revenge: 2 }, slips: [] }) }));
  const r = taHabits(better, J, { now: NOW }).find(h => h.k === 'revenge'); eq(r.share30, 1); ok(r.share < 1 && r.cost > 0, 'the older slips still cost');
  eq(taFmtDelta(0.4), '5 mo'); eq(taFmtDelta(1.5), '1.5 yrs');
});
t('then and now: the last 30 trading days against the 30 before and the 30 before that', () => {
  const days = Array.from({ length: 70 }, (_, i) => habitDay(NOW - (69 - i) * DAY, i < 40 ? {} : { score: 100, parts: { limit: 1 }, behavior: { n: 4, clean: 4, flags: {}, chances: { revenge: 2 }, kept: { revenge: 2 }, keptClean: { revenge: 2 }, slips: [] } }));
  const B = taThenNow(days, {}, { now: NOW });
  eq(B.map(b => b.days), [10, 30, 30], 'oldest first, a short first block');
  eq([B[0].disc, B[1].disc, B[2].disc], [75, 75, 100]); eq([B[0].slips.revenge, B[2].slips.revenge], [25, 0], 'per 100 trades');
  eq([B[1].limit, B[2].limit], [null, 100]); ok(B[2].age > B[1].age);
  eq(taThenNow(days.slice(-35), {}, { now: NOW }).length, 1, 'under 40 trading days: one block only');
});
t('milestone badges: a Seasoned family reads the history (1, 2, 4, 6, 8, 12 years), on both screens', () => {
  ok(src.includes("['traderage','milestones','Seasoned',t=>'a Trader Age of '+t+' year'+(t===1?'':'s'),[1,2,4,6,8,12],2]"));
  ok(grabFn('pzBadgeCatalog').includes("run('traderage',taHistoryOf(D)"));
});
t('a feature plugs into Keel through pzFeature: a Today card people can hide and move, and a screen of its own', () => {
  ok(grabFn('pzFeature').includes('PZ_SECTIONS.today.push') && grabFn('pzFeature').includes('PZ_TABS.push'));
  ok(src.includes("pzFeature({id:'age', today:{label:'Trader Age'") && src.includes("tab:{name:'age',nav:'progress',html:taScreenHtml}"));
  ok(src.includes('for(const f of PZ_FEATS)if(f.today&&!pzRolledOff(f.id))card[f.id]=()=>sec(f.id,()=>f.today.html(D));'), 'Today renders feature cards (unless a staged rollout leaves one out)');
  ok(src.includes('const feat=pzFeatTab(tab);'), 'and routes to feature screens');
  ok(grabFn('pzProgressHtml').includes("pzFeatureCards('progress',D)"), 'its card shows on Progress too (the tab its screen sits under)');
  ok(!grabFn('taCardHtml').includes("if(!A.n)return ''"), 'and on Today even before the first trading day (as building)');
});

// served: the feature file loads on Keel's page only, and app/features/ can't be used to reach other files
const server = require('../server.js');
const app = server.createApp({ dataDir: mkdtempSync(join(tmpdir(), 'ledger-ta-')), auth: '', htmlPath, push: false, pushTick: false, offsiteTimer: false });
const B = await new Promise(r => app.listen(0, () => r('http://127.0.0.1:' + app.address().port)));
try {
  await t('the feature file loads on both screens, versioned like every script', async () => {
    const k = await (await fetch(B + '/daruma')).text(), j = await (await fetch(B + '/')).text();
    const m = k.match(/<script src="(app\/features\/trader-age\.js\?v=[0-9a-f]{12})"><\/script>/); ok(m, 'on Daruma');
    ok(/<script src="app\/features\/trader-age\.js\?v=[0-9a-f]{12}"><\/script>/.test(j), 'on the journal too: its milestone badges count XP on both screens');
    const r = await fetch(B + '/' + m[1]); eq(r.status, 200); ok((await r.text()).includes('function traderAge('));
    for (const p of ['/app/features/../server.js', '/app/features/%2e%2e%2fserver.js', '/app/features/x/y.js', '/app/features/.hidden.js']) eq((await fetch(B + p)).status, 404, p);
  });
} finally { await new Promise(r => app.close(r)); }
report('trader age');
