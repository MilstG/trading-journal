// dex-source filter (main dex vs HIP-3 builder dexes)
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { t, ok, report, makeExtractor } from './harness.mjs';
import { readAppSource } from '../app-source.js'; // ledger.html with its app/*.js inlined, in load order

const here = dirname(fileURLToPath(import.meta.url));
const html = readAppSource(join(here, '..', 'ledger.html'));
const { grabFn } = makeExtractor(html);

// Bundle the filter fns with mutable state they close over (view/dexView/dexSel/allTrades/openPositions).
const bundle = (state) => (0, eval)('(function(){' + state +
  [ 'tradeDex','dexOk','dexFilter','knownDexes','dexPositions','viewFilter','tableFilter','tradeRow','moneyRow','rangeActive','inRange','periodTrades','periodTradesAll' ].map(grabFn).join('\n') +
  ';return {tradeDex,dexFilter,knownDexes,dexPositions,viewFilter,tableFilter,tradeRow,moneyRow,periodTrades,periodTradesAll,' +
  'set:(v,d,s)=>{view=v??view; dexView=d??dexView; if(s)dexSel=new Set(s);},' +
  'get openPositions(){return openPositions}};})()');

console.log('\ndex-source filter');

await t('tradeDex classifies main / HIP-3 / spot / pair coins', () => {
  const f = bundle("let view='perp',dexView='all',dexSel=new Set(),allTrades=[],openPositions=[];");
  ok(f.tradeDex({ coin: 'BTC' }) === '', 'main perp');
  ok(f.tradeDex({ coin: 'xyz:GOLD' }) === 'xyz', 'hip3 prefixed');
  ok(f.tradeDex({ coin: '@210' }) === '', 'spot index');
  ok(f.tradeDex({ coin: 'HYPE/USDC' }) === '', 'spot pair');
  ok(f.tradeDex({ coin: 42 }) === '', 'non-string');
});

await t('dexFilter respects all / main / hip3 modes and chip narrowing', () => {
  const f = bundle("let view='perp',dexView='all',dexSel=new Set(),allTrades=[],openPositions=[];");
  const main = { coin: 'BTC' }, h1 = { coin: 'xyz:GOLD' }, h2 = { coin: 'flex:OIL' };
  ok(f.dexFilter(main) && f.dexFilter(h1), 'all passes everything');
  f.set(null, 'main'); ok(f.dexFilter(main) && !f.dexFilter(h1), 'main excludes hip3');
  f.set(null, 'hip3', []); ok(!f.dexFilter(main) && f.dexFilter(h1) && f.dexFilter(h2), 'hip3, empty sel = all dexes');
  f.set(null, 'hip3', ['xyz']); ok(f.dexFilter(h1) && !f.dexFilter(h2), 'chip narrowing');
});

await t('viewFilter combines market and dex predicates', () => {
  const f = bundle("let view='perp',dexView='all',dexSel=new Set(),allTrades=[],openPositions=[];");
  const tp = { coin: 'xyz:GOLD', market: 'perp' }, ts = { coin: '@210', market: 'spot' };
  f.set('perp', 'main'); ok(!f.viewFilter(tp), 'perp+main drops hip3 trade');
  f.set('perp', 'hip3', []); ok(f.viewFilter(tp) && !f.viewFilter(ts), 'perp+hip3 keeps only hip3');
  f.set('combined', 'main'); ok(f.viewFilter(ts), 'spot counts as main dex');
  f.set('spot', 'hip3'); ok(!f.viewFilter(ts), 'spot+hip3 = empty set, by design');
});

await t('trade rows and money rows: positions are listed and scored, day rows are summed, MOVED is listed only', () => {
  const perp = { id: 'p', coin: 'BTC', market: 'perp', isOpen: false, closeTime: 10, net: 5 };
  const pos = { id: 's1', coin: '@210', market: 'spot', spotPos: true, isOpen: false, closeTime: 11, net: 1 };
  const held = { id: 's2', coin: '@107', market: 'spot', spotPos: true, isOpen: true, closeTime: 12, net: 0 };
  const moved = { id: 's3', coin: '@107', market: 'spot', spotPos: true, isOpen: false, movedOut: true, closeTime: 13, net: -0.1 };
  const day = { id: 'r1', coin: '@210', market: 'spot', spotRz: true, isOpen: false, closeTime: 11, net: 1 };
  const f = bundle("let view='combined',dexView='all',dexSel=new Set(),openPositions=[],period=0,customRange={from:null,to:null},allTrades=" + JSON.stringify([perp, pos, held, moved, day]) + ";");
  const ids = a => a.map(x => x.id).sort().join(',');
  ok(ids(f.periodTrades()) === 'p,s1', 'statistics: closed perp trades and closed spot positions, not day rows, not MOVED: ' + ids(f.periodTrades()));
  ok(ids(f.periodTradesAll()) === 'p,r1', 'money: perp trades and spot day rows, never a position: ' + ids(f.periodTradesAll()));
  ok(ids(f.periodTradesAll(true)) === 'p,s1,s2,s3', 'the table: every trade row, open, closed and MOVED, no day rows: ' + ids(f.periodTradesAll(true)));
  f.set('spot'); ok(ids(f.periodTrades()) === 's1' && ids(f.periodTradesAll()) === 'r1', 'the spot view keeps the split');
  f.set('perp'); ok(ids(f.periodTrades()) === 'p' && ids(f.periodTradesAll()) === 'p', 'perps alone are both');
});

await t('knownDexes unions trades and open positions, sorted', () => {
  const f = bundle("let view='perp',dexView='all',dexSel=new Set()," +
    "allTrades=[{coin:'xyz:GOLD'},{coin:'BTC'},{coin:'@1'}]," +
    "openPositions=[{coin:'abc:SPX',dex:'abc'}];");
  ok(JSON.stringify(f.knownDexes()) === '["abc","xyz"]', 'sorted union');
});

await t('dexPositions filters the open book; identity in all-mode', () => {
  const f = bundle("let view='perp',dexView='all',dexSel=new Set(),allTrades=[]," +
    "openPositions=[{coin:'BTC',dex:''},{coin:'xyz:GOLD',dex:'xyz'}];");
  ok(f.dexPositions() === f.openPositions, 'all returns the same array (no copy churn)');
  f.set(null, 'main'); ok(f.dexPositions().length === 1 && !f.dexPositions()[0].dex, 'main only');
  f.set(null, 'hip3', []); ok(f.dexPositions().length === 1 && f.dexPositions()[0].dex === 'xyz', 'hip3 only');
});

await t('UI wiring present: toggle, chips, persistence, render hook', () => {
  ok(html.includes('id="dextog"'), 'dextog markup');
  ok(html.includes('id="dexchips"'), 'chips markup');
  ok(html.includes('dexView:settings.dexView'), 'snapshot whitelist');
  ok(html.includes("if(['all','main','hip3'].includes(ds.dexView))settings.dexView=ds.dexView"), 'restore path (whitelisted)');
  ok(html.includes('syncDexTog();'), 'render() calls sync');
  ok(html.includes("dexView=settings.dexView||'all'"), 'init from settings');
});

report('test-dexfilter');
