// Two-factor sign-in for the admin panel (/api/social/admin/*) — zero dependencies, Node's crypto only.
//
// The first factor is unchanged: the owner's AUTH_TOKEN, or an admin member's own Pulse key. When
// two-factor applies to that person, every admin route also needs a short-lived admin session: an
// HttpOnly, SameSite=Strict cookie (Secure over https) scoped to /api/social/admin, issued after a
// passkey assertion, an authenticator-app code (RFC 6238 TOTP: SHA-1, 30 s, 6 digits) or a one-time
// recovery code. The cookie alone opens nothing: the first factor still has to come with it.
//
// Nothing else is gated: /api/v1, /api/data, backups, the CLI and every other AUTH_TOKEN use carry on
// with the token alone.
//
// ADMIN_2FA (env, or opts.mode):
//   optional (default) — each person chooses: adding a passkey or an authenticator app switches it on
//                        for them. The owner can also require it of every admin (policy.requireAdmins).
//   required           — everyone (owner and admins) needs it; someone with nothing set up yet can only
//                        set a factor up, and the panel opens once they have.
//   off                — never asked for; factors already set up are kept for when it's switched back on.
//
// Escape hatch, when the owner has lost every factor: `node server.js --reset-admin-2fa`, or start the
// server once with ADMIN_2FA_RESET set (to any value — each value resets once, so leaving it set does
// nothing on later restarts). Either clears the owner's factors and every admin session; admins keep
// theirs (the owner resets an admin's from the panel).
//
// Stored in DATA_DIR/admin-2fa.json (mode 0600): passkey public keys, TOTP secrets, SHA-256 hashes of
// the recovery codes and of the session tokens. A file that can't be read closes the admin panel
// (503) rather than dropping everyone's second factor.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const WebAuthn = require('./webauthn.js');

const FILE = 'admin-2fa.json';
const COOKIE = 'pz_admin2fa';
const SESSION_MS = 12 * 3600000;
const PASSKEY_MAX = 10;
const RECOVERY_N = 10;
const CODE_FAIL_MAX = 5;          // wrong codes per person inside the window before codes are locked…
const CODE_FAIL_WINDOW = 10 * 60000;
const CODE_LOCK_CAP = 24 * 3600000; // …for AUTH_LOCK_MIN, doubling with each lock, up to a day
const TOTP_STEP = 30, TOTP_DIGITS = 6;

const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');

// ---- RFC 4648 base32 (no padding), for TOTP secrets ----
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function b32encode(buf) {
  let bits = 0, v = 0, out = '';
  for (const b of buf) { v = ((v << 8) | b) & 0xfff; bits += 8; while (bits >= 5) { out += B32[(v >>> (bits - 5)) & 31]; bits -= 5; } }
  if (bits > 0) out += B32[(v << (5 - bits)) & 31];
  return out;
}
function b32decode(s) {
  const str = String(s).toUpperCase().replace(/[\s=-]/g, ''), out = [];
  let bits = 0, v = 0;
  for (const c of str) { const i = B32.indexOf(c); if (i < 0) throw new Error('bad base32');
    v = ((v << 5) | i) & 0xfff; bits += 5; if (bits >= 8) { out.push((v >>> (bits - 8)) & 255); bits -= 8; } }
  return Buffer.from(out);
}

// ---- RFC 4226 HOTP / RFC 6238 TOTP ----
function hotp(key, counter, digits = TOTP_DIGITS, algo = 'sha1') {
  const c = Buffer.alloc(8); c.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac(algo, key).update(c).digest(), o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 10 ** digits).padStart(digits, '0');
}
const totpStep = (ms, step = TOTP_STEP) => Math.floor(ms / 1000 / step);
const totp = (key, ms, o = {}) => hotp(key, totpStep(ms, o.step), o.digits, o.algo);
// the step a code belongs to (this one, or one either side for clock drift), or -1; never a step at
// or before `after`, so a code that worked once can't be replayed
function totpMatch(key, code, ms, after) {
  if (!/^\d{6}$/.test(code)) return -1;
  const now = totpStep(ms);
  for (const s of [now, now - 1, now + 1]) {
    if (s <= (after == null ? -1 : after)) continue;
    const want = hotp(key, s);
    if (crypto.timingSafeEqual(Buffer.from(want), Buffer.from(code))) return s;
  }
  return -1;
}
function otpauthUri(secret, account, issuer) {
  const label = encodeURIComponent(issuer) + ':' + encodeURIComponent(account);
  return 'otpauth://totp/' + label + '?secret=' + secret + '&issuer=' + encodeURIComponent(issuer) + '&algorithm=SHA1&digits=6&period=30';
}

// recovery codes: 10 characters from an alphabet without look-alikes (≈50 bits), shown as xxxxx-xxxxx
const RC_ABC = 'abcdefghjkmnpqrstuvwxyz23456789';
const recoveryCode = () => { let s = ''; for (const b of crypto.randomBytes(10)) s += RC_ABC[b % RC_ABC.length]; return s.slice(0, 5) + '-' + s.slice(5); };
const normRecovery = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const recoveryHash = (u, code) => sha('rc:' + u + ':' + normRecovery(code));

const parseMode = v => {
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (!s || s === 'optional') return { mode: 'optional' };
  if (/^(required|require|on|1|true|yes)$/.test(s)) return { mode: 'required' };
  if (/^(off|0|false|no|none)$/.test(s)) return { mode: 'off' };
  return { mode: 'required', warn: 'ADMIN_2FA="' + s.slice(0, 20) + '" isn’t one of required, optional or off — treating it as required' };
};

// ---- the store ----
const emptyStore = () => ({ v: 1, users: {}, sessions: {}, policy: { requireAdmins: false } });
function loadStore(dataDir) {
  const f = path.join(dataDir, FILE);
  let raw; try { raw = fs.readFileSync(f, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return emptyStore(); throw e; }
  const s = JSON.parse(raw);
  if (!s || typeof s !== 'object' || s.v !== 1) throw new Error('unrecognised contents');
  if (!s.users || typeof s.users !== 'object') s.users = {};
  if (!s.sessions || typeof s.sessions !== 'object') s.sessions = {};
  if (!s.policy || typeof s.policy !== 'object') s.policy = { requireAdmins: false };
  return s;
}
function writeStore(dataDir, s) {
  const f = path.join(dataDir, FILE), tmp = f + '.tmp';
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 });
  fs.renameSync(tmp, f);
}
// the owner's factors and every session go; admins' factors and the policy stay
function resetOwner(dataDir, mark) {
  let s; try { s = loadStore(dataDir); } catch (e) { s = emptyStore(); } // a damaged file is replaced
  const had = !!s.users.owner;
  delete s.users.owner; s.sessions = {};
  if (mark) s.resetUsed = mark;
  writeStore(dataDir, s);
  return { had };
}

function create(opts) {
  const dataDir = opts.dataDir, now = opts.now || (() => Date.now());
  const pm = parseMode(opts.mode); if (pm.warn) console.warn('[ledger] ' + pm.warn);
  const mode = pm.mode;
  const sessionMs = opts.sessionMs || SESSION_MS;
  const lockMs = opts.lockMs || 15 * 60000;
  const lockedOut = opts.lockedOut || (() => false), noteBad = opts.noteBadToken || (() => {});
  const json = opts.json;

  let S = null, broken = null;
  try { S = loadStore(dataDir); } catch (e) { broken = e.message; console.error('[ledger] ' + path.join(dataDir, FILE) + ' could not be read (' + e.message + '): the admin panel is closed until it is fixed, or run `node server.js --reset-admin-2fa`'); }
  // ADMIN_2FA_RESET: once per value
  if (opts.reset) {
    const mark = sha('reset:' + opts.reset);
    if (broken || !S || S.resetUsed !== mark) {
      const r = resetOwner(dataDir, mark); S = loadStore(dataDir); broken = null;
      console.warn('[ledger] ADMIN_2FA_RESET: the owner’s admin two-factor was ' + (r.had ? 'cleared' : 'already clear') + ' and every admin session ended. Remove ADMIN_2FA_RESET from the environment now.');
    }
  }
  const save = () => {
    const t = now();
    for (const [k, v] of Object.entries(S.sessions)) if (!v || v.exp <= t) delete S.sessions[k];
    const ks = Object.keys(S.sessions); // a bounded list: the oldest go first
    if (ks.length > 500) ks.sort((a, b) => S.sessions[a].at - S.sessions[b].at).slice(0, ks.length - 500).forEach(k => delete S.sessions[k]);
    writeStore(dataDir, S);
  };
  const userOf = u => S.users[u] || null;
  const ensureUser = u => S.users[u] || (S.users[u] = { passkeys: [], totp: null, recovery: [] });
  const enrolled = u => { const x = userOf(u); return !!(x && ((x.passkeys || []).length || x.totp)); };
  // must this person have a second factor, whether or not they've set one up?
  const mustEnroll = u => mode === 'required' || (mode === 'optional' && u !== 'owner' && !!S.policy.requireAdmins);
  const needs = u => mode !== 'off' && (enrolled(u) || mustEnroll(u));

  // ---- sessions ----
  const cookieOf = req => { const m = /(?:^|;\s*)pz_admin2fa=([A-Za-z0-9_-]{20,100})/.exec(req.headers.cookie || ''); return m ? m[1] : null; };
  const sessionFor = (req, u) => { const tk = cookieOf(req); if (!tk) return null; const s = S.sessions[sha(tk)];
    return s && s.u === u && s.exp > now() ? s : null; };
  const secureReq = (req, site) => !!(req.socket && req.socket.encrypted) || !!(site && /^https:/.test(site.origin || ''));
  const cookie = (req, site, val, maxAge) => COOKIE + '=' + val + '; Path=/api/social/admin; Max-Age=' + maxAge + '; HttpOnly; SameSite=Strict' + (secureReq(req, site) ? '; Secure' : '');
  function issue(req, res, u, site, how) {
    const tk = crypto.randomBytes(32).toString('base64url'), t = now();
    S.sessions[sha(tk)] = { u, at: t, exp: t + sessionMs, how };
    save();
    res.setHeader('Set-Cookie', cookie(req, site, tk, Math.floor(sessionMs / 1000)));
    return t + sessionMs;
  }
  const endSessions = u => { for (const [k, v] of Object.entries(S.sessions)) if (v.u === u) delete S.sessions[k]; };

  // ---- wrong codes: per person (on top of the server's per-address lockout) ----
  const fails = new Map(); // u -> {n, since, until, locks}
  const codeLock = u => { const f = fails.get(u); return f && f.until > now() ? f.until : 0; };
  const codeFailed = (req, u) => {
    noteBad(req);
    const t = now(); let f = fails.get(u);
    if (!f) { f = { n: 0, since: t, until: 0, locks: 0 }; fails.set(u, f); }
    if (t - f.since > CODE_FAIL_WINDOW || (f.until && f.until <= t)) { f.n = 0; f.since = t; f.until = 0; }
    if (++f.n >= CODE_FAIL_MAX) { f.until = t + Math.min(CODE_LOCK_CAP, lockMs * 2 ** f.locks); f.locks++; f.n = 0;
      console.warn('[ledger] admin two-factor: ' + CODE_FAIL_MAX + ' wrong codes for ' + u + ' — codes locked for ' + Math.round((f.until - t) / 60000) + ' min'); }
  };

  const info = u => { const x = userOf(u) || {};
    return { mode, enrolled: enrolled(u), enroll: !enrolled(u), methods: { passkey: (x.passkeys || []).length > 0, totp: !!x.totp, recovery: (x.recovery || []).length > 0 } }; };
  const refuse = (res, u) => json(res, 401, { error: enrolled(u) ? 'Confirm it’s you with your second factor.' : 'Two-factor is required for the admin panel. Set up a passkey or an authenticator app first.', twofa: info(u) });
  const pending = new Map(); // challenge -> {purpose, u, site, exp}; and 'totp:'+u -> {secret, exp}
  const sweep = () => { for (const [k, v] of pending) if (v.exp < now()) pending.delete(k); while (pending.size > 2000) pending.delete(pending.keys().next().value); };
  const newRecovery = u => { const codes = Array.from({ length: RECOVERY_N }, recoveryCode); ensureUser(u).recovery = codes.map(c => recoveryHash(u, c)); userOf(u).recoveryAt = now(); return codes; };
  const pkOut = k => ({ id: k.id, name: k.name, at: k.at, lastUsed: k.lastUsed || null });
  const summary = u => { const x = userOf(u) || {}; return { on: enrolled(u), passkeys: (x.passkeys || []).length, totp: !!x.totp, recoveryLeft: (x.recovery || []).length }; };
  const allPasskeyIds = () => new Set(Object.values(S.users).flatMap(x => (x.passkeys || []).map(k => k.id)));

  // ctx: {parts (after 'admin'), M, body, siteOf(req), admins() → [{id, handle}], log(what)}
  // returns true when it answered the request
  function gate(req, res, who, ctx) {
    if (broken) { json(res, 503, { error: 'The admin two-factor file (' + FILE + ') could not be read. Fix it, or reset two-factor with `node server.js --reset-admin-2fa`.' }); return true; }
    const u = who.owner ? 'owner' : 'm:' + who.id, parts = ctx.parts;
    if (parts[0] !== '2fa') {
      if (!needs(u) || sessionFor(req, u)) return false;
      refuse(res, u); return true;
    }
    route(req, res, who, u, ctx);
    return true;
  }

  function route(req, res, who, u, ctx) {
    const M = ctx.M, body = ctx.body || {}, a = ctx.parts[1] || '', b = ctx.parts[2] || '';
    const sess = sessionFor(req, u), x = userOf(u);
    const log = what => { try { ctx.log && ctx.log('two-factor: ' + what); } catch (e) {} };

    // ---- open with the first factor alone: proving the second, and signing out ----
    if (a === 'logout' && M === 'POST') {
      const tk = cookieOf(req); if (tk) { const k = sha(tk); if (S.sessions[k] && S.sessions[k].u === u) { delete S.sessions[k]; save(); } }
      res.setHeader('Set-Cookie', cookie(req, ctx.siteOf(req), '', 0));
      return json(res, 200, { ok: true });
    }
    if (a === 'verify') {
      if (M !== 'POST') return json(res, 405, { error: 'method not allowed' });
      if (lockedOut(req)) { res.setHeader('Retry-After', String(Math.ceil(lockMs / 1000))); return json(res, 429, { error: 'Too many wrong attempts from this address. Try again in a few minutes.' }); }
      if (!enrolled(u)) return json(res, 400, { error: 'You haven’t set up a second factor yet.', twofa: info(u) });
      const site = ctx.siteOf(req);
      if (b === 'start') { // a passkey challenge for this person's admin passkeys
        if (site.error) return json(res, 400, { error: site.error });
        if (!x.passkeys.length) return json(res, 400, { error: 'You have no admin passkey. Use your authenticator app or a recovery code.' });
        sweep(); const challenge = WebAuthn.newChallenge();
        pending.set('pk:' + challenge, { purpose: 'verify', u, site, exp: now() + 5 * 60000 });
        return json(res, 200, { challenge, rpId: site.rpId, timeout: 300000, userVerification: 'preferred', allowCredentials: x.passkeys.map(k => ({ type: 'public-key', id: k.id })) });
      }
      if (b) return json(res, 404, { error: 'not found' });
      let how = null;
      if (body.credential) {
        const cred = body.credential; let cd = null;
        try { cd = JSON.parse(WebAuthn.fromB64u(cred.response.clientDataJSON).toString('utf8')); } catch (e) {}
        const p = cd && typeof cd.challenge === 'string' ? pending.get('pk:' + cd.challenge) : null;
        if (!p || p.purpose !== 'verify' || p.u !== u || p.exp < now()) return json(res, 400, { error: 'That request expired. Try again.' });
        pending.delete('pk:' + cd.challenge);
        const pk = x.passkeys.find(k => k.id === cred.id);
        try { if (!pk) throw new Error('not one of your admin passkeys');
          const r = WebAuthn.verifyAssertion(cred, { challenge: cd.challenge, origin: p.site.origin, rpId: p.site.rpId }, pk); pk.signCount = r.signCount; pk.lastUsed = now(); how = 'passkey'; }
        catch (e) { noteBad(req); return json(res, 401, { error: 'That passkey didn’t check out (' + e.message + ').' }); }
      } else {
        const lock = codeLock(u);
        if (lock) { res.setHeader('Retry-After', String(Math.max(1, Math.ceil((lock - now()) / 1000)))); return json(res, 429, { error: 'Too many wrong codes. Try again later, or use a passkey.' }); }
        const code = String(body.code || '').replace(/\s/g, '').slice(0, 40);
        if (x.totp && /^\d{6}$/.test(code)) {
          const s = totpMatch(b32decode(x.totp.secret), code, now(), x.totp.lastStep);
          if (s >= 0) { x.totp.lastStep = s; how = 'totp'; }
        } else if (normRecovery(code).length === 10) {
          const h = recoveryHash(u, code), i = (x.recovery || []).indexOf(h);
          if (i >= 0) { x.recovery.splice(i, 1); how = 'recovery'; }
        }
        if (!how) { codeFailed(req, u); return json(res, 401, { error: 'That code didn’t work.' }); }
        fails.delete(u);
      }
      const until = issue(req, res, u, site, how);
      if (how === 'recovery') log('signed in with a recovery code (' + x.recovery.length + ' left)');
      return json(res, 200, { ok: true, until, how, recoveryLeft: (x.recovery || []).length });
    }

    // ---- everything else: managing factors. Needs the session when two-factor applies to this
    // person — except to set up a first factor when it's required and they have none yet.
    const may = !needs(u) || !!sess || !enrolled(u);
    if (!may) return refuse(res, u);
    const site = ctx.siteOf(req);
    // a person's first factor opens the panel right away (they just proved it)
    const settle = (how, out) => { const first = !(x && (x.recovery || []).length) && enrolled(u);
      if (first) out.recovery = newRecovery(u);
      if (!sess && needs(u)) out.until = issue(req, res, u, site, how); else save();
      return out; };
    const status = () => {
      const y = userOf(u) || {}, out = { mode, owner: !!who.owner, required: mustEnroll(u) && mode !== 'off', on: enrolled(u), active: needs(u),
        session: sess ? { until: sess.exp, how: sess.how } : null,
        passkeys: (y.passkeys || []).map(pkOut), totp: y.totp ? { at: y.totp.at } : null, recoveryLeft: (y.recovery || []).length, recoveryAt: y.recoveryAt || null,
        policy: { requireAdmins: !!S.policy.requireAdmins } };
      if (who.owner) { out.ownerOn = enrolled('owner'); out.admins = ctx.admins().map(m => Object.assign({ id: m.id, handle: m.handle }, summary('m:' + m.id))); }
      return out; };

    if (!a && M === 'GET') return json(res, 200, status());
    const offMsg = () => json(res, 403, { error: 'Two-factor is switched off on this server (ADMIN_2FA=off).' });

    if (a === 'passkey' && M === 'POST' && (b === 'start' || b === 'finish')) {
      if (mode === 'off') return offMsg();
      if (site.error) return json(res, 400, { error: site.error });
      if (b === 'start') {
        if (x && x.passkeys.length >= PASSKEY_MAX) return json(res, 409, { error: 'You have ' + PASSKEY_MAX + ' admin passkeys already. Remove one first.' });
        sweep(); const challenge = WebAuthn.newChallenge();
        pending.set('pk:' + challenge, { purpose: 'reg', u, site, exp: now() + 5 * 60000 });
        const name = who.owner ? 'owner' : who.name;
        return json(res, 200, { challenge, rp: { name: 'Keel admin', id: site.rpId }, user: { id: WebAuthn.b64u(Buffer.from('admin:' + u)), name: 'admin ' + name, displayName: 'Keel admin · ' + (who.owner ? 'Owner' : who.name) },
          pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -8 }, { type: 'public-key', alg: -257 }],
          // not a discoverable credential: it's only ever asked for by id, as the second step
          authenticatorSelection: { residentKey: 'discouraged', requireResidentKey: false, userVerification: 'preferred' }, attestation: 'none', timeout: 300000,
          excludeCredentials: (x ? x.passkeys : []).map(k => ({ type: 'public-key', id: k.id })) });
      }
      const cred = body.credential; let cd = null;
      try { cd = JSON.parse(WebAuthn.fromB64u(cred.response.clientDataJSON).toString('utf8')); } catch (e) {}
      const p = cd && typeof cd.challenge === 'string' ? pending.get('pk:' + cd.challenge) : null;
      if (!p || p.purpose !== 'reg' || p.u !== u || p.exp < now()) return json(res, 400, { error: 'That request expired. Try again.' });
      pending.delete('pk:' + cd.challenge);
      let r; try { r = WebAuthn.verifyRegistration(cred, { challenge: cd.challenge, origin: p.site.origin, rpId: p.site.rpId }); }
      catch (e) { return json(res, 400, { error: 'That passkey couldn’t be added (' + e.message + ').' }); }
      if (allPasskeyIds().has(r.id)) return json(res, 409, { error: 'That passkey is already added.' });
      const y = ensureUser(u), nm = String(body.name || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 40) || 'Passkey';
      y.passkeys = [...y.passkeys, { id: r.id, alg: r.alg, jwk: r.jwk, signCount: r.signCount, rpId: p.site.rpId, name: nm, at: now(), lastUsed: null }].slice(-PASSKEY_MAX);
      log('added an admin passkey');
      return json(res, 200, settle('passkey', { ok: true }));
    }
    if (a === 'totp' && M === 'POST' && (b === 'start' || b === 'finish')) {
      if (mode === 'off') return offMsg();
      if (b === 'start') {
        if (x && x.totp) return json(res, 409, { error: 'An authenticator app is already set up. Remove it first to switch to another.' });
        const secret = b32encode(crypto.randomBytes(20)); sweep();
        pending.set('totp:' + u, { secret, exp: now() + 10 * 60000 });
        const host = site.rpId || 'Keel';
        return json(res, 200, { secret, uri: otpauthUri(secret, (who.owner ? 'owner' : who.name) + '@' + host, 'Keel admin') });
      }
      const p = pending.get('totp:' + u);
      if (!p || p.exp < now()) return json(res, 400, { error: 'That setup expired. Start again.' });
      const lock = codeLock(u);
      if (lock) { res.setHeader('Retry-After', String(Math.max(1, Math.ceil((lock - now()) / 1000)))); return json(res, 429, { error: 'Too many wrong codes. Try again later.' }); }
      const s = totpMatch(b32decode(p.secret), String(body.code || '').replace(/\s/g, ''), now(), null);
      if (s < 0) { codeFailed(req, u); return json(res, 400, { error: 'That code didn’t match. Check the time on your phone, then try the next code.' }); }
      pending.delete('totp:' + u);
      ensureUser(u).totp = { secret: p.secret, at: now(), lastStep: s };
      log('set up an authenticator app');
      return json(res, 200, settle('totp', { ok: true }));
    }
    // removing a factor: never the last one while two-factor is required of this person
    const lastOne = () => mustEnroll(u) && mode !== 'off' && ((x.passkeys || []).length + (x.totp ? 1 : 0)) <= 1;
    const afterRemove = () => { if (!enrolled(u)) { x.recovery = []; delete x.recoveryAt; endSessions(u); res.setHeader('Set-Cookie', cookie(req, site, '', 0)); } save(); };
    if (a === 'passkey' && b && M === 'DELETE') {
      const i = x ? x.passkeys.findIndex(k => k.id === b) : -1;
      if (i < 0) return json(res, 404, { error: 'No such passkey.' });
      if (lastOne()) return json(res, 409, { error: 'Two-factor is required here. Add another passkey or an authenticator app before removing this one.' });
      x.passkeys.splice(i, 1); afterRemove(); log('removed an admin passkey');
      return json(res, 200, status());
    }
    if (a === 'totp' && !b && M === 'DELETE') {
      if (!x || !x.totp) return json(res, 404, { error: 'No authenticator app is set up.' });
      if (lastOne()) return json(res, 409, { error: 'Two-factor is required here. Add a passkey before removing the authenticator app.' });
      x.totp = null; afterRemove(); log('removed the authenticator app');
      return json(res, 200, status());
    }
    if (a === 'recovery' && M === 'POST') {
      if (!enrolled(u)) return json(res, 400, { error: 'Set up a passkey or an authenticator app first.' });
      const codes = newRecovery(u); save(); log('made new recovery codes');
      return json(res, 200, { recovery: codes });
    }
    // ---- the owner: require it of every admin; reset an admin who lost their factors ----
    if (a === 'policy' && M === 'PUT') {
      if (!who.owner) return json(res, 403, { error: 'Only the owner can change this.' });
      S.policy.requireAdmins = !!body.requireAdmins; save();
      log(S.policy.requireAdmins ? 'required for every admin' : 'no longer required for every admin');
      return json(res, 200, status());
    }
    if (a === 'admins' && b && M === 'DELETE') {
      if (!who.owner) return json(res, 403, { error: 'Only the owner can reset another admin’s two-factor.' });
      const k = 'm:' + b; if (!S.users[k]) return json(res, 404, { error: 'That admin has no two-factor set up.' });
      const m = ctx.admins().find(z => z.id === b) || null;
      delete S.users[k]; endSessions(k); fails.delete(k); save();
      log('reset ' + (m ? '@' + m.handle + '’s' : 'an admin’s') + ' second factors');
      return json(res, 200, status());
    }
    return json(res, 404, { error: 'not found' });
  }

  return { gate, mode, reset: () => { resetOwner(dataDir); S = loadStore(dataDir); broken = null; fails.clear(); }, state: () => S };
}

module.exports = { create, resetOwner, parseMode, hotp, totp, totpMatch, b32encode, b32decode, otpauthUri, recoveryCode, normRecovery, FILE, COOKIE };
