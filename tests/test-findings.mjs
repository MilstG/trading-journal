// What members see of the research report (findings.js), the crowd's hourly flow (research.js crowdOf), the
// Discipline weights the slip costs suggest (pzBehaviorDays opts.w), your own slips priced the same way the
// research prices them (app/features/research.js rfMySlips), and GET /api/social/findings over HTTP.
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { t, ok, eq, report, makeExtractor } from './harness.mjs';

const require = createRequire(import.meta.url);
const R = require('../research.js');
const F = require('../findings.js');
const server = require('../server.js');
const htmlPath = new URL('../ledger.html', import.meta.url).pathname;
const { readAppSource } = require('../app-source.js');
const { evalModule } = makeExtractor(readAppSource(htmlPath));
const { rfMySlips } = await evalModule(['rfMySlips', 'nfMedian', 'hasAdd'], ['rfMySlips'], 'const RF_MIN=3;');
const HOUR = 3600000, DAY = 86400000;
const T0 = Date.parse('2026-08-01T00:00:00Z');

console.log('The crowd, hour by hour');
// one coin, 10 days; hour h: `n` wallets of a group traded, with net flow f
const crowdFrom = rows => { const flows = { BTC: {} }, heads = { BTC: {} };
  for (const [g, h, f, n] of rows) { (flows.BTC[g] = flows.BTC[g] || new Map()).set(T0 + h * HOUR, f); (heads.BTC[g] = heads.BTC[g] || new Map()).set(T0 + h * HOUR, n); }
  return R.crowdOf(['BTC'], flows, heads, { from: T0, to: T0 + 10 * DAY }, { crowdDays: 60, crowdMin: 3, crowdLag: 24 }); };
t('five steps against the group’s usual hour; an hour with fewer than 3 wallets says nothing', () => {
  const C = crowdFrom([['all', 0, 100, 5], ['all', 1, -100, 5], ['all', 2, 400, 5], ['all', 3, -400, 5], ['all', 4, 10, 5], ['all', 5, 1000, 2]]);
  eq([C.hours, C.from], [9 * 24, T0], 'the last 24 hours are left out');
  // the usual hour with flow: mean |f| over hours with any = (100+100+400+400+10+1000)/6 = 335
  eq(C.coins.BTC.all.slice(0, 7), '22312..', 'hour 5 had 2 wallets; hour 6 none');
});
t('a big buy or sell against the usual is the hard step; a group with no hour of 3+ wallets is left out', () => {
  const C = crowdFrom([0, 1, 2, 3, 4, 5].map(h => ['tier:top', h, 10, 4]).concat([['tier:top', 6, 300, 4], ['tier:top', 7, -300, 4], ['tier:bottom', 0, 50, 1]]));
  eq(C.coins.BTC['tier:top'].slice(0, 8), '22222240', 'usual 82.5: ±300 is past 2×');
  ok(!('tier:bottom' in C.coins.BTC), 'one wallet never stands for its group');
});

console.log('\nWhat members get');
const slip = (v, lo, hi, wallets, rate) => ({ label: 'x', vs: 'y', wallets, chances: 100, slipped: 10, rate, R: { v, lo, hi, n: wallets }, bps: { v: null }, win: { v: null }, slippedR: { v: -0.5 }, per100: -3 });
const rep = { at: T0, sample: { wallets: 40, withTrades: 38, trades: 9000, frame: { kind: 'members' } },
  slips: { slips: { revenge: slip(-0.8, -1.1, -0.5, 30, 12), sizeUp: slip(-0.4, -0.6, -0.2, 25, 5), afterTwo: slip(-0.1, -0.3, 0.1, 22, 8), overtrade: slip(-0.6, -0.9, -0.3, 6, 9),
    addLoser: slip(-2, -3, -1, 18, 20), heldLoser: slip(0.2, 0.1, 0.3, 20, 15) }, order: ['addLoser', 'revenge', 'overtrade', 'sizeUp'] },
  persistence: { wallets: 30, metrics: { R: { n: 30, rho: { v: 0.31 }, topStays: 41 } }, reliability: { R: { perTrade: 0.004, need: 584 }, pf: { need: 900 } } },
  forward: { wallets: 25, months: 160, disc: { v: 0.2, lo: 0.1, hi: 0.3 }, results: { v: 0.1 }, beyondResults: { v: 0.15, lo: 0.05, hi: 0.25 }, within: { v: 0.1 }, withinBeyond: { v: 0.08, lo: -0.02, hi: 0.2 },
    quintiles: [{ q: 1, disc: [10, 40], n: 30, nextR: -0.2, nextProfitable: 38 }, { q: 5, disc: [80, 100], n: 30, nextR: 0.3, nextProfitable: 61 }] },
  improvers: { contributors: 30, groups: [{ key: 'all', panel: 30, n: 8, nOthers: 22, changes: [{ metric: 'rev', text: 'all-change' }] }, { key: 'style=day', panel: 12, n: 5, nOthers: 7, changes: [{ metric: 'tw', text: 'day-change' }] },
    { key: 'style=day|size=s2', panel: 4, n: 2, nOthers: 2, changes: [{ metric: 'jour', text: 'too-small' }] }], lasting: null },
  market: { tiers: { check: {} }, crowd: { from: T0, hours: 48, groups: R.CROWD, min: 3, coins: { BTC: { all: '2'.repeat(48) } } } } };
t('only slips measured on enough wallets, with whether their interval leaves out zero', () => {
  const f = F.memberFindings(rep, {});
  eq(Object.keys(f.slips).sort(), ['addLoser', 'afterTwo', 'heldLoser', 'revenge', 'sizeUp'], 'overtrade rests on 6 wallets: not shown');
  eq([f.slips.revenge.R, f.slips.revenge.sure, f.slips.afterTwo.sure, f.slips.addLoser.mech], [-0.8, true, false, true]);
  eq(f.order, ['addLoser', 'revenge', 'sizeUp']);
  eq([f.rel.need, f.rel.by, f.rel.stays.top], [584, 'R', 41]);
  eq([f.forward.says, f.forward.quintiles.length], ['some', 2], 'beyond this month’s results it says something; inside a wallet not yet');
  eq(Object.keys(f.improvers.groups), ['all', 'style=day'], 'a group under the wallet floor is left out');
  eq(f.crowd.coins.BTC.all.length, 48);
  ok(!JSON.stringify(f).includes('0x'), 'no address');
});
t('the owner can switch sharing off, raise the floor, or keep the crowd to themselves', () => {
  eq(F.memberFindings(rep, { share: false }), null);
  eq(Object.keys(F.memberFindings(rep, { minWallets: 26 }).slips), ['revenge'], 'a higher floor drops more');
  eq(F.memberFindings(rep, { crowd: false }).crowd, null);
  eq(F.sanitizeResearchCfg({ minWallets: 1, minTrades: -5, weights: 'yes' }), Object.assign({}, F.DEFAULTS, { minWallets: 5, minTrades: 0 }), 'clamped; a non-boolean switch is ignored');
});
t('Discipline weights from the costs: the costliest counts in full, the rest by their cost, never under a quarter', () => {
  const w = F.slipWeights(rep.slips.slips, 10);
  eq(w, { revenge: 0.4, afterTwo: 0.25, sizeUp: 0.25, addLoser: 1, overtrade: 1, heldLoser: 0.25 },
    'addLoser costs most (2); revenge 0.8/2; sizeUp 0.2 floors at 0.25; afterTwo can’t be told from zero; heldLoser helps; overtrade unmeasured keeps 1');
  eq(F.activeWeights(rep, { weights: false }), null, 'off by default');
  eq(F.activeWeights(rep, { weights: true }).addLoser, 1);
  eq(F.activeWeights({ slips: { slips: {} } }, { weights: true }), null, 'nothing measured: the old score');
});
t('improvers for a trader’s dimensions: the most specific group with something to say', () => {
  eq(F.improversFor(rep, { style: 'day', size: 's2', exp: 'e2', act: 'a2' }, 10).changes[0].text, 'day-change');
  eq(F.improversFor(rep, { style: 'swing' }, 10).key, 'all');
  const x = F.improversFor(rep, { style: 'day' }, 10); eq([x.src, x.wallets, x.dims], ['research', 30, { style: 'day' }]);
  eq(F.improversFor({}, { style: 'day' }), null);
});

console.log('\nThe Discipline score, weighted');
const E = server.buildEngine(htmlPath, () => { throw new Error('offline'); }).ctx;
const A = '0x' + 'cd'.repeat(20); let tid = 0;
const fill = (side, sz, px, start, pnl, ms) => ({ coin: 'ETH', side, sz: String(sz), px: String(px), startPosition: String(start), closedPnl: String(pnl), fee: '0', crossed: true, time: ms, tid: ++tid, oid: tid, hash: '0x' + tid });
// each day: a loss, a re-entry 5 minutes later (revenge) that loses, a patient winner at 12:30
const fills = [];
for (let d = 0; d < 30; d++) { const b = T0 + d * DAY;
  fills.push(fill('B', 10, 100, 0, 0, b + 10 * HOUR), fill('A', 10, 99, 10, -10, b + 10.5 * HOUR), fill('B', 10, 100, 0, 0, b + 10.5 * HOUR + 5 * 60000), fill('A', 10, 98, 10, -20, b + 11 * HOUR),
    fill('B', 10, 100, 0, 0, b + 12.5 * HOUR), fill('A', 10, 103, 10, 30, b + 13 * HOUR)); }
const closed = E.attributeFunding(E.reconstructTrades(fills, A, 'perp'), []).filter(x => E.tradeRow(x) && !x.isOpen);
const dayOf = ms => new Date(ms).toISOString().slice(0, 10), loss = n => n < -1;
t('without weights a slipped trade costs a whole trade; with them, its slip’s weight', () => {
  const plain = E.pzBehaviorDays(closed, { dayOf, isLoss: loss }), weighted = E.pzBehaviorDays(closed, { dayOf, isLoss: loss, w: { revenge: 0.4 } });
  // 3 trades: the re-entry is a revenge entry, and the 12:30 one comes after two losses in a row (no weight given: 1)
  eq([plain[5].score, weighted[5].score], [33, 53], '1/3 clean, then (3 − 0.4 − 1)/3');
  eq([plain[5].clean, weighted[5].clean, weighted[5].flags.revenge, weighted[5].flags.afterTwo], [1, 1, 1, 1], 'the slips themselves are the same');
  eq(E.pzBehaviorDays(closed, { dayOf, isLoss: loss, w: { revenge: 1, sizeUp: 1, afterTwo: 1, addLoser: 1, overtrade: 1, heldLoser: 1 } }).map(d => d.score), plain.map(d => d.score), 'all 1 is the old score');
});

console.log('\nYour own slips, priced');
t('a revenge entry against your own post-loss entries that waited, in your typical trade', () => {
  const bd = E.pzBehaviorDays(closed, { dayOf, isLoss: loss });
  const m = rfMySlips(closed, bd, { now: T0 + 31 * DAY, iters: 100 });
  // typical trade: median |net| of 10, 20, 30 = 20; revenge loses 20 (−1R), the patient entry after it wins 30 (+1.5R)
  eq([m.unit, m.n, m.slips.revenge.n, m.slips.revenge.R, m.slips.revenge.sure], [20, 90, 30, -2.5, true]);
  ok(Math.abs(m.slips.revenge.usd - -2.5 * 20 * 30) < 1e-6, 'priced in dollars over the window');
  eq(rfMySlips(closed.slice(0, 5), bd).slips, {}, 'under 10 trades: nothing to say');
});
t('a window keeps it to recent trades', () => {
  const bd = E.pzBehaviorDays(closed, { dayOf, isLoss: loss });
  eq(rfMySlips(closed, bd, { now: T0 + 400 * DAY }).n, 0);
});

console.log('\nResults boards rank from the owner’s trade bar');
const Soc = require('../social.js');
const mem = (id, ret, n) => ({ id, handle: id, share: { ret: true }, money: { ret, dd: 0.05, usd: ret * 1000 }, vdays: n == null ? null : [{ k: '2026-10-19', s: 80, n }] });
t('fewer trades than the bar, or none verified: listed after the ranked ones, unranked, and saying why', () => {
  const ms = [mem('a', 0.5, 3), mem('b', 0.1, 400), mem('c', 0.2, null), mem('d', 0.05, 350)];
  const rows = Soc.boardRows(ms, 'ret', { todayKey: '2026-10-20', minTrades: 300 });
  eq(rows.map(r => [r.id, r.rank, !!r.few]), [['b', 1, false], ['d', 2, false], ['a', null, true], ['c', null, true]]);
  ok(/3 of 300 trades/.test(rows[2].sub) && /trades not verified/.test(rows[3].sub), rows.map(r => r.sub).join(' | '));
  eq(Soc.boardRows(ms, 'ret', { todayKey: '2026-10-20' }).map(r => r.id), ['a', 'c', 'b', 'd'], 'no bar: the old order');
  eq(Soc.boardRows(ms, 'discipline', { todayKey: '2026-10-20', minTrades: 300 }).some(r => r.few), false, 'process boards never use it');
  eq(Soc.tradesIn([{ k: '2026-10-01', n: 5 }, { k: '2026-10-10', n: 7 }], '2026-10-05', '2026-10-31'), 7);
});
t('a result on too few trades can’t earn promotion, but can still lose a tier', () => {
  const e = [0, 1, 2, 3].map(i => ({ id: 'm' + i, tier: 0, value: 10 - i, few: i === 0 }));
  eq(Soc.leagueRolloverBy(e), [], 'the top value had too few trades: nobody else is in the top 1 either');
  const e2 = [0, 1, 2, 3].map(i => ({ id: 'm' + i, tier: 1, value: 10 - i, few: i === 3 }));
  eq(Soc.leagueRolloverBy(e2).map(m => [m.id, m.to]), [['m0', 2], ['m3', 0]]);
});

console.log('\nOver HTTP');
const dataDir = mkdtempSync(join(tmpdir(), 'ledger-findings-'));
mkdirSync(join(dataDir, 'research'), { recursive: true });
writeFileSync(join(dataDir, 'research', 'report.json.gz'), gzipSync(JSON.stringify({ status: { state: 'done' }, report: rep, text: '' })));
const app = server.createApp({ dataDir, auth: 'owner-token', htmlPath, now: () => T0 + 40 * DAY, push: false, pushTick: false, trustProxy: true, offsiteTimer: false, statsSweep: false,
  fetchImpl: async () => ({ ok: true, status: 200, json: async () => [] }) });
const B = await new Promise(res => app.listen(0, () => res('http://127.0.0.1:' + app.address().port)));
let ipN = 0;
const call = async (p, o = {}) => { const r = await fetch(B + '/api/social' + p, { method: o.method || 'GET',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.7.0.' + (++ipN), ...(o.key ? { 'X-Pulse-Key': o.key } : {}), ...(o.owner ? { Authorization: 'Bearer owner-token' } : {}) },
    body: o.body !== undefined ? JSON.stringify(o.body) : undefined });
  return { status: r.status, d: await r.json().catch(() => ({})) }; };
try {
  await t('members and the owner read the group figures; nobody else does', async () => {
    eq((await call('/findings')).status, 401);
    const j = (await call('/join', { method: 'POST', body: { handle: 'ann' } })).d;
    const f = (await call('/findings', { key: j.key })).d;
    eq([f.on, f.wallets, f.rel.need, Object.keys(f.slips).length, f.weights.on], [true, 38, 584, 5, false]);
    eq((await call('/findings', { owner: true })).d.on, true);
  });
  await t('the owner’s settings: sharing off hides it; weights on are sent with the feed; out of range is refused', async () => {
    eq((await call('/admin/config', { method: 'PUT', owner: true, body: { research: { minWallets: 2 } } })).status, 400);
    eq((await call('/admin/config', { method: 'PUT', owner: true, body: { research: { weights: true } } })).d.config.research.weights, true);
    const j = (await call('/join', { method: 'POST', body: { handle: 'bob' } })).d;
    const f = (await call('/findings', { key: j.key })).d; eq([f.weights.on, f.weights.w.addLoser, f.weights.w.revenge], [true, 1, 0.4]);
    await call('/admin/config', { method: 'PUT', owner: true, body: { research: { share: false } } });
    eq((await call('/findings', { key: j.key })).d, { on: false, why: 'off' });
  });
  await t('“Traders like you” falls back to the research run’s improvers when the server has none of its own', async () => {
    await call('/admin/config', { method: 'PUT', owner: true, body: { research: { share: true } } });
    const j = (await call('/join', { method: 'POST', body: { handle: 'cat' } })).d;
    const b = (await call('/bench?style=day&size=s2&exp=e2&act=a2', { key: j.key })).d;
    eq([b.improvers.src, b.improvers.changes[0].text], ['research', 'day-change'], JSON.stringify(b.improvers).slice(0, 200));
    ok(/research run on 30 wallets/.test(b.improvers.note));
  });
} finally { await new Promise(r => app.close(r)); }

report('findings');
