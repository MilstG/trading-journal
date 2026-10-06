/* ============================================================================
   Recap — your month or your year in process: Discipline, clean days, the best streak, perfect weeks,
   XP, badges, reviews and lessons, rest days, and the slip that shrank the most. No dollars, on purpose,
   so it's something people can share.
   A feature in its own file: it plugs into Daruma through pzFeature (app/pulse.js) and loads on
   Daruma's page only (data-only="keel" in ledger.html).

   The screen is #recap (#recap/2026-09 for a month, #recap/2026 for a year). For the first week of a
   month, a Today card says last month's recap is ready (the first two weeks of January: last year's),
   until it's opened or put away (this device remembers: localStorage 'pzRecapSeen'). The share image is
   the "Share my week" card (pzWeekCardDraw) with the period's label.
   ============================================================================ */
const RC_SEEN='pzRecapSeen';
const rcRange=key=>key.length===4?{kind:'year',lo:key+'-01-01',hi:key+'-12-31'}:{kind:'month',lo:key+'-01',hi:key+'-31'};
const rcLabel=key=>key.length===4?key:MONTHS[+key.slice(5)-1]+' '+key.slice(0,4);
const rcPrevKey=key=>key.length===4?String(+key-1):(+key.slice(5)===1?(+key.slice(0,4)-1)+'-12':key.slice(0,5)+String(+key.slice(5)-1).padStart(2,'0'));
// The recap of one period, from the game and the journal. Pure apart from what it's handed:
// g: the game (days, streak, xp, catalog, achievements, challenges); J: the journal; lessons: the library.
function rcRecap(g, J, key, lessons){
  const R=rcRange(key), inR=k=>k&&k>=R.lo&&k<=R.hi, days=g.days.filter(d=>inR(d.key));
  if(!days.length)return null;
  const P=rcRange(rcPrevKey(key)), prev=g.days.filter(d=>d.key>=P.lo&&d.key<=P.hi);
  const avg=a=>a.length?Math.round(a.reduce((s,d)=>s+d.score,0)/a.length):null;
  let run=0, best=0; for(const d of days){ run=d.score>=70?run+1:0; if(run>best)best=run; }
  const slipRate=arr=>{ const o={}; for(const d of arr)for(const s of ((d.behavior&&d.behavior.slips)||[]))for(const k of (s.f||[]))o[k]=(o[k]||0)+1;
    for(const k in o)o[k]=o[k]/arr.length; return o; };
  const sc=slipRate(days), sp=slipRate(prev);
  // the slip that shrank the most against the period before (seen at least 3 times then), per trading day
  let better=null; if(prev.length>=3)for(const k in sp){ const was=sp[k], now=sc[k]||0, cnt=Math.round(was*prev.length);
    if(cnt>=3&&now<was*0.75&&(!better||was-now>better.was-better.now))better={slip:k,was,now}; }
  const earned=((g.catalog&&g.catalog.earned)||[]).filter(b=>inR(b.k)&&b.c!=='results');
  const dayE=k=>J['day:'+k]||{};
  let rest=0; for(const k in J)if(k.startsWith('day:')&&inR(k.slice(4))&&J[k]&&J[k].rest)rest++;
  return {key,kind:R.kind,label:rcLabel(key),from:R.lo,to:R.hi,
    tradingDays:days.length,discipline:avg(days),prevDiscipline:avg(prev),clean:days.filter(d=>d.score>=70).length,perfectDays:days.filter(d=>d.score===100).length,
    bestStreak:best,perfectWeeks:((g.streak&&g.streak.perfectWeeks)||[]).filter(w=>inR(w.key)).length,
    xp:Math.round(Object.keys((g.xp&&g.xp.byDay)||{}).filter(inR).reduce((s,k)=>s+g.xp.byDay[k],0)),
    badges:earned.length,topBadges:[...earned].sort((a,b)=>(b.r||0)-(a.r||0)).slice(0,3).map(b=>({t:String(b.t).replace(/ · .*/,''),r:b.r||0})),
    achievements:(g.achievements||[]).filter(a=>inR(a.at)).map(a=>a.title),
    challenges:(g.challenges||[]).filter(c=>c.status==='done'&&inR(c.key)).length,
    reviews:days.filter(d=>dayE(d.key).eod&&dayE(d.key).eod.at).length,plans:days.filter(d=>d.parts&&d.parts.plan===1).length,
    lessons:(lessons||[]).filter(l=>inR(l.key)).length,rest,better};
}
// the recap to offer now: early in a month, last month's (fresh); early in January, last year's (fresh);
// otherwise the latest finished month with trading, if any
function rcLatest(g, todayK){
  todayK=todayK||dayKey(Date.now()); const has=key=>{ const R=rcRange(key); return g.days.some(d=>d.key>=R.lo&&d.key<=R.hi); };
  const m=todayK.slice(0,7), y=todayK.slice(0,4), dom=+todayK.slice(8);
  if(todayK.slice(5,7)==='01'&&dom<=14&&has(String(+y-1)))return {key:String(+y-1),kind:'year',label:String(+y-1),fresh:true};
  const pm=rcPrevKey(m); if(dom<=7&&has(pm))return {key:pm,kind:'month',label:rcLabel(pm),fresh:true};
  const ks=[...new Set(g.days.map(d=>d.key.slice(0,7)))].filter(k=>k<m).sort();
  return ks.length?{key:ks[ks.length-1],kind:'month',label:rcLabel(ks[ks.length-1]),fresh:false}:null;
}
function rcSeen(){ try{ return localStorage.getItem(RC_SEEN)||''; }catch(e){ return ''; } }
function rcSetSeen(k){ try{ localStorage.setItem(RC_SEEN,k); }catch(e){} }
function rcTodayHtml(D){
  const L=rcLatest(D.g,D.todayK); if(!L||!L.fresh||rcSeen()===L.key)return '';
  return `<section class="pz-card pz-kv" aria-labelledby="rcT"><div class="pz-kvrow"><b id="rcT" class="pz-kvh">Your ${esc(L.label)} recap is ready</b><button type="button" class="pz-chip icon" data-rc="hide" data-key="${esc(L.key)}" aria-label="Put the recap away">${pzI('x',16)}</button></div>
    <p class="pz-sub" style="margin:0;font-size:13px">Your ${L.kind} in process: Discipline, your best streak, badges, lessons, and the slip you cut the most. No dollars, so it’s one you can share.</p>
    <a class="pz-cta pz-sm" href="#recap/${esc(L.key)}" style="display:inline-flex;align-items:center;justify-content:center;text-decoration:none;min-height:44px">See my ${L.kind}</a></section>`;
}
function rcScreenHtml(D){
  const g=D.g, back=`<a class="pz-back" href="#progress">${pzI('back',20)}Progress</a>`;
  const months=[...new Set(g.days.map(d=>d.key.slice(0,7)))].sort(), years=[...new Set(months.map(m=>m.slice(0,4)))];
  if(!months.length)return `${back}${pzHead('Recap','Nothing to look back on yet')}<p class="pz-sub">Your first recap appears after your first trading day.</p>`;
  const arg=pzHashArg(), isYear=/^\d{4}$/.test(arg), list=isYear?years:months;
  const key=list.includes(arg)?arg:(rcLatest(g,D.todayK)||{key:months[months.length-1]}).key, keys=key.length===4?years:months, i=keys.indexOf(key);
  if(key===(rcLatest(g,D.todayK)||{}).key)rcSetSeen(key);
  let lessons=[]; try{ lessons=pzLessonsAll(); }catch(e){}
  const r=rcRecap(g,journal,key,lessons); if(!r)return `${back}${pzHead('Recap',rcLabel(key))}<p class="pz-sub">No trading in ${esc(rcLabel(key))}.</p>`;
  const seg=`<div class="pz-seg pz-span" role="group" aria-label="Period"><button type="button" data-rc="go" data-key="${esc(months[months.length-1])}" aria-pressed="${r.kind==='month'}">Month</button><button type="button" data-rc="go" data-key="${esc(years[years.length-1])}" aria-pressed="${r.kind==='year'}">Year</button></div>`;
  const nav=`<div class="pz-kvrow pz-span"><a class="pz-chip icon" href="#recap/${esc(keys[i-1]||key)}"${i>0?'':' aria-disabled="true" tabindex="-1" style="opacity:.4;pointer-events:none"'} aria-label="Previous">${pzI('back',18)}</a><b style="font-size:15px">${esc(r.label)}</b><a class="pz-chip icon" href="#recap/${esc(keys[i+1]||key)}"${i<keys.length-1?'':' aria-disabled="true" tabindex="-1" style="opacity:.4;pointer-events:none"'} aria-label="Next" style="transform:scaleX(-1)">${pzI('back',18)}</a></div>`;
  const col=PZ_COL[pzBand(r.discipline)], dd=r.prevDiscipline!=null?r.discipline-r.prevDiscipline:null;
  const tile=(n,t,c)=>`<div class="pz-tile"><span class="pz-n"${c?` style="color:${c}"`:''}>${esc(String(n))}</span><span class="pz-t">${esc(t)}</span></div>`;
  const per=v=>v>=1?v.toFixed(1):v.toFixed(2);
  return `${back}${pzHead(r.kind==='year'?'Your year':'Your month','Recap')}
  <div class="pz-wide">${seg}${nav}
    <div class="pz-col"><section style="display:flex;flex-direction:column;align-items:center;gap:8px;text-align:center">${pzRing(r.discipline,r.discipline/100,col,{size:168,cap:'Discipline'})}
      <div class="pz-big">${r.clean} of ${r.tradingDays} trading days at 70+</div>
      <p class="pz-sub">${dd==null?'Your average over the '+r.kind+'.':dd>0?'Up '+dd+' from the '+r.kind+' before.':dd<0?'Down '+Math.abs(dd)+' from the '+r.kind+' before.':'Level with the '+r.kind+' before.'}</p></section>
      ${r.better?`<section class="pz-card pz-kv"><span class="pz-lbl" style="color:${PZ_COL.good}">Your biggest improvement</span><b style="font-size:16px">${esc(PZ_BEH[r.better.slip])}</b><p class="pz-sub" style="margin:0">${per(r.better.was)} a trading day before, ${per(r.better.now)} now.</p></section>`:''}
      ${r.topBadges.length?`<section class="pz-card pz-kv"><b class="pz-kvh">Badges earned: ${r.badges}</b>${r.topBadges.map(b=>`<div class="pz-kvrow"><span>${esc(b.t)}</span><span class="pz-tag" style="color:${PZ_TIER_COL[b.r]}">${esc(PZ_TIERS[b.r])}</span></div>`).join('')}</section>`:''}
      ${r.achievements.length?`<section class="pz-card pz-kv"><b class="pz-kvh">Achievements</b>${r.achievements.map(a=>`<span>${pzI('medal',14)} ${esc(a)}</span>`).join('')}</section>`:''}</div>
    <div class="pz-col"><div class="pz-grid2">
      ${tile(r.bestStreak,'best streak (days at 70+)','var(--pz-streak)')}${tile(r.perfectWeeks,'perfect week'+(r.perfectWeeks===1?'':'s'))}
      ${tile('+'+r.xp.toLocaleString('en-US'),'XP earned',PZ_COL.xp)}${tile(r.perfectDays,'days with no slips')}
      ${tile(r.reviews,'end-of-day reviews')}${tile(r.plans,'days planned before the first trade')}
      ${tile(r.lessons,'lessons written')}${tile(r.challenges,'challenges completed')}
      ${r.rest?tile(r.rest,'rest days taken on purpose'):''}</div>
      ${pzLocked('share',g.level.level)?'':`<button type="button" class="pz-cta pz-sm" data-rc="share" data-key="${esc(key)}" style="min-height:44px">Share my ${r.kind}</button>`}
      <p class="pz-fine">Graded on process, not profit: no dollar amounts here or on the image.</p></div>
    <div class="pz-span" id="gmOut"></div></div>`;
}
async function rcShare(key){
  const g=gameContext(); let lessons=[]; try{ lessons=pzLessonsAll(); }catch(e){}
  const r=rcRecap(g,journal,key,lessons); if(!r)return;
  const m=pzWeekCardModel({from:r.from,to:r.to,days:g.days,streak:{current:r.bestStreak,best:g.streak.best},level:g.level,xpByDay:g.xp.byDay,
    badges:g.catalog?g.catalog.earned:[],label:r.label,avgLabel:r.kind+' average',streakLabel:'Best streak'},{duel:false,age:false});
  const blob=await pzWeekCardBlob(m,'portrait',document.body.classList.contains('light')?'light':'dark');
  const text='My '+r.label+' in process (Daruma): Discipline '+r.discipline+'/100 · '+r.clean+'/'+r.tradingDays+' clean days · best streak '+r.bestStreak+' · '+r.badges+' badge'+(r.badges===1?'':'s')+(r.better?' · cut “'+PZ_BEH[r.better.slip].toLowerCase()+'”':'');
  showCardOut(blob,'daruma-recap-'+key,text,await shareAvailable());
}
async function rcClick(t){
  const a=t.dataset.rc; if(!a)return false;
  if(a==='hide'){ rcSetSeen(t.dataset.key); pzRender(); return true; }
  if(a==='go'){ location.hash='#recap/'+t.dataset.key; return true; }
  if(a==='share'){ try{ await rcShare(t.dataset.key); }catch(e){ pzNote('The image couldn’t be made here: '+e.message,'err'); } return true; }
  return false;
}
pzFeature({id:'recap', today:{label:'Monthly recap',hint:'Early each month: last month in process, ready to look back on and share',col:0,html:rcTodayHtml},
  tab:{name:'recap', nav:'progress', arg:/^\d{4}(-\d{2})?$/, html:rcScreenHtml}, click:rcClick});
