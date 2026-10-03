// Ledger app · part 1 of 15: storage, the linked data file, server sync, the Hyperliquid API.
// ledger.html loads the parts in order as classic scripts sharing one global scope. Code that
// runs while a part loads (not inside a function called later) may only use names declared in
// this part or an earlier one; the boot part runs last. See "Development and testing" in README.md.

// Pulse view (/pulse) — set by the small script at the top of <body>; see section 11.
const PZ=document.body.classList.contains('pz-mode');
/* NOTE for editors: server.js and the test suites extract functions from this file by
   brace-matching from a top-level `function NAME(` header (single source of truth — no
   second copy of the math). Two constraints follow: functions on the extraction lists
   must stay top-level function declarations, and none of them may carry an unbalanced
   { or } inside a string or regex literal — extraction would truncate at the stray brace.
   The server validates at boot and loudly disables its engine if this breaks. */
/* ============================ storage ============================ */
const Store = {
  async get(key){
    if(window.storage){ try{ const r=await window.storage.get(key); return r?JSON.parse(r.value):null; }catch(e){ return null; } }
    try{ const v=localStorage.getItem(key); return v?JSON.parse(v):null; }catch(e){ return null; }
  },
  async set(key,val){
    const s=JSON.stringify(val);
    if(window.storage){ try{ await window.storage.set(key,s); }catch(e){ try{localStorage.setItem(key,s);}catch(e2){ storeFailed(e2); } } }
    else { try{ localStorage.setItem(key,s); }catch(e){ storeFailed(e); } }
    if(key===S_KEY)vaultMark(null); // a member's encrypted journal sync keeps this device's newer settings in a merge
    schedulePersist();
  }
};
const J_KEY='hl_journal_v1', S_KEY='hl_settings_v3';
let journal={}, settings={wallets:[],riskDefault:null};
// "0x1234…abcd"; other venues read "Lighter 0x1234…abcd", "Bybit key 3f9a…"
const walletShort=a=>{ a=String(a||''); const m=/^(lighter|bybit|binance):(.+)$/.exec(a);
  if(!m)return a.slice(0,6)+'…'+a.slice(-4);
  return m[1]==='lighter'?'Lighter '+m[2].slice(0,6)+'…'+m[2].slice(-4):(m[1]==='bybit'?'Bybit':'Binance')+' key '+m[2].slice(0,4)+'…'; };
const labelFor=w=>w&&(w.label||walletShort(w.address))||'';

/* ============================ linked data file (persistence) ============================ */
// Optionally bind the journal+wallets+settings to a real JSON file on disk via the
// File System Access API. Auto-saves on every change, re-loads on launch. The file is
// yours — drop it in a Dropbox/iCloud/Drive folder to sync across devices.
const FSA = ('showSaveFilePicker' in window);
let linkedHandle=null, linkedName='', _writeTimer=null, _applying=false;
// one connection for the page's life (opening a new one per read was a measurable boot cost);
// a failed open, or another tab upgrading the database, clears it so the next call reopens
let _idbP=null;
function idb(){ if(_idbP)return _idbP;
  _idbP=new Promise((res,rej)=>{ const r=indexedDB.open('ledger_fs',1);
    r.onupgradeneeded=()=>r.result.createObjectStore('kv');
    r.onsuccess=()=>{ const db=r.result; db.onversionchange=()=>{ db.close(); _idbP=null; }; db.onclose=()=>{ _idbP=null; }; res(db); };
    r.onerror=()=>{ _idbP=null; rej(r.error); }; });
  return _idbP; }
// IndexedDB write failures (quota above all) used to resolve as success — the fill cache,
// the one thing preserving history beyond the API's page cap, could silently stop saving.
// idbSet still never throws (call sites are fire-and-forget by design), but the first
// failure is surfaced once in the status bar so the user knows their caches stopped.
let _idbWarned=false;
function _idbFail(e){ if(_idbWarned)return; _idbWarned=true;
  const quota=e&&(e.name==='QuotaExceededError'||/quota/i.test(String(e&&e.message||e)));
  try{ setErr(quota
    ?'Browser storage is full — fill/candle caches can no longer save. Clear candle cache to free space, and export a backup: history beyond the API page cap is otherwise at risk.'
    :'Browser storage write failed ('+(e&&e.name||'unknown')+') — caches may not persist. Export a backup.'); }catch(_){}
}
async function idbSet(k,v){ try{ const db=await idb(); return await new Promise((res,rej)=>{ const tx=db.transaction('kv','readwrite'); tx.objectStore('kv').put(v,k); tx.oncomplete=()=>res(); tx.onerror=()=>rej(tx.error); tx.onabort=()=>rej(tx.error); }); }catch(e){ _idbFail(e); } }
async function idbGet(k){ try{ const db=await idb(); return new Promise((res)=>{ const tx=db.transaction('kv','readonly'); const rq=tx.objectStore('kv').get(k); rq.onsuccess=()=>res(rq.result); rq.onerror=()=>res(null); }); }catch(e){ return null; } }
async function idbDel(k){ try{ const db=await idb(); return new Promise((res)=>{ const tx=db.transaction('kv','readwrite'); tx.objectStore('kv').delete(k); tx.oncomplete=()=>res(); tx.onerror=()=>res(); }); }catch(e){} }
async function idbKeys(prefix){ try{ const db=await idb(); return new Promise((res)=>{ const tx=db.transaction('kv','readonly'); const rq=tx.objectStore('kv').getAllKeys();
  rq.onsuccess=()=>res((rq.result||[]).filter(k=>typeof k==='string'&&(!prefix||k.startsWith(prefix)))); rq.onerror=()=>res([]); }); }catch(e){ return []; } }

// Shape guard for fill caches: v2 = plain JSON (portable, used in backups), v3 = gzipped
// bytes (what IndexedDB actually stores — 5-10x smaller for large wallets). Only well-formed
// caches keyed by a plausible EVM address pass, so a malformed backup can't poison
// IndexedDB or reconstruction.
function validFillCache(addr,c){
  // a Hyperliquid 0x address, a Lighter one ("lighter:0x…"), or an exchange key's id ("bybit:<12 hex>") — venues.js
  if(typeof addr!=='string' || !/^(?:(?:lighter:)?0x[0-9a-fA-F]{40}|(?:bybit|binance):[0-9a-f]{12})$/.test(addr) || !c) return false;
  if(c.v===2) return Array.isArray(c.fills) && typeof c.last==='number'
    && c.fills.every(f=>f&&typeof f.time==='number'&&typeof f.coin==='string');
  if(c.v===3) return typeof c.last==='number' && !!c.gz
    && (c.gz instanceof Uint8Array || c.gz instanceof ArrayBuffer
        || (typeof Blob!=='undefined' && c.gz instanceof Blob)
        || (c.gz.buffer instanceof ArrayBuffer));
  return false;
}
// Fill-cache compression: CompressionStream('gzip') cuts the stored cache ~5-10x, pushing
// the practical IndexedDB ceiling out for large wallets without touching the architecture.
// Falls back to the plain v2 shape wherever CompressionStream is unavailable, and readers
// accept both — so old caches, old backups, and old browsers all keep working.
async function gzipBytes(str){
  if(typeof CompressionStream==='undefined')return null;
  try{ const stream=new Blob([str]).stream().pipeThrough(new CompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }catch(e){ return null; }
}
async function gunzipStr(bytes){
  const stream=new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return await new Response(stream).text();
}
// exchange-key wallets keep two small extras beside the fills: the symbols traded (Binance asks
// per symbol) and the positions held before the history begins (venues.js)
const cacheExtras=(to,from)=>{ if(from&&from.syms)to.syms=from.syms; if(from&&from.seed)to.seed=from.seed; if(from&&from.more)to.more=from.more; return to; };
async function packFillCache(fills,last){
  const gz=await gzipBytes(JSON.stringify(fills));
  return gz ? {v:3,gz,last,count:fills.length,savedAt:Date.now()}
            : {v:2,fills,last,savedAt:Date.now()};
}
async function unpackFillCache(c){
  if(!c)return null;
  if(c.v===2&&Array.isArray(c.fills))return c;
  if(c.v===3&&c.gz){ try{ const fills=JSON.parse(await gunzipStr(c.gz));
    if(!Array.isArray(fills))return null;
    const out={v:2,fills,last:c.last,savedAt:c.savedAt}; if(c.syms)out.syms=c.syms; if(c.seed)out.seed=c.seed; if(c.more)out.more=c.more; return out;
  }catch(e){ return null; } }
  return null;
}
function snapshot(){ return {app:'ledger',version:8,exportedAt:new Date().toISOString(),
  wallets:settings.wallets, settings:{riskDefault:settings.riskDefault,view:settings.view,dexView:settings.dexView,rBasis:settings.rBasis,pageSize:settings.pageSize,beThreshold:settings.beThreshold,theme:settings.theme,anaBasis:settings.anaBasis,tz:settings.tz,assumedLev:settings.assumedLev,rules:settings.rules,attribBasis:settings.attribBasis,goals:settings.goals,
    pins:settings.pins, habits:settings.habits, tzZone:settings.tzZone, calMode:settings.calMode, calWeeks:settings.calWeeks, coachMode:settings.coachMode, pzPlugs:settings.pzPlugs, pzProfile:settings.pzProfile, pzMarket:settings.pzMarket, pzLayout:settings.pzLayout, pzLessons:settings.pzLessons, pzGoals:settings.pzGoals, playbooks:settings.playbooks, colorway:settings.colorway,appearance:settings.appearance}, journal}; } // pins are the long-horizon forward tracker — losing them on a restore defeated the feature
async function applySnapshot(data){ if(!data)return false; _applying=true;
  try{
    if(data.journal && typeof data.journal==='object'){ journal=data.journal; _jrev++; }
    if(Array.isArray(data.wallets)) settings.wallets=data.wallets;
    // 'in', not !=null: a cleared risk default (null) must propagate, or another device resurrects it
    if(data.settings){ if('riskDefault' in data.settings)settings.riskDefault=data.settings.riskDefault;
      if(data.settings.view)settings.view=data.settings.view; if(data.settings.dexView)settings.dexView=data.settings.dexView; if(data.settings.rBasis)settings.rBasis=data.settings.rBasis; if(data.settings.pageSize)settings.pageSize=data.settings.pageSize; if(data.settings.beThreshold!=null)settings.beThreshold=data.settings.beThreshold; if(data.settings.theme)settings.theme=data.settings.theme; if(data.settings.anaBasis)settings.anaBasis=data.settings.anaBasis; if(data.settings.tz)settings.tz=data.settings.tz; if(data.settings.assumedLev>0)settings.assumedLev=data.settings.assumedLev; if(data.settings.rules&&typeof data.settings.rules==='object')settings.rules=data.settings.rules; if(data.settings.attribBasis)settings.attribBasis=data.settings.attribBasis; if(Array.isArray(data.settings.pins))settings.pins=data.settings.pins.filter(p=>p&&typeof p.pid==='string'); if(Array.isArray(data.settings.habits))settings.habits=data.settings.habits.filter(h=>h&&typeof h.id==='string'&&typeof h.kind==='string'); if(typeof data.settings.tzZone==='string')settings.tzZone=data.settings.tzZone; if(data.settings.calMode==='pnl'||data.settings.calMode==='process')settings.calMode=data.settings.calMode; if(data.settings.calWeeks===26||data.settings.calWeeks===52)settings.calWeeks=data.settings.calWeeks; if(typeof data.settings.coachMode==='boolean')settings.coachMode=data.settings.coachMode; if(Array.isArray(data.settings.pzPlugs))settings.pzPlugs=data.settings.pzPlugs.filter(p=>p&&typeof p.slip==='string'); if(typeof data.settings.pzProfile==='string')settings.pzProfile=data.settings.pzProfile; if(['all','perp','spot'].includes(data.settings.pzMarket))settings.pzMarket=data.settings.pzMarket; if(data.settings.pzLayout&&typeof data.settings.pzLayout==='object')settings.pzLayout=data.settings.pzLayout;
      if(data.settings.pzLessons&&typeof data.settings.pzLessons==='object')settings.pzLessons=pzLessonsNorm(data.settings.pzLessons);
      if(Array.isArray(data.settings.playbooks))settings.playbooks=pbNorm(data.settings.playbooks,true);
      if(['auto','dark','light'].includes(data.settings.appearance))settings.appearance=data.settings.appearance;
      if(['ts9','ink','bb'].includes(data.settings.colorway))settings.colorway=data.settings.colorway;
      if(Array.isArray(data.settings.pzGoals))settings.pzGoals=data.settings.pzGoals.filter(x=>x&&typeof x==='object'&&typeof x.id==='string'); if(data.settings.goals&&typeof data.settings.goals==='object')settings.goals=data.settings.goals; }
    await rawSet(J_KEY,journal); await rawSet(S_KEY,settings);
    // v9+ backups may carry per-wallet fill caches (see backupAll) — restore the valid ones.
    if(data.fillCaches && typeof data.fillCaches==='object'){
      for(const addr in data.fillCaches){ const c=data.fillCaches[addr];
        if(validFillCache(addr,c)) await idbSet('flc:'+addr, c.v===2 ? cacheExtras(await packFillCache(c.fills,c.last),c) : c); }
    }
    if(data.excRows && data.excRows.v===1 && data.excRows.rows && typeof data.excRows.rows==='object')
      await idbSet('excRows',data.excRows); // saved MAE/MFE measurements survive device moves too

  } finally { _applying=false; }
  return true;
}
// write to local store WITHOUT re-triggering a file write (avoids loops on load)
async function rawSet(key,val){ const s=JSON.stringify(val);
  if(window.storage){ try{ await window.storage.set(key,s); return; }catch(e){} }
  try{ localStorage.setItem(key,s); }catch(e){ storeFailed(e); } }
// The browser refused to save (its storage for this site is full): say so, instead of a "saved"
// tick over an edit that will be gone on the next load.
function storeFailed(e){ const full=e&&(e.name==='QuotaExceededError'||e.code===22||/quota/i.test(e.message||''));
  try{ setErr(full?'This browser’s storage for the journal is full, so the last change wasn’t saved here. Use Backup all, then clear old attachments or link a data file.':'Couldn’t save in this browser: '+(e&&e.message||e)); }catch(_){} }

function scheduleLinkedWrite(){ if(!linkedHandle||_applying)return; clearTimeout(_writeTimer); _writeTimer=setTimeout(writeLinked,600); }

/* ============================ server sync (companion server / Railway) ============================ */
// When the app is served by the zero-dependency companion server (server.js), journal,
// wallets, settings and MAE/MFE measurements auto-save to the server and load on every
// visit — persistence that survives reboots and redeploys (given a volume). The same
// single file still works standalone from file:// or any static host: the API is
// probed once at boot and sync only activates if it answers. All compute stays in the
// browser; the server persists one JSON blob and nothing else.
// Concurrency: every write carries the last-known revision. A stale write gets a 409
// with the server's current state, which the client applies instead of clobbering it.
const SRV={enabled:false,needsAuth:false,badAuth:false,token:null,rev:0};
let _srvTimer=null;
// Journal ids edited locally since the last successful sync, with a per-id edit counter.
// On a 409 the server's snapshot wins wholesale — except these entries, which are
// re-applied on top and re-synced. The counter matters: a plain Set lost an entry that
// was re-edited WHILE a PUT was in flight (success deleted the id even though the newer
// edit was never sent); success now clears an id only when its counter is unchanged.
const _dirtyJ=new Map();
let _srvWriting=false,_srvAgain=false;
// Journal edit counter — part of the miner cache key, since tags/setups/mistakes/ratings
// change miner inputs without changing the trade count.
let _jrev=0;
// every edit passes here, so this is where an entry gets its time: restoring a backup keeps
// whichever copy of a note is newer, and it can only tell when both carry one
function markJEdit(id){ const e=typeof journal!=='undefined'&&journal&&journal[id]; if(e&&typeof e==='object'&&!Array.isArray(e))e.updatedAt=Date.now();
  _dirtyJ.set(id,(_dirtyJ.get(id)||0)+1); _jrev++; vaultMark(id); jPendingSave(); }
// The ids edited here and not yet confirmed saved (to the server, or the linked file) are kept in
// localStorage too: a reload or a closed tab before the save went through used to let the older
// copy from the server win at the next start. At boot they're laid back over what loaded.
const JP_KEY='hl_jpending_v1';
let _jpQ=false; // once per burst of edits (a bulk change marks thousands)
function jPendingSave(){ if(_jpQ)return; _jpQ=true; queueMicrotask(()=>{ _jpQ=false;
  try{ if(_dirtyJ.size)localStorage.setItem(JP_KEY,JSON.stringify([..._dirtyJ.keys()].slice(-5000))); else localStorage.removeItem(JP_KEY); }catch(e){} }); }
function jPendingLoad(){ try{ const a=JSON.parse(localStorage.getItem(JP_KEY)||'[]'); return Array.isArray(a)?a.filter(x=>typeof x==='string'):[]; }catch(e){ return []; } }
async function jPendingOverlay(localJ,pend){ if(!pend.length||!localJ)return; _jrev++;
  for(const id of pend){ if(localJ[id]!==undefined)journal[id]=localJ[id]; else delete journal[id]; _dirtyJ.set(id,(_dirtyJ.get(id)||0)+1); }
  await rawSet(J_KEY,journal); jPendingSave(); schedulePersist(); }
// Settings as of the last successful sync — powers a field-level 409 merge: a goal/rule/tz
// edit made here since the last sync wins over the incoming snapshot instead of silently
// bouncing back. Wallets are deliberately excluded (list merges are ambiguous; last write
// wins there, as before).
let _lastSyncedS=null;
const _SYNC_S_FIELDS=['riskDefault','view','dexView','rBasis','pageSize','beThreshold','theme','anaBasis','tz','assumedLev','rules','attribBasis','goals','pins','habits','tzZone','calMode','colorway','calWeeks','coachMode','pzPlugs','pzProfile','pzMarket','pzLayout','pzLessons','pzGoals','playbooks','appearance'];
// lessons and goals are lists edited on several devices: a conflict merges them by id instead of
// letting one device's copy replace the other's (the newest change to an item wins; removals stick)
function pzLessonsNorm(v){ v=v&&typeof v==='object'?v:{}; return Object.assign({},v,{items:v.items&&typeof v.items==='object'&&!Array.isArray(v.items)?v.items:{},own:Array.isArray(v.own)?v.own.filter(o=>o&&typeof o.id==='string'):[]}); }
function _syncMerge(k, mine, theirs){
  if(k==='playbooks'){ const by=new Map(); // per playbook, the newest edit wins; a deletion is a dated tombstone so it sticks
    for(const p of [...pbNorm(theirs,true),...pbNorm(mine,true)]){ const o=by.get(p.id); if(!o||(p.at||0)>=(o.at||0))by.set(p.id,p); }
    return [...by.values()].sort((a,b)=>(a.createdAt||0)-(b.createdAt||0)); }
  if(k==='pzGoals'){ const by=new Map(); for(const g of [...(Array.isArray(theirs)?theirs:[]),...(Array.isArray(mine)?mine:[])]){ if(!g||typeof g.id!=='string')continue;
      const o=by.get(g.id); if(!o){ by.set(g.id,Object.assign({},g)); continue; } const m=Object.assign({},(g.at||0)>=(o.at||0)?o:g,(g.at||0)>=(o.at||0)?g:o);
      for(const f of ['done','missed','cleared','dropped'])m[f]=o[f]||g[f]||m[f]; by.set(g.id,m); }
    return [...by.values()].sort((a,b)=>(a.createdAt||0)-(b.createdAt||0)).slice(-40); }
  if(k==='pzPlugs'){ const by=new Map(); // one plug per leak and start day: both devices' plugs survive, a stop sticks
    for(const p of [...(Array.isArray(theirs)?theirs:[]),...(Array.isArray(mine)?mine:[])]){ if(!p||typeof p.slip!=='string')continue;
      const id=p.slip+'|'+p.from, o=by.get(id); if(!o){ by.set(id,Object.assign({},p)); continue; }
      const m=Object.assign({},(p.at||0)>=(o.at||0)?o:p,(p.at||0)>=(o.at||0)?p:o); if(o.dropped||p.dropped)m.dropped=true; by.set(id,m); }
    return [...by.values()].sort((a,b)=>(a.at||0)-(b.at||0)); }
  if(k==='habits'){ const by=new Map(); // by id: a habit adopted on the other device isn't lost; for the same habit this device's copy wins, as before
    for(const h of [...(Array.isArray(theirs)?theirs:[]),...(Array.isArray(mine)?mine:[])])if(h&&typeof h.id==='string')by.set(h.id,h);
    return [...by.values()]; }
  if(k==='pzLessons'){ const a=pzLessonsNorm(mine), b=pzLessonsNorm(theirs), items=Object.assign({},b.items);
    for(const [id,v] of Object.entries(a.items)){ const o=items[id]; items[id]=!o||(v.at||0)>=(o.at||0)?Object.assign({},v,{off:v.off||(o&&o.off)}):Object.assign({},o,{off:o.off||v.off}); }
    const own=new Map(); for(const o of [...b.own,...a.own])own.set(o.id,o);
    return Object.assign({},b,a,{items,own:[...own.values()].slice(-300),since:Math.min(a.since||Infinity,b.since||Infinity)===Infinity?undefined:Math.min(a.since||Infinity,b.since||Infinity)}); }
  return mine;
}
function _snapS(){ const o={}; for(const k of _SYNC_S_FIELDS)o[k]=settings[k]; return JSON.parse(JSON.stringify(o)); }
function schedulePersist(){ scheduleLinkedWrite(); scheduleServerWrite(); vaultSchedule(); }
// A failed write keeps the edits dirty, shows the error, and retries with backoff (5s → 2min).
function syncFailed(msg){
  SRV.err=msg; SRV.retryMs=Math.min(120000,(SRV.retryMs||2500)*2);
  renderDatafile('error');
  clearTimeout(_srvTimer); _srvTimer=setTimeout(writeServer,SRV.retryMs);
}
// No token (a visitor, or the owner before signing in): edits stay in this browser, never sent to be refused.
function scheduleServerWrite(){ if(!SRV.enabled||_applying)return; if(SRV.needsAuth&&!SRV.token)return; _srvGen++; srvMark(true); clearTimeout(_srvTimer); _srvTimer=setTimeout(writeServer,800); }
// A save waits 800 ms before it goes out. A reload inside that window used to lose the edit: the
// next start applied the server's copy over this browser's newer one. So this browser notes the
// revision it last matched and whether it has edits the server hasn't seen; at the next start, an
// unchanged server revision means nobody else saved since, and this browser's copy is kept and sent.
let _srvGen=0;
const SRV_MARK='srv_sync';
function srvMark(dirty){ try{ localStorage.setItem(SRV_MARK,JSON.stringify({rev:SRV.rev,dirty:!!dirty})); }catch(e){} }
function srvMarkRead(){ try{ const m=JSON.parse(localStorage.getItem(SRV_MARK)||'null'); return m&&typeof m.rev==='number'?m:null; }catch(e){ return null; } }
function srvFetch(p,o){ o=o||{}; o.headers=Object.assign({},o.headers);
  if(SRV.token)o.headers['Authorization']='Bearer '+SRV.token; return fetch(p,o); }
async function writeServer(){
  if(!SRV.enabled)return;
  if(_srvWriting){ _srvAgain=true; return; } // serialize PUTs — interleaved responses can regress SRV.rev
  _srvWriting=true;
  try{
    let excRows=null; try{ const p=await idbGet('excRows'); if(p&&p.v===1&&p.rows)excRows=p; }catch(e){}
    const snap={...snapshot()}; if(excRows)snap.excRows=excRows;
    const sentDirty=[..._dirtyJ.entries()]; // (id, counter) pairs — edits made while in flight bump the counter and stay dirty
    const sentS=_snapS(), sentGen=_srvGen;
    const r=await srvFetch('/api/data',{method:'PUT',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({rev:SRV.rev,snapshot:snap})});
    if(r.status===401){ SRV.badAuth=true; renderDatafile(); return; }
    if(r.status===409){ // edited from another device since we last loaded — take theirs, but keep our unsynced edits
      const j=await r.json(); SRV.rev=j.rev||0;
      if(j.snapshot){
        const mine=journal, dirty=[..._dirtyJ.keys()], localS=_snapS();
        await applySnapshot(j.snapshot); try{ renderWallets(); }catch(e){}
        let merged=false;
        if(dirty.length){
          for(const id of dirty){ if(mine[id]!==undefined)journal[id]=mine[id]; else delete journal[id]; }
          await rawSet(J_KEY,journal); merged=true;
        }
        // field-level settings merge: fields changed here since the last successful sync
        // win over the incoming snapshot (the edit that triggered this very PUT used to
        // silently bounce back). Never-synced sessions skip this — server wins there.
        if(_lastSyncedS){
          let sChanged=false;
          for(const k of _SYNC_S_FIELDS){
            if(JSON.stringify(localS[k])!==JSON.stringify(_lastSyncedS[k])){ settings[k]=_syncMerge(k,localS[k],settings[k]); sChanged=true; }
          }
          if(sChanged){ await rawSet(S_KEY,settings); merged=true; }
        }
        // Rebase the baseline to what is now on disk: incoming values for fields the merge
        // didn't touch, local values for those it re-applied. Without this, a conflict
        // applied with merged=false left the OLD baseline in place, and the NEXT conflict
        // misread server-origin values as local edits — pushing them back over the other
        // device's newer state.
        _lastSyncedS=_snapS();
        srvMark(merged);
        if(merged)scheduleServerWrite(); // push the merge at the new revision
      }
      setStatus('Loaded newer data saved from another device.'+(_dirtyJ.size?' Your local edits were kept and will re-sync.':''));
      renderDatafile(); return;
    }
    if(r.ok){ const j=await r.json(); SRV.rev=j.rev||SRV.rev+1;
      for(const [id,rev] of sentDirty) if(_dirtyJ.get(id)===rev)_dirtyJ.delete(id); // only clear what was actually sent unchanged
      jPendingSave();
      _lastSyncedS=sentS; SRV.err=null; SRV.retryMs=0;
      srvMark(_srvGen!==sentGen); // an edit made while this PUT was in flight is still unsent
      renderDatafile('saved'); }
    else { // 413 / 5xx / proxy errors: say so — the indicator used to keep reading "saved"
      let msg='HTTP '+r.status; try{ const j=await r.json(); if(j&&j.error)msg+=': '+j.error; }catch(e){}
      syncFailed(msg); }
  }catch(e){ syncFailed('server unreachable'); }
  finally{ _srvWriting=false; if(_srvAgain){ _srvAgain=false; writeServer(); } }
}
async function initServerSync(){
  if(!/^https?:$/.test(location.protocol))return false;
  try{
    // with a remembered token, ask for the data at the same time as the health check instead of after it
    let tok=null; try{ tok=localStorage.getItem('srv_token')||null; }catch(e){}
    if(tok)SRV.token=tok;
    const early=tok?srvFetch('/api/data').catch(()=>null):null;
    const h=await fetch('/api/health'); if(!h.ok)return false;
    const info=await h.json(); if(!info||info.ok!==true)return false;
    SRV.enabled=true; SRV.needsAuth=!!info.auth;
    if(SRV.needsAuth){ SRV.token=tok;
      if(!SRV.token){ renderDatafile(); return true; } }
    const d=(early&&await early)||await srvFetch('/api/data');
    if(d.status===401){ SRV.badAuth=true; renderDatafile(); return true; }
    if(d.status===429){ SRV.badAuth=true; renderDatafile(); setErr(srvLockMsg(d)); return true; } // locked out: never sync blind at rev 0
    if(d.ok){ const j=await d.json(); SRV.rev=j.rev||0;
      const m=srvMarkRead();
      if(m&&m.dirty&&m.rev===SRV.rev){ // nobody saved since this browser's unsent edits: keep them all (boot sends them)
        SRV.pushLocal=true; const ss=(j.snapshot&&j.snapshot.settings)||{};
        for(const id of jPendingLoad())_dirtyJ.set(id,(_dirtyJ.get(id)||0)+1); // still unsent: a 409 before the push keeps them
        _lastSyncedS=JSON.parse(JSON.stringify(Object.fromEntries(_SYNC_S_FIELDS.map(k=>[k,ss[k]])))); } // the server's side, for a later 409 merge
      else { srvMark(false);
        // (no readable local journal: nothing to lay over — a missing copy isn't "every edit was a delete")
        if(j.snapshot){ const pend=jPendingLoad(), localJ=pend.length?await Store.get(J_KEY):null;
          await applySnapshot(j.snapshot); await jPendingOverlay(localJ,pend); }
        _lastSyncedS=_snapS(); } } // baseline for the field-level 409 settings merge
    // PWA: only meaningful when served — installable app icon + offline shell
    try{ if('serviceWorker' in navigator)navigator.serviceWorker.register('/sw.js').catch(()=>{});
      if(!document.querySelector('link[rel=manifest]')){ const l=document.createElement('link');
        l.rel='manifest'; l.href='/manifest.webmanifest'; document.head.appendChild(l); } }catch(e){}
  }catch(e){ SRV.enabled=false; return false; }
  return true;
}
// the server locks an address out after too many wrong tokens (AUTH_FAIL_MAX): say so, and for how long
const srvLockMsg=d=>{ const s=+(d.headers&&d.headers.get('retry-after'))||0;
  return 'Too many wrong tokens from this network — try again'+(s?' in about '+Math.max(1,Math.ceil(s/60))+' min':' in a few minutes')+'.'; };
async function connectServerToken(){
  const inp=$('srvTok'); if(!inp)return;
  const tok=inp.value.trim(); if(!tok)return;
  try{ localStorage.setItem('srv_token',tok); }catch(e){}
  SRV.token=tok; SRV.badAuth=false;
  const d=await srvFetch('/api/data');
  if(d.status===401){ SRV.badAuth=true; renderDatafile(); setErr('Server rejected that token.'); return; }
  if(d.status===429){ SRV.badAuth=true; renderDatafile(); setErr(srvLockMsg(d)); return; }
  setStatus('Server sync connected — reloading…');
  location.reload(); // clean boot with the token applies server data in the right order
}

async function toggleSnapHistory(){
  let p=$('snapPanel');
  if(p){ p.remove(); return; }
  const host=$('datafile'); if(!host)return;
  p=document.createElement('div'); p.id='snapPanel'; p.className='datafile'; p.style.cssText='display:block;margin-top:6px';
  p.innerHTML='<span>Loading snapshot history\u2026</span>'; host.insertAdjacentElement('afterend',p);
  try{
    const r=await srvFetch('/api/snapshots'); if(!r.ok)throw new Error('HTTP '+r.status);
    const j=await r.json(); const snaps=j.snapshots||[];
    if(!snaps.length){ p.innerHTML='<span>No snapshots yet \u2014 one is written per day on the first save of that day.</span>'; return; }
    p.innerHTML='<span data-tip="One snapshot per day (UTC), kept for 14 days, written automatically on the first save of each day. Restoring loads that day\u2019s data and saves it as the newest revision \u2014 nothing is deleted, and today\u2019s pre-restore state is itself in today\u2019s snapshot.">Server snapshots \u2014 restore a previous day:</span> '+
      snaps.map(s=>`<button class="df-btn snapRestore" data-d="${esc(s.date)}">${esc(s.date)}${s.rev!=null?' \u00b7 rev '+esc(s.rev):''} \u00b7 ${(s.bytes/1024).toFixed(0)}kB</button>`).join(' '); // server JSON is still an external input \u2014 escape like every other sink
    p.querySelectorAll('.snapRestore').forEach(b=>{ b.onclick=async()=>{
      if(!confirm('Restore the '+b.dataset.d+' snapshot? Your current data will be replaced (it stays recoverable from today\u2019s snapshot).'))return;
      b.disabled=true; b.textContent='restoring\u2026';
      try{
        const rr=await srvFetch('/api/snapshots/'+b.dataset.d); if(!rr.ok)throw new Error('HTTP '+rr.status);
        const jj=await rr.json();
        if(jj&&jj.snapshot){ await applySnapshot(jj.snapshot); await writeServer(); location.reload(); }
        else throw new Error('snapshot empty');
      }catch(e){ setErr('Restore failed: '+e.message); b.disabled=false; b.textContent=b.dataset.d; }
    }; });
  }catch(e){ p.innerHTML='<span>Could not load snapshots: '+esc(e.message)+'</span>'; }
}

let _writing=false,_writeAgain=false;
async function writeLinked(){ if(!linkedHandle)return;
  if(_writing){ _writeAgain=true; return; }
  _writing=true;
  try{ if(await ensurePerm(linkedHandle,'readwrite')!=='granted'){ renderDatafile('need-permission'); return; }
    const sent=[..._dirtyJ.entries()];
    const w=await linkedHandle.createWritable(); await w.write(JSON.stringify(snapshot(),null,2)); await w.close();
    if(!SRV.enabled){ for(const [id,rev] of sent) if(_dirtyJ.get(id)===rev)_dirtyJ.delete(id); jPendingSave(); } // the file is the saved copy here
    renderDatafile('saved');
  }catch(e){ renderDatafile('error'); }
  finally{ _writing=false; if(_writeAgain){ _writeAgain=false; writeLinked(); } } }
async function ensurePerm(h,mode){ try{ const o={mode}; let p=await h.queryPermission(o); if(p==='granted')return p; p=await h.requestPermission(o); return p; }catch(e){ return 'denied'; } }

async function linkNewFile(){ if(!FSA){ alert('Your browser does not support linking a file. Use “Backup all” to export a JSON you can re-import.'); return; }
  try{ const h=await window.showSaveFilePicker({suggestedName:'ledger-data.json',types:[{description:'JSON',accept:{'application/json':['.json']}}]});
    linkedHandle=h; linkedName=h.name; await idbSet('handle',h);
    await writeLinked(); renderDatafile('saved');
  }catch(e){ if(e.name!=='AbortError') renderDatafile('error'); } }
async function openExistingFile(){ if(!FSA){ $('importBtn').click(); return; }
  try{ const [h]=await window.showOpenFilePicker({types:[{description:'JSON',accept:{'application/json':['.json']}}]});
    if(await ensurePerm(h,'readwrite')!=='granted')return;
    const file=await h.getFile(); const data=JSON.parse(await file.text());
    await applySnapshot(data); linkedHandle=h; linkedName=h.name; await idbSet('handle',h);
    renderDatafile('saved'); renderWallets();
    if(allTrades.length) render();
    setStatus('Loaded from '+h.name+' · '+settings.wallets.length+' wallet(s), '+Object.keys(journal).length+' journal entries. Hit Load all to refresh trades.');
  }catch(e){ if(e.name!=='AbortError') renderDatafile('error'); } }
async function reconnectFile(){ const h=await idbGet('handle'); if(!h){ renderDatafile(); return; }
  if(await ensurePerm(h,'readwrite')!=='granted'){ renderDatafile('need-permission'); return; }
  try{ const file=await h.getFile(); const data=JSON.parse(await file.text());
    await applySnapshot(data); linkedHandle=h; linkedName=h.name;
    renderDatafile('saved'); renderWallets();
    if(allTrades.length) render();
    setStatus('Reconnected '+h.name+' · data restored. Hit Load all to refresh trades.');
  }catch(e){ renderDatafile('error'); } }
async function unlinkFile(){ linkedHandle=null; linkedName=''; await idbDel('handle'); renderDatafile(); }

function renderDatafile(state){ const el=$('datafile'); if(!el)return;
  if(SRV.enabled){
    // the companion server also serves the built-in docs — surface the entry points
    for(const id of ['helpBtn','helpLink']){ const h=$(id); if(h)h.classList.remove('hide'); }
    el.classList.remove('hide');
    if(SRV.needsAuth&&(!SRV.token||SRV.badAuth)){
      el.className='datafile';
      el.innerHTML=`<span class="dot"></span><span data-tip="This deployment protects your data with an access token (the AUTH_TOKEN you set on the server). Enter it once — it's remembered in this browser.">${SRV.badAuth?'Server rejected the token — re-enter it':'Server sync available — enter your access token'}</span>
        <span class="sp"></span><input type="password" id="srvTok" placeholder="access token" style="width:150px"><button class="df-btn" id="srvTokBtn">Connect</button>`;
      $('srvTokBtn').onclick=connectServerToken;
      $('srvTok').addEventListener('keydown',e=>{ if(e.key==='Enter')connectServerToken(); });
      return;
    }
    el.className='datafile on';
    { const bs=$('backupSrv'); if(bs)bs.classList.remove('hide'); } // server present + authed — offer server-held backups
    const tag=SRV.err?`<span style="color:var(--loss)" data-tip="Your edits are kept in this browser and retried automatically.">not saved — ${esc(SRV.err)} · retrying</span>`
      :state==='saved'?'<span style="color:var(--profit)">saved</span>':'synced';
    el.innerHTML=`<span class="dot"></span><span data-tip="Journal, wallets, settings and MAE/MFE measurements auto-save to this server on every change and load on every visit — reboots and redeploys are covered as long as the server has a persistent volume. Journal image attachments sync too; candle caches stay in this browser (re-fetchable).">☁ Server sync · rev ${SRV.rev} · ${tag}</span>
      <span class="sp"></span><button class="df-btn" id="srvHist" data-tip="Rotating daily snapshots kept on the server (last 14 days). Restore any of them if a sync or edit went wrong.">History</button><button class="df-btn" id="srvSaveNow">Save now</button>`;
    $('srvSaveNow').onclick=writeServer;
    $('srvHist').onclick=toggleSnapHistory;
    return;
  }
  if(!FSA){ el.className='datafile'; el.innerHTML=`<span class="dot"></span><span>Saved in this browser. For a portable, sync-able copy use <b>Backup all</b> to export / re-import a JSON.</span>`; el.classList.remove('hide'); return; }
  el.classList.remove('hide');
  if(linkedHandle){ el.className='datafile on';
    const tag=state==='saved'?'<span style="color:var(--profit)">saved</span>':state==='error'?'<span style="color:var(--loss)">write error</span>':state==='need-permission'?'<span style="color:var(--gold)">needs permission</span>':'linked';
    el.innerHTML=`<span class="dot"></span><span>Auto-saving to <b>${esc(linkedName)}</b> · ${tag}</span>
      <span class="sp"></span><button class="df-btn" id="dfSaveNow">Save now</button><button class="df-btn" id="dfUnlink">Unlink</button>`;
    $('dfSaveNow').onclick=writeLinked; $('dfUnlink').onclick=unlinkFile;
  } else { el.className='datafile';
    el.innerHTML=`<span class="dot"></span><span data-tip="Binds your tags, notes, ratings, wallets and settings to a real JSON file on disk and auto-saves on every change. Put it in a cloud-synced folder to use across devices.">Your journal is saved in this browser. <b>Link a data file</b> so you never lose it.</span>
      <span class="sp"></span>${state==='reconnect'?'<button class="df-btn" id="dfReconnect">Reconnect file</button>':''}<button class="df-btn" id="dfLink">Link new file</button><button class="df-btn" id="dfOpen">Open existing</button>`;
    if($('dfReconnect'))$('dfReconnect').onclick=reconnectFile;
    $('dfLink').onclick=linkNewFile; $('dfOpen').onclick=openExistingFile;
  }
}

/* ============================ HL API ============================ */
const API='https://api.hyperliquid.xyz/info';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function hlPost(body){
  const MAX=4, backoff=a=>Math.min(8000,300*(2**a))+Math.random()*250; let attempt=0;
  while(true){
    let res;
    try{ res=await fetch(API,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}); }
    catch(e){ if(attempt++<MAX){ await sleep(backoff(attempt)); continue; } throw new Error('Network error reaching Hyperliquid — check your connection.'); }
    if(res.ok) return res.json();
    // 429 (rate limit) and 5xx are transient: honor Retry-After, else exponential backoff
    if((res.status===429||res.status>=500)&&attempt++<MAX){
      const ra=parseFloat(res.headers.get('retry-after'));
      await sleep(isFinite(ra)?Math.min(15000,ra*1000):backoff(attempt)); continue;
    }
    throw new Error('API '+res.status);
  }
}
async function fetchAllFills(addr, since=0){
  let start=since, all=[], pages=0, truncated=false; const seen=new Set();
  const add=f=>{ const id=f.tid+'-'+f.oid+'-'+f.time; if(!seen.has(id)){ seen.add(id); all.push(f);} };
  while(pages<60){
    const batch=await hlPost({type:'userFillsByTime',user:addr,startTime:start,aggregateByTime:true});
    if(!Array.isArray(batch)||batch.length===0) break;
    for(const f of batch) add(f);
    setStatus((since>0?'Fetching new fills… ':'Fetching fills… ')+all.length+' so far', true);
    if(batch.length<2000) break;
    // Resume AT the boundary time, not past it: fills sharing the boundary millisecond that
    // didn't fit in this batch are picked up next page and removed by the dedupe set above.
    // Only when an entire page is one millisecond (start can't advance) is +1 unavoidable.
    const mx=Math.max(...batch.map(f=>f.time));
    start=mx>start?mx:mx+1; pages++; await sleep(40);
    if(pages>=60) truncated=true; // hit the hard page cap with a full final batch — older history is missing
  }
  // The exchange only serves the 10,000 most recent fills: a fetch that reaches that many
  // (from zero, or a gap since the cached watermark) may be missing everything older.
  if(all.length>=10000) truncated=true;
  // TWAP slice fills live in a separate endpoint and are NOT in userFills — merge them in so
  // TWAP-executed trades reconstruct correctly instead of silently going missing.
  try{ const tw=await hlPost({type:'userTwapSliceFills',user:addr});
    if(Array.isArray(tw)) for(const r of tw){ const f=r&&r.fill; if(f&&f.time>=since) add(f); }
  }catch(e){}
  return {fills:all, truncated};
}
async function fetchFunding(addr, since){
  // userFunding caps each response (~500 rows). One call with startTime:0 silently drops
  // everything past the cap, and funding feeds net = pnl - fees + funding — so heavy
  // accounts got corrupted headline numbers. Page forward exactly like fetchAllFills:
  // resume AT the boundary time (dupes straddling a page edge are keyed out below) and
  // only skip a millisecond when a whole page shares one timestamp and start can't advance.
  // since: resume at the cached watermark (the caller merges and dedupes), so a returning
  // user fetches one page instead of their whole funding history
  const out=[]; const seen=new Set();
  let start=since>0?since:0, pages=0, partial=false;
  try{
    while(pages<200){
      const rows=await hlPost({type:'userFunding',user:addr,startTime:start});
      if(!Array.isArray(rows)||rows.length===0) break;
      for(const r of rows){
        const rec={time:r.time,coin:r.delta&&r.delta.coin,usdc:parseFloat((r.delta&&r.delta.usdc)||0)};
        const id=rec.time+'|'+rec.coin; // one funding event per coin per tick
        if(!seen.has(id)){ seen.add(id); out.push(rec); }
      }
      if(rows.length<500) break;
      const mx=Math.max(...rows.map(r=>r.time));
      start=mx>start?mx:mx+1; pages++; await sleep(40);
    }
  }catch(e){ partial=true; } // keep what we have, but say so — silent 0 looked like "no funding"
  if(partial||pages>=200){
    // a transient status line gets overwritten within seconds; the data-health strip is
    // the durable signal that funding attribution is incomplete this session
    if(typeof _fetchHealth!=='undefined'&&_fetchHealth)_fetchHealth.funding=true;
  }
  return out;
}
// Capital flows — deposits, withdrawals, vault and cross-account transfers — from
// userNonFundingLedgerUpdates. These are what turn PnL into a RETURN: without them every
// percentage in the app is notional-based, because fills alone cannot see capital.
// one key per capital flow: amount + destination belong in it — two same-type transfers batched
// into one block (same ms, equal/empty hash) are distinct flows, not duplicates
function ledgerRowId(r){ const d=(r&&r.delta)||{}; return (r.hash||'')+'|'+r.time+'|'+(d.type||'')+'|'+(d.usdc||'')+'|'+(d.destination||''); }
async function fetchLedgerUpdates(addr, since){
  const out=[]; const seen=new Set();
  let start=since>0?since:0, pages=0;
  try{
    while(pages<120){
      const rows=await hlPost({type:'userNonFundingLedgerUpdates',user:addr,startTime:start});
      if(!Array.isArray(rows)||rows.length===0)break;
      for(const r of rows){ const id=ledgerRowId(r); if(!seen.has(id)){ seen.add(id); out.push(r); } }
      if(rows.length<500)break;
      const mx=Math.max(...rows.map(r=>r.time));
      start=mx>start?mx:mx+1; pages++; await sleep(40);
    }
  }catch(e){ if(typeof _fetchHealth!=='undefined'&&_fetchHealth)_fetchHealth.ledger=true; }
  if(pages>=120){ if(typeof _fetchHealth!=='undefined'&&_fetchHealth)_fetchHealth.ledger=true; }
  return out;
}
// Classify raw ledger updates into signed capital flows for one wallet. Only types whose
// direction is unambiguous count; everything else is tallied as `skipped` and surfaced,
// never silently mixed in. accountClassTransfer (perp<->spot INSIDE the wallet) is
// internal plumbing, deliberately not a capital flow.
function capitalFlows(rows, addr){
  const a=(addr||'').toLowerCase(); const flows=[]; let skipped=0;
  for(const r of (rows||[])){ const d=r&&r.delta; if(!d||!r.time)continue;
    const ty=d.type;
    // the amount's field depends on the type: a vault withdrawal reports what it paid out
    // (netWithdrawnUsd, after any fee), a send its USD value; everything else carries usdc
    const usdc=Math.abs(parseFloat(ty==='vaultWithdraw'?(d.netWithdrawnUsd??d.requestedUsd??d.usdc):ty==='send'?(d.usdcValue??d.usdc):d.usdc));
    if(ty==='send'&&String(d.user||'').toLowerCase()===String(d.destination||'').toLowerCase())continue; // to itself, between dexes: internal
    if(!(usdc>0)){ if(ty!=='accountClassTransfer')skipped++; continue; }
    if(ty==='deposit') flows.push({time:r.time,usdc,type:ty});
    else if(ty==='withdraw') flows.push({time:r.time,usdc:-usdc,type:ty});
    else if(ty==='internalTransfer'||ty==='subAccountTransfer'||ty==='send'){
      const dest=(d.destination||'').toLowerCase();
      flows.push({time:r.time,usdc:dest===a?usdc:-usdc,type:ty});
    }
    else if(ty==='vaultDeposit'||ty==='vaultCreate') flows.push({time:r.time,usdc:-usdc,type:ty}); // capital parked in a vault is off the trading account
    else if(ty==='vaultWithdraw') flows.push({time:r.time,usdc,type:ty});
    else if(ty==='accountClassTransfer'){ /* internal — ignore */ }
    else skipped++;
  }
  flows.sort((x,y)=>x.time-y.time);
  return {flows, skipped};
}
// Time-weighted capital + true-return model. Capital(t) is the running sum of flows;
// avgCapital is its time-weighted mean over [first flow, now] — the honest denominator
// for "return on capital" when deposits and withdrawals moved mid-history. Drawdown is
// re-expressed as % of the capital actually present at the trough, not of notional.
// Pure — extracted by the tests and the API server.
function capitalModel(flows, closed, equityNow, now){
  now=now||Date.now();
  if(!flows||!flows.length)return null;
  const chron=[...flows].sort((a,b)=>a.time-b.time);
  let cap=0,totIn=0,totOut=0,maxCap=0,tw=0,prevT=chron[0].time,prevCap=0;
  for(const f of chron){
    tw+=prevCap*(f.time-prevT); prevT=f.time;
    cap+=f.usdc; if(f.usdc>0)totIn+=f.usdc; else totOut-=f.usdc;
    if(cap>maxCap)maxCap=cap; prevCap=cap;
  }
  tw+=prevCap*(now-prevT);
  const spanMs=now-chron[0].time;
  const avgCapital=spanMs>0?tw/spanMs:cap;
  const closedIn=(closed||[]).filter(t=>!t.isOpen&&t.closeTime>=chron[0].time&&t.closeTime<=now)
    .sort((x,y)=>x.closeTime-y.closeTime);
  const realized=closedIn.reduce((s,t)=>s+t.net,0);
  const roc=avgCapital>0?realized/avgCapital:null;
  const years=spanMs/(365*86400000);
  const rocAnnual=(roc!=null&&roc>-1&&years>=0.05)?(Math.pow(1+roc,1/years)-1):null; // annualize only past ~18 days
  let cum=0,peak=0,worst$=0,worstPct=null,ci=0,capNow=0;
  for(const t of closedIn){
    while(ci<chron.length&&chron[ci].time<=t.closeTime){ capNow+=chron[ci].usdc; ci++; }
    cum+=t.net; if(cum>peak)peak=cum;
    const dd=cum-peak;
    if(dd<worst$)worst$=dd;
    // the % track is evaluated at EVERY underwater point, not only new dollar troughs —
    // a proportionally deeper dip against smaller capital is the one that hurts most
    if(dd<0&&capNow>0){ const pct=dd/capNow; if(worstPct==null||pct<worstPct)worstPct=pct; }
  }
  const implied=(equityNow!=null&&isFinite(equityNow))?equityNow-cap:null; // the account's own all-time accounting, unrealized included
  return {n:chron.length, firstAt:chron[0].time, lastAt:chron[chron.length-1].time,
    totIn, totOut, netDeposited:cap, maxCapital:maxCap, avgCapital,
    realized, nTrades:closedIn.length, roc, rocAnnual, maxDD$:worst$, maxDDpctCap:worstPct,
    equityNow:equityNow!=null?equityNow:null, impliedPnl:implied};
}
// Money-weighted (XIRR) annual return: the rate r solving Σ flow·(1+r)^(yrs remaining) =
// live equity — deposits count against you, withdrawals for you, and periods are weighted
// by how much capital was actually in. The complement to time-weighted ROC: XIRR answers
// "what did MY money earn", TWR answers "how good is the strategy". Bisection; returns
// null without live equity or when the history doesn't bracket a root. Pure.
function xirrFromFlows(flows,equityNow,now){
  now=now||Date.now();
  if(equityNow==null||!isFinite(equityNow)||!flows||!flows.length)return null;
  const YR=365*86400000;
  const f=r=>{ let v=0; for(const fl of flows){ if(!(fl.time<=now))continue; v+=fl.usdc*Math.pow(1+r,(now-fl.time)/YR); } return v-equityNow; };
  let lo=-0.9999, hi=10, flo=f(lo), fhi=f(hi);
  if(!isFinite(flo)||!isFinite(fhi))return null;
  // Clamp instead of vanishing at the extremes: the row used to disappear exactly when
  // the number was most dramatic. f is increasing in r for net-invested histories, so
  // both-positive means the true rate is below −99.99%/yr and both-negative above +1000%.
  if(flo>0&&fhi>0)return lo;
  if(flo<0&&fhi<0)return hi;
  for(let i=0;i<200;i++){ const mid=(lo+hi)/2, fm=f(mid);
    if(!isFinite(fm))return null;
    if(Math.abs(fm)<1e-7)return mid;
    if(flo*fm<=0){ hi=mid; fhi=fm; } else { lo=mid; flo=fm; } }
  return (lo+hi)/2;
}
// HIP-3 (builder-deployed) perps live on separate dexs with independent clearinghouses.
// clearinghouseState with no `dex` param only returns the first (validator-operated) perp dex,
// so open HIP-3 positions are invisible unless each dex is queried explicitly.
// We derive the dex list from fills we already have (HIP-3 fill coins are "dex:COIN")
// rather than querying every dex in existence — zero extra discovery calls.
function hip3DexsFromFills(fills){
  const dexs=new Set();
  for(const f of (fills||[])){ const c=f&&f.coin; if(typeof c!=='string')continue;
    const i=c.indexOf(':');
    if(i>0 && !c.includes('/') && !c.startsWith('@')) dexs.add(c.slice(0,i)); }
  return [...dexs].sort();
}
function mapClearinghouse(s,dex){
  return (s.assetPositions||[]).map(a=>a.position).filter(p=>p&&parseFloat(p.szi)!==0).map(p=>{
    // normalize: fills name HIP-3 assets "dex:COIN"; make positions match regardless of
    // whether the per-dex clearinghouse returns the coin bare or already prefixed.
    let coin=p.coin; if(dex && coin.indexOf(dex+':')!==0) coin=dex+':'+coin;
    return {
      coin, dex:dex||'', szi:parseFloat(p.szi), entryPx:parseFloat(p.entryPx),
      uPnl:parseFloat(p.unrealizedPnl), roe:parseFloat(p.returnOnEquity),
      liq:p.liquidationPx?parseFloat(p.liquidationPx):null,
      lev:p.leverage?p.leverage.value:null, value:parseFloat(p.positionValue||0)
    };
  });
}
async function fetchPositions(addr, hip3Dexs){
  let positions=[], accountValue=null; const okDex=new Set(); // which clearinghouses actually answered
  try{
    const s=await hlPost({type:'clearinghouseState',user:addr});
    positions=mapClearinghouse(s,''); okDex.add('');
    // main-dex USDC equity only; HIP-3 margin is siloed per dex and may be non-USDC collateral,
    // so it is deliberately NOT summed into account value.
    accountValue=s.marginSummary?parseFloat(s.marginSummary.accountValue):null;
  }catch(e){}
  for(const dex of (hip3Dexs||[])){
    try{
      const s=await hlPost({type:'clearinghouseState',user:addr,dex});
      positions=positions.concat(mapClearinghouse(s,dex)); okDex.add(dex);
    }catch(e){} // a dead/renamed dex shouldn't sink the whole load
  }
  return {positions,accountValue,okDex};
}
// Pure builder so the mapping logic is testable. Fill coins name spot pairs "@N" where N is
// the pair's own `index` field in the registry — NOT its position in the universe array.
// Tokens are looked up by their own `index` too (the tokens array has gaps, so position is
// wrong for dozens of them), and asset contexts by their `coin` field: the contexts array is
// far longer than the universe and does NOT line up with it, which priced HYPE at $0.08.
function spotMapsFrom(meta,ctxs){
  const nameByCoin={}, quoteByCoin={}, markBySym={'USDC':1}, tk={}, cx={};
  for(const t of ((meta&&meta.tokens)||[]))if(t&&t.index!=null)tk[t.index]=t;
  for(const c of (ctxs||[]))if(c&&c.coin!=null)cx[c.coin]=c;
  ((meta&&meta.universe)||[]).forEach((u,i)=>{
    const tok=j=>tk[j]||((meta.tokens||[])[j])||{};
    const sym=tok(u.tokens&&u.tokens[0]).name||u.name, q=tok(u.tokens&&u.tokens[1]).name;
    const idx=(u.index!=null)?u.index:i, coin='@'+idx;
    nameByCoin[coin]=sym; if(u.name)nameByCoin[u.name]=sym;
    if(q){ quoteByCoin[coin]=q; if(u.name)quoteByCoin[u.name]=q; }
    const c=cx[u.name]||cx[coin]||(ctxs&&ctxs[i]&&ctxs[i].coin==null?ctxs[i]:null); // contexts without a coin field: the old parallel shape
    if(q==='USDC'&&c&&isFinite(parseFloat(c.markPx))&&!(sym in markBySym&&sym!=='USDC'&&markBySym[sym]>0))markBySym[sym]=parseFloat(c.markPx);
  });
  return {nameByCoin,quoteByCoin,markBySym};
}
async function fetchSpotMaps(){
  try{ const res=await hlPost({type:'spotMetaAndAssetCtxs'});
    return spotMapsFrom(res[0],res[1]||[]);
  }catch(e){ return {nameByCoin:{},markBySym:{'USDC':1}}; }
}
// the balances, with `portfolioMargin` on the list: under portfolio margin spot and perps share one
// balance, and the perp clearinghouse reports 0 for an account that may hold six figures
async function fetchSpotState(addr){
  try{ const s=await hlPost({type:'spotClearinghouseState',user:addr});
    const out=(s.balances||[]).map(b=>({coin:b.coin,total:parseFloat(b.total),entry:parseFloat(b.entryNtl||0)}));
    out.portfolioMargin=!!s.portfolioMarginEnabled; return out;
  }catch(e){ return []; }
}
// all-time P&L (whole account and perps), and the exchange's own account value now: the last point
// of the all-time history is written at the time of the request, so it's live, and under portfolio
// margin it's the one number that covers spot and perps together
async function fetchPortfolio(addr){
  try{ const res=await hlPost({type:'portfolio',user:addr});
    const last=(label,field)=>{ const e=(res||[]).find(x=>x[0]===label); if(!e||!e[1])return null;
      const h=e[1][field]||[]; const v=h.length?parseFloat(h[h.length-1][1]):NaN; return isFinite(v)?v:null; };
    return {all:last('allTime','pnlHistory'), perp:last('perpAllTime','pnlHistory'), accountValue:last('allTime','accountValueHistory')};
  }catch(e){ return {all:null,perp:null,accountValue:null}; }
}
// A portfolio-margin account's balance: the exchange's own account value (spot and perps as one), or
// the spot balances valued at mark when that isn't readable. null for an ordinary account, whose perp
// and spot balances are read separately. Hyperliquid's docs: "Under unified account or portfolio
// margin, use spot balances endpoint instead for trading account balance across spot and perps."
function unifiedAccountOf(sbal, port, spotVal){
  if(!sbal||!sbal.portfolioMargin)return null;
  const v=port&&port.accountValue; return isFinite(v)&&v!=null?v:(isFinite(spotVal)?spotVal:null);
}
