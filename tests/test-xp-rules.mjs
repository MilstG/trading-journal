// The app's XP game rules that the fourth audit found could be gamed or could take XP back (AUDIT-4:
// X7 swaps after the fact, X8 badge farming, X9 earned XP taken back, X14 mentoring in league XP,
// X16 the DST week start, X17 the week's XP breakdown, D8 duel stakes, E7 is in test-plans).
// gameContext runs for real in a sandbox: the coach context, the Discipline days and the logging bonus
// are hand-built stubs, everything after them (achievements, challenges, focus days, badges, the award
// ledger, the multiplier) is the shipped code.
process.env.TZ = 'America/New_York'; // X16 needs a zone with a clock change; the game itself runs on the UTC calendar
import vm from 'node:vm';
import { t, ok, eq, report, makeExtractor } from './harness.mjs';
import { readAppSource } from '../app-source.js';

const html = readAppSource(new URL('../ledger.html', import.meta.url).pathname);
const { grabFn } = makeExtractor(html);
const grabConst = name => { const i = html.indexOf('const ' + name + '='); if (i < 0) throw new Error(name); return html.slice(i, html.indexOf(';\n', i) + 1); };

let clock = Date.UTC(2026, 9, 1, 15); // Thu 2026-10-01 15:00Z, ISO week 2026-W40 (Mon 09-28)
class FDate extends Date { constructor(...a) { if (!a.length) super(clock); else super(...a); } static now() { return clock; } }
const ctx = vm.createContext({ Date: FDate, Math, console, Set, Map, Object, JSON, Array, String, Number, Promise, isFinite, Infinity, setTimeout });
const FNS = ['gameContext', 'pzEarned', 'pzEarnedRecord', 'pzBadgeStub', 'pzEarnedBadges', 'pzHabitResAll', 'pzGoalKeys', 'pzAdoptKeys', 'pzPluggedKeys',
  'xpLedger', 'disciplineStreak', 'isoWeekOfKey', 'nthKey', 'gameAchievements', 'challengeResults', 'challengeStatus', 'levelFor', 'pzLevelCfg', 'pzXpCfg',
  'personalBests', 'disciplineSaved', 'ruleFollowThrough', 'habitsList', 'habitById', 'habitSentence', 'habitDayResults', 'habitProgress', 'habitSummary',
  'isoWeekKey', 'lastCompletedWeekRange', 'tzParts', 'tzMidnight', 'addDays', 'dateBound', 'pzBadgeCatalog', 'pzPlugs', 'pzPlugState', 'isoWeekMondayKey',
  'nfMedian', 'isJournaled', 'weekChallenge', 'setWeekChallenge', 'pzSwapStartKey', 'setWeekFocus', 'weekFocus', 'retireHabit', 'adoptHabit', 'pzXpSources',
  'specKey', 'pzGoalEval', 'pzGoalMet', 'pzGoalsCtx', '_syncMerge', 'pzLessonsNorm', 'duelPrize'];
const CONSTS = ['LEVELS', 'PZ_XP_DEF', 'PZ_TIERS', 'PZ_TIER_XP', 'pzN', 'pzUsd', 'PZ_FAMILIES', 'pzAddDays', 'pzHabitKind', 'pzChallengeLocked', 'PZ_BEH', 'PZ_LOSS',
  'dayKey', 'pzMonthEnd', 'pzDaysBetween'];
vm.runInContext(`var settings={tz:'utc'}, journal={}, allTrades=[], _jrev=0, _excM={}, _pzSlipDays=new Map(), _gameMemo={key:null,g:null}, _coachMemo={key:'k'}, _coachMemoAll={key:'k'}, _pzCatPass=null;
var PZ_CFG={rev:0,levels:null,xp:null}, SOC={me:null,cache:{}}, S_KEY='s', J_KEY='j', saves=0, Store={ async set(){ saves++; } }, markJEdit=()=>{}, pbNorm=a=>a||[];
var _avg=a=>a.length?a.reduce((x,y)=>x+y,0)/a.length:0, isLoss=n=>n<-1, pzReadinessManual=()=>null, viewFilter=()=>true, dayLabel=k=>k;
var COACH=null, coachCtx=null, coachContext=()=>coachCtx, planAdherence=()=>({items:[]}), pzBonus=()=>({total:0});
var pzBehaviorDays=closed=>coachCtx.days.map(d=>({key:d.key,score:d.disc,n:d.n,net:d.net,flags:{},slips:[]}));
var customRulePreds=(trades,rules)=>rules.map(r=>({pred:t=>!!t.bad}));
${CONSTS.map(grabConst).join('\n')}
${FNS.map(grabFn).join('\n')}`, ctx);
const run = c => vm.runInContext(c, ctx);
const H = 3600e3, DAY = 86400e3;
const keyOf = ms => new Date(ms).toISOString().slice(0, 10);
// trading days: one closed trade a day at noon UTC; parts.journal=1 keeps the journal-all habit, bad trips the avoid predicate
function account(spec) {
  const days = [], closed = [], byDay = {};
  for (const [key, o] of Object.entries(spec).sort()) {
    const tr = { id: 't' + key, coin: 'ETH', openTime: Date.parse(key + 'T11:00:00Z'), closeTime: Date.parse(key + 'T12:00:00Z'), net: o.net ?? 10, isOpen: false, bad: !!o.bad };
    closed.push(tr); byDay[key] = [tr];
    days.push({ key, score: 80, disc: o.disc ?? 80, n: 1, net: tr.net, parts: { journal: o.j ? 1 : 0 }, breached: false });
  }
  ctx.allTrades = closed; ctx.coachCtx = { trades: closed, closed, days, byDay, preds: {}, findings: [], rulePreds: [] };
  ctx._coachMemo = { key: 'k' + Math.random() }; ctx._gameMemo = { key: null, g: null };
}
const fresh = () => { ctx._coachMemo = { key: 'k' + Math.random() }; ctx._gameMemo = { key: null, g: null }; };
const game = () => { fresh(); return run('gameContext()'); };
const range = (from, n, o) => Object.fromEntries(Array.from({ length: n }, (_, i) => [keyOf(Date.parse(from + 'T00:00:00Z') + i * DAY), Object.assign({}, o)]));
const badge = (g, id) => g.catalog.earned.find(b => b.id === id);

console.log('\nX16 · the week starts on Monday, also across a clock change');
t('Sunday 23:30 after the fall-back (2026-11-01, New York): this Monday is Oct 26, not Tuesday Oct 27', () => {
  run("settings.tz='local'");
  const now = new Date(2026, 10, 1, 23, 30).getTime(); // local wall clock
  const r = ctx.lastCompletedWeekRange(now), d = ms => { const x = new Date(ms); return [x.getFullYear(), x.getMonth() + 1, x.getDate(), x.getHours()]; };
  eq(d(r.to), [2026, 10, 26, 0], 'this Monday, local midnight');
  eq(d(r.from), [2026, 10, 19, 0], 'the Monday before');
  eq(ctx.isoWeekKey(r.to), ctx.isoWeekKey(now), 'Monday is in the same ISO week as now');
  // and across the spring change (2026-03-08) and an ordinary week
  for (const [y, m, dd, h, mon] of [[2026, 2, 8, 23, 2], [2026, 2, 9, 0, 9], [2026, 9, 1, 15, 28]]) {
    const n = new Date(y, m, dd, h, 30).getTime(), w = ctx.lastCompletedWeekRange(n);
    eq(d(w.to).slice(2), [mon, 0], `week of ${y}-${m + 1}-${dd}`); ok([167, 168, 169].includes((w.to - w.from) / H), 'a calendar week (167, 168 or 169 h)');
  }
  run("settings.tz='utc'");
  const u = ctx.lastCompletedWeekRange(Date.UTC(2026, 10, 1, 23, 30));
  eq([keyOf(u.from), keyOf(u.to)], ['2026-10-19', '2026-10-26'], 'UTC mode unchanged');
});

console.log('\nX7 · a swapped challenge or focus habit counts from the swap');
await t('the week’s first pick is graded from Monday; a swap from the swap day, or the next day once today has a trade', async () => {
  account(range('2026-09-28', 4, { j: 1 })); // Mon–Thu, all kept
  clock = Date.UTC(2026, 9, 1, 15); // Thu 15:00, after Thursday's trade (11:00–12:00)
  ctx.journal = {};
  await run("setWeekChallenge({kind:'process',part:'plan',tpl:'plan-first'},0,true)");
  let ch = run('weekChallenge()'); eq([keyOf(ch.from), keyOf(ch.to), ch.swapAt], ['2026-09-28', '2026-10-05', undefined], 'automatic pick: Monday to Monday');
  await run("setWeekChallenge({kind:'process',part:'journal',tpl:'journal-all'},1)");
  ch = run('weekChallenge()'); eq([keyOf(ch.from), keyOf(ch.to), ch.swapAt], ['2026-10-02', '2026-10-05', clock], 'Thursday already traded: counts from Friday');
  eq(ctx.challengeResults(ch, ctx.coachCtx, null), [], 'Mon–Thu, kept before the swap, don’t count');
  clock = Date.UTC(2026, 9, 1, 9); // Thu 09:00, before the day's first trade
  await run("setWeekChallenge({kind:'process',part:'journal',tpl:'journal-all'},1)");
  eq(keyOf(run('weekChallenge()').from), '2026-10-01', 'nothing traded yet today: today counts');
  eq(ctx.challengeResults(run('weekChallenge()'), ctx.coachCtx, null).map(r => r.key), ['2026-10-01']);
});
await t('Sunday cycling no longer pays: a challenge picked on Sunday can’t be done (too few days)', () => {
  account(range('2026-09-28', 7, { j: 1 })); // kept every day of the week
  clock = Date.UTC(2026, 9, 4, 15); // Sunday afternoon, after Sunday's trade
  ctx.journal = { 'week:2026-W40': { challenge: { spec: { kind: 'process', part: 'plan' }, from: Date.UTC(2026, 8, 28), to: Date.UTC(2026, 9, 5) } } };
  return run("setWeekChallenge({kind:'process',part:'journal',tpl:'journal-all'},1)").then(() => {
    clock = Date.UTC(2026, 9, 5, 15); const g = game();
    const c = g.challenges.find(c => c.week === '2026-W40'); eq([c.status, c.res.length], ['too few days', 0]);
    ok(!g.bonuses.some(b => b.why === 'challenge'), 'no +150');
  });
});
t('a missed challenge can’t be swapped: the button is gone and both handlers refuse', () => {
  eq(run("[pzChallengeLocked({status:'missed'}),pzChallengeLocked({status:'on track'}),pzChallengeLocked(null)]"), [true, false, false]);
  ok(grabFn('progressSectionHtml').includes("${pzChallengeLocked(ch)?'':`<button class=\"btn ghost\" id=\"chSwap\""));
  ok(grabFn('pzProgressHtml').includes("${pzChallengeLocked(ch)?'':`<button type=\"button\" class=\"pz-ghost pz-sm\" id=\"pzSwap\""));
  ok(grabFn('wireProgress').includes('if(!c.length||pzChallengeLocked(g.current))return;'));
  ok(html.includes("case 'pzSwap': { const g=gameContext(); const c=challengeCandidates(g.ctx.findings); const cur=weekChallenge(); if(!c.length||pzChallengeLocked(g.current))return;"));
});
await t('a focus habit set mid-week earns from the pick on; the one it replaced keeps the days it held', async () => {
  account(range('2026-09-28', 7, { j: 1 })); // journal-all kept all week
  ctx.journal = {}; clock = Date.UTC(2026, 8, 27, 12);
  run("settings={tz:'utc',habits:[{id:'hA',tpl:'journal-all',kind:'process',part:'journal',createdAt:Date.UTC(2026,8,1)},{id:'hB',tpl:'plan-first',kind:'process',part:'journal',createdAt:Date.UTC(2026,8,1)}]}");
  // the old way: hB as the week's focus, picked on Sunday, paid every kept day since Monday
  ctx.journal = { 'week:2026-W40': { focus: 'hB' } }; clock = Date.UTC(2026, 9, 5, 15);
  eq(game().bonuses.filter(b => b.why === 'focus habit').length, 7, 'an entry without focusFrom (older app): the whole week, as before');
  ctx.journal = {}; clock = Date.UTC(2026, 8, 28, 8); // Monday before trading
  await run("setWeekFocus('hA')"); eq(run("journal['week:2026-W40'].focusFrom"), '2026-09-28');
  clock = Date.UTC(2026, 8, 30, 15); // Wednesday after trading
  await run("setWeekFocus('hB')");
  eq(run("journal['week:2026-W40']").focusPast, [{ id: 'hA', from: '2026-09-28', to: '2026-10-01' }]);
  eq(run("journal['week:2026-W40'].focusFrom"), '2026-10-01');
  clock = Date.UTC(2026, 9, 5, 15);
  const f = game().bonuses.filter(b => b.why === 'focus habit').map(b => b.key);
  eq(f, ['2026-09-28', '2026-09-29', '2026-09-30', '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04'], 'hA Mon–Wed, hB Thu–Sun: each day once');
  ctx.journal = {}; clock = Date.UTC(2026, 9, 4, 15); await run("setWeekFocus('hB')"); // Sunday, after trading
  clock = Date.UTC(2026, 9, 5, 15);
  eq(game().bonuses.filter(b => b.why === 'focus habit').length, 0, 'picked Sunday after trading: nothing back to Monday');
});

console.log('\nX8 · badges count distinct things');
t('Goal getter: 24 recycled check-in goals count once; a goal already met can’t be set', () => {
  const goals = Array.from({ length: 24 }, (_, i) => ({ id: 'g' + i, kind: 'checkin', target: 10, month: '2026-09', done: Date.UTC(2026, 8, 15, 10, i), cleared: 1 }));
  eq(ctx.pzGoalKeys(goals), ['2026-09-15']);
  eq(ctx.pzGoalKeys([...goals, { kind: 'checkin', month: '2026-10', done: Date.UTC(2026, 9, 2) }, { kind: 'noslip', slip: 'revenge', done: Date.UTC(2026, 9, 3) },
    { kind: 'noslip', slip: 'sizeUp', done: Date.UTC(2026, 9, 3) }, { kind: 'disc', month: '2026-09', done: Date.UTC(2026, 9, 1), dropped: 1 }]).length, 4, 'other months and kinds count; a dropped one doesn’t');
  // the audit's repro: ten check-ins backfilled with no trading at all
  const J = {}; for (let d = 1; d <= 10; d++) J['day:2026-09-' + String(d).padStart(2, '0')] = { sleep: 3 };
  ctx.journal = J; clock = Date.UTC(2026, 8, 15, 12);
  eq(ctx.pzGoalMet({ kind: 'checkin', target: 10, month: '2026-09', start: '2026-09-15' }, { days: [], ctx: { closed: [] } }), true);
  eq(ctx.pzGoalMet({ kind: 'checkin', target: 15, month: '2026-09', start: '2026-09-15' }, { days: [], ctx: { closed: [] } }), false);
  const save = html.slice(html.indexOf("if(t.id==='pzGsave'&&pzS.goalNew)"), html.indexOf("if(t.id==='pzLadd')"));
  ok(save.includes("if(pzGoalMet(go,gameContext())){ pzNote("), 'setting it is refused');
  ok(save.includes('settings.pzGoals=all.filter(x=>(x.done&&!x.dropped)||rest.has(x))'), 'the 40-goal cap never drops a reached goal (X9)');
});
t('Toolbox: distinct habits adopted, retired ones included; twelve home-written habits count as one', () => {
  const own = Array.from({ length: 12 }, (_, i) => ({ id: 'o' + i, kind: 'self', when: 'w' + i, then: 'x', createdAt: Date.UTC(2026, 8, 1 + i), retired: true }));
  eq(ctx.pzAdoptKeys(own), ['2026-09-01']);
  const lib = [{ tpl: 'cool-off', kind: 'avoid', pid: 'st:loss1h', createdAt: Date.UTC(2026, 8, 5), retired: true, retiredAt: 1 }, { tpl: 'cool-off', kind: 'avoid', pid: 'st:loss1h', createdAt: Date.UTC(2026, 8, 9) },
    { kind: 'slip', slip: 'revenge', createdAt: Date.UTC(2026, 8, 6) }, { kind: 'slip', slip: 'revenge', createdAt: Date.UTC(2026, 8, 7) }, { kind: 'avoid', pid: 'size:hi', createdAt: Date.UTC(2026, 8, 8) }];
  eq(ctx.pzAdoptKeys([...own, ...lib]).sort(), ['2026-09-01', '2026-09-05', '2026-09-06', '2026-09-08']);
});

console.log('\nX9 · what’s earned stays earned');
t('badges, achievements and challenges go into the ledger once, and a retired habit or a new XP weight doesn’t take them back', () => {
  run("settings={tz:'utc',habits:[{id:'hA',tpl:'journal-all',kind:'process',part:'journal',createdAt:Date.UTC(2026,8,1)}]}"); ctx.journal = {};
  account(range('2026-09-01', 25, { j: 1 })); clock = Date.UTC(2026, 9, 1, 15);
  const g1 = game();
  ok(badge(g1, 'habitdays-5') && badge(g1, 'habitrun-14') && badge(g1, 'adopt-1'), 'habit badges earned');
  ok(g1.achievements.find(a => a.id === 'kept-month').at, 'kept a habit 20 days');
  const E = run('settings.pzEarned');
  eq([E['b:habitdays-5'], E['a:kept-month']], [{ at: '2026-09-05', xp: 5 }, { at: '2026-09-20', xp: 50 }]);
  // retired the old way (no retiredAt): the habit's days are gone from the catalog, the ledger keeps the badges
  run('settings.habits[0].retired=true; PZ_CFG.xp={achievement:100}; PZ_CFG.rev++');
  const g2 = game();
  eq([badge(g2, 'habitdays-5').k, badge(g2, 'habitdays-5').xp, g2.achievements.find(a => a.id === 'kept-month').at], ['2026-09-05', 5, '2026-09-20']);
  eq(g2.bonuses.find(b => b.why === 'Kept it for a month').xp, 50, 'the XP it was earned with, not the new weight');
  eq(g2.xp.total, g1.xp.total, 'the total holds');
  run('PZ_CFG.xp=null; PZ_CFG.rev++');
});
await t('a habit retired now keeps counting for the days it was kept; re-adopting it starts a new copy', async () => {
  run("settings={tz:'utc',habits:[]}"); ctx.journal = {};
  account(range('2026-09-01', 10, { j: 1 })); clock = Date.UTC(2026, 8, 1, 8);
  await run("adoptHabit({tpl:'journal-all',kind:'process',part:'journal',when:'a',then:'b'})");
  clock = Date.UTC(2026, 8, 7, 15); await run("retireHabit(settings.habits[0].id)");
  eq(run('settings.habits[0].retiredAt'), clock);
  clock = Date.UTC(2026, 8, 8, 8); await run("adoptHabit({tpl:'journal-all',kind:'process',part:'journal',when:'a',then:'b'})");
  eq(run('settings.habits.map(h=>[!!h.retired,h.createdAt])'), [[true, Date.UTC(2026, 8, 1, 8)], [false, Date.UTC(2026, 8, 8, 8)]]);
  clock = Date.UTC(2026, 8, 11, 15); fresh();
  const R = run('pzHabitResAll(coachCtx)').map(x => x.res.map(r => r.key));
  eq(R, [['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05', '2026-09-06'], ['2026-09-08', '2026-09-09', '2026-09-10']], 'old copy up to the day it was retired, new one from its adoption');
  eq(game().catalog.families.find(f => f.id === 'habitdays').value, 9, 'both copies count for Habit builder');
  // a retired avoid-habit gets its own predicate (coachContext builds them for active habits only)
  run("settings.habits=[{id:'hX',kind:'avoid',pid:'st:loss1h',createdAt:Date.UTC(2026,8,1),retired:true,retiredAt:Date.UTC(2026,8,4,12)}]");
  eq(run('pzHabitResAll(coachCtx)')[0].res.map(r => r.kept), [true, true, true]);
});
t('a challenge done stays done when the week is graded again; ledger entries merge from both devices and survive a snapshot', () => {
  run("settings={tz:'utc',habits:[]}");
  account(range('2026-09-14', 5, { j: 1 })); clock = Date.UTC(2026, 9, 1, 15);
  ctx.journal = { 'week:2026-W38': { challenge: { spec: { kind: 'process', part: 'journal' }, from: Date.UTC(2026, 8, 14), to: Date.UTC(2026, 8, 21) } } };
  const g1 = game(); eq(g1.challenges[0].status, 'done'); eq(run("settings.pzEarned['c:2026-W38']"), { at: '2026-09-20', xp: 150 });
  ctx.coachCtx.days[2].parts.journal = 0; // a trade un-journaled later: the week re-grades as missed
  const g2 = game(); eq([g2.challenges[0].status, g2.bonuses.filter(b => b.why === 'challenge').length], ['done', 1]);
  eq(ctx._syncMerge('pzEarned', { 'b:x-1': { at: '2026-09-01', xp: 5 } }, { 'b:y-1': { at: '2026-09-02', xp: 5 }, 'b:x-1': { at: '2026-09-09', xp: 9 } }),
    { 'b:y-1': { at: '2026-09-02', xp: 5 }, 'b:x-1': { at: '2026-09-01', xp: 5 } });
  const core = grabFn('applySnapshot');
  ok(core.includes("settings.pzEarned=_syncMerge('pzEarned',settings.pzEarned,data.settings.pzEarned)"), 'a snapshot adds to the ledger, never replaces it');
  ok(grabFn('snapshot').includes('pzEarned:settings.pzEarned') && /const _SYNC_S_FIELDS=\[[^\]]*'pzEarned'/.test(html), 'synced and backed up');
});
t('only the whole account writes the ledger: a per-market view could earn what the account didn’t', () => {
  run("settings={tz:'utc',habits:[{id:'hA',tpl:'journal-all',kind:'process',part:'journal',createdAt:Date.UTC(2026,8,1)}]}"); ctx.journal = {};
  account(range('2026-09-01', 6, { j: 1 }));
  ctx.allTrades = [...ctx.allTrades, { id: 'other', openTime: 0, closeTime: 1, net: -5 }];
  game(); eq(run('settings.pzEarned'), undefined);
  ctx.allTrades = ctx.allTrades.slice(0, -1); game(); ok(run("settings.pzEarned['b:habitdays-5']"));
});

t('a reset empties the ledger and the next computation earns it again from the trades; awards from before it stay ignored after a merge', () => {
  run("settings={tz:'utc',habits:[{id:'hA',tpl:'journal-all',kind:'process',part:'journal',createdAt:Date.UTC(2026,8,1)}]}"); ctx.journal = {};
  account(range('2026-09-01', 25, { j: 1 })); clock = Date.UTC(2026, 9, 1, 15);
  const g1 = game(), before = run('JSON.parse(JSON.stringify(settings.pzEarned))');
  run("settings.pzEarned['b:fake-1']={at:'2026-09-02',xp:900}; settings.pzEarnedResetAt=Date.UTC(2026,9,1,15)"); // polluted, then reset
  const g2 = game(), E = run('settings.pzEarned');
  eq(Object.keys(E).sort(), Object.keys(before).sort(), 'everything the trades earn is back, the fake award is gone');
  ok(Object.values(E).every(e => e.ep === clock), 'stamped with the reset');
  eq(g2.xp.total, g1.xp.total);
  run("settings.pzEarned=_syncMerge('pzEarned',settings.pzEarned,{'b:fake-1':{at:'2026-09-02',xp:900},'b:habitdays-5':{at:'2026-09-05',xp:5}})"); // a device that never saw the reset
  eq(game().xp.total, g1.xp.total, 'its old awards don’t count');
});

console.log('\nX14 · mentoring stays out of league XP');
t('Teacher badges and an XP badge reached only with mentoring XP are mentoring XP: in the level, not in xpBase', () => {
  run("settings={tz:'utc',habits:[]}"); ctx.journal = {};
  account(range('2026-09-01', 10, { disc: 80 })); clock = Date.UTC(2026, 9, 1, 15); // 800 XP from trading
  ctx.SOC = { me: { mentor: true, mentorXp: { total: 300, days: { '2026-09-20': { xp: 300, r: 10, o: 1 } } } }, cache: {} };
  const g = game();
  const xp1k = badge(g, 'xp-1000'), teach = badge(g, 'teacher-10'), helped = badge(g, 'helped-1'), days10 = badge(g, 'days-10');
  eq([xp1k && xp1k.src, teach && teach.src, helped && helped.src, days10 && days10.src], ['mentor', 'mentor', 'mentor', undefined]);
  const mentorXp = g.bonuses.filter(b => b.src === 'mentor').reduce((a, b) => a + b.xp, 0);
  eq(g.xp.total - g.xpBase.total, mentorXp, 'xpBase is the total without any mentoring XP');
  ok(mentorXp > 300, 'the mentoring badges are part of it');
  eq(run("settings.pzEarned['b:xp-1000'].src"), 'mentor', 'and the ledger keeps the tag');
  ctx.SOC = { me: null, cache: {} };
});

console.log('\nX17 · the week’s breakdown adds up');
t('with a Trader Age multiplier the rows sum to “+N this week”, the multiplier’s share on a row of its own', () => {
  run("settings={tz:'utc',habits:[]}"); ctx.journal = {};
  account(range('2026-09-28', 4, { disc: 77 })); clock = Date.UTC(2026, 9, 1, 15);
  ctx.SOC = { me: { mult: { hist: { '2026-W40': 1.5 } } }, cache: {} };
  const g = game(), src = ctx.pzXpSources(g, '2026-09-28');
  eq(Object.values(src).reduce((a, v) => a + v, 0), g.weekXp);
  ok(src.mult > 0 && src.mult === g.weekXp - Object.entries(src).filter(([k]) => k !== 'mult').reduce((a, [, v]) => a + v, 0));
  ok(grabFn('pzProgressHtml').includes("['mult','Trader Age multiplier',PZ_COL.xp]"), 'shown');
  ctx.SOC = { me: null, cache: {} };
});

console.log('\nD8 · the duel screen offers only stakes the server takes');
t('on a measure the apps report, stakes stop at selfMax; the prize names the monthly limit between two members', () => {
  const src = grabFn('socDuelNewHtml');
  ok(src.includes("selfRep=!((verifiable&&st.verified)||st.type==='ret'), selfMax=selfRep?((d.pots&&d.pots.selfMax!=null)?d.pots.selfMax:100):Infinity"));
  ok(src.includes('theirRoom==null?Infinity:theirRoom,selfMax);'), 'stakeMax applies it, as the group duel screen does');
  ctx.SOC = { me: null, cache: { duels: { d: { xp: 100, pots: { pairCapMonth: 1000 } } } } };
  ok(ctx.duelPrize({ stake: 250 }).includes('up to what’s left of the 1000 XP that can move between you two in a month'));
  ctx.SOC.cache.duels.d.pots = { pairCapMonth: 0 }; ok(!ctx.duelPrize({ stake: 250 }).includes('month'), 'no limit set: nothing to say');
  ctx.SOC.cache.duels.d.pots = {}; ok(ctx.duelPrize({ stake: 250 }).includes('monthly limit'), 'limit unknown: said in general');
  eq(ctx.duelPrize({ stake: 0 }), 'Winner gets +100 XP.');
  ctx.SOC = { me: null, cache: {} };
});

report('xp rules');
