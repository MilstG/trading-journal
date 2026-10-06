// The admin panel's research screens: Admin → Research (the research report run on the league's own wallets:
// GET/POST /admin/research/run, GET /admin/research/report) and the "Does the product work?" card in Insights
// (GET /admin/research). admin.html loads this before its own script; it stays out of admin.html because that page
// has a size budget. It reaches the panel through window.ADM (api, render and the helpers), which admin.html sets
// up, and answers its own buttons and selects (ids starting with rs and res).
(function () {
  'use strict';
  const A = () => window.ADM;
  const $ = id => document.getElementById(id);
  const api = (p, o) => A().api(p, o), render = () => A().render(), note = (m, e) => A().note(m, e);
  const esc = s => A().esc(s), fmt = n => A().fmt(n), ago = ms => A().ago(ms), sel = (...a) => A().sel(...a), tiles = l => A().tiles(l);
  const tab = () => location.hash.slice(1).split('/')[0];
  const D = {}, UI = { res: { win: 28, ver: false }, use: { days: 30 } };
  let busy = false;
  async function run(fn, msg) { if (busy) return; busy = true;
    try { await fn(); if (msg) note(msg); } catch (e) { note(e.message, true); } finally { busy = false; } render(); }

  // does the product work? each member's Discipline before and after a first mentor review, duel, playbook,
  // pod or partner, against members who hadn't had one yet over the same weeks (GET /admin/research)
  async function loadRes(){ try{ D.res=await api('/research?window='+UI.res.win+(UI.res.ver?'&verified=1':'')); }catch(e){ D.res={err:e.message}; } }
  function resCard(){
    const R=D.res; if(!R){ D.res={loading:true}; loadRes().then(render); }
    const ctl=`<div class="row" style="gap:8px;min-width:280px">${sel('resWin',[[14,'14 days either side'],[28,'28 days either side'],[56,'56 days either side']],UI.res.win,' aria-label="Window"')}
      ${sel('resVer',[['','All days'],['1','Verified days only']],UI.res.ver?'1':'',' aria-label="Which days"')}</div>`;
    const top=`<section class="card"><div class="ch"><h2>Does the product work?</h2>${ctl}</div>`;
    if(!R||R.loading)return top+'<p class="muted">Loading…</p></section>';
    if(R.err)return top+`<p class="warn">${esc(R.err)}</p></section>`;
    const ci=b=>b&&b.v!=null?`${b.v>0?'+':''}${b.v}${b.lo!=null?` <span class="muted small">[${b.lo>0?'+':''}${b.lo}, ${b.hi>0?'+':''}${b.hi}]</span>`:''}`:'—';
    const col=b=>b&&b.lo!=null?(b.lo>0?' style="color:var(--good)"':b.hi<0?' style="color:var(--low)"':''):'';
    const colSlip=b=>b&&b.lo!=null?(b.hi<0?' style="color:var(--good)"':b.lo>0?' style="color:var(--low)"':''):'';
    return top+`<p class="muted small">Each member’s Discipline over the ${R.window} days after their first one, minus the ${R.window} days before, against the same change for members who hadn’t had one yet (the same calendar weeks). Needs 4 trading days on each side. Coloured when the 95% range leaves out zero. ${esc(R.note)}</p>
      <div class="scroll"><table><thead><tr><th>First…</th><th>Members</th><th>Measured</th><th title="Discipline points, after minus before, against members who hadn’t had one yet">Discipline vs not yet</th><th title="Percentage points of trading days with a slip">Slip days vs not yet</th><th>Raw change</th><th>Discipline before</th></tr></thead><tbody>
      ${Object.values(R.effects).map(x=>`<tr><td>${esc(x.label)}</td><td>${fmt(x.exposed)}</td><td>${fmt(x.measured)}</td><td${col(x.did)}>${ci(x.did)}</td><td${colSlip(x.didSlip)}>${ci(x.didSlip)}</td><td>${x.raw==null?'—':(x.raw>0?'+':'')+x.raw}</td><td>${x.before==null?'—':x.before}</td></tr>`).join('')}
      </tbody></table></div><p class="hint">${fmt(R.members)} members with trading days (${fmt(R.verified)} verified from fills${R.onlyVerified?'':', '+fmt(R.app)+' from the app'}).</p></section>`;
  }
  // staged rollouts (GET/POST /admin/rollouts): a feature for a random share of members, measured against the rest
  async function loadRo(){ try{ D.ro=await api('/rollouts'); }catch(e){ D.ro={err:e.message}; } }
  function roCard(){
    const R=D.ro; if(!R){ D.ro={loading:true}; loadRo().then(render); }
    const top='<section class="card"><h2>Staged rollouts</h2>';
    if(!R||R.loading)return top+'<p class="muted">Loading…</p></section>';
    if(R.err)return top+`<p class="warn">${esc(R.err)}</p></section>`;
    const F=R.features||{}, ci=d=>d&&d.v!=null?`${d.v>0?'+':''}${d.v}${d.lo!=null?` <span class="muted small">[${d.lo>0?'+':''}${d.lo}, ${d.hi>0?'+':''}${d.hi}]</span>`:''}`:'—';
    const rows=(R.rollouts||[]).map(r=>{ const E=r.effect||{}, g=E.groups||{on:{},off:{}};
      return `<tr><td>${esc(r.label)}<div class="muted small">${esc(r.start)} → ${esc(r.end)}${r.endedAt?' · ended':r.live?' · running':''}</div></td><td>${r.share}%</td>
        <td>${fmt(g.on.n)} / ${fmt(g.off.n)}<div class="muted small">measured ${fmt(g.on.measured)} / ${fmt(g.off.measured)}</div></td>
        <td${E.sure?(E.diff.v>0?' style="color:var(--good)"':' style="color:var(--low)"'):''}>${ci(E.diff)}<div class="muted small">got it ${E.on==null?'—':(E.on>0?'+':'')+E.on} · didn’t ${E.off==null?'—':(E.off>0?'+':'')+E.off}</div></td>
        <td>${r.live?`<button class="sm fit" data-ro="end" data-id="${esc(r.id)}">End</button>`:`<button class="sm fit" data-ro="delete" data-id="${esc(r.id)}">Delete</button>`}</td></tr>`; }).join('');
    return top+`<p class="muted small" style="margin-top:0">Switch a Daruma feature on for a random share of members (fixed by a hash: nobody picks their group) and compare their Discipline over the test with their own before it, against the members who didn’t get it. Everyone counts in the group they were dealt, used or not, so the difference is what the feature did, not who chose it.</p>
      ${rows?`<div class="scroll"><table><thead><tr><th>Feature</th><th>Share</th><th>Got it / didn’t</th><th title="Discipline points: change over the test against as many days before, got it minus didn’t">Discipline, got it vs not</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>`:''}
      <div class="row" style="gap:12px;flex-wrap:wrap;align-items:flex-end;margin-top:10px">${sel('roF',Object.entries(F),'',' aria-label="Feature"')}
        <label>Share who get it (%)<br><input type="number" id="roS" min="5" max="95" value="50" style="width:90px"></label><label>Weeks<br><input type="number" id="roW" min="1" max="12" value="4" style="width:80px"></label>
        <button class="primary fit" id="roGo">Start the test</button></div>
      <p class="hint">The members who don’t get it don’t see its card, screen or switch until the test ends. Run one test per feature at a time, for long enough that both groups trade.</p></section>`;
  }
  // what gets used in Daruma (GET /admin/usage): screens and Today cards, totals across members, never per person
  async function loadUse(){ try{ D.use=await api('/usage?days='+UI.use.days); }catch(e){ D.use={err:e.message}; } }
  function useCard(){
    const U=D.use; if(!U){ D.use={loading:true}; loadUse().then(render); }
    const top=`<section class="card"><div class="ch"><h2>What gets used</h2>${sel('useDays',[[7,'Last 7 days'],[30,'Last 30 days']],UI.use.days,' aria-label="Window"')}</div>`;
    if(!U||U.loading)return top+'<p class="muted">Loading…</p></section>';
    if(U.err)return top+`<p class="warn">${esc(U.err)}</p></section>`;
    if(!U.rows.length)return top+'<p class="muted">Nothing yet: apps send this with their stats, so it fills in as members use Daruma.</p></section>';
    const tbl=(kind,title)=>{ const R=U.rows.filter(r=>r.kind===kind); return R.length?`<h3 style="margin:12px 0 6px">${title}</h3><div class="scroll"><table><thead><tr><th>${kind==='screen'?'Screen':'Today card'}</th><th title="Members who ${kind==='screen'?'opened it':'had it on screen'}">${kind==='screen'?'Opened':'Seen'} by</th><th>Pressed something</th><th>Presses</th></tr></thead><tbody>
      ${R.map(r=>`<tr${r.low?' style="opacity:.7"':''}><td>${esc(r.name)}${r.low?' <span class="pill">bottom third</span>':''}</td><td>${fmt(r.opened)}${r.reach!=null?` <span class="muted small">${r.reach}%</span>`:''}</td><td>${fmt(r.acted)}${r.acts!=null?` <span class="muted small">${r.acts}% of them</span>`:''}</td><td>${fmt(r.presses)}</td></tr>`).join('')}</tbody></table></div>`:''; };
    return top+`<p class="muted small" style="margin-top:0">${fmt(U.active)} members used Daruma in the last ${U.days} days. Counted on each device and sent with their stats: which screens they opened, which Today cards were on screen, and how often they pressed something there. Totals only. The bottom third by members who pressed something is where to look for something to cut or merge.</p>
      ${tbl('screen','Screens')}${tbl('card','Today cards')}</section>`;
  }
  // ---------------- research: the report run on the league's own wallets (GET/POST /admin/research/run) ----------------
  async function loadRs(){ try{ D.rs=await api('/research/run'); }catch(e){ D.rs={err:e.message}; return; }
    if(D.rs.hasReport&&(!D.rsRep||D.rsRep.at!==D.rs.finishedAt)){ try{ D.rsRep=Object.assign(await api('/research/report'),{at:D.rs.finishedAt}); }catch(e){ D.rsRep=null; } } }
  // while a run goes, the page keeps itself up to date
  let rsPoll=null;
  function pollRs(){ clearTimeout(rsPoll); rsPoll=null; if(tab()!=='research'||!D.rs||D.rs.state!=='running')return;
    rsPoll=setTimeout(async()=>{ rsPoll=null; if(tab()!=='research')return;
      if(busy||document.visibilityState!=='visible')return pollRs();
      await loadRs(); if(tab()==='research'&&!busy)render(); else pollRs(); },4000); }
  const RS_SECTIONS=[['slips','What each slip costs','Each wallet’s slipped trades against its own trades that faced the same test and passed it. R is the wallet’s typical trade.'],
    ['forward','Does Discipline predict next month?',''],['persistence','Skill or luck?','How well each measure ranks wallets the same way in two back-to-back 90-day windows, and how many trades a reliable ranking needs.'],
    ['improvers','Traders like them who improved',''],['effects','Does the product work?','The same as Insights → Does the product work?, at the time of the run.'],['market','Market views','Skill tiers are set on the first half of the period and read on the second.']];
  function vResearch(){
    const S=D.rs; if(!S){ loadRs().then(render); return '<section class="card"><p class="muted">Loading…</p></section>'; }
    if(S.err)return `<section class="card"><p class="warn">Couldn’t load research: ${esc(S.err)}</p></section>`;
    const A=S.available||{members:0,all:0}, run=S.state==='running', mins=n=>Math.max(1,Math.ceil(n*2*1.5/60));
    const PH={fills:'Reading fills',prices:'Reading prices',analysis:'Working it out'};
    const pct=S.phase==='fills'?(S.total?S.done/S.total:0):S.phase==='analysis'?(S.total?Math.min(1,(S.analysed||0)/S.total):0):1;
    const when=S.finishedAt?ago(S.finishedAt):'';
    const lastLine=S.state==='done'?`Last run ${esc(when)}${S.by?' by '+esc(S.by):''}: ${fmt(S.total)} wallet${S.total===1?'':'s'}${S.scope==='all'?' (members, seed and entered wallets)':' (members’ wallets)'}${S.bots?', '+fmt(S.bots)+' left out as bots':''}${S.failed?', '+fmt(S.failed)+' couldn’t be read':''}.`
      :S.state==='error'?`<span class="warn">The last run stopped with an error ${esc(when)}: ${esc(S.error||'')}</span>`:S.state==='stopped'?`The last run was stopped ${esc(when)}.`:'No run yet.';
    const runCard=`<section class="card"><h2>Run on members’ wallets</h2>
      <p class="muted small" style="margin-top:0">Reads each wallet’s last 300 days of public fills from Hyperliquid, one request every 1.5 seconds (wallets read in the last day are reused), then works the report out in the background. The server keeps answering while it runs. With fewer than about 50 wallets most figures read “too few to bound”.</p>
      ${run?`<div class="prog" style="display:flex;align-items:center;gap:10px;margin:12px 0"><span class="fit small">${esc(PH[S.phase]||'Working')}</span><div class="bar" role="progressbar" aria-valuenow="${Math.round(pct*100)}" aria-valuemin="0" aria-valuemax="100"><i style="width:${Math.round(pct*100)}%"></i></div>
          <span class="fit muted small">${S.phase==='fills'?fmt(S.done)+' of '+fmt(S.total)+' wallets':S.phase==='analysis'?fmt(S.analysed||0)+' of '+fmt(S.total):''}</span></div>
        <button class="fit" id="rsStop">Stop</button>`
      :`<div style="margin:12px 0"><label class="inline"><input type="checkbox" id="rsAll"${A.all>A.members?'':' disabled'}> Also the seed wallets and wallets entered in the app (${fmt(A.all)} in all)</label></div>
        <button class="primary fit" id="rsRun"${A.members?'':' disabled'}>Run on members’ wallets (${fmt(A.members)})</button>
        <p class="hint">${A.members?'About '+mins(A.members)+' minute'+(mins(A.members)===1?'':'s')+' for members’ wallets'+(A.all>A.members?', '+mins(A.all)+' with the others':'')+'.':'No member has a wallet yet.'}</p>`}
      <p class="small" style="margin:10px 0 0">${lastLine}</p></section>`;
    const P=D.rsRep; if(!P||!P.report)return runCard;
    const r=P.report, sp=r.sample||{}, d=ms=>ms?new Date(ms).toISOString().slice(0,10):'—';
    const head=tiles([['Wallets',fmt(sp.wallets)],['With closed trades',fmt(sp.withTrades)],['Trades',fmt(sp.trades)],['Period',sp.span&&sp.span.to?fmt(Math.round((sp.span.to-sp.span.from)/864e5))+' days':'—',d(sp.span&&sp.span.from)+' to '+d(sp.span&&sp.span.to)]]);
    const secs=RS_SECTIONS.filter(([k])=>r[k]&&r[k].text&&r[k].text.length).map(([k,t,sub])=>`<section class="card"><h2>${esc(t)}</h2>${sub?`<p class="muted small" style="margin-top:0">${esc(sub)}</p>`:''}<ul class="small" style="padding-left:18px;margin:0">${r[k].text.map(x=>`<li style="margin:4px 0">${esc(x)}</li>`).join('')}</ul></section>`).join('');
    return runCard+shareCard(S)+`<section class="card"><div class="ch"><h2>Results <span class="sub2">· ${esc(ago(P.at||P.status&&P.status.finishedAt))}</span></h2><button class="fit" id="rsDownload">Download the full report</button></div>${head}
      <p class="hint">${(r.notes||[]).map(esc).join(' ')}</p></section>${secs}`;
  }

  // what members see of the report (GET /api/social/findings), and what the product takes from it (findings.js)
  const RS_SLIPS={revenge:'Re-entry within 15 minutes of a loss',afterTwo:'Trading on after two losses',sizeUp:'Sizing up after a loss',addLoser:'Adding to a loser',overtrade:'Overtrading',heldLoser:'Holding a loser too long'};
  function shareCard(S){
    const c=S.research||{}, g=S.suggest; if(!g)return '';
    const sw=(id,on,label,hint)=>`<label class="inline" style="display:flex;gap:8px;align-items:flex-start;margin:8px 0"><input type="checkbox" id="${id}"${on?' checked':''}><span><b>${esc(label)}</b><br><span class="muted small">${esc(hint)}</span></span></label>`;
    const W=g.weights||{};
    return `<section class="card"><h2>What members see</h2>
      <p class="muted small" style="margin-top:0">Members get group figures from the last run, each resting on at least the number of wallets below, never a wallet’s own numbers: what each slip costs (set beside their own trades in their app), how many trades a results ranking needs, whether Discipline says anything about next month, what improvers changed and the crowd’s hourly flow (a day behind).</p>
      ${sw('rsShare',c.share,'Share the findings with members','Off: members see only their own numbers.')}
      ${sw('rsCrowd',c.crowd,'Include the crowd’s hourly flow','Each hour’s net buying or selling by everyone, the top and the bottom skill quarter, in five steps; an hour with fewer than 3 wallets of a group traded says nothing.')}
      <div class="row" style="gap:12px;flex-wrap:wrap;align-items:flex-end"><label>Fewest wallets behind a figure<br><input type="number" id="rsMinW" min="5" max="1000" value="${+c.minWallets||10}" style="width:110px"></label>
        <label>Results boards rank from (trades in the window, 0 = off)<br><input type="number" id="rsMinT" min="0" max="5000" value="${+c.minTrades||0}" style="width:110px"></label>
        ${g.need?`<button class="fit" id="rsUseNeed" data-n="${g.need}">Use the report’s ${fmt(g.need)}</button>`:''}</div>
      <p class="hint">${g.need?'This run says a ranking on results needs about '+fmt(g.need)+' trades a trader to be 0.7 reliable. Members see that beside results boards and duels either way; ranking from it puts members with fewer trades below the ranked ones, unranked.':'This run couldn’t say how many trades a reliable ranking needs.'}</p>
      ${sw('rsWeights',c.weights,'Weigh slips in the Discipline score by what they cost','A slipped trade takes off its heaviest slip’s weight instead of a whole trade. Verified members’ days are read again when this changes.')}
      <p class="muted small">Weights from this run: ${Object.keys(RS_SLIPS).map(k=>esc(RS_SLIPS[k])+' '+(W[k]!=null?W[k]:1)).join(' · ')}</p>
      <button class="primary fit" id="rsSave">Save</button></section>`;
  }
  document.addEventListener('click', async ev => {
    const b0 = ev.target.closest('button');
    if (b0 && b0.id === 'rsUseNeed') { const i = $('rsMinT'); if (i) i.value = b0.dataset.n; return; }
    if (b0 && b0.id === 'roGo' && !busy) return run(async () => { await api('/rollouts', { body: { feature: $('roF').value, share: +$('roS').value, weeks: +$('roW').value } }); D.ro = null; }, 'The test has started.');
    if (b0 && b0.dataset.ro && !busy) { if (b0.dataset.ro === 'delete' && !confirm('Delete this test and its result?')) return;
      return run(async () => { await api('/rollouts/' + encodeURIComponent(b0.dataset.id), { body: { action: b0.dataset.ro } }); D.ro = null; }, b0.dataset.ro === 'end' ? 'Ended. Everyone sees it now.' : 'Deleted.'); }
    if (b0 && b0.id === 'rsSave' && !busy) return run(async () => {
      await api('/config', { method: 'PUT', body: { research: { share: $('rsShare').checked, crowd: $('rsCrowd').checked, weights: $('rsWeights').checked, minWallets: +$('rsMinW').value, minTrades: +$('rsMinT').value } } });
      D.rs = null; }, 'Saved.');
  });
  document.addEventListener('click', async ev => {
    const b = ev.target.closest('button'); if (!b || busy) return;
    if (b.id === 'rsRun') return run(async () => { D.rs = await api('/research/run', { body: { scope: $('rsAll') && $('rsAll').checked ? 'all' : 'members' } }); }, 'Research started.');
    if (b.id === 'rsStop') return run(async () => { D.rs = await api('/research/run', { body: { action: 'stop' } }); }, 'Stopping…');
    if (b.id === 'rsDownload') { try { const r = await api('/research/report?html=1'), a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([r.html || ''], { type: 'text/html' })); a.download = 'research-report-' + new Date().toISOString().slice(0, 10) + '.html';
      document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000); } catch (e) { note(e.message, true); } }
  });
  document.addEventListener('change', ev => { const t = ev.target;
    if (t.id === 'useDays') { UI.use.days = +t.value; loadUse().then(render); return; }
    if (t.id === 'resWin' || t.id === 'resVer') { if (t.id === 'resWin') UI.res.win = +t.value; else UI.res.ver = t.value === '1'; loadRes().then(render); } });
  window.ARES = {
    view: () => { const h = vResearch(); setTimeout(pollRs, 0); return h; },
    card: () => resCard() + roCard() + useCard(),
    // fresh numbers each time a tab is opened
    enter: t => { if (t === 'insights') { D.res = null; D.use = null; D.ro = null; } if (t === 'research') D.rs = null; },
  };
})();
