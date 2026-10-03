// Habits vs results, day by day (habitLink): the model behind the scatter, the score bands and the
// "which habits pay" bars in Pulse → Stats and Review. Pure: built from the app source, no DOM.
import { t, ok, eq, near, report, makeExtractor } from './harness.mjs';
import { readAppSource } from '../app-source.js';

const html = readAppSource(new URL('../ledger.html', import.meta.url).pathname);
const { evalModule } = makeExtractor(html);
const pre = html.match(/const RV_BLIND=\[[^\]]*\];/)[0] + '\n' + html.match(/const RV_CHANCE=\[[^\]]*\];/)[0] + '\n' + html.slice(html.indexOf('const RV_HABITS=['), html.indexOf('];', html.indexOf('const RV_HABITS=[')) + 2)
  + '\n' + html.match(/const HL_MIN=\{[^}]*\};/)[0] + '\n' + html.match(/const HL_BANDS=\[.*\];/)[0];
const pre2 = pre + '\n' + html.match(/const HL_SURE=\{.*\};/)[0];
const { habitLink, hlLinkWords, hlSummary } = await evalModule(['habitLink', 'hlLinkWords', 'hlSummary', '_spearmanWith', '_seededRnd', 'rvRoutineOf', 'rvChanceSplit'], null, pre2);

// n days; each day's habits decided by keep(i) → {plan, checkin, review, revenge}; result by res(i, kept)
function history(n, keep, res) {
  const days = [], byDay = {}, entries = {};
  for (let i = 0; i < n; i++) {
    const key = new Date(Date.UTC(2026, 6, 1 + i)).toISOString().slice(0, 10), k = keep(i);
    const trades = [{ id: key + 'a', net: res(i, k) / 2, r: res(i, k) / 200, pct: res(i, k) / 100 }, { id: key + 'b', net: res(i, k) / 2, r: res(i, k) / 200, pct: res(i, k) / 100 }];
    byDay[key] = trades;
    days.push({ key, score: k.revenge ? 50 : 100, n: 2, net: res(i, k),
      // trade b came right after a loss (a chance at revenge and at sizing up); the day had a usual trade count to keep
      behavior: { n: 2, clean: k.revenge ? 1 : 2, flags: { revenge: k.revenge ? 1 : 0 }, slips: k.revenge ? [{ id: key + 'b', f: ['revenge'] }] : [],
        chances: { revenge: 1, sizeUp: 1, overtrade: 1 }, kept: { revenge: k.revenge ? 0 : 1, sizeUp: 1, overtrade: 1 }, tests: { revenge: [key + 'b'], sizeUp: [key + 'b'] } },
      parts: { plan: k.plan == null ? null : k.plan ? 1 : 0 } });
    entries[key] = { checkin: !!k.checkin, review: !!k.review };
  }
  return { days, byDay, opts: { rOf: tr => tr.r, pctOf: tr => tr.pct, entryOf: key => entries[key], seed: 3 } };
}
const allKept = () => ({ plan: true, checkin: true, review: true, revenge: false });

t('every trading day is a point: its habit score against the day’s total result', () => {
  const H = history(5, i => ({ plan: i % 2 === 0, checkin: true, review: false, revenge: i === 4 }), i => 100 * (i + 1));
  const L = habitLink(H.days, H.byDay, H.opts);
  eq(L.points.length, 5); eq(L.unit, '$');
  eq(L.points.map(p => p.v), [100, 200, 300, 400, 500], 'the day’s dollars, summed');
  // in play: plan (kept on some days), check-in (kept), and the fill checks; review was never done, so it isn’t held against anyone
  eq(L.tracked.includes('End-of-day review written'), false);
  ok(L.tracked.includes('Morning prep done') && L.tracked.includes('Plan written before the first trade'));
  const p0 = L.points[0], p1 = L.points[1], p4 = L.points[4];
  // a fill check counts only once it was ever tested (adding to a loser never was: no adds in this history)
  eq([p0.kept.length, p0.missed.length, p0.score], [5, 0, 100], 'plan + morning prep + three clean fill checks');
  eq([p1.missed, p1.score], [['Plan written before the first trade'], 80]);
  ok(p4.missed.includes('No revenge entries'), 'a revenge entry is a missed habit');
});
t('habits that can only fail on a losing day stay out of the score', () => {
  const H = history(4, allKept, i => (i % 2 ? -50 : 50));
  H.days.forEach((d, i) => { d.parts.stops = i % 2 ? 0 : 1; d.parts.limit = i % 2 ? 0 : 1; });
  const L = habitLink(H.days, H.byDay, H.opts);
  eq(L.points.map(p => p.score), [100, 100, 100, 100], 'losing days aren’t marked down for the stop they took');
  eq(L.tracked.includes('Stops honored'), false);
  const stops = L.habits.find(h => h.key === 'stops'); ok(stops && stops.mechanical, 'still listed, flagged as following from the result');
});
t('when keeping the habits goes with better days: a positive, significant link and a rising trend', () => {
  const H = history(30, i => ({ plan: i % 3 !== 0, checkin: i % 4 !== 0, review: i % 2 === 0, revenge: i % 5 === 0 }),
    (i, k) => -200 + 60 * [k.plan, k.checkin, k.review, !k.revenge].filter(Boolean).length + ((i * 37) % 11 - 5) * 4);
  const L = habitLink(H.days, H.byDay, H.opts);
  ok(L.spread); ok(L.corr && L.corr.rho > 0.5 && L.corr.p < 0.05, JSON.stringify(L.corr));
  ok(L.fit.slope > 0, 'the trend climbs');
  ok(L.good.avg > L.rest.avg, 'days 70+ beat the rest');
  const words = hlLinkWords(L.corr); eq(words.tone, 'good'); ok(/cleaner days, better results/.test(words.text), words.text);
  const plan = L.habits.find(h => h.key === 'plan'); ok(plan.diff > 0 && plan.kept.n + plan.missed.n === 30);
  eq(L.habits[0].mechanical, false, 'habits that pay first');
});
t('bands: the average day at each habit score, with counts', () => {
  const H = history(12, i => ({ plan: i < 6, checkin: i < 9, review: true, revenge: false }), (i, k) => (k.plan ? 100 : -100));
  const L = habitLink(H.days, H.byDay, H.opts);
  eq(L.bands.map(b => b.label), ['Under 50', '50–69', '70–89', '90–100']);
  eq(L.bands.reduce((a, b) => a + b.n, 0), 12, 'every day in one band');
  const top = L.bands[3]; eq(top.n, 6); near(top.avg, 100, 1e-9); eq(top.green, 6); eq(top.trades, 12);
});
t('every day the same score: nothing to compare, so no link and no trend line', () => {
  const H = history(20, allKept, i => (i % 2 ? 80 : -60));
  const L = habitLink(H.days, H.byDay, H.opts);
  eq(L.spread, false); eq(L.corr, null); eq(L.fit, null);
});
t('the link is only stated from 8 days; points show from the first', () => {
  const H = history(5, i => ({ plan: i % 2 === 0, checkin: true, review: false, revenge: false }), i => 10 * i);
  const L = habitLink(H.days, H.byDay, H.opts);
  eq(L.points.length, 5); eq(L.corr, null); ok(L.fit, 'the trend line is drawn already'); eq(L.need, { days: 3, corr: 8 });
});
t('result units: dollars by default, % and R when the trades carry them', () => {
  const H = history(6, allKept, i => 100 + i);
  eq(habitLink(H.days, H.byDay, H.opts).units, ['$', '%', 'R']);
  const R = habitLink(H.days, H.byDay, { ...H.opts, unit: 'R' }); eq(R.unit, 'R'); near(R.points[0].v, 1, 1e-9, 'two trades of 0.5R');
  eq(habitLink(H.days, H.byDay, { ...H.opts, rOf: () => null }).units, ['$', '%'], 'no R without planned risk');
  eq(habitLink(H.days, H.byDay, { ...H.opts, rOf: () => null, unit: 'R' }).unit, '$', 'an unavailable unit falls back to dollars');
});
t('days without trades aren’t points, and the same input always gives the same answer', () => {
  const H = history(10, i => ({ plan: i % 2 === 0, checkin: true, review: i % 3 === 0, revenge: false }), i => (i % 3) * 40 - 30);
  H.days.push({ key: '2026-08-30', score: 100, n: 0, behavior: { n: 0, slips: [] }, parts: {} });
  const a = habitLink(H.days, H.byDay, H.opts), b = habitLink(H.days, H.byDay, H.opts);
  eq(a.points.length, 10); eq(JSON.stringify(a), JSON.stringify(b));
});

console.log('\nThe plain-language read (Pulse)');
const pays = () => history(30, i => ({ plan: i % 3 !== 0, checkin: i % 4 !== 0, review: i % 2 === 0, revenge: i % 5 === 0 }),
  (i, k) => -200 + 60 * [k.plan, k.checkin, k.review, !k.revenge].filter(Boolean).length + ((i * 37) % 11 - 5) * 4);
t('when habits pay: “yes”, how sure, the dollar difference and the habit to protect', () => {
  const H = pays(), L = habitLink(H.days, H.byDay, H.opts), S = hlSummary(L);
  eq(S.verdict, 'pays'); ok(S.sure >= 2, 'at least “looks real”'); ok(/Looks real|Clear pattern/.test(S.sureText));
  near(S.d, L.good.avg - L.rest.avg, 1e-9); ok(S.d > 0);
  ok(S.top && !S.top.mechanical && S.top.diff > 0, 'a real habit to protect');
  eq(S.top.key, L.habits.find(h => !h.mechanical && h.diff > 0 && h.kept.n >= 3 && h.missed.n >= 3).key, 'the one worth most');
});
t('before 8 days: too early, no claims, no habit named', () => {
  const H = history(6, i => ({ plan: i % 2 === 0, checkin: true, review: false, revenge: false }), (i, k) => (k.plan ? 300 : -300));
  const S = hlSummary(habitLink(H.days, H.byDay, H.opts));
  eq([S.verdict, S.sure, S.sureText, S.top], ['early', 0, 'Too early to tell', null]);
});
t('no link: “not clear yet”, one bar of sure, and no habit to protect', () => {
  const H = history(30, i => ({ plan: i % 2 === 0, checkin: i % 3 !== 0, review: i % 4 === 0, revenge: i % 5 === 0 }), i => ((i * 53) % 17 - 8) * 25);
  const L = habitLink(H.days, H.byDay, H.opts), S = hlSummary(L);
  ok(!L.corr || L.corr.p >= 0.05, 'fixture has no real link');
  eq([S.verdict, S.sure, S.top], ['unclear', 1, null]); eq(S.sureText, 'Not clear yet — could be luck');
});
t('habits kept every day (or never): nothing to compare, said plainly', () => {
  const H = history(12, allKept, i => (i % 2 ? 50 : -20));
  const S = hlSummary(habitLink(H.days, H.byDay, H.opts));
  eq([S.verdict, S.sure, S.both, S.top], ['flat', 0, false, null]); eq(S.sureText, 'Nothing to compare yet');
});
t('when sloppier days did better, it says so rather than claiming habits pay', () => {
  const H = history(30, i => ({ plan: i % 3 !== 0, checkin: i % 4 !== 0, review: i % 2 === 0, revenge: i % 5 === 0 }),
    (i, k) => 200 - 60 * [k.plan, k.checkin, k.review, !k.revenge].filter(Boolean).length + ((i * 37) % 11 - 5) * 4);
  const S = hlSummary(habitLink(H.days, H.byDay, H.opts));
  eq(S.verdict, 'reverse'); ok(S.d < 0); eq(S.top, null);
});

report('habit link');
