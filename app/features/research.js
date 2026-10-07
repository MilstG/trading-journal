/* ============================================================================
   What the data says — the owner's research run (Admin → Research) brought to each member, and into
   the parts of the app that lean on it. Loads on both screens: the coach, the leaks, the tilt alerts and
   the weekly challenge read it on the journal too.

   The server sends group figures only (GET /api/social/findings, findings.js): what each slip costs a
   trader against their own trades in the same spot, how many trades a results ranking needs before it
   says more about skill than luck, whether a month's Discipline says anything about the next one, and,
   when the owner applied them, the Discipline weights those costs suggest. This file sets your own
   trades beside them: what each slip has cost YOU, measured the same way (rfMySlips), priced in your
   typical trade and in dollars. Fetched at most hourly and kept on this device ('pzRF'), so the weights
   hold before the server answers. Nothing here is sent anywhere.
   ============================================================================ */
const RF_KEY='pzRF', RF_TTL=3600000;
var RFD={d:null,at:0,busy:false,err:null};
try{ const c=JSON.parse(localStorage.getItem(RF_KEY)||'null'); if(c&&c.d&&c.d.on)RFD.d=c.d,RFD.at=0; }catch(e){}
function rfCanAsk(){ return typeof socAvailable==='function'&&socAvailable()&&typeof SOC!=='undefined'&&(!!SOC.key||!!(SRV.token&&!SRV.badAuth)); }
// the feed (or null), asked again when it's an hour old; re-draws whatever is open when it comes in
function rfData(){
  if(rfCanAsk()&&!RFD.busy&&Date.now()-RFD.at>RF_TTL){ RFD.busy=true; const was=rfWeightsKey();
    socFetch('/findings').then(d=>{ RFD.d=d&&d.on?d:null; RFD.err=null; try{ localStorage.setItem(RF_KEY,JSON.stringify({d:RFD.d})); }catch(e){} },e=>{ RFD.err=e.message; })
      .finally(()=>{ RFD.at=Date.now(); RFD.busy=false;
        if(rfWeightsKey()!==was||RFD.d){ if(typeof PZ!=='undefined'&&PZ&&typeof pzRender==='function')pzRender(); else if(typeof renderCoach==='function')try{ renderCoach(); }catch(e){} } }); }
  return RFD.d;
}
// the Discipline weights the owner applied (findings.js slipWeights), else null: every slipped trade counts the same
function rfWeights(){ const d=RFD.d; return d&&d.weights&&d.weights.on&&d.weights.w?d.weights.w:null; }
function rfWeightsKey(){ const w=rfWeights(); return w?JSON.stringify(w):''; }

// ---- your own slips, priced: the research's measure on one trader ----
// For each slip: the trades that had the chance to slip and did, against the ones that had it and didn't
// (a post-loss entry that waited, an add to a winner, a loser closed sooner; for trading on after two losses
// and overtrading, your other trades). R is your typical trade (median absolute result). Over the last
// `days` (180). Pure: closed trades and the game's behavior days in, {k: {n, chances, R, lo, hi, sure, usd, per100}} out.
const RF_MIN=3;
// which trades had the chance to slip each way, and which slipped, from the game's behavior days (also the
// work list's check on a leak being plugged, features/worklist.js)
function rfSlipSets(bdays){
  const flag=new Map(), revT=new Set(), sizeT=new Set();
  for(const b of bdays||[]){ if(!b)continue; for(const s of (b.slips||[]))flag.set(s.id,s.f||[]); for(const id of ((b.tests&&b.tests.revenge)||[]))revT.add(id); for(const id of ((b.tests&&b.tests.sizeUp)||[]))sizeT.add(id); }
  const loss=n=>n<-1;
  return {slipped:(t,k)=>(flag.get(t.id)||[]).includes(k),
    chance:{revenge:t=>revT.has(t.id),sizeUp:t=>sizeT.has(t.id),addLoser:t=>typeof hasAdd==='function'&&hasAdd(t),heldLoser:t=>loss(t.net),afterTwo:()=>true,overtrade:()=>true}};
}
function rfMySlips(closed, bdays, o){
  o=Object.assign({days:180,now:Date.now(),iters:200},o||{});
  const from=o.now-o.days*86400000, SS=rfSlipSets(bdays), chance=SS.chance;
  const tr=(closed||[]).filter(t=>t&&!t.isOpen&&t.closeTime&&t.openTime&&!t.partialHistory&&t.closeTime>=from);
  const nets=tr.map(t=>Math.abs(t.net)).filter(x=>x>0), u=nets.length?nfMedian(nets):0, out={};
  if(!(u>0)||tr.length<10)return {unit:u||0,n:tr.length,slips:out};
  const R=t=>Math.max(-20,Math.min(20,t.net/u)), mean=a=>a.reduce((s,x)=>s+x,0)/a.length;
  let seed=7; const rnd=()=>{ seed^=seed<<13; seed>>>=0; seed^=seed>>17; seed^=seed<<5; seed>>>=0; return seed/4294967296; };
  for(const k of Object.keys(chance)){
    const C=tr.filter(chance[k]), S=C.filter(t=>SS.slipped(t,k)).map(R), K=C.filter(t=>!SS.slipped(t,k)).map(R);
    if(S.length<RF_MIN||K.length<RF_MIN){ if(S.length)out[k]={n:S.length,chances:C.length,R:null}; continue; }
    const d=mean(S)-mean(K), bs=[];
    for(let i=0;i<o.iters;i++){ let a=0,b=0; for(let j=0;j<S.length;j++)a+=S[Math.floor(rnd()*S.length)]; for(let j=0;j<K.length;j++)b+=K[Math.floor(rnd()*K.length)]; bs.push(a/S.length-b/K.length); }
    bs.sort((x,y)=>x-y); const lo=bs[Math.floor(0.025*(bs.length-1))], hi=bs[Math.ceil(0.975*(bs.length-1))];
    out[k]={n:S.length,chances:C.length,R:Math.round(d*100)/100,lo:Math.round(lo*100)/100,hi:Math.round(hi*100)/100,sure:lo>0||hi<0,
      usd:d*u*S.length, per100:Math.round(d*S.length/tr.length*10000)/100, slipped:mean(S)};
  }
  return {unit:u,n:tr.length,slips:out};
}
let _rfMine={key:null,v:null};
function rfMine(D){ const g=D&&D.g; if(!g||!g.ctx)return null;
  const key=(typeof _gameKey==='function'?_gameKey():'')+'|'+(g.ctx.closed||[]).length;
  if(_rfMine.key!==key){ let v=null; try{ v=rfMySlips(g.ctx.closed,g.days.map(d=>d.behavior)); }catch(e){ console.warn('rfMySlips',e); } _rfMine={key,v}; }
  return _rfMine.v; }
// your slips, costliest first: your own measure where it's sure enough to say, the group's beside it.
// cost: what each one took over the window, in your typical trades (negative = cost)
function rfPriced(D){
  const mine=rfMine(D), feed=rfData(); if(!mine)return [];
  const rows=[];
  for(const k of Object.keys(PZ_BEH)){ const m=mine.slips[k], g=feed&&feed.slips&&feed.slips[k];
    if(!m||!m.n)continue;
    const each=m.R!=null?m.R:g&&g.sure?g.R:null; if(each==null)continue;
    rows.push({slip:k,label:PZ_BEH[k],n:m.n,each,own:m.R!=null,sure:!!m.sure,lo:m.lo,hi:m.hi,usd:each*mine.unit,total:each*m.n,group:g||null,unit:mine.unit}); }
  return rows.filter(r=>r.each<0).sort((a,b)=>a.total-b.total);
}
const rfX=v=>(Math.round(Math.abs(v)*10)/10).toFixed(1);
// one line for a slip's price, for the coach, the leaks and the tilt alerts
function rfPriceLine(r){ if(!r)return '';
  return 'Each one has cost you about '+rfX(r.each)+' of a typical trade (≈ '+usdPlain(r.usd)+')'+(r.own?'':' — the server’s figure; yours needs a few more')
    +(r.group&&r.own?'; traders here: '+rfX(r.group.R):'')+'.'; }
function rfPriceOf(D, slip){ try{ return rfPriced(D).find(r=>r.slip===slip)||null; }catch(e){ return null; } }

// ---- the screen: #data ----
function rfFwdText(F){
  if(!F)return null;
  const w=F.wallets+' wallets', q=F.quintiles||[], top=q[q.length-1], bot=q[0];
  const tail=top&&bot&&top.nextR!=null&&bot.nextR!=null?` The most disciplined fifth of months were followed by ${top.nextProfitable}% profitable months; the least disciplined fifth by ${bot.nextProfitable}%.`:'';
  return {yes:`Across ${w}, a month more disciplined than a trader’s own usual was followed by a better month, even allowing for how that month itself went.`,
    some:`Across ${w}, a month’s Discipline says something about the next month that its own results don’t. Inside one trader’s months it isn’t clear yet.`,
    no:`Across ${w}, a month’s Discipline didn’t say much about next month’s results on its own. Where it pays is in what it stops: each slip’s own cost, above.`,
    unclear:`Not clear yet from ${w}: the next run, with more months behind it, may say.`}[F.says]+tail;
}
function rfLuckHtml(D, F){
  const rel=F&&F.rel; if(!rel)return '';
  const since=Date.now()-90*86400000, n=((D.g.ctx&&D.g.ctx.closed)||[]).filter(t=>t.closeTime>=since&&!t.partialHistory).length;
  const word=n<rel.need/3?'mostly luck either way':n<rel.need?'still part luck':'enough to start reading as skill';
  return `<section class="pz-card pz-kv" aria-labelledby="rfLk"><b id="rfLk" class="pz-kvh">Skill or luck?</b>
    <p style="margin:0;font-size:14px;line-height:1.45">A ranking on results needs about <b>${rel.need.toLocaleString('en-US')} trades</b> a trader before it says more about skill than luck (0.7 reliable, from ${rel.wallets||F.wallets} wallets).</p>
    <p class="pz-sub" style="margin:0;font-size:13px">You closed ${n.toLocaleString('en-US')} in the last 90 days: ${esc(word)}. Boards and duels on results say so beside them.</p>
    ${rel.stays?`<p class="pz-fine" style="margin:0">Of the top quarter one quarter-year, ${rel.stays.top}% were still there the next (25% would be chance).</p>`:''}</section>`;
}
function rfSlipsHtml(D){
  const rows=rfPriced(D), mine=rfMine(D), feed=rfData(), G=(feed&&feed.slips)||{};
  const body=rows.length?rows.map(r=>{ const plugging=typeof pzPlugs==='function'&&pzPlugs().some(p=>p.slip===r.slip&&!p.dropped&&!p.done);
    return `<div class="pz-kv" style="gap:4px;padding:10px 0;border-top:1px solid var(--pz-line)"><div class="pz-kvrow"><b style="font-size:15px">${esc(r.label)}</b><span class="pz-tag leak">${r.n}×</span></div>
      <span style="font-size:14px">${esc(rfPriceLine(r))}</span>
      <span class="pz-sub" style="font-size:12px">Over the last 180 days that’s about ${esc(usdPlain(r.usd*r.n))}${r.own&&!r.sure?'; your own range still crosses zero':''}.</span>
      ${plugging?'':`<button type="button" class="pz-ghost pz-sm" data-pz-plug="${esc(r.slip)}" style="align-self:flex-start">Plug this leak</button>`}</div>`; }).join('')
    :`<p class="pz-sub" style="margin:0;font-size:13px">${mine&&mine.n>=10?'None of your slips has cost you against your own trades in the same spot. Keep it that way.':'It needs 10 closed trades in the last 180 days.'}</p>`;
  const grp=Object.keys(G).length?`<details class="pz-why"><summary>What each slip costs traders here</summary><span>${Object.keys(PZ_BEH).filter(k=>G[k]).map(k=>esc(PZ_BEH[k])+': '+(G[k].R<0?'−':'+')+rfX(G[k].R)+' of a typical trade'+(G[k].sure?'':' (can’t be told from zero)')+' · '+G[k].wallets+' wallets').join('<br>')}</span></details>`:'';
  return `<section class="pz-card pz-kv" aria-labelledby="rfSl"><b id="rfSl" class="pz-kvh">Your slips, priced</b>
    <p class="pz-sub" style="margin:0;font-size:13px">Each slip against your own trades that had the same chance and didn’t take it: a post-loss entry that waited, a loser closed sooner. Your typical trade is ${mine&&mine.unit?esc(usdPlain(mine.unit)):'—'}.</p>
    ${body}${grp}</section>`;
}
function rfScreenHtml(D){
  const back=`<a class="pz-back" href="#trends">${pzI('back',20)}Stats</a>`, F=rfData();
  const intro=F?`<p class="pz-fine" style="margin:0 0 4px">From the league’s research run on ${F.wallets} wallets (${esc(new Date(F.at).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}))}): group figures only, set beside your own trades on this device.</p>`
    :`<p class="pz-fine" style="margin:0 0 4px">${rfCanAsk()?'The league hasn’t shared a research run yet. Your own numbers below are from your trades alone.':'Your own numbers, from your trades on this device.'}</p>`;
  const fwd=rfFwdText(F&&F.forward);
  return `${back}${pzHead('Stats','What the data says')}${intro}<div class="pz-grid">
    ${rfSlipsHtml(D)}
    ${fwd?`<section class="pz-card pz-kv" aria-labelledby="rfFw"><b id="rfFw" class="pz-kvh">Does Discipline pay next month?</b><p style="margin:0;font-size:14px;line-height:1.45">${esc(fwd)}</p>
      ${F.weights&&F.weights.on?'<p class="pz-fine" style="margin:0">Your league weighs each slip in the Discipline score by what it costs: the costliest counts in full, the others less.</p>':''}</section>`:''}
    ${rfLuckHtml(D,F)}
    ${typeof crowdSectionHtml==='function'?crowdSectionHtml(D):''}
    ${typeof luckSectionHtml==='function'?luckSectionHtml(D):''}
    ${typeof rrSectionHtml==='function'?rrSectionHtml(D):''}</div>`;
}
// ---- on Today: the slip that costs you most, priced ----
function rfCardHtml(D){
  if(typeof wlActive==='function'&&wlActive())return ''; // the work list ranks your slips now (features/worklist.js)
  const r=rfPriced(D)[0]; if(!r||!r.own)return '';
  return `<section class="pz-card pz-kv" aria-labelledby="rfT"><div class="pz-kvrow"><b id="rfT" class="pz-kvh">Your costliest slip</b><span class="pz-tag leak">${r.n}× · 180 days</span></div>
    <b style="font-size:16px;line-height:1.3">${esc(r.label)}</b><p class="pz-sub" style="margin:0;font-size:13px">${esc(rfPriceLine(r))}</p>
    <a class="pz-link" href="#data" style="min-height:0">Every slip, priced${pzI('chev',14)}</a></section>`;
}
pzFeature({id:'priced', today:{label:'Your costliest slip',hint:'The slip that costs you most, priced against your own trades',col:1,after:'finding',html:rfCardHtml},
  tab:{name:'data',nav:'trends',html:rfScreenHtml}});
