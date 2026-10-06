/* ============================================================================
   First look — for someone new, the payoff of connecting a wallet on the first screen: their recent
   trading already scored on process, the habit that cost them most (with one tap to start plugging
   it), the XP their history already earned, and the one next step.
   A feature in its own file: it plugs into Daruma through pzFeature (app/pulse.js) and loads on
   Daruma's page only (data-only="keel" in ledger.html).

   "New" is decided once per device, on the first draw with trades (localStorage 'pzFirstLook'): a
   journal with nothing in it yet. Someone who already journals never sees it. It stays for two weeks
   or until "Got it", and never shows in sample mode.
   ============================================================================ */
const FL_KEY='pzFirstLook';
function flLoad(){ try{ return JSON.parse(localStorage.getItem(FL_KEY)||'null'); }catch(e){ return null; } }
function flSave(v){ try{ localStorage.setItem(FL_KEY,JSON.stringify(v)); }catch(e){} }
// What the first look says, from the game's days (Discipline and slips per trading day). Pure.
function flSummary(days, n){
  const D=(days||[]).slice(-(n||30)); if(!D.length)return null;
  const by={}; for(const d of D)for(const s of ((d.behavior&&d.behavior.slips)||[]))for(const k of (s.f||[])){ const o=by[k]=by[k]||{n:0,cost:0}; o.n++; o.cost+=+s.net||0; }
  const leak=Object.keys(by).filter(k=>by[k].cost<0).sort((a,b)=>by[a].cost-by[b].cost)[0]||null;
  return {days:D.length,from:D[0].key,discipline:Math.round(D.reduce((a,d)=>a+d.score,0)/D.length),clean:D.filter(d=>d.score>=70).length,
    leak:leak?{slip:leak,n:by[leak].n,cost:by[leak].cost}:null};
}
function flCardHtml(D){
  if(typeof isDemoData==='function'&&isDemoData())return '';
  let st=flLoad();
  if(!st){ st={at:Date.now(),show:!Object.keys(journal).some(k=>!k.startsWith('week:'))}; flSave(st); }
  if(!st.show||st.done||Date.now()-st.at>14*86400000)return '';
  const s=flSummary(D.g.days,30); if(!s)return '';
  const plugging=s.leak&&typeof pzPlugs==='function'&&pzPlugs().some(p=>p.slip===s.leak.slip&&!p.dropped&&!p.done);
  const col=PZ_COL[pzBand(s.discipline)], lv=D.g.level, xp=Math.round((D.g.xp&&D.g.xp.total)||0);
  return `<section class="pz-card pz-kv" aria-labelledby="flT"><div class="pz-kvrow"><b id="flT" class="pz-kvh">Your first look</b><button type="button" class="pz-linkbtn" data-fl="done">Got it</button></div>
    <p class="pz-sub" style="margin:0;font-size:13px">Your last ${s.days} trading day${s.days===1?'':'s'}, already scored on process from your fills. Nothing to fill in.</p>
    <div class="pz-grid3"><div class="pz-tile"><span class="pz-n" style="color:${col}">${s.discipline}</span><span class="pz-t">Discipline, on average</span></div>
      <div class="pz-tile"><span class="pz-n">${s.clean}<small>/${s.days}</small></span><span class="pz-t">clean days (70+)</span></div>
      <div class="pz-tile"><span class="pz-n" style="color:${PZ_COL.xp}">${lv.level}</span><span class="pz-t">level · ${xp.toLocaleString('en-US')} XP already</span></div></div>
    ${s.leak?`<div class="pz-kv" style="gap:6px;padding-top:10px;border-top:1px solid var(--pz-line)"><span class="pz-lbl" style="color:${PZ_COL.low}">The habit that cost you most</span>
      <b style="font-size:15px">${esc(PZ_BEH[s.leak.slip])}</b><span class="pz-sub" style="font-size:13px">${s.leak.n} time${s.leak.n===1?'':'s'}, about ${esc(usdPlain(s.leak.cost))} on those trades.</span>
      ${plugging?'<span class="pz-fine">You’re plugging it: three clean trading weeks in a row and it’s done.</span>':`<button type="button" class="pz-cta pz-sm" data-pz-plug="${esc(s.leak.slip)}" style="align-self:flex-start;width:auto;padding:0 16px;min-height:44px">Plug this leak</button>`}</div>`
      :'<p class="pz-sub" style="margin:0;font-size:13px">None of the six slips cost you money in this stretch. That’s rare: keep it going.</p>'}
    <a class="pz-link" href="#journal" style="min-height:0">Next: rate your latest trade, about 10 seconds${pzI('chev',14)}</a></section>`;
}
function flClick(t){
  if(t.dataset.fl!=='done')return false;
  const st=flLoad()||{at:Date.now(),show:false}; st.done=true; flSave(st); pzRender(); return true;
}
pzFeature({id:'firstlook', today:{label:'Your first look',hint:'For your first two weeks: your history scored, and the habit that cost you most',col:0,html:flCardHtml}, click:flClick});
