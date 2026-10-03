// XP for mentoring: appointed mentors earn for reviews (with a comment) and notes on an active mentee's
// day, capped per day, each thing once, never from their own second profile; and a bonus when a mentee
// they worked with in the last 30 days reaches something verified (a Trader Age milestone, a perfect
// week, a leak plugged). It counts for levels only: league tables and duels never see it.
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { t, ok, eq, report, makeExtractor } from './harness.mjs';
import { readAppSource } from '../app-source.js';

const require = createRequire(import.meta.url);
const S = require('../social.js');
const server = require('../server.js');
const htmlPath = new URL('../ledger.html', import.meta.url).pathname;
const DAY = 864e5, key = ms => new Date(ms).toISOString().slice(0, 10);
let clock = Date.parse('2026-10-20T20:00:00Z'); // a Tuesday (2026-W43)
const NED = '0x' + 'e'.repeat(40), MIA = '0x' + 'a'.repeat(40);
// the mentee's verified days, as the server's wallet reader would score them
const d = (k, s, f) => Object.assign({ k, s, n: 3 }, f ? { f } : {});
const wk = (mon, s, f, n = 3) => Array.from({ length: n }, (_, i) => d(key(Date.parse(mon + 'T12:00:00Z') + i * DAY), s, f));
let NED_DAYS = [...wk('2026-09-21', 75, ['revenge']), ...wk('2026-09-28', 75, ['revenge']), ...wk('2026-10-05', 100), ...wk('2026-10-12', 100)];
// the other mentees' wallets: each read as having traded on the days listed (a mentee counts as active only
// when the server read a trading day in the last 14 from a verified wallet: audit X13)
const W = h => '0x' + h.repeat(40), ACT = { [W('1')]: [d(key(clock), 80)], [W('2')]: [d(key(clock), 80)], [W('3')]: [d(key(clock), 80)], [W('4')]: [d(key(clock - 20 * DAY), 80)] };
const behaviorFor = async addr => addr === NED ? NED_DAYS : ACT[addr] || [];

const dataDir = mkdtempSync(join(tmpdir(), 'ledger-mxp-'));
const app = server.createApp({ dataDir, auth: 'owner-token', htmlPath, now: () => clock, push: false, pushTick: false, offsiteTimer: false, behaviorFor, trustProxy: true,
  fetchImpl: async () => ({ ok: true, status: 200, json: async () => [] }) });
const B = await new Promise(res => app.listen(0, () => res('http://127.0.0.1:' + app.address().port)));
let ipN = 0;
const call = async (p, o = {}) => { const r = await fetch(B + '/api/social' + p, { method: o.method || 'GET', headers: { 'Content-Type': 'application/json', ...(p === '/join' ? { 'X-Forwarded-For': '10.0.0.' + (++ipN) } : {}), ...(o.key ? { 'X-Pulse-Key': o.key } : {}), ...(o.admin ? { Authorization: 'Bearer owner-token' } : {}) }, body: o.body ? JSON.stringify(o.body) : undefined });
  return { status: r.status, d: await r.json().catch(() => ({})) }; };
const until = async (f, ms = 4000) => { const end = Date.now() + ms; for (;;) { const v = await f(); if (v || Date.now() > end) return v; await new Promise(r => setTimeout(r, 40)); } };
const join_ = async (h, extra) => (await call('/join', { method: 'POST', body: Object.assign({ handle: h }, extra || {}) })).d.key;
const idOf = async h => (await call('/admin/members', { admin: true })).d.members.find(m => m.handle === h).id;
const me = async k => (await call('/me', { key: k })).d.me;
// a member whose app reports trading days up to today (active), or none in the last 14 days
const traded = (k, lastBack = 0) => call('/stats', { method: 'POST', key: k, body: { xp: 10, level: 1, tz: 'UTC', days: [{ k: key(clock - lastBack * DAY), s: 80 }] } });
const note = (k, h, text = 'Good patience today.') => call('/mentor/' + h + '/notes', { method: 'POST', key: k, body: { day: key(clock), text } });
const TR = { coin: 'BTC', label: 'BTC', side: 'long', market: 'perp', openedAt: clock - 5 * 3600e3, closedAt: clock - 3600e3, entry: 1, exit: 2 };
let M, N, O, P, Q, Z;
try {
  await call('/admin/config', { method: 'PUT', admin: true, body: { requireClaim: false, unlocksOn: false, standing: { on: false } } });
  M = await join_('mia', { address: MIA }); N = await join_('ned', { address: NED, share: { verify: true } });
  O = await join_('olu', { address: W('1'), share: { verify: true } }); P = await join_('pam', { address: W('2'), share: { verify: true } });
  Q = await join_('quin', { address: W('3'), share: { verify: true } }); Z = await join_('zed', { address: W('4'), share: { verify: true } });
  for (const k of [O, P, Q, Z]) await until(async () => (await me(k)).ta);
  await call('/admin/members/' + await idOf('mia'), { method: 'POST', admin: true, body: { action: 'mentor' } });
  for (const k of [N, O, P, Q, Z]) await call('/me', { method: 'PUT', key: k, body: { share: { mentor: true } } });
  for (const k of [O, P, Q]) await traded(k);
  await traded(Z, 20); // last traded 20 days ago

  await t('the defaults: 15 a review, 5 a note (3 a day), 25 a result, 60 a day', async () => {
    eq((await call('/config')).d.mentorXp, { on: true, review: 15, note: 5, notesPerDay: 3, outcome: 25, cap: 60, rates: true, rateMin: 0, rateMax: 100, poolPct: 0, holdHours: 72 });
  });
  await t('a note on an active mentee’s day pays once per mentee a day, three a day at most; an inactive mentee pays nothing', async () => {
    await until(async () => (await me(N)).ta); // ned's wallet read: he traded this week
    eq((await note(M, 'ned')).d.xp, 5);
    eq((await note(M, 'ned', 'And another.')).d.xp, 0, 'the same mentee, the same day');
    eq((await note(M, 'olu')).d.xp, 5); eq((await note(M, 'pam')).d.xp, 5);
    eq((await note(M, 'quin')).d.xp, 0, 'three paid notes today already');
    eq((await note(M, 'zed')).d.xp, 0, 'zed hasn’t traded in 14 days');
    const mx = (await me(M)).mentorXp; eq([mx.total, mx.today, mx.days[key(clock)].n], [15, 15, 3]);
  });
  await t('a mentee without a verified wallet pays nothing, whatever days their app reports', async () => {
    const S2 = await join_('sock'); await call('/me', { method: 'PUT', key: S2, body: { share: { mentor: true } } }); await traded(S2);
    eq((await note(M, 'sock')).d.xp, 0, 'no wallet the server reads: could be the mentor’s own second profile');
  });
  await t('a trade review pays once, and only with a comment from the mentor in it', async () => {
    const rid = (await call('/reviews', { method: 'POST', key: O, body: { key: 'tradeolu01', trade: TR } })).d.review.id;
    eq((await call('/reviews/' + rid + '/reviewed', { method: 'POST', key: M, body: { done: true } })).d.xp, 0, 'nothing said');
    await call('/reviews/' + rid + '/reviewed', { method: 'POST', key: M, body: { done: false } });
    await call('/reviews/' + rid + '/comments', { method: 'POST', key: M, body: { text: 'Entry was early; stop was right.' } });
    eq((await call('/reviews/' + rid + '/reviewed', { method: 'POST', key: M, body: { done: true } })).d.xp, 15);
    await call('/reviews/' + rid + '/reviewed', { method: 'POST', key: M, body: { done: false } });
    eq((await call('/reviews/' + rid + '/reviewed', { method: 'POST', key: M, body: { done: true } })).d.xp, 0, 'already paid');
    eq((await me(M)).mentorXp.days[key(clock)].r, 1);
    // taking the trade back and sending it again makes a new review: it doesn't pay again (keyed on the trade)
    await call('/reviews/' + rid, { method: 'DELETE', key: O });
    const again = (await call('/reviews', { method: 'POST', key: O, body: { key: 'tradeolu01', trade: TR } })).d.review.id; ok(again !== rid);
    await call('/reviews/' + again + '/comments', { method: 'POST', key: M, body: { text: 'Same trade, same lesson.' } });
    eq((await call('/reviews/' + again + '/reviewed', { method: 'POST', key: M, body: { done: true } })).d.xp, 0, 'the same trade');
  });
  await t('the mentor’s day is the UTC day: hopping time zones doesn’t open another day’s cap', async () => {
    const before = (await me(M)).mentorXp;
    await call('/stats', { method: 'POST', key: M, body: { xp: 10, level: 1, tz: 'Etc/GMT-14' } }); // already tomorrow there
    eq((await note(M, 'quin')).d.xp, 0, 'three paid notes today already, whatever the clock says');
    eq(Object.keys((await me(M)).mentorXp.days), Object.keys(before.days), 'no new day bucket');
  });
  await t('reviews and notes stop at the daily cap; a new day starts it again', async () => {
    await call('/admin/config', { method: 'PUT', admin: true, body: { mentorXp: { cap: 40 } } });
    const rid = (await call('/reviews', { method: 'POST', key: P, body: { key: 'tradepam01', trade: TR } })).d.review.id;
    await call('/reviews/' + rid + '/comments', { method: 'POST', key: M, body: { text: 'Nice exit.' } });
    eq((await call('/reviews/' + rid + '/reviewed', { method: 'POST', key: M, body: { done: true } })).d.xp, 10, '30 of 40 used: 10 left');
    clock += DAY; await traded(Q);
    eq((await note(M, 'quin')).d.xp, 5, 'a new day');
    eq((await me(M)).mentorXp.total, 45);
  });
  await t('a mentee’s verified results pay the mentors who worked with them: a milestone, a perfect week, a leak plugged', async () => {
    // a week on: ned traded every day of last week, all clean, and the revenge entries of September are gone for 3 weeks
    clock = Date.parse('2026-10-27T20:00:00Z');
    NED_DAYS = [...NED_DAYS, ...wk('2026-10-19', 100, null, 5)];
    await traded(N); // the app's stats bring a fresh read of the wallet
    const mx = await until(async () => { const m = (await me(M)).mentorXp; const o = Object.values(m.days).reduce((a, x) => a + x.o, 0); return o >= 3 ? m : null; });
    ok(mx, 'three results paid'); const items = (await call('/inbox', { key: M })).d.items.filter(x => x.title === 'Your mentee did it');
    eq(items.length, 3); ok(items.some(x => /perfect verified week/.test(x.text)) && items.some(x => /revenge-entry leak/.test(x.text)) && items.some(x => /Trader Age of \d+ year/.test(x.text)), JSON.stringify(items.map(x => x.text)));
    // the same results never pay twice
    clock += 31 * 60000; await traded(N); await new Promise(r => setTimeout(r, 300));
    eq((await call('/inbox', { key: M })).d.items.filter(x => x.title === 'Your mentee did it').length, 3);
  });
  await t('the owner can switch it off; members who aren’t mentors never earn', async () => {
    eq((await note(O, 'pam')).status, 403, 'only mentors write notes');
    await call('/admin/config', { method: 'PUT', admin: true, body: { mentorXp: { on: false } } });
    await traded(P); eq((await note(M, 'pam', 'Off now.')).d.xp, 0);
    ok((await call('/admin/members', { admin: true })).d.members.find(m => m.handle === 'mia').mentorXp > 0, 'the owner sees what a mentor earned');
  });
} finally { await new Promise(r => app.close(r)); }

console.log('\nIn the app');
const src = readAppSource(htmlPath), { grabFn } = makeExtractor(src);
t('mentoring XP joins levels but stays out of league and duel XP (xpBase), and has its own row in “where this week’s XP came from”', () => {
  const g = grabFn('gameContext');
  ok(g.includes("bonuses.push({key:k,xp:d.xp,why:'mentoring',src:'mentor'})"));
  ok(g.includes("xpLedger(baseRows,bonuses.filter(b=>b.src!=='mentor'))"));
  ok(grabFn('pzXpSources').includes("b.src==='mentor'?'mentor'"));
});
t('two mentoring badge families, shown to mentors only', () => {
  ok(src.includes("['teacher','mentoring','Teacher'") && src.includes("['helped','mentoring','Made a difference'"));
  ok(grabFn('pzBadgeCatalog').includes("PZ_FAMILIES.filter(f=>f[1]!=='mentoring'||mentorFams)"));
});
report('mentor xp');
