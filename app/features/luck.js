/* ============================================================================
   Your luck, measured — how much of a stretch's result your trades can vouch for.
   Loads on Daruma's page only (data-only="keel"): a card on Today (a week leaning on one trade) and a section of
   What the data says (#data, features/research.js).

   Two plain questions about a window of closed trades (luckOf, pure):
     · how sure is the average trade? A 95% range by resampling the trades (a seeded bootstrap), and the
       share of resamples above zero: under 80% the edge is a guess, from 95% it's probably real.
     · how much rests on one trade? The window without its best trade (its worst, for a losing one):
       "+$4,000 this month is +$600 without the BTC spike".
   Trades are the trade rows (perp trades, spot positions); nothing leaves the device.
   ============================================================================ */
function luckOf(trades, o){
  o=Object.assign({iters:1000,seed:13},o||{});
  const T=(trades||[]).filter(t=>t&&!t.isOpen&&t.closeTime&&isFinite(+t.net)), n=T.length;
  if(n<5)return {n,few:true};
  const nets=T.map(t=>+t.net), net=nets.reduce((a,x)=>a+x,0), avg=net/n;
  let s=o.seed>>>0||7; const rnd=()=>{ s^=s<<13; s>>>=0; s^=s>>17; s^=s<<5; s>>>=0; return s/4294967296; };
  const means=[]; for(let i=0;i<o.iters;i++){ let a=0; for(let j=0;j<n;j++)a+=nets[Math.floor(rnd()*n)]; means.push(a/n); }
  means.sort((a,b)=>a-b);
  const by=[...T].sort((a,b)=>b.net-a.net), best=by[0], worst=by[n-1], lean=net>=0?best:worst;
  return {n,net,avg,lo:means[Math.floor(0.025*(o.iters-1))],hi:means[Math.ceil(0.975*(o.iters-1))],pPos:means.filter(x=>x>0).length/o.iters,
    best,worst,lean,without:net-lean.net,without2:net-by[net>=0?1:n-2].net-lean.net,share:net?lean.net/net:null};
}
const luckSure=p=>p>=0.95?'probably a real edge':p>=0.8?'leaning real, not sure yet':p<=0.05?'probably a real leak':p<=0.2?'leaning negative, not sure yet':'can’t tell from luck yet';
const luckTrade=t=>{ let m=''; try{ m=dispMarket(dcoin(t)); }catch(e){ m=t.coin||''; } return (m+' '+String(t.dir||'').toLowerCase()).trim()+', '+dayLabel(dayKey(t.closeTime)); };
// one window, in words
function luckLines(L, span){
  if(!L||L.few)return null;
  const lead=L.net>=0?'best':'worst', big=L.share!=null&&L.share>=0.5;
  return {head:`${signedPlain(L.net)} ${span} is ${signedPlain(L.without)} without your ${lead} trade`,
    lean:`${luckTrade(L.lean)}: ${signedPlain(L.lean.net)}${big?(L.share>1?', more than the whole result':', '+Math.round(L.share*100)+'% of the result'):''}.`, big,
    avg:`Average trade ${signedPlain(L.avg)}; the range your ${L.n} trades allow runs from ${signedPlain(L.lo)} to ${signedPlain(L.hi)}. ${Math.round(L.pPos*100)}% of resamples came out above zero: ${luckSure(L.pPos)}.`};
}
function luckWin(D, days){ const from=Date.now()-days*86400000; return luckOf(((D.g&&D.g.ctx&&D.g.ctx.closed)||[]).filter(t=>t.closeTime>=from)); }
// the section in What the data says (#data)
function luckSectionHtml(D){
  const rows=[[30,'over 30 days'],[90,'over 90 days']].map(([d,span])=>[span,luckLines(luckWin(D,d),span)]).filter(x=>x[1]);
  return `<section class="pz-card pz-kv" aria-labelledby="lkT"><b id="lkT" class="pz-kvh">Your luck, measured</b>
    ${rows.length?rows.map(([span,x])=>`<div class="pz-kv" style="gap:4px;padding:10px 0;border-top:1px solid var(--pz-line)"><b style="font-size:15px">${esc(x.head)}</b>
      <span class="pz-sub" style="font-size:13px">${esc(x.lean)}</span><span style="font-size:13px">${esc(x.avg)}</span></div>`).join('')
      :'<p class="pz-sub" style="margin:0;font-size:13px">It needs 5 closed trades in the last 30 days.</p>'}
    <p class="pz-fine" style="margin:0">The range comes from resampling your own trades: a stretch that rests on one trade, or a range that crosses zero, says little about your edge either way.</p></section>`;
}
// on Today: a week that leans on one trade
function luckCardHtml(D){
  const x=luckLines(luckWin(D,7),'this week'); if(!x||!x.big)return '';
  return `<section class="pz-card pz-kv" aria-labelledby="lkC"><div class="pz-kvrow"><b id="lkC" class="pz-kvh">Your week, measured</b><span class="pz-tag caution">One trade</span></div>
    <b style="font-size:16px;line-height:1.3">${esc(x.head)}.</b><p class="pz-sub" style="margin:0;font-size:13px">${esc(x.lean)} Judge the week on the rest.</p>
    <a class="pz-link" href="#data" style="min-height:0">How sure is your edge?${pzI('chev',14)}</a></section>`;
}
pzFeature({id:'luck', today:{label:'Your week, measured',hint:'When one trade made or broke your week, the week without it',col:1,after:'priced',html:luckCardHtml}});
