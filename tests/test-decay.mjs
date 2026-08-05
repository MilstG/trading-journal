// Edge decay tracker: cusumDrift + decayAssess, extracted verbatim from ledger.html.
// Pins the detector semantics: forward-only scoring, band vs discovery CI, CUSUM drift,
// three-state verdict, direction-awareness for pinned leaks, and the addPin CI capture shape.
import fs from 'node:fs';
import { t, ok, eq, near, report, makeExtractor } from './harness.mjs';

const html = fs.readFileSync(new URL('../ledger.html', import.meta.url), 'utf8');
const { grabFn } = makeExtractor(html);

// decayAssess needs _avg/_std/cusumDrift in scope — evaluate them together.
const src = `
const _avg=a=>a.length?a.reduce((x,y)=>x+y,0)/a.length:0;
const _std=a=>{ if(a.length<2)return 0; const m=_avg(a); return Math.sqrt(a.reduce((s,x)=>s+(x-m)*(x-m),0)/(a.length-1)); };
${grabFn('cusumDrift')}
${grabFn('decayAssess')}
export { cusumDrift, decayAssess };
`;
const { cusumDrift, decayAssess } = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));

const disc = { exp: 10, n: 60, ci: [4, 16] };   // discovered +$10/trade, CI floor $4
const rep2 = (a, k) => Array.from({length: k}, (_, i) => a[i % a.length]);

t('cusumDrift quiet when forward matches discovery', () => {
  const r = cusumDrift(rep2([9, 11, 10, 12, 8], 40), 10, 1);
  ok(!r.trip, 'should not trip');
  ok(r.stat < 4, 'stat stays under threshold');
});

t('cusumDrift trips on a sustained shortfall', () => {
  // forward mean far under the reference: every step adds ~positive drift
  const r = cusumDrift(rep2([-5, 0, -3, 2, -4], 40), 10, 1);
  ok(r.trip, 'must trip');
  ok(r.max >= 4);
  eq(r.series.length, 40);
});

t('cusumDrift sign=-1 tracks a leak healing, not fading', () => {
  // pinned leak at -10/trade; forward trades still around -10 => leak persists => quiet
  ok(!cusumDrift(rep2([-9, -11, -10], 30), -10, -1).trip);
  // forward trades near +2 => leak healed => drift trips
  ok(cusumDrift(rep2([2, 1, 3], 30), -10, -1).trip);
});

t('cusumDrift never goes negative and is one-sided', () => {
  // forward far ABOVE reference: deviations all favorable, stat pinned at 0
  const r = cusumDrift(rep2([30, 28, 32], 30), 10, 1);
  eq(r.stat, 0); eq(r.max, 0); ok(!r.trip);
});

t('decayAssess collecting below minN', () => {
  const r = decayAssess([5, 6, 7], disc);
  eq(r.status, 'collecting'); eq(r.n, 3);
  near(r.fwdExp, 6);
  ok(r.cusum === null);
});

t('decayAssess healthy when forward stays inside the band', () => {
  const r = decayAssess(rep2([9, 12, 8, 11, 10], 30), disc);
  eq(r.status, 'healthy');
  eq(r.trailing, 0);
  eq(r.bandLo, 4, 'band floor = discovery CI lower bound');
  eq(r.roll.length, 30);
});

t('decayAssess dead when both detectors trip', () => {
  const r = decayAssess(rep2([-6, -2, -8, 0, -4], 40), disc);
  eq(r.status, 'dead');
  ok(r.trailing >= 4, 'band breached at the tail');
  ok(r.cusum.trip, 'cusum tripped');
});

t('decayAssess dead on adverse forward expectancy with n>=15 alone', () => {
  // slightly negative forward mean but high variance keeps individual detectors honest;
  // the adverse-expectancy override still declares it dead
  const nets = rep2([-40, 38, -41, 39, -2], 20); // mean < 0
  const r = decayAssess(nets, disc);
  ok(r.fwdExp <= 0);
  eq(r.status, 'dead');
});

t('decayAssess degrading on one detector only', () => {
  // forward mean just under the CI floor with high variance: rolling band breaches
  // while CUSUM (standardized by the wide forward sd) stays quiet => degrading, not dead
  const nets = rep2([33, -26, 34, -27, 3.5], 40); // mean ~3.5, sd ~28, band floor 4
  const r = decayAssess(nets, disc);
  ok(!r.cusum.trip, 'cusum quiet under high variance');
  ok(r.trailing >= 4, 'band detector tripped');
  eq(r.status, 'degrading');
});

t('decayAssess recovery heals the band detector', () => {
  // early slump then full recovery: trailing consecutive breaches reset to 0
  const nets = rep2([-5, -6, -4], 20).concat(rep2([12, 14, 11, 13], 40));
  const r = decayAssess(nets, disc);
  eq(r.trailing, 0, 'trailing breach count resets after recovery');
  ok(r.status !== 'dead');
});

t('decayAssess without a CI falls back to half the discovered edge', () => {
  const r = decayAssess(rep2([9, 11, 10], 30), { exp: 10, n: 60, ci: null });
  eq(r.bandLo, 5);
  eq(r.status, 'healthy');
});

t('decayAssess direction-aware for pinned leaks', () => {
  const leak = { exp: -10, n: 40, ci: [-16, -4] };
  // leak persists (still ~-10/trade): the pinned hypothesis holds => healthy
  eq(decayAssess(rep2([-9, -11, -10], 30), leak).status, 'healthy');
  // leak healed (forward ~+8/trade): sign-adjusted edge collapsed => dead
  eq(decayAssess(rep2([8, 7, 9], 30), leak).status, 'dead');
  // bandLo is reported in original units: -(-ci[1]) => -(-(-4))... floor is -(-4)=4 sign-adjusted, -4 raw
  eq(decayAssess(rep2([-9, -11, -10], 30), leak).bandLo, -4);
});

t('decayAssess deterministic: same input, same output', () => {
  const nets = rep2([3, -2, 7, 1, -4, 9], 40);
  eq(decayAssess(nets, disc), decayAssess(nets, disc));
});

t('rolling window respects opts.window', () => {
  const nets = [0, 0, 0, 0, 100, 100, 100, 100, 100, 100];
  const r = decayAssess(nets, disc, { window: 3, minN: 8 });
  near(r.roll[9], 100, 1e-9, 'last rolling mean sees only the trailing 3');
});

t('addPin stores the discovery CI when present', () => {
  const src = grabFn('addPin');
  ok(src.includes('ci:'), 'addPin captures ci');
  ok(src.includes("isFinite(v.ci[0])"), 'validates ci bounds');
});

t('trackedSectionHtml scores forward-only (post-pinnedAt) trades', () => {
  const src = grabFn('trackedSectionHtml');
  ok(src.includes('t.closeTime>pin.pinnedAt'), 'discovery-date filter intact');
  ok(src.includes('decayAssess(fwd.map(Vv)'), 'decay layer runs on the same forward set');
  ok(src.includes('pin-arch'), 'archive control rendered');
});

t('server engine registers the decay functions', () => {
  const server = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
  ok(server.includes("'cusumDrift', 'decayAssess',"), 'ENGINE_FNS parity');
});

report('decay');
