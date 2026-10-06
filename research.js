'use strict';
// research.js — the owner's research questions, answered from wallets' public fills and members' verified days.
//
//   1. slipCosts           what each of the six slips costs, measured inside each wallet: the trades that
//                          slipped against the trades that had the same chance to slip and didn't
//   2. disciplineForward   whether a month's Discipline says anything about the next month's results
//      persistence         whether results carry from one quarter to the next (skill or luck), and how
//                          many trades a ranking needs before it is reliable
//   4. improvers           "traders like you who improved", rebuilt from fill histories with the server's
//                          own Bench.buildImprovers, and whether the improvement lasted
//   6. productEffects      members' verified Discipline before and after a first mentor review, duel or
//                          adopted playbook, against members who hadn't had one yet over the same weeks
//   8. marketViews         the sample's positioning per coin by size group and skill tier, how the groups
//                          trade around big price shocks, and whether a tier's net flow led the price
//
// Pure functions, no I/O: research-run.js reads the fills and rebuilds trades with the app's engine,
// social.js gathers members for productEffects. Every interval is a 95% bootstrap over the unit that is
// independent (wallets, members, shocks or days), and every number says how many it rests on.

const Bench = require('./bench.js');

const DAY = 86400000, HOUR = 3600000, WEEK = 7 * DAY;
const SLIPS = ['revenge', 'afterTwo', 'sizeUp', 'addLoser', 'overtrade', 'heldLoser'];
const SLIP_LABEL = { revenge: 'Entered within 15 minutes of a loss', afterTwo: 'Kept trading after two losses in a row', sizeUp: 'Sized up right after a loss',
  addLoser: 'Added to a losing position', overtrade: 'More trades than their usual day', heldLoser: 'Held a loser far longer than their winners' };
// what a slipped trade is compared with: trades of the same wallet that faced the same test and passed it
const SLIP_VS = { revenge: 'entries after a loss that waited 15 minutes', afterTwo: 'the wallet’s other trades', sizeUp: 'entries after a loss at the usual size',
  addLoser: 'positions added to while winning', overtrade: 'the wallet’s other trades', heldLoser: 'losers closed sooner' };
// slips whose comparison is partly built in: a position underwater when it was added to, or a loser held long,
// was already doing worse when the slip happened, so part of the gap would be there without it
const SLIP_MECH = { addLoser: true, heldLoser: true };
const C_BIT = { revenge: 1, sizeUp: 2, addLoser: 4 }; // a trade's chance bits (row[5])
const SIZES = { s1: 'Under $1k', s2: '$1k–10k', s3: '$10k–100k', s4: '$100k+' };
const TIERS = { top: 'Top quarter (skill)', bottom: 'Bottom quarter', mid: 'Middle half' };

/* ---------------- small statistics ---------------- */
const fin = v => typeof v === 'number' && isFinite(v);
const sum = a => a.reduce((s, x) => s + x, 0);
const mean = a => a.length ? sum(a) / a.length : null;
const quant = (s, p) => { if (!s.length) return null; const i = (s.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i); return s[lo] + (s[hi] - s[lo]) * (i - lo); };
const median = a => quant([...a].sort((x, y) => x - y), 0.5);
const sdOf = a => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(sum(a.map(x => (x - m) * (x - m))) / (a.length - 1)); };
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const r1 = v => v == null || !isFinite(v) ? null : Math.round(v * 10) / 10;
const r2 = v => v == null || !isFinite(v) ? null : Math.round(v * 100) / 100;
const r3 = v => v == null || !isFinite(v) ? null : Math.round(v * 1000) / 1000;
const utcDay = ms => new Date(ms).toISOString().slice(0, 10);
const utcMonth = ms => new Date(ms).toISOString().slice(0, 7);
function wmean(vals, ws) { let s = 0, w = 0; for (let i = 0; i < vals.length; i++) if (fin(vals[i])) { s += vals[i] * ws[i]; w += ws[i]; } return w > 0 ? s / w : null; }
function ranks(a) {
  const idx = a.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]), out = new Array(a.length);
  for (let i = 0; i < idx.length;) { let j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++; const r = (i + j) / 2 + 1; for (let k = i; k <= j; k++) out[idx[k][1]] = r; i = j + 1; }
  return out;
}
function pearson(x, y) {
  const n = x.length; if (n < 3) return null; const mx = mean(x), my = mean(y); let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const a = x[i] - mx, b = y[i] - my; sxy += a * b; sxx += a * a; syy += b * b; }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null;
}
const spearman = (x, y) => x.length < 3 ? null : pearson(ranks(x), ranks(y));
// xorshift, seeded: the same data gives the same intervals
function rng(seed) { let s = (seed >>> 0) || 0x9e3779b9; return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; }
// a 95% interval for stat(units) by resampling the independent units with replacement
function boot(units, stat, o) {
  o = o || {}; const n = units.length, v = n ? stat(units) : null; if (v == null || n < 5) return { v: v == null ? null : v, lo: null, hi: null, n };
  const R = rng(o.seed || 7), it = o.iters || 1000, out = [];
  for (let b = 0; b < it; b++) { const s = new Array(n); for (let i = 0; i < n; i++) s[i] = units[Math.floor(R() * n)]; const x = stat(s); if (fin(x)) out.push(x); }
  out.sort((a, b) => a - b);
  return { v, lo: quant(out, 0.025), hi: quant(out, 0.975), n };
}
const est = (b, f) => ({ v: f(b.v), lo: f(b.lo), hi: f(b.hi), n: b.n });
const sure = b => b && b.lo != null && (b.lo > 0 || b.hi < 0); // the interval leaves out zero
const isPerpCoin = c => typeof c === 'string' && c[0] !== '@' && !c.includes('/');

/* ---------------- one wallet, reduced to what the studies read ---------------- */
// trades: the engine's closed trade rows; o: {addr, from, to, cut, fills, pzBehaviorDays, peerSummary, notionalOf, hasAdd}
// -> {addr, from, to, cut, units, rows: [[open, close, net, notional, slipBits, chanceBits]], days: [[key, score, n, slipBits]],
//     hist (weekly Bench snapshots), dims (the latest summary's), size, mk: {coin: {p0, h: [[hour, pos, px, flow, liq]]}}}
function walletRecord(trades, o) {
  const tr = (trades || []).filter(t => t && !t.isOpen && t.closeTime && t.openTime && !t.partialHistory && t.closeTime >= (o.from || 0) && t.closeTime <= (o.to || Infinity))
    .sort((a, b) => a.closeTime - b.closeTime);
  const notional = t => (o.notionalOf ? o.notionalOf(t) : t.maxSize * t.avgEntry) || 0;
  const rec = { addr: o.addr, from: o.from, to: o.to, cut: !!o.cut, units: 1, rows: [], days: [], hist: [], dims: null, size: null, mk: marketOf(o.fills, o.addr) };
  if (!tr.length) return rec;
  const bd = o.pzBehaviorDays ? o.pzBehaviorDays(tr, { dayOf: utcDay, isLoss: x => x < -1 }) : [];
  const flags = new Map(), revT = new Set(), sizeT = new Set();
  for (const d of bd) { for (const s of d.slips || []) flags.set(s.id, s.f); for (const id of (d.tests && d.tests.revenge) || []) revT.add(id); for (const id of (d.tests && d.tests.sizeUp) || []) sizeT.add(id); }
  const nets = tr.map(t => Math.abs(t.net)).filter(x => x > 0); rec.units = median(nets) || 1;
  rec.rows = tr.map(t => { const f = flags.get(t.id) || [];
    let b = 0; SLIPS.forEach((k, i) => { if (f.includes(k)) b |= 1 << i; });
    const c = (revT.has(t.id) ? C_BIT.revenge : 0) | (sizeT.has(t.id) ? C_BIT.sizeUp : 0) | (o.hasAdd && o.hasAdd(t) ? C_BIT.addLoser : 0);
    return [t.openTime, t.closeTime, Math.round(t.net * 100) / 100, Math.round(notional(t)), b, c]; });
  rec.days = bd.map(d => { let b = 0; SLIPS.forEach((k, i) => { if (d.flags && d.flags[k]) b |= 1 << i; }); return [d.key, d.score, d.n, b]; });
  const medN = median(rec.rows.map(r => r[3]).filter(x => x > 0)) || 0;
  rec.size = medN < 1000 ? 's1' : medN < 10000 ? 's2' : medN < 100000 ? 's3' : 's4';
  // weekly 90-day summaries, as the server keeps for "traders like you who improved" (#4)
  if (o.peerSummary) {
    const sd = rec.days.map(d => ({ k: d[0], f: SLIPS.filter((k, i) => d[3] & (1 << i)) })), firstAt = o.firstAt || tr[0].openTime;
    for (let w = Bench.weekOf((o.from || tr[0].openTime) + 90 * DAY) + 1; w <= Bench.weekOf(o.to || Date.now()); w++) {
      const at = Math.min((w + 1) * WEEK - 1, o.to || Infinity), s = o.peerSummary(tr, { now: at, dayOf: utcDay, firstAt, minTrades: 15, days: 90 });
      const row = s && s.ok ? Bench.sanitizeBench(s) : null; if (!row) continue;
      rec.hist.push(Bench.histSnap(row, at, Bench.slipRates(sd, at))); rec.dims = { style: row.style, size: row.size, exp: row.exp, act: row.act, n: row.n, at };
    }
  }
  return rec;
}
// perp fills -> per coin: the position before the first fill (p0; it held from the window's start) and, per
// hour with fills, the position after the hour's last fill, its price, the signed notional traded, liquidations
function marketOf(fills, addr) {
  const mk = {}, a = String(addr || '').toLowerCase();
  for (const f of (Array.isArray(fills) ? fills : []).slice().sort((x, y) => x.time - y.time)) {
    if (!f || !isPerpCoin(f.coin)) continue; const sz = +f.sz, px = +f.px, st = +f.startPosition; if (!(sz > 0) || !(px > 0) || !isFinite(st)) continue;
    const sg = f.side === 'B' ? 1 : -1, h = Math.floor(f.time / HOUR) * HOUR, liq = f.liquidation && String(f.liquidation.liquidatedUser || '').toLowerCase() === a ? 1 : 0;
    let c = mk[f.coin]; if (!c) c = mk[f.coin] = { p0: st, h: [] };
    const last = c.h[c.h.length - 1];
    if (last && last[0] === h) { last[1] = st + sg * sz; last[2] = px; last[3] += sg * sz * px; last[4] += liq; }
    else c.h.push([h, st + sg * sz, px, sg * sz * px, liq]);
  }
  for (const c of Object.values(mk)) for (const e of c.h) { e[1] = +e[1].toPrecision(10); e[3] = Math.round(e[3]); }
  return mk;
}

/* ---------------- 1 · what each slip costs ---------------- */
const bpsOf = row => row[3] > 0 ? clamp(row[2] / row[3] * 1e4, -2000, 2000) : null;
const rOf = (row, u) => clamp(row[2] / u, -20, 20);
const winOf = row => row[2] > 1 ? 1 : row[2] < -1 ? 0 : null;
function inChance(k, row) {
  if (k === 'revenge' || k === 'sizeUp' || k === 'addLoser') return !!(row[5] & C_BIT[k]);
  if (k === 'heldLoser') return row[2] < -1;
  return true; // afterTwo, overtrade: the alternative was not taking the trade
}
function slipCosts(records, o) {
  o = Object.assign({ minEach: 2, iters: 1000 }, o || {}); const out = {};
  SLIPS.forEach((k, i) => {
    const bit = 1 << i, per = []; let chances = 0, slipped = 0;
    for (const r of records) {
      const C = r.rows.filter(row => inChance(k, row)), S = C.filter(row => row[4] & bit), K = C.filter(row => !(row[4] & bit));
      chances += C.length; slipped += S.length;
      if (S.length < o.minEach || K.length < o.minEach) continue;
      const m = (set, f) => mean(set.map(f).filter(fin)), u = r.units;
      const dR = m(S, x => rOf(x, u)) - m(K, x => rOf(x, u)), dB = m(S, bpsOf) != null && m(K, bpsOf) != null ? m(S, bpsOf) - m(K, bpsOf) : null;
      const wS = m(S, winOf), wK = m(K, winOf);
      per.push({ R: dR, bps: dB, win: wS != null && wK != null ? 100 * (wS - wK) : null, w: 1 / (1 / S.length + 1 / K.length), nS: S.length,
        // what the slips took from the wallet over every 100 of its trades, in its typical trade (R)
        per100: dR * S.length / r.rows.length * 100, meanS: m(S, x => rOf(x, u)) });
    }
    const agg = f => boot(per, s => wmean(s.map(f), s.map(x => x.w)), { iters: o.iters, seed: 11 + i });
    out[k] = { key: k, label: SLIP_LABEL[k], vs: SLIP_VS[k], wallets: per.length, chances, slipped, rate: chances ? r1(100 * slipped / chances) : null,
      R: est(agg(x => x.R), r2), bps: est(agg(x => x.bps), r1), win: est(agg(x => x.win), r1),
      slippedR: est(agg(x => x.meanS), r2), // the slipped trades' own average, in R: what not taking them would have saved (afterTwo, overtrade)
      worse: per.length ? r1(100 * per.filter(x => x.R < 0).length / per.length) : null, per100: r2(median(per.map(x => x.per100))) };
  });
  const ranked = Object.values(out).filter(x => x.wallets >= 10 && x.R.v != null).sort((a, b) => a.R.v * a.rate - b.R.v * b.rate);
  return { slips: out, order: ranked.map(x => x.key), text: ranked.map(slipSentence) };
}
function slipSentence(x) {
  const cost = x.R.v < 0 ? 'did ' + Math.abs(x.R.v).toFixed(2) + ' of a typical trade worse' : 'did ' + x.R.v.toFixed(2) + ' of a typical trade better';
  return x.label + ' (' + x.rate + '% of chances): the same trader ' + cost + ' than on ' + x.vs + ' (' + fmtCI(x.R) + ', ' + x.wallets + ' wallets'
    + (sure(x.R) ? '' : '; not distinguishable from zero') + ').' + (SLIP_MECH[x.key] ? ' Part of this gap is built in: those trades were already losing when the slip happened.' : '');
}
const fmtCI = b => b.lo == null ? 'too few to bound' : '95% ' + b.lo + ' to ' + b.hi;

/* ---------------- 2 · does Discipline predict next month, and do results persist? ---------------- */
function monthsOf(r, minTrades) {
  const by = new Map();
  for (const row of r.rows) { const k = utcMonth(row[1]); if (!by.has(k)) by.set(k, { rows: [], days: [] }); by.get(k).rows.push(row); }
  for (const d of r.days) { const k = d[0].slice(0, 7); if (by.has(k)) by.get(k).days.push(d); }
  const out = new Map();
  for (const [k, v] of by) {
    const start = Date.parse(k + '-01T00:00:00Z'), end = Date.parse(utcMonth(start + 32 * DAY) + '-01T00:00:00Z');
    if (start < r.from || end > r.to) continue; // whole months only
    out.set(k, Object.assign({ k, n: v.rows.length, ok: v.rows.length >= minTrades }, windowStats(v.rows, v.days, r.units)));
  }
  return out;
}
// the measures a window of trades gives: profit factor, win rate, average bps and R, sharpe of R, dollars, Discipline
function windowStats(rows, days, u) {
  const net = rows.map(x => x[2]), W = net.filter(x => x > 1), L = net.filter(x => x < -1), gw = sum(W), gl = -sum(L), R = rows.map(x => rOf(x, u)), B = rows.map(bpsOf).filter(fin);
  const sdR = sdOf(R);
  return { pf: gl > 0 ? Math.min(10, gw / gl) : gw > 0 ? 10 : null, wr: W.length + L.length ? 100 * W.length / (W.length + L.length) : null, bps: mean(B), R: mean(R),
    sharpe: sdR > 0 ? mean(R) / sdR : null, pnl: sum(net), disc: days && days.length ? mean(days.map(d => d[1])) : null };
}
const nextMonth = k => utcMonth(Date.parse(k + '-15T00:00:00Z') + 31 * DAY);
function disciplineForward(records, o) {
  o = Object.assign({ minTrades: 10, minNext: 5, iters: 1000 }, o || {});
  const pairs = []; // [wallet, disc_t, R_t, R_t+1, profitable_t+1, bps_t+1]
  records.forEach((r, wi) => { const M = monthsOf(r, o.minTrades);
    for (const [k, m] of M) { const nx = M.get(nextMonth(k)); if (!m.ok || !nx || nx.n < o.minNext || m.disc == null) continue;
      pairs.push({ w: wi, disc: m.disc, R: m.R, nR: nx.R, nProf: nx.pnl > 0 ? 1 : 0, nBps: nx.bps, nDisc: nx.disc }); } });
  const byW = new Map(); for (const p of pairs) { if (!byW.has(p.w)) byW.set(p.w, []); byW.get(p.w).push(p); }
  const units = [...byW.values()]; // resampled by wallet: one wallet's months aren't independent
  const flat = s => s.flat();
  const rho = (fx, fy, seed) => boot(units, s => { const p = flat(s).filter(q => fin(fx(q)) && fin(fy(q))); return spearman(p.map(fx), p.map(fy)); }, { iters: o.iters, seed });
  // within a wallet: a month more disciplined than the trader's own usual, followed by a better month than usual?
  const within = boot(units.filter(u => u.length >= 3), s => { const x = [], y = [];
    for (const u of s) { const md = mean(u.map(p => p.disc)), mr = mean(u.map(p => p.nR)); for (const p of u) { x.push(p.disc - md); y.push(p.nR - mr); } }
    return pearson(x, y); }, { iters: o.iters, seed: 23 });
  // the same inside a wallet, holding this month's results fixed: a losing month gives more chances to slip
  // (revenge, trading on after two losses) and results drift back toward the trader's usual next month
  const withinBeyond = boot(units.filter(u => u.length >= 3), s => { const x = [], z = [], y = [];
    for (const u of s) { const md = mean(u.map(p => p.disc)), mr = mean(u.map(p => p.R)), mn = mean(u.map(p => p.nR));
      for (const p of u) { x.push(p.disc - md); z.push(p.R - mr); y.push(p.nR - mn); } }
    return x.length >= 20 ? ols2(x, z, y)[0] : null; }, { iters: o.iters, seed: 27 });
  // both at once, on ranks: does Discipline say anything that this month's results don't already?
  const both = boot(units, s => { const p = flat(s); if (p.length < 20) return null; return ols2(ranks(p.map(q => q.disc)), ranks(p.map(q => q.R)), ranks(p.map(q => q.nR)))[0]; }, { iters: o.iters, seed: 29 });
  const q = []; const sorted = [...pairs].sort((a, b) => a.disc - b.disc);
  for (let i = 0; i < 5; i++) { const s = sorted.slice(Math.floor(i * sorted.length / 5), Math.floor((i + 1) * sorted.length / 5)); if (!s.length) continue;
    q.push({ q: i + 1, disc: [r1(s[0].disc), r1(s[s.length - 1].disc)], n: s.length, nextR: r2(mean(s.map(p => p.nR))), nextProfitable: r1(100 * mean(s.map(p => p.nProf))), nextBps: r1(mean(s.map(p => p.nBps).filter(fin))) }); }
  const out = { months: pairs.length, wallets: units.length,
    disc: est(rho(p => p.disc, p => p.nR, 31), r3), discProfitable: est(rho(p => p.disc, p => p.nProf, 37), r3),
    results: est(rho(p => p.R, p => p.nR, 41), r3), discSelf: est(rho(p => p.disc, p => p.nDisc, 43), r3),
    within: est(within, r3), withinBeyond: est(withinBeyond, r3), beyondResults: est(both, r3), quintiles: q };
  out.text = [
    'A month’s Discipline against the next month’s results (average trade in R): rank correlation ' + out.disc.v + ' (' + fmtCI(out.disc) + '), over ' + out.months + ' wallet-months from ' + out.wallets + ' wallets.',
    'This month’s results against next month’s: ' + out.results.v + ' (' + fmtCI(out.results) + '). Discipline against next month’s Discipline: ' + out.discSelf.v + '.',
    'Beyond this month’s results, Discipline’s own weight on next month: ' + out.beyondResults.v + ' (' + fmtCI(out.beyondResults) + ').',
    'Inside a wallet, a more disciplined month than the trader’s usual and the next month’s results: ' + out.within.v + ' (' + fmtCI(out.within) + '); holding that month’s own results fixed: '
      + out.withinBeyond.v + ' (' + fmtCI(out.withinBeyond) + ').',
  ];
  return out;
}
// least squares y ~ a + b1·x1 + b2·x2 on standardized inputs -> [b1, b2]
function ols2(x1, x2, y) {
  const z = a => { const m = mean(a), s = sdOf(a) || 1; return a.map(v => (v - m) / s); };
  const A = z(x1), B = z(x2), Y = z(y); let aa = 0, bb = 0, ab = 0, ay = 0, by = 0;
  for (let i = 0; i < Y.length; i++) { aa += A[i] * A[i]; bb += B[i] * B[i]; ab += A[i] * B[i]; ay += A[i] * Y[i]; by += B[i] * Y[i]; }
  const det = aa * bb - ab * ab; if (!(Math.abs(det) > 1e-9)) return [null, null];
  return [(ay * bb - by * ab) / det, (by * aa - ay * ab) / det];
}
const PERSIST = { pf: 'Profit factor', wr: 'Win rate', R: 'Average trade (R)', bps: 'Average trade (bps of size)', sharpe: 'Average ÷ spread of trades', pnl: 'Dollar P&L', disc: 'Discipline' };
function persistence(records, o) {
  o = Object.assign({ minTrades: 20, days: 90, iters: 1000 }, o || {});
  const to = Math.max(...records.map(r => r.to || 0)), Q = o.days * DAY, units = [];
  for (const r of records) {
    if (!(r.from <= to - 2 * Q + DAY)) continue;
    const a = r.rows.filter(x => x[1] > to - 2 * Q && x[1] <= to - Q), b = r.rows.filter(x => x[1] > to - Q && x[1] <= to);
    if (a.length < o.minTrades || b.length < o.minTrades) continue;
    const dA = r.days.filter(d => d[0] > utcDay(to - 2 * Q) && d[0] <= utcDay(to - Q)), dB = r.days.filter(d => d[0] > utcDay(to - Q));
    units.push({ a: windowStats(a, dA, r.units), b: windowStats(b, dB, r.units) });
  }
  const metrics = {};
  Object.keys(PERSIST).forEach((k, i) => {
    const has = units.filter(u => fin(u.a[k]) && fin(u.b[k]));
    const rho = boot(has, s => spearman(s.map(u => u.a[k]), s.map(u => u.b[k])), { iters: o.iters, seed: 51 + i });
    // stickiness: of the top (bottom) quarter in the first quarter-year, how many are still there in the next
    let top = null, bottom = null;
    if (has.length >= 20) { const sa = has.map(u => u.a[k]).sort((x, y) => x - y), sb = has.map(u => u.b[k]).sort((x, y) => x - y);
      const qa = [quant(sa, 0.25), quant(sa, 0.75)], qb = [quant(sb, 0.25), quant(sb, 0.75)];
      const T = has.filter(u => u.a[k] > qa[1]), Bt = has.filter(u => u.a[k] < qa[0]);
      top = T.length ? r1(100 * T.filter(u => u.b[k] > qb[1]).length / T.length) : null; bottom = Bt.length ? r1(100 * Bt.filter(u => u.b[k] < qb[0]).length / Bt.length) : null; }
    metrics[k] = { key: k, label: PERSIST[k], n: has.length, rho: est(rho, r3), topStays: top, bottomStays: bottom };
  });
  const rel = reliability(records, o);
  const out = { wallets: units.length, days: o.days, metrics, reliability: rel };
  out.text = Object.values(metrics).filter(m => m.n >= 20).map(m => m.label + ': quarter-to-quarter rank correlation ' + m.rho.v + ' (' + fmtCI(m.rho) + ', ' + m.n + ' wallets); '
    + m.topStays + '% of the top quarter stayed there (25% by chance).')
    .concat(Object.values(rel).filter(x => x.need).map(x => x.label + ': a ranking as reliable as 0.7 needs about ' + x.need + ' trades a trader.'));
  return out;
}
// split-half reliability: each wallet's trades alternately in two halves; how well one half ranks wallets like
// the other, by how many trades they have, then (Spearman–Brown) how many trades a reliable ranking needs
function reliability(records, o) {
  const B = [[20, 50], [50, 100], [100, 250], [250, Infinity]], out = {};
  ['pf', 'wr', 'R', 'bps', 'sharpe'].forEach(k => {
    const buckets = [];
    for (const [lo, hi] of B) {
      const pts = [];
      for (const r of records) { const n = r.rows.length; if (n < lo || n >= hi) continue;
        const h1 = r.rows.filter((_, i) => i % 2 === 0), h2 = r.rows.filter((_, i) => i % 2 === 1), a = windowStats(h1, null, r.units)[k], b = windowStats(h2, null, r.units)[k];
        if (fin(a) && fin(b)) pts.push([a, b, n]); }
      if (pts.length < 15) { buckets.push({ trades: [lo, hi === Infinity ? null : hi], n: pts.length, half: null }); continue; }
      const rh = spearman(pts.map(p => p[0]), pts.map(p => p[1])), half = median(pts.map(p => p[2])) / 2;
      const per = rh > 0 ? rh / (half - (half - 1) * rh) : null; // one trade's reliability, from the half's
      buckets.push({ trades: [lo, hi === Infinity ? null : hi], n: pts.length, half: r3(rh), full: rh != null ? r3(2 * rh / (1 + rh)) : null, per });
    }
    const ok = buckets.filter(b => b.per > 0), per = ok.length ? sum(ok.map(b => b.per * b.n)) / sum(ok.map(b => b.n)) : null;
    const need = per > 0 ? Math.ceil(0.7 * (1 - per) / (per * 0.3)) : null;
    for (const b of buckets) delete b.per;
    out[k] = { key: k, label: PERSIST[k], buckets, perTrade: r3(per), need: need && need < 1e6 ? need : null };
  });
  return out;
}

/* ---------------- 4 · traders like you who improved, from fill histories ---------------- */
function improvers(records, o) {
  o = Object.assign({ min: 25 }, o || {});
  const at = Math.max(...records.map(r => r.to || 0)), curW = Bench.weekOf(at);
  const live = records.filter(r => r.hist.length && r.dims && Bench.weekOf(r.dims.at) >= curW - 3);
  const rows = live.map(r => { const s = r.hist[r.hist.length - 1], row = Object.assign({}, r.dims); for (const k of Bench.HIST_KEYS) row[k] = Bench.histVal(s, k); return row; });
  const cfg = Object.assign({}, Bench.DEFAULTS, { min: o.min });
  const B = Bench.buildBenchmarks(rows, cfg, at);
  const imp = Bench.buildImprovers(live.map(r => ({ dims: r.dims, hist: r.hist })), B, cfg, at);
  const groups = Object.entries(imp).filter(([, g]) => g.changes.length).map(([key, g]) => ({ key, panel: g.panel, n: g.n, nOthers: g.nOthers, changes: g.changes }))
    .sort((a, b) => a.key === 'all' ? -1 : b.key === 'all' ? 1 : b.panel - a.panel);
  // did it last? improvers 12 weeks ago (bottom half → top half over the 8–12 weeks before), and where they are now
  const at1 = curW - 12, snapAt = (h, lo, hi) => { let s = null; for (const x of h) if (x[0] >= lo && x[0] <= hi) s = x; return s; };
  const lasting = {};
  for (const k of ['disc', 'pf']) {
    const P = [];
    for (const r of records) { const a = snapAt(r.hist, at1 - 12, at1 - 8), b = snapAt(r.hist, at1 - 1, at1), c = snapAt(r.hist, curW - 3, curW);
      const va = a && Bench.histVal(a, k), vb = b && Bench.histVal(b, k), vc = c && Bench.histVal(c, k); if (fin(va) && fin(vb) && fin(vc)) P.push([va, vb, vc]); }
    if (P.length < 40) { lasting[k] = { n: P.length }; continue; }
    const ma = median(P.map(p => p[0])), mb = median(P.map(p => p[1])), mc = median(P.map(p => p[2]));
    const share = set => set.length ? { n: set.length, aboveNow: r1(100 * set.filter(p => p[2] > mc).length / set.length) } : { n: 0, aboveNow: null };
    lasting[k] = { n: P.length, improvers: share(P.filter(p => p[0] < ma && p[1] > mb)), stayedTop: share(P.filter(p => p[0] > ma && p[1] > mb)),
      faded: share(P.filter(p => p[0] > ma && p[1] < mb)), stayedBottom: share(P.filter(p => p[0] < ma && p[1] < mb)) };
  }
  const all = groups.find(g => g.key === 'all'), L = lasting;
  const text = (all ? all.changes.slice(0, 4).map(c => c.text + ' (improvers ' + c.improversDelta + ' vs others ' + c.othersDelta + ', effect ' + c.effect + ')') : ['No change stood out for the whole sample.'])
    .concat(['disc', 'pf'].filter(k => L[k].improvers && L[k].improvers.n).map(k => (k === 'disc' ? 'Discipline' : 'Profit factor') + ' improvers 12 weeks later: ' + L[k].improvers.aboveNow + '% still in the top half (stayed-top '
      + L[k].stayedTop.aboveNow + '%, stayed-bottom ' + L[k].stayedBottom.aboveNow + '%; ' + L[k].improvers.n + ' improvers).'));
  return { at, contributors: rows.length, groupsBuilt: Object.keys(B.groups).length, withHistory: records.filter(r => r.hist.length >= 2).length, groups, lasting, text };
}

/* ---------------- 6 · does the product work? (members) ---------------- */
// members: [{id, days: [{k, s, f}], exposures: {mentor: ms, duel: ms, playbook: ms, …}}] — days are the verified
// Discipline the server reads from fills (or the app's, flagged by the caller). For each first exposure, the
// member's Discipline in the 28 days after against the 28 before, minus the same change for members who hadn't
// had that exposure by then (difference in differences, the same calendar weeks).
const EXPOSURES = { mentor: 'First mentor review', duel: 'First duel', playbook: 'First adopted playbook', pod: 'First accountability pod', partner: 'First accountability partner' };
function productEffects(members, o) {
  o = Object.assign({ window: 28, minDays: 4, minControls: 3, iters: 1000 }, o || {});
  const W = o.window * DAY, slipped = d => Array.isArray(d.f) && d.f.length > 0;
  // each member's days sorted by key with running sums, so a window's average is two binary searches
  const M = (members || []).filter(m => m && Array.isArray(m.days) && m.days.length).map(m => {
    const ds = m.days.filter(d => d && typeof d.k === 'string' && fin(d.s)).sort((a, b) => a.k < b.k ? -1 : a.k > b.k ? 1 : 0), ks = ds.map(d => d.k), cs = [0], cf = [0];
    for (const d of ds) { cs.push(cs[cs.length - 1] + d.s); cf.push(cf[cf.length - 1] + (slipped(d) ? 1 : 0)); }
    return { id: m.id, exposures: m.exposures || {}, ks, cs, cf }; }).filter(m => m.ks.length);
  const lower = (a, k) => { let lo = 0, hi = a.length; while (lo < hi) { const md = (lo + hi) >> 1; if (a[md] < k) lo = md + 1; else hi = md; } return lo; };
  const span = (m, lo, hi) => { const i = lower(m.ks, utcDay(lo)), j = lower(m.ks, utcDay(hi) + '~'); const n = j - i; return n > 0 ? { n, s: (m.cs[j] - m.cs[i]) / n, f: (m.cf[j] - m.cf[i]) / n } : { n: 0 }; };
  const delta = (m, E) => { const b = span(m, E - W, E - DAY), a = span(m, E + DAY, E + W);
    if (b.n < o.minDays || a.n < o.minDays) return null;
    return { s: a.s - b.s, slip: 100 * (a.f - b.f), before: b.s }; };
  const out = {};
  for (const k of Object.keys(EXPOSURES)) {
    const exposed = M.filter(m => m.exposures && fin(m.exposures[k])), units = [];
    for (const m of exposed) {
      const E = m.exposures[k], d = delta(m, E); if (!d) continue;
      const ctrl = M.filter(c => c !== m && !(c.exposures && fin(c.exposures[k]) && c.exposures[k] <= E + W)).map(c => delta(c, E)).filter(Boolean);
      if (ctrl.length < o.minControls) continue;
      units.push({ did: d.s - mean(ctrl.map(c => c.s)), didSlip: d.slip - mean(ctrl.map(c => c.slip)), raw: d.s, before: d.before, ctrl: ctrl.length });
    }
    const b = boot(units, s => mean(s.map(u => u.did)), { iters: o.iters, seed: 61 }), bs = boot(units, s => mean(s.map(u => u.didSlip)), { iters: o.iters, seed: 67 });
    out[k] = { key: k, label: EXPOSURES[k], exposed: exposed.length, measured: units.length, did: est(b, r1), didSlip: est(bs, r1),
      raw: r1(mean(units.map(u => u.raw))), before: r1(mean(units.map(u => u.before))), controls: units.length ? Math.round(median(units.map(u => u.ctrl))) : null };
  }
  const text = Object.values(out).filter(x => x.measured).map(x => x.label + ': Discipline ' + (x.did.v >= 0 ? '+' : '') + x.did.v + ' points over the next ' + o.window
    + ' days against members who hadn’t had one yet (' + fmtCI(x.did) + ', ' + x.measured + ' members' + (sure(x.did) ? '' : '; not distinguishable from zero') + ').');
  return { window: o.window, members: M.length, effects: out, text, note: 'Members choose these themselves, so a difference is what followed, not proof of what caused it.' };
}

/* ---------------- 8 · market views ---------------- */
function marketCoins(records, o) {
  const n = new Map(); for (const r of records) for (const c of Object.keys(r.mk || {})) n.set(c, (n.get(c) || 0) + 1);
  return [...n.entries()].sort((a, b) => b[1] - a[1]).slice(0, (o && o.top) || 12).map(x => x[0]);
}
function spanOf(records) {
  const fr = records.map(r => r.from).filter(fin), to = records.map(r => r.to).filter(fin);
  return { from: fr.length ? Math.floor(median(fr) / HOUR) * HOUR : 0, to: to.length ? Math.ceil(Math.max(...to) / HOUR) * HOUR : 0 };
}
// skill tiers set on the first half of the span only, so what the tiers do in the second half is out of sample
function skillTiers(records, mid, o) {
  o = Object.assign({ minTrades: 20, prior: 20 }, o || {});
  const scored = [];
  records.forEach((r, i) => { const pre = r.rows.filter(x => x[1] < mid); if (pre.length < o.minTrades) return;
    scored.push([i, sum(pre.map(x => rOf(x, r.units))) / (pre.length + o.prior)]); });
  const s = scored.map(x => x[1]).sort((a, b) => a - b), lo = quant(s, 0.25), hi = quant(s, 0.75), tier = new Map();
  for (const [i, v] of scored) tier.set(i, v >= hi ? 'top' : v <= lo ? 'bottom' : 'mid');
  // the check: each tier's average trade after the midpoint
  const check = {}; for (const t of Object.keys(TIERS)) { const R = [];
    tier.forEach((v, i) => { if (v !== t) return; const r = records[i], post = r.rows.filter(x => x[1] >= mid); if (post.length >= 5) R.push(mean(post.map(x => rOf(x, r.units)))); });
    check[t] = { wallets: R.length, afterR: r2(median(R)) }; }
  return { tier, rated: scored.length, check };
}
function posAt(c, t) { // the position held at time t (units), from the hourly events
  const h = c.h; if (!h.length || t < h[0][0]) return c.p0; let lo = 0, hi = h.length - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (h[m][0] <= t) lo = m; else hi = m - 1; } return h[lo][1];
}
// the wallet's own last fill price at or before t (its first, before any): for coins without candles
function lastPx(c, t) { const h = c.h; if (!h.length) return 0; let px = h[0][2]; for (const e of h) { if (e[0] > t) break; px = e[2]; } return px; }
// the close of the last hourly candle opened at or before t; null before the first (the exchange serves the newest 5,000)
function priceAt(rows, t) { if (!rows || !rows.length || t < rows[0][0]) return null; let lo = 0, hi = rows.length - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (rows[m][0] <= t) lo = m; else hi = m - 1; } return rows[lo][1]; }
function marketViews(records, prices, o) {
  o = Object.assign({ top: 12, shockPct: 0.995, gapH: 24, iters: 1000 }, o || {});
  const coins = marketCoins(records, o), span = spanOf(records), mid = span.from + (span.to - span.from) / 2;
  const T = skillTiers(records, mid), groupOf = i => ({ size: records[i].size || 's1', tier: T.tier.get(i) || null });
  // a · positioning, weekly, per coin: wallets long and short, and net notional by size group and by tier
  const positioning = {};
  for (const c of coins) {
    const px = prices && prices[c], series = [];
    for (let t = span.from + WEEK; t <= span.to; t += WEEK) {
      const p = priceAt(px, t); let longs = 0, shorts = 0; const bySize = { s1: 0, s2: 0, s3: 0, s4: 0 }, byTier = { top: 0, mid: 0, bottom: 0 }, tierL = { top: [0, 0], mid: [0, 0], bottom: [0, 0] };
      records.forEach((r, i) => { const m = r.mk[c]; if (!m || t < r.from) return; const q = posAt(m, t); if (!q) return;
        const val = q * (p || lastPx(m, t)), g = groupOf(i);
        if (q > 0) longs++; else shorts++; bySize[g.size] += val; if (g.tier) { byTier[g.tier] += val; tierL[g.tier][q > 0 ? 0 : 1]++; } });
      series.push({ t, longs, shorts, longShare: longs + shorts ? r1(100 * longs / (longs + shorts)) : null, bySize: mapR(bySize), byTier: mapR(byTier),
        tierLongShare: Object.fromEntries(Object.entries(tierL).map(([k, [l, s]]) => [k, l + s ? r1(100 * l / (l + s)) : null])) });
    }
    positioning[c] = { holders: records.filter(r => r.mk[c]).length, series };
  }
  // hourly flow per coin per group, for the shocks and the flow → price test
  const flows = {}; // coin -> group -> Map(hour -> flow)
  for (const c of coins) { const F = flows[c] = {};
    records.forEach((r, i) => { const m = r.mk[c]; if (!m) return; const g = groupOf(i), keys = ['all', 'size:' + g.size].concat(g.tier ? ['tier:' + g.tier] : []);
      for (const e of m.h) for (const k of keys) { const M = F[k] || (F[k] = new Map()); M.set(e[0], (M.get(e[0]) || 0) + e[3]); } }); }
  const GROUPS = ['all', 'size:s1', 'size:s2', 'size:s3', 'size:s4', 'tier:top', 'tier:mid', 'tier:bottom'];
  // b · big hourly moves (the top 0.5% by size per coin, a day apart): flow against the move before, in and after
  const shocks = [];
  for (const c of coins) {
    const px = prices && prices[c]; if (!px || px.length < 200) continue;
    const ret = []; for (let i = 1; i < px.length; i++) if (px[i][0] - px[i - 1][0] === HOUR) ret.push([px[i][0], Math.log(px[i][1] / px[i - 1][1])]);
    const cut = quant(ret.map(x => Math.abs(x[1])).sort((a, b) => a - b), o.shockPct); let lastT = -Infinity;
    const hourSd = {}; for (const g of GROUPS) { const M = flows[c][g]; const v = M ? [...M.values()].map(Math.abs) : []; hourSd[g] = v.length ? sum(v) / ((span.to - span.from) / HOUR) : 0; }
    for (const [t, x] of [...ret].sort((a, b) => a[0] - b[0])) {
      // a candle's time is its open: the move happened over [t, t+1h)
      if (Math.abs(x) < cut || t - lastT < o.gapH * HOUR || t < span.from + DAY || t > span.to - DAY) continue; lastT = t;
      const dir = Math.sign(x), win = (M, a, b) => { let s = 0; for (let h = a; h <= b; h += HOUR) s += (M && M.get(h)) || 0; return s; };
      const ev = { coin: c, t, move: r2(100 * (Math.exp(x) - 1)), after: r2(100 * (priceAt(px, t + 24 * HOUR) / priceAt(px, t) - 1) * dir), g: {} };
      for (const g of GROUPS) { const M = flows[c][g], u = hourSd[g]; if (!M || !(u > 0)) continue;
        ev.g[g] = { before: -dir * win(M, t - 24 * HOUR, t - HOUR) / u, during: -dir * win(M, t, t) / u, after: -dir * win(M, t + HOUR, t + 24 * HOUR) / u }; }
      ev.liq = records.reduce((s, r) => s + ((r.mk[c] && r.mk[c].h.filter(e => e[0] >= t - HOUR && e[0] <= t + 2 * HOUR).reduce((a, e) => a + e[4], 0)) || 0), 0);
      shocks.push(ev);
    }
  }
  const shockAgg = {}; GROUPS.forEach((g, gi) => { const s = shocks.filter(e => e.g[g]); shockAgg[g] = {};
    for (const w of ['before', 'during', 'after']) shockAgg[g][w] = est(boot(s, a => mean(a.map(e => e.g[g][w])), { iters: o.iters, seed: 71 + gi }), r2); });
  const cont = boot(shocks, a => mean(a.map(e => e.after).filter(fin)), { seed: 79 });
  // c · after the midpoint (tiers set before it): a day's net flow per tier against the next day's price move
  const lead = {};
  for (const g of ['all', 'tier:top', 'tier:mid', 'tier:bottom']) {
    const pts = [];
    for (const c of coins) { const px = prices && prices[c], M = flows[c][g]; if (!px || !M) continue;
      const daily = new Map(); for (const [h, f] of M) if (h >= mid) { const d = Math.floor(h / DAY) * DAY; daily.set(d, (daily.get(d) || 0) + f); }
      const sd = sdOf([...daily.values()]); if (!(sd > 0)) continue;
      for (const [d, f] of daily) { const p0 = priceAt(px, d + DAY - HOUR), p1 = priceAt(px, d + 2 * DAY - HOUR), pm = priceAt(px, d - HOUR);
        if (!(p0 > 0 && p1 > 0 && pm > 0) || d + 2 * DAY > span.to) continue; pts.push({ d, x: f / sd, next: Math.log(p1 / p0), same: Math.log(p0 / pm) }); } }
    const byDay = new Map(); for (const p of pts) { if (!byDay.has(p.d)) byDay.set(p.d, []); byDay.get(p.d).push(p); }
    const units = [...byDay.values()];
    const rho = f => boot(units, s => { const a = s.flat(); return spearman(a.map(p => p.x), a.map(f)); }, { iters: o.iters, seed: 83 });
    const nz = pts.filter(p => p.x !== 0 && p.next !== 0);
    lead[g] = { points: pts.length, days: units.length, next: est(rho(p => p.next), r3), same: est(rho(p => p.same), r3), hit: nz.length ? r1(100 * nz.filter(p => Math.sign(p.x) === Math.sign(p.next)).length / nz.length) : null };
  }
  const lbl = g => g === 'all' ? 'Everyone' : g.startsWith('size:') ? 'Trades ' + SIZES[g.slice(5)] : TIERS[g.slice(5)];
  const text = [];
  if (shocks.length) text.push(shocks.length + ' big hourly moves across ' + coins.length + ' coins; over the next 24 hours the move went on by ' + r2(cont.v) + '% on average (' + fmtCI(est(cont, r2)) + '; negative is a bounce).');
  for (const g of GROUPS) { const a = shockAgg[g].after; if (a.n >= 10) text.push(lbl(g) + ': in the 24 hours after a big move, flow against it ' + a.v + ' typical hours (' + fmtCI(a) + '; positive is buying drops and selling spikes).'); }
  for (const g of Object.keys(lead)) { const L = lead[g]; if (L.points >= 50) text.push(lbl(g) + ': a day’s net flow and the next day’s move, rank correlation ' + L.next.v + ' (' + fmtCI(L.next) + '), same day ' + L.same.v + '; direction right ' + L.hit + '% of the time.'); }
  return { coins, span, mid, tiers: { rated: T.rated, check: T.check }, positioning, shocks: { n: shocks.length, continued: est(cont, r2), groups: shockAgg, labels: Object.fromEntries(GROUPS.map(g => [g, lbl(g)])), list: shocks.slice(-40).map(e => ({ coin: e.coin, t: e.t, move: e.move, after: e.after, liq: e.liq })) }, lead, text };
}
const mapR = m => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, Math.round(v)]));

/* ---------------- the whole report ---------------- */
function buildReport(records, o) {
  o = o || {}; const withTrades = records.filter(r => r.rows.length);
  const rep = { at: Date.now(), sample: { wallets: records.length, withTrades: withTrades.length, trades: sum(records.map(r => r.rows.length)), cut: records.filter(r => r.cut).length,
    bots: o.bots || 0, empty: o.empty || 0, frame: o.frame || null, span: spanOf(records),
    sizes: Object.fromEntries(Object.keys(SIZES).map(s => [s, withTrades.filter(r => r.size === s).length])) } };
  rep.slips = slipCosts(withTrades, o);
  rep.forward = disciplineForward(withTrades, o);
  rep.persistence = persistence(withTrades, o);
  rep.improvers = improvers(withTrades, o);
  rep.market = marketViews(records, o.prices || {}, o);
  if (o.members) rep.effects = productEffects(o.members, o);
  rep.notes = [
    'Wallets are drawn at random from Hyperliquid’s leaderboard of accounts that traded in the last month (or the list given); accounts that stopped before that are missing, so blow-ups are under-counted.',
    'The exchange serves an address’s newest 10,000 fills; a wallet that hit that has a shorter window (' + rep.sample.cut + ' did). Wallets with more than 20,000 fills are left out as bots or market makers.',
    'R is a wallet’s typical trade: its median absolute trade result. bps are of the trade’s size. Intervals are 95%, resampling wallets (or shocks, or days).',
    'Everything here is correlation in public data. Slip costs compare a trader with themselves in the same situation, which is the closest this gets to cause.',
  ];
  return rep;
}
function reportText(rep) {
  const sec = (t, lines) => lines && lines.length ? '■ ' + t + '\n' + lines.map(l => '  · ' + l).join('\n') : '';
  return [
    'Sample: ' + rep.sample.wallets + ' wallets (' + rep.sample.withTrades + ' with closed trades, ' + rep.sample.trades + ' trades; ' + rep.sample.bots + ' bots left out).',
    sec('1 · What each slip costs', rep.slips.text), sec('2 · Discipline and next month', rep.forward.text), sec('2 · Skill or luck', rep.persistence.text),
    sec('4 · Traders who improved', rep.improvers.text), rep.effects ? sec('6 · Does the product work', rep.effects.text) : '', sec('8 · Market views', rep.market.text),
  ].filter(Boolean).join('\n\n');
}

/* ---------------- a self-contained page for the report ---------------- */
const esc = s => String(s == null ? '—' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const ci = b => b && b.v != null ? esc(b.v) + (b.lo != null ? ' <span class="ci">[' + esc(b.lo) + ', ' + esc(b.hi) + ']</span>' : '') : '—';
const cls = b => b && b.lo != null ? (b.lo > 0 ? ' class="pos"' : b.hi < 0 ? ' class="neg"' : '') : '';
function table(head, rows) { return '<div class="tw"><table><thead><tr>' + head.map(h => '<th>' + esc(h) + '</th>').join('') + '</tr></thead><tbody>' + rows.map(r => '<tr>' + r.join('') + '</tr>').join('') + '</tbody></table></div>'; }
const td = (v, raw) => '<td>' + (raw ? v : esc(v)) + '</td>', tdc = b => '<td' + cls(b) + '>' + ci(b) + '</td>';
function reportHtml(rep) {
  const S = rep.slips.slips, F = rep.forward, P = rep.persistence, I = rep.improvers, M = rep.market, E = rep.effects;
  const d = ms => ms ? new Date(ms).toISOString().slice(0, 10) : '—';
  const lines = a => '<ul>' + (a || []).map(x => '<li>' + esc(x) + '</li>').join('') + '</ul>';
  let h = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Trader Research</title><style>'
    + ':root{--bg:#fbfaf7;--fg:#1d1d1b;--mute:#6b6a65;--line:#e4e1d9;--card:#fff;--pos:#1f7a4d;--neg:#b3412e}'
    + '@media (prefers-color-scheme:dark){:root{--bg:#141413;--fg:#ecebe6;--mute:#9b9a93;--line:#2c2b28;--card:#1c1c1a;--pos:#5cc08b;--neg:#ef8a74}}'
    + 'body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}main{max-width:980px;margin:0 auto;padding:24px 16px 64px}'
    + 'h1{font-size:26px;margin:0 0 4px}h2{font-size:19px;margin:36px 0 8px;padding-top:12px;border-top:1px solid var(--line)}h3{font-size:15px;margin:18px 0 6px}'
    + '.mute,.ci{color:var(--mute)}.ci{font-size:12px}.tw{overflow-x:auto}table{border-collapse:collapse;width:100%;font-size:13px;background:var(--card)}'
    + 'th,td{padding:6px 8px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top;white-space:nowrap}th{font-weight:600;color:var(--mute)}'
    + '.pos{color:var(--pos)}.neg{color:var(--neg)}ul{padding-left:20px}li{margin:3px 0}</style></head><body><main>';
  h += '<h1>Trader research</h1><p class="mute">' + esc(rep.sample.wallets) + ' wallets · ' + esc(rep.sample.withTrades) + ' with closed trades · ' + esc(rep.sample.trades) + ' trades · '
    + d(rep.sample.span.from) + ' to ' + d(rep.sample.span.to) + ' · built ' + d(rep.at) + '</p>' + lines(rep.notes);
  h += '<h2>1 · What each slip costs</h2><p class="mute">Each wallet’s slipped trades against its own trades that faced the same test and passed it, averaged over wallets. Negative is worse. Green or red: the 95% interval leaves out zero.</p>'
    + table(['Slip', 'Compared with', 'Rate', 'Wallets', 'Δ per trade (R)', 'Δ bps', 'Δ win rate (pts)', 'Wallets worse', 'R per 100 trades'],
      SLIPS.map(k => S[k]).map(x => [td(x.label), td(x.vs), td(x.rate == null ? '—' : x.rate + '%'), td(x.wallets), tdc(x.R), tdc(x.bps), tdc(x.win), td(x.worse == null ? '—' : x.worse + '%'), td(x.per100)])) + lines(rep.slips.text);
  h += '<h2>2 · Does Discipline predict next month?</h2>' + lines(F.text)
    + table(['Discipline fifth', 'Range', 'Wallet-months', 'Next month (R per trade)', 'Next month profitable', 'Next month bps'], F.quintiles.map(q => [td(q.q), td(q.disc.join('–')), td(q.n), td(q.nextR), td(q.nextProfitable + '%'), td(q.nextBps)]));
  h += '<h2>2 · Skill or luck?</h2><p class="mute">' + esc(P.wallets) + ' wallets with ' + 20 + '+ trades in each of two back-to-back ' + P.days + '-day windows.</p>'
    + table(['Measure', 'Wallets', 'Rank correlation, one window to the next', 'Top quarter stays', 'Bottom quarter stays'], Object.values(P.metrics).map(m => [td(m.label), td(m.n), tdc(m.rho), td(m.topStays == null ? '—' : m.topStays + '%'), td(m.bottomStays == null ? '—' : m.bottomStays + '%')]))
    + '<h3>How many trades a ranking needs</h3><p class="mute">Split-half: each wallet’s trades alternately in two halves; how well one half ranks wallets like the other.</p>'
    + table(['Measure', 'One trade’s reliability', 'Trades for 0.7'].concat(P.reliability.pf.buckets.map(b => b.trades[0] + (b.trades[1] ? '–' + (b.trades[1] - 1) : '+') + ' trades')),
      Object.values(P.reliability).map(x => [td(x.label), td(x.perTrade), td(x.need || 'no amount')].concat(x.buckets.map(b => td(b.full == null ? '— (' + b.n + ')' : b.full + ' (' + b.n + ')')))));
  h += '<h2>4 · Traders like you who improved</h2><p class="mute">' + esc(I.contributors) + ' wallets with a current summary, ' + esc(I.withHistory) + ' with weekly history; ' + esc(I.groupsBuilt) + ' peer groups. The server’s own buildImprovers, run on histories rebuilt from fills.</p>' + lines(I.text);
  for (const g of I.groups.slice(0, 8)) h += '<h3>' + esc(g.key === 'all' ? 'Everyone' : g.key) + ' <span class="mute">(' + g.n + ' improvers of ' + g.panel + ')</span></h3>'
    + table(['Change', 'Improvers', 'Others', 'Effect', 'Sentence'], g.changes.map(c => [td(c.label), td(c.improversDelta), td(c.othersDelta), td(c.effect), td(c.text)]));
  const L = I.lasting; h += '<h3>Did it last?</h3>' + table(['Measure', 'Panel', 'Improvers', 'Stayed top', 'Faded', 'Stayed bottom'], ['disc', 'pf'].filter(k => L[k] && L[k].improvers && L[k].improvers.n).map(k =>
    [td(k === 'disc' ? 'Discipline' : 'Profit factor'), td(L[k].n)].concat(['improvers', 'stayedTop', 'faded', 'stayedBottom'].map(s => td(L[k][s].aboveNow + '% in top half 12 weeks on (' + L[k][s].n + ')')))));
  if (E) h += '<h2>6 · Does the product work?</h2><p class="mute">' + esc(E.note) + '</p>' + table(['Exposure', 'Members', 'Measured', 'Discipline change vs not-yet (pts)', 'Slip days vs not-yet (pts)', 'Raw change', 'Discipline before'],
    Object.values(E.effects).map(x => [td(x.label), td(x.exposed), td(x.measured), tdc(x.did), tdc(x.didSlip), td(x.raw), td(x.before)]));
  h += '<h2>8 · Market views</h2><p class="mute">Skill tiers are set from each wallet’s average trade in the first half of the span (' + esc(M.tiers.rated) + ' wallets rated) and read only in the second half. Their average trade after the midpoint (R, median): '
    + Object.entries(M.tiers.check).map(([k, v]) => esc(TIERS[k]) + ' ' + esc(v.afterR) + ' (' + esc(v.wallets) + ')').join(' · ') + '.</p>' + lines(M.text);
  h += '<h3>Positioning now</h3>' + table(['Coin', 'Wallets trading it', 'Long share', 'Top-quarter long share', 'Bottom-quarter long share', 'Net $ under 1k', '$1k–10k', '$10k–100k', '$100k+'],
    M.coins.map(c => { const s = M.positioning[c].series, x = s[s.length - 1] || { bySize: {}, tierLongShare: {} };
      return [td(c), td(M.positioning[c].holders), td(x.longShare == null ? '—' : x.longShare + '%'), td(x.tierLongShare.top == null ? '—' : x.tierLongShare.top + '%'), td(x.tierLongShare.bottom == null ? '—' : x.tierLongShare.bottom + '%')]
        .concat(['s1', 's2', 's3', 's4'].map(k => td(x.bySize[k] == null ? '—' : x.bySize[k].toLocaleString('en-US')))); }));
  h += '<h3>Around big moves</h3><p class="mute">Flow against the move, in each group’s typical hours of flow (positive: buying drops, selling spikes). ' + esc(M.shocks.n) + ' moves.</p>'
    + table(['Group', '24h before', 'The hour', '24h after'], Object.keys(M.shocks.groups).map(g => [td(M.shocks.labels[g]), tdc(M.shocks.groups[g].before), tdc(M.shocks.groups[g].during), tdc(M.shocks.groups[g].after)]));
  h += '<h3>Does a tier’s flow lead the price?</h3>' + table(['Group', 'Coin-days', 'Flow vs next day', 'Flow vs same day', 'Direction right'], Object.entries(M.lead).map(([g, x]) => [td(M.shocks.labels[g] || g), td(x.points), tdc(x.next), tdc(x.same), td(x.hit == null ? '—' : x.hit + '%')]));
  return h + '</main></body></html>';
}

module.exports = { SLIPS, SLIP_LABEL, SLIP_VS, SLIP_MECH, EXPOSURES, SIZES, TIERS, walletRecord, marketOf, slipCosts, disciplineForward, persistence, reliability, improvers, productEffects,
  marketCoins, spanOf, skillTiers, marketViews, buildReport, reportText, reportHtml, spearman, pearson, ranks, boot, ols2 };
