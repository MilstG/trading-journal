// The owner's research (research.js, pure; research-run.js does the I/O): a wallet reduced to its trades with the
// app's own engine, what each slip costs inside a wallet, Discipline against the next month, persistence and
// reliability, improvers rebuilt from histories, members before and after a first mentor review or duel, and
// the market views (positions from fills, flow around big moves, a tier's flow against the next day). Then the
// admin route over HTTP.
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { t, ok, eq, report } from './harness.mjs';

const require = createRequire(import.meta.url);
const R = require('../research.js');
const server = require('../server.js');
const htmlPath = new URL('../ledger.html', import.meta.url).pathname;
const DAY = 86400000, HOUR = 3600000, MIN = 60000;
const T0 = Date.parse('2026-03-02T00:00:00Z');
const rnd = (() => { let s = 12345; return () => { s ^= s << 13; s >>>= 0; s ^= s >> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; }; })();

console.log('Statistics');
t('ranks share ties; Spearman is 1 for any rising pair and -1 for a falling one', () => {
  eq(R.ranks([10, 20, 20, 5]), [2, 3.5, 3.5, 1]);
  eq([R.spearman([1, 2, 3, 4], [1, 4, 9, 16]), R.spearman([1, 2, 3, 4], [4, 3, 2, 1])], [1, -1]);
  eq(R.spearman([1, 2], [1, 2]), null, 'too few to say');
});
t('the bootstrap is seeded: the same data gives the same interval, and it brackets the estimate', () => {
  const u = Array.from({ length: 50 }, (_, i) => i % 7), m = s => s.reduce((a, x) => a + x, 0) / s.length;
  const a = R.boot(u, m), b = R.boot(u, m); eq(a, b); ok(a.lo < a.v && a.v < a.hi, JSON.stringify(a));
  eq(R.boot(u.slice(0, 3), m).lo, null, 'under 5 units: no interval');
});

console.log('\nA wallet, through the engine');
const E = server.buildEngine(htmlPath, () => { throw new Error('offline'); }).ctx;
const A = '0x' + 'ab'.repeat(20);
let tid = 0;
const fill = (side, sz, px, start, pnl, ms) => ({ coin: 'ETH', side, sz: String(sz), px: String(px), startPosition: String(start), closedPnl: String(pnl), fee: '0', crossed: true, time: ms, tid: ++tid, oid: tid, hash: '0x' + tid });
// every day: a loss at 10:30, a re-entry 5 minutes later that loses too (revenge), and a patient entry at 12:30 that wins
const fills = [];
for (let d = 0; d < 40; d++) { const b = T0 + d * DAY;
  fills.push(fill('B', 10, 100, 0, 0, b + 10 * HOUR), fill('A', 10, 99, 10, -10, b + 10.5 * HOUR));
  fills.push(fill('B', 10, 100, 0, 0, b + 10.5 * HOUR + 5 * MIN), fill('A', 10, 99, 10, -10, b + 11 * HOUR));
  fills.push(fill('B', 10, 100, 0, 0, b + 12.5 * HOUR), fill('A', 10, 102, 10, 20, b + 13 * HOUR)); }
const trades = E.attributeFunding(E.reconstructTrades(fills, A, 'perp'), []).filter(x => E.tradeRow(x) && !x.isOpen); // net is set with funding
const rec = R.walletRecord(trades, { addr: A, from: T0, to: T0 + 41 * DAY, fills, pzBehaviorDays: E.pzBehaviorDays, peerSummary: E.peerSummary, notionalOf: E.notionalOf, hasAdd: E.hasAdd });
t('a wallet record: every closed trade, its slips and the chances it had, its days and its size group', () => {
  eq([rec.rows.length, rec.days.length, rec.units, rec.size], [120, 40, 10, 's2']);
  const rev = 1 << R.SLIPS.indexOf('revenge');
  eq(rec.rows.filter(r => r[4] & rev).length, 40, 'each 10:35 re-entry is a revenge entry');
  eq(rec.rows.filter(r => r[5] & 1).length, 80, 'chances: the re-entry and the patient entry after it');
  eq(rec.rows.filter(r => r[2] === 20).every(r => !(r[4] & rev) && r[5] & 1), true, 'the patient entry kept the habit');
});
t('positions from fills: the position before the first fill, then after each hour’s last fill, with its flow', () => {
  const mk = R.marketOf([fill('B', 1, 100, 2, 0, T0 + 5 * MIN), fill('B', 1, 101, 3, 0, T0 + 20 * MIN), fill('A', 6, 102, 4, 0, T0 + 2 * HOUR),
    Object.assign(fill('A', 1, 90, -2, 0, T0 + 3 * HOUR), { liquidation: { liquidatedUser: A } }), Object.assign(fill('B', 1, 5, 0, 0, T0), { coin: '@107' })].reverse(), A);
  eq(Object.keys(mk), ['ETH'], 'spot (@107) is left out');
  eq(mk.ETH.p0, 2, 'read in time order, whatever order they came in');
  eq(mk.ETH.h, [[T0, 4, 101, 201, 0], [T0 + 2 * HOUR, -2, 102, -612, 0], [T0 + 3 * HOUR, -3, 90, -90, 1]]);
});

console.log('\n1 · What each slip costs');
// n wallets of `per` trades; a slipped trade (bit) makes `cost` R against a kept one making `gain` R, on the slip's chances
const recs = (n, mk) => Array.from({ length: n }, (_, w) => ({ addr: 'w' + w, from: T0, to: T0 + 200 * DAY, units: 10, days: [], hist: [], mk: {}, rows: mk(w) }));
t('a slip that loses, measured against the same wallet’s kept chances; the rate is per chance', () => {
  const rev = 1 << R.SLIPS.indexOf('revenge');
  const S = R.slipCosts(recs(30, w => Array.from({ length: 40 }, (_, i) => { const slip = i % 4 === 0, chance = i % 2 === 0;
    return [T0 + i * HOUR, T0 + i * HOUR + MIN, slip ? -10 - w % 3 : chance ? 10 : 5, 1000, slip ? rev : 0, chance ? 1 : 0]; })));
  const x = S.slips.revenge;
  eq([x.wallets, x.chances, x.slipped, x.rate], [30, 600, 300, 50]);
  ok(x.R.v < -1.9 && x.R.hi < 0, 'about two typical trades worse: ' + JSON.stringify(x.R));
  ok(x.bps.v < -190, 'and in bps of size: ' + x.bps.v); eq(x.win.v, -100, 'all slipped lost, all kept won');
  eq(S.order[0], 'revenge'); ok(/Entered within 15 minutes of a loss \(50% of chances\)/.test(S.text[0]), S.text[0]);
});
t('a slip that costs nothing reads as not distinguishable from zero; built-in comparisons say so', () => {
  const add = 1 << R.SLIPS.indexOf('addLoser');
  const S = R.slipCosts(recs(30, () => Array.from({ length: 40 }, (_, i) => [T0 + i * HOUR, T0 + i * HOUR + MIN, (rnd() - 0.5) * 20, 1000, i % 3 === 0 ? add : 0, 4])));
  const x = S.slips.addLoser; ok(x.R.lo < 0 && x.R.hi > 0, JSON.stringify(x.R));
  const line = S.text.find(l => l.startsWith('Added to a losing'));
  ok(/not distinguishable from zero/.test(line) && /built in/.test(line), line);
});

console.log('\n2 · Next month, and skill or luck');
// a wallet with a fixed edge (its average trade in R) and noise; Discipline days on every trading day
const edgeWallet = (w, edge, disc, days, perDay, noise) => { const rows = [], ds = [];
  for (let d = 0; d < days; d++) { const k = new Date(T0 + d * DAY).toISOString().slice(0, 10), dsc = disc(d);
    ds.push([k, dsc, perDay, 0]); for (let i = 0; i < perDay; i++) rows.push([T0 + d * DAY + i * HOUR, T0 + d * DAY + i * HOUR + MIN, Math.round((edge + (rnd() - 0.5) * noise) * 1000) / 100, 1000, 0, 0]); }
  return { addr: 'w' + w, from: T0, to: T0 + days * DAY, units: 10, rows, days: ds, hist: [], mk: {} }; };
t('persistence: fixed edges carry from one quarter to the next; pure noise doesn’t', () => {
  const skill = R.persistence(Array.from({ length: 60 }, (_, w) => edgeWallet(w, (w - 30) / 10, () => 60, 200, 1, 2)));
  ok(skill.metrics.R.rho.v > 0.8 && skill.metrics.R.rho.lo > 0.5, JSON.stringify(skill.metrics.R)); eq(skill.wallets, 60);
  ok(skill.metrics.R.topStays > 60, 'the top quarter mostly stays: ' + skill.metrics.R.topStays);
  const luck = R.persistence(Array.from({ length: 60 }, (_, w) => edgeWallet(w, 0, () => 60, 200, 1, 4)));
  ok(luck.metrics.R.rho.lo < 0 && luck.metrics.R.rho.hi > 0, 'noise: ' + JSON.stringify(luck.metrics.R.rho));
});
t('reliability: how many trades a ranking needs falls as the edge stands out from the noise', () => {
  const clear = R.reliability(Array.from({ length: 60 }, (_, w) => edgeWallet(w, (w - 30) / 10, () => 60, 60, 1, 2))).R;
  const noisy = R.reliability(Array.from({ length: 60 }, (_, w) => edgeWallet(w, (w - 30) / 100, () => 60, 60, 1, 4))).R;
  ok(clear.need && noisy.need && clear.need < noisy.need, clear.need + ' vs ' + noisy.need);
  eq(clear.buckets.map(b => b.trades), [[20, 50], [50, 100], [100, 250], [250, null]]);
});
t('Discipline forward: months whose Discipline sets next month’s results show it, across and inside wallets', () => {
  // each wallet's Discipline swings by month; its next month's trades are better after a disciplined month
  const ws = Array.from({ length: 40 }, (_, w) => { const rows = [], ds = [];
    for (let m = 0; m < 8; m++) { const disc = 40 + ((w * 7 + m * 13) % 50), start = Date.parse('2026-0' + (1 + m) + '-01T00:00:00Z');
      for (let d = 0; d < 20; d++) { ds.push([new Date(start + d * DAY).toISOString().slice(0, 10), disc, 1, 0]); }
      const prev = m ? 40 + ((w * 7 + (m - 1) * 13) % 50) : 60;
      for (let i = 0; i < 15; i++) rows.push([start + i * DAY, start + i * DAY + MIN, (prev - 60) / 2 + (rnd() - 0.5) * 4, 1000, 0, 0]); }
    return { addr: 'w' + w, from: Date.parse('2026-01-01T00:00:00Z'), to: Date.parse('2026-09-01T00:00:00Z'), units: 10, rows, days: ds, hist: [], mk: {} }; });
  const F = R.disciplineForward(ws);
  eq([F.wallets, F.months], [40, 280]);
  ok(F.disc.v > 0.7 && F.within.v > 0.7 && F.withinBeyond.v > 0.5, JSON.stringify([F.disc, F.within, F.withinBeyond]));
  eq(F.quintiles.length, 5); ok(F.quintiles[4].nextR > F.quintiles[0].nextR);
});

console.log('\n4 · Improvers, from histories');
t('improvers rebuilt with the server’s own buildImprovers, and whether they stayed in the top half', () => {
  const at = T0 + 200 * DAY, curW = Math.floor(at / (7 * DAY));
  // 80 wallets followed 30 weeks: a quarter improve Discipline 16 weeks ago, a quarter 6 weeks ago (and cut their
  // trades then); the rest hold at 60
  const ws = Array.from({ length: 80 }, (_, w) => { const when = w % 4 === 0 ? curW - 16 : w % 4 === 2 ? curW - 6 : null, hist = [];
    for (let k = curW - 29; k <= curW; k++) { const late = when != null && k > when; const disc = when == null ? 60 + w % 5 : (late ? 80 : 40) + w % 5, tw = w % 4 === 2 && late ? 10 : 20;
      hist.push([k, disc, 5, null, 50, 1.2, 1.1, 20, tw, 60]); }
    return { addr: 'w' + w, from: T0, to: at, units: 10, rows: [[0, at - DAY, 1, 1, 0, 0]], days: [], mk: {}, hist, dims: { style: 'day', size: 's2', exp: 'e2', act: 'a2', n: 40, at } }; });
  const I = R.improvers(ws, { min: 25 });
  const all = I.groups.find(g => g.key === 'all'); ok(all && all.n === 20 && all.panel === 80, JSON.stringify(all && [all.n, all.panel]));
  ok(all.changes.some(c => c.metric === 'tw' && c.improversDelta < 0), 'they traded less: ' + JSON.stringify(all.changes));
  eq([I.lasting.disc.improvers.n, I.lasting.disc.improvers.aboveNow], [20, 100], 'the earlier improvers stayed in the top half');
});

console.log('\n6 · Does the product work?');
const memDays = (id, lift, E, base) => { const days = [];
  for (let i = 0; i < 120; i += 2) { const ms = T0 + i * DAY, after = E && ms > E; days.push({ k: new Date(ms).toISOString().slice(0, 10), s: Math.round((base || 60) + (after ? lift : 0) + Math.sin(i + id.length) * 8), f: after ? [] : ['revenge'] }); }
  return { id, days, exposures: E ? { mentor: E } : {} }; };
t('a first mentor review followed by better Discipline, against members who hadn’t had one yet', () => {
  const ms = Array.from({ length: 40 }, (_, i) => memDays('m' + i, 10, i < 15 ? T0 + (40 + i) * DAY : null));
  const P = R.productEffects(ms), x = P.effects.mentor;
  eq([x.exposed, x.measured, x.didSlip.v], [15, 15, -100]); ok(Math.abs(x.did.v - 10) < 0.5 && x.did.lo > 9, JSON.stringify(x.did));
  ok(/First mentor review: Discipline \+10(\.\d)? points/.test(P.text[0]), P.text[0]);
  eq(P.effects.duel.measured, 0, 'nobody had a duel');
});
t('a lift everyone got at the same time is not the exposure’s', () => {
  const at = T0 + 50 * DAY, ms = Array.from({ length: 40 }, (_, i) => { const m = memDays('m' + i, 0, null);
    m.days = m.days.map(d => Object.assign({}, d, { s: d.s + (Date.parse(d.k) > at ? 10 : 0) })); if (i < 10) m.exposures = { duel: at }; return m; });
  const x = R.productEffects(ms).effects.duel; ok(Math.abs(x.did.v) < 1 && Math.abs(x.raw - 10) < 1, JSON.stringify(x));
});
t('without enough members who hadn’t had one yet, nothing is measured', () => {
  const ms = Array.from({ length: 5 }, (_, i) => memDays('m' + i, 10, T0 + 40 * DAY));
  eq(R.productEffects(ms).effects.mentor.measured, 0);
});

console.log('\n8 · Market views');
// 48 wallets over 60 days; tiers come from trades before the midpoint. After it, the top tier buys the day before
// the coin rises and sells the day before it falls; the bottom tier trades at random. Small wallets buy the big drop.
const span = 60 * DAY, mid = T0 + span / 2, px = [];
let p = 100; const dayMove = new Map();
for (let h = 0; h <= span / HOUR; h++) { const ts = T0 + h * HOUR, d = Math.floor(ts / DAY) * DAY;
  if (!dayMove.has(d)) dayMove.set(d, rnd() < 0.5 ? -1 : 1);
  p *= Math.exp(dayMove.get(d) * 0.002 + (rnd() - 0.5) * 0.001); if (h === 900) p *= 0.85; px.push([ts, p]); }
const shockT = T0 + 900 * HOUR;
const mrec = Array.from({ length: 48 }, (_, w) => { const tier = w < 12 ? 'top' : w < 24 ? 'bottom' : 'mid', size = w % 2 ? 's1' : 's3', rows = [], h = [];
  for (let i = 0; i < 25; i++) rows.push([T0 + i * DAY, T0 + i * DAY + MIN, tier === 'top' ? 20 : tier === 'bottom' ? -20 : 0, 1000, 0, 0]);
  let pos = 0;
  for (let d = mid + DAY; d < T0 + span - 2 * DAY; d += DAY) { const next = dayMove.get(d + DAY), sg = tier === 'top' ? next : rnd() < 0.5 ? -1 : 1;
    pos += sg; h.push([d + 12 * HOUR, pos, 100, sg * 100, 0]); }
  if (size === 's1') { pos += 5; h.push([shockT + 2 * HOUR, pos, 85, 500, 0]); h.sort((a, b) => a[0] - b[0]); }
  return { addr: 'w' + w, from: T0, to: T0 + span, units: 10, rows, days: [], hist: [], size, mk: { BTC: { p0: 0, h } } }; });
const MV = R.marketViews(mrec, { BTC: px }, { iters: 300 });
t('skill tiers from the first half only, checked on the second', () => {
  eq(MV.tiers.rated, 48); eq([MV.tiers.check.top.wallets, MV.tiers.check.bottom.wallets], [0, 0], 'no trades after the midpoint to check');
});
t('positioning: wallets long and short each week, and net notional by size group', () => {
  const last = MV.positioning.BTC.series[MV.positioning.BTC.series.length - 1];
  eq(last.longs + last.shorts, 48 - mrec.filter(r => !r.mk.BTC.h.length || 0).length - mrec.filter(r => { const q = r.mk.BTC.h.filter(e => e[0] <= last.t).pop(); return !q || q[1] === 0; }).length);
  ok('s1' in last.bySize && 'top' in last.tierLongShare);
});
t('around a big drop: small wallets bought it (flow against the move, after)', () => {
  eq(MV.shocks.n >= 1, true); const s1 = MV.shocks.groups['size:s1'].after; ok(s1.v > 0, JSON.stringify(s1));
});
t('a tier’s flow against the next day: the top tier led the price, the others didn’t', () => {
  const top = MV.lead['tier:top'], bot = MV.lead['tier:bottom'];
  ok(top.next.v > 0.6 && top.hit > 80, JSON.stringify(top)); ok(Math.abs(bot.next.v) < 0.4, JSON.stringify(bot.next));
});
t('the report: text and a self-contained page, with nothing unescaped', () => {
  const rep = R.buildReport(mrec.concat([Object.assign(edgeWallet(99, 1, () => 60, 200, 1, 2), { addr: '<b>' })]), { prices: { BTC: px }, frame: { kind: 'test' }, iters: 50 });
  const html = R.reportHtml(rep), txt = R.reportText(rep);
  ok(html.startsWith('<!doctype html>') && html.includes('<title>Trader Research</title>') && !html.includes('<b>'), 'page');
  ok(/Sample: 49 wallets/.test(txt) && /8 · Market views/.test(txt), txt.slice(0, 200));
});

console.log('\nOver HTTP');
const dataDir = mkdtempSync(join(tmpdir(), 'ledger-research-'));
const app = server.createApp({ dataDir, auth: 'owner-token', htmlPath, now: () => Date.parse('2026-10-20T12:00:00Z'), push: false, pushTick: false, trustProxy: true, offsiteTimer: false,
  fetchImpl: async () => ({ ok: true, status: 200, json: async () => [] }) });
const B = await new Promise(res => app.listen(0, () => res('http://127.0.0.1:' + app.address().port)));
let ipN = 0;
const call = async (p, o = {}) => { const r = await fetch(B + '/api/social' + p, { method: o.method || 'GET',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.5.0.' + (++ipN), ...(o.key ? { 'X-Pulse-Key': o.key } : {}), ...(o.owner ? { Authorization: 'Bearer owner-token' } : {}) },
    body: o.body !== undefined ? JSON.stringify(o.body) : undefined });
  return { status: r.status, d: await r.json().catch(() => ({})) }; };
try {
  await t('the owner reads product effects; members can’t; the window and verified-only switch apply', async () => {
    const j = (await call('/join', { method: 'POST', body: { handle: 'ann' } })).d;
    await call('/stats', { method: 'POST', key: j.key, body: { xp: 100, days: [{ k: '2026-10-19', s: 70 }, { k: '2026-10-18', s: 50, f: ['revenge'] }] } });
    eq((await call('/admin/research', { key: j.key })).status, 401);
    const r = (await call('/admin/research?window=14', { owner: true })).d;
    eq([r.window, r.members, r.app, r.verified, Object.keys(r.effects)], [14, 1, 1, 0, ['mentor', 'duel', 'playbook', 'pod', 'partner']]);
    eq(r.labels.mentor, 'First mentor review');
    const v = (await call('/admin/research?verified=1&window=99', { owner: true })).d;
    eq([v.window, v.members, v.onlyVerified], [28, 0, true], 'an unknown window falls back to 28; verified-only drops app days');
  });
} finally { await new Promise(r => app.close(r)); }

report('research');
