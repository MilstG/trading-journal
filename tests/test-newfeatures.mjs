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
const FNS = ['nfMedian','nfXirr','classifyLedgerDelta','cashFlowModel','leverageSurvival',
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

const TRACK=new Set(['0xaaa','0xbbb']); // two of the user's own wallets
t('classify deposit ext_in', ()=>{ const c=ctx.classifyLedgerDelta({type:'deposit',usdc:'1000'},'0xaaa',TRACK); eq(c.flow,'ext_in'); near(c.usdc,1000); });
t('classify withdraw ext_out', ()=>{ const c=ctx.classifyLedgerDelta({type:'withdraw',usdc:'400'},'0xaaa',TRACK); eq(c.flow,'ext_out'); near(c.usdc,-400); });
t('own-wallet transfer nets out (internal)', ()=>{ // A->B, both tracked: seen from B it is an inflow but counterparty A is tracked
  const c=ctx.classifyLedgerDelta({type:'internalTransfer',usdc:'500',user:'0xaaa',destination:'0xbbb'},'0xbbb',TRACK); eq(c.flow,'internal'); });
t('transfer IN from untracked = external in (the real bug)', ()=>{
  const c=ctx.classifyLedgerDelta({type:'spotTransfer',usdcValue:'2000',amount:'2000',token:'USDC',user:'0xexchange',destination:'0xaaa'},'0xaaa',TRACK);
  eq(c.flow,'ext_in'); near(c.usdc,2000); });
t('transfer OUT to untracked = external out', ()=>{
  const c=ctx.classifyLedgerDelta({type:'internalTransfer',usdc:'300',user:'0xaaa',destination:'0xother'},'0xaaa',TRACK);
  eq(c.flow,'ext_out'); near(c.usdc,-300); });
t('accountClassTransfer internal', ()=>{ eq(ctx.classifyLedgerDelta({type:'accountClassTransfer',usdc:'12',toPerp:false},'0xaaa',TRACK).flow,'internal'); });
t('vaultDeposit vault_out neg', ()=>{ const c=ctx.classifyLedgerDelta({type:'vaultDeposit',usdc:'9'},'0xaaa',TRACK); eq(c.flow,'vault_out'); near(c.usdc,-9); });
t('xirr 10%', ()=>near(ctx.nfXirr([{t:now-365*DAY,amt:-1000},{t:now,amt:1100}]),0.10,1e-3));
t('xirr flat 0', ()=>near(ctx.nfXirr([{t:now-365*DAY,amt:-1000},{t:now,amt:1000}]),0,1e-3));
t('xirr no sign change null', ()=>eq(ctx.nfXirr([{t:now-DAY,amt:-1},{t:now,amt:-1}]),null));
t('cashFlowModel counts transfer-in deposits + nets own-wallet + vault separate', ()=>{
  const T=new Set(['0xaaa','0xbbb']);
  const ups=[
    {time:now-100*DAY,addr:'0xaaa',delta:{type:'spotTransfer',usdcValue:'1000',amount:'1000',token:'USDC',user:'0xcex',destination:'0xaaa'}}, // ext in 1000
    {time:now-90*DAY, addr:'0xbbb',delta:{type:'internalTransfer',usdc:'400',user:'0xaaa',destination:'0xbbb'}},                              // own-wallet, internal
    {time:now-50*DAY, addr:'0xaaa',delta:{type:'withdraw',usdc:'200'}},                                                                       // ext out 200
    {time:now-40*DAY, addr:'0xaaa',delta:{type:'vaultDeposit',usdc:'300'}},                                                                   // vault out -300
  ];
  const m=ctx.cashFlowModel(ups,1500,700,T);
  near(m.deposits,1000); near(m.withdrawals,200); near(m.netExternal,800); eq(m.extCount,2);
  near(m.vaultNet,-300); near(m.simpleReturn,700/800); ok(m.xirr!=null);
  ok(m.composition.length>=3); });
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
