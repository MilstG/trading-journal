// The High Ninja role: the owner (or an admin) gives it from a member's page. It marks the profile,
// the People card and feed rows, and makes the member fully unlocked for as long as they hold it;
// taking it away leaves the hand-set "Fully unlocked" as it was.
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { t, ok, eq, report } from './harness.mjs';

const require = createRequire(import.meta.url);
const server = require('../server.js');
const htmlPath = new URL('../ledger.html', import.meta.url).pathname;
const app = server.createApp({ dataDir: mkdtempSync(join(tmpdir(), 'ledger-ninja-')), auth: 'owner-token', htmlPath,
  fetchImpl: async () => ({ ok: true, status: 200, json: async () => [] }) });
const B = await new Promise(res => app.listen(0, () => res('http://127.0.0.1:' + app.address().port)));
const call = async (p, o = {}) => { const r = await fetch(B + p, { method: o.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(o.key ? { 'X-Pulse-Key': o.key } : {}), ...(o.owner ? { Authorization: 'Bearer owner-token' } : {}) },
    body: o.body !== undefined ? JSON.stringify(o.body) : undefined });
  return { status: r.status, d: await r.json().catch(() => ({})) }; };
const act = (id, body, o = { owner: true }) => call('/api/social/admin/members/' + id, { method: 'POST', ...o, body });
const row = async id => (await call('/api/social/admin/members', { owner: true })).d.members.find(m => m.id === id);

let S, Sid, V;
try {
  await t('a member starts without the role and locked', async () => {
    S = (await call('/api/social/join', { method: 'POST', body: { handle: 'sam' } })).d.key;
    V = (await call('/api/social/join', { method: 'POST', body: { handle: 'viv' } })).d.key;
    const me = (await call('/api/social/me', { key: S })).d.me; Sid = me.id;
    eq(me.unlocked, false);
    const r = await row(Sid); eq(r.ninja, false); eq(r.unlocked, false); eq(r.unlockedOwn, false);
  });
  await t('giving the role unlocks them, tells them, and shows the star to others', async () => {
    eq((await act(Sid, { action: 'ninja' })).status, 200);
    eq((await call('/api/social/me', { key: S })).d.me.unlocked, true, 'fully unlocked');
    const r = await row(Sid); eq(r.ninja, true); eq(r.unlocked, true); eq(r.unlockedOwn, false, 'the hand-set switch is untouched');
    const inbox = (await call('/api/social/inbox', { key: S })).d.items;
    ok(inbox.some(x => x.kind === 'role' && /High Ninja/.test(x.text)), 'an inbox note');
    eq((await call('/api/social/profile/sam', { key: V })).d.profile.ninja, true, 'on their profile');
    eq((await call('/api/social/profile/viv', { key: S })).d.profile.ninja, false);
    eq((await call('/api/social/people', { key: V })).d.people.find(p => p.handle === 'sam').ninja, true, 'on their People card');
    const ev = (await call('/api/social/feed?scope=discover', { key: V })).d.events.find(e => e.handle === 'sam' && /High Ninja/.test(e.text));
    ok(ev && ev.ninja, 'announced in the feed, with the star');
  });
  await t('giving it twice doesn’t announce it twice', async () => {
    eq((await act(Sid, { action: 'ninja' })).status, 200);
    eq((await call('/api/social/inbox', { key: S })).d.items.filter(x => x.kind === 'role').length, 1);
  });
  await t('taking it away locks them again, unless they were unlocked by hand', async () => {
    eq((await act(Sid, { action: 'unninja' })).status, 200);
    eq((await call('/api/social/me', { key: S })).d.me.unlocked, false);
    eq((await call('/api/social/profile/sam', { key: V })).d.profile.ninja, false);
    eq((await act(Sid, { action: 'unlock' })).status, 200);
    eq((await act(Sid, { action: 'ninja' })).status, 200);
    eq((await act(Sid, { action: 'unninja' })).status, 200);
    eq((await call('/api/social/me', { key: S })).d.me.unlocked, true, 'the hand-set unlock stays');
  });
  await t('members can’t give it to themselves', async () => {
    eq((await act(Sid, { action: 'ninja' }, { key: V })).status, 401);
  });
  await t('the admin panel offers it on a member’s page', async () => {
    const html = await (await fetch(B + '/admin')).text();
    ok(/mNinja/.test(html) && /High Ninja/.test(html));
  });
} finally { app.close(); }

report('ninja');
