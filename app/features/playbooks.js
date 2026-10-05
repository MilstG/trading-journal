/* ============================================================================
   Playbooks in Daruma — your setups' rules, and the ones members share.
   A feature in its own file: it plugs into Daruma through pzFeature (app/pulse.js) and loads on
   Daruma's page only (data-only="keel" in ledger.html).

   #playbooks           your playbooks (settings.playbooks, the full journal's Review → Playbooks):
                        write and edit them, see what keeping each one's rules is worth (playbookStats),
                        share one with the league, take an update to one you adopted
   #playbooks/shared    what members share (social.js /playbooks): search, sort, adopt a copy
   #playbooks/<id>      one shared playbook with every rule

   Adopting copies the name, the rules (with their ids) and the target reward-to-risk into your own playbooks,
   marked with where it came from (src: {id, h, v, at}); aliases stay your own. The copy's id is made from the shared one's ('pbs' + its id), so
   two devices that adopt the same playbook before they sync make one playbook, not two: sync merges
   playbooks by id, and ticks made on either device point at it. From then on it's yours: a trade whose setup names it gets the
   checklist (Daruma's journal card, or the full journal), and its scorecard reads only your trades, on
   this device. The author sees how many adopted it, never anyone's trades. When the author shares a new
   version (its name or rules changed), adopters hear of it and can take the update, which keeps the ids
   of unchanged rules, so ticks already made still count. An adopter with a scorecard can tell the author,
   anonymously, whether it pays for them (pays: true/false on their adoption); members see "N of M adopters
   say it pays" once three have answered, never who.
   ============================================================================ */
const PBS={q:'',sort:'popular',page:0,edit:null,share:null,confirm:null,draft:{}};
// what's typed in the editor or the share note, kept across Daruma's background redraws (like the bio's draft)
const pbsDraft=(id,v)=>PBS.draft[id]!=null?PBS.draft[id]:v;
const PBS_SORT=[['popular','Most adopted'],['new','Newest'],['mentors','Mentors first']];

// ---- pure: copies and updates (tests/test-playbook-share.mjs) ----
// a copy's id, the same on every device (adopting again after deleting it brings back the same playbook,
// so ticks from before still count)
function pbsCopyId(id){ return 'pbs'+id; }
// the playbook in list that is a copy of shared playbook id
function pbsSharedFrom(list, id){ return (list||[]).find(p=>!p.del&&p.src&&p.src.id===id)||null; }
// sh: a shared playbook (with every rule); list: your playbooks. -> {pb, renamed} | {existing} | {error}
function pbsAdoptCopy(sh, list, now, mkId){
  const live=(list||[]).filter(p=>!p.del), have=pbsSharedFrom(live,sh.id); if(have)return {existing:have};
  const h=sh.author?sh.author.handle:'', taken=n=>live.some(p=>pbKey(p.name)===pbKey(n));
  // its name is what you type as a trade's setup: one you already use gets the author's handle
  let name=sh.name, renamed=false;
  if(taken(name)){ name=(sh.name+' · @'+h).slice(0,60); renamed=true;
    if(taken(name))return {error:'You already have a playbook called “'+name+'”. Rename yours first.'}; }
  mkId=mkId||(()=>pbsCopyId(sh.id));
  return {pb:{id:mkId(),name,rules:sh.rules.map(r=>({id:r.id,text:r.text})),...(sh.rr>0?{rr:sh.rr}:{}),at:now,createdAt:now,src:{id:sh.id,h,v:sh.version,at:now}},renamed};
}
// the update: the author's rules, target reward-to-risk and version; your name and aliases stay (you may have renamed it)
function pbsApplyUpdate(local, sh, now){
  const next=Object.assign({},local,{rules:sh.rules.map(r=>({id:r.id,text:r.text})),at:now,src:Object.assign({},local.src,{v:sh.version,at:now})});
  if(sh.rr>0)next.rr=sh.rr; else delete next.rr;
  return next;
}
// what an update changes: a reworded rule has a new id, so it reads as one removed and one added
function pbsRuleDiff(a, b){
  const ia=new Set((a||[]).map(r=>r.id)), ib=new Set((b||[]).map(r=>r.id));
  return {added:(b||[]).filter(r=>!ia.has(r.id)).map(r=>r.text),removed:(a||[]).filter(r=>!ib.has(r.id)).map(r=>r.text),kept:(b||[]).filter(r=>ia.has(r.id)).length};
}
// your playbook against what you shared of it: changed when its name, rules or target reward-to-risk did
function pbsDiffers(pb, sh){
  if(!sh)return false; const k=rs=>JSON.stringify((rs||[]).map(r=>[r.id,r.text]));
  return pb.name!==sh.name||k(pb.rules)!==k(sh.rules)||(pb.rr||null)!==(sh.rr||null);
}

// ---- the server's side ----
function pbsOn(){ return typeof socAvailable==='function'&&socAvailable()&&!!SOC.me&&!(SOC.cfg&&SOC.cfg.playbooks&&SOC.cfg.playbooks.on===false); }
const pbsDrop=()=>{ for(const k of Object.keys(SOC.cache))if(k.startsWith('pbs:'))delete SOC.cache[k]; };
function pbsMine(){ if(!pbsOn())return null;
  const ids=pbList().filter(p=>p.src).map(p=>p.src.id).sort().join(',');
  return socGet('pbs:mine:'+ids,'/playbooks/mine?have='+ids,20000); }
const pbsWhen=ms=>new Date(ms).toLocaleDateString('en-US',{month:'short',day:'numeric',year:new Date(ms).getFullYear()===new Date().getFullYear()?undefined:'numeric'});
const pbsN=(n,w)=>n+' '+w+(n===1?'':'s');

// ---- screens ----
function pbsTabs(cur){
  const off=!(typeof socAvailable==='function'&&socAvailable())||(SOC.cfg&&SOC.cfg.playbooks&&SOC.cfg.playbooks.on===false);
  return off?'':`<div class="pz-chiprow" role="group" aria-label="Playbooks">${[['','Yours'],['shared','Shared by members']].map(([k,l])=>`<a class="pz-chipbtn" href="#playbooks${k?'/'+k:''}" aria-pressed="${k===cur}">${l}</a>`).join('')}</div>`;
}
function pbsScreenHtml(D){
  const a=pzHashArg();
  return a==='shared'?pbsSharedHtml():/^[0-9a-f]{12}$/.test(a)?pbsOneHtml(a):pbsYoursHtml(D);
}
// what keeping a playbook's rules is worth, over every closed trade (as XP and Discipline read them)
function pbsScoreHtml(s){
  if(!s.checked)return `<p class="pz-sub" style="font-size:13px;margin:0">${s.n?pbsN(s.n,'trade')+' with this setup, none checked yet.':'No trades with this setup yet.'} Type “${esc(s.name)}” as a trade’s setup and tick the rules you kept.</p>`;
  const pct=x=>x==null?'—':Math.round(x*100)+'%';
  const res=a=>!a.n?'—':pbsN(a.n,'trade')+' · win '+pct(a.wr)+' · '+(a.avgR!=null&&a.nR>=a.n/2?(a.avgR>=0?'+':'')+a.avgR.toFixed(2)+'R':fmtUsd(a.exp))+' a trade';
  const g=pbGap(s.kept,s.broke), early=g&&Math.min(s.kept.n,s.broke.n)<10, tr=s.trend, trendOn=tr.earlier.n>=5&&tr.recent.n>=5;
  const sg=v=>(v>=0?'+':'−')+(g.unit==='R'?Math.abs(v).toFixed(2)+'R':fmtUsd(Math.abs(v)));
  return `<div class="pz-row-t"><span>Kept every rule</span><b>${res(s.kept)}</b></div><div class="pz-row-t"><span>Broke one</span><b>${res(s.broke)}</b></div>
    ${g?`<p class="pz-sub" style="font-size:13px;margin:0">Keeping it is worth <b style="color:${g.v>=0?PZ_COL.good:PZ_COL.low}">${sg(g.v)}</b> a trade${s.range?' (9 times in 10: '+sg(s.range.lo)+' to '+sg(s.range.hi)+')':''}${early?' so far (fewer than 10 trades on one side: it can still flip)':''}.</p>`:''}
    ${s.mostBroken?`<div class="pz-row-t" data-pz-tip="The rule left unticked on the most checked trades. Fixing one rule is easier than fixing a setup." tabindex="0"><span>Broken most</span><b style="text-align:right">${esc(s.mostBroken.text)} <span class="pz-sub" style="font-weight:400">· ${s.mostBroken.broke} of ${s.mostBroken.graded}</span></b></div>`:''}
    ${trendOn?`<div class="pz-row-t" data-pz-tip="Checked trades that kept every rule: the last ${tr.recent.n} against the ${tr.earlier.n} before them." tabindex="0"><span>Trend</span><b style="color:${tr.recent.rate>=tr.earlier.rate?PZ_COL.good:PZ_COL.low}">${pct(tr.recent.rate)} kept every rule <span class="pz-sub" style="font-weight:400">· was ${pct(tr.earlier.rate)}</span></b></div>`:''}
    <div class="pz-row-t" data-pz-tip="Checklists filled while the trade was open, or in Plan a trade before it. Ticks made after the close know how it went; these don’t." tabindex="0"><span>Ticked before the close</span><b>${s.live} of ${s.checked}</b></div>`;
}
function pbsEditorHtml(p){
  return `<section class="pz-card pz-kv"><b class="pz-kvh">${p?'Edit '+esc(p.name):'New playbook'}</b>
    <div class="pz-field"><label for="pbsName">Setup name</label><input type="text" id="pbsName" maxlength="60" value="${esc(pbsDraft('pbsName',p?p.name:''))}" placeholder="e.g. Breakout retest" autocomplete="off"></div>
    <div class="pz-field"><label for="pbsRules">Rules, one per line</label><textarea id="pbsRules" rows="5" placeholder="Wait for the retest of the range high&#10;Stop under the range low&#10;Risk 1R or less">${esc(pbsDraft('pbsRules',p?p.rules.map(r=>r.text).join('\n'):''))}</textarea></div>
    <div class="pz-field"><label for="pbsAliases">Also matches (other setup names, comma separated)</label><input type="text" id="pbsAliases" maxlength="200" value="${esc(pbsDraft('pbsAliases',p&&p.aliases?p.aliases.join(', '):''))}" placeholder="breakout, bo retest" autocomplete="off"></div>
    <div class="pz-field"><label for="pbsRR">Target reward-to-risk (optional)</label><input type="number" id="pbsRR" inputmode="decimal" step="0.1" min="0.1" max="50" value="${esc(pbsDraft('pbsRR',p&&p.rr?String(p.rr):''))}" placeholder="e.g. 2 for 1:2"></div>
    <p class="pz-fine" style="margin:0">A trade gets this checklist when its setup says this name or one of the others. Plan a trade fills the target from the reward-to-risk. Rewording a rule starts it fresh; unchanged lines keep their history.${p&&p.src?' This is your copy: @'+esc(p.src.h)+'’s stays as they wrote it.':''}</p>
    <div style="display:flex;gap:8px"><button type="button" class="pz-cta pz-sm" data-pbs="save" data-id="${esc(p?p.id:'')}" style="flex:1">Save playbook</button><button type="button" class="pz-ghost pz-sm" data-pbs="cancel">Cancel</button></div></section>`;
}
function pbsYoursHtml(D){
  const list=pbList(), back=`<a class="pz-back" href="#social">${pzI('back',20)}Social</a>`;
  const closed=allTrades.filter(t=>!t.isOpen&&t.closeTime), stats=playbookStats(closed,journal,list,rFor);
  const M=pbsMine(), md=M&&M.d, mineBy=new Map(((md&&md.mine)||[]).map(x=>[x.src,x])), have=(md&&md.have)||{}, demo=!!pzS.demo, cf=PBS.confirm;
  const card=(p,s)=>{ if(PBS.edit===p.id)return pbsEditorHtml(p);
    const sh=mineBy.get(p.id), up=p.src&&have[p.src.id]&&have[p.src.id].version>p.src.v?have[p.src.id]:null, gone=p.src&&md&&!have[p.src.id];
    const tags=[p.src?`<a class="pz-tag" href="#playbooks/${esc(p.src.id)}" style="text-decoration:none">from @${esc(p.src.h)}</a>`:'',sh?`<span class="pz-tag win">Shared · ${pbsN(sh.adopts,'adopter')}${sh.pays&&sh.pays.n>=3?' · '+sh.pays.yes+' of '+sh.pays.n+' say it pays':''}</span>`:'',p.rr?`<span class="pz-tag">aims 1:${esc(String(p.rr))}</span>`:'',
      up?`<span class="pz-tag info">Update from @${esc(up.handle)}</span>`:'',gone?'<span class="pz-tag">No longer shared: your copy stays</span>':''].filter(Boolean).join('');
    let share='';
    if(PBS.share===p.id)share=`<div class="pz-field"><label for="pbsAbout">A note for whoever adopts it (optional)</label><textarea id="pbsAbout" rows="3" maxlength="400" placeholder="When it works, what it's for, what to watch">${esc(pbsDraft('pbsAbout',sh?sh.about:''))}</textarea></div>
      <p class="pz-fine" style="margin:0">Members with a profile see its name, its rules and this note, with your name. Never your trades or how it went for you.</p>
      <div style="display:flex;gap:8px"><button type="button" class="pz-cta pz-sm" data-pbs="share" data-id="${esc(p.id)}" style="flex:1">${sh?'Share the changes':'Share it'}</button><button type="button" class="pz-ghost pz-sm" data-pbs="cancel">Cancel</button></div>`;
    else if(md&&!p.src&&!demo){ const ch=sh&&pbsDiffers(p,sh);
      share=sh?`<div style="display:flex;gap:8px;flex-wrap:wrap">${ch?`<button type="button" class="pz-cta pz-sm" data-pbs="shareform" data-id="${esc(p.id)}">Share your changes</button>`:`<button type="button" class="pz-ghost pz-sm" data-pbs="shareform" data-id="${esc(p.id)}">Edit the note</button>`}
          <button type="button" class="pz-quietbtn warn" data-pbs="unshare" data-sid="${esc(sh.id)}">${cf==='unshare:'+sh.id?'Tap again: copies others adopted stay theirs':'Stop sharing'}</button></div>`
        :md.canShare?`<button type="button" class="pz-ghost pz-sm" data-pbs="shareform" data-id="${esc(p.id)}">${pzI('social',14)} Share with the league</button>`:''; }
    let upd='';
    if(up&&!demo){ const S1=socGet('pbs:one:'+p.src.id,'/playbooks/'+p.src.id,20000), full=S1&&S1.d&&S1.d.playbook, df=full&&full.version===up.version?pbsRuleDiff(p.rules,full.rules):null;
      upd=`<div class="pz-quote" style="font-size:13px">@${esc(up.handle)} changed it${df?': '+[df.added.length?pbsN(df.added.length,'rule')+' added':'',df.removed.length?pbsN(df.removed.length,'rule')+' gone':''].filter(Boolean).join(', ')+'.':'.'}${p.at>p.src.at?' Taking it replaces the rules you changed.':''}</div>
        <button type="button" class="pz-cta pz-sm" data-pbs="update" data-id="${esc(p.id)}">Get the update</button>`; }
    // an adopted playbook with a scorecard: tell the author whether it pays, anonymously (a count, never a name or a trade)
    let pays='';
    if(p.src&&have[p.src.id]&&s.checked&&!demo&&pbGap(s.kept,s.broke)){ const my=have[p.src.id].myPays, on=v=>my===v;
      pays=`<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center"><span class="pz-sub" style="font-size:13px" data-pz-tip="Only a count reaches @${esc(p.src.h)} and the members browsing it: “N of M adopters say it pays”. Never your trades or your name." tabindex="0">Tell @${esc(p.src.h)}, anonymously:</span>
        <button type="button" class="pz-chipbtn" data-pbs="pays" data-sid="${esc(p.src.id)}" data-v="${on(true)?'':'1'}" aria-pressed="${on(true)}">It pays for me</button><button type="button" class="pz-chipbtn" data-pbs="pays" data-sid="${esc(p.src.id)}" data-v="${on(false)?'':'0'}" aria-pressed="${on(false)}">Not for me</button></div>`; }
    return `<section class="pz-card pz-kv"><div style="display:flex;justify-content:space-between;gap:8px;align-items:baseline"><b class="pz-kvh">${esc(p.name)}</b><span class="pz-sub" style="font-size:12px">${pbsN(p.rules.length,'rule')}</span></div>
      ${tags?`<div class="pz-tags">${tags}</div>`:''}
      ${p.aliases&&p.aliases.length?`<p class="pz-sub" style="font-size:12px;margin:0">Also matches: ${esc(p.aliases.join(', '))}</p>`:''}
      <ol style="margin:0;padding-left:20px;font-size:14px;line-height:1.5">${p.rules.map(r=>`<li>${esc(r.text)}</li>`).join('')||'<li class="pz-sub">No rules yet.</li>'}</ol>
      ${pbsScoreHtml(s)}${pays}${upd}${share}
      <div style="display:flex;gap:8px;flex-wrap:wrap"><button type="button" class="pz-linkbtn" data-pbs="edit" data-id="${esc(p.id)}">Edit</button><button type="button" class="pz-linkbtn" data-pbs="del" data-id="${esc(p.id)}">${cf==='del:'+p.id?'Tap again to delete it':'Delete'}</button></div></section>`; };
  // shared, then deleted here (or in the full journal): still on the league's list until you stop sharing it
  const orphans=((md&&md.mine)||[]).filter(x=>!list.some(p=>p.id===x.src));
  const orphan=x=>`<section class="pz-card pz-kv"><b class="pz-kvh">${esc(x.name)}</b><div class="pz-tags"><span class="pz-tag caution">Still shared · ${pbsN(x.adopts,'adopter')}</span></div>
      <p class="pz-sub" style="font-size:13px;margin:0">You deleted it from your playbooks, but members can still find and adopt it.</p>
      ${demo?'':`<div style="display:flex;gap:8px;flex-wrap:wrap"><button type="button" class="pz-quietbtn warn" data-pbs="unshare" data-sid="${esc(x.id)}">${cf==='unshare:'+x.id?'Tap again: copies others adopted stay theirs':'Stop sharing'}</button>
        <button type="button" class="pz-ghost pz-sm" data-pbs="restore" data-sid="${esc(x.id)}">Bring it back</button></div>`}</section>`;
  const cards=list.map((p,i)=>card(p,stats[i])).join('')+orphans.map(orphan).join('');
  const off=!pbsOn();
  return `${back}${pzHead('Your setups’ rules','Playbooks')}${pbsTabs('')}
    <p class="pz-sub" style="margin:0">Write the rules for each setup once. When a trade’s setup names a playbook, its journal card gets the checklist: tick the rules you kept, and each playbook here shows what keeping them is worth, from your own trades.</p>
    ${demo?'<p class="pz-fine">Sample mode: sharing and adopting wait until you leave it, and playbooks you write here go with the sample.</p>':''}
    <div class="pz-jgrid">${cards}${PBS.edit==='new'?pbsEditorHtml(null):''}</div>
    ${!list.length&&!orphans.length&&PBS.edit!=='new'?`<section class="pz-card pz-empty"><b>No playbooks yet</b><p class="pz-sub">Write your first, or ${off?'open Daruma from your server to adopt one a member shared':'<a href="#playbooks/shared">adopt one a member shared</a>'}.</p></section>`:''}
    ${PBS.edit===null&&list.length<PB_MAX?`<button type="button" class="pz-ghost" data-pbs="new">${pzI('plus',16)} New playbook</button>`:''}
    ${md&&!md.canShare&&md.who==='mentors'?'<p class="pz-fine">On this server, mentors share playbooks; anyone can adopt them.</p>':''}`;
}
function pbsNeedHtml(back){
  if(typeof socAvailable!=='function'||!socAvailable())return `${back}${pzHead('Shared by members','Playbooks')}<section class="pz-card"><p class="pz-sub">Shared playbooks live on the server this page comes from. Open Daruma from your server’s <b>/daruma</b> link.</p></section>`;
  if(SOC.cfg&&SOC.cfg.playbooks&&SOC.cfg.playbooks.on===false)return `${back}${pzHead('Shared by members','Playbooks')}<section class="pz-card"><p class="pz-sub">Shared playbooks are switched off on this server.</p></section>`;
  return `${back}${pzHead('Shared by members','Playbooks')}<section class="pz-card"><p class="pz-sub">Join the league to see the playbooks members share and adopt one. <a href="#social">Join under Social</a>.</p></section>`;
}
function pbsAdoptBtn(x){
  if(x.mine)return '<span class="pz-fine">Yours</span>';
  const have=pbsSharedFrom(pbList(),x.id);
  return have?`<a class="pz-tag win" href="#playbooks" style="text-decoration:none">In your playbooks${have.name!==x.name?' as “'+esc(have.name)+'”':''}</a>`
    :pzS.demo?'':`<button type="button" class="pz-cta pz-sm" data-pbs="adopt" data-sid="${esc(x.id)}">Adopt</button>`;
}
function pbsWho(x){ const a=x.author||{}; return `<a href="#u/${esc(a.handle)}" style="color:var(--pz-text);font-weight:700;text-decoration:none">@${esc(a.handle)}</a>${a.mentor?' <span class="pz-tag info">Mentor</span>':''}${a.style&&typeof SOC_STYLE!=='undefined'&&SOC_STYLE[a.style]?' <span class="pz-tag">'+esc(SOC_STYLE[a.style])+'</span>':''}`; }
function pbsSharedHtml(){
  const back=`<a class="pz-back" href="#social">${pzI('back',20)}Social</a>`;
  if(!pbsOn())return pbsNeedHtml(back);
  const pg=i=>socGet('pbs:list:'+PBS.sort+':'+PBS.q+':p'+i,'/playbooks?sort='+PBS.sort+'&q='+encodeURIComponent(PBS.q)+'&page='+i,20000), c=pg(0);
  const pages=[]; for(let i=0;i<=PBS.page;i++){ const ci=i?pg(i):c; if(ci&&ci.d)pages.push(ci.d); }
  const d=c&&c.d, list=pages.flatMap(x=>x.playbooks), last=pages[pages.length-1];
  const card=x=>`<section class="pz-card pz-kv"><a href="#playbooks/${esc(x.id)}" style="text-decoration:none;color:var(--pz-text);display:flex;justify-content:space-between;gap:8px;align-items:baseline"><b class="pz-kvh">${esc(x.name)}</b>${pzI('chev',16)}</a>
      <span class="pz-sub" style="font-size:12px">${pbsWho(x)} · ${pbsN(x.ruleN,'rule')} · ${pbsN(x.adopts,'adopter')}${x.pays&&x.pays.n>=3?' · '+x.pays.yes+' of '+x.pays.n+' say it pays':''}${x.rr?' · aims 1:'+esc(String(x.rr)):''}</span>
      ${x.about?`<p class="pz-sub" style="font-size:13px;margin:0">${esc(x.about.length>160?x.about.slice(0,160)+'…':x.about)}</p>`:''}
      <ol style="margin:0;padding-left:20px;font-size:13px;line-height:1.45">${x.preview.map(r=>`<li>${esc(r)}</li>`).join('')}</ol>${x.ruleN>x.preview.length?`<a class="pz-link" href="#playbooks/${esc(x.id)}" style="min-height:0;font-size:13px">${pbsN(x.ruleN-x.preview.length,'more rule')} ${pzI('chev',14)}</a>`:''}
      <div>${pbsAdoptBtn(x)}</div></section>`;
  return `${back}${pzHead(d?pbsN(d.total,'playbook'):'Shared by members','Playbooks')}${pbsTabs('shared')}
    <div class="pz-field"><label for="pbsQ" class="pz-sr">Search playbooks</label><input type="search" id="pbsQ" value="${esc(PBS.q)}" placeholder="Search by setup, rule or name" autocomplete="off" enterkeyhint="search"></div>
    <div class="pz-chiprow" role="group" aria-label="Sort">${PBS_SORT.map(([k,l])=>`<button type="button" class="pz-chipbtn" data-pbs="sort" data-v="${k}" aria-pressed="${k===PBS.sort}">${l}</button>`).join('')}</div>
    <p class="pz-sub" style="margin:0">Setups other members wrote rules for. Adopt one and it’s yours: trades whose setup names it get its checklist, and how it works for you stays on your device.</p>
    ${!d?`<p class="pz-sub">${c&&c.err?esc(c.err):'<span class="pz-spin"></span>Loading…'}</p>`
      :list.length?`<div class="pz-jgrid">${list.map(card).join('')}</div>${last&&last.more?'<button type="button" class="pz-ghost" data-pbs="more">Show more</button>':''}`
      :`<section class="pz-card pz-empty"><b>Nothing here yet</b><p class="pz-sub">${PBS.q?'Nothing matches “'+esc(PBS.q)+'”.':d.canShare?'Nobody has shared a playbook yet. Be the first: share one from <a href="#playbooks">your playbooks</a>.':'Nobody has shared a playbook yet.'}</p></section>`}`;
}
function pbsOneHtml(id){
  const back=`<a class="pz-back" href="#playbooks/shared">${pzI('back',20)}Shared playbooks</a>`;
  if(!pbsOn())return pbsNeedHtml(back);
  const c=socGet('pbs:one:'+id,'/playbooks/'+id,20000), x=c&&c.d&&c.d.playbook;
  if(!x)return `${back}<p class="pz-sub">${c&&c.err?esc(c.err):'<span class="pz-spin"></span>Loading…'}</p>`;
  const have=pbsSharedFrom(pbList(),x.id), up=have&&x.version>have.src.v;
  return `${back}${pzHead((x.author?'@'+x.author.handle+' · ':'')+pbsN(x.adopts,'adopter'),x.name)}
    <div class="pz-wide"><div class="pz-col">
      <section class="pz-card pz-kv"><span class="pz-sub" style="font-size:13px">${pbsWho(x)} · updated ${esc(pbsWhen(x.updated))}${x.version>1?' · version '+x.version:''}${x.rr?' · aims for 1:'+esc(String(x.rr)):''}</span>
        ${x.pays&&x.pays.n>=3?`<p class="pz-sub" style="font-size:13px;margin:0" data-pz-tip="Adopters who said, anonymously, whether keeping these rules pays for them." tabindex="0">${x.pays.yes} of ${x.pays.n} adopters say it pays.</p>`:''}
        ${x.about?`<p style="margin:0;font-size:14px;white-space:pre-wrap">${esc(x.about)}</p>`:''}
        <ol style="margin:0;padding-left:20px;font-size:15px;line-height:1.55">${x.rules.map(r=>`<li>${esc(r.text)}</li>`).join('')}</ol></section>
      ${x.mine?`<p class="pz-sub" style="font-size:13px">It’s yours. Change it, or stop sharing it, under <a href="#playbooks">your playbooks</a>.</p>`
        :have?`${pbsAdoptBtn(x)}${up&&!pzS.demo?`<button type="button" class="pz-cta" data-pbs="update" data-id="${esc(have.id)}">Get the update</button>`:''}`
        :pbsAdoptBtn(x)}
    </div><div class="pz-col">
      <p class="pz-fine">Adopting copies its name and rules into your playbooks${pbsAdoptCopy(x,pbList(),0,()=>'').renamed?' (as “'+esc(x.name+' · @'+(x.author?x.author.handle:''))+'”, since you have one called that)':''}. Type that name as a trade’s setup to get the checklist. Your trades and how it works for you stay on your device: @${esc(x.author?x.author.handle:'')} only sees how many adopted it.</p>
      <p class="pz-fine">When @${esc(x.author?x.author.handle:'')} changes its rules, you hear about it and choose whether to take the update.</p></div></div>`;
}

// ---- clicks and typing ----
async function pbsSaveList(list){ settings.playbooks=list; await Store.set(S_KEY,settings); }
async function pbsFull(id){ const d=await socFetch('/playbooks/'+id); SOC.cache['pbs:one:'+id]={at:Date.now(),d,err:null}; return d.playbook; }
async function pbsClick(t){
  const a=t.dataset.pbs; if(!a)return false;
  const id=t.dataset.id, sid=t.dataset.sid, done=(m,k)=>{ if(m)pzNote(m,k); pzRender(); };
  try{
    if(a!=='del'&&a!=='unshare')PBS.confirm=null;
    if(['new','edit','cancel','shareform'].includes(a))PBS.draft={}; // a fresh form starts from what's saved
    if(a==='new'){ PBS.edit='new'; PBS.share=null; pzRender(); const n=$('pbsName'); if(n)n.focus(); return true; }
    if(a==='edit'){ PBS.edit=id; PBS.share=null; pzRender(); const n=$('pbsName'); if(n)n.focus(); return true; }
    if(a==='cancel'){ PBS.edit=null; PBS.share=null; return done(), true; }
    if(a==='sort'){ PBS.sort=t.dataset.v; PBS.page=0; return done(), true; }
    if(a==='more'){ PBS.page++; return done(), true; }
    if(a==='shareform'){ PBS.share=id; PBS.edit=null; pzRender(); const n=$('pbsAbout'); if(n)n.focus(); return true; }
    if(a==='save'){ const name=($('pbsName')||{value:''}).value.trim(); if(!name)return done('A playbook needs a setup name.','err'), true;
      const all=pbNorm(settings.playbooks,true), prev=all.find(p=>p.id===id&&!p.del);
      const aliases=pbAliasesFromText(($('pbsAliases')||{value:''}).value,name), rr=pbRR(($('pbsRR')||{value:''}).value);
      const clash=pbList().find(p=>p.id!==id&&[name,...aliases].some(n=>pbNames(p).some(m=>pbKey(m)===pbKey(n))));
      if(clash)return done('“'+clash.name+'” already answers to one of those names.','err'), true;
      const now=Date.now(), p={id:prev?prev.id:'pb'+now.toString(36)+Math.random().toString(36).slice(2,5),name,rules:pbRulesFromText(($('pbsRules')||{value:''}).value,prev&&prev.rules),at:now,createdAt:prev?prev.createdAt:now,...(prev&&prev.src?{src:prev.src}:{}),...(aliases.length?{aliases}:{}),...(rr?{rr}:{})};
      PBS.edit=null; PBS.draft={}; await pbsSaveList([...all.filter(x=>x.id!==p.id),p]); return done('Saved.'), true; }
    if(a==='del'){ const p=pbList().find(x=>x.id===id); if(!p)return true;
      if(PBS.confirm!=='del:'+id){ PBS.confirm='del:'+id; return done(), true; } PBS.confirm=null;
      await pbsSaveList([...pbNorm(settings.playbooks,true).filter(x=>x.id!==id),{id,del:true,at:Date.now()}]);
      const un=pbUnadopt(p); if(un)un.then(pbsDrop);
      return done('Deleted. Trades keep their setup name.'), true; }
    if(pzS.demo)return done('Leave sample mode to share or adopt playbooks.','err'), true;
    if(a==='share'){ const p=pbList().find(x=>x.id===id); if(!p)return true; t.disabled=true;
      const r=await socFetch('/playbooks',{method:'POST',body:JSON.stringify({src:p.id,name:p.name,about:($('pbsAbout')||{value:''}).value,rules:p.rules,...(p.rr?{rr:p.rr}:{})})});
      PBS.share=null; PBS.draft={}; pbsDrop(); return done(r.changed?'Shared. Members find it under Social → Playbooks.':'Nothing changed since you shared it.'), true; }
    if(a==='unshare'){ if(PBS.confirm!=='unshare:'+sid){ PBS.confirm='unshare:'+sid; return done(), true; } PBS.confirm=null;
      await socFetch('/playbooks/'+sid,{method:'DELETE'}); pbsDrop(); return done('Not shared any more. Yours stays here, and so do copies others adopted.'), true; }
    if(a==='adopt'){ t.disabled=true; const sh=await pbsFull(sid);
      if(pbList().length>=PB_MAX)return done('You have '+PB_MAX+' playbooks. Delete one to adopt another.','err'), true;
      const r=pbsAdoptCopy(sh,pbNorm(settings.playbooks,true),Date.now());
      if(r.error)return done(r.error,'err'), true;
      if(!r.existing)await pbsSaveList([...pbNorm(settings.playbooks,true).filter(x=>x.id!==r.pb.id),r.pb]); // over a deleted copy's tombstone
      await socFetch('/playbooks/'+sid+'/adopt',{method:'POST',body:'{}'}); pbsDrop();
      return done(r.existing?'It’s already in your playbooks.':'Added as “'+r.pb.name+'”. Type it as a trade’s setup to get the checklist.'), true; }
    if(a==='pays'){ t.disabled=true; const v=t.dataset.v; await socFetch('/playbooks/'+sid+'/adopt',{method:'POST',body:JSON.stringify({pays:v==='1'?true:v==='0'?false:null})}); pbsDrop();
      return done(v?'Told them, anonymously. Thanks.':'Taken back.'), true; }
    if(a==='restore'){ const M=pbsMine(), x=((M&&M.d&&M.d.mine)||[]).find(m=>m.id===sid); if(!x)return true;
      if(pbList().some(p=>pbKey(p.name)===pbKey(x.name)))return done('You have another playbook called “'+x.name+'”. Rename it first.','err'), true;
      const now=Date.now(); // its old id: what you shared stays linked to it, and ticks made on it count again
      await pbsSaveList([...pbNorm(settings.playbooks,true).filter(p=>p.id!==x.src),{id:x.src,name:x.name,rules:x.rules,...(x.rr>0?{rr:x.rr}:{}),at:now,createdAt:x.at}]);
      return done('Back in your playbooks.'), true; }
    if(a==='update'){ const p=pbList().find(x=>x.id===id); if(!p||!p.src)return true; t.disabled=true;
      const sh=await pbsFull(p.src.id), next=pbsApplyUpdate(p,sh,Date.now());
      await pbsSaveList([...pbNorm(settings.playbooks,true).filter(x=>x.id!==id),next]); pbsDrop();
      return done('Updated to @'+p.src.h+'’s latest. Ticks on rules that didn’t change still count.'), true; }
  }catch(e){ t.disabled=false; if(e.status===404)pbsDrop(); done(e.message,'err'); }
  return true;
}
function pbsInput(t){
  if(t.id==='pbsName'||t.id==='pbsRules'||t.id==='pbsAbout'||t.id==='pbsAliases'||t.id==='pbsRR'){ PBS.draft[t.id]=t.value; return true; }
  if(t.id!=='pbsQ')return false;
  clearTimeout(PBS.qT); PBS.qT=setTimeout(()=>{ PBS.q=t.value.trim(); PBS.page=0; pzRender(); const el=$('pbsQ'); if(el){ el.focus(); el.setSelectionRange(el.value.length,el.value.length); } },300);
  return true;
}

pzFeature({id:'playbooks', tab:{name:'playbooks', nav:'social', arg:/^(shared|[0-9a-f]{12})$/, html:pbsScreenHtml}, click:pbsClick, input:pbsInput});
