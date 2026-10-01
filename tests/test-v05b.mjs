// v0.5 on the server: web push (RFC 8291 encryption, VAPID, reminders), accountability partners,
// mentors and league seasons, over real HTTP with a stubbed Hyperliquid and a stubbed push service.
import { mkdtempSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import crypto from 'node:crypto';
import { t, ok, eq, report, storedText } from './harness.mjs';

const require = createRequire(import.meta.url);
const Push = require('../push.js');
const Wear = require('../wear.js');
const S = require('../social.js');
const server = require('../server.js');
const htmlPath = new URL('../ledger.html', import.meta.url).pathname;

console.log('\nWeb push');
t('encryption matches a reference implementation byte for byte (fixed keys and salt)', () => {
  const ua = crypto.createECDH('prime256v1'); ua.setPrivateKey(Buffer.alloc(32, 7));
  const keys = { p256dh: Push.b64u(ua.getPublicKey()), auth: Push.b64u(Buffer.alloc(16, 9)) };
  const out = Push.encrypt('Pulse test', keys, { senderPrivate: Buffer.alloc(32, 5), salt: Buffer.alloc(16, 3) });
  // produced by the http_ece package (the one web-push uses) with the same inputs
  eq(Push.b64u(out), 'AwMDAwMDAwMDAwMDAwMDAwAAEABBBAeBDql0zqV3PmO4l_N-O-mgnnpf6blxpE0QZawqOpMRY35HpPmUZKD9zkSojsfXA6kYPB0GVS2eLWt2BpSBxXeaacklfM97jQ5fRRqKsXolQ4Ery8V9CVTvaWw');
});
t('a message decrypts with the subscriber’s private key', () => {
  const ua = crypto.createECDH('prime256v1'); ua.generateKeys(); const auth = crypto.randomBytes(16);
  const body = Push.encrypt('{"title":"hi"}', { p256dh: Push.b64u(ua.getPublicKey()), auth: Push.b64u(auth) });
  // RFC 8291 receiver side
  const salt = body.subarray(0, 16), idlen = body[20], asPub = body.subarray(21, 21 + idlen), ct = body.subarray(21 + idlen);
  const h = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
  const ikm = h(h(auth, ua.computeSecret(asPub)), Buffer.concat([Buffer.from('WebPush: info\0'), ua.getPublicKey(), asPub, Buffer.from([1])]));
  const prk = h(salt, ikm), cek = h(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16), nonce = h(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce); d.setAuthTag(ct.subarray(ct.length - 16));
  const pt = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
  eq(pt.toString(), '{"title":"hi"}\u0002');
});
t('the VAPID header is a valid ES256 JWT for the push service’s origin, and the key persists', () => {
  const dir = mkdtempSync(join(tmpdir(), 'vapid-'));
  const v = Push.loadVapid(dir, 'mailto:owner@example.com'), again = Push.loadVapid(dir);
  eq(again.publicKey, v.publicKey);
  const hdr = Push.vapidAuth('https://web.push.apple.com/abc', v, Date.UTC(2026, 9, 1));
  const [, jwt, k] = hdr.match(/^vapid t=([^,]+), k=(.+)$/); eq(k, v.publicKey);
  const [a, b, sig] = jwt.split('.'), claims = JSON.parse(Push.unb64u(b));
  eq([claims.aud, claims.sub, claims.exp], ['https://web.push.apple.com', 'mailto:owner@example.com', Date.UTC(2026, 9, 1) / 1000 + 43200]);
  const raw = Push.unb64u(v.publicKey), pub = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: Push.b64u(raw.subarray(1, 33)), y: Push.b64u(raw.subarray(33)) }, format: 'jwk' });
  ok(crypto.verify('sha256', Buffer.from(a + '.' + b), { key: pub, dsaEncoding: 'ieee-p1363' }, Push.unb64u(sig)));
});
t('subscriptions only point at the browsers’ push services: never an internal or made-up host', () => {
  const ua = crypto.createECDH('prime256v1'); ua.generateKeys();
  const keys = { p256dh: Push.b64u(ua.getPublicKey()), auth: Push.b64u(crypto.randomBytes(16)) };
  for (const ep of ['https://169.254.169.254/latest', 'https://localhost:8443/admin', 'https://10.0.0.5/x', 'https://evil.test/push', 'https://fcm.googleapis.com.evil.test/x', 'https://fcm.googleapis.com:444/x'])
    eq(Push.sanitizeSubscription({ endpoint: ep, keys }), null, ep);
  for (const ep of ['https://fcm.googleapis.com/fcm/send/a', 'https://updates.push.services.mozilla.com/wpush/v2/a', 'https://web.push.apple.com/a', 'https://wns2-par02p.notify.windows.com/w/?token=a'])
    ok(Push.sanitizeSubscription({ endpoint: ep, keys }), ep);
});
t('subscriptions must be https with real keys', () => {
  const ua = crypto.createECDH('prime256v1'); ua.generateKeys();
  const keys = { p256dh: Push.b64u(ua.getPublicKey()), auth: Push.b64u(crypto.randomBytes(16)) };
  ok(Push.sanitizeSubscription({ endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys }));
  eq(Push.sanitizeSubscription({ endpoint: 'http://evil.test/x', keys }), null);
  eq(Push.sanitizeSubscription({ endpoint: 'https://x.test/y', keys: { p256dh: 'abc', auth: keys.auth } }), null);
});

console.log('\nWearables');
t('WHOOP and Oura records become one day each: score, HRV, resting HR and hours asleep', () => {
  const w = Wear.whoopDays([{ created_at: '2026-10-01T06:30:00Z', score_state: 'SCORED', score: { recovery_score: 64, resting_heart_rate: 54, hrv_rmssd_milli: 61.37 } },
    { created_at: '2026-10-02T06:30:00Z', score_state: 'PENDING_SCORE' }],
    [{ end: '2026-10-01T06:20:00Z', score: { stage_summary: { total_in_bed_time_milli: 8 * 3600000, total_awake_time_milli: 1800000 } } }, { end: '2026-10-01T15:00:00Z', nap: true, score: { stage_summary: {} } }]);
  eq(w, { '2026-10-01': { score: 64, rhr: 54, hrv: 61.4, sleepH: 7.5 } });
  const o = Wear.ouraDays([{ day: '2026-10-01', score: 81 }], [{ day: '2026-10-01', type: 'long_sleep', average_hrv: 48, lowest_heart_rate: 50, total_sleep_duration: 26100 }, { day: '2026-10-01', type: 'rest', average_hrv: 1 }]);
  eq(o, { '2026-10-01': { score: 81, hrv: 48, rhr: 50, sleepH: 7.3 } });
  eq(Object.keys(Wear.whoopDays([{ created_at: '2026-10-01T23:30:00Z', timezone_offset: '+02:00', score_state: 'SCORED', score: { recovery_score: 50 } }], [])), ['2026-10-02'], 'the wearer’s own day');
});
t('Apple Health: HRV against your own month (60%) and sleep against eight hours (40%)', () => {
  const hist = [50, 52, 48, 51, 49].map(hrv => ({ hrv }));
  eq(Wear.appleScore({ hrv: 50, sleepH: 8 }, hist), 70);
  eq(Wear.appleScore({ hrv: 40, sleepH: 6 }, hist), 48);
  eq(Wear.appleScore({ sleepH: 4 }, []), 50); eq(Wear.appleScore({}, hist), null);
});

console.log('\nSeasons');
t('month and quarter seasons, their bounds, labels and weeks', () => {
  eq(S.seasonOf('month', '2026-10-17'), '2026-10'); eq(S.seasonOf('quarter', '2026-11-30'), '2026-Q4'); eq(S.seasonOf('', '2026-11-30'), null);
  eq(S.seasonBounds('2026-02'), { start: '2026-02-01', end: '2026-02-28' }); eq(S.seasonBounds('2026-Q4'), { start: '2026-10-01', end: '2026-12-31' });
  eq(S.seasonLabel('2026-Q4'), 'Q4 2026'); eq(S.seasonLabel('2026-10'), 'October 2026');
  eq(S.weeksIn('2026-10-01', '2026-10-31'), ['2026-W41', '2026-W42', '2026-W43', '2026-W44']);
});

console.log('\nHTTP');
const listen = app => new Promise(res => app.listen(0, () => res('http://127.0.0.1:' + app.address().port)));
let clock = Date.UTC(2026, 9, 28, 7, 0); // Wed 28 Oct 2026, 07:00 UTC
const pushed = [];
const pushFetch = async (url, o) => { pushed.push({ url, headers: o.headers, size: o.body.length }); return { status: url.includes('gone') ? 410 : 201 }; };
const dataDir = mkdtempSync(join(tmpdir(), 'v05b-'));
const wearCalls = [];
const wearFetch = async (url, o = {}) => { wearCalls.push(url);
  const ok = d => ({ ok: true, status: 200, json: async () => d });
  if (url.includes('/oauth2/token')) return ok({ access_token: 'acc-' + (o.body.includes('refresh_token') ? 2 : 1), refresh_token: 'ref', expires_in: 3600 });
  if (url.includes('/v2/recovery')) return ok({ records: [{ created_at: '2026-10-28T06:00:00Z', score_state: 'SCORED', score: { recovery_score: 72, resting_heart_rate: 52, hrv_rmssd_milli: 70 } }] });
  if (url.includes('/activity/sleep')) return ok({ records: [] });
  return { ok: false, status: 404, json: async () => ({}) }; };
const app = server.createApp({ dataDir, auth: 'owner-token', htmlPath, now: () => clock, pushFetch, pushTick: false,
  wearFetch, wearEnv: { WHOOP_CLIENT_ID: 'cid', WHOOP_CLIENT_SECRET: 'sec' }, wearOrigin: 'https://pulse.example',
  fetchImpl: async () => ({ ok: true, status: 200, json: async () => [] }) });
const B = await listen(app);
const call = async (p, o = {}) => { const r = await fetch(B + '/api/social' + p, { method: o.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(o.key ? { 'X-Pulse-Key': o.key } : {}), ...(o.admin ? { Authorization: 'Bearer owner-token' } : {}) },
    body: o.body !== undefined ? JSON.stringify(o.body) : undefined });
  return { status: r.status, d: await r.json() }; };
const join_ = async h => (await call('/join', { method: 'POST', body: { handle: h } })).d.key;
const ua = crypto.createECDH('prime256v1'); ua.generateKeys();
const subFor = host => ({ endpoint: 'https://' + host + '/push/' + crypto.randomBytes(4).toString('hex'), keys: { p256dh: Push.b64u(ua.getPublicKey()), auth: Push.b64u(crypto.randomBytes(16)) } });
try {
  const A = await join_('alice'), Bk = await join_('bobby'), C = await join_('carol');
  await t('push: the key is served, a device subscribes, the morning reminder goes once on the member’s clock', async () => {
    const k = await call('/push', { key: A }); ok(k.d.available && k.d.key.length > 80);
    eq((await call('/push', { method: 'POST', key: A, body: { subscription: subFor('fcm.googleapis.com'), prefs: { morning: '08:00', eod: '21:00' } } })).d.on, true);
    await call('/stats', { method: 'POST', key: A, body: { xp: 10, level: 1, tz: 'Europe/Madrid', days: [{ k: '2026-10-28', s: 80 }] } });
    // 07:00 UTC is 08:00 in Madrid (CET after the clocks change)
    eq(await app.pushTick(), 1); eq(await app.pushTick(), 0, 'once a day');
    eq(pushed.length, 1); eq(pushed[0].headers['Content-Encoding'], 'aes128gcm'); ok(/^vapid t=/.test(pushed[0].headers.Authorization));
    clock = Date.UTC(2026, 9, 28, 20, 5); eq(await app.pushTick(), 1, 'the evening review reminder on a traded day');
    await call('/stats', { method: 'POST', key: A, body: { xp: 10, level: 1, tz: 'Europe/Madrid', days: [{ k: '2026-10-29', s: 80, r: true }] } });
    clock = Date.UTC(2026, 9, 29, 20, 5); eq(await app.pushTick(), 0, 'no morning reminder after noon, no evening one once the day is reviewed');
  });
  await t('partners: ask, accept, see each other’s days and slips, nudge once per six hours, end it', async () => {
    const r = await call('/partners', { method: 'POST', key: A, body: { handle: '@bobby' } });
    eq(r.d.partner.status, 'sent'); const id = r.d.partner.id;
    eq((await call('/partners', { key: Bk })).d.partners[0].status, 'received');
    ok((await call('/inbox', { key: Bk })).d.items[0].text.includes('@alice wants to be accountability partners'));
    eq((await call('/partners/' + id + '/nudge', { method: 'POST', key: A, body: {} })).status, 409, 'not before they accept');
    eq((await call('/partners/' + id + '/accept', { method: 'POST', key: A })).status, 409, 'the asker can’t accept for them');
    eq((await call('/partners/' + id + '/accept', { method: 'POST', key: Bk })).d.partner.status, 'active');
    await call('/stats', { method: 'POST', key: Bk, body: { xp: 50, level: 2, streak: 4, tz: 'UTC', days: [{ k: '2026-10-28', s: 60, f: ['revenge', 'sizeUp', 'bogus'] }] } });
    const v = (await call('/partners', { key: A })).d.partners[0].view;
    eq([v.handle, v.streak, v.avg7, v.slips7, v.days[0].f], ['bobby', 4, 60, 2, ['revenge', 'sizeUp']]);
    eq((await call('/partners/' + id + '/nudge', { method: 'POST', key: A, body: { text: 'Two strikes today' } })).status, 200);
    eq((await call('/partners/' + id + '/nudge', { method: 'POST', key: A, body: {} })).status, 429);
    ok((await call('/inbox', { key: Bk })).d.items[0].text.includes('@alice: Two strikes today'));
    await call('/partners/' + id + '/challenge', { method: 'PUT', key: Bk, body: { text: 'No trades in the first 15 minutes' } });
    eq((await call('/partners', { key: A })).d.partners[0].challenge, { text: 'No trades in the first 15 minutes', mine: false });
    eq((await call('/partners', { method: 'POST', key: A, body: { handle: 'bobby' } })).status, 409, 'already partners');
    eq((await call('/partners/' + id, { method: 'DELETE', key: Bk })).status, 200);
    eq((await call('/partners', { key: A })).d.partners, []);
  });
  await t('mentors: appointed by the owner, see only members who let them in, and their notes land in the inbox', async () => {
    eq((await call('/mentor', { key: C })).status, 403);
    const list = (await call('/admin/members', { admin: true })).d.members, carol = list.find(m => m.handle === 'carol');
    await call('/admin/members/' + carol.id, { method: 'POST', admin: true, body: { action: 'mentor' } });
    eq((await call('/mentor', { key: C })).d.mentees, [], 'nobody opted in yet');
    eq((await call('/mentor/alice', { key: C })).status, 404);
    await call('/me', { method: 'PUT', key: A, body: { share: { mentor: true } } });
    await call('/stats', { method: 'POST', key: A, body: { xp: 10, level: 1, tz: 'UTC', days: [{ k: '2026-10-29', s: 55, f: ['afterTwo'], l: 'Stop after two losses' }] } });
    const d = (await call('/mentor/alice', { key: C })).d.mentee;
    eq([d.handle, d.days[0].l, d.days[0].f], ['alice', 'Stop after two losses', ['afterTwo']]);
    const n = await call('/mentor/alice/notes', { method: 'POST', key: C, body: { day: '2026-10-29', text: 'Good call stopping. Write the rule down.' } });
    eq(n.d.note.by, 'carol');
    const mine = (await call('/notes', { key: A })).d.notes; eq([mine[0].text, mine[0].read], ['Good call stopping. Write the rule down.', false]);
    ok((await call('/inbox', { key: A })).d.items.some(x => x.kind === 'mentor'));
    await call('/me', { method: 'PUT', key: A, body: { share: { mentor: false } } });
    eq((await call('/mentor/alice', { key: C })).status, 404, 'opting out closes the door at once');
  });
  await t('a lesson only reaches the server for members who let mentors in', async () => {
    await call('/stats', { method: 'POST', key: Bk, body: { xp: 10, level: 1, tz: 'UTC', days: [{ k: '2026-10-29', s: 70, l: 'private lesson' }] } });
    const st = storedText(dataDir);
    ok(st.includes('2026-10-29') && !st.includes('private lesson'));
  });
  await t('seasons: a monthly league ranks on its season, closes it with a podium, badges and a hall of fame', async () => {
    const L = { id: (await call('/admin/leagues', { method: 'POST', admin: true, body: { name: 'Process Cup', metric: 'xp', season: 'month', open: true } })).d.id };
    ok(L.id);
    for (const k of [A, Bk, C]) await call('/leagues/' + L.id + '/join', { method: 'POST', key: k, body: {} });
    const wk = S.isoWeekOfKey('2026-10-29');
    // XP by day: a week that straddles the month end only counts its October days
    await call('/stats', { method: 'POST', key: A, body: { xp: 300, level: 2, week: wk, weekXp: 300, tz: 'UTC', xpDays: { '2026-09-29': 999, '2026-10-29': 300 } } });
    await call('/stats', { method: 'POST', key: Bk, body: { xp: 200, level: 2, week: wk, weekXp: 200, tz: 'UTC', xpDays: { '2026-10-28': 200 } } });
    const info = (await call('/leagues/' + L.id, { key: A })).d.league;
    eq([info.season.label, info.season.daysLeft], ['October 2026', 2]); eq(info.top.map(r => r.handle), ['alice', 'bobby']);
    clock = Date.UTC(2026, 10, 1, 9, 0); // November 1st: October has ended but waits a day for late syncs
    const grace = (await call('/leagues/' + L.id, { key: A })).d.league;
    eq([grace.season.label, grace.hall.length], ['November 2026', 0]);
    clock = Date.UTC(2026, 10, 2, 9, 0);
    const after = (await call('/leagues/' + L.id, { key: A })).d.league;
    eq(after.season.label, 'November 2026');
    eq(after.hall[0].podium.map(p => [p.handle, p.value]), [['alice', 300], ['bobby', 200]]);
    const me = (await call('/me', { key: A })).d.me; ok(me.awards.some(a => a.id === 'season-gold'));
    ok((await call('/inbox', { key: Bk })).d.items.some(x => x.kind === 'season' && x.text.includes('#2')));
    // the owner switching to quarters mid-November closes nothing early
    await call('/admin/leagues/' + L.id, { method: 'PUT', admin: true, body: { season: 'quarter' } });
    clock = Date.UTC(2026, 10, 14, 9, 0);
    const q = (await call('/leagues/' + L.id, { key: A })).d.league;
    eq([q.season.label, q.hall.length], ['Q4 2026', 1]);
  });
  await t('wearables: WHOOP over OAuth for a member, Oura not set up, Apple Health through a personal link', async () => {
    const w = (p, o = {}) => fetch(B + '/api/wear' + p, { method: o.method || 'GET', redirect: 'manual', headers: { 'Content-Type': 'application/json', ...(o.key ? { 'X-Pulse-Key': o.key } : {}), ...(o.cookie ? { Cookie: o.cookie } : {}) }, body: o.body !== undefined ? JSON.stringify(o.body) : undefined });
    eq((await w('')).status, 401, 'strangers get nothing');
    const st = await (await w('', { key: A })).json(); eq([st.providers.whoop.configured, st.providers.oura.configured, st.providers.whoop.connected], [true, false, false]);
    eq((await w('/oura/start', { method: 'POST', key: A })).status, 404);
    const sr = await w('/whoop/start', { method: 'POST', key: A }), start = await sr.json();
    const cookie = String(sr.headers.get('set-cookie') || '').split(';')[0]; ok(/^pulse_wear=[a-f0-9]{32}$/.test(cookie), 'the sign-in is tied to this browser');
    const u = new URL(start.url); eq([u.origin, u.searchParams.get('redirect_uri'), u.searchParams.get('client_id')], ['https://api.prod.whoop.com', 'https://pulse.example/api/wear/whoop/callback', 'cid']);
    eq((await w('/whoop/callback?code=x&state=forged')).headers.get('location'), '/pulse#checkin', 'a forged state is ignored');
    // someone else's browser following the link gets nothing attached (and the state is spent)
    const s2 = await (await w('/whoop/start', { method: 'POST', key: A })).json(), st2 = new URL(s2.url).searchParams.get('state');
    await w('/whoop/callback?code=victim&state=' + st2);
    eq((await (await w('', { key: A })).json()).providers.whoop.connected, false, 'no cookie, no link');
    const cb = await w('/whoop/callback?code=abc&state=' + u.searchParams.get('state'), { cookie }); eq(cb.status, 302);
    eq((await w('/whoop/callback?code=abc&state=' + u.searchParams.get('state'), { cookie })).status, 302, 'the state is single use (no second exchange)');
    const synced = await (await w('/sync', { method: 'POST', key: A })).json();
    eq(synced.providers.whoop.connected, true); eq(synced.days.find(d => d.k === '2026-10-28'), { k: '2026-10-28', score: 72, rhr: 52, hrv: 70, src: 'whoop' });
    eq(wearCalls.filter(x => x.includes('/oauth2/token')).length, 1);
    const ap = await (await w('/apple/token', { method: 'POST', key: Bk })).json(); ok(ap.url.startsWith('https://pulse.example/api/wear/apple?t='));
    const post = await fetch(B + '/api/wear/apple?t=' + ap.token, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date: '2026-10-28', hrv: 55, restingHR: 58, sleepHours: 6.5 }) });
    eq((await post.json()).days, 1);
    eq((await (await w('', { key: Bk })).json()).days[0], { k: '2026-10-28', hrv: 55, rhr: 58, sleepH: 6.5, score: 63, src: 'apple' });
    eq((await fetch(B + '/api/wear/apple?t=nope', { method: 'POST', body: '{}' })).status, 401);
    for (const bad of [[null], { date: '2026-13-45', hrv: 50 }, { date: '9999-01-01', hrv: 50 }, ['x']])
      eq((await (await fetch(B + '/api/wear/apple?t=' + ap.token, { method: 'POST', body: JSON.stringify(bad) })).json()).days, 0, 'ignored: ' + JSON.stringify(bad));
    eq((await (await w('', { key: C })).json()).days, [], 'each person sees only their own');
    // removed by the owner: their health data and tokens go too
    const bob = (await call('/admin/members', { admin: true })).d.members.find(m => m.handle === 'bobby');
    ok(JSON.parse(readFileSync(join(dataDir, 'wearables.json'), 'utf8')).users['m:' + bob.id]);
    await call('/admin/members/' + bob.id, { method: 'POST', admin: true, body: { action: 'remove' } });
    eq(JSON.parse(readFileSync(join(dataDir, 'wearables.json'), 'utf8')).users['m:' + bob.id], undefined);
  });
  await t('push: turning reminders off on one device leaves the others on', async () => {
    const one = subFor('fcm.googleapis.com'), two = subFor('updates.push.services.mozilla.com');
    await call('/push', { method: 'POST', key: C, body: { subscription: one } }); await call('/push', { method: 'POST', key: C, body: { subscription: two } });
    eq((await call('/push/remove', { method: 'POST', key: C, body: { endpoint: one.endpoint } })).d.on, true);
    eq((await call('/push', { method: 'POST', key: C, body: { subscription: { endpoint: 'https://169.254.169.254/x', keys: one.keys } } })).status, 400);
  });
} finally { await new Promise(r => app.close(r)); }

report('v05b');
