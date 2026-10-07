/* ============================================================================
   Finding of the week — one thing your own trades show, new each week, on Today.
   A feature in its own file: it plugs into Daruma through pzFeature (app/pulse.js) and loads on
   Daruma's page only (data-only="keel" in ledger.html).

   It comes from the coach's findings (buildFindings: the Diagnostic's recommendations in plain words)
   and only from the ones it calls probably or very likely real, edges and leaks alike, so the surprise
   is always something true. Each week picks the strongest one not shown in the last six weeks (this
   device remembers which: localStorage 'pzFind'); with nothing new that's real, there's no card.
   "Got it" puts it away until next week. Monday's morning reminder says a new one is in.
   ============================================================================ */
const FIND_KEY='pzFind', FIND_CONF={strong:2,likely:1}, FIND_TONES=['edge','leak','caution','win'];
// the pick for a week: the same one all week; otherwise the first eligible finding (they come strongest
// first) not shown in the six weeks before. Pure, for the tests: returns {pick, st}.
function findPick(findings, st, week){
  st=st&&typeof st==='object'?st:{}; const hist=Array.isArray(st.hist)?st.hist.filter(h=>h&&h.id&&h.week):[];
  const ok=(findings||[]).filter(f=>f&&f.id&&f.title&&FIND_CONF[f.conf]&&FIND_TONES.includes(f.tone));
  const cur=hist.find(h=>h.week===week);
  if(cur){ const f=ok.find(x=>x.id===cur.id); return {pick:f||null,st:Object.assign({},st,{hist})}; }
  const wn=w=>{ const m=/^(\d{4})-W(\d{2})$/.exec(w)||[0,0,0]; return +m[1]*52.1775+ +m[2]; }; // weeks, near enough across a year's end
  const recent=new Set(hist.filter(h=>h.week<week&&wn(week)-wn(h.week)<=6).map(h=>h.id));
  const f=ok.find(x=>!recent.has(x.id))||null;
  if(!f)return {pick:null,st:Object.assign({},st,{hist})};
  return {pick:f,st:Object.assign({},st,{hist:[...hist,{week,id:f.id}].slice(-12)})};
}
function findLoad(){ try{ return JSON.parse(localStorage.getItem(FIND_KEY)||'null'); }catch(e){ return null; } }
function findSave(v){ try{ localStorage.setItem(FIND_KEY,JSON.stringify(v)); }catch(e){} }
function findCardHtml(D){
  const week=isoWeekOfKey(D.todayK), st=findLoad()||{};
  if(st.gotIt===week)return '';
  // what the work list already ranks isn't a surprise twice (features/worklist.js)
  const r=findPick(((D.ctx&&D.ctx.findings)||[]).filter(f=>!(typeof wlCovers==='function'&&wlCovers(f))),st,week); if(!r.pick)return '';
  if(JSON.stringify(r.st)!==JSON.stringify(st))findSave(r.st);
  const f=r.pick;
  return `<section class="pz-card pz-kv" aria-labelledby="fdT"><div class="pz-kvrow"><b id="fdT" class="pz-kvh">Finding of the week</b><span class="pz-tag ${esc(f.tone)}">${esc(TONE_TAG[f.tone]||'Note')}</span></div>
    <b style="font-size:16px;line-height:1.3">${esc(f.title)}</b>
    ${f.body?`<p class="pz-sub" style="margin:0;font-size:13px">${esc(pzPlain(f.body))}</p>`:''}
    ${f.action?`<p style="margin:0;font-size:14px"><b>Try:</b> ${esc(pzPlain(f.action))}</p>`:''}
    ${f.evidence?`<details class="pz-why"><summary>Why we think it’s real</summary><span>${esc(f.evidence)} · ${esc(confWords(f.conf))}</span></details>`:`<p class="pz-fine" style="margin:0">${esc(confWords(f.conf))}</p>`}
    <div style="display:flex;gap:8px;flex-wrap:wrap"><a class="pz-ghost pz-sm" href="#trends" style="flex:1;display:inline-flex;align-items:center;justify-content:center;text-decoration:none">Everything that moves your results</a><button type="button" class="pz-linkbtn" data-fd="got">Got it</button></div>
    <p class="pz-fine" style="margin:0">Read from your own trades. A pattern, not a promise: trade it deliberately and keep checking.</p></section>`;
}
function findClick(t){
  if(t.dataset.fd!=='got')return false;
  const st=findLoad()||{}; st.gotIt=isoWeekOfKey(dayKey(Date.now())); findSave(st); pzNote('Put away until next week’s finding.'); pzRender(); return true;
}
pzFeature({id:'finding', today:{label:'Finding of the week',hint:'One thing your own trades show, new each week, only when it’s probably real',col:1,after:'lesson',html:findCardHtml}, click:findClick});
