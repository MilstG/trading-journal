// The walk-forward panel's presentation layer. The engine (walkForward) is covered elsewhere;
// this pins the chart and the wording, because that is where this panel kept going wrong:
//   - the original inline SVG used preserveAspectRatio="none" over a min-120 viewBox, so with a
//     handful of blocks x stretched ~10x while y stretched 1x: 210px-wide bar slabs, and any block
//     under ~5% of the max collapsed into a 0.6px hairline;
//   - it plotted only the realized number, hiding the comparison that is the panel's entire point;
//   - a flat reference line duplicated itself into every index tooltip;
//   - retention is wfExp/fullIS, so a negative forward edge rendered as "-62% of in-sample kept".
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { t, ok, eq, near, report, makeExtractor } from './harness.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '..', 'ledger.html'), 'utf8');
const { grabFn } = makeExtractor(html);

// Minimal environment: real walkForward + real wireWalkForward, stubbed Chart/DOM/formatters.
const env = (0, eval)(`(() => {
  const _avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
  const bootstrapMeanCI = a => ({ lo: _avg(a) - 10, hi: _avg(a) + 10 });
  const fmtUsd = n => (n < 0 ? '-$' : '$') + Math.abs(n).toFixed(2);
  const fmtDate = ms => new Date(ms).toISOString().slice(5, 10);
  const signCol = arr => arr.map(v => v >= 0 ? 'GREEN' : 'RED');
  const TXT = '#5C6578', GRID = 'grid';
  function scales(x = {}) { return { x: { ...x }, y: {} }; }
  const _diagCharts = {};
  const $ = id => ({ id });
  let cfg = null, made = 0;
  class Chart { constructor(el, c) { cfg = c; made++; } destroy() {} }
  ${grabFn('walkForward')}
  ${grabFn('wireWalkForward')}
  return { walkForward, wireWalkForward, _diagCharts, cfg: () => cfg, made: () => made };
})()`);

// A decaying edge: strong for 100 trades, then negative. Blocks must therefore differ in sign,
// which is exactly the case the old hairline rendering made invisible.
const DECAY = [];
{
  const t0 = Date.UTC(2026, 0, 1);
  for (let i = 0; i < 200; i++) DECAY.push({ net: (i < 100 ? 60 : -25) + ((i * 37) % 23 - 11) * 8, closeTime: t0 + i * 86400e3, isOpen: false });
}
const wf = env.walkForward(DECAY);
const cfgFor = w => { env.wireWalkForward(w); return env.cfg(); };

console.log('\nThe regression that prompted the rewrite');
t('no non-uniform SVG stretching survives anywhere in the app', () => {
  const live = html.split('\n').filter(l => l.includes('preserveAspectRatio="none"') && !l.trimStart().startsWith('//'));
  eq(live, [], 'preserveAspectRatio="none" distorts bar geometry — use a real chart');
});
t('the panel renders a canvas with a bounded height, not a hand-rolled sparkline', () => {
  ok(html.includes('<canvas id="wfChart">'), 'no chart canvas');
  ok(/height:180px[^"]*"><canvas id="wfChart"/.test(html), 'canvas needs a sized parent to lay out');
  ok(!html.includes('const bars=vals.map('), 'the old rect-building sparkline is still present');
});

console.log('\nChart contents');
t('both realized and predicted are plotted — the comparison is the point', () => {
  const c = cfgFor(wf);
  const labels = c.data.datasets.map(d => d.label);
  ok(labels.some(l => /realized/.test(l)), 'realized series missing');
  ok(labels.some(l => /predicted/.test(l)), 'predicted series missing — the panel would show no gap');
  eq(c.data.datasets[0].data, wf.points.map(p => p.osExp));
  eq(c.data.datasets[1].data, wf.points.map(p => p.isExp));
  eq(c.data.labels.length, wf.blocks);
});
t('bars are sign-coloured and width-capped so few blocks do not become slabs', () => {
  const c = cfgFor(wf);
  eq(c.data.datasets[0].type, 'bar');
  ok(c.data.datasets[0].maxBarThickness > 0 && c.data.datasets[0].maxBarThickness <= 60);
  const realized = wf.points.map(p => p.osExp);
  eq(c.data.datasets[0].backgroundColor, realized.map(v => v >= 0 ? 'GREEN' : 'RED'));
  ok(realized.some(v => v > 0) && realized.some(v => v < 0), 'fixture must span both signs');
});
t('a small block is a readable bar, not a sub-pixel hairline', () => {
  const realized = wf.points.map(p => p.osExp);
  const mx = Math.max(...realized.map(Math.abs));
  const smallest = Math.min(...realized.map(Math.abs));
  ok(smallest / mx < 0.5, 'fixture must contain a block well below the max');
  const c = cfgFor(wf);
  ok(c.data.datasets[0].data.includes(realized.find(v => Math.abs(v) === smallest)),
    'small blocks keep their true value; the axis scales them, not a clamped pixel height');
  ok(!/Math\.max\(0\.6,/.test(html), 'the 0.6px height clamp that produced hairlines is back');
});
t('the walk-forward mean is drawn as a flat reference', () => {
  const c = cfgFor(wf);
  const mean = c.data.datasets.find(d => d.label === 'walk-forward mean');
  ok(mean, 'no mean reference line');
  eq(new Set(mean.data).size, 1, 'reference line must be flat');
  near(mean.data[0], wf.wfExp);
  eq(mean.pointRadius, 0);
});

console.log('\nTooltips');
t('the flat reference is filtered out of the index tooltip', () => {
  const c = cfgFor(wf);
  const f = c.options.plugins.tooltip.filter;
  ok(typeof f === 'function', 'no tooltip filter — the mean repeats in every tooltip');
  eq(f({ dataset: { label: 'walk-forward mean' } }), false);
  eq(f({ dataset: { label: 'realized (out-of-sample)' } }), true);
});
t('the footer states the per-block miss in plain English, correctly signed', () => {
  const c = cfgFor(wf);
  const cb = c.options.plugins.tooltip.callbacks;
  const gaps = wf.points.map((p, i) => ({ i, gap: p.isExp - p.osExp }));
  const worst = gaps.slice().sort((a, b) => b.gap - a.gap)[0];
  const best = gaps.slice().sort((a, b) => a.gap - b.gap)[0];
  ok(worst.gap > 0 && best.gap < 0, 'fixture must contain both an overshoot and an undershoot');
  ok(/worse than predicted/.test(cb.footer([{ dataIndex: worst.i }])));
  ok(/better than predicted/.test(cb.footer([{ dataIndex: best.i }])));
  ok(!/-\$/.test(cb.footer([{ dataIndex: worst.i }])), 'direction is in the words, so drop the sign');
  ok(/\b\d+ trades? scored\b/.test(cb.footer([{ dataIndex: 0 }])), 'block size belongs in the footer');
});
t('the title identifies which block, since blocks are the unit of the whole panel', () => {
  const cb = cfgFor(wf).options.plugins.tooltip.callbacks;
  eq(cb.title([{ dataIndex: 0 }]), 'Block 1 of ' + wf.blocks + ' \u00b7 ends ' + cfgFor(wf).data.labels[0]);
});

console.log('\nLifecycle');
t('the chart is registered for teardown like every other diagnostic chart', () => {
  cfgFor(wf);
  ok(Object.keys(env._diagCharts).includes('wf'), 'a leaked instance fires tooltips on stale data');
  ok(html.includes('wireWalkForward(wf);'), 'never wired from renderDiagnostic');
});
t('wiring is inert when there is nothing to draw', () => {
  const before = env.made();
  env.wireWalkForward(null);
  env.wireWalkForward({ points: [] });
  env.wireWalkForward({});
  eq(env.made(), before, 'must not construct a Chart with no data');
});

t('the canvas is composed inside the card so both exports title it correctly', () => {
  // exportReport clones #diagView canvases into <img>; exportDiagPdf rasterises '#diagView canvas'
  // and titles each from cv.closest('.diag-card,.card') h3/h2. The old inline SVG appeared in
  // neither export; a canvas is picked up by both for free, but only if it ends up nested inside
  // the card carrying the heading. `spark` is built above the card template and interpolated into
  // it, so source order proves nothing -- check the composition, not the byte offsets.
  ok(/const spark=`<div style="height:\d+px[^`]*<canvas id="wfChart">/.test(html),
    'the canvas must live in the spark fragment');
  const card = html.indexOf('<div class="diag-card" data-tip="Trains on a trailing window');
  const h3 = html.indexOf('<h3>Walk-forward reality', card);
  const spark = html.indexOf('${spark}', h3);
  const close = html.indexOf('</div></div>`;', h3);
  ok(card > 0 && card < h3 && h3 < spark && spark < close,
    'spark must be interpolated inside the card, after its heading');
  ok(html.includes("document.querySelectorAll('#diagView canvas')"), 'pdf export no longer enumerates canvases');
  ok(html.includes("srcEl.querySelectorAll('canvas')"), 'report export no longer enumerates canvases');
});

console.log('\nWording the sign logic instead of leaving it to the reader');
t('in-sample optimism is labelled overstates / understates / calibrated', () => {
  ok(html.includes('in-sample overstates') && html.includes('in-sample understates'),
    'a negative optimism reading is not self-explanatory');
  ok(html.includes('>calibrated<'), 'a near-zero gap deserves its own verdict');
});
t('retention never claims a negative share was "kept"', () => {
  ok(wf.fullIS > 0 && wf.wfExp < 0, 'fixture must produce negative retention');
  ok(wf.retention < 0);
  ok(html.includes('forward edge is negative'), 'negative retention must be worded, not printed as %');
  ok(!html.includes("`${(wf.retention*100).toFixed(0)}% of in-sample kept`"),
    'the unguarded retention string is back');
});

report('walk-forward panel');
