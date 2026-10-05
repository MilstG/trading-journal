// Ledger app · part 10 of 15: leverage, rules and the tripwire, plan adherence, leaderboard, funding carry, habits, the coach.
// ledger.html loads the parts in order as classic scripts sharing one global scope. Code that
// runs while a part loads (not inside a function called later) may only use names declared in
// this part or an earlier one; the boot part runs last. See "Development and testing" in README.md.

/* ======================= 2 · LEVERAGE SURVIVABILITY ======================= */
// Reuses realized MAE (already measured from candles) as the adverse path. At leverage L a
// position's whole margin is gone when the adverse move reaches ~1/L; so the leverage at which
// a trade's own worst excursion would have wiped it is ~ 1/MAEfraction. First-order: ignores the
// maintenance-margin haircut (real liquidation is a touch earlier) and cross-margin buffering.
function leverageSurvival(closed, excM, assumedLev){
  const rows=[];
  for(const t of closed){ const e=excM&&excM[t.id]; if(!e||e.maePct==null||!(e.maePct>0))continue;
    const maeFrac=e.maePct/100; const maxLev=1/maeFrac;
    rows.push({id:t.id, coin:dcoin(t), maePct:e.maePct, maxLev, net:t.net, coarse:!!e.coarse}); }
  rows.sort((a,b)=>a.maxLev-b.maxLev);
  const wouldLiq=assumedLev>0?rows.filter(r=>assumedLev>=r.maxLev):[];
  return {rows, wouldLiq, n:rows.length, assumedLev,
    medMaxLev:nfMedian(rows.map(r=>r.maxLev)), measured:rows.length};
}

/* ======================= 4 · RULE ENGINE + TRIPWIRE ======================= */
function nfRules(){ const r=settings.rules||{}; return {
  maxPerDay:+r.maxPerDay||0, cooldownMin:+r.cooldownMin||0,
  noAddToLosers:!!r.noAddToLosers, dailyLossLimit:+r.dailyLossLimit||0 }; }
// Score personal rules against the reconstructed closed trades. Each finding carries the dollar
// cost of the violating trades so a broken rule has a price, not just a count.
function evaluateRules(closed, rules){
  const R=rules||nfRules(); const out=[];
  const byClose=[...closed].filter(t=>t.closeTime).sort((a,b)=>a.openTime-b.openTime);
  if(R.maxPerDay>0){
    const byDay={}; for(const t of byClose){ const k=nfDayKey(t.openTime); (byDay[k]=byDay[k]||[]).push(t); }
    const viol=[]; for(const k in byDay){ const arr=byDay[k].sort((a,b)=>a.openTime-b.openTime);
      for(let i=R.maxPerDay;i<arr.length;i++)viol.push(arr[i]); }
    out.push({rule:'Max '+R.maxPerDay+' trades/day', n:viol.length, cost:viol.reduce((s,t)=>s+t.net,0), ids:viol.map(t=>t.id)}); }
  if(R.cooldownMin>0){
    const win=R.cooldownMin*60000; const viol=[];
    // Prior closes must be scanned in close-time order — byClose is open-time-ordered, and
    // overlapping trades make closeTime non-monotone in it, which broke the old binary
    // search. And ANY loss closed inside the window trips the rule, not just the single
    // most recent close (a win closing after the loss used to hide it).
    const closes=[...byClose].sort((a,b)=>a.closeTime-b.closeTime);
    const ct=closes.map(t=>t.closeTime);
    for(const t of byClose){ let lo=0,hi=ct.length-1,idx=-1;
      while(lo<=hi){ const m=(lo+hi)>>1; if(ct[m]<=t.openTime){idx=m;lo=m+1;}else hi=m-1; }
      for(let j=idx;j>=0;j--){ const p=closes[j]; if(t.openTime-p.closeTime>win)break;
        if(p.id!==t.id&&isLoss(p.net)){ viol.push(t); break; } } }
    out.push({rule:R.cooldownMin+'-min cooldown after a loss', n:viol.length, cost:viol.reduce((s,t)=>s+t.net,0), ids:viol.map(t=>t.id)}); }
  if(R.noAddToLosers){
    // real detection from per-fill events (an add while underwater vs the running average
    // entry), not the old entry-drift proxy that also flagged planned scale-ins. Every
    // violation counts, winners included — the rule was broken either way.
    const viol=closed.filter(t=>addedToLoser(t));
    out.push({rule:'No adding to losers', n:viol.length, cost:viol.reduce((s,t)=>s+t.net,0), ids:viol.map(t=>t.id)}); }
  if(R.dailyLossLimit>0){
    const byDay={}; for(const t of byClose){ const k=nfDayKey(t.closeTime); (byDay[k]=byDay[k]||[]).push(t); }
    let days=0, cost=0; const ids=[]; for(const k in byDay){ const arr=byDay[k].sort((a,b)=>a.closeTime-b.closeTime);
      let cum=0, tripped=false; for(const t of arr){ cum+=t.net; if(tripped){ cost+=t.net; ids.push(t.id); } if(cum<=-R.dailyLossLimit&&!tripped)tripped=true; }
      if(tripped)days++; }
    out.push({rule:'Daily loss limit '+fmtUsd(R.dailyLossLimit), n:days, cost, unit:'days breached, PnL after breach', ids, kind:'dll'}); }
  return out;
}
// Realized results by day, fill by fill: [[time, result]] per day key across ALL trades — closed
// ones, partial closes of positions still open, and fees. A trade without per-fill results (imports,
// tests, fills older than the engine keeps them for) lands whole on its close day. The process
// score's loss-limit part and Pulse's risk dial read the day's result from here, as the tripwire does.
// only: a day key to collect for (others are skipped).
function realizedByDay(trades, dayOf, only){
  const by={}, put=(tm,v)=>{ const k=dayOf(tm); if(only&&k!==only)return; (by[k]=by[k]||[]).push([tm,v]); };
  for(const t of (trades||[])){
    if(t.rz&&t.rz.length){ for(const [tm,v] of t.rz)put(tm,v); }
    else if(!t.isOpen&&t.closeTime)put(t.closeTime,t.net); }
  for(const k in by)by[k].sort((a,b)=>a[0]-b[0]);
  return by;
}
// Today's realized net across ALL closed trades (tz-toggle day) — powers the live tripwire banner.
// Today's realized result: every fill today (closes, partial closes of open positions, and fees),
// not whole trades that happened to close today with losses from earlier days in them.
// n counts the trades that closed today.
function dailyLossToday(trades){
  const k=nfDayKey(Date.now()); let net=0, n=0;
  for(const t of (trades||[])){
    const today=!t.isOpen&&t.closeTime&&nfDayKey(t.closeTime)===k;
    if(t.rz){ for(const [tm,v] of t.rz)if(nfDayKey(tm)===k)net+=v; }
    else if(today)net+=t.net; // a trade built without per-fill results (imports, tests): whole trade on its close day
    if(today)n++; }
  return {net, n};
}
function renderTripwire(){
  const el=$('tripwire'); if(!el)return;
  const R=nfRules();
  // today's committed max loss (day journal) overrides the standing rule \u2014 a number
  // chosen calmly before the session beats a default when the session goes sideways
  const dj=journal[dayJKey(Date.now())];
  const committed=(dj&&dj.maxLoss>0)?dj.maxLoss:0;
  const lim=committed||R.dailyLossLimit;
  if(!(lim>0)||!allTrades.length){ el.classList.add('hide'); return; }
  const src=committed?'your committed max loss for today':'your daily limit';
  const d=dailyLossToday(allTrades);
  // Open losses count toward the limit as an INTRADAY delta: open uPnL now minus open
  // uPnL at the first sight of this tz-day. Counting lifetime unrealized-since-entry
  // against a daily limit kept the banner permanently lit for anyone holding an old
  // underwater bag \u2014 alarm fatigue that neutered the tripwire. Open gains never license
  // more risk, so only the negative part of the delta counts.
  const uNow=(openPositions||[]).reduce((a,p)=>a+(p.uPnl||0),0)+(spotHoldings||[]).reduce((a,p)=>a+(p.uPnl||0),0);
  const day=tzMidnight(Date.now());
  if(_uPnlBase.day!==day)_uPnlBase={day,val:uNow}; // baseline = first look today (mid-day app opens measure from then, and say so)
  const openLoss=Math.min(0,uNow-_uPnlBase.val);
  if(d.net<=-lim){ el.classList.remove('hide');
    el.innerHTML=`\u26d4 <b>Daily loss limit hit.</b> Today's realized PnL is ${fmtUsd(d.net)} across ${d.n} trade${d.n===1?'':'s'} \u2014 past ${src} (${fmtUsd(lim)}). Step away.`;
    maybeNotify('trip:'+nfDayKey(Date.now()),'Daily loss limit hit','Realized '+fmtUsd(d.net)+' today \u2014 past '+fmtUsd(lim)+'. Step away.');
  } else if(d.net+openLoss<=-lim){ el.classList.remove('hide');
    el.innerHTML=`\u26d4 <b>Daily loss limit hit including open positions.</b> Realized ${fmtUsd(d.net)} today plus ${fmtUsd(openLoss)} of open-PnL decline since your first look today is past ${src} (${fmtUsd(lim)}). Cut or step away \u2014 closing them later doesn't un-lose the money.`;
    maybeNotify('trip:'+nfDayKey(Date.now()),'Daily loss limit hit (incl. open)','Realized '+fmtUsd(d.net)+' + '+fmtUsd(openLoss)+' open decline \u2014 past '+fmtUsd(lim)+'.');
  } else if(d.net<-lim*0.6){ el.classList.remove('hide');
    el.innerHTML=`\u26a0 Approaching ${src}: ${fmtUsd(d.net)} today vs a ${fmtUsd(lim)} cap${openLoss<0?` (open positions add ${fmtUsd(openLoss)} on top)`:''}.`;
  } else el.classList.add('hide');
}

/* ======================= 5 · TRADE-PLAN ADHERENCE ======================= */
// The stop is what makes it a plan; entry is optional (it comes from the fills anyway), and
// callers fall back to the trade's average entry when it's blank.
function nfPlan(j){ const p=j&&j.plan; if(!p)return null;
  const e=parseFloat(p.entry), s=parseFloat(p.stop), tg=parseFloat(p.target);
  if(!(s>0))return null;
  return {entry:e>0?e:null, stop:s, target:isFinite(tg)&&tg>0?tg:null}; }
// Did you honor the plan you wrote down? Uses avg entry/exit from reconstruction vs planned
// stop/target. Stop-honored = you did NOT let price close beyond your stop (past the slippage band). With excursion
// data (excM) it also catches the quieter break: price traded THROUGH the stop and you held
// anyway (heldThrough) — an exit back above the stop hides that from avg-exit alone.
// live = the plan was last written while the trade was still open (plan.at < closeTime);
// a plan written after the close is hindsight, and scored separately.
function planAdherence(closed, journalObj, excM){
  const items=[];
  for(const t of closed){ const j=journalObj[t.id]; const p0=nfPlan(j); if(!p0)continue;
    if(!(t.avgExit>0)||!(t.avgEntry>0))continue;
    const p=p0.entry?p0:{...p0,entry:t.avgEntry};
    const short=t.dir==='Short';
    const riskPer=Math.abs(p.entry-p.stop); if(!(riskPer>0))continue;
    // the same slippage band as planVerdict (plans.js): an exit a little past the stop is the stop
    // working, not a broken one; only beyond 10% of the risk carried does it count as moved
    const {sg,tol}=planStopBand(t,p);
    const exitOk = sg*(t.avgExit-p.stop)>=-tol;
    const e=excM&&excM[t.id];
    const stopDistPct=(short?(p.stop-t.avgEntry):(t.avgEntry-p.stop))/t.avgEntry*100;
    const worst=e&&e.maePct!=null?t.avgEntry*(1-sg*e.maePct/100):null;
    const heldThrough = !!(exitOk&&worst!=null&&!e.coarse&&stopDistPct>0&&sg*(p.stop-worst)>tol);
    const stopHonored = exitOk&&!heldThrough;
    const at=+((j.plan&&j.plan.at)||0);
    const live = at>0&&t.closeTime>0 ? at<t.closeTime : null;
    const targetHit = p.target!=null ? (short ? t.avgExit<=p.target : t.avgExit>=p.target) : null;
    const plannedRR = p.target!=null ? Math.abs(p.target-p.entry)/riskPer : null;
    const plannedRisk$ = riskPer*(t.maxSize||0);
    const realizedR = plannedRisk$>0 ? t.net/plannedRisk$ : null;
    items.push({id:t.id, coin:dcoin(t), stopHonored, heldThrough, live, targetHit, plannedRR, realizedR, net:t.net}); }
  const n=items.length;
  const liveArr=items.filter(x=>x.live===true), hindArr=items.filter(x=>x.live===false);
  const rate=a=>a.length?a.filter(x=>x.stopHonored).length/a.length:null;
  const honored=items.filter(x=>x.stopHonored).length;
  const tHitArr=items.filter(x=>x.targetHit!=null);
  const tHit=tHitArr.filter(x=>x.targetHit).length;
  const rrPlan=nfMedian(items.map(x=>x.plannedRR).filter(x=>x!=null));
  const rrReal=nfMedian(items.map(x=>x.realizedR).filter(x=>x!=null));
  return {n, items, stopHonoredRate:n?honored/n:null,
    targetHitRate:tHitArr.length?tHit/tHitArr.length:null, medPlannedRR:rrPlan, medRealizedR:rrReal,
    brokeStopCost:items.filter(x=>!x.stopHonored).reduce((s,x)=>s+x.net,0),
    heldThroughN:items.filter(x=>x.heldThrough).length,
    liveN:liveArr.length, hindsightN:hindArr.length, liveHonoredRate:rate(liveArr), hindsightHonoredRate:rate(hindArr)};
}

/* ======================= 6 · WALLET / SETUP LEADERBOARD ======================= */
function nfGroupStats(trades){
  const closed=trades.filter(t=>!t.isOpen&&t.closeTime);
  const n=closed.length; if(!n)return null;
  const net=closed.reduce((s,t)=>s+t.net,0);
  const wins=closed.filter(t=>isWin(t.net)).length, losses=closed.filter(t=>isLoss(t.net)).length;
  const winRate=(wins+losses)?wins/(wins+losses):null;
  const expectancy=net/n;
  const chron=[...closed].sort((a,b)=>a.closeTime-b.closeTime);
  let cum=0,peak=0,mdd=0; for(const t of chron){ cum+=t.net; if(cum>peak)peak=cum; const dd=cum-peak; if(dd<mdd)mdd=dd; }
  let sharpe=null; try{ const ss=sharpeStats(dailySeriesCalendar(closed)); sharpe=ss?ss.sr:null; }catch(e){} // .sr — sharpeStats has no .sharpe key, so this column was always a dash
  return {n, net, winRate, expectancy, maxDD:mdd, sharpe};
}
function leaderboard(closed){
  const byWallet={}, bySetup={};
  for(const t of closed){
    const wk=(t.wallet&&(t.wallet.label||t.wallet.address))||'\u2014'; (byWallet[wk]=byWallet[wk]||[]).push(t);
    const j=journal[t.id]; const su=j&&j.setup&&j.setup.trim(); if(su){ (bySetup[su]=bySetup[su]||[]).push(t); }
  }
  const pack=obj=>Object.keys(obj).map(k=>({label:k, ...nfGroupStats(obj[k])})).filter(x=>x&&x.n).sort((a,b)=>b.net-a.net);
  return {wallets:pack(byWallet), setups:pack(bySetup)};
}

/* ======================= 7 · FUNDING CARRY ======================= */
function fundingCarry(closed){
  let paid=0, recv=0, total=0, flipped=0, dominant=0;
  const byCoin={};
  for(const t of closed){ const f=t.funding||0; total+=f; if(f<0)paid+=-f; else recv+=f;
    const c=dcoin(t); const g=byCoin[c]=byCoin[c]||{coin:c, funding:0, n:0}; g.funding+=f; g.n++;
    const gross=t.pnl-t.fees; // pre-funding
    if(isWin(gross) && !isWin(t.net)) flipped++;      // funding turned a gross winner into a non-winner
    if(Math.abs(f)>Math.abs(gross) && Math.abs(f)>0) dominant++; // funding bigger than the trade result itself
  }
  const coins=Object.values(byCoin).sort((a,b)=>Math.abs(b.funding)-Math.abs(a.funding));
  const netPnl=closed.reduce((s,t)=>s+t.net,0);
  return {total, paid, recv, flipped, dominant, coins, shareOfNet:netPnl!==0?total/netPnl:null, n:closed.length};
}

/* ======================= diagnostic cards (2,4,5,7) ======================= */
// Concatenated into the Diagnostic view; wired by nfWireDiag.
function nfDiagExtra(closed){
  const mrow=(l,v,tip)=>`<div class="metric-row"${tip?` data-tip="${esc(tip)}"`:''}><span class="ml">${l}</span><span class="mv">${v}</span></div>`;
  // 7 funding carry
  const fc=fundingCarry(closed);
  const fcRows=fc.coins.slice(0,6).map(c=>mrow(esc(c.coin),(c.funding>=0?'<span class="pos-t">+':'<span class="neg-t">')+fmtUsd(c.funding)+'</span>','Net funding on this coin over the period.')).join('');
  const fcHtml=`<div class="diag-card"><h3 data-tip="Funding is the quiet cost/credit of holding perps. This isolates it: what you paid, what flipped a gross winner into a loss, and where it concentrates.">Funding carry</h3>
    ${mrow('Net funding',(fc.total>=0?'<span class="pos-t">+':'<span class="neg-t">')+fmtUsd(fc.total)+'</span>','Total funding over the period (+ received / \u2212 paid). Already inside every net figure.')}
    ${mrow('Paid / received',fmtUsd(fc.paid)+' / '+fmtUsd(fc.recv),'Gross funding out vs in.')}
    ${mrow('Winners flipped by funding',fc.flipped?('<span class="loss">'+fc.flipped+'</span>'):'0','Trades that were profitable before funding but closed at break-even or worse after it.')}
    ${mrow('Funding-dominated trades',String(fc.dominant),'Trades where the funding paid/received was larger than the trade\u2019s own gross result.')}
    ${fc.shareOfNet!=null?mrow('Share of net PnL',nfSignPct(fc.shareOfNet),'Net funding as a fraction of net PnL \u2014 how much of your bottom line is carry, not directional edge.'):''}
    ${fcRows?'<div style="margin-top:8px;border-top:1px solid var(--line);padding-top:6px">'+fcRows+'</div>':''}</div>`;
  // 2 leverage survivability
  const excN=Object.keys(_excM||{}).length;
  const assumedLev=(settings.assumedLev>0?settings.assumedLev:5);
  let levHtml;
  if(!excN){ levHtml=`<div class="diag-card"><h3 data-tip="Uses your realized worst adverse excursion (MAE). Run Price excursions first.">Leverage survivability</h3><p class="lead">Run <b>Price excursions</b> above first \u2014 this reuses that MAE data.</p></div>`; }
  else { const ls=leverageSurvival(closed,_excM,assumedLev);
    const worst=ls.rows.slice(0,5).map(r=>mrow(esc(r.coin)+(r.coarse?' \u2248':''),'liq &gt; <b>'+r.maxLev.toFixed(1)+'x</b>','This trade\u2019s worst adverse excursion was '+r.maePct.toFixed(2)+'% \u2014 it would have been liquidated above roughly '+r.maxLev.toFixed(1)+'x.')).join('');
    levHtml=`<div class="diag-card"><h3 data-tip="At a given leverage, a position is wiped when the adverse move reaches ~1/leverage. Applying each trade\u2019s realized worst excursion (MAE) tells you which trades only survived because you weren\u2019t levered into them. First-order: ignores the maintenance-margin haircut and cross-margin, so real liquidation is a touch earlier.">Leverage survivability <span style="font-size:11px;color:var(--faint);font-weight:400">from realized MAE</span></h3>
      <div class="calc-row" style="margin-bottom:6px">Assume <input type="number" id="nfLev" value="${assumedLev}" min="1" step="any" style="width:64px">x leverage</div>
      ${mrow('Trades that would have liquidated','<span class="'+(ls.wouldLiq.length?'loss':'pos-t')+'">'+ls.wouldLiq.length+' / '+ls.n+'</span>','How many of your measured trades touched a full-margin loss at '+assumedLev+'x, given their realized worst excursion.')}
      ${mrow('Median survivable leverage',ls.medMaxLev!=null?ls.medMaxLev.toFixed(1)+'x':'\u2014','Half your trades could have withstood at least this much leverage before their worst excursion wiped the margin.')}
      ${worst?'<div style="margin-top:8px;border-top:1px solid var(--line);padding-top:6px"><div class="mini-note" style="margin:0 0 4px">Thinnest-margin trades:</div>'+worst+'</div>':''}</div>`; }
  // 5 plan adherence
  const pa=planAdherence(closed,journal,_excM);
  let paHtml;
  if(!pa.n){ paHtml=`<div class="diag-card"><h3 data-tip="Fill in a plan (entry / stop / target) on a trade\u2019s journal row to score it.">Plan adherence</h3><p class="lead">No trade plans logged yet. Add <b>entry / stop / target</b> in a trade\u2019s journal to start scoring discipline.</p></div>`; }
  else { paHtml=`<div class="diag-card"><h3 data-tip="Scores the plans you wrote down (entry/stop/target) against where you actually got out. Stop-honored = price didn\u2019t close beyond your stop.">Plan adherence <span style="font-size:11px;color:var(--faint);font-weight:400">${pa.n} planned</span></h3>
    ${mrow('Stop-honored rate','<span class="'+((pa.stopHonoredRate||0)>=0.8?'pos-t':'neg-t')+'">'+nfPct(pa.stopHonoredRate)+'</span>','Share of planned trades where you did not let price close past your stop.')}
    ${pa.targetHitRate!=null?mrow('Target-hit rate',nfPct(pa.targetHitRate),'Share of planned trades (with a target) that reached it.'):''}
    ${mrow('Planned vs realized R','med '+(pa.medPlannedRR!=null?pa.medPlannedRR.toFixed(2)+'R':'\u2014')+' \u2192 '+(pa.medRealizedR!=null?(pa.medRealizedR>=0?'+':'')+pa.medRealizedR.toFixed(2)+'R':'\u2014'),'Median planned reward:risk vs the R you actually realized against that plan\u2019s risk.')}
    ${mrow('Cost of blowing stops',pa.brokeStopCost<0?('<span class="loss">'+fmtUsd(pa.brokeStopCost)+'</span>'):fmtUsd(pa.brokeStopCost),'Total net PnL on the planned trades where you held past your stop.')}
    ${pa.heldThroughN&&coachOn()?mrow('Held through the stop','<span class="neg-t">'+pa.heldThroughN+'</span>','Price traded past your planned stop (from candle excursions) and you stayed in anyway — even if the exit later recovered. Counted as a broken stop above. Run Price excursions to measure more trades.'):''}
    ${(pa.liveN||pa.hindsightN)&&coachOn()?mrow('Written live vs after',pa.liveN+' live ('+nfPct(pa.liveHonoredRate,0)+' honored) · '+pa.hindsightN+' after close ('+nfPct(pa.hindsightHonoredRate,0)+')','A plan saved while the position was still open is a commitment; one written after the close is hindsight, and usually flatters you. Plans saved before this was tracked are in neither bucket.'):''}</div>`; }
  // 4 rules
  const R=nfRules(); const rc=evaluateRules(closed,R);
  const ruleInputs=`<div class="calc-row" style="flex-wrap:wrap;gap:10px;margin-bottom:8px">
     <label>Max trades/day <input type="number" id="nfRuleMax" value="${R.maxPerDay||''}" min="0" step="1" style="width:56px" placeholder="off"></label>
     <label>Cooldown after loss <input type="number" id="nfRuleCool" value="${R.cooldownMin||''}" min="0" step="1" style="width:56px" placeholder="min">min</label>
     <label>Daily loss limit $ <input type="number" id="nfRuleDLL" value="${R.dailyLossLimit||''}" min="0" step="any" style="width:80px" placeholder="off"></label>
     <label class="chk ${R.noAddToLosers?'on':''}" style="display:inline-flex"><input type="checkbox" id="nfRuleNAL" ${R.noAddToLosers?'checked':''}>No adds to losers</label></div>`;
  const rcRows=rc.length?rc.map(r=>mrow(esc(r.rule),(r.n?('<span class="'+(r.cost<0?'loss':'pos-t')+'">'+r.n+(r.unit?' '+esc(r.unit.split(',')[0]):'')+' \u00b7 '+fmtUsd(r.cost)+'</span>'):'<span class="pos-t">0 \u2014 clean</span>'),r.unit||'Count of violating trades and their net PnL.')).join(''):'<p class="lead">Set a threshold above to score a rule.</p>';
  let crHtml=''; try{ crHtml=customRulesHtml(closed); }catch(e){ console.warn('custom rules failed',e); }
  const rulesHtml=`<div class="diag-card"><h3 data-tip="Define personal rules; the app scores how often you broke each one and what it cost. A broken rule with a price is easier to fix than a vague resolution. Also drives the live daily-loss banner.">Discipline &amp; rules</h3>${ruleInputs}${rcRows}${crHtml}</div>`;
  return `<div class="diag-section"><h2>Discipline, carry &amp; leverage</h2>
     <div class="diag-grid">${rulesHtml}${paHtml}</div>
     <div class="diag-grid" style="margin-top:14px">${fcHtml}${levHtml}</div></div>`;
}
function nfWireDiag(closed){
  // rules -> persist + re-render tripwire
  const saveRules=async()=>{ const r=settings.rules||(settings.rules={});
    const gi=id=>{ const e=$(id); return e?e.value:''; };
    r.maxPerDay=parseInt(gi('nfRuleMax'))||0; r.cooldownMin=parseInt(gi('nfRuleCool'))||0;
    r.dailyLossLimit=parseFloat(gi('nfRuleDLL'))||0; r.noAddToLosers=!!($('nfRuleNAL')&&$('nfRuleNAL').checked);
    if(r.dailyLossLimit>0)askNotifyPerm(); // save gesture — the one acceptable moment to ask
    await Store.set(S_KEY,settings); renderTripwire(); };
  ['nfRuleMax','nfRuleCool','nfRuleDLL'].forEach(id=>{ const e=$(id); if(e)e.onchange=saveRules; });
  const nal=$('nfRuleNAL'); if(nal)nal.onchange=saveRules;
  wireCustomRules();
  // leverage survivability recompute on assumed-leverage change (persist)
  const lev=$('nfLev'); if(lev)lev.onchange=async()=>{ const v=parseFloat(lev.value); settings.assumedLev=v>0?v:5;
    await Store.set(S_KEY,settings); if(activeTab==='diag')renderDiagnostic(periodTrades(),periodTradesAll()); };
}

/* ======================= 3 · PRE-TRADE SIZER (Project) ======================= */
function nfSizerHtml(){
  const acct=Math.round(((accountValue||0)+(spotAccountValue||0))||0);
  const k=kellyFromTrades(periodTrades().filter(t=>!t.isOpen));
  const halfK=k&&k.kelly!=null?(k.kelly/2*100):null;
  const mrow=(l,v)=>`<div class="metric-row"><span class="ml">${l}</span><span class="mv">${v}</span></div>`;
  return `<div class="diag-section"><h2>Pre-trade sizer <span style="font-size:11px;color:var(--faint);font-weight:400">forward tool</span></h2>
    <div class="diag-card"><h3 data-tip="Size the next trade from your account, a risk budget and a stop distance. It flags when your chosen risk exceeds the half-Kelly ceiling implied by this view\u2019s edge.">Size the next trade</h3>
      <div class="calc-row" style="flex-wrap:wrap;gap:10px">
        Account <input type="number" id="nfSzAcct" value="${acct||''}" min="0" step="any" placeholder="$" style="width:110px">
        risk <input type="number" id="nfSzRisk" value="${halfK!=null?halfK.toFixed(1):'1'}" min="0" step="any" style="width:64px">%
        entry <input type="number" id="nfSzEntry" step="any" placeholder="px" style="width:100px">
        stop <input type="number" id="nfSzStop" step="any" placeholder="px" style="width:100px"></div>
      <div style="margin-top:10px">
        ${mrow('Risk budget','<span class="calc-out" id="nfSzRiskOut">\u2014</span>')}
        ${mrow('Position notional','<span class="calc-out" id="nfSzNotOut">\u2014</span>')}
        ${mrow('Position size (coins)','<span class="calc-out" id="nfSzQtyOut">\u2014</span>')}
        ${mrow('Implied leverage','<span class="calc-out" id="nfSzLevOut">\u2014</span>')}
        <div id="nfSzWarn" class="mini-note" style="margin-top:6px"></div></div>
      <p class="mini-note" style="margin-top:8px">${halfK!=null?'Half-Kelly ceiling from this view\u2019s edge: <b>'+halfK.toFixed(1)+'%</b> per trade.':'Not enough closed trades in this view for a Kelly ceiling yet.'}</p>
    </div></div>`;
}
function nfWireSizer(){
  const halfK=(function(){ const k=kellyFromTrades(periodTrades().filter(t=>!t.isOpen)); return k&&k.kelly!=null?k.kelly/2*100:null; })();
  const calc=()=>{ const acct=parseFloat($('nfSzAcct')&&$('nfSzAcct').value), risk=parseFloat($('nfSzRisk')&&$('nfSzRisk').value),
      entry=parseFloat($('nfSzEntry')&&$('nfSzEntry').value), stop=parseFloat($('nfSzStop')&&$('nfSzStop').value);
    if(!$('nfSzRiskOut'))return;
    const rDollar=(acct>0&&risk>0)?acct*risk/100:null;
    $('nfSzRiskOut').textContent=rDollar!=null?fmtUsd(rDollar):'\u2014';
    const stopFrac=(entry>0&&stop>0)?Math.abs(entry-stop)/entry:null;
    const notl=(rDollar!=null&&stopFrac>0)?rDollar/stopFrac:null;
    $('nfSzNotOut').textContent=notl!=null?fmtUsd(notl):'\u2014';
    $('nfSzQtyOut').textContent=(notl!=null&&entry>0)?(notl/entry).toLocaleString(undefined,{maximumFractionDigits:6}):'\u2014';
    const lev=(notl!=null&&acct>0)?notl/acct:null;
    $('nfSzLevOut').innerHTML=lev!=null?(lev.toFixed(2)+'x'):'\u2014';
    const warn=$('nfSzWarn'); if(warn){ let msg='';
      if(halfK!=null&&risk>halfK) msg='<span class="loss">\u26a0 '+risk.toFixed(1)+'% exceeds the half-Kelly ceiling of '+halfK.toFixed(1)+'%.</span>';
      else if(lev!=null&&lev>20) msg='<span class="loss">\u26a0 '+lev.toFixed(1)+'x is very high leverage.</span>';
      warn.innerHTML=msg; } };
  ['nfSzAcct','nfSzRisk','nfSzEntry','nfSzStop'].forEach(id=>{ const e=$(id); if(e)e.oninput=calc; }); calc();
}

/* ======================= 6 · leaderboard render (Review) ======================= */
function nfLeaderboardHtml(closed){
  const lb=leaderboard(closed);
  const multi=settings.wallets.length>1;
  const cell=(x)=>`<tr><td class="l">${esc(x.label)}</td><td style="text-align:right">${x.n}</td>
    <td style="text-align:right" class="${cls(x.net)}">${fmtUsd(x.net)}</td>
    <td style="text-align:right" class="${cls(x.expectancy)}">${fmtUsd(x.expectancy)}</td>
    <td style="text-align:right">${x.winRate!=null?(x.winRate*100).toFixed(0)+'%':'\u2014'}</td>
    <td style="text-align:right" class="neg-t">${fmtUsd(x.maxDD)}</td>
    <td style="text-align:right">${x.sharpe!=null?x.sharpe.toFixed(2):'\u2014'}</td></tr>`;
  const head=`<thead><tr><th class="l">Name</th><th style="text-align:right">Trades</th><th style="text-align:right">Net</th><th style="text-align:right">Exp/trade</th><th style="text-align:right">Win%</th><th style="text-align:right">Max DD</th><th style="text-align:right">Sharpe</th></tr></thead>`;
  const walletTbl=(multi&&lb.wallets.length>1)?`<div class="diag-card"><h3 data-tip="Each wallet scored as its own book, current view/period. Sharpe is of daily net PnL.">By wallet</h3>
      <div class="tbl-wrap"><table class="trades" style="width:100%">${head}<tbody>${lb.wallets.map(cell).join('')}</tbody></table></div></div>`:'';
  const setupTbl=lb.setups.length?`<div class="diag-card"><h3 data-tip="Each journaled setup treated as a pseudo-strategy. Only trades with a Setup filled in appear.">By setup</h3>
      <div class="tbl-wrap"><table class="trades" style="width:100%">${head}<tbody>${lb.setups.slice(0,12).map(cell).join('')}</tbody></table></div></div>`:'';
  if(!walletTbl&&!setupTbl)return '';
  return `<div class="diag-section"><h2>Leaderboard <span style="font-size:11px;color:var(--faint);font-weight:400">${view} \u00b7 current period</span></h2>
    <p class="lead">Which wallet and which setup is actually carrying the account. Ranked by net; Sharpe is of daily net PnL, Max DD on cumulative PnL.</p>
    <div class="diag-grid">${walletTbl}${setupTbl}</div></div>`;
}

/* ======================= 8 · HABITS: rules from findings · journal inbox · process score ======================= */
// Rules made from miner / what-if conditions live in settings.rules.custom — {pid, name,
// params, createdAt} — so they sync, merge and back up with the built-in rules. A rule is a
// pinned condition turned into a "don't": the same stable pid + frozen thresholds the forward
// tracker uses, resolved with resolvePinPred, so its name and its test never drift apart.
function customRules(){ const r=settings.rules; return r&&Array.isArray(r.custom)?r.custom:[]; }
// Entry-knowable conditions can be judged the moment a position opens, so they get a live
// warning chip. Hold time, excursion shape, close-hour sessions and ratings only exist once
// the trade is closed (or journaled) — those rules are scored after the fact only.
function ruleIsLive(pid){
  const LIVE=['dir:','mkt:','st:','size:','setup:','tag:','ck:'];
  return String(pid||'').split('&').every(p=>LIVE.some(x=>p.startsWith(x)));
}
async function addCustomRule(c){
  if(!c||!c.pid)return false;
  const r=settings.rules||(settings.rules={});
  if(!Array.isArray(r.custom))r.custom=[];
  if(r.custom.some(x=>x.pid===c.pid))return false;
  r.custom.push({pid:c.pid,name:c.name,params:c.params||{},createdAt:Date.now()});
  await Store.set(S_KEY,settings); return true;
}
async function removeCustomRule(pid){
  const r=settings.rules; if(!r||!Array.isArray(r.custom))return;
  r.custom=r.custom.filter(x=>x.pid!==pid);
  await Store.set(S_KEY,settings);
}
// One predicate per rule over closed AND open trades. Open trades join the state model with
// closeTime=Infinity so entry-time states (streaks, day PnL, re-entry gaps) see exactly the
// closes that preceded them; thresholds come from the rule's frozen params.
// the same trades, rules and journal ask for the same predicates on every render: kept until one changes
function customRulePreds(trades, rules){
  const sig=JSON.stringify(rules||[])+'|'+_be+'|'+(trades?trades.length:0)+'|'+(typeof _jrev!=='undefined'?_jrev:0)+'|'+(settings.tz||'')+'|'+(settings.tzZone||''), m=customRulePreds._m;
  if(m&&m.trades===trades&&m.sig===sig)return m.out;
  const out=customRulePredsNow(trades, rules); customRulePreds._m={trades,sig,out}; return out;
}
function customRulePredsNow(trades, rules){
  const pool=(trades||[]).map(t=>(t.isOpen||!t.closeTime)?Object.assign({},t,{closeTime:Infinity}):t);
  const chron=pool.slice().sort((a,b)=>a.openTime-b.openTime);
  const ST=tradeStates(chron);
  const closed=chron.filter(t=>isFinite(t.closeTime));
  return (rules||[]).map(r=>{ let pred=null; try{ pred=resolvePinPred(r,closed,ST); }catch(e){}
    const safe=pred?(t=>{ try{ return !!pred(t); }catch(e){ return false; } }):null;
    return {rule:r, pred:safe, live:ruleIsLive(r.pid)}; });
}
// Did making the rule change what you do? Share of trades (by entry time) breaking it before
// vs after the rule existed, one-sided two-proportion z-test for "fewer breaks after".
function ruleFollowThrough(closed, pred, createdAt){
  let nB=0,vB=0,netB=0,nA=0,vA=0,netA=0;
  for(const t of (closed||[])){ const v=!!pred(t);
    if(t.openTime<createdAt){ nB++; if(v){ vB++; netB+=t.net; } }
    else { nA++; if(v){ vA++; netA+=t.net; } } }
  const rB=nB?vB/nB:null, rA=nA?vA/nA:null;
  let p=null;
  if(nB>=5&&nA>=5){ const pp=(vB+vA)/(nB+nA), se=Math.sqrt(pp*(1-pp)*(1/nB+1/nA));
    p=se>0?1-_normCdf((rB-rA)/se):(rA<rB?0:1); }
  const status = nA<10?'collecting'
    : !vB&&!vA?'clean'
    : !nB?'no baseline'
    : (rA<rB&&p!=null&&p<0.10)?'working'
    : rA<rB?'improving':'not yet';
  return {before:{n:nB,v:vB,rate:rB,net:netB}, after:{n:nA,v:vA,rate:rA,net:netA}, p, status};
}
// customRulePreds over all trades, rebuilt only when trades, rules or the clock setting change.
let _lrpMemo={key:null,preds:null};
function liveRulePreds(){
  let last=0; for(const t of allTrades){ const x=t.closeTime||t.openTime||0; if(x>last)last=x; }
  const key=[allTrades.length,last,settings.tz,JSON.stringify(customRules()),_jrev].join('|');
  if(_lrpMemo.key!==key)_lrpMemo={key,preds:customRulePreds(allTrades,customRules())};
  return _lrpMemo.preds;
}
// Open positions breaking a live rule right now.
function liveRuleHits(openTrades, preds){
  const out=[];
  for(const x of (preds||[])){ if(!x.live||!x.pred)continue;
    for(const t of (openTrades||[])) if(x.pred(t))out.push({rule:x.rule,t}); }
  return out;
}

// ---- journal inbox + streak ----
function isJournaled(j){ return !!(j&&(j.notes||j.setup||(j.tags&&j.tags.length)||j.rating||(j.mistakes&&j.mistakes.length))); }
// Closed trades from the last `days` days with nothing journaled, newest first. A skipped trade
// (j.skip, from the quick journal) stays out of it without counting as journaled.
function journalInbox(trades, journalObj, now, days){
  const cut=(now||Date.now())-(days||30)*86400000, J=journalObj||{};
  return (trades||[]).filter(t=>!t.isOpen&&t.closeTime>=cut&&!isJournaled(J[t.id])&&!(J[t.id]&&J[t.id].skip))
    .sort((a,b)=>b.closeTime-a.closeTime);
}
// Consecutive trading days (by close day, newest first) on which every trade is journaled.
// Today doesn't break the streak while it's still being traded — it only adds once complete.
function journalStreak(trades, journalObj, dayOf, todayK){
  const by={};
  for(const t of (trades||[])){ if(t.isOpen||!t.closeTime)continue; const k=dayOf(t.closeTime); (by[k]=by[k]||[]).push(t); }
  const keys=Object.keys(by).sort().reverse();
  const full=k=>by[k].every(t=>isJournaled((journalObj||{})[t.id]));
  let cur=0, i=0;
  if(keys[0]===todayK&&!full(keys[0]))i=1;
  for(;i<keys.length;i++){ if(full(keys[i]))cur++; else break; }
  let best=0, run=0;
  for(const k of keys.slice().reverse()){ if(full(k)){ run++; if(run>best)best=run; } else run=0; }
  return {current:cur, best, days:keys.length};
}

// ---- process score ----
// A daily grade for HOW you traded, independent of what the market paid. Parts (0–1 each,
// weights fixed and shown): plan filed before the first entry · trades breaking no rule ·
// trades with a plan written live · planned stops honored · no entries after the day's loss
// limit broke · trades journaled. Parts that don't apply that day drop out of the weighting
// ("rules kept" only counts once you have rules; opts.rulesActive=false drops it) —
// and the two planning habits only apply from the first day you ever used them, so history
// from before the habit existed isn't graded against it.
// opts.trades: every trade, open ones included (default: closed). The day's first entry and the
// entries after a loss-limit breach come from all of them — a position opened today and still open,
// or closing tomorrow, is still today's entry — and the day's realized result is read fill by fill.
// When it was set (X4 in AUDIT-4): a day entry's plan, committed max loss and check-in only count
// when they were set in time — plannedAt / limitAt / checkinAt, stamped by nextDayEntry. A plan by the
// first entry is whole, later that same day half, on a later day nothing; a max loss set after the
// first entry is ignored (the standing daily limit applies, if any); a check-in counts on or before
// its day. A field saved before the stamps existed (it has no stamp; nextDayEntry stamps everything
// set since and leaves an unchanged old field unstamped) keeps the benefit of the doubt it always had,
// so no honest day loses credit it already earned. Anything typed onto an old day now is stamped now:
// it still journals, but earns nothing. credit.checkin carries the check-in's verdict to pzBonus.
const PROCESS_W={plan:20,rules:20,planned:15,stops:15,limit:10,journal:20,playbook:10};
function processDays(closed, journalObj, opts){
  opts=opts||{}; const J=journalObj||{};
  const viol=opts.violIds||new Set(), dayOf=opts.dayOf;
  const pa=planAdherence(closed,J,opts.excM);
  const paBy=new Map(pa.items.map(x=>[x.id,x]));
  const by={};
  for(const t of closed){ if(t.isOpen||!t.closeTime)continue; const k=dayOf(t.closeTime); (by[k]=by[k]||[]).push(t); }
  // each day's entries across all trades (a spot holding carried on after a partial sale is not one)
  const all=opts.trades||closed, firstIn={}, lastIn={};
  for(const t of all){ if(!t.openTime||t.carried)continue; const k=dayOf(t.openTime);
    if(!(firstIn[k]<=t.openTime))firstIn[k]=t.openTime; if(!(lastIn[k]>=t.openTime))lastIn[k]=t.openTime; }
  let rz=null; // realized results by day, built on the first day that has a loss limit
  const out=[];
  const hasDayPlan=d=>!!(d&&(d.plan||d.bias||d.maxLoss>0||(r=>!!r&&typeof r==='object'&&Object.values(r).some(v=>Array.isArray(v)?v.length:!!v))(d.rules)));
  const planDays=Object.keys(J).filter(k=>k.startsWith('day:')&&hasDayPlan(J[k])).map(k=>k.slice(4)).sort();
  const minK=(a,b)=>a&&b?(a<b?a:b):(a||b||null);
  const pf=opts.planFrom||{};
  // a planning habit you adopted grades from its adoption day even before your first plan
  const firstDayPlan=minK(planDays.length?planDays[0]:null,pf.plan);
  let firstTradePlan=null;
  for(const t of closed) if(paBy.has(t.id)){ const k=dayOf(t.closeTime); if(!firstTradePlan||k<firstTradePlan)firstTradePlan=k; }
  firstTradePlan=minK(firstTradePlan,pf.planned);
  const inWin=(part,k)=>(opts.planWindows||[]).some(w=>w.part===part&&k>=w.from&&k<w.to);
  for(const k of Object.keys(by).sort()){
    const arr=by[k].sort((a,b)=>a.closeTime-b.closeTime), n=arr.length;
    const de=J['day:'+k]||null, parts={}, first=firstIn[k]!=null?firstIn[k]:null;
    // when a logged field was set: its own stamp, else (saved before stamps existed) the benefit of the doubt
    const setAt=f=>!de?null:de[f]>0?+de[f]:'legacy';
    const inTime=at=>at==='legacy'||(at!=null&&(first!=null?at<=first:dayOf(at)<=k));
    if(first!=null&&((firstDayPlan&&k>=firstDayPlan)||inWin('plan',k))){
      const at=hasDayPlan(de)?setAt('plannedAt'):null;
      // a plan written after the first entry earns half — that same day; on a later day, nothing
      parts.plan=at==null?0:inTime(at)?1:dayOf(at)<=k?0.5:0;
    }
    if(opts.rulesActive!==false&&!(opts.rulesFrom&&k<opts.rulesFrom))parts.rules=1-arr.filter(t=>viol.has(t.id)).length/n;
    const pl=arr.map(t=>paBy.get(t.id)).filter(Boolean);
    if((firstTradePlan&&k>=firstTradePlan)||inWin('planned',k))parts.planned=pl.filter(x=>x.live!==false).length/n;
    if(pl.length)parts.stops=pl.filter(x=>x.stopHonored).length/pl.length;
    // a max loss committed after the first entry (or typed onto an old day) doesn't count
    const lim=(de&&de.maxLoss>0&&inTime(setAt('limitAt')))?de.maxLoss:(opts.dllLimit||0);
    let breached=false;
    if(lim>0){ let cum=0, breachAt=null;
      if(!rz)rz=realizedByDay(all,dayOf);
      for(const [tm,v] of (rz[k]||[])){ cum+=v; if(cum<=-lim){ breachAt=tm; break; } }
      breached=breachAt!=null;
      parts.limit=(breached&&lastIn[k]>breachAt)?0:1; }
    parts.journal=arr.filter(t=>isJournaled(J[t.id])).length/n;
    // playbook rules kept: of the day's trades with a filled-in checklist, the share that kept every rule (a day without one isn't graded on it)
    if(opts.pbChecked){ const pc=arr.filter(t=>opts.pbChecked.has(t.id)); if(pc.length)parts.playbook=1-pc.filter(t=>opts.pbBroke&&opts.pbBroke.has(t.id)).length/pc.length; }
    let sw=0, sv=0; for(const p in parts){ sw+=PROCESS_W[p]; sv+=PROCESS_W[p]*parts[p]; }
    const checkin=!!(de&&(de.sleep||de.stress||de.focus)), ckAt=checkin?setAt('checkinAt'):null;
    out.push({key:k, score:Math.round(100*sv/sw), parts, n, net:arr.reduce((s,t)=>s+t.net,0), breached, first,
      credit:{checkin:checkin&&(ckAt==='legacy'||(ckAt!=null&&dayOf(ckAt)<=k))}});
  }
  return out;
}
// Process vs outcome: good process = score ≥ thr. "Earned" and "good loss" are the days to
// repeat; "lucky" green days are the dangerous ones — they teach the wrong lesson.
function processQuadrants(days, thr){
  thr=thr==null?70:thr;
  const q={earned:{n:0,net:0},goodLoss:{n:0,net:0},lucky:{n:0,net:0},deserved:{n:0,net:0}};
  for(const d of (days||[])){ const g=d.score>=thr, up=d.net>=0;
    const b=g?(up?q.earned:q.goodLoss):(up?q.lucky:q.deserved); b.n++; b.net+=d.net; }
  return q;
}
function processTrend(days, win){
  win=win||20; const s=(days||[]).map(d=>d.score);
  const last=s.slice(-win), prev=s.slice(-2*win,-win);
  let streak=0; for(let i=s.length-1;i>=0&&s[i]>=70;i--)streak++;
  return {avg:last.length?_avg(last):null, prevAvg:prev.length?_avg(prev):null, streak, n:s.length};
}
/* ---- routine vs results: does your discipline pay, over the long run? ---- */
// Pure. days: Pulse's day list ({key, behavior: pzBehaviorDays' day, parts}); byDay: {key: closed
// trades}; opts: {rOf(t)->R|null, pctOf(t)->% return|null, weekOf(key), entryOf(key)->{checkin,review}, seed}.
// The routine score is OUTCOME-BLIND (rvRoutineOf): for revenge entries, sizing up after a loss, adding
// to a loser and overtrading, the share of the day's CHANCES at each that were kept. The two checks that
// can only fail on a losing trade (holding a loser, trading on after two losses) are left out. Results
// are per trade, in R when most trades have a risk, else % return on notional (both size-neutral).
// Everything is seeded, so it reproduces.
const RV_BLIND=['revenge','sizeUp','addLoser','overtrade'];
// Revenge and sizing up can only be tested on an entry that FOLLOWS A LOSS, and that loss sits in the
// same day's result: a day with more losses has more chances to slip. Scoring the share of trades free
// of slips, or grading whole days kept / missed, therefore found "discipline pays" on pure coin flips
// (AUDIT-4 E1: identical behaviour, ±1R coin flips → ρ 0.87, p 0.001). So the score conditions on the
// opportunity, and these two habits are tested trade by trade: post-loss entries that slipped against
// post-loss entries that didn't — each entry's own result, never the loss that triggered it.
const RV_CHANCE=['revenge','sizeUp'];
// The routine of a day, check by check: kept ÷ chances (pzBehaviorDays). A day with no chance at a
// check takes your own rate at it over these days, so having had a loss (or not) can't move the score
// on average; a check never tested in these days is left out. Returns d → {score 0–100 (100: nothing
// testable), rate, stratum}. The spread still depends on how many chances the day had (none: exactly
// your usual rate), so comparisons that cut at a line (the dividend) or permute days (habitLink) stay
// inside a stratum: the day's chances at each post-loss check (RV_CHANCE), 0 / 1 / 2 / 3+ each.
function rvRoutineOf(days){
  const tot={}, kep={}, ch=(b,c)=>(b.chances&&b.chances[c])||0, kp=(b,c)=>Math.min(ch(b,c),(b.kept&&b.kept[c])||0);
  for(const c of RV_BLIND){ tot[c]=0; kep[c]=0; }
  for(const d of days||[]){ const b=d.behavior||{}; for(const c of RV_BLIND){ tot[c]+=ch(b,c); kep[c]+=kp(b,c); } }
  return d=>{ const b=d.behavior||{}, rate={}; let s=0, m=0;
    for(const c of RV_BLIND){ const n=ch(b,c), r=n?kp(b,c)/n:tot[c]?kep[c]/tot[c]:null; rate[c]=r; if(r!=null){ s+=r; m++; } }
    return {score:m?Math.round(100*s/m):100, rate, stratum:RV_CHANCE.map(c=>Math.min(3,ch(b,c))).join(':')}; };
}
// One chance-graded habit (RV_CHANCE), trade by trade: the values of the post-loss entries it was tested
// on, split into kept (k) and slipped (m). val(t) → number|null.
function rvChanceSplit(c, days, byDay, val){
  const k=[], m=[];
  for(const d of days||[]){ const b=d.behavior||{}, ids=(b.tests&&b.tests[c])||[]; if(!ids.length)continue;
    const slip=new Set((b.slips||[]).filter(x=>(x.f||[]).includes(c)).map(x=>x.id)), tr=new Map(((byDay&&byDay[d.key])||[]).map(t=>[t.id,t]));
    for(const id of ids){ const t=tr.get(id), v=t?val(t):null; if(v!=null&&isFinite(v))(slip.has(id)?m:k).push(v); } }
  return {k,m};
}
const RV_HABITS=[ // key, label, how a day is graded (true kept / false missed / null n.a.), mechanical?
  ['plan','Plan written before the first trade',d=>d.parts.plan==null?null:d.parts.plan>=1?true:d.parts.plan===0?false:null,false],
  ['rules','Your rules kept',d=>d.parts.rules==null?null:d.parts.rules>=1,false],
  ['planned','Stops written while the trade was open',d=>d.parts.planned==null?null:d.parts.planned>=1,false],
  ['checkin','Morning prep done',d=>d.checkin,false],
  ['review','End-of-day review written',d=>d.review,false],
  ['journal','Every trade journaled',d=>d.parts.journal==null?null:d.parts.journal>=1,false],
  ['revenge','No revenge entries',d=>!d.flags.revenge,false],
  ['sizeUp','No sizing up after a loss',d=>!d.flags.sizeUp,false],
  ['addLoser','No adding to losers',d=>!d.flags.addLoser,false],
  ['overtrade','No overtrading',d=>!d.flags.overtrade,false],
  ['stops','Stops honored',d=>d.parts.stops==null?null:d.parts.stops>=1,true],
  ['limit','Stayed under the loss limit',d=>d.parts.limit==null?null:d.parts.limit>=1,true],
];
// Spearman rank correlation, with a two-sided permutation p-value drawn from rnd (seeded by the caller)
function _seededRnd(seed){ seed=(seed>>>0)||1; return ()=>{ seed=seed+0x6D2B79F5|0; let t=Math.imul(seed^seed>>>15,1|seed); t=t+Math.imul(t^t>>>7,61|t)^t; return ((t^t>>>14)>>>0)/4294967296; }; }
function _spearmanWith(rnd){
  const mean=a=>a.length?a.reduce((x,y)=>x+y,0)/a.length:null;
  const ranks=a=>{ const idx=a.map((v,i)=>[v,i]).sort((x,y)=>x[0]-y[0]), r=new Array(a.length);
    for(let i=0;i<idx.length;){ let j=i; while(j+1<idx.length&&idx[j+1][0]===idx[i][0])j++; for(let k=i;k<=j;k++)r[idx[k][1]]=(i+j)/2+1; i=j+1; } return r; };
  const pearson=(x,y)=>{ const mx=mean(x), my=mean(y); let sxy=0,sx=0,sy=0; for(let i=0;i<x.length;i++){ sxy+=(x[i]-mx)*(y[i]-my); sx+=(x[i]-mx)**2; sy+=(y[i]-my)**2; } return sx>0&&sy>0?sxy/Math.sqrt(sx*sy):null; };
  return (x,y,perms)=>{ if(x.length<3)return null; const rx=ranks(x), ry=ranks(y), rho=pearson(rx,ry); if(rho==null)return null;
    let hits=0; const P=perms==null?1000:perms, sh=ry.slice();
    for(let k=0;k<P;k++){ for(let i=sh.length-1;i>0;i--){ const j=Math.floor(rnd()*(i+1)); [sh[i],sh[j]]=[sh[j],sh[i]]; } const r=pearson(rx,sh); if(r!=null&&Math.abs(r)>=Math.abs(rho)-1e-12)hits++; }
    return {rho,p:(hits+1)/(P+1),n:x.length}; };
}
function routineVsResults(days, byDay, opts){
  opts=opts||{};
  const rOf=opts.rOf||(()=>null), pctOf=opts.pctOf||(()=>null), weekOf=opts.weekOf||(k=>k.slice(0,7)), entryOf=opts.entryOf||(()=>({}));
  let seed=(opts.seed>>>0)||1; const rnd=()=>{ seed=seed+0x6D2B79F5|0; let t=Math.imul(seed^seed>>>15,1|seed); t=t+Math.imul(t^t>>>7,61|t)^t; return ((t^t>>>14)>>>0)/4294967296; };
  const mean=a=>a.length?a.reduce((x,y)=>x+y,0)/a.length:null;
  const all=[]; for(const d of days||[]) for(const t of (byDay[d.key]||[])) all.push(t);
  const withR=all.filter(t=>{ const r=rOf(t); return r!=null&&isFinite(r); }).length;
  const unit=all.length&&withR/all.length>=0.6?'R':'%';
  const res=t=>{ const v=unit==='R'?rOf(t):pctOf(t); return v!=null&&isFinite(v)?v:null; };
  // per day: outcome-blind score, per-trade results, habit grades
  const D=[], RT=rvRoutineOf(days);
  for(const d of days||[]){ const tr=(byDay[d.key]||[]), vals=tr.map(res).filter(v=>v!=null); if(!vals.length)continue;
    const b=d.behavior||{};
    const flags={}; for(const f of RV_BLIND)flags[f]=(b.flags&&b.flags[f])||0;
    const e=entryOf(d.key)||{};
    const rt=RT(d);
    D.push({key:d.key,week:weekOf(d.key),score:rt.score,stratum:rt.stratum,vals,mean:mean(vals),parts:d.parts||{},flags,checkin:!!e.checkin,review:!!e.review}); }
  const spearman=_spearmanWith(rnd);
  // weeks: average routine score, average per-trade result
  const wk={}; for(const d of D){ const w=wk[d.week]=wk[d.week]||{week:d.week,days:0,scores:[],vals:[]}; w.days++; if(d.score!=null)w.scores.push(d.score); w.vals.push(...d.vals); }
  const weeks=Object.values(wk).sort((a,b)=>a.week<b.week?-1:1).map(w=>({week:w.week,days:w.days,trades:w.vals.length,score:mean(w.scores),res:mean(w.vals)})).filter(w=>w.score!=null);
  const MINW=8;
  const corr=weeks.length>=MINW?spearman(weeks.map(w=>w.score),weeks.map(w=>w.res)):null;
  // lead: does THIS week's routine predict NEXT week's results? (consecutive weeks only)
  const pairs=[]; for(let i=0;i+1<weeks.length;i++)pairs.push([weeks[i].score,weeks[i+1].res]);
  const lead=pairs.length>=MINW?spearman(pairs.map(p=>p[0]),pairs.map(p=>p[1])):null;
  // the discipline dividend: per-trade result on good days (score >= 70) vs the rest, with a bootstrap 90% range.
  // Compared only between days with the same number of post-loss chances (rvRoutineOf's stratum) and pooled
  // with weights n_good·n_rest/(n_good+n_rest): a day without a loss to react to is a better day by
  // construction, and the 70 line must not sort those days to one side (AUDIT-4 E1).
  // The bootstrap resamples whole days within each stratum: inside a stratum a day's trades aren't
  // independent (one loss among the first three is fixed by it), so trade-level resampling ran wide.
  const st={}; for(const d of D){ const x=st[d.stratum]=st[d.stratum]||{g:[],r:[]}; (d.score>=70?x.g:x.r).push(d.vals); }
  const SS=Object.values(st).filter(x=>x.g.length&&x.r.length), good=SS.flatMap(x=>x.g.flat()), rest=SS.flatMap(x=>x.r.flat());
  const avg=ds=>{ let v=0,n=0; for(const a of ds){ for(const y of a)v+=y; n+=a.length; } return v/n; }, tn=ds=>ds.reduce((s,a)=>s+a.length,0);
  const pooled=pick=>{ let w=0,a=0,b=0; for(const x of SS){ const ng=tn(x.g), nr=tn(x.r), ws=ng*nr/(ng+nr); w+=ws; a+=ws*pick(x.g); b+=ws*pick(x.r); } return [a/w,b/w]; };
  let dividend=null;
  if(good.length>=10&&rest.length>=10){ const diffs=[], bs=ds=>{ const o=[]; for(let i=0;i<ds.length;i++)o.push(ds[Math.floor(rnd()*ds.length)]); return avg(o); };
    for(let k=0;k<1000;k++){ const [a,b]=pooled(bs); diffs.push(a-b); }
    diffs.sort((x,y)=>x-y);
    const [gm,rm]=pooled(avg);
    dividend={good:{n:good.length,mean:gm},rest:{n:rest.length,mean:rm},diff:gm-rm,lo:diffs[50],hi:diffs[949]}; }
  // cumulative results, good days vs the rest, in date order (the "two equity curves")
  const curves={good:[],rest:[]}; let cg=0,cr=0;
  for(const d of D){ const s=d.vals.reduce((x,y)=>x+y,0); if(d.score>=70){ cg+=s; curves.good.push({key:d.key,v:cg}); } else { cr+=s; curves.rest.push({key:d.key,v:cr}); } }
  // habits: days kept vs missed, Welch t-test, Benjamini–Hochberg across the habits tested
  const tP=(a,b)=>{ if(a.length<5||b.length<5)return null; const ma=mean(a), mb=mean(b), va=a.reduce((s,x)=>s+(x-ma)**2,0)/(a.length-1), vb=b.reduce((s,x)=>s+(x-mb)**2,0)/(b.length-1);
    const se=Math.sqrt(va/a.length+vb/b.length); if(!(se>0))return null; const z=Math.abs(ma-mb)/se;
    // normal approximation to the t tail (fine at these sample sizes; flagged early below)
    const tail=x=>{ const t=1/(1+0.2316419*x), d=0.3989423*Math.exp(-x*x/2); return d*t*(0.3193815+t*(-0.3565638+t*(1.781478+t*(-1.821256+t*1.330274)))); };
    return Math.min(1,2*tail(z)); };
  // per: 'day' (days kept vs missed, each day's average trade) or 'trade' (RV_CHANCE: post-loss entries)
  const inD=new Set(D.map(d=>d.key)), dD=(days||[]).filter(d=>inD.has(d.key));
  const habits=RV_HABITS.map(([key,label,grade,mech])=>{ let k=[],m=[]; const per=RV_CHANCE.includes(key)?'trade':'day';
    if(per==='trade')({k,m}=rvChanceSplit(key,dD,byDay,res));
    else for(const d of D){ const g=grade(d); if(g===true)k.push(d.mean); else if(g===false)m.push(d.mean); }
    return {key,label,mechanical:mech,per,kept:{n:k.length,mean:mean(k)},missed:{n:m.length,mean:mean(m)},diff:k.length&&m.length?mean(k)-mean(m):null,p:tP(k,m)}; });
  const tested=habits.filter(h=>h.p!=null&&!h.mechanical).sort((a,b)=>a.p-b.p);
  tested.forEach((h,i)=>{ h.q=Math.min(1,h.p*tested.length/(i+1)); });
  for(let i=tested.length-2;i>=0;i--)tested[i].q=Math.min(tested[i].q,tested[i+1].q);
  habits.sort((a,b)=>(a.mechanical-b.mechanical)||((b.diff==null?-1e9:b.diff)-(a.diff==null?-1e9:a.diff)));
  // is it paying more over time? Spearman over a rolling 12-week window
  const rolling=[]; const WIN=12;
  for(let i=WIN;i<=weeks.length;i++){ const w=weeks.slice(i-WIN,i), s=spearman(w.map(x=>x.score),w.map(x=>x.res),0); if(s)rolling.push({week:w[w.length-1].week,rho:s.rho}); }
  return {unit,days:D.length,trades:all.length,weeks,corr,lead,dividend,curves,habits,rolling,need:{weeks:MINW,have:weeks.length}};
}
// Habits vs results, day by day — the picture behind "does discipline pay?". Each trading day is
// a point: its habit score (the share of your habits you kept that day: plan written, rules kept,
// stops written, check-in, end-of-day review, every trade journaled, and no revenge entry, sizing
// up after a loss, adding to a loser or overtrading) against that day's result in dollars, %
// return on notional or R. Only habits you actually use count (one you've never kept in this
// history isn't held against every day), and the two that can only fail on a losing day (stops
// honored, loss limit) are left out of the score so a red day can't drag its own score down.
// The four fill checks count as rvRoutineOf's kept ÷ chances (a day without a chance at one takes
// your usual rate), so a day's losses can't lower its own score through them either (AUDIT-4 E1).
// Also: the average day per score band, and each habit's kept-vs-missed days in the same unit —
// for revenge and sizing up, post-loss entries kept vs slipped, per trade (per:'trade'; see RV_CHANCE).
// Points show from HL_MIN.days days; the correlation is only stated from HL_MIN.corr. Seeded.
const HL_MIN={days:3,corr:8};
const HL_BANDS=[[0,49,'Under 50'],[50,69,'50–69'],[70,89,'70–89'],[90,100,'90–100']];
function habitLink(days, byDay, opts){
  opts=opts||{};
  const rOf=opts.rOf||(()=>null), pctOf=opts.pctOf||(()=>null), entryOf=opts.entryOf||(()=>({}));
  const mean=a=>a.length?a.reduce((x,y)=>x+y,0)/a.length:null, fin=v=>v!=null&&isFinite(v);
  const pts=[], RT=rvRoutineOf((days||[]).filter(d=>((byDay&&byDay[d.key])||[]).length));
  for(const d of days||[]){ const tr=(byDay&&byDay[d.key])||[]; if(!tr.length)continue;
    const b=d.behavior||{}, blind=(b.slips||[]).filter(s=>(s.f||[]).some(f=>RV_BLIND.includes(f)));
    const flags={}; for(const f of RV_BLIND)flags[f]=0; for(const s2 of blind)for(const f of s2.f)if(f in flags)flags[f]++;
    let usd=0,pct=0,pn=0,r=0,rn=0,w=0,l=0;
    for(const t of tr){ usd+=+t.net||0; const p=pctOf(t); if(fin(p)){ pct+=p; pn++; } const x=rOf(t); if(fin(x)){ r+=x; rn++; } if(t.net>0)w++; else if(t.net<0)l++; }
    const e=entryOf(d.key)||{}, rt=RT(d);
    pts.push({key:d.key,routine:rt.score,rate:rt.rate,discipline:d.score!=null?d.score:null,n:tr.length,wins:w,losses:l,
      usd,pct:pn?pct:null,r:rn&&rn===tr.length?r:null,flags,parts:d.parts||{},checkin:!!e.checkin,review:!!e.review}); }
  // the habits in play: graded on some day and kept at least once (fill checks always count)
  const H=RV_HABITS.filter(h=>!h[3]);
  const inPlay=H.filter(([key,,grade])=>RV_BLIND.includes(key)||pts.some(p=>grade(p)===true));
  // a fill check adds its kept share of the day's chances (listed as missed when it slipped that day)
  for(const p of pts){ const kept=[], missed=[]; let sum=0, cnt=0;
    for(const [key,label,grade] of inPlay){
      if(RV_BLIND.includes(key)){ const v=p.rate[key]; if(v==null)continue; sum+=v; cnt++; (p.flags[key]?missed:kept).push(label); continue; }
      const g=grade(p); if(g===true){ kept.push(label); sum++; cnt++; } else if(g===false){ missed.push(label); cnt++; } }
    p.kept=kept; p.missed=missed; p.score=cnt?Math.round(100*sum/cnt):null; }
  const hasR=pts.length>0&&pts.filter(p=>p.r!=null).length/pts.length>=0.6, hasPct=pts.some(p=>p.pct!=null);
  const units=['$'].concat(hasPct?['%']:[],hasR?['R']:[]);
  const unit=units.includes(opts.unit)?opts.unit:'$';
  const val=p=>unit==='$'?p.usd:unit==='%'?p.pct:p.r;
  const P=pts.filter(p=>p.score!=null&&fin(val(p))).map(p=>Object.assign({},p,{v:val(p)}));
  const spread=P.length>1&&P.some(p=>p.score!==P[0].score);
  // the straight line through the points (least squares), for the eye — the rank correlation is the test
  let fit=null;
  if(P.length>=HL_MIN.days&&spread){ const mx=mean(P.map(p=>p.score)), my=mean(P.map(p=>p.v)); let sxy=0,sxx=0;
    for(const p of P){ sxy+=(p.score-mx)*(p.v-my); sxx+=(p.score-mx)**2; }
    if(sxx>0){ const slope=sxy/sxx; fit={slope,icpt:my-slope*mx,per10:slope*10}; } }
  const corr=P.length>=HL_MIN.corr&&spread?_spearmanWith(_seededRnd(opts.seed||7))(P.map(p=>p.score),P.map(p=>p.v)):null;
  const bands=HL_BANDS.map(([lo,hi,label])=>{ const g=P.filter(p=>p.score>=lo&&p.score<=hi);
    return {label,lo,hi,n:g.length,avg:mean(g.map(p=>p.v)),total:g.reduce((s2,p)=>s2+p.v,0),green:g.filter(p=>p.v>0).length,trades:g.reduce((s2,p)=>s2+p.n,0)}; });
  const split=hi=>{ const g=P.filter(p=>(p.score>=70)===hi); return {n:g.length,avg:mean(g.map(p=>p.v)),green:g.filter(p=>p.v>0).length}; };
  const inP=new Set(P.map(p=>p.key)), dP=(days||[]).filter(d=>inP.has(d.key)), tv=t=>unit==='$'?+t.net:unit==='%'?pctOf(t):rOf(t);
  const habits=RV_HABITS.map(([key,label,grade,mech])=>{ let k=[],m=[]; const per=RV_CHANCE.includes(key)?'trade':'day';
    if(per==='trade')({k,m}=rvChanceSplit(key,dP,byDay,tv));
    else for(const p of P){ const g=grade(p); if(g===true)k.push(p.v); else if(g===false)m.push(p.v); }
    return {key,label,mechanical:mech,per,kept:{n:k.length,avg:mean(k)},missed:{n:m.length,avg:mean(m)},diff:k.length&&m.length?mean(k)-mean(m):null}; })
    .filter(h=>h.kept.n>0&&h.missed.n>0)
    .sort((a,b)=>(a.mechanical-b.mechanical)||(b.diff-a.diff));
  return {unit,units,points:P,spread,fit,corr,bands,good:split(true),rest:split(false),habits,tracked:inPlay.map(h=>h[1]),need:HL_MIN};
}
// The plain-language read of habitLink, for people who don't read scatter plots: a verdict, how
// sure it is (0–3 bars), the difference between the two kinds of days, and the one habit to
// protect. Never claims more than the numbers hold: before HL_MIN.corr days it's "too early",
// without a significant link it's "not clear yet", and only a real positive link names a habit.
const HL_SURE={early:'Too early to tell',flat:'Nothing to compare yet',unclear:'Not clear yet — could be luck',pays:['','','Looks real','Clear pattern'],reverse:['','','Looks real','Clear pattern']};
function hlSummary(L){
  const n=L.points.length, g=L.good, r=L.rest, both=g.n>0&&r.n>0, d=both?g.avg-r.avg:null, c=L.corr;
  let verdict, sure=0;
  if(n<L.need.corr)verdict='early';
  else if(!L.spread||!both)verdict='flat';
  else if(c&&c.p<0.05&&c.rho>0&&d>0){ verdict='pays'; sure=c.p<0.01?3:2; }
  else if(c&&c.p<0.05&&c.rho<0&&d<0){ verdict='reverse'; sure=c.p<0.01?3:2; }
  else { verdict='unclear'; sure=1; }
  const top=verdict==='pays'?L.habits.find(h=>!h.mechanical&&h.diff>0&&h.kept.n>=3&&h.missed.n>=3)||null:null;
  const sureText=Array.isArray(HL_SURE[verdict])?HL_SURE[verdict][sure]:HL_SURE[verdict];
  return {n,verdict,sure,sureText,d,both,top};
}
// plain words for a day-level rank correlation
function hlLinkWords(c){
  if(!c)return null;
  const a=Math.abs(c.rho), size=a>=0.5?'Strong':a>=0.3?'Moderate':a>=0.1?'Weak':null;
  if(!size)return {tone:'flat',text:'No real link yet between your routine and your results'};
  return {tone:c.rho>0?(c.p<0.05?'good':'maybe'):'bad',text:size+' link: '+(c.rho>0?'cleaner days, better results':'cleaner days, worse results')+(c.p>=0.05?' — could still be chance':'')};
}
// Everything the process score needs from the rule engine, for one trade set.
// A rule from findings only counts trades entered after it was made, and when those are the
// only rules, the "rules kept" part starts on the first rule's day — history isn't regraded.
function processContext(trades, rulePreds){
  const closed=trades.filter(t=>!t.isOpen&&t.closeTime);
  const viol=new Set();
  for(const r of evaluateRules(closed,nfRules())) if(r.kind!=='dll') for(const id of (r.ids||[])) viol.add(id);
  const P=rulePreds||customRulePreds(trades,customRules());
  for(const x of P) if(x.pred) for(const t of closed) if(t.openTime>=(x.rule.createdAt||0)&&x.pred(t)) viol.add(t.id);
  // with no rules set, "no rule broken" is vacuously true — it would hand every day free points
  const R=nfRules(), builtin=!!(R.maxPerDay>0||R.cooldownMin>0||R.noAddToLosers), cr=customRules();
  const rulesActive=builtin||cr.length>0;
  const rulesFrom=builtin||!cr.length?null:dayKey(Math.min(...cr.map(r=>r.createdAt||0)));
  const since=part=>{ const hs=habitsList().filter(h=>h.kind==='process'&&h.part===part);
    return hs.length?dayKey(Math.min(...hs.map(h=>h.createdAt||Date.now()))):null; };
  // a weekly challenge on a planning part grades that part for its own week only
  const planWindows=[];
  for(const k in journal){ const c=k.startsWith('week:')&&journal[k]&&journal[k].challenge;
    if(c&&c.spec&&c.spec.kind==='process'&&(c.spec.part==='plan'||c.spec.part==='planned')&&c.from&&c.to)
      planWindows.push({part:c.spec.part,from:dayKey(c.from),to:dayKey(c.to)}); }
  const pbG=typeof pbTradeGrades==='function'?pbTradeGrades(closed,journal,pbList()):{checked:new Set(),broke:new Set()};
  return {closed, days:processDays(closed,journal,{trades,violIds:viol,dayOf:dayKey,excM:_excM,dllLimit:R.dailyLossLimit,
    rulesActive,rulesFrom,planFrom:{plan:since('plan'),planned:since('planned')},planWindows,pbChecked:pbG.checked,pbBroke:pbG.broke})};
}

// ---- Review UI: journal inbox, process ----
let _inboxSkip=new Set();
function inboxSectionHtml(){
  if(!coachOn())return '';
  const inbox=journalInbox(allTrades.filter(viewFilter),journal).filter(t=>!_inboxSkip.has(t.id));
  const st=journalStreak(allTrades.filter(viewFilter),journal,dayKey,dayKey(Date.now()));
  const streakTxt=`<span class="sr-note" data-tip="Consecutive trading days on which every closed trade has a setup, tag, rating, note or mistake flag. Today only counts once it's complete — it never breaks the streak while you're still trading.">streak ${st.current} day${st.current===1?'':'s'} · best ${st.best}</span>`;
  if(!inbox.length) return `<div class="diag-section"><h2>Journal inbox <span style="font-size:11px;color:var(--faint);font-weight:400">last 30 days</span> ${streakTxt}</h2>
    <p class="lead">Nothing waiting — every trade from the last 30 days carries at least a setup, tag, rating, note or mistake flag.</p></div>`;
  const t=inbox[0];
  const setups=[...new Set(Object.values(journal).map(j=>j&&j.setup).filter(Boolean))].sort();
  return `<div class="diag-section"><h2>Journal inbox <span style="font-size:11px;color:var(--faint);font-weight:400">${inbox.length} trade${inbox.length===1?'':'s'} waiting · last 30 days</span> ${streakTxt}</h2>
    <div class="diag-card" id="inboxCard" data-id="${esc(t.id)}" data-draft-scope="${esc(t.id)}">
      <p class="lead" style="margin:0 0 10px"><b>${esc(dispMarket(dcoin(t)))}</b> ${t.dir} · <span class="${cls(t.net)}">${fmtUsd(t.net)}</span> · closed ${fmtDate(t.closeTime)} · held ${fmtDur(t.durationMs)}</p>
      <div class="field">${coachOn()?`<label class="coach-q" for="ibNote">${esc(tradeQuestion(t,journal[t.id],_excM[t.id]).q)}</label>`:'<label for="ibNote">Note</label>'}<input type="text" id="ibNote" maxlength="400" placeholder="one honest line is enough"></div>
      <div class="field"><label>Setup</label><input type="text" id="ibSetup" list="ibSetups" placeholder="what was this trade?"><datalist id="ibSetups">${setups.map(x=>`<option value="${esc(x)}">`).join('')}</datalist></div>
      <div class="field"><label>Execution — keys 1–5</label><div class="rating" id="ibRating" role="radiogroup" aria-label="Execution rating">${[1,2,3,4,5].map(n=>`<span class="star" data-r="${n}" role="radio" tabindex="0" aria-label="${n} star${n>1?'s':''}" aria-checked="false">★</span>`).join('')}</div></div>
      <div class="field"><label>Mistakes</label><div class="mistakes" id="ibMistakes">${MISTAKES.map(m=>`<label class="chk"><input type="checkbox" data-m="${esc(m)}">${m}</label>`).join('')}</div></div>
      <div><button class="btn" id="ibSave">Save &amp; next</button> <button class="btn ghost" id="ibSkip">Skip</button> <span class="mini-note" style="display:inline">Enter saves · 1–5 rate (outside the text box)</span></div>
    </div></div>`;
}
function wireInbox(){
  const card=$('inboxCard'); if(!card)return;
  const id=card.dataset.id; let rating=0;
  const stars=[...card.querySelectorAll('#ibRating .star')];
  const setR=n=>{ rating=n; stars.forEach(s=>{ const on=+s.dataset.r<=n; s.classList.toggle('on',on); s.setAttribute('aria-checked',+s.dataset.r===n?'true':'false'); }); };
  stars.forEach(s=>{ s.onclick=()=>setR(+s.dataset.r); s.onkeydown=e=>{ if(e.key==='Enter'||e.key===' '){ e.preventDefault(); setR(+s.dataset.r); } }; });
  card.querySelectorAll('#ibMistakes .chk input').forEach(c=>c.onchange=()=>c.parentElement.classList.toggle('on',c.checked));
  const save=()=>{
    const setup=$('ibSetup').value.trim(), note=($('ibNote')||{value:''}).value.trim();
    const mistakes=[...card.querySelectorAll('#ibMistakes input:checked')].map(c=>c.dataset.m);
    if(!setup&&!rating&&!mistakes.length&&!note){ $('ibSetup').focus(); return; }
    const j=ensureJ(id); if(setup)j.setup=pzCanonSetup(setup); if(rating)j.rating=rating;
    if(note){ const q=coachOn()?tradeQuestion(allTrades.find(x=>x.id===id)||{},j,_excM[id]).q+'\n':''; j.notes=(j.notes?j.notes+'\n\n':'')+q+note; }
    if(mistakes.length)j.mistakes=[...new Set([...(j.mistakes||[]),...mistakes])];
    markJEdit(id); Store.set(J_KEY,journal); renderReview();
    const next=$('ibSetup'); if(next)next.focus();
  };
  $('ibSave').onclick=save;
  $('ibSkip').onclick=()=>{ _inboxSkip.add(id); renderReview(); const n=$('ibSetup'); if(n)n.focus(); };
  card.onkeydown=e=>{
    if(e.key==='Enter'&&e.target.tagName!=='TEXTAREA'&&e.target.tagName!=='BUTTON'&&!e.target.classList.contains('star')){ e.preventDefault(); save(); return; }
    if(e.target.id!=='ibSetup'&&e.target.id!=='ibNote'&&/^[1-5]$/.test(e.key)){ e.preventDefault(); setR(+e.key); }
  };
}
function processSectionHtml(){
  if(!coachOn())return '';
  const {days}=coachContext();
  if(days.length<3)return '';
  const tr=processTrend(days,20);
  const recent=days.slice(-60), q=processQuadrants(recent,70);
  const last=days[days.length-1];
  const PN={plan:'Plan filed before first entry',rules:'Trades breaking no rule',planned:'Trades with a live plan',stops:'Planned stops honored',limit:'Stopped at the loss limit',journal:'Trades journaled'};
  const bar=v=>`<span style="display:inline-block;width:70px;height:6px;background:var(--panel2);vertical-align:middle;margin-right:6px"><span style="display:block;height:6px;width:${Math.round(v*100)}%;background:${v>=0.7?'var(--profit)':v>=0.4?'var(--gold)':'var(--loss)'}"></span></span>`;
  const mrow=(l,v,tip)=>`<div class="metric-row"${tip?` data-tip="${esc(tip)}"`:''}><span class="ml">${l}</span><span class="mv">${v}</span></div>`;
  const partRows=Object.keys(PROCESS_W).map(p=>last.parts[p]==null?'':mrow(PN[p]+` <span style="color:var(--faint)">· ${PROCESS_W[p]}</span>`,bar(last.parts[p])+Math.round(last.parts[p]*100)+'%',
    PN[p]+': '+Math.round(last.parts[p]*100)+'% on your last trading day ('+dayLabel(last.key)+'). It counts '+PROCESS_W[p]+' toward the process score.')).join('');
  const sc=v=>`<b style="color:${v>=70?'var(--profit)':v>=50?'var(--gold)':'var(--loss)'}">${Math.round(v)}</b>`;
  const cell=(title,b,tip,tone)=>`<div style="padding:10px 12px;border:1px solid var(--line);border-left:3px solid var(--${tone})" data-tip="${esc(tip)}"><div style="font-size:11px;color:var(--faint);text-transform:uppercase;letter-spacing:.05em">${title}</div><div style="font-size:18px;font-weight:600;margin:2px 0">${b.n} day${b.n===1?'':'s'}</div><div class="${cls(b.net)}" style="font-size:12px">${fmtUsd(b.net)}</div></div>`;
  return `<div class="diag-section"><h2>Process <span style="font-size:11px;color:var(--faint);font-weight:400">how you traded, not what the market paid</span></h2>
    <div class="diag-grid">
      <div class="diag-card"><h3 data-tip="0–100 per trading day. Weights (shown after each part) are fixed; parts that don't apply that day — no plans written, no loss limit set — drop out of the weighting instead of counting against you.">Process score · ${esc(dayLabel(last.key))} ${sc(last.score)}</h3>
        ${partRows}
        <div style="margin-top:8px;border-top:1px solid var(--line);padding-top:6px">
        ${mrow('Last '+Math.min(20,days.length)+' trading days',tr.avg!=null?sc(tr.avg)+(tr.prevAvg!=null?` <span style="color:var(--faint)">vs ${Math.round(tr.prevAvg)} the ${Math.min(20,days.length-20)} before</span>`:''):'—')}
        ${mrow('Good-process streak',tr.streak+' day'+(tr.streak===1?'':'s'),'Consecutive trading days scoring 70 or more.')}</div>
        <p class="mini-note">The Daily PnL calendar on the dashboard can switch to this score (PnL / Process button).</p></div>
      <div class="diag-card"><h3 data-tip="Last ${recent.length} trading days split by process score (70+ = good) and whether the day was green. Good process on a red day is still a good day; a green day with poor process is the dangerous one — it rewards the habit you are trying to break.">Process vs outcome · last ${recent.length} days</h3>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
          ${cell('Good process · green',q.earned,'Earned days: the process worked and paid.','profit')}
          ${cell('Good process · red',q.goodLoss,'Good losses: you did it right and the market said no. Keep doing exactly this.','gold')}
          ${cell('Poor process · green',q.lucky,'Lucky days: paid despite the process. These teach the wrong lesson — review them like losses.','gold')}
          ${cell('Poor process · red',q.deserved,'Deserved losses: the process broke and it cost money. The cheapest fixes live here.','loss')}
        </div>
        <p class="mini-note">If most of your green days are "lucky", the edge is in the market's mood, not your process.</p></div>
    </div></div>`;
}

// ---- Diagnostic: rules made from findings ----
function customRulesHtml(closed){
  if(!coachOn())return '';
  const rules=customRules();
  const hint='<p class="mini-note" style="margin-top:8px">Make a rule from any leak in the <b>Pattern miner</b> (“+ rule”) or from a <b>What if I stopped doing X</b> replay.</p>';
  if(!rules.length)return hint;
  const preds=customRulePreds(closed,rules);
  const rows=preds.map(({rule,pred,live})=>{
    if(!pred)return `<div class="state-row"><div class="sr-top"><span class="sr-name">${esc(rule.name)}</span><span><span class="sr-note">unresolved</span> <button class="btn ghost rule-del" data-pid="${esc(rule.pid)}" style="font-size:10px;padding:1px 7px">remove</button></span></div></div>`;
    const v=closed.filter(pred), cost=v.reduce((s,t)=>s+t.net,0);
    const ft=ruleFollowThrough(closed,pred,rule.createdAt);
    const pc=x=>x==null?'—':Math.round(x*100)+'%';
    const badge={working:'<span class="badge ok" data-tip="Since you made the rule you break it significantly less often (one-sided two-proportion test, p < 0.10).">working</span>',
      improving:'<span class="badge mid" data-tip="Breaking it less often than before, but not yet distinguishable from chance.">improving</span>',
      'not yet':'<span class="badge no" data-tip="Breaking it as often as before the rule existed — the rule is written down, not yet followed.">not followed yet</span>',
      collecting:'<span class="sr-note">collecting — verdict after 10 trades</span>',
      clean:'<span class="badge ok">never broken</span>',
      'no baseline':'<span class="sr-note">no trades before the rule</span>'}[ft.status]||'';
    const liveB=live?' <span class="badge ok" data-tip="Known at entry: an open position that breaks this rule shows a warning chip on the dashboard.">live</span>':' <span class="sr-note" data-tip="Depends on how the trade ended (hold time, excursion, close hour…), so it is scored after the close only.">after close</span>';
    return `<div class="state-row"><div class="sr-top"><span class="sr-name">${esc(rule.name)}${liveB}</span><span style="white-space:nowrap">${badge} <button class="btn ghost rule-del" data-pid="${esc(rule.pid)}" style="font-size:10px;padding:1px 7px">remove</button></span></div>
      <div class="sr-sub" style="font-size:11.5px;color:var(--muted)">${v.length} breaking trade${v.length===1?'':'s'} · <span class="${cls(cost)}">${fmtUsd(cost)}</span> · ${ft.before.n?`broken on ${pc(ft.before.rate)} of trades before ${esc(dayKey(rule.createdAt))}`:`made ${esc(dayKey(rule.createdAt))}`} · ${ft.after.n?`${pc(ft.after.rate)} of the ${ft.after.n} trade${ft.after.n===1?'':'s'} since`:'no trades since yet'}</div></div>`;
  }).join('');
  return `<div style="margin-top:10px;border-top:1px solid var(--line);padding-top:8px"><div class="mini-note" style="margin:0 0 4px">Your rules from findings — breaks, cost, and whether the rule changed anything:</div>${rows}</div>${hint}`;
}
function wireCustomRules(){
  document.querySelectorAll('.rule-del').forEach(b=>{ b.onclick=async()=>{ await removeCustomRule(b.dataset.pid);
    renderGuardrails(); if(activeTab==='diag')renderDiagnostic(periodTrades(),periodTradesAll()); }; });
}

/* ======================= 9 · COACH: plain-language findings · habits · wins · questions ======================= */
// Everything the app knows, said the way a good trading coach would say it: what's happening,
// one thing to do about it, and how sure we are — with the numbers folded away for anyone who
// wants them. All template-driven and computed in the browser: nothing leaves the machine.

// ---- phrasebook ----
function confLevel(p){ return p==null?'early':p<0.01?'strong':p<0.05?'likely':'early'; }
function confWords(level){ return {strong:'Very likely real',likely:'Probably real',early:'Early signal — keep watching'}[level]||''; }
function sampleWords(n){ return n<10?'a handful of trades':n<30?n+' trades, a small sample':n<100?n+' trades':n+' trades, a solid sample'; }
function usdPlain(x){ const a=Math.abs(x); return a>=10?fmtUsd(a,0):fmtUsd(a).replace(/\.00$/,''); } // whole dollars unless under $10
// 'YYYY-MM-DD' -> 'Mon, Sep 28' (a calendar key, so read it as UTC to keep the same date)
function dayLabel(k){ const d=new Date(k+'T00:00:00Z'); if(isNaN(d))return k; return DOWN[d.getUTCDay()]+', '+MONTHS[d.getUTCMonth()]+' '+d.getUTCDate(); }
function daysPlain(ms){ const d=Math.round(ms/86400000); return d>=60?Math.round(d/7)+' weeks':d+' day'+(d===1?'':'s'); }
function signedPlain(x){ return (x<0?'−':'+')+usdPlain(x); }
// Money that stays readable on a phone: exact up to $99,999, then $452k · $6.04M · $60.4M (the
// exact figure goes in a tooltip). Used where big accounts would otherwise wrap or crowd a tile.
function pzShort(x){ const a=Math.abs(x); if(!(a>=1e5))return usdPlain(x);
  return '$'+(a>=9.995e8?(a/1e9).toFixed(2)+'B':a>=9.995e5?(a/1e6).toFixed(a>=9.95e7?0:a>=9.995e6?1:2)+'M':Math.round(a/1e3)+'k'); }
function pzSigned(x){ return (x<0?'−':'+')+pzShort(x); }
// Welch two-sample t-test, two-sided p. Used to put a confidence word on "A vs B" findings.
function welchP(a,b){
  if(!a||!b||a.length<3||b.length<3)return null;
  const ma=_avg(a), mb=_avg(b), va=_std(a)**2, vb=_std(b)**2;
  const se=Math.sqrt(va/a.length+vb/b.length); if(!(se>0))return null;
  const tt=Math.abs(ma-mb)/se;
  const df=(va/a.length+vb/b.length)**2/((va/a.length)**2/(a.length-1)+(vb/b.length)**2/(b.length-1));
  return 2*(1-_tCdf(tt,Math.max(1,df)));
}
// Noun phrase for an edge-breakdown bucket: "your short trades", "ETH trades", "the “breakout” setup".
function bucketPhrase(dim,key){
  const k=String(key);
  switch(dim){
    case 'dir': return k==='Spot'?'your spot buys':'your '+k.toLowerCase()+' trades';
    case 'market': return dispMarket(k)+' trades';
    case 'dow': return k+' trades';
    case 'hour': { const m=k.match(/^(\d+)\D+(\d+)h$/); return m?'trades closed between '+m[1]+':00 and '+m[2]+':00':'trades closed '+k; }
    case 'hold': return 'trades held '+k;
    case 'size': return 'your '+k+' trades';
    case 'setup': return 'the “'+k+'” setup';
    case 'tag': return 'trades tagged “'+k+'”';
    case 'mistake': return '“'+k+'” trades';
    case 'rating': return k+' trades';
    default: return k+' trades';
  }
}
// The habit a bucket leak maps to, when its condition can be checked on a trade.
function bucketHabit(dim,key){
  const k=String(key);
  const pid=dim==='dir'?'dir:'+k:dim==='market'?'mkt:'+k:dim==='setup'?'setup:'+k:dim==='tag'?'tag:'+k
    :dim==='size'&&/^largest/.test(k)?'size:hi':null;
  if(!pid)return null;
  return {kind:'avoid',pid,when:'I’m about to take '+bucketPhrase(dim,k).replace(/^your /,'one of my '),then:'I pass on it'};
}

// ---- habit library ----
// kind 'process' = kept when that day's process-score part is perfect; 'avoid' = kept on a day
// with no trade matching the condition; 'cap' = kept on a day with at most `cap` trades;
// 'self' (habits you write yourself) = kept on a day you ticked "I followed the plan".
const HABIT_LIBRARY=[
  {tpl:'plan-first',kind:'process',part:'plan',when:'I sit down to trade',then:'I write my plan and max loss before the first entry'},
  {tpl:'stop-live',kind:'process',part:'planned',when:'I open a position',then:'I write its stop in the journal while it’s still open'},
  {tpl:'honor-stop',kind:'process',part:'stops',when:'price reaches my stop',then:'I’m out — no second chances'},
  {tpl:'journal-all',kind:'process',part:'journal',when:'a trade closes',then:'I tag its setup and rate it the same day'},
  {tpl:'respect-limit',kind:'process',part:'limit',when:'I hit my daily loss limit',then:'I’m done for the day'},
  {tpl:'cool-off',kind:'avoid',pid:'st:loss1h',when:'I close a losing trade',then:'I wait an hour before the next entry'},
  {tpl:'two-strikes',kind:'avoid',pid:'st:loss2',when:'I’ve lost twice in a row',then:'I stop until the next session'},
  {tpl:'no-chase-red',kind:'avoid',pid:'st:red',when:'I’m red on the day',then:'I don’t open new trades to win it back'},
  {tpl:'size-cap',kind:'avoid',pid:'size:hi',when:'I size a trade',then:'I keep it no bigger than my usual size'},
  {tpl:'day-cap',kind:'cap',cap:3,when:'I’ve taken 3 trades today',then:'I’m done for the day'},
];
function habitsList(){ return Array.isArray(settings.habits)?settings.habits.filter(h=>h&&!h.retired):[]; }
function habitById(id){ return (Array.isArray(settings.habits)?settings.habits:[]).find(h=>h&&h.id===id)||null; }
function habitSentence(h){ return 'When '+h.when+', '+h.then+'.'; }
async function adoptHabit(spec){
  if(!Array.isArray(settings.habits))settings.habits=[];
  // adopting a habit you already keep is a no-op. Adopting one you retired starts a new copy: the retired
  // one keeps its kept days (they still count for badges), where reviving it reset them to zero.
  const same=settings.habits.find(h=>h&&!h.retired&&((spec.tpl&&h.tpl===spec.tpl)||(spec.pid&&h.pid===spec.pid&&h.kind===spec.kind)
    ||(!spec.tpl&&!spec.pid&&h.kind===spec.kind&&!h.tpl&&!h.pid&&h.when===String(spec.when||'').slice(0,160)&&h.then===String(spec.then||'').slice(0,160))));
  if(same){ await Store.set(S_KEY,settings); return same; }
  let params=spec.params&&Object.keys(spec.params).length?spec.params:null;
  if(spec.pid&&!params){ // same contract as pins and rules: thresholds fixed at adoption, never re-derived
    try{ const chron=allTrades.filter(t=>!t.isOpen&&t.closeTime&&viewFilter(t)).sort((a,b)=>a.closeTime-b.closeTime);
      params=minerFams(chron,tradeStates(chron)).__params||null; }catch(e){} }
  const h={id:'h'+Date.now().toString(36)+Math.random().toString(36).slice(2,6),tpl:spec.tpl||null,kind:spec.kind,
    part:spec.part||null,pid:spec.pid||null,params:params||{},cap:spec.cap||null,slip:spec.slip||null,
    when:String(spec.when||'').slice(0,160),then:String(spec.then||'').slice(0,160),createdAt:Date.now()};
  settings.habits.push(h);
  await Store.set(S_KEY,settings);
  if(!weekFocus())await setWeekFocus(h.id); // the first habit adopted becomes this week's focus
  return h;
}
async function retireHabit(id){ const h=habitById(id); if(!h)return;
  if(weekFocus()===id)await setWeekFocus(null); // before retiring: weekFocus() ignores retired habits
  h.retired=true; h.retiredAt=Date.now(); // its days up to here keep counting for badges (pzHabitResAll)
  await Store.set(S_KEY,settings); }
// This week's single focus habit lives on the current ISO-week journal entry, so it syncs,
// merges and backs up like the weekly review it sits beside.
function weekFocus(ms){ const e=journal[isoWeekKey(ms||Date.now())]; return e&&e.focus&&habitById(e.focus)&&!habitById(e.focus).retired?e.focus:null; }
// A focus picked mid-week earns its +XP days from the pick on (pzSwapStartKey: today, or tomorrow once
// today's trading has started), never back to Monday; the focus it replaces keeps the days it already
// earned (focusPast). Without focusFrom (an older entry) the whole week counts, as before.
async function setWeekFocus(id){ const now=Date.now(), k=isoWeekKey(now);
  const e={...(journal[k]||{})}; if((id||null)===(e.focus||null))return;
  const start=pzSwapStartKey(now,allTrades);
  if(e.focus)e.focusPast=[...(Array.isArray(e.focusPast)?e.focusPast:[]),{id:e.focus,from:e.focusFrom||'',to:start}].slice(-7);
  if(id){ e.focus=id; e.focusFrom=start; } else { delete e.focus; delete e.focusFrom; } e.updatedAt=now;
  journal[k]=e; markJEdit(k); await Store.set(J_KEY,journal); }

// Per trading day, was the habit kept? Pure given its inputs. days = processDays output
// (close-day grouped); byDay maps day key -> closed trades that day; pred for 'avoid' habits.
function habitDayResults(h, days, byDay, pred, fromKey, journalObj){
  const out=[];
  for(const d of days){ if(fromKey&&d.key<fromKey)continue;
    let kept=null;
    if(h.kind==='process'){ const v=d.parts[h.part]; if(v==null)continue; kept=v>=0.999; }
    else if(h.kind==='self'){ const e=(journalObj||{})['day:'+d.key]; kept=!!(e&&e.adherence); }
    else if(h.kind==='avoid'){ if(!pred)continue; kept=!(byDay[d.key]||[]).some(pred); }
    else if(h.kind==='slip'){ const b=_pzSlipDays.get(d.key); if(!b)continue; kept=!(b.flags&&b.flags[h.slip]); } // plugging a Discipline leak
    else if(h.kind==='cap'){ kept=(byDay[d.key]||[]).length<=(h.cap||3); }
    if(kept!=null)out.push({key:d.key,kept});
  }
  return out;
}
var _pzSlipDays=new Map(); // day key -> that day's Discipline checks (pzBehaviorDays), set by gameContext
function habitSummary(res){ const kept=res.filter(r=>r.kept).length; return {kept,total:res.length,rate:res.length?kept/res.length:null}; }

// ---- findings: the Diagnostic's recommendations, as plain-language cards ----
// ext carries the heavier stats a caller may already have (bootstrap CI, Monte Carlo drawdown,
// edge-breakdown scan); anything missing is simply skipped. Ranked by money at stake × confidence.
function buildFindings(closed, s, ext){
  ext=ext||{}; const N=closed.length, F=[];
  if(!N)return F;
  const B=ext.sig||behaviorSignals(closed,s);
  const add=f=>{ F.push(Object.assign({tone:'info',conf:'early',impact:0,n:N},f)); };
  const pc=x=>Math.round(x*100)+'%';
  // edge proof
  const boot=ext.boot, esig=ext.esig;
  const ciLo=boot?boot.lo:(N>=5?s.expectancy-1.96*_std(closed.map(t=>t.net))/Math.sqrt(N):null);
  const ciHi=boot?boot.hi:(N>=5?s.expectancy+1.96*_std(closed.map(t=>t.net))/Math.sqrt(N):null);
  if(s.net>0&&ciLo!=null&&ciLo<=0)
    add({id:'edge-unproven',tone:'caution',title:'You’re up, but it could still be luck',
      body:`You’re ${signedPlain(s.net)} over ${N} trades. Results this size can still come from a lucky run — the likely range for your average trade still includes losing money.`,
      action:esig&&esig.needN>N?`Keep your size steady for about ${esig.needN-N} more trades before sizing up.`:'Keep your size steady until the numbers firm up.',
      evidence:`Average trade ${signedPlain(s.expectancy)} · 95% range ${signedPlain(ciLo)} to ${signedPlain(ciHi)}${s.sharpe!=null?` · Sharpe ${s.sharpe.toFixed(2)} (band ${s.sharpeLo.toFixed(1)} to ${s.sharpeHi.toFixed(1)})`:''}`,
      conf:'likely',impact:Math.abs(s.net)*0.15});
  else if(s.net>0&&ciLo!=null&&ciLo>0)
    add({id:'edge-real',tone:'edge',title:'Your edge looks real',
      body:`${signedPlain(s.net)} over ${N} trades, and even the cautious end of the range for your average trade stays above zero.`,
      action:'Protect it: same process, same size discipline. Don’t change what’s working.',
      evidence:`Average trade ${signedPlain(s.expectancy)} · 95% range ${signedPlain(ciLo)} to ${signedPlain(ciHi)}`,conf:N>=100?'strong':'likely',impact:Math.abs(s.net)*0.1});
  else if(s.net<0)
    add({id:'edge-none',tone:'caution',title:'No edge shows up yet in these trades',
      body:`You’re ${signedPlain(s.net)} over ${N} trades after fees and funding.`,
      action:'Trade smaller while you find what works — the leaks below show where the money goes.',
      evidence:`Average trade ${signedPlain(s.expectancy)}${ciLo!=null?` · 95% range ${signedPlain(ciLo)} to ${signedPlain(ciHi)}`:''}`,conf:N>=30?'likely':'early',impact:Math.abs(s.net)*0.2});
  if(N<100)
    add({id:'sample',tone:'info',title:`Early days: ${N} trades`,
      body:'With this few trades, most patterns are hints, not facts. Some will fade as more trades come in.',
      action:'Treat every pattern here as a hypothesis until you’re past 100 trades.',evidence:`${N} closed trades in this view`,conf:'strong',impact:0});
  // edge-breakdown extremes
  const scan=ext.scan;
  if(scan&&scan.weak&&scan.weak[0]){ const w=scan.weak[0];
    add({id:'worst-bucket',tone:'leak',title:bucketPhrase(w.dim,w.key).replace(/^./,c=>c.toUpperCase())+' lose money',
      body:`${w.n} trades averaging ${signedPlain(w.expectancy)} each — ${signedPlain(w.net)} in total.`,
      action:'Stop taking these, or redefine what makes one worth taking.',
      evidence:`${edgeLabel(w.dim)} = ${w.key} · n=${w.n} · expectancy ${fmtUsd(w.expectancy)} · p=${w.p!=null?w.p.toFixed(3):'—'}${w.sig?' · survives false-discovery correction':''}`,
      conf:w.sig?confLevel(w.p):'early',n:w.n,impact:Math.abs(w.net),habit:bucketHabit(w.dim,w.key)}); }
  if(scan&&scan.strong&&scan.strong[0]){ const b=scan.strong[0];
    add({id:'best-bucket',tone:'edge',title:bucketPhrase(b.dim,b.key).replace(/^./,c=>c.toUpperCase())+' are your best',
      body:`${b.n} trades averaging ${signedPlain(b.expectancy)} each — ${signedPlain(b.net)} in total.`,
      action:'Give these more of your attention. Wait for them instead of forcing other trades.',
      evidence:`${edgeLabel(b.dim)} = ${b.key} · n=${b.n} · expectancy ${fmtUsd(b.expectancy)} · p=${b.p!=null?b.p.toFixed(3):'—'}${b.sig?' · survives false-discovery correction':''}`,
      conf:b.sig?confLevel(b.p):'early',n:b.n,impact:Math.abs(b.net)*0.6}); }
  // behavior
  if(B.tilt){ const others=closed.filter(t=>!B.afterLoss.includes(t)).map(t=>t.net);
    const p=welchP(B.afterLoss.map(t=>t.net),others);
    add({id:'tilt',tone:'leak',title:'You trade worse right after a loss',
      body:`Trades you opened within an hour of a losing trade average ${signedPlain(B.afterLossExp)}, against ${signedPlain(s.expectancy)} across all your trades.`,
      action:'After a losing trade, wait an hour before the next entry.',
      evidence:`${B.afterLoss.length} trades within 60 min of a loss · ${fmtUsd(B.afterLossExp)}/trade vs ${fmtUsd(s.expectancy)} overall${p!=null?' · Welch p='+p.toFixed(3):''}`,
      conf:confLevel(p),n:B.afterLoss.length,impact:Math.max(0,(s.expectancy-B.afterLossExp)*B.afterLoss.length),
      habit:{tpl:'cool-off'}}); }
  if(B.overtrading){ const days=B.hiDays.length;
    const cap=Math.max(1,Math.round(_avg(B.loDays.map(d=>d.n))+0.5));
    const hiN=B.hiDays.reduce((x,d)=>x+d.n,0);
    add({id:'overtrading',tone:'leak',title:'Your busiest days are your worst days',
      body:`On your ${days} busiest days you made ${signedPlain(B.hiExp)} per trade; on normal days ${signedPlain(B.loExp)}.`,
      action:`Cap yourself at about ${cap} trade${cap===1?'':'s'} a day.`,
      evidence:`${days} high-activity days (${hiN} trades) · ${fmtUsd(B.hiExp)}/trade vs ${fmtUsd(B.loExp)}`,
      conf:days>=8?'likely':'early',n:hiN,impact:Math.max(0,(B.loExp-B.hiExp)*hiN),
      habit:{tpl:'day-cap',cap,when:`I’ve taken ${cap} trade${cap===1?'':'s'} today`,then:'I’m done for the day'}}); }
  if(B.oversizing&&B.big&&B.small){
    add({id:'oversizing',tone:'leak',title:'Your biggest trades are your worst',
      body:`Your largest positions average ${signedPlain(B.bigExp)} a trade; your smallest average ${signedPlain(B.smallExp)}.`,
      action:'Keep new trades at your usual size until this flips.',
      evidence:`Largest-quartile notional: ${B.big.n} trades at ${fmtUsd(B.bigExp)} · smallest quartile: ${B.small.n} at ${fmtUsd(B.smallExp)}`,
      conf:B.big.n>=20?'likely':'early',n:B.big.n,impact:Math.max(0,(B.smallExp-B.bigExp)*B.big.n),habit:{tpl:'size-cap'}}); }
  if(B.disposition){
    add({id:'disposition',tone:'leak',title:'You hold losers longer than winners',
      body:`Losing trades stay open ${(B.avgLHold/B.avgWHold).toFixed(1)}× as long as winners (${fmtDur(B.avgLHold)} vs ${fmtDur(B.avgWHold)}). That’s cutting winners early and hoping on losers.`,
      action:'Decide the exit before you enter, write the stop down, and honor it.',
      evidence:`Average hold: losers ${fmtDur(B.avgLHold)}, winners ${fmtDur(B.avgWHold)}`,
      conf:N>=40?'likely':'early',impact:Math.abs(closed.filter(t=>isLoss(t.net)).reduce((x,t)=>x+t.net,0))*0.15,habit:{tpl:'honor-stop'}}); }
  if(B.mistakeCost!=null&&B.mistakeCost>0&&B.flagged.length>=3){
    const cnt={}; B.flagged.forEach(t=>((journal[t.id]||{}).mistakes||[]).forEach(m=>cnt[m]=(cnt[m]||0)+1));
    const top=Object.entries(cnt).sort((a,b)=>b[1]-a[1])[0];
    const p=welchP(B.flagged.map(t=>t.net),B.clean.map(t=>t.net));
    add({id:'mistakes',tone:'leak',title:'The mistakes you flag are costing you',
      body:`Trades you flagged as mistakes average ${usdPlain(B.mistakeCost)} worse than clean ones.${top?` The most common: “${top[0]}” (${top[1]}×).`:''}`,
      action:top?`Write one rule that prevents “${top[0]}”, and check it before every entry.`:'Pick the most common flag and write a rule against it.',
      evidence:`${B.flagged.length} flagged trades at ${fmtUsd(B.flagExp)} vs ${B.clean.length} clean at ${fmtUsd(B.cleanExp)}${p!=null?' · Welch p='+p.toFixed(3):''}`,
      conf:confLevel(p),n:B.flagged.length,impact:B.mistakeCost*B.flagged.length}); }
  if(B.costDragPct!=null&&B.costDragPct>0.25)
    add({id:'fees',tone:'leak',title:`Fees eat ${pc(B.costDragPct)} of what you make`,
      body:`You paid ${usdPlain(s.fees)} in fees against ${usdPlain(B.grossReal)} of gross profit.`,
      action:'Use limit orders where you can, and take fewer, better trades.',
      evidence:`Fees ${fmtUsd(s.fees)} · gross realized ${fmtUsd(B.grossReal)}`,conf:'strong',impact:s.fees*0.5});
  if(B.ratingMono===false)
    add({id:'ratings',tone:'info',title:'Your star ratings don’t match your results',
      body:'Trades you rated higher aren’t more profitable than the ones you rated lower.',
      action:'Rate the process, not the outcome: five stars means you followed the plan exactly.',
      evidence:'Average net per star bucket is not increasing with the rating',conf:'early',impact:0});
  if(B.conc>0.6&&B.topMkt&&B.topMkt.net>0)
    add({id:'concentration',tone:'caution',title:`Most of your profit comes from ${dispMarket(B.topMkt.key)}`,
      body:`${pc(B.conc)} of your result comes from one market.`,
      action:'Make sure it’s a repeatable edge before sizing up there — not one hot run.',
      evidence:`${dispMarket(B.topMkt.key)}: ${fmtUsd(B.topMkt.net)} over ${B.topMkt.n} trades`,conf:'early',impact:B.topMkt.net*0.2});
  (function(){ const A=assetContribution(closed,'usd',5);
    if(A.worst.length&&A.neg>0){ const w=A.worst[0];
      // w.share is its part of the net losses of the markets that lost overall, not of every losing trade's
      // dollars (winning markets have losing trades too), so it's said that way: "100% of your losses" was false
      const nl=(A.rows||A.worst).filter(r=>r.v<0).length, only=nl===1, nm=dispMarket(w.key);
      if(w.share>=0.25&&Math.abs(w.net)>Math.abs(s.expectancy)*5)
        add({id:'loss-market',tone:'leak',title:only?`${nm} is your only losing market`:`${nm} is ${pc(w.share)} of what your losing markets lost`,
          body:`${only?`${nm} is the one market you lost money on this period`:`Of the markets you lost money on this period, ${nm} lost the most, ${pc(w.share)} of their combined net loss`}: ${signedPlain(w.net)} net across ${w.n} trades, ${Math.round(w.winRate*100)}% of them winners.`,
          action:`Before you drop ${nm}, compare its average trade with your other markets. If it holds up, trade it smaller instead of dropping it.`,
          evidence:`Net ${fmtUsd(w.net)} · ${only?'the only market net negative':`${pc(w.share)} of the net loss of the ${nl} markets net negative`}`,conf:w.n>=20?'likely':'early',n:w.n,impact:Math.abs(w.net)*0.5}); }
    if(A.best.length&&A.bestShare>=0.8&&A.markets>=8)
      add({id:'few-markets',tone:'edge',title:`${A.best.length} markets make ${pc(A.bestShare)} of your profit`,
        body:`Out of ${A.markets} markets you traded, a handful do nearly all the earning.`,
        action:'Put your attention and size there; the long tail mostly pays fees.',
        evidence:A.best.map(b=>dispMarket(b.key)).join(', '),conf:'likely',impact:0}); })();
  if(B.fragile)
    add({id:'fragile',tone:'caution',title:'A few big wins carry your results',
      body:`Your top 10% of trades make ${pc(B.topShare)} of your gross profit. Without your single best trade you’d be at ${signedPlain(B.netNoBest)}.`,
      action:'Protect those winners: don’t cut them early, and check they come from your plan, not luck.',
      evidence:`Top-decile share of gross profit ${pc(B.topShare)}${ext.skew!=null?' · skew '+ext.skew.toFixed(1):''}`,conf:'likely',impact:Math.abs(s.net)*0.1});
  if(s.maxDD<0&&!(nfRules().dailyLossLimit>0))
    add({id:'drawdown',tone:'caution',title:`Your worst stretch cost ${usdPlain(s.maxDD)}`,
      body:`Your longest losing streak was ${s.longL} trades in a row.`,
      action:'Set a daily loss limit, so a bad day stays a bad day (Diagnostic → Discipline & rules, or the day journal).',
      evidence:`Max drawdown ${fmtUsd(s.maxDD)} · longest losing streak ${s.longL}`,conf:'strong',impact:Math.abs(s.maxDD)*0.2,habit:{tpl:'respect-limit'}});
  const uw=ext.uw;
  if(uw&&uw.ongoingMs!=null&&uw.ongoingMs>30*86400000)
    add({id:'underwater',tone:'caution',title:`You’ve been below your peak for ${daysPlain(uw.ongoingMs)}`,
      body:'Long flat or losing stretches are where discipline usually breaks.',
      action:'Write your drawdown rules down now — a size cap and a trade cap — instead of deciding under stress.',
      evidence:`Ongoing underwater period ${fmtDur(uw.ongoingMs)}`,conf:'strong',impact:Math.abs(s.net)*0.05});
  const cdd=ext.cdd;
  if(cdd&&cdd.pct!=null&&cdd.pct>0.15)
    add({id:'in-drawdown',tone:'caution',title:cdd.pct<=1?`You’re ${Math.round(cdd.pct*100)}% below your peak`:`You’re ${usdPlain(cdd.dd)} below your peak`,
      body:`${usdPlain(cdd.dd)} down, ${cdd.since} trades since your high.`,
      action:'Stick to your rules and don’t size up to win it back.',evidence:`Current drawdown ${fmtUsd(cdd.dd)}`,conf:'strong',impact:Math.abs(cdd.dd)*0.3,habit:{tpl:'no-chase-red'}});
  const mcdd=ext.mcdd;
  if(mcdd&&s.maxDD<0&&mcdd.p95>Math.abs(s.maxDD)*1.4)
    add({id:'sequence',tone:'caution',title:'Your worst drawdown could have been deeper',
      body:`Shuffling the same trades into a different order, 1 time in 20 you’d have hit ${usdPlain(mcdd.p95)} instead of ${usdPlain(s.maxDD)}.`,
      action:`Size so you could live through a ${usdPlain(mcdd.p95)} drawdown.`,
      evidence:`Realized max DD ${fmtUsd(s.maxDD)} · shuffled p95 ${fmtUsd(-mcdd.p95)}`,conf:'likely',impact:mcdd.p95*0.1});
  if(ext.acf1!=null&&ext.acf1>0.2)
    add({id:'streaky',tone:'info',title:'Your wins and losses come in streaks',
      body:'A losing trade tends to be followed by another one, and wins cluster too.',
      action:'Size down after a loss and back up once you’re hitting again.',
      evidence:`Lag-1 autocorrelation ${ext.acf1.toFixed(2)}`,conf:'early',impact:0,habit:{tpl:'two-strikes'}});
  if(!F.some(f=>f.tone==='leak'||f.tone==='caution'))
    add({id:'clean',tone:'win',title:'No major red flags',body:'Nothing in these trades stands out as a leak right now.',
      action:'Keep journaling setups so the signals sharpen.',evidence:`${N} trades checked`,conf:'strong',impact:0});
  const TW={leak:1,caution:0.8,edge:0.6,win:0.4,info:0.3}, CW={strong:1,likely:0.7,early:0.35};
  for(const f of F)f.rank=(f.impact+1)*TW[f.tone]*CW[f.conf];
  return F.sort((a,b)=>b.rank-a.rank);
}
const TONE_TAG={leak:'Leak',edge:'Edge',caution:'Watch',info:'Note',win:'Good'};
function findingCardHtml(f, i){
  const habit=f.habit?resolveHabitSpec(f.habit):null;
  const adopted=habitAdopted(habit);
  const btn=!habit||!coachOn()?'':adopted?'<span class="fnd-adopted">✓ in your habits</span>'
    :`<button class="btn ghost fnd-adopt" data-fi="${i}" data-tip="${esc(habitSentence(habit))} — adds it to Review → Habits, tracked day by day.">Adopt as habit</button>`;
  return `<article class="fnd ${f.tone}">
    <div class="fnd-top"><span class="fnd-tag">${TONE_TAG[f.tone]||'Note'}</span><span class="fnd-conf" data-tip="${esc(confWords(f.conf))}: how sure the numbers are. Based on ${esc(sampleWords(f.n))}.">${esc(confWords(f.conf))}</span></div>
    <h4 class="fnd-title">${esc(f.title)}</h4>
    <p class="fnd-body">${esc(f.body)}</p>
    <div class="fnd-do"><b>Do this</b>${esc(f.action)}</div>
    <div class="fnd-foot"><details class="fnd-ev"><summary>The numbers</summary><p>${esc(f.evidence||'')}</p></details>${btn}</div>
  </article>`;
}
// A finding's habit hint -> a full habit spec (library template, possibly with overrides).
function resolveHabitSpec(hint){
  if(!hint)return null;
  const base=hint.tpl?HABIT_LIBRARY.find(x=>x.tpl===hint.tpl):null;
  const spec=Object.assign({},base||{},hint);
  return spec.kind&&spec.when&&spec.then?spec:null;
}
function habitAdopted(spec){ return !!spec&&habitsList().some(h=>(spec.tpl&&h.tpl===spec.tpl)||(spec.pid&&h.pid===spec.pid&&h.kind===spec.kind)); }
function wireFindingCards(root, findings){
  (root||document).querySelectorAll('.fnd-adopt').forEach(b=>{ b.onclick=async()=>{
    const f=findings[+b.dataset.fi]; const spec=f&&resolveHabitSpec(f.habit); if(!spec)return;
    b.disabled=true; await adoptHabit(spec);
    b.outerHTML='<span class="fnd-adopted">✓ in your habits</span>'; renderCoach(); }; });
}

// ---- shared coach context (memoized per data revision) ----
// all=true: the game's context (Discipline, XP, level, streak, the stats Pulse posts) — every trade
// but orphans, whatever the view (perp / spot) and dex filters show, so XP can't move with a filter
// or cherry-pick clean dexes, and matches what the server verifies from the wallet. The default
// follows the view, for the dashboard's own coach card, findings and habits. Memoized separately.
let _coachMemo={key:null,ctx:null}, _coachMemoAll={key:null,ctx:null};
function coachContext(all){
  const trades=(all?allTrades.filter(t=>!(t.orphan||(t.offRecord&&!t.isOpen))):allTrades.filter(viewFilter)).filter(t=>tradeRow(t)&&!t.movedOut); // trades, not spot day rows or balances that left
  let closedN=0, lastClose=0, net=0; for(const t of trades){ if(!t.isOpen&&t.closeTime){ closedN++; if(t.closeTime>lastClose)lastClose=t.closeTime; net+=t.net; } }
  const key=[all?'all':view+'/'+(typeof dexView==='undefined'?'':dexView),settings.tz,trades.length,closedN,lastClose,net.toFixed(2),_jrev,dayKey(Date.now()),Object.keys(_excM||{}).length,
    JSON.stringify(settings.rules||{}),JSON.stringify(settings.habits||[]),JSON.stringify(settings.playbooks||[]),_be].join('|');
  const memo=all?_coachMemoAll:_coachMemo;
  if(memo.key===key)return memo.ctx;
  const closed=trades.filter(t=>!t.isOpen&&t.closeTime);
  let rulePreds=[]; try{ rulePreds=customRules().length?customRulePreds(trades,customRules()):[]; }catch(e){}
  const pc=processContext(trades,rulePreds);
  const byDay={}; for(const t of closed){ const k=dayKey(t.closeTime); (byDay[k]=byDay[k]||[]).push(t); }
  const preds={};
  const avoid=habitsList().filter(h=>h.kind==='avoid'&&h.pid);
  if(avoid.length){ const P=customRulePreds(trades,avoid.map(h=>({pid:h.pid,name:h.when,params:h.params||{},createdAt:h.createdAt})));
    avoid.forEach((h,i)=>{ preds[h.id]=P[i]&&P[i].pred; }); }
  let findings=[];
  if(closed.length>=5){ try{
    const s=computeStatsMemo(closed,trades); // the dashboard just ran it on the same trades (period "all")
    const chron=[...closed].sort((a,b)=>a.closeTime-b.closeTime), nets=chron.map(t=>t.net);
    findings=buildFindings(closed,s,{scan:diagScanMemo(closed),sig:behaviorSignalsMemo(closed,s),cdd:currentDD(nets),uw:underwaterStats(chron),skew:_skew(nets),acf1:_autocorr1(nets),esig:edgeSignificance(nets)});
  }catch(e){ console.warn('coach findings failed',e); } }
  const ctx={trades,closed,days:pc.days,byDay,preds,findings,rulePreds};
  memo.key=key; memo.ctx=ctx; return ctx;
}
function habitProgress(h, ctx, fromMs){
  const fromKey=dayKey(Math.max(h.createdAt||0,fromMs||0));
  // memoized per coach context: the coach, the game (twice) and the badge passes ask for the same habit
  // several times a rebuild. A hit needs the same habit (by content), start day, journal revision and
  // slip days ('slip' habits read _pzSlipDays, which the game sets); callers only read the result.
  const M=habitProgress._m||(habitProgress._m=new WeakMap()); let C=M.get(ctx); if(!C)M.set(ctx,C=new Map());
  const k=JSON.stringify(h)+'|'+fromKey+'|'+_jrev, hit=C.get(k); if(hit&&hit.slips===_pzSlipDays&&hit.J===journal)return hit.v;
  const res=habitDayResults(h,ctx.days,ctx.byDay,ctx.preds[h.id],fromKey,journal);
  const v={res,...habitSummary(res)}; C.set(k,{slips:_pzSlipDays,J:journal,v}); return v;
}
function dotsHtml(res,max){ const r=res.slice(-(max||7));
  return `<span class="hdots" aria-label="${r.filter(x=>x.kept).length} of ${r.length} days kept">${r.map(x=>`<i class="${x.kept?'k':'m'}" data-tip="${esc(x.key)} · ${x.kept?'kept':'missed'}"></i>`).join('')}</span>`; }

// ---- wins: reinforcement, not only correction ----
// week = {from, to} (ms) for a past week — the letter; omitted = the current week so far.
function coachWins(ctx, week){
  const W=[]; const cur=!week;
  const wFrom=cur?lastCompletedWeekRange().to:week.from, toKey=cur?null:dayKey(week.to);
  const days=toKey?ctx.days.filter(d=>d.key<toKey):ctx.days, today=toKey||dayKey(Date.now());
  const label=cur?'this week':'that week';
  const tr=processTrend(days,20);
  // this week: the Discipline streak (Progress, Daruma); a past week's letter: the process score's own run
  let sk=tr.streak, by='process score'; if(cur){ try{ sk=gameContext().streak.current; by='Discipline'; }catch(e){} }
  if(sk>=3)W.push(`${sk} trading days in a row at ${by} 70+`);
  const js=journalStreak(cur?ctx.trades:ctx.trades.filter(t=>t.closeTime<week.to),journal,dayKey,today);
  if(js.current>=3)W.push(`Every trade journaled ${js.current} trading days running`);
  const wkFrom=dayKey(wFrom);
  const wkDays=days.filter(d=>d.key>=wkFrom);
  const st=wkDays.filter(d=>d.parts.stops!=null);
  if(st.length>=2&&st.every(d=>d.parts.stops>=0.999))W.push('Every planned stop honored '+label);
  const f=cur?weekFocus():((journal[isoWeekKey(wFrom+3.5*86400000)]||{}).focus||null); const fh0=f&&habitById(f), fh=fh0&&!fh0.retired?fh0:null;
  if(fh){ const p=habitProgress(fh,ctx,wFrom); const r=toKey?p.res.filter(x=>x.key<toKey):p.res; const kept=r.filter(x=>x.kept).length;
    if(r.length>=2&&kept===r.length)W.push(`Focus habit kept every trading day ${label} (${r.length}/${r.length})`); }
  const last=days.filter(d=>d.key<today).slice(-1)[0];
  if(last&&last.score>=70&&last.net<0)W.push(`Good loss on ${dayLabel(last.key)}: you followed your process and the market said no`);
  if(tr.avg!=null&&tr.prevAvg!=null&&tr.avg>=tr.prevAvg+5)W.push(`Process score up ${Math.round(tr.avg-tr.prevAvg)} points on the previous 20 days`);
  try{ const P=ctx.rulePreds||[]; if(P.length){
    P.forEach(x=>{ if(x.pred&&ruleFollowThrough(ctx.closed,x.pred,x.rule.createdAt).status==='working')W.push(`You’re breaking “${x.rule.name.replace(/^Avoid: /,'')}” far less since you made it a rule`); }); } }catch(e){}
  return W.slice(0,4);
}

// ---- one question per closed trade, chosen for what happened ----
function tradeQuestion(t, j, e){
  j=j||{}; const plan=nfPlan(j);
  const short=t.dir==='Short';
  if(plan&&e&&e.maePct!=null&&!e.coarse&&t.avgEntry>0){
    const stopDist=(short?(plan.stop-t.avgEntry):(t.avgEntry-plan.stop))/t.avgEntry*100;
    if(stopDist>0&&e.maePct>stopDist*1.001)return {q:'Price went through your stop and you stayed in. What made you stay?',why:'held through stop'};
  }
  if(plan&&t.avgExit>0&&(short?t.avgExit>plan.stop:t.avgExit<plan.stop))return {q:'You got out past your planned stop. What happened between the stop and the exit?',why:'exit beyond stop'};
  if(e&&e.mfePct!=null&&t.avgEntry>0){ const ret=retPct(t);
    if(e.mfePct>=1&&ret!=null&&ret<e.mfePct*0.25)return {q:`It was up ${e.mfePct.toFixed(1)}% at its best and closed at ${ret>=0?'+':''}${ret.toFixed(1)}%. Where was your exit plan?`,why:'gave back'}; }
  if(addedToLoser(t))return {q:'You added to this while it was losing. Was that the plan, or hoping?',why:'added to loser'};
  const j2=j.mistakes||[];
  if(j2.includes('Revenge trade'))return {q:'You flagged this as revenge. What would have stopped you from taking it?',why:'revenge'};
  if(!plan&&isLoss(t.net))return {q:'Where would you have known you were wrong — and why wasn’t that your exit?',why:'no plan, loss'};
  if(isWin(t.net))return {q:'What did you see before this trade that you’d want to see again?',why:'winner'};
  if(isLoss(t.net))return {q:'Was this a good trade that didn’t work, or a trade you shouldn’t have taken?',why:'loser'};
  return {q:'Why did you take it, and would you take it again?',why:'default'};
}

// ---- the dashboard coach card ----
const PART_MISS={plan:'no plan before the first trade',rules:'rules broken',planned:'no stops written while trades were open',stops:'stops not honored',limit:'kept trading past the loss limit',journal:'trades left unjournaled',playbook:'playbook rules broken'};
function lastSessionLine(ctx){
  const today=dayKey(Date.now());
  const d=ctx.days.filter(x=>x.key<today).slice(-1)[0]; if(!d)return null;
  const weak=Object.keys(d.parts).filter(p=>d.parts[p]<0.999).sort((a,b)=>PROCESS_W[b]*(1-d.parts[b])-PROCESS_W[a]*(1-d.parts[a]));
  const miss=weak.length?PART_MISS[weak[0]]:null;
  const money=`<b class="${cls(d.net)}">${signedPlain(d.net)}</b>`, sc=`process <b>${d.score}</b>`;
  const when=dayLabel(d.key);
  if(d.score>=70&&d.net>=0)return `${when}: ${money}, ${sc}. Earned the right way — do it again.`;
  if(d.score>=70)return `${when}: ${money}, ${sc}. A good loss: you did your part and the market said no.`;
  // nothing journaled yet, ever: the score is low because the journal is empty, and saying "process 0,
  // that's the thing to fix" to someone on their first visit reads as a verdict on their trading
  const everJournaled=typeof allTrades!=='undefined'&&allTrades.some(t=>isJournaled(journal[t.id]));
  if(miss===PART_MISS.journal&&!everJournaled)return `${when}: ${money}. Nothing journaled yet — open a trade below and write one line about it; the process score starts there.`;
  if(d.net>=0)return `${when}: ${money}, but ${sc}${miss?' — '+miss:''}. Green for the wrong reasons; review it like a loss.`;
  return `${when}: ${money}, ${sc}${miss?' — '+miss:''}. That’s the thing to fix today.`;
}
function coachLesson(focusH){
  const L=Object.keys(journal).filter(k=>k.startsWith('week:')&&journal[k]&&journal[k].lesson).sort().reverse().map(k=>({k,t:journal[k].lesson}));
  if(!L.length)return null;
  if(focusH){ const words=(focusH.when+' '+focusH.then).toLowerCase().match(/[a-z]{5,}/g)||[];
    const hit=L.find(x=>words.some(w=>x.t.toLowerCase().includes(w))); if(hit)return hit; }
  const doy=Math.floor(Date.now()/86400000);
  return L[doy%Math.min(L.length,12)];
}
function renderCoach(){
  const el=$('coach'); if(!el)return;
  if(!allTrades.length||!coachOn()){ el.innerHTML=''; el.classList.add('hide'); return; }
  let ctx; try{ ctx=coachContext(); }catch(e){ console.warn('coach failed',e); el.classList.add('hide'); return; }
  const rows=[];
  const ls=lastSessionLine(ctx); if(ls)rows.push({k:'Last session',v:ls});
  // today: the one next action, in priority order
  const todayK=dayJKey(Date.now()), dj=journal[todayK];
  const planned=!!(dj&&(dj.plan||dj.bias||dj.maxLoss>0));
  const recent=ctx.closed.filter(t=>t.closeTime>=Date.now()-86400000&&!isJournaled(journal[t.id])).sort((a,b)=>b.closeTime-a.closeTime)[0];
  let today=null;
  if(!planned)today={v:'Write today’s plan and your max loss before the first entry. The tripwire uses that number.',act:'<button class="btn ghost coach-go" data-go="plan">Write plan →</button>'};
  else if(recent){ const q=tradeQuestion(recent,journal[recent.id],_excM[recent.id]);
    today={v:`Your ${esc(dispMarket(dcoin(recent)))} ${recent.dir.toLowerCase()} (<span class="${cls(recent.net)}">${signedPlain(recent.net)}</span>) closed ${fmtDur(Date.now()-recent.closeTime)} ago. ${esc(q.q)}`,act:'<button class="btn ghost coach-go" data-go="inbox">Answer →</button>'}; }
  else { const top=ctx.findings.find(f=>f.tone==='leak'||f.tone==='caution');
    if(top){ const spec=resolveHabitSpec(top.habit);
      today={v:`<b>${esc(top.title)}.</b> ${esc(top.action)}`,act:spec&&!habitAdopted(spec)?'<button class="btn ghost coach-adopt">Adopt as habit</button>':''}; } }
  if(today)rows.push({k:'Today',...today});
  // first: it fills the per-day slip flags a plugged leak's habit is judged by
  let g=null; try{ g=gameContext(); }catch(e){ console.warn('progress failed',e); }
  const fid=weekFocus(), fh=fid&&habitById(fid);
  if(fh){ const p=habitProgress(fh,ctx,lastCompletedWeekRange().to);
    rows.push({k:'This week',v:`<span class="coach-habit">${esc(habitSentence(fh))}</span> ${p.total?`${dotsHtml(p.res)} <span class="mut">kept ${p.kept} of ${p.total} trading day${p.total===1?'':'s'}</span>`:'<span class="mut">no trading days yet this week</span>'}`}); }
  else rows.push({k:'This week',v:'<span class="mut">No focus habit yet. One habit a week beats ten resolutions.</span>',act:'<button class="btn ghost coach-go" data-go="habits">Pick one →</button>'});
  if(g&&g.current){ const c=g.current, kept=c.res.filter(r=>r.kept).length, xp=pzXpCfg().challenge;
    // a missed challenge can't pay any more: say so, as Progress does
    const tail=c.status==='missed'?'<span class="neg-t">missed once \u2014 a new challenge comes Monday</span>':`+${xp} XP if it holds all week`;
    rows.push({k:'Challenge',v:`<span class="coach-habit">${esc(habitSentence(c.ch.spec))}</span> ${c.res.length?`${dotsHtml(c.res)} <span class="mut">${kept} of ${c.res.length} day${c.res.length===1?'':'s'} \u00b7 ${tail}</span>`:`<span class="mut">starts with your next trading day \u00b7 +${xp} XP</span>`}`}); }
  const les=coachLesson(fh); if(les)rows.push({k:'Remember',v:`“${esc(les.t)}” <span class="mut">— your lesson, ${esc(les.k.slice(5))}</span>`});
  const gw=g?gameWins(g):[];
  // a new streak personal best already says "N days in a row" — don't say it twice
  const cw=coachWins(ctx).filter(w=>!(gw.some(x=>/discipline streak/.test(x))&&/days in a row at Discipline/.test(w)));
  const wins=[...new Set([...gw,...cw])].slice(0,4);
  const dt=tzParts(Date.now());
  ensureWeekChallenge(ctx).then(made=>{ if(made){ if(allTrades.length>=5000&&typeof coachStaged==='function'&&activeTab!=='review')coachStaged(); else renderCoach(); if(activeTab==='review')renderReview(); } }).catch(()=>{}); // big accounts: rebuilt in idle steps (journal.js)
  el.classList.remove('hide');
  el.innerHTML=`<div class="coach-head"><h3>Coach</h3><span class="hint">${DOWN[dt.dow]}, ${MONTHS[dt.mo]} ${dt.day} · from your own trades and journal</span>${g?`<button type="button" class="lvl-chip" id="coachLvl" data-tip="${esc(g.level.into+' / '+g.level.need+' XP to the next level \u00b7 discipline streak '+g.streak.current+' days, '+g.streak.shields+' shield'+(g.streak.shields===1?'':'s')+'. Open Review \u2192 Progress.')}">Lv ${g.level.level} \u00b7 ${esc(g.level.title)} ${shieldsHtml(g.streak.shields)}</button>`:''}<button type="button" class="coach-hide" id="coachHide" data-tip="Turns coach mode off: hides the coach card, habits, wins, process score and trade questions. Switch it back on in the settings panel (⚙ next to the clock toggle).">hide coach</button></div>
    ${rows.map(r=>`<div class="coach-row"><div class="coach-k">${r.k}</div><div class="coach-v">${r.v}</div><div class="coach-a">${r.act||''}</div></div>`).join('')}
    ${wins.length?`<div class="wins">${wins.map(w=>`<span class="win-chip">${esc(w)}</span>`).join('')}</div>`:''}`;
  el.querySelectorAll('.coach-go').forEach(b=>b.onclick=()=>coachGo(b.dataset.go));
  const lv=$('coachLvl'); if(lv)lv.onclick=()=>coachGo('progress');
  const hb=$('coachHide'); if(hb)hb.onclick=async()=>{ await setCoachMode(false);
    setStatus('Coach mode is off \u2014 turn it back on in the settings panel (\u2699) under Coach mode.'); };
  const ad=el.querySelector('.coach-adopt');
  if(ad)ad.onclick=async()=>{ const top=ctx.findings.find(f=>f.tone==='leak'||f.tone==='caution'); const spec=top&&resolveHabitSpec(top.habit); if(!spec)return;
    ad.disabled=true; await adoptHabit(spec); renderCoach(); };
}
function coachGo(where){
  if(where==='plan'){ _dayJEditKey=null; _dayJEditSetOn=null; } // a calendar click earlier must not redirect today's plan
  activateTab(document.querySelector('#topnav button[data-tab="review"]'));
  setTimeout(()=>{ const target=where==='plan'?$('djBias'):where==='inbox'?$('ibNote')||$('ibSetup'):where==='progress'?$('progressSec'):$('habitsSec');
    if(target){ target.scrollIntoView({behavior:'smooth',block:'center'}); if(target.focus)try{ target.focus({preventScroll:true}); }catch(e){} } },80);
}

// ---- Review: habits + weekly focus ----
function habitsSectionHtml(){
  if(!coachOn())return '';
  let ctx; try{ ctx=coachContext(); }catch(e){ return ''; }
  const list=habitsList(); const fid=weekFocus();
  const wins=coachWins(ctx);
  const row=h=>{ const p=habitProgress(h,ctx); const wk=habitProgress(h,ctx,lastCompletedWeekRange().to);
    return `<div class="hab${h.id===fid?' focus':''}">
      <div class="hab-text"><span class="hab-when">When ${esc(h.when)},</span> <span class="hab-then">${esc(h.then)}.</span>
        <div class="hab-meta">${p.total?`${dotsHtml(p.res,10)} kept ${p.kept} of ${p.total} trading day${p.total===1?'':'s'} since ${esc(dayLabel(dayKey(h.createdAt)))}${wk.total?` · this week ${wk.kept}/${wk.total}`:''}`:'no trading days since you adopted it yet'}</div></div>
      <div class="hab-btns">${h.id===fid?'<span class="hab-focus-tag">This week’s focus</span>':`<button class="btn ghost hab-focus" data-id="${esc(h.id)}">Make this week’s focus</button>`}
        <button class="btn ghost hab-retire" data-id="${esc(h.id)}" data-tip="Moves it out of your active habits. Its history stays.">Retire</button></div></div>`; };
  const avail=HABIT_LIBRARY.filter(t=>!list.some(h=>h.tpl===t.tpl));
  const fh=fid&&habitById(fid);
  let focusHtml;
  if(fh){ const wk=habitProgress(fh,ctx,lastCompletedWeekRange().to);
    focusHtml=`<div class="focus-card"><div class="focus-k">This week’s focus</div><div class="focus-sent">${esc(habitSentence(fh))}</div>
      <div class="focus-prog">${wk.total?`${dotsHtml(wk.res)} kept on ${wk.kept} of ${wk.total} trading day${wk.total===1?'':'s'} so far`:'No trading days yet this week — it starts with the next session.'}</div></div>`; }
  else focusHtml=`<div class="focus-card is-empty"><div class="focus-k">This week’s focus</div><div class="focus-sent">Pick one habit to work on this week.</div>
      <div class="focus-prog">One at a time: the coach, the process score and the weekly review all follow it.</div></div>`;
  return `<div class="diag-section" id="habitsSec"><h2>Habits <span style="font-size:11px;color:var(--faint);font-weight:400">when … then … · kept day by day</span></h2>
    ${wins.length?`<div class="wins" style="margin:0 0 14px">${wins.map(w=>`<span class="win-chip">${esc(w)}</span>`).join('')}</div>`:''}
    ${focusHtml}
    ${list.length?`<div class="hab-list">${list.map(row).join('')}</div>`:''}
    <div class="hab-add"><label for="habPick">Add a habit</label><select id="habPick"><option value="">Choose from the library…</option>${avail.map(t=>`<option value="${esc(t.tpl)}">When ${esc(t.when)}, ${esc(t.then)}</option>`).join('')}<option value="__custom">Write your own…</option></select>
      <span id="habCustom" class="hide"><input type="text" id="habWhen" maxlength="120" placeholder="When … (the trigger)"><input type="text" id="habThen" maxlength="120" placeholder="… I will (the action)"></span>
      <button class="btn ghost" id="habAddBtn">Add</button></div>
    <p class="mini-note">Library habits are scored automatically from your trades and journal. A habit you write yourself is tracked by your daily “I followed the plan” check in the day journal.</p>
  </div>`;
}
function wireHabits(){
  document.querySelectorAll('.hab-focus').forEach(b=>b.onclick=async()=>{ await setWeekFocus(b.dataset.id); renderReview(); renderCoach(); });
  document.querySelectorAll('.hab-retire').forEach(b=>b.onclick=async()=>{ await retireHabit(b.dataset.id); renderReview(); renderCoach(); });
  const pick=$('habPick'), add=$('habAddBtn'); if(!pick||!add)return;
  pick.onchange=()=>$('habCustom').classList.toggle('hide',pick.value!=='__custom');
  add.onclick=async()=>{
    let spec=null;
    if(pick.value==='__custom'){ const w=$('habWhen').value.trim().replace(/^when\s+/i,''), th=$('habThen').value.trim().replace(/^i will\s+/i,'I ');
      if(!w||!th){ $('habWhen').focus(); return; } spec={kind:'self',when:w,then:th}; }
    else spec=HABIT_LIBRARY.find(t=>t.tpl===pick.value);
    if(!spec)return;
    await adoptHabit(spec); renderReview(); renderCoach();
  };
}


// ---- coach's weekly letter (optional AI on the companion server) ----
// The only thing ever sent: this aggregate summary, shown in full before sending. No fills,
// wallet addresses, trade notes or screenshots. The server's sanitizeCoachFacts is the same
// allowlist, enforced a second time.
function coachLetterFacts(){
  const ctx=coachContext();
  const {from,to}=lastCompletedWeekRange();
  const wkKey=isoWeekKey(from+3.5*86400000);
  const inWk=ctx.closed.filter(t=>t.closeTime>=from&&t.closeTime<to);
  const prev=ctx.closed.filter(t=>t.closeTime>=from-7*86400000&&t.closeTime<from);
  const sum=a=>+a.reduce((x,t)=>x+t.net,0).toFixed(2);
  const dec=inWk.filter(t=>isWin(t.net)||isLoss(t.net));
  const fromK=dayKey(from), toK=dayKey(to);
  const wkDays=ctx.days.filter(d=>d.key>=fromK&&d.key<toK);
  const tr=processTrend(ctx.days.filter(d=>d.key<toK),20);
  let weakest=null;
  if(wkDays.length){ const avg={}; for(const p of Object.keys(PROCESS_W)){ const v=wkDays.map(d=>d.parts[p]).filter(x=>x!=null); if(v.length)avg[p]=_avg(v); }
    const w=Object.keys(avg).sort((a,b)=>avg[a]-avg[b])[0]; if(w!=null&&avg[w]<0.999)weakest=PART_MISS[w]; }
  const q=processQuadrants(ctx.days.slice(-60),70);
  const prog=h=>{ const r=habitProgress(h,ctx,from).res.filter(x=>x.key<toK); const s=habitSummary(r); return {habit:habitSentence(h),kept:s.kept,total:s.total}; };
  const we=journal[wkKey]||{}; const fh0=we.focus&&habitById(we.focus), fh=fh0&&!fh0.retired?fh0:null;
  const lessons=Object.keys(journal).filter(k=>k.startsWith('week:')&&journal[k]&&journal[k].lesson).sort().reverse().slice(0,2).map(k=>journal[k].lesson);
  return {
    week:wkKey.slice(5), trades:inWk.length, net:sum(inWk), winRate:dec.length?+(dec.filter(t=>isWin(t.net)).length/dec.length).toFixed(2):null,
    prevWeek:{trades:prev.length,net:sum(prev)},
    process:{thisWeek:wkDays.length?Math.round(_avg(wkDays.map(d=>d.score))):null,last20:tr.avg!=null?Math.round(tr.avg):null,prev20:tr.prevAvg!=null?Math.round(tr.prevAvg):null,
      goodDays:wkDays.filter(d=>d.score>=70).length,days:wkDays.length,weakestPart:weakest},
    quadrants60:{goodGreen:q.earned.n,goodRed:q.goodLoss.n,poorGreen:q.lucky.n,poorRed:q.deserved.n},
    focus:fh?prog(fh):null,
    habits:habitsList().filter(h=>!fh||h.id!==fh.id).map(prog),
    journaled:{n:inWk.filter(t=>isJournaled(journal[t.id])).length,of:inWk.length},
    // the week's playbook checklists: how many kept every rule, and the rule broken most
    playbooks:(()=>{ try{ return typeof pbSummary==='function'?pbSummary(inWk,journal,pbList()):null; }catch(e){ return null; } })(),
    findings:ctx.findings.filter(f=>f.tone!=='info').slice(0,3).map(f=>({title:f.title,action:f.action,confidence:confWords(f.conf)})),
    wins:coachWins(ctx,{from,to}), lessons,
    ...(()=>{ try{ const g=gameContext(); const c=g.challenges.find(x=>x.week===wkKey.slice(5));
      return {level:g.level.level+' '+g.level.title, streak:g.streak.current,
        challenge:c?{habit:habitSentence(c.ch.spec),kept:c.res.filter(r=>r.kept).length,total:c.res.length}:null}; }catch(e){ return {}; } })(),
  };
}
let _coachStatus=null, _letterCache={wk:null,letter:null};
async function loadCoachLetter(force){
  const box=$('coachLetter'); if(!box)return;
  if(!SRV.enabled||!coachOn()||isDemoData()){ box.innerHTML=''; return; } // the account's letter: never written from (or shown on) the sample
  let st=_coachStatus;
  if(!st){ try{ const r=await srvFetch('/api/coach/status'); if(r.ok)st=_coachStatus=await r.json(); }catch(e){} } // failures (401 before the token, network) are retried next time
  st=st||{enabled:false};
  const wk=isoWeekKey(lastCompletedWeekRange().from+3.5*86400000).slice(5);
  let letter=null;
  if(!force&&_letterCache.wk===wk)letter=_letterCache.letter;
  else{ try{ const r=await srvFetch('/api/coach/letter/'+wk); if(r.ok)letter=await r.json(); }catch(e){}
    _letterCache={wk,letter}; }
  if(!$('coachLetter'))return; // Review re-rendered meanwhile
  if(!st.enabled&&!letter){ box.innerHTML=''; return; }
  const head=`<h3 data-tip="Written by the AI coach on your companion server from the summary below \u2014 aggregate numbers, your habits and your own lessons only. Switched on by COACH_AI=1 on the server.">Coach\u2019s letter \u00b7 ${esc(wk)}</h3>`;
  if(letter&&letter.text){
    box.innerHTML=`<div class="diag-card letter">${head}<div class="letter-body">${esc(letter.text).split(/\n{2,}/).map(p=>`<p>${p.replace(/\n/g,'<br>')}</p>`).join('')}</div>
      <div class="letter-foot"><span class="mini-note" style="margin:0">Written ${esc(fmtDate(letter.writtenAt))}${letter.model?' \u00b7 '+esc(letter.model):''}</span>${st.enabled?'<button class="btn ghost" id="letterRedo">Rewrite</button>':''}</div></div>`;
  } else {
    let facts=null; try{ facts=coachLetterFacts(); }catch(e){}
    box.innerHTML=`<div class="diag-card letter">${head}
      <p class="lead" style="margin-bottom:10px">A short, plain-language note on last week: what went well, the one thing to work on, tied to your focus habit.</p>
      <details class="fnd-ev"><summary>Exactly what gets sent</summary><pre class="letter-facts">${esc(JSON.stringify(facts,null,1)||'{}')}</pre></details>
      <div class="letter-foot"><span class="mini-note" style="margin:0">No fills, wallet addresses, trade notes or screenshots leave your server.</span><button class="btn" id="letterGo"${facts?'':' disabled'}>Write my letter</button></div></div>`;
  }
  const go=$('letterGo')||$('letterRedo');
  if(go)go.onclick=async()=>{
    go.disabled=true; go.textContent='Writing\u2026';
    try{ const r=await srvFetch('/api/coach/letter/'+wk,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({facts:coachLetterFacts()})});
      const d=await r.json().catch(()=>({}));
      if(!r.ok)throw new Error(d.error||('HTTP '+r.status));
      loadCoachLetter(true);
    }catch(e){ go.disabled=false; go.textContent='Try again'; setErr('Coach letter: '+e.message); }
  };
}
