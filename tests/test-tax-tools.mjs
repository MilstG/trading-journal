// Tax software exports: Koinly's universal CSV and CoinTracker's CSV, row for row, for a small
// history (a deposit, a spot buy and sell, a perp round trip with fees and funding paid, a losing
// perp that received funding, a withdrawal), plus the tax-year windows the export picker uses.
import { t, eq, report, makeExtractor } from './harness.mjs';
import { readAppSource } from '../app-source.js';

const html = readAppSource(new URL('../ledger.html', import.meta.url).pathname);
const { evalModule } = makeExtractor(html);
const T = await evalModule(['csvCell', 'taxYearLabel', 'taxYearBounds', 'taxNum', 'taxToolRows', 'taxToolCsv']);
const U = s => Date.parse(s + 'Z');

const SRC = {
  nameByCoin: { '@1': 'FOO' }, quoteByCoin: { '@1': 'USDC' },
  flows: [{ time: U('2025-01-01T09:00:00'), usdc: 1000, type: 'deposit' }, { time: U('2025-06-30T23:59:59'), usdc: -200, type: 'withdraw' }],
  fills: [
    { coin: '@1', side: 'B', sz: '2', px: '100', fee: '0.002', feeToken: 'FOO', time: U('2025-01-02T10:00:00') },   // fee in the coin bought
    { coin: '@1', side: 'A', sz: '1', px: '150', fee: '0.15', feeToken: 'USDC', time: U('2025-02-01T12:30:00') },   // fee in USDC
    { coin: 'BTC', side: 'B', sz: '0.1', px: '90000', fee: '1', time: U('2025-03-01T00:00:00') },                    // a perp fill: never a spot row
  ],
  trades: [
    { market: 'perp', coin: 'BTC', dir: 'Long', pnl: 120.5, fees: 4.2, funding: -1.3, openTime: U('2025-03-01T00:00:00'), closeTime: U('2025-03-05T08:00:00') },
    { market: 'perp', coin: 'ETH', dir: 'Short', pnl: -50, fees: 2, funding: 0.75, openTime: U('2025-04-09T00:00:00'), closeTime: U('2025-04-10T16:45:00'), venue: 'bybit' },
    { market: 'perp', coin: 'SOL', dir: 'Long', pnl: 10, fees: 1, funding: 0, isOpen: true, openTime: U('2025-05-01T00:00:00') }, // still open: not yet a tax event
    { market: 'spot', coin: '@1', dir: 'Long', pnl: 50, fees: 0.15, closeTime: U('2025-02-01T12:30:00') },                           // spot comes from the fills
  ],
};

t('Koinly universal CSV: exact rows', () => {
  eq(T.taxToolCsv('koinly', SRC).split('\r\n'), [
    'Date,Sent Amount,Sent Currency,Received Amount,Received Currency,Fee Amount,Fee Currency,Net Worth Amount,Net Worth Currency,Label,Description,TxHash',
    '2025-01-01 09:00:00,,,1000,USDC,,,1000,USD,,Deposit,',
    '2025-01-02 10:00:00,200,USDC,2,FOO,0.002,FOO,200,USD,,Spot buy FOO/USDC,',
    '2025-02-01 12:30:00,1,FOO,150,USDC,0.15,USDC,150,USD,,Spot sell FOO/USDC,',
    '2025-03-05 08:00:00,,,120.5,USDC,4.2,USDC,120.5,USD,realized gain,BTC long perp realised profit,',
    '2025-03-05 08:00:00,1.3,USDC,,,,,1.3,USD,margin fee,BTC long perp funding paid,',
    '2025-04-10 16:45:00,50,USDT,,,2,USDT,50,USD,realized gain,ETH short perp realised loss,',
    '2025-04-10 16:45:00,,,0.75,USDT,,,0.75,USD,realized gain,ETH short perp funding received,',
    '2025-06-30 23:59:59,200,USDC,,,,,200,USD,,Withdrawal,',
  ]);
});
t('CoinTracker CSV: exact rows (MM/DD/YYYY UTC, margin tags)', () => {
  eq(T.taxToolCsv('cointracker', SRC).split('\r\n'), [
    'Date,Received Quantity,Received Currency,Sent Quantity,Sent Currency,Fee Amount,Fee Currency,Tag',
    '01/01/2025 09:00:00,1000,USDC,,,,,',
    '01/02/2025 10:00:00,2,FOO,200,USDC,0.002,FOO,',
    '02/01/2025 12:30:00,150,USDC,1,FOO,0.15,USDC,',
    '03/05/2025 08:00:00,120.5,USDC,,,4.2,USDC,margin_gain',
    '03/05/2025 08:00:00,,,1.3,USDC,,,margin_fee',
    '04/10/2025 16:45:00,,,50,USDT,2,USDT,margin_loss',
    '04/10/2025 16:45:00,0.75,USDT,,,,,margin_gain',
    '06/30/2025 23:59:59,,,200,USDC,,,',
  ]);
});
t('a fees-only perp, a fee rebate, and the counts by kind', () => {
  const r = T.taxToolRows('cointracker', { trades: [
    { market: 'perp', coin: 'BTC', dir: 'Long', pnl: 0, fees: 3, funding: 0, closeTime: U('2025-01-01T00:00:00') },
    { market: 'perp', coin: 'BTC', dir: 'Short', pnl: 5, fees: -0.5, funding: 0, closeTime: U('2025-01-02T00:00:00') }] });
  eq(r.rows, [['01/01/2025 00:00:00', '', '', '3', 'USDC', '', '', 'margin_fee'],
    ['01/02/2025 00:00:00', '5', 'USDC', '', '', '', '', 'margin_gain'], ['01/02/2025 00:00:00', '0.5', 'USDC', '', '', '', '', 'margin_rebate']]);
  eq(r.n, { cost: 1, gain: 1, rebate: 1 });
});
t('a date range keeps [from, to); tax-year windows match the year labels', () => {
  const [from, to] = T.taxYearBounds('2024/25', 'uk');
  eq([new Date(from).toISOString(), new Date(to).toISOString()], ['2024-04-06T00:00:00.000Z', '2025-04-06T00:00:00.000Z']);
  eq(T.taxYearBounds('FY2024-25', 'au').map(x => new Date(x).toISOString().slice(0, 10)), ['2024-07-01', '2025-07-01']);
  eq(T.taxYearBounds('2025', 'cal').map(x => new Date(x).toISOString().slice(0, 10)), ['2025-01-01', '2026-01-01']);
  for (const [k, lbl] of [['uk', '2024/25'], ['au', 'FY2024-25'], ['cal', '2025']]) {
    const [a, b] = T.taxYearBounds(lbl, k); eq([T.taxYearLabel(a, k), T.taxYearLabel(b - 1, k), T.taxYearLabel(b, k) !== lbl], [lbl, lbl, true]); }
  const r = T.taxToolRows('koinly', Object.assign({}, SRC, { from: U('2025-03-05T08:00:00'), to: U('2025-04-10T16:45:00') }));
  eq(r.rows.map(x => x[10]), ['BTC long perp realised profit', 'BTC long perp funding paid']);
});
t('amounts print plainly (no exponents, no float dust); text that could run as a formula is quoted', () => {
  eq([T.taxNum(1e-7), T.taxNum(0.1 + 0.2), T.taxNum(-0), T.taxNum(1234567.5)], ['0.0000001', '0.3', '0', '1234567.5']);
  const csv = T.taxToolCsv('koinly', { trades: [{ market: 'perp', coin: '=HYPE', dir: 'Long', pnl: 1, fees: 0, closeTime: U('2025-01-01T00:00:00') }] });
  eq(csv.split('\r\n')[1], "2025-01-01 00:00:00,,,1,USDC,,,1,USD,realized gain,'=HYPE long perp realised profit,");
});
t('every browser CSV uses one cell rule: whitespace-led formulas are defused, CR is quoted, numbers pass', () => {
  eq([' =HYPERLINK("x")', '\t@SUM(A1)', '-1.5', '+2', '-x', 'a\rb', 'a,b', null, 7].map(T.csvCell),
    ["\"' =HYPERLINK(\"\"x\"\")\"", "'\t@SUM(A1)", '-1.5', '+2', "'-x", '"a\rb"', '"a,b"', '', '7']);
});
report('tax tools');
