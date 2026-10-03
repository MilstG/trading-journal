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
//     AUTH_TOKEN gates the admin endpoints; the owner can also make members admins, who reach
//     them with their own member key (never the token, so never the owner's journal or server).
//   - The journal sync (vault) is end-to-end encrypted: the browser encrypts with a key from
//     the member's passphrase before sending, so this server only ever stores ciphertext.
//
// Pure helpers are exported for tests; createSocial() wires them to HTTP.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const SC = require('./social-config.js');
const Store = require('./db.js');
const Bench = require('./bench.js');
const Duels = require('./duels.js');
const Insights = require('./insights.js');
const Push = require('./push.js');
// Ethereum signature recovery for wallet claims (vendored noble libraries, no install needed)
let ethSig = null; try { ethSig = require('./vendor/eth-sig.js'); } catch (e) { /* claims and wallet sign-in answer 501 */ }
// Passkeys (WebAuthn): sign in on any device with Face ID, a fingerprint or a security key
const WebAuthn = require('./webauthn.js');
const PASSKEY_MAX = 10;

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
const MAX_MEDIA_MEMBER = 100 * 1024 * 1024;      // one member's images
const POSTS_PER_DAY = 10, MEDIA_PER_DAY = 40, POST_EDIT_MS = 15 * 60000;
const MAX_VAULT_BODY = 6 * 1024 * 1024;   // one encrypted journal (the ciphertext is base64: ~4.5 MB of journal)
const MAX_VAULT_TOTAL = 1024 * 1024 * 1024; // all members' encrypted journals together
const MAX_KEYS = 10;                       // signed-in devices per member; the oldest drops out
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const MAX_MEMBERS = 5000;
const WALLETS_SEEN_MAX = 20000; // wallets entered in the app that the owner's Wallets list keeps
const STREAK_MARKS = [7, 14, 21, 30, 50, 75, 100, 150, 200, 365];
const COMP_TYPES = ['discipline', 'survivor', 'journal', 'return'];
// guestCap: people using Pulse without a profile stop at this level (their XP still counts, and creating a
// profile unlocks what they earned); 0 = no limit
// mult: the XP multiplier for holding Trader Age (on, the rating bar, and [trading weeks held, multiplier] tiers)
const DEFAULT_MULT = { on: true, bar: 70, tiers: [[2, 1.05], [4, 1.1], [8, 1.2], [13, 1.3], [26, 1.5]] };
function sanitizeMult(b, prev) {
  const o = Object.assign({}, DEFAULT_MULT, prev || {});
  if (b && typeof b === 'object') {
    if (typeof b.on === 'boolean') o.on = b.on;
    const bar = clampNum(b.bar, 40, 95); if (bar != null) o.bar = Math.round(bar);
    if (Array.isArray(b.tiers)) {
      // ascending weeks (1–104) and ascending multipliers (1.01–3), at most 8 tiers
      const t = b.tiers.map(x => Array.isArray(x) ? [Math.round(clampNum(x[0], 1, 104) || 0), Math.round((clampNum(x[1], 1.01, 3) || 0) * 100) / 100] : null)
        .filter(x => x && x[0] && x[1]).sort((a, c) => a[0] - c[0]).slice(0, 8);
      if (t.length && t.every((x, i) => !i || (x[0] > t[i - 1][0] && x[1] > t[i - 1][1]))) o.tiers = t;
    }
  }
  return { on: !!o.on, bar: o.bar, tiers: o.tiers.map(x => [x[0], x[1]]) };
}
// standing: duels, competitions, the leaderboards and the coach's full allowance are kept by holding
// Trader Age over the last 20 trading days (on, the rating bar, and the days of grace before they lock)
const DEFAULT_STANDING = { on: true, bar: 60, grace: 14 };
function sanitizeStanding(b, prev) {
  const o = Object.assign({}, DEFAULT_STANDING, prev || {});
  if (b && typeof b === 'object') {
    if (typeof b.on === 'boolean') o.on = b.on;
    const bar = clampNum(b.bar, 40, 90); if (bar != null) o.bar = Math.round(bar);
    const g = clampNum(b.grace, 3, 60); if (g != null) o.grace = Math.round(g);
  }
  return { on: !!o.on, bar: o.bar, grace: o.grace };
}
// mentorXp: XP for mentoring (levels only: league tables and duels never count it). A trade reviewed with
// a comment, a note on a mentee's day (a few a day), and a bonus when a mentee you've worked with in the
// last 30 days reaches something verified; effort is capped per day.
const DEFAULT_MENTOR_XP = { on: true, review: 15, note: 5, notesPerDay: 3, outcome: 25, cap: 60 };
function sanitizeMentorXp(b, prev) {
  const o = Object.assign({}, DEFAULT_MENTOR_XP, prev || {});
  if (b && typeof b === 'object') {
    if (typeof b.on === 'boolean') o.on = b.on;
    for (const [k, lo, hi] of [['review', 0, 200], ['note', 0, 100], ['notesPerDay', 0, 20], ['outcome', 0, 500], ['cap', 0, 1000]]) { const v = clampNum(b[k], lo, hi); if (v != null) o[k] = Math.round(v); }
  }
  return { on: !!o.on, review: o.review, note: o.note, notesPerDay: o.notesPerDay, outcome: o.outcome, cap: o.cap };
}
const DEFAULT_CONFIG = { open: true, inviteCode: '', unlocksOn: true, requireClaim: false, approveWallets: false, vaultOn: true, guestCap: 3,
  unlocks: { trends: 2, share: 3, compete: 4 } };
const SHARE_KEYS = ['profile', 'boards', 'global', 'page', 'feed', 'habits', 'verify', 'ret', 'usd', 'addr', 'mentor', 'bench', 'duels', 'seek'];
// New members start with everything on except dollar P&L, the wallet address and "looking for a partner";
// they can switch any of it off before joining or later. Existing members keep what they had.
// mentor: the league's mentors can see your trading days (scores, slips, the lesson you wrote) and comment on them
// global: appear on the server-wide leaderboards (every member, every league)
// page: a public badge page at /b/<name> that anyone with the link can open
// ret: 30-day % return and drawdown, read on chain from the first wallet
// duels: other members can challenge you 1 on 1 (you still choose whether to accept)
// bench: an anonymous summary of your trading counts toward "traders like you" — on unless switched off
const DEFAULT_SHARE = { profile: true, boards: true, global: true, page: true, feed: true, habits: true, verify: true, ret: true, usd: false, addr: false, mentor: true, bench: true, duels: true, seek: false };

const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const clampNum = (v, lo, hi) => { if (v !== null && typeof v === 'object') return null; const n = +v; return isFinite(n) ? Math.min(hi, Math.max(lo, n)) : null; };
// invite codes are compared in constant time
const sameText = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
// a post's text keeps its line breaks (at most one blank line in a row); other control characters go
const cleanPost = (s, max) => String(s == null ? '' : s).replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, ' ')
  .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, max);
const cleanText = (s, max) => String(s == null || typeof s === 'object' ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
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
      // for Trader Age: morning prep done, the share of trades journaled, the loss limit kept (1) or broken (0)
      if (d.p) o.p = 1;
      const jn = clampNum(d.jn, 0, 1); if (jn) o.jn = Math.round(jn * 100) / 100;
      if (d.lm === 0 || d.lm === 1) o.lm = d.lm;
      if (d.pl === 1 || d.pl === 0.5) o.pl = d.pl; // a plan before the first trade (half: written late)
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
    // the first fill in the app's history, for "trading for" next to Trader Age (2015 onwards, never in the future)
    firstAt: clampNum(b.firstAt, 1420070400000, Date.now() + 864e5) || null,
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
// members: an array, or the members object keyed by id (no lookup map to build per call)
// walletGate (optional): m -> a reason the member's wallet doesn't count yet (owner approval), or null
function compStandings(c, members, todayKey, requireClaim, walletGate) {
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
// A trade a member sends their mentors for review: what a trade post carries (market, side, times,
// prices, the result as % and R), a size range instead of the size, their note and plan, and the
// dollar result only for members who share dollar P&L.
const SIZE_RANGES = ['under $1k', '$1k to $10k', '$10k to $100k', '$100k to $1M', 'over $1M'];
function sanitizeReviewTrade(b, opts) {
  if (!b || typeof b !== 'object') return null;
  const coin = String(b.coin || '').trim(), side = b.side === 'short' ? 'short' : b.side === 'long' ? 'long' : null, openedAt = stamp(b.openedAt);
  if (!COIN_RE.test(coin) || !side || openedAt == null) return null;
  const c = stamp(b.closedAt), closedAt = c != null && c >= openedAt ? c : null, num = (v, lo, hi) => v == null || v === '' ? null : clampNum(v, lo, hi);
  const t = { coin, side, market: b.market === 'spot' ? 'spot' : 'perp', openedAt, closedAt };
  const label = cleanText(b.label, 40); if (label) t.label = label;
  for (const k of ['entry', 'stop', 'target'].concat(closedAt ? ['exit'] : [])) { const v = price(b[k]); if (v != null) t[k] = v; }
  const sz = num(b.size, 0, SIZE_RANGES.length - 1); if (sz != null) t.size = Math.round(sz);
  if (closedAt) { const pct = num(b.pct, -1000, 1000), r = num(b.r, -100, 100), usd = num(b.usd, -1e9, 1e9);
    if (pct != null) t.pct = Math.round(pct * 100) / 100; if (r != null) t.r = Math.round(r * 100) / 100;
    if (usd != null && opts && opts.usd) t.usd = Math.round(usd * 100) / 100; }
  for (const [k, max] of [['setup', 40], ['note', 1500], ['plan', 500]]) { const v = k === 'setup' ? cleanText(b[k], max) : cleanPost(b[k], max); if (v) t[k] = v; }
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
    let raw = null, old = null; try { raw = fs.readFileSync(legacyFile, 'utf8'); } catch (e) {}
    if (raw != null) { try { old = JSON.parse(raw); } catch (e) {}
      // a league file that's there but can't be read must not turn into an empty league that then
      // can never import it: stop and say so
      if (!old || old.v !== 1) throw new Error(legacyFile + ' could not be read, so the league was not imported. Fix or move the file, then start again.'); }
    if (old) { Store.importJson(store, old); try { fs.renameSync(legacyFile, legacyFile + '.migrated'); } catch (e) {} }
  }
  // every section kept as a kv row: one missing here is never loaded or saved (wallet decisions and
  // the admin log would vanish on the next restart)
  const KV_KEYS = ['config', 'follows', 'comps', 'league', 'leagues', 'badges', 'ownerCoach', 'partners', 'comments', 'leagueSeq', 'wallets', 'adminLog', 'coachUse', 'migrations', 'bench', 'benchSeeds', 'duels', 'benchHist', 'pods', 'ladder', 'visits', 'walletsSeen'];
  let S = { v: 1, members: {} };
  const loadedRaw = new Map(); // what each row held, so the first save writes only what loading changed
  for (const r of q('SELECT k, v FROM kv').all()) if (KV_KEYS.includes(r.k)) try { S[r.k] = JSON.parse(r.v); loadedRaw.set(r.k, r.v); } catch (e) {}
  for (const r of q('SELECT data FROM members').all()) try { const m = JSON.parse(r.data); if (m && m.id) { S.members[m.id] = m; loadedRaw.set('m:' + m.id, r.data); } } catch (e) {}
  if (!S.config || typeof S.config !== 'object') S.config = {};
  if (!S.follows || typeof S.follows !== 'object') S.follows = {};
  if (!S.comps || typeof S.comps !== 'object') S.comps = {};
  if (!S.league || typeof S.league !== 'object') S.league = { week: null };
  const claimSaved = typeof S.config.requireClaim === 'boolean';
  S.config = Object.assign({}, DEFAULT_CONFIG, S.config, {
    unlocks: Object.assign({}, DEFAULT_CONFIG.unlocks, S.config && S.config.unlocks) });
  delete S.config.themes; // colour themes were dropped
  S.config.guestCap = Math.max(0, Math.min(100, Math.round(+S.config.guestCap))) || 0;
  S.config.mult = sanitizeMult(S.config.mult, null);
  S.config.standing = sanitizeStanding(S.config.standing, null);
  S.config.mentorXp = sanitizeMentorXp(S.config.mentorXp, null);
  // v0.4 sections; v0.3's three unlock levels carry over into the feature map
  S.config.modules = SC.sanitizeModules(S.config.modules || S.config.unlocks, null);
  S.config.levels = SC.sanitizeLevels(S.config.levels, null);
  S.config.xp = SC.sanitizeXp(S.config.xp, null);
  S.config.coach = SC.sanitizeCoachCfg(S.config.coach, null);
  S.config.profiles = SC.sanitizeProfiles(S.config.profiles, null);
  S.config.posts = sanitizePostCfg(S.config.posts, null);
  S.config.bench = Bench.sanitizeBenchCfg(S.config.bench, null);
  S.config.duels = Duels.sanitizeDuelCfg(S.config.duels, null);
  if (!S.badges || typeof S.badges !== 'object') S.badges = {};
  // the owner's wallet decisions, by address (so a new profile can't launder a rejected wallet):
  // { '0x…': { s: 'approved' | 'rejected', at, by: 'owner' | 'existing', note } }
  if (!S.wallets || typeof S.wallets !== 'object') S.wallets = {};
  // every wallet address entered in the app, with or without a profile, by address: { '0x…': { first, last } }
  // (last moves at most once a UTC day); the owner sees them under Wallets and they're queued as seed wallets
  if (!S.walletsSeen || typeof S.walletsSeen !== 'object' || Array.isArray(S.walletsSeen)) S.walletsSeen = {};
  if (!S.ownerCoach) S.ownerCoach = { k: null, n: 0 };
  // what admins did in the panel, newest last: {at, by, what}
  if (!Array.isArray(S.adminLog)) S.adminLog = [];
  // AI coach messages asked today, per profile ('m:<id>') and per wallet ('w:<address>'): {k: day, tz, n}
  if (!S.coachUse || typeof S.coachUse !== 'object') S.coachUse = {};
  if (!S.migrations || typeof S.migrations !== 'object') S.migrations = {};
  // "traders like you": the last build of the peer groups, and the owner's seed wallets by address
  if (!S.bench || typeof S.bench !== 'object') S.bench = null;
  if (!S.benchSeeds || typeof S.benchSeeds !== 'object') S.benchSeeds = {};
  // each contributor's weekly summaries, ~26 weeks, by 'm:<member id>' or 's:<seed address>' (never sent out)
  if (!S.benchHist || typeof S.benchHist !== 'object' || Array.isArray(S.benchHist)) S.benchHist = {};
  // duels: one member against another for a week or a month, by id
  if (!S.duels || typeof S.duels !== 'object') S.duels = {};
  // group duels ("pods") by id; the duel ladder's current season and its past podiums
  if (!S.pods || typeof S.pods !== 'object') S.pods = {};
  if (!S.ladder || typeof S.ladder !== 'object') S.ladder = { season: seasonOf('quarter', utcDayKey(now())), hall: [] };
  // October 2026: the coach goes to 3 messages a day for everyone (admins unlimited). Applied once,
  // so a different number the owner sets later in the Coach tab stays.
  if (!S.migrations.coach3) { S.config.coach.daily = 3; S.config.coach.dailyUnlocked = 3; S.migrations.coach3 = Date.now(); }
  // October 2026: duels unlock at level 3 instead of being free. Once, for servers that took the
  // first default (level 1); a level the owner sets afterwards in Features stays.
  if (!S.migrations.duels3) { if (S.config.modules.duels === 1) S.config.modules.duels = 3; S.migrations.duels3 = Date.now(); }
  // October 2026: a new server counts only wallets a member proved are theirs (signed for), so nobody can
  // put a well-known trader's wallet on their profile and borrow its verified numbers. Decided once: a
  // server that already has members keeps what it had (the owner turns it on in Settings, and each member
  // it affects gets a note on how to claim), and so does one where wallet sign-in isn't available.
  if (!S.migrations.claimDefault) {
    if (!claimSaved) S.config.requireClaim = !Object.keys(S.members).length && !!(opts.sig !== undefined ? opts.sig : ethSig);
    S.migrations.claimDefault = Date.now(); }
  // people using Pulse without a profile, counted anonymously per UTC day ({days: {key: n}}), and the
  // new members who had been one of them first ({conv: {key: n}}): no wallet, device or address kept
  if (!S.visits || typeof S.visits !== 'object') S.visits = {};
  for (const k of ['days', 'conv']) if (!S.visits[k] || typeof S.visits[k] !== 'object' || Array.isArray(S.visits[k])) S.visits[k] = {};
  if (!S.partners || typeof S.partners !== 'object') S.partners = {};
  if (!S.comments || typeof S.comments !== 'object') S.comments = {};
  if (!S.leagues || typeof S.leagues !== 'object') { // one league for everyone until the owner makes more
    S.leagues = { main: Object.assign({ id: 'main', createdAt: Date.now(), members: {}, week: S.league.week },
      SC.sanitizeLeague({ name: 'Main league', metric: 'xp', tiers: true, open: true, autoJoin: true })) };
    for (const m of Object.values(S.members)) S.leagues.main.members[m.id] = { tier: m.tier || 0, at: m.createdAt || Date.now() };
  }
  // every league has a short number people can search for (#1001, #1002, …)
  // numbers never repeat: the counter is at least the highest number already handed out
  S.leagueSeq = Math.max(1000, +S.leagueSeq || 0, ...Object.values(S.leagues).map(L => +L.num || 0));
  for (const L of Object.values(S.leagues)) if (!L.num) L.num = ++S.leagueSeq;
  // Writes go out as rows: save(m, 'partners', …) writes that member and those sections, save()
  // with nothing named checks everything. A row is only written when its JSON changed (a digest of
  // the last copy written is kept), and each save is one transaction.
  const written = new Map(), dirty = new Set();
  const digest = s => crypto.createHash('sha1').update(s).digest('base64');
  for (const [k, raw] of loadedRaw) written.set(k, digest(raw)); loadedRaw.clear();
  // what was written is only remembered once the transaction commits: a failed save is tried again next time
  let fresh = null;
  const writeRow = (key, val) => { if (val === undefined) return; const s = JSON.stringify(val), d = digest(s); if (written.get(key) === d) return; fresh.set(key, d);
    if (key.startsWith('m:')) q('INSERT OR REPLACE INTO members (id, data) VALUES (?, ?)').run(key.slice(2), s); else q('INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)').run(key, s); };
  const touch = (...xs) => { for (const x of xs) if (typeof x === 'string') dirty.add(x); else if (x && x.id) dirty.add('m:' + x.id); };
  const save = (...xs) => { const all = !xs.length; touch(...xs);
    if (all || dirty.has('follows')) folCount = null;
    if (dirty.has('leagues')) dirty.add('leagueSeq'); // a new league's number and the counter go together
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
  // … and, when the owner approves wallets, only an address the owner approved
  const walletReview = addr => addr && Object.prototype.hasOwnProperty.call(S.wallets, addr) ? S.wallets[addr] : null;
  const walletStatus = addr => !addr ? null : (walletReview(addr) || {}).s || 'pending';
  // an unverified (rejected) wallet never counts, approval switched on or off; with approval on,
  // only a verified (approved) one does
  const walletFor = m => !m.address ? null : S.config.requireClaim && m.claimed !== m.address ? null
    : walletStatus(m.address) === 'rejected' ? null
    : S.config.approveWallets && walletStatus(m.address) !== 'approved' ? null : m.address;
  // why walletFor(m) is null: 'no-wallet' | 'claim' | 'approval' | 'rejected' (null when it isn't)
  const walletBlock = m => !m.address ? 'no-wallet' : S.config.requireClaim && m.claimed !== m.address ? 'claim'
    : walletStatus(m.address) === 'rejected' ? 'rejected'
    : S.config.approveWallets && walletStatus(m.address) !== 'approved' ? 'approval' : null;
  // numbers read from a wallet that stopped counting go at once, and come back when it counts again
  // a member's main wallet changed: what was read from the old one goes, competitions included
  const walletMoved = m => { m.vdays = null; m.ta = null; m.vAt = 0; m.money = null; for (const cc of Object.values(S.comps)) if (cc.money) delete cc.money[m.id]; };
  const dropWalletNumbers = m => { m.vdays = null; m.ta = null; m.money = null; for (const cc of Object.values(S.comps)) if (cc.money) delete cc.money[m.id]; };
  const recheckWallet = m => { m.vAt = 0; m.vFailAt = 0; m.moneyFailAt = 0; if (!walletFor(m)) dropWalletNumbers(m); };
  const claimedBy = (addr, notId) => addr ? members().find(o => o.id !== notId && o.claimed === addr) || null : null;
  // Wallets the owner or an admin mapped to a member by hand, beside their main one (m.address, the one
  // their on-chain numbers are read from). A mapped wallet belongs to that one member.
  const linkedOf = m => Array.isArray(m.wallets) ? m.wallets : [];
  const walletsOf = m => [...(m.address ? [m.address] : []), ...linkedOf(m).filter(a => a !== m.address)];
  const mappedTo = (addr, notId) => addr ? members().find(o => o.id !== notId && linkedOf(o).includes(addr)) || null : null;
  // simple per-IP rate limits: n requests per window
  const ipOf = opts.clientIp || (req => (req.socket && req.socket.remoteAddress) || '');
  const origins = (opts.publicOrigins || []).map(o => { try { const u = new URL(o); return { host: u.host.toLowerCase(), origin: u.origin }; } catch (e) { return null; } }).filter(Boolean);
  // the site a passkey belongs to: {origin, rpId} — the pinned PUBLIC_ORIGIN that matches this
  // request's Host, or (unpinned) the address this page was served from
  const siteOf = req => {
    const reqHost = String(req.headers.host || '').toLowerCase();
    if (origins.length) { const o = origins.find(x => x.host === reqHost);
      if (!o) return { error: 'Open Daruma at ' + origins[0].origin + '/daruma to use a passkey.' };
      return { origin: o.origin, rpId: o.host.replace(/:\d+$/, '') }; }
    const host = reqHost.slice(0, 100).replace(/[^a-z0-9.:\-\[\]]/g, '');
    if (!host) return { error: 'Missing Host header.' };
    const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https' || (req.socket && req.socket.encrypted) ? 'https' : 'http';
    return { origin: proto + '://' + host, rpId: host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '') };
  };
  const limits = new Map();
  // byMember: count per member wherever they connect from (an IP is easy to change)
  const limited = (req, bucket, n, windowMs, byMember) => { const k = byMember ? bucket : bucket + '|' + ipOf(req);
    const e = limits.get(k), recent = (e ? e.t : []).filter(t => now() - t < windowMs);
    if (recent.length >= n) { limits.set(k, { w: windowMs, t: recent }); return true; }
    recent.push(now()); limits.set(k, { w: windowMs, t: recent });
    // pruning drops only entries whose own window has passed (a day-long limit isn't reset after an hour)
    if (limits.size > 20000) for (const [kk, v] of limits) if (!v.t.length || now() - v.t[v.t.length - 1] > v.w) limits.delete(kk);
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
  const leagueBoard = (L, board, viewer, keep) => { const W = leagueWindow(L); return boardRows(keep ? leagueMembers(L).filter(keep) : leagueMembers(L), board, {
    tier: L.tiers && board === L.metric && viewer ? leagueTier(L, viewer) : undefined, tierAll: true, week: S.league.week,
    weeks: board === 'xp' && W.weeks ? W.weeks : undefined, dayFrom: board === 'xp' ? W.dayFrom : undefined, dayTo: W.dayTo, days: W.days }); };
  // a monthly league's boards cover the month so far: the same window its rollover ranks on
  const monthDays = () => Math.max(1, Math.round((Date.parse(todayKey()) - Date.parse(isoWeekMonday(monthWeeks(S.league.week)[0]))) / 86400000) + 1);
  // how many active members a league has: a walk over its own roster, not over every member
  const leagueSize = L => { let n = 0; for (const id in L.members) if (own(S.members, id) && !S.members[id].banned) n++; return n; };
  const leagueOut = (L, viewer) => ({ id: L.id, num: L.num, name: L.name, desc: L.desc, metric: L.metric, metricLabel: SC.LEAGUE_METRICS[L.metric], period: L.period,
    tiers: L.tiers, open: L.open, inviteRequired: !!L.invite, members: leagueSize(L),
    joined: !!viewer && own(L.members, viewer.id), tier: viewer && own(L.members, viewer.id) ? leagueTier(L, viewer) : null,
    tierName: viewer && own(L.members, viewer.id) ? TIERS[leagueTier(L, viewer)] : null, season: L.season ? seasonInfo(L) : null });
  // ---- levels, XP grants, reward badges ----
  const levelTitle = n => { const t = S.config.levels.titles; return t[Math.min(n, t.length) - 1] || ('Level ' + n); };
  // one formatter per time zone, made once: making them is the slow part (the reminder pass runs every minute over every member)
  const fmts = new Map();
  const fmtFor = (kind, tz) => { const k = kind + '|' + tz; let f = fmts.get(k);
    if (!f) { f = new Intl.DateTimeFormat(kind === 'day' ? 'en-CA' : 'en-GB', kind === 'day' ? { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' } : { timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
      if (fmts.size > 500) fmts.clear(); fmts.set(k, f); } return f; };
  const zoneKey = (tz, ms) => { try { return fmtFor('day', tz || 'UTC').format(ms); }
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
  // Admins ask without a limit (null); everyone else has the day's allowance, unless the owner set one for them.
  const coachLimitFor = m => m.admin ? null : m.coachDaily != null ? m.coachDaily : m.unlocked ? S.config.coach.dailyUnlocked
    : standingLapsed(m) ? Math.min(1, S.config.coach.daily) : S.config.coach.daily; // a lapsed standing: 1 a day
  // Counted per profile and per wallet: several profiles on one wallet share its allowance, and
  // taking the wallet off a profile doesn't hand it a fresh one. A count's day follows the asker's
  // clock, fixed for the day once they've asked (changing zones mid-day doesn't start a new count).
  const coachKeys = m => ['m:' + m.id, ...walletsOf(m).map(a => 'w:' + String(a).toLowerCase())];
  const coachTz = m => { for (const k of coachKeys(m)) { const u = S.coachUse[k]; if (u && u.tz) return u.tz; } return (m.stats && m.stats.tz) || 'UTC'; };
  const coachUsedKey = (key, tz) => { const u = S.coachUse[key]; return u && u.k === zoneKey(u.tz || tz, now()) ? u.n : 0; };
  // (a count from before counts moved here, kept on the member, still holds for its day)
  const coachUsed = m => { const tz = coachTz(m), old = m.coachUse && m.coachUse.k === zoneKey(m.coachUse.tz || tz, now()) ? m.coachUse.n : 0;
    return Math.max(old, ...coachKeys(m).map(k => coachUsedKey(k, tz))); };
  // counts from earlier days are dropped as new ones come in
  const coachPrune = () => { const keys = Object.keys(S.coachUse); if (keys.length < 2000) return;
    for (const k of keys) if (!coachUsedKey(k, 'UTC')) delete S.coachUse[k]; };
  const coachReset = m => { for (const k of coachKeys(m)) delete S.coachUse[k]; delete m.coachUse; };
  const coachStatusFor = m => {
    const c = S.config.coach, lvl = (m.stats && m.stats.level) || 1, need = S.config.unlocksOn && !m.unlocked && S.config.modules.coach > 1 ? S.config.modules.coach : 0;
    const limit = coachLimitFor(m), used = coachUsed(m);
    const reason = m.banned ? 'This profile was removed from the league.' : m.admin ? null : !c.members ? 'The owner hasn’t opened the coach to members.'
      : need && lvl < need ? 'The coach unlocks at level ' + need + '.' : limit <= 0 ? 'The coach is switched off for your profile.' : used >= limit ? 'You’ve used today’s ' + limit + ' coach message' + (limit === 1 ? '' : 's') + '. More tomorrow.' + (m.coachDaily == null && standingLapsed(m) ? ' Your full allowance comes back with your standing.' : '') : null;
    return { allowed: !reason, reason, limit, used, remaining: limit == null ? null : Math.max(0, limit - used), detail: !!(c.detail && m.coachDetail), detailAllowed: !!c.detail, unlockLevel: need || null }; };
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
  // a trade sent for review, and its thread
  const dropReview = id => tx(() => { q('DELETE FROM review_comments WHERE review = ?').run(id); return q('DELETE FROM reviews WHERE id = ?').run(id).changes; });
  const dropMember = (id) => { const gone = own(S.members, id) ? S.members[id].address : null;
    const hadVault = own(S.members, id) && !!S.members[id].vault, goneHandle = own(S.members, id) ? '@' + S.members[id].handle : null;
    // a deleted profile leaves nothing behind: the admin log keeps what was done, not who to
    S.adminLog = S.adminLog.map(x => (x.what.includes(id) || x.by === goneHandle) ? Object.assign({}, x, { what: x.what.split(id).join('(deleted member)'), by: x.by === goneHandle ? '(deleted admin)' : x.by }) : x); touch('adminLog');
    // nor in a league's hall of fame: the place stays, the name goes
    for (const L of Object.values(S.leagues)) for (const h of L.hall || []) for (const r of h.podium || []) if (r.id === id) { r.id = null; r.handle = null; touch('leagues'); }
    if (goneHandle) for (const w of Object.values(S.wallets)) if (w && w.by === goneHandle) { w.by = '(deleted admin)'; touch('wallets'); }
    delete S.members[id]; delete S.follows[id]; dropPairsOf(id); delete S.comments[id]; reindex();
    if (own(S.benchHist, 'm:' + id)) { delete S.benchHist['m:' + id]; touch('benchHist'); }
    if (opts.onDrop) try { opts.onDrop(id); } catch (e) {}
    for (const k in S.comments) S.comments[k] = S.comments[k].filter(c => c.by !== id);
    for (const L of Object.values(S.leagues)) delete L.members[id];
    if (gone && opts.forgetAddress && !members().some(o => o.address === gone)) opts.forgetAddress(gone);
    for (const k in S.follows) S.follows[k] = S.follows[k].filter(x => x !== id);
    for (const c of Object.values(S.comps)) { delete c.entrants[id]; if (c.money) delete c.money[id]; if (c.log) delete c.log[id]; }
    tx(() => {
      for (const e of q('SELECT id FROM events WHERE member = ?').all(id)) dropEvent(e.id);
      q('UPDATE events SET kudos = max(0, kudos - 1) WHERE id IN (SELECT event FROM kudos WHERE member = ?)').run(id);
      q('DELETE FROM kudos WHERE member = ?').run(id);
      for (const c of q('SELECT id, event FROM comments WHERE member = ?').all(id)) dropComment(c);
      q('DELETE FROM reports WHERE member = ?').run(id);
      // the trades they sent for review go with their threads; what they wrote on others' goes too
      for (const r of q('SELECT id FROM reviews WHERE member = ?').all(id)) dropReview(r.id);
      q('UPDATE reviews SET comments = max(0, comments - (SELECT count(*) FROM review_comments c WHERE c.review = reviews.id AND c.member = ?)) WHERE id IN (SELECT review FROM review_comments WHERE member = ?)').run(id, id);
      q('DELETE FROM review_comments WHERE member = ?').run(id);
      q('UPDATE reviews SET reviewer = NULL WHERE reviewer = ?').run(id);
      dropMedia(q('SELECT id FROM media WHERE member = ?').all(id));
      q('DELETE FROM members WHERE id = ?').run(id); written.delete('m:' + id);
      if (hadVault) store.afterCommit(() => { try { fs.unlinkSync(vaultFile(id)); } catch (e) {} }); // the journal file goes once the row has
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
    if (!addr || m.banned || !(m.share.ret || m.share.usd) || moneyBusy.has(m.id)) return;
    if (moneyBusy.size >= 3 && !force) return; // three wallets at a time (a forced one, after a wallet change, goes anyway)
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
      let compsChanged = false;
      // a finished competition keeps the result it had when it ended
      // until a competition's result is frozen (a day or so after the end) its numbers still update
      for (const c of Object.values(S.comps)) if (c.type === 'return' && c.entrants[m.id] && !c.final) {
        const from = Date.parse(c.start + 'T00:00:00Z');
        // the 'month' series only reaches back 30 days; older windows need the coarser all-time one
        const s2 = portfolioStats(res, from >= now() - 29 * 86400000 ? 'month' : 'allTime', from, Date.parse(c.end + 'T23:59:59Z'));
        if (s2) { c.money = c.money || {}; const prev = c.money[m.id];
          if (!prev || prev.ret !== s2.ret || prev.dd !== s2.dd) { c.money[m.id] = { ret: s2.ret, dd: s2.dd }; compsChanged = true; } }
      }
      // % return duels: the same window, from the duel's first day to its last
      let duelsChanged = false;
      for (const d of Object.values(S.duels)) if (d.type === 'ret' && d.status === 'active' && (d.a === m.id || d.b === m.id) && d.start <= todayKey()) {
        const from = Date.parse(d.start + 'T00:00:00Z');
        const s3 = portfolioStats(res, from >= now() - 29 * 86400000 ? 'month' : 'allTime', from, Date.parse(d.end + 'T23:59:59Z'));
        if (s3) { d.money = d.money || {}; d.money[m.id] = { ret: s3.ret, dd: s3.dd }; duelsChanged = true; } }
      if (duelsChanged) touch('duels');
      awardCheck(m); if (compsChanged) save(m, 'comps'); else save(m);
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
      for (const d of days) if (d && DAY_RE.test(d.k)) { const o = { k: d.k, s: clampNum(d.s, 0, 100) || 0, n: clampNum(d.n, 0, 1e5) || 0 };
        const f = Array.isArray(d.f) ? d.f.filter(x => SLIP_KEYS.includes(x)) : []; if (f.length) o.f = f; keep.set(d.k, o); }
      live.vdays = [...keep.values()].sort((a, b) => a.k < b.k ? -1 : 1).slice(-200); // Trader Age reads 6 months
      live.vAt = now(); live.vFailAt = 0; taCompute(live); awardCheck(live); save(live);
    } catch (e) { m.vFailAt = now(); }
    finally { behaviorBusy.delete(m.id); }
  };
  const refreshAll = m => { refreshMoney(m); refreshBehavior(m); };
  // Trader Age, verified: the app's own traderAge (app/features/trader-age.js, borrowed by the server's
  // engine) over the days scored from the member's wallet, with the prep, journal and loss-limit parts
  // their app reported for those days. Only a member whose wallet the server reads (and who shares
  // verified Discipline) gets one; everyone else sees the estimate their app makes.
  const taCompute = m => {
    if (!opts.traderAge || !m.share || !m.share.verify || !walletFor(m) || !Array.isArray(m.vdays) || !m.vdays.length) { if (m.ta) m.ta = null; return; }
    try {
      const L = m.logd || {}, J = {}, tz = (m.stats && m.stats.tz) || 'UTC';
      const days = m.vdays.map(d => { const l = L[d.k] || {}; if (l.p) J['day:' + d.k] = { sleep: 1 };
        return { key: d.k, score: d.s, n: d.n, parts: { limit: l.lm, journal: l.jn || 0, plan: l.pl }, behavior: { flags: Object.fromEntries((d.f || []).map(k => [k, 1])) } }; });
      const A = opts.traderAge(days, J, { now: now(), dayOf: ms => zoneKey(tz, ms), firstAt: (m.stats && m.stats.firstAt) || 0 });
      const r1 = x => x == null ? null : Math.round(x * 10) / 10;
      m.ta = { at: now(), n: A.n, building: !!A.building, need: A.need, rating: r1(A.rating), raw: r1(A.raw), sure: A.sure != null ? Math.round(A.sure * 100) / 100 : null, range: A.range ? A.range.map(r1) : null, age: r1(A.age), recent: r1(A.recent), recentN: A.recentN || 0, pace: r1(A.pace), tradingYears: r1(A.tradingYears), drag: A.drag || null,
        parts: A.parts ? Object.fromEntries(Object.entries(A.parts).map(([k, v]) => [k, r1(v)])) : null,
        week: A.week ? { n: A.week.n, age: r1(A.week.age), rating: r1(A.week.rating), slip: A.week.slip || null } : null,
        weeks: (A.weeks || []).map(w => ({ week: w.week, age: r1(w.age), rating: r1(w.rating), n: w.n })) };
      try { multCompute(m, days, J, tz); } catch (e) { /* the multiplier waits for the next try; Trader Age stands */ }
      try { mentorOutcomes(m); } catch (e) { console.warn('[ledger] mentor outcomes: ' + (e && e.message)); }
    } catch (e) { m.ta = null; }
  };
  // The XP multiplier: each finished trading week moves it (the app's own taMultStep), and the week
  // now under way gets the multiplier those weeks earned. Weeks keep the multiplier they had
  // (multHist), so XP already earned never changes; a week without a verified Trader Age is ×1.
  const multWeekNow = m => opts.taMult ? opts.taMult.weekOf(zoneKey((m.stats && m.stats.tz) || 'UTC', now())) : null;
  const multCompute = (m, days, J, tz) => {
    const M = opts.taMult, cfg = S.config.mult; if (!M) return;
    const cur = multWeekNow(m);
    const weeks = M.weeks(days, J, { dayOf: ms => zoneKey(tz, ms), after: m.multState && m.multState.last }).filter(w => w.week < cur);
    let st = m.multState || null; for (const w of weeks) st = M.step(st, w, cfg);
    m.multState = st || { count: 0, last: null };
    const hist = m.multHist && typeof m.multHist === 'object' ? m.multHist : {};
    hist[cur] = cfg.on ? M.of(m.multState, cfg) : 1;
    const ks = Object.keys(hist).sort(); for (const k of ks.slice(0, Math.max(0, ks.length - 520))) delete hist[k];
    m.multHist = hist;
  };
  // what the app needs: this week's multiplier, progress to the next tier, and each week's multiplier for its XP
  const multOut = m => { const cfg = S.config.mult, st = m.multState || { count: 0 }, T = cfg.tiers, tier = opts.taMult ? opts.taMult.tier(st.count, cfg) : -1, nx = T[tier + 1] || null;
    const hist = m.multHist || {}, cur = multWeekNow(m);
    return { on: !!cfg.on, now: cur && hist[cur] ? hist[cur] : 1, tier, held: st.count, bar: cfg.bar, hist,
      next: nx ? { weeks: nx[0], mult: nx[1], toGo: Math.max(0, nx[0] - st.count) } : null }; };
  // ---- standing (spec step 6) ----
  // Duels, competitions, the leaderboards and the coach's full allowance are kept by holding Trader Age
  // over the last 20 trading days (the app's own taStanding, app/features/trader-age.js). Under the
  // bar, or without a verified Trader Age, there are 14 days of grace; a lapse needs a trading day
  // in them, so a break freezes it. Worked out whenever it's asked, since time passes without new
  // stats. The owner's admins and fully unlocked members are never locked.
  const standingOn = () => !!(opts.taStanding && opts.traderAge && S.config.standing.on);
  const standingCfgOut = () => { const c = S.config.standing; return { on: standingOn(), bar: c.bar, grace: c.grace, years: opts.taStanding ? opts.taStanding.years(c.bar) : null }; };
  const fmtYears = y => !(y > 0) ? '—' : y < 1 ? Math.max(1, Math.round(y * 12)) + ' months' : (y < 10 ? y.toFixed(1) : String(Math.round(y))) + ' years';
  const PERKS = 'duels, competitions, the leaderboards and the coach’s full allowance';
  const standingExempt = m => !!(m.admin || m.unlocked);
  const standingOf = m => {
    if (!m || !standingOn()) return { state: 'off', since: null };
    const tz = (m.stats && m.stats.tz) || 'UTC', verified = !!(m.share && m.share.verify && walletFor(m) && Array.isArray(m.vdays)), ta = verified ? m.ta : null;
    const lastDay = verified && m.vdays.length ? m.vdays[m.vdays.length - 1].k : null, prev = m.standing && typeof m.standing === 'object' ? m.standing : null;
    const st = opts.taStanding.of(prev, { verified, building: !ta || !!ta.building, recent: ta && ta.recent != null ? ta.recent : null, lastDay }, S.config.standing, now(), ms => zoneKey(tz, ms));
    if (!prev || prev.state !== st.state || (prev.since || null) !== (st.since || null) || !!prev.slip !== !!st.slip) {
      m.standing = { state: st.state, since: st.since || null, slip: !!st.slip, at: now(), told: prev && prev.told || 0 };
      if (!standingExempt(m)) standingNotify(m, st, prev);
      save(m);
    }
    return st;
  };
  const standingNotify = (m, st, prev) => {
    const yrs = fmtYears(opts.taStanding.years(S.config.standing.bar)), by = st.deadline ? new Date(st.deadline).toISOString().slice(0, 10) : '';
    // warnings at most every 3 days (a rating right at the bar can cross it day after day); lapses and recoveries always
    const warn = (st.state === 'slipping' || st.state === 'unverified') && st.state !== (prev && prev.state);
    if (warn && now() - (m.standing.told || 0) < 3 * 86400000) return;
    if (warn) m.standing.told = now();
    if (st.state === 'slipping') notify(m, 'standing', 'Your Trader Age over your last 20 trading days is under ' + yrs + '. Get it back by ' + by + ' to keep ' + PERKS + '.', { title: 'Standing slipping', url: '/daruma#age' });
    else if (st.state === 'unverified' && !(prev && prev.state === 'slipping')) notify(m, 'standing', 'Verify your wallet by ' + by + ' to keep ' + PERKS + '.', { title: 'Verify to keep your perks', url: '/daruma#sharing' });
    else if (st.state === 'lapsed') notify(m, 'standing', (st.why === 'unverified' ? 'Your wallet isn’t verified, so ' : 'Your standing lapsed, so ') + PERKS + ' are locked until ' + (st.why === 'unverified' ? 'it is.' : 'your last 20 trading days are back at ' + yrs + '.'), { title: 'Standing lapsed', url: '/daruma#age' });
    else if (prev && prev.state === 'lapsed' && (st.state === 'good' || st.state === 'building')) notify(m, 'standing', 'Your standing is back: ' + PERKS + ' are open again.', { title: 'Standing back', url: '/daruma#age' });
  };
  // locked out of a perk: the reason to show (null when it's open to them)
  const standingLapsed = m => !!m && !standingExempt(m) && standingOf(m).state === 'lapsed';
  const standingLock = (m, what) => { if (!standingLapsed(m)) return null; const st = standingOf(m);
    return st.why === 'unverified' ? what + ' need a verified wallet: turn on “Verify my discipline” with your wallet added.'
      : what + ' are locked while your standing is lapsed. Get your last 20 trading days back to Trader Age ' + fmtYears(opts.taStanding.years(S.config.standing.bar)) + '.'; };
  const standingOut = m => { const c = standingCfgOut(); if (!c.on) return { on: false };
    const st = standingOf(m), ta = m.share && m.share.verify ? m.ta : null;
    return Object.assign({}, c, { state: st.state, why: st.why || null, since: st.since || null, deadline: st.deadline || null, exempt: standingExempt(m),
      locked: st.state === 'lapsed' && !standingExempt(m), recent: ta && ta.recent != null ? ta.recent : null, recentN: ta ? ta.recentN || 0 : 0 }); };
  // ---- XP for mentoring (levels only) ----
  // Kept on the mentor as XP per day of their own clock (never trimmed: it's part of their total), with
  // the keys of what already paid (each review, each day's note per mentee, each outcome pays once).
  const MX_SLIP = { revenge: 'revenge-entry', afterTwo: 'trading-after-two-losses', sizeUp: 'sizing-up', addLoser: 'adding-to-losers', overtrade: 'overtrading', heldLoser: 'holding-losers' };
  const MX_AGES = [1, 2, 4, 6, 8, 12];
  const mxDay = m => zoneKey((m.stats && m.stats.tz) || 'UTC', now());
  // two profiles sharing a wallet are one person: mentoring your own second profile earns nothing
  const sameOwner = (a, b) => { const A = new Set([...walletsOf(a), a.claimed].filter(Boolean).map(x => String(x).toLowerCase()));
    return [...walletsOf(b), b.claimed].filter(Boolean).some(x => A.has(String(x).toLowerCase())); };
  // a mentee who traded in the last 14 days (verified days, or the days their app reports)
  const menteeActive = o => { const ks = [...(Array.isArray(o.vdays) ? o.vdays : []).map(d => d.k), ...((o.stats && o.stats.days) || []).map(d => d.k)].filter(Boolean).sort();
    return ks.length > 0 && ks[ks.length - 1] >= zoneKey('UTC', now() - 14 * 86400000); };
  const mentorWorked = (mentor, mentee) => { const W = mentor.mentoring = mentor.mentoring && typeof mentor.mentoring === 'object' ? mentor.mentoring : {};
    W[mentee.id] = now(); for (const k of Object.keys(W)) if (now() - W[k] > 60 * 86400000) delete W[k]; };
  // pays the mentor (kind 'review' | 'note' | 'outcome'); key makes each thing pay once. Returns the XP paid.
  const mentorPay = (mentor, mentee, kind, key) => {
    const c = S.config.mentorXp; if (!c.on || !mentor || !mentor.mentor || mentor.banned || !mentee || mentor.id === mentee.id || sameOwner(mentor, mentee)) return 0;
    if (kind !== 'outcome' && !menteeActive(mentee)) return 0;
    const L = mentor.mentorXp = mentor.mentorXp && typeof mentor.mentorXp === 'object' ? mentor.mentorXp : {};
    if (!L.days || typeof L.days !== 'object') L.days = {}; if (!Array.isArray(L.paid)) L.paid = [];
    if (L.paid.includes(key)) return 0;
    const D = L.days[mxDay(mentor)] = L.days[mxDay(mentor)] || { xp: 0, effort: 0, r: 0, n: 0, o: 0 };
    if (kind === 'note' && D.n >= c.notesPerDay) return 0;
    let xp = kind === 'review' ? c.review : kind === 'note' ? c.note : c.outcome;
    if (kind !== 'outcome') { xp = Math.min(xp, Math.max(0, c.cap - D.effort)); D.effort += xp; }
    if (!xp) return 0;
    D.xp += xp; D[kind === 'review' ? 'r' : kind === 'note' ? 'n' : 'o']++;
    L.paid = [...L.paid, key].slice(-3000); touch(mentor); return xp; };
  // what the mentor's app needs: XP and counts per day (for the ledger and the mentoring badges)
  const mentorXpOut = m => { const L = m.mentorXp; if (!L || !L.days) return null; const days = {}; let total = 0;
    for (const [k, d] of Object.entries(L.days)) { days[k] = { xp: d.xp, r: d.r, n: d.n, o: d.o }; total += d.xp; }
    return { days, total, today: (L.days[mxDay(m)] || { xp: 0 }).xp, cap: S.config.mentorXp.cap }; };
  // a mentee's verified results pay the mentors who worked with them in the last 30 days: a new Trader Age
  // milestone, a perfect week (3+ trading days, every one 70+), a leak plugged (a slip seen in 2+ of the 6
  // trading weeks before, then none for 3). The first look at a member only notes where they are.
  const mentorOutcomes = o => {
    const out = [], vd = Array.isArray(o.vdays) ? o.vdays : [], curWk = isoWeekOfKey(zoneKey((o.stats && o.stats.tz) || 'UTC', now()));
    if (o.ta) { const hit = o.ta.building ? 0 : MX_AGES.filter(y => o.ta.age >= y).pop() || 0; // still building counts as none reached
      if (o.mxAge == null) o.mxAge = hit; else if (hit > o.mxAge) { o.mxAge = hit; out.push(['age:' + o.id + ':' + hit, 'reached a verified Trader Age of ' + hit + ' year' + (hit === 1 ? '' : 's')]); } }
    const W = new Map(); for (const d of vd) { const w = isoWeekOfKey(d.k); if (w >= curWk) continue; if (!W.has(w)) W.set(w, []); W.get(w).push(d); }
    const weeks = [...W.keys()].sort(), lastW = weeks[weeks.length - 1] || null;
    if (lastW) { if (o.mxWeek == null) o.mxWeek = lastW;
      else { for (const w of weeks) if (w > o.mxWeek && W.get(w).length >= 3 && W.get(w).every(d => d.s >= 70)) out.push(['pw:' + o.id + ':' + w, 'had a perfect verified week']); o.mxWeek = lastW; } }
    const first = o.mxPlug == null; o.mxPlug = o.mxPlug && typeof o.mxPlug === 'object' ? o.mxPlug : {};
    if (weeks.length >= 5) { const recent = weeks.slice(-3), before = weeks.slice(-9, -3), has = (w, k) => W.get(w).some(d => (d.f || []).includes(k));
      for (const k of SLIP_KEYS) if (recent.every(w => !has(w, k)) && before.filter(w => has(w, k)).length >= 2 && !(o.mxPlug[k] && now() - o.mxPlug[k] < 90 * 86400000)) {
        o.mxPlug[k] = now(); if (!first) out.push(['plug:' + o.id + ':' + k + ':' + lastW, 'plugged their ' + MX_SLIP[k] + ' leak (none in 3 trading weeks)']); } }
    if (!out.length || !S.config.mentorXp.on) return;
    const ms = members().filter(x => x.mentor && !x.banned && x.id !== o.id && x.mentoring && now() - (x.mentoring[o.id] || 0) < 30 * 86400000);
    for (const [key, text] of out) for (const x of ms) { const xp = mentorPay(x, o, 'outcome', key);
      if (xp) { notify(x, 'mentor', '@' + o.handle + ' ' + text + '. +' + xp + ' XP for your mentoring.', { title: 'Your mentee did it', url: '/daruma#mentee/' + o.handle }); save(x); } } };
  // ---- "traders like you": peer groups from members' summaries and the owner's seed wallets ----
  // counted seed wallets are read again daily, left-out ones weekly (a new trader may have traded enough since);
  // a counted one whose re-reads keep failing stops counting after SEED_STALE
  const BENCH_FRESH = 21 * 86400000, SEED_REFRESH = 86400000, SEED_SKIP_REFRESH = 7 * 86400000, SEED_STALE = 28 * 86400000, SEED_MAX = 5000;
  const benchRows = () => {
    const rows = [], mine = new Set(), src = []; let seeds = 0;
    for (const m of members()) {
      if (m.banned || !m.share || m.share.bench === false || !m.bench || now() - (m.bench.at || 0) > BENCH_FRESH) continue;
      const r = Object.assign({}, m.bench); delete r.at;
      // returns and drawdown only when read on chain for this member (last 30 days)
      if (m.money && m.money.ret != null && walletFor(m)) { r.ret = m.money.ret * 100; r.dd = m.money.dd * 100; }
      const b = Bench.sanitizeBench(r); if (b && b.n >= S.config.bench.minTrades) { rows.push(b); if (m.address) mine.add(m.address);
        src.push({ id: 'm:' + m.id, row: b, at: m.bench.at || now(), slips: Bench.slipRates(m.stats && m.stats.days, m.bench.at || now()) }); }
    }
    if (S.config.bench.seeds) for (const [a, x] of Object.entries(S.benchSeeds))
      if (x.st === 'ok' && x.sum && x.sum.n >= S.config.bench.minTrades && !mine.has(a) && now() - (x.done || 0) < SEED_STALE) { rows.push(x.sum); seeds++; src.push({ id: 's:' + a, row: x.sum, at: x.done || now() }); }
    return { rows, seeds, src };
  };
  // the weekly history behind "traders like you who improved": a snapshot for each counted
  // summary (at most one a week), ~26 weeks kept; members who left, switched off or were removed,
  // and seed wallets taken out, lose theirs
  const benchHistUpdate = src => {
    const H = S.benchHist, curW = Bench.weekOf(now());
    for (const x of src) H[x.id] = Bench.histPush(H[x.id], Bench.histSnap(x.row, Math.min(x.at, now()), x.slips)).list;
    for (const id of Object.keys(H)) {
      const m = id.startsWith('m:') && own(S.members, id.slice(2)) ? S.members[id.slice(2)] : null;
      const keep = m ? !m.banned && m.share && m.share.bench !== false : id.startsWith('s:') && own(S.benchSeeds, id.slice(2));
      if (keep) H[id] = Bench.histTrim(H[id], curW);
      if (!keep || !H[id].length) delete H[id];
    }
    // the dimensions each one has now decide their groups
    return src.map(x => ({ dims: x.row, hist: H[x.id] || [] }));
  };
  const benchBuild = () => { const R = benchRows();
    S.bench = Object.assign(Bench.buildBenchmarks(R.rows, S.config.bench, now()), { seeds: R.seeds, members: R.rows.length - R.seeds, cfg: JSON.stringify(S.config.bench) });
    S.bench.imp = Bench.buildImprovers(benchHistUpdate(R.src), S.bench, S.config.bench, now());
    save('bench', 'benchHist'); return S.bench; };
  // built on the first request that needs it: daily, when the settings change, and within a few
  // minutes of new summaries arriving (a seed batch finishing rebuilds at once)
  let benchDirty = false;
  const benchNow = () => !S.bench || now() - (S.bench.at || 0) > 86400000 || S.bench.cfg !== JSON.stringify(S.config.bench)
    || (benchDirty && now() - (S.bench.at || 0) > 5 * 60000) ? (benchDirty = false, benchBuild()) : S.bench;
  // seed wallets: read one at a time from their public fills, slowly, so the exchange never sees a burst
  let seedBusy = false, seedTimer = null, closing = false;
  const seedDelay = opts.seedDelay != null ? opts.seedDelay : 4000;
  const seedDue = x => x.st === 'ok' ? !!x.re || now() - (x.done || 0) > SEED_REFRESH : x.st === 'skip' && now() - (x.done || 0) > SEED_SKIP_REFRESH;
  const nextSeed = () => { let due = null;
    for (const [a, x] of Object.entries(S.benchSeeds)) { if (x.st === 'queued') return a;
      if (seedDue(x) && (!due || x.done < S.benchSeeds[due].done)) due = a; }
    return due; };
  const seedWhy = r => { const c = S.config.bench;
    return r.why === 'few' ? (r.n || 0) + ' closed trade' + (r.n === 1 ? '' : 's') + ' in the last ' + c.days + ' days (needs ' + c.minTrades + ')'
      : r.why === 'short' ? 'under 2 weeks of trading in the last ' + c.days + ' days'
      : r.why === 'bot' ? 'too many fills for one person (a bot or market maker)' : 'not enough trading to compare'; };
  const seedWork = async () => {
    const a = nextSeed(); if (seedBusy || !a || !opts.peerSummaryFor) return;
    seedBusy = true; const x = S.benchSeeds[a];
    // a counted wallet asked to be re-read keeps its last read if this one fails: only a new read replaces it
    const keep = x.re && x.st === 'ok' && x.sum;
    const failed = msg => { if (keep) x.why = 'last re-read failed: ' + msg; else { x.st = 'err'; x.why = msg; } };
    try {
      const r = await opts.peerSummaryFor(a, { minTrades: S.config.bench.minTrades, days: S.config.bench.days });
      if (!own(S.benchSeeds, a)) return; // removed while it was being read
      const sum = r && r.ok ? Bench.sanitizeBench(r) : null;
      x.n = r && r.n != null ? r.n : null; x.usd = r && r.usd ? r.usd : null; // shown to the owner in the seed table, never in the groups
      if (sum) { x.st = 'ok'; x.why = ''; x.sum = sum; }
      else if (r && r.ok === false) { x.st = 'skip'; x.why = seedWhy(r); x.sum = null; }
      else failed(String((r && r.error) || 'couldn’t read this wallet').slice(0, 120));
    } catch (e) { if (own(S.benchSeeds, a)) failed(String((e && e.message) || e).slice(0, 120)); }
    finally { if (own(S.benchSeeds, a)) { x.done = now(); x.tries = (x.tries || 0) + 1; delete x.re; } seedBusy = false; benchDirty = true; save('benchSeeds');
      if (!nextSeed()) { benchDirty = false; benchBuild(); } else seedSchedule(); } // the batch is done: count it now
  };
  const seedSchedule = () => { if (seedTimer || closing || !opts.peerSummaryFor || !nextSeed()) return;
    seedTimer = setTimeout(() => { seedTimer = null; seedWork(); }, seedDelay); if (seedTimer.unref) seedTimer.unref(); };
  const seedCounts = () => { const c = { queued: 0, ok: 0, skip: 0, err: 0, re: 0 }; for (const x of Object.values(S.benchSeeds)) { c[x.st] = (c[x.st] || 0) + 1; if (x.re && x.st === 'ok') c.re++; } return c; };
  // ---- duels: one member against another for a week or a month ----
  const DUEL_TTL = 48 * 3600000;
  const duelOpen = d => d.status === 'pending' || d.status === 'active';
  const openDuels = m => Object.values(S.duels).filter(d => duelOpen(d) && (d.a === m.id || d.b === m.id));
  const duelName = d => Duels.TYPES[d.type].label;
  const duelUrl = '/daruma#duels';
  const duelDates = d => { const f = k => new Date(k + 'T12:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' }); return f(d.start) + ' – ' + f(d.end); };
  // XP riding on a member's open duels: the ones running, and the terms they've put to someone
  // (a challenge waiting on them commits nothing until they accept it). `except`: the duel being decided.
  const duelRiding = (m, except) => openDuels(m).filter(d => d !== except && (d.status === 'active' || d.awaiting !== m.id)).reduce((s, d) => s + (d.stake || 0), 0);
  const stakeRoomOf = (m, except) => Duels.stakeRoom((m.stats && m.stats.xp) || 0, duelRiding(m, except), S.config.duels);
  // can `a` put these terms to `b`? -> an error message, or null. self: the duel these terms are for, if it exists already
  const duelProblem = (a, b, t, skipOpen, self) => {
    const cfg = S.config.duels;
    if (!cfg.on) return 'Duels are switched off in this league.';
    if (!b || b.banned) return 'There’s no such member.';
    if (b.id === a.id) return 'You can’t challenge yourself.';
    if (!b.share || b.share.duels === false) return '@' + b.handle + ' isn’t taking challenges.';
    if (standingLapsed(b)) return '@' + b.handle + ' isn’t taking challenges right now.';
    if (!cfg.types[t.type]) return 'This league doesn’t run ' + Duels.TYPES[t.type].label + ' duels.';
    if (!skipOpen) { if (openCount(a) >= cfg.maxOpen) return 'You have ' + cfg.maxOpen + ' duels going already. Finish one first.';
      if (openCount(b) >= cfg.maxOpen) return '@' + b.handle + ' has ' + cfg.maxOpen + ' duels going already.'; }
    for (const [x, who] of [[a, 'You'], [b, '@' + b.handle]]) {
      if (t.verified && !(x.share && x.share.verify && x.address)) return who + (who === 'You' ? ' need' : ' needs') + ' “Verify my discipline” switched on for a verified duel. Turn verification off for this duel, or pick another kind.';
      if (t.type === 'ret' && !(x.share && x.share.ret && walletFor(x))) return who + (who === 'You' ? ' need' : ' needs') + ' “Show % return” switched on (with a wallet) for a % return duel.';
    }
    if (t.stake) {
      if (!cfg.stakes) return 'This league doesn’t allow XP stakes any more. Suggest terms without one.';
      if (t.stake > cfg.maxStake) return 'The most XP a duel can stake here is ' + cfg.maxStake + '.';
      const ra = stakeRoomOf(a, self || t); if (t.stake > ra) return ra ? 'You can put up at most ' + ra + ' XP right now.' : 'You don’t have XP to stake right now. Make it a duel without a stake.';
      if (t.stake > stakeRoomOf(b, self || t)) return '@' + b.handle + ' can’t cover a stake that big right now. Try a smaller one.';
    }
    return null;
  };
  // verified and % return duels are read from the wallets the two sides had when they accepted:
  // switching or clearing yours mid-duel (to shed a bad day or a blown drawdown) loses it
  const duelStanding = (d, ma, mb, upto) => {
    let moved = null;
    if (d.w && (d.verified || d.type === 'ret') && d.start <= upto) moved = { a: !!ma && (ma.address || null) !== d.w.a, b: !!mb && (mb.address || null) !== d.w.b };
    return Duels.standing(moved && (moved.a || moved.b) ? Object.assign({}, d, { moved }) : d, ma, mb, upto); };
  const duelView = (d, me) => {
    const mine = d.a === me.id ? 'a' : 'b', o = S.members[mine === 'a' ? d.b : d.a];
    const v = { id: d.id, type: d.type, label: duelName(d), rule: Duels.TYPES[d.type].rule, period: d.period, start: d.start || null, end: d.end || null,
      verified: !!d.verified, minDays: d.minDays, ddCap: d.ddCap, msg: d.msg || '', stake: d.stake || 0, status: d.status, mine: mine === 'a' ? 'sent' : 'received',
      awaiting: d.awaiting === me.id, exp: d.status === 'pending' ? d.exp : null, at: d.at, countered: !!d.countered,
      other: o ? { handle: o.handle, av: avUrl(o), level: (o.stats && o.stats.level) || 1 } : { handle: '(left the league)', av: null, level: 1 },
      preview: d.status === 'pending' ? Duels.windowFor(d.period, now()) : null };
    if ((d.status === 'active' && d.start <= todayKey()) || d.status === 'done') {
      const st = d.status === 'done' && d.final ? d.final : (() => { const x = duelStanding(d, S.members[d.a], S.members[d.b], todayKey()); return { a: x.a, b: x.b, lead: x.lead, why: x.why }; })();
      const pick = x => x ? { score: x.score, note: x.note, n: x.n, marks: x.marks || [], out: !!x.out || !!x.fell, missing: !!x.verifiedMissing } : null;
      v.me = pick(st[mine]); v.them = pick(st[mine === 'a' ? 'b' : 'a']);
      v.lead = st.lead == null ? null : st.lead === mine ? 'me' : 'them'; v.why = st.why || '';
    }
    if (d.status === 'done') { const r = d.result || {};
      v.result = { outcome: !r.winner ? 'draw' : r.winner === me.id ? 'won' : 'lost', why: r.why || '', forfeit: r.forfeit ? (r.forfeit === me.id ? 'me' : 'them') : null, at: r.at, xp: r.winner === me.id ? r.xp || 0 : 0,
        stake: r.stake ? (r.winner === me.id ? r.stake : -r.stake) : 0, rating: d.rated ? d.rated[mine] : null }; }
    return v;
  };
  const duelSettle = (d, forfeiter) => {
    const ma = S.members[d.a], mb = S.members[d.b];
    let winner = null, why = '';
    if (forfeiter) { winner = forfeiter === d.a ? d.b : d.a; why = 'forfeit'; }
    else { const st = duelStanding(d, ma, mb, d.end); winner = st.lead === 'a' ? d.a : st.lead === 'b' ? d.b : null; why = st.why; d.final = { a: st.a, b: st.b, lead: st.lead, why: st.why }; }
    // the league's bonus is for a duel played to the end: a forfeit can't be farmed between friends
    const xp = winner && S.members[winner] && !forfeiter ? S.config.duels.xp : 0;
    // the stake changes hands only when both sides are still on the books to give and take it
    // (a suspended loser keeps no grants, so a suspended side moves no stake either way)
    const loserId = winner ? (winner === d.a ? d.b : d.a) : null, ok = id => S.members[id] && !S.members[id].banned;
    const stake = winner && d.stake && ok(winner) && ok(loserId) ? d.stake : 0;
    d.status = 'done'; d.result = { winner, why, forfeit: forfeiter || null, at: now(), xp, stake };
    ladderRate(d, winner);
    const grant = (m, n, why) => { m.grants = [...(m.grants || []), { id: crypto.randomBytes(4).toString('hex'), xp: n, why, at: now(), duel: d.id }].slice(-200); };
    for (const [m, o] of [[ma, mb], [mb, ma]]) { if (!m || m.banned) continue;
      const rec = m.duelRec = Object.assign({ w: 0, l: 0, d: 0 }, m.duelRec);
      if (!winner) rec.d++; else if (winner === m.id) rec.w++; else rec.l++;
      const oh = o ? '@' + o.handle : 'your opponent';
      notify(m, 'duel', !winner ? 'Your ' + duelName(d) + ' duel with ' + oh + ' ended in a draw.'
        : winner === m.id ? 'You won your ' + duelName(d) + ' duel against ' + oh + (forfeiter ? ' (they forfeited)' : '') + '.' + (xp + stake ? ' +' + (xp + stake) + ' XP.' : '')
        : (forfeiter === m.id ? 'You forfeited your ' + duelName(d) + ' duel against ' + oh + '.' : oh + ' won your ' + duelName(d) + ' duel.') + (stake ? ' −' + stake + ' XP.' : '') + (forfeiter === m.id ? '' : ' Rematch?'), { title: 'Duel result', url: duelUrl });
      if (stake && m.id === loserId) grant(m, -stake, 'Lost a ' + duelName(d) + ' duel' + (o ? ' to @' + o.handle : ''));
      save(m); }
    const w = winner && S.members[winner];
    if (w && !w.banned) {
      if (xp) grant(w, xp, 'Won a ' + duelName(d) + ' duel');
      if (stake) { const lo = S.members[loserId]; grant(w, stake, 'Won ' + stake + ' XP staked by @' + (lo ? lo.handle : 'your opponent')); }
      // the loser is named only if they share milestones in the feed too
      const lo = S.members[winner === d.a ? d.b : d.a];
      if (w.share.feed) pushEvent(w, { type: 'duel', text: 'won a ' + duelName(d) + ' duel' + (lo && lo.share && lo.share.feed ? ' against @' + lo.handle : '') });
      save(w); }
    touch('duels');
  };
  // expiries, results, forfeits by leaving, and a nudge when the lead changes (once a day at most)
  const duelSweep = () => {
    const today = todayKey(); let changed = false;
    for (const d of Object.values(S.duels)) {
      if (d.status === 'pending') {
        const ma = S.members[d.a], mb = S.members[d.b];
        if (now() > d.exp || !ma || !mb || ma.banned || mb.banned) { d.status = 'expired'; changed = true;
          const w = S.members[d.awaiting === d.a ? d.b : d.a]; if (w) notify(w, 'duel', 'Your ' + duelName(d) + ' challenge expired: no answer in 48 hours.', { title: 'Challenge expired', url: duelUrl }); }
      } else if (d.status === 'active') {
        const ma = S.members[d.a], mb = S.members[d.b];
        if (!ma || ma.banned) { duelSettle(d, d.a); changed = true; continue; }
        if (!mb || mb.banned) { duelSettle(d, d.b); changed = true; continue; }
        if (today > addDaysKey(d.end, 1)) { duelSettle(d); changed = true; continue; } // the day after the last day, once late syncs are in
        if (d.start <= today && d.leadDay !== today) {
          const st = duelStanding(d, ma, mb, today), lead = st.lead === 'a' ? d.a : st.lead === 'b' ? d.b : null;
          if (lead && d.lead && lead !== d.lead) { const L = S.members[lead], T = S.members[lead === d.a ? d.b : d.a];
            notify(L, 'duel', 'You took the lead in your ' + duelName(d) + ' duel against @' + T.handle + '.', { title: 'Duel', url: duelUrl });
            notify(T, 'duel', '@' + L.handle + ' took the lead in your ' + duelName(d) + ' duel.', { title: 'Duel', url: duelUrl }); d.leadDay = today; }
          if (lead !== d.lead) { d.lead = lead; changed = true; }
        }
      }
    }
    // finished duels are kept a year and a bit, for records and rematches
    for (const [id, d] of Object.entries(S.duels)) if (!duelOpen(d) && now() - (d.result ? d.result.at : d.at) > 400 * 86400000) { delete S.duels[id]; changed = true; }
    if (podSweep()) changed = true;
    if (ladderRoll()) changed = true; // after the results above, so a duel that ended last season counts in it
    if (changed) save('duels'); // members notified above were touched and go in the same write
  };
  // ---- the duel ladder: an Elo-style rating from 1v1 results, with a season each calendar quarter ----
  // m.ladder: {r: rating, n: rated duels, s: the season it's counting, s0: the rating that season began on, sn: rated duels in it}
  const ladderOf = m => (m.ladder = Object.assign({ r: Duels.RATING0, n: 0, s: S.ladder.season, s0: Duels.RATING0, sn: 0 }, m.ladder));
  // a duel played or forfeited moves both ratings; one backed out of or cancelled never gets here
  const ladderRate = (d, winner) => {
    const cfg = S.config.duels; if (!cfg.ladder) return;
    const ma = S.members[d.a], mb = S.members[d.b], la = ma ? ladderOf(ma) : { r: Duels.RATING0 }, lb = mb ? ladderOf(mb) : { r: Duels.RATING0 };
    const e = Duels.elo(la.r, lb.r, !winner ? 0.5 : winner === d.a ? 1 : 0, cfg.k);
    for (const [m, L, r] of [[ma, la, e.a], [mb, lb, e.b]]) if (m) { L.r = r; L.n++; L.sn++; touch(m); }
    d.rated = { a: e.delta, b: -e.delta };
  };
  // who's listed: a public profile that takes challenges, with enough rated duels
  const ladderShown = m => !m.banned && !!m.share && !!m.share.profile && m.share.duels !== false;
  const ladderBoard = () => members().filter(m => ladderShown(m) && m.ladder && m.ladder.n >= S.config.duels.ladderMin)
    .sort((x, y) => y.ladder.r - x.ladder.r || x.handle.localeCompare(y.handle));
  const seasonGain = m => m.ladder && m.ladder.s === S.ladder.season ? m.ladder.r - m.ladder.s0 : 0;
  // the season's standing: rating points gained in it, among those listed who played in it
  const seasonBoard = board => (board || ladderBoard()).filter(m => m.ladder.s === S.ladder.season && m.ladder.sn > 0)
    .sort((x, y) => seasonGain(y) - seasonGain(x) || y.ladder.r - x.ladder.r || x.handle.localeCompare(y.handle));
  // A season closes on the second day of the next quarter (once the old one's last duels have settled):
  // the top three with points gained get a podium, a badge, a notification and (if they share milestones) a
  // feed line. Then every rating moves a quarter of the way back to 1000 for the new season.
  const LADDER_BADGES = ['duel-gold', 'duel-silver', 'duel-bronze'];
  const ladderRoll = () => {
    const old = S.ladder.season, cur = seasonOf('quarter', todayKey());
    if (!old) { S.ladder.season = cur; touch('ladder'); return true; }
    if (cur <= old || todayKey() <= addDaysKey(seasonBounds(old).end, 1)) return false;
    if (S.config.duels.ladder) {
      const board = seasonBoard(), podium = board.filter(m => seasonGain(m) > 0).slice(0, 3), b = seasonBounds(old);
      S.ladder.hall = [...(S.ladder.hall || []), { season: old, label: seasonLabel(old), start: b.start, end: b.end, n: board.length, at: now(),
        podium: podium.map(m => ({ id: m.id, handle: m.handle, gain: seasonGain(m), r: m.ladder.r })) }].slice(-12);
      podium.forEach((m, i) => { const bid = LADDER_BADGES[i], gain = seasonGain(m);
        if (!own(S.badges, bid)) { const [name, icon, desc] = SEASON_BADGES[bid]; S.badges[bid] = { id: bid, name, icon, desc, metric: null, op: 'gte', value: 0, xp: 0, system: true }; touch('badges'); }
        m.awards = m.awards || {}; if (!own(m.awards, bid)) m.awards[bid] = now();
        if (m.share.feed) pushEvent(m, { type: 'season', text: ['won', 'took second in', 'took third in'][i] + ' the ' + seasonLabel(old) + ' duel season ' + SEASON_BADGES[bid][1] });
        notify(m, 'duel', 'You finished #' + (i + 1) + ' on the duel ladder for ' + seasonLabel(old) + ', with +' + gain + ' rating.', { title: 'Duel season over ' + SEASON_BADGES[bid][1], url: duelUrl }); });
    }
    for (const m of members()) if (m.ladder) { const r = Duels.softReset(m.ladder.r); Object.assign(m.ladder, { r, s: cur, s0: r, sn: 0 }); touch(m); }
    S.ladder.season = cur; touch('ladder'); return true;
  };
  const ladderOut = me => {
    const board = ladderBoard(), sb = seasonBoard(board), L = me.ladder, id = S.ladder.season, b = seasonBounds(id);
    const row = (m, i) => ({ rank: i + 1, handle: m.handle, av: avUrl(m), r: m.ladder.r, n: m.ladder.n, gain: seasonGain(m), me: m.id === me.id });
    const rank = board.indexOf(me), srank = sb.indexOf(me);
    return { on: true, k: S.config.duels.k, min: S.config.duels.ladderMin,
      me: { r: L ? L.r : Duels.RATING0, n: L ? L.n : 0, gain: seasonGain(me), rank: rank < 0 ? null : rank + 1, srank: srank < 0 ? null : srank + 1, shown: ladderShown(me) },
      top: board.slice(0, 25).map(row), season: { id, label: seasonLabel(id), start: b.start, end: b.end, rows: sb.slice(0, 10).map(row) },
      // past podiums; someone who has since gone private (or left) shows without a name
      hall: (S.ladder.hall || []).filter(h => h.podium.length).slice(-4).reverse().map(h => ({ label: h.label, podium: h.podium.map(x => { const m = S.members[x.id];
        return { handle: m && !m.banned && m.share.profile ? m.handle : null, gain: x.gain }; }) })) };
  };
  // ---- group duels ("pods"): 3 to 6 members on one measure for a week or a month, ranked at the end ----
  // p.mem[id].st: 'in' (accepted; the creator from the start), 'invited', 'declined', 'expired' (no answer in time),
  // 'left' (backed out before the start), 'out' (forfeited after it, or suspended: placed last)
  const podOpen = p => p.status === 'pending' || p.status === 'active';
  const podHas = (p, id) => own(p.mem, id) && (p.mem[id].st === 'in' || p.mem[id].st === 'invited');
  const openPods = m => Object.values(S.pods).filter(p => podOpen(p) && podHas(p, m.id));
  // a pod counts once toward a member's open-duel limit, like a 1v1 (an invitation waiting on you too)
  const openCount = m => openDuels(m).length + openPods(m).length;
  const podIds = (p, ...sts) => Object.keys(p.mem).filter(id => sts.includes(p.mem[id].st));
  const podName = p => Duels.TYPES[p.type].label + ' group duel';
  const podTell = (ids, text, title) => { for (const id of ids) notify(S.members[id], 'duel', text, { title, url: duelUrl }); };
  const podStarted = p => p.status === 'active' && p.start <= todayKey();
  const nth = n => n + (n % 100 > 10 && n % 100 < 14 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th');
  // everyone who plays, scored like one side of a duel, then ranked. A wallet that moved since they
  // accepted (changed or cleared) puts that member out, like a 1v1; so does forfeiting or a suspension.
  const podStanding = (p, upto) => Duels.podRank(p, podIds(p, 'in', 'out').map(id => {
    const m = S.members[id], s = Duels.sideScore(p, m, upto); let out = p.mem[id].st === 'out' || !m || m.banned;
    if (out) s.note = 'out';
    else if (p.start <= upto && p.w && p.w[id] && (m.address || null) !== p.w[id]) { out = true; s.note = 'changed wallet mid-duel'; }
    return { id, s, out }; }));
  const podView = (p, me) => {
    const fin = p.status === 'done' && p.final, st = fin ? p.final : podStarted(p) ? podStanding(p, todayKey()) : null;
    const at = new Map(st ? st.rows.map(r => [r.id, r]) : []), h = id => S.members[id] ? S.members[id].handle : '(left)';
    const mem = Object.keys(p.mem).map(id => { const r = at.get(id), x = p.mem[id];
      return Object.assign({ handle: h(id), av: avUrl(S.members[id]), st: x.st, me: id === me.id, by: id === p.by },
        r ? { place: r.place, out: !!r.out || !!r.s.fell, score: r.s.score, note: r.s.note || '', missing: !!r.s.verifiedMissing } : {}); })
      .sort((a, b) => (a.place || 99) - (b.place || 99) || (a.st === 'in' ? 0 : 1) - (b.st === 'in' ? 0 : 1) || a.handle.localeCompare(b.handle));
    const v = { id: p.id, pod: true, type: p.type, label: Duels.TYPES[p.type].label, rule: Duels.POD_RULES[p.type], period: p.period, start: p.start || null, end: p.end || null,
      verified: !!p.verified, minDays: p.minDays, msg: p.msg || '', status: p.status, at: p.at, exp: podOpen(p) ? p.exp : null, by: h(p.by), mine: p.by === me.id,
      my: p.mem[me.id] ? p.mem[me.id].st : null, members: mem, in: podIds(p, 'in', 'out').length, preview: p.status === 'pending' ? Duels.windowFor(p.period, now()) : null };
    if (st) { v.lead = st.lead ? h(st.lead) : null; v.leadMe = st.lead === me.id; v.why = st.why; }
    if (p.status === 'done') { const r = p.result || {}, mine = at.get(me.id);
      v.result = { winner: r.winner ? h(r.winner) : null, won: r.winner === me.id, place: mine ? mine.place : null, of: st.rows.length, xp: r.winner === me.id ? r.xp || 0 : 0, at: r.at }; }
    return v;
  };
  // fewer than 3 still in before the start: back to waiting while invitations are open, else it's off
  const podShort = p => {
    if (p.status !== 'active' || podStarted(p) || podIds(p, 'in').length >= 3) return;
    if (now() <= p.exp) { p.status = 'pending'; delete p.start; delete p.end; return; }
    p.status = 'cancelled'; p.endedAt = now();
    podTell(podIds(p, 'in'), 'Your ' + podName(p) + ' is off: fewer than 3 people are left in it.', 'Group duel called off');
  };
  const podSettle = p => {
    const st = podStanding(p, p.end), winner = st.lead, n = st.rows.length;
    // the league's bonus needs a pod played to the end: at least one other member who didn't forfeit
    const xp = winner && S.members[winner] && !S.members[winner].banned && podIds(p, 'in').length >= 2 ? S.config.duels.xp : 0;
    p.status = 'done'; p.final = { lead: st.lead, why: st.why, rows: st.rows.map(r => ({ id: r.id, place: r.place, out: r.out, s: { score: r.s.score, note: r.s.note, n: r.s.n, fell: r.s.fell || null } })) };
    p.result = { winner, xp, at: now(), n };
    const wh = winner && S.members[winner] ? '@' + S.members[winner].handle : '';
    for (const r of st.rows) { const m = S.members[r.id]; if (!m || m.banned) continue;
      const rec = m.podRec = Object.assign({ w: 0, n: 0 }, m.podRec); rec.n++; if (r.id === winner) rec.w++;
      notify(m, 'duel', r.id === winner ? 'You won your ' + podName(p) + ' against ' + (n - 1) + ' others.' + (xp ? ' +' + xp + ' XP.' : '')
        : (winner ? wh + ' won your ' + podName(p) + '.' : 'Your ' + podName(p) + ' ended level at the top.') + ' You placed ' + nth(r.place) + ' of ' + n + '.', { title: 'Group duel result', url: duelUrl }); }
    const w = winner && S.members[winner];
    if (w && !w.banned) {
      if (xp) w.grants = [...(w.grants || []), { id: crypto.randomBytes(4).toString('hex'), xp, why: 'Won a ' + podName(p), at: now(), duel: p.id }].slice(-200);
      if (w.share.feed) pushEvent(w, { type: 'duel', text: 'won a ' + n + '-person ' + podName(p) });
      touch(w); }
    touch('pods');
  };
  // invitations closing, pods lapsing or starting short, results, and a nudge when the lead changes (once a day at most)
  const podSweep = () => {
    const today = todayKey(); let changed = false;
    for (const p of Object.values(S.pods)) { if (!podOpen(p)) continue;
      for (const [id, x] of Object.entries(p.mem)) { const m = S.members[id];
        if ((!m || m.banned) && (x.st === 'in' || x.st === 'invited')) { x.st = podStarted(p) && x.st === 'in' ? 'out' : 'left'; changed = true; }
        else if (x.st === 'invited' && (now() > p.exp || podStarted(p))) { x.st = 'expired'; changed = true; } }
      if (p.status === 'pending' && !podHas(p, p.by)) { p.status = 'cancelled'; p.endedAt = now(); changed = true;
        podTell(podIds(p, 'in', 'invited'), 'The ' + podName(p) + ' you were invited to was called off.', 'Group duel called off'); continue; }
      if (p.status === 'pending' && now() > p.exp) { p.status = 'lapsed'; p.endedAt = now(); changed = true;
        podTell(podIds(p, 'in'), 'Your ' + podName(p) + ' didn’t start: fewer than 3 people accepted in 48 hours.', 'Group duel lapsed'); continue; }
      if (p.status !== 'active') continue;
      if (!podStarted(p)) { podShort(p); if (p.status !== 'active') changed = true; continue; }
      if (todayKey() > addDaysKey(p.end, 1)) { podSettle(p); changed = true; continue; } // the day after the last day, once late syncs are in
      if (p.leadDay !== today) { const lead = podStanding(p, today).lead;
        if (lead && p.lead && lead !== p.lead && S.members[lead]) { const L = S.members[lead];
          for (const id of podIds(p, 'in')) notify(S.members[id], 'duel', id === lead ? 'You took the lead in your ' + podName(p) + '.' : '@' + L.handle + ' took the lead in your ' + podName(p) + '.', { title: 'Group duel', url: duelUrl });
          p.leadDay = today; }
        if (lead !== p.lead) { p.lead = lead; changed = true; } }
    }
    // finished pods are kept a year and a bit, like duels
    for (const [id, p] of Object.entries(S.pods)) if (!podOpen(p) && now() - ((p.result && p.result.at) || p.endedAt || p.at) > 400 * 86400000) { delete S.pods[id]; changed = true; }
    if (changed) touch('pods');
    return changed;
  };
  // a module the owner made an unlock: the level it needs, when this member is still below it (else 0)
  const lockedFor = (m, mod) => { const need = S.config.unlocksOn && m && !m.unlocked && S.config.modules[mod] > 1 ? S.config.modules[mod] : 0;
    return need && ((m.stats && m.stats.level) || 1) < need ? need : 0; };
  const benchOut = (B, dims) => ({ on: true, at: B.at, contributors: B.contributors, members: B.members, seeds: B.seeds, min: B.min, split: B.split,
    groups: Bench.groupsFor(B, dims).map(g => ({ key: g.key, dims: g.dims, n: g.n, q: g.q, top: g.top })), improvers: impOut(B, dims) });
  // "what traders like you changed when they improved": the most specific of your groups with
  // something to say, else a broader one; group medians and counts only, never anyone's history
  const impOut = (B, dims) => {
    const gs = Bench.groupsFor(B, dims).filter(g => B.imp && B.imp[g.key]).map(g => Object.assign({ key: g.key, dims: g.dims }, B.imp[g.key]));
    const g = [...gs].reverse().find(x => x.changes.length) || [...gs].reverse().find(x => !x.why) || gs.sort((a, b) => b.panel - a.panel)[0];
    if (!g) return { n: 0, nOthers: 0, panel: 0, changes: [], note: 'Not enough history yet. This needs traders like you followed for 8 to 12 weeks.' };
    const note = g.changes.length ? '' : g.why === 'history' ? `Not enough history yet: it needs ${B.min} traders like you followed for 8 to 12 weeks, and ${g.panel} ${g.panel === 1 ? 'is' : 'are'} so far.`
      : g.why === 'few' ? `Too few traders like you improved to compare yet: ${g.n} did. It needs at least 5 who improved and 5 who didn’t.`
      : 'Traders like you who improved didn’t change anything clearly different from the others.';
    return { key: g.key, dims: g.dims, n: g.n, nOthers: g.nOthers, panel: g.panel, weeks: [8, 12], changes: g.changes, note };
  };
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
      claimed: !!m.claimed, av: avUrl(m), bio: m.bio || '', duelsOpen: !!(m.share && m.share.duels !== false), mentor: !!m.mentor, seeking: !!(m.share && m.share.seek),
      // verified Trader Age, for anyone who shares verified Discipline
      traderAge: m.ta && !m.ta.building && m.share && m.share.verify ? m.ta.age : null };
    if (out.isMe) Object.assign(out, { claimedAddress: m.claimed || null, devices: (m.keyHash ? 1 : 0) + (Array.isArray(m.keyHashes) ? m.keyHashes.length : 0),
      vault: m.vault ? { rev: m.vault.rev, size: m.vault.size, at: m.vault.at } : null, requireClaim: !!S.config.requireClaim, vaultOn: !!S.config.vaultOn,
      ta: m.share && m.share.verify ? m.ta || null : null, // verified Trader Age (null: the app shows its own estimate)
      mult: multOut(m), standing: standingOut(m), mentorXp: mentorXpOut(m),
      needsClaim: !!(S.config.requireClaim && m.address && m.claimed !== m.address),
      walletStatus: m.address && (S.config.approveWallets || walletStatus(m.address) === 'rejected') ? walletStatus(m.address) : null, admin: !!m.admin,
      passkeys: (m.passkeys || []).map(k => ({ id: k.id, name: k.name, at: k.at, lastUsed: k.lastUsed || null })),
      unlocked: !!m.unlocked, grants: (m.grants || []).map(g => ({ id: g.id, xp: g.xp, why: g.why, at: g.at })), coach: coachStatusFor(m), coachDetail: !!m.coachDetail,
      leagues: leaguesOf(m).map(L => ({ id: L.id, name: L.name, tier: leagueTier(L, m) })), mentor: !!m.mentor,
      push: { on: !!(m.push && m.push.subs && m.push.subs.length), prefs: sanitizePrefs(null, m.push && m.push.prefs), available: !!push },
      inbox: (m.inbox || []).filter(x => x.at > (m.inboxRead || 0)).length,
      partners: pairsOf(m).filter(p => p.status === 'active').length });
    if (!m.share.profile && !out.isMe) return Object.assign(out, { private: true });
    const ver = m.share.verify && Array.isArray(m.vdays);
    const d30 = disciplineOver(ver ? m.vdays : st.days, addDaysKey(todayKey(), -29), todayKey(), 3);
    Object.assign(out, { duels: Object.assign({ w: 0, l: 0, d: 0 }, m.duelRec), rating: S.config.duels.ladder && m.ladder && m.ladder.n ? m.ladder.r : null,
      pods: Object.assign({ w: 0, n: 0 }, m.podRec), xp: st.xp || 0, streak: st.streak || 0, best: st.best || 0, discipline30: d30.avg == null ? null : Math.round(d30.avg), verified: ver,
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
      o.post = { kind: d.kind || 'note', trade: t, media: (d.media || []).map(id => '/api/social/media/' + id), verified: isVerified(d, m),
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
  // the mark holds while the author still holds the wallet it was read from (and, with approval on,
  // while the owner still accepts it); posts checked before the address was stored keep theirs
  const isVerified = (d, m) => d.verified === true && !!d.trade && d.checked === checkedKey(d.trade)
    && (!d.addr || (!!m && m.claimed === d.addr && !(S.config.approveWallets && walletStatus(d.addr) !== 'approved')));
  const vq = [], vlast = new Map(); let vbusy = 0;
  const verifyPost = (id, m) => { if (!opts.tradeCheck || !m || vq.some(j => j.id === id)) return; vq.push({ id, mid: m.id }); runVerify(); };
  const runVerify = () => { while (vbusy < 2 && vq.length) { const job = vq.shift(); vbusy++; verifyOne(job).catch(() => {}).finally(() => { vbusy--; runVerify(); }); } };
  const verifyOne = async ({ id, mid }) => {
    const m = own(S.members, mid) ? S.members[mid] : null; if (!m || !m.claimed || m.banned) return;
    if (S.config.approveWallets && walletStatus(m.claimed) !== 'approved') return; // a wallet the owner hasn't accepted isn't read on chain at all
    const addr = m.claimed, e = eventById(id); let d; try { d = JSON.parse(e && e.data || 'null'); } catch (x) { return; }
    const t = d && d.trade; if (!t || !(t.status === 'open' || t.status === 'closed') || !t.openedAt) return;
    const key = checkedKey(t); if (d.checked === key) return;
    const last = vlast.get(id); if (last && last.key === key && now() - last.at < 10 * 60000) return;
    vlast.set(id, { key, at: now() }); if (vlast.size > 5000) vlast.delete(vlast.keys().next().value);
    const ok = await opts.tradeCheck(addr, Object.assign({ kind: d.kind }, t)); if (typeof ok !== 'boolean') return;
    const cur = eventById(id); if (!cur) return; const d2 = JSON.parse(cur.data || '{}');
    if (!d2.trade || checkedKey(d2.trade) !== key) { verifyPost(id, m); return; } // it changed meanwhile: check what it is now
    if (!own(S.members, mid) || S.members[mid].claimed !== addr) return;
    d2.verified = ok; d2.checked = key; d2.addr = addr; q('UPDATE events SET data = ? WHERE id = ?').run(JSON.stringify(d2), id); };
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
  // A competition's standings are frozen the day after it ends (a day's grace for the last sync)
  // and served from then on: members' later days and their history being trimmed can't move them.
  const compRows = c => {
    if (c.final) return c.final.filter(r => own(S.members, r.id) && !S.members[r.id].banned); // as members stand today
    const rows = compStandings(c, S.members, todayKey(), !!S.config.requireClaim, m => ({ approval: 'Wallet waiting for approval', rejected: 'Wallet not accepted' })[walletBlock(m)] || null);
    // return and discipline results come from the chain: freeze once every entrant's numbers were
    // read after the end (or a week late at most, for a wallet that can't be read)
    const endMs = Date.parse(c.end + 'T23:59:59Z'), fresh = () => Object.keys(c.entrants).every(id => { const m = own(S.members, id) ? S.members[id] : null;
      if (!m || m.banned) return true; return c.type === 'return' ? !(m.share.ret && m.address) || (m.money && m.money.at > endMs) : c.type === 'discipline' ? !(m.share.verify && m.address) || (m.vAt || 0) > endMs : true; });
    if (todayKey() > addDaysKey(c.end, 1) && (fresh() || todayKey() > addDaysKey(c.end, 7))) { c.final = rows.map(r => ({ id: r.id, handle: r.handle, score: r.score, note: r.note, out: r.out, rank: r.rank })); delete c.log; save('comps'); }
    else if (c.type === 'return' || c.type === 'discipline') for (const id of Object.keys(c.entrants)) if (own(S.members, id)) refreshAll(S.members[id]); // a few at a time (the refresh caps)
    return rows; };
  // each synced day of a survivor or journal competition's entrants is kept with the competition;
  // a broken loss limit stays broken
  const logCompDays = m => { let ch = false;
    for (const c of Object.values(S.comps)) {
      if (!(c.type === 'survivor' || c.type === 'journal') || !c.entrants[m.id] || c.final) continue;
      const L = (c.log = c.log || {})[m.id] = (c.log[m.id] || []), byK = new Map(L.map(d => [d.k, d]));
      for (const d of (m.stats && m.stats.days) || []) { if (d.k < c.start || d.k > c.end) continue;
        const p = byK.get(d.k), n = { k: d.k, b: !!(d.b || (p && p.b)), j: !!d.j };
        if (!p || p.b !== n.b || p.j !== n.j) { byK.set(d.k, n); ch = true; } }
      if (ch) c.log[m.id] = [...byK.values()].sort((a, b) => a.k < b.k ? -1 : 1).slice(-100); }
    return ch; };
  const compOut = (c, viewer, full) => { const st = compStatus(c, todayKey());
    const rows = compRows(c);
    const mine = viewer ? rows.find(r => r.id === viewer.id) || null : null;
    const o = { id: c.id, title: c.title, type: c.type, rule: c.rule, start: c.start, end: c.end, minDays: c.minDays, ddCap: c.ddCap,
      league: c.league && own(S.leagues, c.league) ? { id: c.league, name: S.leagues[c.league].name } : null,
      status: st, entrants: rows.length, joined: !!(viewer && c.entrants[viewer.id]), me: mine };
    if (full) o.standings = rows.slice(0, 50).map(r => ({ rank: r.rank, handle: r.handle, av: avUrl(S.members[r.id]), note: r.note, out: r.out, score: r.score, me: !!viewer && r.id === viewer.id }));
    return o; };
  const joinTimes = new Map();
  // visitors counted today, by day and a hash of the address (memory only: a restart forgets it, which
  // at worst counts someone twice on that day)
  const visitSeen = new Set();
  // for the admin Overview: today's visitors, the 7- and 30-day daily averages, and how many of the
  // new members in the last 30 days had used Pulse without a profile on this device first
  const visitStats = () => {
    const t = now(), keys = n => Array.from({ length: n }, (_, i) => utcDayKey(t - i * 86400000));
    const sum = (o, n) => keys(n).reduce((a, k) => a + (+o[k] || 0), 0);
    const since = n => members().filter(m => (m.createdAt || 0) > t - n * 86400000).length;
    return { today: +S.visits.days[utcDayKey(t)] || 0, avg7: Math.round(sum(S.visits.days, 7) / 7 * 10) / 10, avg30: Math.round(sum(S.visits.days, 30) / 30 * 10) / 10,
      conv30: sum(S.visits.conv, 30), joins30: since(30) };
  };
  const bumpVisit = (kind, day) => {
    const o = S.visits[kind]; o[day] = (o[day] || 0) + 1;
    const keys = Object.keys(o).sort(); while (keys.length > 400) delete o[keys.shift()];
    if (visitSeen.size > 50000) for (const x of visitSeen) if (!x.startsWith(day)) visitSeen.delete(x);
    save('visits'); };

  // ---- inbox and web push: nudges, mentor notes, season results and the daily reminders ----
  const push = opts.push || null; // { publicKey, send(sub, message) -> status }
  const sanitizePrefs = (p, prev) => { const o = Object.assign({ morning: '08:30', eod: '20:30', partner: true, mentor: true, season: true, comment: true, duel: true, tilt: true, on: { morning: true, eod: true } }, prev || {});
    if (p && typeof p === 'object') {
      for (const k of ['morning', 'eod']) if (typeof p[k] === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(p[k])) o[k] = p[k];
      for (const k of ['partner', 'mentor', 'season', 'comment', 'duel', 'tilt']) if (typeof p[k] === 'boolean') o[k] = p[k];
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
    const pr = m.push && m.push.prefs; if (pr && pr[kind] !== false) sendPush(m, { title: extra && extra.title || 'Daruma', body: it.text, tag: 'pulse-' + kind, url: extra && extra.url || '/daruma#today' }).catch(() => {});
  };
  // morning and evening reminders on the member's own clock, once a day each; the evening one
  // only on a day they traded and haven't reviewed yet
  const localHM = (tz, ms) => { try { return fmtFor('hm', tz || 'UTC').format(ms); } catch (e) { return new Date(ms).toISOString().slice(11, 16); } };
  // a reminder goes from its time until four hours later (a server that was down at 08:30 still sends it at 09:10)
  const mins = hm => +hm.slice(0, 2) * 60 + +hm.slice(3, 5);
  const due = (hm, at) => { const d = mins(hm) - mins(at); return d >= 0 && d < 240; };
  let ticking = false;
  const tick = async () => {
    try { duelSweep(); } catch (e) { console.warn('[ledger] duels: ' + (e && e.message)); }
    if (S.config.bench.seeds !== false) seedSchedule(); // daily re-reads of seed wallets come due on their own
    try { if (S.config.bench.on) benchNow(); } catch (e) {} // a daily build keeps the weekly history going without anyone asking
    if (!push || ticking) return 0; ticking = true; const t = now(), jobs = [];
    try {
      for (const m of members()) {
        if (m.banned || !m.push || !Array.isArray(m.push.subs) || !m.push.subs.length) continue;
        const pr = m.push.prefs = sanitizePrefs(null, m.push.prefs), tz = (m.stats && m.stats.tz) || 'UTC', day = zoneKey(tz, t), hm = localHM(tz, t);
        const sent = m.push.sent = m.push.sent || {};
        if (pr.on.morning && sent.morning !== day && due(hm, pr.morning)) { sent.morning = day; touch(m);
          jobs.push(() => sendPush(m, { title: 'Morning prep', body: 'Thirty seconds: sleep, calm, focus, then your rules for today.', tag: 'pulse-morning', url: '/daruma#checkin' })); }
        const today = m.stats && Array.isArray(m.stats.days) ? m.stats.days.find(d => d.k === day) : null;
        if (pr.on.eod && sent.eod !== day && due(hm, pr.eod) && today && !today.r) { sent.eod = day; touch(m);
          jobs.push(() => sendPush(m, { title: 'Review your day', body: 'Five minutes: one lesson, one focus for tomorrow.', tag: 'pulse-eod', url: '/daruma#review' })); }
      }
      if (jobs.length) save(null); // the members touched above
      // eight at a time: one slow push service doesn't hold up everyone else's reminder
      for (let i = 0; i < jobs.length; i += 8) await Promise.all(jobs.slice(i, i + 8).map(f => f().catch(() => 0)));
      return jobs.length + await tiltPass(t);
    } finally { ticking = false; } };
  // Live tilt alerts while Pulse is closed: members who share verified Discipline (so their public
  // fills are read anyway), with push on and tilt alerts allowed, and a trading day in the last two
  // weeks. Each is checked every 5 minutes, four per minute at most, by the app's own pzTiltAlerts
  // (opts.tiltFor), with its rules: once per pattern a day on their clock, 30 minutes apart. When
  // Pulse is open on one of their devices (seen in the last 10 minutes) the app says it instead.
  const tiltChecked = new Map();
  const tiltPass = async t => {
    if (!opts.tiltFor || !canVerify) return 0;
    const recent = addDaysKey(todayKey(), -14), lastDay = m => { const d = Array.isArray(m.vdays) && m.vdays.length ? m.vdays : m.stats && Array.isArray(m.stats.days) ? m.stats.days : []; return d.length ? d[d.length - 1].k : ''; };
    const due = members().filter(m => !m.banned && m.push && Array.isArray(m.push.subs) && m.push.subs.length && m.share && m.share.verify && walletFor(m)
      && m.push.prefs && m.push.prefs.tilt !== false && t - (tiltChecked.get(m.id) || 0) >= 5 * 60000 && lastDay(m) >= recent)
      .sort((a, b) => (tiltChecked.get(a.id) || 0) - (tiltChecked.get(b.id) || 0)).slice(0, 4);
    let sent = 0;
    await Promise.all(due.map(async m => { tiltChecked.set(m.id, t);
      try {
        const r = await opts.tiltFor(walletFor(m), (m.stats && m.stats.tz) || 'UTC', m.tilt || null);
        if (!r || !r.st || !own(S.members, m.id)) return;
        m.tilt = r.st; touch(m);
        if (r.pick && !(m.lastSeen && t - m.lastSeen < 10 * 60000)) { notify(m, 'tilt', r.pick.text, { title: r.pick.title, url: '/daruma#today' }); sent++; }
      } catch (e) { /* the exchange or the fills cache failed: the next pass tries again */ } }));
    if (due.length) save(null);
    return sent; };

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
  // ---- trade reviews: a trade a member sends their mentors, and the thread on it. The member and
  // the server's mentors see it while the member lets mentors in; admins read it (read-only) ----
  const REVIEWS_PER_DAY = 10, REVIEWS_KEEP = 100, REVIEW_COMMENTS_MAX = 200;
  const reviewById = id => typeof id === 'string' && /^[a-f0-9]{12}$/.test(id) ? q('SELECT * FROM reviews WHERE id = ?').get(id) || null : null;
  const mentorsOf = m => members().filter(o => o.mentor && !o.banned && o.id !== m.id);
  const reviewRole = (r, me) => { const o = own(S.members, r.member) ? S.members[r.member] : null; if (!o) return null;
    return o.id === me.id ? 'mentee' : me.mentor && !o.banned && o.share.mentor ? 'mentor' : null; };
  const reviewTrade = r => { let t = {}; try { t = JSON.parse(r.data) || {}; } catch (e) {}
    if (!(own(S.members, r.member) && S.members[r.member].share.usd)) delete t.usd; return t; }; // dollars only while they share them
  const tradeName = t => (t.label || t.coin) + ' ' + t.side;
  const reviewOut = (r, viewer) => { const o = own(S.members, r.member) ? S.members[r.member] : null, by = r.reviewer && own(S.members, r.reviewer) ? S.members[r.reviewer] : null;
    const lastBy = (q('SELECT member FROM review_comments WHERE review = ? ORDER BY at DESC, rowid DESC LIMIT 1').get(r.id) || {}).member;
    return { id: r.id, key: viewer && viewer.id === r.member ? r.trade : null, at: r.at, last: r.last, handle: o ? o.handle : null, av: avUrl(o), trade: reviewTrade(r),
      comments: r.comments, reviewed: r.reviewed ? { at: r.reviewed, by: by ? by.handle : null } : null, waiting: !r.reviewed && (!lastBy || lastBy === r.member) }; };
  const threadOut = (r, viewer, role) => ({ role, review: reviewOut(r, viewer),
    comments: q('SELECT * FROM review_comments WHERE review = ? ORDER BY at, rowid').all(r.id).filter(c => own(S.members, c.member) && !S.members[c.member].banned)
      .map(c => ({ id: c.id, at: c.at, text: c.text, handle: S.members[c.member].handle, av: avUrl(S.members[c.member]), mentor: c.member !== r.member, mine: !!viewer && c.member === viewer.id })) });
  const addReviewComment = (rid, m, text) => tx(() => { q('INSERT INTO review_comments (id, review, member, at, text) VALUES (?, ?, ?, ?, ?)').run(crypto.randomBytes(6).toString('hex'), rid, m.id, now(), text);
    q('UPDATE reviews SET comments = comments + 1, last = ? WHERE id = ?').run(now(), rid); });

  // ---- seasons ----
  const seasonInfo = L => { if (!L.season) return null; const id = seasonOf(L.season, todayKey()), b = seasonBounds(id);
    return { id, label: seasonLabel(id), start: b.start, end: b.end, daysLeft: Math.round((Date.parse(b.end) - Date.parse(todayKey())) / 86400000) }; };
  const SEASON_BADGES = { 'season-gold': ['Season champion', '🏆', 'Finished first in a league season'], 'season-silver': ['Season runner-up', '🥈', 'Finished second in a league season'],
    'season-bronze': ['Season podium', '🥉', 'Finished third in a league season'],
    'duel-gold': ['Duel season champion', '🏆', 'Gained the most duel rating in a season'], 'duel-silver': ['Duel season runner-up', '🥈', 'Second on the duel ladder for a season'],
    'duel-bronze': ['Duel season podium', '🥉', 'Third on the duel ladder for a season'] };
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
      notify(m, 'season', 'You finished #' + (i + 1) + ' in the ' + L.name + ' ' + seasonLabel(id) + ' season.', { title: 'Season over ' + SEASON_BADGES[bid][1], url: '/daruma#lg/' + L.id }); });
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
    // keys that would make a plain object throw when a route coerces it to text or a number
    // ({"toString":1}) never reach the routes; prototype keys never become own properties
    return raw ? JSON.parse(raw, (k, v) => k === 'toString' || k === 'valueOf' || k === '__proto__' || k === Symbol.toPrimitive ? undefined : v) : {};
  };

  async function handle(req, res, url, query) {
    const M = req.method;
    const parts = url.split('/').slice(3); // ['', 'api', 'social', ...]
    const head = parts[0] || '';
    let body = {};
    const limit = head === 'vault' ? MAX_VAULT_BODY + 4096 : head === 'stats' ? 4 * MAX_SOCIAL_BODY : head === 'admin' && parts[1] === 'bench' ? 8 * MAX_SOCIAL_BODY /* a pasted list of seed wallets */ : MAX_SOCIAL_BODY;
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
      // one member can't fill the server's room for everyone
      if ((q('SELECT sum(size) AS n FROM media WHERE member = ?').get(who.id).n || 0) + buf.length > (opts.mediaMemberMax || MAX_MEDIA_MEMBER)) return json(res, 507, { error: 'You’ve used your room for pictures on this server. Delete a few old posts with pictures first.' });
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

    // a device using Pulse without a profile today (it asks once a day; one address counts once a day too)
    if (head === 'visit' && !parts[1] && M === 'POST') {
      const day = utcDayKey(now()), k = day + '|' + sha(ipOf(req) || '');
      if (!visitSeen.has(k)) { visitSeen.add(k); bumpVisit('days', day); }
      return json(res, 200, { ok: true });
    }
    // every wallet entered in the app, profile or not: the owner sees it under Wallets, and it's queued as a
    // seed wallet, so the benchmarks count it (anonymously, like any seed) once it has traded enough
    if (head === 'seen' && !parts[1] && M === 'POST') {
      if (limited(req, 'seen', 30, 600000)) return json(res, 429, { error: 'Too many requests from here. Try again in a few minutes.' });
      const list = [...new Set((Array.isArray(body.addresses) ? body.addresses : []).slice(0, 20)
        .filter(a => typeof a === 'string' && ADDR_RE.test(a)).map(a => a.toLowerCase()))];
      if (!list.length) return json(res, 400, { error: 'no wallet addresses' });
      const t = now(), day = utcDayKey(t); let seen = false, seeded = false;
      for (const a of list) {
        const w = own(S.walletsSeen, a) ? S.walletsSeen[a] : null;
        if (!w) { S.walletsSeen[a] = { first: t, last: t }; seen = true; }
        else if (utcDayKey(w.last || 0) !== day) { w.last = t; seen = true; }
        // a wallet the owner rejected stays out; the owner can still add it by hand under Benchmarks
        if (!own(S.benchSeeds, a) && walletStatus(a) !== 'rejected' && Object.keys(S.benchSeeds).length < SEED_MAX) {
          S.benchSeeds[a] = { st: 'queued', added: t, by: 'app' }; seeded = true; }
      }
      const all = Object.keys(S.walletsSeen);
      if (all.length > WALLETS_SEEN_MAX) { // the least recently seen go first
        all.sort((x, y) => (S.walletsSeen[x].last || 0) - (S.walletsSeen[y].last || 0));
        for (const a of all.slice(0, all.length - WALLETS_SEEN_MAX)) delete S.walletsSeen[a]; }
      if (seen || seeded) save(...(seen ? ['walletsSeen'] : []), ...(seeded ? ['benchSeeds'] : []));
      if (seeded) seedSchedule();
      return json(res, 200, { ok: true });
    }
    if (head === 'config' && M === 'GET')
      return json(res, 200, { enabled: adminConfigured, open: S.config.open, inviteRequired: !!S.config.inviteCode, unlocksOn: S.config.unlocksOn,
        unlocks: S.config.unlocks, tiers: TIERS, week: S.league.week, members: members().filter(m => !m.banned).length,
        claims: !!sig, passkeys: true, requireClaim: !!S.config.requireClaim, approveWallets: !!S.config.approveWallets, vaultOn: !!S.config.vaultOn,
        modules: S.config.modules, levels: S.config.levels, xp: S.config.xp, profiles: S.config.profiles, guestCap: S.config.guestCap, mult: S.config.mult, standing: standingCfgOut(), mentorXp: S.config.mentorXp,
        bench: { on: !!S.config.bench.on, minTrades: S.config.bench.minTrades, days: S.config.bench.days }, duels: { on: !!S.config.duels.on },
        coach: { members: S.config.coach.members, daily: S.config.coach.daily, detail: S.config.coach.detail }, posts: postCfgOut(),
        badges: Object.values(S.badges).map(b => ({ id: b.id, name: b.name, icon: b.icon, desc: b.desc, metric: b.metric, metricLabel: b.metric ? SC.BADGE_METRICS[b.metric] : null, op: b.op, value: b.value, xp: b.xp })),
        leagues: Object.values(S.leagues).filter(L => L.open).length,
        autoLeagues: Object.values(S.leagues).filter(L => L.autoJoin).map(L => ({ id: L.id, name: L.name, metricLabel: SC.LEAGUE_METRICS ? SC.LEAGUE_METRICS[L.metric] || '' : '' })) });

    // ---------- owner: admin ----------
    if (head === 'admin') {
      // an open server (no AUTH_TOKEN) would make everyone an admin: refuse until a token is set
      if (!adminConfigured) return json(res, 403, { error: 'Set AUTH_TOKEN on the server to use the admin panel.' });
      // the owner (AUTH_TOKEN), or a member the owner made an admin (their own Pulse key)
      let who = null;
      if (req.headers['authorization'] && authOk(req)) who = { owner: true, by: 'owner', name: 'Owner' };
      else { const am = byKey(req); if (am && am.admin && !am.banned) { who = { owner: false, id: am.id, by: '@' + am.handle, name: '@' + am.handle }; am.lastSeen = now(); } }
      if (!who) return json(res, 401, { error: 'unauthorized' });
      // a second factor (admin2fa.js), when two-factor applies to this person; it answers /admin/2fa/* itself
      if (opts.twofa && opts.twofa.gate(req, res, who, { parts: parts.slice(1), M, body, siteOf,
        admins: () => members().filter(m => m.admin && !m.banned), log: what => { S.adminLog.push({ at: now(), by: who.by, what }); save('adminLog'); } })) return;
      const sub = parts[1] || '';
      if (sub === 'me' && M === 'GET') return json(res, 200, { owner: who.owner, id: who.id || null, name: who.name });
      if (sub === 'log' && M === 'GET') return json(res, 200, { log: S.adminLog.slice(-200).reverse() });
      if (M !== 'GET') { S.adminLog.push({ at: now(), by: who.by, what: (M + ' ' + parts.slice(1).join('/') + (body && typeof body.action === 'string' ? ' · ' + body.action.slice(0, 20) : '')).slice(0, 120) });
        if (S.adminLog.length > 500) S.adminLog = S.adminLog.slice(-400); touch('adminLog'); }
      // ---- insights: each member's numbers, and the whole base / any segment of it ----
      if (sub === 'insights' && M === 'GET') {
        const today = todayKey(), all = members();
        const rows = all.map(m => Insights.memberRow(m, { today, leagues: leaguesOf(m).map(L => L.id) }));
        const f = {}; for (const k of Insights.FILTERS) if (typeof query[k] === 'string' && query[k].length <= 40) f[k] = query[k];
        const labels = Object.assign({}, Bench.DIMS, { league: Object.fromEntries(Object.values(S.leagues).map(L => [L.id, L.name])) });
        const out = Insights.insights(rows, all, f, { now: now(), today, by: typeof query.by === 'string' ? query.by : 'style', sort: query.sort, metric: query.metric, labels });
        return json(res, 200, Object.assign(out, { filters: f, labels, metrics: Insights.METRICS, slipsLabels: Insights.SLIPS, levelBands: Insights.LEVEL_BANDS.map(b => b[0]),
          activity: Insights.ACTIVITY, cohortsAll: [...new Set(rows.filter(r => r.joined).map(r => new Date(r.joined).toISOString().slice(0, 7)))].sort().reverse() }));
      }
      if (sub === 'members' && parts[2] && parts[3] === 'perf' && M === 'GET') {
        const m = own(S.members, parts[2]) ? S.members[parts[2]] : null; if (!m) return json(res, 404, { error: 'no such member' });
        const today = todayKey(), rows = members().filter(x => !x.banned).map(x => Insights.memberRow(x, { today, leagues: leaguesOf(x).map(L => L.id) }));
        const r = Insights.memberRow(m, { today, leagues: leaguesOf(m).map(L => L.id) });
        // where they sit: among all members, and in their peer group of "traders like you" (members and seed wallets)
        const pct = {}, peer = {}; let group = null;
        if (r.seg) { const gs = Bench.groupsFor(benchNow(), r.seg); const styled = gs.filter(g => g.dims.style); group = (styled.length ? styled : gs).slice(-1)[0] || null; }
        for (const k of Object.keys(Insights.METRICS)) { const v = Insights.valueOf(r, k); pct[k] = Insights.percentileIn(rows, k, v);
          const bk = k === 'disc30' ? 'disc' : own(Bench.METRICS, k) ? k : null; // the group's deciles are in the benchmark's own measures
          if (group && bk && group.q[bk]) peer[k] = Insights.percentileFromDeciles(group.q[bk], v, Insights.METRICS[k].hi); }
        return json(res, 200, { row: r, pct, peer, group: group ? { key: group.key, dims: group.dims, n: group.n } : null, labels: Bench.DIMS, metrics: Insights.METRICS, slipsLabels: Insights.SLIPS });
      }
      if (sub === 'overview' && M === 'GET') {
        const wk = S.league.week, act = members().filter(m => now() - (m.lastSeen || 0) < 7 * 86400000);
        return json(res, 200, { adminConfigured, members: members().length, banned: members().filter(m => m.banned).length, active7: act.length,
          events: q('SELECT count(*) AS n FROM events').get().n, posts: q("SELECT count(*) AS n FROM events WHERE type = 'post'").get().n,
          reports: q('SELECT count(*) AS n FROM reports WHERE open = 1').get().n, mediaBytes: q('SELECT sum(size) AS n FROM media').get().n || 0, comps: Object.keys(S.comps).length, week: wk, config: S.config,
          walletsPending: S.config.approveWallets ? new Set(members().filter(m => m.address && walletStatus(m.address) === 'pending').map(m => m.address)).size : 0,
          claimed: members().filter(m => m.claimed).length, unclaimed: members().filter(m => !m.banned && m.address && m.claimed !== m.address).length,
          visitors: visitStats(), vaults: members().filter(m => m.vault).length, vaultBytes: vaultTotal(), claims: !!sig,
          originPinned: origins.length > 0 || !!opts.hostVetted,
          leagues: Object.keys(S.leagues).length, badges: Object.keys(S.badges).length, coachAi: !!opts.coachAvailable,
          coachToday: Object.keys(S.coachUse).filter(k => k.startsWith('m:')).reduce((a, k) => a + coachUsedKey(k, 'UTC'), 0) + (S.ownerCoach.k === utcDayKey(now()) ? S.ownerCoach.n : 0),
          meta: { modules: SC.MODULES, leagueMetrics: SC.LEAGUE_METRICS, badgeMetrics: SC.BADGE_METRICS, profiles: SC.PROFILES },
          tiers: TIERS.map((t, i) => ({ tier: t, n: S.leagues.main ? members().filter(m => !m.banned && own(S.leagues.main.members, m.id) && leagueTier(S.leagues.main, m) === i).length : 0 })) });
      }
      if (sub === 'members' && M === 'GET' && !parts[2])
        return json(res, 200, { members: members().sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0)).map(m => ({ id: m.id, handle: m.handle,
          tier: m.tier || 0, level: (m.stats && m.stats.level) || 1, xp: (m.stats && m.stats.xp) || 0, streak: (m.stats && m.stats.streak) || 0,
          passkeys: (m.passkeys || []).length,
          address: m.address || null, walletStatus: m.address ? walletStatus(m.address) : null, joinedWith: m.joinedWith || (m.adminMade ? 'admin' : null), claimed: m.claimed || null, devices: (m.keyHash ? 1 : 0) + (Array.isArray(m.keyHashes) ? m.keyHashes.length : 0),
          vault: m.vault ? m.vault.size : 0, share: m.share, banned: !!m.banned, unlocked: !!m.unlocked, coachDaily: m.coachDaily != null ? m.coachDaily : null,
          coachUsed: coachUsed(m), coachLimit: coachLimitFor(m), grants: m.grants || [], awards: Object.keys(m.awards || {}).filter(id => own(S.badges, id)),
          wallets: linkedOf(m).filter(a => a !== m.address),
          leagues: leaguesOf(m).map(L => ({ id: L.id, tier: leagueTier(L, m) })), adminMade: !!m.adminMade, mentor: !!m.mentor, admin: !!m.admin, keys: (m.keyHash ? 1 : 0) + (Array.isArray(m.keyHashes) ? m.keyHashes.length : 0), verified: !!(m.share.verify && Array.isArray(m.vdays)), standing: standingOn() ? standingOf(m).state : null, mentorXp: m.mentorXp ? (mentorXpOut(m) || {}).total || 0 : 0, createdAt: m.createdAt, lastSeen: m.lastSeen || null,
          av: avUrl(m), bio: m.bio || '',
          money: m.money && m.money.ret != null ? { ret: m.money.ret, dd: m.money.dd } : null })) });
      if (sub === 'members' && !parts[2] && M === 'POST') { // the owner adds someone; they sign in with the code it returns
        if (body.admin && !who.owner) return json(res, 403, { error: 'Only the owner can add admins.' });
        const handle = cleanText(body.handle, 20).replace(/^@/, '');
        if (!HANDLE_RE.test(handle)) return json(res, 400, { error: 'A name is 3–20 letters, numbers or underscores.' });
        if (byHandle(handle)) return json(res, 409, { error: 'That name is taken.' });
        if (members().length >= MAX_MEMBERS) return json(res, 403, { error: 'The league is full.' });
        let address = typeof body.address === 'string' && ADDR_RE.test(body.address) ? body.address.toLowerCase() : null; if (claimedBy(address) || mappedTo(address)) address = null;
        const id = crypto.randomBytes(6).toString('hex'), A = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let code = ''; for (const x of crypto.randomBytes(10)) code += A[x % 32];
        const m = { id, handle, keyHash: null, keyHashes: [], createdAt: now(), lastSeen: 0, tier: 0, share: sanitizeShare(body.share), address, stats: null, weekXp: {}, money: null,
          banned: false, adminMade: true, unlocked: !!body.unlocked, pendingCodes: [{ h: sha(code), exp: now() + 7 * 86400000 }] };
        if (body.admin) { m.admin = true; m.adminSince = now(); }
        if (address && S.config.approveWallets && !walletReview(address)) S.wallets[address] = { s: 'approved', at: now(), by: who.owner ? 'owner' : who.by, note: '' }; // the owner (or an admin) attached it: that's an approval
        S.members[id] = m; S.follows[id] = []; reindex();
        const ls = body.leagues != null ? [].concat(body.leagues) : Object.values(S.leagues).filter(L => L.autoJoin).map(L => L.id);
        for (const lid of ls) if (own(S.leagues, lid)) joinLeague(S.leagues[lid], m);
        save(); refreshAll(m);
        return json(res, 200, { ok: true, id, code, expiresAt: now() + 7 * 86400000 });
      }
      // many members at once: {action: remove | ban | unban | verify | unverify, ids: [...]}. The same
      // rules as one at a time: only the owner acts on another admin, and nobody on themselves
      if (sub === 'members' && parts[2] === 'bulk' && !parts[3] && M === 'POST') {
        const a = body.action, ids = [...new Set([].concat(body.ids || []).filter(x => typeof x === 'string'))];
        if (!['remove', 'ban', 'unban', 'verify', 'unverify'].includes(a)) return json(res, 400, { error: 'action is remove, ban, unban, verify or unverify' });
        if (!ids.length || ids.length > 1000) return json(res, 400, { error: 'Pick 1 to 1,000 members.' });
        let n = 0; const skipped = [];
        for (const id of ids) {
          const m = own(S.members, id) ? S.members[id] : null; if (!m) { skipped.push({ id, why: 'not found' }); continue; }
          if (!who.owner && m.id === who.id && a !== 'verify' && a !== 'unverify') { skipped.push({ id, handle: m.handle, why: 'that’s you' }); continue; }
          if (m.admin && !who.owner && m.id !== who.id) { skipped.push({ id, handle: m.handle, why: 'only the owner can change another admin' }); continue; }
          if (a === 'remove') dropMember(m.id);
          else if (a === 'ban' || a === 'unban') m.banned = a === 'ban';
          else { const ws = walletsOf(m); if (!ws.length) { skipped.push({ id, handle: m.handle, why: 'no wallet' }); continue; }
            for (const ad of ws) { S.wallets[String(ad).toLowerCase()] = { s: a === 'verify' ? 'approved' : 'rejected', at: now(), by: who.owner ? 'owner' : who.by, note: 'from the members list' }; }
            for (const o of members()) if (o.address && ws.map(x => String(x).toLowerCase()).includes(o.address)) { recheckWallet(o); if (walletFor(o)) refreshAll(o); } }
          n++;
        }
        save(); return json(res, 200, { ok: true, n, skipped });
      }
      if (sub === 'members' && parts[2] && M === 'POST') {
        const m = own(S.members, parts[2]) ? S.members[parts[2]] : null; if (!m) return json(res, 404, { error: 'no such member' });
        const a = body.action; let extra = {};
        // admins run the league; only the owner makes or removes admins, or acts on another admin's profile
        if ((a === 'admin' || a === 'unadmin') && !who.owner) return json(res, 403, { error: 'Only the owner can add or remove admins.' });
        if (m.admin && !who.owner && m.id !== who.id) return json(res, 403, { error: 'Only the owner can change another admin.' });
        if (a === 'admin' || a === 'unadmin') { m.admin = a === 'admin'; if (m.admin) m.adminSince = now(); else delete m.adminSince; }
        else if (a === 'ban' || a === 'unban') m.banned = a === 'ban';
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
            { const mp = ad && mappedTo(ad, m.id); if (mp) return json(res, 409, { error: 'That wallet is mapped to @' + mp.handle + '. Unmap it there first.' }); }
            if (ad) m.wallets = linkedOf(m).filter(x => x !== ad); // it becomes the main one
            if (ad && S.config.approveWallets && !walletReview(ad)) S.wallets[ad] = { s: 'approved', at: now(), by: who.owner ? 'owner' : who.by, note: '' };
            if (ad !== m.address) { m.address = ad; walletMoved(m); refreshAll(m); } }
          if (body.share && typeof body.share === 'object') m.share = sanitizeShare(body.share, m.share);
        }
        else if (a === 'clearAvatar') { dropMedia(q('SELECT id FROM media WHERE member = ? AND kind = ?').all(m.id, 'avatar')); m.avatar = null; }
        else if (a === 'clearBio') m.bio = '';
        else if (a === 'mentor' || a === 'unmentor') m.mentor = a === 'mentor'; // sees the days of members who let mentors in, and comments on them
        else if (a === 'unlock' || a === 'lock') m.unlocked = a === 'unlock'; // every feature, theme and the bigger coach allowance
        else if (a === 'coachreset') coachReset(m); // today's count back to zero, for the profile and its wallet
        else if (a === 'link' || a === 'unlink' || a === 'primary') { // map wallets to this member by hand
          const ad = typeof body.address === 'string' && ADDR_RE.test(body.address.trim()) ? body.address.trim().toLowerCase() : null;
          if (!ad) return json(res, 400, { error: 'That isn’t a wallet address (0x and 40 hex characters).' });
          if (a === 'unlink') { if (ad === m.address) return json(res, 400, { error: 'That’s their main wallet: make another one main first, or clear it under Profile.' });
            if (!linkedOf(m).includes(ad)) return json(res, 404, { error: 'That wallet isn’t mapped to @' + m.handle + '.' });
            m.wallets = linkedOf(m).filter(x => x !== ad); }
          else {
            const cl = claimedBy(ad, m.id); if (cl) return json(res, 409, { error: 'That wallet is claimed by @' + cl.handle + ' (proved by signature). Only they can move it.' });
            const mp = mappedTo(ad, m.id); if (mp) return json(res, 409, { error: 'That wallet is mapped to @' + mp.handle + '. Unmap it there first.' });
            const um = members().find(o => o.id !== m.id && o.address === ad); if (um) return json(res, 409, { error: 'That’s @' + um.handle + '’s main wallet. Take it off their profile first.' });
            if (a === 'primary' && m.claimed && m.claimed === m.address && ad !== m.address) return json(res, 409, { error: '@' + m.handle + '’s main wallet is claimed by signature: only they can change it.' });
            if (a === 'link') { if (ad === m.address || linkedOf(m).includes(ad)) return json(res, 400, { error: 'That wallet is already @' + m.handle + '’s.' });
              if (linkedOf(m).length >= 20) return json(res, 400, { error: 'Twenty wallets per member at most.' }); }
            if (S.config.approveWallets && !walletReview(ad)) S.wallets[ad] = { s: 'approved', at: now(), by: who.owner ? 'owner' : who.by, note: 'mapped to @' + m.handle }; // mapping it is approving it
            if (a === 'primary' || !m.address) { // the main wallet: the old main one stays mapped
              const old = m.address; m.wallets = [...linkedOf(m).filter(x => x !== ad), ...(old && old !== ad ? [old] : [])];
              if (ad !== old) { m.address = ad; walletMoved(m); refreshAll(m); } }
            else m.wallets = [...linkedOf(m), ad];
            extra = { wallets: walletsOf(m), address: m.address }; } }
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
      // ---- wallets: the owner approves or rejects each address ----
      if (sub === 'wallets' && M === 'GET') {
        const rows = new Map();
        for (const m of members()) if (m.address) {
          const r = rows.get(m.address) || { address: m.address, members: [] };
          r.members.push({ id: m.id, handle: m.handle, claimed: m.claimed === m.address, banned: !!m.banned,
            joinedWith: m.joinedWith || (m.adminMade ? 'admin' : null), createdAt: m.createdAt || null, lastSeen: m.lastSeen || null });
          rows.set(m.address, r);
        }
        for (const m of members()) for (const a of linkedOf(m)) if (a !== m.address) { // mapped by hand
          const r = rows.get(a) || { address: a, members: [] };
          r.members.push({ id: m.id, handle: m.handle, claimed: false, banned: !!m.banned, linked: true,
            joinedWith: m.joinedWith || (m.adminMade ? 'admin' : null), createdAt: m.createdAt || null, lastSeen: m.lastSeen || null });
          rows.set(a, r); }
        for (const a of Object.keys(S.wallets)) if (!rows.has(a)) rows.set(a, { address: a, members: [] }); // decided, nobody uses it now
        for (const a of Object.keys(S.walletsSeen)) if (!rows.has(a)) rows.set(a, { address: a, members: [] }); // entered in the app, no profile uses it
        const rank = { pending: 0, rejected: 1, approved: 2 };
        const recent = r => Math.max(r.seen ? r.seen.last : 0, ...r.members.map(x => x.createdAt || 0));
        const wallets = [...rows.values()].map(r => { const rv = walletReview(r.address), sn = own(S.walletsSeen, r.address) ? S.walletsSeen[r.address] : null,
            sd = own(S.benchSeeds, r.address) ? S.benchSeeds[r.address] : null;
          return Object.assign(r, { status: walletStatus(r.address), reviewedAt: rv ? rv.at : null, by: rv ? rv.by : null, note: rv ? rv.note || '' : '',
            seen: sn ? { first: sn.first || null, last: sn.last || null } : null, bench: sd ? sd.st : null }); })
          .sort((a, b) => rank[a.status] - rank[b.status] || recent(b) - recent(a));
        return json(res, 200, { approveWallets: !!S.config.approveWallets, wallets,
          counts: { pending: wallets.filter(w => w.status === 'pending' && w.members.length).length, approved: wallets.filter(w => w.status === 'approved').length, rejected: wallets.filter(w => w.status === 'rejected').length,
            app: wallets.filter(w => w.seen && !w.members.length).length } });
      }
      if (sub === 'wallets' && M === 'POST') { // {action: approve|reject|clear, addresses: [...] , note?} — or one address in the path
        const action = body.action;
        if (!['approve', 'reject', 'clear'].includes(action)) return json(res, 400, { error: 'action is approve, reject or clear' });
        const list = (parts[2] ? [parts[2]] : [].concat(body.addresses || [])).map(a => String(a).toLowerCase());
        if (!list.length || list.length > 1000 || list.some(a => !ADDR_RE.test(a))) return json(res, 400, { error: 'Give one or more wallet addresses (0x + 40 hex).' });
        const note = cleanText(body.note, 120);
        for (const a of new Set(list)) {
          if (action === 'clear') delete S.wallets[a];
          else S.wallets[a] = { s: action === 'approve' ? 'approved' : 'rejected', at: now(), by: who.owner ? 'owner' : who.by, note };
          for (const m of members()) if (m.address === a) { recheckWallet(m); if (walletFor(m)) refreshAll(m); }
        }
        save(); return json(res, 200, { ok: true, n: new Set(list).size });
      }
      if (sub === 'config' && M === 'PUT') {
        const c = S.config;
        if (typeof body.open === 'boolean') c.open = body.open;
        if (typeof body.inviteCode === 'string') c.inviteCode = cleanText(body.inviteCode, 40);
        if (typeof body.unlocksOn === 'boolean') c.unlocksOn = body.unlocksOn;
        if (typeof body.vaultOn === 'boolean') c.vaultOn = body.vaultOn;
        if (body.mult) c.mult = sanitizeMult(body.mult, c.mult);
        if (body.standing) c.standing = sanitizeStanding(body.standing, c.standing);
        if (body.mentorXp) c.mentorXp = sanitizeMentorXp(body.mentorXp, c.mentorXp);
        if (body.guestCap !== undefined && isFinite(+body.guestCap)) c.guestCap = Math.max(0, Math.min(100, Math.round(+body.guestCap)));
        if (body.modules) c.modules = SC.sanitizeModules(body.modules, c.modules);
        if (body.unlocks) c.modules = SC.sanitizeModules(body.unlocks, c.modules); // v0.3 panels send this name
        if (body.levels) c.levels = SC.sanitizeLevels(body.levels, c.levels);
        if (body.xp) c.xp = SC.sanitizeXp(body.xp, c.xp);
        if (body.coach) c.coach = SC.sanitizeCoachCfg(body.coach, c.coach);
        if (body.profiles) c.profiles = SC.sanitizeProfiles(body.profiles, c.profiles);
        if (body.posts) c.posts = sanitizePostCfg(body.posts, c.posts);
        if (body.bench) { const was = c.bench; c.bench = Bench.sanitizeBenchCfg(body.bench, c.bench);
          // a new bar or window: left-out wallets get another look (and a new window means re-reading the counted ones too)
          if (was && (was.minTrades !== c.bench.minTrades || was.days !== c.bench.days)) {
            for (const x of Object.values(S.benchSeeds)) if (x.st === 'skip' || (x.st === 'ok' && (was.days !== c.bench.days || (x.sum && x.sum.n < c.bench.minTrades)))) { x.st = 'queued'; x.why = ''; }
            benchDirty = true; save('benchSeeds'); seedSchedule(); } }
        if (body.duels) c.duels = Duels.sanitizeDuelCfg(body.duels, c.duels);
        if (typeof body.requireClaim === 'boolean' && body.requireClaim !== c.requireClaim) {
          c.requireClaim = body.requireClaim;
          // numbers read from wallets nobody signed for stop counting at once, and come back after a claim
          for (const m of members()) recheckWallet(m);
          // and each member it affects hears why, and what to do about it
          if (c.requireClaim) for (const m of members()) if (m.address && m.claimed !== m.address)
            notify(m, 'claim', 'Your league now counts only wallets a member has proved are theirs. Claim yours in Account: it\u2019s a signature, not a transaction, and nothing moves. Until then your verified Discipline and returns don\u2019t count.', { url: '/daruma#account' });
        }
        if (typeof body.approveWallets === 'boolean' && body.approveWallets !== c.approveWallets) {
          c.approveWallets = body.approveWallets;
          // switching approval on doesn't pull the rug from current members: wallets already in
          // use count as approved (marked 'existing', so the owner can still review and reject them)
          if (c.approveWallets && body.grandfather !== false)
            for (const m of members()) if (m.address && !walletReview(m.address)) S.wallets[m.address] = { s: 'approved', at: now(), by: 'existing', note: '' };
          for (const m of members()) { recheckWallet(m); if (walletFor(m)) refreshAll(m); }
        }
        c.unlocks = { trends: c.modules.trends, share: c.modules.share, compete: c.modules.compete };
        save(); return json(res, 200, { ok: true, config: c });
      }
      // ---- duels: settings, the ones running and waiting, and a cancel for the odd bad one ----
      if (sub === 'duels' && M === 'GET') {
        duelSweep();
        const all = Object.values(S.duels), h = id => (S.members[id] || {}).handle || '(left)';
        const out = d => ({ id: d.id, a: h(d.a), b: h(d.b), type: d.type, label: duelName(d), period: d.period, status: d.status, stake: d.stake || 0, start: d.start || null, end: d.end || null, at: d.at,
          awaiting: d.awaiting ? h(d.awaiting) : null, winner: d.result && d.result.winner ? h(d.result.winner) : null, why: d.result ? d.result.why : '' });
        // a group duel in the same rows: everyone still in it (or who played), the creator first
        const pods = Object.values(S.pods), pout = p => ({ id: p.id, pod: true, names: [p.by, ...podIds(p, 'in', 'out', 'invited').filter(id => id !== p.by)].map(h),
          type: p.type, label: Duels.TYPES[p.type].label, period: p.period, status: p.status, stake: 0, start: p.start || null, end: p.end || null, at: p.at, done: p.result ? p.result.at : 0,
          awaiting: p.status === 'pending' ? podIds(p, 'invited').length + ' to answer' : null, winner: p.result && p.result.winner ? h(p.result.winner) : null, why: p.final ? p.final.why : '' });
        const sb = seasonBoard(), sid = S.ladder.season;
        const ladder = { season: Object.assign({ id: sid, label: seasonLabel(sid) }, seasonBounds(sid)), top: sb.slice(0, 10).map(m => ({ handle: m.handle, gain: seasonGain(m), r: m.ladder.r, n: m.ladder.n })),
          listed: ladderBoard().length, last: (S.ladder.hall || []).filter(x => x.podium.length).slice(-1).map(x => ({ label: x.label, podium: x.podium.map(y => y.handle) }))[0] || null };
        return json(res, 200, { config: S.config.duels, types: Duels.TYPES, ladder, pods: { open: pods.filter(podOpen).length, done30: pods.filter(p => p.status === 'done' && now() - p.result.at < 30 * 86400000).length },
          counts: { pending: all.filter(d => d.status === 'pending').length, active: all.filter(d => d.status === 'active').length, done: all.filter(d => d.status === 'done').length,
            done30: all.filter(d => d.status === 'done' && now() - d.result.at < 30 * 86400000).length, declined: all.filter(d => d.status === 'declined').length },
          open: [...all.filter(duelOpen).map(out), ...pods.filter(podOpen).map(pout)].sort((x, y) => y.at - x.at).slice(0, 100),
          recent: [...all.filter(d => d.status === 'done').map(d => Object.assign(out(d), { done: d.result.at })), ...pods.filter(p => p.status === 'done').map(pout)].sort((x, y) => y.done - x.done).slice(0, 30) });
      }
      if (sub === 'duels' && parts[2] && M === 'POST') {
        const pod = own(S.pods, parts[2]) ? S.pods[parts[2]] : null;
        if (pod) { if (body.action !== 'cancel') return json(res, 400, { error: 'unknown action' });
          if (!podOpen(pod)) return json(res, 409, { error: 'That group duel is already over.' });
          pod.status = 'cancelled'; pod.endedAt = now(); pod.cancelledBy = who.by;
          podTell(podIds(pod, 'in', 'out', 'invited'), 'Your ' + podName(pod) + ' was cancelled by the league’s admins. It doesn’t count.', 'Group duel cancelled');
          save('pods'); return json(res, 200, { ok: true }); }
        const d = own(S.duels, parts[2]) ? S.duels[parts[2]] : null; if (!d) return json(res, 404, { error: 'no such duel' });
        if (body.action !== 'cancel') return json(res, 400, { error: 'unknown action' });
        if (!duelOpen(d)) return json(res, 409, { error: 'That duel is already over.' });
        d.status = 'cancelled'; d.answeredAt = now(); d.cancelledBy = who.by;
        for (const id of [d.a, d.b]) { const m = S.members[id]; if (m) notify(m, 'duel', 'Your ' + duelName(d) + ' duel was cancelled by the league’s admins. It doesn’t count.', { title: 'Duel cancelled', url: duelUrl }); }
        save('duels'); return json(res, 200, { ok: true });
      }
      // ---- "traders like you": the peer-group catalog and the seed wallets ----
      if (sub === 'bench' && M === 'GET') {
        const B = benchNow(), seeds = Object.entries(S.benchSeeds).sort((a, b) => (b[1].added || 0) - (a[1].added || 0));
        const optedOut = members().filter(m => !m.banned && m.share && m.share.bench === false).length;
        const imp = B.imp || {}, groups = Object.entries(B.groups).map(([key, g]) => ({ key, dims: g.dims, n: g.n,
          imp: imp[key] && imp[key].panel ? imp[key].n + ' of ' + imp[key].panel + ' followed 8–12 weeks' : '' })).sort((a, b) => b.n - a.n);
        return json(res, 200, { config: S.config.bench, at: B.at, contributors: B.contributors, members: B.members, seeds: B.seeds, split: B.split, min: B.min,
          optedOut, withSummary: members().filter(m => !m.banned && m.share && m.share.bench !== false && m.bench).length, labels: Bench.DIMS, groups,
          improvers: imp.all ? imp.all.changes.map(c => c.text) : [], histFor: Object.keys(S.benchHist).length,
          seedCounts: seedCounts(), seedMax: SEED_MAX, seedReader: !!opts.peerSummaryFor,
          seedDelay, seedList: seeds.slice(0, 1000).map(([a, x]) => ({ address: a, st: x.st, re: !!(x.re && x.st === 'ok'), why: x.why || '', added: x.added || 0, done: x.done || 0, by: x.by || '', style: x.sum ? x.sum.style : null, size: x.sum ? x.sum.size : null, exp: x.sum ? x.sum.exp : null, act: x.sum ? x.sum.act : null, n: x.sum ? x.sum.n : x.n != null ? x.n : null,
            wr: x.sum ? x.sum.wr : null, pf: x.sum ? x.sum.pf : null, pay: x.sum ? x.sum.pay : null, fees: x.sum ? x.sum.fees : null, tw: x.sum ? x.sum.tw : null, hold: x.sum ? x.sum.hold : null,
            disc: x.sum ? x.sum.disc : null, rev: x.sum ? x.sum.rev : null, ret: x.sum ? x.sum.ret : null, dd: x.sum ? x.sum.dd : null, usd: x.usd || null })) });
      }
      if (sub === 'bench' && M === 'POST') {
        const a = body.action;
        if (a === 'rebuild') { benchBuild(); return json(res, 200, { ok: true, at: S.bench.at, contributors: S.bench.contributors }); }
        if (a === 'seed') { // paste anything: every 0x address in it is queued once
          const found = [...new Set(((typeof body.text === 'string' ? body.text : '').slice(0, 400000).match(/0x[0-9a-fA-F]{40}/g) || []).map(x => x.toLowerCase()))];
          let added = 0, dupes = 0, full = 0;
          for (const ad of found) { if (own(S.benchSeeds, ad)) { dupes++; continue; } if (Object.keys(S.benchSeeds).length >= SEED_MAX) { full++; continue; }
            S.benchSeeds[ad] = { st: 'queued', added: now(), by: who.owner ? 'owner' : who.by }; added++; }
          save('benchSeeds'); seedSchedule();
          return json(res, 200, { ok: true, found: found.length, added, dupes, full, counts: seedCounts() });
        }
        if (a === 'retry') { let n = 0; for (const x of Object.values(S.benchSeeds)) if (x.st === 'err' || (body.skipped && x.st === 'skip')) { x.st = 'queued'; n++; } save('benchSeeds'); seedSchedule(); return json(res, 200, { ok: true, requeued: n }); }
        // read wallets again with today's settings and fills: counted ones keep counting until their new read lands
        if (a === 'reread') { const which = body.which || 'all', one = String(body.address || '').toLowerCase(); let n = 0;
          for (const [ad, x] of Object.entries(S.benchSeeds)) {
            if (body.address ? ad !== one : !(which === 'all' || x.st === which)) continue;
            if (x.st === 'ok') { if (!x.re) { x.re = true; n++; } } else if (x.st !== 'queued') { x.st = 'queued'; x.why = ''; n++; } }
          save('benchSeeds'); seedSchedule(); return json(res, 200, { ok: true, requeued: n, counts: seedCounts() }); }
        if (a === 'remove') { const which = body.which; let n = 0;
          for (const [ad, x] of Object.entries(S.benchSeeds)) if (which === 'all' || x.st === which || ad === String(body.address || '').toLowerCase()) { delete S.benchSeeds[ad]; n++; }
          save('benchSeeds'); if (n) benchBuild(); return json(res, 200, { ok: true, removed: n, counts: seedCounts() }); }
        return json(res, 400, { error: 'unknown action' });
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
        // as on a member's page: only the owner moves another admin in or out
        const otherAdmin = id => !who.owner && own(S.members, id) && S.members[id].admin && id !== who.id;
        if ([].concat(body.add || [], body.remove || []).some(otherAdmin)) return json(res, 403, { error: 'Only the owner can change another admin.' });
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
      // trade reviews, read-only: what members sent their mentors and the threads on them, for moderation
      if (sub === 'reviews' && M === 'GET' && !parts[2]) return json(res, 200, { reviews: q('SELECT * FROM reviews ORDER BY last DESC LIMIT 200').all().map(r => reviewOut(r, null)) });
      if (sub === 'reviews' && M === 'GET') { const r = reviewById(parts[2]); return r ? json(res, 200, threadOut(r, null, 'admin')) : json(res, 404, { error: 'no such review' }); }
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
      if (claimedBy(address) || mappedTo(address)) address = null; // someone proved that wallet is theirs, or the owner mapped it to someone: joining still works, without it
      const key = crypto.randomBytes(24).toString('hex'), id = crypto.randomBytes(6).toString('hex');
      const m = { id, handle, keyHash: sha(key), createdAt: now(), lastSeen: now(), tier: 0, share: sanitizeShare(body.share),
        address, stats: null, weekXp: {}, money: null, banned: false, joinedWith: S.config.inviteCode ? 'invite' : 'open' };
      S.members[id] = m; S.follows[id] = []; reindex();
      const skip = new Set(Array.isArray(body.skip) ? body.skip.map(String) : []); // rankings the new member chose not to join
      for (const L of Object.values(S.leagues)) if (L.autoJoin && !skip.has(L.id)) joinLeague(L, m);
      recent.push(now()); joinTimes.set(ip, recent);
      if (body.visitor === true) bumpVisit('conv', utcDayKey(now()));
      if (joinTimes.size > 1000) for (const [k, v] of joinTimes) if (!v.length || now() - v[v.length - 1] > 3600000) joinTimes.delete(k); // addresses an hour quiet
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
        if (!o) return json(res, 400, { error: 'Open Daruma at ' + origins[0].origin + '/daruma to sign with your wallet.' });
        host = o.host; uri = o.origin; }
      else { // not pinned (local or self-hosted without PUBLIC_ORIGIN): the address this page was served from
        host = reqHost.slice(0, 100).replace(/[^a-z0-9.:\-\[\]]/g, '') || 'pulse';
        uri = (String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https' || (req.socket && req.socket.encrypted) ? 'https' : 'http') + '://' + host; }
      const nonce = crypto.randomBytes(8).toString('hex');
      const statement = head === 'claim' ? 'Claim this wallet for @' + who.handle + ' on Daruma. This is a signature, not a transaction: it costs nothing and moves no funds.'
        : 'Sign in to Daruma with this wallet. This is a signature, not a transaction: it costs nothing and moves no funds.';
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
        for (const o of members()) if (o.id !== me.id && linkedOf(o).includes(p.address)) o.wallets = linkedOf(o).filter(x => x !== p.address); // a mapping by hand gives way too
        me.wallets = linkedOf(me).filter(x => x !== p.address); // it's their main wallet now
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
    // ---------- passkeys: sign in ----------
    // The RP ID is the site's hostname: pinned by PUBLIC_ORIGIN when set (a passkey made for one
    // site never works on another), else the address this page was served from.
    if (head === 'passkey' && parts[1] === 'login' && M === 'POST') {
      if (!adminConfigured) return json(res, 403, { error: 'The owner needs to set an access token on the server first.' });
      if (limited(req, 'passkey', 30, 600000)) return json(res, 429, { error: 'Too many sign-in attempts from here. Try again in a few minutes.' });
      const site = siteOf(req); if (site.error) return json(res, 400, { error: site.error });
      if (parts[2] === 'start') {
        const challenge = WebAuthn.newChallenge(); sweep(pending);
        pending.set('pk:' + challenge, { purpose: 'pk-login', site, exp: now() + 5 * 60000 });
        return json(res, 200, { challenge, rpId: site.rpId, timeout: 300000, userVerification: 'preferred' });
      }
      if (parts[2] === 'finish') {
        const cred = body.credential; let cd = null;
        try { cd = JSON.parse(WebAuthn.fromB64u(cred && cred.response && cred.response.clientDataJSON).toString('utf8')); } catch (e) {}
        const p = cd && typeof cd.challenge === 'string' ? pending.get('pk:' + cd.challenge) : null;
        if (!p || p.purpose !== 'pk-login' || p.exp < now()) return json(res, 400, { error: 'That sign-in request expired. Try again.' });
        pending.delete('pk:' + cd.challenge);
        const id = cred && typeof cred.id === 'string' ? cred.id : '';
        const m = id && members().find(x => (x.passkeys || []).some(k => k.id === id));
        if (!m) return json(res, 404, { error: 'This passkey isn’t linked to a profile here. Sign in another way, then add it under Account.' });
        if (m.banned) return json(res, 403, { error: 'This profile was removed from the league.' });
        const pk = m.passkeys.find(k => k.id === id);
        try { const r = WebAuthn.verifyAssertion(cred, { challenge: cd.challenge, origin: p.site.origin, rpId: p.site.rpId }, pk); pk.signCount = r.signCount; }
        catch (e) { return json(res, 403, { error: 'That passkey didn’t check out (' + e.message + ').' }); }
        pk.lastUsed = now();
        const key = addKey(m); m.lastSeen = now(); save();
        return json(res, 200, { key, me: publicMember(m, m), share: m.share });
      }
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

    // ---------- "traders like you": the groups a trader with these dimensions belongs to ----------
    // members and the owner; only group deciles go out, never anyone's own numbers
    if (head === 'bench' && M === 'GET' && !parts[1]) {
      const bm = byKey(req), owner = !!req.headers['authorization'] && authOk(req);
      if (!owner && (!bm || bm.banned)) return json(res, 401, { error: 'not a member' });
      if (!S.config.bench.on) return json(res, 200, { on: false });
      if (!owner && lockedFor(bm, 'peers')) return json(res, 403, { error: 'Traders like you unlocks at level ' + lockedFor(bm, 'peers') + '.' });
      const dims = {}; for (const k of Bench.DIM_KEYS) if (typeof query[k] === 'string' && own(Bench.DIMS[k], query[k])) dims[k] = query[k];
      return json(res, 200, Object.assign(benchOut(benchNow(), dims), bm ? { mine: { share: bm.share.bench !== false, have: !!bm.bench, at: bm.bench ? bm.bench.at : null } } : {}));
    }

    // ---------- everything below needs a member key ----------
    const me = byKey(req);
    if (!me) return json(res, 401, { error: 'not a member' });
    if (me.banned) return json(res, 403, { error: 'This profile was removed from the league.' });

    // ---------- passkeys: add one on this device, list, remove ----------
    if (head === 'passkey' && parts[1] === 'register' && M === 'POST') {
      const site = siteOf(req); if (site.error) return json(res, 400, { error: site.error });
      if (parts[2] === 'start') {
        if ((me.passkeys || []).length >= PASSKEY_MAX) return json(res, 409, { error: 'You have ' + PASSKEY_MAX + ' passkeys already. Remove one first.' });
        const challenge = WebAuthn.newChallenge(); sweep(pending);
        pending.set('pk:' + challenge, { purpose: 'pk-reg', memberId: me.id, site, exp: now() + 5 * 60000 });
        return json(res, 200, { challenge, rp: { name: 'Daruma', id: site.rpId }, user: { id: WebAuthn.b64u(Buffer.from('pulse:' + me.id)), name: me.handle, displayName: '@' + me.handle },
          pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -8 }, { type: 'public-key', alg: -257 }],
          authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'preferred' }, attestation: 'none', timeout: 300000,
          excludeCredentials: (me.passkeys || []).map(k => ({ type: 'public-key', id: k.id })) });
      }
      if (parts[2] === 'finish') {
        const cred = body.credential; let cd = null;
        try { cd = JSON.parse(WebAuthn.fromB64u(cred && cred.response && cred.response.clientDataJSON).toString('utf8')); } catch (e) {}
        const p = cd && typeof cd.challenge === 'string' ? pending.get('pk:' + cd.challenge) : null;
        if (!p || p.purpose !== 'pk-reg' || p.memberId !== me.id || p.exp < now()) return json(res, 400, { error: 'That request expired. Try again.' });
        pending.delete('pk:' + cd.challenge);
        let r; try { r = WebAuthn.verifyRegistration(cred, { challenge: cd.challenge, origin: p.site.origin, rpId: p.site.rpId }); }
        catch (e) { return json(res, 400, { error: 'That passkey couldn’t be added (' + e.message + ').' }); }
        if (members().some(x => (x.passkeys || []).some(k => k.id === r.id))) return json(res, 409, { error: 'That passkey is already linked to a profile.' });
        me.passkeys = [...(me.passkeys || []), { id: r.id, alg: r.alg, jwk: r.jwk, signCount: r.signCount, rpId: p.site.rpId, name: cleanText(body.name, 40) || 'Passkey', at: now(), lastUsed: null }].slice(-PASSKEY_MAX);
        save(); return json(res, 200, { me: publicMember(me, me) });
      }
    }
    if (head === 'passkey' && parts[1] && parts[1] !== 'register' && parts[1] !== 'login' && M === 'DELETE') {
      const before = (me.passkeys || []).length;
      me.passkeys = (me.passkeys || []).filter(k => k.id !== parts[1]);
      if (me.passkeys.length === before) return json(res, 404, { error: 'No such passkey.' });
      save(); return json(res, 200, { me: publicMember(me, me) });
    }
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
      if (body.subscription !== undefined) { const sub = Push.sanitizeSubscription(body.subscription); if (!sub) return json(res, 400, { error: 'This browser’s push service isn’t one Daruma can send to.' });
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
      const n = await sendPush(me, { title: 'Daruma', body: 'Reminders are on. You’ll hear from Daruma at the times you picked.', tag: 'pulse-test', url: '/daruma#today' });
      return json(res, n ? 200 : 502, n ? { ok: true, sent: n } : { error: 'Your browser’s push service didn’t accept the message.' });
    }

    // ---- accountability partners ----
    // ---- group duels ("pods"): set one up, answer an invitation, leave, call it off ----
    if (head === 'pods' && !parts[1] && M === 'POST') {
      duelSweep(); // expired invitations stop counting toward the limit
      if (lockedFor(me, 'duels')) return json(res, 403, { error: 'Duels unlock at level ' + lockedFor(me, 'duels') + '.' });
      if (standingLock(me, 'Duels')) return json(res, 403, { error: standingLock(me, 'Duels'), standing: true });
      const cfg = S.config.duels;
      if (!cfg.on) return json(res, 409, { error: 'Duels are switched off in this league.' });
      if (!cfg.pods) return json(res, 409, { error: 'Group duels are switched off in this league.' });
      const t = Duels.sanitizePodTerms(body, cfg); if (t.error) return json(res, 400, { error: t.error });
      const verOk = x => !!(x.share && x.share.verify && x.address);
      if (openCount(me) >= cfg.maxOpen) return json(res, 409, { error: 'You have ' + cfg.maxOpen + ' duels going already. Finish one first.' });
      if (t.verified && !verOk(me)) return json(res, 409, { error: 'You need “Verify my discipline” switched on for a verified duel. Turn verification off for this one, or pick another kind.' });
      const hs = (Array.isArray(body.to) ? body.to : []).slice(0, 12).map(h => cleanText(h, 30).replace(/^@/, '')).filter(Boolean), os = [];
      for (const h of hs) { const o = byHandle(h);
        if (!o || o.banned) return json(res, 404, { error: 'There’s no member called @' + h + '.' });
        if (o.id === me.id || os.includes(o)) continue;
        if (o.share.duels === false) return json(res, 409, { error: '@' + o.handle + ' isn’t taking challenges.' });
        if (openCount(o) >= cfg.maxOpen) return json(res, 409, { error: '@' + o.handle + ' has ' + cfg.maxOpen + ' duels going already.' });
        if (t.verified && !verOk(o)) return json(res, 409, { error: '@' + o.handle + ' needs “Verify my discipline” switched on for a verified duel. Turn verification off for this one, or pick another kind.' });
        os.push(o); }
      if (os.length < 2) return json(res, 400, { error: 'Invite at least 2 people.' });
      if (os.length + 1 > cfg.podMax) return json(res, 400, { error: 'A group duel here has at most ' + cfg.podMax + ' people, you included.' });
      if (dayLimit(me, 'duelLog', cfg.perDay)) return json(res, 429, { error: 'That’s ' + cfg.perDay + ' challenges today. Try again tomorrow.' });
      const id = crypto.randomBytes(6).toString('hex'), mem = { [me.id]: { st: 'in', at: now() } };
      for (const o of os) mem[o.id] = { st: 'invited', at: now() };
      S.pods[id] = Object.assign({ id, by: me.id, mem, status: 'pending', at: now(), exp: now() + DUEL_TTL, w: { [me.id]: me.address || null } }, t);
      for (const o of os) notify(o, 'duel', '@' + me.handle + ' invited you to a ' + podName(t) + ' (' + (t.period === 'month' ? 'a month' : 'a week') + ') with '
        + os.filter(x => x !== o).map(x => '@' + x.handle).join(', ') + (t.msg ? ': “' + t.msg + '”' : '.') + ' Answer within 48 hours.', { title: 'Group duel invite', url: duelUrl });
      save('pods', me, ...os);
      return json(res, 200, { ok: true, pod: podView(S.pods[id], me) });
    }
    if (head === 'pods' && parts[1] && !parts[2] && M === 'POST') {
      duelSweep();
      const p = own(S.pods, parts[1]) ? S.pods[parts[1]] : null;
      if (!p || !own(p.mem, me.id)) return json(res, 404, { error: 'There’s no such group duel.' });
      const x = p.mem[me.id], a = body.action, others = Object.keys(p.mem).filter(id => id !== me.id).map(id => S.members[id]).filter(Boolean);
      if (a === 'accept' || a === 'decline') {
        if (x.st !== 'invited') return json(res, 409, { error: x.st === 'expired' ? 'That invitation expired.' : 'That invitation isn’t waiting for an answer.' });
        if (!podOpen(p)) return json(res, 409, { error: 'That group duel isn’t on any more.' });
        if (a === 'decline') { x.st = 'declined'; x.at = now(); }
        else {
          const cfg = S.config.duels;
          if (lockedFor(me, 'duels')) return json(res, 403, { error: 'Duels unlock at level ' + lockedFor(me, 'duels') + '.' });
          if (standingLock(me, 'Duels')) return json(res, 403, { error: standingLock(me, 'Duels'), standing: true });
          if (!cfg.on || !cfg.pods) return json(res, 409, { error: 'Group duels are switched off in this league.' });
          if (openCount(me) - 1 >= cfg.maxOpen) return json(res, 409, { error: 'You have ' + cfg.maxOpen + ' duels going already. Finish one first.' });
          if (p.verified && !(me.share.verify && me.address)) return json(res, 409, { error: 'You need “Verify my discipline” switched on for this verified duel.' });
          x.st = 'in'; x.at = now(); p.w = Object.assign({}, p.w, { [me.id]: me.address || null });
          // three in: the dates are fixed — the next Monday, or the 1st
          if (p.status === 'pending' && podIds(p, 'in').length >= 3) {
            Object.assign(p, Duels.windowFor(p.period, now()), { status: 'active', lead: null });
            const dates = duelDates(p);
            podTell(podIds(p, 'in'), 'Your ' + podName(p) + ' is on, with ' + podIds(p, 'in').map(id => '@' + S.members[id].handle).join(', ') + '. It runs ' + dates + '.', 'Group duel on');
          }
        }
      } else if (a === 'cancel') { // the one who set it up calls it off before it starts
        if (p.by !== me.id) return json(res, 409, { error: 'Only the person who set it up can call it off. You can leave it instead.' });
        if (!podOpen(p) || podStarted(p)) return json(res, 409, { error: 'It has started already: leave it instead.' });
        p.status = 'cancelled'; p.endedAt = now();
        podTell(podIds(p, 'in', 'invited').filter(id => id !== me.id), '@' + me.handle + ' called off the ' + podName(p) + '. It doesn’t count.', 'Group duel called off');
      } else if (a === 'leave') {
        if (x.st !== 'in' || !podOpen(p)) return json(res, 409, { error: 'You’re not in this group duel.' });
        if (p.by === me.id && !podStarted(p)) return json(res, 409, { error: 'You set it up: call it off instead.' });
        x.at = now();
        if (podStarted(p)) x.st = 'out'; // a forfeit: you're out, and placed last
        else { x.st = 'left'; podShort(p); } // before the start nothing counts
      } else return json(res, 400, { error: 'unknown action' });
      save('pods', me, ...others);
      return json(res, 200, { ok: true, pod: podView(p, me) });
    }
    // ---- duels: challenge, answer, counter, cancel, forfeit ----
    if (head === 'duels' && M === 'GET' && !parts[1]) {
      duelSweep();
      const cfg = S.config.duels, list = Object.values(S.duels).filter(d => d.a === me.id || d.b === me.id)
        .sort((x, y) => (duelOpen(y) - duelOpen(x)) || ((y.result ? y.result.at : y.at) - (x.result ? x.result.at : x.at))).slice(0, 40);
      // people to pick from: who you follow, your partners, the members of your leagues (anyone else by name)
      const people = new Map(), add = (m, rel) => { if (m && !m.banned && m.id !== me.id && !people.has(m.id)) people.set(m.id, { handle: m.handle, av: avUrl(m), level: (m.stats && m.stats.level) || 1, rel, accepting: m.share.duels !== false }); };
      for (const p of pairsOf(me)) if (p.status === 'active') add(otherIn(p, me), 'partner');
      for (const id of S.follows[me.id] || []) add(S.members[id], 'following');
      for (const L of leaguesOf(me)) for (const id of Object.keys(L.members)) { if (people.size >= 60) break; add(S.members[id], L.name); }
      const pods = Object.values(S.pods).filter(p => own(p.mem, me.id) && p.mem[me.id].st !== 'declined')
        .sort((x, y) => (podOpen(y) - podOpen(x)) || (((y.result && y.result.at) || y.at) - ((x.result && x.result.at) || x.at))).slice(0, 20);
      return json(res, 200, { on: cfg.on, xp: cfg.xp, maxOpen: cfg.maxOpen, open: openCount(me), accepting: me.share.duels !== false, record: Object.assign({ w: 0, l: 0, d: 0 }, me.duelRec),
        ladder: cfg.ladder ? ladderOut(me) : { on: false }, podOn: !!cfg.pods, podMax: cfg.podMax, podRec: Object.assign({ w: 0, n: 0 }, me.podRec), pods: pods.map(p => podView(p, me)),
        podTypes: Duels.POD_TYPES.filter(k => cfg.types[k]).map(k => ({ type: k, label: Duels.TYPES[k].label, rule: Duels.POD_RULES[k], verifiedDefault: !!Duels.TYPES[k].verifiedDefault })),
        stakes: !!cfg.stakes, maxStake: cfg.maxStake, stakePct: cfg.stakePct, room: stakeRoomOf(me), people: [...people.values()],
        types: Object.keys(Duels.TYPES).filter(k => cfg.types[k]).map(k => ({ type: k, label: Duels.TYPES[k].label, rule: Duels.TYPES[k].rule, verifiedDefault: !!Duels.TYPES[k].verifiedDefault })),
        weekPreview: Duels.windowFor('week', now()), monthPreview: Duels.windowFor('month', now()), duels: list.map(d => duelView(d, me)) });
    }
    // before challenging someone: can I, and how have we done against each other
    if (head === 'duels' && parts[1] === 'with' && parts[2] && M === 'GET') {
      let h = parts[2]; try { h = decodeURIComponent(h); } catch (e) {}
      const o = byHandle(String(h).replace(/^@/, '')); if (!o || o.banned) return json(res, 404, { error: 'There’s no such member.' });
      const h2h = { w: 0, l: 0, d: 0 };
      for (const d of Object.values(S.duels)) if (d.status === 'done' && ((d.a === me.id && d.b === o.id) || (d.a === o.id && d.b === me.id))) {
        const r = d.result || {}; if (!r.winner) h2h.d++; else if (r.winner === me.id) h2h.w++; else h2h.l++; }
      const st = o.stats || {}, d30 = disciplineOver(o.share.verify && Array.isArray(o.vdays) ? o.vdays : st.days, addDaysKey(todayKey(), -6), todayKey(), 1);
      const busy = Object.values(S.duels).some(d => duelOpen(d) && ((d.a === me.id && d.b === o.id) || (d.a === o.id && d.b === me.id)));
      return json(res, 200, { other: { handle: o.handle, av: avUrl(o), level: st.level || 1, verified: !!(o.share.verify && o.address), ret: !!(o.share.ret && walletFor(o)), week: d30.avg == null || !o.share.profile ? null : Math.round(d30.avg) }, // a private profile keeps its Discipline to itself
        room: o.share.profile ? stakeRoomOf(o) : null, // a private profile doesn't hint at its XP
        h2h, accepting: o.share.duels !== false && o.id !== me.id, busy, me: { room: stakeRoomOf(me), verified: !!(me.share.verify && me.address), ret: !!(me.share.ret && walletFor(me)) } });
    }
    if (head === 'duels' && !parts[1] && M === 'POST') {
      duelSweep(); // expired challenges stop counting toward the limit
      if (lockedFor(me, 'duels')) return json(res, 403, { error: 'Duels unlock at level ' + lockedFor(me, 'duels') + '.' });
      if (standingLock(me, 'Duels')) return json(res, 403, { error: standingLock(me, 'Duels'), standing: true });
      const t = Duels.sanitizeTerms(body, S.config.duels); if (t.error) return json(res, 400, { error: t.error });
      const o = byHandle(cleanText(body.to, 30).replace(/^@/, ''));
      const bad = duelProblem(me, o, t); if (bad) return json(res, 409, { error: bad });
      if (Object.values(S.duels).some(d => duelOpen(d) && ((d.a === me.id && d.b === o.id) || (d.a === o.id && d.b === me.id)))) return json(res, 409, { error: 'You already have a duel with @' + o.handle + '.' });
      if (Object.values(S.duels).some(d => d.status === 'declined' && d.a === me.id && d.b === o.id && now() - (d.answeredAt || 0) < 7 * 86400000)) return json(res, 409, { error: '@' + o.handle + ' declined a challenge from you this week. Try again later.' });
      if (dayLimit(me, 'duelLog', S.config.duels.perDay)) return json(res, 429, { error: 'That’s ' + S.config.duels.perDay + ' challenges today. Try again tomorrow.' });
      const id = crypto.randomBytes(6).toString('hex');
      S.duels[id] = Object.assign({ id, a: me.id, b: o.id, status: 'pending', awaiting: o.id, at: now(), exp: now() + DUEL_TTL }, t);
      notify(o, 'duel', '@' + me.handle + ' challenged you to a ' + Duels.TYPES[t.type].label + ' duel (' + (t.period === 'month' ? 'a month' : 'a week') + (t.stake ? ', ' + t.stake + ' XP each at stake' : '') + ')' + (t.msg ? ': “' + t.msg + '”' : '.'), { title: 'New challenge', url: duelUrl });
      save('duels', me, o);
      return json(res, 200, { ok: true, duel: duelView(S.duels[id], me) });
    }
    if (head === 'duels' && parts[1] && !parts[2] && M === 'POST') {
      duelSweep();
      const d = own(S.duels, parts[1]) ? S.duels[parts[1]] : null;
      if (!d || (d.a !== me.id && d.b !== me.id)) return json(res, 404, { error: 'There’s no such duel.' });
      const o = S.members[d.a === me.id ? d.b : d.a], a = body.action;
      if (a === 'accept' || a === 'decline' || a === 'counter') {
        if (a !== 'decline' && lockedFor(me, 'duels')) return json(res, 403, { error: 'Duels unlock at level ' + lockedFor(me, 'duels') + '.' });
        if (a !== 'decline' && standingLock(me, 'Duels')) return json(res, 403, { error: standingLock(me, 'Duels'), standing: true });
        if (d.status !== 'pending') return json(res, 409, { error: d.status === 'expired' ? 'That challenge expired.' : 'That challenge isn’t waiting for an answer.' });
        if (d.awaiting !== me.id) return json(res, 409, { error: 'It’s @' + (o ? o.handle : '') + '’s turn to answer.' });
        if (a === 'decline') { d.status = 'declined'; d.answeredAt = now(); d.awaiting = null;
          if (o) notify(o, 'duel', '@' + me.handle + ' declined your ' + duelName(d) + ' challenge.', { title: 'Challenge declined', url: duelUrl }); }
        else if (a === 'accept') {
          const bad = duelProblem(me, o, d, true); if (bad) return json(res, 409, { error: bad });
          const others = openCount(me) - 1, theirs = o ? openCount(o) - 1 : 0; // this duel is one of them
          if (others >= S.config.duels.maxOpen) return json(res, 409, { error: 'You have ' + S.config.duels.maxOpen + ' duels going already. Finish one first.' });
          if (theirs >= S.config.duels.maxOpen) return json(res, 409, { error: '@' + o.handle + ' has ' + S.config.duels.maxOpen + ' duels going already.' });
          Object.assign(d, Duels.windowFor(d.period, now()), { status: 'active', awaiting: null, answeredAt: now(), lead: null,
            w: { a: (S.members[d.a] && S.members[d.a].address) || null, b: (S.members[d.b] && S.members[d.b].address) || null } });
          if (o) notify(o, 'duel', '@' + me.handle + ' accepted your ' + duelName(d) + ' duel. It runs ' + duelDates(d) + '.', { title: 'Challenge accepted', url: duelUrl });
        } else { // suggest different terms: it goes back to them
          const t = Duels.sanitizeTerms(body, S.config.duels); if (t.error) return json(res, 400, { error: t.error });
          const bad = duelProblem(me, o, t, true, d); if (bad) return json(res, 409, { error: bad });
          Object.assign(d, t, { awaiting: o.id, exp: now() + DUEL_TTL, countered: true });
          notify(o, 'duel', '@' + me.handle + ' suggested different terms: a ' + Duels.TYPES[t.type].label + ' duel (' + (t.period === 'month' ? 'a month' : 'a week') + (t.stake ? ', ' + t.stake + ' XP each at stake' : '') + ').', { title: 'Challenge: new terms', url: duelUrl });
        }
      } else if (a === 'cancel') {
        if (d.status !== 'pending' || d.awaiting === me.id) return json(res, 409, { error: 'Only a challenge waiting on the other side can be withdrawn.' });
        d.status = 'cancelled'; d.answeredAt = now();
      } else if (a === 'forfeit') {
        if (d.status !== 'active') return json(res, 409, { error: 'That duel isn’t running.' });
        if (d.start > todayKey()) { // backing out before it starts: nothing was played, so nothing counts
          d.status = 'cancelled'; d.answeredAt = now(); d.backedOut = me.id;
          if (o) notify(o, 'duel', '@' + me.handle + ' backed out of your ' + duelName(d) + ' duel before it started. It doesn’t count.', { title: 'Duel called off', url: duelUrl });
        } else duelSettle(d, me.id);
      } else return json(res, 400, { error: 'unknown action' });
      save('duels', me, ...(o ? [o] : []));
      return json(res, 200, { ok: true, duel: duelView(d, me) });
    }
    // ---- people: find members to duel, partner with or learn from, without sharing a league ----
    // Lists members whose profile is public (and every mentor, whose role is to be found): name,
    // picture, level, bio and trading style, and what they're open to. Never trades, P&L or wallets.
    if (head === 'people' && !parts[1] && M === 'GET') {
      const q = cleanText(query.q, 40).replace(/^@/, '').toLowerCase(), f = ['duels', 'partner', 'mentor'].includes(query.f) ? query.f : '';
      const duelsOn = !!S.config.duels.on, week = 7 * 86400000;
      const pairWith = o => pairsOf(me).find(p => p.a === o.id || p.b === o.id);
      let list = members().filter(o => o.id !== me.id && !o.banned && (o.mentor || (o.share && o.share.profile !== false)));
      if (f === 'duels') list = list.filter(o => duelsOn && o.share.duels !== false);
      if (f === 'partner') list = list.filter(o => o.share.seek);
      if (f === 'mentor') list = list.filter(o => o.mentor);
      if (q) list = list.filter(o => o.handle.toLowerCase().includes(q) || (o.share.profile !== false && (o.bio || '').toLowerCase().includes(q)));
      const total = list.length, page = Math.max(0, Math.min(200, parseInt(query.page, 10) || 0)), size = 30;
      list.sort((a, b) => (q ? (+b.handle.toLowerCase().startsWith(q)) - (+a.handle.toLowerCase().startsWith(q)) : 0) || ((b.lastSeen || 0) - (a.lastSeen || 0)));
      const mine = new Set(leaguesOf(me).map(L => L.id));
      return json(res, 200, { total, page, more: total > (page + 1) * size, people: list.slice(page * size, (page + 1) * size).map(o => {
        const pub = o.share.profile !== false, pr = pairWith(o), st = o.stats || {};
        return { handle: o.handle, av: avUrl(o), level: st.level || 1, title: levelTitle(st.level || 1), bio: pub ? o.bio || '' : '',
          style: pub && o.share.bench !== false && o.bench && o.bench.style ? o.bench.style : null,
          active: (o.lastSeen || 0) > now() - week, duels: duelsOn && o.share.duels !== false, seeking: !!o.share.seek, mentor: !!o.mentor,
          following: (S.follows[me.id] || []).includes(o.id), partner: pr ? (pr.status === 'active' ? 'active' : pr.from === me.id ? 'sent' : 'asked') : null,
          leagues: leaguesOf(o).filter(L => mine.has(L.id)).map(L => L.name).slice(0, 3),
          askedMentor: !!(o.mentor && me.mentorAsks && me.mentorAsks[o.id]) }; }) });
    }
    // ask a particular mentor to look at your trading: it lets mentors in (they see your days, never your
    // wallet) when the member says so, tells that mentor, and puts you first on their list
    if (head === 'people' && parts[1] && parts[2] === 'mentor' && M === 'POST') {
      const o = byHandle(arg); if (!o || o.banned || !o.mentor || o.id === me.id) return json(res, 404, { error: 'No mentor by that name.' });
      if (!me.share.mentor) { if (body.letIn !== true) return json(res, 409, { error: 'Let mentors see your days first (Profile & privacy).', needsLetIn: true });
        me.share = sanitizeShare({ mentor: true }, me.share); }
      const last = me.mentorAsks && me.mentorAsks[o.id];
      if (last && now() - last < 86400000) return json(res, 429, { error: 'You asked @' + o.handle + ' today already.' });
      if (limited(req, 'mask:' + me.id, 10, 86400000, true)) return json(res, 429, { error: 'Too many requests today.' });
      me.mentorAsks = Object.assign({}, me.mentorAsks, { [o.id]: now() });
      notify(o, 'mentor', '@' + me.handle + ' would like you to mentor them. Their days are open to you now.', { title: 'A mentoring request', url: '/daruma#mentee/' + me.handle });
      save(me); return json(res, 200, { ok: true, share: me.share });
    }
    if (head === 'partners' && M === 'GET' && !parts[1]) return json(res, 200, { partners: pairsOf(me).map(p => pairOut(p, me)).filter(Boolean) });
    if (head === 'partners' && !parts[1] && M === 'POST') {
      const o = byHandle(cleanText(body.handle, 21).replace(/^@/, ''));
      if (!o || o.banned || o.id === me.id) return json(res, 404, { error: 'No member by that name.' });
      const ex = pairsOf(me).find(p => p.a === o.id || p.b === o.id);
      if (ex && ex.status === 'active') return json(res, 409, { error: 'You’re already partners.' });
      if (ex && ex.from === o.id) { // they asked first: this accepts
        if (pairsOf(me).filter(p => p.status === 'active').length >= PARTNER_MAX) return json(res, 409, { error: 'You already have ' + PARTNER_MAX + ' partners.' });
        if (pairsOf(o).filter(p => p.status === 'active').length >= PARTNER_MAX) return json(res, 409, { error: '@' + o.handle + ' already has ' + PARTNER_MAX + ' partners.' });
        ex.status = 'active'; ex.since = now(); notify(o, 'partner', '@' + me.handle + ' is now your accountability partner.', { title: 'New partner', url: '/daruma#social' }); save('partners');
        return json(res, 200, { partner: pairOut(ex, me) }); }
      if (ex) return json(res, 409, { error: 'You’ve asked already — waiting for @' + o.handle + '.' });
      if (pairsOf(me).filter(p => p.status === 'active').length >= PARTNER_MAX) return json(res, 409, { error: 'You already have ' + PARTNER_MAX + ' partners.' });
      if (pairsOf(me).filter(p => p.status !== 'active' && p.from === me.id).length >= 5) return json(res, 409, { error: 'Five open requests is the limit.' });
      if (limited(req, 'partner:' + me.id, 20, 86400000, true)) return json(res, 429, { error: 'Too many requests today.' });
      const id = crypto.randomBytes(6).toString('hex');
      S.partners[id] = { id, a: me.id, b: o.id, from: me.id, status: 'pending', at: now(), nudged: {} };
      notify(o, 'partner', '@' + me.handle + ' wants to be accountability partners: you’d see each other’s streak, scores and slips.', { title: 'Partner request', url: '/daruma#social' });
      save('partners'); return json(res, 200, { partner: pairOut(S.partners[id], me) });
    }
    if (head === 'partners' && parts[1]) {
      const p = pairOf(me, arg); if (!p) return json(res, 404, { error: 'No such partnership.' });
      const o = otherIn(p, me);
      if (parts[2] === 'accept' && M === 'POST') { if (p.status === 'active') return json(res, 200, { partner: pairOut(p, me) });
        if (p.from === me.id) return json(res, 409, { error: 'Waiting for @' + (o ? o.handle : '') + ' to accept.' });
        if (pairsOf(me).filter(x => x.status === 'active').length >= PARTNER_MAX) return json(res, 409, { error: 'You already have ' + PARTNER_MAX + ' partners.' });
        if (o && pairsOf(o).filter(x => x.status === 'active').length >= PARTNER_MAX) return json(res, 409, { error: '@' + o.handle + ' already has ' + PARTNER_MAX + ' partners.' });
        p.status = 'active'; p.since = now(); if (o) notify(o, 'partner', '@' + me.handle + ' accepted — you’re accountability partners.', { title: 'New partner', url: '/daruma#social' });
        save('partners'); return json(res, 200, { partner: pairOut(p, me) }); }
      if (!parts[2] && M === 'DELETE') { delete S.partners[p.id]; save('partners'); return json(res, 200, { ok: true }); }
      if (p.status !== 'active') return json(res, 409, { error: 'Not partners yet.' });
      if (parts[2] === 'nudge' && M === 'POST') {
        p.nudged = p.nudged || {}; if (p.nudged[me.id] && now() - p.nudged[me.id] < 6 * 3600000) return json(res, 429, { error: 'One nudge every six hours.' });
        p.nudged[me.id] = now(); const text = cleanText(body.text, 140) || 'Stick to your plan today.';
        notify(o, 'partner', '@' + me.handle + ': ' + text, { title: 'Nudge from @' + me.handle, url: '/daruma#today', from: me.handle });
        save('partners'); return json(res, 200, { ok: true }); }
      if (parts[2] === 'challenge' && M === 'PUT') {
        const text = cleanText(body.text, 140); if (!text) return json(res, 400, { error: 'What’s the challenge?' });
        if (p.challenge && p.challenge.week === S.league.week && now() - p.challenge.at < 3600000) return json(res, 429, { error: 'One change an hour.' });
        p.challenge = { text, by: me.id, week: S.league.week, at: now() };
        notify(o, 'partner', '@' + me.handle + ' set this week’s shared challenge: ' + text, { title: 'Shared challenge', url: '/daruma#social' });
        save('partners'); return json(res, 200, { partner: pairOut(p, me) }); }
      return json(res, 404, { error: 'not found' });
    }

    // ---- mentors: notes on the days of members who let mentors in ----
    if (head === 'notes' && M === 'GET') return json(res, 200, { notes: commentsFor(me.id).slice().reverse().map(commentOut), mentorsOn: !!me.share.mentor });
    if (head === 'notes' && parts[1] === 'read' && M === 'POST') { for (const c of commentsFor(me.id)) c.read = true; save('comments'); return json(res, 200, { ok: true }); }
    if (head === 'mentor') {
      if (!me.mentor) return json(res, 403, { error: 'Only mentors the owner appointed can see this.' });
      if (!parts[1] && M === 'GET') return json(res, 200, { mentees: menteesOf(me).map(o => Object.assign(menteeSummary(o), { asked: !!(o.mentorAsks && o.mentorAsks[me.id]) }))
        .sort((a, b) => (b.asked - a.asked) || ((b.seen || 0) - (a.seen || 0))) });
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
        notify(o, 'mentor', '@' + me.handle + ': ' + text, { title: 'A note from your mentor', url: '/daruma#today', day });
        mentorWorked(me, o); const xp = mentorPay(me, o, 'note', 'n:' + o.id + ':' + mxDay(me));
        save('comments', me); return json(res, 200, { note: commentOut(c), xp }); }
      if (parts[2] === 'notes' && parts[3] && M === 'DELETE') {
        S.comments[o.id] = commentsFor(o.id).filter(c => !(c.id === parts[3] && c.by === me.id)); save('comments'); return json(res, 200, { ok: true }); }
      return json(res, 404, { error: 'not found' });
    }
    // ---- trade reviews: send a trade to your mentors; they comment and mark it reviewed ----
    if (head === 'reviews' && !parts[1] && M === 'GET') {
      const ids = me.mentor ? members().filter(o => o.id !== me.id && !o.banned && o.share.mentor).map(o => o.id) : [];
      return json(res, 200, { mine: q('SELECT * FROM reviews WHERE member = ? ORDER BY last DESC LIMIT 100').all(me.id).map(r => reviewOut(r, me)),
        toReview: me.mentor ? q('SELECT * FROM reviews WHERE member IN (SELECT value FROM json_each(?)) ORDER BY last DESC LIMIT 200').all(JSON.stringify(ids)).map(r => reviewOut(r, me)) : null,
        mentorsOn: !!me.share.mentor, mentors: mentorsOf(me).length }); }
    if (head === 'reviews' && !parts[1] && M === 'POST') {
      if (!me.share.mentor) return json(res, 403, { error: 'Switch on “Let mentors see my days” under What you share first.' });
      const to = mentorsOf(me); if (!to.length) return json(res, 409, { error: 'There are no mentors on this server yet.' });
      const key = typeof body.key === 'string' && /^[a-z0-9]{6,32}$/.test(body.key) ? body.key : null, tr = sanitizeReviewTrade(body.trade, { usd: !!me.share.usd });
      if (!key || !tr) return json(res, 400, { error: 'That trade can’t be sent: it needs its market, side and open time.' });
      const text = cleanPost(body.text, 1000), ex = q('SELECT * FROM reviews WHERE member = ? AND trade = ?').get(me.id, key);
      if (text && limited(req, 'rcomment:' + me.id, 60, 3600000, true)) return json(res, 429, { error: 'That’s a lot of comments this hour.' });
      if (!ex && dayLimit(me, 'reviewLog', REVIEWS_PER_DAY)) return json(res, 429, { error: REVIEWS_PER_DAY + ' trades a day can go to review.' });
      const id = ex ? ex.id : crypto.randomBytes(6).toString('hex');
      tx(() => { if (ex) q('UPDATE reviews SET data = ?, last = ? WHERE id = ?').run(JSON.stringify(tr), now(), id); // sent again: the summary is brought up to date
        else { q('INSERT INTO reviews (id, member, trade, at, last, data) VALUES (?, ?, ?, ?, ?, ?)').run(id, me.id, key, now(), now(), JSON.stringify(tr));
          for (const o of q('SELECT id FROM reviews WHERE member = ? ORDER BY last DESC LIMIT -1 OFFSET ?').all(me.id, REVIEWS_KEEP)) dropReview(o.id); } // the oldest go
        if (text) addReviewComment(id, me, text); });
      if (!ex) for (const o of to) notify(o, 'mentor', '@' + me.handle + ' sent a trade for review: ' + tradeName(tr), { title: 'A trade to review', url: '/daruma#tr/' + id });
      save(me, ...(ex ? [] : to)); return json(res, 200, threadOut(reviewById(id), me, 'mentee'));
    }
    if (head === 'reviews' && parts[1]) {
      const r = reviewById(arg), role = r && reviewRole(r, me);
      if (!role) return json(res, 404, { error: 'That trade review isn’t here.' });
      const o = S.members[r.member], what = tradeName(reviewTrade(r));
      if (!parts[2] && M === 'GET') return json(res, 200, threadOut(r, me, role));
      if (!parts[2] && M === 'DELETE') { if (role !== 'mentee') return json(res, 403, { error: 'Only the member who sent it can take it back.' }); dropReview(r.id); return json(res, 200, { ok: true }); }
      if (parts[2] === 'comments' && M === 'POST') {
        const text = cleanPost(body.text, 1000); if (!text) return json(res, 400, { error: 'Write the comment first.' });
        if (r.comments >= REVIEW_COMMENTS_MAX) return json(res, 409, { error: 'This thread is full (' + REVIEW_COMMENTS_MAX + ' comments).' });
        if (limited(req, 'rcomment:' + me.id, 60, 3600000, true)) return json(res, 429, { error: 'That’s a lot of comments this hour.' });
        addReviewComment(r.id, me, text);
        // a mentor's comment goes to the member; a reply goes to the mentors in the thread (every mentor, before one of them answered)
        const inT = new Set(q('SELECT DISTINCT member FROM review_comments WHERE review = ? AND member != ?').all(r.id, r.member).map(x => x.member));
        const all = role === 'mentor' ? [o] : mentorsOf(o), inThread = all.filter(x => inT.has(x.id)), to = role === 'mentor' || !inThread.length ? all : inThread;
        for (const x of to) notify(x, 'mentor', '@' + me.handle + (role === 'mentor' ? ' on your ' + what + ': ' : ' replied on their ' + what + ': ') + text, { title: role === 'mentor' ? 'Your mentor on a trade' : 'A reply on a trade', url: '/daruma#tr/' + r.id });
        if (to.length) save(...to); return json(res, 200, threadOut(reviewById(r.id), me, role)); }
      if (parts[2] === 'reviewed' && M === 'POST') {
        if (role !== 'mentor') return json(res, 403, { error: 'Only a mentor marks a trade reviewed.' });
        const on = body.done !== false; q('UPDATE reviews SET reviewed = ?, reviewer = ? WHERE id = ?').run(on ? now() : null, on ? me.id : null, r.id);
        let xp = 0;
        if (on && !r.reviewed) { notify(o, 'mentor', '@' + me.handle + ' reviewed your ' + what + ' ✓', { title: 'Trade reviewed', url: '/daruma#tr/' + r.id });
          // a review pays once, and only with something said in it
          mentorWorked(me, o); if (q('SELECT 1 FROM review_comments WHERE review = ? AND member = ? LIMIT 1').get(r.id, me.id)) xp = mentorPay(me, o, 'review', 'r:' + r.id);
          save(o, me); }
        return json(res, 200, Object.assign(threadOut(reviewById(r.id), me, role), { xp })); }
      return json(res, 404, { error: 'not found' });
    }
    if (head === 'me' && M === 'PUT') {
      const r = typeof body.avatar === 'string' && MEDIA_RE.test(body.avatar) ? q('SELECT * FROM media WHERE id = ?').get(body.avatar) : null;
      if (body.avatar !== undefined && body.avatar !== null && (!r || r.member !== me.id || r.kind !== 'avatar')) return json(res, 400, { error: 'That picture didn’t upload. Try again.' });
      const newAddr = body.address !== undefined && !me.claimed ? (typeof body.address === 'string' && ADDR_RE.test(body.address) ? body.address.toLowerCase() : null) : undefined;
      if (newAddr && claimedBy(newAddr, me.id)) return json(res, 409, { error: 'That wallet is claimed by another profile. Only a signature from it can move it.', walletTaken: true });
      if (newAddr && mappedTo(newAddr, me.id)) return json(res, 409, { error: 'That wallet belongs to another profile here. Claim it by signing with it, or ask the owner.', walletTaken: true });
      if (body.handle != null) { const h = cleanText(body.handle, 20).replace(/^@/, '');
        if (!HANDLE_RE.test(h)) return json(res, 400, { error: 'Pick a name of 3–20 letters, numbers or underscores.' });
        const other = byHandle(h); if (other && other.id !== me.id) return json(res, 409, { error: 'That name is taken.' }); me.handle = h; reindex(); }
      const prevAddr = me.address, prevVerify = !!me.share.verify, prevMoney = !!(me.share.ret || me.share.usd);
      if (body.share) { me.share = sanitizeShare(body.share, me.share); if (me.share.bench === false && me.bench) { me.bench = null; benchDirty = true; } } // off: their summary is gone from the next build
      if (me.share.bench === false && own(S.benchHist, 'm:' + me.id)) { delete S.benchHist['m:' + me.id]; touch('benchHist'); } // and their weekly history at once
      if (typeof body.coachDetail === 'boolean') me.coachDetail = body.coachDetail;
      if (body.bio !== undefined) me.bio = cleanText(body.bio, 160);
      // a new picture replaces the old one (whose file goes); null takes it off
      if (body.avatar !== undefined) {
        if (!r || r.id !== me.avatar) { dropMedia(q('SELECT id FROM media WHERE member = ? AND kind = ? AND id != ?').all(me.id, 'avatar', r ? r.id : ''));
          if (r) q('UPDATE media SET ref = ? WHERE id = ?').run('avatar:' + me.id, r.id); me.avatar = r ? r.id : null; } }
      // a claimed wallet stays put: only releasing it (or claiming another) changes the address
      if (newAddr !== undefined) { if (newAddr !== me.address) me.money = null; /* the old wallet's numbers aren't this one's */ me.address = newAddr;
        if (newAddr) me.wallets = linkedOf(me).filter(x => x !== newAddr); } // one of their mapped wallets became the main one
      if (!(me.share.ret || me.share.usd)) me.money = null;
      if (!me.share.verify || me.address !== prevAddr) { me.vdays = null; me.vAt = 0; }
      let compsCh = false;
      if (me.address !== prevAddr) for (const c of Object.values(S.comps)) if (c.money && own(c.money, me.id)) { delete c.money[me.id]; compsCh = true; } // the old wallet's return isn't this one's
      if (!me.share.ret) for (const c of Object.values(S.comps)) if (c.money && own(c.money, me.id)) { delete c.money[me.id]; compsCh = true; } // opting out hides past results too
      if (compsCh) save(me, 'comps'); else save(me);
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
      me.pendingCodes = []; // an unused sign-in code from the owner would let a device straight back in
      // ?passkeys=1: passkeys go too — someone who had the key could have registered one of their own
      if (query.passkeys === '1') me.passkeys = [];
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
      const logd = me.logd && typeof me.logd === 'object' ? me.logd : {};
      for (const d of next.days) { const o = {}; if (d.p) o.p = 1; if (d.jn) o.jn = d.jn; if (d.lm === 0 || d.lm === 1) o.lm = d.lm; if (d.pl) o.pl = d.pl; logd[d.k] = o; }
      const lk = Object.keys(logd).sort(); for (const k of lk.slice(0, Math.max(0, lk.length - 200))) delete logd[k];
      me.logd = logd; taCompute(me);
      if (body.bench !== undefined) { const b = me.share.bench !== false ? Bench.sanitizeBench(body.bench) : null;
        if (b) { b.ret = null; b.dd = null; } // returns are read on chain on the server (benchRows), never taken from the app
        if (!!b !== !!me.bench) benchDirty = true; me.bench = b ? Object.assign(b, { at: now() }) : null; }
      if (next.week) { me.weekXp = me.weekXp || {}; me.weekXp[next.week] = next.weekXp;
        const keep = Object.keys(me.weekXp).sort().slice(-16); /* a quarter's season needs 13 */ for (const k of Object.keys(me.weekXp)) if (!keep.includes(k)) delete me.weekXp[k]; }
      awardCheck(me);
      if (logCompDays(me)) save(me, 'comps'); else save(me); refreshAll(me);
      return json(res, 200, { ok: true, tier: me.tier || 0 });
    }
    // ---- leagues: browse, join, leave ----
    // ?q= finds open leagues by name or number (#1042 or 1042); without q: yours first, then the open ones, biggest first
    if (head === 'leagues' && M === 'GET' && !parts[1]) {
      const q = cleanText(query.q, 40).toLowerCase().replace(/^#/, '');
      let list = Object.values(S.leagues).filter(L => L.open || own(L.members, me.id));
      if (q) list = list.filter(L => String(L.num) === q || L.name.toLowerCase().includes(q) || (L.desc || '').toLowerCase().includes(q));
      const size = leagueSize;
      list.sort((a, b) => (own(b.members, me.id) ? 1 : 0) - (own(a.members, me.id) ? 1 : 0) || size(b) - size(a) || a.num - b.num);
      return json(res, 200, { q, leagues: list.slice(0, 50).map(L => leagueOut(L, me)) });
    }
    // a league's page before (or after) joining: what it ranks, its top five, its competitions
    if (head === 'leagues' && parts[1] && !parts[2] && M === 'GET') {
      const L = own(S.leagues, arg) ? S.leagues[arg] : Object.values(S.leagues).find(x => String(x.num) === arg.replace(/^#/, '')) || null;
      if (!L || (!L.open && !own(L.members, me.id))) return json(res, 404, { error: 'No such league.' });
      const W = leagueWindow(L), top = boardRows(leagueMembers(L), L.metric, { week: S.league.week, weeks: L.metric === 'xp' && W.weeks ? W.weeks : undefined, dayFrom: L.metric === 'xp' ? W.dayFrom : undefined, dayTo: W.dayTo, days: W.days });
      return json(res, 200, { league: Object.assign(leagueOut(L, me), { createdAt: L.createdAt, hall: (L.hall || []).slice().reverse().map(h => ({ season: h.season, label: h.label, n: h.n,
          // as the members stand today: a suspended one isn't named, and returns or dollars only show while still shared
          podium: h.podium.map(r => { const pm = own(S.members, r.id) ? S.members[r.id] : null;
            const shown = !['ret', 'usd', 'riskadj'].includes(L.metric) || (pm && !pm.banned && (L.metric === 'usd' ? pm.share.usd : pm.share.ret));
            return { handle: pm && !pm.banned ? pm.handle : null, value: shown ? r.value : null, me: r.id === me.id }; }) })),
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
      refreshAll(me); // background, the viewer first; boards show what's cached
      let rows, L = null;
      if (global) rows = boardRows(members().filter(m => m.share.global && !standingLapsed(m)), board, { week: S.league.week });
      else { L = own(S.leagues, query.league) && own(S.leagues[query.league].members, me.id) ? S.leagues[query.league] : own((S.leagues.main || {}).members || {}, me.id) ? S.leagues.main : leaguesOf(me)[0] || null;
        rows = L ? leagueBoard(L, board, me, standingOn() ? m => !standingLapsed(m) : null) : []; }
      const mine = rows.find(r => r.id === me.id) || null;
      for (const r of rows.slice(0, 50)) if (own(S.members, r.id)) refreshAll(S.members[r.id]); // the rows on show, a few at a time
      const needKey = global && !me.share.global ? 'global' : !me.share[BOARDS[board].needs] ? BOARDS[board].needs : BOARDS[board].verified && !me.share.verify ? 'verify' : null;
      return json(res, 200, { board, label: BOARDS[board].label, scope: global ? 'global' : 'league', league: L ? { id: L.id, name: L.name } : null,
        rows: rows.slice(0, 50).map(r => ({ rank: r.rank, handle: r.handle, av: avUrl(S.members[r.id]), tier: r.tier, value: r.value, sub: r.sub, me: r.id === me.id })),
        me: mine, total: rows.length, optedIn: !needKey, need: needKey, offBoards: standingLapsed(me),
        verifyState: !BOARDS[board].verified || !me.share.verify ? null : !canVerify ? 'unavailable' : !me.address ? 'no-wallet' : !walletFor(me) ? walletBlock(me) : !Array.isArray(me.vdays) ? 'pending' : 'ok' });
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
        if (limited(req, 'comment:' + me.id, 60, 3600000, true)) return json(res, 429, { error: 'That’s a lot of comments this hour.' });
        const id = crypto.randomBytes(6).toString('hex');
        tx(() => { q('INSERT INTO comments (id, event, member, at, text) VALUES (?, ?, ?, ?, ?)').run(id, e.id, me.id, now(), text);
          q('UPDATE events SET comments = comments + 1 WHERE id = ?').run(e.id); });
        const author = own(S.members, e.member) ? S.members[e.member] : null;
        if (author && author.id !== me.id) { notify(author, 'comment', '@' + me.handle + ' on your post: ' + text, { title: 'New comment', url: '/daruma#post/' + e.id, post: e.id }); save(author); }
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
      if (limited(req, 'report:' + me.id, 20, 86400000, true)) return json(res, 429, { error: 'Too many reports today.' });
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
        if (standingLock(me, 'Competitions')) return json(res, 403, { error: standingLock(me, 'Competitions'), standing: true });
        if (c.type === 'return' && !(me.address && me.share.ret)) return json(res, 400, { error: 'Return competitions read your wallet on chain: add your address and switch on “Show % return” in What you share.' });
        if (c.type === 'return' && !walletFor(me)) return json(res, 400, { error: walletBlock(me) === 'approval' ? 'Your wallet is waiting for the league owner’s approval. You can join return competitions once it’s approved.'
          : walletBlock(me) === 'rejected' ? 'The league owner hasn’t accepted this wallet, so it can’t enter return competitions.'
          : 'This league only counts claimed wallets. Claim yours under Profile & privacy first.' });
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
    count: (m, d = 1) => { if (m) { const tz = coachTz(m), k = zoneKey(tz, now());
        for (const key of coachKeys(m)) S.coachUse[key] = { k, tz, n: Math.max(0, coachUsedKey(key, tz) + d) };
        coachPrune(); }
      else { const k = utcDayKey(now()); S.ownerCoach = { k, n: Math.max(0, (S.ownerCoach.k === k ? S.ownerCoach.n : 0) + d) }; } save(m ? 'coachUse' : 'ownerCoach'); },
  };
  save(); // what loading filled in (defaults, league numbers) is written once, so a restart reads the same
  seedSchedule(); // seed wallets still waiting from before a restart
  return { handle, coach, tick, memberOf: req => { const m = byKey(req); return m && !m.banned ? m : null; }, state: () => S, store, close: () => { closing = true; clearTimeout(seedTimer); store.close(); } };
}

module.exports = { createSocial, sanitizeTrade, sanitizeReviewTrade, sanitizePostCfg, sanitizeStats, sanitizeShare, sanitizeComp, sanitizeVaultBlob, siweMessage, eventsFromStats, portfolioStats, leagueRollover, leagueRolloverBy, isoWeekMonday,
  boardRows, compStandings, compStatus, disciplineOver, isoWeekOfKey, seasonOf, seasonBounds, seasonLabel, weeksIn, TIERS, DEFAULT_CONFIG, DEFAULT_SHARE };
