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
    eq((await call('/people', { key: K.bob.key })).d.people.find(p => p.handle === 'ann_trades').following, false);
    eq((await call('/follow/ann_trades', { method: 'POST', key: K.bob.key })).status, 200);
    eq((await call('/people', { key: K.bob.key })).d.people.find(p => p.handle === 'ann_trades').following, true, 'cards say who you follow');
    eq((await call('/people?f=following', { key: K.bob.key })).d.people.map(p => p.handle), ['ann_trades'], 'and the Following filter lists them');
    await call('/follow/ann_trades', { method: 'DELETE', key: K.bob.key });
    eq((await call('/people?f=following', { key: K.bob.key })).d.total, 0);
  });
  await t('partnering from the directory needs no shared league', async () => {
    eq((await call('/partners', { method: 'POST', key: K.bob.key, body: { handle: 'ann_trades' } })).status, 200);
    eq((await call('/people?f=partner', { key: K.bob.key })).d.people[0].partner, 'sent');
    eq((await call('/people?f=partner', { key: K.ann.key })).d.people.length, 0, 'bob isn’t looking for one');
    eq((await call('/people?q=bob', { key: K.ann.key })).d.people[0].partner, 'asked');
  });
  await t('asking a mentor: lets mentors in only when told to, tells the mentor, and waits for their yes', async () => {
    const no = await call('/people/cat_mentor/mentor', { method: 'POST', key: K.bob.key, body: {} });
    eq([no.status, no.d.needsLetIn], [409, true], 'never opens your days without a yes');
    const yes = await call('/people/cat_mentor/mentor', { method: 'POST', key: K.bob.key, body: { letIn: true, text: 'I overtrade on Mondays' } });
    eq([yes.status, yes.d.share.mentor, yes.d.took, yes.d.me.requests], [200, true, false, ['cat_mentor']]);
    const again = await call('/people/cat_mentor/mentor', { method: 'POST', key: K.bob.key, body: { letIn: true } });
    eq([again.status, again.d.requested], [409, true], 'asked already');
    eq((await call('/people/ann_trades/mentor', { method: 'POST', key: K.bob.key, body: { letIn: true } })).status, 404, 'only mentors');
    const inbox = (await call('/inbox', { key: K.cat.key })).d.items;
    ok(inbox.some(x => x.kind === 'mentor' && /bob_scalps would like you to mentor them\. “I overtrade on Mondays”/.test(x.text)), JSON.stringify(inbox));
    await call('/me', { method: 'PUT', key: K.ann.key, body: { share: { mentor: true } } });
    const d = (await call('/mentor', { key: K.cat.key })).d;
    eq([d.mentees, d.requests.map(m => [m.handle, m.text])], [[], [['bob_scalps', 'I overtrade on Mondays']]], 'letting mentors in isn’t asking one: ann isn’t on cat’s list');
    eq((await call('/mentor/bob_scalps', { key: K.cat.key })).status, 404, 'bob’s days open only once cat says yes');
    eq((await call('/people?f=mentor', { key: K.bob.key })).d.people[0].askedMentor, true);
    eq((await call('/mentor/bob_scalps/accept', { method: 'POST', key: K.cat.key, body: {} })).status, 200);
    eq((await call('/mentor', { key: K.cat.key })).d.mentees.map(m => m.handle), ['bob_scalps']);
    eq((await call('/people?f=mentor', { key: K.bob.key })).d.people[0].myMentor, true);
  });
  await t('profiles say who mentors and who is looking for a partner', async () => {
    const p = (await call('/profile/cat_mentor', { key: K.bob.key })).d.profile, a = (await call('/profile/ann_trades', { key: K.bob.key })).d.profile;
    eq([p.mentor, a.seeking, a.mentor], [true, true, false]);
  });
  await t('X, Telegram and Discord on a profile: usernames only, links give their name, a private profile keeps them', async () => {
    const put = (key, socials, extra) => call('/me', { method: 'PUT', key, body: Object.assign({ socials }, extra || {}) });
    let r = await put(K.ann.key, { x: '@Ann_X', telegram: 'https://t.me/ann_trades?start=1', discord: '@Ann.Trades' });
    eq([r.status, r.d.me.socials], [200, { x: 'Ann_X', telegram: 'ann_trades', discord: 'ann.trades' }], 'the @ goes, a link gives its name, Discord is lowercased');
    eq((await put(K.ann.key, { x: 'https://twitter.com/ann_x2/status/123' })).d.me.socials, { x: 'ann_x2', telegram: 'ann_trades', discord: 'ann.trades' }, 'twitter.com links too; the others stay');
    eq((await put(K.ann.key, { x: 'www.x.com/ann_x' })).d.me.socials.x, 'ann_x');
    for (const [s, re] of [[{ x: 'way_too_long_for_x' }, /X username is 1–15/], [{ x: 'https://evil.example/ann' }, /X username/], [{ telegram: 'abc' }, /Telegram username is 5–32/],
      [{ telegram: 't.me/+joinchat' }, /Telegram username/], [{ discord: 'Ann Trades' }, /Discord username is 2–32/], [{ discord: 'a' }, /Discord username/]]) {
      r = await put(K.ann.key, s, { bio: 'changed' }); eq(r.status, 400, JSON.stringify(s)); ok(re.test(r.d.error), r.d.error); }
    const me = (await call('/me', { key: K.ann.key })).d.me;
    eq([me.bio, me.socials], ['Swing trader, ETH and SOL', { x: 'ann_x', telegram: 'ann_trades', discord: 'ann.trades' }], 'a rejected one saves nothing');
    eq((await put(K.ann.key, { telegram: '' })).d.me.socials, { x: 'ann_x', discord: 'ann.trades' }, 'empty takes one off');
    eq((await call('/profile/ann_trades', { key: K.bob.key })).d.profile.socials, { x: 'ann_x', discord: 'ann.trades' }, 'others see them');
    eq((await call('/me', { method: 'PUT', key: K.ann.key, body: { bio: 'Swing trader' } })).d.me.socials, { x: 'ann_x', discord: 'ann.trades' }, 'a save without them keeps them');
    ok(!('socials' in (await put(K.ann.key, { x: '', discord: '' })).d.me), 'all empty: none');
    eq((await put(K.ann.key, { x: 'ann_x' })).status, 200); ok(!('socials' in (await put(K.ann.key, null)).d.me), 'null takes them all off');
    // cat's profile is private: cat sees their own (to edit them), no one else gets them
    eq((await put(K.cat.key, { x: 'cat_x', telegram: 'cat_mentor', discord: 'cat' })).d.me.socials, { x: 'cat_x', telegram: 'cat_mentor', discord: 'cat' });
    eq((await call('/profile/cat_mentor', { key: K.cat.key })).d.profile.socials.x, 'cat_x');
    const priv = (await call('/profile/cat_mentor', { key: K.bob.key })).d.profile;
    eq(priv.private, true); ok(!('socials' in priv) && !/cat_x/.test(JSON.stringify(priv)), JSON.stringify(priv));
  });
} finally { await new Promise(r => app.close(r)); }
report('people');
