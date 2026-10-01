'use strict';
// Social layer for Pulse (v0.1): members, weekly leagues, leaderboards, competitions,
// following, a feed with kudos, members' posts (trades, plans, notes, pictures, comments), and
// the owner's admin endpoints. Everything lives on the owner's server, in an SQLite database
// (DATA_DIR/pulse.db, see db.js) and DATA_DIR/media/; there is no central service.
//
// Trust model, stated plainly:
//   - Process numbers (XP, level, streak, daily process scores) are computed by each
//     member's own browser from their own journal and posted here. They are self-reported.
//   - Money numbers (30-day return, drawdown, P&L) are NEVER taken from the client: the
//     server reads them from Hyperliquid's public portfolio endpoint for the member's
//     address, and only when the member opted in to showing them.
//   - The Discipline score on boards and in discipline competitions is NOT taken from the client:
//     with "verify" on, the server recomputes it from the member's public fills (behaviorFor,
//     the same pzBehaviorDays the app runs) and only those verified days count there.
//   - Giving an address proves nothing. Claiming one does (v0.3): the member signs a
//     Sign-In with Ethereum message (EIP-4361) with that wallet; the server wrote the message
//     and keeps it by nonce, and recovers the signer itself (vendor/eth-sig.js). A claimed
//     wallet is locked to one profile: nobody else can name it, and only another signature
//     from that wallet moves it. The owner can require a claim before any wallet-derived
//     number (verified Discipline, returns, P&L) counts.
//   - A member is identified by random keys kept in their browsers (header X-Pulse-Key);
//     only their SHA-256 is stored. A new device gets its own key by signing in with the
//     claimed wallet, or with a one-time code from a signed-in device. The owner's
//     AUTH_TOKEN gates the admin endpoints.
//   - The journal sync (vault) is end-to-end encrypted: the browser encrypts with a key from
//     the member's passphrase before sending, so this server only ever stores ciphertext.
//
// Pure helpers are exported for tests; createSocial() wires them to HTTP.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const SC = require('./social-config.js');
const Store = require('./db.js');
const Push = require('./push.js');
// Ethereum signature recovery for wallet claims (vendored noble libraries, no install needed)
let ethSig = null; try { ethSig = require('./vendor/eth-sig.js'); } catch (e) { /* claims and wallet sign-in answer 501 */ }

const TIERS = ['Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond'];
const LEVELS = ['Rookie', 'Apprentice', 'Journeyman', 'Disciplined', 'Consistent', 'Professional', 'Veteran', 'Master', 'Grandmaster', 'Legend'];
const HANDLE_RE = /^[A-Za-z0-9_]{3,20}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const WEEK_RE = /^\d{4}-W\d{2}$/;
const BADGE_RE = /^[a-z0-9-]{1,40}$/;
const MAX_SOCIAL_BODY = 64 * 1024;
const MAX_AVATAR = 256 * 1024;              // a profile picture, already shrunk to a small square by the app
const MAX_IMAGE = 1536 * 1024;              // one image on a post
const MAX_MEDIA_TOTAL = 2 * 1024 * 1024 * 1024; // every uploaded image together
const POSTS_PER_DAY = 10, MEDIA_PER_DAY = 40, POST_EDIT_MS = 15 * 60000;
const MAX_VAULT_BODY = 6 * 1024 * 1024;   // one encrypted journal (the ciphertext is base64: ~4.5 MB of journal)
const MAX_VAULT_TOTAL = 1024 * 1024 * 1024; // all members' encrypted journals together
const MAX_KEYS = 10;                       // signed-in devices per member; the oldest drops out
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const MAX_MEMBERS = 5000;
const STREAK_MARKS = [7, 14, 21, 30, 50, 75, 100, 150, 200, 365];
const COMP_TYPES = ['discipline', 'survivor', 'journal', 'return'];
const DEFAULT_CONFIG = { open: true, inviteCode: '', unlocksOn: true, requireClaim: false, vaultOn: true,
  unlocks: { trends: 2, share: 3, compete: 4 } };
const SHARE_KEYS = ['profile', 'boards', 'global', 'page', 'feed', 'habits', 'verify', 'ret', 'usd', 'addr', 'mentor'];
// mentor: the league's mentors can see your trading days (scores, slips, the lesson you wrote) and comment on them — opt-in
// global: appear on the server-wide leaderboards (every member, every league) — opt-in
// page: a public badge page at /b/<name> that anyone with the link can open — opt-in
const DEFAULT_SHARE = { profile: true, boards: true, global: false, page: false, feed: true, habits: true, verify: true, ret: false, usd: false, addr: false, mentor: false };

const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const clampNum = (v, lo, hi) => { const n = +v; return isFinite(n) ? Math.min(hi, Math.max(lo, n)) : null; };
// invite codes are compared in constant time
const sameText = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
// a post's text keeps its line breaks (at most one blank line in a row); other control characters go
const cleanPost = (s, max) => String(s == null ? '' : s).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ')
  .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, max);
const cleanText = (s, max) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
const utcDayKey = ms => new Date(ms).toISOString().slice(0, 10);
const addDaysKey = (k, n) => utcDayKey(Date.parse(k + 'T00:00:00Z') + n * 86400000);
// ISO week ('GGGG-Www') of a 'YYYY-MM-DD' key — same math as the client's isoWeekOfKey.
function isoWeekOfKey(k) {
  const d = new Date(k + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7) + 3);
  const ft = new Date(Date.UTC(d.getUTCFullYear(), 0, 4)); ft.setUTCDate(ft.getUTCDate() - ((ft.getUTCDay() + 6) % 7) + 3);
  return d.getUTCFullYear() + '-W' + String(1 + Math.round((d - ft) / (7 * 86400000))).padStart(2, '0');
}
const avg = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;

// ---- validation of what a member's browser posts ----
const SLIP_KEYS = ['revenge', 'afterTwo', 'sizeUp', 'addLoser', 'overtrade', 'heldLoser'];
const PARTNER_MAX = 3, INBOX_MAX = 40, COMMENTS_MAX = 300;
function sanitizeStats(b) {
  b = b || {};
  // per day: process score, bonus logged, journaled, reviewed, the slips (by key) and the lesson
  // written that night — the lesson is only kept for members who let mentors see their days
  const days = (Array.isArray(b.days) ? b.days : []).slice(-60)
    .filter(d => d && DAY_RE.test(d.k)).map(d => { const o = { k: d.k, s: clampNum(d.s, 0, 100) || 0, b: !!d.b, j: !!d.j };
      if (d.r) o.r = true;
      const f = Array.isArray(d.f) ? [...new Set(d.f.filter(x => SLIP_KEYS.includes(x)))] : []; if (f.length) o.f = f;
      const l = cleanText(d.l, 200); if (l) o.l = l;
      return o; });
  // earned badges: id, title, category, tier (0 bronze … 5 legend), day earned
  const seenB = new Set();
  const badges = (Array.isArray(b.badges) ? b.badges : []).slice(0, 400)
    .filter(x => x && BADGE_RE.test(x.id) && !seenB.has(x.id) && seenB.add(x.id)).map(x => ({ id: x.id, t: cleanText(x.t, 60), c: cleanText(x.c, 20), r: Math.round(clampNum(x.r, 0, 5) || 0), k: DAY_RE.test(x.k) ? x.k : null, d: cleanText(x.d, 120) }));
  const habits = (Array.isArray(b.habits) ? b.habits : []).slice(0, 20).map(h => cleanText(h, 140)).filter(Boolean).slice(0, 5);
  // XP by day, so a season ranks on exactly its own days (weeks straddle month ends)
  const xpDays = {}; if (b.xpDays && typeof b.xpDays === 'object' && !Array.isArray(b.xpDays))
    for (const k of Object.keys(b.xpDays).filter(k => DAY_RE.test(k)).sort().slice(-100)) { const v = clampNum(b.xpDays[k], 0, 1e5); if (v) xpDays[k] = Math.round(v); }
  return {
    xp: clampNum(b.xp, 0, 1e8) || 0, level: clampNum(b.level, 1, 500) || 1,
    week: WEEK_RE.test(b.week) ? b.week : null, weekXp: clampNum(b.weekXp, 0, 1e6) || 0,
    streak: clampNum(b.streak, 0, 10000) || 0, best: clampNum(b.best, 0, 10000) || 0, shields: clampNum(b.shields, 0, 2) || 0,
    challengesDone: clampNum(b.challengesDone, 0, 10000) || 0, lastChallenge: cleanText(b.lastChallenge, 140),
    tz: typeof b.tz === 'string' && /^[A-Za-z_+\-/0-9]{1,40}$/.test(b.tz) ? b.tz : 'UTC',
    badges, badgeN: clampNum(b.badgeN, 0, 10000) || badges.length, badgeTotal: clampNum(b.badgeTotal, 0, 10000) || 0, habits, days, xpDays,
  };
}
function sanitizeShare(s, prev) {
  // a new member gets the defaults; an existing one keeps what they had, and a key added later
  // (like verify) stays OFF until they switch it on themselves
  const out = prev ? Object.assign({}, DEFAULT_SHARE, { verify: false }, prev) : Object.assign({}, DEFAULT_SHARE);
  for (const k of SHARE_KEYS) if (s && typeof s[k] === 'boolean') out[k] = s[k];
  return out;
}
// Average process score over the trading days in [fromKey, toKey], or null below minDays.
function disciplineOver(days, fromKey, toKey, minDays) {
  const ds = (days || []).filter(d => d.k >= fromKey && d.k <= toKey);
  return ds.length >= (minDays || 1) ? { avg: avg(ds.map(d => d.s)), n: ds.length } : { avg: null, n: ds.length };
}

// ---- feed events from the change between two stats posts ----
function eventsFromStats(prev, next, share, titles) {
  if (!prev || !share || !share.feed) return [];
  const E = [], T = titles && titles.length ? titles : LEVELS;
  if (next.level > prev.level) E.push({ type: 'level', text: 'reached level ' + next.level + ' · ' + T[Math.min(next.level, T.length) - 1] });
  const mark = STREAK_MARKS.filter(m => prev.streak < m && next.streak >= m).pop();
  if (mark) E.push({ type: 'streak', text: 'hit a ' + mark + '-day discipline streak' });
  const had = new Set((prev.badges || []).map(b => b.id));
  const fresh = next.badges.filter(b => !had.has(b.id));
  // a handful post one by one; a burst (a first sync, a big day) posts once, naming the best ones
  if (fresh.length <= 2) for (const b of fresh) E.push({ type: 'badge', text: 'unlocked ' + (b.t || b.id) });
  else { const top = [...fresh].sort((a, b) => (b.r || 0) - (a.r || 0)).slice(0, 3).map(b => b.t || b.id);
    E.push({ type: 'badge', text: 'unlocked ' + fresh.length + ' badges', quote: top.join(' · ') }); }
  if (next.challengesDone > prev.challengesDone)
    E.push({ type: 'challenge', text: 'completed the weekly challenge', quote: next.lastChallenge || '' });
  if (share.habits) {
    const old = new Set(prev.habits || []);
    for (const h of next.habits) if (!old.has(h)) E.push({ type: 'habit', text: 'adopted a habit', quote: h });
  }
  return E.slice(0, 6);
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
  const P = pn.filter(inWin); if (P.length < 2) return null;
  const startAv = (av.filter(p => p[0] <= P[0][0]).pop() || av.find(inWin) || [0, 0])[1];
  if (!(startAv > 0)) return null;
  const base = P[0][1];
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
    if (t < TIERS.length - 1) for (const e of sorted.slice(0, k)) if (val(e) > 0) moves.push({ id: e.id, from: t, to: t + 1 });
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
function boardRows(members, board, opts) {
  opts = opts || {};
  const B = Object.prototype.hasOwnProperty.call(BOARDS, board) ? BOARDS[board] : null; if (!B) return null;
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
      if (board === 'ret') { if (mo.dd > 0.25) continue; v = mo.ret; sub = 'DD ' + (mo.dd * 100).toFixed(1) + '%'; }
      else if (board === 'riskadj') { v = mo.ret / Math.max(mo.dd, 0.005); sub = (mo.ret >= 0 ? '+' : '') + (mo.ret * 100).toFixed(1) + '% · DD ' + (mo.dd * 100).toFixed(1) + '%'; }
      else if (board === 'usd') { v = mo.usd; sub = 'DD ' + (mo.dd * 100).toFixed(1) + '%'; }
    }
    rows.push({ id: m.id, handle: m.handle, tier: m.tier || 0, value: v, sub });
  }
  rows.sort((a, b) => b.value - a.value || a.handle.localeCompare(b.handle));
  rows.forEach((r, i) => { r.rank = i + 1; });
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
function compStandings(c, members, todayKey, requireClaim) {
  const byId = new Map(members.map(m => [m.id, m]));
  const rows = [];
  for (const id of Object.keys(c.entrants || {})) {
    const m = byId.get(id); if (!m || m.banned) continue;
    const days = ((m.stats && m.stats.days) || []).filter(d => d.k >= c.start && d.k <= c.end && d.k <= todayKey);
    let score = null, note = '', out = false;
    if (c.type === 'discipline') {
      // verified days only: recomputed by the server from the member's own fills
      const vd = m.share && m.share.verify && Array.isArray(m.vdays) ? m.vdays.filter(d => d.k >= c.start && d.k <= c.end && d.k <= todayKey) : null;
      if (!vd) { rows.push({ id, handle: m.handle, score: null, out: false,
        note: !(m.share && m.share.verify) ? 'Needs verification: switch on “Verify my discipline”' : !m.address ? 'Needs a wallet to verify'
          : requireClaim && m.claimed !== m.address ? 'Needs a claimed wallet' : 'Verifying from fills…' }); continue; }
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
      if (!r) note = 'waiting for data';
      else if (c.ddCap && r.dd > c.ddCap) { out = true; score = -Infinity; note = 'Over the ' + Math.round(c.ddCap * 100) + '% drawdown cap'; }
      else { score = r.ret; note = (r.ret >= 0 ? '+' : '') + (r.ret * 100).toFixed(1) + '% · DD ' + (r.dd * 100).toFixed(1) + '%'; }
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
    ddCap: type === 'return' ? (clampNum(b.ddCap, 0.01, 0.9) || 0.08) : null };
}

// ---- members' own posts: a trade they took, one they plan to take, or a note ----
// The owner's switches: posts at all, planned-trade posts, images on posts.
function sanitizePostCfg(b, prev) {
  const o = Object.assign({ on: true, plans: true, images: true }, prev || {});
  if (b && typeof b === 'object') for (const k of ['on', 'plans', 'images']) if (typeof b[k] === 'boolean') o[k] = b[k];
  return o;
}
const POST_KINDS = ['trade', 'plan', 'note'];
const TRADE_STATUS = ['planned', 'open', 'closed', 'cancelled'];
const COIN_RE = /^[A-Za-z0-9@/:._-]{1,24}$/;
const MEDIA_RE = /^[a-f0-9]{24}$/;
const price = v => { const n = +v; return v != null && v !== '' && isFinite(n) && n > 0 && n < 1e12 ? +n.toPrecision(10) : null; };
const stamp = v => { const n = Math.round(+v); return isFinite(n) && n > 1.5e12 && n < 4e12 ? n : null; };
// What a trade post carries. The plan's levels (entry, stop, target) are fixed once posted; later
// updates only add what happened (status, exit, times, result). R and % come from the prices
// whenever they're there, so a member can't post a result the levels don't support.
function sanitizeTrade(b, prev, opts) {
  opts = opts || {};
  if (!b || typeof b !== 'object') return prev || null;
  const t = prev ? Object.assign({}, prev) : {};
  if (!prev) {
    const coin = String(b.coin || '').trim(); if (!COIN_RE.test(coin)) return null;
    const side = b.side === 'short' || b.side === 'Short' ? 'short' : b.side === 'long' || b.side === 'Long' ? 'long' : null; if (!side) return null;
    Object.assign(t, { coin, side, entry: price(b.entry), stop: price(b.stop), target: price(b.target),
      setup: cleanText(b.setup, 40), tf: cleanText(b.tf, 12) });
    // a spot pair is '@107' in fills: the app sends the pair's name to show instead (perps show the coin itself)
    const label = String(b.label || '').trim(); if (/^@\d+$/.test(coin) && /^[A-Za-z0-9]{1,16}(\/[A-Za-z0-9]{1,12})?$/.test(label)) t.label = label;
    if (t.entry == null) return null;
    // a stop a hair from the entry would make any move look like a huge R
    if (t.stop != null && Math.abs(t.entry - t.stop) / t.entry < 0.0005) return null;
    // a stop or target on the wrong side of the entry is a typo, not a plan
    const dir = side === 'long' ? 1 : -1;
    if (t.stop != null && (t.stop - t.entry) * dir >= 0) return null;
    if (t.target != null && (t.target - t.entry) * dir <= 0) return null;
    t.status = opts.kind === 'plan' ? 'planned' : 'open';
  }
  const order = { planned: 0, open: 1, closed: 2, cancelled: 2 }, cur = t.status;
  if (TRADE_STATUS.includes(b.status)) {
    // a new plan starts planned and a new trade open or closed; after that, forward only: a closed
    // trade doesn't reopen, and only a plan that never happened can be cancelled
    const ok = !prev ? (opts.kind === 'plan' ? b.status === 'planned' : b.status === 'open' || b.status === 'closed')
      : order[b.status] > order[cur] && (b.status !== 'cancelled' || cur === 'planned');
    if (ok) t.status = b.status;
  }
  // times: a planned trade can't have opened before it was posted (notBefore), and closes after it opens
  const nb = opts.notBefore || 0;
  if (t.status === 'closed' || t.status === 'open') { const o = stamp(b.openedAt); if (o != null && t.openedAt == null && o >= nb) t.openedAt = o; }
  if (t.status === 'closed') { const ex = price(b.exit); if (ex != null && t.exit == null) t.exit = ex;
    const c = stamp(b.closedAt); if (c != null && t.closedAt == null && c >= nb && (t.openedAt == null || c >= t.openedAt)) t.closedAt = c; }
  const dir = t.side === 'long' ? 1 : -1;
  // the result is worked out once, when the exit is first known, and never rewritten
  if (t.status === 'closed' && t.exit != null && t.pct == null) {
    t.pct = Math.round(dir * (t.exit - t.entry) / t.entry * 10000) / 100;
    const r = t.stop != null ? dir * (t.exit - t.entry) / Math.abs(t.entry - t.stop) : clampNum(b.r, -100, 100);
    if (r != null) t.r = Math.round(Math.max(-100, Math.min(100, r)) * 100) / 100;
    const usd = clampNum(b.usd, -1e9, 1e9); if (usd != null && opts.usd) t.usd = Math.round(usd * 100) / 100;
  }
  if (t.status !== 'closed') { delete t.pct; delete t.r; delete t.usd; }
  return t;
}
// ---- the HTTP side ----
// Sign-In with Ethereum (EIP-4361) message text. Wallets recognise this format and check the
// domain against the page they're on, so it has to be the host the member is looking at.
function siweMessage(o) {
  return o.domain + ' wants you to sign in with your Ethereum account:\n' + o.address + '\n\n' + o.statement + '\n\n'
    + 'URI: ' + o.uri + '\nVersion: 1\nChain ID: 1\nNonce: ' + o.nonce + '\nIssued At: ' + o.issuedAt
    + (o.expirationTime ? '\nExpiration Time: ' + o.expirationTime : '');
}
// An encrypted journal as the browser sends it. Only its shape is checked: the server can't read it.
function sanitizeVaultBlob(b) {
  if (!b || typeof b !== 'object' || b.v !== 1) return null;
  const iter = +b.iter;
  if (!Number.isInteger(iter) || iter < 100000 || iter > 5000000) return null;
  for (const [k, max] of [['salt', 64], ['iv', 32], ['ct', MAX_VAULT_BODY]])
    if (typeof b[k] !== 'string' || !b[k] || b[k].length > max || b[k].length % 4 || !B64_RE.test(b[k])) return null;
  return { v: 1, iter, salt: b.salt, iv: b.iv, ct: b.ct };
}

function createSocial(opts) {
  const legacyFile = path.join(opts.dataDir, 'social.json');
  const json = opts.json, authOk = opts.authOk, adminConfigured = !!opts.adminConfigured;
  const fetchImpl = opts.fetchImpl || ((...a) => globalThis.fetch(...a));
  const now = opts.now || (() => Date.now());
  // ---- storage: SQLite in DATA_DIR/pulse.db (db.js) ----
  const store = Store.open(opts.dataDir), q = store.q, tx = store.tx;
  // the first start on SQLite brings the old JSON file over, once
  if (!q('SELECT 1 FROM kv LIMIT 1').get() && !q('SELECT 1 FROM members LIMIT 1').get()) {
    let old = null; try { old = JSON.parse(fs.readFileSync(legacyFile, 'utf8')); } catch (e) {}
    if (old && old.v === 1) { Store.importJson(store, old); try { fs.renameSync(legacyFile, legacyFile + '.migrated'); } catch (e) {} }
  }
  const KV_KEYS = ['config', 'follows', 'comps', 'league', 'leagues', 'badges', 'ownerCoach', 'partners', 'comments', 'leagueSeq'];
  let S = { v: 1, members: {} };
  for (const r of q('SELECT k, v FROM kv').all()) if (KV_KEYS.includes(r.k)) try { S[r.k] = JSON.parse(r.v); } catch (e) {}
  for (const r of q('SELECT data FROM members').all()) try { const m = JSON.parse(r.data); if (m && m.id) S.members[m.id] = m; } catch (e) {}
  if (!S.config || typeof S.config !== 'object') S.config = {};
  if (!S.follows || typeof S.follows !== 'object') S.follows = {};
  if (!S.comps || typeof S.comps !== 'object') S.comps = {};
  if (!S.league || typeof S.league !== 'object') S.league = { week: null };
  S.config = Object.assign({}, DEFAULT_CONFIG, S.config, {
    unlocks: Object.assign({}, DEFAULT_CONFIG.unlocks, S.config && S.config.unlocks) });
  delete S.config.themes; // colour themes were dropped
  // v0.4 sections; v0.3's three unlock levels carry over into the feature map
  S.config.modules = SC.sanitizeModules(S.config.modules || S.config.unlocks, null);
  S.config.levels = SC.sanitizeLevels(S.config.levels, null);
  S.config.xp = SC.sanitizeXp(S.config.xp, null);
  S.config.coach = SC.sanitizeCoachCfg(S.config.coach, null);
  S.config.profiles = SC.sanitizeProfiles(S.config.profiles, null);
  S.config.posts = sanitizePostCfg(S.config.posts, null);
  if (!S.badges || typeof S.badges !== 'object') S.badges = {};
  if (!S.ownerCoach) S.ownerCoach = { k: null, n: 0 };
  if (!S.partners || typeof S.partners !== 'object') S.partners = {};
  if (!S.comments || typeof S.comments !== 'object') S.comments = {};
  if (!S.leagues || typeof S.leagues !== 'object') { // one league for everyone until the owner makes more
    S.leagues = { main: Object.assign({ id: 'main', createdAt: Date.now(), members: {}, week: S.league.week },
      SC.sanitizeLeague({ name: 'Main league', metric: 'xp', tiers: true, open: true, autoJoin: true })) };
    for (const m of Object.values(S.members)) S.leagues.main.members[m.id] = { tier: m.tier || 0, at: m.createdAt || Date.now() };
  }
  // every league has a short number people can search for (#1001, #1002, …)
  if (!(S.leagueSeq > 1000)) S.leagueSeq = 1000;
  for (const L of Object.values(S.leagues)) if (!L.num) L.num = ++S.leagueSeq;
  // Writes go out as rows: save(m, 'partners', …) writes that member and those sections, save()
  // with nothing named checks everything. A row is only written when its JSON changed (a digest of
  // the last copy written is kept), and each save is one transaction.
  const written = new Map(), dirty = new Set();
  const digest = s => crypto.createHash('sha1').update(s).digest('base64');
  // what was written is only remembered once the transaction commits: a failed save is tried again next time
  let fresh = null;
  const writeRow = (key, val) => { if (val === undefined) return; const s = JSON.stringify(val), d = digest(s); if (written.get(key) === d) return; fresh.set(key, d);
    if (key.startsWith('m:')) q('INSERT OR REPLACE INTO members (id, data) VALUES (?, ?)').run(key.slice(2), s); else q('INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)').run(key, s); };
  const touch = (...xs) => { for (const x of xs) if (typeof x === 'string') dirty.add(x); else if (x && x.id) dirty.add('m:' + x.id); };
  const save = (...xs) => { const all = !xs.length; touch(...xs);
    if (all || dirty.has('follows')) folCount = null;
    fresh = new Map();
    tx(() => {
      if (all) { for (const k of KV_KEYS) writeRow(k, S[k]); for (const m of members()) writeRow('m:' + m.id, m); }
      else for (const k of dirty) { if (!k.startsWith('m:')) writeRow(k, S[k]); else if (own(S.members, k.slice(2))) writeRow(k, S.members[k.slice(2)]); }
    });
    for (const [k, d] of fresh) written.set(k, d); dirty.clear(); };
  // lookups by device key and by name, rebuilt after anything that changes keys or names
  let keyIdx = null, handleIdx = null, folCount = null;
  const reindex = () => { keyIdx = null; handleIdx = null; };
  const sig = opts.sig !== undefined ? opts.sig : ethSig;
  const vaultDir = path.join(opts.dataDir, 'vault');
  const vaultFile = id => path.join(vaultDir, String(id).replace(/[^a-f0-9]/g, '') + '.json');
  const members = () => Object.values(S.members);
  // a member has one key per device: keyHash from joining, keyHashes from wallet sign-ins and device codes
  const byKey = req => { const k = req.headers['x-pulse-key']; if (!k || typeof k !== 'string' || k.length > 128) return null;
    if (!keyIdx) { keyIdx = new Map(); for (const m of members()) { if (m.keyHash) keyIdx.set(m.keyHash, m.id); for (const h of m.keyHashes || []) keyIdx.set(h, m.id); } }
    const h = sha(k), id = keyIdx.get(h), m = id && own(S.members, id) ? S.members[id] : null;
    return m && (m.keyHash === h || (Array.isArray(m.keyHashes) && m.keyHashes.includes(h))) ? m : null; };
  const addKey = m => { const key = crypto.randomBytes(24).toString('hex');
    m.keyHashes = [...(Array.isArray(m.keyHashes) ? m.keyHashes : []), sha(key)].slice(-MAX_KEYS); reindex(); return key; };
  // the wallet whose on-chain numbers count for this member: any address they gave, or, when the
  // owner requires claims, only a wallet they proved is theirs by signing
  const walletFor = m => !m.address ? null : S.config.requireClaim && m.claimed !== m.address ? null : m.address;
  const claimedBy = (addr, notId) => addr ? members().find(o => o.id !== notId && o.claimed === addr) || null : null;
  // simple per-IP rate limits: n requests per window
  const ipOf = opts.clientIp || (req => (req.socket && req.socket.remoteAddress) || '');
  const origins = (opts.publicOrigins || []).map(o => { try { const u = new URL(o); return { host: u.host.toLowerCase(), origin: u.origin }; } catch (e) { return null; } }).filter(Boolean);
  const limits = new Map();
  const limited = (req, bucket, n, windowMs) => { const k = bucket + '|' + ipOf(req);
    const recent = (limits.get(k) || []).filter(t => now() - t < windowMs);
    if (recent.length >= n) { limits.set(k, recent); return true; }
    recent.push(now()); limits.set(k, recent);
    if (limits.size > 20000) for (const [kk, v] of limits) if (!v.length || now() - v[v.length - 1] > 3600000) limits.delete(kk);
    return false; };
  const pending = new Map(); // SIWE nonce -> the message the server wrote, single use, 10 minutes
  const links = new Map();   // one-time device code -> member, single use, 10 minutes
  const sweep = map => { for (const [k, v] of map) if (v.exp < now()) map.delete(k);
    while (map.size > 5000) map.delete(map.keys().next().value); };
  // revisions never go back, even across a delete: a device holding an old copy can't overwrite a new one
  const vaultRev = m => m.vault ? m.vault.rev : (m.vaultRev || 0);
  const vaultTotal = () => members().reduce((a, m) => a + (m.vault ? m.vault.size || 0 : 0), 0);
  // ---- leagues ----
  const leaguesOf = m => Object.values(S.leagues).filter(L => own(L.members, m.id));
  const joinLeague = (L, m) => { if (!own(L.members, m.id)) L.members[m.id] = { tier: 0, at: now() }; };
  const leagueTier = (L, m) => (own(L.members, m.id) ? L.members[m.id].tier || 0 : 0);
  // a league's own measure for one member over one week (rollover) or its current period (boards)
  // a monthly league's period: the weeks so far whose Monday is in the same month as this one's
  const monthOf = wk => isoWeekMonday(wk).slice(0, 7);
  const monthWeeks = wk => weeksBack(wk, 5).filter(w => monthOf(w) === monthOf(wk));
  const weeksBack = (wk, n) => { const mon = isoWeekMonday(wk); const out = []; for (let i = n - 1; i >= 0; i--) out.push(isoWeekOfKey(addDaysKey(mon, -7 * i))); return out; };
  const leagueValue = (m, L, wk) => {
    const st = m.stats || {}, mo = m.money;
    switch (L.metric) {
      case 'xp': return (L.period === 'month' ? monthWeeks(wk) : [wk]).reduce((a, w) => a + ((m.weekXp && m.weekXp[w]) || 0), 0);
      case 'discipline': { if (!(m.share.verify && Array.isArray(m.vdays))) return 0; const mon = isoWeekMonday(wk);
        const d = disciplineOver(m.vdays, L.period === 'month' ? isoWeekMonday(monthWeeks(wk)[0]) : mon, addDaysKey(mon, 6), 1); return d.avg || 0; }
      case 'streak': return st.streak || 0;
      case 'level': return st.xp || 0;
      case 'ret': return mo && mo.ret != null && m.share.ret ? mo.ret : 0;
      case 'usd': return mo && mo.usd != null && m.share.usd ? mo.usd : 0;
      case 'riskadj': return mo && mo.ret != null && m.share.ret ? mo.ret / Math.max(mo.dd, 0.005) : 0;
    } return 0; };
  // members of a league as boardRows sees them: their tier is the one in that league
  const leagueMembers = L => members().filter(m => own(L.members, m.id)).map(m => Object.assign({}, m, { tier: L.members[m.id].tier || 0 }));
  // the window a league ranks on: its season so far, else its month so far, else this week
  const leagueWindow = L => { const si = L.season ? seasonInfo(L) : null;
    if (si) return { dayFrom: si.start, dayTo: todayKey(), weeks: null, days: Math.round((Date.parse(todayKey()) - Date.parse(si.start)) / 86400000) + 1 };
    return L.period === 'month' ? { weeks: monthWeeks(S.league.week), days: monthDays() } : { weeks: null, days: 7 }; };
  const leagueBoard = (L, board, viewer) => { const W = leagueWindow(L); return boardRows(leagueMembers(L), board, {
    tier: L.tiers && board === L.metric && viewer ? leagueTier(L, viewer) : undefined, tierAll: true, week: S.league.week,
    weeks: board === 'xp' && W.weeks ? W.weeks : undefined, dayFrom: board === 'xp' ? W.dayFrom : undefined, dayTo: W.dayTo, days: W.days }); };
  // a monthly league's boards cover the month so far: the same window its rollover ranks on
  const monthDays = () => Math.max(1, Math.round((Date.parse(todayKey()) - Date.parse(isoWeekMonday(monthWeeks(S.league.week)[0]))) / 86400000) + 1);
  const leagueOut = (L, viewer) => ({ id: L.id, num: L.num, name: L.name, desc: L.desc, metric: L.metric, metricLabel: SC.LEAGUE_METRICS[L.metric], period: L.period,
    tiers: L.tiers, open: L.open, inviteRequired: !!L.invite, members: members().filter(m => own(L.members, m.id) && !m.banned).length,
    joined: !!viewer && own(L.members, viewer.id), tier: viewer && own(L.members, viewer.id) ? leagueTier(L, viewer) : null,
    tierName: viewer && own(L.members, viewer.id) ? TIERS[leagueTier(L, viewer)] : null, season: L.season ? seasonInfo(L) : null });
  // ---- levels, XP grants, reward badges ----
  const levelTitle = n => { const t = S.config.levels.titles; return t[Math.min(n, t.length) - 1] || ('Level ' + n); };
  const zoneKey = (tz, ms) => { try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms); }
    catch (e) { return utcDayKey(ms); } };
  const badgeValue = (m, metric) => {
    const st = m.stats || {}, mo = m.money;
    switch (metric) {
      case 'level': return st.level || 1;
      case 'xp': return st.xp || 0;
      case 'weekXp': return (m.weekXp && m.weekXp[S.league.week]) || 0;
      case 'streak': return st.streak || 0;
      case 'best': return st.best || 0;
      case 'discipline30': { const ver = m.share.verify && Array.isArray(m.vdays); const d = disciplineOver(ver ? m.vdays : st.days, addDaysKey(todayKey(), -29), todayKey(), 3); return d.avg; }
      case 'badges': return st.badgeN || 0;
      case 'challenges': return st.challengesDone || 0;
      case 'ret30': return mo && mo.ret != null && m.share.ret ? mo.ret * 100 : null;
      case 'usd30': return mo && mo.usd != null && m.share.usd ? mo.usd : null;
      case 'members': return Math.floor((now() - (m.createdAt || now())) / 86400000);
    } return null; };
  // earned automatically once a badge's measure crosses its value; kept from then on
  const awardCheck = m => {
    let changed = false;
    for (const b of Object.values(S.badges)) {
      if (!b.metric || (m.awards && own(m.awards, b.id)) || (m.revoked && own(m.revoked, b.id))) continue;
      const v = badgeValue(m, b.metric); if (v == null || !isFinite(v)) continue;
      if (b.op === 'lte' ? v <= b.value : v >= b.value) { m.awards = m.awards || {}; m.awards[b.id] = now(); changed = true;
        if (m.share.feed) pushEvent(m, { type: 'badge', text: 'earned the ' + b.name + ' badge ' + b.icon }); }
    }
    return changed; };
  const awardsOut = m => Object.keys(m.awards || {}).filter(id => own(S.badges, id)).map(id => ({ id, name: S.badges[id].name, icon: S.badges[id].icon, desc: S.badges[id].desc, xp: S.badges[id].xp, at: m.awards[id] }));
  // ---- AI coach allowance: per member per day (their own clock), or the owner's own budget ----
  const coachLimitFor = m => m.coachDaily != null ? m.coachDaily : m.unlocked ? S.config.coach.dailyUnlocked : S.config.coach.daily;
  // A member's coach day follows their own clock, but the zone is fixed for the day once they've
  // asked: changing time zones mid-day doesn't start a new count.
  const coachTz = m => (m.coachUse && m.coachUse.tz) || (m.stats && m.stats.tz) || 'UTC';
  const coachUsed = m => { if (!m.coachUse) return 0; const k = zoneKey(coachTz(m), now()); return m.coachUse.k === k ? m.coachUse.n : 0; };
  const coachStatusFor = m => {
    const c = S.config.coach, lvl = (m.stats && m.stats.level) || 1, need = S.config.unlocksOn && !m.unlocked && S.config.modules.coach > 1 ? S.config.modules.coach : 0;
    const limit = coachLimitFor(m), used = coachUsed(m);
    const reason = !c.members ? 'The owner hasn’t opened the coach to members.' : m.banned ? 'This profile was removed from the league.'
      : need && lvl < need ? 'The coach unlocks at level ' + need + '.' : limit <= 0 ? 'The coach is switched off for your profile.' : used >= limit ? 'You’ve used today’s ' + limit + ' coach message' + (limit === 1 ? '' : 's') + '. More tomorrow.' : null;
    return { allowed: !reason, reason, limit, used, remaining: Math.max(0, limit - used), detail: !!(c.detail && m.coachDetail), detailAllowed: !!c.detail, unlockLevel: need || null }; };
  const byHandle = h => { if (!handleIdx) { handleIdx = new Map(); for (const m of members()) handleIdx.set(m.handle.toLowerCase(), m.id); }
    const id = handleIdx.get(String(h || '').toLowerCase()), m = id && own(S.members, id) ? S.members[id] : null;
    return m && m.handle.toLowerCase() === String(h || '').toLowerCase() ? m : null; };
  const EVENTS_PER_DAY = 12;
  // ---- the feed: rows in the events table ----
  // automatic milestones are capped per member per day; members' own posts have their own limit
  const pushEvent = (m, e) => {
    if (m && q("SELECT count(*) AS n FROM events WHERE member = ? AND at > ? AND type != 'post'").get(m.id, now() - 86400000).n >= EVENTS_PER_DAY) return null;
    const id = crypto.randomBytes(6).toString('hex');
    q('INSERT INTO events (id, at, member, type, text, quote, data) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(id, now(), m ? m.id : null, String(e.type), String(e.text || ''), String(e.quote || ''), e.data ? JSON.stringify(e.data) : null);
    return id;
  };
  const eventById = id => typeof id === 'string' && /^[a-f0-9]{1,32}$/.test(id) ? q('SELECT * FROM events WHERE id = ?').get(id) || null : null;
  const todayKey = () => utcDayKey(now());
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  // a post is visible when its author is still here, not suspended, and shares that kind of post;
  // posts a member wrote themselves only need them to still be here
  const visible = (e, viewer) => { if (e.hidden) return false; if (!e.member) return true; const a = own(S.members, e.member) ? S.members[e.member] : null;
    if (!a || a.banned) return false; if (viewer && a.id === viewer.id) return true;
    if (e.type === 'post') return true;
    return !!a.share.feed && (e.type !== 'habit' || !!a.share.habits); };
  // images: files in DATA_DIR/media, a row each in the media table
  const mediaDir = path.join(opts.dataDir, 'media');
  const mediaFile = id => path.join(mediaDir, String(id).replace(/[^a-f0-9]/g, ''));
  const dropMedia = rows => { for (const r of rows) { q('DELETE FROM media WHERE id = ?').run(r.id); const f = mediaFile(r.id); store.afterCommit(() => { try { fs.unlinkSync(f); } catch (e) {} }); } };
  // one post (or milestone) and everything hanging off it
  const dropEvent = id => tx(() => {
    q('DELETE FROM kudos WHERE event = ?').run(id);
    q('DELETE FROM reports WHERE event = ? OR comment IN (SELECT id FROM comments WHERE event = ?)').run(id, id);
    q('DELETE FROM comments WHERE event = ?').run(id);
    dropMedia(q('SELECT id FROM media WHERE ref = ?').all('post:' + id));
    return q('DELETE FROM events WHERE id = ?').run(id).changes; });
  const dropComment = c => tx(() => { q('DELETE FROM reports WHERE comment = ?').run(c.id);
    if (q('DELETE FROM comments WHERE id = ?').run(c.id).changes) q('UPDATE events SET comments = max(0, comments - 1) WHERE id = ?').run(c.event); });
  const dropMember = (id) => { const gone = own(S.members, id) ? S.members[id].address : null;
    if (own(S.members, id) && S.members[id].vault) try { fs.unlinkSync(vaultFile(id)); } catch (e) {}
    delete S.members[id]; delete S.follows[id]; dropPairsOf(id); delete S.comments[id]; reindex();
    if (opts.onDrop) try { opts.onDrop(id); } catch (e) {}
    for (const k in S.comments) S.comments[k] = S.comments[k].filter(c => c.by !== id);
    for (const L of Object.values(S.leagues)) delete L.members[id];
    if (gone && opts.forgetAddress && !members().some(o => o.address === gone)) opts.forgetAddress(gone);
    for (const k in S.follows) S.follows[k] = S.follows[k].filter(x => x !== id);
    for (const c of Object.values(S.comps)) { delete c.entrants[id]; if (c.money) delete c.money[id]; }
    tx(() => {
      for (const e of q('SELECT id FROM events WHERE member = ?').all(id)) dropEvent(e.id);
      q('UPDATE events SET kudos = max(0, kudos - 1) WHERE id IN (SELECT event FROM kudos WHERE member = ?)').run(id);
      q('DELETE FROM kudos WHERE member = ?').run(id);
      for (const c of q('SELECT id, event FROM comments WHERE member = ?').all(id)) dropComment(c);
      q('DELETE FROM reports WHERE member = ?').run(id);
      dropMedia(q('SELECT id FROM media WHERE member = ?').all(id));
      q('DELETE FROM members WHERE id = ?').run(id); written.delete('m:' + id);
    }); };
  // weekly league rollover runs lazily on the first request of a new ISO week
  const ensureWeek = () => {
    const wk = isoWeekOfKey(todayKey());
    if (S.league.week === wk && Object.values(S.leagues).every(L => L.week === wk)) return;
    // each tiered league promotes and relegates on its own measure, once, on the first request of a new week
    for (const L of Object.values(S.leagues)) {
      if (L.week === wk) continue;
      // a monthly league promotes and relegates once, when the month changes, on the month it closed
      if (L.week && L.period === 'month' && monthOf(L.week) === monthOf(wk)) { L.week = wk; continue; }
      if (L.week && L.tiers) {
        const entries = members().filter(m => own(L.members, m.id)).map(m => ({ id: m.id, tier: leagueTier(L, m), banned: m.banned, value: leagueValue(m, L, L.week) }));
        for (const mv of leagueRolloverBy(entries)) {
          const m = S.members[mv.id]; if (!m) continue; L.members[mv.id].tier = mv.to;
          if (L.id === 'main') m.tier = mv.to;
          if (mv.to > mv.from && m.share && m.share.feed) pushEvent(m, { type: 'league', text: 'moved up to ' + TIERS[mv.to] + (L.id === 'main' ? ' league' : ' in ' + L.name) });
        }
      }
      L.week = wk;
    }
    S.league.week = wk; save();
    // milestones older than about a year leave the feed; members' posts and the owner's announcements stay
    tx(() => { const old = "SELECT id FROM events WHERE type NOT IN ('post', 'announce') AND at < ?", cut = now() - 400 * 86400000;
      q('DELETE FROM kudos WHERE event IN (' + old + ')').run(cut); q('DELETE FROM events WHERE id IN (' + old + ')').run(cut); });
  };
  // money stats: read from the chain for opted-in members, at most every 30 minutes each
  const moneyBusy = new Set();
  const refreshMoney = async (m, force) => {
    const addr = walletFor(m);
    if (!addr || !(m.share.ret || m.share.usd) || moneyBusy.has(m.id)) return;
    if (!force && m.money && now() - m.money.at < 30 * 60000) return;
    if (m.moneyFailAt && now() - m.moneyFailAt < 10 * 60000) return; // Hyperliquid erroring: don't hammer it
    moneyBusy.add(m.id);
    try {
      const r = await fetchImpl('https://api.hyperliquid.xyz/info', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'portfolio', user: addr }) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      const res = await r.json();
      if (!own(S.members, m.id) || walletFor(S.members[m.id]) !== addr) return; // wallet changed meanwhile
      const st = portfolioStats(res, 'month');
      m.money = st ? { ret: st.ret, dd: st.dd, usd: st.usd, at: now() } : { ret: null, dd: null, usd: null, at: now() };
      for (const c of Object.values(S.comps)) if (c.type === 'return' && c.entrants[m.id]) {
        const from = Date.parse(c.start + 'T00:00:00Z');
        // the 'month' series only reaches back 30 days; older windows need the coarser all-time one
        const s2 = portfolioStats(res, from >= now() - 29 * 86400000 ? 'month' : 'allTime', from, Date.parse(c.end + 'T23:59:59Z'));
        if (s2) { c.money = c.money || {}; c.money[m.id] = { ret: s2.ret, dd: s2.dd }; }
      }
      awardCheck(m); save(m, 'comps');
      m.moneyFailAt = 0;
    } catch (e) { m.moneyFailAt = now(); /* retried after the backoff; boards show what they have */ }
    finally { moneyBusy.delete(m.id); }
  };
  // verified Discipline: recomputed from the member's public fills, at most every 30 minutes each
  const behaviorBusy = new Set();
  const canVerify = !!opts.behaviorFor && opts.verifyAvailable !== false;
  const refreshBehavior = async (m, force) => {
    if (!canVerify || !walletFor(m) || !m.share.verify || behaviorBusy.has(m.id)) return;
    if (behaviorBusy.size >= 2) return; // two fetches at a time; the rest catch up on later requests
    if (!force && m.vAt && now() - m.vAt < 30 * 60000) return;
    if (m.vFailAt && now() - m.vFailAt < 10 * 60000) return;
    const addr = walletFor(m), tz = (m.stats && m.stats.tz) || 'UTC';
    behaviorBusy.add(m.id);
    try {
      const days = await opts.behaviorFor(addr, tz);
      if (!Array.isArray(days)) throw new Error('no data');
      // the member may have changed wallet (or left) while this was running
      const live = own(S.members, m.id) ? S.members[m.id] : null; if (!live || !live.share.verify || walletFor(live) !== addr) return;
      const keep = new Map((live.vdays || []).map(d => [d.k, d]));
      for (const d of days) if (d && DAY_RE.test(d.k)) keep.set(d.k, { k: d.k, s: clampNum(d.s, 0, 100) || 0, n: clampNum(d.n, 0, 1e5) || 0 });
      live.vdays = [...keep.values()].sort((a, b) => a.k < b.k ? -1 : 1).slice(-100);
      live.vAt = now(); live.vFailAt = 0; awardCheck(live); save(live);
    } catch (e) { m.vFailAt = now(); }
    finally { behaviorBusy.delete(m.id); }
  };
  const refreshAll = m => { refreshMoney(m); refreshBehavior(m); };
  const tierOf = m => ({ tier: m.tier || 0, tierName: TIERS[m.tier || 0] });
  // how many follow each member, counted once until the follows change
  const followersOf = id => { if (!folCount) { folCount = new Map();
      for (const [k, list] of Object.entries(S.follows)) if (own(S.members, k)) for (const x of list || []) folCount.set(x, (folCount.get(x) || 0) + 1); }
    return folCount.get(id) || 0; };
  const publicMember = (m, viewer) => {
    const st = m.stats || {};
    const out = { id: m.id, handle: m.handle, ...tierOf(m), level: st.level || 1, title: levelTitle(st.level || 1),
      followers: followersOf(m.id),
      following: (S.follows[m.id] || []).length, isFollowing: !!viewer && (S.follows[viewer.id] || []).includes(m.id), isMe: !!viewer && viewer.id === m.id,
      claimed: !!m.claimed, av: avUrl(m), bio: m.bio || '' };
    if (out.isMe) Object.assign(out, { claimedAddress: m.claimed || null, devices: (m.keyHash ? 1 : 0) + (Array.isArray(m.keyHashes) ? m.keyHashes.length : 0),
      vault: m.vault ? { rev: m.vault.rev, size: m.vault.size, at: m.vault.at } : null, requireClaim: !!S.config.requireClaim, vaultOn: !!S.config.vaultOn,
      unlocked: !!m.unlocked, grants: (m.grants || []).map(g => ({ id: g.id, xp: g.xp, why: g.why, at: g.at })), coach: coachStatusFor(m), coachDetail: !!m.coachDetail,
      leagues: leaguesOf(m).map(L => ({ id: L.id, name: L.name, tier: leagueTier(L, m) })), mentor: !!m.mentor,
      push: { on: !!(m.push && m.push.subs && m.push.subs.length), prefs: sanitizePrefs(null, m.push && m.push.prefs), available: !!push },
      inbox: (m.inbox || []).filter(x => x.at > (m.inboxRead || 0)).length,
      partners: pairsOf(m).filter(p => p.status === 'active').length });
    if (!m.share.profile && !out.isMe) return Object.assign(out, { private: true });
    const ver = m.share.verify && Array.isArray(m.vdays);
    const d30 = disciplineOver(ver ? m.vdays : st.days, addDaysKey(todayKey(), -29), todayKey(), 3);
    Object.assign(out, { xp: st.xp || 0, streak: st.streak || 0, best: st.best || 0, discipline30: d30.avg == null ? null : Math.round(d30.avg), verified: ver,
      badges: (st.badges || []).map(b => b.t || b.id), badgeN: st.badgeN || 0, awards: awardsOut(m) });
    if (m.share.habits || out.isMe) out.habits = st.habits || [];
    if ((m.share.ret || out.isMe) && m.money && m.money.ret != null) { out.ret = m.money.ret; out.dd = m.money.dd; }
    if ((m.share.usd || out.isMe) && m.money && m.money.usd != null) out.usd = m.money.usd;
    if ((m.share.addr || out.isMe) && m.address) out.address = m.address;
    return out;
  };
  const avUrl = m => m && m.avatar && !m.banned ? '/api/social/media/' + m.avatar : null;
  // feed rows as the app sees them; liked: the ids among them this viewer gave kudos to
  const likedBy = (viewer, rows) => { if (!viewer || !rows.length) return new Set();
    return new Set(q('SELECT event FROM kudos WHERE member = ? AND event IN (SELECT value FROM json_each(?))').all(viewer.id, JSON.stringify(rows.map(e => e.id))).map(r => r.event)); };
  const eventOut = (e, viewer, liked) => { const m = e.member && own(S.members, e.member) ? S.members[e.member] : null;
    const o = { id: e.id, at: e.at, type: e.type, text: e.text, quote: e.quote, handle: m ? m.handle : null, av: avUrl(m), tier: m ? m.tier || 0 : null,
      admin: !e.member, kudos: e.kudos || 0, liked: !!liked && liked.has(e.id), mine: !!viewer && e.member === viewer.id };
    if (e.type === 'post') { let d = {}; try { d = JSON.parse(e.data || '{}') || {}; } catch (x) {}
      const t = d.trade ? Object.assign({}, d.trade) : null;
      if (t && !(m && m.share.usd)) delete t.usd; // dollar results only for members who share them
      o.post = { kind: d.kind || 'note', trade: t, media: (d.media || []).map(id => '/api/social/media/' + id), verified: isVerified(d),
        comments: e.comments || 0, edited: e.edited || null, outcome: d.outcome || '', outcomeAt: d.outcomeAt || null }; }
    return o; };
  const eventsOut = (rows, viewer) => { const liked = likedBy(viewer, rows); return rows.map(e => eventOut(e, viewer, liked)); };
  // who to suggest following: the best 30-day Discipline on the server, worked out every five minutes
  let topCache = null;
  const topDiscipline = () => { if (topCache && now() - topCache.at < 300000) return topCache.list;
    const list = members().filter(m => !m.banned && m.share.profile && m.stats)
      .map(m => ({ id: m.id, d: disciplineOver(m.share.verify && Array.isArray(m.vdays) ? m.vdays : m.stats.days, addDaysKey(todayKey(), -29), todayKey(), 3).avg }))
      .sort((a, b) => (b.d || 0) - (a.d || 0)).slice(0, 60);
    topCache = { at: now(), list }; return list; };
  const postCfgOut = () => ({ on: !!S.config.posts.on, plans: !!S.config.posts.plans, images: !!S.config.posts.images });
  const commentRowOut = (c, viewer, e) => { const a = own(S.members, c.member) ? S.members[c.member] : null;
    return { id: c.id, at: c.at, text: c.text, handle: a ? a.handle : null, av: avUrl(a), mine: !!viewer && c.member === viewer.id,
      canDelete: !!viewer && (c.member === viewer.id || e.member === viewer.id) }; };
  // up to four of the member's own uploads, not used elsewhere; false when one isn't theirs or is gone
  const sanitizeMediaIds = (list, m, postId) => { const ids = [...new Set((Array.isArray(list) ? list : []).filter(x => typeof x === 'string'))].slice(0, 4);
    for (const id of ids) { const r = MEDIA_RE.test(id) ? q('SELECT * FROM media WHERE id = ?').get(id) : null;
      if (!r || r.member !== m.id || r.kind !== 'post' || (r.ref && r.ref !== 'post:' + postId)) return false; }
    return ids; };
  // "On chain": the wallet the member proved is theirs by signing (a claimed wallet, never just a
  // typed address) has fills that match the post: the right side, in that market, within a minute of
  // the times given, near the prices given (server.js tradeCheck). The mark belongs to one version of
  // the trade (its times and exit): when those change it's checked again. Checks run in the
  // background, two at a time, and a check that couldn't get an answer waits ten minutes to retry.
  const checkedKey = t => [t.openedAt || 0, t.closedAt || 0, t.exit || 0].join(':');
  const isVerified = d => d.verified === true && !!d.trade && d.checked === checkedKey(d.trade);
  const vq = [], vlast = new Map(); let vbusy = 0;
  const verifyPost = (id, m) => { if (!opts.tradeCheck || !m || vq.some(j => j.id === id)) return; vq.push({ id, mid: m.id }); runVerify(); };
  const runVerify = () => { while (vbusy < 2 && vq.length) { const job = vq.shift(); vbusy++; verifyOne(job).catch(() => {}).finally(() => { vbusy--; runVerify(); }); } };
  const verifyOne = async ({ id, mid }) => {
    const m = own(S.members, mid) ? S.members[mid] : null; if (!m || !m.claimed || m.banned) return;
    const addr = m.claimed, e = eventById(id); let d; try { d = JSON.parse(e && e.data || 'null'); } catch (x) { return; }
    const t = d && d.trade; if (!t || !(t.status === 'open' || t.status === 'closed') || !t.openedAt) return;
    const key = checkedKey(t); if (d.checked === key) return;
    const last = vlast.get(id); if (last && last.key === key && now() - last.at < 10 * 60000) return;
    vlast.set(id, { key, at: now() }); if (vlast.size > 5000) vlast.delete(vlast.keys().next().value);
    const ok = await opts.tradeCheck(addr, Object.assign({ kind: d.kind }, t)); if (typeof ok !== 'boolean') return;
    const cur = eventById(id); if (!cur) return; const d2 = JSON.parse(cur.data || '{}');
    if (!d2.trade || checkedKey(d2.trade) !== key) { verifyPost(id, m); return; } // it changed meanwhile: check what it is now
    if (!own(S.members, mid) || S.members[mid].claimed !== addr) return;
    d2.verified = ok; d2.checked = key; q('UPDATE events SET data = ? WHERE id = ?').run(JSON.stringify(d2), id); };
  // newest first, `limit` the viewer may see, older than the cursor ("<at>.<id>" of the last one shown)
  const feedPage = (viewer, where, args, cursor, limit) => {
    let at = Number.MAX_SAFE_INTEGER, id = '~';
    const c = /^(\d{1,15})\.([a-f0-9]{1,32})$/.exec(String(cursor || '')); if (c) { at = +c[1]; id = c[2]; }
    const out = []; let last = null, more = true;
    for (let pass = 0; pass < 20 && out.length < limit && more; pass++) {
      const rows = q('SELECT * FROM events WHERE hidden = 0 AND (at < ? OR (at = ? AND id < ?))' + (where ? ' AND ' + where : '') + ' ORDER BY at DESC, id DESC LIMIT 100').all(at, at, id, ...args);
      more = rows.length === 100;
      for (const r of rows) { last = r; if (visible(r, viewer)) out.push(r); if (out.length >= limit) break; }
      if (last) { at = last.at; id = last.id; }
    }
    // a short page with more rows behind it (a long run the viewer can't see) still hands on its cursor
    return { rows: out, next: (out.length >= limit || more) && last ? last.at + '.' + last.id : null };
  };
  const compOut = (c, viewer, full) => { const st = compStatus(c, todayKey());
    const rows = compStandings(c, members(), todayKey(), !!S.config.requireClaim);
    const mine = viewer ? rows.find(r => r.id === viewer.id) || null : null;
    const o = { id: c.id, title: c.title, type: c.type, rule: c.rule, start: c.start, end: c.end, minDays: c.minDays, ddCap: c.ddCap,
      league: c.league && own(S.leagues, c.league) ? { id: c.league, name: S.leagues[c.league].name } : null,
      status: st, entrants: rows.length, joined: !!(viewer && c.entrants[viewer.id]), me: mine };
    if (full) o.standings = rows.slice(0, 50).map(r => ({ rank: r.rank, handle: r.handle, av: avUrl(S.members[r.id]), note: r.note, out: r.out, score: r.score, me: !!viewer && r.id === viewer.id }));
    return o; };
  const joinTimes = new Map();

  // ---- inbox and web push: nudges, mentor notes, season results and the daily reminders ----
  const push = opts.push || null; // { publicKey, send(sub, message) -> status }
  const sanitizePrefs = (p, prev) => { const o = Object.assign({ morning: '08:30', eod: '20:30', partner: true, mentor: true, season: true, comment: true, on: { morning: true, eod: true } }, prev || {});
    if (p && typeof p === 'object') {
      for (const k of ['morning', 'eod']) if (typeof p[k] === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(p[k])) o[k] = p[k];
      for (const k of ['partner', 'mentor', 'season', 'comment']) if (typeof p[k] === 'boolean') o[k] = p[k];
      if (p.on && typeof p.on === 'object') o.on = { morning: p.on.morning !== false, eod: p.on.eod !== false }; }
    return o; };
  const sendPush = async (m, msg) => {
    if (!push || !m.push || !Array.isArray(m.push.subs) || !m.push.subs.length) return 0;
    let sent = 0;
    for (const sub of [...m.push.subs]) {
      try { const st = await push.send(sub, msg);
        // gone (404/410), or no longer ours (401/403: the server's key changed) — the device subscribes again
        if (st === 404 || st === 410 || st === 401 || st === 403) { m.push.subs = m.push.subs.filter(x => x.endpoint !== sub.endpoint); save(m); }
        else if (st >= 200 && st < 300) sent++; } catch (e) { /* a push service outage drops this one message */ } }
    return sent; };
  // into the member's inbox (shown in the app) and, if they allow that kind, to their devices
  const notify = (m, kind, text, extra) => {
    if (!m || m.banned) return;
    const it = Object.assign({ id: crypto.randomBytes(5).toString('hex'), at: now(), kind, text: cleanText(text, 700) }, extra || {});
    m.inbox = [...(m.inbox || []), it].slice(-INBOX_MAX); touch(m);
    const pr = m.push && m.push.prefs; if (pr && pr[kind] !== false) sendPush(m, { title: extra && extra.title || 'Pulse', body: it.text, tag: 'pulse-' + kind, url: extra && extra.url || '/pulse#today' });
  };
  // morning and evening reminders on the member's own clock, once a day each; the evening one
  // only on a day they traded and haven't reviewed yet
  const localHM = (tz, ms) => { try { return new Intl.DateTimeFormat('en-GB', { timeZone: tz || 'UTC', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(ms); } catch (e) { return new Date(ms).toISOString().slice(11, 16); } };
  // a reminder goes from its time until four hours later (a server that was down at 08:30 still sends it at 09:10)
  const mins = hm => +hm.slice(0, 2) * 60 + +hm.slice(3, 5);
  const due = (hm, at) => { const d = mins(hm) - mins(at); return d >= 0 && d < 240; };
  let ticking = false;
  const tick = async () => {
    if (!push || ticking) return 0; ticking = true; const t = now(), jobs = [];
    try {
      for (const m of members()) {
        if (m.banned || !m.push || !Array.isArray(m.push.subs) || !m.push.subs.length) continue;
        const pr = m.push.prefs = sanitizePrefs(null, m.push.prefs), tz = (m.stats && m.stats.tz) || 'UTC', day = zoneKey(tz, t), hm = localHM(tz, t);
        const sent = m.push.sent = m.push.sent || {};
        if (pr.on.morning && sent.morning !== day && due(hm, pr.morning)) { sent.morning = day; touch(m);
          jobs.push(() => sendPush(m, { title: 'Morning check-in', body: 'Thirty seconds: sleep, calm, focus — then your rules for today.', tag: 'pulse-morning', url: '/pulse#checkin' })); }
        const today = m.stats && Array.isArray(m.stats.days) ? m.stats.days.find(d => d.k === day) : null;
        if (pr.on.eod && sent.eod !== day && due(hm, pr.eod) && today && !today.r) { sent.eod = day; touch(m);
          jobs.push(() => sendPush(m, { title: 'Review your day', body: 'Five minutes: one lesson, one focus for tomorrow.', tag: 'pulse-eod', url: '/pulse#review' })); }
      }
      if (jobs.length) save(null); // the members touched above
      // eight at a time: one slow push service doesn't hold up everyone else's reminder
      for (let i = 0; i < jobs.length; i += 8) await Promise.all(jobs.slice(i, i + 8).map(f => f().catch(() => 0)));
      return jobs.length;
    } finally { ticking = false; } };

  // ---- accountability partners: two members who see each other's process and nudge each other ----
  const pairOf = (m, id) => { const p = own(S.partners, id) ? S.partners[id] : null; return p && (p.a === m.id || p.b === m.id) ? p : null; };
  const pairsOf = m => Object.values(S.partners).filter(p => p.a === m.id || p.b === m.id);
  const otherIn = (p, m) => S.members[p.a === m.id ? p.b : p.a] || null;
  const partnerView = (o) => { const st = o.stats || {};
    const days = (st.days || []).slice(-14).map(d => ({ k: d.k, s: d.s, f: d.f || [] }));
    const recent = days.slice(-7);
    return { handle: o.handle, level: st.level || 1, streak: st.streak || 0, best: st.best || 0, days,
      avg7: recent.length ? Math.round(recent.reduce((a, d) => a + d.s, 0) / recent.length) : null,
      slips7: recent.reduce((a, d) => a + d.f.length, 0), challenge: st.lastChallenge || '', habits: o.share.habits ? st.habits || [] : [], seen: o.statsAt || null }; };
  const pairOut = (p, m) => { const o = otherIn(p, m); if (!o || o.banned) return null;
    const out = { id: p.id, handle: o.handle, av: avUrl(o), status: p.status === 'active' ? 'active' : p.from === m.id ? 'sent' : 'received', since: p.since || p.at,
      challenge: p.challenge && p.challenge.week === S.league.week ? { text: p.challenge.text, mine: p.challenge.by === m.id } : null };
    if (p.status === 'active') out.view = partnerView(o);
    const last = p.nudged && p.nudged[m.id]; out.canNudge = !last || now() - last > 6 * 3600000;
    return out; };
  const dropPairsOf = id => { for (const [k, p] of Object.entries(S.partners)) if (p.a === id || p.b === id) delete S.partners[k]; };

  // ---- mentors: members the owner appoints; they see the days of members who opted in ----
  const menteesOf = m => members().filter(o => o.id !== m.id && !o.banned && o.share && o.share.mentor);
  const commentsFor = id => (S.comments[id] || []);
  const commentOut = c => { const by = own(S.members, c.by) ? S.members[c.by] : null; return { id: c.id, day: c.day, text: c.text, at: c.at, by: by ? by.handle : 'a mentor', read: !!c.read }; };
  const menteeSummary = o => { const st = o.stats || {}, days = (st.days || []).slice(-7);
    return { handle: o.handle, av: avUrl(o), level: st.level || 1, streak: st.streak || 0, avg7: days.length ? Math.round(days.reduce((a, d) => a + d.s, 0) / days.length) : null,
      slips7: days.reduce((a, d) => a + (d.f ? d.f.length : 0), 0), lastDay: days.length ? days[days.length - 1].k : null, seen: o.statsAt || null,
      notes: commentsFor(o.id).length }; };

  // ---- seasons ----
  const seasonInfo = L => { if (!L.season) return null; const id = seasonOf(L.season, todayKey()), b = seasonBounds(id);
    return { id, label: seasonLabel(id), start: b.start, end: b.end, daysLeft: Math.round((Date.parse(b.end) - Date.parse(todayKey())) / 86400000) }; };
  const SEASON_BADGES = { 'season-gold': ['Season champion', '🏆', 'Finished first in a league season'], 'season-silver': ['Season runner-up', '🥈', 'Finished second in a league season'],
    'season-bronze': ['Season podium', '🥉', 'Finished third in a league season'] };
  // a season closes on the first request after its last day: final standings over its own window,
  // a podium in the league's hall of fame, and a badge for the top three
  const closeSeason = (L, id) => {
    const b = seasonBounds(id), days = Math.round((Date.parse(b.end) - Date.parse(b.start)) / 86400000) + 1;
    const rows = (boardRows(leagueMembers(L), L.metric, { todayKey: b.end, dayFrom: L.metric === 'xp' ? b.start : undefined, dayTo: b.end, days }) || [])
      .filter(r => r.value != null && r.value > 0);
    const podium = rows.slice(0, 3).map(r => ({ id: r.id, handle: r.handle, value: r.value }));
    L.hall = [...(L.hall || []), { season: id, label: seasonLabel(id), start: b.start, end: b.end, n: rows.length, podium, at: now() }].slice(-24);
    ['season-gold', 'season-silver', 'season-bronze'].forEach((bid, i) => { const r = podium[i]; if (!r) return; const m = S.members[r.id]; if (!m) return;
      if (!own(S.badges, bid)) { const [name, icon, desc] = SEASON_BADGES[bid]; S.badges[bid] = { id: bid, name, icon, desc, metric: null, op: 'gte', value: 0, xp: 0, system: true }; }
      m.awards = m.awards || {}; if (!own(m.awards, bid)) m.awards[bid] = now();
      m.seasonWins = [...(m.seasonWins || []), { league: L.id, season: id, place: i + 1 }].slice(-50);
      if (m.share.feed) pushEvent(m, { type: 'season', text: ['won', 'took second in', 'took third in'][i] + ' the ' + L.name + ' ' + seasonLabel(id) + ' season ' + SEASON_BADGES[bid][1] });
      notify(m, 'season', 'You finished #' + (i + 1) + ' in the ' + L.name + ' ' + seasonLabel(id) + ' season.', { title: 'Season over ' + SEASON_BADGES[bid][1], url: '/pulse#lg/' + L.id }); });
  };
  // A season that ran to its end waits one more day (so the last day's numbers can sync) and then
  // closes with a podium. One the owner changed or switched off before its end closes nothing.
  const ensureSeasons = () => { let ch = false; const today = todayKey();
    for (const L of Object.values(S.leagues)) {
      const cur = L.season ? seasonOf(L.season, today) : null;
      if (L.seasonId && L.seasonId !== cur) { if (today > seasonBounds(L.seasonId).end) L.toClose = [...(L.toClose || []), L.seasonId]; ch = true; }
      if ((L.seasonId || null) !== cur) { L.seasonId = cur; ch = true; }
      for (const id of [...(L.toClose || [])]) if (today > addDaysKey(seasonBounds(id).end, 1)) {
        L.toClose = L.toClose.filter(x => x !== id); ch = true;
        if (!(L.hall || []).some(h => h.season === id)) try { closeSeason(L, id); } catch (e) {} } }
    if (ch) save(); };

  // daily limits kept on the member (posts, uploads): deleting a post or picture doesn't give the slot back
  const dayLimit = (m, k, n) => { const L = (Array.isArray(m[k]) ? m[k] : []).filter(t => now() - t < 86400000);
    if (L.length >= n) { m[k] = L; return true; } L.push(now()); m[k] = L; touch(m); return false; };
  const readRaw = (req, limit) => new Promise((resolve, reject) => { let size = 0; const ch = [];
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); return; } ch.push(c); });
    req.on('end', () => resolve(Buffer.concat(ch))); req.on('error', reject); });
  const sniffImage = b => b.length > 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP' ? 'image/webp'
    : b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff ? 'image/jpeg'
    : b.length > 8 && b.toString('latin1', 0, 8) === '\x89PNG\r\n\x1a\n' ? 'image/png' : null;
  const readJson = async (req, limit) => {
    const raw = await new Promise((resolve, reject) => { let size = 0; const ch = [];
      req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); return; } ch.push(c); });
      req.on('end', () => resolve(Buffer.concat(ch).toString('utf8'))); req.on('error', reject); });
    return raw ? JSON.parse(raw) : {};
  };

  async function handle(req, res, url, query) {
    const M = req.method;
    const parts = url.split('/').slice(3); // ['', 'api', 'social', ...]
    const head = parts[0] || '';
    let body = {};
    const limit = head === 'vault' ? MAX_VAULT_BODY + 4096 : head === 'stats' ? 4 * MAX_SOCIAL_BODY : MAX_SOCIAL_BODY;
    if (head === 'vault' && M === 'PUT') { // a member, with sync on, before reading up to 6 MB
      const who = byKey(req); if (!who) return json(res, 401, { error: 'not a member' });
      if (who.banned) return json(res, 403, { error: 'This profile was removed from the league.' });
      if (!S.config.vaultOn) return json(res, 403, { error: 'Journal sync is switched off on this server.' }); }
    // an image: raw bytes in, checked by their first bytes (WebP, JPEG or PNG only: never SVG or HTML)
    if (head === 'media' && !parts[1] && M === 'POST') {
      const who = byKey(req); if (!who) return json(res, 401, { error: 'not a member' });
      if (who.banned) return json(res, 403, { error: 'This profile was removed from the league.' });
      const kind = query.kind === 'avatar' ? 'avatar' : 'post', max = kind === 'avatar' ? MAX_AVATAR : MAX_IMAGE;
      if (kind === 'post' && !(S.config.posts.on && S.config.posts.images)) return json(res, 403, { error: 'Images on posts are switched off on this server.' });
      if (+req.headers['content-length'] > max) { res.setHeader('Connection', 'close'); return json(res, 413, { error: 'That image is too large.' }); }
      // counted when the upload starts, so parallel uploads can't all slip under the limit
      if (dayLimit(who, 'mediaLog', MEDIA_PER_DAY)) return json(res, 429, { error: 'That’s a lot of images today. Try again tomorrow.' });
      save(who);
      let buf; try { buf = await readRaw(req, max); } catch (e) { return json(res, e.message === 'too large' ? 413 : 400, { error: e.message === 'too large' ? 'That image is too large.' : 'invalid body' }); }
      const mime = sniffImage(buf); if (!mime) return json(res, 415, { error: 'Images must be WebP, JPEG or PNG.' });
      // pictures uploaded but never used (a post that wasn't sent) go after a day
      dropMedia(q('SELECT id FROM media WHERE ref IS NULL AND at < ?').all(now() - 86400000));
      if ((q('SELECT sum(size) AS n FROM media').get().n || 0) + buf.length > (opts.mediaTotalMax || MAX_MEDIA_TOTAL)) return json(res, 507, { error: 'This server is out of room for images. Tell its owner.' });
      const id = crypto.randomBytes(12).toString('hex');
      fs.mkdirSync(mediaDir, { recursive: true }); const f = mediaFile(id); fs.writeFileSync(f + '.tmp', buf); fs.renameSync(f + '.tmp', f);
      q('INSERT INTO media (id, member, at, mime, size, kind, ref) VALUES (?, ?, ?, ?, ?, ?, NULL)').run(id, who.id, now(), mime, buf.length, kind);
      return json(res, 200, { id, url: '/api/social/media/' + id });
    }
    if ((M === 'POST' || M === 'PUT') && +req.headers['content-length'] > limit) { res.setHeader('Connection', 'close'); return json(res, 413, { error: 'That’s too large to store here.' }); }
    if (M === 'POST' || M === 'PUT') { try { body = await readJson(req, limit); }
      catch (e) { return json(res, e.message === 'too large' ? 413 : 400, { error: e.message === 'too large' ? 'That’s too large to store here.' : 'invalid body' }); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return json(res, 400, { error: 'invalid body' }); }
    let arg = parts[1] || '';
    try { arg = decodeURIComponent(arg); } catch (e) { return json(res, 400, { error: 'bad path' }); }
    ensureWeek(); ensureSeasons();

    if (head === 'config' && M === 'GET')
      return json(res, 200, { enabled: adminConfigured, open: S.config.open, inviteRequired: !!S.config.inviteCode, unlocksOn: S.config.unlocksOn,
        unlocks: S.config.unlocks, tiers: TIERS, week: S.league.week, members: members().filter(m => !m.banned).length,
        claims: !!sig, requireClaim: !!S.config.requireClaim, vaultOn: !!S.config.vaultOn,
        modules: S.config.modules, levels: S.config.levels, xp: S.config.xp, profiles: S.config.profiles,
        coach: { members: S.config.coach.members, daily: S.config.coach.daily, detail: S.config.coach.detail }, posts: postCfgOut(),
        badges: Object.values(S.badges).map(b => ({ id: b.id, name: b.name, icon: b.icon, desc: b.desc, metric: b.metric, metricLabel: b.metric ? SC.BADGE_METRICS[b.metric] : null, op: b.op, value: b.value, xp: b.xp })),
        leagues: Object.values(S.leagues).filter(L => L.open).length });

    // ---------- owner: admin ----------
    if (head === 'admin') {
      // an open server (no AUTH_TOKEN) would make everyone an admin: refuse until a token is set
      if (!adminConfigured) return json(res, 403, { error: 'Set AUTH_TOKEN on the server to use the admin panel.' });
      if (!authOk(req)) return json(res, 401, { error: 'unauthorized' });
      const sub = parts[1] || '';
      if (sub === 'overview' && M === 'GET') {
        const wk = S.league.week, act = members().filter(m => now() - (m.lastSeen || 0) < 7 * 86400000);
        return json(res, 200, { adminConfigured, members: members().length, banned: members().filter(m => m.banned).length, active7: act.length,
          events: q('SELECT count(*) AS n FROM events').get().n, posts: q("SELECT count(*) AS n FROM events WHERE type = 'post'").get().n,
          reports: q('SELECT count(*) AS n FROM reports WHERE open = 1').get().n, mediaBytes: q('SELECT sum(size) AS n FROM media').get().n || 0, comps: Object.keys(S.comps).length, week: wk, config: S.config,
          claimed: members().filter(m => m.claimed).length, vaults: members().filter(m => m.vault).length, vaultBytes: vaultTotal(), claims: !!sig,
          originPinned: origins.length > 0 || !!opts.hostVetted,
          leagues: Object.keys(S.leagues).length, badges: Object.keys(S.badges).length, coachAi: !!opts.coachAvailable,
          coachToday: members().reduce((a, m) => a + coachUsed(m), 0) + (S.ownerCoach.k === utcDayKey(now()) ? S.ownerCoach.n : 0),
          meta: { modules: SC.MODULES, leagueMetrics: SC.LEAGUE_METRICS, badgeMetrics: SC.BADGE_METRICS, profiles: SC.PROFILES },
          tiers: TIERS.map((t, i) => ({ tier: t, n: S.leagues.main ? members().filter(m => !m.banned && own(S.leagues.main.members, m.id) && leagueTier(S.leagues.main, m) === i).length : 0 })) });
      }
      if (sub === 'members' && M === 'GET' && !parts[2])
        return json(res, 200, { members: members().sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0)).map(m => ({ id: m.id, handle: m.handle,
          tier: m.tier || 0, level: (m.stats && m.stats.level) || 1, xp: (m.stats && m.stats.xp) || 0, streak: (m.stats && m.stats.streak) || 0,
          address: m.address || null, claimed: m.claimed || null, devices: (m.keyHash ? 1 : 0) + (Array.isArray(m.keyHashes) ? m.keyHashes.length : 0),
          vault: m.vault ? m.vault.size : 0, share: m.share, banned: !!m.banned, unlocked: !!m.unlocked, coachDaily: m.coachDaily != null ? m.coachDaily : null,
          coachUsed: coachUsed(m), coachLimit: coachLimitFor(m), grants: m.grants || [], awards: Object.keys(m.awards || {}).filter(id => own(S.badges, id)),
          leagues: leaguesOf(m).map(L => ({ id: L.id, tier: leagueTier(L, m) })), adminMade: !!m.adminMade, mentor: !!m.mentor, keys: (m.keyHash ? 1 : 0) + (Array.isArray(m.keyHashes) ? m.keyHashes.length : 0), verified: !!(m.share.verify && Array.isArray(m.vdays)), createdAt: m.createdAt, lastSeen: m.lastSeen || null,
          av: avUrl(m), bio: m.bio || '',
          money: m.money && m.money.ret != null ? { ret: m.money.ret, dd: m.money.dd } : null })) });
      if (sub === 'members' && !parts[2] && M === 'POST') { // the owner adds someone; they sign in with the code it returns
        const handle = cleanText(body.handle, 20).replace(/^@/, '');
        if (!HANDLE_RE.test(handle)) return json(res, 400, { error: 'A name is 3–20 letters, numbers or underscores.' });
        if (byHandle(handle)) return json(res, 409, { error: 'That name is taken.' });
        if (members().length >= MAX_MEMBERS) return json(res, 403, { error: 'The league is full.' });
        let address = typeof body.address === 'string' && ADDR_RE.test(body.address) ? body.address.toLowerCase() : null; if (claimedBy(address)) address = null;
        const id = crypto.randomBytes(6).toString('hex'), A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let code = ''; for (const x of crypto.randomBytes(10)) code += A[x % 32];
        const m = { id, handle, keyHash: null, keyHashes: [], createdAt: now(), lastSeen: 0, tier: 0, share: sanitizeShare(body.share), address, stats: null, weekXp: {}, money: null,
          banned: false, adminMade: true, unlocked: !!body.unlocked, pendingCodes: [{ h: sha(code), exp: now() + 7 * 86400000 }] };
        S.members[id] = m; S.follows[id] = []; reindex();
        const ls = body.leagues != null ? [].concat(body.leagues) : Object.values(S.leagues).filter(L => L.autoJoin).map(L => L.id);
        for (const lid of ls) if (own(S.leagues, lid)) joinLeague(S.leagues[lid], m);
        save(); refreshAll(m);
        return json(res, 200, { ok: true, id, code, expiresAt: now() + 7 * 86400000 });
      }
      if (sub === 'members' && parts[2] && M === 'POST') {
        const m = own(S.members, parts[2]) ? S.members[parts[2]] : null; if (!m) return json(res, 404, { error: 'no such member' });
        const a = body.action; let extra = {};
        if (a === 'ban' || a === 'unban') m.banned = a === 'ban';
        else if (a === 'tier') { const t = clampNum(body.tier, 0, TIERS.length - 1); if (t == null) return json(res, 400, { error: 'bad tier' });
          const L = own(S.leagues, body.league || 'main') ? S.leagues[body.league || 'main'] : null; if (!L || !own(L.members, m.id)) return json(res, 400, { error: 'not in that league' });
          L.members[m.id].tier = Math.round(t); if (L.id === 'main') m.tier = Math.round(t); }
        else if (a === 'remove') dropMember(m.id);
        else if (a === 'edit') {
          if (body.handle != null) { const h = cleanText(body.handle, 20).replace(/^@/, '');
            if (!HANDLE_RE.test(h)) return json(res, 400, { error: 'A name is 3–20 letters, numbers or underscores.' });
            const o = byHandle(h); if (o && o.id !== m.id) return json(res, 409, { error: 'That name is taken.' }); m.handle = h; reindex(); }
          if (body.address !== undefined && !m.claimed) { const ad = typeof body.address === 'string' && ADDR_RE.test(body.address) ? body.address.toLowerCase() : null;
            if (ad && claimedBy(ad, m.id)) return json(res, 409, { error: 'That wallet is claimed by another profile.' });
            if (ad !== m.address) { m.address = ad; m.vdays = null; m.vAt = 0; m.money = null; refreshAll(m); } }
          if (body.share && typeof body.share === 'object') m.share = sanitizeShare(body.share, m.share);
        }
        else if (a === 'clearAvatar') { dropMedia(q('SELECT id FROM media WHERE member = ? AND kind = ?').all(m.id, 'avatar')); m.avatar = null; }
        else if (a === 'clearBio') m.bio = '';
        else if (a === 'mentor' || a === 'unmentor') m.mentor = a === 'mentor'; // sees the days of members who let mentors in, and comments on them
        else if (a === 'unlock' || a === 'lock') m.unlocked = a === 'unlock'; // every feature, theme and the bigger coach allowance
        else if (a === 'coach') { if (body.daily === null || body.daily === '') m.coachDaily = null;
          else { const d = clampNum(body.daily, 0, 1000); if (d == null || body.daily === undefined) return json(res, 400, { error: 'How many coach messages a day?' }); m.coachDaily = Math.round(d); } }
        else if (a === 'grant') { // XP boost (or a correction, if negative): the member's app adds it to their total
          const xp = Math.round(clampNum(body.xp, -100000, 100000) || 0); if (!xp) return json(res, 400, { error: 'How much XP?' });
          m.grants = [...(m.grants || []), { id: crypto.randomBytes(4).toString('hex'), xp, why: cleanText(body.why, 80) || 'Bonus from the league owner', at: now() }].slice(-200);
          if (xp > 0 && m.share.feed && body.announce) pushEvent(m, { type: 'grant', text: 'got +' + xp + ' XP: ' + (cleanText(body.why, 80) || 'bonus from the league owner') }); }
        else if (a === 'ungrant') m.grants = (m.grants || []).filter(g => g.id !== body.id);
        else if (a === 'award' || a === 'revoke') { if (!own(S.badges, body.badge)) return json(res, 404, { error: 'no such badge' });
          m.awards = m.awards || {}; if (a === 'award') { if (!own(m.awards, body.badge)) { m.awards[body.badge] = now();
            if (m.share.feed) pushEvent(m, { type: 'badge', text: 'earned the ' + S.badges[body.badge].name + ' badge ' + S.badges[body.badge].icon }); } }
          else delete m.awards[body.badge];
          m.revoked = m.revoked || {}; if (a === 'revoke') m.revoked[body.badge] = now(); else delete m.revoked[body.badge]; }
        else if (a === 'leagues') { for (const id of [].concat(body.join || [])) if (own(S.leagues, id)) { if (id === 'main' && !own(S.leagues.main.members, m.id)) m.tier = 0; joinLeague(S.leagues[id], m); }
          for (const id of [].concat(body.leave || [])) if (own(S.leagues, id)) { delete S.leagues[id].members[m.id]; if (id === 'main') m.tier = 0; } }
        else if (a === 'code') { // a sign-in code for this member, good for 7 days: how the owner hands out admin-made profiles or recovers a lost one
          const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let code = ''; for (const x of crypto.randomBytes(10)) code += A[x % 32];
          m.pendingCodes = [...(m.pendingCodes || []).filter(c => c.exp > now()), { h: sha(code), exp: now() + 7 * 86400000 }].slice(-3);
          extra = { code, expiresAt: now() + 7 * 86400000 }; }
        else return json(res, 400, { error: 'unknown action' });
        save(); return json(res, 200, Object.assign({ ok: true }, extra));
      }
      if (sub === 'config' && M === 'PUT') {
        const c = S.config;
        if (typeof body.open === 'boolean') c.open = body.open;
        if (typeof body.inviteCode === 'string') c.inviteCode = cleanText(body.inviteCode, 40);
        if (typeof body.unlocksOn === 'boolean') c.unlocksOn = body.unlocksOn;
        if (typeof body.vaultOn === 'boolean') c.vaultOn = body.vaultOn;
        if (body.modules) c.modules = SC.sanitizeModules(body.modules, c.modules);
        if (body.unlocks) c.modules = SC.sanitizeModules(body.unlocks, c.modules); // v0.3 panels send this name
        if (body.levels) c.levels = SC.sanitizeLevels(body.levels, c.levels);
        if (body.xp) c.xp = SC.sanitizeXp(body.xp, c.xp);
        if (body.coach) c.coach = SC.sanitizeCoachCfg(body.coach, c.coach);
        if (body.profiles) c.profiles = SC.sanitizeProfiles(body.profiles, c.profiles);
        if (body.posts) c.posts = sanitizePostCfg(body.posts, c.posts);
        if (typeof body.requireClaim === 'boolean' && body.requireClaim !== c.requireClaim) {
          c.requireClaim = body.requireClaim;
          // numbers read from wallets nobody signed for stop counting at once, and come back after a claim
          for (const m of members()) { m.vAt = 0; m.vFailAt = 0; m.moneyFailAt = 0;
            if (c.requireClaim && !walletFor(m)) { m.vdays = null; m.money = null;
              for (const cc of Object.values(S.comps)) if (cc.money) delete cc.money[m.id]; } }
        }
        c.unlocks = { trends: c.modules.trends, share: c.modules.share, compete: c.modules.compete };
        save(); return json(res, 200, { ok: true, config: c });
      }
      // ---- leagues ----
      if (sub === 'leagues' && M === 'GET') return json(res, 200, { leagues: Object.values(S.leagues).map(L => Object.assign(leagueOut(L, null), { invite: L.invite, autoJoin: L.autoJoin, week: L.week,
        roster: members().filter(m => own(L.members, m.id)).map(m => ({ id: m.id, handle: m.handle, tier: leagueTier(L, m) })) })) });
      if (sub === 'leagues' && M === 'POST' && !parts[2]) {
        if (Object.keys(S.leagues).length >= 50) return json(res, 400, { error: 'That’s a lot of leagues — 50 at most.' });
        const L = SC.sanitizeLeague(body, null); if (!L) return json(res, 400, { error: 'A league needs a name.' });
        let id = String(L.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'league';
        while (own(S.leagues, id)) id += '-' + crypto.randomBytes(2).toString('hex');
        S.leagues[id] = Object.assign({ id, num: ++S.leagueSeq, createdAt: now(), members: {}, week: S.league.week }, L);
        if (body.everyone) for (const m of members()) joinLeague(S.leagues[id], m);
        save(); return json(res, 200, { ok: true, id });
      }
      if (sub === 'leagues' && parts[2] && (M === 'PUT' || M === 'DELETE' || M === 'POST')) {
        const L = own(S.leagues, parts[2]) ? S.leagues[parts[2]] : null; if (!L) return json(res, 404, { error: 'no such league' });
        if (M === 'DELETE') { if (L.id === 'main') return json(res, 400, { error: 'The main league stays; rename or reshape it instead.' });
          delete S.leagues[L.id]; for (const c of Object.values(S.comps)) if (c.league === L.id) c.league = null; save(); return json(res, 200, { ok: true }); }
        if (M === 'PUT') { const n = SC.sanitizeLeague(body, L); if (!n) return json(res, 400, { error: 'A league needs a name.' }); Object.assign(L, n); save(); return json(res, 200, { ok: true }); }
        // POST /admin/leagues/:id/members {add, remove}
        for (const id of [].concat(body.add || [])) if (own(S.members, id)) { if (L.id === 'main' && !own(L.members, id)) S.members[id].tier = 0; joinLeague(L, S.members[id]); }
        for (const id of [].concat(body.remove || [])) { delete L.members[id]; if (L.id === 'main' && own(S.members, id)) S.members[id].tier = 0; }
        save(); return json(res, 200, { ok: true });
      }
      // ---- reward badges ----
      if (sub === 'badges' && M === 'GET') return json(res, 200, { badges: Object.values(S.badges).map(b => Object.assign({}, b, { earned: members().filter(m => m.awards && own(m.awards, b.id)).length })) });
      if (sub === 'badges' && M === 'POST' && !parts[2]) {
        if (Object.keys(S.badges).length >= 100) return json(res, 400, { error: '100 badges at most.' });
        const b = SC.sanitizeBadge(body, null); if (!b) return json(res, 400, { error: 'A badge needs a name.' });
        const id = crypto.randomBytes(4).toString('hex'); S.badges[id] = Object.assign({ id, createdAt: now() }, b);
        for (const m of members()) awardCheck(m);
        save(); return json(res, 200, { ok: true, id });
      }
      if (sub === 'badges' && parts[2] && (M === 'PUT' || M === 'DELETE')) {
        const b = own(S.badges, parts[2]) ? S.badges[parts[2]] : null; if (!b) return json(res, 404, { error: 'no such badge' });
        if (M === 'DELETE') { delete S.badges[b.id]; for (const m of members()) if (m.awards) delete m.awards[b.id]; save(); return json(res, 200, { ok: true }); }
        const n = SC.sanitizeBadge(body, b); if (!n) return json(res, 400, { error: 'A badge needs a name.' }); Object.assign(b, n);
        for (const m of members()) awardCheck(m);
        save(); return json(res, 200, { ok: true });
      }
      if (sub === 'competitions' && M === 'POST' && !parts[2]) {
        const c = sanitizeComp(body); if (!c) return json(res, 400, { error: 'needs a title, a type (' + COMP_TYPES.join(', ') + '), and start ≤ end dates within 92 days' });
        if (c.league && !own(S.leagues, c.league)) return json(res, 400, { error: 'no such league' });
        c.id = crypto.randomBytes(5).toString('hex'); c.createdAt = now(); c.entrants = {};
        S.comps[c.id] = c; pushEvent(null, { type: 'announce', text: 'New competition: ' + c.title + (c.league && S.leagues[c.league].open && !S.leagues[c.league].invite ? ' · ' + S.leagues[c.league].name : ''), quote: c.rule }); save();
        return json(res, 200, { ok: true, id: c.id });
      }
      if (sub === 'competitions' && parts[2] && M === 'DELETE') {
        if (!own(S.comps, parts[2])) return json(res, 404, { error: 'no such competition' });
        delete S.comps[parts[2]]; save(); return json(res, 200, { ok: true });
      }
      if (sub === 'competitions' && M === 'GET')
        return json(res, 200, { competitions: Object.values(S.comps).sort((a, b) => b.createdAt - a.createdAt).map(c => compOut(c, null, true)) });
      if (sub === 'announce' && M === 'POST') {
        const text = cleanText(body.text, 280); if (!text) return json(res, 400, { error: 'empty' });
        pushEvent(null, { type: 'announce', text }); save(); return json(res, 200, { ok: true });
      }
      if (sub === 'events' && M === 'GET') { const page = feedPage(null, query.kind === 'posts' ? "type = 'post'" : '', [], query.before, 100);
        return json(res, 200, { events: eventsOut(page.rows, null), next: page.next }); }
      if (sub === 'events' && parts[2] && M === 'DELETE') {
        if (!dropEvent(parts[2])) return json(res, 404, { error: 'no such event' });
        return json(res, 200, { ok: true });
      }
      // reports from members: what was reported, by how many, and why
      if (sub === 'reports' && M === 'GET') {
        const rows = q('SELECT * FROM reports WHERE open = 1 ORDER BY at DESC LIMIT 500').all(), groups = new Map();
        for (const r of rows) { const k = r.comment ? 'c:' + r.comment : 'e:' + r.event; const g = groups.get(k) || { ids: [], why: [], at: 0, comment: r.comment, event: r.event };
          g.ids.push(r.id); if (r.why) g.why.push(r.why); g.at = Math.max(g.at, r.at); groups.set(k, g); }
        const out = [];
        for (const g of groups.values()) {
          const c = g.comment ? q('SELECT * FROM comments WHERE id = ?').get(g.comment) : null, e = eventById(c ? c.event : g.event);
          if (!e) { q('UPDATE reports SET open = 0 WHERE id IN (SELECT value FROM json_each(?))').run(JSON.stringify(g.ids)); continue; }
          out.push({ id: g.ids[0], n: g.ids.length, why: g.why.slice(0, 5), at: g.at, post: eventOut(e, null), comment: c ? commentRowOut(c, null, e) : null });
        }
        return json(res, 200, { reports: out });
      }
      if (sub === 'reports' && parts[2] && M === 'POST') {
        const r = /^[a-f0-9]{12}$/.test(parts[2]) ? q('SELECT * FROM reports WHERE id = ?').get(parts[2]) : null; if (!r) return json(res, 404, { error: 'no such report' });
        const same = r.comment ? ['comment = ?', r.comment] : ['event = ? AND comment IS NULL', r.event];
        if (body.action === 'remove') { if (r.comment) { const c = q('SELECT * FROM comments WHERE id = ?').get(r.comment); if (c) dropComment(c); } else dropEvent(r.event); }
        else if (body.action !== 'dismiss') return json(res, 400, { error: 'unknown action' });
        q('UPDATE reports SET open = 0 WHERE ' + same[0]).run(same[1]);
        return json(res, 200, { ok: true });
      }
      if (sub === 'comments' && parts[2] && M === 'DELETE') {
        const c = q('SELECT * FROM comments WHERE id = ?').get(parts[2]); if (!c) return json(res, 404, { error: 'no such comment' });
        dropComment(c); return json(res, 200, { ok: true });
      }
      return json(res, 404, { error: 'not found' });
    }

    // ---------- a member's public badge page (no sign-in; only if they switched it on) ----------
    if (head === 'public' && parts[1] && M === 'GET') {
      if (limited(req, 'public', 240, 600000)) return json(res, 429, { error: 'Too many requests.' });
      const m = byHandle(arg);
      if (!m || m.banned || !m.share.page) return json(res, 404, { error: 'No public badge page here.' });
      const st = m.stats || {}, ver = m.share.verify && Array.isArray(m.vdays);
      const d30 = disciplineOver(ver ? m.vdays : st.days, addDaysKey(todayKey(), -29), todayKey(), 3);
      return json(res, 200, { handle: m.handle, level: st.level || 1, title: levelTitle(st.level || 1), xp: st.xp || 0, streak: st.streak || 0, best: st.best || 0,
        since: utcDayKey(m.createdAt || now()), discipline30: d30.avg == null ? null : Math.round(d30.avg), verified: ver, claimed: !!m.claimed,
        badges: st.badges || [], badgeN: st.badgeN || 0, badgeTotal: st.badgeTotal || 0, awards: awardsOut(m).map(a => ({ name: a.name, icon: a.icon, desc: a.desc, at: a.at })),
        leagues: leaguesOf(m).filter(L => L.open && !L.invite).map(L => ({ name: L.name, tier: L.tiers ? TIERS[leagueTier(L, m)] : null })) });
    }

    // ---------- images: anyone holding the link (ids are random and only handed out with the post or profile) ----------
    if (head === 'media' && parts[1] && M === 'GET') {
      const r = MEDIA_RE.test(arg) ? q('SELECT * FROM media WHERE id = ?').get(arg) : null;
      const a = r && own(S.members, r.member) ? S.members[r.member] : null;
      if (!r || !a || a.banned || !r.ref) return json(res, 404, { error: 'not found' });
      if (req.headers['if-none-match'] === '"' + r.id + '"') { res.writeHead(304); return res.end(); }
      let buf; try { buf = fs.readFileSync(mediaFile(r.id)); } catch (e) { return json(res, 404, { error: 'not found' }); }
      res.writeHead(200, { 'Content-Type': r.mime, 'Content-Length': buf.length, 'Cache-Control': 'public, max-age=31536000, immutable', ETag: '"' + r.id + '"',
        'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Cross-Origin-Resource-Policy': 'same-origin' });
      return res.end(buf);
    }

    // ---------- joining ----------
    if (head === 'join' && M === 'POST') {
      // without AUTH_TOKEN the owner's journal (wallets included) is open to anyone with the link:
      // the league stays closed until the owner protects it
      if (!adminConfigured) return json(res, 403, { error: 'The owner needs to set an access token on the server before the league can open.' });
      if (!S.config.open) return json(res, 403, { error: 'This league isn’t taking new members right now.' });
      if (S.config.inviteCode && limited(req, 'invite', 20, 600000)) return json(res, 429, { error: 'Too many tries from here. Try again in a few minutes.' });
      if (S.config.inviteCode && !sameText(cleanText(body.invite, 40), S.config.inviteCode)) return json(res, 403, { error: 'That invite code isn’t right.' });
      if (members().length >= MAX_MEMBERS) return json(res, 403, { error: 'The league is full.' });
      const ip = ipOf(req);
      const recent = (joinTimes.get(ip) || []).filter(t => now() - t < 3600000);
      if (recent.length >= 5) return json(res, 429, { error: 'Too many new profiles from here. Try again later.' });
      const handle = cleanText(body.handle, 20).replace(/^@/, '');
      if (!HANDLE_RE.test(handle)) return json(res, 400, { error: 'Pick a name of 3–20 letters, numbers or underscores.' });
      if (byHandle(handle)) return json(res, 409, { error: 'That name is taken.' });
      let address = typeof body.address === 'string' && ADDR_RE.test(body.address) ? body.address.toLowerCase() : null;
      if (claimedBy(address)) address = null; // someone proved that wallet is theirs; joining still works, without it
      const key = crypto.randomBytes(24).toString('hex'), id = crypto.randomBytes(6).toString('hex');
      const m = { id, handle, keyHash: sha(key), createdAt: now(), lastSeen: now(), tier: 0, share: sanitizeShare(body.share),
        address, stats: null, weekXp: {}, money: null, banned: false };
      S.members[id] = m; S.follows[id] = []; reindex();
      for (const L of Object.values(S.leagues)) if (L.autoJoin) joinLeague(L, m);
      recent.push(now()); joinTimes.set(ip, recent);
      if (m.share.feed) pushEvent(m, { type: 'join', text: 'joined the league' });
      save(m, 'follows', 'leagues'); refreshMoney(m, true); refreshBehavior(m, true);
      return json(res, 200, { key, me: publicMember(m, m), share: m.share, walletTaken: !address && !!body.address });
    }

    // ---------- wallet sign-in and claims (Sign-In with Ethereum, EIP-4361) ----------
    // The server writes the message and keeps it by nonce; the client only returns the wallet's
    // signature, so the text a member signs is never taken from the client.
    if ((head === 'login' || head === 'claim') && parts[1] === 'start' && M === 'POST') {
      if (!sig) return json(res, 501, { error: 'Wallet sign-in isn’t available on this server.' });
      if (!adminConfigured) return json(res, 403, { error: 'The owner needs to set an access token on the server first.' });
      const addr = typeof body.address === 'string' && ADDR_RE.test(body.address) ? body.address.toLowerCase() : null;
      if (!addr) return json(res, 400, { error: 'That doesn’t look like a wallet address.' });
      if (limited(req, 'siwe', 20, 600000)) return json(res, 429, { error: 'Too many sign-in attempts from here. Try again in a few minutes.' });
      let who = null;
      if (head === 'claim') { who = byKey(req); if (!who) return json(res, 401, { error: 'not a member' });
        if (who.banned) return json(res, 403, { error: 'This profile was removed from the league.' }); }
      // (whether a wallet is claimed is only told after its owner signs: /login/finish)
      const reqHost = String(req.headers.host || '').toLowerCase();
      let host, uri;
      if (origins.length) { const o = origins.find(x => x.host === reqHost);
        if (!o) return json(res, 400, { error: 'Open Pulse at ' + origins[0].origin + '/pulse to sign with your wallet.' });
        host = o.host; uri = o.origin; }
      else { // not pinned (local or self-hosted without PUBLIC_ORIGIN): the address this page was served from
        host = reqHost.slice(0, 100).replace(/[^a-z0-9.:\-\[\]]/g, '') || 'pulse';
        uri = (String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https' || (req.socket && req.socket.encrypted) ? 'https' : 'http') + '://' + host; }
      const nonce = crypto.randomBytes(8).toString('hex');
      const statement = head === 'claim' ? 'Claim this wallet for @' + who.handle + ' on Pulse. This is a signature, not a transaction: it costs nothing and moves no funds.'
        : 'Sign in to Pulse with this wallet. This is a signature, not a transaction: it costs nothing and moves no funds.';
      const message = siweMessage({ domain: host, uri, address: sig.toChecksumAddress(addr), statement, nonce,
        issuedAt: new Date(now()).toISOString(), expirationTime: new Date(now() + 10 * 60000).toISOString() });
      sweep(pending);
      pending.set(nonce, { purpose: head, address: addr, memberId: who ? who.id : null, message, exp: now() + 10 * 60000 });
      return json(res, 200, { nonce, message });
    }
    if ((head === 'login' || head === 'claim') && parts[1] === 'finish' && M === 'POST') {
      if (!sig) return json(res, 501, { error: 'Wallet sign-in isn’t available on this server.' });
      const p = typeof body.nonce === 'string' ? pending.get(body.nonce) : null;
      if (!p || p.purpose !== head || p.exp < now()) return json(res, 400, { error: 'That sign-in request expired. Try again.' });
      pending.delete(body.nonce); // single use, whatever happens next
      let signer = null; try { signer = sig.recoverAddress(p.message, String(body.signature || '').slice(0, 200)); } catch (e) {}
      if (signer !== p.address) return json(res, 403, { error: 'That signature isn’t from ' + p.address.slice(0, 6) + '…' + p.address.slice(-4) + '. Switch your wallet to that account and try again.' });
      if (head === 'claim') {
        const me = own(S.members, p.memberId) ? S.members[p.memberId] : null;
        if (!me || me.banned || byKey(req) !== me) return json(res, 401, { error: 'not a member' });
        const prevAddr = me.address;
        // the wallet's signature wins: whoever else named or claimed it loses it
        for (const o of members()) if (o.id !== me.id && (o.claimed === p.address || o.address === p.address)) {
          if (o.claimed === p.address) o.claimed = null;
          o.address = null; o.vdays = null; o.vAt = 0; o.money = null;
          for (const c of Object.values(S.comps)) if (c.money) delete c.money[o.id]; }
        if (prevAddr !== p.address) { me.vdays = null; me.vAt = 0; me.money = null; for (const c of Object.values(S.comps)) if (c.money) delete c.money[me.id]; }
        me.claimed = p.address; me.claimedAt = now(); me.address = p.address; me.vFailAt = 0; me.moneyFailAt = 0;
        save(); refreshMoney(me, true); refreshBehavior(me, true);
        if (prevAddr && prevAddr !== p.address && opts.forgetAddress && !members().some(o => o.address === prevAddr)) opts.forgetAddress(prevAddr);
        return json(res, 200, { me: publicMember(me, me), share: me.share });
      }
      const m = members().find(x => x.claimed === p.address);
      if (!m) return json(res, 404, { error: 'No profile has claimed this wallet yet. Join first, then claim it under Profile & privacy.' });
      if (m.banned) return json(res, 403, { error: 'This profile was removed from the league.' });
      const key = addKey(m); m.lastSeen = now(); save(m);
      return json(res, 200, { key, me: publicMember(m, m), share: m.share });
    }
    // a one-time code from a signed-in device (Profile & privacy → Add a device)
    if (head === 'link' && parts[1] === 'finish' && M === 'POST') {
      if (limited(req, 'link', 20, 600000)) return json(res, 429, { error: 'Too many tries from here. Try again in a few minutes.' });
      const code = String(body.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16);
      let l = code && links.get(code);
      if (l && l.exp >= now()) links.delete(code);
      else { l = null; const h = code ? sha(code) : null; // a 7-day code the owner made in the admin panel
        const om = h && members().find(x => (x.pendingCodes || []).some(c => c.h === h && c.exp >= now()));
        if (om) { om.pendingCodes = om.pendingCodes.filter(c => c.h !== h); l = { memberId: om.id }; } }
      if (!l) return json(res, 400, { error: 'That code didn’t work. Codes work once, for 10 minutes (or 7 days when the owner made them).' });
      const m = own(S.members, l.memberId) ? S.members[l.memberId] : null;
      if (!m) return json(res, 400, { error: 'That code didn’t work.' });
      if (m.banned) return json(res, 403, { error: 'This profile was removed from the league.' });
      const key = addKey(m); m.lastSeen = now(); save(m);
      return json(res, 200, { key, me: publicMember(m, m), share: m.share });
    }

    // ---------- everything below needs a member key ----------
    const me = byKey(req);
    if (!me) return json(res, 401, { error: 'not a member' });
    if (me.banned) return json(res, 403, { error: 'This profile was removed from the league.' });
    me.lastSeen = now();
    if (now() - (me.seenSaved || 0) > 600000) { me.seenSaved = now(); save(me); } // last seen is written at most every ten minutes

    if (head === 'me' && M === 'GET') return json(res, 200, { me: publicMember(me, me), share: me.share, tier: me.tier || 0 });

    // ---- inbox: nudges, mentor notes, season results ----
    if (head === 'inbox' && M === 'GET') return json(res, 200, { items: (me.inbox || []).slice().reverse().map(x => Object.assign({}, x, { unread: x.at > (me.inboxRead || 0) })) });
    if (head === 'inbox' && parts[1] === 'read' && M === 'POST') { me.inboxRead = now(); save(me); return json(res, 200, { ok: true }); }

    // ---- web push: this device's subscription and when to remind ----
    if (head === 'push' && M === 'GET') return json(res, 200, { available: !!push, key: push ? push.publicKey : null, on: !!(me.push && me.push.subs && me.push.subs.length), prefs: sanitizePrefs(null, me.push && me.push.prefs) });
    if (head === 'push' && !parts[1] && (M === 'POST' || M === 'PUT')) {
      if (!push) return json(res, 404, { error: 'Push reminders aren’t set up on this server.' });
      me.push = me.push || { subs: [], prefs: null, sent: {} };
      if (body.subscription !== undefined) { const sub = Push.sanitizeSubscription(body.subscription); if (!sub) return json(res, 400, { error: 'This browser’s push service isn’t one Pulse can send to.' });
        me.push.subs = [...(me.push.subs || []).filter(x => x.endpoint !== sub.endpoint), sub].slice(-5); }
      me.push.prefs = sanitizePrefs(body.prefs, me.push.prefs); save(me);
      return json(res, 200, { ok: true, on: me.push.subs.length > 0, prefs: me.push.prefs });
    }
    // one device turns its reminders off (the endpoint names it); DELETE turns them off everywhere
    if (head === 'push' && parts[1] === 'remove' && M === 'POST') { const ep = String(body.endpoint || '');
      if (me.push) me.push.subs = (me.push.subs || []).filter(x => x.endpoint !== ep); save(me);
      return json(res, 200, { ok: true, on: !!(me.push && me.push.subs.length) }); }
    if (head === 'push' && !parts[1] && M === 'DELETE') { if (me.push) me.push.subs = []; save(me); return json(res, 200, { ok: true, on: false }); }
    if (head === 'push' && parts[1] === 'test' && M === 'POST') {
      if (limited(req, 'pushtest', 5, 3600000)) return json(res, 429, { error: 'Try again later.' });
      const n = await sendPush(me, { title: 'Pulse', body: 'Reminders are on. You’ll hear from Pulse at the times you picked.', tag: 'pulse-test', url: '/pulse#today' });
      return json(res, n ? 200 : 502, n ? { ok: true, sent: n } : { error: 'Your browser’s push service didn’t accept the message.' });
    }

    // ---- accountability partners ----
    if (head === 'partners' && M === 'GET' && !parts[1]) return json(res, 200, { partners: pairsOf(me).map(p => pairOut(p, me)).filter(Boolean) });
    if (head === 'partners' && !parts[1] && M === 'POST') {
      const o = byHandle(cleanText(body.handle, 21).replace(/^@/, ''));
      if (!o || o.banned || o.id === me.id) return json(res, 404, { error: 'No member by that name.' });
      const ex = pairsOf(me).find(p => p.a === o.id || p.b === o.id);
      if (ex && ex.status === 'active') return json(res, 409, { error: 'You’re already partners.' });
      if (ex && ex.from === o.id) { // they asked first: this accepts
        if (pairsOf(me).filter(p => p.status === 'active').length >= PARTNER_MAX) return json(res, 409, { error: 'You already have ' + PARTNER_MAX + ' partners.' });
        if (pairsOf(o).filter(p => p.status === 'active').length >= PARTNER_MAX) return json(res, 409, { error: '@' + o.handle + ' already has ' + PARTNER_MAX + ' partners.' });
        ex.status = 'active'; ex.since = now(); notify(o, 'partner', '@' + me.handle + ' is now your accountability partner.', { title: 'New partner', url: '/pulse#social' }); save('partners');
        return json(res, 200, { partner: pairOut(ex, me) }); }
      if (ex) return json(res, 409, { error: 'You’ve asked already — waiting for @' + o.handle + '.' });
      if (pairsOf(me).filter(p => p.status === 'active').length >= PARTNER_MAX) return json(res, 409, { error: 'You already have ' + PARTNER_MAX + ' partners.' });
      if (pairsOf(me).filter(p => p.status !== 'active' && p.from === me.id).length >= 5) return json(res, 409, { error: 'Five open requests is the limit.' });
      if (limited(req, 'partner', 20, 86400000)) return json(res, 429, { error: 'Too many requests today.' });
      const id = crypto.randomBytes(6).toString('hex');
      S.partners[id] = { id, a: me.id, b: o.id, from: me.id, status: 'pending', at: now(), nudged: {} };
      notify(o, 'partner', '@' + me.handle + ' wants to be accountability partners: you’d see each other’s streak, scores and slips.', { title: 'Partner request', url: '/pulse#social' });
      save('partners'); return json(res, 200, { partner: pairOut(S.partners[id], me) });
    }
    if (head === 'partners' && parts[1]) {
      const p = pairOf(me, arg); if (!p) return json(res, 404, { error: 'No such partnership.' });
      const o = otherIn(p, me);
      if (parts[2] === 'accept' && M === 'POST') { if (p.status === 'active') return json(res, 200, { partner: pairOut(p, me) });
        if (p.from === me.id) return json(res, 409, { error: 'Waiting for @' + (o ? o.handle : '') + ' to accept.' });
        if (pairsOf(me).filter(x => x.status === 'active').length >= PARTNER_MAX) return json(res, 409, { error: 'You already have ' + PARTNER_MAX + ' partners.' });
        if (o && pairsOf(o).filter(x => x.status === 'active').length >= PARTNER_MAX) return json(res, 409, { error: '@' + o.handle + ' already has ' + PARTNER_MAX + ' partners.' });
        p.status = 'active'; p.since = now(); if (o) notify(o, 'partner', '@' + me.handle + ' accepted — you’re accountability partners.', { title: 'New partner', url: '/pulse#social' });
        save('partners'); return json(res, 200, { partner: pairOut(p, me) }); }
      if (!parts[2] && M === 'DELETE') { delete S.partners[p.id]; save('partners'); return json(res, 200, { ok: true }); }
      if (p.status !== 'active') return json(res, 409, { error: 'Not partners yet.' });
      if (parts[2] === 'nudge' && M === 'POST') {
        p.nudged = p.nudged || {}; if (p.nudged[me.id] && now() - p.nudged[me.id] < 6 * 3600000) return json(res, 429, { error: 'One nudge every six hours.' });
        p.nudged[me.id] = now(); const text = cleanText(body.text, 140) || 'Stick to your plan today.';
        notify(o, 'partner', '@' + me.handle + ': ' + text, { title: 'Nudge from @' + me.handle, url: '/pulse#today', from: me.handle });
        save('partners'); return json(res, 200, { ok: true }); }
      if (parts[2] === 'challenge' && M === 'PUT') {
        const text = cleanText(body.text, 140); if (!text) return json(res, 400, { error: 'What’s the challenge?' });
        if (p.challenge && p.challenge.week === S.league.week && now() - p.challenge.at < 3600000) return json(res, 429, { error: 'One change an hour.' });
        p.challenge = { text, by: me.id, week: S.league.week, at: now() };
        notify(o, 'partner', '@' + me.handle + ' set this week’s shared challenge: ' + text, { title: 'Shared challenge', url: '/pulse#social' });
        save('partners'); return json(res, 200, { partner: pairOut(p, me) }); }
      return json(res, 404, { error: 'not found' });
    }

    // ---- mentors: notes on the days of members who let mentors in ----
    if (head === 'notes' && M === 'GET') return json(res, 200, { notes: commentsFor(me.id).slice().reverse().map(commentOut), mentorsOn: !!me.share.mentor });
    if (head === 'notes' && parts[1] === 'read' && M === 'POST') { for (const c of commentsFor(me.id)) c.read = true; save('comments'); return json(res, 200, { ok: true }); }
    if (head === 'mentor') {
      if (!me.mentor) return json(res, 403, { error: 'Only mentors the owner appointed can see this.' });
      if (!parts[1] && M === 'GET') return json(res, 200, { mentees: menteesOf(me).map(menteeSummary).sort((a, b) => (b.seen || 0) - (a.seen || 0)) });
      const o = byHandle(arg); if (!o || o.id === me.id || o.banned || !o.share.mentor) return json(res, 404, { error: 'That member hasn’t let mentors in.' });
      if (!parts[2] && M === 'GET') { const st = o.stats || {};
        return json(res, 200, { mentee: Object.assign(menteeSummary(o), { best: st.best || 0, habits: o.share.habits ? st.habits || [] : [], challenge: st.lastChallenge || '',
          days: (st.days || []).slice(-30).reverse().map(d => ({ k: d.k, s: d.s, f: d.f || [], l: d.l || '', r: !!d.r, j: !!d.j })),
          notes: commentsFor(o.id).slice().reverse().map(commentOut) }) }); }
      if (parts[2] === 'notes' && M === 'POST') {
        const day = DAY_RE.test(body.day) ? body.day : null, text = cleanText(body.text, 600);
        if (!text) return json(res, 400, { error: 'Write the note first.' });
        if (limited(req, 'mnote', 60, 3600000)) return json(res, 429, { error: 'Too many notes this hour.' });
        const c = { id: crypto.randomBytes(5).toString('hex'), by: me.id, day, text, at: now(), read: false };
        S.comments[o.id] = [...commentsFor(o.id), c].slice(-COMMENTS_MAX);
        notify(o, 'mentor', '@' + me.handle + ': ' + text, { title: 'A note from your mentor', url: '/pulse#today', day });
        save('comments'); return json(res, 200, { note: commentOut(c) }); }
      if (parts[2] === 'notes' && parts[3] && M === 'DELETE') {
        S.comments[o.id] = commentsFor(o.id).filter(c => !(c.id === parts[3] && c.by === me.id)); save('comments'); return json(res, 200, { ok: true }); }
      return json(res, 404, { error: 'not found' });
    }
    if (head === 'me' && M === 'PUT') {
      const r = typeof body.avatar === 'string' && MEDIA_RE.test(body.avatar) ? q('SELECT * FROM media WHERE id = ?').get(body.avatar) : null;
      if (body.avatar !== undefined && body.avatar !== null && (!r || r.member !== me.id || r.kind !== 'avatar')) return json(res, 400, { error: 'That picture didn’t upload. Try again.' });
      const newAddr = body.address !== undefined && !me.claimed ? (typeof body.address === 'string' && ADDR_RE.test(body.address) ? body.address.toLowerCase() : null) : undefined;
      if (newAddr && claimedBy(newAddr, me.id)) return json(res, 409, { error: 'That wallet is claimed by another profile. Only a signature from it can move it.', walletTaken: true });
      if (body.handle != null) { const h = cleanText(body.handle, 20).replace(/^@/, '');
        if (!HANDLE_RE.test(h)) return json(res, 400, { error: 'Pick a name of 3–20 letters, numbers or underscores.' });
        const other = byHandle(h); if (other && other.id !== me.id) return json(res, 409, { error: 'That name is taken.' }); me.handle = h; reindex(); }
      const prevAddr = me.address, prevVerify = !!me.share.verify, prevMoney = !!(me.share.ret || me.share.usd);
      if (body.share) me.share = sanitizeShare(body.share, me.share);
      if (typeof body.coachDetail === 'boolean') me.coachDetail = body.coachDetail;
      if (body.bio !== undefined) me.bio = cleanText(body.bio, 160);
      // a new picture replaces the old one (whose file goes); null takes it off
      if (body.avatar !== undefined) {
        if (!r || r.id !== me.avatar) { dropMedia(q('SELECT id FROM media WHERE member = ? AND kind = ? AND id != ?').all(me.id, 'avatar', r ? r.id : ''));
          if (r) q('UPDATE media SET ref = ? WHERE id = ?').run('avatar:' + me.id, r.id); me.avatar = r ? r.id : null; } }
      // a claimed wallet stays put: only releasing it (or claiming another) changes the address
      if (newAddr !== undefined) me.address = newAddr;
      if (!(me.share.ret || me.share.usd)) me.money = null;
      if (!me.share.verify || me.address !== prevAddr) { me.vdays = null; me.vAt = 0; }
      if (!me.share.ret) for (const c of Object.values(S.comps)) if (c.money) delete c.money[me.id]; // opting out hides past results too
      save(me, 'comps');
      refreshMoney(me, me.address !== prevAddr || (!prevMoney && !!(me.share.ret || me.share.usd)));
      refreshBehavior(me, me.address !== prevAddr || (!prevVerify && !!me.share.verify));
      if (prevAddr && prevAddr !== me.address && opts.forgetAddress && !members().some(o => o.address === prevAddr)) opts.forgetAddress(prevAddr);
      return json(res, 200, { me: publicMember(me, me), share: me.share });
    }
    if (head === 'me' && M === 'DELETE') {
      dropMember(me.id); save('follows', 'comps', 'leagues', 'partners', 'comments'); return json(res, 200, { ok: true });
    }
    if (head === 'claim' && parts[1] === 'release' && M === 'POST') {
      if (!me.claimed) return json(res, 400, { error: 'You haven’t claimed a wallet.' });
      me.claimed = null; me.claimedAt = 0;
      if (S.config.requireClaim) { me.vdays = null; me.money = null; for (const c of Object.values(S.comps)) if (c.money) delete c.money[me.id]; }
      save(me, 'comps'); return json(res, 200, { me: publicMember(me, me), share: me.share });
    }
    if (head === 'link' && parts[1] === 'start' && M === 'POST') {
      sweep(links);
      for (const [k, l] of links) if (l.memberId === me.id) links.delete(k); // one live code per member
      const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let code = '';
      for (const b of crypto.randomBytes(10)) code += A[b % 32];
      links.set(code, { memberId: me.id, exp: now() + 10 * 60000 });
      return json(res, 200, { code, expiresAt: now() + 10 * 60000 });
    }
    if (head === 'devices' && M === 'DELETE') { // sign out every other device: only the key making this call keeps working
      const h = sha(req.headers['x-pulse-key']); me.keyHash = h; me.keyHashes = []; reindex();
      for (const [k, l] of links) if (l.memberId === me.id) links.delete(k);
      save(me); return json(res, 200, { me: publicMember(me, me) });
    }
    // ---------- the encrypted journal (vault): ciphertext in, ciphertext out ----------
    if (head === 'vault' && M === 'GET') {
      // ?have=<rev>: the caller already holds this revision, so skip sending (up to 6 MB of) the copy
      if (me.vault && query.have !== undefined && +query.have === me.vault.rev)
        return json(res, 200, { rev: me.vault.rev, at: me.vault.at, unchanged: true, blob: null, max: MAX_VAULT_BODY, on: !!S.config.vaultOn, member: me.id });
      let blob = null; if (me.vault) try { blob = JSON.parse(fs.readFileSync(vaultFile(me.id), 'utf8')); } catch (e) { blob = null; }
      return json(res, 200, { rev: vaultRev(me), at: me.vault ? me.vault.at : null, blob, max: MAX_VAULT_BODY, on: !!S.config.vaultOn, member: me.id });
    }
    if (head === 'vault' && M === 'PUT') {
      if (!S.config.vaultOn) return json(res, 403, { error: 'Journal sync is switched off on this server.' });
      const cur = vaultRev(me);
      if (+body.rev !== cur) { // another device saved first: hand back its copy to merge
        let blob = null; try { blob = JSON.parse(fs.readFileSync(vaultFile(me.id), 'utf8')); } catch (e) {}
        return json(res, 409, { rev: cur, blob }); }
      const blob = sanitizeVaultBlob(body.blob); if (!blob) return json(res, 400, { error: 'invalid vault' });
      const text = JSON.stringify(blob), size = Buffer.byteLength(text);
      if (vaultTotal() - (me.vault ? me.vault.size : 0) + size > (opts.vaultTotalMax || MAX_VAULT_TOTAL)) return json(res, 507, { error: 'This server is out of room for synced journals. Tell its owner.' });
      fs.mkdirSync(vaultDir, { recursive: true });
      const f = vaultFile(me.id), tmp = f + '.tmp'; fs.writeFileSync(tmp, text); fs.renameSync(tmp, f);
      me.vault = { rev: cur + 1, size, at: now() }; save(me);
      return json(res, 200, { rev: me.vault.rev, at: me.vault.at });
    }
    if (head === 'vault' && M === 'DELETE') {
      try { fs.unlinkSync(vaultFile(me.id)); } catch (e) {}
      // one past the last copy: a device still holding it gets a 409 with nothing in it (deleted), not a silent re-upload
      me.vaultRev = vaultRev(me) + 1; me.vault = null; save(me); return json(res, 200, { ok: true, rev: me.vaultRev });
    }
    if (head === 'stats' && M === 'POST') {
      const next = sanitizeStats(body);
      if (!me.share.mentor) for (const d of next.days) delete d.l;
      const posted = new Set(me.postedHabits || []);
      for (const e of eventsFromStats(me.stats, next, me.share, S.config.levels.titles)) {
        if (e.type === 'habit') { if (posted.has(e.quote)) continue; posted.add(e.quote); }
        pushEvent(me, e);
      }
      me.postedHabits = [...posted].slice(-50);
      me.stats = next; me.statsAt = now();
      if (next.week) { me.weekXp = me.weekXp || {}; me.weekXp[next.week] = next.weekXp;
        const keep = Object.keys(me.weekXp).sort().slice(-16); /* a quarter's season needs 13 */ for (const k of Object.keys(me.weekXp)) if (!keep.includes(k)) delete me.weekXp[k]; }
      awardCheck(me);
      save(me); refreshAll(me);
      return json(res, 200, { ok: true, tier: me.tier || 0 });
    }
    // ---- leagues: browse, join, leave ----
    // ?q= finds open leagues by name or number (#1042 or 1042); without q: yours first, then the open ones, biggest first
    if (head === 'leagues' && M === 'GET' && !parts[1]) {
      const q = cleanText(query.q, 40).toLowerCase().replace(/^#/, '');
      let list = Object.values(S.leagues).filter(L => L.open || own(L.members, me.id));
      if (q) list = list.filter(L => String(L.num) === q || L.name.toLowerCase().includes(q) || (L.desc || '').toLowerCase().includes(q));
      const size = L => members().filter(m => own(L.members, m.id) && !m.banned).length;
      list.sort((a, b) => (own(b.members, me.id) ? 1 : 0) - (own(a.members, me.id) ? 1 : 0) || size(b) - size(a) || a.num - b.num);
      return json(res, 200, { q, leagues: list.slice(0, 50).map(L => leagueOut(L, me)) });
    }
    // a league's page before (or after) joining: what it ranks, its top five, its competitions
    if (head === 'leagues' && parts[1] && !parts[2] && M === 'GET') {
      const L = own(S.leagues, arg) ? S.leagues[arg] : Object.values(S.leagues).find(x => String(x.num) === arg.replace(/^#/, '')) || null;
      if (!L || (!L.open && !own(L.members, me.id))) return json(res, 404, { error: 'No such league.' });
      const W = leagueWindow(L), top = boardRows(leagueMembers(L), L.metric, { week: S.league.week, weeks: L.metric === 'xp' && W.weeks ? W.weeks : undefined, dayFrom: L.metric === 'xp' ? W.dayFrom : undefined, dayTo: W.dayTo, days: W.days });
      return json(res, 200, { league: Object.assign(leagueOut(L, me), { createdAt: L.createdAt, hall: (L.hall || []).slice().reverse().map(h => ({ season: h.season, label: h.label, n: h.n,
          podium: h.podium.map(r => ({ handle: own(S.members, r.id) ? S.members[r.id].handle : r.handle, value: r.value, me: r.id === me.id })) })),
        top: top.slice(0, 5).map(r => ({ rank: r.rank, handle: r.handle, av: avUrl(S.members[r.id]), value: r.value, sub: r.sub, me: r.id === me.id })),
        tiersCount: L.tiers ? TIERS.map((t, i) => ({ tier: t, n: members().filter(m => own(L.members, m.id) && !m.banned && leagueTier(L, m) === i).length })) : null,
        comps: Object.values(S.comps).filter(c => c.league === L.id && compStatus(c, todayKey()) !== 'finished').map(c => ({ id: c.id, title: c.title, start: c.start, end: c.end, type: c.type })) }) });
    }
    if (head === 'leagues' && parts[1] && parts[2] === 'join' && (M === 'POST' || M === 'DELETE')) {
      const L = own(S.leagues, arg) ? S.leagues[arg] : null; if (!L || (!L.open && !own(L.members, me.id))) return json(res, 404, { error: 'No such league.' });
      if (M === 'DELETE') { delete L.members[me.id]; if (L.id === 'main') me.tier = 0; }
      else { if (L.invite && !own(L.members, me.id)) { if (limited(req, 'invite', 20, 600000)) return json(res, 429, { error: 'Too many tries from here. Try again in a few minutes.' });
          if (!sameText(cleanText(body.invite, 40), L.invite)) return json(res, 403, { error: 'That invite code isn’t right.' }); }
        const was = own(L.members, me.id); joinLeague(L, me); if (L.id === 'main' && !was) me.tier = 0;
        if (!was && L.open && !L.invite && me.share.feed) pushEvent(me, { type: 'league', text: 'joined ' + L.name }); }
      save(me, 'leagues'); return json(res, 200, { league: leagueOut(L, me) });
    }
    // one league's own ranking (its measure, by tier when it has tiers); default: main, else the first one you're in
    if (head === 'league' && M === 'GET') {
      const L = own(S.leagues, query.id) && own(S.leagues[query.id].members, me.id) ? S.leagues[query.id]
        : own(S.leagues.main ? S.leagues.main.members : {}, me.id) ? S.leagues.main : leaguesOf(me)[0] || null;
      if (!L) return json(res, 200, { league: null, rows: [], me: null, mine: [] });
      const tier = leagueTier(L, me), rows = leagueBoard(L, L.metric, me);
      const n = L.tiers ? members().filter(m => !m.banned && own(L.members, m.id) && leagueTier(L, m) === tier).length : rows.length, k = L.tiers ? leagueMoveCount(n) : 0;
      return json(res, 200, { league: leagueOut(L, me), tier, tierName: TIERS[tier], week: S.league.week, size: n, promote: tier < TIERS.length - 1 ? k : 0, demote: tier > 0 ? k : 0,
        board: L.metric, label: BOARDS[L.metric].label, mine: leaguesOf(me).map(x => ({ id: x.id, name: x.name })),
        rows: rows.slice(0, 50).map(r => ({ rank: r.rank, handle: r.handle, av: avUrl(S.members[r.id]), value: r.value, sub: r.sub, me: r.id === me.id })), me: rows.find(r => r.id === me.id) || null });
    }
    // boards: scope=global (everyone who opted in to global boards) or a league's members
    if (head === 'leaderboard' && M === 'GET') {
      const board = own(BOARDS, query.board) ? query.board : 'discipline', global = query.scope === 'global';
      for (const m of members()) refreshAll(m); // background; boards show what's cached
      let rows, L = null;
      if (global) rows = boardRows(members().filter(m => m.share.global), board, { week: S.league.week });
      else { L = own(S.leagues, query.league) && own(S.leagues[query.league].members, me.id) ? S.leagues[query.league] : own((S.leagues.main || {}).members || {}, me.id) ? S.leagues.main : leaguesOf(me)[0] || null;
        rows = L ? leagueBoard(L, board, me) : []; }
      const mine = rows.find(r => r.id === me.id) || null;
      const needKey = global && !me.share.global ? 'global' : !me.share[BOARDS[board].needs] ? BOARDS[board].needs : BOARDS[board].verified && !me.share.verify ? 'verify' : null;
      return json(res, 200, { board, label: BOARDS[board].label, scope: global ? 'global' : 'league', league: L ? { id: L.id, name: L.name } : null,
        rows: rows.slice(0, 50).map(r => ({ rank: r.rank, handle: r.handle, av: avUrl(S.members[r.id]), tier: r.tier, value: r.value, sub: r.sub, me: r.id === me.id })),
        me: mine, total: rows.length, optedIn: !needKey, need: needKey,
        verifyState: !BOARDS[board].verified || !me.share.verify ? null : !canVerify ? 'unavailable' : !me.address ? 'no-wallet' : !walletFor(me) ? 'claim' : !Array.isArray(me.vdays) ? 'pending' : 'ok' });
    }
    if (head === 'feed' && M === 'GET') {
      const scope = query.scope === 'discover' ? 'discover' : 'following', postsOnly = query.kind === 'posts';
      const fol = [...new Set([...(S.follows[me.id] || []), me.id])];
      const where = [scope === 'following' ? '(member IS NULL OR member IN (SELECT value FROM json_each(?)))' : '', postsOnly ? "type = 'post'" : ''].filter(Boolean).join(' AND ');
      const page = feedPage(me, where, scope === 'following' ? [JSON.stringify(fol)] : [], query.before, Math.round(clampNum(query.limit, 5, 60) || 30));
      const folSet = new Set(fol);
      const suggest = scope === 'discover' && !query.before ? topDiscipline().filter(x => own(S.members, x.id) && !S.members[x.id].banned && !folSet.has(x.id)).slice(0, 3)
        .map(({ id, d }) => { const m = S.members[id]; return { handle: m.handle, av: avUrl(m), tierName: TIERS[m.tier || 0], why: 'Level ' + ((m.stats && m.stats.level) || 1) + (d != null ? ' · discipline ' + Math.round(d) : '') }; }) : [];
      return json(res, 200, { scope, events: eventsOut(page.rows, me), next: page.next, suggest, posts: postCfgOut() });
    }
    if (head === 'kudos' && parts[1] && M === 'POST') {
      const e = eventById(parts[1]); if (!e || !visible(e, me)) return json(res, 404, { error: 'no such post' });
      if (e.member === me.id) return json(res, 400, { error: 'That’s your own post.' });
      const liked = tx(() => { if (q('DELETE FROM kudos WHERE event = ? AND member = ?').run(e.id, me.id).changes) { q('UPDATE events SET kudos = max(0, kudos - 1) WHERE id = ?').run(e.id); return false; }
        q('INSERT INTO kudos (event, member, at) VALUES (?, ?, ?)').run(e.id, me.id, now()); q('UPDATE events SET kudos = kudos + 1 WHERE id = ?').run(e.id); return true; });
      return json(res, 200, { kudos: q('SELECT kudos FROM events WHERE id = ?').get(e.id).kudos, liked });
    }
    if (head === 'profile' && parts[1] && M === 'GET') {
      const m = byHandle(arg); if (!m || m.banned) return json(res, 404, { error: 'No one by that name.' });
      if (parts[2] === 'posts') { const page = feedPage(me, "member = ? AND type = 'post'", [m.id], query.before, 20);
        return json(res, 200, { posts: eventsOut(page.rows, me), next: page.next }); }
      const ev = feedPage(me, "member = ? AND type != 'post'", [m.id], null, 10).rows, posts = feedPage(me, "member = ? AND type = 'post'", [m.id], null, 10);
      return json(res, 200, { profile: publicMember(m, me), events: eventsOut(ev, me), posts: eventsOut(posts.rows, me), postsNext: posts.next });
    }
    // ---- posts: a trade the member took or plans to take (with the thesis and pictures), or a note ----
    if (head === 'posts' && !parts[1] && M === 'POST') {
      const pc = S.config.posts;
      if (!pc.on) return json(res, 403, { error: 'Posts are switched off on this server.' });
      const kind = POST_KINDS.includes(body.kind) ? body.kind : 'note';
      if (kind === 'plan' && !pc.plans) return json(res, 403, { error: 'Posts about planned trades are switched off on this server.' });
      const text = cleanPost(body.text, 2000);
      const trade = kind === 'note' ? null : sanitizeTrade(body.trade, null, { kind, usd: !!me.share.usd });
      if (kind !== 'note' && !trade) return json(res, 400, { error: 'The trade needs a coin, a side and an entry, with the stop and target on the right sides of it.' });
      if (!text && kind !== 'trade') return json(res, 400, { error: 'Write something first.' });
      const media = sanitizeMediaIds(body.media, me, null); if (media === false) return json(res, 400, { error: 'One of the images is missing. Add it again.' });
      if (media.length && !pc.images) return json(res, 403, { error: 'Images on posts are switched off on this server.' });
      if (dayLimit(me, 'postLog', POSTS_PER_DAY)) return json(res, 429, { error: POSTS_PER_DAY + ' posts a day is the limit.' });
      const id = crypto.randomBytes(6).toString('hex');
      tx(() => { q("INSERT INTO events (id, at, member, type, text, quote, data) VALUES (?, ?, ?, 'post', ?, '', ?)").run(id, now(), me.id, text, JSON.stringify({ kind, trade, media }));
        for (const mid of media) q('UPDATE media SET ref = ? WHERE id = ?').run('post:' + id, mid); });
      save(me); verifyPost(id, me);
      return json(res, 200, { post: eventOut(eventById(id), me, null) });
    }
    if (head === 'posts' && parts[1]) {
      const e = eventById(arg); if (!e || e.type !== 'post' || !visible(e, me)) return json(res, 404, { error: 'That post isn’t here any more.' });
      if (!parts[2] && M === 'GET') {
        const cs = q('SELECT * FROM comments WHERE event = ? ORDER BY at DESC LIMIT 300').all(e.id).reverse().filter(c => own(S.members, c.member) && !S.members[c.member].banned);
        return json(res, 200, { post: eventOut(e, me, likedBy(me, [e])), comments: cs.map(c => commentRowOut(c, me, e)) }); }
      if (!parts[2] && M === 'PUT') {
        if (e.member !== me.id) return json(res, 403, { error: 'Only its author can change a post.' });
        let d = {}; try { d = JSON.parse(e.data || '{}') || {}; } catch (x) {}
        let text = e.text, edited = e.edited || null;
        // the thesis can be fixed for 15 minutes; after that only the outcome is added
        if (body.text !== undefined && cleanPost(body.text, 2000) !== e.text) { if (now() - e.at > POST_EDIT_MS) return json(res, 409, { error: 'The thesis can only be edited in the first 15 minutes. Add an update instead.' });
          text = cleanPost(body.text, 2000); edited = now(); }
        // a plan can't have been taken before it was posted
        if (body.trade && d.trade) d.trade = sanitizeTrade(body.trade, d.trade, { usd: !!me.share.usd, notBefore: d.kind === 'plan' ? e.at - 60000 : 0 });
        // the update, like the thesis, can be fixed for 15 minutes after it's first written
        if (body.outcome !== undefined) { const o = cleanPost(body.outcome, 500);
          if (o !== (d.outcome || '')) { if (d.outcome && now() - (d.outcomeFirst || d.outcomeAt || 0) > POST_EDIT_MS) return json(res, 409, { error: 'The update can only be changed in its first 15 minutes.' });
            if (!d.outcome) d.outcomeFirst = now(); d.outcome = o; d.outcomeAt = now(); } }
        q('UPDATE events SET text = ?, data = ?, edited = ? WHERE id = ?').run(text, JSON.stringify(d), edited, e.id);
        verifyPost(e.id, me);
        return json(res, 200, { post: eventOut(eventById(e.id), me, likedBy(me, [e])) }); }
      if (!parts[2] && M === 'DELETE') { if (e.member !== me.id) return json(res, 403, { error: 'Only its author can delete a post.' }); dropEvent(e.id); return json(res, 200, { ok: true }); }
      if (parts[2] === 'comments' && M === 'POST') {
        const text = cleanPost(body.text, 500); if (!text) return json(res, 400, { error: 'Write the comment first.' });
        if (limited(req, 'comment:' + me.id, 60, 3600000)) return json(res, 429, { error: 'That’s a lot of comments this hour.' });
        const id = crypto.randomBytes(6).toString('hex');
        tx(() => { q('INSERT INTO comments (id, event, member, at, text) VALUES (?, ?, ?, ?, ?)').run(id, e.id, me.id, now(), text);
          q('UPDATE events SET comments = comments + 1 WHERE id = ?').run(e.id); });
        const author = own(S.members, e.member) ? S.members[e.member] : null;
        if (author && author.id !== me.id) { notify(author, 'comment', '@' + me.handle + ' on your post: ' + text, { title: 'New comment', url: '/pulse#post/' + e.id, post: e.id }); save(author); }
        return json(res, 200, { comment: commentRowOut(q('SELECT * FROM comments WHERE id = ?').get(id), me, e), comments: e.comments + 1 }); }
      return json(res, 404, { error: 'not found' });
    }
    // a comment goes when its writer or the post's author deletes it
    if (head === 'comments' && parts[1] && M === 'DELETE') {
      const c = /^[a-f0-9]{12}$/.test(arg) ? q('SELECT * FROM comments WHERE id = ?').get(arg) : null, e = c ? eventById(c.event) : null;
      if (!c || !e || (c.member !== me.id && e.member !== me.id)) return json(res, 404, { error: 'No such comment.' });
      dropComment(c); return json(res, 200, { ok: true });
    }
    // anything someone finds out of line goes to the owner's queue
    if (head === 'report' && M === 'POST') {
      const c = typeof body.comment === 'string' && /^[a-f0-9]{12}$/.test(body.comment) ? q('SELECT * FROM comments WHERE id = ?').get(body.comment) : null;
      const e = c ? eventById(c.event) : eventById(body.post);
      if (!e || !visible(e, me) || (body.comment && !c)) return json(res, 404, { error: 'That isn’t here any more.' });
      if ((c ? c.member : e.member) === me.id) return json(res, 400, { error: 'That’s your own.' });
      if (limited(req, 'report:' + me.id, 20, 86400000)) return json(res, 429, { error: 'Too many reports today.' });
      q('INSERT OR IGNORE INTO reports (id, event, comment, member, at, why) VALUES (?, ?, ?, ?, ?, ?)').run(crypto.randomBytes(6).toString('hex'), c ? null : e.id, c ? c.id : null, me.id, now(), cleanText(body.why, 200));
      return json(res, 200, { ok: true });
    }
    if (head === 'follow' && parts[1] && (M === 'POST' || M === 'DELETE')) {
      const m = byHandle(arg); if (!m || m.banned || m.id === me.id) return json(res, 404, { error: 'No one by that name.' });
      const f = S.follows[me.id] = (S.follows[me.id] || []).filter(x => x !== m.id);
      if (M === 'POST') f.push(m.id);
      save('follows'); return json(res, 200, { following: M === 'POST' });
    }
    const compVisible = c => !c.league || (own(S.leagues, c.league) && own(S.leagues[c.league].members, me.id)) || !!c.entrants[me.id];
    if (head === 'competitions' && M === 'GET' && !parts[1]) {
      for (const c of Object.values(S.comps)) if (c.entrants[me.id]) { if (c.type === 'return') refreshMoney(me); if (c.type === 'discipline') refreshBehavior(me); }
      return json(res, 200, { competitions: Object.values(S.comps).filter(compVisible).sort((a, b) => a.start < b.start ? 1 : -1).map(c => compOut(c, me, false)) });
    }
    if (head === 'competitions' && parts[1] && M === 'GET') {
      const c = own(S.comps, arg) ? S.comps[arg] : null; if (!c || !compVisible(c)) return json(res, 404, { error: 'no such competition' });
      return json(res, 200, { competition: compOut(c, me, true) });
    }
    if (head === 'competitions' && parts[1] && parts[2] === 'join' && (M === 'POST' || M === 'DELETE')) {
      const c = own(S.comps, arg) ? S.comps[arg] : null; if (!c || !compVisible(c)) return json(res, 404, { error: 'no such competition' });
      if (compStatus(c, todayKey()) === 'finished') return json(res, 400, { error: 'This competition has finished.' });
      if (M === 'POST' && c.league && !own(S.leagues[c.league].members, me.id)) return json(res, 403, { error: 'This competition is for ' + S.leagues[c.league].name + ' — join that league first.' });
      if (M === 'DELETE') delete c.entrants[me.id];
      else {
        const need = S.config.unlocksOn && !me.unlocked && S.config.modules.compete > 1 ? S.config.modules.compete : 0;
        if (need && ((me.stats && me.stats.level) || 1) < need) return json(res, 403, { error: 'Competitions unlock at level ' + need + '.' });
        if (c.type === 'return' && !(me.address && me.share.ret)) return json(res, 400, { error: 'Return competitions read your wallet on chain: add your address and switch on “Show % return” in What you share.' });
        if (c.type === 'return' && !walletFor(me)) return json(res, 400, { error: 'This league only counts claimed wallets. Claim yours under Profile & privacy first.' });
        c.entrants[me.id] = { joinedAt: now() };
        if (me.share.feed) pushEvent(me, { type: 'compete', text: 'joined ' + c.title });
        if (c.type === 'return') refreshMoney(me, true);
      }
      save('comps'); return json(res, 200, { joined: M === 'POST' });
    }
    return json(res, 404, { error: 'not found' });
  }
  // for the AI coach in server.js: who is asking, and whether today's allowance has room
  const coach = {
    statusFor: req => { const m = byKey(req); return m ? { who: 'member', member: m, ...coachStatusFor(m) } : null; },
    ownerStatus: () => { const lim = S.config.coach.ownerDaily, k = utcDayKey(now()), used = S.ownerCoach.k === k ? S.ownerCoach.n : 0;
      return { who: 'owner', allowed: !lim || used < lim, reason: lim && used >= lim ? 'You’ve used today’s ' + lim + ' coach messages.' : null, limit: lim || null, used, remaining: lim ? Math.max(0, lim - used) : null, detail: true, detailAllowed: true }; },
    // reserve a message before asking the model (so parallel requests can't all pass), and give it back if no answer came
    count: (m, d = 1) => { if (m) { const used = coachUsed(m), tz = used ? coachTz(m) : (m.stats && m.stats.tz) || 'UTC';
        m.coachUse = { k: zoneKey(tz, now()), tz, n: Math.max(0, used + d) }; }
      else { const k = utcDayKey(now()); S.ownerCoach = { k, n: Math.max(0, (S.ownerCoach.k === k ? S.ownerCoach.n : 0) + d) }; } save(m || 'ownerCoach'); },
  };
  return { handle, coach, tick, memberOf: req => { const m = byKey(req); return m && !m.banned ? m : null; }, state: () => S, store, close: () => store.close() };
}

module.exports = { createSocial, sanitizeTrade, sanitizePostCfg, sanitizeStats, sanitizeShare, sanitizeComp, sanitizeVaultBlob, siweMessage, eventsFromStats, portfolioStats, leagueRollover, leagueRolloverBy, isoWeekMonday,
  boardRows, compStandings, compStatus, disciplineOver, isoWeekOfKey, seasonOf, seasonBounds, seasonLabel, weeksIn, TIERS, DEFAULT_CONFIG, DEFAULT_SHARE };
