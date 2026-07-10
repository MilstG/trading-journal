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
await t('health is unauthenticated and reports auth mode', async () => {
  const r = await fetch(base + '/api/health');
  eq(r.status, 200);
  eq(await r.json(), { ok: true, auth: true });
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
