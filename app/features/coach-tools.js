/* ============================================================================
   The coach's lookups — query_trades, run here on your device over your own closed trades when the AI
   coach asks (server.js COACH_TOOLS). Loads on Daruma's page only (data-only="keel"), where the chat lives.

   Only for a trader who shares their trades with the coach: the same say-so that sends the recent trades
   along. The coach asks with filters (a market, a side, entry hours and weekdays on your clock, a setup, a
   slip, a result, hold times, dates) and an optional grouping; this answers with counts, net, the average
   trade, win rate, profit factor and typical hold, per group, and a few example trades. No notes, no
   wallet. A question gets at most three lookups, then the answer.
   ============================================================================ */
const CT_DAYS=['sun','mon','tue','wed','thu','fri','sat'], CT_SLIPS=['revenge','afterTwo','sizeUp','addLoser','overtrade','heldLoser'];
const ctR=v=>v==null||!isFinite(v)?null:Math.round(v*100)/100;
// the trades, filtered and summarised. Pure apart from the helpers it reads (tzParts, dayKey, dcoin, isWin, isLoss).
// o: {slipOf: {tradeId: [slip keys]}, setupOf: id -> tag}
function coachQueryTrades(input, closed, o){
  const q=input&&typeof input==='object'?input:{}, sl=(o&&o.slipOf)||{}, setupOf=(o&&o.setupOf)||(()=>null);
  const day=s=>/^\d{4}-\d{2}-\d{2}$/.test(s||'')?s:null, from=day(q.from), to=day(q.to);
  const mk=String(q.market||'').trim().toUpperCase(), side=q.side==='long'?'Long':q.side==='short'?'Short':null;
  const hours=Array.isArray(q.hours)?q.hours.map(Number).filter(h=>Number.isInteger(h)&&h>=0&&h<24):[];
  const wds=Array.isArray(q.weekdays)?q.weekdays.map(w=>CT_DAYS.indexOf(String(w).toLowerCase().slice(0,3))).filter(i=>i>=0):[];
  const setup=String(q.setup||'').trim().toLowerCase(), slip=CT_SLIPS.includes(q.slip)||q.slip==='any'||q.slip==='none'?q.slip:null;
  const minH=+q.minHoldMinutes>0?+q.minHoldMinutes*60000:null, maxH=+q.maxHoldMinutes>0?+q.maxHoldMinutes*60000:null;
  const mkOf=t=>{ try{ return String(dcoin(t)||t.coin||''); }catch(e){ return String(t.coin||''); } };
  const res=t=>isWin(t.net)?'win':isLoss(t.net)?'loss':'scratch', hold=t=>t.closeTime&&t.openTime&&!t.partialHistory?t.closeTime-t.openTime:null;
  const T=(closed||[]).filter(t=>{
    if(!t||t.isOpen||!t.closeTime)return false; const k=dayKey(t.closeTime);
    if(from&&k<from||to&&k>to)return false;
    if(mk&&!mkOf(t).toUpperCase().split(/[\s:/(]/).includes(mk)&&mkOf(t).toUpperCase()!==mk)return false;
    if(side&&t.dir!==side)return false;
    if(hours.length||wds.length){ const p=tzParts(t.openTime||t.closeTime); if(hours.length&&!hours.includes(p.h))return false; if(wds.length&&!wds.includes(p.dow))return false; }
    if(q.result&&res(t)!==q.result)return false;
    if(slip){ const f=sl[t.id]||[]; if(slip==='any'?!f.length:slip==='none'?f.length:!f.includes(slip))return false; }
    if(setup&&String(setupOf(t.id)||'').toLowerCase()!==setup)return false;
    const h=hold(t); if(minH&&!(h>=minH)||maxH&&!(h!=null&&h<=maxH))return false;
    return true; });
  const sum=A=>{ const n=A.length, net=A.reduce((a,t)=>a+t.net,0), w=A.filter(t=>isWin(t.net)).length, l=A.filter(t=>isLoss(t.net)).length;
    const gp=A.filter(t=>t.net>0).reduce((a,t)=>a+t.net,0), gl=-A.filter(t=>t.net<0).reduce((a,t)=>a+t.net,0), hs=A.map(hold).filter(x=>x>0).sort((a,b)=>a-b);
    return {trades:n,net:ctR(net),avgTrade:n?ctR(net/n):null,winRate:w+l?ctR(100*w/(w+l)):null,profitFactor:gl>0?ctR(gp/gl):gp>0?'no losses':null,typicalHoldMin:hs.length?Math.round(hs[hs.length>>1]/60000):null}; };
  const out={filters:Object.fromEntries(Object.entries({from,to,market:mk||null,side:q.side||null,hours:hours.length?hours:null,weekdays:wds.length?wds.map(i=>CT_DAYS[i]):null,result:q.result||null,slip,setup:setup||null,
    minHoldMinutes:minH?minH/60000:null,maxHoldMinutes:maxH?maxH/60000:null}).filter(([,v])=>v!=null)),all:sum(T)};
  const gb=q.groupBy&&q.groupBy!=='none'?q.groupBy:null;
  if(gb){ const key={market:mkOf,side:t=>t.dir,hour:t=>String(tzParts(t.openTime||t.closeTime).h).padStart(2,'0')+':00',weekday:t=>CT_DAYS[tzParts(t.openTime||t.closeTime).dow],
      month:t=>dayKey(t.closeTime).slice(0,7),setup:t=>setupOf(t.id)||'(no setup)',result:res,slip:t=>(sl[t.id]||[]).join('+')||'clean'}[gb];
    if(key){ const G=new Map(); for(const t of T){ const k=String(key(t)); if(!G.has(k))G.set(k,[]); G.get(k).push(t); }
      out.groups=[...G.entries()].map(([k,A])=>Object.assign({[gb]:k},sum(A))).sort((a,b)=>b.trades-a.trades).slice(0,24); } }
  const ex=Math.max(0,Math.min(10,Math.round(+q.examples)||0));
  if(ex)out.examples=[...T].sort((a,b)=>b.closeTime-a.closeTime).slice(0,ex).map(t=>{ const p=tzParts(t.openTime||t.closeTime);
    return {date:dayKey(t.closeTime),opened:String(p.h).padStart(2,'0')+':'+String(p.min).padStart(2,'0'),market:mkOf(t),side:t.dir,net:ctR(t.net),holdMin:hold(t)?Math.round(hold(t)/60000):null,setup:setupOf(t.id)||null,slips:sl[t.id]||[]}; });
  if(T.length<20)out.note='Only '+T.length+' trade'+(T.length===1?'':'s')+': a hint, not a pattern.';
  return out;
}
// the app's side of a lookup round: each call answered from this device's trades
function coachRunTools(calls){
  const D=_pzLastD||pzData(), slipOf={};
  for(const d of D.g.days)for(const s of ((d.behavior&&d.behavior.slips)||[]))slipOf[s.id]=s.f||[];
  return (calls||[]).map(c=>{ if(c.name!=='query_trades')return {id:c.id,content:'Unknown tool.',error:true};
    try{ return {id:c.id,content:JSON.stringify(coachQueryTrades(c.input,D.ctx.closed,{slipOf,setupOf:id=>(journal[id]&&journal[id].setup)||null}))}; }
    catch(e){ return {id:c.id,content:'The lookup failed on the device: '+String(e&&e.message||e).slice(0,120),error:true}; } });
}
