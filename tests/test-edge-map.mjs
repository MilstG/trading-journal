// Tests for the scanner condition split: partitionConditions() + _wilson().
// The old panel sliced top-5/bottom-5 from the same rows and sorted "worst" by the UPPER
// Wilson bound, so conditions appeared in both lists and well-sampled winners landed in the
// loser panel. These lock the corrected contract: classify once, partition disjointly,
// one expectancy spine, deterministic order. Functions are extracted from ledger.html.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { t, ok, eq, near, report, makeExtractor } from './harness.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '..', 'ledger.html'), 'utf8');
const { evalFn } = makeExtractor(html);

const _wilson = evalFn('_wilson');
const partitionConditions = evalFn('partitionConditions');

// Build a row the way probabilityScan does: Wilson from the win count, expectancy in basis.
function mk(name, n, winRate, exp){
  const wl = _wilson(Math.round(winRate * n), n);
  return { name, n, w: Math.round(winRate * n), wr: wl.p, lo: wl.lo, hi: wl.hi, exp };
}
const names = arr => arr.map(x => x.name);

// The real surviving conditions from the screenshot.
const REAL = () => [
  mk('08-16h local', 29, 0.72, 0.53),
  mk('Long trades', 47, 0.68, 0.49),
  mk('Weekdays', 45, 0.67, 0.40),
  mk('After 2+ wins', 20, 0.70, 0.47),
  mk('Chased entries', 15, 0.67, 0.17),
  mk('16-24h local', 19, 0.47, -0.08),
  mk('4th-or-later', 21, 0.62, 0.70),
];

console.log('\nWilson interval (reproduces the displayed CIs)');
t('n=29,k=21 -> ~54-85%', () => { const w = _wilson(21, 29); near(w.lo, 0.543, 0.01); near(w.hi, 0.853, 0.01); });
t('n=47,k=32 -> ~54-80%', () => { const w = _wilson(32, 47); near(w.lo, 0.538, 0.01); near(w.hi, 0.796, 0.01); });
t('n=19,k=9 -> ~27-68%',  () => { const w = _wilson(9, 19);  near(w.lo, 0.273, 0.01); near(w.hi, 0.683, 0.01); });
t('n=0 returns null (guarded)', () => ok(_wilson(0, 0) === null));

console.log('\nClassification rules');
t('positive edge + floor >= 50% -> edge', () => {
  const { best } = partitionConditions([mk('x', 45, 0.67, 0.40)]);
  ok(best[0].state === 'edge' && best[0].tone === 'ok');
});
t('positive edge + floor < 50% -> fragile', () => {
  const { worst } = partitionConditions([mk('x', 20, 0.70, 0.47)]);
  ok(worst[0].state === 'fragile' && worst[0].tone === 'mid');
  ok(worst[0].lo < 0.5);
});
t('negative expectancy -> losing, even at 80% win rate', () => {
  const { worst } = partitionConditions([mk('x', 30, 0.80, -0.10)]);
  ok(worst[0].state === 'losing' && worst[0].tone === 'no'); // hit rate does not rescue negative edge
});
t('expectancy exactly 0 is losing (break-even is not an edge)', () => {
  const { worst } = partitionConditions([mk('x', 50, 0.90, 0)]);
  ok(worst[0].state === 'losing');
});
t('fragile note flags a thin sample', () => {
  const { worst } = partitionConditions([mk('x', 20, 0.70, 0.47)]);
  ok(/n=20/.test(worst[0].note), worst[0].note);
});

console.log('\nPartition invariants');
t('every condition on exactly one side (no dupes, no drops)', () => {
  const rows = REAL();
  const { best, worst } = partitionConditions(rows);
  ok(best.length + worst.length === rows.length, 'counts');
  ok(new Set([...names(best), ...names(worst)]).size === rows.length, 'unique across sides');
});
t('lean-in holds only edges; ease-off holds no edges', () => {
  const { best, worst } = partitionConditions(REAL());
  ok(best.every(x => x.state === 'edge'));
  ok(worst.every(x => x.state !== 'edge'));
});

console.log('\nOrdering (single expectancy spine)');
t('lean-in sorted by expectancy descending', () => {
  const { best } = partitionConditions(REAL());
  for (let i = 1; i < best.length; i++) ok(best[i-1].exp >= best[i].exp);
});
t('ease-off sorted ascending, loser floats to top', () => {
  const { worst } = partitionConditions(REAL());
  for (let i = 1; i < worst.length; i++) ok(worst[i-1].exp <= worst[i].exp);
  ok(worst[0].state === 'losing');
});

console.log('\nDeterminism');
t('equal expectancy breaks on Wilson floor (tighter CI first)', () => {
  const { best } = partitionConditions([ mk('wide', 45, 0.70, 0.30), mk('tight', 100, 0.70, 0.30) ]);
  eq(names(best), ['tight', 'wide']);
});
t('stable under input shuffle', () => {
  const a = partitionConditions(REAL());
  const b = partitionConditions([...REAL()].reverse());
  eq(names(a.best), names(b.best));
  eq(names(a.worst), names(b.worst));
});

console.log('\nSnapshot (real conditions)');
t('3 edges / 4 to ease off', () => {
  const { best, worst } = partitionConditions(REAL());
  ok(best.length === 3 && worst.length === 4, `${best.length}/${worst.length}`);
});
t('lean-in order', () => eq(names(partitionConditions(REAL()).best), ['08-16h local', 'Long trades', 'Weekdays']));
t('ease-off order', () => eq(names(partitionConditions(REAL()).worst), ['16-24h local', 'Chased entries', 'After 2+ wins', '4th-or-later']));

report();
