/* ============================================================================
   Celebrate — a moment on screen when something worth it happens: a level, a perfect week, a
   discipline-streak mark, an achievement, a completed challenge or a new badge.
   A feature in its own file: it plugs into Daruma through pzFeature (app/pulse.js) and loads on
   Daruma's page only (data-only="keel" in ledger.html).

   After each draw (pzFeature drawn), the game as it stands now is compared with what this device last
   celebrated (localStorage 'pzCele'): what's new becomes one moment, the biggest, with the rest named
   under it. The first look on a device only notes where things stand, so opening Daruma on a new phone
   never replays a year of badges. Only things earned in the last few days count (a history that merges
   in behind the first draw finds old badges: those aren't news), and a level that jumps by more than
   three at once (a profile's server XP arriving) is taken as it is, quietly. Never in sample mode,
   never while trades are loading or a sheet is open, and only on Today, Progress, Badges and report
   cards, so it never lands in the middle of journaling or a form. Rewards process only: nothing here
   is about profit.
   ============================================================================ */
const CELE_KEY='pzCele', CELE_STREAK=[5,10,20,30,50,75,100,150,200,365], CELE_TABS=['today','progress','badges','report'];
let _celeOpen=false;
// what the game holds now, in the shape the snapshot keeps
function celeSnap(g, E){
  return {lv:+(g.level&&g.level.level)||1,st:+(g.streak&&g.streak.current)||0,pw:(g.streak&&g.streak.perfectWeeks||[]).length,
    keys:Object.keys(E||{}).filter(k=>/^[abc]:/.test(k)).sort()}; }
// The moments between two snapshots, biggest first. names: {id -> {t, r}} for badges and achievements;
// E: the award ledger (its 'at' day says when each was earned); since: the oldest day still news.
function celeMoments(prev, cur, E, names, since){
  if(!prev)return [];
  const out=[], add=(o)=>out.push(o);
  const dl=cur.lv-(+prev.lv||1); if(dl>0&&dl<=3)add({k:'level',rank:100,icon:'up',kicker:'Level up',title:'Level '+cur.lv,sub:names.levelTitle?'You’re '+names.levelTitle+' now. Every point of it came from process, not profit.':'Every point of it came from process, not profit.'});
  if(cur.pw>(+prev.pw||0))add({k:'perfect',rank:80,icon:'shield',kicker:'Perfect week',title:'Every trading day at 70+',sub:'That earns a streak shield: it covers one off day.'});
  const mk=CELE_STREAK.filter(m=>(+prev.st||0)<m&&cur.st>=m).pop();
  if(mk)add({k:'streak',rank:70,icon:'flame',kicker:'Discipline streak',title:mk+' clean days in a row',sub:'Trading days at Discipline 70+. Days you don’t trade never break it.'});
  const had=new Set(prev.keys||[]);
  for(const id of cur.keys){ if(had.has(id))continue; const e=E[id], at=e&&e.at; if(!at||at<since)continue;
    const n=names[id.slice(2)]||{};
    if(id[0]==='a')add({k:'achievement',rank:60,icon:'medal',kicker:'Achievement',title:n.t||'Achievement unlocked',sub:n.d||''});
    else if(id[0]==='c')add({k:'challenge',rank:55,icon:'target',kicker:'Weekly challenge',title:'Challenge complete',sub:'+'+(+(e&&e.xp)||0)+' XP. A new one comes on Monday.'});
    else { const r=+n.r||0; add({k:'badge',rank:30+r*5,icon:'medal',kicker:'New badge'+(typeof PZ_TIERS!=='undefined'&&PZ_TIERS[r]?' · '+PZ_TIERS[r]:''),title:n.t||'Badge',sub:n.d||'',tier:r}); } }
  return out.sort((a,b)=>b.rank-a.rank); }
function celeLoad(){ try{ const v=JSON.parse(localStorage.getItem(CELE_KEY)||'null'); return v&&typeof v==='object'?v:null; }catch(e){ return null; } }
function celeSave(v){ try{ localStorage.setItem(CELE_KEY,JSON.stringify(v)); }catch(e){} }
function celeCheck(D, tab){
  if(_celeOpen||!D||!D.g||!CELE_TABS.includes(tab))return;
  if((typeof isDemoData==='function'&&isDemoData())||(typeof _loading!=='undefined'&&_loading))return;
  if(pzS.sheet||pzS.custom||document.hidden)return;
  const g=D.g, E=typeof pzEarned==='function'?pzEarned():{}, cur=celeSnap(g,E), reset=+settings.pzEarnedResetAt||0;
  const prev=celeLoad();
  // a first look, or the award ledger reset since: note where things stand, say nothing
  if(!prev||(+prev.reset||0)!==reset){ celeSave(Object.assign({},cur,{reset})); return; }
  const names={levelTitle:g.level&&g.level.title};
  for(const a of (g.achievements||[]))names[a.id]={t:a.title,d:a.desc||''};
  for(const b of ((g.catalog&&g.catalog.earned)||[]))names[b.id]={t:String(b.t||'').replace(/ · .*/,''),d:b.desc||'',r:b.r};
  const since=typeof pzAddDays==='function'?pzAddDays(dayKey(Date.now()),-3):'';
  const M=celeMoments(prev,cur,E,names,since);
  // a level or perfect-week count that dips (late fills, a day scored again) and comes back isn't news twice
  celeSave({lv:Math.max(cur.lv,+prev.lv||0),st:cur.st,pw:Math.max(cur.pw,+prev.pw||0),keys:[...new Set([...(prev.keys||[]),...cur.keys])].sort(),reset});
  if(M.length)celeShow(M);
}
// the burst: a few seconds of confetti in the app's own colours (none with reduced motion)
function celeBurst(host){
  const cv=document.createElement('canvas'); cv.className='pz-cele-fx'; cv.setAttribute('aria-hidden','true'); host.prepend(cv);
  const W=cv.width=innerWidth*(devicePixelRatio||1), H=cv.height=innerHeight*(devicePixelRatio||1), x=cv.getContext('2d'); if(!x)return;
  const cs=getComputedStyle($('pz')||document.body), cols=['--pz-good','--pz-xp','--pz-streak','--pz-mid','--pz-risk'].map(v=>cs.getPropertyValue(v).trim()).filter(Boolean);
  const s=devicePixelRatio||1, P=Array.from({length:140},(_,i)=>({x:W/2+(Math.random()-.5)*W*.3,y:H*.38,vx:(Math.random()-.5)*16*s,vy:(-6-Math.random()*14)*s,
    w:(5+Math.random()*6)*s,h:(8+Math.random()*8)*s,a:Math.random()*6.28,va:(Math.random()-.5)*.4,c:cols[i%cols.length]||'#B69CFF'}));
  const t0=performance.now();
  const step=t=>{ const dt=t-t0; if(dt>2600||!cv.isConnected){ cv.remove(); return; }
    x.clearRect(0,0,W,H); x.globalAlpha=dt>1800?Math.max(0,1-(dt-1800)/800):1;
    for(const p of P){ p.vy+=.45*s; p.vx*=.99; p.x+=p.vx; p.y+=p.vy; p.a+=p.va; x.save(); x.translate(p.x,p.y); x.rotate(p.a); x.fillStyle=p.c; x.fillRect(-p.w/2,-p.h/2,p.w,p.h); x.restore(); }
    requestAnimationFrame(step); };
  requestAnimationFrame(step);
}
function celeShow(M){
  const root=$('pz'); if(!root)return;
  const m=M[0], more=M.slice(1,4), back=document.activeElement, calm=matchMedia('(prefers-reduced-motion: reduce)').matches;
  const href=m.k==='badge'?'#badges':'#progress';
  const el=document.createElement('div'); el.className='pz-cele-bg'; el.id='pzCele';
  el.innerHTML=`<div class="pz-cele" role="dialog" aria-modal="true" aria-labelledby="pzCeleT" aria-describedby="pzCeleS">
      <span class="pz-cele-ico"${m.tier!=null&&typeof PZ_TIER_COL!=='undefined'?` style="color:${PZ_TIER_COL[m.tier]}"`:''}>${pzI(m.icon,40)}</span>
      <span class="pz-lbl">${esc(m.kicker)}</span><b id="pzCeleT">${esc(m.title)}</b>${m.sub?`<p id="pzCeleS">${esc(m.sub)}</p>`:'<p id="pzCeleS"></p>'}
      ${more.length?`<p class="pz-cele-more">Also: ${more.map(x=>esc(x.title)).join(' · ')}${M.length>4?' · and '+(M.length-4)+' more':''}</p>`:''}
      <div class="pz-cele-btns"><button type="button" class="pz-cta pz-sm" data-cele="ok">Nice</button><a class="pz-ghost pz-sm" href="${href}" data-cele="go">${m.k==='badge'?'See badges':'See progress'}</a></div></div>`;
  root.appendChild(el); _celeOpen=true;
  const close=()=>{ el.remove(); _celeOpen=false; document.removeEventListener('keydown',key,true); if(back&&back.isConnected&&back.focus)back.focus({preventScroll:true}); };
  const key=ev=>{ if(ev.key==='Escape'){ ev.preventDefault(); close(); } else if(ev.key==='Tab'){ const f=[...el.querySelectorAll('button,a')]; const i=f.indexOf(document.activeElement);
      if(ev.shiftKey&&i<=0){ ev.preventDefault(); f[f.length-1].focus(); } else if(!ev.shiftKey&&i===f.length-1){ ev.preventDefault(); f[0].focus(); } } };
  document.addEventListener('keydown',key,true);
  el.addEventListener('click',ev=>{ const b=ev.target.closest('[data-cele]'); if(b||ev.target===el)close(); });
  const ok=el.querySelector('[data-cele="ok"]'); if(ok)ok.focus({preventScroll:true});
  if(!calm){ celeBurst(el); try{ if(navigator.vibrate)navigator.vibrate([18,40,28]); }catch(e){} }
}
pzFeature({id:'celebrate',drawn:celeCheck});
