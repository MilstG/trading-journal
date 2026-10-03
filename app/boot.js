// Ledger app · part 15 of 15: boot: runs last, once every part above is loaded.
// ledger.html loads the parts in order as classic scripts sharing one global scope. Code that
// runs while a part loads (not inside a function called later) may only use names declared in
// this part or an earlier one; the boot part runs last. See "Development and testing" in README.md.

/* ============================ boot ============================ */
try{ if(window.Chart&&Chart.defaults)Chart.defaults.animation=false; }catch(e){}
(async function(){
  // Ask the browser to exempt our storage from automatic eviction — the fill cache is the
  // only copy of history beyond the API's page cap, so best-effort eviction is not okay.
  try{ if(navigator.storage&&navigator.storage.persist)navigator.storage.persist().catch(()=>{}); }catch(e){}
  // server sync first: if the companion server answers, its snapshot is applied before
  // any local reads, so journal/settings/excursion hydration below see the synced data
  try{ await initServerSync(); }catch(e){}
  journal=(await Store.get(J_KEY))||{};
  // hydrate saved MAE/MFE measurements so journal rows show excursions without a re-run
  // (R-multiples appear after the next excursion run, which recomputes them from current risk)
  try{ const p=await idbGet('excRows');
    if(p&&p.v===1&&p.rows)for(const id in p.rows){ const q=p.rows[id];
      if(q&&q.maePct!=null)_excM[id]={maePct:q.maePct,mfePct:q.mfePct,nC:q.nC,itvMs:q.itvMs||null,
        coarse:!!q.coarse,maeR:null,mfeR:null};
    } }catch(e){}
  settings=(await Store.get(S_KEY));
  if(!settings){ const old=await Store.get('hl_settings_v2');
    settings={wallets:[],riskDefault:(old&&old.riskDefault)||null};
    if(old&&old.address)settings.wallets.push({address:old.address,label:''});
    await Store.set(S_KEY,settings);
  }
  if(!Array.isArray(settings.wallets))settings.wallets=[];
  // edits this browser made just before it was last closed never reached the server: send them now
  if(SRV.pushLocal){ SRV.pushLocal=false; scheduleServerWrite(); }
  // a member's encrypted journal: take a newer copy from their other devices before anything reads settings
  try{ await vaultBoot(); }catch(e){}
  // the browser's IANA zone rides along with settings so the server's end-of-day nudge reads
  // 'today' on the same calendar as the day journal's 'local' dates
  try{ const z=Intl.DateTimeFormat().resolvedOptions().timeZone; if(z&&settings.tzZone!==z){ settings.tzZone=z; await Store.set(S_KEY,settings); } }catch(e){}
  view=PZ?'combined':(settings.view||'perp'); dexView=settings.dexView||'all';
  document.querySelectorAll('#viewtog button').forEach(x=>x.classList.toggle('on',x.dataset.v===view));
  settings.rBasis=settings.rBasis||'avgloss';
  $('rBasis').value=settings.rBasis;
  if(!settings.colorway&&settings.theme==='bb')settings.colorway='bb'; // BB was only ever chosen by hand; INK was the old default, so it moves to TS9
  applyTheme(settings.colorway);
  syncTzBtn(); syncCoachMode();
  if(settings.pageSize&&[10,20,50].includes(settings.pageSize))pageSize=settings.pageSize;
  if(settings.beThreshold==null)settings.beThreshold=50;
  if(!settings.rules||typeof settings.rules!=='object')settings.rules={};
  if(!(settings.assumedLev>0))settings.assumedLev=5;
  _be=settings.beThreshold; $('beThresh').value=settings.beThreshold;
  const fixed=settings.rBasis==='fixed'; $('riskDefault').classList.toggle('hide',!fixed);
  $('rBasisNote').textContent=fixed?'$ risk per trade · override per trade':'R-multiples scale to your average loss · override per trade';
  if(settings.riskDefault)$('riskDefault').value=settings.riskDefault;
  renderWallets(); renderHeaderSummary();
  if(!settings.wallets.length) $('setupPanel').classList.remove('hide');
  // data-file persistence bar: offer reconnect if a file was previously linked.
  // In server-sync mode the server is the source of truth — a linked local file
  // applying on top would clobber it, so the FSA flow is skipped entirely.
  if(SRV.enabled){ renderDatafile(); if(!PZ&&typeof socBoot==='function')socBoot(); } // the league's levels and XP weights apply in the full journal too
  else try{ const h=FSA?await idbGet('handle'):null;
    if(h){ const p=await h.queryPermission({mode:'readwrite'});
      if(p==='granted'){ linkedHandle=h; linkedName=h.name; const file=await h.getFile(); const data=JSON.parse(await file.text());
        const pend=jPendingLoad(), localJ=pend.length?Object.assign({},journal):null;
        await applySnapshot(data); await jPendingOverlay(localJ,pend); renderWallets();
        settings.rBasis=settings.rBasis||'avgloss'; $('rBasis').value=settings.rBasis;
        const fx=settings.rBasis==='fixed'; $('riskDefault').classList.toggle('hide',!fx); if(settings.riskDefault)$('riskDefault').value=settings.riskDefault;
        document.querySelectorAll('#viewtog button').forEach(x=>x.classList.toggle('on',x.dataset.v===(settings.view||view)));
        renderDatafile('saved'); }
      else { renderDatafile('reconnect'); } }
    else renderDatafile();
  }catch(e){ renderDatafile(); }
  if(settings.wallets.length) setStatus(settings.wallets.length+' wallet'+(settings.wallets.length===1?'':'s')+' remembered — refreshing…');
  setupAutoRefresh();
  // auto-load on boot: rebuild from the cached fills and pull anything new, so reopening the
  // app refreshes without a manual "Load all". Incremental and _loading-guarded; the 3-minute
  // interval keeps it current from here. Errors surface the same way an auto-tick would.
  if(settings.wallets.length){ await bootFromCache(); loadAll({auto:true}); }
  if(PZ)pzRender();
})();
