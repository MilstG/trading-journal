// Ledger app · part 14 of 15: Pulse growth screens: progress, badges, reports, review, coach, leagues.
// ledger.html loads the parts in order as classic scripts sharing one global scope. Code that
// runs while a part loads (not inside a function called later) may only use names declared in
// this part or an earlier one; the boot part runs last. See "Development and testing" in README.md.

/* ======================= 13b · PULSE GROWTH SCREENS: progress, badges, reports, review, coach, leagues ======================= */
const PZ_CAT_ICON={discipline:'saved',habits:'bolt',consistency:'flame',journal:'pen',routine:'today',risk:'shield',results:'trends',milestones:'progress'};
// what a badge means, for its hover tip: name, tier, what earns it, when, and the XP it paid
function pzBadgeTip(b, f){
  const tier=PZ_TIERS[b.r]||'', name=b.t.replace(/ · .*/,''), what=b.desc?b.desc.charAt(0).toUpperCase()+b.desc.slice(1):'';
  if(b.earned===false||!b.k){ const have=f&&isFinite(f.value)?' You’re at '+pzN(Math.floor(f.value))+' of '+pzN(b.need)+'.':'';
    return name+(tier?' · '+tier:'')+'\nNot earned yet. '+(what?'Earned for '+what.charAt(0).toLowerCase()+what.slice(1)+'.':'')+have; }
  return name+(tier&&b.fam!=='a'?' · '+tier:'')+'\n'+(what?what+'.':'')+'\nEarned '+dayLabel(b.k)+(b.xp?' · +'+b.xp+' XP':'')+'.'; }
function pzMedal(b, size){
  const r=Math.max(0,Math.min(5,b.r||0)), col=PZ_TIER_COL[r], sz=size||56;
  return `<span class="pz-medal${b.earned===false?' off':''}" style="--tc:${b.earned===false?'#3A424C':col};--ms:${sz}px" aria-hidden="true">${pzI(PZ_CAT_ICON[b.c]||'medal',Math.round(sz*0.42),2)}</span>`;
}
const pzPctBar=(p,col)=>`<span class="pz-pbar"><i style="width:${Math.round(Math.max(0,Math.min(1,p||0))*100)}%;background:${col||'var(--pz-acc)'}"></i></span>`;
// XP earned in a window, by where it came from
function pzXpSources(g, fromKey){
  const X=pzXpCfg(), o={discipline:0,bonus:0,badges:0,challenge:0,habits:0,league:0,achievements:0};
  for(const d of g.days)if(d.key>=fromKey){ o.discipline+=Math.round(d.score*X.discipline); o.bonus+=d.bonus.total; }
  for(const b of (g.bonuses||[]))if(b.key>=fromKey){ const k=b.src==='badge'?'badges':b.src==='grant'||b.src==='award'?'league':b.why==='challenge'?'challenge':b.why==='focus habit'?'habits':'achievements'; o[k]+=b.xp; }
  return o;
}
function pzProgressHtml(D){
  const {g}=D, L=g.level, cat=g.catalog||{earned:[],families:[],total:0}, nowK=D.todayK, wkFrom=dayKey(lastCompletedWeekRange(Date.now()).to);
  const src=pzXpSources(g,wkFrom), srcRows=[['discipline','Discipline scores',PZ_COL.good],['bonus','Prep, plans, journal, reviews',PZ_COL.xp],['badges','Badges',PZ_TIER_COL[2]],
    ['achievements','Achievements','#F4C04E'],['challenge','Weekly challenge','#FFB25A'],['habits','Focus habit','#5AA9FF'],['league','From your league','#FF8AD8']].filter(([k])=>src[k]);
  const wkTot=Object.values(src).reduce((a,v)=>a+v,0);
  const hero=`<section class="pz-card pz-hero pz-span">
    <div class="pz-hero-ring">${pzRing(L.level,L.max?1:L.into/L.need,PZ_COL.xp,{size:132,cap:'Level'})}</div>
    <div class="pz-hero-main"><span class="pz-lbl" style="color:${PZ_COL.xp}">Level ${L.level}</span><h2 class="pz-hero-t">${esc(L.title)}</h2>
      <div class="pz-xpbar" role="progressbar" aria-label="XP to next level" aria-valuemin="0" aria-valuemax="${L.need}" aria-valuenow="${L.into}" data-pz-tip="${esc(L.max?'Top level reached':L.into.toLocaleString()+' of '+L.need.toLocaleString()+' XP into level '+L.level+'\n'+(L.need-L.into).toLocaleString()+' XP to '+pzLevelTitle(L.level+1)+'. XP comes from process, never profit.')}"><i style="width:${L.max?100:Math.round(100*L.into/L.need)}%"></i></div>
      <p class="pz-sub" style="font-size:13px">${L.xp.toLocaleString()} XP · ${L.max?'top level reached':(L.need-L.into).toLocaleString()+' XP to '+esc(pzLevelTitle(L.level+1))}</p>
    </div></section>`;
  const xpCard=`<section class="pz-card pz-kv"><div class="pz-kvrow"><b class="pz-kvh">Where this week’s XP came from</b><span class="pz-sub" style="font-size:12px">${wkTot.toLocaleString()} XP</span></div>
    ${wkTot?srcRows.map(([k,l,c])=>`<div class="pz-row"><div class="pz-row-t"><span>${esc(l)}</span><b>+${src[k].toLocaleString()}</b></div>${pzBar(src[k]/wkTot,c)}</div>`).join('')
      :'<p class="pz-sub" style="font-size:13px">No XP yet this week. Every trading day earns its Discipline score; morning prep, plans, journaling and reviews add more.</p>'}
    <p class="pz-fine">XP only comes from process — never from profit or the number of trades. <a href="#how">How it’s counted</a></p></section>`;
  // challenge
  const ch=g.current, chHtml=ch?`<section class="pz-card pz-kv"><div class="pz-kvrow"><span class="pz-lbl" style="color:${PZ_COL.xp}">This week’s challenge</span><span style="font-size:12px;font-weight:700;color:${PZ_COL.xp}">+${pzXpCfg().challenge} XP</span></div>
      <b style="font-size:16px;line-height:1.35">${esc(habitSentence(ch.ch.spec))}</b>
      ${ch.res.length?`<div class="pz-dots">${ch.res.slice(-7).map(r=>`<span><i class="${r.kept?'k':'m'}"></i>${esc(DOWN[new Date(r.key+'T00:00:00Z').getUTCDay()])}</span>`).join('')}</div>`:'<p class="pz-sub" style="font-size:13px">Starts with your next trading day.</p>'}
      <div class="pz-kvrow"><span class="pz-sub" style="font-size:12px">${ch.status==='missed'?'Missed once — the rest of the week still earns XP.':'Kept on every trading day this week = done.'}</span><button type="button" class="pz-ghost pz-sm" id="pzSwap" style="width:auto;padding:0 14px">Pick another</button></div></section>`
    :`<section class="pz-card"><p class="pz-sub">A weekly challenge is picked from your biggest leak once you have a few trades.</p></section>`;
  // habits with their own streaks
  const savedBy=new Map((g.saved.items||[]).map(x=>[x.name,x.saved]));
  const hs=habitsList().map(h=>({h,s:pzHabitStreak(h,g.ctx,g.nowWeek)}));
  const habitsHtml=`<section class="pz-card pz-kv"><div class="pz-kvrow"><b class="pz-kvh">Your habits</b><span class="pz-sub" style="font-size:12px">${hs.length} active</span></div>
    ${hs.length?pzPage('habits',hs).items.map(({h,s})=>{ const sv=savedBy.get(habitSentence(h))||savedBy.get(h.when); const last=s.res.slice(-10);
      return `<div class="pz-habit"><div class="pz-kvrow"><b style="font-size:14px;line-height:1.35">${esc(habitSentence(h))}</b><span class="pz-hstreak" title="Trading days kept in a row">${pzI('flame',14)}${s.current}</span></div>
        <div class="pz-dots sm">${last.map(r=>`<span><i class="${r.kept?'k':'m'}"></i></span>`).join('')}</div>
        <span class="pz-sub" style="font-size:12px">Kept ${s.kept} of ${s.total} trading days · best run ${s.best}${s.shields?' · '+s.shields+' shield'+(s.shields===1?'':'s'):''}${sv>0?' · saved you ~'+esc(pzShort(sv)):''}</span></div>`; }).join('')
      :'<p class="pz-sub" style="font-size:13px">No habits yet. Plug a leak below, or adopt one from a trader you follow.</p>'}${pzPage('habits',hs).html}</section>`;
  // leaks and plugs
  // the four costliest, plus any leak being plugged right now (a working plug costs little, so it would drop off the list with its Stop button)
  const leakAll=pzLeakMap(g,30), leaks=leakAll.slice(0,4).concat(leakAll.slice(4).filter(x=>x.plug&&!x.plug.done)), plugs=pzPlugs().filter(p=>!p.dropped);
  const leakHtml=`<section class="pz-card pz-kv"><div class="pz-kvrow"><b class="pz-kvh">Your leaks · 30 days</b><span class="pz-sub" style="font-size:12px">vs the 30 before</span></div>
    ${leaks.length?leaks.map(x=>{ const tr=x.n<x.prevN?'down':x.n>x.prevN?'up':'flat', p=x.plug;
      return `<div class="pz-leak"><div class="pz-kvrow"><b style="font-size:14px">${esc(x.label)}</b><b style="color:${x.cost<0?PZ_COL.low:'var(--pz-soft)'}" title="${esc(signedPlain(x.cost))}">${x.n?esc(pzSigned(x.cost)):'—'}</b></div>
        <span class="pz-sub" style="font-size:12px">${x.n} trade${x.n===1?'':'s'} · ${tr==='down'?'<span style="color:'+PZ_COL.good+'">▼ fewer</span> than the 30 days before ('+x.prevN+')':tr==='up'?'<span style="color:'+PZ_COL.low+'">▲ more</span> than before ('+x.prevN+')':'same as before'}</span>
        ${p?(p.done?`<div class="pz-kvrow"><span class="pz-chipbtn ok">${pzI('check',14,3)} Plugged ${esc(dayLabel(p.done))}</span>${p.back?`<button type="button" class="pz-ghost pz-sm" style="width:auto" data-pz-plug="${esc(x.slip)}">It’s back — plug again</button>`:''}</div>`:`<div class="pz-plug"><span class="pz-steps">${[0,1,2].map(i=>`<i class="${i<p.cleanRun?'on':''}"></i>`).join('')}</span><span class="pz-sub" style="font-size:12px">${p.cleanRun} of 3 clean trading weeks · ${pzPlugWeekNote(p)}</span><button type="button" class="pz-kudo" data-pz-unplug="${esc(x.slip)}">Stop</button></div>`)
          :x.n?`<button type="button" class="pz-ghost pz-sm" data-pz-plug="${esc(x.slip)}">Plug this leak</button>`:''}</div>`; }).join('')
      :'<p class="pz-sub" style="font-size:13px">No Discipline slips in the last 60 days. That’s rare — keep it up.</p>'}
    <p class="pz-fine">Plugging a leak adds a habit that’s checked from your fills. Three clean trading weeks in a row plug it and earn a badge (weeks you don’t trade are skipped).</p></section>`;
  // good moments
  const gm=pzGoodMoments(g,pzAddDays(nowK,-6));
  const gmHtml=`<section class="pz-card pz-kv"><div class="pz-kvrow"><b class="pz-kvh">Good moments · 7 days</b><span class="pz-sub" style="font-size:12px">${gm.length}</span></div>
    ${gm.length?gm.slice(0,5).map(m=>`<div class="pz-moment"><span class="pz-bc done">${pzI('check',12,3)}</span><span style="flex:1"><b style="font-size:13px;font-weight:600">${esc(m.text)}</b><span class="pz-sub" style="display:block;font-size:11px">${esc(dayLabel(m.key))}</span></span></div>`).join('')
      :'<p class="pz-sub" style="font-size:13px">Your good moments show up here: waiting after a loss, stopping after two, clean days, plans before the bell.</p>'}</section>`;
  // badges preview
  const recent=cat.earned.slice(-4).reverse();
  const nextUp=cat.families.filter(f=>f.visible&&f.next).map(f=>({f,p:f.next.need?Math.min(1,f.value/f.next.need):0})).sort((a,b)=>b.p-a.p).slice(0,3);
  const badgeHtml=`<section class="pz-card pz-kv"><div class="pz-kvrow"><b class="pz-kvh">Badges</b><a class="pz-link" href="#badges" style="min-height:0">${cat.earned.length} of ${cat.total}${pzI('chev',14)}</a></div>
    ${recent.length?`<div class="pz-medals">${recent.map(b=>`<a href="#badges" class="pz-mini" data-pz-tip="${esc(pzBadgeTip(b))}" aria-label="${esc(pzBadgeTip(b).replace(/\n/g,' '))}">${pzMedal(b,48)}<span>${esc(b.t.replace(/ · .*/,''))}</span><small style="color:${pzTierText(b.r)}">${PZ_TIERS[b.r]}</small></a>`).join('')}</div>`:''}
    ${nextUp.length?`<span class="pz-lbl" style="color:var(--pz-muted);font-size:11px">Next up</span>${nextUp.map(({f,p})=>`<div class="pz-row"><div class="pz-row-t"><span>${esc(f.next.t)}</span><b>${pzN(Math.floor(f.value))} / ${pzN(f.next.need)}</b></div>${pzBar(p,PZ_TIER_COL[f.next.r])}</div>`).join('')}`:''}
    <a class="pz-ghost pz-sm" href="#badges">See your badge case</a></section>`;
  // report cards
  const wk=pzPeriods(g,'week'), mo=pzPeriods(g,'month'), lastW=wk.filter(k=>k<g.nowWeek).pop(), thisM=mo[mo.length-1];
  const rw=lastW&&pzReport(g,'week',lastW), rm=thisM&&pzReport(g,'month',thisM);
  const gradeTile=(r,label,href)=>r?`<a class="pz-tile pz-grade" href="${href}"><span class="pz-t">${esc(label)}</span><span class="pz-n" style="color:${r.grade==='A'||r.grade==='B'?PZ_COL.good:r.grade==='C'?PZ_COL.mid:PZ_COL.low}">${r.grade}</span><span class="pz-t">process ${Math.round(r.avg)} · ${r.good}/${r.days} good days${r.delta!=null?' · '+(r.delta>=0?'▲':'▼')+Math.abs(Math.round(r.delta)):''}</span></a>`:'';
  const lockR=pzLocked('reports',L.level);
  const reportHtml=`<section class="pz-card pz-kv"><div class="pz-kvrow"><b class="pz-kvh">Report cards</b>${lockR?`<span class="pz-fine">${pzI('lock',12)} level ${lockR}</span>`:'<a class="pz-link" href="#report" style="min-height:0">Open'+pzI('chev',14)+'</a>'}</div>
    ${lockR?'<p class="pz-sub" style="font-size:13px">Weekly and monthly report cards unlock at level '+lockR+'.</p>':`<div class="pz-grid2">${gradeTile(rw,'Last week',`#report`)}${gradeTile(rm,thisM===dayKey(Date.now()).slice(0,7)?'This month':new Date(thisM+'-15T12:00:00Z').toLocaleString('en-US',{month:'long',timeZone:'UTC'}),`#report`)}</div>`}</section>`;
  const pb=`<section class="pz-card pz-kv"><b class="pz-kvh">Personal bests</b>${g.pbs.map(p=>`<div class="pz-row-t"><span>${esc(p.label)}${p.isNew?' <span class="pz-new">new</span>':''}</span><b>${p.value!=null?p.value+(p.unit?' '+p.unit:''):'—'}</b></div>`).join('')}</section>`;
  const share=pzLocked('share',L.level);
  const P=(id,h)=>pzShow('progress',id)?h:'';
  return `${pzHead('Earned by process','Progress',pzChips(g,D.inbox.length))}
  <div class="pz-wide pz-masonry">${hero}
    ${P('goals',(()=>{ try{ return pzGoalsHtml(g); }catch(e){ console.warn('goals',e); return ''; } })())}
    <div class="pz-col">${P('xpsources',xpCard)}${P('challenge',chHtml)}${P('habits',habitsHtml)}${P('reports',reportHtml)}</div>
    <div class="pz-col">${P('leaks',leakHtml)}${P('lessons',(()=>{ try{ return pzLessonsCardHtml(); }catch(e){ console.warn('lessons',e); return ''; } })())}${P('moments',gmHtml)}${P('badges',badgeHtml)}${P('bests',pb)}</div>
    <section class="pz-span" style="display:flex;flex-wrap:wrap;gap:8px;align-items:center">${share?`<span class="pz-fine">${pzI('lock',14)} Share cards unlock at level ${share}</span>`:'<button type="button" class="pz-ghost pz-sm" data-pz-wk="open" style="width:auto;padding:0 16px">Share my week</button>'}</section>
    ${pzS.wk&&!share?pzWkHtml():''}
    <div class="pz-span" id="gmOut"></div>
    ${pzCustomizeLink('progress')}
  </div>`;
}
// ---- the badge case (#badges) ----
function pzBadgesHtml(D){
  const {g}=D, cat=g.catalog||{earned:[],families:[],total:0,hidden:0}, sel=pzS.bcat||'all';
  const back=`<a class="pz-back" href="#progress">${pzI('back',20)}Progress</a>`;
  const vis=cat.families.filter(f=>f.visible&&(sel==='all'||f.cat===sel));
  const counts={}; for(const b of cat.earned)counts[b.c]=(counts[b.c]||0)+1;
  const chips=`<div class="pz-chiprow" role="group" aria-label="Category"><button type="button" class="pz-chipbtn" data-pz-bcat="all" aria-pressed="${sel==='all'}">All · ${cat.earned.length}</button>${Object.keys(PZ_BADGE_CATS).map(c=>`<button type="button" class="pz-chipbtn" data-pz-bcat="${c}" aria-pressed="${sel===c}">${esc(PZ_BADGE_CATS[c])}${counts[c]?' · '+counts[c]:''}</button>`).join('')}</div>`;
  const selB=pzS.badgeSel&&([...cat.earned,...cat.families.flatMap(f=>f.tiers)].find(b=>b.id===pzS.badgeSel))||null;
  const selF=selB&&cat.families.find(f=>f.id===selB.fam);
  const ladder=selF?`<div class="pz-ladder">${selF.tiers.map(b=>`<span class="${b.earned?'on':''}" style="--tc:${PZ_TIER_COL[b.r]}" tabindex="0" data-pz-tip="${esc(pzBadgeTip(b,selF))}">${b.earned?pzI('check',12,3):''}${PZ_TIERS[b.r]} · ${pzN(b.need)}</span>`).join('')}</div>`:'';
  const info=selB?`<section class="pz-card pz-binfo" aria-live="polite">${pzMedal(selB,64)}<span style="flex:1;min-width:0;display:flex;flex-direction:column;gap:4px"><b style="font-size:16px">${esc(selB.t)}</b><span class="pz-sub" style="font-size:13px">${esc(selB.desc||'')}${selB.earned?' · earned '+esc(dayLabel(selB.k)):' · not yet'}</span>${ladder}</span></section>`:'';
  const grid=Object.keys(PZ_BADGE_CATS).filter(c=>sel==='all'||sel===c).map(c=>{
    const fams=vis.filter(f=>f.cat===c), extra=c==='milestones'?cat.earned.filter(b=>b.fam==='a'):[];
    if(!fams.length&&!extra.length)return '';
    // one medal per family: the highest tier you hold (or the first one to chase), the next tier as its progress bar
    const cells=[...extra.map(b=>({b,next:false})),...fams.map(f=>{ const top=f.tiers.filter(b=>b.earned).pop(); return top?{b:top,next:false,f,after:f.next}:{b:f.next,next:true,f}; })];
    return `<section class="pz-span pz-kv"><div class="pz-kvrow"><b class="pz-kvh">${esc(PZ_BADGE_CATS[c])}</b><span class="pz-sub" style="font-size:12px">${counts[c]||0} earned</span></div>
      <div class="pz-bgrid">${cells.map(({b,next,f,after})=>`<button type="button" class="pz-bcell${next?' next':''}" data-pz-bsel="${esc(b.id)}" data-pz-tip="${esc(pzBadgeTip(next?Object.assign({},b,{earned:false}):b,f))}" aria-pressed="${pzS.badgeSel===b.id}" aria-label="${esc(pzBadgeTip(next?Object.assign({},b,{earned:false}):b,f).replace(/\n/g,' '))}">
        ${pzMedal(next?Object.assign({},b,{earned:false}):b,52)}<b>${esc(b.t.replace(/ · .*/,''))}</b><small style="color:${next?'var(--pz-muted)':pzTierText(b.r)}">${PZ_TIERS[b.r]||''}</small>
        ${next?`${pzPctBar(f.value/b.need,PZ_TIER_COL[b.r])}<small>${pzN(Math.floor(f.value))} / ${pzN(b.need)}</small>`
          :after?`${pzPctBar(f.value/after.need,PZ_TIER_COL[after.r])}<small title="Next: ${PZ_TIERS[after.r]}">${pzN(Math.floor(f.value))} / ${pzN(after.need)}</small>`
          :`<small>${f?'all tiers earned':esc(dayLabel(b.k).replace(/^\w+, /,''))}</small>`}</button>`).join('')}</div></section>`; }).join('');
  const hiddenN=cat.hidden;
  // sharing: the public page is opt-in under What you share
  const me=SOC.me, pageOn=!!(me&&SOC.share&&SOC.share.page);
  const link=me&&/^https?:$/.test(location.protocol)?location.origin+'/b/'+me.handle:null;
  const shareCard=`<section class="pz-card pz-kv pz-span"><div class="pz-kvrow"><b class="pz-kvh">Show off your badge case</b></div>
    ${!me?'<p class="pz-sub" style="font-size:13px">Create your profile under Social to get a public badge page you can share.</p>'
      :pageOn?`<p class="pz-sub" style="font-size:13px">Your public page: <a href="${esc(link)}" target="_blank" rel="noopener">${esc(link.replace(/^https?:\/\//,''))}</a></p><div style="display:flex;gap:8px;flex-wrap:wrap"><button type="button" class="pz-cta pz-sm" id="pzBadgeLink" style="width:auto;padding:0 18px">Share my badge page</button><button type="button" class="pz-ghost pz-sm" id="pzBadgeImg" style="width:auto;padding:0 16px">Badge card image</button><button type="button" class="pz-ghost pz-sm" data-pz-page="0" style="width:auto;padding:0 16px">Make it private</button></div>`
      :`<p class="pz-sub" style="font-size:13px">Turn on a public page with your badges, level and streak — no trades, no P&amp;L, no wallet. Anyone with the link can see it.</p><div style="display:flex;gap:8px;flex-wrap:wrap"><button type="button" class="pz-cta pz-sm" data-pz-page="1" style="width:auto;padding:0 18px">Create my public badge page</button><button type="button" class="pz-ghost pz-sm" id="pzBadgeImg" style="width:auto;padding:0 16px">Badge card image</button></div>`}</section>`;
  const pct=cat.total?cat.earned.length/cat.total:0;
  return `${back}${pzHead(cat.earned.length+' of '+cat.total+' earned','Badge case')}
    <div class="pz-wide"><div class="pz-span pz-bprog">${pzPctBar(pct,PZ_TIER_COL[2])}<span class="pz-sub" style="font-size:12px">${hiddenN?`${hiddenN} more to discover — new families appear as your case fills. `:''}Hover or tap a badge to see what it’s for.</span></div>
    <div class="pz-span">${chips}</div>${info?`<div class="pz-span">${info}</div>`:''}${grid}${shareCard}
    <div class="pz-span" id="gmOut"></div></div>`;
}
async function pzBadgeCardImage(){
  const g=gameContext(), cat=g.catalog; if(!cat){ pzNote('Your badges couldn’t be read just now — try again in a moment.','err'); return; }
  const top=[...cat.earned].sort((a,b)=>b.r-a.r||(a.k<b.k?1:-1)).slice(0,8);
  const blob=await drawCardPng({w:1200,minH:700,kicker:'Keel · badge case',title:(SOC.me?'@'+SOC.me.handle:'My')+' — '+cat.earned.length+' badges',
    sub:'Level '+g.level.level+' · '+g.level.title+' · '+g.streak.current+'-day discipline streak',
    big:[['Badges',cat.earned.length+'/'+cat.total],['Level',g.level.level],['Best streak',g.streak.best]],
    rows:top.map(b=>[b.t,PZ_TIERS[b.r],b.r>=2?'gold':null]),foot:'Keel · earned by process, not profit'});
  showCardOut(blob,'keel-badges',(SOC.me?'@'+SOC.me.handle+' ':'')+'— '+cat.earned.length+' badges on Keel, earned by process.\n'+top.slice(0,5).map(b=>'• '+b.t).join('\n'),false);
}
// ---- setups: one spelling per setup, so the stats by setup add up ----
function pzSetups(){ const n={}, canon={};
  for(const id in journal){ const s=journal[id]&&typeof journal[id].setup==='string'?journal[id].setup.trim().replace(/\s+/g,' '):''; if(!s||id.includes(':'))continue;
    const k=s.toLowerCase(); n[k]=(n[k]||0)+1; if(!canon[k])canon[k]=s; }
  // playbooks first: their names are the setups with written rules
  const pbs=(typeof pbList==='function'?pbList():[]).map(p=>p.name), seen=new Set(pbs.map(x=>x.toLowerCase()));
  return [...pbs,...Object.keys(n).sort((a,b)=>n[b]-n[a]).filter(k=>!seen.has(k)).map(k=>canon[k])]; }
function pzCanonSetup(s){ s=String(s||'').trim().replace(/\s+/g,' '); if(!s)return ''; const hit=pzSetups().find(x=>x.toLowerCase()===s.toLowerCase()); return hit||s; }

// ---- plan rules: a plan you can check. Each rule is graded from the day's fills at the end of the day ----
const PZ_RULE_LABEL={setups:'Only my setups',coins:'Only these markets',until:'No new trades after',maxPos:'Max position size',stop2:'Stop after two losses in a row',
  lossStreak:'Stop after losses in a row',wait:'Wait after a loss',noAdd:'Never add to a losing position'};
// setups most traders recognise, offered until your own tags take over
const PZ_SETUP_DEFAULTS=['Breakout','Pullback','Trend continuation','Range fade','Reversal','News'];
function pzPlanCheck(key){
  const e=journal['day:'+key]||{}, R=e.rules||{}, out=[];
  const opened=allTrades.filter(t=>t.openTime&&dayKey(t.openTime)===key), closedD=(gameContext().ctx.byDay||{})[key]||[];
  const add=(k,ok,detail)=>out.push({k,label:PZ_RULE_LABEL[k],ok,detail}), lab=(k,label,ok,detail)=>out.push({k,label,ok,detail});
  if(Array.isArray(R.setups)&&R.setups.length){ const want=new Set(R.setups.map(s=>s.toLowerCase())), tagged=opened.filter(t=>journal[t.id]&&journal[t.id].setup);
    const off=tagged.filter(t=>!want.has(String(journal[t.id].setup).trim().toLowerCase())), un=opened.length-tagged.length;
    add('setups',!opened.length?null:off.length?false:un?null:true,R.setups.join(', ')+(off.length?' — '+off.length+' trade'+(off.length===1?'':'s')+' outside them':'')+(un?' · '+un+' not tagged yet':'')); }
  if(/^\d{2}:\d{2}$/.test(R.until||'')){ const [h,m]=R.until.split(':').map(Number), late=opened.filter(t=>{ const p=tzParts(t.openTime); return p.h*60+p.min>h*60+m; });
    add('until',!opened.length?null:!late.length,R.until+(late.length?' — '+late.length+' entr'+(late.length===1?'y':'ies')+' after':'')); }
  if(R.maxPos>0){ const big=opened.filter(t=>Math.abs((+t.maxSize||0)*(+t.avgEntry||0))>R.maxPos*1.001);
    add('maxPos',!opened.length?null:!big.length,usdPlain(R.maxPos)+(big.length?' — '+big.length+' trade'+(big.length===1?'':'s')+' bigger':'')); }
  // stop after N losses in a row (the older two-loss switch is the same rule with N=2)
  const N=R.lossStreak>1?+R.lossStreak:R.stop2?2:0;
  if(N){ const cl=closedD.slice().sort((a,b)=>a.closeTime-b.closeTime); let run=0, hitAt=null;
    for(const x of cl){ run=PZ_LOSS(x.net)?run+1:0; if(run>=N&&hitAt==null)hitAt=x.closeTime; }
    const after=hitAt==null?[]:opened.filter(t=>t.openTime>hitAt);
    lab('lossStreak','Stop after '+N+' losses in a row',hitAt==null?(cl.length?true:null):!after.length,hitAt==null?'':after.length?after.length+' entr'+(after.length===1?'y':'ies')+' after the '+N+'th loss':'stopped when it happened'); }
  if(R.wait>0){ const M=R.wait*60000, losses=closedD.filter(x=>PZ_LOSS(x.net));
    const quick=opened.filter(t=>losses.some(x=>t.openTime>x.closeTime&&t.openTime-x.closeTime<=M));
    lab('wait','Wait '+R.wait+' min after a loss',!losses.length?null:!quick.length,quick.length?quick.length+' entr'+(quick.length===1?'y':'ies')+' within '+R.wait+' min of a loss':losses.length+' loss'+(losses.length===1?'':'es')+', no rushed re-entry'); }
  if(R.noAdd){ const b=_pzSlipDays.get(key), n=b&&b.flags?b.flags.addLoser||0:0;
    add('noAdd',!opened.length&&!closedD.length?null:!n,n?n+' trade'+(n===1?'':'s')+' added to while losing':''); }
  const graded=out.filter(x=>x.ok!=null);
  return {rules:out,kept:graded.filter(x=>x.ok).length,graded:graded.length};
}
function pzRulesFormHtml(ck){
  const R=ck.rules||{}, mine=pzSetups().slice(0,8), chosen=Array.isArray(R.setups)?R.setups:[];
  const setups=[...new Set([...chosen,...mine,...(mine.length<4?PZ_SETUP_DEFAULTS:[])])].slice(0,14);
  const seg=(k,opts,cur)=>`<div class="pz-seg pz-rseg" role="group" aria-label="${esc(PZ_RULE_LABEL[k])}">${opts.map(([v,l])=>`<button type="button" data-pz-rule="${k}" data-v="${v}" aria-pressed="${String(cur||0)===String(v)}">${l}</button>`).join('')}</div>`;
  const N=R.lossStreak>1?+R.lossStreak:R.stop2?2:0;
  const row=(label,hint,ctl)=>`<div class="pz-rrow"><span><b>${label}</b>${hint?`<small>${hint}</small>`:''}</span>${ctl}</div>`;
  const nSet=(chosen.length?1:0)+(N?1:0)+(R.wait>0?1:0)+(R.noAdd?1:0)+(/^\d{2}:\d{2}$/.test(R.until||'')?1:0)+(R.maxPos>0?1:0);
  return `<details class="pz-card pz-kv pz-rules"${pzS.rulesOpen?' open':''}><summary><b class="pz-kvh">Rules for today</b><span class="pz-sub" style="font-size:12px">${nSet?nSet+' set':'none yet'} · checked from your fills</span></summary>
    ${row(PZ_RULE_LABEL.setups,'Trades tagged with anything else count as off-plan',`<div class="pz-chiprow pz-wrapr">${setups.map(x=>`<button type="button" class="pz-chipbtn" data-pz-rule="setups" data-v="${esc(x)}" aria-pressed="${chosen.includes(x)}">${esc(x)}</button>`).join('')}</div>
      <div class="pz-addrow"><label for="pzSetupAdd" class="pz-sr">Add a setup</label><input type="text" id="pzSetupAdd" maxlength="40" placeholder="Add your own setup" autocomplete="off"><button type="button" class="pz-ghost pz-sm" id="pzSetupAddGo">Add</button></div>`)}
    ${row(PZ_RULE_LABEL.lossStreak,'',seg('lossStreak',[[0,'Off'],[2,'2'],[3,'3']],N))}
    ${row(PZ_RULE_LABEL.wait,'Before the next entry',seg('wait',[[0,'Off'],[15,'15m'],[30,'30m'],[60,'1h']],R.wait||0))}
    <div class="pz-toggle"><span style="flex:1"><b id="pzNoAddL">${PZ_RULE_LABEL.noAdd}</b></span><button type="button" role="switch" class="pz-switch" data-pz-rule="noAdd" aria-checked="${!!R.noAdd}" aria-labelledby="pzNoAddL"><i></i></button></div>
    <div class="pz-grid2"><div class="pz-field"><label for="pzUntil" style="font-size:13px">${PZ_RULE_LABEL.until}</label><input type="time" id="pzUntil" value="${esc(R.until||'')}"></div>
      <div class="pz-field"><label for="pzMaxPos" style="font-size:13px">${PZ_RULE_LABEL.maxPos} ($)</label><input type="number" id="pzMaxPos" inputmode="decimal" min="0" step="any" value="${R.maxPos>0?esc(R.maxPos):''}"></div></div></details>`;
}
document.addEventListener('toggle',ev=>{ if(ev.target&&ev.target.classList&&ev.target.classList.contains('pz-rules'))pzS.rulesOpen=ev.target.open; },true);

// ---- the end-of-day review (#review) ----
function pzReviewInit(D){
  if(pzS.rv&&pzS.rv.key===D.todayK)return pzS.rv;
  const e=(journal['day:'+D.todayK]||{}).eod||{};
  pzS.rv={key:D.todayK,rating:e.rating||null,answers:Object.assign({},e.answers||{}),lesson:e.lesson||'',tomorrow:e.tomorrow||''};
  return pzS.rv;
}
function pzReviewHtml(D){
  const back=`<a class="pz-back" href="#today">${pzI('back',20)}Today</a>`;
  const lock=pzLocked('review',D.g.level.level);
  if(lock)return `${back}${pzLockedHtml('End-of-day review',lock,D.g)}`;
  const rv=pzReviewInit(D), prof=pzProfile(D.ctx.closed), day=D.day, risk=D.risk, pc=pzPlanCheck(D.todayK);
  const saved=!!((journal['day:'+D.todayK]||{}).eod||{}).at;
  const slips=day?(day.behavior.slips||[]):[];
  const tByid=new Map(D.todayTrades.map(t=>[t.id,t]));
  const summary=`<section class="pz-card pz-kv"><b class="pz-kvh">Your day in numbers</b>
    <div class="pz-grid3"><div class="pz-tile"><span class="pz-t">Discipline</span><span class="pz-n" style="color:${day?PZ_COL[pzBand(day.score)]:'var(--pz-muted)'}">${day?day.score:'—'}</span></div>
      <div class="pz-tile"><span class="pz-t">P&amp;L</span><span class="pz-n" style="color:${risk.net>0?PZ_COL.good:risk.net<0?PZ_COL.low:'var(--pz-text)'}" title="${esc(signedPlain(risk.net))}">${risk.closed.length?esc(pzSigned(risk.net)):'—'}</span></div>
      <div class="pz-tile"><span class="pz-t">Trades</span><span class="pz-n">${risk.trades}${risk.cap>0?'<small style="font-size:14px;color:var(--pz-muted)"> / '+risk.cap+'</small>':''}</span></div></div>
    ${slips.length?slips.map(s=>{ const t=tByid.get(s.id); return `<div class="pz-row-t"><span>${t?esc(dispMarket(dcoin(t)))+' · '+esc(String(t.dir||'').toLowerCase())+' · ':''}${esc(s.f.map(k=>PZ_BEH[k]).join(', '))}</span><b style="color:${s.net<0?PZ_COL.low:PZ_COL.good}">${esc(pzSigned(s.net))}</b></div>`; }).join('')
      :day?'<p class="pz-sub" style="font-size:13px">No slips today — every closed trade was clean.</p>':'<p class="pz-sub" style="font-size:13px">No closed trades today.</p>'}
    ${risk.limit>0?`<div class="pz-row-t"><span>Loss limit ${esc(usdPlain(risk.limit))}</span><b style="color:${risk.loss>=risk.limit?PZ_COL.low:PZ_COL.good}">${risk.loss>=risk.limit?'hit':'kept'}</b></div>`:''}
    ${pc.rules.length?`<span class="pz-lbl" style="color:var(--pz-muted);font-size:11px;margin-top:4px">Your rules · ${pzRuleTally(pc)}</span>${pc.rules.map(r=>`<div class="pz-part"><span class="pz-pc ${r.ok===true?'full':r.ok===false?'miss':''}" style="${r.ok==null?'background:var(--pz-card2);color:var(--pz-muted)':''}">${pzI(r.ok===true?'check':r.ok===false?'x':'minus',14,3)}</span><span class="pz-pt"><b>${esc(r.label)}</b><span>${esc(r.detail||'')}</span></span></div>`).join('')}`:''}
    ${D.inbox.length?`<a class="pz-next" href="#journal">${D.inbox.length} trade${D.inbox.length===1?'':'s'} to journal first ${pzI('chev',16)}</a>`:''}</section>`;
  const qs=prof.eod.map((q,i)=>`<div class="pz-field"><label for="pzRvQ${i}" style="font-size:14px">${esc(q)}</label><textarea id="pzRvQ${i}" rows="2" data-pz-rvq="${esc(q)}">${esc(rv.answers[q]||'')}</textarea></div>`).join('');
  const rating=`<div role="radiogroup" aria-labelledby="pzRvRate"><p class="pz-q" id="pzRvRate">How well did you trade your plan today?</p><div class="pz-pills">${[1,2,3,4,5].map(n=>`<button type="button" role="radio" class="pz-pill" data-pz-rvrate="${n}" aria-checked="${rv.rating===n}">${n}</button>`).join('')}</div></div>`;
  const coachOk=SOC.me&&SOC.me.coach&&SOC.me.coach.allowed||(SRV.token&&!SRV.badAuth);
  return `${back}${pzHead(dayLabel(D.todayK)+' · '+prof.name,'End-of-day review')}
  <p class="pz-sub" style="margin-top:-6px">Five minutes. What happened, what you learned, one thing for tomorrow.</p>
  <div class="pz-wide"><div class="pz-col">${summary}${socNotesHtml()}</div>
    <div class="pz-col"><section class="pz-card pz-kv">${rating}${qs}
      <div class="pz-field"><label for="pzRvLesson" style="font-size:14px">Today’s lesson, in one line</label><input type="text" id="pzRvLesson" maxlength="200" value="${esc(rv.lesson)}"></div>
      <div class="pz-field"><label for="pzRvTomorrow" style="font-size:14px">One focus for tomorrow</label><input type="text" id="pzRvTomorrow" maxlength="160" value="${esc(rv.tomorrow)}" placeholder="It shows in tomorrow’s prep"></div></section>
      <button type="button" class="pz-cta" id="pzRvSave">${saved?'Update my review':'Save my review'} ${saved||!day?'':`<span class="pz-xpb">+${pzXpCfg().review} XP</span>`}</button>
      ${coachOk&&pzCoachAvailable()?'<button type="button" class="pz-ghost" id="pzRvCoach">Ask the coach to review my day</button>':''}
      <p class="pz-fine">Questions for a ${esc(prof.name.toLowerCase())} — <button type="button" class="pz-linkbtn" data-pz-sheet style="display:inline;min-height:0;padding:0">change your profile</button>.</p></div></div>`;
}
// what's typed in the review is kept as it's typed, so a re-render (opening the profile sheet, a
// background refresh) doesn't wipe it
document.addEventListener('input',ev=>{ const el=ev.target, rv=pzS.rv; if(!rv||!el||!el.dataset)return;
  if(el.dataset.pzRvq!=null)rv.answers[el.dataset.pzRvq]=el.value; else if(el.id==='pzRvLesson')rv.lesson=el.value; else if(el.id==='pzRvTomorrow')rv.tomorrow=el.value; });
async function pzSaveReview(){
  const rv=pzS.rv; if(!rv)return;
  document.querySelectorAll('[data-pz-rvq]').forEach(el=>{ rv.answers[el.dataset.pzRvq]=el.value.trim(); });
  rv.lesson=($('pzRvLesson')||{value:''}).value.trim(); rv.tomorrow=($('pzRvTomorrow')||{value:''}).value.trim();
  const k='day:'+rv.key, e={...(journal[k]||{})};
  const answers={}; for(const q in rv.answers)if(rv.answers[q])answers[q]=rv.answers[q].slice(0,1000);
  e.eod={at:Date.now(),rating:rv.rating||null,answers,lesson:rv.lesson.slice(0,200),tomorrow:rv.tomorrow.slice(0,160),profile:pzProfile(gameContext().ctx.closed).id};
  e.updatedAt=Date.now(); journal[k]=e; markJEdit(k); await Store.set(J_KEY,journal);
  pzNote('Review saved. Tomorrow’s focus: '+(rv.tomorrow||'—'));
  pzS.rv=null; location.hash='#today';
}

// ---- report cards (#report): a week or a month ----
function pzReportHtml(D){
  const {g}=D, back=`<a class="pz-back" href="#progress">${pzI('back',20)}Progress</a>`;
  const lock=pzLocked('reports',g.level.level); if(lock)return `${back}${pzLockedHtml('Report cards',lock,g)}`;
  const kind=pzS.rk==='month'?'month':'week', keys=pzPeriods(g,kind);
  if(!keys.length)return `${back}${pzHead('Report cards','Nothing to grade yet')}<p class="pz-sub">Your first report card appears after your first trading day.</p>`;
  const key=keys.includes(pzS.rkey)?pzS.rkey:keys[keys.length-1], i=keys.indexOf(key), r=pzReport(g,kind,key);
  const label=kind==='week'?'Week '+key.slice(-2)+' · '+dayLabel(pzPeriodOf('week',key).lo).replace(/^\w+, /,'')+' – '+dayLabel(pzPeriodOf('week',key).hi).replace(/^\w+, /,''):MONTHS[+key.slice(5)-1]+' '+key.slice(0,4);
  const gc=gr=>gr==='A'||gr==='B'?PZ_COL.good:gr==='C'?PZ_COL.mid:PZ_COL.low;
  const seg=`<div class="pz-seg" role="group" aria-label="Period"><button type="button" data-pz-rk="week" aria-pressed="${kind==='week'}">Week</button><button type="button" data-pz-rk="month" aria-pressed="${kind==='month'}">Month</button></div>`;
  const nav=`<div class="pz-kvrow pz-span"><button type="button" class="pz-chip icon" data-pz-rkey="${esc(keys[i-1]||'')}"${i>0?'':' disabled'} aria-label="Previous">${pzI('back',18)}</button><b style="font-size:15px">${esc(label)}</b><button type="button" class="pz-chip icon" data-pz-rkey="${esc(keys[i+1]||'')}"${i<keys.length-1?'':' disabled'} aria-label="Next" style="transform:scaleX(-1)">${pzI('back',18)}</button></div>`;
  const slipRows=Object.keys(PZ_BEH).filter(k=>r.slips[k]||r.prevSlips[k]).map(k=>{ const a=(r.slips[k]||{}).n||0, b=(r.prevSlips[k]||{}).n||0;
    return `<div class="pz-row-t"><span>${esc(PZ_BEH[k])}</span><b>${a}${r.prevKey?` <small style="color:${a<b?PZ_COL.good:a>b?PZ_COL.low:'var(--pz-muted)'};font-weight:600">${a<b?'▼':a>b?'▲':'='}${b}</small>`:''}</b></div>`; }).join('');
  const leakTxt=r.leak?PZ_BEH[r.leak]+' cost '+pzSigned(r.slips[r.leak].cost)+' over '+r.slips[r.leak].n+' trade'+(r.slips[r.leak].n===1?'':'s'):null;
  const focus=r.leak&&!pzPlugs().some(p=>p.slip===r.leak&&!p.dropped&&!p.done)?{t:'Plug “'+PZ_BEH[r.leak].toLowerCase()+'”',btn:`<button type="button" class="pz-ghost pz-sm" data-pz-plug="${esc(r.leak)}" style="width:auto;padding:0 14px">Plug it</button>`}
    :r.challenge&&r.challenge.status==='missed'?{t:'Give the challenge another week: '+habitSentence(r.challenge.ch.spec).replace(/^./,c=>c.toLowerCase()),btn:''}
    :r.challenge&&r.challenge.status==='on track'?{t:'Finish the challenge: '+habitSentence(r.challenge.ch.spec).replace(/^./,c=>c.toLowerCase()),btn:''}
    :((g.ctx.findings||[]).find(f=>f.tone==='leak'||f.tone==='caution'))?{t:pzPlain((g.ctx.findings.find(f=>f.tone==='leak'||f.tone==='caution')).action),btn:''}:{t:'Keep doing what you did — repeat your best day’s routine.',btn:''};
  return `${back}${pzHead('Report card','Graded on process',seg)}
  <div class="pz-wide">${nav}
    <section class="pz-card pz-span pz-rhead"><span class="pz-grade-big" style="color:${gc(r.grade)};border-color:${gc(r.grade)}">${r.grade}</span>
      <span style="flex:1;min-width:0"><b style="font-size:18px">Process ${Math.round(r.avg)}/100${r.delta!=null?` <small style="color:${r.delta>=0?PZ_COL.good:PZ_COL.low}">${r.delta>=0?'▲':'▼'} ${Math.abs(Math.round(r.delta))} vs the ${kind} before</small>`:''}</b>
      <span class="pz-sub" style="display:block;font-size:13px">${r.good} of ${r.days} trading days at 70+ · ${r.clean} clean · +${r.xp.toLocaleString()} XP${r.badges.length?' · '+r.badges.length+' badge'+(r.badges.length===1?'':'s'):''}</span></span></section>
    <div class="pz-col">
      <section class="pz-card pz-kv"><b class="pz-kvh">Results</b>
        <div class="pz-row-t"><span>Net P&amp;L</span><b style="color:${r.net>=0?PZ_COL.good:PZ_COL.low}" title="${esc(signedPlain(r.net))}">${esc(pzSigned(r.net))}</b></div>
        <div class="pz-row-t"><span>Trades · win rate</span><b>${r.trades} · ${pzPct(r.winRate)}</b></div>
        <div class="pz-row-t"><span>Profit factor</span><b>${pzRatio(r.pf)}</b></div>
        <div class="pz-row-t"><span>Green days</span><b>${r.greenDays} of ${r.days}</b></div>
        <div class="pz-row-t"><span>Best day (process)</span><b>${esc(dayLabel(r.bestDay.key))} · ${r.bestDay.score}</b></div>
        ${r.worstDay.key!==r.bestDay.key&&r.worstDay.score<r.bestDay.score?`<div class="pz-row-t"><span>Toughest day</span><b>${esc(dayLabel(r.worstDay.key))} · ${r.worstDay.score}</b></div>`:''}</section>
      <section class="pz-card pz-kv"><b class="pz-kvh">Slips${r.prevKey?' <span class="pz-sub" style="font-weight:400;font-size:12px">· vs the '+kind+' before</span>':''}</b>${slipRows||'<p class="pz-sub" style="font-size:13px">No slips. A clean '+kind+'.</p>'}${leakTxt?`<p class="pz-fine">Costliest: ${esc(leakTxt)}.</p>`:''}</section>
      ${r.parts.length?`<section class="pz-card pz-kv"><b class="pz-kvh">Process grades</b>${r.parts.map(p=>`<div class="pz-row-t"><span>${esc(p.name)}</span><b style="color:${gc(p.grade)}">${p.grade} · ${Math.round(p.value*100)}%</b></div>`).join('')}</section>`:''}
    </div>
    <div class="pz-col">
      <section class="pz-card pz-kv"><b class="pz-kvh">Routines</b>
        <div class="pz-row-t"><span>Days prepped</span><b>${r.checkins} of ${r.days}</b></div><div class="pz-row-t"><span>Plans before the first trade</span><b>${r.plans} of ${r.days}</b></div>
        <div class="pz-row-t"><span>End-of-day reviews</span><b>${r.reviews} of ${r.days}</b></div><div class="pz-row-t"><span>Trades journaled</span><b>${pzPct(r.journaled)}</b></div></section>
      ${r.habits.length?`<section class="pz-card pz-kv"><b class="pz-kvh">Habits</b>${r.habits.map(h=>`<div class="pz-row"><div class="pz-row-t"><span>${esc(h.name)}</span><b>${h.kept}/${h.total}</b></div>${pzBar(h.kept/h.total,h.kept===h.total?PZ_COL.good:PZ_COL.mid)}
        ${h.broke.length?`<span class="pz-fine">Broken on ${h.broke.map(b=>esc(dayLabel(b.key).replace(/,.*/,''))+(b.ready!=null?' (readiness '+b.ready+')':'')).join(', ')}</span>`:''}</div>`).join('')}</section>`:''}
      ${r.challenge?`<section class="pz-card pz-kv"><b class="pz-kvh">Weekly challenge</b><span class="pz-sub" style="font-size:13px">${esc(habitSentence(r.challenge.ch.spec))} — <b style="color:${r.challenge.status==='done'?PZ_COL.good:PZ_COL.mid}">${esc(r.challenge.status)}</b></span></section>`:''}
      <section class="pz-card pz-kv"><b class="pz-kvh">Focus for next ${kind}</b><span style="font-size:14px;line-height:1.45">${esc(focus.t)}</span>${focus.btn}</section>
      ${r.badges.length?`<section class="pz-card pz-kv"><b class="pz-kvh">Badges earned</b><div class="pz-medals">${r.badges.slice(-6).map(b=>`<span class="pz-mini" tabindex="0" data-pz-tip="${esc(pzBadgeTip(b))}">${pzMedal(b,40)}<span>${esc(b.t.replace(/ · .*/,''))}</span></span>`).join('')}</div></section>`:''}
    </div>
    <section class="pz-span" style="display:flex;gap:8px;flex-wrap:wrap">${pzLocked('share',g.level.level)?'':`<button type="button" class="pz-ghost pz-sm" id="pzReportShare" style="width:auto;padding:0 16px">Share this report card</button>`}</section>
    <div class="pz-span" id="gmOut"></div></div>`;
}
async function pzShareReport(){
  const g=gameContext(), kind=pzS.rk==='month'?'month':'week', keys=pzPeriods(g,kind), key=keys.includes(pzS.rkey)?pzS.rkey:keys[keys.length-1], r=pzReport(g,kind,key); if(!r)return;
  const label=kind==='week'?'week '+key:MONTHS[+key.slice(5)-1]+' '+key.slice(0,4);
  const rows=[...Object.keys(PZ_BEH).filter(k=>r.slips[k]).map(k=>[PZ_BEH[k],String(r.slips[k].n),'bad']),...r.habits.slice(0,3).map(h=>[h.name.slice(0,48),h.kept+'/'+h.total,h.kept===h.total?'good':null])].slice(0,7);
  const blob=await drawCardPng({w:1080,minH:720,kicker:'Keel · report card',title:label+' · grade '+r.grade,sub:'Process '+Math.round(r.avg)+'/100 · '+r.good+' of '+r.days+' days at 70+ · '+r.clean+' clean',
    big:[['Grade',r.grade],['Process',Math.round(r.avg)],['XP',r.xp]],rows,foot:'Keel · graded on process, not profit'});
  showCardOut(blob,'keel-report-'+key,'Keel '+label+' report card: '+r.grade+' · process '+Math.round(r.avg)+'/100 · '+r.good+'/'+r.days+' good days',await shareAvailable());
}
// ---- "Share my week": an image of your process, with no dollar amounts or P&L, on purpose ----
// src: {from, to, days:[{key,score}], streak:{current,best}, level:{level,title}, xpByDay, badges, duel:{w,l,d}}
// show: {level, duel, badges}, each on unless false. Pure: the card draws only what this returns.
function pzWeekCardModel(src, show){
  show=show||{}; const inW=k=>k>=src.from&&k<=src.to, days=(src.days||[]).filter(d=>d&&inW(d.key));
  const xp=Object.keys(src.xpByDay||{}).filter(inW).reduce((a,k)=>a+(+src.xpByDay[k]||0),0);
  // badges for results are about money: never on this card
  const earned=(src.badges||[]).filter(b=>b&&b.k&&b.t&&b.c!=='results'), rank=(a,b)=>(b.r||0)-(a.r||0)||(a.k<b.k?1:a.k>b.k?-1:0);
  const wk=earned.filter(b=>inW(b.k)).sort(rank), top=wk.concat(earned.filter(b=>!inW(b.k)).sort(rank)).slice(0,3);
  const d=src.duel, st=src.streak||{};
  return {from:src.from,to:src.to,discipline:days.length?Math.round(days.reduce((a,x)=>a+(+x.score||0),0)/days.length):null,
    cleanDays:days.filter(x=>x.score>=70).length,tradingDays:days.length,streak:{current:+st.current||0,best:+st.best||0},
    level:show.level===false||!src.level?null:{level:+src.level.level||1,title:String(src.level.title||''),xp:Math.round(xp)},
    duel:show.duel===false||!d||!((+d.w||0)+(+d.l||0)+(+d.d||0))?null:{w:+d.w||0,l:+d.l||0,d:+d.d||0},
    badges:show.badges===false?[]:top.map(b=>({name:String(b.t).replace(/ · .*/,''),tier:Math.max(0,Math.min(5,+b.r||0)),isNew:inW(b.k)}))};
}
// this week on your clock, or last week when this one has no trading yet
function pzWeekCardSrc(g){
  const mon=isoWeekMondayKey(isoWeekOfKey(dayKey(Date.now()))); let from=mon, to=pzAddDays(mon,6);
  if(!g.days.some(d=>d.key>=from&&d.key<=to)){ from=pzAddDays(mon,-7); to=pzAddDays(mon,-1); }
  const c=SOC.me&&socDuelsOn()?socDuels():null;
  return {from,to,days:g.days,streak:g.streak,level:g.level,xpByDay:g.xp.byDay,badges:g.catalog?g.catalog.earned:[],duel:c&&c.d?c.d.record:null};
}
// fmt: 'portrait' (1080×1350) or 'square' (1080×1080); theme: 'dark' or 'light'
function pzWeekCardDraw(m, fmt, theme){
  const sq=fmt==='square', W=1080, H=sq?1080:1350, P=72, L=theme==='light';
  const C=Object.assign({},L?PZ_COL_LIGHT:PZ_COL_DARK,L?{bg:'#F3F5F8',card:'#FFFFFF',line:'#E1E5EB',text:'#111821',muted:'#56606E',track:'#E4E8EE'}:{bg:'#0A0C0F',card:'#14171C',line:'#1F242B',text:'#F3F5F7',muted:'#A1AAB5',track:'#262B33'});
  const cv=document.createElement('canvas'); cv.width=W; cv.height=H; const x=cv.getContext('2d');
  const F=(w,s,fam)=>w+' '+s+'px '+(fam==='n'?'"Barlow Condensed", "Arial Narrow", sans-serif':'Inter, system-ui, sans-serif');
  const text=(s,tx,ty,font,col,align,maxW)=>{ x.font=font; x.fillStyle=col; x.textAlign=align||'left';
    if(maxW){ let sz=+/(\d+)px/.exec(font)[1]; while(sz>12&&x.measureText(s).width>maxW){ sz-=2; x.font=font.replace(/\d+px/,sz+'px'); } }
    x.fillText(s,tx,ty); };
  const box=(bx,by,bw,bh,r)=>{ x.beginPath(); x.moveTo(bx+r,by); x.arcTo(bx+bw,by,bx+bw,by+bh,r); x.arcTo(bx+bw,by+bh,bx,by+bh,r); x.arcTo(bx,by+bh,bx,by,r); x.arcTo(bx,by,bx+bw,by,r); x.closePath(); };
  const ring=(cx,cy,r,lw,p,col)=>{ x.lineCap='round'; x.lineWidth=lw; x.strokeStyle=C.track; x.beginPath(); x.arc(cx,cy,r,0,2*Math.PI); x.stroke();
    if(p>0){ x.strokeStyle=col; x.beginPath(); x.arc(cx,cy,r,-Math.PI/2,-Math.PI/2+2*Math.PI*Math.min(1,p)); x.stroke(); } };
  x.fillStyle=C.bg; x.fillRect(0,0,W,H);
  const glow=x.createRadialGradient(W*0.85,H*0.08,0,W*0.85,H*0.08,W*0.7); glow.addColorStop(0,C.good+(L?'22':'2A')); glow.addColorStop(1,C.good+'00'); x.fillStyle=glow; x.fillRect(0,0,W,H);
  // the brand mark and the week
  ring(P+22,P+24,19,7,0.72,C.good); text('Keel',P+58,P+38,F(600,40),C.text);
  const md=k=>MONTHS[+k.slice(5,7)-1]+' '+(+k.slice(8));
  text('Week of '+md(m.from)+' – '+md(m.to),W-P,P+36,F(500,28),C.muted,'right',W-2*P-240);
  // Discipline, the week's average, as the big ring
  const band=m.discipline==null?'none':m.discipline>=70?'good':m.discipline>=40?'mid':'low', col=C[band]||C.track;
  const cx=sq?P+200:W/2, cy=sq?470:420, r=sq?170:200;
  ring(cx,cy,r,sq?30:34,(m.discipline||0)/100,col);
  text(m.discipline==null?'—':String(m.discipline),cx,cy+(sq?48:56),F(600,sq?150:176,'n'),C.text,'center');
  text('DISCIPLINE',cx,cy+r+(sq?64:72),F(600,26),C.muted,'center'); text('week average',cx,cy+r+(sq?100:108),F(400,26),C.muted,'center');
  // the tiles: clean days, streak, then level and duels if shown
  const tiles=[['Clean days',m.cleanDays+' of '+m.tradingDays,'trading days at 70+'],['Streak',m.streak.current+' day'+(m.streak.current===1?'':'s'),'best '+m.streak.best]];
  if(m.level)tiles.push(['Level',String(m.level.level),m.level.title+' · +'+m.level.xp.toLocaleString('en-US')+' XP']);
  if(m.duel)tiles.push(['Duels',m.duel.w+'–'+m.duel.l+(m.duel.d?'–'+m.duel.d:''),'won–lost'+(m.duel.d?'–drawn':'')]);
  const tile=(t,tx,ty,tw,th)=>{ box(tx,ty,tw,th,22); x.fillStyle=C.card; x.fill(); x.lineWidth=2; x.strokeStyle=C.line; x.stroke();
    text(t[0].toUpperCase(),tx+28,ty+44,F(600,22),C.muted,'left',tw-56); text(t[1],tx+28,ty+(sq?100:110),F(600,sq?56:64,'n'),C.text,'left',tw-56);
    text(t[2],tx+28,ty+th-24,F(400,22),C.muted,'left',tw-56); };
  let by;
  if(sq){ const tx=P+440, tw=W-P-tx, th=(820-170-16*3)/4; tiles.forEach((t,i)=>tile(t,tx,170+i*(th+16),tw,th)); by=870; }
  else { const tw=(W-2*P-24)/2, th=168, ty=cy+r+136; tiles.forEach((t,i)=>tile(t,P+(i%2)*(tw+24),ty+Math.floor(i/2)*(th+24),tw,th)); by=ty+Math.ceil(tiles.length/2)*(th+24)+8; }
  // top badges, as medals in their tier's colour
  if(m.badges.length){ const bw=(W-2*P)/3;
    m.badges.forEach((b,i)=>{ const mx=P+i*bw+44, my=by+44, tc=PZ_TIER_COL[b.tier];
      x.beginPath(); x.arc(mx,my,40,0,2*Math.PI); x.fillStyle=tc+(L?'33':'2E'); x.fill(); x.lineWidth=5; x.strokeStyle=tc; x.stroke();
      text(PZ_TIERS[b.tier].charAt(0),mx,my+13,F(600,36,'n'),L?C.text:tc,'center');
      text(b.name,mx+56,my-4,F(600,24),C.text,'left',bw-110); text(PZ_TIERS[b.tier]+(b.isNew?' · new':''),mx+56,my+28,F(400,22),C.muted,'left',bw-110); }); }
  text('Graded on process, not profit.',P,H-48,F(400,24),C.muted);
  return cv;
}
async function pzWeekCardBlob(m, fmt, theme){
  try{ if(document.fonts&&document.fonts.ready)await document.fonts.ready; }catch(e){}
  const cv=pzWeekCardDraw(m,fmt,theme); return await new Promise(res=>cv.toBlob(res,'image/png'));
}
// the panel on Progress: a preview, what to show, and three ways out
function pzWkHtml(){
  const w=pzS.wk, m=w.m, canShare=typeof navigator.canShare==='function'&&typeof File!=='undefined'&&(()=>{ try{ return navigator.canShare({files:[new File([''],'w.png',{type:'image/png'})]}); }catch(e){ return false; } })();
  const canCopy=typeof ClipboardItem!=='undefined'&&!!(navigator.clipboard&&navigator.clipboard.write);
  const seg=(lbl,k,opts)=>`<div class="pz-seg" role="group" aria-label="${lbl}" style="flex:1">${opts.map(([v,l])=>`<button type="button" data-pz-wk="${k}:${v}" aria-pressed="${w[k]===v}" style="flex:1">${l}</button>`).join('')}</div>`;
  const sw=(k,lbl,hint)=>`<div class="pz-toggle"><span style="flex:1"><b id="pzWk_${k}">${lbl}</b>${hint?`<span>${hint}</span>`:''}</span><button type="button" role="switch" class="pz-switch" data-pz-wk="show:${k}" aria-checked="${w.show[k]!==false}" aria-labelledby="pzWk_${k}"><i></i></button></div>`;
  return `<section class="pz-card pz-kv pz-span" id="pzWk" aria-labelledby="pzWkT"><div class="pz-kvrow"><b id="pzWkT" class="pz-kvh" style="font-size:16px">Share my week</b><button type="button" class="pz-chip icon" data-pz-wk="close" aria-label="Close share my week">${pzI('x',18)}</button></div>
    <div style="display:flex;justify-content:center;background:var(--pz-bg);border-radius:14px;padding:10px"><img id="pzWkImg" src="${w.url||''}" alt="Your week: discipline, clean days, streak${w.show.level!==false?', level':''}${w.show.duel!==false?', duels':''}${w.show.badges!==false?', badges':''}" style="display:block;max-width:100%;max-height:440px;aspect-ratio:${w.fmt==='square'?'1/1':'4/5'};border-radius:10px;background:var(--pz-card)"></div>
    <div style="display:flex;gap:8px;flex-wrap:wrap">${seg('Shape','fmt',[['portrait','4:5'],['square','Square']])}${seg('Colours','theme',[['dark','Dark'],['light','Light']])}</div>
    ${sw('level','Level and XP','')}${sw('duel','Duel record',m&&!m.duel&&w.show.duel!==false?'No duels to show yet':'')}${sw('badges','Top badges','')}
    <div style="display:flex;gap:8px;flex-wrap:wrap">${canShare?`<button type="button" class="pz-cta pz-sm" style="flex:1;min-height:44px" data-pz-wk="share">Share…</button>`:''}<button type="button" class="${canShare?'pz-ghost':'pz-cta'} pz-sm" style="flex:1;min-height:44px" data-pz-wk="dl">Download</button>${canCopy?`<button type="button" class="pz-ghost pz-sm" style="flex:1" data-pz-wk="copy">Copy image</button>`:''}</div>
    <p class="pz-fine">No dollar amounts and no P&amp;L on this card, on purpose: only your process.</p></section>`;
}
async function pzWkMake(){
  const w=pzS.wk; if(!w)return null; const n=w.n=(w.n||0)+1;
  const m=pzWeekCardModel(pzWeekCardSrc(gameContext()),w.show), blob=await pzWeekCardBlob(m,w.fmt,w.theme);
  if(pzS.wk!==w||w.n!==n)return blob; // a newer choice is being drawn
  if(w.url)URL.revokeObjectURL(w.url); w.blob=blob; w.m=m; w.drawn=w.fmt+'/'+w.theme; w.url=blob?URL.createObjectURL(blob):null; // drawn: what the image on hand shows
  const img=$('pzWkImg'); if(img&&w.url)img.src=w.url; return blob;
}
async function pzWkAction(a){
  const w=pzS.wk, [k,v]=a.split(':');
  if(a==='open'){ pzS.wk={fmt:'portrait',theme:document.body.classList.contains('light')?'light':'dark',show:{level:true,duel:true,badges:true}};
    pzRender(); const el=$('pzWk'); if(el){ el.scrollIntoView({block:'nearest'}); const c=el.querySelector('[data-pz-wk="close"]'); if(c)c.focus(); } await pzWkMake(); pzRender(); return; }
  if(!w)return;
  if(a==='close'){ if(w.url)URL.revokeObjectURL(w.url); pzS.wk=null; pzRender(); const b=document.querySelector('[data-pz-wk="open"]'); if(b)b.focus(); return; }
  if(k==='fmt'||k==='theme'){ w[k]=v; pzRender(); await pzWkMake(); return; }
  if(k==='show'){ w.show[v]=w.show[v]===false; pzRender(); await pzWkMake(); pzRender(); return; }
  const blob=w.blob||await pzWkMake(); if(!blob){ pzNote('The image couldn’t be made in this browser.','err'); return; }
  const name='keel-week-'+(w.m?w.m.from:dayKey(Date.now()))+(w.fmt==='square'?'-square':'')+'.png';
  if(a==='dl'){ const u=URL.createObjectURL(blob), el=document.createElement('a'); el.href=u; el.download=name; document.body.appendChild(el); el.click(); el.remove(); setTimeout(()=>URL.revokeObjectURL(u),4000); return; }
  if(a==='share'){ try{ await navigator.share({files:[new File([blob],name,{type:'image/png'})],title:'My trading week'}); }
    catch(e){ if(e&&e.name!=='AbortError')pzNote('Sharing didn’t work here. Download the image instead.','err'); } return; }
  if(a==='copy'){ try{ await navigator.clipboard.write([new ClipboardItem({'image/png':blob})]); pzNote('Image copied. Paste it wherever you like.'); }
    catch(e){ pzNote('This browser won’t copy images. Download it instead.','err'); } }
}
// ---- the AI coach (#coach): a chat about your own trading, within a daily allowance ----
// The app builds the summary below from your journal and sends it with each message; your trades
// and notes go along only if you switch that on. The server adds nothing and stores nothing.
var COACH={status:null,tried:false,msgs:null,busy:false,err:null};
function pzCoachAvailable(){ return !!(COACH.status&&COACH.status.enabled); }
function pzCoachStoreKey(){ return 'pz_coach:'+(SOC.me?SOC.me.id:'owner'); }
function pzCoachLoad(){ if(COACH.msgs)return COACH.msgs; try{ COACH.msgs=JSON.parse(localStorage.getItem(pzCoachStoreKey())||'[]'); }catch(e){ COACH.msgs=[]; } if(!Array.isArray(COACH.msgs))COACH.msgs=[]; return COACH.msgs; }
function pzCoachSave(){ try{ localStorage.setItem(pzCoachStoreKey(),JSON.stringify((COACH.msgs||[]).slice(-40))); }catch(e){} }
function pzCoachHeaders(){ const h={'Content-Type':'application/json'}; if(SOC.key&&SOC.me)h['X-Pulse-Key']=SOC.key; else if(SRV.token)h['Authorization']='Bearer '+SRV.token; return h; }
function pzCoachStatus(force){
  if(!socAvailable()||(COACH.tried&&!force))return; COACH.tried=true;
  if(!(SOC.key&&SOC.me)&&!(SRV.token&&!SRV.badAuth))return;
  fetch('/api/coach/chat',{headers:pzCoachHeaders()}).then(r=>r.json()).then(d=>{ COACH.status=d; if(PZ)pzRender(); }).catch(()=>{});
}
function pzCoachFacts(D){
  const g=D.g, ctx=g.ctx, now=Date.now(), from30=pzRangeStart(30,now), k30=dayKey(from30), e=D.dayE||{}, day=D.day;
  const s30=pzStatsFor(ctx.trades,from30), r=v=>v==null||!isFinite(v)?null:Math.round(v*100)/100;
  const yK=g.days.filter(d=>d.key<D.todayK).slice(-1)[0], ye=yK?(journal['day:'+yK.key]||{}).eod:null;
  const prof=pzProfile(ctx.closed);
  return {
    today:{date:D.todayK,discipline:day?day.score:null,slips:day?Object.keys(day.behavior.flags).filter(k=>day.behavior.flags[k]).map(k=>PZ_BEH[k]+' ×'+day.behavior.flags[k]):[],
      readiness:D.ready,checkin:e.sleep||e.focus?{sleep:e.sleep||null,calm:e.stress?6-e.stress:null,focus:e.focus||null}:null,form:D.form.score,load:D.load.score,
      tradesOpened:D.risk.trades,tradeCap:D.risk.cap||null,net:r(D.risk.net),lossLimit:D.risk.limit||null,plan:e.plan||null,rules:pzPlanCheck(D.todayK).rules.map(x=>({rule:x.label,kept:x.ok,detail:x.detail})),
      review:e.eod?{rating:e.eod.rating,lesson:e.eod.lesson,tomorrow:e.eod.tomorrow,answers:e.eod.answers}:null},
    yesterday:ye?{lesson:ye.lesson,focusForToday:ye.tomorrow}:null,
    tilt:(()=>{ try{ const T=pzTiltOf(D); return {score:T.score,band:T.band,why:T.reasons.map(x=>x.text)}; }catch(err){ return null; } })(),
    marketToday:(()=>{ const rg=pzRegimeOf(Date.now()); return rg?{btcVolatility:rg.vol,btcTrend:rg.trend}:null; })(),
    goals:(()=>{ try{ const x=pzGoalsCtx(g); return (settings.pzGoals||[]).filter(go=>!go.cleared&&!go.done&&!go.missed).map(go=>{ const ev=pzGoalEval(go,x); return {goal:PZ_GOAL_KINDS[go.kind].title(go),progress:ev.now,status:ev.status}; }); }catch(err){ return []; } })(),
    lessons:(()=>{ try{ return pzLessonsAll().slice(0,8).map(l=>({lesson:l.text,written:l.key,about:l.tag?PZ_SLIP_TOPIC[l.tag]:null})); }catch(err){ return []; } })(),
    profile:{name:prof.name,chosen:prof.chosen},
    level:{level:g.level.level,title:g.level.title,xp:g.level.xp},streak:{current:g.streak.current,best:g.streak.best,shields:g.streak.shields},
    last14days:g.days.slice(-14).map(d=>({date:d.key,discipline:d.score,trades:d.n,net:r(d.net),slips:Object.keys(d.behavior.flags).filter(k=>d.behavior.flags[k]).map(k=>PZ_BEH[k])})),
    stats30:s30?{trades:s30.s.n,net:r(s30.s.net),winRate:r(s30.s.winRate),avgTrade:r(s30.s.expectancy),profitFactor:r(isFinite(s30.s.profitFactor)?s30.s.profitFactor:null),avgWin:r(s30.s.avgWin),avgLoss:r(s30.s.avgLoss),fees:r(s30.s.fees)}:null,
    slipCost30:(()=>{ const c=pzSlipCost(g.days.filter(d=>d.key>=k30)); return {cleanTrades:c.cleanN,cleanAvg:r(c.cleanAvg),slipTrades:c.slipN,slipAvg:r(c.slipAvg),bySlip:Object.keys(c.by).map(k=>({slip:PZ_BEH[k],trades:c.by[k].n,net:r(c.by[k].net)}))}; })(),
    leaks30:pzLeakMap(g,30).slice(0,4).map(x=>({slip:x.label,trades:x.n,cost:r(x.cost),previous30:x.prevN,plugging:x.plug?{since:x.plug.from,cleanWeeks:x.plug.cleanRun,done:x.plug.done}:null})),
    habits:habitsList().slice(0,8).map(h=>{ const s=pzHabitStreak(h,ctx,g.nowWeek); return {habit:habitSentence(h),streak:s.current,best:s.best,kept:s.kept,of:s.total}; }),
    challenge:g.current?{challenge:habitSentence(g.current.ch.spec),kept:g.current.res.filter(x=>x.kept).length,days:g.current.res.length,status:g.current.status}:null,
    findings:(ctx.findings||[]).filter(f=>f.tone!=='info').slice(0,6).map(f=>({type:f.tone,title:f.title,action:f.action,evidence:f.evidence,confidence:confWords(f.conf)})),
    goodMoments7:pzGoodMoments(g,pzAddDays(D.todayK,-6)).slice(0,8).map(m=>m.key+': '+m.text),
    badges:{earned:g.catalog?g.catalog.earned.length:0,recent:(g.catalog?g.catalog.earned.slice(-3):[]).map(b=>b.t)},
    // where they stand among anonymous traders of their style, size and experience (group spreads only)
    tradersLikeYou:(()=>{ try{ const mine=peerMine(), P=mine.ok?peerData(mine):null, grp=P&&P.d?peerGroup(P.d):null; if(!grp)return null;
      const out={group:peerGroupName(grp),traders:grp.n,measures:{}};
      for(const m of PEER_M){ if(m.ctx||!grp.q[m.k]||mine[m.k]==null)continue; out.measures[m.l]={you:m.f(mine[m.k]),typical:m.f(grp.q[m.k][4]),bestQuarter:grp.top[m.k]!=null?m.f(grp.top[m.k]):null,betterThanOutOf100:peerBetter(m,grp.q[m.k],mine[m.k])}; }
      const I=P.d.improvers; if(I&&I.changes&&I.changes.length)out.whatImproversChanged={improved:I.n,others:I.nOthers,changes:I.changes.slice(0,3).map(c=>c.text)};
      return out; }catch(err){ return null; } })(),
  };
}
// only with the member's say-so: recent trades with their notes, and the last week's reviews
function pzCoachDetail(D){
  const closed=[...D.ctx.closed].sort((a,b)=>b.closeTime-a.closeTime).slice(0,30), slipOf={};
  for(const d of D.g.days)for(const s of (d.behavior.slips||[]))slipOf[s.id]=s.f.map(k=>PZ_BEH[k]);
  return {trades:closed.map(t=>{ const j=journal[t.id]||{}, p=tzParts(t.openTime||t.closeTime);
      return {date:dayKey(t.closeTime),opened:String(p.h).padStart(2,'0')+':'+String(p.min).padStart(2,'0'),market:dispMarket(dcoin(t)),side:t.dir,
        holdMin:t.openTime?Math.round((t.closeTime-t.openTime)/60000):null,size:Math.round(Math.abs((+t.maxSize||0)*(+t.avgEntry||0))),net:Math.round(t.net*100)/100,
        slips:slipOf[t.id]||[],rating:j.rating||null,setup:j.setup||null,note:j.notes?String(j.notes).slice(-300):null}; }),
    reviews:Object.keys(journal).filter(k=>k.startsWith('day:')&&journal[k]&&journal[k].eod&&k.slice(4)>=pzAddDays(D.todayK,-7)).sort().map(k=>({date:k.slice(4),...journal[k].eod}))};
}
async function pzCoachSend(text){
  text=String(text||'').trim(); if(!text||COACH.busy)return;
  const D=pzData(), msgs=pzCoachLoad();
  msgs.push({role:'user',content:text.slice(0,4000),at:Date.now()}); COACH.busy=true; COACH.err=null; pzCoachSave(); pzRender();
  try{
    const body={messages:msgs.slice(-16).map(m=>({role:m.role,content:m.content})),facts:pzCoachFacts(D)};
    if(SOC.me&&SOC.me.coachDetail||(SRV.token&&!SRV.badAuth&&settings.pzCoachDetail))body.detail=pzCoachDetail(D);
    const r=await fetch('/api/coach/chat',{method:'POST',headers:pzCoachHeaders(),body:JSON.stringify(body)});
    const d=await r.json().catch(()=>({}));
    if(!r.ok){ COACH.err=d.error||('HTTP '+r.status); if(d.remaining!=null&&COACH.status)Object.assign(COACH.status,{remaining:d.remaining,allowed:false,reason:d.error}); msgs.pop(); const el=$('pzCoachIn'); if(el&&!el.value)el.value=text; }
    else { msgs.push({role:'assistant',content:d.text,at:Date.now()}); if(COACH.status)Object.assign(COACH.status,{remaining:d.remaining,used:d.used,limit:d.limit,allowed:d.remaining==null||d.remaining>0}); }
  }catch(e){ COACH.err='Couldn’t reach the coach. Check your connection and try again.'; msgs.pop(); const el=$('pzCoachIn'); if(el&&!el.value)el.value=text; }
  finally{ COACH.busy=false; pzCoachSave(); pzRender(); const l=$('pzChat'); if(l)l.scrollTop=l.scrollHeight; }
}
function pzCoachPrompts(){
  const h=tzParts(Date.now()).h;
  return [h<12?'Plan my day with me':h>=17?'Review my day':'Am I tilting right now?','What’s my biggest leak right now?','Why was my Discipline low?','What should I work on this week?','What am I doing well?'];
}
function pzCoachHtml(D){
  const back=''; // a top-level tab: no back link
  pzCoachStatus();
  const lock=pzLocked('coach',D.g.level.level); if(lock)return `${back}${pzLockedHtml('Your AI coach',lock,D.g)}`;
  const owner=!!(SRV.token&&!SRV.badAuth);
  if(!socAvailable()||(!SOC.me&&!owner))return `${back}${pzHead('Coach','Your AI coach')}<section class="pz-card pz-empty">
    <span class="pz-ico" style="width:52px;height:52px;background:var(--pz-tint-good);color:var(--pz-good)">${pzI('coach',26)}</span>
    <b style="font-size:18px">A coach that knows your trades</b>
    <p class="pz-sub" style="max-width:460px">Ask why a day went wrong, what to change this week, or whether a setup is worth keeping. It reads your summaries, never your keys, and runs on the league server this page comes from.</p>
    ${socAvailable()?'<a class="pz-cta" href="#social" style="max-width:280px">Create your profile to start</a>':'<p class="pz-fine">Open Keel from your server’s /keel link to use it.</p>'}</section>`;
  const st=COACH.status;
  if(!st)return `${back}${pzHead('Coach','Your AI coach')}<p class="pz-sub"><span class="pz-spin"></span>Loading…</p>`;
  if(!st.enabled)return `${back}${pzHead('Coach','Your AI coach')}<section class="pz-card pz-kv"><p class="pz-sub">The AI coach isn’t switched on for this server yet.${owner?' Set <code>COACH_AI=1</code> and an <code>ANTHROPIC_API_KEY</code> (or <code>OPENAI_API_KEY</code>) on the server, then restart it.':' Ask the league owner.'}</p></section>`;
  const msgs=pzCoachLoad();
  const list=msgs.length?msgs.map(m=>`<div class="pz-msg ${m.role==='user'?'me':'co'}"><p>${esc(m.content).replace(/\n/g,'<br>')}</p></div>`).join('')
    :`<div class="pz-msg co"><p>Hi${SOC.me?' @'+esc(SOC.me.handle):''}. I can see your scores, slips, habits and today’s plan${SOC.me&&SOC.me.coachDetail?', plus your recent trades and notes':''}. Ask me anything about your trading process — or pick one below.</p></div>`;
  const left=st.remaining==null?'':st.remaining+' of '+st.limit+' message'+(st.limit===1?'':'s')+' left today';
  const detailOn=SOC.me?!!SOC.me.coachDetail:!!settings.pzCoachDetail;
  return `${back}${pzHead(left||'Your AI coach','Coach')}
  <div class="pz-coach-wrap"><div class="pz-chat" id="pzChat" aria-live="polite">${list}${COACH.busy?'<div class="pz-msg co"><p><span class="pz-spin"></span>Thinking…</p></div>':''}</div>
    ${COACH.err?`<p class="pz-fine pz-err" role="alert">${esc(COACH.err)}</p>`:''}
    <div class="pz-chiprow">${pzCoachPrompts().map(p=>`<button type="button" class="pz-chipbtn" data-pz-ask="${esc(p)}"${COACH.busy||st.allowed===false?' disabled':''}>${esc(p)}</button>`).join('')}</div>
    <div class="pz-chatin"><textarea id="pzCoachIn" rows="2" maxlength="4000" placeholder="${st.allowed===false?esc(st.reason||'No messages left today'):'Ask about your trading…'}"${st.allowed===false?' disabled':''}></textarea><button type="button" class="pz-cta pz-sm" id="pzCoachSend"${COACH.busy||st.allowed===false?' disabled':''} aria-label="Send">${pzI('arrow',20)}</button></div>
    <div class="pz-toggle"><span style="flex:1"><b id="pzCdL">Include my recent trades and journal notes</b><span>${st.detailAllowed===false?'The league owner has this switched off.':'Sharper answers about specific trades. Wallet addresses are never sent.'}</span></span>
      <button type="button" role="switch" class="pz-switch" data-pz-cdetail aria-checked="${detailOn}" aria-labelledby="pzCdL"${st.detailAllowed===false?' disabled':''}><i></i></button></div>
    <p class="pz-fine">The coach sees a summary built on this device: scores, slips, habits, plans and reviews. It doesn’t give trade signals. Answers can be wrong — your rules come first.${msgs.length?' <button type="button" class="pz-linkbtn" id="pzCoachClear">Clear this chat</button>':''}</p></div>`;
}
function socSubTabs(){
  return `<div class="pz-seg full" role="group" aria-label="Social">${[['league','League'],['boards','Boards'],['feed','Feed']].map(([k,l])=>`<button type="button" data-soc-sub="${k}" aria-pressed="${(SOC.sub==='compete'?'league':SOC.sub)===k}">${l}</button>`).join('')}</div>`;
}
// how often a league's ranking starts over: its seasons when it has them, else its period
const socPeriod=L=>L.season?(L.season.id.includes('-Q')?'quarterly seasons':'monthly seasons'):L.period==='month'?'monthly':'weekly';
const SOC_TIER_COL=['#C98B5A','#CDD3DA','#F4C04E','#8FD9E8','#B69CFF'];
function socRowsHtml(rows, board, emptyText, key){
  if(!rows)return '';
  if(!rows.length)return `<section class="pz-card"><p class="pz-sub">${esc(emptyText)}</p></section>`;
  const pg=pzPage('rows:'+(key||board),rows), mine=rows.find(r=>r.me), mineOff=mine&&!pg.items.includes(mine);
  const li=r=>`<li class="pz-li${r.me?' me':''}"><span class="pz-rank${r.rank<=3?' top':''}">${r.rank}</span>${socAv(r.handle)}
    <a class="pz-who" href="#u/${esc(r.handle)}"><b>${r.me?'You':'@'+esc(r.handle)}</b><span>${esc(r.sub||'')}</span></a><span class="pz-val">${esc(socValue(board,r.value))}</span></li>`;
  return `<ol class="pz-list" aria-label="Standings">${pg.items.map(li).join('')}</ol>${pg.html}${mineOff?`<ol class="pz-list" aria-label="Your place">${li(mine)}</ol>`:''}`;
}
// one "Ranked by" picker instead of a row of pills under the tabs
function socRankSel(id, opts, cur){
  return `<div class="pz-field pz-rankby"><label for="${id}" style="font-size:13px;font-weight:600;color:var(--pz-muted)">Ranked by</label><select id="${id}">${opts.map(([k,l])=>`<option value="${esc(k)}"${k===cur?' selected':''}>${esc(l)}</option>`).join('')}</select></div>`;
}
function socOptHtml(d){
  const need={boards:'Process leaderboards',verify:'Verify my discipline',ret:'Show % return',usd:'Show dollar P&L',global:'Global leaderboards'};
  return d&&d.optedIn===false&&d.need!=='global'?`<p class="pz-warn">You’re not on this board. Switch on “${need[d.need]||'Show % return'}” in <a href="#sharing">What you share</a> to appear.</p>`
    :d&&d.verifyState==='no-wallet'?'<p class="pz-warn">Add a wallet so the server can verify your Discipline from your fills.</p>'
    :d&&d.verifyState==='claim'?'<p class="pz-warn">This league only counts claimed wallets. Claim yours under <a href="#account">Account</a>.</p>'
    :d&&d.verifyState==='approval'?'<p class="pz-warn">Your wallet is waiting for the league owner’s approval. You’ll appear here once it’s approved.</p>'
    :d&&d.verifyState==='rejected'?'<p class="pz-warn">The league owner hasn’t accepted this wallet, so it can’t be verified here.</p>'
    :d&&d.verifyState==='pending'?'<p class="pz-sub" style="font-size:12px"><span class="pz-spin"></span>Verifying your Discipline from your fills — you’ll appear here shortly.</p>'
    :d&&d.verifyState==='unavailable'?'<p class="pz-sub" style="font-size:12px">This server can’t verify scores right now, so the discipline board is paused.</p>':'';
}
// your leagues: pick one, see its own ranking, or any board among its members
function socLeagueHtml(g){
  const id=SOC.lg||'', c=socGet('league:'+id,'/league'+(id?'?id='+encodeURIComponent(id):''),30000), d=c&&c.d;
  if(!d)return `<p class="pz-sub">${c&&c.err?esc(c.err):'<span class="pz-spin"></span>Loading…'}</p>`;
  const find=`<a class="pz-chipbtn" href="#leagues">${pzI('plus',14,3)} Find leagues</a>`;
  if(!d.league)return `<section class="pz-card pz-kv"><b class="pz-kvh">You’re not in a league yet</b><p class="pz-sub" style="font-size:13px">Find one by name or number and join — you can be in several at once.</p><a class="pz-cta" href="#leagues">Find a league</a></section>`;
  const L=d.league, T=(SOC.cfg&&SOC.cfg.tiers)||PZ_TIERS, b=SOC.board&&SOC.board!=='rank'?SOC.board:'rank';
  const chipsL=`<div class="pz-chiprow" role="group" aria-label="Your leagues">${d.mine.map(x=>`<button type="button" class="pz-chipbtn" data-soc-lg="${esc(x.id)}" aria-pressed="${x.id===L.id}">${esc(x.name)}</button>`).join('')}${find}</div>`;
  const banner=`<section class="pz-banner"><span class="pz-ico" style="width:40px;height:40px;background:var(--pz-tint-n);color:${L.tiers?SOC_TIER_COL[d.tier]||'#CDD3DA':PZ_COL.xp}">${pzI('shield',22)}</span>
    <span style="flex:1;display:flex;flex-direction:column;gap:2px;min-width:0"><b style="font-size:14px">${esc(L.name)} <span class="pz-sub" style="font-weight:500">#${L.num}</span></b>
    <span class="pz-sub" style="font-size:12px">${esc(L.metricLabel)} · ${socPeriod(L)} · ${L.members} trader${L.members===1?'':'s'}${L.tiers?' · you’re in '+esc(T[d.tier]):''}</span>
    ${L.season?`<span class="pz-sub" style="font-size:12px;color:var(--pz-soft)">Season: ${esc(L.season.label)} · ${L.season.daysLeft>0?L.season.daysLeft+' day'+(L.season.daysLeft===1?'':'s')+' left':'last day'}</span>`:''}
    ${L.tiers?`<span class="pz-sub" style="font-size:12px">${d.promote?'Top '+d.promote+' move up to '+esc(T[d.tier+1])+' on Monday':d.tier===T.length-1?'The top tier — hold your place.':'Promotion starts once four or more traders share your tier.'}</span>`:''}</span>
    <a class="pz-link" href="#lg/${esc(L.id)}" style="min-height:0">Info${pzI('chev',14)}</a></section>`;
  const chipsB=socRankSel('socBoardSel',[['rank','League ranking · '+L.metricLabel],...SOC_BOARDS.filter(([k])=>k!==L.metric)],b);
  let list='', note='', opt='', mine='';
  // the note says what this league's ranking covers: its season, its month, or its week — and only promises promotion where there are tiers
  const ranks=L.season?'this season ('+L.season.label+')':L.period==='month'?'this month':'this week';
  const leagueNote=L.metric==='xp'?'XP earned '+ranks+' — process, never profit.'+(L.season?' The top three when the season ends take the podium and a badge.':L.tiers?' The top of each tier moves up '+(L.period==='month'?'when the month ends':'on Monday')+', the bottom moves down.':'')
    :L.season?(SOC_BOARD_NOTE[d.board]||'')+' Ranked over '+ranks+'; the top three take the podium.':SOC_BOARD_NOTE[d.board]||'';
  if(b==='rank'){ list=socRowsHtml(d.rows,d.board,'No one in this league has a score yet this period.'); note=leagueNote; mine=d.me?`<p class="pz-sub" style="font-size:13px">You’re <b>#${d.me.rank}</b> of ${d.size} with ${esc(socValue(d.board,d.me.value))}.</p>`:''; }
  else { const c2=socGet('lb:'+L.id+':'+b,'/leaderboard?board='+b+'&league='+encodeURIComponent(L.id),30000), d2=c2&&c2.d;
    list=d2?socRowsHtml(d2.rows,b,'No one on this board yet.'):`<p class="pz-sub">${c2&&c2.err?esc(c2.err):'<span class="pz-spin"></span>Loading…'}</p>`; note=SOC_BOARD_NOTE[b]||''; opt=socOptHtml(d2);
    mine=d2&&d2.me?`<p class="pz-sub" style="font-size:13px">You’re <b>#${d2.me.rank}</b> of ${d2.total} with ${esc(socValue(b,d2.me.value))}.</p>`:''; }
  return `${chipsL}${banner}${chipsB}<p class="pz-sub" style="font-size:12px">${esc(note)}</p>${opt}${mine}${list}`;
}
// the global boards: everyone on the server who opted in, whatever their league
function socBoardsHtml(g){
  const on=!!(SOC.share&&SOC.share.global), b=SOC.gboard||'discipline';
  const chips=socRankSel('socGboardSel',SOC_BOARDS,b);
  const c=socGet('glb:'+b,'/leaderboard?scope=global&board='+b,30000), d=c&&c.d;
  const join=`<section class="pz-card" style="padding:4px 16px"><div class="pz-toggle"><span style="flex:1"><b id="socGlobL">Show me on the global boards</b><span>Everyone on this server who opted in, across all leagues. Your league boards don’t change.</span></span>
    <button type="button" role="switch" class="pz-switch" id="socGlobSw" data-soc-global="${on?'0':'1'}" aria-checked="${on}" aria-labelledby="socGlobL"><i></i></button></div></section>`;
  const list=d?socRowsHtml(d.rows,b,on?'No one on this board yet.':'No one has opted in to this board yet — be the first.'):`<p class="pz-sub">${c&&c.err?esc(c.err):'<span class="pz-spin"></span>Loading…'}</p>`;
  const mine=d&&d.me?`<p class="pz-sub" style="font-size:13px">You’re <b>#${d.me.rank}</b> of ${d.total} with ${esc(socValue(b,d.me.value))}.</p>`:'';
  return `${chips}${join}<p class="pz-sub" style="font-size:12px">${esc(SOC_BOARD_NOTE[b]||'')}</p>${on?socOptHtml(d):''}${mine}${list}`;
}
// find a league by name or number
function socFindHtml(D){
  const back=`<a class="pz-back" href="#social">${pzI('back',20)}Social</a>`;
  if(!socAvailable()||!SOC.me)return `${back}${socSocialHtml(D)}`;
  const q=SOC.lq||'', c=socGet('lq:'+q,'/leagues'+(q?'?q='+encodeURIComponent(q):''),15000), d=c&&c.d;
  const card=L=>`<a class="pz-card pz-cardlink pz-lcard" href="#lg/${esc(L.id)}"><span class="pz-ico" style="background:var(--pz-tint-n);color:${PZ_COL.xp}">${pzI('shield',20)}</span>
    <span style="flex:1;min-width:0;display:flex;flex-direction:column;gap:2px"><b style="font-size:15px">${esc(L.name)} <span class="pz-sub" style="font-weight:500">#${L.num}</span></b>
    <span class="pz-sub" style="font-size:12px">${esc(L.metricLabel)} · ${socPeriod(L)}${L.tiers?' · tiers':''} · ${L.members} trader${L.members===1?'':'s'}${L.inviteRequired?' · invite code':''}</span>
    ${L.desc?`<span class="pz-sub" style="font-size:12px">${esc(L.desc)}</span>`:''}</span>${L.joined?'<span class="pz-chipbtn ok" style="cursor:default">Joined</span>':pzI('chev',18)}</a>`;
  return `${back}${pzHead('Name or number','Find a league')}
    <div class="pz-field"><label for="socLq" class="pz-sr">Search leagues</label><input type="search" id="socLq" value="${esc(q)}" placeholder="e.g. discipline, or #1042" autocomplete="off" enterkeyhint="search"></div>
    ${d?(d.leagues.length?`<div class="pz-jgrid">${pzPage('lgq:'+q,d.leagues).items.map(card).join('')}</div>${pzPage('lgq:'+q,d.leagues).html}`:`<section class="pz-card"><p class="pz-sub">No open league matches “${esc(q)}”. Leagues that are closed only show to their members.</p></section>`)
      :`<p class="pz-sub">${c&&c.err?esc(c.err):'<span class="pz-spin"></span>Searching…'}</p>`}
    <p class="pz-fine">You can be in several leagues at once. Each has its own ranking; your XP and badges are the same everywhere.</p>`;
}
function socLeagueInfoHtml(D, id){
  const back=`<a class="pz-back" href="#leagues">${pzI('back',20)}Leagues</a>`;
  if(!socAvailable()||!SOC.me)return `${back}${socSocialHtml(D)}`;
  const c=socGet('li:'+id,'/leagues/'+encodeURIComponent(id),20000), L=c&&c.d&&c.d.league;
  if(!L)return `${back}<p class="pz-sub">${c&&c.err?esc(c.err):'<span class="pz-spin"></span>Loading…'}</p>`;
  const T=(SOC.cfg&&SOC.cfg.tiers)||PZ_TIERS;
  const top=L.top&&L.top.length?`<ol class="pz-list">${L.top.map(r=>`<li class="pz-li${r.me?' me':''}"><span class="pz-rank${r.rank<=3?' top':''}">${r.rank}</span>${socAv(r.handle)}<a class="pz-who" href="#u/${esc(r.handle)}"><b>${r.me?'You':'@'+esc(r.handle)}</b><span>${esc(r.sub||'')}</span></a><span class="pz-val">${esc(socValue(L.metric,r.value))}</span></li>`).join('')}</ol>`:'<p class="pz-sub" style="font-size:13px">No scores yet this period.</p>';
  const act=L.joined?`<button type="button" class="pz-cta" data-soc-lgopen="${esc(L.id)}">Open the ranking</button><button type="button" class="pz-ghost pz-sm" data-soc-lgleave="${esc(L.id)}">Leave this league</button>`
    :`${L.inviteRequired?'<div class="pz-field"><label for="socLgInv" style="font-size:13px">Invite code</label><input type="text" id="socLgInv" maxlength="40" autocomplete="off"></div>':''}<button type="button" class="pz-cta" data-soc-lgjoin="${esc(L.id)}">Join ${esc(L.name)}</button>`;
  return `${back}${pzHead('League #'+L.num,L.name)}
  <div class="pz-wide"><div class="pz-col"><section class="pz-card pz-kv">${L.desc?`<p style="margin:0;font-size:14px;line-height:1.5">${esc(L.desc)}</p>`:''}
      <div class="pz-row-t"><span>Ranked by</span><b>${esc(L.metricLabel)}</b></div><div class="pz-row-t"><span>Period</span><b>${L.season?(L.season.id.includes('-Q')?'Quarterly seasons':'Monthly seasons'):L.period==='month'?'Rolling month':'Weekly'}</b></div>
      ${L.season?`<div class="pz-row-t"><span>Season</span><b>${esc(L.season.label)} · ends ${esc(dayLabel(L.season.end))}</b></div>`:''}
      <div class="pz-row-t"><span>Tiers</span><b>${L.tiers?'Bronze → Diamond, promotion every Monday':'One table'}</b></div><div class="pz-row-t"><span>Traders</span><b>${L.members}</b></div>
      <div class="pz-row-t"><span>Joining</span><b>${L.inviteRequired?'Invite code':'Open'}</b></div>
      ${L.tiersCount?`<div class="pz-row-t"><span>By tier</span><b>${L.tiersCount.map(t=>t.n).join(' · ')}</b></div>`:''}</section>${act}</div>
    <div class="pz-col"><section class="pz-card pz-kv"><b class="pz-kvh">Top five</b>${top}</section>
      ${L.hall&&L.hall.length?`<section class="pz-card pz-kv"><b class="pz-kvh">Hall of fame</b>${L.hall.slice(0,6).map(h=>`<div style="padding:8px 0;border-top:1px solid var(--pz-line)"><span class="pz-sub" style="font-size:12px">${esc(h.label)} · ${h.n} trader${h.n===1?'':'s'}</span><div style="display:flex;flex-wrap:wrap;gap:4px 14px;margin-top:4px;font-size:14px;font-weight:600">${h.podium.map((r,i)=>`<span>${['🏆','🥈','🥉'][i]} ${r.me?'You':r.handle?'@'+esc(r.handle):'a former member'}</span>`).join('')||'—'}</div></div>`).join('')}</section>`:''}
      ${L.comps&&L.comps.length?`<section class="pz-card pz-kv"><b class="pz-kvh">Competitions</b>${L.comps.map(x=>`<a class="pz-row-t" href="#c/${esc(x.id)}"><span>${esc(x.title)}</span><b>${esc(x.start.slice(5))} → ${esc(x.end.slice(5))}</b></a>`).join('')}</section>`:''}</div></div>`;
}

// ---- accountability partners: up to three, each sees the other's streak, scores and slips ----
const SOC_SLIP_SHORT={revenge:'revenge entry',afterTwo:'traded on after two losses',sizeUp:'sized up after a loss',addLoser:'added to a loser',overtrade:'overtraded',heldLoser:'held a loser'};
function socDayDots(days){
  return `<span class="pz-pdots" aria-hidden="true">${(days||[]).slice(-14).map(d=>`<i data-pz-tip="${esc(dayLabel(d.k))} · discipline ${d.s}${d.f&&d.f.length?' · '+esc(d.f.map(k=>SOC_SLIP_SHORT[k]||k).join(', ')):''}" style="background:${PZ_COL[pzBand(d.s)]}${d.f&&d.f.length?';box-shadow:0 0 0 2px #FF7A59':''}"></i>`).join('')}</span>`;
}
function socPartnersHtml(){
  if(!SOC.me)return '';
  const c=socGet('partners','/partners',30000), L=c&&c.d?c.d.partners:null;
  if(!L)return `<section class="pz-card"><p class="pz-sub">${c&&c.err?esc(c.err):'<span class="pz-spin"></span>Loading partners…'}</p></section>`;
  const active=L.filter(p=>p.status==='active'), recv=L.filter(p=>p.status==='received'), sent=L.filter(p=>p.status==='sent');
  const card=p=>{ const v=p.view||{};
    return `<section class="pz-card pz-kv"><div class="pz-kvrow"><a href="#u/${esc(p.handle)}" style="display:flex;align-items:center;gap:10px;color:var(--pz-text);text-decoration:none;min-width:0">${socAv(p.handle,34)}<span style="min-width:0"><b>@${esc(p.handle)}</b><span class="pz-sub" style="display:block;font-size:12px">Level ${v.level||1} · ${v.streak||0}-day streak</span></span></a>
      <button type="button" class="pz-chip icon" data-soc-pdel="${esc(p.id)}" aria-label="End the partnership with @${esc(p.handle)}">${pzI('x',16)}</button></div>
      <div class="pz-kvrow"><span class="pz-sub" style="font-size:13px">7-day discipline <b style="color:var(--pz-text)">${v.avg7==null?'—':v.avg7}</b> · slips <b style="color:${v.slips7?PZ_COL.low:'var(--pz-text)'}">${v.slips7||0}</b></span>${socDayDots(v.days)}</div>
      ${p.challenge?`<p class="pz-sub" style="font-size:13px">Shared challenge: <b style="color:var(--pz-text)">${esc(p.challenge.text)}</b>${p.challenge.mine?' (yours)':''}</p>`:''}
      ${pzS.chFor===p.id?`<div class="pz-field"><label for="socChIn" style="font-size:13px">This week’s shared challenge</label><input type="text" id="socChIn" maxlength="140" placeholder="e.g. No trades in the first 15 minutes"></div>
        <div style="display:flex;gap:8px"><button type="button" class="pz-cta pz-sm" style="flex:1;min-height:40px" data-soc-chsave="${esc(p.id)}">Set it for you both</button><button type="button" class="pz-ghost pz-sm" style="flex:1" data-soc-chfor="">Cancel</button></div>`
        :`<div style="display:flex;gap:8px;flex-wrap:wrap"><button type="button" class="pz-ghost pz-sm" style="width:auto;padding:0 14px" data-soc-nudge="${esc(p.id)}"${p.canNudge?'':' disabled'}>${p.canNudge?'Nudge':'Nudged'}</button><button type="button" class="pz-ghost pz-sm" style="width:auto;padding:0 14px" data-soc-chfor="${esc(p.id)}">${p.challenge?'Change the challenge':'Set a shared challenge'}</button>${p.challenge&&!p.challenge.mine?`<button type="button" class="pz-ghost pz-sm" style="width:auto;padding:0 14px" data-soc-adopt="${esc(p.challenge.text)}">Adopt as habit</button>`:''}</div>`}</section>`; };
  return `<section style="display:flex;flex-direction:column;gap:10px;margin-bottom:12px"><div class="pz-kvrow"><span class="pz-lbl" style="color:var(--pz-muted)">Accountability partners</span>${active.length<3?`<a class="pz-link" href="#people/partner" style="min-height:0">Find a partner ${pzI('chev',14)}</a>`:''}</div>
    ${recv.map(p=>`<section class="pz-card pz-kvrow">${socAv(p.handle,30)}<span style="flex:1;font-size:14px"><b>@${esc(p.handle)}</b> wants to be partners</span><button type="button" class="pz-cta pz-sm" style="width:auto;min-height:40px;padding:0 16px" data-soc-paccept="${esc(p.id)}">Accept</button><button type="button" class="pz-ghost pz-sm" style="width:auto;padding:0 14px" data-soc-pdel="${esc(p.id)}" data-what="decline">Decline</button></section>`).join('')}
    ${active.length?`<div class="pz-jgrid">${active.map(card).join('')}</div>`:'<p class="pz-sub" style="font-size:13px">Pair with someone you trust: you each see the other’s streak, Discipline scores and slips — never trades or P&amp;L — and can nudge each other and share a weekly challenge.</p>'}
    ${sent.map(p=>`<p class="pz-fine">Waiting for @${esc(p.handle)} to accept. <button type="button" class="pz-linkbtn" data-soc-pdel="${esc(p.id)}" data-what="cancel">Cancel</button></p>`).join('')}
    ${active.length<3?`<div style="display:flex;gap:8px;align-items:flex-end"><div class="pz-field" style="flex:1"><label for="socPIn" style="font-size:13px">Ask someone by name</label><input type="text" id="socPIn" maxlength="21" placeholder="@name" autocomplete="off" autocapitalize="off" spellcheck="false"></div><button type="button" class="pz-ghost pz-sm" style="width:auto;padding:0 16px;min-height:48px" id="socPAsk">Ask</button></div>`:''}</section>`;
}
// a slim row per partner on Today
function socPartnerStripHtml(){
  if(!SOC.me||!SOC.me.partners)return '';
  const c=socGet('partners','/partners',60000), L=c&&c.d?c.d.partners.filter(p=>p.status==='active'):[]; if(!L.length)return '';
  return `<section class="pz-card pz-kv"><div class="pz-kvrow"><b class="pz-kvh">Your partners</b><a class="pz-link" href="#social" data-soc-sub="feed" style="min-height:0">All ›</a></div>
    ${L.map(p=>{ const v=p.view||{}; return `<div class="pz-kvrow" style="gap:10px">${socAv(p.handle,28)}<span style="flex:1;min-width:0;font-size:13px"><b>@${esc(p.handle)}</b> · ${v.streak||0}-day streak · ${v.slips7?`<span style="color:${PZ_COL.low}">${v.slips7} slip${v.slips7===1?'':'s'}</span>`:'no slips'} this week</span>${p.canNudge?`<button type="button" class="pz-linkbtn" data-soc-nudge="${esc(p.id)}">Nudge</button>`:''}</div>`; }).join('')}</section>`;
}
// nudges, mentor notes and season results, until you've read them
function socInboxHtml(){
  if(!SOC.me)return '';
  const c=socGet('inbox','/inbox',60000), L=c&&c.d?c.d.items.filter(x=>x.unread):[]; if(!L.length)return '';
  const ico={partner:'social',mentor:'coach',season:'medal',duel:'medal'};
  return `<section class="pz-card pz-kv" aria-label="New for you"><div class="pz-kvrow"><b class="pz-kvh">New for you</b><button type="button" class="pz-linkbtn" id="socInboxRead">Mark read</button></div>
    ${L.slice(0,4).map(x=>`<div class="pz-nowrow"><span style="color:${x.kind==='mentor'?PZ_COL.xp:x.kind==='season'?'#F4C04E':PZ_COL.risk}">${pzI(ico[x.kind]||'bolt',16)}</span><span><b style="font-size:13px;font-weight:600">${esc(x.text)}</b><span class="pz-sub" style="display:block;font-size:11px">${x.day?'About '+esc(dayLabel(x.day))+' · ':''}${socAgo(x.at)}</span></span></div>`).join('')}</section>`;
}

// notes your mentors left, in full, newest first (the evening review is where you read them)
function socNotesHtml(){
  if(!SOC.me||!SOC.share||!SOC.share.mentor)return '';
  const c=socGet('notes','/notes',60000), L=c&&c.d?c.d.notes:[]; if(!L.length)return '';
  return `<section class="pz-card pz-kv"><b class="pz-kvh">Notes from your mentor</b>${L.slice(0,5).map(n=>`<div class="pz-quote">${esc(n.text)}<span class="pz-sub" style="display:block;font-size:11px;margin-top:4px">@${esc(n.by)}${n.day?' · about '+esc(dayLabel(n.day)):''} · ${socAgo(n.at)}</span></div>`).join('')}</section>`;
}
// ---- mentors: the members who let mentors in, their days, and notes on them ----
function socMentorHtml(D){
  const back=`<a class="pz-back" href="#social">${pzI('back',20)}Social</a>`;
  if(!socAvailable()||!SOC.me)return `${back}${socSocialHtml(D)}`;
  if(!SOC.me.mentor)return `${back}${pzHead('Mentor','Mentees')}<section class="pz-card"><p class="pz-sub">Only mentors the league owner appointed see this.</p></section>`;
  const c=socGet('mentees','/mentor',30000), L=c&&c.d?c.d.mentees:null;
  if(!L)return `${back}${pzHead('Mentor','Mentees')}<p class="pz-sub">${c&&c.err?esc(c.err):'<span class="pz-spin"></span>Loading…'}</p>`;
  const pg=pzPage('mentees',L);
  return `${back}${pzHead(L.length+' member'+(L.length===1?'':'s')+' let you in','Mentees')}<a class="pz-card pz-cardlink" href="#reviews" style="margin-bottom:12px"><b style="flex:1">Trades to review</b>${pzI('chev',18)}</a>
    ${L.length?`<div class="pz-jgrid">${pg.items.map(m=>`<a class="pz-card pz-cardlink" href="#mentee/${esc(m.handle)}">${socAv(m.handle,36)}<span style="flex:1;min-width:0;display:flex;flex-direction:column;gap:2px"><b style="font-size:15px">@${esc(m.handle)}${m.asked?' <span class="pz-tag info">asked for you</span>':''}</b>
      <span class="pz-sub" style="font-size:12px">7-day discipline ${m.avg7==null?'—':m.avg7} · ${m.slips7} slip${m.slips7===1?'':'s'} · ${m.streak}-day streak${m.lastDay?' · last traded '+esc(dayLabel(m.lastDay)):''}</span>
      <span class="pz-sub" style="font-size:12px">${m.notes} note${m.notes===1?'':'s'} so far</span></span>${pzI('chev',18)}</a>`).join('')}</div>${pg.html}`
      :'<section class="pz-card"><p class="pz-sub">No one has let mentors in yet. Members switch on “Let mentors see my days” under What you share.</p></section>'}`;
}
function socMenteeHtml(D, handle){
  const back=`<a class="pz-back" href="#mentor">${pzI('back',20)}Mentees</a>`;
  if(!socAvailable()||!SOC.me||!SOC.me.mentor)return socMentorHtml(D);
  const c=socGet('mentee:'+handle.toLowerCase(),'/mentor/'+encodeURIComponent(handle),20000), m=c&&c.d&&c.d.mentee;
  if(!m)return `${back}<p class="pz-sub">${c&&c.err?esc(c.err):'<span class="pz-spin"></span>Loading…'}</p>`;
  const notesBy={}; for(const n of m.notes)(notesBy[n.day||'']=notesBy[n.day||'']||[]).push(n);
  const pg=pzPage('mentee:'+handle,m.days,10);
  const row=d=>`<section class="pz-card pz-kv"><div class="pz-kvrow"><b>${esc(dayLabel(d.k))}</b><b style="color:${PZ_COL[pzBand(d.s)]}">${d.s}</b></div>
    <span class="pz-sub" style="font-size:13px">${d.f.length?esc(d.f.map(k=>SOC_SLIP_SHORT[k]||k).join(' · ')):'No slips'}${d.r?' · reviewed':''}${d.j?' · journaled':''}</span>
    ${d.l?`<p style="margin:0;font-size:14px">“${esc(d.l)}”</p>`:''}
    ${(notesBy[d.k]||[]).map(n=>`<div class="pz-quote">${esc(n.text)} <span class="pz-sub" style="font-size:11px">— @${esc(n.by)}, ${socAgo(n.at)}${n.by===SOC.me.handle?` · <button type="button" class="pz-linkbtn" data-soc-ndel="${esc(n.id)}" data-h="${esc(m.handle)}">Delete</button>`:''}</span></div>`).join('')}
    ${pzS.noteFor===d.k?`<div class="pz-field"><label for="socNoteIn" class="pz-sr">Note</label><textarea id="socNoteIn" rows="2" maxlength="600" placeholder="What you see, and one thing to try"></textarea></div>
      <div style="display:flex;gap:8px"><button type="button" class="pz-cta pz-sm" style="flex:1;min-height:40px" data-soc-nsend="${esc(d.k)}" data-h="${esc(m.handle)}">Send note</button><button type="button" class="pz-ghost pz-sm" style="flex:1" data-soc-notefor="">Cancel</button></div>`
      :`<button type="button" class="pz-linkbtn" style="align-self:flex-start" data-soc-notefor="${esc(d.k)}">Add a note on this day</button>`}</section>`;
  return `${back}${pzHead('Level '+m.level+' · '+m.streak+'-day streak','@'+m.handle)}
    <div class="pz-wide"><div class="pz-col">${m.days.length?pg.items.map(row).join('')+pg.html:'<section class="pz-card"><p class="pz-sub">No trading days shared yet.</p></section>'}</div>
    <div class="pz-col"><section class="pz-card pz-kv"><b class="pz-kvh">At a glance</b><div class="pz-row-t"><span>7-day discipline</span><b>${m.avg7==null?'—':m.avg7}</b></div><div class="pz-row-t"><span>Slips, 7 days</span><b>${m.slips7}</b></div><div class="pz-row-t"><span>Best streak</span><b>${m.best}</b></div>
      ${m.challenge?`<div class="pz-row-t"><span>Last challenge</span><b>${esc(m.challenge)}</b></div>`:''}${m.habits.length?`<p class="pz-sub" style="font-size:13px">Habits: ${m.habits.map(esc).join(' · ')}</p>`:''}</section>
      ${(notesBy['']||[]).length?`<section class="pz-card pz-kv"><b class="pz-kvh">General notes</b>${notesBy[''].map(n=>`<div class="pz-quote">${esc(n.text)}</div>`).join('')}</section>`:''}
      <p class="pz-fine">You see what @${esc(m.handle)} chose to share with mentors: scores, slips and their nightly lesson. Trades only when they send one for review (under Trades to review); never wallets.</p></div></div>`;
}

// ---- reminders: web push to this device, on the member's clock ----
function pzPushHtml(){
  if(!SOC.me||!SOC.me.push||!SOC.me.push.available)return '';
  const ok='serviceWorker' in navigator&&'PushManager' in window&&typeof Notification!=='undefined';
  const P=SOC.me.push, on=!!PZ_PUSH.sub, pr=P.prefs||{};
  return `<section><span class="pz-lbl" style="color:var(--pz-muted)">Reminders</span>
    ${!ok?'<p class="pz-sub" style="margin-top:6px;font-size:13px">This browser can’t receive push reminders. On iPhone, add Keel to your Home Screen first, then open it from there.</p>'
    :`<div class="pz-toggle"><span style="flex:1"><b id="pzPushL">Remind me on this device</b><span>Morning prep, evening review, and nudges or notes from partners and mentors</span></span><button type="button" role="switch" class="pz-switch" id="pzPushOn" aria-checked="${!!on}" aria-labelledby="pzPushL"><i></i></button></div>
      ${on?`<div style="display:flex;gap:10px"><div class="pz-field" style="flex:1"><label for="pzPushAm" style="font-size:13px">Morning</label><input type="time" id="pzPushAm" value="${esc(pr.morning||'08:30')}"></div><div class="pz-field" style="flex:1"><label for="pzPushPm" style="font-size:13px">Evening</label><input type="time" id="pzPushPm" value="${esc(pr.eod||'20:30')}"></div></div>
        <div class="pz-toggle"><span style="flex:1"><b id="pzPushTiltL">Tilt alerts while Keel is closed</b><span>${SOC.share&&SOC.share.verify?'Read from your public fills every few minutes':'Needs verified Discipline (Sharing), so the server can read your fills'}</span></span><button type="button" role="switch" class="pz-switch" data-pz-ta="push" aria-checked="${pr.tilt!==false}" aria-labelledby="pzPushTiltL"><i></i></button></div>
        <button type="button" class="pz-linkbtn" id="pzPushTest" style="margin-top:6px">Send a test</button>`:''}`}</section>`;
}
const PZ_PUSH={sub:null,checked:false};
async function pzPushCheck(){ if(PZ_PUSH.checked||!('serviceWorker' in navigator)||!('PushManager' in window))return; PZ_PUSH.checked=true;
  try{ const reg=await navigator.serviceWorker.getRegistration(); PZ_PUSH.sub=reg?await reg.pushManager.getSubscription():null; }catch(e){} }
const pzB64=s=>{ s=String(s).replace(/-/g,'+').replace(/_/g,'/'); const b=atob(s+'='.repeat((4-s.length%4)%4)); return Uint8Array.from(b,c=>c.charCodeAt(0)); };
async function pzPushToggle(on){
  if(!on){ const sub=PZ_PUSH.sub; PZ_PUSH.sub=null; let r=null; if(sub){ try{ r=await socFetch('/push/remove',{method:'POST',body:JSON.stringify({endpoint:sub.endpoint})}); }catch(e){} try{ await sub.unsubscribe(); }catch(e){} }
    SOC.me.push.on=!!(r&&r.on); pzNote('Reminders are off on this device.'); return; }
  if(Notification.permission!=='granted'&&await Notification.requestPermission()!=='granted'){ pzNote('Notifications are blocked for this site — allow them in your browser’s site settings.','err'); return; }
  const k=await socFetch('/push'); let reg=await navigator.serviceWorker.getRegistration(); if(!reg)reg=await navigator.serviceWorker.register('/sw.js'); await navigator.serviceWorker.ready;
  const sub=await reg.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:pzB64(k.key)});
  const tz=pzClockZone(); const r=await socFetch('/push',{method:'POST',body:JSON.stringify({subscription:sub.toJSON(),prefs:SOC.me.push.prefs||{}})});
  PZ_PUSH.sub=sub; SOC.me.push.on=true; SOC.me.push.prefs=r.prefs; pzNote('Reminders on. Times follow your '+tz+' clock.');
}

// ---- readiness from a wearable: WHOOP, Oura, or Apple Health through a Shortcut ----
const WEAR={st:null,at:0,busy:false,err:null,apple:null};
async function wearFetch(p,o){ o=o||{};
  o.headers=Object.assign({},o.body?{'Content-Type':'application/json'}:{},SOC.key?{'X-Pulse-Key':SOC.key}:SRV.token&&!SRV.badAuth?{Authorization:'Bearer '+SRV.token}:{},o.headers||{});
  const r=await fetch('/api/wear'+p,o); let d={}; try{ d=await r.json(); }catch(e){}
  if(!r.ok)throw Object.assign(new Error(d.error||('HTTP '+r.status)),{status:r.status}); return d; }
const wearOk=()=>socAvailable()&&(!!SOC.key||!!(SRV.token&&!SRV.badAuth));
// once a session and then every 30 minutes: what the wearables say, written into each day's journal entry
async function pzWearSync(force){
  if(WEAR.busy||!wearOk()||(!force&&Date.now()-WEAR.at<30*60000))return; WEAR.busy=true;
  try{ let st=await wearFetch(''); const any=['whoop','oura'].some(p=>st.providers[p]&&st.providers[p].connected);
    if(any)st=await wearFetch('/sync',{method:'POST'});
    WEAR.st=st; WEAR.err=null; let ch=false;
    for(const d of st.days||[]){ if(d.score==null&&d.hrv==null&&d.sleepH==null)continue; const k='day:'+d.k, e=journal[k]||{};
      const w={score:d.score==null?null:Math.round(d.score),hrv:d.hrv==null?null:d.hrv,rhr:d.rhr==null?null:d.rhr,sleepH:d.sleepH==null?null:d.sleepH,src:d.src};
      if(JSON.stringify(e.wear||null)!==JSON.stringify(w)){ journal[k]=Object.assign({},e,{wear:w}); markJEdit(k); ch=true; } }
    if(ch){ await Store.set(J_KEY,journal); }
  }catch(e){ WEAR.err=e.status===401?null:e.message; }
  finally{ WEAR.at=Date.now(); WEAR.busy=false; if(PZ)pzRender(); }
}
const PZ_WEAR_NAME={whoop:'WHOOP',oura:'Oura',apple:'Apple Health'};
function pzWearHtml(D){
  if(!wearOk())return '';
  if(!WEAR.st){ pzWearSync(); return ''; }
  const P=WEAR.st.providers, w=(D.dayE||{}).wear, live=['whoop','oura','apple'].filter(p=>P[p]&&P[p].connected);
  const conn=['whoop','oura'].filter(p=>P[p]&&P[p].configured&&!P[p].connected);
  return `<section class="pz-card pz-kv"><div class="pz-kvrow"><b class="pz-kvh">Readiness from a wearable</b>${live.length?`<button type="button" class="pz-linkbtn" data-pz-wsync>Sync</button>`:''}</div>
    ${w&&w.score!=null?`<div class="pz-kvrow"><span class="pz-sub" style="font-size:13px">${esc(PZ_WEAR_NAME[w.src]||w.src)} today${w.hrv?' · HRV '+w.hrv+' ms':''}${w.rhr?' · resting HR '+w.rhr:''}${w.sleepH?' · '+w.sleepH+'h asleep':''}</span><b style="font-size:20px;color:${PZ_COL[pzBand(w.score)]}">${w.score}</b></div>
      <p class="pz-fine">Your readiness today comes from ${esc(PZ_WEAR_NAME[w.src]||w.src)}. The questions below still count for your bonus XP.</p>`
      :live.length?`<p class="pz-sub" style="font-size:13px">Connected: ${live.map(p=>esc(PZ_WEAR_NAME[p])).join(', ')}. Nothing for today yet${WEAR.st.syncedAt?' — last synced '+socAgo(WEAR.st.syncedAt)+' ago':''}.</p>`
      :'<p class="pz-sub" style="font-size:13px">Let your sleep and recovery set your readiness, and see on Stats which days your discipline breaks.</p>'}
    ${live.filter(p=>P[p].err).map(p=>`<p class="pz-fine pz-err">${esc(P[p].err)}</p>`).join('')}${['whoop','oura'].filter(p=>!P[p].connected&&P[p].err).map(p=>`<p class="pz-fine pz-err">${esc(P[p].err)}</p>`).join('')}
    <div style="display:flex;gap:8px;flex-wrap:wrap">${conn.map(p=>`<button type="button" class="pz-ghost pz-sm" style="width:auto;padding:0 14px" data-pz-wcon="${p}">Connect ${PZ_WEAR_NAME[p]}</button>`).join('')}
      ${live.map(p=>`<button type="button" class="pz-linkbtn" data-pz-wdis="${p}">Disconnect ${PZ_WEAR_NAME[p]}</button>`).join('')}
      ${P.apple&&!P.apple.connected?`<button type="button" class="pz-ghost pz-sm" style="width:auto;padding:0 14px" data-pz-wapple>Apple Health</button>`:''}</div>
    ${WEAR.apple?`<div class="pz-field"><label for="pzWAppleUrl" style="font-size:13px">Your personal link — keep it private</label><input type="text" id="pzWAppleUrl" readonly value="${esc(WEAR.apple)}"></div>
      <ol class="pz-sub" style="font-size:13px;margin:0;padding-left:18px;line-height:1.5"><li>In the Shortcuts app, make a shortcut that finds today’s Heart Rate Variability, Resting Heart Rate and Sleep from Health.</li><li>Add “Get Contents of URL”: this link, method POST, JSON body <code>{"hrv":…, "restingHR":…, "sleepHours":…}</code>.</li><li>Run it from an Automation each morning.</li></ol>`:''}
    ${!conn.length&&!live.length&&!P.whoop.configured&&!P.oura.configured?'<p class="pz-fine">WHOOP and Oura need the server owner to add their app keys (WHOOP_CLIENT_ID / OURA_CLIENT_ID).</p>':''}</section>`;
}

// ---- Today: live heads-ups, good moments, the evening review and the coach ----
function pzNudgesHtml(D){
  let n=[]; try{ n=pzNudges(D); }catch(e){ console.warn('nudges failed',e); }
  return n.map(x=>`<section class="pz-card pz-nudge ${x.tone}" role="status"><span class="pz-ico">${pzI(x.tone==='good'?'check':'bolt',18)}</span><p>${esc(x.text)}</p></section>`).join('');
}
function pzTodayExtrasHtml(D){
  const g=D.g, h=tzParts(Date.now()).h, e=D.dayE||{}, done=!!(e.eod&&e.eod.at), traded=D.risk.trades>0||D.todayTrades.length>0;
  let gm=[]; try{ gm=pzGoodMoments(g,D.todayK); }catch(err){}
  const good=gm.length?`<section class="pz-card pz-kv pz-goodcard"><span class="pz-lbl" style="color:${PZ_COL.good}">Done right today</span>${gm.slice(0,3).map(m=>`<div class="pz-moment"><span class="pz-bc done">${pzI('check',12,3)}</span><b style="font-size:13px;font-weight:600">${esc(m.text)}</b></div>`).join('')}</section>`:'';
  const lockR=pzLocked('review',g.level.level);
  const review=!lockR&&(traded||h>=16)?`<a class="pz-card pz-cardlink" href="#review"><span class="pz-ico" style="background:var(--pz-tint-good);color:${PZ_COL.good}">${pzI(done?'check':'pen',20)}</span>
    <span style="flex:1;min-width:0;display:flex;flex-direction:column;gap:2px"><b style="font-size:15px">${done?'Day reviewed':'End-of-day review'}</b><span class="pz-sub" style="font-size:12px">${done?(e.eod.tomorrow?'Tomorrow: '+esc(e.eod.tomorrow):'Saved — edit any time tonight'):(D.day?'Five minutes, +'+pzXpCfg().review+' XP. ':'Five minutes. ')+'One lesson, one focus for tomorrow.'}</span></span>${pzI('chev',18)}</a>`:'';
  const coach=pzCoachAvailable()&&!pzLocked('coach',g.level.level)?`<a class="pz-card pz-cardlink" href="#coach"><span class="pz-ico" style="background:var(--pz-tint-xp);color:${PZ_COL.xp}">${pzI('coach',20)}</span>
    <span style="flex:1;min-width:0"><b style="font-size:15px">Ask your coach</b><span class="pz-sub" style="display:block;font-size:12px">${COACH.status&&COACH.status.remaining!=null?COACH.status.remaining+' message'+(COACH.status.remaining===1?'':'s')+' left today':'About your day, your leaks, your plan'}</span></span>${pzI('chev',18)}</a>`:'';
  pzCoachStatus();
  return good+review+coach;
}
// ---- the morning: your profile's questions, last night's focus, today's rules ----
// Your usual answers to one morning question, once you've answered it on enough days to have usuals:
// answers you gave at least twice (case and spacing aside), most used first, then most recent. For a
// question about setups, your playbooks and most-journaled setups are offered too.
const PZ_USUAL_AFTER=5;
function pzUsualAnswers(J, q, todayK, setups){
  const days=Object.keys(J||{}).filter(k=>k.startsWith('day:')&&k.slice(4)<todayK).sort().reverse();
  const said=[]; for(const k of days){ const a=J[k]&&J[k].am&&J[k].am[q]; if(typeof a==='string'&&a.trim())said.push(a.trim().replace(/\s+/g,' ')); if(said.length>=90)break; }
  if(said.length<PZ_USUAL_AFTER)return [];
  const by=new Map(); said.forEach((a,i)=>{ const k=a.toLowerCase(), o=by.get(k); if(o)o.n++; else by.set(k,{text:a,n:1,last:i}); });
  const out=[...by.values()].filter(x=>x.n>=2).sort((a,b)=>b.n-a.n||a.last-b.last).slice(0,4).map(x=>({text:x.text,n:x.n}));
  if(/setup/i.test(q))for(const s of (setups||[]).slice(0,3))if(out.length<5&&!out.some(x=>x.text.toLowerCase()===s.toLowerCase()))out.push({text:s,n:0,setup:true});
  return out;
}
function pzMorningHtml(D, ck){
  const prof=pzProfile(D.ctx.closed), prevK=D.g.days.filter(d=>d.key<D.todayK).slice(-1)[0], pe=prevK?((journal['day:'+prevK.key]||{}).eod||null):null;
  const qs=prof.morning.map((q,i)=>{ const cur=(ck.am||{})[q]||'', us=pzUsualAnswers(journal,q,D.todayK,/setup/i.test(q)?pzSetups():null);
    return `<div class="pz-field"><label for="pzAm${i}" style="font-size:13px">${esc(q)}</label><input type="text" id="pzAm${i}" data-pz-am="${esc(q)}" maxlength="300" value="${esc(cur)}">
    ${us.length?`<div class="pz-usual" role="group" aria-label="Your usual answers"><span class="pz-fine">Your usuals:</span>${us.map(u=>`<button type="button" class="pz-chipbtn${cur.trim().toLowerCase()===u.text.toLowerCase()?' ok':''}" data-pz-amfill="${i}" data-v="${esc(u.text)}" title="${esc(u.text)}${u.n?' · used '+u.n+' times':' · one of your setups'}">${esc(u.text.length>48?u.text.slice(0,46)+'…':u.text)}</button>`).join('')}</div>`:''}</div>`; }).join('');
  return `<section class="pz-card pz-kv"><div class="pz-kvrow"><span class="pz-lbl" style="color:var(--pz-acc)">${esc(prof.name)} routine</span><button type="button" class="pz-linkbtn" data-pz-sheet>Change</button></div>
    <span class="pz-sub" style="font-size:13px">${esc(prof.tip)}</span>
    ${pe&&pe.tomorrow?`<div class="pz-focusline"><span class="pz-lbl" style="font-size:11px;color:var(--pz-muted)">Last night you said</span><b>${esc(pe.tomorrow)}</b></div>`:''}
    ${qs}</section>`;
}
function pzProfilePickHtml(){
  let g=null; try{ g=gameContext(); }catch(e){} if(!g)return '';
  const prof=pzProfile(g.ctx.closed), custom=(SOC.cfg&&SOC.cfg.profiles&&SOC.cfg.profiles.custom)||[], cur=settings.pzProfile||'auto';
  const det=prof.detected?PZ_ROUTINES[prof.detected].name:null;
  return `<section><span class="pz-lbl" style="color:var(--pz-muted)">Trader profile</span>
    <div class="pz-field" style="margin-top:6px"><label for="pzProf" style="font-size:13px">Your routines and review questions follow it</label>
    <select id="pzProf">${[['auto','Automatic'+(det?' — looks like '+det.toLowerCase():'')],...Object.keys(PZ_ROUTINES).map(k=>[k,PZ_ROUTINES[k].name+' — '+PZ_ROUTINES[k].desc.toLowerCase()]),...custom.map(c=>[c.id,c.name+(c.desc?' — '+c.desc:'')])]
      .map(([v,l])=>`<option value="${esc(v)}"${v===cur?' selected':''}>${esc(l)}</option>`).join('')}</select></div></section>`;
}

// clicks on the growth screens: badges, plugs, reports, review, coach, plan rules, setups
async function pzGrowthAction(t){
  const ds=t.dataset;
  try{
    if(ds.pzBk){ pzS.bk=ds.pzBk; pzRender(); return true; }
    if(ds.pzQuiet){ await pzQuietAction(ds.pzQuiet); return true; }
    if(ds.pzTa){ await pzTaAction(ds.pzTa); return true; }
    if(ds.pzWk){ await pzWkAction(ds.pzWk); return true; }
    if(ds.pzWsync!==undefined){ pzNote('Syncing…','busy'); await pzWearSync(true); pzNote('Synced.'); return true; }
    if(ds.pzWcon){ const r=await wearFetch('/'+ds.pzWcon+'/start',{method:'POST'}); location.href=r.url; return true; }
    if(ds.pzWdis){ if(!confirm('Disconnect '+PZ_WEAR_NAME[ds.pzWdis]+'? Its days stay in your journal.'))return true; WEAR.st=await wearFetch('/'+ds.pzWdis,{method:'DELETE'}); WEAR.apple=null; pzRender(); return true; }
    if(ds.pzWapple!==undefined){ const r=await wearFetch('/apple/token',{method:'POST'}); WEAR.apple=r.url; WEAR.st=await wearFetch(''); pzRender(); const n=$('pzWAppleUrl'); if(n){ n.focus(); n.select(); } return true; }
    if(t.id==='pzPushOn'){ await pzPushToggle(t.getAttribute('aria-checked')!=='true'); pzRender(); return true; }
    if(t.id==='pzPushTest'){ await socFetch('/push/test',{method:'POST'}); pzNote('Sent — it should arrive in a few seconds.'); return true; }
    if(ds.pzLesson){ if(ds.pzLesson==='off'&&!confirm('Remove this lesson from your library?'))return true;
      await pzLessonMark(ds.id,ds.pzLesson); pzNote(ds.pzLesson==='got'?'Kept. It comes back later.':ds.pzLesson==='again'?'It comes back tomorrow.':ds.pzLesson==='back'?'Back in rotation.':'Removed.'); pzRender(); return true; }
    if(ds.pzLf){ pzS.lf=ds.pzLf; pzRender(); return true; }
    if(ds.pzGoaldel){ const go=pzGoalList().find(x=>x.id===ds.pzGoaldel); if(!go)return true;
      if(!go.done&&!go.missed&&!confirm('Drop this goal?'))return true;
      if(go.done)go.cleared=Date.now(); else go.dropped=Date.now(); go.at=Date.now(); await Store.set(S_KEY,settings); pzRender(); return true; }
    if(t.id==='pzGnew'){ pzS.goalNew={kind:'disc',target:80,slip:'revenge'}; pzRender(); const n=$('pzGk'); if(n)n.focus(); return true; }
    if(t.id==='pzGcancel'){ pzS.goalNew=null; pzRender(); return true; }
    if(t.id==='pzGsave'&&pzS.goalNew){ const f=pzS.goalNew, K=PZ_GOAL_KINDS[f.kind], today=dayKey(Date.now());
      const go={id:'g'+Date.now().toString(36),kind:f.kind,target:+f.target||K.targets[0],start:today,createdAt:Date.now()};
      if(K.month)go.month=today.slice(0,7); if(f.kind==='noslip')go.slip=f.slip||'revenge';
      settings.pzGoals=(Array.isArray(settings.pzGoals)?settings.pzGoals:[]).filter(x=>x&&typeof x==='object').concat([go]).slice(-40); pzS.goalNew=null;
      await Store.set(S_KEY,settings); pzNote('Goal set: '+K.title(go)+'.'); pzRender(); return true; }
    if(t.id==='pzLadd'){ const el=$('pzLnew'), v=(el&&el.value||'').trim(); if(v.length<3)return true;
      const st=settings.pzLessons=pzLessonsNorm(settings.pzLessons); st.own=st.own.concat([{id:'u:'+Date.now().toString(36),text:v.slice(0,200),at:Date.now()}]).slice(-300);
      await Store.set(S_KEY,settings); if(el)el.value=''; pzNote('Added. It comes back tomorrow.'); pzRender(); return true; }
    if(t.id==='pzTiltNotify'){ const on=t.getAttribute('aria-checked')!=='true';
      if(on&&typeof Notification!=='undefined'&&Notification.permission!=='granted'){ const r=await Notification.requestPermission();
        if(r!=='granted'){ pzNote('Notifications are blocked for this site — allow them in your browser’s site settings.','err'); return true; } }
      settings.pzTiltNotify=on; await Store.set(S_KEY,settings); pzRender(); return true; }
    if(ds.pzMk){ settings.pzMarket=ds.pzMk; await Store.set(S_KEY,settings); pzRender(); return true; }
    if(ds.pzPg!=null){ PZ_PAGES[ds.pzPg]=Math.max(0,(PZ_PAGES[ds.pzPg]||0)+(+ds.d||0)); pzRender(); const n=document.querySelector('[data-pz-pg="'+CSS.escape(ds.pzPg)+'"]'); if(n){ const list=n.closest('nav').previousElementSibling; if(list&&list.scrollIntoView)list.scrollIntoView({block:'nearest'}); } return true; }
    if(ds.pzPlug){ await pzPlugStart(ds.pzPlug); pzNote('Plugging “'+PZ_BEH[ds.pzPlug].toLowerCase()+'”. It’s checked from your fills — three clean trading weeks in a row plug it.'); pzRender(); return true; }
    if(ds.pzImpadopt!=null){ const c=PEER.d&&PEER.d.improvers&&PEER.d.improvers.changes[+ds.pzImpadopt], h=peerImpHabit(c); if(!h)return true;
      const x=await peerImpAdopt(h), hb=x&&x.habitId?habitById(x.habitId):x; pzNote('Added to your habits'+(hb&&hb.when?': “'+habitSentence(hb)+'”':'')+' It’s tracked day by day.'); pzRender(); return true; }
    if(ds.pzUnplug){ if(!confirm('Stop plugging this leak? Its habit is retired.'))return true; await pzPlugDrop(ds.pzUnplug); pzRender(); return true; }
    if(ds.pzBcat){ pzS.bcat=ds.pzBcat; pzRender(); return true; }
    if(ds.pzBsel){ pzS.badgeSel=pzS.badgeSel===ds.pzBsel?null:ds.pzBsel; pzRender(); return true; }
    if(ds.pzPage){ const on=ds.pzPage==='1', share={...(SOC.share||SOC_DEFAULT_SHARE),page:on};
      const r=await socFetch('/me',{method:'PUT',body:JSON.stringify({share})}); SOC.me=r.me; PZ_CFG.rev++; SOC.share=r.share; pzNote(on?'Your public badge page is live.':'Your badge page is private again.'); pzRender(); return true; }
    if(ds.pzRk){ pzS.rk=ds.pzRk; pzS.rkey=null; pzRender(); return true; }
    if(ds.pzRkey!==undefined){ if(ds.pzRkey){ pzS.rkey=ds.pzRkey; pzRender(); } return true; }
    if(ds.pzRvrate&&pzS.rv){ const n=+ds.pzRvrate; pzS.rv.rating=pzS.rv.rating===n?null:n; t.closest('.pz-pills').querySelectorAll('button').forEach(b=>b.setAttribute('aria-checked',String(+b.dataset.pzRvrate===pzS.rv.rating))); return true; }
    if(ds.pzAsk){ await pzCoachSend(ds.pzAsk); return true; }
    if(ds.pzCdetail!==undefined){ const on=t.getAttribute('aria-checked')!=='true';
      if(SOC.me){ const r=await socFetch('/me',{method:'PUT',body:JSON.stringify({coachDetail:on})}); SOC.me=r.me; PZ_CFG.rev++; COACH.tried=false; pzCoachStatus(true); }
      else { settings.pzCoachDetail=on; await Store.set(S_KEY,settings); }
      t.setAttribute('aria-checked',String(on)); pzRender(); return true; }
    if(ds.pzRule&&pzS.ck){ const R=pzS.ck.rules=pzS.ck.rules||{}, k=ds.pzRule;
      if(k==='stop2'||k==='noAdd'){ R[k]=!R[k]; t.setAttribute('aria-checked',String(R[k])); }
      else if(k==='lossStreak'||k==='wait'){ R[k]=+ds.v||0; if(k==='lossStreak')R.stop2=false; t.parentNode.querySelectorAll('button').forEach(b=>b.setAttribute('aria-pressed',String(b===t))); }
      else { const a=R[k]=Array.isArray(R[k])?R[k]:[], v=ds.v, i=a.indexOf(v); if(i>=0)a.splice(i,1); else a.push(v); t.setAttribute('aria-pressed',String(i<0)); }
      return true; }
    if(t.id==='pzSetupAddGo'&&pzS.ck){ const inp=$('pzSetupAdd'), v=pzCanonSetup(inp&&inp.value||''); if(!v)return true;
      const R=pzS.ck.rules=pzS.ck.rules||{}; R.setups=Array.isArray(R.setups)?R.setups:[]; if(!R.setups.includes(v))R.setups.push(v); inp.value=''; pzRender(); const n=$('pzSetupAdd'); if(n){ n.value=''; n.focus(); } return true; }
    if(ds.pzSetupchip){ const sec=t.closest('[data-pz-trade]'), inp=sec&&sec.querySelector('input[type=text]'); if(inp){ inp.value=ds.pzSetupchip; inp.focus(); } return true; }
    switch(t.id){
      case 'pzRvSave': await pzSaveReview(); return true;
      case 'pzRvCoach': await pzSaveReview(); location.hash='#coach'; await pzCoachSend('Review my day. Here are my answers from tonight’s review — what went well, the one thing to fix, and my focus for tomorrow.'); return true;
      case 'pzCoachSend': { const el=$('pzCoachIn'); const v=el?el.value:''; if(el)el.value=''; await pzCoachSend(v); return true; }
      case 'pzCoachClear': if(confirm('Clear this chat on this device?')){ COACH.msgs=[]; pzCoachSave(); pzRender(); } return true;
      case 'pzBadgeLink': { const u=location.origin+'/b/'+SOC.me.handle; if(navigator.share)navigator.share({title:'My trading badges on Keel',url:u}).catch(()=>{});
        else try{ await navigator.clipboard.writeText(u); pzNote('Link copied: '+u); }catch(e){ pzNote(u); } return true; }
      case 'pzBadgeImg': await pzBadgeCardImage(); return true;
      case 'pzReportShare': await pzShareReport(); return true;
    }
  }catch(e){ pzNote(e.message||String(e),'err'); return true; }
  return false;
}
