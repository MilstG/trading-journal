/* ============================================================================
   Invite — referral links and what they earn (social.js /referrals).
   A feature in its own file: it plugs into Daruma through pzFeature (app/pulse.js) and loads on
   Daruma's page only (data-only="keel" in ledger.html).

   Every member has a link on their handle (/daruma?ref=<handle>); a member whose wallet is claimed
   (and approved, where the owner approves wallets) can also make codes of their own, each with a label
   and its own visits, joins and activations. Someone who joins through a link is a referral on the terms
   of that day (the owner's amounts, or a running promotion's). It counts once they're active: a claimed
   wallet no member used before, and enough trading days, read from that wallet, soon after joining.
   Then the referrer gets a bonus, the new member a welcome bonus, and the referrer a share of the new
   member's trading XP each week for their first months. Referral XP raises levels and XP to spend,
   never the XP leagues and duels rank on. The server works all of it out; this screen only shows it.
   ============================================================================ */
const REFS={confirm:null,draft:{}};
const REF_WHY={claim:'needs to claim their wallet',approval:'their wallet is waiting for the owner’s approval',verify:'needs “Verify my discipline” switched on',
  wallet:'that wallet already counted for a referral',owner:'stopped by the league owner',gone:'the member who invited them left',days:''};
function refsOn(){ return typeof socAvailable==='function'&&socAvailable()&&!!SOC.me&&!!(SOC.cfg&&SOC.cfg.referrals&&SOC.cfg.referrals.on); }
const refsUrl=code=>location.origin+'/daruma?ref='+encodeURIComponent(code);
const refsDate=k=>{ const d=new Date(typeof k==='number'?k:k+'T12:00:00Z'); return d.toLocaleDateString('en-US',{month:'short',day:'numeric',timeZone:typeof k==='number'?undefined:'UTC'}); };
const refsN=(n,w)=>n+' '+w+(n===1?'':'s');
// one referral, in words: where it stands and what it paid
function refsState(r){
  if(r.st==='pending')return r.why==='days'||!r.why?`${r.days} of ${r.need} trading days · until ${refsDate(r.until)}`:REF_WHY[r.why]+' · until '+refsDate(r.until);
  if(r.st==='active')return r.capped?'active · past that month’s cap, so it pays you nothing':'active'+(r.shared?' · '+r.shared.toLocaleString()+' XP shared so far':'')+' · '+refsN(r.weeksPaid,'week')+' of '+r.terms.wk+' paid';
  if(r.st==='expired')return 'didn’t become active in '+r.terms.aw+' days'+(r.why&&REF_WHY[r.why]?' ('+REF_WHY[r.why]+')':'');
  return 'won’t count: '+(REF_WHY[r.why]||'stopped');
}
const REFS_TAG={pending:['Pending',''],active:['Active','win'],expired:['Expired',''],void:['Doesn’t count','caution']};
function refsTermsHtml(T, d){
  return `<section class="pz-card pz-kv"><b class="pz-kvh">${T.promo?`<span class="pz-tag win">${esc(T.promo)}${T.until?' · until '+esc(refsDate(T.until)):''}</span> `:''}What an invite earns</b>
    <div class="pz-grid2">
      <div class="pz-tile"><span class="pz-n" style="color:var(--pz-xp)">+${T.rx}</span><span class="pz-t">XP for you when they’re active</span></div>
      <div class="pz-tile"><span class="pz-n" style="color:var(--pz-xp)">+${T.ex}</span><span class="pz-t">XP welcome bonus for them</span></div>
      <div class="pz-tile"><span class="pz-n">${T.pct}%</span><span class="pz-t">of their trading XP, to you, weekly for ${refsN(T.wk,'week')}</span></div>
      <div class="pz-tile"><span class="pz-n">${T.ad} days</span><span class="pz-t">of trading in their first ${T.aw} makes them active</span></div></div>
    <p class="pz-fine" style="margin:0">Active means a wallet they claimed that no member used before, and ${T.ad} trading days read from it. The share pays a week once it can’t change any more (the week after). Referral XP raises your level and your XP to spend; leagues and duels never count it.${d&&d.monthlyCap?' Up to '+d.monthlyCap+' referrals pay each month ('+d.paidThisMonth+' so far this month).':''}${T.promo?' The promotion’s terms hold for everyone who joins while it runs.':''}</p></section>`;
}
function refsLinkRow(L, own){
  const u=refsUrl(L.code);
  return `<div class="pz-kv" style="gap:6px;padding:10px 0;border-top:1px solid var(--pz-line)">
    <div style="display:flex;justify-content:space-between;gap:8px;align-items:baseline;flex-wrap:wrap"><b style="font-size:14px;word-break:break-all">${esc(u.replace(/^https?:\/\//,''))}</b>${L.label?`<span class="pz-tag">${esc(L.label)}</span>`:''}</div>
    <span class="pz-sub" style="font-size:12px">${refsN(L.visits||0,'visit')} · ${refsN(L.joins||0,'join')} · ${L.active||0} active</span>
    <div style="display:flex;gap:8px;flex-wrap:wrap"><button type="button" class="pz-ghost pz-sm" data-refs="copy" data-url="${esc(u)}">Copy link</button>${navigator.share?`<button type="button" class="pz-ghost pz-sm" data-refs="share" data-url="${esc(u)}">Share…</button>`:''}
      ${own?`<button type="button" class="pz-quietbtn warn" data-refs="del" data-code="${esc(L.code)}">${REFS.confirm==='del:'+L.code?'Tap again: the link stops working':'Delete'}</button>`:''}</div></div>`;
}
function refsScreenHtml(){
  const back=`<a class="pz-back" href="#social">${pzI('back',20)}Social</a>`;
  if(!refsOn())return `${back}${pzHead('Bring traders in','Invite')}<section class="pz-card"><p class="pz-sub">${typeof socAvailable!=='function'||!socAvailable()?'Invites live on the server this page comes from. Open Daruma from your server’s <b>/daruma</b> link.':SOC.cfg&&SOC.cfg.referrals&&!SOC.cfg.referrals.on?'Invites are switched off on this server.':'Join the league first: <a href="#social">create your profile under Social</a>.'}</p></section>`;
  const c=socGet('refs','/referrals',20000), d=c&&c.d;
  if(!d)return `${back}${pzHead('Bring traders in','Invite')}<p class="pz-sub">${c&&c.err?esc(c.err):'<span class="pz-spin"></span>Loading…'}</p>`;
  const T=d.terms, E=d.earned, demo=!!pzS.demo;
  const add=d.canCustom&&!demo&&d.links.length<d.linksMax?`<div class="pz-kv" style="gap:8px;padding-top:10px;border-top:1px solid var(--pz-line)">
      <div style="display:flex;gap:8px;flex-wrap:wrap"><div class="pz-field" style="flex:1;min-width:140px"><label for="refCode">Your code</label><input type="text" id="refCode" maxlength="24" placeholder="e.g. ${esc(SOC.me.handle.toLowerCase())}-x" autocomplete="off" autocapitalize="none" value="${esc(REFS.draft.refCode||'')}"></div>
        <div class="pz-field" style="flex:1;min-width:140px"><label for="refLabel">Where you’ll post it (optional)</label><input type="text" id="refLabel" maxlength="40" placeholder="e.g. Twitter bio" autocomplete="off" value="${esc(REFS.draft.refLabel||'')}"></div></div>
      <button type="button" class="pz-cta pz-sm" data-refs="add">Make the link</button>
      <p class="pz-fine" style="margin:0">3–24 letters, numbers, - or _. One code per place you share it shows which one brings people in.</p></div>`
    :!d.canCustom?`<p class="pz-fine" style="margin:0">${d.why==='approval'?'Links of your own open once the league owner approves your wallet.':'Links of your own open once you claim your wallet (<a href="#account">Account</a>).'}</p>`
    :d.links.length>=d.linksMax?`<p class="pz-fine" style="margin:0">You have ${d.linksMax} links, the most this league allows. Delete one to make another.</p>`:'';
  const mine=d.mine?`<section class="pz-card pz-kv"><b class="pz-kvh">You joined through @${esc(d.mine.by||'a member')}</b>
      <span class="pz-sub" style="font-size:13px">${d.mine.st==='active'?'You’re active: your '+d.mine.terms.ex+' XP welcome bonus is paid.':d.mine.st==='pending'?'Your '+d.mine.terms.ex+' XP welcome bonus: '+refsState(d.mine)+'.':refsState(d.mine)+'.'}</span></section>`:'';
  const people=d.refs.length?d.refs.map(r=>{ const [tl,tc]=REFS_TAG[r.st]||[r.st,''];
      return `<div class="pz-person-h" style="padding:10px 0;border-top:1px solid var(--pz-line)">${socAv(r.handle,36)}<span class="pz-person-i"><a href="#u/${esc(r.handle)}" style="color:var(--pz-text);font-weight:700;text-decoration:none">@${esc(r.handle)}</a> <span class="pz-tag ${tc}">${tl}</span>${r.terms.promo?` <span class="pz-tag">${esc(r.terms.promo)}</span>`:''}
        <span class="pz-sub" style="display:block;font-size:12px">joined ${esc(refsDate(r.at))}${r.code!==SOC.me.handle.toLowerCase()?' with '+esc(r.code):''} · ${esc(refsState(r))}</span></span></div>`; }).join('')
    :'<p class="pz-sub" style="font-size:13px;margin:0">Nobody yet. Share your link with traders you know.</p>';
  return `${back}${pzHead(T.promo?T.promo:'Bring traders in','Invite')}
    <div class="pz-wide"><div class="pz-col">
      ${refsTermsHtml(T,d)}
      <section class="pz-card pz-kv"><b class="pz-kvh">Your link</b>${refsLinkRow(d.link,false)}</section>
      <section class="pz-card pz-kv"><b class="pz-kvh">Links of your own · ${d.links.length} of ${d.linksMax}</b>${d.links.map(L=>refsLinkRow(L,true)).join('')}${add}</section>
    </div><div class="pz-col">
      ${mine}
      <section class="pz-card pz-kv"><b class="pz-kvh">What you’ve earned</b>
        <div class="pz-grid2"><div class="pz-tile"><span class="pz-n" style="color:var(--pz-xp)">${(E.bonus+E.share).toLocaleString()}</span><span class="pz-t">XP from inviting</span></div>
          <div class="pz-tile"><span class="pz-n">${E.share.toLocaleString()}</span><span class="pz-t">of it from weekly shares</span></div></div></section>
      <section class="pz-card pz-kv"><b class="pz-kvh">People you invited · ${d.total}</b>${people}</section>
    </div></div>`;
}

// ---- clicks and typing ----
async function refsCopy(u){ try{ await navigator.clipboard.writeText(u); pzNote('Link copied.'); }catch(e){ window.prompt('Copy your link:',u); } }
async function refsClick(t){
  const a=t.dataset.refs; if(!a)return false;
  if(a!=='del')REFS.confirm=null;
  try{
    if(a==='copy'){ await refsCopy(t.dataset.url); return true; }
    if(a==='share'){ try{ await navigator.share({title:'Join me on Daruma',text:'Track your trading discipline with me on Daruma.',url:t.dataset.url}); }catch(e){} return true; }
    if(a==='add'){ const code=($('refCode')||{value:''}).value.trim(), label=($('refLabel')||{value:''}).value.trim(); if(!code){ pzNote('Pick a code first.','err'); return true; }
      t.disabled=true; await socFetch('/referrals/links',{method:'POST',body:JSON.stringify({code,label})}); REFS.draft={}; delete SOC.cache.refs;
      pzNote('Your link is ready: '+refsUrl(code.toLowerCase()).replace(/^https?:\/\//,'')); pzRender(); return true; }
    if(a==='del'){ const c=t.dataset.code; if(REFS.confirm!=='del:'+c){ REFS.confirm='del:'+c; pzRender(); return true; } REFS.confirm=null;
      await socFetch('/referrals/links/'+encodeURIComponent(c),{method:'DELETE'}); delete SOC.cache.refs; pzNote('Deleted. People who joined with it still count.'); pzRender(); return true; }
  }catch(e){ t.disabled=false; pzNote(e.message,'err'); }
  return true;
}
function refsInput(t){ if(t.id!=='refCode'&&t.id!=='refLabel')return false; REFS.draft[t.id]=t.value; return true; }

pzFeature({id:'invite', tab:{name:'invite', nav:'social', html:refsScreenHtml}, click:refsClick, input:refsInput});
