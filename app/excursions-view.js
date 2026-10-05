// Ledger app · part 6b of 15: the excursion and pattern-miner panels, the trade replay chart, the benchmark.
// ledger.html loads the parts in order as classic scripts sharing one global scope. Code that
// runs while a part loads (not inside a function called later) may only use names declared in
// this part or an earlier one; the boot part runs last. See "Development and testing" in README.md.
// The journal's page only (data-only="journal" in ledger.html): these draw into the Diagnostic tab and
// the trade table, which Daruma never shows (and its replay draws with Chart.js, which Daruma doesn't
// load). What both pages need — measuring excursions, fetching candles, the replay's extremes and P&L,
// auto-refresh — stays in part 6.

// plain-English takeaways from the summary — pure so the harness can pin the wording logic
function excVerdict(s){
  const out=[]; if(!s)return out;
  const R=x=>x!=null?' ('+x.toFixed(2)+'R)':'';
  if(s.winnersMaeP90!=null)
    out.push(`9 in 10 of your winning trades never moved more than <b>${s.winnersMaeP90.toFixed(2)}%</b>${R(s.winnersMaeP90R)} against you before working out. A stop just beyond that line protects almost every winner${s.medMaeL!=null?` — and your typical loser fell <b>${s.medMaeL.toFixed(2)}%</b>, so it cuts those sooner`:''}.`);
  if(s.capture!=null)
    out.push(`For every $1 of peak open profit on winning trades, you banked <b>${Math.round(s.capture*100)}¢</b> and gave back <b>${Math.round(100-s.capture*100)}¢</b> before exiting.`);
  if(s.medMaeAtW!=null&&s.medMfeAtW!=null&&(s.timedN||0)>=10){
    const early=s.medMaeAtW<=0.35, late=s.medMfeAtW>=0.6;
    out.push(`Timing: your typical winner hits its worst dip <b>${Math.round(s.medMaeAtW*100)}%</b> of the way through the hold and peaks at <b>${Math.round(s.medMfeAtW*100)}%</b>${early&&late?' — dip-early-run-late: the danger zone is right after entry, and patience pays at the end':early?' — the danger zone is right after entry':''}.`);
  }
  if(s.paperWinners!=null&&s.paperWinners>0&&s.l)
    out.push(`<b>${s.paperWinners}</b> of your ${s.l} losers were up as much as a typical winner before closing red — those losses came from <b>exits</b>, not entries.`);
  if(s.approx)
    out.push(`Every measurement in this selection is a coarse-candle approximation — treat the numbers above as upper bounds.`);
  return out;
}
function renderExcResults(c){
  const box=$('excBox'); if(!box)return;
  const s=excSummary(c.rows);
  if(!s){ box.innerHTML='<p class="lead">No candle data available for these trades'
    +(c.skippedCoins&&c.skippedCoins.length?' (no candles for: '+c.skippedCoins.map(esc).join(', ')+')':'')+'.</p>'; return; }
  const f2=x=>x==null?'—':x.toFixed(2)+'%';
  const fR=x=>x==null?'':' <span style="color:var(--faint)">('+x.toFixed(2)+'R)</span>';
  const row=(k,v,tip)=>`<div style="display:flex;justify-content:space-between;align-items:baseline;gap:14px;padding:6px 0"><span class="lead" style="margin:0"${tip?` data-tip="${tip}"`:''}>${k}</span><span class="num" style="font-size:14px;color:var(--text);text-align:right">${v}</span></div>`;
  // coverage line — how much of the selection these stats actually describe
  const coverage=`<p class="lead" style="margin:2px 0 10px"><b>${s.n}</b> trades measured precisely (${s.w} wins / ${s.l} losses)`
    +(s.coarseN?` · <span data-tip="The exchange only serves fine candles for recent history (1m ≈ 3.5 days, 15m ≈ 52 days back). These older short trades could only be measured with candles wider than the trade itself, so their excursions are upper bounds: shown with ≈ in journal rows, excluded from the numbers below. Measurements are saved permanently — run excursions regularly and new trades lock in precise forever, so this bucket only shrinks.">${s.coarseN} approximate (≈)</span>`:'')
    +(c.skippedN?` · ${c.skippedN} skipped — no candles${c.skippedCoins&&c.skippedCoins.length?' for '+c.skippedCoins.slice(0,4).map(esc).join(', '):''}`:'')
    +(c.reused?` · ${c.reused} loaded from saved measurements`:'')+`</p>`;
  const stopsCard=`<div class="diag-card"><h3 data-tip="Max adverse excursion (MAE): the worst the price went against you during each trade. If winners rarely exceed some dip before working out, a stop just past that dip costs you almost no winners while ending losers earlier.">Your stops — what winners endure</h3>
    ${row('Typical winner pullback',`<b>${f2(s.medMaeW)}</b>${fR(s.medMaeWR)}`,'Median MAE across winning trades — the dip a normal winner survives on the way to profit.')}
    ${row('90% of winners stayed within',`<b>${f2(s.winnersMaeP90)}</b>${fR(s.winnersMaeP90R)}`,'Only 1 in 10 winners ever went further against you than this. Stop distance beyond this line protected almost nothing.')}
    ${row('Typical loser drawdown',`<b>${f2(s.medMaeL)}</b>`,'Median MAE across losing trades — how much further losers fall than winners dip. The gap between this and the winner numbers is your stop\u2019s working room.')}
  </div>`;
  const exitsCard=`<div class="diag-card"><h3 data-tip="Max favorable excursion (MFE): the best open profit each trade reached. Comparing it with what you actually realized shows how much of the move you keep versus give back.">Your exits — profit kept vs given back</h3>
    ${row('Typical winner peak',`<b>${f2(s.medMfeW)}</b>`,'Median MFE across winning trades — the open profit a normal winner reached at its best moment.')}
    ${s.capture!=null?row('Kept of every $1 peak profit',`<b>${Math.round(s.capture*100)}¢</b>`,'Realized net of winners divided by their combined peak open profit. The rest evaporated between the peak and your exit.'):''}
    ${s.capture!=null?row('Given back after the peak',`<b>${fmtUsd(s.left)}</b>`,'Total dollars of winners\u2019 peak open profit that was not realized. Some giveback is unavoidable — you can\u2019t sell the top — but this is the size of the pool better exits draw from.'):''}
    ${s.paperWinners!=null?row('Losers that peaked like winners',`<b>${s.paperWinners}</b> of ${s.l}`,'Losing trades whose open profit reached the median winner\u2019s peak before closing red. Each one is a win that was given back — an exit problem, not an entry problem.'):''}
  </div>`;
  const verdict=excVerdict(s).map(v=>`<p class="lead" style="margin:6px 0">${v}</p>`).join('');
  // open-position monitor: current excursion vs what your winners historically endured
  let openHtml='';
  if(c.openRows&&c.openRows.length){
    const rowsH=c.openRows.map(r=>{
      const over=s.winnersMaeP90!=null&&r.maePct>s.winnersMaeP90;
      const ap=r.coarse?'≈':'';
      const nm=(r.symbol&&!/^@\d+$/.test(r.symbol))?r.symbol:(spotMaps.nameByCoin[r.coin]||r.symbol||r.coin);
      return `<li>${esc(nm)} ${r.dir==='Short'?'short':'long'} · open ${fmtDur(r.ageMs)} · worst dip so far <b class="${over?'loss':''}">${ap}${f2(r.maePct)}</b>${fR(r.maeR)} · best so far ${ap}${f2(r.mfePct)}`
        +(over?` · <span class="badge no" data-tip="This position has already moved further against you than 90% of your historical winners ever did before recovering. Statistically it is behaving like your losers.">beyond winner territory</span>`:` · <span class="badge ok">within winner range</span>`)+`</li>`;
    }).join('');
    openHtml=`<div style="margin-top:14px"><h3 data-tip="Live positions measured with the same candle machinery, from entry to now, compared against the drawdown 90% of your historical winners stayed inside.">Open positions vs your history</h3><ul class="diag-list">${rowsH}</ul></div>`;
  }
  box.innerHTML=`${coverage}
    <div class="diag-grid">${stopsCard}${exitsCard}</div>
    <div style="margin-top:12px">${verdict}</div>${openHtml}
    <div class="chart-box" style="height:300px;margin-top:12px"><canvas id="excScatter"></canvas></div>
    <p class="lead" style="font-size:12px;color:var(--faint);margin-top:8px">Each dot is one trade: how far it dipped (→) vs how it ended (↑). Green above the line at its dip = survived and won; the dashed line marks the 90% winner boundary — dots right of it are in loser-behavior territory. Measured from your size-weighted entry over candle highs/lows; intra-candle sequencing is invisible, so values within one candle\u2019s range are approximate. R uses planned risk (journal) or 1R fallback. Skipped trades have no candles at any interval. Candles and measurements are cached locally — re-runs only fetch what\u2019s new.</p>
    ${c.closedRef?'<div style="margin-top:8px"><button class="btn ghost" id="excRerun" data-tip="Re-measure now: closed trades load instantly from saved measurements; open positions are re-measured from entry to the current moment, so the monitor above keeps tracking a position while it is still open instead of going stale until something closes.">Update open positions</button></div>':''}`;
  const rr=$('excRerun'); if(rr)rr.onclick=rerunExcursions;
  const plotRows=c.rows.filter(r=>!r.coarse).length?c.rows.filter(r=>!r.coarse):c.rows;
  const W=plotRows.filter(r=>r.net>0),L=plotRows.filter(r=>r.net<=0);
  if(_diagCharts.exc)_diagCharts.exc.destroy();
  const rets=plotRows.map(r=>r.ret), yMin=Math.min(0,...rets), yMax=Math.max(0,...rets);
  const p90=s.winnersMaeP90;
  const dsets=[
    {label:'wins',data:W.map(r=>({x:r.maePct,y:r.ret})),backgroundColor:'rgba(47,208,140,.55)',pointRadius:3},
    {label:'losses',data:L.map(r=>({x:r.maePct,y:r.ret})),backgroundColor:'rgba(240,97,109,.55)',pointRadius:3}];
  if(p90!=null)dsets.push({label:'p90',type:'line',data:[{x:p90,y:yMin},{x:p90,y:yMax}],
    borderColor:'rgba(230,180,80,.7)',borderWidth:1.4,borderDash:[5,4],pointRadius:0,fill:false});
  _diagCharts.exc=new Chart($('excScatter'),{type:'scatter',data:{datasets:dsets},
    options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},
      tooltip:{filter:i=>i.dataset.label!=='p90',
        callbacks:{label:ctx=>' dipped '+ctx.parsed.x.toFixed(2)+'% → ended '+(ctx.parsed.y>=0?'+':'')+ctx.parsed.y.toFixed(2)+'%'}}},
      scales:scales({title:{display:true,text:'worst dip during the trade (% of entry)',color:'#8b93a7',font:{size:11}}}),
      interaction:{intersect:false,mode:'nearest'}}});
  explain(_diagCharts.exc,'One dot per trade: across, the worst it went against you; up, how it ended. Dots right of the dashed line dipped deeper than 90% of your winners ever did.');
}
// Re-run on demand: closed trades reload from saved measurements (fast); open positions
// get a fresh entry-to-now measurement — the monitor no longer goes stale while a
// position's window keeps growing.
async function rerunExcursions(){
  const closed=_excCache.closedRef; if(!closed)return;
  const btn=$('excRerun'); if(btn){ btn.disabled=true; btn.textContent='Updating…'; }
  try{
    const openT=allTrades.filter(t=>t.isOpen&&viewFilter(t));
    const out=await runExcursions(closed,openT);
    _excCache={..._excCache,...out};
    for(const r of out.rows)_excM[r.id]=r;
    // open-position measurements are tagged: once the trade closes, the stale entry-to-
    // earlier-now window must not feed the miner's exc families until the ratchet re-measures
    for(const r of (out.openRows||[]))_excM[r.id]={...r,openMeas:true};
    renderExcResults(_excCache);
    setStatus('Excursions updated'+(out.openRows&&out.openRows.length?' · '+out.openRows.length+' open position'+(out.openRows.length===1?'':'s')+' re-measured':' · no open positions in this view')+'.');
  }catch(e){ setStatus('Excursion update stopped: '+e.message);
    const b=$('excRerun'); if(b){ b.disabled=false; b.textContent='Update open positions'; } }
}
function wireExcursions(closed){
  const box=$('excBox'); if(!box)return;
  const key=[view,period,customRange.from,customRange.to,closed.length,dexView].join('|'); // dex filter can change the universe at identical length
  if(_excCache.key===key&&_excCache.rows){ renderExcResults(_excCache); return; }
  const btn=$('runExc'); if(!btn)return;
  btn.onclick=async()=>{ btn.disabled=true; btn.textContent='Fetching candles…';
    try{ const openT=allTrades.filter(t=>t.isOpen&&viewFilter(t));
      const out=await runExcursions(closed,openT);
      _excCache={key,...out,closedRef:closed}; // closedRef powers the update-open-positions re-run
      for(const r of out.rows)_excM[r.id]=r;
    // open-position measurements are tagged: once the trade closes, the stale entry-to-
    // earlier-now window must not feed the miner's exc families until the ratchet re-measures
    for(const r of (out.openRows||[]))_excM[r.id]={...r,openMeas:true};
      // fresh excursion data unlocks new miner families — invalidate any cached scan
      _minerCache={key:null,res:null,deep:null};
      const rb=$('runMiner'); if(rb){ rb.disabled=false; rb.textContent='Run pattern miner + deep scan'; }
      renderExcResults(_excCache);
      renderTable(); // journal rows now show per-trade MAE/MFE
      setStatus(`Excursions computed for ${out.rows.length} trade${out.rows.length===1?'':'s'}${out.openRows&&out.openRows.length?' + '+out.openRows.length+' open':''}${out.skippedN?' · '+out.skippedN+' skipped (no candles)':''}.`);
    }catch(e){ box.innerHTML='<p class="lead">Excursion scan stopped: '+esc(e.message)+'</p>'
      +'<button class="btn ghost" id="runExc">Retry</button>'; wireExcursions(closed); setStatus(''); } };
}

async function openReplay(id,btn){
  const box=document.getElementById('replay-'+id); if(!box)return;
  if(_replayFor===id&&_replayChart){ clearInterval(_replayTimer); _replayChart.destroy(); _replayChart=null; _replayFor=null; box.innerHTML=''; return; }
  const t=allTrades.find(x=>x.id===id); if(!t){ box.innerHTML='<p class="lead">Trade not found.</p>'; return; }
  if(btn)btn.textContent='Loading candles…';
  const got=await ensureTradeCandles(t);
  if(btn)btn.textContent='📈 Price chart';
  if(!got){ box.innerHTML='<p class="lead" style="font-size:12px">No candles available for this trade (coin unsupported or beyond retention).</p>'; return; }
  const {candles,itv}=got;
  const closeT=t.isOpen?Date.now():t.closeTime;
  // candlesticks as two overlaid floating-bar datasets (thin wick low..high, thick body open..close),
  // per-candle up/down colors; open derived via candleOpen so pre-open cache rows still render.
  const wick=[],wickBg=[],body=[],bodyBg=[],meta=[];
  for(let i=0;i<candles.length;i++){ const k=candles[i];
    const o=candleOpen(candles,i), c=isFinite(k[3])?k[3]:(k[1]+k[2])/2, up=c>=o;
    const a=up?'rgba(47,208,140,':'rgba(244,88,106,';
    wick.push({x:k[0],y:[k[2],k[1]]}); wickBg.push(a+'.85)');
    body.push({x:k[0],y:[Math.min(o,c),Math.max(o,c)]}); bodyBg.push(a+(up?'.8)':'.85)'));
    meta.push({o,c}); }
  // price range from the candles + avg lines first — marker flag offsets are sized from it.
  let plo=Infinity,phi=-Infinity;
  for(const k of candles){ if(isFinite(k[2])&&k[2]<plo)plo=k[2]; if(isFinite(k[1])&&k[1]>phi)phi=k[1]; }
  if(isFinite(t.avgEntry)&&t.avgEntry>0){ plo=Math.min(plo,t.avgEntry); phi=Math.max(phi,t.avgEntry); }
  if(!t.isOpen&&t.avgExit>0){ plo=Math.min(plo,t.avgExit); phi=Math.max(phi,t.avgExit); }
  // the written plan (stop / target) and the trade's own worst / best prices while it was on
  const plan=coachOn()?nfPlan(journal[t.id]):null;
  const ex=coachOn()?replayExtremes(t,candles,itv.ms):null;
  if(plan){ for(const v of [plan.stop,plan.target]) if(v>0){ plo=Math.min(plo,v); phi=Math.max(phi,v); } }
  // fill markers: every entry/add (gold triangle up) and every partial/final close (green triangle
  // down). Drawn as flags UNDER (entry/add) or OVER (close) the candle that holds the fill — never
  // at the raw fill price, which buries the marker inside the candle body. Several fills on the
  // same side of one candle stack outward. The exact fill price/size/time lives in the hover.
  const evs=(t.events||[]).filter(e=>e[0]>=t.openTime-itv.ms&&e[0]<=closeT+itv.ms);
  const cIdx=ts=>{ let lo=0,hi=candles.length-1,best=0;
    while(lo<=hi){ const m=(lo+hi)>>1; if(candles[m][0]<=ts){best=m;lo=m+1;} else hi=m-1; } return best; };
  const off=(phi-plo)*0.045||Math.abs(phi)*0.002||1;
  const stacked={};
  const marks=evs.map((e,i)=>{ const ci=cIdx(e[0]), k=candles[ci], key=ci+':'+(e[3]>0?'b':'s');
    const n=stacked[key]=(stacked[key]||0)+1;
    const y=e[3]>0 ? (isFinite(k[2])?k[2]:e[1])-off*(0.6+0.9*n)
                   : (isFinite(k[1])?k[1]:e[1])+off*(0.6+0.9*n);
    return {x:k[0],y,px:e[1],k:e[3],sz:e[2],
      lbl:e[3]>0?(i===0?'entry':'add'):((!t.isOpen&&i===evs.length-1)?'exit':'partial close')}; });
  const xmin=candles[0][0]-itv.ms/2, xmax=candles[candles.length-1][0]+itv.ms/2;
  // bar datasets default the value axis to beginAtZero, which squashes a tight price range
  // against 0 — pin the y range to the actual extremes (candles + marker flags + avg lines).
  let ylo=plo,yhi=phi;
  for(const m of marks){ if(m.y<ylo)ylo=m.y; if(m.y>yhi)yhi=m.y; }
  const ypad=(yhi-ylo)*0.06||Math.abs(yhi)*0.002||1; ylo-=ypad; yhi+=ypad;
  const hline=(y,color,dash)=>({type:'line',data:[{x:xmin,y},{x:xmax,y}],borderColor:color,borderWidth:1.2,borderDash:dash,pointRadius:0,fill:false});
  const dsets=[
    {type:'bar',data:wick,backgroundColor:wickBg,grouped:false,barThickness:1,borderWidth:0,minBarLength:1,order:4},
    {type:'bar',data:body,backgroundColor:bodyBg,grouped:false,barPercentage:0.82,categoryPercentage:1,maxBarThickness:14,borderWidth:0,minBarLength:2,order:3},
    hline(t.partialHistory&&!(t.openSz>0)?null:t.avgEntry,'rgba(230,180,80,.8)',[4,3]), // no entry line when every opening fill predates the history: the stand-in was the exit price
  ];
  const XDS=!t.isOpen&&t.avgExit>0?dsets.length:-1; // the avg-exit line: hidden while replaying, until the close
  if(!t.isOpen&&t.avgExit>0)dsets.push(hline(t.avgExit,'rgba(47,208,140,.8)',[4,3]));
  if(plan&&plan.stop>0)dsets.push(hline(plan.stop,'rgba(244,88,106,.9)',[2,3]));
  if(plan&&plan.target>0)dsets.push(hline(plan.target,'rgba(47,208,140,.95)',[2,3]));
  const EDS=ex?dsets.length:-1;
  if(ex)dsets.push({type:'scatter',order:2,data:[ex.worst,ex.best].filter(Boolean),
    pointStyle:'crossRot',pointRadius:7,pointHoverRadius:8,borderWidth:2,
    borderColor:[ex.worst,ex.best].filter(Boolean).map(p=>p.kind==='worst'?'rgba(244,88,106,1)':'rgba(47,208,140,1)')});
  const MDS=dsets.length;
  if(marks.length)dsets.push({type:'scatter',data:marks,order:1,
    pointStyle:'triangle',rotation:marks.map(m=>m.k>0?0:180),
    pointRadius:6,pointHoverRadius:7,borderColor:'rgba(10,14,24,.9)',borderWidth:1,
    backgroundColor:marks.map(m=>m.k>0?'rgba(230,180,80,.95)':'rgba(47,208,140,.95)')});
  box.innerHTML='<div class="chart-box" style="height:260px;margin:8px 0"><canvas id="rp-'+id.replace(/[^a-zA-Z0-9_-]/g,'_')+'"></canvas></div>'
    +'<p class="lead" style="font-size:11.5px;color:var(--faint);margin:2px 0 8px">'+itv.name+' candles · \u25b2 = entry / add fill · \u25bc = close fill · gold dash = avg entry'+(!t.isOpen&&t.avgExit>0?' · green dash = avg exit':'')
    +(plan&&plan.stop>0?' · red dots = planned stop':'')+(plan&&plan.target>0?' · green dots = planned target':'')
    +(ex?' · \u2715 = worst / best price while the trade was on':'')+' · hover a candle for OHLC, a marker for the fill</p>'
    // (past the stop by more than the verdict's slippage band — 10% of entry-to-stop — so a wick can't contradict "followed the plan")
    +(ex&&plan&&plan.stop>0&&ex.worst&&(t.dir==='Short'?ex.worst.y>plan.stop:ex.worst.y<plan.stop)&&Math.abs(ex.worst.y-plan.stop)>0.1*Math.abs(t.avgEntry-plan.stop)?'<p class="lead" style="font-size:12px;margin:0 0 8px;border-left:2px solid var(--loss);padding-left:8px">Price traded through your planned stop (worst '+ex.worst.y.toLocaleString(undefined,{maximumFractionDigits:6})+' vs stop '+plan.stop.toLocaleString(undefined,{maximumFractionDigits:6})+') and the position stayed open.</p>':'');
  const cv=box.querySelector('canvas');
  if(_replayChart)_replayChart.destroy();
  _replayFor=id;
  const fpx=v=>{const a=Math.abs(v);return v.toLocaleString(undefined,{maximumFractionDigits:a>=1000?2:a>=1?4:6});};
  const szf=v=>v.toLocaleString(undefined,{maximumFractionDigits:6});
  _replayChart=new Chart(cv,{data:{datasets:dsets},options:{responsive:true,maintainAspectRatio:false,
    plugins:{legend:{display:false},tooltip:{
      filter:i=>i.datasetIndex===1||(marks.length&&i.datasetIndex===MDS)||i.datasetIndex===EDS,
      callbacks:{title:()=>'',label:c=>{
        if(c.datasetIndex===EDS){ const p=c.raw;
          return ' '+(p.kind==='worst'?'worst':'best')+' price while on: '+fpx(p.y)+' ('+(p.pct>=0?'+':'')+p.pct.toFixed(2)+'% vs avg entry) · '+new Date(p.x).toLocaleString(); }
        if(marks.length&&c.datasetIndex===MDS){ const m=c.raw;
          return ' '+m.lbl+' · '+szf(m.sz)+' @ '+fpx(m.px)+' · '+new Date(m.x).toLocaleString(); }
        const i=c.dataIndex,k=candles[i],m=meta[i];
        const chg=m.o>0?(m.c/m.o-1)*100:null;
        return [' '+new Date(k[0]).toLocaleString(),
          ' O '+fpx(m.o)+'  H '+fpx(k[1])+'  L '+fpx(k[2])+'  C '+fpx(m.c)+(chg!=null?'  ('+(chg>=0?'+':'')+chg.toFixed(2)+'%)':'')];
      }}}},
    scales:{x:{type:'linear',min:xmin,max:xmax,grid:{color:GRID,drawTicks:false},border:{display:false},
      ticks:{maxTicksLimit:7,callback:v=>{const d=new Date(v);return (closeT-t.openTime>3*86400e3)?(d.getMonth()+1)+'/'+d.getDate():d.getHours()+':'+String(d.getMinutes()).padStart(2,'0');}}},
      y:{min:ylo,max:yhi,beginAtZero:false,grid:{color:GRID,drawTicks:false},border:{display:false},
        ticks:{callback:v=>{const a=Math.abs(v);return v.toLocaleString(undefined,{maximumFractionDigits:a>=1000?2:a>=1?4:6});}}}},
    interaction:{intersect:false,mode:'nearest'}}});
  explain(_replayChart,'The market while this trade was on: candles are price, triangles your fills, dashed lines your average entry and exit.');
  replayWire(box,t,{candles,wick,wickBg,body,bodyBg,marks,EDS,MDS,XDS,cIdx,fpx});
}

function replayWire(box,t,S){
  clearInterval(_replayTimer); _replayTimer=null;
  const ch=_replayChart, n=S.candles.length;
  const start=Math.max(0,S.cIdx(t.openTime)-5), end=n-1;
  let k=end, speed=1;
  const evs=[...(t.events||[])].sort((a,b)=>a[0]-b[0]);
  // one state per fill (size, average entry, banked P&L) and the candle holding each fill —
  // Shift+arrows and the ⇤ ⇥ buttons jump between them. The plan + verdict note follows coach mode, like the plan lines.
  const fs=replayFillSteps(t.dir,evs), fBar=fs.map(f=>S.cIdx(f.t));
  const risk=typeof riskFor==='function'?riskFor(t):null;
  const j=journal[t.id]||{}, plan=coachOn()?nfPlan(j):null, pv=plan&&!t.isOpen?planVerdict(t,plan,_excM[t.id]):null;
  const ctl=document.createElement('div'); ctl.className='rpctl';
  ctl.innerHTML=`<div class="rprow" role="group" aria-label="Replay controls. Left and right arrows step one bar, Shift with an arrow jumps to the previous or next fill, Space plays or pauses, Home and End go to the start and the end." aria-keyshortcuts="ArrowLeft ArrowRight Shift+ArrowLeft Shift+ArrowRight Space Home End">
      <button type="button" class="btn ghost" data-rp="start" title="Back to before the entry" aria-label="Back to before the entry">⏮</button>
      <button type="button" class="btn ghost" data-rp="pfill" title="Previous fill (Shift+←)" aria-label="Previous fill">⇤</button>
      <button type="button" class="btn ghost" data-rp="back" title="One bar back (←)" aria-label="One bar back">◀</button>
      <button type="button" class="btn" data-rp="play" aria-label="Play">▶ Replay</button>
      <button type="button" class="btn ghost" data-rp="fwd" title="One bar forward (→)" aria-label="One bar forward">▶|</button>
      <button type="button" class="btn ghost" data-rp="nfill" title="Next fill (Shift+→)" aria-label="Next fill">⇥</button>
      <input type="range" min="${start}" max="${end}" value="${end}" step="1" aria-label="Replay position">
      <select aria-label="Replay speed"><option value="1">1×</option><option value="3">3×</option><option value="8">8×</option></select>
      <button type="button" class="btn ghost" data-rp="attach" title="Save this chart, as it looks now, to the trade’s screenshots — then mark it up with ✎">📎 Attach chart</button></div>
    <div class="rpread" aria-live="polite"></div>
    ${plan?`<div class="rpnote" data-tip="Your written plan, drawn on the chart as dotted lines (red stop, green target). The verdict compares the exit with it — see Diagnostic → Plan vs outcome."><b>Your plan</b>stop ${esc(S.fpx(plan.stop))}${plan.target?' · target '+esc(S.fpx(plan.target)):''}${plan.entry?' · entry '+esc(S.fpx(plan.entry)):''}${j.plan&&j.plan.why?' · '+esc(j.plan.why):''}${pv&&pv.v!=='none'?' → <b style="margin:0">'+esc(planWords(pv.v)[0])+'</b> ('+esc(planFmtR(pv.R))+')':''}</div>`:''}
    ${j.notes?`<div class="rpnote"><b>Your note</b> ${esc(j.notes)}</div>`:''}`;
  box.appendChild(ctl);
  const slider=ctl.querySelector('input[type=range]'), read=ctl.querySelector('.rpread'), playBtn=ctl.querySelector('[data-rp="play"]');
  const show=i=>{ k=Math.max(start,Math.min(end,i)); slider.value=k;
    const D=ch.data.datasets, upTo=S.candles[k][0], done=k===end;
    D[0].data=S.wick.slice(0,k+1); D[0].backgroundColor=S.wickBg.slice(0,k+1);
    D[1].data=S.body.slice(0,k+1); D[1].backgroundColor=S.bodyBg.slice(0,k+1);
    if(S.marks.length&&D[S.MDS]){ const vis=S.marks.map((m,i)=>m.x<=upTo?i:-1).filter(i=>i>=0), lastX=vis.length?S.marks[vis[vis.length-1]].x:null;
      D[S.MDS].data=vis.map(i=>S.marks[i]); D[S.MDS].rotation=vis.map(i=>S.marks[i].k>0?0:180);
      D[S.MDS].backgroundColor=vis.map(i=>S.marks[i].k>0?'rgba(230,180,80,.95)':'rgba(47,208,140,.95)');
      // while stepping, the latest fill stands out: bigger and white-edged
      const cur=vis.map(i=>!done&&S.marks[i].x===lastX); D[S.MDS].pointRadius=cur.map(c=>c?9:6); D[S.MDS].borderColor=cur.map(c=>c?'#fff':'rgba(10,14,24,.9)'); D[S.MDS].borderWidth=cur.map(c=>c?2:1); }
    if(S.XDS>=0&&D[S.XDS])D[S.XDS].hidden=!done;
    if(S.EDS>=0&&D[S.EDS])D[S.EDS].hidden=!done;
    ch.update('none');
    const c=S.candles[k], px=isFinite(c[3])?c[3]:(c[1]+c[2])/2, barEnd=c[0]+(k+1<n?S.candles[k+1][0]-c[0]:0)-1;
    const p=replayPnlAt(t.dir,evs,barEnd,px), nf=fs.filter(f=>f.t<=barEnd).length, f=nf?fs[nf-1]:null;
    const r=risk>0?' ('+(p.total/risk>=0?'+':'')+(p.total/risk).toFixed(2)+'R)':'';
    read.innerHTML=(f&&fBar[nf-1]===k?`<span class="rpfill">Fill ${nf} of ${fs.length}: ${f.what} ${esc(+f.sz.toPrecision(6)+'')} @ ${esc(S.fpx(f.px))}</span> · `:'')
      +`<span>${esc(new Date(c[0]).toLocaleString())}</span> · close ${esc(S.fpx(px))} · `
      +(p.pos>0?`holding ${esc(+p.pos.toPrecision(6)+'')} @ avg ${esc(S.fpx(p.avg))} · unrealised <span class="${cls(p.open)}">${esc(fmtUsd(p.open))}</span> · `:barEnd<t.openTime?'not in yet · ':'flat · ')
      +`realised <span class="${cls(p.realized)}">${esc(fmtUsd(p.realized))}</span> · total <b class="${cls(p.total)}">${esc(fmtUsd(p.total))}${esc(r)}</b> <span style="color:var(--faint)">gross, before fees</span>`;
    slider.setAttribute('aria-valuetext',new Date(c[0]).toLocaleString()+(nf?', after fill '+nf+' of '+fs.length:', before the entry')+(p.pos>0?', holding '+(+p.pos.toPrecision(6)):''));
  };
  const stop=()=>{ clearInterval(_replayTimer); _replayTimer=null; playBtn.textContent='▶ Replay'; playBtn.setAttribute('aria-label','Play'); };
  const play=()=>{ if(k>=end)show(start); playBtn.textContent='⏸ Pause'; playBtn.setAttribute('aria-label','Pause');
    _replayTimer=setInterval(()=>{ if(!document.body.contains(slider)||_replayChart!==ch){ stop(); return; } if(k>=end){ stop(); return; } show(k+1); },Math.round(450/speed)); };
  const act=async(a,b)=>{
    if(a==='play'){ if(_replayTimer)stop(); else play(); return; }
    stop();
    if(a==='start')show(start); else if(a==='end')show(end); else if(a==='back')show(k-1); else if(a==='fwd')show(k+1);
    else if(a==='nfill'){ const i=fBar.find(x=>x>k); show(i!=null?i:end); }
    else if(a==='pfill'){ const i=[...fBar].reverse().find(x=>x<k); show(i!=null?i:start); }
    else if(a==='attach'){ try{
        const src=ch.canvas, out=document.createElement('canvas'); out.width=src.width; out.height=src.height;
        const x=out.getContext('2d'); x.fillStyle=getComputedStyle(document.body).getPropertyValue('--panel').trim()||'#0d1117'; x.fillRect(0,0,out.width,out.height); x.drawImage(src,0,0);
        const arr=(await idbGet('att:'+t.id))||[]; if(arr.length>=12){ setErr('Max 12 images per trade — remove one first.'); return; }
        arr.push(out.toDataURL('image/jpeg',0.85)); await idbSet('att:'+t.id,arr); loadAttachments(t.id); syncAttUp(t.id);
        b.textContent='📎 Attached'; setTimeout(()=>{ b.textContent='📎 Attach chart'; },1500);
      }catch(err){ setErr('Couldn’t attach the chart: '+err.message); } }
  };
  ctl.addEventListener('click',e=>{ const b=e.target.closest('[data-rp]'); if(b)act(b.dataset.rp,b); });
  // keyboard: arrows step a bar (on the slider its own arrows do), Shift+arrows jump a fill, Space plays
  ctl.addEventListener('keydown',e=>{ const tg=e.target, rng=tg.type==='range', K=e.key; let a=null;
    if(tg.tagName==='SELECT')return;
    if(K==='ArrowLeft'||K==='ArrowRight'){ if(rng&&!e.shiftKey)return; a=e.shiftKey?(K==='ArrowLeft'?'pfill':'nfill'):(K==='ArrowLeft'?'back':'fwd'); }
    else if((K==='Home'||K==='End')&&!rng)a=K==='Home'?'start':'end';
    else if(K===' '&&tg.tagName!=='BUTTON')a='play'; // a focused button's own Space already clicks it
    if(!a)return; e.preventDefault(); act(a); });
  slider.addEventListener('input',()=>{ stop(); show(+slider.value); });
  ctl.querySelector('select').addEventListener('change',e=>{ speed=+e.target.value||1; if(_replayTimer){ stop(); play(); } });
  show(end);
}

let _benchToken=0; // stale-render guard: only the latest benchmark run may draw (the miner has the same guard)
async function renderBenchmark(closed, money){
  const el=$('diagBench'); if(!el||closed.length<5)return;
  const tok=++_benchToken;
  try{
    const t0=Math.min(...closed.map(t=>t.openTime)), t1=Math.max(...closed.map(t=>t.closeTime));
    if(!(t1>t0))return;
    const series={}, demo=typeof isDemoData==='function'&&isDemoData(); // sample: drawn, never cached
    for(const coin of ['BTC','HYPE']){
      const k=excKey(coin,'1d');
      let cache=null; if(!demo){ try{ cache=await idbGet('cnd:'+k); }catch(e){} }
      if(!cache||cache.v!==1||!Array.isArray(cache.candles)||!Array.isArray(cache.ranges))cache={v:1,candles:[],ranges:[]};
      const want=[t0-86400e3,t1+86400e3];
      for(const u of uncoveredRanges(want,cache.ranges)){
        if(u[1]-u[0]<=86400e3)continue;
        try{ const c=await venueFetchCandles('',coin,'1d',u[0],u[1]);
          cache.candles=mergeCandles(cache.candles,c.rows);
          if(c.coveredTo>u[0]) cache.ranges=mergeRanges([...cache.ranges,[u[0],c.coveredTo]],1); }catch(e){}
      }
      if(!demo){ try{ await idbSet('cnd:'+k,cache); }catch(e){} }
      const win=cache.candles.filter(c=>c[0]>=t0-86400e3&&c[0]<=t1+86400e3);
      if(win.length>=2)series[coin]=win;
    }
    // a Diagnostic re-render during the awaited candle fetches replaced this card's canvas —
    // drawing now would paint a detached element and destroy the newer run's chart
    if(tok!==_benchToken||!el.isConnected)return;
    if(!Object.keys(series).length)return;
    // your line: cumulative net as % of average deployed notional — a stated approximation
    const avgNotional=_avg(closed.map(notionalOf).filter(x=>x>0)); // measured rows only
    if(!(avgNotional>0))return;
    const byClose=[...(money||closed)].filter(t=>t.closeTime).sort((a,b)=>a.closeTime-b.closeTime); // the realized curve is money
    let cum=0; const mine=byClose.map(t=>{ cum+=t.net; return {x:t.closeTime,y:cum/avgNotional*100}; });
    mine.unshift({x:t0,y:0});
    const px=c=>isFinite(c[3])?c[3]:(c[1]+c[2])/2;
    const colors={BTC:'rgba(230,180,80,.85)',HYPE:'rgba(47,208,140,.85)'};
    const dsets=Object.entries(series).map(([coin,win])=>{ const base=px(win[0]);
      return {label:coin+' hold',data:win.map(c=>({x:c[0],y:(px(c)/base-1)*100})),
        borderColor:colors[coin],borderWidth:1.3,pointRadius:0,fill:false,tension:0}; });
    dsets.push({label:'you',data:mine,borderColor:'rgba(139,147,255,.95)',borderWidth:1.8,pointRadius:0,fill:false,stepped:true});
    const card=el.closest('.diag-card'); if(card)card.classList.remove('hide');
    if(_diagCharts.bench)_diagCharts.bench.destroy();
    _diagCharts.bench=new Chart(el,{type:'line',data:{datasets:dsets},options:{responsive:true,maintainAspectRatio:false,
      plugins:{legend:{display:true,labels:{color:TXT,boxWidth:10,font:{size:11}}},
        tooltip:{callbacks:{label:c=>' '+c.dataset.label+' '+(c.parsed.y>=0?'+':'')+c.parsed.y.toFixed(1)+'%'}}},
      scales:{x:{type:'linear',grid:{color:GRID,drawTicks:false},border:{display:false},
        ticks:{maxTicksLimit:8,callback:v=>{const d=new Date(v);return (d.getMonth()+1)+'/'+d.getDate();}}},
        y:{grid:{color:GRID,drawTicks:false},border:{display:false},ticks:{callback:v=>v+'%'}}},
      interaction:{intersect:false,mode:'nearest'}}});
    explain(_diagCharts.bench,'Your running total as a % of your average position size, against simply holding BTC or HYPE over the same dates.');
  }catch(e){ /* benchmark is a bonus — never break the diagnostic over it */ }
}

function renderMinerResults(r,deep,basis){ basis=basis||'usd';
  const fmtA = basis==='pct' ? (n=>(n>=0?'+':'')+n.toFixed(2)+'%') : (n=>fmtUsd(n));
  const unitT = basis==='pct' ? '%-points' : '';
  const box=$('minerBox'); if(!box)return;
  if(!r){ box.innerHTML='<p class="lead">Needs ≥30 completed trades.</p>'; return; }
  const li=(cls,mk,txt)=>`<li class="${cls}"><span class="mk">${mk}</span><span>${txt}</span></li>`;
  const ciTag=v=> v.ci ? ` · 95% CI ${fmtA(v.ci.lo)} to ${fmtA(v.ci.hi)} per trade` : '';
  const oosTag=v=>{
    if(!r.split) return ' <span class="badge mid" data-tip="Not enough trades (need \u226560) to hold out a validation slice, so this is in-sample only. Confirm forward before sizing on it.">in-sample only</span>';
    if(v.oosN==null||v.oosN<5) return ` <span class="badge mid" data-tip="Too few matching trades in the held-out window to judge out-of-sample.">only ${v.oosN||0} held-out</span>`;
    return v.holds
      ? ` <span class="badge ok" data-tip="The edge kept the same direction on the most recent trades — data it was NOT discovered on. This is the difference between a real pattern and a lucky slice.">holds out-of-sample \u00b7 ${fmtA(v.oosExp)}/trade on ${v.oosN} held-out</span>`
      : ` <span class="badge no" data-tip="On the held-out recent trades the edge flipped or vanished. Very likely an in-sample artifact \u2014 do not size on it.">fails out-of-sample \u00b7 ${fmtA(v.oosExp)}/trade on ${v.oosN} held-out</span>`;
  };
  const row=v=>{ const good=v.uplift>=0;
    const upliftTxt=(v.uplift>=0?'+':'')+(basis==='pct'?v.uplift.toFixed(1)+' '+unitT:fmtUsd(v.uplift));
    const lossTxt=basis==='pct'?Math.abs(v.uplift).toFixed(1)+' '+unitT:fmtUsd(Math.abs(v.uplift));
    const sent=good
      ? `${v.n} trades averaging <b>${fmtA(v.exp)}</b> each, vs ${fmtA(r.mAll)} across all your trades — roughly <b>${upliftTxt}</b> of your ${basis==='pct'?'cumulative return':'PnL'} traces to this pattern.`
      : `${v.n} trades averaging <b>${fmtA(v.exp)}</b> each, vs ${fmtA(r.mAll)} across all your trades — this pattern cost you roughly <b>${lossTxt}</b> ${basis==='pct'?'of cumulative return':''} vs trading at your baseline.`;
    const stats=`<span style="color:var(--faint);font-size:11px" data-tip="p is the chance of a gap this large appearing by pure luck (permutation test) — lower means more likely real. The CI is the plausible range for the true per-trade average.">p=${v.p<0.001?'<0.001':v.p.toFixed(3)}${ciTag(v)}</span>`;
    return li(good?'good':'bad',good?'▲':'▼',
      `<b>${esc(v.name)}</b>${oosTag(v)}${pinCtl(v)}${ruleCtl(v)}<br>${sent}<br>${stats}`); };
  const byPid={};
  const ruleCtl=v=>{ if(!v.pid||v.uplift>=0||!coachOn())return'';
    return customRules().some(r=>r.pid===v.pid)?' <span class="sr-note" style="margin-left:6px">rule \u2713</span>'
      :` <button class="btn ghost rulebtn" data-pid="${esc(v.pid)}" data-tip="Turn this leak into a personal rule: every trade that matches it is counted as a break with its dollar cost, open positions that match get a warning chip (when the condition is known at entry), and the rules card tracks whether you break it less from today on." style="font-size:10px;padding:1px 7px;margin-left:6px">+ rule</button>`; };
  const pinCtl=v=>{ if(!v.pid)return''; byPid[v.pid]=v;
    const already=pinsList().some(p=>p.pid===v.pid&&p.basis===basis);
    return already?' <span class="sr-note" style="margin-left:6px">tracking \u2713</span>'
      :` <button class="btn ghost pinbtn" data-pid="${esc(v.pid)}" data-tip="Pin this pattern to track it forward: every trade you close from now on that matches this condition gets measured against the discovered edge \u2014 a rolling out-of-sample test in the Tracked patterns card above." style="font-size:10px;padding:1px 7px;margin-left:6px">\ud83d\udccc track forward</button>`; };
  const vHtml=r.validated.length?r.validated.map(row).join(''):li('warn','·','No pattern here is statistically distinguishable from luck yet — after accounting for how many combinations were scanned, every apparent hot or cold pocket is within what chance alone would produce. That itself is useful to know.');
  const sHtml=r.suggestive.length?r.suggestive.map(row).join(''):'';

  let statesHtml='', cpHtml='', szHtml='', ideas=[];
  if(deep&&deep.states){
    const rows=deep.states.filter(x=>!x.skip);
    statesHtml=rows.map(x=>{
      const tag=x.sig?(x.delta<0?'<span class="badge no">drain</span>':'<span class="badge ok">boost</span>'):'<span class="sr-note">no clear effect</span>';
      const d=basis==='pct'
        ? (x.delta>=0?'+':'\u2212')+Math.abs(x.delta).toFixed(2)+' pts'
        : (x.delta>=0?'+':'\u2212')+fmtUsd(Math.abs(x.delta));
      return `<div class="state-row" data-tip="Expectancy of trades entered in this state vs your overall average, in the selected basis. p from a two-sample test vs all other trades; significance is Benjamini–Hochberg FDR-controlled across every state tested, so 'boost'/'drain' isn't just the best of many coin-flips. 'no clear effect' = not distinguishable from your average."><div class="sr-top"><span class="sr-name">${esc(x.name)}</span>${tag}</div><div class="sr-sub">${x.n} trades · averaged <b>${fmtA(x.exp)}</b> per trade · ${d} vs your baseline</div></div>`;
    }).join('')||'<p class="lead">Too few trades per state.</p>';
    const _thr=basis==='pct'?5:100;
    for(const x of rows){
      if(x.sig&&x.delta<0&&x.impact<-_thr) ideas.push({w:(basis==='pct'?40:1)*-x.impact,txt:`<b>${esc(x.name)}</b>: ${x.n} trades averaging ${fmtA(x.exp)} — ${fmtA(Math.abs(x.delta)).replace('+','')}/trade below your baseline. Cutting or halving these ≈ <b>${basis==='pct'?fmtA(-x.impact).replace('+','')+' cumulative':fmtUsd(-x.impact)}</b> over this sample. A hard rule (cooldown, daily cap) beats willpower.`});
      if(x.sig&&x.delta>0&&x.impact>_thr) ideas.push({w:(basis==='pct'?40:1)*x.impact,txt:`<b>${esc(x.name)}</b> is a genuine boost: ${fmtA(x.delta)}/trade over baseline across ${x.n} trades. Lean in when this state holds.`});
    }
  }
  if(deep&&deep.cp){
    const c=deep.cp; const dir=c.after.exp>=c.before.exp?'improved':'deteriorated';
    cpHtml=c.sig
      ? `<p class="lead">Strongest break in your expectancy sequence: <b>${fmtDate(c.at)}</b> (trade ${c.k} of ${c.before.n+c.after.n}) — ${fmtA(c.before.exp)}/trade before → <b>${fmtA(c.after.exp)}/trade</b> after (p=${c.p<0.001?'<0.001':c.p.toFixed(3)}). Your edge <b>${dir}</b> around that date; think back to what changed — size, markets, process — and ${dir==='improved'?'protect it':'undo it'}.</p>`
      : `<p class="lead">No statistically significant regime change (p=${c.p.toFixed(2)}) — your per-trade expectancy is consistent across the whole sequence. Stability is a feature.</p>`;
    if(c.series&&c.series.length>2) cpHtml+=`<div style="height:130px;margin-top:10px"><canvas id="regimeSpark"></canvas></div><p class="lead" style="font-size:11px;color:var(--faint);margin-top:4px">Rolling ${c.win}-trade expectancy over your sequence${c.sig?' — the gold dashed line marks the detected break':''}.</p>`;
    if(c.sig&&c.after.exp<c.before.exp) ideas.push({w:(basis==='pct'?40:1)*(c.before.exp-c.after.exp)*c.after.n,txt:`Your expectancy <b>dropped around ${fmtDate(c.at)}</b> (${fmtA(c.before.exp)} → ${fmtA(c.after.exp)}/trade, significant). Review what changed then — this is the single highest-leverage question in your data.`});
  }
  if(deep&&deep.sz){
    const z=deep.sz;
    const szSub=z.sig?(z.rho<0?'your results get worse as your position size grows':'your results improve as your position size grows'):'size barely relates to outcome here';
    szHtml=`<div class="state-row" data-tip="Spearman rank correlation between position notional and %-return on notional, permutation-tested. Percent basis is deliberate: $ PnL scales mechanically with size, which fakes a correlation — % isolates whether your decision quality actually changes with size."><div class="sr-top"><span class="sr-name">Do bigger trades do better or worse?</span>${z.sig?(z.rho<0?'<span class="badge no">bigger = worse</span>':'<span class="badge ok">bigger = better</span>'):'<span class="sr-note">no dependence</span>'}</div><div class="sr-sub">${z.n} trades · ${szSub} (rank correlation \u03c1=${z.rho.toFixed(2)}, p=${z.p<0.001?'<0.001':z.p.toFixed(3)})</div></div>`;
    if(z.sig&&z.rho<-0.1) ideas.push({w:500,txt:`Outcome falls as size rises (ρ=${z.rho.toFixed(2)}, significant) — conviction sizing is miscalibrated. Cap size at your median notional until the correlation flattens.`});
  }
  let probHtml='';
  if(deep&&deep.prob){
    const P=deep.prob;
    const TAGTXT={ok:'edge',mid:'fragile',no:'loses'};
    const prow=(x)=>{ const ci=(x.lo*100).toFixed(0)+'\u2013'+(x.hi*100).toFixed(0)+'%';
      const ec=x.exp>0?'var(--profit)':x.exp<0?'var(--loss)':'var(--muted)';
      const nt=x.note?`<span style="color:var(--faint);font-weight:400"> \u00b7 ${x.note}</span>`:'';
      return `<div class="metric-row" data-tip="Split by money then reliability: an edge clears break-even AND its 95% Wilson win-rate floor sits above 50%; fragile is profitable but the floor dips under a coin flip (often just a small sample); loses is negative expectancy. One spine \u2014 sorted by %/trade. Every condition appears on exactly one side."><span class="ml"><span class="badge ${x.tone}">${TAGTXT[x.tone]}</span>${esc(x.name)} \u00b7 ${x.n} trades${nt}</span><span class="mv">${(x.wr*100).toFixed(0)}% <span style="color:var(--faint);font-weight:400">(${ci})</span> \u00b7 <span style="color:${ec}">${fmtA(x.exp)}/trade</span></span></div>`; };
    const emptyRow=(t)=>`<div class="metric-row"><span class="ml" style="color:var(--faint)">${t}</span></div>`;
    probHtml=`<div class="diag-grid" style="margin-top:14px">
      <div class="diag-card"><h3 data-tip="Conditions worth leaning into: positive expectancy in your selected basis AND a 95% Wilson win-rate floor above 50%, so a 4-for-4 fluke can't outrank a proven edge. Sorted by %/trade. Your overall decisive win rate is ${(P.overall.wr*100).toFixed(0)}% (${(P.overall.lo*100).toFixed(0)}\u2013${(P.overall.hi*100).toFixed(0)}%, n=${P.overall.n}).">Lean in \u00b7 your edges</h3>${P.best.length?P.best.map(prow).join(''):emptyRow('no confirmed edges yet')}</div>
      <div class="diag-card"><h3 data-tip="Ease off \u2014 leaks and fragile spots. Losing conditions (negative expectancy) first, then profitable-but-unconfirmed ones whose win-rate floor is under a coin flip. A high %/trade with a low floor is usually a small sample, not a clean edge \u2014 re-test before trusting it.">Ease off \u00b7 leaks &amp; fragile</h3>${P.worst.length?P.worst.map(prow).join(''):emptyRow('nothing dragging \u2014 clean run')}</div>
    </div>`;
    const topB=P.best[0], topW=P.worst[0];
    if(topB&&topB.state==='edge') ideas.push({w:400+topB.n,txt:`Your strongest edge is <b>${esc(topB.name)}</b>: ${fmtA(topB.exp)}/trade over ${topB.n} decisive trades, ${(topB.wr*100).toFixed(0)}% win (\u2265${(topB.lo*100).toFixed(0)}% at 95%). Lean in when this state holds.`});
    if(topW&&topW.state==='losing') ideas.push({w:380+topW.n,txt:`<b>${esc(topW.name)}</b> loses money: ${fmtA(topW.exp)}/trade over ${topW.n} decisive trades (${(topW.wr*100).toFixed(0)}% win). This is the one to cut or rework \u2014 not size down.`});
  }
  if(r.validated[0]){ const v=r.validated[0];
    const oos = !r.split ? ' (in-sample only — confirm forward)'
      : v.holds ? ' — and it held on held-out trades, which is the version worth acting on'
      : (v.oosN>=5 ? ' — but it FAILED out-of-sample, so treat it as noise until it re-proves itself' : ' (too few held-out trades to confirm yet)');
    const act = v.uplift>=0
      ? (r.split && v.holds ? 'Allocate more attention and size here.' : 'Promising, but confirm it forward before sizing up.')
      : (r.split && v.holds ? 'Stop taking these — the leak persists on fresh data.' : 'Stop or paper-trade these for a month to confirm before risking more.');
    ideas.push({w:(basis==='pct'?40:1)*Math.abs(v.uplift)*0.8*((r.split&&!v.holds&&v.oosN>=5)?0.3:1),txt:`${v.uplift>=0?'Best validated pattern':'Worst validated leak'}: <b>${esc(v.name)}</b> (${(v.uplift>=0?'+':'')+(basis==='pct'?v.uplift.toFixed(1)+' %-points cumulative':fmtUsd(v.uplift))}, FDR-controlled)${oos}. ${act}`}); }
  ideas.sort((a,b)=>b.w-a.w);
  // one-line top verdict: the single most actionable finding, or an honest null result
  let verdictHtml='';
  { const holders=r.validated.filter(v=>v.holds);
    const pool=holders.length?holders:r.validated;
    if(pool.length){ const v0=[...pool].sort((a,b)=>Math.abs(b.uplift)-Math.abs(a.uplift))[0];
      const amt=basis==='pct'?Math.abs(v0.uplift).toFixed(1)+' '+unitT:fmtUsd(Math.abs(v0.uplift));
      verdictHtml=`<p class="lead" style="font-size:13px;margin:0 0 12px;border-left:2px solid var(--${v0.uplift>=0?'profit':'loss'});padding-left:10px">${v0.uplift>=0?'Your clearest real edge':'Your clearest leak'}: <b>${esc(v0.name)}</b> \u2014 roughly <b>${amt}</b> of your ${basis==='pct'?'cumulative return':'PnL'} ${v0.uplift>=0?'traces to it':'drained into it'}${v0.holds?', and it held up on trades it was not discovered on':''}.</p>`; }
    else verdictHtml=`<p class="lead" style="font-size:13px;margin:0 0 12px;border-left:2px solid var(--line);padding-left:10px">No condition beats luck yet across ${r.tested} candidates \u2014 your hot and cold pockets are within what chance produces. Trade your process and re-scan as the sample grows.</p>`; }
  const ideasHtml=ideas.length?`
   <div class="diag-section" style="margin-top:22px">
     <h2>Actionable ideas <span style="font-size:11px;color:var(--faint);font-weight:400">ranked by dollar impact · in-sample</span></h2>
     <ol class="recs">${ideas.slice(0,6).map(i=>`<li>${i.txt}</li>`).join('')}</ol>
   </div>`:'';

  const splitNote = r.split
    ? `<p class="lead" style="margin:0 0 10px;font-size:11.5px">Discovered on your earlier <b>${r.discN}</b> trades, then re-tested on the <b>${r.holdN}</b> most recent (held out). The out-of-sample tag on each pattern is the important part — it's the difference between an edge and a lucky slice.</p>`
    : `<p class="lead" style="margin:0 0 10px;font-size:11.5px">In-sample only — need \u226560 trades to hold out a validation slice. Treat these as hypotheses to confirm forward.</p>`;
  box.innerHTML=`${verdictHtml}
    <div class="diag-grid">
      <div class="diag-card"><h3 data-tip="Survived the permutation test AND the false-discovery correction across all ${r.tested} candidates tested — discovered on an earlier slice and, where possible, re-tested on held-out recent trades. Correlated conditions can still be proxies for one cause.">Patterns that survived statistical testing <span style="font-size:11px;color:var(--faint);font-weight:400">FDR 10%</span></h3>${splitNote}<ul class="diag-list">${vHtml}</ul></div>
      <div class="diag-card"><h3 data-tip="Raw p ≤ 0.05 but did NOT survive correction for the ${r.tested} candidates scanned — with this many tests, some of these are expected to be flukes. Watch, don't act.">Hints only — could easily be flukes <span style="font-size:11px;color:var(--faint);font-weight:400">p \u2264 0.05, failed correction</span></h3><ul class="diag-list">${sHtml||li('warn','·','None.')}</ul></div>
    </div>
    <div class="diag-grid" style="margin-top:14px">
      <div class="diag-card"><h3 data-tip="Your expectancy conditioned on the psychological/temporal state you were in at entry — computed from entry-time truth only (trades closed before you entered).">How you were doing when you entered</h3>${statesHtml}${szHtml}</div>
      <div class="diag-card"><h3 data-tip="Binary-segmentation change-point detection with permutation significance: finds and dates the strongest break in your per-trade expectancy sequence — far sharper than an earlier/recent half-split.">Did your edge change at some point?</h3>${cpHtml}</div>
    </div>
    ${probHtml}
    ${ideasHtml}
    <p class="lead" style="margin-top:10px">How this works: ${r.tested} candidate conditions were scanned (single conditions plus cross-combinations, each needing ≥${r.minN} trades). Each was shuffle-tested ${r.perms} times to ask “could luck alone produce this gap?”, and because scanning many candidates guarantees a few flukes, results are corrected so no more than ~10% of what survives is expected to be a false alarm (Benjamini–Hochberg FDR). Behavioral states use only what you knew at entry time. Numbers are in your selected basis (${basis==='pct'?'% of notional — size-neutral':'dollars'}). Everything here shows correlation on past trades — treat patterns as hypotheses to trade deliberately and re-test, not guarantees.${r.seed?' Deterministic run (seed '+r.seed+'): the same trade selection always reproduces these exact numbers.':''}</p>`;
  // pin buttons -> forward tracker (re-render restores miner results from cache)
  box.querySelectorAll('.pinbtn').forEach(b=>{ b.onclick=async()=>{ const v=byPid[b.dataset.pid]; if(!v)return;
    b.disabled=true; b.textContent='pinned \u2713';
    await addPin(v,basis,r.famParams||null);
    renderDiagnostic(periodTrades(),periodTradesAll()); }; });
  box.querySelectorAll('.rulebtn').forEach(b=>{ b.onclick=async()=>{ const v=byPid[b.dataset.pid]; if(!v)return;
    b.disabled=true; b.textContent='rule \u2713';
    await addCustomRule({pid:v.pid,name:'Avoid: '+v.name,params:r.famParams||{}});
    renderGuardrails(); renderDiagnostic(periodTrades(),periodTradesAll()); }; });
  // rolling-expectancy sparkline with the change-point marked
  if(charts.regime){ try{charts.regime.destroy();}catch(e){} charts.regime=null; }
  if(deep&&deep.cp&&deep.cp.series&&$('regimeSpark')){
    const S=deep.cp.series; let cpX=null;
    if(deep.cp.sig){ cpX=S.findIndex(p=>p.i>=deep.cp.k); if(cpX<0)cpX=null; }
    const vline={id:'cpv',afterDatasetsDraw(ch){ if(ch.$cp==null)return;
      const x=ch.scales.x.getPixelForValue(ch.$cp), a=ch.chartArea, c=ch.ctx;
      c.save(); c.strokeStyle='#C9A85C'; c.setLineDash([4,3]); c.lineWidth=1;
      c.beginPath(); c.moveTo(x,a.top); c.lineTo(x,a.bottom); c.stroke(); c.restore(); }};
    const ch=new Chart($('regimeSpark'),{type:'line',plugins:[vline],
      data:{labels:S.map(p=>fmtDate(p.t)),datasets:[{data:S.map(p=>p.v),borderColor:'#8a7bd8',borderWidth:1.6,pointRadius:0,tension:.3,fill:false}]},
      options:{responsive:true,maintainAspectRatio:false,animation:false,
        plugins:{legend:{display:false},tooltip:{callbacks:{label:c2=>fmtA(c2.parsed.y)+'/trade (rolling '+deep.cp.win+')'}}},
        scales:{x:{ticks:{color:TXT,maxTicksLimit:4,maxRotation:0,font:{size:10}},grid:{display:false}},
                y:{ticks:{color:TXT,font:{size:10},callback:v=>fmtA(v)},grid:{color:GRID}}}}});
    ch.$cp=cpX; charts.regime=ch;
    explain(ch,'Your average trade over a rolling window. The gold dashed line marks where your results changed character.');
  }
}
