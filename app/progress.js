// Ledger app · part 11 of 15: XP, levels, streaks, achievements, automatic metrics, Pulse growth.
// ledger.html loads the parts in order as classic scripts sharing one global scope. Code that
// runs while a part loads (not inside a function called later) may only use names declared in
// this part or an earlier one; the boot part runs last. See "Development and testing" in README.md.

/* ======================= 10 · PROGRESS: XP, levels, streaks, achievements, challenges ======================= */
// A game layer over the same process days, journal and trades the coach reads. Everything is
// derived — only the week's challenge is stored — so it syncs for free and can't drift.
// Points reward PROCESS, never profit or activity: XP is earned per trading day (a day's process
// score, 0–100), so one well-run trade earns as much as ten; nothing here scores PnL.

const LEVELS=['Rookie','Apprentice','Journeyman','Disciplined','Consistent','Professional','Veteran','Master','Grandmaster','Legend'];
// Level n starts at 200·n·(n−1) XP: 0, 400, 1200, 2400, 4000, 6000 … — a full-effort trading day
// is 100 XP, so early levels take a week or two and the later ones take months of consistency.
// The league owner can reshape this (admin → Levels & XP): another curve base, a table of
// thresholds, their own titles. Without a league config the defaults above apply.
function levelFor(xp){
  const C=pzLevelCfg(), at=n=>n<=1?0:C.mode==='table'?(n-2<C.thresholds.length?C.thresholds[n-2]:Infinity):C.base*n*(n-1);
  let n=1; while(n<1000&&at(n+1)<=xp)n++;
  const T=C.titles&&C.titles.length?C.titles:LEVELS;
  // without a profile, levels stop at the league's cap: the XP still counts, and a profile unlocks it
  const cap=typeof pzGuestCap==='function'?pzGuestCap():0;
  if(cap&&n>cap){ const s=at(cap), nx=at(cap+1);
    return {level:cap, title:T[Math.min(cap,T.length)-1], xp, into:nx-s, need:nx-s, next:nx, max:false, capped:true, earned:n}; }
  const start=at(n), next=at(n+1);
  return {level:n, title:T[Math.min(n,T.length)-1], xp, into:xp-start, need:isFinite(next)?next-start:Math.max(1,xp-start), next, max:!isFinite(next)};
}
// league config (set when Pulse loads /api/social/config); defaults otherwise
var PZ_CFG={rev:0,levels:null,xp:null};
// XP where level n starts, under the league's level settings (the same steps levelFor uses)
function pzLevelStart(n){ const C=pzLevelCfg(); return n<=1?0:C.mode==='table'?(n-2<C.thresholds.length?C.thresholds[n-2]:Infinity):C.base*n*(n-1); }
function pzLevelCfg(){ const c=PZ_CFG.levels; return c&&(c.mode==='table'||c.base>0)?c:{mode:'curve',base:200,thresholds:[],titles:LEVELS}; }
const PZ_XP_DEF={discipline:1,checkin:10,plan:15,journal:15,stops:10,limit:10,review:15,achievement:50,challenge:150,focus:25};
function pzXpCfg(){ return Object.assign({},PZ_XP_DEF,PZ_CFG.xp||{}); }
function pzLevelTitle(n){ const T=pzLevelCfg().titles; const t=T&&T.length?T:LEVELS; return t[Math.min(n,t.length)-1]; }
// ISO week ('GGGG-Www') of a 'YYYY-MM-DD' calendar key — pure, no clock or tz involved.
function isoWeekOfKey(k){
  const d=new Date(k+'T00:00:00Z'); d.setUTCDate(d.getUTCDate()-((d.getUTCDay()+6)%7)+3);
  const ft=new Date(Date.UTC(d.getUTCFullYear(),0,4)); ft.setUTCDate(ft.getUTCDate()-((ft.getUTCDay()+6)%7)+3);
  return d.getUTCFullYear()+'-W'+String(1+Math.round((d-ft)/(7*86400000))).padStart(2,'0');
}
// Good-process streak that forgives. Days without trades never count either way; a finished
// perfect week (every trading day 70+, at least 3 of them) earns a shield (max 2) that absorbs
// one missed day instead of resetting the streak. The current week earns only once it's over.
function disciplineStreak(days, nowWeek){
  let cur=0, best=0, shields=0, wk=null, wkDays=[];
  const shielded=[], perfectWeeks=[];
  const closeWeek=()=>{ if(wk&&wkDays.length>=3&&wkDays.every(d=>d.score>=70)){ perfectWeeks.push({week:wk,key:wkDays[wkDays.length-1].key}); shields=Math.min(2,shields+1); } };
  for(const d of days){
    const w=isoWeekOfKey(d.key);
    if(w!==wk){ closeWeek(); wk=w; wkDays=[]; }
    wkDays.push(d);
    if(d.score>=70)cur++;
    else if(shields>0&&cur>0){ shields--; shielded.push(d.key); }
    else cur=0;
    if(cur>best)best=cur;
  }
  if(wk&&wk!==nowWeek)closeWeek();
  return {current:cur, best, shields, shielded, perfectWeeks};
}
function xpLedger(days, bonuses){
  const byDay={}; let total=0;
  for(const d of days){ byDay[d.key]=(byDay[d.key]||0)+d.score; total+=d.score; }
  for(const b of (bonuses||[])){ byDay[b.key]=(byDay[b.key]||0)+b.xp; total+=b.xp; }
  return {total, byDay};
}
// The n-th time a condition held, in date order: its day key (null if it never got there).
function nthKey(keys, n){ const k=[...keys].sort(); return k.length>=n?k[n-1]:null; }
// Achievements for moments that are hard in real trading. g = the assembled game inputs.
function gameAchievements(g){
  const A=[];
  const add=(id,title,desc,glyph,n,of,at)=>A.push({id,title,desc,glyph,n:Math.min(n,of),of,at:n>=of?at:null});
  const closeKey=new Map(g.closed.map(t=>[t.id,g.dayOf(t.closeTime)]));
  const liveKeys=g.pa.items.filter(x=>x.live===true).map(x=>closeKey.get(x.id)).filter(Boolean);
  add('first-live','First live plan','Write a trade’s stop while the position is still open.','▲',liveKeys.length,1,nthKey(liveKeys,1));
  const planKeys=g.days.filter(d=>d.parts.plan===1).map(d=>d.key);
  add('plan-10','Plan before the bell','File the day’s plan before the first entry on 10 trading days.','▤',planKeys.length,10,nthKey(planKeys,10));
  const walked=g.days.filter(d=>d.breached&&d.parts.limit===1).map(d=>d.key);
  add('walked-away','Walked away at the limit','Hit your daily loss limit and open nothing else that day.','⏹',walked.length,1,nthKey(walked,1));
  const sat=[];
  for(const k in g.byDay){ const a=[...g.byDay[k]].sort((x,y)=>x.closeTime-y.closeTime);
    for(let i=1;i<a.length;i++) if(isLoss(a[i-1].net)&&isLoss(a[i].net)&&!a.some(t=>t.openTime>a[i].closeTime)){ sat.push(k); break; } }
  add('sat-out','Sat out after two losses','Two losses in a row, then no new trades that day.','⏸',sat.length,1,nthKey(sat,1));
  const goodLoss=g.days.filter(d=>d.score>=70&&d.net<0).map(d=>d.key);
  add('good-losses','Ten good losses','Ten red days where you still followed your process.','◆',goodLoss.length,10,nthKey(goodLoss,10));
  // stops honored in a row, in close order
  const closeT=new Map(g.closed.map(t=>[t.id,t.closeTime]));
  const planned=g.pa.items.map(x=>({x,k:closeKey.get(x.id),t:closeT.get(x.id)||0})).sort((a,b)=>a.t-b.t);
  let run=0, bestRun=0, runAt=null;
  for(const p of planned){ run=p.x.stopHonored?run+1:0; if(run>bestRun){ bestRun=run; if(run===20)runAt=p.k; } }
  add('stops-20','Twenty stops honored','Honor 20 planned stops in a row.','■',bestRun,20,runAt);
  A.stopsBest=bestRun; // gameContext reuses this run instead of recomputing it
  add('journal-30','Thirty-day journal','Journal every trade for 30 trading days in a row.','✎',g.journalRun.best,30,g.journalRun.at30);
  const jKeys=g.closed.filter(t=>isJournaled(g.J[t.id])).sort((a,b)=>a.closeTime-b.closeTime).map(t=>g.dayOf(t.closeTime));
  add('journal-100','A hundred entries','Journal 100 closed trades.','≡',jKeys.length,100,jKeys.length>=100?jKeys[99]:null);
  const ckKeys=g.days.filter(d=>{ const e=g.J['day:'+d.key]; return !!(e&&(e.sleep||e.stress||e.focus)); }).map(d=>d.key);
  add('checkin-20','Know thyself','Do your prep on 20 trading days.','◎',ckKeys.length,20,nthKey(ckKeys,20));
  add('perfect-week','Perfect week','Every trading day of a week at process 70+ (at least three days).','★',g.streak.perfectWeeks.length,1,g.streak.perfectWeeks.length?g.streak.perfectWeeks[0].key:null);
  add('kept-month','Kept it for a month','A rule with no breaks for 30 days, or a habit kept 20 trading days in a row.','✓',g.keptMonth.length?1:0,1,nthKey(g.keptMonth,1));
  const doneCh=g.challenges.filter(c=>c.status==='done').map(c=>c.key);
  add('challenge-1','Challenge accepted','Complete a weekly challenge.','⚑',doneCh.length,1,nthKey(doneCh,1));
  add('challenge-5','Five for five','Complete five weekly challenges.','⚐',doneCh.length,5,nthKey(doneCh,5));
  return A;
}
// "Keeping your rules has saved an estimated $X": for each rule/avoid-habit, the trades you'd
// have taken at the old rate, minus the ones you actually took, times what they averaged before.
// Only counted when the condition lost money before and you now break it less.
function disciplineSaved(closed, items){
  const out=[]; let total=0;
  for(const it of (items||[])){ if(!it.pred)continue;
    const ft=ruleFollowThrough(closed,it.pred,it.createdAt);
    const b=ft.before, a=ft.after;
    if(b.v<5||!(b.net<0)||a.n<5||a.rate==null||b.rate==null||!(a.rate<b.rate))continue;
    const avoided=(b.rate-a.rate)*a.n, saved=avoided*(-b.net/b.v);
    out.push({name:it.name, avoided, saved}); total+=saved; }
  return {total, items:out.sort((x,y)=>y.saved-x.saved)};
}
function personalBests(days, streak, stopsBest, journalBest, nowWeek){
  const byWk={}; for(const d of days){ const w=isoWeekOfKey(d.key); (byWk[w]=byWk[w]||[]).push(d.score); }
  let best=null, bestWk=null;
  for(const w in byWk){ if(w===nowWeek||byWk[w].length<3)continue; const v=_avg(byWk[w]); if(best==null||v>best){ best=v; bestWk=w; } }
  const cur=byWk[nowWeek]&&byWk[nowWeek].length>=3?_avg(byWk[nowWeek]):null;
  return [
    {id:'week',label:'Best process week',value:best!=null?Math.round(best):null,when:bestWk,current:cur!=null?Math.round(cur):null,isNew:cur!=null&&best!=null&&cur>best},
    {id:'streak',label:'Longest discipline streak',value:streak.best,unit:'days',current:streak.current,isNew:streak.current>0&&streak.current>=streak.best&&streak.best>=5},
    {id:'stops',label:'Stops honored in a row',value:stopsBest,unit:'trades'},
    {id:'journal',label:'Longest journaling run',value:journalBest,unit:'days'},
  ];
}
const GRADE=v=>v==null?null:v>=0.9?'A':v>=0.75?'B':v>=0.6?'C':v>=0.4?'D':'F';
const PART_NAME={plan:'Plan before the first entry',rules:'Rules kept',planned:'Stops written live',stops:'Stops honored',limit:'Loss limit respected',journal:'Trades journaled'};
// One month's process report card: an overall grade, a grade per habit, and the change vs the
// previous month that had trading days. No dollar amounts, by design — it's made to be shared.
function monthlyReport(days, month){
  const inM=m=>days.filter(d=>d.key.slice(0,7)===m);
  const cur=inM(month); if(!cur.length)return null;
  const months=[...new Set(days.map(d=>d.key.slice(0,7)))].sort();
  const pm=months.filter(m=>m<month).pop(), prev=pm?inM(pm):[];
  const partAvg=(arr,p)=>{ const v=arr.map(d=>d.parts[p]).filter(x=>x!=null); return v.length?_avg(v):null; };
  const parts=Object.keys(PROCESS_W).map(p=>{ const v=partAvg(cur,p), pv=partAvg(prev,p);
    return {part:p, name:PART_NAME[p], value:v, grade:GRADE(v), delta:v!=null&&pv!=null?v-pv:null}; }).filter(x=>x.value!=null);
  const avg=_avg(cur.map(d=>d.score)), pavg=prev.length?_avg(prev.map(d=>d.score)):null;
  return {month, prevMonth:pm||null, days:cur.length, good:cur.filter(d=>d.score>=70).length, avg, grade:GRADE(avg/100),
    delta:pavg!=null?avg-pavg:null, parts};
}

// ---- weekly challenge: one concrete target a week, drawn from your biggest leak ----
const CHALLENGE_DEFAULTS=['journal-all','plan-first','stop-live','honor-stop','cool-off'];
// what a challenge actually tests — two specs with the same key are the same challenge
function specKey(sp){ return !sp?'':sp.kind==='avoid'?'pid:'+sp.pid:sp.kind==='process'?'part:'+sp.part:sp.kind==='cap'?'cap:'+(sp.cap||3):'tpl:'+sp.tpl; }
function challengeCandidates(findings){
  const out=[], seen=new Set();
  const push=spec=>{ if(!spec)return; const id=specKey(spec); if(seen.has(id))return; seen.add(id); out.push(spec); };
  for(const f of (findings||[])) if((f.tone==='leak'||f.tone==='caution')&&f.habit)push(resolveHabitSpec(f.habit));
  for(const tpl of CHALLENGE_DEFAULTS)push(HABIT_LIBRARY.find(h=>h.tpl===tpl));
  return out;
}
function weekChallenge(ms){ const e=journal[isoWeekKey(ms||Date.now())]; return e&&e.challenge&&e.challenge.spec?e.challenge:null; }
async function setWeekChallenge(spec, idx, auto){
  const now=Date.now(), k=isoWeekKey(now), from=lastCompletedWeekRange(now).to;
  let params=spec.params&&Object.keys(spec.params).length?spec.params:null;
  if(spec.pid&&!params){ try{ const chron=allTrades.filter(t=>!t.isOpen&&t.closeTime&&viewFilter(t)).sort((a,b)=>a.closeTime-b.closeTime);
    params=minerFams(chron,tradeStates(chron)).__params||null; }catch(e){} }
  const e={...(journal[k]||{})};
  e.challenge={spec:{kind:spec.kind,tpl:spec.tpl||null,pid:spec.pid||null,part:spec.part||null,cap:spec.cap||null,params:params||{},when:spec.when,then:spec.then},
    idx:idx||0, from, to:addDays(from,7), createdAt:now}; // addDays: a DST week is 167 or 169 hours
  e.updatedAt=now; journal[k]=e;
  // auto picks aren't marked dirty, so the 409 merge keeps the server's version of the week
  // (a challenge the user picked on another device) instead of this device's automatic one
  if(!auto)markJEdit(k); else _jrev++;
  await Store.set(J_KEY,journal);
}
// Picks this week's challenge once (first time the coach runs in a new week). Idempotent.
async function ensureWeekChallenge(ctx){
  if(!coachOn()||weekChallenge()||ctx.closed.length<5)return false;
  const c=challengeCandidates(ctx.findings); if(!c.length)return false;
  const last=weekChallenge(Date.now()-7*86400000), lastId=last&&specKey(last.spec);
  let i=c.findIndex(x=>specKey(x)!==lastId); if(i<0)i=0; // variety: not last week's again
  await setWeekChallenge(c[i],i,true); return true;
}
function challengeResults(ch, ctx, pred){
  const fromKey=dayKey(ch.from), toKey=dayKey(ch.to);
  return habitDayResults(ch.spec,ctx.days,ctx.byDay,pred,fromKey,journal).filter(r=>r.key<toKey);
}
function challengeStatus(res, ended){
  const kept=res.filter(r=>r.kept).length, missed=res.length-kept;
  if(!ended)return missed?'missed':'on track';
  return res.length>=2&&!missed?'done':res.length<2?'too few days':'missed';
}

// ---- everything the progress panel needs, memoized with the coach context ----
let _gameMemo={key:null,g:null};
function gameContext(){
  const ctx=coachContext();
  const key=_coachMemo.key+'|'+_jrev+'|'+PZ_CFG.rev+'|'+(typeof SOC!=='undefined'&&SOC.me&&SOC.me.mult?JSON.stringify(SOC.me.mult.hist||{}):'')+'|'+(typeof SOC!=='undefined'&&SOC.me&&SOC.me.mentorXp?SOC.me.mentorXp.total:0)+'|'+(Array.isArray(settings.pzGoals)?settings.pzGoals.filter(x=>x&&x.done).length:0)+'|'+(typeof pzGuestCap==='function'?pzGuestCap():0);
  if(_gameMemo.key===key)return _gameMemo.g;
  const X=pzXpCfg();
  const now=Date.now(), nowWeek=isoWeekOfKey(dayKey(now));
  // A day's score is its Discipline score, read from fills (pzBehaviorDays). Anything logged —
  // check-in, plan, journal, stops, a respected loss limit — adds bonus XP on top and never
  // lowers the score. The process parts ride along for achievements and the report card.
  const pmap=new Map(ctx.days.map(d=>[d.key,d]));
  const days=pzBehaviorDays(ctx.closed,{dayOf:dayKey,isLoss:PZ_LOSS}).map(b=>{ const p=pmap.get(b.key)||null;
    const bonus=pzBonus(p,journal['day:'+b.key],X);
    return {key:b.key,score:b.score,n:b.n,net:b.net,behavior:b,parts:p?p.parts:{},breached:p?p.breached:false,process:p?p.score:null,bonus}; });
  _pzSlipDays=new Map(days.map(d=>[d.key,d.behavior])); // 'slip' habits (plugging a leak) read their days from here
  const streak=disciplineStreak(days,nowWeek);
  const pa=planAdherence(ctx.closed,journal,_excM);
  // journaling runs over trading days (for the 30-day achievement and personal bests)
  let jr=0, jBest=0, at30=null;
  for(const k of Object.keys(ctx.byDay).sort()){ const full=ctx.byDay[k].every(t=>isJournaled(journal[t.id]));
    jr=full?jr+1:0; if(jr>jBest)jBest=jr; if(jr===30&&!at30)at30=k; }
  // challenges: every stored week with one, graded; predicates for 'avoid' kinds
  const challenges=[];
  const predFor=spec=>{ if(spec.kind!=='avoid'||!spec.pid)return null;
    try{ const P=customRulePreds(ctx.trades,[{pid:spec.pid,name:'',params:spec.params||{},createdAt:0}]); return P[0]&&P[0].pred; }catch(e){ return null; } };
  for(const k of Object.keys(journal).filter(k=>k.startsWith('week:')&&journal[k]&&journal[k].challenge).sort()){
    const ch=journal[k].challenge; if(!ch||!ch.spec)continue;
    const res=challengeResults(ch,ctx,predFor(ch.spec)); const ended=now>=ch.to;
    challenges.push({key:dayKey(Math.min(ch.to-1,now)),week:k.slice(5),ch,res,status:challengeStatus(res,ended),ended}); }
  // kept for a month: rules with 30 clean days, or habits kept 20 trading days running
  const keptMonth=[];
  for(const x of (ctx.rulePreds||[])){ const r=x.rule; if(!x.pred||!(r.createdAt<=now-30*86400000))continue;
    const after=ctx.closed.filter(t=>t.openTime>=r.createdAt);
    if(after.length>=10&&!after.some(x.pred))keptMonth.push(dayKey(r.createdAt+30*86400000)); }
  for(const h of habitsList()){ const res=habitProgress(h,ctx).res; let run=0;
    for(const r of res){ run=r.kept?run+1:0; if(run===20){ keptMonth.push(r.key); break; } } }
  const J=journal;
  const achievements=gameAchievements({days,closed:ctx.closed,byDay:ctx.byDay,J,pa,dayOf:dayKey,
    journalRun:{best:jBest,at30},streak,keptMonth,challenges});
  // XP: the day's Discipline score plus its logging bonus, plus achievements, challenges and focus-habit days
  const bonuses=[];
  for(const a of achievements) if(a.at)bonuses.push({key:a.at,xp:X.achievement,why:a.title});
  for(const c of challenges) if(c.status==='done')bonuses.push({key:c.key,xp:X.challenge,why:'challenge'});
  for(const k of Object.keys(journal).filter(k=>k.startsWith('week:')&&journal[k]&&journal[k].focus)){
    const h=habitById(journal[k].focus); if(!h)continue;
    for(const r of habitProgress(h,ctx).res) if(r.kept&&isoWeekOfKey(r.key)===k.slice(5))bonuses.push({key:r.key,xp:X.focus,why:'focus habit'}); }
  // from the league: XP the owner granted, and their reward badges that carry XP
  const me=typeof SOC!=='undefined'&&SOC.me;
  if(me){ for(const gr of (me.grants||[]))bonuses.push({key:dayKey(gr.at),xp:gr.xp,why:gr.why||'league bonus',src:'grant'});
    for(const a of (me.awards||[]))if(a.xp)bonuses.push({key:dayKey(a.at),xp:a.xp,why:a.name,src:'award'});
    // mentoring: XP the server paid for reviews, notes and mentees' results, per day (levels only: never leagues or duels)
    for(const [k,d] of Object.entries((me.mentorXp&&me.mentorXp.days)||{}))if(d&&d.xp>0)bonuses.push({key:k,xp:d.xp,why:'mentoring',src:'mentor'}); }
  // the XP multiplier (Trader Age, verified by the server): each week's daily XP times the multiplier that
  // week had; achievements, badges, challenges and grants pay what they say. Leagues and duels get the XP
  // before the multiplier (xpBase), so a newcomer can still win a week; mentoring XP stays out of it too.
  const MH=(me&&me.mult&&me.mult.hist)||{}, multOf=k=>{ const v=+MH[isoWeekOfKey(k)]; return v>1?v:1; };
  const baseRows=days.map(d=>({key:d.key,score:Math.round(d.score*X.discipline)+d.bonus.total}));
  const dayRows=baseRows.map(r=>({key:r.key,score:Math.round(r.score*multOf(r.key))}));
  let led=xpLedger(dayRows,bonuses), lv=levelFor(led.total);
  // the badge catalog reads the game so far; its badges then add their own XP on the day they're earned
  let catalog=null;
  try{ const G0={ctx,days,streak,pa,achievements,challenges,journalBest:jBest,stopsBest:achievements.stopsBest||0,now,nowWeek};
    catalog=pzBadgeCatalog(Object.assign({},G0,{xp:led.total,xpByDay:led.byDay,level:lv.level}));
    if(catalog.earned.length){
      // the XP and level badges count badge XP too: a second pass reads the total including the first pass's badges
      const first=catalog.earned.filter(b=>b.xp).map(b=>({key:b.k,xp:b.xp,why:b.t,src:'badge'}));
      const led1=xpLedger(dayRows,bonuses.concat(first));
      catalog=pzBadgeCatalog(Object.assign({},G0,{xp:led1.total,xpByDay:led1.byDay,level:levelFor(led1.total).level}));
      for(const b of catalog.earned)if(b.xp)bonuses.push({key:b.k,xp:b.xp,why:b.t,src:'badge'});
      led=xpLedger(dayRows,bonuses); lv=levelFor(led.total); } }
  catch(e){ console.warn('badges failed',e); }
  const wkFrom=dayKey(lastCompletedWeekRange(now).to);
  const weekXp=Object.keys(led.byDay).filter(k=>k>=wkFrom).reduce((s,k)=>s+led.byDay[k],0);
  const xpBase=xpLedger(baseRows,bonuses.filter(b=>b.src!=='mentor')), weekXpBase=Object.keys(xpBase.byDay).filter(k=>k>=wkFrom).reduce((s,k)=>s+xpBase.byDay[k],0);
  const stopsBest=achievements.stopsBest||0;
  const pbs=personalBests(days,streak,stopsBest,jBest,nowWeek);
  const savedItems=[...(ctx.rulePreds||[]).map(x=>({name:x.rule.name.replace(/^Avoid: /,''),pred:x.pred,createdAt:x.rule.createdAt})),
    ...habitsList().filter(h=>h.kind==='avoid').map(h=>({name:habitSentence(h),pred:ctx.preds[h.id],createdAt:h.createdAt}))];
  const seenPid=new Set(), uniq=[];
  const pidOf=[...(ctx.rulePreds||[]).map(x=>x.rule.pid),...habitsList().filter(h=>h.kind==='avoid').map(h=>h.pid)];
  savedItems.forEach((it,i)=>{ const p=pidOf[i]; if(p&&seenPid.has(p))return; if(p)seenPid.add(p); uniq.push(it); });
  const saved=disciplineSaved(ctx.closed,uniq);
  const cur=challenges.find(c=>!c.ended&&c.week===isoWeekKey(now).slice(5))||null;
  const g={ctx,days,streak,level:lv,xp:led,weekXp,xpBase,weekXpBase,mult:multOf(dayKey(now)),achievements,challenges,current:cur,pbs,saved,stopsBest,journalBest:jBest,nowWeek,bonuses,catalog,pa};
  _gameMemo={key,g}; return g;
}
// New since the start of this week — feeds the coach's wins row.
function gameWins(g){
  const W=[], wkFrom=dayKey(lastCompletedWeekRange().to);
  for(const a of g.achievements) if(a.at&&a.at>=wkFrom)W.push(`Achievement unlocked: ${a.title}`);
  for(const p of g.pbs) if(p.isNew)W.push(`New personal best: ${p.label.toLowerCase()}${p.current!=null?' ('+p.current+(p.unit?' '+p.unit:'')+')':''}`);
  const prev=levelFor(g.xp.total-g.weekXp);
  if(g.level.level>prev.level)W.push(`Level up: ${g.level.title} (level ${g.level.level})`);
  return W;
}

// ---- Review: the progress panel ----
function shieldsHtml(n){ return `<span class="shields" aria-label="${n} streak shield${n===1?'':'s'}">${[0,1].map(i=>`<i class="${i<n?'on':''}"></i>`).join('')}</span>`; }
function progressSectionHtml(){
  if(!coachOn())return '';
  let g; try{ g=gameContext(); }catch(e){ console.warn('progress failed',e); return ''; }
  if(!g.days.length)return '';
  const L=g.level, pct=Math.round(100*L.into/L.need);
  const ch=g.current;
  let chHtml;
  if(ch){ const kept=ch.res.filter(r=>r.kept).length;
    chHtml=`<div class="gm-big">${esc(habitSentence(ch.ch.spec))}</div>
      <div class="gm-sub">${ch.res.length?`${dotsHtml(ch.res)} ${kept} of ${ch.res.length} trading day${ch.res.length===1?'':'s'} so far`:'Starts with your next trading day.'}
      ${ch.status==='missed'?' · <span class="neg-t">missed once — the rest of the week still counts for XP</span>':''}</div>
      <div class="gm-foot"><span class="mini-note" style="margin:0">+${pzXpCfg().challenge} XP if every trading day this week keeps it</span><button class="btn ghost" id="chSwap">Pick another</button></div>`; }
  else chHtml=`<div class="gm-sub">A challenge is picked from your biggest leak once you have a few trades.</div>`;
  const past=g.challenges.filter(c=>c.ended).slice(-6).reverse();
  const unlocked=g.achievements.filter(a=>a.at).length;
  const ach=g.achievements.map(a=>`<div class="ach${a.at?' on':''}" data-tip="${esc(a.desc)}${a.at?' · unlocked '+esc(dayLabel(a.at)):' · '+a.n+' of '+a.of}"><span class="ach-g" aria-hidden="true">${a.glyph}</span><span class="ach-t">${esc(a.title)}</span><span class="ach-p">${a.at?esc(dayLabel(a.at)):a.of>1?a.n+'/'+a.of:'locked'}</span>${!a.at&&a.of>1?`<span class="ach-bar"><i style="width:${Math.round(100*a.n/a.of)}%"></i></span>`:''}</div>`).join('');
  const pb=g.pbs.map(p=>`<div class="metric-row"><span class="ml">${esc(p.label)}${p.isNew?' <span class="badge ok">new best</span>':''}</span><span class="mv">${p.value!=null?p.value+(p.unit?' '+p.unit:''):'—'}${p.when?` <span style="color:var(--faint);font-weight:400">${esc(p.when)}</span>`:''}${p.current!=null&&p.id==='week'?` <span style="color:var(--faint);font-weight:400">· this week ${p.current}</span>`:''}</span></div>`).join('');
  const sv=g.saved.total>0?`<div class="metric-row" data-tip="For each rule or avoid-habit: trades you'd have taken at your old rate minus the ones you took, times what those trades averaged before. An estimate from your own past trades, not a promise."><span class="ml">Discipline saved you (est.)</span><span class="mv pos-t">${usdPlain(g.saved.total)}</span></div>${g.saved.items.slice(0,3).map(x=>`<div class="metric-row"><span class="ml" style="padding-left:10px">${esc(x.name)}</span><span class="mv" style="font-weight:400">${usdPlain(x.saved)} · ~${Math.round(x.avoided)} fewer trades</span></div>`).join('')}`
    :`<div class="metric-row"><span class="ml">Discipline saved you (est.)</span><span class="mv" style="font-weight:400;color:var(--faint)">appears once a rule or avoid-habit has a track record</span></div>`;
  return `<div class="diag-section" id="progressSec"><h2>Progress <span style="font-size:11px;color:var(--faint);font-weight:400">earned by process, never by profit or trade count</span></h2>
    <div class="gm-grid">
      <div class="diag-card gm"><h3 data-tip="${(X=>esc(`XP per trading day = that day's Discipline score (0–100${X.discipline!==1?', ×'+X.discipline:''}, read from your fills: no revenge entries, sizing up after losses, adding to losers, trading on after two losses, overtrading or holding losers too long), plus bonus XP for what you log: morning prep +${X.checkin}, plan before the first trade +${X.plan}, trades journaled +${X.journal}, stops written +${X.stops}, loss limit respected +${X.limit}. Also +${X.focus} per focus-habit day, +${X.challenge} per completed weekly challenge, +${X.achievement} per achievement.`))(pzXpCfg())}">Level</h3>
        <div class="gm-big">${L.level} · ${esc(L.title)}</div>
        <div class="xpbar" role="progressbar" aria-valuemin="0" aria-valuemax="${L.need}" aria-valuenow="${L.into}" data-tip="${esc(L.into.toLocaleString()+' of '+L.need.toLocaleString()+' XP into level '+L.level+' ('+pct+'%). '+(L.need-L.into).toLocaleString()+' XP to go.')}"><i style="width:${pct}%"></i></div>
        <div class="gm-sub">${L.capped?`Level ${L.earned} earned: create a profile in Daruma to unlock it`:`${L.into.toLocaleString()} / ${L.need.toLocaleString()} XP to ${esc(pzLevelTitle(L.level+1))}`} · +${g.weekXp.toLocaleString()} this week</div></div>
      <div class="diag-card gm"><h3 data-tip="Consecutive trading days with process 70+. Days you don't trade never break it. A finished perfect week (every trading day 70+, at least three) earns a shield, max two; a shield absorbs one missed day instead of resetting the streak.">Discipline streak</h3>
        <div class="gm-big">${g.streak.current} day${g.streak.current===1?'':'s'} ${shieldsHtml(g.streak.shields)}</div>
        <div class="gm-sub">best ${g.streak.best} · ${g.streak.shields} shield${g.streak.shields===1?'':'s'}${g.streak.shielded.length?` · ${g.streak.shielded.length} miss${g.streak.shielded.length===1?'':'es'} absorbed so far`:''}</div></div>
      <div class="diag-card gm"><h3 data-tip="One concrete target a week, picked from the biggest leak in your numbers (or a core habit when there isn't one). Kept on every trading day of the week = challenge done.">This week’s challenge</h3>${chHtml}</div>
    </div>
    <div class="diag-card" style="margin-top:14px"><h3>Achievements <span class="hint" style="font-family:var(--mono);text-transform:none;letter-spacing:0;color:var(--faint);font-weight:400">${unlocked} of ${g.achievements.length} unlocked</span></h3><div class="ach-grid">${ach}</div></div>
    <div class="diag-grid" style="margin-top:14px">
      <div class="diag-card"><h3>Personal bests</h3>${pb}${sv}</div>
      <div class="diag-card"><h3>Past challenges</h3>${past.length?past.map(c=>`<div class="metric-row"><span class="ml">${esc(c.week)} · ${esc(habitSentence(c.ch.spec))}</span><span class="mv">${c.status==='done'?'<span class="badge ok">done</span>':c.status==='too few days'?'<span class="sr-note">too few days</span>':'<span class="badge no">missed</span>'}</span></div>`).join(''):'<p class="lead">Finished challenges land here.</p>'}
        <div class="gm-actions"><button class="btn ghost" id="gmReport">Monthly report card</button><button class="btn ghost" id="gmShare">Share this week</button></div></div>
    </div>
    <div id="gmOut"></div>
  </div>`;
}
function wireProgress(){
  const sw=$('chSwap');
  if(sw)sw.onclick=async()=>{ const g=gameContext(); const c=challengeCandidates(g.ctx.findings); const cur=weekChallenge();
    if(!c.length)return; const curKey=cur&&specKey(cur.spec);
    const start=Math.max(0,c.findIndex(x=>specKey(x)===curKey));
    let i=(start+1)%c.length; for(let n=0;n<c.length&&specKey(c[i])===curKey;n++)i=(i+1)%c.length;
    await setWeekChallenge(c[i],i); renderReview(); renderCoach(); };
  const rp=$('gmReport'); if(rp)rp.onclick=()=>showReportCard();
  const sh=$('gmShare'); if(sh)sh.onclick=()=>showShareCard();
}

// ---- shareable images (no dollar amounts) ----
// Daruma's logo (icons/build-daruma.mjs; pzMark in pulse.js is the page's copy): a daruma whose outline is a
// progress track, 72% painted, with one eye filled in. Drawn on a canvas at (left, top), `s` px square.
const DARUMA_BODY='M50 8C70 8 82 24 84 44C87 66 82 92 50 92C18 92 13 66 16 44C18 24 30 8 50 8Z', DARUMA_LEN=247.2;
function drawDarumaMark(x, left, top, s, c){ // c: {acc, track, fill, eye}
  const body=new Path2D(DARUMA_BODY);
  x.save(); x.translate(left,top); x.scale(s/100,s/100); x.lineCap='round'; x.lineWidth=10;
  x.fillStyle=c.fill; x.fill(body); x.strokeStyle=c.track; x.stroke(body);
  x.setLineDash([DARUMA_LEN*.72,DARUMA_LEN]); x.strokeStyle=c.acc; x.stroke(body); x.setLineDash([]);
  x.fillStyle=c.acc; x.beginPath(); x.arc(40.5,48,9.25,0,2*Math.PI); x.fill();
  x.strokeStyle=c.eye; x.lineWidth=3.5; x.beginPath(); x.arc(59.5,48,7.5,0,2*Math.PI); x.stroke();
  x.restore(); }
function cardColors(){ const cs=getComputedStyle(document.body), v=n=>cs.getPropertyValue(n).trim();
  return {bg:v('--bg')||'#0A0E18',panel:v('--panel2')||'#0F1522',line:v('--line')||'#1A2233',text:v('--text')||'#E8ECF5',muted:v('--muted')||'#6B7488',
    gold:v('--gold')||'#C9A85C',profit:v('--profit')||'#2FD08C',loss:v('--loss')||'#F4586A',lbl:v('--lbl')||'#5C6578'}; }
// spec: {w,h,kicker,title,sub,big:[[label,value]],rows:[[label,right,color?]],foot}
async function drawCardPng(spec){
  // the fonts are files now: a canvas only draws with a face that's already loaded, so load them first
  try{ if(document.fonts&&document.fonts.load)await Promise.all(['400 18px "IBM Plex Mono"','600 26px "IBM Plex Mono"','400 24px Inter','600 46px Inter','600 18px "Barlow Condensed"'].map(f=>document.fonts.load(f).catch(()=>{}))); }catch(e){}
  try{ if(document.fonts&&document.fonts.ready)await document.fonts.ready; }catch(e){}
  // height fits the content: header + big numbers + one line per row + footer
  const W=spec.w||1200, H=Math.max(spec.minH||620,300+((spec.big||[]).length?110:0)+(spec.rows||[]).length*44+120);
  const c=cardColors(), cv=document.createElement('canvas'); cv.width=W; cv.height=H;
  const x=cv.getContext('2d');
  x.fillStyle=c.bg; x.fillRect(0,0,W,H);
  x.fillStyle=c.gold; x.fillRect(0,0,8,H);
  x.strokeStyle=c.line; x.lineWidth=2; x.strokeRect(1,1,W-2,H-2);
  const P=64; let y=P+10;
  x.fillStyle=c.gold; x.font='600 22px "Barlow Condensed", sans-serif'; x.fillText(String(spec.kicker||'').toUpperCase().split('').join(' '),P,y);
  y+=58; x.fillStyle=c.text; x.font='600 46px Inter, sans-serif'; x.fillText(spec.title,P,y);
  if(spec.sub){ y+=40; x.fillStyle=c.muted; x.font='400 24px Inter, sans-serif'; x.fillText(spec.sub,P,y); }
  y+=50;
  const big=spec.big||[], bw=(W-2*P)/Math.max(1,big.length);
  big.forEach(([l,v],i)=>{ const bx=P+i*bw;
    x.fillStyle=c.lbl; x.font='600 18px "Barlow Condensed", sans-serif'; x.fillText(String(l).toUpperCase(),bx,y);
    x.fillStyle=c.text; x.font='600 52px "IBM Plex Mono", monospace'; x.fillText(String(v),bx,y+60); });
  if(big.length)y+=110;
  x.strokeStyle=c.line; x.beginPath(); x.moveTo(P,y); x.lineTo(W-P,y); x.stroke(); y+=12;
  for(const [l,r,col] of (spec.rows||[])){ y+=44; if(y>H-70)break;
    x.fillStyle=c.muted; x.font='400 24px Inter, sans-serif'; x.fillText(l,P,y);
    x.fillStyle=col==='good'?c.profit:col==='bad'?c.loss:col==='gold'?c.gold:c.text; x.font='600 26px "IBM Plex Mono", monospace';
    const tw=x.measureText(r).width; x.fillText(r,W-P-tw,y); }
  drawDarumaMark(x,P,H-62,32,{acc:c.profit,track:c.line,fill:c.panel,eye:c.muted});
  x.fillStyle=c.muted; x.font='400 18px "IBM Plex Mono", monospace'; x.fillText(spec.foot||'Ledger · process, not profit',P+46,H-40);
  return await new Promise(res=>cv.toBlob(res,'image/png'));
}
let _gmUrl=null;
function showCardOut(blob, name, text, canSend){
  const out=$('gmOut'); if(!out)return;
  if(_gmUrl)URL.revokeObjectURL(_gmUrl); _gmUrl=blob?URL.createObjectURL(blob):null;
  out.innerHTML=`<div class="diag-card gm-card" style="margin-top:14px">
    ${_gmUrl?`<img src="${_gmUrl}" alt="${esc(name)}" class="gm-img">`:''}
    <div class="gm-actions"><button class="btn" id="gmDl">Download image</button><button class="btn ghost" id="gmCopy">Copy text</button>${canSend?'<button class="btn ghost" id="gmSend" data-tip="Posts the text above to the partner chat set by TELEGRAM_SHARE_CHAT_ID on your server.">Send to partner</button>':''}<button class="btn ghost" id="gmClose">Close</button></div>
    <pre class="letter-facts" style="max-height:none">${esc(text)}</pre></div>`;
  $('gmDl').onclick=()=>{ if(!_gmUrl)return; const a=document.createElement('a'); a.href=_gmUrl; a.download=name+'.png'; a.click(); };
  $('gmCopy').onclick=async()=>{ try{ await navigator.clipboard.writeText(text); $('gmCopy').textContent='Copied ✓'; }catch(e){ setErr('Copy failed — select the text instead.'); } };
  $('gmClose').onclick=()=>{ out.innerHTML=''; };
  const sd=$('gmSend');
  if(sd)sd.onclick=async()=>{ sd.disabled=true; sd.textContent='Sending…';
    try{ const r=await srvFetch('/api/share',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text})});
      const d=await r.json().catch(()=>({})); if(!r.ok)throw new Error(d.error||'HTTP '+r.status); sd.textContent='Sent ✓'; }
    catch(e){ sd.disabled=false; sd.textContent='Send to partner'; setErr('Share: '+e.message); } };
  out.scrollIntoView({behavior:'smooth',block:'nearest'});
}
async function shareAvailable(){
  if(!SRV.enabled)return false;
  let st=_coachStatus; if(!st){ try{ const r=await srvFetch('/api/coach/status'); if(r.ok)st=_coachStatus=await r.json(); }catch(e){} }
  return !!(st&&st.share);
}
function weekShareData(){
  const g=gameContext(), now=Date.now();
  const wk=isoWeekOfKey(dayKey(now)), from=dayKey(lastCompletedWeekRange(now).to);
  const days=g.days.filter(d=>d.key>=from);
  const avg=days.length?Math.round(_avg(days.map(d=>d.score))):null, good=days.filter(d=>d.score>=70).length;
  const fid=weekFocus(), fh=fid&&habitById(fid), fp=fh?habitProgress(fh,g.ctx,lastCompletedWeekRange(now).to):null;
  const ch=g.current, chKept=ch?ch.res.filter(r=>r.kept).length:0;
  const newA=g.achievements.filter(a=>a.at&&a.at>=from);
  const rows=[['Discipline streak',g.streak.current+' days'+(g.streak.shields?' · '+g.streak.shields+' shield'+(g.streak.shields===1?'':'s'):''),'gold']];
  if(fh)rows.push(['Focus: '+fh.then,fp.kept+' / '+fp.total,fp.total&&fp.kept===fp.total?'good':null]);
  if(ch)rows.push(['Challenge: '+ch.ch.spec.then,chKept+' / '+ch.res.length,ch.res.length&&chKept===ch.res.length?'good':'bad']);
  for(const a of newA.slice(0,2))rows.push(['Unlocked',a.title,'gold']);
  const text=['Ledger · week '+wk,
    'Process '+(avg!=null?avg+'/100':'—')+' · '+good+' of '+days.length+' trading days disciplined',
    'Discipline streak '+g.streak.current+' days'+(g.streak.shields?' ('+g.streak.shields+' shield'+(g.streak.shields===1?'':'s')+')':''),
    fh?'Focus habit: '+habitSentence(fh)+' — kept '+fp.kept+'/'+fp.total:null,
    ch?'Challenge: '+habitSentence(ch.ch.spec)+' — '+chKept+'/'+ch.res.length+' days':null,
    newA.length?'Unlocked: '+newA.map(a=>a.title).join(', '):null,
    'Level '+g.level.level+' · '+g.level.title].filter(Boolean).join('\n');
  return {spec:{kicker:'Ledger · week '+wk,title:'Process '+(avg!=null?avg:'—')+' / 100',sub:good+' of '+days.length+' trading days at 70+ · level '+g.level.level+' '+g.level.title,
    big:[['Streak',g.streak.current],['Level',g.level.level],['Achievements',g.achievements.filter(a=>a.at).length+'/'+g.achievements.length]],rows},text,name:'ledger-week-'+wk};
}
async function showShareCard(){
  try{ const d=weekShareData(); const blob=await drawCardPng(d.spec); showCardOut(blob,d.name,d.text,await shareAvailable()); }
  catch(e){ setErr('Share card failed: '+e.message); }
}
async function showReportCard(){
  try{ const g=gameContext(); const months=[...new Set(g.days.map(d=>d.key.slice(0,7)))].sort();
    const m=months[months.length-1]; const r=m&&monthlyReport(g.days,m); if(!r){ setErr('No trading days to grade yet.'); return; }
    const mName=MONTHS[+r.month.slice(5)-1]+' '+r.month.slice(0,4);
    const arrow=d=>d==null?'':d>0.02?' ▲':d<-0.02?' ▼':' ▬';
    const rows=r.parts.map(p=>[p.name,p.grade+' · '+Math.round(p.value*100)+'%'+arrow(p.delta),p.grade==='A'||p.grade==='B'?'good':p.grade==='F'||p.grade==='D'?'bad':null]);
    const text=['Ledger · '+mName+' report card','Overall '+r.grade+' · process '+Math.round(r.avg)+'/100'+(r.delta!=null?' ('+(r.delta>=0?'+':'')+Math.round(r.delta)+' vs '+r.prevMonth+')':''),
      r.good+' of '+r.days+' trading days at 70+',...r.parts.map(p=>p.name+': '+p.grade+' ('+Math.round(p.value*100)+'%)')].join('\n');
    const blob=await drawCardPng({w:1080,minH:760,kicker:'Ledger · report card',title:mName+' · grade '+r.grade,
      sub:'Process '+Math.round(r.avg)+'/100'+(r.delta!=null?' ('+(r.delta>=0?'+':'')+Math.round(r.delta)+' vs last month)':'')+' · '+r.good+' of '+r.days+' days at 70+',
      big:[['Grade',r.grade],['Process',Math.round(r.avg)],['Good days',r.good+'/'+r.days]],rows,foot:'Ledger · graded on process, not profit'});
    showCardOut(blob,'ledger-report-'+r.month,text,await shareAvailable()); }
  catch(e){ setErr('Report card failed: '+e.message); }
}

/* ======================= 12 · AUTOMATIC METRICS: useful with zero effort ======================= */
// Form, Discipline and Load are read from fills alone — nothing to log. Logging (check-in, plans,
// journal, stops, a loss limit) only adds: bonus XP, readiness, and your own limits on Load.
// pzBehaviorDays is also extracted by server.js to verify members' scores from their public fills,
// so it takes everything it needs as arguments (no app globals besides nfMedian/addedToLoser).
const PZ_BEH={revenge:'Entered within 15 minutes of a loss',afterTwo:'Kept trading after two losses in a row',sizeUp:'Sized up right after a loss',
  addLoser:'Added to a losing position',overtrade:'More trades than your usual day',heldLoser:'Held a loser far longer than your winners'};
// What counts as a loss for Discipline: fixed (more than $1 lost), NOT the personal break-even
// setting, so the app and the server's verification score the same trades the same way.
const PZ_LOSS=n=>n<-1;
const PZ_BONUS={checkin:['Morning prep',10],plan:['Plan before your first trade',15],journal:['Today’s trades journaled',15],stops:['Stops written while trades were open',10],limit:['Respected your loss limit',10],review:['End-of-day review',15]};
// Per trading day (by close day): the share of trades with none of the six slips, 0–100.
// Baselines (usual size, usual trades per day, usual winner hold) come only from trades that
// closed before that day's first entry, so a day is never judged against itself.
function pzBehaviorDays(closed, opts){
  const dayOf=opts.dayOf, loss=opts.isLoss, M=15*60000, H2=2*3600000;
  // trades cut off at the start of the history (no opening fill seen) have no real entry to judge
  const tr=(closed||[]).filter(t=>!t.isOpen&&t.closeTime&&t.openTime&&!t.partialHistory).sort((a,b)=>a.openTime-b.openTime);
  const closes=[...tr].sort((a,b)=>a.closeTime-b.closeTime), ct=closes.map(t=>t.closeTime);
  const before=ms=>{ let lo=0,hi=ct.length; while(lo<hi){ const m=(lo+hi)>>1; if(ct[m]<ms)lo=m+1; else hi=m; } return lo; };
  const size=t=>Math.abs((+t.maxSize||0)*(+t.avgEntry||0)), dur=t=>t.closeTime-t.openTime;
  const by={}; for(const t of tr){ const k=dayOf(t.closeTime); (by[k]=by[k]||[]).push(t); }
  const keys=Object.keys(by).sort(), perDay={}; for(const k of keys)perDay[k]=by[k].length;
  const out=[];
  keys.forEach((k,ki)=>{
    const arr=by[k], n=arr.length, prior=closes.slice(0,before(arr[0].openTime));
    const medSize=nfMedian(prior.slice(-30).map(size).filter(x=>x>0));
    const pastDays=keys.slice(Math.max(0,ki-30),ki), medN=pastDays.length>=5?nfMedian(pastDays.map(x=>perDay[x])):null;
    const cap=medN!=null?Math.max(3,Math.ceil(medN*1.5)):null;
    const winHold=nfMedian(prior.slice(-60).filter(t=>t.net>0&&!loss(t.net)).map(dur).filter(x=>x>0));
    const zero=()=>({revenge:0,afterTwo:0,sizeUp:0,addLoser:0,overtrade:0,heldLoser:0});
    // chances: how often the habit was tested (an entry after a loss, a losing trade to cut, a day with two
    // losses in a row…); kept: the chances not slipped; keptClean: kept by a trade with no slip of any kind
    // (Trader Age reads these to say what each habit earns, not only what the slips cost)
    const flags=zero(), chances=zero(), kept=zero(), keptClean=zero(), slips=[]; let clean=0, entries=0;
    const tested=(c,f,x)=>{ chances[c]++; if(!f.includes(c)){ kept[c]++; if(!f.length)keptClean[c]++; } };
    arr.forEach((t)=>{
      // a spot position carried on after a partial sale is not a new entry: only the holding checks apply
      const entry=!t.carried, i=entry?entries++:-1;
      // closes up to and including the entry's millisecond: a stop-and-reverse closes the loser and
      // opens the next trade on the same fill, and that re-entry counts
      const prev=[]; for(let q=before(t.openTime+1)-1;q>=0&&prev.length<2;q--)if(closes[q]!==t)prev.push(closes[q]);
      const p1=prev[0]||null, p2=prev[1]||null, f=[];
      const afterLoss=entry&&p1&&loss(p1.net), sizeTest=afterLoss&&t.openTime-p1.closeTime<=H2&&!!medSize, holdTest=loss(t.net)&&!!winHold, addTest=hasAdd(t);
      if(afterLoss&&t.openTime-p1.closeTime<=M)f.push('revenge');
      if(entry&&p1&&p2&&loss(p1.net)&&loss(p2.net)&&dayOf(p1.closeTime)===dayOf(t.openTime)&&dayOf(p2.closeTime)===dayOf(t.openTime))f.push('afterTwo');
      if(sizeTest&&size(t)>1.5*medSize)f.push('sizeUp');
      if(addTest&&addedToLoser(t))f.push('addLoser');
      if(entry&&cap!=null&&i>=cap)f.push('overtrade');
      if(holdTest&&dur(t)>3*winHold)f.push('heldLoser');
      for(const x of f)flags[x]++; if(!f.length)clean++; else slips.push({id:t.id,net:t.net,f});
      if(afterLoss)tested('revenge',f); if(sizeTest)tested('sizeUp',f); if(addTest)tested('addLoser',f); if(holdTest)tested('heldLoser',f);
    });
    // day-level chances: two losses in a row closed today (a chance to stop), a usual count to stay inside
    const byClose=[...arr].sort((a,b)=>a.closeTime-b.closeTime);
    if(byClose.some((t,j)=>j>0&&loss(t.net)&&loss(byClose[j-1].net))){ chances.afterTwo=1; if(!flags.afterTwo)kept.afterTwo=keptClean.afterTwo=1; }
    if(cap!=null){ chances.overtrade=1; if(!flags.overtrade)kept.overtrade=keptClean.overtrade=1; }
    out.push({key:k,score:Math.round(100*clean/n),n,clean,flags,chances,kept,keptClean,slips,net:arr.reduce((s,t)=>s+t.net,0)});
  });
  return out;
}
// ---- "Traders like you": the anonymous summary a trader contributes to the benchmarks ----
// The same function runs in the app (from your own trades) and on the server (from a seed
// wallet's public fills), so both are measured identically. Last 90 days, closed trades only.
// Sizes and activity are reduced to ranges; nothing here names a coin, a dollar amount or a wallet.
// o: {now, dayOf, firstAt (first trade ever, for experience), isJournaled (app only)}
function peerSummary(closed, o){
  // the league owner sets the bar (Admin → Benchmarks): at least minTrades closed trades in the last
  // `days` days (15 in 90 by default), over at least two weeks, so one lucky week can't skew a group
  o=o||{}; const DAY=86400000, now=o.now||Date.now(), look=o.days===180?180:90, minN=Math.max(10,Math.min(100,Math.round(+o.minTrades)||15)), from=now-look*DAY;
  const tr=(closed||[]).filter(t=>!t.isOpen&&t.closeTime>=from&&t.closeTime<=now&&t.openTime&&!t.partialHistory);
  const n=tr.length; if(n<minN)return {ok:false,why:'few',n,need:minN,days:look};
  const first=Math.min(...tr.map(t=>t.closeTime)), last=Math.max(...tr.map(t=>t.closeTime));
  if((last-first)/DAY<14)return {ok:false,why:'short',n,days:look};
  const med=a=>{ const s=[...a].sort((x,y)=>x-y), k=s.length; return k?(k%2?s[(k-1)/2]:(s[k/2-1]+s[k/2])/2):null; };
  const r1=v=>Math.round(v*10)/10, r2=v=>Math.round(v*100)/100;
  // the same style rule as Pulse's profile (pzDetectProfile)
  const hold=med(tr.map(t=>t.closeTime-t.openTime)), days=new Set(tr.map(t=>o.dayOf?o.dayOf(t.closeTime):Math.floor(t.closeTime/DAY))).size, perDay=n/Math.max(1,days);
  const style=hold<20*60000||perDay>=8?'scalper':hold<8*3600000?'day':hold<10*DAY?'swing':'position';
  const notional=med(tr.map(t=>(t.maxSize||0)*(t.avgEntry||0)).filter(x=>x>0))||0;
  const size=notional<1000?'s1':notional<10000?'s2':notional<100000?'s3':'s4';
  const firstAt=Math.min(o.firstAt||first,first), months=(now-firstAt)/(30.44*DAY);
  const exp=months<3?'e1':months<12?'e2':months<36?'e3':'e4';
  const weeks=Math.max(1,(now-Math.max(from,firstAt))/(7*DAY)), tw=n/weeks;
  const act=tw<5?'a1':tw<15?'a2':tw<40?'a3':'a4';
  // results: a win or a loss is more than $1 either way (the same fixed rule Pulse's Discipline uses)
  const W=tr.filter(t=>t.net>1), L=tr.filter(t=>t.net<-1), gw=W.reduce((a,t)=>a+t.net,0), gl=-L.reduce((a,t)=>a+t.net,0);
  const wr=W.length+L.length?100*W.length/(W.length+L.length):null;
  const pf=gl>0?Math.min(50,gw/gl):gw>0?50:null, pay=W.length&&L.length?Math.min(50,(gw/W.length)/(gl/L.length)):null;
  const grossUp=tr.reduce((a,t)=>a+Math.max(0,t.pnl!=null?t.pnl:t.net),0), cost=tr.reduce((a,t)=>a+(t.fees||0)+Math.max(0,-(t.funding||0)),0);
  const fees=grossUp>0?Math.min(500,100*cost/grossUp):null;
  // process: the day's Discipline score (read from fills) and how often a trade was a revenge entry
  const bd=pzBehaviorDays(tr,{dayOf:o.dayOf||(ms=>new Date(ms).toISOString().slice(0,10)),isLoss:x=>x<-1});
  const disc=bd.length?bd.reduce((a,d)=>a+d.score,0)/bd.length:null, rev=100*bd.reduce((a,d)=>a+((d.flags&&d.flags.revenge)||0),0)/n;
  const jour=typeof o.isJournaled==='function'?100*tr.filter(o.isJournaled).length/n:null;
  return {ok:true,v:1,n,style,size,exp,act,tw:r1(tw),hold:Math.round(hold/60000),disc:disc==null?null:r1(disc),rev:r1(rev),jour:jour==null?null:r1(jour),
    wr:wr==null?null:r1(wr),pf:pf==null?null:r2(pf),pay:pay==null?null:r2(pay),fees:fees==null?null:r1(fees)};
}
// Bonus XP for what you chose to log that day. Nothing here can lower a score.
function pzBonus(pday, dayE, X){
  X=X||{checkin:10,plan:15,journal:15,stops:10,limit:10,review:15};
  const P=(pday&&pday.parts)||{}, b={};
  if(dayE&&(dayE.sleep||dayE.stress||dayE.focus)&&X.checkin)b.checkin=X.checkin;
  if(P.plan>0&&X.plan)b.plan=Math.round(X.plan*P.plan);
  if(P.journal>0&&X.journal)b.journal=Math.round(X.journal*P.journal);
  if(P.planned>0&&X.stops)b.stops=Math.round(X.stops*P.planned);
  if(P.limit===1&&X.limit)b.limit=X.limit;
  if(dayE&&dayE.eod&&dayE.eod.at&&X.review)b.review=X.review; // the end-of-day review
  let total=0; for(const k in b)total+=b[k];
  return {parts:b,total};
}
// Form: your recent trading against your own earlier trading — average trade, win rate, and how
// far you sit below your 30-day high. 50 is your usual. "Recent" is the last 7 days when they
// hold 5+ trades, else your last 5 trades (so a slow trader still gets a reading); the baseline
// is up to 90 trades before that. Null with under 15 trades, or nothing in the last 30 days.
function pzForm(closed, now, opts){
  const DAY=86400000, win=opts.isWin, loss=opts.isLoss;
  const c=(closed||[]).filter(t=>!t.isOpen&&t.closeTime&&t.closeTime<=now).sort((a,b)=>a.closeTime-b.closeTime);
  const wk=c.filter(t=>t.closeTime>=now-7*DAY);
  const byWeek=wk.length>=5, rec=byWeek?wk:c.slice(-5);
  const base=rec.length?c.filter(t=>t.closeTime<rec[0].closeTime).slice(-90):[];
  if(c.length<15||!rec.length||rec[rec.length-1].closeTime<now-30*DAY||base.length<10)
    return {score:null,rec:rec.length,base:base.length,total:c.length,stale:!!(c.length&&c[c.length-1].closeTime<now-30*DAY)};
  const mean=a=>a.reduce((s,t)=>s+t.net,0)/a.length;
  const scale=nfMedian(base.map(t=>Math.abs(t.net)).filter(x=>x>0))||1;
  const wr=a=>{ const w=a.filter(t=>win(t.net)).length, l=a.filter(t=>loss(t.net)).length; return w+l?w/(w+l):null; };
  const avgRec=mean(rec), avgBase=mean(base), wrRec=wr(rec), wrBase=wr(base);
  const e=Math.max(-1.5,Math.min(1.5,(avgRec-avgBase)/scale));
  const w=wrRec!=null&&wrBase!=null?Math.max(-0.5,Math.min(0.5,wrRec-wrBase)):0;
  let cum=0, peak=0; for(const t of c.filter(t=>t.closeTime>=now-30*DAY).sort((a,b)=>a.closeTime-b.closeTime)){ cum+=t.net; if(cum>peak)peak=cum; }
  const dd=Math.max(0,peak-cum), ddN=Math.min(1,dd/(5*scale));
  const score=Math.round(Math.max(0,Math.min(100,50+20*e+40*w-20*ddN)));
  return {score,rec:rec.length,base:base.length,avgRec,avgBase,wrRec,wrBase,dd,e,w,ddN,window:byWeek?'last 7 days':'last 5 trades'};
}
// Load: today's activity against your usual trading day (median of the last 30): trades opened
// and total size. 50 = a usual day, 100 = twice it.
function pzLoad(trades, todayK, dayOf){
  const size=t=>Math.abs((+t.maxSize||0)*(+t.avgEntry||0));
  const opened=(trades||[]).filter(t=>t.openTime&&dayOf(t.openTime)===todayK);
  const past={}; for(const t of (trades||[])){ if(!t.openTime)continue; const k=dayOf(t.openTime); if(k>=todayK)continue; (past[k]=past[k]||{n:0,v:0}); past[k].n++; past[k].v+=size(t); }
  const ks=Object.keys(past).sort().slice(-30);
  const n=opened.length, v=opened.reduce((s,t)=>s+size(t),0);
  if(ks.length<5)return {score:null,n,v,days:ks.length};
  const medN=nfMedian(ks.map(k=>past[k].n)), medV=nfMedian(ks.map(k=>past[k].v));
  const rN=medN?n/medN:0, rV=medV?v/medV:0, ratio=Math.max(rN,rV);
  return {score:Math.round(Math.min(100,ratio*50)),ratio,n,v,medN,medV,rN,rV,days:ks.length};
}
// ---- market regimes: each day tagged by how BTC moved — calm or wild, trending or choppy ----
// Read from BTC daily candles. Volatility is the day's high–low range against the median of the
// 30 days before it; trend is the 7-day efficiency ratio (the net move over the sum of the daily
// moves): near 1 is a clean trend, near 0 is chop. Days are UTC, like the candles. Pure.
const PZ_VOL={low:'Quiet days',normal:'Normal days',high:'Volatile days'}, PZ_TREND={up:'Trending up',down:'Trending down',mixed:'Mixed',chop:'Choppy'};
function pzRegimes(candles, now){
  const c=(candles||[]).filter(x=>x&&x[3]>0).slice().sort((a,b)=>a[0]-b[0]), out={};
  // a day still in progress has had less time to move: a range grows roughly with the square
  // root of time, so today's is scaled up by √(day ÷ time elapsed) before it's compared
  const rng=c.map(x=>{ const r=(x[1]-x[2])/x[3], f=now&&now-x[0]<86400000?Math.max(0.1,(now-x[0])/86400000):1; return f<1?r/Math.sqrt(f):r; });
  for(let i=0;i<c.length;i++){
    const prev=rng.slice(Math.max(0,i-30),i).filter(x=>x>0), med=prev.length>=10?nfMedian(prev):null;
    const r=med&&rng[i]>0?rng[i]/med:null;
    let trend=null, er=null;
    if(i>=7){ let path=0; for(let j=i-6;j<=i;j++)path+=Math.abs(c[j][3]-c[j-1][3]); const move=c[i][3]-c[i-7][3]; er=path>0?Math.abs(move)/path:0;
      trend=er>=0.5?(move>0?'up':'down'):er<=0.25?'chop':'mixed'; }
    out[new Date(c[i][0]).toISOString().slice(0,10)]={vol:r==null?null:r>=1.4?'high':r<=0.7?'low':'normal',trend,ratio:r,er,range:rng[i]};
  }
  return out;
}
const pzUtcDay=ms=>new Date(ms).toISOString().slice(0,10);
// BTC daily candles, cached like trade candles; today's (still moving) candle is always refetched
const PZ_REG={map:null,at:0,busy:false};
// worth (re)loading: never loaded, an hour old, or a new UTC day the map doesn't have yet (with a
// five-minute pause after a failure, so being offline doesn't mean a request on every screen)
function pzRegimeWant(){ const now=Date.now(), m=PZ_REG.map, fresh=m&&m[pzUtcDay(now)];
  if(PZ_REG.busy)return; if(fresh?now-PZ_REG.at>3600000:now-PZ_REG.at>300000)pzRegimeLoad(); }
async function pzRegimeLoad(){
  if(PZ_REG.busy||!allTrades.length||typeof hlPost!=='function')return;
  PZ_REG.busy=true;
  try{ const now=Date.now(), DAY=86400000; let first=Infinity; for(const t of allTrades)if(t.openTime&&t.openTime<first)first=t.openTime;
    if(!isFinite(first))first=now-90*DAY;
    const a=Math.max(first-45*DAY,now-1800*DAY), k='cnd:'+excKey('BTC','1d');
    let cache=null; try{ cache=await idbGet(k); }catch(e){}
    if(!cache||cache.v!==1||!Array.isArray(cache.candles)||!Array.isArray(cache.ranges))cache={v:1,candles:[],ranges:[]};
    const settled=Math.floor(now/DAY)*DAY-DAY; // candles before yesterday's open don't change any more
    const covered=cache.ranges.map(r=>[r[0],Math.min(r[1],settled)]).filter(r=>r[1]>r[0]);
    for(const u of uncoveredRanges([a,now],covered)){ if(u[1]-u[0]<DAY/2)continue;
      const f=await fetchCandles('BTC','1d',u[0],u[1]); cache.candles=mergeCandles(cache.candles,f.rows);
      if(f.coveredTo>u[0]){ covered.push([u[0],f.coveredTo]); cache.ranges=mergeRanges(covered,1); } }
    try{ await idbSet(k,cache); }catch(e){}
    const m=pzRegimes(cache.candles,now), before=JSON.stringify(PZ_REG.map&&PZ_REG.map[pzUtcDay(now)]||null)+(PZ_REG.map?Object.keys(PZ_REG.map).length:0);
    PZ_REG.map=m; PZ_REG.at=now;
    if(JSON.stringify(m[pzUtcDay(now)]||null)+Object.keys(m).length!==before&&PZ)pzRender();
  }catch(e){ console.warn('regimes',e); PZ_REG.at=Date.now(); }
  finally{ PZ_REG.busy=false; }
}
function pzRegimeOf(ms){ const m=PZ_REG.map; return m?m[pzUtcDay(ms)]||null:null; }
// the regime you trade worst and best in, when the gap is real (5+ trades on each side)
function pzRegimeInsight(rows, names){
  const ok=(rows||[]).filter(r=>r.n>=5&&r.avg!=null); if(ok.length<2)return null;
  const s=[...ok].sort((a,b)=>a.avg-b.avg), lo=s[0], hi=s[s.length-1];
  if(lo.avg>=0||hi.avg<=0)return null;
  return {lo,hi,text:`You lose on ${names[lo.k].toLowerCase()} (avg ${signedPlain(lo.avg)} over ${lo.n} trades) and make it back on ${names[hi.k].toLowerCase()} (avg ${signedPlain(hi.avg)} over ${hi.n}).`};
}
// ---- costs: what fees and funding take, and the one change that would keep more of it ----
// pnl is the price result, fees and funding are the costs (funding: + received, − paid). Maker and
// taker notional come from each fill's crossed flag; rates fall back to Hyperliquid's base tier. Pure.
function pzCostStats(trades){
  let price=0,fees=0,fund=0,paid=0,mkN=0,tkN=0,mkF=0,tkF=0,unN=0;
  for(const t of trades||[]){ price+=+t.pnl||0; fees+=+t.fees||0; const f=+t.funding||0; fund+=f; if(f<0)paid-=f;
    mkN+=+t.makerNotional||0; tkN+=+t.takerNotional||0; mkF+=+t.makerFee||0; tkF+=+t.takerFee||0; unN+=+t.unkNotional||0; }
  // maker share is over fills that say which side they were; fees per volume over all of it
  const known=mkN+tkN, vol=known+unN, tkRate=tkN>0&&tkF>0?tkF/tkN:0.00045, mkRate=mkN>0?mkF/mkN:Math.min(tkRate,0.00015);
  const r={price,fees,fund,paid,vol,makerShare:known?mkN/known:null,feeBps:vol?fees/vol*1e4:null,
    drag:price>0?fees/price:null,fundShare:price>0&&paid>0?paid/price:null,save:Math.max(0,tkN*(tkRate-mkRate)*0.5),advice:[]};
  if(r.makerShare!=null&&r.makerShare<0.3&&r.save>=5)r.advice.push(`${Math.round((1-r.makerShare)*100)}% of your volume paid taker fees. Entering half of it with limit orders would have kept about ${usdPlain(r.save)}.`);
  if(r.drag!=null&&r.drag>=0.25)r.advice.push(`Fees took ${Math.round(r.drag*100)}% of what your trades made on price. Fewer trades with more room to run keep more of it.`);
  else if(price<=0&&fees>0)r.advice.push(`Your trades lost on price before costs; fees added ${usdPlain(fees)} on top. Cutting the weakest setups cuts both.`);
  if(r.fundShare!=null&&r.fundShare>=0.1)r.advice.push(`Funding cost ${usdPlain(paid)} — ${Math.round(r.fundShare*100)}% of your price profit. Holding the crowded side through funding is a cost; time the hold or size it smaller.`);
  if(!r.advice.length&&vol)r.advice.push(fund>0?`Costs are in hand, and funding paid you ${usdPlain(fund)}.`:'Costs are in hand: no change would make a real difference here.');
  return r;
}
function pzCostHtml(tr){
  const c=pzCostStats(tr); if(!c.vol&&!c.fees)return '';
  return `<section class="pz-card pz-kv"><b class="pz-kvh">Fees and funding</b>
    ${c.makerShare!=null?`<div class="pz-row-t" title="Share of your traded volume that rested on the book (maker) instead of crossing the spread (taker)"><span>Maker share of volume</span><b>${Math.round(c.makerShare*100)}%</b></div>`:''}
    ${c.feeBps!=null?`<div class="pz-row-t" title="Fees per $10,000 traded (basis points)"><span>Average fee</span><b>${c.feeBps.toFixed(1)} bps</b></div>`:''}
    <div class="pz-row-t"><span>Fees vs result on price</span><b style="color:${c.drag!=null&&c.drag>=0.25?PZ_COL.low:'var(--pz-text)'}">${c.drag!=null?Math.round(c.drag*100)+'% of '+esc(usdPlain(c.price)):esc(usdPlain(c.fees))+' on a '+esc(signedPlain(c.price))+' price result'}</b></div>
    <div class="pz-row-t"><span>Funding</span><b style="color:${pzSignCol(c.fund)}">${esc(signedPlain(c.fund))}${c.paid?' · '+esc(usdPlain(c.paid))+' paid':''}</b></div>
    ${c.advice.map(a=>`<p class="pz-sub" style="font-size:13px;margin-top:4px">${esc(a)}</p>`).join('')}</section>`;
}
// ---- a chart on every journal card: candles around the trade, with entry, exit, stop and target ----
// one price format everywhere a price is shown: thousands separated, decimals by size, no trailing noise
function pzPx(v){
  if(v==null||!isFinite(v))return '—';
  const a=Math.abs(v), d=a>=1000?2:a>=1?4:a>=0.01?5:7;
  let s=(+v).toFixed(d); if(d>2)s=s.replace(/(\.\d\d\d*?)0+$/,'$1');
  const [i,f]=s.split('.'); return (i.startsWith('-')?'−':'')+Math.abs(+i).toLocaleString('en-US')+(f?'.'+f:'');
}
function pzHeld(ms){ const m=Math.max(0,Math.round(ms/60000)); if(m<60)return m+'m'; const h=Math.floor(m/60); if(h<24)return h+'h '+(m%60)+'m'; const d=Math.floor(h/24); return d+'d '+(h%24)+'h'; }
// about n round-number gridlines between lo and hi
function pzTicks(lo,hi,n){ const span=hi-lo; if(!(span>0))return []; const raw=span/n, p=Math.pow(10,Math.floor(Math.log10(raw))), m=raw/p, step=(m>=5?5:m>=2?2:1)*p, out=[];
  for(let v=Math.ceil(lo/step)*step;v<=hi+step*1e-6;v+=step)out.push(+v.toFixed(10)); return out; }
const PZ_SNAP={}, _pzSnapQ=[]; let _pzSnapBusy=false;
const PZ_ITV_NAME={60e3:'1m',300e3:'5m',900e3:'15m',3600e3:'1h',14400e3:'4h',86400e3:'1d'};
function pzSnapSvg(t, candles, ms, plan, mk){
  if(!candles||candles.length<2)return '';
  // at most 90 candles: merge neighbours on long trades
  const k=Math.max(1,Math.ceil(candles.length/90)), cs=[];
  for(let i=0;i<candles.length;i+=k){ const g=candles.slice(i,i+k), o=g[0][4]!=null?g[0][4]:(i?candles[i-1][3]:g[0][3]);
    cs.push({t:g[0][0],h:Math.max(...g.map(x=>x[1])),l:Math.min(...g.map(x=>x[2])),c:g[g.length-1][3],o}); }
  const W=360, H=200, L=8, R=74, T=10, B=22, pw=W-L-R, ph=H-T-B, step=pw/cs.length, cms=ms*k, t0=cs[0].t, t1=cs[cs.length-1].t+cms;
  const ev=(t.events||[]).filter(e=>e[1]>0), endT=t.isOpen?t1:t.closeTime, short=t.dir==='Short';
  const lv=[t.avgEntry,t.isOpen?null:t.avgExit,plan&&plan.stop,plan&&plan.target,...ev.map(e=>e[1])].filter(v=>v>0);
  let lo=Math.min(...cs.map(x=>x.l),...lv), hi=Math.max(...cs.map(x=>x.h),...lv); const pad=(hi-lo)*0.08||hi*0.002; lo-=pad; hi+=pad;
  const Y=v=>T+ph*(hi-v)/(hi-lo), X=m=>L+pw*Math.max(0,Math.min(1,(m-t0)/(t1-t0)));
  const fx=n=>n.toFixed(1), up=PZ_COL.good, dn=PZ_COL.low, gold=PZ_COL.mid, win=t.net>=0, exitCol=win?up:dn;
  const tf=m=>new Date(m).toLocaleString('en-US',{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false});
  const sz=v=>(+(+v).toPrecision(5)).toLocaleString('en-US');
  // the holding period, and the ground covered between the entry and exit prices
  const x0=X(t.openTime), x1=X(endT), hw=Math.max(1,x1-x0);
  const hold=`<rect x="${fx(x0)}" y="${T}" width="${fx(hw)}" height="${ph}" fill="currentColor" opacity=".05"/>`;
  const zone=!t.isOpen&&t.avgExit>0?`<rect x="${fx(x0)}" y="${fx(Math.min(Y(t.avgEntry),Y(t.avgExit)))}" width="${fx(hw)}" height="${fx(Math.max(1,Math.abs(Y(t.avgEntry)-Y(t.avgExit))))}" fill="${exitCol}" opacity=".12"/>`:'';
  // the axis: in, out, stop and target as pills at their price, nudged apart; gridlines fill the rest
  const pills=[], pill=(v,col,lab)=>{ if(v>0)pills.push({y:Y(v),col,lab}); };
  pill(t.avgEntry,gold,'in '+pzPx(t.avgEntry)); if(!t.isOpen)pill(t.avgExit,exitCol,'out '+pzPx(t.avgExit));
  if(plan&&plan.stop>0)pill(plan.stop,dn,'stop '+pzPx(plan.stop)); if(plan&&plan.target>0)pill(plan.target,up,'target '+pzPx(plan.target));
  pills.sort((a,b)=>a.y-b.y); for(let i=1;i<pills.length;i++)if(pills[i].y-pills[i-1].y<14)pills[i].y=pills[i-1].y+14;
  const over=pills.length?pills[pills.length-1].y+7-(H-B):0; if(over>0)pills.forEach(p=>{ p.y-=over; });
  const ticks=pzTicks(lo,hi,4).filter(v=>Y(v)>T+6&&Y(v)<H-B-6);
  const grid=ticks.map(v=>`<line x1="${L}" x2="${W-R}" y1="${fx(Y(v))}" y2="${fx(Y(v))}" stroke="currentColor" opacity=".08"/>${pills.some(p=>Math.abs(p.y-Y(v))<13)?'':`<text x="${W-R+6}" y="${fx(Y(v)+3.5)}" class="pz-snap-ax">${pzPx(v)}</text>`}`).join('');
  const pillsHtml=pills.map(p=>`<rect x="${W-R+3}" y="${fx(p.y-7)}" width="${R-7}" height="14" rx="4" fill="${p.col}"/><text x="${W-R+3+(R-7)/2}" y="${fx(p.y+3.5)}" text-anchor="middle" class="pz-snap-pill">${esc(p.lab)}</text>`).join('');
  // candles, each with its own tooltip
  const body=cs.map((x,i)=>{ const u=x.c>=x.o, col=u?up:dn, cx=L+step*(i+0.5), w=Math.max(1.5,step-2);
    const ch=x.o>0?(x.c/x.o-1)*100:null, vs=t.avgEntry>0?(x.c/t.avgEntry-1)*100*(short?-1:1):null;
    const tip=tf(x.t)+'\nO '+pzPx(x.o)+' · H '+pzPx(x.h)+'\nL '+pzPx(x.l)+' · C '+pzPx(x.c)+(ch!=null?' ('+(ch>=0?'+':'')+ch.toFixed(2)+'%)':'')+(vs!=null?'\n'+(vs>=0?'+':'')+vs.toFixed(2)+'% vs your entry, for your '+(short?'short':'long'):'');
    return `<g data-pz-tip="${esc(tip)}"><rect x="${fx(L+step*i)}" y="${T}" width="${fx(step)}" height="${ph}" fill="transparent"/><line x1="${fx(cx)}" x2="${fx(cx)}" y1="${fx(Y(x.h))}" y2="${fx(Y(x.l))}" stroke="${col}" stroke-width="1"/><rect x="${fx(cx-w/2)}" y="${fx(Y(Math.max(x.o,x.c)))}" width="${fx(w)}" height="${fx(Math.max(1.5,Math.abs(Y(x.o)-Y(x.c))))}" rx=".6" fill="${col}"/></g>`; }).join('');
  // price lines: entry from its fill on, exit across the hold, stop and target dashed across it
  const hline=(v,col,from,to,dash)=>v>0?`<line x1="${fx(from)}" x2="${fx(to)}" y1="${fx(Y(v))}" y2="${fx(Y(v))}" stroke="${col}" stroke-width="1.2"${dash?' stroke-dasharray="3 3"':''} opacity=".9"/>`:'';
  const lines=hline(plan&&plan.stop,dn,x0,W-R,true)+hline(plan&&plan.target,up,x0,W-R,true)+hline(t.avgEntry,gold,x0,W-R)+(t.isOpen?'':hline(t.avgExit,exitCol,x0,W-R));
  // every fill on its candle: a triangle up for a buy, down for a sell; the one being stepped through is ringed
  const tri=(x,y,upward,col)=>`<path d="M${fx(x-4.5)} ${fx(upward?y+4:y-4)}L${fx(x+4.5)} ${fx(upward?y+4:y-4)}L${fx(x)} ${fx(upward?y-4.5:y+4.5)}Z" fill="${col}" stroke="#0E1216" stroke-width="1"/>`;
  const marks=ev.map(e=>{ const buy=e[3]>0, x=X(e[0]), y=Y(e[1]), cur=mk&&mk.t===e[0]&&mk.px===e[1];
    const what=buy?(short?'Sold short':'Bought'):(short?'Covered':'Sold');
    return `<g data-pz-tip="${esc(what+' '+sz(e[2])+' at '+pzPx(e[1])+'\n'+tf(e[0]))}">${cur?`<circle cx="${fx(x)}" cy="${fx(y)}" r="8" fill="none" stroke="currentColor" stroke-width="1.5" opacity=".9"/>`:''}${tri(x,y,buy,buy?gold:exitCol)}</g>`; }).join('');
  // the worst and best points while held
  let ext='';
  if(typeof replayExtremes==='function'&&!t.isOpen){ const E=replayExtremes(t,candles,ms)||{};
    for(const [p,lab] of [[E.worst,'worst'],[E.best,'best']]){ if(!p||Math.abs(p.pct)<0.1)continue; const x=X(p.x+ms/2), y=Y(p.y);
      if(ev.some(e=>Math.abs(X(e[0])-x)<10&&Math.abs(Y(e[1])-y)<10))continue; // the extreme is a fill itself (the exit at the top): nothing to add
      const right=x<W-R-70, txt=lab+' '+(p.pct>=0?'+':'')+p.pct.toFixed(2)+'%';
      ext+=`<g data-pz-tip="${esc('The '+lab+' point while you held: '+pzPx(p.y)+' ('+(p.pct>=0?'+':'')+p.pct.toFixed(2)+'% from your entry)\n'+tf(p.x))}"><circle cx="${fx(x)}" cy="${fx(y)}" r="3" fill="#0E1216" stroke="${lab==='worst'?dn:up}" stroke-width="1.5"/><text x="${fx(right?x+6:x-6)}" y="${fx(y+(lab==='worst'?10:-5))}" text-anchor="${right?'start':'end'}" class="pz-snap-ax" fill="${lab==='worst'?dn:up}">${esc(txt)}</text></g>`; } }
  // the time axis: when it starts and ends, how long it was held, the candle size
  const axis=`<text x="${L}" y="${H-7}" class="pz-snap-ax">${esc(tf(t0))}</text><text x="${W-R}" y="${H-7}" text-anchor="end" class="pz-snap-ax">${esc(tf(t1))}</text>`
    +`<text x="${fx(L+pw/2)}" y="${H-7}" text-anchor="middle" class="pz-snap-ax" opacity=".8">${esc((t.isOpen?'open ':'held ')+pzHeld(endT-t.openTime)+' · '+(PZ_ITV_NAME[cms]||(k>1?'~'+Math.round(cms/60000)+'m':PZ_ITV_NAME[ms]||''))+' candles')}</text>`;
  const label=`${dispMarket(dcoin(t))} ${short?'short':'long'}: in at ${pzPx(t.avgEntry)}${t.isOpen?', still open':', out at '+pzPx(t.avgExit)}${plan&&plan.stop>0?', stop '+pzPx(plan.stop):''}${plan&&plan.target>0?', target '+pzPx(plan.target):''}, ${ev.length} fill${ev.length===1?'':'s'}`;
  return `<svg class="pz-snapsvg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}">${hold}${zone}${grid}${body}${lines}${ext}${marks}${pillsHtml}${axis}</svg>`;
}
function pzSnapHtml(t){
  const s=PZ_SNAP[t.id];
  const ph='<div class="pz-snapph" aria-busy="true"><span class="pz-spin"></span>Loading the chart…</div>';
  if(!s){ pzSnapWant(t); return ph; }
  if(s.st==='busy')return ph;
  if(s.st!=='ok'){ if(Date.now()-(s.at||0)>5*60000){ delete PZ_SNAP[t.id]; return pzSnapHtml(t); } return '<div class="pz-snapph">No candles for this market yet.</div>'; }
  return pzSnapSvg(t,s.c,s.ms,typeof nfPlan==='function'?nfPlan(journal[t.id]):null,typeof planPzMark==='function'?planPzMark(t):null);
}
function pzSnapWant(t){ if(PZ_SNAP[t.id]||typeof ensureTradeCandles!=='function')return; PZ_SNAP[t.id]={st:'busy'}; _pzSnapQ.push(t); pzSnapRun(); }
async function pzSnapRun(){
  if(_pzSnapBusy)return; _pzSnapBusy=true;
  try{ while(_pzSnapQ.length){ const t=_pzSnapQ.shift(); let r=null; try{ r=await ensureTradeCandles(t); }catch(e){}
      PZ_SNAP[t.id]=r&&r.candles&&r.candles.length>=2?{st:'ok',c:r.candles,ms:r.itv.ms}:{st:'none',at:Date.now()};
      const el=document.querySelector('[data-pz-snap="'+CSS.escape(t.id)+'"]'); if(el)el.innerHTML=pzSnapHtml(t); } }
  finally{ _pzSnapBusy=false; }
}
// ---- process goals: targets for how you trade, never for what you make ----
// disc: a month's Discipline average · noslip: N weeks without one slip · journal: share of a month's
// trades journaled · checkin: check-ins in a month · limit: N weeks inside your loss limit.
const PZ_GOAL_KINDS={
  disc:{title:g=>'Discipline average of '+g.target+'+ in '+pzMonthName(g.month),targets:[70,80,90],month:1},
  noslip:{title:g=>'No '+PZ_SLIP_TOPIC[g.slip]+' for '+g.target+' weeks',targets:[2,4,8]},
  journal:{title:g=>'Journal '+g.target+'% of trades in '+pzMonthName(g.month),targets:[80,90,100],month:1},
  checkin:{title:g=>'Prep on '+g.target+' days in '+pzMonthName(g.month),targets:[10,15,20],month:1},
  limit:{title:g=>'Inside your loss limit every day for '+g.target+' weeks',targets:[2,4,8]}};
const pzMonthName=m=>new Date(Date.UTC(+m.slice(0,4),+m.slice(5,7)-1,1)).toLocaleString('en-US',{month:'long',timeZone:'UTC'});
const pzMonthEnd=m=>new Date(Date.UTC(+m.slice(0,4),+m.slice(5,7),0)).toISOString().slice(0,10);
const pzDaysBetween=(a,b)=>Math.round((Date.parse(b+'T00:00:00Z')-Date.parse(a+'T00:00:00Z'))/86400000);
// progress for one goal. x = {days (trading days, oldest first), J (journal), closed, today, dayOf, journaled}. Pure.
function pzGoalEval(g, x){
  const today=x.today, inMonth=k=>k.slice(0,7)===g.month, monthOver=!!g.month&&today.slice(0,7)>g.month;
  if(g.kind==='disc'){ const ds=x.days.filter(d=>inMonth(d.key)), avg=ds.length?Math.round(ds.reduce((a,d)=>a+d.score,0)/ds.length):null, ok=avg!=null&&avg>=g.target&&ds.length>=5;
    return {pct:avg==null?0:Math.min(1,avg/g.target),now:avg==null?'No trading days yet':avg+' average over '+ds.length+' day'+(ds.length===1?'':'s'),
      status:monthOver?(ok?'done':'missed'):avg==null||avg>=g.target?'on':'behind',note:ds.length<5&&!monthOver?'Counts once you’ve traded 5 days this month.':''}; }
  if(g.kind==='journal'){ const tr=x.closed.filter(t=>inMonth(x.dayOf(t.closeTime))), j=tr.filter(t=>x.journaled(x.J[t.id])).length, sh=tr.length?Math.round(100*j/tr.length):null;
    return {pct:sh==null?0:Math.min(1,sh/g.target),now:sh==null?'No trades yet':sh+'% · '+j+' of '+tr.length+' trades',status:monthOver?(sh!=null&&sh>=g.target?'done':'missed'):sh==null||sh>=g.target?'on':'behind'}; }
  if(g.kind==='checkin'){ let n=0; for(const k in x.J){ if(!k.startsWith('day:')||!inMonth(k.slice(4)))continue; const e=x.J[k]; if(e&&(+e.sleep||+e.stress||+e.focus))n++; }
    const left=g.month===today.slice(0,7)?pzDaysBetween(today,pzMonthEnd(g.month))+1:0;
    return {pct:Math.min(1,n/g.target),now:n+' of '+g.target+' days prepped',status:n>=g.target?'done':monthOver||n+left<g.target?'missed':'on'}; }
  // run goals: the clock starts with the goal and restarts after a break. Days you don't trade
  // never break it, but they don't prove anything either: it also takes three trading days per
  // week of the target (for the limit goal, trading days with a loss limit set).
  const span=g.target*7, needT=g.target*3; let from=g.start, broke=null;
  const counts=d=>g.kind==='noslip'?true:!!(d.parts&&d.parts.limit!=null);
  for(const d of x.days){ if(d.key<g.start)continue;
    const bad=g.kind==='noslip'?((d.behavior&&d.behavior.flags&&d.behavior.flags[g.slip])||0)>0:counts(d)&&!!d.breached;
    if(bad){ broke=d.key; from=d.key; } }
  const run=Math.max(0,pzDaysBetween(from,today)), traded=x.days.filter(d=>d.key>=g.start&&(broke?d.key>broke:true)&&counts(d)).length;
  return {pct:Math.min(1,run/span,traded/needT),now:run+' of '+span+' days · '+Math.min(traded,needT)+' of '+needT+' trading days'+(broke?' · restarted '+x.label(broke):''),
    status:run>=span&&traded>=needT?'done':broke&&run<3?'behind':'on',
    note:g.kind==='limit'&&!x.days.some(d=>d.key>=g.start&&counts(d))?'Counts the days you trade with a loss limit set in your prep.':''};
}
// goals as synced: only kinds this version knows, no dropped ones
const pzGoalList=()=>(Array.isArray(settings.pzGoals)?settings.pzGoals:[]).filter(x=>x&&typeof x.id==='string'&&PZ_GOAL_KINDS[x.kind]&&!x.dropped);
const pzGoalTitle=go=>{ try{ return PZ_GOAL_KINDS[go.kind].title(go); }catch(e){ return 'A goal'; } };
function pzGoalsCtx(g){ return {days:g.days,J:journal,closed:g.ctx.closed||[],today:dayKey(Date.now()),dayOf:dayKey,journaled:isJournaled,label:dayLabel}; }
// a goal reached is stamped once (and counts for the Goal getter badge); a missed one stays until cleared
function pzGoalsSettle(g){
  const list=pzGoalList(), x=pzGoalsCtx(g); let ch=false;
  for(const go of list){ if(go.done||go.missed)continue; let e; try{ e=pzGoalEval(go,x); }catch(err){ continue; }
    if(e.status==='done'){ go.done=Date.now(); ch=true; pzNote('Goal reached: '+pzGoalTitle(go)+'.'); }
    else if(e.status==='missed'){ go.missed=Date.now(); ch=true; } }
  if(ch)Store.set(S_KEY,settings);
}
function pzGoalsHtml(g){
  try{ pzGoalsSettle(g); }catch(e){}
  const list=pzGoalList().filter(x=>!x.cleared), x=pzGoalsCtx(g);
  const card=go=>{ let e; try{ e=pzGoalEval(go,x); }catch(err){ return ''; }
    const st=go.done?'done':go.missed?'missed':e.status, col=st==='done'?PZ_COL.good:st==='missed'?PZ_COL.low:st==='behind'?PZ_COL.mid:PZ_COL.risk;
    return `<div class="pz-goal">${pzRing(st==='done'?'✓':Math.round(e.pct*100)+'%',st==='done'?1:e.pct,col,{size:64})}
      <span style="flex:1;min-width:0;display:flex;flex-direction:column;gap:2px"><b style="font-size:14px;line-height:1.35">${esc(pzGoalTitle(go))}</b>
      <span class="pz-sub" style="font-size:12px">${esc(e.now)}</span><span style="font-size:12px;font-weight:700;color:${col}">${st==='done'?'Reached':st==='missed'?'Missed':st==='behind'?'Behind':'On track'}</span>${e.note?`<span class="pz-fine">${esc(e.note)}</span>`:''}</span>
      <button type="button" class="pz-chip icon" data-pz-goaldel="${esc(go.id)}" aria-label="${go.done||go.missed?'Clear':'Drop'} this goal">${pzI('x',16)}</button></div>`; };
  const active=list.filter(x=>!x.done&&!x.missed).length, f=pzS.goalNew;
  const unit=v=>f.kind==='disc'?v+'+ average':f.kind==='journal'?v+'%':f.kind==='checkin'?v+' days':v+' weeks';
  const form=f?`<div class="pz-goalform"><div class="pz-field"><label for="pzGk" style="font-size:13px">Goal</label><select id="pzGk">${Object.entries({disc:'Discipline average for the month',noslip:'Weeks without a slip',journal:'Share of trades journaled this month',checkin:'Days prepped this month',limit:'Weeks inside your loss limit'}).map(([k,l])=>`<option value="${k}"${f.kind===k?' selected':''}>${l}</option>`).join('')}</select></div>
      ${f.kind==='noslip'?`<div class="pz-field"><label for="pzGs" style="font-size:13px">Which slip</label><select id="pzGs">${Object.entries(PZ_SLIP_TOPIC).map(([k,l])=>`<option value="${k}"${f.slip===k?' selected':''}>${l[0].toUpperCase()+l.slice(1)}</option>`).join('')}</select></div>`:''}
      <div class="pz-field"><label for="pzGt" style="font-size:13px">Target</label><select id="pzGt">${PZ_GOAL_KINDS[f.kind].targets.map(v=>`<option value="${v}"${+f.target===v?' selected':''}>${unit(v)}</option>`).join('')}</select></div>
      <div style="display:flex;gap:8px"><button type="button" class="pz-cta pz-sm" style="flex:1;min-height:42px" id="pzGsave">Set this goal</button><button type="button" class="pz-ghost pz-sm" style="flex:1" id="pzGcancel">Cancel</button></div></div>`
    :active<3?`<button type="button" class="pz-ghost pz-sm" id="pzGnew" style="width:auto;align-self:flex-start;padding:0 16px">${pzI('plus',14,3)} New goal</button>`:'<p class="pz-fine">Three goals at a time keeps each one meaningful.</p>';
  return `<section class="pz-card pz-kv pz-span"><div><b class="pz-kvh" style="display:flex;align-items:center;gap:6px">${pzI('target',16)} Process goals</b><span class="pz-sub" style="font-size:12px">How you trade, never what you make</span></div>
    ${list.length?`<div class="pz-goals">${list.map(card).join('')}</div>`:'<p class="pz-sub" style="font-size:13px">Pick a target for your process: a Discipline average, weeks without revenge entries, every trade journaled. Reaching one earns the Goal getter badge.</p>'}${form}</section>`;
}
// ---- lessons: what your evening reviews taught you, brought back before you forget ----
// Lessons come from each review's “lesson” line and its mistake answers, plus any you add.
// They come back on a spaced schedule (1, 3, 7, 14, 30, 60 days) until you've kept one through
// all six, and early when today's tilt matches the slip a lesson was written about.
const PZ_LESSON_STEPS=[1,3,7,14,30,60];
const PZ_SLIP_TOPIC={revenge:'revenge entries',afterTwo:'trading on after two losses',sizeUp:'sizing up after a loss',addLoser:'adding to losers',overtrade:'overtrading',heldLoser:'holding losers'};
const PZ_LESSON_TAGS=[['revenge',/reveng|re-?ent(er|ry)|right after (a|the) loss|win it back/i],['afterTwo',/two loss|2 loss|losing streak|tilt|stop after/i],
  ['sizeUp',/siz(e|ing)|too big|position size|leverage/i],['overtrade',/overtrad|too many|fewer trades|bored/i],['addLoser',/add(ed|ing)? to (a |my |the )?los|averag(e|ing) down/i],
  ['heldLoser',/held|holding|stop ?loss|cut (it|losers)|let (it|losers) run/i]];
function pzLessonTag(text, dayFlags){
  for(const [k,re] of PZ_LESSON_TAGS)if(re.test(text||''))return k;
  if(dayFlags){ const top=Object.keys(dayFlags).filter(k=>dayFlags[k]>0).sort((a,b)=>dayFlags[b]-dayFlags[a])[0]; if(top)return top; }
  return null;
}
// every lesson, newest first, with its schedule; st is settings.pzLessons ({items:{id:{step,due,done,off}},own:[{id,text,at}]})
function pzLessonList(J, st, flagsOf){
  st=st&&typeof st==='object'?st:{}; const items=st.items&&typeof st.items==='object'?st.items:{}, own=Array.isArray(st.own)?st.own:[], out=[];
  const add=(id,text,key,at,kind)=>{ text=String(text||'').trim(); if(text.length<3)return; const s=items[id]||{};
    if(s.off)return; out.push({id,text,key,at,kind,tag:pzLessonTag(text,flagsOf?flagsOf(key):null),step:s.step||0,due:s.due||(at+PZ_LESSON_STEPS[0]*86400000),done:!!s.done}); };
  for(const k in J){ if(!k.startsWith('day:'))continue; const e=J[k], v=e&&e.eod; if(!v||!v.at)continue; const key=k.slice(4);
    if(v.lesson)add('d:'+key+':l',v.lesson,key,v.at,'lesson');
    for(const q in (v.answers||{}))if(/mistake|not to repeat|do differently/i.test(q))add('d:'+key+':m',v.answers[q],key,v.at,'mistake'); }
  for(const o of own)if(o&&typeof o.id==='string')add(o.id,o.text,o.key||null,o.at||0,'own');
  // lessons written before resurfacing started don't all come due at once: one a day, oldest first
  const since=+st.since||0; if(since){ let i=0; for(const l of [...out].sort((a,b)=>a.at-b.at))if(!items[l.id]&&l.at<since)l.due=since+(i++)*86400000; }
  return out.sort((a,b)=>b.at-a.at);
}
function pzLessonsAll(){ let fl=null;
  // the day lessons started coming back on this account: older lessons are spread one a day from it
  if(!settings.pzLessons||!settings.pzLessons.since){ settings.pzLessons=Object.assign(pzLessonsNorm(settings.pzLessons),{since:Date.now()}); try{ Store.set(S_KEY,settings); }catch(e){} } try{ const g=gameContext(); fl=k=>{ const d=g.days.find(x=>x.key===k); return d&&d.behavior?d.behavior.flags:null; }; }catch(e){}
  return pzLessonList(journal,settings.pzLessons,fl); }
// the one due now, the longest-waiting first
function pzLessonDue(list, now){ return list.filter(l=>!l.done&&l.due<=now).sort((a,b)=>a.due-b.due)[0]||null; }
// the lesson that fits this tilt: written about the slip the reading points at, newest first
const PZ_TILT_SLIP={streak:'afterTwo',revenge:'revenge',size:'sizeUp',pace:'overtrade'};
function pzLessonFor(T, D, list){
  const want=new Set((T.reasons||[]).map(r=>PZ_TILT_SLIP[r.k]).filter(Boolean)); if(!want.size)return null;
  return (list||pzLessonsAll()).find(l=>l.tag&&want.has(l.tag))||null;
}
async function pzLessonMark(id, how){
  const st=settings.pzLessons=pzLessonsNorm(settings.pzLessons); st.items=Object.assign({},st.items);
  const l=pzLessonsAll().find(x=>x.id===id), cur=Object.assign({step:l?l.step:0},st.items[id]||{}), now=Date.now();
  if(how==='got'){ cur.step=(cur.step||0)+1; if(cur.step>=PZ_LESSON_STEPS.length)cur.done=true; else cur.due=now+PZ_LESSON_STEPS[cur.step]*86400000; }
  else if(how==='again'){ cur.step=0; cur.due=now+86400000; cur.done=false; }
  else if(how==='off'){ cur.off=true; }
  else if(how==='back'){ cur.done=false; cur.step=0; cur.due=now; }
  cur.at=now; st.items[id]=cur; await Store.set(S_KEY,settings);
}
function pzLessonDueHtml(D){
  const l=pzLessonDue(pzLessonsAll(),Date.now()); if(!l)return '';
  return `<section class="pz-card pz-kv"><div class="pz-kvrow"><span class="pz-lbl" style="color:${PZ_COL.xp}">${pzI('book',14)} A lesson to revisit</span><a class="pz-link" href="#lessons" style="min-height:0">All lessons ›</a></div>
    <p style="margin:0;font-size:16px;line-height:1.45">“${esc(l.text)}”</p><span class="pz-sub" style="font-size:12px">${l.key?'You wrote this '+esc(dayLabel(l.key)):'You added this'}${l.tag?' · about '+esc(PZ_SLIP_TOPIC[l.tag]):''}</span>
    <div style="display:flex;gap:8px"><button type="button" class="pz-cta pz-sm" style="flex:1;min-height:42px" data-pz-lesson="got" data-id="${esc(l.id)}">I still live by it</button><button type="button" class="pz-ghost pz-sm" style="flex:1" data-pz-lesson="again" data-id="${esc(l.id)}">I slipped on it</button></div></section>`;
}
function pzLessonsCardHtml(){
  const L=pzLessonsAll(), due=L.filter(l=>!l.done&&l.due<=Date.now()).length, done=L.filter(l=>l.done).length;
  return `<a class="pz-card pz-cardlink" href="#lessons"><span class="pz-ico" style="background:var(--pz-tint-xp);color:${PZ_COL.xp}">${pzI('book',20)}</span>
    <span style="flex:1;min-width:0;display:flex;flex-direction:column;gap:2px"><b style="font-size:15px">Lessons library</b><span class="pz-sub" style="font-size:12px">${L.length?L.length+' lesson'+(L.length===1?'':'s')+(due?' · '+due+' to revisit':'')+(done?' · '+done+' kept for good':''):'Your evening reviews fill it — one line a night'}</span></span>${pzI('chev',18)}</a>`;
}
function pzLessonsHtml(D){
  const back=`<a class="pz-back" href="#progress">${pzI('back',20)}Progress</a>`;
  const L=pzLessonsAll(), now=Date.now(), F=pzS.lf||'all', q=(pzS.lq||'').toLowerCase();
  const shown=L.filter(l=>(F==='due'?!l.done&&l.due<=now:F==='kept'?l.done:true)&&(!q||l.text.toLowerCase().includes(q)));
  const seg=`<div class="pz-seg" role="group" aria-label="Show">${[['all','All'],['due','To revisit'],['kept','Kept']].map(([k,l])=>`<button type="button" data-pz-lf="${k}" aria-pressed="${F===k}">${l}</button>`).join('')}</div>`;
  const pg=pzPage('lessons:'+F+':'+q,shown);
  const row=l=>`<section class="pz-card pz-kv"><p style="margin:0;font-size:15px;line-height:1.45">${esc(l.text)}</p>
    <div class="pz-kvrow"><span class="pz-sub" style="font-size:12px">${l.key?esc(dayLabel(l.key)):'Added by you'}${l.kind==='mistake'?' · a mistake':''}${l.tag?' · about '+esc(PZ_SLIP_TOPIC[l.tag]):''} · ${l.done?'kept for good':l.due<=now?'to revisit now':'next '+esc(dayLabel(dayKey(l.due)))}</span>
    <span style="display:flex;gap:10px;flex-wrap:wrap">${!l.done&&l.due<=now?`<button type="button" class="pz-linkbtn" data-pz-lesson="got" data-id="${esc(l.id)}">I still live by it</button><button type="button" class="pz-linkbtn" data-pz-lesson="again" data-id="${esc(l.id)}">I slipped on it</button>`:''}${l.done?`<button type="button" class="pz-linkbtn" data-pz-lesson="back" data-id="${esc(l.id)}">Bring it back</button>`:''}<button type="button" class="pz-linkbtn" data-pz-lesson="off" data-id="${esc(l.id)}" aria-label="Remove this lesson">Remove</button></span></div></section>`;
  return `${back}${pzHead(L.length+' lesson'+(L.length===1?'':'s'),'Lessons',seg)}
  <div class="pz-wide"><div class="pz-col">
    <div class="pz-field"><label for="pzLq" class="pz-sr">Search lessons</label><input type="search" id="pzLq" value="${esc(pzS.lq||'')}" placeholder="Search your lessons" autocomplete="off"></div>
    ${shown.length?pg.items.map(row).join('')+pg.html:`<section class="pz-card"><p class="pz-sub">${L.length?'Nothing here.':'No lessons yet. Each evening review asks for one line — today’s lesson — and it lands here.'}</p></section>`}</div>
  <div class="pz-col"><section class="pz-card pz-kv"><b class="pz-kvh">Add a lesson</b><div class="pz-field"><label for="pzLnew" class="pz-sr">Lesson</label><textarea id="pzLnew" rows="2" maxlength="200" placeholder="e.g. After two losses, I’m done for the day."></textarea></div>
      <button type="button" class="pz-ghost" id="pzLadd">Add to my lessons</button></section>
    <p class="pz-fine">Lessons come back after 1, 3, 7, 14, 30 and 60 days. Say you still live by it and it waits longer; say you slipped and it starts again tomorrow. When your tilt meter runs hot, the lesson you wrote about that slip comes back on the spot.</p></div></div>`;
}
// ---- tilt: one live reading of the triggers that come before a blow-up ----
// Each trigger scores 0–1 and carries a weight; the reading is their weighted sum, 0–100.
// Profit plays no part: three green trades in a row are not tilt, three red ones can be.
const PZ_TILT_W={streak:30,revenge:20,size:15,pace:15,risk:10,ready:10};
const PZ_TILT_HOT=65, PZ_TILT_WARM=35;
function pzTilt(o){
  const now=o.now, c=(o.closed||[]).filter(t=>t.closeTime).slice().sort((a,b)=>a.closeTime-b.closeTime);
  let run=0; for(let i=c.length-1;i>=0&&PZ_LOSS(c[i].net);i--)run++;
  let lastLoss=null; for(let i=c.length-1;i>=0;i--)if(PZ_LOSS(c[i].net)){ lastLoss=c[i]; break; }
  const since=lastLoss?Math.max(0,(now-lastLoss.closeTime)/60000):null;
  const recent=(o.opened||[]).filter(t=>t.openTime&&now-t.openTime>=0&&now-t.openTime<=3600000).length;
  const sx=o.sizeX, used=o.used, rd=o.ready;
  const parts=[
    ['streak',run>=3?1:run===2?0.7:run===1?0.3:0,run+' loss'+(run===1?'':'es')+' in a row'],
    ['revenge',since==null?0:since<15?1:since<30?0.5:0,since==null?'':Math.round(since)+' min since a loss'],
    ['size',sx==null?0:sx>=1.5?1:sx>=1.2?0.5:0,sx==null?'':'Entries at '+sx.toFixed(1)+'× your usual size'],
    ['pace',recent>=4?1:recent>=3?0.6:o.paceX>=2?0.6:0,recent>=3?recent+' entries in the last hour':'Twice your usual number of trades'],
    ['risk',used==null?0:used>=1?1:used>=0.75?0.6:0,used==null?'':Math.round(used*100)+'% of today’s risk budget used'],
    ['ready',rd==null?0:rd<40?1:rd<60?0.5:0,rd==null?'':'Readiness '+rd+' from your prep']];
  const reasons=parts.filter(p=>p[1]>0).map(([k,v,text])=>({k,pts:Math.round(PZ_TILT_W[k]*v),text})).sort((a,b)=>b.pts-a.pts);
  const score=Math.min(100,reasons.reduce((a,r)=>a+r.pts,0));
  return {score,band:score>=PZ_TILT_HOT?'hot':score>=PZ_TILT_WARM?'warm':'calm',reasons,run,since,recent,
    // what set it off: the latest fill-driven event, so one break covers one episode
    key:Math.max(lastLoss?lastLoss.closeTime:0,...(o.opened||[]).map(t=>t.openTime||0),0)};
}
function pzTiltOf(D){
  const opened=(D.ctx.trades||[]).filter(t=>t.openTime&&dayKey(t.openTime)===D.todayK);
  return pzTilt({now:Date.now(),closed:D.risk.closed,opened,sizeX:D.risk.sizeX,paceX:D.load&&D.load.rN,used:D.risk.used,ready:D.ready});
}
const pzTiltCol=b=>b==='hot'?PZ_COL.low:b==='warm'?PZ_COL.mid:PZ_COL.good;
// ---- live tilt alerts: one specific pattern in today's fills, said once and calmly ----
// Checked after each refresh that brings new fills. Patterns: a re-entry within 15 minutes of a
// loss, 3 losses within 45 minutes, sizing up right after a loss, more trades than the day's plan
// (or well past your usual day), and the loss limit (80% used, or reached). Only what happened in
// the last hour, on today's date on your clock. Also run by server.js, from a member's public
// fills, for pushes while Pulse is closed: so everything comes in as arguments.
// trades: closed and open; o: {now, dayOf, isLoss, maxTrades, lossLimit}. Most urgent first.
function pzTiltAlerts(trades, o){
  const now=o.now, dayOf=o.dayOf, loss=o.isLoss||(n=>n<-1), M=60000, today=dayOf(now);
  const size=t=>Math.abs((+t.maxSize||0)*(+t.avgEntry||0)), mins=ms=>Math.max(1,Math.round(ms/M)), S=n=>n===1?'':'s';
  const tr=(trades||[]).filter(t=>t&&t.openTime&&t.openTime<=now&&!t.partialHistory);
  const closes=tr.filter(t=>!t.isOpen&&t.closeTime&&t.closeTime<=now).sort((a,b)=>a.closeTime-b.closeTime);
  const entries=tr.filter(t=>!t.carried&&dayOf(t.openTime)===today).sort((a,b)=>a.openTime-b.openTime);
  // the trade that closed last at or before ms (a stop-and-reverse re-enters on the same fill)
  const prevClose=(ms,self)=>{ let p=null; for(const c of closes){ if(c.closeTime>ms)break; if(c!==self)p=c; } return p; };
  const out=[], add=(k,at,title,text)=>{ if(at>now-60*M&&at<=now)out.push({k,at,title,text}); };
  // the loss limit: realized P&L today, the close that crossed 80% and the one that reached it
  const lim=+o.lossLimit||0;
  if(lim>0){ let net=0, at80=0, at100=0;
    for(const c of closes)if(dayOf(c.closeTime)===today){ net+=+c.net||0; const used=-net/lim;
      if(used>=1){ if(!at100)at100=c.closeTime; } else at100=0;
      if(used>=0.8){ if(!at80)at80=c.closeTime; } else at80=0; }
    if(at100)add('limit',at100,'Today’s loss limit is reached','You’ve reached the loss limit you set for today. The best trade now is no trade. Close the app and come back fresh tomorrow?');
    else if(at80)add('limit80',at80,'Close to today’s loss limit','You’ve used '+Math.round(100*-net/lim)+'% of today’s loss limit. This is a good moment to stop for the day, or at least step away for 15 minutes.'); }
  // 3 losses within 45 minutes (today's closes only)
  const L=closes.filter(c=>loss(c.net)&&dayOf(c.closeTime)===today);
  for(let i=L.length-1;i>=2;i--){ const span=L[i].closeTime-L[i-2].closeTime;
    if(span<=45*M){ add('streak3',L[i].closeTime,'Three losses close together','3 losses in '+mins(span)+' minute'+S(mins(span))+'. This is when revenge trades happen. Step away for 15 minutes?'); break; } }
  // re-entry within 15 minutes of a loss, and a bigger size than usual right after one (latest first)
  for(let i=entries.length-1;i>=0;i--){ const e=entries[i], p=prevClose(e.openTime,e);
    if(p&&loss(p.net)&&e.openTime-p.closeTime<=15*M){ const m=mins(e.openTime-p.closeTime);
      add('revenge',e.openTime,'A quick re-entry after a loss','A new trade '+m+' minute'+S(m)+' after a loss. Quick re-entries are how revenge trading starts. Step away for 15 minutes?'); break; } }
  for(let i=entries.length-1;i>=0;i--){ const e=entries[i], p=prevClose(e.openTime,e);
    if(!p||!loss(p.net)||e.openTime-p.closeTime>2*3600000)continue;
    const prior=closes.filter(c=>c.closeTime<e.openTime).slice(-30).map(size).filter(x=>x>0), med=prior.length>=5?nfMedian(prior):null;
    if(med&&size(e)>1.5*med){
      add('sizeUp',e.openTime,'A bigger size after a loss','This trade is '+(size(e)/med).toFixed(1)+'× your usual size, right after a loss. Going bigger to win it back is a classic tilt move. Back to your usual size, or step away for 15 minutes?'); break; } }
  // more trades than planned, or than a usual day (entries by open day, the last 30 trading days)
  const n=entries.length, cap=+o.maxTrades||0;
  if(cap>0&&n>cap)add('overtrade',entries[cap].openTime,'More trades than you planned','That’s trade '+n+' today, and your plan was '+cap+'. Good setups rarely come in bunches. Call it a day, or step away for 15 minutes?');
  else { const per={}; for(const t of tr){ if(t.carried)continue; const k=dayOf(t.openTime); if(k<today)per[k]=(per[k]||0)+1; }
    const ks=Object.keys(per).sort().slice(-30), med=ks.length>=5?nfMedian(ks.map(k=>per[k])):null, u=med!=null?Math.max(3,Math.ceil(med*1.5)):null;
    if(u!=null&&n>u)add('overtrade',entries[u].openTime,'A busier day than usual','That’s trade '+n+' today; a usual day for you is about '+Math.round(med)+'. Good setups rarely come in bunches. Call it a day, or step away for 15 minutes?'); }
  const P=['limit','streak3','revenge','sizeUp','overtrade','limit80'];
  return out.sort((a,b)=>P.indexOf(a.k)-P.indexOf(b.k));
}
// The rules: each pattern at most once a day (the day on your clock), none within 30 minutes of
// the last alert. st: {day, fired:{pattern:at}, last} as returned before (null to start).
// Returns the alert to show now (or null) and the state to keep.
function pzTiltAlertPick(cands, st, now, today){
  const last=st&&+st.last||0, fired=st&&st.day===today&&st.fired?st.fired:{};
  const keep={day:today,fired:Object.assign({},fired),last};
  if(now-last<30*60000)return {pick:null,st:keep};
  const pick=(cands||[]).find(c=>!keep.fired[c.k])||null;
  if(pick){ keep.fired[pick.k]=now; if(pick.k==='limit')keep.fired.limit80=now; keep.last=now; }
  return {pick,st:keep};
}
// Plain stats for a window: the full app's computeStats, plus markets, hours and daily P&L.
function pzStatsFor(trades, fromMs){
  const all=(trades||[]).filter(t=>t.closeTime&&t.closeTime>=fromMs&&!t.isOpen);
  if(!all.length)return null;
  const s=computeStats(all,all);
  const mk={}, hr={}, dy={};
  for(const t of all){ const m=dcoin(t); (mk[m]=mk[m]||{net:0,n:0}); mk[m].net+=t.net; mk[m].n++;
    const h=tzParts(t.openTime||t.closeTime).h; (hr[h]=hr[h]||{net:0,n:0}); hr[h].net+=t.net; hr[h].n++;
    const d=dayKey(t.closeTime), o=dy[d]=dy[d]||{net:0,n:0,w:0,l:0}; o.net+=t.net; o.n++; if(isWin(t.net))o.w++; else if(isLoss(t.net))o.l++; }
  const markets=Object.entries(mk).map(([k,v])=>({k,...v})).sort((a,b)=>b.net-a.net);
  const hours=Object.entries(hr).map(([k,v])=>({h:+k,...v})).filter(x=>x.n>=3).sort((a,b)=>b.net-a.net);
  return {s,markets,hours,days:Object.keys(dy).sort().map(k=>({k,...dy[k]}))};
}
// In-depth stats for a window: the breakdowns behind the Stats tab. Pure given its inputs
// (o: isWin, isLoss, coin, hourOf, dowOf, monthOf). trades = closed trades in the window.
function pzDeepStats(trades, o){
  const tr=[...(trades||[])].filter(t=>!t.isOpen&&t.closeTime).sort((a,b)=>a.closeTime-b.closeTime);
  if(!tr.length)return null;
  const W=t=>o.isWin(t.net), L=t=>o.isLoss(t.net);
  // counts use the break-even band; profit factor is gross over every trade (as in the main stats)
  const agg=list=>{ let net=0,gp=0,gl=0,w=0,l=0; for(const t of list){ net+=t.net; if(t.net>0)gp+=t.net; else gl-=t.net; if(W(t))w++; else if(L(t))l++; }
    return {n:list.length,net,avg:list.length?net/list.length:null,winRate:w+l?w/(w+l):null,pf:gl>0?gp/gl:(gp>0?Infinity:null)}; };
  const group=(keyOf,order)=>{ const m=new Map(); for(const t of tr){ const k=keyOf(t); if(k==null)continue; if(!m.has(k))m.set(k,[]); m.get(k).push(t); }
    const rows=[...m].map(([k,v])=>({k,...agg(v)})); if(order)rows.sort(order); return rows; };
  const size=t=>Math.abs((+t.maxSize||0)*(+t.avgEntry||0)), hold=t=>t.closeTime-(t.openTime||t.closeTime);
  // equity and drawdown, trade by trade
  let cum=0, peak=0; const curve=tr.map(t=>{ cum+=t.net; if(cum>peak)peak=cum; return {at:t.closeTime,cum,dd:cum-peak,net:t.net,id:t.id}; });
  let maxDD=0, ddFrom=null, ddTo=null, pk=0, pkAt=tr[0].closeTime;
  for(const c of curve){ if(c.cum>=pk){ pk=c.cum; pkAt=c.at; } if(c.cum-pk<maxDD){ maxDD=c.cum-pk; ddFrom=pkAt; ddTo=c.at; } }
  // size quarters: smallest to biggest notional, so you see whether size and results line up
  // quarters by rank (ties split evenly by entry order), each labelled with the sizes it actually holds
  const sized=tr.filter(t=>size(t)>0).sort((a,b)=>size(a)-size(b)||a.closeTime-b.closeTime), qOf=new Map();
  sized.forEach((t,i)=>qOf.set(t,Math.min(3,Math.floor(4*i/sized.length))));
  const bySize=sized.length>=8?group(t=>qOf.has(t)?qOf.get(t):null,(a,b)=>a.k-b.k).map(r=>{ const v=sized.filter(t=>qOf.get(t)===r.k).map(size);
      return {...r,label:['Smallest ¼','Second ¼','Third ¼','Biggest ¼'][r.k],from:Math.min(...v),to:Math.max(...v)}; }):[];
  const real=t=>!t.partialHistory&&t.openTime; // trades cut off at the start of the history have no real entry time
  const HB=[[5,'Under 5 min'],[60,'5–60 min'],[240,'1–4 hours'],[1440,'4–24 hours'],[Infinity,'Over a day']];
  const byHold=group(t=>{ if(!real(t))return null; const m=hold(t)/60000; return HB.findIndex(h=>m<h[0]); },(a,b)=>a.k-b.k).map(r=>({...r,label:HB[r.k][1]}));
  // streaks, and what happens right after a win or a loss
  // runs: break-even trades neither extend nor break a run (as in the full app's stats)
  let run=0, runSign=0, bestW=0, bestL=0; const after={win:[],loss:[]};
  const ct=tr.map(t=>t.closeTime), lastBefore=ms=>{ let lo=0,hi=ct.length; while(lo<hi){ const m=(lo+hi)>>1; if(ct[m]<=ms)lo=m+1; else hi=m; } return lo-1; };
  tr.forEach(t=>{ const sg=W(t)?1:L(t)?-1:0;
    if(sg){ if(sg===runSign)run++; else { run=1; runSign=sg; } if(sg>0)bestW=Math.max(bestW,run); else bestL=Math.max(bestL,run); }
    // the trade that closed last before this one was opened, even with other positions open in between
    if(!real(t))return; let q=lastBefore(t.openTime); while(q>=0&&tr[q]===t)q--;
    const p=q>=0?tr[q]:null; if(p){ if(W(p))after.win.push(t); else if(L(p))after.loss.push(t); } });
  // outcome spread in units of your typical trade (median absolute result)
  const absMed=(()=>{ const a=tr.map(t=>Math.abs(t.net)).filter(x=>x>0).sort((x,y)=>x-y); return a.length?a[Math.floor(a.length/2)]:0; })();
  // losses and wins in steps of your typical trade; trades inside your break-even band get their own row
  const BL=[[-Infinity,-3],[-3,-1],[-1,0]], BW=[[0,1],[1,3],[3,Infinity]];
  const inB=(t,lo,hi)=>{ const x=Math.abs(t.net)/absMed; return x>lo&&x<=hi; };
  const dist=absMed>0?[...BL.map(([lo,hi])=>({kind:'loss',lo:-hi*absMed,hi:-lo*absMed,n:tr.filter(t=>L(t)&&inB(t,-hi,-lo)).length})),
    {kind:'even',n:tr.filter(t=>!W(t)&&!L(t)).length},
    ...BW.map(([lo,hi])=>({kind:'win',lo:lo*absMed,hi:hi*absMed,n:tr.filter(t=>W(t)&&inB(t,lo,hi)).length}))]:[];
  const nets=tr.map(t=>t.net);
  return {all:agg(tr),curve,maxDD,ddFrom,ddTo,
    side:group(t=>t.dir||null,(a,b)=>b.n-a.n),
    markets:group(o.coin,(a,b)=>b.net-a.net),
    dow:group(t=>o.dowOf(t.openTime||t.closeTime),(a,b)=>((a.k+6)%7)-((b.k+6)%7)),
    hours:group(t=>o.hourOf(t.openTime||t.closeTime),(a,b)=>a.k-b.k),
    months:group(t=>o.monthOf(t.closeTime),(a,b)=>a.k<b.k?-1:1),
    // from the journal: what you called the setup, and how well you rated your own execution (1–5)
    setups:o.setupOf?group(t=>{ const x=o.setupOf(t); return x?x.toLowerCase():null; },(a,b)=>b.n-a.n).map(r=>Object.assign(r,{label:o.setupOf(tr.find(t=>(o.setupOf(t)||'').toLowerCase()===r.k))})):[],
    ratings:o.ratingOf?group(t=>{ const x=o.ratingOf(t); return x>=1&&x<=5?x:null; },(a,b)=>b.k-a.k):[],
    vol:o.volOf?group(o.volOf,(a,b)=>['low','normal','high'].indexOf(a.k)-['low','normal','high'].indexOf(b.k)):[],
    trend:o.trendOf?group(o.trendOf,(a,b)=>['up','down','mixed','chop'].indexOf(a.k)-['up','down','mixed','chop'].indexOf(b.k)):[],
    bySize,byHold,dist,absMed,
    streaks:{bestW,bestL,current:run*runSign},
    after:{win:agg(after.win),loss:agg(after.loss)},
    best:Math.max(...nets),worst:Math.min(...nets),
    holdW:nfMedian(tr.filter(t=>W(t)&&real(t)).map(hold).filter(x=>x>0)),holdL:nfMedian(tr.filter(t=>L(t)&&real(t)).map(hold).filter(x=>x>0)),partial:tr.filter(t=>!real(t)).length};
}
// What the six slips cost over a window: each slip's trades and their total, against clean trades.
function pzSlipCost(days){
  const by={}; let slipN=0, slipNet=0, cleanN=0, cleanNet=0;
  for(const d of (days||[])){ const b=d.behavior||d; let dn=0;
    for(const s of (b.slips||[])){ slipN++; slipNet+=s.net; dn+=s.net; for(const f of s.f){ (by[f]=by[f]||{n:0,net:0}); by[f].n++; by[f].net+=s.net; } }
    cleanN+=b.clean||0; cleanNet+=(b.net||0)-dn; }
  return {by,slipN,slipNet,cleanN,cleanNet,slipAvg:slipN?slipNet/slipN:null,cleanAvg:cleanN?cleanNet/cleanN:null};
}

/* ======================= 13 · PULSE GROWTH: badges, leaks, habits, routines, reports, coach ======================= */
// ---- the badge catalog: families of badges in six tiers, earned from your own history ----
// Every badge rewards process or consistency; the Results family counts what you kept, never a single
// lucky trade. A family shows its next tier as soon as you're in it, and new families appear as
// your collection grows (reveal = badges you need before a family shows up), so there's always
// something next to chase. Each earned badge adds a little XP on the day it was earned.
// calendar arithmetic on day keys (no clock involved)
const pzAddDays=(k,n)=>new Date(Date.parse(k+'T00:00:00Z')+n*86400000).toISOString().slice(0,10);
const PZ_TIERS=['Bronze','Silver','Gold','Platinum','Diamond','Legend'];
const PZ_TIER_COL=['#C98A5B','#B8C2CC','#F4C04E','#7FE0D2','#8FA8FF','#FF8AD8'];
// the same tiers as text on a light background, dark enough to read (the fills above stay)
const PZ_TIER_TXT_LIGHT=['#99582B','#5E6A77','#8C6400','#16786C','#3A55C9','#A8287F'];
const pzTierText=r=>(typeof document!=='undefined'&&document.body&&document.body.classList.contains('light')?PZ_TIER_TXT_LIGHT:PZ_TIER_COL)[r];
const PZ_TIER_XP=[5,10,20,40,80,160];
const PZ_BADGE_CATS={discipline:'Discipline',habits:'Habits',consistency:'Consistency',journal:'Journaling',routine:'Routines',risk:'Risk control',results:'Results',milestones:'Milestones',mentoring:'Mentoring'};
const pzN=n=>n>=1e6?(n/1e6)+'M':n>=1e3&&n%1e3===0?(n/1e3)+'k':String(n);
const pzUsd=n=>'$'+pzN(n);
// [id, category, title, what one counts, tiers, reveal]
const PZ_FAMILIES=[
  ['clean','discipline','Clean slate',t=>t+' trading day'+(t===1?'':'s')+' with every trade clean',[1,5,15,40,100,250],0],
  ['good','discipline','In control',t=>t+' trading days scoring 70+',[3,10,30,75,150,365],0],
  ['streak','discipline','Unbroken',t=>'a '+t+'-day discipline streak',[3,7,14,30,60,120],0],
  ['perfect','discipline','Perfect week',t=>t+' perfect week'+(t===1?'':'s')+' (every trading day 70+)',[1,3,8,16,32,52],3],
  ['norevenge','discipline','Cool head',t=>t+' days with a loss and no revenge entry',[3,10,25,60,120,250],2],
  ['satout','discipline','Two strikes',t=>t+' time'+(t===1?'':'s')+' you stopped after two losses in a row',[1,3,8,20,40,80],4],
  ['steady','discipline','Steady size',t=>t+' days with a loss and no sizing up after it',[3,10,25,60,120,250],6],
  ['noadd','discipline','No averaging down',t=>t+' days with a losing trade and nothing added to it',[5,15,40,100,200,400],8],
  ['pace','discipline','Own pace',t=>t+' busy days without overtrading',[5,20,50,100,200,400],10],
  ['cutloss','discipline','Cut it short',t=>t+' days with a loss and no loser held too long',[5,15,40,100,200,400],12],
  ['habitdays','habits','Habit builder',t=>t+' habit-days kept',[5,25,75,200,500,1000],1],
  ['habitrun','habits','Locked in',t=>'one habit kept '+t+' trading days running',[3,7,14,30,60,120],2],
  ['challenge','habits','Challenger',t=>t+' weekly challenge'+(t===1?'':'s')+' completed',[1,3,6,12,26,52],0],
  ['adopt','habits','Toolbox',t=>t+' habit'+(t===1?'':'s')+' adopted',[1,2,3,5,8,12],0],
  ['goals','habits','Goal getter',t=>t+' process goal'+(t===1?'':'s')+' reached',[1,3,6,12,24,48],1],
  ['plugged','habits','Leak plugged',t=>t+' leak'+(t===1?'':'s')+' plugged for three weeks straight',[1,2,3,4,5,6],5],
  ['days','consistency','Showing up',t=>t+' trading days',[10,30,75,150,300,600],0],
  ['weeks','consistency','Week after week',t=>t+' weeks traded',[4,12,26,52,104,208],2],
  ['wk80','consistency','Process week',t=>t+' week'+(t===1?'':'s')+' averaging 80+',[1,3,6,12,24,52],6],
  ['m70','consistency','Steady month',t=>t+' month'+(t===1?'':'s')+' averaging 70+',[1,2,4,6,9,12],10],
  ['jtrades','journal','Scribe',t=>t+' trades journaled',[10,50,150,400,1000,2500],0],
  ['jrun','journal','Every trade, every day',t=>'every trade journaled '+t+' trading days running',[3,7,14,30,60,120],2],
  ['notes','journal','Reflective',t=>t+' trades with notes',[5,25,75,200,500,1000],3],
  ['setups','journal','Setup spotter',t=>t+' trades tagged with a setup',[10,50,150,400,1000,2500],5],
  ['checkin','routine','Self-aware',t=>t+' morning'+(t===1?'':'s')+' prepped',[1,7,30,90,180,365],0],
  ['plan','routine','Plan first',t=>t+' days with a plan before the first trade',[1,7,30,90,180,365],0],
  ['review','routine','Day reviewed',t=>t+' end-of-day review'+(t===1?'':'s'),[1,7,30,90,180,365],0],
  ['ready','routine','Rested and ready',t=>t+' preps at readiness 70+',[3,15,45,100,200,365],4],
  ['limitok','risk','Inside the lines',t=>t+' days inside your loss limit',[5,20,50,100,200,365],1],
  ['walked','risk','Walked away',t=>t+' time'+(t===1?'':'s')+' you hit the limit and stopped',[1,3,6,12,24,48],3],
  ['stoplive','risk','Stop first',t=>t+' stops written while the trade was open',[5,25,75,200,500,1000],2],
  ['stopok','risk','Stop honored',t=>t+' stops honored',[5,25,75,200,500,1000],4],
  ['nobig','risk','No blow-ups',t=>t+' days without one outsized loss',[10,30,75,150,300,600],6],
  ['green','results','Green day',t=>t+' green trading days',[1,10,30,75,150,300],0],
  ['greenwk','results','Green week',t=>t+' green week'+(t===1?'':'s'),[1,4,12,26,52,104],3],
  ['greenmo','results','Green month',t=>t+' green month'+(t===1?'':'s'),[1,3,6,12,24,36],6],
  ['netprofit','results','In the black',t=>pzUsd(t)+' net profit, all time',[100,1000,10000,50000,250000,1000000],2],
  ['bestday','results','Big day',t=>'a '+pzUsd(t)+' day',[100,500,2500,10000,50000,250000],4],
  ['pfmonth','results','Edge month',t=>t+' month'+(t===1?'':'s')+' with a 1.5+ profit factor (20+ trades)',[1,2,4,6,9,12],8],
  ['highs','results','New high',t=>t+' new all-time equity high'+(t===1?'':'s'),[1,10,25,50,100,250],3],
  ['comeback','results','Comeback',t=>t+' comeback'+(t===1?'':'s')+' from a deep drawdown to a new high',[1,2,3,5,8,12],10],
  ['trades','milestones','Reps',t=>t+' trades closed',[10,50,100,500,1000,5000],0],
  ['level','milestones','Rank up',t=>'level '+t,[2,5,10,20,35,50],0],
  ['xp','milestones','Experience',t=>pzN(t)+' XP',[1000,5000,20000,50000,100000,250000],1],
  ['tenure','milestones','Veteran',t=>t+' days since your first trade',[7,30,90,180,365,730],1],
  ['teacher','mentoring','Teacher',t=>t+' trade'+(t===1?'':'s')+' reviewed for a mentee',[1,10,30,75,150,300],0],
  ['helped','mentoring','Made a difference',t=>t+' mentee result'+(t===1?'':'s')+' (a leak plugged, a perfect week, a Trader Age milestone)',[1,3,6,12,24,48],0],
  ['traderage','milestones','Seasoned',t=>'a Trader Age of '+t+' year'+(t===1?'':'s'),[1,2,4,6,8,12],2],
];
// days -> keys where a condition held; nth key = the day the nth was reached
function pzBadgeCatalog(G){
  const ctx=G.ctx, D=G.days, X=pzXpCfg(), J=journal, today=dayKey(G.now||Date.now());
  const byDay=ctx.byDay||{}, closed=[...(ctx.closed||[])].sort((a,b)=>a.closeTime-b.closeTime);
  const loss=t=>PZ_LOSS(t.net), dayTr=k=>(byDay[k]||[]).slice().sort((a,b)=>a.closeTime-b.closeTime);
  const EV={}, SER={}; // EV: sorted day keys, one per unit; SER: [[key,value]] running values
  const add=(id,keys)=>{ EV[id]=keys.filter(Boolean).sort(); };
  const run=(id,pairs)=>{ SER[id]=pairs; };
  const lossDay=d=>dayTr(d.key).some(loss), f=d=>(d.behavior&&d.behavior.flags)||{};
  add('clean',D.filter(d=>d.n>=1&&d.score===100).map(d=>d.key));
  add('good',D.filter(d=>d.score>=70).map(d=>d.key));
  // the same shield-bridged streak the hero shows
  { const sh=new Set((G.streak&&G.streak.shielded)||[]); let r=0; run('streak',D.map(d=>{ r=d.score>=70?r+1:sh.has(d.key)&&r>0?r:0; return [d.key,r]; })); }
  add('perfect',(G.streak.perfectWeeks||[]).map(w=>w.key));
  add('norevenge',D.filter(d=>lossDay(d)&&!f(d).revenge).map(d=>d.key));
  add('satout',D.filter(d=>{ const a=dayTr(d.key); for(let i=0;i+1<a.length;i++)if(loss(a[i])&&loss(a[i+1])){ const end=a[i+1].closeTime; return !a.some(t=>t.openTime>end); } return false; }).map(d=>d.key));
  add('steady',D.filter(d=>lossDay(d)&&!f(d).sizeUp).map(d=>d.key));
  add('noadd',D.filter(d=>lossDay(d)&&!f(d).addLoser).map(d=>d.key));
  add('pace',D.filter(d=>d.n>=2&&!f(d).overtrade).map(d=>d.key));
  add('cutloss',D.filter(d=>lossDay(d)&&!f(d).heldLoser).map(d=>d.key));
  // habits
  const hk=[], hrun=[];
  for(const h of habitsList()){ const res=habitProgress(h,ctx).res, sh=new Set(disciplineStreak(res.map(x=>({key:x.key,score:x.kept?100:0})),G.nowWeek).shielded); let r=0;
    for(const x of res){ if(x.kept)hk.push(x.key); r=x.kept?r+1:sh.has(x.key)&&r>0?r:0; hrun.push([x.key,r]); } }
  add('habitdays',hk); run('habitrun',hrun.sort((a,b)=>a[0]<b[0]?-1:1));
  add('challenge',(G.challenges||[]).filter(c=>c.status==='done').map(c=>c.key));
  add('goals',(Array.isArray(settings.pzGoals)?settings.pzGoals:[]).filter(x=>x&&x.done&&!x.dropped).map(x=>dayKey(x.done)));
  add('adopt',(Array.isArray(settings.habits)?settings.habits:[]).filter(h=>h&&h.createdAt).map(h=>dayKey(h.createdAt)));
  { const seen=new Set(); add('plugged',pzPlugs().filter(p=>p.done&&!p.dropped&&!seen.has(p.slip+'|'+p.done)&&seen.add(p.slip+'|'+p.done)).map(p=>p.done)); } // a stopped plug earns nothing; one leak counts once
  // consistency
  add('days',D.map(d=>d.key));
  { const seen=new Set(), k=[]; for(const d of D){ const w=isoWeekOfKey(d.key); if(!seen.has(w)){ seen.add(w); k.push(d.key); } } add('weeks',k); }
  const curWeek=isoWeekOfKey(today), curMonth=today.slice(0,7), grp=(fn)=>{ const o={}; for(const d of D)(o[fn(d.key)]=o[fn(d.key)]||[]).push(d); return o; };
  const W=grp(isoWeekOfKey), M=grp(k=>k.slice(0,7)), lastKey=a=>a[a.length-1].key;
  add('wk80',Object.keys(W).filter(w=>w!==curWeek&&W[w].length>=3&&_avg(W[w].map(d=>d.score))>=80).map(w=>lastKey(W[w])));
  add('m70',Object.keys(M).filter(m=>m!==curMonth&&M[m].length>=5&&_avg(M[m].map(d=>d.score))>=70).map(m=>lastKey(M[m])));
  // journal
  const jt=closed.filter(t=>isJournaled(J[t.id]));
  add('jtrades',jt.map(t=>dayKey(t.closeTime)));
  { let r=0; run('jrun',Object.keys(byDay).sort().map(k=>{ r=byDay[k].every(t=>isJournaled(J[t.id]))?r+1:0; return [k,r]; })); }
  add('notes',closed.filter(t=>J[t.id]&&J[t.id].notes).map(t=>dayKey(t.closeTime)));
  add('setups',closed.filter(t=>J[t.id]&&J[t.id].setup).map(t=>dayKey(t.closeTime)));
  // routines
  const dayE=Object.keys(J).filter(k=>k.startsWith('day:')).map(k=>[k.slice(4),J[k]]).filter(([k,e])=>e&&typeof e==='object'&&/^\d{4}-\d{2}-\d{2}$/.test(k));
  add('checkin',dayE.filter(([k,e])=>e.sleep||e.stress||e.focus).map(([k])=>k));
  add('plan',D.filter(d=>d.parts&&d.parts.plan===1).map(d=>d.key));
  add('review',dayE.filter(([k,e])=>e.eod&&e.eod.at).map(([k])=>k));
  add('ready',dayE.filter(([k,e])=>(pzReadinessManual(e)||0)>=70).map(([k])=>k));
  // risk
  add('limitok',D.filter(d=>d.parts&&d.parts.limit!=null&&!d.breached).map(d=>d.key));
  add('walked',D.filter(d=>d.breached&&d.parts&&d.parts.limit===1).map(d=>d.key));
  const pa=G.pa||{items:[]}, closeK=new Map(closed.map(t=>[t.id,dayKey(t.closeTime)]));
  add('stoplive',pa.items.filter(x=>x.live===true).map(x=>closeK.get(x.id)));
  add('stopok',pa.items.filter(x=>x.stopHonored).map(x=>closeK.get(x.id)));
  const absMed=nfMedian(closed.map(t=>Math.abs(t.net)).filter(x=>x>0))||0;
  add('nobig',absMed?D.filter(d=>d.n>=1&&dayTr(d.key).every(t=>t.net>-3*absMed)).map(d=>d.key):[]);
  // results: what you kept, by day, week and month
  add('green',D.filter(d=>d.net>0).map(d=>d.key));
  add('greenwk',Object.keys(W).filter(w=>w!==curWeek&&W[w].reduce((a,d)=>a+d.net,0)>0).map(w=>lastKey(W[w])));
  add('greenmo',Object.keys(M).filter(m=>m!==curMonth&&M[m].reduce((a,d)=>a+d.net,0)>0).map(m=>lastKey(M[m])));
  { let cum=0, hi=0, peak=0, trough=0, deep=false; const cs=[], highs=[], backs=[];
    for(const t of closed){ cum+=t.net; const k=dayKey(t.closeTime); cs.push([k,cum]);
      if(cum>peak&&cum>0){ highs.push(k); if(deep)backs.push(k); deep=false; peak=cum; trough=cum; }
      else { trough=Math.min(trough,cum); if(absMed&&peak-trough>=5*absMed)deep=true; }
      if(cum>hi)hi=cum; }
    run('netprofit',cs); add('highs',highs); add('comeback',backs); }
  { let best=0; run('bestday',D.map(d=>{ best=Math.max(best,d.net); return [d.key,best]; })); }
  add('pfmonth',Object.keys(M).filter(m=>m!==curMonth).filter(m=>{ const tr=M[m].flatMap(d=>dayTr(d.key)); if(tr.length<20)return false;
    const gp=tr.filter(t=>t.net>0).reduce((a,t)=>a+t.net,0), gl=-tr.filter(t=>t.net<0).reduce((a,t)=>a+t.net,0); return gl>0&&gp/gl>=1.5; }).map(m=>lastKey(M[m])));
  // milestones
  add('trades',closed.map(t=>dayKey(t.closeTime)));
  { let cum=0; const pairs=Object.keys((G.xpByDay)||{}).sort().map(k=>{ cum+=G.xpByDay[k]; return [k,cum]; });
    run('xp',pairs.length?pairs:[[today,G.xp||0]]); run('level',(pairs.length?pairs:[[today,G.xp||0]]).map(([k,v])=>[k,levelFor(v).level])); }
  // mentoring (mentors only): reviews and mentees' results, counted per day by the server
  { const md=(typeof SOC!=='undefined'&&SOC.me&&SOC.me.mentorXp&&SOC.me.mentorXp.days)||{}, rk=[], ok=[];
    for(const k of Object.keys(md).sort()){ for(let i=0;i<(md[k].r||0);i++)rk.push(k); for(let i=0;i<(md[k].o||0);i++)ok.push(k); }
    add('teacher',rk); add('helped',ok); }
  // Trader Age (app/features/trader-age.js): its value at the end of each trading day
  if(typeof taHistoryOf==='function'){ try{ run('traderage',taHistoryOf(D).filter(h=>h.age!=null).map(h=>[h.key,h.age])); }catch(e){ console.warn('trader age history',e); } }
  { const first=D.length?D[0].key:null; if(first){ const span=Math.floor((Date.parse(today)-Date.parse(first))/86400000); run('tenure',[[today,span]]); SER.tenureFrom=first; } }
  // tiers -> badges
  const out=[], fams=[], xpScale=(X.achievement||0)/50;
  const mentorFams=typeof SOC!=='undefined'&&SOC.me&&(SOC.me.mentor||SOC.me.mentorXp), fams0=PZ_FAMILIES.filter(f=>f[1]!=='mentoring'||mentorFams);
  for(const [id,cat,title,desc,tiers,reveal] of fams0){
    const ev=EV[id], ser=SER[id];
    const value=ev?ev.length:ser&&ser.length?Math.max(...ser.map(p=>p[1])):0;
    const reached=t=>ev?(ev.length>=t?ev[t-1]:null):id==='tenure'?(value>=t?pzAddDays(SER.tenureFrom,t):null):(ser||[]).find(p=>p[1]>=t)?ser.find(p=>p[1]>=t)[0]:null;
    const T=tiers.map((t,r)=>{ const k=reached(t); return {id:id+'-'+t,fam:id,c:cat,r,t:title+' · '+PZ_TIERS[r],need:t,desc:desc(t),k,earned:!!k,xp:k?Math.round(PZ_TIER_XP[r]*xpScale):0}; });
    for(const b of T)if(b.earned)out.push(b);
    fams.push({id,cat,title,value,tiers:T,reveal,next:T.find(b=>!b.earned)||null});
  }
  // the classic achievements keep their own XP; they join the case as gold milestones
  for(const a of (G.achievements||[]))if(a.at)out.push({id:'a-'+a.id,fam:'a',c:'milestones',r:2,t:a.title,desc:a.desc,k:a.at,earned:true,xp:0});
  out.sort((a,b)=>a.k<b.k?-1:a.k>b.k?1:b.r-a.r);
  const n=out.length;
  for(const f of fams)f.visible=f.tiers.some(b=>b.earned)||n>=f.reveal;
  const total=fams0.reduce((a,f)=>a+f[4].length,0)+(G.achievements||[]).length;
  return {earned:out,families:fams,total,hidden:fams.filter(f=>!f.visible).reduce((a,f)=>a+f.tiers.length,0)};
}

// ---- leaks: what each Discipline slip costs you, and plugging one with a habit ----
const PZ_PLUG={revenge:{when:'I close a losing trade',then:'I wait at least 15 minutes before the next entry'},
  afterTwo:{when:'I’ve lost twice in a row today',then:'I stop for the day'},
  sizeUp:{when:'I’ve just taken a loss',then:'my next trade is no bigger than my usual size'},
  addLoser:{when:'a position goes against me',then:'I don’t add to it'},
  overtrade:{when:'I’ve taken my usual number of trades',then:'I only take an A+ setup'},
  heldLoser:{when:'a losing trade reaches my stop',then:'I close it — no hoping'}};
// A plug is kept as {slip, from, habitId}; its progress is read from fills, week by week.
function pzPlugState(p){
  const weeks={}, curWeek=isoWeekOfKey(dayKey(Date.now()));
  for(const [k,b] of _pzSlipDays){ if(k<p.from)continue; const w=isoWeekOfKey(k); const x=(weeks[w]=weeks[w]||{week:w,days:0,count:0,cost:0});
    x.days++; for(const s of (b.slips||[]))if(s.f.includes(p.slip)){ x.count++; x.cost+=s.net; } }
  const list=Object.values(weeks).sort((a,b)=>a.week<b.week?-1:1);
  let runN=0, done=null;
  // only weeks you traded in exist here: a week with a slip resets the run, a week traded without
  // one adds to it, and a week with no trading neither counts nor breaks it
  for(const w of list){ if(w.week===curWeek)continue; if(w.count){ runN=0; continue; }
    runN++; if(runN>=3&&!done){ const mon=isoWeekMondayKey(w.week); done=pzAddDays(mon,6); } }
  const cur=weeks[curWeek]||{count:0,days:0};
  // plugged, then slipped again in a later week: "It’s back"
  const back=!!done&&list.some(w=>w.count&&isoWeekMondayKey(w.week)>done);
  return {weeks:list,cleanRun:runN,done,thisWeek:cur,back};
}
// this week so far, for one plug: only trades since the plug started count
function pzPlugWeekNote(p){ const w=p.thisWeek||{count:0,days:0};
  return w.count?w.count+' slip'+(w.count===1?'':'s')+' this week':w.days?'clean this week'
    :isoWeekOfKey(p.from)===isoWeekOfKey(dayKey(Date.now()))?'no trades since you started':'no trades yet this week'; }
function isoWeekMondayKey(week){ const m=/^(\d{4})-W(\d{2})$/.exec(week); if(!m)return null; const j4=Date.UTC(+m[1],0,4), d=new Date(j4);
  return new Date(j4-((d.getUTCDay()+6)%7)*86400000+(+m[2]-1)*7*86400000).toISOString().slice(0,10); }
function pzPlugs(){ return (Array.isArray(settings.pzPlugs)?settings.pzPlugs:[]).filter(p=>p&&PZ_BEH[p.slip]&&/^\d{4}-\d{2}-\d{2}$/.test(p.from||'')).map(p=>Object.assign({},p,pzPlugState(p))); }
async function pzPlugStart(slip){
  if(!PZ_PLUG[slip])return null;
  if(!Array.isArray(settings.pzPlugs))settings.pzPlugs=[];
  const live=settings.pzPlugs.find(p=>p.slip===slip&&!p.dropped&&!pzPlugState(p).done); if(live)return live; // a plugged leak that came back can be plugged again
  // plugging it again after it was plugged: the old plug's habit starts over with the new plug
  for(const o of settings.pzPlugs)if(o.slip===slip&&!o.dropped&&o.habitId){ const oh=habitById(o.habitId); if(oh&&!oh.retired)await retireHabit(o.habitId); }
  const h=await adoptHabit({kind:'slip',slip,when:PZ_PLUG[slip].when,then:PZ_PLUG[slip].then});
  const p={slip,from:dayKey(Date.now()),habitId:h&&h.id,at:Date.now()};
  settings.pzPlugs.push(p); await Store.set(S_KEY,settings); return p;
}
async function pzPlugDrop(slip){ const p=(settings.pzPlugs||[]).find(x=>x.slip===slip&&!x.dropped&&!pzPlugState(x).done); if(!p)return; p.dropped=true; if(p.habitId)await retireHabit(p.habitId); await Store.set(S_KEY,settings); }
// Your leaks over a window, costliest first, with the previous window for the trend.
function pzLeakMap(g, days){
  days=days||30; const today=dayKey(Date.now()), from=pzAddDays(today,-(days-1)), prevFrom=pzAddDays(today,-(2*days-1)); // calendar days, so a clock change can't add one
  const plugs=pzPlugs().filter(p=>!p.dropped);
  const sum=(lo,hi)=>{ const o={}; for(const d of g.days){ if(d.key<lo||d.key>=hi)continue; for(const s of (d.behavior.slips||[]))for(const k of s.f){ (o[k]=o[k]||{n:0,cost:0}); o[k].n++; o[k].cost+=s.net; } } return o; };
  const cur=sum(from,'9999'), prev=sum(prevFrom,from);
  return Object.keys(PZ_BEH).map(k=>({slip:k,label:PZ_BEH[k],n:(cur[k]||{}).n||0,cost:(cur[k]||{}).cost||0,prevN:(prev[k]||{}).n||0,prevCost:(prev[k]||{}).cost||0,
    plug:plugs.filter(p=>p.slip===k).sort((a,b)=>(a.done?1:0)-(b.done?1:0)||(b.at||0)-(a.at||0))[0]||null})).filter(x=>x.n||x.prevN||x.plug).sort((a,b)=>a.cost-b.cost||b.n-a.n);
}
// ---- habits: a streak per habit, with shields like the discipline streak ----
function pzHabitStreak(h, ctx, nowWeek){
  const res=habitProgress(h,ctx).res;
  const s=disciplineStreak(res.map(r=>({key:r.key,score:r.kept?100:0})),nowWeek);
  return {res,current:s.current,best:s.best,shields:s.shields,kept:res.filter(r=>r.kept).length,total:res.length};
}
// ---- catch yourself doing it right: good moments read from fills and the journal ----
function pzGoodMoments(g, fromKey){
  const out=[], byDay=g.ctx.byDay||{}, J=journal, loss=t=>PZ_LOSS(t.net);
  for(const d of g.days){ if(d.key<fromKey)continue;
    const a=(byDay[d.key]||[]).slice().sort((x,y)=>x.closeTime-y.closeTime), opens=[...a].sort((x,y)=>x.openTime-y.openTime), fl=d.behavior.flags||{};
    for(const t of a)if(loss(t)){ const next=opens.find(o=>o.openTime>t.closeTime);
      if(!next){ out.push({key:d.key,kind:'pause',text:'Walked away after a loss — no more trades that day'}); break; }
      const m=Math.round((next.openTime-t.closeTime)/60000); if(m>=15){ out.push({key:d.key,kind:'pause',text:'Waited '+(m>=120?Math.round(m/60)+' hours':m+' minutes')+' after a loss before the next entry'}); break; } }
    for(let i=0;i+1<a.length;i++)if(loss(a[i])&&loss(a[i+1])){ if(!a.some(t=>t.openTime>a[i+1].closeTime))out.push({key:d.key,kind:'stop',text:'Two losses in a row — and you stopped'}); break; }
    if(d.n>=2&&d.score===100)out.push({key:d.key,kind:'clean',text:'A clean day: '+d.n+' trades, no slips'});
    if(d.breached&&d.parts&&d.parts.limit===1)out.push({key:d.key,kind:'limit',text:'Hit your loss limit and stopped'});
    if(d.parts&&d.parts.plan===1)out.push({key:d.key,kind:'plan',text:'Plan written before the first trade'});
    if(a.length&&a.every(t=>isJournaled(J[t.id])))out.push({key:d.key,kind:'journal',text:'Every trade journaled'});
    if(a.some(loss)&&!fl.sizeUp&&a.length>=2)out.push({key:d.key,kind:'size',text:'Kept your usual size after a loss'});
  }
  return out.sort((x,y)=>x.key<y.key?1:-1);
}
// ---- heads-up when one of your own triggers is live, with what history says about it ----
function pzNudges(D){
  const g=D.g, closed=[...g.ctx.closed].sort((a,b)=>a.closeTime-b.closeTime), now=Date.now(), out=[], loss=t=>PZ_LOSS(t.net);
  const todayT=closed.filter(t=>dayKey(t.closeTime)===D.todayK), last=todayT[todayT.length-1], prev=todayT[todayT.length-2];
  const wr=a=>{ const w=a.filter(t=>isWin(t.net)).length, l=a.filter(t=>isLoss(t.net)).length; return w+l>=8?w/(w+l):null; };
  const ct=closed.map(t=>t.closeTime), upto=ms=>{ let lo=0,hi=ct.length; while(lo<hi){ const m=(lo+hi)>>1; if(ct[m]<=ms)lo=m+1; else hi=m; } return lo; };
  // trades whose previous (up to two) closes before their entry match fn
  const after=fn=>{ const a=[]; for(const t of closed){ if(!t.openTime)continue; const i=upto(t.openTime); const p=closed.slice(Math.max(0,i-2),i).filter(x=>x!==t); if(fn(p,t))a.push(t); } return a; };
  const base=wr(closed);
  if(last&&prev&&loss(last)&&loss(prev)&&now-last.closeTime<3*3600000){
    const h=after((p,t)=>p.length===2&&p.every(loss)&&dayKey(p[0].closeTime)===dayKey(t.openTime));
    const r=wr(h); out.push({tone:'warn',text:'Two losses in a row today.'+(r!=null?' Historically your next trade after two losses wins '+Math.round(r*100)+'%'+(base!=null?' (vs '+Math.round(base*100)+'% overall)':'')+'.':'')+' The plan says step away.'}); }
  else if(last&&loss(last)&&now-last.closeTime<15*60000){
    const h=after((p,t)=>p.length&&loss(p[p.length-1])&&t.openTime-p[p.length-1].closeTime<=15*60000);
    const r=wr(h); out.push({tone:'warn',text:'You closed a loss '+Math.max(1,Math.round((now-last.closeTime)/60000))+' minutes ago.'+(r!=null?' Entries within 15 minutes of a loss win '+Math.round(r*100)+'% for you'+(base!=null?' (vs '+Math.round(base*100)+'% overall)':'')+'.':'')+' Give it the full 15.'}); }
  if(D.ready!=null&&D.ready<50){ const rl=pzReadinessLink(g.days,journal);
    out.push({tone:'warn',text:'Low readiness this morning ('+D.ready+').'+(rl?' On low-readiness days your Discipline averages '+rl.lo+', against '+rl.hi+' when you’re rested.':'')+' Smaller size, fewer trades.'}); }
  for(const p of pzPlugs().filter(p=>!p.dropped&&!p.done)){ const n=p.thisWeek.count;
    out.push({tone:n?'warn':'good',text:n?'Plugging “'+PZ_BEH[p.slip].toLowerCase()+'”: '+n+' slip'+(n===1?'':'s')+' this week. Reset and go again.':'Plugging “'+PZ_BEH[p.slip].toLowerCase()+'”: '+(p.cleanRun?p.cleanRun+' clean trading week'+(p.cleanRun===1?'':'s')+' so far, ':'')+pzPlugWeekNote(p)+'. Three clean trading weeks in a row plug it.'}); }
  return out.slice(0,3);
}

// ---- trader profiles and their routines ----
const PZ_ROUTINES={
  scalper:{name:'Scalper',desc:'Many short trades a day',tip:'Your edge lives in the cap: fewer, cleaner trades.',
    morning:['Which one setup are you trading today?','When does your session end?'],
    eod:['Did you stop at your trade cap? If not, what pulled you back in?','Which trade broke your rules, and what triggered it?','Your cleanest trade today — what made it clean?']},
  day:{name:'Day trader',desc:'In and out the same day',tip:'Plan the day, then trade the plan — the review is where you get better.',
    morning:['What’s your bias today, and what would prove it wrong?','Which setup are you waiting for?'],
    eod:['Did you follow your plan? Where did you drift?','What did the market do against your bias, and how did you react?','The one mistake not to repeat tomorrow']},
  swing:{name:'Swing trader',desc:'Holds for days',tip:'Your job is mostly to leave good trades alone and cut broken ones.',
    morning:['Is every open position’s thesis still intact?','Any stop you’re tempted to move — by plan or by fear?'],
    eod:['Did anything today change a thesis? Which one?','Did you move a stop? Was that the plan?','What would make you exit tomorrow?']},
  position:{name:'Position trader',desc:'Holds for weeks',tip:'Size for the worst case; check in on the thesis, not the price.',
    morning:['What would change your long-term view this week?','Is your size still right for the risk?'],
    eod:['Did today’s noise change anything that matters?','Are you still sized for the worst case?','What do you need to check before the week ends?']},
};
function pzDetectProfile(closed){
  const now=Date.now(), c=(closed||[]).filter(t=>t.closeTime>now-90*86400000&&t.openTime&&!t.partialHistory);
  if(c.length<5)return null;
  const hold=nfMedian(c.map(t=>t.closeTime-t.openTime)), days=new Set(c.map(t=>dayKey(t.closeTime))).size, perDay=c.length/Math.max(1,days);
  return hold<20*60000||perDay>=8?'scalper':hold<8*3600000?'day':hold<10*86400000?'swing':'position';
}
// the profile in use: your choice, else detected from the last 90 days; a league's custom profile builds on one of the four
function pzProfile(closed){
  const cfg=SOC.cfg&&SOC.cfg.profiles||{}, custom=(cfg.custom||[]), pick=settings.pzProfile;
  const detected=pzDetectProfile(closed);
  const c=pick&&custom.find(p=>p.id===pick);
  const id=c?c.base:PZ_ROUTINES[pick]?pick:detected||'day';
  const base=PZ_ROUTINES[id], ov=(cfg.overrides||{})[id]||{};
  return {id:c?c.id:id,base:id,name:c?c.name:base.name,desc:c?(c.desc||base.desc):base.desc,tip:base.tip,detected,chosen:!!(c||PZ_ROUTINES[pick]),
    morning:(c&&c.morning.length?c.morning:ov.morning||base.morning),eod:(c&&c.eod.length?c.eod:ov.eod||base.eod)};
}

// ---- report cards: a week or a month, graded on process, with results alongside ----
function pzPeriodOf(kind, key){ return kind==='week'?{lo:isoWeekMondayKey(key),hi:pzAddDays(isoWeekMondayKey(key),6)}:{lo:key+'-01',hi:key+'-31'}; }
function pzPeriods(g, kind){ return [...new Set(g.days.map(d=>kind==='week'?isoWeekOfKey(d.key):d.key.slice(0,7)))].sort(); }
function pzReport(g, kind, key){
  const P=pzPeriodOf(kind,key), inP=(d,p)=>d.key>=p.lo&&d.key<=p.hi;
  const cur=g.days.filter(d=>inP(d,P)); if(!cur.length)return null;
  // compared with the period right before (no comparison when that one had no trading)
  const pk=kind==='week'?isoWeekOfKey(pzAddDays(P.lo,-7)):(m=>{ const y=+key.slice(0,4), mo=+key.slice(5,7); return mo===1?(y-1)+'-12':y+'-'+String(mo-1).padStart(2,'0'); })(), prev=g.days.filter(d=>inP(d,pzPeriodOf(kind,pk)));
  const avg=a=>a.length?_avg(a.map(d=>d.score)):null, byDay=g.ctx.byDay||{};
  const trades=cur.flatMap(d=>byDay[d.key]||[]), w=trades.filter(t=>isWin(t.net)).length, l=trades.filter(t=>isLoss(t.net)).length;
  const gp=trades.filter(t=>t.net>0).reduce((a,t)=>a+t.net,0), gl=-trades.filter(t=>t.net<0).reduce((a,t)=>a+t.net,0);
  const slips=(arr)=>{ const o={}; for(const d of arr)for(const s of (d.behavior.slips||[]))for(const k of s.f){ (o[k]=o[k]||{n:0,cost:0}); o[k].n++; o[k].cost+=s.net; } return o; };
  const sc=slips(cur), sp=slips(prev);
  const partAvg=p=>{ const v=cur.map(d=>d.parts&&d.parts[p]).filter(x=>x!=null); return v.length?_avg(v):null; };
  const parts=Object.keys(PROCESS_W).map(p=>({part:p,name:PART_NAME[p],value:partAvg(p),grade:GRADE(partAvg(p))})).filter(x=>x.value!=null);
  const J=journal, dayE=k=>J['day:'+k]||{};
  const ctxH=habitsList().map(h=>{ const res=habitProgress(h,g.ctx).res.filter(r=>r.key>=P.lo&&r.key<=P.hi);
    const broke=res.filter(r=>!r.kept).map(r=>({key:r.key,ready:pzReadiness(dayE(r.key))}));
    return {name:habitSentence(h),kept:res.filter(r=>r.kept).length,total:res.length,broke}; }).filter(h=>h.total);
  const xp=Object.keys(g.xp.byDay).filter(k=>k>=P.lo&&k<=P.hi).reduce((a,k)=>a+g.xp.byDay[k],0);
  const badges=(g.catalog?g.catalog.earned:[]).filter(b=>b.k>=P.lo&&b.k<=P.hi);
  const leak=Object.keys(sc).sort((a,b)=>sc[a].cost-sc[b].cost)[0]||null;
  const best=[...cur].sort((a,b)=>b.score-a.score||b.net-a.net)[0], worst=[...cur].sort((a,b)=>a.score-b.score||a.net-b.net)[0];
  const ch=kind==='week'?g.challenges.find(c=>c.week===key)||null:null;
  const a=avg(cur), pa=avg(prev);
  return {kind,key,prevKey:pk||null,days:cur.length,good:cur.filter(d=>d.score>=70).length,clean:cur.filter(d=>d.score===100).length,avg:a,grade:GRADE(a/100),delta:pa!=null?a-pa:null,
    trades:trades.length,net:cur.reduce((x,d)=>x+d.net,0),winRate:w+l?w/(w+l):null,pf:gl>0?gp/gl:gp>0?Infinity:null,
    greenDays:cur.filter(d=>d.net>0).length,bestDay:best,worstDay:worst,slips:sc,prevSlips:sp,leak,parts,habits:ctxH,xp,badges,challenge:ch,
    plans:cur.filter(d=>d.parts&&d.parts.plan===1).length,checkins:cur.filter(d=>{ const e=dayE(d.key); return e.sleep||e.stress||e.focus; }).length,
    reviews:cur.filter(d=>dayE(d.key).eod).length,journaled:trades.length?trades.filter(t=>isJournaled(J[t.id])).length/trades.length:null};
}
