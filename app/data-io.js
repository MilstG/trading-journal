// Ledger app · part 8 of 15: wallets and loading, CSV import, UI events.
// ledger.html loads the parts in order as classic scripts sharing one global scope. Code that
// runs while a part loads (not inside a function called later) may only use names declared in
// this part or an earlier one; the boot part runs last. See "Development and testing" in README.md.

/* ============================ wallets + load ============================ */
function renderWallets(){
  $('wallets').innerHTML=settings.wallets.map((w,i)=>
    `<span class="wchip">${w.label?`<span class="lbl">${esc(w.label)}</span>`:''}<span class="ad">${esc(walletShort(w.address))}</span>${isCexVenue(venueOf(w))?`<button class="rm" data-cexkey="${i}" title="Enter this account’s API key on this device" aria-label="API key for ${esc(labelFor(w))}">key</button>`:''}<button class="rm" data-rm="${i}" title="Remove" aria-label="Remove wallet ${esc(w.label||walletShort(w.address))}">×</button></span>`
  ).join('');
}
// One address, every venue it trades on: Hyperliquid and Lighter are both checked and each one
// with an account is added (venues.js: walletIdsFor). "lighter:0x…" adds the Lighter one only.
async function addWalletFromInput(){
  const raw=$('walletAddr').value.trim(), label=$('walletLabel').value.trim();
  const forced=/^lighter:/i.test(raw), address=raw.replace(/^lighter:/i,'');
  if(!/^0x[0-9a-fA-F]{40}$/.test(address)){ setErr('That doesn\u2019t look like a 0x wallet address (42 chars). For Bybit or Binance, use \u201cConnect exchange\u201d.'); return false; }
  // trade ids (and so your notes) include the address as written: a wallet added again in other
  // letter case takes the spelling its notes already use; a new one is stored in lower case
  const lc=address.toLowerCase(), known=Object.keys(journal).map(k=>k.split(':')[0]).find(a=>a.toLowerCase()===lc);
  setStatus('Looking for '+walletShort(address)+' on Hyperliquid and Lighter\u2026',true);
  const ids=(await walletIdsFor(address,forced?['lighter']:null)).map(id=>venueOfAddr(id)==='lighter'?'lighter:'+lc:(known||lc));
  const have=new Set(settings.wallets.map(w=>String(w.address).toLowerCase()));
  const add=ids.filter(id=>!have.has(id.toLowerCase()));
  if(!add.length){ setErr('That wallet is already in the list.'); return false; }
  for(const id of add)settings.wallets.push({address:id,label});
  await Store.set(S_KEY,settings);
  $('walletAddr').value=''; $('walletLabel').value=''; renderWallets();
  const names=add.map(id=>VENUE_NAMES[venueOfAddr(id)]);
  setStatus('Added on '+names.join(' and ')+' · '+settings.wallets.length+' wallet'+(settings.wallets.length===1?'':'s')+' in the list · hit Load all.');
  return true;
}
async function removeWallet(i){
  const w=settings.wallets[i]; if(!w)return;
  settings.wallets.splice(i,1); await Store.set(S_KEY,settings); renderWallets(); forgetVenueWallet(w);
  allTrades=allTrades.filter(t=>!t.wallet||t.wallet.address!==w.address);
  openPositions=openPositions.filter(p=>!p.wallet||p.wallet.address!==w.address);
  spotHoldings=spotHoldings.filter(p=>!p.wallet||p.wallet.address!==w.address);
  hlPnl={all:null,perp:null};
  // per-wallet equity isn't tracked, so the aggregates are unknowable until the next load —
  // null beats keeping the removed wallet's money in the capital card's equity
  accountValue=null; spotAccountValue=null; unifiedAccountValue=null;
  resetDerivedState(w.address); // drop the removed wallet's capital flows + derived caches
  // its data-health warnings go too (truncation entries are keyed by label, possibly with
  // a suffix); partial-fetch flags are load-scoped, so clear and let the next load re-flag
  const lbl=labelFor(w);
  fillsTruncated=(Array.isArray(fillsTruncated)?fillsTruncated:[]).filter(x=>x!==lbl&&!String(x).startsWith(lbl+' ('));
  _fetchHealth={funding:false,ledger:false};
  if(allTrades.length||openPositions.length||spotHoldings.length){ render(); } else { $('app').classList.add('hide'); $('empty').classList.remove('hide'); }
  setStatus('Removed '+labelFor(w)+(settings.wallets.length?'':' · list empty'));
}
// ---- loading one wallet: cached first, then only what's new, everything independent in parallel ----
// a new device on a synced server: seed this browser's caches from the server's copy in one download
async function srvSeed(a){
  if(!(typeof SRV!=='undefined'&&SRV.enabled&&(SRV.token||!SRV.needsAuth)&&!SRV.badAuth))return null;
  try{ const r=await srvFetch('/api/v1/cache/'+a); if(!r.ok)return null; const j=await r.json();
    const lastOf=rows=>rows.reduce((m,x)=>x.time>m?x.time:m,0);
    if(!j||!j.fills||!Array.isArray(j.fills.fills)||!j.fills.fills.length)return null;
    return {truncated:!!j.fills.truncated,fills:{v:2,fills:j.fills.fills,last:j.fills.last||lastOf(j.fills.fills),seeded:true},
      funding:j.funding&&Array.isArray(j.funding.rows)?{v:1,rows:j.funding.rows,last:lastOf(j.funding.rows),seeded:true}:null,
      ledger:j.ledger&&Array.isArray(j.ledger.rows)?{v:1,rows:j.ledger.rows,last:lastOf(j.ledger.rows),seeded:true}:null};
  }catch(e){ return null; } }
// what the dashboard showed last time (positions, balances, capital flows), so the next start can show it at once
const VIEW_KEY='view:last', walletsSig=()=>settings.wallets.map(w=>String(w.address).toLowerCase()).sort().join(',');
function saveLastView(){ try{ idbSet(VIEW_KEY,{v:1,key:walletsSig(),at:Date.now(),positions:openPositions,accountValue,spotHoldings,spotAccountValue,unifiedAccountValue,hlPnl,ledFlows,ledSkipped}); }catch(e){} }
// Opening the app shows your saved data at once — trades rebuilt from the cached fills and funding,
// positions as they were last time — and the refresh runs quietly behind it.
async function bootFromCache(){
  if(!settings.wallets.length||allTrades.length)return false;
  try{
    const [view,sm0]=await Promise.all([idbGet(VIEW_KEY),idbGet('spotMaps')]);
    const sm=sm0&&sm0.nameByCoin?sm0:{nameByCoin:{},markBySym:{USDC:1}};
    const per=await Promise.all(settings.wallets.map(async w=>{ const a=w.address;
      if(venueOf(w)!=='hyperliquid')return venueBootTrades(w);
      const [fc,fd]=await Promise.all([idbGet('flc:'+a).then(unpackFillCache).catch(()=>null),idbGet('fnd:'+a).catch(()=>null)]);
      if(!fc||!Array.isArray(fc.fills)||!fc.fills.length)return null;
      const frows=fd&&fd.v===1&&Array.isArray(fd.rows)?fd.rows:[], lastF=fd&&fd.last||0;
      const r=await reconstructCompute(fc.fills,frows,a);
      r.spot.forEach(t=>{ t.symbol=sm.nameByCoin[t.coin]||t.coin; t.quote=(sm.quoteByCoin||{})[t.coin]||null; }); [...r.perp,...r.spot].forEach(t=>t.wallet={address:a,label:w.label});
      _recMemo[a.toLowerCase()]={sig:recSig(fc.fills,fc.last||fc.fills.reduce((m,f)=>f.time>m?f.time:m,0),frows,lastF),perp:r.perp,spot:r.spot};
      return r.perp.concat(r.spot); }));
    if(per.some(x=>!x)||allTrades.length)return false; // a wallet with no cache waits for the real load
    allTrades=per.flat().sort((x,y)=>y.openTime-x.openTime); spotMaps=sm;
    if(view&&view.v===1&&view.key===walletsSig()){ openPositions=view.positions||[]; accountValue=view.accountValue??null; spotHoldings=view.spotHoldings||[];
      spotAccountValue=view.spotAccountValue??null; unifiedAccountValue=view.unifiedAccountValue??null; hlPnl=view.hlPnl||{all:null,perp:null}; ledFlows=view.ledFlows||[]; ledSkipped=view.ledSkipped||0; }
    $('empty').classList.add('hide'); $('app').classList.remove('hide'); $('setupPanel').classList.add('hide');
    try{ render(); }catch(e){ console.warn('cached render',e); }
    // the saved positions are hours or days old: the intraday open-P&L baseline waits for live ones
    if(typeof _uPnlBase!=='undefined')_uPnlBase={day:null,val:0};
    if(PZ)pzRender();
    const mins=view&&view.at?Math.round((Date.now()-view.at)/60000):null;
    const ago=mins==null?'':mins<1?'just now':mins<60?mins+' min ago':mins<2880?Math.round(mins/60)+'h ago':Math.round(mins/1440)+' days ago';
    if(PZ)pzNote('Showing your saved data'+(ago?' from '+ago:'')+' — refreshing…'); else setStatus('Showing your saved data'+(ago?' from '+ago:'')+' — checking for anything new…',true);
    return true;
  }catch(e){ console.warn('cached start',e); return false; }
}
async function mapLimit(list,n,fn){ const out=new Array(list.length); let k=0;
  await Promise.all(Array.from({length:Math.min(n,list.length)},async()=>{ while(k<list.length){ const i=k++; out[i]=await fn(list[i],i); } })); return out; }
// merge freshly fetched rows into a cached list by key; the watermark is the newest time seen
function mergeRows(cached,fresh,keyOf){ const rows=(cached||[]).slice(), seen=new Set(rows.map(keyOf)); let added=0;
  for(const r of (fresh||[])){ const k=keyOf(r); if(!seen.has(k)){ seen.add(k); rows.push(r); added++; } }
  return {rows,added,last:rows.reduce((m,r)=>r.time>m?r.time:m,0)}; }
const fundKey=r=>r.time+'|'+r.coin;
// rebuilding trades is skipped when a wallet's fills and funding haven't changed since the last rebuild
var _recMemo={};
const recSig=(fills,lastF,frows,lastR)=>fills.length+'|'+lastF+'|'+frows.length+'|'+lastR;
async function loadWallet(w,fresh,spotP){
  if(venueOf(w)!=='hyperliquid')return loadVenueWallet(w,fresh); // Lighter, Bybit, Binance: venues.js
  const a=w.address, fcKey='flc:'+a, fdKey='fnd:'+a, lgKey='lgu:'+a;
  const [fc0,fd0,lg0]=fresh?[null,null,null]:await Promise.all([idbGet(fcKey).then(unpackFillCache).catch(()=>null),idbGet(fdKey).catch(()=>null),idbGet(lgKey).catch(()=>null)]);
  let fcache=fc0&&fc0.v===2&&Array.isArray(fc0.fills)?fc0:null;
  let fdc=fd0&&fd0.v===1&&Array.isArray(fd0.rows)?fd0:null, lgc=lg0&&lg0.v===1&&Array.isArray(lg0.rows)?lg0:null;
  // a new device on a synced server: start from the server's copy instead of the whole history
  let seededTrunc=false;
  if(!fcache&&!fresh){ const seed=await srvSeed(a); if(seed){ fcache=seed.fills; fdc=fdc||seed.funding; lgc=lgc||seed.ledger; seededTrunc=seed.truncated; } }
  // everything that doesn't need the fills starts now
  const fundP=fetchFunding(a,fdc?fdc.last:0), ledP=fetchLedgerUpdates(a,lgc?lgc.last:0), spotStP=fetchSpotState(a), portP=fetchPortfolio(a);
  const fr=await fetchAllFills(a,fcache&&fcache.last?fcache.last:0); // resume AT the watermark — the merge dedupes, boundary-ms fills are never skipped
  let fills, added=0, truncNote=null;
  if(fcache){
    const seen=new Set(fcache.fills.map(f=>f.tid+'-'+f.oid+'-'+f.time));
    fills=fcache.fills.slice();
    for(const f of fr.fills){ const id=f.tid+'-'+f.oid+'-'+f.time; if(!seen.has(id)){ seen.add(id); fills.push(f); added++; } }
    // A truncated incremental fetch means a gap between the cache and now that the
    // advancing watermark would otherwise paper over permanently — say so loudly.
    if(fr.truncated)truncNote=labelFor(w)+' (since last load — Shift-click Load all for a full refetch)';
    else if(seededTrunc)truncNote=labelFor(w)+' (the server’s copy is missing older history)';
  } else { fills=fr.fills; added=fills.length; if(fr.truncated)truncNote=labelFor(w); }
  const lastT=fills.reduce((m,f)=>f.time>m?f.time:m,0);
  // nothing new: the stored copy is already current, so skip re-compressing it
  if(!fcache||added>0||fcache.seeded){ try{ await idbSet(fcKey,await packFillCache(fills,lastT)); }catch(e){} }
  const posP=fetchPositions(a,hip3DexsFromFills(fills));
  const [fnew,lnew,ch,sbal,port]=await Promise.all([fundP,ledP,posP,spotStP,portP]);
  const fm=mergeRows(fdc&&fdc.rows,fnew,fundKey), lm=mergeRows(lgc&&lgc.rows,lnew,ledgerRowId);
  if(!fdc||fm.added||fdc.seeded)idbSet(fdKey,{v:1,rows:fm.rows,last:fm.last,savedAt:Date.now()});
  if(!lgc||lm.added||lgc.seeded)idbSet(lgKey,{v:1,rows:lm.rows,last:lm.last,savedAt:Date.now()});
  const cf=capitalFlows(lm.rows,a);
  // a transfer BETWEEN two loaded wallets appears as -X in one and +X in the other, which correctly nets to zero for combined capital
  const flows=cf.flows.map(f=>({...f,wallet:a}));
  const sig=recSig(fills,lastT,fm.rows,fm.last), memo=_recMemo[a.toLowerCase()];
  let perpTr, spotTr;
  if(memo&&memo.sig===sig&&!fresh){ perpTr=memo.perp; spotTr=memo.spot; }
  else { setStatus(`Reconstructing trades for ${labelFor(w)}…`,true);
    // reconstruction runs in the compute worker — large wallets don't freeze the UI
    ({perp:perpTr,spot:spotTr}=await reconstructCompute(fills,fm.rows,a)); }
  const sm=await spotP;
  spotTr.forEach(t=>{ t.symbol=sm.nameByCoin[t.coin]||t.coin; t.quote=(sm.quoteByCoin||{})[t.coin]||null; });
  [...perpTr,...spotTr].forEach(t=>t.wallet={address:a,label:w.label});
  _recMemo[a.toLowerCase()]={sig,perp:perpTr,spot:spotTr};
  ch.positions.forEach(p=>p.wallet={address:a,label:w.label});
  // An "open" trade the exchange says you no longer hold lost its closing fill (a liquidation, ADL,
  // settlement, or a gap in the history). It's closed, but its result is incomplete: kept out of the
  // stats and named in the data-health note. Only judged against clearinghouses that answered.
  const live=new Set(ch.positions.map(p=>p.coin)), ok=ch.okDex||new Set(['']);
  for(const t of perpTr){ const dex=/^([A-Za-z0-9_-]+):/.exec(t.coin); t.orphan=!!(t.isOpen&&ok.has(dex?dex[1]:'')&&!live.has(t.coin)); }
  const heldUsd=new Map(sbal.map(b=>[b.coin,b.total*(sm.markBySym[b.coin]||0)]));
  for(const t of spotTr){ t.orphan=!!(t.isOpen&&sbal.length&&!(heldUsd.get(t.symbol)>=1)); }
  let spotVal=0; const spotHold=[];
  sbal.forEach(b=>{ const mark=sm.markBySym[b.coin]||(b.coin==='USDC'?1:0); const value=b.total*mark; spotVal+=value;
    if(b.coin!=='USDC' && b.total>1e-9 && (value>=1 || b.entry>=1)){ spotHold.push({coin:b.coin,total:b.total,entry:b.entry,mark,value,uPnl:value-b.entry,wallet:{address:a,label:w.label}}); } });
  // portfolio margin: one balance for spot and perps, so it's the account value in every view
  const unified=unifiedAccountOf(sbal,port,spotVal);
  return {added,cached:!!fcache,truncNote,flows,skipped:cf.skipped,nFills:fills.length,trades:perpTr.concat(spotTr),positions:ch.positions,
    accountValue:unified!=null?unified:ch.accountValue,port,spotHold,spotVal:unified!=null?unified:spotVal,spotHas:sbal.length>0||unified!=null,unified};
}
async function loadAll(opts){ opts=opts||{}; const fresh=!!opts.fresh, auto=!!opts.auto;
  if(_loading)return; _loading=true; _pzQuiet=auto&&allTrades.length>0; try{
  if($('walletAddr').value.trim()){ if(!await addWalletFromInput()) return; }
  if(!settings.wallets.length){ setErr('Add at least one wallet address first.'); return; }
  if(typeof socWalletsSeen==='function')try{ socWalletsSeen(); }catch(e){} // the league's admin sees every wallet entered (pulse-social.js)
  $('loadAll').disabled=true;
  let trades=[], positions=[], accVals=[], spotHold=[], spotAccVals=[], uniVals=[], totalFills=0, failed=[];
  let portAll=0, portPerp=0, portAllHas=false, portPerpHas=false;
  let truncated=[], newFills=0, cachedN=0, flowsAcc=[], skippedAcc=0;
  _fetchHealth={funding:false,ledger:false}; // fresh load, fresh health
  try{
    // spot metadata and every wallet load side by side — two wallets at a time, so a long list
    // stays inside the exchange's rate limit
    setStatus('Loading '+settings.wallets.length+' wallet'+(settings.wallets.length===1?'':'s')+'…',true);
    const spotP=fetchSpotMaps().then(m=>{ if(m&&Object.keys(m.nameByCoin||{}).length)idbSet('spotMaps',m); return m; });
    const results=await mapLimit(settings.wallets,2,w=>loadWallet(w,fresh,spotP).catch(e=>{ console.warn('wallet load',e); return {failed:true,error:e&&e.message}; }));
    spotMaps=await spotP;
    results.forEach((r,i)=>{ const w=settings.wallets[i];
      // another venue's reason is worth reading (a key to add on this device, a region the exchange refuses)
      if(r.failed){ failed.push(labelFor(w)+(r.error&&venueOf(w)!=='hyperliquid'?' — '+r.error:'')); return; }
      newFills+=r.added; if(r.cached)cachedN++; if(r.truncNote)truncated.push(r.truncNote);
      for(const f of r.flows)flowsAcc.push(f); skippedAcc+=r.skipped; totalFills+=r.nFills;
      trades=trades.concat(r.trades); positions=positions.concat(r.positions);
      if(r.accountValue!=null)accVals.push(r.accountValue);
      if(r.port.all!=null){portAll+=r.port.all;portAllHas=true;}
      if(r.port.perp!=null){portPerp+=r.port.perp;portPerpHas=true;}
      spotHold=spotHold.concat(r.spotHold); if(r.spotHas)spotAccVals.push(r.spotVal); if(r.unified!=null)uniVals.push(r.unified);
    });
    if(!trades.length && !positions.length && !spotHold.length){
      // check BEFORE clobbering globals: an auto-refresh where every wallet failed
      // (offline laptop) must keep the current view instead of blanking the dashboard
      if(auto){ setStatus('Auto-refresh got nothing'+(failed.length?' (failed: '+failed.join(', ')+')':'')+' — keeping the current view.'); return; }
      allTrades=[]; openPositions=[]; spotHoldings=[];
      setErr('No activity found'+(failed.length?' · failed: '+failed.join(', '):'')+'.'); return; }
    allTrades=trades.sort((a,b)=>b.openTime-a.openTime);
    openPositions=positions; accountValue=accVals.length?accVals.reduce((a,b)=>a+b,0):null;
    spotHoldings=spotHold; spotAccountValue=spotAccVals.length?spotAccVals.reduce((a,b)=>a+b,0):null;
    unifiedAccountValue=uniVals.length?uniVals.reduce((a,b)=>a+b,0):null;
    fillsTruncated=truncated;
    ledFlows=flowsAcc.sort((a,b)=>a.time-b.time); ledSkipped=skippedAcc;
    // purge stale open-window MAE/MFE for trades that have since closed — the ratchet
    // re-measures them entry-to-exit on its next pass
    { const closedIds=new Set(allTrades.filter(t=>!t.isOpen).map(t=>t.id));
      for(const id in _excM) if(_excM[id]&&_excM[id].openMeas&&closedIds.has(id)) delete _excM[id]; }
    hlPnl={all:portAllHas?portAll:null, perp:portPerpHas?portPerp:null};
    try{ $('empty').classList.add('hide'); $('app').classList.remove('hide'); $('setupPanel').classList.add('hide'); render(); }
    catch(e){ console.error(e); setErr('Data loaded, but hit an error drawing the dashboard ('+e.message+'). Please reload.'); return; }
    saveLastView();
    const perpN=allTrades.filter(t=>!t.isOpen&&t.market==='perp').length, spotN=allTrades.filter(t=>!t.isOpen&&t.market==='spot').length, ok=settings.wallets.length-failed.length;
    const cacheNote=cachedN?` · ${newFills} new fill${newFills===1?'':'s'} since last load`:'';
    setStatus(`${totalFills} fills → ${perpN} perp + ${spotN} spot trades across ${ok} wallet${ok===1?'':'s'}${cacheNote}${failed.length?' · could not load: '+failed.join(', '):''}${truncated.length?' · ⚠ fill history truncated (60-page cap) for: '+truncated.join(', ')+' — oldest trades may be missing':''}`);
  }catch(e){ console.error(e);
    // a background refresh failing (offline laptop, transient outage) is not banner-worthy —
    // it retries in 3 minutes; only a user-initiated load earns the error treatment
    if(auto) setStatus('Auto-refresh failed ('+e.message+') — retrying on the next cycle.');
    else setErr('Couldn\u2019t reach the exchange from the browser ('+e.message+'). Use “Paste data” instead.'); }
  finally{ $('loadAll').disabled=false; }

  } finally { _loading=false; _pzQuiet=false; if(PZ&&pzS.note&&pzS.note.kind==='busy')pzS.note=null;
    // Pulse has no data-health strip: say once when an open trade turned out to be closed off the record
    if(PZ){ const o=allTrades.filter(t=>t.orphan), k=o.map(t=>t.id).join('|'); if(o.length&&k!==_orphSeen){ _orphSeen=k;
      pzNote(o.length+' position'+(o.length===1?'':'s')+' ('+o.slice(0,3).map(t=>dispMarket(dcoin(t))+' '+(t.dir||'').toLowerCase()).join(', ')+') closed without a closing fill in your history — likely a liquidation. Left out of your stats.'); } }
    // new fills for today: check them for a tilt pattern before drawing (the banner shows on this render)
    if(PZ){ try{ pzTiltAlertCheck(); }catch(e){ console.warn('tilt alerts',e); } pzRender(); } }
  // measuring excursions fetches candles: wait until the browser is idle so it never competes with the first paint
  if(typeof requestIdleCallback==='function')requestIdleCallback(()=>autoRatchet(),{timeout:8000}); else setTimeout(autoRatchet,3000);
}
/* ============================ generic CSV fill import ============================ */
// RFC-4180-ish row splitter: quoted fields, doubled quotes, CRLF or LF.
function csvParseRows(text){
  const rows=[]; let row=[], cell='', q=false;
  for(let i=0;i<text.length;i++){ const ch=text[i];
    if(q){ if(ch==='"'){ if(text[i+1]==='"'){ cell+='"'; i++; } else q=false; } else cell+=ch; }
    else if(ch==='"')q=true;
    else if(ch===','){ row.push(cell); cell=''; }
    else if(ch==='\n'||ch==='\r'){ if(ch==='\r'&&text[i+1]==='\n')i++;
      row.push(cell); cell=''; if(row.length>1||row[0]!=='')rows.push(row); row=[]; }
    else cell+=ch;
  }
  if(cell!==''||row.length){ row.push(cell); if(row.length>1||row[0]!=='')rows.push(row); }
  return rows;
}
// Header-mapped CSV fills → HL-shaped fills for the exact reconstruction path exchange
// data takes. Column names are matched loosely (case/punctuation-insensitive) against the
// aliases below, so exports from other venues or a hand-built spreadsheet both work.
// startPosition and closedPnl are derived (running position + average-cost realization)
// when the CSV lacks them — exact when the file carries each coin's full history, and the
// status line says when derivation was used. Throws with a specific message on bad input.
// Locale-tolerant numeric parser. Handles "1,234.50" (US thousands), "1.234,56" (EU),
// "1234,56" (bare decimal comma), accounting negatives "(12.5)", $ prefixes and plain
// floats/exponents. Returns NaN for anything ambiguous — a skipped row beats a silently
// corrupted one (parseFloat alone read "1,234.50" as 1 and imported it as a valid price).
function csvNum(v){
  let s=String(v==null?'':v).trim().replace(/[$\s]/g,'');
  if(!s)return NaN;
  const neg=/^\(.*\)$/.test(s); if(neg)s=s.slice(1,-1).replace(/^[+-]/,''); // an inner sign inside parens is redundant — "(-5)" means −5, and keeping it double-negated the value
  const hasC=s.includes(','), hasD=s.includes('.');
  if(hasC&&hasD){
    if(s.lastIndexOf(',')>s.lastIndexOf('.')) s=s.replace(/\./g,'').replace(',','.'); // EU: 1.234,56
    else s=s.replace(/,/g,'');                                                        // US: 1,234.50
  } else if(hasC){
    const parts=s.split(',');
    if(parts.length===2&&parts[1].length!==3) s=parts[0]+'.'+parts[1];        // 1234,56 → decimal comma
    else if(parts.slice(1).every(p=>p.length===3)) s=parts.join('');          // 1,234 / 1,234,567 → thousands
    else return NaN;                                                          // 1,23,456 — refuse to guess
  }
  if(!/^[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(s))return NaN;
  const n=parseFloat(s); return neg?-n:n;
}
function parseFillsCsv(text){
  const rows=csvParseRows(text.trim());
  if(rows.length<2)throw new Error('need a header row plus at least one data row');
  const norm=s=>String(s).toLowerCase().replace(/[^a-z0-9]/g,'');
  const header=rows[0].map(norm);
  // Two alias tiers per column: exact/primary names always win over loose ones across the
  // whole header, so a Binance-style "…,Type,Side,…" maps side←Side, never side←Type.
  // ('type' is gone entirely — order-type columns shadowed real Side columns.)
  const ALIAS={
    time:[['time','date','datetime','timestamp','ts'],['filledat','executedat','tradetime','createdat']],
    coin:[['coin','symbol','pair'],['market','asset','ticker','instrument','contract']],
    side:[['side','direction','buysell'],['action','dir']], // Hyperliquid's own export has dir: "Open Long", "Close Short"…
    px:[['px','price','fillprice'],['avgprice','execprice','dealprice','filledprice']],
    sz:[['sz','size','qty','quantity'],['amount','filled','baseqty','executedqty','filledqty','vol','volume']],
    fee:[['fee','fees','commission'],['feepaid','tradingfee']],
    closedPnl:[['closedpnl','realizedpnl'],['pnl','realized','profit']],
    startPosition:[['startposition'],[]],
  };
  const col={};
  for(const k in ALIAS){
    let i=header.findIndex(h=>ALIAS[k][0].includes(h));
    if(i<0)i=header.findIndex(h=>ALIAS[k][1].includes(h));
    if(i>=0)col[k]=i;
  }
  const missing=['time','coin','side','px','sz'].filter(k=>col[k]==null);
  if(missing.length)throw new Error('could not find column(s) for: '+missing.join(', ')
    +' — headers seen: '+rows[0].join(', '));
  const parseT=v=>{
    if(/^\d+(\.\d+)?$/.test(v)){
      const n=parseFloat(v);
      // digit-string heuristics: 8 digits like 20260920 is a date, not epoch seconds;
      // plausible epoch ranges (~2001-2052) in s / ms / µs; anything else is rejected
      // rather than silently imported as 1970 or year 55978
      if(/^\d{8}$/.test(v)){ const t=Date.parse(v.slice(0,4)+'-'+v.slice(4,6)+'-'+v.slice(6,8)); return isNaN(t)?null:t; }
      if(n>=1e9&&n<2.6e9)return Math.round(n*1000);
      if(n>=1e12&&n<2.6e12)return Math.round(n);
      if(n>=1e15&&n<2.6e15)return Math.round(n/1000);
      return null;
    }
    // a date and time with no zone is UTC, as exchanges export it: read in the viewer's own zone
    // the same file would land at a different time (and trade ids) on every device
    const m=/^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?)$/.exec(v.trim());
    const t=Date.parse(m?m[1]+'T'+(m[2].length<5||m[2].indexOf(':')===1?'0'+m[2]:m[2])+'Z':v); return isNaN(t)?null:t;
  };
  // "open"/"close" alone don't say buy or sell (closing a short is a buy), so they aren't read as sides;
  // "Open Long"/"Close Short" (and "Long > Short" flips) say both
  const sideOf=v=>{ const s=norm(v); if(['b','buy','long','bid','openlong','closeshort','shortlong'].includes(s))return 'B';
    if(['a','s','sell','short','ask','openshort','closelong','longshort'].includes(s))return 'A'; return null; };
  const fills=[]; let skipped=0;
  for(let r=1;r<rows.length;r++){ const row=rows[r];
    const time=parseT(String(row[col.time]||'').trim());
    const coin=String(row[col.coin]||'').trim();
    const side=sideOf(row[col.side]);
    const px=csvNum(row[col.px]), sz=Math.abs(csvNum(row[col.sz]));
    if(time==null||!coin||!side||!(px>0)||!(sz>0)){ skipped++; continue; }
    // no `crossed` field: execution style is unknown for imported fills, and tallyFill
    // counts unknowns in neither maker nor taker instead of fabricating a signal
    const f={coin, side, time, px:String(px), sz:String(sz),
      fee:col.fee!=null&&isFinite(csvNum(row[col.fee]))?String(csvNum(row[col.fee])):'0',
      tid:'csv'+r, oid:r, dir:''};
    if(col.closedPnl!=null&&row[col.closedPnl]!==''&&isFinite(csvNum(row[col.closedPnl])))f.closedPnl=String(csvNum(row[col.closedPnl]));
    if(col.startPosition!=null&&row[col.startPosition]!==''&&isFinite(csvNum(row[col.startPosition])))f.startPosition=String(csvNum(row[col.startPosition]));
    fills.push(f);
  }
  if(!fills.length)throw new Error('mapped the columns but no row parsed cleanly ('+skipped+' skipped)');
  // Stable time sort; same-millisecond ties keep the FILE's chronological direction —
  // most venue exports are newest-first, and walking a same-ms close-then-reopen
  // backwards corrupts the average-cost derivation.
  const desc=fills.length>1&&fills[0].time>fills[fills.length-1].time;
  fills.sort((a,b)=>a.time-b.time||(desc?b.oid-a.oid:a.oid-b.oid));
  // derive startPosition and closedPnl per coin where absent: running position, and
  // average-cost realization on the closing portion of each reducing fill
  const {derived}=deriveFillPositions(fills);
  const note=fills.length+' rows mapped ('+['time','coin','side','px','sz'].map(k=>k+'←'+rows[0][col[k]]).join(', ')
    +(col.fee!=null?', fee←'+rows[0][col.fee]:', no fee column')
    +(skipped?', '+skipped+' rows skipped':'')+')';
  return {fills, note, derived, skipped};
}
// Coin names become part of trade ids, which land in HTML attributes and selectors — pasted
// or imported data is untrusted, so anything outside exchange-style symbols is refused.
function safeCoin(c){ return typeof c==='string'&&/^[A-Za-z0-9@:\/._+-]{1,48}$/.test(c); }
let _pastedFills=null; // the last pasted (or sample) fills: tax exports need the raw legs, which have no wallet cache
async function loadFromPaste(fills,opts){
  opts=opts||{};
  const nIn=fills.length; fills=fills.filter(f=>f&&safeCoin(f.coin)); _pastedFills=fills;
  const dropped=nIn-fills.length;
  if(!fills.length){ setErr(dropped?`No usable fills: ${dropped} had coin names with characters a market symbol can't contain.`:'No fills found in that data.'); return; }
  // resolve @N spot indices to real token names — the paste path used to skip this,
  // leaving pasted spot trades labeled "@210" forever (sample data has no @N coins: skip the fetch)
  if(!opts.offline&&!Object.keys(spotMaps.nameByCoin).length){
    try{ setStatus('Fetching spot metadata…',true); spotMaps=await fetchSpotMaps(); }catch(e){}
  }
  const {perp:perpTr,spot:spotTr}=await reconstructCompute(fills,[],'paste');
  spotTr.forEach(t=>{ t.symbol=spotMaps.nameByCoin[t.coin]||t.coin; t.quote=(spotMaps.quoteByCoin||{})[t.coin]||null; });
  [...perpTr,...spotTr].forEach(t=>t.wallet={address:'paste',label:'pasted'});
  allTrades=[...perpTr,...spotTr].sort((a,b)=>b.openTime-a.openTime);
  openPositions=[]; accountValue=null; spotHoldings=[]; spotAccountValue=null; unifiedAccountValue=null; hlPnl={all:null,perp:null};
  resetDerivedState(); // pasted world: old wallets' capital flows / clusters / caches must not leak into it
  fillsTruncated=[];
  $('empty').classList.add('hide'); $('app').classList.remove('hide'); render();
  setStatus(`Loaded ${fills.length} pasted fills → ${perpTr.length} perp + ${spotTr.length} spot trades.`+(dropped?` Skipped ${dropped} with invalid coin names.`:''));
}

/* ============================ events ============================ */
$('addWallet').onclick=addWalletFromInput;
$('loadAll').onclick=e=>loadAll({fresh:!!(e&&(e.shiftKey||e.altKey))});
$('walletAddr').addEventListener('keydown',e=>{ if(e.key==='Enter')loadAll(); });
$('walletLabel').addEventListener('keydown',e=>{ if(e.key==='Enter')$('walletAddr').focus(); });
$('wallets').addEventListener('click',e=>{ const b=e.target.closest('[data-rm]'); if(b)removeWallet(+b.dataset.rm);
  const k=e.target.closest('[data-cexkey]'); if(k){ const w=settings.wallets[+k.dataset.cexkey]; if(w)openCexConnect(venueOf(w),w.label); } });
$('cexBtn').onclick=()=>openCexConnect();
// Bybit / Binance: a read-only API key, checked, kept on this device (venues.js: cexConnect)
function openCexConnect(venue, label){
  const bg=document.createElement('div'); bg.className='modal-bg show'; bg.setAttribute('role','dialog'); bg.setAttribute('aria-modal','true'); bg.setAttribute('aria-label','Connect an exchange');
  venue=isCexVenue(venue)?venue:'bybit';
  bg.innerHTML=`<div class="modal cexbox"><h2>Connect an exchange</h2>
    <div class="seg" role="group" aria-label="Exchange">${['bybit','binance'].map(v=>`<button type="button" data-cexv="${v}" aria-pressed="${v===venue}">${VENUE_NAMES[v]}</button>`).join('')}</div>
    <p id="cexSteps"></p>
    <div class="field"><label for="cexKey">API key</label><input type="text" id="cexKey" autocomplete="off" spellcheck="false"></div>
    <div class="field"><label for="cexSecret">API secret</label><input type="password" id="cexSecret" autocomplete="off" spellcheck="false"></div>
    <div class="field"><label for="cexLabel">Label (optional)</label><input type="text" id="cexLabel" maxlength="40" value="${esc(label||'')}" autocomplete="off"></div>
    <p class="mini-note">Read-only keys only — a key that can trade or withdraw is refused. The secret stays in this browser: each request is signed here and your server only passes it on. Lighter needs no key: add its 0x address like a Hyperliquid wallet.</p>
    <p class="lead neg-t" id="cexErr" role="alert"></p>
    <div class="modal-actions"><button class="btn ghost" data-cex="close">Cancel</button><button class="btn" data-cex="go">Connect</button></div></div>`;
  document.body.appendChild(bg);
  const show=()=>{ $('cexSteps').innerHTML=CEX_HELP[venue].steps+` <a href="${CEX_HELP[venue].url}" target="_blank" rel="noopener">Open ${VENUE_NAMES[venue]} API settings</a>`;
    bg.querySelectorAll('[data-cexv]').forEach(b=>b.setAttribute('aria-pressed',String(b.dataset.cexv===venue))); };
  show(); setTimeout(()=>{ const f=$('cexKey'); if(f)f.focus(); },0);
  const close=()=>{ bg.remove(); document.removeEventListener('keydown',onKey); };
  const onKey=e=>{ if(e.key==='Escape')close(); }; document.addEventListener('keydown',onKey);
  bg.addEventListener('click',async e=>{
    if(e.target===bg)return close();
    const v=e.target.closest('[data-cexv]'); if(v){ venue=v.dataset.cexv; show(); return; }
    const a=e.target.closest('[data-cex]'); if(!a)return;
    if(a.dataset.cex==='close')return close();
    a.disabled=true; $('cexErr').textContent=''; const old=a.textContent; a.textContent='Checking the key…';
    try{ const r=await cexConnect(venue,$('cexKey').value,$('cexSecret').value,$('cexLabel').value);
      close(); renderWallets(); setStatus(VENUE_NAMES[venue]+' connected'+(r.note?' · key '+r.note:'')+' · loading…',true); loadAll(); }
    catch(err){ $('cexErr').textContent=err.message; a.disabled=false; a.textContent=old; } });
}
// debounced: these fire per keystroke, and each render() destroys and rebuilds all nine
// dashboard charts — typing "1500" used to trigger four full re-renders
let _setRenderTimer=null;
const debouncedRender=()=>{ clearTimeout(_setRenderTimer); _setRenderTimer=setTimeout(()=>{ if(allTrades.length)render(); },350); };
$('riskDefault').addEventListener('input',async e=>{ const v=parseFloat(e.target.value); settings.riskDefault=v>0?v:null; await Store.set(S_KEY,settings); debouncedRender(); });
$('beThresh').addEventListener('input',async e=>{ const v=parseFloat(e.target.value); settings.beThreshold=(isFinite(v)&&v>=0)?v:0; await Store.set(S_KEY,settings);
  _minerCache={key:null,res:null,deep:null}; debouncedRender(); }); // wins, losses and streaks move with the band: mined patterns are stale
$('rBasis').addEventListener('change',async e=>{ settings.rBasis=e.target.value;
  const fixed=settings.rBasis==='fixed'; $('riskDefault').classList.toggle('hide',!fixed);
  $('rBasisNote').textContent=fixed?'$ risk per trade · override per trade':'R-multiples scale to your average loss · override per trade';
  await Store.set(S_KEY,settings); if(allTrades.length)render(); });
function activateTab(b){ if(!b)return;
  activeTab=b.dataset.tab; document.querySelectorAll('#topnav button').forEach(x=>{ const on=x===b; x.classList.toggle('on',on); x.setAttribute('aria-selected',on?'true':'false'); });
  $('dashView').classList.toggle('hide',activeTab!=='dash'); $('diagView').classList.toggle('hide',activeTab!=='diag'); $('reviewView').classList.toggle('hide',activeTab!=='review'); $('projView').classList.toggle('hide',activeTab!=='proj');
  renderReconcile();
  if(activeTab==='diag') renderDiagnostic(periodTrades(),periodTradesAll());
  if(activeTab==='review') renderReview();
  if(activeTab==='proj') renderProjection();
  buildSecnav(); }
// Long views (Review, Diagnostic) get a sticky bar of their sections: jump to one, and the bar
// follows along as you scroll. Built from each section's heading whenever the view re-renders.
const SECNAV_VIEWS={review:'reviewView',diag:'diagView'};
let _secnavKey='', _secnavSecs=[];
function secnavLabel(h){ let t=''; for(const n of h.childNodes){ if(n.nodeType===3)t+=n.textContent; else if(n.nodeType===1&&!/^(SPAN|SMALL|BUTTON)$/.test(n.tagName))t+=n.textContent; }
  t=t.replace(/\s+/g,' ').trim().replace(/\s*[·—:]\s*$/,''); const cut=t.split(/ [·—] /)[0]; return (cut||t).slice(0,32); }
function buildSecnav(){ const nav=$('secnav'); if(!nav)return; const vid=SECNAV_VIEWS[activeTab], view=vid&&$(vid);
  const heads=view?[...view.querySelectorAll('.diag-section > h2')]:[];
  if(heads.length<4){ nav.classList.add('hide'); nav.innerHTML=''; _secnavKey=''; _secnavSecs=[]; return; }
  _secnavSecs=heads.map((h,i)=>{ const sec=h.parentElement; if(!sec.id)sec.id='sec-'+activeTab+'-'+i; return {id:sec.id,label:secnavLabel(h)||('Section '+(i+1))}; }).filter(x=>x.label);
  const key=activeTab+'|'+_secnavSecs.map(x=>x.id+':'+x.label).join('|'); nav.classList.remove('hide');
  if(key!==_secnavKey){ _secnavKey=key; nav.innerHTML=_secnavSecs.map(x=>`<button type="button" data-sec="${esc(x.id)}">${esc(x.label)}</button>`).join(''); }
  secnavSpy(); }
function secnavSpy(){ const nav=$('secnav'); if(!nav||nav.classList.contains('hide')||!_secnavSecs.length)return;
  const top=nav.getBoundingClientRect().bottom+12; let cur=_secnavSecs[0].id;
  for(const x of _secnavSecs){ const el=document.getElementById(x.id); if(el&&el.getBoundingClientRect().top<=top+4)cur=x.id; }
  for(const b of nav.children){ const on=b.dataset.sec===cur; if(on!==b.classList.contains('on')){ b.classList.toggle('on',on); if(on&&b.scrollIntoView&&nav.scrollWidth>nav.clientWidth)nav.scrollLeft=Math.max(0,b.offsetLeft-nav.clientWidth/3); } } }
$('secnav').addEventListener('click',e=>{ const b=e.target.closest('[data-sec]'); if(!b)return; const el=document.getElementById(b.dataset.sec); if(!el)return;
  const nav=$('secnav'), off=nav.offsetHeight+(parseFloat(getComputedStyle(nav).top)||0)+12;
  window.scrollTo({top:el.getBoundingClientRect().top+window.scrollY-off,behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'}); });
{ let raf=0; window.addEventListener('scroll',()=>{ if(!raf)raf=requestAnimationFrame(()=>{ raf=0; secnavSpy(); }); },{passive:true});
  let t=0; const mo=new MutationObserver(()=>{ clearTimeout(t); t=setTimeout(buildSecnav,60); });
  for(const id of Object.values(SECNAV_VIEWS)){ const el=$(id); if(el)mo.observe(el,{childList:true}); } }
$('topnav').addEventListener('click',e=>{ const b=e.target.closest('button'); if(b)activateTab(b); });
$('topnav').addEventListener('keydown',e=>{ if(e.key!=='ArrowRight'&&e.key!=='ArrowLeft')return;
  const btns=[...document.querySelectorAll('#topnav button')]; const i=btns.indexOf(document.activeElement); if(i<0)return;
  const n=btns[(i+(e.key==='ArrowRight'?1:btns.length-1))%btns.length]; n.focus(); activateTab(n); e.preventDefault(); });
// calendar → day journal: clicking a heatmap day opens that date's entry in the Review tab
$('cal').addEventListener('click',e=>{ const c=e.target.closest('[data-day]'); if(!c)return;
  _dayJEditKey='day:'+c.dataset.day; _dayJEditSetOn=tzMidnight(Date.now());
  activateTab(document.querySelector('#topnav button[data-tab="review"]'));
  setTimeout(()=>{ const f=$('djBias'); if(f){ f.scrollIntoView({behavior:'smooth',block:'center'}); f.focus(); } },60);
});
$('calWeeksBtn').addEventListener('click',async()=>{ settings.calWeeks=settings.calWeeks===52?26:52;
  await Store.set(S_KEY,settings); if(allTrades.length)render(); });
$('calModeBtn').addEventListener('click',async()=>{ settings.calMode=settings.calMode==='process'?'pnl':'process';
  await Store.set(S_KEY,settings); if(allTrades.length)render(); });
$('walletsBtn').addEventListener('click',()=>$('setupPanel').classList.toggle('hide'));
$('hdrsum').addEventListener('click',()=>$('setupPanel').classList.toggle('hide'));
$('periods').addEventListener('click',e=>{ const b=e.target.closest('button'); if(!b)return;
  period=+b.dataset.d; document.querySelectorAll('#periods button').forEach(x=>x.classList.remove('on')); b.classList.add('on');
  customRange={from:null,to:null}; $('pFrom').value=''; $('pTo').value=''; $('pFrom').classList.remove('act'); $('pTo').classList.remove('act'); $('rangeFields').classList.add('hide'); $('rangeBtn').classList.remove('on');
  render(); });
function applyRange(){
  const fv=$('pFrom').value, tv=$('pTo').value;
  customRange.from = dateBound(fv,false);
  customRange.to   = dateBound(tv,true);
  $('pFrom').classList.toggle('act',!!fv); $('pTo').classList.toggle('act',!!tv);
  const on=rangeActive(); $('rangeBtn').classList.toggle('on',on);
  if(on) document.querySelectorAll('#periods button').forEach(x=>x.classList.remove('on'));
  else { const allb=document.querySelector('#periods button[data-d="0"]'); if(allb){document.querySelectorAll('#periods button').forEach(x=>x.classList.remove('on')); allb.classList.add('on'); period=0;} }
  if(allTrades.length) render();
}
$('pFrom').addEventListener('change',applyRange);
$('pTo').addEventListener('change',applyRange);
$('pClear').addEventListener('click',()=>{ $('pFrom').value=''; $('pTo').value=''; applyRange(); $('rangeFields').classList.add('hide'); $('rangeBtn').classList.remove('on'); });
$('rangeBtn').addEventListener('click',()=>{ const f=$('rangeFields'); f.classList.toggle('hide'); $('rangeBtn').classList.toggle('on',!f.classList.contains('hide')); });

$('appearBtn').addEventListener('click',()=>{ const cur=APPEARANCES.includes(settings.appearance)?settings.appearance:'dark'; setAppearance(APPEARANCES[(APPEARANCES.indexOf(cur)+1)%3]); });
$('themeBtn').addEventListener('click',()=>{ const i=COLORWAYS.indexOf(settings.theme); setColorway(COLORWAYS[(i+1)%COLORWAYS.length]); });
// Coach mode (default on) gates the coaching layer only; the data under it is never touched.
function coachOn(){ return PZ||settings.coachMode!==false; } // Pulse always shows the coach + game layers
function syncCoachMode(){
  const on=coachOn(); document.body.classList.toggle('coach-off',!on);
  const b=$('coachSwitch'); if(b)b.setAttribute('aria-checked',on?'true':'false');
  const st=$('coachSwitchState'); if(st)st.textContent=on?'On':'Off';
}
async function setCoachMode(on){
  settings.coachMode=!!on; syncCoachMode(); await Store.set(S_KEY,settings);
  _minerCache={key:null,res:null,deep:null}; // the check-in conditions come and go with coach mode
  if(allTrades.length)render(); else if(activeTab==='review')renderReview();
}
function syncTzBtn(){ const b=$('tzBtn'); if(b)b.textContent=(settings.tz==='utc'?'🕓 UTC':'🕓 Local'); }
$('coachSwitch').addEventListener('click',()=>setCoachMode(!coachOn()));
$('tzBtn').addEventListener('click',async ()=>{ settings.tz=settings.tz==='utc'?'local':'utc'; syncTzBtn();
  _minerCache={key:null,res:null,deep:null}; // session/dow buckets changed → invalidate mined patterns
  await Store.set(S_KEY,settings);
  // a custom date range is resolved on the active clock — re-resolve it, or its edges stay on the old one
  if($('pFrom').value||$('pTo').value)applyRange(); else if(allTrades.length)render(); });
$('gearBtn').addEventListener('click',e=>{ e.stopPropagation(); $('settingsPop').classList.toggle('hide'); });
$('settingsPop').addEventListener('click',e=>e.stopPropagation());
document.addEventListener('click',e=>{ const p=$('settingsPop'); if(p&&!p.classList.contains('hide'))p.classList.add('hide');
  // the tools menu closes on a pick or on any click outside it
  const m=$('toolsMenu'); if(m&&m.open&&(!m.contains(e.target)||e.target.closest('.tmenu-pop button')))m.open=false; });
document.addEventListener('keydown',e=>{ if(e.key!=='Escape')return; const m=$('toolsMenu'); if(m&&m.open){ m.open=false; m.querySelector('summary').focus(); } });
$('viewtog').addEventListener('click',async e=>{ const b=e.target.closest('button'); if(!b)return;
  view=b.dataset.v; document.querySelectorAll('#viewtog button').forEach(x=>x.classList.toggle('on',x===b));
  settings.view=view; await Store.set(S_KEY,settings);
  $('fCoin').value=''; $('fSide').value='';
  if(allTrades.length||openPositions.length||spotHoldings.length)render(); });
function syncDexTog(){
  const dexes=knownDexes(), tog=$('dextog'), chips=$('dexchips');
  if(!tog)return;
  tog.classList.toggle('hide',!dexes.length);            // invisible until a HIP-3 fill exists
  if(!dexes.length){ chips.classList.add('hide'); if(dexView!=='all'){dexView='all';} return; }
  tog.querySelectorAll('button').forEach(b=>b.classList.toggle('on',b.dataset.x===dexView));
  const showChips=dexView==='hip3'&&dexes.length>1;
  chips.classList.toggle('hide',!showChips);
  if(showChips){
    dexSel.forEach(d=>{ if(!dexes.includes(d))dexSel.delete(d); });
    chips.innerHTML=dexes.map(d=>`<button data-c="${esc(d)}" class="${(!dexSel.size||dexSel.has(d))?'on':''}">${esc(d)}</button>`).join('');
  } else chips.innerHTML='';
}
$('dextog').addEventListener('click',async e=>{ const b=e.target.closest('button'); if(!b)return;
  dexView=b.dataset.x; settings.dexView=dexView; await Store.set(S_KEY,settings);
  _minerCache={key:null,res:null,deep:null};             // trade universe changed → mined patterns stale
  if(allTrades.length||openPositions.length||spotHoldings.length)render(); });
$('dexchips').addEventListener('click',e=>{ const b=e.target.closest('button'); if(!b)return;
  const d=b.dataset.c, dexes=knownDexes();
  if(!dexSel.size)dexes.forEach(x=>dexSel.add(x));       // "all on" is the implicit default; first click narrows
  dexSel.has(d)?dexSel.delete(d):dexSel.add(d);
  if(dexSel.size===dexes.length||!dexSel.size)dexSel.clear();
  _minerCache={key:null,res:null,deep:null};
  if(allTrades.length||openPositions.length||spotHoldings.length)render(); });
['fWallet','fCoin','fSide','fOut','fTag'].forEach(id=>$(id).addEventListener('change',renderTable));
['fFrom','fTo','fRating','fFlag'].forEach(id=>$(id).addEventListener('change',renderTable));
$('fSearch').addEventListener('input',renderTable);
$('edgeDim').addEventListener('change',()=>renderEdge(periodTrades()));
$('clearFilters').onclick=()=>{ ['fCoin','fSide','fOut','fTag','fWallet','fFlag'].forEach(id=>$(id).value='');
  $('fRating').value='0'; $('fFrom').value=''; $('fTo').value=''; $('fSearch').value=''; renderTable(); };
/* tooltips — hover (mouse), tap (touch), and focus (keyboard) */
(function(){ let tip=$('tip'); if(!tip){ tip=document.createElement('div'); tip.id='tip'; tip.className='tip'; document.body.appendChild(tip); }
  let cur=null, hideT=null;
  const hide=()=>{ cur=null; tip.style.opacity='0'; clearTimeout(hideT); };
  const place=(el,x,y)=>{ tip.textContent=el.getAttribute('data-tip'); tip.style.opacity='1';
    const r=tip.getBoundingClientRect(); let l=x+14,t=y+16;
    if(l+r.width>innerWidth-8)l=innerWidth-r.width-8; if(l<8)l=8;
    if(t+r.height>innerHeight-8)t=y-r.height-12; tip.style.left=l+'px'; tip.style.top=t+'px'; };
  // anchor to an element's box (used for tap + keyboard focus, where there's no cursor to follow)
  const placeAnchored=el=>{ tip.textContent=el.getAttribute('data-tip'); tip.style.opacity='1';
    const b=el.getBoundingClientRect(), r=tip.getBoundingClientRect();
    let l=b.left+b.width/2-r.width/2, t=b.top-r.height-10;
    if(l+r.width>innerWidth-8)l=innerWidth-r.width-8; if(l<8)l=8;
    if(t<8)t=b.bottom+10; tip.style.left=l+'px'; tip.style.top=t+'px'; };
  const coarse=matchMedia('(hover: none)').matches;
  if(!coarse){
    document.addEventListener('mouseover',e=>{ const el=e.target.closest&&e.target.closest('[data-tip]'); if(el){cur=el;place(el,e.clientX,e.clientY);} });
    document.addEventListener('mousemove',e=>{ if(cur)place(cur,e.clientX,e.clientY); });
    document.addEventListener('mouseout',e=>{ const to=e.relatedTarget; if(cur&&(!to||!to.closest||!to.closest('[data-tip]'))){hide();} });
  } else {
    // touch: tap a tipped, non-actionable element to reveal it; tap elsewhere (or wait) to dismiss.
    // actionable controls (buttons, rows, stars…) keep their tap for the action, not the tip.
    const actionable='button,a,input,select,textarea,label,[role="button"],.star,.chk,.trow,.sortable';
    document.addEventListener('click',e=>{ const el=e.target.closest&&e.target.closest('[data-tip]');
      if(el&&el!==cur&&!e.target.closest(actionable)){ cur=el; placeAnchored(el); clearTimeout(hideT); hideT=setTimeout(hide,6000); }
      else hide(); },true);
  }
  // keyboard: reveal the tip when a tipped, focusable element receives focus
  document.addEventListener('focusin',e=>{ const el=e.target.closest&&e.target.closest('[data-tip]'); if(el){cur=el;placeAnchored(el);} });
  document.addEventListener('focusout',()=>{ if(cur)hide(); });
  document.addEventListener('scroll',()=>{ if(cur)hide(); },true);
  window.addEventListener('resize',()=>{ if(cur)hide(); });
})();
document.querySelectorAll('.trades th.sortable').forEach(th=>{
  th.setAttribute('role','button'); th.setAttribute('tabindex','0'); th.setAttribute('aria-sort','none');
  const sort=()=>{ const k=th.dataset.s; if(sortKey===k)sortDir*=-1; else{sortKey=k;sortDir=-1;} renderTable(); };
  th.addEventListener('click',sort);
  th.addEventListener('keydown',e=>{ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); sort(); } });
});
$('tbody').addEventListener('click',e=>{
  const save=e.target.closest('[data-save]'); if(save){ saveJournal(save.dataset.save); return; }
  // trade ids contain ':' themselves (addr:COIN:time) — the index is after the LAST colon
  const ann=e.target.closest('[data-att-ann]'); if(ann){ const v=ann.dataset.attAnn, k=v.lastIndexOf(':'); openAnnotator(v.slice(0,k),+v.slice(k+1)); return; }
  const del=e.target.closest('[data-att-del]'); if(del){ const v=del.dataset.attDel, k=v.lastIndexOf(':'); removeAttachment(v.slice(0,k),+v.slice(k+1)); return; }
  const rp=e.target.closest('[data-replay]'); if(rp){ openReplay(rp.dataset.replay,rp); return; }
  const av=e.target.closest('[data-att-view]'); if(av){ const src=av.getAttribute('src');
    if(_attSrcOk(src)){ const w=window.open(); if(w){ const img=w.document.createElement('img');
      img.src=src; img.style.maxWidth='100%'; w.document.body.appendChild(img); } } return; }
  const star=e.target.closest('.star'); if(star){ setStar(star); return; }
  const pbr=e.target.closest('.pbrule'); if(pbr){ setTimeout(()=>{ const box=pbr.closest('.pbrules'); pbr.classList.toggle('on',pbr.querySelector('input').checked); pbSaveTicks(box); },0); return; }
  const chk=e.target.closest('.chk'); if(chk){ const id=chk.parentElement.dataset.id,m=chk.querySelector('input').dataset.m;
    const j=ensureJ(id),box=chk.querySelector('input'); setTimeout(()=>{ if(box.checked){if(!j.mistakes.includes(m))j.mistakes.push(m);}else{j.mistakes=j.mistakes.filter(x=>x!==m);} chk.classList.toggle('on',box.checked);
      markJEdit(id); Store.set(J_KEY,journal); },0); return; } // persist immediately — a toggle is an edit, not a draft
  if(e.target.closest('textarea,input,.rating,.mistakes,.pbrules,.jsave,.attgrid,.attbtn'))return;
  const row=e.target.closest('.trow'); if(row){ const id=row.dataset.id; expandedId=expandedId===id?null:id; renderTable(); }
});
function setStar(star){ const id=star.parentElement.dataset.id, r=+star.dataset.r; ensureJ(id).rating=r;
  markJEdit(id); Store.set(J_KEY,journal); // persist immediately — a rating is an edit, not a draft
  star.parentElement.querySelectorAll('.star').forEach((s,i)=>{ s.classList.toggle('on',i<r); s.setAttribute('aria-checked',(i+1)===r?'true':'false'); }); }
// keyboard: expand rows with Enter/Space; set star ratings with Enter/Space/Arrows
$('tbody').addEventListener('keydown',e=>{
  const star=e.target.closest('.star');
  if(star){ const stars=[...star.parentElement.querySelectorAll('.star')]; const i=stars.indexOf(star);
    if(e.key==='Enter'||e.key===' '){ e.preventDefault(); setStar(star); }
    else if(e.key==='ArrowRight'||e.key==='ArrowUp'){ e.preventDefault(); (stars[i+1]||stars[i]).focus(); }
    else if(e.key==='ArrowLeft'||e.key==='ArrowDown'){ e.preventDefault(); (stars[i-1]||stars[i]).focus(); }
    return; }
  if(e.target.closest('textarea,input,.mistakes,.jsave,.attgrid,.attbtn'))return;
  const row=e.target.closest('tr.trow');
  if(row&&(e.key==='Enter'||e.key===' ')){ e.preventDefault(); const id=row.dataset.id; expandedId=expandedId===id?null:id; renderTable();
    if(expandedId===id) setTimeout(()=>{ const r=$('tbody').querySelector(`tr.trow[data-id="${CSS.escape(id)}"]`); if(r)r.focus(); },0); }
});
$('tbody').addEventListener('change',e=>{ const fi=e.target.closest('input[data-att]');
  if(fi&&fi.files&&fi.files.length){ addAttachments(fi.dataset.att,[...fi.files]); fi.value=''; } });
// The paste modal does four jobs behind one box (fills JSON, CSV, journal restore, full
// backup). Naming the detected type BEFORE Load removes the "wrong branch" surprise class.
function detectPasteType(raw){
  const t=String(raw||'').trim(); if(!t)return '';
  try{ const d=JSON.parse(t);
    if(Array.isArray(d))return d.length&&d[0]&&d[0].coin!==undefined?'fills JSON · '+d.length+' fills':'JSON array';
    if(d&&typeof d==='object'){
      if(d.fills)return 'fills JSON · '+((d.fills&&d.fills.length)||0)+' fills';
      if(d.journal||d.wallets||d.settings)return 'full backup'+(d.fillCaches?' · incl. fill caches':'');
      return 'journal export · '+Object.keys(d).length+' entries';
    }
    return 'JSON';
  }catch(e){}
  const first=t.split('\n')[0]||'';
  if(t.includes('\n')&&first.includes(','))return 'CSV · '+(t.split('\n').length-1)+' rows';
  return 'unrecognized — expected fills JSON, a backup/journal export, or CSV';
}
function updatePasteType(){ const el=$('pasteType'); if(!el)return;
  const ty=detectPasteType($('pasteBox').value);
  el.textContent=ty?('detected: '+ty):''; }
let _pasteTypeTimer=null;
$('pasteBox').addEventListener('input',()=>{ clearTimeout(_pasteTypeTimer); _pasteTypeTimer=setTimeout(updatePasteType,250); });
$('pasteFile').addEventListener('change',e=>{
  const f=e.target.files&&e.target.files[0]; if(!f)return;
  const rd=new FileReader();
  rd.onload=()=>{ $('pasteBox').value=String(rd.result||''); updatePasteType(); };
  rd.onerror=()=>setErr('Could not read '+f.name+'.');
  rd.readAsText(f); e.target.value='';
});
$('importBtn').onclick=()=>{ $('modal').classList.add('show'); updatePasteType(); };
$('modalCancel').onclick=()=>$('modal').classList.remove('show');
$('modal').addEventListener('click',e=>{ if(e.target===$('modal'))$('modal').classList.remove('show'); });
$('modalLoad').onclick=async()=>{
  const raw=$('pasteBox').value.trim(); if(!raw)return; let data;
  try{ data=JSON.parse(raw); }catch(e){
    // not JSON \u2014 try the generic CSV importer (header-mapped fills from any venue)
    let csv=null, csvErr=null;
    try{ csv=parseFillsCsv(raw); }catch(e2){ csvErr=e2.message; }
    if(csv&&csv.fills.length){
      $('modal').classList.remove('show'); $('pasteBox').value='';
      await loadFromPaste(csv.fills); // its status line is then extended with the mapping report
      setStatus('CSV import: '+csv.note+(csv.derived?' \u00b7 position/PnL derived by average cost \u2014 exact only when the file holds each coin\u2019s full history':''));
      return;
    }
    setErr('Not valid JSON'+(csvErr?'; CSV import failed: '+csvErr:' or CSV.')); return;
  }
  $('modal').classList.remove('show'); $('pasteBox').value='';
  // !data.fills: a {fills:[...]} paste is fill data for reconstruction, not a journal —
  // without this guard it would fall through to the journal branch and overwrite it.
  if(data&&!Array.isArray(data)&&typeof data==='object'&&!data.coin&&!data.fills){
    if(data.journal||data.wallets||data.settings){ // full backup
      // applySnapshot is the one restore path that knows the whole backup shape — including
      // the v9 fill caches and saved MAE/MFE rows that pasting used to silently drop.
      const before=journal, incoming=data.journal&&typeof data.journal==='object'?data.journal:null;
      const nIn=incoming?Object.keys(incoming).length:0, nOnlyHere=Object.keys(before).filter(k=>!incoming||!(k in incoming)).length;
      if(!confirm('Restore this backup ('+nIn+' journal entr'+(nIn===1?'y':'ies')+')?\n\nWallets and settings come from the backup. Your journal is merged: entries only in the backup are added, and your own notes are kept'
        +(nOnlyHere?' (including '+nOnlyHere+' the backup doesn’t have)':'')+' unless the backup’s copy is newer.'))return;
      await applySnapshot(data);
      // merge, not replace: a note written here since the backup was made survives the restore
      if(incoming){ let kept=0; for(const [k,v] of Object.entries(before)){ const b=incoming[k]; if(!b||(v&&(v.updatedAt||0)>=(b.updatedAt||0))){ journal[k]=v; kept++; } }
        if(kept){ _jrev++; await rawSet(J_KEY,journal); } }
      resetDerivedState(); // restored wallet set replaces the loaded world — derived state goes with it
      vaultMarkAll(before); // a member's encrypted sync: the restore wins the next merge instead of being undone
      schedulePersist(); // applySnapshot writes via rawSet (no sync triggers) — push the restored state explicitly
      view=settings.view||view; dexView=settings.dexView||dexView; if(settings.riskDefault)$('riskDefault').value=settings.riskDefault;
      document.querySelectorAll('#viewtog button').forEach(x=>x.classList.toggle('on',x.dataset.v===view));
      renderWallets(); if(allTrades.length||openPositions.length||spotHoldings.length)render();
      const nc=data.fillCaches?Object.keys(data.fillCaches).length:0;
      setStatus('Backup restored: '+settings.wallets.length+' wallet(s), '+Object.keys(journal).length+' journal entries'+(nc?', fill cache for '+nc+' wallet'+(nc===1?'':'s'):'')+'. Hit Load all to refresh trades.'); return;
    }
    // a journal export is {"<trade id | day:… | week:…>": {…}} — anything else (an API response,
    // a settings blob) used to replace the whole journal silently
    const ents=Object.entries(data);
    if(!ents.length||!ents.every(([k,v])=>k.includes(':')&&v&&typeof v==='object'&&!Array.isArray(v))){
      setErr('That JSON isn\u2019t a journal export or a backup \u2014 nothing was changed.'); return; }
    const have=Object.keys(journal).length;
    if(have&&!confirm(`Replace your journal (${have} entries) with the pasted one (${ents.length} entries)? Use a full backup to merge devices instead.`)){
      setStatus('Journal paste cancelled \u2014 nothing was changed.'); return; }
    const before=journal; journal=data; _jrev++; vaultMarkAll(before,true); await Store.set(J_KEY,journal); if(allTrades.length)render();
    setStatus('Journal restored ('+Object.keys(journal).length+' entries).'); return;
  }
  const fills=Array.isArray(data)?data:(data.fills||[]);
  await loadFromPaste(fills);
};
$('exportCsv').onclick=()=>{
  const rows=filteredTrades(); if(!rows.length){ setStatus('No trades in the current filter to export.'); return; }
  const q=v=>{ v=v==null?'':String(v);
    // formula-injection guard: notes/tags open in Excel/Sheets, where a leading = @
    // (or +/- that isn't a number) executes as a formula; real negatives pass untouched
    if(/^[=@]/.test(v)||(/^[+-]/.test(v)&&!isFinite(Number(v))))v="'"+v;
    return /[",\n]/.test(v)?'"'+v.replace(/"/g,'""')+'"':v; };
  const head=['open_time','close_time','market_type','symbol','direction','status','avg_entry','avg_exit','max_size','pnl','fees','funding','net','return_pct','r_multiple','duration_min','rating','setup','tags','mistakes','note','wallet'];
  const lines=[head.join(',')];
  for(const t of rows){ const j=journal[t.id]||{}; const R=rFor(t), ret=retPct(t);
    lines.push([new Date(t.openTime).toISOString(),t.closeTime?new Date(t.closeTime).toISOString():'',
      t.market,dcoin(t),t.dir,t.isOpen?'open':'closed',t.avgEntry,t.avgExit==null?'':t.avgExit,t.maxSize,
      t.pnl,t.fees,t.funding||0,t.net,ret==null?'':ret.toFixed(4),R==null?'':R.toFixed(3),
      t.durationMs?(t.durationMs/60000).toFixed(1):'',j.rating||'',j.setup||'',(j.tags||[]).join('; '),(j.mistakes||[]).join('; '),j.notes||'',
      t.wallet?labelFor(t.wallet):''].map(q).join(','));
  }
  const blob=new Blob([lines.join('\n')],{type:'text/csv'});
  dlBlob(blob,'ledger-trades-'+new Date().toISOString().slice(0,10)+'.csv');
  setStatus('Exported '+rows.length+' trades (current filters) to CSV.');
};
