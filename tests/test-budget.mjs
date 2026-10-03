// Size budgets for what each screen downloads, measured as the server sends it: the page plus the
// app/ scripts that page loads, each gzipped. The journal (/) and Daruma (/daruma) get different script
// lists, so each has its own budget and a failure names the screen that grew. The fonts are files
// of their own (cached for a year, and only the faces a screen uses are fetched), with a budget of
// their own. Raising a budget is fine: do it in the same change that needs it, and say why.
import { readFileSync, mkdtempSync, readdirSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { t, ok, report } from './harness.mjs';

const require = createRequire(import.meta.url);
const { createApp } = require('../server.js');
const root = new URL('..', import.meta.url).pathname;
const KB = 1024;
const app = createApp({ dataDir: mkdtempSync(join(tmpdir(), 'ledger-budget-')), auth: '', htmlPath: join(root, 'ledger.html'), push: false, pushTick: false, offsiteTimer: false });
const B = await new Promise(r => app.listen(0, () => r('http://127.0.0.1:' + app.address().port)));
const served = async path => {
  const html = await (await fetch(B + path)).text();
  const scripts = [...html.matchAll(/<script src="(app\/[^"]+)"/g)].map(m => m[1]);
  let raw = Buffer.byteLength(html), gz = gzipSync(html).length;
  for (const s of scripts) { const b = Buffer.from(await (await fetch(B + '/' + s)).arrayBuffer()); raw += b.length; gz += gzipSync(b).length; }
  return { html, scripts, raw: raw / KB, gz: gz / KB };
};
try {
  const journal = await served('/'), keel = await served('/daruma');
  const BUDGETS = [ // name, measured, raw KB, gzipped KB
    // Oct 2026: fonts moved out of the page and each screen got its own script list. Before, one page
    // carried everything: 1917 KB raw / 734 KB gzipped against 1950 / 740.
    // Oct 2026: +50 KB raw each for the mentor directory, mentor rates and the send-to-a-mentor sheet
    // (about 22 KB); both screens were within 3 KB of the old 1800 / 1600. Gzipped budgets unchanged.
    ['the journal (/: page + ' + journal.scripts.length + ' scripts)', journal, 1850, 620],
    ['Daruma (/daruma: page + ' + keel.scripts.length + ' scripts, no Chart.js)', keel, 1650, 560],
  ];
  t('each screen loads its code from app/, and Daruma leaves Chart.js out', () => {
    ok(journal.scripts.length > 10 && keel.scripts.length > 10);
    ok(journal.scripts.some(s => s.startsWith('app/chart.umd.js')), 'the journal draws charts');
    ok(!keel.scripts.some(s => s.startsWith('app/chart.umd.js')), 'Daruma never does');
  });
  t('no font is embedded in the page any more', () => {
    for (const p of [journal, keel]) { ok(!p.html.includes('data:font/'), 'a data: font in the page'); ok(/url\(app\/fonts\/inter-400\.woff2\?v=[0-9a-f]{12}\)/.test(p.html), 'fonts are versioned files'); }
  });
  for (const [name, m, rawMax, gzMax] of BUDGETS) {
    t(`${name}: ${m.raw.toFixed(0)} KB raw (budget ${rawMax}), ${m.gz.toFixed(0)} KB gzipped (budget ${gzMax})`, () => {
      ok(m.raw <= rawMax, `${name} is ${m.raw.toFixed(0)} KB raw — over its ${rawMax} KB budget`);
      ok(m.gz <= gzMax, `${name} is ${m.gz.toFixed(0)} KB gzipped — over its ${gzMax} KB budget`);
    });
  }
  // every face, though a screen only fetches the ones its text uses (woff2 is compressed already)
  const fontDir = join(root, 'app', 'fonts'), fonts = readdirSync(fontDir).filter(f => f.endsWith('.woff2'));
  const fontKB = fonts.reduce((a, f) => a + statSync(join(fontDir, f)).size, 0) / KB;
  t(`fonts (${fonts.length} faces): ${fontKB.toFixed(0)} KB (budget 180)`, () => ok(fontKB <= 180, `fonts are ${fontKB.toFixed(0)} KB — over their 180 KB budget`));
  // each feature in app/features/ is its own file with its own budget: 40 KB raw, 12 KB gzipped unless listed here
  // trader-age.js: the habit list (every habit's band and what it's worth) and the then-and-now table
  const FEATURE_BUDGETS = { 'trader-age.js': [52, 16] };
  const featDir = join(root, 'app', 'features');
  for (const f of readdirSync(featDir).filter(f => f.endsWith('.js'))) {
    const b = readFileSync(join(featDir, f)), [rMax, gMax] = FEATURE_BUDGETS[f] || [40, 12], r = b.length / KB, g = gzipSync(b).length / KB;
    t(`feature ${f}: ${r.toFixed(1)} KB raw (budget ${rMax}), ${g.toFixed(1)} KB gzipped (budget ${gMax})`, () => { ok(r <= rMax); ok(g <= gMax); });
  }
  // the owner's panel only (never sent to members): 100 → 200 KB raw with Insights, bulk actions and the seed table (Oct 2026)
  const admin = readFileSync(join(root, 'admin.html')), aRaw = admin.length / KB, aGz = gzipSync(admin).length / KB;
  t(`admin.html: ${aRaw.toFixed(0)} KB raw (budget 200), ${aGz.toFixed(0)} KB gzipped (budget 60)`, () => { ok(aRaw <= 200); ok(aGz <= 60); });
} finally { await new Promise(r => app.close(r)); }
report('budget');
