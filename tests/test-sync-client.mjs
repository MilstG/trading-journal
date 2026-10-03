// The app's server sync, run for real: the storage + sync part of app/core.js (as ledger.html ships
// it) in a sandbox per "device", each with its own localStorage, against the real server. Pins:
// a restore survives another device's newer save (the 409 merge used to undo it while the status
// said "restored"); a save waits for one in flight; wallets merge by address on a 409; a reload
// never wipes the settings a snapshot doesn't carry; and pasted JSON fills without startPosition
// get one derived instead of building nonsense trades.
import { createRequire } from 'node:module';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { t, ok, eq, report, makeExtractor } from './harness.mjs';
import { readAppSource } from '../app-source.js';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const { createApp } = require('../server.js');
const htmlPath = join(here, '..', 'ledger.html');
const html = readAppSource(htmlPath);
const { grabFn, grabBlock, evalModule } = makeExtractor(html);

// app/core.js from its storage layer through the server sync (everything up to the token prompt)
const i0 = html.indexOf('const Store = {'), i1 = html.indexOf('async function connectServerToken(');
ok(i0 > 0 && i1 > i0, 'the storage + sync section is where this suite expects it');
const CORE = html.slice(i0, i1) + '\n' + grabFn('pbNorm') + '\n' + grabBlock('const TAX_PRESETS={') + ';';

const TOKEN = 'tok';
const dataDir = mkdtempSync(join(tmpdir(), 'ledger-sync-client-'));
const app = createApp({ dataDir, auth: TOKEN, htmlPath, push: false, offsiteTimer: false, fetchImpl: async () => { throw new Error('offline'); } });
const BASE = await new Promise(r => app.listen(0, '127.0.0.1', () => r('http://127.0.0.1:' + app.address().port)));
const H = { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' };
const get = async () => (await fetch(BASE + '/api/data', { headers: H })).json();
const put = async (rev, snapshot) => (await fetch(BASE + '/api/data', { method: 'PUT', headers: H, body: JSON.stringify({ rev, snapshot }) })).status;
// another device's save, made straight against the API
const otherDevice = async fn => { const cur = await get(); const s = JSON.parse(JSON.stringify(cur.snapshot)); fn(s); eq(await put(cur.rev, s), 200); };

// One browser: its own localStorage (kept across a "reload"), the server's token remembered.
function device(store) {
  store = store || new Map([['srv_token', TOKEN]]);
  const localStorage = { getItem: k => store.has(k) ? store.get(k) : null, setItem: (k, v) => store.set(k, String(v)), removeItem: k => store.delete(k) };
  const ctx = { console, URL, JSON, Math, Date, Map, Set, Object, Array, String, Number, Promise, Error, Blob, Response,
    setTimeout, clearTimeout, queueMicrotask, localStorage, window: {}, navigator: {}, location: { protocol: 'http:' },
    document: { querySelector: () => null, head: { appendChild() {} }, createElement: () => ({}) },
    fetch: (p, o) => fetch(BASE + p, o), status: [], errs: [] };
  vm.createContext(ctx);
  vm.runInContext(CORE + `
    function renderDatafile(){} function renderWallets(){} function vaultMark(){} function vaultSchedule(){}
    function setStatus(m){ status.push(m); } function setErr(m){ errs.push(m); }
    async function idbGet(){ return null; } async function idbSet(){}
    // what boot.js does after the server sync: read the settings this browser stored
    async function boot(){ await initServerSync(); journal=(await Store.get(J_KEY))||{}; settings=(await Store.get(S_KEY))||{wallets:[],riskDefault:null};
      if(!Array.isArray(settings.wallets))settings.wallets=[]; if(SRV.pushLocal){ SRV.pushLocal=false; scheduleServerWrite(); } }`, ctx);
  const run = src => vm.runInContext(src, ctx);
  return { ctx, store, run, eval: src => JSON.parse(JSON.stringify(run(src)) ?? 'null') };
}
const W = c => '0x' + c.repeat(40);

await put(0, { app: 'ledger', wallets: [{ address: W('1'), label: 'main' }], settings: { tz: 'utc' }, journal: { 'day:2026-09-30': { review: 'GOOD NOTE' } } });

console.log('\nRestores survive another device’s newer save');
await t('a pasted full backup, after another device saved: the backup and the other device’s note both land, wallets merge by address', async () => {
  const A = device(); await A.run('boot()');
  await otherDevice(s => { s.journal['day:2026-10-02'] = { review: 'from phone' }; s.wallets.push({ address: W('2'), label: 'phone' }); });
  // the full-backup paste (app/data-io.js): applySnapshot, then the restore marks itself and saves now
  const res = await A.run(`(async()=>{ const before=journal, bw=settings.wallets;
    await applySnapshot({ wallets:[{address:'${W('3')}',label:'backup'}], settings:{tz:'local',goals:{monthlyTarget:7}},
      journal:{'day:2026-09-01':{review:'RESTORED A'},'day:2026-09-02':{review:'RESTORED B'}} });
    for(const [k,v] of Object.entries(before))if(!(k in journal))journal[k]=v; // the paste merges: notes only here are kept
    srvRestored(before,bw); return await srvSaveNow(); })()`);
  eq(res, true, 'saved (after the 409 merge)');
  const s = (await get()).snapshot;
  eq(Object.keys(s.journal).sort(), ['day:2026-09-01', 'day:2026-09-02', 'day:2026-09-30', 'day:2026-10-02']);
  eq(s.journal['day:2026-09-01'].review, 'RESTORED A');
  // the restore replaced main (1) with backup (3); the phone's wallet (2), added since, stays
  eq(s.wallets.map(w => w.address).sort(), [W('2'), W('3')]);
  eq([s.settings.tz, s.settings.goals], ['local', { monthlyTarget: 7 }], 'the restored settings win the merge');
  eq(A.eval('Object.keys(journal).sort()'), Object.keys(s.journal).sort(), 'this device shows what the server holds');
  ok(readdirSync(join(dataDir, 'snapshots')).some(f => f.startsWith('pre-restore-')), 'the server kept what the restore replaced');
});

await t('a server-snapshot restore after another device wiped the journal: the snapshot’s journal is what the server keeps', async () => {
  const A = device(); await A.run('boot()');
  await otherDevice(s => { s.journal = {}; });
  const res = await A.run(`(async()=>{ const before=journal, bw=settings.wallets;
    await applySnapshot({ wallets:[{address:'${W('3')}'}], settings:{tz:'utc'}, journal:{'day:2026-09-30':{review:'GOOD NOTE'}} });
    srvRestored(before,bw); return await srvSaveNow(); })()`);
  eq(res, true);
  eq((await get()).snapshot.journal, { 'day:2026-09-30': { review: 'GOOD NOTE' } }, 'not the wiped {}');
});

await t('a journal paste after another device saved: the pasted journal replaces this device’s, the other device’s new note is kept', async () => {
  const A = device(); await A.run('boot()');
  await otherDevice(s => { s.journal['day:2026-10-03'] = { review: 'phone, today' }; });
  const res = await A.run(`(async()=>{ const before=journal; journal={'day:2026-01-01':{review:'pasted'}}; srvRestored(before); await Store.set(J_KEY,journal); return await srvSaveNow(); })()`);
  eq(res, true);
  eq(Object.keys((await get()).snapshot.journal).sort(), ['day:2026-01-01', 'day:2026-10-03'], 'what this device had is replaced; nothing the other device added is lost');
});

await t('a restore waits for a save already in flight instead of being dropped by it', async () => {
  const A = device(); await A.run('boot()');
  await otherDevice(s => { s.journal['day:2026-10-04'] = { review: 'phone' }; });
  const res = await A.run(`(async()=>{ journal['day:2026-10-05']={review:'typed here'}; markJEdit('day:2026-10-05');
    const inflight=writeServer(); // the debounced save fires: it will meet a 409
    const before=journal, bw=settings.wallets; await applySnapshot({journal:{'day:2026-08-08':{review:'restored'}}});
    srvRestored(before,bw); const r=await srvSaveNow(); await inflight; return r; })()`);
  eq(res, true);
  const j = (await get()).snapshot.journal;
  ok(j['day:2026-08-08'] && !j['day:2026-10-05'] && j['day:2026-10-04'], JSON.stringify(j));
});

await t('srvSaveNow says when the server didn’t take it (the restore stays here and keeps retrying)', async () => {
  const A = device(); await A.run('boot()');
  eq(await A.run(`(async()=>{ SRV.token='wrong'; const before=journal; journal={'x:1':{n:1}}; srvRestored(before); return await srvSaveNow(); })()`), false);
  ok(/Backup restored here, but the server hasn’t saved it yet \(token rejected\)/.test(A.run('srvNotSaved("Backup restored")')));
  eq(A.eval('_dirtyJ.has("x:1")'), true, 'still marked for the next save');
  // no server sync (a visitor without the token): nothing to wait for
  const V = device(new Map()); await V.run('boot()'); eq(await V.run('srvSaveNow()'), null);
});

console.log('\nWallets on an ordinary 409');
await t('a wallet added here survives another device’s newer save; one removed here stays removed', async () => {
  const A = device(); await A.run('boot()');
  const start = A.eval('settings.wallets.map(w=>w.address)');
  await A.run(`(async()=>{ settings.wallets=[...settings.wallets.filter(w=>w.address!=='${start[0]}'),{address:'${W('9')}',label:'new here'}]; await Store.set(S_KEY,settings); })()`);
  await otherDevice(s => { s.wallets.push({ address: W('8'), label: 'phone' }); s.journal['day:2026-10-06'] = { review: 'x' }; });
  eq(await A.run('srvSaveNow()'), true);
  const s = (await get()).snapshot;
  eq(s.wallets.map(w => w.address).sort(), [...start.slice(1), W('8'), W('9')].sort());
  ok(s.journal['day:2026-10-06'], 'the other device’s note too');
});

console.log('\nSettings a snapshot doesn’t carry survive a reload');
await t('autoRefresh and tilt notifications are device-local and survive reloads; tilt alerts, coach detail and the tax preset sync', async () => {
  const A = device(); await A.run('boot()');
  await A.run(`(async()=>{ settings.autoRefresh=false; settings.pzTiltNotify=true; settings.pzTiltAlerts=false; settings.pzCoachDetail=true;
    settings.taxExport={preset:'uk',cur:'GBP'}; await Store.set(S_KEY,settings); return srvSaveNow(); })()`);
  eq(JSON.parse(A.store.get('srv_sync')).dirty, false, 'saved, nothing pending: the boot path that used to wipe them');
  const A2 = device(A.store); await A2.run('boot()'); // a reload: same browser storage
  eq(A2.eval('[settings.autoRefresh,settings.pzTiltNotify,settings.pzTiltAlerts,settings.pzCoachDetail,settings.taxExport]'), [false, true, false, true, { preset: 'uk', cur: 'GBP' }]);
  await otherDevice(s => { s.journal['day:2026-10-07'] = { review: 'y' }; }); // and after another device saved
  const A3 = device(A.store); await A3.run('boot()');
  eq(A3.eval('[settings.autoRefresh,settings.pzTiltNotify]'), [false, true]);
  const B = device(); await B.run('boot()'); // a fresh device
  eq(B.eval('[settings.autoRefresh,settings.pzTiltNotify,settings.pzTiltAlerts,settings.pzCoachDetail,settings.taxExport]'), [null, null, false, true, { preset: 'uk', cur: 'GBP' }]);
  const s = (await get()).snapshot.settings;
  ok(!('autoRefresh' in s) && !('pzTiltNotify' in s), 'device-local fields never reach the server');
  // an unknown preset would throw in the tax screen: it isn't taken
  await A.run(`applySnapshot({settings:{taxExport:{preset:'constructor',cur:'x'}}})`);
  eq(A.eval('settings.taxExport'), { preset: 'uk', cur: 'GBP' });
});

await t('every restore path marks itself and reports only after the server took it', () => {
  const io = html.slice(html.indexOf("$('modalLoad').onclick"), html.indexOf("$('exportCsv').onclick"));
  ok(io.includes('srvRestored(before,bw)') && io.includes('srvRestored(before)'), 'backup and journal pastes mark the restore');
  eq((io.match(/if\(await srvSaveNow\(\)===false\)/g) || []).length, 2, 'both wait for the server before saying "restored"');
  ok(io.indexOf('srvSaveNow()') < io.indexOf("setStatus('Backup restored: '"));
  const hist = grabFn('toggleSnapHistory');
  ok(hist.includes('srvRestored(before,bw)') && /if\(await srvSaveNow\(\)===false\)\{[^}]*return; \}\s*location\.reload\(\)/.test(hist), 'History reloads only after a 2xx');
  ok(!hist.includes('await writeServer(); location.reload()'));
});

console.log('\nPasted JSON fills');
await t('fills without startPosition get it derived: buy 1 @100, sell 1 @110 is a closed Long, +10', async () => {
  const PRE = 'const _be=50; const isWin=n=>n>_be; const isLoss=n=>n<-_be;';
  const { pasteDeriveFills, reconstructTrades } = await evalModule(['deriveFillPositions', 'pasteDeriveFills', 'isPerp', 'newTrade', 'tallyFill', 'reconstructTrades'], ['pasteDeriveFills', 'reconstructTrades'], PRE);
  const T = Date.UTC(2026, 0, 1), Hr = 3600e3;
  // newest first, as an API dump usually is; no startPosition or closedPnl
  const fills = [{ coin: 'BTC', time: T + Hr, side: 'A', sz: '1', px: '110', fee: '0.1' }, { coin: 'BTC', time: T, side: 'B', sz: '1', px: '100', fee: '0.1' }];
  eq(pasteDeriveFills(fills), 1);
  eq(fills.map(f => [f.startPosition, f.closedPnl]), [['1', '10'], ['0', '0']]);
  const tr = reconstructTrades(fills, 'paste', 'perp');
  eq(tr.length, 1); eq([tr[0].dir, !!tr[0].isOpen, tr[0].avgEntry], ['Long', false, 100]);
  ok(Math.abs(tr[0].pnl - 10) < 1e-9, 'pnl ' + tr[0].pnl);
  // fills that carry it are left exactly as they are
  const full = [{ coin: 'ETH', time: T, side: 'B', sz: '2', px: '10', startPosition: '5', closedPnl: '0' }];
  eq(pasteDeriveFills(full), 0); eq(full[0].startPosition, '5');
  ok(grabFn('loadFromPaste').includes('pasteDeriveFills(fills)'), 'every paste goes through it');
});

app.close();
report('sync-client');
