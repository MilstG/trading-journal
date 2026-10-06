// Admin insights: each member's row from what the server holds, the whole base and segments
// (insights.js, pure), then the two admin routes over HTTP: who can read them, the filters,
// small-segment suppression, and a member's percentiles in the league and in their peer group.
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { t, ok, eq, report } from './harness.mjs';

const require = createRequire(import.meta.url);
const I = require('../insights.js');
const server = require('../server.js');
const htmlPath = new URL('../ledger.html', import.meta.url).pathname;
const DAY = 86400000, TODAY = '2026-10-20', NOW = Date.parse(TODAY + 'T12:00:00Z');
const k = n => new Date(NOW - n * DAY).toISOString().slice(0, 10);

console.log('Rows and aggregates');
const mem = (id, o) => Object.assign({ id, handle: id, createdAt: NOW - 40 * DAY, lastSeen: NOW - DAY, share: { bench: true }, address: '0x' + 'a'.repeat(40),
  stats: { level: 3, xp: 1500, streak: 2, days: [] } }, o);
t('a member row: Discipline now and before, journaling, slips, trading numbers only when shared', () => {
  const m = mem('ann', { stats: { level: 4, xp: 2000, days: [
    { k: k(1), s: 90, j: true, r: true }, { k: k(2), s: 70, j: true, f: ['revenge'] }, { k: k(3), s: 50, f: ['revenge', 'sizeUp'] },
    { k: k(40), s: 40 }, { k: k(45), s: 60 }] },
    bench: { style: 'day', size: 's2', exp: 'e2', act: 'a2', n: 40, wr: 55, pf: 1.4 }, money: { ret: 0.051, dd: 0.02 } });
  const r = I.memberRow(m, { today: TODAY, leagues: ['main'] });
  eq([r.disc30, r.discPrev30, r.days30, r.clean30, r.journal30, r.review30], [70, 50, 3, 2, 67, 33]);
  eq(r.slips30, { revenge: 2, sizeUp: 1 }); eq(r.seg, { style: 'day', size: 's2', exp: 'e2', act: 'a2' });
  eq([r.trading.wr, r.trading.pf, r.ret, r.dd], [55, 1.4, 5.1, 2]);
  const off = I.memberRow(Object.assign({}, m, { share: { bench: false } }), { today: TODAY });
  eq([off.trading, off.benchOn, !!off.seg], [null, false, true], 'switched off: no win rate or profit factor, even to the owner');
});
t('verified members are scored on the server’s own Discipline days', () => {
  const m = mem('v', { share: { verify: true }, vdays: [{ k: k(1), s: 40 }], stats: { days: [{ k: k(1), s: 100 }] } });
  eq(I.memberRow(m, { today: TODAY }).disc30, 40);
});
t('segments: medians per group, a group under 5 shows its size only', () => {
  const rows = [];
  for (let i = 0; i < 6; i++) rows.push(I.memberRow(mem('d' + i, { bench: { style: 'day', size: 's2', exp: 'e2', act: 'a2', n: 40, wr: 50 + i }, stats: { days: [{ k: k(1), s: 60 + i }] } }), { today: TODAY }));
  for (let i = 0; i < 2; i++) rows.push(I.memberRow(mem('s' + i, { bench: { style: 'swing', size: 's2', exp: 'e2', act: 'a1', n: 40, wr: 70 } }), { today: TODAY }));
  const b = I.breakdown(rows, 'style', NOW, { style: { day: 'Day trader', swing: 'Swing trader' } });
  eq(b.map(g => [g.label, g.n, g.small]), [['Day trader', 6, false], ['Swing trader', 2, true]]);
  eq([b[0].med.wr, b[0].med.disc30, b[1].med], [52.5, 62.5, null]);
});
t('the funnel, cohorts and who’s slipping', () => {
  const rows = [
    I.memberRow(mem('a', { stats: { days: [{ k: k(1), s: 40, j: true }, { k: k(35), s: 90 }] } }), { today: TODAY }),
    I.memberRow(mem('b', { address: null, stats: null, lastSeen: 0, createdAt: Date.parse('2026-08-03') }), { today: TODAY }),
  ];
  const f = I.funnel(rows, NOW); eq([f.joined, f.wallet, f.synced, f.traded30, f.journaling, f.active7], [2, 1, 1, 1, 1, 1]);
  eq(I.cohorts(rows, NOW).map(c => [c.month, c.joined]), [['2026-09', 1], ['2026-08', 1]]);
  eq(I.cohorts(rows, NOW).map(c => [c.back7, c.journaled]), [[1, 1], [0, 0]], 'a: joined 40 days ago, seen yesterday; b: never seen');
  eq(f.reviewing, 0, 'no day reviewed');
  const out = I.insights(rows, [], {}, { now: NOW, today: TODAY, sort: 'slipping' });
  eq(out.members.map(r => r.handle), ['a'], 'Discipline 90 → 40');
});
t('percentiles: in the league (better direction respected) and from a group’s deciles', () => {
  const pool = [10, 20, 30, 40, 50].map((s, i) => I.memberRow(mem('p' + i, { stats: { days: [{ k: k(1), s }] } }), { today: TODAY }));
  eq(I.percentileIn(pool, 'disc30', 45), 80); eq(I.percentileIn(pool.slice(0, 3), 'disc30', 45), null, 'too few to say');
  const q = [10, 20, 30, 40, 50, 60, 70, 80, 90];
  eq([I.percentileFromDeciles(q, 55, true), I.percentileFromDeciles(q, 55, false), I.percentileFromDeciles(q, 5, true)], [55, 45, 5]);
});
t('weekly trend: Monday-to-Sunday weeks, newest last', () => {
  const w = I.weekly([mem('a', { stats: { days: [{ k: '2026-10-19', s: 80, j: true }, { k: '2026-10-13', s: 60 }] } })], TODAY, 2);
  eq(w.map(x => [x.from, x.traders, x.disc, x.journaled]), [['2026-10-12', 1, 60, 0], ['2026-10-19', 1, 80, 100]]);
});

console.log('\nOver HTTP');
let clock = NOW;
const dataDir = mkdtempSync(join(tmpdir(), 'ledger-insights-'));
const app = server.createApp({ dataDir, auth: 'owner-token', htmlPath, now: () => clock, push: false, pushTick: false, trustProxy: true, offsiteTimer: false,
  fetchImpl: async () => ({ ok: true, status: 200, json: async () => [] }) });
const B = await new Promise(res => app.listen(0, () => res('http://127.0.0.1:' + app.address().port)));
let ipN = 0;
const call = async (p, o = {}) => { const r = await fetch(B + '/api/social' + p, { method: o.method || 'GET',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.4.0.' + (++ipN), ...(o.key ? { 'X-Pulse-Key': o.key } : {}), ...(o.owner ? { Authorization: 'Bearer owner-token' } : {}) },
    body: o.body !== undefined ? JSON.stringify(o.body) : undefined });
  return { status: r.status, d: await r.json().catch(() => ({})) }; };
const summary = (style, i) => ({ ok: true, v: 1, n: 40, style, size: 's2', exp: 'e2', act: 'a2', disc: 60 + i, rev: 5, jour: 50, wr: 45 + i, pf: 1 + i / 10, pay: 1.2, fees: 20, tw: 9, hold: 80 });
try {
  const keys = [];
  await t('the owner reads the whole league and any segment; members can’t', async () => {
    for (let i = 0; i < 7; i++) { const j = (await call('/join', { method: 'POST', body: { handle: 'trader' + i } })).d; keys.push(j);
      await call('/stats', { method: 'POST', key: j.key, body: { xp: 100 * i, days: [{ k: k(1), s: 50 + i * 5, j: i % 2 === 0 }], bench: summary(i < 5 ? 'day' : 'swing', i) } }); }
    eq((await call('/admin/insights', { key: keys[0].key })).status, 401);
    const all = (await call('/admin/insights?by=style', { owner: true })).d;
    eq([all.n, all.total, all.small], [7, 7, false]);
    eq(all.breakdown.map(g => [g.key, g.n, g.small]), [['day', 5, false], ['swing', 2, true]]);
    eq(all.summary.disc30, 65, 'median Discipline of 50…80');
    const day = (await call('/admin/insights?style=day&sort=wr', { owner: true })).d;
    eq([day.n, day.members[0].handle], [5, 'trader4'], 'filtered and sorted by win rate');
    const sw = (await call('/admin/insights?style=swing', { owner: true })).d;
    eq([sw.n, sw.small, sw.summary, sw.members.length], [2, true, null, 2], 'a small segment: names, no numbers');
  });
  await t('a member’s performance: their row, league percentiles, and their peer group when it exists', async () => {
    const p = (await call('/admin/members/' + keys[4].me.id + '/perf', { owner: true })).d;
    eq([p.row.handle, p.row.disc30, p.row.trading.wr], ['trader4', 70, 49]);
    ok(p.pct.disc30 > 50, 'better than most of the league: ' + p.pct.disc30);
    eq((await call('/admin/members/nope/perf', { owner: true })).status, 404);
    eq((await call('/admin/members/' + keys[4].me.id + '/perf', { key: keys[1].key })).status, 401);
  });
} finally { await new Promise(r => app.close(r)); }

report('insights');
