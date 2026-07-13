// Tests for: excursion timing (#3), trade replay groundwork (#1), benchmark (#4),
// auto-refresh + automatic ratchet (#6), PWA registration (#7), attachment sync (#9).
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '..', 'ledger.html'), 'utf8');

function extractFn(name){
  const m = new RegExp('function ' + name + '\\(').exec(html);
  if (!m) throw new Error('fn not found: ' + name);
  let j = html.indexOf('{', m.index), depth = 0;
  for (let k = j; k < html.length; k++) {
    if (html[k] === '{') depth++;
    else if (html[k] === '}' && --depth === 0) return html.slice(m.index, k + 1);
  }
  throw new Error('unbalanced: ' + name);
}
const src = [
  extractFn('computeExcursion'),
  extractFn('excSummary'),
  extractFn('excVerdict'),
  extractFn('isPerp'),
  extractFn('newTrade'),
  extractFn('tallyFill'),
  extractFn('reconstructTrades'),
  extractFn('candleOpen'),
  'export { computeExcursion, excSummary, excVerdict, reconstructTrades, candleOpen };',
].join('\n');
const mod = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
const { computeExcursion, excSummary, excVerdict, reconstructTrades, candleOpen } = mod;

let pass = 0, fail = 0;
function t(name, fn){
  try { fn(); pass++; console.log('  ✓ ' + name); }
  catch (e) { fail++; console.error('  ✗ ' + name + '\n    ' + e.message); }
}
const eq = (a, b, m) => { const ja = JSON.stringify(a), jb = JSON.stringify(b);
  if (ja !== jb) throw new Error((m || 'ne') + '\n    got: ' + ja + '\n    want: ' + jb); };
const ok = (v, m) => { if (!v) throw new Error(m || 'falsy'); };
const near = (a, b, eps, m) => { if (Math.abs(a - b) > (eps ?? 1e-9)) throw new Error((m||'not near')+': '+a+' vs '+b); };

const MIN = 60e3, T0 = 1700000000000;

console.log('\nExcursion timing (#3)');
t('maeAt/mfeAt locate the extremes as fractions of the hold', () => {
  // 10-candle trade: trough in candle 2, peak in candle 7
  const candles = []; for (let i = 0; i < 10; i++) candles.push([T0 + i * MIN, 100, 100, 100]);
  candles[2] = [T0 + 2 * MIN, 100, 90, 95];   // low 90 early
  candles[7] = [T0 + 7 * MIN, 115, 100, 110]; // high 115 late
  const ex = computeExcursion({ openTime: T0, closeTime: T0 + 10 * MIN, avgEntry: 100, dir: 'Long' }, candles, MIN);
  near(ex.maePct, 10); near(ex.mfePct, 15);
  near(ex.maeAt, 0.25, 0.01, 'dip at candle 2 + half-candle offset');
  near(ex.mfeAt, 0.75, 0.01, 'peak at candle 7 + half-candle offset');
});
t('short direction flips which extreme is adverse', () => {
  const candles = []; for (let i = 0; i < 10; i++) candles.push([T0 + i * MIN, 100, 100, 100]);
  candles[2] = [T0 + 2 * MIN, 100, 90, 95];
  candles[7] = [T0 + 7 * MIN, 115, 100, 110];
  const ex = computeExcursion({ openTime: T0, closeTime: T0 + 10 * MIN, avgEntry: 100, dir: 'Short' }, candles, MIN);
  near(ex.maeAt, 0.75, 0.01, 'for a short, the high is the adverse move');
  near(ex.mfeAt, 0.25, 0.01);
});
t('zero excursion on one side → null timing for that side', () => {
  const up = [[T0, 120, 105, 110], [T0 + MIN, 130, 110, 125]];
  const ex = computeExcursion({ openTime: T0, closeTime: T0 + 2 * MIN, avgEntry: 100, dir: 'Long' }, up, MIN);
  near(ex.maePct, 0); eq(ex.maeAt, null, 'no adverse move → no adverse moment');
  ok(ex.mfeAt != null);
});
t('summary medians + verdict timing sentence (≥10 timed winners required)', () => {
  const rows = [];
  for (let i = 0; i < 12; i++) rows.push({ net: 10, maePct: 1, mfePct: 3, notional: 1000, maeAt: 0.2, mfeAt: 0.8 });
  rows.push({ net: -5, maePct: 4, mfePct: 1, notional: 1000, maeAt: 0.5, mfeAt: 0.1 });
  const s = excSummary(rows);
  near(s.medMaeAtW, 0.2); near(s.medMfeAtW, 0.8); eq(s.timedN, 12);
  const v = excVerdict(s).join('|');
  ok(v.includes('worst dip <b>20%</b>'));
  ok(v.includes('peaks at <b>80%</b>'));
  ok(v.includes('dip-early-run-late'));
});
t('legacy ratchet rows without timing degrade gracefully', () => {
  const rows = Array.from({ length: 15 }, () => ({ net: 10, maePct: 1, mfePct: 3, notional: 1000 }));
  const s = excSummary(rows);
  eq(s.medMaeAtW, null); eq(s.timedN, 0);
  ok(!excVerdict(s).join('|').includes('Timing:'), 'no timing sentence without data');
});
t('timing persists through the ratchet and reuse path', () => {
  ok(html.includes('maeAt:ex.maeAt!=null?ex.maeAt:null, mfeAt:ex.mfeAt!=null?ex.mfeAt:null,'));
  ok(html.includes('maeAt:p.maeAt!=null?p.maeAt:null,mfeAt:p.mfeAt!=null?p.mfeAt:null'));
});

console.log('\nTrade replay (#1)');
t('candles now carry close AND open; midpoint fallback lives in candleOpen', () => {
  ok(html.includes('out.push([+r.t,parseFloat(r.h),parseFloat(r.l),parseFloat(r.c),parseFloat(r.o)]);'));
  ok(html.includes('function candleOpen(candles,i)'));
});
t('replay button, container, delegate, and toggle-off present', () => {
  ok(html.includes('data-replay="${t.id}"'));
  ok(html.includes('<div id="replay-${t.id}"></div>'));
  ok(html.includes("openReplay(rp.dataset.replay,rp)"));
  ok(html.includes('if(_replayFor===id&&_replayChart){'));
});
t('replay uses cache-aware per-trade fetch with coarser fallback', () => {
  ok(html.includes('async function ensureTradeCandles(t)'));
  ok(html.includes('for(let pass=0;pass<3;pass++){'));
});

console.log('\nBenchmark (#4)');
t('BTC + HYPE daily candles via the shared cache; avg-notional approximation stated', () => {
  ok(html.includes("for(const coin of ['BTC','HYPE'])"));
  ok(html.includes("excKey(coin,'1d')"));
  ok(html.includes('AVERAGE deployed notional (a stated approximation'));
  ok(html.includes('renderBenchmark(closed);'));
});
t('benchmark never breaks the diagnostic', () =>
  ok(html.includes('/* benchmark is a bonus — never break the diagnostic over it */')));

console.log('\nAuto-refresh + automatic ratchet (#6)');
t('loadAll guarded against overlap and triggers the ratchet', () => {
  ok(html.includes('if(_loading)return; _loading=true; try{'));
  ok(html.includes('} finally { _loading=false; }\n  autoRatchet();'));
});
t('auto-ratchet: recent unmeasured closed trades only, silent, budget-safe', () => {
  ok(html.includes('t.closeTime>now-21*86400e3&&!have[t.id]'));
  ok(html.includes('const out=await runExcursions(recent,[]);'));
  ok(html.includes('/* budget guard or transient — the manual button still works */'));
});
t('3-minute visible-tab interval, persisted toggle, boot wiring', () => {
  ok(html.includes('},180000);'));
  ok(html.includes("document.visibilityState!=='visible'"));
  ok(html.includes('settings.autoRefresh=!(settings.autoRefresh!==false);'));
  ok(html.includes('setupAutoRefresh();\n})();'));
});

console.log('\nPWA (#7) + attachment sync (#9)');
t('service worker + manifest registered only in server mode', () => {
  ok(html.includes("navigator.serviceWorker.register('/sw.js')"));
  ok(html.includes("l.href='/manifest.webmanifest'"));
});
t('attachments sync up on add/remove and down on empty-local open', () => {
  ok(html.includes('loadAttachments(id); syncAttUp(id); }'));
  ok(html.includes('const dl=await syncAttDown(id); if(dl)arr=dl;'));
  ok(html.includes("srvFetch('/api/att/'+_attKey(id)"));
});

console.log('\nReplay candlesticks: fill events + candle opens (#1)');
const mkFill = (time, side, sz, startPosition, px) => ({ time, side, sz: String(sz),
  startPosition: String(startPosition), px: String(px), fee: '0', closedPnl: '0', coin: 'ETH', crossed: true });
t('entry / add / partial close / exit fills are logged with time, px, size and side', () => {
  const fills = [
    mkFill(T0 + 0 * MIN, 'B', 2, 0, 100),   // entry long 2
    mkFill(T0 + 1 * MIN, 'B', 1, 2, 101),   // add 1
    mkFill(T0 + 2 * MIN, 'A', 1, 3, 103),   // partial close 1
    mkFill(T0 + 3 * MIN, 'A', 2, 2, 104),   // final close 2
  ];
  const [tr] = reconstructTrades(fills, 'addr', 'perp');
  eq(tr.events, [
    [T0 + 0 * MIN, 100, 2, 1],
    [T0 + 1 * MIN, 101, 1, 1],
    [T0 + 2 * MIN, 103, 1, -1],
    [T0 + 3 * MIN, 104, 2, -1],
  ]);
  ok(!tr.isOpen, 'trade closed');
});
t('a flip fill logs the closing portion on the old trade and the opening portion on the new one', () => {
  const fills = [
    mkFill(T0 + 0 * MIN, 'B', 2, 0, 100),    // long 2
    mkFill(T0 + 1 * MIN, 'A', 5, 2, 102),    // sell 5: closes 2, opens short 3
    mkFill(T0 + 2 * MIN, 'B', 3, -3, 101),   // buy back 3
  ];
  const trades = reconstructTrades(fills, 'addr', 'perp').sort((a, b) => a.openTime - b.openTime);
  eq(trades[0].events, [[T0, 100, 2, 1], [T0 + MIN, 102, 2, -1]], 'long: entry 2, close 2');
  eq(trades[1].events, [[T0 + MIN, 102, 3, 1], [T0 + 2 * MIN, 101, 3, -1]], 'short seeded by the flip remainder');
});
t('open trades keep their event log too', () => {
  const fills = [mkFill(T0, 'B', 2, 0, 100), mkFill(T0 + MIN, 'B', 1, 2, 101)];
  const [tr] = reconstructTrades(fills, 'addr', 'perp');
  ok(tr.isOpen);
  eq(tr.events, [[T0, 100, 2, 1], [T0 + MIN, 101, 1, 1]]);
});
t('candleOpen: stored open wins, prev close backfills old rows, first row falls back to its own close', () => {
  const cs = [
    [T0, 105, 95, 100],            // old 4-element cache row, no open
    [T0 + MIN, 106, 99, 104],      // old row -> open = prev close 100
    [T0 + 2 * MIN, 107, 103, 106, 104.5], // new 5-element row -> stored open
  ];
  near(candleOpen(cs, 0), 100, 1e-12, 'first row: own close');
  near(candleOpen(cs, 1), 100, 1e-12, 'prev close is the open on a continuous perp');
  near(candleOpen(cs, 2), 104.5, 1e-12, 'stored open used when present');
});
t('replay chart renders candlestick bars and fill markers, not the old band/dip-peak', () => {
  ok(html.includes("wick.push({x:k[0],y:[k[2],k[1]]})"), 'wick dataset built from low..high');
  ok(html.includes("body.push({x:k[0],y:[Math.min(o,c),Math.max(o,c)]})"), 'body dataset built from open..close');
  ok(html.includes("pointStyle:'triangle'"), 'fill markers are triangles');
  ok(!html.includes("lbl:'worst dip'"), 'dip/peak markers removed from the replay chart');
  ok(html.includes('\\u25b2 = entry / add fill'), 'caption documents the new markers');
});
t('y-axis is pinned to the price range — bar datasets must not drag it to zero', () => {
  ok(html.includes('y:{min:ylo,max:yhi,beginAtZero:false'), 'explicit y min/max on the replay chart');
  ok(html.includes('const ypad=(yhi-ylo)*0.08'), 'padded from the computed extremes');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
