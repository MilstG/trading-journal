'use strict';
// leagues.js — leagues, leaderboards, seasons and competitions, as pure functions: return and drawdown from the
// exchange's portfolio answer, weekly promotion and relegation, each board's rows (with the drawdown rule and the
// owner's trade bar), calendar seasons, and competition standings. social.js keeps the state and wires them to HTTP.
const { TIERS, DAY_RE, COMP_TYPES, clampNum, cleanText, utcDayKey, addDaysKey, isoWeekOfKey, avg } = require('./social-util.js');
const Duels = require('./duels.js');

// Average process score over the trading days in [fromKey, toKey], or null below minDays.
function disciplineOver(days, fromKey, toKey, minDays) {
  const ds = (days || []).filter(d => d.k >= fromKey && d.k <= toKey);
  return ds.length >= (minDays || 1) ? { avg: avg(ds.map(d => d.s)), n: ds.length } : { avg: null, n: ds.length };
}

// ---- 30-day return and drawdown from Hyperliquid's portfolio response ----
// Equity is rebuilt from the P&L series (start value + P&L since start), so deposits and
// withdrawals inside the window neither count as return nor as drawdown.
function portfolioStats(res, label, fromMs, toMs) {
  const e = (Array.isArray(res) ? res : []).find(x => x && x[0] === label);
  if (!e || !e[1]) return null;
  const av = (e[1].accountValueHistory || []).map(p => [+p[0], parseFloat(p[1])]).filter(p => isFinite(p[1]));
  const pn = (e[1].pnlHistory || []).map(p => [+p[0], parseFloat(p[1])]).filter(p => isFinite(p[1]));
  const inWin = p => (fromMs == null || p[0] >= fromMs) && (toMs == null || p[0] <= toMs);
  let P = pn.filter(inWin);
  // a window with a single point so far (early on its first day) measures from the last point before it
  // (on the 30-day series only: the all-time one is coarse, and a point from long before the window would
  // count gains from before it)
  if (P.length === 1 && fromMs != null && label === 'month') { const before = pn.filter(p => p[0] < fromMs).pop(); if (before) P = [before, ...P]; }
  if (P.length < 2) return null;
  const startAv = (av.filter(p => p[0] <= P[0][0]).pop() || av.find(inWin) || [0, 0])[1];
  if (!(startAv > 0)) return null;
  const base = P[0][1];
  // A ratio needs real starting equity: an account that stood at a dollar or two when the window opened
  // read as +925,528% (and a 38,682% drawdown) on the boards. Under $100 the dollar figure is kept and the
  // percentages are not meaningful.
  if (startAv < 100) return { ret: null, dd: null, usd: P[P.length - 1][1] - base, start: startAv, thin: true };
  let peak = startAv, dd = 0;
  for (const [, v] of P) { const eq = startAv + (v - base); if (eq > peak) peak = eq; if (peak > 0) dd = Math.max(dd, (peak - eq) / peak); }
  const usd = P[P.length - 1][1] - base;
  return { ret: usd / startAv, dd, usd, start: startAv };
}

// ---- league: weekly promotion and relegation by XP earned that week ----
const leagueMoveCount = n => n >= 4 ? Math.min(5, Math.floor(n / 4)) : 0;
// entries: [{id, tier, value, banned}] — everyone in a tier is ranked by the league's measure; a
// week with nothing posted counts as 0, so sitting out never protects a spot. Only a positive value
// earns promotion.
function leagueRolloverBy(entries) {
  const moves = [];
  for (let t = 0; t < TIERS.length; t++) {
    const val = e => (isFinite(e.value) && e.value != null ? e.value : 0);
    const inTier = entries.filter(e => !e.banned && (e.tier || 0) === t);
    const n = inTier.length; const k = leagueMoveCount(n); if (!k) continue;
    const sorted = [...inTier].sort((a, b) => val(b) - val(a) || a.id.localeCompare(b.id));
    // few: fewer trades in the window than the owner's research bar (findings.js minTrades), so the result is mostly luck
    if (t < TIERS.length - 1) for (const e of sorted.slice(0, k)) if (val(e) > 0 && !e.few) moves.push({ id: e.id, from: t, to: t + 1 });
    if (t > 0) for (const e of sorted.slice(-k)) moves.push({ id: e.id, from: t, to: t - 1 });
  }
  return moves;
}
// the original weekly-XP rollover, kept for its callers and tests
function leagueRollover(members, week) {
  return leagueRolloverBy(members.map(m => ({ id: m.id, tier: m.tier || 0, banned: m.banned, value: (m.weekXp && m.weekXp[week]) || 0 })));
}
// Monday's day key of an ISO week ('2026-W40' -> '2026-09-28')
function isoWeekMonday(week) {
  const m = /^(\d{4})-W(\d{2})$/.exec(week || ''); if (!m) return null;
  const jan4 = new Date(Date.UTC(+m[1], 0, 4)), mon = jan4.getTime() - ((jan4.getUTCDay() + 6) % 7) * 86400000;
  return utcDayKey(mon + (+m[2] - 1) * 7 * 86400000);
}

// ---- leaderboards ----
const BOARDS = {
  xp: { label: 'Weekly XP', scope: 'league', needs: 'boards' },
  discipline: { label: 'Discipline', needs: 'boards', verified: true },
  streak: { label: 'Streak', needs: 'boards' },
  level: { label: 'All-time XP', needs: 'boards' },
  riskadj: { label: 'Return / drawdown', needs: 'ret' },
  ret: { label: '% Return', needs: 'ret' },
  usd: { label: '$ P&L', needs: 'usd' },
};
// money and a drawdown rule -> {out, pen (a fraction of return), skip}. risk: {cap (a fraction), mode: 'week' |
// 'penalty' | 'off', penalty (points per 1%)}; dollars can't be docked, so there a penalty puts you out.
function boardRisk(mo, board, risk) {
  if (!risk) return { out: false, pen: 0, skip: board === 'ret' && mo.dd > 0.25 };
  if (risk.mode === 'off' || !risk.cap || !(mo.dd > risk.cap)) return { out: false, pen: 0, skip: false };
  if (risk.mode === 'penalty' && board !== 'usd') return { out: false, pen: (mo.dd - risk.cap) * (risk.penalty == null ? 2 : risk.penalty), skip: false };
  return { out: true, pen: 0, skip: false };
}
// a member's closed trades over [fromKey, toKey], from their verified days (null: not verified, so not known)
function tradesIn(vdays, fromKey, toKey) { if (!Array.isArray(vdays)) return null; let n = 0; for (const d of vdays) if (d && d.k >= fromKey && d.k <= toKey) n += +d.n || 0; return n; }
const MONEY_BOARDS = ['ret', 'riskadj', 'usd'];
function boardRows(members, board, opts) {
  opts = opts || {};
  const B = Object.prototype.hasOwnProperty.call(BOARDS, board) ? BOARDS[board] : null; if (!B) return null;
  // callers inside the module pass todayKey from the module's clock (opts.now): the windowed boards
  // (discipline's last 7 days) must follow the same time as everything else, the tests' included
  const todayK = opts.todayKey || utcDayKey(Date.now());
  const week = opts.week || isoWeekOfKey(todayK);
  // process boards read posted stats; money boards read only what the server fetched from the chain
  let pool = members.filter(m => !m.banned && m.share && m.share[B.needs] && (B.needs !== 'boards' || m.stats)
    && (!B.verified || (m.share.verify && Array.isArray(m.vdays))));
  if (opts.tier != null && (B.scope === 'league' || opts.tierAll)) pool = pool.filter(m => (m.tier || 0) === opts.tier);
  const rows = [];
  for (const m of pool) {
    let v = null, sub = '';
    if (board === 'xp') { v = opts.dayFrom ? Object.entries((m.stats && m.stats.xpDays) || {}).reduce((a, [k, x]) => k >= opts.dayFrom && k <= opts.dayTo ? a + x : a, 0)
        : opts.weeks ? opts.weeks.reduce((a, w) => a + ((m.weekXp && m.weekXp[w]) || 0), 0) : (m.weekXp && m.weekXp[week]) || 0; sub = 'Level ' + m.stats.level; }
    else if (board === 'level') { v = m.stats.xp; sub = 'Level ' + m.stats.level; }
    else if (board === 'streak') { v = m.stats.streak; sub = 'Best ' + m.stats.best; }
    else if (board === 'discipline') { const d = disciplineOver(m.vdays, addDaysKey(todayK, -((opts.days || 7) - 1)), todayK, 3); if (d.avg == null) continue; v = Math.round(d.avg); sub = 'verified · ' + d.n + ' trading days'; }
    else {
      const mo = m.money; if (!mo || mo.ret == null) continue;
      // the drawdown rule (opts.risk: {cap, mode, penalty}): past the cap a member is out for the board's
      // window, shown last; or their return is docked. Without one, the old line: over 25% leaves % return.
      const k = boardRisk(mo, board, opts.risk);
      if (k.out) { rows.push({ id: m.id, handle: m.handle, tier: m.tier || 0, value: null, out: true, sub: 'Out: DD ' + (mo.dd * 100).toFixed(1) + '%, past the ' + Math.round(opts.risk.cap * 100) + '% cap' }); continue; }
      if (k.skip) continue;
      const ret = mo.ret - k.pen, penTxt = k.pen ? ' · −' + (k.pen * 100).toFixed(1) + '% past the cap' : '';
      if (board === 'ret') { v = ret; sub = 'DD ' + (mo.dd * 100).toFixed(1) + '%' + penTxt; }
      else if (board === 'riskadj') { v = ret / Math.max(mo.dd, 0.005); sub = (mo.ret >= 0 ? '+' : '') + (mo.ret * 100).toFixed(1) + '% · DD ' + (mo.dd * 100).toFixed(1) + '%' + penTxt; }
      else if (board === 'usd') { v = mo.usd; sub = 'DD ' + (mo.dd * 100).toFixed(1) + '%'; }
    }
    // results rank from opts.minTrades closed trades in the window (the owner's bar from the research, findings.js):
    // fewer, or none verified to count, and the member is listed after the ranked ones, unranked
    let few = false;
    if (opts.minTrades > 0 && MONEY_BOARDS.includes(board)) { const n = tradesIn(m.vdays, opts.dayFrom || addDaysKey(todayK, -((opts.days || 30) - 1)), opts.dayTo || todayK);
      if (!(n >= opts.minTrades)) { few = true; sub += (sub ? ' · ' : '') + (n == null ? 'trades not verified' : n + ' of ' + opts.minTrades + ' trades'); } }
    rows.push(Object.assign({ id: m.id, handle: m.handle, tier: m.tier || 0, value: v, sub }, few ? { few: true } : {}));
  }
  rows.sort((a, b) => (!!a.out - !!b.out) || (!!a.few - !!b.few) || (a.out ? 0 : b.value - a.value) || a.handle.localeCompare(b.handle));
  let rk = 0; rows.forEach(r => { r.rank = r.few ? null : ++rk; });
  return rows;
}

// ---- seasons: a league can run calendar seasons (a month or a quarter) with a podium at the end ----
function seasonOf(kind, dayKey) {
  if (kind === 'month') return dayKey.slice(0, 7);
  if (kind === 'quarter') return dayKey.slice(0, 4) + '-Q' + (Math.floor((+dayKey.slice(5, 7) - 1) / 3) + 1);
  return null;
}
function seasonBounds(id) {
  const y = +id.slice(0, 4);
  const m0 = id.includes('-Q') ? (+id.slice(6) - 1) * 3 : +id.slice(5, 7) - 1, months = id.includes('-Q') ? 3 : 1;
  return { start: utcDayKey(Date.UTC(y, m0, 1)), end: utcDayKey(Date.UTC(y, m0 + months, 0)) };
}
function seasonLabel(id) {
  if (id.includes('-Q')) return 'Q' + id.slice(6) + ' ' + id.slice(0, 4);
  return new Date(Date.UTC(+id.slice(0, 4), +id.slice(5, 7) - 1, 1)).toLocaleString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}
// the ISO weeks whose Monday falls inside [start, end]
function weeksIn(start, end) { const out = []; let k = start;
  const dow = (new Date(k + 'T00:00:00Z').getUTCDay() + 6) % 7; if (dow) k = addDaysKey(k, 7 - dow);
  for (; k <= end; k = addDaysKey(k, 7)) out.push(isoWeekOfKey(k));
  return out; }

// ---- competitions ----
function compStatus(c, todayKey) { return todayKey < c.start ? 'upcoming' : todayKey > c.end ? 'finished' : 'live'; }
// members: an array, or the members object keyed by id (no lookup map to build per call)
// walletGate (optional): m -> a reason the member's wallet doesn't count yet (owner approval), or null
// final: the results are being frozen — a drawdown that still can't be read is out, never "not over"
function compStandings(c, members, todayKey, requireClaim, walletGate, final) {
  const byId = Array.isArray(members) ? new Map(members.map(m => [m.id, m])) : { get: id => Object.prototype.hasOwnProperty.call(members, id) ? members[id] : undefined };
  const rows = [];
  for (const id of Object.keys(c.entrants || {})) {
    const m = byId.get(id); if (!m || m.banned) continue;
    // the days the competition kept as they were synced (the app only sends the last few weeks),
    // with the member's latest copy on top
    const kept = new Map(((c.log && c.log[id]) || []).map(d => [d.k, d]));
    for (const d of (m.stats && m.stats.days) || []) { const p = kept.get(d.k); kept.set(d.k, p ? Object.assign({}, d, { b: !!(d.b || p.b) }) : d); }
    const days = [...kept.values()].filter(d => d.k >= c.start && d.k <= c.end && d.k <= todayKey).sort((a, b) => a.k < b.k ? -1 : 1);
    let score = null, note = '', out = false;
    if (c.type === 'discipline') {
      // verified days only: recomputed by the server from the member's own fills
      const vd = m.share && m.share.verify && Array.isArray(m.vdays) ? m.vdays.filter(d => d.k >= c.start && d.k <= c.end && d.k <= todayKey) : null;
      if (!vd) { rows.push({ id, handle: m.handle, score: null, out: false,
        note: !(m.share && m.share.verify) ? 'Needs verification: switch on “Verify my discipline”' : !m.address ? 'Needs a wallet to verify'
          : requireClaim && m.claimed !== m.address ? 'Needs a claimed wallet' : (walletGate && walletGate(m)) || 'Verifying from fills…' }); continue; }
      const d = disciplineOver(vd, c.start, c.end, c.minDays || 3);
      if (d.avg == null) note = d.n + ' of ' + (c.minDays || 3) + ' trading days so far'; else { score = Math.round(d.avg); note = d.n + ' trading days'; }
    } else if (c.type === 'survivor') {
      const hit = days.find(d => d.b);
      if (hit) { out = true; score = -1; note = 'Out on ' + hit.k; } else { score = days.length; note = days.length + ' trading day' + (days.length === 1 ? '' : 's') + ' standing'; }
    } else if (c.type === 'journal') {
      let run = 0, best = 0; for (const d of days) { run = d.j ? run + 1 : 0; best = Math.max(best, run); }
      score = best; note = best + ' fully journaled day' + (best === 1 ? '' : 's') + ' in a row' + (best >= (c.minDays || 10) ? ' · done' : '');
    } else if (c.type === 'return') {
      const r = m.share && m.share.ret && c.money && Object.prototype.hasOwnProperty.call(c.money, id) ? c.money[id] : null;
      // trading days: verified ones only (days an app reports can be made up, and sitting flat mustn't win)
      const td = m.share && m.share.verify && Array.isArray(m.vdays) ? m.vdays.filter(d => d.k >= c.start && d.k <= c.end && d.k <= todayKey).length : 0;
      if (!r) note = 'waiting for data';
      else if (r.ret == null) note = 'starting equity under $100: no % return';
      else if (c.tradeDays && td < c.tradeDays) note = td + ' of ' + c.tradeDays + ' trading days so far';
      else { score = r.ret; note = (r.ret >= 0 ? '+' : '') + (r.ret * 100).toFixed(1) + '% · DD ' + (r.dd * 100).toFixed(1) + '%'; }
    }
    // the drawdown rule, on any type: past the cap you're out (last), or your score is docked
    if (c.ddCap && !out) {
      const r = m.share && m.share.ret && c.money && Object.prototype.hasOwnProperty.call(c.money, id) ? c.money[id] : null;
      const k = Duels.ddCheck(r, c.ddCap, c.ddMode || 'out', c.type, c.penalty);
      // a drawdown that can't be read is out: stopped sharing % return after the start, or no reading at the end
      const dark = todayKey >= c.start && !(m.share && m.share.ret) ? 'stopped sharing returns' : final && !r ? 'no drawdown reading' : null;
      if (dark) { out = true; score = -Infinity; note = 'Out: ' + dark; }
      else if (k.out) { out = true; score = -Infinity; note = 'Out: drawdown ' + (k.dd * 100).toFixed(1) + '%, past the ' + Math.round(c.ddCap * 100) + '% cap'; }
      else if (k.pen && score != null) { score = c.type === 'return' ? score - k.pen : Math.round(score - k.pen); note += ' · −' + (c.type === 'return' ? (k.pen * 100).toFixed(1) + '%' : Math.round(k.pen) + ' pts') + ' past the drawdown cap'; }
      else if (!r && c.type !== 'return') note += ' · drawdown: waiting for data';
    }
    rows.push({ id, handle: m.handle, score, note, out });
  }
  rows.sort((a, b) => (b.score == null ? -Infinity : b.score) - (a.score == null ? -Infinity : a.score) || a.handle.localeCompare(b.handle));
  rows.forEach((r, i) => { r.rank = i + 1; });
  return rows;
}
function sanitizeComp(b) {
  b = b || {};
  const type = COMP_TYPES.includes(b.type) ? b.type : null;
  const title = cleanText(b.title, 60), rule = cleanText(b.rule, 280);
  if (!type || !title || !DAY_RE.test(b.start) || !DAY_RE.test(b.end) || b.end < b.start) return null;
  if (Date.parse(b.end) - Date.parse(b.start) > 92 * 86400000) return null;
  return { type, title, rule, start: b.start, end: b.end, league: typeof b.league === 'string' && /^[a-z0-9-]{1,30}$/.test(b.league) ? b.league : null,
    minDays: clampNum(b.minDays, 1, 90) || (type === 'journal' ? 10 : 3),
    // % return always has a drawdown cap; any other kind can take one. ddMode: 'out' or 'penalty' (unset: the league's default)
    // (empty, null or 0 is no cap: clampNum would read them as 0 and clamp up to 1%)
    ddCap: (cap => type === 'return' ? cap || 0.08 : cap)(b.ddCap == null || b.ddCap === '' || !+b.ddCap ? null : clampNum(b.ddCap, 0.01, 0.9)),
    ddMode: ['out', 'penalty'].includes(b.ddMode) ? b.ddMode : null,
    // % return: the trading days an entrant needs to be ranked (unset: the league's default; 0: none)
    tradeDays: type === 'return' && b.tradeDays !== undefined && b.tradeDays !== '' && b.tradeDays !== null ? Math.round(clampNum(b.tradeDays, 0, 90) || 0) : null };
}


module.exports = { disciplineOver, portfolioStats, leagueMoveCount, leagueRolloverBy, leagueRollover, isoWeekMonday, BOARDS, boardRisk, tradesIn, MONEY_BOARDS, boardRows,
  seasonOf, seasonBounds, seasonLabel, weeksIn, compStatus, compStandings, sanitizeComp };
