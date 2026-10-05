// Ledger app · part 3 of 15: trade reconstruction, state, formatting, risk/R, projection, edge decay, the pattern miner, analytics.
// ledger.html loads the parts in order as classic scripts sharing one global scope. Code that
// runs while a part loads (not inside a function called later) may only use names declared in
// this part or an earlier one; the boot part runs last. See "Development and testing" in README.md.

/* ============================ engine ============================ */
function isPerp(coin){ return !coin.includes('/') && !coin.startsWith('@'); }
function newTrade(coin,f,dir,openSz,openNotional,fills){
  return {coin,dir,openTime:f.time,closeTime:f.time,openSz:openSz||0,openNotional:openNotional||0,
    closeSz:0,closeNotional:0,pnl:0,fees:0,fills:fills||0,maxSize:openSz||0,
    makerFills:0,takerFills:0,makerFee:0,takerFee:0,makerNotional:0,takerNotional:0,liquidated:false,firstEntryPx:parseFloat(f.px),
    events:[]}; }   // events: compact [time,px,sz,k] per fill (k=+1 open/add, -1 close) — powers the replay chart's fill markers
// portion: the part of the fill's size that belongs to THIS trade (a flip fill is split
// between the trade it closes and the one it opens); defaults to the whole fill.
// liq: whether this fill liquidated THIS wallet (reconstructTrades decides, see liqOf); left out, the
// bare presence of a liquidation field counts, as it did before.
function tallyFill(t,f,fee,portion,liq){ const notl=(portion!=null?portion:Math.abs(parseFloat(f.sz||0)))*parseFloat(f.px||0);
  // crossed is tri-state: true=taker, false=maker, undefined=unknown (CSV imports carry
  // no execution style — fabricating either side would feed the miner a fake signal)
  if(f.crossed===true){ t.takerFills++; t.takerFee+=fee; t.takerNotional+=notl; }
  else if(f.crossed===false){ t.makerFills++; t.makerFee+=fee; t.makerNotional+=notl; }
  else { t.unkFills=(t.unkFills||0)+1; t.unkNotional=(t.unkNotional||0)+notl; }
  if(liq!=null?liq:(f.liquidation || /liquidat/i.test(f.dir||''))) t.liquidated=true; }
function reconstructTrades(fills, addr, market){
  // Spot fees paid in a stable quote are dollars; anything else (a buy's fee comes out of the
  // token bought) is in the base token and is converted at the fill price.
  const SPOT_QUOTES={USDC:1,USDT0:1,USDT:1,USDH:1,USDE:1};
  // each recent fill's realized result (closedPnl − fee), on the trade it belongs to: the daily loss
  // limit counts what was realized today, including partial closes of a position still open
  const rzSince=Date.now()-3*86400000;
  const pred = market==='spot' ? (c=>!isPerp(c)) : (c=>isPerp(c));
  // Fills that share a millisecond can arrive in any order (a close and a reopen in one ms, TWAP
  // slices): within such a group, one coin's fills are put in the order their positions chain —
  // each fill's startPosition is where the one before it left the position.
  const chainSameTime=arr=>{ const pos={};
    for(let i=0;i<arr.length;){ let j=i+1; while(j<arr.length&&arr[j].time===arr[i].time)j++;
      if(j-i>1){ const byCoin=new Map(); for(let k=i;k<j;k++){ const c=arr[k].coin; if(!byCoin.has(c))byCoin.set(c,[]); byCoin.get(c).push(arr[k]); }
        const out=[];
        for(const [c,g] of byCoin){ if(g.length<2){ out.push(...g); continue; }
          const sp=f=>parseFloat(f.startPosition), end=f=>sp(f)+(f.side==='B'?1:-1)*Math.abs(parseFloat(f.sz)), same=(a,b)=>Math.abs(a-b)<=1e-9*Math.max(1,Math.abs(a),Math.abs(b));
          const left=g.slice(), seq=[];
          // start where the position stood before this millisecond, else at the fill no other fill leads into
          let cur=pos[c]; let k=cur!=null?left.findIndex(f=>same(sp(f),cur)):-1;
          if(k<0)k=left.findIndex(f=>!left.some(o=>o!==f&&same(end(o),sp(f))));
          while(left.length){ if(k<0){ seq.push(...left); break; } const f=left.splice(k,1)[0]; seq.push(f); cur=end(f); k=left.findIndex(o=>same(sp(o),cur)); }
          out.push(...seq); }
        for(let k=i;k<j;k++)arr[k]=out[k-i]; }
      for(let k=i;k<j;k++){ const f=arr[k]; pos[f.coin]=parseFloat(f.startPosition)+(f.side==='B'?1:-1)*Math.abs(parseFloat(f.sz)); }
      i=j; }
    return arr; };
  const sorted=chainSameTime(fills.filter(f=>pred(f.coin)).sort((a,b)=>a.time-b.time));
  // Hyperliquid writes the liquidation field on BOTH sides of a liquidation: the user whose position
  // was force-closed and the maker whose resting order filled it. Only the former was liquidated;
  // the latter's trade (often a winner) used to wear the LIQ badge too. A field without the user
  // (imported CSVs: Bybit's BustTrade, Binance's liquidation type) still counts.
  const me=addr&&/^0x[0-9a-f]{40}$/i.test(String(addr))?String(addr).toLowerCase():null;
  const liqOf=f=>{ const l=f.liquidation; if(l&&typeof l==='object'&&l.liquidatedUser&&me)return String(l.liquidatedUser).toLowerCase()===me;
    return !!(l||/liquidat/i.test(f.dir||'')); };
  const open={}, trades=[], EPS=1e-9, spot=market==='spot', lastAfter={};
  // Spot: a position runs from the balance leaving zero to its return to zero (dust aside): partial
  // sells stay inside it, so a stack nibbled around for months is one open position, not a trade a
  // day. Its money is counted apart from it, by the day it was realized (dayRz: one row per coin and
  // day, flagged spotRz), so the equity curve, the calendar and the totals see spot P&L when it
  // happened while the trade statistics see only round trips. The day is the app's when the
  // time-zone helpers are here (the page, the worker, the server), else UTC.
  const dayOf=typeof tzMidnight==='function'?(ms=>{ try{ return tzMidnight(ms); }catch(e){ return Math.floor(ms/86400000)*86400000; } }):(ms=>Math.floor(ms/86400000)*86400000);
  const dayRz={};
  for(const f of sorted){
    const coin=f.coin, sz=Math.abs(parseFloat(f.sz));
    if(!(sz>0))continue; // a zero-size fill moves nothing (it used to open a phantom trade)
    const signed=f.side==='B'?sz:-sz;
    const before=parseFloat(f.startPosition);
    const px=parseFloat(f.px), pnl=parseFloat(f.closedPnl||'0');
    let fee=parseFloat(f.fee||'0'), feeBasis=0;
    if(spot&&f.feeToken&&(f.side==='B'?f.feeToken!=='USDC':!SPOT_QUOTES[f.feeToken])){ fee=fee*px; feeBasis=fee; } // a buy's fee is in the token bought; closedPnl already counts it in the cost basis
    let after=before+signed;
    // spot exits leave dust (fees come out of the token bought): under $1 or 1/10,000 of the position counts as flat
    if(spot&&Math.abs(after)>EPS&&Math.abs(after)<Math.abs(before)&&(Math.abs(after)*px<1||Math.abs(after)<=1e-4*Math.abs(before)))after=0;
    // Perps: a fill that starts from a position the fills so far don't reach is a seam — fills the
    // exchange no longer serves (TWAP slices older than ~3 months, history past its retention)
    // moved the position in between. startPosition is the exchange's own, so the position is
    // trusted as is; the open trade is told what it missed instead of being silently welded to
    // whatever comes next (a fresh entry used to be filed as an add to a trade that had in fact
    // already closed off the record). Spot balances move without fills (transfers, staking,
    // borrowing), so there a jump proves nothing and the check stays off.
    if(!spot&&open[coin]&&lastAfter[coin]!=null){
      const prev=lastAfter[coin], jump=before-prev;
      if(Math.abs(jump)>Math.max(EPS,1e-6*Math.max(Math.abs(prev),Math.abs(before)))){
        const t0=open[coin];
        t0.gaps=(t0.gaps||0)+1; t0.gapSz=(t0.gapSz||0)+Math.abs(jump); t0.gapNotional=(t0.gapNotional||0)+Math.abs(jump)*px; // valued at the nearest known price
        (t0.gapTimes=t0.gapTimes||[]).push(f.time); // the seam is somewhere before this fill
        const closedOff=Math.abs(before)<EPS||(prev>0)!==(before>0);
        // shrunk, closed or flipped in fills we never saw: that P&L is gone for good — the trade's
        // result is incomplete and it stays out of the stats. Grown off the record: only the entry
        // is unknown; what closes later still carries the exchange's own closedPnl.
        if(closedOff||Math.abs(before)<Math.abs(prev))t0.offRecord=true; else t0.partialHistory=true;
        if(closedOff){ // ends where its last known fill left it; what this fill does starts a fresh trade
          if(!(t0.openSz>0))t0.partialHistory=true;
          t0.avgEntry=t0.openSz>0?t0.openNotional/t0.openSz:t0.firstEntryPx; t0.avgExit=t0.closeSz>0?t0.closeNotional/t0.closeSz:null;
          t0.durationMs=t0.closeTime-t0.openTime; trades.push(t0); delete open[coin]; }
      }
    }
    // Spot balances move without fills (a transfer, staking, a send). A position whose balance left
    // without a sell ends where its last fill left it (movedOut); one whose balance moved while held is
    // noted (balanceMoved) and carries on from the exchange's own figure.
    if(spot&&open[coin]&&lastAfter[coin]!=null&&Math.abs(before-lastAfter[coin])>Math.max(EPS,1e-6*Math.max(Math.abs(before),Math.abs(lastAfter[coin])))){
      const t0=open[coin]; t0.balanceMoved=true;
      if(Math.abs(before)<EPS){ t0.movedOut=true; if(!(t0.openSz>0))t0.partialHistory=true;
        t0.avgEntry=t0.openSz>0?t0.openNotional/t0.openSz:t0.firstEntryPx; t0.avgExit=t0.closeSz>0?t0.closeNotional/t0.closeSz:null; t0.durationMs=t0.closeTime-t0.openTime; trades.push(t0); delete open[coin]; }
    }
    const wasFlat=!spot&&lastAfter[coin]!=null&&Math.abs(lastAfter[coin])<EPS; // the fills saw this coin go flat, so a new trade must start from 0
    lastAfter[coin]=after;
    let t=open[coin];
    // a fill acting on a position held before the history began (closing it, or flipping through it)
    // belongs to the side that was held; a fresh position takes the side it opens
    if(!t){ t=open[coin]=newTrade(coin,f,(Math.abs(before)>EPS?before>0:after>0)?'Long':'Short',0,0,0);
      if(Math.abs(before)>EPS){ t.partialHistory=true; // held before its first served fill: the entry is unknown, adds or not
        // the fills saw this coin go flat earlier, so the position it starts from was opened in fills we
        // never got: a seam like the others (it was counted as none, so coverage read whole)
        if(wasFlat){ t.gaps=1; t.gapSz=Math.abs(before); t.gapNotional=Math.abs(before)*px; t.gapTimes=[f.time]; } } }
    const flipped=Math.abs(before)>EPS&&Math.abs(after)>EPS&&(before>0)!==(after>0);
    // a flip fill's notional and fee are split by size between the closing and opening trade —
    // counting the whole fill on both inflated volume, taker share and the fee-tier model
    const feeHere=flipped&&sz>0?fee*Math.abs(before)/sz:fee;
    const liq=liqOf(f);
    if(spot){ // the day's realized result on this coin: spot money lives here, by the day it happened
      const dk=dayOf(f.time), rk=coin+'|'+dk; let r=dayRz[rk]; if(!r){ r=dayRz[rk]=newTrade(coin,f,'Spot',0,0,0); r.spotRz=true; r.dayStart=dk; }
      r.fills++; r.fees+=fee; if(feeBasis)r.feesInBasis=(r.feesInBasis||0)+feeBasis; r.pnl+=pnl; r.closeTime=f.time;
      if(signed>0){ r.openSz+=sz; r.openNotional+=sz*px; } else { r.closeSz+=sz; r.closeNotional+=sz*px; }
      r.maxSize=Math.max(r.maxSize,Math.abs(after)); tallyFill(r,f,fee,null,liq); r.events.push([f.time,px,sz,signed>0?1:-1]); }
    t.fills++; t.fees+=feeHere; if(feeBasis)t.feesInBasis=(t.feesInBasis||0)+feeBasis; t.pnl+=pnl; t.closeTime=f.time; tallyFill(t,f,feeHere,flipped?Math.abs(before):null,liq);
    if(f.time>rzSince)(t.rz||(t.rz=[])).push([f.time,pnl-(fee-feeBasis)]); // the whole fill once (a flip's opening fee included; a spot buy's token fee is already in closedPnl's basis)
    if(flipped){
      // one fill that closes the whole |before| position AND opens |after| the other way:
      // only the closing portion belongs to this trade; the opening portion seeds the next trade.
      t.closeSz+=Math.abs(before); t.closeNotional+=Math.abs(before)*px; t.maxSize=Math.max(t.maxSize,Math.abs(before));
      t.events.push([f.time,px,Math.abs(before),-1]);
    } else if(Math.abs(after)>Math.abs(before)+EPS){ t.openSz+=sz; t.openNotional+=sz*px; t.maxSize=Math.max(t.maxSize,Math.abs(after)); t.events.push([f.time,px,sz,1]); }
    else { t.closeSz+=sz; t.closeNotional+=sz*px; t.maxSize=Math.max(t.maxSize,Math.abs(before)); t.events.push([f.time,px,sz,-1]); }
    if(Math.abs(after)<EPS||flipped){
      // openSz===0: the entry predates the observed fill history (page cap / cache boundary).
      // The exit-price fallback keeps PnL right (closedPnl comes from the API), but
      // entry-derived stats would be fiction — flag it; retPct/entryDrift go null below.
      if(!(t.openSz>0)) t.partialHistory=true;
      t.avgEntry=t.openSz>0?t.openNotional/t.openSz:px;
      t.avgExit=t.closeSz>0?t.closeNotional/t.closeSz:px;
      t.durationMs=t.closeTime-t.openTime;
      trades.push(t); delete open[coin];
      if(Math.abs(after)>EPS){ const nt=newTrade(coin,f,after>0?'Long':'Short',Math.abs(after),Math.abs(after)*px,0);
        nt.maxSize=Math.abs(after); nt.fills++; nt.fees+=fee-feeHere; tallyFill(nt,f,fee-feeHere,Math.abs(after),liq); nt.events.push([f.time,px,Math.abs(after),1]); open[coin]=nt; }
    }
  }
  for(const c in open){ const t=open[c];
    t.isOpen=true; if(!(t.openSz>0))t.partialHistory=true; t.avgEntry=t.openSz>0?t.openNotional/t.openSz:0;
    t.avgExit=null; t.durationMs=Date.now()-t.openTime; trades.push(t); }
  if(spot)for(const k in dayRz){ const r=dayRz[k]; r.isOpen=false; r.avgEntry=r.openSz>0?r.openNotional/r.openSz:(r.closeSz>0?r.closeNotional/r.closeSz:r.firstEntryPx);
    r.avgExit=r.closeSz>0?r.closeNotional/r.closeSz:null; r.durationMs=r.closeTime-r.openTime; trades.push(r); }
  trades.forEach(t=>{ t.market=market; if(spot){ t.dir='Spot'; if(!t.spotRz)t.spotPos=true; }
    // entry drift: how far your size-weighted entry landed from your first fill, in the adverse direction
    t.entryDrift=(!t.partialHistory&&!t.spotRz&&t.firstEntryPx>0&&t.avgEntry>0)
      ? (t.dir==='Short' ? t.firstEntryPx/t.avgEntry-1 : t.avgEntry/t.firstEntryPx-1) : null;
    // a spot day row is keyed by its day, a position (spot or perp) by its first fill, so notes stay put across rebuilds
    t.id=(market==='spot'?(addr||'paste')+':spot:':(addr||'paste')+':')+t.coin+':'+(t.spotRz?'rz:'+t.dayStart:t.openTime); });
  return trades.sort((a,b)=>b.openTime-a.openTime);
}
// The same fill served twice at two granularities. userFillsByTime is asked with aggregateByTime,
// which folds the pieces of one order filled within one millisecond into a single fill; the archive
// (and the TWAP slice endpoint) keep the pieces. Merged, the combined fill and its pieces move the
// position twice over: a seam on every later fill of the coin, size and P&L counted double (this
// wallet's seams went 256 → 1593 the first time archive fills met API fills). Within one coin,
// order, side and millisecond, a fill whose position range is covered by another's is that other's
// piece and goes; pieces that only touch end to end (a slice filled in two) all stay. Order is kept.
function dedupeFills(fills){
  if(!Array.isArray(fills)||fills.length<2)return fills;
  const groups=new Map();
  for(let i=0;i<fills.length;i++){ const f=fills[i]; if(!f)continue; const k=f.coin+'|'+f.oid+'|'+f.time+'|'+f.side; const g=groups.get(k); if(g)g.push(i); else groups.set(k,[i]); }
  let drop=null;
  for(const g of groups.values()){ if(g.length<2)continue;
    const iv=[]; for(const i of g){ const f=fills[i], s=parseFloat(f.startPosition), sz=Math.abs(parseFloat(f.sz)); if(!isFinite(s)||!(sz>0))continue; const e=s+(f.side==='B'?sz:-sz); iv.push({i,lo:Math.min(s,e),hi:Math.max(s,e),span:sz}); }
    iv.sort((a,b)=>b.span-a.span||a.i-b.i); // the widest first: a combined fill before its pieces
    const kept=[];
    for(const x of iv){
      // covered when it overlaps a kept range by at least half the smaller of the two: a spot
      // piece's start is off by its fee in the base token, which is nowhere near half a fill
      const covered=kept.some(k=>Math.min(x.hi,k.hi)-Math.max(x.lo,k.lo)>=0.5*Math.min(x.span,k.span));
      if(covered)(drop||(drop=new Set())).add(x.i); else kept.push(x);
    }
  }
  return drop?fills.filter((f,i)=>!drop.has(i)):fills;
}
// How much of a wallet's history the fills the exchange still serves explain. Volume: the served
// fills' notional per market against the exchange's own all-time volume (the portfolio endpoint's
// vlm). Seams: the position changes reconstructTrades found no fill for, their notional at the
// nearest known price and the months they fall in; offRecord: the trades whose result those seams
// took. Hyperliquid serves TWAP slice fills for about three months and ordinary fills for a long
// but finite time, so a wallet followed from day one keeps everything in its cache, while one added
// later can never get the older fills back — this is what tells the two apart. Pure.
function coverageOf(fills, trades, port){
  let perpVol=0, spotVol=0;
  for(const f of (fills||[])){ const v=Math.abs(parseFloat(f.sz)*parseFloat(f.px))||0; if(isPerp(String(f.coin||'')))perpVol+=v; else spotVol+=v; }
  let gaps=0, gapNotional=0, offRecord=0, gapFirst=null, gapLast=null; const months={};
  for(const t of (trades||[])){
    if(t.offRecord&&!t.isOpen)offRecord++;
    if(!t.gaps)continue;
    gaps+=t.gaps; gapNotional+=t.gapNotional||0;
    const times=t.gapTimes||[]; const per=times.length?(t.gapNotional||0)/times.length:0;
    for(const ms of times){ if(gapFirst==null||ms<gapFirst)gapFirst=ms; if(gapLast==null||ms>gapLast)gapLast=ms;
      const k=new Date(ms).toISOString().slice(0,7); months[k]=(months[k]||0)+per; }
  }
  const exchPerpVlm=port&&isFinite(port.perpVlm)&&port.perpVlm>0?port.perpVlm:null, exchVlm=port&&isFinite(port.vlm)&&port.vlm>0?port.vlm:null;
  return {perpVol, spotVol, exchPerpVlm, exchVlm,
    perpShare:exchPerpVlm?Math.min(1,perpVol/exchPerpVlm):null, allShare:exchVlm?Math.min(1,(perpVol+spotVol)/exchVlm):null,
    gaps, gapNotional, offRecord, gapFirst, gapLast, months};
}
function attributeFunding(trades,fundingRows){
  // Per coin: sorted rows + prefix sums, then two binary searches per trade. The old full
  // scan per trade was O(trades × rows) per coin — ~35M row visits for a 2-year account,
  // re-run on every reconstruction (including each 3-minute auto-refresh).
  const byCoin={};
  for(const r of fundingRows){ (byCoin[r.coin]=byCoin[r.coin]||[]).push(r); }
  const pre={};
  for(const c in byCoin){ const rows=byCoin[c].sort((a,b)=>a.time-b.time);
    const p=new Float64Array(rows.length+1);
    for(let i=0;i<rows.length;i++)p[i+1]=p[i]+rows[i].usdc;
    pre[c]=p; }
  const lb=(rows,x)=>{ let lo=0,hi=rows.length; while(lo<hi){ const m=(lo+hi)>>1; if(rows[m].time<x)lo=m+1; else hi=m; } return lo; }; // first index with time >= x
  for(const t of trades){
    const rows=byCoin[t.coin];
    // a spot buy's fee is in the token and already inside closedPnl's cost basis: shown in fees, not subtracted twice
    if(!rows||!rows.length){ t.funding=0; t.net=t.pnl-t.fees+(t.feesInBasis||0); continue; }
    const end=t.isOpen?Date.now():t.closeTime;
    const a=lb(rows,t.openTime), b=lb(rows,end+1); // [openTime, end] inclusive
    const f=pre[t.coin][b]-pre[t.coin][a];
    t.funding=f; t.net=t.pnl - t.fees + (t.feesInBasis||0) + f;   // all-in realized (funding usdc: +received / -paid)
  }
  return trades;
}

/* ============================ state ============================ */
let allTrades=[], fundingRows=[], fundingTotal=0, openPositions=[], accountValue=null;
let ledFlows=[], ledSkipped=0; // classified capital flows (deposits/withdrawals/transfers) across loaded wallets
let _fetchHealth={funding:false,ledger:false,twap:false}; // partial-fetch flags for the persistent data-health line
// how much of the account's history the fills the exchange still serves explain (data-io.js: coverageOf), across loaded wallets
let dataCoverage=null;
let spotHoldings=[], spotAccountValue=null, spotMaps={nameByCoin:{},markBySym:{'USDC':1}};
// portfolio-margin wallets' balances (one pool for spot and perps): counted in both accountValue and
// spotAccountValue, so a combined total takes this off to count them once
let unifiedAccountValue=null;
let hlPnl={all:null,perp:null};
let fillsTruncated=[];
let activeTab='dash';
let view='perp';
let period=0, sortKey='openTime', sortDir=-1, expandedId=null;
let page=1, pageSize=10, _tblSig='';
// spot trades read as pairs ("HYPE/USDC") so they never merge with the perp of the same name
const dcoin=t=>{ const s=t.symbol; const base=(s&&!/^@\d+$/.test(s))?s:((spotMaps.nameByCoin&&spotMaps.nameByCoin[t.coin])||s||t.coin);
  if(t.market!=='spot'||String(base).includes('/'))return base; return base+'/'+(t.quote||(spotMaps.quoteByCoin&&spotMaps.quoteByCoin[t.coin])||'USDC'); };
// display-only: HIP-3 markets arrive as "dex:COIN" — show the coin first with the builder dex in parens.
const dispMarket=k=>{ const s=String(k); const m=s.match(/^([A-Za-z0-9_-]+):(.+)$/); return m?m[2]+' ('+m[1]+' dex)':s; };
const $=id=>document.getElementById(id);
let _stTimer=null;
function setStatus(m,busy){ const s=$('status'); s.className='';
  // textContent, not innerHTML: messages interpolate wallet labels and coin/dex names,
  // which arrive from imported backups and the exchange — identifiers, never markup.
  s.textContent=m;
  if(busy){ const d=document.createElement('span'); d.className='dot'; s.prepend(d); }
  clearTimeout(_stTimer); if(!busy&&m) _stTimer=setTimeout(()=>{ if(s.className==='')s.textContent=''; },8000);
  if(PZ&&!_pzQuiet)pzNote(m,busy?'busy':''); }
function setErr(m){ const s=$('status'); s.className='err'; s.textContent=m; if(PZ)pzNote(m,'err'); }
// One download path for every export. The object URL is revoked after a grace period —
// before this, every export leaked its blob for the life of the tab.
function dlBlob(blob,name){ const a=document.createElement('a'); const u=URL.createObjectURL(blob);
  a.href=u; a.download=name; a.click(); setTimeout(()=>URL.revokeObjectURL(u),10000); }

/* ============================ format ============================ */
const fmtUsd=(n,dp=2)=>{ if(n===null||n===undefined||isNaN(n))return '—'; const s=n<0?'-':'';
  return s+'$'+Math.abs(n).toLocaleString('en-US',{minimumFractionDigits:dp,maximumFractionDigits:dp}); };
const fmtNum=n=>{ if(n===null||n===undefined)return '—'; const a=Math.abs(n);
  const dp=a>=1000?0:a>=1?2:a>=0.01?4:6; return n.toLocaleString('en-US',{maximumFractionDigits:dp}); };
function fmtDur(ms){ if(!ms||ms<=0)return '—'; const s=ms/1000; if(s<90)return Math.round(s)+'s';
  const m=s/60; if(m<90)return Math.round(m)+'m'; const h=m/60; if(h<48)return h.toFixed(1)+'h'; return (h/24).toFixed(1)+'d'; }
// ---- timezone layer: all time-of-day / day bucketing goes through here (settings.tz = 'local'|'utc') ----
function tzParts(ms){ const d=new Date(ms);
  return settings.tz==='utc'
    ? {y:d.getUTCFullYear(),mo:d.getUTCMonth(),day:d.getUTCDate(),h:d.getUTCHours(),min:d.getUTCMinutes(),dow:d.getUTCDay()}
    : {y:d.getFullYear(),mo:d.getMonth(),day:d.getDate(),h:d.getHours(),min:d.getMinutes(),dow:d.getDay()}; }
const tzHour=ms=>tzParts(ms).h;
const tzDow=ms=>tzParts(ms).dow;
function tzMidnight(ms){ const p=tzParts(ms); return settings.tz==='utc'?Date.UTC(p.y,p.mo,p.day):new Date(p.y,p.mo,p.day).getTime(); }
// yyyy-mm-dd from a date input, resolved on the tz-toggle clock. Local-only parsing
// shifted range edges by the viewer's UTC offset relative to every other day boundary.
// end=true returns the last millisecond of that day.
function dateBound(v,end){
  const m=/^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v||'').trim()); if(!m)return null;
  const y=+m[1],mo=+m[2]-1,d=+m[3];
  const t0=settings.tz==='utc'?Date.UTC(y,mo,d):new Date(y,mo,d).getTime();
  return end?addDays(t0,1)-1:t0; // next-midnight−1, not +24h−1 — local DST days are 23/25h long
}
// Local mode steps by CALENDAR date and keeps the offset into the day. setDate() on the Date
// itself drifted where DST starts at midnight (Santiago, Asunción, Beirut…): that day begins at
// 01:00, so every later step landed an hour past the day keys and the daily series read zeros.
function addDays(ms,n){ if(settings.tz==='utc')return ms+n*86400000;
  const p=tzParts(ms), off=ms-new Date(p.y,p.mo,p.day).getTime();
  return new Date(p.y,p.mo,p.day+n).getTime()+off; }
const tzLabel=()=>settings.tz==='utc'?'UTC':'local';
const MONTHS=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
function fmtDate(ms){ const p=tzParts(ms); let h=p.h,ap=h<12?'AM':'PM'; h=h%12; if(h===0)h=12;
  // multi-year curves need the year — "Mar 4" of which year is ambiguous on an all-time chart
  const yr=p.y!==new Date().getFullYear()?' ’'+String(p.y).slice(2):'';
  return MONTHS[p.mo]+' '+p.day+yr+' '+h+':'+String(p.min).padStart(2,'0')+' '+ap; }
const cls=n=>n>0?'pos-t':n<0?'neg-t':'';
const dayKey=ms=>{ const p=tzParts(ms); return p.y+'-'+String(p.mo+1).padStart(2,'0')+'-'+String(p.day).padStart(2,'0'); };
// break-even band: trades strictly inside ±_be of zero count as scratches, not wins or losses
// (a trade exactly at the band is decided). render() sets it: beBandFor(settings, allTrades).
let _be=50;
const isWin =n=>n>0&&n>=_be;
const isLoss=n=>n<0&&-n>=_be;
const isBE  =n=>Math.abs(n)<_be||n===0;
// The automatic band: 5% of the median |net| per closed trade, clamped to $0.50–$50. It scales with
// the account (a flat $50 made most of a small account's trades scratches) and keeps $50 for big ones.
function autoBeBand(trades){ const a=[]; for(const t of trades||[])if(t&&!t.isOpen&&isFinite(t.net))a.push(Math.abs(t.net));
  if(!a.length)return 0.5; a.sort((x,y)=>x-y); const n=a.length, m=n%2?a[(n-1)/2]:(a[n/2-1]+a[n/2])/2;
  return Math.round(Math.min(50,Math.max(0.5,m*0.05))*100)/100; }
// The fixed band the user set, or null for auto. A stored 50 without beFixed is the old default that
// boot wrote into every profile (never chosen; the input only showed it), so it reads as auto.
function beFixedOf(s){ const v=s&&s.beThreshold; return typeof v==='number'&&isFinite(v)&&v>=0&&(v!==50||s.beFixed===true)?v:null; }
function beBandFor(s,trades){ const v=beFixedOf(s); return v!=null?v:autoBeBand(trades); }
const outClass=n=>isWin(n)?'pos-t':isLoss(n)?'neg-t':'be-t';

/* ============================ risk / R ============================ */
function riskFor(t){ const j=journal[t.id]||{}; const r=parseFloat(j.risk);
  if(r>0) return r; return _oneR>0?_oneR:null; }
function rFor(t){ const r=riskFor(t); return r?t.net/r:null; }
const _avg=a=>a.length?a.reduce((x,y)=>x+y,0)/a.length:0;
const _std=a=>{ if(a.length<2)return 0; const m=_avg(a); return Math.sqrt(a.reduce((s,x)=>s+(x-m)*(x-m),0)/(a.length-1)); };
function retPct(t){ if(t.partialHistory)return null; const notional=t.maxSize*t.avgEntry; return notional>0? t.net/notional*100 : null; } // partial-history trades have a fabricated entry — no honest % exists
// Real add-to-loser detection from the per-fill event stream: an ADD executed at a price
// materially worse (0.1%+) than the RUNNING average entry means the position was underwater
// when it was sized up. entryDrift was only ever a proxy — it compares against the first
// fill, so it also flags planned scale-ins into strength. Events are [time, px, sz, ±1].
function addedToLoser(t){
  if(!Array.isArray(t.events)||t.events.length<2)return false;
  if(t.dir!=='Long'&&t.dir!=='Short')return false;
  const short=t.dir==='Short', TOL=1e-3;
  let sz=0,notional=0;
  for(const ev of t.events){ const px=ev[1],q=ev[2],dirn=ev[3];
    if(!(q>0)||!(px>0))continue;
    if(dirn>0){
      if(sz>0){ const avg=notional/sz;
        if(short ? px>avg*(1+TOL) : px<avg*(1-TOL)) return true; }
      sz+=q; notional+=q*px;
    } else { const avg=sz>0?notional/sz:0; sz=Math.max(0,sz-q); notional=sz*avg; }
  }
  return false;
}
// a position that was added to at least once (a second entry in its direction), to a winner or a loser
function hasAdd(t){
  if(!Array.isArray(t.events)||t.events.length<2||(t.dir!=='Long'&&t.dir!=='Short'))return false;
  let adds=0; for(const ev of t.events)if(ev[3]>0&&ev[2]>0&&ev[1]>0)adds++;
  return adds>=2;
}
function dailyPnl(trades){ const m={}; trades.forEach(t=>{const k=dayKey(t.closeTime); m[k]=(m[k]||0)+t.net;}); return m; }
function dailySeriesCalendar(trades){
  if(!trades.length)return [];
  const m={}; let min=Infinity,max=-Infinity;
  trades.forEach(t=>{ const k=tzMidnight(t.closeTime);
    m[k]=(m[k]||0)+t.net; min=Math.min(min,k); max=Math.max(max,k); });
  const out=[]; for(let d=min; d<=max; d=addDays(d,1)) out.push(m[d]||0);
  return out;
}
// Sharpe with Lo (2002) standard error on the per-period estimate, then annualized (√365).
function sharpeStats(series){
  if(series.length<2)return null; const m=_avg(series), sd=_std(series); if(sd===0)return null;
  const srD=m/sd, N=series.length, ann=Math.sqrt(365);
  const seD=Math.sqrt((1+0.5*srD*srD)/N);
  return {srDaily:srD,N,sr:srD*ann,se:seD*ann,lo:(srD-1.96*seD)*ann,hi:(srD+1.96*seD)*ann};
}
function sortinoAnnual(series){
  if(series.length<2)return null; const m=_avg(series); const neg=series.filter(x=>x<0);
  const dd=Math.sqrt(neg.reduce((s,x)=>s+x*x,0)/series.length);
  if(dd===0)return m>0?Infinity:null; return m/dd*Math.sqrt(365);
}
// --- advanced diagnostics stats ---
function _autocorr1(a){ if(a.length<3)return null; const m=_avg(a); let num=0,den=0;
  for(let i=0;i<a.length;i++){ den+=(a[i]-m)**2; if(i>0)num+=(a[i]-m)*(a[i-1]-m); } return den>0?num/den:null; }
function _erf(x){ const t=1/(1+0.3275911*Math.abs(x));
  const y=1-(((((1.061405429*t-1.453152027)*t)+1.421413741)*t-0.284496736)*t+0.254829592)*t*Math.exp(-x*x);
  return x>=0?y:-y; }
const _normCdf=z=>0.5*(1+_erf(z/Math.SQRT2));
// Student-t CDF for the small-sample significance tests. The normal approximation is
// anti-conservative at exactly the n=5-15 subgroup sizes the FDR gates police (a |t|=2.1
// at df=9 is p=.065, not the .036 the normal claims). Lanczos log-gamma + regularized
// incomplete beta (Lentz continued fraction), accurate to ~1e-10 across the df range here.
function _lgamma(z){ const g=[676.5203681218851,-1259.1392167224028,771.32342877765313,-176.61502916214059,12.507343278686905,-0.13857109526572012,9.9843695780195716e-6,1.5056327351493116e-7];
  if(z<0.5)return Math.log(Math.PI/Math.sin(Math.PI*z))-_lgamma(1-z);
  z-=1; let x=0.99999999999980993; for(let i=0;i<8;i++)x+=g[i]/(z+i+1);
  const t=z+7.5; return 0.5*Math.log(2*Math.PI)+(z+0.5)*Math.log(t)-t+Math.log(x); }
function _ibetaReg(x,a,b){
  if(x<=0)return 0; if(x>=1)return 1;
  if(x>(a+1)/(a+b+2))return 1-_ibetaReg(1-x,b,a); // symmetry: keep the fraction convergent
  const front=Math.exp(a*Math.log(x)+b*Math.log(1-x)-(_lgamma(a)+_lgamma(b)-_lgamma(a+b)))/a;
  let f=1,c=1,d=0;
  for(let i=0;i<=300;i++){ const m=i>>1; let num;
    if(i===0)num=1;
    else if(i%2===0)num=m*(b-m)*x/((a+2*m-1)*(a+2*m));
    else num=-(a+m)*(a+b+m)*x/((a+2*m)*(a+2*m+1));
    d=1+num*d; if(Math.abs(d)<1e-30)d=1e-30; d=1/d;
    c=1+num/c; if(Math.abs(c)<1e-30)c=1e-30;
    const cd=c*d; f*=cd; if(Math.abs(1-cd)<1e-10)break; }
  return front*(f-1); }
function _tCdf(t,df){ if(!isFinite(t))return t>0?1:0; if(!(df>0)||!isFinite(df))return _normCdf(t);
  const p=1-0.5*_ibetaReg(df/(df+t*t),df/2,0.5);
  return t>=0?p:1-p; }
/* seedable PRNG (mulberry32). All stochastic analytics (bootstraps, permutation tests, MC
   shuffles) draw from _rng, seeded deterministically from the data selection — so the same
   trades always produce identical p-values/CIs run-to-run, and the Node harness can pin
   exact expected outputs. Network backoff jitter deliberately stays on Math.random. */
let _rng=Math.random;
let _progress=null; // set only inside the compute worker to stream miner progress; null (no-op) on the page
function _srand(seed){ let a=(seed>>>0)||1; _rng=function(){ a|=0; a=a+0x6D2B79F5|0;
  let t=Math.imul(a^a>>>15,1|a); t=t+Math.imul(t^t>>>7,61|t)^t; return ((t^t>>>14)>>>0)/4294967296; }; }
function _hashSeed(s){ s=String(s); let h=2166136261;
  for(let i=0;i<s.length;i++){ h^=s.charCodeAt(i); h=Math.imul(h,16777619); } return h>>>0; }
function bootstrapMeanCI(vals,B){ if(vals.length<2)return null; const N=vals.length,means=new Array(B);
  for(let b=0;b<B;b++){ let s=0; for(let i=0;i<N;i++)s+=vals[(_rng()*N)|0]; means[b]=s/N; }
  means.sort((a,b)=>a-b); const q=p=>means[Math.min(B-1,Math.floor(p*B))];
  return {lo:q(0.025),hi:q(0.975),median:q(0.5)}; }
function mcMaxDD(nets,iters){ if(nets.length<2)return null; const dds=new Array(iters);
  for(let k=0;k<iters;k++){ const a=nets.slice();
    for(let i=a.length-1;i>0;i--){ const j=(_rng()*(i+1))|0; const t=a[i];a[i]=a[j];a[j]=t; }
    let peak=0,cum=0,mdd=0; for(const n of a){ cum+=n; if(cum>peak)peak=cum; const dd=cum-peak; if(dd<mdd)mdd=dd; } dds[k]=-mdd; }
  dds.sort((a,b)=>a-b); const q=p=>dds[Math.min(iters-1,Math.floor(p*iters))];
  return {median:q(0.5),p95:q(0.95)}; }
// The Diagnostic headline's test for an edge: the daily Sharpe's 95% lower bound or the per-trade
// expectancy's bootstrap 95% lower bound clears 0. Shared so Project can't claim more than it does.
function edgeEstablished(sharpeLo, boot){ return (sharpeLo!=null&&sharpeLo>0)||!!(boot&&boot.lo>0); }
// That test on a set of closed trades (Project's basis). Seed, order and B match the Diagnostic's
// Monte Carlo (_diagMCInput), so the same trades get the same answer on both tabs.
function edgeTest(closed){ const N=closed.length; if(N<5)return {proven:false,sharpeLo:null,boot:null};
  const sh=sharpeStats(dailySeriesCalendar(closed)), lo=sh?sh.lo:null;
  if(lo!=null&&lo>0)return {proven:true,sharpeLo:lo,boot:null};
  _srand(_hashSeed('diag|'+N+'|'+closed[0].id+'|'+closed[N-1].id));
  const boot=bootstrapMeanCI(closed.map(t=>t.net),N>3000?800:2000);
  return {proven:edgeEstablished(lo,boot),sharpeLo:lo,boot}; }
/* ============================ forward projection (Project tab) ============================ */
// Calendar daily net series over a lookback window (flat days included, ending today).
// Pure given tzMidnight/addDays/isWin/isLoss, so the Node harness can pin exact outputs.
function projBaseline(trades, lookbackDays, now){
  now=now||Date.now();
  const closed=trades.filter(t=>!t.isOpen&&t.closeTime&&t.closeTime<=now);
  const from=lookbackDays>0? now-lookbackDays*86400000 : -Infinity;
  const inWin=closed.filter(t=>t.closeTime>=from);
  if(!inWin.length) return null;
  const m={}; let min=Infinity;
  inWin.forEach(t=>{ const k=tzMidnight(t.closeTime); m[k]=(m[k]||0)+t.net; if(k<min)min=k; });
  // Per-calendar-day pace divides by the WINDOW, not first-trade-in-window-to-now: a 90d
  // lookback with trades only in the last 10 days is a trader who paused, not a 9x pace.
  // Accounts younger than the lookback clamp to their own first trade ever, so a 2-week-old
  // account isn't diluted across 90 empty days it didn't exist for.
  if(lookbackDays>0&&closed.length){
    const firstEver=tzMidnight(Math.min(...closed.map(t=>t.closeTime)));
    const start=Math.max(tzMidnight(from),firstEver);
    if(start<min)min=start;
  }
  const end=tzMidnight(now);
  const daily=[]; let active=0;
  for(let d=min; d<=end; d=addDays(d,1)){ daily.push(m[d]||0); if(m[d]!=null)active++; }
  const total=inWin.reduce((s,t)=>s+t.net,0);
  const w=inWin.filter(t=>isWin(t.net)).length, l=inWin.filter(t=>isLoss(t.net)).length;
  return { daily, trades:inWin.length, total,
    perDay: daily.length? total/daily.length : 0,
    activeDays:active, calDays:daily.length,
    winRate:(w+l)? w/(w+l) : null,
    expectancy: total/inWin.length,
    tradesPerWeek: daily.length? inWin.length/(daily.length/7) : 0 };
}
// Bootstrap Monte Carlo: resample the observed daily distribution forward `horizonDays`.
// Default is i.i.d. daily sampling; pass block>1 for a moving-block bootstrap that samples
// contiguous runs of `block` days (with wraparound), preserving hot/cold streak structure
// that i.i.d. resampling destroys. Deterministic for a given seed (mulberry32 via _srand);
// with block absent/1 the RNG stream is byte-identical to the original i.i.d. version.
// Returns per-day quantile bands of the cumulative-PnL path, end-of-horizon quantiles, and
// per-path MAX DRAWDOWN quantiles (dd) — the honest companion to the fan chart.
function projectForward(daily, horizonDays, paths, seed, block){
  if(!daily||!daily.length||!(horizonDays>=1)) return null;
  paths=paths||400; horizonDays=Math.floor(horizonDays);
  const N=daily.length;
  const B=(block&&block>1)?Math.min(Math.floor(block),N):1;
  _srand(seed!=null?seed:_hashSeed(daily.length+':'+horizonDays+':'+daily.reduce((s,x)=>s+x,0).toFixed(2)+(B>1?':b'+B:'')));
  const ends=new Array(paths), cums=new Array(paths);
  for(let p=0;p<paths;p++){ let c=0; const row=new Float64Array(horizonDays);
    if(B<=1){ for(let d=0;d<horizonDays;d++){ c+=daily[(_rng()*N)|0]; row[d]=c; } }
    else { let d=0; while(d<horizonDays){ const st=(_rng()*N)|0;
      for(let k=0;k<B&&d<horizonDays;k++,d++){ c+=daily[(st+k)%N]; row[d]=c; } } }
    cums[p]=row; ends[p]=c; }
  const q=(sorted,p)=>sorted[Math.min(sorted.length-1,Math.max(0,Math.round(p*(sorted.length-1))))];
  const bands={p05:[],p25:[],p50:[],p75:[],p95:[]};
  const col=new Array(paths);
  for(let d=0; d<horizonDays; d++){
    for(let p=0;p<paths;p++)col[p]=cums[p][d];
    const s=col.slice().sort((a,b)=>a-b);
    bands.p05.push(q(s,0.05)); bands.p25.push(q(s,0.25)); bands.p50.push(q(s,0.5)); bands.p75.push(q(s,0.75)); bands.p95.push(q(s,0.95));
  }
  const es=ends.slice().sort((a,b)=>a-b);
  // per-path max drawdown (peak-to-trough inside the simulated horizon, from a 0 start peak)
  const dds=new Array(paths);
  for(let p=0;p<paths;p++){ const row=cums[p]; let peak=0,mdd=0;
    for(let d=0;d<horizonDays;d++){ const c=row[d]; if(c>peak)peak=c; const dd=c-peak; if(dd<mdd)mdd=dd; }
    dds[p]=-mdd; }
  dds.sort((a,b)=>a-b);
  return { bands, end:{p05:q(es,0.05),p25:q(es,0.25),p50:q(es,0.5),p75:q(es,0.75),p95:q(es,0.95)},
    probPositive: es.filter(v=>v>0).length/paths,
    dd:{p50:q(dds,0.5),p75:q(dds,0.75),p95:q(dds,0.95)}, block:B };
}
// Next "nice round" milestone targets strictly above `start` (1 / 2 / 2.5 / 5 x 10^k ladder).
function projMilestones(start, count){
  count=count||4; const out=[]; if(!isFinite(start))return out;
  const steps=[1,2,2.5,5]; let cands=[];
  for(let e=2;e<=9;e++) for(const s of steps) cands.push(s*Math.pow(10,e));
  cands=[...new Set(cands)].sort((a,b)=>a-b);
  for(const c of cands){ if(c>start+1e-9){ out.push(c); if(out.length>=count)break; } }
  return out;
}
function currentDD(nets){ let peak=0,cum=0,peakIdx=-1;
  for(let i=0;i<nets.length;i++){ cum+=nets[i]; if(cum>=peak){peak=cum;peakIdx=i;} }
  return {dd:cum-peak, pct:peak>0?Math.abs(cum-peak)/peak:null, since:nets.length-1-peakIdx}; }
// Longest calendar stretch spent below the high-water mark (peak -> recovery), from
// chronologically sorted closed trades. `ongoingMs` is set when currently underwater.
function underwaterStats(chron){ if(!chron.length)return null;
  let peak=0,cum=0,peakT=chron[0].closeTime,maxSpan=0,spanStart=null;
  for(const t of chron){ cum+=t.net;
    if(cum>=peak){ peak=cum;
      if(spanStart!=null){ const sp=t.closeTime-spanStart; if(sp>maxSpan)maxSpan=sp; spanStart=null; }
      peakT=t.closeTime; }
    else if(spanStart==null) spanStart=peakT; }
  let ongoing=null;
  if(spanStart!=null){ ongoing=chron[chron.length-1].closeTime-spanStart; if(ongoing>maxSpan)maxSpan=ongoing; }
  return {maxSpanMs:maxSpan, ongoingMs:ongoing}; }
// Forward sequence risk: bootstrap (sample WITH replacement) H future trades from your own
// per-trade nets, take the worst drawdown of each simulated path. Unlike mcMaxDD (which
// reshuffles the exact past), this asks what the NEXT H trades could plausibly do.
function fwdMaxDD(nets,H,iters){ if(nets.length<10)return null; const dds=new Array(iters);
  for(let k=0;k<iters;k++){ let peak=0,cum=0,mdd=0;
    for(let i=0;i<H;i++){ cum+=nets[(_rng()*nets.length)|0]; if(cum>peak)peak=cum; const dd=cum-peak; if(dd<mdd)mdd=dd; }
    dds[k]=-mdd; }
  dds.sort((a,b)=>a-b); const q=p=>dds[Math.min(iters-1,Math.floor(p*iters))];
  return {median:q(0.5),p75:q(0.75),p95:q(0.95),H}; }
// Kelly fraction from a trade set: p = decisive win rate (break-even band excluded),
// b = average win / average loss. Pure given isWin/isLoss. kelly is clamped at 0; a
// negative-edge sample returns kelly 0 rather than a nonsense short-your-own-account number.
function kellyFromTrades(trades){
  const wins=trades.filter(t=>isWin(t.net)), losses=trades.filter(t=>isLoss(t.net));
  const n=wins.length+losses.length; if(n<10)return null;
  const p=wins.length/n;
  const aw=wins.length?wins.reduce((s,t)=>s+t.net,0)/wins.length:0;
  const al=losses.length?Math.abs(losses.reduce((s,t)=>s+t.net,0)/losses.length):0;
  const b=al>0?(aw/al):(aw>0?Infinity:null);
  let kelly=null;
  if(b===Infinity)kelly=p; else if(b!=null&&b>0)kelly=p-(1-p)/b;
  return {n,p,b,kelly:kelly!=null?Math.max(0,kelly):null,quarter:kelly!=null?Math.max(0,kelly)/4:null};
}
// Open-position risk model: distance to liquidation per position (vs current mark, derived
// from positionValue / |size| so no extra API call), aggregate notional by coin (netting
// offsetting longs/shorts across wallets), gross/skew totals, and a danger list of positions
// within 10% of their liquidation price. Pure — testable in Node.
function openRiskModel(positions){
  const rows=(positions||[]).filter(p=>p&&isFinite(p.szi)&&p.szi!==0).map(p=>{
    const size=Math.abs(p.szi); const mark=(size>0&&isFinite(p.value)&&p.value>0)?p.value/size:null;
    let liqDist=null;
    if(p.liq!=null&&isFinite(p.liq)&&mark>0) liqDist=Math.abs(p.liq-mark)/mark;
    return {coin:p.coin,dex:p.dex||'',side:p.szi>0?'long':'short',notional:p.value||0,
      mark,liq:(p.liq!=null&&isFinite(p.liq))?p.liq:null,liqDist,uPnl:p.uPnl||0,lev:p.lev||null,wallet:p.wallet||null};
  });
  if(!rows.length)return null;
  rows.sort((a,b)=>{ const A=a.liqDist==null?Infinity:a.liqDist, C=b.liqDist==null?Infinity:b.liqDist;
    return A-C || b.notional-a.notional; });
  const gross=rows.reduce((s,r)=>s+r.notional,0);
  const skew=rows.reduce((s,r)=>s+r.notional*(r.side==='short'?-1:1),0);
  const upnl=rows.reduce((s,r)=>s+r.uPnl,0);
  const byCoin={};
  for(const r of rows){ const g=byCoin[r.coin]=byCoin[r.coin]||{coin:r.coin,net:0,gross:0,wallets:new Set(),hip3:!!r.dex};
    g.net+=r.notional*(r.side==='short'?-1:1); g.gross+=r.notional;
    if(r.wallet&&r.wallet.address)g.wallets.add(r.wallet.address); }
  const coins=Object.values(byCoin).map(x=>({coin:x.coin,net:x.net,gross:x.gross,wallets:x.wallets.size,hip3:x.hip3,share:gross>0?x.gross/gross:0}))
    .sort((a,b)=>b.gross-a.gross);
  const danger=rows.filter(r=>r.liqDist!=null&&r.liqDist<0.10);
  return {rows,coins,gross,skew,upnl,positions:rows.length,
    largestShare:(coins.length&&gross>0)?coins[0].gross/gross:0,danger};
}
// Correlation-aware concentration flag for the open-risk panel. openRiskModel sums per-position
// risk as if the positions were independent; but perps move together (in risk-off, alts track
// BTC), so same-direction exposure across several coins carries more real risk than the
// arithmetic sum. Without a price-history correlation matrix we measure how one-sided the book
// is by notional (|skew|/gross) and whether that lopsidedness is spread across multiple names
// rather than one big position. A flagged book should be read as "combined risk larger than the
// sum". Heuristic and labelled as such — no fabricated correlation numbers. Pure/Node-testable.
function riskConcentration(model){
  if(!model||!model.rows||!model.rows.length) return null;
  const gross=model.gross||0; if(gross<=0) return null;
  const net=model.skew||0;                       // signed notional: + long-heavy, − short-heavy
  const dirRatio=Math.abs(net)/gross;            // 0 balanced/hedged … 1 fully one-directional
  const longs=model.rows.filter(r=>r.side==='long').length;
  const shorts=model.rows.filter(r=>r.side==='short').length;
  const nPos=model.rows.length, sameSide=Math.max(longs,shorts);
  const clustered = nPos>=2 && dirRatio>=0.6 && sameSide>=2;
  return { dirRatio, net, gross, longs, shorts, positions:nPos,
    side: net>=0?'long':'short', clustered };
}
// Pairwise daily-return correlation of held coins: log returns on 1d closes, aligned by
// candle timestamp; a pair needs >=20 overlapping days to report. Pure — the exact version
// of riskConcentration's stated approximation ("without a price-history correlation matrix
// it measures how one-sided you are, not exact correlations").
function coinCorrelations(candlesByCoin){
  const rets={};
  for(const c in candlesByCoin){ const rows=candlesByCoin[c]; const m={};
    for(let i=1;i<rows.length;i++){ const p0=rows[i-1][3],p1=rows[i][3];
      if(p0>0&&p1>0)m[rows[i][0]]=Math.log(p1/p0); }
    rets[c]=m; }
  const coins=Object.keys(rets), corr={};
  for(let i=0;i<coins.length;i++)for(let j=i+1;j<coins.length;j++){
    const A=rets[coins[i]],B=rets[coins[j]];
    const ks=Object.keys(A).filter(k=>k in B);
    if(ks.length<20)continue;
    const a=ks.map(k=>A[k]),b=ks.map(k=>B[k]),ma=_avg(a),mb=_avg(b);
    let sab=0,sa=0,sb=0;
    for(let k=0;k<a.length;k++){ const x=a[k]-ma,y=b[k]-mb; sab+=x*y; sa+=x*x; sb+=y*y; }
    if(sa>0&&sb>0)corr[coins[i]+'|'+coins[j]]=sab/Math.sqrt(sa*sb);
  }
  return corr;
}
// Cluster co-moving (rho >= thr) held coins by union-find and net signed exposure within
// each cluster — five alt longs at 0.8 correlation are closer to one big bet than five
// diversified positions. Positive-correlation clustering only: honest and sufficient for
// crypto books where nearly everything co-moves; anti-correlated pairs stay separate.
// naiveDirectional sums each coin's |net| independently; effectiveDirectional nets within
// clusters first — the gap between them is the diversification that is actually there. Pure.
function exposureClusters(exposures, corr, thr){
  thr=thr==null?0.7:thr;
  const parent={}; exposures.forEach(e=>parent[e.coin]=e.coin);
  const find=c=>parent[c]===c?c:(parent[c]=find(parent[c]));
  for(const k in corr){ const i=k.indexOf('|'); const a=k.slice(0,i), b=k.slice(i+1);
    if(corr[k]>=thr&&parent[a]!=null&&parent[b]!=null)parent[find(a)]=find(b); }
  const groups={};
  for(const e of exposures){ const r=find(e.coin); (groups[r]=groups[r]||[]).push(e); }
  const clusters=[]; let effective=0, naive=0;
  for(const r in groups){ const g=groups[r];
    const net=g.reduce((s,e)=>s+e.net,0), gross=g.reduce((s,e)=>s+Math.abs(e.net),0);
    naive+=gross; effective+=Math.abs(net);
    if(g.length<2)continue;
    let lo=1, seen=false;
    for(let i=0;i<g.length;i++)for(let j=i+1;j<g.length;j++){
      const key1=g[i].coin+'|'+g[j].coin, key2=g[j].coin+'|'+g[i].coin;
      const rho=corr[key1]!==undefined?corr[key1]:corr[key2];
      if(rho!=null){ seen=true; if(rho<lo)lo=rho; } }
    clusters.push({coins:g.map(e=>e.coin), net, gross, minCorr:seen?lo:null});
  }
  clusters.sort((a,b)=>Math.abs(b.net)-Math.abs(a.net));
  return {clusters, naiveDirectional:naive, effectiveDirectional:effective, thr};
}
// First-order stress test on the open book: shift every mark by shockPct, sum the signed
// PnL impact (long +notional*s, short −notional*s), and check which positions cross their
// liquidation price at the shocked mark. Ignores funding, fees, and margin-tier changes —
// real liquidation comes a touch earlier, same first-order lens as leverageSurvival. Pure.
function scenarioShock(rows, accountValue, shockPct){
  const s=shockPct/100; let pnl=0; const liqs=[];
  for(const r of (rows||[])){
    if(!(r.notional>0))continue;
    pnl+=r.notional*s*(r.side==='long'?1:-1);
    if(r.mark>0&&r.liq!=null){
      const shocked=r.mark*(1+s);
      const crosses=r.side==='long'?shocked<=r.liq:shocked>=r.liq;
      if(crosses)liqs.push({coin:r.coin,side:r.side,notional:r.notional,liq:r.liq,mark:r.mark});
    }
  }
  return {shockPct, pnl, liqs, acctAfter:accountValue!=null?accountValue+pnl:null,
    acctPct:(accountValue>0)?pnl/accountValue:null};
}
// Autocorrelation-aware Kelly haircut. kellyFromTrades assumes independent bets; when trade PnL
// is positively autocorrelated (streaks are real), effective variance is higher than the i.i.d.
// formula assumes and full Kelly overstates the growth-optimal fraction — precisely when
// oversizing does the most damage. Shrink the fraction by (1 − acf1), floored at 0.4 so even a
// strong streak signal cuts at most 60% and never drives a positive-edge size to zero. Pure.
function kellyHaircut(fraction, acf1){
  if(fraction==null||!(fraction>0)) return {factor:1, adjusted:fraction, acf1:acf1!=null?acf1:null};
  const a=(acf1!=null&&isFinite(acf1))?Math.max(0,acf1):0;
  const factor=Math.max(0.4, 1-a);
  return {factor, adjusted:fraction*factor, acf1:a};
}
// Rolling walk-forward expectancy — the honest counterpart to the app's in-sample stats. Sort
// closed trades chronologically, train on a trailing window, SCORE the next non-overlapping
// block strictly out-of-sample, then slide. The concatenated out-of-sample blocks tile the
// post-warmup history with no look-ahead, so their mean is a genuine walk-forward expectancy.
// Compare it to the naive full-sample in-sample expectancy: a large drop is edge decay or
// overfitting, not noise. Pure given _avg / bootstrapMeanCI, so the harness can pin it exactly.
function walkForward(closed, opts){
  opts=opts||{};
  const tr=(closed||[]).filter(t=>t&&!t.isOpen&&isFinite(t.net)).sort((a,b)=>a.closeTime-b.closeTime);
  const N=tr.length; if(N<20) return null;
  const train=Math.max(10, opts.train||Math.min(120, Math.round(N*0.4)));
  const step =Math.max(5,  opts.step ||Math.max(5, Math.round(train/4)));
  if(N < train+step) return null;
  const points=[], oos=[];
  for(let origin=train; origin+step<=N; origin+=step){
    const trs=tr.slice(origin-train, origin), tes=tr.slice(origin, origin+step);
    const isExp=_avg(trs.map(t=>t.net)), osExp=_avg(tes.map(t=>t.net));
    for(const t of tes) oos.push(t.net);
    points.push({ i:origin, t:tes[tes.length-1].closeTime, isExp, osExp, n:tes.length });
  }
  if(!points.length) return null;
  const fullIS=_avg(tr.map(t=>t.net));
  const wfExp=oos.length?_avg(oos):null;
  // opts.ci===false skips the 800-pass bootstrap (the only RNG draw here): the Diagnostic gets the
  // CI from its Monte Carlo batch instead (diagMCCompute, in the worker for big accounts), which
  // runs this same function seeded the same way, so the numbers are identical.
  const wfCI=opts.ci!==false&&oos.length>=8?bootstrapMeanCI(oos,800):null;
  const optimism=_avg(points.map(p=>p.isExp-p.osExp)); // mean(in-sample − realized); >0 = IS overstates
  return { train, step, blocks:points.length, oosN:oos.length, points, fullIS, wfExp, wfCI, optimism,
    retention:(fullIS>0 && wfExp!=null)?wfExp/fullIS:null, holds:(wfExp!=null && wfExp>0) };
}
// "What if I stopped doing X": deterministic counterfactual replay. Takes the actual
// chronological closed-trade sequence and removes the trades matching `pred`, then compares
// the two resulting equity curves and headline stats. No resampling, no RNG — this is the
// dollar answer to whether a miner finding is worth acting on.
function whatIfStats(chron){
  let cum=0,peak=0,mdd=0,gp=0,gl=0,w=0,l=0;
  for(const t of chron){ cum+=t.net; if(cum>peak)peak=cum; const dd=cum-peak; if(dd<mdd)mdd=dd;
    if(t.net>0)gp+=t.net; else gl-=t.net; if(isWin(t.net))w++; else if(isLoss(t.net))l++; }
  return {n:chron.length, net:cum, expectancy:chron.length?cum/chron.length:0, maxDD:mdd,
    winRate:(w+l)?w/(w+l):null, profitFactor:gl>0?gp/gl:(gp>0?Infinity:0)};
}
function whatIfModel(closed,pred){
  const chron=[...closed].sort((a,b)=>a.closeTime-b.closeTime);
  const removed=chron.filter(pred), kept=chron.filter(t=>!pred(t));
  const labels=[],act=[],cf=[]; let a=0,c=0;
  for(const t of chron){ a+=t.net; if(!pred(t))c+=t.net; labels.push(t.closeTime); act.push(a); cf.push(c); }
  return {all:whatIfStats(chron), kept:whatIfStats(kept),
    removed:{n:removed.length, net:removed.reduce((s,t)=>s+t.net,0)},
    series:{labels, actual:act, cf}};
}
// Spot cost-basis lots, FIFO. Consumes raw spot fills (coins "@N" or "PAIR/USDC") in time
// order: buys open lots, sells consume the oldest lots first, each consumption emitting an
// 8949-style row (proceeds, basis, gain, short/long term at >365 days held). Sells that
// exceed everything bought on-exchange (tokens transferred/airdropped in) draw from a
// zero-cost UNKNOWN-BASIS lot and are flagged — the honest treatment when the true basis
// can't be rebuilt from fills. Fees: base-token fees on buys shrink the received quantity;
// USDC(-equivalent) fees are added to basis on buys and subtracted from proceeds on sells.
function spotFifoLots(fills, nameByCoin){
  nameByCoin=nameByCoin||{};
  const EPS=1e-12;
  // Long-term only when disposed AFTER the one-year anniversary date (UTC calendar dates, the
  // dates the export prints): a sale on the anniversary itself is still short-term. A Feb 29
  // acquisition's anniversary is Feb 28. A fixed 365-day span got both edges wrong.
  const termOf=(acq,disp)=>{ const a=new Date(acq), d=new Date(disp);
    const leap=a.getUTCMonth()===1&&a.getUTCDate()===29;
    const ann=Date.UTC(a.getUTCFullYear()+1,a.getUTCMonth(),leap?28:a.getUTCDate());
    return Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate())>ann?'long':'short'; };
  const spot=(fills||[]).filter(f=>f&&typeof f.coin==='string'&&(f.coin.includes('/')||f.coin.startsWith('@')))
    .sort((a,b)=>a.time-b.time);
  const sym=c=>{ const base=c.includes('/')?c.split('/')[0]:c; return nameByCoin[c]||nameByCoin[base]||base; };
  const lots={}; const rows=[]; let unknownQty=0;
  for(const f of spot){
    const s=sym(f.coin), q=Math.abs(parseFloat(f.sz||0)), px=parseFloat(f.px||0), fee=parseFloat(f.fee||0)||0;
    if(!(q>0)||!isFinite(px))continue;
    const baseFee=!!(f.feeToken&&(f.side==='B'?f.feeToken!=='USDC':!{USDC:1,USDT0:1,USDT:1,USDH:1,USDE:1}[f.feeToken])); // a sell's fee in a stable quote (USDH, USDT0) is dollars, as in reconstructTrades
    const L=lots[s]=lots[s]||[];
    if(f.side==='B'){
      const recv=baseFee?q-fee:q;
      // fee >= quantity (dust/malformed fill): received ~nothing — skipping is honest,
      // clamping to EPS manufactured a near-infinite unit cost in the tax export
      if(!(recv>EPS))continue;
      const basis=q*px + (baseFee?0:fee);
      L.push({qty:recv, unitCost:basis/recv, time:f.time});
    } else {
      let rem=q; const usdFee=baseFee?fee*px:fee; const feeUnit=q>0?usdFee/q:0;
      while(rem>EPS){
        let lot=L[0];
        if(!lot){ lot={qty:rem, unitCost:0, time:null, unknown:true}; L.unshift(lot); }
        const take=Math.min(rem, lot.qty);
        if(lot.unknown)unknownQty+=take;
        rows.push({symbol:s, qty:take, acquired:lot.time, disposed:f.time,
          proceeds:take*px - take*feeUnit, basis:take*lot.unitCost,
          gain:take*(px-feeUnit-lot.unitCost),
          term:lot.time==null?'unknown':termOf(lot.time,f.time),
          unknownBasis:!!lot.unknown});
        lot.qty-=take; rem-=take; if(lot.qty<=EPS)L.shift();
      }
    }
  }
  const open=[];
  for(const s in lots)for(const lot of lots[s])
    if(lot.qty>EPS&&!lot.unknown)open.push({symbol:s,qty:lot.qty,unitCost:lot.unitCost,acquired:lot.time});
  const byYear={};
  for(const r of rows){ const y=new Date(r.disposed).getUTCFullYear();
    const b=byYear[y]=byYear[y]||{n:0,proceeds:0,basis:0,gain:0};
    b.n++; b.proceeds+=r.proceeds; b.basis+=r.basis; b.gain+=r.gain; }
  return {rows, open, byYear, unknownQty};
}
/* ---- other venues: Lighter, Bybit, Binance → Hyperliquid-shaped fills (pure) ---- */
// Every venue's fills are normalized to the fill shape the reconstruction already takes:
// {coin, side:'B'|'A', px, sz, time, fee (USD, + = paid), feeToken, startPosition, closedPnl,
// crossed (taker), tid, oid, liquidation?}. Coins are plain base symbols ("BTC") for USD(T)-margined
// perps and "BASE/QUOTE" for spot, so stats group the same asset across venues; the venue rides
// on each trade (t.venue) and picks its own candles.
// Derive startPosition and closedPnl per coin where a venue doesn't give them: running position
// plus average-cost realization on each reducing fill's closing portion. `initial` seeds the
// position each coin held before the first fill (from today's position minus the window's net,
// when a venue's history is shorter than the account's) — the first trade then reads as partial
// instead of a phantom position the other way. Fills must be sorted by time. Mutates and returns.
// Spot: a buy whose fee is taken in the coin bought (Bybit) adds only what's left after the fee,
// and its cost is spread over that — the same basis Hyperliquid's own closedPnl uses. And a coin
// never goes below zero: selling coins held before the history began (a deposit) reads as closing
// a holding of unknown cost, not as opening a short.
function deriveFillPositions(fills, initial){
  const pos=Object.assign({},initial||{}), avg={}; let derived=false;
  const spotBaseFee=f=>f.side==='B'&&f.coin.includes('/')&&f.feeToken&&f.feeToken!=='USDC'&&f.feeToken===f.coin.split('/')[0]?Math.abs(parseFloat(f.fee)||0):0;
  const run={}, low={};
  for(const f of fills){ if(!f.coin.includes('/')||f.startPosition!=null)continue; const q=parseFloat(f.sz); if(!(q>0))continue;
    const c=f.coin; run[c]=(run[c]||0)+(f.side==='B'?q-spotBaseFee(f):-q); if(run[c]<(low[c]||0))low[c]=run[c]; }
  for(const c in low) if(low[c]<-1e-12)pos[c]=(pos[c]||0)-low[c];
  for(const f of fills){
    const c=f.coin, px=parseFloat(f.px), bf=spotBaseFee(f), q=parseFloat(f.sz)-bf;
    const p=pos[c]||0, signed=f.side==='B'?q:-q;
    if(f.startPosition==null){ f.startPosition=String(+p.toFixed(10)); derived=true; }
    const sameDir=p===0||(p>0)===(signed>0);
    if(f.closedPnl==null){
      if(sameDir)f.closedPnl='0';
      else{ const closeQty=Math.min(Math.abs(p),q);
        f.closedPnl=String(+(((px-(avg[c]||px))*closeQty*(p>0?1:-1))).toFixed(8)); derived=true; }
    }
    if(sameDir){ const tot=Math.abs(p)+q, paid=(q+bf)*px; avg[c]=tot>0?((Math.abs(p)*(avg[c]||px)+paid)/tot):px; }
    else if(q>Math.abs(p)){ avg[c]=px; } // flip: the remainder opens at this price
    pos[c]=p+signed;
    if(Math.abs(pos[c])<1e-9){ pos[c]=0; avg[c]=0; }
  }
  return {fills,derived,end:pos};
}
// Position each coin held before `fills` began: today's position minus the net of the fills.
function initialPositions(fills, nowPos){
  const net={}; for(const f of fills){ const q=parseFloat(f.sz); net[f.coin]=(net[f.coin]||0)+(f.side==='B'?q:-q); }
  const out={}; for(const c of new Set([...Object.keys(net),...Object.keys(nowPos||{})])){ const v=((nowPos||{})[c]||0)-(net[c]||0); if(Math.abs(v)>1e-9)out[c]=v; }
  return out;
}
// Lighter trade (as /api/v1/trades returns it) → fill for account `idx`. The trade carries each
// side's position before it (exact startPosition) and its entry cost (exact closedPnl); fees are
// in millionths of notional. symbolOf(market_id) -> 'BTC' | 'ETH/USDC'.
function ltNormTrade(tr, idx, symbolOf){
  const isBid=+tr.bid_account_id===+idx, isAsk=+tr.ask_account_id===+idx; if(!isBid&&!isAsk)return null;
  const maker=isBid?!tr.is_maker_ask:!!tr.is_maker_ask, coin=symbolOf(tr.market_id); if(!coin)return null;
  const px=parseFloat(tr.price), sz=parseFloat(tr.size); if(!(px>0)||!(sz>0))return null;
  const before=parseFloat(maker?tr.maker_position_size_before:tr.taker_position_size_before);
  const entryQ=parseFloat(maker?tr.maker_entry_quote_before:tr.taker_entry_quote_before);
  const rate=+(maker?tr.maker_fee:tr.taker_fee)||0, notional=parseFloat(tr.usd_amount)||px*sz;
  const f={coin,side:isBid?'B':'A',px:String(px),sz:String(sz),time:+tr.timestamp,fee:String(+(notional*rate/1e6).toFixed(8)),feeToken:'USDC',
    crossed:!maker,tid:String(tr.trade_id_str||tr.trade_id),oid:String(isBid?(tr.bid_id_str||tr.bid_id):(tr.ask_id_str||tr.ask_id)),hash:tr.tx_hash||''};
  if(!coin.includes('/')&&isFinite(before)){
    f.startPosition=String(before);
    const signed=isBid?sz:-sz, reducing=before!==0&&(before>0)!==(signed>0);
    const exch=tr[(isBid?'bid':'ask')+'_account_pnl'];
    if(exch!=null&&isFinite(parseFloat(exch)))f.closedPnl=String(parseFloat(exch));
    else if(reducing&&isFinite(entryQ)&&Math.abs(before)>0){ const entry=entryQ/Math.abs(before), q=Math.min(sz,Math.abs(before));
      f.closedPnl=String(+((px-entry)*q*(before>0?1:-1)).toFixed(8)); }
    else f.closedPnl='0';
  }
  if(tr.type&&/liquidat|deleverage/i.test(tr.type))f.liquidation={method:tr.type};
  return f;
}
// Estimated funding for Lighter (its per-payment history needs a login): the hourly public rate
// times the position held at that hour. fundings: {coin: [{timestamp (s), value (USD per unit),
// direction:'long'|'short' = the side that pays}]}; fills: this account's sorted perp fills.
function ltFundingEstimate(fills, fundings){
  const out=[]; const by={};
  for(const f of fills){ if(f.coin.includes('/'))continue; (by[f.coin]=by[f.coin]||[]).push(f); }
  for(const c in by){ const F=by[c], rows=(fundings[c]||[]).slice().sort((a,b)=>a.timestamp-b.timestamp); let i=0, pos=0;
    for(const r of rows){ const t=r.timestamp*1000;
      while(i<F.length&&F[i].time<t){ const q=parseFloat(F[i].sz); pos=parseFloat(F[i].startPosition)+(F[i].side==='B'?q:-q); i++; }
      if(i===0&&F.length&&F[0].time>=t)pos=parseFloat(F[0].startPosition)||0; // before this coin's first fill in the window
      if(Math.abs(pos)<1e-12)continue;
      const v=parseFloat(r.value); if(!(v>0))continue;
      const usdc=(r.direction==='long'?-1:1)*pos*v;
      out.push({time:t,coin:c,usdc:+usdc.toFixed(8),est:true}); } }
  return out.sort((a,b)=>a.time-b.time);
}
// Exchange symbols ↔ coins. USDT-margined perps read as the base ("BTCUSDT" → "BTC"); other
// settle coins keep a suffix so two contracts on one asset never merge ("BTCUSDC" → "BTC-USDC",
// Bybit's "BTCPERP" → "BTC-PERP"); spot reads "BASE/QUOTE".
const CEX_QUOTES=['USDT','USDC','FDUSD','BUSD','USD','EUR','BTC','ETH','BNB'];
function cexCoin(symbol, kind){
  const s=String(symbol||'').toUpperCase();
  if(kind==='spot'){ for(const q of CEX_QUOTES) if(s.endsWith(q)&&s.length>q.length)return s.slice(0,-q.length)+'/'+q; return s; }
  if(s.endsWith('PERP'))return s.slice(0,-4)+'-PERP';
  if(s.endsWith('USDT'))return s.slice(0,-4);
  for(const q of ['USDC','FDUSD','BUSD']) if(s.endsWith(q))return s.slice(0,-q.length)+'-'+q;
  return s;
}
function cexSymbol(coin){
  const c=String(coin||'');
  if(c.includes('/'))return c.replace('/','');
  const m=c.match(/^(.+)-(PERP|USDC|FDUSD|BUSD)$/); if(m)return m[1]+m[2];
  return c+'USDT';
}
const STABLES=new Set(['USDT','USDC','FDUSD','BUSD','USD']);
// Bybit v5 execution (/v5/execution/list item) → fill. Funding and other non-trade executions are
// skipped (funding comes from the transaction log). Fees: + paid, − rebate, in feeCurrency.
function bybitNormExec(e, category){
  if(!e||!['Trade','BustTrade','AdlTrade','Delivery','Settle'].includes(e.execType||'Trade'))return null;
  const px=parseFloat(e.execPrice), sz=parseFloat(e.execQty); if(!(px>0)||!(sz>0))return null;
  const spot=category==='spot', fc=String(e.feeCurrency||(spot?'':'USDT')).toUpperCase();
  const f={coin:cexCoin(e.symbol,spot?'spot':'perp'),side:e.side==='Buy'?'B':'A',px:String(px),sz:String(sz),time:+e.execTime,
    fee:String(parseFloat(e.execFee)||0),feeToken:STABLES.has(fc)||!fc?'USDC':fc,crossed:!(e.isMaker===true||e.isMaker==='true'),
    tid:String(e.execId),oid:String(e.orderId||'')};
  if(e.execType==='BustTrade'||e.execType==='AdlTrade')f.liquidation={method:e.execType};
  return f;
}
// Binance USD-M futures trade (/fapi/v1/userTrades item) → fill. realizedPnl is the exchange's own
// (gross of commission), used as closedPnl. Hedge mode legs (positionSide LONG/SHORT) are tagged so
// each leg is reconstructed on its own. bnbUsd prices BNB-paid commissions (approximate).
function binanceNormTrade(tr, bnbUsd){
  const px=parseFloat(tr.price), sz=parseFloat(tr.qty); if(!(px>0)||!(sz>0))return null;
  const ca=String(tr.commissionAsset||'USDT').toUpperCase(), com=parseFloat(tr.commission)||0;
  const fee=STABLES.has(ca)?com:ca==='BNB'&&bnbUsd>0?com*bnbUsd:0;
  const f={coin:cexCoin(tr.symbol,'perp'),side:tr.side==='BUY'?'B':'A',px:String(px),sz:String(sz),time:+tr.time,fee:String(+fee.toFixed(8)),feeToken:'USDC',
    crossed:!tr.maker,tid:String(tr.id),oid:String(tr.orderId||''),closedPnl:String(parseFloat(tr.realizedPnl)||0)};
  if(tr.positionSide&&tr.positionSide!=='BOTH')f.leg=tr.positionSide; // LONG | SHORT
  if(!STABLES.has(ca)&&!(ca==='BNB'&&bnbUsd>0))f.feeUnpriced=ca;
  return f;
}
/* ---- tax presets by country: the matching method, the tax year, and the flags that matter ---- */
// Not tax advice: these reproduce each country's standard cost-basis METHOD and tax-year
// boundaries from your fills, so an accountant (or you) starts from the right numbers. Gains are
// computed; tax isn't. Proceeds are gross; costs include acquisition fees plus the sale's fees.
const TAX_PRESETS={
  us:{name:'United States',method:'fifo',year:'cal',cur:'USD',note:'FIFO lots. Short-term if held one year or less, long-term after (Form 8949).'},
  uk:{name:'United Kingdom',method:'uk',year:'uk',cur:'GBP',note:'HMRC matching for cryptoassets: same day, then the next 30 days, then the Section 104 pool. Tax year 6 April to 5 April. Report in GBP.'},
  de:{name:'Germany',method:'fifo',year:'cal',cur:'EUR',note:'Private sales under §23 EStG, FIFO. Coins held more than one year are tax-free; net gains under the annual Freigrenze are tax-free — check the current limit. Report in EUR.'},
  au:{name:'Australia',method:'fifo',year:'au',cur:'AUD',note:'CGT with FIFO lots (the ATO also accepts identifying specific parcels). Assets held at least 12 months may get the 50% CGT discount (individuals). Income year 1 July to 30 June. Report in AUD.'},
  ca:{name:'Canada',method:'acb',year:'cal',cur:'CAD',note:'Adjusted cost base (average cost) per coin. Losses where the same coin was bought within 30 days before or after are flagged as possible superficial losses — those are denied and added to the new cost. Report in CAD.'},
  other:{name:'Other (FIFO, calendar year)',method:'fifo',year:'cal',cur:'USD',note:'FIFO lots, calendar year. Check your local rules.'},
};
function taxYearLabel(ms, kind){ const d=new Date(ms), y=d.getUTCFullYear(), m=d.getUTCMonth(), day=d.getUTCDate();
  if(kind==='uk'){ const s=(m>3||(m===3&&day>=6))?y:y-1; return s+'/'+String((s+1)%100).padStart(2,'0'); }
  if(kind==='au'){ const s=m>=6?y:y-1; return 'FY'+s+'-'+String((s+1)%100).padStart(2,'0'); }
  return String(y); }
// held past the first anniversary (UTC dates; a 29 Feb purchase's anniversary is 28 Feb)
function heldOverYear(acq, disp){ if(acq==null)return false; const a=new Date(acq), d=new Date(disp);
  const ann=Date.UTC(a.getUTCFullYear()+1,a.getUTCMonth(),a.getUTCMonth()===1&&a.getUTCDate()===29?28:a.getUTCDate());
  return Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate())>ann; }
// A daily rate table pasted as "YYYY-MM-DD,rate" lines (units of your currency per 1 USD).
// A fill uses the latest rate on or before its day, looking back up to 7 days (weekends,
// holidays). Returns {fx(ms) -> rate|NaN, n, first, last}. An empty table means USD (rate 1).
function fxFromTable(text){
  const rows=[]; for(const line of String(text||'').split(/\r?\n/)){ const m=line.trim().match(/^(\d{4}-\d{2}-\d{2})\s*[,;\t ]\s*([0-9]*[.,]?[0-9]+)\s*$/); if(!m)continue;
    const r=parseFloat(m[2].replace(',','.')); if(r>0)rows.push([Date.UTC(+m[1].slice(0,4),+m[1].slice(5,7)-1,+m[1].slice(8,10)),r]); }
  if(!rows.length)return {fx:()=>1,n:0,first:null,last:null};
  rows.sort((a,b)=>a[0]-b[0]);
  const fx=ms=>{ const d=Math.floor(ms/86400000)*86400000; let lo=0,hi=rows.length-1,best=-1;
    while(lo<=hi){ const m=(lo+hi)>>1; if(rows[m][0]<=d){best=m;lo=m+1;}else hi=m-1; }
    return best>=0&&d-rows[best][0]<=7*86400000?rows[best][1]:NaN; };
  return {fx,n:rows.length,first:rows[0][0],last:rows[rows.length-1][0]};
}
// Spot disposals by method. fills: raw spot fills; fx(ms): USD -> report currency.
// method 'fifo' (lots), 'acb' (average cost), 'uk' (same-day, 30-day, Section 104 pool).
// Rows: {symbol, qty, acquired|null, disposed, proceeds, cost, gain, rule, unknownBasis}.
function taxDisposals(fills, nameByCoin, method, fx){
  nameByCoin=nameByCoin||{}; fx=fx||(()=>1);
  const EPS=1e-12, DAY=86400000;
  const sym=c=>{ const base=c.includes('/')?c.split('/')[0]:c; return nameByCoin[c]||nameByCoin[base]||base; };
  const ev=[]; let missingFx=0;
  for(const f of (fills||[]).filter(f=>f&&typeof f.coin==='string'&&(f.coin.includes('/')||f.coin.startsWith('@'))).sort((a,b)=>a.time-b.time)){
    const q=Math.abs(parseFloat(f.sz||0)), px=parseFloat(f.px||0), fee=parseFloat(f.fee||0)||0;
    if(!(q>0)||!isFinite(px))continue;
    const rate=fx(f.time); if(!(rate>0)){ missingFx++; continue; }
    const baseFee=!!(f.feeToken&&(f.side==='B'?f.feeToken!=='USDC':!{USDC:1,USDT0:1,USDT:1,USDH:1,USDE:1}[f.feeToken])), feeVal=(baseFee?fee*px:fee)*rate;
    if(f.side==='B'){ const recv=baseFee?q-fee:q; if(!(recv>EPS))continue; ev.push({s:sym(f.coin),t:f.time,buy:true,qty:recv,amt:q*px*rate+(baseFee?0:feeVal)}); }
    else ev.push({s:sym(f.coin),t:f.time,buy:false,qty:q,amt:q*px*rate,fee:feeVal});
  }
  const rows=[];
  const row=(e,qty,acquired,cost,rule,unknown)=>{ const share=qty/e.qty, proceeds=e.amt*share, c=cost+(e.fee||0)*share;
    rows.push({symbol:e.s,qty,acquired,disposed:e.t,proceeds,cost:c,gain:proceeds-c,rule,unknownBasis:!!unknown}); };
  const bySym={}; for(const e of ev)(bySym[e.s]=bySym[e.s]||[]).push(e);
  for(const s in bySym){ const E=bySym[s];
    if(method==='acb'){ let qty=0,cost=0;
      for(const e of E){ if(e.buy){ qty+=e.qty; cost+=e.amt; continue; }
        const take=Math.min(e.qty,qty), part=qty>EPS?cost*take/qty:0;
        if(take>EPS){ row(e,take,null,part,'acb'); qty-=take; cost-=part; if(qty<=EPS){qty=0;cost=0;} }
        if(e.qty-take>EPS)row(e,e.qty-take,null,0,'unknown',true); } }
    else if(method==='uk'){
      // per UTC day: total bought (qty, cost) and the day's disposals
      const dayOf=t=>Math.floor(t/DAY), days={};
      for(const e of E){ const d=days[dayOf(e.t)]=days[dayOf(e.t)]||{d:dayOf(e.t),bq:0,bc:0,sells:[]}; if(e.buy){ d.bq+=e.qty; d.bc+=e.amt; } else d.sells.push({e,left:e.qty}); }
      const D=Object.values(days).sort((a,b)=>a.d-b.d);
      const take=(d,want)=>{ const q=Math.min(want,d.bq), c=d.bq>EPS?d.bc*q/d.bq:0; d.bq-=q; d.bc-=c; if(d.bq<=EPS){d.bq=0;d.bc=0;} return [q,c]; };
      for(const d of D) for(const x of d.sells){ if(x.left<=EPS||d.bq<=EPS)continue; const [q,c]=take(d,x.left); row(x.e,q,x.e.t,c,'same-day'); x.left-=q; }
      for(const d of D) for(const x of d.sells){ for(const n of D){ if(x.left<=EPS)break; if(n.d<=d.d||n.d>d.d+30||n.bq<=EPS)continue;
        const [q,c]=take(n,x.left); row(x.e,q,n.d*DAY,c,'30-day'); x.left-=q; } }
      let pq=0,pc=0;
      for(const d of D){ pq+=d.bq; pc+=d.bc; // what's left of the day's buys joins the pool (the day's own sells were matched first)
        for(const x of d.sells){ if(x.left<=EPS)continue; const q=Math.min(x.left,pq), c=pq>EPS?pc*q/pq:0;
          if(q>EPS){ row(x.e,q,null,c,'s104'); pq-=q; pc-=c; if(pq<=EPS){pq=0;pc=0;} }
          if(x.left-q>EPS)row(x.e,x.left-q,null,0,'unknown',true); x.left=0; } } }
    else { const L=[];
      for(const e of E){ if(e.buy){ L.push({qty:e.qty,unit:e.amt/e.qty,t:e.t}); continue; }
        let rem=e.qty;
        while(rem>EPS){ const lot=L[0]; if(!lot){ row(e,rem,null,0,'unknown',true); break; }
          const q=Math.min(rem,lot.qty); row(e,q,lot.t,q*lot.unit,'fifo'); lot.qty-=q; rem-=q; if(lot.qty<=EPS)L.shift(); } } }
  }
  rows.sort((a,b)=>a.disposed-b.disposed||(a.symbol<b.symbol?-1:1));
  return {rows,missingFx,buys:ev.filter(e=>e.buy)};
}
// The preset's view of the disposals: tax year, the flags that change the tax, a per-year summary.
function taxReport(fills, nameByCoin, presetKey, fx){
  const P=TAX_PRESETS[presetKey]||TAX_PRESETS.other;
  const {rows,missingFx,buys}=taxDisposals(fills,nameByCoin,P.method,fx);
  for(const r of rows){
    r.year=taxYearLabel(r.disposed,P.year);
    const over=r.acquired!=null&&heldOverYear(r.acquired,r.disposed);
    if(presetKey==='us')r.flag=r.unknownBasis?'unknown basis':over?'long-term':'short-term';
    else if(presetKey==='de')r.flag=over?'tax-free (held over 1 year)':'';
    else if(presetKey==='au')r.flag=over&&r.gain>0?'CGT discount may apply (held 12+ months)':'';
    else if(presetKey==='ca')r.flag=r.gain<0&&buys.some(b=>b.s===r.symbol&&Math.abs(b.t-r.disposed)<=30*86400000)?'possible superficial loss':'';
    else r.flag='';
    if(r.unknownBasis&&presetKey!=='us')r.flag=(r.flag?r.flag+'; ':'')+'unknown basis';
  }
  const years={};
  for(const r of rows){ const y=years[r.year]=years[r.year]||{year:r.year,n:0,proceeds:0,cost:0,gains:0,losses:0,net:0,flagged:0,exempt:0};
    y.n++; y.proceeds+=r.proceeds; y.cost+=r.cost; if(r.gain>=0)y.gains+=r.gain; else y.losses+=r.gain; y.net+=r.gain;
    if(r.flag&&!/^(short|long)-term$/.test(r.flag))y.flagged++; if(presetKey==='de'&&/tax-free/.test(r.flag))y.exempt+=r.gain; }
  return {preset:P,rows,years:Object.values(years).sort((a,b)=>a.year<b.year?-1:1),missingFx,unknown:rows.filter(r=>r.unknownBasis).length};
}
// [from, to) in ms of a taxYearLabel label ('2025', '2024/25', 'FY2024-25'), UTC like the labels
function taxYearBounds(label, kind){ const y=+String(label).replace(/^FY/,'').slice(0,4); if(!(y>1970))return [null,null];
  const m=kind==='uk'?3:kind==='au'?6:0, d=kind==='uk'?6:1; return [Date.UTC(y,m,d),Date.UTC(y+1,m,d)]; }
/* ---- tax software: Koinly's universal CSV and CoinTracker's CSV ---- */
// Amounts stay in the coins traded (the tools price them in your currency themselves). Spot fills
// are trades: received / sent, the fee in its own coin. Perps keep the other exports' treatment:
// each closed trade at its close time, its realised P&L a margin gain or loss with the trading fees
// in the fee column, and the funding attributed to it as its own row (paid: a margin fee). Capital
// flows are plain transfers. src: {fills, trades, flows, nameByCoin, quoteByCoin, from, to}.
function taxNum(v){ const s=(+v).toFixed(8).replace(/\.?0+$/,''); return s==='-0'?'0':s; }
function taxToolRows(fmt, src){
  const nm=src.nameByCoin||{}, qm=src.quoteByCoin||{}, ev=[], STB=/^(USDC|USDT0?|USDH|USDE|USD)$/;
  const inR=t=>t>=(src.from||0)&&(src.to==null||t<src.to);
  const add=(t,o)=>{ if(inR(t))ev.push(Object.assign({t},o)); };
  for(const f of (src.fills||[])){ const c=f&&String(f.coin||''); if(!c.includes('/')&&!c.startsWith('@'))continue;
    const q=Math.abs(+f.sz||0), px=+f.px||0, fee=Math.abs(+f.fee||0); if(!(q>0)||!(px>0))continue;
    const base=nm[c]||nm[c.split('/')[0]]||c.split('/')[0], quote=c.includes('/')?c.split('/')[1]:qm[c]||'USDC', amt=q*px, buy=f.side==='B';
    add(f.time,{sent:buy?[amt,quote]:[q,base],recv:buy?[q,base]:[amt,quote],fee:fee?[fee,f.feeToken||quote]:null,worth:STB.test(quote)?amt:null,
      k:buy?'buy':'sell',desc:'Spot '+(buy?'buy ':'sell ')+base+'/'+quote}); }
  for(const t of (src.trades||[])){ if(t.market!=='perp'||t.isOpen||!t.closeTime)continue;
    const cur=t.venue==='bybit'||t.venue==='binance'?'USDT':'USDC', what=(t.symbol||t.coin)+' '+String(t.dir||'').toLowerCase()+' perp';
    const pnl=+t.pnl||0, fees=+t.fees||0, fund=+t.funding||0, fee=fees>0?[fees,cur]:null;
    if(pnl||fee)add(t.closeTime,pnl>0?{recv:[pnl,cur],fee,worth:pnl,k:'gain',desc:what+' realised profit'}:pnl<0?{sent:[-pnl,cur],fee,worth:-pnl,k:'loss',desc:what+' realised loss'}
      :{sent:fee,worth:fees,k:'cost',desc:what+' trading fees'});
    if(fees<0)add(t.closeTime,{recv:[-fees,cur],worth:-fees,k:'rebate',desc:what+' fee rebate'});
    if(fund)add(t.closeTime,fund>0?{recv:[fund,cur],worth:fund,k:'fundin',desc:what+' funding received'}:{sent:[-fund,cur],worth:-fund,k:'fundout',desc:what+' funding paid'}); }
  const FL={deposit:'Deposit',withdraw:'Withdrawal',vaultDeposit:'Into a vault',vaultCreate:'Into a vault',vaultWithdraw:'Out of a vault',subAccountTransfer:'Sub-account transfer'};
  for(const f of (src.flows||[])){ const u=+f.usdc||0; if(!u)continue;
    add(f.time,u>0?{recv:[u,'USDC'],worth:u,k:'in',desc:FL[f.type]||'Transfer in'}:{sent:[-u,'USDC'],worth:-u,k:'out',desc:FL[f.type]||'Transfer out'}); }
  ev.sort((a,b)=>a.t-b.t);
  const K=fmt==='koinly', LB=K?{gain:'realized gain',loss:'realized gain',cost:'cost',rebate:'realized gain',fundin:'realized gain',fundout:'margin fee'}
    :{gain:'margin_gain',loss:'margin_loss',cost:'margin_fee',rebate:'margin_rebate',fundin:'margin_gain',fundout:'margin_fee'};
  const iso=ms=>new Date(ms).toISOString(), date=ms=>K?iso(ms).replace('T',' ').slice(0,19):iso(ms).replace(/^(\d+)-(\d+)-(\d+)T(\d\d:\d\d:\d\d).*$/,'$2/$3/$1 $4');
  const p=x=>x?[taxNum(x[0]),x[1]]:['',''];
  const head=K?['Date','Sent Amount','Sent Currency','Received Amount','Received Currency','Fee Amount','Fee Currency','Net Worth Amount','Net Worth Currency','Label','Description','TxHash']
    :['Date','Received Quantity','Received Currency','Sent Quantity','Sent Currency','Fee Amount','Fee Currency','Tag'];
  const rows=ev.map(e=>K?[date(e.t),...p(e.sent),...p(e.recv),...p(e.fee),e.worth!=null?taxNum(e.worth):'',e.worth!=null?'USD':'',LB[e.k]||'',e.desc,'']
    :[date(e.t),...p(e.recv),...p(e.sent),...p(e.fee),LB[e.k]||'']);
  const n={}; for(const e of ev)n[e.k]=(n[e.k]||0)+1;
  return {head,rows,n,times:ev.map(e=>e.t)};
}
// One CSV cell, for every export the app writes (the server's csvCell is the same rule). Notes, tags
// and labels open in Excel/Sheets, where a leading = @ (or a +/- that isn't a number) runs as a
// formula: checked after leading whitespace too, since some importers trim first. CR is quoted
// with LF, or an importer that splits records on it moves the rest of the row.
function csvCell(v){ let s=v==null?'':String(v); const t0=s.replace(/^\s+/,'');
  if(/^[=@]/.test(t0)||(/^[+-]/.test(t0)&&!isFinite(Number(t0))))s="'"+s;
  return /[",\n\r]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s; }
function taxToolCsv(fmt, src){ const r=taxToolRows(fmt,src), q=csvCell;
  return [r.head,...r.rows].map(x=>x.map(q).join(',')).join('\r\n'); }
function edgeSignificance(nets){ const m=_avg(nets),sd=_std(nets),N=nets.length;
  const t=(sd>0&&N>1)?m/(sd/Math.sqrt(N)):null; const p=t!=null?1-_tCdf(t,N-1):null;
  const d=sd>0?m/sd:null; const needN=(d&&d>0)?Math.ceil((1.645/d)**2):null;
  return {t,p,needN,d}; }

/* ============================ edge decay ============================ */
// One-sided CUSUM on the sign-adjusted deviation of forward per-trade results from the
// discovery expectancy. Standardized by the forward sample sd (fallback |refExp|), drift
// allowance k=0.5, trip threshold h=4 — catches slow decay a point comparison misses.
// Pure given _std. sign=+1 tracks a positive edge fading; sign=-1 tracks a leak healing.
function cusumDrift(nets, refExp, sign){
  sign = sign>=0 ? 1 : -1;
  const sd = _std(nets) || Math.abs(refExp) || 1;
  let c=0, max=0, trip=false; const series=[];
  for(const x of nets){ const z=(sign*(refExp-x))/sd; c=Math.max(0,c+z-0.5); series.push(c); if(c>max)max=c; if(c>=4)trip=true; }
  return {stat:c, max, trip, series};
}
// Three-state decay verdict for a pinned pattern, scored on forward-only trades (closed
// after pinnedAt — the caller guarantees that filter). Pure given _avg/_std/cusumDrift.
// disc={exp,n,ci:[lo,hi]|null}. Direction-aware: a pinned leak (exp<0) "holds" by staying
// negative, so everything is judged in sign-adjusted units. Detectors:
//   band  — trailing-window rolling mean vs the lower edge of the discovery CI (or half
//           the discovered edge when the pin predates CI capture); trips after breachK
//           consecutive breaches ending at the latest trade, so recovery heals it.
//   cusum — cumulative drift below discovery expectancy (see cusumDrift).
// dead requires both detectors, or an outright adverse forward expectancy with n>=15.
function decayAssess(fwdNets, disc, opts){
  opts=opts||{};
  const minN=opts.minN||8, W=opts.window||20, K=opts.breachK||4;
  const n=fwdNets.length, sign=(disc.exp<0)?-1:1;
  const roll=[]; for(let i=0;i<n;i++) roll.push(_avg(fwdNets.slice(Math.max(0,i-W+1),i+1)));
  const lo=(disc.ci && isFinite(disc.ci[0]) && isFinite(disc.ci[1]))
    ? (sign>0?disc.ci[0]:-disc.ci[1])
    : Math.abs(disc.exp)*0.5;
  const bandLo=sign>0?lo:-lo;
  if(n<minN) return {status:'collecting', n, fwdExp:n?_avg(fwdNets):null, roll, bandLo, trailing:0, cusum:null};
  const fwdExp=_avg(fwdNets);
  let trailing=0; for(let i=n-1;i>=minN-1;i--){ if(sign*roll[i]<lo)trailing++; else break; }
  const cusum=cusumDrift(fwdNets, disc.exp, sign);
  const bandTrip=trailing>=K, adverse=sign*fwdExp<=0;
  const status=(bandTrip&&cusum.trip)||(adverse&&n>=15) ? 'dead'
    : (bandTrip||cusum.trip||sign*fwdExp<lo) ? 'degrading' : 'healthy';
  return {status, n, fwdExp, roll, bandLo, trailing, cusum:{stat:cusum.stat,max:cusum.max,trip:cusum.trip}};
}

/* ============================ pattern miner ============================ */
// Mines single conditions AND pairwise interactions over trade features (+journal metadata),
// tests each with a permutation test, controls false discoveries with Benjamini–Hochberg (FDR 10%),
// then prunes diluted marginals, complements, and overlapping echoes.
// Check-in conditions: [display name, stable id]. The id alone rebuilds the predicate
// (checkinPred), so pinned patterns and rules made from them never go unresolvable.
const CHECKIN_CONDS=[['slept badly (sleep \u22642/5)','ck:sleepLo'],['high stress (\u22654/5)','ck:stressHi'],
  ['low focus (\u22642/5)','ck:focusLo'],['sharp focus (\u22654/5)','ck:focusHi']];
function checkinPred(id){
  const day=t=>journal[dayJKey(t.openTime)]||{};
  if(id==='ck:sleepLo')return t=>{ const v=+day(t).sleep; return v>=1&&v<=2; };
  if(id==='ck:stressHi')return t=>{ const v=+day(t).stress; return v>=4; };
  if(id==='ck:focusLo')return t=>{ const v=+day(t).focus; return v>=1&&v<=2; };
  if(id==='ck:focusHi')return t=>{ const v=+day(t).focus; return v>=4; };
  return null;
}
function minerFams(closed,ST,fz){
  // fz = frozen thresholds from the moment a pattern was pinned; without it thresholds
  // are recomputed from `closed`. Ids (3rd tuple element) are stable, name-independent
  // handles so pinned patterns can be re-resolved after names/thresholds drift.
  fz=fz||{};
  const H=t=>tzHour(t.closeTime), D=t=>tzDow(t.closeTime); const TZ=tzLabel();
  const qv=(vals,p)=>{const s=[...vals].sort((a,b)=>a-b);return s.length?s[Math.min(s.length-1,Math.floor(p*s.length))]:null;};
  const notion=t=>(t.maxSize||0)*(t.avgEntry||0);
  const nq3=fz.nq3!=null?fz.nq3:(qv(closed.map(notion).filter(x=>x>0),0.75)||Infinity), nq1=fz.nq1!=null?fz.nq1:(qv(closed.map(notion).filter(x=>x>0),0.25)||0);
  const hq3=fz.hq3!=null?fz.hq3:(qv(closed.map(t=>t.durationMs||0).filter(x=>x>0),0.75)||Infinity), hq1=fz.hq1!=null?fz.hq1:(qv(closed.map(t=>t.durationMs||0).filter(x=>x>0),0.25)||0);
  let _dq3=null,_maq3=null,_maq1=null,_mfMed=null;
  // compact formatters so condition names carry their actual thresholds ("largest 25% by $ size (≥ $12.5k)")
  const fUsd=n=>!isFinite(n)?'':n>=1e6?'$'+(n/1e6).toFixed(1)+'M':n>=1e3?'$'+(n/1e3).toFixed(1)+'k':'$'+n.toFixed(0);
  const fDur=ms=>{ if(!isFinite(ms)||ms<=0)return ''; const m=ms/60000; return m<1?Math.round(ms/1000)+'s':m<90?Math.round(m)+' min':m<2880?(m/60).toFixed(1)+'h':(m/1440).toFixed(1)+'d'; };
  const fams={
    dir:[['Long trades',t=>t.dir==='Long','dir:Long'],['Short trades',t=>t.dir==='Short','dir:Short'],['Spot buys',t=>t.dir==='Spot','dir:Spot']],
    market:(()=>{ const cnt={}; closed.forEach(t=>{const k=t.symbol||dcoin(t);cnt[k]=(cnt[k]||0)+1;});
      return Object.entries(cnt).sort((a,b)=>b[1]-a[1]).slice(0,12).map(([c])=>[dispMarket(c),t=>(t.symbol||dcoin(t))===c,'mkt:'+c]); })(),
    session:[['00–08h '+TZ,t=>H(t)<8,'sess:0'],['08–16h '+TZ,t=>H(t)>=8&&H(t)<16,'sess:1'],['16–24h '+TZ,t=>H(t)>=16,'sess:2']],
    day:[['weekends',t=>D(t)===0||D(t)===6,'day:we'],['weekdays',t=>D(t)>0&&D(t)<6,'day:wd']],
    hold:[['quick trades'+(isFinite(hq1)&&hq1>0?' (held under '+fDur(hq1)+')':' (fastest 25%)'),t=>(t.durationMs||0)<=hq1,'hold:lo'],
          ['long holds'+(isFinite(hq3)?' (held over '+fDur(hq3)+')':' (slowest 25%)'),t=>(t.durationMs||0)>=hq3,'hold:hi']],
    size:[['largest 25% by $ size'+(isFinite(nq3)?' (\u2265 '+fUsd(nq3)+')':''),t=>notion(t)>=nq3,'size:hi'],
          ['smallest 25% by $ size'+(nq1>0?' (\u2264 '+fUsd(nq1)+')':''),t=>notion(t)<=nq1,'size:lo']],
    state:[
      ['entered within 1h of a loss',t=>{const x=ST.get(t.id);return !!(x&&x.prevNet!=null&&isLoss(x.prevNet)&&x.gap<=3600000);},'st:loss1h'],
      ['entered after 2+ straight losses',t=>{const x=ST.get(t.id);return !!(x&&x.streak<=-2);},'st:loss2'],
      ['entered after 2+ straight wins',t=>{const x=ST.get(t.id);return !!(x&&x.streak>=2);},'st:win2'],
      ['re-entered within 15 min of last trade',t=>{const x=ST.get(t.id);return !!(x&&x.gap!=null&&x.gap<=9e5);},'st:re15'],
      ['4th-or-later trade of the day',t=>{const x=ST.get(t.id);return !!(x&&x.idxDay>=4);},'st:idx4'],
      ['entered while down on the day',t=>{const x=ST.get(t.id);return !!(x&&x.dayPnl<0);},'st:red'],
    ],
  };
  const setups=[...new Set(closed.map(t=>(journal[t.id]||{}).setup).filter(Boolean))].slice(0,8);
  if(setups.length)fams.setup=setups.map(sn=>['setup: '+sn,t=>(journal[t.id]||{}).setup===sn,'setup:'+sn]);
  const tags=[...new Set(closed.flatMap(t=>(journal[t.id]||{}).tags||[]))].slice(0,8);
  if(tags.length)fams.tag=tags.map(tg=>['tag: '+tg,t=>((journal[t.id]||{}).tags||[]).includes(tg),'tag:'+tg]);
  if(closed.some(t=>{const j=journal[t.id]||{};return j.mistakes&&j.mistakes.length;}))
    fams.flag=[['mistake-flagged',t=>{const j=journal[t.id]||{};return !!(j.mistakes&&j.mistakes.length);},'flag:any']];
  // session check-in (day journal, 1–5): judged on the entry day — known before the trade
  { const ck=CHECKIN_CONDS.map(([nm,id])=>[nm,checkinPred(id),id]);
    const withCk=closed.filter(t=>{ const d=journal[dayJKey(t.openTime)]; return !!(d&&(d.sleep||d.stress||d.focus)); }).length;
    if(fz.ck||(settings.coachMode!==false&&withCk>=10))fams.mood=ck; }
  if(closed.some(t=>(journal[t.id]||{}).rating))
    fams.rating=[['rated ≤2★ execution',t=>{const r=(journal[t.id]||{}).rating;return !!r&&r<=2;},'rate:lo'],
                 ['rated 4–5★ execution',t=>{const r=(journal[t.id]||{}).rating;return !!r&&r>=4;},'rate:hi']];
  // execution style: taker share of notional (fill-level truth, always available)
  const tk=t=>{const tot=(t.makerNotional||0)+(t.takerNotional||0);return tot>0?(t.takerNotional||0)/tot:null;};
  fams.exec=[['mostly market orders (\u226575% taker volume)',t=>{const x=tk(t);return x!=null&&x>=0.75;},'exec:taker'],
             ['mostly limit orders (\u226425% taker volume)',t=>{const x=tk(t);return x!=null&&x<=0.25;},'exec:maker'],
             ['added to a losing position (real adds, from fills)',t=>addedToLoser(t),'exec:atl']];
  // entry drift: chased entries (scaled in at adverse prices), when drift is known for most trades
  const drifts=closed.map(t=>t.entryDrift).filter(x=>x!=null&&isFinite(x));
  if(fz.dq3!=null || drifts.length>=closed.length*0.5){ const dq3=fz.dq3!=null?fz.dq3:qv(drifts,0.75); _dq3=dq3;
    if(dq3!=null&&dq3>0)fams.drift=[['chased entries (added at worsening prices, worst 25%)',t=>t.entryDrift!=null&&t.entryDrift>=dq3,'drift:hi']]; }
  // excursion families: available once MAE/MFE has been computed for most of this pool
  const exR=closed.map(t=>_excM[t.id]).filter(e=>e&&e.maePct!=null);
  if(fz.maq3!=null || exR.length>=closed.length*0.6){
    const maq3=fz.maq3!=null?fz.maq3:qv(exR.map(e=>e.maePct),0.75), maq1=fz.maq1!=null?fz.maq1:qv(exR.map(e=>e.maePct),0.25);
    const mfMed=fz.mfMed!=null?fz.mfMed:qv(exR.map(e=>e.mfePct),0.5);
    _maq3=maq3; _maq1=maq1; _mfMed=mfMed;
    const EX=t=>_excM[t.id];
    fams.exc=[['went deep underwater first (worst 25% MAE)',t=>{const e=EX(t);return !!e&&e.maePct!=null&&e.maePct>=maq3;},'exc:maeHi'],
              ['barely went underwater (best 25% MAE)',t=>{const e=EX(t);return !!e&&e.maePct!=null&&e.maePct<=maq1;},'exc:maeLo'],
              ['peaked in profit but closed red (MFE \u2265 median)',t=>{const e=EX(t);return !!e&&e.mfePct!=null&&e.mfePct>=mfMed&&t.net<=0;},'exc:giveback']];
  }
  // frozen-threshold capture for pinning (non-enumerable: for..in over families must not see it)
  Object.defineProperty(fams,'__params',{value:{nq3:isFinite(nq3)?nq3:null,nq1,hq3:isFinite(hq3)?hq3:null,hq1,dq3:_dq3,maq3:_maq3,maq1:_maq1,mfMed:_mfMed,ck:!!fams.mood||undefined},enumerable:false});
  return fams;
}
function mineInsights(closed,V){ V=V||(t=>t.net);
  const N=closed.length; if(N<30) return null;
  // chronological order is essential: discover on the earlier slice, confirm on the later (held-out) slice.
  const chron=[...closed].sort((a,b)=>a.closeTime-b.closeTime);
  const ST=tradeStates(chron); // sequential state computed over the FULL sequence so held-out trades are correct
  // split only when both sides are big enough to mean anything; otherwise mine the whole sample (in-sample only).
  const canSplit = N>=60;
  const splitAt = canSplit ? Math.round(N*0.70) : N;
  const disc = chron.slice(0, splitAt), hold = chron.slice(splitAt);
  const split = canSplit && hold.length>=15 && disc.length>=30;
  const mineSet = split ? disc : chron, holdSet = split ? hold : [];
  const Nd = mineSet.length;
  const minN=Math.max(8,Math.round(Nd*0.05)), maxN=Math.round(Nd*0.9);
  const fams=minerFams(mineSet,ST); // quantile/market thresholds come from the discovery slice only

  const singles=[]; for(const f in fams) for(const [name,fn,cid] of fams[f]) singles.push({name,fn,fam:f,cid});
  const cands=[];
  const idxOf=fn=>{ const a=[]; for(let i=0;i<Nd;i++) if(fn(mineSet[i]))a.push(i); return a; };
  const singleIdx=singles.map(s=>idxOf(s.fn));
  singles.forEach((s,i)=>{ const idx=singleIdx[i]; if(idx.length>=minN&&idx.length<=maxN)cands.push({name:s.name,fams:[s.fam],pid:s.cid,idx,pred:s.fn}); });
  for(let a=0;a<singles.length;a++)for(let b=a+1;b<singles.length;b++){
    if(singles[a].fam===singles[b].fam)continue;
    const setB=new Set(singleIdx[b]); const idx=singleIdx[a].filter(i=>setB.has(i));
    if(idx.length>=minN&&idx.length<=maxN){ const fA=singles[a].fn,fB=singles[b].fn;
      cands.push({name:singles[a].name+' × '+singles[b].name,fams:[singles[a].fam,singles[b].fam],pid:singles[a].cid+'&'+singles[b].cid,idx,pred:t=>fA(t)&&fB(t)}); }
  }
  // permutation test (reusable buffer, partial Fisher–Yates)
  const nets=Float64Array.from(mineSet.map(V)); let mAll=0; for(let i=0;i<Nd;i++)mAll+=nets[i]; mAll/=Nd;
  const budget=6e7; const totalWork=cands.reduce((s,c)=>s+c.idx.length,0)||1;
  const PERMS=Math.max(200,Math.min(800,Math.floor(budget/totalWork)));
  const buf=new Int32Array(Nd); for(let i=0;i<Nd;i++)buf[i]=i;
  let _pi=0;
  for(const c of cands){
    let s=0; for(const i of c.idx)s+=nets[i]; const m=s/c.idx.length;
    c.n=c.idx.length; c.exp=m; c.uplift=(m-mAll)*c.n;
    const obs=Math.abs(m-mAll); let ge=0;
    for(let p=0;p<PERMS;p++){ let ps=0;
      for(let k=0;k<c.n;k++){ const j=k+((_rng()*(Nd-k))|0); const tmp=buf[k];buf[k]=buf[j];buf[j]=tmp; ps+=nets[buf[k]]; }
      if(Math.abs(ps/c.n-mAll)>=obs)ge++; }
    c.p=(ge+1)/(PERMS+1);
    if(_progress&&(++_pi%16===0||_pi===cands.length))_progress(_pi,cands.length);
  }
  // BH FDR 10%
  const sorted=[...cands].sort((a,b)=>a.p-b.p); const M=sorted.length, Q=0.10;
  let cut=-1; for(let i=0;i<M;i++) if(sorted[i].p<=(i+1)/M*Q)cut=i;
  let validated=sorted.slice(0,cut+1);
  const suggestive=sorted.slice(cut+1).filter(c=>c.p<=0.05).sort((a,b)=>Math.abs(b.uplift)-Math.abs(a.uplift)).slice(0,4);
  // prune: pairs must beat sharper parent per-trade
  const expByName={}; for(const c of cands) if(!c.name.includes(' × '))expByName[c.name]=c.exp;
  validated=validated.filter(v=>{ if(v.fams.length===1)return true;
    const pBest=Math.max(...v.name.split(' × ').map(p=>expByName[p]!=null?Math.abs(expByName[p]-mAll):0));
    return Math.abs(v.exp-mAll)>=pBest*1.5; });
  // prune: complement partitions
  const drop=new Set();
  for(let i=0;i<validated.length;i++)for(let j=i+1;j<validated.length;j++){
    const a=validated[i],b=validated[j];
    if(a.fams.length===1&&b.fams.length===1&&a.fams[0]===b.fams[0]&&a.n+b.n===Nd
       // relative tolerance: uplifts are dollar sums, and float accumulation order makes exact
       // complements miss an absolute 1e-6 on large accounts — letting both eat result slots
       &&Math.abs(a.uplift+b.uplift)<1e-6*Math.max(1,Math.abs(a.uplift),Math.abs(b.uplift)))
      drop.add(Math.abs(a.exp-mAll)>=Math.abs(b.exp-mAll)?b.name:a.name); }
  validated=validated.filter(v=>!drop.has(v.name));
  validated.sort((a,b)=>Math.abs(b.uplift)-Math.abs(a.uplift));
  // prune: greedy overlap (echoes of one underlying effect)
  const kept=[],covP=new Set(),covN=new Set();
  for(const v of validated){ const cov=v.uplift>=0?covP:covN;
    let ov=0; for(const i of v.idx)if(cov.has(i))ov++;
    if(ov/v.idx.length<0.6){kept.push(v);for(const i of v.idx)cov.add(i);} }
  const top=kept.slice(0,8);
  // enrich: bootstrap CI on the discovery expectancy, then re-test each survivor out-of-sample
  const mAllHold = holdSet.length ? _avg(holdSet.map(V)) : null;
  const enrich=v=>{ const vals=[]; for(const i of v.idx)vals.push(nets[i]); v.ci=bootstrapMeanCI(vals,800);
    if(split){ const oi=holdSet.filter(v.pred); v.oosN=oi.length; v.oosExp=oi.length?_avg(oi.map(V)):null;
      v.holds = (v.oosN>=5 && v.oosExp!=null && Math.sign(v.oosExp-mAllHold)===Math.sign(v.exp-mAll)); }
  };
  top.forEach(enrich); suggestive.forEach(enrich);
  // strip functions/index arrays: they can't cross postMessage (DataCloneError), which was
  // silently forcing the miner onto the blocking main-thread fallback. pid strings remain.
  const strip=v=>{ delete v.pred; delete v.idx; return v; };
  return {validated:top.map(strip),suggestive:suggestive.map(strip),tested:M,minN,perms:PERMS,mAll,
    split,discN:mineSet.length,holdN:holdSet.length,mAllHold,famParams:fams.__params||null};
}
function avgLossOf(closed){ const l=closed.filter(t=>isLoss(t.net)).map(t=>-t.net); return l.length?_avg(l):null; }
let _oneR=null;
function computeOneR(closed){
  if((settings.rBasis||'avgloss')==='fixed'){ const d=parseFloat(settings.riskDefault); return d>0?d:null; }
  return avgLossOf(closed);
}

/* ============================ analytics ============================ */
/* dex-source filter: '' = main dex, otherwise the HIP-3 builder dex name (fills name HIP-3 assets "dex:COIN") */
let dexView='all', dexSel=new Set();
function tradeDex(t){ const c=t&&t.coin; if(typeof c!=='string')return '';
  const i=c.indexOf(':'); return (i>0 && !c.includes('/') && !c.startsWith('@'))?c.slice(0,i):''; }
function dexOk(d){ if(dexView==='main')return !d;
  if(dexView==='hip3')return !!d && (dexSel.size?dexSel.has(d):true);
  return true; }
function dexFilter(t){ return dexOk(tradeDex(t)); }
function knownDexes(){ const s=new Set();
  for(const t of allTrades){ const d=tradeDex(t); if(d)s.add(d); }
  for(const p of openPositions){ if(p.dex)s.add(p.dex); }
  return [...s].sort(); }
function dexPositions(){ return dexView==='all'?openPositions:openPositions.filter(p=>dexOk(p.dex||'')); }
// A trade whose result the fills can't give is out of every statistic: an orphan (open here, but the exchange
// no longer holds it) or one a seam in the fills shrank or closed off the record (offRecord) once it has closed —
// while still open it stays in view, its result isn't final anyway. The same test is inlined wherever orphans
// were already left out (coach, progress, pulse, fee tier, reconcile): those run in bare contexts in the tests.
function viewFilter(t){ return !(t.orphan||(t.offRecord&&!t.isOpen)) && (view==='combined' ? true : t.market===view) && dexFilter(t); }
// The trades table keeps the off-record ones (badged "incomplete"): they happened, they carry notes, and
// hiding them made a TWAP-heavy wallet's history look thinner than it was. Orphans stay out as before.
function tableFilter(t){ return !t.orphan && !t.spotRz && (view==='combined' ? true : t.market===view) && dexFilter(t); }
// Two populations out of one list. Trade rows (perp trades, spot positions): counted, rated, listed.
// Money rows (perp trades, spot day rows): summed into P&L, fees, volume, the curve and the calendar.
// A spot position is never money (its sells are in the day rows); a day row is never a trade.
function tradeRow(t){ return !t.spotRz; }
function moneyRow(t){ return !t.spotPos; }
// The two closed populations, for every corner that needs "closed trades" without the period: the
// completed trades (perp trades and spot round trips; not a balance that merely left, not a result
// the fills can't give) and the realized money (perp trades and spot day rows). f narrows further.
function closedTrades(f){ return allTrades.filter(t=>!t.isOpen&&t.closeTime&&tradeRow(t)&&!t.movedOut&&!(t.orphan||t.offRecord)&&(!f||f(t))); }
function closedMoney(f){ return allTrades.filter(t=>!t.isOpen&&t.closeTime&&moneyRow(t)&&!(t.orphan||t.offRecord)&&(!f||f(t))); }
// The all-time net the fills can't give: Hyperliquid's own P&L for a market ('perp', 'spot' or
// 'combined' — what its app and trackers such as Hyperdash show, unrealized included) with the
// fill-based sum beside it, when seams were found or, for perps, the two differ materially.
// Otherwise null and the fills stand on their own: spot's verified figure is the whole account's
// minus perps and always differs from the fills (unsold holdings, airdrops, transferred tokens).
// Shared by the journal's Net PnL card and Daruma's Stats tile, so the two say the same thing;
// each caller decides when the all-time, every-dex figure applies to what it shows.
// several wallets' curves as one: at every time any of them has a point, the sum of each one's latest
// value so far (a step series). Pure.
function sumSeries(list){
  const L=(list||[]).filter(s=>Array.isArray(s)&&s.length); if(!L.length)return [];
  if(L.length===1)return L[0].slice();
  const times=[...new Set(L.flatMap(s=>s.map(p=>p[0])))].sort((a,b)=>a-b), idx=L.map(()=>0), cur=L.map(()=>0), out=[];
  for(const t of times){ for(let i=0;i<L.length;i++){ const s=L[i]; while(idx[i]<s.length&&s[idx[i]][0]<=t){ cur[i]=s[idx[i]][1]; idx[i]++; } }
    out.push([t,cur.reduce((a,b)=>a+b,0)]); }
  return out;
}
// Hyperliquid's own all-time P&L curve for a market: perps as reported, the whole account for
// combined, spot as the difference (the account's minus perps, pointwise). null without one.
function verifiedCurve(mkt){
  const h=hlPnl&&hlPnl.hist; if(!h)return null;
  const c=mkt==='perp'?h.perp:mkt==='spot'?sumSeries([h.all,(h.perp||[]).map(p=>[p[0],-p[1]])]):h.all;
  return c&&c.length>1?c:null;
}
// A curve cut to [from, to] and rebased to zero at `from`: the point standing at `from` (the last one
// at or before it, else the first) becomes [from, 0]; null when fewer than two points remain.
function curveSlice(curve, from, to){
  if(!curve||curve.length<2)return null;
  const lo=from!=null?from:curve[0][0], hi=to!=null?to:Infinity;
  let base=null; for(const p of curve){ if(p[0]<=lo)base=p; else break; }
  const b=base?base[1]:curve[0][1], out=[];
  if(base||from!=null)out.push([lo,0]);
  for(const p of curve){ if(p[0]>lo&&p[0]<=hi)out.push([p[0],p[1]-b]); }
  return out.length>1?out:null;
}
// Hyperliquid's mark-to-market P&L (equity, unrealized included) for a market over a period: the
// densest of the exchange's spans that reaches back to `from` (a day, a week, a month, all time),
// cut and rebased there. All time when from is null. null without the exchange's curves.
function verifiedCurveFor(mkt, from, to){
  const h=hlPnl&&hlPnl.hist; if(!h)return null;
  const pick=sp=>{ if(!sp)return null; const c=mkt==='perp'?sp.perp:mkt==='spot'?sumSeries([sp.all,(sp.perp||[]).map(p=>[p[0],-p[1]])]):sp.all; return c&&c.length>1?c:null; };
  if(from==null)return pick(h);
  const spans=h.spans||{};
  for(const k of ['day','week','month']){ const c=pick(spans[k]); if(c&&c[0][0]<=from)return curveSlice(c,from,to); }
  const c=pick(h); return c?curveSlice(c,from,to):null;
}
// Where a fill-based total and the exchange's part company. Hyperliquid's archive begins on
// ARCHIVE_FROM; fills older than that come only from the API's own, finite memory, so a gap in them
// is history no source serves any more. The exchange's curve at that date against the fills' net up
// to it says how much of a difference is that, and how much is since (funding the API thins out,
// open positions' marks, or fills the archive could still close). null without the exchange's curve.
function reconcileSplit(trades, mkt, at){
  at=at||Date.UTC(2025,4,25); // 2025-05-25: the first day of hl-mainnet-node-data's node_fills
  const h=hlPnl&&hlPnl.hist&&(mkt==='perp'?hlPnl.hist.perp:hlPnl.hist.all); if(!h||!h.length)return null;
  let ex=0; for(const p of h){ if(p[0]<=at)ex=p[1]; else break; } // the curve's value at `at` (0 when the account is younger)
  let rec=0, n=0; for(const t of trades){ if(!t.isOpen&&t.closeTime<at){ rec+=t.net; n++; } }
  return {at, pre:rec-ex, n, ex, rec};
}
// A plain word, with no figures, on why figures built from fills may not match the exchange's own:
// the fills still have seams; or part of the history is older than anything still served (the
// archive begins 2025-05-25, the API forgets) and the two agree since; or they differ for another
// reason. The detail (the split, the deltas) lives in the reconciliation panel. null when there is
// nothing to say. Perp-only, like the reconciliation: spot never leads with the exchange's figure.
function historyNote(){
  const cov=typeof dataCoverage!=='undefined'?dataCoverage:null, seams=!!(cov&&cov.gaps>0);
  const SEAMS='Some fills are missing from this wallet’s history, so figures built from fills can differ from Hyperliquid’s own. The verified figure is the exchange’s.';
  const OLDER='Part of this wallet’s history is older than anything Hyperliquid still serves, so figures built from fills can differ from the exchange’s own. The verified figure is the exchange’s.';
  const GAP='Figures built from fills differ from Hyperliquid’s own for this wallet. A Shift-click on Refresh forces a full re-fetch; if it persists, trust the verified figure.';
  if(seams)return {kind:'seams',text:SEAMS};
  const perp=hlPnl&&hlPnl.perp; if(perp==null||hlPnl.partial)return null;
  const hl=t=>typeof candleVenue==='function'?!candleVenue(t):true;
  const rows=allTrades.filter(t=>hl(t)&&moneyRow(t)&&t.market==='perp'&&!(t.orphan||(t.offRecord&&!t.isOpen)));
  const pd=rows.reduce((s,t)=>s+t.net,0)-perp, lim=Math.max(2500,Math.abs(perp)*0.05);
  if(Math.abs(pd)<=lim)return null;
  const sp=reconcileSplit(rows,'perp'), pre=sp?sp.pre:0;
  if(sp&&Math.abs(pre)>Math.max(500,Math.abs(pd)*0.1))return {kind:Math.abs(pd-pre)<=lim?'older':'older+',text:Math.abs(pd-pre)<=lim?OLDER:OLDER+' Some recent fills may be missing too: a Shift-click on Refresh forces a full re-fetch.'};
  return {kind:'gap',text:GAP};
}
// the deepest fall from a high on a curve of [time, value] points
function curveDrawdown(curve){ let peak=-Infinity, dd=0, at=null; for(const [t,v] of (curve||[])){ if(v>peak)peak=v; const d=v-peak; if(d<dd){ dd=d; at=t; } } return {dd, at, peak:isFinite(peak)?peak:0}; }
function verifiedFigure(mkt){
  // Spot never leads with it: the seam check is perp-only (spot balances move without fills), and the
  // account's figure minus perps carries unsold holdings, airdrops and transferred tokens the spot fills
  // never had — a perp seam says nothing about the spot history.
  if(mkt==='spot')return null;
  const ver=mkt==='perp'?hlPnl.perp:hlPnl.all;
  if(ver==null||hlPnl.partial)return null; // a wallet the exchange didn't answer for: the sum understates and must not lead
  const hlOf=t=>!candleVenue(t)&&!t.orphan&&!t.offRecord&&(mkt==='combined'||mkt==='all'||t.market===mkt);
  const hl=allTrades.filter(t=>hlOf(t)&&!t.isOpen);
  const rec=hl.reduce((s,t)=>s+t.net,0);
  const seams=!!(dataCoverage&&dataCoverage.gaps>0);
  // The exchange's figure is account-based, unrealized included. Set against it, the fills must count
  // what open trades have realized so far and what the open positions are marked at — a large open
  // position used to read as a material gap on its own, and the exchange's curve took over a
  // dashboard whose fills were whole.
  const hlPos=p=>!p.venue||p.venue==='hyperliquid';
  const live=rec+allTrades.filter(t=>hlOf(t)&&t.isOpen).reduce((s,t)=>s+t.net,0)
    +(mkt==='perp'||mkt==='combined'||mkt==='all'?openPositions.filter(hlPos).reduce((s,p)=>s+(p.uPnl||0),0):0)
    +(mkt==='combined'||mkt==='all'?spotHoldings.filter(hlPos).reduce((s,h)=>s+(h.uPnl||0),0):0);
  if(!seams&&!(mkt==='perp'&&Math.abs(live-ver)>Math.max(2500,Math.abs(ver)*0.05)))return null;
  return {ver,rec,live,seams,n:hl.length,gaps:seams?dataCoverage.gaps:0,share:dataCoverage?(mkt==='perp'?dataCoverage.perpShare:dataCoverage.allShare):null};
}
let customRange={from:null,to:null};
function rangeActive(){ return customRange.from!=null||customRange.to!=null; }
function inRange(t){ if(customRange.from!=null&&t.closeTime<customRange.from)return false; if(customRange.to!=null&&t.closeTime>customRange.to)return false; return true; }
// A tiny identity + version memo (two slots per name) for heavy pure functions of a trade list that
// several views run on the same trades. A hit needs the very same trade objects in the same order —
// pointer-compared, O(n), since results can hold trade references — and the same `ver` (everything
// else the function reads, plus content sums that catch a trade changed in place), so it can only
// ever return what a recompute would.
function _sameTrades(a,b){ if(a===b)return true; if(!a||!b||a.length!==b.length)return false;
  for(let i=0;i<a.length;i++)if(a[i]!==b[i])return false; return true; }
function _tradesMemo(name,closed,ver,fn,allv){ const m=_tradesMemo[name]||(_tradesMemo[name]=[]);
  for(const e of m)if(e.ver===ver&&_sameTrades(e.trades,closed)&&_sameTrades(e.all,allv||null))return e.val;
  const val=fn(); m.unshift({ver,trades:closed.slice(),all:allv?allv.slice():null,val}); if(m.length>2)m.pop(); return val; }
// computeStats for the dashboard (render) and the Diagnostic, which run it on the same period trades.
// Besides the trades it reads the break-even band, 1R and per-trade journal risk (R stats) and the
// tz day buckets.
function computeStatsMemo(closed,allv){ allv=allv||closed; let a=0,b=0;
  for(const t of allv){ a+=t.net; b+=(t.closeTime||0)+(t.fees||0)+(t.funding||0)+(t.isOpen?1:0); }
  return _tradesMemo('stats',closed,[_be,_oneR,_jrev,settings.tz,settings.tzZone,dayKey(Date.now()),a,b].join('|'),()=>computeStats(closed,allv),allv); }
function periodTrades(){ const closed=allTrades.filter(t=>!t.isOpen && tradeRow(t) && !t.movedOut && viewFilter(t)); // a spot position that ended by its balance leaving (movedOut) is listed, not scored
  if(rangeActive())return closed.filter(inRange);
  if(!period)return closed; const cut=Date.now()-period*86400000; return closed.filter(t=>t.closeTime>=cut); }
function periodTradesAll(forTable){ const inv=allTrades.filter(forTable?tableFilter:(t=>moneyRow(t)&&viewFilter(t)));
  if(rangeActive())return inv.filter(inRange);
  if(!period)return inv; const cut=Date.now()-period*86400000; return inv.filter(t=>t.closeTime>=cut); }
// maxDDpct's label: |maxDD| ÷ the all-time high of cumulative PnL, which is not "% off the peak it fell from"
// Past 100% the fall is deeper than the best the curve ever reached: say it as a multiple ("1.5× your
// best cumulative profit"), which reads as what it is, where "154% of best cumulative profit" read as a slip.
function ddPctOfBest(x){ return x>=1?(x).toFixed(1).replace(/\.0$/,'')+'× your best cumulative profit':(x*100).toFixed(x<0.1?1:0)+'% of best cumulative profit'; }
function computeStats(closed, allv){
  allv=allv||closed;
  const wins=closed.filter(t=>isWin(t.net)), losses=closed.filter(t=>isLoss(t.net)), scratches=closed.filter(t=>isBE(t.net));
  const gp=wins.reduce((s,t)=>s+t.net,0), gl=Math.abs(losses.reduce((s,t)=>s+t.net,0));
  // profit factor is gross profit ÷ gross loss over every trade: small losses inside the
  // break-even band are still losses (nine −$40 trades against one +$200 isn't "∞")
  const gpAll=closed.reduce((s,t)=>s+(t.net>0?t.net:0),0), glAll=closed.reduce((s,t)=>s+(t.net<0?-t.net:0),0);
  // PnL totals include realized from open positions (allv)
  const net=allv.reduce((s,t)=>s+t.net,0), fees=allv.reduce((s,t)=>s+t.fees,0);
  const fund=allv.reduce((s,t)=>s+(t.funding||0),0);
  const avgW=wins.length?gp/wins.length:0, avgL=losses.length?gl/losses.length:0;
  const payoff=avgL>0?avgW/avgL:(avgW>0?Infinity:0);
  const breakevenWR=(avgW+avgL)>0?avgL/(avgW+avgL):0;
  const expectancy=closed.length?closed.reduce((s,t)=>s+t.net,0)/closed.length:0;
  // drawdown over all realized, chronological
  const chron=[...allv].sort((a,b)=>a.closeTime-b.closeTime);
  let peak=0,cum=0,maxDD=0; for(const t of chron){ cum+=t.net; if(cum>peak)peak=cum; const dd=cum-peak; if(dd<maxDD)maxDD=dd; }
  // % relative to PEAK CUMULATIVE PROFIT (high-water mark), not the running peak — the running
  // peak is near zero early on, which makes an early drawdown into capital explode to absurd %.
  // This base is deposit/withdrawal independent. Null when never net-positive (no meaningful base).
  const maxDDpct = peak>0 ? Math.abs(maxDD)/peak : null;
  // streaks from completed trades (scratches are neutral — they don't extend or break a streak)
  let cur=0,curSign=0,longW=0,longL=0,run=0,runSign=0;
  for(const t of [...closed].sort((a,b)=>a.closeTime-b.closeTime)){ const sg=isWin(t.net)?1:isLoss(t.net)?-1:0;
    if(sg===0){continue;} // scratch: neutral — does not extend or break the streak
    if(sg===runSign)run++; else {run=1;runSign=sg;}
    if(sg>0)longW=Math.max(longW,run); else longL=Math.max(longL,run);
    cur=run;curSign=sg; }
  const withR=closed.map(rFor).filter(r=>r!==null);
  const avgR=withR.length?withR.reduce((a,b)=>a+b,0)/withR.length:null;
  const totalR=withR.length?withR.reduce((a,b)=>a+b,0):null;
  const holds=closed.map(t=>t.durationMs).filter(x=>x>0);
  const avgHold=holds.length?holds.reduce((a,b)=>a+b,0)/holds.length:0;
  const activeDaily=Object.values(dailyPnl(allv));
  const greenDays=activeDaily.filter(x=>x>0).length, totalDays=activeDaily.length;
  const calSeries=dailySeriesCalendar(allv);
  const sh=sharpeStats(calSeries); const sortino=sortinoAnnual(calSeries);
  const rets=closed.map(retPct).filter(x=>x!==null); const avgRet=rets.length?_avg(rets):null;
  const _sortedNets=[...closed.map(t=>t.net)].sort((a,b)=>a-b);
  const median=_sortedNets.length?(_sortedNets.length%2?_sortedNets[(_sortedNets.length-1)/2]:(_sortedNets[_sortedNets.length/2-1]+_sortedNets[_sortedNets.length/2])/2):null;
  return {n:closed.length,openN:allv.filter(t=>t.isOpen).length,net,fees,fund,volume:allv.reduce((a,t)=>a+((t.makerNotional||0)+(t.takerNotional||0)+(t.unkNotional||0)),0),wins:wins.length,losses:losses.length,breakeven:scratches.length,
    winRate:(wins.length+losses.length)?wins.length/(wins.length+losses.length):0,
    profitFactor:glAll>0?gpAll/glAll:(gpAll>0?Infinity:0),avgWin:avgW,avgLoss:avgL,payoff,breakevenWR,
    expectancy,maxDD,maxDDpct,
    curStreak:cur,curSign,longW,longL,avgR,totalR,rCount:withR.length,avgHold,
    sharpe:sh?sh.sr:null,sharpeLo:sh?sh.lo:null,sharpeHi:sh?sh.hi:null,sharpeN:sh?sh.N:0,sharpeDaily:sh?sh.srDaily:null,
    sortino,greenDays,totalDays,avgRet,calSeries,median,
    largestWin:closed.reduce((m,t)=>Math.max(m,t.net),0)};
}
