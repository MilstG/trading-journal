// Ledger app · part 6 of 15: price excursions (MAE/MFE) and candles, the replay's shared pieces, auto-refresh; the panels are part 6b.
// ledger.html loads the parts in order as classic scripts sharing one global scope. Code that
// runs while a part loads (not inside a function called later) may only use names declared in
// this part or an earlier one; the boot part runs last. See "Development and testing" in README.md.

/* ============================ MAE/MFE price excursions ============================ */
// How far each trade ran against you (MAE) and in your favor (MFE) between entry and exit,
// measured from exchange candles (candleSnapshot). On-demand because it's fetch-heavy; candles
// are cached in IndexedDB per coin+interval with covered-range tracking, so re-runs and
// overlapping selections only fetch the gaps. Interval is chosen per trade duration so any
// trade costs ≤ ~400 candles. Computation is a linear min/max pass — the fetch dominates, so
// unlike reconstruction/mining this deliberately stays on the main thread.
const EXC_ITVS=[['1m',60e3],['5m',300e3],['15m',900e3],['1h',3600e3],['4h',14400e3],['1d',86400e3]];
// Hyperliquid retains roughly only the most recent ~5000 candles per interval (1m ≈ 3.5 days,
// 5m ≈ 17 days, 15m ≈ 52 days…). Selecting by duration alone made every short trade older than
// a few days request candles that no longer exist — hence skipped. Selection is therefore
// age-aware, and runExcursions retries unmeasured trades at coarser intervals, so the exact
// retention number being wrong self-corrects at the cost of one extra pass.
const EXC_RETAIN=4500; // conservative margin under the ~5000 cap
function excIntervalAt(i){ const c=EXC_ITVS[Math.max(0,Math.min(EXC_ITVS.length-1,i))]; return {name:c[0],ms:c[1]}; }
function excIntervalIdx(durMs,ageMs){ ageMs=ageMs||0;
  for(let i=0;i<EXC_ITVS.length;i++){ const ms=EXC_ITVS[i][1];
    if(durMs/ms<=400 && ageMs<=EXC_RETAIN*ms)return i; }
  return EXC_ITVS.length-1;
}
function excInterval(durMs,ageMs){ return excIntervalAt(excIntervalIdx(durMs,ageMs)); }
// per-trade interval for a given retry pass: pass 0 = age-aware choice, each further pass one coarser
function chooseItv(t,now,pass){ return excIntervalAt(excIntervalIdx(t.closeTime-t.openTime,Math.max(0,now-t.openTime))+(pass||0)); }
// a single candleSnapshot request only returns ~5000 candles; split any merged range that exceeds that
function chunkRanges(ranges,maxSpan){ const out=[];
  for(const r of ranges){ let a=r[0];
    while(r[1]-a>maxSpan){ out.push([a,a+maxSpan]); a+=maxSpan; }
    out.push([a,r[1]]); }
  return out; }
// candles are per venue: a Lighter or Bybit trade is measured on its own exchange's prices
const venueCoin=(venue,coin)=>(venue?VENUE_NAMES[venue]+' ':'')+coin;
// sample candles get keys of their own, so they never sit in (or read from) a real coin's cache
const excKey=(coin,itvName,venue)=>(typeof isDemoData==='function'&&isDemoData()?'demo:':'')+(venue?venue+':':'')+coin+'|'+itvName;
function mergeRanges(wins,gap){ const s=[...wins].sort((a,b)=>a[0]-b[0]); const out=[];
  for(const w of s){ const L=out[out.length-1];
    if(L&&w[0]<=L[1]+(gap||0)){ if(w[1]>L[1])L[1]=w[1]; } else out.push([w[0],w[1]]); }
  return out; }
function uncoveredRanges(want,covered){ let segs=[[want[0],want[1]]];
  for(const c of (covered||[])){ const next=[];
    for(const s of segs){
      if(c[1]<=s[0]||c[0]>=s[1]){ next.push(s); continue; }
      if(c[0]>s[0])next.push([s[0],c[0]]);
      if(c[1]<s[1])next.push([c[1],s[1]]); }
    segs=next; if(!segs.length)break; }
  return segs; }
function planExcursions(trades,now,pass){
  now=now||Date.now();
  const plan=new Map();
  for(const t of trades){
    // a partial-history trade's entry is a stand-in (its opening fills are older than the history): no MAE/MFE
    if(t.isOpen||t.partialHistory||!(t.avgEntry>0)||!(t.closeTime>t.openTime))continue;
    const itv=chooseItv(t,now,pass), venue=candleVenue(t), k=excKey(t.coin,itv.name,venue);
    let e=plan.get(k); if(!e){ e={coin:t.coin,venue,itv,windows:[]}; plan.set(k,e); }
    e.windows.push([t.openTime-itv.ms,t.closeTime+itv.ms]);
  }
  // merge windows closer than 30 candles apart — one request instead of many tiny ones —
  // then re-split anything longer than one request's worth of candles
  for(const e of plan.values())e.ranges=chunkRanges(mergeRanges(e.windows,e.itv.ms*30),e.itv.ms*4000);
  return plan;
}
function mergeCandles(oldC,newC){ const m=new Map();
  for(const c of (oldC||[]))m.set(c[0],c); for(const c of (newC||[]))m.set(c[0],c);
  return [...m.values()].sort((a,b)=>a[0]-b[0]); }
async function fetchCandles(coin,itvName,a,b){
  // Returns {rows, coveredTo}. coveredTo < b when the page cap cut the fetch short — callers
  // must record coverage only up to coveredTo, otherwise the gap would be marked covered,
  // never refetched, and excursions computed over it would be silently wrong forever.
  let start=a; const rows=[]; let pages=0, coveredTo=b;
  while(start<b){ // HL caps ~5000 candles per response; paginate if the range is bigger
    if(pages>=12){ coveredTo=start; break; } // hard page cap — everything past `start` was NOT fetched
    const batch=await hlPost({type:'candleSnapshot',req:{coin,interval:itvName,startTime:Math.floor(start),endTime:Math.floor(b)}});
    if(!Array.isArray(batch)||!batch.length)break; // exchange has nothing (further) in range — that IS coverage
    for(const r of batch)rows.push([+r.t,parseFloat(r.h),parseFloat(r.l),parseFloat(r.c),parseFloat(r.o)]); // open appended last so older [t,h,l,c] cache rows stay index-compatible
    const lastT=+batch[batch.length-1].t;
    if(batch.length<5000||lastT<=start)break;
    start=lastT+1; pages++; await sleep(120);
  }
  return {rows, coveredTo};
}
// candles: sorted [openTime, high, low, close, open?]; the open (index 4) exists only on rows fetched
// after the replay-candlestick build — everything here uses indexes 1-3 so old cache rows are fine.
// A candle counts if it overlaps (openTime, closeTime).
// Also records WHEN the extremes happened: maeAt/mfeAt are fractions of the trade's duration
// (0 = at entry, 1 = at exit, candle-midpoint resolution) — "winners dip early, peak late"
// is a different exit prescription than "winners peak early, then bleed".
function computeExcursion(t,candles,ms){
  const a=t.openTime,b=t.closeTime;
  let lo=0,hi=candles.length; while(lo<hi){ const m=(lo+hi)>>1; if(candles[m][0]+ms<=a)lo=m+1; else hi=m; }
  let h=-Infinity,l=Infinity,n=0,hT=null,lT=null;
  for(let i=lo;i<candles.length&&candles[i][0]<b;i++){ const c=candles[i];
    if(c[1]>h){ h=c[1]; hT=c[0]; } if(c[2]<l){ l=c[2]; lT=c[0]; } n++; }
  if(!n)return null;
  const e=t.avgEntry; if(!(e>0))return null;
  h=Math.max(h,e); l=Math.min(l,e); // your own entry is by definition part of the path
  const short=t.dir==='Short';
  const dur=Math.max(1,b-a);
  const frac=x=>x==null?null:Math.max(0,Math.min(1,(x+ms/2-a)/dur));
  const advT=short?hT:lT, favT=short?lT:hT;
  const maePct=(short?(h-e):(e-l))/e*100, mfePct=(short?(e-l):(h-e))/e*100;
  return {maePct,mfePct,nC:n,
    maeAt:maePct>0?frac(advT):null, mfeAt:mfePct>0?frac(favT):null};
}
function excSummary(rows){
  if(!rows||!rows.length)return null;
  // stats come from precisely measured trades only; coarse rows (retention-forced wide candles,
  // excursion = upper bound) would inflate every MAE/MFE number
  const precise=rows.filter(r=>!r.coarse);
  const use=precise.length?precise:rows, approx=!precise.length;
  const med=a=>{ if(!a.length)return null; const s=[...a].sort((x,y)=>x-y), m=s.length>>1;
    return s.length%2?s[m]:(s[m-1]+s[m])/2; };
  const q=(a,p)=>{ if(!a.length)return null; const s=[...a].sort((x,y)=>x-y);
    return s[Math.min(s.length-1,Math.floor(p*s.length))]; };
  // isWin/isLoss, not net>0: scratch trades inside the break-even band are neither — counting
  // them as winners skewed the stop/capture statistics that everything else calls B/E.
  const W=use.filter(r=>isWin(r.net)),L=use.filter(r=>isLoss(r.net));
  const mfe$=r=>r.mfePct/100*r.notional;
  const capDen=W.reduce((s,r)=>s+mfe$(r),0);
  const capture=capDen>0?W.reduce((s,r)=>s+r.net,0)/capDen:null;
  const left=W.reduce((s,r)=>s+Math.max(0,mfe$(r)-r.net),0);
  const medMfeW=med(W.map(r=>r.mfePct));
  const wR=W.map(r=>r.maeR).filter(x=>x!=null);
  const wMaeAt=W.map(r=>r.maeAt).filter(x=>x!=null), wMfeAt=W.map(r=>r.mfeAt).filter(x=>x!=null);
  return {n:use.length,w:W.length,l:L.length,coarseN:rows.length-precise.length,approx,
    // timing: when winners hit worst dip / peak, as fraction of the hold (0=entry, 1=exit)
    medMaeAtW:med(wMaeAt), medMfeAtW:med(wMfeAt), timedN:Math.min(wMaeAt.length,wMfeAt.length),
    medMaeW:med(W.map(r=>r.maePct)), medMfeW,
    medMaeL:med(L.map(r=>r.maePct)), medMfeL:med(L.map(r=>r.mfePct)),
    winnersMaeP90:q(W.map(r=>r.maePct),0.9), capture, left,
    // R-multiple view of the same stop question, when planned risk / 1R is known
    medMaeWR:med(wR), winnersMaeP90R:q(wR,0.9),
    // losers that reached a typical winner's peak open profit and still closed red
    paperWinners:medMfeW!=null?L.filter(r=>r.mfePct>=medMfeW).length:null};
}
// one measured row per trade; risk (planned $ or 1R fallback) converts excursions into R-multiples.
// coarse = measured with candles wider than half the trade's duration (retention forced a coarse
// interval) — excursion is then an upper bound from candle extremes, so it's flagged and kept out
// of the summary statistics.
function excRow(t,ex,risk){
  const notional=notionalOf(t)||0; // measured rows only
  const r=(risk>0)?risk:null;
  return {id:t.id,coin:t.coin,symbol:t.symbol,dir:t.dir,net:t.net,ret:retPct(t),notional,
    maePct:ex.maePct,mfePct:ex.mfePct,nC:ex.nC,risk:r,
    maeAt:ex.maeAt!=null?ex.maeAt:null, mfeAt:ex.mfeAt!=null?ex.mfeAt:null,
    itvMs:ex.itvMs||null, coarse:!!(ex.itvMs&&(t.closeTime-t.openTime)<2*ex.itvMs),
    maeR:r?ex.maePct/100*notional/r:null, mfeR:r?ex.mfePct/100*notional/r:null};
}
// A spot "open trade" left over from a mostly-sold bag (tiny remainder keeps the trade
// open in reconstruction) is dust, not a position — don't monitor it. Dust = remaining
// size worth under $10 at entry, or under 1% of the position's peak size.
function isDustOpen(t){
  if(t.market!=='spot')return false;
  const rem=Math.max(0,(t.openSz||0)-(t.closeSz||0));
  return rem*(t.avgEntry||0)<10 || (t.maxSize>0&&rem/t.maxSize<0.01);
}
let _excM={}; // trade id → measured excursion row; feeds the journal rows and the miner's excursion families
let _excQuiet=false; // the auto-ratchet's runs write nothing to the status line (they used to overwrite the load summary within seconds)
let _excCache={key:null,rows:null,openRows:null,skippedCoins:null,skippedN:0};
async function runExcursions(closed,openTrades){
  const now=Date.now();
  const base=closed.filter(t=>!t.isOpen&&notionalOf(t)>0); // measured rows only
  // open positions are measured over [openTime, now] via a pseudo-close so the same
  // planner/cache/compute path serves the live monitor (#4)
  const pseudo=(openTrades||[]).filter(t=>t.isOpen&&t.avgEntry>0&&!isDustOpen(t))
    .map(t=>({...t,isOpen:false,closeTime:now,_open:true}));
  // precision ratchet: once a closed trade is measured, the measurement is persisted and
  // reused forever. A trade measured while fine candles still existed stays precise even
  // after retention rolls past it — so the "approximate" bucket is a one-time backfill
  // artifact that only shrinks if excursions are run regularly. Open positions always
  // re-measure (their window grows). Retrying persisted-coarse trades is pointless: age
  // only increases, so the available interval can only get coarser.
  let persisted={v:1,rows:{}};
  try{ const p=await idbGet('excRows'); if(p&&p.v===1&&p.rows&&typeof p.rows==='object')persisted=p; }catch(err){}
  const store=new Map(); const skippedCoins=new Set(); const measured=new Map();
  let pending=[];
  for(const t of base){ const p=persisted.rows[t.id];
    if(p&&p.maePct!=null)measured.set(t.id,{t,ex:{maePct:p.maePct,mfePct:p.mfePct,nC:p.nC,itvMs:p.itvMs,maeAt:p.maeAt!=null?p.maeAt:null,mfeAt:p.mfeAt!=null?p.mfeAt:null}});
    else pending.push(t);
  }
  const reused=measured.size;
  pending=pending.concat(pseudo);
  let grandReq=0;
  const MAXPASS=3; // pass 0 = age-aware interval; each retry pass one interval coarser
  const demo=typeof isDemoData==='function'&&isDemoData(); // sample candles are drawn, never cached
  for(let pass=0;pass<MAXPASS&&pending.length;pass++){
    const plan=planExcursions(pending,now,pass);
    const jobs=[]; let reqTotal=0;
    for(const [k,e] of plan){
      if(skippedCoins.has(venueCoin(e.venue,e.coin)))continue;
      let cache=null; if(!demo){ try{ cache=await idbGet('cnd:'+k); }catch(err){} }
      if(!cache||cache.v!==1||!Array.isArray(cache.candles)||!Array.isArray(cache.ranges))cache={v:1,candles:[],ranges:[]};
      const missing=[]; for(const r of e.ranges)for(const u of uncoveredRanges(r,cache.ranges))if(u[1]-u[0]>e.itv.ms)missing.push(u);
      jobs.push({k,e,cache,missing}); reqTotal+=missing.length;
    }
    if(grandReq+reqTotal>150)throw new Error('this selection needs '+(grandReq+reqTotal)+'+ candle requests — narrow the period or date range and re-run (already-fetched candles stay cached)');
    let req=0;
    for(const j of jobs){
      for(const u of j.missing){
        req++; grandReq++;
        if(!_excQuiet)setStatus(`Fetching candles… ${req}/${reqTotal}${pass?` (retry pass ${pass})`:''} (${j.e.coin} ${j.e.itv.name})`,true);
        try{ const c=await venueFetchCandles(j.e.venue,j.e.coin,j.e.itv.name,u[0],u[1]);
          j.cache.candles=mergeCandles(j.cache.candles,c.rows);
          if(c.coveredTo>u[0]) j.cache.ranges=mergeRanges([...j.cache.ranges,[u[0],c.coveredTo]],1);
          await sleep(90);
        }catch(err){ skippedCoins.add(venueCoin(j.e.venue,j.e.coin)); } // no candles for this coin (some HIP-3/spot names) — skip, don't sink the run
      }
      if(!demo){ try{ await idbSet('cnd:'+j.k,j.cache); }catch(err){} }
      store.set(j.k,{candles:j.cache.candles,ms:j.e.itv.ms});
    }
    const still=[];
    for(const t of pending){
      if(skippedCoins.has(venueCoin(candleVenue(t),t.coin)))continue; // coin-level failure: retrying coarser won't help
      const itv=chooseItv(t,now,pass), s=store.get(excKey(t.coin,itv.name,candleVenue(t)));
      const ex=s?computeExcursion(t,s.candles,s.ms):null;
      if(ex){ ex.itvMs=itv.ms; measured.set(t.id,{t,ex}); }
      else still.push(t); // likely beyond this interval's retention — coarser candles next pass
    }
    pending=still;
  }
  // persist any newly measured closed trades (never open ones — their window still grows)
  let dirty=false;
  for(const {t,ex} of measured.values()){ if(demo||t._open||persisted.rows[t.id])continue; // the sample's stay in memory
    persisted.rows[t.id]={maePct:ex.maePct,mfePct:ex.mfePct,nC:ex.nC,itvMs:ex.itvMs,
      maeAt:ex.maeAt!=null?ex.maeAt:null, mfeAt:ex.mfeAt!=null?ex.mfeAt:null,
      coarse:!!(ex.itvMs&&(t.closeTime-t.openTime)<2*ex.itvMs)}; dirty=true;
  }
  if(dirty){ try{ await idbSet('excRows',persisted); }catch(err){} schedulePersist(); }
  const rows=[],openRows=[]; let skippedN=base.filter(t=>!measured.has(t.id)).length;
  for(const {t,ex} of measured.values()){
    if(t._open){ const r=excRow(t,ex,riskFor(t)); openRows.push({...r,ageMs:now-t.openTime}); }
    else if(retPct(t)!==null)rows.push(excRow(t,ex,riskFor(t)));
    else skippedN++;
  }
  return {rows,openRows,skippedCoins:[...skippedCoins],skippedN,reused};
}
/* ============================ trade replay (per-trade candle chart) ============================ */
let _replayChart=null,_replayFor=null;
// open price for candle i: the stored open when the cache row has one (5-element rows, new fetches),
// else the previous candle's close (a perp trades continuously, so prev close IS the open),
// else its own close/midpoint. Old 4-element cache rows are handled honestly, never fabricated flat.
function candleOpen(candles,i){ const k=candles[i];
  if(isFinite(k[4]))return k[4];
  if(i>0&&isFinite(candles[i-1][3]))return candles[i-1][3];
  return isFinite(k[3])?k[3]:(k[1]+k[2])/2; }
async function ensureTradeCandles(t, pad){
  // fetch (cache-aware) candles for one trade's window, falling back coarser like the main scan.
  // pad: {before, after} candles of context around it (one each by default; replay drills ask for more)
  // Sample candles are drawn, not fetched, and never cached: the sample trades move with the clock.
  const now=Date.now(), demo=typeof isDemoData==='function'&&isDemoData();
  for(let pass=0;pass<3;pass++){
    const itv=chooseItv(t,now,pass), k=excKey(t.coin,itv.name,candleVenue(t));
    let cache=null; if(!demo){ try{ cache=await idbGet('cnd:'+k); }catch(e){} }
    if(!cache||cache.v!==1||!Array.isArray(cache.candles)||!Array.isArray(cache.ranges))cache={v:1,candles:[],ranges:[]};
    const pb=((pad&&pad.before)||1)*itv.ms, pa=((pad&&pad.after)||1)*itv.ms;
    const want=[t.openTime-pb,(t.isOpen?now:t.closeTime)+pa];
    for(const u of uncoveredRanges(want,cache.ranges)){
      if(u[1]-u[0]<=itv.ms)continue;
      try{ const c=await venueFetchCandles(candleVenue(t),t.coin,itv.name,u[0],u[1]);
        cache.candles=mergeCandles(cache.candles,c.rows);
        if(c.coveredTo>u[0]) cache.ranges=mergeRanges([...cache.ranges,[u[0],c.coveredTo]],1);
      }catch(e){ return null; }
    }
    if(!demo){ try{ await idbSet('cnd:'+k,cache); }catch(e){} }
    const a=want[0], b=want[1];
    const win=cache.candles.filter(c=>c[0]>=a&&c[0]<=b);
    if(win.length)return {candles:win,itv};
  }
  return null;
}
// The adverse and favorable extremes between entry and exit (or now, for an open trade),
// located on the candle that printed them — the MAE/MFE made visible. Pure.
function replayExtremes(t,candles,ms){
  const e=t.avgEntry; if(!(e>0)||!candles||!candles.length)return null;
  const a=t.openTime, b=t.isOpen?Infinity:t.closeTime, short=t.dir==='Short';
  let hi=null, lo=null;
  for(const c of candles){ if(c[0]+ms<=a||c[0]>=b)continue;
    if(isFinite(c[1])&&(!hi||c[1]>hi.y))hi={x:c[0],y:c[1]};
    if(isFinite(c[2])&&(!lo||c[2]<lo.y))lo={x:c[0],y:c[2]}; }
  if(!hi||!lo)return null;
  const w=short?hi:lo, bst=short?lo:hi;
  const pct=y=>(short?(e-y):(y-e))/e*100;
  return {worst:pct(w.y)<0?{...w,kind:'worst',pct:pct(w.y)}:null, best:pct(bst.y)>0?{...bst,kind:'best',pct:pct(bst.y)}:null};
}
/* ---- bar-by-bar replay: watch the trade unfold the way you lived it ---- */
// The chart above, played forward one candle at a time from a few bars before the entry:
// fills appear as they happened, the exit line and the worst/best marks only at the end, and
// a readout shows the position and its P&L at each bar (gross, before fees). The journal note
// sits underneath, so the replay is a review: what did you know, and what did you do?
let _replayTimer=null;
// Pure. Position and P&L at time ts with the bar's close at `price`, from the trade's fill
// events [time, px, size, +1 add | -1 reduce]: running average entry, realized on reductions.
function replayPnlAt(dir, events, ts, price){
  const sgn=dir==='Short'?-1:1; let pos=0, avg=0, realized=0;
  for(const e of events||[]){ if(e[0]>ts)break; const px=e[1], sz=e[2];
    if(e[3]>0){ avg=pos+sz>0?(avg*pos+px*sz)/(pos+sz):px; pos+=sz; }
    else { const q=Math.min(sz,pos); realized+=(px-avg)*q*sgn; pos-=q; if(pos<=1e-12){ pos=0; } } }
  const open=pos>0&&isFinite(price)?(price-avg)*pos*sgn:0;
  return {pos,avg:pos>0?avg:null,realized,open,total:realized+open};
}
/* ============================ benchmark: you vs buy-and-hold ============================ */
let _diagMC={key:null}; // memoized Monte Carlo results for renderDiagnostic (see mcKey there)
/* ============================ auto-refresh + automatic MAE/MFE ratchet ============================ */
let _loading=false,_excBusy=false;
const _ratchetTried=new Set(); // attempted this session but unmeasurable (no candles / retention) — don't replan + refetch them on every 3-minute auto-refresh
async function autoRatchet(){
  // silently lock in precise MAE/MFE for recently closed trades after each data load —
  // the ratchet then maintains itself without ever pressing the excursions button
  if(_excBusy)return; _excBusy=true;
  try{
    const now=Date.now();
    let persisted=null; try{ persisted=await idbGet('excRows'); }catch(e){}
    const have=(persisted&&persisted.v===1&&persisted.rows)||{};
    const recent=closedTrades(t=>notionalOf(t)>0 // completed, measured trades: no spot day rows, no balance that merely left, no stand-in entry
      &&t.closeTime>now-21*86400e3&&!have[t.id]&&!_ratchetTried.has(t.id));
    if(!recent.length)return;
    // the newest 25 per run: the rest follow on the next refresh instead of queueing a hundred candle requests at start
    recent.sort((a,b)=>b.closeTime-a.closeTime); recent.length=Math.min(recent.length,25);
    _excQuiet=true;
    const out=await runExcursions(recent,[]);
    const got=new Set(out.rows.map(r=>r.id));
    for(const t of recent)if(!got.has(t.id))_ratchetTried.add(t.id);
    for(const r of out.rows)_excM[r.id]=r;
    schedulePersist();
  }catch(e){ /* budget guard or transient — the manual button still works */ }
  finally{ _excBusy=false; _excQuiet=false; }
}
let _autoTimer=null;
function setupAutoRefresh(){
  if(_autoTimer)clearInterval(_autoTimer);
  const btn=$('autoBtn');
  const on=settings.autoRefresh!==false;
  if(btn){ btn.textContent='⟳ auto: '+(on?'on':'off'); btn.classList.toggle('on',on);
    btn.onclick=()=>{ settings.autoRefresh=!(settings.autoRefresh!==false); Store.set(S_KEY,settings); setupAutoRefresh(); }; }
  if(!on)return;
  _autoTimer=setInterval(()=>{
    // a hidden tab waits, unless Pulse's tilt alerts want it during a live session (pzTiltBgWanted)
    if(document.visibilityState!=='visible'&&!(typeof pzTiltBgWanted==='function'&&pzTiltBgWanted()))return;
    if(_loading||!settings.wallets.length)return;
    loadAll({auto:true});
  },180000);
}

let _minerCache={key:null,res:null,deep:null};
let _minerToken=0; // stale-render guard: only the latest scan paints the panel
