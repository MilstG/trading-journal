'use strict';
// Social layer for Pulse (v0.1): members, weekly leagues, leaderboards, competitions,
// following, a feed with kudos, and the owner's admin endpoints. Everything lives on the
// owner's server in one JSON file (DATA_DIR/social.json); there is no central service.
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
// Ethereum signature recovery for wallet claims (vendored noble libraries, no install needed)
let ethSig = null; try { ethSig = require('./vendor/eth-sig.js'); } catch (e) { /* claims and wallet sign-in answer 501 */ }

const TIERS = ['Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond'];
const LEVELS = ['Rookie', 'Apprentice', 'Journeyman', 'Disciplined', 'Consistent', 'Professional', 'Veteran', 'Master', 'Grandmaster', 'Legend'];
const HANDLE_RE = /^[A-Za-z0-9_]{3,20}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const WEEK_RE = /^\d{4}-W\d{2}$/;
const BADGE_RE = /^[a-z0-9-]{1,40}$/;
const MAX_SOCIAL_BODY = 64 * 1024;
const MAX_VAULT_BODY = 6 * 1024 * 1024;   // one encrypted journal (the ciphertext is base64: ~4.5 MB of journal)
const MAX_VAULT_TOTAL = 1024 * 1024 * 1024; // all members' encrypted journals together
const MAX_KEYS = 10;                       // signed-in devices per member; the oldest drops out
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const B64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const MAX_EVENTS = 2000;
const MAX_MEMBERS = 5000;
const STREAK_MARKS = [7, 14, 21, 30, 50, 75, 100, 150, 200, 365];
const COMP_TYPES = ['discipline', 'survivor', 'journal', 'return'];
const DEFAULT_CONFIG = { open: true, inviteCode: '', unlocksOn: true, requireClaim: false, vaultOn: true,
  unlocks: { trends: 2, share: 3, compete: 4 }, themes: { ember: 3, aurora: 5, gold: 8 } };
const SHARE_KEYS = ['profile', 'boards', 'global', 'page', 'feed', 'habits', 'verify', 'ret', 'usd', 'addr'];
// global: appear on the server-wide leaderboards (every member, every league) — opt-in
// page: a public badge page at /b/<name> that anyone with the link can open — opt-in
const DEFAULT_SHARE = { profile: true, boards: true, global: false, page: false, feed: true, habits: true, verify: true, ret: false, usd: false, addr: false };

const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const clampNum = (v, lo, hi) => { const n = +v; return isFinite(n) ? Math.min(hi, Math.max(lo, n)) : null; };
// invite codes are compared in constant time
const sameText = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
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
function sanitizeStats(b) {
  b = b || {};
  const days = (Array.isArray(b.days) ? b.days : []).slice(-60)
    .filter(d => d && DAY_RE.test(d.k)).map(d => ({ k: d.k, s: clampNum(d.s, 0, 100) || 0, b: !!d.b, j: !!d.j }));
  // earned badges: id, title, category, tier (0 bronze … 5 legend), day earned
  const seenB = new Set();
  const badges = (Array.isArray(b.badges) ? b.badges : []).slice(0, 400)
    .filter(x => x && BADGE_RE.test(x.id) && !seenB.has(x.id) && seenB.add(x.id)).map(x => ({ id: x.id, t: cleanText(x.t, 60), c: cleanText(x.c, 20), r: Math.round(clampNum(x.r, 0, 5) || 0), k: DAY_RE.test(x.k) ? x.k : null, d: cleanText(x.d, 120) }));
  const habits = (Array.isArray(b.habits) ? b.habits : []).slice(0, 20).map(h => cleanText(h, 140)).filter(Boolean).slice(0, 5);
  return {
    xp: clampNum(b.xp, 0, 1e8) || 0, level: clampNum(b.level, 1, 500) || 1,
    week: WEEK_RE.test(b.week) ? b.week : null, weekXp: clampNum(b.weekXp, 0, 1e6) || 0,
    streak: clampNum(b.streak, 0, 10000) || 0, best: clampNum(b.best, 0, 10000) || 0, shields: clampNum(b.shields, 0, 2) || 0,
    challengesDone: clampNum(b.challengesDone, 0, 10000) || 0, lastChallenge: cleanText(b.lastChallenge, 140),
    tz: typeof b.tz === 'string' && /^[A-Za-z_+\-/0-9]{1,40}$/.test(b.tz) ? b.tz : 'UTC',
    badges, badgeN: clampNum(b.badgeN, 0, 10000) || badges.length, badgeTotal: clampNum(b.badgeTotal, 0, 10000) || 0, habits, days,
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
    if (board === 'xp') { v = opts.weeks ? opts.weeks.reduce((a, w) => a + ((m.weekXp && m.weekXp[w]) || 0), 0) : (m.weekXp && m.weekXp[week]) || 0; sub = 'Level ' + m.stats.level; }
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
  const file = path.join(opts.dataDir, 'social.json');
  const json = opts.json, authOk = opts.authOk, adminConfigured = !!opts.adminConfigured;
  const fetchImpl = opts.fetchImpl || ((...a) => globalThis.fetch(...a));
  const now = opts.now || (() => Date.now());
  let S;
  try { S = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { S = null; }
  if (!S || S.v !== 1) S = { v: 1, config: {}, members: {}, follows: {}, events: [], comps: {}, league: { week: null } };
  S.config = Object.assign({}, DEFAULT_CONFIG, S.config, {
    unlocks: Object.assign({}, DEFAULT_CONFIG.unlocks, S.config && S.config.unlocks),
    themes: Object.assign({}, DEFAULT_CONFIG.themes, S.config && S.config.themes) });
  // v0.4 sections; v0.3's three unlock levels carry over into the feature map
  S.config.modules = SC.sanitizeModules(S.config.modules || S.config.unlocks, null);
  S.config.levels = SC.sanitizeLevels(S.config.levels, null);
  S.config.xp = SC.sanitizeXp(S.config.xp, null);
  S.config.coach = SC.sanitizeCoachCfg(S.config.coach, null);
  S.config.profiles = SC.sanitizeProfiles(S.config.profiles, null);
  if (!S.badges || typeof S.badges !== 'object') S.badges = {};
  if (!S.ownerCoach) S.ownerCoach = { k: null, n: 0 };
  if (!S.leagues || typeof S.leagues !== 'object') { // one league for everyone until the owner makes more
    S.leagues = { main: Object.assign({ id: 'main', createdAt: Date.now(), members: {}, week: S.league.week },
      SC.sanitizeLeague({ name: 'Main league', metric: 'xp', tiers: true, open: true, autoJoin: true })) };
    for (const m of Object.values(S.members)) S.leagues.main.members[m.id] = { tier: m.tier || 0, at: m.createdAt || Date.now() };
  }
  // every league has a short number people can search for (#1001, #1002, …)
  if (!(S.leagueSeq > 1000)) S.leagueSeq = 1000;
  for (const L of Object.values(S.leagues)) if (!L.num) L.num = ++S.leagueSeq;
  const sig = opts.sig !== undefined ? opts.sig : ethSig;
  const vaultDir = path.join(opts.dataDir, 'vault');
  const vaultFile = id => path.join(vaultDir, String(id).replace(/[^a-f0-9]/g, '') + '.json');
  const save = () => { const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(S)); fs.renameSync(tmp, file); };
  const members = () => Object.values(S.members);
  // a member has one key per device: keyHash from joining, keyHashes from wallet sign-ins and device codes
  const byKey = req => { const k = req.headers['x-pulse-key']; if (!k || typeof k !== 'string' || k.length > 128) return null;
    const h = sha(k); return members().find(m => m.keyHash === h || (Array.isArray(m.keyHashes) && m.keyHashes.includes(h))) || null; };
  const addKey = m => { const key = crypto.randomBytes(24).toString('hex');
    m.keyHashes = [...(Array.isArray(m.keyHashes) ? m.keyHashes : []), sha(key)].slice(-MAX_KEYS); return key; };
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
  const leagueBoard = (L, board, viewer) => boardRows(leagueMembers(L), board, {
    tier: L.tiers && board === L.metric && viewer ? leagueTier(L, viewer) : undefined, tierAll: true, week: S.league.week,
    weeks: L.period === 'month' && board === 'xp' ? monthWeeks(S.league.week) : undefined, days: L.period === 'month' ? monthDays() : 7 });
  // a monthly league's boards cover the month so far: the same window its rollover ranks on
  const monthDays = () => Math.max(1, Math.round((Date.parse(todayKey()) - Date.parse(isoWeekMonday(monthWeeks(S.league.week)[0]))) / 86400000) + 1);
  const leagueOut = (L, viewer) => ({ id: L.id, num: L.num, name: L.name, desc: L.desc, metric: L.metric, metricLabel: SC.LEAGUE_METRICS[L.metric], period: L.period,
    tiers: L.tiers, open: L.open, inviteRequired: !!L.invite, members: members().filter(m => own(L.members, m.id) && !m.banned).length,
    joined: !!viewer && own(L.members, viewer.id), tier: viewer && own(L.members, viewer.id) ? leagueTier(L, viewer) : null,
    tierName: viewer && own(L.members, viewer.id) ? TIERS[leagueTier(L, viewer)] : null });
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
  const byHandle = h => members().find(m => m.handle.toLowerCase() === String(h || '').toLowerCase()) || null;
  const EVENTS_PER_DAY = 12;
  const pushEvent = (m, e) => {
    if (m) { const recent = S.events.filter(x => x.member === m.id && now() - x.at < 86400000).length; if (recent >= EVENTS_PER_DAY) return; }
    S.events.push({ id: crypto.randomBytes(6).toString('hex'), at: now(), member: m ? m.id : null, type: e.type, text: e.text, quote: e.quote || '', kudos: [] });
    if (S.events.length > MAX_EVENTS) S.events.splice(0, S.events.length - MAX_EVENTS);
  };
  const todayKey = () => utcDayKey(now());
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  // a post is visible when its author is still here, not suspended, and shares that kind of post
  const visible = (e, viewer) => { if (!e.member) return true; const a = own(S.members, e.member) ? S.members[e.member] : null;
    if (!a || a.banned) return false; if (viewer && a.id === viewer.id) return true;
    return !!a.share.feed && (e.type !== 'habit' || !!a.share.habits); };
  const dropMember = (id) => { const gone = own(S.members, id) ? S.members[id].address : null;
    if (own(S.members, id) && S.members[id].vault) try { fs.unlinkSync(vaultFile(id)); } catch (e) {}
    delete S.members[id]; delete S.follows[id];
    for (const L of Object.values(S.leagues)) delete L.members[id];
    if (gone && opts.forgetAddress && !members().some(o => o.address === gone)) opts.forgetAddress(gone);
    for (const k in S.follows) S.follows[k] = S.follows[k].filter(x => x !== id);
    S.events = S.events.filter(e => e.member !== id); for (const e of S.events) e.kudos = e.kudos.filter(x => x !== id);
    for (const c of Object.values(S.comps)) { delete c.entrants[id]; if (c.money) delete c.money[id]; } };
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
      awardCheck(m); save();
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
      live.vdays = days.filter(d => d && DAY_RE.test(d.k)).slice(-60).map(d => ({ k: d.k, s: clampNum(d.s, 0, 100) || 0, n: clampNum(d.n, 0, 1e5) || 0 }));
      live.vAt = now(); live.vFailAt = 0; awardCheck(live); save();
    } catch (e) { m.vFailAt = now(); }
    finally { behaviorBusy.delete(m.id); }
  };
  const refreshAll = m => { refreshMoney(m); refreshBehavior(m); };
  const tierOf = m => ({ tier: m.tier || 0, tierName: TIERS[m.tier || 0] });
  const publicMember = (m, viewer) => {
    const st = m.stats || {};
    const out = { id: m.id, handle: m.handle, ...tierOf(m), level: st.level || 1, title: levelTitle(st.level || 1),
      followers: members().filter(x => (S.follows[x.id] || []).includes(m.id)).length,
      following: (S.follows[m.id] || []).length, isFollowing: !!viewer && (S.follows[viewer.id] || []).includes(m.id), isMe: !!viewer && viewer.id === m.id,
      claimed: !!m.claimed };
    if (out.isMe) Object.assign(out, { claimedAddress: m.claimed || null, devices: (m.keyHash ? 1 : 0) + (Array.isArray(m.keyHashes) ? m.keyHashes.length : 0),
      vault: m.vault ? { rev: m.vault.rev, size: m.vault.size, at: m.vault.at } : null, requireClaim: !!S.config.requireClaim, vaultOn: !!S.config.vaultOn,
      unlocked: !!m.unlocked, grants: (m.grants || []).map(g => ({ id: g.id, xp: g.xp, why: g.why, at: g.at })), coach: coachStatusFor(m), coachDetail: !!m.coachDetail,
      leagues: leaguesOf(m).map(L => ({ id: L.id, name: L.name, tier: leagueTier(L, m) })) });
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
  const eventOut = (e, viewer) => { const m = e.member ? S.members[e.member] : null;
    return { id: e.id, at: e.at, type: e.type, text: e.text, quote: e.quote, handle: m ? m.handle : null, tier: m ? m.tier || 0 : null,
      admin: !e.member, kudos: e.kudos.length, liked: !!viewer && e.kudos.includes(viewer.id), mine: !!viewer && e.member === viewer.id }; };
  const compOut = (c, viewer, full) => { const st = compStatus(c, todayKey());
    const rows = compStandings(c, members(), todayKey(), !!S.config.requireClaim);
    const mine = viewer ? rows.find(r => r.id === viewer.id) || null : null;
    const o = { id: c.id, title: c.title, type: c.type, rule: c.rule, start: c.start, end: c.end, minDays: c.minDays, ddCap: c.ddCap,
      league: c.league && own(S.leagues, c.league) ? { id: c.league, name: S.leagues[c.league].name } : null,
      status: st, entrants: rows.length, joined: !!(viewer && c.entrants[viewer.id]), me: mine };
    if (full) o.standings = rows.slice(0, 50).map(r => ({ rank: r.rank, handle: r.handle, note: r.note, out: r.out, score: r.score, me: !!viewer && r.id === viewer.id }));
    return o; };
  const joinTimes = new Map();

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
    if ((M === 'POST' || M === 'PUT') && +req.headers['content-length'] > limit) { res.setHeader('Connection', 'close'); return json(res, 413, { error: 'That’s too large to store here.' }); }
    if (M === 'POST' || M === 'PUT') { try { body = await readJson(req, limit); }
      catch (e) { return json(res, e.message === 'too large' ? 413 : 400, { error: e.message === 'too large' ? 'That’s too large to store here.' : 'invalid body' }); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) return json(res, 400, { error: 'invalid body' }); }
    let arg = parts[1] || '';
    try { arg = decodeURIComponent(arg); } catch (e) { return json(res, 400, { error: 'bad path' }); }
    ensureWeek();

    if (head === 'config' && M === 'GET')
      return json(res, 200, { enabled: adminConfigured, open: S.config.open, inviteRequired: !!S.config.inviteCode, unlocksOn: S.config.unlocksOn,
        unlocks: S.config.unlocks, themes: S.config.themes, tiers: TIERS, week: S.league.week, members: members().filter(m => !m.banned).length,
        claims: !!sig, requireClaim: !!S.config.requireClaim, vaultOn: !!S.config.vaultOn,
        modules: S.config.modules, levels: S.config.levels, xp: S.config.xp, profiles: S.config.profiles,
        coach: { members: S.config.coach.members, daily: S.config.coach.daily, detail: S.config.coach.detail },
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
          events: S.events.length, comps: Object.keys(S.comps).length, week: wk, config: S.config,
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
          leagues: leaguesOf(m).map(L => ({ id: L.id, tier: leagueTier(L, m) })), adminMade: !!m.adminMade, keys: (m.keyHash ? 1 : 0) + (Array.isArray(m.keyHashes) ? m.keyHashes.length : 0), verified: !!(m.share.verify && Array.isArray(m.vdays)), createdAt: m.createdAt, lastSeen: m.lastSeen || null,
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
        S.members[id] = m; S.follows[id] = [];
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
            const o = byHandle(h); if (o && o.id !== m.id) return json(res, 409, { error: 'That name is taken.' }); m.handle = h; }
          if (body.address !== undefined && !m.claimed) { const ad = typeof body.address === 'string' && ADDR_RE.test(body.address) ? body.address.toLowerCase() : null;
            if (ad && claimedBy(ad, m.id)) return json(res, 409, { error: 'That wallet is claimed by another profile.' });
            if (ad !== m.address) { m.address = ad; m.vdays = null; m.vAt = 0; m.money = null; refreshAll(m); } }
          if (body.share && typeof body.share === 'object') m.share = sanitizeShare(body.share, m.share);
        }
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
        if (typeof body.requireClaim === 'boolean' && body.requireClaim !== c.requireClaim) {
          c.requireClaim = body.requireClaim;
          // numbers read from wallets nobody signed for stop counting at once, and come back after a claim
          for (const m of members()) { m.vAt = 0; m.vFailAt = 0; m.moneyFailAt = 0;
            if (c.requireClaim && !walletFor(m)) { m.vdays = null; m.money = null;
              for (const cc of Object.values(S.comps)) if (cc.money) delete cc.money[m.id]; } }
        }
        for (const [grp, keys] of [['themes', ['ember', 'aurora', 'gold']]])
          if (body[grp] && typeof body[grp] === 'object') for (const k of keys) { const v = clampNum(body[grp][k], 1, 100); if (v != null) c[grp][k] = Math.round(v); }
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
      if (sub === 'events' && M === 'GET') return json(res, 200, { events: S.events.slice(-100).reverse().map(e => eventOut(e, null)) });
      if (sub === 'events' && parts[2] && M === 'DELETE') {
        const n = S.events.length; S.events = S.events.filter(e => e.id !== parts[2]);
        if (S.events.length === n) return json(res, 404, { error: 'no such event' });
        save(); return json(res, 200, { ok: true });
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
      S.members[id] = m; S.follows[id] = [];
      for (const L of Object.values(S.leagues)) if (L.autoJoin) joinLeague(L, m);
      recent.push(now()); joinTimes.set(ip, recent);
      if (m.share.feed) pushEvent(m, { type: 'join', text: 'joined the league' });
      save(); refreshMoney(m, true); refreshBehavior(m, true);
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
      const key = addKey(m); m.lastSeen = now(); save();
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
      const key = addKey(m); m.lastSeen = now(); save();
      return json(res, 200, { key, me: publicMember(m, m), share: m.share });
    }

    // ---------- everything below needs a member key ----------
    const me = byKey(req);
    if (!me) return json(res, 401, { error: 'not a member' });
    if (me.banned) return json(res, 403, { error: 'This profile was removed from the league.' });
    me.lastSeen = now();

    if (head === 'me' && M === 'GET') return json(res, 200, { me: publicMember(me, me), share: me.share, tier: me.tier || 0 });
    if (head === 'me' && M === 'PUT') {
      const newAddr = body.address !== undefined && !me.claimed ? (typeof body.address === 'string' && ADDR_RE.test(body.address) ? body.address.toLowerCase() : null) : undefined;
      if (newAddr && claimedBy(newAddr, me.id)) return json(res, 409, { error: 'That wallet is claimed by another profile. Only a signature from it can move it.', walletTaken: true });
      if (body.handle != null) { const h = cleanText(body.handle, 20).replace(/^@/, '');
        if (!HANDLE_RE.test(h)) return json(res, 400, { error: 'Pick a name of 3–20 letters, numbers or underscores.' });
        const other = byHandle(h); if (other && other.id !== me.id) return json(res, 409, { error: 'That name is taken.' }); me.handle = h; }
      const prevAddr = me.address, prevVerify = !!me.share.verify, prevMoney = !!(me.share.ret || me.share.usd);
      if (body.share) me.share = sanitizeShare(body.share, me.share);
      if (typeof body.coachDetail === 'boolean') me.coachDetail = body.coachDetail;
      // a claimed wallet stays put: only releasing it (or claiming another) changes the address
      if (newAddr !== undefined) me.address = newAddr;
      if (!(me.share.ret || me.share.usd)) me.money = null;
      if (!me.share.verify || me.address !== prevAddr) { me.vdays = null; me.vAt = 0; }
      if (!me.share.ret) for (const c of Object.values(S.comps)) if (c.money) delete c.money[me.id]; // opting out hides past results too
      save();
      refreshMoney(me, me.address !== prevAddr || (!prevMoney && !!(me.share.ret || me.share.usd)));
      refreshBehavior(me, me.address !== prevAddr || (!prevVerify && !!me.share.verify));
      if (prevAddr && prevAddr !== me.address && opts.forgetAddress && !members().some(o => o.address === prevAddr)) opts.forgetAddress(prevAddr);
      return json(res, 200, { me: publicMember(me, me), share: me.share });
    }
    if (head === 'me' && M === 'DELETE') {
      dropMember(me.id); save(); return json(res, 200, { ok: true });
    }
    if (head === 'claim' && parts[1] === 'release' && M === 'POST') {
      if (!me.claimed) return json(res, 400, { error: 'You haven’t claimed a wallet.' });
      me.claimed = null; me.claimedAt = 0;
      if (S.config.requireClaim) { me.vdays = null; me.money = null; for (const c of Object.values(S.comps)) if (c.money) delete c.money[me.id]; }
      save(); return json(res, 200, { me: publicMember(me, me), share: me.share });
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
      const h = sha(req.headers['x-pulse-key']); me.keyHash = h; me.keyHashes = [];
      for (const [k, l] of links) if (l.memberId === me.id) links.delete(k);
      save(); return json(res, 200, { me: publicMember(me, me) });
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
      me.vault = { rev: cur + 1, size, at: now() }; save();
      return json(res, 200, { rev: me.vault.rev, at: me.vault.at });
    }
    if (head === 'vault' && M === 'DELETE') {
      try { fs.unlinkSync(vaultFile(me.id)); } catch (e) {}
      // one past the last copy: a device still holding it gets a 409 with nothing in it (deleted), not a silent re-upload
      me.vaultRev = vaultRev(me) + 1; me.vault = null; save(); return json(res, 200, { ok: true, rev: me.vaultRev });
    }
    if (head === 'stats' && M === 'POST') {
      const next = sanitizeStats(body);
      const posted = new Set(me.postedHabits || []);
      for (const e of eventsFromStats(me.stats, next, me.share, S.config.levels.titles)) {
        if (e.type === 'habit') { if (posted.has(e.quote)) continue; posted.add(e.quote); }
        pushEvent(me, e);
      }
      me.postedHabits = [...posted].slice(-50);
      me.stats = next; me.statsAt = now();
      if (next.week) { me.weekXp = me.weekXp || {}; me.weekXp[next.week] = next.weekXp;
        const keep = Object.keys(me.weekXp).sort().slice(-8); for (const k of Object.keys(me.weekXp)) if (!keep.includes(k)) delete me.weekXp[k]; }
      awardCheck(me);
      save(); refreshAll(me);
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
      const top = boardRows(leagueMembers(L), L.metric, { week: S.league.week, weeks: L.period === 'month' && L.metric === 'xp' ? monthWeeks(S.league.week) : undefined, days: L.period === 'month' ? monthDays() : 7 });
      return json(res, 200, { league: Object.assign(leagueOut(L, me), { createdAt: L.createdAt,
        top: top.slice(0, 5).map(r => ({ rank: r.rank, handle: r.handle, value: r.value, sub: r.sub, me: r.id === me.id })),
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
      save(); return json(res, 200, { league: leagueOut(L, me) });
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
        rows: rows.slice(0, 50).map(r => ({ rank: r.rank, handle: r.handle, value: r.value, sub: r.sub, me: r.id === me.id })), me: rows.find(r => r.id === me.id) || null });
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
        rows: rows.slice(0, 50).map(r => ({ rank: r.rank, handle: r.handle, tier: r.tier, value: r.value, sub: r.sub, me: r.id === me.id })),
        me: mine, total: rows.length, optedIn: !needKey, need: needKey,
        verifyState: !BOARDS[board].verified || !me.share.verify ? null : !canVerify ? 'unavailable' : !me.address ? 'no-wallet' : !walletFor(me) ? 'claim' : !Array.isArray(me.vdays) ? 'pending' : 'ok' });
    }
    if (head === 'feed' && M === 'GET') {
      const scope = query.scope === 'discover' ? 'discover' : 'following';
      const fol = new Set([...(S.follows[me.id] || []), me.id]);
      const list = S.events.filter(e => visible(e, me) && (scope === 'discover' || !e.member || fol.has(e.member))).slice(-60).reverse();
      const suggest = scope === 'discover' ? members().filter(m => m.id !== me.id && !m.banned && m.share.profile && !fol.has(m.id) && m.stats)
        .map(m => ({ m, d: disciplineOver(m.share.verify && Array.isArray(m.vdays) ? m.vdays : m.stats.days, addDaysKey(todayKey(), -29), todayKey(), 3).avg }))
        .sort((a, b) => (b.d || 0) - (a.d || 0)).slice(0, 3)
        .map(({ m, d }) => ({ handle: m.handle, tierName: TIERS[m.tier || 0], why: 'Level ' + m.stats.level + (d != null ? ' · discipline ' + Math.round(d) : '') })) : [];
      return json(res, 200, { scope, events: list.map(e => eventOut(e, me)), suggest });
    }
    if (head === 'kudos' && parts[1] && M === 'POST') {
      const e = S.events.find(x => x.id === parts[1]); if (!e || !visible(e, me)) return json(res, 404, { error: 'no such post' });
      if (e.member === me.id) return json(res, 400, { error: 'That’s your own post.' });
      const i = e.kudos.indexOf(me.id); if (i >= 0) e.kudos.splice(i, 1); else e.kudos.push(me.id);
      save(); return json(res, 200, { kudos: e.kudos.length, liked: i < 0 });
    }
    if (head === 'profile' && parts[1] && M === 'GET') {
      const m = byHandle(arg); if (!m || m.banned) return json(res, 404, { error: 'No one by that name.' });
      const ev = S.events.filter(e => e.member === m.id && visible(e, me)).slice(-10).reverse().map(e => eventOut(e, me));
      return json(res, 200, { profile: publicMember(m, me), events: ev });
    }
    if (head === 'follow' && parts[1] && (M === 'POST' || M === 'DELETE')) {
      const m = byHandle(arg); if (!m || m.banned || m.id === me.id) return json(res, 404, { error: 'No one by that name.' });
      const f = S.follows[me.id] = (S.follows[me.id] || []).filter(x => x !== m.id);
      if (M === 'POST') f.push(m.id);
      save(); return json(res, 200, { following: M === 'POST' });
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
      save(); return json(res, 200, { joined: M === 'POST' });
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
      else { const k = utcDayKey(now()); S.ownerCoach = { k, n: Math.max(0, (S.ownerCoach.k === k ? S.ownerCoach.n : 0) + d) }; } save(); },
  };
  return { handle, coach, state: () => S };
}

module.exports = { createSocial, sanitizeStats, sanitizeShare, sanitizeComp, sanitizeVaultBlob, siweMessage, eventsFromStats, portfolioStats, leagueRollover, leagueRolloverBy, isoWeekMonday,
  boardRows, compStandings, compStatus, disciplineOver, isoWeekOfKey, TIERS, DEFAULT_CONFIG, DEFAULT_SHARE };
