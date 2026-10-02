// Ledger app · part 12 of 15: Pulse: the simple, gamified view at /pulse.
// ledger.html loads the parts in order as classic scripts sharing one global scope. Code that
// runs while a part loads (not inside a function called later) may only use names declared in
// this part or an earlier one; the boot part runs last. See "Development and testing" in README.md.

/* ======================= 11 · PULSE: the simple, gamified view at /pulse ======================= */
// Same data and the same scores as the full app, with fewer knobs: three dials (readiness,
// discipline, risk used), one next step, and the progress layer. It renders into #pz when the
// page is opened at /pulse (or with ?pulse from disk); the full app stays in the DOM, hidden, so
// every loader, cache and sync path is shared. Pulse always shows the coach and game layers,
// whatever the full app's coach-mode switch says (coachOn() is true in Pulse).
const PZ_C=2*Math.PI*52;
// Pulse's signal colours, per appearance (light uses deeper tones that hold contrast on white).
// Read through PZ_COL.x at render time, so a re-render after switching appearance recolours
// everything, SVG attributes included (CSS variables don't reach those).
const PZ_COL_DARK={good:'#3FE0A0',mid:'#F4C04E',low:'#FF7A59',none:'#2C333C',risk:'#5AA9FF',xp:'#B69CFF'};
const PZ_COL_LIGHT={good:'#0A9A63',mid:'#B07D05',low:'#D9481F',none:'#CDD4DD',risk:'#2F7FD8',xp:'#7656E0'};
const PZ_COL=new Proxy({},{get:(_,k)=>((typeof document!=='undefined'&&document.body&&document.body.classList.contains('light'))?PZ_COL_LIGHT:PZ_COL_DARK)[k]});
const pzBand=v=>v==null?'none':v>=70?'good':v>=40?'mid':'low';
const PZ_PART={plan:'Plan before the first trade',rules:'Rules kept',planned:'Stops written while open',stops:'Stops honored',limit:'Under the loss limit',journal:'Trades journaled'};

// Readiness 0–100 from the session check-in (1–5 scales; stress counts inverted, as calm).
// Weighted sleep .4 · calm .2 · focus .4 over whichever answers were given; null with none.
// the check-in's own answers only, never a wearable: what the check-in XP and its badge count
const pzReadinessManual=e=>e?pzReadiness(Object.assign({},e,{wear:null})):null;
function pzReadiness(e){
  if(!e)return null;
  // a wearable's score, when there is one for the day, is the readiness; the check-in still earns its XP
  if(e.wear&&e.wear.score!=null&&isFinite(e.wear.score))return Math.max(0,Math.min(100,Math.round(e.wear.score)));
  let w=0, s=0;
  for(const [k,wt,f] of [['sleep',0.4,v=>v],['stress',0.2,v=>6-v],['focus',0.4,v=>v]]){
    const v=+e[k]; if(v>=1&&v<=5){ w+=wt; s+=wt*f(v)/5; } }
  return w?Math.round(100*s/w):null;
}
// A day's process score from its parts — the same weighting processDays uses.
function pzScoreOf(parts){
  let sw=0, sv=0; for(const p in parts){ if(parts[p]==null||!PROCESS_W[p])continue; sw+=PROCESS_W[p]; sv+=PROCESS_W[p]*parts[p]; }
  return sw?Math.round(100*sv/sw):null;
}
// How much of today's risk budget is used: trades opened today vs the cap, realized loss vs the
// limit (today's check-in numbers beat the standing rules). used = the larger share (0–1, can
// pass 1); null when neither a cap nor a limit is set. sizeX = median size of today's entries
// vs the median of the 60 entries before today.
function pzRisk(trades, dayE, rules, todayK, dayOf){
  const opened=trades.filter(t=>t.openTime&&dayOf(t.openTime)===todayK);
  const closedT=trades.filter(t=>!t.isOpen&&t.closeTime&&dayOf(t.closeTime)===todayK);
  const net=closedT.reduce((s,t)=>s+t.net,0), loss=Math.max(0,-net);
  const cap=dayE&&dayE.maxTrades>0?+dayE.maxTrades:(+rules.maxPerDay||0);
  const limit=dayE&&dayE.maxLoss>0?+dayE.maxLoss:(+rules.dailyLossLimit||0);
  const shares=[]; if(cap>0)shares.push(opened.length/cap); if(limit>0)shares.push(loss/limit);
  const size=t=>Math.abs((+t.maxSize||0)*(+t.avgEntry||0));
  const prior=trades.filter(t=>t.openTime&&dayOf(t.openTime)<todayK).sort((a,b)=>b.openTime-a.openTime).slice(0,60).map(size).filter(x=>x>0);
  const now=opened.map(size).filter(x=>x>0);
  const sizeX=prior.length>=5&&now.length?nfMedian(now)/nfMedian(prior):null;
  return {trades:opened.length, closed:closedT, cap, loss, net, limit, used:shares.length?Math.max(...shares):null, sizeX};
}
// Process vs results over the trading days from fromKey on: days at 70+ vs the rest, with the
// average day's net and the trade win rate on those days.
function pzTrendStats(days, byDay, fromKey){
  const ds=days.filter(d=>d.key>=fromKey);
  const grp=hi=>{ const g=ds.filter(d=>(d.score>=70)===hi), tr=[];
    for(const d of g)for(const t of (byDay[d.key]||[]))tr.push(t);
    const w=tr.filter(t=>isWin(t.net)).length, l=tr.filter(t=>isLoss(t.net)).length;
    return {n:g.length, avgNet:g.length?_avg(g.map(d=>d.net)):null, winRate:w+l?w/(w+l):null}; };
  return {days:ds, avg:ds.length?Math.round(_avg(ds.map(d=>d.score))):null, hi:grp(true), lo:grp(false)};
}
// Does how you feel show up in how you trade? Process on check-in days at readiness 70+ vs below.
function pzReadinessLink(days, J){
  const hi=[], lo=[];
  for(const d of days){ const r=pzReadiness(J['day:'+d.key]); if(r!=null)(r>=70?hi:lo).push(d.score); }
  return hi.length>=3&&lo.length>=3?{hi:Math.round(_avg(hi)),lo:Math.round(_avg(lo)),n:hi.length+lo.length}:null;
}
// Chart bars: one per trading day, or weekly averages when there are too many days to read.
function pzBars(days){
  if(days.length<=40)return {unit:'Daily score',bars:days.map(d=>({v:d.score,tip:pzDayTip(d)}))};
  const by={}; for(const d of days){ const w=isoWeekOfKey(d.key); (by[w]=by[w]||[]).push(d); }
  return {unit:'Weekly average',bars:Object.keys(by).sort().map(w=>{ const ds=by[w], v=Math.round(_avg(ds.map(d=>d.score))), net=ds.reduce((a,d)=>a+(d.net||0),0), n=ds.reduce((a,d)=>a+(d.n||0),0);
    return {v,tip:'Week '+w.replace(/^\d{4}-W?/,'')+' · discipline '+v+' on average\n'+ds.length+' trading day'+(ds.length===1?'':'s')+' · '+n+' trade'+(n===1?'':'s')+'\nNet '+signedPlain(net)+'\n'+ds.filter(d=>d.score>=70).length+' of '+ds.length+' days 70+'}; })};
}
// what a day's discipline bar says on hover: the score, the trades, the P&L and the slips
function pzDayTip(d){
  const f=(d.behavior&&d.behavior.flags)||{}, sl=Object.keys(f).filter(k=>f[k]>0).map(k=>(PZ_BEH[k]||k)+(f[k]>1?' ×'+f[k]:''));
  return dayLabel(d.key)+' · discipline '+d.score+(d.score>=70?' (clean day)':'')+'\n'+(d.behavior&&d.behavior.clean!=null?d.behavior.clean+' of '+d.n+' trade'+(d.n===1?'':'s')+' clean':d.n+' trade'+(d.n===1?'':'s'))
    +(d.net!=null?'\nNet '+signedPlain(d.net):'')+'\n'+(sl.length?'Slips: '+sl.join(', '):'No slips');
}
function pzHasPlan(e){ return !!(e&&(e.plan||e.bias||e.maxLoss>0||(r=>!!r&&typeof r==='object'&&Object.values(r).some(v=>Array.isArray(v)?v.length:!!v))(e.rules))); }

// The bonus XP still on offer today, and what's already earned. Pure given its inputs.
function pzBonusItems(D){
  const e=D.dayE||{}, todayT=D.todayTrades||[], j=todayT.filter(t=>isJournaled(journal[t.id])).length;
  const planned=pzHasPlan(D.dayE), opened=D.risk.trades>0, lim=D.risk.limit;
  const earned=(D.day&&D.day.bonus&&D.day.bonus.parts)||{};
  return [
    {k:'checkin',label:'Morning prep',xp:pzXpCfg().checkin,done:pzReadinessManual(D.dayE)!=null,href:'#checkin',hint:'Thirty seconds: sleep, calm, focus'},
    {k:'plan',label:'Plan before your first trade',xp:pzXpCfg().plan,done:planned&&(!opened||earned.plan===pzXpCfg().plan),partial:planned&&opened&&earned.plan>0&&earned.plan<pzXpCfg().plan,href:'#checkin',
      hint:planned?(opened?'Written after your first entry: half the bonus':'Written — it counts when you trade'):'A line and a loss limit, before you trade'},
    {k:'journal',label:'Journal today’s trades',xp:pzXpCfg().journal,done:todayT.length>0&&j===todayT.length,partial:j>0&&j<todayT.length,href:'#journal',
      hint:todayT.length?j+' of '+todayT.length+' journaled':'After your trades close'},
    lim>0?{k:'limit',label:'Respect your loss limit',xp:pzXpCfg().limit,done:!!earned.limit,href:'#discipline',hint:usdPlain(lim)+' today'}:null,
    pzLocked('review',(D.g&&D.g.level.level)||1)?null:{k:'review',label:'End-of-day review',xp:pzXpCfg().review,done:!!(D.dayE&&D.dayE.eod&&D.dayE.eod.at),href:'#review',hint:'Five minutes: what happened, one lesson, one focus for tomorrow'},
  ].filter(Boolean);
}
// One line from the coach, most urgent first: a hit limit, then the slip you just made, then
// load and form, then the biggest leak in your numbers.
// finding text written for the full journal, minus its directions to full-journal panels
function pzRulesBroken(D){ try{ return pzPlanCheck(D.todayK).rules.some(r=>r.ok===false); }catch(e){ return false; } }
function pzPlain(t){ return String(t||'').replace(/\s*\([^)]*→[^)]*\)/g,''); }
function pzCoachLine(D){
  const risk=D.risk, day=D.day, f=day&&day.behavior?day.behavior.flags:null;
  if(risk.limit>0&&risk.loss>=risk.limit)return 'You’ve hit today’s loss limit. The best trade now is no trade — close the app and come back tomorrow.';
  const c=[...risk.closed].sort((a,b)=>a.closeTime-b.closeTime), last=c[c.length-1];
  if(f&&f.afterTwo)return 'You kept trading after two losses in a row. This is where tilt starts — step away for fifteen minutes, or make the next one half size.';
  if(c.length>=2&&isLoss(last.net)&&isLoss(c[c.length-2].net))return 'Two losses in a row. This is where tilt starts — step away for fifteen minutes, or make the next one half size.';
  if(f&&f.revenge)return 'You re-entered within fifteen minutes of a loss. Give the next one a proper pause — the market will still be there.';
  if(f&&f.sizeUp)return 'You sized up right after a loss. Go back to your usual size until you’re green again.';
  if(f&&f.overtrade)return 'That’s more trades than your usual day. The good setups rarely come in bunches.';
  if(D.load&&D.load.ratio>=1.6)return 'You’re at '+D.load.ratio.toFixed(1)+'× your usual trading today. Slow down and let the next setup come to you.';
  if(D.form&&D.form.score!=null&&D.form.score<40)return 'Your recent trading trails your usual. Trade smaller until a few clean wins bring your form back.';
  // a clean day so far gets said so, instead of a lesson from older trades that reads like it's about today
  if(c.length&&day&&day.behavior&&!(day.behavior.slips||[]).length&&risk.net>=0&&!pzRulesBroken(D))return 'Clean so far: '+c.length+' closed, no slips'+(risk.limit>0?', inside your loss limit':'')+'. Keep the same routine for the next one — or call it a day.';
  const fd=(D.ctx.findings||[]).find(x=>x.tone==='leak'||x.tone==='caution')||(D.ctx.findings||[])[0];
  return fd?'Across your trades: '+fd.title+'. '+pzPlain(fd.action):'Keep trading your plan — your dials fill in as your history grows.';
}

// ---- UI state (never stored) ----
const PZ_TABS=['compose','today','trends','checkin','progress','discipline','journal','social','sharing','account','deep','how','badges','report','review','coach','leagues','lessons','mentor','mentee','duels','reviews','podnew','plan','people'];
var _pzQuiet=false; // a background refresh of data Pulse already shows: no status toasts
var pzS={ring:'discipline',range:30,badge:null,ck:null,sheet:false,custom:null,jr:{},note:null};
// a sign-in link from the league owner (/pulse#link=CODE): keep the code for the sign-in form, drop it from the address bar
(function(){ const m=/^#link=([A-Za-z0-9-]{4,20})$/.exec(location.hash||''); if(!m)return; pzS.linkCode=m[1].toUpperCase(); pzS.acctOpen=true;
  try{ history.replaceState(null,'',location.pathname+location.search+'#today'); }catch(e){} })();
function pzTab(){ const h=(location.hash||'').slice(1);
  if(/^u\/[A-Za-z0-9_]{3,20}$/.test(h))return 'profile'; if(/^mentee\/[A-Za-z0-9_]{3,20}$/.test(h))return 'mentee'; if(/^c\/[0-9a-f]{4,24}$/.test(h))return 'comp'; if(/^lg\/[a-z0-9-]{1,40}$/.test(h))return 'lginfo'; if(/^post\/[0-9a-f]{12}$/.test(h))return 'post'; if(/^tr\/[0-9a-f]{12}(\/mod)?$/.test(h))return 'tr'; if(/^duel\/[A-Za-z0-9_]{3,20}$/.test(h))return 'duelnew';
  if(/^link=[A-Za-z0-9-]{4,20}$/.test(h))return 'today'; if(/^people\/(duels|partner|mentor)$/.test(h))return 'people';
  return PZ_TABS.includes(h)?h:'today'; }
function pzHashArg(){ return (location.hash||'').slice(1).split('/')[1]||''; }
const PZI={
  pause:'<rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/>',
  book:'<path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z"/><path d="M4 21V5"/><path d="M9 7h6"/>',
  target:'<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
  today:'<circle cx="12" cy="12" r="9"/><path d="M12 12l4-3"/>',
  trends:'<path d="M5 20V11M12 20V5M19 20v-6"/>',
  checkin:'<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>',
  progress:'<path d="M8 21h8M12 17v4M7 4h10v5a5 5 0 0 1-10 0V4zM17 6h3v1a3 3 0 0 1-3 3M7 6H4v1a3 3 0 0 0 3 3"/>',
  flame:'<path d="M12 22c4 0 7-3 7-7 0-4-3-6-4-10-2 2-3 4-3 6-1-1-2-2-2-4-2 2-5 5-5 8 0 4 3 7 7 7z"/>',
  shield:'<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z"/>',
  saved:'<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3z"/><path d="M8.5 12l2.5 2.5 4.5-5"/>',
  bolt:'<path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z"/>',
  chat:'<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>',
  coach:'<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/><path d="M8.5 10.5h.01M12 10.5h.01M15.5 10.5h.01"/>',
  up:'<path d="M6 15l6-6 6 6"/>', down:'<path d="M6 9l6 6 6-6"/>',
  back:'<path d="M15 18l-6-6 6-6"/>', chev:'<path d="M9 6l6 6-6 6"/>', arrow:'<path d="M5 12h14M13 6l6 6-6 6"/>',
  check:'<path d="M5 12l5 5 9-10"/>', minus:'<path d="M6 12h12"/>', plus:'<path d="M12 6v12M6 12h12"/>',
  x:'<path d="M6 6l12 12M18 6L6 18"/>', lock:'<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  medal:'<circle cx="12" cy="9" r="6"/><path d="M8.5 14L7 22l5-3 5 3-1.5-8"/>',
  gear:'<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  pen:'<path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  social:'<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.8-3.5 3.4-5.5 6.5-5.5s5.7 2 6.5 5.5M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.8c2 .7 3.2 2.5 3.5 5.2"/>',
};
function pzI(n,sz,sw){ return `<svg width="${sz||20}" height="${sz||20}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${sw||2}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PZI[n]||''}</svg>`; }
function pzRing(value, pct, color, opts){ opts=opts||{};
  const d=Math.max(0,Math.min(1,pct||0))*PZ_C;
  return `<span class="pz-ring"${opts.size?` style="--sz:${opts.size}px"`:''}><svg viewBox="0 0 120 120" aria-hidden="true"><circle cx="60" cy="60" r="52" class="pz-track"/><circle cx="60" cy="60" r="52" class="pz-arc" style="stroke:${color}" stroke-dasharray="${d.toFixed(1)} ${PZ_C.toFixed(1)}" transform="rotate(-90 60 60)"/></svg><span class="pz-rv">${value}${opts.cap?`<small>${opts.cap}</small>`:''}</span></span>`;
}
const pzBar=(pct,color)=>`<div class="pz-bar"><i style="width:${Math.round(Math.max(0,Math.min(1,pct||0))*100)}%;background:${color}"></i></div>`;
function pzRows(rows,color){ return rows.map(r=>`<div class="pz-row"><div class="pz-row-t"><span>${esc(r.label)}</span><b>${esc(r.value)}</b></div>${pzBar(r.pct,r.color||color)}</div>`).join(''); }
function pzFullHref(){ return /^https?:$/.test(location.protocol)?'/':location.pathname; }



function pzNav(tab, level){
  const cur=tab==='discipline'||tab==='journal'||tab==='review'||tab==='plan'?'today':tab==='profile'||tab==='comp'||tab==='sharing'||tab==='account'||tab==='leagues'||tab==='mentor'||tab==='mentee'||tab==='reviews'||tab==='tr'||tab==='lginfo'||tab==='duels'||tab==='people'||tab==='duelnew'||tab==='podnew'||tab==='post'||tab==='compose'?'social':tab==='deep'||tab==='how'?'trends':tab==='badges'||tab==='report'||tab==='lessons'?'progress':tab;
  const items=[['today','Today'],['trends','Stats'],['checkin','Prep'],['coach','Coach'],['social','Social'],['progress','Progress']];
  const lockT=0; // Stats is always open; only its deeper insights are level-gated
  return `<nav class="pz-nav" aria-label="Keel"><div class="pz-brand">${pzRing('',0.72,'var(--pz-acc)',{size:30})}Keel</div>
    ${items.map(([k,l])=>`<a href="#${k}"${k===cur?' aria-current="page"':''}${k==='trends'&&lockT?` aria-label="Trends, unlocks at level ${lockT}"`:''}>${pzI(k==='trends'&&lockT?'lock':k,22)}<span>${l}</span></a>`).join('')}
    <div class="pz-navfoot"><a href="${esc(pzFullHref())}">Open the full journal →</a></div></nav>`;
}
function pzHead(kick,title,extra){
  return `<header class="pz-head"><div><span class="pz-kick">${esc(kick)}</span><h1 class="pz-h1">${esc(title)}</h1></div>${extra||''}</header>`;
}
function pzChips(g, toJournal){
  return `<div class="pz-chips">${toJournal?`<a class="pz-chip pz-jchip" href="#journal" aria-label="${toJournal} trade${toJournal===1?'':'s'} to journal">${pzI('pen',16)}<span>${toJournal}</span></a>`:''}<a class="pz-chip streak" href="#progress" aria-label="${g.streak.current}-day discipline streak">${pzI('flame',18)}<span>${g.streak.current}</span></a>
    <button type="button" class="pz-chip icon" data-pz-sheet aria-label="Settings and wallets">${pzI('gear',20)}</button></div>`;
}

function pzData(){
  const g=gameContext(), ctx=g.ctx, now=Date.now(), todayK=dayKey(now);
  const dayE=journal['day:'+todayK]||null;
  const day=g.days.find(d=>d.key===todayK)||null;
  const last=g.days.filter(d=>d.key<todayK).slice(-1)[0]||null;
  const risk=pzRisk(ctx.trades,dayE,nfRules(),todayK,dayKey);
  const inbox=journalInbox(ctx.trades,journal,now);
  return {g,ctx,todayK,dayE,day,last,risk,ready:pzReadiness(dayE),inbox,todayTrades:ctx.byDay[todayK]||[],
    form:pzForm(ctx.closed,now,{isWin,isLoss}),load:pzLoad(ctx.trades,todayK,dayKey)};
}
const pzLoadCol=s=>s==null?PZ_COL.none:s>=80?PZ_COL.low:s>=62?PZ_COL.mid:PZ_COL.risk;
const pzPct=v=>v==null?'—':Math.round(v*100)+'%';
// ---- your layout: every screen's sections can be shown or hidden (synced with your settings) ----
const PZ_SECTIONS={
  today:[['oneThing','Today’s one thing','Your focus from last night’s review',1],['numbers','Today in numbers','Net, entries against your cap, risk used',1],
    ['tilt','Tilt meter','Losses in a row, re-entry window, size and pace — and quiet mode when it runs hot',1],
    ['session','Your session','P&L curve, trades, and your rules as they stand',1],['positions','Open positions','Size and hold time against your usual',1],
    ['insight','Coach insight','One line on what matters most',1],['next','Next step','Prep in the morning, review at night',1],
    ['now','Before you trade','How you do at this hour, the market today, time since a loss',1],['good','Done right today','Moments you followed a rule that usually costs you',1],['duels','Duels','Challenges waiting for you and duels running',1],
    ['lesson','A lesson to revisit','One of your own lessons, back when it’s due',1],
    ['inbox','From your partners and mentor','Nudges, notes and season results',1],['partners','Your partners','Their streak and slips this week',1],
    ['xp','Today’s XP','What earns XP today, and what’s due this week',1],['week','Last 7 trading days','Discipline and net, day by day',1],
    ['level','Level and league','Level progress, XP today, league standing',0],['yesterday','Last trading day','Its score, net and lesson in full',0]],
  stats:[['tiles','Headline numbers','Net, win rate, average trade and more',1],['daily','Daily P&L','',1],['findings','What moves your results','Your biggest edges and leaks',1],
    ['insights','Does discipline pay?','Results on good-discipline days vs the rest',1],['habits','Do your habits pay?','Your habit days against your other days, in dollars',1],['peers','Traders like you','How you compare with traders of your style, size and experience',1],['markets','Markets and time of day','Best and worst markets and hours',1],['plans','Your plans','How often you plan, follow it, and what not following cost',1]],
  progress:[['goals','Process goals','Targets you set for your process, with progress',1],['xpsources','Where your XP came from','',1],['challenge','Weekly challenge','',1],['habits','Your habits','Streaks for each habit you run',1],['reports','Report cards','Last week and this month',1],
    ['leaks','Your leaks','What your slips cost, and plugging them',1],['lessons','Lessons library','Everything your reviews taught you',1],['moments','Good moments','',1],['badges','Badges','Your latest badges',1],['bests','Personal bests','',1]],
};
// Today's cards below the dials can also be put in your own order (the top of the screen stays put)
const PZ_FLOW={today:[['tilt','insight','session','positions'],['next','now','good','inbox','duels','partners','lesson','xp','week','yesterday']]};
function pzOrdered(screen){ const all=(PZ_FLOW[screen]||[]).flat(), o=((settings.pzLayout||{})[screen]||{})._order;
  if(!Array.isArray(o))return null;
  return [...o.filter(id=>all.includes(id)),...all.filter(id=>!o.includes(id))]; }
function pzMove(screen,id,d){ const cur=pzOrdered(screen)||(PZ_FLOW[screen]||[]).flat(), i=cur.indexOf(id), j=i+d;
  if(i<0||j<0||j>=cur.length)return false; [cur[i],cur[j]]=[cur[j],cur[i]];
  const L=settings.pzLayout=settings.pzLayout||{}, M=L[screen]=L[screen]||{}; M._order=cur; return true; }
function pzShow(screen,id){ const L=(settings.pzLayout||{})[screen]; if(L&&Object.prototype.hasOwnProperty.call(L,id))return !!L[id];
  const d=(PZ_SECTIONS[screen]||[]).find(x=>x[0]===id); return d?!!d[3]:true; }
const pzLayoutCss=screen=>{ const hid=(PZ_SECTIONS[screen]||[]).filter(x=>!pzShow(screen,x[0])).map(x=>`[data-sec="${screen}:${x[0]}"]`); return hid.length?`<style>${hid.join(',')}{display:none!important}</style>`:''; };
const pzCustomizeLink=screen=>`<p class="pz-span pz-custom"><button type="button" class="pz-link" data-pz-customize="${screen}">${pzI('gear',14)} Customize this screen</button></p>`;
function pzCustomizeHtml(screen){
  const list=PZ_SECTIONS[screen]||[], name={today:'Today',stats:'Stats',progress:'Progress'}[screen]||screen;
  return `<div class="pz-sheet-bg" data-pz-close><div class="pz-sheet" role="dialog" aria-modal="true" aria-labelledby="pzCustT">
    <div style="display:flex;justify-content:space-between;align-items:center"><b id="pzCustT" style="font-size:18px">Customize ${esc(name)}</b><button type="button" class="pz-chip icon" data-pz-close aria-label="Close">${pzI('x',20)}</button></div>
    <p class="pz-sub" style="font-size:13px">Show only what you use${PZ_FLOW[screen]?', in the order you want':''}. Hidden sections keep working in the background.</p>
    ${(()=>{ const flow=PZ_FLOW[screen]?(pzOrdered(screen)||PZ_FLOW[screen].flat()):null, byId=Object.fromEntries(list.map(x=>[x[0],x]));
      const row=(id,i,n)=>{ const [,label,hint]=byId[id]; return `<div class="pz-toggle"><span style="flex:1;min-width:0"><b id="pzCu_${id}">${esc(label)}</b>${hint?`<span class="pz-sub" style="display:block;font-size:12px">${esc(hint)}</span>`:''}</span>
        ${flow&&i!=null?`<span class="pz-moves"><button type="button" class="pz-chip icon" data-pz-move="${screen}:${id}:-1" aria-label="Move ${esc(label)} up"${i===0?' disabled':''}>${pzI('up',16)}</button><button type="button" class="pz-chip icon" data-pz-move="${screen}:${id}:1" aria-label="Move ${esc(label)} down"${i===n-1?' disabled':''}>${pzI('down',16)}</button></span>`:''}
        <button type="button" role="switch" class="pz-switch" data-pz-sect="${screen}:${id}" aria-checked="${pzShow(screen,id)}" aria-labelledby="pzCu_${id}"><i></i></button></div>`; };
      if(!flow)return `<section>${list.map(x=>row(x[0])).join('')}</section>`;
      const top=list.filter(x=>!flow.includes(x[0]));
      return `<section><span class="pz-lbl" style="color:var(--pz-muted)">At the top</span>${top.map(x=>row(x[0])).join('')}</section>
        <section><span class="pz-lbl" style="color:var(--pz-muted)">Below the dials, in this order</span>${flow.filter(id=>byId[id]).map((id,i,a)=>row(id,i,a.length)).join('')}</section>`; })()}
    <button type="button" class="pz-ghost" data-pz-sectreset="${screen}">Reset to default</button></div></div>`;
}
// ---- Today, in more depth: the day in numbers, the session, the plan, open positions, context ----
// Everything here is read from fills and the journal already loaded; nothing new is fetched
// except the league standing and competitions Social already caches.
function pzTodayFacts(D){
  const {g,ctx,todayK,risk}=D, now=Date.now(), dayOf=t=>dayKey(t);
  const closedT=(risk.closed||[]).slice().sort((a,b)=>a.closeTime-b.closeTime);
  const wins=closedT.filter(t=>isWin(t.net)).length, losses=closedT.filter(t=>isLoss(t.net)).length;
  const fees=closedT.reduce((s,t)=>s+(+t.fees||0),0);
  const open=(typeof allTrades!=='undefined'&&allTrades.length?allTrades:(ctx.trades||[])).filter(t=>t.isOpen&&!t.orphan&&t.market!=='spot');
  const pos=typeof dexPositions==='function'?dexPositions():[];
  const upnl=pos.reduce((s,p)=>s+(+p.uPnl||0),0);
  let cum=0, hi=0, lo=0; const curve=closedT.map(t=>{ cum+=t.net; hi=Math.max(hi,cum); lo=Math.min(lo,cum); return {t:t.closeTime,v:cum,tr:t}; });
  const lastLoss=closedT.filter(t=>isLoss(t.net)).pop()||null;
  const lastOpen=(ctx.trades||[]).filter(t=>t.openTime&&dayOf(t.openTime)===todayK).sort((a,b)=>b.openTime-a.openTime)[0]||null;
  return {now,closedT,wins,losses,fees,open,pos,upnl,curve,hi,lo,net:cum,lastLoss,lastOpen};
}
// minutes into today on the app's clock; earlier days clamp to the start
function pzDayMin(ms,todayK){ if(dayKey(ms)<todayK)return -1; if(dayKey(ms)>todayK)return 1441; const p=tzParts(ms); return p.h*60+p.min; }
// Today's one thing: the focus you set in your last review
function pzOneThingHtml(D){
  const keys=Object.keys(journal).filter(k=>/^day:\d{4}-\d{2}-\d{2}$/.test(k)&&k.slice(4)<D.todayK).sort();
  for(let i=keys.length-1;i>=0&&i>=keys.length-7;i--){ const e=journal[keys[i]]&&journal[keys[i]].eod; if(e&&e.tomorrow)
    return `<p class="pz-onething">${pzI('bolt',15)}<span><b>Today’s one thing</b> ${esc(e.tomorrow)}</span></p>`; }
  return '';
}
// the one next step: the check-in before you trade, the review once you have
function pzNextHtml(D){
  const g=D.g, h=tzParts(Date.now()).h, e=D.dayE||{}, traded=D.risk.trades>0||D.todayTrades.length>0;
  const checked=!!(e.sleep||e.stress||e.focus||e.plan||e.rules), reviewed=!!(e.eod&&e.eod.at), lockR=pzLocked('review',g.level.level);
  const card=(href,ic,col,title,sub)=>`<a class="pz-card pz-cardlink" href="${href}"><span class="pz-ico" style="background:color-mix(in srgb, ${col} 16%, transparent);color:${col}">${pzI(ic,20)}</span><span style="flex:1;min-width:0;display:flex;flex-direction:column;gap:2px"><b style="font-size:15px">${title}</b><span class="pz-sub" style="font-size:12px">${sub}</span></span>${pzI('chev',18)}</a>`;
  if(!checked&&!traded)return card('#checkin','checkin',PZ_COL.risk,'Morning prep','Thirty seconds: readiness, limits and today’s rules · +'+pzXpCfg().checkin+' XP');
  if(!lockR&&!reviewed&&(traded||h>=16))return card('#review','pen',PZ_COL.good,'End-of-day review',(D.day?'Five minutes, +'+pzXpCfg().review+' XP. ':'Five minutes. ')+'One lesson, one focus for tomorrow.');
  if(D.inbox.length)return card('#journal','pen',PZ_COL.xp,D.inbox.length+' trade'+(D.inbox.length===1?'':'s')+' to journal','From the last 30 days: a rating, a setup or one line each'+(reviewed?' · today is reviewed':''));
  if(reviewed)return card('#review','check',PZ_COL.good,'Day reviewed',e.eod.tomorrow?'Tomorrow: '+esc(e.eod.tomorrow):'Edit any time tonight');
  return '';
}
function pzGoodHtml(D){
  let gm=[]; try{ gm=pzGoodMoments(D.g,D.todayK); }catch(err){} if(!gm.length)return '';
  return `<section class="pz-card pz-kv pz-goodcard"><b class="pz-kvh" style="color:${PZ_COL.good}">Done right today</b>${gm.slice(0,3).map(m=>`<div class="pz-moment"><span class="pz-bc done">${pzI('check',12,3)}</span><b style="font-size:13px;font-weight:600">${esc(m.text)}</b></div>`).join('')}</section>`;
}
// today's rules as one line of chips: kept, broken, or waiting to be tested
function pzRuleTally(pc){ const bad=pc.graded-pc.kept, wait=pc.rules.length-pc.graded;
  return [pc.graded?pc.kept+' kept':'',bad?bad+' broken':'',wait?wait+' not tested yet':''].filter(Boolean).join(' · '); }
function pzRuleName(r, R){ return r.k==='until'&&R.until?r.label+' '+R.until:r.label; }
function pzPlanChipsHtml(D){
  const pc=pzPlanCheck(D.todayK), R=(D.dayE&&D.dayE.rules)||{};
  if(!pc.rules.length)return `<a class="pz-link" href="#checkin" style="min-height:0">Set today’s rules ›</a>`;
  return `<div class="pz-planchips">${pc.rules.map(r=>`<span class="pz-st${r.ok===true?' ok':r.ok===false?' bad':''}" title="${esc(r.ok==null?'Not tested yet'+(r.detail?' · '+r.detail:''):r.detail||'')}">${r.ok===true?pzI('check',12,3)+' ':r.ok===false?pzI('x',12,3)+' ':''}${esc(pzRuleName(r,R))}</span>`).join('')}</div>`;
}
function pzTodayStripHtml(D,F){
  const {risk}=D, X=(lbl,v,sub,col,title)=>`<div class="pz-tile pz-tt"${title?` title="${esc(title)}"`:''}><span class="pz-lbl" style="font-size:11px">${lbl}</span><span class="pz-n"${col?` style="color:${col}"`:''}>${v}</span><span class="pz-t">${sub}</span></div>`;
  const col=v=>v>0?PZ_COL.good:v<0?PZ_COL.low:null, n=F.closedT.length;
  const used=risk.used, usedCol=used==null?null:used>=1?PZ_COL.low:used>=0.75?PZ_COL.mid:PZ_COL.good;
  return `<div class="pz-strip pz-span" role="group" aria-label="Today in numbers">
    ${X('Net today',n?esc(pzSigned(F.net)):'—',n?n+' closed · '+F.wins+'W '+F.losses+'L':'nothing closed yet',n?col(F.net):null,n?signedPlain(F.net)+(F.fees?' after '+usdPlain(F.fees)+' fees':''):'')}
    ${X('Entries',String(risk.trades)+(risk.cap>0?`<small> / ${risk.cap}</small>`:''),risk.cap>0?(risk.trades>=risk.cap?'at your cap':(risk.cap-risk.trades)+' left today'):'opened today')}
    ${X('Risk used',used==null?'—':Math.round(used*100)+'%',risk.limit>0?usdPlain(risk.loss)+' of '+usdPlain(risk.limit):'set a loss limit',usedCol)}
  </div>`;
}
// the session: today's P&L curve over the loss limit, each trade as a bar from entry to exit, and the day's markers
// ---- the tilt meter on Today, and quiet mode when it runs hot ----
function pzTiltHtml(D){
  const T=pzTiltOf(D), col=pzTiltCol(T.band), active=D.risk.closed.length||D.risk.trades;
  const word=T.band==='hot'?'Running hot — step away':T.band==='warm'?'Heating up':'Calm';
  const canNotify=typeof Notification!=='undefined', on=!!settings.pzTiltNotify&&canNotify&&Notification.permission==='granted';
  return `<section class="pz-card pz-tilt" aria-label="Tilt meter"><div class="pz-kvrow"><span class="pz-lbl" style="color:${col}">Tilt · ${T.score}</span>${T.band==='hot'?'<button type="button" class="pz-linkbtn" data-pz-quiet="open">Quiet mode</button>':''}</div>
    <b style="font-size:17px">${esc(word)}</b>
    <div class="pz-tiltbar" role="meter" aria-label="Tilt" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${T.score}"><i style="left:${T.score}%"></i></div>
    ${T.reasons.length?T.reasons.slice(0,3).map(r=>`<div class="pz-row-t"><span>${esc(r.text)}</span><b style="color:${col}">+${r.pts}</b></div>`).join('')
      :`<p class="pz-sub" style="font-size:12px">${active?'No losses in a row, no rushed re-entry, size and pace as usual.':'Nothing pushing you yet today.'}</p>`}
    ${canNotify?`<div class="pz-toggle" style="min-height:44px"><span style="flex:1"><b id="pzTiltNL" style="font-size:13px">Notify me when it runs hot</b><span class="pz-sub" style="display:block;font-size:11px">While Keel is open, even in another tab</span></span><button type="button" role="switch" class="pz-switch" id="pzTiltNotify" aria-checked="${on}" aria-labelledby="pzTiltNL"><i></i></button></div>`:''}</section>`;
}
const PZ_QUIET_MIN=15;
// kept in memory too, so quiet mode still closes when storage is blocked (private mode, full disk)
let _pzQuietMem=null;
function pzQuietState(){ if(_pzQuietMem)return Object.assign({},_pzQuietMem); try{ return JSON.parse(localStorage.getItem('pzQuiet')||'{}')||{}; }catch(e){ return {}; } }
function pzQuietSave(q){ _pzQuietMem=Object.assign({},q); try{ localStorage.setItem('pzQuiet',JSON.stringify(q)); }catch(e){} }
// shown on its own when a new hot episode starts (a new loss or entry pushed the reading past
// 65), while a break runs, or when opened from the card. One answer covers one episode.
function pzQuietHtml(D){
  const q=pzQuietState(), now=Date.now(), T=pzTiltOf(D), onBreak=q.until>now;
  const fresh=T.band==='hot'&&T.key&&q.ack!==T.key&&D.todayK===dayKey(T.key);
  if(!onBreak&&!fresh&&!pzS.quiet)return '';
  if(fresh&&q.notified!==T.key){ q.notified=T.key; pzQuietSave(q); if(now-T.key<10*60000)pzTiltNotify(T); }
  let lesson=null; try{ lesson=pzLessonFor(T,D); }catch(e){}
  const left=Math.max(0,q.until-now), mm=String(Math.floor(left/60000)).padStart(2,'0'), ss=String(Math.floor(left/1000)%60).padStart(2,'0');
  return `<div class="pz-quiet" role="alertdialog" aria-modal="true" aria-labelledby="pzQuietT"><div>
    <span class="pz-qico">${pzI('pause',34)}</span>
    <h2 id="pzQuietT" class="pz-h1" style="margin:0">${onBreak?'On a break':'Step away'}</h2>
    ${onBreak?`<div class="pz-qtime" id="pzQuietLeft" aria-live="off">${mm}:${ss}</div><p class="pz-sub">Away from the screen. Water, a walk, breathe. The market will still be there.</p>`
      :`<p class="pz-sub" style="font-size:15px">Your tilt reading is <b style="color:${pzTiltCol(T.band)}">${T.score}</b>. This is where most blow-ups start — not with a bad idea, but with the next trade after one.</p>`}
    ${T.reasons.length?`<ul>${T.reasons.map(r=>`<li><span>${esc(r.text)}</span><b style="color:${PZ_COL.low}">+${r.pts}</b></li>`).join('')}</ul>`:''}
    ${lesson?`<section class="pz-card" style="width:100%;text-align:left"><span class="pz-lbl" style="color:var(--pz-muted)">${lesson.key?'You wrote, '+esc(dayLabel(lesson.key)):'Your lesson'}</span><p style="margin:6px 0 0;font-size:15px;line-height:1.45">“${esc(lesson.text)}”</p></section>`:''}
    ${onBreak?`<button type="button" class="pz-ghost" data-pz-quiet="end">End the break early</button>`
      :`<button type="button" class="pz-cta" data-pz-quiet="break">Start a ${PZ_QUIET_MIN}-minute break</button><button type="button" class="pz-ghost" data-pz-quiet="ack">I’m calm — back to Keel</button>`}
  </div></div>`;
}
function pzTiltNotify(T){
  if(!settings.pzTiltNotify||typeof Notification==='undefined'||Notification.permission!=='granted')return;
  const body=(T.reasons[0]?T.reasons[0].text+'. ':'')+'Step away for '+PZ_QUIET_MIN+' minutes.';
  const show=()=>{ try{ new Notification('Tilt '+T.score+' — time for a break',{body,tag:'pz-tilt'}); }catch(e){} };
  if(navigator.serviceWorker&&navigator.serviceWorker.getRegistration)navigator.serviceWorker.getRegistration().then(r=>r?r.showNotification('Tilt '+T.score+' — time for a break',{body,tag:'pz-tilt'}):show()).catch(show);
  else show();
}
// ---- live tilt alerts: a banner on Today (and a notification) when a pattern shows up ----
// The patterns and their once-a-day / 30-minute rules are pzTiltAlerts and pzTiltAlertPick.
// What was said today is kept on this device; "Taking a break" starts the same 15-minute break
// as quiet mode and is logged on the day (breaks never change the Discipline score).
let _pzTaMem=null;
function pzTaState(){ if(_pzTaMem)return Object.assign({},_pzTaMem); try{ return JSON.parse(localStorage.getItem('pzTiltAlerts')||'{}')||{}; }catch(e){ return {}; } }
function pzTaSave(s){ _pzTaMem=Object.assign({},s); try{ localStorage.setItem('pzTiltAlerts',JSON.stringify(s)); }catch(e){} }
function pzTaOn(){ return settings.pzTiltAlerts!==false; }
// run after a refresh: only when today's fills changed since the last look
function pzTiltAlertCheck(){
  if(!PZ||!pzTaOn()||!allTrades.length)return null;
  const D=pzData(), now=Date.now(), s=pzTaState();
  const sig=D.todayK+':'+(D.ctx.trades||[]).filter(t=>(t.openTime&&dayKey(t.openTime)===D.todayK)||(t.closeTime&&dayKey(t.closeTime)===D.todayK)).map(t=>t.id+(t.isOpen?'o':'c'+t.closeTime)).sort().join(',');
  if(s.sig===sig)return null; s.sig=sig;
  const r=pzTiltAlertPick(pzTiltAlerts(D.ctx.trades,{now,dayOf:dayKey,isLoss:PZ_LOSS,maxTrades:D.risk.cap,lossLimit:D.risk.limit}),s.gate,now,D.todayK);
  s.gate=r.st; if(r.pick)s.cur=Object.assign({},r.pick,{day:D.todayK,shown:now});
  pzTaSave(s); if(r.pick)pzTaNotify(r.pick); return r.pick;
}
function pzTaNotify(a){
  if(typeof Notification==='undefined'||Notification.permission!=='granted')return;
  // the loss limit already has its notification (the tripwire): one, not two
  if(a.k==='limit'){ const k='trip:'+nfDayKey(Date.now()); if(_notified[k])return; _notified[k]=1; }
  const o={body:a.text,tag:'pz-tilt',data:{url:'/keel#today'},icon:'/pulse-icon.svg'}, show=()=>{ try{ new Notification(a.title,o); }catch(e){} };
  try{ if(navigator.serviceWorker&&navigator.serviceWorker.getRegistration)navigator.serviceWorker.getRegistration().then(r=>r?r.showNotification(a.title,o):show()).catch(show); else show(); }catch(e){ show(); }
}
// a hidden tab keeps refreshing while it could matter: alerts on, notifications allowed, a trade in the last two hours
function pzTiltBgWanted(){
  if(!PZ||!pzTaOn()||typeof Notification==='undefined'||Notification.permission!=='granted')return false;
  const since=Date.now()-2*3600000; return allTrades.some(t=>(t.openTime||0)>since||(t.closeTime||0)>since);
}
function pzTaBannerHtml(D){
  const a=pzTaState().cur, now=Date.now();
  if(!pzTaOn()||!a||a.day!==D.todayK||now-a.shown>2*3600000||pzQuietState().until>a.shown)return '';
  const col=a.k==='limit'||a.k==='limit80'?PZ_COL.mid:PZ_COL.risk;
  return `<section class="pz-card pz-kv pz-talert" role="status" aria-labelledby="pzTaT" style="border:1px solid color-mix(in srgb, ${col} 50%, var(--pz-line));background:color-mix(in srgb, ${col} 9%, var(--pz-card))">
    <div class="pz-kvrow"><span class="pz-lbl" style="color:${col}">${pzI('pause',14)} A moment to pause</span><span class="pz-sub" style="font-size:12px">${(p=>'at '+String(p.h).padStart(2,'0')+':'+String(p.min).padStart(2,'0'))(tzParts(a.at))}</span></div>
    <b id="pzTaT" style="font-size:16px">${esc(a.title)}</b><p style="margin:0;font-size:14px;line-height:1.45">${esc(a.text)}</p>
    <div style="display:flex;gap:8px;flex-wrap:wrap"><button type="button" class="pz-cta pz-sm" style="flex:1;min-height:44px" data-pz-ta="break">Taking a break</button><button type="button" class="pz-ghost pz-sm" style="flex:1" data-pz-ta="dismiss">Dismiss</button></div></section>`;
}
async function pzTaAction(kind){
  const s=pzTaState(), a=s.cur;
  if(kind==='toggle'){ settings.pzTiltAlerts=!pzTaOn(); await Store.set(S_KEY,settings); pzRender(); return; }
  if(kind==='push'){ const pr=Object.assign({},SOC.me&&SOC.me.push&&SOC.me.push.prefs); pr.tilt=pr.tilt===false;
    const r=await socFetch('/push',{method:'PUT',body:JSON.stringify({prefs:pr})}); SOC.me.push.prefs=r.prefs; pzRender(); return; }
  s.cur=null; pzTaSave(s);
  if(kind==='break'&&a)return pzQuietAction('break',{src:'alert',p:a.k});
  pzRender(); const m=$('pzMain'); if(m){ m.setAttribute('tabindex','-1'); m.focus({preventScroll:true}); }
}
// the switch in Settings, next to the reminders
function pzTaSetHtml(){
  return `<section><span class="pz-lbl" style="color:var(--pz-muted)">Tilt alerts</span>
    <div class="pz-toggle"><span style="flex:1"><b id="pzTaL">Tell me when a tilt pattern shows up</b><span>Re-entering soon after a loss, losses close together, sizing up, more trades than planned, or near your loss limit. Once per pattern a day, at most every 30 minutes.</span></span><button type="button" role="switch" class="pz-switch" data-pz-ta="toggle" aria-checked="${pzTaOn()}" aria-labelledby="pzTaL"><i></i></button></div></section>`;
}
let _pzQuietTick=null;
function pzQuietMount(D){
  const box=$('pzQuiet'); if(!box)return; let h='';
  try{ h=D?pzQuietHtml(D):''; }catch(e){ console.warn('quiet mode',e); }
  // the countdown changes every second: compare without it, so a re-render doesn't rebuild the dialog under focus
  const sig=h.replace(/<div class="pz-qtime"[^>]*>[^<]*<\/div>/,''), was=box.dataset.sig||'';
  if(sig!==was){ const wasOpen=!!was; box.innerHTML=h; box.dataset.sig=sig;
    if(h&&!wasOpen){ const b=box.querySelector('button'); if(b)b.focus(); }
    if(!h&&wasOpen){ const c=document.querySelector('.pz-tilt'); if(c){ c.setAttribute('tabindex','-1'); c.focus({preventScroll:true}); } } }
  document.body.classList.toggle('pz-quiet-on',!!h);
  clearInterval(_pzQuietTick); _pzQuietTick=null;
  if(pzQuietState().until>Date.now())_pzQuietTick=setInterval(()=>{ const q=pzQuietState(), el=$('pzQuietLeft');
    if(!(q.until>Date.now())){ clearInterval(_pzQuietTick); pzRender(); return; }
    const left=q.until-Date.now(); if(el)el.textContent=String(Math.floor(left/60000)).padStart(2,'0')+':'+String(Math.floor(left/1000)%60).padStart(2,'0'); },1000);
}
async function pzQuietAction(kind, extra){
  const q=pzQuietState(), D=pzData(), T=pzTiltOf(D);
  if(kind==='open'){ pzS.quiet=true; }
  else if(kind==='ack'){ q.ack=T.key; pzS.quiet=false; pzQuietSave(q); }
  else if(kind==='end'){ q.until=0; q.ack=T.key; pzS.quiet=false; pzQuietSave(q); }
  else if(kind==='break'){ q.until=Date.now()+PZ_QUIET_MIN*60000; q.ack=T.key; pzS.quiet=false; pzQuietSave(q);
    const k='day:'+D.todayK, e=journal[k]=Object.assign({},journal[k]||{}); e.breaks=(Array.isArray(e.breaks)?e.breaks:[]).concat([Object.assign({at:Date.now(),min:PZ_QUIET_MIN,tilt:T.score},extra||{})]).slice(-20);
    e.updatedAt=Date.now(); markJEdit(k); await Store.set(J_KEY,journal); }
  pzRender(); const f=document.querySelector('#pzQuiet button'); if(f)f.focus();
}
document.addEventListener('keydown',ev=>{ const box=$('pzQuiet'); if(!box||!box.firstElementChild)return;
  if(ev.key==='Escape'){ ev.preventDefault(); if(!(pzQuietState().until>Date.now()))pzQuietAction('ack'); return; }
  if(ev.key==='Tab'){ const f=[...box.querySelectorAll('button')]; if(!f.length)return; const i=f.indexOf(document.activeElement);
    if(ev.shiftKey&&(i<=0)){ ev.preventDefault(); f[f.length-1].focus(); } else if(!ev.shiftKey&&(i===-1||i===f.length-1)){ ev.preventDefault(); f[0].focus(); } } },true);
function pzSessionHtml(D,F){
  const {todayK,dayE,risk,day}=D, now=F.now, nowM=pzDayMin(now,todayK);
  const openIds=new Set(F.open.map(t=>t.id));
  const trades=(D.ctx.trades||[]).filter(t=>!openIds.has(t.id)&&((t.openTime&&dayKey(t.openTime)===todayK)||(t.closeTime&&!t.isOpen&&dayKey(t.closeTime)===todayK))).concat(F.open);
  if(!trades.length)return `<section class="pz-card pz-kv"><b class="pz-kvh">Your session</b><p class="pz-sub" style="font-size:13px">No trades yet today. Your entries, exits and P&amp;L curve draw here as you trade.</p>${pzPlanChipsHtml(D)}</section>`;
  const R=(dayE&&dayE.rules)||{}, until=/^\d{2}:\d{2}$/.test(R.until||'')?(+R.until.slice(0,2))*60+(+R.until.slice(3)):null;
  const planAt=dayE&&dayE.plannedAt&&dayKey(dayE.plannedAt)===todayK?pzDayMin(dayE.plannedAt,todayK):null;
  const mins=trades.flatMap(t=>[pzDayMin(t.openTime||now,todayK),t.isOpen?nowM:pzDayMin(t.closeTime,todayK)]).filter(m=>m>=0&&m<=1440);
  let lo=Math.min(nowM,...mins,...(planAt!=null?[planAt]:[])), hi=Math.max(nowM,...mins,...(until!=null&&until>lo?[until]:[]));
  lo=Math.max(0,Math.floor(lo/60)*60-30); hi=Math.min(1440,Math.ceil(hi/60)*60+30); if(hi-lo<180)hi=Math.min(1440,lo+180);
  const W=440, PL=6, PR=6, x=m=>PL+(Math.max(lo,Math.min(hi,m))-lo)/(hi-lo)*(W-PL-PR);
  // P&L curve
  const CT=12, CH=78, limit=risk.limit>0?-risk.limit:null;
  const vmin=Math.min(0,F.lo,limit!=null?limit:0), vmax=Math.max(0,F.hi,1), span=vmax-vmin||1, y=v=>CT+(vmax-v)/span*CH;
  let path=`M${x(lo).toFixed(1)} ${y(0).toFixed(1)}`, prev=0;
  for(const p of F.curve){ const px=x(pzDayMin(p.t,todayK)).toFixed(1); path+=` L${px} ${y(prev).toFixed(1)} L${px} ${y(p.v).toFixed(1)}`; prev=p.v; }
  path+=` L${x(nowM).toFixed(1)} ${y(prev).toFixed(1)}`;
  const curveCol=F.net>=0?PZ_COL.good:PZ_COL.low;
  // trade lanes: up to four rows, each trade in the first row free at its entry
  const slip=new Map(((day&&day.behavior&&day.behavior.slips)||[]).map(s=>[s.id,s.f]));
  const rows=[], LT=CT+CH+18, LH=12, LG=5, bars=[];
  for(const t of trades.slice().sort((a,b)=>(a.openTime||0)-(b.openTime||0))){
    const a=Math.max(lo,pzDayMin(t.openTime||now,todayK)), b=t.isOpen?nowM:Math.min(hi,pzDayMin(t.closeTime,todayK));
    let r=rows.findIndex(end=>end<=a-2); if(r<0){ r=rows.length<4?rows.length:rows.indexOf(Math.min(...rows)); } rows[r]=Math.max(b,a+4);
    const col=t.isOpen?PZ_COL.risk:t.net>0?PZ_COL.good:t.net<0?PZ_COL.low:'var(--pz-muted)', f=slip.get(t.id);
    const tip=`${dispMarket(dcoin(t))} ${t.dir||''} · ${t.isOpen?'open':esc(signedPlain(t.net))}${f&&f.length?' · '+f.map(k=>PZ_BEH[k]||k).join(', '):''}`;
    bars.push(`<g data-pz-tip="${esc(tip.replace(' · ','\n'))}"><rect x="${x(a).toFixed(1)}" y="${LT+r*(LH+LG)}" width="${Math.max(4,x(b)-x(a)).toFixed(1)}" height="${LH}" rx="4" fill="${col}" opacity="${t.isOpen?0.55:0.9}"/>${f&&f.length?`<circle cx="${x(a).toFixed(1)}" cy="${LT+r*(LH+LG)+LH/2}" r="5" fill="none" stroke="${PZ_COL.mid}" stroke-width="2"/>`:''}</g>`);
  }
  const H=LT+Math.max(1,rows.length)*(LH+LG)+20;
  const ticks=[]; const step=(hi-lo)>720?180:(hi-lo)>360?120:60; for(let m=Math.ceil(lo/step)*step;m<=hi;m+=step)ticks.push(m);
  const hh=m=>String(Math.floor(m/60)%24).padStart(2,'0')+':00';
  const mark=(m,label,col,dash)=>m==null||m<lo||m>hi?'':`<line x1="${x(m)}" x2="${x(m)}" y1="${CT-6}" y2="${H-16}" stroke="${col}" stroke-width="1.5"${dash?' stroke-dasharray="3 3"':''}/><text x="${x(m)+3}" y="${CT-1}" font-size="13" fill="${col}">${label}</text>`;
  const svg=`<svg class="pz-session" viewBox="0 0 ${W} ${H}" role="img" aria-label="Today’s session: P&amp;L ${esc(signedPlain(F.net))} over ${trades.length} trades">
    ${ticks.map(m=>`<line x1="${x(m)}" x2="${x(m)}" y1="${CT}" y2="${H-16}" stroke="var(--pz-line)" stroke-width="1"/><text x="${x(m)}" y="${H-3}" font-size="13" text-anchor="middle" fill="var(--pz-muted)">${hh(m)}</text>`).join('')}
    <line x1="${PL}" x2="${W-PR}" y1="${y(0)}" y2="${y(0)}" stroke="var(--pz-line2)" stroke-width="1"/>
    ${limit!=null?`<line x1="${PL}" x2="${W-PR}" y1="${y(limit)}" y2="${y(limit)}" stroke="${PZ_COL.low}" stroke-width="1.5" stroke-dasharray="5 4"/><text x="${W-PR}" y="${y(limit)-4}" font-size="13" text-anchor="end" fill="${PZ_COL.low}">loss limit ${esc(pzShort(-limit))}</text>`:''}
    <path d="${path}" fill="none" stroke="${curveCol}" stroke-width="2.2" stroke-linejoin="round"/>
    ${F.curve.map(p=>`<g data-pz-tip="${esc(dispMarket(dcoin(p.tr))+' '+(p.tr.dir||'')+' closed '+new Date(p.t).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit'})+'\nThis trade '+signedPlain(p.tr.net)+'\nDay so far '+signedPlain(p.v))}"><circle cx="${x(pzDayMin(p.t,todayK)).toFixed(1)}" cy="${y(p.v).toFixed(1)}" r="10" fill="transparent"/><circle cx="${x(pzDayMin(p.t,todayK)).toFixed(1)}" cy="${y(p.v).toFixed(1)}" r="3" fill="${p.tr.net>=0?PZ_COL.good:PZ_COL.low}"/></g>`).join('')}
    ${mark(planAt,'plan',PZ_COL.xp)}${mark(until,'stop '+(R.until||''),PZ_COL.mid,true)}${mark(nowM,'now','var(--pz-soft)')}
    ${bars.join('')}</svg>`;
  return `<section class="pz-card pz-kv"><div class="pz-kvrow"><b class="pz-kvh">Your session</b><span class="pz-sub" style="font-size:12px">high ${esc(pzSigned(F.hi))} · low ${esc(pzSigned(F.lo))}</span></div>${svg}
    <div class="pz-legend"><span><i style="background:${PZ_COL.good}"></i>win</span><span><i style="background:${PZ_COL.low}"></i>loss</span><span><i style="background:${PZ_COL.risk}"></i>open</span><span><i class="ring" style="border-color:${PZ_COL.mid}"></i>slip</span></div>${pzPlanChipsHtml(D)}</section>`;
}
// the structured plan, live: each rule kept, broken or not yet tested, plus the cap, the limit and the stop time
function pzPlanLiveHtml(D,F){
  const {todayK,dayE,risk}=D, R=(dayE&&dayE.rules)||{}, pc=pzPlanCheck(todayK), rows=[];
  const st=v=>v==null?`<span class="pz-st">not tested</span>`:v?`<span class="pz-st ok">${pzI('check',12,3)} kept</span>`:`<span class="pz-st bad">broken</span>`;
  for(const r of pc.rules)rows.push([r.label,r.detail,r.ok]);
  if(risk.cap>0)rows.push(['Trade cap',risk.trades+' of '+risk.cap,risk.trades?risk.trades<=risk.cap:null]);
  if(risk.limit>0)rows.push(['Loss limit',usdPlain(risk.loss)+' of '+usdPlain(risk.limit),F.closedT.length?risk.loss<risk.limit:null]);
  if(/^\d{2}:\d{2}$/.test(R.until||'')){ const p=tzParts(F.now), left=(+R.until.slice(0,2))*60+(+R.until.slice(3))-(p.h*60+p.min);
    rows.push(['Stop time',left>0?Math.floor(left/60)+'h '+String(left%60).padStart(2,'0')+'m left':'past '+R.until+' — done for the day',null]); } // graded once, by the 'No new trades after' rule
  if(!rows.length)return `<a class="pz-card pz-cardlink" href="#checkin"><span class="pz-ico" style="background:var(--pz-tint-xp);color:${PZ_COL.xp}">${pzI('pen',20)}</span><span style="flex:1;min-width:0"><b style="font-size:15px">No rules for today</b><span class="pz-sub" style="display:block;font-size:12px">Pick your setups, markets, a stop time and a cap — they’re checked from your fills as you trade.</span></span>${pzI('chev',18)}</a>`;
  const kept=rows.filter(r=>r[2]===true).length, graded=rows.filter(r=>r[2]!=null).length;
  return `<section class="pz-card pz-kv"><div class="pz-kvrow"><b class="pz-kvh">Your plan, live</b><span class="pz-sub" style="font-size:12px">${graded?kept+' of '+graded+' kept':'nothing tested yet'}</span></div>
    ${rows.map(([l,d,ok])=>`<div class="pz-kvrow pz-planrow"><span style="min-width:0"><b style="font-size:13px">${esc(l)}</b>${d?`<span class="pz-sub" style="display:block;font-size:12px">${esc(d)}</span>`:''}</span>${st(ok)}</div>`).join('')}</section>`;
}
// open positions: size and time held against your own usual, the stop, and the mark-to-market when it's known
function pzPositionsHtml(D,F){
  if(!F.open.length&&!F.pos.length)return '';
  const closed=D.ctx.closed||[], now=F.now;
  const winHold=nfMedian(closed.filter(t=>isWin(t.net)&&t.openTime&&!t.partialHistory).slice(-200).map(t=>t.closeTime-t.openTime))||0;
  const size=t=>Math.abs((+t.maxSize||0)*(+t.avgEntry||0)), usual=nfMedian(closed.slice(-60).map(size).filter(x=>x>0))||0;
  const dur=ms=>ms<3600000?Math.max(1,Math.round(ms/60000))+'m':ms<86400000?(ms/3600000).toFixed(1)+'h':(ms/86400000).toFixed(1)+'d';
  const posBy=new Map(F.pos.map(p=>[p.coin,p]));
  const list=F.open.length?F.open:F.pos.map(p=>({coin:p.coin,dir:p.side==='long'?'Long':'Short',fromPos:p}));
  return `<section class="pz-card pz-kv"><div class="pz-kvrow"><b class="pz-kvh">Open positions</b><span class="pz-sub" style="font-size:12px">${list.length}</span></div>
    ${list.slice(0,6).map(t=>{ const p=t.fromPos||posBy.get(t.coin)||null, held=t.openTime?now-t.openTime:null, sz=t.fromPos?p.notional:size(t);
      const plan=t.id?nfPlan(journal[t.id]):null, stop=!t.id||!!(plan&&plan.stop>0); // a position known only from the exchange can't carry a journal stop
      const long=winHold&&held!=null&&held>3*winHold, big=usual&&sz>1.5*usual;
      const notes=[held!=null?'held '+dur(held)+(winHold?' (winners: '+dur(winHold)+')':''):'', sz?pzShort(sz)+(usual?' · '+(sz/usual).toFixed(1)+'× usual':''):'', !t.id?'':stop?'stop '+plan.stop:'no stop written'];
      return `<div class="pz-pos"><div class="pz-kvrow"><b style="font-size:14px">${esc(dispMarket(t.coin?t.coin:dcoin(t)))} <span class="pz-sub" style="font-weight:600">${esc(t.dir||'')}</span></b>${p?`<b style="color:${p.uPnl>=0?PZ_COL.good:PZ_COL.low}" title="${esc(signedPlain(p.uPnl))}">${esc(pzSigned(p.uPnl))}</b>`:''}</div>
        <span class="pz-sub" style="font-size:12px">${notes.filter(Boolean).map(esc).join(' · ')}</span>
        ${long||big||!stop?`<span class="pz-sub" style="font-size:12px;color:${PZ_COL.mid}">${[long?'Held far past your usual winner — is the thesis still intact?':'',big?'Bigger than you usually trade.':'',!stop&&t.id?'Write a stop for it in the journal.':''].filter(Boolean).join(' ')}</span>`:''}</div>`; }).join('')}</section>`;
}
// right now: this hour in your history, and how long since the last loss
// "Before you trade": context for this moment, in plain words: how you usually do at this hour,
// the market today, and how long since your last loss or entry. It shows during the hours you
// usually trade, or once you've traded today; at 2 a.m. on a day off it stays out of the way.
function pzNowHtml(D,F){
  const closed=(D.ctx.closed||[]).filter(t=>t.openTime&&t.closeTime>F.now-180*86400000), byH={};
  for(const t of closed){ const h=tzParts(t.openTime).h; const o=byH[h]=byH[h]||{n:0,net:0,w:0,l:0}; o.n++; o.net+=t.net; if(isWin(t.net))o.w++; if(isLoss(t.net))o.l++; }
  const h=tzParts(F.now).h, hrs=Object.entries(byH).filter(([,o])=>o.n>=5).map(([k,o])=>({h:+k,avg:o.net/o.n,n:o.n,wr:o.w+o.l?o.w/(o.w+o.l):null})).sort((a,b)=>b.avg-a.avg);
  const me=hrs.find(x=>x.h===h), rank=me?hrs.indexOf(me):-1, lines=[];
  const lossMin=F.lastLoss?Math.round((F.now-F.lastLoss.closeTime)/60000):null;
  if(!me&&!F.lastOpen&&!(lossMin!=null&&lossMin<60))return ''; // not an hour you trade, nothing today: nothing to say
  const clock=n=>String(n).padStart(2,'0')+':00', ago=m=>m<120?m+' minute'+(m===1?'':'s'):(m/60).toFixed(1)+' hours';
  const n=byH[h]?byH[h].n:0;
  if(me){ const good=rank<3&&me.avg>0, bad=rank>=hrs.length-3&&me.avg<0;
    lines.push([good?PZ_COL.good:bad?PZ_COL.low:'var(--pz-soft)',`It’s ${clock(h)}, ${good?'one of your best hours':bad?'one of your worst hours':'an ordinary hour for you'}`,
      `You average ${signedPlain(me.avg)} a trade at this hour${me.wr!=null?', winning '+pzPct(me.wr)+' of them':''} (${me.n} trades in 6 months).${bad?' Trade smaller, or wait for a better hour.':''}`]); }
  else lines.push(['var(--pz-soft)',`It’s ${clock(h)}, an hour you rarely trade`,`${n?n+' trade'+(n===1?'':'s'):'No trades'} at this hour in 6 months, too few to say how you do.${hrs.length?' Your best hour is '+clock(hrs[0].h)+' (you average '+signedPlain(hrs[0].avg)+').':''}`]);
  pzRegimeWant();
  const rg=pzRegimeOf(F.now);
  if(rg&&(rg.vol||rg.trend)){ const like=rg.vol?(D.ctx.closed||[]).filter(t=>{ const r=pzRegimeOf(t.openTime||t.closeTime); return r&&r.vol===rg.vol&&t.closeTime<F.now-3600000; }):[];
    const avg=like.length?like.reduce((a,t)=>a+t.net,0)/like.length:null;
    const kind=[rg.vol?PZ_VOL[rg.vol].replace(' days','').toLowerCase():'',rg.trend?PZ_TREND[rg.trend].toLowerCase():''].filter(Boolean).join(', ');
    lines.push([avg==null||like.length<5?'var(--pz-soft)':avg<0?PZ_COL.low:PZ_COL.good,`BTC is having a ${kind} day`,
      like.length>=5?`On ${PZ_VOL[rg.vol].toLowerCase()} like this you average ${signedPlain(avg)} a trade (${like.length} trades).${avg<0?' Be pickier today.':''}`:'You haven’t traded enough days like this to say how you do on them.']); }
  if(F.lastLoss){ lines.push([lossMin<15?PZ_COL.low:lossMin<60?PZ_COL.mid:'var(--pz-soft)',lossMin<15?`Your last loss was ${ago(lossMin)} ago`:`${ago(lossMin)} since your last loss`,
      lossMin<15?'Most revenge trades happen in the first 15 minutes after a loss. Let this window pass before your next entry.':F.losses+' loss'+(F.losses===1?'':'es')+' today.']); }
  if(F.lastOpen){ const m=Math.round((F.now-F.lastOpen.openTime)/60000); lines.push(['var(--pz-soft)',`Your last entry was ${ago(m)} ago`,dispMarket(dcoin(F.lastOpen))+' '+String(F.lastOpen.dir||'').toLowerCase()+'.']); }
  return `<section class="pz-card pz-kv"><b class="pz-kvh">Before you trade</b>${lines.map(([c,a,b])=>`<div class="pz-nowrow"><i style="background:${c}"></i><span><b style="font-size:13px">${esc(a)}</b><span class="pz-sub" style="display:block;font-size:12px">${esc(b)}</span></span></div>`).join('')}</section>`;
}
// level, today's XP, streak and shields, and where you stand in your league
function pzProgressRowHtml(D){
  const g=D.g, L=g.level, xpToday=(g.xp&&g.xp.byDay&&g.xp.byDay[D.todayK])||0;
  let lg='';
  if(typeof SOC!=='undefined'&&SOC.me&&typeof socGet==='function'){ const c=socGet('league:'+(SOC.lg||''),'/league'+(SOC.lg?'?id='+encodeURIComponent(SOC.lg):''),60000), d=c&&c.d;
    if(d&&d.league&&d.me)lg=`<a class="pz-prog" href="#social"><span class="pz-lbl" style="font-size:11px">${esc(d.league.name)}${d.tierName&&d.league.tiers?' · '+esc(d.tierName):''}</span><b>#${d.me.rank}<small> of ${d.size||d.rows.length}</small></b><span class="pz-t">${d.promote&&d.me.rank<=d.promote?'in the promotion zone':d.demote&&d.me.rank>(d.size||0)-d.demote?'in the relegation zone':d.promote?'top '+d.promote+' move up':'this '+(d.league.period==='month'?'month':'week')}</span></a>`; }
  return `<div class="pz-progrow pz-span">
    <a class="pz-prog" href="#progress"><span class="pz-lbl" style="font-size:11px;color:${PZ_COL.xp}">Level ${L.level} · ${esc(L.title)}</span>${pzBar(L.max?1:L.into/L.need,PZ_COL.xp)}<span class="pz-t">${L.max?'top level':(L.need-L.into).toLocaleString()+' XP to level '+(L.level+1)}</span></a>
    <a class="pz-prog" href="#progress"><span class="pz-lbl" style="font-size:11px">XP today</span><b style="color:${PZ_COL.xp}">+${xpToday.toLocaleString()}</b><span class="pz-t">${g.streak.current}-day streak${g.streak.shields?' · '+g.streak.shields+' shield'+(g.streak.shields===1?'':'s'):''}</span></a>
    ${lg}</div>`;
}
// in the morning, or before the first close: how the last trading day went and what you told yourself
function pzYesterdayHtml(D){
  const {last,todayK}=D; if(!last)return '';
  const h=tzParts(Date.now()).h; if(D.day&&h>=12)return '';
  const e=journal['day:'+last.key]||{}, yE=(journal['day:'+pzAddDays(todayK,-1)]||{}).eod||{}, b=pzBand(last.score);
  // the review may be from a non-trading yesterday: its "tomorrow" is still today's one thing
  const eod=Object.assign({},e.eod||{},yE.tomorrow&&yE.at>((e.eod||{}).at||0)?{tomorrow:yE.tomorrow}:{});
  return `<section class="pz-card pz-kv"><div class="pz-kvrow"><b class="pz-kvh">${last.key===pzAddDays(todayK,-1)?'Yesterday':esc(dayLabel(last.key))}</b><span class="pz-sub" style="font-size:12px">${last.n} trade${last.n===1?'':'s'}</span></div>
    <div class="pz-grid3"><div class="pz-mini"><span class="pz-t">Discipline</span><b style="color:${PZ_COL[b]}">${last.score}</b></div><div class="pz-mini"><span class="pz-t">Net</span><b style="color:${last.net>=0?PZ_COL.good:PZ_COL.low}" title="${esc(signedPlain(last.net))}">${esc(pzSigned(last.net))}</b></div><div class="pz-mini"><span class="pz-t">XP</span><b style="color:${PZ_COL.xp}">+${((D.g.xp.byDay||{})[last.key]||0).toLocaleString()}</b></div></div>
    ${eod.lesson?`<p class="pz-sub" style="font-size:13px"><b>Lesson:</b> ${esc(eod.lesson)}</p>`:''}${eod.tomorrow?`<p class="pz-focusline">${pzI('bolt',14)}<span><b>Today’s one thing:</b> ${esc(eod.tomorrow)}</span></p>`:''}
    ${!eod.at?`<a class="pz-link" href="#review" style="min-height:0">No review that day — the lesson is where you get better</a>`:''}</section>`;
}
// the last seven trading days, one row each: the day, its Discipline score, and what it made or lost
function pzWeekSparkHtml(D){
  const days=D.g.days.slice(-7).reverse(); if(days.length<2)return '';
  const maxAbs=Math.max(1,...days.map(d=>Math.abs(d.net)));
  const avgS=Math.round(_avg(days.map(d=>d.score))), net=days.reduce((a,d)=>a+d.net,0);
  const dl=k=>new Date(k+'T12:00:00Z').toLocaleDateString('en-US',{weekday:'short',month:'short',day:'numeric',timeZone:'UTC'});
  return `<section class="pz-card pz-kv"><div class="pz-kvrow"><b class="pz-kvh">Last ${days.length} trading days</b><span class="pz-sub" style="font-size:12px">avg discipline ${avgS} · <span style="color:${net>=0?PZ_COL.good:PZ_COL.low}">${esc(pzSigned(net))}</span></span></div>
    <div class="pz-wk" role="table" aria-label="Your last ${days.length} trading days">
      <div class="pz-wkr pz-wkh" role="row"><span role="columnheader">Day</span><span role="columnheader">Discipline</span><span role="columnheader">Net</span></div>
      ${days.map(d=>{ const c=PZ_COL[pzBand(d.score)], w=Math.round(Math.abs(d.net)/maxAbs*100);
        return `<a class="pz-wkr" role="row" href="#discipline" data-pz-tip="${esc(dl(d.key)+': discipline '+d.score+', '+d.n+' trade'+(d.n===1?'':'s')+', '+signedPlain(d.net))}">
          <span role="cell" class="pz-wkd">${esc(dl(d.key))}</span>
          <span role="cell" class="pz-wks"><b style="color:${c}">${d.score}</b><i><em style="width:${d.score}%;background:${c}"></em></i></span>
          <span role="cell" class="pz-wkn"><b style="color:${d.net>=0?PZ_COL.good:PZ_COL.low}">${esc(pzSigned(d.net))}</b><i class="${d.net<0?'neg':''}"><em style="width:${Math.max(3,w)}%;background:${d.net>=0?PZ_COL.good:PZ_COL.low}"></em></i></span></a>`; }).join('')}
    </div><p class="pz-fine" style="margin:0">Discipline is 0–100 from your fills (70+ is a good day). Net bars are scaled to your biggest day of the seven.</p></section>`;
}
// what's due: the challenge, habits to keep today, plugs in progress, competitions ending, the review
function pzComingUpHtml(D){
  const items=pzDueItems(D); if(!items.length)return '';
  return `<section class="pz-card pz-kv"><b class="pz-kvh">Coming up</b>${pzDueRows(items)}</section>`;
}
const pzDueRows=items=>items.map(([ic,c,a,b,href])=>`<a class="pz-uprow" href="${href}"><span class="pz-bc" style="color:${c}">${pzI(ic,13,2.4)}</span><span style="flex:1;min-width:0"><b style="font-size:13px">${esc(a)}</b><span class="pz-sub" style="display:block;font-size:12px">${esc(b)}</span></span></a>`).join('');
function pzDueItems(D){
  const {g,todayK}=D, items=[], dow=new Date(todayK+'T12:00:00Z').getUTCDay(), daysLeft=dow===0?0:7-dow;
  if(g.current){ const kept=g.current.res.filter(r=>r.kept).length; items.push(['bolt',PZ_COL.xp,'Weekly challenge',`${kept} day${kept===1?'':'s'} kept · ${daysLeft?daysLeft+' day'+(daysLeft===1?'':'s')+' left this week':'ends tonight'}`,'#progress']); }
  for(const h of habitsList().slice(0,3)){ const r=habitProgress(h,g.ctx).res.find(x=>x.key===todayK);
    items.push(['check',r?(r.kept?PZ_COL.good:PZ_COL.low):'var(--pz-soft)',habitSentence(h),r?(r.kept?'kept today':'broken today'):'due today','#progress']); }
  for(const p of pzPlugs().filter(p=>!p.dropped&&!p.done).slice(0,2))items.push(['shield',PZ_COL.risk,'Plugging: '+(PZ_BEH[p.slip]||p.slip),`${p.cleanRun} of 3 clean trading weeks · ${pzPlugWeekNote(p)}`,'#progress']);
  if(typeof SOC!=='undefined'&&SOC.me){ const c=SOC.cache&&SOC.cache.comps, all=c&&c.d?c.d.competitions:[];
    for(const x of (all||[]).filter(x=>x.joined&&x.status==='live').sort((a,b)=>a.end<b.end?-1:1).slice(0,2)){
      const left=Math.round((Date.parse(x.end)-Date.parse(todayK))/86400000);
      items.push(['medal',PZ_COL.mid,x.title,(x.me?'#'+x.me.rank+' of '+x.entrants+' · ':'')+(left<=0?'ends today':left+' day'+(left===1?'':'s')+' left'),'#c/'+x.id]); } }
  return items;
}
// Install Pulse on the phone: one card on Today until it's installed or dismissed. Android and
// desktop Chrome offer a real prompt; iPhone Safari has none, so it says where the button is.
function pzStandalone(){ try{ return matchMedia('(display-mode: standalone)').matches||navigator.standalone===true; }catch(e){ return false; } }
function pzIsIOS(){ return /iPhone|iPad|iPod/.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1); }
function pzInstallCardHtml(){
  if(pzStandalone()||!/^https?:$/.test(location.protocol))return '';
  try{ if(localStorage.getItem('pz_install_x'))return ''; }catch(e){}
  const ios=pzIsIOS(); if(!_deferredInstall&&!ios)return '';
  return `<section class="pz-banner pz-span" aria-label="Install Keel"><span class="pz-ico" style="width:40px;height:40px;background:var(--pz-tint-good);color:var(--pz-good)">${pzI('plus',20)}</span>
    <div style="flex:1;min-width:0"><b style="font-size:14px">Put Keel on your home screen</b><p class="pz-fine" style="margin-top:2px">${ios?'Tap <b>Share</b> in Safari’s toolbar, then <b>Add to Home Screen</b>. It opens full screen, like an app.':'It opens full screen, like an app, and can remind you to prep.'}</p></div>
    ${ios?'':'<button type="button" class="pz-ghost pz-sm" id="pzInstallCard" style="flex:0 0 auto">Install</button>'}<button type="button" class="pz-chip icon" id="pzInstallX" aria-label="Not now" style="flex:0 0 auto;height:36px;padding:0 10px">${pzI('x',16)}</button></section>`;
}
function pzTodayHtml(D){
  const {g,day,last,risk,ready,form,load}=D;
  // Discipline is today's score only: before today's first close the dial is empty, with the last
  // trading day's score as a small line under it (it used to show that score, which read as today's)
  const rings=[
    {k:'form',label:'Form',shown:form.score==null?'—':form.score,pct:(form.score||0)/100,col:PZ_COL[pzBand(form.score)],tip:'Your recent trading against your own usual: 50 is normal for you, higher is better than usual. Tap for the details.'},
    {k:'discipline',label:'Discipline',sub:!day&&last?'Last: '+dayLabel(last.key).slice(0,3)+' · '+last.score:'',shown:day?day.score:'—',pct:day?day.score/100:0,col:day?PZ_COL[pzBand(day.score)]:'var(--pz-track)',tip:(day?day.behavior.clean+' of '+day.n+' trade'+(day.n===1?'':'s')+' clean today. ':'No closed trades yet today'+(last?' (your last trading day, '+dayLabel(last.key)+', scored '+last.score+')':'')+'. ')+'The share of trades free of revenge entries, sizing up after losses, adding to losers, trading on after two losses, overtrading and over-held losers. 70+ is a clean day.'},
    {k:'load',label:'Load',shown:load.score==null?'—':load.ratio.toFixed(1)+'×',pct:(load.score||0)/100,col:pzLoadCol(load.score),tip:'How much you’re trading today against your usual day: 1× is normal, above it is busier than usual.'}];
  const sel=['form','discipline','load'].includes(pzS.ring)?pzS.ring:'discipline';
  const ringsHtml=`<div class="pz-rings pz-span" role="group" aria-label="Today’s dials">${rings.map(r=>`<button type="button" class="pz-ringbtn" data-pz-ring="${r.k}" aria-pressed="${r.k===sel}" aria-label="${r.label} ${r.shown==='—'?'not yet today':r.shown}${r.sub?', '+r.sub:''}" data-pz-tip="${esc(r.label+' · '+r.shown+'\n'+r.tip)}">${pzRing(r.shown,r.pct,r.col)}<span class="pz-rl">${r.label}</span>${r.sub?`<span class="pz-rs">${esc(r.sub)}</span>`:''}</button>`).join('')}</div>`;
  let det;
  if(sel==='form'){
    if(form.score==null) det={lbl:'Form',col:PZ_COL.good,href:'#trends',link:'Stats',head:form.stale?'No trades in the last 30 days':'Building your baseline',
      sub:form.stale?'Form reads your recent trading against your usual. It comes back with your next trades.':`Form compares your recent trades with your earlier ones. It needs 15 closed trades — you have ${form.total}.`,rows:[]};
    else { const b=pzBand(form.score), sc=form;
      det={lbl:'Form · '+form.score,col:PZ_COL[b],href:'#trends',link:'Stats',
        head:b==='good'?'In form':b==='mid'?'About your usual':'In a slump',
        sub:b==='good'?'Your recent trading beats your usual. Keep your size where it is — don’t press it.':b==='mid'?'Your recent trading looks like your usual.':'Your recent trading trails your usual. Trade smaller until a few clean wins bring it back.',
        rows:[{label:'Average trade, '+sc.window,value:signedPlain(sc.avgRec)+' vs '+signedPlain(sc.avgBase)+' usual',pct:0.5+sc.e/3},
          {label:'Win rate, '+sc.window,value:pzPct(sc.wrRec)+' vs '+pzPct(sc.wrBase),pct:0.5+sc.w},
          {label:'From your 30-day high',value:sc.dd>0?'−'+usdPlain(sc.dd):'At the high',pct:1-sc.ddN},
          ready!=null?{label:'Readiness from your prep',value:String(ready),pct:ready/100,color:PZ_COL[pzBand(ready)]}:null].filter(Boolean)}; }
  } else if(sel==='load'){
    const lim=[risk.cap>0?{label:'Trades vs your cap',value:risk.trades+' of '+risk.cap,pct:risk.trades/risk.cap}:null,
      risk.limit>0?{label:'Loss vs your limit',value:usdPlain(risk.loss)+' of '+usdPlain(risk.limit),pct:risk.loss/risk.limit}:null].filter(Boolean);
    if(load.score==null) det={lbl:'Load',col:PZ_COL.risk,href:'#checkin',link:'Set limits',head:load.n?load.n+' trade'+(load.n===1?'':'s')+' today':'No trades yet today',
      sub:'Load compares today with your usual trading day. It needs about a week of trading days to know what usual is.',rows:lim};
    else { const r=load.ratio;
      det={lbl:'Load · '+r.toFixed(1)+'× usual',col:pzLoadCol(load.score),href:'#checkin',link:lim.length?'Adjust limits':'Set limits',
        head:r<0.5?'A light day':r<1.2?'Your usual pace':r<1.6?'Busier than usual':'Well past your usual — slow down',
        sub:`${load.n} trade${load.n===1?'':'s'} opened today; on a usual day you open ${Math.round(load.medN*10)/10}.`,
        rows:[{label:'Trades vs usual',value:load.rN.toFixed(1)+'×',pct:load.rN/2,color:pzLoadCol(Math.min(100,load.rN*50))},
          {label:'Size traded vs usual',value:load.rV.toFixed(1)+'×',pct:load.rV/2,color:pzLoadCol(Math.min(100,load.rV*50))},...lim]}; }
  } else {
    if(day){ const b=pzBand(day.score), f=day.behavior.flags, slips=Object.keys(PZ_BEH).filter(k=>f[k]);
      det={lbl:'Discipline · '+day.score,col:PZ_COL[b],href:'#discipline',link:'Breakdown',
        head:b==='good'?'Clean trading':b==='mid'?'A few slips':'Off the rails today',
        sub:`${day.behavior.clean} of ${day.n} closed trade${day.n===1?'':'s'} clean today. Read from your fills — nothing to log.`,
        rows:slips.length?slips.map(k=>({label:PZ_BEH[k],value:f[k]+' trade'+(f[k]===1?'':'s'),pct:f[k]/day.n,color:PZ_COL.low}))
          :[{label:'No revenge entries, size-ups, adding to losers or overtrading',value:'✓',pct:1}]}; }
    else det={lbl:'Discipline',col:PZ_COL.good,href:'#discipline',link:'Breakdown',head:'No closed trades yet today',
      sub:'Today’s score appears with your first closed trade. It starts at 100 and drops for revenge entries, sizing up after a loss, adding to a loser, trading on after two losses and overtrading, all read from your fills. Prep doesn’t change it: prep sets your readiness and earns XP.'
        +(last?` Your last trading day (${dayLabel(last.key)}) scored ${last.score}.`:''),rows:[]};
  }
  const detail=`<section class="pz-card pz-detail" aria-live="polite"><div class="pz-dh"><span class="pz-lbl" style="color:${det.col}">${esc(det.lbl)}</span><a class="pz-link" href="${det.href}">${esc(det.link)}${pzI('chev',16)}</a></div>
    <div><div class="pz-big">${esc(det.head)}</div><p class="pz-sub" style="margin-top:4px">${esc(det.sub)}</p></div>${pzRows(det.rows,det.col)}</section>`;
  const items=pzBonusItems(D), earned=day?day.bonus.total:0, left=items.filter(x=>!x.done).reduce((s,x)=>s+x.xp,0);
  let due=[]; try{ due=pzDueItems(D); }catch(err){}
  const bonus=`<section class="pz-card pz-kv"><div class="pz-kvrow"><b class="pz-kvh">Today’s XP</b><span style="font-size:12px;font-weight:700;color:${PZ_COL.xp}">${earned?'+'+earned+' earned':''}${earned&&left?' · ':''}${left?'+'+left+' to go':''}</span></div>
    ${items.map(x=>`<a class="pz-bonus" href="${x.href}"><span class="pz-bc ${x.done?'done':x.partial?'part':''}">${pzI(x.done?'check':x.partial?'minus':'plus',14,3)}</span><span style="flex:1;min-width:0"><b>${esc(x.label)}</b><span>${esc(x.hint)}</span></span><span class="pz-bx">+${x.xp}</span></a>`).join('')}
    ${due.length?`<span class="pz-lbl pz-sublbl">This week</span>${pzDueRows(due)}`:''}</section>`;
  const coach=`<section class="pz-card pz-coach"><span class="pz-ico">${pzI('chat',18)}</span><p>${esc(pzCoachLine(D))}</p></section>`;
  // each section fails on its own (a bad record can't blank the screen), and shows only if you keep it on
  const safe=f=>{ try{ return f(); }catch(err){ console.warn('today section',err); return ''; } };
  const F=safe(()=>pzTodayFacts(D))||null;
  const on=id=>pzShow('today',id), sec=(id,f)=>on(id)?safe(f):'', more=(id,k)=>F&&on(id)?safe(()=>k(D,F)):'';
  return `${pzHead(dayLabel(D.todayK).replace(', ',' · '),'Today',pzChips(g,D.inbox.length))}
    ${safe(()=>pzTaBannerHtml(D))}
    ${safe(pzInstallCardHtml)}
    ${sec('oneThing',()=>pzOneThingHtml(D))}
    <div class="pz-wide">${ringsHtml}<div class="pz-span" id="pzRingDetail">${detail}</div>${more('numbers',pzTodayStripHtml)}${sec('level',()=>pzProgressRowHtml(D))}
      ${(()=>{ const card={tilt:()=>sec('tilt',()=>pzTiltHtml(D)),insight:()=>on('insight')?coach:'',session:()=>more('session',pzSessionHtml),positions:()=>more('positions',pzPositionsHtml),
          next:()=>sec('next',()=>pzNextHtml(D)),now:()=>more('now',pzNowHtml),good:()=>sec('good',()=>pzGoodHtml(D)),inbox:()=>sec('inbox',()=>socInboxHtml()),duels:()=>sec('duels',()=>socDuelsTodayHtml(D.g)),partners:()=>sec('partners',()=>socPartnerStripHtml()),
          lesson:()=>sec('lesson',()=>pzLessonDueHtml(D)),xp:()=>on('xp')?bonus:'',week:()=>sec('week',()=>pzWeekSparkHtml(D)),yesterday:()=>sec('yesterday',()=>pzYesterdayHtml(D))};
        // your own order (or the default one) reads top to bottom, then on into the second column on a
        // wide screen, the two balanced so neither runs far below the other
        const ord=pzOrdered('today')||PZ_FLOW.today[0].concat(PZ_FLOW.today[1]), lead=pzLinkCardHtml()+pzNudgesHtml(D)+safe(()=>planTodayHtml(D));
        if(ord)return `<div class="pz-span pz-flow">${lead?`<div class="pz-col">${lead}</div>`:''}${ord.map(id=>card[id]()).filter(Boolean).map(h=>`<div class="pz-col">${h}</div>`).join('')}</div>`;
        return `<div class="pz-col">${lead}${PZ_FLOW.today[0].map(id=>card[id]()).join('')}</div><div class="pz-col">${PZ_FLOW.today[1].map(id=>card[id]()).join('')}</div>`; })()}</div>
    ${pzCustomizeLink('today')}`;
}

function pzDisciplineHtml(D){
  const {g,day,last}=D, d=day||last;
  const back=`<a class="pz-back" href="#today">${pzI('back',20)}Today</a>`;
  if(!d)return `${back}${pzHead('Discipline','No trading days yet')}<p class="pz-sub">Your score appears after your first closed trade. It’s read from your fills: revenge entries, sizing up after losses, adding to losers, trading on after two losses, overtrading and holding losers too long.</p>`;
  const b=pzBand(d.score), isToday=d===day, f=d.behavior.flags;
  const checks=Object.keys(PZ_BEH).map(k=>{ const c=f[k]||0;
    return `<div class="pz-part"><span class="pz-pc ${c?'miss':'full'}">${pzI(c?'x':'check',15,3)}</span><span class="pz-pt"><b>${esc(PZ_BEH[k])}</b><span>${c?c+' of '+d.n+' trade'+(d.n===1?'':'s'):'None'}</span></span></div>`; }).join('');
  const bp=d.bonus.parts;
  const recent=g.days.slice(-14);
  const bars=recent.map(x=>`<i style="height:${Math.max(4,Math.round(x.score*0.96))}px;background:${PZ_COL[pzBand(x.score)]}" data-pz-tip="${esc(pzDayTip(x))}"></i>`).join('');
  return `${back}${pzHead(isToday?'Today':dayLabel(d.key),'Discipline')}
  <div class="pz-wide">
    <div class="pz-col"><section style="display:flex;flex-direction:column;align-items:center;gap:8px;text-align:center">${pzRing(d.score,d.score/100,PZ_COL[b],{size:188,cap:'Discipline'})}
      <div class="pz-big">${d.behavior.clean} of ${d.n} trade${d.n===1?'':'s'} clean${isToday?'':' on your last trading day'}</div>
      <p class="pz-sub">Read from your fills, so it’s the same score the leaderboard verifies. Profit doesn’t count. <a href="#how">How it’s worked out</a></p></section>
      <section class="pz-card" style="display:flex;flex-direction:column;gap:10px"><div style="display:flex;justify-content:space-between;align-items:baseline;gap:10px"><b style="font-size:15px">Last ${recent.length} trading days</b><span style="display:inline-flex;align-items:center;gap:6px;font-size:13px;font-weight:700;color:var(--pz-streak)">${pzI('flame',16)}${g.streak.current}-day streak</span></div>
        <div class="pz-chart" style="--h:96px;--gap:5px"><span class="pz-thr" style="bottom:${Math.round(70*0.96)}px"></span>${bars}</div>
        <p class="pz-sub" style="font-size:12px">Dashed line is 70 — a clean day for your streak. ${g.streak.shields?`You hold ${g.streak.shields} shield${g.streak.shields===1?'':'s'}: each one covers an off day.`:'A perfect week (every trading day 70+) earns a shield that covers one off day.'}</p></section></div>
    <div class="pz-col"><section class="pz-card pz-parts" aria-label="The six checks">${checks}</section>
      </div>
  </div>`;
}

// Stats can be narrowed to perps or spot; everything else in Pulse counts every market
// the saved choice applies only while both markets exist; otherwise everything shows
let _pzMkMemo={n:-1,both:false};
function pzBothMarkets(){ if(_pzMkMemo.n!==allTrades.length){ _pzMkMemo={n:allTrades.length,both:allTrades.some(t=>t.market==='perp')&&allTrades.some(t=>t.market==='spot')}; } return _pzMkMemo.both; }
function pzMk(){ const m=settings.pzMarket; return pzBothMarkets()&&(m==='perp'||m==='spot')?m:'all'; }
const pzInMk=t=>{ const m=pzMk(); return m==='all'||t.market===m; };
function pzMkSeg(){
  if(!pzBothMarkets())return '';
  return `<div class="pz-seg pz-mkseg" role="group" aria-label="Markets">${[['all','All markets'],['perp','Perps'],['spot','Spot']].map(([k,l])=>`<button type="button" data-pz-mk="${k}" aria-pressed="${pzMk()===k}">${l}</button>`).join('')}</div>`; }
// the whole-history answer under the range tiles: the good-day dividend and whether it holds up,
// from the same analysis as Review → Routine vs results in the full journal
function pzLongViewHtml(){
  let r; try{ r=rvModel(); }catch(e){ return ''; }
  const u=r.unit, f=v=>(v>=0?'+':'')+(u==='R'?v.toFixed(2)+'R':v.toFixed(2)+'%');
  if(r.weeks.length<r.need.weeks)return `<p class="pz-fine">The long view needs ${r.need.weeks} weeks of trading; you have ${r.weeks.length}.</p>`;
  const dv=r.dividend; if(!dv)return '';
  const holds=dv.lo>0, against=dv.hi<0, top=r.habits.filter(h=>!h.mechanical&&h.q!=null&&h.q<0.1&&h.diff>0)[0];
  return `<div class="pz-tile ${holds?'good':against?'hot':'cool'}"><span class="pz-t" style="font-size:13px;line-height:1.45">Over all ${r.weeks.length} weeks: disciplined days made <b>${esc(f(dv.diff))}</b> more per trade than the rest${holds?' — and it holds up':against?' — the other way round':' — not clear yet'} (90% range ${esc(f(dv.lo))} to ${esc(f(dv.hi))}).${top?` The habit that pays most: <b>${esc(top.label.toLowerCase())}</b> (${esc(f(top.diff))}/trade).`:''} <a href="${esc(pzFullHref())}">Full analysis</a></span></div>`;
}
// ---- "Do your habits pay?": the simple version, for people getting started ----
// Pulse answers in plain words: a verdict, how sure it is, the two kinds of days side by side
// and the one habit to protect, in dollars. A tap opens a plain breakdown (a three-step
// staircase and the habits, each worth so much a day). The scatter and the statistics live in
// the full journal (Review → Routine vs results); this is the same model (habitLink), told simply.
let _pzHL={key:null,v:null};
function pzHabitModel(g, ctx, fromKey){
  const days=g.days.filter(d=>d.key>=fromKey&&(byd=>byd.some(pzInMk))(ctx.byDay[d.key]||[]));
  const key=[fromKey,pzMk(),days.length,_coachMemo.key,_jrev].join('|');
  if(_pzHL.key===key)return _pzHL.v;
  const byDay={}; for(const d of days)byDay[d.key]=(ctx.byDay[d.key]||[]).filter(pzInMk);
  const entryOf=k=>{ const e=journal['day:'+k]; return {checkin:typeof pzReadinessManual==='function'&&pzReadinessManual(e)!=null, review:!!(e&&e.eod&&e.eod.at)}; };
  let v=null; try{ v=habitLink(days,byDay,{unit:'$',rOf:rFor,pctOf:retPct,entryOf,seed:_hashSeed('hl|'+fromKey)}); }catch(e){ console.warn('habits vs results',e); }
  _pzHL={key,v}; return v;
}
const pzHlFmt=(v,u,exact)=>v==null||!isFinite(v)?'—':u==='$'?(exact?signedPlain(v):pzSigned(v)):u==='%'?(v>=0?'+':'')+v.toFixed(2)+'%':(v>=0?'+':'')+v.toFixed(2)+'R';
const PZ_HL_DAY='A “habit day” is a day you kept most of your habits (7 in 10 or more): plan, morning prep, journaling, review, and no revenge trades, sizing up after a loss, adding to losers or overtrading. Only the habits you actually use count.';
function pzHabitLinkHtml(g, ctx, fromKey){
  const L=pzHabitModel(g,ctx,fromKey); if(!L)return '';
  const S=hlSummary(L), gd=L.good, rs=L.rest, n=S.n, open=!!pzS.hlOpen, abs=v=>pzShort(Math.abs(v)), dd=k=>k+' day'+(k===1?'':'s');
  const pill={early:'Early read',flat:'Not yet',pays:'Yes',unclear:'Not clear yet',reverse:'Not yet'}[S.verdict];
  const line=S.verdict==='early'?(n?`After ${dd(n)} it’s too early to tell. Keep logging your habits; this fills in around day ${L.need.corr}.`:'No trading days in this range yet.')
    :S.verdict==='flat'?(!gd.n?'You haven’t had a day with most of your habits kept yet. Try one and see how it goes.':!rs.n?'You kept most of your habits every single day here, so there’s nothing to compare against. A good problem to have.':'Your days all looked the same on habits, so there’s nothing to compare yet.')
    :S.verdict==='pays'?`On days you kept most of your habits, you made <b style="color:${PZ_COL.good};white-space:nowrap">${esc(abs(S.d))} more</b> a day on average.`
    :S.verdict==='reverse'?`So far your days with fewer habits kept did a bit better (${esc(abs(S.d))} a day). That can happen early on, from the market or plain luck. Keep logging and check back.`
    :(Math.abs(S.d)<1?'So far your habit days and your other days end up about the same.':`So far your habit days did a bit ${S.d>0?'better':'worse'} (${esc(abs(S.d))} a day), but it’s not clear yet; it could be luck.`)+' Keep going; it gets clearer with more days.';
  const tile=(cls,lbl,x,tip)=>`<div class="pz-tile ${cls}" data-pz-tip="${esc(tip)}" tabindex="0"><span class="pz-t">${lbl}</span><span class="pz-n" style="color:${pzSignCol(x.avg)}">${esc(pzHlFmt(x.avg,'$'))}</span><span class="pz-t">average day · ${x.green} of ${dd(x.n)} green</span></div>`;
  const tiles=gd.n>=2&&rs.n>=2&&n>=L.need.days?`<div class="pz-grid2">${tile('good','Habit days',gd,'Habit days: '+dd(gd.n)+'\nAverage day '+pzHlFmt(gd.avg,'$',true)+', '+gd.green+' of them green.\n'+PZ_HL_DAY)}${tile('cool','Other days',rs,'Other days: '+dd(rs.n)+'\nAverage day '+pzHlFmt(rs.avg,'$',true)+', '+rs.green+' of them green.\nDays you kept fewer than 7 in 10 of your habits.')}</div>`:'';
  const protect=S.top?`<div class="pz-hlprot" data-pz-tip="${esc(S.top.label+'\nDays you kept it: '+pzHlFmt(S.top.kept.avg,'$',true)+' on average ('+dd(S.top.kept.n)+').\nDays you didn’t: '+pzHlFmt(S.top.missed.avg,'$',true)+' ('+dd(S.top.missed.n)+').')}" tabindex="0"><span class="pz-hlk">1</span><span>Protect this one: <b>${esc(S.top.label)}</b><span class="pz-sub" style="display:block;font-size:12px">worth about ${esc(abs(S.top.diff))} a day for you</span></span></div>`:'';
  const meter=`<div class="pz-hlmeter" data-pz-tip="${esc('How sure we are\nIt gets surer as you log more days and the pattern keeps holding. Until then, treat it as a hint, not a fact.')}" tabindex="0"><i aria-hidden="true">${[1,2,3].map(k=>`<s class="${S.sure>=k?'on':''}"></s>`).join('')}</i>${esc(S.sureText)} · ${dd(n)}</div>`;
  // the breakdown: three steps and the habits, in dollars a day
  let more='';
  if(open){
    const steps=[['Few','under half',p=>p.score<50],['Some','half or more',p=>p.score>=50&&p.score<70],['Most','7 in 10 or more',p=>p.score>=70]].map(([l,sub,f])=>{ const ps=L.points.filter(f), avg=ps.length?ps.reduce((a,p)=>a+p.v,0)/ps.length:null;
      return {l,v:avg||0,tip:ps.length?`${l} habits kept (${sub}): ${dd(ps.length)}\nAverage day ${pzHlFmt(avg,'$',true)}\n${ps.filter(p=>p.v>0).length} of them green`:`${l} habits kept (${sub})\nNo days like this yet`}; });
    const hab=L.habits.filter(h=>!h.mechanical).slice(0,5);
    more=`<div class="pz-hlmore-body">
      <b style="font-size:14px">The more habits you keep…</b>${pzDivBars(steps,90)}
      <p class="pz-fine" style="margin:-4px 0 0">Your average day when you kept few, some or most of your habits.</p>
      ${hab.length?`<b style="font-size:14px;margin-top:6px">Your habits, by what they’re worth</b>${hab.map((h,i)=>`<div class="pz-hlhab" data-pz-tip="${esc(h.label+'\nKept on '+dd(h.kept.n)+', skipped on '+dd(h.missed.n)+'.\nDays you kept it were '+pzHlFmt(h.diff,'$',true)+' a day compared with days you didn’t.')}" tabindex="0"><span class="pz-hlk${i===0&&h.diff>0&&S.verdict==='pays'?' top':''}">${i+1}</span><span>${esc(h.label)}<span class="pz-sub" style="display:block;font-size:12px">kept ${h.kept.n} of ${h.kept.n+h.missed.n} days</span></span><b style="color:${pzSignCol(h.diff)}">${esc(pzHlFmt(h.diff,'$'))}<small> /day</small></b></div>`).join('')}
        <p class="pz-fine" style="margin:0">Habits overlap, so these don’t add up. Treat them as a ranking.</p>`:''}
      <p class="pz-fine" style="margin:0">Every day as a dot, and the statistics behind this, are in the <a href="${esc(pzFullHref())}">full journal</a> under Review.</p></div>`;
  }
  return `<section class="pz-card pz-span pz-viz pz-hlcard" data-sec="stats:habits">
    <div class="pz-kvrow"><b style="font-size:16px" data-pz-tip="${esc(PZ_HL_DAY)}" tabindex="0">Do your habits pay?</b><span class="pz-hlpill ${S.verdict}">${pill}</span></div>
    <p class="pz-hlline">${line}</p>${tiles}${protect}${meter}
    ${n>=L.need.days?`<button type="button" class="pz-hlmore" data-pz-hlmore="1" aria-expanded="${open}">${open?'Hide the breakdown':'See the breakdown'} ${pzI('chev',14)}</button>`:''}${more}</section>`;
}
// ---- "Traders like you", the simple version: five numbers against your peer group, in plain words ----
function pzPeersHtml(g){
  if(!peerCanAsk()||(SOC.cfg&&SOC.cfg.bench&&SOC.cfg.bench.on===false))return '';
  const head=`<div class="pz-kvrow"><b style="font-size:16px">Traders like you</b>`, sec=body=>`<section class="pz-card pz-span pz-viz pz-peers" data-sec="stats:peers">${body}</section>`;
  const lock=pzLocked('peers',g.level.level);
  if(lock)return sec(`${head}</div><p class="pz-sub" style="font-size:13px;margin:0">${pzI('lock',14)} Unlocks at level ${lock}. ${pzXpToGo(lock,g)}</p>`);
  const mine=peerMine();
  if(!mine.ok)return sec(`${head}</div><p class="pz-sub" style="font-size:13px;margin:0">See how you compare with traders who trade like you. ${esc(peerWhy(mine))}${mine.n?' You have '+mine.n+'.':''}</p>`);
  const P=peerData(mine), d=P&&P.d;
  if(!d)return sec(`${head}</div><p class="pz-sub" style="font-size:13px;margin:0">${P&&P.err?'Couldn’t load the comparison: '+esc(P.err):'Loading your peer group…'}</p>`);
  if(d.on===false)return '';
  const grp=peerGroup(d);
  if(!grp)return sec(`${head}</div><p class="pz-sub" style="font-size:13px;margin:0">Not enough traders on this server to compare yet: ${d.contributors} of the ${d.min} needed for a group. It fills in as more people trade here.</p>`);
  const rows=PEER_M.filter(m=>['disc','rev','jour','wr','pf'].includes(m.k)&&grp.q[m.k]&&mine[m.k]!=null).map(m=>{
    const b=peerBetter(m,grp.q[m.k],mine[m.k]), c=b>=75?'top':b<25?'bot':'mid', w=b>=75?'Top 25%':b>=40?'Typical':b>=25?'A bit behind':'Bottom 25%';
    const col=c==='top'?PZ_COL.good:c==='bot'?PZ_COL.low:PZ_COL.risk, typ=grp.q[m.k][4];
    return `<div class="pz-prow" tabindex="0" data-pz-tip="${esc(m.l+': '+m.f(mine[m.k])+'\nTypical trader like you: '+m.f(typ)+'\n'+m.tip)}"><span class="pz-plab">${esc(m.l)}</span><b class="pz-pval">${esc(m.f(mine[m.k]))}</b>
      <span class="pz-pbarw"><span class="pz-pbar2"><s></s><i style="left:${b}%;background:${col}"></i></span><span class="pz-ptag ${c}">${w}</span></span>
      <span class="pz-sub pz-pline">Better than ${b} of 100 traders like you</span></div>`; }).join('');
  const gap=peerGap(grp,mine), say=gap&&PEER_GAP_SAY[gap.m.k](gap.top,gap.v);
  const chips=['style','size','exp','act'].filter(k=>grp.dims[k]).map(k=>`<span class="pz-pchip">${esc(PEER_DIMS[k][grp.dims[k]])}</span>`).join('')||'<span class="pz-pchip">Everyone on this server</span>';
  const out=SOC.share&&SOC.share.bench===false?`<p class="pz-fine" style="margin:0">You’re not counted in these groups (switched off under Profile & privacy).</p>`:'';
  return sec(`${head}<span class="pz-sub" style="font-size:12px">${grp.n} traders</span></div>
    <div class="pz-pchips">${chips}</div><div>${rows}</div>
    ${say?`<div class="pz-pgap" tabindex="0" data-pz-tip="${esc('The best quarter of your group by profit factor. This is the habit where you’re furthest behind them.')}"><span class="pz-lbl" style="color:${PZ_COL.xp}">What the best of them do</span><b>${esc(say[0])} ${esc(say[1])}</b></div>`:''}
    ${out}<p class="pz-fine" style="margin:0">Last 90 days · anonymous · groups of ${d.min} or more · updated daily</p>`);
}
// ---- "What traders like you changed when they improved": two or three changes, each one tap from a habit ----
function pzImproversHtml(g){
  if(!peerCanAsk()||(SOC.cfg&&SOC.cfg.bench&&SOC.cfg.bench.on===false)||pzLocked('peers',g.level.level))return '';
  const mine=peerMine(), P=mine.ok?peerData(mine):null, d=P&&P.d, I=d&&d.on!==false&&d.improvers;
  if(!I)return '';
  const head=`<b style="font-size:16px">What traders like you changed when they improved</b>`, sec=body=>`<section class="pz-card pz-span pz-viz pz-peers" data-sec="stats:peers">${head}${body}</section>`;
  if(!I.changes.length)return sec(`<p class="pz-sub" style="font-size:13px;margin:0">${esc(I.note||'Not enough history yet.')}</p>`);
  // changes you can turn into a habit first, biggest first within each
  const list=[...I.changes.filter(c=>peerImpHabit(c)),...I.changes.filter(c=>!peerImpHabit(c))].slice(0,3);
  const rows=list.map(c=>{ const h=peerImpHabit(c), i=I.changes.indexOf(c);
    const act=!h?'':peerImpHas(h)?`<span class="pz-chipbtn ok">${pzI('check',14,3)} In your habits</span>`:`<button type="button" class="pz-ghost pz-sm" style="width:auto;padding:0 14px" data-pz-impadopt="${i}">Make it my habit</button>`;
    return `<div class="pz-imp"><span tabindex="0" data-pz-tip="${esc(peerImpTip(c))}">${esc(c.text)}.</span>${act}</div>`; }).join('');
  return sec(`<div>${rows}</div><p class="pz-fine" style="margin:0">${I.n} traders like you got better over 8 to 12 weeks (from the bottom half of their group to the top half, on Discipline or profit factor). Compared with ${I.nOthers} who didn’t. Tap a change for the numbers.</p>`);
}
function pzTrendsHtml(D){
  const {g}=D, ctx=g.ctx, R=pzS.range, now=Date.now();
  const from=R==='all'?0:pzRangeStart(R,now), fromKey=dayKey(from);
  const st=pzStatsFor(ctx.trades.filter(pzInMk),from);
  const seg=`<div class="pz-seg" role="group" aria-label="Range">${[[7,'7D'],[30,'30D'],[90,'90D'],['all','All']].map(([n,l])=>`<button type="button" data-pz-range="${n}" aria-pressed="${n===R}">${l}</button>`).join('')}</div>`;
  const money=v=>v==null||!isFinite(v)?'—':pzSigned(v), exact=v=>v==null||!isFinite(v)?'':signedPlain(v);
  let stats;
  if(!st) stats=`<section class="pz-card pz-span"><p class="pz-sub">No closed trades in this range.</p></section>`;
  else { const s=st.s, col=v=>v>0?PZ_COL.good:v<0?PZ_COL.low:'var(--pz-text)';
    const tile=(label,val,sub,c,full)=>`<div class="pz-tile"${full?` title="${esc(label+': '+full)}"`:''}><span class="pz-t">${esc(label)}</span><span class="pz-n" style="color:${c||'var(--pz-text)'}">${esc(val)}</span>${sub?`<span class="pz-t">${esc(sub)}</span>`:''}</div>`;
    const maxAbs=Math.max(1,...st.days.map(x=>Math.abs(x.net)));
    const days=st.days.slice(-60);
    const bars=days.map(x=>`<i style="height:${Math.max(3,Math.round(Math.abs(x.net)/maxAbs*100))}px;background:${x.net>=0?PZ_COL.good:PZ_COL.low};opacity:.9" data-pz-tip="${esc(dayLabel(x.k)+'\nNet '+signedPlain(x.net)+'\n'+x.n+' trade'+(x.n===1?'':'s')+' · '+x.w+' W · '+x.l+' L'+(x.n?'\nAverage trade '+signedPlain(x.net/x.n):''))}"></i>`).join('');
    const mk=st.markets, best=mk.slice(0,3).filter(x=>x.net>0), worst=mk.slice(-3).reverse().filter(x=>x.net<0);
    const hr=h=>String(h).padStart(2,'0')+':00';
    const hrs=st.hours.length>=2?[['Best hour',st.hours[0]],['Worst hour',st.hours[st.hours.length-1]]]:[];
    stats=`<div class="pz-grid3 pz-span" data-sec="stats:tiles">${tile('Net P&L',money(s.net),s.n+' trade'+(s.n===1?'':'s'),col(s.net),exact(s.net))}${tile('Win rate',pzPct(s.winRate),s.wins+' W · '+s.losses+' L')}${tile('Average trade',money(s.expectancy),'',col(s.expectancy),exact(s.expectancy))}
      ${tile('Profit factor',isFinite(s.profitFactor)?s.profitFactor.toFixed(2):'∞','')}${tile('Average win',pzShort(s.avgWin),'avg loss '+pzShort(s.avgLoss)+' · payoff '+(isFinite(s.payoff)?s.payoff.toFixed(2):'∞'),null,usdPlain(s.avgWin)+' win / '+usdPlain(s.avgLoss)+' loss')}${tile('Fees + funding',money(-(s.fees)+(s.fund||0)),'fees '+pzShort(s.fees),null,exact(-(s.fees)+(s.fund||0)))}</div>
      <a class="pz-ghost pz-span pz-deepbtn" href="#deep">${pzLocked('deep',g.level.level)?pzI('lock',16)+'In-depth stats · level '+pzLocked('deep',g.level.level):'See in-depth stats'}${pzI('chev',18)}</a>
      <section class="pz-card pz-span" data-sec="stats:daily" style="display:flex;flex-direction:column;gap:10px"><div style="display:flex;justify-content:space-between;align-items:baseline"><b style="font-size:15px">Daily P&L</b><span class="pz-sub" style="font-size:12px">${days.length} trading day${days.length===1?'':'s'}${st.days.length>60?' (last 60)':''}</span></div>
        <div class="pz-chart" style="--h:100px;--gap:${days.length>30?'2px':'5px'}">${bars}</div></section>
      <section class="pz-card" data-sec="stats:markets" style="display:flex;flex-direction:column;gap:6px"><b style="font-size:15px">Markets</b>
        ${best.map(x=>`<div class="pz-row-t"><span>${esc(dispMarket(x.k))} · ${x.n}</span><b style="color:${PZ_COL.good}" title="${esc(signedPlain(x.net))}">${esc(pzSigned(x.net))}</b></div>`).join('')||'<p class="pz-sub" style="font-size:13px">No winning market in this range.</p>'}
        ${worst.map(x=>`<div class="pz-row-t"><span>${esc(dispMarket(x.k))} · ${x.n}</span><b style="color:${PZ_COL.low}" title="${esc(signedPlain(x.net))}">${esc(pzSigned(x.net))}</b></div>`).join('')}</section>
      <section class="pz-card" data-sec="stats:markets" style="display:flex;flex-direction:column;gap:6px"><b style="font-size:15px">Time of day</b>
        ${hrs.map(([l,x])=>`<div class="pz-row-t"><span>${l} · ${hr(x.h)} · ${x.n} trades</span><b style="color:${col(x.net)}" title="${esc(signedPlain(x.net))}">${esc(pzSigned(x.net))}</b></div>`).join('')||'<p class="pz-sub" style="font-size:13px">Needs a few more trades per hour to compare.</p>'}
        <p class="pz-fine">By entry time, on your ${settings.tz==='utc'?'UTC':'local'} clock.</p></section>`; }
  // deeper insights: discipline vs results — unlocked by level
  const lock=pzLocked('trends',g.level.level);
  let deep;
  if(lock) deep=`<section class="pz-card pz-span" style="display:flex;align-items:center;gap:14px">${pzI('lock',22)}<span style="flex:1"><b style="font-size:15px">Deeper insights unlock at level ${lock}</b><br><span class="pz-sub" style="font-size:13px">Does discipline pay for you, how your morning prep relates to your trading, and what moves your score. ${pzXpToGo(lock,g)}</span></span></section>`;
  else { const ts=pzTrendStats(g.days,ctx.byDay,fromKey), bc=pzBars(ts.days);
    const chart=ts.days.length?`<div class="pz-chart" style="--h:110px;--gap:${bc.bars.length>20?'3px':'8px'}"><span class="pz-thr" style="bottom:${Math.round(70*1.1)}px"></span>${bc.bars.map(b=>`<i style="height:${Math.max(4,Math.round(b.v*1.1))}px;background:${PZ_COL[pzBand(b.v)]}" data-pz-tip="${esc(b.tip)}"></i>`).join('')}</div>`:'<p class="pz-sub">No trading days in this range.</p>';
    const tile=(cls,lbl,x)=>`<div class="pz-tile ${cls}"><span class="pz-lbl" style="font-size:11px">${lbl} · ${x.n} day${x.n===1?'':'s'}</span><span class="pz-n">${esc(money(x.avgNet))}</span><span class="pz-t">avg day · ${pzPct(x.winRate)} win rate</span></div>`;
    const rl=pzReadinessLink(ts.days,journal), RF=pzRangeFindings(ctx,from), FA=RF.findings;
    // the six most significant edges and leaks (already ranked by size × confidence); plain notes only fill the gaps
    const F=[...FA.filter(f=>f.tone!=='info'),...FA.filter(f=>f.tone==='info')].slice(0,6);
    deep=`<section class="pz-card pz-span" data-sec="stats:insights" style="display:flex;flex-direction:column;gap:12px"><div style="display:flex;justify-content:space-between;align-items:flex-end;gap:10px"><span><span class="pz-lbl" style="color:${PZ_COL.good}">Discipline</span><br><span class="pz-sub" style="font-size:13px">${bc.unit}</span></span><span style="display:flex;align-items:baseline;gap:6px"><span class="pz-sub" style="font-size:12px">avg</span><span style="font-family:var(--pz-num);font-size:40px;font-weight:600;line-height:1">${ts.avg==null?'—':ts.avg}</span></span></div>${chart}</section>
      <div class="pz-col pz-span" data-sec="stats:insights"><section style="display:flex;flex-direction:column;gap:10px"><b style="font-size:15px">Does discipline pay?</b><div class="pz-grid2">${tile('good','Days 70+',ts.hi)}${tile('hot','Under 70',ts.lo)}</div>
        ${pzLongViewHtml()}
        ${rl?`<div class="pz-tile cool"><span class="pz-t" style="font-size:13px;line-height:1.45">On days you prepped at readiness 70+, your discipline averaged <b>${rl.hi}</b>; on the other days you prepped, <b>${rl.lo}</b>.</span></div>`:''}</section></div>
      <div class="pz-col pz-span" data-sec="stats:findings"><section class="pz-card" style="padding:6px 16px"><b style="display:block;font-size:15px;margin:10px 0 2px">What moves your results <span class="pz-sub" style="font-weight:400;font-size:12px">· ${R==='all'?'all time':'last '+R+' days'}${RF.n?', '+RF.n+' trades':''}</span></b>${RF.few?`<p class="pz-sub" style="font-size:13px;padding:6px 0 12px">Needs at least 10 closed trades in this range to find patterns — there ${RF.n===1?'is':'are'} ${RF.n}. Try a longer range.</p>`:''}${F.length?F.map(f=>`<div class="pz-ins"><span class="pz-tag ${esc(f.tone)}">${esc(TONE_TAG[f.tone]||'Note')}</span><span><b>${esc(f.title)}</b><span>${esc(pzPlain(f.action||f.body||''))}</span>${f.evidence?`<details class="pz-why"><summary>Why</summary><span>${esc(f.evidence)} · ${esc(confWords(f.conf))}</span></details>`:''}</span></div>`).join(''):(RF.few?'':'<p class="pz-sub" style="padding:12px 0">Patterns show up here after about five closed trades.</p>')}</section></div>`; }
  if(!lock)deep=pzHabitLinkHtml(g,ctx,fromKey)+deep; // the plain answer first, then the detail
  deep+=pzPeersHtml(g)+pzImproversHtml(g);
  return `${pzHead(R==='all'?'All time':'Last '+R+' days','Stats',seg)}${pzMkSeg()}<div class="pz-wide">${stats}${(()=>{ try{ return pzShow('stats','plans')?planPzStatsHtml(ctx.closed.filter(t=>t.closeTime>=from&&pzInMk(t)),R):''; }catch(e){ console.warn('plans card',e); return ''; } })()}${deep}<p class="pz-fine pz-span"><a href="#how">How are the scores worked out?</a></p>${pzCustomizeLink('stats')}</div>${pzLayoutCss('stats')}`;
}
// The Diagnostic's findings for one range (all time reuses the coach's set). Same engine, only the
// range's trades; memoized per range so switching back and forth is instant.
let _pzRF={key:null,v:null};
function pzRangeFindings(ctx, fromMs){
  if(!fromMs&&pzMk()==='all')return {findings:ctx.findings||[],n:ctx.closed.length,few:false};
  const closed=ctx.closed.filter(t=>t.closeTime>=fromMs&&pzInMk(t)), key=fromMs+'|'+pzMk()+'|'+closed.length+'|'+_coachMemo.key+'|'+_jrev;
  if(_pzRF.key===key)return _pzRF.v;
  let v;
  if(closed.length<10)v={findings:[],n:closed.length,few:true};
  else { let findings=[];
    try{ const s=computeStats(closed,closed), chron=[...closed].sort((a,b)=>a.closeTime-b.closeTime), nets=chron.map(t=>t.net);
      findings=buildFindings(closed,s,{scan:diagScan(closed),cdd:currentDD(nets),uw:underwaterStats(chron),skew:_skew(nets),acf1:_autocorr1(nets),esig:edgeSignificance(nets)}); }
    catch(e){ console.warn('range findings failed',e); }
    v={findings,n:closed.length,few:false}; }
  _pzRF={key,v}; return v;
}
// ---- screens: in-depth stats (#deep) and how the scores work (#how) ----
const pzMoney=v=>v==null||!isFinite(v)?'—':pzSigned(v);
const pzSignCol=v=>v>0?PZ_COL.good:v<0?PZ_COL.low:'var(--pz-text)';
const pzRatio=v=>v==null?'—':isFinite(v)?v.toFixed(2):'∞';
// a card of label/value rows; tip explains the number on hover
function pzKv(title, rows, note){
  return `<section class="pz-card pz-kv"><b class="pz-kvh">${esc(title)}</b>${rows.filter(Boolean).map(([l,v,c,tip])=>`<div class="pz-row-t"${tip?` data-pz-tip="${esc(l+'\n'+tip)}" tabindex="0"`:''}><span>${esc(l)}</span><b${c?` style="color:${c}"`:''}>${esc(v)}</b></div>`).join('')}${note?`<p class="pz-fine">${note}</p>`:''}</section>`;
}
// a breakdown table: label, trades, win rate, net, average
// Lists longer than ten show ten at a time; each list remembers its page while the app is open.
var PZ_PAGES={};
function pzPage(key, items, size){ size=size||10; const n=items.length, pages=Math.max(1,Math.ceil(n/size)), p=Math.max(0,Math.min(PZ_PAGES[key]||0,pages-1)); PZ_PAGES[key]=p;
  return {items:items.slice(p*size,(p+1)*size), offset:p*size, page:p, pages,
    html:n>size?`<nav class="pz-pager" aria-label="Pages"><button type="button" data-pz-pg="${esc(key)}" data-d="-1"${p?'':' disabled'} aria-label="Previous page">${pzI('back',16)}</button><span>${p*size+1}–${Math.min(n,(p+1)*size)} of ${n}</span><button type="button" data-pz-pg="${esc(key)}" data-d="1"${p<pages-1?'':' disabled'} aria-label="Next page">${pzI('chev',16)}</button></nav>`:''}; }
function pzTbl(title, rows, labelOf, note){
  if(!rows.length)return '';
  const pg=pzPage('tbl:'+title,rows); rows=pg.items;
  return `<section class="pz-card pz-kv"><b class="pz-kvh">${esc(title)}</b><div class="pz-tblw"><table class="pz-tbl"><thead><tr><th scope="col"></th><th scope="col">Trades</th><th scope="col">Win rate</th><th scope="col">Net</th><th scope="col">Avg</th></tr></thead><tbody>
    ${rows.map(r=>`<tr><th scope="row">${esc(labelOf(r))}</th><td>${r.n}</td><td>${pzPct(r.winRate)}</td><td style="color:${pzSignCol(r.net)}" title="${esc(r.net==null?'':signedPlain(r.net))}">${esc(pzMoney(r.net))}<small>avg ${esc(pzMoney(r.avg))}</small></td><td title="${esc(r.avg==null?'':signedPlain(r.avg))}">${esc(pzMoney(r.avg))}</td></tr>`).join('')}</tbody></table></div>${pg.html}${note?`<p class="pz-fine">${note}</p>`:''}</section>`;
}
// bars above and below a zero line, one per bucket (P&L by hour or weekday); tip on each
function pzDivBars(items, h){
  const max=Math.max(1,...items.map(x=>Math.abs(x.v||0)));
  return `<div class="pz-div" style="--h:${h||110}px" role="img" aria-label="Net P&L by bucket; the table view is below">${items.map(x=>{ const pct=Math.round(Math.abs(x.v||0)/max*100);
    return `<span data-pz-tip="${esc(x.tip)}" tabindex="0"><i class="up">${x.v>0?`<b style="height:${Math.max(2,pct)}%;background:${PZ_COL.good}"></b>`:''}</i><i class="dn">${x.v<0?`<b style="height:${Math.max(2,pct)}%;background:${PZ_COL.low}"></b>`:''}</i><em>${esc(x.l)}</em></span>`; }).join('')}</div>`;
}
// cumulative P&L, trade by trade, with the drawdown underneath
// The equity curve, spelled out: dollar axis, dates, the peak, where it stands now, the deepest
// drawdown with its own scale, and a hover readout of any trade along the way. Drawn at roughly
// the size it's shown so the labels stay readable on a phone.
var PZ_EQ={curve:null,byId:null,geo:null};
function pzNiceStep(span,n){ const raw=span/Math.max(1,n), p=Math.pow(10,Math.floor(Math.log10(raw||1))), f=raw/p; return (f<=1?1:f<=2?2:f<=2.5?2.5:f<=5?5:10)*p; }
function pzEquitySvg(curve,byId){
  if(curve.length<2)return '<p class="pz-sub" style="font-size:13px">Needs at least two trades.</p>';
  const vw=typeof innerWidth==='number'?innerWidth:800, W=Math.round(Math.max(320,Math.min(1000,vw<900?vw-56:vw-360)));
  const L=58, R=14, T=18, EH=Math.round(Math.max(150,Math.min(230,W*0.3))), G=40, DH=70, B=22, H=T+EH+G+DH+B, n=curve.length, pw=W-L-R;
  let hiI=0, ddI=0; curve.forEach((c,i)=>{ if(c.cum>curve[hiI].cum)hiI=i; if(c.dd<curve[ddI].dd)ddI=i; });
  const hi=Math.max(0,curve[hiI].cum), lo=Math.min(0,...curve.map(c=>c.cum)), st=pzNiceStep(hi-lo||1,4);
  const yMax=Math.ceil(hi/st)*st||st, yMin=Math.floor(lo/st)*st, ddMin=Math.min(-1e-9,curve[ddI].dd), dst=pzNiceStep(-ddMin,2), dMin=-Math.ceil(-ddMin/dst)*dst||-dst;
  const x=i=>L+i/(n-1)*pw, y=v=>T+(yMax-v)/(yMax-yMin||1)*EH, DT=T+EH+G, yd=v=>DT+v/dMin*DH;
  const f1=v=>v.toFixed(1);
  const line=curve.map((c,i)=>(i?'L':'M')+f1(x(i))+' '+f1(y(c.cum))).join(' ');
  const fill=line+` L${f1(x(n-1))} ${f1(y(Math.max(yMin,0)))} L${f1(x(0))} ${f1(y(Math.max(yMin,0)))} Z`;
  const area=`M${L} ${DT} `+curve.map((c,i)=>'L'+f1(x(i))+' '+f1(yd(c.dd))).join(' ')+` L${f1(x(n-1))} ${DT} Z`;
  const last=curve[n-1], col=last.cum>=0?PZ_COL.good:PZ_COL.low;
  const yt=[]; for(let v=yMin;v<=yMax+st/2;v+=st)yt.push(v);
  const span=curve[n-1].at-curve[0].at, fmtD=ms=>{ const d=new Date(ms); return span>300*86400000?d.toLocaleString('en-US',{month:'short',year:'2-digit'}):d.toLocaleString('en-US',{month:'short',day:'numeric'}); };
  const nx=Math.max(2,Math.min(6,Math.floor(pw/110))), xt=[]; for(let k=0;k<nx;k++)xt.push(Math.round(k*(n-1)/(nx-1)));
  const lab=(px,py,txt,c,anchor)=>`<text x="${f1(px)}" y="${f1(py)}" font-size="12" font-weight="700" fill="${c}" text-anchor="${anchor||'middle'}" paint-order="stroke" stroke="var(--pz-card)" stroke-width="4">${esc(txt)}</text>`;
  const anc=px=>px<L+60?'start':px>W-R-60?'end':'middle';
  PZ_EQ={curve,byId:byId||null,geo:{W,L,R,T,EH,DT,DH,n,yMin,yMax,dMin}};
  return `<div class="pz-eqwrap" data-pz-eq="1"><svg class="pz-eq" viewBox="0 0 ${W} ${H}" role="img" aria-label="Cumulative P&amp;L over ${n} trades, ending at ${esc(signedPlain(last.cum))}; peak ${esc(signedPlain(curve[hiI].cum))}; deepest drawdown ${esc(signedPlain(curve[ddI].dd))}">
    ${yt.map(v=>`<line x1="${L}" x2="${W-R}" y1="${f1(y(v))}" y2="${f1(y(v))}" stroke="${v===0?'#4A535E':'var(--pz-line)'}"${v===0?' stroke-dasharray="4 4"':''}/><text x="${L-8}" y="${f1(y(v)+4)}" font-size="11" text-anchor="end" fill="var(--pz-muted)">${esc(v===0?'$0':pzSigned(v))}</text>`).join('')}
    <path d="${fill}" fill="${col}" fill-opacity=".08"/>
    <path d="${line}" fill="none" stroke="${col}" stroke-width="2" stroke-linejoin="round"/>
    <circle cx="${f1(x(hiI))}" cy="${f1(y(curve[hiI].cum))}" r="4.5" fill="${PZ_COL.good}" stroke="var(--pz-card)" stroke-width="2"/>
    ${hiI!==n-1?lab(x(hiI),y(curve[hiI].cum)-10,'Peak '+pzSigned(curve[hiI].cum),PZ_COL.good,anc(x(hiI))):''}
    <circle cx="${f1(x(n-1))}" cy="${f1(y(last.cum))}" r="4.5" fill="${col}" stroke="var(--pz-card)" stroke-width="2"/>
    ${lab(x(n-1),y(last.cum)+(hiI===n-1?-10:18),(hiI===n-1?'Peak · now ':'Now ')+pzSigned(last.cum),col,'end')}
    <text x="${L}" y="${DT-8}" font-size="11" font-weight="700" fill="var(--pz-muted)">DRAWDOWN FROM THE RUNNING HIGH</text>
    <line x1="${L}" x2="${W-R}" y1="${DT}" y2="${DT}" stroke="var(--pz-line2)"/>
    <line x1="${L}" x2="${W-R}" y1="${f1(yd(dMin))}" y2="${f1(yd(dMin))}" stroke="var(--pz-line)"/>
    <text x="${L-8}" y="${DT+4}" font-size="11" text-anchor="end" fill="var(--pz-muted)">$0</text><text x="${L-8}" y="${f1(yd(dMin)+4)}" font-size="11" text-anchor="end" fill="var(--pz-muted)">${esc(pzSigned(dMin))}</text>
    <path d="${area}" fill="${PZ_COL.low}" fill-opacity=".38"/>
    <circle cx="${f1(x(ddI))}" cy="${f1(yd(curve[ddI].dd))}" r="4" fill="${PZ_COL.low}" stroke="var(--pz-card)" stroke-width="2"/>
    ${(()=>{ const r=x(ddI)>W/2; /* a trough on the right half labels to its left, so the text stays inside */ return lab(x(ddI)+(r?-8:8),yd(curve[ddI].dd)+4,'Max drawdown '+pzSigned(curve[ddI].dd),PZ_COL.low,r?'end':'start'); })()}
    ${xt.map(i=>`<text x="${f1(x(i))}" y="${H-5}" font-size="11" text-anchor="${i===0?'start':i===n-1?'end':'middle'}" fill="var(--pz-muted)">${esc(fmtD(curve[i].at))}</text>`).join('')}
    <line class="pz-eqx" x1="0" x2="0" y1="${T}" y2="${DT+DH}" stroke="var(--pz-soft)" stroke-width="1" style="display:none"/>
    <circle class="pz-eqd" r="4" fill="var(--pz-text)" style="display:none"/>
  </svg><div class="pz-eqtip" role="status" aria-live="polite" hidden></div></div>
  <p class="pz-fine" style="margin:0">Each step is one closed trade, in order. Hover or drag across the chart to read any point.</p>`;
}
function pzEqHover(ev){
  const w=ev.target.closest&&ev.target.closest('.pz-eqwrap'); if(!w||!PZ_EQ.curve)return;
  const svg=w.querySelector('svg'), r=svg.getBoundingClientRect(), G=PZ_EQ.geo, c=PZ_EQ.curve, s=r.width/G.W;
  const px=(ev.clientX-r.left)/s; if(px<G.L-4||px>G.W-G.R+4){ pzEqLeave(w); return; }
  const i=Math.max(0,Math.min(G.n-1,Math.round((px-G.L)/(G.W-G.L-G.R)*(G.n-1)))), p=c[i], X=G.L+i/(G.n-1)*(G.W-G.L-G.R);
  const Y=G.T+(G.yMax-p.cum)/(G.yMax-G.yMin||1)*G.EH;
  const ln=svg.querySelector('.pz-eqx'), dot=svg.querySelector('.pz-eqd'); ln.setAttribute('x1',X); ln.setAttribute('x2',X); ln.style.display=''; dot.setAttribute('cx',X); dot.setAttribute('cy',Y); dot.style.display='';
  let pk=0; for(let k=0;k<=i;k++)pk=Math.max(pk,c[k].cum);
  const t=PZ_EQ.byId&&p.id?PZ_EQ.byId.get(p.id):null, tip=w.querySelector('.pz-eqtip');
  tip.innerHTML=`<b>${esc(new Date(p.at).toLocaleString('en-US',{month:'short',day:'numeric',year:'numeric'}))}</b> · trade ${i+1} of ${G.n}`
    +(t?`<br>${esc(dispMarket(dcoin(t)))} ${esc(t.dir||'')} <span style="color:${p.net>=0?PZ_COL.good:PZ_COL.low}">${esc(signedPlain(p.net))}</span>`:p.net!=null?`<br>This trade <span style="color:${p.net>=0?PZ_COL.good:PZ_COL.low}">${esc(signedPlain(p.net))}</span>`:'')
    +`<br>Total <b style="color:${p.cum>=0?PZ_COL.good:PZ_COL.low}">${esc(signedPlain(p.cum))}</b>`
    +`<br>${p.dd<0?`Down <b style="color:${PZ_COL.low}">${esc(signedPlain(p.dd))}</b> from the high${pk>0?' ('+Math.round(-p.dd/pk*100)+'%)':''}`:'<span style="color:'+PZ_COL.good+'">At a new high</span>'}`;
  tip.hidden=false; const left=X*s, tw=tip.offsetWidth; tip.style.left=Math.max(0,Math.min(r.width-tw,left-tw/2))+'px'; tip.style.top=Math.max(0,Y*s-tip.offsetHeight-14)+'px';
}
function pzEqLeave(w){ if(!w)return; const svg=w.querySelector('svg'); svg.querySelector('.pz-eqx').style.display='none'; svg.querySelector('.pz-eqd').style.display='none'; w.querySelector('.pz-eqtip').hidden=true; }
document.addEventListener('pointermove',pzEqHover,{passive:true});
document.addEventListener('pointerdown',pzEqHover,{passive:true});
document.addEventListener('pointerleave',ev=>{ const w=ev.target&&ev.target.closest&&ev.target.closest('.pz-eqwrap'); if(w)pzEqLeave(w); },true);
// Hover (or keyboard focus) on anything with data-pz-tip shows what it means: badges above all.
// One floating box, kept inside the screen; on a phone the badge's own info card does the job.
function pzTipShow(el){ const txt=el.getAttribute('data-pz-tip'); if(!txt)return; let box=document.getElementById('pzTip');
  if(!box){ box=document.createElement('div'); box.id='pzTip'; box.className='pz-tipbox'; box.setAttribute('role','tooltip'); document.body.appendChild(box); }
  _pzTipEl=el; const [head,...rest]=txt.split('\n'); box.innerHTML='<b>'+esc(head)+'</b>'+(rest.length?'<br>'+rest.map(esc).join('<br>'):''); box.hidden=false;
  const r=el.getBoundingClientRect(), bw=box.offsetWidth, bh=box.offsetHeight;
  let x=r.left+r.width/2-bw/2, y=r.top-bh-8; if(y<8)y=r.bottom+8;
  box.style.left=Math.max(8,Math.min(innerWidth-bw-8,x))+'px'; box.style.top=Math.max(8,Math.min(innerHeight-bh-8,y))+'px'; }
function pzTipHide(){ const box=document.getElementById('pzTip'); if(box)box.hidden=true; _pzTipEl=null; }
var _pzTipEl=null;
const PZ_VIZ='.pz-viz,.pz-chart,.pz-div,.pz-session,.pz-snapsvg';
// no hover on a phone: a tap on a chart mark shows what it means, a tap anywhere else hides it
document.addEventListener('pointerdown',ev=>{ if(ev.pointerType==='mouse')return; const el=ev.target.closest&&ev.target.closest('[data-pz-tip]');
  if(el&&el.closest(PZ_VIZ)){ pzTipShow(el); _pzTapAt=Date.now(); } else pzTipHide(); },{passive:true});
var _pzTapAt=0;
document.addEventListener('pointerover',ev=>{ if(ev.pointerType!=='mouse')return; const el=ev.target.closest&&ev.target.closest('[data-pz-tip]'); if(el)pzTipShow(el); },{passive:true});
document.addEventListener('pointerout',ev=>{ if(ev.pointerType&&ev.pointerType!=='mouse')return; /* a lifted finger "leaves" too; a tap elsewhere closes it */ const el=ev.target.closest&&ev.target.closest('[data-pz-tip]'); if(el&&!el.contains(ev.relatedTarget))pzTipHide(); },{passive:true});
document.addEventListener('focusin',ev=>{ const el=ev.target.closest&&ev.target.closest('[data-pz-tip]'); if(el&&el.matches(':focus-visible'))pzTipShow(el); else if(el!==_pzTipEl)pzTipHide(); });
document.addEventListener('focusout',ev=>{ const to=ev.relatedTarget; if(Date.now()-_pzTapAt<500||(_pzTipEl&&to&&_pzTipEl.contains(to)))return; pzTipHide(); }); // the blur a tap causes doesn't close the tip it just opened
addEventListener('scroll',pzTipHide,{passive:true,capture:true}); addEventListener('hashchange',pzTipHide); // a fixed tip would float off its mark
// Midnight (on the app's clock) of the first day of an n-day range ending today — calendar
// days, not 24-hour steps, so a daylight-saving change doesn't shift the window by an hour.
function pzRangeStart(n, now){ const p=tzParts(now); return settings.tz==='utc'?Date.UTC(p.y,p.mo,p.day-(n-1)):new Date(p.y,p.mo,p.day-(n-1)).getTime(); }
function pzDeepHtml(D){
  const {g}=D, ctx=g.ctx, R=pzS.range, now=Date.now();
  const fromMs=R==='all'?0:pzRangeStart(R,now), fromKey=R==='all'?'0000':dayKey(fromMs);
  const back=`<a class="pz-back" href="#trends">${pzI('back',20)}Stats</a>`;
  const dlock=pzLocked('deep',g.level.level); if(dlock)return back+pzLockedHtml('In-depth stats',dlock,g);
  const seg=`<div class="pz-seg" role="group" aria-label="Range">${[[7,'7D'],[30,'30D'],[90,'90D'],['all','All']].map(([n,l])=>`<button type="button" data-pz-range="${n}" aria-pressed="${n===R}">${l}</button>`).join('')}</div>`;
  const head=`${back}${pzHead(R==='all'?'All time':'Last '+R+' days','In-depth stats',seg)}${pzMkSeg()}`;
  const tr=ctx.closed.filter(t=>t.closeTime>=fromMs&&pzInMk(t));
  const X=pzDeepStats(tr,{isWin,isLoss,coin:dcoin,hourOf:tzHour,dowOf:tzDow,monthOf:ms=>dayKey(ms).slice(0,7),
    setupOf:t=>journal[t.id]&&journal[t.id].setup?String(journal[t.id].setup).trim():null,ratingOf:t=>journal[t.id]&&+journal[t.id].rating||null,
    volOf:t=>{ const r=pzRegimeOf(t.openTime||t.closeTime); return r&&r.vol; },trendOf:t=>{ const r=pzRegimeOf(t.openTime||t.closeTime); return r&&r.trend; }});
  pzRegimeWant();
  if(!X)return `${head}<section class="pz-card"><p class="pz-sub">No closed trades in this range.</p></section>`;
  const s=computeStats(tr,tr);
  const hr=h=>String(h).padStart(2,'0')+':00';
  // results, risk, consistency
  const results=pzKv('Results',[
    ['Net P&L',pzMoney(s.net),pzSignCol(s.net)],['Trades',s.n+' · '+s.wins+' W · '+s.losses+' L'+(s.breakeven?' · '+s.breakeven+' even':'')],
    ['Win rate',pzPct(s.winRate),null,'Wins ÷ (wins + losses); break-even trades are left out'],
    ['Win rate you need to break even',pzPct(s.breakevenWR),null,'Given your average win and loss: avg loss ÷ (avg win + avg loss)'],
    ['Average trade',pzMoney(s.expectancy),pzSignCol(s.expectancy)],['Median trade',pzMoney(s.median),pzSignCol(s.median),'Half your trades did better than this, half worse'],
    ['Average win / loss',pzShort(s.avgWin)+' / '+pzShort(s.avgLoss)],['Payoff ratio',pzRatio(s.payoff),null,'Average win ÷ average loss'],
    ['Profit factor',pzRatio(s.profitFactor),null,'Money won ÷ money lost'],['Best / worst trade',pzMoney(X.best)+' / '+pzMoney(X.worst)],
    s.rCount?['Average R',(s.avgR>=0?'+':'')+s.avgR.toFixed(2)+'R · '+s.rCount+' trades with risk set',null,'Result ÷ the risk you set for the trade']:null]);
  const risk=pzKv('Risk',[
    ['Max drawdown',X.maxDD<0?pzMoney(X.maxDD):'None',X.maxDD<0?PZ_COL.low:null,'Biggest drop from a running high in cumulative P&L'],
    X.ddFrom?['Drawdown ran',dayLabel(dayKey(X.ddFrom))+' → '+dayLabel(dayKey(X.ddTo))]:null,
    s.maxDDpct!=null?['Deepest drop as % of the high before it',pzPct(s.maxDDpct),null,'The largest percentage fall from a running high — it can be a different, earlier dip than the biggest dollar drawdown']:null,
    ['Longest losing run',X.streaks.bestL+' trade'+(X.streaks.bestL===1?'':'s')],['Longest winning run',X.streaks.bestW+' trade'+(X.streaks.bestW===1?'':'s')],
    ['Current run',X.streaks.current>0?X.streaks.current+' win'+(X.streaks.current===1?'':'s'):X.streaks.current<0?(-X.streaks.current)+' loss'+(X.streaks.current===-1?'':'es'):'—'],
    s.sharpe!=null?['Sharpe (yearly)',s.sharpe.toFixed(2)+(s.sharpeLo!=null?' · likely '+s.sharpeLo.toFixed(1)+' to '+s.sharpeHi.toFixed(1):''),null,'Daily net P&L, annualised, with a 95% range — a wide range means too little history to tell']:null,
    s.sortino!=null&&isFinite(s.sortino)?['Sortino (yearly)',s.sortino.toFixed(2),null,'Like Sharpe, but only down days count as risk']:null,
    ['Fees',pzMoney(-s.fees),PZ_COL.low],['Funding',pzMoney(s.fund||0),pzSignCol(s.fund||0)],
    s.volume?['Volume traded',pzShort(s.volume)]:null]);
  const cons=pzKv('Consistency',[
    ['Green days',s.greenDays+' of '+s.totalDays],
    ['Typical hold: winners',X.holdW?fmtDur(X.holdW):'—'],['Typical hold: losers',X.holdL?fmtDur(X.holdL):'—'],
    X.after.loss.n>=5?['Next trade after a loss',pzPct(X.after.loss.winRate)+' win rate · avg '+pzMoney(X.after.loss.avg),pzSignCol(X.after.loss.avg),'The trade you open after a losing one — tilt shows up here']:null,
    X.after.win.n>=5?['Next trade after a win',pzPct(X.after.win.winRate)+' win rate · avg '+pzMoney(X.after.win.avg),pzSignCol(X.after.win.avg)]:null]);
  const eq=`<section class="pz-card pz-span pz-kv"><div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px"><b class="pz-kvh">Equity curve</b><span class="pz-sub" style="font-size:12px">${s.n} trades · ${esc(pzSigned(X.curve[X.curve.length-1].cum))}</span></div>${pzEquitySvg(X.curve,new Map(tr.map(t=>[t.id,t])))}</section>`;
  // what the slips cost
  const sc=pzSlipCost(g.days.filter(d=>d.key>=fromKey));
  const slips=Object.keys(PZ_BEH).filter(k=>sc.by[k]);
  const slipHtml=pzKv('What your slips cost',[
    ['Clean trades',sc.cleanN+' · avg '+pzMoney(sc.cleanAvg),pzSignCol(sc.cleanAvg)],
    ['Trades with a slip',sc.slipN+' · avg '+pzMoney(sc.slipAvg),pzSignCol(sc.slipAvg)],
    ...slips.map(k=>[PZ_BEH[k],sc.by[k].n+' · '+pzMoney(sc.by[k].net),pzSignCol(sc.by[k].net)])],
    (sc.slipN?'Each trade with one of the six Discipline slips, and what those trades made or lost in total. A trade can have more than one slip.':'No slips in this range — every closed trade was clean.')
      +(X.partial?' '+X.partial+' trade'+(X.partial===1?' was':'s were')+' cut off at the start of your history and aren’t judged.':''));
  // plan vs execution
  const pa=planAdherence(tr,journal,_excM), pd=g.days.filter(d=>d.key>=fromKey&&d.parts);
  const dp=pd.filter(d=>d.parts.plan!=null), lim=pd.filter(d=>d.parts.limit!=null), rl=pd.filter(d=>d.parts.rules!=null);
  const planRows=[
    dp.length?['Day plan before the first trade',dp.filter(d=>d.parts.plan===1).length+' of '+dp.length+' days'+(dp.some(d=>d.parts.plan===0.5)?' · '+dp.filter(d=>d.parts.plan===0.5).length+' written late':'')]:null,
    lim.length?['Stayed inside the loss limit',lim.filter(d=>!d.breached).length+' of '+lim.length+' days with a limit']:null,
    lim.some(d=>d.breached)?['Stopped once the limit was hit',lim.filter(d=>d.breached&&d.parts.limit===1).length+' of '+lim.filter(d=>d.breached).length+' days you hit it',null,'No new trade opened after the day’s losses reached the limit']:null,
    rl.length?['Trades within your rules',pzPct(rl.reduce((a,d)=>a+d.parts.rules*d.n,0)/Math.max(1,rl.reduce((a,d)=>a+d.n,0)))]:null,
    pa.n?['Trades with a written stop',pa.n+' of '+s.n+(pa.liveN||pa.hindsightN?' · '+pa.liveN+' written while open':'')]:null,
    pa.n?['Stops honored',pzPct(pa.stopHonoredRate)+(pa.heldThroughN?' · '+pa.heldThroughN+' held through the stop':''),null,'Exit at or before the stop; with price data, price trading past the stop while you held also counts as broken']:null,
    pa.n&&pa.brokeStopCost?['Trades that broke their stop',pzMoney(pa.brokeStopCost),pzSignCol(pa.brokeStopCost)]:null,
    pa.targetHitRate!=null?['Targets reached',pzPct(pa.targetHitRate)]:null,
    pa.medPlannedRR!=null?['Planned reward : risk (median)',pa.medPlannedRR.toFixed(2)+' : 1']:null,
    pa.medRealizedR!=null?['Realized, in units of planned risk',(pa.medRealizedR>=0?'+':'')+pa.medRealizedR.toFixed(2)+'R',pzSignCol(pa.medRealizedR)]:null];
  const planHtml=!planRows.some(Boolean)?'':pzKv('Plan vs execution',planRows,
    dp.length||lim.length||pa.n?'Checked against the numbers you wrote, not by AI: your day plan’s time against your first entry, your loss limit against the day’s realized P&L, and each trade’s stop and target against its actual exit.'
      :'Nothing to compare yet. Write a day plan and loss limit in Prep, or a stop and target on trades in the full journal, and this shows how closely you followed them.');
  // breakdowns
  const DN=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const hours=Array.from({length:24},(_,h)=>X.hours.find(r=>r.k===h)||{k:h,n:0,net:0});
  const hourHtml=`<section class="pz-card pz-span pz-kv"><b class="pz-kvh">Time of day</b>${pzDivBars(hours.map(r=>({v:r.net,l:r.k%6===0?String(r.k):'',tip:hr(r.k)+' · '+r.n+' trade'+(r.n===1?'':'s')+(r.n?' · '+signedPlain(r.net):'')})),110)}<p class="pz-fine">Net P&L by entry hour, on your ${settings.tz==='utc'?'UTC':'local'} clock.</p></section>`;
  const dowHtml=`<section class="pz-card pz-kv"><b class="pz-kvh">Day of the week</b>${pzDivBars(X.dow.map(r=>({v:r.net,l:DN[r.k].slice(0,2),tip:DN[r.k]+' · '+r.n+' trades · '+signedPlain(r.net)})),90)}</section>`;
  const distHtml=X.dist.length?`<section class="pz-card pz-kv"><b class="pz-kvh">How your trades land</b>${pzRows(X.dist.filter(b=>b.kind!=='even'||b.n).map(b=>({label:b.kind==='even'?'About even':b.kind==='loss'?(b.hi===Infinity?'Lost more than '+pzShort(b.lo):'Lost '+pzShort(b.lo)+'–'+pzShort(b.hi)):(b.hi===Infinity?'Made more than '+pzShort(b.lo):'Made '+pzShort(b.lo)+'–'+pzShort(b.hi)),
      value:b.n+' trade'+(b.n===1?'':'s'),pct:b.n/s.n,color:b.kind==='loss'?PZ_COL.low:b.kind==='even'?'#5A6470':PZ_COL.good})),PZ_COL.good)}<p class="pz-fine">Steps are your typical trade (${esc(pzShort(X.absMed))}). A few big losses at the top of this list cost more than many small ones.</p></section>`:'';
  const exc=tr.map(t=>_excM[t.id]).filter(e=>e&&e.maePct!=null);
  const excHtml=exc.length>=10?(()=>{ const Wn=tr.filter(t=>isWin(t.net)&&_excM[t.id]&&_excM[t.id].maePct!=null), Ls=tr.filter(t=>isLoss(t.net)&&_excM[t.id]&&_excM[t.id].maePct!=null);
      const m=(a,k)=>a.length?nfMedian(a.map(t=>_excM[t.id][k])):null, f=v=>v==null?'—':v.toFixed(2)+'%';
      return pzKv('Price excursions',[['Winners: worst point against you',f(m(Wn,'maePct')),null,'Median, as % of entry price'],['Winners: best point',f(m(Wn,'mfePct'))],['Losers: worst point',f(m(Ls,'maePct'))],['Losers: best point before turning',f(m(Ls,'mfePct')),null,'How far losers went your way before they lost']],exc.length+' trades measured from candles. Measure more in the full journal.'); })():'';
  const tagged=X.setups.reduce((a,r)=>a+r.n,0), rated=X.ratings.reduce((a,r)=>a+r.n,0);
  const tagHint=!X.setups.length||!X.ratings.length?`<p class="pz-fine">Tag setups and rate your executions in the journal to see results ${!X.setups.length&&!X.ratings.length?'by setup and by rating':!X.setups.length?'by setup':'by rating'} here.</p>`:'';
  // one breakdown card with a switcher instead of seven tables in a row
  const BK=[['market','Market',X.markets,r=>dispMarket(r.k),''],['side','Long / short',X.side,r=>r.k,''],
    ['size','Size',X.bySize,r=>r.label+' · '+pzShort(r.from)+'–'+pzShort(r.to),'A quarter of your trades each, smallest to biggest. Position size is the largest notional the trade reached.'],
    ['hold','Hold time',X.byHold,r=>r.label,''],['month','Month',X.months,r=>MONTHS[+r.k.slice(5)-1]+' '+r.k.slice(0,4),''],
    ['setup','Setup',X.setups,r=>r.label||r.k,tagged+' of '+s.n+' trades tagged. Tag the rest in the journal — chips keep one spelling per setup.'],
    ['rating','Your rating',X.ratings,r=>'★'.repeat(r.k)+' '+r.k,rated+' rated trades. Rating is how well you executed, not how it paid — if 5s don’t beat 2s, your idea of a good trade needs a look.'],
    ['vol','Volatility',X.vol,r=>PZ_VOL[r.k],'How wild BTC was on the day you entered: its high–low range against its previous 30 days.'],
    ['trend','Trend',X.trend,r=>PZ_TREND[r.k],'How cleanly BTC moved over the 7 days to your entry: a trend goes one way, chop goes nowhere.']].filter(x=>x[2].length);
  const bk=BK.find(x=>x[0]===pzS.bk)||BK[0];
  const breakdown=bk?`<div class="pz-span pz-kv"><div class="pz-chiprow" role="group" aria-label="Break down by">${BK.map(x=>`<button type="button" class="pz-chipbtn" data-pz-bk="${x[0]}" aria-pressed="${x===bk}">${esc(x[1])}</button>`).join('')}</div>
    ${(()=>{ const ins=bk[0]==='vol'?pzRegimeInsight(X.vol,PZ_VOL):bk[0]==='trend'?pzRegimeInsight(X.trend,PZ_TREND):null; return ins?`<section class="pz-card pz-coach"><span class="pz-ico">${pzI('bolt',18)}</span><p>${esc(ins.text)}</p></section>`:''; })()}
    ${pzTbl('By '+bk[1].toLowerCase(),bk[2],bk[3],bk[4]||undefined)}${tagHint}</div>`:'';
  return `${head}<div class="pz-wide">${eq}<div class="pz-col">${results}${cons}${slipHtml}</div><div class="pz-col">${risk}${planHtml}${distHtml}${pzCostHtml(tr)}</div>${hourHtml}${excHtml?`<div class="pz-col">${dowHtml}</div><div class="pz-col">${excHtml}</div>`:dowHtml.replace('pz-card pz-kv','pz-card pz-span pz-kv')}${breakdown}
    <section class="pz-span" style="display:flex;flex-wrap:wrap;gap:16px;justify-content:center"><a class="pz-link" href="#how">How the scores are worked out ›</a><a class="pz-link" style="white-space:normal;text-align:center" href="${esc(pzFullHref())}">Pattern miner, excursions and Diagnostic in the full journal ›</a></section></div>`;
}
function pzHowHtml(){
  const back=`<a class="pz-back" href="#trends">${pzI('back',20)}Stats</a>`;
  const sec=(t,html)=>`<section class="pz-card pz-kv pz-how"><b class="pz-kvh">${esc(t)}</b>${html}</section>`;
  return `${back}${pzHead('Plain arithmetic, no AI','How the scores work')}<div class="pz-wide"><div class="pz-col">
    ${sec('Discipline · 0–100',`<p>The share of the day’s closed trades with none of six slips, read from your fills — nothing to log. 3 of 4 clean trades = 75.</p><ul>
      <li><b>Revenge entry:</b> opened within 15 minutes of closing a loss.</li><li><b>Trading on after two losses:</b> a third trade the same day after two losing ones in a row.</li>
      <li><b>Sizing up after a loss:</b> within 2 hours of a loss, a position over 1.5× your median size of your last 30 trades.</li><li><b>Adding to a loser:</b> adding to a position (buying more on a long, selling more on a short) while it was under water.</li>
      <li><b>Overtrading:</b> trades past 1.5× your usual number per day (median of the 30 trading days before; at least 3).</li><li><b>Holding a loser:</b> a losing trade held over 3× your usual winner’s hold.</li></ul>
      <p>“Usual” only uses trades closed before that day’s first entry, so a day is never judged against itself. A loss means losing more than $1. Profit never counts. The server recomputes this same score from public fills for the leaderboard.</p>`)}
    ${sec('Form · 50 is your usual',`<p>Your recent trades against your own earlier ones. Recent = the last 7 days if they hold 5+ trades, else your last 5 trades; the baseline is up to 90 trades before that.</p>
      <p>Form = 50 + 20 × (difference in average trade ÷ your typical result, the median size of a win or loss, capped at ±1.5) + 40 × (difference in win rate, capped at ±0.5) − 20 × (how far below your 30-day high you are, in units of 5 typical results, capped at 1). Needs 15 closed trades, at least 10 of them before the recent window, and a trade in the last 30 days.</p>`)}
    ${sec('Load · 50 is a usual day',`<p>Today against your usual trading day (median of the last 30 days you traded): trades opened, and total size traded. Load = 50 × the larger of the two ratios, up to 100. 1.0× usual reads 50; twice your usual reads 100. Needs 5 earlier trading days.</p>`)}
    ${sec('Tilt · 65 turns on quiet mode',`<p>Today’s triggers, added up: losses in a row (9 for one, 21 for two, 30 for three or more), a loss in the last 15 minutes (20; 10 up to 30 minutes), entries at 1.5× your usual size (15; 8 from 1.2×), four entries in an hour (15; 9 for three, or for twice your usual number of trades), your risk budget three quarters used (6; 10 when spent) and readiness under 40 (10; 5 under 60). Profit plays no part.</p>
      <p>From 35 it reads “heating up”; at 65 a new loss or entry opens quiet mode. One break or “I’m calm” covers that episode.</p>`)}
    ${sec('Market conditions · from BTC',`<p>Each UTC day, from BTC’s daily candle: <b>volatile</b> when its high–low range is 1.4× the median of the 30 days before, <b>quiet</b> at 0.7× or less. <b>Trending</b> when the 7-day net move is at least half the sum of the daily moves, <b>choppy</b> at a quarter or less.</p>`)}
    </div><div class="pz-col">
    ${sec('Readiness · from your prep',`<p>Your 1–5 answers: sleep counts 40%, calm 20%, focus 40%. All 5s = 100. It never changes your Discipline score; Stats shows whether your discipline is better on high-readiness days.</p>`)}
    ${sec('XP and levels',`<p>Each trading day earns its Discipline score in XP (up to 100), plus optional bonus XP: morning prep 10, a plan before your first trade 15 (half if written after), today’s trades journaled 15, stops written while trades were open 10, respecting your loss limit (nothing new opened after hitting it) 10. Plus 50 per achievement, 150 per weekly challenge kept, 25 per focus-habit day. Logging only ever adds.</p>
      <p>Level n starts at 200 × n × (n − 1) XP: level 2 at 400, 3 at 1,200, 4 at 2,400, 5 at 4,000.</p>`)}
    ${sec('Streak and shields',`<p>Consecutive trading days scoring 70+. Days you don’t trade never break it. A finished perfect week (every trading day 70+, at least three) earns a shield, two at most; a shield absorbs one off day.</p>`)}
    ${sec('Plan vs execution',`<p>Checked against the numbers you wrote, not judged by AI: a day plan’s time against your first entry; your loss limit against the day’s realized P&L (opening anything after hitting it counts as breaking it); each trade’s stop and target against its actual exit, and, where candles were measured, whether price traded through the stop while you held.</p>
      <p>The only AI is an optional weekly letter in the full journal (the owner switches it on with COACH_AI). It gets an aggregate summary — no individual trades, trade notes or addresses, but your habit sentences and your last two written weekly lessons — and is told to use only the numbers the app computed.</p>`)}
    </div></div>`;
}





function pzCheckinInit(D){
  if(pzS.ck&&pzS.ck.key===D.todayK)return pzS.ck;
  const e=D.dayE||{}, R=nfRules();
  pzS.ck={key:D.todayK,sleep:+e.sleep||null,calm:+e.stress?6-e.stress:null,focus:+e.focus||null,
    maxTrades:+e.maxTrades||+R.maxPerDay||null,maxLoss:e.maxLoss>0?e.maxLoss:'',plan:e.plan||'',
    rules:JSON.parse(JSON.stringify(e.rules||{})),am:Object.assign({},e.am||{})};
  return pzS.ck;
}
// the readiness the check-in shows: today's wearable score when there is one, else the answers
function pzCkReady(ck){ const w=((journal['day:'+ck.key]||{}).wear)||null; return pzReadiness({sleep:ck.sleep,stress:ck.calm?6-ck.calm:null,focus:ck.focus,wear:w}); }
function pzCheckinHtml(D){
  const ck=pzCheckinInit(D), r=pzCkReady(ck), b=pzBand(r);
  const opened=D.risk.trades>0;
  const Q=[['sleep','How did you sleep?','Badly','Great'],['calm','How calm do you feel?','Wired','Calm'],['focus','How focused are you?','Scattered','Locked in']];
  const q=Q.map(([k,t,lo,hi])=>`<div role="radiogroup" aria-labelledby="pzq_${k}"><p class="pz-q" id="pzq_${k}">${t}</p><div class="pz-pills">${[1,2,3,4,5].map(n=>`<button type="button" role="radio" class="pz-pill" data-pz-ck="${k}" data-n="${n}" aria-checked="${ck[k]===n}" aria-label="${n} of 5">${n}</button>`).join('')}</div><div class="pz-ends"><span>${lo}</span><span>${hi}</span></div></div>`).join('');
  return `${pzHead(dayLabel(D.todayK),'Prep')}
  <p class="pz-sub" style="margin-top:-6px">Thirty seconds. It sets your readiness and today’s limits.</p>
  ${pzMorningHtml(D,ck)}
  <div class="pz-wide">
    <div class="pz-col"><section class="pz-card" id="pzCkPrev" style="display:flex;align-items:center;gap:16px" aria-live="polite">${pzCkPrevHtml(r,b)}</section>${pzWearHtml(D)}${q}</div>
    <div class="pz-col">
      <section class="pz-card" style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 10px 10px 16px"><span><b style="font-size:15px">Trade cap today</b><br><span class="pz-sub" style="font-size:12px">The risk dial counts against it</span></span>
        <span class="pz-step"><button type="button" data-pz-cap="-1" aria-label="One fewer trade">${pzI('minus',18,2.4)}</button><output id="pzCap" aria-live="polite">${ck.maxTrades||'—'}</output><button type="button" data-pz-cap="1" aria-label="One more trade">${pzI('plus',18,2.4)}</button></span></section>
      <div class="pz-field"><label for="pzLoss">Stop for the day at a loss of ($)</label><input type="number" id="pzLoss" inputmode="decimal" min="0" step="any" value="${ck.maxLoss?esc(ck.maxLoss):''}" placeholder="${nfRules().dailyLossLimit>0?'standing limit '+usdPlain(nfRules().dailyLossLimit):'e.g. 400'}"></div>
      ${pzRulesFormHtml(ck)}
      <div class="pz-field"><label for="pzPlan">One-line plan</label><textarea id="pzPlan" rows="2" placeholder="Only A+ setups at the open. Stop after two losses.">${esc(ck.plan)}</textarea></div>
      <button type="button" class="pz-cta" id="pzCkSave">Lock in my day <span class="pz-xpb">+${pzXpCfg().checkin+(opened?Math.round(pzXpCfg().plan/2):pzXpCfg().plan)} XP</span></button>
      <p class="pz-fine">All optional — your dials work without it. On a trading day your prep earns +${pzXpCfg().checkin} XP; a plan or loss limit saved before your first trade earns +${pzXpCfg().plan}${opened?' (you’ve already traded today, so a plan now earns half — tomorrow, prep first)':''}.</p>
    </div>
  </div>`;
}
function pzCkPrevHtml(r,b){
  const txt=r==null?'Tap how you slept, how calm you feel and how focused you are.':b==='good'?'You’re set up well. Normal size, same rules.':b==='mid'?'Start at half size until your first good setup works.':'Low tank. A rest day or paper trades is a winning move.';
  return `${pzRing(r==null?'—':r,(r||0)/100,PZ_COL[b],{size:88})}<span style="display:flex;flex-direction:column;gap:4px"><span class="pz-lbl" style="color:${r==null?'var(--pz-muted)':PZ_COL[b]}">Readiness${r==null?'':' · '+(b==='good'?'Ready':b==='mid'?'Steady':'Low')}</span><span style="font-size:14px;line-height:1.4;color:var(--pz-soft)">${txt}</span></span>`;
}
async function pzSaveCheckin(){
  const ck=pzS.ck; if(!ck)return;
  const k='day:'+ck.key, prev=journal[k]||{};
  const loss=parseFloat(ck.maxLoss);
  const R=ck.rules||{}, rules={};
  if(Array.isArray(R.setups)&&R.setups.length)rules.setups=R.setups.slice(0,12);
  if(/^\d{2}:\d{2}$/.test(R.until||''))rules.until=R.until; if(R.maxPos>0)rules.maxPos=R.maxPos;
  if(R.lossStreak>1)rules.lossStreak=Math.min(5,Math.round(R.lossStreak)); else if(R.stop2&&R.lossStreak==null)rules.lossStreak=2;
  if([15,30,60].includes(+R.wait))rules.wait=+R.wait; if(R.noAdd)rules.noAdd=true;
  const am={}; for(const q in (ck.am||{}))if(String(ck.am[q]).trim())am[q]=String(ck.am[q]).trim().slice(0,500);
  const e={...prev, sleep:ck.sleep||null, stress:ck.calm?6-ck.calm:null, focus:ck.focus||null,
    plan:String(ck.plan||'').trim(), maxLoss:loss>0?loss:null, maxTrades:ck.maxTrades>0?ck.maxTrades:null,
    rules:Object.keys(rules).length?rules:null, am:Object.keys(am).length?am:null};
  delete e.updatedAt; delete e.plannedAt;
  const nx=nextDayEntry(prev,e,Date.now());
  if(!nx)delete journal[k]; else journal[k]=nx;
  markJEdit(k); await Store.set(J_KEY,journal);
  if(e.maxLoss>0)askNotifyPerm();
  renderTripwire();
  pzNote('Locked in. Go trade your plan.');
  if(location.hash!=='#today')location.hash='#today'; else pzRender();
}

function pzJournalHtml(D){
  const jpg=pzPage('journal',D.inbox,6), list=jpg.items, setups=pzSetups().slice(0,8);
  const back=`<a class="pz-back" href="#today">${pzI('back',20)}Today</a>`;
  if(!list.length)return `${back}${pzHead('Journal','All caught up')}<p class="pz-sub">Every trade from the last 30 days has a note, a setup or a rating. That’s the habit — keep it going.</p>`;
  const card=t=>{ const r=pzS.jr[t.id]||0, q=tradeQuestion(t,journal[t.id],_excM[t.id]).q;
    const p=tzParts(t.closeTime);
    return `<section class="pz-card pz-trade" data-pz-trade="${esc(t.id)}"><div class="pz-trade-h"><b>${esc(dispMarket(dcoin(t)))} ${esc(String(t.dir||'').toLowerCase())}</b><span style="font-family:var(--pz-num);font-size:20px;font-weight:600;color:${isBE(t.net)?'var(--pz-soft)':t.net>=0?PZ_COL.good:PZ_COL.low}">${isBE(t.net)?'B/E':signedPlain(t.net)}</span></div>
      <span class="pz-sub" style="font-size:12px">${esc(dayLabel(dayKey(t.closeTime)))} · ${String(p.h).padStart(2,'0')}:${String(p.min).padStart(2,'0')}</span>
      <div class="pz-snap" data-pz-snap="${esc(t.id)}">${pzSnapHtml(t)}</div>${planPzRpHtml(t)}
      <div role="radiogroup" aria-label="How well did you execute it, 1 to 5"><div class="pz-stars">${[1,2,3,4,5].map(n=>`<button type="button" role="radio" data-pz-rate="${n}" aria-checked="${r===n}" aria-label="${n} of 5">${n}</button>`).join('')}</div></div>
      <input type="text" id="pzSetup_${esc(t.id)}" aria-label="Setup" placeholder="Setup (breakout, fade, retest…)" autocomplete="off">
      ${setups.length?`<div class="pz-chiprow pz-wrapr" aria-label="Your setups">${setups.map(x=>`<button type="button" class="pz-chipbtn" data-pz-setupchip="${esc(x)}">${esc(x)}</button>`).join('')}</div>`:''}
      <textarea id="pzNoteT_${esc(t.id)}" rows="2" aria-label="${esc(q)}" placeholder="${esc(q)}"></textarea>
      <div style="display:flex;gap:8px"><button type="button" class="pz-ghost" data-pz-jsave style="flex:1">Save</button>${SOC.me&&!pzS.demo&&!(SOC.cfg&&SOC.cfg.posts&&!SOC.cfg.posts.on)?`<button type="button" class="pz-ghost" data-soc-share="${esc(t.id)}">Share</button>`:''}${mrCanShare()?`<button type="button" class="pz-ghost" data-mr-share="${esc(t.id)}">Ask mentor</button>`:''}</div></section>`; };
  return `${back}${pzHead(D.inbox.length+' to journal','Journal')}<p class="pz-sub" style="margin-top:-6px">Rate how well you executed each trade, not how it paid. One line is enough.</p>
    <div class="pz-jgrid">${list.map(card).join('')}</div>${jpg.html}`;
}
async function pzSaveJournal(sec){
  const id=sec.dataset.pzTrade, rating=pzS.jr[id]||0;
  const setup=(sec.querySelector('input[type=text]')||{value:''}).value.trim(), note=(sec.querySelector('textarea')||{value:''}).value.trim();
  if(!rating&&!setup&&!note){ pzNote('Pick a rating or write a line first.','err'); return; }
  const t=allTrades.find(x=>x.id===id)||{};
  const j=ensureJ(id); if(setup)j.setup=pzCanonSetup(setup); if(rating)j.rating=rating; // one spelling per setup, so stats by setup add up
  if(note){ const q=tradeQuestion(t,j,_excM[id]).q; j.notes=(j.notes?j.notes+'\n\n':'')+q+'\n'+note; }
  delete pzS.jr[id]; markJEdit(id); await Store.set(J_KEY,journal);
  pzNote('Saved.'); pzRender();
}


// ---- first run, loading, empty ----
// The first-run screen: what Pulse is on one side, connecting your trades on the other
function pzWelcomeHero(){
  const dial=(v,pct,col,l)=>`<div>${pzRing(esc(v),pct,col,{size:76})}<span>${l}</span></div>`;
  return `<section class="pz-wl-hero"><div class="pz-wl-brand">${pzRing('',0.72,'var(--pz-acc)',{size:30})}<b>Keel</b></div>
    <h1>Know when to trade.<br><span>And when to stop.</span></h1>
    <p class="pz-wl-lede">Keel reads your own fills on Hyperliquid, Lighter, Bybit or Binance and turns them into three dials for your trading day.</p>
    <div class="pz-wl-dials" aria-hidden="true">${dial('78',0.78,'var(--pz-good)','Readiness')}${dial('84',0.84,'var(--pz-xp)','Discipline')}${dial('Low',0.28,'var(--pz-risk)','Risk')}</div>
    <ul class="pz-wl-points"><li>${pzI('check',16,2.4)}Two minutes of prep before the open</li><li>${pzI('check',16,2.4)}Revenge trades, size-ups and overtrading caught as they happen</li><li>${pzI('check',16,2.4)}One-line journaling, and how you compare with traders like you</li></ul></section>`;
}
function pzConnectHtml(){
  const synced=SRV.enabled&&(!SRV.needsAuth||(SRV.token&&!SRV.badAuth));
  const tokenAsk=SRV.enabled&&SRV.needsAuth&&(!SRV.token||SRV.badAuth);
  const busy=_loading;
  const err=pzS.note&&pzS.note.kind==='err'?pzS.note.m:'';
  const errHtml=err?`<p class="pz-fine pz-err" role="alert">${esc(err)}</p>`:'';
  if(acctWantsUnlock()&&SOC.cfg&&SOC.cfg.enabled)return `<div class="pz-welcome">${pzWelcomeHero()}<section class="pz-wl-card">${acctConnectHtml()}${errHtml}</section></div>`;
  const link=pzLinkCardHtml(), cex=!!pzS.cex;
  return `<div class="pz-welcome">${pzWelcomeHero()}
    <section class="pz-wl-card" aria-labelledby="pzWlT">${link}
    <h2 id="pzWlT">Connect your trades</h2>
    <div class="pz-seg full" role="group" aria-label="Where you trade"><button type="button" data-pz-cexoff aria-pressed="${!cex}">Wallet address</button><button type="button" data-pz-cex="${esc(cex&&pzS.cex.venue||'bybit')}" aria-pressed="${cex}">Exchange API key</button></div>
    ${cex?pzCexFormHtml(true):`
      ${settings.wallets.length&&!busy?`<p class="pz-fine">No closed trades found yet for ${settings.wallets.map(w=>esc(labelFor(w))).join(', ')}. Add another address, or look around with sample data.</p>`:''}
      <div class="pz-field"><label for="pzAddr">Hyperliquid or Lighter address</label><input type="text" id="pzAddr" placeholder="0x…" autocomplete="off" autocapitalize="off" spellcheck="false"></div>
      ${errHtml}
      <button type="button" class="pz-cta" id="pzConnect"${busy?' disabled':''}>${busy?'<span class="pz-spin"></span>Loading your trades…':'Connect'}</button>`}
    <div class="pz-wl-or"><span>or</span></div>
    <button type="button" class="pz-ghost" id="pzDemo">Try it with sample data</button>
    <p class="pz-fine pz-wl-safe">${pzI('lock',14)}<span>Read-only. ${cex?'Bybit and Binance through a key that can’t trade or withdraw':'A public address: no wallet connection, no signature, no keys'}. Your journal ${synced?'syncs to this server.':'stays in this browser.'}</span></p>
    <div class="pz-wl-more">
      ${link?'':acctConnectHtml()}
      ${tokenAsk?`<details><summary class="pz-fine" style="cursor:pointer">Own this server? Sign in to sync</summary>${pzTokenHtml()}</details>`:''}
      <a class="pz-fine" href="${esc(pzFullHref())}">Open the full journal instead →</a></div>
    </section></div>`;
}
// Bybit / Binance: a read-only API key (venues.js: cexConnect, CEX_HELP)
function pzCexFormHtml(inCard){ const v=pzS.cex.venue||'bybit';
  return `<div class="pz-cex" style="display:flex;flex-direction:column;gap:8px;margin-top:10px">
    <div class="pz-seg" role="group" aria-label="Exchange">${['bybit','binance'].map(x=>`<button type="button" data-pz-cex="${x}" aria-pressed="${x===v}" style="flex:1">${VENUE_NAMES[x]}</button>`).join('')}</div>
    <p class="pz-fine">${CEX_HELP[v].steps} <a href="${CEX_HELP[v].url}" target="_blank" rel="noopener">Open ${VENUE_NAMES[v]}</a></p>
    <div class="pz-field"><label for="pzCexKey">API key</label><input type="text" id="pzCexKey" autocomplete="off" autocapitalize="off" spellcheck="false"></div>
    <div class="pz-field"><label for="pzCexSecret">API secret</label><input type="password" id="pzCexSecret" autocomplete="off" autocapitalize="off" spellcheck="false"></div>
    ${pzS.cex.err?`<p class="pz-fine pz-err" role="alert">${esc(pzS.cex.err)}</p>`:''}
    <div style="display:flex;gap:8px"><button type="button" class="pz-cta" id="pzCexGo"${pzS.cex.busy?' disabled':''}>${pzS.cex.busy?'<span class="pz-spin"></span>Checking the key…':'Connect '+VENUE_NAMES[v]}</button>${inCard?'':'<button type="button" class="pz-ghost" id="pzCexX">Cancel</button>'}</div>
    <p class="pz-fine">Read-only keys only — a key that can trade or withdraw is refused. The secret stays on this device; your server only passes the signed requests on.</p></div>`; }
async function pzCexGo(){
  const k=$('pzCexKey'), sct=$('pzCexSecret'); pzS.cex.busy=true; pzS.cex.err=''; pzRender();
  try{ const r=await cexConnect(pzS.cex.venue||'bybit',k?k.value:'',sct?sct.value:'','');
    const name=VENUE_NAMES[pzS.cex.venue||'bybit']; pzS.cex=null; pzS.sheet=false;
    ['pzCexKey','pzCexSecret'].forEach(id=>{ const el=$(id); if(el)el.value=''; });
    pzNote(name+' connected'+(r.note?' · key '+r.note:'')+' — loading your trades…','busy'); return loadAll(); }
  catch(e){ if(pzS.cex){ pzS.cex.busy=false; pzS.cex.err=e.message; } pzRender(); } }
function pzLoadingHtml(){
  const m=pzS.note&&pzS.note.m||'Loading your trades…';
  return `<div class="pz-connect" style="align-items:center;text-align:center">${pzRing('',0.3,PZ_COL.good,{size:88})}
    <p class="pz-sub" role="status"><span class="pz-spin"></span>${esc(m)}</p><p class="pz-fine">The first load pulls your full history; after that only new fills are fetched.</p></div>`;
}
function pzTokenHtml(){
  return `<div class="pz-field" style="margin-top:10px"><label for="pzTok">Access token</label><input type="password" id="pzTok" autocomplete="current-password" placeholder="the AUTH_TOKEN set on the server">
    <p class="pz-fine">Signing in loads this server’s journal. Anything saved only in this browser is replaced.</p>
    <button type="button" class="pz-ghost pz-sm" id="pzTokBtn">Connect</button>${SRV.badAuth&&SRV.token?'<p class="pz-fine pz-err">The server rejected that token.</p>':''}</div>`;
}
function pzSheetHtml(){
  const tokenAsk=SRV.enabled&&SRV.needsAuth&&(!SRV.token||SRV.badAuth);
  const where=!SRV.enabled?'Saved in this browser. Use the full journal’s Backup to move it to another device.'
    :tokenAsk?'Saved in this browser only — this server is protected by an access token.'
    :'Synced to this server — open Keel on any device to pick up where you left off.';
  return `<div class="pz-sheet-bg" data-pz-close><div class="pz-sheet" role="dialog" aria-modal="true" aria-labelledby="pzSheetT">
    <div style="display:flex;justify-content:space-between;align-items:center"><b id="pzSheetT" style="font-size:18px">Settings</b><button type="button" class="pz-chip icon" data-pz-close aria-label="Close">${pzI('x',20)}</button></div>
    <section><span class="pz-lbl" style="color:var(--pz-muted)">Wallets</span>
      ${settings.wallets.map((w,i)=>`<div class="pz-wl"><span>${w.label?esc(w.label)+' · ':''}<code>${esc(walletShort(w.address))}</code></span><button type="button" class="pz-ghost pz-sm" data-pz-rmw="${i}" aria-label="Remove wallet ${esc(labelFor(w))}">Remove</button></div>`).join('')||'<p class="pz-sub">No wallets yet.</p>'}
      <div class="pz-field" style="margin-top:10px"><label for="pzAddr2" style="font-size:13px">Add another address</label><input type="text" id="pzAddr2" placeholder="0x…" autocomplete="off" autocapitalize="off" spellcheck="false">
        <div style="display:flex;gap:8px"><button type="button" class="pz-ghost pz-sm" id="pzAdd2">Add &amp; load</button>${settings.wallets.length?'<button type="button" class="pz-ghost pz-sm" id="pzRefresh">Refresh now</button>':''}</div></div>
      ${pzS.cex?pzCexFormHtml():`<button type="button" class="pz-ghost pz-sm" data-pz-cex="bybit" style="margin-top:8px">Connect Bybit or Binance</button>`}</section>
    <section><span class="pz-lbl" style="color:var(--pz-muted)">Appearance</span>
      <div class="pz-seg" role="group" aria-label="Appearance" style="margin-top:6px">${[['auto','Auto'],['dark','Dark'],['light','Light']].map(([v,l])=>`<button type="button" data-pz-appear="${v}" aria-pressed="${(settings.appearance||'auto')===v}" style="flex:1">${l}</button>`).join('')}</div>
      <p class="pz-fine" style="margin-top:6px">Auto follows your phone’s light or dark setting.</p></section>
    ${pzProfilePickHtml()}
    ${pzTaSetHtml()}
    ${pzPushHtml()}
    <section><span class="pz-lbl" style="color:var(--pz-muted)">Your data</span><p class="pz-sub" style="margin-top:6px">${where}</p>
      ${SRV.enabled&&!SRV.needsAuth?'<p class="pz-warn" style="margin-top:10px">This server has no access token set, so everyone who opens this link shares one journal. The owner should set AUTH_TOKEN before sharing it.</p>':''}
      ${tokenAsk?pzTokenHtml():''}</section>
    <section style="display:flex;flex-direction:column;gap:8px">${_deferredInstall?'<button type="button" class="pz-ghost" id="pzInstall">Install Keel as an app</button>':'<p class="pz-fine">To install: on iPhone tap Share → Add to Home Screen; on Android or desktop use the browser’s Install option.</p>'}
      <a class="pz-ghost" href="${esc(pzFullHref())}">Open the full journal</a>${((SRV.enabled&&SRV.token&&!SRV.badAuth)||(typeof SOC!=='undefined'&&SOC.me&&SOC.me.admin))&&/^https?:$/.test(location.protocol)?'<a class="pz-ghost" href="/admin">Admin panel</a>':''}</section>
  </div></div>`;
}

// ---- render + events ----
function pzNote(m, kind){
  pzS.note=m?{m,kind:kind||''}:null;
  const el=$('pzNote'); if(!el)return;
  el.className='pz-note'+(kind==='err'?' err':'');
  el.innerHTML=m?(kind==='busy'?'<span class="pz-spin"></span>':'')+esc(m):'';
  // messages go by themselves (errors stay a little longer), or with a tap, or when you change screens
  clearTimeout(pzNote._t); if(m&&kind!=='busy')pzNote._t=setTimeout(()=>{ if(el.textContent===m){ el.textContent=''; pzS.note=null; } },kind==='err'?9000:5000);
  // the first-run and loading screens show the message inline too
  if(!allTrades.length&&$('pzView'))pzRender();
}
let _pzLastD=null;
function pzRender(){
  if(!PZ)return; const view=$('pzView'); if(!view)return;
  // keep what's typed across re-renders (a background sync or auto-refresh can land mid-edit)
  const root=$('pz'), keep={}; root.querySelectorAll('input[id],textarea[id]').forEach(el=>{ keep[el.id]=el.value; });
  const act=document.activeElement, actId=act&&root.contains(act)?act.id:null;
  // the focused control without an id is found again by its data-* attributes, so a click that
  // re-renders the screen doesn't drop keyboard focus to the page
  const actSel=act&&!actId&&root.contains(act)&&act.attributes?([...act.attributes].filter(a=>a.name.startsWith('data-')).map(a=>`[${a.name}="${CSS.escape(a.value)}"]`).join('')||null):null;
  let html;
  if(!allTrades.length){ socBoot(); html=_loading&&settings.wallets.length?pzLoadingHtml():pzConnectHtml(); }
  else { const tab=pzTab(); let D;
    try{ D=_pzLastD=pzData(); }catch(e){ console.error(e); view.inert=false; view.innerHTML=`<div class="pz-connect"><p class="pz-sub pz-err">Keel hit an error reading your data (${esc(e.message)}).</p><a class="pz-ghost" href="${esc(pzFullHref())}">Open the full journal</a></div>`; return; }
    ensureWeekChallenge(D.ctx).then(made=>{ if(made)pzRender(); }).catch(()=>{});
    socBoot(); pzWearSync(); pzPushCheck();
    const lv=D.g.level.level;
    const body=tab==='trends'?pzTrendsHtml(D):tab==='deep'?pzDeepHtml(D):tab==='how'?pzHowHtml():tab==='badges'?pzBadgesHtml(D):tab==='report'?pzReportHtml(D)
      :tab==='review'?pzReviewHtml(D):tab==='coach'?pzCoachHtml(D):tab==='leagues'?socFindHtml(D):tab==='lginfo'?socLeagueInfoHtml(D,pzHashArg()):tab==='checkin'?pzCheckinHtml(D):tab==='progress'?pzProgressHtml(D)
      :tab==='discipline'?pzDisciplineHtml(D):tab==='journal'?pzJournalHtml(D):tab==='social'?socSocialHtml(D):tab==='duels'?socDuelsHtml(D):tab==='people'?socPeopleHtml(D):tab==='duelnew'?socDuelNewHtml(D,pzHashArg()):tab==='podnew'?socPodNewHtml(D):tab==='sharing'?socSharingHtml(D):tab==='account'?socAccountHtml(D)
      :tab==='lessons'?(()=>{ try{ return pzLessonsHtml(D); }catch(e){ console.warn('lessons',e); return `<a class="pz-back" href="#progress">${pzI('back',20)}Progress</a><p class="pz-sub pz-err">Your lessons couldn’t be read (${esc(e.message)}).</p>`; } })():tab==='mentor'?socMentorHtml(D):tab==='mentee'?socMenteeHtml(D,pzHashArg()):tab==='profile'?socProfileHtml(D,pzHashArg()):tab==='post'?socPostHtml(D,pzHashArg()):tab==='compose'?socComposeHtml(D):tab==='reviews'?mrListHtml(D):tab==='tr'?mrThreadHtml(D,pzHashArg(),/\/mod$/.test(location.hash)):tab==='plan'?planPzHtml(D):tab==='comp'?socCompHtml(D,pzHashArg()):pzTodayHtml(D);
    html=`${pzNav(tab,lv)}<main class="pz-main" id="pzMain">${body}</main>`;
    socSync(D.g); }
  view.innerHTML=html;
  pzQuietMount(allTrades.length?_pzLastD:null);
  const sh=$('pzSheet'); if(sh)sh.innerHTML=pzS.sheet?pzSheetHtml():pzS.custom?pzCustomizeHtml(pzS.custom):'';
  view.inert=!!(sh&&(pzS.sheet||pzS.custom)); // with a sheet open, Tab stays inside it
  for(const id in keep){ const el=$(id); if(el&&root.contains(el)&&keep[id]&&!el.value)el.value=keep[id]; }
  // (by data-* only when they name a single control: several identical Save buttons stay unfocused rather than jumping to the first)
  const f=(actId&&$(actId))||(actSel&&(()=>{ const all=root.querySelectorAll(actSel+':not([disabled])'); return all.length===1?all[0]:null; })()); if(f&&f.focus)f.focus({preventScroll:true});
}
async function pzConnect(inputId){
  const el=$(inputId); const a=(el&&el.value||'').trim();
  if(!/^(lighter:)?0x[0-9a-fA-F]{40}$/i.test(a)){ pzNote('That doesn’t look like a wallet address — it starts with 0x and is 42 characters long. For Bybit or Binance, connect an API key instead.','err'); const f=$(inputId); if(f)f.focus(); return; }
  if(el)el.value=''; pzS.sheet=false; pzNote('Loading your trades…','busy');
  for(let i=0;_loading&&i<240;i++)await sleep(250); // a background refresh is running: let it finish, then load
  $('walletAddr').value=a;
  await loadAll();
  // real trades loaded: sample-data mode is over (not before, in case the load didn't happen)
  if(allTrades.length&&settings.wallets.some(w=>w.address.toLowerCase()===a.toLowerCase()))pzS.demo=false;
}
async function pzToken(){
  const tok=($('pzTok')||{value:''}).value.trim(); if(!tok)return;
  try{ localStorage.setItem('srv_token',tok); }catch(e){}
  SRV.token=tok; SRV.badAuth=false;
  const d=await srvFetch('/api/data');
  if(d.status===401){ SRV.badAuth=true; pzNote('The server rejected that token.','err'); pzRender(); return; }
  if(d.status===429){ SRV.badAuth=true; pzNote(srvLockMsg(d),'err'); pzRender(); return; }
  pzNote('Connected — reloading…','busy'); location.reload();
}
function wirePulse(){
  const root=$('pz'); if(!root)return;
  root.addEventListener('click',async ev=>{
    const t=ev.target.closest('button,a,[data-pz-close]'); if(!t||!root.contains(t))return;
    const ds=t.dataset;
    if(ds.pzRing){ pzS.ring=ds.pzRing; pzRender();
      // the detail opens under the dials; bring it into view when the screen has scrolled
      const d=$('pzRingDetail'); if(d&&d.getBoundingClientRect().bottom>innerHeight)d.scrollIntoView({block:'nearest',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});
      return; }
    if(await pzGrowthAction(t))return;
    if(ds.pzRange){ pzS.range=ds.pzRange==='all'?'all':+ds.pzRange; pzRender(); return; }
    if(ds.pzHlmore){ pzS.hlOpen=!pzS.hlOpen; pzRender(); return; }
    if(ds.pzBadge){ pzS.badge=pzS.badge===ds.pzBadge?null:ds.pzBadge; pzRender(); return; }
    if(ds.pzCk&&pzS.ck){ const n=+ds.n; pzS.ck[ds.pzCk]=pzS.ck[ds.pzCk]===n?null:n;
      t.closest('.pz-pills').querySelectorAll('button').forEach(b=>b.setAttribute('aria-checked',String(+b.dataset.n===pzS.ck[ds.pzCk])));
      const r=pzCkReady(pzS.ck), p=$('pzCkPrev'); if(p)p.innerHTML=pzCkPrevHtml(r,pzBand(r)); return; }
    if(ds.pzCap&&pzS.ck){ const cur=pzS.ck.maxTrades||0; pzS.ck.maxTrades=Math.max(0,Math.min(50,cur+(+ds.pzCap)))||null; const o=$('pzCap'); if(o)o.textContent=pzS.ck.maxTrades||'—'; return; }
    if(ds.pzRate){ const sec=t.closest('[data-pz-trade]'); if(!sec)return; const id=sec.dataset.pzTrade, n=+ds.pzRate;
      pzS.jr[id]=pzS.jr[id]===n?0:n; sec.querySelectorAll('[data-pz-rate]').forEach(b=>b.setAttribute('aria-checked',String(+b.dataset.pzRate===pzS.jr[id]))); return; }
    if(ds.pzJsave!==undefined){ const sec=t.closest('[data-pz-trade]'); if(sec)await pzSaveJournal(sec); return; }
    if(ds.pzSheet!==undefined){ pzS.sheet=true; pzRender(); const c=$('pzSheet').querySelector('[data-pz-close].pz-chip'); if(c)c.focus(); return; }
    if(ds.pzClose!==undefined){ if(t.classList.contains('pz-sheet-bg')&&ev.target!==t)return; pzS.sheet=false; pzS.custom=null; pzRender(); return; }
    if(ds.pzCustomize){ pzS.custom=ds.pzCustomize; pzRender(); const c=$('pzSheet').querySelector('[data-pz-close].pz-chip'); if(c)c.focus(); return; }
    if(ds.pzMove){ const [sc,id,d]=ds.pzMove.split(':'); if(pzMove(sc,id,+d)){ await Store.set(S_KEY,settings); pzRender();
        const b=$('pzSheet').querySelector(`[data-pz-move="${sc}:${id}:${d}"]:not([disabled])`)||$('pzSheet').querySelector(`[data-pz-move^="${sc}:${id}:"]:not([disabled])`); if(b)b.focus(); } return; }
    if(ds.pzSect){ const [sc,id]=ds.pzSect.split(':'), L=settings.pzLayout=settings.pzLayout||{}, M=L[sc]=L[sc]||{}; M[id]=!pzShow(sc,id); await Store.set(S_KEY,settings); pzRender(); return; }
    if(ds.pzSectreset){ if(settings.pzLayout)delete settings.pzLayout[ds.pzSectreset]; await Store.set(S_KEY,settings); pzRender(); return; }
    if(ds.pzAmfill!==undefined){ const el=$('pzAm'+ds.pzAmfill); if(!el)return; el.value=ds.v; el.dispatchEvent(new Event('input',{bubbles:true}));
      root.querySelectorAll('[data-pz-amfill="'+ds.pzAmfill+'"]').forEach(b=>b.classList.toggle('ok',b===t)); el.focus(); return; }
    if(ds.pzRmw!==undefined){ const w=settings.wallets[+ds.pzRmw]; if(w&&!confirm('Remove '+labelFor(w)+'? Its trades leave Keel; your notes on them stay saved.'))return;
      await removeWallet(+ds.pzRmw); pzRender(); return; }
    if(ds.pzCex){ pzS.cex={venue:ds.pzCex}; pzRender(); const f=$('pzCexKey'); if(f)f.focus(); return; }
    if(ds.pzCexoff!=null){ pzS.cex=null; pzRender(); const f=$('pzAddr'); if(f)f.focus(); return; }
    if(await mrAction(t))return;
    if(await socAction(t))return;
    switch(t.id){
      case 'pzConnect': return pzConnect('pzAddr');
      case 'pzAdd2': return pzConnect('pzAddr2');
      case 'pzCexGo': return pzCexGo();
      case 'pzCexX': pzS.cex=null; pzRender(); return;
      case 'pzDemo': pzS.demo=true; pzNote('Generating sample data…','busy'); await loadDemo();
        if(allTrades.length)pzNote('These are sample trades. Discipline is read from the fills; prep and journal a few to earn XP and watch the rest fill in.');
        return;
      case 'pzRefresh': pzS.sheet=false; pzRender(); pzNote('Refreshing…','busy'); return loadAll();
      case 'pzCkSave': return pzSaveCheckin();
      case 'pzTokBtn': return pzToken();
      case 'pzInstallX': try{ localStorage.setItem('pz_install_x','1'); }catch(e){} pzRender(); return;
      case 'pzInstallCard':
      case 'pzInstall': if(_deferredInstall){ _deferredInstall.prompt(); try{ await _deferredInstall.userChoice; }catch(e){} _deferredInstall=null; pzRender(); } return;
      case 'pzReport': return showReportCard();
      case 'pzSwap': { const g=gameContext(); const c=challengeCandidates(g.ctx.findings); const cur=weekChallenge(); if(!c.length)return;
        const curKey=cur&&specKey(cur.spec); let i=(Math.max(0,c.findIndex(x=>specKey(x)===curKey))+1)%c.length;
        for(let n=0;n<c.length&&specKey(c[i])===curKey;n++)i=(i+1)%c.length;
        await setWeekChallenge(c[i],i); pzRender(); return; }
    }
  });
  root.addEventListener('input',ev=>{ const t=ev.target; if(t.id==='socHandle2'){ SOC.draftHandle=t.value; return; } if(t.id==='socBio'){ SOC.draftBio=t.value; return; }
    if(t.id==='socPq'){ clearTimeout(SOC.pqT); SOC.pqT=setTimeout(()=>{ SOC.pq=t.value.trim(); SOC.ppage=0; pzRender(); const el=$('socPq'); if(el){ el.focus(); el.setSelectionRange(el.value.length,el.value.length); } },300); return; }
    if(t.id==='socLq'){ clearTimeout(SOC.lqT); SOC.lqT=setTimeout(()=>{ SOC.lq=t.value.trim(); pzRender(); const el=$('socLq'); if(el){ el.focus(); el.setSelectionRange(el.value.length,el.value.length); } },300); return; }
    if(t.id==='pzLq'){ clearTimeout(pzS.lqT); pzS.lqT=setTimeout(()=>{ pzS.lq=t.value.trim(); pzRender(); const el=$('pzLq'); if(el){ el.focus(); el.setSelectionRange(el.value.length,el.value.length); } },250); return; }
    if(pzS.ck&&t.id==='pzUntil'){ (pzS.ck.rules=pzS.ck.rules||{}).until=t.value; return; }
    if(pzS.ck&&t.id==='pzMaxPos'){ (pzS.ck.rules=pzS.ck.rules||{}).maxPos=parseFloat(t.value)||null; return; }
    if(pzS.ck&&t.dataset.pzAm){ (pzS.ck.am=pzS.ck.am||{})[t.dataset.pzAm]=t.value; return; }
    if(!pzS.ck)return;
    if(t.id==='pzPlan')pzS.ck.plan=t.value; else if(t.id==='pzLoss')pzS.ck.maxLoss=t.value; });
  root.addEventListener('change',async ev=>{ const t=ev.target;
    if(t.type==='file'&&await socFilePicked(t))return;
    if(t.id==='socBoardSel'){ SOC.board=t.value; pzRender(); return; }
    if((t.id==='pzPushAm'||t.id==='pzPushPm')&&/^\d{2}:\d{2}$/.test(t.value)){ const pr=Object.assign({},SOC.me&&SOC.me.push&&SOC.me.push.prefs,t.id==='pzPushAm'?{morning:t.value}:{eod:t.value});
      try{ const r=await socFetch('/push',{method:'PUT',body:JSON.stringify({prefs:pr})}); SOC.me.push.prefs=r.prefs; pzNote('Saved.'); }catch(e){ pzNote(e.message,'err'); } return; }
    if(t.id==='socGboardSel'){ SOC.gboard=t.value; pzRender(); return; }
    if(pzS.goalNew&&(t.id==='pzGk'||t.id==='pzGt'||t.id==='pzGs')){ const f=pzS.goalNew;
      if(t.id==='pzGk'){ f.kind=t.value; const T=PZ_GOAL_KINDS[f.kind].targets; f.target=T[1]||T[0]; } else if(t.id==='pzGt')f.target=+t.value; else f.slip=t.value;
      pzRender(); const n=$(t.id); if(n)n.focus(); return; }
    if(t.id==='pzProf'){ settings.pzProfile=t.value==='auto'?null:t.value; await Store.set(S_KEY,settings); pzNote('Profile set: '+pzProfile(gameContext().ctx.closed).name+'.'); pzRender(); } });
  root.addEventListener('keydown',ev=>{
    if(ev.key==='Enter'&&(ev.target.id==='pzAddr'||ev.target.id==='pzAddr2')){ ev.preventDefault(); pzConnect(ev.target.id); }
    else if(ev.key==='Enter'&&ev.target.id==='pzTok'){ ev.preventDefault(); pzToken(); }
    else if(ev.key==='Enter'&&ev.target.id==='pzCexSecret'){ ev.preventDefault(); pzCexGo(); }
    else if(ev.key==='Enter'&&ev.target.id==='socHandle'){ ev.preventDefault(); const b=$('socJoin'); if(b)b.click(); }
    else if(ev.key==='Enter'&&!ev.shiftKey&&ev.target.id==='pzCoachIn'){ ev.preventDefault(); const b=$('pzCoachSend'); if(b)b.click(); }
    else if(ev.key==='Enter'&&ev.target.id==='pzSetupAdd'){ ev.preventDefault(); const b=$('pzSetupAddGo'); if(b)b.click(); }
    else if(ev.key==='Enter'&&(ev.target.id==='socLinkIn'||ev.target.id==='vaultPass'||ev.target.id==='vaultPass2')){ ev.preventDefault();
      const b=$(ev.target.id==='socLinkIn'?'socLinkGo':$('vaultUnlock')?'vaultUnlock':'vaultOn'); if(b)b.click(); }
  });
  // Escape closes an open sheet wherever focus is (it can sit on the page itself after a re-render)
  document.addEventListener('keydown',ev=>{ if(ev.key==='Escape'&&(pzS.sheet||pzS.custom)){ pzS.sheet=false; pzS.custom=null; pzRender(); const g=document.querySelector('[data-pz-sheet]'); if(g)g.focus(); } });
  { const n=$('pzNote'); if(n)n.addEventListener('click',()=>{ if(pzS.note&&pzS.note.kind!=='busy')pzNote(null); }); }
  let prevTab=pzTab(); window.addEventListener('hashchange',()=>{ const tb=pzTab(); SOC.confirm=null; if(pzS.note&&pzS.note.kind==='err')pzNote(null);
    // a half-typed comment or update belongs to the post it was written on
    for(const id of ['socCText','socUNote','socUExit']){ const el=$(id); if(el)el.value=''; } if(tb==='checkin')pzS.ck=null; if(tb==='sharing'&&prevTab!=='account'){ SOC.draft=null; SOC.draftHandle=null; SOC.draftBio=null; } prevTab=tb; pzRender(); window.scrollTo(0,0); });
  // the join screen's "What you share" stays open across re-renders (each switch re-renders the screen)
  document.addEventListener('toggle',ev=>{ if(ev.target&&ev.target.id==='socShareBox')pzS.joinShare=ev.target.open; },true);
  window.addEventListener('beforeinstallprompt',()=>{ if(pzS.sheet||!location.hash||location.hash==='#today')pzRender(); });
  window.addEventListener('appinstalled',()=>{ _deferredInstall=null; pzRender(); });
}
if(PZ)wirePulse();
