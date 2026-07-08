// Extracts engine/API functions from ledger.html by name (brace matching) and tests
// the HIP-3 multi-dex position changes in Node with a stubbed hlPost.
import { readFileSync } from 'fs';
const html = readFileSync('/home/claude/ledger.html', 'utf8');

function extractFn(name) {
  const re = new RegExp(`(async\\s+)?function\\s+${name}\\s*\\(`);
  const m = re.exec(html);
  if (!m) throw new Error('function not found: ' + name);
  let i = html.indexOf('{', m.index), depth = 0, j = i;
  for (; j < html.length; j++) {
    const c = html[j];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) break; }
  }
  return html.slice(m.index, j + 1);
}

const src = [
  'hip3DexsFromFills', 'mapClearinghouse', 'fetchPositions',
  'isPerp', 'newTrade', 'tallyFill', 'reconstructTrades'
].map(extractFn).join('\n');

// hlPost stub: routes by dex param, can throw per dex
let hlCalls = [];
let hlRoutes = {};
const hlPost = async (body) => {
  hlCalls.push(body);
  const key = body.dex || '';
  const r = hlRoutes[key];
  if (r instanceof Error) throw r;
  return r;
};

const api = new Function('hlPost', src + `
  return {hip3DexsFromFills, mapClearinghouse, fetchPositions, isPerp, reconstructTrades};
`)(hlPost);

let pass = 0, fail = 0;
const t = (name, cond) => { if (cond) { pass++; console.log('  ok  ' + name); } else { fail++; console.log('  FAIL ' + name); } };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log('hip3DexsFromFills');
t('empty/undefined input', eq(api.hip3DexsFromFills(), []) && eq(api.hip3DexsFromFills([]), []));
t('main-dex perp coins ignored', eq(api.hip3DexsFromFills([{coin:'BTC'},{coin:'ETH'}]), []));
t('spot pair and @index ignored', eq(api.hip3DexsFromFills([{coin:'PURR/USDC'},{coin:'@107'}]), []));
t('HIP-3 prefixes collected, deduped, sorted', eq(api.hip3DexsFromFills([
  {coin:'xyz:XYZ100'},{coin:'xyz:TSLA'},{coin:'abc:GOLD'},{coin:'BTC'}
]), ['abc','xyz']));
t('malformed coins ignored (leading colon, non-string)', eq(api.hip3DexsFromFills([
  {coin:':WEIRD'},{coin:42},{},null
]), []));

console.log('mapClearinghouse');
const state = (positions) => ({ assetPositions: positions.map(p => ({ position: p })) });
const rawPos = (coin, szi) => ({ coin, szi: String(szi), entryPx: '100', unrealizedPnl: '5', returnOnEquity: '0.1', liquidationPx: '50', leverage: { value: 3 }, positionValue: '1000' });
t('zero-size positions filtered', eq(api.mapClearinghouse(state([rawPos('BTC', 0)]), '').length, 0));
t('main dex: coin untouched, dex empty', (() => {
  const p = api.mapClearinghouse(state([rawPos('BTC', 1)]), '')[0];
  return p.coin === 'BTC' && p.dex === '' && p.szi === 1 && p.value === 1000;
})());
t('HIP-3 bare coin gets prefixed', (() => {
  const p = api.mapClearinghouse(state([rawPos('XYZ100', -2)]), 'xyz')[0];
  return p.coin === 'xyz:XYZ100' && p.dex === 'xyz' && p.szi === -2;
})());
t('HIP-3 already-prefixed coin not double-prefixed', (() => {
  const p = api.mapClearinghouse(state([rawPos('xyz:XYZ100', 1)]), 'xyz')[0];
  return p.coin === 'xyz:XYZ100';
})());

console.log('fetchPositions (stubbed hlPost)');
{
  hlCalls = [];
  hlRoutes = {
    '':    Object.assign(state([rawPos('BTC', 1)]), { marginSummary: { accountValue: '5000' } }),
    'xyz': state([rawPos('XYZ100', 2)]),
    'abc': new Error('API 500'),
  };
  const r = await api.fetchPositions('0xdead', ['xyz', 'abc']);
  t('three calls made (main + 2 dexs)', hlCalls.length === 3);
  t('dex param present on HIP-3 calls only', hlCalls[0].dex === undefined && hlCalls[1].dex === 'xyz' && hlCalls[2].dex === 'abc');
  t('positions merged across dexs', r.positions.length === 2 && r.positions.map(p => p.coin).join(',') === 'BTC,xyz:XYZ100');
  t('failed dex skipped without sinking load', r.positions.length === 2);
  t('accountValue from main dex only', r.accountValue === 5000);
}
{
  hlRoutes = { '': new Error('API 500'), 'xyz': state([rawPos('XYZ100', 1)]) };
  const r = await api.fetchPositions('0xdead', ['xyz']);
  t('main-dex failure still yields HIP-3 positions, null accountValue', r.positions.length === 1 && r.accountValue === null);
}
{
  hlRoutes = { '': state([]) };
  const r = await api.fetchPositions('0xdead', []);
  t('no HIP-3 dexs → single call, empty ok', r.positions.length === 0 && r.accountValue === null);
}

console.log('regression: engine treats HIP-3 coins as perps');
t('isPerp("xyz:XYZ100") true, spot forms false',
  api.isPerp('xyz:XYZ100') && api.isPerp('BTC') && !api.isPerp('PURR/USDC') && !api.isPerp('@107'));
{
  const fills = [
    { coin: 'xyz:XYZ100', side: 'B', sz: '1', px: '100', startPosition: '0', time: 1000, fee: '0.1', closedPnl: '0', crossed: true, dir: 'Open Long', tid: 1, oid: 1 },
    { coin: 'xyz:XYZ100', side: 'A', sz: '1', px: '110', startPosition: '1', time: 2000, fee: '0.1', closedPnl: '10', crossed: false, dir: 'Close Long', tid: 2, oid: 2 },
  ];
  const tr = api.reconstructTrades(fills, '0xdead', 'perp');
  t('HIP-3 round trip reconstructs as one perp trade with prefixed coin',
    tr.length === 1 && tr[0].coin === 'xyz:XYZ100' && tr[0].dir === 'Long' && Math.abs(tr[0].pnl - 10) < 1e-9);
  const sp = api.reconstructTrades(fills, '0xdead', 'spot');
  t('HIP-3 fills excluded from spot reconstruction', sp.length === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
