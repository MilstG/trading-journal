// Ledger app · part 5 of 15: the Diagnostic's analytics (edge scan, behavior signals, pinned patterns, deep scan, the Monte Carlo batch) and the compute worker; the view itself is part 5b.
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
function _skew(a){ const n=a.length; if(n<3)return 0; const m=_avg(a),sd=_std(a); if(sd===0)return 0;
  const s=a.reduce((x,v)=>x+Math.pow((v-m)/sd,3),0); return (n/((n-1)*(n-2)))*s; }
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
// Behavioral signals behind the plain-language findings — shared by the Diagnostic view
// and the dashboard coach so both always say the same thing. Pure given (closed, stats).
// money: the money rows behind s (concentration is a share of net, which is money); without it the trades carry it
function behaviorSignals(closed, s, money){
  // cost drag: fees as % of gross realized profit (before fees/funding)
  const grossReal = s.net + s.fees - s.fund; // undo costs
  const costDragPct = grossReal>0 ? s.fees/grossReal : null;

  // oversizing: measured rows only (a stand-in entry has no size)
  const f=sizeBucketFn(closed); const sz={}; closed.forEach(t=>{const k=f(t); if(k==null)return; (sz[k]=sz[k]||{n:0,net:0});sz[k].n++;sz[k].net+=t.net;});
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
  const mkts=bucketize(money||closed,'market'); const topMkt=[...mkts].sort((a,b)=>b.net-a.net)[0];
  const absTot=mkts.reduce((x,b)=>x+Math.abs(b.net),0)||1; const conc=topMkt?topMkt.net/absTot:0;

  // --- behavioral: disposition effect (hold winners vs losers) ---
  const wHold=closed.filter(t=>isWin(t.net)&&holdOf(t)>0).map(holdOf);
  const lHold=closed.filter(t=>isLoss(t.net)&&holdOf(t)>0).map(holdOf);
  const avgWHold=wHold.length?_avg(wHold):null, avgLHold=lHold.length?_avg(lHold):null;
  const disposition=(avgWHold!=null&&avgLHold!=null&&avgLHold>avgWHold*1.25);
  // --- tilt: trades opened soon after a loss ---
  const TILT_WIN=60*60000; const byClose=[...closed].filter(t=>t.closeTime).sort((a,b)=>a.closeTime-b.closeTime);
  const _ct=byClose.map(p=>p.closeTime);
  function priorClose(t){ let lo=0,hi=_ct.length-1,idx=-1;
    while(lo<=hi){ const m=(lo+hi)>>1; if(_ct[m]<=t.openTime){idx=m;lo=m+1;} else hi=m-1; }
    while(idx>=0){ if(byClose[idx].id!==t.id) return byClose[idx]; idx--; } return null; }
  const afterLoss=closed.filter(t=>{ if(!measured(t))return false; const p=priorClose(t); return p&&isLoss(p.net)&&(t.openTime-p.closeTime)<=TILT_WIN; }); // a stand-in entry has no entry time
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
/* ============================ deep scan: states / regime / sizing ============================ */
function tradeStates(closed){
  const byOpen=[...closed].filter(measured).sort((a,b)=>a.openTime-b.openTime); // entry states need an entry: a stand-in one gets no state
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
  const pts=closed.map(t=>({x:notionalOf(t)||0,y:retPct(t)})).filter(p=>p.x>0&&p.y!==null); // measured rows only
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

// The Diagnostic's Monte Carlo batch as one pure function, run by both the sync path and the
// compute worker ('diagmc') — same code, same seeds, same order, so the two can't drift. Each
// stage reseeds from its own identity, exactly as the inline code it replaced did: the walk-
// forward CI is walkForward's bootstrap after _srand('wf:'+N), the change point is changePoint
// after renderDistribution's _distSeed. `times` + `chron` rebuild the closed set in close order
// ({closeTime, net} is all either reads); re-sorting it is a no-op since the sort is stable.
function diagMCCompute(p){
  _srand(p.seed);
  const nets=p.nets, chron=p.chron;
  const out={boot:nets.length>=5?bootstrapMeanCI(nets,p.B):null,
    esig:nets.length>=5?edgeSignificance(nets):null,
    mcdd:chron.length>=5?mcMaxDD(chron,p.MCI):null,
    fdd:chron.length>=10?fwdMaxDD(chron,p.HZN,p.FI):null};
  if(p.times){ const T=p.times.map((t,i)=>({closeTime:t,net:chron[i]}));
    _srand(p.wfSeed); const wf=walkForward(T); out.wfCI=wf?wf.wfCI:null;
    _srand(p.cpSeed); out.cp=changePoint(T); }
  return out;
}
// Memo keys. _diagMCKey: the closed set's identity (the Monte Carlo reads only the nets).
// _diagDataKey: that plus everything the heavy sync panels read besides the trades — journal
// (setups, tags, ratings, risk, check-ins), tz buckets, the break-even band and 1R, excursions,
// spot names, coach mode — so a memo hit can only ever return what a recompute would.
function _diagMCKey(closed){ let net=0; for(const t of closed)net+=t.net;
  return [closed.length,closed.length?closed[0].id:'',closed.length?closed[closed.length-1].id:'',net,_be].join('|'); }
function _diagDataKey(closed){ let ct=0, ot=0; for(const t of closed){ ct+=t.closeTime||0; ot+=t.openTime||0; }
  return [_diagMCKey(closed),ct,ot,_oneR,_jrev,settings.tz,settings.tzZone,settings.coachMode,Object.keys(_excM||{}).length,
    Object.keys((spotMaps&&spotMaps.nameByCoin)||{}).length].join('|'); }
// diagScan and behaviorSignals run on every coach rebuild (coachContext, over the view's trades) and
// again on the Diagnostic (over the period's — the same trades when the period is "all"): the tab
// reuses what the coach just computed, and its re-renders reuse their own (_tradesMemo, engine.js).
function diagScanMemo(closed){ return _tradesMemo('scan',closed,_diagDataKey(closed),()=>diagScan(closed)); }
function behaviorSignalsMemo(closed,s,money){ // reads s.net / fees / fund / expectancy besides the trades
  return _tradesMemo('sig',closed,_diagDataKey(closed)+'|'+[s.net,s.fees,s.fund,s.expectancy,money?money.length:0].join('|'),()=>behaviorSignals(closed,s,money)); }

/* ============================ compute worker (main-thread offload) ============================ */
// The two heavy paths — fill→trade reconstruction and the permutation-test miner/deep scan —
// run in a Web Worker so large wallets no longer freeze the UI. Single-file constraint: the
// worker is built at runtime from a Blob of the page's own function sources (no worker.js).
// Everything shipped into the worker is pure modulo the globals in _WORKER_PRELUDE, which are
// re-sent with each request. If Worker construction or execution fails for any reason, the
// wrappers fall back to the original synchronous code path — identical results, just blocking.
const _WORKER_LIB=()=>({_srand,_avg,_std,_erf,_normCdf,_lgamma,_ibetaReg,_tCdf,_wilson,_maxSplitT,retPct,addedToLoser,dcoin,dispMarket,
  mcMaxDD,fwdMaxDD,edgeSignificance,walkForward,diagMCCompute,
  tzParts,tzHour,tzDow,tzLabel,tzMidnight,isWin,isLoss,isPerp,newTrade,tallyFill,measured,notionalOf,holdOf,
  reconstructTrades,attributeFunding,bootstrapMeanCI,tradeStates,stateDefs,stateAnalysis,
  changePoint,sizeDependence,probabilityScan,partitionConditions,dayJKey,checkinPred,minerFams,mineInsights,deepScan});
const _WORKER_PRELUDE="let settings={tz:'local'}, journal={}, _excM={}, spotMaps={nameByCoin:{}}, _be=50, _rng=Math.random, _progress=null, _pool=null;"+
  "const CHECKIN_CONDS="+JSON.stringify(CHECKIN_CONDS)+";";
const _WORKER_DISPATCH="onmessage=function(e){var d=e.data;"+
 "try{var out;"+
 "if(d.kind==='miner'){settings=d.payload.settings||settings;journal=d.payload.journal||{};_excM=d.payload.excursions||{};if(d.payload.be!=null)_be=d.payload.be;"+
 "_srand(d.payload.seed);_progress=function(done,total){postMessage({id:d.id,type:'progress',done:done,total:total});};"+
 "var V=d.payload.basis==='pct'?function(t){return retPct(t);}:function(t){return t.net;};"+
 "var P=d.payload.trades||(_pool&&_pool.key===d.payload.poolKey&&_pool.trades);if(!P)throw new Error('pool missing');"+
 "var res=mineInsights(P,V);var deep=deepScan(P,V);_progress=null;out={res:res,deep:deep};}"+
 "else if(d.kind==='pool'){if(d.payload.reset)_pool={key:d.payload.key,trades:[]};"+ // the miner's pool, kept here across scans (see _workerPool)
 "if(_pool&&_pool.key===d.payload.key){for(var i=0;i<d.payload.trades.length;i++)_pool.trades.push(d.payload.trades[i]);}out={key:_pool&&_pool.key,n:_pool?_pool.trades.length:0};}"+
 "else if(d.kind==='reconstruct'){if(d.payload.tz)settings.tz=d.payload.tz;out={perp:attributeFunding(reconstructTrades(d.payload.fills,d.payload.addr,'perp'),d.payload.frows||[]),"+
 "spot:attributeFunding(reconstructTrades(d.payload.fills,d.payload.addr,'spot'),[])};}"+
 "else if(d.kind==='diagmc'){if(d.payload.be!=null)_be=d.payload.be;out=diagMCCompute(d.payload);}"+ // the sync path's own function — identical values
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
// The miner's trade pool goes to the worker once per data version and stays there: one structured
// clone of 30k trades (fill events and all) is ~400 ms of main-thread time, and it used to be paid
// on every scan. Sent in slices, each its own task, so no single send blocks the page; the worker
// answers each slice with its running count, and the pool only counts as sent once it all arrived.
// Queued, so two sends can't interleave their slices.
const _POOL_SLICE=3000;
let _poolQ=Promise.resolve();
let _minerRun=null; // the scan in flight ({key, p}): a re-render on the same selection joins it
function _poolKey(pool,basis){ let a=0,b=0,c=0; for(const t of pool){ a+=t.net; b+=t.closeTime||0; c+=(t.openTime||0)+(t.maxSize||0); }
  return [basis,pool.length,pool.length?pool[0].id:'',pool.length?pool[pool.length-1].id:'',a,b,c].join('|'); }
function _workerPool(key,pool){
  const send=async()=>{ const w=computeWorker(); if(w._poolKey===key)return; w._poolKey=null; let n=0;
    for(let i=0;i===0||i<pool.length;i+=_POOL_SLICE){ if(i)await new Promise(r=>setTimeout(r,0));
      const r=await runInWorker('pool',{key,reset:i===0,trades:pool.slice(i,i+_POOL_SLICE)}); n=r&&r.key===key?r.n:-1; }
    if(n!==pool.length||_worker!==w)throw new Error('pool missing');
    w._poolKey=key; };
  return (_poolQ=_poolQ.then(send,send));
}
async function minerScan(pool,basis,seed,onProgress,poolKey){
  try{
    const job={basis,seed,be:_be,settings:{tz:settings.tz,coachMode:settings.coachMode},journal:_journalSubset(pool),excursions:_excSubset(pool)};
    if(poolKey){ try{ await _workerPool(poolKey,pool); return await runInWorker('miner',{...job,poolKey},onProgress); }
      catch(e){ if(!/pool missing/.test(e&&e.message))throw e; } } // lost it (a rebuilt worker): ship it inline below
    return await runInWorker('miner',{...job,trades:pool},onProgress);
  }catch(e){ // sync fallback: identical math on the main thread
    _srand(seed);
    const V=basis==='pct'?(t=>retPct(t)):(t=>t.net);
    const res=mineInsights(pool,V); const deep=deepScan(pool,V);
    return {res,deep};
  }
}
async function reconstructCompute(fills,frows,addr){
  try{ return await runInWorker('reconstruct',{fills,frows,addr,tz:settings.tz}); } // the app's clock: spot day rows end at its midnight
  catch(e){ return {perp:attributeFunding(reconstructTrades(fills,addr,'perp'),frows),
                    spot:attributeFunding(reconstructTrades(fills,addr,'spot'),[])}; }
}
