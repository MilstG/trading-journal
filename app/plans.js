// Ledger app · plans: a plan written before the trade, scored against what happened; the fill-by-fill replay steps.
// ledger.html loads the parts in order as classic scripts sharing one global scope. Code that
// runs while a part loads (not inside a function called later) may only use names declared in
// this part or an earlier one; the boot part runs last. See "Development and testing" in README.md.

/* ============================ plan vs outcome (pure) ============================ */
// A plan is the trade's journal `plan` {entry, stop, target, at} (nfPlan reads it; the stop is
// what makes it a plan). Pulse's "Plan a trade" writes one BEFORE the trade, as a pending plan in
// the journal under 'pplan:<id>' — synced like any entry — that attaches itself to the next trade
// on that market and side opening within 24h. Everything below is pure, for the tests and the server.

// one spelling for a market: case, a HIP-3 dex prefix and a spot quote don't matter ("xyz:TSLA" = "tsla")
function planCoinKey(s){ return String(s||'').trim().toUpperCase().replace(/^[A-Z0-9_-]+:/,'').split('/')[0]; }
// what's wrong with a plan form, in plain words ('' = fine). Entry is optional (the fills give it).
function pplanCheck(p){
  if(!p||!planCoinKey(p.coin))return 'Which market? Type its name, like BTC.';
  if(!(p.stop>0))return 'Add a stop: the price where the idea is wrong.';
  const long=p.dir!=='Short';
  if(p.entry>0&&(long?p.stop>=p.entry:p.stop<=p.entry))return 'For a '+(long?'long':'short')+', the stop goes '+(long?'below':'above')+' the entry.';
  if(p.target>0&&(long?p.target<=p.stop:p.target>=p.stop))return 'For a '+(long?'long':'short')+', the target goes '+(long?'above':'below')+' the stop.';
  if(p.entry>0&&p.target>0&&(long?p.target<=p.entry:p.target>=p.entry))return 'For a '+(long?'long':'short')+', the target goes '+(long?'above':'below')+' the entry.';
  return '';
}
// pending plans out of a journal, oldest first (each carries its key)
function pplanList(J){ return Object.keys(J||{}).filter(k=>k.startsWith('pplan:')&&J[k]&&typeof J[k]==='object'&&J[k].stop>0&&J[k].at>0)
  .map(k=>Object.assign({key:k},J[k])).sort((a,b)=>a.at-b.at); }
// attached → a trade took it; expired → 24h passed with no matching trade; else still waiting
function pplanStatus(p, now){ return p.tid?'attached':now-p.at>864e5?'expired':'pending'; }
// Which waiting plan goes on which trade: the first trade on the plan's market and side opening
// from 5 minutes before the plan (typed just after the click) to 24h after it. A trade that already
// has a plan with a stop keeps it — the pending one waits for the next trade. Oldest plan first,
// one plan per trade. Returns [{key, tid}].
function pplanMatches(J, trades, now){
  const out=[], used=new Set(), L=pplanList(J);
  for(const p of L)if(p.tid)used.add(p.tid);
  const has=id=>{ const q=J[id]&&J[id].plan; return !!(q&&parseFloat(q.stop)>0); };
  for(const p of L){ if(p.tid)continue; const ck=planCoinKey(p.coin); let best=null;
    for(const t of trades||[]){ if(t.dir!==(p.dir==='Short'?'Short':'Long')||used.has(t.id)||has(t.id))continue;
      if(!(t.openTime>=p.at-3e5&&t.openTime<=p.at+864e5))continue;
      if(planCoinKey(t.coin)!==ck&&planCoinKey(t.symbol)!==ck)continue;
      if(!best||t.openTime<best.openTime)best=t; }
    if(best){ used.add(best.id); out.push({key:p.key,tid:best.id}); } }
  return out;
}
// One closed trade against its plan. Prices decide the verdict, so a planned entry that differs
// from the fill can't blur it:
//   moved    — out beyond the stop (a loss bigger than the stop allowed: it was moved or widened)
//   followed — out at the stop (±10% of the risk, for slippage), at/after the target, or no target set
//   held     — out on the right side of the stop, but price traded through it while you were in
//              (a fill before the exit, or the candles' worst price, MAE, beyond the stop)
//   early    — out before the target, without the stop being hit
// R: 1R is the distance from your actual entry to the stop (the risk you carried), so a clean stop-out
// is −1R. Planned R:R uses the planned entry. Both are price-based, gross of fees and funding.
// costR: what the deviation cost against following the plan — moved/held vs the stop-out the plan
// called for (−1R); early only when the target printed while you held (else nobody knows: unpriced).
// cost$ = costR × 1R × the largest size held.
function planVerdict(t, p, e){
  if(!t||t.isOpen)return null;
  if(!p||!(p.stop>0))return {v:'none'};
  const short=t.dir==='Short', sg=short?-1:1, en=p.entry>0?p.entry:t.avgEntry;
  if(!(t.avgEntry>0)||!(t.avgExit>0)||!(Math.abs(en-p.stop)>0))return {v:'none'};
  const carried=sg*(t.avgEntry-p.stop), unit=carried>0?carried:Math.abs(en-p.stop), tol=0.1*unit;
  const rr=p.target>0?Math.abs(p.target-en)/Math.abs(en-p.stop):null;
  const R=sg*(t.avgExit-t.avgEntry)/unit, R$=unit*(t.maxSize||0);
  const past=(px,lvl)=>sg*(lvl-px)>tol; // px on the losing side of lvl by more than the slippage band
  const ev=(t.events||[]).slice(0,-1), precise=e&&e.maePct!=null&&!e.coarse;
  const worst=precise?t.avgEntry*(1-sg*e.maePct/100):null, best=e&&e.mfePct!=null&&!e.coarse?t.avgEntry*(1+sg*e.mfePct/100):null;
  const thru=ev.some(x=>past(x[1],p.stop))||(worst!=null&&past(worst,p.stop));
  const tHit=p.target>0&&(ev.some(x=>!past(x[1],p.target))||(best!=null&&!past(best,p.target)));
  const xs=sg*(t.avgExit-p.stop); // exit vs stop: <0 beyond it
  let v, costR=0, priced=true;
  if(xs<-tol){ v='moved'; costR=R+1; }
  else if(xs<=tol)v='followed';
  else if(thru){ v='held'; costR=R+1; }
  else if(p.target>0&&past(t.avgExit,p.target)){ v='early'; const tR=sg*(p.target-t.avgEntry)/unit; if(tHit)costR=R-tR; else { costR=0; priced=false; } }
  else v='followed';
  return {v, rr, R, R$, costR, cost:costR*R$, priced, thru};
}
// The plain words for each verdict: [journal label, Pulse words, what it means]
function planWords(v){ return ({followed:['Followed the plan','Followed your plan','Out at the stop, at or past the target, or with no target set — the plan ran as written.'],
  early:['Exited early','Got out before your target','Closed before the target without the stop being hit. Costed only when the target printed while you held.'],
  moved:['Stop moved or widened','Lost more than your stop allowed','The exit was beyond the planned stop: a bigger loss than the plan allowed.'],
  held:['Held past the stop','Stayed in past your stop','Price traded through your stop while you were in, and you stayed — whatever happened after was luck, not the plan.'],
  none:['No plan','No plan','No stop was written for this trade.']})[v]||['','',''];
}
// Aggregate over closed trades: share planned, how often the plan was followed, average R and the
// cost of each deviation type, and planned vs achieved R by setup. J is the journal; excM the MAE map.
function planStats(closed, J, excM){
  const by={followed:{n:0,R:0,cost:0,priced:0},early:{n:0,R:0,cost:0,priced:0},moved:{n:0,R:0,cost:0,priced:0},held:{n:0,R:0,cost:0,priced:0}};
  const setups={}; let n=0, planned=0;
  for(const t of closed||[]){ if(t.isOpen)continue; n++;
    const j=(J||{})[t.id], r=planVerdict(t,nfPlan(j),excM&&excM[t.id]); if(!r||r.v==='none')continue;
    planned++; const b=by[r.v]; b.n++; b.R+=r.R; if(r.priced){ b.cost+=r.cost; b.priced++; }
    const k=(j&&String(j.setup||'').trim())||'—', s=setups[k]=setups[k]||{k,n:0,rrS:0,rrN:0,R:0,ok:0};
    s.n++; s.R+=r.R; if(r.rr!=null){ s.rrS+=r.rr; s.rrN++; } if(r.v==='followed')s.ok++; }
  const f=by.followed, broke=planned-f.n, dev=['early','moved','held'];
  const worst=dev.map(k=>({k,cost:by[k].cost,n:by[k].n})).filter(x=>x.cost<0).sort((a,b)=>a.cost-b.cost)[0]||null;
  return {n, planned, share:n?planned/n:null, followed:f.n, adherence:planned?f.n/planned:null, by,
    avgRFollowed:f.n?f.R/f.n:null, avgRBroke:broke?dev.reduce((s,k)=>s+by[k].R,0)/broke:null,
    devCost:dev.reduce((s,k)=>s+by[k].cost,0), worst,
    bySetup:Object.values(setups).map(s=>({k:s.k,n:s.n,rr:s.rrN?s.rrS/s.rrN:null,R:s.R/s.n,adherence:s.ok/s.n})).sort((a,b)=>b.n-a.n)};
}
// Pure. The position after each fill, from the trade's fill events [time, px, size, +1 add | −1 reduce]:
// size held, running average entry, P&L banked so far, and the open P&L marked at that fill's own price
// (gross, before fees — same arithmetic as replayPnlAt, one step per fill instead of per bar).
function replayFillSteps(dir, events){
  const sg=dir==='Short'?-1:1, out=[], ev=[...(events||[])].sort((a,b)=>a[0]-b[0]); let pos=0, avg=0, real=0;
  ev.forEach((e,i)=>{ const px=e[1], sz=e[2];
    if(e[3]>0){ avg=pos+sz>0?(avg*pos+px*sz)/(pos+sz):px; pos+=sz; }
    else { const q=Math.min(sz,pos); real+=(px-avg)*q*sg; pos-=q; if(pos<=1e-12)pos=0; }
    out.push({i,t:e[0],px,sz,k:e[3],pos,avg:pos>0?avg:null,real,open:pos>0?(px-avg)*pos*sg:0,
      what:e[3]>0?(i===0?'entry':'add'):pos>0?'partial close':'exit'}); });
  return out;
}

/* ============================ pending plans: attach, prune (state) ============================ */
// Runs on every render: a plan whose trade has now loaded becomes that trade's plan (stamped with
// the time it was written, so it counts as a live plan), and plans older than 30 days are dropped.
function planAttachPending(){
  if(typeof journal!=='object'||!journal||!Array.isArray(allTrades))return 0;
  const now=Date.now(), m=pplanMatches(journal,allTrades,now); let n=0;
  for(const {key,tid} of m){ const p=journal[key], j=ensureJ(tid);
    j.plan={entry:p.entry>0?p.entry:'',stop:p.stop,target:p.target>0?p.target:'',at:p.at}; if(p.setup)j.plan.why=p.setup;
    if(!j.setup&&p.setup)j.setup=p.setup;
    p.tid=tid; markJEdit(tid); markJEdit(key); n++; }
  for(const p of pplanList(journal))if(now-p.at>30*864e5){ delete journal[p.key]; markJEdit(p.key); n++; }
  if(n)Store.set(J_KEY,journal);
  return n;
}

/* ============================ the full journal: trade row, Diagnostic ============================ */
function planFmtR(x){ return x==null||!isFinite(x)?'—':(x>=0?'+':'')+x.toFixed(2)+'R'; }
// one line under the trade's plan inputs: planned R:R, achieved R, verdict
function planOutcomeLine(t,j){
  const p=nfPlan(j); if(!p)return '';
  if(t.isOpen)return `<div class="plline" data-tip="Your stop and target are drawn on the price chart; the verdict comes when the trade closes.">Plan on · ${p.target?'planned R:R 1:'+(Math.abs(p.target-(p.entry||t.avgEntry))/Math.abs((p.entry||t.avgEntry)-p.stop)).toFixed(2):'no target'}${j.plan&&j.plan.why?' · '+esc(j.plan.why):''}</div>`;
  const r=planVerdict(t,p,_excM[t.id]); if(!r||r.v==='none')return '';
  const w=planWords(r.v), col=r.v==='followed'?'pos-t':r.v==='early'?'':'neg-t';
  return `<div class="plline" data-tip="${esc(w[2]+' Achieved R: your exit vs your entry, in units of the distance from your entry to the stop (a clean stop-out is −1R), before fees.'+(r.v!=='followed'?(r.priced?' Against following the plan: '+planFmtR(r.costR)+' ≈ '+fmtUsd(r.cost)+'.':' Not costed: the target never printed while you held.'):''))}">Plan: ${r.rr!=null?'planned 1:'+r.rr.toFixed(2)+' · ':''}achieved <span class="${cls(r.R)}">${planFmtR(r.R)}</span> · <b class="${col}">${w[0]}</b>${r.v!=='followed'&&r.priced&&r.cost?` <span class="${cls(r.cost)}">(${fmtUsd(r.cost)} vs plan)</span>`:''}</div>`;
}
// a strip of the verdict mix; each part names its count on hover (data-tip here, data-pz-tip in Pulse)
function planStripHtml(S, tipAttr, cols){
  const ks=['followed','early','moved','held'].filter(k=>S.by[k].n); if(!ks.length)return '';
  return `<div class="plstrip pz-viz" role="img" aria-label="${esc(ks.map(k=>S.by[k].n+' '+planWords(k)[1].toLowerCase()).join(', '))}">${ks.map(k=>`<i style="flex:${S.by[k].n};background:${cols[k]}" ${tipAttr}="${esc(planWords(k)[tipAttr==='data-tip'?0:1]+'\n'+S.by[k].n+' of '+S.planned+' planned trades ('+Math.round(S.by[k].n/S.planned*100)+'%) · average '+planFmtR(S.by[k].R/S.by[k].n))}"></i>`).join('')}</div>`;
}
// Diagnostic card: the full table — planned vs achieved R by setup, adherence, cost of each deviation
function planDiagHtml(closed){
  const S=planStats(closed,journal,_excM), mrow=(l,v,tip)=>`<div class="metric-row" data-tip="${esc(tip)}"><span class="ml">${l}</span><span class="mv">${v}</span></div>`;
  const head=`<h2>Plan vs outcome <span style="font-size:11px;color:var(--faint);font-weight:400">${S.planned} of ${S.n} closed trades planned</span></h2>`;
  if(!S.planned)return `<div class="diag-section">${head}<div class="diag-card"><p class="lead">No planned trades in this view. Write an entry / stop / target on a trade’s journal row, or use <b>Plan a trade</b> in Keel before you trade — it attaches itself to the trade.</p></div></div>`;
  const pct=x=>x==null?'—':Math.round(x*100)+'%', cols={followed:'var(--profit)',early:'var(--gold)',moved:'var(--loss)',held:'#E0803F'};
  const vr=['followed','early','moved','held'].map(k=>{ const b=S.by[k], w=planWords(k);
    return `<tr data-tip="${esc(w[2])}"><td class="l">${w[0]}</td><td>${b.n}</td><td>${b.n?pct(b.n/S.planned):'—'}</td><td class="${b.n?cls(b.R):''}">${b.n?planFmtR(b.R/b.n):'—'}</td><td class="${cls(b.cost)}">${k==='followed'?'—':b.priced?fmtUsd(b.cost)+(b.priced<b.n?' <span style="color:var(--faint)">('+b.priced+' of '+b.n+')</span>':''):b.n?'<span style="color:var(--faint)">not costed</span>':'—'}</td></tr>`; }).join('');
  const sr=S.bySetup.slice(0,12).map(s=>`<tr data-tip="${esc((s.k==='—'?'Planned trades with no setup written':s.k)+': '+s.n+' planned · average planned R:R '+(s.rr!=null?'1:'+s.rr.toFixed(2):'— (no targets)')+' vs '+planFmtR(s.R)+' achieved on average · plan followed '+pct(s.adherence))}"><td class="l">${esc(s.k)}</td><td>${s.n}</td><td>${s.rr!=null?'1:'+s.rr.toFixed(2):'—'}</td><td class="${cls(s.R)}">${planFmtR(s.R)}</td><td>${pct(s.adherence)}</td></tr>`).join('');
  return `<div class="diag-section">${head}<div class="diag-grid">
    <div class="diag-card"><h3 data-tip="Each planned trade gets one verdict from its prices: out beyond the stop (moved or widened), price through the stop while you held, out before the target, or the plan as written. R is gross, in units of your entry-to-stop distance.">Adherence</h3>
      ${mrow('Trades with a plan',pct(S.share)+' <span style="color:var(--faint)">'+S.planned+' / '+S.n+'</span>','Closed trades in this view with a stop written down — before the trade (Keel’s Plan a trade) or on the journal row.')}
      ${mrow('Plan followed','<span class="'+((S.adherence||0)>=0.7?'pos-t':'neg-t')+'">'+pct(S.adherence)+'</span>','Share of planned trades that ran as written: stopped at the stop, out at or past the target, or no target set and the stop never broken.')}
      ${mrow('Average R: followed vs not',planFmtR(S.avgRFollowed)+' vs '+planFmtR(S.avgRBroke),'Average achieved R on the trades where you followed the plan, against the ones where you didn’t.')}
      ${mrow('Deviations vs the plan',S.devCost?'<span class="'+cls(S.devCost)+'">'+fmtUsd(S.devCost)+'</span>':'—','Sum of every costed deviation against what following the plan would have paid. Early exits count only when the target printed while you held.')}
      ${planStripHtml(S,'data-tip',cols)}</div>
    <div class="diag-card"><h3 data-tip="What each kind of deviation did to you. Cost = your result minus what the plan would have produced: the stop-out (−1R) for a moved stop or a hold past the stop, the target for an early exit when the target printed while you held.">By verdict</h3>
      <div style="overflow-x:auto"><table class="perf-tbl"><thead><tr><th class="l">Verdict</th><th>Trades</th><th>Share</th><th>Avg R</th><th>Cost vs plan</th></tr></thead><tbody>${vr}</tbody></table></div></div>
    <div class="diag-card" style="grid-column:1/-1"><h3 data-tip="Planned trades grouped by the setup written on them: the reward-to-risk you planned against the R you actually got, and how often the plan ran as written.">By setup — planned vs achieved</h3>
      <div style="overflow-x:auto"><table class="perf-tbl"><thead><tr><th class="l">Setup</th><th>Planned</th><th>Planned R:R</th><th>Achieved R</th><th>Followed</th></tr></thead><tbody>${sr}</tbody></table></div></div>
  </div></div>`;
}

/* ============================ Pulse: Plan a trade, Your plans, step-through ============================ */
function planPzRR(p){ const en=p.entry>0?p.entry:null; return en&&p.target>0&&p.stop>0?Math.abs(p.target-en)/Math.abs(en-p.stop):null; }
function planPzPx(v){ return v>0?(+v).toLocaleString(undefined,{maximumFractionDigits:v>=1000?1:v>=1?4:6}):'—'; }
// Today: one card to plan the next trade, with what's waiting
function planTodayHtml(D){
  const now=Date.now(), wait=pplanList(journal).filter(p=>pplanStatus(p,now)==='pending');
  return `<a class="pz-card pz-plancta" href="#plan">${pzI('target',22)}<span style="flex:1;min-width:0"><b>Plan your next trade</b><span class="pz-sub" style="display:block;font-size:13px">${wait.length?esc(wait.map(p=>planCoinKey(p.coin)+' '+(p.dir==='Short'?'short':'long')).join(', '))+' waiting · '+(wait.length===1?'it attaches':'they attach')+' when you trade':'Stop and target first, then the trade'}</span></span>${pzI('chev',18)}</a>`;
}
function planPzHtml(D){
  const now=Date.now(), side=pzS.planSide==='Short'?'Short':'Long', L=pplanList(journal).reverse();
  const coins=[...new Set(allTrades.slice(-300).map(t=>planCoinKey(dcoin(t))))].slice(-12).reverse(), setups=pzSetups().slice(0,6);
  const num=(id,l,ph)=>`<div class="pz-field" style="flex:1;min-width:0"><label for="${id}" style="font-size:13px">${l}</label><input type="number" id="${id}" inputmode="decimal" step="any" min="0" placeholder="${ph}"></div>`;
  const left=p=>{ const h=Math.max(0,(p.at+864e5-now)/36e5); return h>=1?Math.floor(h)+'h left':Math.max(1,Math.round(h*60))+' min left'; };
  const row=p=>{ const st=pplanStatus(p,now), t=p.tid&&allTrades.find(x=>x.id===p.tid), r=t&&!t.isOpen?planVerdict(t,nfPlan(journal[t.id]),_excM[t.id]):null, rr=planPzRR(p);
    const what=st==='pending'?left(p):st==='expired'?'Expired — no trade within 24h':!t?'Attached':t.isOpen?'Attached · trade open':r&&r.v!=='none'?planWords(r.v)[1]+' · '+planFmtR(r.R):'Attached';
    return `<div class="pz-row-t" data-pz-tip="${esc(planCoinKey(p.coin)+' '+(p.dir==='Short'?'short':'long')+'\nStop '+planPzPx(p.stop)+(p.target?' · target '+planPzPx(p.target):'')+(p.entry?' · entry '+planPzPx(p.entry):'')+(rr?'\nRisk 1 to make '+rr.toFixed(1):'')+(p.setup?'\n'+p.setup:''))}" tabindex="0"><span><b>${esc(planCoinKey(p.coin))} ${p.dir==='Short'?'short':'long'}</b> <span class="pz-sub" style="font-size:12px">stop ${esc(planPzPx(p.stop))}${p.target?' · target '+esc(planPzPx(p.target)):''}</span></span><span style="display:flex;gap:8px;align-items:center"><b style="font-size:13px;color:${st==='pending'?'var(--pz-text)':r&&r.v==='followed'?PZ_COL.good:r&&r.v!=='none'?PZ_COL.low:'var(--pz-muted)'}">${esc(what)}</b>${st==='pending'?`<button type="button" class="pz-chip icon" data-pz-pldel="${esc(p.key)}" aria-label="Delete the ${esc(planCoinKey(p.coin))} plan">${pzI('x',16)}</button>`:''}</span></div>`; };
  return `<a class="pz-back" href="#today">${pzI('back',20)}Today</a>${pzHead('Before you trade','Plan a trade')}
    <div class="pz-wide"><div class="pz-col"><section class="pz-card" style="display:flex;flex-direction:column;gap:12px">
      <div style="display:flex;gap:10px;align-items:flex-end"><div class="pz-field" style="flex:1;min-width:0"><label for="pzPlCoin" style="font-size:13px">Market</label><input type="text" id="pzPlCoin" maxlength="24" placeholder="BTC" list="pzPlCoins" autocomplete="off" autocapitalize="characters" spellcheck="false"><datalist id="pzPlCoins">${coins.map(c=>`<option value="${esc(c)}">`).join('')}</datalist></div>
        <div class="pz-seg" role="group" aria-label="Side">${[['Long','Long'],['Short','Short']].map(([k,l])=>`<button type="button" data-pz-plside="${k}" aria-pressed="${side===k}">${l}</button>`).join('')}</div></div>
      <div style="display:flex;gap:10px">${num('pzPlEntry','Entry','optional')}${num('pzPlStop','Stop','needed')}${num('pzPlTarget','Target','optional')}</div>
      <div class="pz-field"><label for="pzPlWhy" style="font-size:13px">Why this trade (one line)</label><input type="text" id="pzPlWhy" maxlength="80" placeholder="Breakout retest" autocomplete="off"></div>
      ${setups.length?`<div class="pz-chiprow pz-wrapr" aria-label="Your setups">${setups.map(x=>`<button type="button" class="pz-chipbtn" data-pz-plwhy="${esc(x)}">${esc(x)}</button>`).join('')}</div>`:''}
      <button type="button" class="pz-cta" data-pz-plsave>Save plan</button>
      <p class="pz-fine">It attaches itself to your next trade on this market and side within 24 hours, then Keel checks how the trade went against it. No trade in 24 hours? It expires.</p></section></div>
    <div class="pz-col"><section class="pz-card pz-kv"><b class="pz-kvh">Your plans</b>${L.length?L.slice(0,8).map(row).join(''):'<p class="pz-sub" style="font-size:13px">None yet.</p>'}</section></div></div>`;
}
// Stats: % planned, how often followed, and one sentence on what not following cost
function planPzStatsHtml(closed, R){
  const S=planStats(closed,journal,_excM), when=R==='all'?'across all your trades':'over the last '+R+' days', pct=x=>x==null?'—':Math.round(x*100)+'%';
  const cols={followed:PZ_COL.good,early:PZ_COL.mid,moved:PZ_COL.low,held:'var(--pz-streak)'};
  const W=S.worst, lead=W?['','Exiting early','Losing more than your stop','Staying in past your stop'][['','early','moved','held'].indexOf(W.k)]+' cost you about '+usdPlain(W.cost)+' '+when+'.'
    :!S.planned?'Before your next trade, write down where you’re wrong (stop) and where you take profit (target).'
    :S.followed===S.planned?'You followed every plan '+when+'. Keep writing them.'
    :S.avgRFollowed!=null&&S.avgRBroke!=null?'When you followed your plan you averaged '+planFmtR(S.avgRFollowed)+'; when you didn’t, '+planFmtR(S.avgRBroke)+'.'
    :(k=>planWords(k)[1]+' on '+S.by[k].n+' of '+S.planned+' planned trade'+(S.planned===1?'':'s')+' '+when+'.')(['early','moved','held'].sort((a,b)=>S.by[b].n-S.by[a].n)[0]);
  const row=(l,v,tip)=>`<div class="pz-row-t" data-pz-tip="${esc(l+'\n'+tip)}" tabindex="0"><span>${esc(l)}</span><b>${esc(v)}</b></div>`;
  return `<section class="pz-card pz-kv pz-span" data-sec="stats:plans"><div class="pz-kvrow"><b class="pz-kvh">Your plans</b><a class="pz-link" href="#plan">Plan a trade${pzI('chev',16)}</a></div>
    ${row('Trades with a plan',pct(S.share)+(S.n?' · '+S.planned+' of '+S.n:''),'A plan is a stop written down — in Plan a trade before you trade, or on the trade afterwards.')}
    ${S.planned?row('Plan followed',pct(S.adherence)+' · '+S.followed+' of '+S.planned,'Out at your stop or your target, as planned. Getting out early, losing more than the stop, or staying in past it all count as not followed.'):''}
    ${planStripHtml(S,'data-pz-tip',cols)}<p class="pz-sub" style="font-size:14px;margin:2px 0 0">${esc(lead)}</p></section>`;
}
// The step-through under a trade's chart: one fill at a time, the position and P&L after it
function planPzRpHtml(t){
  const st=replayFillSteps(t.dir,t.events); if(st.length<2)return '';
  const i=Math.max(-1,Math.min(st.length-1,(pzS.rp||{})[t.id]!=null?pzS.rp[t.id]:-1)), s=st[i];
  const j=journal[t.id]||{}, p=nfPlan(j), sz=v=>(+v.toPrecision(6)).toLocaleString();
  const say=!s?`${st.length} fills. Step through them to see the trade the way it happened.`
    :`${s.what==='entry'?'You got in':s.what==='add'?'You added':s.what==='exit'?'You got out':'You took some off'}: ${sz(s.sz)} at ${planPzPx(s.px)}. `
      +(s.pos>0?`Holding ${sz(s.pos)}, average ${planPzPx(s.avg)}. Open P&L ${signedPlain(s.open)}`:'Flat')+`, banked ${signedPlain(s.real)}.`
      +(p&&i===st.length-1?' Plan: stop '+planPzPx(p.stop)+(p.target?', target '+planPzPx(p.target):'')+'.':'');
  return `<div class="pz-rp" role="group" aria-label="Step through the fills" data-pz-rpg="${esc(t.id)}" aria-keyshortcuts="ArrowLeft ArrowRight"><div style="display:flex;gap:8px;align-items:center">
    <button type="button" class="pz-chip icon" data-pz-rp="-1" aria-label="Previous fill"${i<0?' disabled':''}>${pzI('back',18)}</button><span class="pz-sub" style="flex:1;text-align:center;font-size:13px">${s?'Fill '+(i+1)+' of '+st.length:'Replay the fills'}</span>
    <button type="button" class="pz-chip icon" data-pz-rp="1" aria-label="Next fill"${i>=st.length-1?' disabled':''}>${pzI('chev',18)}</button></div>
    <p class="pz-sub" style="font-size:13px;margin:6px 0 0" aria-live="polite">${esc(say)}</p></div>`;
}
// the current step's fill, for the chart's marker (null when not stepping)
function planPzMark(t){ const i=(pzS.rp||{})[t&&t.id]; if(i==null||i<0)return null; const s=replayFillSteps(t.dir,t.events)[i]; return s?{t:s.t,px:s.px,k:s.k}:null; }
async function planPzAction(el){
  const ds=el.dataset;
  if(ds.pzPlside){ pzS.planSide=ds.pzPlside; el.parentElement.querySelectorAll('button').forEach(b=>b.setAttribute('aria-pressed',String(b===el))); return true; }
  if(ds.pzPlwhy){ const w=$('pzPlWhy'); if(w){ w.value=ds.pzPlwhy; w.focus(); } return true; }
  if(ds.pzPldel){ if(journal[ds.pzPldel]&&!journal[ds.pzPldel].tid){ delete journal[ds.pzPldel]; markJEdit(ds.pzPldel); await Store.set(J_KEY,journal); pzNote('Plan deleted.'); pzRender(); } return true; }
  if(ds.pzPlsave!==undefined){ const v=id=>{ const e=$(id); return e?e.value.trim():''; }, n=id=>{ const x=parseFloat(v(id)); return x>0?x:null; };
    const p={coin:planCoinKey(v('pzPlCoin')),dir:pzS.planSide==='Short'?'Short':'Long',entry:n('pzPlEntry'),stop:n('pzPlStop'),target:n('pzPlTarget'),setup:v('pzPlWhy').slice(0,80),at:Date.now()};
    const err=pplanCheck(p); if(err){ pzNote(err,'err'); return true; }
    if(p.setup&&typeof pzCanonSetup==='function')p.setup=pzCanonSetup(p.setup);
    const key='pplan:'+p.at.toString(36)+Math.random().toString(36).slice(2,6);
    journal[key]=p; markJEdit(key); await Store.set(J_KEY,journal);
    for(const id of ['pzPlCoin','pzPlEntry','pzPlStop','pzPlTarget','pzPlWhy']){ const e=$(id); if(e)e.value=''; }
    planAttachPending(); // the trade may already be on
    pzNote('Plan saved — it attaches to your next '+p.coin+' '+p.dir.toLowerCase()+'.'); pzRender(); return true; }
  if(ds.pzRp){ const g=el.closest('[data-pz-rpg]'); if(g)planPzStep(g.dataset.pzRpg,+ds.pzRp); return true; }
  return false;
}
// one step: redraw only this card's chart and step-through (a full render would drop focus and scroll)
function planPzStep(id,d){
  const t=allTrades.find(x=>x.id===id); if(!t)return;
  const n=replayFillSteps(t.dir,t.events).length, rp=pzS.rp=pzS.rp||{};
  rp[id]=Math.max(-1,Math.min(n-1,(rp[id]!=null?rp[id]:-1)+d));
  const sn=document.querySelector('[data-pz-snap="'+CSS.escape(id)+'"]'); if(sn)sn.innerHTML=pzSnapHtml(t);
  const g=document.querySelector('[data-pz-rpg="'+CSS.escape(id)+'"]'); if(!g)return;
  const had=g.contains(document.activeElement)?document.activeElement.dataset.pzRp:null;
  g.outerHTML=planPzRpHtml(t);
  const g2=document.querySelector('[data-pz-rpg="'+CSS.escape(id)+'"]'), b=g2&&(g2.querySelector('[data-pz-rp="'+had+'"]:not([disabled])')||g2.querySelector('[data-pz-rp]:not([disabled])'));
  if(had!=null&&b)b.focus();
}
// Pulse wiring of its own (pulse.js's handlers stay untouched): clicks, and ← → on a step-through
if(typeof PZ!=='undefined'&&PZ){
  document.addEventListener('click',ev=>{ const el=ev.target.closest&&ev.target.closest('[data-pz-plside],[data-pz-plwhy],[data-pz-pldel],[data-pz-plsave],[data-pz-rp]'); if(el&&!el.disabled)planPzAction(el); });
  document.addEventListener('keydown',ev=>{ if(ev.key!=='ArrowLeft'&&ev.key!=='ArrowRight')return; const g=ev.target.closest&&ev.target.closest('[data-pz-rpg]'); if(!g)return;
    ev.preventDefault(); planPzStep(g.dataset.pzRpg,ev.key==='ArrowRight'?1:-1); });
}
