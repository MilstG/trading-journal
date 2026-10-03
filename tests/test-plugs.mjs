// Plugging a leak (Pulse → Progress): the clean-week run, the "plugged" badge, plugging again,
// and how plugs merge between devices. The real functions run in a sandbox with a fixed clock
// (Thu 2026-10-01, ISO week 40) and hand-built slip days.
import vm from 'node:vm';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { t, ok, eq, report, makeExtractor } from './harness.mjs';
import { readAppSource } from '../app-source.js';

const here = dirname(fileURLToPath(import.meta.url));
const html = readAppSource(join(here, '..', 'ledger.html'));
const { grabFn } = makeExtractor(html);
const grabConst = name => { const i = html.indexOf('const ' + name + '='); if (i < 0) throw new Error(name); return html.slice(i, html.indexOf(';\n', i) + 1); };

const NOW = Date.UTC(2026, 9, 1, 15);
class FDate extends Date { constructor(...a) { if (!a.length) super(NOW); else super(...a); } static now() { return NOW; } }
const ctx = vm.createContext({ Date: FDate, Math, console, Set, Map, Object, JSON, Array, String, Promise, isFinite, Infinity, setTimeout,
  S_KEY: 's', J_KEY: 'j', rawSet: async () => {}, allTrades: [], viewFilter: () => true, Store: { async set() {} },
  dayKey: ms => new Date(ms).toISOString().slice(0, 10), isoWeekKey: () => 'week:x', markJEdit() {}, pbNorm: a => a || [] });
const FNS = ['isoWeekOfKey', 'isoWeekMondayKey', 'pzPlugState', 'pzPlugWeekNote', 'pzPlugs', 'pzPlugStart', 'pzPlugDrop', 'pzLeakMap', 'adoptHabit', 'retireHabit',
  'habitById', '_syncMerge', 'pzLessonsNorm', 'weekFocus', 'setWeekFocus', 'pzSwapStartKey', 'pzPluggedKeys'];
vm.runInContext(['PZ_BEH', 'PZ_PLUG', 'pzAddDays'].map(grabConst).join('\n') + '\nvar settings={}, journal={}, _pzSlipDays=new Map();\n' + FNS.map(grabFn).join('\n'), ctx);
const run = c => vm.runInContext(c, ctx);
// slip days: {day: [[net, ...flags], ...]}
const days = o => { ctx.__d = new Map(Object.entries(o).sort().map(([k, sl]) => [k, { key: k, slips: sl.map(([net, ...f], i) => ({ id: k + i, net, f })) }]));
  run('_pzSlipDays=__d'); };
const state = from => { const s = run(`pzPlugState({slip:'revenge',from:'${from}'})`); return { cleanRun: s.cleanRun, done: s.done, back: s.back }; };

console.log('\nThe clean-week run');
t('three clean trading weeks plug it, done on the third Sunday', () => {
  days({ '2026-09-01': [], '2026-09-02': [], '2026-09-08': [], '2026-09-09': [], '2026-09-15': [], '2026-09-16': [] });
  eq(state('2026-09-01'), { cleanRun: 3, done: '2026-09-20', back: false });
});
t('a slip resets the run even in a week with a single trading day', () => {
  days({ '2026-09-01': [], '2026-09-02': [], '2026-09-09': [[-400, 'revenge']], '2026-09-15': [], '2026-09-16': [], '2026-09-22': [], '2026-09-23': [] });
  eq(state('2026-09-01'), { cleanRun: 2, done: null, back: false });
});
t('any week you traded in counts, even a single day', () => {
  days({ '2026-09-01': [], '2026-09-09': [], '2026-09-17': [] });
  eq(state('2026-09-01'), { cleanRun: 3, done: '2026-09-20', back: false });
});
t('weeks with no trading are skipped: they neither count nor break the run', () => {
  days({ '2026-09-01': [], '2026-09-15': [], '2026-09-29': [] }); // traded W36 and W38; W37 idle; W40 is this week
  eq(state('2026-09-01'), { cleanRun: 2, done: null, back: false });
  days({ '2026-08-04': [], '2026-09-15': [], '2026-09-22': [] }); // a month off between the first and second
  eq(state('2026-08-01'), { cleanRun: 3, done: '2026-09-27', back: false });
});
t('this week with no trades yet says so, not "clean"', () => {
  const note = (from, d) => { days(d); return run(`pzPlugWeekNote(Object.assign({from:'${from}'},pzPlugState({slip:'revenge',from:'${from}'})))`); };
  eq(note('2026-09-21', { '2026-09-22': [] }), 'no trades yet this week');
  eq(note('2026-10-01', { '2026-09-29': [] }), 'no trades since you started', 'plugged mid-week after trading earlier that week');
  eq(note('2026-09-21', { '2026-09-29': [] }), 'clean this week');
  eq(note('2026-09-21', { '2026-09-29': [[-5, 'revenge'], [-6, 'revenge']] }), '2 slips this week');
  eq((html.match(/pzPlugWeekNote\(p\)/g) || []).length, 4, 'defined once; the leak card, Today and the nudge all use it');
});
t('the week in progress shows but doesn’t count yet; another slip type is not this leak', () => {
  days({ '2026-09-22': [[-10, 'sizeUp']], '2026-09-23': [], '2026-09-29': [[-50, 'revenge']], '2026-09-30': [] });
  const s = run(`pzPlugState({slip:'revenge',from:'2026-09-21'})`);
  eq([s.cleanRun, s.thisWeek.count], [1, 1]);
});
t('a leak that comes back after it was plugged says so', () => {
  days({ '2026-09-01': [], '2026-09-02': [], '2026-09-08': [], '2026-09-09': [], '2026-09-15': [], '2026-09-16': [], '2026-09-22': [[-80, 'revenge']] });
  eq(state('2026-09-01').back, true);
});

console.log('\nPlugging, stopping, plugging again');
await t('a plug makes one habit; plugging again after it was plugged starts a new habit, and the old one keeps its days (audit 4 X9)', async () => {
  run('settings={}');
  days({ '2026-09-01': [], '2026-09-02': [], '2026-09-08': [], '2026-09-09': [], '2026-09-15': [], '2026-09-16': [] });
  ctx.__p = run(`pzPlugStart('revenge')`); await ctx.__p;
  run(`settings.pzPlugs[0].from='2026-09-01'; settings.habits[0].createdAt=Date.UTC(2026,8,1)`);
  await run(`pzPlugStart('revenge')`); // the first one is done: a new plug
  const s = run('settings');
  eq(s.pzPlugs.length, 2); eq(s.habits.length, 2, 'a new copy: reviving the old one reset its history');
  eq([s.habits[0].retired, s.habits[0].createdAt, s.habits[0].retiredAt], [true, Date.UTC(2026, 8, 1), NOW], 'the old one keeps its start and says when it stopped');
  eq([!!s.habits[1].retired, s.habits[1].createdAt], [false, NOW], 'the new one counts from the new plug');
  eq(s.pzPlugs[1].habitId, s.habits[1].id);
  await run(`pzPlugStart('revenge')`); eq(run('settings.pzPlugs.length'), 2, 'starting twice is a no-op');
  eq(run('settings.habits.length'), 2, 'and adopting a habit you keep is a no-op');
});
await t('the badge counts done plugs once each, and never a stopped one', async () => {
  days({ '2026-09-01': [], '2026-09-02': [], '2026-09-08': [], '2026-09-09': [], '2026-09-15': [], '2026-09-16': [] });
  run(`settings={pzPlugs:[{slip:'revenge',from:'2026-09-01',dropped:true},{slip:'revenge',from:'2026-09-01'},{slip:'revenge',from:'2026-09-01'},{slip:'sizeUp',from:'2026-09-01'}]}`);
  ok(grabFn('pzBadgeCatalog').includes("add('plugged',pzPluggedKeys(pzPlugs()))"), 'pzBadgeCatalog counts with pzPluggedKeys');
  const f = run(`pzPlugs().filter(p=>p.done&&!p.dropped)`); eq(f.length, 3);
  eq(run('pzPluggedKeys(pzPlugs())').sort(), ['2026-09-20', '2026-09-20']);
});
t('re-plugging the same leak later doesn’t count again: one leak counts once (audit 4 X8)', () => {
  days({ '2026-09-01': [], '2026-09-02': [], '2026-09-08': [], '2026-09-09': [], '2026-09-15': [], '2026-09-16': [], '2026-09-22': [] });
  // plugged, came back, plugged again from a later start: two done plugs of one leak (keyed slip|done they were two)
  run(`settings={pzPlugs:[{slip:'revenge',from:'2026-09-01'},{slip:'revenge',from:'2026-09-07'},{slip:'sizeUp',from:'2026-09-07',dropped:true}]}`);
  const done = run(`pzPlugs().filter(p=>p.done&&!p.dropped).map(p=>p.done)`); eq(done, ['2026-09-20', '2026-09-27']);
  eq(run('pzPluggedKeys(pzPlugs())'), ['2026-09-20'], 'the first time it was plugged');
  eq(ctx.pzPluggedKeys([{ slip: 'revenge', done: '2026-09-27' }, { slip: 'revenge', done: '2026-09-20' }, { slip: 'afterTwo', done: '2026-09-27' }]), ['2026-09-20', '2026-09-27']);
});

console.log('\nTwo devices');
t('plugs merge by leak and start day; a stop on either device sticks', () => {
  const mine = [{ slip: 'revenge', from: '2026-09-01', habitId: 'hA', at: 1 }];
  const theirs = [{ slip: 'sizeUp', from: '2026-09-02', habitId: 'hB', at: 2 }, { slip: 'revenge', from: '2026-09-01', habitId: 'hA', at: 0, dropped: true }];
  const m = ctx._syncMerge('pzPlugs', mine, theirs);
  eq(m.map(p => [p.slip, !!p.dropped]), [['revenge', true], ['sizeUp', false]]);
});
t('habits merge by id, so a plug’s habit from the other device isn’t orphaned', () => {
  const m = ctx._syncMerge('habits', [{ id: 'hB', when: 'x', then: 'mine' }], [{ id: 'hA', when: 'y', then: 'z' }, { id: 'hB', when: 'x', then: 'theirs' }]);
  eq(m.map(h => h.id + ':' + h.then).sort(), ['hA:z', 'hB:mine']);
});

console.log('\nThe leak map');
t('the 30-day window is 30 calendar days and the 30 before it', () => {
  const g = { days: [{ key: '2026-09-02', behavior: { slips: [{ net: -10, f: ['revenge'] }] } }, { key: '2026-09-01', behavior: { slips: [{ net: -20, f: ['revenge'] }] } },
    { key: '2026-08-03', behavior: { slips: [{ net: -5, f: ['revenge'] }] } }, { key: '2026-08-02', behavior: { slips: [{ net: -7, f: ['revenge'] }] } }] };
  run('settings={}');
  const r = ctx.pzLeakMap(g, 30).find(x => x.slip === 'revenge');
  eq([r.n, r.cost, r.prevN, r.prevCost], [1, -10, 2, -25]);
});

report('plugs');
