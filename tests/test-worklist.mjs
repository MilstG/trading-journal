// Your work list (app/features/worklist.js): every source onto one key with one figure and one rank (wlCollect),
// what you did about each from plugs and settings.pzWork (wlResolve), and the check on what you're working on
// (wlSlipCheck / wlSlipVerdict for a slip being plugged, wlTrendVerdict for the rest).
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { t, ok, eq, near, report, makeExtractor } from './harness.mjs';

const require = createRequire(import.meta.url);
const { readAppSource } = require('../app-source.js');
const { evalModule } = makeExtractor(readAppSource(new URL('../ledger.html', import.meta.url).pathname));
// the feature's one-line consts, read from the file itself so the suite can't drift from them
const wlSrc = readFileSync(new URL('../app/features/worklist.js', import.meta.url), 'utf8');
const consts = wlSrc.split('\n').filter(l => /^const (WL_[A-Z_]+|wlR|wlPc|wlMo)\b/.test(l)).join('\n');
const prelude = consts + `
const usdPlain=x=>'$'+Math.round(Math.abs(x)); const signedPlain=x=>(x<0?'−':'+')+usdPlain(x);
const pzPlain=t=>String(t||'').replace(/\\s*\\([^)]*→[^)]*\\)/g,'');
const _normCdf=z=>0.5*(1+_erf(z/Math.SQRT2)); const PZ_BEH={revenge:'Entered within 15 minutes of a loss',sizeUp:'Sized up right after a loss',addLoser:'Added to a losing position',afterTwo:'Kept trading after two losses in a row'};`;
const W = await evalModule(['wlCollect', 'wlResolve', 'wlSlipCheck', 'wlSlipVerdict', 'wlTrendVerdict', 'rfSlipSets', 'ruleFollowThrough', '_erf', 'nfMedian', 'hasAdd'],
  ['wlCollect', 'wlResolve', 'wlSlipCheck', 'wlSlipVerdict', 'wlTrendVerdict'], prelude);
const DAY = 86400000, NOW = Date.parse('2026-10-07T12:00:00Z');

const BEH = { revenge: 'Entered within 15 minutes of a loss', sizeUp: 'Sized up right after a loss', addLoser: 'Added to a losing position', afterTwo: 'Kept trading after two losses in a row' };
const PLUG = { revenge: { when: 'I close a losing trade', then: 'I wait 15 minutes before the next entry' } };
const input = () => ({
  span: 90, beh: BEH, plug: PLUG,
  slips: { unit: 100, slips: {
    revenge: { n: 14, chances: 45, R: -0.7, lo: -1.2, hi: -0.2, sure: true, usd: -70, slipped: -0.9 },
    sizeUp: { n: 5, chances: 20, R: -1.5, lo: -3, hi: 0.5, sure: false, usd: -150, slipped: -1.6 },
    addLoser: { n: 4, chances: 9, R: 0.4, lo: -0.2, hi: 1, sure: false, usd: 40, slipped: 0.1 },
    afterTwo: { n: 2, chances: 10, R: null } } },
  findings: [
    { id: 'tilt', tone: 'leak', title: 'You trade worse right after a loss', body: 'Within an hour of a loss (Diagnostic → Rules).', conf: 'likely', usd: -500 },
    { id: 'worst-bucket', tone: 'leak', title: 'Trades opened 22:00 lose money', body: 'b', action: 'Stop taking these.', conf: 'likely', n: 26, usd: -900, dim: 'hour', bkey: '22' },
    { id: 'best-bucket', tone: 'edge', title: 'BTC shorts are your best', body: 'b', action: 'Wait for these.', conf: 'strong', n: 38, usd: 1200, dim: 'market', bkey: 'BTC' },
    { id: 'oversizing', tone: 'leak', title: 'Your biggest trades are your worst', body: 'b', action: 'a', conf: 'early', n: 9, usd: -300, habit: { tpl: 'size-cap' } },
    { id: 'fees', tone: 'leak', title: 'Fees eat 40%', conf: 'strong', impact: 900 },
    { id: 'drawdown', tone: 'caution', title: 'Your worst stretch', conf: 'strong', impact: 400 },
    { id: 'mistakes', tone: 'leak', title: 'Flagged mistakes', conf: 'early', usd: null }],
  fees: { saveAsMaker30: 60, takerN30: 9e5, makerN30: 1e5, unk30: 0 },
  leak30: [{ slip: 'revenge', n: 6, cost: -820 }],
  group: { revenge: { R: -0.5, sure: true, wallets: 140 } } });

t('every source onto one key: slips, the coach findings with a dollar gap, taker fees', () => {
  const by = Object.fromEntries(W.wlCollect(input()).map(x => [x.key, x]));
  eq(Object.keys(by).sort(), ['bucket:hour=22', 'bucket:market=BTC', 'cost:taker', 'size:big', 'slip:revenge', 'slip:sizeUp']);
  ok(!by['slip:addLoser'], 'a slip that went better than not slipping is no leak');
  ok(!by['slip:afterTwo'], 'no figure of your own (too few chances): not on the list');
  ok(!by.mistakes && !by.fees && !by.drawdown, 'findings without an honest dollar gap stay in the Diagnostic');
});
t('one figure: dollars a month over the window, a slip measured like-for-like', () => {
  const by = Object.fromEntries(W.wlCollect(input()).map(x => [x.key, x]));
  near(by['slip:revenge'].month, -0.7 * 100 * 14 * 30.44 / 90, 1e-9);
  near(by['bucket:hour=22'].month, -900 * 30.44 / 90, 1e-9);
  eq(by['cost:taker'].month, -60, 'fees are already a month');
  near(W.wlCollect(Object.assign(input(), { span: 30 }))[0].month, -0.7 * 100 * 14 * 30.44 / 30, 1e-9, 'a shorter history scales up');
  eq(by['slip:revenge'].action, 'When I close a losing trade, I wait 15 minutes before the next entry.');
});
t('confidence: a sure slip is probably real, very likely from 20; an unsure one is an early signal', () => {
  const by = Object.fromEntries(W.wlCollect(input()).map(x => [x.key, x]));
  eq([by['slip:revenge'].conf, by['slip:sizeUp'].conf, by['size:big'].conf, by['cost:taker'].conf], ['likely', 'early', 'early', 'strong']);
  const I = input(); I.slips.slips.revenge.n = 25; eq(W.wlCollect(I).find(x => x.key === 'slip:revenge').conf, 'strong');
});
t('the rank: $ a month × how sure × how much is in your hands; early signals rank 0', () => {
  const by = Object.fromEntries(W.wlCollect(input()).map(x => [x.key, x]));
  near(by['slip:revenge'].rank, Math.abs(by['slip:revenge'].month) * 0.7 * 1, 1e-9);
  near(by['bucket:hour=22'].rank, Math.abs(by['bucket:hour=22'].month) * 0.7 * 0.8, 1e-9);
  near(by['cost:taker'].rank, 60 * 1 * 0.9, 1e-9);
  eq(by['slip:sizeUp'].rank, 0);
});
t('the same problem counted another way goes on the item’s page, not a second item', () => {
  const r = W.wlCollect(input()).find(x => x.key === 'slip:revenge');
  eq(r.other.map(o => o[0]), ['Those trades’ whole result', 'Your leaks on Progress', 'Traders in your league', 'The coach’s finding']);
  eq(r.other[3][2], 'Within an hour of a loss.', 'the Diagnostic’s menu path is dropped');
  eq(W.wlCollect({ span: 90, beh: BEH, findings: [input().findings[0]] }), [], 'no slip item: the tilt finding alone adds nothing');
});

console.log('\nWhat you did about each');
const items = () => W.wlCollect(input());
t('nothing done yet: ranked leaks up next, early signals watching, edges kept', () => {
  const R = W.wlResolve(items(), {}, [], NOW);
  eq(R.next.map(x => x.key), ['slip:revenge', 'bucket:hour=22', 'cost:taker']);
  eq(R.watching.map(x => x.key), ['slip:sizeUp', 'size:big'], 'costliest first');
  eq(R.keep.map(x => x.key), ['bucket:market=BTC']); eq([R.working, R.fixed, R.snoozed], [[], [], []]);
});
t('a live plug is working on it; a plug that held is fixed; one that came back is back on the list', () => {
  const at = NOW - 10 * DAY;
  let R = W.wlResolve(items(), {}, [{ slip: 'revenge', from: '2026-09-27', at, done: null, back: false, cleanRun: 1 }], NOW);
  eq([R.working.map(x => [x.key, x.since]), R.next[0].key], [[['slip:revenge', at]], 'bucket:hour=22']);
  R = W.wlResolve(items(), {}, [{ slip: 'revenge', from: '2026-08-01', done: '2026-08-31', back: false }], NOW);
  eq([R.fixed.map(x => x.key), R.next.some(x => x.key === 'slip:revenge')], [['slip:revenge'], false]);
  R = W.wlResolve(items(), {}, [{ slip: 'revenge', from: '2026-08-01', done: '2026-08-31', back: true }], NOW);
  ok(R.next[0].key === 'slip:revenge' && R.next[0].back, 'it’s back');
  R = W.wlResolve(items(), {}, [{ slip: 'revenge', from: '2026-08-01', done: null, dropped: true }], NOW);
  ok(R.next[0].key === 'slip:revenge' && !R.working.length, 'a dropped plug is no plug');
});
t('plugs and items started here that dropped off the 90 days still show, from their records', () => {
  const R = W.wlResolve(items(), { on: { 'bucket:hour=03': { at: NOW - 30 * DAY, month: -200, title: 'Trades opened 03:00' } }, fixed: { mistakes: { at: NOW - 5 * DAY, title: 'Flagged mistakes' } } },
    [{ slip: 'addLoser', from: '2026-09-01', at: NOW - 36 * DAY, done: null }, { slip: 'afterTwo', from: '2026-07-01', done: '2026-08-02', back: false }], NOW);
  eq(R.working.map(x => [x.key, x.gone, x.title]), [['slip:addLoser', true, 'Added to a losing position'], ['bucket:hour=03', true, 'Trades opened 03:00']]);
  eq(R.fixed.map(x => x.key), ['mistakes', 'slip:afterTwo'], 'latest first');
});
t('not now: two weeks, or back sooner once it grows by half', () => {
  const st = { snooze: { 'bucket:hour=22': { until: NOW + 5 * DAY, month: -300 } } };
  let R = W.wlResolve(items(), st, [], NOW); eq(R.snoozed.map(x => x.key), ['bucket:hour=22']); ok(!R.next.some(x => x.key === 'bucket:hour=22'));
  R = W.wlResolve(items(), st, [], NOW + 6 * DAY); ok(R.next.some(x => x.key === 'bucket:hour=22'), 'the two weeks are up');
  R = W.wlResolve(items(), { snooze: { 'bucket:hour=22': { until: NOW + 5 * DAY, month: -150 } } }, [], NOW); ok(R.next.some(x => x.key === 'bucket:hour=22'), 'doubled since: back');
});
t('fixed stays fixed unless it’s sure again at half the size it had when you started', () => {
  const big = items(), b = big.find(x => x.key === 'bucket:hour=22');
  let R = W.wlResolve(big, { fixed: { 'bucket:hour=22': { at: NOW, month: -50, base: -1000 } } }, [], NOW);
  ok(R.fixed.some(x => x.key === 'bucket:hour=22'), Math.round(b.month) + ' is under half of 1000');
  R = W.wlResolve(big, { fixed: { 'bucket:hour=22': { at: NOW, month: -50, base: -400 } } }, [], NOW);
  ok(R.next.find(x => x.key === 'bucket:hour=22').back, 'back');
});

console.log('\nThe check on what you’re working on');
// a trader with a loss then a post-loss entry each day (a revenge chance). Before the start half of them came within
// 15 minutes (a slip) and lost 2 typical trades; since, 1 in 10 did, and the waits went better.
function history(before, after, startDay) {
  const closed = [], bd = [], start = NOW - startDay * DAY;
  const day = (i, slipped, net, s) => { const b = start + i * DAY;
    closed.push({ id: 'l' + i, net: -100, openTime: b, closeTime: b + 3600000 }, { id: 'e' + i, net, openTime: b + 2 * 3600000, closeTime: b + 3 * 3600000 });
    bd.push({ slips: slipped ? [{ id: 'e' + i, f: ['revenge'] }] : [], tests: { revenge: ['e' + i] } }); };
  for (let i = 0; i < before; i++) day(i - before, i % 2 === 0, i % 2 === 0 ? -200 : -50);
  for (let i = 0; i < after; i++) day(i, i % 10 === 0, i % 10 === 0 ? -200 : 30 + (i % 3) * 10);
  return { closed, bd, start };
}
t('kept and paying: slipping less often, and those chances went better beyond the range', () => {
  const H = history(30, 25, 25), v = W.wlSlipCheck(H.closed, H.bd, 'revenge', H.start, { now: NOW });
  eq([v.before.n, v.before.v, v.after.n, v.after.v, v.status], [30, 15, 25, 3, 'working']);
  ok(v.lo > 0, 'range above zero: ' + v.lo);
  const x = W.wlSlipVerdict(v, H.start, NOW); eq([x.state, x.head], ['ok', 'Kept, and paying']);
  ok(/slipped on 3 of 25 chances \(12%\), against 50%/.test(x.lines[0]), x.lines[0]);
});
t('checking until 20 chances or three weeks', () => {
  const H = history(30, 6, 6), v = W.wlSlipCheck(H.closed, H.bd, 'revenge', H.start, { now: NOW });
  const x = W.wlSlipVerdict(v, H.start, NOW); eq(x.state, 'checking'); near(x.pct, 7 / 21, 0.05);
  eq(W.wlSlipVerdict(v, H.start, H.start + 22 * DAY).state === 'checking', false, 'three weeks: a verdict either way');
});
t('not kept: slipping as often as before', () => {
  const H = history(30, 0, 25);
  for (let i = 0; i < 24; i++) { const b = H.start + i * DAY, s = i % 2 === 0;
    H.closed.push({ id: 'l' + i, net: -100, openTime: b, closeTime: b + 3600000 }, { id: 'e' + i, net: s ? -200 : -50, openTime: b + 2 * 3600000, closeTime: b + 3 * 3600000 });
    H.bd.push({ slips: s ? [{ id: 'e' + i, f: ['revenge'] }] : [], tests: { revenge: ['e' + i] } }); }
  const x = W.wlSlipVerdict(W.wlSlipCheck(H.closed, H.bd, 'revenge', H.start, { now: NOW }), H.start, NOW);
  eq([x.state, x.head], ['bad', 'Not kept yet']);
});
t('anything else: the habit’s days, then the 90-day figure against when you started', () => {
  const on = { at: NOW - 10 * DAY, month: -400 };
  let x = W.wlTrendVerdict({ month: -380, on }, { kept: 6, total: 8 }, NOW);
  eq([x.state, x.fix], ['checking', false]); eq(x.lines[0], 'Habit kept on 6 of 8 trading days.');
  on.at = NOW - 30 * DAY;
  x = W.wlTrendVerdict({ month: -380, on }, null, NOW); eq([x.state, x.head, x.fix], ['meh', 'Not shrinking yet', true]);
  x = W.wlTrendVerdict({ month: -150, on }, null, NOW); eq([x.state, x.head], ['ok', 'Shrinking']);
  x = W.wlTrendVerdict({ gone: true, on }, null, NOW); eq(x.state, 'ok'); ok(/no longer shows up/.test(x.lines[0]));
  ok(/last 30 days/.test(W.wlTrendVerdict({ month: -20, win: 30, on }, null, NOW).lines[0]), 'fees are read over 30 days, and say so');
});

report('worklist');
