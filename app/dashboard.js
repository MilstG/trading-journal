// Ledger app · part 4 of 15: the dashboard: positions, stats, calendar, guardrails, charts, tags, attribution.
// ledger.html loads the parts in order as classic scripts sharing one global scope. Code that
// runs while a part loads (not inside a function called later) may only use names declared in
// this part or an earlier one; the boot part runs last. See "Development and testing" in README.md.

/* ============================ render: positions + stats ============================ */
function perpCard(p,multi){
  const long=p.szi>0; const side=long?'long':'short';
  const disp=p.dex?p.coin.slice(p.dex.length+1):p.coin;
  const dexTag=p.dex?` <span class="pill hip3" data-tip="HIP-3 builder-deployed market on the &quot;${esc(p.dex)}&quot; dex — separate margin and order book from Hyperliquid's main perps; values are in the dex's collateral token (usually USD-pegged).">${esc(p.dex.toUpperCase())}</span>`:'';
  return `<div class="poscard ${side}"><div class="top">
    <span class="coin">${esc(disp)} <span class="pill ${side}">${long?'LONG':'SHORT'}${p.lev?' '+p.lev+'x':''}</span>${dexTag}</span>
    <span class="upnl ${cls(p.uPnl)}">${fmtUsd(p.uPnl)}</span></div>
    <div class="meta">size ${fmtNum(Math.abs(p.szi))} · entry ${fmtNum(p.entryPx)}${p.roe?' · ROE '+(p.roe*100).toFixed(1)+'%':''}<br>
    ${p.liq?'liq '+fmtNum(p.liq)+' · ':''}notional ${fmtUsd(p.value)}${multi&&p.wallet?' · '+esc(labelFor(p.wallet)):''}</div></div>`;
}
function spotCard(h,multi){
  return `<div class="poscard spot"><div class="top">
    <span class="coin">${esc(h.coin)} <span class="pill spot">SPOT</span></span>
    <span class="upnl ${cls(h.uPnl)}">${fmtUsd(h.uPnl)}</span></div>
    <div class="meta">holding ${fmtNum(h.total)} · cost ${fmtUsd(h.entry)}<br>
    mark ${h.mark?fmtNum(h.mark):'—'} · value ${fmtUsd(h.value)}${multi&&h.wallet?' · '+esc(labelFor(h.wallet)):''}</div></div>`;
}
function renderPositions(){
  const strip=$('posStrip'), multi=settings.wallets.length>1; let cards=[];
  if(view==='perp'||view==='combined') cards=cards.concat(dexPositions().map(p=>perpCard(p,multi)));
  if(view==='spot'||view==='combined') cards=cards.concat(spotHoldings.map(h=>spotCard(h,multi)));
  if(!cards.length){ strip.classList.add('hide'); strip.innerHTML=''; renderRiskPanel(); return; }
  // totals: unrealized, gross exposure, perp net direction skew
  const perpsIn=(view!=='spot')?dexPositions():[], spotsIn=(view!=='perp')?spotHoldings:[];
  const uTot=perpsIn.reduce((s,p)=>s+(p.uPnl||0),0)+spotsIn.reduce((s,h)=>s+(h.uPnl||0),0);
  const gross=perpsIn.reduce((s,p)=>s+(p.value||0),0)+spotsIn.reduce((s,h)=>s+(h.value||0),0);
  if(gross<1 && Math.abs(uTot)<1){ strip.classList.remove('hide'); strip.innerHTML=cards.join(''); return; }
  const skew=perpsIn.reduce((s,p)=>s+(p.value||0)*(p.szi<0?-1:1),0);
  // net directional exposure per coin — reveals same-coin longs/shorts (across wallets) that partly cancel
  let netExpHtml='';
  if(view!=='spot'&&perpsIn.length){ const ne=netExposureByCoin();
    const offset=ne.filter(x=>x.wallets>1 || Math.abs(x.net)<x.gross-1); // hedged or split across wallets
    if(offset.length){ netExpHtml='<br>net by coin '+ne.slice(0,4).map(x=>`${esc(x.coin)} ${x.net>=0?'+':'−'}${fmtUsd(Math.abs(x.net)).replace('$','$')}`).join(' · '); }
  }
  const totalCard=`<div class="poscard ${uTot>=0?'long':'short'} pos-total" data-tip="Your open book at a glance: total unrealized PnL, gross exposure (sum of position sizes in $), net directional skew (long notional minus short), and net-per-coin exposure that nets offsetting longs/shorts across wallets. Includes HIP-3 dex positions (their values are in each dex's collateral token, usually USD-pegged). A large skew means the book is one directional bet.">
    <div class="top"><span class="coin">OPEN BOOK <span class="pill">${cards.length} pos</span></span>
    <span class="upnl ${cls(uTot)}">${fmtUsd(uTot)}</span></div>
    <div class="meta">gross exposure ${fmtUsd(gross)}${(view!=='spot'&&perpsIn.length)?`<br>net skew ${skew>=0?'long ':'short '}${fmtUsd(Math.abs(skew))}`:''}${netExpHtml}</div></div>`;
  strip.classList.remove('hide'); strip.innerHTML=totalCard+cards.join('');
}
// Open-position RISK panel: the position strip lists positions; this summarizes them as
// risk — distance to liquidation per position, aggregate notional by coin (netted across
// wallets, HIP-3 dexs included), concentration, and a danger callout for anything within
// 10% of its liquidation price. Perp-only by design: spot holdings have no liq price.
// On-demand correlation clusters for the risk panel: ~90 days of 1d candles per held coin
// (same cache the benchmark uses), real pairwise correlations, exposure netted per cluster.
let _riskClusters=null; // {key, res} — keyed on coins AND sizes (see _riskKey)
let _shockPct=null;     // active scenario-shock selection; null = off
// Cluster cache key: coin set plus rounded net exposures. Keying on coins alone let a
// 3-minute auto-refresh change sizes/marks while the panel kept showing stale dollars.
const _riskKey=ne=>ne.map(e=>e.coin+':'+Math.round(e.net)).sort().join(',');
// One reset for every piece of state DERIVED from the loaded wallet set. loadFromPaste,
// removeWallet, and backup restore each replace part of the world; anything derived from
// the old one — capital flows, correlation clusters, scenario shock, excursion and miner
// caches — must not survive into the new one. Three staleness bugs came from missing
// exactly this hook. With removeAddr set, wallet-tagged state is filtered, not wiped.
function resetDerivedState(removeAddr){
  if(removeAddr){ const a=removeAddr.toLowerCase();
    ledFlows=ledFlows.filter(f=>(f.wallet||'').toLowerCase()!==a);
  } else { ledFlows=[]; ledSkipped=0; }
  _riskClusters=null; _shockPct=null;
  _excCache={key:null,rows:null,openRows:null,skippedCoins:null,skippedN:0};
  _minerCache={key:null,res:null,deep:null};
}
async function computeRiskClusters(){
  const ne=netExposureByCoin(); if(ne.length<2)return;
  const key=_riskKey(ne);
  const btn=$('riskCorrBtn'); if(btn){ btn.disabled=true; btn.textContent='Fetching daily candles…'; }
  const now=Date.now(), from=now-95*86400e3;
  const candlesByCoin={};
  for(const e of ne.slice(0,12)){ // the netted book is small; 12 coins is already extreme
    try{
      const k=excKey(e.coin,'1d');
      let cache=null; try{ cache=await idbGet('cnd:'+k); }catch(err){}
      if(!cache||cache.v!==1||!Array.isArray(cache.candles)||!Array.isArray(cache.ranges))cache={v:1,candles:[],ranges:[]};
      for(const u of uncoveredRanges([from,now],cache.ranges)){
        if(u[1]-u[0]<=86400e3)continue;
        const c=await fetchCandles(e.coin,'1d',u[0],u[1]);
        cache.candles=mergeCandles(cache.candles,c.rows);
        if(c.coveredTo>u[0])cache.ranges=mergeRanges([...cache.ranges,[u[0],c.coveredTo]],1);
      }
      try{ await idbSet('cnd:'+k,cache); }catch(err){}
      const win=cache.candles.filter(c=>c[0]>=from);
      if(win.length>=21)candlesByCoin[e.coin]=win;
    }catch(err){} // no candles for this name (some HIP-3 markets) — skip, don't sink the panel
  }
  const res=exposureClusters(ne,coinCorrelations(candlesByCoin),0.7);
  _riskClusters={key, res};
  renderRiskPanel();
}
function renderRiskPanel(){
  const el=$('riskPanel'); if(!el)return;
  const m=(view!=='spot')?openRiskModel(dexPositions()):null;
  if(!m){ el.classList.add('hide'); el.innerHTML=''; return; }
  el.classList.remove('hide');
  const pctf=x=>x==null?'\u2014':(x*100).toFixed(1)+'%';
  const rowStyle='display:grid;grid-template-columns:minmax(90px,1.4fr) 56px 1fr 1fr 1fr 90px 1fr;gap:8px;align-items:baseline;padding:4px 0;border-bottom:1px solid var(--line);font-size:12px';
  const head=`<div style="${rowStyle};color:var(--faint);font-size:10.5px;text-transform:uppercase;letter-spacing:.04em"><span>market</span><span>side</span><span style="text-align:right">notional</span><span style="text-align:right">mark</span><span style="text-align:right">liq</span><span style="text-align:right" data-tip="How far the current mark price is from this position's liquidation price, as a % of mark. Sorted nearest-first \u2014 the top row is your most fragile position.">to liq</span><span style="text-align:right">uPnL</span></div>`;
  const rows=m.rows.map(r=>{
    const disp=r.dex?esc(r.coin.slice(r.dex.length+1))+' <span class="pill hip3">'+esc(r.dex.toUpperCase())+'</span>':esc(r.coin);
    const dCls=r.liqDist==null?'':(r.liqDist<0.10?'neg-t':(r.liqDist<0.25?'':'pos-t'));
    const wl=(settings.wallets.length>1&&r.wallet)?' <span style="color:var(--faint);font-size:10px">'+esc(labelFor(r.wallet))+'</span>':'';
    return `<div style="${rowStyle}"><span>${disp}${wl}</span><span class="${r.side==='long'?'pos-t':'neg-t'}">${r.side}${r.lev?' '+r.lev+'x':''}</span><span style="text-align:right">${fmtUsd(r.notional)}</span><span style="text-align:right">${r.mark!=null?fmtNum(r.mark):'\u2014'}</span><span style="text-align:right">${r.liq!=null?fmtNum(r.liq):'\u2014'}</span><span style="text-align:right" class="${dCls}">${pctf(r.liqDist)}</span><span style="text-align:right" class="${cls(r.uPnl)}">${fmtUsd(r.uPnl)}</span></div>`;
  }).join('');
  const coinBits=m.coins.slice(0,6).map(c=>`<span data-tip="Signed net notional for ${esc(c.coin)} across all wallets (gross ${fmtUsd(c.gross)}${c.wallets>1?', '+c.wallets+' wallets':''}); ${(c.share*100).toFixed(0)}% of your open book."><b>${esc(c.coin)}</b> <span class="${c.net>=0?'pos-t':'neg-t'}">${c.net>=0?'long':'short'} ${fmtUsd(Math.abs(c.net))}</span></span>`).join(' \u00b7 ');
  const danger=m.danger.length?`<div class="guard overtrading" style="margin-top:8px"><span class="gicon">\u26a0</span><span><b>${m.danger.length} position${m.danger.length===1?'':'s'} within 10% of liquidation</b>: ${m.danger.map(r=>esc(r.dex?r.coin.slice(r.dex.length+1):r.coin)+' ('+pctf(r.liqDist)+' away)').join(', ')}. One ordinary candle can force-close these \u2014 add margin, trim, or place the stop yourself before the exchange does.</span></div>`:'';
  const conc=riskConcentration(m);
  const concHtml=(conc&&conc.clustered)?`<div class="guard overtrading" style="margin-top:8px" data-tip="Perps move together \u2014 in risk-off, alts track BTC \u2014 so several positions on the same side carry more real risk than the sum of their individual liquidation distances suggests. This flags when your book is heavily one-directional (|net|/gross \u2265 60%) across multiple names. Heuristic: without a price-history correlation matrix it measures how one-sided you are, not exact correlations."><span class="gicon">\u26a0</span><span><b>Concentrated ${conc.side} book</b>: ${(conc.dirRatio*100).toFixed(0)}% of gross exposure is net ${conc.side} across ${conc.side==='long'?conc.longs:conc.shorts} of ${conc.positions} positions. Correlated names moving together means your real risk is larger than the per-position liquidation distances imply \u2014 a single regime move hits all of them at once. Size the cluster as one bet.</span></div>`:'';
  // real correlation clusters (on demand): the exact version of the heuristic above
  const ne=netExposureByCoin();
  const ckey=_riskKey(ne);
  let clusterHtml='';
  if(ne.length>=2){
    if(_riskClusters&&_riskClusters.key===ckey){
      const rc=_riskClusters.res;
      const lines=rc.clusters.map(c=>`<div class="guard overtrading" style="margin-top:8px"><span class="gicon">\u26d3</span><span><b>${c.coins.map(esc).join(' + ')} move together</b>${c.minCorr!=null?' (pairwise \u03c1 \u2265 '+c.minCorr.toFixed(2)+', 90d daily)':''}: net ${c.net>=0?'long':'short'} ${fmtUsd(Math.abs(c.net))} across ${fmtUsd(c.gross)} gross \u2014 one regime move hits all of them, so size the cluster as one bet.</span></div>`).join('');
      clusterHtml=lines+(rc.clusters.length
        ?`<div style="margin-top:8px;font-size:11.5px;color:var(--muted)" data-tip="Directional exposure counting each co-moving cluster as ONE position, vs summing every coin independently. The gap is the diversification your book actually has.">cluster-netted directional exposure ${fmtUsd(rc.effectiveDirectional)} \u00b7 counting coins independently ${fmtUsd(rc.naiveDirectional)}</div>`
        :`<div style="margin-top:8px;font-size:11.5px;color:var(--muted)">correlation clusters (\u03c1\u2265${rc.thr}, 90d daily): none \u2014 your open coins are not strongly co-moving right now.</div>`);
    } else clusterHtml=`<div style="margin-top:8px"><button class="btn ghost" id="riskCorrBtn" data-tip="Fetch ~90 days of daily candles for each held coin (cached locally) and compute real pairwise correlations, then net exposure within co-moving clusters \u2014 the exact version of the one-sided-book heuristic above.">Compute correlation clusters</button></div>`;
  }
  // scenario shock: mark everything \u00b1X% and see what breaks
  let shockHtml='';
  { const opts=[-20,-10,-5,5,10,20];
    const btns=opts.map(p=>`<button class="btn ghost" data-shock="${p}" style="padding:2px 8px;font-size:11px${_shockPct===p?';border-color:#2FD08C;color:var(--text)':''}">${p>0?'+':''}${p}%</button>`).join(' ');
    let out='';
    if(_shockPct!=null){
      const sc=scenarioShock(m.rows, accountValue, _shockPct);
      out=`<div style="margin-top:6px;font-size:12px">mark everything ${_shockPct>0?'+':''}${_shockPct}% \u2192 PnL impact <span class="${cls(sc.pnl)}">${fmtUsd(sc.pnl)}</span>${sc.acctPct!=null?' <span style="color:var(--faint)">('+(sc.acctPct>=0?'+':'')+(sc.acctPct*100).toFixed(1)+'% of account)</span>':''}${sc.liqs.length?` \u00b7 <span class="loss"><b>${sc.liqs.length} position${sc.liqs.length===1?'':'s'} liquidate${sc.liqs.length===1?'s':''}</b>: ${sc.liqs.map(l=>esc(l.dex?l.coin.slice(l.dex.length+1):l.coin)).join(', ')}</span>`:' \u00b7 no liquidations'}</div>`;
    }
    shockHtml=`<div style="margin-top:10px;font-size:11.5px;color:var(--muted)" data-tip="First-order stress test: shift every mark by the chosen % (longs and shorts signed correctly), sum the PnL impact, and check which positions cross their liquidation price at the shocked mark. Ignores funding, fees, and margin-tier interactions \u2014 real liquidation comes a touch earlier. Click a % again to clear.">scenario shock: ${btns}</div>${out}`;
  }
  el.innerHTML=`<h3 data-tip="The open book summarized as RISK rather than a list: per-position distance to liquidation (nearest first), net directional exposure by coin netted across wallets (HIP-3 dexs included), and concentration. Live from Hyperliquid \u2014 refreshes with each load.">Open-position risk <span class="hint">${m.positions} position${m.positions===1?'':'s'} \u00b7 gross ${fmtUsd(m.gross)} \u00b7 net ${m.skew>=0?'long':'short'} ${fmtUsd(Math.abs(m.skew))} \u00b7 largest market ${(m.largestShare*100).toFixed(0)}% of book</span></h3>
    ${head}${rows}
    <div style="margin-top:8px;font-size:11.5px;color:var(--muted)">net by coin: ${coinBits||'\u2014'}</div>
    ${danger}${concHtml}${clusterHtml}${shockHtml}`;
  const cb=$('riskCorrBtn'); if(cb)cb.onclick=computeRiskClusters;
  el.querySelectorAll('[data-shock]').forEach(b=>b.onclick=()=>{ const p=+b.dataset.shock;
    _shockPct=_shockPct===p?null:p; renderRiskPanel(); });
}
function renderStats(s){
  const openN=allTrades.filter(t=>t.isOpen&&viewFilter(t)).length;
  const posList = view==='spot'?spotHoldings : view==='perp'?dexPositions() : dexPositions().concat(spotHoldings);
  const uPnl=posList.reduce((a,p)=>a+(p.uPnl||0),0);
  // a portfolio-margin wallet's balance is in both perp and spot (one pool), so the combined total counts it once
  const acct = view==='spot'?spotAccountValue : view==='perp'?accountValue
    : ((accountValue==null&&spotAccountValue==null)?null:((accountValue||0)+(spotAccountValue||0)-(unifiedAccountValue||0)));
  const unified=unifiedAccountValue!=null&&unifiedAccountValue>0;
  const pf=s.profitFactor===Infinity?'∞':s.profitFactor.toFixed(2);
  const payoff=s.payoff===Infinity?'∞':s.payoff.toFixed(2);
  const streak=s.curStreak?`${s.curStreak}${s.curSign>0?'W':'L'} streak`:'no streak';
  const gd=s.totalDays?(s.greenDays/s.totalDays*100):0;
  const cards=[
    {pri:1,k:'Net PnL',v:fmtUsd(s.net),sign:s.net,sub:s.n+' trades'+(openN?' · '+openN+' open':''),tip:'All-in realized PnL (fees and funding included) for closed trades in this view and period.'},
    {pri:1,k:'Volume',v:fmtUsd(s.volume),sign:0,sub:s.n?'≈'+fmtUsd(s.volume/s.n)+'/trade':'total traded',tip:'Total notional traded in this view — every fill\'s size × price summed across entries and exits (maker + taker). A read on turnover and the fee-generating flow you push.'},
    {pri:1,k:'Unrealized',v:posList.length?fmtUsd(uPnl):'—',sign:uPnl,sub:posList.length+(view==='spot'?' holding':' position')+(posList.length===1?'':'s'),tip:'Mark-to-market PnL on your open positions. Live from Hyperliquid; not part of realized stats.'},
    {pri:1,k:'Win rate',v:(s.winRate*100).toFixed(1)+'%',sign:s.winRate>=0.5?1:-1,sub:s.wins+'W / '+s.losses+'L'+(s.breakeven?' / '+s.breakeven+' B/E':''),tip:'Winning trades ÷ (winners + losers). Trades landing within ±'+fmtUsd(_be)+' of zero are break-even scratches, excluded from both sides. Adjust the band under ⚙ Metrics.'},
    {pri:1,k:'Expectancy',v:fmtUsd(s.expectancy),sign:s.expectancy,sub:'median '+(s.median!=null?fmtUsd(s.median):'—'),tip:'Average net PnL per trade. The median is the middle trade — if the mean is far above the median, a few big winners carry the average.'},
    {pri:1,k:'Profit factor',v:pf,sign:s.profitFactor>=1?1:-1,sub:'payoff '+payoff+' · b/e WR '+(s.breakevenWR*100).toFixed(0)+'%',tip:'Gross profit ÷ gross loss (1.5+ solid, 2+ strong). Sub: average win ÷ average loss, and the win rate needed to break even at that payoff.'},
    {pri:1,k:'Max drawdown',v:fmtUsd(s.maxDD),sign:s.maxDD<0?-1:0,sub:(s.maxDDpct!=null?(s.maxDDpct*100).toFixed(1)+'% off peak':'peak to trough'),tip:'Largest peak-to-trough drop in cumulative PnL for this view. The % is relative to your peak cumulative profit (deposit/withdrawal independent). Hyperliquid\'s own app shows an account-value drawdown instead, which deposits and withdrawals distort — this PnL-based figure is the honest one.'},
    {pri:1,k:'Sharpe',v:s.sharpe!=null?s.sharpe.toFixed(2):'—',sign:s.sharpe!=null?(s.sharpeLo>0?1:s.sharpe<0?-1:0):0,sub:s.sharpe!=null?('95% CI '+s.sharpeLo.toFixed(1)+'–'+s.sharpeHi.toFixed(1)+' · '+s.sharpeN+'d'):'need ≥2 days',tip:'Annualized Sharpe of daily NET PnL over calendar days (flat days included), risk-free 0. Sub shows the 95% CI (Lo 2002) and day count — if the band spans 0, the estimate is not yet reliable. In-sample, not walk-forward.'},
    {k:'Avg R',v:s.avgR!=null?(s.avgR>=0?'+':'')+s.avgR.toFixed(2)+'R':'—',sign:s.avgR,sub:s.rCount?('1R='+(settings.rBasis==='fixed'?fmtUsd(parseFloat(settings.riskDefault)||0):'avg loss')+' · Σ'+(s.totalR>=0?'+':'')+s.totalR.toFixed(1)+'R'):'no losses yet',tip:'Average R-multiple = net PnL ÷ 1R. Default 1R = your average losing trade (auto). Change the basis under ⚙ Settings, or set risk per trade in the journal. +0.3R and up is healthy.'},
    {k:'Account value',v:acct!=null?fmtUsd(acct):'—',sign:0,sub:unified?'portfolio margin · one balance':view==='combined'?'perp + spot':'live',tip:'Current account equity, live from each exchange. On Hyperliquid: main perp dex + spot only — margin parked on HIP-3 dexs is siloed (and may be non-USDC collateral), so it is not summed here.'+(unified?' A wallet on portfolio margin has one balance for spot and perps (the exchange’s own account value), shown in every view.':'')},
    {k:'Avg return',v:s.avgRet!=null?(s.avgRet>=0?'+':'')+s.avgRet.toFixed(2)+'%':'—',sign:s.avgRet,sub:'on notional',tip:'Average per-trade return as a % of position notional (net ÷ size × entry). A leverage-neutral read on edge.'},
    {k:'Costs',v:fmtUsd(-(s.fees-s.fund)),sign:(s.fees-s.fund)>0?-1:1,sub:'fees '+fmtUsd(s.fees)+' · fund '+(s.fund>=0?'+':'')+fmtUsd(s.fund),tip:'Total friction over this period: fees paid net of funding. Already deducted from every PnL number — this shows how much it took.'},
    {k:'Sortino',v:s.sortino!=null?(s.sortino===Infinity?'∞':s.sortino.toFixed(2)):'—',sign:s.sortino!=null?(s.sortino>=1?1:s.sortino<0?-1:0):0,sub:s.sharpeN?('downside-adj · '+s.sharpeN+'d'):'downside-adjusted',tip:'Like Sharpe but penalizes only downside deviation. Net of costs, calendar days, annualized ×√365.'},
    {k:'Profitable days',v:s.totalDays?gd.toFixed(0)+'%':'—',sign:gd>=50?1:-1,sub:s.greenDays+' / '+s.totalDays+' days',tip:'Share of trading days that finished net positive.'},
    {k:'Avg hold',v:fmtDur(s.avgHold),sign:0,sub:streak+' · long '+s.longW+'W/'+s.longL+'L',tip:'Average time in a trade. Sub shows current streak and longest win/loss streaks.'},
  ];
  const card=c=>{ const vc=c.sign>0?'pos-t':c.sign<0?'neg-t':'';
    return `<div class="stat" data-tip="${esc(c.tip)}"><div class="k">${c.k}</div><div class="v ${vc}">${c.v}</div><div class="sub">${c.sub}</div></div>`; };
  const seg=c=>{ const vc=c.sign>0?'pos-t':c.sign<0?'neg-t':'';
    return `<div class="sseg" data-tip="${esc(c.tip)}"><span class="sk">${c.k}</span><span class="sv ${vc}">${c.v}</span><span class="ss">${c.sub}</span></div>`; };
  $('stats').innerHTML=cards.filter(c=>c.pri).map(card).join('');
  $('statsMore').innerHTML=cards.filter(c=>!c.pri).map(seg).join('');
}

/* ============================ calendar heatmap ============================ */
function renderCalendar(trades){
  const map={}; trades.forEach(t=>{ const k=dayKey(t.closeTime); (map[k]=map[k]||{net:0,n:0}); map[k].net+=t.net; map[k].n++; });
  // process mode: same cells, colored by the day's process score instead of its PnL
  const proc=settings.calMode==='process'&&coachOn()?{}:null;
  if(proc){ try{ for(const d of coachContext().days)proc[d.key]=d; }catch(e){} } // colored only where this period has trades
  const mb=$('calModeBtn'); if(mb)mb.textContent=proc?'Process':'PnL';
  const hint=$('calHint'); if(hint)hint.textContent=proc?'green = disciplined day (70+), red = process broke (<50) · click a day to journal it':'green = up day, red = down day · click a day to journal it';
  const WEEKS=settings.calWeeks===52?52:26; const DOWN=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  const today=tzMidnight(Date.now());
  const end=addDays(today, 6-tzDow(today));        // saturday of this week, in the active tz
  const start=addDays(end, -(WEEKS*7-1));
  // color scale over the VISIBLE window only — with "all time" selected, one monster day
  // a year ago used to wash all contrast out of the drawn weeks
  let scale=1;
  { let d0=start; for(let i=0;i<WEEKS*7;i++){ const o=map[dayKey(d0)]; if(o&&Math.abs(o.net)>scale)scale=Math.abs(o.net); d0=addDays(d0,1); } }
  let cols=[], d=start;
  for(let w=0;w<WEEKS;w++){ let cells=[];
    for(let i=0;i<7;i++){ const k=dayKey(d); const o=map[k]; const p=tzParts(d);
      const dateStr=DOWN[p.dow]+', '+MONTHS[p.mo]+' '+p.day+', '+p.y;
      const isFuture=d>today; let bg='var(--panel2)', tip=dateStr+' · no trades';
      if(o!==undefined&&proc&&proc[k]){ const sc=proc[k].score;
        bg=sc>=70?`rgba(47,208,140,${0.3+0.55*(sc-70)/30})`:sc>=50?'rgba(201,168,92,.55)':`rgba(244,88,106,${0.35+0.5*(50-sc)/50})`;
        tip=`${dateStr} · process ${sc}/100 · ${fmtUsd(o.net)} · ${o.n} trade${o.n===1?'':'s'}`; }
      else if(o!==undefined){ const inten=0.28+0.6*Math.min(1,Math.abs(o.net)/scale);
        bg=o.net>=0?`rgba(47,208,140,${inten})`:`rgba(244,88,106,${inten})`;
        tip=`${dateStr} · ${fmtUsd(o.net)} · ${o.n} trade${o.n===1?'':'s'}`; }
      else if(isFuture){ bg='transparent'; }
      if(!isFuture)tip+=' · click to open this day’s journal';
      const a11y = o!==undefined ? ` role="img" aria-label="${esc(tip)}"` : ' aria-hidden="true"';
      cells.push(`<div class="cal-cell" style="background:${bg}${isFuture?'':';cursor:pointer'}"${isFuture&&o===undefined?' aria-hidden="true"':` data-tip="${esc(tip)}"${a11y}`}${isFuture?'':` data-day="${k}"`}></div>`);
      d=addDays(d,1);
    }
    cols.push('<div class="cal-col">'+cells.join('')+'</div>');
  }
  $('cal').innerHTML=cols.join('');
  const wb=$('calWeeksBtn'); if(wb)wb.textContent=WEEKS+'w';
}
/* ============================ guardrails + day×hour heatmap ============================ */
function renderGuardrails(){
  const el=$('guardrails'); if(!el)return;
  const sig=guardrailSignals();
  if(!sig.length){ el.innerHTML=''; return; }
  el.innerHTML=sig.map(s=>`<div class="guard ${s.type}"><span class="gicon">${s.type==='cooldown'?'⏸':'⚠'}</span><span>${s.txt}</span></div>`).join('');
}
function renderDowHour(trades){
  const el=$('dowHour'); if(!el)return;
  const hint=$('dowHint'); if(hint)hint.textContent='net PnL by weekday and hour ('+tzLabel()+')';
  const grid=Array.from({length:7},()=>Array(24).fill(null));
  const cnt=Array.from({length:7},()=>Array.from({length:24},()=>({n:0,w:0,l:0})));
  trades.forEach(t=>{ const day=tzDow(t.closeTime), hr=tzHour(t.closeTime);
    grid[day][hr]=(grid[day][hr]||0)+t.net; const c=cnt[day][hr]; c.n++; if(isWin(t.net))c.w++; else if(isLoss(t.net))c.l++; });
  let mx=1; for(const row of grid)for(const v of row)if(v!=null)mx=Math.max(mx,Math.abs(v));
  const DOW=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  let html='<table class="dh-tbl" aria-label="Net PnL by weekday and hour of day"><thead><tr><th></th>'+Array.from({length:24},(_,h)=>`<th>${h}</th>`).join('')+'</tr></thead><tbody>';
  for(let d=0;d<7;d++){ html+=`<tr><td class="dh-lab">${DOW[d]}</td>`;
    for(let h=0;h<24;h++){ const v=grid[d][h];
      if(v==null){ html+='<td class="dh-cell" style="background:var(--panel2)" aria-hidden="true"></td>'; continue; }
      const inten=0.25+0.65*Math.min(1,Math.abs(v)/mx);
      const bg=v>=0?`rgba(47,208,140,${inten})`:`rgba(244,88,106,${inten})`;
      html+=`<td class="dh-cell" style="background:${bg}" data-tip="${DOW[d]} ${h}:00–${h}:59 · ${esc(fmtUsd(v))} · ${cnt[d][h].n} trade${cnt[d][h].n===1?'':'s'}${cnt[d][h].w+cnt[d][h].l?' · '+Math.round(100*cnt[d][h].w/(cnt[d][h].w+cnt[d][h].l))+'% wins':''} · avg ${esc(fmtUsd(v/Math.max(1,cnt[d][h].n)))}" role="img" aria-label="${DOW[d]} ${h} o'clock, ${esc(fmtUsd(v))}"></td>`; }
    html+='</tr>'; }
  html+='</tbody></table>';
  el.innerHTML=html;
}

/* ============================ charts ============================ */
let charts={}; let GRID='rgba(255,255,255,.06)', TXT='#8D97A3';
// Keel's page doesn't load Chart.js (it never draws one), so everything here checks it's there first.
const hasChart=()=>typeof Chart!=='undefined';
if(hasChart()){ Chart.defaults.font.family="Inter, system-ui, -apple-system, 'Segoe UI', sans-serif"; Chart.defaults.font.size=11; Chart.defaults.color=TXT; }
// Every chart explains itself on hover: a chart's own lines first (the numbers behind the point,
// and any footer of its own), then, under them, what the chart shows (chart.$explain, set with
// explain()) — as the tooltip's after-footer, so it never displaces a chart's own footer. Canvas tooltips
// don't wrap, so the explanation is broken into short lines here.
function wrapTip(text,n){ n=n||52; const out=[]; for(const para of String(text).split('\n')){ let line='';
  for(const w of para.split(/\s+/)){ if(!w)continue; if(line&&(line+' '+w).length>n){ out.push(line); line=w; } else line=line?line+' '+w:w; }
  out.push(line); } return out; }
function explain(chart,text){ if(chart)chart.$explain=text; return chart; }
if(hasChart())try{ Object.assign(Chart.defaults.plugins.tooltip,{padding:10,boxPadding:4,bodySpacing:3,footerMarginTop:8,footerSpacing:1,footerColor:'rgba(205,214,228,.82)',
    footerFont:{weight:'normal',size:10.5},caretPadding:6});
  Chart.defaults.interaction.mode='index'; Chart.defaults.interaction.intersect=false;
  Chart.defaults.plugins.tooltip.callbacks.afterFooter=function(items){ const c=this&&this.chart, ex=c&&c.$explain; if(!ex)return '';
    const t=typeof ex==='function'?ex(items):ex; return t?wrapTip(t):''; };
}catch(e){}
const THEMES={ ts9:{grid:'rgba(125,255,79,.08)',txt:'#93a393'}, ink:{grid:'rgba(255,255,255,.06)',txt:'#8D97A3'}, bb:{grid:'rgba(44,44,40,.9)',txt:'#8C8C84'}, light:{grid:'rgba(18,24,38,.09)',txt:'#6B7488'} };
// Colorways: TS9 is the default (or whatever the server's DEFAULT_THEME says), INK and BB stay a tap away.
// settings.colorway is the user's own pick and wins; settings.theme is what is showing right now.
const COLORWAYS=['ts9','ink','bb'];
// the colorway's profit green, for charts that paint their own (always a 6-digit hex, so an alpha byte can follow)
function themeGreen(){ try{ const v=getComputedStyle(document.body).getPropertyValue('--profit').trim(); if(/^#[0-9a-f]{6}$/i.test(v))return v; }catch(e){} return '#2FD08C'; }
function defaultTheme(){ const m=typeof document!=='undefined'&&document.querySelector&&document.querySelector('meta[name="default-theme"]'); const v=m&&m.getAttribute('content'); return COLORWAYS.includes(v)?v:'ts9'; }
// Appearance (settings.appearance): dark unless chosen otherwise; 'light' by hand, or 'auto' to
// follow the device's light/dark setting. The colorway (INK/BB) is a dark-mode choice; light replaces it.
const APPEARANCES=['dark','light','auto'];
function appearanceIsLight(mode, prefersLight){ mode=APPEARANCES.includes(mode)?mode:'dark'; return mode==='light'||(mode==='auto'&&!!prefersLight); }
function prefersLight(){ try{ return matchMedia('(prefers-color-scheme: light)').matches; }catch(e){ return false; } }
function applyTheme(t){ t=COLORWAYS.includes(t)?t:defaultTheme();
  const light=appearanceIsLight(settings.appearance,prefersLight());
  document.body.classList.toggle('light',light);
  document.body.classList.toggle('bb',!light&&t==='bb');
  document.body.classList.toggle('ts9',!light&&t==='ts9');
  const pal=THEMES[light?'light':t]; GRID=pal.grid; TXT=pal.txt; if(hasChart())Chart.defaults.color=TXT;
  settings.theme=t;
  const b=$('themeBtn'); if(b){ b.textContent='◧ '+t.toUpperCase(); b.disabled=light; b.title=light?'Colorways apply in dark mode':''; }
  const a=$('appearBtn'); if(a)a.textContent={auto:'◐ Auto',dark:'● Dark',light:'○ Light'}[APPEARANCES.includes(settings.appearance)?settings.appearance:'dark'];
  const m=document.querySelector('meta[name="theme-color"]'); if(m)m.setAttribute('content',light?'#F3F5F8':t==='ts9'?'#050705':document.body.classList.contains('pz-mode')?'#0A0C0F':t==='bb'?'#000000':'#0A0C0F');
  try{ localStorage.setItem('ledger_appear',light?'light':'dark'); localStorage.setItem('ledger_theme',light?'':t); }catch(e){} // read by the first-paint script in ledger.html
}
// the user picks a colorway (the footer button, Daruma's settings): it sticks, syncs, and re-themes everything
async function setColorway(t){
  settings.colorway=COLORWAYS.includes(t)?t:defaultTheme();
  applyTheme(settings.colorway); await Store.set(S_KEY,settings);
  if(typeof PZ!=='undefined'&&PZ&&typeof pzRender==='function')pzRender(); else if(allTrades.length)render();
}
// cycle Dark -> Light -> Auto, re-theme everything that draws its own colours
async function setAppearance(mode){
  settings.appearance=APPEARANCES.includes(mode)?mode:'dark';
  applyTheme(settings.colorway); await Store.set(S_KEY,settings);
  if(typeof PZ!=='undefined'&&PZ&&typeof pzRender==='function')pzRender(); else if(allTrades.length)render();
}
// a device switching between light and dark (sunset, a phone's schedule) follows along in Auto
try{ matchMedia('(prefers-color-scheme: light)').addEventListener('change',()=>{ if(settings.appearance==='auto')setAppearance('auto'); }); }catch(e){}
function destroyCharts(){ Object.values(charts).forEach(c=>c&&c.destroy()); charts={}; }
const usdTip={callbacks:{label:c=>' '+fmtUsd(c.parsed.y)}};
function scales(x={}){ return {x:{grid:{color:GRID,drawTicks:false},border:{display:false},ticks:{maxRotation:0,autoSkip:true,maxTicksLimit:8},...x},
  y:{grid:{color:GRID,drawTicks:false},border:{display:false},ticks:{callback:v=>'$'+Number(v).toLocaleString()}}};}
const signCol=arr=>arr.map(v=>v>=0?'rgba(47,208,140,.75)':'rgba(244,88,106,.75)');
// Min-max decimation for per-trade line series: each bucket of consecutive points keeps
// its extremes (order preserved) plus the final point, so the drawn pixels are identical
// while a 30k-trade curve ships ~1.5k points instead of 30k labels + 30k date formats.
// Returns the kept indices, or null when the series is already small enough.
function decimateIdx(ys,maxN){
  const n=ys.length; maxN=maxN||1500;
  if(n<=maxN)return null;
  const idx=[]; const bucket=Math.ceil(n/(maxN/2));
  for(let i=0;i<n;i+=bucket){
    const end=Math.min(n,i+bucket);
    let lo=i,hi=i;
    for(let j=i+1;j<end;j++){ if(ys[j]<ys[lo])lo=j; if(ys[j]>ys[hi])hi=j; }
    const a=Math.min(lo,hi),b=Math.max(lo,hi);
    idx.push(a); if(b!==a)idx.push(b);
  }
  if(idx[idx.length-1]!==n-1)idx.push(n-1);
  return idx;
}
const pickIdx=(arr,idx)=>idx?idx.map(i=>arr[i]):arr;
// per-bucket numbers for a bar's tooltip: trades, wins, losses, best and worst
function grpStats(trades,keyOf){ const m={}; for(const t of trades){ const k=keyOf(t), o=m[k]||(m[k]={n:0,w:0,l:0,net:0,best:-Infinity,worst:Infinity});
  o.n++; o.net+=t.net; if(isWin(t.net))o.w++; else if(isLoss(t.net))o.l++; if(t.net>o.best)o.best=t.net; if(t.net<o.worst)o.worst=t.net; } return m; }
const grpLines=o=>!o||!o.n?[' No trades']:[' '+o.n+' trade'+(o.n===1?'':'s')+' · '+o.w+' W · '+o.l+' L'+(o.w+o.l?' · '+Math.round(100*o.w/(o.w+o.l))+'% wins':''),
  ' Average trade '+fmtUsd(o.net/o.n),' Best '+fmtUsd(o.best)+' · worst '+fmtUsd(o.worst)];
function bar(canvas,labels,data,opt={}){ const G=opt.groups;
  const tip=opt.tip||{callbacks:{label:c=>' Net '+fmtUsd(c.parsed.y),...(G?{afterLabel:c=>grpLines(G[c.dataIndex])}:{})}};
  return explain(new Chart($(canvas),{type:'bar',
  data:{labels,datasets:[{data,backgroundColor:signCol(data),borderRadius:4,...(opt.ds||{})}]},
  options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:tip},scales:scales(opt.x||{})}}),opt.explain);}
function renderCharts(closed, allv){
  allv=allv||closed;
  destroyCharts();
  const chron=[...allv].sort((a,b)=>a.closeTime-b.closeTime);
  let cum=0; const eqT=[],eqY=[];
  const eqDD=[]; let eqHi=0;
  for(const t of chron){ cum+=t.net; eqT.push(t.closeTime); eqY.push(cum); if(cum>eqHi)eqHi=cum; eqDD.push(cum-eqHi); }
  const eqIdx=decimateIdx(eqY); // labels are formatted AFTER decimation — never 30k fmtDate calls
  const keptT=pickIdx(eqT,eqIdx), keptY=pickIdx(eqY,eqIdx);
  // deposit/withdrawal markers on the curve: capital events explain its steps in context —
  // a flat month after a big withdrawal is smaller capital at work, not a cold streak
  const flowAmt={};
  if(ledFlows.length&&keptT.length){
    for(const f of ledFlows){ if(f.type!=='deposit'&&f.type!=='withdraw')continue;
      if(f.time<keptT[0])continue;
      let lo=0,hi=keptT.length-1,idx=0;
      while(lo<=hi){ const m=(lo+hi)>>1; if(keptT[m]<=f.time){idx=m;lo=m+1;}else hi=m-1; }
      flowAmt[idx]=(flowAmt[idx]||0)+f.usdc; }
  }
  const ctx=$('equity').getContext('2d'); const g=ctx.createLinearGradient(0,0,0,260), G=themeGreen();
  g.addColorStop(0,G+'29'); g.addColorStop(1,G+'00');
  charts.eq=new Chart(ctx,{type:'line',data:{labels:keptT.map(fmtDate),
    datasets:[{data:keptY,borderColor:G,borderWidth:1.6,fill:true,backgroundColor:g,tension:.1,pointRadius:0,pointHoverRadius:4},
      ...(Object.keys(flowAmt).length?[{data:keptY.map((v,i)=>flowAmt[i]!=null?v:null),showLine:false,fill:false,
        pointStyle:'triangle',pointRadius:5,pointHoverRadius:7,pointBorderWidth:0,
        pointRotation:keptY.map((v,i)=>(flowAmt[i]||0)<0?180:0),
        pointBackgroundColor:keptY.map((v,i)=>(flowAmt[i]||0)>=0?'rgba(139,147,255,.95)':'rgba(230,180,80,.95)')}]:[])]},
    options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},
      tooltip:{callbacks:{label:c=>c.datasetIndex===1&&flowAmt[c.dataIndex]!=null
        ? ' '+(flowAmt[c.dataIndex]>=0?'deposit +':'withdrawal −')+'$'+Math.abs(Math.round(flowAmt[c.dataIndex])).toLocaleString('en-US')
        : ' Total '+fmtUsd(c.parsed.y),
        afterLabel:c=>{ if(c.datasetIndex!==0)return []; const i=eqIdx?eqIdx[c.dataIndex]:c.dataIndex, t=chron[i]; if(!t)return [];
          return [' After trade '+(i+1)+' of '+chron.length+': '+dispMarket(dcoin(t))+' '+(t.dir||'')+' '+fmtUsd(t.net),
            eqDD[i]<0?' '+fmtUsd(eqDD[i])+' below the high so far':' At a new high']; }}}},scales:scales(),interaction:{intersect:false,mode:'index'}}});
  explain(charts.eq,'Your running total of closed-trade P&L, trade by trade. Triangles mark deposits (up) and withdrawals (down).');
  const byCoin={}; allv.forEach(t=>{const k=dcoin(t);byCoin[k]=(byCoin[k]||0)+t.net;});
  const coins=Object.entries(byCoin).sort((a,b)=>Math.abs(b[1])-Math.abs(a[1])).slice(0,10);
  const gCoin=grpStats(allv,t=>dcoin(t));
  charts.coin=bar('byCoin',coins.map(c=>dispMarket(c[0])),coins.map(c=>c[1]),{groups:coins.map(c=>gCoin[c[0]]),explain:'Net P&L per market, your ten biggest by size of result. The longest bars are where most of your money is made or lost.'});
  const byMon={}; allv.forEach(t=>{ const p=tzParts(t.closeTime); const k=p.y+'-'+String(p.mo+1).padStart(2,'0'); byMon[k]=(byMon[k]||0)+t.net; }); // tzParts, not local Date — keeps this chart on the same clock as the monthly decomposition
  // zero-fill skipped months — omitting them visually compressed inactive stretches out of the timeline
  { const mks=Object.keys(byMon).sort();
    if(mks.length>1){ let y0=+mks[0].slice(0,4),m0=+mks[0].slice(5); const y1=+mks[mks.length-1].slice(0,4),m1=+mks[mks.length-1].slice(5);
      while(y0<y1||(y0===y1&&m0<=m1)){ const k=y0+'-'+String(m0).padStart(2,'0'); if(byMon[k]==null)byMon[k]=0; if(++m0>12){m0=1;y0++;} } } }
  const mons=Object.keys(byMon).sort().slice(-12);
  const MONL=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const gMon=grpStats(allv,t=>{ const p=tzParts(t.closeTime); return p.y+'-'+String(p.mo+1).padStart(2,'0'); });
  charts.month=bar('byMonth',mons.map(k=>MONL[+k.slice(5)-1]+' '+k.slice(2,4)),mons.map(k=>byMon[k]),{groups:mons.map(k=>gMon[k]),explain:'Net P&L per calendar month (the last 12). How many months are green, and how lumpy the good ones are.'});
  const DOW=['Sun','Mon','Tue','Wed','Thu','Fri','Sat']; const dow=Array(7).fill(0);
  allv.forEach(t=>dow[tzDow(t.closeTime)]+=t.net);
  const gDow=grpStats(allv,t=>tzDow(t.closeTime));
  charts.dow=bar('byDow',DOW,dow,{groups:DOW.map((_,i)=>gDow[i]),explain:'Net P&L by the weekday trades closed on ('+tzLabel()+'). Shows which days you trade well or poorly.'});
  const hrs=Array(24).fill(0); allv.forEach(t=>hrs[tzHour(t.closeTime)]+=t.net);
  const gHr=grpStats(allv,t=>tzHour(t.closeTime));
  charts.hour=bar('byHour',hrs.map((_,i)=>i),hrs,{tip:{callbacks:{title:c=>c[0].label+':00–'+c[0].label+':59',label:c=>' Net '+fmtUsd(c.parsed.y),afterLabel:c=>grpLines(gHr[c.dataIndex])}},
    explain:'Net P&L by the hour trades closed ('+tzLabel()+'). Your best and worst hours of the day.'});
  // Sessions are market-clock concepts, pinned to UTC regardless of the tz toggle —
  // bucketing them by the toggled hour mislabeled every session for non-UTC viewers.
  const SESS=[['Asia',0,8],['London',8,13],['Overlap',13,16],['NY',16,21],['Late NY',21,24]];
  const utcH=ms=>new Date(ms).getUTCHours();
  const sessIdx=h=>SESS.findIndex(([,a,b])=>a<b?(h>=a&&h<b):(h>=a||h<b));
  const sess=Array(SESS.length).fill(0); allv.forEach(t=>sess[sessIdx(utcH(t.closeTime))]+=t.net);
  const gSess=grpStats(allv,t=>sessIdx(utcH(t.closeTime)));
  charts.sess=bar('bySession',SESS.map(([n,a,b])=>[n,String(a).padStart(2,'0')+'–'+String(b).padStart(2,'0')]),sess,
    {ds:{maxBarThickness:60},x:{ticks:{maxRotation:0,autoSkip:false}},groups:SESS.map((_,i)=>gSess[i]),
     tip:{callbacks:{title:c=>{ const s2=SESS[c[0].dataIndex]; return s2[0]+' session · '+String(s2[1]).padStart(2,'0')+':00–'+String(s2[2]).padStart(2,'0')+':00 UTC'; },label:c=>' Net '+fmtUsd(c.parsed.y),afterLabel:c=>grpLines(gSess[c.dataIndex])}},
     explain:'Net P&L by market session, from the UTC hour each trade closed (sessions run on the market’s clock, so the time-zone toggle doesn’t move them).'});
  const sides={}; allv.forEach(t=>sides[t.dir]=(sides[t.dir]||0)+t.net);
  const sideLabels=['Long','Short','Spot'].filter(k=>k in sides);
  const gSide=grpStats(allv,t=>t.dir);
  charts.side=bar('bySide',sideLabels,sideLabels.map(k=>sides[k]),{ds:{barThickness:60},groups:sideLabels.map(k=>gSide[k]),explain:'Net P&L split by direction. A big gap means you’re much better one way than the other.'});
  const w=closed.filter(t=>isWin(t.net)).length,l=closed.filter(t=>isLoss(t.net)).length,be=closed.filter(t=>isBE(t.net)).length;
  charts.dist=new Chart($('dist'),{type:'doughnut',data:{labels:['Wins','Losses','Break-even'],
    datasets:[{data:[w,l,be],backgroundColor:['rgba(47,208,140,.85)','rgba(244,88,106,.85)','rgba(91,100,120,.6)'],borderColor:getComputedStyle(document.body).getPropertyValue('--bg').trim()||'#0A0E18',borderWidth:3}]},
    options:{responsive:true,maintainAspectRatio:false,cutout:'62%',interaction:{mode:'nearest',intersect:true},plugins:{legend:{position:'right',labels:{boxWidth:10,padding:12}},
      tooltip:{callbacks:{label:c=>' '+c.parsed+' '+c.label.toLowerCase()+' · '+(closed.length?Math.round(100*c.parsed/closed.length):0)+'% of trades',
        afterLabel:c=>{ const g=[closed.filter(t=>isWin(t.net)),closed.filter(t=>isLoss(t.net)),closed.filter(t=>isBE(t.net))][c.dataIndex]; const sum=g.reduce((a,t)=>a+t.net,0);
          return g.length?[' Total '+fmtUsd(sum)+' · average '+fmtUsd(sum/g.length)]:[]; }}}}}});
  explain(charts.dist,'Closed trades by outcome. Break-even trades are those too small to count as a win or a loss.');
  const rs=closed.map(rFor).filter(r=>r!==null);
  const buckets=['≤-2','-2⋯-1','-1⋯0','0⋯1','1⋯2','2⋯3','>3']; const bc=Array(7).fill(0);
  rs.forEach(r=>{ let i; if(r<=-2)i=0;else if(r<-1)i=1;else if(r<0)i=2;else if(r<1)i=3;else if(r<2)i=4;else if(r<3)i=5;else i=6; bc[i]++; });
  const rdCanvas=$('rdist'), rdEmpty=$('rdistEmpty');
  if(rs.length){ rdEmpty.classList.add('hide'); rdCanvas.style.display='';
    charts.rdist=new Chart(rdCanvas,{type:'bar',data:{labels:buckets,
    datasets:[{data:bc,backgroundColor:buckets.map((_,i)=>i<3?'rgba(244,88,106,.75)':'rgba(47,208,140,.75)'),borderRadius:4}]},
    options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{title:c=>c[0].label+' R',label:c=>' '+c.parsed.y+' trade'+(c.parsed.y===1?'':'s')+' · '+Math.round(100*c.parsed.y/rs.length)+'% of trades with a risk set'}}},
      scales:{x:{grid:{color:GRID,drawTicks:false},border:{display:false}},y:{grid:{color:GRID,drawTicks:false},border:{display:false},ticks:{precision:0}}}}});
    explain(charts.rdist,'R = a trade’s result ÷ the risk you planned for it. Bars on the right (above 1R) are winners bigger than your risk.');
  } else { rdEmpty.classList.remove('hide'); rdCanvas.style.display='none'; }
}

/* ============================ tag performance ============================ */
const DOWN=['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
function holdBucket(ms){ const m=ms/60000; if(m<5)return 'under 5 min'; if(m<60)return '5–60 min'; if(m<240)return '1–4 hours'; if(m<1440)return '4–24 hours'; return 'over a day'; }
function hourBlock(h){ if(h<6)return '00–06h'; if(h<12)return '06–12h'; if(h<18)return '12–18h'; return '18–24h'; }
function sizeBucketFn(trades){
  const ns=trades.map(t=>t.maxSize*t.avgEntry).filter(x=>x>0).sort((a,b)=>a-b);
  const q=p=>ns.length?ns[Math.min(ns.length-1,Math.floor(p*ns.length))]:0;
  const q1=q(.25),q2=q(.5),q3=q(.75);
  // trades ranked by $ size (notional) and split into quarters — labels say which quarter a trade falls in
  return t=>{ const n=t.maxSize*t.avgEntry; return n<=q1?'smallest 25%':n<=q2?'small-mid (25–50%)':n<=q3?'large-mid (50–75%)':'largest 25%'; };
}
function edgeKeyFn(dim,trades){
  if(dim==='size'){ const f=sizeBucketFn(trades); return t=>[f(t)]; }
  return t=>{ const j=journal[t.id]||{};
    switch(dim){
      case 'dir': return [t.dir];
      case 'market': return [dcoin(t)];
      case 'dow': return [DOWN[tzDow(t.closeTime)]];
      case 'hour': return [hourBlock(tzHour(t.closeTime))];
      case 'hold': return [holdBucket(t.durationMs)];
      case 'rating': return [j.rating?'★'.repeat(j.rating):'unrated'];
      case 'setup': return [j.setup?j.setup:'(no setup)'];
      case 'tag': return (j.tags&&j.tags.length)?j.tags:['(untagged)'];
      case 'mistake': return (j.mistakes&&j.mistakes.length)?j.mistakes:['clean'];
      default: return ['all'];
    } };
}
function bucketize(trades,dim){
  const keyFn=edgeKeyFn(dim,trades), g={};
  trades.forEach(t=>{ for(const k of keyFn(t)){ const b=g[k]||(g[k]={key:k,n:0,wins:0,losses:0,net:0,sq:0,rs:[]});
    b.n++; if(isWin(t.net))b.wins++; else if(isLoss(t.net))b.losses++; b.net+=t.net; b.sq+=t.net*t.net; const r=rFor(t); if(r!==null)b.rs.push(r); } });
  return Object.values(g).map(b=>{ const mean=b.net/b.n;
    const sd=b.n>1?Math.sqrt(Math.max(0,(b.sq-b.n*mean*mean)/(b.n-1))):0;
    return {key:b.key,n:b.n,wins:b.wins,losses:b.losses,net:b.net,sd,winRate:(b.wins+b.losses)?b.wins/(b.wins+b.losses):0,expectancy:mean,avgR:b.rs.length?_avg(b.rs):null}; });
}
/* ============================ asset attribution ============================ */
// Ranked per-market contribution to the period result. Two denominators, because "% of my PnL"
// is ambiguous and the naive version is wrong:
//   pos / neg — summed contribution of the markets that MADE / LOST money. Shares within each
//     side total exactly 1, so "these five produced 84% of the profit" is literally true. Primary.
//   total     — the bottom line. Shares against it can exceed 100% and go negative because
//     winners and losers offset, so it is a secondary read and is suppressed entirely when the
//     net is small next to the gross sides (netMeaningful), where the ratio is noise.
// basis 'usd' attributes dollars (where the money came from -- correct for "cutting X saves $Y").
// basis 'pct' attributes summed per-trade return points: additive and size-neutral, so a small
// well-traded market can outrank a big frequently-traded one.
// best/worst are partitioned by sign, never sliced from a shared list, so a market cannot appear
// in both -- the same contract test-edge-map locks in for partitionConditions. Ties break on key
// so the order is deterministic across renders.
function assetContribution(trades,basis,k){
  basis=basis==='pct'?'pct':'usd'; k=k||5;
  const g={};
  for(const t of trades){ const key=dcoin(t);
    const b=g[key]||(g[key]={key,n:0,wins:0,losses:0,net:0,sumRet:0,retN:0});
    b.n++; if(isWin(t.net))b.wins++; else if(isLoss(t.net))b.losses++;
    b.net+=t.net; const r=retPct(t); if(r!==null){ b.sumRet+=r; b.retN++; } }
  const rows=Object.values(g).map(b=>({key:b.key,n:b.n,wins:b.wins,losses:b.losses,
    net:b.net,sumRet:b.sumRet,meanRet:b.retN?b.sumRet/b.retN:null,
    winRate:(b.wins+b.losses)?b.wins/(b.wins+b.losses):0,
    expectancy:b.net/b.n,
    v:basis==='pct'?b.sumRet:b.net}));
  const pos=rows.reduce((a,r)=>a+(r.v>0?r.v:0),0);
  const neg=rows.reduce((a,r)=>a+(r.v<0?-r.v:0),0);
  const total=rows.reduce((a,r)=>a+r.v,0);
  rows.forEach(r=>{ const d=r.v>0?pos:neg;
    r.share=d>0?Math.abs(r.v)/d:0;
    r.shareNet=total!==0?r.v/Math.abs(total):null; });
  const sorted=[...rows].sort((a,b)=>b.v-a.v||String(a.key).localeCompare(String(b.key)));
  const best=sorted.filter(r=>r.v>0).slice(0,k);
  const worst=sorted.filter(r=>r.v<0).slice(-k).reverse();
  const gross=pos+neg;
  // "% of net" is only worth showing when the net is a real fraction of the gross AND no single
  // market's share of it is absurd. The second half matters: at 5% of gross a market can print
  // "704% of net", which is arithmetically correct and completely useless. Gate on the symptom,
  // not just the cause.
  const maxNetShare=Math.max(0,...sorted.map(r=>r.shareNet==null?0:Math.abs(r.shareNet)));
  return {basis,k,rows:sorted,best,worst,pos,neg,total,maxNetShare,
    netMeaningful:gross>0&&Math.abs(total)>=0.1*gross&&maxNetShare<=3,
    bestShare:pos>0?best.reduce((a,r)=>a+r.v,0)/pos:0,
    worstShare:neg>0?worst.reduce((a,r)=>a-r.v,0)/neg:0,
    markets:rows.length,others:Math.max(0,rows.length-best.length-worst.length)};
}
function assetAttribHtml(closed,basis){
  const A=assetContribution(closed,basis,5);
  if(A.markets<2) return '<p class="lead">Only one market traded in this view \u2014 nothing to rank.</p>';
  const pctB=A.basis==='pct';
  const fV=n=>pctB?((n>=0?'+':'\u2212')+Math.abs(n).toFixed(1)+' pts'):fmtUsd(n);
  const p1=x=>(x*100).toFixed(1)+'%';
  const maxAbs=Math.max(1e-9,...A.rows.map(r=>Math.abs(r.v)));
  const sideN=pos=>A.rows.filter(r=>pos?r.v>0:r.v<0).length;
  const row=(r,i,pos)=>{
    const w=(Math.abs(r.v)/maxAbs*100).toFixed(1);
    const mr=r.meanRet!=null?(r.meanRet>=0?'+':'')+r.meanRet.toFixed(2)+'%':'\u2014';
    const ofNet=(A.netMeaningful&&r.shareNet!=null)?' \u00b7 '+(r.shareNet<0?'\u2212':'')+Math.abs(r.shareNet*100).toFixed(0)+'% of net':'';
    return `<div class="state-row" data-tip="${esc(dispMarket(r.key))}: ${r.n} trades, ${r.wins}W/${r.losses}L, net ${fmtUsd(r.net)}, mean return ${mr} of notional per trade. The percentage is this market's share of the total ${pos?'profit':'loss'} across every ${pos?'profitable':'losing'} market in this view.">
      <div class="sr-top"><span class="sr-name"><span style="color:var(--faint);font-size:10.5px">${i+1}</span> ${esc(dispMarket(r.key))}</span><span class="${pos?'pos-t':'neg-t'}" style="white-space:nowrap"><b>${p1(r.share)}</b> \u00b7 ${fV(r.v)}</span></div>
      <div class="sr-sub">${r.n} trade${r.n===1?'':'s'} \u00b7 ${(r.winRate*100).toFixed(0)}% WR \u00b7 ${fmtUsd(r.expectancy)}/trade \u00b7 mean ${mr}${ofNet}</div>
      <span style="display:block;height:6px;border-radius:3px;background:rgba(127,127,127,.16);overflow:hidden;margin-top:6px"><span style="display:block;height:6px;width:${w}%;border-radius:3px;background:var(--${pos?'profit':'loss'})"></span></span>
    </div>`;
  };
  const list=(rs,pos,none)=>rs.length?rs.map((r,i)=>row(r,i,pos)).join(''):`<p class="lead">${none}</p>`;
  const tip=pos=>`Share of the total ${pos?'profit':'loss'} produced by every ${pos?'profitable':'losing'} market in this view (${fV(pos?A.pos:-A.neg)} across ${sideN(pos)} market${sideN(pos)===1?'':'s'}). Because the denominator is one side only, these shares sum to exactly 100% within the side \u2014 which is why they are the primary number. The &quot;of net&quot; figure divides by your bottom line instead: it is the honest answer to &quot;how much of my result is this market&quot;, but winners and losers offset, so that column can exceed 100% and is hidden whenever your net is small next to the gross sides.`;
  return `<div class="diag-grid">
      <div class="diag-card"><h3 data-tip="${tip(true)}">Best 5 markets <span class="hint">${p1(A.bestShare)} of all profit</span></h3>${list(A.best,true,'No profitable market in this view.')}</div>
      <div class="diag-card"><h3 data-tip="${tip(false)}">Worst 5 markets <span class="hint">${p1(A.worstShare)} of all loss</span></h3>${list(A.worst,false,'No losing market in this view.')}</div>
    </div>
    <p class="mini-note">${A.markets} market${A.markets===1?'':'s'} traded \u00b7 ${A.others} outside these two lists \u00b7 ${fV(A.pos)} made against ${fV(-A.neg)} lost \u00b7 net ${fV(A.total)}${A.netMeaningful?'':' \u2014 net is small next to the gross sides, so per-market \u201c% of net\u201d is suppressed as meaningless here'}${pctB?' \u00b7 return points are per-trade % of position notional, summed \u2014 size-neutral, so a small well-traded market can outrank a large one':' \u00b7 dollars reward size and frequency; switch to % for size-neutral quality'}.</p>`;
}
function assetAttribSection(closed){
  const b=settings.attribBasis==='pct'?'pct':'usd';
  return `<div class="diag-section">
     <h2>Where the money came from <span style="font-size:11px;color:var(--faint);font-weight:400">per-market attribution \u00b7 ranked</span></h2>
     <p class="lead">Your best and worst five markets, and what share of this period's result each one is responsible for. This is <b>attribution, not edge quality</b> \u2014 a market can top the list purely because you traded it big and often, which is exactly why the % basis exists.</p>
     <div style="display:flex;align-items:center;gap:14px;margin-bottom:10px">
       <div class="viewtog" id="attribBasisTog" data-tip="Attribution basis. $ = dollars contributed (where the money actually came from; rewards size and frequency, and is the right basis for &quot;cutting this market saves $Y&quot;). % = summed per-trade return on position notional (size-neutral decision quality, so a small market traded well can outrank a big one). Both are additive, so the shares stay interpretable either way.">
         <button data-b="usd"${b==='usd'?' class="on"':''}>attribute in $</button><button data-b="pct"${b==='pct'?' class="on"':''}>attribute in %</button>
       </div>
     </div>
     <div id="attribBox">${assetAttribHtml(closed,b)}</div>
   </div>`;
}
// Own toggle, own re-render, own persisted setting: repainting just #attribBox leaves the miner
// cache and any on-screen scan results untouched, which a full renderDiagnostic would discard.
function wireAssetAttrib(closed){
  document.querySelectorAll('#attribBasisTog button').forEach(btn=>{
    btn.onclick=async()=>{
      settings.attribBasis=btn.dataset.b; await Store.set(S_KEY,settings);
      document.querySelectorAll('#attribBasisTog button').forEach(x=>x.classList.toggle('on',x===btn));
      const box=$('attribBox'); if(box)box.innerHTML=assetAttribHtml(closed,btn.dataset.b);
    };
  });
}
const edgeLabel=dim=>({dir:'Direction',market:'Market',dow:'Day of week',hour:'Hour block',hold:'Hold time',size:'Trade size',rating:'Rating',setup:'Setup',tag:'Tag',mistake:'Mistake flag'}[dim]||'Bucket');
// plain-English phrase for a (dimension, bucket) pair — used in the edges/leaks lists so
// rows read as conditions ("Fridays", "Your largest 25% of trades by $ size") instead of raw keys.
function humanBucket(dim,key){ const k=String(key);
  switch(dim){
    case 'dow': return ({Sun:'Sundays',Mon:'Mondays',Tue:'Tuesdays',Wed:'Wednesdays',Thu:'Thursdays',Fri:'Fridays',Sat:'Saturdays'})[k]||k;
    case 'hour': return 'Trades closed '+k+' '+tzLabel();
    case 'hold': return 'Trades held '+k;
    case 'size': return 'Your '+k+' of trades by $ size';
    case 'market': return dispMarket(k)+' trades';
    case 'dir': return k==='Spot'?'Spot buys':k+' trades';
    case 'rating': return 'Trades you rated '+k;
    case 'setup': return 'Setup \u201c'+k+'\u201d';
    case 'tag': return 'Tagged \u201c'+k+'\u201d';
    case 'mistake': return k==='clean'?'Trades with no mistake flags':'Trades flagged \u201c'+k+'\u201d';
    default: return k;
  } }
function renderEdge(trades){
  const dim=$('edgeDim').value;
  const rows=bucketize(trades,dim).sort((a,b)=>b.expectancy-a.expectancy);
  const dispKey=k=>dim==='market'?dispMarket(k):String(k);
  if(!rows.length){ $('edgeTable').innerHTML='<div style="color:var(--faint);font-size:12.5px;padding:6px 0">No trades in this view yet.</div>'; $('edgeInsight').innerHTML=''; return; }
  $('edgeTable').innerHTML=`<table class="perf-tbl"><thead><tr>
    <th class="l">${edgeLabel(dim)}</th><th>Trades</th><th>Win rate</th><th>Expectancy</th><th>Avg R</th><th>Net PnL</th></tr></thead><tbody>`+
    rows.map(r=>`<tr><td class="l">${esc(dispKey(r.key))}</td><td>${r.n}</td>
      <td><span class="wrbar"><i style="width:${(r.winRate*100).toFixed(0)}%;background:${r.winRate>=0.5?'var(--profit)':'var(--loss)'}"></i></span> ${(r.winRate*100).toFixed(0)}%</td>
      <td class="${cls(r.expectancy)}">${fmtUsd(r.expectancy)}</td>
      <td class="${r.avgR!=null?cls(r.avgR):''}">${r.avgR!=null?(r.avgR>=0?'+':'')+r.avgR.toFixed(2)+'R':'—'}</td>
      <td class="${cls(r.net)}">${fmtUsd(r.net)}</td></tr>`).join('')+`</tbody></table>`;
  const MIN=Math.max(5,Math.round(trades.length*0.03)); const sample=rows.filter(r=>r.n>=MIN);
  if(sample.length>=2){ const best=sample[0], worst=sample[sample.length-1];
    $('edgeInsight').innerHTML=`Strongest: <b class="good">${esc(dispKey(best.key))}</b> · ${(best.winRate*100).toFixed(0)}% · ${fmtUsd(best.expectancy)}/trade &nbsp;•&nbsp; Weakest: <b class="bad">${esc(dispKey(worst.key))}</b> · ${(worst.winRate*100).toFixed(0)}% · ${fmtUsd(worst.expectancy)}/trade <span style="color:var(--faint)">(≥${MIN} trades)</span>`;
  } else $('edgeInsight').innerHTML='<span style="color:var(--faint)">Add more trades in a category for reliable strongest/weakest signals.</span>';
}
