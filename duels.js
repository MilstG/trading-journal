'use strict';
// Duels: one member challenges another to a week or a month on one measure. Pure functions —
// the terms, the dates, and the score — so the rules can be tested without a server.
//
// Scoring reads only what the server already has: the Discipline days it verifies from each
// member's public fills (m.vdays), the days each member's app syncs (m.stats.days: score, fully
// journaled, reviewed), XP by day (m.stats.xpDays), and for % return the duel's own on-chain
// snapshot (d.money). Nobody marks their own homework. Money is never staked; XP can be: each side
// puts up the same amount and the winner takes the loser's.
//
// Also here: the ladder's rating maths (elo, softReset) and group duels ("pods"): their terms and
// how 3 to 6 members, each scored like one side of a duel, are ranked (podRank).

const TYPES = {
  disc: { label: 'Discipline', rule: 'Higher average daily Discipline wins.', verifiedDefault: true },
  clean: { label: 'Clean days', rule: 'More trading days at 70+ Discipline wins; a tie goes to the higher average.', verifiedDefault: true },
  survive: { label: 'Last one standing', rule: 'The first to have a trading day under 70 Discipline loses.', verifiedDefault: true },
  journal: { label: 'Journal streak', rule: 'More days with every trade journaled and the day reviewed wins.' },
  xp: { label: 'Process XP', rule: 'More XP earned from process wins. Profit earns none.' },
  ret: { label: '% return, capped', rule: 'Higher % return wins; going past the drawdown cap loses outright.' },
};
const DEFAULTS = { on: true, types: { disc: true, clean: true, survive: true, journal: true, xp: true, ret: false }, xp: 100, maxOpen: 3, perDay: 5,
  stakes: true, maxStake: 500, stakePct: 25, // stakePct: the most of your XP that can be riding on open duels at once
  ladder: true, k: 32, ladderMin: 3, // the ladder: an Elo-style rating from 1v1 results; k: how far one duel moves it; ladderMin: rated duels to be listed
  pods: true, podMax: 6 }; // group duels ("pods"): 3 to podMax members
// Drawdown rules: what happens when someone goes past an event's drawdown cap, per format. 'out': they lose
// (a duel) or place last (a group duel, a competition); 'penalty': their score drops `penalty` points per 1%
// past the cap (Discipline points, or percentage points of return; types that count days can't be docked,
// so there it's 'out'); 'off': only % return carries a cap (it always has). A league's money boards:
// 'week' (past the cap, you're out for the league's week: you score 0 and drop to the bottom), 'penalty', or
// 'off'. caps: the presets members pick from, in %. minDays: trading days a return event needs by default.
const RISK_DEFAULTS = { caps: [10, 15, 20, 25], duel: 'out', pod: 'out', comp: 'out', league: 'week', leagueCap: 25, penalty: 2, minDays: 5 };
const RISK_MODES = ['out', 'penalty', 'off'], LEAGUE_RISK_MODES = ['week', 'penalty', 'off'];
const PENALTY_TYPES = ['disc', 'ret', 'discipline', 'return']; // scores a penalty can come off (duel types and competition types)
function sanitizeRiskCfg(b, prev) {
  const out = Object.assign({}, RISK_DEFAULTS, prev || {});
  out.caps = (prev && Array.isArray(prev.caps) ? prev.caps : RISK_DEFAULTS.caps).slice();
  if (!b || typeof b !== 'object') return out;
  for (const k of ['duel', 'pod', 'comp']) if (RISK_MODES.includes(b[k])) out[k] = b[k];
  if (LEAGUE_RISK_MODES.includes(b.league)) out.league = b.league;
  if (b.caps !== undefined) { const c = (Array.isArray(b.caps) ? b.caps : String(b.caps).split(/[\s,%]+/)).map(x => Math.round(+x)).filter(x => isFinite(x) && x >= 2 && x <= 50);
    const u = [...new Set(c)].sort((x, y) => x - y).slice(0, 6); if (u.length) out.caps = u; }
  if (b.leagueCap !== undefined) { const x = clamp(b.leagueCap, 2, 90); if (x != null) out.leagueCap = Math.round(x); }
  if (b.penalty !== undefined) { const x = clamp(b.penalty, 0, 20); if (x != null) out.penalty = Math.round(x * 10) / 10; }
  if (b.minDays !== undefined) { const x = clamp(b.minDays, 0, 30); if (x != null) out.minDays = Math.round(x); }
  return out;
}
// One member's drawdown against an event's cap. r: {ret, dd} read from their wallet for the event's dates (or
// null while it's being read); cap: a fraction; mode: 'out' | 'penalty'; type: what's scored. ->
// {dd, over, out, pen} where pen is the penalty in the score's own units (points, or a fraction of return).
function ddCheck(r, cap, mode, type, penalty) {
  if (!cap || !r || r.dd == null) return { dd: r && r.dd != null ? r.dd : null, over: false, out: false, pen: 0 };
  const over = r.dd > cap; if (!over) return { dd: r.dd, over, out: false, pen: 0 };
  const pts = (r.dd - cap) * 100 * (penalty == null ? RISK_DEFAULTS.penalty : penalty);
  if (mode === 'penalty' && PENALTY_TYPES.includes(type)) return { dd: r.dd, over, out: false, pen: ['ret', 'return'].includes(type) ? pts / 100 : pts };
  return { dd: r.dd, over, out: true, pen: 0 };
}
const DAY = 86400000;
const keyOf = ms => new Date(ms).toISOString().slice(0, 10);
const clamp = (v, lo, hi) => { const n = +v; return isFinite(n) ? Math.min(hi, Math.max(lo, n)) : null; };

function sanitizeDuelCfg(b, prev) {
  const out = Object.assign({}, DEFAULTS, prev || {}, { types: Object.assign({}, DEFAULTS.types, (prev && prev.types) || {}) });
  if (!b || typeof b !== 'object') return out;
  if (typeof b.on === 'boolean') out.on = b.on;
  if (typeof b.stakes === 'boolean') out.stakes = b.stakes;
  if (b.maxStake !== undefined) { const x = clamp(b.maxStake, 0, 100000); if (x != null) out.maxStake = Math.round(x); }
  if (b.stakePct !== undefined) { const x = clamp(b.stakePct, 1, 100); if (x != null) out.stakePct = Math.round(x); }
  if (b.types && typeof b.types === 'object') for (const k of Object.keys(TYPES)) if (typeof b.types[k] === 'boolean') out.types[k] = b.types[k];
  if (b.xp !== undefined) { const x = clamp(b.xp, 0, 10000); if (x != null) out.xp = Math.round(x); }
  if (b.maxOpen !== undefined) { const x = clamp(b.maxOpen, 1, 20); if (x != null) out.maxOpen = Math.round(x); }
  if (b.perDay !== undefined) { const x = clamp(b.perDay, 1, 50); if (x != null) out.perDay = Math.round(x); }
  if (typeof b.ladder === 'boolean') out.ladder = b.ladder;
  if (b.k !== undefined) { const x = clamp(b.k, 4, 100); if (x != null) out.k = Math.round(x); }
  if (b.ladderMin !== undefined) { const x = clamp(b.ladderMin, 1, 50); if (x != null) out.ladderMin = Math.round(x); }
  if (typeof b.pods === 'boolean') out.pods = b.pods;
  if (b.podMax !== undefined) { const x = clamp(b.podMax, 3, 6); if (x != null) out.podMax = Math.round(x); }
  return out;
}
// The terms someone proposes -> the stored shape, or {error}.
function sanitizeTerms(b, cfg) {
  b = b || {}; cfg = cfg || DEFAULTS;
  const type = Object.prototype.hasOwnProperty.call(TYPES, b.type) ? b.type : null;
  if (!type) return { error: 'Pick what to compete on.' };
  if (!cfg.types[type]) return { error: 'This league doesn’t run ' + TYPES[type].label + ' duels.' };
  const period = b.period === 'month' ? 'month' : 'week';
  const verified = ['disc', 'clean', 'survive'].includes(type) ? b.verified !== false : false;
  // a minimum of trading days: Discipline always had one; % return now too, so sitting flat can't win
  const risk = (cfg && cfg.risk) || RISK_DEFAULTS;
  const minDays = type === 'disc' || type === 'ret' ? Math.round(clamp(b.minDays, 1, period === 'month' ? 20 : 5) || (type === 'ret' ? retMinDays(period, risk) : 3)) : null;
  // % return always has a drawdown cap; any other duel can take one when the league allows it
  // (empty, null or 0 is no cap: clamp would read them as 0 and clamp up to 2%)
  const capIn = b.ddCap == null || b.ddCap === '' || !+b.ddCap ? null : clamp(b.ddCap, 0.02, 0.5);
  const ddCap = type === 'ret' ? capIn || 0.08 : risk.duel !== 'off' ? capIn : null;
  const msg = String(b.msg == null ? '' : b.msg).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 140);
  const stake = cfg.stakes === false ? 0 : Math.round(clamp(b.stake, 0, cfg.maxStake == null ? DEFAULTS.maxStake : cfg.maxStake) || 0);
  return { type, period, verified, minDays, ddCap, msg, stake };
}
// trading days a % return duel needs by default: the league's number for a month, three fifths of it for a week
// (5 → 3 a week, 5 a month), at least 1, at most the days there are (5 a week, 20 a month)
function retMinDays(period, risk) { const n = +((risk || RISK_DEFAULTS).minDays) || 0;
  return period === 'month' ? Math.min(20, Math.max(1, n)) : Math.min(5, Math.max(1, Math.ceil(n * 3 / 5))); }
// the rule a capped event plays by, fixed when it's made: the league's setting for that format
const ddModeFor = (fmt, risk) => { const m = (risk || RISK_DEFAULTS)[fmt]; return m === 'penalty' ? 'penalty' : 'out'; };
// The most XP a member can still put up: a share of their XP, less what's already riding on their
// other open duels. xp: their total; riding: the stakes already committed.
function stakeRoom(xp, riding, cfg) {
  cfg = cfg || DEFAULTS;
  return Math.max(0, Math.min(cfg.maxStake, Math.floor((+xp || 0) * (cfg.stakePct || DEFAULTS.stakePct) / 100) - (riding || 0)));
}
// the member's own calendar day for a moment, as their app files XP under it
const localKey = (ms, tz) => { try { return new Date(ms).toLocaleDateString('en-CA', { timeZone: tz || 'UTC' }); } catch (e) { return keyOf(ms); } };
// The duel's dates once accepted: the next whole week (Monday to Sunday) or the next calendar month,
// in UTC days like the league's weeks — always one that starts after today, so nobody gets a head
// start: accepted on a Monday (or the 1st), part of that day is already played and reported.
function windowFor(period, nowMs) {
  const d = new Date(keyOf(nowMs) + 'T00:00:00Z');
  if (period === 'month') {
    const s = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
    const e = new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth() + 1, 0));
    return { start: keyOf(s.getTime()), end: keyOf(e.getTime()) };
  }
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  const s = d.getTime() + (7 - dow) * DAY;
  return { start: keyOf(s), end: keyOf(s + 6 * DAY) };
}
// One side's score so far (or final). m: the member; d: the duel; upto: the last day to count.
function sideScore(d, m, upto) {
  const last = d.end < upto ? d.end : upto, inWin = k => k >= d.start && k <= last;
  const verifiedDays = m && m.share && m.share.verify && Array.isArray(m.vdays) ? m.vdays : null;
  const appDays = (m && m.stats && Array.isArray(m.stats.days)) ? m.stats.days : [];
  const proc = (d.verified ? verifiedDays || [] : appDays).filter(x => inWin(x.k)).sort((a, b) => a.k < b.k ? -1 : 1);
  const avg = a => a.length ? a.reduce((s, x) => s + x.s, 0) / a.length : null;
  const marks = proc.map(x => ({ k: x.k, s: Math.round(x.s) })); // what the duel card draws, day by day
  const out = { n: proc.length, marks, score: null, note: '', verifiedMissing: d.verified && !verifiedDays };
  if (d.type === 'disc') { const a = avg(proc); out.avg = a; out.score = a == null ? null : Math.round(a);
    out.note = proc.length < (d.minDays || 3) ? proc.length + ' of ' + (d.minDays || 3) + ' trading days' : proc.length + ' trading days'; }
  else if (d.type === 'clean') { out.score = proc.filter(x => x.s >= 70).length; out.avg = avg(proc); out.note = out.score + ' of ' + proc.length + ' days at 70+'; }
  else if (d.type === 'survive') { const fell = proc.find(x => x.s < 70); out.fell = fell ? fell.k : null; out.score = proc.length;
    // switching verification off mid-duel would hide every slip: that counts as falling on day one
    if (d.verified && !(m && m.share && m.share.verify) && d.start <= upto) { out.fell = d.start; out.note = 'Out: turned verification off'; }
    else out.note = fell ? 'Out on ' + fell.k : proc.length + ' clean trading day' + (proc.length === 1 ? '' : 's'); }
  else if (d.type === 'journal') { const days = appDays.filter(x => inWin(x.k)); out.score = days.filter(x => x.j && x.r).length; out.n = days.length;
    out.marks = days.map(x => ({ k: x.k, s: x.j && x.r ? 100 : 0 })); out.note = out.score + ' of ' + days.length + ' days journaled and reviewed'; }
  else if (d.type === 'xp') { const xd = (m && m.stats && m.stats.xpDays) || {}; let s = 0; const mk = [];
    // XP won in duels isn't process XP: it comes off the day it landed on
    const won = {}; for (const g of (m && m.grants) || []) if (g.duel && g.xp > 0) { const k = localKey(g.at, m.stats && m.stats.tz); won[k] = (won[k] || 0) + g.xp; }
    for (const k of Object.keys(xd).sort()) if (inWin(k)) { const v = Math.max(0, Math.round((+xd[k] || 0) - (won[k] || 0))); s += v; mk.push({ k, s: v }); }
    out.score = s; out.marks = mk; out.n = mk.length; out.note = s + ' XP'; }
  else if (d.type === 'ret') { const r = d.money && m && Object.prototype.hasOwnProperty.call(d.money, m.id) ? d.money[m.id] : null;
    // trading days: only the verified ones, read from the wallet (days an app reports can be made up, and
    // sitting flat with made-up days must not win)
    const td = (verifiedDays || []).filter(x => inWin(x.k)); out.n = td.length; out.marks = td.map(x => ({ k: x.k, s: Math.round(x.s) }));
    if (!r) out.note = 'waiting for on-chain data';
    else { out.ret = r.ret; out.dd = r.dd; out.score = r.ret;
      out.note = (r.ret >= 0 ? '+' : '') + (r.ret * 100).toFixed(1) + '% · drawdown ' + (r.dd * 100).toFixed(1) + '%' + (d.minDays && td.length < d.minDays ? ' · ' + td.length + ' of ' + d.minDays + ' trading days' : ''); } }
  // the drawdown rule, on any type: past the cap you're out, or your score is docked
  if (d.ddCap) {
    const r = d.money && m && Object.prototype.hasOwnProperty.call(d.money, m.id) ? d.money[m.id] : null;
    const c = ddCheck(r, d.ddCap, d.ddMode || 'out', d.type, d.penalty);
    out.dd = c.dd; out.ddOut = c.out; out.pen = c.pen;
    if (c.out) { out.out = true; out.note = 'Out: drawdown ' + (c.dd * 100).toFixed(1) + '%, past the ' + Math.round(d.ddCap * 100) + '% cap'; }
    else if (c.pen) { if (out.score != null) out.score = d.type === 'ret' ? out.score - c.pen : Math.round(out.score - c.pen);
      if (out.avg != null) out.avg -= c.pen; out.note += ' · −' + (d.type === 'ret' ? (c.pen * 100).toFixed(1) + '%' : Math.round(c.pen) + ' pts') + ' past the drawdown cap'; }
    else if (!r && d.type !== 'ret') out.note += (out.note ? ' · ' : '') + 'drawdown: waiting for on-chain data';
  }
  return out;
}
// Who's ahead (or who won, when upto is past the end): {a, b, lead: 'a' | 'b' | null, why}
function standing(d, ma, mb, upto) {
  const a = sideScore(d, ma, upto), b = sideScore(d, mb, upto);
  let lead = null, why = '';
  const cmp = (x, y) => x > y ? 'a' : y > x ? 'b' : null;
  // d.moved (set by the server): a side whose wallet isn't the one it accepted with — that side loses
  if (d.moved && (d.moved.a || d.moved.b)) {
    for (const [k, x] of [['a', a], ['b', b]]) if (d.moved[k]) { x.out = true; x.note = 'changed wallet mid-duel'; if (d.type === 'survive') x.fell = d.start; }
    if (d.moved.a && d.moved.b) return { a, b, lead: null, why: 'both changed wallets mid-duel' };
    return { a, b, lead: d.moved.a ? 'b' : 'a', why: 'the other side changed wallet mid-duel' };
  }
  // d.dark (set by the server): a capped duel's side whose drawdown can't be read — they stopped sharing
  // returns after the start, or there's still no reading once it's over. No reading is never "not over".
  if (d.dark && (d.dark.a || d.dark.b)) {
    for (const [k, x] of [['a', a], ['b', b]]) if (d.dark[k]) { x.out = true; x.note = 'Out: ' + d.dark[k]; if (d.type === 'survive') x.fell = d.start; }
    if (d.dark.a && d.dark.b) return { a, b, lead: null, why: 'neither side’s drawdown could be read' };
    return { a, b, lead: d.dark.a ? 'b' : 'a', why: 'the other side’s drawdown couldn’t be read' };
  }
  // past the drawdown cap (a 'out' rule, or % return's own cap): that side loses, whatever the measure
  if (a.out || b.out) {
    if (a.out && b.out) return { a, b, lead: null, why: 'both went past the drawdown cap' };
    return { a, b, lead: a.out ? 'b' : 'a', why: 'the other side went past the ' + Math.round(d.ddCap * 100) + '% drawdown cap' };
  }
  if (d.type === 'disc') {
    const qa = a.n >= (d.minDays || 3) && a.avg != null, qb = b.n >= (d.minDays || 3) && b.avg != null;
    if (qa && qb) { lead = cmp(a.avg, b.avg); why = lead ? 'higher average Discipline' : 'same average'; }
    else if (qa !== qb) { lead = qa ? 'a' : 'b'; why = 'the other side traded fewer than ' + (d.minDays || 3) + ' days'; }
    else why = 'neither has ' + (d.minDays || 3) + ' trading days yet';
  } else if (d.type === 'clean') { lead = cmp(a.score, b.score) || (a.avg != null && b.avg != null ? cmp(a.avg, b.avg) : null); why = lead ? 'more clean days' : 'level'; }
  else if (d.type === 'survive') {
    if (a.fell && b.fell) { lead = a.fell > b.fell ? 'a' : b.fell > a.fell ? 'b' : null; why = lead ? 'lasted longer' : 'both fell the same day'; }
    else if (a.fell || b.fell) { lead = a.fell ? 'b' : 'a'; why = 'still standing'; }
    else why = 'both still standing';
  } else if (d.type === 'journal' || d.type === 'xp') { lead = cmp(a.score, b.score); why = lead ? (d.type === 'xp' ? 'more process XP' : 'more journaled days') : 'level'; }
  else if (d.type === 'ret') {
    // with a minimum of trading days (duels from before it have none), a side short of it loses to one that has it
    const min = d.minDays || 0, qa = a.score != null && a.n >= min, qb = b.score != null && b.n >= min;
    if (qa && qb) { lead = cmp(a.score, b.score); why = lead ? 'higher % return' : 'same return'; }
    else if (qa !== qb && a.score != null && b.score != null) { lead = qa ? 'a' : 'b'; why = 'the other side traded fewer than ' + min + ' days'; }
    else if (a.score != null && b.score != null) why = 'neither has ' + min + ' trading days yet';
    else why = 'waiting for on-chain data';
  }
  return { a, b, lead, why };
}


// ---- the ladder: an Elo-style rating, moved by 1v1 results ----
const RATING0 = 1000, RESET = 0.25; // where everyone starts; how far a new season pulls a rating back towards it
// ra, rb: the two ratings; sa: a's result (1 won, 0.5 drew, 0 lost) -> the new ratings. Whole points, and
// what one side gains the other loses.
function elo(ra, rb, sa, k) {
  const ea = 1 / (1 + Math.pow(10, (rb - ra) / 400)), delta = Math.round((k || DEFAULTS.k) * (sa - ea));
  return { a: ra + delta, b: rb - delta, delta };
}
const softReset = r => Math.round(RATING0 + (r - RATING0) * (1 - RESET));

// ---- group duels ("pods"): 3 to 6 members, each scored like one side of a duel, then ranked ----
const POD_TYPES = ['disc', 'clean', 'survive', 'journal', 'xp', 'ret'];
const POD_RULES = { disc: 'Highest average daily Discipline wins.', clean: 'Most trading days at 70+ Discipline wins.',
  survive: 'A trading day under 70 Discipline puts you out. The last one standing wins.', journal: 'Most days with every trade journaled and the day reviewed wins.',
  xp: 'Most XP earned from process wins. Profit earns none.', ret: 'Highest % return wins. Past the drawdown cap you’re out.' };
// The pod's terms -> the stored shape, or {error}. No stakes; a drawdown cap like a 1v1's.
function sanitizePodTerms(b, cfg) {
  b = b || {};
  if (!POD_TYPES.includes(b.type)) return { error: 'Pick what to compete on.' };
  cfg = cfg || DEFAULTS; const risk = cfg.risk || RISK_DEFAULTS;
  const t = sanitizeTerms(Object.assign({}, b, { stake: 0, ddCap: b.type !== 'ret' && risk.pod === 'off' ? null : b.ddCap }), Object.assign({}, cfg, { risk: Object.assign({}, risk, { duel: risk.pod }) })); if (t.error) return t;
  return { type: t.type, period: t.period, verified: t.verified, minDays: t.minDays, ddCap: t.ddCap, msg: t.msg };
}
// sides: [{id, s: sideScore(...), out}] (out: forfeited, or the wallet moved) -> the same, ranked, each with
// a place (equal results share it), plus the sole leader's id (null when the top is shared) and why
function podRank(p, sides) {
  const min = p.minDays || 3;
  const key = x => { const s = x.s || {};
    if (x.out) return [0];
    if (p.type === 'disc') return s.n >= min && s.avg != null ? [2, s.avg] : [1];
    if (p.type === 'ret') return s.score != null && s.n >= (p.minDays || 0) ? [2, s.score] : [1];
    if (p.type === 'survive') return s.fell ? [1, Date.parse(s.fell)] : [2];
    if (p.type === 'clean') return [1, s.score || 0, s.avg || 0];
    return [1, s.score || 0]; };
  const cmp = (a, b) => { for (let i = 0; i < Math.max(a.length, b.length); i++) { const d = (b[i] || 0) - (a[i] || 0); if (d) return d; } return 0; };
  const rows = sides.map(x => Object.assign({}, x, { key: key(x) })).sort((a, b) => cmp(a.key, b.key));
  rows.forEach((r, i) => { r.place = i && !cmp(rows[i - 1].key, r.key) ? rows[i - 1].place : i + 1; });
  const top = rows.filter(r => r.place === 1), lead = top.length === 1 && top[0].key[0] > 0 ? top[0].id : null;
  const why = !lead ? (rows.length && rows[0].key[0] === 0 ? 'everyone is out' : 'level at the top')
    : p.type === 'disc' ? 'highest average Discipline' : p.type === 'survive' ? 'last one standing' : p.type === 'clean' ? 'most clean days'
    : p.type === 'xp' ? 'most process XP' : p.type === 'ret' ? 'highest % return' : 'most journaled days';
  // q: placed on merit, so a pot can pay them (not out, and with the agreed trading days where those count);
  // alive: still in it at the end (a last-one-standing duel: never fell) — who "survivors split" pays
  const need = ['disc', 'ret'].includes(p.type) ? 2 : 1;
  rows.forEach(r => { r.q = r.key[0] >= need; r.alive = p.type === 'survive' ? r.key[0] === 2 : r.q; delete r.key; });
  return { rows, lead, why };
}

module.exports = { RISK_DEFAULTS, RISK_MODES, LEAGUE_RISK_MODES, sanitizeRiskCfg, ddCheck, ddModeFor, retMinDays, TYPES, DEFAULTS, sanitizeDuelCfg, sanitizeTerms, stakeRoom, windowFor, sideScore, standing, keyOf,
  RATING0, RESET, elo, softReset, POD_TYPES, POD_RULES, sanitizePodTerms, podRank };
