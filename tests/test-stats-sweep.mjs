// Background refresh of members' on-chain numbers (statsSweep, from the social minute tick): how
// stale each member may get by how recently they were seen (or whether they're in a running contest),
// most overdue first, only into free fetch slots, and a failing wallet waits a full interval.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { t, ok, eq, report } from './harness.mjs';

const require = createRequire(import.meta.url);
const server = require('../server.js');
const htmlPath = new URL('../ledger.html', import.meta.url).pathname;

const M = 60000, H = 3600000, DAY = 86400000;
const T0 = Date.parse('2026-10-01T12:00:00Z');
let clock = T0;
const PORT = [['month', { accountValueHistory: [[T0 - 20 * DAY, '1000'], [T0, '1100']], pnlHistory: [[T0 - 20 * DAY, '0'], [T0, '100']] }]];
const reads = []; // [type, user]
const failFor = new Set();
let hold = null; // a promise portfolio reads wait on (to keep slots busy)
const fetchImpl = async (url, o) => { const b = JSON.parse(o.body || '{}'); const u = String(b.user || '').toLowerCase();
  reads.push([b.type, u]);
  if (b.type === 'portfolio' && hold) await hold;
  if (failFor.has(u)) return { ok: false, status: 500, json: async () => ({}) };
  return { ok: true, status: 200, json: async () => b.type === 'portfolio' ? PORT : [] }; };
const settle = () => new Promise(r => setTimeout(r, 40));
const addr = c => '0x' + c.repeat(40);
const portfolioReads = () => reads.filter(r => r[0] === 'portfolio').map(r => r[1]);
const fillReads = () => [...new Set(reads.filter(r => r[0] === 'userFillsByTime').map(r => r[1]))];

const dataDir = mkdtempSync(join(tmpdir(), 'ledger-sweep-'));
const app = server.createApp({ dataDir, auth: 'owner-token', htmlPath, now: () => clock, pushTick: false, fetchImpl, offsiteTimer: false });
const B = await new Promise(res => app.listen(0, () => res('http://127.0.0.1:' + app.address().port)));
const call = async (p, o = {}) => { const r = await fetch(B + '/api/social' + p, { method: o.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(o.admin ? { Authorization: 'Bearer owner-token' } : {}) }, body: o.body !== undefined ? JSON.stringify(o.body) : undefined });
  return { status: r.status, d: await r.json().catch(() => ({})) }; };
const soc = app._social, S = soc.state();
const byHandle = h => Object.values(S.members).find(m => m.handle === h);
try {
  await call('/admin/config', { method: 'PUT', admin: true, body: { requireClaim: false } });
  // (verified Discipline is on by default: off here but for the last)
  // active (seen now), monthly (seen 20 days ago), dormant (200 days), quiet (no sharing), verify (Discipline too)
  for (const [h, c, share] of [['active', 'a', { ret: true, verify: false }], ['monthly', 'b', { ret: true, verify: false }], ['dormant', 'c', { usd: true, verify: false }],
    ['quiet', 'd', { ret: false, usd: false, verify: false }], ['verifier', 'e', { verify: true }]])
    eq((await call('/join', { method: 'POST', body: { handle: h, address: addr(c), share } })).status, 200, h + ' joined');
  await settle();
  byHandle('monthly').lastSeen = T0 - 20 * DAY;
  byHandle('dormant').lastSeen = T0 - 200 * DAY;

  await t('just read on joining: nothing is due', async () => {
    ok(byHandle('active').money && byHandle('active').money.at === T0, 'joining reads the wallet');
    reads.length = 0;
    eq(soc.statsSweep(), { money: 0, behavior: 0 }); await settle(); eq(reads.length, 0);
  });
  await t('after 4 hours: members seen this week are read again, dormant and unshared ones are not', async () => {
    clock = T0 + 4 * H + M; reads.length = 0;
    const r = soc.statsSweep(); await settle();
    eq(r.money, 1, 'only the active member is due for returns'); eq(portfolioReads(), [addr('a')]);
    eq(r.behavior, 1); eq(fillReads(), [addr('e')], 'verified Discipline re-read from fills');
    eq(byHandle('active').money.at, clock);
    eq(soc.statsSweep(), { money: 0, behavior: 0 }, 'just read: not again');
  });
  await t('after 12 hours: members seen this month too; after 2 days, still never the 200-days-away one', async () => {
    clock = T0 + 12 * H + M; reads.length = 0;
    soc.statsSweep(); await settle();
    eq(portfolioReads().sort(), [addr('a'), addr('b')]);
    clock = T0 + 3 * DAY; reads.length = 0;
    soc.statsSweep(); await settle(); soc.statsSweep(); await settle();
    ok(!portfolioReads().includes(addr('c')), 'dormant is left to the boards that show it');
    ok(!portfolioReads().includes(addr('d')), 'not sharing returns: never read');
  });
  await t('a member in a running duel is read every 4 hours however long since they were seen', async () => {
    const dm = byHandle('dormant'), am = byHandle('active');
    S.duels.sweeptest = { id: 'sweeptest', status: 'active', a: dm.id, b: am.id };
    clock += 4 * H + M; reads.length = 0;
    soc.statsSweep(); await settle();
    ok(portfolioReads().includes(addr('c')), JSON.stringify(portfolioReads()));
    delete S.duels.sweeptest;
  });
  await t('most overdue first, at most two portfolio reads per pass', async () => {
    const t0 = clock;
    byHandle('active').money.at = t0 - 5 * H;  // 1 h overdue on 4 h
    byHandle('monthly').money.at = t0 - 30 * H; // 18 h overdue on 12 h
    byHandle('dormant').lastSeen = t0 - 3 * DAY; byHandle('dormant').money.at = t0 - 9 * H; // seen this week now: 5 h overdue
    reads.length = 0;
    eq(soc.statsSweep().money, 2); await settle();
    eq(portfolioReads(), [addr('b'), addr('c')]);
  });
  await t('only free slots: reads people are waiting on keep one, and a busy sweep starts nothing', async () => {
    let open; hold = new Promise(r => { open = r; });
    clock += 2 * DAY; reads.length = 0;
    eq(soc.statsSweep().money, 2, 'two of the three slots');
    eq(soc.statsSweep().money, 0, 'both sweep slots still busy');
    open(); hold = null; await settle();
    eq(soc.statsSweep().money, 1, 'freed: the one left');
    await settle();
  });
  await t('a failing wallet counts as read: the sweep waits a full interval, not the 10-minute backoff', async () => {
    failFor.add(addr('a'));
    clock += 5 * H; reads.length = 0;
    soc.statsSweep(); await settle();
    ok(byHandle('active').moneyFailAt === clock, 'the read failed');
    clock += 30 * M; reads.length = 0;
    soc.statsSweep(); await settle();
    ok(!portfolioReads().includes(addr('a')), 'not retried 30 minutes later');
    failFor.delete(addr('a'));
    clock += 4 * H; reads.length = 0;
    soc.statsSweep(); await settle();
    ok(portfolioReads().includes(addr('a')), 'tried again after its interval');
    ok(byHandle('active').money.at === clock && !byHandle('active').moneyFailAt, 'and read');
  });
  await t('banned members are never swept', async () => {
    byHandle('monthly').banned = true; byHandle('monthly').lastSeen = clock;
    clock += 2 * DAY; reads.length = 0;
    soc.statsSweep(); await settle(); soc.statsSweep(); await settle();
    ok(!portfolioReads().includes(addr('b')));
    byHandle('monthly').banned = false;
  });
  await t('the minute tick runs it', async () => {
    clock += 2 * DAY; reads.length = 0;
    await app.pushTick(); await settle();
    ok(portfolioReads().length >= 1, 'portfolio read from the tick');
  });
} finally { app.close(); }

await t('statsSweep: false turns it off', async () => {
  const d2 = mkdtempSync(join(tmpdir(), 'ledger-sweep-off-'));
  const app2 = server.createApp({ dataDir: d2, auth: 'owner-token', htmlPath, now: () => clock, pushTick: false, fetchImpl, offsiteTimer: false, statsSweep: false });
  try { eq(app2._social.statsSweep(), { money: 0, behavior: 0 }); } finally { app2.close(); }
});
report('stats sweep');
