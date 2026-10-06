/* ============================================================================
   Evaluation — a prop-firm-style test of your own trading, read from your account (social.js /evals,
   evals.js). A feature in its own file: the #eval screen (from Social → Compete) and, while one runs, a
   card on Today. Loads on Daruma's page only (data-only="keel").

   You pick rules (a preset or your own numbers): a profit target, a daily loss limit and a drawdown limit as
   a share of the account when it starts, a minimum of trading days and a consistency rule. The server reads
   the account's P&L curve from the exchange (deposits and withdrawals don't move it) every few hours, and
   your trading days from your verified fills: break a limit and it fails at once; reach the target with the
   days in and the rule kept and it passes. A pass of a preset earns its badge and the owner's XP, once.
   This screen only shows what the server works out.
   ============================================================================ */
const EVS={pick:'standard',draft:{},confirm:null};
function evOn(){ return typeof socAvailable==='function'&&socAvailable()&&!!SOC.me&&!!(SOC.cfg&&SOC.cfg.evals&&SOC.cfg.evals.on); }
const evData=()=>evOn()?socGet('evals','/evals',30000):null;
const evPct=v=>v==null?'—':(v>=0?'+':'')+(Math.round(v*100)/100)+'%';
const evDate=ms=>new Date(ms).toLocaleDateString('en-US',{month:'short',day:'numeric'});
const EV_ST={live:['Running',''],passed:['Passed','win'],failed:['Failed','caution'],ended:['Ended',''],abandoned:['Stopped','']};
// one limit as a bar: how much of it is used (red as it fills), or how far to the target
function evBar(label, used, limit, good){
  const p=limit>0?Math.max(0,Math.min(1,(used||0)/limit)):0, col=good?PZ_COL.good:p>=0.8?PZ_COL.low:p>=0.5?PZ_COL.mid:PZ_COL.risk;
  return `<div class="pz-row"><div class="pz-row-t"><span>${esc(label)}</span><b>${esc(good?evPct(used)+' of '+evPct(limit):(Math.round((used||0)*100)/100)+'% of '+limit+'%')}</b></div>${pzBar(p,col)}</div>`;
}
function evLiveHtml(e, compact){
  const P=e.prog||{}, R=e.rules, left=Math.max(0,Math.ceil((e.endAt-Date.now())/86400000)), dayN=Math.min(R.days,Math.max(1,Math.ceil((Date.now()-e.startAt)/86400000)));
  const today=P.days?P.days[new Date().toISOString().slice(0,10)]:null, todayLoss=today!=null&&today<0&&e.startAv?-100*today/e.startAv:0;
  return `<div class="pz-kvrow"><b style="font-size:15px">${pzI('medal',16)} ${esc(R.preset==='custom'?'Your rules':(SOC_EV_PRESET(R.preset)||'Evaluation'))}</b><span class="pz-sub" style="font-size:12px">day ${dayN} of ${R.days} · ${left} left</span></div>
    ${P.at?`${R.target>0?evBar('Profit toward the target',Math.max(0,P.profit||0),R.target,true):''}
      ${evBar('Lost today (UTC)',todayLoss,R.daily)}${evBar(R.trail?'Drawdown from the high':'Drawdown from the start',P.ddUsed||0,R.dd)}
      ${compact?'':`<div class="pz-grid2"><div class="pz-tile"><span class="pz-n">${P.tradingDays==null?'—':P.tradingDays}<small>/${R.minDays}</small></span><span class="pz-t">trading days</span></div>
        <div class="pz-tile"><span class="pz-n">${P.bestShare==null?'—':Math.round(P.bestShare)+'%'}</span><span class="pz-t">of the profit from your best day${R.consistency?' (at most '+R.consistency+'%)':''}</span></div></div>`}
      <span class="pz-fine">Read ${esc(socAgo(P.at))}${/^\d/.test(socAgo(P.at))?' ago':''} · started at ${esc(usdPlain(e.startAv))}${P.dailyWorst?' · worst day so far −'+P.dailyWorst.pct+'%':''}</span>`
      :'<p class="pz-sub" style="margin:0;font-size:13px"><span class="pz-spin"></span>The first reading of your account comes within a few hours.</p>'}`;
}
const SOC_EV_PRESET=k=>({standard:'Standard',steady:'Steady',sprint:'Sprint'})[k]||null;
function evRulesLine(R){ return (R.target>0?'+'+R.target+'% target · ':'')+R.daily+'% daily loss · '+R.dd+'% '+(R.trail?'trailing ':'')+'drawdown · '+R.minDays+' trading days'+(R.consistency?' · no day over '+R.consistency+'% of the profit':'')+' · '+R.days+' days'; }
function evStartHtml(d){
  const P=d.presets||{}, keys=Object.keys(P), cur=EVS.pick, dr=EVS.draft, base=P[cur]||P.standard||{};
  const f=(k,label,min,max,step)=>`<div class="pz-field" style="flex:1;min-width:120px"><label for="evF_${k}" style="font-size:12px">${esc(label)}</label><input type="number" id="evF_${k}" min="${min}" max="${max}" step="${step||1}" value="${esc(dr[k]!=null?dr[k]:base[k])}"></div>`;
  return `<section class="pz-card pz-kv" aria-labelledby="evS"><b id="evS" class="pz-kvh">Start an evaluation</b>
    <div class="pz-chiprow pz-wrapr" role="group" aria-label="Rules">${keys.map(k=>`<button type="button" class="pz-chipbtn" data-ev-pick="${esc(k)}" aria-pressed="${k===cur}">${esc(P[k].label)}</button>`).join('')}<button type="button" class="pz-chipbtn" data-ev-pick="custom" aria-pressed="${cur==='custom'}">Your own</button></div>
    ${cur==='custom'?`<div style="display:flex;gap:8px;flex-wrap:wrap">${f('target','Profit target %',0,100,0.5)}${f('daily','Daily loss limit %',0.5,50,0.5)}${f('dd','Drawdown limit %',1,60,0.5)}${f('minDays','Trading days',0,60)}${f('consistency','Best day at most % (0 off)',0,100)}${f('days','Days',7,60)}</div>
      <label class="pz-toggle" style="min-height:44px"><span style="flex:1"><b style="font-size:13px">Trailing drawdown</b><span class="pz-sub" style="display:block;font-size:11px">Measured from the highest the account reached, not the start</span></span><input type="checkbox" id="evF_trail"${(dr.trail!=null?dr.trail:base.trail)?' checked':''}></label>
      <p class="pz-fine" style="margin:0">Your own rules earn the badge without XP: only the presets pay XP.</p>`
      :`<p style="margin:0;font-size:14px">${esc(evRulesLine(base))}</p>`}
    ${d.can?`<p class="pz-warn" style="margin:0">${esc(d.can)}</p>`:`<button type="button" class="pz-cta" data-ev="start">Start now</button>`}
    <p class="pz-fine" style="margin:0">Limits are a share of your account when it starts (at least ${esc(usdPlain(d.minAccount||100))}). Days run midnight to midnight UTC. A pass of a preset earns its badge and ${d.xp} XP, once; prizes are never money.</p></section>`;
}
function evScreenHtml(D){
  const back=`<a class="pz-back" href="#social">${pzI('back',20)}Social</a>`, head=pzHead('Trade it like it’s funded','Evaluation');
  if(!evOn())return `${back}${head}<section class="pz-card"><p class="pz-sub">${typeof socAvailable!=='function'||!socAvailable()?'Evaluations live on the server this page comes from. Open Daruma from your server’s <b>/daruma</b> link.':!SOC.me?'Make a profile (Social) to take an evaluation.':'The league owner hasn’t switched evaluations on.'}</p></section>`;
  const c=evData(), d=c&&c.d;
  if(!d)return `${back}${head}<p class="pz-sub">${c&&c.err?esc(c.err):'<span class="pz-spin"></span>Loading…'}</p>`;
  const live=(d.mine||[]).find(e=>e.st==='live'), past=(d.mine||[]).filter(e=>e.st!=='live');
  const liveCard=live?`<section class="pz-card pz-kv">${evLiveHtml(live)}<button type="button" class="pz-quietbtn warn" data-ev="abandon" data-id="${esc(live.id)}" style="align-self:flex-start">${EVS.confirm===live.id?'Tap again to stop it: it counts as stopped':'Stop this evaluation'}</button></section>`:evStartHtml(d);
  const hist=past.length?`<section class="pz-card pz-kv"><b class="pz-kvh">Your evaluations</b>${past.map(e=>{ const [tl,tc]=EV_ST[e.st]||[e.st,''];
    return `<div class="pz-kv" style="gap:2px;padding:8px 0;border-top:1px solid var(--pz-line)"><div class="pz-kvrow"><b style="font-size:14px">${esc(SOC_EV_PRESET(e.rules.preset)||'Your rules')} · ${esc(evDate(e.startAt))}</b><span class="pz-tag ${tc}">${tl}</span></div>
      <span class="pz-sub" style="font-size:12px">${esc(e.why||'')}${e.prog&&e.prog.profit!=null?' · '+evPct(e.prog.profit):''}</span></div>`; }).join('')}</section>`:'';
  const board=`<section class="pz-card pz-kv"><b class="pz-kvh">Passed lately</b>${(d.passed||[]).length?d.passed.map(p=>`<div class="pz-person-h" style="padding:8px 0;border-top:1px solid var(--pz-line)">${socAv(p.handle,32)}<span class="pz-person-i"><a href="#u/${esc(p.handle)}" style="color:var(--pz-text);font-weight:700;text-decoration:none">${p.me?'You':'@'+esc(p.handle)}</a> <span class="pz-tag win">${esc(SOC_EV_PRESET(p.preset)||'Own rules')}</span>
      <span class="pz-sub" style="display:block;font-size:12px">${esc(evDate(p.at))}${p.profit!=null?' · '+evPct(p.profit):''}</span></span></div>`).join(''):'<p class="pz-sub" style="margin:0;font-size:13px">Nobody has passed one here yet. Be the first.</p>'}</section>`;
  return `${back}${head}<div class="pz-wide"><div class="pz-col">${liveCard}${hist}</div><div class="pz-col">${board}
    <section class="pz-card pz-kv"><b class="pz-kvh">How it’s read</b><p class="pz-sub" style="margin:0;font-size:13px">From the exchange, never from this app: your account’s P&amp;L curve every few hours (deposits and withdrawals don’t move it) and your trading days from your verified fills. A limit broken at any point between readings still counts. Profit is the account’s, open positions included.</p></section></div></div>`;
}
// on Today, while one runs
function evCardHtml(){
  const c=evOn()?evData():null, d=c&&c.d, live=d&&(d.mine||[]).find(e=>e.st==='live'); if(!live)return '';
  return `<section class="pz-card pz-kv" aria-label="Your evaluation">${evLiveHtml(live,true)}<a class="pz-link" href="#eval" style="min-height:0">The evaluation in full${pzI('chev',14)}</a></section>`;
}
async function evClick(t){
  const ds=t.dataset;
  if(ds.evPick){ EVS.pick=ds.evPick; pzRender(); return true; }
  if(!ds.ev)return false;
  if(ds.ev!=='abandon')EVS.confirm=null;
  try{
    if(ds.ev==='start'){ const P=((evData()||{}).d||{}).presets||{}, base=P[EVS.pick]||P.standard||{}, body={preset:EVS.pick==='custom'?'standard':EVS.pick};
      if(EVS.pick==='custom'){ const r={custom:true}; for(const k of ['target','daily','dd','minDays','consistency','days']){ const el=$('evF_'+k); r[k]=el?+el.value:base[k]; }
        const tr=$('evF_trail'); r.trail=tr?!!tr.checked:!!base.trail; body.rules=r; }
      t.disabled=true; await socFetch('/evals',{method:'POST',body:JSON.stringify(body)}); delete SOC.cache.evals; EVS.draft={};
      pzNote('Your evaluation has started. The first reading comes within a few hours.'); pzRender(); return true; }
    if(ds.ev==='abandon'){ if(EVS.confirm!==ds.id){ EVS.confirm=ds.id; pzRender(); return true; } EVS.confirm=null;
      await socFetch('/evals/'+encodeURIComponent(ds.id),{method:'POST',body:JSON.stringify({action:'abandon'})}); delete SOC.cache.evals; pzNote('Stopped.'); pzRender(); return true; }
  }catch(e){ t.disabled=false; pzNote(e.message,'err'); }
  return true;
}
function evInput(t){ const m=/^evF_(\w+)$/.exec(t.id||''); if(!m)return false; EVS.draft[m[1]]=t.type==='checkbox'?t.checked:t.value; return true; }
pzFeature({id:'eval', today:{label:'Your evaluation',hint:'While one runs: profit to target, today’s loss and drawdown against the limits',col:0,after:'tilt',html:evCardHtml},
  tab:{name:'eval', nav:'social', html:evScreenHtml}, click:evClick, input:evInput});
