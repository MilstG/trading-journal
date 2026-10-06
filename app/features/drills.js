/* ============================================================================
   Replay drills — practice on your own trades. A feature in its own file: the #drills screen (from
   Progress) and, once a day, a card on Today. Loads on Daruma's page only (data-only="keel").

   One of your closed trades from the last 90 days comes back with the chart cut off at the moment it
   hurt most (the candle that closed furthest against you while you held; the middle of the hold when it
   never did). You see what you saw then: the candles before, your entry, where price is now. Hold, cut or
   add? Then the rest of the chart, and what each choice would have made against what you actually did:
   cut closes everything at that candle's close; add doubles the position there and exits with your exits;
   hold is what you did. Gross of fees, from your own fills (replayPnlAt). Hindsight is the point: it's
   practice reading the chart at the moment it counts, not a verdict on the trade.

   Kept in your settings (settings.pzDrills, so it syncs): how many you've done and how each call went.
   ============================================================================ */
var DR={cur:null,busy:false,err:null};
const DR_CH={hold:'Hold',cut:'Cut',add:'Add'};
// trades that can be drilled: closed, entry known, fills to replay, in the last `days`
function drillPool(closed, o){
  o=Object.assign({days:90,now:Date.now(),skip:[]},o||{}); const from=o.now-o.days*86400000, skip=new Set(o.skip);
  return (closed||[]).filter(t=>t&&!t.isOpen&&t.closeTime>=from&&!t.partialHistory&&t.avgEntry>0&&Array.isArray(t.events)&&t.events.length>=2
    &&(t.dir==='Long'||t.dir==='Short')&&t.closeTime-t.openTime>=15*60000&&!skip.has(t.id));
}
// the moment it hurt most: of the candles wholly inside the hold, the one whose close was furthest against
// you (the middle one when none was against you); null when the hold spans under 3 candles. Pure.
function drillPoint(t, candles, ms){
  const sg=t.dir==='Short'?-1:1, inside=(candles||[]).filter(c=>c[0]>=t.openTime&&c[0]+ms<=t.closeTime);
  if(inside.length<3)return null;
  let k=-1, worst=0; inside.slice(0,-1).forEach((c,i)=>{ const v=(c[3]-t.avgEntry)*sg; if(v<worst){ worst=v; k=i; } });
  const pick=k>=0&&-worst/t.avgEntry>=0.002?inside[k]:inside[Math.floor((inside.length-1)/2)];
  return {at:pick[0]+ms, px:pick[3], hurt:k>=0&&-worst/t.avgEntry>=0.002};
}
// what each call would have made from that point. Pure (replayPnlAt: the position and P&L from the fills).
function drillOutcomes(t, p){
  const sg=t.dir==='Short'?-1:1, now=replayPnlAt(t.dir,t.events,p.at,p.px), end=replayPnlAt(t.dir,t.events,Infinity,NaN);
  let q=0, v=0; for(const e of t.events)if(e[0]>p.at&&e[3]<0){ q+=e[2]; v+=e[1]*e[2]; }
  const exitAfter=q>0?v/q:null, hold=end.realized;
  return {pos:now.pos, avg:now.avg, open:now.open, cut:now.total, hold, add:exitAfter!=null&&now.pos>0?hold+now.pos*(exitAfter-p.px)*sg:null};
}
function drillState(){ const s=settings.pzDrills; return s&&typeof s==='object'?Object.assign({n:0,beat:0,by:{},hist:[]},s):{n:0,beat:0,by:{},hist:[]}; }
async function drillSave(rec){
  const s=drillState(); s.n++; if(rec.beat)s.beat++;
  const b=s.by[rec.c]=Object.assign({n:0,beat:0},s.by[rec.c]); b.n++; if(rec.beat)b.beat++;
  s.hist=[...(s.hist||[]),rec].slice(-50); s.last=dayKey(Date.now()); settings.pzDrills=s; await Store.set(S_KEY,settings);
}
async function drillStart(D){
  if(DR.busy)return; DR.busy=true; DR.err=null; DR.cur=null; pzRender();
  try{
    const pool=drillPool(D.g.ctx.closed,{skip:drillState().hist.map(h=>h.id)}), tries=pool.sort(()=>Math.random()-0.5).slice(0,6);
    for(const t of tries){ let r=null; try{ r=await ensureTradeCandles(t,{before:24,after:8}); }catch(e){}
      if(!r||!r.candles||r.candles.length<6)continue;
      const p=drillPoint(t,r.candles,r.itv.ms); if(!p)continue;
      DR.cur={t,c:r.candles,ms:r.itv.ms,p,o:drillOutcomes(t,p),choice:null}; break; }
    if(!DR.cur)DR.err=pool.length?'None of your recent trades could be drilled right now (no candles for those markets, or holds too short). Try again later.':'It needs closed trades from the last 90 days with their fills: hold a trade at least 15 minutes and come back.';
  }finally{ DR.busy=false; pzRender(); }
}
function drillChartHtml(cur, reveal){
  const t=cur.t;
  if(reveal)return pzSnapSvg(t,cur.c,cur.ms,typeof nfPlan==='function'?nfPlan(journal[t.id]):null,null);
  // as you saw it: the candles up to the moment, your fills before it, still open
  const seen=cur.c.filter(c=>c[0]+cur.ms<=cur.p.at), ev=t.events.filter(e=>e[0]<=cur.p.at);
  return pzSnapSvg(Object.assign({},t,{isOpen:true,events:ev,avgEntry:cur.o.avg||t.avgEntry,avgExit:null}),seen,cur.ms,null,null);
}
function drillsScreenHtml(D){
  const back=`<a class="pz-back" href="#progress">${pzI('back',20)}Progress</a>`, head=pzHead('Practice on your own trades','Replay drills'), S=drillState(), cur=DR.cur;
  const stats=S.n?`<section class="pz-card pz-kv"><b class="pz-kvh">Your drills · ${S.n}</b><div class="pz-grid3">${['hold','cut','add'].map(k=>{ const b=S.by[k]||{n:0,beat:0};
    return `<div class="pz-tile"><span class="pz-n">${b.n}</span><span class="pz-t">${DR_CH[k]}${b.n?' · beat what you did '+b.beat+'×':''}</span></div>`; }).join('')}</div>
    <p class="pz-fine" style="margin:0">“Beat” is hindsight: the call made more than what you actually did. Look for a pattern in your calls, not a score.</p></section>`:'';
  let body;
  if(DR.busy)body='<section class="pz-card"><p class="pz-sub" style="margin:0"><span class="pz-spin"></span>Finding a trade and its candles…</p></section>';
  else if(!cur)body=`<section class="pz-card pz-kv"><b class="pz-kvh">How it works</b><p class="pz-sub" style="margin:0;font-size:13px">One of your trades from the last 90 days, cut off at the moment it hurt most. Hold, cut or add? Then the rest of the chart, and what each call would have made.</p>
    ${DR.err?`<p class="pz-warn" style="margin:0">${esc(DR.err)}</p>`:''}<button type="button" class="pz-cta" data-dr="start">${S.n?'Next drill':'Start a drill'}</button></section>`;
  else { const t=cur.t, o=cur.o, short=t.dir==='Short', mv=(cur.p.px/(o.avg||t.avgEntry)-1)*100*(short?-1:1), held=pzHeld(cur.p.at-t.openTime);
    const q=`You’re ${short?'short':'long'} ${esc(dispMarket(dcoin(t)))} from ${esc(pzPx(o.avg||t.avgEntry))}. It’s now ${esc(pzPx(cur.p.px))} (${mv>=0?'+':''}${mv.toFixed(2)}%), ${esc(held)} in${o.open?', '+esc(signedPlain(o.open))+' open':''}.`;
    if(!cur.choice)body=`<section class="pz-card pz-kv">${drillChartHtml(cur,false)}<p style="margin:0;font-size:15px;line-height:1.4">${q} What do you do?</p>
      <div class="pz-grid3">${['hold','cut','add'].map(k=>`<button type="button" class="${k==='hold'?'pz-cta':'pz-ghost'}" data-dr="pick" data-c="${k}"${k==='add'&&o.add==null?' disabled':''}>${DR_CH[k]}</button>`).join('')}</div>
      <p class="pz-fine" style="margin:0">${esc(dayLabel(dayKey(t.openTime)))}. The rest of the chart is hidden until you choose.</p></section>`;
    else { const pick=o[cur.choice], col=v=>v==null?'':v>=0?PZ_COL.good:PZ_COL.low, row=k=>`<div class="pz-row-t"><span>${DR_CH[k]}${k==='hold'?' (what you did)':''}${k===cur.choice?' · your call':''}</span><b style="color:${col(o[k])}">${o[k]==null?'—':esc(signedPlain(o[k]))}</b></div>`;
      const vs=cur.choice==='hold'?'Same as what you did.':pick>o.hold?'Better than what you did by '+signedPlain(pick-o.hold).replace(/^\+/,'')+'.':pick<o.hold?'What you did was better by '+signedPlain(o.hold-pick).replace(/^\+/,'')+'.':'The same as what you did.';
      body=`<section class="pz-card pz-kv">${drillChartHtml(cur,true)}<p style="margin:0;font-size:15px;line-height:1.4">${q}</p>${['hold','cut','add'].map(row).join('')}
        <b style="font-size:15px">${esc(vs)}</b>${journal[t.id]&&journal[t.id].notes?`<p class="pz-sub" style="margin:0;font-size:13px">Your note then: “${esc(String(journal[t.id].notes).slice(0,240))}”</p>`:''}
        <p class="pz-fine" style="margin:0">Gross of fees, from your own fills. Add doubles the position at that candle and exits with your exits.</p>
        <button type="button" class="pz-cta" data-dr="start">Next drill</button></section>`; } }
  return `${back}${head}<div class="pz-wide"><div class="pz-col">${body}</div><div class="pz-col">${stats}</div></div>`;
}
// on Today: one a day, until you've done today's; on Progress (its screen's cards) always, as the way in
function drillCardHtml(D){
  const S=drillState(), done=S.last===D.todayK; if(drillPool(D.g.ctx.closed).length<5)return '';
  if(pzTab()==='progress')return `<section class="pz-card pz-kv"><div class="pz-kvrow"><b class="pz-kvh">Replay drills</b>${S.n?`<span class="pz-tag">${S.n} done</span>`:''}</div>
    <p class="pz-sub" style="margin:0;font-size:13px">Practice on your own trades: hold, cut or add at the moment it hurt most.</p><a class="pz-link" href="#drills" style="min-height:0">${done?'Another drill':'Today’s drill'}${pzI('chev',14)}</a></section>`;
  if(done)return '';
  return `<section class="pz-card pz-kv" aria-labelledby="drC"><div class="pz-kvrow"><b id="drC" class="pz-kvh">Today’s drill</b><span class="pz-tag">2 minutes</span></div>
    <p class="pz-sub" style="margin:0;font-size:13px">One of your own trades, stopped at the moment it hurt most. Hold, cut or add?</p>
    <a class="pz-ghost pz-sm" href="#drills" style="display:inline-flex;align-items:center;justify-content:center;text-decoration:none">Take it</a></section>`;
}
async function drillsClick(t){
  const a=t.dataset.dr; if(!a)return false;
  if(a==='start'){ drillStart(pzData()); return true; }
  if(a==='pick'&&DR.cur&&!DR.cur.choice){ const c=t.dataset.c, o=DR.cur.o; if(o[c]==null)return true; DR.cur.choice=c;
    await drillSave({id:DR.cur.t.id,c,at:Date.now(),d:Math.round((o[c]-o.hold)*100)/100,beat:c!=='hold'&&o[c]>o.hold}); pzRender(); return true; }
  return true;
}
pzFeature({id:'drills', today:{label:'Today’s drill',hint:'One of your trades, stopped at the moment it hurt most: hold, cut or add?',col:1,after:'rules',html:drillCardHtml},
  tab:{name:'drills', nav:'progress', html:drillsScreenHtml}, click:drillsClick});
