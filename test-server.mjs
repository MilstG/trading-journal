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
const html = readFileSync(join(here, '..', 'ledger.html'), 'utf8');

let pass = 0, fail = 0;
async function t(name, fn){
  try { await fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.error('  ✗ ' + name + '\n    ' + e.message); }
}
const eq = (a, b, m) => { const ja = JSON.stringify(a), jb = JSON.stringify(b);
  if (ja !== jb) throw new Error((m || 'not equal') + '\n    got:  ' + ja + '\n    want: ' + jb); };
const ok = (v, m) => { if (!v) throw new Error(m || 'expected truthy'); };

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
  ok(body.includes('initServerSync'), 'served file is the sync-capable app');
});
await t('health is unauthenticated and reports auth mode + app sync capability', async () => {
  const r = await fetch(base + '/api/health');
  eq(r.status, 200);
  eq(await r.json(), { ok: true, auth: true, appSyncCapable: true });
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

console.log('\nServer: persistence round-trip');
await t('PUT then GET round-trips the snapshot with incremented rev', async () => {
  const snap = { app: 'ledger', journal: { 'w:BTC:1': { notes: 'test entry', tags: ['a'] } }, wallets: [] };
  const w = await put(base, { rev: 0, snapshot: snap }, authH);
  eq(w.status, 200);
  eq(await w.json(), { rev: 1 });
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
  ok((await sw.text()).includes("u.pathname.startsWith('/api/')"), 'sw never intercepts the API');
  const mf = await (await fetch(base3 + '/manifest.webmanifest')).json();
  eq(mf.name, 'Ledger'); eq(mf.display, 'standalone');
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
  eq((await fetch(base3 + '/api/att/dHJhZGUx', { headers: authH3 })).status, 404);
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
  ok(html.includes('if(SRV.enabled){ renderDatafile(); }'));
});
await t('all persistence paths route through schedulePersist (linked file + server)', () => {
  ok(html.includes('function schedulePersist(){ scheduleLinkedWrite(); scheduleServerWrite(); }'));
  ok(html.includes('schedulePersist();\n  }\n};') || html.includes('schedulePersist();'));
  ok(!html.includes('scheduleLinkedWrite();\n  }\n};'), 'Store.set no longer calls linked-write directly');
});
await t('409 handling applies server state instead of clobbering', () => {
  ok(html.includes("if(r.status===409){ // edited from another device"));
  ok(html.includes('Loaded newer data saved from another device.'));
});
await t('writes carry the rev and the excursion measurements', () => {
  ok(html.includes('body:JSON.stringify({rev:SRV.rev,snapshot:snap})'));
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
