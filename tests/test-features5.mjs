// Unit tests for the third features build: fee-tier optimizer, weekly review keys,
// variance expectations, risk-creep detector, unplanned-trading guardrail, demo mode.
// Same pattern as every suite: extract the pure functions from ledger.html and pin
// behaviour against hand-computed values.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { t, ok, eq, near, report, makeExtractor } from './harness.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '..', 'ledger.html'), 'utf8');
const { evalModule } = makeExtractor(html);

// FEE_TIERS is a top-level const, not a function — lift it verbatim so the test can
// never drift from the shipped table.
const FEE_TIERS_SRC = (html.match(/const FEE_TIERS=\[[\s\S]*?\];/) || [''])[0];
ok_boot(FEE_TIERS_SRC, 'FEE_TIERS table found in ledger.html');
function ok_boot(v, msg) { if (!v) { console.error('boot: ' + msg); process.exit(1); } }

const PRELUDE = `
const settings={tz:'utc'};
const _be=50; const isWin=n=>n>_be; const isLoss=n=>n<-_be;
const _avg=a=>a.length?a.reduce((x,y)=>x+y,0)/a.length:0;
let _rng=Math.random;
` + FEE_TIERS_SRC + '\n';

const { feeTierModel, isoWeekKey, lastCompletedWeekRange, varianceModel, riskCreepModel,
        unplannedToday, demoFills, reconstructTrades } = await evalModule(
  ['tzParts', 'tzMidnight', 'dayJKey', '_srand', '_hashSeed', 'nfMedian',
   'feeTierModel', 'isoWeekKey', 'lastCompletedWeekRange', 'varianceModel', 'riskCreepModel',
   'unplannedToday', 'demoFills', 'isPerp', 'newTrade', 'tallyFill', 'reconstructTrades'],
  ['feeTierModel', 'isoWeekKey', 'lastCompletedWeekRange', 'varianceModel', 'riskCreepModel',
   'unplannedToday', 'demoFills', 'reconstructTrades'], PRELUDE);

const DAY = 86400000, H = 3600000;
const NOW = Date.UTC(2026, 8, 24, 15); // 2026-09-24T15:00Z, a Thursday

console.log('\nfee-tier optimizer');
t('volume from per-fill events picks the tier; 30d taker flow prices the alternatives', () => {
  const trades = [{
    events: [[NOW - DAY, 1, 6e6, 1]],  // $6M inside the 14d window → tier 1
    closeTime: NOW - DAY, fees: 500, takerNotional: 1e6, makerNotional: 0, unkNotional: 0,
  }];
  const m = feeTierModel(trades, NOW);
  eq(m.tier, 1); near(m.vol14, 6e6);
  near(m.toNext, 19e6);                     // tier 2 starts at $25M
  near(m.takerFee30, 1e6 * 0.00040);        // tier-1 taker
  near(m.saveAsMaker30, 1e6 * (0.00040 - 0.00012));
  near(m.saveNextTier30, 1e6 * (0.00040 - 0.00035));
});
t('events outside the 14-day window never set the tier; trades outside 30d carry no fees', () => {
  const m = feeTierModel([
    { events: [[NOW - 20 * DAY, 1, 9e9, 1]], closeTime: NOW - 1 * DAY,
      fees: 225, takerNotional: 5e5, makerNotional: 0, unkNotional: 0 }, // $9B — but 20 days ago
    { events: [], closeTime: NOW - 40 * DAY, fees: 999, takerNotional: 9e6, makerNotional: 0, unkNotional: 0 },
  ], NOW);
  eq(m.tier, 0, 'old volume must not set the tier');
  near(m.vol14, 0);
  near(m.takerFee30, 5e5 * 0.00045, 1e-6, 'only the recent trade prices the 30d flow');
  near(m.fees30, 225);
});
t('no flow at all → null (card hidden)', () => {
  eq(feeTierModel([], NOW), null);
  eq(feeTierModel([{ events: [], closeTime: NOW - 90 * DAY, fees: 1 }], NOW), null);
});
t('top tier reports no next tier', () => {
  const m = feeTierModel([{ events: [[NOW - DAY, 1, 3e9, 1]], closeTime: NOW - DAY,
    fees: 0, takerNotional: 0, makerNotional: 0, unkNotional: 1 }], NOW);
  eq(m.tier, 5); eq(m.next, null); eq(m.toNext, null); eq(m.saveNextTier30, null);
});

console.log('\nISO week keys');
t('textbook ISO boundaries: year rollovers land in the right ISO year', () => {
  eq(isoWeekKey(Date.UTC(2026, 0, 1)), 'week:2026-W01');   // Thu 2026-01-01
  eq(isoWeekKey(Date.UTC(2024, 11, 30)), 'week:2025-W01'); // Mon 2024-12-30 belongs to 2025
  eq(isoWeekKey(Date.UTC(2021, 0, 1)), 'week:2020-W53');   // Fri 2021-01-01 belongs to 2020
  eq(isoWeekKey(Date.UTC(2026, 8, 24)), 'week:2026-W39');
});
t('lastCompletedWeekRange is the Monday-to-Monday week before the current one', () => {
  const { from, to } = lastCompletedWeekRange(NOW);
  eq(new Date(to).toISOString().slice(0, 10), '2026-09-21');   // this week's Monday
  eq(new Date(from).toISOString().slice(0, 10), '2026-09-14'); // prior Monday
  eq(isoWeekKey(from + 3.5 * DAY), 'week:2026-W38');
});

console.log('\nvariance expectations');
const mkTrade = (net, i) => ({ net, closeTime: NOW - 60 * DAY + i * 2 * DAY, isOpen: false });
const VAR_TRADES = [];
for (let i = 0; i < 30; i++) VAR_TRADES.push(mkTrade(i % 2 ? 100 : -100, i));
t('needs 20 trades; win rate from decisive trades only', () => {
  eq(varianceModel(VAR_TRADES.slice(0, 15)), null);
  const m = varianceModel(VAR_TRADES);
  near(m.p, 0.5); eq(m.n, 30);
  ok(m.perMonth >= 12 && m.perMonth <= 20, 'about one trade every 2 days → ~15/mo, got ' + m.perMonth);
});
t('deterministic per seed; streak probabilities decrease with length', () => {
  const a = varianceModel(VAR_TRADES), b = varianceModel(VAR_TRADES);
  eq(a.monthP5, b.monthP5);
  eq(a.streaks, b.streaks);
  for (let i = 1; i < a.streaks.length; i++) ok(a.streaks[i].prob <= a.streaks[i - 1].prob + 1e-9);
  const s3 = a.streaks.find(s => s.len === 3);
  ok(s3 && s3.prob > 0.9, 'a 3-loss run in 200 trades at 50% win rate is near-certain');
});
t('bad-month percentiles are ordered and scale with the trade distribution', () => {
  const m = varianceModel(VAR_TRADES);
  ok(m.monthP5 <= m.monthP25 && m.monthP25 <= m.monthMed);
  ok(m.monthP5 < 0, 'a 50% win rate coin-flip book has losing months');
});

console.log('\nrisk-creep detector');
const creepTrades = (n1, n2, nets) => {
  const out = [];
  for (let i = 0; i < 40; i++) out.push({ isOpen: false, closeTime: NOW - (40 - i) * DAY,
    maxSize: 1, avgEntry: i < 20 ? n1 : n2, net: nets != null ? nets : 0 });
  return out;
};
t('doubling median notional with no equity data flags creep', () => {
  const m = riskCreepModel(creepTrades(1000, 2000));
  near(m.m1, 1000); near(m.m2, 2000); near(m.sizeGrowth, 1.0);
  eq(m.eqGrowth, null); eq(m.creep, true);
});
t('sizing that merely tracks equity growth is not creep', () => {
  // notional +30%, while the account also grew ~+30% over the last-20 stretch
  const trades = creepTrades(1000, 1300, 150); // last 20 net +150 each → +3000 realized
  const m = riskCreepModel(trades, 13000);     // acctThen = 13000-3000 = 10000 → eq +30%
  near(m.sizeGrowth, 0.3); near(m.eqGrowth, 0.3);
  eq(m.creep, false, 'growth in line with capital is healthy compounding');
});
t('sizing that outruns a flat account is creep; flat sizing never is', () => {
  const m = riskCreepModel(creepTrades(1000, 1400, 0), 10000); // eq flat, size +40%
  eq(m.creep, true);
  eq(riskCreepModel(creepTrades(1000, 1000), 10000).creep, false, 'flat sizing is never creep');
  eq(riskCreepModel(creepTrades(1000, 2000).slice(0, 39)), null, 'needs 40 closed trades');
});

console.log('\nunplanned-trading guardrail');
t('two trades today with no plan → unplanned; a filed plan clears it', () => {
  const trades = [
    { isOpen: false, closeTime: NOW - 2 * H },
    { isOpen: false, closeTime: NOW - 1 * H },
    { isOpen: false, closeTime: NOW - 30 * H }, // yesterday — not counted
  ];
  const u = unplannedToday(trades, {}, NOW);
  eq(u.n, 2); eq(u.hasPlan, false); eq(u.unplanned, true);
  const planned = unplannedToday(trades, { 'day:2026-09-24': { plan: 'fade the open' } }, NOW);
  eq(planned.hasPlan, true); eq(planned.unplanned, false);
});
t('one trade is not nagged; open positions entered today count', () => {
  eq(unplannedToday([{ isOpen: false, closeTime: NOW - H }], {}, NOW).unplanned, false);
  const u = unplannedToday([
    { isOpen: true, openTime: NOW - 3 * H },
    { isOpen: false, closeTime: NOW - H },
  ], {}, NOW);
  eq(u.n, 2); eq(u.unplanned, true);
});
t('a committed max loss alone counts as a plan', () => {
  eq(unplannedToday([{ isOpen: false, closeTime: NOW - H }, { isOpen: false, closeTime: NOW - 2 * H }],
    { 'day:2026-09-24': { maxLoss: 300 } }, NOW).unplanned, false);
});

console.log('\ndemo mode');
t('deterministic per seed, different across seeds, sorted, schema-complete', () => {
  const a = demoFills(1, NOW), b = demoFills(1, NOW), c = demoFills(2, NOW);
  eq(JSON.stringify(a), JSON.stringify(b));
  ok(JSON.stringify(a) !== JSON.stringify(c), 'seed must matter');
  ok(a.length >= 80, 'a populated demo needs a real history, got ' + a.length + ' fills');
  for (let i = 1; i < a.length; i++) ok(a[i].time >= a[i - 1].time, 'sorted by time');
  for (const f of a) {
    ok(typeof f.coin === 'string' && (f.side === 'B' || f.side === 'A'));
    ok(isFinite(parseFloat(f.sz)) && parseFloat(f.px) > 0 && isFinite(parseFloat(f.fee)));
    ok(typeof f.startPosition === 'string' && isFinite(parseFloat(f.closedPnl)));
    ok(f.time <= NOW);
  }
  ok(a.some(f => f.coin === 'PURR/USDC'), 'spot pair present');
});
t('demo fills reconstruct into a plausible closed-trade history', () => {
  const fills = demoFills(1, NOW);
  const perp = reconstructTrades(fills, 'demo', 'perp');
  const closed = perp.filter(x => !x.isOpen);
  ok(closed.length >= 40, 'months of round trips, got ' + closed.length);
  eq(perp.filter(x => x.isOpen).length, 0, 'every perp round trip closes — no phantom opens');
  const wins = closed.filter(x => (x.pnl - x.fees) > 50).length; // net is finalized later; pnl−fees is the demo's net
  const wr = wins / closed.length;
  ok(wr > 0.3 && wr < 0.7, 'win rate plausible, got ' + wr.toFixed(2));
  const spot = reconstructTrades(fills, 'demo', 'spot');
  ok(spot.length >= 1 && spot.some(x => x.coin === 'PURR/USDC'), 'spot position reconstructed');
});

report('features5');
