// Tests for the companion server (server.js) and the client's server-sync wiring.
// The server is exercised over real HTTP on an ephemeral port with a temp data dir.
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const { createApp } = require(join(here, '..', 'server.js'));
const html = readAppSource(join(here, '..', 'ledger.html'));

import { t, ok, eq, near, report } from './harness.mjs';
import { readAppSource } from '../app-source.js'; // ledger.html with its app/*.js inlined, in load order

function listen(app){ return new Promise(res => app.listen(0, () => res('http://127.0.0.1:' + app.address().port))); }
function makeServer(auth){
  const dataDir = mkdtempSync(join(tmpdir(), 'ledger-test-'));
  const app = createApp({ dataDir, auth, htmlPath: join(here, '..', 'ledger.html') });
  return { app, dataDir };
}
const authH = { Authorization: 'Bearer secret' };
const put = (base, body, headers) => fetch(base + '/api/data', { method: 'PUT',
  headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

console.log('\nServer: basics');
const s1 = makeServer('secret');
const base = await listen(s1.app);

await t('serves the app HTML at / with no-cache and nosniff', async () => {
  const r = await fetch(base + '/');
  eq(r.status, 200);
  ok((r.headers.get('content-type') || '').includes('text/html'));
  ok((r.headers.get('x-content-type-options') || '') === 'nosniff');
  const body = await r.text();
  const srcs = [...body.matchAll(/<script src="(app\/[a-z0-9.-]+\.js\?v=[0-9a-f]{12})"><\/script>/g)].map(m => m[1]);
  ok(srcs.length >= 10, 'the page loads its app/ scripts by content hash: ' + srcs.length);
  let code = '';
  for (const s of srcs) {
    const a = await fetch(base + '/' + s);
    eq(a.status, 200, s);
    ok(/immutable/.test(a.headers.get('cache-control') || ''), 'hashed scripts are cached long-term');
    code += await a.text();
  }
  ok(code.includes('initServerSync'), 'the served app is the sync-capable one');
});
await t('the Daruma tutorial: /tutorial/ serves the page, its screenshots load, nothing else under it does', async () => {
  const r0 = await fetch(base + '/tutorial', { redirect: 'manual' });
  eq(r0.status, 302); eq(r0.headers.get('location'), '/tutorial/');
  const r = await fetch(base + '/tutorial/');
  eq(r.status, 200);
  ok((r.headers.get('content-type') || '').includes('text/html'));
  ok(/default-src 'none'/.test(r.headers.get('content-security-policy') || ''), 'static docs CSP: no scripts');
  const body = await r.text();
  ok(/<title>[^<]*Daruma/.test(body), 'the tutorial page');
  const imgs = [...new Set([...body.matchAll(/src="img\/([a-z0-9-]+\.webp)"/g)].map(m => m[1]))];
  ok(imgs.length >= 20, 'screenshots referenced: ' + imgs.length);
  for (const i of imgs) {
    const a = await fetch(base + '/tutorial/img/' + i);
    eq(a.status, 200, i); eq(a.headers.get('content-type'), 'image/webp', i);
  }
  eq((await fetch(base + '/tutorial/img/nope.webp')).status, 404);
  eq((await fetch(base + '/tutorial/img/index.html')).status, 404);
  eq((await fetch(base + '/tutorial/index.js')).status, 404);
});

await t('app scripts: only real app/*.js files are served; a stale hash revalidates; 304 on a known ETag', async () => {
  for (const p of ['/app/../server.js', '/app/.hidden.js', '/app/nope.js', '/app/core.json', '/app/%2e%2e%2fserver.js'])
    eq((await fetch(base + p)).status, 404, p);
  const r = await fetch(base + '/app/core.js?v=000000000000');
  eq(r.status, 200); eq(r.headers.get('cache-control'), 'no-cache');
  eq((await fetch(base + '/app/core.js', { headers: { 'If-None-Match': r.headers.get('etag') } })).status, 304);
});
await t('health is unauthenticated and reports auth mode + app sync capability', async () => {
  const r = await fetch(base + '/api/health');
  eq(r.status, 200);
  eq(await r.json(), { ok: true, auth: true, appSyncCapable: true });
});
await t('fonts are files: versioned in the page, cached for a year by hash, only real woff2 files served', async () => {
  const body = await (await fetch(base + '/')).text();
  const m = body.match(/url\((app\/fonts\/inter-400\.woff2)\?v=([0-9a-f]{12})\)/);
  ok(m, 'the page names the font file with its hash'); ok(!body.includes('data:font/'), 'no font embedded in the page');
  const r = await fetch(base + '/' + m[1] + '?v=' + m[2]);
  eq([r.status, r.headers.get('content-type')], [200, 'font/woff2']); ok(/immutable/.test(r.headers.get('cache-control')));
  const b = Buffer.from(await r.arrayBuffer()); eq(b.subarray(0, 4).toString('latin1'), 'wOF2');
  eq((await fetch(base + '/' + m[1] + '?v=000000000000')).headers.get('cache-control'), 'no-cache', 'a stale hash revalidates');
  eq((await fetch(base + '/' + m[1], { headers: { 'If-None-Match': r.headers.get('etag') } })).status, 304);
  for (const p of ['/app/fonts/../server.js', '/app/fonts/nope.woff2', '/app/fonts/inter-400.ttf', '/app/fonts/%2e%2e%2fserver.js']) eq((await fetch(base + p)).status, 404, p);
});
await t('each screen gets its own page: Daruma leaves Chart.js out; both share one version and the offline cache keeps them apart', async () => {
  const j = await (await fetch(base + '/')).text(), k = await (await fetch(base + '/daruma')).text(), p = await (await fetch(base + '/pulse')).text(), kl = await (await fetch(base + '/keel')).text();
  ok(j.includes('src="app/chart.umd.js?v=')); ok(!k.includes('chart.umd.js')); eq(p, k, '/pulse is Daruma'); eq(kl, k, '/keel is Daruma');
  const ver = s => s.match(/name="app-version" content="([0-9a-f]+)"/)[1];
  eq(ver(j), ver(k), 'one version for both screens');
  const sw = await (await fetch(base + '/sw.js')).text();
  ok(sw.includes("const K=u.pathname==='/daruma'||u.pathname==='/keel'||u.pathname==='/pulse'?'/daruma':'/';") && sw.includes('c.put(K,cp)') && sw.includes('caches.match(K)'), 'a cached copy per screen');
});
await t('the page carries its version, and /api/version (unauthenticated, never cached) answers the same one', async () => {
  const body = await (await fetch(base + '/pulse')).text();
  const m = body.match(/<meta name="app-version" content="([0-9a-f]{12})">/);
  ok(m, 'version meta in the page');
  const r = await fetch(base + '/api/version');
  eq(r.status, 200); eq(r.headers.get('cache-control'), 'no-store');
  eq(await r.json(), { v: m[1] });
  // a deploy (here: a changed script) moves the version, so a resumed app knows to reload
  const dir = mkdtempSync(join(tmpdir(), 'ledger-ver-'));
  const { cpSync } = await import('node:fs');
  cpSync(join(here, '..', 'ledger.html'), join(dir, 'ledger.html')); cpSync(join(here, '..', 'app'), join(dir, 'app'), { recursive: true });
  const s = createApp({ dataDir: mkdtempSync(join(tmpdir(), 'ledger-test-')), auth: 'secret', htmlPath: join(dir, 'ledger.html') });
  const b = await listen(s);
  try {
    const v1 = (await (await fetch(b + '/api/version')).json()).v; eq(v1, m[1], 'same files, same version');
    writeFileSync(join(dir, 'app', 'boot.js'), readFileSync(join(dir, 'app', 'boot.js'), 'utf8') + '\n// changed');
    const v2 = (await (await fetch(b + '/api/version')).json()).v;
    ok(v2 && v2 !== v1, 'a changed script is a new version');
    ok((await (await fetch(b + '/')).text()).includes('content="' + v2 + '"'), 'and the page says so');
  } finally { await new Promise(res => s.close(res)); }
});
await t('stale ledger.html (no sync client) is detected, not silently served', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-stale-'));
  const stale = join(dir, 'old.html');
  writeFileSync(stale, '<html><script>/* an old build with no sync client */</script></html>');
  const app = createApp({ dataDir: dir, auth: 'secret', htmlPath: stale });
  eq(app.appSyncCapable, false, 'flag exposed for the boot warning');
  const b = await listen(app);
  const h = await (await fetch(b + '/api/health')).json();
  eq(h.appSyncCapable, false, 'health surfaces the mismatch remotely');
  await new Promise(res => app.close(res));
});
await t('unknown routes 404 as JSON (no path-based file serving → no traversal surface)', async () => {
  for (const p of ['/nope', '/../server.js', '/api/../../etc/passwd']) {
    const r = await fetch(base + p);
    eq(r.status, 404, p);
  }
});

console.log('\nServer: auth');
await t('data API rejects missing and wrong tokens', async () => {
  eq((await fetch(base + '/api/data')).status, 401);
  eq((await fetch(base + '/api/data', { headers: { Authorization: 'Bearer wrong' } })).status, 401);
});
await t('data API accepts the right token', async () => {
  const r = await fetch(base + '/api/data', { headers: authH });
  eq(r.status, 200);
  eq(await r.json(), { rev: 0, snapshot: null });
});

await t('wrong tokens lock the address out (429, right token included); no-token and READ_TOKEN calls never count', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ledger-lock-'));
  const app = createApp({ dataDir, auth: 'secret', readAuth: 'reader', authFailMax: 3, htmlPath: join(here, '..', 'ledger.html') });
  const b = await listen(app);
  // a tokenless visitor and a READ_TOKEN script on a full-token route are not guesses
  for (let i = 0; i < 5; i++) eq((await fetch(b + '/api/data')).status, 401);
  for (let i = 0; i < 5; i++) eq((await fetch(b + '/api/data', { headers: { Authorization: 'Bearer reader' } })).status, 401);
  eq((await fetch(b + '/api/data', { headers: authH })).status, 200, 'still open after 10 non-guesses');
  // parallel guesses: the 300ms delay alone wouldn't stop these
  const rs = await Promise.all([1, 2, 3].map(i => fetch(b + '/api/data', { headers: { Authorization: 'Bearer guess' + i } })));
  eq(rs.map(r => r.status), [401, 401, 401]);
  const locked = await fetch(b + '/api/data', { headers: authH });
  eq(locked.status, 429, 'even the right token is refused while locked');
  ok(+locked.headers.get('retry-after') > 0, 'Retry-After set');
  eq((await fetch(b + '/api/v1/stats', { headers: { Authorization: 'Bearer reader' } })).status, 429, 'read token locked too');
  eq((await fetch(b + '/api/health')).status, 200, 'tokenless public routes still answer');
  ok(/locked out for \d+ more minutes/.test((await locked.json()).error), 'the 429 says how long');
  await new Promise(res => app.close(res));
});
await t('one wrong token is one guess, however many requests carry it (a sign-in burst, a stale saved token)', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ledger-lock-'));
  const app = createApp({ dataDir, auth: 'secret', authFailMax: 3, htmlPath: join(here, '..', 'ledger.html') });
  const b = await listen(app);
  // the admin panel used to send its 13 calls at once with a mistyped token: 13 guesses, and two typos locked the owner out
  const burst = tok => Promise.all(Array.from({ length: 13 }, (_, i) => fetch(b + (i % 2 ? '/api/data' : '/api/social/admin/me'), { headers: { Authorization: 'Bearer ' + tok } })));
  for (const tok of ['secrte', 'secrte', 'Secret']) eq([...new Set((await burst(tok)).map(r => r.status))], [401], tok);
  eq((await fetch(b + '/api/data', { headers: authH })).status, 200, 'two distinct typos, sent 39 times: not locked');
  eq((await fetch(b + '/api/data', { headers: { Authorization: 'Bearer third' } })).status, 401);
  eq((await fetch(b + '/api/data', { headers: authH })).status, 429, 'a third distinct wrong token still locks (AUTH_FAIL_MAX 3)');
  await new Promise(res => app.close(res));
});

console.log('\nServer: persistence round-trip');
await t('PUT then GET round-trips the snapshot with incremented rev', async () => {
  const snap = { app: 'ledger', journal: { 'w:BTC:1': { notes: 'test entry', tags: ['a'] } }, wallets: [] };
  const w = await put(base, { rev: 0, snapshot: snap }, authH);
  eq(w.status, 200);
  const wj = await w.json(); eq(wj.rev, 1);
  ok(typeof wj.storeId === 'string' && wj.storeId.length >= 12 && typeof wj.at === 'string', 'the store’s id and this version’s time: ' + JSON.stringify(wj));
  const g = await fetch(base + '/api/data', { headers: authH });
  const j = await g.json();
  eq(j.rev, 1);
  eq(j.snapshot, snap, 'journal entry survives the round trip');
});
await t('stale rev → 409 with current server state (no clobber)', async () => {
  const r = await put(base, { rev: 0, snapshot: { stale: true } }, authH);
  eq(r.status, 409);
  const j = await r.json();
  eq(j.rev, 1);
  ok(j.snapshot && j.snapshot.journal, 'conflict response carries the current snapshot');
});
await t('correct rev advances; previous version kept as .bak', async () => {
  const r = await put(base, { rev: 1, snapshot: { second: true } }, authH);
  eq(await r.json().then(j => j.rev), 2);
  ok(existsSync(join(s1.dataDir, 'ledger-data.json.bak')), '.bak exists');
  const bak = JSON.parse(readFileSync(join(s1.dataDir, 'ledger-data.json.bak'), 'utf8'));
  eq(bak.rev, 1, 'backup is the previous revision');
});
await t('data survives a server restart (same data dir = the volume)', async () => {
  await new Promise(res => s1.app.close(res));
  const app2 = createApp({ dataDir: s1.dataDir, auth: 'secret', htmlPath: join(here, '..', 'ledger.html') });
  const base2 = await listen(app2);
  const j = await (await fetch(base2 + '/api/data', { headers: authH })).json();
  eq(j.rev, 2);
  eq(j.snapshot, { second: true }, 'reboot did not lose the journal');
  await new Promise(res => app2.close(res));
});

console.log('\nServer: input validation');
const s2 = makeServer(''); // no auth
const base2 = await listen(s2.app);
await t('no AUTH_TOKEN → API open (health reports auth:false)', async () => {
  eq((await (await fetch(base2 + '/api/health')).json()).auth, false);
  eq((await fetch(base2 + '/api/data')).status, 200);
});
await t('invalid JSON → 400', async () => {
  const r = await fetch(base2 + '/api/data', { method: 'PUT',
    headers: { 'Content-Type': 'application/json' }, body: '{nope' });
  eq(r.status, 400);
});
await t('wrong shape → 400', async () => {
  eq((await put(base2, { rev: 'x', snapshot: {} })).status, 400);
  eq((await put(base2, { rev: 0 })).status, 400);
});
await t('oversized body → 413', async () => {
  const big = { rev: 0, snapshot: { blob: 'x'.repeat(26 * 1024 * 1024) } };
  const r = await fetch(base2 + '/api/data', { method: 'PUT',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(big) }).catch(() => ({ status: 413 }));
  ok(r.status === 413 || r.status === undefined, 'rejected (413 or connection reset)');
});
await t('non-PUT/GET on /api/data → 405', async () => {
  eq((await fetch(base2 + '/api/data', { method: 'DELETE' })).status, 405);
});
await new Promise(res => s2.app.close(res));

console.log('\nServer: PWA assets');
const s3 = makeServer('tok');
const base3 = await listen(s3.app);
const authH3 = { Authorization: 'Bearer tok' };
await t('sw.js, manifest, icon served with right content types', async () => {
  const sw = await fetch(base3 + '/sw.js');
  eq(sw.status, 200); ok((sw.headers.get('content-type') || '').includes('javascript'));
  const swText = await sw.text();
  ok(swText.includes("u.pathname.startsWith('/api/')"), 'sw never intercepts the API');
  ok(swText.includes('setTimeout(()=>old().then(send),3000)'), 'the shell is network-first, the cached copy only after 3 s or offline');
  ok(swText.includes("C='ledger-v5'"), 'same cache name: the cached scripts survive this update');
  const mf = await (await fetch(base3 + '/manifest.webmanifest')).json();
  eq([mf.short_name, mf.display, mf.start_url, mf.id], ['Ledger', 'standalone', '/', '/']);
  for (const i of mf.icons) { const r = await fetch(base3 + i.src); eq([r.status, r.headers.get('content-type')], [200, 'image/png'], i.src); }
  ok(mf.icons.some(i => i.purpose === 'maskable' && i.sizes === '512x512'), 'a maskable icon for Android');
  eq((await fetch(base3 + '/icons/../server.js')).status, 404, 'only the icon files');
  const ic = await fetch(base3 + '/icon.svg');
  ok((ic.headers.get('content-type') || '').includes('svg'));
});

console.log('\nServer: attachments');
await t('attachment CRUD round-trip', async () => {
  const arr = ['data:image/jpeg;base64,AAA', 'data:image/png;base64,BBB'];
  const w = await fetch(base3 + '/api/att/dHJhZGUx', { method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...authH3 }, body: JSON.stringify(arr) });
  eq(await w.json().then(j => j.count), 2);
  const g = await fetch(base3 + '/api/att/dHJhZGUx', { headers: authH3 });
  eq(await g.json(), arr);
  await fetch(base3 + '/api/att/dHJhZGUx', { method: 'DELETE', headers: authH3 });
  const gone = await fetch(base3 + '/api/att/dHJhZGUx', { headers: authH3 });
  eq([gone.status, await gone.json()], [200, []], 'none stored: an empty list, not a 404 (the app asks for every trade it opens)');
});
await t('attachments require auth and validate keys + payload', async () => {
  eq((await fetch(base3 + '/api/att/dHJhZGUx')).status, 401);
  eq((await fetch(base3 + '/api/att/..%2Fescape', { headers: authH3 })).status, 400, 'traversal-shaped key rejected');
  const bad = await fetch(base3 + '/api/att/dHJhZGUx', { method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...authH3 }, body: JSON.stringify(['javascript:evil']) });
  eq(bad.status, 400, 'non-image payload rejected');
});
await new Promise(res => s3.app.close(res));

console.log('\nClient wiring guards');
await t('boot probes the server before local reads; FSA skipped in server mode', () => {
  ok(html.includes('try{ await initServerSync(); }catch(e){}'));
  ok(html.includes('if(SRV.enabled){ renderDatafile();'));
});
await t('all persistence paths route through schedulePersist (linked file + server + a member’s encrypted sync)', () => {
  ok(html.includes('function schedulePersist(){ scheduleLinkedWrite(); scheduleServerWrite(); vaultSchedule(); }'));
  ok(html.includes('schedulePersist();\n  }\n};') || html.includes('schedulePersist();'));
  ok(!html.includes('scheduleLinkedWrite();\n  }\n};'), 'Store.set no longer calls linked-write directly');
});
await t('409 handling applies server state instead of clobbering', () => {
  ok(html.includes("if(r.status===409){ // edited from another device"));
  ok(html.includes('Loaded newer data saved from another device.'));
});
await t('writes carry the rev and the excursion measurements', () => {
  ok(html.includes('const body={rev:SRV.rev,snapshot:snap}; if(sentRestore)body.restore=true;') && html.includes('body:JSON.stringify(body)'), 'and a restore says so');
  ok(html.includes('if(excRows)snap.excRows=excRows;'));
});
await t('token UI present with localStorage persistence', () => {
  ok(html.includes("localStorage.setItem('srv_token',tok);"));
  ok(html.includes('id="srvTok"'));
  ok(html.includes('☁ Server sync · rev'));
});
await t('excursion persistence triggers a server write', () => {
  ok(html.includes("if(dirty){ try{ await idbSet('excRows',persisted); }catch(err){} schedulePersist(); }"));
});
await t("CSP connect-src 'self' still covers same-origin /api calls", () => {
  ok(/connect-src 'self' https:\/\/api\.hyperliquid\.xyz/.test(html));
});

await t('daily snapshots: written on PUT, listed, fetchable, auth-gated', async () => {
  const srv = makeServer('tok');
  const base = await listen(srv.app);
  const H = { 'Authorization': 'Bearer tok', 'Content-Type': 'application/json' };
  let r = await fetch(base + '/api/data', { method: 'PUT', headers: H,
    body: JSON.stringify({ rev: 0, snapshot: { hello: 1 } }) });
  ok(r.status === 200, 'PUT failed: ' + r.status);
  // list
  r = await fetch(base + '/api/snapshots', { headers: H });
  ok(r.status === 200);
  const j = await r.json();
  ok(Array.isArray(j.snapshots) && j.snapshots.length === 1, 'expected 1 snapshot');
  const d = j.snapshots[0];
  ok(/^\d{4}-\d{2}-\d{2}$/.test(d.date) && d.rev === 1 && d.bytes > 0, 'snapshot meta wrong');
  // fetch one
  r = await fetch(base + '/api/snapshots/' + d.date, { headers: H });
  ok(r.status === 200);
  const s = await r.json();
  ok(s.rev === 1 && s.snapshot && s.snapshot.hello === 1, 'snapshot content wrong');
  // same-day overwrite, not append
  r = await fetch(base + '/api/data', { method: 'PUT', headers: H,
    body: JSON.stringify({ rev: 1, snapshot: { hello: 2 } }) });
  ok(r.status === 200);
  r = await fetch(base + '/api/snapshots', { headers: H });
  ok((await r.json()).snapshots.length === 1, 'same-day snapshot duplicated');
  r = await fetch(base + '/api/snapshots/' + d.date, { headers: H });
  ok((await r.json()).snapshot.hello === 2, 'same-day snapshot not overwritten');
  // auth gates
  ok((await fetch(base + '/api/snapshots')).status === 401, 'list not auth-gated');
  ok((await fetch(base + '/api/snapshots/' + d.date)).status === 401, 'fetch not auth-gated');
  // invalid date shape does not match the route (falls through to 404 handler or api 404)
  ok((await fetch(base + '/api/snapshots/evil', { headers: H })).status !== 200, 'bad date accepted');
  await new Promise(res => srv.app.close(res));
});

await t('snapshot rotation prunes to 14 days', async () => {
  const srv = makeServer('');
  const base = await listen(srv.app);
  const { writeFileSync: wf, mkdirSync: mk, readdirSync: rd } = await import('node:fs');
  const sd = join(srv.dataDir, 'snapshots'); mk(sd, { recursive: true });
  for (let i = 1; i <= 20; i++) wf(join(sd, `2026-06-${String(i).padStart(2,'0')}.json`), '{"rev":1}');
  // a PUT triggers snapshotDaily, which prunes
  const r = await fetch(base + '/api/data', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rev: 0, snapshot: { x: 1 } }) });
  ok(r.status === 200);
  const files = rd(sd).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  ok(files.length === 14, 'expected 14 after prune, got ' + files.length);
  ok(files[0] > '2026-06-06', 'oldest files not pruned first: ' + files[0]);
  await new Promise(res => srv.app.close(res));
});

// Railway sends SIGTERM to the old container on every redeploy. A non-zero exit
// (Node's default 143) makes Railway flag the deployment "Crashed" on every push.
await t('server exits 0 on SIGTERM (graceful redeploy)', async () => {
  const { spawn } = await import('node:child_process');
  const code = await new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [join(here, '..', 'server.js')],
      { env: { ...process.env, PORT: '39271' } });
    let out = '';
    p.stdout.on('data', d => { out += d; if (out.includes('listening')) setTimeout(() => p.kill('SIGTERM'), 50); });
    p.on('exit', c => resolve(c));
    p.on('error', reject);
    setTimeout(() => { p.kill('SIGKILL'); reject(new Error('shutdown timed out')); }, 8000);
  });
  ok(code === 0, `expected exit 0, got ${code}`);
});

console.log('\nServer: brotli for the page and its scripts');
await t('a br-accepting browser gets brotli once it is built (gzip until then), the same bytes unpacked, under the same ETag', async () => {
  const http = await import('node:http'), zlib = await import('node:zlib');
  const s = makeServer(''); const b = await listen(s.app), port = new URL(b).port;
  const get = (p, ae) => new Promise((res, rej) => http.get({ host: '127.0.0.1', port, path: p, headers: ae ? { 'accept-encoding': ae } : {} }, x => {
    const c = []; x.on('data', d => c.push(d)); x.on('end', () => res({ status: x.statusCode, h: x.headers, buf: Buffer.concat(c) })); }).on('error', rej));
  try {
    const page = await get('/daruma', 'gzip');
    const src = /<script src="(app\/pulse\.js\?v=[0-9a-f]+)"/.exec(page.buf.length ? zlib.gunzipSync(page.buf).toString() : '')[1];
    for (const p of ['/daruma', '/' + src]) {
      const first = await get(p, 'gzip, deflate, br');
      eq(first.h['content-encoding'], 'gzip', p + ': the first br request is answered with gzip while brotli builds');
      let br = first; for (let i = 0; i < 100 && br.h['content-encoding'] !== 'br'; i++) { await new Promise(r => setTimeout(r, 30)); br = await get(p, 'gzip, deflate, br'); }
      eq(br.h['content-encoding'], 'br', p + ': then brotli');
      const plain = await get(p, '');
      eq(plain.h['content-encoding'], undefined, 'no Accept-Encoding: the file as is');
      ok(zlib.brotliDecompressSync(br.buf).equals(plain.buf) && zlib.gunzipSync(first.buf).equals(plain.buf), p + ': one file, three encodings');
      ok(br.buf.length < first.buf.length, p + ': brotli is smaller (' + br.buf.length + ' < ' + first.buf.length + ')');
      eq([br.h.etag, br.h.vary], [plain.h.etag, 'Accept-Encoding']);
    }
  } finally { s.app.close(); }
});

report();
