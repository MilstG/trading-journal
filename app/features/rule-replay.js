/* ============================================================================
   Your rules, replayed — the last 90 days as they would have gone had you kept your own rules.
   Loads on Daruma's page only (data-only="keel"): a card on Today and a section of What the data says (#data).

   "Your rules" are the ones you wrote down: the rules in Settings (max trades a day, the cool-down after a
   loss, no adding to losers, the daily loss limit; evaluateRules prices each) and the leaks you chose to
   plug (pzPlugs: a trade with that slip broke your own rule). Then the same replay without your rules, for
   all six slips (what Discipline counts). A straight replay: the trades that broke a rule are taken out and
   everything else stays as it was (whatIfModel). What you'd have done instead can't be known, so this is
   the price of the rule-breaking trades themselves, nothing more.
   ============================================================================ */
// closed trades and the game's behavior days -> {n, net, rules: {n, net, ids, which}, slips: {n, net}}. Pure apart
// from what it's given: rules (nfRules), plugged slips, a day key for the loss limit.
function rrReplay(closed, bdays, o){
  o=Object.assign({days:90,now:Date.now(),rules:null,plugs:[]},o||{});
  const from=o.now-o.days*86400000, tr=(closed||[]).filter(t=>t&&!t.isOpen&&t.closeTime>=from);
  if(tr.length<10)return {n:tr.length,few:true};
  const flag=new Map(); for(const b of bdays||[])for(const s of ((b&&b.slips)||[]))flag.set(s.id,s.f||[]);
  const broke=new Map(), add=(id,why)=>{ if(!broke.has(id))broke.set(id,new Set()); broke.get(id).add(why); };
  const R=o.rules||{}, anyRule=R.maxPerDay>0||R.cooldownMin>0||R.noAddToLosers||R.dailyLossLimit>0;
  if(anyRule)for(const r of evaluateRules(tr,R))for(const id of r.ids||[])add(id,r.rule);
  for(const sl of o.plugs||[])for(const t of tr)if((flag.get(t.id)||[]).includes(sl))add(t.id,'plug:'+sl);
  const slipped=new Set(tr.filter(t=>(flag.get(t.id)||[]).length).map(t=>t.id));
  const M=pred=>whatIfModel(tr,pred);
  const r=broke.size?M(t=>broke.has(t.id)):null, s=slipped.size?M(t=>slipped.has(t.id)):null;
  const which={}; for(const set of broke.values())for(const w of set)which[w]=(which[w]||0)+1;
  return {n:tr.length,net:tr.reduce((a,t)=>a+t.net,0),days:o.days,hasRules:anyRule||(o.plugs||[]).length>0,
    rules:r?{n:r.removed.n,net:r.kept.net,cut:r.removed.net,maxDD:r.kept.maxDD,actualDD:r.all.maxDD,which}:null,
    slips:s?{n:s.removed.n,net:s.kept.net,cut:s.removed.net}:null};
}
let _rrMemo={key:null,v:null};
function rrOf(D){
  const g=D&&D.g; if(!g||!g.ctx)return null;
  const plugs=typeof pzPlugs==='function'?[...new Set(pzPlugs().filter(p=>!p.dropped).map(p=>p.slip))]:[], rules=nfRules();
  const key=(typeof _gameKey==='function'?_gameKey():'')+'|'+JSON.stringify(rules)+'|'+plugs.join(',');
  if(_rrMemo.key!==key){ let v=null; try{ v=rrReplay(g.ctx.closed,g.days.map(d=>d.behavior),{rules,plugs}); }catch(e){ console.warn('rule replay',e); } _rrMemo={key,v}; }
  return _rrMemo.v;
}
const RR_PLUG=k=>'plugging “'+String((PZ_BEH&&PZ_BEH[k])||k).toLowerCase()+'”';
function rrWhich(w){ return Object.entries(w||{}).sort((a,b)=>b[1]-a[1]).map(([k,n])=>(k.startsWith('plug:')?RR_PLUG(k.slice(5)):k)+' ('+n+')').join(', '); }
function rrSectionHtml(D){
  const x=rrOf(D); if(!x||x.few)return '';
  const r=x.rules, s=x.slips;
  return `<section class="pz-card pz-kv" aria-labelledby="rrT"><b id="rrT" class="pz-kvh">Your rules, replayed · ${x.days} days</b>
    ${r?`<p style="margin:0;font-size:15px;line-height:1.4"><b>Keeping your own rules: ${esc(signedPlain(r.net))}</b> instead of ${esc(signedPlain(x.net))}, with ${r.n} fewer trade${r.n===1?'':'s'}.</p>
      <span class="pz-sub" style="font-size:13px">The rule-breaking trades: ${esc(rrWhich(r.which))}. Worst drawdown ${esc(usdPlain(-r.maxDD))} instead of ${esc(usdPlain(-r.actualDD))}.</span>`
      :x.hasRules?'<p class="pz-sub" style="margin:0;font-size:13px">Not one trade broke your rules in this stretch.</p>'
      :'<p class="pz-sub" style="margin:0;font-size:13px">You haven’t written any rules down yet: set them in Settings (trades a day, a cool-down after a loss, a daily loss limit), or plug a leak.</p>'}
    ${s?`<p style="margin:0;font-size:14px;line-height:1.4">Without any of the six slips: ${esc(signedPlain(s.net))}, ${s.n} fewer trade${s.n===1?'':'s'}.</p>`:''}
    <p class="pz-fine" style="margin:0">A straight replay: the trades that broke a rule are taken out and the rest stay as they were. What you’d have done instead can’t be known.</p></section>`;
}
// on Today: only when keeping your rules would have been worth it
function rrCardHtml(D){
  const x=rrOf(D), r=x&&!x.few&&x.rules; if(!r||!(r.cut<0)||Math.abs(r.cut)<Math.max(1,Math.abs(x.net)*0.05))return '';
  return `<section class="pz-card pz-kv" aria-labelledby="rrC"><div class="pz-kvrow"><b id="rrC" class="pz-kvh">Your rules, replayed</b><span class="pz-tag leak">${x.days} days</span></div>
    <b style="font-size:16px;line-height:1.3">Keeping your own rules: ${esc(signedPlain(r.net))} instead of ${esc(signedPlain(x.net))}.</b>
    <p class="pz-sub" style="margin:0;font-size:13px">${r.n} fewer trade${r.n===1?'':'s'}: ${esc(rrWhich(r.which))}.</p>
    <a class="pz-link" href="#data" style="min-height:0">The replay in full${pzI('chev',14)}</a></section>`;
}
pzFeature({id:'rules', today:{label:'Your rules, replayed',hint:'The last 90 days had you kept your own rules',col:1,after:'luck',html:rrCardHtml}});
