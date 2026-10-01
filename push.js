'use strict';
// Web push without dependencies: the server's VAPID identity (RFC 8292), message encryption
// (RFC 8291, aes128gcm content coding from RFC 8188) and the POST to the browser's push service.
// Payloads are small JSON objects ({title, body, url, tag}); the service worker shows them.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const b64u = buf => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = s => Buffer.from(String(s || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

// The server's push identity, made once and kept in DATA_DIR/vapid.json. publicKey is the raw
// uncompressed P-256 point, base64url — what browsers take as applicationServerKey.
function loadVapid(dataDir, subject) {
  const file = path.join(dataDir, 'vapid.json');
  let jwk = null, raw = null;
  try { raw = fs.readFileSync(file, 'utf8'); }
  // there but unreadable (permissions): never replace it — push stays off until it can be read
  catch (e) { if (e.code !== 'ENOENT') throw new Error('can’t read ' + file + ' (' + e.code + ')'); }
  if (raw != null) try { jwk = JSON.parse(raw); } catch (e) {}
  if (!jwk || jwk.kty !== 'EC' || !jwk.d) {
    // a file that's there but unreadable is kept aside (not overwritten) so the owner can recover it
    if (raw != null) { const aside = file + '.unreadable-' + Date.now(); try { fs.renameSync(file, aside); } catch (e) {}
      console.warn('[ledger] ' + file + ' could not be read; moved it to ' + aside + ' and made new push keys (devices turn reminders on again)'); }
    jwk = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ format: 'jwk' });
    // a key that isn't kept means every device has to subscribe again after the next restart
    try { fs.writeFileSync(file + '.tmp', JSON.stringify(jwk), { mode: 0o600 }); fs.renameSync(file + '.tmp', file); }
    catch (e) { console.warn('[ledger] couldn’t save push keys to ' + file + ' (' + e.message + '): reminders stop after a restart until devices turn them on again'); }
  }
  const privateKey = crypto.createPrivateKey({ key: jwk, format: 'jwk' });
  const publicKey = b64u(Buffer.concat([Buffer.from([4]), unb64u(jwk.x), unb64u(jwk.y)]));
  return { privateKey, publicKey, subject: subject || 'mailto:pulse@localhost' };
}

// RFC 8292: a JWT signed with the server key, for the push service's origin, valid 12 hours
function vapidAuth(endpoint, vapid, nowMs) {
  const aud = new URL(endpoint).origin;
  const head = b64u(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64u(JSON.stringify({ aud, exp: Math.floor((nowMs || Date.now()) / 1000) + 12 * 3600, sub: vapid.subject }));
  const sig = crypto.sign('sha256', Buffer.from(head + '.' + claims), { key: vapid.privateKey, dsaEncoding: 'ieee-p1363' });
  return 'vapid t=' + head + '.' + claims + '.' + b64u(sig) + ', k=' + vapid.publicKey;
}

// RFC 8291: encrypt one message for one subscription (keys.p256dh, keys.auth). One record; the
// 0x02 delimiter marks it as the last. salt and the sender key pair are fresh per message —
// tests pass them in to check against a known decryption.
function encrypt(payload, keys, fixed) {
  const uaPublic = unb64u(keys.p256dh), authSecret = unb64u(keys.auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error('bad p256dh key');
  if (authSecret.length < 16) throw new Error('bad auth secret');
  const ecdh = crypto.createECDH('prime256v1');
  if (fixed && fixed.senderPrivate) ecdh.setPrivateKey(fixed.senderPrivate); else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const secret = ecdh.computeSecret(uaPublic);
  const salt = fixed && fixed.salt || crypto.randomBytes(16);
  const prkKey = hmac(authSecret, secret);
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const c = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([c.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), c.final(), c.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

// The browsers' push services. A subscription can only point at one of them, so the server never
// POSTs to an address a member made up (an internal host, a metadata service, a port scan).
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^updates\.push\.services\.mozilla\.com$/, /^[a-z0-9-]+\.push\.services\.mozilla\.com$/,
  /^web\.push\.apple\.com$/, /^[a-z0-9-]+\.push\.apple\.com$/, /^[a-z0-9-]+\.notify\.windows\.com$/, /^android\.googleapis\.com$/];
const pushHostOk = host => PUSH_HOSTS.some(re => re.test(String(host).toLowerCase()));
// A subscription the browser handed us: an https endpoint at a push service, and its two keys
function sanitizeSubscription(s) {
  if (!s || typeof s !== 'object') return null;
  let u; try { u = new URL(String(s.endpoint || '')); } catch (e) { return null; }
  if (u.protocol !== 'https:' || u.port || u.username || String(s.endpoint).length > 1000 || !pushHostOk(u.hostname)) return null;
  const k = s.keys || {};
  if (typeof k.p256dh !== 'string' || typeof k.auth !== 'string' || k.p256dh.length > 200 || k.auth.length > 100) return null;
  if (unb64u(k.p256dh).length !== 65 || unb64u(k.auth).length < 16) return null;
  return { endpoint: u.href, keys: { p256dh: k.p256dh, auth: k.auth } };
}

// Sends one message. Resolves to the push service's status; 404/410 mean the subscription is
// gone and the caller should drop it.
async function send(fetchImpl, sub, message, vapid, opts) {
  opts = opts || {};
  const body = encrypt(JSON.stringify(message).slice(0, 3000), sub.keys);
  if (!sanitizeSubscription(sub)) return 410; // not a push service: treated as gone
  const r = await fetchImpl(sub.endpoint, { method: 'POST', body, signal: opts.signal, redirect: 'manual',
    headers: { 'Content-Type': 'application/octet-stream', 'Content-Encoding': 'aes128gcm', TTL: String(opts.ttl || 4 * 3600),
      Urgency: opts.urgency || 'normal', Authorization: vapidAuth(sub.endpoint, vapid, opts.now) } });
  try { if (r.body && r.arrayBuffer) await r.arrayBuffer(); } catch (e) {} // free the connection
  return r.status;
}

module.exports = { loadVapid, vapidAuth, encrypt, send, sanitizeSubscription, pushHostOk, b64u, unb64u };
