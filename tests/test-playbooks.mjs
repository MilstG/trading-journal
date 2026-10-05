// Playbooks: a setup's written rules, ticked per trade, and what keeping them is worth.
// Pure functions extracted from the app (app-source.js), pinned against hand-computed values.
import { t, ok, eq, near, report, makeExtractor } from './harness.mjs';
import { readAppSource } from '../app-source.js';

const html = readAppSource(new URL('../ledger.html', import.meta.url).pathname);
const { evalModule, grabFn } = makeExtractor(html);
const P = await evalModule(['pbNorm', 'pbKey', 'pbNames', 'playbookFor', 'pbAliasesFromText', 'pbRR', 'pbRulesFromText', 'pbGrade', 'playbookStats', 'pbGap', 'pbGapRange', 'pbNearSetups', 'pbTradeGrades', 'pbSummary', 'pbSummaryText', 'pbTickWords'], null,
  'let _be = 1; const isWin = n => n > _be, isLoss = n => n < -_be; const PB_ALIAS_MAX = 6, PB_TREND_N = 10;');

const BO = { id: 'pb1', name: 'Breakout retest', rules: [{ id: 'a', text: 'Wait for the retest' }, { id: 'b', text: 'Stop under the range' }], at: 1 };

console.log('\nPlaybooks: data');
t('normalizing drops junk, trims, caps rules, and keeps tombstones only when asked', () => {
  const raw = [BO, { id: 'x', name: '  ' }, null, { id: 'pb1', name: 'dup' }, { id: 'gone', del: true, at: 5 },
    { id: 'big', name: 'Big', rules: Array.from({ length: 20 }, (_, i) => ({ id: 'r' + i, text: 'rule ' + i })) }];
  eq(P.pbNorm(raw).map(p => p.id), ['pb1', 'big']);
  eq(P.pbNorm(raw)[1].rules.length, 15);
  eq(P.pbNorm(raw, true).map(p => p.id), ['pb1', 'gone', 'big']);
});
t('a trade matches a playbook by setup name, ignoring case and spacing; deleted ones never match', () => {
  eq(P.playbookFor('  breakout   RETEST ', [BO]).id, 'pb1');
  eq(P.playbookFor('breakout', [BO]), null);
  eq(P.playbookFor('', [BO]), null);
  eq(P.playbookFor('Breakout retest', [{ ...BO, del: true }]), null);
});
t('aliases: other spellings of the setup match the playbook; the name itself, blanks and repeats are dropped; six at most', () => {
  eq(P.pbAliasesFromText('breakout, BO retest\n\n Breakout Retest , breakout,  bo  retest ', 'Breakout retest'), ['breakout', 'BO retest']);
  eq(P.pbAliasesFromText('a1,a2,a3,a4,a5,a6,a7', 'x').length, 6);
  const A = { ...BO, aliases: ['breakout', 'bo retest'] };
  eq(P.playbookFor('BREAKOUT', [A]).id, 'pb1'); eq(P.playbookFor('bo   retest', [A]).id, 'pb1'); eq(P.playbookFor('bo', [A]), null);
  eq(P.pbNames(A), ['Breakout retest', 'breakout', 'bo retest']);
  const n = P.pbNorm([{ ...A, aliases: ['Breakout retest', 'breakout', 7, '  '], rr: '2.5' }, { ...BO, id: 'q', rr: 0 }, { ...BO, id: 'z', rr: 99 }]);
  eq([n[0].aliases, n[0].rr, 'rr' in n[1], 'rr' in n[2]], [['breakout'], 2.5, false, false], 'aliases and the target survive normalizing; junk is dropped');
  eq([P.pbRR('2'), P.pbRR(1.234), P.pbRR('x'), P.pbRR(0.05)], [2, 1.23, null, null]);
});
t('rules typed one per line keep the ids of unchanged lines, so earlier ticks still count', () => {
  let n = 0; const mk = () => 'new' + (++n);
  const r = P.pbRulesFromText('- wait for the RETEST\n\n2) Size half on Fridays\n• Stop under the range', BO.rules, mk);
  eq(r, [{ id: 'a', text: 'wait for the RETEST' }, { id: 'new1', text: 'Size half on Fridays' }, { id: 'b', text: 'Stop under the range' }]);
  eq(P.pbRulesFromText('same\nsame', [], mk).map(x => x.id), ['new2', 'new3'], 'a repeated line gets its own id');
});

console.log('\nPlaybooks: what keeping the rules is worth');
const T = (id, net) => ({ id, net, isOpen: false, closeTime: 1 });
const trades = [T('t1', 100), T('t2', 60), T('t3', -80), T('t4', -40), T('t5', 30), T('t6', 10)];
const J = {
  t1: { setup: 'Breakout retest', pb: { id: 'pb1', ok: ['a', 'b'], of: ['a', 'b'] } },
  t2: { setup: 'breakout retest', pb: { id: 'pb1', ok: ['a', 'b'], of: ['a', 'b'] } },
  t3: { setup: 'Breakout retest', pb: { id: 'pb1', ok: ['b'], of: ['a', 'b'] } },          // broke a
  t4: { setup: 'Breakout retest', pb: { id: 'pb1', ok: [], of: ['a', 'b'] } },             // broke both
  t5: { setup: 'Breakout retest' },                                                         // not checked
  t6: { setup: 'Range fade' },                                                              // another setup
};
const R = { t1: 2, t2: 1.2, t3: -1, t4: -0.5 };
const [s] = P.playbookStats(trades, J, [BO], tr => R[tr.id] ?? null);
t('counts the playbook’s trades, the checked ones, and splits kept-every-rule from broke-one', () => {
  eq([s.n, s.checked, s.kept.n, s.broke.n], [5, 4, 2, 2]);
  near(s.kept.exp, 80); near(s.broke.exp, -60); near(s.all.net, 70);
  near(s.kept.avgR, 1.6); near(s.broke.avgR, -0.75);
  eq(s.kept.wr, 1); eq(s.broke.wr, 0);
});
t('per rule: how often it was kept, and the result kept vs broken', () => {
  const [a, b] = s.rules;
  eq([a.graded, a.kept.n, a.broke.n], [4, 2, 2]); near(a.keptRate, 0.5);
  eq([b.graded, b.kept.n, b.broke.n], [4, 3, 1]); near(b.kept.exp, (100 + 60 - 80) / 3); near(b.broke.exp, -40);
});
t('the gap is in R when both sides mostly have R, else in dollars per trade', () => {
  eq(P.pbGap(s.kept, s.broke), { v: 1.6 - -0.75, unit: 'R' });
  const noR = P.playbookStats(trades, J, [BO], () => null)[0];
  eq(P.pbGap(noR.kept, noR.broke), { v: 140, unit: '$' });
  eq(P.pbGap({ n: 0 }, s.broke), null, 'no gap without both sides');
});
t('a rule added after a trade was checked doesn’t grade that trade', () => {
  const BO2 = { ...BO, rules: [...BO.rules, { id: 'c', text: 'No entries in the first 15 minutes' }] };
  const [s2] = P.playbookStats(trades, J, [BO2], () => null);
  eq(s2.rules[2].graded, 0, 'the new rule waits for new checklists');
  eq([s2.kept.n, s2.broke.n], [2, 2], 'old trades that kept every rule on their checklist still count as kept');
});
t('ticks for another playbook (the setup was renamed) are ignored', () => {
  const J2 = { ...J, t1: { setup: 'Breakout retest', pb: { id: 'other', ok: ['a', 'b'] } } };
  eq(P.playbookStats(trades, J2, [BO], () => null)[0].checked, 3);
});
t('a rule marked n/a on a trade is out of that trade’s grading: the trade can still count as kept every rule', () => {
  const g = P.pbGrade({ id: 'pb1', ok: ['b'], of: ['a', 'b'], na: ['a'] }, BO);
  eq(g, { graded: ['b'], broke: [], kept: true, live: false });
  eq(P.pbGrade({ id: 'pb1', ok: [], of: ['a', 'b'], na: ['a'], live: true }, BO), { graded: ['b'], broke: ['b'], kept: false, live: true });
  eq(P.pbGrade({ id: 'other', ok: [] }, BO), null); eq(P.pbGrade(null, BO), null);
  const J3 = { ...J, t3: { setup: 'Breakout retest', pb: { id: 'pb1', ok: ['b'], of: ['a', 'b'], na: ['a'] } } };
  const s3 = P.playbookStats(trades, J3, [BO], () => null)[0];
  eq([s3.kept.n, s3.broke.n, s3.rules[0].graded], [3, 1, 3], 't3 kept every rule that applied; rule a was graded on three trades, not four');
});
t('the rule broken most, how many checklists were ticked before the close, and the adherence trend', () => {
  eq(s.mostBroken, { id: 'a', text: 'Wait for the retest', broke: 2, graded: 4 });
  eq(s.live, 0);
  const JL = { ...J, t1: { ...J.t1, pb: { ...J.t1.pb, live: true } } };
  eq(P.playbookStats(trades, JL, [BO], () => null)[0].live, 1);
  eq(s.trend, { recent: { n: 4, rate: 0.5 }, earlier: { n: 0, rate: null } }, 'fewer than PB_TREND_N checked: everything is recent');
  // 16 checked trades in date order: the first six broke a rule, the last ten kept every one
  const TT = [], JJ = {}; for (let i = 0; i < 16; i++) { TT.push({ id: 'x' + i, net: 10, isOpen: false, closeTime: 1000 + i }); JJ['x' + i] = { setup: 'Breakout retest', pb: { id: 'pb1', ok: i < 6 ? ['a'] : ['a', 'b'], of: ['a', 'b'] } }; }
  const st = P.playbookStats(TT, JJ, [BO], () => null)[0];
  eq(st.trend, { recent: { n: 10, rate: 1 }, earlier: { n: 6, rate: 0 } });
  eq(st.mostBroken, { id: 'b', text: 'Stop under the range', broke: 6, graded: 16 });
});
t('the gap gets a 90% bootstrap range once each side has five trades; it is deterministic and brackets the gap', () => {
  eq(s.range, null, 'two a side: no range yet');
  const TT = [], JJ = {}; for (let i = 0; i < 20; i++) { const kept = i % 2 === 0; TT.push({ id: 'y' + i, net: kept ? 50 + (i % 3) * 10 : -30 + (i % 3) * 5, isOpen: false, closeTime: i }); JJ['y' + i] = { setup: 'Breakout retest', pb: { id: 'pb1', ok: kept ? ['a', 'b'] : ['a'], of: ['a', 'b'] } }; }
  const st = P.playbookStats(TT, JJ, [BO], () => null)[0], g = P.pbGap(st.kept, st.broke);
  ok(st.range && st.range.unit === '$' && st.range.lo <= g.v && g.v <= st.range.hi, 'range in dollars around the gap');
  ok(st.range.lo > 0, 'a clear gap stays above zero');
  eq(P.pbGapRange(st.kept, st.broke), st.range, 'the same on every call');
  const rs = { ...st.kept, rs: st.kept.nets.map(v => v / 10), nR: st.kept.n }, rb = { ...st.broke, rs: st.broke.nets.map(v => v / 10), nR: st.broke.n, avgR: -2 };
  eq(P.pbGapRange({ ...rs, avgR: 6 }, rb).unit, 'R', 'in R when both sides mostly have R');
});
t('setups that look like a playbook but name none are counted, most used first (the alias nudge)', () => {
  const TT = ['breakout', 'Breakout', 'breakout 15m', 'Range fade', 'retest', 'news'].map((s, i) => ({ id: 'n' + i, net: 1, isOpen: false, closeTime: i }));
  const JJ = {}; TT.forEach((t, i) => { JJ[t.id] = { setup: ['breakout', 'Breakout', 'breakout 15m', 'Range fade', 'retest', 'news'][i] }; });
  const near = P.pbNearSetups(TT, JJ, [BO, { id: 'rf', name: 'Range fade', rules: [] }]);
  eq(near, { pb1: [{ setup: 'breakout', n: 2 }, { setup: 'breakout 15m', n: 1 }, { setup: 'retest', n: 1 }] }, 'contained either way or the same first word; news is not it; Range fade names a playbook');
  eq(P.pbNearSetups(TT, JJ, [{ ...BO, aliases: ['breakout'] }]).pb1, [{ setup: 'breakout 15m', n: 1 }, { setup: 'retest', n: 1 }], 'an alias takes its trades out of the nudge');
});
t('the day score and the weekly review read the same grades: which trades were checked, which broke a rule', () => {
  const g = P.pbTradeGrades(trades, J, [BO]);
  eq([[...g.checked].sort(), [...g.broke].sort()], [['t1', 't2', 't3', 't4'], ['t3', 't4']]);
  eq(P.pbTradeGrades(trades, J, []).checked.size, 0);
  const sm = P.pbSummary(trades, J, [BO]);
  eq(sm, { checked: 4, kept: 2, broke: 2, playbooks: 1, mostBroken: { playbook: 'Breakout retest', text: 'Wait for the retest', n: 2 } });
  eq(P.pbSummaryText(sm), '2 of 4 checked trades kept every playbook rule. Broken most: “Wait for the retest” (Breakout retest, 2 times).');
  eq(P.pbSummary(trades, { t6: { setup: 'Range fade' } }, [BO]), null);
  eq(P.pbTickWords(BO, { id: 'pb1', ok: ['a'], of: ['a', 'b'], na: ['b'], live: true }), '1/1 kept · ticked before the close');
  eq(P.pbTickWords(BO, null), 'not checked yet');
});

console.log('\nPlaybooks: wiring');
t('playbooks sync (field-level, merged per playbook) and ride backups', () => {
  ok(html.includes("'pzLessons','pzGoals','playbooks','appearance'];"), 'synced settings field');
  ok(html.includes('playbooks:settings.playbooks,'), 'in snapshots/backups');
  ok(grabFn('_syncMerge').includes("k==='playbooks'"), 'merged by id on a conflict');
  ok(grabFn('journalRow').includes('pbChecklistHtml(t,j)'), 'the checklist shows in the trade journal');
  ok(grabFn('renderReviewInner').includes('playbooksSectionHtml()'), 'the Review tab shows the section');
  ok(grabFn('processDays').includes('parts.playbook='), 'a day with checked playbook trades is scored on the rules it kept');
  ok(html.includes('journal:20,playbook:10}'), 'the part has a weight');
  ok(grabFn('processContext').includes('pbTradeGrades(closed,journal,pbList())'), 'the game grades from the journal’s ticks');
  ok(grabFn('weeklyReviewSectionHtml').includes('pbSummary(closed,journal,pbList())'), 'the weekly review shows the week’s adherence');
  ok(grabFn('coachLetterFacts').includes('pbSummary(inWk,journal,pbList())'), 'the coach’s letter hears about it');
  ok(grabFn('pzCoachFacts').includes('playbooks:'), 'the coach’s facts carry the playbooks');
  ok(grabFn('pbChecklistHtml').includes('data-pbna='), 'n/a on a rule in the journal');
  ok(grabFn('pzPbCheckHtml').includes('data-pz-pbna='), 'and on Daruma’s card');
  ok(grabFn('pbSaveTicks').includes('t.isOpen') && grabFn('pzSaveJournal').includes('t.isOpen'), 'ticks on an open trade are marked live');
  ok(grabFn('planAttachPending').includes('live:true'), 'a plan’s checklist becomes the trade’s, marked live');
  ok(grabFn('planPzHtml').includes('data-pz-plpb') && grabFn('planPzFillTarget').includes('p.rr'), 'Plan a trade shows the checklist and fills the target from the playbook’s reward-to-risk');
  ok(grabFn('pzPlanCheck').includes('wantPb'), '“Only my setups” counts an alias of a chosen playbook as within');
});

report('playbooks');
