// Fills the exchange no longer serves. Hyperliquid keeps TWAP slice fills for about three months
// and the newest-2,000 endpoint saw only the tail of them; a wallet that TWAPs out of positions
// had its exits — and their P&L — vanish, and the next entry was welded onto the trade that had
// in fact already closed. Pinned here: the by-time TWAP paging (resume at the boundary, dedupe,
// fallback), the seams reconstructTrades now finds (closed, shrunk, grown or flipped off the
// record), what each does to the trade, and the coverage figures the data-health strip shows.
import vm from 'node:vm';
import { t, ok, eq, near, report, makeExtractor } from './harness.mjs';
import { readAppSource } from '../app-source.js';

const html = readAppSource(new URL('../ledger.html', import.meta.url).pathname);
const { grabFn } = makeExtractor(html);
const ctx = { Math, Object, Array, String, Number, JSON, isFinite, Date, Set, Map, Float64Array, parseFloat, console,
  setTimeout, Promise, Error, setStatus(){}, _fetchHealth: { funding: false, ledger: false, twap: false } };
vm.createContext(ctx);
vm.runInContext('const sleep=ms=>new Promise(r=>setTimeout(r,0));\n' +
  ['isPerp', 'newTrade', 'tallyFill', 'reconstructTrades', 'attributeFunding', 'coverageOf', 'dedupeFills', 'fetchAllFills', 'fetchTwapFills'].map(grabFn).join('\n'), ctx);

const T0 = Date.UTC(2026, 5, 1);
let tid = 0;
// a perp fill as the API shapes it; startPosition is the exchange's own position before the fill
const F = (coin, side, sz, px, time, start, closedPnl = 0, fee = 0) =>
  ({ coin, side, sz: String(sz), px: String(px), time, startPosition: String(start), closedPnl: String(closedPnl), fee: String(fee), feeToken: 'USDC', tid: ++tid, oid: ++tid, crossed: true, dir: side === 'B' ? 'Open Long' : 'Close Long', hash: '0x1' });
const perp = fills => ctx.attributeFunding(ctx.reconstructTrades(fills, '0xw', 'perp'), []);

console.log('\nOne fill served at two granularities');
t('a combined fill and its pieces: the pieces go, touching pieces stay, other orders and other ms are untouched', () => {
  const oid = 5000, T = T0 + 60e3;
  const agg = Object.assign(F('kBONK', 'A', 180995, 0.00002, T, 22967667), { oid, tid: 'agg' });
  const piece = Object.assign(F('kBONK', 'A', 100709, 0.00002, T, 22887381), { oid, tid: 'p2' }); // 22967667−80286: the second piece
  const other = Object.assign(F('kBONK', 'A', 500, 0.00002, T, 22786672), { oid: oid + 1 }); // another order, same ms
  const twapA = Object.assign(F('ETH', 'B', 0.34, 2500, T + 1, 10), { oid: 7 }), twapB = Object.assign(F('ETH', 'B', 0.34, 2500, T + 1, 10.34), { oid: 7 }); // one slice in two touching fills
  const spotA = Object.assign(F('@107', 'B', 0.34, 37.2, T + 2, 27070.1199), { oid: 9 }), spotB = Object.assign(F('@107', 'B', 0.34, 37.2, T + 2, 27070.4597), { oid: 9 }); // the fee in the token bought shifts the start a hair
  const input = [piece, agg, other, twapA, twapB, spotA, spotB];
  const out = ctx.dedupeFills(input);
  eq(out.map(f => f.tid), [agg.tid, other.tid, twapA.tid, twapB.tid, spotA.tid, spotB.tid], 'only the covered piece is dropped; order kept');
  ok(ctx.dedupeFills([agg]) .length === 1 && ctx.dedupeFills([]).length === 0);
  // the pieces alone (older than the API serves) all stay: nothing combined to cover them
  const p1 = Object.assign(F('kBONK', 'A', 80286, 0.00002, T, 22967667), { oid, tid: 'p1' });
  eq(ctx.dedupeFills([p1, piece]).length, 2);
  // and the chain reads clean with the piece gone: no seam where the double count used to put one
  const before = F('kBONK', 'B', 22967667, 0.00002, T - 1000, 0);
  const seams = tr => tr.reduce((n, t) => n + (t.gaps || 0), 0);
  ok(seams(perp([before, agg, piece])) > 0, 'with the piece the position jumps'); eq(seams(perp(ctx.dedupeFills([before, agg, piece]))), 0);
});

console.log('\nSeams in the fills');
t('a position closed off the record ends its trade there; the next entry is a trade of its own', () => {
  const tr = perp([
    F('ETH', 'B', 10, 1000, T0, 0),               // open 10
    // 10 ETH TWAPed out here — those slices are gone from the API
    F('ETH', 'B', 2, 1200, T0 + 3600e3, 0),       // a fresh long from flat
    F('ETH', 'A', 2, 1300, T0 + 7200e3, 2, 200),  // closed: +200
  ]).sort((a, b) => a.openTime - b.openTime);
  eq(tr.length, 2);
  const [old, fresh] = tr;
  ok(old.offRecord && !old.isOpen, 'the first trade is closed, off the record');
  eq([old.gaps, old.gapSz, old.gapNotional], [1, 10, 12000], 'one seam of 10 ETH, valued at the next known price');
  eq(old.gapTimes, [T0 + 3600e3]);
  eq(old.closeTime, T0, 'it ends where its last known fill left it');
  ok(!fresh.offRecord && !fresh.partialHistory, 'the fresh trade is whole');
  near(fresh.net, 200); eq(fresh.openSz, 2);
});
t('shrunk off the record: the trade goes on, flagged — its P&L is incomplete', () => {
  const tr = perp([
    F('SOL', 'B', 100, 10, T0, 0),
    F('SOL', 'A', 30, 12, T0 + 1e6, 30, 60),       // 70 left off the record before this close of the last 30
  ]);
  eq(tr.length, 1); const [x] = tr;
  ok(x.offRecord && !x.isOpen, 'closed, incomplete'); eq(x.gaps, 1); eq(x.gapSz, 70);
  near(x.pnl, 60, 1e-9, 'the served close still carries the exchange’s own closedPnl');
});
t('grown off the record: only the entry is unknown — partial history, result kept', () => {
  const tr = perp([
    F('BTC', 'B', 1, 50000, T0, 0),
    F('BTC', 'A', 3, 51000, T0 + 1e6, 3, 1500),    // 2 more were bought in fills we never saw
  ]);
  eq(tr.length, 1); const [x] = tr;
  ok(!x.offRecord, 'nothing closed off the record'); ok(x.partialHistory, 'the entry can’t be trusted'); eq(x.gaps, 1);
  near(x.net, 1500);
});
t('flipped off the record: the long ends, a short of the held side begins with partial history', () => {
  const tr = perp([
    F('HYPE', 'B', 100, 40, T0, 0),
    F('HYPE', 'A', 50, 45, T0 + 1e6, -200),        // the position is -200 now: it closed and went short unseen
    F('HYPE', 'B', 250, 44, T0 + 2e6, -250, 300),  // covers the short
  ]).sort((a, b) => a.openTime - b.openTime);
  eq(tr.length, 2);
  eq(tr[0].dir, 'Long'); ok(tr[0].offRecord && !tr[0].isOpen);
  eq(tr[1].dir, 'Short'); ok(tr[1].partialHistory && !tr[1].offRecord); near(tr[1].net, 300);
});
t('an open trade with a seam stays open and is reported as such', () => {
  const tr = perp([F('ZRO', 'B', 1000, 2, T0, 0), F('ZRO', 'A', 100, 2.1, T0 + 1e6, 600, 10)]);
  eq(tr.length, 1); ok(tr[0].isOpen && tr[0].offRecord);
  eq(ctx.coverageOf([], tr, null).offRecord, 0, 'not counted as a lost result while it is still open');
});
t('a history that simply starts mid-position is not a seam', () => {
  const tr = perp([F('ETH', 'A', 5, 1000, T0, 5, 50)]);
  eq(tr.length, 1); ok(tr[0].partialHistory && !tr[0].offRecord && !tr[0].gaps);
});
t('a position opened off the record after the fills saw the coin go flat is a seam: partial history, result kept', () => {
  const tr = perp([
    F('ETH', 'B', 10, 1000, T0, 0), F('ETH', 'A', 10, 1100, T0 + 1e6, 10, 1000), // whole: +1000
    // 5 ETH bought here in fills we never got
    F('ETH', 'A', 5, 1200, T0 + 2e6, 5, 500),                                     // its close is served
  ]).sort((a, b) => a.openTime - b.openTime);
  eq(tr.length, 2); ok(!tr[0].gaps && !tr[0].partialHistory, 'the whole trade is untouched');
  const x = tr[1]; ok(x.partialHistory && !x.offRecord, 'entry unknown, the exchange’s closedPnl counts');
  eq([x.gaps, x.gapSz, x.gapNotional, x.gapTimes], [1, 5, 6000, [T0 + 2e6]]); near(x.net, 500);
  eq(ctx.coverageOf([], tr, null).gaps, 1, 'coverage counts it');
  // the same fill with no earlier history for the coin stays a plain mid-position start
  ok(!perp([F('ETH', 'A', 5, 1200, T0 + 2e6, 5, 500)])[0].gaps);
});
t('unbroken chains, same-millisecond groups and flips never trip it', () => {
  const tr = perp([
    F('ETH', 'B', 1, 100, T0, 0), F('ETH', 'B', 1, 101, T0 + 1, 1),
    F('ETH', 'A', 3, 110, T0 + 2, 2, 19),          // flip to -1
    F('ETH', 'B', 1, 105, T0 + 2, -1, 5),          // same ms: covers it
  ]);
  ok(tr.every(x => !x.gaps && !x.offRecord), JSON.stringify(tr.map(x => [x.dir, x.gaps, x.offRecord])));
  eq(tr.length, 2);
});
t('spot balances move without fills, so a jump there is not a seam', () => {
  const tr = ctx.attributeFunding(ctx.reconstructTrades([
    F('@107', 'B', 10, 2, T0, 0), F('@107', 'A', 4, 3, T0 + 1e6, 30, 0),  // 20 more arrived by transfer
  ], '0xw', 'spot'), []);
  ok(tr.every(x => !x.gaps && !x.offRecord));
});

console.log('\nWhose liquidation');
t('the LIQ flag lands only on the wallet that was liquidated, not on the maker who filled it', () => {
  const liq = (f, user) => Object.assign(f, { liquidation: { liquidatedUser: user, markPx: f.px, method: 'market' } });
  const me = '0xABCDEF0123456789abcdef0123456789ABCDEF01', other = '0x1111111111111111111111111111111111111111';
  const mk = user => ctx.reconstructTrades([F('ETH', 'B', 1, 100, T0, 0), liq(F('ETH', 'A', 1, 90, T0 + 1e6, 1, -10), user)], me, 'perp');
  ok(mk(me.toLowerCase())[0].liquidated, 'this wallet, any letter case: liquidated');
  ok(!mk(other)[0].liquidated, 'someone else’s liquidation filled against us: not ours');
  const csv = ctx.reconstructTrades([F('ETH', 'B', 1, 100, T0, 0), Object.assign(F('ETH', 'A', 1, 90, T0 + 1e6, 1, -10), { liquidation: { method: 'BustTrade' } })], me, 'perp');
  ok(csv[0].liquidated, 'an imported fill names no user: the field alone counts');
  ok(ctx.reconstructTrades([F('ETH', 'B', 1, 100, T0, 0), liq(F('ETH', 'A', 1, 90, T0 + 1e6, 1, -10), other)], 'paste', 'perp')[0].liquidated, 'pasted fills have no wallet to compare: the field counts');
  // a flip fill carries the verdict to both the trade it closes and the one it opens
  const fl = ctx.reconstructTrades([F('ETH', 'B', 1, 100, T0, 0), liq(F('ETH', 'A', 3, 90, T0 + 1e6, 1, -10), other)], me, 'perp');
  ok(fl.every(x => !x.liquidated), 'neither side of the flip is ours');
});

console.log('\nCoverage');
t('served volume against the exchange’s own, seams by month, closed off-record trades', () => {
  const fills = [F('ETH', 'B', 10, 1000, T0, 0), F('ETH', 'B', 2, 1200, Date.UTC(2026, 6, 2), 0), F('ETH', 'A', 2, 1300, Date.UTC(2026, 6, 3), 2, 200), F('@107', 'B', 10, 2, T0, 0)];
  const cov = ctx.coverageOf(fills, perp(fills), { vlm: 100000, perpVlm: 50000 });
  near(cov.perpVol, 15000); near(cov.spotVol, 20); near(cov.perpShare, 0.3); near(cov.allShare, 0.1502);
  eq([cov.gaps, cov.offRecord], [1, 1]); near(cov.gapNotional, 12000);
  eq(Object.keys(cov.months), ['2026-07']); near(cov.months['2026-07'], 12000);
  eq(cov.gapFirst, Date.UTC(2026, 6, 2));
  eq(ctx.coverageOf(fills, [], null).perpShare, null, 'no exchange volume, no share');
});

console.log('\nThe verified figure (journal card and Daruma tile)');
t('leads only with seams, or a material perp gap; spot never; combined keeps whole fills on its own', () => {
  vm.runInContext(grabFn('verifiedFigure') + '\nconst candleVenue=t=>t.venue&&t.venue!=="hyperliquid"?t.venue:"";', ctx);
  const closed = (market, net, extra) => Object.assign({ market, net, isOpen: false, closeTime: T0 }, extra);
  ctx.allTrades = [closed('perp', 100), closed('perp', 50, { offRecord: true }), closed('spot', 10), closed('perp', 999, { venue: 'lighter' })];
  ctx.openPositions = []; ctx.spotHoldings = [];
  ctx.hlPnl = { all: 10000, perp: 150 }; ctx.dataCoverage = null;
  eq(ctx.verifiedFigure('perp'), null, 'perp within tolerance: fills stand');
  eq(ctx.verifiedFigure('spot'), null, 'spot always differs, never on its own'); eq(ctx.verifiedFigure('combined'), null);
  ctx.hlPnl = { all: 10000, perp: 50000 };
  const v = ctx.verifiedFigure('perp'); eq([v.ver, v.rec, v.live, v.n, v.seams], [50000, 100, 100, 1, false], 'a material perp gap: the exchange’s figure, off-record and other venues’ trades out of the fill sum');
  ctx.dataCoverage = { gaps: 3, perpShare: 0.4, allShare: 0.3 };
  const c = ctx.verifiedFigure('combined'); eq([c.ver, c.rec, c.gaps, c.share], [10000, 110, 3, 0.3], 'with seams perp and combined lead with the verified figure');
  eq(ctx.verifiedFigure('spot'), null, 'a perp seam says nothing about the spot fills');
  ctx.hlPnl = { all: null, perp: null }; eq(ctx.verifiedFigure('perp'), null, 'nothing verified, nothing to lead with');
});
t('the gap is judged like with like: open trades’ realized and the positions’ unrealized count on the fills’ side', () => {
  const closed = (market, net, extra) => Object.assign({ market, net, isOpen: false, closeTime: T0 }, extra);
  ctx.dataCoverage = null;
  // whole fills: +100 closed, +20 realized on an open trade, and an open position marked +40,000 up
  ctx.allTrades = [closed('perp', 100), { market: 'perp', net: 20, isOpen: true }, { market: 'perp', net: 5000, isOpen: true, venue: 'lighter' }];
  ctx.openPositions = [{ coin: 'ETH', uPnl: 40000 }, { coin: 'BTC', uPnl: 777, venue: 'lighter' }]; ctx.spotHoldings = [{ coin: 'HYPE', uPnl: 9 }];
  ctx.hlPnl = { all: 40200, perp: 40120 };
  eq(ctx.verifiedFigure('perp'), null, 'the exchange’s unrealized-inclusive figure matches the fills plus the open book: no gap, the fills stand');
  ctx.hlPnl = { all: 90000, perp: 90000 };
  const v = ctx.verifiedFigure('perp'); ok(v && v.live === 40120 && v.rec === 100, 'a real gap still leads, with the live basis beside the closed sum');
  ctx.openPositions = []; ctx.spotHoldings = [];
});

t('the exchange’s curves: summed across wallets as a step series, per market, with their drawdown', () => {
  vm.runInContext(['sumSeries', 'verifiedCurve', 'curveDrawdown'].map(grabFn).join('\n'), ctx);
  eq(ctx.sumSeries([[[1, 10], [3, 30]], [[2, 5], [3, 6]]]), [[1, 10], [2, 15], [3, 36]], 'each wallet’s latest value so far, summed at every time');
  eq(ctx.sumSeries([[[1, 1]]]), [[1, 1]]); eq(ctx.sumSeries([]), []);
  ctx.hlPnl = { all: 100, perp: 40, hist: { all: [[1, 0], [2, 100]], perp: [[1, 0], [2, 40]] } };
  eq(ctx.verifiedCurve('perp'), [[1, 0], [2, 40]]); eq(ctx.verifiedCurve('combined'), [[1, 0], [2, 100]]); eq(ctx.verifiedCurve('spot'), [[1, 0], [2, 60]]);
  ctx.hlPnl = { all: 1, perp: 1, hist: null }; eq(ctx.verifiedCurve('perp'), null);
  const d = ctx.curveDrawdown([[1, 0], [2, 50], [3, -20], [4, 10], [5, -40]]); eq([d.dd, d.at, d.peak], [-90, 5, 50]);
});

console.log('\nTWAP slice fills, paged by time');
const slice = (time, i) => ({ fill: F('ETH', 'B', 1, 100, time, i), twapId: 1 });
await t('pages until a short page, resumes AT the boundary, dedupes, honors since', async () => {
  const calls = [];
  // 2,000 slices in the first page, the last three sharing a millisecond that straddles the page edge
  const page1 = Array.from({ length: 2000 }, (_, i) => slice(T0 + Math.min(i, 1997) * 1000, i));
  const page2 = [page1[1998], page1[1999], slice(T0 + 2000 * 1000, 2000)]; // two dupes, one new
  ctx.hlPost = async b => { calls.push(b);
    if (b.type !== 'userTwapSliceFillsByTime') throw new Error('unexpected ' + b.type);
    return b.startTime <= T0 ? page1 : page2; };
  const r = await ctx.fetchTwapFills('0xw', 0);
  eq(calls.length, 2); eq(calls[1].startTime, T0 + 1997 * 1000, 'the second page starts at the boundary millisecond, not past it');
  eq(r.fills.length, 2001); ok(!r.partial);
  const r2 = await ctx.fetchTwapFills('0xw', T0 + 2000 * 1000);
  eq(calls[2].startTime, T0 + 2000 * 1000); eq(r2.fills.length, 1, 'only what is at or after since');
});
await t('falls back to the newest-2,000 call when the by-time one is refused; a full 2,000 means older ones may be missing', async () => {
  let n = 0, full = false;
  ctx.hlPost = async b => { if (b.type === 'userTwapSliceFillsByTime') throw new Error('API 422'); n++;
    return full ? Array.from({ length: 2000 }, (_, i) => slice(T0 + i, i)) : [slice(T0, 0), slice(T0 + 1, 1)]; };
  const r = await ctx.fetchTwapFills('0xw', 0);
  eq(n, 1); eq(r.fills.length, 2); ok(!r.partial, 'fewer than 2,000: that is all there is');
  full = true; ok((await ctx.fetchTwapFills('0xw', 0)).partial);
});
await t('fetchAllFills merges the slices with the ordinary fills and keys out duplicates', async () => {
  const shared = F('ETH', 'A', 1, 100, T0 + 5, 1);
  ctx.hlPost = async b => {
    if (b.type === 'userFillsByTime') return [F('ETH', 'B', 1, 100, T0, 0), shared];
    if (b.type === 'userTwapSliceFillsByTime') return [{ fill: shared, twapId: 1 }, slice(T0 + 9, 2)];
    throw new Error('unexpected ' + b.type); };
  const r = await ctx.fetchAllFills('0xw', 0);
  eq(r.fills.length, 3); ok(!r.truncated); ok(!ctx._fetchHealth.twap); ok(r.twapPartial === false);
});
await t('a slice served again under another trade id is one execution, not two', async () => {
  const f = F('ETH', 'A', 1, 100, T0 + 5, 1), again = Object.assign({}, f, { tid: 99991, oid: 99992 }); // same coin, time, side, size, price, start
  ctx.hlPost = async b => {
    if (b.type === 'userFillsByTime') return [f];
    if (b.type === 'userTwapSliceFillsByTime') return [{ fill: again, twapId: 1 }, slice(T0 + 9, 2)];
    throw new Error('unexpected ' + b.type); };
  const r = await ctx.fetchAllFills('0xw', 0);
  eq(r.fills.length, 2, 'the duplicate is keyed out by content; the genuinely new slice stays');
});
t('a wallet the exchange didn’t answer for keeps the verified figure from leading', () => {
  const closed = (market, net, extra) => Object.assign({ market, net, isOpen: false, closeTime: T0 }, extra);
  ctx.allTrades = [closed('perp', 100)]; ctx.openPositions = []; ctx.spotHoldings = []; ctx.dataCoverage = { gaps: 2, perpShare: 0.5, allShare: 0.5 };
  ctx.hlPnl = { all: 5000, perp: 5000, partial: true };
  eq(ctx.verifiedFigure('perp'), null, 'the sum understates: it must not lead'); eq(ctx.verifiedFigure('combined'), null);
  ctx.hlPnl = { all: 5000, perp: 5000, partial: false };
  ok(ctx.verifiedFigure('perp'), 'every wallet answered: it leads as before');
});
await t('a TWAP fetch that comes back partial is flagged on the data-health state', async () => {
  ctx.hlPost = async b => { if (b.type === 'userFillsByTime') return []; throw new Error('API 500'); };
  const r = await ctx.fetchAllFills('0xw', 0);
  ok(ctx._fetchHealth.twap); ok(r.twapPartial, 'so a first cache is not marked as holding every slice');
});

report();
