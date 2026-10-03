/* ============================================================================
   Trader Age — how seasoned your trading process looks, in years, next to how long
   you've actually traded (the "Trader Age and XP Multiplier Spec" doc, step 3).
   A feature in its own file: it plugs into Keel through pzFeature (app/pulse.js)
   and loads on Keel's page only (data-only="keel" in ledger.html).

   Each trading day gets a 0–100 rating:
     65% Discipline (the day's score, read from fills)
     15% Steadiness (100 minus twice the spread of your last 20 daily Discipline scores, each day
         first pulled toward their average by how few trades it has: a one-trade day is 0 or 100
         whatever the trader is like, and shouldn't read as unsteadiness)
     10% Loss limit kept (100 kept, 0 traded past it, 70 when no limit was set)
     10% Prep and journal (half for prep: a plan written before the first trade, or half of that for
         a late plan or a morning check-in alone; half for the share of trades journaled)
   The rating R is a weighted average of the last 6 months of trading days, a day's weight
   halving every 30 trading days back. Trader Age = 2^((R − 50) / 10) years, capped at 20:
   every 10 points doubles it. Only trading days count, so a break freezes it.
   Pace is this week (the last 7 days, 3+ trading days) against that norm, from 0× to 3×.
   The screen shows each habit behind the rating the way a health tracker shows its inputs: how often it
   was kept over the 6 months and the last 30 trading days, and what it's worth in years now (taHabits),
   plus the last 30 trading days against the 30 before and the 30 before that (taThenNow).
   ============================================================================ */
// the settings and the years formula are functions so the server can borrow them, with traderAge,
// to work out members' verified Trader Age from their wallets (server.js ENGINE_FNS)
function taConf(){ return {halfLife:30, minDays:15, windowDays:183, cap:20, steadyN:20, shrinkN:3, recentN:30, fewChances:5, weekMin:3, paceMax:3, standN:20, priorDays:15, fullDays:60}; }
const TA=taConf();
function taYears(r){ return Math.min(TA.cap, Math.pow(2,(r-50)/10)); }
// a rating back from years (for "get back to 2 years" style messages)
const taRatingFor=y=>50+10*Math.log2(Math.max(1e-9,y));
function taFmtYears(y){
  if(!(y>0))return '—';
  if(y<1){ const m=Math.max(1,Math.round(y*12)); return m+' month'+(m===1?'':'s'); }
  return (y<10?y.toFixed(1):String(Math.round(y)))+' years';
}
// a difference in years, short: '3 mo', '1.5 yrs'
function taFmtDelta(y){ y=Math.abs(y); if(y<1){ const m=Math.max(1,Math.round(y*12)); return m+' mo'; } return (y<10?y.toFixed(1):String(Math.round(y)))+' yrs'; }
// a day's trade count, when known (the game's days carry it; the server's verified days too)
function taDayN(d){ return d.n>0?+d.n:d.behavior&&d.behavior.n>0?+d.behavior.n:0; }
// prep: a plan written before the first trade; half for a late one, or for a morning check-in alone
function taPrep(P,e){ return Math.max(P.plan>=1?1:P.plan===0.5?0.5:0, taCheckin(e)?0.5:0); }
function taCheckin(e){ return !!(e&&(e.sleep||e.stress||e.focus)); }
// days: the game's trading days, oldest first ({key, score, parts, behavior}); J: the journal (for the
// morning prep on 'day:<key>'); firstAt: the first fill on record (ms); now: ms
function traderAge(days, J, opts){
  opts=opts||{}; const now=opts.now||Date.now(), dayOf=opts.dayOf||(ms=>new Date(ms).toISOString().slice(0,10));
  const from=dayOf(now-TA.windowDays*864e5), weekFrom=dayOf(now-6*864e5);
  // only the last 6 months count, for every part (steadiness looks back over these days only too)
  const all=(days||[]).filter(d=>d&&d.key&&d.key>=from&&isFinite(d.score)).slice().sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0);
  const rated=all.map((d,i)=>{
    // steadiness: the spread of the last 20 daily scores, each first pulled toward their average by how
    // few trades it has (3 trades' worth), so a one-trade day's 0 or 100 doesn't read as unsteadiness
    const win=all.slice(Math.max(0,i-TA.steadyN+1),i+1), mean=win.reduce((a,x)=>a+x.score,0)/win.length;
    const sh=win.map(x=>{ const n=taDayN(x); return n>0?(x.score*n+TA.shrinkN*mean)/(n+TA.shrinkN):x.score; }), m2=sh.reduce((a,v)=>a+v,0)/sh.length;
    const sd=Math.sqrt(sh.reduce((a,v)=>a+(v-m2)*(v-m2),0)/sh.length);
    const P=d.parts||{}, e=J&&J['day:'+d.key];
    const parts={discipline:d.score, steadiness:Math.max(0,100-2*sd), limit:P.limit===1?100:P.limit===0?0:70,
      log:50*taPrep(P,e)+50*Math.max(0,Math.min(1,+P.journal||0))};
    if(opts.partsFix)Object.assign(parts,opts.partsFix); // "as if": a part held at a value (taHabits)
    // fillsOnly: only what the wallet shows (Discipline and steadiness, reweighted to 100) — what the server's
    // standing and mentors' pay read, since the loss limit, prep and journal parts are the app's word
    return {key:d.key, d, parts, r:opts.fillsOnly?(0.65*parts.discipline+0.15*parts.steadiness)/0.8:0.65*parts.discipline+0.15*parts.steadiness+0.10*parts.limit+0.10*parts.log};
  });
  const inWin=rated, n=inWin.length;
  if(opts.raw)return {daily:rated.map(x=>({key:x.key,r:x.r}))};
  const firstAt=opts.firstAt>0?opts.firstAt:null, tradingYears=firstAt?Math.max(0,(now-firstAt)/(365.25*864e5)):null;
  const out={n, need:Math.max(0,TA.minDays-n), tradingYears, building:n<TA.minDays};
  if(!n)return out;
  let W=0, W2=0, R=0; const parts={discipline:0,steadiness:0,limit:0,log:0}, ws=inWin.map((x,i)=>Math.pow(0.5,(n-1-i)/TA.halfLife));
  inWin.forEach((x,i)=>{ const w=ws[i]; W+=w; W2+=w*w; R+=w*x.r; for(const k in parts)parts[k]+=w*x.parts[k]; });
  out.raw=R/W; for(const k in parts)parts[k]=parts[k]/W; out.parts=parts;
  // confidence: with few trading days the rating is pulled toward 50 (1 year), fully trusted from 60 days on,
  // so 15 perfect days don't read as 20 years; the range is about 80% likely (the spread of daily ratings)
  const prior=TA.priorDays*Math.max(0,1-n/TA.fullDays), shrink=n/(n+prior);
  out.rating=50+(out.raw-50)*shrink; out.age=taYears(out.rating); out.sure=shrink;
  const sd=Math.sqrt(inWin.reduce((a,x,i)=>a+ws[i]*(x.r-out.raw)*(x.r-out.raw),0)/W), se=sd/Math.sqrt(W*W/W2)*shrink;
  out.range=[taYears(out.rating-1.28*se), taYears(out.rating+1.28*se)];
  // the last 20 trading days, plain average: what standing reads
  const rec=inWin.slice(-TA.standN); out.recent=rec.reduce((a,x)=>a+x.r,0)/rec.length; out.recentN=rec.length;
  // what's holding it back most: the part furthest below 100, by its weight
  const WT={discipline:.65,steadiness:.15,limit:.10,log:.10};
  out.drag=Object.keys(WT).map(k=>[k,(100-parts[k])*WT[k]]).sort((a,b)=>b[1]-a[1])[0][0];
  // this week against the norm
  const wk=rated.filter(x=>x.key>=weekFrom);
  out.week={n:wk.length};
  if(wk.length>=TA.weekMin){ const wr=wk.reduce((a,x)=>a+x.r,0)/wk.length; out.week.rating=wr; out.week.age=taYears(wr);
    out.pace=Math.max(0,Math.min(TA.paceMax,Math.pow(2,(wr-out.raw)/10))); // against the 6-month rating itself (no cap, no pull)
    const slips={}; for(const x of wk){ const f=(x.d.behavior&&x.d.behavior.flags)||{}; for(const k in f)if(f[k]>0)slips[k]=(slips[k]||0)+f[k]; }
    const top=Object.entries(slips).sort((a,b)=>b[1]-a[1])[0]; out.week.slip=top?top[0]:null; }
  // the last 12 weeks with trading, each as its own Trader Age (oldest first)
  const byWeek=new Map(); for(const x of inWin){ const w=isoWeekOfKey(x.key); if(!byWeek.has(w))byWeek.set(w,[]); byWeek.get(w).push(x.r); }
  out.weeks=[...byWeek.entries()].slice(-12).map(([w,rs])=>{ const r=rs.reduce((a,v)=>a+v,0)/rs.length; return {week:w, rating:r, age:taYears(r), n:rs.length}; });
  return out;
}
// Trader Age at the end of each trading day, oldest first: the history line and the milestone badges.
// Each day reads only the trading days before it (at most the 200 before: the window is 6 months).
// Exactly traderAge(all.slice(max(0,i-199),i+1), J, {now: the day's end, dayOf, firstAt}) per day (what
// it used to call: ~1 s a rebuild), in near-linear time. Day i's window is a run [s..i] (s only moves
// forward); a day's rating depends on the window only through steadiness cut at s, so it's rated once
// with a full 20-day spread, or once per s for the 19 days after it — by traderAge itself (opts.raw).
// Then the same weighted sum, same order, same weights: every number identical.
function taHistory(days, J, opts){
  opts=opts||{}; const all=(days||[]).filter(d=>d&&d.key&&isFinite(d.score)).slice().sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0);
  const dayOf=opts.dayOf||(ms=>new Date(ms).toISOString().slice(0,10)), firstAt=opts.firstAt>0?opts.firstAt:null, S=TA.steadyN;
  const full=[], ws=[]; let s=0, part=null;
  const raw=(a,b,now)=>traderAge(all.slice(a,b+1), J, {now, dayOf:opts.dayOf, raw:true}).daily;
  return all.map((d,i)=>{ const now=Date.parse(d.key+'T23:59:59Z'), from=dayOf(now-TA.windowDays*864e5);
    const s0=s; s=Math.max(s,i-199); while(s<i&&all[s].key<from)s++; if(s!==s0)part=null;
    const n=i-s+1; let W=0, R=0;
    for(let j=s;j<=i;j++){ let r;
      if(j-S+1>=s){ r=full[j]; if(r===undefined)r=full[j]=raw(j-S+1,j,now)[S-1].r; }
      else { if(!part||part.length<=j-s)part=raw(s,Math.min(i,s+S-2),now).map(x=>x.r); r=part[j-s]; }
      const k=n-1-(j-s), w=ws[k]!==undefined?ws[k]:(ws[k]=Math.pow(0.5,k/TA.halfLife)); W+=w; R+=w*r; }
    const prior=TA.priorDays*Math.max(0,1-n/TA.fullDays), rating=50+(R/W-50)*(n/(n+prior));
    return {key:d.key, n, rating, age:n<TA.minDays?null:taYears(rating), tradingYears:firstAt?Math.max(0,(now-firstAt)/(365.25*864e5)):null}; });
}
// ---- the habits behind the rating, and what each is worth ----
// A slip kind, taken away: the trades with only that slip become clean (their day's Discipline goes up,
// the flag goes). A trade with two slips isn't made clean by taking one away.
function taDayWithoutSlip(d,k){ const b=d&&d.behavior; if(!b||!b.flags||!b.flags[k])return d; const n=b.n||d.n||0; if(!n)return d;
  const freed=(b.slips||[]).filter(x=>x.f&&x.f.length===1&&x.f[0]===k).length, fl=Object.assign({},b.flags); delete fl[k];
  return Object.assign({},d,{score:Math.round(100*Math.min(n,(b.clean||0)+freed)/n), behavior:Object.assign({},b,{flags:fl})}); }
// A habit, dropped: the clean trades that kept it become slips. For a habit tested once a day (stopping
// after two losses, staying inside the usual count) it's one more trade that day, a slip.
function taDayWithoutKept(d,k,day){ const b=d&&d.behavior; if(!b||!b.kept||!b.kept[k])return d; const n=b.n||d.n||0; if(!n)return d;
  const fl=Object.assign({},b.flags); fl[k]=(fl[k]||0)+(day?1:b.keptClean[k]||0);
  return day?Object.assign({},d,{score:Math.round(100*(b.clean||0)/(n+1)), n:n+1, behavior:Object.assign({},b,{n:n+1,flags:fl})})
    :Object.assign({},d,{score:Math.round(100*Math.max(0,(b.clean||0)-(b.keptClean[k]||0))/n), behavior:Object.assign({},b,{flags:fl})}); }
// what each kind of slip costs: Trader Age worked out again without that slip, best gain first
const TA_SLIPS=['revenge','afterTwo','sizeUp','addLoser','overtrade','heldLoser'];
function taWhatIf(days, J, opts){
  opts=opts||{}; const base=traderAge(days,J,opts); if(!base.n||base.building)return [];
  const now=opts.now||Date.now(), from=(opts.dayOf||(ms=>new Date(ms).toISOString().slice(0,10)))(now-TA.windowDays*864e5);
  return TA_SLIPS.map(k=>{ let hit=0;
    const alt=(days||[]).map(d=>{ const b=d&&d.behavior; if(b&&b.flags&&b.flags[k]&&d.key>=from&&(b.n||d.n))hit+=b.flags[k]; return taDayWithoutSlip(d,k); });
    if(!hit)return null; const A=traderAge(alt,J,opts); return {k, n:hit, age:A.age, gain:A.age-base.age}; })
    .filter(x=>x&&x.gain>=0.05).sort((a,b)=>b.gain-a.gain);
}
// Every habit behind the rating. Each is a chance kept or slipped: an entry after a loss, a losing trade to
// cut, a day with a limit, a trading day to plan… `day`: tested once a day. `unit`: what the chances are.
function taHabitList(){ return [
  {k:'revenge',part:'discipline',good:'Waiting after a loss',bad:'Revenge entries',unit:'entries after a loss'},
  {k:'afterTwo',part:'discipline',good:'Stopping after two losses',bad:'Trading on after two losses',unit:'days with two losses in a row',day:true},
  {k:'sizeUp',part:'discipline',good:'Keeping size after a loss',bad:'Sizing up after a loss',unit:'entries soon after a loss'},
  {k:'addLoser',part:'discipline',good:'Adding only to winners',bad:'Adding to losers',unit:'positions added to'},
  {k:'overtrade',part:'discipline',good:'Staying inside your usual count',bad:'Overtrading',unit:'days with a usual count',day:true},
  {k:'heldLoser',part:'discipline',good:'Cutting losers on time',bad:'Holding losers too long',unit:'losing trades'},
  {k:'steadiness',part:'steadiness',good:'Even days',bad:'Uneven days',unit:''},
  {k:'limit',part:'limit',good:'Loss limit kept',bad:'Traded past the limit',unit:'days with a limit'},
  {k:'plan',part:'log',good:'Plan before the first trade',bad:'No plan',unit:'trading days'},
  {k:'checkin',part:'log',good:'Morning check-in',bad:'No check-in',unit:'trading days'},
  {k:'journal',part:'log',good:'Trades journaled',bad:'Trades not journaled',unit:'trades'}]; }
const TA_HABITS=taHabitList();
// one day's chances and kept for a habit (null: this day says nothing about it)
function taHabitDay(h,d,J){ const b=d.behavior||{}, P=d.parts||{}, e=J&&J['day:'+d.key], n=taDayN(d);
  if(h.part==='discipline'){ if(!b.chances)return null; const c=b.chances[h.k]||0; return c?{c, k:(b.kept||{})[h.k]||0}:null; }
  if(h.k==='limit')return P.limit===0||P.limit===1?{c:1,k:P.limit}:null;
  if(h.k==='plan')return {c:1,k:P.plan>=1?1:P.plan===0.5?0.5:0,late:P.plan===0.5?1:0};
  if(h.k==='checkin')return {c:1,k:taCheckin(e)?1:0};
  if(h.k==='journal'){ const j=Math.max(0,Math.min(1,+P.journal||0)); return n?{c:n,k:j*n}:{c:1,k:j}; }
  return null; }
// a habit as if always kept (cost) or never (earn): the days, and the journal for the check-in
function taHabitAlt(h,days,J,best){ const J2=Object.assign({},J||{}); const alt=days.map(d=>{ const P=d.parts||{}, e=J&&J['day:'+d.key];
  if(h.part==='discipline')return best?taDayWithoutSlip(d,h.k):taDayWithoutKept(d,h.k,h.day);
  if(h.k==='limit')return P.limit===(best?0:1)?Object.assign({},d,{parts:Object.assign({},P,{limit:best?1:0})}):d;
  if(h.k==='plan')return (best?P.plan<1||P.plan==null:P.plan>0)?Object.assign({},d,{parts:Object.assign({},P,{plan:best?1:0})}):d;
  if(h.k==='checkin'){ if(best&&!taCheckin(e))J2['day:'+d.key]=Object.assign({},e||{},{focus:1}); else if(!best&&taCheckin(e))J2['day:'+d.key]=Object.assign({},e,{sleep:0,stress:0,focus:0}); return d; }
  if(h.k==='journal')return Object.assign({},d,{parts:Object.assign({},P,{journal:best?1:0})});
  return d; }); return {days:alt,J:J2}; }
// The habits, each with the share kept over the 6 months and the last 30 trading days, and what it's worth
// now: earn = years lost without the kept ones, cost = years gained without the slips. Each on its own,
// everything else the same; years double every 10 points, so they don't add up.
function taHabits(days, J, opts){
  opts=opts||{}; const base=traderAge(days,J,opts); if(!base.n||base.building)return [];
  const now=opts.now||Date.now(), from=(opts.dayOf||(ms=>new Date(ms).toISOString().slice(0,10)))(now-TA.windowDays*864e5);
  const win=(days||[]).filter(d=>d&&d.key&&d.key>=from&&isFinite(d.score)).slice().sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0), rec=win.slice(-TA.recentN);
  const sum=(h,ds)=>{ let c=0,k=0,late=0,any=false; for(const d of ds){ const x=taHabitDay(h,d,J); if(x){ any=true; c+=x.c; k+=x.k; late+=x.late||0; } } return any?{c,k,late,share:c?k/c:null}:null; };
  const r2=v=>Math.round(v*100)/100;
  return TA_HABITS.map(h=>{
    if(h.k==='steadiness'){ // a measure, not chances: its 6-month and 30-day values, and what evenness would add
      const rec30=traderAge(rec,J,Object.assign({},opts,{now})); const cost=traderAge(days,J,Object.assign({},opts,{partsFix:{steadiness:100}})).age-base.age;
      return {k:h.k, part:h.part, good:h.good, bad:h.bad, unit:h.unit, value:base.parts.steadiness, value30:rec30.parts?rec30.parts.steadiness:null, earn:0, cost:cost>=0.05?r2(cost):0}; }
    const six=sum(h,win); if(!six)return null; const thirty=sum(h,rec);
    const earn=six.k>0?base.age-traderAge(taHabitAlt(h,days,J,false).days,taHabitAlt(h,days,J,false).J,opts).age:0;
    const cost=six.k<six.c?traderAge(taHabitAlt(h,days,J,true).days,taHabitAlt(h,days,J,true).J,opts).age-base.age:0;
    return {k:h.k, part:h.part, good:h.good, bad:h.bad, unit:h.unit, day:!!h.day, chances:six.c, kept:six.k, late:six.late||0, share:six.share, share30:thirty?thirty.share:null,
      few:six.c<TA.fewChances, earn:earn>=0.05?r2(earn):0, cost:cost>=0.05?r2(cost):0}; }).filter(Boolean);
}
// You against yourself: the last 30 trading days, the 30 before, and the 30 before that (newest last). Each
// block: its own rating and years (a plain average of its days), Discipline, slips per 100 trades, and how
// often the limit, the plan, the check-in and journaling were kept.
function taThenNow(days, J, opts){
  opts=opts||{}; const now=opts.now||Date.now(), from=(opts.dayOf||(ms=>new Date(ms).toISOString().slice(0,10)))(now-TA.windowDays*864e5);
  const win=(days||[]).filter(d=>d&&d.key&&d.key>=from&&isFinite(d.score)).slice().sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0);
  const daily=new Map(traderAge(win,J,Object.assign({},opts,{raw:true})).daily.map(x=>[x.key,x.r]));
  const blocks=[]; for(let end=win.length;end>0&&blocks.length<3;end-=TA.recentN){ const ds=win.slice(Math.max(0,end-TA.recentN),end); if(ds.length<10)break;
    const n=ds.reduce((a,d)=>a+taDayN(d),0), rating=ds.reduce((a,d)=>a+daily.get(d.key),0)/ds.length, slips={};
    if(n)for(const k of TA_SLIPS){ const f=ds.reduce((a,d)=>a+((d.behavior&&d.behavior.flags&&d.behavior.flags[k])||0),0); slips[k]=Math.round(1000*f/n)/10; }
    const share=(h)=>{ let c=0,k=0; for(const d of ds){ const x=taHabitDay(h,d,J); if(x){ c+=x.c; k+=x.k; } } return c?Math.round(100*k/c):null; };
    const H=k=>TA_HABITS.find(h=>h.k===k);
    blocks.unshift({from:ds[0].key, to:ds[ds.length-1].key, days:ds.length, trades:n, rating, age:taYears(rating), disc:Math.round(ds.reduce((a,d)=>a+d.score,0)/ds.length),
      slips:n?slips:null, limit:share(H('limit')), plan:share(H('plan')), checkin:share(H('checkin')), journal:share(H('journal'))}); }
  return blocks;
}
// '2026-W39' as 'Week of Sep 21' (its Monday)
function taWeekLabel(w){ try{ const k=isoWeekMondayKey(w); return 'Week of '+MONTHS[+k.slice(5,7)-1]+' '+(+k.slice(8)); }catch(e){ return w; } }
/* ---- the XP multiplier (spec step 5): earned by holding Trader Age, worked out by the server ----
   A trading week counts toward it when that week's own rating and the 6-month rating at its end are
   both at the bar (70 = Trader Age 4 years). A trading week under the bar drops one tier, never back to
   the start; weeks without trading neither count nor break it. */
function taMultDefaults(){ return {on:true, bar:70, tiers:[[2,1.05],[4,1.1],[8,1.2],[13,1.3],[26,1.5]]}; }
// every trading week in the days given (oldest first): the average rating of its own days, and the
// 6-month rating at its end (null until there are 15 trading days to go on)
function taWeeks(days, J, opts){
  opts=opts||{}; const dayOf=opts.dayOf;
  const all=(days||[]).filter(d=>d&&d.key&&isFinite(d.score)).slice().sort((a,b)=>a.key<b.key?-1:a.key>b.key?1:0);
  const weeks=[...new Set(all.map(d=>isoWeekOfKey(d.key)))].filter(w=>!opts.after||w>opts.after);
  return weeks.map(w=>{ const keys=all.filter(d=>isoWeekOfKey(d.key)===w).map(d=>d.key), end=keys[keys.length-1];
    const upTo=all.filter(d=>d.key<=end), now=Date.parse(end+'T23:59:59Z');
    const A=traderAge(upTo, J, {now, dayOf}), rs=traderAge(upTo, J, {now, dayOf, raw:true}).daily.filter(x=>keys.includes(x.key)).map(x=>x.r);
    return {week:w, end, n:keys.length, weekRating:rs.length?rs.reduce((a,v)=>a+v,0)/rs.length:null, norm:A.n>=TA.minDays?A.rating:null}; });
}
// the tier a count of good weeks reaches (-1: none yet), under the owner's current tiers
function taMultTier(count, cfg){ let t=-1; (cfg||taMultDefaults()).tiers.forEach((x,i)=>{ if(count>=x[0])t=i; }); return t; }
// one finished trading week moves the multiplier. The state is the good weeks held and the last week
// counted, so the tier always reads from the owner's current tiers (changing them never strands anyone).
function taMultStep(state, wk, cfg){
  cfg=cfg||taMultDefaults(); const T=cfg.tiers, st=Object.assign({count:0,last:null},state||{});
  if(!wk||(st.last&&wk.week<=st.last))return st;
  if(wk.weekRating!=null&&wk.weekRating<cfg.bar){ const t=taMultTier(st.count,cfg); st.count=t>=1?T[t-1][0]:0; } // down one tier
  else if(wk.weekRating!=null&&wk.norm!=null&&wk.norm>=cfg.bar)st.count++;
  st.last=wk.week; return st;
}
function taMultOf(state, cfg){ cfg=cfg||taMultDefaults(); const t=state?taMultTier(state.count,cfg):-1; return t>=0&&cfg.on!==false?cfg.tiers[t][1]:1; }
// the multiplier, as the server reports it: this week's, the good weeks held, and what the next tier needs
function taMultCardHtml(A){
  const cfg=(typeof SOC!=='undefined'&&SOC.cfg&&SOC.cfg.mult)||taMultDefaults(), M=typeof SOC!=='undefined'&&SOC.me&&SOC.me.mult;
  if(cfg.on===false)return '';
  const top=cfg.tiers[cfg.tiers.length-1], bar=cfg.bar, barYears=taFmtYears(taYears(bar));
  const rule=`<p class="pz-fine">A good week: that week and your 6-month Trader Age both at ${esc(barYears)} or more (rating ${bar}). A week below drops one tier, never back to the start. Weeks you don’t trade don’t count either way. Leagues and duels use your XP before the multiplier.</p>`;
  if(!A.verified||!M)return `<section class="pz-card pz-kv"><b class="pz-kvh">XP multiplier</b>
    <p class="pz-sub" style="font-size:13px">Hold a verified Trader Age of ${esc(barYears)} or more and your daily XP grows, up to ×${top[1]} after ${top[0]} good trading weeks.</p>${rule}</section>`;
  const nx=M.next, pct=nx?Math.min(1,M.held/nx.weeks):1;
  return `<section class="pz-card pz-kv"><div class="pz-kvrow"><b class="pz-kvh">XP multiplier</b><span style="font-family:var(--pz-num);font-size:28px;font-weight:600;color:${M.now>1?PZ_COL.good:'var(--pz-muted)'}">×${(+M.now).toFixed(2).replace(/0$/,'')}</span></div>
    ${pzBar(pct,PZ_COL.xp)}<p class="pz-sub" style="font-size:13px">${M.held} good week${M.held===1?'':'s'} held. ${nx?`${nx.toGo} more for ×${nx.mult}.`:'That’s the top tier.'} This week’s daily XP is multiplied by ×${(+M.now).toFixed(2).replace(/0$/,'')}.</p>${rule}</section>`;
}
/* ---- standing (spec step 6): perks are kept by holding Trader Age ----
   Your last 20 trading days against the bar (60 = Trader Age 2 years). Under it, or without a verified
   Trader Age, there are 14 days of grace to get back; a lapse also needs a trading day after the slip
   began, so a break freezes it. Fewer than 15 trading days counts as good.
   x: {verified, building, recent (the 20-day rating), lastDay (the last trading day's key)} */
function taStandingDefaults(){ return {on:true, bar:60, grace:14}; }
function taStanding(prev, x, cfg, now, dayOf){
  cfg=cfg||taStandingDefaults(); x=x||{}; dayOf=dayOf||(ms=>new Date(ms).toISOString().slice(0,10));
  if(cfg.on===false)return {state:'off', since:null};
  // owed: the clock was started by a rating under the bar. Building again (a fresh wallet, or every day
  // out of the 6 months) doesn't clear it: only a rating back at the bar does.
  const owed=!!(prev&&prev.since>0&&prev.slip);
  let state=!x.verified?'unverified':x.building||x.recent==null?'building':x.recent>=cfg.bar?'good':'slipping';
  if(state==='building'&&owed)state='slipping';
  if(state==='good'||state==='building')return {state, since:null};
  // the grace runs from when it first went under (or unverified), and switching between the two doesn't restart it
  const since=prev&&prev.since>0?prev.since:now, deadline=since+cfg.grace*864e5, slip=owed||state==='slipping';
  if(now>=deadline&&(state==='unverified'||(x.lastDay&&x.lastDay>dayOf(since))))return {state:'lapsed', why:state==='unverified'?'unverified':'rating', since, deadline, slip};
  return {state, since, deadline, slip};
}
// standing, as the server reports it on /me (null: no profile, or the owner switched it off)
function taStandingMe(){ const st=typeof SOC!=='undefined'&&SOC.me&&SOC.me.standing; return st&&st.on?st:null; }
const TA_PERKS='duels, competitions, the leaderboards and the coach’s full allowance';
function taDaysLeft(at){ const n=Math.max(0,Math.ceil((at-Date.now())/864e5)); return n===0?'today':n===1?'1 day':n+' days'; }
function taWhen(at){ try{ return new Date(at).toLocaleDateString(undefined,{weekday:'short',month:'short',day:'numeric'}); }catch(e){ return ''; } }
// on Today, only when something needs doing: slipping, unverified, or lapsed
function taStandingBannerHtml(){
  const st=taStandingMe(); if(!st||st.exempt||!['slipping','unverified','lapsed'].includes(st.state))return '';
  const yrs=taFmtYears(st.years), now20=st.recent!=null?taFmtYears(taYears(st.recent)):null, lapsed=st.state==='lapsed', col=lapsed?PZ_COL.low:PZ_COL.mid;
  const unver=st.state==='unverified'||(lapsed&&st.why==='unverified');
  const head=lapsed?'Standing lapsed':unver?'Verify to keep your perks':'Standing slipping';
  const text=unver?(lapsed?'Your wallet isn’t verified, so '+TA_PERKS+' are locked. Verify it and they open again.':'Verify your wallet within '+taDaysLeft(st.deadline)+' to keep '+TA_PERKS+'.')
    :lapsed?(now20?'Your last 20 trading days are at Trader Age '+now20+', under the '+yrs+' that keeps ':'Your Trader Age isn’t back at '+yrs+' yet, so you’ve lost ')+TA_PERKS+'. Get back to '+yrs+' and they open again.'
    :(now20?'Your last 20 trading days are at Trader Age '+now20+'.':'Your Trader Age isn’t back at '+yrs+' yet.')+' Get back to '+yrs+' by '+taWhen(st.deadline)+' to keep '+TA_PERKS+'.'+(st.deadline<Date.now()?' The clock waits while you’re not trading.':'');
  return `<section class="pz-card pz-kv pz-span" role="status" style="border:1px solid color-mix(in srgb, ${col} 50%, var(--pz-line));background:color-mix(in srgb, ${col} 9%, var(--pz-card))">
    <div class="pz-kvrow"><span class="pz-lbl" style="color:${col}">${pzI('shield',14)} ${esc(head)}</span><a class="pz-link" href="${unver?'#sharing':'#age'}" style="min-height:0">${unver?'Verify':'What to do'} ${pzI('chev',14)}</a></div>
    <p style="margin:0;font-size:14px;line-height:1.45">${esc(text)}</p></section>`;
}
// on the Trader Age screen: where your standing is, and the rule
function taStandingCardHtml(){
  const st=taStandingMe(), cfg=(typeof SOC!=='undefined'&&SOC.cfg&&SOC.cfg.standing)||null;
  if(!st&&!(cfg&&cfg.on))return '';
  const yrs=taFmtYears(st?st.years:cfg.years), grace=st?st.grace:cfg.grace;
  const rule=`<p class="pz-fine">Your last 20 trading days at Trader Age ${esc(yrs)} or more (rating ${st?st.bar:cfg.bar}) keep ${TA_PERKS}. Under it, or without a verified wallet, you have ${grace} days to get back before they lock. The clock waits while you’re not trading, and it never touches your level, XP or badges.</p>`;
  if(!st)return `<section class="pz-card pz-kv"><b class="pz-kvh">Standing</b><p class="pz-sub" style="font-size:13px">Members with a profile keep their perks by holding their Trader Age.</p>${rule}</section>`;
  if(st.exempt)return `<section class="pz-card pz-kv"><b class="pz-kvh">Standing</b><p class="pz-sub" style="font-size:13px">Your perks stay open whatever your Trader Age: the owner unlocked everything for you.</p>${rule}</section>`;
  const W={good:['Good',PZ_COL.good],building:['Building',PZ_COL.xp],slipping:['Slipping',PZ_COL.mid],unverified:['Not verified',PZ_COL.mid],lapsed:['Lapsed',PZ_COL.low]}[st.state]||['—','var(--pz-muted)'];
  const now20=st.recent!=null&&st.recentN?`Last ${st.recentN} trading day${st.recentN===1?'':'s'}: Trader Age ${esc(taFmtYears(taYears(st.recent)))}. `:'';
  const what=st.state==='good'?'Your perks are open.':st.state==='building'?'Your perks are open while your Trader Age builds.'
    :st.state==='slipping'?`Get back to ${esc(yrs)} by ${esc(taWhen(st.deadline))} to keep your perks.`
    :st.state==='unverified'?`Verify your wallet within ${esc(taDaysLeft(st.deadline))} to keep your perks. <a href="#sharing">Verify my discipline</a>`
    :st.why==='unverified'?'Your perks are locked until your wallet is verified. <a href="#sharing">Verify my discipline</a>':`Your perks are locked until you’re back at ${esc(yrs)}.`;
  return `<section class="pz-card pz-kv"><div class="pz-kvrow"><b class="pz-kvh">Standing</b><span style="font-weight:700;color:${W[1]}">${W[0]}</span></div>
    <p class="pz-sub" style="font-size:13px">${now20}${what}</p>${rule}</section>`;
}
const TA_PART={discipline:['Discipline','Your daily Discipline score, read from your fills',65],steadiness:['Steadiness','How even your daily scores are, one-trade days discounted',15],
  limit:['Loss limit kept','Days inside your loss limit (no limit set counts as 70)',10],log:['Prep and journal','A plan before the first trade (half for a late one or a check-in alone), trades journaled',10]};
// the server's verified Trader Age when it has one (a member whose wallet it reads), else this device's estimate
function taOf(D){
  const v=typeof SOC!=='undefined'&&SOC.me&&SOC.me.ta;
  // (while the server is still building one, e.g. a wallet just added, this device's estimate shows instead)
  if(v&&v.n&&!v.building)return Object.assign({},v,{verified:true,week:v.week||{n:0},weeks:v.weeks||[],pace:v.pace==null?undefined:v.pace});
  return taLocal(D);
}
// this device's inputs: the game's trading days, the journal (for prep), the first fill on record
function taInputs(days){
  let firstAt=0; for(const t of (typeof allTrades!=='undefined'?allTrades:[])){ const a=+t.openTime||+t.closeTime||0; if(a>0&&(!firstAt||a<firstAt))firstAt=a; }
  return {days:days||[], J:typeof journal!=='undefined'?journal:{}, opts:{firstAt, dayOf:typeof dayKey==='function'?dayKey:undefined}};
}
function taLocal(D){ const I=taInputs(D.g.days); return traderAge(I.days, I.J, I.opts); }
// the history is worked out once per set of days (the game's days array is rebuilt when anything changes)
const _taHist=new WeakMap();
function taHistoryOf(days){ if(!days||!days.length)return []; let h=_taHist.get(days); if(!h){ const I=taInputs(days); h=taHistory(I.days,I.J,I.opts); _taHist.set(days,h); } return h; }
function taPaceWord(p){ return p>=1.1?'maturing':p<=0.9?'slipping':'steady'; }
// the ring's colour follows the age: under a year, 1–3 years, 3 years and up
function taAgeCol(rating){ return rating<50?PZ_COL.low:rating<taRatingFor(3)?PZ_COL.mid:PZ_COL.good; }
function taPaceCol(p){ return p>=1.1?PZ_COL.good:p<=0.9?PZ_COL.low:PZ_COL.mid; }
// verified by the server from the wallet's fills, or an estimate made here (with what it takes to verify it)
function taEstimateNote(A){
  if(A&&A.verified)return 'Verified: the server worked it out from your wallet’s fills, with the prep, journal and loss-limit days your app reported.';
  const member=typeof SOC!=='undefined'&&SOC.key, owner=typeof SRV!=='undefined'&&SRV.token&&!SRV.badAuth;
  if(owner&&!member)return 'Estimated on this device from your fills and journal.';
  if(member)return 'Estimated on this device. It’s verified once the server reads your wallet: turn on <a href="#sharing">Verify my discipline</a> with a wallet added'+(SOC.me&&SOC.me.needsClaim?' and <a href="#account">claimed</a>':'')+'.';
  return 'Estimated on this device. <a href="#social">Create a profile</a> to have it verified and to earn the XP multiplier.';
}
// a Trader Age milestone badge earned in the last 7 days, said once on the card
function taMilestoneNote(D){
  const c=D.g&&D.g.catalog, since=typeof dayKey==='function'?dayKey(Date.now()-7*864e5):'';
  const b=c&&c.earned.filter(x=>x.fam==='traderage'&&x.k>=since).pop();
  return b?`<a class="pz-fine" href="#badges" style="color:${PZ_COL.good};text-decoration:none">New milestone: ${esc(b.desc)} ›</a>`:'';
}
function taCardHtml(D){
  const A=taOf(D); // no trading days yet: it shows as building, so it can be found
  const head=`<div class="pz-kvrow"><span class="pz-lbl" style="color:${PZ_COL.xp}">Trader Age${A.verified?' · ✓ verified':''}</span><a class="pz-link" href="#age" style="min-height:0">What builds it ${pzI('chev',14)}</a></div>`;
  if(A.building)return `<section class="pz-card pz-kv">${head}
    <b style="font-size:17px">Building your Trader Age</b>${pzBar((TA.minDays-A.need)/TA.minDays,PZ_COL.xp)}
    <p class="pz-sub" style="font-size:13px">${A.need} more trading day${A.need===1?'':'s'} and it appears: how seasoned your process looks, in years.</p></section>`;
  const pace=A.pace!=null?`<span style="color:${taPaceCol(A.pace)};font-weight:600">Pace ${A.pace.toFixed(1)}× · ${taPaceWord(A.pace)}</span>`:'<span class="pz-sub">Pace needs 3 trading days this week</span>';
  return `<section class="pz-card pz-kv">${head}
    <div style="display:flex;align-items:baseline;gap:10px;flex-wrap:wrap"><span style="font-family:var(--pz-num);font-size:40px;font-weight:600;line-height:1">${esc(taFmtYears(A.age))}</span>
      ${A.tradingYears!=null?`<span class="pz-sub" style="font-size:13px">trading for ${esc(taFmtYears(A.tradingYears))}</span>`:''}</div>
    <p style="font-size:13px;margin:0">${pace}</p>${taMilestoneNote(D)}</section>`;
}
const TA_SLIP={revenge:'Revenge entries',afterTwo:'Trading on after two losses',sizeUp:'Sizing up after a loss',addLoser:'Adding to losers',overtrade:'Overtrading',heldLoser:'Holding losers too long'};
// a habit band: worst on the left, best on the right, ▼ the 6-month share (labelled), ▲ the last 30 trading days
function taBandHtml(v6,v30,fmt,muted){ const pos=v=>Math.max(2,Math.min(98,100*v)).toFixed(1)+'%';
  const tip=esc('6 months  '+fmt(v6)+(v30!=null?'\nLast 30 trading days  '+fmt(v30):''));
  // the last 30 days' marker reads the trend at a glance: green when ahead of the 6 months, red when behind
  const col=v30==null?'':v30-v6>=0.02?PZ_COL.good:v6-v30>=0.02?PZ_COL.low:'var(--pz-muted)';
  return `<div class="pz-band${muted?' pz-band-few':''}" data-pz-tip="${tip}" role="img" aria-label="${tip}"><span class="pz-band-l" style="left:${pos(v6)}">${esc(fmt(v6))}</span><span class="pz-band-m pz-band-6" style="left:${pos(v6)}">▼</span>${v30!=null?`<span class="pz-band-m pz-band-30" style="left:${pos(v30)};color:${col}">▲</span>`:''}</div>`; }
// what a habit is worth now: green what the kept ones earn, red what the slips cost
function taWorthHtml(h){ const e=h.earn>0?`<span style="color:${PZ_COL.good}">+${esc(taFmtDelta(h.earn))}</span>`:'', c=h.cost>0?`<span style="color:${PZ_COL.low}">−${esc(taFmtDelta(h.cost))}</span>`:'';
  return e||c?`<b class="pz-hab-y">${e}${e&&c?' <span class="pz-sub">·</span> ':''}${c}</b>`:'<b class="pz-hab-y pz-sub" style="font-weight:500">—</b>'; }
// every habit behind the rating, grouped by part, each with its band and what it's worth (this device's trades)
function taHabitsHtml(D,A){
  const I=taInputs(D.g.days); let H=[]; try{ H=taHabits(I.days,I.J,I.opts); }catch(e){ console.warn('habits',e); }
  if(!H.length)return '';
  const pct=v=>Math.round(100*v)+'%';
  const row=h=>{ const few=!!h.few;
    const sub=h.k==='steadiness'?'The spread of your daily scores, one-trade days discounted'
      :h.k==='journal'?`${Math.round(h.kept)} of ${h.chances} ${h.unit} journaled`
      :h.k==='plan'?`${Math.floor(h.kept)} of ${h.chances} ${h.unit} planned${h.late?' · '+h.late+' written late':''}`
      :h.k==='checkin'?`${h.kept} of ${h.chances} ${h.unit}`
      :h.k==='limit'?`${h.kept} of ${h.chances} ${h.unit}`
      :`${h.kept} of ${h.chances} ${h.unit} kept`;
    const band=h.k==='steadiness'?taBandHtml(h.value/100,h.value30!=null?h.value30/100:null,v=>Math.round(100*v)+''):taBandHtml(h.share,h.share30,pct,few);
    const worth=few?`<b class="pz-hab-y pz-sub" style="font-weight:500" title="Fewer than ${TA.fewChances} chances in 6 months: too few to say what it’s worth">too few yet</b>`:taWorthHtml(h);
    return `<div class="pz-row${few?' pz-few':''}"><div class="pz-row-t"><span>${esc(h.good)}<span class="pz-sub" style="display:block;font-size:12px">${esc(sub)}</span></span>${worth}</div>${band}</div>`; };
  const groups=[['discipline','Discipline'],['steadiness','Steadiness'],['limit','Loss limit'],['log','Prep and journal']].map(([p,l])=>{ const rows=H.filter(h=>h.part===p); if(!rows.length)return '';
    const [, , w]=TA_PART[p], v=A.parts?A.parts[p]:null;
    return `<div style="display:flex;justify-content:space-between;align-items:baseline;gap:10px;margin-top:6px"><span class="pz-lbl" style="color:${p===A.drag?PZ_COL.low:'var(--pz-muted)'}">${esc(l)} · ${w}%</span>${v!=null?`<b style="font-family:var(--pz-num);font-size:16px">${Math.round(v)}</b>`:''}</div>${rows.map(row).join('')}`; }).join('');
  return `<section class="pz-card pz-kv"><div class="pz-kvrow"><b class="pz-kvh">What each habit is worth</b><span class="pz-sub" style="font-size:12px;white-space:nowrap">▼ 6 months · ▲ last 30 trading days</span></div>
    <p class="pz-sub" style="font-size:13px"><span style="color:${PZ_COL.good}">Green</span>: what the times you kept it earn you. <span style="color:${PZ_COL.low}">Red</span>: what the slips cost you. Each on its own, everything else the same. The ▲ is green when the last 30 days beat the 6 months, red when they trail.</p>
    ${groups}
    <p class="pz-fine">From this device’s trades. Years double every 10 rating points, so the figures don’t add up. Holding it back most: <b>${esc(TA_PART[A.drag][0].toLowerCase())}</b>. <a href="#progress">Plug a leak</a> to work on one.</p></section>`;
}
// the last 30 trading days against the 30 before and the 30 before that (this device's trades)
function taThenNowHtml(D){
  const I=taInputs(D.g.days); let B=[]; try{ B=taThenNow(I.days,I.J,I.opts); }catch(e){ console.warn('then-now',e); }
  const head=`<b class="pz-kvh">Then and now</b>`;
  if(B.length<2)return `<section class="pz-card pz-kv">${head}<p class="pz-sub" style="font-size:13px">Your last 30 trading days against the 30 before. It needs 40 trading days in the last 6 months${B.length?'; you have '+(B[0].days)+'.':'.'}</p></section>`;
  const last=B[B.length-1], prev=B[B.length-2];
  const arrow=(a,b,hiGood)=>{ if(a==null||b==null||a===b)return ''; const up=a>b, good=hiGood?up:!up; return `<span style="color:${good?PZ_COL.good:PZ_COL.low}">${up?'↑':'↓'}</span>`; };
  const cells=(f,fmt,hiGood)=>B.map((b,i)=>{ const v=f(b); return `<td${i===B.length-1?' class="now"':''}>${v==null?'<span class="pz-sub">—</span>':esc(fmt(v))}${i===B.length-1?' '+arrow(v,f(prev),hiGood):''}</td>`; }).join('');
  const slipRows=TA_SLIPS.filter(k=>B.some(b=>b.slips&&b.slips[k]>0)).map(k=>[TA_SLIP[k],b=>b.slips?b.slips[k]:null,v=>v.toFixed(1),false,'in']);
  const rows=[['Trader Age',b=>b.age,taFmtDelta,true],['Discipline',b=>b.disc,v=>v+'',true]]
    .concat(slipRows.length?[['Slips, per 100 trades']]:[]).concat(slipRows)
    .concat([['Kept']]).concat([['Loss limit',b=>b.limit,v=>v+'%',true,'in'],['Plan before the first trade',b=>b.plan,v=>v+'%',true,'in'],['Morning check-in',b=>b.checkin,v=>v+'%',true,'in'],['Trades journaled',b=>b.journal,v=>v+'%',true,'in']].filter(r=>B.some(b=>r[1](b)!=null)));
  const label=(b,i)=>i===B.length-1?'Last 30':i===B.length-2?'Previous 30':'Earlier 30';
  return `<section class="pz-card pz-kv">${head}<p class="pz-sub" style="font-size:13px">You against yourself: each column is 30 trading days${B.some(b=>b.days<TA.recentN)?' (the oldest has '+B[0].days+')':''}. Arrows: the last 30 against the 30 before.</p>
    <table class="pz-tn"><thead><tr><th></th>${B.map((b,i)=>`<th title="${esc(b.from+' to '+b.to)}">${label(b,i)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map(([l,f,fmt,hi,ind])=>f?`<tr${ind?' class="in"':''}><td>${esc(l)}</td>${cells(f,fmt,hi)}</tr>`:`<tr class="grp"><td colspan="${B.length+1}">${esc(l)}</td></tr>`).join('')}</tbody></table>
    <p class="pz-fine">Trading days only, so a break doesn’t count against you. From this device’s trades.</p></section>`;
}
// Trader Age over time (the end of each week with trading, last 26) against how long you've traded,
// on one scale in years where every gridline doubles (the same scale the rating uses)
function taHistoryChartHtml(D){
  let H=[]; try{ H=taHistoryOf(D.g.days); }catch(e){ console.warn('history',e); }
  const firstAt=taInputs([]).opts.firstAt, byW=new Map(); for(const h of H)if(h.age!=null)byW.set(isoWeekOfKey(h.key),h);
  const P=[...byW.entries()].slice(-26).map(([w,h])=>({w,key:h.key,age:h.age,ty:firstAt?Math.max(1/12,(Date.parse(h.key+'T23:59:59Z')-firstAt)/(365.25*864e5)):null}));
  if(P.length<2)return '';
  const r=y=>50+10*Math.log2(Math.max(1/12,Math.min(TA.cap,y))), vals=P.flatMap(p=>[r(p.age)].concat(p.ty?[r(p.ty)]:[]));
  const lo=Math.min(...vals)-4, hi=Math.max(...vals)+4, Wd=320, Ht=150, L=36, R=10, T=10, B=24;
  const x=i=>L+(Wd-L-R)*i/(P.length-1), y=v=>T+(Ht-T-B)*(1-(v-lo)/(hi-lo));
  const grid=[[1/12,'1 mo'],[1/4,'3 mo'],[1/2,'6 mo'],[1,'1 yr'],[2,'2 yrs'],[4,'4 yrs'],[8,'8 yrs'],[16,'16 yrs']].filter(([g])=>r(g)>=lo&&r(g)<=hi);
  const line=f=>P.map((p,i)=>(i?'L':'M')+x(i).toFixed(1)+' '+y(f(p)).toFixed(1)).join(' ');
  const last=P[P.length-1], tip=p=>esc(taWeekLabel(p.w)+'\nTrader Age  '+taFmtYears(p.age)+(p.ty?'\nTrading for  '+taFmtYears(p.ty):''));
  return `<section class="pz-card pz-kv"><b class="pz-kvh">Over time</b>
    <div style="display:flex;gap:14px;flex-wrap:wrap;font-size:12px" class="pz-sub"><span><svg width="18" height="8" aria-hidden="true"><path d="M1 4H17" stroke="${PZ_COL.xp}" stroke-width="2" stroke-linecap="round"/></svg> Trader Age</span>${last.ty?`<span><svg width="18" height="8" aria-hidden="true"><path d="M1 4H17" stroke="var(--pz-muted)" stroke-width="2" stroke-dasharray="3 3"/></svg> Time trading</span>`:''}</div>
    <svg viewBox="0 0 ${Wd} ${Ht}" width="100%" role="img" aria-label="${esc('Trader Age by week, from '+taFmtYears(P[0].age)+' to '+taFmtYears(last.age)+(last.ty?', trading for '+taFmtYears(last.ty):''))}" style="display:block;overflow:visible">
      ${grid.map(([g,l])=>`<line x1="${L}" x2="${Wd-R}" y1="${y(r(g)).toFixed(1)}" y2="${y(r(g)).toFixed(1)}" stroke="var(--pz-line)" stroke-width="1"/><text x="${L-6}" y="${(y(r(g))+4).toFixed(1)}" text-anchor="end" font-size="10" fill="var(--pz-muted)">${l}</text>`).join('')}
      ${last.ty?`<path d="${line(p=>r(p.ty))}" fill="none" stroke="var(--pz-muted)" stroke-width="2" stroke-dasharray="4 4" stroke-linejoin="round"/>`:''}
      <path d="${line(p=>r(p.age))}" fill="none" stroke="${PZ_COL.xp}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
      <circle cx="${x(P.length-1).toFixed(1)}" cy="${y(r(last.age)).toFixed(1)}" r="4" fill="${PZ_COL.xp}" stroke="var(--pz-card)" stroke-width="2"/>
      <text x="${L}" y="${Ht-6}" font-size="10" fill="var(--pz-muted)">${esc(taWeekLabel(P[0].w).replace('Week of ',''))}</text><text x="${Wd-R}" y="${Ht-6}" font-size="10" fill="var(--pz-muted)" text-anchor="end">${esc(taWeekLabel(last.w).replace('Week of ',''))}</text>
      ${P.map((p,i)=>`<rect x="${(x(i)-(Wd-L-R)/(P.length-1)/2).toFixed(1)}" y="${T}" width="${((Wd-L-R)/(P.length-1)).toFixed(1)}" height="${Ht-T-B}" fill="transparent" data-pz-tip="${tip(p)}"/>`).join('')}
    </svg>
    <p class="pz-fine">Your Trader Age at the end of each week you traded${last.ty?', next to how long you’ve been trading':''}. Every gridline doubles. From this device’s trades.</p></section>`;
}
function taScreenHtml(D){
  const A=taOf(D), back=`<a class="pz-back" href="#today">${pzI('back',20)}Today</a>`;
  const how=`<section class="pz-card pz-kv"><b class="pz-kvh">How it works</b>
    <p class="pz-sub" style="font-size:13px">Every trading day is rated from 0 to 100: 65% your Discipline score (the share of trades with no slip, read from your fills), 15% steadiness (how even your daily scores are, with one-trade days discounted), 10% the loss limit (kept 100, traded past it 0, none set 70) and 10% prep and journal (a plan before the first trade, half for a late one or a check-in alone; and the share of trades journaled).</p>
    <p class="pz-sub" style="font-size:13px">Your last 6 months of trading days are averaged, with recent days counting more (a day's weight halves every 30 trading days). Every 10 points doubles your Trader Age: a rating of 50 is 1 year, 60 is 2, 70 is 4, 80 is 8. Only days you trade count, so a break freezes it. It never comes from profit.</p>
    <p class="pz-fine">${taEstimateNote(A)}</p></section>`;
  if(!A.n)return `${back}${pzHead('Your process, in years','Trader Age')}<section class="pz-card"><p class="pz-sub">It starts with your first trading day.</p></section>${taStandingCardHtml()}${how}`;
  if(A.building)return `${back}${pzHead('Your process, in years','Trader Age')}<section class="pz-card pz-kv"><b style="font-size:17px">Building: ${A.need} more trading day${A.need===1?'':'s'}</b>${pzBar((TA.minDays-A.need)/TA.minDays,PZ_COL.xp)}<p class="pz-sub" style="font-size:13px">${A.n} of ${TA.minDays} trading days so far.</p></section>${taStandingCardHtml()}${how}`;
  const ahead=A.tradingYears==null?'Your process, in years':A.age>=A.tradingYears?'Ahead of your experience':'Still catching up with your experience';
  const wk=A.week, slip=wk.slip&&typeof PZ_BEH!=='undefined'?PZ_BEH[wk.slip]:null;
  const weekLine=A.pace!=null?`This week, over ${wk.n} trading days, you traded like someone with ${esc(taFmtYears(wk.age))} behind them: ${taPaceWord(A.pace)}.${A.pace<0.9&&slip?' What cost you most: '+esc(slip.toLowerCase())+'.':''}`
    :`Pace needs 3 trading days in the last 7${wk.n?'; you have '+wk.n:''}.`;
  const hero=`<section class="pz-card pz-hero pz-span">
    <div class="pz-hero-ring">${pzRing(taFmtYears(A.age).split(' ')[0],Math.min(1,A.rating/100),taAgeCol(A.rating),{size:132,cap:taFmtYears(A.age).split(' ')[1]||''})}</div>
    <div class="pz-hero-main"><span class="pz-lbl" style="color:${PZ_COL.xp}">Trader Age</span><h2 class="pz-hero-t">${esc(ahead)}</h2>
      <p class="pz-sub" style="font-size:13px">${A.tradingYears!=null?`Your process looks ${esc(taFmtYears(A.age))} seasoned, and you’ve been trading for ${esc(taFmtYears(A.tradingYears))}. `:''}Rating ${Math.round(A.rating)} from ${A.n} trading days.</p>
      ${A.tradingYears!=null||A.pace!=null?`<div style="display:flex;gap:18px;flex-wrap:wrap;margin-top:4px">${A.tradingYears!=null?`<span><b style="font-family:var(--pz-num);font-size:22px;color:${A.age>=A.tradingYears?PZ_COL.good:PZ_COL.low}">${A.age>=A.tradingYears?'+':'−'}${esc(taFmtDelta(A.age-A.tradingYears))}</b><span class="pz-sub" style="display:block;font-size:11px;letter-spacing:.04em;text-transform:uppercase">${A.age>=A.tradingYears?'ahead of':'behind'} your experience</span></span>`:''}${A.pace!=null?`<span><b style="font-family:var(--pz-num);font-size:22px;color:${taPaceCol(A.pace)}">${A.pace.toFixed(1)}×</b><span class="pz-sub" style="display:block;font-size:11px;letter-spacing:.04em;text-transform:uppercase">pace this week</span></span>`:''}</div>`:''}
      <p class="pz-fine">${A.range?`Likely between ${esc(taFmtYears(A.range[0]))} and ${esc(taFmtYears(A.range[1]))}.${A.sure<1?` With fewer than ${TA.fullDays} trading days it’s held closer to 1 year, and firms up as you trade.`:''} `:''}${weekLine}</p></div></section>`;
  const mult=taMultCardHtml(A)+taStandingCardHtml();
  const rows=Object.keys(TA_PART).map(k=>{ const [l,h,w]=TA_PART[k], v=A.parts[k];
    return `<div class="pz-row"><div class="pz-row-t"><span>${esc(l)}<span class="pz-sub" style="display:block;font-size:12px">${esc(h)} · ${w}%</span></span><b>${Math.round(v)}</b></div>${pzBar(v/100,k===A.drag?PZ_COL.low:PZ_COL.xp)}</div>`; }).join('');
  const habits=taHabitsHtml(D,A);
  // the four parts on their own only when the habit list can't be made (no trading days on this device)
  const parts=habits?'':`<section class="pz-card pz-kv"><b class="pz-kvh">What builds it</b>${rows}<p class="pz-fine">Holding it back most: <b>${esc(TA_PART[A.drag][0].toLowerCase())}</b>.</p></section>`;
  const hist=taHistoryChartHtml(D), then=taThenNowHtml(D);
  return `${back}${pzHead('Your process, in years','Trader Age')}<div class="pz-wide">${hero}<div class="pz-col">${habits}${parts}${how}</div><div class="pz-col">${then}${hist}${mult}</div></div>`;
}
pzFeature({id:'age', today:{label:'Trader Age',hint:'How seasoned your process looks, in years, against how long you’ve traded',col:0,after:'tilt',html:taCardHtml},
  tab:{name:'age',nav:'progress',html:taScreenHtml}});
