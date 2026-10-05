// Private beta mode (social.js, beta.html, admin-beta-ui.js): while it's on, the journal, Daruma and their
// scripts open only for an activated profile or the owner; everyone else gets the beta page. Invites are
// single use; page access rides on an HttpOnly cookie that a sign-out, suspension, deletion or "sign out
// everywhere" ends at once. Switched off, everything is as it was. Also: names are unique whatever their
// capitals, and an admin can reset a member's passkeys or sign them out of every device.
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { t, ok, eq, report } from './harness.mjs';

const require = createRequire(import.meta.url);
const server = require('../server.js');
const S = require('../social.js');
const htmlPath = new URL('../ledger.html', import.meta.url).pathname;
const fetchImpl = async () => ({ ok: true, status: 200, json: async () => [] });
let clock = Date.parse('2026-10-05T12:00:00Z');
const dataDir = mkdtempSync(join(tmpdir(), 'ledger-beta-'));
const mk = () => server.createApp({ dataDir, auth: 'owner-token', htmlPath, fetchImpl, now: () => clock, push: false, pushTick: false, offsiteTimer: false });
const listen = app => new Promise(res => app.listen(0, () => res('http://127.0.0.1:' + app.address().port)));
let app = mk(), B = await listen(app);

const call = async (p, o = {}) => { const r = await fetch(B + '/api/social' + p, { method: o.method || (o.body !== undefined ? 'POST' : 'GET'),
    headers: { 'Content-Type': 'application/json', ...(o.key ? { 'X-Pulse-Key': o.key } : {}), ...(o.admin ? { Authorization: 'Bearer owner-token' } : {}),
      ...(o.cookie ? { Cookie: o.cookie } : {}), ...(o.headers || {}) }, body: o.body !== undefined ? JSON.stringify(o.body) : undefined });
  const sc = r.headers.get('set-cookie'); return { status: r.status, d: await r.json().catch(() => ({})), cookie: sc ? sc.split(';')[0] : null, setCookie: sc }; };
// a page as a browser opens it: no member key header, only the cookie
const page = async (p, cookie) => { const r = await fetch(B + p, { redirect: 'manual', headers: cookie ? { Cookie: cookie } : {} });
  const body = await r.text(); return { status: r.status, gate: r.headers.get('x-beta-gate') === '1', location: r.headers.get('location'), body }; };
const admin = (p, o = {}) => call('/admin' + p, { ...o, admin: true });
const codeOf = c => c.replace(/-/g, '');

try {
  let oldKey, oldId;
  await t('beta mode starts off: the app opens for anyone, joining is as before, /join goes to Daruma', async () => {
    eq(S.sanitizeBetaCfg(null, null), { on: false, keepExisting: true, publicDocs: true, ttlDays: 14, message: '', since: 0, by: '' });
    eq((await call('/config')).d.beta, { on: false });
    const p = await page('/'); eq(p.status, 200); ok(!p.gate, 'the app, not the beta page');
    eq((await page('/app/core.js')).status, 200);
    const j = await page('/join'); eq(j.status, 302); eq(j.location, '/daruma');
    const r = await call('/join', { body: { handle: 'early' } }); eq(r.status, 200); oldKey = r.d.key; oldId = r.d.me.id;
    ok(/^daruma_access=m\./.test(r.cookie) && /HttpOnly/.test(r.setCookie) && /SameSite=Lax/.test(r.setCookie), 'a sign-in sets the access cookie, ready for beta mode');
  });

  await t('only the owner and admins switch it on; the switch is logged, with who and when', async () => {
    eq((await call('/admin/beta', { method: 'PUT', body: { on: true } })).status, 401);
    eq((await admin('/beta', { method: 'PUT', body: { ttlDays: 400 } })).status, 400, 'invites last 1 to 90 days');
    const r = await admin('/beta', { method: 'PUT', body: { on: true, message: 'Ask @owner on Telegram for an invite.' } });
    eq(r.status, 200); eq(r.d.config.on, true); eq(r.d.config.since, clock); eq(r.d.config.by, 'owner');
    eq((await call('/config')).d.beta, { on: true, message: 'Ask @owner on Telegram for an invite.' });
    eq((await call('/config')).d.inviteRequired, true, 'the app’s own join form asks for a code');
    ok((await admin('/log')).d.log.some(l => /^PUT beta/.test(l.what)));
  });

  await t('outsiders get the beta page for the journal and Daruma, and no app code', async () => {
    for (const p of ['/', '/index.html', '/ledger.html', '/daruma', '/keel', '/pulse', '/join']) {
      const r = await page(p); eq(r.status, 200, p); ok(r.gate, p + ' is the beta page'); ok(r.body.includes('Daruma is invite-only for now'), p); }
    eq((await page('/app/core.js')).status, 403); eq((await page('/app/pulse-social.js?v=1')).status, 403);
    eq((await page('/app/fonts/inter-400.woff2')).status, 200, 'the beta page’s fonts stay open');
    ok(!(await page('/admin')).gate, 'the admin panel is never behind it');
    ok(!(await page('/help')).gate, 'the docs stay public by default');
    const sw = await page('/sw.js'); eq(sw.status, 200);
    ok(sw.body.includes("r.ok&&!r.headers.get('x-beta-gate')"), 'the service worker never keeps the beta page as the app shell');
    ok(sw.body.includes("if(!r.headers.get('x-beta-gate'))return c.put('/',r)") && !sw.body.includes("c.add('/')"), 'nor when it installs');
  });

  await t('what a visitor without a profile sends waits for an invite; open joining and the shared code stop', async () => {
    eq((await call('/visit', { body: {} })).status, 403);
    eq((await call('/seen', { body: { addresses: [] } })).status, 403);
    eq((await call('/ref/early')).status, 403);
    const j = await call('/join', { body: { handle: 'sneaky' } }); eq(j.status, 403); eq(j.d.state, 'unknown');
    await admin('/config', { method: 'PUT', body: { inviteCode: 'SHARED' } });
    eq((await call('/join', { body: { handle: 'sneaky', invite: 'SHARED' } })).status, 403, 'the league’s shared code doesn’t open the beta');
    await admin('/config', { method: 'PUT', body: { inviteCode: '' } });
  });

  let inv, inv2, newKey, newCookie;
  await t('invites: made in a batch, one per name; the code is shown once and only its hash is kept', async () => {
    eq((await call('/admin/beta/invites', { body: { count: 1 } })).status, 401);
    eq((await admin('/beta/invites', { body: { count: 51 } })).status, 400);
    const r = await admin('/beta/invites', { body: { names: ['Ana', 'Ben'], ttlDays: 7 } });
    eq(r.status, 200); eq(r.d.invites.map(x => x.note), ['Ana', 'Ben']);
    [inv, inv2] = r.d.invites; ok(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{2}$/.test(inv.code), inv.code);
    eq(inv.expiresAt, clock + 7 * 86400000);
    const l = (await admin('/beta')).d;
    eq(l.counts, { all: 2, open: 2, used: 0, closed: 0 }); eq(l.invites[0].tail, codeOf(inv.code).slice(-4));
    const raw = JSON.stringify(app._social.state().beta);
    ok(!raw.includes(codeOf(inv.code)) && !raw.includes(codeOf(inv2.code)), 'no code is stored in the clear');
    eq(l.existing, 1, '@early came before the beta');
  });

  await t('checking an invite: bad, good, and whether a name is free (capitals don’t make a new name)', async () => {
    eq((await call('/beta/check', { body: { code: 'AAAA-AAAA-AA' } })).status, 404);
    const c = await call('/beta/check', { body: { code: inv.code.toLowerCase(), handle: 'EARLY' } });
    eq(c.status, 200); eq(c.d.handleFree, false, 'EARLY is @early'); eq(c.d.expiresAt, inv.expiresAt);
    eq((await call('/beta/check', { body: { code: codeOf(inv.code), handle: 'ana_trades' } })).d.handleFree, true);
    eq((await call('/beta/check', { body: { code: inv.code, handle: 'a!' } })).d.handleOk, false);
  });

  await t('an invite activates one profile, once, and that device can open the app at once', async () => {
    eq((await call('/join', { body: { handle: 'Early', beta: inv.code } })).status, 409, 'a taken name, whatever its capitals; the invite isn’t spent');
    const r = await call('/join', { body: { handle: 'ana_trades', beta: inv.code } });
    eq(r.status, 200); newKey = r.d.key; newCookie = r.cookie; ok(newCookie);
    const p = await page('/daruma', newCookie); ok(!p.gate, 'the cookie opens Daruma'); ok(p.body.includes('<script src="app/'), 'the app itself');
    const js = await fetch(B + '/app/core.js?v=x', { headers: { Cookie: newCookie } }); eq(js.status, 200);
    const cur = (await page('/daruma', newCookie)).body.match(/app\/core\.js\?v=([a-z0-9]+)/);
    ok(cur, 'the page names its scripts by version'); eq((await fetch(B + '/app/core.js?v=' + cur[1], { headers: { Cookie: newCookie } })).headers.get('cache-control'), 'private, max-age=31536000, immutable', 'no shared cache keeps gated scripts');
    const again = await call('/join', { body: { handle: 'someone_else', beta: inv.code } }); eq(again.status, 403); eq(again.d.state, 'used');
    eq((await call('/beta/check', { body: { code: inv.code } })).status, 410);
    const x = (await admin('/beta')).d.invites.find(i => i.note === 'Ana');
    eq(x.state, 'used'); eq(x.used.handle, 'ana_trades');
    eq((await admin('/members')).d.members.find(m => m.handle === 'ana_trades').joinedWith, 'beta');
    // an open invite link, already in: straight to Daruma
    eq((await page('/join', newCookie)).location, '/daruma');
  });

  await t('a stale cookie of the same name sent first doesn’t hide the good one', async () => {
    ok(!(await page('/', 'daruma_access=m.' + oldId + '.' + 'B'.repeat(32) + '; ' + newCookie)).gate);
  });
  await t('the app’s own join form (the owner, while beta mode is on) sends the code as invite', async () => {
    const x = (await admin('/beta/invites', { body: { count: 1 } })).d.invites[0];
    const r = await call('/join', { body: { handle: 'owners_alt', invite: x.code } }); eq(r.status, 200); eq(r.d.me.handle, 'owners_alt');
    await admin('/members/' + r.d.me.id, { body: { action: 'remove' } });
  });

  await t('the cookie is the server’s: forged, tampered or another member’s id doesn’t open anything', async () => {
    const [, id, mac] = newCookie.split('=')[1].split('.');
    for (const c of ['daruma_access=m.' + id + '.' + 'A'.repeat(32), 'daruma_access=m.' + oldId + '.' + mac, 'daruma_access=o.' + mac, 'daruma_access=' + newKey])
      ok((await page('/', c)).gate, c);
  });

  await t('signing in on another device: the device gets its own cookie; signing out clears it', async () => {
    const link = await call('/link/start', { method: 'POST', body: {}, key: newKey });
    const r = await call('/link/finish', { body: { code: link.d.code } }); eq(r.status, 200); ok(r.cookie && r.cookie !== newCookie);
    ok(!(await page('/', r.cookie)).gate);
    const out = await call('/access', { method: 'DELETE' }); eq(out.status, 200); ok(/Max-Age=0/.test(out.setCookie));
  });

  await t('a profile from before keeps access by default: its stored key is swapped for the cookie', async () => {
    eq((await call('/access', { method: 'POST', body: {} })).status, 401);
    const r = await call('/access', { method: 'POST', body: {}, key: oldKey }); eq(r.status, 200); ok(r.cookie);
    ok(!(await page('/ledger.html', r.cookie)).gate);
  });

  await t('with “profiles from before keep access” off they need an invite: the old cookie stops, a code brings them in', async () => {
    const before = (await call('/access', { method: 'POST', body: {}, key: oldKey })).cookie;
    await admin('/beta', { method: 'PUT', body: { keepExisting: false } });
    ok((await page('/', before)).gate, 'the cookie from before no longer opens it');
    ok(!(await page('/', newCookie)).gate, 'a profile an invite made still gets in');
    const r = await call('/access', { method: 'POST', body: {}, key: oldKey }); eq(r.status, 403); eq(r.d.needsInvite, true); eq(r.d.handle, 'early');
    eq((await call('/seen', { body: { addresses: [] }, key: oldKey })).status, 403);
    // its key doesn't reach the member API either (an app tab left open, a script): only the invite step
    const me = await call('/me', { key: oldKey }); eq(me.status, 403); eq(me.d.needsInvite, true);
    eq((await call('/posts', { body: { kind: 'note', text: 'hi' }, key: oldKey })).status, 403);
    const red = await call('/beta/redeem', { body: { code: inv2.code }, key: oldKey }); eq(red.status, 200); ok(red.cookie);
    ok(!(await page('/', red.cookie)).gate); ok(!(await page('/', before)).gate, 'the device’s cookie works again');
    eq((await call('/beta/redeem', { body: { code: inv2.code }, key: newKey })).status, 410, 'spent');
    await admin('/beta', { method: 'PUT', body: { keepExisting: true } });
  });

  await t('expiry, withdrawing, and a new link in place of an old one', async () => {
    const [a, b, c] = (await admin('/beta/invites', { body: { count: 3, ttlDays: 1 } })).d.invites;
    clock += 2 * 86400000;
    const e = await call('/join', { body: { handle: 'late_one', beta: a.code } }); eq(e.status, 403); eq(e.d.state, 'expired');
    eq((await admin('/beta/invites/' + b.id, { body: { action: 'revoke' } })).status, 409, 'an expired one can’t be withdrawn');
    const fresh = await admin('/beta/invites', { body: { count: 1 } }); const f = fresh.d.invites[0];
    eq((await admin('/beta/invites/' + f.id, { body: { action: 'revoke' } })).status, 200);
    eq((await call('/beta/check', { body: { code: f.code } })).d.state, 'revoked');
    const rep = await admin('/beta/invites/' + c.id, { body: { action: 'replace' } }); eq(rep.status, 200); ok(rep.d.code && rep.d.code !== c.code);
    eq((await call('/join', { body: { handle: 'late_one', beta: rep.d.code } })).status, 200);
    const used = (await admin('/beta')).d.invites.find(x => x.state === 'used');
    eq((await admin('/beta/invites/' + used.id, { body: { action: 'replace' } })).status, 409, 'a used invite isn’t replaced');
    eq((await admin('/beta/invites/nope', { body: { action: 'revoke' } })).status, 404);
  });

  await t('suspending, or an admin’s “sign out all devices”, ends page access at once', async () => {
    const m = (await admin('/members')).d.members.find(x => x.handle === 'ana_trades');
    await admin('/members/' + m.id, { body: { action: 'ban' } });
    ok((await page('/', newCookie)).gate); eq((await call('/access', { method: 'POST', body: {}, key: newKey })).status, 403);
    await admin('/members/' + m.id, { body: { action: 'unban' } });
    ok(!(await page('/', newCookie)).gate, 'restored');
    const so = await admin('/members/' + m.id, { body: { action: 'signout' } }); eq(so.status, 200);
    ok((await page('/', newCookie)).gate); eq((await call('/me', { key: newKey })).status, 401, 'the key itself is gone');
    eq((await admin('/members')).d.members.find(x => x.id === m.id).devices, 0);
    const code = (await admin('/members/' + m.id, { body: { action: 'code' } })).d.code;
    const back = await call('/link/finish', { body: { code } }); eq(back.status, 200, 'a sign-in code from the admin brings them back'); newKey = back.d.key; newCookie = back.cookie;
    ok(!(await page('/', newCookie)).gate);
  });

  await t('an admin resets a member’s passkeys: they stop signing in, and the member is told', async () => {
    const m = (await admin('/members')).d.members.find(x => x.handle === 'ana_trades');
    app._social.state().members[m.id].passkeys = [{ id: 'cred-1', name: 'iPhone', alg: -7, pub: 'x', signCount: 0, at: clock }];
    eq((await admin('/members')).d.members.find(x => x.id === m.id).passkeys, 1);
    const r = await admin('/members/' + m.id, { body: { action: 'passkeys' } }); eq(r.status, 200); eq(r.d.removed, 1);
    eq((await admin('/members')).d.members.find(x => x.id === m.id).passkeys, 0);
    ok((await call('/inbox', { key: newKey })).d.items.some(i => /removed your passkeys/.test(i.text)));
    // only the owner acts on another admin (as for every other member action)
    const adm = (await admin('/members', { body: { handle: 'helper', admin: true } })).d;
    const hk = (await call('/link/finish', { body: { code: adm.code } })).d.key;
    eq((await call('/admin/members/' + oldId, { body: { action: 'passkeys' }, key: hk })).status, 200, 'an admin resets a member');
    const other = (await admin('/members', { body: { handle: 'helper2', admin: true } })).d;
    eq((await call('/admin/members/' + other.id, { body: { action: 'signout' }, key: hk })).status, 403, 'but not another admin');
  });

  await t('names are unique whatever their capitals, on every way a name is set', async () => {
    eq((await call('/me', { method: 'PUT', key: newKey, body: { handle: 'EARLY' } })).status, 409);
    eq((await admin('/members', { body: { handle: 'Ana_Trades' } })).status, 409);
    eq((await admin('/members/' + oldId, { body: { action: 'edit', handle: 'ANA_TRADES' } })).status, 409);
    eq((await call('/me', { method: 'PUT', key: newKey, body: { handle: 'Ana_Trades' } })).status, 200, 'their own name in other capitals is still theirs');
  });

  await t('the owner: the token gets the cookie (a wrong one doesn’t); a new AUTH_TOKEN ends it', async () => {
    eq((await call('/access', { method: 'POST', body: {}, headers: { Authorization: 'Bearer nope' } })).status, 401);
    const r = await call('/access', { method: 'POST', body: {}, admin: true }); eq(r.status, 200); ok(/^daruma_access=o\./.test(r.cookie));
    ok(!(await page('/', r.cookie)).gate);
    // the same data, another token: the owner's cookie was signed with the old one
    const other = server.createApp({ dataDir, auth: 'new-token', htmlPath, fetchImpl, now: () => clock, push: false, pushTick: false, offsiteTimer: false });
    const B2 = await listen(other);
    const p = await fetch(B2 + '/', { headers: { Cookie: r.cookie } }); eq(p.headers.get('x-beta-gate'), '1');
    const p2 = await fetch(B2 + '/', { headers: { Cookie: newCookie } }); eq(p2.headers.get('x-beta-gate'), null, 'members’ cookies don’t depend on the token');
    await new Promise(res => other.close(res)); other._social && other._social.close && other._social.close();
  });

  await t('the docs go behind the beta page too when they’re set to', async () => {
    await admin('/beta', { method: 'PUT', body: { publicDocs: false } });
    ok((await page('/help')).gate); ok((await page('/docs')).gate); eq((await page('/tutorial/img/x.webp')).status, 403);
    ok(!(await page('/help', newCookie)).gate, 'members read them');
    await admin('/beta', { method: 'PUT', body: { publicDocs: true } });
  });

  await t('invites, the mode and every cookie survive a restart', async () => {
    await new Promise(res => app.close(res)); app._social.close();
    app = mk(); B = await listen(app);
    ok(!(await page('/', newCookie)).gate); ok((await page('/')).gate);
    eq((await admin('/beta')).d.counts.used, 4);
    const cfg = (await admin('/beta')).d.config; eq(cfg.by, 'owner'); ok(cfg.since > 0, 'who switched it on, and when, are kept');
  });

  await t('switched off, everything is as it was: the app opens for anyone and joining is open again', async () => {
    const r = await admin('/beta', { method: 'PUT', body: { on: false } }); eq(r.d.config.on, false);
    ok(!(await page('/')).gate); eq((await page('/app/core.js')).status, 200);
    eq((await page('/join')).location, '/daruma');
    eq((await call('/join', { body: { handle: 'open_again' } })).status, 200);
    eq((await call('/beta/check', { body: { code: 'AAAA-AAAA-AA' } })).d.off, true);
    eq((await call('/visit', { body: {} })).status, 200);
  });
} finally {
  await new Promise(res => app.close(res)); try { app._social.close(); } catch (e) {}
}
report('beta');
