// Admin two-factor (admin2fa.js): TOTP against the RFC 6238 vectors, the admin session cookie and
// its expiry, gating of /api/social/admin/* (and nothing else: /api/v1 and /api/data keep working
// with the token alone), passkeys as the second step (soft-authenticator.mjs), single-use recovery
// codes, the lockout, the owner's policy for admins, the three ADMIN_2FA modes, and the reset path.
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { t, ok, eq, report } from './harness.mjs';
import { authenticator } from './soft-authenticator.mjs';

const require = createRequire(import.meta.url);
const T = require('../admin2fa.js');
const server = require('../server.js');
const htmlPath = new URL('../ledger.html', import.meta.url).pathname;
const serverJs = new URL('../server.js', import.meta.url).pathname;

console.log('\nTOTP (RFC 6238 appendix B)');
t('SHA-1, SHA-256 and SHA-512 test vectors, 8 digits', () => {
  const keys = { sha1: Buffer.from('12345678901234567890'), sha256: Buffer.from('12345678901234567890123456789012'),
    sha512: Buffer.from('1234567890123456789012345678901234567890123456789012345678901234') };
  const V = [[59, '94287082', '46119246', '90693936'], [1111111109, '07081804', '68084774', '25091201'], [1111111111, '14050471', '67062674', '99943326'],
    [1234567890, '89005924', '91819424', '93441116'], [2000000000, '69279037', '90698825', '38618901'], [20000000000, '65353130', '77737706', '47863826']];
  for (const [s, a, b, c] of V) {
    eq(T.totp(keys.sha1, s * 1000, { digits: 8, algo: 'sha1' }), a, 'sha1 @' + s);
    eq(T.totp(keys.sha256, s * 1000, { digits: 8, algo: 'sha256' }), b, 'sha256 @' + s);
    eq(T.totp(keys.sha512, s * 1000, { digits: 8, algo: 'sha512' }), c, 'sha512 @' + s);
    eq(T.totp(keys.sha1, s * 1000), a.slice(2), 'the 6-digit code the server uses @' + s);
  }
});
t('base32 (RFC 4648) round trip, and the RFC key as an authenticator app would see it', () => {
  eq(T.b32encode(Buffer.from('12345678901234567890')), 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
  eq(T.b32encode(Buffer.from('foobar')), 'MZXW6YTBOI');
  eq(T.b32decode('mzxw 6ytb oi').toString(), 'foobar');
  for (let n = 0; n < 40; n++) { const b = Buffer.from(Array.from({ length: n }, (_, i) => (i * 37 + n) & 255)); eq(T.b32decode(T.b32encode(b)).toString('hex'), b.toString('hex')); }
  let e = null; try { T.b32decode('abc1'); } catch (x) { e = x; } ok(e, 'a 1 is not base32');
});
t('a code works for its step and one either side, never twice, and never for an older step', () => {
  const key = Buffer.from('12345678901234567890'), at = 1111111109 * 1000, code = '081804', step = Math.floor(1111111109 / 30);
  eq(T.totpMatch(key, code, at, null), step);
  eq(T.totpMatch(key, code, at + 30000, null), step, 'next step: still accepted (clock drift)');
  eq(T.totpMatch(key, code, at - 30000, null), step, 'previous step: still accepted');
  eq(T.totpMatch(key, code, at + 60000, null), -1, 'two steps later: refused');
  eq(T.totpMatch(key, code, at, step), -1, 'the same step again: refused (replay)');
  eq(T.totpMatch(key, '12345', at, null), -1); eq(T.totpMatch(key, 'abcdef', at, null), -1);
});
t('the otpauth:// URI names the issuer, the account and the parameters', () => {
  eq(T.otpauthUri('JBSWY3DPEHPK3PXP', 'owner@pulse.example', 'Pulse admin'),
    'otpauth://totp/Pulse%20admin:owner%40pulse.example?secret=JBSWY3DPEHPK3PXP&issuer=Pulse%20admin&algorithm=SHA1&digits=6&period=30');
});
t('ADMIN_2FA: required, optional (the default) and off; anything else fails closed to required', () => {
  eq(['', undefined, 'optional', 'OPTIONAL'].map(v => T.parseMode(v).mode), ['optional', 'optional', 'optional', 'optional']);
  eq(['required', 'on', '1'].map(v => T.parseMode(v).mode), ['required', 'required', 'required']);
  eq(['off', '0', 'false'].map(v => T.parseMode(v).mode), ['off', 'off', 'off']);
  const r = T.parseMode('reqired'); eq(r.mode, 'required'); ok(r.warn);
});
t('recovery codes: ten characters without look-alikes, grouped 5-5', () => {
  const cs = Array.from({ length: 50 }, T.recoveryCode);
  ok(cs.every(c => /^[a-hj-km-np-z2-9]{5}-[a-hj-km-np-z2-9]{5}$/.test(c)), cs[0]);
  eq(new Set(cs).size, 50); eq(T.normRecovery(' ABCDE-fghjk '), 'abcdefghjk');
});

console.log('\nQR code (admin2fa-ui.js)');
t('the encoder matches an independent implementation module for module (Python qrcode, byte mode, level M)', () => {
  const { qrMatrix, qrSvg } = require('../admin2fa-ui.js');
  const hash = g => crypto.createHash('sha256').update(g.map(r => r.map(b => b ? 1 : 0).join('')).join('')).digest('hex').slice(0, 32);
  // [text, version, mask, sha256 of the module bits row by row] — from qrcode 8 with mask_pattern forced
  const V = [['hello', 1, 0, '99ccedcf0d82e92a63894c8b42e405a3'],
    ['otpauth://totp/Pulse%20admin:owner%40pulse.example.com?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ&issuer=Pulse%20admin&algorithm=SHA1&digits=6&period=30', 8, 3, '4d7b97d795e158fa814ab935c318a2d3'],
    ['x'.repeat(100), 6, 5, '93713b3b57e4ff371385f69b2cd93f1b'], ['w'.repeat(180), 9, 6, '9c6cb1b09ff669ad30e944a77e0a47e4'],
    ['q'.repeat(213), 10, 7, 'a9b683470f1e35026a41d95bba230a74'], ['é'.repeat(40), 5, 2, 'bb5e209b1df3ad6089a8342a4c321ca1']];
  for (const [text, v, mask, h] of V) {
    const g = qrMatrix(text, mask); eq(g.length, 17 + 4 * v, 'version ' + v); eq(hash(g), h, text.slice(0, 12) + '… mask ' + mask);
    eq(qrMatrix(text).length, 17 + 4 * v, 'the smallest version that fits');
  }
  let e = null; try { qrMatrix('z'.repeat(214)); } catch (x) { e = x; } ok(e, 'too long is an error, not a broken code');
  ok(/^<svg [^>]*viewBox="0 0 57 57"[^>]*><rect[^>]*fill="#fff"\/><path d="M4 4h1v1h-1z/.test(qrSvg(V[1][0])), 'an SVG with a quiet zone, dark on white');
});

// ---- the server ----
let clock = Date.parse('2026-10-02T12:00:00Z');
const now = () => clock;
const TOKEN = 'owner-token';
const fetchImpl = async () => ({ ok: true, status: 200, json: async () => [] });
async function boot(o = {}) {
  const dataDir = o.dataDir || mkdtempSync(join(tmpdir(), 'ledger-2fa-'));
  const app = server.createApp({ dataDir, auth: TOKEN, htmlPath, push: false, pushTick: false, offsiteTimer: false, fetchImpl, now, ...o, dataDir });
  const B = await new Promise(r => app.listen(0, '127.0.0.1', () => r('http://127.0.0.1:' + app.address().port)));
  const call = async (p, x = {}) => {
    const h = { 'Content-Type': 'application/json', ...(x.key ? { 'X-Pulse-Key': x.key } : {}), ...(x.owner !== false && !x.key ? { Authorization: 'Bearer ' + (x.token || TOKEN) } : {}),
      ...(x.cookie ? { Cookie: x.cookie } : {}), ...(x.headers || {}) };
    const r = await fetch(B + p, { method: x.method || (x.body !== undefined ? 'POST' : 'GET'), headers: h, body: x.body !== undefined ? JSON.stringify(x.body) : undefined });
    const sc = r.headers.get('set-cookie') || '', m = /pz_admin2fa=([^;]*)/.exec(sc);
    return { status: r.status, d: await r.json().catch(() => ({})), setCookie: sc, cookie: m && m[1] ? 'pz_admin2fa=' + m[1] : null, retry: r.headers.get('retry-after') };
  };
  return { app, B, call, dataDir, close: () => new Promise(r => app.close(r)) };
}
const A2 = '/api/social/admin';
const codeFor = (secret, at = clock) => T.totp(T.b32decode(secret), at);
// a passkey ceremony through the routes: register (start/finish), or the second step (verify/start + verify)
async function addPasskey(call, A, origin, name) {
  const st = await call(A2 + '/2fa/passkey/start', { body: {} });
  ok(st.status === 200, 'passkey/start ' + st.status + ' ' + JSON.stringify(st.d));
  return call(A2 + '/2fa/passkey/finish', { body: { credential: A.create(st.d.challenge, origin, st.d.rp.id), name } });
}
async function passkeyStep(call, A, origin) {
  const st = await call(A2 + '/2fa/verify/start', { body: {} });
  ok(st.status === 200, 'verify/start ' + st.status + ' ' + JSON.stringify(st.d));
  return call(A2 + '/2fa/verify', { body: { credential: A.get(st.d.challenge, origin, st.d.rpId) } });
}

console.log('\nAdmin two-factor: the owner');
const S1 = await boot({ authFailMax: 1000 });
const { call } = S1;
let secret, recovery, cookie;
try {
  await t('off by default for everyone: the panel opens with the token alone until someone sets it up', async () => {
    eq((await call(A2 + '/overview')).status, 200);
    const st = await call(A2 + '/2fa');
    eq(st.status, 200); eq([st.d.mode, st.d.on, st.d.required, st.d.owner], ['optional', false, false, true]);
    eq((await call('/admin2fa-ui.js', { owner: false })).status, 200, 'the panel’s two-factor script is served');
  });
  await t('setting up an authenticator app: a secret and an otpauth:// URI; a wrong code is refused; the right one switches it on', async () => {
    const st = await call(A2 + '/2fa/totp/start', { body: {} });
    eq(st.status, 200); ok(/^[A-Z2-7]{32}$/.test(st.d.secret), st.d.secret); ok(st.d.uri.startsWith('otpauth://totp/Keel%20admin:owner%40127.0.0.1?secret=' + st.d.secret));
    secret = st.d.secret;
    eq((await call(A2 + '/2fa/totp/finish', { body: { code: '000000' === codeFor(secret) ? '111111' : '000000' } })).status, 400);
    const fin = await call(A2 + '/2fa/totp/finish', { body: { code: codeFor(secret) } });
    eq(fin.status, 200); eq(fin.d.recovery.length, 10, 'ten recovery codes, shown once'); ok(fin.cookie, 'and a session, so the panel stays open');
    recovery = fin.d.recovery; cookie = fin.cookie;
    ok(/HttpOnly/.test(fin.setCookie) && /SameSite=Strict/.test(fin.setCookie) && /Path=\/api\/social\/admin/.test(fin.setCookie) && /Max-Age=43200/.test(fin.setCookie), fin.setCookie);
    ok(!/Secure/.test(fin.setCookie), 'not Secure over plain http');
    const stored = readFileSync(join(S1.dataDir, 'admin-2fa.json'), 'utf8');
    ok(!recovery.some(c => stored.includes(c) || stored.includes(T.normRecovery(c))), 'recovery codes are stored hashed');
    ok(!stored.includes(cookie.split('=')[1]), 'session tokens are stored hashed');
    eq(statSync(join(S1.dataDir, 'admin-2fa.json')).mode & 0o777, 0o600);
  });
  await t('gating: every admin route needs the session now; with it, it opens', async () => {
    for (const p of ['/me', '/overview', '/members', '/log']) {
      const r = await call(A2 + p); eq(r.status, 401, p); eq(r.d.twofa.methods, { passkey: false, totp: true, recovery: true }); eq(r.d.twofa.enroll, false);
    }
    eq((await call(A2 + '/config', { method: 'PUT', body: { open: false } })).status, 401, 'writes too');
    eq((await call(A2 + '/overview', { cookie })).status, 200);
    eq((await call(A2 + '/me', { cookie })).d.owner, true);
    eq((await call(A2 + '/overview', { cookie, token: 'wrong' })).status, 401, 'the cookie alone opens nothing');
    eq((await call(A2 + '/overview', { cookie: 'pz_admin2fa=' + 'x'.repeat(43) })).status, 401, 'a made-up session');
  });
  await t('the token’s other uses are untouched: /api/v1, /api/data, snapshots', async () => {
    eq((await call('/api/data')).status, 200);
    eq((await call('/api/v1/stats')).status, 200);
    eq((await call('/api/data', { method: 'PUT', body: { rev: 0, snapshot: { journal: {} } } })).status, 200);
    eq((await call('/api/snapshots')).status, 200);
  });
  await t('the second step with the app: a session; the same code can’t be used twice', async () => {
    clock += 30000;
    const code = codeFor(secret), r = await call(A2 + '/2fa/verify', { body: { code } });
    eq(r.status, 200); eq(r.d.how, 'totp'); ok(r.cookie && r.cookie !== cookie); eq(r.d.until, clock + 12 * 3600000);
    eq((await call(A2 + '/overview', { cookie: r.cookie })).status, 200);
    eq((await call(A2 + '/2fa/verify', { body: { code } })).status, 401, 'replayed');
    cookie = r.cookie;
  });
  await t('sessions last 12 hours, then the second step is asked for again', async () => {
    clock += 12 * 3600000 - 60000; eq((await call(A2 + '/overview', { cookie })).status, 200, 'eleven hours 59 in');
    clock += 61000; const r = await call(A2 + '/overview', { cookie }); eq(r.status, 401); ok(r.d.twofa);
  });
  await t('recovery codes work once each', async () => {
    const r = await call(A2 + '/2fa/verify', { body: { code: recovery[0].toUpperCase() } });
    eq(r.status, 200); eq(r.d.how, 'recovery'); eq(r.d.recoveryLeft, 9); cookie = r.cookie;
    eq((await call(A2 + '/2fa/verify', { body: { code: recovery[0] } })).status, 401, 'used');
    eq((await call(A2 + '/2fa', { cookie })).d.recoveryLeft, 9);
    const log = (await call(A2 + '/log', { cookie })).d.log; ok(log.some(x => /^two-factor: signed in with a recovery code/.test(x.what)), 'the admin log says so');
  });
  const A = authenticator();
  await t('adding an admin passkey needs the session; then it is a second step of its own', async () => {
    eq((await call(A2 + '/2fa/passkey/start', { body: {} })).status, 401, 'no session, no changes');
    const reg = await addPasskey((p, o) => call(p, { ...o, cookie }), A, S1.B, 'YubiKey');
    eq(reg.status, 200); eq(reg.d.recovery, undefined, 'recovery codes only come with the first factor');
    const st = await call(A2 + '/2fa', { cookie });
    eq(st.d.passkeys.map(k => k.name), ['YubiKey']); eq(!!st.d.totp, true);
    const s2 = await call(A2 + '/2fa/verify/start', { body: {} });
    eq(s2.d.allowCredentials.map(c => c.id), [A.id], 'asks for this person’s admin passkeys by id');
    const cred = A.get(s2.d.challenge, S1.B, s2.d.rpId);
    const v = await call(A2 + '/2fa/verify', { body: { credential: cred } });
    eq(v.status, 200); eq(v.d.how, 'passkey'); eq((await call(A2 + '/overview', { cookie: v.cookie })).status, 200);
    eq((await call(A2 + '/2fa/verify', { body: { credential: cred } })).status, 400, 'a challenge works once');
    const s3 = await call(A2 + '/2fa/verify/start', { body: {} });
    eq((await call(A2 + '/2fa/verify', { body: { credential: authenticator().get(s3.d.challenge, S1.B, s3.d.rpId) } })).status, 401, 'someone else’s passkey');
    const s4 = await call(A2 + '/2fa/verify/start', { body: {} });
    eq((await call(A2 + '/2fa/verify', { body: { credential: A.get(s4.d.challenge, 'https://evil.example', s4.d.rpId) } })).status, 401, 'another site');
    cookie = v.cookie;
  });
  await t('an admin passkey never signs anyone in to Pulse', async () => {
    const st = await call('/api/social/passkey/login/start', { owner: false, body: {} });
    eq((await call('/api/social/passkey/login/finish', { owner: false, body: { credential: A.get(st.d.challenge, S1.B, st.d.rpId) } })).status, 404);
  });
  await t('new recovery codes replace the old ones', async () => {
    const r = await call(A2 + '/2fa/recovery', { cookie, body: {} }); eq(r.status, 200); eq(r.d.recovery.length, 10);
    eq((await call(A2 + '/2fa/verify', { body: { code: recovery[1] } })).status, 401, 'an old code');
    recovery = r.d.recovery;
    eq((await call(A2 + '/2fa/verify', { body: { code: recovery[1] } })).status, 200, 'a new one');
  });
  await t('lockout: five wrong codes lock codes for this person, even the right one; passkeys still work', async () => {
    for (let i = 0; i < 5; i++) eq((await call(A2 + '/2fa/verify', { body: { code: '999999' === codeFor(secret) ? '888888' : '999999' } })).status, 401);
    clock += 30000;
    const r = await call(A2 + '/2fa/verify', { body: { code: codeFor(secret) } });
    eq(r.status, 429); ok(+r.retry > 0, 'Retry-After');
    eq((await call(A2 + '/2fa/verify', { body: { code: recovery[2] } })).status, 429, 'recovery codes too');
    eq((await passkeyStep(call, A, S1.B)).status, 200, 'a passkey can’t be guessed, so it isn’t locked');
    clock += 15 * 60000 + 1000;
    for (let i = 0; i < 5; i++) await call(A2 + '/2fa/verify', { body: { code: '000001' } });
    clock += 15 * 60000 + 1000;
    eq((await call(A2 + '/2fa/verify', { body: { code: codeFor(secret) } })).status, 429, 'five more wrong ones: the next lock is twice as long');
    clock += 15 * 60000;
    const ok2 = await call(A2 + '/2fa/verify', { body: { code: codeFor(secret) } }); eq(ok2.status, 200, 'after it'); cookie = ok2.cookie;
    for (let i = 0; i < 5; i++) await call(A2 + '/2fa/verify', { body: { code: '000001' } });
    clock += 15 * 60000 + 1000;
    eq((await call(A2 + '/2fa/verify', { body: { code: codeFor(secret) } })).status, 200, 'a success starts the count over: back to AUTH_LOCK_MIN');
  });
  await t('signing out ends the session', async () => {
    const r = await call(A2 + '/2fa/logout', { cookie, body: {} }); eq(r.status, 200); ok(/Max-Age=0/.test(r.setCookie));
    eq((await call(A2 + '/overview', { cookie })).status, 401);
    cookie = (await passkeyStep(call, A, S1.B)).cookie;
  });
} finally { await S1.close(); }

await t('lockout: wrong second-factor codes count toward the address’s token lockout (AUTH_FAIL_MAX)', async () => {
  const S = await boot({ authFailMax: 3 });
  try {
    const st = await S.call(A2 + '/2fa/totp/start', { body: {} });
    const fin = await S.call(A2 + '/2fa/totp/finish', { body: { code: codeFor(st.d.secret) } }); eq(fin.status, 200);
    for (let i = 0; i < 3; i++) await S.call(A2 + '/2fa/verify', { body: { code: '00000' + i } });
    eq((await S.call('/api/data')).status, 429, 'that address is locked out like after three wrong tokens');
  } finally { await S.close(); }
});

console.log('\nAdmin two-factor: admins and the owner’s policy');
const S2 = await boot({ authFailMax: 1000 });
try {
  const c = S2.call;
  const made = await c(A2 + '/members', { body: { handle: 'alex', admin: true } });
  const key = (await c('/api/social/link/finish', { owner: false, body: { code: made.d.code } })).d.key, alexId = made.d.id;
  const P = authenticator();
  let alexCookie, ownerCookie;
  await t('an admin chooses for themselves: off until they add a passkey, then asked for', async () => {
    eq((await c(A2 + '/overview', { key })).status, 200);
    const reg = await addPasskey((p, o) => c(p, { ...o, key }), P, S2.B, 'Phone');
    eq(reg.status, 200); eq(reg.d.recovery.length, 10); ok(reg.cookie); alexCookie = reg.cookie;
    eq((await c(A2 + '/overview', { key })).status, 401);
    eq((await c(A2 + '/overview', { key, cookie: alexCookie })).status, 200);
    eq((await passkeyStep((p, o) => c(p, { ...o, key }), P, S2.B)).status, 200);
  });
  await t('a session belongs to one person: the admin’s cookie doesn’t pass for the owner, nor the other way', async () => {
    const st = await c(A2 + '/2fa/totp/start', { body: {} });
    const fin = await c(A2 + '/2fa/totp/finish', { body: { code: codeFor(st.d.secret) } }); ownerCookie = fin.cookie;
    eq((await c(A2 + '/overview', { cookie: alexCookie })).status, 401);
    eq((await c(A2 + '/overview', { key, cookie: ownerCookie })).status, 401);
  });
  await t('the owner sees who has two-factor, and can require it of every admin', async () => {
    const b = (await c(A2 + '/members', { cookie: ownerCookie, body: { handle: 'blair', admin: true } })).d;
    const bkey = (await c('/api/social/link/finish', { owner: false, body: { code: b.code } })).d.key;
    let st = (await c(A2 + '/2fa', { cookie: ownerCookie })).d;
    eq(st.admins.map(a => [a.handle, a.on, a.passkeys, a.totp]), [['alex', true, 1, false], ['blair', false, 0, false]]);
    eq((await c(A2 + '/overview', { key: bkey })).status, 200, 'blair hasn’t chosen it');
    eq((await c(A2 + '/2fa/policy', { key, cookie: alexCookie, method: 'PUT', body: { requireAdmins: true } })).status, 403, 'only the owner');
    st = (await c(A2 + '/2fa/policy', { cookie: ownerCookie, method: 'PUT', body: { requireAdmins: true } })).d; eq(st.policy.requireAdmins, true);
    const r = await c(A2 + '/overview', { key: bkey }); eq(r.status, 401); eq(r.d.twofa.enroll, true);
    eq((await c(A2 + '/members', { key: bkey })).status, 401);
    eq((await c(A2 + '/2fa', { key: bkey })).d.required, true, 'they can still see what to set up…');
    const s2 = await c(A2 + '/2fa/totp/start', { key: bkey, body: {} });
    const f2 = await c(A2 + '/2fa/totp/finish', { key: bkey, body: { code: codeFor(s2.d.secret) } });
    eq(f2.status, 200); eq((await c(A2 + '/overview', { key: bkey, cookie: f2.cookie })).status, 200, '…and the panel opens once they have');
    eq((await c(A2 + '/2fa/totp', { key: bkey, cookie: f2.cookie, method: 'DELETE' })).status, 409, 'and while it’s required, the last factor stays');
    eq((await c(A2 + '/2fa/policy', { cookie: ownerCookie, method: 'PUT', body: { requireAdmins: false } })).status, 200);
    eq((await c(A2 + '/2fa/totp', { key: bkey, cookie: f2.cookie, method: 'DELETE' })).status, 200, 'optional again: blair can switch it off');
    eq((await c(A2 + '/overview', { key: bkey })).status, 200);
  });
  await t('the owner resets an admin who lost their factors; their sessions end', async () => {
    eq((await c(A2 + '/2fa/admins/' + alexId, { key, cookie: alexCookie, method: 'DELETE' })).status, 403, 'not an admin’s call');
    const r = await c(A2 + '/2fa/admins/' + alexId, { cookie: ownerCookie, method: 'DELETE' }); eq(r.status, 200);
    eq(r.d.admins.find(a => a.handle === 'alex').on, false);
    eq((await c(A2 + '/2fa', { key, cookie: alexCookie })).d.session, null, 'the old session is gone');
    eq((await c(A2 + '/overview', { key })).status, 200, 'optional, and nothing set up: open');
    const log = (await c(A2 + '/log', { cookie: ownerCookie })).d.log.map(x => x.what);
    ok(log.some(w => w === 'two-factor: reset @alex’s second factors'), log.join(' | '));
  });
  await t('removing every factor switches it off for that person and drops their recovery codes', async () => {
    const st = (await c(A2 + '/2fa', { cookie: ownerCookie })).d; eq(st.recoveryLeft, 10);
    const r = await c(A2 + '/2fa/totp', { cookie: ownerCookie, method: 'DELETE' }); eq(r.status, 200); eq([r.d.on, r.d.recoveryLeft], [false, 0]);
    eq((await c(A2 + '/overview')).status, 200);
  });
} finally { await S2.close(); }

console.log('\nAdmin two-factor: modes, a damaged file, and the reset');
await t('ADMIN_2FA=required: the owner must set a factor up before anything else; /api/v1 is still open to the token', async () => {
  const S = await boot({ admin2fa: 'required' });
  try {
    const r = await S.call(A2 + '/overview'); eq(r.status, 401); eq(r.d.twofa.enroll, true); eq(r.d.twofa.mode, 'required');
    eq((await S.call('/api/v1/stats')).status, 200); eq((await S.call('/api/data')).status, 200);
    const P = authenticator(), reg = await addPasskey(S.call, P, S.B);
    eq(reg.status, 200); eq((await S.call(A2 + '/overview', { cookie: reg.cookie })).status, 200);
    eq((await S.call(A2 + '/2fa/passkey/' + P.id, { cookie: reg.cookie, method: 'DELETE' })).status, 409, 'not the last one');
    eq((await S.call(A2 + '/2fa/passkey/start', { body: {} })).status, 401, 'a second one needs the session');
  } finally { await S.close(); }
});
await t('ADMIN_2FA=off: never asked for, factors kept; on again, they apply', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ledger-2fa-off-'));
  let S = await boot({ dataDir });
  const st = await S.call(A2 + '/2fa/totp/start', { body: {} }); await S.call(A2 + '/2fa/totp/finish', { body: { code: codeFor(st.d.secret) } });
  eq((await S.call(A2 + '/overview')).status, 401); await S.close();
  S = await boot({ dataDir, admin2fa: 'off' });
  eq((await S.call(A2 + '/overview')).status, 200);
  const s = (await S.call(A2 + '/2fa')).d; eq([s.mode, s.on, s.active], ['off', true, false]);
  eq((await S.call(A2 + '/2fa/totp/start', { body: {} })).status, 403, 'nothing new is set up while it’s off');
  await S.close();
  S = await boot({ dataDir }); eq((await S.call(A2 + '/overview')).status, 401, 'kept'); await S.close();
});
await t('Secure on the cookie when the site is https', async () => {
  const S = await boot();
  try {
    const h = { 'X-Forwarded-Proto': 'https' };
    const st = await S.call(A2 + '/2fa/totp/start', { headers: h, body: {} });
    const fin = await S.call(A2 + '/2fa/totp/finish', { headers: h, body: { code: codeFor(st.d.secret) } });
    ok(/; Secure/.test(fin.setCookie), fin.setCookie);
  } finally { await S.close(); }
});
await t('a damaged admin-2fa.json closes the admin panel (503) instead of dropping everyone’s second factor', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ledger-2fa-bad-')); writeFileSync(join(dataDir, 'admin-2fa.json'), '{not json');
  const S = await boot({ dataDir });
  try { eq((await S.call(A2 + '/overview')).status, 503); eq((await S.call('/api/data')).status, 200); } finally { await S.close(); }
});
await t('reset: ADMIN_2FA_RESET clears the owner’s factors once per value; admins keep theirs', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ledger-2fa-reset-'));
  let S = await boot({ dataDir });
  const st = await S.call(A2 + '/2fa/totp/start', { body: {} }); const fin = await S.call(A2 + '/2fa/totp/finish', { body: { code: codeFor(st.d.secret) } });
  const made = await S.call(A2 + '/members', { cookie: fin.cookie, body: { handle: 'casey', admin: true } });
  const key = (await S.call('/api/social/link/finish', { owner: false, body: { code: made.d.code } })).d.key;
  const P = authenticator(); eq((await addPasskey((p, o) => S.call(p, { ...o, key }), P, S.B)).status, 200);
  eq((await S.call(A2 + '/overview')).status, 401); await S.close();
  const warn = console.warn; const said = []; console.warn = m => said.push(String(m));
  try {
    S = await boot({ dataDir, admin2faReset: '1' });
    eq((await S.call(A2 + '/overview')).status, 200, 'the owner is back in with the token');
    eq((await S.call(A2 + '/overview', { cookie: fin.cookie })).status, 200);
    eq((await S.call(A2 + '/overview', { key })).status, 401, 'casey still has theirs');
    ok(said.some(m => /ADMIN_2FA_RESET/.test(m)), 'it says so in the log');
    const s2 = await S.call(A2 + '/2fa/totp/start', { body: {} }); await S.call(A2 + '/2fa/totp/finish', { body: { code: codeFor(s2.d.secret) } });
    await S.close();
    S = await boot({ dataDir, admin2faReset: '1' }); eq((await S.call(A2 + '/overview')).status, 401, 'left set, the same value doesn’t reset again'); await S.close();
    S = await boot({ dataDir, admin2faReset: '2' }); eq((await S.call(A2 + '/overview')).status, 200, 'a new value does'); await S.close();
  } finally { console.warn = warn; }
});
await t('reset: `node server.js --reset-admin-2fa` clears the owner’s factors and exits without starting the server', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ledger-2fa-cli-'));
  let S = await boot({ dataDir });
  const st = await S.call(A2 + '/2fa/totp/start', { body: {} }); await S.call(A2 + '/2fa/totp/finish', { body: { code: codeFor(st.d.secret) } });
  eq((await S.call(A2 + '/overview')).status, 401); await S.close();
  const r = spawnSync(process.execPath, [serverJs, '--reset-admin-2fa'], { env: { ...process.env, DATA_DIR: dataDir, PORT: '1' }, encoding: 'utf8', timeout: 20000 });
  eq(r.status, 0, r.stderr); ok(/factors were removed/.test(r.stdout), r.stdout);
  S = await boot({ dataDir }); eq((await S.call(A2 + '/overview')).status, 200); await S.close();
  const r2 = spawnSync(process.execPath, [serverJs, '--reset-admin-2fa'], { env: { ...process.env, DATA_DIR: mkdtempSync(join(tmpdir(), 'ledger-2fa-cli2-')) }, encoding: 'utf8', timeout: 20000 });
  eq(r2.status, 0, r2.stderr); ok(/already clear/.test(r2.stdout), r2.stdout);
});

report('admin two-factor');
