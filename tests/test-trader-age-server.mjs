// Verified Trader Age (spec step 4): the server scores a member's last 6 months from their wallet's
// fills with the app's own traderAge, adds the prep, journal and loss-limit days their app reports,
// and hands it back on /me; the fills cache grows to 6 months and refills an older, shorter cache.
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { t, ok, eq, near, report } from './harness.mjs';

const require = createRequire(import.meta.url);
const server = require('../server.js');
const S = require('../social.js');
const htmlPath = new URL('../ledger.html', import.meta.url).pathname;
const DAY = 864e5, ADDR = '0x' + 'b'.repeat(40);
let clock = Date.parse('2026-10-20T20:00:00Z');
const key = ms => new Date(ms).toISOString().slice(0, 10);
// 20 clean trading days: a buy and a winning sell each day (Discipline 100)
const FILLS = [];
for (let i = 19; i >= 0; i--) { const d = clock - i * DAY - 6 * 3600e3;
  FILLS.push({ coin: 'ETH', side: 'B', sz: '1', px: '100', startPosition: '0', closedPnl: '0', fee: '0', crossed: true, time: d, tid: 2 * i + 1, oid: 2 * i + 1 },
    { coin: 'ETH', side: 'A', sz: '1', px: '110', startPosition: '1', closedPnl: '10', fee: '0', crossed: true, time: d + 3600e3, tid: 2 * i + 2, oid: 2 * i + 2 }); }
// a second wallet: every day one revenge entry in four trades (Discipline 75, the same every day)
const ADDR2 = '0x' + 'c'.repeat(40), F2 = [];
const wobblyDay = (ms, n) => { const f = (side, px, sp, pnl, t, i) => ({ coin: 'ETH', side, sz: '1', px: String(px), startPosition: String(sp), closedPnl: String(pnl), fee: '0', crossed: true, time: t, tid: i, oid: i }), h = 3600e3;
  F2.push(f('B', 100, 0, 0, ms, n), f('A', 110, 1, 10, ms + h, n + 1), f('B', 100, 0, 0, ms + 2 * h, n + 2), f('A', 90, 1, -10, ms + 2 * h + 600e3, n + 3),
    f('B', 100, 0, 0, ms + 2 * h + 900e3, n + 4), f('A', 110, 1, 10, ms + 3 * h, n + 5), f('B', 100, 0, 0, ms + 4 * h, n + 6), f('A', 110, 1, 10, ms + 5 * h, n + 7)); };
for (let i = 19; i >= 0; i--) wobblyDay(Date.parse(key(clock - i * DAY) + 'T08:00:00Z'), 1000 + 10 * i);
const starts = [];
const fetchImpl = async (url, o) => { const b = JSON.parse(o.body);
  if (b.type === 'userFillsByTime' && String(b.user).toLowerCase() === ADDR2) return { ok: true, status: 200, json: async () => F2.filter(f => f.time >= (b.startTime || 0)) };
  if (b.type === 'userFillsByTime' && String(b.user).toLowerCase() === ADDR) { starts.push(b.startTime); return { ok: true, status: 200, json: async () => FILLS.filter(f => f.time >= (b.startTime || 0)) }; }
  return { ok: true, status: 200, json: async () => (b.type === 'portfolio' ? [] : []) }; };
const dataDir = mkdtempSync(join(tmpdir(), 'ledger-ta-srv-'));
// a cache from before the window grew: v1, holding only the last few days
mkdirSync(join(dataDir, 'social-fills'), { recursive: true });
writeFileSync(join(dataDir, 'social-fills', ADDR + '.json.gz'), gzipSync(JSON.stringify({ v: 1, fills: FILLS.slice(-4) })));
const app = server.createApp({ dataDir, auth: 'owner-token', htmlPath, fetchImpl, now: () => clock, push: false, pushTick: false, offsiteTimer: false });
const B = await new Promise(r => app.listen(0, () => r('http://127.0.0.1:' + app.address().port)));
const call = async (p, o = {}) => { const r = await fetch(B + '/api/social' + p, { method: o.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(o.key ? { 'X-Pulse-Key': o.key } : {}), ...(o.owner ? { Authorization: 'Bearer owner-token' } : {}) },
    body: o.body !== undefined ? JSON.stringify(o.body) : undefined });
  return { status: r.status, d: await r.json().catch(() => ({})) }; };
const until = async (f, ms = 3000) => { const end = Date.now() + ms; for (;;) { const v = await f(); if (v || Date.now() > end) return v; await new Promise(r => setTimeout(r, 40)); } };
// what the app sends: the days, with a check-in and a plan every day, half the trades journaled, no loss limit set
const stats = () => ({ xp: 100, level: 1, tz: 'UTC', firstAt: clock - 400 * DAY,
  days: Array.from({ length: 20 }, (_, i) => ({ k: key(clock - (19 - i) * DAY), s: 100, b: false, j: false, p: 1, pl: 1, jn: 0.5 })) });
let K;
try {
  await t('the stats the app sends carry prep, journal share, loss limit and the first fill, cleaned', () => {
    const s = S.sanitizeStats({ firstAt: 5, days: [{ k: '2026-10-01', s: 80, p: 'yes', jn: 3, lm: 0, pl: 0.5 }, { k: '2026-10-02', s: 80, lm: 7, jn: 0.333, pl: 2 }] });
    eq(s.firstAt, 1420070400000, 'clamped to 2015 or later');
    eq([s.days[0].p, s.days[0].jn, s.days[0].lm, s.days[0].pl], [1, 1, 0, 0.5]); eq([s.days[1].p, s.days[1].jn, s.days[1].lm, s.days[1].pl], [undefined, 0.33, undefined, undefined]);
  });
  await t('a member whose wallet the server reads gets a verified Trader Age on /me', async () => {
    await call('/admin/config', { method: 'PUT', owner: true, body: { requireClaim: false, unlocksOn: false } });
    K = (await call('/join', { method: 'POST', body: { handle: 'steady_one', address: ADDR, share: { verify: true } } })).d.key;
    eq((await call('/stats', { method: 'POST', key: K, body: stats() })).status, 200);
    const ta = await until(async () => { const m = (await call('/me', { key: K })).d.me; return m.ta && m.ta.n >= 20 ? m.ta : null; });
    ok(ta, 'verified'); eq([ta.n, ta.building], [20, false]);
    // Discipline 100 from the fills, steady, no limit set (70), prep (a plan) 50 + half journaled 25
    eq([ta.parts.discipline, ta.parts.steadiness, ta.parts.limit, ta.parts.log], [100, 100, 70, 75]);
    near(ta.raw, 94.5, 0.05); near(ta.age, 7.8, 0.05, 'held toward 1 year with 20 days'); eq(ta.sure, 0.67); ok(ta.range[0] <= ta.age && ta.range[1] >= ta.age);
    near(ta.tradingYears, 400 / 365.25, 0.05); eq(ta.week.n, 7); ok(ta.pace > 0);
  });
  await t('the fills cache grew to 6 months: an older 50-day (v1) cache is read again from the start of the window', () => {
    const first = Math.min(...starts);
    ok(Math.abs(first - (clock - 183 * DAY)) < DAY, 'fetched from 6 months back, not from the cached last fill: ' + new Date(first).toISOString());
  });
  await t('the multiplier: finished weeks move it, the week under way gets it, and the owner’s tiers apply', async () => {
    // 20 days to Tuesday Oct 20: of the finished weeks only Oct 12–18 has 15+ days behind it, and it was good
    let me = (await call('/me', { key: K })).d.me;
    eq([me.mult.held, me.mult.now, me.mult.next.toGo, me.mult.next.mult], [1, 1, 1, 1.05]);
    eq(me.mult.hist, { '2026-W43': 1 }, 'this week, at ×1');
    // the owner makes 1 good week worth ×1.1: the next sync gives this week ×1.1, the weeks already counted aren't recounted
    eq((await call('/admin/config', { method: 'PUT', owner: true, body: { mult: { on: true, bar: 70, tiers: [[1, 1.1], [3, 1.2]] } } })).status, 200);
    await call('/stats', { method: 'POST', key: K, body: stats() });
    me = (await call('/me', { key: K })).d.me;
    eq([me.mult.held, me.mult.now, me.mult.hist['2026-W43']], [1, 1.1, 1.1]);
    // tiers whose multiplier goes down are refused (weeks are sorted); the last good ones stay
    await call('/admin/config', { method: 'PUT', owner: true, body: { mult: { tiers: [[2, 1.5], [4, 1.2]] } } });
    eq((await call('/config')).d.mult.tiers, [[1, 1.1], [3, 1.2]]);
    // off: this week goes back to ×1
    await call('/admin/config', { method: 'PUT', owner: true, body: { mult: { on: false } } });
    await call('/stats', { method: 'POST', key: K, body: stats() });
    eq((await call('/me', { key: K })).d.me.mult.now, 1);
    await call('/admin/config', { method: 'PUT', owner: true, body: { mult: { on: true } } });
  });
  await t('others see the Trader Age only while the member shares verified Discipline', async () => {
    const k2 = (await call('/join', { method: 'POST', body: { handle: 'watcher' } })).d.key;
    const prof = async () => (await call('/profile/steady_one', { key: k2 })).d;
    const p = await prof(); ok(JSON.stringify(p).includes('"traderAge":7.8'), 'shown');
    await call('/me', { method: 'PUT', key: K, body: { share: { verify: false } } });
    ok(!JSON.stringify(await prof()).includes('"traderAge":7.8'), 'hidden once verify is off');
    eq((await call('/me', { key: K })).d.me.ta, null, 'and the member’s own goes back to the estimate');
  });
  // ---- standing (spec step 6) ----
  const me = async k => (await call('/me', { key: k })).d.me;
  let k2, watcherId;
  await t('standing: on by default (bar 60 = 2 years, 14 days of grace); a verified member at the bar is good', async () => {
    eq((await call('/config')).d.standing, { on: true, bar: 60, grace: 14, years: 2 });
    await call('/me', { method: 'PUT', key: K, body: { share: { verify: true } } });
    const st = await until(async () => { const m = await me(K); return m.ta && m.ta.recentN === 20 && m.standing.state === 'good' ? m.standing : null; });
    // standing reads Trader Age from fills alone: Discipline 100 and steady is 100, whatever the app says about prep
    ok(st, 'good'); eq([st.locked, st.exempt, st.since], [false, false, null]); near(st.recent, 100, 0.05);
  });
  await t('without a verified wallet: 14 days of grace, with a heads-up in the inbox', async () => {
    k2 = (await call('/join', { method: 'POST', body: { handle: 'dodger' } })).d.key;
    const st = (await me(k2)).standing; eq([st.state, st.deadline - st.since, st.locked], ['unverified', 14 * DAY, false]);
    ok((await call('/inbox', { key: k2 })).d.items.some(x => x.kind === 'standing' && /Verify your wallet by/.test(x.text)), 'told');
    watcherId = (await call('/admin/members', { owner: true })).d.members.find(m => m.handle === 'dodger').id;
    eq((await call('/admin/members', { owner: true })).d.members.find(m => m.handle === 'dodger').standing, 'unverified');
  });
  let W;
  await t('under the bar: slipping, with the deadline; past it without trading since, the clock waits', async () => {
    // the owner raises the bar to 90. What the app says about prep and journaling no longer moves standing
    // (audit X12): a member whose fills are clean stays good with none of it...
    await call('/admin/config', { method: 'PUT', owner: true, body: { standing: { bar: 90 } } });
    const noLog = stats(); for (const d of noLog.days) { d.p = 0; d.pl = 0; d.jn = 0; }
    await call('/stats', { method: 'POST', key: K, body: noLog });
    eq((await me(K)).standing.state, 'good');
    // ...and one whose fills show a revenge entry a day can't post their way back up: 75 Discipline, steady: 79.7
    W = (await call('/join', { method: 'POST', body: { handle: 'wobbly', address: ADDR2, share: { verify: true } } })).d.key;
    const perfect = stats(); for (const d of perfect.days) { d.p = 1; d.pl = 1; d.jn = 1; d.lm = 1; }
    await call('/stats', { method: 'POST', key: W, body: perfect });
    let st = await until(async () => { const m = await me(W); return m.ta && m.ta.recentN === 20 ? m.standing : null; });
    eq(st.state, 'slipping'); near(st.recent, 79.7, 0.05); eq(st.deadline, clock + 14 * DAY);
    ok((await me(W)).ta.raw > st.recent, 'the Trader Age shown still counts the app’s parts');
    clock += 15 * DAY;
    st = (await me(W)).standing; eq([st.state, st.locked], ['slipping', false], 'no trading day since it began');
  });
  await t('lapsed (unverified): duels, competitions and the leaderboards lock, the coach drops to 1 a day', async () => {
    const st = (await me(k2)).standing; eq([st.state, st.why, st.locked], ['lapsed', 'unverified', true]);
    const d = await call('/duels', { method: 'POST', key: k2, body: { to: 'steady_one', type: 'disc', period: 'week', verified: false } });
    eq([d.status, d.d.standing], [403, true]); ok(/verified wallet/.test(d.d.error), d.d.error);
    const day = key(clock), mk = await call('/admin/competitions', { method: 'POST', owner: true, body: { title: 'Cup', type: 'discipline', start: day, end: key(clock + 7 * DAY) } });
    const cj = await call('/competitions/' + mk.d.id + '/join', { method: 'POST', key: k2 }); eq([cj.status, cj.d.standing], [403, true]);
    eq((await me(k2)).coach.limit, 1);
    // off the leaderboards (global), but the league table keeps everyone
    await call('/me', { method: 'PUT', key: k2, body: { share: { global: true, boards: true } } });
    await call('/me', { method: 'PUT', key: K, body: { share: { global: true } } });
    const lb = (await call('/leaderboard?scope=global&board=level', { key: k2 })).d;
    eq(lb.offBoards, true); ok(!lb.rows.some(r => r.handle === 'dodger'), 'not on it'); ok(lb.rows.some(r => r.handle === 'steady_one'), 'others are');
    // someone else can't challenge them either
    const c = await call('/duels', { method: 'POST', key: K, body: { to: 'dodger', type: 'disc', period: 'week', verified: false } });
    ok(c.status === 409 && /isn’t taking challenges right now/.test(c.d.error), JSON.stringify(c));
  });
  await t('lapsed (rating): a trading day after the deadline locks it; back at the bar opens it again', async () => {
    // a new trading day comes in from the wallet
    wobblyDay(Date.parse(key(clock) + 'T08:00:00Z') - 2 * DAY, 5000); clock = Date.parse(key(clock) + 'T20:00:00Z');
    clock += 31 * 60000; // the wallet is read again at most every 30 minutes; the stats the app sends bring it in
    await call('/stats', { method: 'POST', key: W, body: Object.assign(stats(), { days: [] }) });
    const st = await until(async () => { const m = await me(W); return m.standing.state === 'lapsed' ? m.standing : null; });
    ok(st, 'lapsed'); eq([st.why, st.locked], ['rating', true]);
    const dl = await call('/duels', { method: 'POST', key: W, body: { to: 'dodger', type: 'disc', period: 'week', verified: false } });
    ok(dl.status === 403 && /standing is lapsed/.test(dl.d.error), dl.d.error);
    eq((await call('/leaderboard?scope=global&board=level', { key: W })).d.offBoards, true);
    await call('/admin/config', { method: 'PUT', owner: true, body: { standing: { bar: 60 } } });
    eq((await me(W)).standing.state, 'good');
    ok((await call('/inbox', { key: W })).d.items.some(x => x.kind === 'standing' && /back/.test(x.text)), 'told it’s back');
  });
  await t('fully unlocked members are never locked; the owner can switch standing off', async () => {
    await call('/admin/members/' + watcherId, { method: 'POST', owner: true, body: { action: 'unlock' } });
    let st = (await me(k2)).standing; eq([st.state, st.exempt, st.locked], ['lapsed', true, false]);
    ok((await me(k2)).coach.limit > 1, 'the unlocked allowance');
    await call('/admin/members/' + watcherId, { method: 'POST', owner: true, body: { action: 'lock' } });
    const bad = await call('/admin/config', { method: 'PUT', owner: true, body: { standing: { on: false, grace: 999 } } });
    eq([bad.status, bad.d.error], [400, 'Standing → grace must be from 3 to 60 (not 999).'], 'grace is kept within 3–60 days: refused, nothing changed');
    eq((await call('/config')).d.standing.on, true);
    eq((await call('/admin/config', { method: 'PUT', owner: true, body: { standing: { on: false } } })).status, 200);
    eq((await me(k2)).standing, { on: false });
    eq((await me(k2)).coach.limit, 3);
    eq((await call('/leaderboard?scope=global&board=level', { key: k2 })).d.offBoards, false);
  });
} finally { await new Promise(r => app.close(r)); }
report('trader age (server)');
