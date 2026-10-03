// More coach messages for XP: once the day's allowance is used, a member can buy a pack at the
// league's price. Each purchase is a negative grant flagged coach (lifetime XP only), packs are
// counted per profile and per wallet like messages, and the owner sets price, pack size, a daily
// cap, a doubling price and whether a purchase may drop a level. The model is a stub.
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { t, ok, eq, report } from './harness.mjs';

const require = createRequire(import.meta.url);
const server = require('../server.js');
const SC = require('../social-config.js');
const htmlPath = new URL('../ledger.html', import.meta.url).pathname;
const stub = { beta: { messages: { create: async req => ({ model: req.model, stop_reason: 'end_turn', content: [{ type: 'text', text: 'Stick to the plan.' }] }) } } };
const dataDir = mkdtempSync(join(tmpdir(), 'ledger-coachpacks-'));
let clock = Date.parse('2026-10-01T15:00:00Z');
const app = server.createApp({ dataDir, auth: 'owner-token', htmlPath, now: () => clock, push: false, pushTick: false,
  fetchImpl: async () => ({ ok: true, status: 200, json: async () => [] }), coach: { enabled: true, client: stub } });
const B = await new Promise(res => app.listen(0, () => res('http://127.0.0.1:' + app.address().port)));
const call = async (p, o = {}) => { const r = await fetch(B + p, { method: o.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(o.key ? { 'X-Pulse-Key': o.key } : {}), ...(o.owner ? { Authorization: 'Bearer owner-token' } : {}) },
    body: o.body !== undefined ? JSON.stringify(o.body) : undefined });
  return { status: r.status, d: await r.json().catch(() => ({})) }; };
const ask = key => call('/api/coach/chat', { method: 'POST', key, body: { messages: [{ role: 'user', content: 'How did I do?' }], facts: { level: 4 } } });
const status = key => call('/api/coach/chat', { key }).then(r => r.d);
const buy = (key, price) => call('/api/coach/packs', { method: 'POST', key, body: price === undefined ? {} : { price } });
const stats = (key, xp, coachSpent) => call('/api/social/stats', { method: 'POST', key, body: { xp, level: 4, tz: 'UTC', coachSpent } });
const cfg = packs => call('/api/social/admin/config', { method: 'PUT', owner: true, body: { coach: { packs } } });
const join_ = async (handle, address) => { const k = (await call('/api/social/join', { method: 'POST', body: { handle, address } })).d.key;
  return { k, id: (await call('/api/social/me', { key: k })).d.me.id }; };
const useUp = async (key, n) => { for (let i = 0; i < n; i++) eq((await ask(key)).status, 200, 'message ' + (i + 1)); };
const W = '0x' + '5d'.repeat(20);

t('the owner’s settings are clamped; packs are on by default at 150 XP for 3 messages, 2 a day', () => {
  const d = SC.sanitizeCoachCfg({}, null).packs;
  eq([d.on, d.cost, d.msgs, d.max, d.rise, d.keepLevel, d.lapsed], [true, 150, 3, 2, false, true, false]);
  const c = SC.sanitizeCoachCfg({ packs: { on: false, cost: -5, msgs: 500, max: 99, rise: 'yes' } }, null).packs;
  eq([c.on, c.cost, c.msgs, c.max, c.rise], [false, 1, 50, 20, false]);
  eq(SC.sanitizeCoachCfg({ daily: 4 }, { packs: { cost: 400 } }).packs.cost, 400, 'other coach saves keep the pack settings');
});

let A, A2;
try {
  // default levels: level 4 starts at 2,400 XP, level 5 at 4,000
  await t('nothing to buy while messages are left; once they’re used the offer comes with the 429', async () => {
    A = await join_('pia', W); await stats(A.k, 3000, 0);
    eq((await status(A.k)).packs, null);
    await useUp(A.k, 3);
    const r = await ask(A.k); eq(r.status, 429);
    eq(r.d.packs, { price: 150, msgs: 3, bought: 0, max: 2, xp: 3000, after: 2850, level: 4, levelAfter: 4, blocked: null });
  });
  await t('a purchase at a stale price is refused; at the shown price it adds 3 messages and a coach grant', async () => {
    const bad = await buy(A.k, 99); eq(bad.status, 409); ok(/price is now 150 XP/.test(bad.d.error), bad.d.error);
    const r = await buy(A.k, 150); eq(r.status, 200);
    eq([r.d.allowed, r.d.limit, r.d.remaining, r.d.packs], [true, 6, 3, null]); eq(r.d.bought, { price: 150, msgs: 3 });
    const g = (await call('/api/social/me', { key: A.k })).d.me.grants;
    eq(g.length, 1); eq([g[0].xp, g[0].why, g[0].coach], [-150, 'Coach: 3 extra messages', true]);
    eq((await buy(A.k, 150)).status, 409, 'messages left: nothing to buy');
  });
  await t('XP the app hasn’t counted yet is held back from the next price check', async () => {
    await useUp(A.k, 3);
    const st = await status(A.k); eq([st.allowed, st.limit, st.packs.xp, st.packs.bought], [false, 6, 2850, 1]);
    ok(/today’s 6 coach messages, extras included/.test(st.reason), st.reason);
    await stats(A.k, 2850, 150); // the app caught up: the same 2,850, not 2,700
    eq((await status(A.k)).packs.xp, 2850);
  });
  await t('a second pack the same day adds to the day’s one grant', async () => {
    eq((await buy(A.k, 150)).status, 200);
    const g = (await call('/api/social/me', { key: A.k })).d.me.grants;
    eq(g.length, 1); eq([g[0].xp, g[0].why], [-300, 'Coach: 6 extra messages']);
  });
  await t('a profile on the same wallet shares the extras and the cap', async () => {
    A2 = await join_('pia_two', W); await stats(A2.k, 5000, 0);
    eq((await status(A2.k)).limit, 9);
    await useUp(A.k, 3);
    const st = await status(A2.k); eq(st.allowed, false); ok(/today’s 2 extra packs/.test(st.packs.blocked), st.packs.blocked);
    const r = await buy(A2.k, 150); eq(r.status, 409); ok(/today’s 2 extra packs/.test(r.d.error));
  });
  await t('no cap and a doubling price: a pack that would cost a level is refused until the owner allows it', async () => {
    eq((await cfg({ max: 0, rise: true })).status, 200);
    let o = (await status(A.k)).packs; // 2,850 less the 150 the app hasn't counted = 2,700; a 600 XP pack would leave 2,100 (level 3)
    eq([o.price, o.xp, o.level, o.levelAfter, o.max], [600, 2700, 4, 3, null]);
    ok(/drop you below level 4\. Earn 300 more XP first/.test(o.blocked), o.blocked);
    eq((await buy(A.k, 600)).status, 409);
    await cfg({ keepLevel: false });
    o = (await status(A.k)).packs; eq(o.blocked, null);
    eq((await buy(A.k, 600)).status, 200);
    eq((await status(A.k)).limit, 12);
  });
  await t('not enough XP', async () => {
    await useUp(A.k, 3);
    await stats(A.k, 1000, 900);
    const o = (await status(A.k)).packs; eq([o.price, o.xp], [1200, 1000]); eq(o.blocked, 'You need 1,200 XP and have 1,000.');
  });
  await t('the owner sees today’s packs and their XP; switching packs off leaves “More tomorrow”', async () => {
    const ov = (await call('/api/social/admin/overview', { owner: true })).d;
    eq(ov.coachPacks, { n: 3, xp: 900 }); eq(ov.config.coach.packs.cost, 150);
    const m = (await call('/api/social/admin/members', { owner: true })).d.members.find(x => x.id === A.id);
    eq([m.coachPacks, m.coachLimit], [3, 12]);
    await cfg({ on: false });
    const st = await status(A.k); eq(st.packs, null); ok(/More tomorrow/.test(st.reason));
    eq((await buy(A.k)).status, 409);
    await cfg({ on: true, max: 2, rise: false, keepLevel: true });
  });
  await t('an admin reset clears the packs too; the XP stays spent', async () => {
    await call('/api/social/admin/members/' + A.id, { method: 'POST', owner: true, body: { action: 'coachreset' } });
    const st = await status(A.k); eq([st.limit, st.remaining], [3, 3]);
    eq((await call('/api/social/me', { key: A.k })).d.me.grants[0].xp, -900);
  });
  await t('admins have no limit, so no offer; only members can buy', async () => {
    const r = await call('/api/social/admin/members', { method: 'POST', owner: true, body: { handle: 'ada', admin: true } });
    const k = (await call('/api/social/link/finish', { method: 'POST', body: { code: r.d.code } })).d.key;
    eq((await status(k)).packs, null); eq((await buy(k)).status, 409);
    eq((await call('/api/coach/packs', { method: 'POST', owner: true, body: {} })).status, 401);
    eq((await call('/api/coach/packs', { key: A.k })).status, 405);
  });
  await t('a new day: the allowance and the packs start over', async () => {
    await useUp(A.k, 3);
    clock += 86400000;
    const st = await status(A.k); eq([st.limit, st.remaining, st.packs], [3, 3, null]);
    await useUp(A.k, 3);
    eq((await status(A.k)).packs.bought, 0);
  });
  await t('a purchase names its price: one without it is refused', async () => {
    const r = await buy(A.k); eq(r.status, 409); ok(/price is now 150 XP/.test(r.d.error), r.d.error);
  });
  await t('what was lost on duel stakes limits what can be spent; a purchase lowers the stake balance at once', async () => {
    const m = app._social.state().members[A.id];
    m.stakeNet = -900; // earned 1,000, balance 100
    eq((await status(A.k)).packs.blocked, 'You can spend 100 XP right now: that’s your balance after duel stakes.');
    m.stakeNet = 0;
    eq((await buy(A.k, 150)).status, 200);
    eq((await call('/api/social/me', { key: A.k })).d.me.balance, 850, 'before the app reports it');
  });
  await t('the grant list keeps its newest 200, but never drops a coach purchase (its XP would come back)', async () => {
    const m = app._social.state().members[A.id], spent = m.grants.reduce((a, g) => a + (g.coach ? g.xp : 0), 0);
    m.grants = [...m.grants, ...Array.from({ length: 70 }, (_, i) => ({ id: 'c' + i, xp: -10, why: 'Coach: 3 extra messages', at: i, coach: true, day: 'd' + i, msgs: 3 })),
      ...Array.from({ length: 200 }, (_, i) => ({ id: 'g' + i, xp: 1, why: 'bonus', at: i }))];
    eq((await call('/api/social/admin/members/' + A.id, { method: 'POST', owner: true, body: { action: 'grant', xp: 5 } })).status, 200);
    const coach = m.grants.filter(g => g.coach);
    eq(m.grants.length - coach.length, 200); ok(coach.length <= 60, coach.length + ' coach entries');
    eq(coach.reduce((a, g) => a + g.xp, 0), spent - 700);
    ok(/extra messages, earlier$/.test(m.grants[0].why), m.grants[0].why);
  });
} finally { await new Promise(r => app.close(r)); }

report('coach packs');
