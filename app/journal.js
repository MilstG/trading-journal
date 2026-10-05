// Ledger app · part 7 of 15: extra analytics, journal editing, render(), goals, the day journal, the Project tab.
// ledger.html loads the parts in order as classic scripts sharing one global scope. Code that
// runs while a part loads (not inside a function called later) may only use names declared in
// this part or an earlier one; the boot part runs last. See "Development and testing" in README.md.

/* ============================ extra analytics ============================ */
// Maker/taker execution split + honest effective-rate savings estimate.
function makerTakerStats(trades){
  let mk=0,tk=0,mkFee=0,tkFee=0,mkNot=0,tkNot=0;
  for(const t of trades){ mk+=t.makerFills||0; tk+=t.takerFills||0; mkFee+=t.makerFee||0; tkFee+=t.takerFee||0;
    mkNot+=t.makerNotional||0; tkNot+=t.takerNotional||0; }
  const totF=mk+tk; if(!totF)return null;
  const makerRate=mkNot>0?mkFee/mkNot:null, takerRate=tkNot>0?tkFee/tkNot:null;
  // if the taker volume had paid your own maker rate, how much less fee would you have paid?
  const savings=(makerRate!=null&&takerRate!=null&&tkNot>0)?Math.max(0,tkFee-tkNot*makerRate):null;
  return {mk,tk,totF,takerShareFills:tk/totF,mkFee,tkFee,mkNot,tkNot,
    takerShareNot:(mkNot+tkNot)>0?tkNot/(mkNot+tkNot):null,makerRate,takerRate,savings};
}
// Execution quality: median entry drift (slippage vs first fill) + annualized return on notional.
function executionStats(trades){
  const drift=trades.map(t=>t.entryDrift).filter(x=>x!=null&&isFinite(x));
  const med=a=>{ if(!a.length)return null; const s=[...a].sort((x,y)=>x-y); const n=s.length;
    return n%2?s[(n-1)/2]:(s[n/2-1]+s[n/2])/2; };
  // annualized return on notional per trade: retPct scaled by (year / holding period). Winsorized to tame sub-minute holds.
  const ann=[]; for(const t of trades){ const r=retPct(t), d=t.durationMs; if(r==null||!d||d<=0)continue;
    let a=r*(31536000000/d); a=Math.max(-100000,Math.min(100000,a)); ann.push(a); }
  return {n:drift.length, medDrift:med(drift), adverseShare:drift.length?drift.filter(x=>x>0).length/drift.length:null,
    medAnnRet:med(ann), annN:ann.length};
}
// Liquidation summary.
function liqStats(trades){ const liq=trades.filter(t=>t.liquidated); return {n:liq.length, net:liq.reduce((s,t)=>s+t.net,0)}; }
// Drawdown episodes on the chronological equity curve: recovery times + current underwater length.
function drawdownEpisodes(closed){
  const chron=[...closed].sort((a,b)=>a.closeTime-b.closeTime); if(chron.length<2)return null;
  let cum=0,peak=0,peakIdx=-1,inDD=false,ddStartIdx=-1,trough=0; const recov=[];
  for(let i=0;i<chron.length;i++){ cum+=chron[i].net;
    if(cum>=peak){ if(inDD){ recov.push({len:i-ddStartIdx, depth:trough-peak}); inDD=false; } peak=cum; peakIdx=i; }
    else { if(!inDD){ inDD=true; ddStartIdx=peakIdx; trough=cum; } if(cum<trough)trough=cum; } }
  const underwaterTrades=inDD?(chron.length-1-peakIdx):0;
  const recTimes=recov.map(r=>r.len);
  const med=a=>{ if(!a.length)return null; const s=[...a].sort((x,y)=>x-y); const n=s.length; return n%2?s[(n-1)/2]:(s[n/2-1]+s[n/2])/2; };
  return {episodes:recov.length, medRecover:med(recTimes), maxRecover:recTimes.length?Math.max(...recTimes):null,
    underwaterTrades, deepest:recov.length?Math.min(...recov.map(r=>r.depth)):0};
}
// Worst losing streak by cumulative dollars (depth), alongside the count-based longest streak.
function worstLossStreakDepth(closed){
  const chron=[...closed].sort((a,b)=>a.closeTime-b.closeTime);
  let run=0,worst=0,cnt=0,worstCnt=0;
  for(const t of chron){ if(isLoss(t.net)){ run+=t.net; cnt++; if(run<worst){worst=run;worstCnt=cnt;} }
    else if(isWin(t.net)){ run=0; cnt=0; } }
  return {depth:worst, count:worstCnt};
}
// Cost drag (fees net of funding as % of gross realized profit) by calendar month.
function feeDragByMonth(closed){
  const m={}; for(const t of closed){ const p=tzParts(t.closeTime); const k=p.y+'-'+String(p.mo+1).padStart(2,'0'); // tz-aware — matches the monthly decomposition chart
    const b=m[k]||(m[k]={fees:0,fund:0,gross:0}); b.fees+=t.fees; b.fund+=(t.funding||0); b.gross+=(t.pnl>0?t.pnl:0); }
  return Object.keys(m).sort().slice(-12).map(k=>{ const b=m[k]; const cost=b.fees-b.fund;
    return {k, cost, gross:b.gross, drag:b.gross>0?cost/b.gross:null}; });
}
// Net directional exposure by coin across all open perps (nets long vs short across wallets).
function netExposureByCoin(){
  const g={}; for(const p of dexPositions()){ const notional=(p.value||0)*(p.szi<0?-1:1);
    (g[p.coin]=g[p.coin]||{coin:p.coin,net:0,gross:0,wallets:new Set()}); g[p.coin].net+=notional; g[p.coin].gross+=Math.abs(p.value||0);
    if(p.wallet)g[p.coin].wallets.add(p.wallet.address); }
  return Object.values(g).map(x=>({coin:x.coin,net:x.net,gross:x.gross,wallets:x.wallets.size}))
    .filter(x=>x.gross>0).sort((a,b)=>Math.abs(b.net)-Math.abs(a.net));
}
// Guardrail signals computed from the most recently loaded trades (advisory, snapshot-based).
function guardrailSignals(){
  const out=[];
  // trading with no plan filed — fires regardless of history depth (it's a habit nudge)
  const up=unplannedToday(allTrades.filter(t=>tradeRow(t)&&!t.movedOut),journal);
  if(up.unplanned)
    out.push({type:'unplanned',txt:`<b>${up.n}</b> trades today with no plan filed. The end-of-day review will ask why — write the bias, plan, and max loss in <b>Review → Day journal</b> before the next entry.`});
  // open positions breaking one of your rules-from-findings (entry-knowable conditions only)
  const open=coachOn()?allTrades.filter(t=>t.isOpen):[];
  if(open.length&&customRules().length){
    try{ const hits=liveRuleHits(open,liveRulePreds());
      for(const h of hits.slice(0,3))
        out.push({type:'cooldown',txt:`Open <b>${esc(dispMarket(dcoin(h.t)))} ${h.t.dir}</b> breaks your rule <b>${esc(h.rule.name)}</b> (made ${fmtDate(h.rule.createdAt)}). Diagnostic \u2192 Discipline &amp; rules shows what these trades have cost you.`});
    }catch(e){}
  }
  // open positions with no written stop — the plan only counts as a commitment while it's live
  // (perps opened in the last 7 days: long-held spot bags and ancient positions would make it wallpaper)
  { const unplanned=open.filter(t=>t.market!=='spot'&&t.openTime>=Date.now()-7*86400000&&!nfPlan(journal[t.id]));
    if(unplanned.length)
      out.push({type:'unplanned',txt:`<b>${unplanned.length}</b> open position${unplanned.length===1?' has':'s have'} no written stop (${unplanned.slice(0,3).map(t=>esc(dispMarket(dcoin(t))))
        .join(', ')}${unplanned.length>3?', \u2026':''}). Open the trade row and fill <b>entry / stop / target</b> now \u2014 a plan written while the trade is live counts; one written after the close is hindsight.`}); }
  const closed=closedTrades().sort((a,b)=>b.closeTime-a.closeTime); // completed trades only: a result the fills can't give, a spot day row or a balance that left is no evidence
  if(closed.length<20)return out;
  const now=Date.now();
  // sizing creep vs capital
  const rc=riskCreepModel(closed,((accountValue||0)+(spotAccountValue||0))||null);
  if(rc&&rc.creep)
    out.push({type:'overtrading',txt:`Sizing is creeping: median entry notional <b>${fmtUsd(rc.m2).replace('.00','')}</b> over your last 20 trades vs ${fmtUsd(rc.m1).replace('.00','')} the 20 before (+${Math.round(rc.sizeGrowth*100)}%)${rc.eqGrowth!=null?`, while capital moved ${(rc.eqGrowth>=0?'+':'')+Math.round(rc.eqGrowth*100)}%`:''}. Size that outruns equity is the classic post-win-streak failure — re-derive size from the sizer, not from momentum.`});
  // after-loss expectancy — the nearest CLOSE before each open (binary search, skip self),
  // matching the Diagnostic's priorClose. Adjacent close-ordered pairs also matched
  // concurrent positions opened hours BEFORE the loss closed (negative gaps).
  const byClose=[...closed].sort((a,b)=>a.closeTime-b.closeTime);
  const ct=byClose.map(t=>t.closeTime);
  const afterLoss=[]; for(const t of closed){
    let lo=0,hi=ct.length-1,idx=-1;
    while(lo<=hi){ const m=(lo+hi)>>1; if(ct[m]<=t.openTime){idx=m;lo=m+1;} else hi=m-1; }
    while(idx>=0&&byClose[idx].id===t.id)idx--;
    if(idx>=0&&isLoss(byClose[idx].net)&&(t.openTime-byClose[idx].closeTime)<=3600000)afterLoss.push(t.net);
  }
  const overallExp=_avg(closed.map(t=>t.net));
  const alExp=afterLoss.length?_avg(afterLoss):null;
  const last=closed[0];
  if(last&&isLoss(last.net)&&(now-last.closeTime)<=90*60000&&alExp!=null&&afterLoss.length>=5&&alExp<Math.min(0,overallExp))
    out.push({type:'cooldown',txt:`Your last trade was a loss ${fmtDur(now-last.closeTime)} ago. Historically your trades within an hour of a loss average <b>${fmtUsd(alExp)}</b> vs ${fmtUsd(overallExp)} overall — a documented tilt leak. Consider stepping away before re-entering.`});
  // overtrading today
  const d0=tzMidnight(Date.now());
  const todayN=closed.filter(t=>t.closeTime>=d0).length;
  const byDay={}; closed.forEach(t=>{const k=tzMidnight(t.closeTime);byDay[k]=(byDay[k]||0)+1;});
  const counts=Object.values(byDay); const thr=Math.max(_avg(counts)+_std(counts), _avg(counts)+1);
  if(todayN>=thr&&todayN>=4)
    out.push({type:'overtrading',txt:`You've closed <b>${todayN}</b> trades today — above your typical ceiling (~${thr.toFixed(0)}). On your busiest days your per-trade expectancy usually falls. A trades-per-day cap protects you here.`});
  return out;
}
// Kelly-based position sizing suggestion from the current view's stats.
// One Kelly, one source: derive the Diagnostic sizing card from the same kellyFromTrades
// the Projection tab uses. Two parallel implementations (this one used view-stats
// payoff/winRate) could show a trader two different "suggested" risk numbers.
function sizingFromStats(s,closed){
  const kt=closed?kellyFromTrades(closed):null;
  if(kt&&kt.kelly!=null) return {kelly:kt.kelly, half:kt.kelly/2, payoff:kt.b, winRate:kt.p};
  const kelly=(s.payoff>0&&s.payoff!==Infinity&&s.winRate>0)?(s.winRate-(1-s.winRate)/s.payoff):null;
  return {kelly:kelly!=null?Math.max(0,kelly):null, half:kelly!=null?Math.max(0,kelly)/2:null,
    payoff:s.payoff, winRate:s.winRate};
}
// HTML for the execution / costs / structure / sizing diagnostic sections.
function extraDiagHtml(closed,allv,s){
  const mt=makerTakerStats(closed), ex=executionStats(closed), liq=liqStats(closed);
  const dd=drawdownEpisodes(closed), wls=worstLossStreakDepth(closed);
  const sizing=sizingFromStats(s,closed); const acct=(accountValue||0)+(spotAccountValue||0);
  const mrow=(l,v,tip)=>`<div class="metric-row"${tip?` data-tip="${esc(tip)}"`:''}><span class="ml">${l}</span><span class="mv">${v}</span></div>`;
  const bps=x=>x==null?'—':(x*10000).toFixed(1)+' bps';
  const signPct=x=>x==null?'—':((x>=0?'+':'')+(x*100).toFixed(2)+'%');

  let mtHtml='<p class="lead">No fill-level maker/taker data in this view (older pasted imports may omit it).</p>';
  if(mt){ mtHtml=
    mrow('Taker share (fills)',(mt.takerShareFills*100).toFixed(0)+'%','Share of your fills that crossed the spread (taker). Taker fills pay the higher fee tier.')+
    mrow('Taker share (notional)',mt.takerShareNot!=null?(mt.takerShareNot*100).toFixed(0)+'%':'—','Share of your traded $ volume executed as taker.')+
    mrow('Effective taker rate',bps(mt.takerRate),'Taker fees ÷ taker notional.')+
    mrow('Effective maker rate',bps(mt.makerRate),'Maker fees ÷ maker notional (negative if you net rebates).')+
    mrow('Fees taker / maker',fmtUsd(mt.tkFee)+' / '+fmtUsd(mt.mkFee),'Total fees paid at each tier over this view.')+
    (mt.savings!=null?mrow('Est. savings if maker','<span class="pos-t">'+fmtUsd(mt.savings)+'</span>','If your taker volume had paid your own maker rate, this is the fee you would have saved — a concrete ceiling on the payoff from going maker-first.'):''); }

  let exHtml=
    mrow('Median entry drift',signPct(ex.medDrift),'How far your size-weighted entry typically lands from your first fill, in the adverse direction. Positive = you scale in at worse prices (chasing); negative = you average in better.')+
    mrow('Trades with adverse drift',ex.adverseShare!=null?(ex.adverseShare*100).toFixed(0)+'%':'—','Share of trades where your average entry was worse than your first fill.')+
    mrow('Median ann. return / trade',ex.medAnnRet!=null?signPct(ex.medAnnRet/100):'—','Per-trade return on notional, annualized by holding period (median). A capital-velocity read: a small win held 2 minutes is a very different edge than the same win held 3 days.')+
    mrow('Liquidations',liq.n?('<span class="loss">'+liq.n+' · '+fmtUsd(liq.net)+'</span>'):'0','Trades containing a forced-liquidation fill, and their net PnL. Any number here is worth a hard look at sizing and stops.');

  let ddHtml = dd
    ? mrow('Drawdown episodes',String(dd.episodes),'Distinct peak-to-trough-to-recovery cycles in your cumulative-PnL curve.')+
      mrow('Median trades to recover',dd.medRecover!=null?String(dd.medRecover):'—','Typical number of trades to climb back to a prior high-water mark after a drawdown began.')+
      mrow('Longest recovery',dd.maxRecover!=null?dd.maxRecover+' trades':'—','Most trades it ever took to make a new high-water mark.')+
      mrow('Currently underwater',dd.underwaterTrades?('<span class="loss">'+dd.underwaterTrades+' trades</span>'):'at/near highs','Trades since your last high-water mark. Long underwater stretches are where discipline slips.')+
      mrow('Deepest episode',dd.deepest<0?('<span class="loss">'+fmtUsd(dd.deepest)+'</span>'):'—','Worst peak-to-trough dollar depth across completed drawdown episodes. Pair it with the recovery counts: depth is what tests sizing, length is what tests patience.')
    : '<p class="lead">Needs ≥2 completed trades.</p>';
  ddHtml += mrow('Worst losing streak',wls.count?('<span class="loss">'+fmtUsd(wls.depth)+' · '+wls.count+' trades</span>'):'—','Deepest cumulative dollar loss across an unbroken run of losing trades — the depth behind the count-based streak. Size so you can sit through this without breaking rules.');

  const feeRows=feeDragByMonth(allv); // money rows: spot fees and funding by the day they were paid
  const feeHtml=feeRows.length?`<div class="diag-section"><h2>Cost drag over time <span style="font-size:11px;color:var(--faint);font-weight:400">fees net of funding, as % of gross profit</span></h2>
     <div class="diag-card"><div style="height:210px"><canvas id="diagFeeMonth"></canvas></div>
       <p class="mini-note">Bars show monthly friction (fees − funding) as a share of that month's gross profit. Rising drag as size grows is a signal to favor maker fills or trade less often.</p></div></div>`:'';

  const sizingHtml=`<div class="diag-section"><h2>Position sizing <span style="font-size:11px;color:var(--faint);font-weight:400">Kelly-derived · in-sample</span></h2>
    <div class="diag-card"><h3 data-tip="A sizing sandbox built from this view's edge. Full-Kelly maximizes long-run growth but is famously volatile; most traders use a fraction of it. This is in-sample guidance, not a guarantee.">Sizing calculator</h3>
      ${mrow('Win rate · payoff',(sizing.winRate*100).toFixed(0)+'% · '+(sizing.payoff===Infinity?'∞':(sizing.payoff||0).toFixed(2)),'From the current view.')}
      ${mrow('Full-Kelly fraction',sizing.kelly!=null?(sizing.kelly*100).toFixed(1)+'%':'—','Fraction of capital Kelly says to risk per trade at this edge. Aggressive.')}
      ${mrow('Half-Kelly (suggested)',sizing.half!=null?(sizing.half*100).toFixed(1)+'%':'—','A common, calmer default: half the Kelly fraction.')}
      <div class="calc-row" style="margin-top:12px">Account <input type="number" id="szAcct" value="${acct>0?Math.round(acct):''}" placeholder="$" min="0" step="any">
        · risk <input type="number" id="szRisk" value="${sizing.half!=null?(sizing.half*100).toFixed(1):'1'}" min="0" step="any">% per trade
        · stop <input type="number" id="szStop" value="1" min="0" step="any">% away</div>
      <div class="calc-row">→ risk <span class="calc-out" id="szRiskOut">—</span> · position notional <span class="calc-out" id="szNotOut">—</span> <span style="color:var(--faint)">(size = risk ÷ stop distance)</span></div>
    </div></div>`;

  return `<div class="diag-section"><h2>Execution &amp; costs</h2>
     <div class="diag-grid">
       <div class="diag-card"><h3 data-tip="Maker vs taker breakdown from fill-level data, with an honest savings estimate based on your own realized fee rates.">Maker / taker</h3>${mtHtml}</div>
       <div class="diag-card"><h3 data-tip="Entry execution and capital velocity, plus any forced liquidations.">Execution quality</h3>${exHtml}</div>
     </div></div>
   <div class="diag-section"><h2>Structure &amp; risk</h2>
     <div class="diag-grid">
       <div class="diag-card"><h3 data-tip="How your equity curve recovers from drawdowns, and the depth of your worst losing run.">Drawdown recovery &amp; streak depth</h3>${ddHtml}</div>
       <div class="diag-card"><h3 data-tip="Net directional exposure right now, netting offsetting longs/shorts by coin across wallets.">Open-book net exposure</h3>${(function(){const ne=netExposureByCoin();return ne.length?ne.slice(0,6).map(x=>mrow(esc(x.coin)+(x.wallets>1?' · '+x.wallets+' wallets':''),(x.net>=0?'<span class="pos-t">net long ':'<span class="neg-t">net short ')+fmtUsd(Math.abs(x.net))+'</span>','Signed sum of position notional for this coin across all wallets.')).join(''):'<p class="lead">No open perp positions.</p>';})()}</div>
     </div></div>
   ${feeHtml}${sizingHtml}${nfDiagExtra(closed)}${planDiagHtml(closed)}`;
}
function wireExtraDiag(closed,allv,s){
  // cost drag by month
  const fee=feeDragByMonth(allv);
  if(fee.length&&$('diagFeeMonth')){ const lab=fee.map(r=>r.k.slice(2)), d=fee.map(r=>r.drag!=null?r.drag*100:0);
    _diagCharts.feeMonth=new Chart($('diagFeeMonth'),{type:'bar',data:{labels:lab,datasets:[{data:d,backgroundColor:d.map(v=>v>25?tint(themeRed(),.8):tint(themeGold(),.75)),borderRadius:4}]},
      options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{label:c=>' Costs: '+c.parsed.y.toFixed(0)+'% of gross profit',
        afterLabel:c=>{ const r=fee[c.dataIndex]; return [' Fees and funding '+fmtUsd(-r.cost),' Gross profit '+fmtUsd(r.gross)]; }}}},
        scales:{x:{grid:{display:false},border:{display:false},ticks:{maxRotation:45,minRotation:45,font:{size:9}}},y:{grid:{color:GRID,drawTicks:false},border:{display:false},ticks:{callback:v=>v+'%'}}}}});
    explain(_diagCharts.feeMonth,'How much of each month’s gross profit went to fees and funding. Red bars: over a quarter of it.'); }
  // sizing calculator
  const calc=()=>{ const acct=parseFloat($('szAcct')&&$('szAcct').value), risk=parseFloat($('szRisk')&&$('szRisk').value), stop=parseFloat($('szStop')&&$('szStop').value);
    if(!$('szRiskOut'))return; const rDollar=(acct>0&&risk>0)?acct*risk/100:null;
    $('szRiskOut').textContent=rDollar!=null?fmtUsd(rDollar):'—';
    const notl=(rDollar!=null&&stop>0)?rDollar/(stop/100):null;
    $('szNotOut').textContent=notl!=null?fmtUsd(notl):'—'; };
  ['szAcct','szRisk','szStop'].forEach(id=>{ const e=$(id); if(e)e.oninput=calc; }); calc();
  nfWireDiag(closed);
}
const MISTAKES=['FOMO entry','No stop','Oversized','Revenge trade','Moved stop','Early exit','Chased','Broke plan'];
function filteredTrades(){
  const closed=periodTradesAll(true); // off-record trades stay listed here (badged), out of every statistic
  const fc=$('fCoin').value,fs=$('fSide').value,fo=$('fOut').value,ft=$('fTag').value,fw=$('fWallet').value,q=$('fSearch').value.toLowerCase().trim();
  const fRating=+$('fRating').value, fFlag=$('fFlag').value;
  const fromMs=dateBound($('fFrom').value,false);
  const toMs=dateBound($('fTo').value,true);
  let r=closed.filter(t=>{
    if(fromMs&&t.closeTime<fromMs)return false;
    if(toMs&&t.closeTime>toMs)return false;
    if(fw&&(!t.wallet||t.wallet.address!==fw))return false;
    if(fc&&dcoin(t)!==fc)return false; if(fs&&t.dir!==fs)return false;
    if(fo==='win'&&!isWin(t.net))return false; if(fo==='loss'&&!isLoss(t.net))return false;
    const j=journal[t.id]||{}; if(ft&&!(j.tags||[]).some(x=>String(x).toLowerCase()===ft))return false;
    if(fRating&&!((j.rating||0)>=fRating))return false;
    if(fFlag==='flagged'&&!(j.mistakes&&j.mistakes.length))return false;
    if(fFlag==='clean'&&(j.mistakes&&j.mistakes.length))return false;
    if(fFlag==='noted'&&!(j.notes&&j.notes.trim()))return false;
    if(q){ const hay=(dcoin(t)+' '+(j.notes||'')+' '+(j.setup||'')+' '+(j.tags||[]).join(' ')).toLowerCase(); if(!hay.includes(q))return false; }
    return true;
  });
  r.sort((a,b)=>{ let av,bv;
    if(sortKey==='R'){av=rFor(a)??-1e12;bv=rFor(b)??-1e12;}
    else if(sortKey==='ret'){av=retPct(a)??-1e12;bv=retPct(b)??-1e12;}
    else {av=a[sortKey];bv=b[sortKey];}
    return (av<bv?-1:av>bv?1:0)*sortDir; });
  return r;
}
function renderTable(){
  jFlush(); // typing still waiting for its autosave is saved before the form is rebuilt
  const rows=filteredTrades(); const multi=settings.wallets.length>1;
  // reset to page 1 whenever the filtered/sorted set changes (but not on row-expand)
  const sig=[sortKey,sortDir,view,period,customRange.from,customRange.to,pageSize,
    $('fSearch').value,$('fTag').value,$('fCoin').value,$('fWallet').value,$('fSide').value,$('fOut').value,
    ($('fFrom')&&$('fFrom').value),($('fTo')&&$('fTo').value),($('fRating')&&$('fRating').value),
    ($('fFlag')&&$('fFlag').value),rows.length].join('|');
  if(sig!==_tblSig){ page=1; _tblSig=sig; }
  const total=rows.length; const pages=Math.max(1,Math.ceil(total/pageSize));
  if(page>pages)page=pages; if(page<1)page=1;
  const startIdx=(page-1)*pageSize; const pageRows=rows.slice(startIdx,startIdx+pageSize);
  $('tcount').textContent = total? `${startIdx+1}–${Math.min(startIdx+pageSize,total)} of ${total} trade${total===1?'':'s'}` : '0 trades';
  document.querySelectorAll('.arw').forEach(a=>a.textContent=a.dataset.for===sortKey?(sortDir===1?'▲':'▼'):'');
  document.querySelectorAll('.trades th.sortable').forEach(th=>th.setAttribute('aria-sort', th.dataset.s===sortKey?(sortDir===1?'ascending':'descending'):'none'));
  $('tbody').innerHTML=pageRows.map(t=>{
    const j=journal[t.id]||{}; const tags=(j.tags||[]); const R=rFor(t); const ret=retPct(t);
    const jsummary=[j.setup?`<span class="tagchip">${esc(j.setup)}</span>`:'',
      ...tags.slice(0,3).map(x=>`<span class="tagchip">${esc(x)}</span>`),
      j.rating?`<span class="tagchip" style="color:var(--gold)">${'★'.repeat(Math.max(0,Math.min(5,Math.round(+j.rating)||0)))}</span>`:'',
      (j.mistakes&&j.mistakes.length)?`<span class="tagchip" style="color:var(--loss)">⚑${j.mistakes.length}</span>`:'',
      j.notes?`<span class="tagchip">📝</span>`:''].join('');
    const liqBadge=t.liquidated?` <span class="pill short" data-tip="This trade contains at least one liquidation fill — the position was force-closed by the exchange.">⚠ LIQ</span>`:'';
    // a seam in the fills: the result shown is what the served fills give, not the whole trade
    const gapBadge=t.offRecord?` <span class="pill be" data-tip="Incomplete: ${esc(fmtNum(t.gapSz||0))} of this position was ${t.isOpen?'moved':'closed'} in fills Hyperliquid no longer serves (TWAP slices older than ~3 months, or history past its retention). The net shown is only what the served fills realized, so this trade is left out of every statistic. See Data health.">INCOMPLETE</span>`
      :t.gaps?` <span class="pill be" data-tip="${esc(fmtNum(t.gapSz||0))} of this position was ${t.openSz>0?'added':'opened'} in fills Hyperliquid no longer serves, so the entry price and size are partial; the result is the exchange’s own and counts.">PARTIAL</span>`
      :t.partialHistory?` <span class="pill be" data-tip="This position was ${t.openSz>0?'partly ':''}opened before the fill history begins, so the entry is ${t.openSz>0?'only the part that was served':'unknown'} and no return % is shown; the result is the exchange’s own and counts.">PARTIAL</span>`:'';
    const side=(t.isOpen?`<span class="pill open" data-tip="Position still open in this reconstruction. Net shown is realized so far.">OPEN</span>`:t.movedOut?`<span class="pill be" data-tip="This spot balance left without a sell (a transfer, staking, a send), so the position ended there. Listed for the record; not a completed trade, so it is kept out of the statistics.">MOVED</span>`:(isBE(t.net)?`<span class="pill be" data-tip="Break-even scratch: net PnL inside ±${esc(fmtUsd(_be))} of zero. Not counted as a win or a loss.">B/E</span> <span class="pill ${t.dir.toLowerCase()}" style="opacity:.7">${t.dir}</span>`:`<span class="pill ${t.dir.toLowerCase()}">${t.dir}</span>`))+liqBadge+gapBadge;
    return `<tr class="trow ${expandedId===t.id?'expanded':''}" data-id="${esc(t.id)}" tabindex="0" role="button" aria-expanded="${expandedId===t.id?'true':'false'}" aria-label="${esc(dispMarket(dcoin(t)))} ${t.dir}${t.isOpen?' open':''}, net ${fmtUsd(t.net)}. Activate to ${expandedId===t.id?'collapse':'expand'} journal.">
      <td class="l num">${fmtDate(t.openTime)}</td>
      <td class="l" style="font-weight:600">${esc(dispMarket(dcoin(t)))}${(multi&&t.wallet)||candleVenue(t)?`<div style="margin-top:3px">${candleVenue(t)&&!(t.wallet&&!t.wallet.label&&multi)?`<span class="tagchip">${esc(VENUE_NAMES[t.venue])}</span>`:''}${multi&&t.wallet?`<span class="tagchip">${esc(labelFor(t.wallet))}</span>`:''}</div>`:''}</td><td class="l">${side}</td>
      <td class="num">${t.partialHistory&&!(t.openSz>0)?'<span style="color:var(--faint)" data-tip="Entry unknown: every opening fill predates the history (the exit price stood in for it in older versions).">—</span>':fmtNum(t.avgEntry)}</td><td class="num">${fmtNum(t.avgExit)}</td>
      <td class="num">${fmtNum(t.maxSize)}</td>
      <td class="num ${outClass(t.net)}" style="font-weight:600">${fmtUsd(t.net)}</td>
      <td class="num ${ret!=null?cls(ret):''}">${ret!=null?(ret>=0?'+':'')+ret.toFixed(2)+'%':'—'}</td>
      <td class="num ${R!=null?cls(R):''}">${R!=null?(R>=0?'+':'')+R.toFixed(2)+'R':'—'}</td>
      <td class="num">${fmtDur(t.durationMs)}</td>
      <td class="l">${jsummary||'<span style="color:var(--faint)">—</span>'}</td>
      <td class="num"><span class="caret" aria-hidden="true">›</span></td>
    </tr>${expandedId===t.id?journalRow(t,j,R):''}`;
  }).join('')||`<tr><td colspan="12" style="text-align:center;color:var(--faint);padding:34px">No trades match these filters.</td></tr>`;
  renderPager(total,pages);
  if(expandedId&&document.getElementById('att-'+expandedId))loadAttachments(expandedId);
  if(expandedId&&typeof mrJournalLoad==='function')mrJournalLoad(expandedId); // a mentor review of this trade (social server only)
}
function renderPager(total,pages){
  const el=$('pager'); if(!el)return;
  const sizeSel=`<div class="pgsize">Rows <select id="pgSel">${[10,20,50].map(n=>`<option value="${n}"${n===pageSize?' selected':''}>${n}</option>`).join('')}</select></div>`;
  if(total<=pageSize && pages<=1){ el.innerHTML=sizeSel; wirePager(pages); return; }
  let nums=[]; const win=2;
  for(let p=1;p<=pages;p++){ if(p===1||p===pages||(p>=page-win&&p<=page+win))nums.push(p); else if(nums[nums.length-1]!=='…')nums.push('…'); }
  const numBtns=nums.map(p=>p==='…'?`<span style="padding:0 4px;color:var(--faint)">…</span>`:`<button data-pg="${p}" class="${p===page?'on':''}">${p}</button>`).join('');
  el.innerHTML=`${sizeSel}
    <div class="pgnav">
      <button id="pgPrev" ${page<=1?'disabled':''}>‹ Prev</button>
      <div class="pgpages">${numBtns}</div>
      <button id="pgNext" ${page>=pages?'disabled':''}>Next ›</button>
    </div>`;
  wirePager(pages);
}
function wirePager(pages){
  const sel=$('pgSel'); if(sel)sel.onchange=e=>{ pageSize=+e.target.value; page=1; settings.pageSize=pageSize; Store.set(S_KEY,settings); renderTable(); };
  const prev=$('pgPrev'); if(prev)prev.onclick=()=>{ if(page>1){page--; renderTable(); scrollTable();} };
  const next=$('pgNext'); if(next)next.onclick=()=>{ if(page<pages){page++; renderTable(); scrollTable();} };
  document.querySelectorAll('#pager .pgpages button').forEach(b=>b.onclick=()=>{ page=+b.dataset.pg; renderTable(); scrollTable(); });
}
function scrollTable(){ try{ const w=document.querySelector('.tbl-wrap'); if(w&&w.scrollIntoView)w.scrollIntoView({behavior:'smooth',block:'nearest'}); }catch(e){} }
// per-trade MAE/MFE line for the journal row, once excursions have been computed
function excLine(t){
  const e=_excM[t.id]; if(!e||e.maePct==null)return '';
  const r=x=>x!=null?' ('+x.toFixed(2)+'R)':'';
  const ap=e.coarse?'≈':'';
  return `<br><span data-tip="Max adverse / favorable excursion from exchange candles — how far this trade ran against you and in your favor between entry and exit.${e.coarse?' ≈ = approximate: exchange candle retention forced coarse candles for this older trade, so these are upper bounds from candle extremes.':''} Computed in Diagnostic → Price excursions.">MAE <span class="neg-t">${ap}${e.maePct.toFixed(2)}%</span>${r(e.maeR)} · MFE <span class="pos-t">${ap}${e.mfePct.toFixed(2)}%</span>${r(e.mfeR)}</span>`;
}
// "written live" vs "written after close" — the difference between a plan and a story.
function planTimingBadge(t,j){
  if(!coachOn())return '';
  const at=j&&j.plan&&+j.plan.at; if(!(at>0))return t.isOpen?' <span class="sr-note" style="margin-left:6px">write it now, while it’s live</span>':'';
  if(t.isOpen||!(t.closeTime>0)||at<t.closeTime)return ' <span class="badge ok" style="margin-left:6px" data-tip="Saved while the position was open — a real commitment, scored in the live bucket.">written live</span>';
  return ' <span class="badge mid" style="margin-left:6px" data-tip="Last changed after the trade closed — hindsight. Scored separately from live plans so it can’t flatter your stop discipline.">written after close</span>';
}
function journalRow(t,j,R){
  return `<tr class="jrow"><td colspan="12"><div class="journal">
    <div>
      <div class="field"><label>Notes — thesis, what happened, lesson</label>
        ${t.isOpen||!coachOn()?'':`<div class="coach-q" data-tip="Chosen for what actually happened in this trade (stop, excursion, adds, outcome). Answer it in the notes.">${esc(tradeQuestion(t,j,_excM[t.id]).q)}</div>`}
        <textarea data-j="notes" data-id="${esc(t.id)}" placeholder="${t.isOpen?'Why did you take it? Where are you wrong?':coachOn()?'Answer the question above \u2014 one honest line is enough.':'Why did you take it? How did it play out? What would you repeat or change?'}">${esc(j.notes||'')}</textarea></div>
      <div class="field"><label>Setup / strategy</label>
        <input type="text" data-j="setup" data-id="${esc(t.id)}" value="${esc(j.setup||'')}" placeholder="${pbList().length?'pick a playbook or type a setup':'e.g. breakout retest, funding fade'}" list="pbNames-${esc(t.id)}">
        <datalist id="pbNames-${esc(t.id)}">${pbList().map(p=>`<option value="${esc(p.name)}">`).join('')}</datalist></div>
      ${pbChecklistHtml(t,j)}
      <div class="field"><label>Tags — comma separated</label>
        <input type="text" data-j="tags" data-id="${esc(t.id)}" value="${esc((j.tags||[]).join(', '))}" placeholder="a-setup, trend, scalp"></div>
      <div class="field"><label>Planned risk ($) — for this trade's R-multiple</label>
        <input type="number" data-j="risk" data-id="${esc(t.id)}" value="${j.risk!=null?esc(j.risk):''}" placeholder="${settings.riskDefault?esc('default '+settings.riskDefault):'e.g. 100'}" min="0" step="any"></div>
      <div class="field"><label>Trade plan — entry / stop / target <span style="color:var(--faint);font-weight:400;text-transform:none;letter-spacing:0">— scored under Diagnostic → Plan adherence</span>${planTimingBadge(t,j)}</label>
        <div style="display:flex;gap:6px">
          <input type="number" data-j="plan_entry" data-id="${esc(t.id)}" value="${(j.plan&&j.plan.entry)?esc(j.plan.entry):''}" placeholder="entry px" step="any" style="flex:1">
          <input type="number" data-j="plan_stop" data-id="${esc(t.id)}" value="${(j.plan&&j.plan.stop)?esc(j.plan.stop):''}" placeholder="stop px" step="any" style="flex:1">
          <input type="number" data-j="plan_target" data-id="${esc(t.id)}" value="${(j.plan&&j.plan.target)?esc(j.plan.target):''}" placeholder="target px" step="any" style="flex:1"></div>
        <div class="plan-err neg-t" id="planErr-${esc(t.id)}" role="alert">${j.plan?esc(tradePlanCheck(t,+j.plan.entry,+j.plan.stop,+j.plan.target)):''}</div>${planOutcomeLine(t,j)}</div>
    </div>
    <div>
      <div class="field"><label>Execution rating</label>
        <div class="rating" data-id="${esc(t.id)}" role="radiogroup" aria-label="Trade rating">${[1,2,3,4,5].map(n=>`<span class="star ${(j.rating||0)>=n?'on':''}" data-r="${n}" role="radio" tabindex="${n===((j.rating||0)||1)?0:-1}" aria-label="${n} star${n>1?'s':''}" aria-checked="${(j.rating||0)===n?'true':'false'}">★</span>`).join('')}</div></div>
      <div class="field"><label>Mistakes / flags</label>
        <div class="mistakes" data-id="${esc(t.id)}">${MISTAKES.map(m=>`<label class="chk ${(j.mistakes||[]).includes(m)?'on':''}"><input type="checkbox" data-m="${esc(m)}" ${(j.mistakes||[]).includes(m)?'checked':''}>${m}</label>`).join('')}</div></div>
      <div class="field"><label>Trade metrics</label>
        <div class="num" style="color:var(--muted);font-size:12.5px;line-height:1.9">
          Realized ${fmtUsd(t.pnl)} · fees ${fmtUsd(-t.fees)} · funding <span class="${cls(t.funding||0)}">${fmtUsd(t.funding||0)}</span><br>
          <strong style="color:var(--text)">Net ${fmtUsd(t.net)}</strong>${retPct(t)!=null?' · <span class="'+cls(retPct(t))+'">'+(retPct(t)>=0?'+':'')+retPct(t).toFixed(2)+'%</span>':''}${R!=null?' · <span class="'+cls(R)+'">'+(R>=0?'+':'')+R.toFixed(2)+'R</span>':''} · ${t.fills} fills · held ${fmtDur(t.durationMs)}<br>
          <span data-tip="Share of this trade's fills that were taker (crossed the spread) vs maker (resting). Taker fills pay the higher fee tier. Imported fills carry no execution style and are counted in neither.">${((t.makerFills||0)+(t.takerFills||0))?`maker ${(t.makerFills||0)} · taker ${(t.takerFills||0)}${(t.takerFills+t.makerFills)?' ('+Math.round((t.takerFills/(t.takerFills+t.makerFills))*100)+'% taker)':''}`:(t.unkFills?'execution style unknown (imported)':'maker 0 · taker 0')}</span>${t.entryDrift!=null?` · <span data-tip="How far your size-weighted entry drifted from your first fill, in the adverse direction. Positive = you scaled in at worse prices (chasing).">entry drift <span class="${t.entryDrift>0?'neg-t':t.entryDrift<0?'pos-t':''}">${(t.entryDrift>=0?'+':'')+(t.entryDrift*100).toFixed(2)}%</span></span>`:''}${addedToLoser(t)?' · <span class="neg-t" data-tip="At least one add was executed while the position was underwater vs your running average entry (detected from the fill stream, not a proxy).">avg’d down</span>':''}${t.liquidated?' · <span class="loss" data-tip="Contains a liquidation fill.">⚠ liquidated</span>':''}${excLine(t)}
        </div></div>
    </div>
    <div class="field"><label>Screenshots / attachments <span style="color:var(--faint);font-weight:400;text-transform:none;letter-spacing:0">— stored in this browser (IndexedDB), not in the JSON backup</span></label>
      <div class="attgrid" id="att-${esc(t.id)}"><span style="color:var(--faint);font-size:11.5px">Loading…</span></div>
      <label class="btn ghost attbtn">+ Add image<input type="file" data-att="${esc(t.id)}" accept="image/*" multiple hidden></label>
      <button class="btn ghost attbtn" data-replay="${esc(t.id)}" data-tip="Candlestick chart of this trade: real OHLC candles with every entry/add fill (▲) and close fill (▼) marked at its actual time and price, plus avg entry/exit lines. Uses the locally cached candles where possible.">📈 Price chart</button></div>
    <div id="replay-${esc(t.id)}"></div>
    <div class="field mrev" id="mrev-${esc(t.id)}" data-mr-box="${esc(t.id)}"></div>
    <div class="jsave"><span class="saved-tag" id="saved-${esc(t.id)}" aria-live="polite">Saved ✓</span>
      <button class="btn" data-save="${esc(t.id)}" data-tip="Notes, setup and tags save as you type; numbers when you leave the field. This saves everything now and refreshes the dashboard.">Save journal</button></div>
  </div></td></tr>`;
}
function esc(s){ return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

/* ============================ journal editing ============================ */
// Trade attachments live in IndexedDB (key att:<id>) as downscaled JPEG data URLs — kept out of
// localStorage / the JSON backup so images can't blow the storage quota.
function downscaleImage(file,max){ max=max||1200; return new Promise((res,rej)=>{
  const rd=new FileReader(); rd.onload=()=>{ const img=new Image();
    img.onload=()=>{ let{width:w,height:h}=img; if(w>max||h>max){ const s=max/Math.max(w,h); w=Math.round(w*s); h=Math.round(h*s); }
      const c=document.createElement('canvas'); c.width=w; c.height=h; c.getContext('2d').drawImage(img,0,0,w,h);
      try{ res(c.toDataURL('image/jpeg',0.72)); }catch(e){ rej(e); } };
    img.onerror=rej; img.src=rd.result; };
  rd.onerror=rej; rd.readAsDataURL(file); }); }
const _attKey=id=>btoa(unescape(encodeURIComponent(id))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
// Attachments render via innerHTML/src, so every entry must be a well-formed base64 image
// data URL — the server validates on PUT, but the client must not trust the read path
// (a compromised sync server could otherwise inject markup through /api/att).
const _attSrcOk=s=>typeof s==='string'&&/^data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]*$/i.test(s);
async function syncAttUp(id){ if(!SRV.enabled||(typeof isDemoData==='function'&&isDemoData()))return; // a sample trade's images stay in this browser
  try{ const arr=(await idbGet('att:'+id))||[];
    const r=arr.length?await srvFetch('/api/att/'+_attKey(id),{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify(arr)})
      :await srvFetch('/api/att/'+_attKey(id),{method:'DELETE'});
    // 413 (too large) / 507 (attachment store full): the images stay in this browser only — say so
    if(r&&!r.ok&&r.status!==404){ let m='HTTP '+r.status; try{ const j=await r.json(); if(j&&j.error)m=j.error; }catch(e){}
      setErr('Screenshots saved in this browser but not on the server: '+m); }
  }catch(e){} }
async function syncAttDown(id){ if(!SRV.enabled||(typeof isDemoData==='function'&&isDemoData()))return null;
  try{ const r=await srvFetch('/api/att/'+_attKey(id));
    if(!r.ok)return null; let arr=await r.json();
    if(Array.isArray(arr)) arr=arr.filter(_attSrcOk);
    if(Array.isArray(arr)&&arr.length){ await idbSet('att:'+id,arr); return arr; }
  }catch(e){} return null; }
async function loadAttachments(id){ const box=document.getElementById('att-'+id); if(!box)return;
  let arr=(await idbGet('att:'+id))||[];
  if(!arr.length&&SRV.enabled){ const dl=await syncAttDown(id); if(dl)arr=dl; } // images follow you across devices
  if(!arr.length){ box.innerHTML='<span style="color:var(--faint);font-size:11.5px">No attachments yet.</span>'; return; }
  box.innerHTML=arr.map((src,i)=>_attSrcOk(src)?`<div class="attthumb"><img src="${src}" data-att-view="${esc(id)}:${i}" alt="attachment ${i+1}"><button class="att-del" data-att-del="${esc(id)}:${i}" title="Remove" aria-label="Remove attachment ${i+1}">×</button><button class="att-ann" data-att-ann="${esc(id)}:${i}" title="Draw on it" aria-label="Draw on attachment ${i+1}">✎</button></div>`:'').join(''); }
async function addAttachments(id,files){ const box=document.getElementById('att-'+id);
  if(box)box.innerHTML='<span style="color:var(--faint);font-size:11.5px">Processing…</span>';
  let arr=(await idbGet('att:'+id))||[];
  for(const f of files){ if(!/^image\//.test(f.type))continue; if(arr.length>=12){ setStatus('Max 12 images per trade.'); break; }
    try{ arr.push(await downscaleImage(f)); }catch(e){} }
  await idbSet('att:'+id,arr); loadAttachments(id); syncAttUp(id); }
/* ---- drawing on a screenshot: arrows, lines, boxes, a pen and text, flattened into the image ---- */
// Shapes are kept as a list while the editor is open (so undo works), then drawn into the image
// on save. "Save" replaces the screenshot; "Save as a copy" keeps the original and adds the
// marked-up one next to it. Pure helpers (annArrowHead) are unit-tested.
const ANN_COLORS=['#F4586A','#2FD08C','#E6B450','#FFFFFF'];
// the two barb points of an arrow head at (x2,y2), pointing along (x1,y1)->(x2,y2)
function annArrowHead(x1,y1,x2,y2,len){
  const a=Math.atan2(y2-y1,x2-x1), s=Math.PI/7;
  return [[x2-len*Math.cos(a-s),y2-len*Math.sin(a-s)],[x2-len*Math.cos(a+s),y2-len*Math.sin(a+s)]];
}
function annDraw(ctx,sh,scale){
  const w=Math.max(2,Math.round(3*scale));
  ctx.save(); ctx.strokeStyle=sh.c; ctx.fillStyle=sh.c; ctx.lineWidth=w; ctx.lineCap='round'; ctx.lineJoin='round';
  if(sh.t==='pen'){ ctx.beginPath(); sh.p.forEach(([x,y],i)=>i?ctx.lineTo(x,y):ctx.moveTo(x,y)); ctx.stroke(); }
  else if(sh.t==='box'){ ctx.strokeRect(Math.min(sh.x1,sh.x2),Math.min(sh.y1,sh.y2),Math.abs(sh.x2-sh.x1),Math.abs(sh.y2-sh.y1)); }
  else if(sh.t==='line'||sh.t==='arrow'){ ctx.beginPath(); ctx.moveTo(sh.x1,sh.y1); ctx.lineTo(sh.x2,sh.y2); ctx.stroke();
    if(sh.t==='arrow'){ const [b1,b2]=annArrowHead(sh.x1,sh.y1,sh.x2,sh.y2,Math.max(12,16*scale));
      ctx.beginPath(); ctx.moveTo(sh.x2,sh.y2); ctx.lineTo(b1[0],b1[1]); ctx.lineTo(b2[0],b2[1]); ctx.closePath(); ctx.fill(); } }
  else if(sh.t==='text'){ const fs=Math.max(14,Math.round(18*scale)); ctx.font='600 '+fs+'px Inter, system-ui, sans-serif'; ctx.textBaseline='top';
    // a dark halo keeps the label readable on any chart
    ctx.lineWidth=Math.max(3,fs/4); ctx.strokeStyle='rgba(8,10,14,.85)'; ctx.strokeText(sh.s,sh.x1,sh.y1); ctx.fillText(sh.s,sh.x1,sh.y1); }
  ctx.restore();
}
async function openAnnotator(id,idx){
  const arr=(await idbGet('att:'+id))||[], src=arr[idx]; if(!_attSrcOk(src))return;
  const img=new Image(); img.src=src; await new Promise((res,rej)=>{ img.onload=res; img.onerror=rej; }).catch(()=>null);
  if(!img.naturalWidth)return;
  const W=img.naturalWidth, H=img.naturalHeight, scale=Math.max(W,H)/1200*1.6||1;
  const bg=document.createElement('div'); bg.className='modal-bg show'; bg.setAttribute('role','dialog'); bg.setAttribute('aria-modal','true'); bg.setAttribute('aria-label','Mark up screenshot');
  const tools=[['arrow','↗ Arrow'],['line','╱ Line'],['box','▭ Box'],['pen','✎ Pen'],['text','T Text']];
  bg.innerHTML=`<div class="modal annbox"><div class="anntools" role="toolbar" aria-label="Drawing tools">
      ${tools.map(([k,l],i)=>`<button type="button" class="btn ghost${i?'':' on'}" data-ann-tool="${k}" aria-pressed="${i?'false':'true'}">${l}</button>`).join('')}
      <span class="annsep"></span>${ANN_COLORS.map((c,i)=>`<button type="button" class="anncol${i?'':' on'}" data-ann-col="${c}" style="background:${c}" aria-label="Colour ${i+1}" aria-pressed="${i?'false':'true'}"></button>`).join('')}
      <span class="annsep"></span><button type="button" class="btn ghost" data-ann="undo">Undo</button><button type="button" class="btn ghost" data-ann="clear">Clear</button></div>
    <div class="annstage"><canvas width="${W}" height="${H}"></canvas></div>
    <div class="modal-actions"><button class="btn ghost" data-ann="cancel">Cancel</button><button class="btn ghost" data-ann="copy">Save as a copy</button><button class="btn" data-ann="save">Save</button></div></div>`;
  document.body.appendChild(bg);
  const cv=bg.querySelector('canvas'), ctx=cv.getContext('2d');
  let tool='arrow', color=ANN_COLORS[0], shapes=[], cur=null;
  const paint=()=>{ ctx.clearRect(0,0,W,H); ctx.drawImage(img,0,0,W,H); for(const s of shapes)annDraw(ctx,s,scale); if(cur)annDraw(ctx,cur,scale); };
  paint();
  const pos=e=>{ const r=cv.getBoundingClientRect(); return [(e.clientX-r.left)*W/r.width,(e.clientY-r.top)*H/r.height]; };
  cv.addEventListener('pointerdown',e=>{ e.preventDefault(); const [x,y]=pos(e);
    if(tool==='text'){ const s=(prompt('Text to place here:')||'').trim().slice(0,80); if(s){ shapes.push({t:'text',c:color,x1:x,y1:y,s}); paint(); } return; }
    cv.setPointerCapture(e.pointerId); cur=tool==='pen'?{t:'pen',c:color,p:[[x,y]]}:{t:tool,c:color,x1:x,y1:y,x2:x,y2:y}; });
  cv.addEventListener('pointermove',e=>{ if(!cur)return; const [x,y]=pos(e); if(cur.t==='pen')cur.p.push([x,y]); else{ cur.x2=x; cur.y2=y; } paint(); });
  const end=()=>{ if(!cur)return; const tiny=cur.t==='pen'?cur.p.length<2:Math.hypot(cur.x2-cur.x1,cur.y2-cur.y1)<4; if(!tiny)shapes.push(cur); cur=null; paint(); };
  cv.addEventListener('pointerup',end); cv.addEventListener('pointercancel',end);
  const close=()=>{ bg.remove(); document.removeEventListener('keydown',onKey); };
  const onKey=e=>{ if(e.key==='Escape')close(); else if((e.ctrlKey||e.metaKey)&&e.key==='z'){ e.preventDefault(); shapes.pop(); paint(); } };
  document.addEventListener('keydown',onKey);
  bg.addEventListener('click',async e=>{
    const b=e.target.closest('button'); if(!b){ if(e.target===bg)close(); return; }
    if(b.dataset.annTool){ tool=b.dataset.annTool; bg.querySelectorAll('[data-ann-tool]').forEach(x=>{ x.classList.toggle('on',x===b); x.setAttribute('aria-pressed',String(x===b)); }); return; }
    if(b.dataset.annCol){ color=b.dataset.annCol; bg.querySelectorAll('[data-ann-col]').forEach(x=>{ x.classList.toggle('on',x===b); x.setAttribute('aria-pressed',String(x===b)); }); return; }
    const a=b.dataset.ann;
    if(a==='undo'){ shapes.pop(); paint(); }
    else if(a==='clear'){ shapes=[]; paint(); }
    else if(a==='cancel')close();
    else if(a==='save'||a==='copy'){
      if(!shapes.length){ close(); return; }
      cur=null; paint();
      let out; try{ out=cv.toDataURL('image/jpeg',0.85); }catch(err){ setErr('Couldn’t save the drawing: '+err.message); return; }
      const now=(await idbGet('att:'+id))||[];
      if(a==='save'&&now[idx]===src)now[idx]=out; else{ if(now.length>=12){ setErr('Max 12 images per trade — remove one first, or Save to replace.'); return; } now.push(out); }
      await idbSet('att:'+id,now); close(); loadAttachments(id); syncAttUp(id);
    }
  });
}
async function removeAttachment(id,idx){ let arr=(await idbGet('att:'+id))||[]; arr.splice(idx,1);
  if(arr.length)await idbSet('att:'+id,arr); else await idbDel('att:'+id); loadAttachments(id); syncAttUp(id); }
// The plan's `at` stamps when its numbers last changed — a plan saved while the trade is
// open is a commitment, one edited after the close is hindsight (Plan adherence splits them).
// Re-saving the journal with the same numbers keeps the original stamp.
function nextPlan(prev,e,s,tg,now){
  if(!(e>0||s>0||tg>0))return null;
  const p={entry:e>0?e:'',stop:s>0?s:'',target:tg>0?tg:''};
  const same=prev&&String(prev.entry)===String(p.entry)&&String(prev.stop)===String(p.stop)&&String(prev.target)===String(p.target);
  if(!same)p.at=now; else if(prev.at)p.at=prev.at; // unchanged legacy plans stay unstamped (unknown), never "hindsight"
  if(prev&&prev.why)p.why=prev.why; // the one-line reason from Pulse's Plan a trade stays with the plan
  return p;
}
function ensureJ(id){ if(!journal[id])journal[id]={notes:'',tags:[],setup:'',rating:0,mistakes:[],risk:null,plan:null}; return journal[id]; }
// "scalp, , SCALP, scalp ,  fomo" → ["scalp","fomo"]: one tag per spelling-insensitive name, the first spelling kept
function parseTags(s){ const seen=new Set(), out=[];
  for(const x of String(s||'').split(',')){ const v=x.trim(), k=v.toLowerCase(); if(v&&!seen.has(k)){ seen.add(k); out.push(v); } }
  return out; }
// the tag filter's options: one per name whatever its case (value = lower case, label = first spelling met)
function tagOptions(J){ const m=new Map();
  for(const j of Object.values(J||{}))for(const t of (j&&Array.isArray(j.tags)?j.tags:[])){ const k=String(t).toLowerCase(); if(k&&!m.has(k))m.set(k,String(t)); }
  return [...m].sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0); }
// A trade plan checked like Daruma's plan form, on the trade's own side; a blank entry is the fill's.
// Without a stop only the target is checked (against the entry). '' = fine.
function tradePlanCheck(t,e,s,tg){
  const long=t.dir!=='Short', en=e>0?e:t.avgEntry;
  if(s>0)return pplanCheck({coin:t.coin||'?',dir:long?'Long':'Short',entry:en>0?en:null,stop:s,target:tg>0?tg:null});
  if(tg>0&&en>0&&(long?tg<=en:tg>=en))return 'For a '+(long?'long':'short')+', the target goes '+(long?'above':'below')+' the entry.';
  return '';
}
// The open drawer → its journal entry. Text always; the numbers (planned risk, the plan) only with
// `nums`: they're saved when the field is left, never half-typed, since a plan's `at` stamp is what
// "written live" is scored on. A plan on the wrong side of the entry isn't saved; the drawer says why.
const _jPlanBad=new Set();
function jReadDrawer(id,nums){
  const g=s=>document.querySelector(`[data-j="${s}"][data-id="${CSS.escape(id)}"]`);
  if(!g('notes'))return null; // the drawer isn't open
  const fresh=!journal[id], j=ensureJ(id), before=JSON.stringify(j);
  j.notes=g('notes').value;
  if(g('setup'))j.setup=g('setup').value;
  if(g('tags'))j.tags=parseTags(g('tags').value);
  let err='';
  if(nums){
    if(g('risk')){ const v=parseFloat(g('risk').value); j.risk=v>0?v:null; }
    const pe=g('plan_entry'), ps=g('plan_stop'), pt=g('plan_target');
    let msg='';
    if(pe||ps||pt){ const e=parseFloat(pe&&pe.value), s=parseFloat(ps&&ps.value), tg=parseFloat(pt&&pt.value), t=allTrades.find(x=>x.id===id), p0=j.plan;
      msg=t?tradePlanCheck(t,e,s,tg):'';
      // a plan stored before this check existed is left as it is (and still named), only new numbers are refused
      const same=!!p0&&String(p0.entry)===String(e>0?e:'')&&String(p0.stop)===String(s>0?s:'')&&String(p0.target)===String(tg>0?tg:'');
      err=same?'':msg;
      if(!err)j.plan=nextPlan(j.plan,e,s,tg,Date.now()); }
    const box=$('planErr-'+id); if(box)box.textContent=err?err+' The plan isn’t saved until it is.':msg;
    if(err)_jPlanBad.add(id); else _jPlanBad.delete(id);
  }
  const changed=JSON.stringify(j)!==before;
  if(fresh&&!changed)delete journal[id];
  return {changed,err};
}
function jSavedTag(id){ const tag=$('saved-'+id); if(tag){ tag.classList.add('show'); clearTimeout(tag._t); tag._t=setTimeout(()=>tag.classList.remove('show'),1400); } }
// Autosave: no redraw, so nothing moves under the cursor (and an open price chart stays). The table
// and stats catch up when the row closes (_jStale) or on the next render; the button redraws now.
let _jStale=false;
function jAutosave(id,nums){ const r=jReadDrawer(id,nums); if(!r||!r.changed)return r;
  markJEdit(id); Store.set(J_KEY,journal); _jStale=true; jSavedTag(id); return r; }
async function saveJournal(id){
  jCancel('t|'+id);
  const r=jReadDrawer(id,true);
  if(r&&r.changed){ markJEdit(id); await Store.set(J_KEY,journal); }
  if(!r||!r.err)jSavedTag(id);
  // the autosave usually got there first (leaving the field saves at once), so the entry is saved either way: say so
  if(r&&!r.err){ const t=allTrades.find(x=>x.id===id); setStatus('Journal saved'+(t?' · '+dispMarket(dcoin(t))+' '+(t.dir||'').toLowerCase():'')+(typeof SRV!=='undefined'&&SRV&&SRV.enabled?' · synced to the server':'')); }
  _jStale=false; render();
}
// Pending autosaves by key ('t|<trade id>', 'day', 'week'): a pause in typing fires one; leaving the
// field, a redraw of the form, hiding the page or closing it fires it at once.
const _jPend=new Map();
function jSoon(key,fn,ms){ jCancel(key); _jPend.set(key,{fn,t:setTimeout(()=>jNow(key),ms==null?700:ms)}); }
function jCancel(key){ const p=_jPend.get(key); if(p){ clearTimeout(p.t); _jPend.delete(key); } }
function jNow(key){ const p=_jPend.get(key); if(!p)return; jCancel(key); try{ p.fn(); }catch(e){ console.warn('autosave',e); } }
function jFlush(){ for(const k of [..._jPend.keys()])jNow(k); }
function toggleRow(id){ expandedId=expandedId===id?null:id; if(_jStale){ _jStale=false; render(); } else renderTable(); }
function refreshTagFilter(){
  const sel=$('fTag'),cur=sel.value;
  sel.innerHTML='<option value="">Any tag</option>'+tagOptions(journal).map(([k,l])=>`<option value="${esc(k)}">${esc(l)}</option>`).join(''); sel.value=cur;
}

/* ============================ render all ============================ */
// Unsaved text in journal fields survives re-renders — the 3-minute auto-refresh, a sync pull,
// or a save elsewhere used to rebuild the rows from the saved journal and silently drop what
// was being typed. A draft is only put back into the same field of the same trade/day/week.
function _draftKey(el){
  const sc=el.closest('[data-draft-scope]'), scope=sc?sc.dataset.draftScope:'';
  if(el.dataset.j)return 'j|'+el.dataset.j+'|'+el.dataset.id;
  return el.id?'#|'+el.id+'|'+scope:null;
}
function captureDrafts(){
  const out=[], act=document.activeElement;
  document.querySelectorAll('#dashView textarea[data-j],#dashView input[data-j],#reviewView textarea,#reviewView input[type=text],#reviewView input[type=number]').forEach(el=>{
    if(el.value===el.defaultValue&&el!==act)return; // the focused field comes back focused even when saved
    const key=_draftKey(el); if(!key)return;
    let sel=null; try{ if(el===act&&el.selectionStart!=null)sel=[el.selectionStart,el.selectionEnd]; }catch(e){}
    out.push({key,value:el.value,focus:el===act,sel});
  });
  return out;
}
function restoreDrafts(list){
  if(!list||!list.length)return;
  const byKey=new Map(list.map(d=>[d.key,d]));
  document.querySelectorAll('#dashView textarea[data-j],#dashView input[data-j],#reviewView textarea,#reviewView input[type=text],#reviewView input[type=number]').forEach(el=>{
    const d=byKey.get(_draftKey(el)); if(!d)return;
    el.value=d.value;
    if(d.focus){ try{ el.focus({preventScroll:true}); if(d.sel)el.setSelectionRange(d.sel[0],d.sel[1]); }catch(e){} }
  });
}
// the break-even band for this render: the user's fixed $ or the automatic one over every closed trade
// (all markets, so a view switch never moves it). The auto band is a median: cached per trade list.
let _beAutoM={trades:null,n:-1,v:null};
function applyBeBand(){ const fx=beFixedOf(settings);
  if(fx==null&&(_beAutoM.trades!==allTrades||_beAutoM.n!==allTrades.length))_beAutoM={trades:allTrades,n:allTrades.length,v:autoBeBand(allTrades.filter(t=>tradeRow(t)&&!t.movedOut))}; // the median trade: trade rows, not spot day rows
  _be=fx!=null?fx:_beAutoM.v; syncBeInput(); }
// Settings: the input holds the fixed $ (empty = auto) and the label says what auto works out to
function syncBeInput(){ const i=$('beThresh'), a=$('beAuto'); if(!i)return; const fx=beFixedOf(settings);
  if(document.activeElement!==i)i.value=fx!=null?fx:'';
  if(a)a.textContent=fx!=null?'Fixed by you ·':'auto ('+fmtUsd(_be)+') ·'; }
function render(){
  try{ planAttachPending(); }catch(e){ console.warn('pending plans',e); } // a plan written in Pulse finds its trade once the trade has loaded
  if(PZ){ // Pulse draws only its own view; the hidden full dashboard isn't rebuilt
    // spot-only history under the default perps view would show empty dials: widen it (not saved)
    view='combined'; // Pulse reads every market: XP, streaks and Today never depend on the full app's view switch
    applyBeBand(); _oneR=computeOneR(periodTrades());
    try{ renderTripwire(); }catch(e){} // still arms the loss-limit notification
    pzRender(); return; }
  const _drafts=captureDrafts();
  try{ renderInner(); } finally { restoreDrafts(_drafts); }
}
let _coachFirst=true, _orphSeen='', _coachStage=0;
// Big accounts: when the coach's inputs changed (a journal save, new fills) rebuilding it is ~1 s at 30k
// trades — its context, the game's every-trade context (X10), then the game. Each is its own idle task here, then the panel, instead of one
// block inside render(). Memoized steps cost nothing, so an unchanged coach just redraws; a newer
// render() supersedes the steps still queued.
function coachStaged(){
  const tok=++_coachStage, ok=()=>tok===_coachStage&&allTrades.length&&coachOn();
  const steps=[()=>{ if(ok())coachContext(); }, ()=>{ if(ok())coachContext(true); }, ()=>{ if(ok())gameContext(); }, ()=>{ if(tok===_coachStage)renderCoach(); }];
  const next=()=>{ const f=steps.shift(); if(f)requestIdleCallback(()=>{ try{ f(); }catch(e){ console.warn(e); } next(); },{timeout:1000}); };
  next();
}
function renderInner(){
  syncDexTog(); syncCoachMode(); // a sync pull or backup restore can flip coach mode
  const pt=periodTrades(); const ptAll=periodTradesAll();
  applyBeBand();
  _oneR=computeOneR(pt);
  renderReconcile(); renderPulse(); renderTape(); renderHeaderSummary();
  renderPositions(); renderRiskPanel(); renderStats(computeStatsMemo(pt,ptAll)); renderCharts(pt,ptAll); renderCalendar(ptAll,pt); renderDowHour(ptAll,pt); renderGuardrails();
  // the coach panel is the heaviest part and sits below the fold: on the first paint it waits for an idle moment
  if(_coachFirst){ _coachFirst=false; const go=()=>{ try{ renderCoach(); }catch(e){ console.warn(e); } }; if(typeof requestIdleCallback==='function')requestIdleCallback(go,{timeout:1500}); else setTimeout(go,50); }
  else if(allTrades.length>=5000&&typeof requestIdleCallback==='function')coachStaged(); else renderCoach();
  renderTripwire(); renderEdge(pt);
  const coins=[...new Set(allTrades.filter(viewFilter).map(dcoin))].sort(); const csel=$('fCoin'),cur=csel.value;
  csel.innerHTML='<option value="">All markets</option>'+coins.map(c=>`<option value="${esc(c)}">${esc(dispMarket(c))}</option>`).join(''); csel.value=cur;
  const wsel=$('fWallet');
  if(settings.wallets.length>1){ wsel.classList.remove('hide'); const wcur=wsel.value;
    wsel.innerHTML='<option value="">All wallets</option>'+settings.wallets.map(w=>`<option value="${esc(w.address)}">${esc(labelFor(w))}</option>`).join(''); wsel.value=wcur; }
  else wsel.classList.add('hide');
  refreshTagFilter(); renderTable();
  if(activeTab==='diag') renderDiagnostic(pt,ptAll);
  else if(typeof diagWarm==='function') diagWarm(pt); // big accounts: the Diagnostic's Monte Carlo starts in the worker now
  if(activeTab==='review') renderReview();
  if(activeTab==='proj') renderProjection();
}
function renderHeaderSummary(){
  const el=$('hdrsum'); if(!el)return;
  if(!settings.wallets.length){ el.classList.add('hide'); return; }
  el.classList.remove('hide');
  el.innerHTML=settings.wallets.length+' wallet'+(settings.wallets.length===1?'':'s')+
    (hlPnl.all!=null?` · verified <b class="${cls(hlPnl.all)}">${fmtUsd(hlPnl.all)}</b> ✓`:'');
  el.title=el.textContent; // the whole line, when the header has to cut it short
}
function renderTape(){
  const el=$('tape'); if(!el)return;
  const closedAll=closedTrades().sort((a,b)=>b.closeTime-a.closeTime); // the chips are trades; the total below is money (spot by the day it was realized)
  if(!closedAll.length){ el.classList.add('hide'); return; }
  const day0=tzMidnight(Date.now()); // same "today" as the tripwire and daily analytics
  const today=closedAll.filter(t=>t.closeTime>=day0);
  const tNet=closedMoney(t=>t.closeTime>=day0).reduce((s,t)=>s+t.net,0);
  const fmtT=ms=>{ const p=tzParts(ms); // tz-toggle clock — the "TODAY" cut is tz-aware, so the printed times must be too
    return ms>=day0 ? String(p.h).padStart(2,'0')+':'+String(p.min).padStart(2,'0')
    : (p.mo+1)+'/'+p.day; };
  const chip=t=>`<span class="tp">${fmtT(t.closeTime)} <b>${esc(dispMarket(dcoin(t)))}</b> <b class="${isBE(t.net)?'':(t.net>=0?'up':'dn')}">${isBE(t.net)?'B/E':(t.net>=0?'+':'−')+'$'+Math.abs(t.net).toFixed(0)}</b></span>`;
  // closed trades only, so say so — and name today's entries still open (the unplanned nudge counts those too)
  const openN=allTrades.filter(t=>t.isOpen&&t.openTime>=day0).length, openTxt=openN?` · ${openN} OPENED TODAY, STILL OPEN`:'';
  const sum=today.length?`<span class="tp sum">TODAY ${tNet>=0?'+':'−'}$${Math.abs(tNet).toFixed(0)} · ${today.length} closed trade${today.length===1?'':'s'}${openTxt}</span>`:`<span class="tp sum">NO CLOSED TRADES TODAY${openTxt} · LAST ${Math.min(12,closedAll.length)} SHOWN</span>`;
  el.classList.remove('hide');
  el.innerHTML=sum+closedAll.slice(0,12).map(chip).join('');
}
function renderPulse(){
  const el=$('pulse'); const inv=allTrades.filter(viewFilter);
  if(!inv.length){ el.classList.add('hide'); return; }
  const now=Date.now();
  // the net is money (spot by the day it was realized); the count is of completed trades
  const win=(from)=>{ const xs=inv.filter(t=>t.closeTime>=from&&t.closeTime<=now);
    return {net:xs.filter(moneyRow).reduce((s,t)=>s+t.net,0), n:xs.filter(t=>tradeRow(t)&&!t.movedOut&&!t.isOpen).length}; };
  const spans=[['Today',win(tzMidnight(now))],['7D',win(now-7*86400000)],['30D',win(now-30*86400000)]];
  el.classList.remove('hide');
  el.innerHTML=spans.map(([k,v])=>`<div class="p-item" data-tip="Realized net PnL and trade count for this window (current market view — ignores the period selector below)."><span class="p-k">${k}</span><span class="p-v ${v.n?cls(v.net):''}">${v.n?fmtUsd(v.net):'—'}</span><span class="p-n">${v.n} trade${v.n===1?'':'s'}</span></div>`).join('');
}
function renderReview(){
  jFlush(); // a day / week answer still waiting for its autosave is saved before the form is rebuilt
  const _drafts=captureDrafts();
  try{ renderReviewInner(); } finally { restoreDrafts(_drafts); }
}
function renderReviewInner(){
  const el=$('reviewView'); if(!el)return;
  const closed=closedTrades(viewFilter);
  if(!closed.length){ el.innerHTML=dayJournalSectionHtml()+habitsSectionHtml()+goalsSectionHtml()+playbooksSectionHtml()+'<div class="diag-section"><p class="lead">No closed trades in this view yet.</p></div>'; wireDayJournal(); wireHabits(); wireGoals(); wirePlaybooks(); return; }
  let procHtml=''; try{ procHtml=processSectionHtml(); }catch(e){ console.warn('process score failed',e); }
  const now=Date.now(), DAY=86400000;
  const money=closedMoney(viewFilter); // the windows' net is money (spot by the day it was realized); their counts and rates are trades
  const win=(from,to)=>closed.filter(t=>t.closeTime>=from&&t.closeTime<to), winM=(from,to)=>money.filter(t=>t.closeTime>=from&&t.closeTime<to);
  const wk=win(now-7*DAY,now+1), pwk=win(now-14*DAY,now-7*DAY), wkM=winM(now-7*DAY,now+1), pwkM=winM(now-14*DAY,now-7*DAY);
  const mo=win(now-30*DAY,now+1), pmo=win(now-60*DAY,now-30*DAY), moM=winM(now-30*DAY,now+1), pmoM=winM(now-60*DAY,now-30*DAY);
  const sumNet=a=>a.reduce((s,t)=>s+t.net,0);
  const wr=a=>{const w=a.filter(t=>isWin(t.net)).length,l=a.filter(t=>isLoss(t.net)).length;return (w+l)?w/(w+l):null;};
  const exp=a=>a.length?sumNet(a)/a.length:null;
  const baseExp=exp(closed), baseWR=wr(closed);
  const weeklyCounts=(()=>{ const m={}; closed.forEach(t=>{const k=Math.floor(t.closeTime/(7*DAY));m[k]=(m[k]||0)+1;}); const v=Object.values(m); return v.length?_avg(v):0; })();
  const delta=(cur,prev,fmt,invert)=>{ if(cur==null||prev==null)return ''; const d=cur-prev; if(Math.abs(d)<1e-9)return ' <span style="color:var(--faint)">flat</span>';
    const good=invert?d<0:d>0; return ` <span class="${good?'pos-t':'neg-t'}" style="font-size:11px">${d>=0?'▲':'▼'} ${fmt(Math.abs(d))} vs prior</span>`; };
  const mrow=(l,v,tip)=>`<div class="metric-row"${tip?` data-tip="${esc(tip)}"`:''}><span class="ml">${l}</span><span class="mv">${v}</span></div>`;
  const pct=x=>x==null?'—':(x*100).toFixed(0)+'%';
  const windowCard=(title,cur,prev,curM,prevM)=>{
    const n=cur.length, net=sumNet(curM||cur), w=wr(cur), e=exp(cur);
    return `<div class="diag-card"><h3>${title}</h3>
      ${mrow('Net PnL','<span class="'+cls(net)+'">'+fmtUsd(net)+'</span>'+delta(net,sumNet(prevM||prev),v=>fmtUsd(v).replace('-','')),'Realized net over the window.')}
      ${mrow('Trades',String(n)+delta(n,prev.length,v=>v.toFixed(0)),'Closed trades in the window.')}
      ${mrow('Win rate',pct(w)+delta(w,wr(prev),v=>(v*100).toFixed(0)+'pt'),'Wins ÷ decisive trades (scratches excluded).')}
      ${mrow('Expectancy / trade',(e!=null?'<span class="'+cls(e)+'">'+fmtUsd(e)+'</span>':'—')+delta(e,exp(prev),v=>fmtUsd(v).replace('-','')),'Average net per trade. Baseline (all-time): '+(baseExp!=null?fmtUsd(baseExp):'—')+'.')}
    </div>`;
  };
  // best / worst this month
  const ms=[...mo].sort((a,b)=>b.net-a.net); const best=ms[0], worst=ms[ms.length-1];
  const tradeLine=t=>t?`<b>${esc(dispMarket(dcoin(t)))}</b> ${t.dir} · <span class="${cls(t.net)}">${fmtUsd(t.net)}</span> · ${fmtDate(t.closeTime)}`:'—';
  // journaling completeness (month)
  const journaled=mo.filter(t=>isJournaled(journal[t.id])).length;
  const jpct=mo.length?journaled/mo.length:0;
  // focus points
  const focus=[];
  if(exp(wk)!=null&&exp(wk)<0&&(baseExp==null||exp(wk)<baseExp)) focus.push(`Expectancy this week (${fmtUsd(exp(wk))}) is below your baseline (${baseExp!=null?fmtUsd(baseExp):'—'}). Tighten trade selection before pressing size.`);
  if(mo.length>=5&&jpct<0.5) focus.push(`Only ${Math.round(jpct*100)}% of this month's trades are journaled. Logging setups and notes is what makes the Diagnostic's pattern miner and mistake tracking work.`);
  if(wk.length>weeklyCounts*1.5&&wk.length>=6) focus.push(`You traded ${wk.length} times this week vs a ~${weeklyCounts.toFixed(0)}/week norm. Watch for overtrading — check the Day×hour heatmap for a leaky slot.`);
  if(worst&&Math.abs(worst.net)>Math.abs(sumNet(mo))*0.5&&worst.net<0) focus.push(`One trade (${esc(dispMarket(dcoin(worst)))}, ${fmtUsd(worst.net)}) drove an outsized share of this month's damage. A per-trade stop or size cap would blunt tails like it.`);
  if(!focus.length) focus.push(sumNet(wk)>=0?`Steady week — net ${fmtUsd(sumNet(wk))} with no red flags in the guardrails. Keep executing your process.`:`A red week (${fmtUsd(sumNet(wk))}) but within normal variance. Review the losing trades below for process breaks vs. bad luck.`);
  // costs & variance: fee-tier economics + what normal-bad looks like at your own edge
  const bp=x=>{const s=(x*1e4).toFixed(1);return (s.endsWith('.0')?s.slice(0,-2):s)+' bp';};
  const fee=feeTierModel(allTrades.filter(t=>!candleVenue(t)&&moneyRow(t)&&!(t.orphan||(t.offRecord&&!t.isOpen)))); // the Hyperliquid fee tier counts Hyperliquid volume only, once (money rows)
  let feeCard='';
  if(fee){
    const fmtVol=v=>v>=1e9?'$'+(v/1e9).toFixed(2)+'B':v>=1e6?'$'+(v/1e6).toFixed(2)+'M':fmtUsd(v).replace('.00','');
    feeCard=`<div class="diag-card"><h3 data-tip="Hyperliquid fees step by trailing-14-day volume. Rates here are the BASE schedule (no staking discounts) — verify against app.hyperliquid.xyz/fees before acting on the dollar figures; last checked September 2026.">Fee tier <span style="font-size:11px;color:var(--faint);font-weight:400">14d volume</span></h3>
      ${mrow('14-day volume',fmtVol(fee.vol14),'What Hyperliquid tiers on: perps volume plus twice spot volume (spot counts double), summed fill notional over the trailing 14 days across your Hyperliquid wallets.'+(fee.spot14>0?' Perps '+fmtVol(fee.perp14)+' + 2 × spot '+fmtVol(fee.spot14)+'.':''))}
      ${mrow('Current tier','tier '+fee.tier+' · taker '+bp(fee.cur.taker)+' / maker '+bp(fee.cur.maker),'Perps rates. Spot at this tier: taker '+bp(fee.cur.spotTaker)+' / maker '+bp(fee.cur.spotMaker)+'.')}
      ${fee.next?mrow('Next tier at',fmtVol(fee.next.min)+' · '+fmtVol(fee.toNext)+' away','Volume needed in a 14-day window to reach taker '+bp(fee.next.taker)+' / maker '+bp(fee.next.maker)+'.'):mrow('Next tier','— top tier')}
      ${mrow('Taker fees · last 30d','<span class="'+cls(-fee.takerFee30)+'">'+fmtUsd(fee.takerFee30)+'</span>','Estimated: taker notional × your current tier rate (spot at spot rates). Actual paid fees over 30d: '+fmtUsd(fee.fees30)+'.')}
      ${fee.saveNextTier30!=null?mrow('One tier up saves','~'+fmtUsd(fee.saveNextTier30)+'/mo','Last 30 days’ taker flow re-priced at the next tier’s taker rate.'):''}
      ${mrow('As maker instead','~'+fmtUsd(fee.saveAsMaker30)+'/mo cheaper','Last 30 days’ taker flow re-priced at your tier’s MAKER rate — the concrete answer to “does resting orders pay”. Fills change when you rest orders, so treat as an upper bound.')}
      <p class="mini-note">Base schedule, hardcoded — verify at app.hyperliquid.xyz/fees (last checked Sep 2026).</p></div>`;
  }
  const vm=varianceModel(closed);
  let varCard='';
  if(vm){
    const srows=vm.streaks.filter(s=>s.prob>=0.03&&s.prob<=0.985).slice(0,4)
      .map(s=>mrow(s.len+'+ losses in a row',Math.round(s.prob*100)+'% chance','Probability that a run of at least '+s.len+' consecutive losses appears somewhere in your next '+vm.horizon+' trades, at your '+Math.round(vm.p*100)+'% win rate. Seeded simulation from your own numbers.')).join('');
    varCard=`<div class="diag-card"><h3 data-tip="Simulated from YOUR win rate, frequency, and trade distribution (seeded, reproducible). Decide now what normal-bad looks like, so a live drawdown reads as variance instead of falsification — the trader who expects the 6-loss streak survives it.">Variance expectations <span style="font-size:11px;color:var(--faint);font-weight:400">next ${vm.horizon} trades</span></h3>
      ${mrow('Your inputs',Math.round(vm.p*100)+'% win rate · ~'+vm.perMonth+' trades/mo','Decisive trades only; frequency from your full history span.')}
      ${srows}
      ${mrow('1-in-20 bad month','<span class="'+cls(vm.monthP5)+'">'+fmtUsd(vm.monthP5)+'</span>','5th percentile of 1,000 bootstrapped months (~'+vm.perMonth+' draws from your own trade nets). At current sizing, a month like this is expected about once every 20 — plan the response before it happens.')}
      ${mrow('Median month','<span class="'+cls(vm.monthMed)+'">'+fmtUsd(vm.monthMed)+'</span>')}
      <p class="mini-note">If the 1-in-20 month would break your rules or your account, the sizing — not the edge — is the problem.</p></div>`;
  }
  const costVar=(feeCard||varCard)?`<div class="diag-section"><h2>Costs &amp; variance</h2><div class="diag-grid">${feeCard}${varCard}</div></div>`:'';

  el.innerHTML=`<div class="diag-section"><h2>Review · ${esc(view)}</h2><p class="lead">Rolling digest for the ${esc(view)} view. Windows are trailing 7 / 30 days; "vs prior" compares the immediately preceding window of equal length.</p></div>
   ${progressSectionHtml()}
   ${dayJournalSectionHtml()}
   ${habitsSectionHtml()}
   ${inboxSectionHtml()}
   ${weeklyReviewSectionHtml()}
   ${goalsSectionHtml()}
   ${playbooksSectionHtml()}
   <div class="diag-section"><h2>This week</h2><div class="diag-grid">${windowCard('Last 7 days',wk,pwk,wkM,pwkM)}${windowCard('Last 30 days',mo,pmo,moM,pmoM)}</div></div>
   ${procHtml}
   ${routineSectionLazyHtml(closed.length)}
   <div id="peersSec">${peersSectionHtml()}</div>
   ${costVar}
   <div class="diag-section"><h2>Highlights · last 30 days</h2><div class="diag-grid">
     <div class="diag-card"><h3>Best &amp; worst</h3>
       ${mrow('Best trade',tradeLine(best))}
       ${mrow('Worst trade',tradeLine(worst))}
       ${mrow('Month net','<span class="'+cls(sumNet(moM))+'">'+fmtUsd(sumNet(moM))+'</span>')}
     </div>
     <div class="diag-card"><h3 data-tip="Share of this month's closed trades that have a note, setup, tag, rating or mistake flag.">Journaling completeness</h3>
       ${mrow('Journaled','<span class="'+(jpct>=.5?'pos-t':'neg-t')+'">'+Math.round(jpct*100)+'%</span> ('+journaled+'/'+mo.length+')')}
       <p class="mini-note">Well-journaled months make the Diagnostic's pattern miner and mistake analytics far sharper.</p>
     </div>
   </div></div>
   <div class="diag-section"><h2>Focus for next week</h2><ol class="recs">${focus.map(f=>`<li>${f}</li>`).join('')}</ol></div>
   ${nfLeaderboardHtml(periodTrades().filter(t=>!t.isOpen))}`;
  wireDayJournal(); wireHabits(); wireInbox(); wireWeeklyReview(); wireGoals(); wirePlaybooks(); wireProgress();
  try{ drawRoutineCharts(); }catch(e){ console.warn('routine charts',e); }
  try{ drawHabitCharts(); }catch(e){ console.warn('habit charts',e); }
  wireRoutineLazy();
  wirePeers();
  loadCoachLetter();
}
/* ============================ playbooks ============================ */
// A playbook is a setup with its written rules ("Breakout: wait for the retest; stop under
// the range; no entries in the first 15 minutes"). A trade whose setup names a playbook (its
// name or one of its aliases) gets that checklist in its journal: tick it before you enter
// (Daruma's Plan a trade, or an open trade's journal row) or when you review. The Review tab
// then compares trades that kept every rule with trades that broke one, rule by rule: does
// following your own rules pay? Playbooks live in settings (synced, merged per playbook,
// deletions as dated tombstones); ticks live in the trade's journal entry as
// j.pb = {id, ok:[rule ids ticked], of:[rule ids on the checklist then], na:[rule ids that didn't
// apply to this trade], at, live:true when it was ticked before the trade closed}.
// A playbook may also carry aliases (other setup spellings that mean it) and rr, the reward-to-risk
// it aims for (Plan a trade fills the target from it).
const PB_MAX=30, PB_RULES_MAX=15, PB_ALIAS_MAX=6, PB_TREND_N=10;
function pbNorm(list, keepDeleted){
  const out=[], seen=new Set();
  for(const p of (Array.isArray(list)?list:[])){
    if(!p||typeof p.id!=='string'||!p.id||seen.has(p.id))continue; seen.add(p.id);
    if(p.del){ if(keepDeleted)out.push({id:p.id.slice(0,24),del:true,at:+p.at||0}); continue; }
    const name=String(p.name||'').trim().slice(0,60); if(!name)continue;
    const rules=(Array.isArray(p.rules)?p.rules:[]).filter(r=>r&&typeof r.id==='string'&&String(r.text||'').trim())
      .slice(0,15).map(r=>({id:r.id.slice(0,24),text:String(r.text).trim().slice(0,160)})); // 15 = PB_RULES_MAX (self-contained: sync code calls this)
    // src: a copy adopted from a playbook someone shared in Daruma (its shared id, the author, the version
    // taken, and when it was taken — an edit after that is the adopter's own)
    const s=p.src, src=s&&typeof s.id==='string'&&/^[a-f0-9]{12}$/.test(s.id)?{src:{id:s.id,h:String(s.h||'').slice(0,20),v:Math.max(1,Math.floor(+s.v)||1),at:+s.at||0}}:{};
    const aliases=pbAliasesFromText(Array.isArray(p.aliases)?p.aliases.filter(a=>typeof a==='string').join('\n'):'',name), rr=pbRR(p.rr);
    out.push({id:p.id.slice(0,24),name,rules,at:+p.at||0,createdAt:+p.createdAt||+p.at||0,...src,...(aliases.length?{aliases}:{}),...(rr?{rr}:{})});
  }
  return out.slice(-90); // PB_MAX × 3, room for tombstones
}
function pbList(){ return pbNorm(settings.playbooks).slice(-PB_MAX); }
// a deleted copy of a playbook someone shared stops counting as adopted (from Daruma or the full journal);
// best effort: offline, signed out or in sample mode the server simply isn't told
function pbUnadopt(p){
  if(!p||!p.src||typeof socFetch!=='function'||typeof SOC==='undefined'||!SOC.key||(typeof pzS!=='undefined'&&pzS.demo)||!/^https?:$/.test(location.protocol))return null;
  return socFetch('/playbooks/'+p.src.id+'/adopt',{method:'POST',body:JSON.stringify({on:false})}).catch(()=>null);
}
function pbKey(s){ return String(s||'').trim().toLowerCase().replace(/\s+/g,' '); }
// the setup spellings that mean playbook p: its name first, then its aliases
function pbNames(p){ return [p.name,...(p.aliases||[])]; }
function playbookFor(setup, playbooks){ const k=pbKey(setup); return k?(playbooks||[]).find(p=>!p.del&&pbNames(p).some(n=>pbKey(n)===k))||null:null; }
// aliases typed with commas or one per line -> up to PB_ALIAS_MAX distinct spellings, never the name itself
function pbAliasesFromText(text, name){
  const seen=new Set([pbKey(name)]), out=[];
  for(const a of String(text||'').split(/[\n,]/)){ const t=a.trim().replace(/\s+/g,' ').slice(0,40), k=pbKey(t); if(!k||seen.has(k))continue; seen.add(k); out.push(t); if(out.length>=PB_ALIAS_MAX)break; }
  return out;
}
// the reward-to-risk a playbook aims for: a number from 0.1 to 50, two decimals; null when none
function pbRR(v){ const x=parseFloat(v); return x>=0.1&&x<=50?Math.round(x*100)/100:null; }
// rules typed one per line -> rules; a line that didn't change keeps its id, so past ticks still count
function pbRulesFromText(text, prev, mkId){
  mkId=mkId||(()=>'r'+Math.random().toString(36).slice(2,9));
  const old=new Map((prev||[]).map(r=>[pbKey(r.text),r.id])), used=new Set();
  return String(text||'').split('\n').map(x=>x.replace(/^\s*(?:[-*•]|\d+[.)])\s*/,'').trim()).filter(Boolean).slice(0,15).map(t=>{ // 15 = PB_RULES_MAX
    let id=old.get(pbKey(t)); if(!id||used.has(id))id=mkId(); used.add(id); return {id,text:t.slice(0,160)}; });
}
// Pure. One trade's checklist against playbook p: null when it wasn't checked (or was checked for
// another playbook); else which of p's rules it was graded on (the ones on its checklist then, minus
// the ones marked not applicable), which it broke, and whether it was ticked before the close.
function pbGrade(pb, p){
  if(!pb||pb.id!==p.id||!Array.isArray(pb.ok))return null;
  const na=new Set(Array.isArray(pb.na)?pb.na:[]), of=Array.isArray(pb.of)?new Set(pb.of):null;
  const graded=p.rules.filter(r=>(!of||of.has(r.id))&&!na.has(r.id)).map(r=>r.id);
  const broke=graded.filter(id=>!pb.ok.includes(id));
  return {graded,broke,kept:!broke.length,live:pb.live===true};
}
// Pure. Per playbook: its trades; of those with a filled-in checklist, the ones that kept every
// rule vs broke at least one (with a bootstrap range on the gap); per rule, how often it was kept
// and the average result when kept vs broken; the rule broken most; the adherence trend (the last
// PB_TREND_N checked trades against the ones before); and how many were ticked before the close.
// A rule only counts on trades whose checklist had it (rules added later don't grade older trades)
// and where it applied. Results come in R (rOf) where the risk is known, and in $ always.
function playbookStats(closed, J, playbooks, rOf){
  rOf=rOf||(()=>null);
  const agg=list=>{ const n=list.length, nets=list.map(t=>t.net); if(!n)return {n:0,net:0,exp:null,wr:null,avgR:null,nR:0,nets,rs:[]};
    const net=nets.reduce((s,x)=>s+x,0), w=list.filter(t=>isWin(t.net)).length, l=list.filter(t=>isLoss(t.net)).length;
    const rs=list.map(rOf).filter(x=>x!=null&&isFinite(x));
    return {n,net,exp:net/n,wr:w+l?w/(w+l):null,avgR:rs.length?rs.reduce((a,b)=>a+b,0)/rs.length:null,nR:rs.length,nets,rs}; };
  return (playbooks||[]).filter(p=>!p.del).map(p=>{
    const mine=closed.filter(t=>{ const j=J[t.id]; return j&&playbookFor(j.setup,[p]); });
    const G=new Map(); for(const t of mine){ const g=pbGrade(J[t.id].pb,p); if(g)G.set(t.id,g); }
    const checked=mine.filter(t=>G.has(t.id));
    const rules=p.rules.map(r=>{ const graded=checked.filter(t=>G.get(t.id).graded.includes(r.id)), k=graded.filter(t=>!G.get(t.id).broke.includes(r.id)), b=graded.filter(t=>G.get(t.id).broke.includes(r.id));
      return {id:r.id,text:r.text,graded:graded.length,keptRate:graded.length?k.length/graded.length:null,kept:agg(k),broke:agg(b)}; });
    const kept=agg(checked.filter(t=>G.get(t.id).kept)), broke=agg(checked.filter(t=>!G.get(t.id).kept));
    const mb=rules.filter(r=>r.broke.n).sort((a,b)=>b.broke.n-a.broke.n||a.keptRate-b.keptRate)[0]||null;
    const chron=[...checked].sort((a,b)=>a.closeTime-b.closeTime), recent=chron.slice(-PB_TREND_N), earlier=chron.slice(0,-PB_TREND_N);
    const rate=L=>L.length?L.filter(t=>G.get(t.id).kept).length/L.length:null;
    return {id:p.id,name:p.name,ruleN:p.rules.length,n:mine.length,checked:checked.length,live:checked.filter(t=>G.get(t.id).live).length,all:agg(mine),
      kept,broke,range:pbGapRange(kept,broke),mostBroken:mb?{id:mb.id,text:mb.text,broke:mb.broke.n,graded:mb.graded}:null,
      trend:{recent:{n:recent.length,rate:rate(recent)},earlier:{n:earlier.length,rate:rate(earlier)}},rules};
  });
}
// the cost of breaking a rule, in R when both sides have R for most trades, else in $ per trade
function pbGap(k, b){
  if(!k.n||!b.n)return null;
  if(k.avgR!=null&&b.avgR!=null&&k.nR>=k.n/2&&b.nR>=b.n/2)return {v:k.avgR-b.avgR,unit:'R'};
  return {v:k.exp-b.exp,unit:'$'};
}
// a 90% bootstrap range on that gap (1000 resamples of each side, seeded by the data so it's the
// same on every redraw), in pbGap's unit; null until each side has 5 trades
function pbGapRange(k, b, B){
  const g=pbGap(k,b); if(!g||k.n<5||b.n<5)return null;
  const a=g.unit==='R'?k.rs:k.nets, c=g.unit==='R'?b.rs:b.nets; if(a.length<5||c.length<5)return null;
  let seed=(a.length*7919+c.length*104729+Math.round((a[0]+c[0])*1000))|0; const rnd=()=>{ seed=seed+0x6D2B79F5|0; let t=Math.imul(seed^seed>>>15,1|seed); t=t+Math.imul(t^t>>>7,61|t)^t; return ((t^t>>>14)>>>0)/4294967296; };
  const mean=L=>{ let s=0; for(let i=0;i<L.length;i++)s+=L[Math.floor(rnd()*L.length)]; return s/L.length; };
  B=B||1000; const d=[]; for(let i=0;i<B;i++)d.push(mean(a)-mean(c)); d.sort((x,y)=>x-y);
  return {lo:d[Math.floor(B*0.05)],hi:d[Math.ceil(B*0.95)-1],unit:g.unit};
}
// Pure. Setups that name no playbook but look like one: the same words as its name or an alias
// (one contains the other, or they share a first word of 4+ letters). Per playbook id: [{setup, n}],
// most used first — the nudge to add an alias so those trades get the checklist and count.
function pbNearSetups(closed, J, playbooks){
  const live=(playbooks||[]).filter(p=>!p.del), cnt={}, canon={};
  for(const t of closed){ const j=J[t.id], s=j&&typeof j.setup==='string'?j.setup.trim().replace(/\s+/g,' '):''; if(!s||playbookFor(s,live))continue; const k=pbKey(s); cnt[k]=(cnt[k]||0)+1; canon[k]=canon[k]||s; }
  const first=k=>{ const w=k.split(' ')[0]; return w.length>=4?w:null; };
  const like=(k,n)=>{ const nk=pbKey(n); if(k.length<4||nk.length<4)return false; if(k.includes(nk)||nk.includes(k))return true; const a=first(k), b=first(nk); return !!a&&a===b; };
  const out={};
  for(const p of live){ const L=Object.keys(cnt).filter(k=>pbNames(p).some(n=>like(k,n))).sort((a,b)=>cnt[b]-cnt[a]).map(k=>({setup:canon[k],n:cnt[k]})); if(L.length)out[p.id]=L; }
  return out;
}
// Pure. Which closed trades have a checked playbook, and which of those broke a rule (the day's
// "playbook rules kept" part reads this). -> {checked: Set, broke: Set}
function pbTradeGrades(closed, J, playbooks){
  const live=(playbooks||[]).filter(p=>!p.del), checked=new Set(), broke=new Set();
  if(live.length)for(const t of closed){ const j=J[t.id]; if(!j||!j.pb)continue; const p=playbookFor(j.setup,live), g=p&&pbGrade(j.pb,p); if(!g)continue; checked.add(t.id); if(!g.kept)broke.add(t.id); }
  return {checked,broke};
}
// Pure. One line's worth of playbook adherence over a set of closed trades (a week, the coach):
// null with nothing checked; else how many kept every rule, and the rule broken most often.
function pbSummary(closed, J, playbooks){
  const S=playbookStats(closed,J,playbooks,()=>null).filter(s=>s.checked); if(!S.length)return null;
  const checked=S.reduce((a,s)=>a+s.checked,0), kept=S.reduce((a,s)=>a+s.kept.n,0);
  const mb=S.filter(s=>s.mostBroken).sort((a,b)=>b.mostBroken.broke-a.mostBroken.broke)[0];
  return {checked,kept,broke:checked-kept,playbooks:S.length,mostBroken:mb?{playbook:mb.name,text:mb.mostBroken.text,n:mb.mostBroken.broke}:null};
}
function pbSummaryText(s){ if(!s)return '';
  return s.kept+' of '+s.checked+' checked trade'+(s.checked===1?'':'s')+' kept every playbook rule'+(s.mostBroken?'. Broken most: “'+s.mostBroken.text+'” ('+s.mostBroken.playbook+', '+s.mostBroken.n+' time'+(s.mostBroken.n===1?'':'s')+')':'')+'.'; }
// the words after a checklist's name: how many kept, and when it was ticked
function pbTickWords(p, pb){ if(!pb||pb.id!==p.id||!Array.isArray(pb.ok))return 'not checked yet';
  const na=new Set(pb.na||[]), of=p.rules.filter(r=>!na.has(r.id)); return pb.ok.filter(id=>of.some(r=>r.id===id)).length+'/'+of.length+' kept · ticked '+(pb.live?'before the close':'after the close'); }
// the checklist inside a trade's journal row
function pbChecklistHtml(t,j){
  const p=playbookFor(j.setup,pbList()); if(!p)return '';
  if(!p.rules.length)return `<div class="field"><label>${esc(p.name)} playbook</label><p class="mini-note">This playbook has no rules yet — add them under Review → Playbooks.</p></div>`;
  const pb=j.pb&&j.pb.id===p.id?j.pb:null, ok=new Set(pb?pb.ok:[]), na=new Set(pb&&Array.isArray(pb.na)?pb.na:[]);
  return `<div class="field"><label data-tip="Tick each rule you followed on this trade${t.isOpen?' — before you enter is best':''}. Unticked rules count as broken once any box here has been saved; n/a takes a rule that didn’t apply to this trade out of the grading. Ticks made while the trade is open are marked as such. Review → Playbooks compares trades that kept every rule with trades that broke one.">${esc(p.name)} playbook · ${esc(pbTickWords(p,pb))}</label>
    <div class="pbrules" data-pb="${esc(p.id)}" data-id="${esc(t.id)}">${p.rules.map(r=>`<div class="pbrow${na.has(r.id)?' na':''}"><label class="pbrule${ok.has(r.id)&&!na.has(r.id)?' on':''}"><input type="checkbox" data-pbr="${esc(r.id)}"${ok.has(r.id)&&!na.has(r.id)?' checked':''}${na.has(r.id)?' disabled':''}><span>${esc(r.text)}</span></label><button type="button" class="pbna" data-pbna="${esc(r.id)}" aria-pressed="${na.has(r.id)}" data-tip="This rule didn’t apply to this trade: it’s left out of the grading.">n/a</button></div>`).join('')}</div></div>`;
}
// a tick is an edit, saved at once (like the mistake flags); once ticked live, a later touch keeps it live
function pbSaveTicks(box){
  const id=box.dataset.id, p=pbList().find(x=>x.id===box.dataset.pb); if(!p)return;
  const j=ensureJ(id), na=[...box.querySelectorAll('[data-pbna][aria-pressed="true"]')].map(b=>b.dataset.pbna);
  const ok=[...box.querySelectorAll('input[data-pbr]')].filter(i=>i.checked&&!na.includes(i.dataset.pbr)).map(i=>i.dataset.pbr);
  const t=allTrades.find(x=>x.id===id), live=!!((j.pb&&j.pb.id===p.id&&j.pb.live)||(t&&t.isOpen));
  j.pb={id:p.id,ok,of:p.rules.map(r=>r.id),...(na.length?{na}:{}),at:Date.now(),...(live?{live:true}:{})};
  const lab=box.previousElementSibling; if(lab)lab.textContent=p.name+' playbook · '+pbTickWords(p,j.pb);
  markJEdit(id); Store.set(J_KEY,journal);
}
// n/a on a rule: out of the grading for this trade (and unticked)
function pbToggleNa(btn){
  const box=btn.closest('.pbrules'), row=btn.closest('.pbrow'), on=btn.getAttribute('aria-pressed')!=='true';
  btn.setAttribute('aria-pressed',String(on)); row.classList.toggle('na',on);
  const inp=row.querySelector('input[data-pbr]'); if(inp){ inp.disabled=on; if(on){ inp.checked=false; row.querySelector('.pbrule').classList.remove('on'); } }
  pbSaveTicks(box);
}
let _pbEdit=null; // playbook id being edited, 'new', or null
function playbooksSectionHtml(){
  const list=pbList();
  const closed=closedTrades(viewFilter);
  const stats=playbookStats(closed,journal,list,rFor), near=pbNearSetups(closed,journal,list);
  const mrow=(l,v,tip)=>`<div class="metric-row"${tip?` data-tip="${esc(tip)}"`:''}><span class="ml">${l}</span><span class="mv">${v}</span></div>`;
  const pct=x=>x==null?'—':Math.round(x*100)+'%';
  const res=a=>!a.n?'—':`${a.n} trade${a.n===1?'':'s'} · win ${pct(a.wr)} · `+(a.avgR!=null&&a.nR>=a.n/2?`<span class="${cls(a.avgR)}">${a.avgR>=0?'+':''}${a.avgR.toFixed(2)}R</span>/trade`:`<span class="${cls(a.exp)}">${fmtUsd(a.exp)}</span>/trade`);
  const early=(a,b)=>Math.min(a.n,b.n)<10?` <span style="color:var(--faint)" data-tip="Fewer than 10 trades on one side: this can flip with a few more trades.">· early (${Math.min(a.n,b.n)} vs ${Math.max(a.n,b.n)})</span>`:'';
  const gapTxt=g=>!g?'':g.unit==='R'?`${g.v>=0?'+':''}${g.v.toFixed(2)}R`:`${g.v>=0?'+':''}${fmtUsd(g.v)}`;
  const rangeTxt=r=>!r?'':` <span style="color:var(--faint)" data-tip="A 90% bootstrap range: resampling your trades 1,000 times, the gap landed in here 9 times out of 10. A range that straddles zero isn’t settled yet.">· 90% range ${gapTxt({v:r.lo,unit:r.unit})} to ${gapTxt({v:r.hi,unit:r.unit})}</span>`;
  const editor=p=>`<div class="diag-card pbedit"><h3>${p?'Edit playbook':'New playbook'}</h3>
      <div class="field"><label for="pbName">Setup name</label><input type="text" id="pbName" maxlength="60" value="${esc(p?p.name:'')}" placeholder="e.g. Breakout retest"></div>
      <div class="field"><label for="pbRules">Rules — one per line</label><textarea id="pbRules" placeholder="Wait for the retest of the range high&#10;Stop under the range low&#10;Risk no more than 1R&#10;No entries in the first 15 minutes">${esc(p?p.rules.map(r=>r.text).join('\n'):'')}</textarea></div>
      <div class="field"><label for="pbAliases" data-tip="Other spellings of this setup you use on trades (comma separated, up to ${PB_ALIAS_MAX}). A trade tagged with any of them gets this checklist and counts here.">Also matches — other setup names, comma separated</label><input type="text" id="pbAliases" maxlength="200" value="${esc(p&&p.aliases?p.aliases.join(', '):'')}" placeholder="breakout, bo retest"></div>
      <div class="field"><label for="pbRR" data-tip="The reward-to-risk this setup aims for. Daruma’s Plan a trade fills the target from it once you’ve typed the entry and the stop.">Target reward-to-risk (optional)</label><input type="number" id="pbRR" inputmode="decimal" step="0.1" min="0.1" max="50" value="${p&&p.rr?p.rr:''}" placeholder="e.g. 2 for 1:2"></div>
      <p class="mini-note">A trade gets this checklist when its Setup field says this name or one of the other names. Rewording a rule starts it fresh; unchanged lines keep their history.</p>
      <button class="btn" id="pbSave" data-pbid="${esc(p?p.id:'')}">Save playbook</button> <button class="btn ghost" id="pbCancel">Cancel</button></div>`;
  const cards=stats.map(s=>{ const p=list.find(x=>x.id===s.id); if(_pbEdit===s.id)return editor(p);
    const g=pbGap(s.kept,s.broke), tr=s.trend, trendOn=tr.earlier.n>=5&&tr.recent.n>=5;
    const rules=s.rules.map(r=>({r,g:pbGap(r.kept,r.broke)})).sort((a,b)=>(b.g?Math.abs(b.g.v):-1)-(a.g?Math.abs(a.g.v):-1));
    const nr=near[s.id]||[];
    return `<div class="diag-card"><h3>${esc(s.name)} <span style="font-size:11px;color:var(--faint);font-weight:400">${p&&p.src?'from @'+esc(p.src.h)+' · ':''}${s.ruleN} rule${s.ruleN===1?'':'s'} · ${s.n} trade${s.n===1?'':'s'}${p&&p.rr?' · aims for 1:'+p.rr:''}</span></h3>
      ${p&&p.aliases&&p.aliases.length?`<p class="mini-note" style="margin-top:0">Also matches: ${esc(p.aliases.join(', '))}</p>`:''}
      ${s.checked?`${mrow('Kept every rule',res(s.kept),'Trades whose checklist had every rule that applied ticked.')}
      ${mrow('Broke a rule',res(s.broke),'Trades with at least one rule that applied left unticked.')}
      ${g?mrow('Following the playbook is worth',`<b class="${cls(g.v)}">${gapTxt(g)}</b> per trade${rangeTxt(s.range)}${early(s.kept,s.broke)}`,'Average result when every rule was kept minus when one was broken. Small samples swing a lot — read it as a direction until each side has 20+ trades.'):''}
      ${s.mostBroken?mrow('Rule you break most',`${esc(s.mostBroken.text)} <span style="color:var(--faint)">· broken on ${s.mostBroken.broke} of ${s.mostBroken.graded}</span>`,'The rule left unticked on the most checked trades. Fixing one rule is easier than fixing a setup.'):''}
      ${trendOn?mrow('Adherence trend',`last ${tr.recent.n} checked: <b class="${tr.recent.rate>=tr.earlier.rate?'pos-t':'neg-t'}">${pct(tr.recent.rate)}</b> kept every rule <span style="color:var(--faint)">· before that ${pct(tr.earlier.rate)} (${tr.earlier.n})</span>`,'Share of checked trades that kept every rule: the most recent '+PB_TREND_N+' against the ones before. Is it getting better?'):''}
      ${mrow('Ticked before the close',`${s.live} of ${s.checked}`,'Checklists filled while the trade was still open (or in Plan a trade before it). Ticks made after the close know how it went; these don’t.')}
      <div style="margin-top:8px;border-top:1px solid var(--line);padding-top:6px">${rules.map(({r,g})=>mrow(esc(r.text),r.graded?`kept ${pct(r.keptRate)}${!g?'':g.v>=0?` · breaking it cost <b class="neg-t">${gapTxt(g).replace('+','')}</b>/trade`:` · broken trades did <b class="pos-t">${gapTxt({v:-g.v,unit:g.unit})}</b> better`}${g?early(r.kept,r.broke):''}`:'<span style="color:var(--faint)">not graded yet</span>','Of the '+r.graded+' checked trades where this rule applied: how often you kept it, and the average result when kept vs broken.')).join('')}</div>`
      :`<p class="mini-note">${s.n?`${s.n} trade${s.n===1?' has':'s have'} this setup, none checked yet. Open one in the trade list and tick the rules you followed.`:'No trades with this setup yet. Type “'+esc(s.name)+'” in a trade’s Setup field to get the checklist.'}</p>`}
      ${s.checked&&s.checked<s.n?`<p class="mini-note">${s.n-s.checked} of ${s.n} trades with this setup aren’t checked yet.</p>`:''}
      ${nr.length?`<p class="mini-note">${nr.slice(0,3).map(x=>`${x.n} trade${x.n===1?'':'s'} tagged “${esc(x.setup)}” look${x.n===1?'s':''} like this playbook${p&&(p.aliases||[]).length<PB_ALIAS_MAX?` — <button class="btn ghost pbaliasbtn" data-pbalias="${esc(s.id)}" data-v="${esc(x.setup)}">count them here</button>`:''}`).join('<br>')}</p>`:''}
      <div style="margin-top:8px"><button class="btn ghost" data-pbedit="${esc(s.id)}">Edit</button> <button class="btn ghost" data-pbdel="${esc(s.id)}">Delete</button></div></div>`; }).join('');
  return `<div class="diag-section"><h2>Playbooks <span style="font-size:11px;color:var(--faint);font-weight:400">your setups' rules, and what keeping them is worth · current view</span></h2>
    <p class="lead">Write the rules for each setup once. Every trade with that setup gets a checklist; tick what you followed${list.length?'':' — then this section shows whether following your own rules pays'}.${/^https?:$/.test(location.protocol)?` <a href="/daruma#playbooks">Share yours or adopt others’ in Daruma →</a>`:''}</p>
    <div class="diag-grid">${cards}${_pbEdit==='new'?editor(null):''}</div>
    ${_pbEdit===null&&list.length<PB_MAX?'<button class="btn ghost" id="pbNew" style="margin-top:8px">+ New playbook</button>':''}</div>`;
}
function wirePlaybooks(){
  const root=$('reviewView'); if(!root)return;
  const nb=$('pbNew'); if(nb)nb.onclick=()=>{ _pbEdit='new'; renderReview(); setTimeout(()=>{ const n=$('pbName'); if(n)n.focus(); },0); };
  const cancel=$('pbCancel'); if(cancel)cancel.onclick=()=>{ _pbEdit=null; renderReview(); };
  const save=$('pbSave'); if(save)save.onclick=async()=>{
    const name=$('pbName').value.trim(); if(!name){ setErr('A playbook needs a setup name.'); return; }
    const all=pbNorm(settings.playbooks,true), id=save.dataset.pbid, prev=all.find(p=>p.id===id&&!p.del);
    const aliases=pbAliasesFromText($('pbAliases').value,name), rr=pbRR($('pbRR').value);
    const clash=pbList().find(p=>p.id!==id&&[name,...aliases].some(n=>pbNames(p).some(m=>pbKey(m)===pbKey(n))));
    if(clash){ setErr('“'+clash.name+'” already answers to one of those names.'); return; }
    const now=Date.now(), p={id:prev?prev.id:'pb'+now.toString(36)+Math.random().toString(36).slice(2,5),name,rules:pbRulesFromText($('pbRules').value,prev&&prev.rules),at:now,createdAt:prev?prev.createdAt:now,...(prev&&prev.src?{src:prev.src}:{}),...(aliases.length?{aliases}:{}),...(rr?{rr}:{})};
    settings.playbooks=[...all.filter(x=>x.id!==p.id),p];
    _pbEdit=null; await Store.set(S_KEY,settings); renderReview(); renderTable();
  };
  root.querySelectorAll('[data-pbedit]').forEach(b=>b.onclick=()=>{ _pbEdit=b.dataset.pbedit; renderReview(); });
  // "count them here": the look-alike setup becomes an alias, so its trades get the checklist and count
  root.querySelectorAll('[data-pbalias]').forEach(b=>b.onclick=async()=>{
    const all=pbNorm(settings.playbooks,true), p=all.find(x=>x.id===b.dataset.pbalias&&!x.del); if(!p)return;
    const aliases=pbAliasesFromText([...(p.aliases||[]),b.dataset.v].join('\n'),p.name); if(aliases.length===(p.aliases||[]).length)return;
    settings.playbooks=[...all.filter(x=>x.id!==p.id),{...p,aliases,at:Date.now()}];
    await Store.set(S_KEY,settings); renderReview(); renderTable(); });
  root.querySelectorAll('[data-pbdel]').forEach(b=>b.onclick=async()=>{
    const p=pbList().find(x=>x.id===b.dataset.pbdel); if(!p||!confirm('Delete the “'+p.name+'” playbook? Trades keep their setup name; their checklist ticks stop counting.'))return;
    settings.playbooks=[...pbNorm(settings.playbooks,true).filter(x=>x.id!==p.id),{id:p.id,del:true,at:Date.now()}];
    pbUnadopt(p); await Store.set(S_KEY,settings); renderReview(); renderTable(); });
}

/* ============================ routine vs results (Review) ============================ */
// The long view of "does discipline pay": routineVsResults (habits-coach.js) over the whole history,
// memoized on the game's context (it runs ~3k seeded permutations/resamples). Like Discipline and XP it
// reads every trade, whatever the view and dex filters show — the days and their trades must match.
let _rvMemo={key:null,r:null}, _rvCharts=[];
const _rvKey=g=>_coachMemoAll.key+'|'+g.days.length;
function rvModel(){
  const g=gameContext(), ctx=g.ctx, key=_rvKey(g);
  if(_rvMemo.key===key)return _rvMemo.r;
  const entryOf=k=>{ const e=journal['day:'+k]; return {checkin:typeof pzReadinessManual==='function'&&pzReadinessManual(e)!=null, review:!!(e&&e.eod&&e.eod.at)}; };
  const r=routineVsResults(g.days,ctx.byDay,{rOf:rFor,pctOf:retPct,weekOf:isoWeekOfKey,entryOf,seed:_hashSeed('rv|all')});
  _rvMemo={key,r}; return r;
}
// plain words for a rank correlation and its p-value
function rvLinkWords(c){
  if(!c)return null;
  const a=Math.abs(c.rho), size=a>=0.5?'strong':a>=0.3?'moderate':a>=0.1?'weak':'no real';
  const dir=c.rho>=0?'better':'worse';
  return {size,dir,chance:c.p>=0.05,text:(a<0.1?'No real link':size[0].toUpperCase()+size.slice(1)+' link: more disciplined weeks, '+dir+' results')+(c.p>=0.05&&a>=0.1?' — but it could still be chance':'')};
}
const RV_HEAD=`<h2>Routine vs results <span style="font-size:11px;color:var(--faint);font-weight:400">the long view · does your discipline pay? · all your trades</span></h2>`;
// Big accounts: this section (routineVsResults — ~3k seeded resamples over every trade, ~500 ms at
// 30k trades — and the habits-vs-results model) sits far down the Review. While either model isn't
// memoized yet it's a placeholder with the same heading, filled in when it nears the viewport
// (wireRoutineLazy), so opening the tab doesn't wait on it. Same section, same numbers, built later.
let _rvLazyIO=null;
function routineSectionLazyHtml(n){
  if(n<2000||typeof IntersectionObserver!=='function')return routineSectionHtml();
  try{ const g=gameContext(); if(_rvMemo.key===_rvKey(g)&&_hlMemo.key===_hlKey(g))return routineSectionHtml(); }catch(e){}
  return `<div class="diag-section" id="rvLazy">${RV_HEAD}<p class="lead">Working out how your routine lines up with your results\u2026</p></div>`;
}
function wireRoutineLazy(){
  if(_rvLazyIO){ _rvLazyIO.disconnect(); _rvLazyIO=null; }
  const ph=$('rvLazy'); if(!ph)return;
  _rvLazyIO=new IntersectionObserver(es=>{ if(!es.some(e=>e.isIntersecting))return; _rvLazyIO.disconnect(); _rvLazyIO=null;
    if(!ph.isConnected)return; ph.outerHTML=routineSectionHtml();
    try{ drawRoutineCharts(); }catch(e){ console.warn('routine charts',e); }
    try{ drawHabitCharts(); }catch(e){ console.warn('habit charts',e); } },{rootMargin:'600px 0px'});
  _rvLazyIO.observe(ph);
}
function routineSectionHtml(){
  let r; try{ r=rvModel(); }catch(e){ console.warn('routine vs results',e); return ''; }
  const u=r.unit, fmt=v=>v==null?'—':(v>=0?'+':'')+(u==='R'?v.toFixed(2)+'R':v.toFixed(2)+'%');
  const mrow=(l,v,tip)=>`<div class="metric-row"${tip?` data-tip="${esc(tip)}"`:''}><span class="ml">${l}</span><span class="mv">${v}</span></div>`;
  const head=`<div class="diag-section">${RV_HEAD}`;
  const hl=`<div id="hlSec">${hlSectionInner()}</div>`;
  if(r.weeks.length<r.need.weeks)return head+hl+`<p class="lead" style="margin-top:14px">The week-by-week test below needs at least ${r.need.weeks} weeks with trades to say anything honest — you have ${r.weeks.length}. Keep trading your process; the link (or the lack of one) shows up here once there’s enough history.</p>
    <div class="rvbar" role="progressbar" aria-valuemin="0" aria-valuemax="${r.need.weeks}" aria-valuenow="${r.weeks.length}" data-tip="${r.weeks.length} of ${r.need.weeks} weeks with trades"><i style="width:${Math.round(100*r.weeks.length/r.need.weeks)}%"></i></div></div>`;
  const L=rvLinkWords(r.corr), N=rvLinkWords(r.lead), dv=r.dividend;
  const flat=!r.corr&&r.weeks.every(w=>Math.abs(w.score-r.weeks[0].score)<1e-9);
  if(flat)return head+hl+`<p class="lead">Your routine score was ${Math.round(r.weeks[0].score)} every week of this history (${r.weeks.length} weeks) — no revenge entries, sizing up after losses, adds to losers or overtrading${r.weeks[0].score<100?' changed from week to week':''}. With no variation there’s nothing to compare yet; this fills in as soon as some weeks go differently.</p></div>`;
  const hRows=r.habits.filter(h=>h.kept.n>0&&h.missed.n>0);
  const headline=dv?(dv.lo>0?`On your disciplined days (score 70+) you made <b class="pos-t">${fmt(dv.diff)}</b> more per trade than on the rest — and that holds up (90% range ${fmt(dv.lo)} to ${fmt(dv.hi)}).`
      :dv.hi<0?`Surprisingly, your disciplined days did <b class="neg-t">${fmt(dv.diff)}</b> per trade versus the rest (90% range ${fmt(dv.lo)} to ${fmt(dv.hi)}). Worth a look at what “disciplined” trades you’re taking.`
      :`So far your disciplined days and the rest perform about the same per trade (${fmt(dv.diff)}, 90% range ${fmt(dv.lo)} to ${fmt(dv.hi)}) — not enough to call either way yet.`)
    :'Not enough trades on both kinds of day yet to compare them.';
  const sig=h=>h.mechanical?'<span style="color:var(--faint)">follows from the result</span>':h.q!=null&&h.q<0.1?'<b>holds up</b>':h.p!=null&&h.p<0.05?'suggestive':h.p!=null?'<span style="color:var(--faint)">could be chance</span>':'<span style="color:var(--faint)">too few days</span>';
  const roll=r.rolling.length>=2?r.rolling:null;
  return head+hl+`<h3 style="margin:18px 0 6px;font-size:13px">Week by week · the long view</h3><p class="lead">${headline}</p>
    <div class="diag-grid">
      <div class="diag-card"><h3 data-tip="Bars: average result per trade each week. Line: that week’s routine score (0–100, right axis) — how often you kept to it when you had the chance: waited after a loss, kept your size after a loss, didn’t add to a loser, stayed inside your usual trade count.">Week by week</h3><div class="chart-box" style="height:220px"><canvas id="rvWeeks"></canvas></div></div>
      <div class="diag-card"><h3 data-tip="Cumulative result of the trades taken on days scoring 70+ versus all other days, in date order. Two separate running totals.">Disciplined days vs the rest</h3><div class="chart-box" style="height:220px"><canvas id="rvCurves"></canvas></div></div>
    </div>
    <div class="diag-grid">
      <div class="diag-card"><h3>The numbers</h3>
        ${mrow('Same week',L?`${esc(L.text)} <span style="color:var(--faint)">ρ ${r.corr.rho.toFixed(2)} · p ${r.corr.p.toFixed(3)} · ${r.corr.n} weeks</span>`:'—','Spearman rank correlation between each week’s routine score and its average result per trade, with a permutation p-value (1,000 shuffles).')}
        ${mrow('Next week',N?`${esc(N.text.replace('more disciplined weeks, ','a disciplined week, then '))} <span style="color:var(--faint)">ρ ${r.lead.rho.toFixed(2)} · p ${r.lead.p.toFixed(3)}</span>`:'—','Does a disciplined week predict the FOLLOWING week’s results? Same-week links can run backwards (a bad day makes you sloppy); a next-week link can’t, so it’s closer to cause and effect.')}
        ${dv?mrow('Per trade, disciplined days',`${fmt(dv.good.mean)} <span style="color:var(--faint)">${dv.good.n} trades</span>`,'Days are only compared with days that had as many entries after a loss (a day without a loss to react to is a better day by construction), and the groups are pooled. Days with no such match are left out.'):''}
        ${dv?mrow('Per trade, other days',`${fmt(dv.rest.mean)} <span style="color:var(--faint)">${dv.rest.n} trades</span>`):''}
        ${roll?mrow('Over time',`ρ ${roll[0].rho.toFixed(2)} → ${roll[roll.length-1].rho.toFixed(2)} <span style="color:var(--faint)">rolling 12 weeks</span>`,'The same-week correlation over a sliding 12-week window, first and latest. Rising means discipline is paying more lately.'):''}
        <p class="mini-note">Results are ${u==='R'?'in R (your planned risk per trade)':'% return on notional (set a planned risk to see R)'}, so bigger size doesn’t count as better trading. Correlation isn’t proof: read the next-week line and the habits below as the stronger evidence.</p></div>
    </div>
    <div class="diag-grid" style="grid-template-columns:1fr">
      <div class="diag-card"><h3 data-tip="Average result per trade on days you kept each habit versus days you didn’t (d = days). Revenge entries and sizing up are compared trade by trade (t): entries after a loss where you waited or kept your size, against those where you didn’t — never the loss that came before. 'Holds up' survives a false-discovery check across all habits tested; 'suggestive' doesn’t yet. Habits that can only fail on a losing day are listed but not tested.">Which habits pay</h3>
        <div class="tbl-wrap"><table class="rvtbl"><thead><tr><th class="l">Habit</th><th>Kept</th><th>Missed</th><th>Difference</th><th class="l">Evidence</th></tr></thead><tbody>
        ${hRows.length?'':'<tr><td colspan="5" class="l" style="color:var(--faint)">Every habit here was either always kept or never logged in this history — nothing to compare yet.</td></tr>'}
        ${hRows.map(h=>`<tr${h.mechanical?' class="rvmech"':''}><td class="l">${esc(h.label)}</td><td>${fmt(h.kept.mean)} <span class="rvn">${h.kept.n}${h.per==='trade'?'t':'d'}</span></td><td>${fmt(h.missed.mean)} <span class="rvn">${h.missed.n}${h.per==='trade'?'t':'d'}</span></td><td class="${h.diff==null?'':cls(h.diff)}">${h.diff==null?'—':fmt(h.diff)}</td><td class="l">${sig(h)}</td></tr>`).join('')}
        </tbody></table></div></div>
    </div></div>`;
}
// ---- habits vs results, day by day: the scatter, the score bands and which habits pay ----
// Shown from three trading days (the week-by-week test above waits for eight weeks). Same model
// as Pulse → Stats → Habits vs results (habitLink), on the whole history of every trade.
let _hlUnit='$', _hlMemo={key:null,v:null}, _hlCharts=[];
const _hlKey=g=>_coachMemoAll.key+'|'+g.days.length+'|'+_hlUnit+'|'+_jrev;
function hlModel(){
  const g=gameContext(), ctx=g.ctx, key=_hlKey(g);
  if(_hlMemo.key===key)return _hlMemo.v;
  const entryOf=k=>{ const e=journal['day:'+k]; return {checkin:typeof pzReadinessManual==='function'&&pzReadinessManual(e)!=null, review:!!(e&&e.eod&&e.eod.at)}; };
  const v=habitLink(g.days,ctx.byDay,{unit:_hlUnit,rOf:rFor,pctOf:retPct,entryOf,seed:_hashSeed('hl|all')});
  _hlMemo={key,v}; return v;
}
const hlFmt=(v,u)=>v==null||!isFinite(v)?'—':u==='$'?fmtUsd(v):u==='%'?(v>=0?'+':'')+v.toFixed(2)+'%':(v>=0?'+':'')+v.toFixed(2)+'R';
const HL_UNIT_WORDS={'$':'dollars of net P&L','%':'% return on the size traded (summed per day)','R':'R — result ÷ planned risk (summed per day)'};
function hlSectionInner(){
  let L; try{ L=hlModel(); }catch(e){ console.warn('habits vs results',e); return ''; }
  const u=L.unit;
  const tog=L.units.length>1?`<span class="viewtog" id="hlUnit" role="group" aria-label="Result in">${L.units.map(k=>`<button class="${k===u?'on':''}" data-u="${k}" data-tip="Results in ${esc(HL_UNIT_WORDS[k])}">${k==='$'?'$ P&amp;L':k}</button>`).join('')}</span>`:'';
  const top=`<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin:6px 0 8px"><h3 style="margin:0;font-size:13px" data-tip="Each trading day is a dot: across, your habit score (the share of your habits you kept that day: plan, rules, stops written, prep, review, journaling, and no revenge entry, sizing up after a loss, adding to a loser or overtrading); up and down, what the day made. Dots drifting up to the right mean your habits pay.">Habits vs results · day by day</h3>${tog}</div>`;
  if(L.points.length<L.need.days)return top+`<p class="lead">Each trading day becomes a dot — how many of your habits you kept against what you made. Needs ${L.need.days} trading days; you have ${L.points.length}.</p>`;
  const W=hlLinkWords(L.corr), gd=L.good, rs=L.rest;
  const lead=!L.spread?`Every day has the same habit score (${L.points[0].score}) so far — nothing to compare yet. As some days go better or worse on your habits, the dots spread out and the link shows. `:(gd.n&&rs.n?`Days you kept 70%+ of your habits averaged <b class="${cls(gd.avg)}">${hlFmt(gd.avg,u)}</b> (${gd.n} days); the rest averaged <b class="${cls(rs.avg)}">${hlFmt(rs.avg,u)}</b> (${rs.n} days). `:'')
    +(!L.spread?'':W?`<b>${esc(W.text)}</b> <span style="color:var(--faint)" data-tip="Spearman rank correlation across ${L.corr.n} days, with a permutation p-value (1,000 shuffles). ρ above 0: days with more habits kept come with better results. p under 0.05: unlikely to be chance.">ρ ${L.corr.rho.toFixed(2)} · p ${L.corr.p.toFixed(3)} · ${L.corr.n} days</span>`
       :`<span style="color:var(--faint)">${L.points.length} days so far — the link is stated from ${L.need.corr}.</span>`);
  return top+`<p class="lead">${lead}</p>
    <div class="diag-grid">
      <div class="diag-card"><h3 data-tip="One dot per trading day. Across: habit score (0–100). Up and down: the day's result. The dashed line is the trend; the shaded band is 70+. Hover a dot for the day.">Habit score vs day result</h3><div class="chart-box" style="height:260px"><canvas id="hlScatter"></canvas></div><p class="mini-note">Habits counted: ${esc(L.tracked.join(', ').toLowerCase())}. Stops honored and the loss limit are left out of the score: they can only fail on a losing day.</p></div>
      <div class="diag-card"><h3 data-tip="Your days grouped by habit score, and what an average day in each group made. If your habits pay, the bars climb to the right.">Average day by habit score</h3><div class="chart-box" style="height:260px"><canvas id="hlBands"></canvas></div></div>
    </div>
    ${L.habits.length?`<div class="diag-card" style="margin-top:14px"><h3 data-tip="For each habit: your average day when you kept it minus your average day when you didn't. Right and green: keeping it went with better days. Grey: a habit that can only fail on a losing day, so it follows from the result.">Which habits pay · kept minus missed</h3><div class="chart-box" style="height:${Math.max(140,34*L.habits.length+40)}px"><canvas id="hlHabits"></canvas></div></div>`:''}`;
}
function drawHabitCharts(){
  _hlCharts.forEach(c=>{ try{ c.destroy(); }catch(e){} }); _hlCharts=[];
  const L=_hlMemo.v, a=$('hlScatter'); if(!L||!a)return;
  const css=v=>getComputedStyle(document.body).getPropertyValue(v).trim();
  const pos=css('--profit')||'#2FD08C', neg=css('--loss')||'#F4586A', gold=css('--gold')||'#C9A85C', u=L.unit;
  const yTick=v=>u==='$'?'$'+Number(v).toLocaleString():(+Number(v).toFixed(2))+(u==='%'?'%':'R');
  const jit=k=>{ let h=0; for(const c of k)h=(h*31+c.charCodeAt(0))|0; return ((h>>>0)%1000/1000-0.5)*3; };
  const P=L.points, x0=Math.min(...P.map(p=>p.score));
  const band={id:'hlBand',beforeDatasetsDraw(ch){ const xa=ch.scales.x, ya=ch.scales.y, c=ch.ctx; c.save(); c.fillStyle=tint(themeGreen(),.06);
    c.fillRect(xa.getPixelForValue(70),ya.top,xa.getPixelForValue(100)-xa.getPixelForValue(70),ya.bottom-ya.top); c.restore(); }};
  const ds=[{type:'scatter',label:'Trading day',data:P.map(p=>({x:Math.max(0,Math.min(100,p.score+jit(p.key))),y:p.v,p})),
    backgroundColor:P.map(p=>p.v>=0?pos:neg),pointRadius:5,pointHoverRadius:7,borderColor:'rgba(0,0,0,.25)',borderWidth:1}];
  if(L.fit&&x0<100)ds.push({type:'line',label:'Trend',data:[{x:x0,y:L.fit.icpt+L.fit.slope*x0},{x:100,y:L.fit.icpt+L.fit.slope*100}],borderColor:gold,borderDash:[6,4],borderWidth:2,pointRadius:0,pointHitRadius:0});
  _hlCharts.push(explain(new Chart(a,{data:{datasets:ds},plugins:[band],
    options:{responsive:true,maintainAspectRatio:false,interaction:{mode:'nearest',intersect:false,axis:'xy'},
      plugins:{legend:{display:false},tooltip:{filter:i=>i.datasetIndex===0,callbacks:{
        title:it=>{ const p=it[0].raw.p; return dayLabel(p.key); },
        label:c=>{ const p=c.raw.p; return ' Habit score '+p.score+' · '+p.kept.length+' of '+(p.kept.length+p.missed.length)+' kept'+(p.discipline!=null?' · Discipline '+p.discipline:''); },
        afterLabel:c=>{ const p=c.raw.p;
          return [' Result '+hlFmt(p.v,u)+(u!=='$'?' ('+fmtUsd(p.usd)+')':''),' '+p.n+' trade'+(p.n===1?'':'s')+' · '+p.wins+' W · '+p.losses+' L'].concat(p.missed.length?wrapTip('Missed: '+p.missed.join(', '),48).map(x=>' '+x):[' Every habit kept']); }}}},
      scales:{x:{type:'linear',min:Math.max(0,Math.min(60,Math.floor((x0-8)/10)*10)),max:100,grid:{color:GRID},ticks:{stepSize:10},title:{display:true,text:'habit score (share of your habits kept that day)',color:TXT,font:{size:11}}},
        y:{grid:{color:GRID},ticks:{callback:yTick},title:{display:true,text:'day result ('+(u==='$'?'net P&L':u==='%'?'% return':'R')+')',color:TXT,font:{size:11}}}}}}),
    items=>items&&items[0]&&items[0].datasetIndex===0?'Shaded: 70+ of your habits kept. Dashed line: the trend'+(L.fit?' — about '+hlFmt(L.fit.per10,u)+' a day per 10 points of score':'')+'.':''));
  const b=$('hlBands');
  if(b)_hlCharts.push(explain(new Chart(b,{type:'bar',data:{labels:L.bands.map(x=>x.label),datasets:[{data:L.bands.map(x=>x.avg),backgroundColor:L.bands.map(x=>(x.avg||0)>=0?pos:neg),borderRadius:4,maxBarThickness:70}]},
    options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{
      title:it=>'Habit score '+it[0].label,label:c=>{ const x=L.bands[c.dataIndex]; return x.n?' Average day '+hlFmt(x.avg,u):' No days in this band'; },
      afterLabel:c=>{ const x=L.bands[c.dataIndex]; return x.n?[' '+x.n+' day'+(x.n===1?'':'s')+' · '+x.green+' green · '+x.trades+' trades',' All together '+hlFmt(x.total,u)]:[]; }}}},
      scales:{x:{grid:{display:false},title:{display:true,text:'habit score',color:TXT,font:{size:11}}},y:{grid:{color:GRID},ticks:{callback:yTick}}}}}),
    'What an average day made at each habit score. Rising to the right: your habits pay.'));
  const h=$('hlHabits');
  if(h)_hlCharts.push(explain(new Chart(h,{type:'bar',data:{labels:L.habits.map(x=>x.label),datasets:[{data:L.habits.map(x=>x.diff),
      backgroundColor:L.habits.map(x=>x.mechanical?'rgba(120,130,150,.6)':x.diff>=0?pos:neg),borderRadius:4,maxBarThickness:22}]},
    options:{indexAxis:'y',responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{
      label:c=>' Kept minus missed: '+hlFmt(c.parsed.x,u),
      afterLabel:c=>{ const x=L.habits[c.dataIndex], w=x.per==='trade'?'trade':'day', nn=k=>k+' '+(x.per==='trade'?'entr'+(k===1?'y':'ies')+' after a loss':'day'+(k===1?'':'s'));
        return [' Kept: '+hlFmt(x.kept.avg,u)+' a '+w+' over '+nn(x.kept.n),' Missed: '+hlFmt(x.missed.avg,u)+' a '+w+' over '+nn(x.missed.n)].concat(x.mechanical?[' Can only fail on a losing day — follows from the result.']:[]); }}}},
      scales:{x:{grid:{color:GRID},ticks:{callback:yTick}},y:{grid:{display:false},ticks:{autoSkip:false}}}}}),
    'Green bars: habits whose kept days beat their missed days. A link, not proof — but one worth protecting.'));
  const tg=$('hlUnit'); if(tg)tg.querySelectorAll('button').forEach(btn=>btn.onclick=()=>{ _hlUnit=btn.dataset.u; const sec=$('hlSec'); if(sec){ sec.innerHTML=hlSectionInner(); drawHabitCharts(); } });
}
// ---- "Traders like you", the detailed version: pick the peer group, see the whole spread ----
let _peersPick=null;
function peersSectionHtml(){
  const head=`<div class="diag-section"><h2>Traders like you <span style="font-size:11px;color:var(--faint);font-weight:400">your last 90 days against anonymous traders of your style, size and experience</span></h2>`;
  if(!peerCanAsk())return '';
  if(SOC.cfg&&SOC.cfg.bench&&SOC.cfg.bench.on===false)return '';
  let mine; try{ mine=peerMine(); }catch(e){ return ''; }
  if(!mine.ok)return head+`<p class="lead">${esc(peerWhy(mine))}${mine.n?' You have '+mine.n+'.':''}</p></div>`;
  const P=peerData(mine), d=P&&P.d;
  if(!d)return head+`<p class="lead">${P&&P.err?'Couldn’t load the comparison: '+esc(P.err):'Loading your peer groups…'}</p></div>`;
  if(d.on===false)return '';
  if(!d.groups.length)return head+`<p class="lead">Not enough traders on this server yet: ${d.contributors} of the ${d.min} needed for a group${d.seeds?' ('+d.seeds+' of them seed wallets)':''}.</p></div>`;
  const g=peerGroup(d,_peersPick);
  // pick the group by the dimensions it matches; a combination with too few traders isn't offered
  const have=new Set(d.groups.map(x=>x.key)), keyOf=dims=>{ const ks=['style','size','exp','act'].filter(k=>dims[k]); return ks.length?ks.map(k=>k+'='+dims[k]).join('|'):'all'; };
  const chips=['style','size','exp','act'].map(k=>{ const on=!!g.dims[k], nd=Object.assign({},g.dims); if(on)delete nd[k]; else nd[k]=mine[k];
    const ok=have.has(keyOf(nd));
    return `<button class="peerchip${on?' on':''}" data-peerkey="${esc(keyOf(nd))}"${ok?'':' disabled'} aria-pressed="${on}" data-tip="${esc(ok?(on?'Stop matching on ':'Also match on ')+PEER_DIM_NAMES[k].toLowerCase():'Too few traders share this with you as well; a group needs '+d.min+'.')}">${esc(PEER_DIM_NAMES[k])}: ${esc(PEER_DIMS[k][mine[k]])}</button>`; }).join('');
  let last='';
  const rows=PEER_M.filter(m=>g.q[m.k]).map(m=>{
    const hdr=m.g!==last?`<tr><td colspan="6" class="peergrp">${m.g}</td></tr>`:''; last=m.g;
    const v=mine[m.k], b=m.ctx?null:peerBetter(m,g.q[m.k],v), c=b==null?'':b>=75?'pos-t':b<25?'neg-t':'';
    return hdr+`<tr><td class="l"><span data-tip="${esc(m.tip)}">${esc(m.l)}</span>${m.verified?' <span class="peerver" data-tip="Read on chain">verified</span>':''}</td>
      <td><b>${v==null?'—':esc(m.f(v))}</b></td><td>${esc(m.f(g.q[m.k][4]))}</td><td>${m.ctx||g.top[m.k]==null?'—':esc(m.f(g.top[m.k]))}</td>
      <td class="peerstrip">${peerStripSvg(m,g,v)}</td><td class="${c}">${b==null?(m.ctx?'<span style="color:var(--faint)">context</span>':'—'):b+'%'}</td></tr>`; }).join('');
  const gap=peerGap(g,mine), say=gap&&PEER_GAP_SAY[gap.m.k](gap.top,gap.v);
  return head+`<div class="peerctl"><span class="mini-note" style="margin:0">Compare me with</span>${chips}<span class="mini-note" style="margin:0 0 0 auto"><b>${g.n}</b> traders · ${esc(peerGroupName(g))}</span></div>
    ${say?`<p class="lead" style="margin:10px 0 0"><b>What the best quarter does differently:</b> ${esc(say[0])} ${esc(say[1])}</p>`:''}
    <div class="tbl-wrap"><table class="peertbl"><thead><tr><th class="l">Measure</th><th>You</th><th>Typical</th><th data-tip="The median of the group's best quarter by profit factor">Best quarter</th><th class="l">Where you sit</th><th data-tip="Out of 100 traders in this group, how many you do better than">Better than</th></tr></thead><tbody>${rows}</tbody></table></div>
    <p class="mini-note">Line: the group's 10th to 90th percentile · box: its middle half · tick: typical · diamond: best quarter · dot: you. Groups of ${d.min} or more, built daily from ${d.contributors} anonymous summaries${d.seeds?' ('+d.seeds+' from seed wallets read on chain)':''}. Only the groups' spreads reach this page, never another trader's numbers.${SOC.share&&SOC.share.bench===false?' You aren’t counted yourself (switched off in Daruma under Profile & privacy).':''}</p>${peersImpHtml(d)}</div>`;
}
// What traders like you changed when they improved: each change's median for the improvers against
// the others over 8–12 weeks, and how many each median covers (group figures only, from the server)
function peersImpHtml(d){
  const I=d&&d.improvers; if(!I)return '';
  const head=`<h3 style="margin:18px 0 4px;font-size:14px">What traders like you changed when they improved</h3>`;
  if(!I.changes.length)return head+`<p class="lead">${esc(I.note||'Not enough history yet.')}</p>`;
  const val=(c,v)=>{ if(v==null)return '—'; const m=PEER_M.find(x=>x.k===c.metric); return m?m.f(v):Math.round(v)+'% of days'; };
  const rows=I.changes.map(c=>`<tr><td class="l"><b>${esc(c.label)}</b><div class="mini-note" style="margin:2px 0 0">${esc(c.text)}.</div></td>
    <td>${esc(val(c,c.from))} → ${esc(val(c,c.to))}</td><td><b>${esc(peerImpFmt(c,c.improversDelta))}</b></td><td>${esc(peerImpFmt(c,c.othersDelta))}</td>
    <td>${c.n} / ${c.nOthers}</td><td>${Math.abs(c.effect).toFixed(1)}</td></tr>`).join('');
  return head+`<div class="tbl-wrap"><table class="peertbl"><thead><tr><th class="l">Change</th><th data-tip="Medians for the traders who improved, 8 to 12 weeks apart">Improvers, then → now</th><th data-tip="Median change for the traders who improved">Improvers’ change</th><th data-tip="Median change for everyone else in the group over the same weeks">Others’ change</th><th data-tip="How many traders each median covers: improvers / others">n</th><th data-tip="The gap between the two medians, in units of the spread of everyone’s changes. Biggest first.">Effect</th></tr></thead><tbody>${rows}</tbody></table></div>
    <p class="mini-note">${I.n} traders in ${esc(peerGroupName(I))} moved from the bottom half of the group to the top half on Discipline or profit factor over 8 to 12 weeks; ${I.nOthers} others didn’t. % changes are relative; pts are percentage points. Only changes where both sides have 5 or more traders are shown.</p>`;
}
function peerStripSvg(m,g,v){
  const q=g.q[m.k], top=g.top[m.k], W=220, lo=Math.min(q[0],v==null?q[0]:v,top==null?q[0]:top), hi=Math.max(q[8],v==null?q[8]:v,top==null?q[8]:top);
  const pad=(hi-lo)*0.06||1, a=lo-pad, b=hi+pad, x=t=>(4+(t-a)/(b-a)*(W-8)).toFixed(1);
  const bt=m.ctx||v==null?null:peerBetter(m,q,v), col=bt==null?'var(--muted)':bt>=75?'var(--profit)':bt<25?'var(--loss)':'#5AA9FF';
  return `<svg width="${W}" height="22" viewBox="0 0 ${W} 22" role="img" aria-label="${esc(m.l)}: middle half of the group ${esc(m.f(q[2]))} to ${esc(m.f(q[6]))}${v==null?'':', you '+esc(m.f(v))}">
    <line x1="${x(q[0])}" x2="${x(q[8])}" y1="11" y2="11" stroke="var(--line)" stroke-width="2"/>
    <rect x="${x(q[2])}" y="5" width="${Math.max(2,x(q[6])-x(q[2]))}" height="12" rx="3" fill="var(--panel2)" stroke="var(--line)"/>
    <line x1="${x(q[4])}" x2="${x(q[4])}" y1="3" y2="19" stroke="var(--text)" stroke-width="2"/>
    ${top==null||m.ctx?'':`<rect x="${(+x(top)-4).toFixed(1)}" y="7" width="8" height="8" transform="rotate(45 ${x(top)} 11)" fill="#8a7bd8"/>`}
    ${v==null?'':`<circle cx="${x(v)}" cy="11" r="5.5" fill="${col}" stroke="var(--bg)" stroke-width="2"/>`}</svg>`;
}
function wirePeers(){ const el=$('peersSec'); if(!el)return;
  el.querySelectorAll('[data-peerkey]').forEach(b=>b.onclick=()=>{ _peersPick=b.dataset.peerkey; peersRerender(); }); }
function peersRerender(){ const el=$('peersSec'); if(!el)return; el.innerHTML=peersSectionHtml(); wirePeers(); }
function drawRoutineCharts(){
  _rvCharts.forEach(c=>{ try{ c.destroy(); }catch(e){} }); _rvCharts=[];
  const a=$('rvWeeks'), b=$('rvCurves'); if(!a||!b)return;
  const r=_rvMemo.r; if(!r)return;
  const css=v=>getComputedStyle(document.body).getPropertyValue(v).trim();
  const pos=css('--profit')||'#2FD08C', neg=css('--loss')||'#F4586A', gold=css('--gold')||'#C9A85C';
  _rvCharts.push(new Chart(a,{data:{labels:r.weeks.map(w=>w.week.replace(/^\d{4}-/,'')),datasets:[
      {type:'bar',label:'Result per trade',data:r.weeks.map(w=>w.res),backgroundColor:r.weeks.map(w=>w.res>=0?pos:neg),yAxisID:'y',order:2},
      {type:'line',label:'Routine score',data:r.weeks.map(w=>w.score),borderColor:gold,backgroundColor:gold,pointRadius:0,borderWidth:2,tension:.25,yAxisID:'y2',order:1}]},
    options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{title:it=>'Week '+r.weeks[it[0].dataIndex].week,
        label:c=>c.datasetIndex===0?' Result per trade '+(c.parsed.y>=0?'+':'')+c.parsed.y.toFixed(2)+(r.unit==='R'?'R':'%'):' Routine score '+Math.round(c.parsed.y),
        afterBody:it=>{ const w=r.weeks[it[0].dataIndex]; return [' '+w.days+' trading day'+(w.days===1?'':'s')+' · '+w.trades+' trade'+(w.trades===1?'':'s')]; }}}},scales:{x:{grid:{display:false},ticks:{maxTicksLimit:8,maxRotation:0}},
      y:{grid:{color:GRID},ticks:{callback:v=>(+v.toFixed(2))+(r.unit==='R'?'R':'%')}},y2:{position:'right',min:0,max:100,grid:{display:false}}}}}));
  explain(_rvCharts[0],'Bars: each week’s average result per trade. Gold line: that week’s routine score (right axis). If they rise and fall together, discipline is paying.');
  const pts=s=>s.map(p=>({x:Date.parse(p.key+'T12:00:00Z'),y:p.v}));
  _rvCharts.push(new Chart(b,{type:'line',data:{datasets:[
      {label:'Disciplined days (70+)',data:pts(r.curves.good),borderColor:pos,pointRadius:0,borderWidth:2},
      {label:'Other days',data:pts(r.curves.rest),borderColor:neg,pointRadius:0,borderWidth:2,borderDash:[5,4]}]},
    options:{responsive:true,maintainAspectRatio:false,interaction:{mode:'nearest',intersect:false},plugins:{legend:{display:true,labels:{boxWidth:10}},
      tooltip:{callbacks:{title:it=>dayLabel(new Date(it[0].parsed.x).toISOString().slice(0,10)),label:c=>' '+c.dataset.label+': '+(c.parsed.y>=0?'+':'')+c.parsed.y.toFixed(2)+(r.unit==='R'?'R':'%')+' so far'}}},
      scales:{x:{type:'linear',min:Math.min(...[...r.curves.good,...r.curves.rest].map(p=>Date.parse(p.key+'T12:00:00Z'))),max:Math.max(...[...r.curves.good,...r.curves.rest].map(p=>Date.parse(p.key+'T12:00:00Z'))),grid:{display:false},ticks:{maxTicksLimit:6,callback:v=>{ const d=new Date(v); return (d.getUTCMonth()+1)+'/'+String(d.getUTCFullYear()).slice(2); }}},
        y:{grid:{color:GRID},ticks:{callback:v=>(+v.toFixed(2))+(r.unit==='R'?'R':'%')}}}}}));
  explain(_rvCharts[1],'Two running totals: trades on your disciplined days (routine 70+) and trades on all other days. The gap is what discipline is worth.');
}
/* ============================ monthly goals ============================ */
// This-month progress vs self-set goals: realized net vs target (with straight-line pace
// and projection), worst intramonth drawdown vs the acceptable max, trades/week vs the
// cap. Calendar month on the tz toggle. Pure given tzParts/settings.
function monthlyGoalModel(closed, goals, now){
  now=now||Date.now();
  if(!goals||!(goals.monthlyTarget>0||goals.maxDD>0||goals.maxTradesWeek>0))return null;
  const p=tzParts(now);
  const mStart=settings.tz==='utc'?Date.UTC(p.y,p.mo,1):new Date(p.y,p.mo,1).getTime();
  const daysIn=new Date(Date.UTC(p.y,p.mo+1,0)).getUTCDate();
  const dayOf=p.day;
  // one list, two populations: money rows (perp trades, spot day rows) for the net and the drawdown,
  // trade rows (perp trades, spot round trips) for the counts; given trade rows alone they coincide
  const rows=closed.filter(t=>!t.isOpen&&t.closeTime>=mStart&&t.closeTime<=now).sort((a,b)=>a.closeTime-b.closeTime);
  const inMonth=rows.filter(t=>!t.spotPos), trMonth=rows.filter(t=>!t.spotRz&&!t.movedOut);
  const net=inMonth.reduce((s,t)=>s+t.net,0);
  let cum=0,peak=0,worst=0;
  for(const t of inMonth){ cum+=t.net; if(cum>peak)peak=cum; if(cum-peak<worst)worst=cum-peak; }
  const weeksElapsed=Math.max(1/7,(now-mStart)/(7*86400000));
  return {mStart, daysIn, dayOf, n:trMonth.length, net, intraDD:worst,
    tradesPerWeek:trMonth.length/weeksElapsed,
    projected:dayOf>0?net/dayOf*daysIn:null,
    paceNeeded:goals.monthlyTarget>0?(goals.monthlyTarget-net)/Math.max(1,daysIn-dayOf+1):null,
    target:goals.monthlyTarget>0?goals.monthlyTarget:null,
    maxDD:goals.maxDD>0?goals.maxDD:null,
    maxTradesWeek:goals.maxTradesWeek>0?goals.maxTradesWeek:null};
}
function goalsSectionHtml(){
  const g=settings.goals||{};
  const allClosed=allTrades.filter(viewFilter); // every row: the model sums money rows and counts trade rows itself
  const m=monthlyGoalModel(allClosed,g);
  const inp=(id,val,ph,tip)=>`<div class="field"><label data-tip="${esc(tip)}">${ph}</label><input type="number" id="${id}" min="0" step="any" value="${val>0?esc(val):''}"></div>`;
  let progress='<p class="lead">Set a goal to see this month tracked against it. Goals are commitments made calmly — the month holds you to them.</p>';
  if(m){
    const rows=[];
    const mrow=(l,v,tip)=>`<div class="metric-row"${tip?` data-tip="${esc(tip)}"`:''}><span class="ml">${l}</span><span class="mv">${v}</span></div>`;
    if(m.target!=null){
      const pct=Math.max(0,Math.min(1.5,m.net/m.target));
      rows.push(mrow('Net vs target','<span class="'+cls(m.net)+'">'+fmtUsd(m.net)+'</span> / '+fmtUsd(m.target)+' ('+Math.round(pct*100)+'%)','Realized net this calendar month against your target.'));
      if(m.projected!=null)rows.push(mrow('Projected month-end','<span class="'+cls(m.projected)+'">'+fmtUsd(m.projected)+'</span>','Straight-line projection of the current pace across the whole month. Day '+m.dayOf+' of '+m.daysIn+'.'));
      if(m.paceNeeded!=null&&m.net<m.target)rows.push(mrow('Needed per remaining day',fmtUsd(m.paceNeeded),'What the rest of the month must average per calendar day to hit the target.'));
    }
    if(m.maxDD!=null)rows.push(mrow('Intramonth drawdown',(m.intraDD<0?'<span class="'+(-m.intraDD>=m.maxDD?'loss':'')+'">'+fmtUsd(m.intraDD)+'</span>':'—')+' / cap '+fmtUsd(-m.maxDD),'Worst peak-to-trough dip of this month’s cumulative net vs the max you said you would tolerate.'+(-m.intraDD>=m.maxDD?' CAP EXCEEDED — the plan says stop and review.':'')));
    if(m.maxTradesWeek!=null)rows.push(mrow('Trades / week',(m.tradesPerWeek).toFixed(1)+' / cap '+m.maxTradesWeek,'Average weekly trade count this month vs your cap.'+(m.tradesPerWeek>m.maxTradesWeek?' Over — overtrading is the leak most journals find first.':'')));
    rows.push(mrow('Trades this month',String(m.n)));
    progress=rows.join('');
  }
  return `<div class="diag-section"><h2>Monthly goals <span style="font-size:11px;color:var(--faint);font-weight:400">this month vs the plan · current view</span></h2>
    <div class="diag-grid">
      <div class="diag-card"><h3 data-tip="Three commitments, all optional. They persist with your settings and sync across devices.">The plan</h3>
        ${inp('goalTarget',g.monthlyTarget,'Monthly net target ($)','Realized net you are aiming for this month.')}
        ${inp('goalDD',g.maxDD,'Max acceptable drawdown ($)','Worst intramonth peak-to-trough dip you will tolerate before stopping to review.')}
        ${inp('goalTPW',g.maxTradesWeek,'Trades/week cap','Weekly trade-count ceiling — the anti-overtrading commitment.')}
        <button class="btn ghost" id="goalSave">Save goals</button> <span id="goalSaved" style="color:var(--faint);font-size:11px"></span>
      </div>
      <div class="diag-card"><h3 data-tip="Where the month actually stands against each commitment.">This month</h3>${progress}</div>
    </div></div>`;
}
function wireGoals(){
  const b=$('goalSave'); if(!b)return;
  b.onclick=async()=>{
    const v=id=>{ const n=parseFloat($(id).value); return n>0?n:null; };
    settings.goals={monthlyTarget:v('goalTarget'), maxDD:v('goalDD'), maxTradesWeek:v('goalTPW')};
    await Store.set(S_KEY,settings);
    const s=$('goalSaved'); if(s){ s.textContent='saved'; setTimeout(()=>{ s.textContent=''; },1400); }
    renderReview();
  };
}
/* ============================ day-level journal ============================ */
// Daily entries live INSIDE the trade journal under 'day:YYYY-MM-DD' keys (tz-toggle
// dates), so they ride the existing persistence, server sync, conflict merge, and backup
// machinery for free — trade ids are 'addr:COIN:time', so the keyspace can't collide.
function dayJKey(ms){ const p=tzParts(ms); return 'day:'+p.y+'-'+String(p.mo+1).padStart(2,'0')+'-'+String(p.day).padStart(2,'0'); }
let _dayJEditKey=null, _dayJEditSetOn=null; // calendar-day click target; auto-clears when the tz-day rolls over
let _uPnlBase={day:null,val:0}; // open uPnL at the first sight of each tz-day — tripwire uses the intraday delta
function dayJournalSectionHtml(){
  const todayK=dayJKey(Date.now());
  // a calendar-click target left over from a previous day is a trap: tomorrow's plan and
  // committed max loss typed into it save to the past date and never arm the tripwire
  if(_dayJEditKey&&_dayJEditSetOn!==tzMidnight(Date.now())){ _dayJEditKey=null; _dayJEditSetOn=null; }
  const k=_dayJEditKey||todayK, isToday=k===todayK;
  const e=journal[k]||{};
  const recent=[];
  // step from today's tz-midnight and sample mid-day: naive now−i*24h skipped or doubled
  // a calendar date across DST transitions (23/25-hour local days)
  const mid0=tzMidnight(Date.now())+43200000;
  for(let i=1;i<=21&&recent.length<7;i++){ const rk=dayJKey(mid0-i*86400000); const d=journal[rk]; if(d)recent.push([rk,d]); }
  const chip=(rk,d)=>`<div class="metric-row"><span class="ml">${esc(rk.slice(4))}${d.bias?' · '+esc(d.bias):''}${d.adherence?' · <span class="pos-t">plan followed</span>':''}</span><span class="mv" style="max-width:58%;text-align:right;white-space:normal;font-weight:400">${esc(d.review||d.plan||'')}</span></div>`;
  return `<div class="diag-section"><h2>Day journal <span style="font-size:11px;color:var(--faint);font-weight:400">pre-market plan · end-of-day review</span></h2>
    <div class="diag-grid">
      <div class="diag-card" data-draft-scope="${esc(k)}"><h3 data-tip="Write the plan BEFORE the session: bias, what you'll trade, and the loss at which you stop. A committed max loss becomes today's tripwire threshold on the dashboard — a number you chose calmly, enforced when you aren't.">${isToday?'Today':'Day'} — ${esc(k.slice(4))}${isToday?'':' <button class="linkish" id="djToday" style="margin-left:8px">back to today</button>'}</h3>
        <div class="field"><label>Bias / market read</label><input type="text" id="djBias" value="${esc(e.bias||'')}" placeholder="e.g. chop until CPI, long bias above break"></div>
        <div class="field"><label>Plan</label><textarea id="djPlan" placeholder="What will you trade today — and what will you NOT do?">${esc(e.plan||'')}</textarea></div>
        <div class="field"><label>Committed max loss ($)</label><input type="number" id="djMaxLoss" min="0" step="any" value="${e.maxLoss>0?esc(e.maxLoss):''}" placeholder="stop trading for the day at −$…"></div>
${coachOn()?`        <div class="field"><label data-tip="Ten seconds before the session. The pattern miner tests these like any other condition (&quot;low focus&quot;, &quot;slept badly&quot;) once about ten trades carry a prep score — so how you felt becomes a measured edge or leak, not a guess.">Prep — 1 low · 5 high</label>
          <div class="ck-grid">${CHECKIN_FIELDS.map(([k,l])=>`<div class="ck-item"><span class="ck-l">${l}</span><div class="seg" id="djCk_${k}" data-v="${+e[k]||''}" role="radiogroup" aria-label="${l}, 1 low to 5 high">${[1,2,3,4,5].map(n=>`<button type="button" role="radio" aria-checked="${+e[k]===n?'true':'false'}" class="${+e[k]===n?'on':''}" data-n="${n}">${n}</button>`).join('')}</div></div>`).join('')}</div></div>`:''}
        <div class="field"><label>End-of-day review</label><textarea id="djReview" placeholder="What actually happened? What would you repeat or change?">${esc(e.review||'')}</textarea></div>
        <label class="dchk" style="display:inline-flex;margin-bottom:10px"><input type="checkbox" id="djAdh" ${e.adherence?'checked':''}> I followed the plan</label>
        <div><button class="btn ghost" id="djSave">Save day</button> <span id="djSaved" style="color:var(--faint);font-size:11px"></span></div>
      </div>
      <div class="diag-card"><h3 data-tip="Your last journaled days. Trade journaling is graded below; this is the day-level habit that closes the loop between plan and review.">Recent days</h3>
        ${recent.length?recent.map(([rk,d])=>chip(rk,d)).join(''):'<p class="lead">No day entries yet. The plan you write before the session is the one the review can hold you to.</p>'}
      </div>
    </div></div>`;
}
// Session check-in scales, stored on the day entry (1 = low … 5 = high).
const CHECKIN_FIELDS=[['sleep','Sleep'],['stress','Stress'],['focus','Focus']];
// Merge a day-journal save, stamping when each logged thing was first set, so the process score and
// bonus XP can tell "before the first trade" from "wrote it up afterwards" (or a month later, from the
// calendar): `plannedAt` — when a plan (bias / plan / max loss / rules) first existed for the day;
// `limitAt` — when the committed max loss took its current value (tightening it keeps the old stamp:
// a stricter limit can't be used to dodge a breach; loosening or setting it restamps); `checkinAt` —
// when the check-in (sleep / stress / focus) was first filled in. Pure; null = nothing left worth keeping.
function nextDayEntry(prev,e,now){
  const has=['bias','plan','review','maxLoss','maxTrades','adherence','sleep','stress','focus','rules','am','eod'].some(k=>e[k]);
  // structured rules count as a plan only when at least one is set
  const on=r=>!!r&&typeof r==='object'&&Object.values(r).some(v=>Array.isArray(v)?v.length:!!v), rulesOn=on(e.rules);
  if(!has)return null;
  const planned=!!(e.bias||e.plan||e.maxLoss>0||rulesOn);
  const out={...e,updatedAt:now}; delete out.plannedAt; delete out.limitAt; delete out.checkinAt;
  // a field that was already there keeps its stamp; one saved before the stamps existed stays unstamped
  // (processDays gives those the benefit of the doubt, as it always did), so re-saving an old entry
  // never costs it credit, while anything newly set is stamped now
  const keep=(had,f)=>had?(prev[f]>0?prev[f]:undefined):now, set=(f,v)=>{ if(v!==undefined)out[f]=v; };
  if(planned)set('plannedAt',keep(!!(prev&&(prev.bias||prev.plan||prev.maxLoss>0||on(prev.rules))),'plannedAt'));
  if(e.maxLoss>0)set('limitAt',keep(!!(prev&&prev.maxLoss>0&&e.maxLoss<=prev.maxLoss),'limitAt'));
  if(e.sleep||e.stress||e.focus)set('checkinAt',keep(!!(prev&&(prev.sleep||prev.stress||prev.focus)),'checkinAt'));
  return out;
}
function wireDayJournal(){
  const b=$('djSave'); if(!b)return;
  // Autosave: the text after a pause in typing; the committed max loss only once the field is left (a
  // half-typed "1" of "150" would arm a $1 tripwire and restamp limitAt); ticks and the check-in at once.
  // A pause that would empty a filed plan waits for the field to be left too: retyping a plan from
  // scratch mustn't cost its plannedAt stamp.
  const card=b.closest('.diag-card');
  card.addEventListener('input',e=>{ if(e.target.matches('#djBias,#djPlan,#djReview'))jSoon('day',()=>saveDay(true)); });
  card.addEventListener('change',e=>{ if(e.target.matches('#djBias,#djPlan,#djReview,#djMaxLoss,#djAdh')){ jCancel('day'); saveDay(); } });
  // check-in segments: click to pick, click again to clear
  document.querySelectorAll('.seg[id^="djCk_"]').forEach(g=>g.querySelectorAll('button').forEach(b=>b.onclick=()=>{
    const v=g.dataset.v===b.dataset.n?'':b.dataset.n; g.dataset.v=v;
    g.querySelectorAll('button').forEach(x=>{ const on=x.dataset.n===v; x.classList.toggle('on',on); x.setAttribute('aria-checked',on?'true':'false'); });
    jCancel('day'); saveDay(); }));
  const tb=$('djToday'); if(tb)tb.onclick=()=>{ _dayJEditKey=null; _dayJEditSetOn=null; renderReview(); };
  b.onclick=()=>{ jCancel('day'); saveDay(false,true); };
}
function saveDay(typing,btn){
  if(!$('djSave'))return;
  const k=_dayJEditKey||dayJKey(Date.now());
  const prevE=journal[k]||{};
  const num=typing?(prevE.maxLoss||NaN):parseFloat($('djMaxLoss').value);
  const e={bias:$('djBias').value.trim(), plan:$('djPlan').value.trim(),
    maxLoss:num>0?num:null, review:$('djReview').value.trim(),
    adherence:$('djAdh').checked||null,
    maxTrades:prevE.maxTrades||null, // Pulse's trade cap for the day — not edited here, so kept
    rules:prevE.rules||null, am:prevE.am||null, eod:prevE.eod||null}; // likewise Pulse's plan rules, morning answers and evening review
  for(const [f] of CHECKIN_FIELDS){ const el=$('djCk_'+f);
    if(!el){ e[f]=prevE[f]||null; continue; } // check-in hidden (coach mode off): keep what's stored
    const v=parseInt(el.dataset.v); e[f]=v>=1&&v<=5?v:null; }
  const was=journal[k], planned=x=>!!(x&&(x.bias||x.plan||x.maxLoss>0||x.rules&&Object.values(x.rules).some(v=>Array.isArray(v)?v.length:!!v)));
  if(typing&&planned(was)&&!planned(e))return;
  const nx=nextDayEntry(was,e,Date.now()), same=x=>x&&JSON.stringify({...x,updatedAt:0});
  if(btn||same(nx)!==same(was)){ // an autosave with nothing new writes nothing
    if(!nx) delete journal[k]; else journal[k]=nx;
    markJEdit(k); Store.set(J_KEY,journal);
    renderTripwire(); // a committed max loss takes effect immediately
    const s=$('djSaved'); if(s){ s.textContent='saved'; clearTimeout(s._t); s._t=setTimeout(()=>{ s.textContent=''; },1400); } }
  if(!typing&&e.maxLoss>0)askNotifyPerm(); // committed max loss + a gesture — offer desktop notifications
}
/* ============================ Project tab ============================ */
let _proj={look:90,hor:182,block:0}; let _projChart=null;
const PROJ_LOOKS=[[30,'Last 30 days'],[60,'Last 60 days'],[90,'Last 90 days'],[180,'Last 180 days'],[365,'Last year'],[0,'All history']];
const PROJ_HORS=[[30,'1 month'],[91,'3 months'],[182,'6 months'],[365,'1 year'],[730,'2 years']];
const PROJ_BLOCKS=[[0,'resample: i.i.d. daily'],[5,'resample: 5-day blocks'],[7,'resample: 7-day blocks']];
function renderProjection(){
  const el=$('projView'); if(!el)return;
  if(_projChart){ _projChart.destroy(); _projChart=null; }
  const closed=closedTrades(viewFilter), rowsAll=allTrades.filter(viewFilter); // projBaseline sums money rows and counts trade rows itself
  if(closed.length<5){ el.innerHTML='<div class="diag-section"><p class="lead">Need at least 5 closed trades in this view to project forward. Load more history first.</p></div>'+nfSizerHtml(); nfWireSizer(); return; }
  let base=projBaseline(rowsAll,_proj.look), look=_proj.look;
  if((!base||base.trades<5)&&_proj.look>0){ base=projBaseline(rowsAll,0); look=0; } // fall back to all history if the window is too thin
  if(!base){ el.innerHTML='<div class="diag-section"><p class="lead">No closed trades inside the selected lookback window.</p></div>'+nfSizerHtml(); nfWireSizer(); return; } // the pre-trade sizer needs no history — keep it available
  const now=Date.now(), startBal=closedMoney(viewFilter).reduce((s,t)=>s+t.net,0);
  // the Diagnostic headline's test on the basis trades: until it passes, every number here is "if"
  const bt=look>0?closed.filter(t=>t.closeTime>=now-look*86400000&&t.closeTime<=now):closed;
  const proven=bt.length>=5&&_tradesMemo('projEdge',bt,settings.tz+'|'+settings.tzZone,()=>edgeTest(bt)).proven;
  const ifNote=proven?'':'<p class="mini-note"><b>If your average day holds — not yet a proven edge.</b> Over this basis the Diagnostic\u2019s test (Sharpe or expectancy 95% CI above 0) doesn\u2019t pass, so these paths assume an edge your trades haven\u2019t shown yet.</p>';
  const fc=projectForward(base.daily,_proj.hor,400,null,_proj.block);
  const medPerDay=fc.end.p50/_proj.hor;
  const horLabel=(PROJ_HORS.find(h=>h[0]===_proj.hor)||[0,_proj.hor+' days'])[1];
  const mrow=(l,v,tip)=>`<div class="metric-row"${tip?` data-tip="${esc(tip)}"`:''}><span class="ml">${l}</span><span class="mv">${v}</span></div>`;
  const usd=v=>'<span class="'+cls(v)+'">'+fmtUsd(v)+'</span>';
  const sel=(id,opts,cur)=>`<select id="${id}">`+opts.map(o=>`<option value="${o[0]}"${o[0]===cur?' selected':''}>${o[1]}</option>`).join('')+'</select>';
  // milestones off the median simulated pace
  const targets=projMilestones(startBal,4);
  const msRows=medPerDay>0? targets.map(tg=>{ const days=Math.ceil((tg-startBal)/medPerDay);
      const dt=new Date(now+days*86400000), p=tzParts(dt.getTime());
      return mrow(fmtUsd(tg).replace('.00',''),`${fmtUsd(tg-startBal).replace('.00','')} away · ~${days<45?days+' days':Math.round(days/30.44)+' months'} · ${MONTHS[p.mo]} ${p.y}`,'At your median simulated pace of '+fmtUsd(medPerDay)+'/day.');
    }).join('')
    : '<p class="lead">Median simulated pace is not positive over this lookback, so milestone dates are unavailable. Pick a stronger stretch — or go make one.</p>';
  el.innerHTML=`
   <div class="diag-section"><h2>Projection <span>· if you kept trading exactly like this</span></h2>
    <p class="lead">A visualization, not a forecast: this just replays your recent daily results forward a few hundred times and shows where the paths land. Markets owe nobody their past distribution — but it is a fine way to see what staying the course could look like.</p>
    <div class="filters" style="margin-bottom:14px">
      ${sel('projLook',PROJ_LOOKS,_proj.look)}
      ${sel('projHor',PROJ_HORS,_proj.hor)}
      <span data-tip="How future days are drawn from your history. i.i.d. picks days independently, which destroys streakiness; block sampling draws contiguous ${_proj.block||5}-day runs, preserving your hot/cold streaks — bands usually widen, which is the more honest picture.">${sel('projBlock',PROJ_BLOCKS,_proj.block)}</span>
      <span class="count">basis: ${base.trades} trades over ${base.calDays} days (${base.activeDays} active)</span>
    </div>
    <div class="diag-grid">
      <div class="diag-card"><h3>Your current pace</h3>
        ${mrow('Avg per calendar day',usd(base.perDay),'Lookback net divided by all calendar days, flat days included.')}
        ${mrow('Trades / week',base.tradesPerWeek.toFixed(1))}
        ${mrow('Win rate',base.winRate==null?'—':(base.winRate*100).toFixed(0)+'%','Scratches inside the break-even band excluded.')}
        ${mrow('Expectancy / trade',usd(base.expectancy))}
        ${mrow('Lookback net',usd(base.total))}
      </div>
      <div class="diag-card"><h3>If you keep this up</h3>
        ${mrow('Per week',usd(base.perDay*7))}
        ${mrow('Per month',usd(base.perDay*30.44))}
        ${mrow('Per year',usd(base.perDay*365.25))}
        <p class="mini-note">Straight-line extrapolation of your average day${proven?'':', which isn\u2019t yet distinguishable from noise'}. The chart below adds the uncertainty.</p>
      </div>
      <div class="diag-card"><h3>${esc(horLabel)} out — simulated</h3>
        ${mrow('Median path',usd(fc.end.p50))}
        ${mrow('Good stretch (75th)',usd(fc.end.p75))}
        ${mrow('Hot streak (95th)',usd(fc.end.p95))}
        ${mrow('Rough stretch (25th)',usd(fc.end.p25))}
        ${mrow('Simulated paths ending green',(fc.probPositive*100).toFixed(0)+'%','Share of the 400 replayed paths that end above zero. Not a probability you finish green: every path assumes your past days keep coming.')}
        ${ifNote}
      </div>
      <div class="diag-card"><h3 data-tip="The honest companion to the fan chart: the worst peak-to-trough dip INSIDE each simulated path over this horizon, not just where paths end. Same ${_proj.block>1?'block-':''}bootstrapped paths as the chart below.">Drawdown reality-check</h3>
        ${mrow('Median max drawdown','<span class="'+cls(-fc.dd.p50)+'">'+fmtUsd(-fc.dd.p50)+'</span>','Half of the simulated futures dip at least this far below a prior peak at some point over the horizon.')}
        ${mrow('1 path in 4 dips','<span class="'+cls(-fc.dd.p75)+'">'+fmtUsd(-fc.dd.p75)+'</span> or worse','75th percentile of per-path max drawdown.')}
        ${mrow('1 path in 20 dips','<span class="'+cls(-fc.dd.p95)+'">'+fmtUsd(-fc.dd.p95)+'</span> or worse','95th percentile — the rough stretch you should be sized to sit through without breaking rules.')}
        <p class="mini-note">At this pace, expect a dip like the median at some point. If the 1-in-4 number would force you to stop trading or cut size, you are oversized now — decide the response before it happens.</p>
      </div>
      <div class="diag-card"><h3 data-tip="Kelly sizing from the same trades the projection is built on: win rate and payoff ratio give the growth-optimal risk fraction. Full-Kelly assumes the edge is stable and exactly known (it isn't) and is famously violent; quarter-Kelly is the calmer default. In-sample guidance, not a guarantee.">Sizing at this edge</h3>
        ${(function(){ const kel=kellyFromTrades(closed);
          if(!kel)return '<p class="lead">Needs \u226510 decisive trades (outside the break-even band) in this view.</p>';
          const acct2=(accountValue||0)+(spotAccountValue||0);
          const pctv=x=>(x*100).toFixed(1)+'%';
          const dollar=x=>acct2>0?' \u00b7 '+fmtUsd(acct2*x):'';
          const chron=[...closed].sort((a,b)=>a.closeTime-b.closeTime).map(t=>t.net);
          const acf1=_autocorr1(chron);
          const hc=kellyHaircut(kel.quarter,acf1);
          const streaky=acf1!=null&&acf1>0.15&&kel.quarter!=null&&kel.quarter>0;
          const streakRow=streaky
            ? mrow('Streak-adjusted (suggested)',pctv(hc.adjusted)+dollar(hc.adjusted)+` <span style="color:var(--faint)">\u00b7 \u00d7${hc.factor.toFixed(2)} for +${acf1.toFixed(2)} autocorr</span>`,'Your trade results are positively autocorrelated \u2014 streaks are real, so effective variance is higher than Kelly\u2019s independent-bet assumption and full/quarter-Kelly overstate the safe size. This shrinks quarter-Kelly by (1\u2212autocorrelation), floored at \u00d70.4. Lean on this over plain quarter-Kelly while the clustering persists.')
            : '';
          const note=streaky
            ? `Pairs with the pace cards. Your results cluster (autocorrelation ${acf1.toFixed(2)}), so the streak-adjusted line is the one to trust \u2014 plain Kelly assumes independent bets. Edges drift; re-check as the sample grows.`
            : 'Pairs with the pace cards: this is how large you can rationally bet <i>if</i> you keep trading exactly like this. Edges drift; re-check as the sample grows.';
          return mrow('Win rate \u00b7 payoff',(kel.p*100).toFixed(0)+'% \u00b7 '+(kel.b===Infinity?'\u221e':kel.b.toFixed(2)),'Decisive win rate and average win \u00f7 average loss over the projection basis trades.')
            + mrow('Full-Kelly risk / trade',kel.kelly!=null?(kel.kelly<=0?'0% \u2014 no positive edge':pctv(kel.kelly)+dollar(kel.kelly)):'\u2014','Growth-optimal fraction of account to risk per trade at this edge. A ceiling, not a target.')
            + mrow('Quarter-Kelly (suggested)',kel.quarter!=null?(kel.quarter<=0?'\u2014':pctv(kel.quarter)+dollar(kel.quarter)):'\u2014','A quarter of Kelly keeps most of the growth with a fraction of the drawdown pain \u2014 the usual practitioner default.')
            + streakRow
            + '<p class="mini-note">'+note+'</p>';
        })()}
      </div>
      <div class="diag-card"><h3>Milestones <span style="color:var(--faint)">from ${esc(fmtUsd(startBal))} realized</span></h3>
        ${msRows}${medPerDay>0?ifNote:''}
      </div>
    </div>
   </div>
   <div class="diag-section"><h2>Possible paths <span>· cumulative PnL from today</span></h2>
    <div class="card"><div class="chart-box" style="height:300px"><canvas id="projChart"></canvas></div>
    <p class="mini-note">Solid line = median of 400 ${_proj.block>1?'block-bootstrap ('+_proj.block+'-day blocks, streaks preserved)':'bootstrap'} simulations; inner band = middle 50% of paths; outer band = middle 90%. Deterministic for a given data selection.</p></div>
   </div>`;
  $('projLook').onchange=e=>{ _proj.look=+e.target.value; renderProjection(); };
  $('projHor').onchange=e=>{ _proj.hor=+e.target.value; renderProjection(); };
  $('projBlock').onchange=e=>{ _proj.block=+e.target.value; renderProjection(); };
  const start=tzMidnight(now), labels=[];
  for(let d=1; d<=_proj.hor; d++){ const p=tzParts(addDays(start,d)); labels.push(MONTHS[p.mo]+' '+p.day+(_proj.hor>200?' \u2019'+String(p.y).slice(2):'')); }
  const G=themeGreen(), GR=[1,3,5].map(i=>parseInt(G.slice(i,i+2),16)).join(',');
  const band=(data,bg,bw)=>({data,borderColor:'rgba('+GR+','+bw+')',borderWidth:1,pointRadius:0,fill:false,tension:.1});
  const ds=[
    Object.assign(band(fc.bands.p95,0,.30),{label:'95th'}),
    Object.assign(band(fc.bands.p05,0,.30),{label:'5th',fill:'-1',backgroundColor:tint(G,.06)}),
    Object.assign(band(fc.bands.p75,0,0),{label:'75th',borderColor:tint(G,0)}),
    Object.assign(band(fc.bands.p25,0,0),{label:'25th',borderColor:tint(G,0),fill:'-1',backgroundColor:tint(G,.14)}),
    {label:'median',data:fc.bands.p50,borderColor:G,borderWidth:2,pointRadius:0,fill:false,tension:.1}
  ];
  _projChart=new Chart($('projChart'),{type:'line',data:{labels,datasets:ds},
    options:{responsive:true,maintainAspectRatio:false,interaction:{intersect:false,mode:'index'},
      plugins:{legend:{display:false},tooltip:{callbacks:{label:c=>' '+({'95th':'Best 5% of paths','5th':'Worst 5% of paths','75th':'Better quarter','25th':'Worse quarter',median:'Middle path'}[c.dataset.label]||c.dataset.label)+': '+fmtUsd(c.parsed.y)}}},
      scales:scales()}});
  explain(_projChart,'400 simulated futures built from your own past days. Half the paths end inside the darker band, 90% inside the lighter one.');
  el.insertAdjacentHTML('beforeend', nfSizerHtml()); nfWireSizer();
}
// Persistent data-health strip: partial or failing data sources, visible until resolved.
// Status-bar warnings get overwritten within seconds; incomplete funding or capital data
// silently skews net PnL and return-on-capital, which deserves a standing flag.
function renderDataHealth(){
  const el=$('dataHealth'); if(!el)return;
  const items=[];
  if(Array.isArray(fillsTruncated)&&fillsTruncated.length)
    items.push('fill history truncated for '+fillsTruncated.map(esc).join(', ')+' (Shift-click Load all for a full refetch)');
  if(_fetchHealth.funding)items.push('funding history partial — net PnL may be missing funding for this load');
  if(_fetchHealth.twap)items.push('TWAP fill history partial — TWAP-executed trades may be missing for this load');
  // seams: position changes with no fill behind them — fills the exchange no longer serves. Said once,
  // with where they fall and what it means, because no refetch can close them
  const cov=dataCoverage;
  if(cov&&cov.gaps){
    const MON=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const when=Object.entries(cov.months||{}).sort((a,b)=>b[1]-a[1]).slice(0,3).map(([k])=>MON[+k.slice(5,7)-1]+' '+k.slice(0,4));
    items.push('<span data-tip="Hyperliquid keeps TWAP slice fills for about three months and older fills for a finite time. A perp fill that starts from a position no earlier fill reaches proves fills are missing in between. Their P&L can’t be rebuilt and no refetch brings them back; from now on every load caches what is still served. See Help → Data health.">fills missing'+(cov.wallets&&cov.wallets.length?' for '+cov.wallets.map(esc).join(', '):'')+': '+cov.gaps+' position change'+(cov.gaps===1?'':'s')+(when.length?' (mostly '+when.join(', ')+')':'')+
      (cov.perpShare!=null?' · '+Math.round(cov.perpShare*100)+'% of perp volume has fills':'')+' · '+cov.offRecord+' trade'+(cov.offRecord===1?'':'s')+' with an unknown result kept out of the stats</span>');
  }
  if(_fetchHealth.ledger)items.push('capital-flow history partial — return-on-capital may be incomplete');
  if(_idbWarned)items.push('browser storage is failing — caches may not persist; export a backup');
  const orph=allTrades.filter(t=>t.orphan);
  if(orph.length)items.push(orph.length+' position'+(orph.length===1?'':'s')+' the exchange no longer holds but whose closing fill isn’t in your history ('+orph.slice(0,4).map(t=>esc(dispMarket(dcoin(t))+' '+(t.dir||'').toLowerCase()+' from '+new Date(t.openTime).toISOString().slice(0,10))).join(', ')+(orph.length>4?'…':'')+') — likely a liquidation or a gap; kept out of your stats. Shift-click Load all for a full refetch');
  // a server to recover from: the archive panel (check, sample, backfill, the index) stays reachable
  // here whether or not there is anything to warn about — once the seams are closed, the strip is the
  // one place that says so, and the panel is still how the index and other wallets are looked after
  const canArc=srvOwner(); // the owner's token session only: the archive spends their AWS budget
  const arcBtn=canArc?' <button class="df-btn" id="arcOpen" style="margin-left:6px">'+(cov&&cov.gaps?'Recover from the archive…':'Archive…')+'</button>':'';
  if(!items.length&&!canArc){ el.classList.add('hide'); el.innerHTML=''; delete el.dataset.ok; return; }
  el.classList.remove('hide');
  if(!items.length){ el.dataset.ok='1';
    el.innerHTML='✓ <b>Data health:</b> every position change has its fill'+(cov&&cov.perpShare!=null?' · '+Math.round(cov.perpShare*100)+'% of perp volume has fills':'')+arcBtn; }
  else { delete el.dataset.ok; el.innerHTML='⚠ <b>Data health:</b> '+items.join(' · ')+arcBtn; }
  const b=$('arcOpen'); if(b)b.onclick=()=>toggleArchivePanel($('dataHealth'));
}
// Recovering the fills behind the seams from Hyperliquid's node-data archive on S3, through the server
// (archive.js): a coverage check (what the archive holds, what the seams need, what it would cost), a
// sample hour, then the backfill with a spending cap. The server merges what it finds into its fill
// cache; the next load merges that into this browser's (data-io.js: srvArchived) and reconstructs.
let _arcTimer=null;
// Opened from the Data health strip (seams on record) or from the server-sync bar (always there, so a
// check, a diagnose or a running backfill stays reachable once the seams are gone); anchored below either.
async function toggleArchivePanel(anchor){
  let p=$('arcPanel'); if(p){ p.remove(); clearTimeout(_arcTimer); return; }
  if(!srvOwner())return;
  const host=(anchor&&anchor.nodeType===1?anchor:null)||$('dataHealth'); if(!host)return;
  p=document.createElement('div'); p.id='arcPanel'; p.className='reconwarn'; p.style.cssText='margin-top:-6px;margin-bottom:12px';
  host.insertAdjacentElement('afterend',p);
  const usd=n=>'$'+(+n||0).toFixed(2), mb=b=>(b/1048576).toFixed(1)+' MB', gbOf=b=>(b/1073741824).toFixed(2)+' GB';
  const hl=settings.wallets.filter(w=>venueOf(w)==='hyperliquid');
  const call=async(path,body)=>{ const r=await srvFetch('/api/v1/archive'+path,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:undefined); const j=await r.json().catch(()=>({})); if(!r.ok)throw Object.assign(new Error(j.error||('HTTP '+r.status)),{plan:j.plan}); return j; };
  const out=msg=>{ const o=$('arcOut'); if(o)o.innerHTML=msg; };
  // the archive plans from the server's copy of the fills; a server that never refreshed a wallet has a
  // thin one or none, so this browser's cache goes up first (merged there, a few thousand fills a request)
  const sync=async()=>{ let note=[];
    for(const w of hl){ const a=w.address.toLowerCase(); let local=null; try{ local=await unpackFillCache(await idbGet('flc:'+a)); }catch(e){}
      if(!local||!local.fills||!local.fills.length)continue;
      let srvCount=-1; try{ const m=await srvFetch('/api/v1/cache/'+a+'?meta=1'); if(m.ok)srvCount=((await m.json()).fills||{}).count||0; }catch(e){}
      if(srvCount>=local.fills.length)continue;
      out(`Sending ${esc(labelFor(w))}’s ${local.fills.length} fills to the server…`);
      let added=0; for(let i=0;i<local.fills.length;i+=4000){ const r=await srvFetch('/api/v1/cache/'+a,{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({fills:local.fills.slice(i,i+4000),twapFull:!!local.twapFull})});
        if(!r.ok){ const j=await r.json().catch(()=>({})); throw new Error('sending fills to the server: '+(j.error||('HTTP '+r.status))); } added+=((await r.json()).added||0); }
      note.push(`${labelFor(w)}: ${added} fills sent`); }
    return note; };
  const draw=st=>{ const j=st.job, lc=st.lastCheck;
    p.innerHTML=`<b>Hyperliquid’s archive</b> — ${st.configured?`bucket ${esc(st.bucket)}${st.region?' ('+esc(st.region)+')':''}, $${st.costPerGB}/GB billed to your AWS account`:'not set up: add <code>ARCHIVE_AWS_KEY_ID</code> and <code>ARCHIVE_AWS_SECRET</code> to the server (Railway → Variables) and redeploy'}.
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;margin:8px 0">
        <button class="df-btn" id="arcCheck" ${st.configured?'':'disabled'}>Check coverage</button><button class="df-btn" id="arcDiag" ${st.configured?'':'disabled'}>Diagnose</button><button class="df-btn" id="arcSample" ${st.configured?'':'disabled'}>Fetch a sample hour</button>
        <select id="arcWallet">${hl.map(w=>`<option value="${esc(w.address)}">${esc(labelFor(w))}</option>`).join('')}</select>
        <select id="arcScope" data-tip="Exits: only the seams on trades whose closing fills are missing — the ones that carry P&L. Everything: also the seams where a position opened off the record, which cost only the entry price and many more hours."><option value="exits">exits only (P&amp;L)</option><option value="all">everything (entries too)</option></select>
        <label>cap <input id="arcGB" type="number" min="0.01" step="5" value="75" style="width:64px"> GB</label>
        <button class="df-btn" id="arcGo" ${st.configured?'':'disabled'}>Backfill</button>${j&&j.state==='running'?'<button class="df-btn" id="arcStop">Stop</button>':''}<button class="df-btn" id="arcClose">Close</button></div>
      <div id="arcOut" style="font-size:12.5px;line-height:1.5">${j?esc(`Backfill ${j.address.slice(0,8)}…${j.source==='index'?' from the index':''}: ${j.state} · ${j.done}/${j.total} ${j.source==='index'?'days':'hours'} · ${j.fills} fills found${j.added!=null?' · '+j.added+' new in the cache':''} · ${mb(j.bytes)}${j.cost!=null&&j.source!=='index'?' ≈ $'+j.cost:''}${j.lastError?' · last error: '+j.lastError:''}`):lc?esc(`Last check: archive ${lc.archive.first||'—'} → ${lc.archive.last||'—'} (${lc.archive.days?lc.archive.days.length+' days':'probed'})`):''}</div>`;
    $('arcClose').onclick=toggleArchivePanel;
    $('arcCheck').onclick=async()=>{ out('Listing the archive…'); try{ const synced=await sync(); const c=await call('/check',{scope:$('arcScope').value});
      const a=c.archive, sd=c.sampleDay;
      const ix=c.index?(c.index.error?`Index: ${esc(c.index.error)}<br>`:`Index by wallet: <b>${c.index.days.length} days</b> ${esc(c.index.first||'')} → ${esc(c.index.last||'')}${c.index.progress&&c.index.progress.lastSummary?' · last day '+esc(c.index.progress.lastDay)+' ('+c.index.progress.lastSummary.fills.toLocaleString('en-US')+' fills)':''} — Backfill reads the whole history from it.<br>`):'';
      out((synced.length?esc(synced.join(' · '))+'<br>':'')+ix+`Archive: <b>${esc(a.first||'nothing')}</b> → ${esc(a.last||'')} (${a.days?a.days.length+' days':'probed'})${sd?`; ${sd.day} has ${sd.hours} hours, ${mb(sd.bytes)} (${mb(sd.perHour)}/hour)`:''}.<br>`+
        c.wallets.map(w=>w.error?`${esc(w.address.slice(0,8))}…: ${esc(w.error)}`:`${esc(w.address.slice(0,8))}…: ${w.seams} ${w.scope==='all'?'seams':'exit seams'} → ${w.hours} hours; the archive has ${w.hours-w.missing.length} of them${w.fromOld?' ('+w.fromOld+' from the older dataset)':''}, ${gbOf(w.bytes)} ≈ ${usd(w.estCost)}${w.missing.length?` — ${w.missing.length} hour${w.missing.length===1?'':'s'} fall outside the archive (${esc(w.missing[0])}…)`:''}${w.skippedLong.length?`; ${w.skippedLong.length} seam${w.skippedLong.length===1?'':'s'} wider than ${c.maxWindowDays||14} days skipped`:''}`).join('<br>')); }
      catch(e){ out('Check failed: '+esc(e.message)); } };
    $('arcDiag').onclick=async()=>{ out('Asking AWS…'); try{ const d=await call('/diagnose',{});
      const one=s=>s.error?('no answer — '+s.error):s.arn?(s.arn+' (account '+s.account+')'):s.ok===true&&s.key?('ok · '+s.key+(s.size?' · '+s.size+' bytes':'')):s.ok===false&&s.tried?('not there (tried '+s.tried.join(', ')+')'):(s.status+(s.code?' '+s.code:'')+(s.message?' — '+s.message:'')+(s.bucketRegion?' · region '+s.bucketRegion:'')+(s.size?' · '+s.size+' bytes':'')+(s.prefixes&&s.prefixes.length?' · '+s.prefixes.join(' '):'')+(s.keys&&s.keys.length?' · '+s.keys.join(' '):''));
      const line=(k,s)=>!s||typeof s!=='object'?`<b>${esc(k)}</b>: ${esc(String(s))}`:('status' in s||'arn' in s||'error' in s||'ok' in s)?`<b>${esc(k)}</b>: ${esc(one(s))}`:Object.entries(s).map(([k2,s2])=>`<b>${esc(k)} ${esc(k2)}</b>: ${esc(one(s2))}`).join('<br>');
      out(`<b>Verdict:</b> ${esc(d.verdict)}<br>key ${esc(d.keyId)} · bucket ${esc(d.bucket)} · region ${esc(d.regionSetting)}<br>`+Object.entries(d.steps).map(([k,s])=>line(k,s)).join('<br>')); }
      catch(e){ out('Diagnose failed: '+esc(e.message)); } };
    $('arcSample').onclick=async()=>{ const k=prompt('Which hour? Leave empty for the newest hour of the archive, or paste a file path such as node_fills/hourly/20250601/12 or node_fills_by_block/hourly/20260101/5.lz4',''); if(k===null)return; out('Downloading one hour…'); try{ const s=await call('/sample',k&&k.trim()?{key:k.trim()}:{});
      const w=Object.entries(s.wallets||{}).map(([a,x])=>`${esc(a.slice(0,8))}…: ${x.fills} fills`).join(', ');
      out(`${esc(s.key)}: ${mb(s.bytes)} ${esc(s.encoding)}, ${s.lines} lines, ${s.fillsSeen} fills in it (${esc(JSON.stringify(s.shapes))})${w?'; '+w:''}.<pre style="white-space:pre-wrap;max-height:160px;overflow:auto;font-size:11px">${esc(s.preview)}</pre>`); }
      catch(e){ out('Sample failed: '+esc(e.message)); } };
    $('arcGo').onclick=async()=>{ const address=$('arcWallet').value, maxGB=parseFloat($('arcGB').value)||75;
      out('Planning…'); try{ await sync(); const j=await call('/backfill',{address,maxGB,scope:$('arcScope').value}); out(j.source==='index'?'Started: reading the wallet’s shard from the index, every day it has.':`Started: ${j.total} hours, ${gbOf(j.plan.bytes)} ≈ ${usd(j.plan.estCost)}.${j.indexSkipped?' (Index skipped: '+j.indexSkipped+')':''}`); poll(); }
      catch(e){ out('Not started: '+esc(e.message)); } };
    const sb=$('arcStop'); if(sb)sb.onclick=async()=>{ try{ await call('/stop',{}); }catch(e){} poll(); };
  };
  const poll=async()=>{ clearTimeout(_arcTimer); try{ const st=await call(''); draw(st);
      if(st.job&&st.job.state==='running')_arcTimer=setTimeout(poll,3000);
      else if(st.job&&st.job.state==='done'&&!st.job.applied){ st.job.applied=true; if(st.job.added){ out(`Done: ${st.job.added} fills recovered — loading them…`); loadAll(); } } }
    catch(e){ p.innerHTML='<b>Hyperliquid’s archive</b> — '+esc(e.message)+' <button class="df-btn" id="arcClose">Close</button>'; $('arcClose').onclick=toggleArchivePanel; } };
  poll();
}
// The Net PnL card's all-time headline (engine.js: verifiedFigure), only when nothing narrows the
// stats cards: all time (no period, no custom range) with every dex in view. A 30-day period, a
// date range or a dex filter shows the fill-based figure for that window, as every other card does.
function verifiedHeadline(){
  if(period||rangeActive()||dexView!=='all')return null;
  return verifiedFigure(view);
}
function renderReconcile(){
  renderDataHealth();
  const el=$('reconcile');
  const all=hlPnl.all, perp=hlPnl.perp, spot=(all!=null&&perp!=null)?all-perp:null;
  // all-time reconstructed sums (incl. open positions' realized) for apples-to-apples deltas
  const hlOnly=allTrades.filter(t=>!candleVenue(t)&&moneyRow(t)&&!(t.orphan||(t.offRecord&&!t.isOpen))); // Hyperliquid's figure covers Hyperliquid wallets only; money rows, so spot is counted once
  const recPerp=hlOnly.filter(t=>t.market==='perp').reduce((s,t)=>s+t.net,0);
  const recSpot=hlOnly.filter(t=>t.market==='spot').reduce((s,t)=>s+t.net,0);
  const recAll=recPerp+recSpot;
  // the exchange's figure is account-based, unrealized included: the open positions' marks go in the
  // fills' side too (as verifiedFigure does), or a large open position reads as a gap of its own
  const uPerp=openPositions.filter(p=>!p.venue||p.venue==='hyperliquid').reduce((s,p)=>s+(p.uPnl||0),0);
  const recLive=recPerp+uPerp;
  // integrity banner: perp reconstruction vs Hyperliquid's verified figure, on EVERY tab.
  // Perp-only on purpose: spot gaps are expected (unknown cost basis on transfers/airdrops).
  const wEl=$('reconWarn');
  if(wEl){
    // Only alarm on a genuinely material gap. Small perp reconstruction differences are
    // routine (funding attribution timing, fills near the pagination boundary) and are
    // already shown quietly by the per-line "recon" tag — the banner is reserved for the
    // case where enough trades are missing/mis-attributed to actually distort analytics.
    // one plain sentence, no figures (engine.js: historyNote); seams are the data-health strip's to say,
    // and the deltas themselves are in the reconciliation panel below
    const note=typeof historyNote==='function'?historyNote():null;
    if(note&&note.kind!=='seams'){ wEl.classList.remove('hide'); wEl.innerHTML=(note.kind==='gap'||note.kind==='older+'?'<b>\u26a0 Reconstruction check:</b> ':'<b>\u24d8 Older history:</b> ')+esc(note.text)
      +(dataAudit?' <button class="df-btn" id="auditOpen" style="margin-left:6px" data-tip="Your fills and funding against Hyperliquid’s own perp curve: where the difference opened, the recent day / week / month side by side, and the funding check.">Audit…</button>':'');
      const ab=$('auditOpen'); if(ab)ab.onclick=toggleAuditPanel; }
    else wEl.classList.add('hide');
  }
  if(activeTab==='diag' || (hlPnl.all==null && hlPnl.perp==null)){ el.classList.add('hide'); return; }
  const delta=(hl,rec)=>{ if(hl==null)return ''; const d=rec-hl; const mat=Math.abs(d)>Math.max(50,Math.abs(hl)*0.01);
    return `<span style="font-size:10.5px;color:${mat?'var(--gold)':'var(--faint)'}" data-tip="Reconstructed-from-fills total minus Hyperliquid's figure. Small gaps are normal for spot (cost basis on transferred/airdropped tokens can't be rebuilt from fills). A large gap means some trades' PnL isn't captured — trust the Verified number.">recon ${d>=0?'+':''}${fmtUsd(d)}</span>`; };
  const item=(k,v,d)=>`<div class="ritem"><span class="rk">${k}</span><span class="rv ${v!=null?cls(v):''}">${v!=null?fmtUsd(v):'—'}</span>${d||''}</div>`;
  el.classList.remove('hide');
  el.innerHTML=`<span class="rlab" data-tip="Hyperliquid's own account P&L figures, as its app reports them — always all time, whatever period or filter is picked above. “recon” is how far the fill-based sum is from each; a large gap means fills are missing, and the verified number is the one to trust. Drawdown lives in Stats / Diagnostic.">Verified · Hyperliquid all-time · doesn’t follow the period</span>`+
    item('Total PnL',all,delta(all,recAll))+item('Perps',perp,delta(perp,recLive))+item('Spot + vaults',spot,delta(spot,recSpot))+
    (hlPnl.partial?`<span class="ritem" style="color:var(--gold)" data-tip="Hyperliquid didn’t answer the portfolio request for at least one wallet this load, so these sums cover only the wallets it did. Load all again.">⚠ a wallet is missing from these</span>`:'')+
    (dataAudit?`<button class="linkish" id="auditOpen2" data-tip="Where the fills and Hyperliquid’s perp figure part ways: its own P&L curve set against your fills and funding at each of its points, the recent day / week / month side by side, and the funding check.">Audit</button>`:'');
  const a2=$('auditOpen2'); if(a2)a2.onclick=toggleAuditPanel;
  if($('auditPanel'))renderAuditPanel();
}
// The perp P&L audit (engine.js: pnlAudit), per wallet: what the fills add up to and from what, the
// funding check, the account's record before its first fill, the recent windows side by side, and the
// dates where the gap to Hyperliquid's own curve moved.
function toggleAuditPanel(){
  const p=$('auditPanel'); if(p){ p.remove(); return; }
  const host=$('reconcile'); if(!host)return;
  const el=document.createElement('div'); el.id='auditPanel'; el.className='reconwarn'; el.style.cssText='margin-top:-6px;margin-bottom:12px;font-size:12.5px;line-height:1.55';
  host.insertAdjacentElement('afterend',el); renderAuditPanel();
}
function renderAuditPanel(){
  const el=$('auditPanel'); if(!el)return;
  if(!dataAudit){ el.innerHTML='<b>Perp P&amp;L audit</b> — Load all to run it. <button class="df-btn" id="auditClose">Close</button>'; $('auditClose').onclick=toggleAuditPanel; return; }
  const ymd=ms=>new Date(ms).toISOString().slice(0,10), sg=v=>`<span class="${cls(v)}">${v>=0?'+':''}${fmtUsd(v)}</span>`;
  const uOf=a=>openPositions.filter(p=>(!p.venue||p.venue==='hyperliquid')&&p.wallet&&p.wallet.address&&p.wallet.address.toLowerCase()===String(a).toLowerCase()).reduce((s,p)=>s+(p.uPnl||0),0);
  const one=a=>{
    const real=a.closed-a.fees+a.funding, u=uOf(a.address);
    const hl=a.points.length?a.points[a.points.length-1].hl:null, gap=hl!=null?real+u-hl:null;
    const unf=a.funding-a.fundingAttributed;
    const rows=[];
    rows.push(`${a.fills.toLocaleString('en-US')} perp fills${a.first?' from '+ymd(a.first):''}: closed P&amp;L ${fmtUsd(a.closed)} − fees ${fmtUsd(a.fees)} ${a.funding<0?'−':'+'} funding ${fmtUsd(Math.abs(a.funding))} (${a.fundingRows.toLocaleString('en-US')} payments) = <b>${fmtUsd(real)}</b> realized${u?`, ${sg(u)} open`:''}`
      +(hl!=null?` · Hyperliquid: <b>${fmtUsd(hl)}</b> · difference ${sg(gap)}`:''));
    rows.push(Math.abs(unf)<100?`Funding: every payment lands on a trade (${fmtUsd(a.fundingAttributed)} on trades).`
      :`Funding: ${sg(unf)} of the ${fmtUsd(a.funding)} paid lands on no trade’s window, so the trades’ net leaves it out (the line above counts it).`);
    if(a.before)rows.push(`<b>Before the first fill:</b> Hyperliquid’s record starts ${ymd(a.before.start)}, the earliest fill it still serves is ${ymd(a.before.first)}.`
      +(a.before.gap!=null?` At its first point after that (${ymd(a.before.at)}) the fills already stand ${sg(a.before.gap)} from its curve: roughly the P&amp;L made before the first fill, give or take what was still open then.`:'')
      +` That P&amp;L is in its figure and in no fill; neither the exchange nor its archive (from May 2025) still has those fills.`);
    const W=a.windows, wl={day:'24 h',week:'7 days',month:'30 days'};
    const wrows=['day','week','month'].filter(k=>W[k]).map(k=>{ const w=W[k], sh=w.hlVlm>0?Math.round(Math.min(9.99,w.fillsVlm/w.hlVlm)*100)+'%':'—';
      return `<tr><td>${wl[k]}</td><td style="text-align:right">${fmtUsd(w.hlPnl)}</td><td style="text-align:right">${fmtUsd(w.fillsPnl)}</td><td style="text-align:right">${fmtUsd(w.hlVlm,0)}</td><td style="text-align:right">${fmtUsd(w.fillsVlm,0)}</td><td style="text-align:right">${sh}</td></tr>`; }).join('');
    if(wrows)rows.push(`<table style="width:100%;max-width:680px;border-collapse:collapse;margin:4px 0"><tr style="color:var(--muted)"><td>window</td><td style="text-align:right" data-tip="Hyperliquid’s perp P&amp;L over the window, the change in open positions’ unrealized included.">Hyperliquid P&amp;L</td><td style="text-align:right" data-tip="What the fills realized in the window: closed P&amp;L − fees + funding.">fills realized</td><td style="text-align:right">Hyperliquid volume</td><td style="text-align:right">fills volume</td><td style="text-align:right">held</td></tr>${wrows}</table><div style="color:var(--muted);font-size:11.5px">Volume held near 100% means every fill of the window is here. P&amp;L differs by the change in your open positions’ unrealized over the window.</div>`);
    const st=a.steps;
    rows.push(st.length?`<b>Where the difference moved</b> (the fills minus Hyperliquid’s curve, between two of its points; a move that comes back later is an open position’s unrealized, one that stays is P&amp;L the fills don’t hold):`
      +`<div style="max-height:320px;overflow:auto;max-width:540px"><table style="width:100%;border-collapse:collapse;margin:4px 0"><tr style="color:var(--muted)"><td>between</td><td style="text-align:right">moved</td><td style="text-align:right">difference after</td></tr>`
      +st.map(x=>`<tr><td>${ymd(x.from)} → ${ymd(x.to)}</td><td style="text-align:right">${sg(x.delta)}</td><td style="text-align:right">${sg(x.gap)}</td></tr>`).join('')+'</table></div>'
      :'The difference never moved by $1,000 between two of Hyperliquid’s points.');
    return `<div style="margin-top:8px"><b>${esc(a.label)}</b><br>`+rows.join('<br>')+'</div>';
  };
  el.innerHTML='<b>Perp P&amp;L audit</b> — your fills and funding against Hyperliquid’s own perp curve. <button class="df-btn" id="auditClose">Close</button>'+dataAudit.map(one).join('');
  $('auditClose').onclick=toggleAuditPanel;
}
