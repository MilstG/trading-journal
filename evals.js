'use strict';
// evals.js — the evaluation: a prop-firm-style test of a member's own trading, read from their account.
//
// A member picks rules (a preset or their own): a profit target, a daily loss limit and a drawdown limit (both as a
// share of the account at the start), a minimum of trading days, and a consistency rule (no single day more than a
// share of the profit). The evaluation runs for a set number of days from the moment it starts. Everything is read
// from the exchange, never from the app: the account's P&L curve (Hyperliquid's portfolio pnlHistory, which deposits
// and withdrawals don't move) gives the equity at each point, and the server's verified days (vdays, from fills) give
// the trading days. Days run midnight to midnight UTC. Breaking the daily loss or drawdown limit at any point fails it
// at once; reaching the target with the trading days in and the consistency rule kept passes it; running out of time
// ends it. Pure functions; social.js reads the portfolio and keeps the state.

const DAY = 86400000;
const PRESETS = {
  standard: { label: 'Standard', days: 30, target: 8, daily: 5, dd: 10, trail: false, minDays: 5, consistency: 40 },
  steady: { label: 'Steady', days: 30, target: 5, daily: 3, dd: 6, trail: true, minDays: 10, consistency: 30 },
  sprint: { label: 'Sprint', days: 14, target: 5, daily: 4, dd: 8, trail: false, minDays: 4, consistency: 50 },
};
// the owner's settings: on, the XP a pass pays (through a badge, like a season podium), the days to wait after
// a failed or abandoned one before the next, the smallest account an evaluation can start on; tile: the Compete
// screen's way in (shown only when the owner switches it on, its words and link theirs to set)
const TILE = { on: false, label: 'Evaluation', title: 'Take it', sub: 'trade it like it’s funded', href: '#eval' };
const DEFAULTS = { on: true, xp: 300, cooldownDays: 1, minAccount: 100, tile: TILE };
const fin = v => typeof v === 'number' && isFinite(v);
const num = (v, lo, hi, def) => { const n = +v; return v !== '' && v != null && isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def; };
const r2 = v => fin(v) ? Math.round(v * 100) / 100 : null;

function sanitizeEvalCfg(b, prev) {
  const out = Object.assign({}, DEFAULTS, prev || {}); out.tile = Object.assign({}, TILE, (prev || {}).tile);
  if (!b || typeof b !== 'object') return out;
  if (typeof b.on === 'boolean') out.on = b.on;
  const t = b.tile && typeof b.tile === 'object' ? b.tile : {}, T = out.tile;
  if (typeof t.on === 'boolean') T.on = t.on;
  // each line trimmed, one line, clipped; left empty, it goes back to the default words
  for (const [k, max] of [['label', 30], ['title', 30], ['sub', 80]]) if (typeof t[k] === 'string') T[k] = t[k].replace(/\s+/g, ' ').trim().slice(0, max) || TILE[k];
  // only a screen inside the app (#something), never a page elsewhere
  if (typeof t.href === 'string') T.href = /^#[a-z0-9/_-]{1,40}$/i.test(t.href.trim()) ? t.href.trim() : TILE.href;
  if (b.xp !== undefined) out.xp = Math.round(num(b.xp, 0, 5000, out.xp));
  if (b.cooldownDays !== undefined) out.cooldownDays = Math.round(num(b.cooldownDays, 0, 30, out.cooldownDays));
  if (b.minAccount !== undefined) out.minAccount = Math.round(num(b.minAccount, 10, 1e6, out.minAccount));
  return out;
}
// a member's rules: a preset by name, its numbers changed by any given (each clamped to a sane range; target 0 =
// no target, then it can only end; consistency 0 = off)
function sanitizeRules(b) {
  b = b && typeof b === 'object' ? b : {};
  const base = Object.prototype.hasOwnProperty.call(PRESETS, b.preset) ? PRESETS[b.preset] : PRESETS.standard;
  const days = Math.round(num(b.days, 7, 60, base.days));
  const out = { preset: 'custom', days,
    target: r2(num(b.target, 0, 100, base.target)), daily: r2(num(b.daily, 0.5, 50, base.daily)), dd: r2(num(b.dd, 1, 60, base.dd)),
    trail: typeof b.trail === 'boolean' ? b.trail : base.trail, minDays: Math.round(num(b.minDays, 0, days, base.minDays)),
    consistency: (c => c === 0 ? 0 : Math.round(num(c, 10, 100, base.consistency)))(b.consistency === undefined ? base.consistency : +b.consistency || 0) };
  // named after a preset only when every number is that preset's
  for (const [k, p] of Object.entries(PRESETS)) if (['days', 'target', 'daily', 'dd', 'trail', 'minDays', 'consistency'].every(x => p[x] === out[x])) { out.preset = k; break; }
  return out;
}
const utcDay = ms => new Date(ms).toISOString().slice(0, 10);
// the portfolio answer -> one series [[ms, value]] for a label ('month' covers ~30 days, 'allTime' further back)
function seriesOf(res, label, key) {
  const e = (Array.isArray(res) ? res : []).find(x => x && x[0] === label);
  return e && e[1] && Array.isArray(e[1][key]) ? e[1][key].map(p => [+p[0], parseFloat(p[1])]).filter(p => fin(p[0]) && fin(p[1])) : [];
}
// the account value when it starts (the last point at or before t, else the first after), or null
function accountAt(res, t) {
  const av = seriesOf(res, 'day', 'accountValueHistory').concat(seriesOf(res, 'week', 'accountValueHistory'), seriesOf(res, 'month', 'accountValueHistory'))
    .sort((a, b) => a[0] - b[0]);
  if (!av.length) return null;
  const before = av.filter(p => p[0] <= t).pop(); return (before || av[0])[1];
}
// e: {startAt, endAt, startAv, rules}; res: the portfolio answer; at: now.
// -> {eq, profit, ddUsed, dailyWorst: {k, pct}, days: {k: pnl}, bestShare, breach: null | {why, at, k}, points}
function evalState(e, res, at) {
  const R = e.rules, to = Math.min(at, e.endAt), label = e.startAt >= at - 29 * DAY ? 'month' : 'allTime';
  const all = seriesOf(res, label, 'pnlHistory').sort((a, b) => a[0] - b[0]);
  const before = all.filter(p => p[0] <= e.startAt).pop(), inWin = all.filter(p => p[0] > e.startAt && p[0] <= to);
  const P = (before ? [[e.startAt, before[1]]] : []).concat(inWin);
  const out = { eq: e.startAv, profit: 0, ddUsed: 0, dailyWorst: null, days: {}, bestShare: null, breach: null, points: P.length };
  if (P.length < 2 || !(e.startAv > 0)) return out;
  const base = P[0][1], S = e.startAv, pct = x => 100 * x / S;
  let peak = S, dayK = null, dayOpen = S, prev = S;
  for (const [t, v] of P) {
    const eq = S + (v - base), k = utcDay(t);
    if (k !== dayK) { if (dayK) out.days[dayK] = r2(prev - dayOpen); dayK = k; dayOpen = prev; }
    const dLoss = pct(dayOpen - eq);
    if (dLoss > 0 && (!out.dailyWorst || dLoss > out.dailyWorst.pct)) out.dailyWorst = { k, pct: r2(dLoss) };
    if (!out.breach && dLoss >= R.daily) out.breach = { why: 'daily', at: t, k, pct: r2(dLoss) };
    if (eq > peak) peak = eq;
    const dd = pct((R.trail ? peak : S) - eq); if (dd > out.ddUsed) out.ddUsed = r2(dd);
    if (!out.breach && dd >= R.dd) out.breach = { why: 'dd', at: t, k, pct: r2(dd) };
    prev = eq;
  }
  out.days[dayK] = r2(prev - dayOpen);
  out.eq = r2(prev); out.profit = r2(pct(prev - S));
  const total = prev - S, best = Math.max(0, ...Object.values(out.days));
  out.bestShare = total > 0 ? r2(100 * best / total) : null;
  return out;
}
// where it stands: 'live' | 'passed' | 'failed' | 'ended', and why; tradingDays: days with trades in the window
// (from verified fills; null when they can't be read)
function evalStatus(e, st, tradingDays, at) {
  const R = e.rules;
  if (st.breach) return { st: 'failed', why: st.breach.why === 'daily' ? 'Lost ' + st.breach.pct + '% of the starting account in a day (the limit is ' + R.daily + '%)'
    : 'Drew down ' + st.breach.pct + '% ' + (R.trail ? 'from the high' : 'from the start') + ' (the limit is ' + R.dd + '%)' };
  const daysOk = !R.minDays || (tradingDays != null && tradingDays >= R.minDays);
  const consOk = !R.consistency || st.bestShare == null || st.bestShare <= R.consistency;
  if (R.target > 0 && st.profit >= R.target && daysOk && consOk) return { st: 'passed', why: '+' + st.profit + '% with ' + (tradingDays || 0) + ' trading days' };
  if (at > e.endAt) return { st: 'ended', why: R.target > 0 ? (st.profit >= R.target ? (!daysOk ? 'Reached the target with ' + (tradingDays || 0) + ' of ' + R.minDays + ' trading days'
    : 'Reached the target, but one day made ' + st.bestShare + '% of the profit (the rule is ' + R.consistency + '%)') : 'Ended at ' + (st.profit >= 0 ? '+' : '') + st.profit + '% of a ' + R.target + '% target')
    : 'Ended at ' + (st.profit >= 0 ? '+' : '') + st.profit + '% within every limit' };
  return { st: 'live', why: '' };
}
// the member's rules in one line
function rulesText(R) {
  return (R.target > 0 ? '+' + R.target + '% target · ' : '') + R.daily + '% daily loss · ' + R.dd + '% ' + (R.trail ? 'trailing ' : '') + 'drawdown · '
    + R.minDays + ' trading day' + (R.minDays === 1 ? '' : 's') + (R.consistency ? ' · no day over ' + R.consistency + '% of the profit' : '') + ' · ' + R.days + ' days';
}

module.exports = { PRESETS, DEFAULTS, sanitizeEvalCfg, sanitizeRules, seriesOf, accountAt, evalState, evalStatus, rulesText, utcDay };
