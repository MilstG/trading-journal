// "Traders like you": the summary every trader contributes (the same function in the app and on the
// server), the peer groups built from those summaries (deciles only, groups of `min` or more), the
// API members and the owner read, the opt-out, and seed wallets the owner bulk-adds, read from their
// public fills. Network is stubbed.
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { t, ok, eq, near, report, makeExtractor } from './harness.mjs';
import { readAppSource } from '../app-source.js';

const require = createRequire(import.meta.url);
const Bench = require('../bench.js');
const server = require('../server.js');
const htmlPath = new URL('../ledger.html', import.meta.url).pathname;
const html = readAppSource(htmlPath);
const { evalModule } = makeExtractor(html);
const { peerSummary } = await evalModule(['peerSummary', 'pzBehaviorDays', 'hasAdd', 'addedToLoser', 'nfMedian'], null, '');

const DAY = 86400000, NOW = Date.parse('2026-10-01T12:00:00Z');
// n closed trades, one a day at 10:00 going back from yesterday, held `hold` ms; every third loses
const trades = (n, o = {}) => Array.from({ length: n }, (_, i) => { const close = NOW - (i + 1) * (o.every || DAY) + (o.hold || 2 * 3600e3), win = i % 3 !== 0;
  return { id: 't' + i, openTime: close - (o.hold || 2 * 3600e3), closeTime: close, net: win ? 200 : -100, pnl: win ? 210 : -90, fees: 10, funding: 0, maxSize: o.size || 1, avgEntry: o.px || 5000, coin: 'BTC', dir: 'Long' }; });
const dayOf = ms => new Date(ms).toISOString().slice(0, 10);

console.log('The summary (app and server alike)');
t('a day trader’s last 90 days: style, size range, experience, activity and the numbers', () => {
  const s = peerSummary(trades(45), { now: NOW, dayOf, firstAt: NOW - 200 * DAY, isJournaled: x => +x.id.slice(1) % 2 === 0 });
  eq([s.ok, s.n, s.style, s.size, s.exp, s.act], [true, 45, 'day', 's2', 'e2', 'a1']);
  near(s.wr, 100 * 30 / 45, 0.1); near(s.pf, (30 * 200) / (15 * 100), 0.01); near(s.pay, 2, 0.01);
  near(s.jour, 100 * 23 / 45, 0.1); near(s.fees, 100 * 450 / (30 * 210), 0.1);
  eq(s.hold, 120); ok(s.disc > 0 && s.disc <= 100);
  for (const k of ['address', 'coin', 'net', 'trades']) ok(!(k in s), 'no ' + k + ' in a summary');
});
t('scalpers, swing traders and bigger sizes land in their own ranges', () => {
  eq(peerSummary(trades(60, { hold: 5 * 60000 }), { now: NOW, dayOf }).style, 'scalper');
  eq(peerSummary(trades(40, { hold: 3 * DAY, every: 2 * DAY }), { now: NOW, dayOf }).style, 'swing');
  eq(peerSummary(trades(40, { size: 10, px: 50000 }), { now: NOW, dayOf }).size, 's4');
  eq(peerSummary(trades(40), { now: NOW, dayOf }).jour, null, 'no journal (a seed wallet): not measured');
});
t('too few trades or under 2 weeks: no summary, and it says why; the owner sets the bar and the look-back', () => {
  eq(peerSummary(trades(12), { now: NOW, dayOf }), { ok: false, why: 'few', n: 12, need: 15, days: 90 }, '15 closed trades by default');
  eq(peerSummary(trades(20), { now: NOW, dayOf }).ok, true);
  eq(peerSummary(trades(20), { now: NOW, dayOf, minTrades: 30 }), { ok: false, why: 'few', n: 20, need: 30, days: 90 });
  eq(peerSummary(trades(8), { now: NOW, dayOf, minTrades: 3 }).need, 10, 'never under 10');
  eq(peerSummary(trades(40, { every: 6 * 3600e3 }), { now: NOW, dayOf }).why, 'short');
});

console.log('\nPeer groups');
const row = (style, size, exp, wr, extra) => Bench.sanitizeBench(Object.assign({ n: 40, style, size, exp, act: 'a2', disc: 70, rev: 5, wr, pf: wr / 40, pay: 1.2, fees: 15, tw: 8, hold: 90 }, extra));
t('summaries are checked: real ranges only, at least 30 trades, numbers clamped', () => {
  eq(Bench.sanitizeBench({ ...row('day', 's2', 'e2', 50), style: 'whale' }), null);
  eq(Bench.sanitizeBench({ ...row('day', 's2', 'e2', 50), n: 9 }), null, 'under 10 is never a summary');
  eq(Bench.sanitizeBenchCfg({ minTrades: 5, days: 365 }), Object.assign({}, Bench.DEFAULTS, { minTrades: 10, days: 90 }));
  eq(Bench.sanitizeBench({ ...row('day', 's2', 'e2', 50), wr: 400 }).wr, 100);
  eq(Bench.sanitizeBench({ ...row('day', 's2', 'e2', 50), jour: null }).jour, null);
});
t('only groups of `min` or more exist; below `splitAt` only everyone and same-style groups', () => {
  const rows = [...Array.from({ length: 40 }, (_, i) => row('day', 's2', 'e2', 40 + i)), ...Array.from({ length: 12 }, (_, i) => row('swing', 's3', 'e3', 50 + i))];
  const small = Bench.buildBenchmarks(rows, { min: 25, splitAt: 200 }, 1);
  eq(Object.keys(small.groups).sort(), ['all', 'style=day']); eq(small.split, false);
  const big = Bench.buildBenchmarks(rows, { min: 25, splitAt: 0 }, 1);
  ok(big.groups['style=day|size=s2|exp=e2'] && !big.groups['style=swing'], 'the 12 swing traders have no group of their own');
  const g = big.groups['style=day'];
  eq(g.n, 40); eq(g.q.wr.length, 9); near(g.q.wr[4], 59.5, 0.01, 'median win rate');
  ok(g.top.wr > g.q.wr[4], 'the best quarter by profit factor beats the median');
  ok(!('jour' in g.q), 'a measure too few traders have is left out');
  eq(Bench.groupsFor(big, { style: 'day', size: 's2', exp: 'e2', act: 'a2' }).map(x => x.key)[0], 'all', 'broadest first');
  eq(Bench.groupsFor(big, { style: 'swing', size: 's3', exp: 'e3', act: 'a2' }).map(x => x.key), ['all', 'act=a2'], 'only the groups big enough');
});
t('the group spread never carries anyone’s own numbers or identity', () => {
  const B = Bench.buildBenchmarks(Array.from({ length: 25 }, (_, i) => row('day', 's2', 'e2', 40 + i)), { min: 25, splitAt: 0 }, 1);
  eq(Object.keys(B.groups.all).sort(), ['dims', 'n', 'q', 'top']);
});

console.log('\nThe API, the opt-out and seed wallets');
const W = c => '0x' + c.repeat(40);
const fl = (side, sz, px, start, pnl, ms, i) => ({ coin: 'ETH', side, sz: String(sz), px: String(px), startPosition: String(start), closedPnl: String(pnl), fee: '0.5', crossed: true, time: ms, tid: i, oid: i });
// a seed wallet with 40 round trips over 40 days (two hours each, every third a loser), and one with 3
const FILLS = { [W('1')]: [], [W('2')]: [fl('B', 1, 100, 0, 0, NOW - 5 * DAY, 1), fl('A', 1, 101, 1, 1, NOW - 5 * DAY + 3600e3, 2)] };
for (let i = 0; i < 40; i++) { const t0 = NOW - (i + 1) * DAY, win = i % 3 !== 0;
  FILLS[W('1')].push(fl('B', 10, 100, 0, 0, t0, 2 * i + 1), fl('A', 10, win ? 102 : 99, 10, win ? 20 : -10, t0 + 2 * 3600e3, 2 * i + 2)); }
const PORT = [['month', { accountValueHistory: [[NOW - 30 * DAY, '1000'], [NOW, '1100']], pnlHistory: [[NOW - 30 * DAY, '0'], [NOW, '100']] }],
  ['allTime', { accountValueHistory: [[NOW - 400 * DAY, '0'], [NOW - 300 * DAY, '500'], [NOW, '1100']], pnlHistory: [[NOW - 300 * DAY, '0'], [NOW, '100']] }]];
let w1Down = false; // the exchange failing for a wallet that already counts
const fetchImpl = async (url, o) => { const b = JSON.parse(o.body), u = String(b.user || '').toLowerCase();
  if (u === W('9') || (w1Down && u === W('1'))) return { ok: false, status: 500, json: async () => ({}) };
  const out = b.type === 'portfolio' ? PORT : b.type === 'userFillsByTime' ? (FILLS[u] || []).filter(f => f.time >= (b.startTime || 0)) : [];
  return { ok: true, status: 200, json: async () => out }; };
const dataDir = mkdtempSync(join(tmpdir(), 'ledger-bench-'));
const mk = () => server.createApp({ dataDir, auth: 'owner-token', htmlPath, fetchImpl, now: () => NOW, push: false, pushTick: false, seedDelay: 0, trustProxy: true });
let app = mk();
const listen = () => new Promise(res => app.listen(0, () => res('http://127.0.0.1:' + app.address().port)));
let B = await listen();
const call = async (p, o = {}) => { const r = await fetch(B + '/api/social' + p, { method: o.method || 'GET',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': o.ip || '10.0.0.1', ...(o.key ? { 'X-Pulse-Key': o.key } : {}), ...(o.owner ? { Authorization: 'Bearer owner-token' } : {}) },
    body: o.body !== undefined ? JSON.stringify(o.body) : undefined });
  return { status: r.status, d: await r.json().catch(() => ({})) }; };
let ipN = 0;
const join_ = async h => (await call('/join', { method: 'POST', ip: '10.0.1.' + (++ipN), body: { handle: h } })).d.key;
const summary = i => ({ ok: true, v: 1, n: 40 + i, style: 'day', size: 's2', exp: 'e2', act: 'a2', disc: 50 + i, rev: 20 - i / 2, jour: 20 + i * 2, wr: 40 + i / 2, pf: 0.8 + i / 30, pay: 1.1, fees: 20, tw: 9, hold: 80, ret: 900, dd: 1 }); // ret/dd from an app: never trusted
const keys = [];
const waitFor = async (f, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await f()) return true; await new Promise(r => setTimeout(r, 20)); } return false; };
try {
  await t('members are counted by default: their summary rides along with the stats sync', async () => {
    await call('/admin/config', { method: 'PUT', owner: true, body: { bench: { min: 10, splitAt: 0 } } });
    for (let i = 0; i < 12; i++) { const k = await join_('peer' + i); keys.push(k);
      eq((await call('/stats', { method: 'POST', key: k, body: { xp: 10, bench: summary(i) } })).status, 200); }
    const me = (await call('/me', { key: keys[0] })).d; eq(me.share.bench, true, 'on unless switched off');
    const r = (await call('/bench?style=day&size=s2&exp=e2&act=a2', { key: keys[0] })).d;
    eq([r.on, r.contributors, r.members, r.seeds, r.split], [true, 12, 12, 0, true]);
    const all = r.groups.find(g => g.key === 'all'), mine = r.groups[r.groups.length - 1];
    eq(mine.key, 'style=day|size=s2|exp=e2|act=a2'); eq(all.n, 12); eq(all.q.disc.length, 9); eq(all.top.disc, undefined, 'a best quarter of 3 traders is too few to show');
    eq(r.mine, { share: true, have: true, at: NOW });
    eq([all.q.ret, all.q.dd], [undefined, undefined], 'returns come only from the chain, never from what an app sends');
  });
  await t('switching off removes the summary from the next build; the owner can read groups too', async () => {
    await call('/me', { method: 'PUT', key: keys[0], body: { share: { bench: false } } });
    await call('/admin/bench', { method: 'POST', owner: true, body: { action: 'rebuild' } });
    eq((await call('/bench', { key: keys[1] })).d.contributors, 11);
    eq((await call('/stats', { method: 'POST', key: keys[0], body: { xp: 11, bench: summary(0) } })).status, 200);
    await call('/admin/bench', { method: 'POST', owner: true, body: { action: 'rebuild' } });
    eq((await call('/bench', { owner: true })).d.contributors, 11, 'a switched-off member stays out even when their app sends one');
    eq((await call('/bench')).status, 401, 'strangers get nothing');
  });
  await t('below the smallest group size nothing is shown', async () => {
    await call('/admin/config', { method: 'PUT', owner: true, body: { bench: { min: 25 } } });
    const r = (await call('/bench?style=day', { key: keys[1] })).d; eq([r.groups.length, r.min, r.contributors], [0, 25, 11]);
    const rr = await call('/admin/config', { method: 'PUT', owner: true, body: { bench: { min: 3 } } });
    eq([rr.status, rr.d.error], [400, 'Traders like you → min must be from 10 to 1000 (not 3).'], 'never under 10: refused, not clamped');
  });
  await t('seed wallets: paste anything, each address is read once from its public fills', async () => {
    const text = `wallets,label\n${W('1')},good one\n${W('2').toUpperCase().replace('0X', '0x')},tiny\n${W('9')}\n${W('1')} again\nnot a wallet 0x123`;
    const r = (await call('/admin/bench', { method: 'POST', owner: true, body: { action: 'seed', text } })).d;
    eq([r.found, r.added, r.dupes], [3, 3, 0]);
    eq((await call('/admin/bench', { method: 'POST', owner: true, body: { action: 'seed', text: W('1') } })).d.dupes, 1);
    ok(await waitFor(async () => (await call('/admin/bench', { owner: true })).d.seedCounts.queued === 0), 'all three were read');
    const a = (await call('/admin/bench', { owner: true })).d, st = Object.fromEntries(a.seedList.map(x => [x.address, x]));
    eq([st[W('1')].st, st[W('1')].style, st[W('1')].n], ['ok', 'day', 40]);
    eq([st[W('2')].st, st[W('2')].why], ['skip', '1 closed trade in the last 90 days (needs 15)']);
    eq(st[W('9')].st, 'err');
    eq([a.contributors, a.members, a.seeds], [12, 11, 1]);
  });
  await t('a seed wallet’s summary is the app’s own: on-chain return and experience included', async () => {
    const sum = (await call('/admin/bench', { owner: true })).d.seedList.find(x => x.address === W('1'));
    eq([sum.style, sum.size, sum.exp, sum.act], ['day', 's2', 'e2', 'a1'], '10 ETH at 100: a $1k–10k trade; first funded 300 days ago');
    near(sum.ret, 10, 0.01); near(sum.wr, 100 * 26 / 40, 0.1);
  });
  await t('re-analyze: one wallet or all of them; a counted one keeps counting until its new read lands', async () => {
    const one = (await call('/admin/bench', { method: 'POST', owner: true, body: { action: 'reread', address: W('1') } })).d;
    eq([one.requeued, one.counts.re, one.counts.ok], [1, 1, 1]);
    const mid = (await call('/admin/bench', { owner: true })).d, x1 = mid.seedList.find(x => x.address === W('1'));
    eq([x1.st, mid.seeds], ['ok', 1], 'still counted while it waits (or already read again: the test server reads at once)');
    ok(await waitFor(async () => (await call('/admin/bench', { owner: true })).d.seedCounts.re === 0), 're-read');
    const all = (await call('/admin/bench', { method: 'POST', owner: true, body: { action: 'reread' } })).d;
    eq([all.requeued, all.counts.queued, all.counts.re], [3, 2, 1], 'the counted one is flagged, the left-out and failed ones go back in the queue');
    ok(await waitFor(async () => { const c = (await call('/admin/bench', { owner: true })).d.seedCounts; return c.queued === 0 && c.re === 0; }));
    const a = (await call('/admin/bench', { owner: true })).d, st = Object.fromEntries(a.seedList.map(x => [x.address, x]));
    eq([st[W('1')].st, st[W('2')].st, st[W('9')].st, st[W('1')].re], ['ok', 'skip', 'err', false]);
    eq((await call('/admin/bench', { method: 'POST', key: keys[1], body: { action: 'reread' } })).status, 401, 'members can’t');
    w1Down = true;
    await call('/admin/bench', { method: 'POST', owner: true, body: { action: 'reread', address: W('1') } });
    ok(await waitFor(async () => (await call('/admin/bench', { owner: true })).d.seedCounts.re === 0), 'the failed re-read finished');
    const after = (await call('/admin/bench', { owner: true })).d, x = after.seedList.find(y => y.address === W('1'));
    eq([x.st, x.style, after.seeds], ['ok', 'day', 1], 'a failed re-read keeps the last good read counted');
    ok(/^last re-read failed/.test(x.why), x.why);
    w1Down = false;
    await call('/admin/bench', { method: 'POST', owner: true, body: { action: 'reread', address: W('1') } });
    ok(await waitFor(async () => (await call('/admin/bench', { owner: true })).d.seedCounts.re === 0));
    eq((await call('/admin/bench', { owner: true })).d.seedList.find(y => y.address === W('1')).why, '', 'a good read clears the note');
  });
  await t('failed ones can be retried or removed; settings and seeds survive a restart', async () => {
    eq((await call('/admin/bench', { method: 'POST', owner: true, body: { action: 'retry' } })).d.requeued, 1);
    ok(await waitFor(async () => (await call('/admin/bench', { owner: true })).d.seedCounts.queued === 0));
    eq((await call('/admin/bench', { method: 'POST', owner: true, body: { action: 'remove', which: 'err' } })).d.removed, 1);
    await new Promise(r => app.close(r)); app = mk(); B = await listen();
    const a = (await call('/admin/bench', { owner: true })).d;
    eq([a.config.min, a.seedCounts.ok, a.seedCounts.skip, a.seedCounts.err || 0], [25, 1, 1, 0]);
    eq((await call('/admin/bench', { method: 'POST', key: keys[1], body: { action: 'remove', which: 'all' } })).status, 401, 'members can’t');
    const many = Array.from({ length: 6000 }, (_, i) => '0x' + (i + 1000).toString(16).padStart(40, '0')).join('\n'); // ~260 KB
    const big = (await call('/admin/bench', { method: 'POST', owner: true, body: { action: 'seed', text: many } })).d;
    eq([big.found, big.added, big.full], [6000, 4998, 1002], 'a big paste goes in at once, up to 5,000 wallets in all');
    eq((await call('/admin/bench', { method: 'POST', owner: true, body: { action: 'remove', which: 'all' } })).d.removed, 5000);
  });
  await t('“Traders like you” is a feature the owner can tie to a level (free by default)', async () => {
    const c = (await call('/config')).d; eq(c.modules.peers, 1); eq(c.bench, { on: true, minTrades: 15, days: 90 });
    await call('/admin/config', { method: 'PUT', owner: true, body: { unlocksOn: true, modules: { peers: 3 } } });
    const locked = await call('/bench', { key: keys[1] }); eq(locked.status, 403, 'the server holds the level too'); ok(/level 3/.test(locked.d.error));
    eq((await call('/bench', { owner: true })).status, 200, 'the owner always can');
    await call('/admin/config', { method: 'PUT', owner: true, body: { bench: { on: false } } });
    const c2 = (await call('/config')).d; eq([c2.modules.peers, c2.bench.on], [3, false]);
    eq((await call('/bench', { key: keys[1] })).d, { on: false });
  });
} finally { await new Promise(r => app.close(r)); }

report('benchmarks');
