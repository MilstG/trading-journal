// dex-source filter (main dex vs HIP-3 builder dexes)
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { t, ok, report, makeExtractor } from './harness.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '..', 'ledger.html'), 'utf8');
const { grabFn } = makeExtractor(html);

// Bundle the filter fns with mutable state they close over (view/dexView/dexSel/allTrades/openPositions).
const bundle = (state) => (0, eval)('(function(){' + state +
  [ 'tradeDex','dexOk','dexFilter','knownDexes','dexPositions','viewFilter' ].map(grabFn).join('\n') +
  ';return {tradeDex,dexFilter,knownDexes,dexPositions,viewFilter,' +
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
  ok(html.includes('settings.dexView=data.settings.dexView'), 'restore path');
  ok(html.includes('syncDexTog();'), 'render() calls sync');
  ok(html.includes("dexView=settings.dexView||'all'"), 'init from settings');
});

report('test-dexfilter');
