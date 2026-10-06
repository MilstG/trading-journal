'use strict';
// findings.js — what members see of the owner's research report (research.js), and what the product takes from it.
//
// The report stays the owner's (Admin → Research). This is the part members get, at GET /api/social/findings:
// group figures only, each resting on at least cfg.minWallets wallets, never a wallet's own numbers.
//
//   slips      what each slip costs a trader, compared with themselves in the same spot (R, its 95% interval)
//   rel        how many trades a results ranking needs before it says more about skill than luck
//   forward    whether a month's Discipline says anything about the next month's results
//   improvers  what traders who improved changed (the report rebuilds these from fill histories, so a young
//              server's "Traders like you" panel can show them before it has followed anyone for 12 weeks)
//   crowd      each hour's net flow by group in five steps (research.js crowdOf), for "the crowd at your entry"
//   weights    the Discipline weights the costs suggest (see slipWeights), and whether the owner applied them
//
// The owner's settings (cfg, Admin → Research): share (members see any of it), minWallets, minTrades (results
// boards rank only members with that many closed trades in the window; 0 = off) and weights (the Discipline
// score weighs each slip by its cost instead of counting every slipped trade the same). Pure functions; no I/O.

const R = require('./research.js');

const DEFAULTS = { share: true, minWallets: 10, minTrades: 0, weights: false, crowd: true };
const fin = v => typeof v === 'number' && isFinite(v);
const sure = b => !!b && b.lo != null && (b.lo > 0 || b.hi < 0);

function sanitizeResearchCfg(b, prev) {
  const out = Object.assign({}, DEFAULTS, prev || {});
  if (!b || typeof b !== 'object') return out;
  for (const k of ['share', 'weights', 'crowd']) if (typeof b[k] === 'boolean') out[k] = b[k];
  if (b.minWallets !== undefined) { const n = Math.round(+b.minWallets); if (isFinite(n)) out.minWallets = Math.min(1000, Math.max(5, n)); }
  if (b.minTrades !== undefined) { const n = Math.round(+b.minTrades); if (isFinite(n)) out.minTrades = Math.min(5000, Math.max(0, n)); }
  return out;
}

// The weight of each slip in the Discipline score, from what the report says it costs: the costliest slip
// counts in full (1), the others by their cost against it, never under 0.25 (no slip becomes free); a slip
// whose cost the report can't tell from zero counts 0.25, and one it couldn't measure on enough wallets
// keeps the full weight. A trade with several slips counts its heaviest. All 1 is the old score exactly.
function slipWeights(slips, minWallets) {
  const known = R.SLIPS.map(k => [k, slips && slips[k]]).filter(([, x]) => x && x.wallets >= (minWallets || DEFAULTS.minWallets) && x.R && fin(x.R.v));
  const costs = known.filter(([, x]) => x.R.v < 0 && sure(x.R)).map(([, x]) => -x.R.v), top = costs.length ? Math.max(...costs) : 0;
  const w = {};
  for (const k of R.SLIPS) {
    const x = known.find(e => e[0] === k);
    w[k] = !x ? 1 : !(top > 0) || !(x[1].R.v < 0 && sure(x[1].R)) ? 0.25 : Math.max(0.25, Math.round(100 * -x[1].R.v / top) / 100);
  }
  return w;
}

// The trades a results ranking needs to be 0.7 reliable: the average trade in R if the report could say,
// else in bps, else profit factor. null when it couldn't say at all.
function reliabilityNeed(rel) {
  for (const k of ['R', 'bps', 'pf']) if (rel && rel[k] && fin(rel[k].need)) return { need: rel[k].need, by: k };
  return null;
}

// The report -> what members get (null when there's nothing to share).
function memberFindings(rep, cfg) {
  cfg = sanitizeResearchCfg(cfg, null);
  if (!rep || !cfg.share || !rep.sample) return null;
  const minW = cfg.minWallets, out = { at: rep.at, frame: (rep.sample.frame && rep.sample.frame.kind) || null, wallets: rep.sample.withTrades, trades: rep.sample.trades, minWallets: minW };
  // 1 · slips: the ones measured on enough wallets
  const S = (rep.slips && rep.slips.slips) || {}, slips = {};
  for (const k of R.SLIPS) { const x = S[k]; if (!x || !(x.wallets >= minW) || !x.R || !fin(x.R.v)) continue;
    slips[k] = { label: x.label, vs: x.vs, R: x.R.v, lo: x.R.lo, hi: x.R.hi, sure: sure(x.R), rate: x.rate, wallets: x.wallets, per100: x.per100,
      slippedR: x.slippedR ? x.slippedR.v : null, mech: !!R.SLIP_MECH[k] }; }
  out.slips = slips;
  out.order = ((rep.slips && rep.slips.order) || []).filter(k => slips[k]);
  // 2 · skill or luck
  const P = rep.persistence || {}, need = reliabilityNeed(P.reliability);
  out.rel = need ? Object.assign(need, { wallets: P.wallets || 0, perTrade: P.reliability[need.by].perTrade,
    stays: P.metrics && P.metrics[need.by] && P.metrics[need.by].n >= minW ? { top: P.metrics[need.by].topStays, rho: P.metrics[need.by].rho.v, n: P.metrics[need.by].n } : null }) : null;
  // 2 · Discipline and next month
  const F = rep.forward;
  out.forward = F && F.wallets >= minW ? { wallets: F.wallets, months: F.months, disc: F.disc, results: F.results, beyond: F.beyondResults, within: F.within, withinBeyond: F.withinBeyond,
    says: sure(F.withinBeyond) ? (F.withinBeyond.v > 0 ? 'yes' : 'no') : sure(F.beyondResults) ? (F.beyondResults.v > 0 ? 'some' : 'no') : 'unclear',
    quintiles: (F.quintiles || []).map(q => ({ q: q.q, disc: q.disc, nextR: q.nextR, nextProfitable: q.nextProfitable, n: q.n })) } : null;
  // 4 · improvers, by peer group key (the same keys as the benchmarks)
  const I = rep.improvers || {}, groups = {};
  for (const g of I.groups || []) if (g.changes && g.changes.length && g.panel >= minW) groups[g.key] = { panel: g.panel, n: g.n, nOthers: g.nOthers, changes: g.changes };
  out.improvers = Object.keys(groups).length ? { contributors: I.contributors || 0, groups, lasting: I.lasting || null } : null;
  // 8 · the crowd, hour by hour
  const C = rep.market && rep.market.crowd;
  out.crowd = cfg.crowd && C && C.hours && Object.keys(C.coins || {}).length ? { from: C.from, hours: C.hours, groups: C.groups, min: C.min, coins: C.coins,
    check: rep.market.tiers ? rep.market.tiers.check : null } : null;
  // the Discipline weights these costs suggest, and whether the owner uses them
  out.weights = { on: !!cfg.weights, w: slipWeights(S, minW) };
  out.minTrades = cfg.minTrades || 0;
  return out;
}

// The weights the Discipline score uses right now (null: count every slipped trade the same, the default).
function activeWeights(rep, cfg) {
  cfg = sanitizeResearchCfg(cfg, null);
  if (!cfg.weights || !rep || !rep.slips) return null;
  const w = slipWeights(rep.slips.slips, cfg.minWallets);
  return Object.values(w).every(x => x === 1) ? null : w;
}

// Improvers for a trader with these dimensions from the report, in the shape the benchmarks' impOut sends: the
// most specific of their groups (a key like 'style=day|size=s2'; 'all' for everyone) with something to say.
function improversFor(rep, dims, minWallets) {
  const I = rep && rep.improvers; if (!I || !Array.isArray(I.groups)) return null;
  const parse = key => key === 'all' ? {} : Object.fromEntries(String(key).split('|').map(x => x.split('=')));
  const fits = I.groups.filter(g => g && g.changes && g.changes.length && g.panel >= (minWallets || DEFAULTS.minWallets))
    .map(g => ({ g, d: parse(g.key) })).filter(x => Object.keys(x.d).every(k => dims && dims[k] === x.d[k]))
    .sort((a, b) => Object.keys(b.d).length - Object.keys(a.d).length || b.g.panel - a.g.panel);
  if (!fits.length) return null; const { g, d } = fits[0];
  return { key: g.key, dims: d, n: g.n, nOthers: g.nOthers, panel: g.panel, weeks: [8, 12], changes: g.changes, src: 'research', at: rep.at, wallets: I.contributors || 0 };
}

module.exports = { DEFAULTS, sanitizeResearchCfg, slipWeights, reliabilityNeed, memberFindings, activeWeights, improversFor };
