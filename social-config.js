'use strict';
// What the owner can configure in the admin panel (v0.4), with one sanitizer per section. Every
// value from the panel passes through here before it's stored, so the rest of social.js and the
// app can trust its shape. Pure functions only; exported for tests.

const PROFILES = ['scalper', 'day', 'swing', 'position'];
// Pulse features that can be tied to a level. 1 = open to everyone.
const MODULES = {
  trends: 'Deeper Stats insights', deep: 'In-depth stats', share: 'Share cards', compete: 'Competitions',
  coach: 'AI coach', review: 'End-of-day review', reports: 'Report cards', peers: 'Traders like you', duels: 'Duels',
};
const LEAGUE_METRICS = {
  xp: 'XP earned', discipline: 'Discipline (verified)', streak: 'Discipline streak', level: 'All-time XP',
  ret: '% return', usd: '$ P&L', riskadj: 'Return / drawdown',
};
const BADGE_METRICS = {
  level: 'Level', xp: 'Total XP', weekXp: 'XP this week', streak: 'Current streak', best: 'Best streak',
  discipline30: 'Discipline, 30 days', badges: 'App badges unlocked', challenges: 'Weekly challenges kept',
  ret30: '% return, 30 days', usd30: '$ P&L, 30 days', members: 'Days in the league',
};
const DEFAULT_LEVEL_TITLES = ['Rookie', 'Apprentice', 'Journeyman', 'Disciplined', 'Consistent', 'Professional', 'Veteran', 'Master', 'Grandmaster', 'Legend'];
const DEFAULTS = {
  modules: { trends: 2, deep: 1, share: 3, compete: 4, coach: 1, review: 1, reports: 1, peers: 1, duels: 3 }, // peers: free for now; duels from level 3 (1,200 XP), so there's a record to compete on and XP to stake
  levels: { mode: 'curve', base: 200, thresholds: [], titles: DEFAULT_LEVEL_TITLES },
  xp: { discipline: 1, checkin: 10, plan: 15, journal: 15, stops: 10, limit: 10, review: 15, achievement: 50, challenge: 150, focus: 25 },
  coach: { members: true, daily: 3, dailyUnlocked: 3, ownerDaily: 0, detail: true,
    // extra messages bought with XP once the day's allowance is used: cost XP buys msgs messages, at most max packs a day
    // (0 = no cap); rise doubles each pack's price that day; keepLevel refuses a purchase that would drop a level
    packs: { on: true, cost: 150, msgs: 3, max: 2, rise: false, keepLevel: true, lapsed: false } },
  profiles: { custom: [], overrides: {} },
};

const num = (v, lo, hi, def) => { const n = +v; return isFinite(n) && v !== '' && v !== null ? Math.min(hi, Math.max(lo, n)) : def; };
const int = (v, lo, hi, def) => { const n = num(v, lo, hi, null); return n == null ? def : Math.round(n); };
const text = (s, max) => String(s == null ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const slug = s => text(s, 40).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30);
const own = (o, k) => !!o && Object.prototype.hasOwnProperty.call(o, k);
const questions = (a, n) => (Array.isArray(a) ? a : []).map(q => text(q, 200)).filter(Boolean).slice(0, n);

function sanitizeModules(b, prev) {
  const out = Object.assign({}, DEFAULTS.modules, prev || {});
  if (b && typeof b === 'object') for (const k of Object.keys(MODULES)) if (own(b, k)) out[k] = int(b[k], 1, 100, out[k]);
  return out;
}
// Level n starts at base·n·(n−1) XP ('curve'), or at thresholds[n−2] ('table': ascending XP for level 2, 3, …).
function sanitizeLevels(b, prev) {
  const out = Object.assign({}, DEFAULTS.levels, prev || {});
  if (!b || typeof b !== 'object') return out;
  if (b.mode === 'curve' || b.mode === 'table') out.mode = b.mode;
  if (own(b, 'base')) out.base = int(b.base, 10, 5000, out.base);
  if (own(b, 'thresholds')) {
    const t = (Array.isArray(b.thresholds) ? b.thresholds : String(b.thresholds).split(/[\s,]+/)).map(x => Math.round(+x)).filter(x => isFinite(x) && x > 0);
    const asc = []; for (const x of t) if (!asc.length || x > asc[asc.length - 1]) asc.push(x);
    out.thresholds = asc.slice(0, 99);
  }
  if (out.mode === 'table' && !out.thresholds.length) out.mode = 'curve';
  if (own(b, 'titles')) { const ti = (Array.isArray(b.titles) ? b.titles : String(b.titles).split(/\n|,/)).map(x => text(x, 30)).filter(Boolean).slice(0, 100);
    out.titles = ti.length ? ti : DEFAULT_LEVEL_TITLES; }
  return out;
}
// XP needed to reach `level` (1-based) under a levels config; Infinity past the last table entry.
function levelStart(cfg, level) {
  if (level <= 1) return 0;
  if (cfg.mode === 'table') return level - 2 < cfg.thresholds.length ? cfg.thresholds[level - 2] : Infinity;
  return cfg.base * level * (level - 1);
}
function levelOf(cfg, xp) { let n = 1; while (n < 1000 && levelStart(cfg, n + 1) <= xp) n++; return n; }
// The most XP one day can pay under these weights, before the multiplier: a perfect Discipline score, every
// logging bonus, a focus-habit day, the week's challenge and room for several achievements or badges landing
// the same day. What the server accepts for a day from a member's app: an honest perfect day stays under it.
function dayXpCap(x) { const p = dayXpParts(x); return p.discipline + p.bonus + p.extra; }
// The same cap in the parts a member's app reports for a day: the Discipline score's XP, the logging bonus
// (every bonus at once), and the rest (a focus-habit day, the week's challenge, achievements and badges).
function dayXpParts(x) { x = Object.assign({}, DEFAULTS.xp, x || {});
  return { discipline: Math.round(100 * x.discipline), bonus: x.checkin + x.plan + x.journal + x.stops + x.limit + x.review,
    extra: x.focus + x.challenge + 10 * x.achievement }; }
function sanitizeXp(b, prev) {
  const out = Object.assign({}, DEFAULTS.xp, prev || {});
  if (!b || typeof b !== 'object') return out;
  for (const k of Object.keys(DEFAULTS.xp)) if (own(b, k)) out[k] = k === 'discipline' ? num(b[k], 0, 5, out[k]) : int(b[k], 0, 1000, out[k]);
  return out;
}
function sanitizeCoachCfg(b, prev) {
  const out = Object.assign({}, DEFAULTS.coach, prev || {});
  const p = out.packs = Object.assign({}, DEFAULTS.coach.packs, out.packs);
  if (!b || typeof b !== 'object') return out;
  for (const k of ['members', 'detail']) if (typeof b[k] === 'boolean') out[k] = b[k];
  if (own(b, 'daily')) out.daily = int(b.daily, 0, 500, out.daily);
  if (own(b, 'dailyUnlocked')) out.dailyUnlocked = int(b.dailyUnlocked, 0, 1000, out.dailyUnlocked);
  if (own(b, 'ownerDaily')) out.ownerDaily = int(b.ownerDaily, 0, 1000, out.ownerDaily);
  const bp = b.packs;
  if (bp && typeof bp === 'object') {
    for (const k of ['on', 'rise', 'keepLevel', 'lapsed']) if (typeof bp[k] === 'boolean') p[k] = bp[k];
    if (own(bp, 'cost')) p.cost = int(bp.cost, 1, 100000, p.cost);
    if (own(bp, 'msgs')) p.msgs = int(bp.msgs, 1, 50, p.msgs);
    if (own(bp, 'max')) p.max = int(bp.max, 0, 20, p.max);
  }
  return out;
}
// Custom trader profiles (each built on one of the four) and per-profile question overrides.
function sanitizeProfiles(b, prev) {
  const out = { custom: (prev && prev.custom) || [], overrides: (prev && prev.overrides) || {} };
  if (!b || typeof b !== 'object') return out;
  if (Array.isArray(b.custom)) {
    const seen = new Set(PROFILES);
    out.custom = b.custom.slice(0, 12).map(p => {
      if (!p || typeof p !== 'object') return null;
      const name = text(p.name, 40); if (!name) return null;
      let id = slug(p.id || name); if (!id || seen.has(id)) id = (id || 'profile') + '-' + seen.size; seen.add(id);
      return { id, name, desc: text(p.desc, 200), base: PROFILES.includes(p.base) ? p.base : 'day', morning: questions(p.morning, 6), eod: questions(p.eod, 8) };
    }).filter(Boolean);
  }
  if (b.overrides && typeof b.overrides === 'object') {
    out.overrides = {};
    for (const k of PROFILES) if (own(b.overrides, k) && b.overrides[k] && typeof b.overrides[k] === 'object') {
      const o = {}; const m = questions(b.overrides[k].morning, 6), e = questions(b.overrides[k].eod, 8);
      if (m.length) o.morning = m; if (e.length) o.eod = e; if (Object.keys(o).length) out.overrides[k] = o; }
  }
  return out;
}
// A reward badge: earned automatically when a metric crosses a value, or awarded by hand (metric null).
function sanitizeBadge(b, prev) {
  if (!b || typeof b !== 'object') return null;
  const name = text(b.name != null ? b.name : prev && prev.name, 40); if (!name) return null;
  const metric = own(b, 'metric') ? (own(BADGE_METRICS, b.metric) ? b.metric : null) : (prev ? prev.metric : null);
  const icon = Array.from(text(own(b, 'icon') ? b.icon : prev && prev.icon, 8) || '🏅').slice(0, 2).join('');
  return { name, icon, desc: text(own(b, 'desc') ? b.desc : prev && prev.desc, 200), metric,
    op: (own(b, 'op') ? b.op : prev && prev.op) === 'lte' ? 'lte' : 'gte',
    value: num(own(b, 'value') ? b.value : prev && prev.value, -1e9, 1e12, 0),
    xp: int(own(b, 'xp') ? b.xp : prev && prev.xp, 0, 10000, 0) };
}
function sanitizeLeague(b, prev) {
  if (!b || typeof b !== 'object') return null;
  const name = text(b.name != null ? b.name : prev && prev.name, 40); if (!name) return null;
  const pick = (k, def) => own(b, k) ? b[k] : prev && own(prev, k) ? prev[k] : def;
  const metric = own(LEAGUE_METRICS, pick('metric', 'xp')) ? pick('metric', 'xp') : 'xp';
  return { name, desc: text(pick('desc', ''), 200), metric, period: pick('period', 'week') === 'month' ? 'month' : 'week',
    tiers: !!pick('tiers', metric === 'xp'), open: pick('open', true) !== false, invite: text(pick('invite', ''), 40), autoJoin: !!pick('autoJoin', false),
    // seasons rank what was earned inside the season: XP and Discipline can be counted that way;
    // all-time XP, streaks and returns can't, so those leagues don't run seasons
    season: ['xp', 'discipline'].includes(metric) && ['month', 'quarter'].includes(pick('season', '')) ? pick('season', '') : '',
    // the drawdown rule on its money boards: its own cap (%) and rule, or '' / null for the league-wide default
    ddCap: (x => x === '' || x == null ? null : int(x, 2, 90, null))(pick('ddCap', null)),
    ddRule: ['week', 'penalty', 'off'].includes(pick('ddRule', '')) ? pick('ddRule', '') : '' };
}

module.exports = { PROFILES, MODULES, LEAGUE_METRICS, BADGE_METRICS, DEFAULTS, DEFAULT_LEVEL_TITLES,
  sanitizeModules, sanitizeLevels, sanitizeXp, sanitizeCoachCfg, sanitizeProfiles, sanitizeBadge, sanitizeLeague, levelStart, levelOf, dayXpCap, dayXpParts };
