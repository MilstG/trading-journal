// Unit tests for the Capital / leverage / rules / plan / leaderboard / funding build.
// Same pattern as the other suites: extract pure functions straight from ledger.html,
// eval them in a stubbed sandbox, assert behaviour. Run: node test-newfeatures.mjs
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('./ledger.html', import.meta.url), 'utf8');
function grab(name){
  for (const hdr of ['async function '+name+'(', 'function '+name+'(']) {
    const i = html.indexOf(hdr); if (i < 0) continue;
    let d = 0; for (let p = html.indexOf('{', i); p < html.length; p++) {
      if (html[p]==='{') d++; else if (html[p]==='}') { d--; if (!d) return html.slice(i, p+1); } }
  }
  throw new Error('function not found: '+name);
}
function grabArrow(name){
  const m = html.match(new RegExp('\\b(?:const|let)\\s+'+name+'=.*?;'));
  if (!m) throw new Error('const not found: '+name); return m[0];
}
const FNS = ['nfMedian','leverageSurvival',
  'nfRules','evaluateRules','dailyLossToday','nfPlan','planAdherence','nfGroupStats','leaderboard','fundingCarry'];
const ARROWS = ['nfPct','nfSignPct','nfUtcDay'];

const ctx = { _be:50, journal:{}, settings:{rules:{},assumedLev:5}, spotMaps:{nameByCoin:{}}, Date, Math, console };
ctx.isWin=n=>n>ctx._be; ctx.isLoss=n=>n<-ctx._be; ctx.isBE=n=>Math.abs(n)<=ctx._be;
ctx.dcoin=t=>t.coin; ctx.fmtUsd=n=>(n<0?'-$':'$')+Math.abs(n).toFixed(2);
ctx.sharpeStats=()=>({sharpe:1.23}); ctx.dailySeriesCalendar=()=>[1,2,3];
vm.createContext(ctx);
vm.runInContext(ARROWS.map(grabArrow).concat(FNS.map(grab)).join('\n'), ctx);

let pass=0, fail=0;
const t=(n,f)=>{ try{ f(); pass++; }catch(e){ fail++; console.error('FAIL '+n+': '+e.message);} };
const near=(a,b,tol=1e-6)=>{ if(Math.abs(a-b)>tol) throw new Error('got '+a+' want '+b); };
const eq=(a,b)=>{ if(JSON.stringify(a)!==JSON.stringify(b)) throw new Error('got '+JSON.stringify(a)+' want '+JSON.stringify(b)); };
const ok=v=>{ if(!v) throw new Error('expected truthy'); };
const DAY=86400000, now=Date.now();

t('leverageSurvival maxLev + flag', ()=>{ const ls=ctx.leverageSurvival(
  [{id:'a',coin:'BTC',net:1},{id:'b',coin:'ETH',net:-1},{id:'c',coin:'SOL',net:1}],{a:{maePct:5},b:{maePct:20},c:{maePct:2}},10);
  near(ls.rows[0].maxLev,5); eq(ls.wouldLiq.length,1); near(ls.medMaxLev,20); });
t('rules maxPerDay', ()=>{ const base=now-10*DAY; const closed=[0,1,2,3].map(i=>({id:'t'+i,openTime:base+i*6e4,closeTime:base+i*6e4+1e3,net:-100,entryDrift:0}));
  const f=ctx.evaluateRules(closed,{maxPerDay:2}).find(x=>x.rule.includes('Max 2')); eq(f.n,2); near(f.cost,-200); });
t('rules noAddToLosers', ()=>{ const f=ctx.evaluateRules([{id:'x',net:-100,entryDrift:0.01},{id:'z',net:200,entryDrift:0.02}],{noAddToLosers:true}).find(x=>x.rule.includes('adding')); eq(f.n,1); });
t('dailyLossToday utc filter', ()=>{ const d=ctx.dailyLossToday([{isOpen:false,closeTime:now,net:-300},{isOpen:false,closeTime:now,net:100},{isOpen:false,closeTime:now-2*DAY,net:-9}]); near(d.net,-200); eq(d.n,2); });
t('planAdherence long', ()=>{ ctx.journal={L1:{plan:{entry:100,stop:90,target:120}}};
  const pa=ctx.planAdherence([{id:'L1',dir:'Long',avgEntry:100,avgExit:118,maxSize:10,net:180}],ctx.journal);
  eq(pa.stopHonoredRate,1); eq(pa.targetHitRate,0); near(pa.medPlannedRR,2); near(pa.medRealizedR,1.8); });
t('fundingCarry flip+dominant', ()=>{ ctx._be=50; const fc=ctx.fundingCarry([
  {coin:'BTC',pnl:100,fees:10,funding:-80,net:10},{coin:'ETH',pnl:200,fees:20,funding:30,net:210},{coin:'BTC',pnl:-100,fees:5,funding:-200,net:-305}]);
  eq(fc.flipped,1); eq(fc.dominant,1); eq(fc.coins[0].coin,'BTC'); });
t('leaderboard groups', ()=>{ ctx.journal={s1:{setup:'breakout'},s2:{setup:'breakout'}};
  const lb=ctx.leaderboard([{id:'s1',isOpen:false,closeTime:now,net:300,wallet:{label:'main'}},{id:'s2',isOpen:false,closeTime:now-DAY,net:-100,wallet:{label:'alt'}}]);
  eq(lb.wallets[0].label,'main'); near(lb.setups[0].net,200); });

console.log((fail?'\u2717':'\u2713')+' new-features suite: '+pass+' passed, '+fail+' failed');
process.exit(fail?1:0);
