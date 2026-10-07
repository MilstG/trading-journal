/* ============================================================================
   Your work list — everything your trades say to fix (or keep doing) as one ranked list, with what you did
   about each. A feature in its own file: a card on Today ("What to work on"), the #work screen and one item's
   page (#work/<key>). Loads on Daruma's page only (data-only="keel").

   Before it, several Today cards each picked their own leak from their own window with their own math (the
   costliest slip over 180 days, the first look's 30-day sum, the coach's 60-minute tilt finding…), so one
   habit could show up four times with four dollar figures. Here every source maps onto one key per problem
   (slip:revenge takes the revenge slip, the coach's tilt finding and the cool-down), each item gets one figure
   in one unit (dollars a month over the last 90 days, by the most like-for-like method there is for it), and
   one rank: $ a month × how sure × how much is in your hands. The other ways of counting stay on the item's
   page, each with what makes it different.

   Sources (wlCollect, pure):
     slip:<id>        the six Discipline slips against your own trades that had the same chance and didn't
                      (rfMySlips over 90 days); the coach's tilt / overtrading / disposition findings fold in
     size:big, bucket:<dim>=<key>, mistakes
                      the coach's findings over the last 90 days that carry an honest dollar gap (usd)
     cost:taker       last 30 days' taker flow priced at maker rates (feeTierModel)
   Early signals (can't be told from luck yet) aren't ranked: they wait under Watching.

   What you did about each (wlResolve, pure) lives in settings.pzWork, synced like the rest of your settings:
     on[key]      {at, month, title, hid}  working on it (hid: the habit it started)
     fixed[key]   {at, month, base, title} you marked it fixed; it comes back if it grows back
     snooze[key]  {until, month}           not now: two weeks, or sooner if it grows by half
   Slips keep using plugs (settings.pzPlugs): a live plug is "working on", three clean trading weeks fix it,
   and a plugged slip that came back is back on the list. So a plug started anywhere shows here, and one
   started here shows on Progress.

   The check on what you're working on (wlSlipCheck for slips, pure): how often you slipped when you had the
   chance, before (90 days) and since (the rules' two-proportion test, ruleFollowThrough), and whether those
   chances went better, in typical trades, with a 95% range from resampling. Other items: the habit's kept days
   and the item's monthly figure now against when you started.

   Today's other cards defer to it while it's on (wlActive: not left out by a staged rollout): Your costliest
   slip and Your rules, replayed step aside (their sections stay on What the data says), Finding of the week
   skips what the list already covers, and the coach line and the first look read its top item.
   ============================================================================ */
const WL_DAYS=90, WL_MO=30.44, WL_DAY=86400000, WL_NEED=20, WL_WAIT=21, WL_SNOOZE=14, WL_SEEN='pzWorkSeen';
const WL_CONF={strong:1,likely:0.7};
// coach findings that are the same problem as a slip, and the ones that are items of their own
const WL_SLIP_OF={tilt:'revenge',overtrading:'overtrade',disposition:'heldLoser'};
const WL_OWN={oversizing:1,'worst-bucket':1,'best-bucket':1,mistakes:1};
var WL={ask:null,busy:false};
const wlActive=()=>!(typeof pzRolledOff==='function'&&pzRolledOff('work'));
// the coach findings the list covers (Finding of the week skips them while it's on)
const wlCovers=f=>!!f&&wlActive()&&(!!WL_SLIP_OF[f.id]||!!WL_OWN[f.id]||f.id==='fees');
const wlR=v=>(v<0?'−':'+')+(Math.round(Math.abs(v)*10)/10).toFixed(1);
const wlPc=x=>Math.round(x*100)+'%';
const wlHref=k=>'#work/'+encodeURIComponent(k);
const wlMo=m=>'about '+usdPlain(m)+' a month';

// ---- the items: every source onto one key, one figure, one rank. Pure. ----
// I: {span (days the figures cover), slips (rfMySlips), findings (buildFindings), fees (feeTierModel), beh (PZ_BEH),
//     plug (PZ_PLUG), group (the research feed's slips), leak30 (pzLeakMap rows)}
function wlCollect(I){
  I=I||{}; const span=Math.max(1,I.span||WL_DAYS), mo=usd=>usd*WL_MO/span, items=new Map(), beh=I.beh||{}, plug=I.plug||{};
  const S=(I.slips&&I.slips.slips)||{}, unit=(I.slips&&I.slips.unit)||0, G=I.group||{}, L30=new Map((I.leak30||[]).map(x=>[x.slip,x]));
  for(const k of Object.keys(beh)){ const m=S[k]; if(!m||m.R==null||!(m.R<0)||!(m.n>0))continue;
    const kept=m.slipped-m.R, l30=L30.get(k), g=G[k], P=plug[k];
    const other=[['Those trades’ whole result',signedPlain(m.slipped*unit*m.n)+' over 90 days','The sum counts what they’d have lost anyway; the figure above counts only how much worse they went.']];
    if(l30&&l30.n)other.push(['Your leaks on Progress',signedPlain(l30.cost)+' over 30 days',`The same sum over the last 30 days (${l30.n} trade${l30.n===1?'':'s'}).`]);
    if(g&&g.R!=null)other.push(['Traders in your league',wlR(g.R)+' of a typical trade each',`The research run’s figure, measured the same way on ${g.wallets} wallets${g.sure?'':'; it can’t be told from zero'}.`]);
    items.set('slip:'+k,{key:'slip:'+k,kind:'leak',slip:k,title:beh[k],action:P?'When '+P.when+', '+P.then+'.':'',month:mo(m.R*unit*m.n),n:m.n,control:1,
      conf:m.sure?(m.n>=20?'strong':'likely'):'early',
      body:`${m.n} time${m.n===1?'':'s'} in the last 90 days. Those trades averaged ${wlR(m.slipped)} of a typical trade; when you had the same chance and didn’t take it, ${wlR(kept)}.`,
      why:`Each one ${wlR(m.R)} of a typical trade (${usdPlain(unit)}), 95% range ${wlR(m.lo)} to ${wlR(m.hi)}, from ${m.chances} times you had the chance.`,other}); }
  for(const f of I.findings||[]){ if(!f||!f.id)continue;
    const sk=WL_SLIP_OF[f.id];
    if(sk){ const it=items.get('slip:'+sk); if(it)it.other.push(['The coach’s finding',f.title,pzPlain(f.body)]); continue; }
    if(!WL_OWN[f.id]||typeof f.usd!=='number'||!isFinite(f.usd))continue;
    const edge=f.tone==='edge'; if(edge?!(f.usd>0):!(f.usd<0))continue;
    const key=f.id==='oversizing'?'size:big':f.id==='mistakes'?'mistakes':'bucket:'+f.dim+'='+f.bkey;
    items.set(key,{key,kind:edge?'edge':'leak',finding:f.id,title:f.title,action:pzPlain(f.action),month:mo(f.usd),n:f.n,control:f.id==='mistakes'?1:0.8,
      conf:f.conf,habit:f.habit||null,body:pzPlain(f.body),why:f.evidence||'',other:[]}); }
  const F=I.fees;
  if(F&&F.saveAsMaker30>=5&&F.takerN30>F.makerN30){ const sh=F.takerN30/(F.takerN30+F.makerN30+(F.unk30||0));
    items.set('cost:taker',{key:'cost:taker',kind:'leak',title:'Taker fees you could keep',action:'Enter with limit orders where you can; keep market orders for exits that can’t wait.',
      month:-F.saveAsMaker30,win:30,n:null,control:0.9,conf:'strong',habit:{tpl:'maker-half'},
      body:`Over the last 30 days ${wlPc(sh)} of your volume went through as taker. The same flow as maker would have cost about ${usdPlain(F.saveAsMaker30)} less.`,
      why:'Your fills’ maker/taker split, priced at your fee tier on Hyperliquid’s base schedule (check app.hyperliquid.xyz/fees). Exact arithmetic, not an estimate from a sample.',other:[]}); }
  const out=[...items.values()];
  for(const it of out)it.rank=Math.abs(it.month)*(WL_CONF[it.conf]||0)*it.control;
  return out;
}

// ---- what you did about each: the stage, from your plugs and settings.pzWork. Pure. ----
// -> {working, next, watching, snoozed, keep, fixed}; each entry an item (or a stand-in for one no longer on the
// list) with stage, since, back (it was fixed and came back)
function wlResolve(items, st, plugs, now){
  st=st&&typeof st==='object'?st:{}; now=now||Date.now();
  const on=st.on||{}, fixed=st.fixed||{}, snooze=st.snooze||{}, P=(plugs||[]).filter(p=>p&&!p.dropped);
  const live=new Map(P.filter(p=>!p.done).map(p=>[p.slip,p])), done=new Map(P.filter(p=>p.done&&!p.back).map(p=>[p.slip,p])), back=new Set(P.filter(p=>p.done&&p.back).map(p=>p.slip));
  const by=new Map(items.map(it=>[it.key,it])), R={working:[],next:[],watching:[],snoozed:[],keep:[],fixed:[]};
  const stand=(key,title)=>({key,kind:'leak',title,month:0,conf:'early',control:1,rank:0,gone:true,other:[],slip:key.startsWith('slip:')?key.slice(5):null});
  for(const it of items){ const x=Object.assign({},it), f=fixed[it.key], s=snooze[it.key];
    if(it.slip&&live.has(it.slip)){ const p=live.get(it.slip); x.stage='working'; x.since=p.at||Date.parse(p.from+'T00:00:00Z'); x.plug=p; R.working.push(x); continue; }
    if(!it.slip&&on[it.key]){ x.stage='working'; x.since=on[it.key].at; x.on=on[it.key]; R.working.push(x); continue; }
    if(it.slip&&done.has(it.slip)){ x.stage='fixed'; x.fixedAt=done.get(it.slip).done; R.fixed.push(x); continue; }
    // a fixed item comes back when it's sure again and at least half the size it was when you started on it
    if(f){ if(it.kind==='leak'&&WL_CONF[it.conf]&&Math.abs(it.month)>=0.5*Math.abs(f.base||f.month||0))x.back=true;
      else { x.stage='fixed'; x.fixedAt=f.at; R.fixed.push(x); continue; } }
    if(it.slip&&back.has(it.slip))x.back=true;
    if(it.kind==='edge'){ if(WL_CONF[it.conf]){ x.stage='keep'; R.keep.push(x); } continue; }
    if(s&&now<s.until&&!(Math.abs(it.month)>=1.5*Math.abs(s.month||0))){ x.stage='snoozed'; x.until=s.until; R.snoozed.push(x); continue; }
    x.stage='new'; (WL_CONF[it.conf]?R.next:R.watching).push(x); }
  // working on something that has dropped off the 90 days, and what was fixed before: kept from their records
  for(const [slip,p] of live)if(!by.has('slip:'+slip))R.working.push(Object.assign(stand('slip:'+slip,(typeof PZ_BEH!=='undefined'&&PZ_BEH[slip])||slip),{stage:'working',since:p.at||Date.parse(p.from+'T00:00:00Z'),plug:p}));
  for(const k of Object.keys(on))if(!by.has(k)&&!k.startsWith('slip:'))R.working.push(Object.assign(stand(k,on[k].title||k),{stage:'working',since:on[k].at,on:on[k]}));
  for(const [slip,p] of done)if(!by.has('slip:'+slip))R.fixed.push(Object.assign(stand('slip:'+slip,(typeof PZ_BEH!=='undefined'&&PZ_BEH[slip])||slip),{stage:'fixed',fixedAt:p.done}));
  for(const k of Object.keys(fixed))if(!by.has(k))R.fixed.push(Object.assign(stand(k,fixed[k].title||k),{stage:'fixed',fixedAt:fixed[k].at}));
  R.working.sort((a,b)=>(a.since||0)-(b.since||0));
  R.next.sort((a,b)=>b.rank-a.rank); R.watching.sort((a,b)=>a.month-b.month); R.keep.sort((a,b)=>b.rank-a.rank);
  const fk=x=>typeof x.fixedAt==='number'?new Date(x.fixedAt).toISOString().slice(0,10):String(x.fixedAt||'');
  R.fixed.sort((a,b)=>fk(b)<fk(a)?-1:fk(b)>fk(a)?1:0);
  return R;
}

// ---- the check on a slip you're plugging. Pure. ----
// Your chances to slip in the 90 days before you started and since: how often you took them (ruleFollowThrough's
// two-proportion test) and how those trades went, in typical trades (the 90 days' median absolute result), with
// a seeded 95% range on since minus before.
function wlSlipCheck(closed, bdays, slip, start, o){
  o=Object.assign({now:Date.now(),iters:400},o||{});
  const SS=rfSlipSets(bdays), ch=SS.chance[slip]; if(!ch)return null;
  const tr=(closed||[]).filter(t=>t&&!t.isOpen&&t.closeTime&&t.openTime&&!t.partialHistory&&t.openTime>=start-WL_DAYS*WL_DAY&&t.closeTime<=o.now);
  const nets=tr.map(t=>Math.abs(t.net)).filter(x=>x>0), u=nets.length?nfMedian(nets):0;
  const C=tr.filter(ch), ft=ruleFollowThrough(C,t=>SS.slipped(t,slip),start);
  const R=t=>u>0?Math.max(-20,Math.min(20,t.net/u)):0, mean=a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:null;
  const B=C.filter(t=>t.openTime<start).map(R), A=C.filter(t=>t.openTime>=start).map(R);
  let lo=null, hi=null;
  if(u>0&&A.length>=5&&B.length>=5){ let seed=11; const rnd=()=>{ seed^=seed<<13; seed>>>=0; seed^=seed>>17; seed^=seed<<5; seed>>>=0; return seed/4294967296; }, bs=[];
    for(let i=0;i<o.iters;i++){ let a=0,b=0; for(let j=0;j<A.length;j++)a+=A[Math.floor(rnd()*A.length)]; for(let j=0;j<B.length;j++)b+=B[Math.floor(rnd()*B.length)]; bs.push(a/A.length-b/B.length); }
    bs.sort((x,y)=>x-y); lo=bs[Math.floor(0.025*(bs.length-1))]; hi=bs[Math.ceil(0.975*(bs.length-1))]; }
  return {unit:u,before:Object.assign({r:mean(B)},ft.before),after:Object.assign({r:mean(A)},ft.after),p:ft.p,status:ft.status,lo,hi};
}
// the verdict, in words, from a slip check: checking until 20 chances or three weeks, then kept / paying
function wlSlipVerdict(v, start, now){
  if(!v)return null;
  const a=v.after, b=v.before, days=Math.floor(((now||Date.now())-start)/WL_DAY);
  const slipLine=a.n?`Since you started: slipped on ${a.v} of ${a.n} chance${a.n===1?'':'s'} (${wlPc(a.rate)})${b.n?`, against ${wlPc(b.rate)} in the 90 days before`:''}.`:'No chances to slip since you started yet.';
  const resLine=a.r!=null&&b.r!=null&&a.n>=5&&b.n>=5?`Those trades averaged ${wlR(a.r)} of a typical trade, against ${wlR(b.r)} before${v.lo!=null?` (difference ${wlR(a.r-b.r)}, 95% range ${wlR(v.lo)} to ${wlR(v.hi)})`:''}.`:'';
  if(a.n<WL_NEED&&days<WL_WAIT)return {state:'checking',head:'Checking',pct:Math.max(a.n/WL_NEED,days/WL_WAIT),lines:[slipLine,resLine].filter(Boolean),
    note:`A verdict after ${WL_NEED} chances or three weeks, whichever comes first.`};
  const kept=v.status==='working'||v.status==='clean', paid=v.lo!=null&&v.lo>0;
  const head=kept&&paid?'Kept, and paying':kept?'Kept: no clear change in results yet':v.status==='improving'?'Slipping less, not clearly yet':v.status==='collecting'?'Checking':'Not kept yet';
  return {state:kept&&paid?'ok':kept||v.status==='improving'||v.status==='collecting'?'meh':'bad',head,lines:[slipLine,resLine].filter(Boolean),
    note:kept&&paid?'Three clean trading weeks in a row mark it fixed.':kept?'Keep going: results take longer to show than the habit does.':'Try a smaller version of the rule, or drop it and pick another.'};
}
// the verdict for anything else you're working on: the habit's kept days, and the figure now against when you started
function wlTrendVerdict(it, hab, now){
  const on=it.on||{}, base=Math.abs(on.month||0), cur=it.gone?0:Math.abs(it.month||0), days=Math.floor(((now||Date.now())-(on.at||now))/WL_DAY), win=it.win||WL_DAYS;
  const hl=hab&&hab.total?`Habit kept on ${hab.kept} of ${hab.total} trading day${hab.total===1?'':'s'}.`:'';
  const fig=it.gone?`It no longer shows up in your last ${win} days (it was ${wlMo(base)}).`:`Your last ${win} days now show ${wlMo(cur)}, from ${wlMo(base)} when you started.`;
  if(days<WL_WAIT)return {state:'checking',head:'Checking',pct:days/WL_WAIT,lines:[hl,`Day ${days+1} of ${WL_WAIT}. It was ${wlMo(base)} when you started.`].filter(Boolean),
    note:`The ${win}-day figure moves slowly: most of the window is still from before you started.`,fix:false};
  const ok=it.gone||!(base>0)||cur<=0.5*base;
  return {state:ok?'ok':'meh',head:ok?'Shrinking':'Not shrinking yet',lines:[hl,fig].filter(Boolean),note:ok?'Mark it fixed when you’re ready; it comes back if it grows back.':'Keep going, or drop it for the next item.',fix:true};
}

// ---- on the device: the inputs, memoized per game ----
let _wlMemo={key:null,items:null};
function wlItems(D){
  const g=D&&D.g; if(!g||!g.ctx)return [];
  const key=(typeof _gameKey==='function'?_gameKey():'')+'|'+(g.ctx.closed||[]).length+'|'+(typeof rfWeightsKey==='function'?rfWeightsKey():'')+'|'+(RFD.d?RFD.d.at:'');
  if(_wlMemo.key===key)return _wlMemo.items;
  let items=[];
  try{ const now=Date.now(), from=now-WL_DAYS*WL_DAY, closed=g.ctx.closed||[], recent=closed.filter(t=>t.closeTime>=from);
    const first=recent.reduce((m,t)=>Math.min(m,t.closeTime),now), span=Math.max(30,Math.min(WL_DAYS,(now-first)/WL_DAY));
    let fees=null; try{ fees=feeTierModel(g.ctx.trades,now); }catch(e){}
    let leak30=[]; try{ leak30=pzLeakMap(g,30); }catch(e){}
    const feed=rfData();
    items=wlCollect({span,slips:rfMySlips(closed,g.days.map(d=>d.behavior),{days:WL_DAYS,now}),findings:pzRangeFindings(g.ctx,from,true).findings,
      fees,beh:PZ_BEH,plug:PZ_PLUG,group:feed&&feed.slips,leak30}); }
  catch(e){ console.warn('work list',e); }
  _wlMemo={key,items}; return items;
}
function wlState(){ const s=settings.pzWork; return s&&typeof s==='object'?s:{}; }
async function wlSave(fn){ const s=JSON.parse(JSON.stringify(wlState())); for(const k of ['on','fixed','snooze'])if(!s[k]||typeof s[k]!=='object')s[k]={};
  fn(s); settings.pzWork=s; await Store.set(S_KEY,settings); }
function wlLists(D){ return wlResolve(wlItems(D),wlState(),typeof pzPlugs==='function'?pzPlugs():[],Date.now()); }
// the top of Up next (the first look reads it), null when the list is off or empty
function wlTop(D){ if(!wlActive())return null; try{ return wlLists(D).next[0]||null; }catch(e){ return null; } }
// the coach line's fallback (pzCoachLine): what to do today about what you're working on, else about the top item.
// With the card on Today it says only what the card doesn't (the action), so the two never repeat each other.
function wlCoachLine(D){
  if(!wlActive())return null; let L; try{ L=wlLists(D); }catch(e){ return null; }
  const w=L.working.find(x=>x.action), nx=L.next[0], card=typeof pzShow!=='function'||pzShow('today','work');
  if(w)return 'Working on it today: '+w.action;
  if(!nx||!nx.action)return null;
  return card?'Up next on your work list, try this: '+nx.action:'Top of your work list: '+nx.title.charAt(0).toLowerCase()+nx.title.slice(1)+', about '+usdPlain(nx.month)+' a month. '+nx.action;
}
// memoized per game and item start, so drawing Today doesn't resample on every render
let _wlChk={key:null,m:new Map()};
function wlCheck(D, x){
  const gk=(typeof _gameKey==='function'?_gameKey():'')+'|'+dayKey(Date.now()); if(_wlChk.key!==gk)_wlChk={key:gk,m:new Map()};
  const ck=x.key+'|'+x.since+'|'+(x.on?(x.on.hab||x.on.hid)+'|'+x.on.month:'')+'|'+(x.plug?x.plug.cleanRun:'')+'|'+(x.gone?0:Math.round(x.month||0));
  if(!_wlChk.m.has(ck))_wlChk.m.set(ck,wlCheckNow(D,x));
  return _wlChk.m.get(ck);
}
function wlCheckNow(D, x){
  const now=Date.now();
  if(x.plug){ try{ return wlSlipVerdict(wlSlipCheck(D.g.ctx.closed,D.g.days.map(d=>d.behavior),x.slip,x.since,{now}),x.since,now); }catch(e){ console.warn('work check',e); return null; } }
  let hab=null; const h=x.on&&(x.on.hab||x.on.hid)&&habitById(x.on.hab||x.on.hid);
  if(h&&!h.retired)try{ const res=habitProgress(h,D.g.ctx).res||[]; hab={kept:res.filter(r=>r.kept).length,total:res.length}; }catch(e){}
  return wlTrendVerdict(x,hab,now);
}
// first seen on this device, for "New this week" (localStorage, like Finding of the week's history)
function wlSeen(items){ let s={}; try{ s=JSON.parse(localStorage.getItem(WL_SEEN)||'{}')||{}; }catch(e){}
  const today=dayKey(Date.now()); let ch=false; for(const it of items)if(!s[it.key]){ s[it.key]=today; ch=true; }
  if(ch)try{ localStorage.setItem(WL_SEEN,JSON.stringify(s)); }catch(e){}
  return s; }
const wlIsNew=(seen,k)=>!!seen[k]&&isoWeekOfKey(seen[k])===isoWeekOfKey(dayKey(Date.now()));

// ---- drawing ----
const WL_TAG={working:['Working on','info'],new:['Leak','leak'],snoozed:['Not now',''],keep:['Keep doing','edge'],fixed:['Fixed','win']};
function wlAmt(x){ if(x.gone||!x.month)return ''; const c=!WL_CONF[x.conf]?'var(--pz-soft)':x.month<0?PZ_COL.low:PZ_COL.good; // an early signal isn't sure: no alarm colour
  return `<b style="color:${c};white-space:nowrap;font-size:15px">${x.month<0?'−':'+'}${esc(usdPlain(x.month))}<span class="pz-sub" style="font-size:11px;font-weight:400">/mo</span></b>`; }
function wlRow(x, i){
  const sub=x.stage==='fixed'?'Fixed'+(x.fixedAt?' '+(typeof x.fixedAt==='number'?dayLabel(dayKey(x.fixedAt)):dayLabel(x.fixedAt)):'')
    :x.stage==='snoozed'?'Back '+dayLabel(dayKey(x.until))+', or sooner if it grows'
    :x.back?'It’s back':confWords(x.conf).replace(/ —.*$/,'')+(x.n?' · '+x.n+' trade'+(x.n===1?'':'s'):'');
  return `<a class="pz-ins" href="${wlHref(x.key)}" style="text-decoration:none;color:inherit;align-items:center">${i!=null?`<b style="font-size:18px;color:var(--pz-muted);width:14px;text-align:center">${i}</b>`:''}
    <span style="flex:1;min-width:0;display:flex;flex-direction:column;gap:2px"><b style="font-size:14px;line-height:1.3">${esc(x.title)}</b><span class="pz-sub" style="font-size:12px">${esc(sub)}</span></span>${x.stage==='fixed'?`<span class="pz-tag win">Fixed</span>`:wlAmt(x)}${pzI('chev',14)}</a>`;
}
function wlCheckHtml(D, x, full){
  const v=wlCheck(D,x); if(!v)return '';
  const col=v.state==='ok'?PZ_COL.good:v.state==='bad'?PZ_COL.low:v.state==='meh'?PZ_COL.mid:PZ_COL.xp;
  const plug=x.plug?`<span class="pz-plug"><span class="pz-steps">${[0,1,2].map(i=>`<i class="${i<x.plug.cleanRun?'on':''}"></i>`).join('')}</span><span class="pz-sub" style="font-size:12px">${x.plug.cleanRun} of 3 clean trading weeks · ${esc(pzPlugWeekNote(x.plug))}</span></span>`:'';
  return `<div class="pz-kv" style="gap:6px"><span class="pz-lbl" style="color:${col}">${esc(v.head)}</span>${v.state==='checking'?pzBar(v.pct,PZ_COL.xp):''}
    ${(full?v.lines:v.lines.slice(0,1)).map(l=>`<span style="font-size:13px;line-height:1.4">${esc(l)}</span>`).join('')}${plug}
    ${full?`<span class="pz-fine">${esc(v.note)}</span>`:''}
    ${full?`<div style="display:flex;gap:8px;flex-wrap:wrap">${v.fix&&!x.plug?`<button type="button" class="${v.state==='ok'?'pz-cta':'pz-ghost'} pz-sm" data-wl="fix" data-k="${esc(x.key)}" style="width:auto;padding:0 16px">Mark as fixed</button>`:''}<button type="button" class="pz-ghost pz-sm" data-wl="drop" data-k="${esc(x.key)}" style="width:auto;padding:0 16px">Stop working on it</button></div>`:''}</div>`;
}
// Today: what you're working on, and the one up next
function wlCardHtml(D){
  if(!wlActive())return '';
  const L=wlLists(D), w=L.working[0], nx=L.next[0]; if(!w&&!nx)return '';
  const seen=wlSeen(L.next), total=L.working.length+L.next.length+L.watching.length;
  return `<section class="pz-card pz-kv" aria-labelledby="wlT"><div class="pz-kvrow"><b id="wlT" class="pz-kvh">What to work on</b>${nx&&wlIsNew(seen,nx.key)?'<span class="pz-tag caution">New this week</span>':''}</div>
    ${w?`<a href="${wlHref(w.key)}" style="text-decoration:none;color:inherit;display:flex;flex-direction:column;gap:6px"><span class="pz-lbl" style="color:${PZ_COL.xp}">Working on${L.working.length>1?' · 1 of '+L.working.length:''}</span><b style="font-size:15px;line-height:1.3">${esc(w.title)}</b></a>${wlCheckHtml(D,w,false)}`:''}
    ${nx?`<div class="pz-kv" style="gap:4px;${w?'padding-top:10px;border-top:1px solid var(--pz-line)':''}"><span class="pz-lbl">${w?'Up next':'Start here'}</span>
      <a href="${wlHref(nx.key)}" style="text-decoration:none;color:inherit;display:flex;gap:10px;align-items:center"><span style="flex:1;min-width:0;display:flex;flex-direction:column;gap:2px"><b style="font-size:15px;line-height:1.3">${esc(nx.title)}</b><span class="pz-sub" style="font-size:12px">${esc(confWords(nx.conf))}${nx.back?' · it’s back':''}</span></span>${wlAmt(nx)}</a></div>`:''}
    <a class="pz-link" href="#work" style="min-height:0">Your work list${total>1?' · '+total+' items':''}${pzI('chev',14)}</a></section>`;
}
function wlSect(title, sub, rows){ return `<section class="pz-card pz-kv" style="padding-bottom:6px"><div class="pz-kvrow"><b class="pz-kvh">${esc(title)}</b>${sub?`<span class="pz-sub" style="font-size:12px">${esc(sub)}</span>`:''}</div>${rows}</section>`; }
// #work: the whole list
function wlScreenHtml(D){
  const arg=pzHashArg(); if(arg){ let k=arg; try{ k=decodeURIComponent(arg); }catch(e){} return wlItemHtml(D,k); }
  const back=`<a class="pz-back" href="#today">${pzI('back',20)}Today</a>`, head=pzHead('From your last 90 days','Work list');
  const L=wlLists(D);
  const working=L.working.length?L.working.map(x=>`<div class="pz-kv" style="gap:6px;padding:10px 0;border-top:1px solid var(--pz-line)"><a href="${wlHref(x.key)}" style="text-decoration:none;color:inherit;display:flex;gap:8px;align-items:center"><b style="flex:1;font-size:15px;line-height:1.3">${esc(x.title)}</b>${pzI('chev',14)}</a>${wlCheckHtml(D,x,false)}</div>`).join('')
    :`<p class="pz-sub" style="margin:0;font-size:13px">${L.next.length?'Nothing yet. Start with the top of Up next.':'Nothing yet.'}</p>`;
  const next=L.next.length?L.next.map((x,i)=>wlRow(x,i+1)).join(''):`<p class="pz-sub" style="margin:0;font-size:13px">${(D.g.ctx.closed||[]).length<20?'It needs more closed trades to say anything sure.':'Nothing your last 90 days can show for sure. Keep it that way.'}</p>`;
  const left=wlSect('Working on','',working)+wlSect('Up next','ranked',next);
  const right=(L.watching.length?wlSect('Watching','early signals',`<p class="pz-fine" style="margin:0">Too few trades to tell from luck yet. They join the ranking once the numbers firm up.</p>${L.watching.map(x=>wlRow(x)).join('')}`):'')
    +(L.snoozed.length?wlSect('Not now','',L.snoozed.map(x=>wlRow(x)).join('')):'')
    +(L.keep.length?wlSect('Keep doing','your edges',L.keep.map(x=>wlRow(x)).join('')):'')
    +wlSect('What you fixed','',L.fixed.length?L.fixed.map(x=>wlRow(x)).join(''):'<p class="pz-sub" style="margin:0;font-size:13px">Nothing yet. Three clean trading weeks fix a slip; you mark the rest.</p>')
    +`<section class="pz-card pz-kv"><b class="pz-kvh">How the list is ranked</b><p class="pz-sub" style="margin:0;font-size:13px">Each item has one figure: about how many dollars a month it moves, over your last 90 days. A slip is measured against your own trades that had the same chance and didn’t take it, so it doesn’t count losses the trade would have had anyway. The rank is that figure × how sure the numbers are (very likely 1, probably 0.7) × how much is in your hands (habits 1, fees 0.9, what and when you trade 0.8). Live alerts, like a loss limit hit today, stay at the top of Today and never wait here.</p></section>`;
  return `${back}${head}<div class="pz-wide"><div class="pz-col">${left}</div><div class="pz-col">${right}</div></div>`;
}
// #work/<key>: one item
function wlItemHtml(D, key){
  const back=`<a class="pz-back" href="#work">${pzI('back',20)}Work list</a>`, L=wlLists(D);
  const all=[...L.working,...L.next,...L.watching,...L.snoozed,...L.keep,...L.fixed], x=all.find(i=>i.key===key);
  if(!x)return `${back}${pzHead('Work list','Not on your list')}<section class="pz-card"><p class="pz-sub" style="margin:0">This item isn’t in your last 90 days any more.</p></section>`;
  const st=wlState(), stage=x.stage, [tagT,tagC]=x.back&&stage==='new'?['It’s back','leak']:x.kind==='edge'?WL_TAG.keep:x.conf==='early'&&stage==='new'?['Watching','caution']:WL_TAG[stage]||WL_TAG.new;
  const rank=L.next.findIndex(i=>i.key===key), H=[];
  if(x.plug)H.push([x.plug.from,'You started plugging it']);
  if(x.on)H.push([dayKey(x.on.at),'You started working on it'+(x.on.month?' ('+wlMo(x.on.month)+')':'')]);
  if(st.snooze&&st.snooze[key])H.push([dayKey(st.snooze[key].until-WL_SNOOZE*WL_DAY),'Not now']);
  if(stage==='fixed'&&x.fixedAt)H.push([typeof x.fixedAt==='number'?dayKey(x.fixedAt):x.fixedAt,'Fixed']);
  let act='';
  if(x.kind==='leak'&&(stage==='new'||stage==='snoozed')&&!x.gone){
    if(WL.ask===key)act=`<div class="pz-kv" style="gap:8px;padding:12px;border-radius:14px;background:var(--pz-card2)"><span style="font-size:13px">You’re already working on ${L.working.length===1?'“'+esc(L.working[0].title)+'”':L.working.length+' things'}. One at a time tends to stick better.</span>
      <div style="display:flex;gap:8px;flex-wrap:wrap"><button type="button" class="pz-cta pz-sm" data-wl="start" data-k="${esc(key)}" data-force="1" style="width:auto;padding:0 16px">Start it too</button><button type="button" class="pz-ghost pz-sm" data-wl="cancel" style="width:auto;padding:0 16px">Not yet</button></div></div>`;
    else act=`<div style="display:flex;gap:8px;flex-wrap:wrap"><button type="button" class="pz-cta" data-wl="start" data-k="${esc(key)}" style="flex:1"${WL.busy?' disabled':''}>Work on this</button>${stage==='new'&&WL_CONF[x.conf]?`<button type="button" class="pz-ghost" data-wl="snooze" data-k="${esc(key)}" style="flex:1">Not now</button>`:''}</div>`; }
  const fig=x.gone?'':`<div><div style="font-family:var(--pz-num);font-size:34px;font-weight:600;line-height:1.05;color:${!WL_CONF[x.conf]?'var(--pz-soft)':x.month<0?PZ_COL.low:PZ_COL.good}">About ${x.month<0?'':'+'}${esc(usdPlain(x.month))} a month</div><p class="pz-sub" style="margin:4px 0 0;font-size:13px">${esc(x.body||'')}</p></div>`;
  return `${back}<div class="pz-wide"><div class="pz-col"><section class="pz-card pz-kv">
      <div class="pz-kvrow"><span class="pz-tag ${tagC}">${esc(tagT)}</span>${rank>=0?`<span class="pz-sub" style="font-size:12px">#${rank+1} of ${L.next.length}</span>`:''}</div>
      <b style="font-size:19px;line-height:1.3">${esc(x.title)}</b>${fig}
      ${x.action?`<div class="pz-kv" style="gap:2px;padding:10px 12px;border-radius:14px;background:var(--pz-card2)"><span class="pz-lbl">${x.kind==='edge'?'Keep doing':'Try'}</span><span style="font-size:14px">${esc(x.action)}</span></div>`:''}
      ${act}${stage==='working'?wlCheckHtml(D,x,true):''}</section></div>
    <div class="pz-col"><section class="pz-card pz-kv">
      ${x.why?`<details class="pz-why"><summary>How sure: ${esc(confWords(x.conf))}</summary><span>${esc(x.why)}</span></details>`:''}
      ${x.other&&x.other.length?`<details class="pz-why"><summary>Other ways to count it (${x.other.length})</summary><span>${x.other.map(o=>`<b>${esc(o[0])}: ${esc(o[1])}</b><br>${esc(o[2])}`).join('<br><br>')}</span></details>`:''}
      ${H.length?`<div class="pz-kv" style="gap:4px"><span class="pz-lbl">History</span>${H.sort((a,b)=>a[0]<b[0]?-1:1).map(h=>`<span style="font-size:13px"><span class="pz-sub">${esc(dayLabel(h[0]))}</span> · ${esc(h[1])}</span>`).join('')}</div>`:''}
      <p class="pz-fine" style="margin:0">Read from your own trades over the last ${x.win||WL_DAYS} days. A pattern, not a promise.</p></section></div></div>`;
}

async function wlClick(t){
  const a=t.dataset.wl; if(!a)return false;
  const key=t.dataset.k, D=pzData(), L=wlLists(D), x=key?[...L.working,...L.next,...L.watching,...L.snoozed,...L.keep,...L.fixed].find(i=>i.key===key):null;
  if(a==='cancel'){ WL.ask=null; pzRender(); return true; }
  if(!x||WL.busy)return true;
  WL.busy=true;
  try{
    if(a==='start'){
      if(L.working.length&&!t.dataset.force){ WL.ask=key; return true; }
      WL.ask=null;
      if(x.slip)await pzPlugStart(x.slip);
      // hab: the habit the check reads; hid: only one this started (adoptHabit hands back a habit you already keep,
      // and stopping here must never retire that one)
      else { let hid=null, hab=null; const spec=x.habit?resolveHabitSpec(x.habit):null;
        if(spec){ const had=new Set(habitsList().map(h=>h.id)), h=await adoptHabit(spec); hab=h&&h.id||null; hid=hab&&!had.has(hab)?hab:null; }
        await wlSave(s=>{ s.on[key]={at:Date.now(),month:Math.round(x.month),title:x.title,hid,hab}; delete s.fixed[key]; }); }
      await wlSave(s=>{ delete s.snooze[key]; });
      pzNote(x.slip?'Working on it: three clean trading weeks plug it.':'Working on it. The check starts today.'); }
    else if(a==='snooze'){ await wlSave(s=>{ s.snooze[key]={until:Date.now()+WL_SNOOZE*WL_DAY,month:Math.round(x.month)}; }); pzNote('Put away for two weeks. It comes back sooner if it grows.'); }
    else if(a==='drop'){
      if(x.slip&&x.plug)await pzPlugDrop(x.slip);
      else { const on=wlState().on&&wlState().on[key]; if(on&&on.hid)await retireHabit(on.hid); await wlSave(s=>{ delete s.on[key]; }); }
      pzNote('Stopped. It stays on the list with its history.'); }
    else if(a==='fix'&&!x.slip){ const on=(wlState().on||{})[key]||{};
      await wlSave(s=>{ s.fixed[key]={at:Date.now(),month:Math.round(x.month||0),base:on.month||0,title:x.title}; delete s.on[key]; }); pzNote('Moved to What you fixed. It comes back if it grows back.'); }
  } finally { WL.busy=false; pzRender(); }
  return true;
}
pzFeature({id:'work', today:{label:'What to work on',hint:'Your work list: what you’re working on, and the one thing up next',col:0,after:'insight',html:wlCardHtml},
  tab:{name:'work', nav:'today', arg:/^[^/]+$/, html:wlScreenHtml}, click:wlClick});
