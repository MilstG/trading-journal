// Ledger app · part 14b of 15: mentor trade reviews (loads after part 14, before boot).
// ledger.html loads the parts in order as classic scripts sharing one global scope. Code that
// runs while a part loads (not inside a function called later) may only use names declared in
// this part or an earlier one; the boot part runs last. See "Development and testing" in README.md.

/* ======================= mentor trade reviews ======================= */
// A member who lets mentors in can send one trade to the league's mentors (social.js /reviews):
// a summary like a trade post (market, side, times, prices, % and R, a size range; dollars only
// with "Show dollar P&L" on) with their note and plan. Mentors comment and mark it reviewed; the
// member replies. In Pulse at #reviews and #tr/<id>, and under the trade in the full journal.
const MR_SIZES=['under $1k','$1k to $10k','$10k to $100k','$100k to $1M','over $1M'];
// The server knows a trade by a short hash of its id (the id holds the wallet address).
function mrTradeKey(id){ let a=0xdeadbeef, b=0x41c6ce57;
  for(const ch of String(id)){ const c=ch.charCodeAt(0); a=Math.imul(a^c,2654435761); b=Math.imul(b^c,1597334677); }
  a=Math.imul(a^(a>>>16),2246822507)^Math.imul(b^(b>>>13),3266489909); b=Math.imul(b^(b>>>16),2246822507)^Math.imul(a^(a>>>13),3266489909);
  return (b>>>0).toString(36).padStart(7,'0')+(a>>>0).toString(36).padStart(7,'0'); }
function mrSizeRange(notional){ const n=Math.abs(+notional||0); return n<1e3?0:n<1e4?1:n<1e5?2:n<1e6?3:4; }
// What goes to the server for trade t with journal entry j. o: {label, r, pct, plan (the day's), usd (shares dollars), extra (unsaved note)}.
function mrSummary(t, j, o){ j=j||{}; o=o||{}; const p=j.plan||{}, num=v=>+v>0?+v:null, closed=!t.isOpen&&t.closeTime>0;
  const note=[j.notes||'',o.extra||''].map(s=>String(s).trim()).filter(Boolean).join('\n\n');
  return {coin:t.coin,label:o.label||t.coin,side:t.dir==='Short'?'short':'long',market:t.market==='spot'?'spot':'perp',openedAt:t.openTime,closedAt:closed?t.closeTime:null,
    entry:t.avgEntry,exit:closed?t.avgExit:null,stop:num(p.stop),target:num(p.target),size:mrSizeRange((t.maxSize||0)*(t.avgEntry||0)),
    pct:closed&&o.pct!=null?o.pct:null,r:closed&&o.r!=null?o.r:null,usd:closed&&o.usd?t.net:null,setup:j.setup||'',note,plan:o.plan||''}; }
function mrCanShare(){ return !!(SOC.me&&SOC.share&&SOC.share.mentor&&!pzS.demo); }
async function mrShare(id, extra){
  const t=allTrades.find(x=>x.id===id); if(!t)throw new Error('That trade isn’t loaded.');
  const R=typeof rFor==='function'?rFor(t):null, day=journal['day:'+dayKey(t.openTime)];
  const trade=mrSummary(t,journal[t.id],{label:dispMarket(dcoin(t)),r:R,pct:retPct(t),plan:day&&day.plan,usd:!!(SOC.share&&SOC.share.usd),extra});
  const d=await socFetch('/reviews',{method:'POST',body:JSON.stringify({key:mrTradeKey(id),trade})});
  SOC.cache['tr:'+d.review.id]={at:Date.now(),d,err:null}; delete SOC.cache.reviews; return d; }
function mrWhen(ms){ const p=tzParts(ms); return dayLabel(dayKey(ms))+' '+String(p.h).padStart(2,'0')+':'+String(p.min).padStart(2,'0'); }
function mrBadge(r){ return r.reviewed?`<span class="pz-pill mr-ok">Reviewed${r.reviewed.by?' by @'+esc(r.reviewed.by):''} ✓</span>`
  :`<span class="pz-pill">${r.waiting?'Waiting for a mentor':'Mentor replied'}</span>`; }
function mrRowHtml(r, mod){ const t=r.trade||{};
  return `<a class="pz-card pz-cardlink" href="#tr/${esc(r.id)}${mod?'/mod':''}">${socAv(r.handle,32)}<span style="flex:1;min-width:0;display:flex;flex-direction:column;gap:3px">
    <b style="font-size:14px">${esc((t.side==='short'?'Short ':'Long ')+(t.label||t.coin||''))} <span class="pz-sub" style="font-weight:400">· @${esc(r.handle||'?')} · ${esc(dayLabel(dayKey(t.openedAt||r.at)))}</span></b>
    <span style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">${mrBadge(r)}<span class="pz-sub" style="font-size:12px">${r.comments} comment${r.comments===1?'':'s'} · ${socAgo(r.last)}</span></span></span>${pzI('chev',18)}</a>`; }
// #reviews: trades to review (mentors), your own trades out for review, and every thread (admins, read-only)
function mrListHtml(D){
  const back=`<a class="pz-back" href="#social">${pzI('back',20)}Social</a>`;
  if(!socAvailable()||!SOC.me)return `${back}${socSocialHtml(D)}`;
  const c=socGet('reviews','/reviews',20000), d=c&&c.d; if(!d)return `${back}<p class="pz-sub">${c&&c.err?esc(c.err):'<span class="pz-spin"></span>Loading…'}</p>`;
  const sec=(h,L,mod,empty)=>`<section style="display:flex;flex-direction:column;gap:10px"><b class="pz-kvh">${h}</b>${L.length?L.map(r=>mrRowHtml(r,mod)).join(''):`<p class="pz-sub" style="font-size:13px">${empty}</p>`}</section>`;
  const a=SOC.me.admin&&pzS.mrAll?socGet('admreviews','/admin/reviews',20000):null;
  return `${back}${pzHead('Mentor','Trade reviews')}<div class="pz-wide"><div class="pz-col">
    ${d.toReview?sec('Trades to review',d.toReview.slice().sort((x,y)=>(y.waiting-x.waiting)||(y.last-x.last)),false,'No one has sent a trade yet.'):''}
    ${d.toReview&&!d.mine.length?'':sec('Your trades with mentors',d.mine,false,d.mentorsOn?'Send one from a trade in your journal: “Ask my mentor”.':'Switch on “Let mentors see my days” under What you share, then send a trade from your journal.')}</div>
    <div class="pz-col">${SOC.me.admin?(a&&a.d?sec('Every thread (admin, read-only)',a.d.reviews,true,'None yet.'):`<button type="button" class="pz-ghost pz-sm" data-mr-all>${a?'<span class="pz-spin"></span>Loading…':'Show every thread (admin, read-only)'}</button>`):''}
    <p class="pz-fine">A trade you send goes to the league’s mentors with your note and plan, its % and R and a size range. Dollars only if you share dollar P&amp;L. Switching off “Let mentors see my days” closes your threads to them at once.</p></div></div>`;
}
function mrThreadInner(d, mod){ const r=d.review, me=d.role, id=r.id, rep=SOC.confirm==='mrdel:'+id;
  const cs=d.comments.map(x=>`<div class="pz-com">${socAv(x.handle,30)}<span style="flex:1;min-width:0;display:flex;flex-direction:column;gap:2px">
    <span style="font-size:13px"><b>${x.mine?'You':'@'+esc(x.handle)}</b>${x.mentor?' <span class="pz-pill">mentor</span>':''} <span class="pz-sub" style="font-size:11px">${socAgo(x.at)}</span></span>
    <span class="pz-thesis" style="font-size:14px">${esc(x.text)}</span></span></div>`).join('');
  return `<b style="font-size:15px">${r.comments} comment${r.comments===1?'':'s'}</b>${cs||'<p class="pz-sub" style="font-size:13px">No comments yet.</p>'}
    ${mod?'<p class="pz-fine">Read-only: you see this as an admin, for moderation.</p>':`<div class="pz-field"><label for="mrText" class="pz-vh">${me==='mentor'?'Comment on this trade':'Reply'}</label><textarea id="mrText" rows="3" maxlength="1000" placeholder="${me==='mentor'?'What you see, and one thing to try':'Reply to your mentor'}"></textarea></div>
    <div style="display:flex;gap:8px;flex-wrap:wrap"><button type="button" class="pz-cta pz-sm" style="flex:1;min-height:40px" data-mr-send="${esc(id)}">Send</button>
    ${me==='mentor'?`<button type="button" class="pz-ghost pz-sm" style="flex:1" data-mr-done="${esc(id)}" data-on="${r.reviewed?0:1}">${r.reviewed?'Reviewed ✓ · undo':'Mark reviewed ✓'}</button>`
      :`<button type="button" class="pz-quietbtn warn" data-mr-del="${esc(id)}">${rep?'Tap again to take it back':'Take this trade back'}</button>`}</div>`}`; }
// #tr/<id>: one trade and its thread (#tr/<id>/mod: an admin's read-only view)
function mrThreadHtml(D, id, mod){
  const back=`<a class="pz-back" href="#reviews">${pzI('back',20)}Trade reviews</a>`;
  if(!socAvailable()||!SOC.me)return `${back}${socSocialHtml(D)}`;
  const c=socGet('tr:'+id,(mod?'/admin/reviews/':'/reviews/')+encodeURIComponent(id),20000), d=c&&c.d;
  if(!d)return `${back}<p class="pz-sub">${c&&c.err?esc(c.err):'<span class="pz-spin"></span>Loading…'}</p>`;
  const r=d.review, t=r.trade;
  return `${back}${pzHead('@'+(r.handle||'?')+' · sent '+(Date.now()-r.at<60000?'just now':socAgo(r.at)+' ago'),(t.side==='short'?'Short ':'Long ')+(t.label||t.coin))}
    <div class="pz-wide"><div class="pz-col"><section class="pz-card" style="display:flex;flex-direction:column;gap:10px">${mrBadge(r)}${socTradeHtml(Object.assign({},t,{status:t.closedAt?'closed':'open'}))}
      <span class="pz-sub" style="font-size:12px">${esc(t.market==='spot'?'Spot':'Perp')} · opened ${esc(mrWhen(t.openedAt))}${t.closedAt?' · closed '+esc(mrWhen(t.closedAt)):' · still open'}${t.size!=null?' · size '+esc(MR_SIZES[t.size]):''}</span>
      ${t.note?`<div class="pz-quote"><b>Note</b><br>${esc(t.note)}</div>`:''}${t.plan?`<div class="pz-quote"><b>Plan for the day</b><br>${esc(t.plan)}</div>`:''}</section></div>
    <div class="pz-col"><section class="pz-card" style="display:flex;flex-direction:column;gap:12px">${mrThreadInner(d,mod)}</section></div></div>`;
}
// clicks, in Pulse and in the full journal; true when handled
async function mrAction(t){ const ds=t.dataset;
  if(ds.mrShare===undefined&&!ds.mrSend&&!ds.mrDone&&!ds.mrDel&&ds.mrAll===undefined)return false;
  const redraw=id=>{ if(PZ)pzRender(); else if(id)mrJournalLoad(id,true); }, note=(m,k)=>PZ?pzNote(m,k):k==='err'?setErr(m):setStatus(m);
  try{
    if(ds.mrAll!==undefined){ pzS.mrAll=true; pzRender(); return true; }
    if(ds.mrShare!==undefined){ const sec=t.closest('[data-pz-trade]'), ta=sec&&sec.querySelector('textarea'); t.disabled=true;
      const d=await mrShare(ds.mrShare||sec.dataset.pzTrade,ta&&ta.value); note('Sent to your mentor.');
      if(PZ)location.hash='#tr/'+d.review.id; else mrJournalLoad(ds.mrShare,true); return true; }
    const id=ds.mrSend||ds.mrDone||ds.mrDel, box=t.closest('[data-mr-box]'), tid=box&&box.dataset.mrBox;
    if(ds.mrSend){ const el=(box||document).querySelector('#mrText,[data-mr-text]'), text=(el&&el.value||'').trim(); if(!text){ note('Write the comment first.','err'); return true; }
      t.disabled=true; SOC.cache['tr:'+id]={at:Date.now(),d:await socFetch('/reviews/'+id+'/comments',{method:'POST',body:JSON.stringify({text})}),err:null}; if(el)el.value=''; }
    else if(ds.mrDone)SOC.cache['tr:'+id]={at:Date.now(),d:await socFetch('/reviews/'+id+'/reviewed',{method:'POST',body:JSON.stringify({done:ds.on==='1'})}),err:null};
    else { if(PZ&&SOC.confirm!=='mrdel:'+id){ SOC.confirm='mrdel:'+id; pzRender(); return true; } if(!PZ&&!confirm('Take this trade back? The thread goes with it.'))return true;
      SOC.confirm=null; await socFetch('/reviews/'+id,{method:'DELETE'}); delete SOC.cache['tr:'+id]; note('Taken back.'); if(PZ)location.hash='#reviews'; }
    delete SOC.cache.reviews; redraw(tid);
  }catch(e){ t.disabled=false; note(e.message,'err'); }
  return true; }
// the full journal: under an expanded trade, its review thread or the button to ask for one
async function mrJournalLoad(id, fresh){
  const box=document.getElementById('mrev-'+id); if(!box)return;
  if(!SOC.me||pzS.demo){ box.innerHTML=''; return; }
  if(!SOC.share||!SOC.share.mentor){ box.innerHTML='<label>Mentor review</label><p class="mini-note">To ask a mentor about this trade, switch on “Let mentors see my days” in Keel → Profile &amp; privacy.</p>'; return; }
  let L=SOC.cache.reviews; try{ if(fresh||!L||!L.d||Date.now()-L.at>30000){ L=SOC.cache.reviews={at:Date.now(),d:await socFetch('/reviews'),err:null}; } }catch(e){ box.innerHTML=''; return; }
  const r=L.d.mine.find(x=>x.key===mrTradeKey(id));
  if(!r){ box.innerHTML=`<label>Mentor review</label><p class="mini-note">${L.d.mentors?'Send this trade to the league’s mentors with your note and plan: its % and R and a size range'+(SOC.share.usd?' and dollar result':'')+'. They comment here and in Keel.':'There are no mentors on this server yet.'}</p>${L.d.mentors?`<button class="btn ghost" data-mr-share="${esc(id)}">Ask my mentor to review this trade</button>`:''}`; return; }
  let d=SOC.cache['tr:'+r.id]; try{ if(fresh||!d||!d.d){ d=SOC.cache['tr:'+r.id]={at:Date.now(),d:await socFetch('/reviews/'+r.id),err:null}; } }catch(e){ box.innerHTML=''; return; }
  const T=d.d, rv=T.review;
  box.innerHTML=`<label>Mentor review ${rv.reviewed?`<span class="badge ok">Reviewed${rv.reviewed.by?' by @'+esc(rv.reviewed.by):''} ✓</span>`:''}</label>
    <div class="mr-thread">${T.comments.map(x=>`<p><b>${x.mine?'You':'@'+esc(x.handle)}</b>${x.mentor?' <span class="badge mid">mentor</span>':''} <span class="mini-note">${socAgo(x.at)}</span><br>${esc(x.text)}</p>`).join('')||'<p class="mini-note">Sent. No comments yet.</p>'}</div>
    <textarea data-mr-text rows="2" maxlength="1000" placeholder="Reply to your mentor" aria-label="Reply to your mentor"></textarea>
    <div style="display:flex;gap:8px;margin-top:6px"><button class="btn ghost" data-mr-send="${esc(r.id)}">Send reply</button><button class="btn ghost" data-mr-share="${esc(id)}" data-tip="Sends the trade’s summary again with your latest note and plan">Update the summary</button><a class="btn ghost" href="/keel#tr/${esc(r.id)}">Open in Keel</a></div>`;
}
document.addEventListener('click',e=>{ if(PZ)return; const b=e.target.closest&&e.target.closest('[data-mr-box] button'); if(b){ e.stopPropagation(); mrAction(b); } },true);
