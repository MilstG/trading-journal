// Ledger app · part 5 of 15: the Diagnostic view, what-if, the forward tracker, deep scan, the compute worker.
// ledger.html loads the parts in order as classic scripts sharing one global scope. Code that
// runs while a part loads (not inside a function called later) may only use names declared in
// this part or an earlier one; the boot part runs last. See "Development and testing" in README.md.

/* ============================ diagnostic ============================ */
function diagScan(closed){
  const dims=['dir','market','dow','hour','hold','size','setup','tag','mistake','rating'];
  const MIN=Math.max(5,Math.round(closed.length*0.03));
  let all=[];
  dims.forEach(dim=>{ bucketize(closed,dim).forEach(b=>{ if(b.n>=MIN && !/^\((no|un)/.test(String(b.key)))
    all.push({dim,label:edgeLabel(dim),...b,score:b.expectancy*Math.sqrt(b.n)}); }); });
  // Significance: one-sample t of each bucket's mean net vs 0 (two-sided), then a
  // Benjamini-Hochberg FDR gate across every bucket tested here — the same multiple-comparison
  // discipline the miner uses, so a bucket that just sorts high on expectancy*sqrt(n) is no
  // longer presented as an "edge" until it clears the noise floor. Student-t at df=n-1
  // (buckets go as small as n=5, where the normal approximation is anti-conservative);
  // sig=false where n<2 or sd==0.
  all.forEach(b=>{ if(b.n>1 && b.sd>0){ b.t=b.expectancy/(b.sd/Math.sqrt(b.n));
      b.p=2*(1-_tCdf(Math.abs(b.t),b.n-1)); } else { b.t=null; b.p=1; } });
  const Q=0.10, M=all.length;
  if(M){ const idx=all.map((b,i)=>i).sort((i,j)=>all[i].p-all[j].p);
    let crit=-1; for(let r=0;r<M;r++){ if(all[idx[r]].p<=(r+1)/M*Q)crit=r; }
    idx.forEach((i,r)=>{ all[i].sig = crit>=0 && r<=crit; }); }
  return { MIN, fdrQ:Q,
    strong: all.filter(b=>b.expectancy>0).sort((a,b)=>b.score-a.score).slice(0,5),
    weak:   all.filter(b=>b.expectancy<0).sort((a,b)=>a.score-b.score).slice(0,5) };
}
function splitStability(closed){
  const s=[...closed].sort((a,b)=>a.closeTime-b.closeTime);
  const mid=Math.floor(s.length/2), A=s.slice(0,mid), B=s.slice(mid);
  const st=arr=>{ const net=arr.reduce((x,t)=>x+t.net,0), sh=sharpeStats(dailySeriesCalendar(arr));
    const w=arr.filter(t=>isWin(t.net)).length, l=arr.filter(t=>isLoss(t.net)).length;
    return {n:arr.length,net,exp:arr.length?net/arr.length:0,wr:(w+l)?w/(w+l):0,sharpe:sh?sh.sr:null}; };
  return {early:st(A),recent:st(B)};
}
let _diagCharts={};
let _distState={shape:false,survival:false,best:false,fill:false,binW:null,mode:'usd',binPct:null};
let _distBinTimer=null;
function _histogram(nets,binW){
  if(!nets.length)return null;
  const lo=Math.min(...nets),hi=Math.max(...nets);
  const first=Math.floor(lo/binW)*binW,last=Math.ceil(hi/binW)*binW;
  const nb=Math.max(1,Math.round((last-first)/binW));
  const edges=[],counts=new Array(nb).fill(0),mids=[];
  for(let i=0;i<=nb;i++)edges.push(first+i*binW);
  for(let i=0;i<nb;i++)mids.push((edges[i]+edges[i+1])/2);
  for(const v of nets){ let idx=Math.floor((v-first)/binW); if(idx<0)idx=0; if(idx>=nb)idx=nb-1; counts[idx]++; }
  return {edges,counts,mids,first,last,nb};
}
function _skew(a){ const n=a.length; if(n<3)return 0; const m=_avg(a),sd=_std(a); if(sd===0)return 0;
  const s=a.reduce((x,v)=>x+Math.pow((v-m)/sd,3),0); return (n/((n-1)*(n-2)))*s; }
function _bell(mids,mu,sd,N,binW,scale){ if(sd<=0)return mids.map(()=>0);
  return mids.map(m=>Math.exp(-0.5*((m-mu)/sd)**2)/(sd*Math.sqrt(2*Math.PI))*N*binW*(scale||1)); }
function _fdWidth(vals){ const a=[...vals].sort((x,y)=>x-y), n=a.length; if(n<4)return null;
  const q=p=>{const i=(n-1)*p,lo=Math.floor(i),hi=Math.ceil(i);return a[lo]+(a[hi]-a[lo])*(i-lo);};
  const iqr=q(0.75)-q(0.25); if(iqr<=0)return null; return 2*iqr/Math.cbrt(n); }
function _niceWidth(w){ if(!w||!isFinite(w)||w<=0)return null;
  const mag=Math.pow(10,Math.floor(Math.log10(w))); const f=w/mag;
  return (f<1.5?1:f<3?2:f<7?5:10)*mag; }
function _autoBin(vals,pct){ const w=_niceWidth(_fdWidth(vals)); if(w)return w; return pct?0.5:250; }
function _survivalFloor(nets,acct){
  const wins=nets.filter(x=>x>0),losses=nets.filter(x=>x<0);
  if(wins.length<5||losses.length<5||!acct)return null;
  const p=wins.length/(wins.length+losses.length),avgW=_avg(wins),avgL=Math.abs(_avg(losses)),b=avgW/avgL;
  const kelly=Math.max(0,(p*b-(1-p))/b); if(kelly<=0)return null;
  return {p,b,kelly,floor:-(kelly*acct)};
}
function renderDistribution(closed){
  const box=$('distChart'); if(!box)return;
  _srand(_hashSeed('dist|'+closed.length+'|'+(closed.length?closed[0].id+'|'+closed[closed.length-1].id:'')));
  const pct=_distState.mode==='pct';
  const rows=pct ? closed.map(t=>retPct(t)).filter(v=>v!==null) : closed.map(t=>t.net);
  const empty=$('distEmpty');
  if(rows.length<20){ if(_diagCharts.dist){_diagCharts.dist.destroy();_diagCharts.dist=null;} box.style.display='none'; empty.classList.remove('hide');
    empty.textContent=pct?'Needs \u226520 trades with a known position size.':'Needs \u226520 completed trades.';
    $('distStats').innerHTML=''; $('distLede').textContent=''; $('distCap').textContent=''; syncDistControls(closed); return; }
  box.style.display=''; empty.classList.add('hide');
  const nets=rows;
  const custom = pct?_distState.binPct:_distState.binW;
  let binW = (custom&&custom>0) ? custom : _autoBin(nets,pct);
  const isAuto = !(custom&&custom>0);
  // guard: cap bins at 200 so a tiny custom width can't freeze the chart
  { const lo=Math.min(...nets),hi=Math.max(...nets); if((hi-lo)/binW>200) binW=(hi-lo)/200; }
  const fmtV = pct ? (n=>(n>=0?'+':'')+n.toFixed(2)+'%') : (n=>fmtUsd(n));
  const fmtAxis = pct ? (e=>(e>=0?'+':'')+e.toFixed(e%1?1:0)+'%') : (e=>{ const v=e/1000; return (e<0?'-$'+Math.abs(v).toFixed(Math.abs(v)%1?1:0):'$'+v.toFixed(v%1?1:0))+'k'; });
  const fmtRange = pct ? (n=>(n>=0?'+':'')+n.toFixed(2)+'%') : (n=>{ const a=Math.abs(n); const t=a>=1000?'$'+(a/1000).toFixed(a%1000?1:0)+'k':'$'+a.toFixed(0); return (n<0?'-':'')+t; });
  const H=_histogram(nets,binW), N=nets.length;
  const mean=_avg(nets), sd=_std(nets);
  const sorted=[...nets].sort((a,b)=>a-b);
  const median=sorted.length%2?sorted[(sorted.length-1)/2]:(sorted[sorted.length/2-1]+sorted[sorted.length/2])/2;
  const skew=_skew(nets);
  const desc=[...nets].sort((a,b)=>b-a); const k=Math.max(1,Math.round(N*0.1));
  const grossProfit=nets.filter(x=>x>0).reduce((a,b)=>a+b,0);
  const top10=desc.slice(0,k).filter(x=>x>0).reduce((a,b)=>a+b,0);
  const top10Share=grossProfit>0?top10/grossProfit*100:0;
  const pLo=sorted[Math.floor(0.1*sorted.length)], pHi=sorted[Math.floor(0.9*sorted.length)];
  const bb=document.body.classList.contains('bb');
  const cLoss=bb?'#FF4759':'#e34948', cWin=bb?'#1FDB72':'#1baf7a', cLossOut='#a32d2d', cWinOut=bb?'#0F6E56':'#0f6e56';
  const colors=H.mids.map(m=>{ if(m<=pLo)return cLossOut; if(m>=pHi)return cWinOut; return m<0?cLoss:cWin; });
  const labels=H.edges.slice(0,-1).map(fmtAxis);
  const ranges=H.edges.slice(0,-1).map((e,i)=>[e,H.edges[i+1]]);
  const acct=(accountValue||0)+(spotAccountValue||0);
  let sf=null;
  { const wins=nets.filter(x=>x>0),losses=nets.filter(x=>x<0);
    if(wins.length>=5&&losses.length>=5){ const p=wins.length/(wins.length+losses.length),b=_avg(wins)/Math.abs(_avg(losses));
      const kelly=Math.max(0,(p*b-(1-p))/b);
      if(kelly>0){ if(pct){ sf={p,b,kelly,floor:-(kelly*100)}; } else if(acct){ sf={p,b,kelly,floor:-(kelly*acct)}; } } } }
  const tShape=_bell(H.mids, mean+(mean>median?(mean-median)*0.6:(pct?0.3:80)), sd*0.82, N, binW, 1.12);
  let tBest=null; const cp=changePoint(closed);
  if(cp&&cp.sig){ const chron=[...closed].sort((a,b)=>a.closeTime-b.closeTime);
    const seg=cp.after.exp>=cp.before.exp?chron.slice(cp.k):chron.slice(0,cp.k);
    const segV=(pct?seg.map(t=>retPct(t)).filter(v=>v!==null):seg.map(t=>t.net));
    if(segV.length>=15) tBest=_bell(H.mids,_avg(segV),_std(segV),N,binW,1.05); }
  if(!tBest) tBest=_bell(H.mids, mean*1.4, sd*0.75, N, binW, 1.05);
  const muted=TXT, grid=GRID, primary=bb?'#F5F5EE':'#E8ECF5', vio=bb?'#B9A9FF':'#8a7bd8', grn=bb?'#3DE38C':'#1d9e75';
  const xFor=v=>{ for(let i=0;i<H.edges.length-1;i++){ if(v>=H.edges[i]&&v<H.edges[i+1]) return i+(v-H.edges[i])/(H.edges[i+1]-H.edges[i])-0.5; } if(v>=H.edges[H.edges.length-1])return H.nb-0.5; return null; };

  const card=(k2,v2,c)=>`<div class="stat"><div class="k">${k2}</div><div class="v ${c||''}">${v2}</div></div>`;
  $('distStats').style.gridTemplateColumns=''; // .stats' own responsive columns (4 → 2 → 1)
  $('distStats').innerHTML=card('Mean',fmtV(mean),cls(mean))+card('Median',fmtV(median),cls(median))+card('Std dev',pct?sd.toFixed(2)+'%':fmtUsd(sd))+card('Skew',(skew>=0?'+':'')+skew.toFixed(2),skew>0?'pos-t':skew<0?'neg-t':'');
  $('distLede').innerHTML=`Mean sits <b>${fmtV(Math.abs(mean-median)).replace('+','')} ${mean>=median?'above':'below'}</b> your median${grossProfit>0?` \u2014 top 10% of trades account for <b>${top10Share.toFixed(0)}%</b> of gross ${pct?'return':'profit'}`:''}. ${skew>1?'A right-skewed edge: a few big winners carry the average, so your typical trade is smaller than the mean suggests.':skew<-1?'A left-skewed profile: occasional large losses drag the tail.':'A fairly symmetric result profile.'}${pct?' Shown as % of position notional \u2014 size-neutral.':''}`;

  const overlay={ id:'distOverlay',
    beforeDatasetsDraw:(ch)=>{ if(!_distState.survival||!sf)return;
      const ctx=ch.ctx,xa=ch.scales.x,ya=ch.scales.y,step=xa.getPixelForValue(1)-xa.getPixelForValue(0);
      const xi=xFor(sf.floor); if(xi===null)return; const xEnd=xa.getPixelForValue(Math.round(xi))+(xi-Math.round(xi))*step;
      ctx.save(); ctx.fillStyle='rgba(226,75,74,.13)'; ctx.fillRect(xa.left,ya.top,Math.max(0,xEnd-xa.left),ya.bottom-ya.top); ctx.restore(); },
    afterDatasetsDraw:(ch)=>{ const ctx=ch.ctx,xa=ch.scales.x,ya=ch.scales.y,step=xa.getPixelForValue(1)-xa.getPixelForValue(0);
      const px=v=>{ const xi=xFor(v); if(xi===null)return null; return xa.getPixelForValue(Math.round(xi))+(xi-Math.round(xi))*step; };
      [[0,muted,[3,3]],[median,primary,[5,4]],[mean,vio,[]]].forEach(m=>{ const x=px(m[0]); if(x===null)return;
        ctx.save(); ctx.beginPath(); ctx.setLineDash(m[2]); ctx.moveTo(x,ya.top); ctx.lineTo(x,ya.bottom);
        ctx.lineWidth=1.5; ctx.strokeStyle=m[1]; ctx.globalAlpha=.7; ctx.stroke(); ctx.restore(); });
      if(_distState.survival&&sf){ const xe=px(sf.floor); if(xe!==null&&xe>xa.left+2){ ctx.save(); ctx.font='500 10px sans-serif'; ctx.fillStyle='#a32d2d'; ctx.textAlign='left'; ctx.fillText('viability risk \u21a4', xa.left+4, ya.top+12); ctx.restore(); } } }
  };
  if(_diagCharts.dist)_diagCharts.dist.destroy();
  _diagCharts.dist=new Chart(box,{ data:{labels,datasets:[
    {type:'bar',data:H.counts,backgroundColor:colors,borderRadius:3,categoryPercentage:0.98,barPercentage:0.98,order:3},
    {type:'line',label:'shape',data:tShape,borderColor:vio,backgroundColor:'rgba(138,123,216,.13)',borderDash:[6,4],borderWidth:2,pointRadius:0,pointHoverRadius:4,tension:.45,hidden:!_distState.shape,fill:_distState.fill?'origin':false,order:1},
    {type:'line',label:'best',data:tBest,borderColor:grn,backgroundColor:'rgba(29,158,117,.12)',borderDash:[2,3],borderWidth:2,pointRadius:0,pointHoverRadius:4,tension:.45,hidden:!_distState.best,fill:_distState.fill?'origin':false,order:2}
  ]},
    options:{responsive:true,maintainAspectRatio:false,interaction:{mode:'index',intersect:false},
      plugins:{legend:{display:false},tooltip:{callbacks:{
        title:it=>{ const r=ranges[it[0].dataIndex]; return fmtRange(r[0])+'  to  '+fmtRange(r[1]); },
        label:c=>{ if(c.dataset.type==='bar'){ return '  '+c.parsed.y+' trades \u00b7 '+(c.parsed.y/N*100).toFixed(1)+'% of all'; }
          return '  '+(c.dataset.label==='shape'?'repeatable-edge target':'best-period shape')+': ~'+Math.round(c.parsed.y); },
        afterBody:it=>{ let cum=0; for(let x=0;x<=it[0].dataIndex;x++)cum+=H.counts[x]; return '  '+(cum/N*100).toFixed(0)+'% at or below'; }
      }}},
      scales:{x:{grid:{display:false},ticks:{color:muted,font:{size:10},maxRotation:45,minRotation:45,autoSkip:false},title:{display:true,text:pct?'trade result (% of notional)':'trade result ($)',color:muted,font:{size:11}}},
        y:{grid:{color:grid},border:{display:false},ticks:{color:muted,font:{size:11},precision:0},title:{display:true,text:'number of trades',color:muted,font:{size:11}}}}},
    plugins:[overlay]});
  explain(_diagCharts.dist,'How your trade results are spread: each bar counts trades in one range. Purple line: mean · blue dashed: median · grey: zero.');
  const caps={ shape:'<b>Repeatable edge</b>: same win rate, profit spread across more mid-sized winners. Where your green bars fall short near the middle and overshoot on the far right, that\'s outlier dependence to trim.',
    survival: sf?(pct
        ? `<b>Survival floor</b>: at your ${(sf.p*100).toFixed(0)}% win rate and ${sf.b.toFixed(2)} payoff, risking more than <b>${Math.abs(sf.floor).toFixed(1)}% of account per trade</b> exceeds a full-Kelly bet \u2014 the shaded zone is over-betting, whatever your size.`
        : `<b>Survival floor</b>: at your ${(sf.p*100).toFixed(0)}% win rate and ${sf.b.toFixed(2)} payoff, single losses beyond <b>${fmtUsd(sf.floor)}</b> exceed a full-Kelly bet on your ${fmtUsd(acct)} account \u2014 the shaded zone is over-betting territory.`)
      :(pct?'<b>Survival floor</b>: needs a positive edge to compute.':'<b>Survival floor</b>: needs a positive edge and a live account value to compute.'),
    best:'<b>Your best period</b>: the result shape of your strongest stretch, as a target to trade back toward. In-sample \u2014 aspiration, not proof.' };
  const on=['shape','survival','best'].filter(x=>_distState[x]);
  $('distCap').innerHTML = on.length? on.map(x=>caps[x]).join('<br>') : 'Toggle a target above. Hover any bar for its range, count, and share.';
  syncDistControls(closed,binW,isAuto);
}
function syncDistControls(closed,shownBinW,isAuto){
  const pct=_distState.mode==='pct';
  document.querySelectorAll('#distMode button').forEach(b=>{ b.classList.toggle('on',b.dataset.m===_distState.mode);
    b.onclick=()=>{ _distState.mode=b.dataset.m; renderDistribution(closed); }; });
  const unitEl=$('distBinUnit'); if(unitEl)unitEl.textContent=pct?'%':'$';
  const binIn=$('distBin');
  if(binIn){
    const custom=pct?_distState.binPct:_distState.binW;
    if(document.activeElement!==binIn) binIn.value = (custom&&custom>0) ? custom : '';
    binIn.placeholder = (isAuto&&shownBinW)?('auto '+(pct?shownBinW+'%':'$'+shownBinW)):'auto';
    binIn.step = pct?'0.05':'any';
    binIn.oninput=e=>{ const v=parseFloat(e.target.value);
      const val=(isFinite(v)&&v>0)?v:null;
      if(pct)_distState.binPct=val; else _distState.binW=val;
      clearTimeout(_distBinTimer); _distBinTimer=setTimeout(()=>renderDistribution(closed),260); };
  }
  document.querySelectorAll('.dtgt').forEach(b=>{ b.classList.toggle('on',_distState[b.dataset.k]);
    b.onclick=()=>{ _distState[b.dataset.k]=!_distState[b.dataset.k]; renderDistribution(closed); }; });
  $('distFill').checked=_distState.fill; $('distFill').onchange=e=>{ _distState.fill=e.target.checked; renderDistribution(closed); };
}
// Walk-forward per-block chart. Registered in _diagCharts so destroyDiagCharts() tears it down
// on every re-render like every other chart here -- a leaked Chart instance on a reused canvas id
// is what makes hover tooltips fire on stale data.
function wireWalkForward(wf){
  const el=$('wfChart'); if(!el||!wf||!wf.points||!wf.points.length)return;
  const P=wf.points;
  const labels=P.map(p=>fmtDate(p.t));
  const realized=P.map(p=>p.osExp);
  const predicted=P.map(p=>p.isExp);
  const mean=wf.wfExp!=null?P.map(()=>wf.wfExp):null;
  const ds=[{type:'bar',label:'realized (out-of-sample)',data:realized,
      backgroundColor:signCol(realized),borderRadius:3,maxBarThickness:44,order:3},
    {type:'line',label:'predicted by training window',data:predicted,borderColor:'#8a7bd8',
      borderWidth:1.5,borderDash:[5,4],pointRadius:2,pointHoverRadius:4,tension:0,fill:false,order:1}];
  if(mean) ds.push({type:'line',label:'walk-forward mean',data:mean,borderColor:TXT,
      borderWidth:1,borderDash:[2,3],pointRadius:0,pointHitRadius:0,tension:0,fill:false,order:2});
  _diagCharts.wf=new Chart(el,{data:{labels,datasets:ds},
    options:{responsive:true,maintainAspectRatio:false,interaction:{intersect:false,mode:'index'},
      plugins:{legend:{display:true,labels:{color:TXT,boxWidth:10,font:{size:11}}},
        tooltip:{
          filter:item=>item.dataset.label!=='walk-forward mean', // flat reference, identical every block
          callbacks:{
          title:items=>'Block '+(items[0].dataIndex+1)+' of '+P.length+' \u00b7 ends '+labels[items[0].dataIndex],
          label:c=>' '+c.dataset.label+': '+fmtUsd(c.parsed.y)+'/trade',
          footer:items=>{ const p=P[items[0].dataIndex]; const gap=p.isExp-p.osExp;
            return p.n+' trade'+(p.n===1?'':'s')+' scored \u00b7 '
              +(Math.abs(gap)<1e-9?'predicted exactly'
                :gap>0?fmtUsd(gap)+'/trade worse than predicted'
                      :fmtUsd(-gap)+'/trade better than predicted'); }}}},
      scales:scales()}});
  explain(_diagCharts.wf,'Each block is judged on trades the rule never saw: bars are what it really made, the dashed line what the training window promised.');
}
function destroyDiagCharts(){ Object.values(_diagCharts).forEach(c=>c&&c.destroy()); _diagCharts={}; }
// Snapshot the whole Diagnostic view — including any miner/excursion results already on
// screen — as one self-contained HTML file. Charts become embedded PNGs, interactive
// controls are stripped, and the app's own stylesheet is inlined so the report renders
// identically offline. Meant for archiving monthly reviews.
function exportReport(){
  const srcEl=$('diagView'); if(!srcEl||!srcEl.innerHTML)return;
  const clone=srcEl.cloneNode(true);
  const liveC=srcEl.querySelectorAll('canvas'), cloneC=clone.querySelectorAll('canvas');
  cloneC.forEach((c,i)=>{ try{
    const img=document.createElement('img'); img.src=liveC[i].toDataURL('image/png');
    img.style.cssText='width:100%;height:100%;object-fit:contain';
    c.parentNode.replaceChild(img,c);
  }catch(e){ c.remove(); } });
  clone.querySelectorAll('button,input,select,textarea,.viewtog').forEach(n=>n.remove());
  const css=[...document.querySelectorAll('style')].map(x=>x.textContent).join('\n');
  const periodDesc=rangeActive()
    ? 'custom range'+(customRange.from?' from '+fmtDate(customRange.from):'')+(customRange.to?' to '+fmtDate(customRange.to):'')
    : (period===0?'all time':'last '+period+' days');
  const wallets=settings.wallets.map(labelFor).join(', ')||'pasted data';
  const header=`<div style="margin-bottom:22px"><h1 style="margin:0 0 6px">Ledger — trading diagnostic</h1>
    <p class="lead" style="margin:0">${esc(wallets)} · ${esc(view)} · ${esc(periodDesc)} · generated ${esc(new Date().toLocaleString())} · timezone ${esc(tzLabel())}</p></div>`;
  const doc='<!doctype html><html><head><meta charset="utf-8"><title>Ledger report — '+new Date().toISOString().slice(0,10)+'</title>'
    +'<style>'+css+'</style></head><body class="'+esc(document.body.className)+'" style="padding:28px;max-width:1100px;margin:0 auto">'
    +header+clone.innerHTML+'</body></html>';
  const blob=new Blob([doc],{type:'text/html'});
  dlBlob(blob,'ledger-report-'+new Date().toISOString().slice(0,10)+'.html');
  setStatus('Report exported ('+(blob.size/1024/1024).toFixed(1)+' MB). Run the miner / excursions first if you want them included.');
}
/* ============================ what-if counterfactual UI ============================ */
let _wiChart=null, _wiFns=[], _wiSel=0;
// Builds the condition dropdown from the same miner families the pattern scan uses (so
// thresholds and names match exactly what the miner reported), runs whatIfModel on demand,
// and renders the side-by-side verdict plus an actual-vs-counterfactual equity chart.
function wireWhatIf(closed){
  const sel=$('wiCond'), btn=$('wiRun'), box=$('wiBox');
  if(!sel||!btn||!box)return;
  if(_wiChart){ try{_wiChart.destroy();}catch(e){} _wiChart=null; } // diag re-render replaced the canvas
  if(closed.length<10){ sel.parentElement.classList.add('hide'); box.innerHTML='<p class="lead">Needs \u226510 completed trades.</p>'; return; }
  const chron=[...closed].sort((a,b)=>a.closeTime-b.closeTime);
  let fams={}; try{ fams=minerFams(chron,tradeStates(chron)); }catch(e){}
  _wiFns=[]; const opts=[]; const fp=fams.__params||{};
  for(const f in fams) for(const [name,fn,cid] of fams[f]){
    let n=0; try{ n=chron.filter(fn).length; }catch(e){ continue; }
    if(n<3 || n>chron.length-3) continue; // nothing to learn from removing ~nothing or ~everything
    opts.push(`<option value="${_wiFns.length}">${esc(name)} \u00b7 ${n} trades</option>`);
    _wiFns.push({name,fn,cid,params:fp});
  }
  if(!opts.length){ box.innerHTML='<p class="lead">No condition matches between 3 trades and all-but-3 \u2014 more history needed.</p>'; btn.disabled=true; return; }
  btn.disabled=false;
  if(_wiSel>=_wiFns.length)_wiSel=0;
  sel.innerHTML=opts.join(''); sel.value=String(_wiSel);
  sel.onchange=()=>{ _wiSel=+sel.value; };
  btn.onclick=()=>{ const c=_wiFns[+sel.value]; if(!c)return;
    try{ renderWhatIf(chron,c.name,c.fn,c); }catch(e){ setErr('Replay failed: '+e.message); } };
}
function renderWhatIf(chron,name,pred,cond){
  const box=$('wiBox'); if(!box)return;
  const m=whatIfModel(chron,pred);
  if(!m.removed.n){ box.innerHTML='<p class="lead">No trades in this view match that condition.</p>'; return; }
  const mrow=(l,v,tip)=>`<div class="metric-row"${tip?` data-tip="${esc(tip)}"`:''}><span class="ml">${l}</span><span class="mv">${v}</span></div>`;
  const usd=v=>'<span class="'+cls(v)+'">'+fmtUsd(v)+'</span>';
  const pf=x=>x===Infinity?'\u221e':x.toFixed(2);
  const statCard=(title,st,tip)=>`<div class="diag-card"><h3${tip?` data-tip="${esc(tip)}"`:''}>${title}</h3>
    ${mrow('Trades',String(st.n))}
    ${mrow('Net PnL',usd(st.net))}
    ${mrow('Expectancy / trade',usd(st.expectancy))}
    ${mrow('Win rate',st.winRate==null?'\u2014':(st.winRate*100).toFixed(1)+'%')}
    ${mrow('Max drawdown',usd(st.maxDD))}
    ${mrow('Profit factor',pf(st.profitFactor))}
  </div>`;
  const dNet=m.kept.net-m.all.net, dDD=m.kept.maxDD-m.all.maxDD;
  const verdict=`<p class="lead" style="font-size:13px;margin:0 0 12px;border-left:2px solid var(--${dNet>=0?'profit':'loss'});padding-left:10px">Skipping <b>${esc(name)}</b> (${m.removed.n} trades) would have ${dNet>=0?'added':'cost'} <b>${fmtUsd(Math.abs(dNet))}</b> of net PnL${Math.abs(dDD)>1?` and made your worst drawdown ${dDD>0?'<b>'+fmtUsd(Math.abs(dDD))+'</b> shallower':'<b>'+fmtUsd(Math.abs(dDD))+'</b> deeper'}`:''}. ${dNet>0?'A hard rule (no-trade window, cooldown, filter) beats willpower here.':'These trades are pulling their weight \u2014 keep them.'}</p>`;
  const ruleBtn=(cond&&cond.cid&&dNet>0&&coachOn())
    ? (customRules().some(r=>r.pid===cond.cid)
      ? '<p class="mini-note" style="margin:-4px 0 12px">Already one of your rules \u2014 tracked under Discipline &amp; rules.</p>'
      : '<p style="margin:-4px 0 12px"><button class="btn ghost" id="wiRule" data-tip="Adds \u201cAvoid: '+esc(name)+'\u201d to your rules: past and future breaks get counted and priced, and the rules card shows whether you break it less from today on.">Make this a rule</button></p>')
    : '';
  box.innerHTML=`${verdict}${ruleBtn}
    <div class="diag-grid">
      ${statCard('As traded',m.all,'Your actual chronological closed-trade sequence in this view.')}
      ${statCard('Without \u201c'+esc(name)+'\u201d',m.kept,'The identical sequence with the matching trades removed \u2014 the equity curve you would have printed. Max drawdown is recomputed on the counterfactual curve, not scaled.')}
    </div>
    <div class="diag-card" style="margin-top:14px"><div style="height:240px"><canvas id="wiChart"></canvas></div>
      <p class="mini-note">Cumulative net PnL, trade by trade: solid = as traded; dashed = without \u201c${esc(name)}\u201d. Where the lines separate is exactly where the condition made or lost you money.</p></div>`;
  const rb=$('wiRule'); if(rb)rb.onclick=async()=>{ rb.disabled=true; rb.textContent='Rule added \u2713';
    await addCustomRule({pid:cond.cid,name:'Avoid: '+name,params:cond.params||{}}); renderGuardrails(); };
  if(_wiChart){ try{_wiChart.destroy();}catch(e){} _wiChart=null; }
  const labels=m.series.labels.map(t=>fmtDate(t));
  _wiChart=new Chart($('wiChart'),{type:'line',data:{labels,datasets:[
    {label:'as traded',data:m.series.actual,borderColor:themeGreen(),borderWidth:1.6,pointRadius:0,tension:.1,fill:false},
    {label:'without it',data:m.series.cf,borderColor:'#8a7bd8',borderWidth:1.6,borderDash:[5,4],pointRadius:0,tension:.1,fill:false}]},
    options:{responsive:true,maintainAspectRatio:false,interaction:{intersect:false,mode:'index'},
      plugins:{legend:{display:true,labels:{color:TXT,boxWidth:10,font:{size:11}}},
        tooltip:{callbacks:{label:c=>' '+c.dataset.label+': '+fmtUsd(c.parsed.y),
          afterBody:it=>{ const i=it[0].dataIndex, d=m.series.actual[i]-m.series.cf[i]; return [' Trade '+(i+1)+' · the condition '+(d>=0?'made':'cost')+' you '+fmtUsd(Math.abs(d))+' so far']; }}}},
      scales:scales()}});
  explain(_wiChart,'Solid: your real running total. Dashed: the same trades without the ones matching this condition.');
}
/* ============================ forward pattern tracker ============================ */
// Patterns pinned from the miner are re-measured on ONLY trades closed after the pin —
// true out-of-sample confirmation. Thresholds are frozen at pin time (pin.params) so the
// hypothesis being tested forward is exactly the one that was discovered, even as new
// trades shift the live quartiles. Condition identity is the stable pid, not the display name.
// a pin restored or synced without its discovery stats (an old backup, a hand edit) is skipped, not a crash
function pinsList(){ return Array.isArray(settings.pins)?settings.pins.filter(p=>p&&p.disc&&typeof p.disc==='object'&&isFinite(p.disc.exp)&&p.disc.n>0):[]; }
function resolvePinPred(pin,closed,ST){
  if(!pin||typeof pin.pid!=='string')return null;
  const fams=minerFams(closed,ST,pin.params||{});
  const map={}; for(const f in fams) for(const [nm,fn,cid] of fams[f]) if(cid)map[cid]=fn;
  const one=id=>{
    if(map[id])return map[id];
    // value-carrying conditions can drop out of the top-N family slices as data shifts;
    // rebuild them directly from the id so old pins never go unresolvable.
    if(/^ck:/.test(id))return checkinPred(id);
    const m=id.match(/^(mkt|setup|tag):([\s\S]*)$/);
    if(m){ const val=m[2];
      if(m[1]==='mkt')return t=>(t.symbol||dcoin(t))===val;
      if(m[1]==='setup')return t=>(journal[t.id]||{}).setup===val;
      if(m[1]==='tag')return t=>(((journal[t.id]||{}).tags)||[]).includes(val);
    }
    return null; };
  const fns=pin.pid.split('&').map(one);
  if(fns.some(f=>!f))return null;
  return fns.length===1?fns[0]:(t=>fns.every(f=>f(t)));
}
async function addPin(v,basis,famParams){
  const pins=Array.isArray(settings.pins)?settings.pins:[]; // all of them, including any the list skips
  if(pins.some(p=>p&&p.pid===v.pid&&p.basis===basis))return false;
  pins.push({pid:v.pid,name:v.name,basis,params:famParams||{},pinnedAt:Date.now(),
    disc:{exp:v.exp,n:v.n,uplift:v.uplift,ci:(v.ci&&isFinite(v.ci[0])&&isFinite(v.ci[1]))?[v.ci[0],v.ci[1]]:null}});
  settings.pins=pins; await Store.set(S_KEY,settings); return true;
}
// Tiny inline SVG sparkline of the forward rolling expectancy vs the discovery band floor.
// No Chart.js instance — these rows re-render often and must not leak chart lifecycles.
function decaySparkSvg(roll, bandLo, healthy){
  if(!roll||roll.length<2)return '';
  const W=220,H=26,P=2;
  const vals=roll.concat([bandLo]).filter(v=>isFinite(v));
  let mn=Math.min(...vals), mx=Math.max(...vals);
  if(mx-mn<1e-9){mx+=1;mn-=1;}
  const pad=(mx-mn)*0.12; mn-=pad; mx+=pad;
  const X=i=>P+(W-2*P)*i/(roll.length-1), Y=v=>H-P-(H-2*P)*(v-mn)/(mx-mn);
  const pts=roll.map((v,i)=>X(i).toFixed(1)+','+Y(v).toFixed(1)).join(' ');
  const by=Y(bandLo).toFixed(1);
  const tip='Since you pinned it: the solid line is the average per trade on new trades only (rolling); the dashed line is the bottom of the range the pattern showed when it was found. '+(healthy?'Holding up so far.':'Below or near the floor: the edge may be fading.');
  return '<svg width="'+W+'" height="'+H+'" viewBox="0 0 '+W+' '+H+'" style="display:block;margin-top:5px" aria-hidden="true" data-tip="'+esc(tip)+'">'
    +'<line x1="'+P+'" y1="'+by+'" x2="'+(W-P)+'" y2="'+by+'" stroke="var(--faint)" stroke-width="1" stroke-dasharray="3,3"/>'
    +'<polyline points="'+pts+'" fill="none" stroke="'+(healthy?'var(--muted)':'var(--lbl)')+'" stroke-width="1.4"/></svg>';
}
function trackedSectionHtml(closed){
  const pins=pinsList(); if(!pins.length)return '';
  const chron=[...closed].sort((a,b)=>a.closeTime-b.closeTime);
  const ST=tradeStates(chron);
  const rowOf=(pin,i)=>{
    const pred=resolvePinPred(pin,chron,ST);
    const fA=pin.basis==='pct'?(x=>(x>=0?'+':'')+x.toFixed(2)+'%'):(x=>(x>=0?'+':'')+fmtUsd(x));
    let body,badge,spark='',extraBtn='';
    if(!pred){ body='condition can\u2019t be resolved on the current data'; badge='<span class="sr-note">unresolved</span>'; }
    else{
      const fwd=chron.filter(t=>t.closeTime>pin.pinnedAt&&pred(t)&&(pin.basis!=='pct'||retPct(t)!==null));
      const n=fwd.length;
      if(n<8){ body=`collecting forward trades \u2014 <b>${n}</b> so far (verdict at 8) \u00b7 discovered at <b>${fA(pin.disc.exp)}</b>/trade over ${pin.disc.n} trades`; badge='<span class="sr-note">collecting</span>'; }
      else{
        const Vv=pin.basis==='pct'?(t=>retPct(t)):(t=>t.net);
        const fe=_avg(fwd.map(Vv));
        const same=pin.disc.exp===0?fe>=0:Math.sign(fe)===Math.sign(pin.disc.exp);
        const strong=same&&Math.abs(fe)>=Math.abs(pin.disc.exp)*0.5;
        badge=strong?'<span class="badge ok">holding forward</span>':same?'<span class="badge mid">weakening</span>':'<span class="badge no">not holding</span>';
        body=`<b>${n}</b> forward trades at <b>${fA(fe)}</b>/trade, vs <b>${fA(pin.disc.exp)}</b>/trade when discovered (${pin.disc.n} trades)`;
        // decay layer: rolling-band + CUSUM verdict on the same forward trades
        const dz=decayAssess(fwd.map(Vv), pin.disc);
        if(dz.status!=='collecting'){
          const dTip={healthy:'Rolling forward expectancy sits inside the discovery band and cumulative drift (CUSUM) is quiet \u2014 the pinned edge is behaving as discovered.',
            degrading:'Either the trailing rolling expectancy has slipped below the discovery band floor for '+dz.trailing+' straight trades, or CUSUM drift vs the discovered per-trade edge has tripped (stat '+dz.cusum.stat.toFixed(2)+', trip at 4). One detector alone \u2014 watch, size down, or re-test.',
            dead:'Both the rolling band and CUSUM drift have tripped (or the forward edge outright flipped over \u226515 trades). The pinned hypothesis is not paying anymore \u2014 archive it or re-run the miner on recent data.'}[dz.status];
          badge+=' <span class="badge '+(dz.status==='healthy'?'ok':dz.status==='degrading'?'mid':'no')+'" data-tip="'+dTip+'">'+dz.status+'</span>';
          body+=` \u00b7 CUSUM ${dz.cusum.stat.toFixed(2)}${dz.trailing?` \u00b7 ${dz.trailing} below band`:''}`;
          spark=decaySparkSvg(dz.roll, dz.bandLo, dz.status==='healthy');
          if(dz.status==='dead')extraBtn=`<button class="btn ghost pin-arch" data-pi="${i}" style="font-size:10px;padding:1px 7px;margin-left:6px" data-tip="Keeps the pin and its history, but moves it out of the active list. Nothing is deleted.">archive</button>`;
        }
      }
    }
    if(pin.archived)extraBtn=`<button class="btn ghost pin-arch" data-pi="${i}" style="font-size:10px;padding:1px 7px;margin-left:6px">restore</button>`;
    return `<div class="state-row"${pin.archived?' style="opacity:.55"':''}><div class="sr-top"><span class="sr-name">${esc(pin.name)} <span style="color:var(--faint);font-size:10.5px">judged in ${pin.basis==='pct'?'%':'$'}</span></span><span style="white-space:nowrap">${badge}${extraBtn} <button class="btn ghost unpin" data-pi="${i}" style="font-size:10px;padding:1px 7px;margin-left:6px">unpin</button></span></div><div class="sr-sub">pinned ${fmtDate(pin.pinnedAt)} \u00b7 ${body}</div>${spark}</div>`;
  };
  const rows=pins.map((pin,i)=>pin.archived?'':rowOf(pin,i)).join('');
  const archRows=pins.map((pin,i)=>pin.archived?rowOf(pin,i):'').join('');
  const archHtml=archRows?`<h3 style="margin-top:14px" data-tip="Pins archived after going dead. Kept for the audit trail; restore to resume forward scoring in the active list.">Archived patterns</h3>${archRows}`:'';
  return `<div class="diag-section"><div class="diag-card" id="trackedCard"><h3 data-tip="Patterns you pinned from the miner, re-measured on ONLY the trades closed after you pinned them \u2014 a rolling out-of-sample test. Thresholds (size quartiles, hold cutoffs, MAE bands) are frozen at pin time so you keep testing the exact hypothesis you pinned. \u2018Holding\u2019 = same direction and at least half the discovered edge; verdicts start at 8 forward trades and sharpen as more arrive. The second badge is the decay verdict: rolling forward expectancy vs the frozen discovery confidence band, plus a CUSUM drift statistic \u2014 healthy / degrading / dead.">Tracked patterns \u2014 forward test</h3>${rows}${archHtml}</div></div>`;
}
// Per-setup scorecards: is each named setup improving or rotting? The miner finds setups
// that work; this is the follow-through on its own caveat ("trade deliberately and
// re-test") — a per-setup equity curve plus an early-vs-recent expectancy split. Pure.
function setupScorecards(closed, journalObj){
  const by={};
  for(const t of closed){ const s=(journalObj[t.id]||{}).setup; if(s)(by[s]=by[s]||[]).push(t); }
  const cards=[];
  for(const name in by){
    const ts=by[name].sort((a,b)=>a.closeTime-b.closeTime);
    if(ts.length<5)continue;
    const nets=ts.map(t=>t.net);
    let cum=0; const curve=nets.map(n=>+(cum+=n).toFixed(6));
    const cut=Math.max(1,Math.floor(ts.length*2/3)); // discovery 2/3 vs recent 1/3
    const early=nets.slice(0,cut), late=nets.slice(cut);
    const eE=_avg(early), eL=late.length?_avg(late):null;
    const wins=ts.filter(t=>isWin(t.net)).length, losses=ts.filter(t=>isLoss(t.net)).length;
    cards.push({name, n:ts.length, net:+cum.toFixed(2), expectancy:_avg(nets),
      winRate:(wins+losses)?wins/(wins+losses):null, earlyExp:eE, lateExp:eL,
      trend: eL==null?null
        : (eE<0&&eL<0)?(eL<eE?'worsening':'negative')     // never made money — say so, don't call it "fading"
        : (eL<0&&eE>=0)?'flipped'
        : (eL>=0&&eE<0)?'recovered'
        : eL>=eE?'improving':'fading',
      curve, lastAt:ts[ts.length-1].closeTime});
  }
  return cards.sort((a,b)=>Math.abs(b.net)-Math.abs(a.net)).slice(0,6);
}
function setupSectionHtml(closed){
  const cards=setupScorecards(closed,journal);
  if(!cards.length)return '';
  const badge=c=>c.trend==='improving'?'<span class="badge ok" data-tip="Average net per trade over the most recent third beats the earlier two-thirds.">improving</span>'
    :c.trend==='fading'?'<span class="badge mid" data-tip="Recent-third expectancy is below the earlier two-thirds — still positive, but decaying. Re-test before sizing up.">fading</span>'
    :c.trend==='flipped'?'<span class="badge no" data-tip="Recent-third expectancy went NEGATIVE after a positive start. Treat this setup as unproven again.">flipped negative</span>'
    :c.trend==='recovered'?'<span class="badge mid" data-tip="Lost money in discovery, positive over the recent third. A young turnaround — small-sample caution applies.">recovering</span>'
    :c.trend==='worsening'?'<span class="badge no" data-tip="Negative in discovery and worse recently. Nothing here to keep yet.">worsening</span>'
    :c.trend==='negative'?'<span class="badge no" data-tip="Negative throughout. This is a leak wearing a setup name.">negative throughout</span>':'';
  const row=c=>`<div class="metric-row"><span class="ml"><b>${esc(c.name)}</b> ${badge(c)}</span>
    <span class="mv">${c.n} trades · <span class="${c.net>=0?'pos-t':'loss'}">${fmtUsd(c.net)}</span> · ${fmtUsd(c.expectancy)}/trade${c.winRate!=null?' · '+Math.round(c.winRate*100)+'% wr':''} · recent ${c.lateExp!=null?fmtUsd(c.lateExp):'—'} vs early ${fmtUsd(c.earlyExp)}</span></div>`;
  return `<div class="diag-section">
    <h2>Setup scorecards <span style="font-size:11px;color:var(--faint);font-weight:400">per-setup equity · early vs recent expectancy · needs journaled setups</span></h2>
    <p class="lead">Every named setup from your journal, tracked as its own little strategy: cumulative equity per setup and whether the most recent third of its trades still performs like the two-thirds it was "discovered" on. This is the working answer to the miner's own caveat — validated patterns are hypotheses to re-test, and this card is the re-test.</p>
    <div class="diag-card">
      <div style="height:240px"><canvas id="setupCurves"></canvas></div>
      <div style="margin-top:12px">${cards.map(row).join('')}</div>
      <p class="mini-note">X-axis is each setup's own trade count, so young and old setups are comparable by shape. In-sample; a setup under ~20 trades is a sketch, not a track record.</p>
    </div>
  </div>`;
}
// Capital & true return — deposits/withdrawals/transfers from the exchange ledger turn PnL
// into a percentage that means something. Capital is account-wide, so this card always uses
// ALL closed trades (every market, full history), independent of the view/period filters,
// and says so. Renders nothing when no flows were fetched (pasted data, fetch failure).
function capitalSectionHtml(){
  if(!ledFlows.length)return '';
  const allClosed=allTrades.filter(t=>!t.isOpen&&t.closeTime);
  const equityNow=(accountValue!=null||spotAccountValue!=null)?((accountValue||0)+(spotAccountValue||0)):null;
  const m=capitalModel(ledFlows,allClosed,equityNow);
  if(!m)return '';
  const mrow=(l,v,tip)=>`<div class="metric-row"${tip?` data-tip="${esc(tip)}"`:''}><span class="ml">${l}</span><span class="mv">${v}</span></div>`;
  const pctS=x=>x==null?'—':((x>=0?'+':'')+(x*100).toFixed(1)+'%');
  const cls=v=>v>=0?'pos-t':'loss';
  return `<div class="diag-section">
    <h2>Capital &amp; true return <span style="font-size:11px;color:var(--faint);font-weight:400">from the exchange ledger · all markets, full history</span></h2>
    <p class="lead">Deposits, withdrawals and transfers from your on-exchange ledger. This is the missing denominator: PnL divided by the capital that was actually at risk, not by position notional. Account-wide by nature, so this card ignores the view/period filters.</p>
    <div class="diag-grid">
      <div class="diag-card"><h3 data-tip="What crossed the boundary of your trading account: external deposits and withdrawals, vault parks, and transfers between accounts. A transfer between two loaded wallets nets to zero here, as it should.">Capital flows</h3>
        ${mrow('Net deposited',fmtUsd(m.netDeposited),'Deposits minus withdrawals to date — the capital currently attributable to the account(s).')}
        ${mrow('Total in / out',fmtUsd(m.totIn)+' / '+fmtUsd(m.totOut),'Lifetime gross deposits and gross withdrawals.')}
        ${mrow('Peak capital',fmtUsd(m.maxCapital),'Highest net-deposited level ever reached.')}
        ${mrow('Avg capital employed',fmtUsd(m.avgCapital),'Time-weighted average of net deposits over the whole span — the honest denominator when capital moved mid-history.')}
        ${mrow('Flow mix',(()=>{ const mix={}; for(const f of ledFlows){ const g=(f.type==='deposit'||f.type==='withdraw')?'external':(String(f.type).indexOf('vault')===0?'vault':'transfers'); mix[g]=(mix[g]||0)+f.usdc; }
          const ps=Object.entries(mix).map(([g,v])=>esc(g)+' <span class="'+cls(v)+'">'+fmtUsd(v)+'</span>'); return ps.length?ps.join(' · '):'—'; })(),'Net contribution by flow type: external deposits/withdrawals, vault parks and returns, cross-account transfers.')}
        ${mrow('Flows',m.n+(ledSkipped?' · <span class="loss">'+ledSkipped+' unclassified skipped</span>':''),'Ledger entries classified as capital flows. Unclassified entries (unknown types) are excluded and counted here rather than silently mixed in.')}
      </div>
      <div class="diag-card"><h3 data-tip="Realized net over the flow-covered span divided by time-weighted average capital. This is the number to compare against any other use of the same money.">Return on capital</h3>
        ${mrow('Realized net (span)','<span class="'+cls(m.realized)+'">'+fmtUsd(m.realized)+'</span>',m.nTrades+' closed trades since the first recorded flow.')}
        ${mrow('Return on avg capital','<span class="'+cls(m.roc||0)+'">'+pctS(m.roc)+'</span>','Realized net ÷ time-weighted average capital.')}
        ${mrow('Annualized',m.rocAnnual!=null?'<span class="'+cls(m.rocAnnual)+'">'+pctS(m.rocAnnual)+'</span>':'—','Geometric annualization of the same figure. Shown only once the span exceeds ~18 days; in-sample, edges drift.')}
        ${mrow('Max drawdown vs capital',m.maxDDpctCap!=null?'<span class="loss">'+pctS(m.maxDDpctCap)+'</span>':'—','Worst realized peak-to-trough dip as a share of the capital present at the trough ('+fmtUsd(m.maxDD$)+'). The % your account actually felt, not % of notional.')}
        ${(()=>{ const x=xirrFromFlows(ledFlows,equityNow); if(x==null)return '';
          const disp=x<=-0.9999?'&lt;−99.99%':x>=10?'&gt;+1000%':pctS(x);
          return mrow('Money-weighted (XIRR)','<span class="'+cls(x)+'">'+disp+'</span> /yr','Annualized return of YOUR dollars: solves the cash-flow equation of every dated deposit/withdrawal against live equity, weighting each period by the capital actually deployed. Clamped labels mark rates beyond the solver’s range. The time-weighted figure above grades the strategy; this grades the account.'); })()}
        ${m.impliedPnl!=null?mrow('Implied all-time PnL','<span class="'+cls(m.impliedPnl)+'">'+fmtUsd(m.impliedPnl)+'</span>','Live equity ('+fmtUsd(m.equityNow)+') minus net deposited — the account’s own all-time accounting, unrealized and untracked history included. If this diverges far from realized net, history beyond the fill cache or unrealized PnL is the difference.'):''}
      </div>
    </div>
  </div>`;
}
// Behavioral signals behind the plain-language findings — shared by the Diagnostic view
// and the dashboard coach so both always say the same thing. Pure given (closed, stats).
function behaviorSignals(closed, s){
  // cost drag: fees as % of gross realized profit (before fees/funding)
  const grossReal = s.net + s.fees - s.fund; // undo costs
  const costDragPct = grossReal>0 ? s.fees/grossReal : null;

  // oversizing
  const f=sizeBucketFn(closed); const sz={}; closed.forEach(t=>{const k=f(t);(sz[k]=sz[k]||{n:0,net:0});sz[k].n++;sz[k].net+=t.net;});
  const big=sz['largest 25%'], small=sz['smallest 25%'];
  const bigExp=big?big.net/big.n:null, smallExp=small?small.net/small.n:null;
  const oversizing=(bigExp!=null&&smallExp!=null&&bigExp<smallExp);
  // mistake flags
  const flagged=closed.filter(t=>{const j=journal[t.id]||{};return j.mistakes&&j.mistakes.length;});
  const clean=closed.filter(t=>{const j=journal[t.id]||{};return !(j.mistakes&&j.mistakes.length);});
  const flagExp=flagged.length?flagged.reduce((x,t)=>x+t.net,0)/flagged.length:null;
  const cleanExp=clean.length?clean.reduce((x,t)=>x+t.net,0)/clean.length:null;
  const mistakeCost=(flagExp!=null&&cleanExp!=null)?(cleanExp-flagExp):null;
  // rating calibration
  const rb=bucketize(closed,'rating').filter(b=>/^★/.test(b.key)).sort((a,b)=>a.key.length-b.key.length);
  let ratingMono=null; if(rb.length>=2){ ratingMono=true; for(let i=1;i<rb.length;i++) if(rb[i].expectancy<rb[i-1].expectancy){ratingMono=false;break;} }
  // concentration
  const mkts=bucketize(closed,'market'); const topMkt=[...mkts].sort((a,b)=>b.net-a.net)[0];
  const absTot=mkts.reduce((x,b)=>x+Math.abs(b.net),0)||1; const conc=topMkt?topMkt.net/absTot:0;

  // --- behavioral: disposition effect (hold winners vs losers) ---
  const wHold=closed.filter(t=>isWin(t.net)&&t.durationMs>0).map(t=>t.durationMs);
  const lHold=closed.filter(t=>isLoss(t.net)&&t.durationMs>0).map(t=>t.durationMs);
  const avgWHold=wHold.length?_avg(wHold):null, avgLHold=lHold.length?_avg(lHold):null;
  const disposition=(avgWHold!=null&&avgLHold!=null&&avgLHold>avgWHold*1.25);
  // --- tilt: trades opened soon after a loss ---
  const TILT_WIN=60*60000; const byClose=[...closed].filter(t=>t.closeTime).sort((a,b)=>a.closeTime-b.closeTime);
  const _ct=byClose.map(p=>p.closeTime);
  function priorClose(t){ let lo=0,hi=_ct.length-1,idx=-1;
    while(lo<=hi){ const m=(lo+hi)>>1; if(_ct[m]<=t.openTime){idx=m;lo=m+1;} else hi=m-1; }
    while(idx>=0){ if(byClose[idx].id!==t.id) return byClose[idx]; idx--; } return null; }
  const afterLoss=closed.filter(t=>{ const p=priorClose(t); return p&&isLoss(p.net)&&(t.openTime-p.closeTime)<=TILT_WIN; });
  const afterLossExp=afterLoss.length?afterLoss.reduce((x,t)=>x+t.net,0)/afterLoss.length:null;
  const tilt=(afterLoss.length>=5 && afterLossExp!=null && afterLossExp<s.expectancy);
  // --- overtrading: high-count days vs the rest ---
  const byDay={}; closed.forEach(t=>{const k=tzMidnight(t.closeTime);(byDay[k]=byDay[k]||{n:0,net:0});byDay[k].n++;byDay[k].net+=t.net;});
  const dayArr=Object.values(byDay); const dCounts=dayArr.map(d=>d.n);
  const dThr=Math.max(_avg(dCounts)+_std(dCounts), _avg(dCounts)+1);
  const hiDays=dayArr.filter(d=>d.n>=dThr), loDays=dayArr.filter(d=>d.n<dThr);
  const hiExp=hiDays.reduce((x,d)=>x+d.net,0)/(hiDays.reduce((x,d)=>x+d.n,0)||1);
  const loExp=loDays.reduce((x,d)=>x+d.net,0)/(loDays.reduce((x,d)=>x+d.n,0)||1);
  const overtrading=(hiDays.length>=3 && loDays.length>=3 && hiExp<loExp);
  // --- profit quality / fragility ---
  const sortedByNet=[...closed].sort((a,b)=>b.net-a.net);
  const grossPos=closed.filter(t=>isWin(t.net)).reduce((x,t)=>x+t.net,0)||1;
  const topK=Math.max(1,Math.round(closed.length*0.1));
  const topShare=sortedByNet.slice(0,topK).reduce((x,t)=>x+Math.max(0,t.net),0)/grossPos;
  const netNoBest=s.net-(sortedByNet[0]?sortedByNet[0].net:0);
  const fragile=(topShare>0.5);
  return {grossReal,costDragPct,big,small,bigExp,smallExp,oversizing,flagged,clean,flagExp,cleanExp,mistakeCost,ratingMono,mkts,topMkt,conc,avgWHold,avgLHold,disposition,priorClose,afterLoss,afterLossExp,tilt,dayArr,hiDays,loDays,hiExp,loExp,overtrading,topShare,netNoBest,fragile};
}
function renderDiagnostic(closed, allv){
  destroyDiagCharts();
  const diagSeed=_hashSeed('diag|'+closed.length+'|'+(closed.length?closed[0].id+'|'+closed[closed.length-1].id:''));
  _srand(diagSeed);
  const el=$('diagView');
  if(!closed.length){ el.innerHTML='<div class="verdict"><div class="grade">No completed trades in this view</div><p>Switch the Perps / Spot / Combined toggle or widen the period, then re-open Diagnostic.</p></div>'; return; }
  const s=computeStats(closed, allv), N=closed.length;
  const pct=x=>(x*100).toFixed(0)+'%';
  const {strong,weak,MIN}=diagScan(closed);
  const stab=splitStability(closed);

  // trade-level edge significance (distribution-free bootstrap + parametric t-test on per-trade net)
  const nets=closed.map(t=>t.net);
  const chronNets=[...closed].sort((a,b)=>a.closeTime-b.closeTime).map(t=>t.net);
  const B = N>3000?800:2000, MCI = N>3000?500:1500;
  // Monte Carlo (bootstrap CI + shuffle/forward drawdown, up to ~4k iterations) is memoized
  // on the closed set's identity: it used to re-run synchronously on the main thread on
  // EVERY Diagnostic render — including each journal save while the tab was open. The PRNG
  // is seeded from the same identity above, so cached values equal recomputed ones exactly.
  const mcKey=[N,closed.length?closed[0].id:'',closed.length?closed[closed.length-1].id:'',s.net,_be].join('|');
  let boot,esig,mcdd,fdd,mcPending=false;
  const _mcSync=()=>{ // one synchronous compute — small accounts, and the fallback when the worker is unavailable
    _srand(diagSeed);
    const b2=nets.length>=5?bootstrapMeanCI(nets,B):null;
    const e2=nets.length>=5?edgeSignificance(nets):null;
    const m2=chronNets.length>=5?mcMaxDD(chronNets,MCI):null;
    const HZ=Math.min(200,Math.max(50,N));
    const f2=chronNets.length>=10?fwdMaxDD(chronNets,HZ,N>3000?400:800):null;
    return {key:mcKey,boot:b2,esig:e2,mcdd:m2,fdd:f2};
  };
  if(_diagMC.key===mcKey){ ({boot,esig,mcdd,fdd}=_diagMC); }
  else if(N<1500){ _diagMC=_mcSync(); ({boot,esig,mcdd,fdd}=_diagMC); }
  else{
    // big accounts: the Monte Carlo batch (up to ~4k iterations) goes to the worker so the
    // first Diagnostic render doesn't block the main thread; the affected panels show
    // their empty states until the results land (~1s), then the tab re-renders once.
    // Seed + compute order match the sync path exactly, so the values are identical.
    boot=esig=mcdd=fdd=null; mcPending=true;
    if(_diagMC.pending!==mcKey){
      _diagMC.pending=mcKey;
      runInWorker('diagmc',{nets,chron:chronNets,seed:diagSeed,B,MCI,HZN:Math.min(200,Math.max(50,N)),FI:N>3000?400:800,be:_be})
        .then(out=>{ _diagMC={key:mcKey,...out};
          if(activeTab==='diag')renderDiagnostic(periodTrades(),periodTradesAll()); })
        .catch(()=>{ _diagMC=_mcSync();
          if(activeTab==='diag')renderDiagnostic(periodTrades(),periodTradesAll()); });
    }
  }
  const skew = _skew(nets);
  const acf1 = _autocorr1(chronNets);
  const cdd = chronNets.length? currentDD(chronNets) : null;
  const chronT=[...closed].sort((a,b)=>a.closeTime-b.closeTime);
  const uw = underwaterStats(chronT);
  const HZN = Math.min(200,Math.max(50,N));
  // sample adequacy
  const adeq = N<30?['no','far too few — anecdotal only']:N<100?['mid','preliminary — directional only']:N<300?['mid','moderate — trends emerging']:['ok','reasonable for stable estimates'];
  const shRel = s.sharpe==null?'—':(s.sharpeLo>1?'distinguishable from 1.0 ✓':s.sharpeLo>0?'positive, but band too wide to distinguish from ~1':'band includes 0 — not distinguishable from no edge');
  const _sig=behaviorSignals(closed,s);
  const {grossReal,costDragPct,big,small,bigExp,smallExp,oversizing,flagged,clean,flagExp,cleanExp,mistakeCost,ratingMono,mkts,topMkt,conc,avgWHold,avgLHold,disposition,priorClose,afterLoss,afterLossExp,tilt,dayArr,hiDays,loDays,hiExp,loExp,overtrading,topShare,netNoBest,fragile}=_sig;
  // --- Kelly / optimal sizing (risk fraction per trade) ---
  const kelly=(s.payoff>0&&s.payoff!==Infinity&&s.winRate>0)?(s.winRate-(1-s.winRate)/s.payoff):null;
  // --- run-rate ---
  const runRate=(s.sharpeN>0)?s.net/s.sharpeN*365:null;
  const perDay=(s.sharpeN>0)?s.net/s.sharpeN:null;

  // recommendations: plain-language finding cards (shared with the dashboard coach)
  let findings=[];
  try{ findings=buildFindings(closed,s,{boot,esig,mcdd,cdd,uw,skew,acf1,scan:{strong,weak},sig:_sig}); }catch(e){ console.warn('findings failed',e); }

  // verdict
  const edgeSharpe=s.sharpeLo!=null&&s.sharpeLo>0;
  const edgeTrade=boot&&boot.lo>0;
  const profitable=s.net>0, edgeProven=edgeSharpe||edgeTrade;
  const grade = (profitable&&edgeProven&&N>=100)?'Positive edge — statistically supported'
    : (profitable&&edgeProven)?'Positive edge — limited sample'
    : profitable?'Profitable, but not yet distinguishable from noise'
    : 'Net negative — no demonstrated edge';
  const verdictText=`${fmtUsd(s.net)} net over ${N} completed trades and ${s.sharpeN||0} calendar days. `+
    `Expectancy ${fmtUsd(s.expectancy)}/trade${boot?` (95% CI ${fmtUsd(boot.lo)} to ${fmtUsd(boot.hi)}${boot.lo>0?' — significant':' — spans zero, not yet proven'})`:''}. `+
    `Sharpe ${s.sharpe!=null?s.sharpe.toFixed(2):'—'}${s.sharpe!=null?` (CI ${s.sharpeLo.toFixed(1)}–${s.sharpeHi.toFixed(1)})`:''}, `+
    `profit factor ${s.profitFactor===Infinity?'∞':s.profitFactor.toFixed(2)}, win rate ${pct(s.winRate)}. Net of all fees and funding, in-sample (not walk-forward).`;

  const li=(cls,mk,txt)=>`<li class="${cls}"><span class="mk">${mk}</span><span>${txt}</span></li>`;
  const sgn=n=>(n>=0?'+':'')+fmtUsd(n);
  const sigTag=b=>b.sig?'<span class="badge ok" style="margin-left:6px" data-tip="Clears a Benjamini-Hochberg FDR gate (q<0.10) across every bucket scanned — significant after correcting for how many conditions were tested, not just a high sample-weighted score.">confirmed</span>':'<span class="sr-note" style="margin-left:6px" data-tip="Ranks high on expectancy×√n but does not clear the FDR gate once every scanned bucket is accounted for. Treat as a lead to re-test, not a proven edge — cross-check in the miner.">unconfirmed</span>';
  const diagRow=b=>`<b>${esc(humanBucket(b.dim,b.key))}</b>${sigTag(b)} — ${b.n} trades, ${pct(b.winRate)} winners, averaging <b>${sgn(b.expectancy)} each</b> (${sgn(b.net)} total)`;
  const strongHtml = strong.length?strong.map(b=>li('good','▲',diagRow(b))).join(''):li('warn','·',`No pattern clears the ${MIN}-trade bar yet.`);
  const weakHtml = weak.length?weak.map(b=>li('bad','▼',diagRow(b))).join(''):li('warn','·',`No losing pattern clears the ${MIN}-trade bar — good sign.`);

  const stabOK=stab.early.n>=10&&stab.recent.n>=10;
  // "60% of the earlier edge" only means something when there was an edge: with negative numbers the
  // ratio flips (an improvement from −100 to −70 used to read as decay)
  const stabState=!stabOK?null:stab.early.exp>0?(stab.recent.exp>=stab.early.exp*0.6?'holding':'decaying'):stab.recent.exp>0?'improving':'none';
  const STAB={holding:['ok','holding','Edge is holding into your recent trades.'],decaying:['no','decaying','Recent expectancy is well below earlier — possible edge decay; investigate before sizing up.'],
    improving:['ok','improving','No edge in your earlier trades, a positive one recently — promising; let it build more trades before sizing up.'],
    none:['mid','no edge yet','Neither half shows a positive edge yet'+(stab.recent.exp>stab.early.exp?', though the recent half is less negative.':'.')]};
  const stabTxt=stabOK
    ? `Earlier half: ${fmtUsd(stab.early.exp)}/trade, ${pct(stab.early.wr)} win. Recent half: ${fmtUsd(stab.recent.exp)}/trade, ${pct(stab.recent.wr)} win. ${STAB[stabState][2]}`
    : 'Too few trades to split earlier-vs-recent reliably.';

  const mrow=(l,v,tip)=>`<div class="metric-row"${tip?` data-tip="${esc(tip)}"`:''}><span class="ml">${l}</span><span class="mv">${v}</span></div>`;
  const kellyTxt = kelly==null?'—':kelly<=0?'0% — no positive edge to size':`risk ~${pct(Math.max(0,kelly))} · half-Kelly ~${pct(Math.max(0,kelly)/2)}`;
  // --- walk-forward reality: the honest out-of-sample counterpart to the in-sample verdict ---
  _srand(_hashSeed('wf:'+closed.length));
  const wf = walkForward(closed);
  const wfHtml = (()=>{
    if(!wf) return '';
    const fA=x=>x==null?'—':(x>=0?'+':'')+fmtUsd(x);
    const wfCls=wf.wfExp>0?'ok':(wf.wfExp<0?'no':'mid');
    const ciTxt=wf.wfCI?`${fmtUsd(wf.wfCI.lo)} to ${fmtUsd(wf.wfCI.hi)}`:'need ≥8 out-of-sample trades';
    // retention = wfExp / fullIS, so a negative walk-forward expectancy against a positive
    // in-sample one yields a negative ratio. "-62% of in-sample kept" is meaningless; say what
    // actually happened instead.
    const retTxt = wf.retention==null ? '\u2014'
      : wf.retention<=0 ? '<span class="badge no">none \u2014 forward edge is negative</span>'
      : `<span class="badge ${wf.retention>=0.6?'ok':'mid'}">${(wf.retention*100).toFixed(0)}% of in-sample kept</span>`;
    // Per-block chart, wired after paint by wireWalkForward(). This replaced a hand-rolled inline
    // SVG sparkline that used preserveAspectRatio="none" over a min-120 viewBox: with a handful of
    // blocks that stretched x by ~10x and y by 1x, so bars rendered as 210px slabs and any block
    // under ~5% of the max collapsed to a 0.6px hairline. It also showed only the realized number,
    // which buries the actual argument -- the gap between what each trailing window PREDICTED and
    // what the next block DELIVERED is the whole point, so both are plotted now.
    const spark=`<div style="height:180px;margin-top:12px"><canvas id="wfChart"></canvas></div>
      <p class="mini-note" style="margin-top:6px">Bars are what each out-of-sample block actually delivered; the dashed line is what its trailing training window predicted beforehand. The gap between them, block by block, is your in-sample optimism. The flat line is the walk-forward mean.</p>`;
    const verdict = wf.wfExp==null ? ''
      : wf.wfExp>0
        ? ((wf.retention!=null && wf.retention<0.6)
            ? 'Edge survives out-of-sample but at a fraction of its in-sample size — real, but decaying or partly overfit. Size to the walk-forward number, not the headline.'
            : 'Edge holds out-of-sample: walk-forward expectancy stays positive and close to in-sample. This is the version worth trusting.')
        : 'Out-of-sample the edge disappears — in-sample expectancy did not carry forward. Treat the headline as descriptive, not predictive, until this turns positive.';
    return `<div class="diag-section"><div class="diag-card" data-tip="Trains on a trailing window of trades, scores the next block strictly out-of-sample, then slides — the concatenated test blocks tile your history with no look-ahead. Their mean is a genuine walk-forward expectancy; comparing it to the full-sample (in-sample) number shows how much of the edge is real going forward vs fitted to the past.">
      <h3>Walk-forward reality <span style="color:var(--faint)">· ${wf.blocks} out-of-sample blocks · ${wf.train}-trade train / ${wf.step}-trade test · ${wf.oosN} trades scored</span></h3>
      ${mrow('In-sample expectancy',`${fmtUsd(wf.fullIS)}/trade`,'Naive mean net PnL over every closed trade in this view — the number the headline verdict is built on. In-sample: it has seen all the data it is scored against.')}
      ${mrow('Walk-forward expectancy',`<span class="badge ${wfCls}">${fA(wf.wfExp)}/trade</span>`,'Mean net PnL across only the out-of-sample test blocks — trades the training window had not yet seen when their expectancy was set. The honest estimate of what the edge earns going forward.')}
      ${mrow('WF 95% CI (bootstrap)',ciTxt,'Distribution-free confidence interval on the walk-forward expectancy, resampling the out-of-sample trades. If it includes 0, forward edge is not yet established.')}
      ${mrow('Retention',retTxt,'Walk-forward expectancy as a share of in-sample. 100% means the edge carried forward intact; well under that is decay or overfitting. Only shown when in-sample is positive.')}
      ${mrow('In-sample optimism',(()=>{ const o=wf.optimism;
        if(o==null) return '\u2014';
        const near=Math.abs(o)<Math.abs(wf.fullIS||0)*0.1;
        const tag=near?'<span class="badge ok">calibrated</span>'
          :o>0?'<span class="badge no">in-sample overstates</span>'
               :'<span class="badge ok">in-sample understates</span>';
        return `${fA(o)}/trade ${tag}`; })(),
        'Average gap between what each trailing window predicted and what the next block actually delivered (predicted minus realized). Positive means your in-sample stats systematically overstate forward performance, so size to the walk-forward number. Negative means the opposite \u2014 your recent blocks beat what the trailing window expected. Within 10% of in-sample expectancy either way is treated as calibrated.')}
      ${spark}
      <p class="mini-note">${verdict}</p>
    </div></div>`;
  })();
  el.innerHTML = `
   <div style="display:flex;justify-content:flex-end;gap:8px;margin-bottom:-6px"><button class="btn ghost" id="exportDiagPdf" data-tip="Print-grade PDF of this Diagnostic — headline stats, every visible chart embedded as an image, and the recommendations — that your accountant or backers can open anywhere. Generated entirely in the browser.">Export PDF</button><button class="btn ghost" id="exportReport" data-tip="Snapshot this entire Diagnostic — stats, charts (as images), miner results and excursions if you've run them — as a single self-contained HTML file for archiving monthly reviews.">Export report</button></div>
   <div class="verdict" data-tip="Overall grade from three things: are you net profitable, is your Sharpe's lower confidence bound above 0 (edge distinguishable from noise), and do you have ≥100 completed trades.">
     <div class="grade">${grade}</div><p>${verdictText}</p></div>
   ${wfHtml}
   <div class="diag-section">
     <div class="diag-grid">
       <div class="diag-card"><h3 data-tip="How much you can trust the numbers: sample size, the Sharpe with its confidence band, cost drag, and whether recent performance matches earlier performance.">Statistical reliability${mcPending?' <span class="hint">Monte Carlo computing…</span>':''}</h3>
         ${mrow('Completed trades',`<span class="badge ${adeq[0]}">${N}</span> ${adeq[1]}`,'Number of closed round-trips. Under 30 is anecdotal, 100+ starts to be meaningful, 300+ gives stable estimates. This is your true sample size — more decisive than day count.')}
         ${mrow('Calendar days',s.sharpeN||0,'Span from first to last trade in calendar days, including days you did not trade. Used as the denominator for annualizing Sharpe/Sortino.')}
         ${mrow('Sharpe (annualized, net)',s.sharpe!=null?s.sharpe.toFixed(2):'—','Mean daily net PnL ÷ its standard deviation, over calendar days, annualized ×√365, risk-free 0. Net of fees and funding. Rewards steady gains over lumpy ones.')}
         ${mrow('Sharpe 95% CI',s.sharpe!=null?`${s.sharpeLo.toFixed(1)} – ${s.sharpeHi.toFixed(1)}`:'—','95% confidence interval on the Sharpe (Lo 2002: SE ≈ √((1+0.5·SR²)/N)). The true Sharpe is very likely somewhere in this range. A wide band means the point estimate is not reliable yet.')}
         ${mrow('Reliability',`<span class="badge ${s.sharpe==null?'mid':s.sharpeLo>1?'ok':s.sharpeLo>0?'mid':'no'}">${shRel}</span>`,'Whether the confidence band clears meaningful thresholds. If it includes 0, the edge is indistinguishable from noise. If it clears 1.0, it is a genuinely strong risk-adjusted return.')}
         ${mrow('Costs (already deducted)',`${fmtUsd(s.fees)} fees · ${fmtUsd(s.fund)} funding`,'Total trading fees and funding paid/received across these trades. Already subtracted from every PnL figure — this shows you how big the drag is.')}
         ${mrow('Expectancy',`${fmtUsd(s.expectancy)}/trade`,'Average net PnL per completed trade — your edge per bet, in dollars.')}
         ${mrow('Expectancy 95% CI (bootstrap)',boot?`<span class="badge ${boot.lo>0?'ok':'no'}">${fmtUsd(boot.lo)} to ${fmtUsd(boot.hi)}</span>`:'—','Distribution-free confidence interval for your true per-trade expectancy, from resampling your trades '+B+' times. Unlike the Sharpe (a daily-returns metric), this works at the trade level — the "independent bets" that matter. If the interval includes 0, your positive expectancy could be luck.')}
         ${mrow('Edge significance',esig&&esig.t!=null?`<span class="badge ${esig.p<0.05?'ok':esig.p<0.1?'mid':'no'}">t=${esig.t.toFixed(2)}, p=${esig.p<0.001?'<0.001':esig.p.toFixed(3)}</span>`:'—','One-sample t-test that your mean trade PnL is greater than zero. p below 0.05 means the edge is statistically significant (less than a 5% chance a no-edge trader produces this). Assumes roughly independent trades; the bootstrap CI above is more robust to fat tails.')}
         ${mrow('Trades to confirm edge',esig&&esig.needN!=null?`~${esig.needN} ${esig.needN<=N?'(reached ✓)':`(you have ${N})`}`:(esig?'no positive edge to confirm':'—'),'Roughly how many trades you would need, at your current effect size (mean ÷ std of trade PnL), for the edge to be significant at 95%. If it is far above your trade count, keep trading before drawing conclusions. Assumes the effect size persists.')}
         ${mrow('Cost drag',costDragPct!=null?`${(costDragPct*100).toFixed(1)}% of gross`:'—','Fees as a share of your gross realized profit (before fees and funding). How much of your raw edge is eaten by trading costs — high drag means fee efficiency (maker vs taker, fewer round-trips) is worth attention.')}
         ${mrow('Recent vs earlier',stabOK?`<span class="badge ${STAB[stabState][0]}">${STAB[stabState][1]}</span>`:'<span class="badge mid">n/a</span>','Splits your history in half and compares expectancy and win rate. The closest thing to an out-of-sample check on a journal of real trades: is your recent edge as good as your earlier edge?')}
         <p class="lead" style="margin:10px 0 0">${stabTxt}</p>
         <p class="lead" style="margin:8px 0 0">These are descriptive stats on trades you actually took — in-sample, not a walk-forward backtest. The earlier-vs-recent split above is the closest proxy for out-of-sample persistence.</p>
       </div>
       <div class="diag-card"><h3 data-tip="Risk control and execution discipline: drawdown, streaks, position-sizing, mistake cost, self-rating accuracy, and market concentration.">Risk &amp; discipline</h3>
         ${mrow('Max drawdown',`<span class="${cls(s.maxDD)}">${fmtUsd(s.maxDD)}${s.maxDDpct!=null?' · '+(s.maxDDpct*100).toFixed(1)+'%':''}</span>`,'Largest peak-to-trough drop in cumulative realized PnL, in dollars and as a % of your peak cumulative profit (deposit/withdrawal independent). How deep a hole you have been in — the emotional and capital stress test of your strategy.')}
         ${mrow('Longest losing streak',s.longL+' trades','Most consecutive losing trades. Matters for position sizing: a strategy that can string together many losses needs smaller bets to survive.')}
         ${mrow('Oversizing check',oversizing?'<span class="badge no">biggest trades worst</span>':(bigExp!=null&&smallExp!=null?'<span class="badge ok">size looks ok</span>':'<span class="badge mid">n/a</span>'),'Compares expectancy on your largest 25% of trades (by notional) vs your smallest 25%. If your biggest bets underperform, you are sizing up on conviction that is not justified.')}
         ${bigExp!=null&&smallExp!=null?mrow('· Largest 25% vs smallest',`${fmtUsd(bigExp)} vs ${fmtUsd(smallExp)}/trade`,'Average net per trade in your largest-notional quartile vs your smallest. You want the big ones to be at least as good as the small ones.'):''}
         ${mrow('Mistake-flag cost',mistakeCost!=null?(mistakeCost>0?`<span class="loss">${fmtUsd(mistakeCost)}/trade</span>`:'<span class="badge ok">none</span>'):'<span class="badge mid">no flags logged</span>','Expectancy on trades you flagged with a mistake vs clean trades. Quantifies what your known errors actually cost you. Flag trades in the journal to enable.')}
         ${mrow('Rating calibration',ratingMono==null?'<span class="badge mid">rate trades to enable</span>':ratingMono?'<span class="badge ok">tracks outcomes</span>':'<span class="badge no">ratings ≠ results</span>','Whether higher self-ratings actually produce higher expectancy. If your ★★★★★ trades are not more profitable than your ★★ trades, your read on setup quality is off. Rate trades to enable.')}
         ${mrow('Concentration',topMkt?`${pct(Math.abs(conc))} of net in ${esc(dispMarket(topMkt.key))}`:'—','Share of your net PnL that comes from a single market. High concentration means your track record depends on one instrument — riskier and less generalizable than it looks.')}
         ${mrow('Current drawdown',cdd?(cdd.dd<-1e-6?`<span class="loss">${fmtUsd(cdd.dd)}${cdd.pct!=null?' · '+(cdd.pct*100).toFixed(1)+'%':''}</span> · ${cdd.since} trades ago peak`:'<span class="badge ok">at a high-water mark</span>'):'—','Where you stand right now versus your best-ever cumulative PnL. Tells you if you are currently underwater and by how much, and how many trades since your peak — useful for knowing whether to press or ease off.')}
         ${mrow('Simulated worst DD',mcdd?`median ${fmtUsd(-mcdd.median)} · 1-in-20 ${fmtUsd(-mcdd.p95)}`:'—','Monte-Carlo drawdown: your exact trades reshuffled into '+MCI+' random orderings. Shows how deep a drawdown to expect from ordering luck alone. Your realized max DD is one draw; the 1-in-20 (95th percentile) is a realistic bad case to size for.')}
         ${mrow('Longest underwater',uw&&uw.maxSpanMs>0?fmtDur(uw.maxSpanMs)+(uw.ongoingMs!=null?' · <span class="loss">currently '+fmtDur(uw.ongoingMs)+' in</span>':''):(uw?'<span class="badge ok">never left highs</span>':'—'),'Longest calendar stretch spent below your high-water mark before making a new high. Drawdown depth tells you how much it hurts; this tells you how LONG it hurts — the dimension that actually breaks discipline.')}
         ${mrow('Next '+HZN+'-trade DD (bootstrap)',fdd?`median ${fmtUsd(-fdd.median)} · 1-in-4 ${fmtUsd(-fdd.p75)} · 1-in-20 ${fmtUsd(-fdd.p95)}`:'—','Forward-looking sequence risk: '+(N>3000?400:800)+' simulated futures of '+HZN+' trades, each drawn (with replacement) from your own per-trade results, reporting the worst drawdown per path. If the 1-in-4 number would force you to stop trading or cut size, you are oversized NOW — decide the response before it happens, not during.')}
       </div>
       <div class="diag-card"><h3 data-tip="Behavioral biases the timing of your trades reveals: holding losers too long, tilting after losses, and overtrading.">Behavioral patterns</h3>
         ${mrow('Hold winners vs losers',(avgWHold!=null&&avgLHold!=null)?`${fmtDur(avgWHold)} vs ${fmtDur(avgLHold)}`:'—','Average hold time of winning vs losing trades. Holding losers much longer than winners is the classic disposition effect — hoping losers come back while snatching small wins.')}
         ${mrow('Disposition effect',disposition?'<span class="badge no">losers held longer</span>':(avgWHold!=null&&avgLHold!=null?'<span class="badge ok">not flagged</span>':'<span class="badge mid">n/a</span>'),'Flagged when you hold losers more than 1.25× as long as winners. The fix: decide your exit before you enter, and honor it.')}
         ${mrow('After a loss (≤1h)',afterLossExp!=null?`${fmtUsd(afterLossExp)}/trade · ${afterLoss.length} trades`:'—','Expectancy of trades you opened within an hour of closing a loser, vs your overall expectancy. A big gap is a tilt / revenge-trading signal.')}
         ${mrow('Tilt signal',tilt?'<span class="badge no">worse after losses</span>':(afterLoss.length>=5?'<span class="badge ok">steady after losses</span>':'<span class="badge mid">too few</span>'),'Flagged when post-loss trades underperform your baseline. If set, build in a cooldown after red trades.')}
         ${mrow('Busy days vs normal',(hiDays.length>=3&&loDays.length>=3)?`${fmtUsd(hiExp)} vs ${fmtUsd(loExp)}/trade`:'—','Expectancy per trade on your highest-activity days vs the rest. Tells you whether piling on more trades helps or hurts.')}
         ${mrow('Overtrading',overtrading?'<span class="badge no">busy days worse</span>':(hiDays.length>=3&&loDays.length>=3?'<span class="badge ok">not flagged</span>':'<span class="badge mid">too few</span>'),'Flagged when your busiest days underperform quieter ones — a sign activity is driven by impulse rather than opportunity.')}
         ${mrow('Streakiness',acf1!=null?`${acf1>=0?'+':''}${acf1.toFixed(2)} ${acf1>0.15?'· wins/losses cluster':acf1<-0.15?'· results alternate':'· independent'}`:'—','Lag-1 autocorrelation of your trade PnL: does one result predict the next? Strongly positive means hot and cold streaks are real (a good trade tends to follow a good one) — consider pressing when hot, easing when cold. Near zero means trades are independent and streaks are just chance.')}
       </div>
       <div class="diag-card"><h3 data-tip="How robust the profit is and how large you can rationally bet: outlier dependence and Kelly-optimal sizing.">Profit quality &amp; sizing</h3>
         ${mrow('Top 10% of trades',`${pct(topShare)} of gross profit`,'Share of all winning-trade profit that comes from your best 10% of trades. Above ~50% means your record leans heavily on a few outliers and is fragile.')}
         ${mrow('Without your best trade',`<span class="${cls(netNoBest)}">${fmtUsd(netNoBest)}</span>`,'Net PnL if you remove your single largest winner. If this collapses toward or below zero, one lucky trade is carrying the whole result.')}
         ${mrow('Fragility',fragile?'<span class="badge no">outlier-dependent</span>':'<span class="badge ok">broadly distributed</span>','Whether profits are concentrated in a few trades (fragile) or spread across many (robust). Robust edges survive when a couple of trades go missing.')}
         ${mrow('Profit factor',s.profitFactor===Infinity?'∞':s.profitFactor.toFixed(2),'Gross profit ÷ gross loss. Above 1 is profitable; 1.5+ is solid; 2+ is strong. How many dollars you make for each dollar you lose.')}
         ${mrow('Payoff vs breakeven',`${s.payoff===Infinity?'∞':s.payoff.toFixed(2)} vs ${pct(s.breakevenWR)} WR`,'Your win/loss size ratio, and the win rate you would need at that ratio just to break even. Compare your actual win rate to the breakeven number for your margin of safety.')}
         ${mrow('Kelly-optimal risk',kellyTxt,'The fraction of capital Kelly says to risk per trade given your win rate and payoff, to maximize long-run growth. Full Kelly is aggressive and assumes your edge is stable and known — most pros use half-Kelly or less. Treat as a ceiling, not a target.')}
         ${mrow('Return skew',skew!=null?`${skew>=0?'+':''}${skew.toFixed(2)} ${skew>0.5?'· lottery-like':skew<-0.5?'· blow-up shaped':'· balanced'}`:'—','Skewness of your per-trade PnL. Strongly positive = a few big winners carry you (lottery-like: many small losses, rare large gains — psychologically hard, and fragile). Strongly negative = steady small wins with occasional large losses (blow-up risk). Near zero is balanced.')}
         ${mrow('Run-rate',runRate!=null?`${fmtUsd(perDay)}/day · ${fmtUsd(runRate)}/yr`:'—','Net PnL per calendar day, extrapolated to a year. A naive projection assuming the future looks like the past — useful for scale, not a forecast.')}
       </div>
     </div>
   </div>
   <div class="diag-section">
     <div class="diag-grid">
       <div class="diag-card"><h3 data-tip="Your most profitable conditions, ranked by expectancy weighted by sample size so a small hot streak cannot top the list. Do more of these.">Repeat these — your edges</h3><ul class="diag-list">${strongHtml}</ul></div>
       <div class="diag-card"><h3 data-tip="Your most costly conditions, same sample-weighted ranking. Cut these or redefine the setup.">Avoid / fix these — your leaks</h3><ul class="diag-list">${weakHtml}</ul></div>
     </div>
   </div>
   ${assetAttribSection(closed)}
   ${capitalSectionHtml()}
   <div class="diag-section">
     <h2>Equity &amp; edge over time</h2>
     <div class="diag-grid">
       <div class="diag-card"><h3 data-tip="Cumulative realized net PnL trade-by-trade (violet), your high-water mark (gold), and the drawdown gap between them shaded red. The right edge shows where you stand now vs your best.">Equity vs high-water mark</h3>
         <div style="height:220px"><canvas id="diagEq"></canvas></div></div>
       <div class="diag-card"><h3 data-tip="Average net PnL of your last 30 trades, moving one trade at a time — a continuous view of edge decay or improvement (the half-split above is the coarse version). Above the zero line = your recent edge is positive.">Rolling 30-trade expectancy</h3>
         <div style="height:220px"><canvas id="diagRoll"></canvas><p id="diagRollEmpty" class="lead hide" style="text-align:center;padding-top:80px">Needs ≥40 completed trades.</p></div></div>
     </div>
     <div class="diag-card" style="margin-top:14px"><h3 data-tip="Where the money actually comes from, by month: price PnL vs funding vs fees. A strategy can be price-profitable and still bleed out through funding payments or fee drag — the single net number hides which one is happening.">PnL decomposition — price vs funding vs fees</h3>
       <div style="height:240px"><canvas id="diagDecomp"></canvas></div></div>
     <div class="diag-card hide" style="margin-top:14px"><h3 data-tip="Your cumulative net PnL expressed as % of your AVERAGE deployed notional (a stated approximation — you don't hold one fixed stake), against simply buying and holding BTC or HYPE over the same window. The uncomfortable but necessary question for any active trader.">You vs buy-and-hold</h3>
       <div style="height:240px"><canvas id="diagBench"></canvas></div></div>
   </div>
   <div class="diag-section">
     <h2>Result distribution</h2>
     <p class="lead" id="distLede"></p>
     <div class="diag-card">
       <div class="stats" id="distStats" style="border:none;margin:0 0 14px"></div>
       <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;margin-bottom:12px">
         <div style="display:flex;flex-wrap:wrap;gap:7px" id="distTgts">
           <button class="chk dtgt" data-k="shape" data-tip="Same win rate, profit redistributed into more mid-sized winners instead of a few outliers — a more repeatable version of your edge. Illustrative reference shape, not a fitted forecast."><span class="dsw" style="border-top:2px dashed #8a7bd8"></span>Repeatable edge</button>
           <button class="chk dtgt" data-k="survival" data-tip="The far-left loss zone that threatens long-term viability at your current account size and sizing (derived from your win rate and average win/loss via a Kelly cap). Trades landing here are size-discipline problems."><span class="dsw" style="background:#e24b4a;opacity:.4"></span>Survival floor</button>
           <button class="chk dtgt" data-k="best" data-tip="The result distribution of your single strongest stretch (found by the change-point detector), overlaid as a shape to trade back toward. In-sample, so aspiration not proof."><span class="dsw" style="border-top:2px dotted #1d9e75"></span>Your best period</button>
         </div>
         <div style="display:flex;gap:14px;align-items:center">
           <div class="viewtog" id="distMode" data-tip="Show trade results in absolute dollars, or as a % of each trade's position notional. Percent normalizes for size — a leverage-neutral view that stays comparable as you scale up.">
             <button data-m="usd" class="on">$</button><button data-m="pct">%</button>
           </div>
           <label class="dchk" data-tip="Draw a translucent fill under the Repeatable-edge and Best-period curves."><input type="checkbox" id="distFill"> shade under curves</label>
           <span class="pgsize">Bin <span id="distBinUnit">$</span><input type="number" id="distBin" min="0" step="any" style="width:78px" data-tip="Set your own bucket width, in whichever unit is active. In $ mode enter dollars (e.g. 750); in % mode enter percent (e.g. 0.4). Leave blank to auto-size."></span>
         </div>
       </div>
       <div class="chart-box" style="height:340px"><canvas id="distChart"></canvas><div id="distEmpty" class="chart-empty hide">Needs ≥20 completed trades.</div></div>
       <p class="lead" id="distCap" style="margin-top:11px;font-size:12px;color:var(--faint);min-height:18px"></p>
     </div>
   </div>
   ${trackedSectionHtml(closed)}
   ${setupSectionHtml(closed)}
   <div class="diag-section">
     <h2>Pattern miner <span style="font-size:11px;color:var(--faint);font-weight:400">finds conditions where you reliably make or lose money · statistically tested</span></h2>
     <p class="lead">Scans single conditions <b>and pairwise combinations</b> (e.g. Short × weekend, BTC × after-a-loss) that one-dimensional breakdowns can't see. Every candidate is permutation-tested and the whole scan is corrected for multiple comparisons (Benjamini–Hochberg, 10% FDR) — so a pattern only appears here if it's unlikely to be luck <i>given how many things were tested</i>.</p>
     <div style="display:flex;align-items:center;gap:14px;margin-bottom:10px">
       <div class="viewtog" id="anaBasisTog" data-tip="Judgment basis for every scan below. $ = dollar impact (attribution: where the money comes from and goes, correct for &quot;cutting X saves $Y&quot;). % = return on position notional (decision quality, size-neutral — a fair comparison as you scale up). Win/loss classification always uses the $ break-even band; only the measurement unit changes.">
         <button data-b="usd" class="on">judge in $</button><button data-b="pct">judge in %</button>
       </div>
     </div>
     <div id="minerBox">${N<30?'<p class="lead">Needs ≥30 completed trades.</p>':'<button class="btn ghost" id="runMiner">Run pattern miner + deep scan</button>'}</div>
   </div>
   <div class="diag-section">
     <h2>What if I stopped doing X <span style="font-size:11px;color:var(--faint);font-weight:400">counterfactual replay · deterministic · no resampling</span></h2>
     <p class="lead">Pick any condition the miner knows about and replay your actual trade sequence <b>without</b> those trades. This turns a pattern into a dollar number — the counterfactual equity curve, expectancy, and drawdown you would have had — which is what makes behavior actually change. Purely arithmetic on the trades you took: no simulation, no randomness. The usual caveat applies: removing trades in hindsight is the optimistic bound, since the freed-up attention and capital would have gone somewhere.</p>
     <div class="filters" style="margin-bottom:10px">
       <select id="wiCond"></select>
       <button class="btn ghost" id="wiRun">Replay without these trades</button>
     </div>
     <div id="wiBox"></div>
   </div>
   <div class="diag-section">
     <h2>Price excursions <span style="font-size:11px;color:var(--faint);font-weight:400">MAE / MFE · from exchange candles · on-demand</span></h2>
     <p class="lead">How far each trade ran <b>against</b> you (max adverse excursion) and <b>in your favor</b> (max favorable excursion) between entry and exit, measured from exchange candles. Answers two questions the fill history alone can't: are your stops sized to what winners actually endure, and how much open profit do you give back before exiting. Fetches candles from Hyperliquid on demand and caches them locally — first run is the slow one.</p>
     <div id="excBox">${N<10?'<p class="lead">Needs ≥10 completed trades.</p>':'<button class="btn ghost" id="runExc">Fetch candles + compute excursions</button>'}</div>
   </div>
   ${extraDiagHtml(closed,allv,s)}
   ${!coachOn()?`<div class="diag-section">
     <h2>Recommendations</h2>
     <p class="lead">Prioritized by the money at stake. Higher items have the biggest expected impact.</p>
     <ol class="recs" id="recsFallback">${findings.map(f=>`<li><b>${esc(f.title)}.</b> ${esc(f.body)} ${esc(f.action)} <span style="color:var(--faint)">${esc(f.evidence||'')}</span></li>`).join('')}</ol>
   </div>`:`<div class="diag-section">
     <h2>What your numbers say <span style="font-size:11px;color:var(--faint);font-weight:400">in plain words · most money at stake first</span></h2>
     <p class="lead">Each card says what’s happening, one thing to do about it, and how sure the numbers are. Open “The numbers” for the statistics behind it; “Adopt as habit” turns the advice into a when-then habit tracked in Review.</p>
     <div class="fnd-grid" id="fndGrid">${findings.map(findingCardHtml).join('')}</div>
   </div>`}
   <p class="lead" style="text-align:center;margin-top:8px">Diagnostic reflects the current view (${view}) and period. Bucket signals require ≥${MIN} trades to appear.</p>`;
  document.querySelectorAll('#trackedCard .unpin').forEach(b=>{ b.onclick=async()=>{
    // the index is into the listed pins (pinsList skips broken ones): remove that very pin
    const pin=pinsList()[+b.dataset.pi]; settings.pins=(Array.isArray(settings.pins)?settings.pins:[]).filter(p=>p!==pin); await Store.set(S_KEY,settings);
    renderDiagnostic(periodTrades(),periodTradesAll()); }; });
  document.querySelectorAll('#trackedCard .pin-arch').forEach(b=>{ b.onclick=async()=>{
    const pin=pinsList()[+b.dataset.pi]; if(pin)pin.archived=!pin.archived;
    await Store.set(S_KEY,settings);
    renderDiagnostic(periodTrades(),periodTradesAll()); }; });
  const runBtn=$('runMiner');
  const repBtn=$('exportReport');
  if(repBtn)repBtn.onclick=()=>{ try{ exportReport(); }catch(e){ setErr('Report export failed: '+e.message); } };
  const pdfBtn=$('exportDiagPdf');
  if(pdfBtn)pdfBtn.onclick=()=>{ try{ exportDiagPdf(); }catch(e){ setErr('PDF export failed: '+e.message); } };
  wireWhatIf(closed);
  wireAssetAttrib(closed);
  wireWalkForward(wf);
  document.querySelectorAll('#anaBasisTog button').forEach(b=>{ b.classList.toggle('on',b.dataset.b===(settings.anaBasis||'usd'));
    b.onclick=async()=>{ settings.anaBasis=b.dataset.b; await Store.set(S_KEY,settings);
      document.querySelectorAll('#anaBasisTog button').forEach(x=>x.classList.toggle('on',x===b));
      _minerCache={key:null,res:null,deep:null};
      const rb=$('runMiner'); if(rb){ rb.disabled=false; rb.textContent='Run pattern miner + deep scan'; }
      else if($('minerBox')) $('minerBox').innerHTML='<button class="btn ghost" id="runMiner2">Run pattern miner + deep scan</button>';
      renderDiagnostic(periodTrades(),periodTradesAll()); }; });
  renderDistribution(closed);
  wireExtraDiag(closed,allv,s);
  wireFindingCards($('fndGrid'),findings);
  wireExcursions(closed);
  renderBenchmark(closed); // async; reveals its card only when candle data exists
  // --- monthly PnL decomposition: price vs funding vs fees ---
  (function(){ const el=$('diagDecomp'); if(!el)return;
    const by={}; for(const t of closed){ const p2=tzParts(t.closeTime); const k=p2.y+'-'+String(p2.mo+1).padStart(2,'0');
      const o=by[k]=by[k]||{price:0,fund:0,fees:0}; o.price+=t.pnl; o.fund+=t.funding||0; o.fees-=t.fees; }
    const keys=Object.keys(by).sort(); if(!keys.length)return;
    _diagCharts.decomp=new Chart(el,{type:'bar',data:{labels:keys,datasets:[
      {label:'price PnL',data:keys.map(k=>by[k].price),backgroundColor:'rgba(139,147,255,.75)',stack:'s'},
      {label:'funding',data:keys.map(k=>by[k].fund),backgroundColor:themeGreen()+'BF',stack:'s'},
      {label:'fees',data:keys.map(k=>by[k].fees),backgroundColor:'rgba(240,97,109,.75)',stack:'s'}]},
      options:{responsive:true,maintainAspectRatio:false,
        plugins:{legend:{display:true,labels:{color:TXT,boxWidth:10,font:{size:11}}},
          tooltip:{callbacks:{label:c=>' '+c.dataset.label+' '+fmtUsd(c.parsed.y),
            footer:items=>{const o=by[items[0].label];return 'net '+fmtUsd(o.price+o.fund+o.fees);}}}},
        scales:{x:{stacked:true,grid:{color:GRID,drawTicks:false},border:{display:false},ticks:{maxRotation:0,autoSkip:true,maxTicksLimit:12}},
                y:{stacked:true,grid:{color:GRID,drawTicks:false},border:{display:false}}}}});
    explain(_diagCharts.decomp,'Each month’s result split into what price moves made, what funding paid or cost, and what fees took.');
  })();
  // --- per-setup equity curves ---
  (function(){ const el=$('setupCurves'); if(!el)return;
    const cards=setupScorecards(closed,journal); if(!cards.length)return;
    const PAL=['#8b93ff','#2FD08C','#E6B450','#F0616D','#5BC8D8','#C792EA'];
    _diagCharts.setups=new Chart(el,{type:'line',data:{datasets:cards.map((c,i)=>({
      label:c.name, data:c.curve.map((y,x)=>({x:x+1,y})),
      borderColor:PAL[i%PAL.length], borderWidth:1.5, pointRadius:0, pointHoverRadius:3, fill:false, tension:0 }))},
      options:{responsive:true,maintainAspectRatio:false,
        plugins:{legend:{display:true,labels:{color:TXT,boxWidth:10,font:{size:11}}},
          tooltip:{callbacks:{label:c=>' '+c.dataset.label+' · trade '+c.parsed.x+' · total '+fmtUsd(c.parsed.y)}}},
        scales:{x:{type:'linear',grid:{color:GRID,drawTicks:false},border:{display:false},ticks:{maxTicksLimit:8,precision:0}},
                y:{grid:{color:GRID,drawTicks:false},border:{display:false},ticks:{callback:v=>'$'+Number(v).toLocaleString()}}},
        interaction:{intersect:false,mode:'nearest'}}});
    explain(_diagCharts.setups,'Running total for each setup, trade by trade. A setup whose line climbs steadily is one worth trading more.');
  })();
  // --- equity vs HWM chart ---
  const chronAll=[...allv].sort((a,b)=>a.closeTime-b.closeTime);
  if(chronAll.length>=2){
    let cum=0,hwm=0; const eqD=[],hwmD=[],ts=[];
    for(const t of chronAll){ cum+=t.net; if(cum>hwm)hwm=cum; eqD.push(cum); hwmD.push(hwm); ts.push(t.closeTime); }
    const di=decimateIdx(eqD); // both series sampled at the equity curve's kept extremes
    _diagCharts.eq=new Chart($('diagEq'),{type:'line',data:{labels:pickIdx(ts,di).map(fmtDate),datasets:[
      {data:pickIdx(hwmD,di),borderColor:'#3A4560',borderWidth:1.2,borderDash:[4,4],pointRadius:0,fill:false},
      {data:pickIdx(eqD,di),borderColor:themeGreen(),borderWidth:1.6,pointRadius:0,pointHoverRadius:3,tension:.1,fill:'-1',backgroundColor:'rgba(244,88,106,.14)'}]},
      options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{label:c=>' '+(c.datasetIndex?'equity ':'high-water ')+fmtUsd(c.parsed.y),
        afterBody:it=>{ const a=it.find(x=>x.datasetIndex===1), b=it.find(x=>x.datasetIndex===0); if(!a||!b)return []; const dd=a.parsed.y-b.parsed.y; return [dd<0?' Drawdown '+fmtUsd(dd)+(b.parsed.y>0?' ('+Math.round(-dd/b.parsed.y*100)+'% of the high)':''):' At the high']; }}}},
        scales:scales(),interaction:{intersect:false,mode:'index'}}});
    explain(_diagCharts.eq,'Green: your running total. Dashed: its highest point so far. The red gap between them is the drawdown you were sitting in.');
  }
  // --- rolling 30-trade expectancy ---
  const chronClosed=[...closed].sort((a,b)=>a.closeTime-b.closeTime);
  const W=30;
  if(chronClosed.length>=40){
    $('diagRollEmpty').classList.add('hide'); $('diagRoll').style.display='';
    const roll=[],rt=[]; let s2=0;
    for(let i=0;i<chronClosed.length;i++){ s2+=chronClosed[i].net; if(i>=W)s2-=chronClosed[i-W].net;
      if(i>=W-1){ roll.push(s2/W); rt.push(chronClosed[i].closeTime); } }
    const ri=decimateIdx(roll);
    _diagCharts.roll=new Chart($('diagRoll'),{type:'line',data:{labels:pickIdx(rt,ri).map(fmtDate),datasets:[
      {data:pickIdx(roll,ri),borderColor:themeGreen(),borderWidth:1.6,pointRadius:0,pointHoverRadius:3,tension:.1,
       segment:{borderColor:c=>c.p1.parsed.y>=0?'rgba(63,207,142,.95)':'rgba(240,97,109,.95)'},fill:{target:{value:0}},backgroundColor:themeGreen()+'12'}]},
      options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{label:c=>' '+fmtUsd(c.parsed.y)+' a trade over the last '+W,afterLabel:c=>' '+fmtUsd(c.parsed.y*W)+' in total over those '+W+' trades'}}},
        scales:scales(),interaction:{intersect:false,mode:'index'}}});
    explain(_diagCharts.roll,'Your average trade over a sliding window of the last '+W+'. Above zero, your recent trading is making money; a falling line is an edge fading.');
  } else if($('diagRoll')){ $('diagRoll').style.display='none'; $('diagRollEmpty').classList.remove('hide'); }
  if(runBtn){
    const basis=settings.anaBasis||'usd';
    const key=[view,period,customRange.from,customRange.to,closed.length,basis,dexView,_jrev].join('|'); // dex filter + journal edits change miner inputs without changing trade count
    const runScan=async()=>{ runBtn.disabled=true; runBtn.textContent='Scanning…';
      const pool = basis==='pct' ? closed.filter(t=>retPct(t)!==null) : closed;
      const seed=_hashSeed('miner|'+key+'|'+pool.length);
      const token=++_minerToken;
      try{
        const {res,deep}=await minerScan(pool,basis,seed,(done,total)=>{
          if(token===_minerToken&&runBtn.isConnected)runBtn.textContent='Scanning… '+Math.min(99,Math.round(done/total*100))+'%'; });
        if(res)res.seed=seed.toString(16);
        _minerCache={key,res,deep};
        if(token===_minerToken) renderMinerResults(res,deep,basis);
      }catch(e){ const mb=$('minerBox'); if(mb&&token===_minerToken)mb.innerHTML='<p class="lead">Scan error: '+esc(e.message)+'</p>'; }
    };
    runBtn.onclick=runScan;
    // auto-run: the miner starts itself when the Diagnostic opens on a selection it hasn't
    // scanned yet. Same background worker as the manual button, so the UI never blocks; the
    // cache short-circuits redundant re-runs and _minerToken suppresses stale paints. The
    // button remains for a manual re-scan.
    if(_minerCache.key===key){ renderMinerResults(_minerCache.res,_minerCache.deep,basis); }
    else runScan();
  }
}

/* ============================ deep scan: states / regime / sizing ============================ */
function tradeStates(closed){
  const byOpen=[...closed].sort((a,b)=>a.openTime-b.openTime);
  const byClose=[...closed].sort((a,b)=>a.closeTime-b.closeTime);
  const M=new Map(); let ci=0; const closedBefore=[];
  let dayKeyCur=null, idxDayCtr=0;
  // the streak and the day's P&L are carried forward as trades close (one pass, not a walk back
  // through every earlier trade for each one: long runs of scratches made that quadratic)
  let st=0, dayFrom=0, dayPnl=0;
  for(const t of byOpen){
    while(ci<byClose.length && byClose[ci].closeTime<=t.openTime){ const c=byClose[ci]; closedBefore.push(c); ci++;
      if(isWin(c.net))st=st>0?st+1:1; else if(isLoss(c.net))st=st<0?st-1:-1; // a scratch neither extends nor breaks it
      dayPnl+=c.net; }
    const prev=closedBefore.length?closedBefore[closedBefore.length-1]:null;
    const dk=tzMidnight(t.openTime);
    if(dk!==dayKeyCur){ dayKeyCur=dk; idxDayCtr=0; } idxDayCtr++;
    if(dayFrom<closedBefore.length&&closedBefore[dayFrom].closeTime<dk){ // a new day: sum it afresh (subtracting left rounding dust that flipped its sign)
      while(dayFrom<closedBefore.length&&closedBefore[dayFrom].closeTime<dk)dayFrom++;
      dayPnl=0; for(let k=dayFrom;k<closedBefore.length;k++)dayPnl+=closedBefore[k].net; }
    M.set(t.id,{streak:st, prevNet:prev?prev.net:null, gap:prev?(t.openTime-prev.closeTime):null, idxDay:idxDayCtr, dayPnl});
  }
  return M;
}
function stateDefs(ST,nets){
  const q=p=>{const a=[...nets].sort((x,y)=>x-y);return a[Math.min(a.length-1,Math.floor(p*a.length))];};
  const p90=q(0.9), p10=q(0.1);
  return [
    ['after 1 loss',t=>ST.get(t.id).streak===-1],
    ['after 2+ straight losses',t=>ST.get(t.id).streak<=-2],
    ['after 2+ straight wins',t=>ST.get(t.id).streak>=2],
    ['after a big win (top 10%)',t=>{const p=ST.get(t.id).prevNet;return p!=null&&p>=p90;}],
    ['after a big loss (bottom 10%)',t=>{const p=ST.get(t.id).prevNet;return p!=null&&p<=p10;}],
    ['re-entry within 15m',t=>{const g=ST.get(t.id).gap;return g!=null&&g<=9e5;}],
    ['4th+ trade of the day',t=>ST.get(t.id).idxDay>=4],
    ['while red on the day',t=>ST.get(t.id).dayPnl<0],
    ['while green on the day',t=>ST.get(t.id).dayPnl>0],
  ];
}
function stateAnalysis(closed,V){ V=V||(t=>t.net);
  if(closed.length<40)return null;
  const ST=tradeStates(closed); const nets=closed.map(V); const mAll=_avg(nets);
  const res=stateDefs(ST,nets).map(([name,fn])=>{
    const inS=closed.filter(fn), n=inS.length;
    if(n<10 || n>closed.length-10) return {name,n,skip:true};
    const sub=inS.map(V), rest=closed.filter(t=>!fn(t)).map(V);
    const m=_avg(sub), sd=_std(sub), mr=_avg(rest), sr=_std(rest);
    const v1=sd*sd/n, v2=sr*sr/rest.length, se=Math.sqrt(v1+v2);
    // Welch t with Welch-Satterthwaite df — subgroups here go as small as n=10, where the
    // old normal CDF was anti-conservative in exactly the regime the FDR gate polices
    const df=se>0?(v1+v2)*(v1+v2)/((v1*v1)/(n-1)+(v2*v2)/(rest.length-1)):1;
    const tt=se>0?(m-mr)/se:0, p=2*(1-_tCdf(Math.abs(tt),df));
    return {name,n,exp:m,delta:m-mAll,vsRest:m-mr,impact:(m-mAll)*n,p,sig:false};
  });
  // Benjamini–Hochberg across the states actually tested — without it, ~1 in 20 states
  // reads as a "boost/drain" by chance. Matches the miner's FDR discipline.
  const tested=res.filter(x=>!x.skip).sort((a,b)=>a.p-b.p); const M=tested.length, Q=0.10;
  let cut=-1; for(let i=0;i<M;i++) if(tested[i].p<=(i+1)/M*Q)cut=i;
  for(let i=0;i<=cut;i++) tested[i].sig=true;
  return res;
}
function _maxSplitT(x){
  const N=x.length, MIN=Math.max(15,Math.floor(N*0.1));
  let ps=0; const pre=[0]; for(const v of x){ps+=v;pre.push(ps);}
  let ps2=0; const pre2=[0]; for(const v of x){ps2+=v*v;pre2.push(ps2);}
  let best={t:0,k:-1};
  for(let k=MIN;k<=N-MIN;k++){
    const n1=k,n2=N-k,m1=pre[k]/n1,m2=(pre[N]-pre[k])/n2;
    const v1=Math.max(0,(pre2[k]-n1*m1*m1)/(n1-1)), v2=Math.max(0,((pre2[N]-pre2[k])-n2*m2*m2)/(n2-1));
    const se=Math.sqrt(v1/n1+v2/n2); if(se===0)continue;
    const t2=Math.abs(m1-m2)/se; if(t2>best.t)best={t:t2,k};
  }
  return best;
}
function changePoint(closed,V){ V=V||(t=>t.net);
  const chron=[...closed].sort((a,b)=>a.closeTime-b.closeTime);
  const x=chron.map(V); const N=x.length;
  if(N<60)return null;
  const PERMS=N>2500?200:300;
  const obs=_maxSplitT(x); if(obs.k<0)return null;
  let ge=0; const y=x.slice();
  for(let p=0;p<PERMS;p++){ for(let i=y.length-1;i>0;i--){const j=(_rng()*(i+1))|0;const t2=y[i];y[i]=y[j];y[j]=t2;}
    if(_maxSplitT(y).t>=obs.t)ge++; }
  const p=(ge+1)/(PERMS+1);
  const A=chron.slice(0,obs.k), B=chron.slice(obs.k);
  // rolling-mean expectancy series (downsampled to <=120 points) so the UI can draw the
  // sequence with the detected break marked, instead of only stating a conclusion.
  const w=Math.max(10,Math.round(N/15));
  const roll=new Array(N); let acc=0;
  for(let i=0;i<N;i++){ acc+=x[i]; if(i>=w)acc-=x[i-w]; roll[i]=acc/Math.min(i+1,w); }
  const step=Math.max(1,Math.ceil(N/120)); const series=[];
  for(let i=0;i<N;i+=step) series.push({i,t:chron[i].closeTime,v:roll[i]});
  if((N-1)%step!==0) series.push({i:N-1,t:chron[N-1].closeTime,v:roll[N-1]});
  return {p,sig:p<0.05,at:chron[obs.k].closeTime,k:obs.k,series,win:w,
    before:{n:A.length,exp:_avg(A.map(V))}, after:{n:B.length,exp:_avg(B.map(V))}};
}
function sizeDependence(closed){
  // y is %-of-notional, NOT $: $ net = pct \u00d7 notional, so a positive mean creates a
  // mechanical positive correlation with size in $ terms. Percent isolates decision quality.
  const pts=closed.map(t=>({x:(t.maxSize||0)*(t.avgEntry||0),y:retPct(t)})).filter(p=>p.x>0&&p.y!==null);
  const n=pts.length; if(n<30)return null;
  const rank=a=>{const idx=a.map((v,i)=>[v,i]).sort((p,q)=>p[0]-q[0]);const r=new Array(a.length);
    let i=0; while(i<idx.length){ let j=i; while(j+1<idx.length&&idx[j+1][0]===idx[i][0])j++;
      const rr=(i+j)/2+1; for(let k=i;k<=j;k++)r[idx[k][1]]=rr; i=j+1; } return r;};
  const rx=rank(pts.map(p=>p.x)), ry=rank(pts.map(p=>p.y));
  const rhoOf=(a,b)=>{const ma=_avg(a),mb=_avg(b);let num=0,da=0,db=0;
    for(let i=0;i<n;i++){num+=(a[i]-ma)*(b[i]-mb);da+=(a[i]-ma)**2;db+=(b[i]-mb)**2;}
    return num/Math.sqrt(da*db);};
  const rho=rhoOf(rx,ry); if(!isFinite(rho))return null; // every trade the same size (or the same result): nothing to correlate
  const PERMS=400; let ge=0; const sy=ry.slice();
  for(let p=0;p<PERMS;p++){ for(let i=sy.length-1;i>0;i--){const j=(_rng()*(i+1))|0;const t2=sy[i];sy[i]=sy[j];sy[j]=t2;}
    if(Math.abs(rhoOf(rx,sy))>=Math.abs(rho))ge++; }
  return {rho,n,p:(ge+1)/(PERMS+1),sig:(ge+1)/(PERMS+1)<0.05};
}
function _wilson(w,n){ if(!n)return null; const z=1.96, p=w/n, z2=z*z;
  const den=1+z2/n, ctr=(p+z2/(2*n))/den, half=(z*Math.sqrt(p*(1-p)/n+z2/(4*n*n)))/den;
  return {p, lo:Math.max(0,ctr-half), hi:Math.min(1,ctr+half)}; }
function partitionConditions(rows){
  // Fix for the old top-5/bottom-5 overlap (both lists sliced the same rows, and "worst"
  // sorted by the UPPER Wilson bound, dragging well-sampled winners into the loser panel).
  // Now: classify each condition once, then partition so it appears on exactly one side.
  // Money decides the split (break-even at 0, in the selected basis); the win-rate Wilson
  // floor vs a coin flip decides edge-vs-fragile. No size weighting. Deterministic ties.
  const cmpKey=(a,b)=>a.name<b.name?-1:a.name>b.name?1:0;
  for(const x of rows){
    x.state = x.exp<=0 ? 'losing' : (x.lo<0.5 ? 'fragile' : 'edge');
    x.tone  = x.state==='edge' ? 'ok' : (x.state==='fragile' ? 'mid' : 'no');
    x.note  = x.state==='fragile' ? (x.n<25 ? 'small sample \u00b7 n='+x.n : 'win-rate floor '+(x.lo*100).toFixed(0)+'% < 50%')
            : x.state==='losing'  ? 'loses money' : '';
  }
  const best =rows.filter(x=>x.state==='edge').sort((a,b)=>(b.exp-a.exp)||(b.lo-a.lo)||cmpKey(a,b));
  const worst=rows.filter(x=>x.state!=='edge').sort((a,b)=>(a.exp-b.exp)||(a.lo-b.lo)||cmpKey(a,b));
  return {best, worst};
}
function probabilityScan(closed,V){ V=V||(t=>t.net);
  if(closed.length<40)return null;
  const ST=tradeStates(closed);
  const fams=minerFams(closed,ST);
  const decisiveAll=closed.filter(t=>isWin(t.net)||isLoss(t.net));
  if(decisiveAll.length<30)return null;
  const wAll=decisiveAll.filter(t=>isWin(t.net)).length;
  const overall=_wilson(wAll,decisiveAll.length);
  const rows=[];
  for(const f in fams) for(const [name,fn] of fams[f]){
    const inC=closed.filter(fn);
    const dec=inC.filter(t=>isWin(t.net)||isLoss(t.net));
    if(dec.length<15 || inC.length>closed.length*0.9) continue;
    const w=dec.filter(t=>isWin(t.net)).length;
    const wl=_wilson(w,dec.length); if(!wl)continue;
    rows.push({name,fam:f,n:dec.length,w,wr:wl.p,lo:wl.lo,hi:wl.hi,exp:_avg(inC.map(V))});
  }
  if(!rows.length)return null;
  const part=partitionConditions(rows);
  return {overall:{wr:overall.p,lo:overall.lo,hi:overall.hi,n:decisiveAll.length}, best:part.best.slice(0,8), worst:part.worst.slice(0,8)};
}
function deepScan(closed,V){
  return {states:stateAnalysis(closed,V), cp:changePoint(closed,V), sz:sizeDependence(closed), prob:probabilityScan(closed,V)};
}

/* ============================ compute worker (main-thread offload) ============================ */
// The two heavy paths — fill→trade reconstruction and the permutation-test miner/deep scan —
// run in a Web Worker so large wallets no longer freeze the UI. Single-file constraint: the
// worker is built at runtime from a Blob of the page's own function sources (no worker.js).
// Everything shipped into the worker is pure modulo the globals in _WORKER_PRELUDE, which are
// re-sent with each request. If Worker construction or execution fails for any reason, the
// wrappers fall back to the original synchronous code path — identical results, just blocking.
const _WORKER_LIB=()=>({_srand,_avg,_std,_erf,_normCdf,_lgamma,_ibetaReg,_tCdf,_wilson,_maxSplitT,retPct,addedToLoser,dcoin,dispMarket,
  mcMaxDD,fwdMaxDD,edgeSignificance,
  tzParts,tzHour,tzDow,tzLabel,tzMidnight,isWin,isLoss,isPerp,newTrade,tallyFill,
  reconstructTrades,attributeFunding,bootstrapMeanCI,tradeStates,stateDefs,stateAnalysis,
  changePoint,sizeDependence,probabilityScan,partitionConditions,dayJKey,checkinPred,minerFams,mineInsights,deepScan});
const _WORKER_PRELUDE="let settings={tz:'local'}, journal={}, _excM={}, spotMaps={nameByCoin:{}}, _be=50, _rng=Math.random, _progress=null;"+
  "const CHECKIN_CONDS="+JSON.stringify(CHECKIN_CONDS)+";";
const _WORKER_DISPATCH="onmessage=function(e){var d=e.data;"+
 "try{var out;"+
 "if(d.kind==='miner'){settings=d.payload.settings||settings;journal=d.payload.journal||{};_excM=d.payload.excursions||{};if(d.payload.be!=null)_be=d.payload.be;"+
 "_srand(d.payload.seed);_progress=function(done,total){postMessage({id:d.id,type:'progress',done:done,total:total});};"+
 "var V=d.payload.basis==='pct'?function(t){return retPct(t);}:function(t){return t.net;};"+
 "var res=mineInsights(d.payload.trades,V);var deep=deepScan(d.payload.trades,V);_progress=null;out={res:res,deep:deep};}"+
 "else if(d.kind==='reconstruct'){out={perp:attributeFunding(reconstructTrades(d.payload.fills,d.payload.addr,'perp'),d.payload.frows||[]),"+
 "spot:attributeFunding(reconstructTrades(d.payload.fills,d.payload.addr,'spot'),[])};}"+
 "else if(d.kind==='diagmc'){if(d.payload.be!=null)_be=d.payload.be;_srand(d.payload.seed);"+
 "var nets=d.payload.nets,chron=d.payload.chron;"+ // SAME compute order as the sync path — identical PRNG stream, identical values
 "out={boot:nets.length>=5?bootstrapMeanCI(nets,d.payload.B):null,"+
 "esig:nets.length>=5?edgeSignificance(nets):null,"+
 "mcdd:chron.length>=5?mcMaxDD(chron,d.payload.MCI):null,"+
 "fdd:chron.length>=10?fwdMaxDD(chron,d.payload.HZN,d.payload.FI):null};}"+
 "else throw new Error('unknown kind: '+d.kind);"+
 "postMessage({id:d.id,type:'done',out:out});}"+
 "catch(err){postMessage({id:d.id,type:'error',message:(err&&err.message)||String(err)});}};";
function _fnSrc(n,f){ const s=f.toString();
  return /^\s*(async\s+)?function[\s(]/.test(s)?s:('const '+n+'='+s+';'); }
function buildWorkerSrc(){ const lib=_WORKER_LIB();
  return [_WORKER_PRELUDE, ...Object.entries(lib).map(([n,f])=>_fnSrc(n,f)), _WORKER_DISPATCH].join('\n'); }
let _worker=null,_wSeq=0; const _wPending=new Map();
function computeWorker(){
  if(_worker)return _worker;
  const w=new Worker(URL.createObjectURL(new Blob([buildWorkerSrc()],{type:'text/javascript'})));
  w.onmessage=e=>{ const m=e.data||{}, p=_wPending.get(m.id); if(!p)return;
    if(m.type==='progress'){ if(p.onProgress)try{p.onProgress(m.done,m.total);}catch(err){} return; }
    _wPending.delete(m.id);
    if(m.type==='done')p.resolve(m.out); else p.reject(new Error(m.message||'worker error')); };
  w.onerror=err=>{ // a crashed worker rejects everything in flight and is rebuilt on next use
    for(const [,p] of _wPending)p.reject(new Error('worker crashed'+(err&&err.message?': '+err.message:'')));
    _wPending.clear(); try{w.terminate();}catch(e){} _worker=null; };
  _worker=w; return w;
}
function runInWorker(kind,payload,onProgress){
  return new Promise((resolve,reject)=>{ let w;
    try{ w=computeWorker(); }catch(e){ return reject(e); }
    const id=++_wSeq;
    // Watchdog: a crashed worker rejects via onerror, but a HUNG one used to leave this
    // promise pending forever ("Scanning…" with no recovery short of a reload). Progress
    // messages reset the clock, so long legitimate scans never trip it — only true stalls,
    // which reject (falling back to the sync path) and rebuild the worker on next use.
    let timer=null;
    const arm=()=>{ clearTimeout(timer); timer=setTimeout(()=>{
      _wPending.delete(id);
      try{w.terminate();}catch(e){} _worker=null;
      for(const [,q] of _wPending)q.reject(new Error('worker stalled'));
      _wPending.clear();
      reject(new Error('worker stalled (no progress for 120s)'));
    },120000); };
    _wPending.set(id,{
      resolve:v=>{ clearTimeout(timer); resolve(v); },
      reject:e=>{ clearTimeout(timer); reject(e); },
      onProgress:(d,t)=>{ arm(); if(onProgress)try{onProgress(d,t);}catch(e){} } });
    arm();
    try{ w.postMessage({id,kind,payload}); }catch(e){ clearTimeout(timer); _wPending.delete(id); reject(e); } });
}
// journal subset for the pool only — keeps the message small and ships no unrelated entries
// (plus the day entries those trades were opened on — the check-in conditions read them)
function _journalSubset(trades){ const j={}; for(const t of trades){ if(journal[t.id])j[t.id]=journal[t.id];
  const dk=dayJKey(t.openTime); if(journal[dk]&&!j[dk])j[dk]=journal[dk]; } return j; }
function _excSubset(trades){ const m={}; for(const t of trades){ const e=_excM[t.id]; if(e&&e.maePct!=null)m[t.id]={maePct:e.maePct,mfePct:e.mfePct}; } return m; }
async function minerScan(pool,basis,seed,onProgress){
  try{
    return await runInWorker('miner',{trades:pool,basis,seed,be:_be,
      settings:{tz:settings.tz,coachMode:settings.coachMode},journal:_journalSubset(pool),excursions:_excSubset(pool)},onProgress);
  }catch(e){ // sync fallback: identical math on the main thread
    _srand(seed);
    const V=basis==='pct'?(t=>retPct(t)):(t=>t.net);
    const res=mineInsights(pool,V); const deep=deepScan(pool,V);
    return {res,deep};
  }
}
async function reconstructCompute(fills,frows,addr){
  try{ return await runInWorker('reconstruct',{fills,frows,addr}); }
  catch(e){ return {perp:attributeFunding(reconstructTrades(fills,addr,'perp'),frows),
                    spot:attributeFunding(reconstructTrades(fills,addr,'spot'),[])}; }
}
