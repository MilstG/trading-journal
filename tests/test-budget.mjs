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
    // Oct 2026: the TS9 colorway (two CSS blocks) and the drawn daruma mark took the raw sizes past the
    // old lines by a few KB; gzipped sizes barely moved (607 / 539 against 620 / 560), so only raw moves.
    // Oct 2026: the mentor directory, rates and the send-to-a-mentor sheet (about 22 KB raw) fit under
    // these lines: 1836 / 1636 raw, 617 / 549 gzipped.
    // Oct 2026: restores that survive a 409 (srvRestored / srvSaveNow) and the pasted-fill derivation: 621 KB gzipped.
    // Oct 2026: the XP game's award ledger, swap-day grading and distinct-badge counts (audit 4, about 12 KB raw)
    // took both screens past their raw lines and the journal past its gzipped one: 1853 / 1653 raw, 623 / 555 gzipped.
    // Oct 2026: outcome-blind routine score, timestamped logging and fill-by-fill loss limits (AUDIT-4 E1–E5,
    // X4, X10) with their comments: about 4 KB raw / 3 KB gzipped on each screen (1854 / 1654, 623 / 555).
    // Oct 2026: the heavy-account work (AUDIT-4 P1/P2: the Diagnostic's worker batch and memos, lazy
    // below-the-fold charts and sections, the near-linear Trader Age history) is ~17 KB raw / ~6 KB
    // gzipped, about half of it comments: 1858 / 1657 raw, 625 / 557 gzipped.
    // Oct 2026: the Diagnostic view, the excursion/miner panels and replay chart, and the exports moved
    // to journal-only files (diagnostic-view.js, excursions-view.js, exports.js): Daruma 1657 -> 1479 KB
    // raw, 557 -> 495 KB gzipped; the journal pays ~2 KB gzipped for three more files compressed apart.
    // All of audit 4 together (correctness fixes, the performance work, Daruma's split): 1895 / 1514 raw,
    // 642 / 509 gzipped — Daruma still 48 KB gzipped under where it started.
    // Oct 2026: the beta's honest-stats fixes (CSV delimiter / decimal-mark / date-order inference with
    // named errors, the automatic break-even band, the shared edge test) add ~8 KB raw / ~2 KB gzipped
    // to both screens, most of it the CSV importer (data-io.js loads on both): 1908 / 1526 raw, 647 / 514 gzipped.
    // Oct 2026: journal beta fixes (autosave for the trade, day and week journals, the trade-plan check, tag
    // de-duplication, the drawer pinned to the screen on phones, calendar labels, tooltip and Escape handling):
    // about 11 KB raw / 3 KB gzipped, a third of it comments: 1906 / 1525 raw, 646 / 513 gzipped.
    // Oct 2026: sync merges an entry both devices edited field by field, a tab notices another device's
    // save, and the sync bar warns about a server without AUTH_TOKEN (all in core.js, so both screens):
    // ~11 KB raw / ~3 KB gzipped, much of it comments: 1906 / 1525 raw, 645 / 512 gzipped.
    // Oct 2026: sample mode kept off the account (core.js sampleEnter/sampleLeave) and the award ledger's
    // reset: about 6 KB raw on each screen took both past their raw lines (1901 / 1520 raw, 644 / 510 gzipped).
    // Daruma's beta fixes (badges, plan checks, XP left, layout, keyboard) and all of the above together,
    // measured after merging the five: 1944 / 1561 raw, 660 / 526 gzipped.
    // Oct 2026: shared playbooks — Daruma's Playbooks screen (app/features/playbooks.js, Daruma only, ~23 KB raw /
    // ~8 KB gzipped, a third of it comments), the playbook checklist on its journal card and the admin's
    // controls: Daruma 1589 raw / 535 gzipped; the journal ~1 KB raw for keeping an adopted playbook's source.
    // Oct 2026: referrals — Daruma's Invite screen (app/features/referrals.js, Daruma only, ~11 KB raw / ~4 KB gzipped),
    // the ?ref= capture and the join form's invite card (pulse-social.js, both screens) and the Recruiter badges:
    // Daruma 1605 raw / 541 gzipped, the journal 1951 raw / 662 gzipped.
    // +10 KB raw / +4 KB gzipped: seams in the fill history (TWAP paging, off-record trades, fill coverage, the verified headline)
    ['the journal (/: page + ' + journal.scripts.length + ' scripts)', journal, 1985, 674],
    ['Daruma (/daruma: page + ' + keel.scripts.length + ' scripts, no Chart.js)', keel, 1636, 552],
  ];
  t('each screen loads its code from app/, and Daruma leaves Chart.js out', () => {
    ok(journal.scripts.length > 10 && keel.scripts.length > 10);
    ok(journal.scripts.some(s => s.startsWith('app/chart.umd.js')), 'the journal draws charts');
    ok(!keel.scripts.some(s => s.startsWith('app/chart.umd.js')), 'Daruma never does');
    // nor the Diagnostic view, the excursion/miner panels and replay chart, or the exports: it never shows them
    for (const f of ['diagnostic-view.js', 'excursions-view.js', 'exports.js']) {
      ok(journal.scripts.some(s => s.startsWith('app/' + f)), 'the journal loads ' + f);
      ok(!keel.scripts.some(s => s.startsWith('app/' + f)), 'Daruma leaves out ' + f); }
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
