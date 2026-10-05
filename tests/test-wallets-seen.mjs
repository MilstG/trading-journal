// Wallets entered in the app (social.js POST /seen): every address goes to the owner's Wallets list,
// profile or not, and is queued as a benchmark seed wallet so "traders like you" counts it once it has
// traded enough. Counted seed wallets are read again daily, left-out ones weekly. Exercised over real
// HTTP with a stubbed Hyperliquid and a clock the tests move.
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { t, ok, eq, report } from './harness.mjs';

const require = createRequire(import.meta.url);
const server = require('../server.js');
const htmlPath = new URL('../ledger.html', import.meta.url).pathname;

const DAY = 86400000, HOUR = 3600000;
let clock = Date.parse('2026-09-30T12:00:00Z');
const W = c => '0x' + c.repeat(40);
const fl = (side, sz, px, start, pnl, ms, i) => ({ coin: 'ETH', side, sz: String(sz), px: String(px), startPosition: String(start), closedPnl: String(pnl), fee: '0.5', crossed: true, time: ms, tid: i, oid: i });
// W('1') trades enough to count (40 round trips over 40 days); W('2') has one trade; W('3') none
const FILLS = { [W('1')]: [], [W('2')]: [fl('B', 1, 100, 0, 0, clock - 5 * DAY, 1), fl('A', 1, 101, 1, 1, clock - 5 * DAY + HOUR, 2)] };
for (let i = 0; i < 40; i++) { const t0 = clock - (i + 1) * DAY, win = i % 3 !== 0;
  FILLS[W('1')].push(fl('B', 10, 100, 0, 0, t0, 2 * i + 1), fl('A', 10, win ? 102 : 99, 10, win ? 20 : -10, t0 + 2 * HOUR, 2 * i + 2)); }
const reads = []; // whose fills the server asked for
const fetchImpl = async (url, o) => { const b = JSON.parse(o.body), u = String(b.user || '').toLowerCase();
  if (b.type === 'userFillsByTime' && !reads.includes(u + '@' + clock)) reads.push(u + '@' + clock);
  const out = b.type === 'userFillsByTime' ? (FILLS[u] || []).filter(f => f.time >= (b.startTime || 0)) : [];
  return { ok: true, status: 200, json: async () => out }; };
const dataDir = mkdtempSync(join(tmpdir(), 'ledger-seen-'));
const mk = (dir = dataDir) => server.createApp({ dataDir: dir, auth: 'owner-token', htmlPath, fetchImpl, now: () => clock, push: false, pushTick: false, seedDelay: 0, trustProxy: true });
let app = mk();
const listen = () => new Promise(res => app.listen(0, () => res('http://127.0.0.1:' + app.address().port)));
let B = await listen();
const call = async (p, o = {}) => { const r = await fetch(B + '/api/social' + p, { method: o.method || 'GET',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': o.ip || '10.0.0.1', ...(o.key ? { 'X-Pulse-Key': o.key } : {}), ...(o.owner ? { Authorization: 'Bearer owner-token' } : {}) },
    body: o.body !== undefined ? JSON.stringify(o.body) : undefined });
  return { status: r.status, d: await r.json().catch(() => ({})) }; };
const seen = (addresses, ip) => call('/seen', { method: 'POST', ip, body: { addresses } });
const wallets = async () => (await call('/admin/wallets', { owner: true })).d;
const seeds = async () => Object.fromEntries((await call('/admin/bench', { owner: true })).d.seedList.map(x => [x.address, x]));
const waitFor = async (f, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await f()) return true; await new Promise(r => setTimeout(r, 20)); } return false; };
const settle = () => waitFor(async () => (await call('/admin/bench', { owner: true })).d.seedCounts.queued === 0 && !(await call('/admin/bench', { owner: true })).d.seedCounts.re);
// nudges the seed reader the way the server's periodic tick does (pushTick is off in tests)
const nudge = () => call('/admin/bench', { method: 'POST', owner: true, body: { action: 'retry' } });

try {
  await t('a wallet entered without a profile is listed under Wallets', async () => {
    eq((await seen([W('1'), W('2').toUpperCase().replace('0X', '0x'), 'nope', W('1')])).status, 200);
    const w = await wallets(), by = Object.fromEntries(w.wallets.map(x => [x.address, x]));
    ok(by[W('1')] && by[W('2')], 'both addresses, lower-cased, once each');
    eq([by[W('1')].members, by[W('1')].seen.first, by[W('1')].status], [[], clock, 'pending']);
    eq(w.counts.app, 2); eq(w.counts.pending, 0, 'nothing for the owner to approve: no profile uses them');
    eq((await seen(['not a wallet'])).status, 400);
    eq((await call('/admin/wallets')).status, 401, 'strangers can’t read the list');
  });
  await t('it is queued for the benchmarks and counts once it has traded enough', async () => {
    ok(await settle(), 'read');
    const s = await seeds();
    eq([s[W('1')].st, s[W('1')].by, s[W('2')].st], ['ok', 'app', 'skip']);
    const by = Object.fromEntries((await wallets()).wallets.map(x => [x.address, x]));
    eq([by[W('1')].bench, by[W('2')].bench], ['ok', 'skip']);
    eq((await call('/admin/bench', { owner: true })).d.seeds, 1, 'the usable one is in the groups');
  });
  await t('a member’s wallet entered in the app shows its member, not “no profile”', async () => {
    const r = await call('/join', { method: 'POST', ip: '10.0.2.1', body: { handle: 'carol', address: W('3'), share: { verify: true } } });
    eq(r.status, 200); await seen([W('3')]);
    const row = (await wallets()).wallets.find(x => x.address === W('3'));
    eq([row.members.map(m => m.handle), !!row.seen], [['carol'], true]);
    eq((await wallets()).counts.app, 2);
  });
  await t('a rejected wallet is listed but never queued for the benchmarks', async () => {
    await call('/admin/wallets', { method: 'POST', owner: true, body: { action: 'reject', addresses: [W('4')] } });
    await seen([W('4')]);
    eq((await seeds())[W('4')], undefined);
    ok((await wallets()).wallets.some(x => x.address === W('4') && x.seen));
  });
  await t('counted seed wallets are read again daily; left-out ones weekly', async () => {
    await settle(); const before = await seeds();
    clock += 2 * HOUR; await nudge(); await settle();
    eq((await seeds())[W('1')].done, before[W('1')].done, 'not again within the day');
    clock += DAY; await nudge(); ok(await waitFor(async () => (await seeds())[W('1')].done === clock), 'read again after a day');
    eq((await seeds())[W('2')].done, before[W('2')].done, 'a left-out one waits a week');
    clock += 6 * DAY; await nudge(); ok(await waitFor(async () => (await seeds())[W('2')].done === clock), 'read again after a week');
    eq((await seeds())[W('1')].st, 'ok', 'still counted');
  });
  await t('“last seen” moves at most once a day; it all survives a restart', async () => {
    await seen([W('1')]); // a week on: today's first report moves it
    const first = (await wallets()).wallets.find(x => x.address === W('1')).seen;
    eq(first.last, clock); ok(first.first < first.last, 'first seen stays put');
    clock += HOUR; await seen([W('1')]);
    eq((await wallets()).wallets.find(x => x.address === W('1')).seen.last, first.last, 'same day');
    clock += DAY; await seen([W('1')]);
    eq((await wallets()).wallets.find(x => x.address === W('1')).seen.last, clock);
    await settle(); await new Promise(r => app.close(r)); app = mk(); B = await listen();
    const row = (await wallets()).wallets.find(x => x.address === W('1'));
    eq([row.seen.first, row.seen.last], [first.first, clock]);
    eq((await seeds())[W('1')].by, 'app');
  });
  await t('one place can’t flood it', async () => {
    let last = 0; for (let i = 0; i < 31; i++) last = (await seen([W('5')], '10.9.9.9')).status;
    eq(last, 429);
    eq((await seen([W('5')], '10.9.9.8')).status, 200, 'others are unaffected');
  });
} finally { await new Promise(r => app.close(r)); }

// many places at once, on a fresh server: wallets entered in the app get a share of the seed places, never all of them
app = mk(mkdtempSync(join(tmpdir(), 'ledger-seen-many-'))); B = await listen();
const A = i => '0x' + (0xa000000 + i).toString(16).padStart(40, '0');
let ipN = 0; const fromMany = async (n, from) => { for (let r = 0; r < n; r++) eq((await seen(Array.from({ length: 20 }, (_, k) => A(from + r * 20 + k)), '10.' + (++ipN >> 8 & 255) + '.' + (ipN & 255) + '.7')).status, 200); };
const total = async () => { const c = (await call('/admin/bench', { owner: true })).d.seedCounts; return c.queued + c.ok + c.skip + c.err; };
try {
  await t('many places together queue at most 200 new seed wallets a day', async () => {
    await fromMany(15, 0); // 300 wallets from 15 addresses
    eq(await total(), 200);
    eq((await wallets()).counts.app, 300, 'every one is still listed for the owner');
  });
  await t('and never more than their share of the seed places', async () => {
    for (let d = 1; d <= 5; d++) { clock += DAY; await fromMany(10, 1000 * d); }
    eq(await total(), 1000, 'four days at 200, then the share is full');
  });
  await t('the owner’s own seed wallets still queue when the app’s share is full', async () => {
    const r = await call('/admin/bench', { method: 'POST', owner: true, body: { action: 'seed', text: [W('a'), W('b'), W('c')].join(' ') } });
    eq([r.d.added, r.d.full], [3, 0]);
    const s = await seeds(); eq([s[W('a')].by, s[W('c')].by], ['owner', 'owner']); eq(await total(), 1003);
  });
  await t('everyone together has a ceiling per 10 minutes', async () => {
    clock += 11 * 60000;
    for (let i = 0; i < 300; i++) eq((await seen([W('d')], '10.200.' + (i >> 8) + '.' + (i & 255))).status, 200);
    eq((await seen([W('d')], '10.201.0.1')).status, 429, 'a new address too');
    clock += 10 * 60000; eq((await seen([W('d')], '10.201.0.1')).status, 200, 'the next window');
  });
  await waitFor(async () => (await call('/admin/bench', { owner: true })).d.seedCounts.queued === 0, 30000);
} finally { await new Promise(r => app.close(r)); }

// an app backlog never holds up the owner's seed wallets: theirs are read next
const order = []; let gate = null;
app = server.createApp({ dataDir: mkdtempSync(join(tmpdir(), 'ledger-seen-order-')), auth: 'owner-token', htmlPath, fetchImpl, now: () => clock, push: false, pushTick: false, seedDelay: 0, trustProxy: true,
  peerSummaryFor: async a => { order.push(a); if (order.length === 1) await new Promise(r => { gate = r; }); return { ok: false, why: 'few', n: 0 }; } });
B = await listen();
try {
  await t('the owner’s queued seed wallets are read before the app’s', async () => {
    await seen(Array.from({ length: 5 }, (_, k) => A(9000 + k)), '10.250.0.1');
    ok(await waitFor(() => gate), 'the first app wallet is being read');
    await call('/admin/bench', { method: 'POST', owner: true, body: { action: 'seed', text: W('e') } });
    gate(); ok(await waitFor(() => order.length === 6));
    eq([order[0], order[1]], [A(9000), W('e')]);
  });
} finally { await new Promise(r => app.close(r)); }

report('wallets entered in the app');
