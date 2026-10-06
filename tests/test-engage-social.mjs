// Coming back daily, between members: pair streaks between accountability partners, credit for rules others
// adopt, plan outcomes and the league race as notifications, quiet hours and the daily cap on social pushes,
// and the rings, themes and titles members earn and wear. (Kudos and follower notes: test-engage.mjs.)
import crypto from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { t, ok, eq, report } from './harness.mjs';

const require = createRequire(import.meta.url);
const server = require('../server.js');
const Push = require('../push.js');
const htmlPath = new URL('../ledger.html', import.meta.url).pathname;
let clock = Date.parse('2026-10-10T12:00:00Z');
const pushed = [];
const pushFetch = async (url, o) => { pushed.push(url); return { status: 201 }; };
const app = server.createApp({ dataDir: mkdtempSync(join(tmpdir(), 'ledger-engage-social-')), auth: 'owner-token', htmlPath, now: () => clock, pushFetch, pushTick: false, trustProxy: true, offsiteTimer: false,
  fetchImpl: async () => ({ ok: true, status: 200, json: async () => [] }) });
const B = await new Promise(r => app.listen(0, () => r('http://127.0.0.1:' + app.address().port)));
let ip = 0;
const call = async (p, o = {}) => { const r = await fetch(B + '/api/social' + p, { method: o.method || 'GET',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.7.' + Math.floor(++ip / 200) + '.' + (ip % 200), ...(o.key ? { 'X-Pulse-Key': o.key } : {}), ...(o.owner ? { Authorization: 'Bearer owner-token' } : {}) },
    body: o.body !== undefined ? JSON.stringify(o.body) : undefined });
  return { status: r.status, d: await r.json().catch(() => ({})) }; };
const join_ = async h => (await call('/join', { method: 'POST', body: { handle: h, share: { mentor: false } } })).d.key;
const inbox = async key => (await call('/inbox', { key })).d.items;
const day = (k, o) => Object.assign({ k, s: 70 }, o);
const keys = (from, to) => { const out = []; for (let d = Date.parse(from + 'T00:00:00Z'); d <= Date.parse(to + 'T00:00:00Z'); d += 86400000) out.push(new Date(d).toISOString().slice(0, 10)); return out; };
const stats = (days, extra) => Object.assign({ tz: 'UTC', days }, extra || {});
const ua = crypto.createECDH('prime256v1'); ua.generateKeys();
const sub = () => ({ endpoint: 'https://fcm.googleapis.com/push/' + crypto.randomBytes(4).toString('hex'), keys: { p256dh: Push.b64u(ua.getPublicKey()), auth: Push.b64u(crypto.randomBytes(16)) } });

try {
  const K = {};
  for (const h of ['ann', 'bob', 'cat', 'dan']) K[h] = await join_(h + '_tr');

  await t('pair streak: both partners showing up counts, a trade-only day doesn’t, one missed day a week is covered', async () => {
    eq((await call('/partners', { method: 'POST', key: K.ann, body: { handle: 'bob_tr' } })).status, 200);
    const pid = (await call('/partners', { key: K.bob })).d.partners[0].id;
    eq((await call('/partners/' + pid + '/accept', { method: 'POST', key: K.bob })).status, 200);
    clock = Date.parse('2026-10-20T15:00:00Z'); // Tuesday; partners since the 10th
    const all = keys('2026-10-11', '2026-10-20');
    await call('/stats', { method: 'POST', key: K.ann, body: stats(all.map(k => day(k, { j: true }))) });
    // bob: nothing on the 17th (a Saturday, week 42: covered); on the 13th only a review, which counts
    await call('/stats', { method: 'POST', key: K.bob, body: stats(all.filter(k => k !== '2026-10-17').map(k => day(k, k === '2026-10-13' ? { r: true } : { j: true }))) });
    const me = (await call('/partners', { key: K.ann })).d.partners[0];
    eq(me.streak.n, 9, 'the 11th to the 20th, less the covered 17th');
    eq([me.streak.me, me.streak.them], [true, true]);
    eq([me.streak.days.length, me.streak.days.slice(-4)], [14, ['freeze', 'both', 'both', 'both']], 'the 17th shows as week 42’s freeze');
    eq(me.streak.freeze, true, 'this week (43) has its freeze left');
    const items = await inbox(K.bob);
    ok(items.some(x => x.kind === 'streak' && /7 days in a row with @ann_tr/.test(x.text)), 'the 7-day badge is announced to both');
  });

  await t('pair streak: a day with only trades doesn’t count; today waits until midnight', async () => {
    clock = Date.parse('2026-10-22T15:00:00Z');
    const all = keys('2026-10-11', '2026-10-22');
    await call('/stats', { method: 'POST', key: K.ann, body: stats(all.map(k => day(k, { j: true }))) });
    // bob traded on the 21st and 22nd without journaling, prepping or reviewing
    await call('/stats', { method: 'POST', key: K.bob, body: stats(all.filter(k => k !== '2026-10-17').map(k => day(k, k >= '2026-10-21' ? { s: 90 } : { j: true }))) });
    const me = (await call('/partners', { key: K.ann })).d.partners[0];
    eq([me.streak.me, me.streak.them], [true, false], 'today: ann showed up, bob didn’t');
    eq([me.streak.n, me.streak.freeze], [9, false], 'the 21st (traded, not journaled) took week 43’s freeze; today is still open');
    eq(me.streak.days.slice(-2), ['freeze', 'today']);
    clock = Date.parse('2026-10-24T15:00:00Z');
    await call('/stats', { method: 'POST', key: K.ann, body: stats(keys('2026-10-11', '2026-10-24').map(k => day(k, { j: true }))) });
    eq((await call('/partners', { key: K.ann })).d.partners[0].streak.n, 0, 'a second miss in week 43 ends it');
  });

  await t('adopting a rule credits its author: +5 XP each new adopter, once each, only for a real rule of theirs', async () => {
    await call('/stats', { method: 'POST', key: K.cat, body: stats([day('2026-10-22', { j: true })], { habits: ['No trades in the first 15 minutes'] }) });
    const r = await call('/adopt', { method: 'POST', key: K.ann, body: { from: 'cat_tr', text: 'no trades in the  first 15 minutes' } });
    eq([r.status, r.d.n, r.d.xp], [200, 1, 5]);
    eq((await call('/adopt', { method: 'POST', key: K.ann, body: { from: 'cat_tr', text: 'No trades in the first 15 minutes' } })).d, { n: 1, xp: 0 }, 'once per adopter');
    eq((await call('/adopt', { method: 'POST', key: K.ann, body: { from: 'cat_tr', text: 'Buy every dip' } })).status, 400, 'not one of hers');
    eq((await call('/adopt', { method: 'POST', key: K.cat, body: { from: 'cat_tr', text: 'No trades in the first 15 minutes' } })).d.xp, 0, 'your own rule: no credit');
    await call('/adopt', { method: 'POST', key: K.bob, body: { from: 'cat_tr', text: 'No trades in the first 15 minutes' } });
    const items = await inbox(K.cat), a = items.filter(x => x.kind === 'adopt');
    eq(a.length, 1, 'two adopters within the hour: one line');
    ok(/^@bob_tr and 1 other adopted “No trades in the first 15 minutes”/.test(a[0].text), a[0].text);
    const prof = (await call('/profile/cat_tr', { key: K.dan })).d.profile;
    eq([prof.rules, prof.adoptN], [[{ text: 'No trades in the first 15 minutes', n: 2 }], 2]);
    const top = (await call('/feed?scope=discover', { key: K.dan })).d.topRules;
    eq(top[0].n, 2, 'most adopted this week');
  });

  await t('adoption XP stops at 50 a week, and Rulemaker comes at 5 adoptions', async () => {
    for (let i = 0; i < 10; i++) { const k = await join_('fan' + i); await call('/adopt', { method: 'POST', key: k, body: { from: 'cat_tr', text: 'No trades in the first 15 minutes' } }); }
    const me = (await call('/me', { key: K.cat })).d.me;
    eq(me.adoptN, 12, 'ann, bob and ten fans');
    eq((await call('/stats', { method: 'POST', key: K.cat, body: stats([day('2026-10-22', { j: true })], { habits: ['No trades in the first 15 minutes'] }) })).d.xp, 50, '12 adopters, 50 XP');
    ok((await inbox(K.cat)).some(x => x.kind === 'adopt' && /You earned “Rulemaker”/.test(x.text)));
    eq(me.looks.find(l => l.id === 'rule').has, true, 'the Rulemaker ring is hers to wear');
  });

  await t('a plan’s update reaches whoever gave it kudos', async () => {
    const p = (await call('/posts', { method: 'POST', key: K.dan, body: { kind: 'plan', text: 'Breakout retest on the 4h.', trade: { coin: 'BTC', side: 'long', entry: 60000, stop: 59000, target: 63000 } } })).d.post;
    await call('/kudos/' + p.id, { method: 'POST', key: K.ann }); await call('/kudos/' + p.id, { method: 'POST', key: K.bob });
    eq((await call('/posts/' + p.id, { method: 'PUT', key: K.dan, body: { outcome: 'Stopped out, kept to the plan.' } })).status, 200);
    for (const key of [K.ann, K.bob]) ok((await inbox(key)).some(x => x.kind === 'outcome' && /@dan_tr posted how their plan went/.test(x.text)));
    ok(!(await inbox(K.cat)).some(x => x.kind === 'outcome'), 'no kudos, no news');
  });

  await t('push: social news respects quiet hours and the daily cap, and still lands in the inbox', async () => {
    eq((await call('/push', { method: 'POST', key: K.dan, body: { subscription: sub(), prefs: { cap: 3, quiet: { on: true, from: '22:00', to: '07:00' } } } })).d.prefs.cap, 3);
    const post = (await call('/posts', { method: 'POST', key: K.dan, body: { kind: 'note', text: 'Note for comments' } })).d.post.id;
    clock = Date.parse('2026-10-22T23:30:00Z'); pushed.length = 0;
    await call('/posts/' + post + '/comments', { method: 'POST', key: K.ann, body: { text: 'Late one' } }); await new Promise(r => setTimeout(r, 50));
    eq(pushed.length, 0, 'quiet hours: no push');
    ok((await inbox(K.dan)).some(x => x.kind === 'comment' && /Late one/.test(x.text)), 'but it’s in the inbox');
    clock = Date.parse('2026-10-23T10:00:00Z');
    for (let i = 0; i < 4; i++) await call('/posts/' + post + '/comments', { method: 'POST', key: K.ann, body: { text: 'Comment ' + i } });
    await new Promise(r => setTimeout(r, 50));
    eq(pushed.length, 3, 'the daily cap of 3');
    const pr = (await call('/push', { method: 'PUT', key: K.dan, body: { prefs: { cap: 7, outcome: false } } })).d.prefs;
    eq([pr.cap, pr.outcome, pr.adopt, pr.social, pr.league], [3, false, true, true, true], 'only 3, 5 or 10; each kind on its own');
  });

  await t('the league race: whoever you pass hears about it, once a day', async () => {
    clock = Date.parse('2026-10-23T12:00:00Z');
    const xp = (k, s) => ({ tz: 'UTC', days: [day(k, { s })], xpLog: { [k]: { s } } });
    await call('/stats', { method: 'POST', key: K.cat, body: xp('2026-10-23', 80) });
    await call('/stats', { method: 'POST', key: K.dan, body: xp('2026-10-23', 30) });
    const race = () => inbox(K.cat).then(L => L.filter(x => x.kind === 'league' && /passed you/.test(x.text)));
    const before = (await race()).length;
    await call('/stats', { method: 'POST', key: K.dan, body: { tz: 'UTC', days: [day('2026-10-22', { s: 100 }), day('2026-10-23', { s: 100 })], xpLog: { '2026-10-22': { s: 100 }, '2026-10-23': { s: 100 } } } });
    const after = await race();
    eq(after.length, before + 1); ok(/^@dan_tr passed you in Main league\. You’re #\d/.test(after[0].text), after[0].text);
  });

  await t('looks: only what you’ve earned can be worn, and a role taken back takes its ring with it', async () => {
    eq((await call('/me', { method: 'PUT', key: K.ann, body: { look: { ring: 'ninja' } } })).status, 400);
    const ann = (await call('/admin/members', { owner: true })).d.members.find(m => m.handle === 'ann_tr');
    await call('/admin/members/' + ann.id, { method: 'POST', owner: true, body: { action: 'ninja' } });
    const r = await call('/me', { method: 'PUT', key: K.ann, body: { look: { ring: 'ninja', theme: 'ninja', title: 'ninja' } } });
    eq([r.status, r.d.me.look.ring, r.d.me.look.titleName], [200, 'ninja', 'High Ninja']);
    eq((await call('/profile/ann_tr', { key: K.bob })).d.profile.ring, 'ninja', 'others see it');
    await call('/admin/members/' + ann.id, { method: 'POST', owner: true, body: { action: 'unninja' } });
    eq((await call('/profile/ann_tr', { key: K.bob })).d.profile.look, {}, 'gone with the role');
  });
} finally { app.close(); }
report('engage-social');
