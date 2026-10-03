'use strict';
// XP pots: everyone in a group duel or a competition puts up the same buy-in when they join, it's held
// until the end, and a payout table splits it among those who qualified. Pure functions — the owner's
// settings, the pot's size, the split, and who moved XP to whom — so the rules can be tested without a
// server. XP only, never money: buy-ins and payouts move the stake balance, never earned XP or a level.

// pods: members can put a buy-in on a group duel (up to podMaxBuyIn each); comps: the owner can put one on a
// competition (up to compMaxBuyIn) and add an overlay (new XP, guaranteed). burnPct: the share of every pot
// removed by default (a competition can set its own, up to burnMax). pairCapMonth: the most net XP two
// members can move between them in a calendar month, across duel stakes and pots. selfMax: the most XP
// that can ride on a measure the app reports itself (unverified scores, journaling, process XP).
// oneSeat: a wallet takes one seat in a pot, so a second profile on it can't enter twice. minEntrants:
// fewer in a competition's pot when it ends and everyone gets their buy-in back.
const POT_DEFAULTS = { pods: true, podMaxBuyIn: 250, comps: true, compMaxBuyIn: 1000, burnPct: 0, burnMax: 20, pairCapMonth: 1000, selfMax: 100, oneSeat: true, minEntrants: 3 };
const PAYS = {
  wta: { label: 'Winner takes all', w: () => [1] },
  top2: { label: 'Top 2', w: () => [0.7, 0.3] },
  top3: { label: 'Top 3', w: () => [0.6, 0.3, 0.1] },
  // the top quarter of the field (at least one), more for higher places: k, k−1, … 1
  topq: { label: 'Top 25%', w: n => { const k = Math.max(1, Math.round(n / 4)), s = k * (k + 1) / 2; return Array.from({ length: k }, (_, i) => (k - i) / s); } },
  surv: { label: 'Survivors split', w: null }, // everyone who qualified, equal shares
};
const POD_PAYS = ['wta', 'top2', 'surv'], COMP_PAYS = ['wta', 'top3', 'topq', 'surv'];
const clamp = (v, lo, hi) => { const n = +v; return v !== '' && v !== null && isFinite(n) ? Math.min(hi, Math.max(lo, n)) : null; };

function sanitizePotCfg(b, prev) {
  const out = Object.assign({}, POT_DEFAULTS, prev || {});
  if (!b || typeof b !== 'object') return out;
  for (const k of ['pods', 'comps', 'oneSeat']) if (typeof b[k] === 'boolean') out[k] = b[k];
  const num = (k, lo, hi) => { if (b[k] !== undefined) { const x = clamp(b[k], lo, hi); if (x != null) out[k] = Math.round(x); } };
  num('podMaxBuyIn', 0, 100000); num('compMaxBuyIn', 0, 100000); num('burnMax', 0, 50); num('burnPct', 0, 50);
  num('pairCapMonth', 0, 1000000); num('selfMax', 0, 100000); num('minEntrants', 2, 50);
  out.burnPct = Math.min(out.burnPct, out.burnMax);
  return out;
}
// a pot's terms as an event stores them -> {buyIn, pay} or {error}. fmt: 'pod' | 'comp'
function sanitizePotTerms(b, cfg, fmt) {
  cfg = cfg || POT_DEFAULTS; b = b || {};
  const buyIn = Math.round(clamp(b.buyIn, 0, 100000) || 0);
  if (!buyIn) return { buyIn: 0, pay: null };
  if (fmt === 'pod' && !cfg.pods) return { error: 'This league doesn’t allow buy-ins on group duels.' };
  if (fmt === 'comp' && !cfg.comps) return { error: 'This league doesn’t allow buy-ins on competitions.' };
  const max = fmt === 'pod' ? cfg.podMaxBuyIn : cfg.compMaxBuyIn;
  if (buyIn > max) return { error: 'The most a ' + (fmt === 'pod' ? 'group duel' : 'competition') + ' buy-in can be here is ' + max + ' XP.' };
  const allowed = fmt === 'pod' ? POD_PAYS : COMP_PAYS;
  const pay = allowed.includes(b.pay) ? b.pay : allowed[fmt === 'pod' ? 0 : 1];
  return { buyIn, pay };
}
// gross: buy-ins held plus any overlay; burnPct: % removed -> {gross, burned, pot}
function potSize(gross, burnPct) {
  gross = Math.max(0, Math.round(gross || 0));
  const burned = Math.floor(gross * Math.max(0, Math.min(100, burnPct || 0)) / 100);
  return { gross, burned, pot: gross - burned };
}
// The split. rows: the field in finishing order, each {id, place, q} (q: qualified to be paid — not out,
// and ranked); pay: a PAYS key; n: entrants (for the top quarter). Tied places share the prizes for the
// places they cover; shares meant for places nobody qualified for go to those who did, in proportion;
// the rounding remainder goes to first place. -> {refund: true} when nobody qualified, else {paid: {id: xp}}.
function payouts(pot, rows, pay, n) {
  const Q = (rows || []).filter(r => r.q);
  if (!Q.length) return { refund: true, paid: {} };
  const share = new Map();
  if (pay === 'surv' || !PAYS[pay] || !PAYS[pay].w) for (const r of Q) share.set(r.id, 1 / Q.length);
  else {
    const w = PAYS[pay].w(n || Q.length);
    for (let i = 0; i < Q.length;) {
      let j = i; while (j + 1 < Q.length && Q[j + 1].place === Q[i].place) j++;
      let s = 0; for (let k = i; k <= j; k++) s += w[k] || 0;
      for (let k = i; k <= j; k++) share.set(Q[k].id, s / (j - i + 1));
      i = j + 1;
    }
    const tot = [...share.values()].reduce((a, b) => a + b, 0);
    for (const [id, v] of share) share.set(id, tot ? v / tot : 0);
  }
  const paid = {}; let sum = 0;
  for (const r of Q) { const x = Math.floor(pot * share.get(r.id)); if (x > 0) { paid[r.id] = x; sum += x; } }
  if (pot - sum > 0) paid[Q[0].id] = (paid[Q[0].id] || 0) + pot - sum;
  return { refund: false, paid };
}
// who moved XP to whom: nets {id: won − put in} -> [[from, to, xp]], each loser's loss spread over the
// winners in proportion to their gains (an overlay or a burn makes the two sides differ; what's spread is the
// smaller of them, so nobody is said to have moved XP that no one received)
function pairFlows(nets) {
  const W = Object.entries(nets).filter(([, v]) => v > 0), L = Object.entries(nets).filter(([, v]) => v < 0);
  const G = W.reduce((a, [, v]) => a + v, 0), P = L.reduce((a, [, v]) => a - v, 0), moved = Math.min(G, P);
  if (!moved) return [];
  const out = [];
  for (const [l, lv] of L) for (const [w, wv] of W) { const x = Math.round(moved * (-lv / P) * (wv / G)); if (x > 0) out.push([l, w, x]); }
  return out;
}
// a pair's key and the sign of a flow from `from` to `to` under it (positive: the first id gained)
const pairKey = (x, y) => x < y ? x + '|' + y : y + '|' + x;
const pairSign = (from, to) => to < from ? 1 : -1;

module.exports = { POT_DEFAULTS, PAYS, POD_PAYS, COMP_PAYS, sanitizePotCfg, sanitizePotTerms, potSize, payouts, pairFlows, pairKey, pairSign };
