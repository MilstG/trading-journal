// Wearables under races: work that was already in flight when a person disconnected, rotated
// their Apple Health link or was removed writes nothing; the Shortcut's endpoint is rate limited.
// Drives createWear directly with fake requests, a gated fake fetch and an injected clock.
import { mkdtempSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { t, ok, eq, report } from './harness.mjs';

const require = createRequire(import.meta.url);
const Wear = require('../wear.js');

let clock = Date.UTC(2026, 9, 28, 7, 0);
const json = (res, code, d) => { res.code = code; res.body = d; };
const mkRes = () => { const r = { code: 0, headers: {}, body: null, setHeader: (k, v) => { r.headers[k.toLowerCase()] = v; }, writeHead: (c, h) => { r.code = c; Object.assign(r.headers, h || {}); }, end: () => {} }; return r; };
const mkReq = (method, headers = {}, ip = '10.0.0.1') => Object.assign(new EventEmitter(), { method, headers, socket: { remoteAddress: ip } });
const send = (req, body) => { req.emit('data', Buffer.from(JSON.stringify(body))); req.emit('end'); };
const gate = () => { let open; const p = new Promise(r => { open = r; }); return { p, open }; };

// a fresh store each time; the token endpoint waits on `hold` when one is set
function mk() {
  const dir = mkdtempSync(join(tmpdir(), 'wear-races-')), ctx = { hold: null, fail: false, calls: [] };
  const fetchImpl = async (url, o = {}) => { ctx.calls.push(url);
    const good = d => ({ ok: true, status: 200, json: async () => d });
    if (url.includes('/oauth2/token')) { if (ctx.hold) await ctx.hold.p;
      return ctx.fail ? { ok: false, status: 400, json: async () => ({ error: 'invalid_grant' }) } : good({ access_token: 'acc-' + ctx.calls.length, refresh_token: 'ref', expires_in: 3600 }); }
    if (url.includes('/v2/recovery')) return good({ records: [{ created_at: '2026-10-28T06:00:00Z', score_state: 'SCORED', score: { recovery_score: 72, resting_heart_rate: 52, hrv_rmssd_milli: 70 } }] });
    if (url.includes('/activity/sleep')) return good({ records: [] });
    return { ok: false, status: 404, json: async () => ({}) }; };
  const w = Wear.createWear({ dataDir: dir, json, now: () => clock, fetchImpl, env: { WHOOP_CLIENT_ID: 'cid', WHOOP_CLIENT_SECRET: 'sec' }, originOf: () => 'https://pulse.example' });
  const call = async (method, p, { uid = null, query = {}, headers = {}, ip, body } = {}) => { const req = mkReq(method, headers, ip), res = mkRes();
    const done = w.handle(req, res, '/api/wear' + p, query, () => uid); if (body !== undefined) send(req, body); await done; return res; };
  const users = () => { try { return JSON.parse(readFileSync(join(dir, 'wearables.json'), 'utf8')).users; } catch (e) { return {}; } };
  // starts a WHOOP sign-in and returns the callback, held at the token exchange until ctx.hold opens
  const signIn = async uid => { const r = await call('POST', '/whoop/start', { uid });
    const state = new URL(r.body.url).searchParams.get('state'), cookie = String(r.headers['set-cookie']).split(';')[0];
    ctx.hold = gate(); const req = mkReq('GET', { cookie }), res = mkRes();
    const done = w.handle(req, res, '/api/wear/whoop/callback', { code: 'abc', state }, () => null);
    return { done: done.then(() => res), open: () => ctx.hold.open() }; };
  // an Apple upload whose body hasn't arrived yet
  const upload = (headers, query = {}, ip) => { const req = mkReq('POST', headers, ip), res = mkRes();
    const done = w.handle(req, res, '/api/wear/apple', query, () => null);
    return { done: done.then(() => res), finish: body => send(req, body) }; };
  return { w, ctx, call, users, signIn, upload };
}
const tick = () => new Promise(r => setImmediate(r));
const day = { date: '2026-10-28', hrv: 55, restingHR: 58, sleepHours: 6.5 };

console.log('\nOAuth sign-ins in flight');
await t('disconnecting while the token exchange is in flight: the provider stays disconnected', async () => {
  const S = mk(), cb = await S.signIn('m:a');
  await S.call('DELETE', '/whoop', { uid: 'm:a' }); cb.open(); const res = await cb.done; await tick();
  eq(res.headers.Location, '/daruma#checkin');
  eq(S.users()['m:a'].whoop, undefined, 'no token written'); eq(S.w.status('m:a').providers.whoop.connected, false);
  eq(S.ctx.calls.filter(u => u.includes('/v2/')).length, 0, 'no sync started');
});
await t('a member removed while the token exchange is in flight: no record is recreated', async () => {
  const S = mk(); await S.call('POST', '/apple/token', { uid: 'm:a' }); ok(S.users()['m:a']);
  const cb = await S.signIn('m:a'); S.w.forget('m:a'); cb.open(); await cb.done; await tick();
  eq(S.users()['m:a'], undefined);
});
await t('a removed member’s failed exchange doesn’t recreate them to record the error', async () => {
  const S = mk(), cb = await S.signIn('m:a'); S.ctx.fail = true; S.w.forget('m:a'); cb.open(); await cb.done;
  eq(S.users()['m:a'], undefined);
});
await t('removal drops pending sign-ins: the state can’t be used afterwards', async () => {
  const S = mk(), r = await S.call('POST', '/whoop/start', { uid: 'm:a' });
  const state = new URL(r.body.url).searchParams.get('state'), cookie = String(r.headers['set-cookie']).split(';')[0];
  S.w.forget('m:a'); await S.call('GET', '/whoop/callback', { query: { code: 'abc', state }, headers: { cookie } });
  eq(S.ctx.calls.length, 0, 'no exchange'); eq(S.users()['m:a'], undefined);
});
await t('an undisturbed sign-in still connects', async () => {
  const S = mk(), cb = await S.signIn('m:a'); cb.open(); await cb.done; await tick(); await tick();
  eq(S.w.status('m:a').providers.whoop.connected, true);
});
await t('a token refresh in flight during a disconnect doesn’t bring the connection back', async () => {
  const S = mk(), cb = await S.signIn('m:a'); cb.open(); await cb.done; await tick(); await tick();
  clock += 2 * 3600000; S.ctx.hold = gate(); const job = S.w.sync('m:a', true); await tick();
  await S.call('DELETE', '/whoop', { uid: 'm:a' }); S.ctx.hold.open(); await job;
  eq(S.users()['m:a'].whoop, undefined); eq(S.users()['m:a'].days, {}, 'nothing merged');
});

console.log('\nApple Health uploads in flight');
await t('a member removed while the upload arrives: nothing is written', async () => {
  const S = mk(), tok = (await S.call('POST', '/apple/token', { uid: 'm:b' })).body.token;
  const up = S.upload({}, { t: tok }); await tick(); S.w.forget('m:b'); up.finish(day);
  eq((await up.done).code, 401); eq(S.users()['m:b'], undefined);
});
await t('the link rotated mid-upload: the write is refused', async () => {
  const S = mk(), tok = (await S.call('POST', '/apple/token', { uid: 'm:b' })).body.token;
  const up = S.upload({}, { t: tok }), uh = S.upload({ authorization: 'Bearer ' + tok }); await tick();
  await S.call('POST', '/apple/token', { uid: 'm:b' }); up.finish(day); uh.finish(day);
  eq((await uh.done).code, 401, 'by header too');
  eq((await up.done).code, 401); eq(S.users()['m:b'].days, {});
});
await t('Apple Health disconnected mid-upload: the write is refused', async () => {
  const S = mk(), tok = (await S.call('POST', '/apple/token', { uid: 'm:b' })).body.token;
  const up = S.upload({}, { t: tok }); await tick(); await S.call('DELETE', '/apple', { uid: 'm:b' }); up.finish(day);
  eq((await up.done).code, 401); eq(S.users()['m:b'].days, {}); eq(S.users()['m:b'].apple, undefined);
});
await t('the token works from an Authorization header as well as the link; the server offers the header form', async () => {
  const S = mk(), r = (await S.call('POST', '/apple/token', { uid: 'm:b' })).body;
  eq([r.endpoint, r.authorization, r.url], ['https://pulse.example/api/wear/apple', 'Bearer ' + r.token, 'https://pulse.example/api/wear/apple?t=' + r.token]);
  eq((await S.call('POST', '/apple', { headers: { authorization: r.authorization }, body: day })).body, { ok: true, days: 1 });
  eq((await S.call('POST', '/apple', { query: { t: r.token }, body: Object.assign({}, day, { date: '2026-10-27' }) })).body.days, 1, 'old Shortcuts keep working');
  eq(Object.keys(S.users()['m:b'].days), ['2026-10-28', '2026-10-27']);
  eq((await S.call('POST', '/apple', { headers: { authorization: 'Bearer ' + r.token + 'x'.repeat(200) }, body: day })).code, 401, 'oversized tokens never match');
});

console.log('\nApple Health rate limits');
await t('failed links from one address are turned away after 20, valid or not, until the window passes', async () => {
  const S = mk(), tok = (await S.call('POST', '/apple/token', { uid: 'm:b' })).body.token;
  for (let i = 0; i < 20; i++) eq((await S.call('POST', '/apple', { query: { t: 'guess' + i }, ip: '6.6.6.6', body: day })).code, 401);
  eq((await S.call('POST', '/apple', { query: { t: 'guess-more' }, ip: '6.6.6.6', body: day })).code, 429);
  eq((await S.call('POST', '/apple', { headers: { authorization: 'Bearer guess' }, ip: '6.6.6.6', body: day })).code, 429, 'the header too');
  eq((await S.call('POST', '/apple', { query: { t: tok }, ip: '6.6.6.6', body: day })).code, 429, 'no oracle for a good guess');
  eq((await S.call('POST', '/apple', { query: { t: tok }, ip: '7.7.7.7', body: day })).code, 200, 'others are unaffected');
  clock += 10 * 60000 + 1; eq((await S.call('POST', '/apple', { query: { t: tok }, ip: '6.6.6.6', body: day })).code, 200);
});
await t('one link uploads at most 30 times an hour, from anywhere', async () => {
  const S = mk(), tok = (await S.call('POST', '/apple/token', { uid: 'm:b' })).body.token;
  for (let i = 0; i < 30; i++) eq((await S.call('POST', '/apple', { query: { t: tok }, ip: '10.1.0.' + i, body: day })).code, 200);
  eq((await S.call('POST', '/apple', { query: { t: tok }, ip: '10.2.0.1', body: day })).code, 429);
});
await t('one address makes at most 120 uploads in ten minutes', async () => {
  const S = mk(), toks = [];
  for (let i = 0; i < 5; i++) toks.push((await S.call('POST', '/apple/token', { uid: 'm:' + i })).body.token);
  for (let i = 0; i < 120; i++) eq((await S.call('POST', '/apple', { query: { t: toks[i % 5] }, ip: '8.8.8.8', body: day })).code, 200);
  eq((await S.call('POST', '/apple', { query: { t: toks[0] }, ip: '8.8.8.8', body: day })).code, 429);
});

report('wear-races');
