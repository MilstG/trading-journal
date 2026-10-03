// Routine vs results: the long-run link between an outcome-blind discipline score and per-trade
// results — weekly correlation, next-week lead, the good-day dividend with a bootstrap range,
// habit attribution with false-discovery control, and the rolling trend. Synthetic histories
// where we control the truth.
import { t, ok, eq, near, report, makeExtractor } from './harness.mjs';
import { readAppSource } from '../app-source.js';

const html = readAppSource(new URL('../ledger.html', import.meta.url).pathname);
const { grabFn, evalModule } = makeExtractor(html);
const pre = html.match(/const RV_BLIND=\[[^\]]*\];/)[0] + '\n' + html.match(/const RV_CHANCE=\[[^\]]*\];/)[0] + '\n' + html.slice(html.indexOf('const RV_HABITS=['), html.indexOf('];', html.indexOf('const RV_HABITS=[')) + 2);
const { routineVsResults } = await evalModule(['routineVsResults', '_spearmanWith', 'rvRoutineOf', 'rvChanceSplit'], null, pre);

// a history of N weeks x 4 trading days x 3 trades; `effect` links the day's discipline to its results
function history(N, effect, opts = {}) {
  let s = 12345; const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
  const days = [], byDay = {};
  for (let w = 0; w < N; w++) for (let d = 0; d < 4; d++) {
    const key = '2026-' + String(Math.floor((w * 7 + d) / 28) + 1).padStart(2, '0') + '-' + String((w * 7 + d) % 28 + 1).padStart(2, '0');
    const sloppy = rnd() < 0.4, trades = [], slips = [];
    for (let i = 0; i < 3; i++) { const id = key + ':' + i, bad = sloppy && i === 0;
      const r = (bad ? -effect : effect * 0.3) + (rnd() - 0.5) * 2;
      trades.push({ id, r, net: r * 100 });
      if (bad) slips.push({ id, f: ['revenge'] });
      if (opts.mechanical && r < -0.5) slips.push({ id, f: ['heldLoser'] }); }
    byDay[key] = trades;
    // trade 0 is an entry right after a loss (a chance at "no revenge entry"); on a sloppy day it slipped
    days.push({ key, week: 'W' + String(w).padStart(3, '0'), behavior: { n: 3, slips, flags: { revenge: sloppy ? 1 : 0 },
      chances: { revenge: 1 }, kept: { revenge: sloppy ? 0 : 1 }, tests: { revenge: [key + ':0'], sizeUp: [] } },
      parts: { plan: opts.planPays ? (sloppy ? 0 : 1) : (rnd() < 0.5 ? 1 : 0), limit: trades.some(x => x.r < -1) ? 0 : 1 } });
  }
  return { days, byDay, opts: { rOf: x => x.r, pctOf: x => x.r, weekOf: k => days.find(d => d.key === k).week, seed: 7 } };
}

console.log('\nRoutine vs results');
t('when discipline drives results: positive weekly correlation, a clear good-day dividend', () => {
  const H = history(30, 1.5); const r = routineVsResults(H.days, H.byDay, H.opts);
  eq(r.unit, 'R'); eq(r.weeks.length, 30);
  ok(r.corr.rho > 0.3 && r.corr.p < 0.05, JSON.stringify(r.corr));
  ok(r.dividend.diff > 0.5 && r.dividend.lo > 0, JSON.stringify(r.dividend));
  ok(r.dividend.lo <= r.dividend.diff && r.dividend.diff <= r.dividend.hi);
});
t('when it doesn’t: no significant correlation, a dividend range that straddles zero', () => {
  const H = history(30, 0); const r = routineVsResults(H.days, H.byDay, H.opts);
  ok(r.corr.p > 0.05, JSON.stringify(r.corr));
  ok(r.dividend.lo < 0 && r.dividend.hi > 0, JSON.stringify(r.dividend));
});
t('the score is outcome-blind: checks that only fail on a loss don’t lower it', () => {
  const A = history(10, 0), B = history(10, 0, { mechanical: true });
  eq(routineVsResults(A.days, A.byDay, A.opts).weeks.map(w => w.score), routineVsResults(B.days, B.byDay, B.opts).weeks.map(w => w.score));
});
t('below 8 weeks: no correlation is claimed, and the result says how many weeks it needs', () => {
  const H = history(5, 1.5); const r = routineVsResults(H.days, H.byDay, H.opts);
  eq(r.corr, null); eq(r.lead, null); eq(r.need, { weeks: 8, have: 5 });
});
t('habits: one that pays is found; outcome-linked ones are marked mechanical and kept out of the FDR family', () => {
  const H = history(30, 1.5, { planPays: true }); const r = routineVsResults(H.days, H.byDay, H.opts);
  const plan = r.habits.find(h => h.key === 'plan'), limit = r.habits.find(h => h.key === 'limit');
  ok(plan.diff > 0 && plan.q < 0.05, JSON.stringify(plan));
  eq(limit.mechanical, true); eq(limit.q, undefined, 'not part of the tested family');
  ok(r.habits.findIndex(h => h.mechanical) > r.habits.findIndex(h => h.key === 'plan'), 'mechanical habits list last');
});
t('next-week lead, the rolling window and the good/rest curves are produced', () => {
  const H = history(30, 1.5); const r = routineVsResults(H.days, H.byDay, H.opts);
  ok(r.lead && r.lead.n === 29); eq(r.rolling.length, 30 - 12 + 1);
  near(r.curves.good.at(-1).v + r.curves.rest.at(-1).v, Object.values(H.byDay).flat().reduce((s, x) => s + x.r, 0), 1e-9);
});
t('results fall back to % return when most trades have no risk set', () => {
  const H = history(10, 1); H.opts.rOf = () => null; eq(routineVsResults(H.days, H.byDay, H.opts).unit, '%');
});
t('seeded: the same history gives the same numbers', () => {
  const H = history(20, 1);
  eq(JSON.stringify(routineVsResults(H.days, H.byDay, H.opts)), JSON.stringify(routineVsResults(H.days, H.byDay, H.opts)));
});
t('wired into Review (with charts) and Pulse’s “Does discipline pay?”', () => {
  ok(grabFn('renderReviewInner').includes('routineSectionHtml()') && grabFn('renderReviewInner').includes('drawRoutineCharts()'));
  ok(grabFn('pzTrendsHtml').includes('pzLongViewHtml()'));
  ok(grabFn('rvModel').includes('rOf:rFor,pctOf:retPct'), 'R, else % return: both size-neutral');
});
report('routine');
