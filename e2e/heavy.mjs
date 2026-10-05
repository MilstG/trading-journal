// A heavy account in the real app: ~18k trades (the built-in sample history repeated across time
// blocks and coin groups, the way AUDIT-4's profile scaled it), against the real server, offline.
// e2e/run.mjs works on ~100 trades, where nothing is slow; this is where the Diagnostic's worker
// batch, the memoized panels, the near-linear Trader Age history, the coach and Daruma's game built in
// idle steps, and the lazy below-the-fold work either hold or regress. Every budget is real (a few
// times what it measures locally, not 5–10×): before that work this history took ~3 s to open the
// Diagnostic, in one 3 s main-thread task.
// Run: npm run test:e2e:heavy   (HEAVY=10x30 for ~31k trades; E2E_SLOW=2 doubles the budgets)
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { t, ok, eq, report } from '../tests/harness.mjs';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
let chromium;
try { ({ chromium } = require('playwright')); }
catch (e) {
  console.error('Playwright is not installed. Run: npm i --no-save playwright && npx playwright install chromium');
  process.exit(1);
}
const { createApp } = require(join(here, '..', 'server.js'));

const SLOW = Math.max(1, +process.env.E2E_SLOW || 1);
const [BLOCKS, GROUPS] = (process.env.HEAVY || '6x30').split('x').map(Number);
// measured locally at ~18k trades: import ~0.8 s, render ~0.3 s and then the coach in idle steps
// (each under ~0.3 s; it was one ~1 s block), Diagnostic ~0.3 s, Review ~0.2 s, the other tabs ~0.1 s,
// longest task while switching tabs ~0.3 s (it was 3 s). The import's longest task, its first coach
// included, ~0.5 s (0.7 s at 18k / 1.05 s at 31k when that coach was one idle callback); Daruma drawn
// ~1.5 s after the import with no task over ~0.2–0.4 s (its game was one 1.2–1.7 s task inside the import)
const BUDGET_MS = { import: 3000, render: 2500, diag: 1200, review: 1000, proj: 800, dash: 800, tabTask: 900, renderTask: 900, mcLands: 15000, daruma: 4000,
  importTask: 900, darumaDrawn: 6000, darumaTask: 900 };
const within = (what, ms) => ok(ms <= BUDGET_MS[what] * SLOW, `${what} took ${ms} ms — over its ${BUDGET_MS[what] * SLOW} ms budget`);
const timings = {};

const TOKEN = 'e2e-token';
const app = createApp({ dataDir: mkdtempSync(join(tmpdir(), 'ledger-e2e-heavy-')), auth: TOKEN, htmlPath: join(here, '..', 'ledger.html'), push: false, pushTick: false, offsiteTimer: false,
  fetchImpl: async () => { throw new Error('offline'); } });
const BASE = await new Promise(r => app.listen(0, '127.0.0.1', () => r('http://127.0.0.1:' + app.address().port)));
const browser = await chromium.launch();

try {
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|frame-ancestors/.test(m.text())) errors.push(m.text()); });
  await page.route('**/*', r => r.request().url().startsWith(BASE) ? r.continue() : r.abort());
  await page.addInitScript(tok => { try { localStorage.setItem('srv_token', tok); } catch (e) {} }, TOKEN);
  await page.goto(BASE + '/');
  await page.waitForSelector('#demoBtn', { state: 'visible' });
  await page.waitForFunction(() => typeof SRV !== 'undefined' && SRV.enabled && !SRV.badAuth);
  // long tasks from here on, tagged with the phase they happened in
  await page.evaluate(() => { window.__phase = 'load'; window.__lt = [];
    new PerformanceObserver(l => { for (const e of l.getEntries()) window.__lt.push([window.__phase, Math.round(e.duration)]); }).observe({ type: 'longtask' }); });
  const longest = phase => page.evaluate(p => Math.max(0, ...__lt.filter(x => x[0] === p).map(x => x[1])), phase);
  const settle = () => page.evaluate(() => new Promise(r => requestAnimationFrame(() => setTimeout(r, 0))));

  console.log(`\nHeavy account (${BLOCKS}x${GROUPS})`);
  let N = 0;
  await t('imports a heavy fill history and renders the dashboard, inside the budget', async () => {
    const r = await page.evaluate(async ([blocks, groups]) => {
      const DAY = 86400000, now = Date.now(); let fills = [], tid = 1;
      for (let b = 0; b < blocks; b++) for (let g = 0; g < groups; g++) for (const f of demoFills(b * 1000 + g + 1, now - b * 152 * DAY)) {
        if (f.coin.includes('/')) { if (b || g) continue; } else if (g) f.coin = f.coin + 'X' + g; // more markets, not overlapping round trips
        f.tid = tid++; f.oid = 1e6 + tid; fills.push(f); }
      fills.sort((a, b) => a.time - b.time);
      const t0 = performance.now(); await loadFromPaste(fills, { offline: true, sample: true });
      return { ms: Math.round(performance.now() - t0), trades: allTrades.length };
    }, [BLOCKS, GROUPS]);
    N = r.trades; timings.import = r.ms;
    ok(N >= 10000, 'a heavy history: ' + N + ' trades'); within('import', r.ms);
    // the first render's coach (its context, the game) comes in idle steps here too: it was one ~1.4 s task at 31k
    await page.waitForFunction(() => { const el = document.getElementById('coach'); return el && el.innerText.trim().length > 50 && _gameMemo.key && _gameMemo.key.startsWith(_coachMemoAll.key); }, null, { timeout: 15000 });
    const lt = await longest('load'); timings['task:import'] = lt; within('importTask', lt);
    eq(errors, [], 'no uncaught errors');
  });
  await settle();
  // the coach picks the week's challenge once a week, on its first run: let that happen first, so the
  // render below measures what a journal save costs
  await page.waitForFunction(() => typeof weekChallenge === 'function' && !!weekChallenge(), null, { timeout: 15000 });
  await page.waitForTimeout(1500);
  await t('a full render (dashboard, coach, game, Trader Age history) stays inside the budget', async () => {
    await page.evaluate(() => { window.__phase = 'render'; });
    const ms = await page.evaluate(() => { _jrev++; const t0 = performance.now(); render(); return Math.round(performance.now() - t0); }); // a journal edit: every memo cold
    timings.render = ms; within('render', ms);
    // big accounts rebuild the coach (its context, the game) in idle steps after render(): none of them a long block either
    await page.waitForFunction(() => { const el = document.getElementById('coach'); return el && el.innerText.trim().length > 50 && _gameMemo.key && _gameMemo.key.startsWith(_coachMemoAll.key); }, null, { timeout: 15000 });
    const lt = await longest('render'); timings['task:render'] = lt; within('renderTask', lt);
    ok(await page.evaluate(() => { const g = gameContext(); return g.days.length > 100 && g.catalog && g.catalog.families.length > 10; }), 'the game and its badge catalog were built');
    eq(errors, [], 'no uncaught errors');
  });
  await page.waitForTimeout(500);
  for (const [tab, view] of [['diag', 'diagView'], ['review', 'reviewView'], ['proj', 'projView'], ['dash', 'dashView']]) {
    await t(`the ${tab} tab opens inside its budget, with no long main-thread task`, async () => {
      await page.evaluate(p => { window.__phase = p; }, 'tab:' + tab);
      const ms = await page.evaluate(async ([tab, view]) => {
        const t0 = performance.now(); document.querySelector(`#topnav [data-tab="${tab}"]`).click();
        await new Promise(r => requestAnimationFrame(() => setTimeout(r, 0)));
        const el = document.getElementById(view); if (!el || el.classList.contains('hide') || el.innerText.trim().length < 200) throw new Error(view + ' is empty');
        return Math.round(performance.now() - t0); }, [tab, view]);
      timings['tab:' + tab] = ms; within(tab, ms);
      await page.waitForTimeout(tab === 'diag' ? 1500 : 300); // the Diagnostic re-renders once if its Monte Carlo was still in the worker
      const lt = await longest('tab:' + tab); timings['task:' + tab] = lt; within('tabTask', lt);
      eq(errors, [], 'no uncaught errors');
    });
  }
  await t('the Diagnostic: the worker batch lands, and equals the sync path to the last bit', async () => {
    await page.evaluate(() => { window.__phase = 'check'; });
    const t0 = Date.now();
    await page.waitForFunction(() => _diagMC.key === _diagMCKey(periodTrades()), null, { timeout: BUDGET_MS.mcLands * SLOW });
    timings.mcLands = Date.now() - t0;
    const r = await page.evaluate(async () => {
      const I = _diagMCInput(periodTrades());
      const viaWorker = await runInWorker('diagmc', I.mcIn), sync = diagMCCompute(I.mcIn), memo = { ..._diagMC }; delete memo.key; delete memo.pending;
      return { n: I.mcIn.nets.length, same: JSON.stringify(viaWorker) === JSON.stringify(sync), memo: JSON.stringify(memo) === JSON.stringify(sync),
        cp: !!sync.cp, ci: !!sync.wfCI };
    });
    ok(r.n >= 10000 && r.cp && r.ci, 'a change point and a walk-forward CI at this size');
    ok(r.same, 'worker === sync'); ok(r.memo, 'what the tab shows === sync');
    await page.click('#topnav [data-tab="diag"]'); await settle();
    ok(!/computing…/.test(await page.textContent('#diagView')), 'nothing left pending once it landed');
  });
  await t('the miner keeps its pool in the worker: a pooled scan equals one shipped inline', async () => {
    const r = await page.evaluate(async () => {
      const pool = periodTrades().slice(0, 2500), key = _poolKey(pool, 'usd'), seed = _hashSeed('heavy-e2e');
      const a = await minerScan(pool, 'usd', seed, null, key), sent = _worker && _worker._poolKey === key;
      const again = await minerScan(pool, 'usd', seed, null, key);
      const job = { basis: 'usd', seed, be: _be, settings: { tz: settings.tz, coachMode: settings.coachMode }, journal: _journalSubset(pool), excursions: _excSubset(pool) };
      const inline = await runInWorker('miner', { ...job, trades: pool });
      return { sent, same: JSON.stringify(a) === JSON.stringify(inline), again: JSON.stringify(again) === JSON.stringify(inline), found: !!(a && a.res) };
    });
    ok(r.sent, 'the pool stayed in the worker'); ok(r.found); ok(r.same, 'pooled === inline'); ok(r.again, 'a second scan reuses it, same result');
  });
  await t('below the fold, built on the way down: Diagnostic charts and the what-if list, the Review routine section', async () => {
    await page.click('#topnav [data-tab="diag"]'); await settle();
    ok(await page.evaluate(() => !_diagCharts.roll && _diagLazy.length > 0), 'not built while out of view');
    await page.evaluate(async () => { for (let y = 0; y < document.body.scrollHeight; y += 600) { window.scrollTo(0, y); await new Promise(r => setTimeout(r, 30)); } });
    await page.waitForFunction(() => !!_diagCharts.roll && !!_diagCharts.eq && !!_diagCharts.dist && _diagLazy.length === 0);
    await page.waitForFunction(() => document.querySelectorAll('#wiCond option').length > 3);
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.click('#topnav [data-tab="review"]'); await settle();
    await page.evaluate(async () => { for (let y = 0; y < document.body.scrollHeight; y += 600) { window.scrollTo(0, y); await new Promise(r => setTimeout(r, 30)); } });
    await page.waitForFunction(() => !document.getElementById('rvLazy') && !!document.getElementById('rvWeeks'));
    await page.evaluate(() => window.scrollTo(0, 0));
    eq(errors, [], 'no uncaught errors');
  });
  await page.close();

  console.log(`\nDaruma, same history`);
  await t('Daruma imports and draws the heavy history without the journal-only code, inside the budget', async () => {
    const p = await browser.newPage({ viewport: { width: 390, height: 844 } }), errs = [];
    p.on('pageerror', e => errs.push(e.message));
    p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|frame-ancestors/.test(m.text())) errs.push(m.text()); });
    await p.route('**/*', r => r.request().url().startsWith(BASE) ? r.continue() : r.abort());
    await p.addInitScript(tok => { try { localStorage.setItem('srv_token', tok); } catch (e) {} }, TOKEN);
    await p.goto(BASE + '/daruma'); await p.waitForSelector('#pz', { state: 'visible' });
    await p.evaluate(() => { window.__lt = []; new PerformanceObserver(l => { for (const e of l.getEntries()) window.__lt.push(Math.round(e.duration)); }).observe({ type: 'longtask' }); });
    // the Diagnostic view, the excursion/miner panels, the replay chart and the exports aren't on this page
    eq(await p.evaluate(() => [typeof renderDiagnostic, typeof renderMinerResults, typeof openReplay, typeof MiniPDF, typeof diagScan, typeof reconstructCompute, typeof fetchCandles]),
      ['undefined', 'undefined', 'undefined', 'undefined', 'function', 'function', 'function']);
    const ms = await p.evaluate(async ([blocks, groups]) => {
      const DAY = 86400000, now = Date.now(); let fills = [], tid = 1;
      for (let b = 0; b < blocks; b++) for (let g = 0; g < groups; g++) for (const f of demoFills(b * 1000 + g + 1, now - b * 152 * DAY)) {
        if (f.coin.includes('/')) { if (b || g) continue; } else if (g) f.coin = f.coin + 'X' + g; f.tid = tid++; f.oid = 1e6 + tid; fills.push(f); }
      fills.sort((a, b) => a.time - b.time);
      const t0 = performance.now(); await loadFromPaste(fills, { offline: true, sample: true }); return Math.round(performance.now() - t0); }, [BLOCKS, GROUPS]);
    timings.daruma = ms; within('daruma', ms);
    // drawn once the game is built, in idle steps: no single task near what the whole build costs (it was one
    // 1.3–2 s task here, and 7–11 s on a phone at 4x CPU)
    const t1 = Date.now();
    await p.waitForFunction(() => !_pzStage && document.getElementById('pz').innerText.trim().length > 100 && gameWarm(), null, { timeout: BUDGET_MS.darumaDrawn * SLOW });
    timings.darumaDrawn = ms + (Date.now() - t1); within('darumaDrawn', timings.darumaDrawn);
    await p.waitForTimeout(500); const dlt = await p.evaluate(() => Math.max(0, ...__lt)); timings['task:daruma'] = dlt; within('darumaTask', dlt);
    ok(await p.evaluate(() => allTrades.length) >= 10000 && await p.evaluate(() => !!_worker), 'reconstructed in the worker (its function list resolves here)');
    for (const h of ['#progress', '#journal', '']) { await p.evaluate(x => { location.hash = x; }, h);
      await p.waitForFunction(() => document.getElementById('pz').innerText.trim().length > 100); await p.waitForTimeout(300); }
    eq(errs, [], 'no uncaught errors');
    await p.close();
  });
} finally {
  await browser.close();
  await new Promise(r => app.close(r));
  console.log('\nTimings (ms): ' + Object.entries(timings).map(([k, v]) => k + ' ' + v).join(' · '));
}
report('e2e heavy');
