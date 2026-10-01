// The progress layer: levels, the forgiving discipline streak, XP, achievements, discipline
// saved, personal bests, the monthly report card, weekly challenges — and the coach-mode switch
// that hides every recent feature. Pure functions are extracted from ledger.html itself.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { t, ok, eq, near, report, makeExtractor } from './harness.mjs';

const html = readFileSync(new URL('../ledger.html', import.meta.url), 'utf8');
const { grabFn } = makeExtractor(html);
const grabConst = (name) => { const i = html.indexOf('const ' + name + '='); if (i < 0) throw new Error(name);
  return html.slice(i, html.indexOf(';\n', i) + 1); };

const ctx = { Date, Math, Object, Set, Map, JSON, isFinite, journal: {}, settings: {}, PZ_CFG: { rev: 0, levels: null } };
Object.assign(ctx, { isWin: n => n > 50, isLoss: n => n < -50, _avg: a => a.reduce((s, x) => s + x, 0) / a.length });
vm.createContext(ctx);
vm.runInContext(['PROCESS_W', 'LEVELS', 'GRADE', 'PART_NAME', 'HABIT_LIBRARY', 'CHALLENGE_DEFAULTS'].map(grabConst).join('\n') + '\n'
  + ['_erf', 'pzLevelCfg', 'levelFor', 'isoWeekOfKey', 'disciplineStreak', 'xpLedger', 'nthKey', 'isJournaled', 'gameAchievements', 'ruleFollowThrough',
     'disciplineSaved', 'personalBests', 'monthlyReport', 'resolveHabitSpec', 'specKey', 'challengeCandidates', 'challengeStatus', 'nfPlan', 'nfMedian', 'planAdherence', 'processDays'].map(grabFn).join('\n')
  + '\nconst _normCdf=z=>0.5*(1+_erf(z/Math.SQRT2));', ctx);

const day = (key, score, extra) => Object.assign({ key, score, net: 10, parts: {}, n: 1 }, extra || {});
// consecutive calendar days from a start date
const keys = (start, n) => Array.from({ length: n }, (_, i) => new Date(Date.parse(start + 'T00:00:00Z') + i * 86400000).toISOString().slice(0, 10));

console.log('\nLevels and XP');
t('levels start at 200·n·(n−1) XP and carry titles', () => {
  eq(ctx.levelFor(0).level, 1); eq(ctx.levelFor(0).title, 'Rookie');
  eq(ctx.levelFor(399).level, 1); eq(ctx.levelFor(400).level, 2); eq(ctx.levelFor(1200).level, 3);
  const l = ctx.levelFor(1500); eq(l.level, 3); eq(l.into, 300); eq(l.need, 1200);
  eq(ctx.levelFor(1e9).title, 'Legend');
  // a league owner's own table and titles
  ctx.PZ_CFG.levels = { mode: 'table', thresholds: [100, 300], titles: ['Pup', 'Wolf', 'Alpha'] };
  eq([ctx.levelFor(99).level, ctx.levelFor(100).title, ctx.levelFor(5000).level, ctx.levelFor(5000).max], [1, 'Wolf', 3, true]);
  ctx.PZ_CFG.levels = null;
});
t('XP is the day’s process score plus bonuses — trade count never enters it', () => {
  const led = ctx.xpLedger([day('2026-06-01', 80, { n: 1 }), day('2026-06-02', 80, { n: 12 })], [{ key: '2026-06-02', xp: 150 }]);
  eq(led.total, 310); eq(led.byDay['2026-06-01'], 80); eq(led.byDay['2026-06-02'], 230);
});
t('ISO weeks from calendar keys', () => {
  eq(ctx.isoWeekOfKey('2026-09-28'), '2026-W40'); eq(ctx.isoWeekOfKey('2026-01-01'), '2026-W01'); eq(ctx.isoWeekOfKey('2027-01-01'), '2026-W53');
});

console.log('\nDiscipline streak');
t('a finished perfect week earns a shield that absorbs one miss', () => {
  // Mon–Fri Jun 1–5 2026 all good → shield; next Monday a miss is absorbed; Tuesday good
  const d = keys('2026-06-01', 5).map(k => day(k, 90)).concat([day('2026-06-08', 40), day('2026-06-09', 85)]);
  const s = ctx.disciplineStreak(d, '2026-W30');
  eq(s.perfectWeeks.length, 1); eq(s.shielded, ['2026-06-08']); eq(s.current, 6); eq(s.shields, 0);
});
t('without a shield a miss resets; the current week earns nothing until it ends', () => {
  const d = keys('2026-06-01', 3).map(k => day(k, 90)).concat([day('2026-06-04', 30), day('2026-06-05', 80)]);
  const s = ctx.disciplineStreak(d, '2026-W23');
  eq(s.current, 1); eq(s.best, 3); eq(s.perfectWeeks.length, 0);
  eq(ctx.disciplineStreak(keys('2026-06-01', 4).map(k => day(k, 90)), '2026-W23').shields, 0, 'week still running');
  eq(ctx.disciplineStreak(keys('2026-06-01', 4).map(k => day(k, 90)), '2026-W24').shields, 1, 'week over');
});

console.log('\nAchievements');
t('achievements unlock on the day the threshold is reached', () => {
  const ds = keys('2026-06-01', 12).map((k, i) => day(k, i < 10 ? 80 : 50, { net: -60, parts: { plan: 1 }, breached: i === 3 ? true : false }));
  ds[3].parts.limit = 1;
  const closed = ds.map((d, i) => ({ id: 't' + i, closeTime: Date.parse(d.key + 'T12:00:00Z'), openTime: Date.parse(d.key + 'T11:00:00Z'), net: -60 }));
  const byDay = {}; closed.forEach(t => { const k = new Date(t.closeTime).toISOString().slice(0, 10); (byDay[k] = byDay[k] || []).push(t); });
  byDay['2026-06-05'] = [{ closeTime: 1, openTime: 0, net: -80 }, { closeTime: 2, openTime: 1, net: -90 }];
  const A = ctx.gameAchievements({ days: ds, closed, byDay, J: {}, pa: { items: [] }, dayOf: ms => new Date(ms).toISOString().slice(0, 10),
    journalRun: { best: 3, at30: null }, streak: { perfectWeeks: [] }, keptMonth: [], challenges: [{ key: '2026-06-07', status: 'done' }] });
  const a = id => A.find(x => x.id === id);
  eq(a('plan-10').at, '2026-06-10'); eq(a('walked-away').at, '2026-06-04'); eq(a('good-losses').at, '2026-06-10');
  eq(a('sat-out').at, '2026-06-05'); eq(a('challenge-1').at, '2026-06-07');
  eq(a('journal-30').at, null); eq(a('journal-30').n, 3); eq(a('challenge-5').n, 1);
  ok(A.every(x => x.title && x.desc && x.glyph && x.of >= 1));
});

console.log('\nDiscipline saved');
t('only counts rules that lost money before and are broken less since', () => {
  const T = Date.UTC(2026, 0, 1), closed = [];
  for (let i = 0; i < 40; i++) closed.push({ openTime: T + i * 86400000, coin: i < 20 ? (i % 2 ? 'ETH' : 'BTC') : (i === 25 ? 'ETH' : 'BTC'), net: i % 2 && i < 20 ? -100 : 20 });
  const r = ctx.disciplineSaved(closed, [{ name: 'ETH', pred: x => x.coin === 'ETH', createdAt: T + 20 * 86400000 }]);
  // before: 10 of 20 broke it at −100 avg; after: 1 of 20 → ~9 avoided × $100
  near(r.items[0].avoided, 9, 1e-9); near(r.total, 900, 1e-9);
  eq(ctx.disciplineSaved(closed, [{ name: 'BTC', pred: x => x.coin === 'BTC', createdAt: T + 20 * 86400000 }]).total, 0, 'a profitable condition saves nothing');
});

console.log('\nPersonal bests and report card');
t('best process week excludes the running week and flags a new best', () => {
  const d = [...keys('2026-06-01', 3).map(k => day(k, 70)), ...keys('2026-06-08', 3).map(k => day(k, 90))];
  const p = ctx.personalBests(d, { best: 6, current: 6 }, 4, 5, '2026-W24');
  const wk = p.find(x => x.id === 'week');
  eq(wk.value, 70); eq(wk.current, 90); eq(wk.isNew, true);
});
t('monthly report grades each habit and compares with the previous month', () => {
  const d = [day('2026-05-10', 50, { parts: { journal: 0.5 } }), day('2026-06-02', 95, { parts: { journal: 1, stops: 0.8 } }), day('2026-06-03', 85, { parts: { journal: 1 } })];
  const r = ctx.monthlyReport(d, '2026-06');
  eq(r.grade, 'A'); eq(r.good, 2); eq(r.prevMonth, '2026-05'); near(r.delta, 40, 1e-9);
  eq(r.parts.find(p => p.part === 'journal').grade, 'A'); near(r.parts.find(p => p.part === 'journal').delta, 0.5, 1e-9);
  eq(r.parts.find(p => p.part === 'stops').grade, 'B');
  ok(!JSON.stringify(r).includes('$'), 'no dollar amounts in the card data');
  eq(ctx.monthlyReport(d, '2026-07'), null);
});

console.log('\nWeekly challenges');
t('candidates come from leaks first, then core habits, without duplicates', () => {
  const c = ctx.challengeCandidates([{ tone: 'leak', habit: { tpl: 'cool-off' } }, { tone: 'edge', habit: { tpl: 'size-cap' } }, { tone: 'caution', habit: { tpl: 'cool-off' } }]);
  eq(c[0].tpl, 'cool-off'); ok(!c.some(x => x.tpl === 'size-cap'), 'edges are not challenges');
  eq(c.filter(x => x.tpl === 'cool-off').length, 1); ok(c.some(x => x.tpl === 'journal-all'));
});
t('a finding and a library habit testing the same condition are one candidate', () => {
  const c = ctx.challengeCandidates([{ tone: 'leak', habit: { kind: 'avoid', pid: 'st:loss1h', when: 'x', then: 'y' } }]);
  eq(c.filter(x => ctx.specKey(x) === 'pid:st:loss1h').length, 1, 'cool-off (same pid) not added again');
});
t('a planning challenge grades its own week only — later days are not redefined', () => {
  const mk = d => ({ id: 'p' + d, coin: 'BTC', dir: 'Long', openTime: Date.UTC(2026, 5, d, 9), closeTime: Date.UTC(2026, 5, d, 10), avgEntry: 100, avgExit: 101, maxSize: 1, net: 10 });
  const dk = ms => new Date(ms).toISOString().slice(0, 10);
  const days = ctx.processDays([mk(1), mk(9), mk(20)], {}, { dayOf: dk, violIds: new Set(), rulesActive: false, planWindows: [{ part: 'plan', from: '2026-06-08', to: '2026-06-15' }] });
  eq(days.map(d => d.parts.plan), [undefined, 0, undefined]);
});
t('challenge status: on track, missed, done, too few days', () => {
  eq(ctx.challengeStatus([{ kept: true }], false), 'on track'); eq(ctx.challengeStatus([{ kept: true }, { kept: false }], false), 'missed');
  eq(ctx.challengeStatus([{ kept: true }, { kept: true }], true), 'done'); eq(ctx.challengeStatus([{ kept: true }], true), 'too few days');
});

console.log('\nCoach mode switch covers every recent feature');
t('each recent surface is gated by coachOn()', () => {
  for (const fn of ['renderCoach', 'habitsSectionHtml', 'processSectionHtml', 'progressSectionHtml', 'inboxSectionHtml', 'customRulesHtml',
    'planTimingBadge', 'lastWeekFocusHtml', 'loadCoachLetter', 'findingCardHtml', 'ensureWeekChallenge'])
    ok(grabFn(fn).includes('coachOn()'), fn);
  ok(html.includes("const ruleCtl=v=>{ if(!v.pid||v.uplift>=0||!coachOn())return'';"), 'miner + rule');
  ok(html.includes("const ruleBtn=(cond&&cond.cid&&dNet>0&&coachOn())"), 'what-if make rule');
  ok(html.includes("const open=coachOn()?allTrades.filter(t=>t.isOpen):[];"), 'dashboard chips');
  ok(html.includes("const plan=coachOn()?nfPlan(journal[t.id]):null;"), 'replay overlays');
  ok(html.includes("fz.ck||(settings.coachMode!==false&&withCk>=10)"), 'check-in miner family');
  ok(html.includes("_minerCache={key:null,res:null,deep:null}; // the check-in conditions come and go with coach mode"), 'miner cache reset on toggle');
  ok(html.includes('syncDexTog(); syncCoachMode();'), 'switch UI follows synced settings');
  ok(html.includes("to:addDays(from,7)"), 'DST-safe challenge end');
  ok(html.includes("if(!auto)markJEdit(k);"), 'auto challenge picks lose to other devices on conflict');
  ok(html.includes("${coachOn()?`        <div class=\"field\"><label data-tip=\"Ten seconds"), 'check-in fields');
  ok(html.includes("if(!el){ e[f]=prevE[f]||null; continue; }"), 'hidden check-in keeps stored values');
  ok(html.includes('${!coachOn()?`<div class="diag-section">\n     <h2>Recommendations</h2>'), 'plain recommendations when off');
  const srv = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  ok(srv.includes("if (st && st.coachMode === false) return; } catch (e) {} // coach mode off in the app"), 'server nudge');
});

report('game');
