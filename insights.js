'use strict';
// Admin insights: one row per member from what the server already holds (synced days, XP, the
// benchmark summary, on-chain return, duels), then the whole base, segments, cohorts and weekly
// trends from those rows. Pure functions; no I/O. The owner and admins see members by name (the
// privacy text says so); a segment with fewer than MIN_SEG members shows no numbers.

const DAY = 86400000;
const MIN_SEG = 5;
const keyOf = ms => new Date(ms).toISOString().slice(0, 10);
const addDays = (k, n) => keyOf(Date.parse(k + 'T00:00:00Z') + n * DAY);
const fin = v => typeof v === 'number' && isFinite(v);
const avg = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
const quant = (s, p) => { if (!s.length) return null; const i = (s.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i); return s[lo] + (s[hi] - s[lo]) * (i - lo); };
const r2 = v => v == null ? null : Math.round(v * 100) / 100;

const SLIPS = { revenge: 'Entered within 15 minutes of a loss', afterTwo: 'Kept trading after two losses in a row', sizeUp: 'Sized up right after a loss',
  addLoser: 'Added to a losing position', overtrade: 'More trades than their usual day', heldLoser: 'Held a loser far longer than winners' };
// what each measure is, how it reads, and which way is better (hi: higher is better)
const METRICS = {
  disc30: { label: 'Discipline (30 days)', unit: '', hi: true },
  clean30: { label: 'Clean trading days (30 days)', unit: '', hi: true },
  days30: { label: 'Trading days (30 days)', unit: '', hi: null },
  journal30: { label: 'Days fully journaled', unit: '%', hi: true },
  review30: { label: 'Days reviewed', unit: '%', hi: true },
  wr: { label: 'Win rate', unit: '%', hi: true, trading: true },
  pf: { label: 'Profit factor', unit: '', hi: true, trading: true },
  pay: { label: 'Average win ÷ average loss', unit: '', hi: true, trading: true },
  fees: { label: 'Fees and funding as % of gross profit', unit: '%', hi: false, trading: true },
  tw: { label: 'Trades per week', unit: '', hi: null, trading: true },
  hold: { label: 'Typical hold', unit: '', hi: null, trading: true },
  rev: { label: 'Revenge entries', unit: '%', hi: false, trading: true },
  ret: { label: '30-day return', unit: '%', hi: true },
  dd: { label: '30-day max drawdown', unit: '%', hi: false },
  xp: { label: 'XP', unit: '', hi: true },
  streak: { label: 'Streak', unit: '', hi: true },
};
const LEVEL_BANDS = [['1-2', 1, 2], ['3-5', 3, 5], ['6-10', 6, 10], ['11+', 11, Infinity]];
const bandOf = l => (LEVEL_BANDS.find(([, a, b]) => l >= a && l <= b) || LEVEL_BANDS[0])[0];
const activityOf = (r, now) => !r.lastSeen ? 'never' : now - r.lastSeen < 7 * DAY ? 'active7' : now - r.lastSeen < 30 * DAY ? 'active30' : 'dormant';
const ACTIVITY = { active7: 'Seen in the last 7 days', active30: 'Seen 8–30 days ago', dormant: 'Not seen for 30+ days', never: 'Never signed in' };

// One member -> the row every view is built from.
// o: {today: 'YYYY-MM-DD', leagues: [ids]}
function memberRow(m, o) {
  const st = m.stats || {}, today = o.today, from30 = addDays(today, -29), from60 = addDays(today, -59);
  const app = Array.isArray(st.days) ? st.days : [];
  const verified = !!(m.share && m.share.verify && Array.isArray(m.vdays));
  const disc = verified ? m.vdays : app; // the Discipline the league trusts: verified from fills when on
  const win = (a, f, t) => a.filter(d => d.k >= f && d.k <= t);
  const d30 = win(disc, from30, today), dPrev = win(disc, from60, addDays(from30, -1)), a30 = win(app, from30, today);
  const slips = {}; for (const d of a30) for (const k of d.f || []) slips[k] = (slips[k] || 0) + 1;
  const share = (a, f) => a.length ? Math.round(a.filter(f).length / a.length * 100) : null;
  const benchOn = !(m.share && m.share.bench === false), b = benchOn && m.bench ? m.bench : null;
  const dims = m.bench ? { style: m.bench.style, size: m.bench.size, exp: m.bench.exp, act: m.bench.act } : null;
  return {
    id: m.id, handle: m.handle, level: st.level || 1, xp: st.xp || 0, streak: st.streak || 0, best: st.best || 0,
    joined: m.createdAt || 0, lastSeen: m.lastSeen || 0, statsAt: m.statsAt || 0, leagues: o.leagues || [],
    admin: !!m.admin, mentor: !!m.mentor, banned: !!m.banned, wallet: !!m.address, synced: !!m.stats, verified,
    seg: dims, benchOn,
    disc30: d30.length ? Math.round(avg(d30.map(d => d.s))) : null, discPrev30: dPrev.length ? Math.round(avg(dPrev.map(d => d.s))) : null,
    days30: a30.length, clean30: d30.filter(d => d.s >= 70).length,
    journal30: share(a30, d => d.j), review30: share(a30, d => d.r), logged30: share(a30, d => d.b),
    slips30: slips,
    trading: b ? { n: b.n, wr: b.wr, pf: b.pf, pay: b.pay, fees: b.fees, tw: b.tw, hold: b.hold, rev: b.rev, jour: b.jour } : null,
    ret: m.money && fin(m.money.ret) ? r2(m.money.ret * 100) : null, dd: m.money && fin(m.money.dd) ? r2(m.money.dd * 100) : null,
    duels: Object.assign({ w: 0, l: 0, d: 0 }, m.duelRec),
    habits: (st.habits || []).slice(0, 5),
    spark: d30.map(d => ({ k: d.k, s: Math.round(d.s) })),
  };
}
function valueOf(r, k) {
  if (METRICS[k] && METRICS[k].trading) return r.trading && fin(r.trading[k]) ? r.trading[k] : null;
  const v = r[k]; return fin(v) ? v : null;
}

// ---- filters: the segment the admin is looking at ----
const FILTERS = ['style', 'size', 'exp', 'act', 'league', 'level', 'cohort', 'verified', 'activity'];
function matches(r, f, now) {
  for (const k of FILTERS) {
    const want = f[k]; if (want == null || want === '') continue;
    if (['style', 'size', 'exp', 'act'].includes(k)) { if (!r.seg || r.seg[k] !== want) return false; }
    else if (k === 'league') { if (!r.leagues.includes(want)) return false; }
    else if (k === 'level') { if (bandOf(r.level) !== want) return false; }
    else if (k === 'cohort') { if (!r.joined || keyOf(r.joined).slice(0, 7) !== want) return false; }
    else if (k === 'verified') { if ((want === 'yes') !== r.verified) return false; }
    else if (k === 'activity') { if (activityOf(r, now) !== want) return false; }
  }
  return true;
}
function summarize(rows, k) {
  const vals = rows.map(r => valueOf(r, k)).filter(fin).sort((a, b) => a - b);
  if (!vals.length) return { n: 0, median: null, q: null, hist: null };
  const lo = vals[0], hi = vals[vals.length - 1], bins = 12, w = (hi - lo) / bins || 1, hist = new Array(bins).fill(0);
  for (const v of vals) hist[Math.min(bins - 1, Math.floor((v - lo) / w))]++;
  return { n: vals.length, median: r2(quant(vals, 0.5)), q: [0.1, 0.25, 0.5, 0.75, 0.9].map(p => r2(quant(vals, p))), hist: { lo: r2(lo), hi: r2(hi), counts: hist } };
}
const MED_KEYS = ['disc30', 'journal30', 'review30', 'wr', 'pf', 'ret', 'tw'];
function medians(rows) { const o = {}; for (const k of MED_KEYS) o[k] = summarize(rows, k).median; return o; }
// rows split by one dimension; a group under MIN_SEG shows its size only
function breakdown(rows, by, now, labels) {
  const keyFor = r => ['style', 'size', 'exp', 'act'].includes(by) ? (r.seg ? r.seg[by] : null)
    : by === 'league' ? null : by === 'level' ? bandOf(r.level) : by === 'cohort' ? (r.joined ? keyOf(r.joined).slice(0, 7) : null)
    : by === 'verified' ? (r.verified ? 'yes' : 'no') : by === 'activity' ? activityOf(r, now) : null;
  const groups = new Map(), add = (k, r) => { if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); };
  for (const r of rows) { if (by === 'league') { for (const L of r.leagues) add(L, r); if (!r.leagues.length) add(null, r); } else add(keyFor(r), r); }
  const nameOf = k => k == null ? (['style', 'size', 'exp', 'act'].includes(by) ? 'Not known yet' : '—')
    : (labels && labels[by] && labels[by][k]) || (by === 'activity' ? ACTIVITY[k] : by === 'verified' ? (k === 'yes' ? 'Verified from fills' : 'Not verified') : by === 'level' ? 'Level ' + k : String(k));
  return [...groups.entries()].map(([k, rs]) => {
    const small = rs.length < MIN_SEG;
    return { key: k, label: nameOf(k), n: rs.length, small, med: small ? null : medians(rs),
      active7: small ? null : Math.round(rs.filter(r => activityOf(r, now) === 'active7').length / rs.length * 100) };
  }).sort((a, b) => b.n - a.n);
}
function funnel(rows, now) {
  return { joined: rows.length, wallet: rows.filter(r => r.wallet).length, synced: rows.filter(r => r.synced).length,
    traded30: rows.filter(r => r.days30 > 0).length, journaling: rows.filter(r => r.journal30 > 0).length, reviewing: rows.filter(r => r.review30 > 0).length,
    active30: rows.filter(r => r.lastSeen && now - r.lastSeen < 30 * DAY).length, active7: rows.filter(r => r.lastSeen && now - r.lastSeen < 7 * DAY).length,
    verified: rows.filter(r => r.verified).length };
}
// by month joined: how many stayed, how many came back after their first week, how many journal
function cohorts(rows, now, months) {
  const by = new Map();
  for (const r of rows) { if (!r.joined) continue; const k = keyOf(r.joined).slice(0, 7); if (!by.has(k)) by.set(k, []); by.get(k).push(r); }
  return [...by.entries()].sort((a, b) => a[0] < b[0] ? 1 : -1).slice(0, months || 12).map(([k, rs]) => ({ month: k, joined: rs.length,
    synced: rs.filter(r => r.synced).length, journaled: rs.filter(r => r.journal30 > 0).length,
    // came back at least once a week or more after joining (its last visit is that late): the week-1 drop-off
    back7: rs.filter(r => r.lastSeen && r.lastSeen - r.joined >= 7 * DAY).length, active30: rs.filter(r => r.lastSeen && now - r.lastSeen < 30 * DAY).length,
    active7: rs.filter(r => r.lastSeen && now - r.lastSeen < 7 * DAY).length }));
}
// Monday-to-Sunday weeks, newest last: members who traded, average Discipline, share of days journaled
function weekly(members, today, weeks) {
  weeks = weeks || 8;
  const dow = (new Date(today + 'T00:00:00Z').getUTCDay() + 6) % 7, mon0 = addDays(today, -dow), out = [];
  for (let i = weeks - 1; i >= 0; i--) {
    const from = addDays(mon0, -7 * i), to = addDays(from, 6), per = [];
    let days = 0, journaled = 0, slips = 0;
    for (const m of members) { const ds = ((m.stats && m.stats.days) || []).filter(d => d.k >= from && d.k <= to); if (!ds.length) continue;
      per.push(avg(ds.map(d => d.s))); days += ds.length; journaled += ds.filter(d => d.j).length; slips += ds.reduce((a, d) => a + (d.f ? d.f.length : 0), 0); }
    out.push({ from, to, traders: per.length, disc: per.length ? Math.round(avg(per)) : null, journaled: days ? Math.round(journaled / days * 100) : null,
      slipsPerDay: days ? r2(slips / days) : null });
  }
  return out;
}
function slipTotals(rows) {
  let days = 0; const n = {};
  for (const r of rows) { days += r.days30; for (const [k, c] of Object.entries(r.slips30)) n[k] = (n[k] || 0) + c; }
  return Object.keys(SLIPS).map(k => ({ key: k, label: SLIPS[k], n: n[k] || 0, share: days ? Math.round((n[k] || 0) / days * 100) : null })).sort((a, b) => b.n - a.n);
}
// percent of `pool` this value beats, in the metric's better direction (null when it can't be said)
function percentileIn(pool, k, v) {
  const def = METRICS[k]; if (!fin(v) || !def || def.hi == null) return null;
  const vals = pool.map(r => valueOf(r, k)).filter(fin); if (vals.length < MIN_SEG) return null;
  const below = vals.filter(x => def.hi ? x < v : x > v).length, eq = vals.filter(x => x === v).length;
  return Math.round((below + eq / 2) / vals.length * 100);
}
// the same, read off a benchmark group's deciles (10th…90th): an estimate within a decile
function percentileFromDeciles(q, v, hi) {
  if (!Array.isArray(q) || q.length !== 9 || !fin(v) || hi == null) return null;
  let p; if (v <= q[0]) p = 5; else if (v >= q[8]) p = 95;
  else { let i = 0; while (i < 8 && v > q[i + 1]) i++; const span = q[i + 1] - q[i]; p = 10 * (i + 1) + (span > 0 ? (v - q[i]) / span * 10 : 5); }
  return Math.round(hi ? p : 100 - p);
}

// Everything the Insights tab shows, for the members matching `f`.
function insights(rows, members, f, o) {
  const now = o.now, sel = rows.filter(r => !r.banned && matches(r, f || {}, now));
  const filtered = FILTERS.some(k => f && f[k]);
  const small = filtered && sel.length < MIN_SEG;
  const sortK = METRICS[o.sort] || o.sort === 'slipping' || o.sort === 'lastSeen' ? o.sort : 'disc30';
  const drop = r => r.disc30 != null && r.discPrev30 != null ? r.disc30 - r.discPrev30 : null;
  let list = sel.slice();
  if (sortK === 'slipping') list = list.filter(r => drop(r) != null && drop(r) <= -10).sort((a, b) => drop(a) - drop(b));
  else if (sortK === 'lastSeen') list.sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0));
  else { const hi = METRICS[sortK].hi !== false; list.sort((a, b) => { const x = valueOf(a, sortK), y = valueOf(b, sortK);
    if (x == null) return y == null ? 0 : 1; if (y == null) return -1; return hi ? y - x : x - y; }); }
  const ids = new Set(sel.map(r => r.id)), mem = members.filter(m => ids.has(m.id));
  const metric = METRICS[o.metric] ? o.metric : 'disc30';
  return {
    n: sel.length, total: rows.filter(r => !r.banned).length, small, minSeg: MIN_SEG,
    summary: small ? null : Object.assign(medians(sel), { trading: sel.filter(r => r.trading).length }),
    funnel: funnel(sel, now), cohorts: cohorts(sel, now, 12), weekly: small ? null : weekly(mem, o.today, 8),
    slips: small ? null : slipTotals(sel),
    dist: small ? null : Object.assign({ key: metric }, summarize(sel, metric)),
    breakdown: breakdown(sel, o.by || 'style', now, o.labels),
    members: list.slice(0, 200).map(r => ({ id: r.id, handle: r.handle, level: r.level, seg: r.seg, disc30: r.disc30, discPrev30: r.discPrev30,
      days30: r.days30, journal30: r.journal30, wr: valueOf(r, 'wr'), pf: valueOf(r, 'pf'), ret: r.ret, lastSeen: r.lastSeen, verified: r.verified })),
    more: Math.max(0, list.length - 200),
  };
}

// ---- what gets used: Daruma's screens and Today cards, as totals across members (never per person) ----
// The app sends, per day on the member's clock: o, screens opened ('tab:name'); s, Today cards on screen ('card:id');
// a, presses per screen or card. Kept 35 days per member. usageTable -> one row per screen or card: how many active
// members opened (or saw) it and how many pressed something on it, over the window; the bottom third by members who
// acted is flagged, as a place to look for something to cut or merge.
const USE_KEY = /^(tab|card):[a-z0-9_-]{1,40}$/, USE_DAY = /^\d{4}-\d{2}-\d{2}$/;
function sanitizeUse(b) {
  const out = {}; if (!b || typeof b !== 'object' || Array.isArray(b)) return out;
  const list = a => [...new Set((Array.isArray(a) ? a : []).filter(x => typeof x === 'string' && USE_KEY.test(x)))].slice(0, 60);
  for (const k of Object.keys(b).filter(k => USE_DAY.test(k)).sort().slice(-14)) { const d = b[k]; if (!d || typeof d !== 'object') continue;
    const a = {}; if (d.a && typeof d.a === 'object' && !Array.isArray(d.a)) for (const [x, n] of Object.entries(d.a).slice(0, 120)) { const v = Math.round(+n); if (USE_KEY.test(x) && v > 0) a[x] = Math.min(v, 10000); }
    out[k] = { o: list(d.o), s: list(d.s), a }; }
  return out;
}
function mergeUse(prev, next) { const o = Object.assign({}, prev && typeof prev === 'object' ? prev : {}, next || {}); return Object.fromEntries(Object.keys(o).sort().slice(-35).map(k => [k, o[k]])); }
function usageTable(members, o) {
  o = Object.assign({ days: 30, now: Date.now() }, o || {}); const from = keyOf(o.now - (o.days - 1) * DAY), rows = new Map();
  const row = k => { if (!rows.has(k)) rows.set(k, { key: k, kind: k.startsWith('tab:') ? 'screen' : 'card', name: k.slice(k.indexOf(':') + 1), opened: new Set(), acted: new Set(), presses: 0 }); return rows.get(k); };
  let active = 0;
  for (const m of members || []) { const U = m && m.use; if (!U || typeof U !== 'object') continue; let any = false;
    for (const [day, d] of Object.entries(U)) { if (day < from || !d) continue; any = true;
      for (const k of [...(d.o || []), ...(d.s || [])]) row(k).opened.add(m.id);
      for (const [k, n] of Object.entries(d.a || {})) { const r = row(k); r.acted.add(m.id); r.opened.add(m.id); r.presses += n; } }
    if (any) active++; }
  const out = [...rows.values()].map(r => ({ key: r.key, kind: r.kind, name: r.name, opened: r.opened.size, acted: r.acted.size, presses: r.presses,
    reach: active ? Math.round(100 * r.opened.size / active) : null, acts: r.opened.size ? Math.round(100 * r.acted.size / r.opened.size) : null }))
    .sort((a, b) => b.acted - a.acted || b.opened - a.opened || a.key.localeCompare(b.key));
  for (const kind of ['screen', 'card']) { const K = out.filter(r => r.kind === kind), n = Math.floor(K.length / 3); for (const r of K.slice(K.length - n)) r.low = true; }
  return { days: o.days, active, rows: out };
}

module.exports = { sanitizeUse, mergeUse, usageTable, METRICS, SLIPS, LEVEL_BANDS, ACTIVITY, FILTERS, MIN_SEG, memberRow, valueOf, matches, summarize, breakdown, funnel, cohorts, weekly, slipTotals,
  percentileIn, percentileFromDeciles, insights, bandOf, activityOf };
