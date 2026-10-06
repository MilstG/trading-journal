// Daruma's features for coming back: what's worth celebrating (celebrate.js), the finding of the week
// (finding.js), the month and year recap (recap.js) and the first look (first-look.js). Each file is
// run as it ships, in a sandbox with the few app globals it leans on.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { t, ok, eq, report } from './harness.mjs';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const load = (...files) => { const feats = [];
  const ctx = vm.createContext({ MONTHS, PZ_TIERS: ['Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond', 'Legend'], pzFeature: f => feats.push(f), localStorage: { getItem: () => null, setItem() {} },
    PZ_BEH: { revenge: 'Entered within 15 minutes of a loss', afterTwo: 'Kept trading after two losses in a row', sizeUp: 'Sized up right after a loss' },
    dayKey: ms => new Date(ms).toISOString().slice(0, 10) });
  for (const f of files) vm.runInContext(readFileSync(new URL('../app/features/' + f, import.meta.url), 'utf8'), ctx, { filename: f });
  ctx.feats = feats; return ctx; };

console.log('\nCelebrations');
const C = load('celebrate.js');
const snap = (o) => Object.assign({ lv: 4, st: 3, pw: 1, keys: ['a:first-live', 'b:clean-5'] }, o);
const E = { 'a:first-live': { at: '2026-09-01' }, 'b:clean-5': { at: '2026-09-02' }, 'a:walked-away': { at: '2026-10-05' }, 'b:clean-10': { at: '2026-10-05' }, 'b:old-1': { at: '2026-01-01' }, 'c:2026-W41': { at: '2026-10-05', xp: 150 } };
const names = { 'walked-away': { t: 'Walked away at the limit' }, 'clean-10': { t: 'Clean slate', r: 2 }, 'old-1': { t: 'Old one' }, levelTitle: 'Steady hand' };
t('nothing on a first look (no snapshot yet)', () => {
  eq(C.celeMoments(null, snap(), E, names, '2026-10-02').length, 0);
});
t('a level, a perfect week, a streak mark and new awards, biggest first', () => {
  const cur = snap({ lv: 5, st: 10, pw: 2, keys: [...snap().keys, 'a:walked-away', 'b:clean-10', 'c:2026-W41'] });
  const M = C.celeMoments(snap(), cur, E, names, '2026-10-02');
  eq(M.map(m => m.k), ['level', 'perfect', 'streak', 'achievement', 'challenge', 'badge']);
  eq(M[0].title, 'Level 5'); ok(/Steady hand/.test(M[0].sub)); eq(M[2].title, '10 clean days in a row', 'the highest mark crossed (5 and 10): 10');
  eq(M[5].kicker, 'New badge · Gold');
});
t('old awards that turn up late (history merging in) aren’t news; nor is a jump of many levels', () => {
  const M = C.celeMoments(snap(), snap({ lv: 9, keys: [...snap().keys, 'b:old-1'] }), E, names, '2026-10-02');
  eq(M, []);
});
t('a streak that didn’t cross a mark says nothing', () => {
  eq(C.celeMoments(snap({ st: 6 }), snap({ st: 9 }), E, names, '2026-10-02'), []);
});

console.log('\nFinding of the week');
const F = load('finding.js');
const fs = [{ id: 'a', title: 'A', conf: 'strong', tone: 'leak' }, { id: 'b', title: 'B', conf: 'early', tone: 'edge' },
  { id: 'c', title: 'C', conf: 'likely', tone: 'edge' }, { id: 'd', title: 'D', conf: 'strong', tone: 'info' }];
t('only findings that are probably real, edges and leaks, strongest first', () => {
  const r = F.findPick(fs, {}, '2026-W41'); eq(r.pick.id, 'a'); eq(r.st.hist, [{ week: '2026-W41', id: 'a' }]);
});
t('the same one all week, a new one the next week, none repeated within six weeks', () => {
  let r = F.findPick(fs, {}, '2026-W41'); eq(F.findPick(fs, r.st, '2026-W41').pick.id, 'a');
  r = F.findPick(fs, r.st, '2026-W42'); eq(r.pick.id, 'c');
  r = F.findPick(fs, r.st, '2026-W43'); eq(r.pick, null, 'nothing new that’s real: no card');
  const old = { hist: [{ week: '2026-W30', id: 'a' }] }; eq(F.findPick(fs, old, '2026-W41').pick.id, 'a', 'long enough ago: it can come back');
});

console.log('\nRecap');
const R = load('recap.js');
const day = (key, score, slips) => ({ key, score, parts: { plan: score >= 70 ? 1 : 0 }, behavior: { slips: (slips || []).map(f => ({ f: [f], net: -10 })) } });
const g = { days: [day('2026-08-03', 50, ['revenge', 'revenge']), day('2026-08-04', 40, ['revenge']), day('2026-08-05', 60, ['revenge', 'sizeUp']),
    day('2026-09-01', 80), day('2026-09-02', 90), day('2026-09-03', 60, ['sizeUp']), day('2026-09-10', 100), day('2026-09-11', 75)],
  streak: { perfectWeeks: [{ week: '2026-W37', key: '2026-09-11' }], best: 4 }, xp: { byDay: { '2026-09-01': 100, '2026-09-10': 120, '2026-08-03': 50 } },
  catalog: { earned: [{ id: 'x-1', t: 'Clean slate · Gold', r: 2, k: '2026-09-02', c: 'discipline' }, { id: 'm-1', t: 'In the black', r: 4, k: '2026-09-02', c: 'results' }] },
  achievements: [{ title: 'Perfect week', at: '2026-09-11' }], challenges: [{ status: 'done', key: '2026-09-11' }] };
const J = { 'day:2026-09-01': { eod: { at: 1 } }, 'day:2026-09-06': { rest: 1 }, 'day:2026-08-06': { rest: 1 } };
t('a month in process: Discipline, clean days, best streak, XP, badges (never results ones), rest days', () => {
  const r = R.rcRecap(g, J, '2026-09', [{ key: '2026-09-02' }, { key: '2026-08-01' }]);
  eq([r.label, r.tradingDays, r.discipline, r.prevDiscipline, r.clean, r.perfectDays, r.bestStreak, r.perfectWeeks, r.xp],
    ['Sep 2026', 5, 81, 50, 4, 1, 2, 1, 220]);
  eq([r.badges, r.topBadges, r.achievements, r.challenges, r.reviews, r.plans, r.lessons, r.rest], [1, [{ t: 'Clean slate', r: 2 }], ['Perfect week'], 1, 1, 4, 1, 1]);
  eq(r.better.slip, 'revenge', 'four revenge entries over three August days, none in September');
  ok(!JSON.stringify(r).match(/net|usd|pnl/i), 'no money in it');
});
t('a year, and a period without trading', () => {
  eq(R.rcRecap(g, J, '2026', []).tradingDays, 8); eq(R.rcRecap(g, J, '2026-07', []), null);
});
t('which recap to offer: last month early in a month, last year early in January', () => {
  eq(R.rcLatest(g, '2026-10-03'), { key: '2026-09', kind: 'month', label: 'Sep 2026', fresh: true });
  eq(R.rcLatest(g, '2026-10-20').fresh, false);
  eq(R.rcLatest(g, '2027-01-05'), { key: '2026', kind: 'year', label: '2026', fresh: true });
});

console.log('\nFirst look');
const L = load('first-look.js');
t('the last 30 trading days scored, and the slip that cost the most', () => {
  const s = L.flSummary(g.days, 30);
  eq([s.days, s.discipline, s.clean], [8, 69, 4]);
  eq(s.leak, { slip: 'revenge', n: 4, cost: -40 });
  eq(L.flSummary([], 30), null);
});

console.log('\nWired into Daruma');
t('each plugs in through pzFeature', () => {
  eq(C.feats.map(f => [f.id, typeof f.drawn]), [['celebrate', 'function']]);
  eq(F.feats[0].today.after, 'lesson'); eq(R.feats[0].tab.name, 'recap'); ok(R.feats[0].tab.arg.test('2026-09') && R.feats[0].tab.arg.test('2026'));
  eq(L.feats[0].id, 'firstlook');
});

report('engagement features');
