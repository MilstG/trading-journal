/* ============================================================================
   The crowd at your entry — your entries set against what the league's traders were doing that hour.
   A section of What the data says (#data, features/research.js); loads on Daruma's page only.

   The research run sends each hour's net flow per coin for everyone and for the top and bottom skill
   quarters (research.js crowdOf: '0' selling hard … '4' buying hard, '.' fewer than 3 wallets of the
   group traded), a day behind and group figures only. For each of your perp entries inside that span, in
   a coin it covers, the hour you entered says whether you went with the group's flow or against it;
   then your average result each way. A pattern, not a signal: the flow is read after the fact.
   ============================================================================ */
// trades -> per group: {with: {n, net}, against: {n, net}, flat: n, read: n}. Pure.
function crowdAtEntry(trades, C){
  if(!C||!C.coins||!(C.hours>0))return null;
  const H=3600000, out={}, end=C.from+C.hours*H;
  for(const g of C.groups||[])out[g]={with:{n:0,net:0},against:{n:0,net:0},flat:0,read:0};
  const coins=new Set();
  for(const t of trades||[]){
    if(!t||t.isOpen||!t.openTime||t.openTime<C.from||t.openTime>=end||(t.dir!=='Long'&&t.dir!=='Short'))continue;
    const row=C.coins[t.coin]; if(!row)continue; coins.add(t.coin);
    const i=Math.floor((t.openTime-C.from)/H), sg=t.dir==='Long'?1:-1;
    for(const g of Object.keys(out)){ const c=row[g]&&row[g][i]; if(!c||c==='.')continue; const x=out[g]; x.read++;
      const d=(+c-2)*sg; if(!d){ x.flat++; continue; } const k=d>0?x.with:x.against; k.n++; k.net+=+t.net||0; }
  }
  return {groups:out,coins:[...coins]};
}
const CROWD_NAME={all:'the crowd','tier:top':'the top quarter','tier:bottom':'the bottom quarter'};
function crowdSectionHtml(D){
  const F=typeof rfData==='function'?rfData():null, C=F&&F.crowd; if(!C)return '';
  const r=crowdAtEntry((D.g&&D.g.ctx&&D.g.ctx.closed)||[],C); if(!r)return '';
  const days=Math.round(C.hours/24), avg=x=>x.n?signedPlain(x.net/x.n):'—';
  const line=g=>{ const x=r.groups[g]; if(!x||x.with.n+x.against.n<5)return '';
    return `<div class="pz-kv" style="gap:4px;padding:10px 0;border-top:1px solid var(--pz-line)"><b style="font-size:15px">With ${esc(CROWD_NAME[g]||g)}: ${x.with.n} · against: ${x.against.n}</b>
      <span style="font-size:13px">Your average trade with them ${esc(avg(x.with))}, against them ${esc(avg(x.against))}${x.flat?'; '+x.flat+' entered while they were balanced':''}.</span></div>`; };
  const body=['tier:top','all','tier:bottom'].map(line).join('');
  return `<section class="pz-card pz-kv" aria-labelledby="crT"><b id="crT" class="pz-kvh">The crowd at your entry</b>
    <p class="pz-sub" style="margin:0;font-size:13px">Your entries over the ${days} days the run covers${r.coins.length?' in '+esc(r.coins.slice(0,6).join(', ')):''}, against which way the league’s traders were trading that hour. Skill quarters were set on the first half of the run’s data.</p>
    ${body||'<p class="pz-sub" style="margin:0;font-size:13px">It needs 5 of your entries in hours the run could read, in the coins it covers.</p>'}
    <p class="pz-fine" style="margin:0">Group flow a day behind, from the last research run: a pattern in what happened, never a signal to follow.</p></section>`;
}
