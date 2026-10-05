// Passkeys (webauthn.js + the /api/social/passkey routes) against a software authenticator
// (soft-authenticator.mjs, from node:crypto — real ES256 / Ed25519 keys, real CBOR, real signatures) — so
// every check a relying party must make is exercised: ceremony type, single-use challenge,
// origin, RP ID, user presence, signature, and the clone-detecting counter.
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { t, ok, eq, report } from './harness.mjs';
import { cbor, authenticator } from './soft-authenticator.mjs';

const require = createRequire(import.meta.url);
const W = require('../webauthn.js');
const server = require('../server.js');
const htmlPath = new URL('../ledger.html', import.meta.url).pathname;

console.log('\nwebauthn.js');
t('CBOR round trip of the shapes authenticators use, and refusal of what it doesn’t support', () => {
  const v = W.cborDecode(cbor(new Map([['fmt', 'none'], [-2, Buffer.from([1, 2])], [3, -257], [500, 'x']]))).value;
  eq([v.get('fmt'), [...v.get(-2)], v.get(3), v.get(500)], ['none', [1, 2], -257, 'x']);
  let e = null; try { W.cborDecode(Buffer.from([0x9f])); } catch (x) { e = x; } ok(e && /indefinite/.test(e.message));
  e = null; try { W.cborDecode(Buffer.from([0x58, 10, 1])); } catch (x) { e = x; } ok(e && /truncated/.test(e.message));
});
for (const kind of ['es256', 'ed25519']) {
  t(kind + ': registration and sign-in verify; every tampering is refused', () => {
    const A = authenticator(kind), exp = { challenge: 'c1', origin: 'https://pulse.example', rpId: 'pulse.example' };
    const reg = W.verifyRegistration(A.create('c1', exp.origin, exp.rpId), exp);
    eq(reg.id, A.id); eq(reg.alg, kind === 'ed25519' ? -8 : -7);
    const stored = { ...reg }; const e2 = { ...exp, challenge: 'c2' };
    stored.signCount = W.verifyAssertion(A.get('c2', exp.origin, exp.rpId), e2, stored).signCount; eq(stored.signCount, 1);
    const bad = (cred, ex, re) => { let err = null; try { W.verifyAssertion(cred, ex, stored); } catch (x) { err = x; } ok(err && re.test(err.message), (err && err.message) + ' !~ ' + re); };
    bad(A.get('c3', exp.origin, exp.rpId), e2, /challenge/);
    bad(A.get('c2', 'https://evil.example', exp.rpId), e2, /origin/);
    bad(A.get('c2', exp.origin, 'evil.example'), e2, /RP ID/);
    bad(A.get('c2', exp.origin, exp.rpId, { flags: 0x00 }), e2, /not present/);
    bad(A.get('c2', exp.origin, exp.rpId, { type: 'webauthn.create' }), e2, /ceremony/);
    bad(A.get('c2', exp.origin, exp.rpId, { tamper: true }), e2, /signature/);
    A.setCount(0); bad(A.get('c2', exp.origin, exp.rpId), e2, /counter/);
  });
}

console.log('\nPasskey routes');
const dataDir = mkdtempSync(join(tmpdir(), 'ledger-pk-'));
const app = server.createApp({ dataDir, auth: 'owner', htmlPath, push: false, offsiteTimer: false, fetchImpl: async () => ({ ok: true, status: 200, json: async () => [] }) });
const B = await new Promise(r => app.listen(0, () => r('http://127.0.0.1:' + app.address().port)));
const ORIGIN = B, RP = '127.0.0.1';
const call = async (p, o = {}) => { const r = await fetch(B + '/api/social' + p, { method: o.method || 'GET', headers: { 'Content-Type': 'application/json', ...(o.key ? { 'X-Pulse-Key': o.key } : {}) }, body: o.body ? JSON.stringify(o.body) : undefined }); return { status: r.status, d: await r.json() }; };
try {
  const key = (await call('/join', { method: 'POST', body: { handle: 'passy' } })).d.key;
  const A = authenticator();
  let reg;
  await t('a signed-in member adds a passkey; the options name this site and exclude existing keys', async () => {
    const st = await call('/passkey/register/start', { method: 'POST', key });
    eq(st.status, 200); eq(st.d.rp.id, RP); eq(st.d.authenticatorSelection.residentKey, 'required'); eq(st.d.excludeCredentials, []);
    reg = await call('/passkey/register/finish', { method: 'POST', key, body: { credential: A.create(st.d.challenge, ORIGIN, RP), name: 'MacBook' } });
    eq(reg.status, 200); eq(reg.d.me.passkeys.map(k => k.name), ['MacBook']);
    eq((await call('/passkey/register/start', { method: 'POST', key })).d.excludeCredentials.map(c => c.id), [A.id]);
    eq((await call('/passkey/register/start', { method: 'POST' })).status, 401, 'needs a member key');
  });
  await t('signing in with it issues a new device key; the challenge is single use', async () => {
    const st = await call('/passkey/login/start', { method: 'POST' }); eq(st.status, 200); eq(st.d.rpId, RP);
    const cred = A.get(st.d.challenge, ORIGIN, RP);
    const fin = await call('/passkey/login/finish', { method: 'POST', body: { credential: cred } });
    eq(fin.status, 200); eq(fin.d.me.handle, 'passy'); ok(fin.d.key && fin.d.key !== key);
    eq((await call('/me', { key: fin.d.key })).d.me.handle, 'passy', 'the new key works');
    eq((await call('/passkey/login/finish', { method: 'POST', body: { credential: cred } })).status, 400, 'replay refused');
  });
  await t('signing out other devices keeps passkeys unless asked; with ?passkeys=1 they go too', async () => {
    eq((await call('/devices', { method: 'DELETE', key })).d.me.passkeys.length, 1, 'kept by default');
    const B2 = authenticator(), k3 = (await call('/join', { method: 'POST', body: { handle: 'lost_phone' } })).d.key;
    const st = await call('/passkey/register/start', { method: 'POST', key: k3 });
    await call('/passkey/register/finish', { method: 'POST', key: k3, body: { credential: B2.create(st.d.challenge, ORIGIN, RP) } });
    eq((await call('/devices?passkeys=1', { method: 'DELETE', key: k3 })).d.me.passkeys, []);
    const s5 = await call('/passkey/login/start', { method: 'POST' });
    eq((await call('/passkey/login/finish', { method: 'POST', body: { credential: B2.get(s5.d.challenge, ORIGIN, RP) } })).status, 404, 'that passkey no longer signs in');
  });
  await t('a passkey from elsewhere, a wrong origin or a bad signature gets nothing', async () => {
    const st = await call('/passkey/login/start', { method: 'POST' });
    eq((await call('/passkey/login/finish', { method: 'POST', body: { credential: authenticator().get(st.d.challenge, ORIGIN, RP) } })).status, 404);
    const s2 = await call('/passkey/login/start', { method: 'POST' });
    eq((await call('/passkey/login/finish', { method: 'POST', body: { credential: A.get(s2.d.challenge, 'https://evil.example', RP) } })).status, 403);
    const s3 = await call('/passkey/login/start', { method: 'POST' });
    eq((await call('/passkey/login/finish', { method: 'POST', body: { credential: A.get(s3.d.challenge, ORIGIN, RP, { tamper: true }) } })).status, 403);
    eq((await call('/passkey/login/finish', { method: 'POST', body: { credential: { type: 'public-key', response: {} } } })).status, 400);
  });
  await t('a passkey alone signs in, so the device must verify its owner: presence-only ceremonies are refused', async () => {
    const st = await call('/passkey/login/start', { method: 'POST' }); eq(st.d.userVerification, 'required');
    const r = await call('/passkey/login/finish', { method: 'POST', body: { credential: A.get(st.d.challenge, ORIGIN, RP, { flags: 0x01 }) } });
    eq(r.status, 403); ok(/not verified/.test(r.d.error), r.d.error);
    const U = authenticator(), k = (await call('/join', { method: 'POST', body: { handle: 'touch_only' } })).d.key;
    const rs = await call('/passkey/register/start', { method: 'POST', key: k }); eq(rs.d.authenticatorSelection.userVerification, 'required');
    eq((await call('/passkey/register/finish', { method: 'POST', key: k, body: { credential: U.create(rs.d.challenge, ORIGIN, RP, { flags: 0x41 }) } })).status, 400, 'not enrolled without verification');
  });
  await t('the same passkey can’t be linked twice; a member can remove theirs', async () => {
    const k2 = (await call('/join', { method: 'POST', body: { handle: 'other' } })).d.key;
    const st = await call('/passkey/register/start', { method: 'POST', key: k2 });
    eq((await call('/passkey/register/finish', { method: 'POST', key: k2, body: { credential: A.create(st.d.challenge, ORIGIN, RP) } })).status, 409);
    eq((await call('/passkey/' + A.id, { method: 'DELETE', key })).d.me.passkeys, []);
    const s4 = await call('/passkey/login/start', { method: 'POST' });
    eq((await call('/passkey/login/finish', { method: 'POST', body: { credential: A.get(s4.d.challenge, ORIGIN, RP) } })).status, 404, 'removed means removed');
  });
} finally { await new Promise(r => app.close(r)); }

await t('with PUBLIC_ORIGIN pinned, passkeys belong to that site and other hosts are told where to go', async () => {
  const app2 = server.createApp({ dataDir: mkdtempSync(join(tmpdir(), 'ledger-pk2-')), auth: 'owner', htmlPath, push: false, offsiteTimer: false, publicOrigins: ['https://pulse.example.com'] });
  const b2 = await new Promise(r => app2.listen(0, () => r('http://127.0.0.1:' + app2.address().port)));
  const r = await fetch(b2 + '/api/social/passkey/login/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  eq(r.status, 400); ok(/pulse\.example\.com/.test((await r.json()).error));
  await new Promise(r => app2.close(r));
});

report('passkeys');
