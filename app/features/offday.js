/* ============================================================================
   Off the screen — a Today card for a day with no trades and nothing open, so a day off still has
   something worth opening Daruma for: last week's report card, the lessons library, the latest recap,
   and a way to say "I'm sitting out today on purpose".
   A feature in its own file: it plugs into Daruma through pzFeature (app/pulse.js) and loads on
   Daruma's page only (data-only="keel" in ledger.html).

   A rest day is kept on the day's journal entry (rest: when it was marked) and counted in the
   month's recap. It earns no XP, on purpose: XP for not trading could be claimed every day with no
   effort, and the leagues rank on XP. The card goes away as soon as the day has a trade.
   ============================================================================ */
function odRestDays(J, month){ let n=0; for(const k in J)if(k.startsWith('day:'+month)&&J[k]&&J[k].rest)n++; return n; }
function odCardHtml(D){
  if(D.day||(D.todayTrades&&D.todayTrades.length))return '';
  if(((D.ctx&&D.ctx.trades)||[]).some(t=>t.isOpen&&!t.orphan&&t.market!=='spot'))return ''; // a perp still open: not a day off (a spot holding is)
  const g=D.g, e=D.dayE||{}, wd=new Date(D.todayK+'T12:00:00Z').getUTCDay(), weekend=wd===0||wd===6, rest=!!e.rest;
  const rows=[];
  // last week's report card (unlocked with level), else the one before when last week had no trading
  if(!pzLocked('reports',g.level.level)){ const wk=pzPeriods(g,'week').filter(k=>k<isoWeekOfKey(D.todayK)).pop(); const r=wk?pzReport(g,'week',wk):null;
    if(r)rows.push(`<a class="pz-bonus" href="#report" data-od-rk="${esc(wk)}"><span class="pz-bc done" style="font-weight:700">${esc(r.grade)}</span><span style="flex:1;min-width:0"><b>Last week’s report card</b><span>${r.good} of ${r.days} trading days at 70+${r.leak?' · top slip: '+esc(PZ_BEH[r.leak].toLowerCase()):''}</span></span>${pzI('chev',16)}</a>`); }
  let n=0; try{ n=pzLessonsAll().length; }catch(err){}
  if(n)rows.push(`<a class="pz-bonus" href="#lessons"><span class="pz-bc">${pzI('book',14)}</span><span style="flex:1;min-width:0"><b>Your lessons library</b><span>${n} lesson${n===1?'':'s'} in your own words</span></span>${pzI('chev',16)}</a>`);
  if(typeof rcLatest==='function'){ const L=rcLatest(g); if(L)rows.push(`<a class="pz-bonus" href="#recap"><span class="pz-bc">${pzI('trends',14)}</span><span style="flex:1;min-width:0"><b>${esc(L.label)} recap</b><span>Your process over the ${L.kind}, no dollars</span></span>${pzI('chev',16)}</a>`); }
  const month=D.todayK.slice(0,7), nRest=odRestDays(journal,month);
  return `<section class="pz-card pz-kv" aria-labelledby="odT"><div class="pz-kvrow"><b id="odT" class="pz-kvh">${rest?'Rest day':weekend?'Off the screen today':'No trades yet today'}</b>${nRest?`<span class="pz-sub" style="font-size:12px">${nRest} rest day${nRest===1?'':'s'} this month</span>`:''}</div>
    <p class="pz-sub" style="margin:0;font-size:13px">${rest?'Sitting out is a decision too, and a good one when you’re not at your best. Your streak never breaks on a day you don’t trade.':'A quiet day is a good one to look back: a few minutes here keep the habit without a trade.'}</p>
    ${rows.join('')}
    <button type="button" class="${rest?'pz-linkbtn':'pz-ghost pz-sm'}" data-od="${rest?'unrest':'rest'}"${rest?'':' style="align-self:flex-start;width:auto;padding:0 14px"'}>${rest?'Undo: I may trade today':'I’m sitting out today on purpose'}</button></section>`;
}
async function odClick(t){
  const ds=t.dataset;
  if(ds.odRk){ pzS.rk='week'; pzS.rkey=ds.odRk; return false; } // the link goes on to #report
  if(ds.od!=='rest'&&ds.od!=='unrest')return false;
  const k='day:'+dayKey(Date.now()), e=Object.assign({},journal[k]||{});
  if(ds.od==='rest')e.rest=Date.now(); else delete e.rest;
  journal[k]=e; markJEdit(k); await Store.set(J_KEY,journal);
  pzNote(ds.od==='rest'?'Marked as a rest day. Enjoy it.':'Unmarked.'); pzRender(); return true;
}
pzFeature({id:'offday', today:{label:'Days off the screen',hint:'On a day without trades: last week’s report card, your lessons, and marking a rest day',col:1,after:'next',html:odCardHtml}, click:odClick});
