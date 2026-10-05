// Ledger app · part 9 of 15: fee tiers, the weekly review, variance, risk creep, guardrails, demo mode, notifications, PWA; the exports are part 9a.
// ledger.html loads the parts in order as classic scripts sharing one global scope. Code that
// runs while a part loads (not inside a function called later) may only use names declared in
// this part or an earlier one; the boot part runs last. See "Development and testing" in README.md.

/* ============================ fee-tier optimizer ============================ */
// Hyperliquid perp fees step by trailing-14-day volume. This table is the BASE schedule
// (no staking discounts, no referral rebates) — VERIFY against app.hyperliquid.xyz/fees
// before trusting the dollar figures; last checked September 2026. Rates are decimals.
const FEE_TIERS=[ // Hyperliquid's base schedule (no staking discount): perps, and spot's own rates
  {min:0,    taker:0.00045, maker:0.00015, spotTaker:0.0007,  spotMaker:0.0004},
  {min:5e6,  taker:0.00040, maker:0.00012, spotTaker:0.0006,  spotMaker:0.0003},
  {min:25e6, taker:0.00035, maker:0.00008, spotTaker:0.0005,  spotMaker:0.0002},
  {min:100e6,taker:0.00030, maker:0.00004, spotTaker:0.0004,  spotMaker:0.0001},
  {min:500e6,taker:0.00028, maker:0,       spotTaker:0.00035, spotMaker:0},
  {min:2e9,  taker:0.00026, maker:0,       spotTaker:0.0003,  spotMaker:0},
  {min:7e9,  taker:0.00024, maker:0,       spotTaker:0.00025, spotMaker:0},
];
// Rolling volume from the per-fill events each reconstructed trade carries ([time,px,sz,k]),
// so the 14-day window is exact even when a trade spans it. The "what would last month have
// cost" answers use the recorded maker/taker split. Pure; null when there is no flow at all.
function feeTierModel(trades, now){
  now=now||Date.now();
  const cut14=now-14*86400000, cut30=now-30*86400000;
  // Hyperliquid's tier volume: perps + 2 × spot ("spot volume counts double toward your fee tier")
  let vol14=0, perp14=0, spot14=0, fees30=0, takerN30=0, makerN30=0, unk30=0, spotTakerN30=0;
  for(const t of (trades||[])){ const spot=t.market==='spot';
    for(const ev of (t.events||[])){ const n=Math.abs((ev[1]||0)*(ev[2]||0)); if(ev[0]>=cut14&&ev[0]<=now){ if(spot)spot14+=n; else perp14+=n; } }
    const last=t.closeTime||t.openTime;
    if(last>=cut30&&last<=now){ fees30+=t.fees||0; takerN30+=t.takerNotional||0; makerN30+=t.makerNotional||0; unk30+=t.unkNotional||0; if(spot)spotTakerN30+=t.takerNotional||0; }
  }
  vol14=perp14+2*spot14;
  if(!(vol14>0)&&!(takerN30+makerN30+unk30>0))return null;
  let tier=0; for(let i=0;i<FEE_TIERS.length;i++)if(vol14>=FEE_TIERS[i].min)tier=i;
  const cur=FEE_TIERS[tier], next=FEE_TIERS[tier+1]||null, perpTakerN30=takerN30-spotTakerN30;
  // taker flow priced at its own market's rate: spot fees are higher than perps at every tier
  const at=(T,k)=>perpTakerN30*T[k]+spotTakerN30*T[k==='taker'?'spotTaker':'spotMaker'];
  const takerFee30=at(cur,'taker');
  return {vol14, perp14, spot14, tier, cur, next, toNext:next?Math.max(0,next.min-vol14):null,
    takerN30, makerN30, unk30, fees30, takerFee30,
    saveAsMaker30:takerFee30-at(cur,'maker'),
    saveNextTier30:next?takerFee30-at(next,'taker'):null};
}

/* ============================ weekly review wizard + lessons ============================ */
// ISO week key ('week:GGGG-Www') from the tz-toggle calendar date — rides the existing
// journal plumbing (sync, backup, conflict merge) exactly like the 'day:' entries.
function isoWeekKey(ms){
  const p=tzParts(ms);
  const d=new Date(Date.UTC(p.y,p.mo,p.day));
  d.setUTCDate(d.getUTCDate()-((d.getUTCDay()+6)%7)+3);      // this week's Thursday fixes the ISO year
  const ft=new Date(Date.UTC(d.getUTCFullYear(),0,4));
  ft.setUTCDate(ft.getUTCDate()-((ft.getUTCDay()+6)%7)+3);   // first ISO week's Thursday
  const week=1+Math.round((d-ft)/(7*86400000));
  return 'week:'+d.getUTCFullYear()+'-W'+String(week).padStart(2,'0');
}
// Monday's midnight from the calendar fields, like addDays: stepping back dow×24h crossed the 25-hour
// day at a clock change (Sunday 23:30 after the fall-back read last Tuesday as "this Monday")
function lastCompletedWeekRange(now){
  now=now||Date.now();
  const p=tzParts(now);
  const dow=(new Date(Date.UTC(p.y,p.mo,p.day)).getUTCDay()+6)%7; // Mon=0 on the tz calendar
  const at=d=>settings.tz==='utc'?Date.UTC(p.y,p.mo,d):tzMidnight(new Date(p.y,p.mo,d,12).getTime()); // noon, then its midnight: a day whose midnight is skipped starts at 01:00
  return {from:at(p.day-dow-7), to:at(p.day-dow)};
}
function weeklyReviewSectionHtml(){
  const {from,to}=lastCompletedWeekRange();
  const wkKey=isoWeekKey(from+3.5*86400000);
  const e=journal[wkKey]||{};
  const inWeek=t=>t.closeTime>=from&&t.closeTime<to&&viewFilter(t);
  const closed=closedTrades(inWeek); // the week's trades: best, worst, count
  const net=closedMoney(inWeek).reduce((s,t)=>s+t.net,0); // the week's result: money, spot by the day it was realized
  const sorted=[...closed].sort((a,b)=>b.net-a.net);
  const best=sorted[0], worst=sorted[sorted.length-1];
  const tl=t=>t?`<b>${esc(dispMarket(dcoin(t)))}</b> ${t.dir} · <span class="${cls(t.net)}">${fmtUsd(t.net)}</span>`:'—';
  const lessons=Object.keys(journal).filter(k=>k.startsWith('week:')&&journal[k]&&journal[k].lesson)
    .sort().reverse().map(k=>({k,e:journal[k]}));
  const lrows=lessons.slice(0,12).map(x=>`<div class="metric-row"><span class="ml">${esc(x.k.slice(5))}</span><span class="mv" style="max-width:70%;text-align:right;white-space:normal;font-weight:400">${esc(x.e.lesson)}</span></div>`).join('');
  return `<div class="diag-section"><h2>Weekly review <span style="font-size:11px;color:var(--faint);font-weight:400">${esc(wkKey.slice(5))} · last completed week</span></h2>
    <div class="diag-grid">
      <div class="diag-card" data-draft-scope="${esc(wkKey)}"><h3 data-tip="Three questions, once a week, about the week that just ended. The digest automates the numbers; this automates the learning — every answer feeds the lessons library.">Guided review — ${closed.length} trade${closed.length===1?'':'s'}, net <span class="${cls(net)}">${fmtUsd(net)}</span></h3>
        ${lastWeekFocusHtml(from)}
        <div class="metric-row"><span class="ml">Best trade</span><span class="mv">${tl(best)}</span></div>
        <div class="metric-row"><span class="ml">Worst trade</span><span class="mv">${tl(worst)}</span></div>
        ${(()=>{ const s=pbSummary(closed,journal,pbList()); return s?`<div class="metric-row" data-tip="That week’s trades with a playbook checklist filled in: how many kept every rule, and the rule broken most."><span class="ml">Playbooks</span><span class="mv" style="max-width:70%;text-align:right;white-space:normal;font-weight:400">${esc(pbSummaryText(s))}</span></div>`:''; })()}
        <div class="field" style="margin-top:8px"><label>What worked — worth repeating?</label><textarea id="wrRepeat" placeholder="setups, conditions, behaviors that paid">${esc(e.repeat||'')}</textarea></div>
        <div class="field"><label>What didn't — what changes next week?</label><textarea id="wrChange" placeholder="the leak you'll plug">${esc(e.change||'')}</textarea></div>
        <div class="field"><label>One-line lesson</label><input type="text" id="wrLesson" maxlength="160" value="${esc(e.lesson||'')}" placeholder="the sentence future-you should re-read"></div>
        <div><button class="btn ghost" id="wrSave">Save week</button> <span id="wrSaved" style="color:var(--faint);font-size:11px"></span></div>
      </div>
      <div class="diag-card"><h3 data-tip="Every one-line lesson from your saved weekly reviews, newest first. Rereading these before a session is the cheapest edge available.">Lessons library</h3>
        ${lessons.length?`<p class="lead" style="margin-bottom:8px">Latest: <b>${esc(lessons[0].e.lesson)}</b></p>`:''}
        ${lrows||'<p class="lead">No lessons saved yet. Answer the three questions and the library builds itself.</p>'}
      </div>
    </div><div id="coachLetter" style="margin-top:14px"></div></div>`;
}
// Last week's focus habit, how often it was kept, and a one-click carry-over to this week.
function lastWeekFocusHtml(from){
  if(!coachOn())return '';
  const e=journal[isoWeekKey(from+3.5*86400000)]; const h=e&&e.focus&&habitById(e.focus); if(!h||h.retired)return '';
  let p={total:0,kept:0,res:[]}; try{ const ctx=coachContext(); const all=habitProgress(h,ctx,from);
    const toK=dayKey(lastCompletedWeekRange().to); p.res=all.res.filter(r=>r.key<toK); Object.assign(p,habitSummary(p.res)); }catch(err){}
  const cur=weekFocus();
  return `<div class="focus-recap"><div class="focus-k">Last week\u2019s focus</div><div class="focus-sent">${esc(habitSentence(h))}</div>
    <div class="focus-prog">${p.total?`${dotsHtml(p.res)} kept on ${p.kept} of ${p.total} trading day${p.total===1?'':'s'}`:'No trading days that week.'}
    ${cur===h.id?'<span class="fnd-adopted" style="margin-left:8px">\u2713 still this week\u2019s focus</span>':`<button class="btn ghost" id="wrKeepFocus" data-id="${esc(h.id)}" style="margin-left:8px">Keep it this week</button>`}</div></div>`;
}
function wireWeeklyReview(){
  const kf=$('wrKeepFocus'); if(kf)kf.onclick=async()=>{ await setWeekFocus(kf.dataset.id); renderReview(); renderCoach(); };
  const b=$('wrSave'); if(!b)return;
  const save=auto=>{
    const {from}=lastCompletedWeekRange();
    const wkKey=isoWeekKey(from+3.5*86400000);
    const e={repeat:$('wrRepeat').value.trim(), change:$('wrChange').value.trim(), lesson:$('wrLesson').value.trim()};
    const prev=journal[wkKey]||{};
    if(auto&&e.repeat===(prev.repeat||'')&&e.change===(prev.change||'')&&e.lesson===(prev.lesson||''))return;
    if(!(e.repeat||e.change||e.lesson||prev.focus)) delete journal[wkKey];
    else journal[wkKey]={...prev,...e,updatedAt:Date.now()}; // keeps that week's focus habit
    markJEdit(wkKey); Store.set(J_KEY,journal);
    const s=$('wrSaved'); if(s){ s.textContent='saved'; clearTimeout(s._t); s._t=setTimeout(()=>{ s.textContent=''; },1400); }
    if(!auto)renderReview(); // the lessons library updates in place (an autosave doesn't redraw under the cursor)
  };
  // the answers autosave after a pause in typing and when a field is left, like the day journal
  const card=b.closest('.diag-card');
  card.addEventListener('input',e=>{ if(e.target.matches('#wrRepeat,#wrChange,#wrLesson'))jSoon('week',()=>save(true)); });
  card.addEventListener('change',e=>{ if(e.target.matches('#wrRepeat,#wrChange,#wrLesson')){ jCancel('week'); save(true); } });
  b.onclick=()=>{ jCancel('week'); save(false); };
}

/* ============================ variance expectations ============================ */
// From YOUR OWN win rate, frequency, and net distribution (seeded MC): how likely a given
// loss streak is over the next 200 trades, and what a 1-in-20 bad month looks like at
// current sizing. Deciding NOW what normal-bad looks like is the single best antidote to
// abandoning an edge mid-drawdown — live pain then reads as variance, not falsification.
function varianceModel(closed, opts){
  opts=opts||{};
  const dec=(closed||[]).filter(t=>isWin(t.net)||isLoss(t.net));
  if(!closed||closed.length<20||dec.length<10)return null;
  const p=dec.filter(t=>isWin(t.net)).length/dec.length;
  const nets=closed.map(t=>t.net);
  const times=closed.map(t=>t.closeTime);
  const span=Math.max(1,(Math.max(...times)-Math.min(...times))/86400000);
  const perMonth=Math.max(1,Math.round(closed.length/span*30.44));
  const N=opts.horizon||200, SIM=opts.sims||2000, MAXL=10;
  _srand(_hashSeed(opts.seed||('variance|'+closed.length+'|'+dec.length)));
  const hit=new Array(MAXL+1).fill(0);
  for(let s=0;s<SIM;s++){
    let run=0,best=0;
    for(let i=0;i<N;i++){ if(_rng()>=p){ run++; if(run>best)best=run; } else run=0; }
    for(let L=1;L<=MAXL;L++)if(best>=L)hit[L]++;
  }
  const streaks=[]; for(let L=3;L<=MAXL;L++){ const pr=hit[L]/SIM; if(pr>=0.01)streaks.push({len:L,prob:pr}); }
  const months=[];
  for(let s=0;s<1000;s++){ let m=0; for(let i=0;i<perMonth;i++)m+=nets[Math.floor(_rng()*nets.length)]; months.push(m); }
  months.sort((a,b)=>a-b);
  const q=x=>months[Math.min(months.length-1,Math.floor(x*months.length))];
  return {p, n:closed.length, perMonth, horizon:N, streaks, monthP5:q(0.05), monthP25:q(0.25), monthMed:q(0.5)};
}

/* ============================ risk-creep detector ============================ */
// Median entry notional of the last 20 trades vs the 20 before, compared with how much
// capital actually changed over the same stretch. Sizing that outruns equity is the
// classic post-win-streak failure. Pure; needs 40 closed trades.
function riskCreepModel(closed, acctNow){
  const chron=(closed||[]).filter(t=>!t.isOpen&&t.closeTime).sort((a,b)=>a.closeTime-b.closeTime);
  if(chron.length<40)return null;
  const notional=t=>(t.maxSize||0)*(t.avgEntry||0);
  const last=chron.slice(-20), prior=chron.slice(-40,-20);
  const m2=nfMedian(last.map(notional)), m1=nfMedian(prior.map(notional));
  if(!(m1>0)||!(m2>0))return null;
  const sizeGrowth=m2/m1-1;
  let eqGrowth=null;
  if(acctNow>0){
    const netSince=last.reduce((s,t)=>s+t.net,0); // realized change over the last-20 stretch
    const acctThen=acctNow-netSince;
    if(acctThen>0)eqGrowth=acctNow/acctThen-1;
  }
  // creep = sizing clearly up AND clearly ahead of capital (or way up with no equity data)
  const creep=sizeGrowth>0.25&&(eqGrowth==null?sizeGrowth>0.5:sizeGrowth>eqGrowth+0.25);
  return {m1, m2, sizeGrowth, eqGrowth, creep};
}

/* ============================ unplanned-trading guardrail ============================ */
// The day journal knows whether today has a plan; the tape knows whether you're trading.
// Pure given the journal object; today = tz-toggle day, opens and closes both count.
function unplannedToday(trades, journalObj, now){
  now=now||Date.now();
  const d0=tzMidnight(now);
  let n=0;
  for(const t of (trades||[])){
    if(t.isOpen){ if(t.openTime>=d0)n++; }
    else if(t.closeTime>=d0)n++;
  }
  const dj=(journalObj||{})[dayJKey(now)];
  const hasPlan=!!(dj&&(dj.plan||dj.bias||dj.maxLoss>0));
  return {n, hasPlan, unplanned:n>=2&&!hasPlan};
}

/* ============================ demo mode ============================ */
// Seeded synthetic history so a fresh visitor (or a screenshot) sees every panel populated
// without pasting a wallet: ~5 months of perp round trips across four coins (52% win rate,
// fat left tail, mild size-follows-wins creep) plus PURR/USDC spot accumulation with a
// partial take-profit. Deterministic per seed, and it goes through the exact paste-import
// path — nothing about the pipeline is special-cased. Rows use the exchange fill schema.
function demoFills(seed, now){
  now=now||Date.now();
  _srand(_hashSeed('demo|'+(seed==null?1:seed)));
  const R=()=>_rng();
  const DAY=86400000, H=3600000;
  const coins=[{c:'ETH',px:2600},{c:'BTC',px:64000},{c:'SOL',px:150},{c:'DOGE',px:0.12}];
  const out=[]; let tid=1;
  const F=(coin,side,sz,px,time,sp,pnl,fee,crossed)=>out.push({coin,side,
    sz:String(+sz.toFixed(5)), px:String(+px.toFixed(8)), time:Math.round(time),
    startPosition:String(+sp.toFixed(5)), closedPnl:String(+pnl.toFixed(2)),
    fee:String(+fee.toFixed(4)), crossed, dir:'', tid:tid++, oid:9000+tid});
  let size=1;
  const free={}; // per-coin next-free time — overlapping same-coin round trips would read as adds
  for(let day=150;day>=1;day--){
    const t0=now-day*DAY;
    const dow=new Date(t0).getUTCDay();
    if(R()<(dow===0||dow===6?0.75:0.35)){continue;}
    const nTr=R()<0.3?2:1;
    for(let i=0;i<nTr;i++){
      const A=coins[Math.floor(R()*coins.length)];
      let open=t0+(7+R()*11)*H;
      if(free[A.c]&&open<free[A.c])open=free[A.c]+H;
      const hold=(0.4+R()*(R()<0.85?7:30))*H;
      const close=open+hold;
      if(close>now-2*H)continue;
      const px0=A.px*(1+(R()-0.5)*0.24);
      const long=R()<0.58;
      const notional=(3000+R()*9000)*size;
      const sz=notional/px0;
      const win=R()<0.52;
      // decisive moves (0.4–4.5% of notional) so the default $50 break-even band doesn't
      // turn the whole demo into scratches; ~15% of losses draw the fat left tail
      const gross=win?notional*(0.005+R()*0.04):-notional*(0.004+R()*(R()<0.15?0.09:0.03));
      const px1=px0+(long?1:-1)*gross/sz;
      const maker=R()<0.3, feeR=maker?0.00015:0.00045;
      F(A.c, long?'B':'A', sz, px0, open, 0, 0, notional*feeR, !maker);
      F(A.c, long?'A':'B', sz, px1, close, long?sz:-sz, gross, Math.abs(px1*sz)*feeR, !maker);
      free[A.c]=close;
      size*=win?1.004:0.999;
    }
  }
  // spot: four PURR buys, one partial sale near the end
  let bag=0, cost=0;
  for(let k=0;k<4;k++){
    const px=0.14+R()*0.1, sz=3000+R()*3000;
    F('PURR/USDC','B',sz,px,now-(130-k*25)*DAY+10*H,bag,0,sz*px*0.0004,true);
    bag+=sz; cost+=sz*px;
  }
  const sellSz=bag*0.4, sellPx=(cost/bag)*1.35;
  F('PURR/USDC','A',sellSz,sellPx,now-9*DAY+15*H,bag,(sellPx-cost/bag)*sellSz,sellSz*sellPx*0.0004,true);
  out.sort((a,b)=>a.time-b.time);
  return out;
}
// its own flag (core.js): pasted fills share the 'paste' wallet tag, and they're the user's data
function isDemoData(){ return !!_sample; }
async function loadDemo(){
  setStatus('Generating sample data…',true);
  try{ await loadFromPaste(demoFills(1),{offline:true,sample:true}); }
  catch(e){ setErr('Demo generation failed: '+e.message); return; }
  setStatus('Sample data loaded — '+allTrades.length+' synthetic trades across perps and spot. Nothing was fetched or saved to a wallet; add a real address whenever you like.');
}
// sample mode ends with nothing to replace its trades (a backup applied): they leave the screen too
function sampleEnd(){ if(!sampleLeave())return;
  allTrades=[]; openPositions=[]; spotHoldings=[]; accountValue=null; spotAccountValue=null; unifiedAccountValue=null; hlPnl={all:null,perp:null}; dataCoverage=null; dataAudit=null; _pastedFills=null; fillsTruncated=[];
  resetDerivedState();
  if(PZ){ try{ pzRender(); }catch(e){} } else { $('app').classList.add('hide'); $('empty').classList.remove('hide'); } }
(function(){ for(const id of ['demoBtn','demoBtn2']){ const b=$(id); if(b)b.onclick=loadDemo; } })();
// Sample candles. The sample fills are made up, so real exchange candles can never line up with them:
// in sample mode every chart and excursion reads a price path drawn here instead. One deterministic
// path per coin that passes through every one of its fills (log-linear between fills, with layered
// value noise that fades out near each fill), so any interval and any range agree with each other.
const _demoAnchors=new Map();
function demoAnchorsFor(coin){
  const tr=(typeof allTrades!=='undefined'?allTrades:[]).filter(t=>t.coin===coin), sig=tr.length+'|'+tr.reduce((a,t)=>a+(t.events||[]).length,0);
  const c=_demoAnchors.get(coin); if(c&&c.sig===sig)return c.pts;
  const pts=[]; for(const t of tr)for(const e of (t.events||[]))if(e[1]>0)pts.push([e[0],e[1]]);
  pts.sort((a,b)=>a[0]-b[0]); _demoAnchors.set(coin,{sig,pts}); return pts;
}
const _demoHash=(coin,oct,i)=>_hashSeed('dc|'+coin+'|'+oct+'|'+i)/4294967296;
function demoNoise(coin,ms){ // -1..1, smooth, with the slow swings of a real tape
  const OCT=[[86400e3,1],[14400e3,.6],[3600e3,.45],[900e3,.3],[300e3,.18],[90e3,.1]]; let v=0, w=0;
  for(let o=0;o<OCT.length;o++){ const [P,A]=OCT[o], x=ms/P, i=Math.floor(x), u=x-i, s=u*u*(3-2*u);
    v+=A*((1-s)*_demoHash(coin,o,i)+s*_demoHash(coin,o,i+1)); w+=A; }
  return (v/w)*2-1;
}
function demoPrice(coin,ms,P){
  P=P||demoAnchorsFor(coin); const FADE=20*60e3; if(!P.length)return null; // the noise fades out only in the last 20 minutes to a fill
  let lo=0, hi=P.length; while(lo<hi){ const m=(lo+hi)>>1; if(P[m][0]<=ms)lo=m+1; else hi=m; }
  const A=P[lo-1]||null, B=P[lo]||null; let base, dist;
  if(A&&B){ const u=(ms-A[0])/Math.max(1,B[0]-A[0]); base=A[1]*Math.pow(B[1]/A[1],u); dist=Math.min(ms-A[0],B[0]-ms); }
  else { const N=A||B; base=N[1]; dist=Math.abs(ms-N[0]); }
  return base*(1+Math.min(1,dist/FADE)*0.03*demoNoise(coin,ms));
}
// the same shape venueFetchCandles returns: rows [t, high, low, close, open], and coverage to b
function demoCandles(coin,itvName,a,b){
  const ms=(({'1m':60e3,'5m':300e3,'15m':900e3,'1h':3600e3,'4h':14400e3,'1d':86400e3})[itvName])||300e3, rows=[], P=demoAnchorsFor(coin);
  if(!P.length)return {rows,coveredTo:b};
  for(let t=Math.floor(a/ms)*ms;t<b;t+=ms){
    const xs=[]; for(let k=0;k<=6;k++)xs.push(demoPrice(coin,t+ms*k/6,P)); // the anchors once per request: finding them reads every trade
    for(const p of P)if(p[0]>=t&&p[0]<t+ms)xs.push(p[1]); // a fill inside the candle is inside its range
    rows.push([t,Math.max(...xs),Math.min(...xs),xs[6],xs[0]]);
  }
  return {rows,coveredTo:b};
}
(function(){ const b=$('helpBtn'); if(b)b.onclick=()=>window.open('help','_blank','noopener'); })();
// Docs entry points show whenever the page is SERVED (http/https) — the /help and /docs
// routes come from server.js, so from file:// they'd 404 and stay hidden. Protocol-gated
// rather than SRV-gated so they're findable even before/without the sync handshake.
(function(){ if(/^https?:$/.test(location.protocol))
  for(const id of ['appfoot','helpBtn','helpLink']){ const el=$(id); if(el)el.classList.remove('hide'); } })();

/* ============================ tab-visible tripwire notifications ============================ */
// The webhook covers the phone; this covers the desktop: when the app sits in a background
// tab and the tripwire trips, the OS notification fires. Permission is only ever requested
// on an explicit save gesture (rules / day plan) — never on load.
const _notified={};
function maybeNotify(key, title, body){
  try{
    if(!('Notification' in window)||Notification.permission!=='granted')return;
    if(_notified[key])return;
    _notified[key]=1;
    new Notification(title,{body, tag:key});
  }catch(e){}
}
function askNotifyPerm(){
  try{ if(('Notification' in window)&&Notification.permission==='default')Notification.requestPermission().catch(()=>{}); }catch(e){}
}

/* ============================ PWA ============================ */
// Installable when served over http(s): the manifest + icons above handle "Add to home screen".
// Full offline caching needs a companion service worker file at the origin (see self-hosting notes),
// so registration is best-effort and silently no-ops from file:// or when no sw.js is present.
let _deferredInstall=null;
// Android and desktop Chrome hand over an install prompt; iPhone Safari never does, so there the
// button explains Share → Add to Home Screen. Hidden once the app runs installed (standalone).
const installedNow=()=>{ try{ return matchMedia('(display-mode: standalone)').matches||navigator.standalone===true; }catch(e){ return false; } };
const isIOSSafari=()=>/iPhone|iPad|iPod/.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
function showInstall(on){ for(const id of ['installPWA','installSide']){ const b=$(id); if(b)b.classList.toggle('hide',!on); } }
window.addEventListener('beforeinstallprompt',e=>{ e.preventDefault(); _deferredInstall=e; showInstall(true); });
async function doInstall(){
  if(_deferredInstall){ _deferredInstall.prompt(); try{ await _deferredInstall.userChoice; }catch(e){} _deferredInstall=null; showInstall(false); return; }
  if(isIOSSafari())alert('To install Ledger on your iPhone or iPad: tap the Share button in Safari’s toolbar, then “Add to Home Screen”. It opens full screen, like an app.'); }
(function(){ for(const id of ['installPWA','installSide']){ const b=$(id); if(b)b.onclick=doInstall; }
  if(/^https?:$/.test(location.protocol)&&!installedNow()&&isIOSSafari())showInstall(true); })();
window.addEventListener('appinstalled',()=>{ _deferredInstall=null; showInstall(false); });
(function(){ try{
  if('serviceWorker' in navigator && /^https?:$/.test(location.protocol)){
    navigator.serviceWorker.register('sw.js').catch(()=>{}); // present only if the app is self-hosted with a sw.js
  }
}catch(e){} })();
// An installed phone app is resumed far more often than it's reloaded, so a deploy could go unseen
// for days. Coming back to the foreground (at most once a minute) it asks the server which version
// it would serve now; a newer one reloads the page at once, unless something typed here would be
// lost, in which case a bar offers the update instead.
function appTyped(){ return [...document.querySelectorAll('textarea,input:not([type]),input[type=text],input[type=number],input[type=search]')]
  .some(el=>el.offsetParent!==null&&el.value!==''&&el.value!==el.defaultValue); }
function appUpdateBar(){ if(document.getElementById('appUpdate'))return;
  const d=document.createElement('div'); d.id='appUpdate'; d.setAttribute('role','status');
  d.style.cssText='position:fixed;left:50%;transform:translateX(-50%);bottom:calc(16px + env(safe-area-inset-bottom));z-index:9999;display:flex;gap:12px;align-items:center;padding:10px 12px 10px 16px;border-radius:12px;background:#1B2027;color:#E8ECF1;font:500 14px/1.3 Inter,system-ui,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.35);max-width:calc(100vw - 32px);width:max-content;white-space:nowrap';
  d.innerHTML='<span>A new version is ready.</span><button type="button" style="border:0;border-radius:8px;padding:7px 12px;background:#3B82F6;color:#fff;font:600 13px Inter,system-ui,sans-serif;cursor:pointer">Update</button>';
  d.querySelector('button').onclick=()=>location.reload(); document.body.appendChild(d); }
(function(){ try{
  const meta=document.querySelector('meta[name="app-version"]'), mine=meta&&meta.content;
  if(!mine||!/^https?:$/.test(location.protocol))return; // served by our server only
  let last=Date.now(), busy=false;
  async function check(){ if(busy||document.hidden||Date.now()-last<60000)return; busy=true; last=Date.now();
    try{ const r=await fetch('/api/version',{cache:'no-store'}); const j=r.ok?await r.json():null;
      if(!j||!j.v||j.v===mine)return;
      if(appTyped())appUpdateBar(); else location.reload();
    }catch(e){} finally{ busy=false; } }
  document.addEventListener('visibilitychange',()=>{ if(!document.hidden)check(); });
  window.addEventListener('focus',check);
}catch(e){} })();

/* ============================================================================
   NEW FEATURES BUILD — added as extracted, mostly-pure functions.
   1 Capital: cash-flow ledger + money-weighted return (XIRR)
   2 Leverage survivability (liq-proximity from realized MAE)
   3 Pre-trade position sizer (Project tab)
   4 Rule engine + live daily-loss tripwire
   5 Trade-plan capture + adherence scoring
   6 Wallet / setup leaderboard (Review tab)
   7 Funding-carry lens
   Pure fns take their inputs explicitly so the Node harness / server engine can
   call them without DOM. Render fns touch the DOM and reuse existing primitives.
   ============================================================================ */

/* ---- small local helpers (nf* prefix to avoid collisions) ---- */
const nfPct=(x,dp=1)=>x==null||!isFinite(x)?'\u2014':(x*100).toFixed(dp)+'%';
const nfSignPct=(x,dp=1)=>x==null||!isFinite(x)?'\u2014':((x>=0?'+':'')+(x*100).toFixed(dp)+'%');
// Day bucket honoring the tz toggle. This used to be a raw UTC day (floor(ms/86400000)),
// so a US-timezone trader's "daily loss limit" and max-trades/day reset at 4-5pm local
// while every other day analytic used tzMidnight. One clock now.
const nfDayKey=ms=>tzMidnight(ms);
function nfMedian(a){ if(!a||!a.length)return null; const s=[...a].sort((x,y)=>x-y),n=s.length; return n%2?s[(n-1)/2]:(s[n/2-1]+s[n/2])/2; }
