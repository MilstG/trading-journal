// People: the directory members use to find someone to duel, partner with or learn from (no
// shared league needed), asking a particular mentor, and choosing the default rankings at sign-up.
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { t, ok, eq, report } from './harness.mjs';

const require = createRequire(import.meta.url);
const server = require('../server.js');
const htmlPath = new URL('../ledger.html', import.meta.url).pathname;
let clock = Date.parse('2026-10-20T12:00:00Z');
const app = server.createApp({ dataDir: mkdtempSync(join(tmpdir(), 'ledger-people-')), auth: 'owner-token', htmlPath, now: () => clock, push: false, pushTick: false, trustProxy: true, offsiteTimer: false,
  fetchImpl: async () => ({ ok: true, status: 200, json: async () => [] }) });
const B = await new Promise(r => app.listen(0, () => r('http://127.0.0.1:' + app.address().port)));
let ip = 0;
const call = async (p, o = {}) => { const r = await fetch(B + '/api/social' + p, { method: o.method || 'GET',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.9.' + Math.floor(++ip / 200) + '.' + (ip % 200), ...(o.key ? { 'X-Pulse-Key': o.key } : {}), ...(o.owner ? { Authorization: 'Bearer owner-token' } : {}) },
    body: o.body !== undefined ? JSON.stringify(o.body) : undefined });
  return { status: r.status, d: await r.json().catch(() => ({})) }; };
const join_ = async (handle, extra) => (await call('/join', { method: 'POST', body: Object.assign({ handle }, extra || {}) })).d;
try {
  const K = {};
  await t('sign-up: the default rankings are offered and can be skipped', async () => {
    await call('/admin/leagues', { method: 'POST', owner: true, body: { name: 'Night owls', autoJoin: true } });
    const cfg = (await call('/config')).d;
    eq(cfg.autoLeagues.map(L => L.name).sort(), ['Main league', 'Night owls']);
    const owls = cfg.autoLeagues.find(L => L.name === 'Night owls').id;
    K.ann = await join_('ann_trades', { share: { seek: true, mentor: false } });
    K.bob = await join_('bob_scalps', { skip: ['main', owls], share: { mentor: false } });
    eq(K.ann.me.leagues.map(L => L.name).sort(), ['Main league', 'Night owls']);
    eq(K.bob.me.leagues, [], 'skipped both: a profile, no ranking');
    eq(K.ann.share.seek, true);
  });
  await t('the directory: public profiles and mentors, with what each is open to — never trades or wallets', async () => {
    K.cat = await join_('cat_mentor', { share: { profile: false } });
    K.dan = await join_('dan_hidden', { share: { profile: false, duels: false, mentor: false } });
    const cat = (await call('/admin/members', { owner: true })).d.members.find(m => m.handle === 'cat_mentor');
    await call('/admin/members/' + cat.id, { method: 'POST', owner: true, body: { action: 'mentor' } });
    await call('/me', { method: 'PUT', key: K.ann.key, body: { bio: 'Swing trader, ETH and SOL' } });
    const all = (await call('/people', { key: K.bob.key })).d;
    eq(all.people.map(p => p.handle).sort(), ['ann_trades', 'cat_mentor'], 'dan has no public profile; cat is a mentor, so listed anyway');
    const ann = all.people.find(p => p.handle === 'ann_trades'), cat2 = all.people.find(p => p.handle === 'cat_mentor');
    eq([ann.seeking, ann.duels, ann.mentor, ann.bio, ann.partner], [true, true, false, 'Swing trader, ETH and SOL', null]);
    eq([cat2.mentor, cat2.bio], [true, ''], 'a private profile shows no bio, even for a mentor');
    ok(!JSON.stringify(all).match(/address|money|usd|wallet/i), 'no wallets or money in the directory');
    eq((await call('/people?f=partner', { key: K.bob.key })).d.people.map(p => p.handle), ['ann_trades']);
    eq((await call('/people?f=mentor', { key: K.bob.key })).d.people.map(p => p.handle), ['cat_mentor']);
    eq((await call('/people?f=duels', { key: K.bob.key })).d.people.map(p => p.handle).sort(), ['ann_trades', 'cat_mentor']);
    eq((await call('/people?q=eth', { key: K.bob.key })).d.people.map(p => p.handle), ['ann_trades'], 'search reads bios too');
    eq((await call('/people')).status, 401, 'members only');
  });
  await t('partnering from the directory needs no shared league', async () => {
    eq((await call('/partners', { method: 'POST', key: K.bob.key, body: { handle: 'ann_trades' } })).status, 200);
    eq((await call('/people?f=partner', { key: K.bob.key })).d.people[0].partner, 'sent');
    eq((await call('/people?f=partner', { key: K.ann.key })).d.people.length, 0, 'bob isn’t looking for one');
    eq((await call('/people?q=bob', { key: K.ann.key })).d.people[0].partner, 'asked');
  });
  await t('asking a mentor: lets mentors in only when told to, tells the mentor, puts you first on their list', async () => {
    const no = await call('/people/cat_mentor/mentor', { method: 'POST', key: K.bob.key, body: {} });
    eq([no.status, no.d.needsLetIn], [409, true], 'never opens your days without a yes');
    const yes = await call('/people/cat_mentor/mentor', { method: 'POST', key: K.bob.key, body: { letIn: true } });
    eq([yes.status, yes.d.share.mentor], [200, true]);
    eq((await call('/people/cat_mentor/mentor', { method: 'POST', key: K.bob.key, body: { letIn: true } })).status, 429, 'once a day per mentor');
    eq((await call('/people/ann_trades/mentor', { method: 'POST', key: K.bob.key, body: { letIn: true } })).status, 404, 'only mentors');
    const inbox = (await call('/inbox', { key: K.cat.key })).d.items;
    ok(inbox.some(x => x.kind === 'mentor' && /bob_scalps would like you to mentor them/.test(x.text)), JSON.stringify(inbox));
    await call('/me', { method: 'PUT', key: K.ann.key, body: { share: { mentor: true } } });
    const list = (await call('/mentor', { key: K.cat.key })).d.mentees;
    eq(list.map(m => [m.handle, m.asked]), [['bob_scalps', true], ['ann_trades', false]]);
    eq((await call('/people?f=mentor', { key: K.bob.key })).d.people[0].askedMentor, true);
    clock += 86400000 + 1000;
    eq((await call('/people/cat_mentor/mentor', { method: 'POST', key: K.bob.key, body: { letIn: true } })).status, 200, 'again the next day');
  });
  await t('profiles say who mentors and who is looking for a partner', async () => {
    const p = (await call('/profile/cat_mentor', { key: K.bob.key })).d.profile, a = (await call('/profile/ann_trades', { key: K.bob.key })).d.profile;
    eq([p.mentor, a.seeking, a.mentor], [true, true, false]);
  });
} finally { await new Promise(r => app.close(r)); }
report('people');
