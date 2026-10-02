// Ledger app · part 13 of 15: Pulse social (leagues, competitions, following) and accounts (wallet claims, sign-in, encrypted sync).
// ledger.html loads the parts in order as classic scripts sharing one global scope. Code that
// runs while a part loads (not inside a function called later) may only use names declared in
// this part or an earlier one; the boot part runs last. See "Development and testing" in README.md.

/* ======================= 11b · PULSE SOCIAL: leagues, competitions, following ======================= */
// Talks to /api/social on the server that served the page (social.js). A member is a random
// key in this browser (X-Pulse-Key). Only the numbers in pzSocialStats() are sent on their own; the
// journal, notes and trades stay in the browser unless the member posts a trade or sends one to
// their mentors for review (reviews.js). Returns are read on the server from the
// chain, never sent from here. Sample data is never posted.
const SOC_KEY_STORE='pz_social_key';
const SOC_DEFAULT_SHARE={profile:true,boards:true,global:false,page:false,feed:true,habits:true,verify:true,ret:false,usd:false,addr:false,mentor:false,bench:true,duels:true,seek:false};
const SOC_SHARE_ROWS=[
  ['profile','Public profile','Your profile page: streak, discipline, badges. Name, level and league show wherever you appear'],
  ['boards','Process leaderboards','Weekly XP, discipline and streak boards in your leagues'],
  ['global','Global leaderboards','Appear on the server-wide boards, ranked against everyone who opted in, whatever their league'],
  ['page','Public badge page','A page anyone with the link can open: your badges, level and streak — no trades, P&L or wallet'],
  ['feed','Milestones in the feed','Level-ups, streaks, badges and challenges'],
  ['habits','Habits you run','Others can see and adopt them'],
  ['verify','Verify my discipline','The server reads your public fills to confirm your Discipline score — the discipline board only counts verified scores. The owner can see your address'],
  ['ret','Show % return','30-day return and drawdown, read from your first wallet on chain'],
  ['usd','Show dollar P&L','Reveals your account size to everyone',true],
  ['addr','Show wallet address','Anyone could look up every trade and balance',true],
  ['mentor','Let mentors see my days','Mentors the owner appointed see your scores, slips and the lesson you write each night, and can leave you notes. They see a trade only when you send it for review; never your wallet'],
  ['seek','Looking for an accountability partner','Shows you under “Looking for a partner” in Find people, so someone who wants one can ask you'],
  ['duels','Accept duel challenges','Other members can challenge you to a week or a month, 1 on 1, on Discipline, clean days, journaling or XP. Nothing starts until you accept; switch off to stop receiving challenges'],
  ['bench','Count me in “Traders like you”','An anonymous summary of your last 90 days (win rate, discipline, how much you journal; trade size only as a range) goes into peer groups of 25 or more, and is kept weekly for about 6 months to see what changed for traders who improved. Other members only ever see the groups, never you; the league’s owner and admins can see your own summary. No trades, coins, amounts or wallet. Switch off to be left out (your history is deleted, and it’s kept from the owner too)']];
const SOC_BOARDS=[['xp','Weekly XP'],['discipline','Discipline'],['streak','Streak'],['level','All-time XP'],['riskadj','Return / drawdown'],['ret','% Return'],['usd','$ P&L']];
const SOC_BOARD_NOTE={
  xp:'XP earned this week in your league — process, never profit. The top of the league moves up on Monday, the bottom moves down.',
  discipline:'Average Discipline score over the last 7 days, minimum 3 trading days — recomputed by the server from each trader’s own fills, so it can’t be typed in.',
  streak:'Current discipline streak: trading days in a row at 70+. Shields count; days off never break it.',
  level:'All the XP you’ve earned, by process.',
  riskadj:'30-day return divided by max drawdown, read on chain. Rewards making money without blowing up.',
  ret:'30-day return, read on chain. Over 25% drawdown drops you off this board.',
  usd:'30-day dollar P&L, read on chain. Only traders who opt in appear — it reveals account size.'};
const SOC_COMP_KIND={discipline:'Discipline',survivor:'Survivor',journal:'Journal streak',return:'Return under a drawdown cap'};
const SOC_COMP_HOW={
  discipline:'Your daily process score, averaged over the competition days. Profit doesn’t count: a red day with a clean process scores the same as a green one.',
  survivor:'Stay under your daily loss limit on every trading day. The first day you hit it, you’re out. Days you don’t trade are safe.',
  journal:'Journal every closed trade, day after day. Your longest run of fully journaled trading days counts.',
  return:'Return over the competition dates, read from your wallet on chain. Cross the drawdown cap at any point and you finish last.'};
const PZ_UNLOCK_DEFAULTS={unlocksOn:true,unlocks:{trends:2,share:3,compete:4}};
var SOC={cfg:null,cfgTried:false,key:null,me:null,share:null,sub:'league',board:'rank',cfilter:'mine',feed:'following',
  cache:{},busy:{},lastSent:'',lastSentAt:0,timer:null,draft:null,avs:{},more:{},upd:{},compose:null,confirm:null};
try{ SOC.key=localStorage.getItem(SOC_KEY_STORE)||null; }catch(e){}

// The numbers a member shares, from the shared game context. Pure given its inputs.
function pzSocialStats(g, habits, J, withLessons){
  const done=g.challenges.filter(c=>c.status==='done');
  return {xp:g.xp.total, level:g.level.level, week:g.nowWeek, weekXp:g.weekXp, tz:pzClockZone(),
    streak:g.streak.current, best:g.streak.best, shields:g.streak.shields,
    challengesDone:done.length, lastChallenge:done.length?habitSentence(done[done.length-1].ch.spec):'',
    badges:g.catalog?g.catalog.earned.map(b=>({id:b.id,t:b.t,c:b.c,r:b.r,k:b.k,d:b.desc||''})):g.achievements.filter(a=>a.at).map(a=>({id:a.id,t:a.title})),
    badgeN:g.catalog?g.catalog.earned.length:g.achievements.filter(a=>a.at).length, badgeTotal:g.catalog?g.catalog.total:0,
    habits:(habits||[]).slice(0,5),
    days:g.days.slice(-45).map(d=>{ const o={k:d.key,s:d.score,b:!!d.breached,j:d.parts.journal===1}, fl=(d.behavior&&d.behavior.flags)||{};
      const f=Object.keys(fl).filter(k=>fl[k]>0); if(f.length)o.f=f;
      const e=J&&J['day:'+d.key], v=e&&e.eod; if(v&&v.at)o.r=true; if(withLessons&&v&&v.lesson)o.l=String(v.lesson).slice(0,200);
      return o; }),
    xpDays:Object.fromEntries(Object.entries((g.xp&&g.xp.byDay)||{}).filter(([k,v])=>v>0).sort().slice(-100))};
}
// The server only gets a wallet address when a toggle needs it — Verify my discipline (fills),
// % return or dollar P&L (portfolio), or Show wallet address; otherwise it never leaves the browser.
// (the first Hyperliquid wallet: the server reads returns and fills from Hyperliquid only)
function socWallet(){ return settings.wallets.find(w=>!/^(lighter|bybit|binance):/.test(String(w.address))); }
function socAddressFor(share){ const w=socWallet(); return w&&share&&(share.verify||share.ret||share.usd||share.addr)?w.address:null; }
// The IANA zone the app's day keys use, so the server scores the same calendar days.
function pzClockZone(){ try{ return settings&&settings.tz==='utc'?'UTC':Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC'; }catch(e){ return 'UTC'; } }
// "When X, Y." -> a self-graded habit spec (kept via the day journal's "I followed the plan").
function socHabitSpec(sentence){
  const s=String(sentence||'').trim(), m=s.match(/^when (.+?), (.+?)\.?$/i);
  return m?{kind:'self',when:m[1],then:m[2]}:{kind:'self',when:'I trade',then:s.replace(/\.$/,'')};
}
// Level-gated features. 0 = available; otherwise the level that unlocks it.
function pzUnlockCfg(){ return SOC.cfg||PZ_UNLOCK_DEFAULTS; }
function pzNeeds(feature, level, cfg, demo, unlocked){
  cfg=cfg||PZ_UNLOCK_DEFAULTS; if(!cfg.unlocksOn||demo||unlocked)return 0;
  const need=(cfg.modules||cfg.unlocks||{})[feature];
  return need>1&&level<need?need:0;
}
// Pulse's own check: the league's levels, unless the owner fully unlocked this member (or it's the
// owner, signed in without a member profile). Acting as a member, it's the member's own unlock that
// counts — the server holds a member's key to it, owner token or not.
function pzLocked(feature, level){ return pzNeeds(feature,level,pzUnlockCfg(),pzS.demo,SOC.me?!!SOC.me.unlocked:!!(SRV.token&&!SRV.badAuth)); }
function socValue(board,v){ if(v==null)return '—';
  if(board==='ret')return (v>=0?'+':'−')+Math.abs(v*100).toFixed(1)+'%';
  if(board==='usd')return signedPlain(v);
  if(board==='riskadj')return v.toFixed(1);
  return Math.round(v).toLocaleString(); }
function socAgo(ms){ const m=Math.max(0,Math.round((Date.now()-ms)/60000)); return m<1?'just now':m<60?m+'m':m<1440?Math.round(m/60)+'h':Math.round(m/1440)+'d'; }
function socAv(h,size){ const u=SOC.avs[String(h||'').toLowerCase()];
  if(u)return `<img class="pz-av" src="${esc(u)}" alt="" aria-hidden="true" loading="lazy" decoding="async"${size?` style="width:${size}px;height:${size}px"`:''}>`;
  const P=['#B69CFF','#5AA9FF','#FFB25A','#3FE0A0','#F4C04E','#FF9A7E','#9FB4C8'];
  let x=0; for(const c of String(h||''))x=(x*31+c.charCodeAt(0))>>>0;
  return `<span class="pz-av" aria-hidden="true" style="background:${P[x%P.length]}${size?`;width:${size}px;height:${size}px;font-size:${Math.round(size*0.36)}px`:''}">${esc(String(h||'?').slice(0,2).toUpperCase())}</span>`; }

function socAvailable(){ return /^https?:$/.test(location.protocol)&&SRV.enabled; }
async function socFetch(p,o){ o=o||{};
  o.headers=Object.assign({},o.body?{'Content-Type':'application/json'}:{},SOC.key?{'X-Pulse-Key':SOC.key}:{},o.headers||{});
  const r=await fetch('/api/social'+p,o);
  let d; try{ d=await r.json(); }catch(e){ if(r.ok)throw new Error('The server’s answer didn’t arrive in full. Try again.'); d={}; } // a cut-off body is never an empty success
  if(!r.ok){ const e=new Error(d.error||('HTTP '+r.status)); e.status=r.status; e.data=d; throw e; }
  socLearnAv(d,0); return d; }
function socBoot(){
  if(SOC.cfgTried||!socAvailable())return; SOC.cfgTried=true;
  socFetch('/config').then(c=>{ SOC.cfg=c; pzApplyCfg(c); if(!SOC.key)return;
    socMeWatch();
    return socFetch('/me').then(d=>{ SOC.me=d.me; SOC.share=d.share; PZ_CFG.rev++; },e=>{
      if(e.status===401||e.status===403){ SOC.key=null; vaultForget(); try{ localStorage.removeItem(SOC_KEY_STORE); }catch(_){} if(e.status===403)pzNote(e.message,'err'); } }); })
    .catch(()=>{}).finally(()=>{ if(PZ)pzRender(); else if(typeof allTrades!=='undefined'&&allTrades.length)render(); });
}
// What the owner changes for a member (an XP grant, a reward badge, a full unlock, admin rights)
// reaches an open app without a reload: /me is re-read every two minutes while the page is in
// view, and on coming back to it; the game is recomputed only when something that feeds it moved.
let _socMeTimer=null, _socMeAt=0;
function socMeWatch(){
  if(_socMeTimer)return;
  _socMeTimer=setInterval(()=>socMeRefresh(),120000);
  document.addEventListener('visibilitychange',()=>{ if(document.visibilityState==='visible'&&Date.now()-_socMeAt>30000)socMeRefresh(); });
}
async function socMeRefresh(){
  if(!SOC.key||!SOC.me||document.visibilityState==='hidden')return;
  _socMeAt=Date.now();
  let d; try{ d=await socFetch('/me'); }catch(e){ return; }
  if(!d||!d.me)return;
  const sig=m=>JSON.stringify([m.grants||[],m.awards||[],!!m.unlocked,!!m.admin,m.tier||0,m.mentor||false,(m.leagues||[]).map(l=>l.id)]);
  const moved=sig(d.me)!==sig(SOC.me);
  SOC.me=d.me; SOC.share=d.share;
  if(!moved)return;
  PZ_CFG.rev++; // levels and XP are rebuilt from the new grants and awards
  if(PZ)pzRender(); else if(typeof allTrades!=='undefined'&&allTrades.length)render();
}
// the league's levels, titles and XP weights reach the game layer (both views)
function pzApplyCfg(c){ if(!c)return; PZ_CFG={rev:PZ_CFG.rev+1,levels:c.levels||null,xp:c.xp||null}; }
// Cached GET: returns what's cached (possibly stale) and refreshes in the background.
function socGet(name, p, maxAge){
  const c=SOC.cache[name], fresh=c&&Date.now()-c.at<(maxAge||30000);
  if(!fresh&&!SOC.busy[name]){ SOC.busy[name]=true;
    socFetch(p).then(d=>{ socKeepOlder(name,c); SOC.cache[name]={at:Date.now(),d,err:null}; },e=>{ SOC.cache[name]={at:Date.now(),d:c?c.d:null,err:e.message}; })
      .finally(()=>{ SOC.busy[name]=false; if(PZ)pzRender(); }); }
  return c||null;
}
function socStale(){ for(const k in SOC.cache)SOC.cache[k].at=0; }
function socSync(g){
  if(!SOC.key||!SOC.me||pzS.demo||!settings.wallets.length)return;
  let p; try{ p=JSON.stringify(Object.assign(pzSocialStats(g,habitsList().map(habitSentence),journal,!!(SOC.share&&SOC.share.mentor)),
    {bench:SOC.share&&SOC.share.bench===false?null:(m=>m.ok?m:null)(peerMine())})); }catch(e){ return; }
  if(p===SOC.lastSent)return;
  clearTimeout(SOC.timer);
  SOC.timer=setTimeout(()=>{ SOC.lastSentAt=Date.now();
    socFetch('/stats',{method:'POST',body:p}).then(()=>{ SOC.lastSent=p; socStale(); },()=>{}); },
    Math.max(1500,15000-(Date.now()-SOC.lastSentAt)));
}

// ---- "Traders like you": your summary, your peer groups, and where you sit in them ----
// Your summary is worked out here from your own trades (peerSummary, the same function the server
// runs on seed wallets). The server answers with the deciles of every group you belong to; the
// comparison itself happens on this device.
const PEER_DIMS={style:{scalper:'Scalper',day:'Day trader',swing:'Swing trader',position:'Position trader'},
  size:{s1:'Trades under $1k',s2:'Trades $1k–10k',s3:'Trades $10k–100k',s4:'Trades $100k+'},
  exp:{e1:'Under 3 months',e2:'3–12 months',e3:'1–3 years',e4:'3+ years'},
  act:{a1:'Under 5 trades a week',a2:'5–15 trades a week',a3:'15–40 trades a week',a4:'40+ trades a week'}};
const PEER_DIM_NAMES={style:'Style',size:'Trade size',exp:'Experience',act:'Activity'};
// hi: higher is better; ctx: context only, not a score
const PEER_M=[
  {k:'disc',l:'Discipline',g:'Process',hi:true,f:v=>String(Math.round(v)),tip:'Your average daily Discipline score: the share of your trades with no revenge entry, sizing up after a loss, adding to a loser, trading on after two losses, overtrading or holding a loser too long.'},
  {k:'rev',l:'Revenge trades',g:'Process',hi:false,f:v=>Math.round(v)+'%',tip:'Share of your trades opened soon after a loss on the same market.'},
  {k:'jour',l:'Trades journaled',g:'Process',hi:true,f:v=>Math.round(v)+'%',tip:'Share of your trades with a note, setup, tag, rating or mistake.'},
  {k:'wr',l:'Win rate',g:'Results',hi:true,f:v=>Math.round(v)+'%',tip:'Wins out of wins and losses (more than $1 either way), last 90 days.'},
  {k:'pf',l:'Profit factor',g:'Results',hi:true,f:v=>v.toFixed(2),tip:'Money won ÷ money lost. Above 1 means you made money overall.'},
  {k:'pay',l:'Average win ÷ average loss',g:'Results',hi:true,f:v=>v.toFixed(2),tip:'How big your winners are compared with your losers.'},
  {k:'ret',l:'Return, last 30 days',g:'Results',hi:true,f:v=>(v>=0?'+':'')+v.toFixed(1)+'%',verified:true,tip:'Read on chain for wallets whose owners share it (Show % return).'},
  {k:'dd',l:'Deepest drawdown, last 30 days',g:'Risk',hi:false,f:v=>Math.round(v)+'%',verified:true,tip:'The biggest drop from a high, as % of the account, read on chain.'},
  {k:'fees',l:'Fees, % of gross profit',g:'Risk',hi:false,f:v=>Math.round(v)+'%',tip:'How much of what your winning trades made went to fees and funding.'},
  {k:'tw',l:'Trades a week',g:'Context',ctx:true,f:v=>v<10?v.toFixed(1):String(Math.round(v)),tip:'Context, not a score: how active the group is.'},
  {k:'hold',l:'Typical hold',g:'Context',ctx:true,f:v=>v<60?Math.round(v)+'m':v<1440?(v/60).toFixed(1)+'h':(v/1440).toFixed(1)+'d',tip:'Context, not a score: the median time a trade stays open.'}];
let _peerMine={key:null,v:null};
function peerMine(){
  const ctx=coachContext(), key=_coachMemo.key+'|'+_jrev;
  if(_peerMine.key===key)return _peerMine.v;
  let v; try{ const first=Math.min(...ctx.closed.map(t=>t.openTime||t.closeTime));
    const bc=(SOC.cfg&&SOC.cfg.bench)||{};
    v=peerSummary(ctx.closed,{now:Date.now(),minTrades:bc.minTrades,days:bc.days,dayOf:dayKey,firstAt:isFinite(first)?first:null,isJournaled:t=>isJournaled(journal[t.id])});
    // your own on-chain return, when you share it, sits you among the verified numbers too
    const mo=SOC.me; if(v.ok&&mo&&mo.ret!=null){ v.ret=mo.ret*100; v.dd=(mo.dd||0)*100; }
  }catch(e){ v={ok:false,why:'error'}; }
  _peerMine={key,v}; return v;
}
// where a value sits in a group, 0–100, from the group's deciles (tails are estimates: 5 and 95)
function peerPct(q, v){
  if(v==null||!isFinite(v)||!Array.isArray(q)||q.length!==9)return null;
  if(v<q[0])return 5; if(v>q[8])return 95;
  for(let i=0;i<8;i++)if(v<=q[i+1]){ const a=q[i],b=q[i+1]; return Math.round(10*(i+1)+10*(b>a?(v-a)/(b-a):0.5)); }
  return 95;
}
const peerBetter=(m,q,v)=>{ const p=peerPct(q,v); return p==null?null:m.hi?p:100-p; };
var PEER={q:null,at:0,d:null,err:null,busy:false};
function peerCanAsk(){ return typeof socAvailable==='function'&&socAvailable()&&(!!SOC.key||!!(SRV.token&&!SRV.badAuth)); }
// the groups for your dimensions, fetched at most every 10 minutes; re-renders whichever view is open
function peerData(mine){
  if(!mine||!mine.ok||!peerCanAsk())return null;
  const qs=['style','size','exp','act'].map(k=>k+'='+encodeURIComponent(mine[k])).join('&');
  if(PEER.q!==qs||Date.now()-PEER.at>600000){ if(!PEER.busy){ PEER.busy=true;
    fetch('/api/social/bench?'+qs,{headers:SOC.key?{'X-Pulse-Key':SOC.key}:{Authorization:'Bearer '+SRV.token}})
      .then(r=>r.json().then(d=>{ if(!r.ok)throw new Error(d.error||'HTTP '+r.status); return d; }))
      .then(d=>{ PEER={q:qs,at:Date.now(),d,err:null,busy:false}; },e=>{ PEER={q:qs,at:Date.now(),d:PEER.q===qs?PEER.d:null,err:e.message,busy:false}; })
      .finally(()=>{ if(typeof PZ!=='undefined'&&PZ){ if(typeof pzRender==='function')pzRender(); } else if(typeof peersRerender==='function')peersRerender(); }); } }
  return PEER.q===qs?PEER:null;
}
// the one matching `pick`, else the most specific group that keeps your style (style matters
// most), else the most specific there is; groups come broadest first
function peerGroup(d, pick){
  const gs=(d&&d.groups)||[]; if(!gs.length)return null;
  if(pick){ const g=gs.find(x=>x.key===pick); if(g)return g; }
  const styled=gs.filter(x=>x.dims&&x.dims.style);
  return (styled.length?styled:gs)[(styled.length?styled:gs).length-1];
}
const peerGroupName=g=>!g||g.key==='all'?'everyone on this server':['style','size','exp','act'].filter(k=>g.dims[k]).map(k=>PEER_DIMS[k][g.dims[k]]).join(' · ');
// the one habit that most separates the group's best quarter from you, in units of the group's spread
function peerGap(g, mine){
  let best=null;
  for(const k of ['jour','rev','disc','fees']){ const m=PEER_M.find(x=>x.k===k), q=g.q[k], top=g.top&&g.top[k], v=mine[k];
    if(!q||top==null||v==null)continue; const spread=(q[7]-q[1])||1, gap=(m.hi?top-v:v-top)/spread;
    if(gap>0.25&&(!best||gap>best.gap))best={m,top,v,gap}; }
  return best;
}
const PEER_GAP_SAY={jour:(t,v)=>[`The best quarter journal ${Math.round(t)}% of their trades.`,`You journal ${Math.round(v)}%.`],
  rev:(t,v)=>[`The best quarter revenge trade on ${Math.round(t)}% of their trades.`,`You: ${Math.round(v)}%.`],
  disc:(t,v)=>[`The best quarter average ${Math.round(t)} on Discipline.`,`You average ${Math.round(v)}.`],
  fees:(t,v)=>[`The best quarter give ${Math.round(t)}% of their gross profit to fees.`,`You give ${Math.round(v)}%.`]};
// why there's no summary yet, with the league's own bar
function peerWhy(m){ return m.why==='few'&&m.need?'It needs '+m.need+' closed trades in the last '+(m.days||90)+' days.':m.why==='short'?'It needs at least 2 weeks of trading in the last '+(m.days||90)+' days.':PEER_WHY[m.why]||''; }
const PEER_WHY={few:'It needs more closed trades in the last few months.',short:'It needs at least 2 weeks of trading.',error:'Your summary couldn’t be worked out.'};
// "What traders like you changed when they improved": the server sends group medians of the changes
// (d.improvers); each change maps to a habit from the existing system: a leak to plug, a habit from
// the library, or one written out. Key: metric + the direction the improvers moved.
function peerImpHabit(c){
  if(!c)return null; const k=c.metric+(c.improversDelta<0?'-':'+'), run={kind:'self',when:'a trade is working',then:'I let it reach my target instead of closing early'};
  return {'tw-':{slip:'overtrade'},'rev-':{slip:'revenge'},'jour+':{tpl:'journal-all'},'hold-':{slip:'heldLoser'},'hold+':run,'pay+':run,
    'fees-':{kind:'self',when:'I enter a trade',then:'I use a limit order unless I must get in now'},'wr+':{kind:'self',when:'a setup isn’t clearly an A+',then:'I skip it'},
    'afterTwo-':{slip:'afterTwo'},'sizeUp-':{slip:'sizeUp'},'addLoser-':{slip:'addLoser'},'overtrade-':{slip:'overtrade'},'heldLoser-':{slip:'heldLoser'}}[k]||null;
}
function peerImpHas(h){
  if(!h)return false; const L=habitsList();
  if(h.slip)return L.some(x=>x.kind==='slip'&&x.slip===h.slip); if(h.tpl)return L.some(x=>x.tpl===h.tpl);
  return L.some(x=>x.kind==='self'&&x.when===h.when&&x.then===h.then);
}
async function peerImpAdopt(h){
  if(!h)return null; if(h.slip)return pzPlugStart(h.slip);
  return adoptHabit(h.tpl?HABIT_LIBRARY.find(x=>x.tpl===h.tpl):h);
}
function peerImpFmt(c, v){
  if(v==null||!isFinite(v))return '—'; const s=v>0?'+':v<0?'−':'', a=Math.abs(v);
  return s+(c.unit==='pct'?Math.round(a)+'%':c.unit==='pts'?(Math.round(a*10)/10)+' pts':a.toFixed(2));
}
function peerImpTip(c){
  return c.label+'\nTraders who improved: '+peerImpFmt(c,c.improversDelta)+' (median of '+c.n+')\nThe others: '+peerImpFmt(c,c.othersDelta)+' (median of '+c.nOthers+')\nChange over 8 to 12 weeks'+(c.unit==='pts'?'; pts = percentage points':'');
}

// ---- screens ----

function socHead(){
  return `<header class="pz-head"><div><span class="pz-kick">${SOC.cfg&&SOC.cfg.week?'Week '+esc(SOC.cfg.week.slice(-2)):'Social'}</span><h1 class="pz-h1">Social</h1></div>
    <div class="pz-chips">${SOC.me.mentor?`<a class="pz-chip" href="#mentor" style="font-weight:700;font-size:13px;padding:0 14px">Mentees</a>`:''}${SOC.me.mentor||SOC.me.admin||(SOC.share&&SOC.share.mentor)?`<a class="pz-chip" href="#reviews" style="font-weight:700;font-size:13px;padding:0 14px">Reviews</a>`:''}<a class="pz-chip" href="#people" style="font-weight:700;font-size:13px;padding:0 14px">${pzI('social',16)} Find people</a><a class="pz-chip icon" href="#u/${esc(SOC.me.handle)}" aria-label="My profile">${socAv(SOC.me.handle,30)}</a><a class="pz-chip icon" href="#sharing" aria-label="What you share">${pzI('gear',20)}</a></div></header>`;
}
function socUnavailableHtml(){
  return `${pzHead('Leagues · competitions · friends','Social')}<section class="pz-card"><p class="pz-sub">Social lives on the Ledger server this page comes from. Open Keel from your server’s <b>/keel</b> link to join the league${/^https?:$/.test(location.protocol)?' — this server didn’t answer just now; try again in a moment.':'.'}</p></section>`;
}
const SOC_SHARE_GROUPS=[['Profile',['profile','page','feed','habits','mentor','duels','seek']],['Boards',['boards','global','verify','ret','bench']],['Sensitive',['usd','addr']]];
function socToggles(share, attr){
  return SOC_SHARE_GROUPS.map(([g,keys])=>`<section class="pz-card" style="padding:4px 16px"><span class="pz-lbl" style="display:block;margin:12px 0 2px;color:${g==='Sensitive'?PZ_COL.low:'var(--pz-muted)'}">${g}</span>${socToggleRows(share,attr,keys)}</section>`).join('');
}
function socToggleRows(share, attr, keys){
  return SOC_SHARE_ROWS.filter(r=>keys.includes(r[0])).map(([k,l,n,risky])=>`<div class="pz-toggle"><span style="flex:1"><b id="soct_${k}">${esc(l)}</b><span class="${risky?'risky':''}">${esc(n)}</span></span>
    <button type="button" role="switch" class="pz-switch" ${attr}="${k}" aria-checked="${!!share[k]}" aria-labelledby="soct_${k}"><i></i></button></div>`).join('');
}
function socJoinHtml(){
  const cfg=SOC.cfg; SOC.draft=SOC.draft||{...SOC_DEFAULT_SHARE};
  if(cfg&&!cfg.open)return `${pzHead('Leagues · competitions · friends','Social')}${pzLinkCardHtml()}<section class="pz-card"><p class="pz-sub">This league isn’t taking new members right now. Ask the person who shared the link.</p></section>`;
  const linkCard=pzLinkCardHtml(), d=SOC.draft;
  // one column: the pitch, your name and the button first; what you share folds below with a one-line summary
  const on=SOC_SHARE_ROWS.filter(r=>d[r[0]]).map(r=>r[1]), off=SOC_SHARE_ROWS.filter(r=>!d[r[0]]&&r[3]).map(r=>r[1]);
  const autoL=(cfg&&cfg.autoLeagues)||[], skip=SOC.joinSkip||(SOC.joinSkip=[]);
  const rankings=autoL.length?`<div><span class="pz-lbl" style="color:var(--pz-muted)">Also join ${autoL.length===1?'this ranking':'these rankings'}</span>${autoL.map(L=>`<div class="pz-toggle"><span style="flex:1"><b id="socjl_${esc(L.id)}">${esc(L.name)}</b><span>${L.metricLabel?'Ranked by '+esc(L.metricLabel)+' · ':''}you can leave it, or join others, any time</span></span>
      <button type="button" role="switch" class="pz-switch" data-soc-jskip="${esc(L.id)}" aria-checked="${!skip.includes(L.id)}" aria-labelledby="socjl_${esc(L.id)}"><i></i></button></div>`).join('')}</div>`:'';
  return `<div class="pz-join">${pzHead('Duels · partners · mentors · leagues','Create your profile')}${linkCard}
    <section class="pz-card pz-join-card">
      <span class="pz-ico" style="width:48px;height:48px;background:var(--pz-tint-xp);color:var(--pz-xp)">${pzI('progress',24)}</span>
      <div class="pz-big">Trade alongside other people</div>
      <p class="pz-sub">Your profile is how you take part: challenge someone to a duel, find an accountability partner, ask a mentor to look at your trading, and climb rankings that count process, never profit.${cfg&&cfg.members?' <b>'+cfg.members+' trader'+(cfg.members===1?'':'s')+'</b> in this league so far.':''}</p>
      <div class="pz-field"><label for="socHandle">Your public name</label><input type="text" id="socHandle" maxlength="20" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="e.g. slowhands"></div>
      ${cfg&&cfg.inviteRequired?'<div class="pz-field"><label for="socInvite">Invite code</label><input type="text" id="socInvite" maxlength="40" autocomplete="off"></div>':''}
      ${rankings}
      <button type="button" class="pz-cta" id="socJoin">Create my profile</button>
      <p class="pz-fine">Your journal, notes and trades stay in this browser. Only the numbers switched on below are sent, and returns are read from the chain, never from this device.</p>
    </section>
    <details class="pz-card pz-join-share" id="socShareBox"${pzS.joinShare?' open':''}><summary><span><b>What you share</b><span class="pz-fine" style="display:block;margin-top:2px">${esc(on.length+' on'+(off.length?' · hidden: '+off.join(', ').toLowerCase():''))} · change any time under Profile &amp; privacy</span></span>${pzI('down',18)}</summary>
      ${socToggles(SOC.draft,'data-soc-draft').replace(/class="pz-card" style="padding:4px 16px"/g,'class="pz-join-grp"')}</details>
  </div>`;
}

function socCompCard(c, level){
  const need=pzLocked('compete',level);
  const when=c.status==='upcoming'?'Starts '+dayLabel(c.start):c.status==='live'?'Ends '+dayLabel(c.end):'Finished '+dayLabel(c.end);
  const meLine=c.me?`#${c.me.rank} of ${c.entrants} · ${c.me.note}`:c.entrants+' joined';
  const act=c.status==='finished'?`<a class="pz-ghost pz-sm" href="#c/${esc(c.id)}">Results</a>`
    :c.joined?`<a class="pz-ghost pz-sm" href="#c/${esc(c.id)}">Standings</a>`
    :need?`<span class="pz-fine">${pzI('lock',14)} Unlocks at level ${need}</span>`
    :`<button type="button" class="pz-cta pz-sm" style="width:auto;min-height:40px;padding:0 18px" data-soc-join="${esc(c.id)}">Join</button>`;
  return `<section class="pz-card" style="display:flex;flex-direction:column;gap:8px"><div style="display:flex;justify-content:space-between;gap:10px"><span class="pz-lbl" style="color:${c.type==='survivor'?'#FFB25A':c.type==='return'?PZ_COL.xp:c.type==='journal'?PZ_COL.risk:PZ_COL.good}">${esc(SOC_COMP_KIND[c.type]||c.type)}</span><span class="pz-sub" style="font-size:12px">${esc(when)}</span></div>
    <a href="#c/${esc(c.id)}" style="color:var(--pz-text);text-decoration:none"><b style="font-size:17px">${esc(c.title)}</b></a>${c.rule?`<p class="pz-sub" style="font-size:13px">${esc(c.rule)}</p>`:''}
    <div style="display:flex;justify-content:space-between;align-items:center;gap:10px"><span style="font-size:13px;font-weight:600;color:${c.me&&c.me.out?PZ_COL.low:'var(--pz-soft)'}">${esc(meLine)}</span>${act}</div></section>`;
}
function socCompeteHtml(g){
  const c=socGet('comps','/competitions',30000), all=c&&c.d?c.d.competitions:null;
  const F=SOC.cfilter;
  const seg=`<div class="pz-seg" role="group" aria-label="Show">${[['mine','Mine'],['open','Open'],['past','Past']].map(([k,l])=>`<button type="button" data-soc-cf="${k}" aria-pressed="${F===k}">${l}</button>`).join('')}</div>`;
  if(!all)return `${seg}<p class="pz-sub">${c&&c.err?esc(c.err):'<span class="pz-spin"></span>Loading…'}</p>`;
  const list=all.filter(x=>F==='past'?x.status==='finished':F==='mine'?x.joined&&x.status!=='finished':!x.joined&&x.status!=='finished');
  const empty=F==='mine'?'You’re not in a competition right now. Pick one from Open.':F==='open'?'No open competitions. The league owner creates them — check back soon.':'Finished competitions land here.';
  return `<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">${seg}<span class="pz-fine">Prizes are badges and bragging rights, never money.</span></div>
    ${list.length?`<div class="pz-jgrid">${pzPage('comps:'+F,list).items.map(x=>socCompCard(x,g.level.level)).join('')}</div>${pzPage('comps:'+F,list).html}`:`<section class="pz-card"><p class="pz-sub">${empty}</p></section>`}`;
}
function socCompHtml(D, id){
  const c=socGet('comp:'+id,'/competitions/'+encodeURIComponent(id),20000), x=c&&c.d&&c.d.competition;
  const back=`<a class="pz-back" href="#social">${pzI('back',20)}Social</a>`;
  if(!x)return `${back}<p class="pz-sub">${c&&c.err?esc(c.err):'<span class="pz-spin"></span>Loading…'}</p>`;
  const need=pzLocked('compete',D.g.level.level);
  const act=x.status==='finished'?'':x.joined?`<button type="button" class="pz-ghost" data-soc-leave="${esc(x.id)}">Leave this competition</button>`
    :need?`<p class="pz-fine">${pzI('lock',14)} Competitions unlock at level ${need}. You’re level ${D.g.level.level}.</p>`:`<button type="button" class="pz-cta" data-soc-join="${esc(x.id)}">Join</button>`;
  const spg=pzPage('st:'+x.id,x.standings||[]), rows=spg.items.map(r=>`<li class="pz-li${r.me?' me':''}"><span class="pz-rank${r.rank<=3?' top':''}">${r.rank}</span>${socAv(r.handle)}<a class="pz-who" href="#u/${esc(r.handle)}"><b>${r.me?'You':'@'+esc(r.handle)}</b><span${r.out?' style="color:var(--pz-err-t)"':''}>${esc(r.note)}</span></a></li>`).join('');
  return `${back}${pzHead((SOC_COMP_KIND[x.type]||x.type)+' · '+(x.status==='upcoming'?'starts '+dayLabel(x.start):x.status==='live'?'ends '+dayLabel(x.end):'finished'),x.title)}
    <div class="pz-wide"><div class="pz-col">
      ${x.me?`<div class="pz-grid3"><div class="pz-tile good"><span class="pz-t">Your rank</span><span class="pz-n">#${x.me.rank}</span><span class="pz-t">of ${x.entrants}</span></div><div class="pz-tile" style="grid-column:span 2"><span class="pz-t">Your standing</span><span style="font-size:15px;font-weight:600">${esc(x.me.note)}</span></div></div>`:''}
      <section class="pz-card" style="display:flex;flex-direction:column;gap:8px"><b style="font-size:15px">How it’s scored</b>${x.rule?`<p class="pz-sub" style="font-size:13px">${esc(x.rule)}</p>`:''}<p class="pz-sub" style="font-size:13px">${esc(SOC_COMP_HOW[x.type]||'')}</p><p class="pz-fine">${esc(dayLabel(x.start))} → ${esc(dayLabel(x.end))}${x.type==='discipline'?' · minimum '+x.minDays+' trading days':x.type==='journal'?' · done at '+x.minDays+' days':x.type==='return'&&x.ddCap?' · drawdown cap '+Math.round(x.ddCap*100)+'%':''}</p></section>
      ${act}</div>
      <div class="pz-col">${rows?`<ol class="pz-list" aria-label="Standings">${rows}</ol>${spg.html}`:'<section class="pz-card"><p class="pz-sub">No one has joined yet.</p></section>'}</div></div>`;
}
function socFeedHtml(){
  const S=SOC.feed, c=socGet('feed:'+S,'/feed?scope='+S,20000), d=c&&c.d;
  const seg=`<div class="pz-seg full" role="group" aria-label="Show">${[['following','Following'],['discover','Discover']].map(([k,l])=>`<button type="button" data-soc-feed="${k}" aria-pressed="${S===k}">${l}</button>`).join('')}</div>`;
  const top=`<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap"><div style="flex:1;min-width:220px">${seg}</div>${socNewPostBtn()}</div>`;
  if(!d)return `${top}<p class="pz-sub">${c&&c.err?esc(c.err):'<span class="pz-spin"></span>Loading…'}</p>`;
  const sug=d.suggest&&d.suggest.length?`<section style="display:flex;flex-direction:column;gap:8px"><span class="pz-lbl" style="color:var(--pz-muted)">Traders to follow</span><div class="pz-grid3">${d.suggest.map(p=>`<a class="pz-tile" href="#u/${esc(p.handle)}" style="align-items:center;text-align:center;text-decoration:none;color:var(--pz-text)">${socAv(p.handle,40)}<b style="font-size:13px">@${esc(p.handle)}</b><span class="pz-t">${esc(p.tierName)} · ${esc(p.why)}</span></a>`).join('')}</div></section>`:'';
  const list=socWithMore('feed:'+S,d.events), ev=list.map(e=>socEvHtml(e)).join('');
  const empty=S==='following'?'Nothing here yet. Follow traders from Discover or the leaderboards and their posts and milestones show up here.':'No posts yet.';
  return `${top}${sug}${ev?`<div class="pz-jgrid">${ev}</div>${socMoreHtml('feed:'+S,d.next)}`:`<section class="pz-card"><p class="pz-sub">${empty}</p></section>`}`;
}
function socSocialHtml(D){
  socBoot();
  if(!socAvailable())return socUnavailableHtml();
  if(!SOC.cfg)return `${pzHead('Leagues · competitions · friends','Social')}<p class="pz-sub"><span class="pz-spin"></span>Loading…</p>`;
  if(SOC.cfg.enabled===false)return `${pzHead('Leagues · competitions · friends','Social')}<section class="pz-card"><p class="pz-sub">The league opens once the server owner sets an access token (AUTH_TOKEN). Without one, anyone with the link could read the owner’s journal.</p></section>`;
  if(!SOC.me)return socJoinHtml();
  const body=SOC.sub==='feed'?socPartnersHtml()+socFeedHtml():SOC.sub==='boards'?socBoardsHtml(D.g):socLeagueHtml(D.g)+`<section style="display:flex;flex-direction:column;gap:10px;margin-top:10px"><span class="pz-lbl" style="color:var(--pz-muted)">Competitions</span>${socCompeteHtml(D.g)}</section>`;
  return `${socHead()}${socSubTabs()}${socDuelEntryHtml(D.g)}${body}`;
}
function socProfileHtml(D, handle){
  const back=`<a class="pz-back" href="#social">${pzI('back',20)}Social</a>`;
  if(!socAvailable()||!SOC.me)return `${back}${socSocialHtml(D)}`;
  const c=socGet('u:'+handle.toLowerCase(),'/profile/'+encodeURIComponent(handle),30000), d=c&&c.d, p=d&&d.profile;
  if(!p)return `${back}<p class="pz-sub">${c&&c.err?esc(c.err):'<span class="pz-spin"></span>Loading…'}</p>`;
  const T=(SOC.cfg&&SOC.cfg.tiers)||[];
  const follow=p.isMe?`<a class="pz-ghost" href="#sharing">Edit what you share</a>`
    :`<button type="button" class="${p.isFollowing?'pz-ghost':'pz-cta'}" data-soc-follow="${esc(p.handle)}" data-on="${p.isFollowing?1:0}">${p.isFollowing?'Following':'Follow'}</button>
      <button type="button" class="pz-ghost" data-soc-pask="${esc(p.handle)}">Ask to be accountability partners</button>
      ${p.duelsOpen&&socDuelsOn()&&!pzLocked('duels',D.g.level.level)?`<a class="pz-ghost" href="#duel/${esc(p.handle)}">${pzI('medal',16)} Challenge to a duel</a>`:''}${!p.isMe&&p.mentor?`<button type="button" class="pz-ghost" data-soc-pmentor="${esc(p.handle)}">${pzI('coach',16)} Ask @${esc(p.handle)} to mentor you</button>`:''}${!p.isMe&&p.seeking?`<button type="button" class="pz-ghost" data-soc-ppartner="${esc(p.handle)}">Ask to be accountability partners</button>`:''}`;
  const tiles=p.private?'<section class="pz-card"><p class="pz-sub">This profile is private.</p></section>'
    :`<div class="pz-grid3"><div class="pz-tile good"><span class="pz-n">${p.discipline30==null?'—':p.discipline30}</span><span class="pz-t">Discipline · 30d${p.verified?' · verified':''}</span></div>
      <div class="pz-tile warm"><span class="pz-n">${p.streak}</span><span class="pz-t">Day streak · best ${p.best}</span></div>
      <div class="pz-tile"><span class="pz-n">${p.badgeN}</span><span class="pz-t">Badges</span></div></div>${p.duels&&(p.duels.w+p.duels.l+p.duels.d)?`<div class="pz-tile" style="flex-direction:row;align-items:center;justify-content:space-between"><span class="pz-t">Duels${p.rating!=null?` · <b style="color:${PZ_COL.xp}">${p.rating}</b> rating`:''}</span><span class="pz-n" style="font-size:22px"><span style="color:${PZ_COL.good}">${p.duels.w}</span> – <span style="color:${PZ_COL.low}">${p.duels.l}</span>${p.duels.d?' – '+p.duels.d:''}</span></div>`:''}${p.pods&&p.pods.n?`<div class="pz-tile" style="flex-direction:row;align-items:center;justify-content:space-between"><span class="pz-t">Group duels won</span><span class="pz-n" style="font-size:22px">${p.pods.w} <span class="pz-sub" style="font-size:13px">of ${p.pods.n}</span></span></div>`:''}`;
  const money=p.ret!=null||p.usd!=null?`<section class="pz-card" style="display:flex;justify-content:space-between;gap:12px"><span><span class="pz-t pz-sub" style="font-size:12px">30-day return${p.isMe?' (only you see this unless you share it)':''}</span><br><b style="font-family:var(--pz-num);font-size:26px;color:${p.ret>=0?PZ_COL.good:PZ_COL.low}">${p.ret!=null?socValue('ret',p.ret):'—'}</b>${p.usd!=null?` <span class="pz-sub">${esc(signedPlain(p.usd))}</span>`:''}</span><span style="text-align:right"><span class="pz-sub" style="font-size:12px">Max drawdown</span><br><b style="font-family:var(--pz-num);font-size:26px">${p.dd!=null?(p.dd*100).toFixed(1)+'%':'—'}</b></span></section>`:'';
  const habits=p.habits&&p.habits.length?`<section class="pz-card" style="padding:6px 16px"><b style="display:block;font-size:15px;margin:10px 0 4px">Habits ${p.isMe?'you run':'they run'}</b>${p.habits.map(h=>`<div class="pz-toggle"><span style="flex:1;font-size:14px;line-height:1.4">${esc(h)}</span>${p.isMe?'':`<button type="button" class="pz-kudo" data-soc-adopt="${esc(h)}">Adopt</button>`}</div>`).join('')}</section>`:'';
  const badges=p.badges&&p.badges.length?`<section style="display:flex;flex-wrap:wrap;gap:6px">${p.badges.map(b=>`<span class="pz-chipbtn" style="height:32px;display:inline-flex;align-items:center;gap:6px;cursor:default">${pzI('medal',14)}${esc(b)}</span>`).join('')}</section>`:'';
  const ev=(d.events||[]).map(e=>`<div class="pz-ins"><span class="pz-sub" style="font-size:12px;min-width:34px">${socAgo(e.at)}</span><span><b>${esc(e.text)}</b>${e.quote?`<span>${esc(e.quote)}</span>`:''}</span></div>`).join('');
  return `${back}<section style="display:flex;align-items:center;gap:14px">${socAv(p.handle,72)}<span style="flex:1;min-width:0;display:flex;flex-direction:column;gap:3px"><h1 class="pz-h1" style="font-family:Inter,system-ui,sans-serif;font-size:22px;font-weight:800">@${esc(p.handle)}</h1>
      <span class="pz-sub" style="font-size:13px">Level ${p.level} · ${esc(p.title)} · ${esc(T[p.tier]||p.tierName)} league</span><span class="pz-sub" style="font-size:12px">${p.followers} follower${p.followers===1?'':'s'} · ${p.following} following${p.address?' · '+esc(walletShort(p.address)):''}</span></span></section>
    ${p.bio?`<p class="pz-bio">${esc(p.bio)}</p>`:p.isMe?`<p class="pz-fine"><a href="#sharing">Add a picture and a line about how you trade</a></p>`:''}
    <div class="pz-wide"><div class="pz-col">${follow}${tiles}${money}${badges}</div><div class="pz-col">${habits}${ev?`<section class="pz-card" style="padding:4px 16px"><b style="display:block;font-size:15px;margin:10px 0 2px">Recent</b>${ev}</section>`:''}</div>
      ${(()=>{ const mk='u:'+p.handle.toLowerCase(), ps=socWithMore(mk,d.posts||[]); if(!ps.length&&!p.isMe)return '';
        return `<section class="pz-span" style="display:flex;flex-direction:column;gap:10px"><div style="display:flex;justify-content:space-between;align-items:center;gap:10px"><b style="font-size:17px">Posts</b>${p.isMe?socNewPostBtn():''}</div>
          ${ps.length?`<div class="pz-jgrid">${ps.map(e=>socEvHtml(e)).join('')}</div>${socMoreHtml(mk,d.postsNext)}`:'<section class="pz-card"><p class="pz-sub">Share a trade you took or one you’re planning, with your thesis. It shows here and in your followers’ feeds.</p></section>'}</section>`; })()}</div>`;
}
function socSharingHtml(D){
  const back=`<a class="pz-back" href="#social">${pzI('back',20)}Social</a>`;
  if(!socAvailable()||!SOC.me)return `${back}${socSocialHtml(D)}`;
  SOC.draft=SOC.draft||{...SOC.share};
  const w=socWallet();
  return `${back}${pzHead('Profile & privacy','What you share')}
  <p class="pz-sub" style="margin-top:-6px">Your journal, notes and trades stay on this device, apart from what you send the coach and your journal sync (encrypted, if you switch it on). For the league, only the numbers switched on below are sent. The league’s owner and its admins can see the stats you send, by name, to help run the league.</p>
  <div class="pz-wide"><div class="pz-col">
    <div class="pz-field"><span style="font-size:15px;font-weight:700">Profile picture</span><div style="display:flex;align-items:center;gap:14px">${socAv(SOC.me.handle,64)}
      <label class="pz-ghost pz-sm" for="socAvFile" style="cursor:pointer">${SOC.me.av?'Change picture':'Add a picture'}</label><input type="file" id="socAvFile" accept="image/*" class="pz-vh">${SOC.me.av?'<button type="button" class="pz-linkbtn" data-soc-avdel>Remove</button>':''}</div></div>
    <div class="pz-field"><label for="socHandle2">Public name</label><input type="text" id="socHandle2" maxlength="20" value="${esc(SOC.draftHandle!=null?SOC.draftHandle:SOC.me.handle)}" autocomplete="off" autocapitalize="off" spellcheck="false"></div>
    <div class="pz-field"><label for="socBio">Bio</label><textarea id="socBio" rows="2" maxlength="160" placeholder="What you trade and how, in a line">${esc(SOC.draftBio!=null?SOC.draftBio:SOC.me.bio||'')}</textarea><span class="pz-fine">Up to 160 characters, on your profile.</span></div>
    ${socToggles(SOC.draft,'data-soc-draft')}</div>
  <div class="pz-col">
    ${SOC.me.walletStatus==='pending'?'<p class="pz-warn">Your wallet is waiting for the league owner’s approval. Until then it doesn’t count for returns, verified Discipline or return competitions.</p>'
      :SOC.me.walletStatus==='rejected'?'<p class="pz-warn">The league owner hasn’t accepted this wallet. It doesn’t count for returns, verified Discipline or return competitions here.</p>':''}
    <p class="pz-fine">${SOC.me.claimed?`Returns and verified Discipline are read on chain from your claimed wallet (${esc(walletShort(SOC.me.claimedAddress||''))}).`:w?`Returns are read on chain from your first wallet (${esc(walletShort(w.address))}) when “Show % return” or “Show dollar P&L” is on. The server owner can see that address.`:'Add a wallet to take part in return boards and competitions.'}</p>
    <button type="button" class="pz-cta" id="socSaveShare">Save</button>
    <a class="pz-card pz-cardlink" href="#account"><span class="pz-ico" style="background:var(--pz-tint-n);color:var(--pz-soft)">${pzI('shield',20)}</span>
      <span style="flex:1;min-width:0;display:flex;flex-direction:column;gap:2px"><b style="font-size:15px">Account</b><span class="pz-sub" style="font-size:12px">Claim your wallet, devices, journal sync, leave the league</span></span>${pzI('chev',18)}</a>
  </div></div>`;
}
// claim, devices, sync and leaving: the things you set once, away from the everyday sharing switches
function socAccountHtml(D){
  const back=`<a class="pz-back" href="#sharing">${pzI('back',20)}What you share</a>`;
  if(!socAvailable()||!SOC.me)return `<a class="pz-back" href="#social">${pzI('back',20)}Social</a>${socSocialHtml(D)}`;
  const sync=(SRV.token&&!SRV.badAuth)?'':socVaultCardHtml();
  return `${back}${pzHead('@'+SOC.me.handle,'Account')}
  <div class="pz-wide"><div class="pz-col">${socClaimCardHtml()}${socPasskeysCardHtml()}${socDevicesCardHtml()}</div>
  <div class="pz-col">${sync}
    <section class="pz-card" style="display:flex;flex-direction:column;gap:10px"><b style="font-size:15px">Leave the league</b><p class="pz-sub" style="font-size:13px">Deletes your profile, posts and competition entries from this server. Your journal isn’t touched.</p><button type="button" class="pz-ghost pz-sm" id="socLeave" style="color:var(--pz-err-t);border-color:var(--pz-err-b)">Leave and delete my profile</button></section>
  </div></div>`;
}
function pzXpToGo(need,g){ const s=pzLevelStart(need); return isFinite(s)?Math.max(0,s-g.level.xp).toLocaleString()+' XP to go.':'Past the top level the league set — ask the owner.'; }
function pzLockedHtml(title, need, g){
  const L=g.level;
  return `${pzHead('Unlocks at level '+need,title)}<section class="pz-card pz-lock">${pzRing(L.level,L.into/L.need,PZ_COL.xp,{size:96,cap:'Level'})}
    <div class="pz-big">${esc(title)} unlocks at level ${need}</div><p class="pz-sub">${pzXpToGo(need,g)} XP comes from process: prep, plan before your first trade, keep your stops and journal every trade.</p>
    <a class="pz-cta" href="#checkin" style="max-width:320px">Earn XP: do today’s prep</a></section>`;
}
// ---- posts: trades members took or plan to take, with the thesis, pictures and comments ----
// Profile pictures arrive with names in any answer ({handle, av}); socAv draws them wherever a name shows.
function socLearnAv(x,depth){ if(!x||typeof x!=='object'||depth>6)return;
  if(Array.isArray(x)){ for(const y of x)socLearnAv(y,depth+1); return; }
  if(typeof x.handle==='string'&&'av' in x){ const k=x.handle.toLowerCase(); if(x.av)SOC.avs[k]=x.av; else delete SOC.avs[k]; }
  for(const k in x){ const v=x[k]; if(v&&typeof v==='object')socLearnAv(v,depth+1); } }
const socPx=v=>{ if(v==null||!isFinite(v))return '—'; const d=v>=1000?1:v>=100?2:v>=1?4:6; return (+v).toLocaleString(undefined,{maximumFractionDigits:d}); };
const socSignedN=(v,suf,dp)=>(v>=0?'+':'−')+Math.abs(v).toFixed(dp==null?2:dp)+suf;
const SOC_TSTAT={planned:['Planned','#B69CFF'],open:['Open','#F4C04E'],closed:['Closed','#9AA4AE'],cancelled:['Didn’t take it','#8B95A1']};
// a trade's levels and result: R and % always, dollars only from members who share them
function socTradeHtml(t){
  if(!t)return '';
  const st=SOC_TSTAT[t.status]||['',''], long=t.side!=='short';
  const rr=t.stop&&t.target?Math.abs(t.target-t.entry)/Math.abs(t.entry-t.stop):null;
  const cell=(l,v,c)=>`<div class="pz-lv"><span>${l}</span><b${c?` style="color:${c}"`:''}>${v}</b></div>`;
  const res=t.status==='closed'&&(t.r!=null||t.pct!=null)?[t.r!=null?socSignedN(t.r,'R'):'',t.pct!=null?socSignedN(t.pct,'%'):'',t.usd!=null?signedPlain(t.usd):''].filter(Boolean).join(' · '):'';
  const win=t.status==='closed'&&((t.r!=null?t.r:t.pct)||0)>=0;
  return `<div class="pz-tr"><div class="pz-trh"><b>${long?'Long':'Short'} ${esc(t.label||dispMarket(t.coin))}</b>${t.tf?`<span class="pz-pill">${esc(t.tf)}</span>`:''}${t.setup?`<span class="pz-pill">${esc(t.setup)}</span>`:''}
      <span class="pz-pill" style="margin-left:auto;color:${st[1]};border-color:currentColor">${st[0]}</span></div>
    <div class="pz-lvs">${[cell('Entry',socPx(t.entry)),t.stop?cell('Stop',socPx(t.stop),'#FF9A7E'):'',t.target?cell('Target',socPx(t.target),'#3FE0A0'):'',
      t.status==='closed'&&t.exit?cell('Exit',socPx(t.exit)):rr?cell('R : R',rr.toFixed(1)+' : 1'):''].join('')}</div>
    ${res?`<div class="pz-trres" style="color:${win?PZ_COL.good:PZ_COL.low}">${esc(res)}</div>`:''}</div>`;
}
const SOC_PKIND={trade:'Trade',plan:'Planned trade',note:'Note'};
// one feed row: a milestone (as before) or a member's post
function socEvHtml(e, full){
  const who=e.admin?`<span class="pz-av" style="background:#3FE0A0" aria-hidden="true">${pzI('bolt',16)}</span>`:socAv(e.handle,36);
  const name=e.admin?'<b>League</b>':`<a href="#u/${esc(e.handle)}" style="color:var(--pz-text);font-weight:700;text-decoration:none">${e.mine?'You':'@'+esc(e.handle)}</a>`;
  const kudo=e.admin||e.mine?(e.mine&&e.kudos?`<span class="pz-fine">${e.kudos} kudos</span>`:''):`<button type="button" class="pz-kudo" data-soc-kudos="${esc(e.id)}" aria-pressed="${e.liked}" aria-label="Kudos, ${e.kudos}">${pzI('check',16)}${e.kudos}</button>`;
  if(!e.post)return `<article class="pz-card pz-ev"><div class="pz-evh">${who}
      <span style="flex:1;min-width:0;display:flex;flex-direction:column"><span style="font-size:14px;line-height:1.35">${name} ${esc(e.text)}</span><span class="pz-sub" style="font-size:11px">${socAgo(e.at)}</span></span></div>
      ${e.quote?`<div class="pz-quote">${esc(e.quote)}</div>`:''}
      <div style="display:flex;gap:8px;flex-wrap:wrap">${kudo}${e.type==='habit'&&e.quote&&!e.mine?`<button type="button" class="pz-kudo" data-soc-adopt="${esc(e.quote)}">Adopt this habit</button>`:''}</div></article>`;
  const P=e.post, href='#post/'+esc(e.id), long=e.text.length>420||e.text.split('\n').length>7;
  const media=P.media.length?`<div class="pz-media${P.media.length===1?' one':''}">${P.media.map((u,i)=>`<a href="${esc(u)}" target="_blank" rel="noopener"><img src="${esc(u)}" alt="Picture ${i+1} with the post" loading="lazy" decoding="async"></a>`).join('')}</div>`:'';
  return `<article class="pz-card pz-ev pz-post"><div class="pz-evh">${who}
      <span style="flex:1;min-width:0;display:flex;flex-direction:column"><span style="font-size:14px;line-height:1.35">${name} <span class="pz-sub">· ${SOC_PKIND[P.kind]||'Post'}</span></span>
        <span class="pz-sub" style="font-size:11px"><a href="${href}" style="color:inherit;text-decoration:none">${socAgo(e.at)}${e.edited?' · edited':''}</a></span></span>
      ${P.verified?`<span class="pz-ver" title="The wallet behind this profile has fills in this market at the times given">${pzI('check',14,3)}On chain</span>`:''}</div>
    ${socTradeHtml(P.trade)}
    ${e.text?`<div class="pz-thesis${!full&&long?' clamp':''}">${esc(e.text)}</div>${!full&&long?`<a class="pz-link" href="${href}">Read the rest</a>`:''}`:''}
    ${media}
    ${P.outcome?`<div class="pz-quote"><b style="color:var(--pz-text)">Update${P.outcomeAt?' · '+socAgo(P.outcomeAt):''}</b><br>${esc(P.outcome)}</div>`:''}
    ${P.kind==='plan'?'<p class="pz-fine">A member’s own plan, shared for accountability. Not advice.</p>':''}
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">${kudo}${full?'':`<a class="pz-kudo" href="${href}" aria-label="Comments, ${P.comments}">${pzI('chat',16)}${P.comments}</a>`}</div></article>`;
}
// the feed's older pages, fetched by cursor and kept under the first page
function socMoreHtml(key, next){ const M=SOC.more[key];
  const nx=M?M.next:next; if(!nx)return '';
  return `<button type="button" class="pz-ghost" data-soc-more="${esc(key)}" data-next="${esc(nx)}"${M&&M.busy?' disabled':''}>${M&&M.busy?'<span class="pz-spin"></span>Loading…':'Show older'}</button>`; }
function socWithMore(key, first){ const M=SOC.more[key]; if(!M)return first; const seen=new Set(first.map(e=>e.id));
  return first.concat(M.items.filter(e=>!seen.has(e.id))).sort((a,b)=>b.at-a.at||(a.id<b.id?1:-1)); }
// a refreshed first page moves down as new posts arrive: what it held before stays listed under it
// with the older pages already loaded, so nothing between them drops out of sight
function socKeepOlder(name, c){ const M=SOC.more[name]; if(!M||!c||!c.d)return;
  const old=(name.startsWith('u:')?c.d.posts:c.d.events)||[], have=new Set(M.items.map(e=>e.id));
  M.items=old.filter(e=>!have.has(e.id)).concat(M.items); }
function socNewPostBtn(){ const pc=SOC.cfg&&SOC.cfg.posts; if(pc&&!pc.on)return '';
  return `<a class="pz-cta pz-sm" href="#compose" style="width:auto;min-height:44px;padding:0 18px;display:inline-flex;align-items:center;gap:6px">${pzI('plus',16)}Post a trade</a>`; }

// ---- one post, its comments, and (for its author) the outcome ----
function socPostHtml(D, id){
  const back=`<a class="pz-back" href="#social" data-soc-sub="feed">${pzI('back',20)}Feed</a>`;
  if(!socAvailable()||!SOC.me)return `${back}${socSocialHtml(D)}`;
  const c=socGet('post:'+id,'/posts/'+encodeURIComponent(id),15000), d=c&&c.d, e=d&&d.post;
  if(!e)return `${back}<p class="pz-sub">${c&&c.err?esc(c.err):'<span class="pz-spin"></span>Loading…'}</p>`;
  const t=e.post.trade, U=SOC.upd[id]||{};
  let upd='';
  if(e.mine&&t&&(t.status==='planned'||t.status==='open')){
    const opts=t.status==='planned'?[['open','I took it'],['closed','It’s closed'],['cancelled','Didn’t take it']]:[['closed','It’s closed']];
    const st=U.status||'';
    const cand=socJournalTrades().filter(x=>x.coin===t.coin&&x.openTime>=e.at-86400000).slice(0,6);
    upd=`<section class="pz-card" style="display:flex;flex-direction:column;gap:10px"><b style="font-size:15px">Add what happened</b>
      <div class="pz-seg" role="group" aria-label="What happened">${opts.map(([k,l])=>`<button type="button" data-soc-ust="${k}" data-id="${esc(id)}" aria-pressed="${st===k}">${l}</button>`).join('')}</div>
      ${st&&st!=='cancelled'&&cand.length?`<span class="pz-fine">Link the trade from your journal — its times and exit fill in, and a wallet trade gets the on-chain mark:</span><div class="pz-chiprow pz-wrapr">${cand.map(x=>`<button type="button" class="pz-chipbtn" data-soc-ulink="${esc(x.id)}" data-id="${esc(id)}" aria-pressed="${U.tid===x.id}">${esc(dayLabel(dayKey(x.openTime)))} · ${esc(socPx(x.avgEntry))}${x.isOpen?' · open':' → '+esc(socPx(x.avgExit))}</button>`).join('')}</div>`:''}
      ${st==='closed'&&!U.tid?`<div class="pz-field"><label for="socUExit" style="font-size:13px">Exit price</label><input type="number" id="socUExit" inputmode="decimal" step="any" min="0"></div>`:''}
      <div class="pz-field"><label for="socUNote" style="font-size:13px">How it went (optional)</label><textarea id="socUNote" rows="2" maxlength="500" placeholder="What you did, and what you’d keep or change"></textarea></div>
      <button type="button" class="pz-ghost" data-soc-usave="${esc(id)}"${st||U.tid?'':' disabled'}>Save the update</button></section>`;
  } else if(e.mine&&!e.post.outcome){
    upd=`<section class="pz-card" style="display:flex;flex-direction:column;gap:10px"><div class="pz-field"><label for="socUNote" style="font-size:13px">Add an update</label><textarea id="socUNote" rows="2" maxlength="500"></textarea></div><button type="button" class="pz-ghost" data-soc-usave="${esc(id)}">Save the update</button></section>`;
  }
  const rep=k=>SOC.confirm===k;
  const own=e.mine?`<button type="button" class="pz-quietbtn warn" data-soc-postdel="${esc(id)}">${rep('del:'+id)?'Tap again to delete this post':'Delete this post'}</button>`
    :`<button type="button" class="pz-quietbtn" data-soc-report="${esc(id)}">${rep('rep:'+id)?'Tap again to report this post to the league owner':'Report'}</button>`;
  const cs=(d.comments||[]).map(x=>`<div class="pz-com">${socAv(x.handle,30)}<span style="flex:1;min-width:0;display:flex;flex-direction:column;gap:2px">
      <span style="font-size:13px"><a href="#u/${esc(x.handle)}" style="color:var(--pz-text);font-weight:700;text-decoration:none">${x.mine?'You':'@'+esc(x.handle)}</a> <span class="pz-sub" style="font-size:11px">${socAgo(x.at)}</span></span>
      <span class="pz-thesis" style="font-size:14px">${esc(x.text)}</span>
      <span style="display:flex;gap:14px">${x.canDelete?`<button type="button" class="pz-quietbtn" data-soc-cdel="${esc(x.id)}" data-id="${esc(id)}">${rep('cdel:'+x.id)?'Tap again to delete':'Delete'}</button>`:''}${x.mine?'':`<button type="button" class="pz-quietbtn" data-soc-creport="${esc(x.id)}">${rep('crep:'+x.id)?'Tap again to report':'Report'}</button>`}</span></span></div>`).join('');
  return `${back}<div class="pz-wide"><div class="pz-col">${socEvHtml(e,true)}${upd}<p style="display:flex;gap:14px">${own}</p></div>
    <div class="pz-col"><section class="pz-card" style="display:flex;flex-direction:column;gap:12px"><b style="font-size:15px">${e.post.comments} comment${e.post.comments===1?'':'s'}</b>${cs||'<p class="pz-sub" style="font-size:13px">No comments yet.</p>'}
      <div class="pz-field"><label for="socCText" class="pz-vh">Write a comment</label><textarea id="socCText" rows="2" maxlength="500" placeholder="Write a comment"></textarea></div>
      <button type="button" class="pz-ghost pz-sm" data-soc-csend="${esc(id)}">Send</button></section></div></div>`;
}

// ---- the composer ----
function socJournalTrades(){ return allTrades.filter(t=>t.openTime>Date.now()-30*86400000).sort((a,b)=>(b.isOpen?Infinity:b.closeTime)-(a.isOpen?Infinity:a.closeTime)).slice(0,30); }
function socComposeHtml(D){
  const back=`<a class="pz-back" href="#social" data-soc-sub="feed">${pzI('back',20)}Feed</a>`;
  if(!socAvailable()||!SOC.me)return `${back}${socSocialHtml(D)}`;
  const pc=(SOC.cfg&&SOC.cfg.posts)||{on:true,plans:true,images:true};
  if(!pc.on)return `${back}<section class="pz-card"><p class="pz-sub">Posts are switched off on this server.</p></section>`;
  const C=SOC.compose=SOC.compose||{kind:'trade',tid:null,media:[],chart:true,side:'long'};
  const kinds=[['trade','A trade I took'],['plan','A trade I’m planning'],['note','A note']].filter(k=>k[0]!=='plan'||pc.plans);
  const seg=`<div class="pz-seg full" role="group" aria-label="What are you posting">${kinds.map(([k,l])=>`<button type="button" data-soc-ckind="${k}" aria-pressed="${C.kind===k}">${l}</button>`).join('')}</div>`;
  let what='';
  if(C.kind==='trade'){ const t=C.tid&&allTrades.find(x=>x.id===C.tid);
    if(t&&!C.pick){ const j=journal[t.id]||{};
      what=`<section class="pz-card" style="display:flex;flex-direction:column;gap:10px"><div style="display:flex;justify-content:space-between;align-items:baseline;gap:10px"><b>${esc(t.dir)} ${esc(dispMarket(dcoin(t)))}</b><button type="button" class="pz-linkbtn" data-soc-cpick>Pick another</button></div>
        <span class="pz-sub" style="font-size:12px">${esc(dayLabel(dayKey(t.openTime)))} · in ${esc(socPx(t.avgEntry))}${t.isOpen?' · still open':' · out '+esc(socPx(t.avgExit))}${j.setup?' · '+esc(j.setup):''}</span>
        <div class="pz-snap" data-pz-snap="${esc(t.id)}">${pzSnapHtml(t)}</div>
        ${PZ_SNAP[t.id]&&PZ_SNAP[t.id].st==='none'?'':`<div class="pz-toggle"><span style="flex:1"><b id="socChartL">Attach this chart</b><span>Entry, exit and your planned stop and target, drawn on the price</span></span><button type="button" role="switch" class="pz-switch" data-soc-cchart aria-checked="${!!C.chart}" aria-labelledby="socChartL"><i></i></button></div>`}
        <p class="pz-fine">Shows the result in R and %${SOC.share&&SOC.share.usd?' and dollars (you share dollar P&L)':'; dollars stay private unless you share dollar P&L'}.</p></section>`; }
    else if(pzS.demo) what=`<section class="pz-card"><p class="pz-sub">These are sample trades, so they can’t be shared. Connect your wallet to post your own — or post a plan or a note.</p></section>`;
    else { const L=socJournalTrades();
      what=`<section class="pz-card" style="padding:4px 16px"><b style="display:block;font-size:15px;margin:12px 0 4px">Pick the trade</b>${L.length?L.map(x=>`<button type="button" class="pz-pickrow" data-soc-ctrade="${esc(x.id)}"><span style="flex:1;min-width:0;text-align:left"><b>${esc(x.dir)} ${esc(dispMarket(dcoin(x)))}</b><span class="pz-sub" style="display:block;font-size:12px">${esc(dayLabel(dayKey(x.openTime)))}${x.isOpen?' · open':''}</span></span><span style="font-family:var(--pz-num);font-weight:600;color:${x.isOpen?'var(--pz-soft)':x.net>=0?PZ_COL.good:PZ_COL.low}">${x.isOpen?'open':esc(signedPlain(x.net))}</span></button>`).join(''):'<p class="pz-sub" style="margin:8px 0 14px">No trades in the last 30 days.</p>'}</section>`; } }
  else if(C.kind==='plan'){
    const num=(id,l)=>`<div class="pz-field" style="flex:1;min-width:0"><label for="${id}" style="font-size:13px">${l}</label><input type="number" id="${id}" inputmode="decimal" step="any" min="0"></div>`;
    what=`<section class="pz-card" style="display:flex;flex-direction:column;gap:12px">
      <div style="display:flex;gap:10px;align-items:flex-end"><div class="pz-field" style="flex:1;min-width:0"><label for="socPCoin" style="font-size:13px">Market</label><input type="text" id="socPCoin" maxlength="24" placeholder="BTC" autocomplete="off" autocapitalize="characters" spellcheck="false"></div>
        <div class="pz-seg" role="group" aria-label="Side">${[['long','Long'],['short','Short']].map(([k,l])=>`<button type="button" data-soc-cside="${k}" aria-pressed="${C.side===k}">${l}</button>`).join('')}</div></div>
      <div style="display:flex;gap:10px">${num('socPEntry','Entry')}${num('socPStop','Stop')}${num('socPTarget','Target')}</div>
      <div style="display:flex;gap:10px"><div class="pz-field" style="flex:1;min-width:0"><label for="socPTf" style="font-size:13px">Timeframe</label><input type="text" id="socPTf" maxlength="12" placeholder="4h" autocomplete="off"></div>
        <div class="pz-field" style="flex:2;min-width:0"><label for="socPSetup" style="font-size:13px">Setup</label><input type="text" id="socPSetup" maxlength="40" placeholder="Breakout retest" autocomplete="off"></div></div>
      <p class="pz-fine">Entry, stop and target are fixed once posted. Afterwards you add what happened, and the result is worked out from these prices.</p></section>`; }
  const imgs=pc.images?`<section style="display:flex;flex-direction:column;gap:8px">${C.media.length?`<div class="pz-media">${C.media.map(m=>`<span class="pz-mthumb"><img src="${esc(m.url)}" alt=""><button type="button" class="pz-chip icon" data-soc-cimgdel="${esc(m.id)}" aria-label="Remove this picture">${pzI('x',16)}</button></span>`).join('')}</div>`:''}
      ${C.media.length<4?`<label class="pz-ghost pz-sm" for="socPostImg" style="align-self:flex-start;cursor:pointer">${C.upBusy?'<span class="pz-spin"></span>Adding…':'Add a picture'}</label><input type="file" id="socPostImg" accept="image/*" class="pz-vh">`:''}</section>`:'';
  const ph=C.kind==='note'?'What’s on your mind about your trading?':C.kind==='plan'?'Your thesis: why this trade, what has to happen, what makes you wrong':'Your thesis, and what you did';
  return `${back}${pzHead('New post','Share with the league')}<div class="pz-wide"><div class="pz-col">${seg}${what}</div>
    <div class="pz-col"><div class="pz-field"><label for="socPostText">${C.kind==='note'?'Your note':'Thesis'}</label><textarea id="socPostText" rows="6" maxlength="2000" placeholder="${esc(ph)}"></textarea></div>
      ${imgs}
      <button type="button" class="pz-cta" id="socPostSend"${C.busy?' disabled':''}>${C.busy?'<span class="pz-spin"></span>Posting…':'Post'}</button>
      <p class="pz-fine">Everyone in the league can see posts${C.kind==='plan'?'. Plans are your own idea, shared for accountability — never advice':''}. You can delete a post any time.</p></div></div>`;
}
// pictures: shrunk in the browser to WebP (JPEG where the browser can’t write WebP) before upload
async function socShrink(src, max, square, q){
  const bmp=src instanceof Blob?await createImageBitmap(src):src;
  let sx=0, sy=0, sw=bmp.width, sh=bmp.height;
  if(square){ const s=Math.min(sw,sh); sx=(sw-s)/2; sy=(sh-s)/2; sw=sh=s; }
  const k=Math.min(1,max/Math.max(sw,sh)), cv=document.createElement('canvas'); cv.width=Math.round(sw*k); cv.height=Math.round(sh*k);
  const cx=cv.getContext('2d'); cx.fillStyle='#12161A'; cx.fillRect(0,0,cv.width,cv.height); cx.drawImage(bmp,sx,sy,sw,sh,0,0,cv.width,cv.height);
  const enc=type=>new Promise(r=>cv.toBlob(r,type,q||0.85));
  let b=await enc('image/webp'); if(!b||b.type!=='image/webp')b=await enc('image/jpeg');
  return b; }
async function socUpload(blob, kind){
  const r=await fetch('/api/social/media?kind='+kind,{method:'POST',headers:{'Content-Type':blob.type||'application/octet-stream','X-Pulse-Key':SOC.key},body:blob});
  let d={}; try{ d=await r.json(); }catch(e){}
  if(!r.ok)throw new Error(d.error||'The picture didn’t upload (HTTP '+r.status+').'); return d; }
// the trade's chart (the same drawing as in your journal), as a picture for the post
async function socChartBlob(t){ const s=PZ_SNAP[t.id]; if(!s||s.st!=='ok')return null;
  let svg=pzSnapSvg(t,s.c,s.ms,typeof nfPlan==='function'?nfPlan(journal[t.id]):null); if(!svg)return null;
  svg=svg.replace('<svg ','<svg xmlns="http://www.w3.org/2000/svg" width="1020" height="450" font-family="Inter,Arial,sans-serif" ').replace(/(<svg[^>]*>)/,'$1<rect width="100%" height="100%" fill="#12161A"/>');
  const img=new Image(); img.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svg); await img.decode();
  return socShrink(img,1020,false,0.9); }
async function socPostSend(){
  const C=SOC.compose; if(!C||C.busy)return;
  const text=($('socPostText')||{value:''}).value.trim(), body={kind:C.kind,text,media:C.media.map(m=>m.id)};
  if(C.kind==='trade'&&pzS.demo){ pzNote('Sample trades can’t be posted. Connect your wallet to share your own.','err'); return; }
  if(C.kind==='trade'){ const t=C.tid&&allTrades.find(x=>x.id===C.tid); if(!t){ pzNote('Pick the trade first.','err'); return; }
    const p=typeof nfPlan==='function'?nfPlan(journal[t.id]):null, long=t.dir!=='Short', ok=(v,s)=>v>0&&(v-t.avgEntry)*(long?1:-1)*s>0;
    body.trade={coin:t.coin,label:dispMarket(dcoin(t)),side:long?'long':'short',entry:t.avgEntry,stop:p&&ok(p.stop,-1)?p.stop:null,target:p&&ok(p.target,1)?p.target:null,
      setup:(journal[t.id]||{}).setup||'',status:t.isOpen?'open':'closed',openedAt:t.openTime,closedAt:t.isOpen?null:t.closeTime,exit:t.isOpen?null:t.avgExit,
      usd:SOC.share&&SOC.share.usd&&!t.isOpen?t.net:null}; }
  else if(C.kind==='plan'){ const v=id=>parseFloat(($(id)||{value:''}).value);
    body.trade={coin:($('socPCoin')||{value:''}).value.trim().toUpperCase(),side:C.side,entry:v('socPEntry'),stop:v('socPStop')||null,target:v('socPTarget')||null,
      tf:($('socPTf')||{value:''}).value.trim(),setup:($('socPSetup')||{value:''}).value.trim(),status:'planned'};
    if(!body.trade.coin||!(body.trade.entry>0)){ pzNote('A plan needs the market and an entry price.','err'); return; } }
  if(!text&&C.kind!=='trade'){ pzNote('Write something first.','err'); return; }
  C.busy=true; pzRender();
  try{
    if(C.kind==='trade'&&C.chart&&(SOC.cfg&&SOC.cfg.posts?SOC.cfg.posts.images:true)&&body.media.length<4){ const t=allTrades.find(x=>x.id===C.tid);
      try{ const b=await socChartBlob(t); if(b){ const u=await socUpload(b,'post'); body.media.unshift(u.id); } }catch(e){ console.warn('chart picture',e); } }
    const r=await socFetch('/posts',{method:'POST',body:JSON.stringify(body)});
    for(const m of C.media)try{ URL.revokeObjectURL(m.url); }catch(e){} // the previews were local copies
    SOC.compose=null; const el=$('socPostText'); if(el)el.value='';
    for(const k in SOC.cache)if(k.startsWith('feed:')||k.startsWith('u:'))delete SOC.cache[k]; SOC.more={};
    SOC.cache['post:'+r.post.id]={at:Date.now(),d:{post:r.post,comments:[]},err:null};
    location.hash='#post/'+r.post.id; pzNote('Posted.');
  }catch(e){ C.busy=false; pzNote(e.message,'err'); pzRender(); }
}
async function socPostAction(t){
  const ds=t.dataset, C=SOC.compose;
  const twice=k=>{ if(SOC.confirm===k){ SOC.confirm=null; return true; } SOC.confirm=k; pzRender(); return false; };
  const fresh=id=>{ delete SOC.cache['post:'+id]; for(const k in SOC.cache)if(k.startsWith('feed:')||k.startsWith('u:'))SOC.cache[k].at=0; };
  if(ds.socCkind&&C){ C.kind=ds.socCkind; C.pick=false; pzRender(); return true; }
  if(ds.socCpick!==undefined&&C){ C.pick=true; pzRender(); return true; }
  if(ds.socCtrade&&C){ C.tid=ds.socCtrade; C.pick=false; pzRender(); return true; }
  if(ds.socCside&&C){ C.side=ds.socCside; pzRender(); return true; }
  if(ds.socCchart!==undefined&&C){ C.chart=!C.chart; t.setAttribute('aria-checked',String(C.chart)); return true; }
  if(ds.socCimgdel&&C){ for(const m of C.media)if(m.id===ds.socCimgdel)try{ URL.revokeObjectURL(m.url); }catch(e){} C.media=C.media.filter(m=>m.id!==ds.socCimgdel); pzRender(); return true; }
  if(t.id==='socPostSend'){ await socPostSend(); return true; }
  if(ds.socShare){ SOC.compose={kind:'trade',tid:ds.socShare,media:[],chart:true,side:'long'}; location.hash='#compose'; return true; }
  if(ds.socMore){ const key=ds.socMore, M=SOC.more[key]=SOC.more[key]||{items:[],next:ds.next}; if(M.busy)return true; M.busy=true; pzRender();
    try{ const [kind,arg]=key.split(':'), url=kind==='feed'?'/feed?scope='+arg+'&before='+encodeURIComponent(M.next):'/profile/'+encodeURIComponent(arg)+'/posts?before='+encodeURIComponent(M.next);
      const r=await socFetch(url); M.items=M.items.concat(r.events||r.posts||[]); M.next=r.next; }catch(e){ pzNote(e.message,'err'); }
    M.busy=false; pzRender(); return true; }
  if(ds.socUst){ const U=SOC.upd[ds.id]=SOC.upd[ds.id]||{}; U.status=U.status===ds.socUst?'':ds.socUst; if(U.status==='cancelled')U.tid=null; pzRender(); return true; }
  if(ds.socUlink){ const U=SOC.upd[ds.id]=SOC.upd[ds.id]||{}; U.tid=U.tid===ds.socUlink?null:ds.socUlink; pzRender(); return true; }
  if(ds.socUsave){ const id=ds.socUsave, U=SOC.upd[id]||{}, body={}, note=($('socUNote')||{value:''}).value.trim();
    if(note)body.outcome=note;
    const x=U.tid&&allTrades.find(y=>y.id===U.tid);
    if(x)body.trade={status:x.isOpen?'open':'closed',openedAt:x.openTime,closedAt:x.isOpen?null:x.closeTime,exit:x.isOpen?null:x.avgExit,usd:SOC.share&&SOC.share.usd&&!x.isOpen?x.net:null};
    else if(U.status){ body.trade={status:U.status}; if(U.status==='closed'){ const ex=parseFloat(($('socUExit')||{value:''}).value); if(!(ex>0)){ pzNote('What price did you exit at?','err'); return true; } body.trade.exit=ex; } }
    if(!body.trade&&!body.outcome){ pzNote('Pick what happened or write a line first.','err'); return true; }
    const r=await socFetch('/posts/'+encodeURIComponent(id),{method:'PUT',body:JSON.stringify(body)});
    delete SOC.upd[id]; const n=$('socUNote'); if(n)n.value=''; fresh(id); SOC.cache['post:'+id]={at:Date.now(),d:{post:r.post,comments:(SOC.cache['post:'+id]||{d:{}}).d.comments||[]},err:null};
    pzNote('Updated.'); pzRender(); return true; }
  if(ds.socCsend){ const id=ds.socCsend, el=$('socCText'), text=(el&&el.value||'').trim(); if(!text){ pzNote('Write the comment first.','err'); return true; }
    await socFetch('/posts/'+encodeURIComponent(id)+'/comments',{method:'POST',body:JSON.stringify({text})}); if(el)el.value=''; fresh(id); pzRender(); return true; }
  if(ds.socCdel){ if(!twice('cdel:'+ds.socCdel))return true; await socFetch('/comments/'+encodeURIComponent(ds.socCdel),{method:'DELETE'}); fresh(ds.id); pzNote('Comment deleted.'); pzRender(); return true; }
  if(ds.socPostdel){ if(!twice('del:'+ds.socPostdel))return true; await socFetch('/posts/'+encodeURIComponent(ds.socPostdel),{method:'DELETE'}); fresh(ds.socPostdel); SOC.more={}; SOC.sub='feed'; location.hash='#social'; pzNote('Post deleted.'); return true; }
  if(ds.socReport){ if(!twice('rep:'+ds.socReport))return true; await socFetch('/report',{method:'POST',body:JSON.stringify({post:ds.socReport})}); pzNote('Reported. The league owner will take a look.'); pzRender(); return true; }
  if(ds.socCreport){ if(!twice('crep:'+ds.socCreport))return true; await socFetch('/report',{method:'POST',body:JSON.stringify({comment:ds.socCreport})}); pzNote('Reported. The league owner will take a look.'); pzRender(); return true; }
  if(ds.socAvdel!==undefined){ const r=await socFetch('/me',{method:'PUT',body:JSON.stringify({avatar:null})}); SOC.me=r.me; delete SOC.avs[SOC.me.handle.toLowerCase()]; pzNote('Picture removed.'); pzRender(); return true; }
  return false;
}
// files picked for a post or as a profile picture
async function socFilePicked(t){
  const f=t.files&&t.files[0]; if(!f)return false; t.value='';
  if(!/^image\//.test(f.type)){ pzNote('That isn’t a picture.','err'); return true; }
  try{
    if(t.id==='socAvFile'){ pzNote('Uploading your picture…','busy');
      const u=await socUpload(await socShrink(f,256,true,0.86),'avatar'), r=await socFetch('/me',{method:'PUT',body:JSON.stringify({avatar:u.id})});
      SOC.me=r.me; socLearnAv(r.me,0); pzNote('Picture saved.'); pzRender(); return true; }
    if(t.id==='socPostImg'&&SOC.compose){ const C=SOC.compose; if(C.media.length>=4)return true; C.upBusy=true; pzRender();
      try{ let b=await socShrink(f,1600,false,0.82); if(b.size>1400*1024)b=await socShrink(f,1100,false,0.7);
        const u=await socUpload(b,'post'); C.media.push({id:u.id,url:URL.createObjectURL(b)}); }
      finally{ C.upBusy=false; pzRender(); } return true; }
  }catch(e){ pzNote(e.message||'That picture couldn’t be read.','err'); return true; }
  return false;
}

// ---- duels: one member against another for a week or a month ----
const DUEL_IC={disc:'shield',clean:'check',survive:'bolt',journal:'pen',xp:'medal',ret:'up'};
function socDuelsOn(){ return !!(SOC.cfg&&(!SOC.cfg.duels||SOC.cfg.duels.on!==false)); }
function socDuels(){ return SOC.me&&socDuelsOn()?socGet('duels','/duels',30000):null; }
const duelDate=k=>{ if(!k)return ''; const d=new Date(k+'T12:00:00Z'); return d.toLocaleDateString('en-US',{month:'short',day:'numeric',timeZone:'UTC'}); };
const duelWhen=v=>v.start?duelDate(v.start)+' – '+duelDate(v.end):v.preview?duelDate(v.preview.start)+' – '+duelDate(v.preview.end):'';
function duelScoreTxt(v,side){ if(!side)return '—';
  if(v.type==='ret')return side.score==null?'—':(side.score>=0?'+':'')+(side.score*100).toFixed(1)+'%';
  if(v.type==='survive')return side.out?'Out':'In';
  if(side.score==null)return '—';
  return String(side.score)+(v.type==='xp'?'':''); }
// what the winner takes: the league's bonus (for a duel played to the end) and the other side's stake
function duelPrize(v){ const bonus=(SOC.cache.duels&&SOC.cache.duels.d&&SOC.cache.duels.d.xp)||0;
  return v.stake?'You each put up '+v.stake+' XP: the winner takes the other’s'+(bonus?', plus +'+bonus+' XP from the league':'')+'. A draw gives both back.'
    :bonus?'Winner gets +'+bonus+' XP.':'The win goes on your record.'; }
function duelTerms(v){ const c=[]; if(v.stake)c.push(v.stake+' XP each at stake');
  if(v.minDays)c.push(v.minDays+'+ trading days each'); if(v.verified)c.push('verified from fills'); if(v.ddCap)c.push('drawdown cap '+Math.round(v.ddCap*100)+'%');
  return c.join(' · '); }
// the day-by-day marks, one row per side
function duelMarks(v){
  const s=v.start, e=v.end; if(!s)return '';
  const days=[]; for(let t=Date.parse(s+'T00:00:00Z');t<=Date.parse(e+'T00:00:00Z');t+=86400000)days.push(new Date(t).toISOString().slice(0,10));
  const today=new Date().toISOString().slice(0,10), small=days.length>10;
  const row=(lbl,side)=>{ const mk=new Map(((side&&side.marks)||[]).map(m=>[m.k,m.s]));
    return `<span class="pz-dmlab">${esc(lbl)}</span>`+days.map(k=>{ const x=mk.get(k), past=k<=today;
      const good=v.type==='xp'?x>0:v.type==='journal'?x>=100:x>=70, col=x==null?(past?'var(--pz-line2)':'var(--pz-track)'):good?PZ_COL.good:PZ_COL.low;
      const tip=duelDate(k)+(x==null?(past?' · no trading':' · to come'):v.type==='xp'?' · '+x+' XP':v.type==='journal'?(x>=100?' · journaled and reviewed':' · not fully journaled'):' · Discipline '+x);
      return `<i class="pz-dm${small?' sm':''}" style="background:${col}" data-pz-tip="${esc(tip)}">${!small&&x!=null&&v.type!=='journal'?x:''}</i>`; }).join(''); };
  return `<div class="pz-dmarks" style="grid-template-columns:auto repeat(${days.length},minmax(0,1fr))">${row('you',v.me)}${row(v.other.handle.slice(0,8),v.them)}</div>`;
}
function socDuelCardHtml(v, compact){
  const o=v.other, head=`<div class="pz-kvrow"><b style="font-size:15px">${pzI(DUEL_IC[v.type]||'medal',16)} ${esc(v.label)} duel</b><span class="pz-sub" style="font-size:12px">${esc(duelWhen(v))}</span></div>`;
  if(v.status==='pending'&&v.awaiting) return `<section class="pz-card pz-duel">${head}
    <div class="pz-kvrow" style="justify-content:flex-start;gap:10px">${socAv(o.handle,36)}<span><b>@${esc(o.handle)}</b> ${v.countered?'suggested new terms':'challenged you'}<span class="pz-sub" style="display:block;font-size:12px">Level ${o.level} · answer within ${Math.max(1,Math.round((v.exp-Date.now())/3600000))}h</span></span></div>
    ${v.msg?`<div class="pz-quote">“${esc(v.msg)}”</div>`:''}
    <p class="pz-sub" style="margin:0;font-size:13px">${esc(v.rule)} ${esc(v.period==='month'?'A month':'A week')}, ${esc(duelWhen(v))}${duelTerms(v)?' · '+esc(duelTerms(v)):''}. ${duelPrize(v)}</p>
    <div class="pz-grid2"><button type="button" class="pz-ghost" data-duel-act="counter" data-id="${v.id}" data-h="${esc(o.handle)}">Suggest changes</button><button type="button" class="pz-cta" data-duel-act="accept" data-id="${v.id}">Accept</button></div>
    <button type="button" class="pz-linkbtn" data-duel-act="decline" data-id="${v.id}" style="align-self:center">Decline</button></section>`;
  if(v.status==='pending') return `<section class="pz-card pz-duel">${head}<div class="pz-kvrow" style="justify-content:flex-start;gap:10px">${socAv(o.handle,32)}<span>Waiting for <b>@${esc(o.handle)}</b> to answer<span class="pz-sub" style="display:block;font-size:12px">${Math.max(1,Math.round((v.exp-Date.now())/3600000))}h left · ${esc(duelTerms(v)||v.rule)}</span></span></div>
    ${compact?'':`<button type="button" class="pz-linkbtn" data-duel-act="cancel" data-id="${v.id}" style="align-self:flex-start">Withdraw</button>`}</section>`;
  if(v.status==='active'&&!v.me) return `<section class="pz-card pz-duel">${head}<div class="pz-kvrow" style="justify-content:flex-start;gap:10px">${socAv(o.handle,32)}<span>Starts ${esc(duelDate(v.start))} against <b>@${esc(o.handle)}</b><span class="pz-sub" style="display:block;font-size:12px">${esc(v.rule)}${duelTerms(v)?' · '+esc(duelTerms(v)):''}</span></span></div>
    ${compact?'':`<button type="button" class="pz-linkbtn" data-duel-act="forfeit" data-early="1" data-id="${v.id}" style="align-self:flex-start">Back out (it won’t count)</button>`}</section>`;
  if(v.status==='active'||v.status==='done'){
    const done=v.status==='done', r=v.result||{}, lead=v.lead;
    const left=done?'':(()=>{ const d=Math.ceil((Date.parse(v.end+'T23:59:59Z')-Date.now())/86400000); return d<=0?'last day':d+' day'+(d===1?'':'s')+' left'; })();
    const meCol=(done?r.outcome==='won':lead==='me')?PZ_COL.good:'var(--pz-text)', themCol=(done?r.outcome==='lost':lead==='them')?PZ_COL.xp:'var(--pz-text)';
    const banner=done?`<div class="pz-dres ${r.outcome}">${r.outcome==='won'?'You won'+(r.xp+(r.stake||0)?' · +'+(r.xp+(r.stake||0))+' XP':''):r.outcome==='lost'?'@'+esc(o.handle)+' won'+(r.stake?' · '+r.stake+' XP':''):'A draw'}${r.forfeit?' <span class="pz-sub">('+(r.forfeit==='me'?'you forfeited':'they forfeited')+')</span>':''}</div>`
      :`<div class="pz-dlead">${lead==='me'?'You lead':lead==='them'?'@'+esc(o.handle)+' leads':'Level'}<span class="pz-sub"> · ${esc(v.why||'')}</span></div>`;
    return `<section class="pz-card pz-duel pz-viz"><div class="pz-kvrow"><b style="font-size:15px">${pzI(DUEL_IC[v.type]||'medal',16)} ${esc(v.label)} duel${v.stake?` <span class="pz-chip" style="color:${PZ_COL.xp}" data-pz-tip="${esc('You each put up '+v.stake+' XP. The winner takes the other’s.')}">${v.stake} XP</span>`:''}</b><span class="pz-sub" style="font-size:12px">${done?esc(duelWhen(v)):esc(left)}</span></div>
      <div class="pz-vs"><div>${socAv((SOC.me&&SOC.me.handle)||'you',40)}<b style="color:${meCol}">${esc(duelScoreTxt(v,v.me))}</b><span class="pz-sub">${esc((v.me&&v.me.note)||'you')}</span></div><span class="pz-sub" style="font-weight:700">VS</span>
        <div>${socAv(o.handle,40)}<b style="color:${themCol}">${esc(duelScoreTxt(v,v.them))}</b><span class="pz-sub">@${esc(o.handle)} · ${esc((v.them&&v.them.note)||'')}</span></div></div>
      ${banner}${compact?'':duelMarks(v)}
      ${v.me&&v.me.missing?'<p class="pz-fine" style="margin:0">Your days count once “Verify my discipline” is on.</p>':''}
      ${done?`<div class="pz-grid2"><a class="pz-ghost" href="#u/${esc(o.handle)}">Their profile</a><button type="button" class="pz-cta" data-duel-act="rematch" data-id="${v.id}" data-h="${esc(o.handle)}">Rematch</button></div>`
        :compact?`<a class="pz-link" href="#duels" style="min-height:0;align-self:flex-start">Details ›</a>`:`<button type="button" class="pz-linkbtn" data-duel-act="forfeit" data-id="${v.id}" style="align-self:flex-start">Forfeit</button>`}</section>`;
  }
  return `<section class="pz-card pz-duel"><div class="pz-kvrow"><b style="font-size:14px">${esc(v.label)} · @${esc(o.handle)}</b><span class="pz-sub" style="font-size:12px">${v.status==='declined'?(v.mine==='sent'?'declined':'you declined'):v.status==='expired'?'expired':'cancelled'}</span></div></section>`;
}
function socDuelEntryHtml(g){
  if(!socDuelsOn()||pzLocked('duels',g.level.level))return '';
  const c=socDuels(), d=c&&c.d; if(!d)return '';
  const P=d.pods||[], wait=d.duels.filter(v=>v.status==='pending'&&v.awaiting).length+P.filter(v=>v.my==='invited').length, run=d.duels.filter(v=>v.status==='active').length+P.filter(v=>v.status==='active'&&v.my==='in').length, r=d.record;
  return `<a class="pz-card pz-cardlink" href="#duels" style="margin-bottom:10px"><span class="pz-ico" style="background:rgba(182,156,255,.14);color:${PZ_COL.xp}">${pzI('medal',20)}</span><span style="flex:1;min-width:0"><b style="font-size:15px">Duels</b><span class="pz-sub" style="display:block;font-size:13px">${wait?`<b style="color:${PZ_COL.xp}">${wait} waiting for you</b> · `:''}${run?run+' running · ':''}record ${r.w}–${r.l}${r.d?'–'+r.d:''}${d.ladder&&d.ladder.on&&d.ladder.me.n?' · rating '+d.ladder.me.r:''}</span></span>${pzI('chev',18)}</a>`;
}
function socDuelsTodayHtml(g){
  if(!SOC.me||!socDuelsOn()||(g&&pzLocked('duels',g.level.level)))return '';
  const c=socDuels(), d=c&&c.d; if(!d)return '';
  const inv=d.duels.filter(v=>v.status==='pending'&&v.awaiting).slice(0,1), act=d.duels.filter(v=>v.status==='active'&&v.me).slice(0,2);
  const P=d.pods||[], pinv=P.filter(v=>v.my==='invited').slice(0,1), pact=P.filter(v=>v.status==='active'&&v.my==='in'&&v.why).slice(0,1);
  if(!inv.length&&!act.length&&!pinv.length&&!pact.length)return '';
  return inv.map(v=>socDuelCardHtml(v,true)).join('')+pinv.map(v=>socPodCardHtml(v,true)).join('')+act.map(v=>socDuelCardHtml(v,true)).join('')+pact.map(v=>socPodCardHtml(v,true)).join('');
}
function socDuelsHtml(D){
  const back=`<a class="pz-back" href="#social">${pzI('back',20)}Social</a>`;
  if(!socAvailable()||!SOC.me)return back+socSocialHtml(D);
  const lock=pzLocked('duels',D.g.level.level); if(lock)return back+pzLockedHtml('Duels',lock,D.g);
  const c=socDuels(), d=c&&c.d;
  if(!d)return `${back}${pzHead('One on one','Duels')}<p class="pz-sub">${c&&c.err?esc(c.err):'<span class="pz-spin"></span>Loading…'}</p>`;
  if(!d.on)return `${back}${pzHead('One on one','Duels')}<section class="pz-card"><p class="pz-sub">Duels are switched off in this league.</p></section>`;
  const r=d.record, grp=(t,L)=>L.length?`<section style="display:flex;flex-direction:column;gap:10px"><span class="pz-lbl" style="color:var(--pz-muted)">${t}</span>${L.map(v=>v.pod?socPodCardHtml(v,false):socDuelCardHtml(v,false)).join('')}</section>`:'';
  const P=d.pods||[], pOpen=v=>v.status==='pending'||v.status==='active', pInv=P.filter(v=>pOpen(v)&&v.my==='invited'), pAct=P.filter(v=>v.status==='active'&&(v.my==='in'||v.my==='out')), pWait=P.filter(v=>v.status==='pending'&&v.my==='in'),
    pDone=P.filter(v=>v.status==='done'&&(v.my==='in'||v.my==='out')), pOther=P.filter(v=>![pInv,pAct,pWait,pDone].some(L=>L.includes(v)));
  const inv=d.duels.filter(v=>v.status==='pending'&&v.awaiting).concat(pInv), act=d.duels.filter(v=>v.status==='active').concat(pAct), sent=d.duels.filter(v=>v.status==='pending'&&!v.awaiting).concat(pWait),
    done=d.duels.filter(v=>v.status==='done').slice(0,10).concat(pDone.slice(0,5)), other=d.duels.filter(v=>['declined','expired','cancelled'].includes(v.status)).slice(0,5).concat(pOther.slice(0,3)), L=d.ladder&&d.ladder.on?d.ladder:null;
  return `${back}${pzHead('One on one','Duels')}
    <div class="pz-wide"><div class="pz-col">
      <section class="pz-card" style="display:flex;flex-direction:column;gap:10px"><div class="pz-kvrow"><b style="font-size:15px">Your record</b><span class="pz-sub" style="font-size:12px">${d.open!=null?d.open:inv.length+act.length+sent.length} of ${d.maxOpen} open</span></div>
        <div class="pz-grid3"><div class="pz-tile good"><span class="pz-n">${r.w}</span><span class="pz-t">won</span></div><div class="pz-tile hot"><span class="pz-n">${r.l}</span><span class="pz-t">lost</span></div><div class="pz-tile"><span class="pz-n">${r.d}</span><span class="pz-t">drawn</span></div></div>
        ${L?`<div class="pz-kvrow"><span>Rating <b style="font-family:var(--pz-num);font-size:20px;color:${PZ_COL.xp}">${L.me.r}</b></span><span class="pz-sub" style="font-size:12px">${L.me.rank?'#'+L.me.rank+' on the ladder':L.me.n<L.min?L.me.n+' of '+L.min+' duels to join the ladder':'not listed'}${L.me.gain?' · '+(L.me.gain>0?'+':'')+L.me.gain+' this season':''}</span></div>`:''}
        <div class="pz-kvrow" style="gap:8px"><input id="duelWho" aria-label="Name to challenge" placeholder="@name to challenge" autocomplete="off" style="flex:1;min-width:0"><button type="button" class="pz-cta" id="duelGo" style="width:auto;padding:0 18px">Challenge</button></div>
        ${socDuelPeopleHtml(d)}<a class="pz-link" href="#people/duels" style="min-height:0;align-self:flex-start">Find someone to duel ${pzI('chev',14)}</a>
        <p class="pz-fine" style="margin:0">Anyone in the league can be challenged: type their name, pick someone above, or open a profile from a leaderboard. Duels are scored by Keel from your fills and your app. ${d.stakes?'You can put XP on it (never money): up to '+d.room+' XP right now. ':'No money is ever staked. '}${d.xp?'A duel played to the end gives the winner +'+d.xp+' XP.':''}${d.accepting?'':' You’re not taking challenges (switched off under <a href="#sharing">Profile & privacy</a>).'}</p>
        ${d.podOn?`<a class="pz-ghost" href="#podnew">${pzI('medal',16)} Group duel: 3 to ${d.podMax} people</a>`:''}</section>
      ${grp('Waiting for you',inv)}${grp('Running',act)}${grp('Sent',sent)}</div>
    <div class="pz-col">${L?socLadderHtml(d):''}${grp('Finished',done)}${grp('Didn’t happen',other)}${!d.duels.length&&!P.length?'<section class="pz-card"><p class="pz-sub" style="margin:0">No duels yet. Challenge someone to a week of clean trading.</p></section>':''}</div></div>`;
}
// quick picks: partners, who you follow, your leagues' members
const DUEL_REL={partner:'partner',following:'you follow'};
// pick: the handles picked so far for a group duel (then each person toggles in or out)
function socDuelPeopleHtml(d,pick){
  const ppl=(d.people||[]).filter(p=>p.accepting); if(!ppl.length)return '';
  const busy=new Set(pick?[]:d.duels.filter(v=>v.status==='pending'||v.status==='active').map(v=>v.other.handle.toLowerCase())), sel=new Set((pick||[]).map(h=>h.toLowerCase()));
  return `<div class="pz-dpeople">${ppl.slice(0,24).map(p=>{ const b=busy.has(p.handle.toLowerCase());
    if(pick)return `<button type="button" class="pz-dperson" data-pod-pick="${esc(p.handle)}" aria-pressed="${sel.has(p.handle.toLowerCase())}">${socAv(p.handle,32)}<span>@${esc(p.handle)}</span><i>${sel.has(p.handle.toLowerCase())?'picked':esc(DUEL_REL[p.rel]||p.rel)}</i></button>`;
    const tag=b?'span':'a', tip=esc('@'+p.handle+' · level '+p.level+' · '+(DUEL_REL[p.rel]||p.rel)+(b?'\nYou already have a duel together':''));
    return `<${tag} class="pz-dperson"${b?' aria-disabled="true" tabindex="0"':` href="#duel/${esc(p.handle)}"`} data-pz-tip="${tip}">${socAv(p.handle,32)}<span>@${esc(p.handle)}</span><i>${esc(DUEL_REL[p.rel]||p.rel)}</i></${tag}>`; }).join('')}</div>`;
}
function socDuelNewHtml(D, handle){
  const back=`<a class="pz-back" href="#duels">${pzI('back',20)}Duels</a>`;
  if(!socAvailable()||!SOC.me)return back+socSocialHtml(D);
  const lock=pzLocked('duels',D.g.level.level); if(lock)return back+pzLockedHtml('Duels',lock,D.g);
  const c=socDuels(), d=c&&c.d, w=socGet('dw:'+handle.toLowerCase(),'/duels/with/'+encodeURIComponent(handle),30000), x=w&&w.d;
  if(!d||!x)return `${back}<p class="pz-sub">${(w&&w.err)||(c&&c.err)?esc((w&&w.err)||c.err):'<span class="pz-spin"></span>Loading…'}</p>`;
  const o=x.other, st=pzS.duel&&pzS.duel.h===o.handle?pzS.duel:(pzS.duel={h:o.handle,type:(d.types[0]||{}).type,period:'week',verified:!!(x.me.verified&&o.verified),minDays:3,ddCap:0.08,stake:0}); // verified by default only when both can be
  if(!d.types.some(t=>t.type===st.type))st.type=(d.types[0]||{}).type;
  const T=d.types.find(t=>t.type===st.type)||{}, verifiable=['disc','clean','survive'].includes(st.type), counter=pzS.duelCounter&&pzS.duelCounter.h===o.handle?pzS.duelCounter.id:null;
  // when answering with new terms, their room still holds the stake they proposed; it's freed by this answer
  const held=counter?((d.duels.find(v=>v.id===counter)||{}).stake||0):0, theirRoom=x.room==null?null:x.room+held;
  const stakeMax=!d.stakes?0:Math.min(d.maxStake,(x.me&&x.me.room)||0,theirRoom==null?Infinity:theirRoom);
  const why=!x.accepting?'@'+o.handle+' isn’t taking challenges.':x.busy&&!counter?'You already have a duel with @'+o.handle+'.'
    :verifiable&&st.verified&&!x.me.verified?'Switch on “Verify my discipline” under Profile & privacy, or turn verification off for this duel.'
    :verifiable&&st.verified&&!o.verified?'@'+o.handle+' hasn’t switched on “Verify my discipline”. Turn verification off for this duel, or pick another kind.'
    :st.type==='ret'&&!(x.me.ret&&o.ret)?'Both of you need “Show % return” switched on for a % return duel.'
    :st.stake&&st.stake>stakeMax?'You can put up at most '+stakeMax+' XP'+(theirRoom!=null&&theirRoom<x.me.room?' (what @'+o.handle+' can cover)':'')+'.':'';
  const pv=st.period==='month'?d.monthPreview:d.weekPreview, h2=x.h2h;
  return `${back}${pzHead(counter?'Suggest different terms':'One on one','Challenge @'+esc(o.handle))}
  <div class="pz-wide"><div class="pz-col"><section class="pz-card" style="display:flex;flex-direction:column;gap:14px">
    <div class="pz-kvrow" style="justify-content:flex-start;gap:12px">${socAv(o.handle,44)}<span><b style="font-size:16px">@${esc(o.handle)}</b><span class="pz-sub" style="display:block;font-size:12px">Level ${o.level}${o.week!=null?' · Discipline '+o.week+' this week':''}${h2.w+h2.l+h2.d?' · you vs them '+h2.w+'–'+h2.l+(h2.d?'–'+h2.d:''):' · first duel together'}</span></span></div>
    <div><span class="pz-lbl" style="color:var(--pz-muted)">Compete on</span><div class="pz-dtypes">${d.types.map(t=>`<button type="button" class="pz-dtype" data-duel-type="${t.type}" aria-pressed="${t.type===st.type}">${pzI(DUEL_IC[t.type]||'medal',16)}<b>${esc(t.label)}</b><span>${esc(t.rule)}</span></button>`).join('')}</div></div>
    <div><span class="pz-lbl" style="color:var(--pz-muted)">When</span><div class="pz-seg" style="margin-top:6px">${[['week','A week · '+duelDate(d.weekPreview.start)+'–'+duelDate(d.weekPreview.end)],['month','A month · '+new Date(d.monthPreview.start+'T12:00:00Z').toLocaleDateString('en-US',{month:'long',timeZone:'UTC'})]].map(([k,l])=>`<button type="button" data-duel-period="${k}" aria-pressed="${st.period===k}">${esc(l)}</button>`).join('')}</div>
      <p class="pz-fine" style="margin:6px 0 0">It starts on the next Monday (or the 1st) after it’s accepted, so nobody gets a head start.</p></div>
    <div><span class="pz-lbl" style="color:var(--pz-muted)">Conditions</span>
      ${st.type==='disc'?`<div class="pz-toggle"><span style="flex:1"><b>At least ${st.minDays} trading day${st.minDays===1?'':'s'} each</b><span>So nobody wins by not trading</span></span><span style="display:flex;gap:6px"><button type="button" class="pz-chipbtn" data-duel-min="-1" aria-label="Fewer">−</button><button type="button" class="pz-chipbtn" data-duel-min="1" aria-label="More">+</button></span></div>`:''}
      ${verifiable?`<div class="pz-toggle"><span style="flex:1"><b id="duelVerLbl">Verified from fills</b><span>Scored from both wallets’ public fills, not what the apps report</span></span><button type="button" role="switch" class="pz-switch" data-duel-verified="1" aria-labelledby="duelVerLbl" aria-checked="${!!st.verified}"><i></i></button></div>`:''}
      ${st.type==='ret'?`<div class="pz-toggle"><span style="flex:1"><b>Drawdown cap</b><span>Going past it loses outright</span></span><span class="pz-seg">${[0.05,0.08,0.1,0.15].map(v=>`<button type="button" data-duel-dd="${v}" aria-pressed="${st.ddCap===v}">${v*100}%</button>`).join('')}</span></div>`:''}
      ${d.stakes?socDuelStakeHtml(st,stakeMax,d):''}
      <label class="pz-sub" for="duelMsg" style="display:block;margin-top:8px;font-size:12px">Message (optional)</label><input id="duelMsg" maxlength="140" placeholder="Loser buys coffee" autocomplete="off"></div>
    <div class="pz-quote">${esc(T.label||'')} · ${esc(duelDate(pv.start))} – ${esc(duelDate(pv.end))}. ${esc(T.rule||'')}${st.type==='disc'?' At least '+st.minDays+' trading days each.':''}${verifiable&&st.verified?' Verified from fills.':''}${st.type==='ret'?' Drawdown cap '+Math.round(st.ddCap*100)+'%.':''} ${esc(duelPrize({stake:st.stake}))}</div>
    ${why?`<p class="pz-sub pz-err" style="margin:0;font-size:13px">${esc(why)}</p>`:''}
    <button type="button" class="pz-cta" id="duelSend"${why?' disabled':''}>${counter?'Send these terms back':'Send challenge'}</button></section></div></div>`;
}

// XP on the line: both sides put up the same amount; the winner takes the other's
function socDuelStakeHtml(st,max,d){
  const opts=[0,25,50,100,250,500,1000].filter(v=>v<=d.maxStake);
  return `<div class="pz-toggle" style="flex-wrap:wrap"><span style="flex:1;min-width:180px"><b>XP at stake</b><span>${max?'You each put up the same XP; the winner takes the other’s. Up to '+max+' XP here.':'Nothing to stake yet: you can stake up to '+(d.stakePct||25)+'% of your XP once you’ve earned some.'}</span></span>
    <span class="pz-seg" style="flex-wrap:wrap">${opts.map(v=>`<button type="button" data-duel-stake="${v}" aria-pressed="${(st.stake||0)===v}"${v>max&&v!==(st.stake||0)?' disabled':''}>${v?v+' XP':'None'}</button>`).join('')}</span></div>`;
}

// ---- the duel ladder: ratings from 1v1 results, and this quarter's season ----
function socLadderHtml(d){
  const L=d.ladder; if(!L||!L.on)return '';
  const tab=pzS.ladTab==='season'?'season':'all', rows=tab==='season'?L.season.rows:L.top.slice(0,10), me=L.me;
  const seg=`<div class="pz-seg" role="group" aria-label="Show">${[['all','Rating'],['season',L.season.label]].map(([k,l])=>`<button type="button" data-lad-tab="${k}" aria-pressed="${tab===k}">${esc(l)}</button>`).join('')}</div>`;
  const val=r=>tab==='season'?(r.gain>0?'+':'')+r.gain:String(r.r);
  const list=rows.length?`<ol class="pz-list pz-dlad" aria-label="Ladder">${rows.map(r=>`<li class="pz-li${r.me?' me':''}"><span class="pz-rank${r.rank<=3?' top':''}">${r.rank}</span>${socAv(r.handle,30)}<a class="pz-who" href="#u/${esc(r.handle)}"><b>${r.me?'You':'@'+esc(r.handle)}</b><span>${r.n} duel${r.n===1?'':'s'}${tab==='season'?' · rating '+r.r:''}</span></a><span class="pz-val">${esc(val(r))}</span></li>`).join('')}</ol>`
    :`<p class="pz-sub" style="margin:0;font-size:13px">${tab==='season'?'No one has played a rated duel this season yet.':'No one is on the ladder yet.'}</p>`;
  const mine=me.n<L.min?`You join after ${L.min} duels (${me.n} so far).`:!me.shown?'You’re not listed: your profile is private or you’re not taking challenges.':'';
  const hall=L.hall.length?`<p class="pz-fine" style="margin:0">${L.hall.slice(0,2).map(h=>esc(h.label)+': '+h.podium.map((x,i)=>['🏆','🥈','🥉'][i]+' '+(x.handle?'@'+esc(x.handle):'a private member')).join(' · ')).join('<br>')}</p>`:'';
  return `<section class="pz-card" style="display:flex;flex-direction:column;gap:10px"><div class="pz-kvrow" style="flex-wrap:wrap;gap:8px"><b style="font-size:15px">${pzI('medal',16)} Ladder</b>${seg}</div>
    ${list}${mine?`<p class="pz-fine" style="margin:0">${esc(mine)}</p>`:''}
    <p class="pz-fine" style="margin:0">${tab==='season'?'Points won this season. Ends '+esc(duelDate(L.season.end))+'. The top 3 get a badge.':'Win 1-on-1 duels to climb. Beating a higher rating counts more.'}</p>${hall}</section>`;
}
// ---- group duels: 3 to 6 people, everyone's score on one card ----
function socPodCardHtml(v, compact){
  const head=`<div class="pz-kvrow"><b style="font-size:15px">${pzI(DUEL_IC[v.type]||'medal',16)} ${esc(v.label)} · group</b><span class="pz-sub" style="font-size:12px">${esc(duelWhen(v))}</span></div>`;
  const hrs=v.exp?Math.max(1,Math.round((v.exp-Date.now())/3600000)):0, inN=v.members.filter(m=>m.st==='in').length;
  const faces=`<div class="pz-podfaces">${v.members.filter(m=>['in','invited','out'].includes(m.st)).map(m=>`<span class="pz-podface${m.st==='in'?'':' wait'}" data-pz-tip="${esc((m.me?'You':'@'+m.handle)+(m.st==='in'?' · in':' · not answered yet'))}">${socAv(m.handle,30)}<i>${m.me?'you':esc(m.handle)}</i></span>`).join('')}</div>`;
  const btn=(act,lbl,cls)=>`<button type="button" class="${cls||'pz-linkbtn'}" data-pod-act="${act}" data-id="${v.id}"${cls?'':' style="align-self:flex-start"'}>${lbl}</button>`;
  if((v.status==='pending'||v.status==='active')&&v.my==='invited') return `<section class="pz-card pz-duel">${head}
    <div class="pz-kvrow" style="justify-content:flex-start;gap:10px">${socAv(v.by,36)}<span><b>@${esc(v.by)}</b> invited you to a group duel<span class="pz-sub" style="display:block;font-size:12px">${esc(v.period==='month'?'A month':'A week')} · answer within ${hrs}h</span></span></div>
    ${v.msg?`<div class="pz-quote">“${esc(v.msg)}”</div>`:''}${faces}
    <p class="pz-sub" style="margin:0;font-size:13px">${esc(v.rule)}${v.verified?' Verified from fills.':''} It starts once 3 are in.</p>
    <div class="pz-grid2">${btn('decline','Decline','pz-ghost')}${btn('accept','Accept','pz-cta')}</div></section>`;
  if(v.status==='pending') return `<section class="pz-card pz-duel">${head}<span>Waiting for answers: <b>${inN} in</b>, 3 needed<span class="pz-sub" style="display:block;font-size:12px">${hrs}h left · ${esc(v.rule)}</span></span>${faces}
    ${compact?'':v.mine?btn('cancel','Call it off'):''}</section>`;
  if(v.status==='active'&&!v.lead&&!v.why) return `<section class="pz-card pz-duel">${head}<span>Starts ${esc(duelDate(v.start))} · <b>${inN} in</b><span class="pz-sub" style="display:block;font-size:12px">${esc(v.rule)}</span></span>${faces}
    ${compact?'':v.mine?btn('cancel','Call it off'):v.my==='in'?btn('leave','Back out (it won’t count)'):''}</section>`;
  if(v.status==='active'||v.status==='done'){
    const done=v.status==='done', r=v.result||{}, ppl=v.members.filter(m=>m.place);
    const left=done?'':(()=>{ const n=Math.ceil((Date.parse(v.end+'T23:59:59Z')-Date.now())/86400000); return n<=0?'last day':n+' day'+(n===1?'':'s')+' left'; })();
    const banner=done?`<div class="pz-dres ${r.won?'won':r.winner?'lost':''}">${r.won?'You won'+(r.xp?' · +'+r.xp+' XP':''):r.winner?'@'+esc(r.winner)+' won':'Level at the top'}${r.place?` <span class="pz-sub">· you: ${r.place} of ${r.of}</span>`:''}</div>`
      :`<div class="pz-dlead">${v.leadMe?'You lead':v.lead?'@'+esc(v.lead)+' leads':'Level'}<span class="pz-sub"> · ${esc(v.why||'')}</span></div>`;
    const rows=(compact?ppl.slice(0,4):ppl).map(m=>`<li class="pz-li${m.me?' me':''}"><span class="pz-rank${m.place===1?' top':''}">${m.place}</span>${socAv(m.handle,30)}<span class="pz-who"><b>${m.me?'You':'@'+esc(m.handle)}</b><span${m.out?' style="color:var(--pz-err-t)"':''}>${esc(m.note||'')}</span></span><span class="pz-val">${esc(duelScoreTxt(v,m))}</span></li>`).join('');
    return `<section class="pz-card pz-duel"><div class="pz-kvrow"><b style="font-size:15px">${pzI(DUEL_IC[v.type]||'medal',16)} ${esc(v.label)} · group of ${ppl.length}</b><span class="pz-sub" style="font-size:12px">${done?esc(duelWhen(v)):esc(left)}</span></div>
      ${banner}<ol class="pz-list pz-dlad" aria-label="Standings">${rows}</ol>
      ${!done&&v.members.some(m=>m.me&&m.missing)?'<p class="pz-fine" style="margin:0">Your days count once “Verify my discipline” is on.</p>':''}
      ${done?'':compact?`<a class="pz-link" href="#duels" style="min-height:0;align-self:flex-start">Details ›</a>`:v.my==='in'?btn('leave','Leave (you’ll place last)'):''}</section>`;
  }
  return `<section class="pz-card pz-duel"><div class="pz-kvrow"><b style="font-size:14px">${esc(v.label)} · group by @${esc(v.by)}</b><span class="pz-sub" style="font-size:12px">${v.status==='lapsed'?'not enough people':v.status==='cancelled'?'called off':v.my==='expired'?'no answer':'you left'}</span></div></section>`;
}
function socPodNewHtml(D){
  const back=`<a class="pz-back" href="#duels">${pzI('back',20)}Duels</a>`;
  if(!socAvailable()||!SOC.me)return back+socSocialHtml(D);
  const lock=pzLocked('duels',D.g.level.level); if(lock)return back+pzLockedHtml('Duels',lock,D.g);
  const c=socDuels(), d=c&&c.d;
  if(!d)return `${back}<p class="pz-sub">${c&&c.err?esc(c.err):'<span class="pz-spin"></span>Loading…'}</p>`;
  if(!d.on||!d.podOn||!d.podTypes)return `${back}${pzHead('Duels','Group duel')}<section class="pz-card"><p class="pz-sub">Group duels are switched off in this league.</p></section>`;
  const st=pzS.pod||(pzS.pod={type:(d.podTypes[0]||{}).type,period:'week',verified:false,minDays:3,pick:[]});
  if(!d.podTypes.some(t=>t.type===st.type))st.type=(d.podTypes[0]||{}).type;
  const T=d.podTypes.find(t=>t.type===st.type)||{}, verifiable=['disc','clean','survive'].includes(st.type), max=d.podMax-1, n=st.pick.length, pv=st.period==='month'?d.monthPreview:d.weekPreview;
  const why=d.open>=d.maxOpen?'You have '+d.maxOpen+' duels going already. Finish one first.':n<2?'Pick at least 2 people.':n>max?'Pick at most '+max+' people.':'';
  return `${back}${pzHead('3 to '+d.podMax+' people','Group duel')}
  <div class="pz-wide"><div class="pz-col"><section class="pz-card" style="display:flex;flex-direction:column;gap:14px">
    <div><span class="pz-lbl" style="color:var(--pz-muted)">Who (${n} picked)</span>${socDuelPeopleHtml(d,st.pick)}
      <div class="pz-kvrow" style="gap:8px;margin-top:6px"><input id="podWho" aria-label="Name to invite" placeholder="@name" autocomplete="off" style="flex:1;min-width:0"><button type="button" class="pz-ghost" id="podAdd" style="width:auto;padding:0 18px">Add</button></div>
      ${n?`<div class="pz-pchips" style="margin-top:8px">${st.pick.map(h=>`<button type="button" class="pz-pchip" data-pod-pick="${esc(h)}" aria-label="${esc('Remove @'+h)}">@${esc(h)} ×</button>`).join('')}</div>`:''}</div>
    <div><span class="pz-lbl" style="color:var(--pz-muted)">Compete on</span><div class="pz-dtypes">${d.podTypes.map(t=>`<button type="button" class="pz-dtype" data-pod-type="${t.type}" aria-pressed="${t.type===st.type}">${pzI(DUEL_IC[t.type]||'medal',16)}<b>${esc(t.label)}</b><span>${esc(t.rule)}</span></button>`).join('')}</div></div>
    <div><span class="pz-lbl" style="color:var(--pz-muted)">When</span><div class="pz-seg" style="margin-top:6px">${[['week','A week'],['month','A month']].map(([k,l])=>`<button type="button" data-pod-period="${k}" aria-pressed="${st.period===k}">${l}</button>`).join('')}</div></div>
    ${st.type==='disc'||verifiable?`<div>${st.type==='disc'?`<div class="pz-toggle"><span style="flex:1"><b>At least ${st.minDays} trading day${st.minDays===1?'':'s'} each</b><span>So nobody wins by not trading</span></span><span style="display:flex;gap:6px"><button type="button" class="pz-chipbtn" data-pod-min="-1" aria-label="Fewer">−</button><button type="button" class="pz-chipbtn" data-pod-min="1" aria-label="More">+</button></span></div>`:''}
      ${verifiable?`<div class="pz-toggle"><span style="flex:1"><b id="podVerLbl">Verified from fills</b><span>Everyone needs “Verify my discipline” on</span></span><button type="button" role="switch" class="pz-switch" data-pod-verified="1" aria-labelledby="podVerLbl" aria-checked="${!!st.verified}"><i></i></button></div>`:''}</div>`:''}
    <div><label class="pz-sub" for="podMsg" style="display:block;font-size:12px">Message (optional)</label><input id="podMsg" maxlength="140" placeholder="Last one standing buys lunch" autocomplete="off"></div>
    <div class="pz-quote">${esc(T.label||'')} · ${esc(duelDate(pv.start))} – ${esc(duelDate(pv.end))} if 3 of you are in by then. ${esc(T.rule||'')} ${d.xp?'Winner gets +'+d.xp+' XP.':''}</div>
    ${why?`<p class="pz-sub pz-err" style="margin:0;font-size:13px">${esc(why)}</p>`:''}
    <button type="button" class="pz-cta" id="podSend"${why?' disabled':''}>Send invites</button>
    <p class="pz-fine" style="margin:0">They have 48 hours to answer. It doesn’t change your ladder rating.</p></section></div></div>`;
}

// ---- actions ----
// ---- Find people: duel, partner with, or learn from anyone on this server, no shared league needed ----
const SOC_PEOPLE_F=[['','Everyone'],['duels','Open to duels'],['partner','Looking for a partner'],['mentor','Mentors']];
const SOC_STYLE={scalper:'Scalper',day:'Day trader',swing:'Swing trader',position:'Position trader'};
function socPeopleHtml(D){
  const back=`<a class="pz-back" href="#social">${pzI('back',20)}Social</a>`;
  if(!socAvailable()||!SOC.me)return `${back}${socSocialHtml(D)}`;
  const f=['duels','partner','mentor'].includes(pzHashArg())?pzHashArg():'', q=SOC.pq||'';
  if(SOC.pkey!==f+'|'+q){ SOC.pkey=f+'|'+q; SOC.ppage=0; } // a new filter or search starts at its first page
  const n=(SOC.ppage||0)+1;
  // pages come one at a time ("Show more") and are added to what's shown
  const pg=i=>socGet('people:'+f+':'+q+':p'+i,'/people?f='+f+'&q='+encodeURIComponent(q)+'&page='+i,20000), c=pg(0);
  const pages=[]; for(let i=0;i<n;i++){ const ci=i?pg(i):c; if(ci&&ci.d)pages.push(ci.d); }
  const d=c&&c.d, list=pages.flatMap(x=>x.people), duelLock=pzLocked('duels',D.g.level.level), duelsOn=socDuelsOn();
  const tabs=`<div class="pz-chiprow" role="group" aria-label="Show">${SOC_PEOPLE_F.map(([k,l])=>`<a class="pz-chipbtn" href="#people${k?'/'+k:''}" aria-pressed="${k===f}">${l}</a>`).join('')}</div>`;
  const intro={duels:'Members who accept duel challenges. Pick one and set the terms: a week or a month, on Discipline, clean days, journaling or XP.',
    partner:'Members looking for an accountability partner. Partners see each other’s streak, scores and slips, and can nudge each other. Up to three each.',
    mentor:'Mentors the league owner appointed. Ask one to look at your trading: they see your days (never your wallet) and can leave you notes and review trades you send.',
    '':'Everyone with a public profile, most recently active first. You don’t need to share a league to duel, partner or ask a mentor.'}[f];
  const card=p=>{ const tags=[p.mentor?`<span class="pz-tag info">Mentor</span>`:'',p.seeking?`<span class="pz-tag win">Looking for a partner</span>`:'',p.duels?`<span class="pz-tag">Open to duels</span>`:'',p.style?`<span class="pz-tag">${esc(SOC_STYLE[p.style]||p.style)}</span>`:''].filter(Boolean).join('');
    const acts=[!duelLock&&duelsOn&&p.duels?`<a class="pz-ghost pz-sm" href="#duel/${esc(p.handle)}">${pzI('medal',14)} Challenge</a>`:'',
      p.partner==='active'?'<span class="pz-fine">Your partner</span>':p.partner==='sent'?'<span class="pz-fine">Partner request sent</span>':p.partner==='asked'?`<button type="button" class="pz-cta pz-sm" data-soc-ppartner="${esc(p.handle)}">Accept as partner</button>`
        :(p.seeking||f==='partner')?`<button type="button" class="pz-ghost pz-sm" data-soc-ppartner="${esc(p.handle)}">Ask to partner</button>`:'',
      p.mentor?(p.askedMentor?'<span class="pz-fine">Asked to mentor you</span>':`<button type="button" class="pz-ghost pz-sm" data-soc-pmentor="${esc(p.handle)}">${pzI('coach',14)} Ask to mentor me</button>`):''].filter(Boolean).join('');
    return `<section class="pz-card pz-person"><a class="pz-person-h" href="#u/${esc(p.handle)}">${socAv(p.handle,44)}<span class="pz-person-i"><b>@${esc(p.handle)}</b><span class="pz-sub" style="display:block;font-size:12px">Level ${p.level} · ${esc(p.title)}${p.active?' · active this week':''}${p.leagues.length?' · '+esc(p.leagues.join(', ')):''}</span></span>${pzI('chev',16)}</a>
      ${p.bio?`<p class="pz-bio" style="margin:0">${esc(p.bio)}</p>`:''}${tags?`<div class="pz-tags">${tags}</div>`:''}${acts?`<div class="pz-person-a">${acts}</div>`:''}</section>`; };
  const last=pages[pages.length-1];
  return `${back}${pzHead(d?d.total+' '+(d.total===1?'person':'people'):'People','Find people')}
    <div class="pz-field"><label for="socPq" class="pz-sr">Search people</label><input type="search" id="socPq" value="${esc(q)}" placeholder="Search by name or what they trade" autocomplete="off" enterkeyhint="search"></div>
    ${tabs}<p class="pz-sub" style="margin:0">${intro}</p>
    ${f==='partner'&&!(SOC.share&&SOC.share.seek)?`<p class="pz-fine">Want people to find you too? Switch on “Looking for an accountability partner” in <a href="#sharing">Profile &amp; privacy</a>.</p>`:''}
    ${!d?`<p class="pz-sub">${c&&c.err?esc(c.err):'<span class="pz-spin"></span>Loading…'}</p>`
      :list.length?`<div class="pz-jgrid">${list.map(card).join('')}</div>${last&&last.more?`<button type="button" class="pz-ghost" data-soc-pmore="1">Show more</button>`:''}`
      :`<section class="pz-card pz-empty"><b>No one here yet</b><p class="pz-sub">${q?'Nobody matches “'+esc(q)+'”.':f==='mentor'?'This league has no mentors yet. The owner appoints them.':f==='partner'?'Nobody has said they’re looking for a partner yet. Be the first: switch it on in Profile & privacy.':'Nobody else has a public profile yet.'}</p></section>`}`;
}
const socPeopleDrop=()=>{ for(const k of Object.keys(SOC.cache))if(k.startsWith('people:'))delete SOC.cache[k]; };
async function socAction(t){
  const ds=t.dataset;
  const done=(m,kind)=>{ if(m)pzNote(m,kind); socStale(); pzRender(); };
  try{
    if(await socPostAction(t))return true;
    // sign-up: the default rankings are a choice
    if(ds.socJskip){ const L=SOC.joinSkip||(SOC.joinSkip=[]), i=L.indexOf(ds.socJskip); if(i<0)L.push(ds.socJskip); else L.splice(i,1); pzRender(); return true; }
    // find people
    if(ds.socPmore){ SOC.ppage=(SOC.ppage||0)+1; pzRender(); return true; }
    if(ds.socPpartner){ const h=ds.socPpartner, r=await socFetch('/partners',{method:'POST',body:JSON.stringify({handle:h})});
      socPeopleDrop(); delete SOC.cache.partners; done(r.partner&&r.partner.status==='active'?'You and @'+h+' are partners now.':'Asked @'+h+'. They’ll see it under Social.'); return true; }
    if(ds.socPmentor){ const h=ds.socPmentor;
      if(!(SOC.share&&SOC.share.mentor)&&!confirm('Asking a mentor lets the league’s mentors see your days: scores, slips and the lesson you write each night. Never your wallet, and a trade only when you send it for review. You can switch it off any time in Profile & privacy.\n\nAsk @'+h+' to mentor you?'))return true;
      const r=await socFetch('/people/'+encodeURIComponent(h)+'/mentor',{method:'POST',body:JSON.stringify({letIn:true})});
      if(r.share){ SOC.share=r.share; SOC.draft=null; } socPeopleDrop(); done('Asked @'+h+'. They’ve been told, and they can see your days now.'); return true; }
    // duels
    if(ds.duelType){ pzS.duel.type=ds.duelType; pzRender(); return true; }
    if(ds.duelPeriod){ pzS.duel.period=ds.duelPeriod; pzRender(); return true; }
    if(ds.duelVerified){ pzS.duel.verified=!pzS.duel.verified; pzRender(); return true; }
    if(ds.duelMin){ pzS.duel.minDays=Math.max(1,Math.min(pzS.duel.period==='month'?20:5,(pzS.duel.minDays||3)+(+ds.duelMin))); pzRender(); return true; }
    if(ds.duelDd){ pzS.duel.ddCap=+ds.duelDd; pzRender(); return true; }
    if(ds.duelStake!=null){ pzS.duel.stake=+ds.duelStake||0; pzRender(); return true; }
    if(t.id==='duelGo'){ const h=(($('duelWho')||{value:''}).value||'').trim().replace(/^@/,''); if(!/^[A-Za-z0-9_]{3,20}$/.test(h)){ pzNote('Type their name, like @nora_fx.','err'); return true; }
      pzS.duelCounter=null; location.hash='#duel/'+h; return true; }
    if(t.id==='duelSend'){ const st=pzS.duel, msg=(($('duelMsg')||{value:''}).value||'').trim(), counter=pzS.duelCounter&&pzS.duelCounter.h===st.h?pzS.duelCounter.id:null;
      const terms={type:st.type,period:st.period,verified:st.verified,minDays:st.minDays,ddCap:st.ddCap,stake:st.stake||0,msg};
      t.disabled=true;
      try{ if(counter)await socFetch('/duels/'+encodeURIComponent(counter),{method:'POST',body:JSON.stringify(Object.assign({action:'counter'},terms))});
        else await socFetch('/duels',{method:'POST',body:JSON.stringify(Object.assign({to:st.h},terms))}); }
      finally{ t.disabled=false; }
      pzS.duelCounter=null; delete SOC.cache.duels; const el=$('duelMsg'); if(el)el.value='';
      location.hash='#duels'; done(counter?'Sent back to @'+st.h+'.':'Challenge sent to @'+st.h+'. They have 48 hours to answer.'); return true; }
    // group duels and the ladder
    if(ds.ladTab){ pzS.ladTab=ds.ladTab; pzRender(); return true; }
    if(ds.podType&&pzS.pod){ pzS.pod.type=ds.podType; pzRender(); return true; }
    if(ds.podPeriod&&pzS.pod){ pzS.pod.period=ds.podPeriod; pzS.pod.minDays=Math.min(pzS.pod.minDays,ds.podPeriod==='month'?20:5); pzRender(); return true; }
    if(ds.podVerified&&pzS.pod){ pzS.pod.verified=!pzS.pod.verified; pzRender(); return true; }
    if(ds.podMin&&pzS.pod){ pzS.pod.minDays=Math.max(1,Math.min(pzS.pod.period==='month'?20:5,(pzS.pod.minDays||3)+(+ds.podMin))); pzRender(); return true; }
    if((ds.podPick||t.id==='podAdd')&&pzS.pod){ const h=ds.podPick||(($('podWho')||{value:''}).value||'').trim().replace(/^@/,''), L=pzS.pod.pick, i=L.findIndex(x=>x.toLowerCase()===h.toLowerCase());
      if(!/^[A-Za-z0-9_]{3,20}$/.test(h)){ pzNote('Type their name, like @nora_fx.','err'); return true; }
      if(SOC.me&&h.toLowerCase()===String(SOC.me.handle).toLowerCase()){ pzNote('You’re in it already.','err'); return true; }
      if(i>=0){ if(ds.podPick)L.splice(i,1); } else L.push(h);
      const el=$('podWho'); if(el&&!ds.podPick)el.value=''; pzRender(); return true; }
    if(t.id==='podSend'&&pzS.pod){ const st=pzS.pod, msg=(($('podMsg')||{value:''}).value||'').trim();
      t.disabled=true;
      try{ await socFetch('/pods',{method:'POST',body:JSON.stringify({to:st.pick,type:st.type,period:st.period,verified:st.verified,minDays:st.minDays,msg})}); }
      finally{ t.disabled=false; }
      pzS.pod=null; delete SOC.cache.duels; location.hash='#duels'; done('Invites sent. It starts once 3 of you are in.'); return true; }
    if(ds.podAct){ const a=ds.podAct;
      if(a==='decline'&&!confirm('Decline this group duel?'))return true;
      if(a==='cancel'&&!confirm('Call off this group duel? Nobody wins or loses.'))return true;
      if(a==='leave'&&!confirm(t.textContent.includes('won’t count')?'Back out? It hasn’t started, so it won’t count.':'Leave this group duel? You’ll be placed last.'))return true;
      const r=await socFetch('/pods/'+encodeURIComponent(ds.id),{method:'POST',body:JSON.stringify({action:a})}); delete SOC.cache.duels;
      done(a==='accept'?(r.pod.status==='active'?'You’re in. It runs '+duelWhen(r.pod)+'.':'You’re in. It starts once 3 are in.'):a==='decline'?'Declined.':a==='cancel'?'Called off.':'You left.'); return true; }
    if(ds.duelAct){ const a=ds.duelAct, id=ds.id;
      if(a==='counter'||a==='rematch'){ const v=((SOC.cache.duels&&SOC.cache.duels.d&&SOC.cache.duels.d.duels)||[]).find(x=>x.id===id);
        if(v)pzS.duel={h:v.other.handle,type:v.type,period:v.period,verified:v.verified,minDays:v.minDays||3,ddCap:v.ddCap||0.08,stake:v.stake||0};
        pzS.duelCounter=a==='counter'?{id,h:ds.h}:null; location.hash='#duel/'+ds.h; return true; }
      const fv=((SOC.cache.duels&&SOC.cache.duels.d&&SOC.cache.duels.d.duels)||[]).find(x=>x.id===id)||{};
      if(a==='forfeit'&&!confirm(ds.early?'Back out of this duel? It hasn’t started, so it won’t count either way.':'Forfeit this duel? The other side wins'+(fv.stake?' and takes your '+fv.stake+' XP stake.':'.')))return true;
      if(a==='decline'&&!confirm('Decline this challenge?'))return true;
      const r=await socFetch('/duels/'+encodeURIComponent(id),{method:'POST',body:JSON.stringify({action:a})}); delete SOC.cache.duels;
      done(a==='accept'?'Accepted. It runs '+duelWhen(r.duel)+'.':a==='decline'?'Declined.':a==='cancel'?'Withdrawn.':ds.early?'You backed out. It doesn’t count.':'You forfeited.'); return true; }
    if(ds.socSub){ SOC.sub=ds.socSub; if(pzTab()!=='social')location.hash='#social'; else pzRender(); return true; }
    // partners
    if(ds.socPask||t.id==='socPAsk'){ const h=ds.socPask||(($('socPIn')||{value:''}).value.trim()); if(!h)return true;
      await socFetch('/partners',{method:'POST',body:JSON.stringify({handle:h})}); delete SOC.cache.partners; done('Asked @'+h.replace(/^@/,'')+'. You’ll see each other’s days once they accept.'); return true; }
    if(ds.socPaccept){ await socFetch('/partners/'+encodeURIComponent(ds.socPaccept)+'/accept',{method:'POST'}); delete SOC.cache.partners; if(SOC.me)SOC.me.partners=(SOC.me.partners||0)+1; done('You’re partners now.'); return true; }
    if(ds.socPdel){ if(!ds.what&&!confirm('End this partnership? You stop seeing each other’s days.'))return true;
      await socFetch('/partners/'+encodeURIComponent(ds.socPdel),{method:'DELETE'}); delete SOC.cache.partners; done(''); return true; }
    if(ds.socNudge){ await socFetch('/partners/'+encodeURIComponent(ds.socNudge)+'/nudge',{method:'POST',body:JSON.stringify({})}); delete SOC.cache.partners; done('Nudged. They’ll see it on their next open — or as a notification.'); return true; }
    if(ds.socChfor!==undefined){ pzS.chFor=ds.socChfor||null; pzRender(); const n=$('socChIn'); if(n)n.focus(); return true; }
    if(ds.socChsave){ const v=($('socChIn')||{value:''}).value.trim(); if(!v)return true;
      await socFetch('/partners/'+encodeURIComponent(ds.socChsave)+'/challenge',{method:'PUT',body:JSON.stringify({text:v})}); pzS.chFor=null; delete SOC.cache.partners; done('Shared challenge set for this week.'); return true; }
    // mentor notes
    if(ds.socNotefor!==undefined){ pzS.noteFor=ds.socNotefor||null; pzRender(); const n=$('socNoteIn'); if(n)n.focus(); return true; }
    if(ds.socNsend){ const v=($('socNoteIn')||{value:''}).value.trim(); if(!v)return true;
      await socFetch('/mentor/'+encodeURIComponent(ds.h)+'/notes',{method:'POST',body:JSON.stringify({day:ds.socNsend,text:v})}); pzS.noteFor=null; delete SOC.cache['mentee:'+ds.h.toLowerCase()]; done('Note sent.'); return true; }
    if(ds.socNdel){ if(!confirm('Delete this note?'))return true; await socFetch('/mentor/'+encodeURIComponent(ds.h)+'/notes/'+encodeURIComponent(ds.socNdel),{method:'DELETE'}); delete SOC.cache['mentee:'+ds.h.toLowerCase()]; done(''); return true; }
    if(t.id==='socInboxRead'){ await socFetch('/inbox/read',{method:'POST'}); delete SOC.cache.inbox; if(SOC.me)SOC.me.inbox=0; pzRender(); return true; }
    if(ds.socLg){ SOC.lg=ds.socLg; SOC.board='rank'; pzRender(); return true; }
    if(ds.socGboard){ SOC.gboard=ds.socGboard; pzRender(); return true; }
    if(ds.socGlobal){ const on=ds.socGlobal==='1', share={...(SOC.share||SOC_DEFAULT_SHARE),global:on};
      const r=await socFetch('/me',{method:'PUT',body:JSON.stringify({share})}); SOC.me=r.me; PZ_CFG.rev++; SOC.share=r.share; done(on?'You’re on the global leaderboards.':'You left the global leaderboards.'); return true; }
    if(ds.socLgjoin){ const inv=($('socLgInv')||{value:''}).value.trim();
      const r=await socFetch('/leagues/'+encodeURIComponent(ds.socLgjoin)+'/join',{method:'POST',body:JSON.stringify({invite:inv})});
      SOC.lg=r.league.id; SOC.board='rank'; SOC.sub='league'; SOC.cache={}; done('Welcome to '+r.league.name+'.'); location.hash='#social'; return true; }
    if(ds.socLgleave){ if(!confirm('Leave this league? Your XP and badges stay; you just leave its ranking.'))return true;
      await socFetch('/leagues/'+encodeURIComponent(ds.socLgleave)+'/join',{method:'DELETE'}); SOC.lg=null; SOC.cache={}; done('You left the league.'); return true; }
    if(ds.socLgopen){ SOC.lg=ds.socLgopen; SOC.board='rank'; SOC.sub='league'; location.hash='#social'; return true; }
    if(ds.socBoard){ SOC.board=ds.socBoard; pzRender(); return true; }
    if(ds.socCf){ SOC.cfilter=ds.socCf; pzRender(); return true; }
    if(ds.socFeed){ SOC.feed=ds.socFeed; pzRender(); return true; }
    if(ds.socDraft){ SOC.draft=SOC.draft||{...(SOC.share||SOC_DEFAULT_SHARE)}; SOC.draft[ds.socDraft]=!SOC.draft[ds.socDraft]; t.setAttribute('aria-checked',String(SOC.draft[ds.socDraft])); return true; }
    if(ds.socKudos){ const r=await socFetch('/kudos/'+encodeURIComponent(ds.socKudos),{method:'POST'}); t.setAttribute('aria-pressed',String(r.liked)); t.setAttribute('aria-label','Kudos, '+r.kudos); t.lastChild.textContent=r.kudos; socStale(); return true; }
    if(ds.socFollow){ const on=ds.on==='1'; await socFetch('/follow/'+encodeURIComponent(ds.socFollow),{method:on?'DELETE':'POST'}); done(on?'Unfollowed.':'Following @'+ds.socFollow+'. Their milestones show up in your feed.'); return true; }
    if(ds.socJoin){ await socFetch('/competitions/'+encodeURIComponent(ds.socJoin)+'/join',{method:'POST'}); done('You’re in. Good luck — play your process.'); return true; }
    if(ds.socLeave){ if(!confirm('Leave this competition?'))return true; await socFetch('/competitions/'+encodeURIComponent(ds.socLeave)+'/join',{method:'DELETE'}); done('You left the competition.'); return true; }
    if(ds.socAdopt){ await adoptHabit(socHabitSpec(ds.socAdopt)); done('Added to your habits. It’s tracked by the day journal’s “I followed the plan”.'); return true; }
    if(ds.pzAppear){ await setAppearance(ds.pzAppear); return true; }
    if((t.id||(t.dataset&&t.dataset.pkDel))&&await acctAction(t))return true;
    switch(t.id){
      case 'socJoin': { const h=($('socHandle')||{value:''}).value.trim(), inv=($('socInvite')||{value:''}).value.trim();
        const share=SOC.draft||SOC_DEFAULT_SHARE;
        const r=await socFetch('/join',{method:'POST',body:JSON.stringify({handle:h,invite:inv,share,address:socAddressFor(share),skip:SOC.joinSkip||[]})});
        vaultForget(); COACH.tried=false; COACH.msgs=null; SOC.key=r.key; try{ localStorage.setItem(SOC_KEY_STORE,r.key); }catch(e){}
        SOC.me=r.me; PZ_CFG.rev++; SOC.share=r.share; SOC.draft=null; SOC.cache={}; SOC.lastSent='';
        SOC.joinSkip=null; done('Welcome, @'+r.me.handle+'.'+(r.walletTaken?' Your wallet is claimed by another profile, so it wasn’t added.':'')); return true; }
      case 'socSaveShare': { const h=($('socHandle2')||{value:''}).value.trim(), share=SOC.draft||SOC.share;
        let r, taken=false;
        const bio=$('socBio')?$('socBio').value:undefined;
        try{ r=await socFetch('/me',{method:'PUT',body:JSON.stringify({handle:h,share,address:socAddressFor(share),bio})}); }
        catch(e){ if(!(e.status===409&&e.data&&e.data.walletTaken))throw e; taken=true; // save the rest without that wallet
          r=await socFetch('/me',{method:'PUT',body:JSON.stringify({handle:h,share,address:null,bio})}); }
        SOC.me=r.me; PZ_CFG.rev++; SOC.share=r.share; SOC.draft=null; SOC.draftHandle=null; SOC.draftBio=null; SOC.lastSent='';
        done(taken?'Saved — without your wallet: another profile claimed it, so its numbers can’t count for you.':'Saved.'); return true; }
      case 'socLeave': { if(!confirm('Leave the league and delete your profile, posts and competition entries? Your journal isn’t touched.'))return true;
        await socFetch('/me',{method:'DELETE'}); SOC.key=null; SOC.me=null; PZ_CFG.rev++; SOC.share=null; SOC.cache={}; vaultForget(); try{ localStorage.removeItem(SOC_KEY_STORE); }catch(e){}
        location.hash='#social'; done('You left the league.'); return true; }
    }
  }catch(e){ pzNote(e.message,'err'); return true; }
  return false;
}


/* ======================= 11c · PULSE ACCOUNTS: wallet claims, sign-in on any device, encrypted journal sync ======================= */
// A wallet signature (Sign-In with Ethereum) claims a wallet for a profile and signs in on another
// device — no password, no transaction. A one-time code from a signed-in device works too, for
// phones without a wallet app. The journal can follow a member between devices as an encrypted
// copy: encrypted in this browser with a key stretched from a sync passphrase (PBKDF2 → AES-GCM),
// so the server, and its owner, only ever hold ciphertext. There's no reset: lose the passphrase
// and the synced copy can't be opened. The owner (signed in with AUTH_TOKEN) already syncs the
// whole journal to the server, so none of this applies to them.
const VAULT_STORE='pz_vault', VAULT_ITER=310000;
// mid: the member this sync belongs to (another profile signing in on this device never inherits it).
// dirty: journal ids edited here since the last push (with an edit counter, like _dirtyJ).
// base: settings and wallets as last synced, so a merge keeps only the fields changed here (null: all of
// this device's settings win, e.g. after restoring a backup). sGen/sSent: whether settings await a push.
var VAULT={key:null,salt:null,rev:0,mid:null,dirty:new Map(),base:null,sGen:0,sSent:0,timer:null,busy:false,again:false,err:null};
const vb64=buf=>{ let s=''; const a=buf instanceof Uint8Array?buf:new Uint8Array(buf); for(let i=0;i<a.length;i+=0x8000)s+=String.fromCharCode.apply(null,a.subarray(i,i+0x8000)); return btoa(s); };
const unvb64=s=>Uint8Array.from(atob(s),c=>c.charCodeAt(0));
function utf8Hex(s){ return '0x'+Array.from(new TextEncoder().encode(s),b=>b.toString(16).padStart(2,'0')).join(''); }

// Ask the browser's wallet to sign the server's message. purpose: 'claim' | 'login'.
async function socWalletSign(purpose){
  const eth=window.ethereum;
  if(!eth||typeof eth.request!=='function')throw new Error('No wallet in this browser. Use a browser with MetaMask or Rabby, or your wallet app’s built-in browser — or sign in with a code from a device you’re already signed in on.');
  const accts=((await eth.request({method:'eth_requestAccounts'}))||[]).map(a=>String(a).toLowerCase());
  const acct=accts[0]; if(!/^0x[0-9a-f]{40}$/.test(acct||''))throw new Error('Your wallet didn’t share an account.');
  const st=await socFetch('/'+purpose+'/start',{method:'POST',body:JSON.stringify({address:acct})});
  let signature;
  try{ signature=await eth.request({method:'personal_sign',params:[utf8Hex(st.message),acct]}); }
  catch(e){ throw new Error(e&&e.code===4001?'You cancelled the signature.':'Your wallet couldn’t sign: '+(e&&e.message||e)); }
  return Object.assign(await socFetch('/'+purpose+'/finish',{method:'POST',body:JSON.stringify({nonce:st.nonce,signature})}),{address:acct});
}
function socSignedIn(r){
  COACH.tried=false; COACH.status=null; COACH.msgs=null; PZ_CFG.rev++;
  if(VAULT.mid&&r.me&&r.me.id!==VAULT.mid)vaultForget(); // another profile: its sync isn't this one's
  SOC.key=r.key; try{ localStorage.setItem(SOC_KEY_STORE,r.key); }catch(e){}
  SOC.me=r.me; PZ_CFG.rev++; SOC.share=r.share; SOC.draft=null; SOC.cache={}; SOC.lastSent='';
}
// After signing in on a device: offer the synced journal if there is one, else read the claimed wallet.
async function acctAfterSignIn(){
  let v=null; try{ v=await socFetch('/vault'); }catch(e){}
  if(v&&v.blob&&!VAULT.key){ pzS.unlock=true; pzRender(); return; }
  await acctUseClaimedWallet();
}
async function acctUseClaimedWallet(){
  pzS.unlock=false; pzS.unlockSkip=true;
  const a=SOC.me&&SOC.me.claimedAddress;
  if(a&&!settings.wallets.some(w=>String(w.address).toLowerCase()===a)){ pzNote('Loading your trades…','busy'); $('walletAddr').value=a; await loadAll(); }
  else pzRender();
}

// ---- the encrypted journal ----
async function vaultLoadLocal(){
  try{ const v=JSON.parse(localStorage.getItem(VAULT_STORE)||'null');
    if(v&&v.k&&v.salt&&v.mid&&vaultCan()){ VAULT.key=await crypto.subtle.importKey('raw',unvb64(v.k),{name:'AES-GCM'},true,['encrypt','decrypt']);
      VAULT.salt=v.salt; VAULT.rev=+v.rev||0; VAULT.mid=v.mid; VAULT.dirty=new Map((v.dirty||[]).map(id=>[id,1]));
      VAULT.base=v.base===undefined?vaultSnapS():v.base; VAULT.sGen=v.sDirty?1:0; VAULT.sSent=0; } }catch(e){}
}
async function vaultSaveLocal(){ if(!VAULT.key)return;
  try{ localStorage.setItem(VAULT_STORE,JSON.stringify({k:vb64(await crypto.subtle.exportKey('raw',VAULT.key)),salt:VAULT.salt,rev:VAULT.rev,mid:VAULT.mid,
    dirty:[...VAULT.dirty.keys()].slice(-5000),base:VAULT.base,sDirty:VAULT.sGen!==VAULT.sSent})); }catch(e){} }
function vaultForget(){ clearTimeout(VAULT.timer); VAULT.key=null; VAULT.salt=null; VAULT.rev=0; VAULT.mid=null; VAULT.dirty=new Map(); VAULT.base=null; VAULT.sGen=VAULT.sSent=0; VAULT.err=null;
  try{ localStorage.removeItem(VAULT_STORE); }catch(e){} }
async function vaultDerive(pass, saltB64, iter){
  const base=await crypto.subtle.importKey('raw',new TextEncoder().encode(pass),'PBKDF2',false,['deriveKey']);
  return crypto.subtle.deriveKey({name:'PBKDF2',salt:unvb64(saltB64),iterations:iter||VAULT_ITER,hash:'SHA-256'},base,{name:'AES-GCM',length:256},true,['encrypt','decrypt']);
}
async function vaultSeal(key, salt, obj){
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const ct=await crypto.subtle.encrypt({name:'AES-GCM',iv},key,new TextEncoder().encode(JSON.stringify(obj)));
  return {v:1,iter:VAULT_ITER,salt,iv:vb64(iv),ct:vb64(ct)};
}
async function vaultOpen(key, blob){
  const pt=await crypto.subtle.decrypt({name:'AES-GCM',iv:unvb64(blob.iv)},key,unvb64(blob.ct));
  return JSON.parse(new TextDecoder().decode(pt));
}
// what travels: the same snapshot backups and the owner's server sync use (wallets, settings, journal)
function vaultPayload(){ return snapshot(); }
// Web Crypto only exists on https (and localhost): elsewhere sync isn't offered
function vaultCan(){ try{ return !!(window.isSecureContext&&window.crypto&&crypto.subtle); }catch(e){ return false; } }
function vaultSnapS(){ const o=_snapS(); o.wallets=JSON.parse(JSON.stringify(settings.wallets||[])); return o; }
function vaultActive(){
  if(SOC.me&&VAULT.mid&&SOC.me.id!==VAULT.mid)vaultForget(); // signed in as someone else now
  return !!(VAULT.key&&SOC.key&&socAvailable()&&!(SRV.token&&!SRV.badAuth)); }
function vaultDirty(){ return VAULT.dirty.size>0||VAULT.sGen!==VAULT.sSent; }
// called on every local save (Store.set / markJEdit)
function vaultMark(id){ if(!VAULT.key)return; if(id==null)VAULT.sGen++; else VAULT.dirty.set(id,(VAULT.dirty.get(id)||0)+1); }
// a restored backup is this device's word on everything: every entry and setting wins the next merge
// prev: the journal before the restore, so entries it removed stay removed too
function vaultMarkAll(prev, journalOnly){ if(!VAULT.key)return;
  for(const id of new Set([...Object.keys(prev||{}),...Object.keys(journal)]))VAULT.dirty.set(id,(VAULT.dirty.get(id)||0)+1);
  if(!journalOnly){ VAULT.base=null; VAULT.sGen++; } vaultSaveLocal(); }
function vaultSchedule(){ if(!vaultActive()||_applying)return; clearTimeout(VAULT.timer); VAULT.timer=setTimeout(()=>vaultPush(),3000); vaultSaveLocal(); }
// Another device's copy, merged: theirs wins, except journal entries edited here since the last push,
// settings fields changed here (against the last synced values), and wallets added or removed here.
async function vaultMerge(d){
  let theirs; try{ theirs=await vaultOpen(VAULT.key,d.blob); }
  catch(e){ vaultForget(); throw new Error('Your sync passphrase was changed on another device. Enter the new one under Social → What you share → Account to keep syncing.'); }
  const mineJ=journal, mine=vaultSnapS(), base=VAULT.base, ids=[...VAULT.dirty.keys()];
  const wBefore=JSON.stringify(settings.wallets);
  const changed=k=>!base||JSON.stringify(mine[k])!==JSON.stringify(base[k]);
  await applySnapshot(theirs);
  const theirsS=vaultSnapS();
  for(const id of ids){ if(mineJ[id]!==undefined)journal[id]=mineJ[id]; else delete journal[id]; }
  for(const k of _SYNC_S_FIELDS)if(changed(k))settings[k]=_syncMerge(k,mine[k],settings[k]);
  const wk=w=>String(w&&w.address).toLowerCase();
  if(!base)settings.wallets=mine.wallets;
  else { const was=new Set((base.wallets||[]).map(wk)), now=new Set(mine.wallets.map(wk));
    const out=theirsS.wallets.filter(w=>!(was.has(wk(w))&&!now.has(wk(w)))); // removed here
    for(const w of mine.wallets)if(!was.has(wk(w))&&!out.some(x=>wk(x)===wk(w)))out.push(w); // added here
    settings.wallets=out; }
  await rawSet(J_KEY,journal); await rawSet(S_KEY,settings);
  // until the merged copy is pushed, what this device changed still counts as changed against theirs
  VAULT.base=theirsS; VAULT.rev=d.rev; await vaultSaveLocal();
  try{ renderWallets(); }catch(e){}
  return JSON.stringify(settings.wallets)!==wBefore;
}
async function vaultPush(){
  if(!vaultActive())return;
  if(VAULT.busy){ VAULT.again=true; return; } VAULT.busy=true;
  try{
    const sentIds=[...VAULT.dirty.entries()], sentS=VAULT.sGen, sentBase=vaultSnapS();
    const blob=await vaultSeal(VAULT.key,VAULT.salt,vaultPayload());
    if(blob.ct.length>6*1024*1024)throw new Error('Your journal is too large to sync ('+(blob.ct.length/1048576).toFixed(1)+' MB; the limit is 6 MB).');
    const r=await fetch('/api/social/vault',{method:'PUT',headers:{'Content-Type':'application/json','X-Pulse-Key':SOC.key},body:JSON.stringify({rev:VAULT.rev,blob})});
    const d=await r.json().catch(()=>null);
    if(!d)throw new Error('The server’s answer didn’t arrive in full. Will retry.');
    if(r.status===409&&!d.blob){ vaultForget(); if(SOC.me)SOC.me.vault=null; pzNote('Your synced journal was deleted from another device, so this one stopped syncing.'); return; }
    if(r.status===409){ // another device saved first: merge its copy, then push again at its revision
      const walletsChanged=await vaultMerge(d); VAULT.again=true;
      if(walletsChanged&&settings.wallets.length)loadAll({auto:true}); else if(PZ)pzRender(); else render();
      return; }
    if(!r.ok)throw new Error(d.error||'HTTP '+r.status);
    VAULT.rev=d.rev; VAULT.err=null;
    for(const [id,c] of sentIds)if(VAULT.dirty.get(id)===c)VAULT.dirty.delete(id);
    VAULT.sSent=sentS; VAULT.base=sentBase; await vaultSaveLocal();
    if(SOC.me&&SOC.me.vault!==undefined)SOC.me.vault={rev:d.rev,size:blob.ct.length,at:d.at};
  }catch(e){ VAULT.err=e.message; if(PZ&&pzTab()==='account')pzRender(); }
  finally{ VAULT.busy=false; if(VAULT.again&&VAULT.key){ VAULT.again=false; clearTimeout(VAULT.timer); VAULT.timer=setTimeout(()=>vaultPush(),500); } }
}
// On open: take a newer copy from another device (merging anything unsent from here), else push what's unsent.
async function vaultSyncOnOpen(signal){
  if(!vaultActive())return false;
  try{ const d=await socFetch('/vault'+(VAULT.rev>0?'?have='+VAULT.rev:''),signal?{signal}:undefined);
    if(!d||!d.member)throw new Error('The server’s answer didn’t arrive in full.');
    if(VAULT.mid&&d.member!==VAULT.mid){ vaultForget(); return false; }
    let walletsChanged=false;
    if(d.unchanged){}
    else if(d.blob&&d.rev!==VAULT.rev)walletsChanged=await vaultMerge(d);
    else if(!d.blob&&VAULT.rev>0){ vaultForget(); VAULT.err=null; pzNote('Your synced journal was deleted from another device, so this one stopped syncing.'); return false; }
    else if(!d.blob){ VAULT.rev=d.rev||0; VAULT.sGen++; } // turned on here but never sent: send it now
    if(vaultDirty())vaultSchedule();
    return walletsChanged;
  }catch(e){ VAULT.err=e.message; if(e.status===401||e.status===403)vaultForget(); return false; }
}
// At startup, before the first load. A slow server is given up on (aborted, so nothing merges late).
async function vaultBoot(){
  await vaultLoadLocal();
  if(!vaultActive())return false;
  const ac=typeof AbortController==='function'?new AbortController():null, tm=ac?setTimeout(()=>ac.abort(),8000):0;
  try{ return await vaultSyncOnOpen(ac&&ac.signal); } finally{ clearTimeout(tm); }
}
// replace: overwrite a copy that's already there (a new passphrase); otherwise refuse to
async function vaultEnable(pass, replace){
  const salt=vb64(crypto.getRandomValues(new Uint8Array(16)));
  const key=await vaultDerive(pass,salt);
  const d=await socFetch('/vault');
  if(d.blob&&!replace){ if(SOC.me)SOC.me.vault={rev:d.rev,size:0,at:d.at};
    throw new Error('Another device turned on sync for this profile. Enter that passphrase to open your synced journal.'); }
  const sentBase=vaultSnapS(), blob=await vaultSeal(key,salt,vaultPayload());
  const r=await socFetch('/vault',{method:'PUT',body:JSON.stringify({rev:d.rev||0,blob})});
  VAULT.key=key; VAULT.salt=salt; VAULT.rev=r.rev; VAULT.mid=d.member||(SOC.me&&SOC.me.id); VAULT.dirty=new Map(); VAULT.base=sentBase; VAULT.sGen=VAULT.sSent=0; VAULT.err=null; await vaultSaveLocal();
  if(SOC.me)SOC.me.vault={rev:r.rev,size:blob.ct.length,at:r.at};
}
// Open the synced copy here. Anything only on this device is kept alongside it (theirs wins per entry).
async function vaultUnlock(pass){
  const d=await socFetch('/vault'); if(!d.blob)throw new Error('There’s no synced journal for this profile yet.');
  const key=await vaultDerive(pass,d.blob.salt,d.blob.iter);
  let data; try{ data=await vaultOpen(key,d.blob); }catch(e){ throw new Error('That passphrase doesn’t open your synced journal.'); }
  const mineJ=journal||{}, mineW=settings.wallets||[];
  await applySnapshot(data);
  VAULT.key=key; VAULT.salt=d.blob.salt; VAULT.rev=d.rev; VAULT.mid=d.member||(SOC.me&&SOC.me.id); VAULT.dirty=new Map(); VAULT.base=vaultSnapS(); VAULT.sGen=VAULT.sSent=0; VAULT.err=null;
  for(const id in mineJ)if(!(id in journal)){ journal[id]=mineJ[id]; VAULT.dirty.set(id,1); }
  for(const w of mineW)if(!settings.wallets.some(x=>String(x.address).toLowerCase()===String(w.address).toLowerCase())){ settings.wallets.push(w); VAULT.sGen++; }
  await rawSet(J_KEY,journal); await rawSet(S_KEY,settings); await vaultSaveLocal();
  if(vaultDirty())vaultSchedule();
  pzS.unlock=false; renderWallets();
  if(settings.wallets.length)await loadAll(); else await acctUseClaimedWallet();
}

// ---- screens ----
// On the first-run screen: already a member elsewhere? Sign in, or open your synced journal.
// a signed-in member with a synced journal they haven't opened on this device
function acctWantsUnlock(){ return !!(SOC.me&&!VAULT.key&&vaultCan()&&!(SRV.token&&!SRV.badAuth)&&(pzS.unlock||(!pzS.unlockSkip&&SOC.me.vault&&SOC.me.vault.rev&&SOC.me.vaultOn))); }
// the owner sent a sign-in link: one tap to sign in, wherever the member lands
function pzLinkCardHtml(){
  if(!pzS.linkCode||SOC.me||!socAvailable()||!SOC.cfg||!SOC.cfg.enabled)return '';
  return `<section class="pz-card" style="display:flex;flex-direction:column;gap:10px"><b style="font-size:15px">You’ve been invited to the league</b>
    <p class="pz-sub" style="font-size:13px">The league owner made a profile for you. Sign in with your code to pick it up on this device.</p>
    <div class="pz-field"><label for="socLinkIn" style="font-size:13px">Sign-in code</label><input type="text" id="socLinkIn" maxlength="14" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" value="${esc(pzS.linkCode)}"></div>
    <button type="button" class="pz-cta" id="socLinkGo">Sign in</button></section>`;
}
function acctConnectHtml(){
  if(!socAvailable()||!SOC.cfg||!SOC.cfg.enabled||(SRV.token&&!SRV.badAuth))return '';
  if(acctWantsUnlock())return `<section class="pz-card" style="display:flex;flex-direction:column;gap:10px;text-align:left"><b style="font-size:15px">Welcome back, @${esc(SOC.me.handle)}</b>
    <p class="pz-sub" style="font-size:13px">Your journal is synced. Enter your sync passphrase to open it on this device.</p>
    <div class="pz-field"><label for="vaultPass" style="font-size:13px">Sync passphrase</label><input type="password" id="vaultPass" autocomplete="current-password"></div>
    <button type="button" class="pz-cta" id="vaultUnlock">Open my journal</button><button type="button" class="pz-ghost pz-sm" id="vaultSkip">Skip — start without it</button></section>`;
  if(SOC.me){ const a=SOC.me.claimedAddress, known=a&&settings.wallets.some(w=>String(w.address).toLowerCase()===a);
    return `<p class="pz-fine">Signed in as @${esc(SOC.me.handle)}.${a?'':' Add your wallet address above to load your trades.'}</p>${a&&!known?`<button type="button" class="pz-ghost" id="acctLoadClaimed">Load my claimed wallet (${esc(walletShort(a))})</button>`:''}`; }
  return `<details class="pz-acct"${pzS.acctOpen?' open':''}><summary class="pz-fine" style="cursor:pointer">Already use Keel on another device? Sign in</summary>
    <div style="display:flex;flex-direction:column;gap:10px;margin-top:10px">
    ${pkAvailable()?'<button type="button" class="pz-ghost" id="socPkLogin">Sign in with a passkey</button><p class="pz-fine">Face ID, a fingerprint or your device PIN — once you’ve added a passkey under Account on a signed-in device.</p>':''}
    ${SOC.cfg.claims?'<button type="button" class="pz-ghost" id="socWalletLogin">Sign in with my wallet</button><p class="pz-fine">Works once you’ve claimed your wallet. It’s a signature, not a transaction — nothing moves.</p>':''}
    <div class="pz-field"><label for="socLinkIn" style="font-size:13px">Or enter a code from a signed-in device</label><input type="text" id="socLinkIn" maxlength="14" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" placeholder="e.g. K7Q2M9XW4P" value="${esc(pzS.linkCode||'')}">
      <button type="button" class="pz-ghost pz-sm" id="socLinkGo">Sign in with code</button></div>
    <p class="pz-fine">Get a code on your other device under Social → What you share → Account → Add a device.</p></div></details>`;
}
function socClaimCardHtml(){
  if(!SOC.cfg||!SOC.cfg.claims)return '';
  const me=SOC.me;
  if(me.claimed)return `<section class="pz-card" style="display:flex;flex-direction:column;gap:10px"><b style="font-size:15px;display:flex;align-items:center;gap:8px">${pzI('shield',18)}Wallet claimed</b>
    <p class="pz-sub" style="font-size:13px"><code>${esc(walletShort(me.claimedAddress||''))}</code> is locked to @${esc(me.handle)}. Nobody else can use it here, your boards show a ✓, and you can sign in with it on any device. Only a signature from this wallet can move it.</p>
    <button type="button" class="pz-ghost pz-sm" id="socUnclaim">Release this wallet</button></section>`;
  return `<section class="pz-card" style="display:flex;flex-direction:column;gap:10px"><b style="font-size:15px;display:flex;align-items:center;gap:8px">${pzI('shield',18)}Claim your wallet</b>
    <p class="pz-sub" style="font-size:13px">Prove a wallet is yours by signing a short message with it. It’s a signature, not a transaction: no gas, nothing moves. A claimed wallet is locked to your profile, gets a ✓ on the boards${me.requireClaim?' (this league only counts claimed wallets for verified Discipline and returns)':''}, and lets you sign in on any device. The server owner can see the address.</p>
    <button type="button" class="pz-ghost" id="socClaim">Claim with my wallet</button>
    <p class="pz-fine">Signs with the account selected in your browser wallet (MetaMask, Rabby…). On a phone, open this page in your wallet app’s browser.</p></section>`;
}
// ---- passkeys: Face ID / fingerprint / security key sign-in (server side: webauthn.js) ----
function pkAvailable(){ return !!(typeof window!=='undefined'&&window.PublicKeyCredential&&navigator.credentials&&window.isSecureContext&&SOC.cfg&&SOC.cfg.passkeys); }
const pkBuf=s=>Uint8Array.from(atob(String(s).replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));
const pkB64u=b=>btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
function pkJSON(c){ const r=c.response, o={id:c.id,rawId:pkB64u(c.rawId),type:c.type,response:{clientDataJSON:pkB64u(r.clientDataJSON)}};
  if(r.attestationObject)o.response.attestationObject=pkB64u(r.attestationObject);
  if(r.authenticatorData){ o.response.authenticatorData=pkB64u(r.authenticatorData); o.response.signature=pkB64u(r.signature); o.response.userHandle=r.userHandle?pkB64u(r.userHandle):null; }
  return o; }
// a short label for a new passkey: the kind of device it was made on
function pkDeviceName(){ const u=navigator.userAgent||''; return /iPhone/.test(u)?'iPhone':/iPad/.test(u)?'iPad':/Android/.test(u)?'Android':/Mac/.test(u)?'Mac':/Windows/.test(u)?'Windows':/Linux/.test(u)?'Linux':'This device'; }
async function pkAdd(){
  const o=await socFetch('/passkey/register/start',{method:'POST'});
  const cred=await navigator.credentials.create({publicKey:{...o,challenge:pkBuf(o.challenge),user:{...o.user,id:pkBuf(o.user.id)},excludeCredentials:(o.excludeCredentials||[]).map(c=>({...c,id:pkBuf(c.id)}))}});
  return socFetch('/passkey/register/finish',{method:'POST',body:JSON.stringify({credential:pkJSON(cred),name:pkDeviceName()})});
}
async function pkLogin(){
  const o=await socFetch('/passkey/login/start',{method:'POST'});
  const cred=await navigator.credentials.get({publicKey:{challenge:pkBuf(o.challenge),rpId:o.rpId,timeout:o.timeout,userVerification:o.userVerification}});
  return socFetch('/passkey/login/finish',{method:'POST',body:JSON.stringify({credential:pkJSON(cred)})});
}
function socPasskeysCardHtml(){
  if(!SOC.cfg||!SOC.cfg.passkeys)return '';
  const me=SOC.me, list=me.passkeys||[];
  return `<section class="pz-card" style="display:flex;flex-direction:column;gap:10px"><b style="font-size:15px;display:flex;align-items:center;gap:8px">${pzI('shield',18)}Passkeys</b>
    <p class="pz-sub" style="font-size:13px">Sign in on any device with Face ID, a fingerprint or your device PIN — no code, no wallet. ${list.length?'':'Add one here and it syncs through your phone’s or computer’s password manager.'}</p>
    ${list.map(k=>`<div class="pz-wl"><span>${esc(k.name)} <span class="pz-fine">· added ${esc(socAgo(k.at))}${k.lastUsed?' · last used '+esc(socAgo(k.lastUsed)):''}</span></span><button type="button" class="pz-ghost pz-sm" data-pk-del="${esc(k.id)}" aria-label="Remove passkey ${esc(k.name)}">Remove</button></div>`).join('')}
    ${pkAvailable()?'<button type="button" class="pz-ghost pz-sm" id="socPkAdd">Add a passkey on this device</button>':'<p class="pz-fine">This browser can’t make passkeys here (they need a secure https page and a recent browser).</p>'}</section>`;
}
function socDevicesCardHtml(){
  const me=SOC.me, L=SOC.link&&SOC.link.exp>Date.now()?SOC.link:null;
  return `<section class="pz-card" style="display:flex;flex-direction:column;gap:10px"><b style="font-size:15px">Your devices</b>
    <p class="pz-sub" style="font-size:13px">Signed in on ${me.devices||1} device${(me.devices||1)===1?'':'s'}. On a new device, sign in with ${[(me.passkeys||[]).length?'a passkey':'',me.claimed?'your wallet':''].filter(Boolean).join(' or ')||'a one-time code from here'}${(me.passkeys||[]).length||me.claimed?', or a one-time code from here':''}.</p>
    ${L?`<div class="pz-code" aria-live="polite"><b style="font-family:var(--pz-num);font-size:26px;letter-spacing:.12em">${esc(L.code.slice(0,5)+' '+L.code.slice(5))}</b><span class="pz-fine">On the other device open Keel, choose “Already use Keel on another device?” and enter this code. It works once, for 10 minutes.</span></div>`
      :'<button type="button" class="pz-ghost pz-sm" id="socLinkNew">Add a device</button>'}
    ${(me.devices||1)>1?'<button type="button" class="pz-ghost pz-sm" id="socSignOutOthers">Sign out other devices</button>':''}</section>`;
}
function socVaultCardHtml(){
  const me=SOC.me;
  if(!me.vaultOn&&!VAULT.key)return '';
  if(!vaultCan())return `<section class="pz-card"><b style="font-size:15px">Your journal on every device</b><p class="pz-sub" style="font-size:13px;margin-top:6px">Encrypted sync needs a secure (https) connection. Open Keel from its https address to turn it on.</p></section>`;
  if(VAULT.key)return `<section class="pz-card" style="display:flex;flex-direction:column;gap:10px"><b style="font-size:15px;display:flex;align-items:center;gap:8px">${pzI('check',16)}Journal sync is on</b>
    <p class="pz-sub" style="font-size:13px">Your journal, wallets and settings are encrypted on this device before they’re sent, so the server stores only scrambled data. On another device, sign in and enter your sync passphrase.</p>
    ${VAULT.err?`<p class="pz-fine pz-err" role="alert">Last sync failed: ${esc(VAULT.err)}</p>`:me.vault&&me.vault.at?`<p class="pz-fine">Last synced ${socAgo(me.vault.at)}${me.vault.at>Date.now()-60000?'':' ago'}.</p>`:''}
    <div style="display:flex;gap:8px;flex-wrap:wrap"><button type="button" class="pz-ghost pz-sm" id="vaultOff">Stop syncing on this device</button><button type="button" class="pz-ghost pz-sm" id="vaultDelete" style="color:var(--pz-err-t);border-color:var(--pz-err-b)">Delete the synced copy</button></div></section>`;
  const has=!!(me.vault&&me.vault.rev);
  return `<section class="pz-card" style="display:flex;flex-direction:column;gap:10px"><b style="font-size:15px">Your journal on every device</b>
    <p class="pz-sub" style="font-size:13px">${has?'This profile has a synced journal. Enter its passphrase to open it here — anything only on this device is kept too.'
      :'Choose a sync passphrase. Your journal, wallets and settings are encrypted on this device before they leave it: the server, and its owner, can’t read them. There’s no reset — lose the passphrase and the synced copy can’t be opened.'}</p>
    <div class="pz-field"><label for="vaultPass" style="font-size:13px">Sync passphrase</label><input type="password" id="vaultPass" autocomplete="${has?'current-password':'new-password'}" placeholder="${has?'':'at least 10 characters'}"></div>
    ${has?'<button type="button" class="pz-ghost" id="vaultUnlock">Open my synced journal</button><button type="button" class="pz-ghost pz-sm" id="vaultReplace">Replace it with this device’s journal (new passphrase)</button>'
      :'<div class="pz-field"><label for="vaultPass2" style="font-size:13px">Type it again</label><input type="password" id="vaultPass2" autocomplete="new-password"></div><button type="button" class="pz-ghost" id="vaultOn">Turn on journal sync</button>'}</section>`;
}

// ---- actions (from socAction) ----
async function acctAction(t){
  const done=(m,kind)=>{ if(m)pzNote(m,kind); socStale(); pzRender(); };
  const pass=()=>{ const el=$('vaultPass'), v=el?el.value:''; return v; };
  const clearPass=()=>{ for(const id of ['vaultPass','vaultPass2']){ const el=$(id); if(el)el.value=''; } };
  if(t.dataset&&t.dataset.pkDel){ if(!confirm('Remove this passkey? You won’t be able to sign in with it here any more.'))return true;
    const r=await socFetch('/passkey/'+encodeURIComponent(t.dataset.pkDel),{method:'DELETE'}); SOC.me=r.me; done('Passkey removed.'); return true; }
  switch(t.id){
    case 'socPkAdd': { pzNote('Follow your device’s prompt…','busy');
      try{ const r=await pkAdd(); SOC.me=r.me; done('Passkey added. On another device, choose “Sign in with a passkey”.'); }
      catch(e){ if(e&&e.name==='NotAllowedError'){ pzNote('Cancelled.'); return true; } if(e&&e.name==='InvalidStateError'){ pzNote('This device already has a passkey for your profile.','err'); return true; } throw e; }
      return true; }
    case 'socPkLogin': { pzS.acctOpen=true; pzNote('Follow your device’s prompt…','busy');
      let r; try{ r=await pkLogin(); }catch(e){ if(e&&e.name==='NotAllowedError'){ pzNote('Cancelled.'); return true; } throw e; }
      socSignedIn(r); pzNote('Signed in as @'+r.me.handle+'.'); await acctAfterSignIn(); return true; }
    case 'socClaim': { pzNote('Waiting for your wallet…','busy'); const r=await socWalletSign('claim'); SOC.me=r.me; PZ_CFG.rev++; SOC.share=r.share; SOC.draft=null;
      const known=settings.wallets.some(w=>String(w.address).toLowerCase()===r.address);
      done('Claimed '+walletShort(r.address)+'. It’s locked to your profile.'+(known?'':' It isn’t one of the wallets Keel reads — add it in Settings to see its trades.')); return true; }
    case 'socUnclaim': { if(!confirm('Release this wallet? Anyone could name it again, and you’d lose wallet sign-in until you claim it again.'))return true;
      const r=await socFetch('/claim/release',{method:'POST'}); SOC.me=r.me; PZ_CFG.rev++; done('Wallet released.'); return true; }
    case 'socWalletLogin': { pzS.acctOpen=true; pzNote('Waiting for your wallet…','busy'); const r=await socWalletSign('login'); socSignedIn(r);
      pzNote('Signed in as @'+r.me.handle+'.'); await acctAfterSignIn(); return true; }
    case 'socLinkGo': { pzS.acctOpen=true; const c=($('socLinkIn')||{value:''}).value.trim(); if(!c)return true;
      const r=await socFetch('/link/finish',{method:'POST',body:JSON.stringify({code:c})}); socSignedIn(r); pzS.linkCode=null; if($('socLinkIn'))$('socLinkIn').value='';
      pzNote('Signed in as @'+r.me.handle+'.'); await acctAfterSignIn(); return true; }
    case 'socLinkNew': { const r=await socFetch('/link/start',{method:'POST'}); SOC.link={code:r.code,exp:r.expiresAt};
      setTimeout(()=>{ if(SOC.link&&SOC.link.code===r.code){ SOC.link=null; if(pzTab()==='account')pzRender(); } },10*60000); pzRender(); return true; }
    case 'socSignOutOthers': { if(!confirm('Sign out every other device? They’ll need your wallet or a new code to sign back in.'))return true;
      // a passkey signs straight back in, so if a device was lost (or someone else had your key) they go too
      const pk=(SOC.me&&SOC.me.passkeys||[]).length&&confirm('Also remove your '+SOC.me.passkeys.length+' passkey'+(SOC.me.passkeys.length===1?'':'s')+'?\n\nDo this if a device was lost or someone else may have had your key. You can add a passkey again on this device afterwards.');
      const r=await socFetch('/devices'+(pk?'?passkeys=1':''),{method:'DELETE'}); SOC.me=r.me; PZ_CFG.rev++; SOC.link=null; done('Other devices are signed out.'); return true; }
    case 'vaultOn': { const p=pass(), p2=($('vaultPass2')||{value:''}).value;
      if(p.length<10){ pzNote('Use at least 10 characters — a few words you’ll remember works well.','err'); return true; }
      if(p!==p2){ pzNote('The two passphrases don’t match.','err'); return true; }
      pzNote('Encrypting your journal…','busy');
      try{ await vaultEnable(p); }catch(e){ pzRender(); throw e; }
      clearPass(); done('Journal sync is on. Keep your passphrase safe: there’s no reset.'); return true; }
    case 'vaultReplace': { const p=pass(); if(p.length<10){ pzNote('Type a new passphrase of at least 10 characters first.','err'); return true; }
      if(!confirm('Replace the synced journal with this device’s journal, under this new passphrase? Other devices will need the new passphrase.'))return true;
      pzNote('Encrypting your journal…','busy'); await vaultEnable(p,true); clearPass(); done('Synced journal replaced.'); return true; }
    case 'vaultUnlock': { const p=pass(); if(!p)return true; pzNote('Opening your journal…','busy');
      await vaultUnlock(p); clearPass(); pzNote('Your journal is open on this device and syncs from here on.'); socStale(); pzRender(); return true; }
    case 'vaultSkip': case 'acctLoadClaimed': await acctUseClaimedWallet(); return true;
    case 'vaultOff': vaultForget(); done('This device stopped syncing. The synced copy is still on the server.'); return true;
    case 'vaultDelete': { if(!confirm('Delete the synced copy from the server? This device keeps its journal; other devices stop syncing.'))return true;
      await socFetch('/vault',{method:'DELETE'}); vaultForget(); if(SOC.me)SOC.me.vault=null; done('Synced copy deleted.'); return true; }
  }
  return false;
}
