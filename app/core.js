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
    if(_sample&&(key===J_KEY||key===S_KEY)){ // sample mode: only the account's own settings (sampleOwnS)
      if(key===J_KEY)return; const was=JSON.stringify(_sample.settings); val=sampleOwnS(); if(JSON.stringify(val)===was)return; _sample.dirty=true; }
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
const cacheExtras=(to,from)=>{ if(from&&from.syms)to.syms=from.syms; if(from&&from.seed)to.seed=from.seed; if(from&&from.more)to.more=from.more; if(from&&from.twapFull)to.twapFull=true; if(from&&from.archivedAt)to.archivedAt=from.archivedAt; return to; };
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
    const out={v:2,fills,last:c.last,savedAt:c.savedAt}; if(c.syms)out.syms=c.syms; if(c.seed)out.seed=c.seed; if(c.more)out.more=c.more; if(c.twapFull)out.twapFull=true; if(c.archivedAt)out.archivedAt=c.archivedAt; return out;
  }catch(e){ return null; } }
  return null;
}
function snapshot(){ if(typeof _sample!=='undefined'&&_sample)return sampleOwn(snapshot); // the account's, never the sample's
  return {app:'ledger',version:8,exportedAt:new Date().toISOString(),
  wallets:settings.wallets, settings:{riskDefault:settings.riskDefault,view:settings.view,dexView:settings.dexView,rBasis:settings.rBasis,pageSize:settings.pageSize,beThreshold:settings.beThreshold,beFixed:settings.beFixed,theme:settings.theme,anaBasis:settings.anaBasis,tz:settings.tz,assumedLev:settings.assumedLev,rules:settings.rules,attribBasis:settings.attribBasis,goals:settings.goals,
    pins:settings.pins, habits:settings.habits, tzZone:settings.tzZone, calMode:settings.calMode, calWeeks:settings.calWeeks, coachMode:settings.coachMode, pzPlugs:settings.pzPlugs, pzProfile:settings.pzProfile, pzMarket:settings.pzMarket, pzLayout:settings.pzLayout, pzLessons:settings.pzLessons, pzGoals:settings.pzGoals, pzEarned:settings.pzEarned, pzEarnedResetAt:settings.pzEarnedResetAt,
    pzTiltAlerts:settings.pzTiltAlerts, pzCoachDetail:settings.pzCoachDetail, taxExport:settings.taxExport, playbooks:settings.playbooks, colorway:settings.colorway,appearance:settings.appearance}, journal}; } // pins are the long-horizon forward tracker — losing them on a restore defeated the feature
// Device-local, never in the snapshot: autoRefresh (a phone on mobile data may want it off while the
// desktop keeps it on) and pzTiltNotify (rides on this browser's own notification permission). They
// live only in this browser's stored settings, which a snapshot is laid over, never replaces.
async function applySnapshot(data){ if(!data)return false;
  if(typeof _sample!=='undefined'&&_sample)sampleEnd(); // real data ends sample mode
  _applying=true;
  try{
    if(data.journal && typeof data.journal==='object'){ journal=data.journal; _jrev++; }
    if(Array.isArray(data.wallets)) settings.wallets=data.wallets;
    // 'in', not !=null: a cleared risk default (null) must propagate, or another device resurrects it
    if(data.settings){ if('riskDefault' in data.settings)settings.riskDefault=data.settings.riskDefault;
      if(data.settings.view)settings.view=data.settings.view; if(data.settings.dexView)settings.dexView=data.settings.dexView; if(data.settings.rBasis)settings.rBasis=data.settings.rBasis; if(data.settings.pageSize)settings.pageSize=data.settings.pageSize; if(data.settings.beThreshold!==undefined){ settings.beThreshold=data.settings.beThreshold; settings.beFixed=data.settings.beFixed===true; /* null = auto */ } if(data.settings.theme)settings.theme=data.settings.theme; if(data.settings.anaBasis)settings.anaBasis=data.settings.anaBasis; if(data.settings.tz)settings.tz=data.settings.tz; if(data.settings.assumedLev>0)settings.assumedLev=data.settings.assumedLev; if(data.settings.rules&&typeof data.settings.rules==='object')settings.rules=data.settings.rules; if(data.settings.attribBasis)settings.attribBasis=data.settings.attribBasis; if(Array.isArray(data.settings.pins))settings.pins=data.settings.pins.filter(p=>p&&typeof p.pid==='string'); if(Array.isArray(data.settings.habits))settings.habits=data.settings.habits.filter(h=>h&&typeof h.id==='string'&&typeof h.kind==='string'); if(typeof data.settings.tzZone==='string')settings.tzZone=data.settings.tzZone; if(data.settings.calMode==='pnl'||data.settings.calMode==='process')settings.calMode=data.settings.calMode; if(data.settings.calWeeks===26||data.settings.calWeeks===52)settings.calWeeks=data.settings.calWeeks; if(typeof data.settings.coachMode==='boolean')settings.coachMode=data.settings.coachMode; if(Array.isArray(data.settings.pzPlugs))settings.pzPlugs=data.settings.pzPlugs.filter(p=>p&&typeof p.slip==='string'); if(typeof data.settings.pzProfile==='string')settings.pzProfile=data.settings.pzProfile; if(['all','perp','spot'].includes(data.settings.pzMarket))settings.pzMarket=data.settings.pzMarket; if(data.settings.pzLayout&&typeof data.settings.pzLayout==='object')settings.pzLayout=data.settings.pzLayout;
      if(data.settings.pzLessons&&typeof data.settings.pzLessons==='object')settings.pzLessons=pzLessonsNorm(data.settings.pzLessons);
      if(Array.isArray(data.settings.playbooks))settings.playbooks=pbNorm(data.settings.playbooks,true);
      if(['auto','dark','light'].includes(data.settings.appearance))settings.appearance=data.settings.appearance;
      if(['ts9','ink','bb'].includes(data.settings.colorway))settings.colorway=data.settings.colorway;
      if(typeof data.settings.pzTiltAlerts==='boolean')settings.pzTiltAlerts=data.settings.pzTiltAlerts; if(typeof data.settings.pzCoachDetail==='boolean')settings.pzCoachDetail=data.settings.pzCoachDetail;
      const tx=data.settings.taxExport; // the tax screen indexes its presets by this name: an unknown one would throw there
      if(tx&&typeof tx==='object'&&typeof tx.preset==='string'&&(typeof TAX_PRESETS==='undefined'||Object.prototype.hasOwnProperty.call(TAX_PRESETS,tx.preset)))settings.taxExport={preset:tx.preset,cur:String(tx.cur||'USD').toUpperCase().replace(/[^A-Z]/g,'').slice(0,3)||'USD'};
      if(data.settings.pzEarned&&typeof data.settings.pzEarned==='object')settings.pzEarned=_syncMerge('pzEarned',settings.pzEarned,data.settings.pzEarned); // the award ledger only grows (pzEarned)
      if(+data.settings.pzEarnedResetAt>0)settings.pzEarnedResetAt=Math.max(+settings.pzEarnedResetAt||0,+data.settings.pzEarnedResetAt); // the latest reset wins
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
async function rawSet(key,val){ if(_sample&&(key===J_KEY||key===S_KEY))val=key===J_KEY?_sample.journal:sampleOwnS();
  const s=JSON.stringify(val);
  if(window.storage){ try{ await window.storage.set(key,s); return; }catch(e){} }
  try{ localStorage.setItem(key,s); }catch(e){ storeFailed(e); } }
// The browser refused to save (its storage for this site is full): say so, instead of a "saved"
// tick over an edit that will be gone on the next load.
function storeFailed(e){ const full=e&&(e.name==='QuotaExceededError'||e.code===22||/quota/i.test(e.message||''));
  try{ setErr(full?'This browser’s storage for the journal is full, so the last change wasn’t saved here. Use Backup all, then clear old attachments or link a data file.':'Couldn’t save in this browser: '+(e&&e.message||e)); }catch(_){} }

/* ============================ sample mode ============================ */
// Sample data never touches the account: its journal and settings are set aside here while the app works
// on a scratch copy kept in memory. Store and every sync see only the account's own, which takes just the
// wallets and preferences from it. Real trades, applied data or a reload put the account's back.
let _sample=null; // {journal, settings, dirty}: the account's own, while sample data is loaded
const SAMPLE_KEEP=['wallets','theme','appearance','colorway','tz','tzZone','view','dexView','pageSize','calMode','calWeeks','coachMode','pzLayout','pzMarket','autoRefresh'];
function sampleEnter(){ if(_sample)return; _sample={journal,settings,dirty:false}; _jrev++; if(typeof pzS!=='undefined')pzS.demo=true;
  journal={}; settings=JSON.parse(JSON.stringify(settings)); delete settings.pzEarned; delete settings.pzEarnedResetAt; }
// the account's own settings, with the scratch copy's wallets and preferences
function sampleOwnS(){ const s=_sample.settings;
  for(const k of SAMPLE_KEEP){ if(settings[k]===undefined)delete s[k]; else s[k]=JSON.parse(JSON.stringify(settings[k])); } return s; }
function sampleOwn(fn){ const s=_sample, sj=journal, ss=settings; journal=s.journal; settings=sampleOwnS(); _sample=null;
  try{ return fn(); }finally{ _sample=s; journal=sj; settings=ss; } }
function sampleLeave(){ if(!_sample)return false; const s=_sample, was=JSON.stringify(s.settings);
  settings=sampleOwnS(); journal=s.journal; _sample=null; _jrev++;
  if(typeof pzS!=='undefined')pzS.demo=false;
  // what changed or met a 409 meanwhile goes out now
  if(s.dirty||JSON.stringify(settings)!==was)Promise.resolve(Store.set(S_KEY,settings)).catch(()=>{});
  return true; }

function scheduleLinkedWrite(){ if(!linkedHandle||_applying)return; clearTimeout(_writeTimer); _writeTimer=setTimeout(writeLinked,600); }

/* ============================ server sync (companion server / Railway) ============================ */
// When the app is served by the zero-dependency companion server (server.js), journal,
// wallets, settings and MAE/MFE measurements auto-save to the server and load on every
// visit — persistence that survives reboots and redeploys (given a volume). The same
// single file still works standalone from file:// or any static host: the API is
// probed once at boot and sync only activates if it answers. All compute stays in the
// browser; the server persists one JSON blob and nothing else.
// Concurrency: every write carries the last-known revision. A stale write gets a 409
// with the server's current state, which the client applies instead of clobbering it,
// laying back what it changed since (an entry both devices edited merges field by field).
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
  _jrev++; if(_sample)return; // never saved or synced
  _dirtyJ.set(id,(_dirtyJ.get(id)||0)+1); vaultMark(id); jPendingSave(); }
// The ids edited here and not yet confirmed saved (to the server, or the linked file) are kept in
// localStorage too: a reload or a closed tab before the save went through used to let the older
// copy from the server win at the next start. At boot they're laid back over what loaded.
const JP_KEY='hl_jpending_v1';
let _jpQ=false; // once per burst of edits (a bulk change marks thousands)
function jPendingSave(){ if(_jpQ)return; _jpQ=true; queueMicrotask(()=>{ _jpQ=false;
  try{ if(_dirtyJ.size)localStorage.setItem(JP_KEY,JSON.stringify([..._dirtyJ.keys()].slice(-5000))); else { localStorage.removeItem(JP_KEY); localStorage.removeItem(JP_BASE); } }catch(e){} }); }
function jPendingLoad(){ try{ const a=JSON.parse(localStorage.getItem(JP_KEY)||'[]'); return Array.isArray(a)?a.filter(x=>typeof x==='string'):[]; }catch(e){ return []; } }
// base (server sync only): the server's copy of each pending entry as of the last sync (jPendingBaseLoad);
// an entry with one merges field by field with what the server has now, the rest are laid over whole
async function jPendingOverlay(localJ,pend,base){ if(!pend.length||!localJ)return; _jrev++; let conflicts=0;
  for(const id of pend){
    if(base&&Object.prototype.hasOwnProperty.call(base,id)){ const r=jMerge3(base[id]===null?undefined:base[id],localJ[id],journal[id]); conflicts+=r.conflicts;
      if(r.v===undefined)delete journal[id]; else journal[id]=r.v; }
    else if(localJ[id]!==undefined)journal[id]=localJ[id]; else delete journal[id];
    _dirtyJ.set(id,(_dirtyJ.get(id)||0)+1); }
  if(conflicts)SRV.conflicts=(SRV.conflicts||0)+conflicts;
  await rawSet(J_KEY,journal); jPendingSave(); schedulePersist(); }
// The journal as the server last had it, for that three-way merge: the text of the last full copy
// both sides agreed on (the boot GET, the last saved PUT's body, a 409's answer), kept as it came and
// parsed only when a conflict needs it — one string, no cost per edit.
let _jBaseTxt=null,_jBaseObj=null;
function jBaseSet(txt){ _jBaseTxt=typeof txt==='string'?txt:null; _jBaseObj=null; }
// null: no base known (nothing synced yet); else {has, v}
function jBaseOf(id){ if(!_jBaseTxt)return null;
  if(!_jBaseObj){ try{ const o=JSON.parse(_jBaseTxt); _jBaseObj=(o&&o.snapshot&&o.snapshot.journal)||{}; }catch(e){ _jBaseTxt=null; return null; } }
  return Object.prototype.hasOwnProperty.call(_jBaseObj,id)?{has:true,v:_jBaseObj[id]}:{has:false}; }
// At a hide (a reload, a closed tab, a phone switching apps) with edits unsent: the server's copy of
// each, so the next start can merge them field by field if another device saved meanwhile.
const JP_BASE='hl_jpbase_v1';
function jPendingBaseSave(){ if(!_dirtyJ.size||!_jBaseTxt)return;
  try{ const o={}; for(const id of [..._dirtyJ.keys()].slice(-5000)){ const b=jBaseOf(id); if(!b)return; o[id]=b.has?b.v:null; }
    const t=JSON.stringify(o); if(t.length<1500000)localStorage.setItem(JP_BASE,t); }catch(e){} }
function jPendingBaseLoad(){ try{ const o=JSON.parse(localStorage.getItem(JP_BASE)||'null'); return o&&typeof o==='object'&&!Array.isArray(o)?o:null; }catch(e){ return null; } }
// One entry edited here and on another device since the last sync, merged against that base: a field
// only one side changed takes that change; lists (tags, mistakes…) merge item by item; a text both
// changed keeps both, theirs first, under J_CONFLICT (counted, so the sync bar can say so); any other
// value both changed keeps this device's. Deleted on one side and changed on the other: kept.
const J_CONFLICT='\n\n——— also edited on another device; this device’s version: ———\n';
function jMerge3(base,mine,theirs){
  const S=v=>JSON.stringify(v===undefined?null:v), obj=v=>!!v&&typeof v==='object'&&!Array.isArray(v);
  let conflicts=0;
  const one=(b,m,t,k)=>{ const sm=S(m),st=S(t),sb=S(b);
    if(sm===st)return m; if(sm===sb)return t; if(st===sb)return m;
    if(m===undefined)return t; if(t===undefined)return m;
    if(k==='updatedAt')return Math.max(+m||0,+t||0);
    if(obj(m)&&obj(t))return fields(obj(b)?b:{},m,t);
    if(Array.isArray(m)&&Array.isArray(t)){ const bs=new Set((Array.isArray(b)?b:[]).map(S)), ms=new Set(m.map(S));
      const out=t.filter(x=>!(bs.has(S(x))&&!ms.has(S(x)))), os=new Set(out.map(S));
      for(const x of m){ const s=S(x); if(!bs.has(s)&&!os.has(s)){ out.push(x); os.add(s); } } return out; }
    if(typeof m==='string'&&typeof t==='string'){ if(m.includes(t))return m; if(t.includes(m))return t; conflicts++; return t+J_CONFLICT+m; }
    return m; };
  const fields=(b,m,t)=>{ const out={}; for(const k of new Set([...Object.keys(t),...Object.keys(m)])){ const v=one(b[k],m[k],t[k],k); if(v!==undefined)out[k]=v; } return out; };
  const v=obj(mine)&&obj(theirs)?fields(obj(base)?base:{},mine,theirs):one(base,mine,theirs);
  return {v,conflicts}; }
const jConflictMsg=n=>n+' journal note'+(n===1?' was':'s were')+' edited on this device and another at the same time: both versions are kept, the other device’s first, under an “also edited on another device” line. Tidy '+(n===1?'it':'them')+' up when you can.';
// Settings as of the last successful sync — powers a field-level 409 merge: a goal/rule/tz
// edit made here since the last sync wins over the incoming snapshot instead of silently
// bouncing back. The wallet list rides along (`wallets`) and merges by address, as the encrypted
// sync's does: a wallet added or removed here since the last sync stays added or removed, the rest
// is theirs. (It used to be last-write-wins, which on a 409 meant the server always won: a wallet
// added here was dropped.) A baseline saved before wallets were in it merges no wallets: theirs win.
let _lastSyncedS=null;
const _SYNC_S_FIELDS=['riskDefault','view','dexView','rBasis','pageSize','beThreshold','beFixed','theme','anaBasis','tz','assumedLev','rules','attribBasis','goals','pzTiltAlerts','pzCoachDetail','taxExport','pins','habits','pzEarned','pzEarnedResetAt','tzZone','calMode','colorway','calWeeks','coachMode','pzPlugs','pzProfile','pzMarket','pzLayout','pzLessons','pzGoals','playbooks','appearance'];
// lessons and goals are lists edited on several devices: a conflict merges them by id instead of
// letting one device's copy replace the other's (the newest change to an item wins; removals stick)
function pzLessonsNorm(v){ v=v&&typeof v==='object'?v:{}; return Object.assign({},v,{items:v.items&&typeof v.items==='object'&&!Array.isArray(v.items)?v.items:{},own:Array.isArray(v.own)?v.own.filter(o=>o&&typeof o.id==='string'):[]}); }
function _syncMerge(k, mine, theirs){
  if(k==='pzEarned'){ const o=Object.assign({},theirs&&typeof theirs==='object'?theirs:{}); // the award ledger: both devices' awards; mine, unless theirs was earned since a later reset (ep)
    for(const [id,e] of Object.entries(mine&&typeof mine==='object'?mine:{}))if(!o[id]||(+(e&&e.ep)||0)>=(+(o[id]&&o[id].ep)||0))o[id]=e; return o; }
  if(k==='pzEarnedResetAt')return Math.max(+mine||0,+theirs||0)||undefined; // the latest reset
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
function _snapS(){ if(typeof _sample!=='undefined'&&_sample)return sampleOwn(_snapS); const o={}; for(const k of _SYNC_S_FIELDS)o[k]=settings[k]; o.wallets=settings.wallets; return JSON.parse(JSON.stringify(o)); }
// base: the list at the last sync; mine: this device's now; theirs: the incoming copy's
function _walletMerge(base, mine, theirs){ const wk=w=>String(w&&w.address).toLowerCase();
  const was=new Set((base||[]).map(wk)), now=new Set((mine||[]).map(wk));
  const out=(Array.isArray(theirs)?theirs:[]).filter(w=>!(was.has(wk(w))&&!now.has(wk(w)))); // removed here
  for(const w of mine||[])if(!was.has(wk(w))&&!out.some(x=>wk(x)===wk(w)))out.push(w); // added here
  return out; }
function schedulePersist(){ scheduleLinkedWrite(); scheduleServerWrite(); vaultSchedule(); }
// A failed write keeps the edits dirty, shows the error, and retries with backoff (5s → 2min), or
// once a lockout's wait (ms) is over.
function syncFailed(msg,wait){
  SRV.err=msg; SRV.retryMs=wait>0?wait+1000:Math.min(120000,(SRV.retryMs||2500)*2);
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
// The settings baseline (_lastSyncedS) is kept beside the mark, so a start that finds another device
// saved in the meantime can still tell which fields this browser changed: those are kept, the rest
// come from the server (the same field-level merge a 409 does). Without it, the whole server copy won
// and an edit made just before a reload (Light, a goal, a rule) was silently undone.
const SRV_BASE='srv_base';
function srvBaseSave(){ try{ localStorage.setItem(SRV_BASE,JSON.stringify(_lastSyncedS)); }catch(e){} }
function srvBaseRead(){ try{ const b=JSON.parse(localStorage.getItem(SRV_BASE)||'null'); return b&&typeof b==='object'?b:null; }catch(e){ return null; } }
function srvFetch(p,o){ o=o||{}; o.headers=Object.assign({},o.headers);
  if(SRV.token)o.headers['Authorization']='Bearer '+SRV.token; return fetch(p,o); }
// Resolves to what happened: 'ok' (the server has it), 'conflict' (a 409, merged; the merge is on its
// way out), 'auth', 'error', 'busy' (a save was in flight: this one runs after it), 'off'.
async function writeServer(){
  if(!SRV.enabled)return 'off';
  if(_srvWriting){ _srvAgain=true; return 'busy'; } // serialize PUTs — interleaved responses can regress SRV.rev
  _srvWriting=true;
  try{
    let excRows=null; try{ const p=await idbGet('excRows'); if(p&&p.v===1&&p.rows)excRows=p; }catch(e){}
    const snap={...snapshot()}; if(excRows)snap.excRows=excRows;
    const sentDirty=[..._dirtyJ.entries()]; // (id, counter) pairs — edits made while in flight bump the counter and stay dirty
    const sentS=_snapS(), sentGen=_srvGen, sentRestore=SRV.restoring||0;
    const body={rev:SRV.rev,snapshot:snap}; if(sentRestore)body.restore=true; // the server keeps a copy of what a restore replaces
    const sent=JSON.stringify(body); // once saved, the base the next conflict merges against
    const r=await srvFetch('/api/data',{method:'PUT',headers:{'Content-Type':'application/json'},body:sent});
    if(r.status===401){ SRV.badAuth=true; renderDatafile(); return 'auth'; }
    if(r.status===429){ syncFailed(srvLockMsg(r),(+r.headers.get('retry-after')||0)*1000); return 'error'; } // locked out: retry when it ends
    if(r.status===409){ // edited from another device since we last loaded — take theirs, but keep our unsynced edits
      if(_sample){ _sample.dirty=true; srvMark(true); renderDatafile(); return 'conflict'; } // merged after sampleLeave
      const txt=await r.text(), j=JSON.parse(txt); SRV.rev=j.rev||0;
      const n=j.snapshot?await srvTakeNewer(j,txt):0;
      if(n)setErr('Loaded newer data saved from another device. '+jConflictMsg(n));
      else setStatus('Loaded newer data saved from another device.'+(_dirtyJ.size?' Your local edits were kept and will re-sync.':''));
      renderDatafile(); return 'conflict';
    }
    if(r.ok){ const j=await r.json(); SRV.rev=j.rev||SRV.rev+1; jBaseSet(sent);
      for(const [id,rev] of sentDirty) if(_dirtyJ.get(id)===rev)_dirtyJ.delete(id); // only clear what was actually sent unchanged
      jPendingSave();
      _lastSyncedS=sentS; srvBaseSave(); SRV.err=null; SRV.retryMs=0;
      if(SRV.restoring===sentRestore)SRV.restoring=0;
      srvMark(_srvGen!==sentGen); // an edit made while this PUT was in flight is still unsent
      renderDatafile('saved'); return 'ok'; }
    else { // 413 / 5xx / proxy errors: say so — the indicator used to keep reading "saved"
      let msg='HTTP '+r.status; try{ const j=await r.json(); if(j&&j.error)msg+=': '+j.error; }catch(e){}
      syncFailed(msg); return 'error'; }
  }catch(e){ syncFailed('server unreachable'); return 'error'; }
  finally{ _srvWriting=false; if(_srvAgain){ _srvAgain=false; writeServer(); } }
}
// The server's newer copy (a 409's answer, or one srvCheckNewer fetched): take it, laying back what
// this device changed since the last sync — journal entries merged field by field against the base
// (jMerge3; laid over whole when there's none), settings fields, wallets by address — and send the
// merge at the new revision. txt: the response as text, the base from now on. Returns the number of
// notes both devices changed (kept twice, see J_CONFLICT).
async function srvTakeNewer(j,txt){
  const mine=journal, dirty=[..._dirtyJ.keys()], localS=_snapS();
  await applySnapshot(j.snapshot);
  const theirsS=_snapS(); // the incoming copy, before anything of ours is laid back
  let merged=false, conflicts=0;
  if(dirty.length){
    for(const id of dirty){ const b=SRV.restoring?null:jBaseOf(id); // a restore's entries are its word, whole
      if(b){ const r=jMerge3(b.has?b.v:undefined,mine[id],journal[id]); conflicts+=r.conflicts; if(r.v===undefined)delete journal[id]; else journal[id]=r.v; }
      else if(mine[id]!==undefined)journal[id]=mine[id]; else delete journal[id]; }
    await rawSet(J_KEY,journal); merged=true;
  }
  jBaseSet(txt);
  // field-level settings merge: fields changed here since the last successful sync
  // win over the incoming snapshot (the edit that triggered this very PUT used to
  // silently bounce back). Never-synced sessions skip this — server wins there.
  if(_lastSyncedS){
    let sChanged=false;
    for(const k of _SYNC_S_FIELDS){
      if(JSON.stringify(localS[k])!==JSON.stringify(_lastSyncedS[k])){ settings[k]=_syncMerge(k,localS[k],settings[k]); sChanged=true; }
    }
    if(Array.isArray(_lastSyncedS.wallets)){ const w=_walletMerge(_lastSyncedS.wallets,localS.wallets,settings.wallets);
      if(JSON.stringify(w)!==JSON.stringify(settings.wallets)){ settings.wallets=w; sChanged=true; } }
    if(sChanged){ await rawSet(S_KEY,settings); merged=true; }
  }
  try{ renderWallets(); }catch(e){}
  // Rebase the baseline to the incoming copy (as the encrypted sync does): fields the merge
  // didn't touch now match it, and those it re-applied from here still differ — so a second
  // 409 before this merge is pushed keeps them again instead of reading them as synced.
  // Without a rebase, a conflict applied with merged=false left the OLD baseline in place,
  // and the NEXT conflict misread server-origin values as local edits — pushing them back
  // over the other device's newer state.
  _lastSyncedS=theirsS; srvBaseSave();
  srvMark(merged);
  if(merged)scheduleServerWrite(); // push the merge at the new revision
  if(conflicts)SRV.conflicts=(SRV.conflicts||0)+conflicts;
  return conflicts; }
// Another device saved: notice it without a reload (this tab used to read "saved" over a stale copy
// until then). A cheap revision check (GET /api/data?only=rev) when the tab comes back into view or
// gets focus, and once a minute while it's visible; a newer revision is fetched and taken like a
// 409's answer. It holds the save lock meanwhile, so a save waits for it instead of racing it.
let _srvChk=0;
async function srvCheckNewer(){
  if(!SRV.enabled||(SRV.needsAuth&&(!SRV.token||SRV.badAuth))||_srvWriting||_applying||SRV.err)return false;
  if(_sample)return false; // taking it would end sample mode under the viewer: the next check after it ends takes it
  if(Date.now()-_srvChk<5000)return false; _srvChk=Date.now();
  _srvWriting=true;
  try{ const r=await srvFetch('/api/data?only=rev'); if(!r.ok)return false;
    const v=await r.json(); if(!(v&&v.rev>SRV.rev))return false;
    const d=await srvFetch('/api/data'); if(!d.ok)return false;
    const txt=await d.text(), j=JSON.parse(txt); if(!(j.rev>SRV.rev)||!j.snapshot)return false;
    SRV.rev=j.rev; const n=await srvTakeNewer(j,txt);
    if(n)setErr('Loaded newer data saved from another device. '+jConflictMsg(n)); else setStatus('Loaded newer data saved from another device.');
    renderDatafile(); srvRefreshView(); return true;
  }catch(e){ return false; }
  finally{ _srvWriting=false; if(_srvAgain){ _srvAgain=false; writeServer(); } } }
// redraw with what was fetched, unless someone is typing (their field would be redrawn under them)
function srvRefreshView(){ try{ const a=document.activeElement; if(a&&(/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)||a.isContentEditable))return;
  if(typeof PZ!=='undefined'&&PZ){ if(typeof pzRender==='function')pzRender(); } else if(typeof allTrades!=='undefined'&&allTrades.length)render(); }catch(e){} }
function srvWatch(){ if(typeof document.addEventListener!=='function'||typeof window.addEventListener!=='function')return;
  document.addEventListener('visibilitychange',()=>{ if(document.visibilityState==='visible')srvCheckNewer(); else jPendingBaseSave(); });
  window.addEventListener('focus',()=>{ srvCheckNewer(); });
  window.addEventListener('pagehide',jPendingBaseSave);
  setInterval(()=>{ if(document.visibilityState==='visible')srvCheckNewer(); },60000); }
// A restore (a pasted backup or journal, a server snapshot) is this device's word on everything it
// touched, as vaultMarkAll makes it for the encrypted sync. Before, nothing marked it: the next save
// went out at this tab's old revision, met a 409 if another device had saved since, and the 409
// merge laid the server's copy over the restore (no dirty ids to keep) while the status still said
// "restored". Now every journal id it added, changed or removed (before ∪ after) is dirty, and,
// given the wallets from before it, every settings field and the wallet list count as edits made
// here: an empty baseline makes each field "changed", and the wallet baseline stays what was synced,
// so wallets the restore added or removed merge by address. prev: the journal before the restore.
function srvRestored(prev, prevWallets){ if(!SRV.enabled)return;
  for(const id of new Set([...Object.keys(prev||{}),...Object.keys(journal)]))_dirtyJ.set(id,(_dirtyJ.get(id)||0)+1);
  _jrev++; jPendingSave();
  if(Array.isArray(prevWallets)){ const b=_lastSyncedS;
    _lastSyncedS={wallets:JSON.parse(JSON.stringify(b&&Array.isArray(b.wallets)?b.wallets:prevWallets))}; srvBaseSave(); }
  SRV.restoring=(SRV.restoring||0)+1; }
// Save now and say whether the server took it: a restore says "restored" (or reloads) only after a
// 2xx. A save already in flight finishes first (calling writeServer during it only queues a rerun,
// and a reload right after threw the restore away); a 409 merges — the restore's ids and fields are
// this device's edits, so they survive it — and the merged copy goes straight back out.
// null: no server sync here (or no token yet), so this browser's copy is the saved one.
async function srvSaveNow(){
  if(!SRV.enabled||(SRV.needsAuth&&!SRV.token))return null;
  for(let i=0;i<4;i++){
    while(_srvWriting)await new Promise(r=>setTimeout(r,50));
    clearTimeout(_srvTimer);
    const st=await writeServer();
    if(st==='ok')return true;
    if(st!=='conflict'&&st!=='busy')return false;
  }
  return false; }
// the line a restore shows when the server hasn't taken it: the copy here is intact and keeps retrying
const srvNotSaved=what=>what+' here, but the server hasn’t saved it yet ('+(SRV.badAuth?'token rejected':SRV.err||'another device keeps saving')+'). It keeps retrying — keep this tab open until the status reads saved.';
async function initServerSync(){
  if(!/^https?:$/.test(location.protocol))return false;
  try{
    // with a remembered token, ask for the data at the same time as the health check instead of after it
    let tok=null; try{ tok=localStorage.getItem('srv_token')||null; }catch(e){}
    if(tok)SRV.token=tok;
    const early=tok?srvFetch('/api/data').catch(()=>null):null;
    const h=await fetch('/api/health'); if(!h.ok)return false;
    const info=await h.json(); if(!info||info.ok!==true)return false;
    SRV.enabled=true; SRV.needsAuth=!!info.auth; srvWatch();
    if(SRV.needsAuth){ SRV.token=tok;
      if(!SRV.token){ renderDatafile(); return true; } }
    const d=(early&&await early)||await srvFetch('/api/data');
    if(d.status===401){ SRV.badAuth=true; renderDatafile(); return true; }
    if(d.status===429){ SRV.badAuth=true; renderDatafile(); setErr(srvLockMsg(d)); return true; } // locked out: never sync blind at rev 0
    if(d.ok){ const txt=await d.text(), j=JSON.parse(txt); SRV.rev=j.rev||0;
      const jBase=jPendingBaseLoad(); jBaseSet(txt); // the stored base is the one the pending edits were made on
      const m=srvMarkRead();
      if(m&&m.dirty&&m.rev===SRV.rev){ // nobody saved since this browser's unsent edits: keep them all (boot sends them)
        SRV.pushLocal=true; const ss=(j.snapshot&&j.snapshot.settings)||{};
        for(const id of jPendingLoad())_dirtyJ.set(id,(_dirtyJ.get(id)||0)+1); // still unsent: a 409 before the push keeps them
        _lastSyncedS=JSON.parse(JSON.stringify(Object.assign(Object.fromEntries(_SYNC_S_FIELDS.map(k=>[k,ss[k]])),{wallets:(j.snapshot&&j.snapshot.wallets)||[]}))); srvBaseSave(); } // the server's side, for a later 409 merge
      else { // someone else saved since: take theirs, but keep the settings this browser changed and never sent
        // The server's copy is laid over this browser's stored settings, never over the defaults:
        // this runs before boot reads them, and applySnapshot used to store the defaults plus the
        // server's fields — wiping every setting a snapshot doesn't carry (auto-refresh, tilt
        // notifications) on every reload.
        const stored=await Store.get(S_KEY); if(stored&&typeof stored==='object'&&!Array.isArray(stored))settings=stored;
        const base=m&&m.dirty?srvBaseRead():null, localS=base&&stored?JSON.parse(JSON.stringify(stored)):null;
        srvMark(false);
        // (no readable local journal: nothing to lay over — a missing copy isn't "every edit was a delete")
        if(j.snapshot){ const pend=jPendingLoad(), localJ=pend.length?await Store.get(J_KEY):null;
          await applySnapshot(j.snapshot); await jPendingOverlay(localJ,pend,jBase); }
        _lastSyncedS=_snapS(); // baseline for the field-level 409 settings merge
        if(localS&&j.snapshot){ let kept=false;
          for(const k of _SYNC_S_FIELDS)if(JSON.stringify(localS[k])!==JSON.stringify(base[k])){ settings[k]=_syncMerge(k,localS[k],settings[k]); kept=true; }
          if(Array.isArray(base.wallets)){ const w=_walletMerge(base.wallets,localS.wallets,settings.wallets);
            if(JSON.stringify(w)!==JSON.stringify(settings.wallets)){ settings.wallets=w; kept=true; } }
          if(kept){ await rawSet(S_KEY,settings); srvMark(true); SRV.pushLocal=true; } } // boot sends the kept fields
        srvBaseSave(); } }
    // PWA: only meaningful when served — installable app icon + offline shell
    try{ if('serviceWorker' in navigator)navigator.serviceWorker.register('/sw.js').catch(()=>{});
      if(!document.querySelector('link[rel=manifest]')){ const l=document.createElement('link');
        l.rel='manifest'; l.href='/manifest.webmanifest'; document.head.appendChild(l); } }catch(e){}
  }catch(e){ SRV.enabled=false; return false; }
  return true;
}
// the server locks an address out after too many wrong tokens (AUTH_FAIL_MAX): say so, and for how long
const srvLockMsg=d=>{ const s=+(d.headers&&d.headers.get('retry-after'))||0;
  return 'Locked out: too many wrong tokens from this network — try again'+(s?' in about '+Math.max(1,Math.ceil(s/60))+' min':' in a few minutes')+'.'; };
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
  p.innerHTML='<span>Loading snapshot history…</span>'; host.insertAdjacentElement('afterend',p);
  try{
    // the server's own daily snapshots, and the full backups "Backup to server" stored (fill caches included)
    const [r,rb]=await Promise.all([srvFetch('/api/snapshots'),srvFetch('/api/backups').catch(()=>null)]); if(!r.ok)throw new Error('HTTP '+r.status);
    const j=await r.json(); const snaps=j.snapshots||[];
    const backups=rb&&rb.ok?((await rb.json()).backups||[]):[];
    // a day's snapshot is that day's last save; a "before restore" copy is what a restore (or a save
    // that dropped many journal entries) replaced, kept by the server just before it wrote
    const when=s=>String(s.at||'').slice(5,16).replace('T',' ')+' UTC';
    const label=s=>s.kind==='pre-restore'?'before restore '+when(s):s.date;
    const what=s=>s.kind==='pre-restore'?'the copy kept before the restore of '+when(s):'the snapshot of '+s.date;
    // backup-2026-10-03T18-41-07-123Z.json.gz -> 10-03 18:41 UTC
    const bkWhen=n=>{ const m=/^backup-\d{4}-(\d\d-\d\d)T(\d\d)-(\d\d)/.exec(n); return m?m[1]+' '+m[2]+':'+m[3]+' UTC':n; };
    p.innerHTML=(snaps.length?'<span data-tip="One snapshot per day (UTC), kept for 14 days: the last save of that day. Restoring loads it and saves it as the newest revision — nothing is deleted: the server first keeps a copy of what the restore replaces, listed here as “before restore” (the newest 5 are kept).">Server snapshots — restore a previous day:</span> '+
      snaps.map(s=>`<button class="df-btn snapRestore" data-d="${esc(s.id||s.date)}" data-l="${esc(label(s))}" data-w="${esc(what(s))}">${esc(label(s))}${s.rev!=null?' · rev '+esc(s.rev):''} · ${(s.bytes/1024).toFixed(0)}kB</button>`).join(' ') // server JSON is still an external input — escape like every other sink
      :'<span>No snapshots yet — one is kept per day (UTC), updated with each save.</span>')
      +(backups.length&&typeof restoreBackup==='function'?'<div style="margin-top:6px"><span data-tip="Full backups made with Export &amp; tools → Backup to server (the newest 10), fill caches included. Restoring one works like opening a backup file: wallets and settings come from it, your journal is merged, and the server first keeps a copy of what it replaces.">Server backups:</span> '+
        backups.map(b=>`<button class="df-btn bkRestore" data-n="${esc(b.name)}" data-l="${esc(bkWhen(b.name))}">${esc(bkWhen(b.name))} · ${(b.bytes/1024).toFixed(0)}kB</button>`).join(' ')+'</div>':'');
    p.querySelectorAll('.snapRestore').forEach(b=>{ b.onclick=async()=>{
      if(!confirm('Restore '+b.dataset.w+'? Your current data will be replaced (the server keeps a copy of it first, listed here as “before restore”).'))return;
      b.disabled=true; b.textContent='restoring…';
      try{
        const rr=await srvFetch('/api/snapshots/'+encodeURIComponent(b.dataset.d)); if(!rr.ok)throw new Error('HTTP '+rr.status);
        const jj=await rr.json();
        if(!(jj&&jj.snapshot))throw new Error('snapshot empty');
        const before=journal, bw=settings.wallets;
        await applySnapshot(jj.snapshot); srvRestored(before,bw);
        // reload only once the server holds it: a 409 or a save in flight used to undo it
        if(await srvSaveNow()===false){ setErr(srvNotSaved('Snapshot restored')); b.textContent='restored here — not saved yet'; return; }
        location.reload();
      }catch(e){ setErr('Restore failed: '+e.message); b.disabled=false; b.textContent=b.dataset.l; }
    }; });
    // the same restore as opening the backup file (restoreBackup, app/data-io.js): it asks first
    p.querySelectorAll('.bkRestore').forEach(b=>{ b.onclick=async()=>{
      b.disabled=true; const t=b.textContent; b.textContent='loading…';
      try{
        const rr=await srvFetch('/api/backups/'+encodeURIComponent(b.dataset.n)); if(!rr.ok)throw new Error('HTTP '+rr.status);
        const data=await rr.json(); if(!(data&&(data.journal||data.wallets||data.settings)))throw new Error('not a backup');
        b.textContent=await restoreBackup(data,'the server backup of '+b.dataset.l)?'restored':t;
      }catch(e){ setErr('Restore failed: '+e.message); b.textContent=t; }
      b.disabled=false;
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
  // the welcome screen's line on where the journal lives follows the mode actually in use
  const es=$('emptySaved'); if(es)es.textContent=SRV.enabled&&!(SRV.needsAuth&&(!SRV.token||SRV.badAuth))?'Your journal syncs to this server, so it’s there on every device you open it on.'
    :SRV.enabled?'Your journal is saved in this browser until you enter the server’s access token.':linkedHandle?'Your journal auto-saves to '+linkedName+'.':'Your journal is saved locally on this device.';
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
    el.className='datafile'+(SRV.needsAuth?' on':''); // no green light on an open server
    { const bs=$('backupSrv'); if(bs)bs.classList.remove('hide'); } // server present + authed — offer server-held backups
    const tag=SRV.err?`<span style="color:var(--loss)" data-tip="Your edits are kept in this browser and retried automatically.">not saved — ${esc(SRV.err)} · retrying</span>`
      :state==='saved'?'<span style="color:var(--profit)">saved</span>':'synced';
    // an open server (no AUTH_TOKEN): sync works, and so does everyone else's access — say it every time
    const open=SRV.needsAuth?'':`<span style="color:var(--loss)" data-tip="Set AUTH_TOKEN on the server (README-deploy.md, step 3: a long random string) and restart it. The app then asks for it once per browser.">⚠ This server has no AUTH_TOKEN — anyone with the URL can read and change your journal</span>`;
    const both=SRV.conflicts?`<span style="color:var(--gold)" data-tip="${esc(jConflictMsg(SRV.conflicts))}">⚠ ${SRV.conflicts} note${SRV.conflicts===1?'':'s'} edited on two devices — both versions kept</span>`:'';
    el.innerHTML=`<span class="dot"></span><span data-tip="Journal, wallets, settings and MAE/MFE measurements auto-save to this server on every change and load on every visit — reboots and redeploys are covered as long as the server has a persistent volume. Journal image attachments sync too; candle caches stay in this browser (re-fetchable).">☁ Server sync · rev ${SRV.rev} · ${tag}</span>${open}${both}
      <span class="sp"></span><button class="df-btn" id="srvHist" data-tip="Rotating daily snapshots kept on the server (last 14 days), and the full backups made with Backup to server. Restore any of them if a sync or edit went wrong.">History</button><button class="df-btn" id="srvSaveNow">Save now</button>${typeof toggleArchivePanel==='function'?'<button class="df-btn" id="srvArchive" data-tip="Hyperliquid’s node-data archive on S3: check coverage, diagnose the AWS key, fetch a sample hour, run or watch a backfill of the fills the public API no longer serves.">Archive</button>':''}`;
    $('srvSaveNow').onclick=writeServer;
    { const ab=$('srvArchive'); if(ab)ab.onclick=()=>toggleArchivePanel($('datafile')); }
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
    catch(e){ if(attempt++<MAX&&(typeof navigator==='undefined'||navigator.onLine!==false)){ await sleep(backoff(attempt)); continue; } throw new Error('Network error reaching Hyperliquid — check your connection.'); } // offline: say so now, not after the retries
    if(res.ok) return res.json();
    // 429 (rate limit) and 5xx are transient: honor Retry-After, else exponential backoff
    if((res.status===429||res.status>=500)&&attempt++<MAX){
      const ra=parseFloat(res.headers.get('retry-after'));
      await sleep(isFinite(ra)?Math.min(15000,ra*1000):backoff(attempt)); continue;
    }
    throw new Error('API '+res.status);
  }
}
// One execution, whatever endpoint served it: the same coin, time, side, size, price and starting
// position can't be two fills (a fill of any size moves the position, so the next one starts
// elsewhere). The key the TWAP merge below falls back on, should the exchange ever serve a slice
// under one trade id in userFills and another in userTwapSliceFills — counted twice, it would
// move the position off every later fill's startPosition and read as a seam on every TWAP.
async function fetchAllFills(addr, since=0){
  const fillSame=f=>[f.coin,f.time,f.side,f.sz,f.px,f.startPosition].join('|'); // local: the tests and the server lift this function out on its own
  let start=since, all=[], pages=0, truncated=false; const seen=new Set(), same=new Set();
  const add=f=>{ const id=f.tid+'-'+f.oid+'-'+f.time; if(!seen.has(id)){ seen.add(id); same.add(fillSame(f)); all.push(f);} };
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
  const tw=await fetchTwapFills(addr,since);
  for(const f of tw.fills) if(!same.has(fillSame(f))) add(f);
  if(tw.partial&&typeof _fetchHealth!=='undefined'&&_fetchHealth)_fetchHealth.twap=true;
  return {fills:all, truncated, twapPartial:!!tw.partial};
}
// Every TWAP slice fill the exchange still serves, from `since` on. userTwapSliceFills returns
// only the newest 2,000 slices: a wallet that TWAPs out of its positions had everything older
// vanish — the exit of a trade and its whole P&L with it — which is where most of the gap to
// Hyperliquid's own P&L figure came from. userTwapSliceFillsByTime pages by time, 2,000 per
// response, resumed AT the boundary millisecond like fetchAllFills (dupes are keyed out by the
// caller). The exchange keeps slices for about three months, so each load caches what it can
// still get; the newest-2,000 call stays as a fallback if the by-time call is ever refused.
async function fetchTwapFills(addr, since=0){
  const out=[]; const seen=new Set();
  const add=f=>{ if(!f||!(f.time>=since))return; const id=f.tid+'-'+f.oid+'-'+f.time; if(!seen.has(id)){ seen.add(id); out.push(f); } };
  let start=since>0?since:0, pages=0, partial=false;
  try{
    while(pages<60){
      const batch=await hlPost({type:'userTwapSliceFillsByTime',user:addr,startTime:start});
      if(!Array.isArray(batch)||batch.length===0) break;
      for(const r of batch) add(r&&r.fill);
      if(batch.length<2000) break;
      const mx=Math.max(...batch.map(r=>(r&&r.fill&&r.fill.time)||0));
      start=mx>start?mx:mx+1; pages++; await sleep(40);
    }
    if(pages>=60) partial=true;
  }catch(e){ partial=true;
    try{ const tw=await hlPost({type:'userTwapSliceFills',user:addr});
      if(Array.isArray(tw)){ for(const r of tw) add(r&&r.fill); partial=tw.length>=2000; } // 2,000 served = there may be older ones
    }catch(e2){}
  }
  return {fills:out, partial};
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
    // all-time volume too: the fills the exchange still serves are measured against it (fill coverage)
    const vlm=label=>{ const e=(res||[]).find(x=>x[0]===label); const v=e&&e[1]?parseFloat(e[1].vlm):NaN; return isFinite(v)?v:null; };
    // the whole curve too (weekly points over all time): the equity curve and drawdown when the fills can't give them
    const hist=label=>{ const e=(res||[]).find(x=>x[0]===label); const h=(e&&e[1]&&e[1].pnlHistory)||[]; const out=[];
      for(const p of h){ const t=+p[0], v=parseFloat(p[1]); if(isFinite(t)&&isFinite(v))out.push([t,v]); } return out; };
    return {all:last('allTime','pnlHistory'), perp:last('perpAllTime','pnlHistory'), accountValue:last('allTime','accountValueHistory'),
      vlm:vlm('allTime'), perpVlm:vlm('perpAllTime'), hist:{all:hist('allTime'),perp:hist('perpAllTime')}};
  }catch(e){ return {all:null,perp:null,accountValue:null,vlm:null,perpVlm:null,hist:null}; }
}
// A portfolio-margin account's balance: the exchange's own account value (spot and perps as one), or
// the spot balances valued at mark when that isn't readable. null for an ordinary account, whose perp
// and spot balances are read separately. Hyperliquid's docs: "Under unified account or portfolio
// margin, use spot balances endpoint instead for trading account balance across spot and perps."
function unifiedAccountOf(sbal, port, spotVal){
  if(!sbal||!sbal.portfolioMargin)return null;
  const v=port&&port.accountValue; return isFinite(v)&&v!=null?v:(isFinite(spotVal)?spotVal:null);
}
