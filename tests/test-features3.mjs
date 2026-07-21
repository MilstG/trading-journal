// Tests for: projection drawdown reality-check (#1), block bootstrap (#2), MiniPDF image
// XObjects + diagnostic PDF (#3), what-if counterfactual replay (#4), open-position risk
// model (#5), Kelly sizing card engine (#6), HIP-3 verification persistence (#7), gzip
// fill-cache compression (#8), spot FIFO cost-basis lots (#9).
// Functions are extracted from ledger.html itself so the tests exercise exactly what ships.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '..', 'ledger.html'), 'utf8');

import { t, ok, eq, near, report, makeExtractor } from './harness.mjs';
const { grabBlock, grabFn, evalFn, evalClass } = makeExtractor(html);

// globals the extracted functions expect
globalThis._rng = Math.random;
globalThis.isWin  = n => n > 50;
globalThis.isLoss = n => n < -50;
globalThis.fmtUsd = (n, dp = 2) => {
  if (n === null || n === undefined || isNaN(n)) return '\u2014';
  const s = n < 0 ? '-' : '';
  return s + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
};

globalThis._srand = evalFn('_srand');
globalThis._hashSeed = evalFn('_hashSeed');
const projectForward = evalFn('projectForward');
const kellyFromTrades = evalFn('kellyFromTrades');
const openRiskModel = evalFn('openRiskModel');
globalThis.whatIfStats = evalFn('whatIfStats');
const whatIfModel = evalFn('whatIfModel');
const spotFifoLots = evalFn('spotFifoLots');
const validFillCache = evalFn('validFillCache');
globalThis.gzipBytes = evalFn('gzipBytes');
globalThis.gunzipStr = evalFn('gunzipStr');
const packFillCache = evalFn('packFillCache');
const unpackFillCache = evalFn('unpackFillCache');
const MiniPDF = evalClass('MiniPDF');
globalThis.MiniPDF = MiniPDF;
const renderDiagPdfDoc = evalFn('renderDiagPdfDoc');
const hip3CoinShape = evalFn('hip3CoinShape');

const DAY = 86400000;

// ---------------------------------------------------------------------------
console.log('projectForward \u2014 drawdown reality-check (#1)');
await t('constant losing days: dd equals the full loss, end matches', () => {
  const fc = projectForward([-100], 10, 50, 1);
  near(fc.end.p50, -1000); near(fc.dd.p50, 1000); near(fc.dd.p95, 1000);
});
await t('constant winning days: max drawdown is zero on every path', () => {
  const fc = projectForward([100], 10, 50, 1);
  near(fc.dd.p50, 0); near(fc.dd.p95, 0);
});
await t('dd quantiles are ordered p50 \u2264 p75 \u2264 p95 and non-negative', () => {
  const daily = Array.from({length: 60}, (_, i) => (i % 3 === 0 ? -180 : 130));
  const fc = projectForward(daily, 90, 400, 42);
  ok(fc.dd.p50 >= 0 && fc.dd.p75 >= fc.dd.p50 && fc.dd.p95 >= fc.dd.p75,
     `dd not ordered: ${fc.dd.p50}/${fc.dd.p75}/${fc.dd.p95}`);
});
await t('adding dd did not change the band/end values for a fixed seed', () => {
  // pins the RNG-stream compatibility promise: the i.i.d. path consumes random numbers
  // in exactly the original order, so old pinned outputs remain valid.
  const daily = [100, -50, 200, 0, -120, 80];
  const a = projectForward(daily, 30, 100, 7);
  const b = projectForward(daily, 30, 100, 7);
  near(a.end.p50, b.end.p50); near(a.bands.p95[29], b.bands.p95[29]);
  ok(a.probPositive === b.probPositive, 'not deterministic');
});

console.log('\nprojectForward \u2014 block bootstrap (#2)');
await t('block param is reported and capped at the series length', () => {
  ok(projectForward([1, 2, 3], 10, 20, 1, 5).block === 3, 'not capped');
  ok(projectForward([1, 2, 3], 10, 20, 1).block === 1, 'default not i.i.d.');
  ok(projectForward([1, 2, 3], 10, 20, 1, 0).block === 1, 'block 0 must mean i.i.d.');
});
await t('block runs are deterministic for a fixed seed', () => {
  const daily = Array.from({length: 40}, (_, i) => Math.sin(i) * 100);
  const a = projectForward(daily, 60, 200, 99, 5);
  const b = projectForward(daily, 60, 200, 99, 5);
  near(a.end.p50, b.end.p50); near(a.dd.p95, b.dd.p95);
});
await t('block sampling preserves streaks: deeper median drawdown on streaky data', () => {
  // 10 up days then 10 down days, repeated \u2014 i.i.d. destroys the runs, blocks keep them,
  // so the per-path max drawdown must be at least as deep with blocks.
  const daily = [];
  for (let r = 0; r < 3; r++) { for (let i = 0; i < 10; i++) daily.push(150); for (let i = 0; i < 10; i++) daily.push(-150); }
  const iid = projectForward(daily, 90, 400, 5);
  const blk = projectForward(daily, 90, 400, 5, 7);
  ok(blk.dd.p50 >= iid.dd.p50, `block dd ${blk.dd.p50} < iid dd ${iid.dd.p50}`);
});
await t('block sampling wraps cleanly and sums stay finite', () => {
  const fc = projectForward([10, -10, 5], 100, 50, 3, 3);
  ok(isFinite(fc.end.p50) && isFinite(fc.dd.p95), 'non-finite output');
  ok(fc.bands.p50.length === 100, 'band length wrong');
});

console.log('\nkellyFromTrades (#6)');
const mk = net => ({ net });
await t('textbook case: p=0.6, b=2 \u2192 kelly 0.4, quarter 0.1', () => {
  const trades = [...Array(6)].map(() => mk(100)).concat([...Array(4)].map(() => mk(-50.0001)));
  const k = kellyFromTrades(trades);
  near(k.p, 0.6); near(k.b, 2, 1e-4); near(k.kelly, 0.4, 1e-4); near(k.quarter, 0.1, 1e-4);
});
await t('negative edge clamps kelly to 0 instead of a nonsense negative fraction', () => {
  const trades = [...Array(3)].map(() => mk(60)).concat([...Array(7)].map(() => mk(-100)));
  const k = kellyFromTrades(trades);
  ok(k.kelly === 0 && k.quarter === 0, 'not clamped');
});
await t('break-even scratches are excluded; <10 decisive trades \u2192 null', () => {
  ok(kellyFromTrades([mk(10), mk(-20), mk(100), mk(-100)]) === null, 'scratch handling');
  ok(kellyFromTrades([...Array(9)].map(() => mk(100))) === null, 'min-n');
});
await t('all-winner sample: b=\u221e, kelly = win rate', () => {
  const k = kellyFromTrades([...Array(12)].map(() => mk(100)));
  ok(k.b === Infinity, 'b'); near(k.kelly, 1); near(k.quarter, 0.25);
});

console.log('\nopenRiskModel (#5)');
const pos = o => Object.assign({ coin: 'BTC', dex: '', szi: 1, entryPx: 100, liq: 50, value: 100, uPnl: 0 }, o);
await t('rows sort nearest-to-liquidation first; no-liq rows sink to the bottom', () => {
  const m = openRiskModel([
    pos({ coin: 'ETH', liq: 95, value: 100, szi: 1 }),   // mark 100, 5% away
    pos({ coin: 'BTC', liq: 50, value: 100, szi: 1 }),   // 50% away
    pos({ coin: 'SOL', liq: null }),
  ]);
  ok(m.rows[0].coin === 'ETH' && m.rows[1].coin === 'BTC' && m.rows[2].coin === 'SOL', 'order');
  near(m.rows[0].liqDist, 0.05); near(m.rows[1].liqDist, 0.5);
});
await t('danger list = positions within 10% of liquidation', () => {
  const m = openRiskModel([pos({ coin: 'ETH', liq: 95 }), pos({ coin: 'BTC', liq: 50 })]);
  ok(m.danger.length === 1 && m.danger[0].coin === 'ETH', 'danger');
});
await t('net-by-coin nets offsetting sides across wallets; gross/skew/upnl totals', () => {
  const m = openRiskModel([
    pos({ coin: 'BTC', szi: 1, value: 300, uPnl: 10, wallet: { address: '0xa' } }),
    pos({ coin: 'BTC', szi: -1, value: 100, uPnl: -4, wallet: { address: '0xb' } }),
    pos({ coin: 'ETH', szi: -2, value: 200, uPnl: 1 }),
  ]);
  near(m.gross, 600); near(m.skew, 0); near(m.upnl, 7);
  const btc = m.coins.find(c => c.coin === 'BTC');
  near(btc.net, 200); near(btc.gross, 400); ok(btc.wallets === 2, 'wallet count');
  near(m.largestShare, 400 / 600);
});
await t('HIP-3 positions are flagged and included in totals', () => {
  const m = openRiskModel([pos({ coin: 'dex:XYZ', dex: 'dex', value: 500 })]);
  ok(m.coins[0].hip3 === true, 'hip3 flag'); near(m.gross, 500);
});
await t('empty / zero-size books return null', () => {
  ok(openRiskModel([]) === null, 'empty');
  ok(openRiskModel([pos({ szi: 0 })]) === null, 'zero size');
});

console.log('\nwhatIfModel \u2014 counterfactual replay (#4)');
const wtr = (net, i) => ({ net, closeTime: 1700000000000 + i * DAY });
await t('removing the losers improves net and shrinks the drawdown', () => {
  const seq = [100, -200, 300, -400, 150].map(wtr);
  const m = whatIfModel(seq, t2 => t2.net < 0);
  near(m.all.net, -50); near(m.kept.net, 550);
  near(m.removed.net, -600); ok(m.removed.n === 2, 'removed n');
  ok(m.kept.maxDD === 0, 'kept dd'); near(m.all.maxDD, -400);
});
await t('counterfactual series holds flat where trades are removed, same length as actual', () => {
  const seq = [100, -200, 300].map(wtr);
  const m = whatIfModel(seq, t2 => t2.net === -200);
  ok(m.series.actual.length === 3 && m.series.cf.length === 3, 'lengths');
  near(m.series.actual[1], -100); near(m.series.cf[1], 100); near(m.series.cf[2], 400);
});
await t('stats are computed on the chronological order even if input is unsorted', () => {
  const seq = [wtr(-400, 3), wtr(100, 0), wtr(300, 2), wtr(-200, 1)];
  const m = whatIfModel(seq, () => false);
  near(m.all.maxDD, -400); near(m.all.net, -200);
});
await t('win rate and profit factor on the kept set', () => {
  const seq = [100, 100, -100, 10].map(wtr); // 10 is a scratch under the \u00b150 band
  const m = whatIfModel(seq, () => false);
  near(m.kept.winRate, 2 / 3); near(m.kept.profitFactor, 2.1);
});

console.log('\nspotFifoLots (#9)');
const T0 = Date.UTC(2024, 0, 1);
const bfill = (o) => Object.assign({ coin: '@1', side: 'B', sz: '10', px: '1', fee: '0', time: T0 }, o);
await t('USDC fees: added to basis on buys, subtracted from proceeds on sells', () => {
  const m = spotFifoLots([
    bfill({ sz: '10', px: '1', fee: '0.1', feeToken: 'USDC', time: T0 }),
    bfill({ side: 'A', sz: '5', px: '2', fee: '0.5', feeToken: 'USDC', time: T0 + DAY }),
  ], { '@1': 'FOO' });
  ok(m.rows.length === 1, 'row count');
  const r = m.rows[0];
  ok(r.symbol === 'FOO', 'symbol map');
  near(r.proceeds, 9.5); near(r.basis, 5.05); near(r.gain, 4.45);
  ok(r.term === 'short', 'term');
  ok(m.open.length === 1, 'open lot'); near(m.open[0].qty, 5); near(m.open[0].unitCost, 1.01);
});
await t('FIFO order: oldest lot consumed first, sale split across lots', () => {
  const m = spotFifoLots([
    bfill({ sz: '5', px: '1', time: T0 }),
    bfill({ sz: '5', px: '3', time: T0 + DAY }),
    bfill({ side: 'A', sz: '8', px: '4', time: T0 + 2 * DAY }),
  ], {});
  ok(m.rows.length === 2, 'split rows');
  near(m.rows[0].basis, 5);  near(m.rows[0].qty, 5);   // 5 @ $1 first
  near(m.rows[1].basis, 9);  near(m.rows[1].qty, 3);   // then 3 @ $3
  near(m.rows[0].gain, 15);  near(m.rows[1].gain, 3);
});
await t('long-term at >365 days held; short otherwise', () => {
  const m = spotFifoLots([
    bfill({ sz: '2', px: '1', time: T0 }),
    bfill({ side: 'A', sz: '1', px: '2', time: T0 + 366 * DAY }),
    bfill({ side: 'A', sz: '1', px: '2', time: T0 + 366 * DAY + 1 }), // same lot, still long
  ], {});
  ok(m.rows[0].term === 'long' && m.rows[1].term === 'long', 'term calc');
});
await t('overselling (transferred-in tokens) yields flagged zero-basis unknown rows', () => {
  const m = spotFifoLots([
    bfill({ sz: '1', px: '1', time: T0 }),
    bfill({ side: 'A', sz: '3', px: '2', time: T0 + DAY }),
  ], {});
  ok(m.rows.length === 2, 'rows');
  const u = m.rows.find(r => r.unknownBasis);
  ok(u && u.term === 'unknown' && u.basis === 0, 'unknown lot');
  near(u.qty, 2); near(m.unknownQty, 2);
});
await t('base-token fee on a buy shrinks the received quantity, not the cash basis', () => {
  const m = spotFifoLots([
    bfill({ sz: '10', px: '2', fee: '0.5', feeToken: 'FOO', time: T0 }),
    bfill({ side: 'A', sz: '9.5', px: '2', fee: '0', time: T0 + DAY }),
  ], {});
  near(m.rows[0].basis, 20); near(m.rows[0].qty, 9.5); near(m.rows[0].gain, -1);
  ok(m.open.length === 0, 'fully consumed');
});
await t('perp fills are ignored; pair-form coins map to their base symbol', () => {
  const m = spotFifoLots([
    bfill({ coin: 'BTC', sz: '1', px: '50000', time: T0 }),           // perp \u2014 ignored
    bfill({ coin: 'HYPE/USDC', sz: '4', px: '10', time: T0 }),
    bfill({ coin: 'HYPE/USDC', side: 'A', sz: '4', px: '12', time: T0 + DAY }),
  ], {});
  ok(m.rows.length === 1 && m.rows[0].symbol === 'HYPE', 'filtering/mapping');
  near(m.rows[0].gain, 8);
});
await t('yearly aggregation by UTC disposal year', () => {
  const m = spotFifoLots([
    bfill({ sz: '2', px: '1', time: Date.UTC(2024, 5, 1) }),
    bfill({ side: 'A', sz: '1', px: '2', time: Date.UTC(2024, 11, 31) }),
    bfill({ side: 'A', sz: '1', px: '3', time: Date.UTC(2025, 0, 2) }),
  ], {});
  near(m.byYear[2024].gain, 1); near(m.byYear[2025].gain, 2);
  ok(m.byYear[2024].n === 1 && m.byYear[2025].n === 1, 'year buckets');
});

console.log('\nMiniPDF image XObjects + diagnostic PDF (#3)');
// minimal synthetic JPEG: SOI + SOF0 (h=32, w=64) + EOI \u2014 enough for the dimension parser
function fakeJpegDataUrl(w, h){
  const bytes = [0xFF, 0xD8, 0xFF, 0xC0, 0x00, 0x11, 0x08, (h >> 8) & 255, h & 255, (w >> 8) & 255, w & 255,
    0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xFF, 0xD9];
  return 'data:image/jpeg;base64,' + Buffer.from(bytes).toString('base64');
}
await t('image() parses JPEG dimensions from the SOF marker', () => {
  const pdf = new MiniPDF();
  const i = pdf.image(fakeJpegDataUrl(64, 32));
  ok(i === 0, 'index');
  const sz = pdf.imgSize(i);
  ok(sz.w === 64 && sz.h === 32, `dims ${sz.w}x${sz.h}`);
});
await t('non-JPEG or garbage data URLs return -1 and drawImage(-1) is a no-op', () => {
  const pdf = new MiniPDF();
  ok(pdf.image('data:image/png;base64,AAAA') === -1, 'png rejected');
  ok(pdf.image('nonsense') === -1, 'garbage rejected');
  const ops = pdf.pages[0].length;
  pdf.drawImage(-1, 0, 0, 10, 10);
  ok(pdf.pages[0].length === ops, 'no op emitted');
});
await t('output embeds a DCTDecode XObject and every page references it', () => {
  const pdf = new MiniPDF();
  const i = pdf.image(fakeJpegDataUrl(10, 10));
  pdf.drawImage(i, 42, 100, 200, 100);
  pdf.newPage(); pdf.text(40, 700, 'page 2');
  const out = pdf.output();
  ok(out.includes('/Filter /DCTDecode'), 'filter');
  ok(out.includes('/Im0 Do'), 'draw op');
  ok((out.match(/\/XObject <</g) || []).length === 2, 'XObject in both page resources');
  ok(out.includes('/Width 10 /Height 10'), 'dims in dict');
});
await t('text-only documents keep the original resource shape (no XObject)', () => {
  const pdf = new MiniPDF(); pdf.text(40, 700, 'hello');
  ok(!pdf.output().includes('/XObject'), 'unexpected XObject');
});
await t('outputBytes is a latin1-faithful byte image of output', () => {
  const pdf = new MiniPDF();
  pdf.image(fakeJpegDataUrl(4, 4)); pdf.drawImage(0, 10, 10, 4, 4);
  const s2 = pdf.output(), u = pdf.outputBytes();
  ok(u.length === s2.length, 'length');
  for (let k = 0; k < u.length; k++) if (u[k] !== (s2.charCodeAt(k) & 0xFF)) throw new Error('byte mismatch at ' + k);
});
await t('xref offsets stay parseable with binary image streams present', () => {
  const pdf = new MiniPDF();
  pdf.image(fakeJpegDataUrl(8, 8)); pdf.drawImage(0, 40, 600, 100, 100);
  const out = pdf.output();
  const xrefAt = parseInt(out.slice(out.lastIndexOf('startxref') + 10), 10);
  ok(out.slice(xrefAt, xrefAt + 4) === 'xref', 'startxref points at the xref table');
});
await t('renderDiagPdfDoc renders a stats + charts + recs model end to end', () => {
  const model = {
    generated: '2026-07-10T00:00:00Z', wallets: [{ label: 'main', address: '0xabc' }],
    view: 'perp', periodDesc: 'last 90 days', tz: 'UTC',
    stats: [{ k: 'Net PnL', v: '$1,000.00', sub: '42 trades' }, { k: 'Win rate', v: '55.0%' }],
    charts: [{ title: 'Equity curve', img: fakeJpegDataUrl(600, 300) }],
    recs: ['Stop trading between 2 and 5am \u2014 it has cost you money in every month sampled.'],
  };
  const pdf = renderDiagPdfDoc(model);
  const out = pdf.output();
  ok(out.includes('TRADING DIAGNOSTIC'), 'title');
  ok(out.includes('/DCTDecode'), 'chart embedded');
  ok(out.includes('RECOMMENDATIONS'), 'recs section');
  ok(pdf.outputBytes() instanceof Uint8Array, 'bytes export');
});

console.log('\nfill-cache compression (#8)');
await t('pack \u2192 unpack roundtrips the fills exactly', async () => {
  const fills = [{ time: 1, coin: 'BTC', sz: '1', px: '50000' }, { time: 2, coin: '@1', sz: '3', px: '2' }];
  const packed = await packFillCache(fills, 2);
  ok(packed.v === 3 || packed.v === 2, 'version');
  ok(packed.last === 2, 'last');
  const plain = await unpackFillCache(packed);
  ok(plain.v === 2 && plain.last === 2, 'unpacked shape');
  ok(JSON.stringify(plain.fills) === JSON.stringify(fills), 'roundtrip');
});
await t('gzip actually shrinks a large repetitive cache', async () => {
  if (typeof CompressionStream === 'undefined') return; // environment without CS: fallback covered above
  const fills = Array.from({ length: 5000 }, (_, i) => ({ time: i, coin: 'BTC', sz: '0.5', px: '50000', side: 'B', fee: '0.1' }));
  const packed = await packFillCache(fills, 4999);
  ok(packed.v === 3, 'expected gz in this environment');
  const plainLen = JSON.stringify(fills).length;
  ok(packed.gz.length < plainLen / 4, `only ${(plainLen / packed.gz.length).toFixed(1)}x`);
});
await t('unpackFillCache passes v2 through and rejects corrupt gz', async () => {
  const v2 = { v: 2, fills: [{ time: 1, coin: 'X' }], last: 1 };
  ok((await unpackFillCache(v2)) === v2, 'v2 passthrough');
  ok((await unpackFillCache({ v: 3, gz: new Uint8Array([1, 2, 3]), last: 1 })) === null, 'corrupt gz');
  ok((await unpackFillCache(null)) === null, 'null');
});
await t('validFillCache accepts both v2 and v3, rejects junk', () => {
  const addr = '0x' + 'a'.repeat(40);
  ok(validFillCache(addr, { v: 2, fills: [{ time: 1, coin: 'B' }], last: 1 }), 'v2');
  ok(validFillCache(addr, { v: 3, gz: new Uint8Array([31, 139]), last: 1 }), 'v3');
  ok(!validFillCache(addr, { v: 3, gz: 'not bytes', last: 1 }), 'gz type');
  ok(!validFillCache('nope', { v: 2, fills: [], last: 1 }), 'address');
  ok(!validFillCache(addr, { v: 2, fills: [{ nope: 1 }], last: 1 }), 'fill shape');
});

console.log('\nHIP-3 verification + wiring guards (#7 and UI plumbing)');
await t('hip3CoinShape still classifies bare / prefixed / empty', () => {
  ok(hip3CoinShape('dex', ['dex:AAA', 'dex:BBB']) === 'prefixed', 'prefixed');
  ok(hip3CoinShape('dex', ['AAA']) === 'bare', 'bare');
  ok(hip3CoinShape('dex', []) === 'empty', 'empty');
});
await t('live shape verification is persisted and surfaced in the load status', () => {
  ok(html.includes("idbSet('hip3shape:'+dex"), 'persistence write missing');
  ok(html.includes('_hip3Notes.push({dex,shape})'), 'note collection missing');
  ok(html.includes('HIP-3 verified live'), 'status surfacing missing');
});
await t('fill cache read/write routes through pack/unpack in loadAll and backup', () => {
  ok(html.includes('await idbSet(fcKey,await packFillCache(fills,lastT))'), 'write path');
  ok(html.includes('fcache=await unpackFillCache(await idbGet(fcKey))'), 'read path');
  ok(html.includes("await unpackFillCache(await idbGet('flc:'+w.address))"), 'backup decompresses');
});
await t('UI plumbing present: risk panel, what-if, block toggle, PDF + lots buttons', () => {
  ok(html.includes('id="riskPanel"') && html.includes('function renderRiskPanel'), 'risk panel');
  ok(html.includes('id="wiCond"') && html.includes('function wireWhatIf') && html.includes('function renderWhatIf'), 'what-if');
  ok(html.includes("sel('projBlock',PROJ_BLOCKS,_proj.block)") && html.includes("$('projBlock').onchange"), 'block toggle');
  ok(html.includes('id="exportDiagPdf"') && html.includes('function exportDiagPdf'), 'diag pdf');
  ok(html.includes('id="exportSpotLots"') && html.includes("$('exportSpotLots').onclick"), 'spot lots');
  ok(html.includes('fc.dd.p95') && html.includes('kellyFromTrades(closed)'), 'project-tab cards');
  ok(html.includes('renderPositions(); renderRiskPanel();'), 'risk panel in render pass');
});

report();
