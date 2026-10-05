// A software WebAuthn authenticator built from node:crypto — real ES256 / Ed25519 keys, real CBOR,
// real signatures — for the passkey suites (member passkeys, admin two-factor).
import crypto from 'node:crypto';

const b64u = b => Buffer.from(b).toString('base64url');
const sha = b => crypto.createHash('sha256').update(b).digest();

// --- a tiny CBOR encoder, just for building authenticator output ---
export function cbor(v) {
  const head = (major, n) => n < 24 ? Buffer.from([major << 5 | n]) : n < 256 ? Buffer.from([major << 5 | 24, n]) : Buffer.from([major << 5 | 25, n >> 8, n & 255]);
  if (typeof v === 'number') return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === 'string') { const b = Buffer.from(v); return Buffer.concat([head(3, b.length), b]); }
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  throw new Error('cbor: ' + typeof v);
}
// --- a software authenticator ---
export function authenticator(kind = 'es256') {
  const { privateKey, publicKey } = kind === 'ed25519' ? crypto.generateKeyPairSync('ed25519') : crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const cose = kind === 'ed25519' ? new Map([[1, 1], [3, -8], [-1, 6], [-2, Buffer.from(jwk.x, 'base64url')]])
    : new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]);
  const credId = crypto.randomBytes(16); let count = 0;
  const authData = (rpId, flags, withCred) => { const c = Buffer.alloc(4); c.writeUInt32BE(count);
    const parts = [sha(Buffer.from(rpId)), Buffer.from([flags]), c];
    if (withCred) { const l = Buffer.alloc(2); l.writeUInt16BE(credId.length); parts.push(Buffer.alloc(16), l, credId, cbor(cose)); }
    return Buffer.concat(parts); };
  return {
    id: b64u(credId),
    create(challenge, origin, rpId, o = {}) { const cdj = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge, origin, crossOrigin: false }));
      const ao = cbor(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData(rpId, o.flags ?? 0x45, true)]]));
      return { id: b64u(credId), rawId: b64u(credId), type: 'public-key', response: { clientDataJSON: b64u(cdj), attestationObject: b64u(ao) } }; },
    get(challenge, origin, rpId, o = {}) { count += o.countStep ?? 1;
      const cdj = Buffer.from(JSON.stringify({ type: o.type || 'webauthn.get', challenge, origin, crossOrigin: false }));
      const ad = authData(rpId, o.flags ?? 0x05, false), data = Buffer.concat([ad, sha(cdj)]);
      let sig = kind === 'ed25519' ? crypto.sign(null, data, privateKey) : crypto.sign('sha256', data, privateKey);
      if (o.tamper) { sig = Buffer.from(sig); sig[sig.length - 1] ^= 1; }
      return { id: b64u(credId), rawId: b64u(credId), type: 'public-key', response: { clientDataJSON: b64u(cdj), authenticatorData: b64u(ad), signature: b64u(sig), userHandle: null } }; },
    setCount(n) { count = n; },
  };
}
