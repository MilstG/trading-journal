// A server whose data goes backwards, a backup opened as a data file, and a save that waited out its
// backoff after the connection came back. The storage + sync part of app/core.js (as ledger.html ships
// it) runs in a sandbox per "device", each with its own localStorage, against the real server — which
// here gets redeployed empty, or restored from an older copy of its DATA_DIR. Pins: a device never
// takes an older or empty server copy as "newer" (it used to, and its notes were gone on every device);
// its copy is merged over the server's and sent back as a restore, and it says so. Ordinary
// multi-device sync still takes the other device's save. Opening a Backup all file restores it (asks,
// merges) and never links it, so nothing is written over its fill caches. Back online, a failed save
// goes out at once. The server answers 503 for a data file that vanished, never "no data yet".
import { createRequire } from 'node:module';
import { mkdtempSync, readdirSync, cpSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';
import { t, ok, eq, report, makeExtractor } from './harness.mjs';
import { readAppSource } from '../app-source.js';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const { createApp } = require('../server.js');
const htmlPath = join(here, '..', 'ledger.html');
const html = readAppSource(htmlPath);
const { grabFn, grabBlock } = makeExtractor(html);

// app/core.js from its storage layer through the linked file and the server sync
const i0 = html.indexOf('const Store = {'), i1 = html.indexOf('function renderDatafile(');
ok(i0 > 0 && i1 > i0, 'the storage + sync section is where this suite expects it');
const CORE = html.slice(i0, i1) + '\n' + grabFn('pbNorm') + '\n' + grabBlock('const TAX_PRESETS={') + ';\n' + grabFn('restoreBackup');

const TOKEN = 'tok';
const H = { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' };
// one address, servers coming and going behind it (a redeploy, a restore)
const srv = { app: null, base: '', dir: '' };
async function serve(dir) {
  if (srv.app) await new Promise(r => srv.app.close(r));
  srv.dir = dir;
  srv.app = createApp({ dataDir: dir, auth: TOKEN, htmlPath, push: false, pushTick: false, offsiteTimer: false, fetchImpl: async () => { throw new Error('offline'); } });
  srv.base = await new Promise(r => srv.app.listen(0, '127.0.0.1', () => r('http://127.0.0.1:' + srv.app.address().port)));
}
const tmp = p => mkdtempSync(join(tmpdir(), 'ledger-back-' + p + '-'));
const get = async () => (await fetch(srv.base + '/api/data', { headers: H })).json();
const sj = async () => Object.keys(((await get()).snapshot || {}).journal || {}).sort();
const put = async (rev, snapshot) => (await fetch(srv.base + '/api/data', { method: 'PUT', headers: H, body: JSON.stringify({ rev, snapshot }) })).status;
const otherDevice = async fn => { const cur = await get(); const s = JSON.parse(JSON.stringify(cur.snapshot || { app: 'ledger', wallets: [], settings: {}, journal: {} })); fn(s); eq(await put(cur.rev, s), 200); };

// One browser: its own localStorage (kept across a "reload"), the server's token remembered. net.off
// makes every request fail as an offline browser's does; on/fire run the window and document listeners.
function device(store, opt) {
  store = store || new Map([['srv_token', TOKEN]]); opt = opt || {};
  const localStorage = { getItem: k => store.has(k) ? store.get(k) : null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
  const on = {}, listen = (k, f) => { (on[k] = on[k] || []).push(f); }, net = { off: false, puts: 0 };
  const el = { value: '', textContent: '', classList: { toggle() {}, remove() {}, add() {} }, click() {} };
  const ctx = { console, URL, JSON, Math, Date, Map, Set, Object, Array, String, Number, Promise, Error, SyntaxError, Blob, Response,
    setTimeout, clearTimeout, setInterval: () => 0, queueMicrotask, localStorage,
    window: Object.assign({ addEventListener: listen }, opt.window || {}), navigator: {}, location: { protocol: opt.protocol || 'http:' },
    document: { querySelector: () => null, querySelectorAll: () => [], head: { appendChild() {} }, createElement: () => ({}), addEventListener: listen, visibilityState: 'visible' },
    fetch: async (p, o) => { if (net.off) throw new TypeError('Failed to fetch'); if (o && o.method === 'PUT') net.puts++; return fetch(srv.base + p, o); },
    status: [], errs: [], confirms: [], kv: new Map(), $: () => el, view: 'perp', dexView: 'all', allTrades: [], openPositions: [], spotHoldings: [] };
  ctx.confirm = m => { ctx.confirms.push(m); return opt.confirm !== undefined ? opt.confirm : true; };
  vm.createContext(ctx);
  vm.runInContext(CORE + `
    function renderDatafile(){} function renderWallets(){} function render(){} function vaultMark(){} function vaultSchedule(){} function vaultMarkAll(){}
    function sampleEnd(){} function resetDerivedState(){}
    function setStatus(m){ status.push(m); } function setErr(m){ errs.push(m); }
    async function idbGet(k){ return kv.get(k)??null; } async function idbSet(k,v){ kv.set(k,v); } async function idbDel(k){ kv.delete(k); }
    // what boot.js does after the server sync: read the settings this browser stored
    async function boot(){ await initServerSync(); journal=(await Store.get(J_KEY))||{}; settings=(await Store.get(S_KEY))||{wallets:[],riskDefault:null};
      if(!Array.isArray(settings.wallets))settings.wallets=[]; if(SRV.pushLocal){ SRV.pushLocal=false; scheduleServerWrite(); } }`, ctx);
  const run = src => vm.runInContext(src, ctx);
  const fire = k => (on[k] || []).forEach(f => f());
  return { ctx, store, run, net, fire, eval: src => JSON.parse(JSON.stringify(run(src)) ?? 'null') };
}
// a note written on a device (dated, as every edit is) and saved now
const note = (D, id, text) => D.run(`(async()=>{ journal['${id}']={review:${JSON.stringify(text)}}; markJEdit('${id}'); await Store.set(J_KEY,journal); return srvSaveNow(); })()`);
const keys = D => D.eval('Object.keys(journal).sort()');
const wait = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 4000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await fn()) return true; await wait(50); } return false; };
const six = Array.from({ length: 6 }, (_, i) => 'day:2026-09-0' + (i + 1));

console.log('\nThe server comes back empty (redeployed without its volume)');
await t('a reload onto the empty server keeps all 6 notes and puts them back; a new device then sees them', async () => {
  await serve(tmp('a1'));
  const A = device(); await A.run('boot()');
  for (const id of six) eq(await note(A, id, 'A ' + id), true);
  eq(await sj(), six);
  await serve(tmp('a2')); // same browser storage, a server with nothing
  const A2 = device(A.store); await A2.run('boot()');
  eq(keys(A2), six, 'kept here');
  ok(await until(async () => (await sj()).length === 6), 'and saved back: ' + JSON.stringify(await sj()));
  ok(A2.ctx.errs.some(m => /server had lost its data/.test(m)), 'told in plain words: ' + A2.ctx.errs.join(' | '));
  const C = device(); await C.run('boot()');
  eq(keys(C), six, 'a new device gets them');
  eq(await note(C, 'day:2026-10-05', 'C phone note'), true);
  eq(await A2.run('srvCheckNewer()'), true); eq(keys(A2), [...six, 'day:2026-10-05'].sort(), 'and ordinary sync carries on');
});
await t('a new device saves to the empty server first: an open tab’s next check keeps its 6 and adds the 1, and so does a reload', async () => {
  await serve(tmp('b1'));
  const A = device(); await A.run('boot()');
  for (const id of six) eq(await note(A, id, 'A ' + id), true);
  const kept = new Map(A.store); // the same browser's storage, for a reload later
  await serve(tmp('b2'));
  const C = device(); await C.run('boot()'); eq(await note(C, 'day:2026-10-05', 'C phone note'), true);
  eq(await sj(), ['day:2026-10-05']);
  // the tab comes back into view: the same revision number (1), another store
  await A.run('_srvChk=0'); eq(await A.run('srvCheckNewer()'), true);
  eq(keys(A), [...six, 'day:2026-10-05'].sort(), 'used to be the 1 note alone');
  ok(await until(async () => (await sj()).length === 7), 'the merge is saved: ' + JSON.stringify(await sj()));
  eq(await C.run('srvCheckNewer()'), true); eq(keys(C).length, 7, 'and reaches the other device');
  ok(readdirSync(join(srv.dir, 'snapshots')).some(f => f.startsWith('pre-restore-')), 'sent as a restore');
  // the same, from a reload instead of an open tab
  await serve(tmp('b3')); const C2 = device(); await C2.run('boot()'); eq(await note(C2, 'day:2026-10-06', 'C2'), true);
  const A2 = device(kept); await A2.run('boot()');
  eq(keys(A2), [...six, 'day:2026-10-06'].sort());
  ok(await until(async () => (await sj()).length === 7));
});
await t('an open tab whose next save meets the replaced store (a 409 from another store) keeps everything', async () => {
  await serve(tmp('c1'));
  const A = device(); await A.run('boot()');
  for (const id of six) eq(await note(A, id, 'A ' + id), true);
  await serve(tmp('c2'));
  const C = device(); await C.run('boot()'); eq(await note(C, 'day:2026-10-05', 'C'), true); // rev 1 of another store: the same number A holds
  eq(await note(A, 'day:2026-10-06', 'A again'), true, 'saved, after merging');
  eq(await sj(), [...six, 'day:2026-10-05', 'day:2026-10-06'].sort());
  ok(A.ctx.errs.some(m => /older than this browser’s/.test(m)), A.ctx.errs.join(' | '));
});

console.log('\nThe server is restored from an older bundle');
await t('A wrote 4 notes after the bundle was taken: a reload keeps all 10, saves them back, and the server keeps a copy of what it had', async () => {
  const D = tmp('r1'), B = tmp('rb'); await serve(D);
  const A = device(); await A.run('boot()');
  for (const id of six) eq(await note(A, id, 'A ' + id), true);
  cpSync(D, B, { recursive: true }); // last night's bundle
  const four = ['day:2026-10-01', 'day:2026-10-02', 'day:2026-10-03', 'day:2026-10-04'];
  for (const id of four) eq(await note(A, id, 'after the bundle ' + id), true);
  rmSync(join(B, 'snapshots'), { recursive: true, force: true });
  await serve(B);
  eq((await sj()).length, 6, 'the server went back to the bundle');
  const A2 = device(A.store); await A2.run('boot()');
  eq(keys(A2).length, 10, 'used to be 6: the 4 newer notes were gone');
  ok(await until(async () => (await sj()).length === 10), 'saved back: ' + (await sj()).length);
  ok(readdirSync(join(B, 'snapshots')).some(f => f.startsWith('pre-restore-')), 'sent as a restore: the server kept the bundle’s copy');
  ok(A2.ctx.errs.some(m => /older than this browser’s.*4 journal entries/.test(m)), A2.ctx.errs.join(' | '));
});
await t('restored, then saved past A’s revision by another device: A still keeps its newer notes (the history of times tells)', async () => {
  const D = tmp('s1'), B = tmp('sb'); await serve(D);
  const A = device(); await A.run('boot()');
  for (const id of six) eq(await note(A, id, 'A ' + id), true);
  cpSync(D, B, { recursive: true });
  eq(await note(A, 'day:2026-10-01', 'newer'), true); eq(await note(A, 'day:2026-10-02', 'newer'), true); // rev 8
  await serve(B); // rev 6
  for (let i = 0; i < 3; i++) await otherDevice(s => { s.journal['p:' + i] = { review: 'phone ' + i, updatedAt: Date.now() }; }); // rev 9: past A's 8
  const A2 = device(A.store); await A2.run('boot()');
  eq(keys(A2), [...six, 'day:2026-10-01', 'day:2026-10-02', 'p:0', 'p:1', 'p:2'].sort());
  ok(await until(async () => (await sj()).length === 11));
});
await t('an entry both copies have goes to the later edit', async () => {
  const D = tmp('u1'), B = tmp('ub'); await serve(D);
  const A = device(); await A.run('boot()');
  eq(await note(A, 'x:1', 'old text'), true); eq(await note(A, 'x:2', 'kept'), true);
  cpSync(D, B, { recursive: true });
  eq(await note(A, 'x:1', 'new text'), true);
  await serve(B);
  const A2 = device(A.store); await A2.run('boot()');
  eq(A2.eval("[journal['x:1'].review,journal['x:2'].review]"), ['new text', 'kept']);
  ok(await until(async () => (await get()).snapshot.journal['x:1'].review === 'new text'));
});

console.log('\nOrdinary sync is unchanged');
await t('another device’s save is still taken (no "older" notice); its version check passes the history', async () => {
  await serve(tmp('n1'));
  const A = device(); await A.run('boot()'); eq(await note(A, 'n:1', 'mine'), true);
  await otherDevice(s => { s.journal['n:1'] = { review: 'edited on the phone', updatedAt: 1 }; s.journal['n:2'] = { review: 'phone' }; });
  const A2 = device(A.store); await A2.run('boot()');
  eq(A2.eval("journal['n:1'].review"), 'edited on the phone', 'theirs, though older-dated: an ordinary newer save wins whole');
  eq(A2.eval('SRV.replaced||null'), null); eq(A2.ctx.errs, []);
  await otherDevice(s => { s.journal['n:3'] = { review: 'again' }; });
  eq(await A2.run('srvCheckNewer()'), true); eq(A2.eval('SRV.replaced||null'), null); eq(keys(A2), ['n:1', 'n:2', 'n:3']);
  const s = await get(); ok(Array.isArray(s.hist) && s.hist.at(-1)[0] === s.rev && s.hist.at(-1)[1] === s.at, JSON.stringify(s.hist));
});
await t('a browser from before the version check (a mark with only rev) and a store without an id sync as before', async () => {
  const D = tmp('o1'); mkdirSync(D, { recursive: true });
  writeFileSync(join(D, 'ledger-data.json'), JSON.stringify({ rev: 4, snapshot: { journal: { 'o:1': { review: 'server' } }, wallets: [] } }));
  await serve(D);
  const store = new Map([['srv_token', TOKEN], ['srv_sync', JSON.stringify({ rev: 3, dirty: false })], ['hl_journal_v1', JSON.stringify({ 'o:1': { review: 'stale here' } })]]);
  const A = device(store); await A.run('boot()');
  eq(A.eval("journal['o:1'].review"), 'server'); eq(A.eval('SRV.replaced||null'), null);
  eq(await note(A, 'o:2', 'x'), true); ok(typeof (await get()).storeId === 'string', 'the first save gives the store its id');
  eq(A.eval('typeof SRV.storeId'), 'string');
});
await t('the server refuses a save made on another store or another version of the same revision', async () => {
  await serve(tmp('v1'));
  eq(await put(0, { journal: {} }), 200); const g = await get();
  const st = async b => (await fetch(srv.base + '/api/data', { method: 'PUT', headers: H, body: JSON.stringify(Object.assign({ rev: g.rev, snapshot: { journal: {} } }, b)) })).status;
  eq(await st({ storeId: 'someotherstore' }), 409); eq(await st({ at: '2020-01-01T00:00:00.000Z' }), 409);
  eq(await st({ storeId: g.storeId, at: g.at }), 200); eq((await get()).storeId, g.storeId, 'kept by every write');
});

console.log('\nBack online');
await t('an "online" event sends a failed save at once, not at the end of a 2-minute backoff', async () => {
  await serve(tmp('m1'));
  const A = device(); await A.run('boot()');
  A.net.off = true;
  await A.run(`(async()=>{ journal['m:1']={review:'offline note'}; markJEdit('m:1'); await Store.set(J_KEY,journal); clearTimeout(_srvTimer); await writeServer(); })()`);
  eq(A.eval('SRV.err'), 'server unreachable');
  await A.run('syncFailed("server unreachable")'); A.run('SRV.retryMs=120000; clearTimeout(_srvTimer); _srvTimer=setTimeout(writeServer,120000)'); // as after minutes offline
  A.net.off = false; A.fire('online');
  ok(await until(async () => (await sj()).includes('m:1'), 2000), 'reached the server right away');
  ok(await until(() => A.eval('!SRV.err')), 'the bar reads saved again');
});
await t('focus or the tab coming back retries a failed save too; not during a lockout, and not more than every 3 s', async () => {
  await serve(tmp('m2'));
  const A = device(); await A.run('boot()');
  A.net.off = true; await A.run(`(async()=>{ journal['m:2']={review:'x'}; markJEdit('m:2'); clearTimeout(_srvTimer); await writeServer(); clearTimeout(_srvTimer); _srvRetryAt=0; })()`);
  A.net.off = false;
  await A.run('syncFailed("Locked out",60000); clearTimeout(_srvTimer)'); const p0 = A.net.puts;
  A.fire('focus'); await wait(200); eq(A.net.puts, p0, 'a lockout’s wait is the server’s');
  await A.run('SRV.lockUntil=0'); A.fire('visibilitychange');
  ok(await until(async () => (await sj()).includes('m:2'), 2000));
  const p1 = A.net.puts; await A.run('SRV.err="x"'); A.fire('focus'); await wait(200); eq(A.net.puts, p1, 'throttled');
  await A.run('SRV.err=null');
});
await t('srvWatch listens for "online"', () => { ok(/addEventListener\('online'/.test(grabFn('srvWatch'))); });

console.log('\nOpening a file (standalone, no server)');
// a picked file, in memory: what it holds, and every write made to it
const fileH = (name, obj) => { const h = { name, text: JSON.stringify(obj), writes: 0,
  queryPermission: async () => 'granted', requestPermission: async () => 'granted',
  getFile: async () => ({ text: async () => h.text }),
  createWritable: async () => { let b = ''; return { write: async s => { b += s; }, close: async () => { h.text = b; h.writes++; } }; } }; return h; };
const ADDR = '0x' + '1'.repeat(40);
const backup = { app: 'ledger', version: 9, wallets: [{ address: ADDR, label: 'main' }], settings: { tz: 'utc' },
  journal: { 'day:2026-09-01': { review: 'old review', updatedAt: 1 } },
  fillCaches: { [ADDR]: { v: 2, last: 1756684800000, fills: [{ coin: 'BTC', time: 1756684800000, px: '1', sz: '1', side: 'B' }] } } };
const standalone = (h, confirm) => { const D = device(new Map(), { protocol: 'file:', confirm, window: { showSaveFilePicker() {}, showOpenFilePicker: async () => [h] } });
  D.run(`journal={'day:2026-10-04':{review:'NEW WORK since the backup',updatedAt:Date.now()}}; settings={wallets:[],riskDefault:null};`); return D; };
await t('Open existing on a Backup all file asks, merges (the newer note stays), restores the fill caches, and is not linked or written', async () => {
  const h = fileH('ledger-backup-2026-09-01.json', backup), D = standalone(h);
  await D.run('openExistingFile()');
  eq(D.ctx.confirms.length, 1, 'it asks'); ok(/Restore the backup ledger-backup-2026-09-01\.json \(1 journal entry\)/.test(D.ctx.confirms[0]), D.ctx.confirms[0]);
  eq(keys(D), ['day:2026-09-01', 'day:2026-10-04'], 'used to be the backup’s single entry');
  ok(D.ctx.kv.has('flc:' + ADDR), 'fill caches restored'); ok(!D.ctx.kv.has('handle'), 'not linked'); eq(D.eval('linkedHandle'), null);
  await D.run(`(async()=>{ journal['day:2026-10-05']={review:'edit'}; markJEdit('day:2026-10-05'); await Store.set(J_KEY,journal); })()`); await wait(900);
  eq(h.writes, 0); ok(JSON.parse(h.text).fillCaches, 'the backup keeps its fill caches');
  // declined: nothing changes
  const D2 = standalone(fileH('b.json', backup), false); await D2.run('openExistingFile()'); eq(keys(D2), ['day:2026-10-04']);
});
await t('Open existing on a data file asks before merging with a journal that has notes, then links it and writes the merge', async () => {
  const data = { app: 'ledger', wallets: [], settings: {}, journal: { 'f:1': { review: 'in the file', updatedAt: 5 } } };
  const no = fileH('ledger-data.json', data), D0 = standalone(no, false); await D0.run('openExistingFile()');
  eq(D0.ctx.confirms.length, 1); eq(keys(D0), ['day:2026-10-04'], 'declined: untouched'); eq(D0.eval('linkedHandle'), null);
  const h = fileH('ledger-data.json', data), D = standalone(h); await D.run('openExistingFile()');
  ok(/Link ledger-data\.json \(1 journal entry\)\?.*including 1 the file doesn’t have/s.test(D.ctx.confirms[0]), D.ctx.confirms[0]);
  eq(keys(D), ['day:2026-10-04', 'f:1']); eq(D.eval('linkedName'), 'ledger-data.json');
  eq(Object.keys(JSON.parse(h.text).journal).sort(), ['day:2026-10-04', 'f:1'], 'the file holds the merge');
  // an empty journal here: nothing to lose, no question
  const E = standalone(fileH('d.json', data)); E.run('journal={}'); await E.run('openExistingFile()'); eq(E.ctx.confirms.length, 0); eq(keys(E), ['f:1']);
});
await t('a backup linked by an older build is never written over (and Reconnect won’t relink it)', async () => {
  const h = fileH('ledger-backup.json', backup), D = standalone(h);
  D.ctx.picked = h; await D.run(`(async()=>{ linkedHandle=picked; linkedName='ledger-backup.json'; await idbSet('handle',picked); await writeLinked(); })()`);
  eq(h.writes, 0); ok(JSON.parse(h.text).fillCaches); eq(D.eval('linkedHandle'), null); ok(!D.ctx.kv.has('handle'));
  ok(D.ctx.errs.some(m => /full backup \(fill caches included\), so it isn’t linked and nothing is saved over it/.test(m)), D.ctx.errs.join(' | '));
  const R = standalone(h); R.ctx.kv.set('handle', h); await R.run('reconnectFile()');
  eq(keys(R), ['day:2026-10-04'], 'not applied'); ok(!R.ctx.kv.has('handle'));
});

console.log('\nThe data volume disappears under a running server');
await t('a vanished data file answers 503 (never "no data yet"), without the server’s paths; att/ and backups/ come back with the volume', async () => {
  const D = tmp('g1'); await serve(D);
  eq(await put(0, { journal: { a: {} } }), 200); eq(await put(1, { journal: { a: {}, b: {} } }), 200);
  rmSync(D, { recursive: true, force: true });
  const r = await fetch(srv.base + '/api/data', { headers: H }), body = await r.text();
  eq(r.status, 503); ok(/missing/.test(body) && !body.includes(D), body);
  eq((await fetch(srv.base + '/api/data?only=rev', { headers: H })).status, 503);
  eq(await put(2, { journal: {} }), 503); eq(await put(0, { journal: {} }), 503, 'a stale or fresh save can’t start a new store over it');
  const bk = await fetch(srv.base + '/api/backup', { method: 'POST', headers: H, body: JSON.stringify({ app: 'ledger', journal: {} }) }), bt = await bk.text();
  eq(bk.status, 500, 'nowhere to write it: no folder is made where the volume was'); ok(!bt.includes(D), 'no absolute path in the error: ' + bt);
  ok(!existsSync(D));
  mkdirSync(D); // the volume remounted, empty
  eq((await fetch(srv.base + '/api/data', { headers: H })).status, 503, 'still not a fresh install: this process served rev 2');
  eq((await fetch(srv.base + '/api/backup', { method: 'POST', headers: H, body: JSON.stringify({ app: 'ledger', journal: {} }) })).status, 200, 'backups/ recreated');
  eq((await fetch(srv.base + '/api/att/abc', { method: 'PUT', headers: H, body: JSON.stringify(['data:image/png;base64,AAAA']) })).status, 200, 'att/ recreated');
  // a fresh process on an empty folder is a fresh install
  await serve(tmp('g2')); eq(await get(), { rev: 0, snapshot: null });
});
await t('a write that fails names the reason, not the path', async () => {
  const D = tmp('w1'); await serve(D);
  rmSync(D, { recursive: true, force: true }); writeFileSync(D, 'not a folder');
  const r = await fetch(srv.base + '/api/data', { method: 'PUT', headers: H, body: JSON.stringify({ rev: 0, snapshot: { journal: {} } }) }), b = await r.text();
  eq(r.status, 500); ok(/^\{"error":"write failed \(E[A-Z]+\)"\}$/.test(b) && !b.includes(D), b);
  rmSync(D, { force: true });
});
await t('an unusable DATA_DIR stops the boot with one line naming it, not a stack trace', () => {
  const f = join(tmp('L6'), 'afile'); writeFileSync(f, 'x');
  const p = spawnSync(process.execPath, [join(here, '..', 'server.js')], { env: Object.assign({}, process.env, { DATA_DIR: join(f, 'sub'), PORT: '0', AUTH_TOKEN: 'x' }), encoding: 'utf8', timeout: 20000 });
  eq(p.status, 1); const err = p.stderr.trim();
  ok(/^\[ledger\] DATA_DIR .*afile\/sub is not usable: part of that path is a file, not a folder\./.test(err) && !/\n\s+at /.test(err), err);
  ok(!existsSync(join(f, 'sub')));
});

await new Promise(r => srv.app.close(r));
report('sync-backwards');
