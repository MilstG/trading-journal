// The admin panel's two-factor screens (see admin2fa.js on the server). admin.html loads this before
// its own script; it stays out of admin.html because that page has a size budget.
//
//   - The second step: any admin call answered 401 with {twofa} (two-factor applies and this browser
//     has no admin session) opens the step — a passkey, an authenticator-app code or a recovery code,
//     or, when it's required and nothing is set up yet, setting a factor up — then the call is sent
//     again. Calls made meanwhile wait for the same step. On the sign-in screen it takes the sign-in
//     card's place; over an open panel (a session that ran out) it's a dialog.
//   - The Security card under Settings (window.A2F.card()): status, admin passkeys, the authenticator
//     app (QR code, secret, otpauth:// link), recovery codes; for the owner, every admin's status,
//     "require it of every admin", and resetting an admin who lost their factors.
//   - Sign out also ends the admin session.
// In Node (tests) it only exports the QR encoder.
(function () {
  'use strict';
  // ---- a small QR encoder (ISO/IEC 18004): byte mode, error correction M, versions 1–10 (up to 213
  // bytes, plenty for an otpauth:// URI). Returns rows of booleans (true = dark), no quiet zone.
  // Checked module for module against the Python qrcode library (tests/test-admin2fa.mjs has its vectors).
  const QR_EC = [0, [10, 1, 16, 0, 0], [16, 1, 28, 0, 0], [26, 1, 44, 0, 0], [18, 2, 32, 0, 0], [24, 2, 43, 0, 0], [16, 4, 27, 0, 0], [18, 4, 31, 0, 0],
    [22, 2, 38, 2, 39], [22, 3, 36, 2, 37], [26, 4, 43, 1, 44]]; // ec per block, blocks × data, blocks × data
  const QR_ALIGN = [0, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
  function qrMatrix(text, forceMask) {
    const bytes = Array.from(new TextEncoder().encode(text));
    let v = 1; const dataCw = n => QR_EC[n][1] * QR_EC[n][2] + QR_EC[n][3] * QR_EC[n][4];
    while (v <= 10 && 4 + (v < 10 ? 8 : 16) + 8 * bytes.length > 8 * dataCw(v)) v++;
    if (v > 10) throw new Error('too long for a QR code here');
    // the bit stream: mode 0100, length, the bytes, a terminator, then pad bytes
    const bits = []; const put = (x, n) => { for (let i = n - 1; i >= 0; i--) bits.push((x >>> i) & 1); };
    put(4, 4); put(bytes.length, v < 10 ? 8 : 16); bytes.forEach(b => put(b, 8));
    const cap = 8 * dataCw(v); put(0, Math.min(4, cap - bits.length)); while (bits.length % 8) bits.push(0);
    const data = []; for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => a * 2 + b, 0));
    for (let p = 0; data.length < dataCw(v); p ^= 1) data.push(p ? 0x11 : 0xEC);
    // Reed–Solomon over GF(256), polynomial 0x11D
    const EXP = [], LOG = []; for (let i = 0, x = 1; i < 255; i++) { EXP[i] = x; LOG[x] = i; x = (x << 1) ^ (x & 128 ? 0x11D : 0); }
    const mul = (a, b) => a && b ? EXP[(LOG[a] + LOG[b]) % 255] : 0;
    const [ecn, b1, d1, b2, d2] = QR_EC[v];
    let gen = [1]; for (let i = 0; i < ecn; i++) { const g = gen.concat(0); for (let j = 0; j < gen.length; j++) g[j + 1] ^= mul(gen[j], EXP[i]); gen = g; }
    const blocks = [], ecs = []; let at = 0;
    for (let k = 0; k < b1 + b2; k++) { const n = k < b1 ? d1 : d2, blk = data.slice(at, at + n); at += n; blocks.push(blk);
      const r = blk.concat(new Array(ecn).fill(0));
      for (let i = 0; i < n; i++) { const c = r[i]; if (c) for (let j = 0; j < gen.length; j++) r[i + j] ^= mul(gen[j], c); }
      ecs.push(r.slice(n)); }
    const cw = []; for (let i = 0; i < Math.max(d1, d2); i++) blocks.forEach(b => { if (i < b.length) cw.push(b[i]); });
    for (let i = 0; i < ecn; i++) ecs.forEach(e => cw.push(e[i]));
    // the grid: function patterns first (fn marks them so data and masks skip them)
    const N = 17 + 4 * v, M = [], fn = [];
    for (let y = 0; y < N; y++) { M.push(new Array(N).fill(false)); fn.push(new Array(N).fill(false)); }
    const set = (x, y, d) => { M[y][x] = d; fn[y][x] = true; };
    const finder = (cx, cy) => { for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) { const x = cx + dx, y = cy + dy;
      if (x >= 0 && x < N && y >= 0 && y < N) { const d = Math.max(Math.abs(dx), Math.abs(dy)); set(x, y, d !== 2 && d !== 4); } } };
    for (let i = 0; i < N; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
    finder(3, 3); finder(N - 4, 3); finder(3, N - 4);
    const al = QR_ALIGN[v];
    al.forEach((ay, i) => al.forEach((ax, j) => { if ((i === 0 && j === 0) || (i === 0 && j === al.length - 1) || (i === al.length - 1 && j === 0)) return;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(ax + dx, ay + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1); }));
    const format = mask => { const d = mask; let r = d; for (let i = 0; i < 10; i++) r = (r << 1) ^ ((r >>> 9) * 0x537); // level M is 00
      const b = ((d << 10) | r) ^ 0x5412, bit = i => ((b >>> i) & 1) === 1;
      for (let i = 0; i <= 5; i++) set(8, i, bit(i));
      set(8, 7, bit(6)); set(8, 8, bit(7)); set(7, 8, bit(8));
      for (let i = 9; i < 15; i++) set(14 - i, 8, bit(i));
      for (let i = 0; i < 8; i++) set(N - 1 - i, 8, bit(i));
      for (let i = 8; i < 15; i++) set(8, N - 15 + i, bit(i));
      set(8, N - 8, true); };
    format(0);
    if (v >= 7) { let r = v; for (let i = 0; i < 12; i++) r = (r << 1) ^ ((r >>> 11) * 0x1F25);
      const b = (v << 12) | r; for (let i = 0; i < 18; i++) { const d = ((b >>> i) & 1) === 1, a = N - 11 + i % 3, c = Math.floor(i / 3); set(a, c, d); set(c, a, d); } }
    // the codewords, two columns at a time, zigzagging up and down from the bottom right
    let i = 0;
    for (let right = N - 1; right >= 1; right -= 2) { if (right === 6) right = 5;
      for (let vert = 0; vert < N; vert++) for (let j = 0; j < 2; j++) { const x = right - j, y = ((right + 1) & 2) === 0 ? N - 1 - vert : vert;
        if (!fn[y][x] && i < cw.length * 8) { M[y][x] = ((cw[i >>> 3] >>> (7 - (i & 7))) & 1) === 1; i++; } } }
    const MASKS = [(x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, x => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
      (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => x * y % 2 + x * y % 3 === 0,
      (x, y) => (x * y % 2 + x * y % 3) % 2 === 0, (x, y) => ((x + y) % 2 + x * y % 3) % 2 === 0];
    const masked = m => { const keep = M.map(r => r.slice());
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) if (!fn[y][x] && MASKS[m](x, y)) M[y][x] = !M[y][x];
      format(m); const out = M.map(r => r.slice()); for (let y = 0; y < N; y++) M[y] = keep[y]; return out; };
    // the standard penalty (runs, 2×2 blocks, finder look-alikes, balance) picks the mask
    const penalty = G => { let p = 0, dark = 0;
      const line = a => { let s = 0, run = 1; for (let k = 1; k <= a.length; k++) { if (k < a.length && a[k] === a[k - 1]) run++; else { if (run >= 5) s += run - 2; run = 1; } }
        const str = a.map(b => b ? 1 : 0).join(''); for (const pat of ['10111010000', '00001011101']) for (let k = str.indexOf(pat); k >= 0; k = str.indexOf(pat, k + 1)) s += 40; return s; };
      for (let y = 0; y < N; y++) { p += line(G[y]); p += line(G.map(r => r[y])); for (let x = 0; x < N; x++) { if (G[y][x]) dark++;
        if (x < N - 1 && y < N - 1 && G[y][x] === G[y][x + 1] && G[y][x] === G[y + 1][x] && G[y][x] === G[y + 1][x + 1]) p += 3; } }
      return p + 10 * Math.floor(Math.abs(dark * 20 / (N * N) - 10)); };
    if (forceMask != null) return masked(forceMask);
    let best = null, bestP = Infinity; for (let m = 0; m < 8; m++) { const G = masked(m), p = penalty(G); if (p < bestP) { bestP = p; best = G; } }
    return best;
  }
  // an SVG of it: dark on white with the four-module quiet zone, whatever the page's colours, at a
  // whole 4 px per module so every edge is sharp on screen
  const qrSvg = text => { const G = qrMatrix(text), n = G.length + 8; let d = '';
    G.forEach((r, y) => r.forEach((on, x) => { if (on) d += 'M' + (x + 4) + ' ' + (y + 4) + 'h1v1h-1z'; }));
    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + n + ' ' + n + '" width="' + 4 * n + '" height="' + 4 * n + '" shape-rendering="crispEdges" role="img" aria-label="QR code for your authenticator app"><rect width="' + n + '" height="' + n + '" fill="#fff"/><path d="' + d + '" fill="#000"/></svg>'; };

  if (typeof document === 'undefined') { if (typeof module === 'object' && module.exports) module.exports = { qrMatrix, qrSvg }; return; }

  // ---------------- the browser ----------------
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const day = ms => ms ? new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : 'never';
  const time = ms => new Date(ms).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  const css = document.createElement('style');
  css.textContent = '.a2f-ov{position:fixed;inset:0;background:rgba(5,7,9,.72);display:flex;align-items:center;justify-content:center;padding:16px;z-index:30}'
    + '.a2f-ov>.card{width:100%;max-width:460px;max-height:calc(100vh - 32px);overflow:auto}'
    + '.a2f-qr{display:flex;gap:14px;flex-wrap:wrap;align-items:flex-start;margin:10px 0}.a2f-qr svg{display:block;max-width:100%;height:auto;border-radius:10px;flex:0 0 auto}'
    + '.a2f-qr>div{flex:1;min-width:min(200px,100%)}'
    + '.a2f-secret{font:700 15px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.06em;overflow-wrap:anywhere}'
    + '.a2f-uri{font-size:12px;overflow-wrap:anywhere;color:var(--muted)}'
    + '.a2f-codes{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:6px 14px;margin:10px 0;font:700 15px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace}'
    + '.a2f-pk{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--line);flex-wrap:wrap}.a2f-pk>div{min-width:0;overflow-wrap:anywhere}'
    + '.a2f-step .row+.row{margin-top:10px}';
  document.head.appendChild(css);

  // ---- calls ----
  const realFetch = window.fetch.bind(window);
  const ADMIN = /^\/api\/social\/admin(\/|$)/, TWOFA = /^\/api\/social\/admin\/2fa(\/|$)/;
  const pathOf = u => { try { return new URL(u, location.href).pathname; } catch (e) { return ''; } };
  // the first factor the panel signs its calls with: the owner's token, or this admin's Pulse key
  let first = null;
  const firstOf = h => { if (!h) return null; const g = k => h instanceof Headers ? h.get(k) : h[k];
    const a = g('Authorization'), k = g('X-Pulse-Key'); return a ? { Authorization: a } : k ? { 'X-Pulse-Key': k } : null; };
  let stepping = null, passedAt = -1; // the second step everyone waits for; when one last went through
  const needStep = info => stepping || (stepping = step(info).then(ok => { if (ok) passedAt = performance.now(); return ok; }).finally(() => { stepping = null; }));
  window.fetch = async function (input, init) {
    const p = pathOf(typeof input === 'string' ? input : (input && input.url) || '');
    if (!ADMIN.test(p) || TWOFA.test(p)) return realFetch(input, init);
    const f = firstOf(init && init.headers); if (f) first = f;
    const sent = performance.now(), r = await realFetch(input, init);
    if (r.status !== 401) return r;
    let d = null; try { d = await r.clone().json(); } catch (e) {}
    if (!d || !d.twofa) return r;
    // sent before a step that has since gone through: it only needs sending again
    if (sent < passedAt) return realFetch(input, init);
    if (!(await needStep(d.twofa))) return new Response(JSON.stringify({ error: 'The admin panel needs your second step. Sign in again to continue.' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
    return realFetch(input, init);
  };
  async function call(p, o, again) { o = o || {};
    const hasBody = o.body !== undefined;
    const r = await realFetch('/api/social/admin/2fa' + p, { method: o.method || (hasBody ? 'POST' : 'GET'), credentials: 'same-origin',
      headers: Object.assign({}, first, hasBody ? { 'Content-Type': 'application/json' } : {}), body: hasBody ? JSON.stringify(o.body) : undefined });
    const d = await r.json().catch(() => ({}));
    // a session that ran out while the card was open: the step, then once more
    if (r.status === 401 && d.twofa && !again && !/^\/verify/.test(p) && await needStep(d.twofa)) return call(p, o, true);
    if (!r.ok) { const e = new Error(d.error || ('HTTP ' + r.status)); e.status = r.status; throw e; }
    return d; }

  // ---- passkeys (WebAuthn): base64url in and out ----
  const hasPk = () => !!(window.PublicKeyCredential && navigator.credentials && window.isSecureContext);
  const b2u = b => btoa(String.fromCharCode.apply(null, new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const u2b = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0));
  const ids = l => (l || []).map(x => ({ type: 'public-key', id: u2b(x.id) }));
  async function pkCreate(o) {
    const c = await navigator.credentials.create({ publicKey: Object.assign({}, o, { challenge: u2b(o.challenge), user: Object.assign({}, o.user, { id: u2b(o.user.id) }), excludeCredentials: ids(o.excludeCredentials) }) });
    return { id: c.id, rawId: b2u(c.rawId), type: c.type, response: { clientDataJSON: b2u(c.response.clientDataJSON), attestationObject: b2u(c.response.attestationObject) } };
  }
  async function pkGet(o) {
    const c = await navigator.credentials.get({ publicKey: { challenge: u2b(o.challenge), rpId: o.rpId, timeout: o.timeout, userVerification: o.userVerification, allowCredentials: ids(o.allowCredentials) } });
    return { id: c.id, rawId: b2u(c.rawId), type: c.type, response: { clientDataJSON: b2u(c.response.clientDataJSON), authenticatorData: b2u(c.response.authenticatorData),
      signature: b2u(c.response.signature), userHandle: c.response.userHandle ? b2u(c.response.userHandle) : null } };
  }
  const pkWords = e => e && e.name === 'NotAllowedError' ? 'The passkey request was cancelled or timed out.' : e && e.name === 'InvalidStateError' ? 'That passkey is already added.' : (e && e.message) || String(e);
  // a passkey for the admin panel: start → the device → finish; returns the server's answer
  async function addPasskey(name) { const o = await call('/passkey/start', { body: {} }); return call('/passkey/finish', { body: { credential: await pkCreate(o), name } }); }

  // ---- pieces both screens use ----
  const totpHtml = (t, codeId, okAttr) => `<div class="a2f-qr">${(() => { try { return qrSvg(t.uri); } catch (e) { return ''; } })()}<div>
      <p class="muted small" style="margin:0 0 6px">Scan the code with your authenticator app (Google Authenticator, 1Password, Authy, …), or type this key into it:</p>
      <div class="a2f-secret" id="a2fSecret">${esc(t.secret.match(/.{1,4}/g).join(' '))}</div>
      <p class="a2f-uri" style="margin:8px 0 0">On this phone? <a href="${esc(t.uri)}">Open in the authenticator app</a> · <span>${esc(t.uri)}</span></p></div></div>
    <label for="${codeId}">The 6-digit code it shows</label>
    <div class="row"><input id="${codeId}" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="123456"><button class="primary fit" ${okAttr}>Turn on</button></div>`;
  const codesHtml = codes => `<p class="warn small" style="margin:8px 0 0">Save these recovery codes somewhere safe — a password manager, or on paper. Each one works once, if you lose your passkeys and your phone. They aren’t shown again.</p>
    <div class="a2f-codes" id="a2fCodes">${codes.map(c => `<span>${esc(c)}</span>`).join('')}</div>
    <div class="row" style="align-items:center"><button class="fit sm" data-a2f="copycodes">Copy</button><button class="fit sm" data-a2f="dlcodes">Download</button></div>`;
  let shownCodes = null;
  const copyCodes = async () => { try { await navigator.clipboard.writeText(shownCodes.join('\n')); flash('Copied.'); } catch (e) { flash('Couldn’t copy — select them by hand.', true); } };
  const dlCodes = () => { const a = document.createElement('a'); a.href = 'data:text/plain;charset=utf-8,' + encodeURIComponent('Keel admin recovery codes (' + location.host + ')\n\n' + shownCodes.join('\n') + '\n');
    a.download = 'pulse-admin-recovery-codes.txt'; document.body.appendChild(a); a.click(); a.remove(); };
  const flash = (m, err) => { const n = $('note'); if (!n) return; n.className = 'note' + (err ? ' err' : ''); n.textContent = m; setTimeout(() => { if (n.textContent === m) n.textContent = ''; }, err ? 6000 : 3500); };

  // ---------------- the second step ----------------
  let S = null; // {info, resolve, view: 'verify' | 'enroll' | 'totp' | 'codes', totp, codes, err, busy, hid}
  function step(info) {
    return new Promise(resolve => { S = { info, resolve, view: info.enroll ? 'enroll' : 'verify' }; drawStep(true); });
  }
  function stepBody() {
    const m = S.info.methods || {}, err = `<p class="warn${S.err ? '' : ' hide'}" id="a2fErr" role="alert" style="margin:12px 0 0">${esc(S.err || '')}</p>`;
    const cancel = `<p style="margin:14px 0 0"><button class="sm fit" data-a2f="cancel">Cancel</button></p>`;
    if (S.view === 'codes') return `<h2 id="a2fT">Two-factor is on</h2>${codesHtml(S.codes)}<p style="margin:14px 0 0"><button class="primary" data-a2f="stepdone">I’ve saved them — continue</button></p>`;
    if (S.view === 'totp') return `<h2 id="a2fT">Set up an authenticator app</h2>${totpHtml(S.totp, 'a2fStepTotp', 'data-a2f="stepTotpOk"')}${err}${cancel}`;
    if (S.view === 'enroll') return `<h2 id="a2fT">Set up two-factor</h2>
      <p class="muted" style="margin:0">The admin panel on this server asks for a second step after the ${first && first.Authorization ? 'access token' : 'sign-in'}. Set one up to continue: a passkey (Face ID, a fingerprint, the device PIN or a security key), or an authenticator app on your phone.</p>
      <div class="row" style="margin-top:12px">${hasPk() ? '<button class="primary fit" data-a2f="stepPkAdd">Add a passkey</button>' : ''}<button class="fit" data-a2f="stepTotp">Use an authenticator app</button></div>${err}${cancel}`;
    return `<h2 id="a2fT">Second step</h2>
      <p class="muted" style="margin:0">Confirm it’s you to open the admin panel. This browser then stays signed in for 12 hours.</p>
      ${m.passkey ? `<div class="row" style="margin-top:12px"><button class="primary fit" data-a2f="stepPk"${hasPk() ? '' : ' disabled'}>Use a passkey</button></div>${hasPk() ? '' : '<p class="hint">Passkeys need https (or localhost) and a browser that supports them.</p>'}` : ''}
      <label for="a2fCode">${m.totp ? 'Or a code from your authenticator app, or a recovery code' : 'Or a recovery code'}</label>
      <div class="row"><input id="a2fCode" autocomplete="one-time-code" maxlength="20" placeholder="${m.totp ? '123456' : 'xxxxx-xxxxx'}" aria-describedby="a2fErr"><button class="${m.passkey ? '' : 'primary '}fit" data-a2f="stepCode">Verify</button></div>${err}${cancel}`;
  }
  function drawStep(opening) {
    let box = $('a2fStep');
    if (!box) {
      const inApp = $('app') && !$('app').classList.contains('hide');
      box = document.createElement('div'); box.id = 'a2fStep';
      box.innerHTML = '<section class="card a2f-step" role="dialog" aria-modal="' + inApp + '" aria-labelledby="a2fT"></section>';
      if (inApp) { box.className = 'a2f-ov'; document.body.appendChild(box); }
      else { const login = $('login'); if (login && !login.classList.contains('hide')) { login.classList.add('hide'); S.hid = login; }
        (login || $('app')).insertAdjacentElement('afterend', box); }
    }
    box.firstChild.innerHTML = stepBody();
    const f = box.querySelector('input,button.primary,button'); if (opening && f) f.focus();
  }
  function endStep(passed) {
    const s = S; if (!s) return; S = null;
    const box = $('a2fStep'); if (box) box.remove();
    if (s.hid) s.hid.classList.remove('hide');
    card.stale = true; s.resolve(passed);
  }
  const stepErr = (m, focusId) => { S.err = m; S.busy = false; drawStep(); const el = focusId && $(focusId); if (el) { el.focus(); el.select && el.select(); } };
  // a first factor just set up: show the recovery codes before going on
  const enrolled = d => { if (d.recovery) { S.view = 'codes'; S.codes = shownCodes = d.recovery; S.err = ''; S.busy = false; drawStep(true); } else endStep(true); };
  async function stepAct(a) {
    if (!S || S.busy) return;
    if (a === 'cancel') return endStep(false);
    if (a === 'stepdone') return endStep(true);
    if (a === 'copycodes') return copyCodes();
    if (a === 'dlcodes') return dlCodes();
    S.busy = true;
    try {
      if (a === 'stepPk') { const o = await call('/verify/start', { body: {} });
        await call('/verify', { body: { credential: await pkGet(o) } }); return endStep(true); }
      if (a === 'stepCode') { const code = ($('a2fCode').value || '').trim(); if (!code) return stepErr('Type the code first.', 'a2fCode');
        await call('/verify', { body: { code } }); return endStep(true); }
      if (a === 'stepPkAdd') return enrolled(await addPasskey('Passkey'));
      if (a === 'stepTotp') { S.totp = await call('/totp/start', { body: {} }); S.view = 'totp'; S.err = ''; S.busy = false; return drawStep(true); }
      if (a === 'stepTotpOk') { const code = ($('a2fStepTotp').value || '').replace(/\s/g, ''); if (!/^\d{6}$/.test(code)) return stepErr('The app shows 6 digits.', 'a2fStepTotp');
        return enrolled(await call('/totp/finish', { body: { code } })); }
      S.busy = false;
    } catch (e) { stepErr(e.name && /Error$/.test(e.name) && e.name !== 'Error' ? pkWords(e) : e.message, a === 'stepCode' ? 'a2fCode' : a === 'stepTotpOk' ? 'a2fStepTotp' : null); }
  }

  // ---------------- the Security card (Settings) ----------------
  let st = null, loading = false, ui = { totp: null, codes: null, err: '', busy: false };
  async function refresh() { loading = true;
    try { st = await call(''); ui.err = ''; } catch (e) { ui.err = e.message; }
    loading = false; card.stale = false; redraw(); }
  const redraw = () => { const el = $('a2fCard'); if (el) el.innerHTML = cardBody(); };
  function card() { if ((!st || card.stale) && !loading) refresh(); return '<section class="card" id="a2fCard" aria-labelledby="a2fH">' + cardBody() + '</section>'; }
  function cardBody() {
    const errP = `<p class="warn${ui.err ? '' : ' hide'}" role="alert" style="margin:12px 0 0">${esc(ui.err)}</p>`;
    if (!st) return `<h2 id="a2fH">Security</h2><p class="muted">${loading || !ui.err ? 'Loading…' : ''}</p>${errP}`;
    const off = st.mode === 'off', methods = [st.passkeys.length ? st.passkeys.length + ' passkey' + (st.passkeys.length === 1 ? '' : 's') : '', st.totp ? 'authenticator app' : ''].filter(Boolean).join(' and ');
    const status = off ? `<p class="warn small">Two-factor is switched off on this server (<code>ADMIN_2FA=off</code>). What’s set up here is kept for when it’s on again.</p>`
      : st.on ? `<p style="margin:0"><span class="pill ok">Two-factor on</span> <span class="muted small">${esc(methods)}${st.session ? ' · this browser until ' + esc(time(st.session.until)) : ''}</span></p>`
      : `<p style="margin:0"><span class="pill">Two-factor off</span> <span class="muted small">${st.required ? 'Required here: set one up below.' : 'Add a passkey or an authenticator app, and the panel asks for it after the ' + (st.owner ? 'access token' : 'sign-in') + '.'}</span></p>`;
    const dis = ui.busy ? ' disabled' : '';
    let h = `<h2 id="a2fH">Security</h2>${status}
      ${st.mode === 'required' ? '<p class="hint">Required for the owner and every admin on this server (<code>ADMIN_2FA=required</code>).</p>' : ''}
      <h3>Admin passkeys</h3>
      ${st.passkeys.length ? st.passkeys.map(k => `<div class="a2f-pk"><div><b>${esc(k.name)}</b> <span class="muted small">added ${esc(day(k.at))} · last used ${esc(k.lastUsed ? day(k.lastUsed) : 'never')}</span></div><button class="sm danger fit" data-a2f="pkdel" data-id="${esc(k.id)}" data-n="${esc(k.name)}"${dis}>Remove</button></div>`).join('') : '<p class="muted small" style="margin:0">None yet. These are only for the admin panel: they don’t sign anyone in to Keel.</p>'}
      ${off ? '' : `<div class="row" style="margin-top:10px"><input id="a2fPkName" maxlength="40" placeholder="Name it, e.g. MacBook" aria-label="Passkey name" autocomplete="off"><button class="fit" data-a2f="pkadd"${hasPk() ? dis : ' disabled'}>Add a passkey</button></div>${hasPk() ? '' : '<p class="hint">Passkeys need https (or localhost) and a browser that supports them.</p>'}`}
      <h3>Authenticator app</h3>
      ${st.totp ? `<div class="a2f-pk"><div>Set up ${esc(day(st.totp.at))}</div><button class="sm danger fit" data-a2f="totpdel"${dis}>Remove</button></div>`
        : ui.totp ? totpHtml(ui.totp, 'a2fTotpCode', 'data-a2f="totpok"' + dis) + '<p style="margin:10px 0 0"><button class="sm fit" data-a2f="totpcancel">Cancel</button></p>'
        : off ? '<p class="muted small" style="margin:0">Not set up.</p>' : `<p class="muted small" style="margin:0 0 8px">Six-digit codes from an app on your phone, for when no passkey is at hand.</p><button class="fit" data-a2f="totpstart"${dis}>Set up an authenticator app</button>`}
      <h3>Recovery codes</h3>
      ${ui.codes ? codesHtml(ui.codes) + '<p style="margin:10px 0 0"><button class="sm fit" data-a2f="codesdone">Done</button></p>'
        : st.on ? `<div class="a2f-pk"><div>${st.recoveryLeft} of 10 left<span class="muted small">${st.recoveryAt ? ' · made ' + esc(day(st.recoveryAt)) : ''}</span></div><button class="sm fit" data-a2f="rcnew"${dis}>Make new codes</button></div>`
        : '<p class="muted small" style="margin:0">Ten one-time codes come with your first passkey or authenticator app.</p>'}`;
    if (st.owner) {
      const req = st.mode === 'required' || st.policy.requireAdmins;
      h += `<h3>Admins</h3>
        <label class="inline"><input type="checkbox" id="a2fReq"${req ? ' checked' : ''}${st.mode !== 'optional' || ui.busy ? ' disabled' : ''}>Require two-factor for every admin</label>
        <p class="hint" style="margin:-6px 0 6px 26px">${st.mode === 'optional' ? 'Admins without it are asked to set it up the next time they open the panel. Your own stays your choice.' : 'Set on the server with <code>ADMIN_2FA</code>.'}</p>
        ${st.admins.length ? `<div class="scroll"><table><tbody>${st.admins.map(a => `<tr><td>@${esc(a.handle)}</td><td>${a.on ? '<span class="pill ok">on</span>' : '<span class="pill">off</span>'}</td>
          <td class="muted small">${a.on ? esc([a.passkeys ? a.passkeys + ' passkey' + (a.passkeys === 1 ? '' : 's') : '', a.totp ? 'app' : '', a.recoveryLeft + ' recovery'].filter(Boolean).join(' · ')) : ''}</td>
          <td>${a.on ? `<button class="sm danger fit" data-a2f="reset" data-id="${esc(a.id)}" data-h="${esc(a.handle)}"${dis}>Reset</button>` : ''}</td></tr>`).join('')}</tbody></table></div>`
          : '<p class="muted small" style="margin:0">No admins yet.</p>'}`;
    }
    return h + errP;
  }
  async function cardAct(a, b) {
    if (a === 'copycodes') return copyCodes();
    if (a === 'dlcodes') return dlCodes();
    if (a === 'codesdone') { ui.codes = null; return redraw(); }
    if (a === 'totpcancel') { ui.totp = null; return redraw(); }
    if (ui.busy) return;
    if (a === 'pkdel' && !confirm('Remove the admin passkey “' + b.dataset.n + '”?')) return;
    if (a === 'totpdel' && !confirm('Remove the authenticator app? Its codes stop working.')) return;
    if (a === 'rcnew' && !confirm('Make ten new recovery codes? The old ones stop working.')) return;
    if (a === 'reset' && !confirm('Reset @' + b.dataset.h + '’s two-factor? Their passkeys, app and recovery codes are removed and they’re signed out of the panel. They can set it up again.')) return;
    // what was typed is read before the card redraws as busy
    let code = ''; const name = (($('a2fPkName') || {}).value || '').trim();
    if (a === 'totpok') { code = ($('a2fTotpCode').value || '').replace(/\s/g, ''); if (!/^\d{6}$/.test(code)) { ui.err = 'The app shows 6 digits.'; redraw(); return; } }
    ui.busy = true; ui.err = ''; redraw();
    try {
      let d = null;
      if (a === 'pkadd') { d = await addPasskey(name); flash('Passkey added.'); }
      else if (a === 'pkdel') { await call('/passkey/' + encodeURIComponent(b.dataset.id), { method: 'DELETE' }); flash('Removed.'); }
      else if (a === 'totpstart') { ui.totp = await call('/totp/start', { body: {} }); }
      else if (a === 'totpok') { d = await call('/totp/finish', { body: { code } }); ui.totp = null; flash('Authenticator app on.'); }
      else if (a === 'totpdel') { await call('/totp', { method: 'DELETE' }); flash('Removed.'); }
      else if (a === 'rcnew') d = await call('/recovery', { body: {} });
      else if (a === 'reset') { await call('/admins/' + encodeURIComponent(b.dataset.id), { method: 'DELETE' }); flash('@' + b.dataset.h + '’s two-factor was reset.'); }
      else if (a === 'policy') { await call('/policy', { method: 'PUT', body: { requireAdmins: b.checked } }); flash(b.checked ? 'Every admin now needs two-factor.' : 'Admins choose for themselves.'); }
      if (d && d.recovery) ui.codes = shownCodes = d.recovery;
      ui.busy = false; await refresh();
      if (a === 'totpstart') { const el = $('a2fTotpCode'); if (el) el.focus(); }
    } catch (e) { ui.busy = false; ui.err = e.name && /Error$/.test(e.name) && e.name !== 'Error' ? pkWords(e) : e.message; if (a === 'policy') await refresh(); else redraw(); }
  }

  // ---- wiring ----
  document.addEventListener('click', ev => {
    const b = ev.target.closest('[data-a2f]'); if (!b) return;
    if (b.closest('#a2fStep')) return stepAct(b.dataset.a2f);
    if (b.closest('#a2fCard')) return cardAct(b.dataset.a2f, b);
  });
  document.addEventListener('change', ev => { if (ev.target.id === 'a2fReq') cardAct('policy', ev.target); });
  document.addEventListener('keydown', ev => {
    if (ev.key === 'Enter' && ev.target.id === 'a2fCode') stepAct('stepCode');
    else if (ev.key === 'Enter' && ev.target.id === 'a2fStepTotp') stepAct('stepTotpOk');
    else if (ev.key === 'Enter' && ev.target.id === 'a2fTotpCode') cardAct('totpok');
    else if (ev.key === 'Escape' && S && S.view !== 'codes' && $('a2fStep')) endStep(false);
  });
  // signing out ends the admin session too. This listener goes on after admin.html's own (set while
  // its script ran), so the token, or the key after its confirm, is already gone when it's a sign-out.
  document.addEventListener('DOMContentLoaded', () => { const so = $('signout'); if (so) so.addEventListener('click', () => {
    const f = first; if (!f) return;
    let gone = false; try { gone = !localStorage.getItem(f.Authorization ? 'srv_token' : 'pz_social_key'); } catch (e) {}
    if (gone) realFetch('/api/social/admin/2fa/logout', { method: 'POST', keepalive: true, credentials: 'same-origin', headers: Object.assign({ 'Content-Type': 'application/json' }, f), body: '{}' }).catch(() => {}); }); });

  window.A2F = { card };
})();
