// Notes that bring people back for the right reasons: kudos and new followers reach the member they
// were for (the first one at once, the rest bundled), league moves are told to the member who moved,
// and near the end of a league week a member whose spot is on the line hears it once.
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { t, ok, eq, report, xpLogFor } from './harness.mjs';

const require = createRequire(import.meta.url);
const server = require('../server.js');
const htmlPath = new URL('../ledger.html', import.meta.url).pathname;
const H = 3600000;
let clock = Date.parse('2026-10-07T12:00:00Z'); // a Wednesday (2026-W41: Monday 10-05 to Sunday 10-11)
const dataDir = mkdtempSync(join(tmpdir(), 'ledger-engage-'));
const app = server.createApp({ dataDir, auth: 'owner-token', htmlPath, now: () => clock, push: false, pushTick: false, offsiteTimer: false, trustProxy: true,
  fetchImpl: async () => ({ ok: true, status: 200, json: async () => [] }) });
const B = await new Promise(res => app.listen(0, () => res('http://127.0.0.1:' + app.address().port)));
let ipN = 0;
const call = async (p, o = {}) => { const r = await fetch(B + '/api/social' + p, { method: o.method || 'GET',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': o.ip || '10.0.0.1', ...(o.key ? { 'X-Pulse-Key': o.key } : {}), ...(o.owner ? { Authorization: 'Bearer owner-token' } : {}) },
    body: o.body !== undefined ? JSON.stringify(o.body) : undefined });
  return { status: r.status, d: await r.json().catch(() => ({})) }; };
const K = {};
const join_ = async (h, tz) => { const r = await call('/join', { method: 'POST', ip: '10.0.9.' + (++ipN), body: { handle: h } }); if (!r.d.key) throw new Error(JSON.stringify(r));
  K[h] = r.d.key; await call('/stats', { method: 'POST', key: K[h], body: { tz: tz || 'UTC' } }); return K[h]; };
const idOf = async h => (await call('/admin/members', { owner: true })).d.members.find(m => m.handle === h).id;
const xp = (h, day, n) => call('/stats', { method: 'POST', key: K[h], body: { tz: h === 'tok' ? 'Asia/Tokyo' : 'UTC', xpLog: xpLogFor(n, day) } });
const inbox = async h => (await call('/inbox', { key: K[h] })).d.items || [];
const ofKind = async (h, k) => (await inbox(h)).filter(x => x.kind === k);
const tick = () => app.pushTick();

try {
  await call('/admin/config', { method: 'PUT', owner: true, body: { requireClaim: false, unlocksOn: false } });
  const P = ['amy', 'ben', 'cal', 'dov', 'eve', 'fay', 'gus', 'hal'];
  for (const h of P) await join_(h);
  for (const h of P) await call('/admin/members/' + await idOf(h), { method: 'POST', owner: true, body: { action: 'unlock' } });
  // a level-up from amy, so there's a feed post for kudos
  await call('/stats', { method: 'POST', key: K.amy, body: { tz: 'UTC', streak: 7, xpLog: xpLogFor(900, '2026-10-06') } });
  const feed = (await call('/feed?scope=discover', { key: K.ben })).d.events || [];
  const ev = feed.find(e => e.handle === 'amy' || (e.member && e.member.handle === 'amy'));

  console.log('\nKudos and followers');
  await t('the first kudos says who and what, at once', async () => {
    ok(ev, 'amy has a feed event: ' + JSON.stringify(feed.map(e => e.text)));
    eq((await call('/kudos/' + ev.id, { method: 'POST', key: K.ben })).d.liked, true);
    const s = await ofKind('amy', 'social'); eq(s.length, 1); ok(/^@ben gave kudos: you /.test(s[0].text), s[0].text);
  });
  await t('more within six hours wait; taking kudos back and giving it again never says it twice', async () => {
    await call('/kudos/' + ev.id, { method: 'POST', key: K.ben }); await call('/kudos/' + ev.id, { method: 'POST', key: K.ben }); // off, on again
    await call('/kudos/' + ev.id, { method: 'POST', key: K.cal });
    await call('/follow/amy', { method: 'POST', key: K.dov });
    await call('/follow/amy', { method: 'DELETE', key: K.dov }); await call('/follow/amy', { method: 'POST', key: K.dov });
    eq((await ofKind('amy', 'social')).length, 1, 'still one');
    clock += 2 * H; await tick(); eq((await ofKind('amy', 'social')).length, 1, 'not yet: six hours from the last');
  });
  await t('after six hours they come as one line', async () => {
    clock += 5 * H; await tick();
    const s = await ofKind('amy', 'social'); eq(s.length, 2);
    eq(s[0].text, '1 kudos and 1 new follower from @cal and others.');
    await tick(); eq((await ofKind('amy', 'social')).length, 2, 'said once');
  });
  await t('a quiet six hours later, the next one is said at once again', async () => {
    clock += 7 * H; await call('/follow/amy', { method: 'POST', key: K.eve });
    const s = await ofKind('amy', 'social'); eq(s.length, 3); eq(s[0].text, '@eve started following you.');
  });

  console.log('\nLeague week');
  // Bronze has 8: the top two move up. Sunday-ish XP so far this week:
  const plan = { amy: 0, ben: 700, cal: 600, dov: 550, eve: 300, fay: 200, gus: 100, hal: 50 };
  for (const [h, n] of Object.entries(plan)) if (n) await xp(h, '2026-10-08', n);
  await t('nothing before the last 30 hours of the week', async () => {
    clock = Date.parse('2026-10-10T12:00:00Z'); await tick(); // Saturday noon: 36 hours left
    eq((await ofKind('ben', 'league')).length, 0);
  });
  await t('from 30 hours out: the promotion zone, close behind it, or nothing', async () => {
    clock = Date.parse('2026-10-10T20:00:00Z'); await tick(); // Saturday 20:00 UTC: 28 hours left
    const b = await ofKind('ben', 'league'); eq(b.length, 1); eq(b[0].title, 'Hold your spot');
    eq(b[0].text, 'You’re #2 in Bronze, in the promotion zone, 100 XP clear. About a day left to hold it.', 'amy leads with 900 from Tuesday');
    const d = await ofKind('dov', 'league'); eq(d.length, 1);
    eq(d[0].text, 'You’re 151 XP from the promotion zone in Bronze, with about a day left. A review or journaling today’s trades counts.');
    eq((await ofKind('hal', 'league')).length, 0, 'far behind in the bottom tier: no relegation, nothing to say');
    await tick(); clock += H; await tick(); eq((await ofKind('ben', 'league')).length, 1, 'once a week');
  });
  await t('on the member’s own clock: not at night', async () => {
    await join_('tok', 'Asia/Tokyo'); await call('/admin/members/' + await idOf('tok'), { method: 'POST', owner: true, body: { action: 'unlock' } });
    await xp('tok', '2026-10-08', 580);
    clock = Date.parse('2026-10-10T21:00:00Z'); await tick(); // 06:00 in Tokyo
    eq((await ofKind('tok', 'league')).length, 0);
    clock = Date.parse('2026-10-11T02:00:00Z'); await tick(); // 11:00 in Tokyo
    eq((await ofKind('tok', 'league')).length, 1);
  });
  await t('the rollover tells the members who moved', async () => {
    clock = Date.parse('2026-10-12T09:00:00Z'); await call('/me', { key: K.amy }); // first request of the new week
    const b = await ofKind('ben', 'league'); eq(b[0].title, 'Promoted'); ok(/^You moved up to Silver league\./.test(b[0].text), b[0].text);
    eq((await ofKind('hal', 'league')).length, 0, 'Bronze has nowhere lower');
  });
  await t('the push switches cover the new kinds, on by default', async () => {
    const pr = (await call('/push', { key: K.amy })).d.prefs; eq([pr.league, pr.social], [true, true]);
  });
} finally { await new Promise(r => app.close(r)); }

report('engagement notes');
