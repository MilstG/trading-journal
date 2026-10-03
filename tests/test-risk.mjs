// Drawdown rules: a cap on any duel, group duel or competition (out, or a docked score), % return in
// group duels with a minimum of trading days, and a league's money boards with a visible cap instead
// of the old hidden 25% line. Pure functions (duels.js, social.js); the HTTP side is in
// test-league-windows (a league cap over a week) and test-duel-ladder (a group duel's needs).
import { createRequire } from 'node:module';
import { t, ok, eq, near, report } from './harness.mjs';

const require = createRequire(import.meta.url);
const Duels = require('../duels.js');
const S = require('../social.js');

console.log('\nSettings');
t('the owner’s drawdown settings are clamped; unknown modes keep the default', () => {
  const r = Duels.sanitizeRiskCfg(null);
  eq([r.caps, r.duel, r.pod, r.comp, r.league, r.leagueCap, r.penalty, r.minDays], [[10, 15, 20, 25], 'out', 'out', 'out', 'week', 25, 2, 5]);
  const x = Duels.sanitizeRiskCfg({ caps: '30, 5, 5, 99, 1, x', duel: 'penalty', pod: 'nope', league: 'off', leagueCap: 500, penalty: -3, minDays: 3 }, r);
  eq([x.caps, x.duel, x.pod, x.league, x.leagueCap, x.penalty, x.minDays], [[5, 30], 'penalty', 'out', 'off', 90, 0, 3]);
  eq(Duels.sanitizeRiskCfg({ caps: [] }, x).caps, [5, 30], 'an empty list keeps the old one');
  eq(Duels.sanitizeRiskCfg({ league: 'out' }).league, 'week', 'a league is out for its week, not for good');
});
t('one member against a cap: under it nothing happens; over it they’re out, or docked where a score can be', () => {
  eq(Duels.ddCheck({ ret: 0.1, dd: 0.12 }, 0.15, 'out', 'disc'), { dd: 0.12, over: false, out: false, pen: 0 });
  eq(Duels.ddCheck({ ret: 0.1, dd: 0.18 }, 0.15, 'out', 'disc').out, true);
  near(Duels.ddCheck({ ret: 0.1, dd: 0.18 }, 0.15, 'penalty', 'disc', 2).pen, 6, 1e-9, '3% past the cap at 2 points per 1%');
  near(Duels.ddCheck({ ret: 0.1, dd: 0.18 }, 0.15, 'penalty', 'ret', 2).pen, 0.06, 1e-9, 'for % return: 6 percentage points');
  eq(Duels.ddCheck({ ret: 0.1, dd: 0.18 }, 0.15, 'penalty', 'clean', 2).out, true, 'a count of days can’t be docked: out');
  eq(Duels.ddCheck(null, 0.15, 'out', 'disc'), { dd: null, over: false, out: false, pen: 0 }, 'nothing read yet: nothing decided');
});

console.log('\nDuels');
const dd = (type, extra) => Object.assign({ type, start: '2026-10-12', end: '2026-10-18', verified: false, minDays: 3, ddCap: null }, extra);
const mem = (id, scores, extra) => Object.assign({ id, share: {}, stats: { days: scores.map(([k, s]) => ({ k: '2026-10-' + k, s })), xpDays: {} } }, extra);
const A = mem('a', [['12', 95], ['13', 95], ['14', 95]]), B = mem('b', [['12', 80], ['13', 80], ['14', 80]]);
t('terms: a cap on any kind when the league allows it; % return always has one, and now a minimum of trading days', () => {
  eq(Duels.sanitizeTerms({ type: 'disc', ddCap: 0.15 }).ddCap, 0.15);
  eq(Duels.sanitizeTerms({ type: 'disc' }).ddCap, null, 'no cap unless asked for');
  eq(Duels.sanitizeTerms({ type: 'disc', ddCap: 0.15 }, Object.assign(Duels.sanitizeDuelCfg(null), { risk: Duels.sanitizeRiskCfg({ duel: 'off' }) })).ddCap, null, 'switched off: no cap');
  const cfg = Duels.sanitizeDuelCfg({ types: { ret: true } });
  eq([Duels.sanitizeTerms({ type: 'ret' }, cfg).minDays, Duels.sanitizeTerms({ type: 'ret', period: 'month' }, cfg).minDays], [3, 5]);
  eq([Duels.sanitizeTerms({ type: 'ret', ddCap: null }, cfg).ddCap, Duels.sanitizeTerms({ type: 'ret', ddCap: '' }, cfg).ddCap], [0.08, 0.08], 'an empty cap is the default, not 2%');
  eq([Duels.sanitizeTerms({ type: 'disc', ddCap: null }).ddCap, Duels.sanitizeTerms({ type: 'disc', ddCap: 0 }).ddCap], [null, null], 'an empty cap on another kind is no cap');
  const ten = Object.assign({}, cfg, { risk: Duels.sanitizeRiskCfg({ minDays: 10 }) });
  eq([Duels.sanitizeTerms({ type: 'ret', period: 'month' }, ten).minDays, Duels.sanitizeTerms({ type: 'ret' }, ten).minDays], [10, 5], 'the league’s trading days: all of them a month, three fifths a week (at most 5)');
  eq([Duels.retMinDays('week', { minDays: 0 }), Duels.retMinDays('month', { minDays: 40 })], [1, 20]);
  eq(Duels.ddModeFor('duel', Duels.sanitizeRiskCfg({ duel: 'penalty' })), 'penalty');
  eq(Duels.ddModeFor('duel', Duels.sanitizeRiskCfg({ duel: 'off' })), 'out', 'what % return plays by when caps are off elsewhere');
});
t('a Discipline duel with a cap: the better process loses if it blew through the drawdown', () => {
  const d = dd('disc', { ddCap: 0.15, money: { a: { ret: 0.3, dd: 0.21 }, b: { ret: 0.02, dd: 0.04 } } });
  const s = Duels.standing(d, A, B, '2026-10-20');
  eq([s.lead, !!s.a.out, !!s.b.out], ['b', true, false]); ok(/15% drawdown cap/.test(s.why), s.why);
  ok(/Out: drawdown 21.0%/.test(s.a.note), s.a.note);
  eq(Duels.standing(dd('disc', { ddCap: 0.15, money: { a: { ret: 0, dd: 0.2 }, b: { ret: 0, dd: 0.3 } } }), A, B, '2026-10-20').lead, null, 'both out: a draw');
  eq(Duels.standing(dd('disc', { ddCap: 0.15, money: { a: { ret: 0, dd: 0.1 } } }), A, B, '2026-10-20').lead, 'a', 'one side not read yet: the measure decides for now');
});
t('the penalty rule docks Discipline points instead', () => {
  const d = dd('disc', { ddCap: 0.15, ddMode: 'penalty', penalty: 2, money: { a: { ret: 0, dd: 0.21 }, b: { ret: 0, dd: 0.04 } } });
  const s = Duels.standing(d, A, B, '2026-10-20');
  eq([s.a.score, s.lead], [83, 'a'], '95 − 12 points (6% past the cap) still beats 80');
  const d2 = Object.assign({}, d, { money: { a: { ret: 0, dd: 0.25 }, b: { ret: 0, dd: 0.04 } } });
  eq(Duels.standing(d2, A, B, '2026-10-20').lead, 'b', '95 − 20 = 75 loses to 80');
  eq(Duels.standing(Object.assign(dd('clean'), d2, { type: 'clean' }), A, B, '2026-10-20').a.out, true, 'clean days can’t be docked: out');
});
t('% return with a minimum of trading days: sitting flat doesn’t win', () => {
  const quiet = mem('b', [['12', 90]]);
  const d = dd('ret', { ddCap: 0.15, minDays: 3, money: { a: { ret: 0.02, dd: 0.03 }, b: { ret: 0.05, dd: 0.001 } } });
  const s = Duels.standing(d, A, quiet, '2026-10-20');
  eq([s.lead, s.b.n], ['a', 1]); ok(/fewer than 3 days/.test(s.why), s.why);
  eq(Duels.standing(Object.assign({}, d, { minDays: null }), A, quiet, '2026-10-20').lead, 'b', 'a duel from before the minimum: return decides');
});

console.log('\nGroup duels');
t('% return in a group duel: past the cap you’re last, short of the trading days you’re below everyone who has them', () => {
  const p = { type: 'ret', minDays: 3 };
  const r = Duels.podRank(p, [{ id: 'a', s: { score: 0.3, n: 4 }, out: true }, { id: 'b', s: { score: 0.05, n: 4 } }, { id: 'c', s: { score: 0.2, n: 1 } }, { id: 'd', s: { score: 0.1, n: 5 } }]);
  eq(r.rows.map(x => x.id), ['d', 'b', 'c', 'a']); eq([r.lead, r.why], ['d', 'highest % return']);
});

console.log('\nCompetitions');
const vd = (k, s) => ({ k: '2026-10-' + k, s });
const comp = extra => Object.assign({ start: '2026-10-01', end: '2026-10-31', entrants: { 1: {}, 2: {}, 3: {} } }, extra);
const people = [
  { id: '1', handle: 'calm', share: { verify: true, ret: true }, vdays: [vd('02', 90), vd('03', 90), vd('06', 90)], stats: { days: [] } },
  { id: '2', handle: 'wild', share: { verify: true, ret: true }, vdays: [vd('02', 95), vd('03', 95), vd('06', 95)], stats: { days: [] } },
  { id: '3', handle: 'nowallet', share: { verify: true, ret: false }, vdays: [vd('02', 70), vd('03', 70), vd('06', 70)], stats: { days: [] } }];
t('a Discipline competition with a cap: the one past it is out and placed last', () => {
  const c = comp({ type: 'discipline', minDays: 3, ddCap: 0.15, ddMode: 'out', money: { 1: { ret: 0.01, dd: 0.05 }, 2: { ret: 0.4, dd: 0.3 } } });
  const rows = S.compStandings(c, people, '2026-10-10');
  eq(rows.map(r => [r.handle, r.out]), [['calm', false], ['nowallet', false], ['wild', true]]);
  ok(/Out: drawdown 30.0%/.test(rows[2].note), rows[2].note);
  ok(/drawdown: waiting/.test(rows[1].note), 'a member whose drawdown isn’t read yet is told so: ' + rows[1].note);
});
t('a return competition: docked past the cap under the penalty rule; trading days only when it was made with them', () => {
  const c = comp({ type: 'return', minDays: 3, ddCap: 0.1, ddMode: 'penalty', penalty: 2, money: { 1: { ret: 0.08, dd: 0.04 }, 2: { ret: 0.2, dd: 0.17 } } });
  const rows = S.compStandings(c, people, '2026-10-10');
  eq(rows.slice(0, 2).map(r => r.handle), ['calm', 'wild']); near(rows[1].score, 0.06, 1e-9, '20% − 14 points (7% past the cap)');
  const strict = S.compStandings(Object.assign({}, c, { tradeDays: 5 }), people, '2026-10-10');
  eq(strict.find(r => r.handle === 'calm').note, '3 of 5 trading days so far');
});

console.log('\nLeague boards');
const money = (id, ret, dd) => ({ id, handle: id, share: { boards: true, ret: true, usd: true }, money: { ret, dd, usd: ret * 1000 } });
const field = [money('steady', 0.05, 0.03), money('swing', 0.3, 0.22), money('down', -0.04, 0.08)];
t('the old line stays for boards without a rule: over 25% leaves % return', () => {
  eq(S.boardRows([money('x', 0.5, 0.3), money('y', 0.1, 0.05)], 'ret', {}).map(r => r.handle), ['y']);
});
t('out for the week: past the cap you’re listed last, crossed out with the reason', () => {
  const rows = S.boardRows(field, 'ret', { risk: { cap: 0.2, mode: 'week', penalty: 2 } });
  eq(rows.map(r => [r.handle, !!r.out]), [['steady', false], ['down', false], ['swing', true]]);
  eq(rows[2].value, null); ok(/Out: DD 22.0%, past the 20% cap/.test(rows[2].sub), rows[2].sub);
});
t('penalty: the return is docked; off: nothing happens', () => {
  const p = S.boardRows(field, 'ret', { risk: { cap: 0.2, mode: 'penalty', penalty: 2 } });
  eq(p.map(r => r.handle), ['swing', 'steady', 'down']); near(p[0].value, 0.26, 1e-9, '30% − 4 points');
  eq(S.boardRows(field, 'ret', { risk: { cap: 0.2, mode: 'off' } }).map(r => r.handle), ['swing', 'steady', 'down']);
  eq(S.boardRows(field, 'usd', { risk: { cap: 0.2, mode: 'penalty', penalty: 2 } }).find(r => r.handle === 'swing').out, true, 'dollars can’t be docked: out');
});
report('drawdown rules');
