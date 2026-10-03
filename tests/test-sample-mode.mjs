// Sample data never touches the account, and the award ledger can be reset. The storage + sync part of
// app/core.js runs for real (as in test-sync-client) in a sandbox per "device" against the real server,
// with loadFromPaste and the award ledger's functions from the app beside it. Pins: in sample mode the
// journal, the award ledger, the week's challenge and plans stay off the server and out of this browser's
// storage, while wallets and preferences still save; pasted fills are the user's own and do save; leaving
// sample mode brings the account's own copy back; a 409 met while the sample is up merges afterwards; and
// a reset of the ledger survives a merge with a device that still holds the old awards.
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
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
const { grabFn, grabBlock } = makeExtractor(html);

const i0 = html.indexOf('const Store = {'), i1 = html.indexOf('async function connectServerToken(');
ok(i0 > 0 && i1 > i0, 'the storage + sync section is where this suite expects it');
const CORE = html.slice(i0, i1) + '\n' + grabFn('pbNorm') + '\n' + grabBlock('const TAX_PRESETS={') + ';\n' +
  ['isDemoData', 'loadFromPaste', 'safeCoin', 'pzEarned', 'pzEarnedRecord', 'pzEarnedReset'].map(grabFn).join('\n');
ok(CORE.includes('let _sample=null'), 'sample mode lives in the storage layer');

const TOKEN = 'tok';
const app = createApp({ dataDir: mkdtempSync(join(tmpdir(), 'ledger-sample-')), auth: TOKEN, htmlPath, push: false, offsiteTimer: false, fetchImpl: async () => { throw new Error('offline'); } });
const BASE = await new Promise(r => app.listen(0, '127.0.0.1', () => r('http://127.0.0.1:' + app.address().port)));
const H = { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' };
const get = async () => (await fetch(BASE + '/api/data', { headers: H })).json();
const put = async (rev, snapshot) => (await fetch(BASE + '/api/data', { method: 'PUT', headers: H, body: JSON.stringify({ rev, snapshot }) })).status;
const otherDevice = async fn => { const cur = await get(); const s = JSON.parse(JSON.stringify(cur.snapshot)); fn(s); eq(await put(cur.rev, s), 200); };
const W = c => '0x' + c.repeat(40);
const WEEK = 'week:2026-W40';

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
    // what loadFromPaste leans on, minus the reconstruction (one trade per fill) and the drawing
    var allTrades=[], openPositions=[], spotHoldings=[], accountValue=null, spotAccountValue=null, unifiedAccountValue=null, hlPnl={}, fillsTruncated=[], _pastedFills=null;
    var spotMaps={nameByCoin:{x:1},quoteByCoin:{}}, _gameMemo={key:null,g:null};
    function pasteDeriveFills(){ return 0; } function resetDerivedState(){} function render(){} function $(){ return {classList:{add(){},remove(){}}}; }
    async function reconstructCompute(fills){ return {perp:fills.map(f=>({id:'paste:'+f.coin+':'+f.time,coin:f.coin,openTime:f.time})),spot:[]}; }
    function sampleEnd(){ if(sampleLeave())allTrades=[]; }
    function isoWeekKey(){ return '${WEEK}'; }
    async function boot(){ await initServerSync(); journal=(await Store.get(J_KEY))||{}; settings=(await Store.get(S_KEY))||{wallets:[],riskDefault:null};
      if(!Array.isArray(settings.wallets))settings.wallets=[]; if(SRV.pushLocal){ SRV.pushLocal=false; scheduleServerWrite(); } }`, ctx);
  const run = src => vm.runInContext(src, ctx);
  return { ctx, store, run, eval: src => JSON.parse(JSON.stringify(run(src)) ?? 'null') };
}
const fills = (coin, n) => Array.from({ length: n }, (_, i) => ({ coin, time: Date.UTC(2026, 8, 1 + i), side: 'B', sz: '1', px: '1' }));
const OLD_AWARDS = { 'a:first-plan': { at: '2026-09-01', xp: 50 }, 'b:days-10': { at: '2026-09-12', xp: 5 } };
const REAL = { app: 'ledger', wallets: [{ address: W('1'), label: 'main' }], settings: { tz: 'utc', colorway: 'ts9', pzEarned: OLD_AWARDS },
  journal: { 'day:2026-09-30': { review: 'REAL NOTE' }, [WEEK]: { challenge: { spec: { kind: 'process', part: 'plan' }, from: 1, to: 2 } } } };
eq(await put(0, REAL), 200);

console.log('\nSample mode stays off the account');
await t('the journal, awards, the week’s challenge, plans and habits made on sample data reach neither the server nor this browser’s storage', async () => {
  const A = device(); await A.run('boot()');
  const storedJ = A.store.get('hl_journal_v1'), storedS = JSON.parse(A.store.get('hl_settings_v3'));
  await A.run(`loadFromPaste(${JSON.stringify(fills('ETH', 6))},{offline:true,sample:true})`);
  eq(A.eval('[isDemoData(), allTrades.length, Object.keys(journal).length, settings.pzEarned||null]'), [true, 6, 0, null], 'a clean scratch copy: empty journal, no ledger');
  await A.run(`(async()=>{ const id=allTrades[0].id;
    journal[id]={notes:'a note on a sample trade',rating:4}; markJEdit(id); await Store.set(J_KEY,journal);
    journal['${WEEK}']={challenge:{spec:{kind:'avoid',pid:'coin:SOL'},from:1,to:2}}; markJEdit('${WEEK}');
    journal['pplan:1']={coin:'ETH',side:'long'}; journal['day:2026-10-03']={plan:'sample prep',plannedAt:1}; markJEdit('pplan:1'); await Store.set(J_KEY,journal);
    pzEarnedRecord({'b:days-25':{at:'2026-10-01',xp:25},'a:clean-week':{at:'2026-10-01',xp:50}});
    settings.habits=[{id:'h1',kind:'process'}]; settings.pzGoals=[{id:'g1'}]; await Store.set(S_KEY,settings); })()`);
  eq(A.eval('_dirtyJ.size'), 0, 'nothing marked for the next sync');
  eq(await A.run('srvSaveNow()'), true);
  const s = (await get()).snapshot;
  eq(s.journal, REAL.journal, 'the server journal is untouched');
  eq([s.settings.pzEarned, s.settings.habits, s.settings.pzGoals], [OLD_AWARDS, undefined, undefined], 'no award, habit or goal from the sample');
  eq(A.store.get('hl_journal_v1'), storedJ, 'this browser’s stored journal is untouched');
  eq(JSON.parse(A.store.get('hl_settings_v3')).pzEarned, storedS.pzEarned);
  ok(A.eval("journal['pplan:1'] && settings.pzEarned['b:days-25']"), 'the sample shows them on screen');
  ok(JSON.stringify(A.run('snapshot()')).indexOf('sample') < 0, 'a backup made now is the account’s');
});

await t('wallets and preferences picked while the sample is up do save; leaving brings the account’s own journal and settings back', async () => {
  const A = device(); await A.run('boot()');
  await A.run(`loadFromPaste(${JSON.stringify(fills('ETH', 3))},{offline:true,sample:true})`);
  await A.run(`(async()=>{ journal[allTrades[0].id]={notes:'sample'}; markJEdit(allTrades[0].id);
    settings.colorway='ink'; settings.wallets.push({address:'${W('2')}',label:'added'}); settings.riskDefault=999; pzEarnedRecord({'b:x-1':{at:'2026-10-01',xp:5}}); await Store.set(S_KEY,settings); })()`);
  eq(await A.run('srvSaveNow()'), true);
  let s = (await get()).snapshot;
  eq([s.settings.colorway, s.wallets.map(w => w.address), s.settings.riskDefault, s.settings.pzEarned], ['ink', [W('1'), W('2')], undefined, OLD_AWARDS],
    'a preference and a wallet are the user’s; an analysis setting and awards made on the sample are not');
  eq(A.eval('sampleLeave()'), true);
  eq(A.eval('[isDemoData(), journal, settings.pzEarned, settings.colorway, settings.wallets.length]'), [false, REAL.journal, OLD_AWARDS, 'ink', 2]);
  eq(await A.run('srvSaveNow()'), true);
  s = (await get()).snapshot; eq(s.journal, REAL.journal); eq(s.settings.pzEarned, OLD_AWARDS);
  await otherDevice(x => { x.wallets = REAL.wallets; x.settings.colorway = 'ts9'; });
});

await t('a 409 while the sample is up waits for it to go, then merges the other device’s change and nothing of the sample', async () => {
  const A = device(); await A.run('boot()');
  await A.run(`loadFromPaste(${JSON.stringify(fills('SOL', 3))},{offline:true,sample:true})`);
  await otherDevice(s => { s.journal['day:2026-10-01'] = { review: 'from phone' }; });
  eq(await A.run(`(async()=>{ journal['day:2026-10-02']={review:'sample review'}; markJEdit('day:2026-10-02'); settings.colorway='bb'; await Store.set(S_KEY,settings); return writeServer(); })()`), 'conflict');
  eq(A.eval("[Object.keys(journal), settings.colorway]"), [['day:2026-10-02'], 'bb'], 'the screen is untouched by the conflict');
  await A.run(`loadFromPaste(${JSON.stringify(fills('BTC', 2))},{offline:true})`); // real fills replace the sample
  eq(await A.run('srvSaveNow()'), true);
  const s = (await get()).snapshot;
  eq(Object.keys(s.journal).sort(), ['day:2026-09-30', 'day:2026-10-01', WEEK]);
  eq(s.settings.colorway, 'bb', 'the preference made it');
  await otherDevice(x => { x.journal = REAL.journal; x.settings.colorway = 'ts9'; });
});

console.log('\nPasted fills are the user’s own');
await t('notes on pasted fills save and sync — also after sample data was loaded first', async () => {
  const A = device(); await A.run('boot()');
  await A.run(`loadFromPaste(${JSON.stringify(fills('ETH', 3))},{offline:true,sample:true})`);
  await A.run(`loadFromPaste(${JSON.stringify(fills('DOGE', 4))},{offline:true})`);
  eq(A.eval('[isDemoData(), allTrades.every(t=>t.wallet.address==="paste"), Object.keys(journal).sort()]'), [false, true, Object.keys(REAL.journal).sort()]);
  const id = A.eval('allTrades[0].id');
  await A.run(`(async()=>{ journal['${id}']={notes:'pasted, mine'}; markJEdit('${id}'); await Store.set(J_KEY,journal); })()`);
  eq(await A.run('srvSaveNow()'), true);
  eq((await get()).snapshot.journal[id], A.eval(`journal['${id}']`), 'on the server');
  eq(JSON.parse(A.store.get('hl_journal_v1'))[id].notes, 'pasted, mine', 'and in this browser');
  ok(grabFn('loadDemo').includes('{offline:true,sample:true}'), 'only “Load sample data” asks for sample mode');
  await otherDevice(x => { x.journal = REAL.journal; });
});

await t('applying real data (a backup, a synced copy) ends sample mode before it lands', async () => {
  const A = device(); await A.run('boot()');
  await A.run(`loadFromPaste(${JSON.stringify(fills('ETH', 3))},{offline:true,sample:true})`);
  await A.run(`(async()=>{ journal['paste:x']={notes:'sample'}; await applySnapshot({journal:Object.assign({},journal,{'day:2026-01-01':{review:'backup'}})}); })()`);
  eq(A.eval('[isDemoData(), allTrades.length]'), [false, 0]);
  ok(A.eval("!!journal['day:2026-01-01']"), 'the backup landed');
  ok(grabFn('vaultUnlock').indexOf('sampleEnd()') < grabFn('vaultUnlock').indexOf('mineJ=journal'), 'a synced journal opened here never takes the sample’s notes along');
  await otherDevice(x => { x.journal = REAL.journal; });
});

console.log('\nResetting the award ledger');
await t('a reset survives a merge with a device that still has the old awards, and the ledger earns again from there', async () => {
  const A = device(), B = device(); await A.run('boot()'); await B.run('boot()');
  await A.run('pzEarnedReset()');
  const R = A.eval('settings.pzEarnedResetAt');
  ok(R > 0); eq(A.eval('[pzEarned(), journal["' + WEEK + '"].challenge||null]'), [{}, null], 'empty, and this week’s challenge is gone');
  A.run(`pzEarnedRecord({'a:first-plan':{at:'2026-10-02',xp:50}})`); // re-earned from the trades on the next computation
  eq(A.eval('pzEarned()'), { 'a:first-plan': { at: '2026-10-02', xp: 50, ep: R } });
  eq(await A.run('srvSaveNow()'), true);
  // B never saw the reset: it still holds the old awards and records one of its own, then saves (409, merge)
  A.run('0'); B.run(`pzEarnedRecord({'b:streak-5':{at:'2026-10-02',xp:5}})`);
  eq(await B.run('srvSaveNow()'), true);
  eq(B.eval('settings.pzEarnedResetAt'), R, 'the tombstone arrived');
  eq(Object.keys(B.eval('pzEarned()')), ['a:first-plan'], 'the old awards are ignored, even though the union brought them back');
  const s = (await get()).snapshot.settings;
  eq(s.pzEarnedResetAt, R, 'the server keeps the reset');
  const C = device(); await C.run('boot()');
  eq(Object.keys(C.eval('pzEarned()')), ['a:first-plan'], 'a fresh device sees the reset ledger');
  ok(!((await get()).snapshot.journal[WEEK] || {}).challenge, 'the week’s challenge stays gone');
  // a later reset wins, an older one never undoes it
  eq([A.ctx._syncMerge('pzEarnedResetAt', 5, 9), A.ctx._syncMerge('pzEarnedResetAt', 9, undefined), A.ctx._syncMerge('pzEarnedResetAt', undefined, undefined)], [9, 9, undefined]);
  await C.run(`applySnapshot({settings:{pzEarnedResetAt:${R - 1000},pzEarned:${JSON.stringify(OLD_AWARDS)}}})`);
  eq([C.eval('settings.pzEarnedResetAt'), Object.keys(C.eval('pzEarned()'))], [R, ['a:first-plan']]);
});

t('a reset is offered in the journal’s Settings and on Daruma’s Progress screen, behind a confirm', () => {
  ok(/id="earnResetBtn"/.test(html) && html.includes("$('earnResetBtn').addEventListener('click',async()=>{ if(!confirm(PZ_EARN_RESET_ASK))return;"));
  ok(grabFn('pzProgressHtml').includes('data-pz-earnreset') && html.includes('if(ds.pzEarnreset!==undefined){ if(!confirm(PZ_EARN_RESET_ASK))return; await pzEarnedReset();'));
});

console.log('\nNothing fetched in sample mode');
t('market regimes are skipped and the benchmark reads the sample’s own candles, caching nothing', () => {
  const want = grabFn('pzRegimeWant'), bench = grabFn('renderBenchmark');
  ok(want.indexOf('isDemoData()){ PZ_REG.map=null; PZ_REG.at=0; return; }') < want.indexOf('pzRegimeLoad()'), 'no BTC candles fetched for the sample, and the account’s regimes never shown on it');
  ok(grabFn('pzRegimeLoad').includes('isDemoData())return; // the sample came in meanwhile'));
  ok(bench.includes("venueFetchCandles('',coin,'1d'") && bench.includes("if(!demo){ try{ await idbSet('cnd:'+k,cache)"));
  ok(grabFn('runExcursions').includes('if(demo||t._open||persisted.rows[t.id])continue;'), 'sample measurements never join excRows (it syncs)');
});

app.close();
report('sample-mode');
