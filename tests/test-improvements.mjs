// Tests for the analytics improvements added on top of the shipped build:
//   #1 walkForward   — rolling out-of-sample expectancy vs in-sample (edge decay / overfit)
//   #2 diagScan FDR  — one-sample t + Benjamini-Hochberg gate so quick-look ≠ noise
//   #3 kellyHaircut  — autocorrelation-aware shrink of the suggested Kelly fraction
//   #4 riskConcentration — correlation-aware one-sided-book flag for the open-risk panel
// Every function is extracted straight from ledger.html so the tests exercise what ships.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '..', 'ledger.html'), 'utf8');

import { t, ok, eq, near, report, makeExtractor } from './harness.mjs';
const { evalFn } = makeExtractor(html);

// --- environment the extracted pure functions expect ---
globalThis._avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
globalThis._rng = Math.random;
globalThis.isWin  = n => n > 0;
globalThis.isLoss = n => n < 0;
globalThis._srand = evalFn('_srand');
globalThis._hashSeed = evalFn('_hashSeed');
globalThis._erf = evalFn('_erf');
globalThis._normCdf = z => 0.5 * (1 + _erf(z / Math.SQRT2));
globalThis.bootstrapMeanCI = evalFn('bootstrapMeanCI');

const walkForward = evalFn('walkForward');
const kellyHaircut = evalFn('kellyHaircut');
const riskConcentration = evalFn('riskConcentration');
const openRiskModel = evalFn('openRiskModel');
const diagScan = evalFn('diagScan');

const T = (net, i) => ({ net, closeTime: 1000 + i * 1000, isOpen: false });

console.log('walkForward');
await t('null below the 20-trade floor', () => {
  eq(walkForward([], {}), null);
  eq(walkForward(Array.from({ length: 19 }, (_, i) => T(10, i)), {}), null);
});
await t('flat +100 edge: walk-forward == in-sample, zero optimism, holds', () => {
  const trades = Array.from({ length: 60 }, (_, i) => T(100, i));
  const wf = walkForward(trades, { train: 20, step: 10 });
  ok(wf, 'null result');
  near(wf.fullIS, 100);
  near(wf.wfExp, 100);
  near(wf.optimism, 0);
  eq(wf.holds, true);
  near(wf.retention, 1);
  // origins 20,30,40,50 with train20/step10 over N=60 -> 4 non-overlapping test blocks
  eq(wf.blocks, 4);
  eq(wf.oosN, 40);
});
await t('decaying edge: in-sample overstates (optimism>0), retention<1', () => {
  // strong early, weak late — sliding windows should reveal the fade out-of-sample
  const trades = Array.from({ length: 60 }, (_, i) => T(i < 30 ? 100 : -40, i));
  const wf = walkForward(trades, { train: 20, step: 10 });
  ok(wf.fullIS > wf.wfExp, 'walk-forward should trail in-sample: ' + wf.wfExp + ' vs ' + wf.fullIS);
  ok(wf.optimism > 0, 'optimism should be positive, got ' + wf.optimism);
});
await t('every out-of-sample block is non-overlapping and tiles forward', () => {
  const trades = Array.from({ length: 45 }, (_, i) => T(10 + (i % 3), i));
  const wf = walkForward(trades, { train: 20, step: 5 });
  eq(wf.oosN, wf.blocks * wf.step);
  const ord = wf.points.map(p => p.i);
  eq(ord, [...ord].sort((a, b) => a - b)); // origins strictly increasing
});
await t('deterministic CI under a fixed seed (regression: reproducible bootstrap)', () => {
  const trades = Array.from({ length: 60 }, (_, i) => T((i * 37) % 200 - 90, i));
  _srand(_hashSeed('wf:60')); const a = walkForward(trades, { train: 20, step: 10 });
  _srand(_hashSeed('wf:60')); const b = walkForward(trades, { train: 20, step: 10 });
  eq(a.wfCI, b.wfCI);
  ok(a.wfCI && typeof a.wfCI.lo === 'number', 'CI present with >=8 oos trades');
});

console.log('\nkellyHaircut');
await t('no autocorrelation -> no haircut', () => {
  const h = kellyHaircut(0.08, 0);
  near(h.factor, 1); near(h.adjusted, 0.08);
});
await t('positive autocorrelation shrinks by (1-acf1)', () => {
  const h = kellyHaircut(0.10, 0.3);
  near(h.factor, 0.7); near(h.adjusted, 0.07);
});
await t('strong clustering is floored at x0.4 (never wipes a positive edge)', () => {
  const h = kellyHaircut(0.10, 0.9);
  near(h.factor, 0.4); near(h.adjusted, 0.04);
});
await t('negative autocorrelation is treated as zero (no bonus sizing)', () => {
  const h = kellyHaircut(0.10, -0.5);
  near(h.factor, 1); near(h.adjusted, 0.10);
});
await t('non-positive fraction passes through untouched', () => {
  eq(kellyHaircut(0, 0.5).factor, 1);
  eq(kellyHaircut(null, 0.5).adjusted, null);
});

console.log('\nriskConcentration');
const pos = (coin, szi, value) => ({ coin, szi, value, liq: null, uPnl: 0 });
await t('one-sided multi-name long book is flagged clustered', () => {
  const m = openRiskModel([pos('BTC', 1, 100), pos('ETH', 1, 100), pos('SOL', 1, 100)]);
  const c = riskConcentration(m);
  eq(c.clustered, true); eq(c.side, 'long'); eq(c.longs, 3); eq(c.shorts, 0);
  near(c.dirRatio, 1);
});
await t('hedged book (equal long/short) is not clustered', () => {
  const m = openRiskModel([pos('BTC', 1, 100), pos('ETH', -1, 100)]);
  const c = riskConcentration(m);
  eq(c.clustered, false); near(c.dirRatio, 0);
});
await t('a single position is never a cluster', () => {
  const m = openRiskModel([pos('BTC', 1, 100)]);
  eq(riskConcentration(m).clustered, false);
});
await t('short-heavy but under the 60% threshold is not flagged', () => {
  // gross 300, net -100 -> dirRatio 0.33
  const m = openRiskModel([pos('BTC', -1, 200), pos('ETH', 1, 100)]);
  const c = riskConcentration(m);
  ok(c.dirRatio < 0.6); eq(c.clustered, false);
});
await t('null model -> null', () => { eq(riskConcentration(null), null); });

console.log('\ndiagScan FDR gate');
// diagScan calls the GLOBAL bucketize + edgeLabel; stub them to feed controlled buckets so the
// real significance + Benjamini-Hochberg code runs against known inputs. One true edge (huge t)
// plus pure-noise buckets (mean ~0, wide sd) — only the real edge may clear the q<0.10 gate.
globalThis.edgeLabel = d => d;
const mkBucket = (key, expectancy, sd, n) => ({ key, n, wins: Math.round(n * 0.6), losses: Math.round(n * 0.4),
  net: expectancy * n, sd, winRate: 0.6, expectancy, avgR: null });
await t('a real edge clears the gate; noise buckets do not', () => {
  const fake = {
    dir:    [mkBucket('Long', 500, 300, 80)],   // t ~ 500/(300/√80) ≈ 14.9 -> p≈0
    market: [mkBucket('perp', 2, 800, 60)],      // t ~ 0.02 -> p≈0.98 noise
    dow:    [mkBucket('Mon', -3, 700, 50)],      // noise
    hour:   [mkBucket('00-04', 5, 900, 40)],     // noise
  };
  globalThis.bucketize = (closed, dim) => fake[dim] ? fake[dim].map(b => ({ ...b })) : [];
  const closed = Array.from({ length: 200 }, () => ({ net: 1 })); // only length matters (MIN)
  const r = diagScan(closed);
  const strongEdge = r.strong.find(b => b.key === 'Long');
  ok(strongEdge, 'the real edge should appear in strong');
  eq(strongEdge.sig, true, 'the real edge must clear the FDR gate');
  const noiseSig = r.strong.concat(r.weak).filter(b => b.key !== 'Long' && b.sig);
  eq(noiseSig.length, 0, 'no noise bucket may be marked confirmed');
  eq(r.fdrQ, 0.10);
});
await t('all-noise scan confirms nothing', () => {
  const fake = {
    dir:    [mkBucket('Long', 4, 900, 50)],
    market: [mkBucket('perp', -6, 850, 55)],
    dow:    [mkBucket('Fri', 3, 950, 45)],
  };
  globalThis.bucketize = (closed, dim) => fake[dim] ? fake[dim].map(b => ({ ...b })) : [];
  const r = diagScan(Array.from({ length: 200 }, () => ({ net: 1 })));
  eq(r.strong.concat(r.weak).filter(b => b.sig).length, 0);
});

report();
