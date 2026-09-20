// Capital flows → return on capital (deposit/withdrawal ledger feature).
// Extracts capitalFlows + capitalModel straight from ledger.html, pins classification
// rules and the time-weighted math against hand-computed values.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { t, ok, eq, near, report, makeExtractor } from './harness.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '..', 'ledger.html'), 'utf8');
const { evalModule } = makeExtractor(html);
const { capitalFlows, capitalModel, xirrFromFlows } = await evalModule(
  ['capitalFlows', 'capitalModel', 'xirrFromFlows'], ['capitalFlows', 'capitalModel', 'xirrFromFlows']);

const DAY = 86400000, T0 = 1700000000000;
const ADDR = '0x' + 'a'.repeat(40);

console.log('\ncapitalFlows classification');
t('deposit +, withdraw −', () => {
  const { flows, skipped } = capitalFlows([
    { time: T0, delta: { type: 'deposit', usdc: '1000' } },
    { time: T0 + 1, delta: { type: 'withdraw', usdc: '400' } },
  ], ADDR);
  eq(flows.map(f => f.usdc), [1000, -400]); eq(skipped, 0);
});
t('internalTransfer signs by destination', () => {
  const { flows } = capitalFlows([
    { time: T0, delta: { type: 'internalTransfer', usdc: '250', destination: ADDR.toUpperCase() } },
    { time: T0 + 1, delta: { type: 'internalTransfer', usdc: '100', destination: '0x' + 'b'.repeat(40) } },
  ], ADDR);
  eq(flows.map(f => f.usdc), [250, -100]);
});
t('vault park is an outflow; vault withdraw an inflow', () => {
  const { flows } = capitalFlows([
    { time: T0, delta: { type: 'vaultDeposit', usdc: '500' } },
    { time: T0 + 1, delta: { type: 'vaultWithdraw', usdc: '500' } },
  ], ADDR);
  eq(flows.map(f => f.usdc), [-500, 500]);
});
t('accountClassTransfer is internal plumbing — neither flow nor skipped', () => {
  const { flows, skipped } = capitalFlows([
    { time: T0, delta: { type: 'accountClassTransfer', usdc: '9999' } },
  ], ADDR);
  eq(flows.length, 0); eq(skipped, 0);
});
t('unknown types are counted, never silently mixed in', () => {
  const { flows, skipped } = capitalFlows([
    { time: T0, delta: { type: 'someFutureThing', usdc: '123' } },
  ], ADDR);
  eq(flows.length, 0); eq(skipped, 1);
});
t('flows come back time-sorted', () => {
  const { flows } = capitalFlows([
    { time: T0 + 5, delta: { type: 'deposit', usdc: '1' } },
    { time: T0, delta: { type: 'deposit', usdc: '2' } },
  ], ADDR);
  eq(flows.map(f => f.time), [T0, T0 + 5]);
});

console.log('\ncapitalModel math');
const FLOWS = [
  { time: T0, usdc: 10000 },
  { time: T0 + 10 * DAY, usdc: -5000 },
];
const TRADES = [
  { isOpen: false, closeTime: T0 + 5 * DAY, net: 1000 },
  { isOpen: false, closeTime: T0 + 15 * DAY, net: -2000 },
];
const NOW = T0 + 20 * DAY;

t('time-weighted average capital', () => {
  const m = capitalModel(FLOWS, TRADES, null, NOW);
  // 10k for 10 days, then 5k for 10 days → 7.5k average
  near(m.avgCapital, 7500);
  near(m.totIn, 10000); near(m.totOut, 5000); near(m.netDeposited, 5000); near(m.maxCapital, 10000);
});
t('return on capital over the span', () => {
  const m = capitalModel(FLOWS, TRADES, null, NOW);
  near(m.realized, -1000); eq(m.nTrades, 2);
  near(m.roc, -1000 / 7500, 1e-9);
});
t('drawdown as % of capital present at the trough', () => {
  const m = capitalModel(FLOWS, TRADES, null, NOW);
  // cum +1000 (peak), then -1000 → dd $-2000 at a time when capital was 5000
  near(m.maxDD$, -2000); near(m.maxDDpctCap, -0.4, 1e-9);
});
t('implied all-time PnL = equity − net deposited', () => {
  const m = capitalModel(FLOWS, TRADES, 4200, NOW);
  near(m.impliedPnl, -800);
});
t('no flows → null (feature renders nothing rather than lying)', () => {
  eq(capitalModel([], TRADES, null, NOW), null);
});
t('annualization gated on span length', () => {
  const short = capitalModel([{ time: NOW - 5 * DAY, usdc: 1000 }], [], null, NOW);
  eq(short.rocAnnual, null); // 5 days is noise, not a rate
  const yr = capitalModel([{ time: NOW - 365 * DAY, usdc: 10000 }],
    [{ isOpen: false, closeTime: NOW - DAY, net: 1000 }], null, NOW);
  near(yr.rocAnnual, 0.1, 0.005); // +10% over one year annualizes to ~10%
});

console.log('\nxirrFromFlows (money-weighted return)');
t('single deposit one year ago, equity 1.1x → ~10%/yr', () => {
  const x = xirrFromFlows([{ time: NOW - 365 * DAY, usdc: 10000 }], 11000, NOW);
  near(x, 0.10, 1e-4);
});
t('deposit + interim withdrawal weight periods by deployed capital', () => {
  // 10k in 2y ago, 5k out 1y ago, 6.655k equity now — money grew 10%/yr throughout:
  // FV = 10000·1.1² − 5000·1.1 = 12100 − 5500 = 6600
  const x = xirrFromFlows([
    { time: NOW - 730 * DAY, usdc: 10000 },
    { time: NOW - 365 * DAY, usdc: -5000 },
  ], 6600, NOW);
  near(x, 0.10, 1e-3);
});
t('losing account solves to a negative rate', () => {
  const x = xirrFromFlows([{ time: NOW - 365 * DAY, usdc: 10000 }], 8000, NOW);
  near(x, -0.20, 1e-3);
});
t('no live equity → null (never guessed)', () => {
  eq(xirrFromFlows([{ time: NOW - DAY, usdc: 1000 }], null, NOW), null);
  eq(xirrFromFlows([], 5000, NOW), null);
});

report('capital');
