// Beta 6, the full journal. A spot sell is two rows: the position it belongs to (counted, listed,
// journaled) and the day it was realized on (summed). Surfaces that took both added spot P&L twice and
// counted a spot round trip as up to three trades — the pulse strip, the tape, the Review digest, the
// weekly review, the monthly goals, Project, the journal inbox and streak, the daily loss limit, the
// verified figure's "closed fills", Capital & true return, Daruma's Stats. Pinned here on one synthetic
// history built by the real reconstruction, with the truth written out: plus the fill-truncation record
// that now survives a reload, the reconstruction banner judged against the open book, the exchange's
// curve kept to the account it covers, the audit's "before the first fill", and the Diagnostic verdict
// that says when it speaks for the fills only.
import vm from 'node:vm';
import { t, ok, eq, near, report, makeExtractor } from './harness.mjs';
import { readAppSource } from '../app-source.js';

const html = readAppSource(new URL('../ledger.html', import.meta.url).pathname);
const { grabFn } = makeExtractor(html);
const NOW = Date.UTC(2026, 9, 5, 15, 0, 0), H = 3600e3, D = 86400e3, DAY0 = Date.UTC(2026, 9, 5);
class FakeDate extends Date { constructor(...a){ super(...(a.length ? a : [NOW])); } static now(){ return NOW; } }
const els = {};
const $ = id => els[id] || (els[id] = { id, innerHTML: '', textContent: '', dataset: {}, classList: { s: new Set(), add(c){ this.s.add(c); }, remove(c){ this.s.delete(c); }, toggle(){}, contains(c){ return this.s.has(c); } } });
const ctx = { Math, Object, Array, String, Number, JSON, isFinite, isNaN, Set, Map, Float64Array, parseFloat, parseInt, console, Date: FakeDate, $,
  settings: { tz: 'utc', wallets: [] }, journal: {}, view: 'combined', dexView: 'all', dexSel: new Set(), period: 0, _be: 0.5, _oneR: null,
  allTrades: [], openPositions: [], spotHoldings: [], hlPnl: { all: null, perp: null }, dataCoverage: null, spotMaps: { nameByCoin: { '@107': 'HYPE', '@108': 'PURR' } },
  candleVenue: t => t.venue && t.venue !== 'hyperliquid' ? t.venue : '', coachOn: () => false, lastWeekFocusHtml: () => '', pbSummary: () => null, pbList: () => [] };
vm.createContext(ctx);
const FNS = ['isPerp', 'newTrade', 'tallyFill', 'reconstructTrades', 'attributeFunding', 'tzParts', 'tzMidnight', 'addDays', 'tradeDex', 'dexOk', 'dexFilter', 'viewFilter',
  'tradeRow', 'moneyRow', 'closedTrades', 'realizedMoney', 'measured', 'notionalOf', 'holdOf', 'dayNetMap', 'projBaseline', 'monthlyGoalModel', 'capitalModel', 'dailyLossToday', 'verifiedFigure', 'historyNote', 'reconcileSplit',
  'pnlAudit', 'fillTrunc', 'truncNoteOf', 'mergeCoverage', 'renderPulse', 'renderTape', 'isoWeekKey', 'lastCompletedWeekRange', 'weeklyReviewSectionHtml', 'esc', 'fmtDate',
  'dailyPnl', 'dailySeriesCalendar', 'sharpeStats', 'sortinoAnnual', 'riskFor', 'rFor', 'retPct', 'computeStats', 'pzStatsFor', 'dashCurve', 'verifiedCurveFor', 'sumSeries', 'curveSlice',
  'periodFrom', 'rangeActive', 'diagFillsRecord'];
vm.runInContext(`
const MONTHS=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const fmtUsd=(n,dp=2)=>{ if(n===null||n===undefined||isNaN(n))return '—'; const s=n<0?'-':''; return s+'$'+Math.abs(n).toLocaleString('en-US',{minimumFractionDigits:dp,maximumFractionDigits:dp}); };
const cls=n=>n>0?'pos-t':n<0?'neg-t':'';
const dayKey=ms=>{ const p=tzParts(ms); return p.y+'-'+String(p.mo+1).padStart(2,'0')+'-'+String(p.day).padStart(2,'0'); };
const nfDayKey=ms=>tzMidnight(ms);
const isWin=n=>n>0&&n>=_be, isLoss=n=>n<0&&-n>=_be, isBE=n=>Math.abs(n)<_be||n===0;
const _avg=a=>a.length?a.reduce((x,y)=>x+y,0)/a.length:0;
const _std=a=>{ if(a.length<2)return 0; const m=_avg(a); return Math.sqrt(a.reduce((s,x)=>s+(x-m)*(x-m),0)/(a.length-1)); };
const dcoin=t=>t.symbol||(spotMaps.nameByCoin[t.coin])||t.coin;
const dispMarket=k=>String(k);
let customRange={from:null,to:null};
` + FNS.map(grabFn).join('\n'), ctx);

let tid = 0;
const F = (coin, side, sz, px, time, start, closedPnl = 0, fee = 0) =>
  ({ coin, side, sz: String(sz), px: String(px), time, startPosition: String(start), closedPnl: String(closedPnl), fee: String(fee), feeToken: 'USDC', tid: ++tid, oid: ++tid, crossed: true, dir: '', hash: '0x1' });
// HYPE: 10 bought ten days ago, sold in two halves today (+$50 each): one round trip, +$100.
// PURR: 10 bought five days ago, half sold today (+$20): still open, its +$20 realized today.
// BTC perp: opened yesterday, closed today, +$50.
// Truth for today and the last 30 days: +$170 realized, 2 closed trades.
const spotFills = [F('@107', 'B', 10, 40, NOW - 10 * D, 0), F('@107', 'A', 5, 50, DAY0 + 9 * H, 10, 50), F('@107', 'A', 5, 50, DAY0 + 10 * H, 5, 50),
  F('@108', 'B', 10, 1, NOW - 5 * D, 0), F('@108', 'A', 5, 5, DAY0 + 11 * H, 10, 20)];
const perpFills = [F('BTC', 'B', 0.1, 60000, NOW - D, 0), F('BTC', 'A', 0.1, 60500, DAY0 + 12 * H, 0.1, 50)];
const build = () => [...ctx.attributeFunding(ctx.reconstructTrades(perpFills, '0xw', 'perp'), []), ...ctx.attributeFunding(ctx.reconstructTrades(spotFills, '0xw', 'spot'), [])];
ctx.allTrades = build();
const A = ctx.allTrades;

console.log('\nThe synthetic spot history');
t('the reconstruction gives both kinds of spot rows, as the app sees them', () => {
  const pos = A.filter(x => x.spotPos), rz = A.filter(x => x.spotRz);
  eq(pos.map(x => [x.coin, !!x.isOpen, +x.net.toFixed(2)]).sort(), [['@107', false, 100], ['@108', true, 20]].sort());
  eq(rz.length, 4, 'two buy days (net $0) and two sell days');
  near(rz.reduce((s, x) => s + x.net, 0), 120, 1e-9, 'the day rows hold the realized spot money');
  near(A.filter(x => !x.isOpen).reduce((s, x) => s + x.net, 0), 270, 1e-9, 'summing every closed row reads spot twice: the bug');
  eq(ctx.closedTrades().length, 2); near(ctx.realizedMoney().reduce((s, x) => s + x.net, 0), 170, 1e-9);
});

console.log('\nEvery surface counts spot once');
t('pulse strip: today and 30 days say +$170 over 2 trades', () => {
  ctx.renderPulse(); const h = $('pulse').innerHTML;
  const items = [...h.matchAll(/<span class="p-k">([^<]+)<\/span><span class="p-v[^"]*">([^<]+)<\/span><span class="p-n">([^<]+)<\/span>/g)].map(m => m.slice(1));
  eq(items, [['Today', '$170.00', '2 trades'], ['7D', '$170.00', '2 trades'], ['30D', '$170.00', '2 trades']]);
});
t('tape: TODAY +$170 · 2 closed trades, a chip per trade and none for a buy day', () => {
  ctx.renderTape(); const h = $('tape').innerHTML;
  ok(/TODAY \+\$170 · 2 closed trades/.test(h), h.slice(0, 120));
  eq((h.match(/class="tp"/g) || []).length, 2, 'two chips: the HYPE round trip and BTC');
  ok(!/B\/E/.test(h), 'no break-even chip for the day HYPE was bought');
});
t('monthly goals: the month’s net and its trade count', () => {
  const m = ctx.monthlyGoalModel(A.filter(x => !x.isOpen && x.closeTime), { monthlyTarget: 1000 });
  near(m.net, 170); eq(m.n, 2);
});
t('Project: the basis sums money once and counts trades', () => {
  const b = ctx.projBaseline(A.filter(x => !x.isOpen && x.closeTime), 90);
  near(b.total, 170); eq(b.trades, 2); near(b.expectancy, 85, 1e-9, 'the money, $170, over 2 trades (main’s projBaseline: expectancy is total ÷ trades)');
  near(b.daily.reduce((s, v) => s + v, 0), 170);
});
t('Capital & true return: realized once, trades counted once', () => {
  const m = ctx.capitalModel([{ time: NOW - 20 * D, usdc: 1000, type: 'deposit' }], ctx.realizedMoney(), 1170); // the Diagnostic passes realizedMoney()
  near(m.realized, 170);
});
t('daily loss limit: today’s realized is +$170 over 2 trades (a −$300 spot day used to read −$600)', () => {
  const d = ctx.dailyLossToday(A); near(d.net, 170, 1e-9); eq(d.n, 2);
  const loss = ctx.attributeFunding(ctx.reconstructTrades([F('@107', 'B', 10, 40, NOW - 2 * D, 0), F('@107', 'A', 10, 10, DAY0 + 9 * H, 10, -300)], '0xw', 'spot'), []);
  near(ctx.dailyLossToday(loss).net, -300, 1e-9);
});
t('verified figure, combined: “closed fills” is perp + spot once, n counts trades', () => {
  ctx.hlPnl = { all: 9000, perp: 50 }; ctx.dataCoverage = { gaps: 2, perpShare: 0.5, allShare: 0.5 };
  const v = ctx.verifiedFigure('combined'); near(v.rec, 170); eq(v.n, 2);
  ctx.hlPnl = { all: null, perp: null }; ctx.dataCoverage = null;
});
t('weekly review: the week’s net and trade count', () => {
  ctx.allTrades = A.map(x => Object.assign(Object.create(Object.getPrototypeOf(x)), x, { closeTime: x.closeTime - 7 * D, openTime: x.openTime - 7 * D }));
  const h = ctx.weeklyReviewSectionHtml(); ctx.allTrades = A;
  ok(/Guided review — 2 trades, net <span class="pos-t">\$170\.00<\/span>/.test(h), h.match(/Guided review[^<]*<span[^>]*>[^<]*/)?.[0]);
});
t('Daruma’s Stats: Net, the day bars and the markets from money rows; counts from trades', () => {
  const trades = A.filter(x => !x.spotRz); // coachContext(true)'s trades: no day rows
  const st = ctx.pzStatsFor(trades, NOW - 30 * D, ctx.realizedMoney()); // Daruma passes coachContext's money
  near(st.s.net, 170); eq(st.s.n, 2);
  eq(st.days.map(d => [d.k, +d.net.toFixed(2), d.n]).filter(d => d[0] === '2026-10-05'), [['2026-10-05', 170, 2]]);
  near(st.markets.find(m => m.k === 'PURR').net, 20, 1e-9, 'PURR’s partial sale counts though its stack is still open');
  const perpOnly = ctx.pzStatsFor(trades.filter(x => x.market === 'perp'), NOW - 30 * D); near(perpOnly.s.net, 50, 1e-9, 'a market toggle keeps to its market');
});
t('the readers that list, count or grade trades take trade rows (inbox, streak, review, playbooks, miner, guardrails, heatmap, calendar, ratchet, Daruma)', () => {
  const src = n => grabFn(n);
  // the engine's two populations (closedTrades / realizedMoney; tests/test-populations.mjs guards hand-built lists)
  ok(/tradeRow\(t\)&&!t\.movedOut/.test(src('inboxSectionHtml')), 'journal inbox and streak');
  ok(/closedTrades\(viewFilter\)/.test(src('renderReviewInner')) && /realizedMoney\(viewFilter\)/.test(src('renderReviewInner')), 'the Review digest');
  ok(/closedTrades\(viewFilter\)/.test(src('playbooksSectionHtml')), 'playbooks');
  ok(/closedTrades\(\)/.test(src('pbsYoursHtml')), 'Daruma’s playbooks');
  ok(/closedTrades\(viewFilter\)/.test(src('setWeekChallenge')) && /closedTrades\(viewFilter\)/.test(src('adoptHabit')), 'the habit miner’s inputs');
  ok(/closedTrades\(\)/.test(src('guardrailSignals')), 'the guardrails');
  ok(/renderCalendar\(ptAll,pt\); renderDowHour\(ptAll,pt\)/.test(src('renderInner')), 'calendar counts and the weekday×hour heatmap see spot trades');
  ok(/tradeRow\(t\)&&!t\.movedOut/.test(src('socJournalTrades')), 'Daruma’s share-a-trade list');
  ok(/tradeRow\(t\)&&!t\.movedOut&&!t\.orphan&&t\.openTime/.test(src('pzPlanCheck')), 'Daruma’s plan check');
});
t('Project: “Sizing at this edge” reads the basis trades, as its tip says', () => {
  const s = grabFn('renderProjection'); ok(/kellyFromTrades\(bt\)/.test(s) && !/kellyFromTrades\(closed\)/.test(s));
  ok(/projBaseline\(rowsAll,_proj\.look\)/.test(s), 'the basis is built from both kinds, split inside');
});

console.log('\nFill truncation survives the next load');
t('a first load cut at the exchange’s window is recorded with its first fill; later loads keep it', () => {
  const first = { truncated: true, why: 'window', first: Date.UTC(2025, 11, 2), fills: [] };
  const fills = [{ time: Date.UTC(2025, 11, 2) }, { time: NOW }];
  const tr = ctx.fillTrunc(null, first, fills, false); eq(tr, { why: 'window', from: Date.UTC(2025, 11, 2) });
  eq(ctx.fillTrunc(tr, { truncated: false, fills: [] }, fills, true), tr, 'an incremental load with nothing cut keeps the record');
  ok(/10,000 fills: nothing before 2025-12-02/.test(ctx.truncNoteOf('heavy', tr)) && /archive/.test(ctx.truncNoteOf('heavy', tr)), 'and says only the archive reaches past it');
  eq(ctx.fillTrunc(tr, { truncated: false, fills: [] }, [{ time: Date.UTC(2025, 5, 1) }, ...fills], true), null, 'fills recovered from before it (the archive) clear it');
  eq(ctx.fillTrunc(tr, { truncated: false, first: 0, fills: [] }, fills, false), null, 'a whole refetch from zero that isn’t cut clears it');
  eq(ctx.fillTrunc(tr, first, fills, false), tr.from === first.first ? { why: 'window', from: first.first } : null, 'a full refetch cut at the same window keeps it');
  eq(ctx.fillTrunc(null, first, [{ time: Date.UTC(2024, 0, 1) }, ...fills], false), null, 'a full refetch merged into a cache that reaches past the cut: the cache stands');
  const gap = ctx.fillTrunc(tr, { truncated: true, why: 'window', first: NOW - D }, fills, true);
  eq(gap, { why: 'gap', from: NOW - D }, 'an incremental fetch that hits the limit is a gap since the last load');
  ok(/Full refetch/.test(ctx.truncNoteOf('w', gap)));
});
t('“whole since” is the latest of the seams and every truncated wallet’s first fill', () => {
  let acc = ctx.mergeCoverage(null, { gaps: 3, gapFirst: Date.UTC(2025, 1, 1), gapLast: Date.UTC(2025, 6, 1), label: 'a' });
  acc = ctx.mergeCoverage(acc, { gaps: 0, truncFrom: Date.UTC(2025, 11, 2), label: 'heavy' });
  eq([acc.gapLast, acc.truncLast], [Date.UTC(2025, 6, 1), Date.UTC(2025, 11, 2)]);
  const s = grabFn('renderStats'); ok(/Math\.max\(cov\.gapLast\|\|0,cov\.truncLast\|\|0\)/.test(s), 'the Trade stats card reads both');
});

console.log('\nThe exchange’s figures, like with like');
t('reconstruction note: whole fills beside a large open position are not a gap', () => {
  const A1 = [{ market: 'perp', net: 1000, isOpen: false, closeTime: NOW - 19 * D }, { market: 'perp', net: 0, isOpen: true, closeTime: NOW - 10 * D }];
  ctx.allTrades = A1; ctx.openPositions = [{ coin: 'ETH', uPnl: 20000 }]; ctx.hlPnl = { perp: 21000, all: 21000, hist: null }; ctx.dataCoverage = { gaps: 0 };
  eq(ctx.historyNote(), null, '+$1,000 realized and +$20,000 open is Hyperliquid’s $21,000');
  ctx.openPositions = []; eq(ctx.historyNote().kind, 'gap', 'without the open position it is a gap');
  ok(!/Shift/.test(ctx.historyNote().text) && /Full refetch/.test(ctx.historyNote().text), 'pointing at a control that exists');
  ctx.allTrades = A; ctx.hlPnl = { all: null, perp: null }; ctx.dataCoverage = null;
  ok(/recAllLive=recAll\+uPerp\+uSpot/.test(grabFn('renderReconcile')), 'the strip’s Total adds the open book too');
});
t('the dashboard’s curve stands only for the account it covers', () => {
  ctx.hlPnl = { all: 100, perp: 40, hist: { all: [[NOW - 9 * D, 0], [NOW, 100]], perp: [[NOW - 9 * D, 0], [NOW, 40]] } };
  ctx.view = 'perp'; ok(ctx.dashCurve(), 'whole account, perps: the curve');
  ctx.view = 'spot'; eq(ctx.dashCurve(), null, 'spot: never (holdings, airdrops, transfers)');
  ctx.view = 'perp'; ctx.hlPnl.partial = true; eq(ctx.dashCurve(), null, 'a wallet unanswered: one wallet’s curve is not the account’s');
  ctx.hlPnl.partial = false; ctx.dexView = 'main'; eq(ctx.dashCurve(), null, 'a dex filter');
  ctx.dexView = 'all'; ctx.allTrades = [...A, { market: 'perp', venue: 'lighter', net: 5, isOpen: false, closeTime: NOW }]; eq(ctx.dashCurve(), null, 'Lighter trades in view');
  ctx.allTrades = A; ctx.view = 'combined'; ctx.hlPnl = { all: null, perp: null };
});
t('the audit claims P&L before the first fill only when the curve moved before it', () => {
  const T = Date.UTC(2026, 0, 1), fills = [{ coin: 'BTC', closedPnl: '0', fee: '0', sz: '1', px: '100', time: T }];
  const flat = Array.from({ length: 17 }, (_, i) => [T - (17 - i) * 7 * D, 0]).concat([[T + D, 0]]);
  eq(ctx.pnlAudit(fills, [], flat, [], null, T + 2 * D).before, null, 'a curve at 0 until the first fill: nothing before it');
  ok(ctx.pnlAudit(fills, [], [[T - 30 * D, 0], [T - 20 * D, -400], [T + D, -400]], [], null, T + 2 * D).before, 'a curve that moved: said');
  const s = grabFn('renderAuditPanel'); ok(/a\.first<=ARCHIVE_FROM/.test(s), 'and the archive is said to lack them only when they predate it');
});
t('the Diagnostic verdict speaks for the fills on record when they can’t speak for the account', () => {
  ctx.verifiedHeadline = () => ({ ver: -9758, share: 0.56 }); ctx.dataCoverage = { gaps: 0, truncLast: Date.UTC(2025, 11, 2) };
  const r = ctx.diagFillsRecord(); ok(r && r.ver === -9758 && /fills on record, not the account/.test(r.text) && /-\$9,758/.test(r.text) && /56%/.test(r.text) && /2025-12-02/.test(r.text), r && r.text);
  const v = grabFn('renderDiagnostic'); ok(/The fills on record are profitable — the account is not/.test(v));
  ctx.verifiedHeadline = () => null; ctx.period = 30; ctx.dataCoverage = { gaps: 0, truncLast: NOW - 90 * D };
  eq(ctx.diagFillsRecord(), null, 'a period after the fills are whole: the verdict stands as it is');
  ctx.period = 0; ok(ctx.diagFillsRecord(), 'all time with a truncated wallet: qualified');
  ctx.dataCoverage = null; eq(ctx.diagFillsRecord(), null);
});

report('beta6-journal');
