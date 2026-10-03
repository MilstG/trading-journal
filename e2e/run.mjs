// Browser smoke tests: the real app in a real Chromium, served by the real server, offline.
// The unit suites (npm test) exercise functions pulled out of ledger.html; these catch what
// they can't — a view that throws on render, a button wired to nothing, a sync that never
// reaches the server, a page that got slow. Run: npm run test:e2e
//
// Needs Playwright with Chromium, which the repo deliberately doesn't depend on:
//   npm i --no-save playwright && npx playwright install chromium
// (or point NODE_PATH at an existing install). Every request outside the local server is
// blocked, so nothing here touches Hyperliquid or the internet.
//
// Timing budgets are in BUDGET_MS below; E2E_SLOW=2 doubles them on a slow machine.
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
const BUDGET_MS = { boot: 3000, reload: 2000, demo: 4000, tab: 2500, pulse: 4000, admin: 3000, file: 4000 }; // measured ~0.4–0.6 s locally
const within = (what, ms) => ok(ms <= BUDGET_MS[what] * SLOW, `${what} took ${ms} ms — over its ${BUDGET_MS[what] * SLOW} ms budget`);
const timings = {};

const TOKEN = 'e2e-token';
const dataDir = mkdtempSync(join(tmpdir(), 'ledger-e2e-'));
const app = createApp({ dataDir, auth: TOKEN, htmlPath: join(here, '..', 'ledger.html'), push: false, offsiteTimer: false,
  fetchImpl: async () => { throw new Error('offline'); } });
const BASE = await new Promise(r => app.listen(0, '127.0.0.1', () => r('http://127.0.0.1:' + app.address().port)));
const browser = await chromium.launch();

// A page that blocks the outside world, carries the token, and records every uncaught error.
// Console noise the browser itself makes (blocked requests, the CSP meta warning) isn't a bug.
async function openPage(viewport, opts = {}) {
  const page = await browser.newPage({ viewport, ...(opts.colorScheme ? { colorScheme: opts.colorScheme } : {}) });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|frame-ancestors/.test(m.text())) errors.push(m.text()); });
  await page.route('**/*', r => { const u = r.request().url(); return u.startsWith(BASE) || u.startsWith('file://') ? r.continue() : r.abort(); });
  if (opts.token !== false) await page.addInitScript(tok => { try { localStorage.setItem('srv_token', tok); } catch (e) {} }, TOKEN);
  return { page, errors };
}
const timed = async (key, fn) => { const t0 = Date.now(); await fn(); return (timings[key] = Date.now() - t0); };
const serverJournal = async () => (await (await fetch(BASE + '/api/data', { headers: { Authorization: 'Bearer ' + TOKEN } })).json()).snapshot?.journal || {};

try {
  console.log('\nFull journal (desktop)');
  const { page, errors } = await openPage({ width: 1366, height: 900 });
  await t('boots against the server with the token, inside the budget', async () => {
    within('boot', await timed('boot', async () => {
      await page.goto(BASE + '/');
      await page.waitForSelector('#demoBtn', { state: 'visible' });
      await page.waitForFunction(() => typeof SRV !== 'undefined' && SRV.enabled && !SRV.badAuth);
    }));
    eq(errors, [], 'no uncaught errors on boot');
  });
  await t('sample data reconstructs trades and renders the dashboard, inside the budget', async () => {
    within('demo', await timed('demo', async () => {
      await page.click('#demoBtn');
      await page.waitForFunction(() => typeof allTrades !== 'undefined' && allTrades.length > 0);
      await page.waitForSelector('#tbody tr.trow');
    }));
    ok(await page.evaluate(() => allTrades.length) >= 50, 'a populated history');
    ok(await page.locator('#tbody tr.trow').count() > 0, 'trade rows rendered');
    eq(errors, [], 'no uncaught errors');
  });
  for (const [tab, view] of [['review', 'reviewView'], ['diag', 'diagView'], ['proj', 'projView'], ['dash', 'dashView']]) {
    await t(`the ${tab} tab renders with data, inside the budget`, async () => {
      within('tab', await timed('tab:' + tab, async () => {
        await page.click(`#topnav [data-tab="${tab}"]`);
        await page.waitForFunction(v => { const el = document.getElementById(v); return el && !el.classList.contains('hide') && el.innerText.trim().length > 200; }, view);
      }));
      eq(errors, [], 'no uncaught errors');
    });
  }
  await t('a reload gets every app script from the browser cache, inside the budget', async () => {
    within('reload', await timed('reload', async () => {
      await page.reload();
      await page.waitForFunction(() => typeof SRV !== 'undefined' && SRV.enabled && !SRV.badAuth);
    }));
    const net = await page.evaluate(() => performance.getEntriesByType('resource')
      .filter(e => /\/app\/[a-z0-9.-]+\.js/.test(e.name) && e.transferSize > 0).map(e => e.name));
    eq(net, [], 'hashed app scripts are cached long-term, not refetched');
    await page.click('#demoBtn');
    await page.waitForSelector('#tbody tr.trow');
    eq(errors, [], 'no uncaught errors');
  });
  let tradeId;
  await t('a journal note saves, syncs to the server, and survives a reload', async () => {
    const row = page.locator('#tbody tr.trow').first();
    tradeId = await row.getAttribute('data-id');
    await row.click();
    const notes = page.locator(`[data-j="notes"][data-id="${tradeId}"]`);
    await notes.waitFor();
    await notes.fill('e2e: waited for the retest, sized down');
    await page.click(`[data-save="${tradeId}"]`);
    // sync is debounced ~1 s after an edit
    let synced = null;
    for (let i = 0; i < 50 && !synced; i++) { const j = await serverJournal(); if (j[tradeId] && j[tradeId].notes) synced = j[tradeId].notes; else await page.waitForTimeout(200); }
    eq(synced, 'e2e: waited for the retest, sized down', 'the server holds the note');
    await page.reload();
    await page.waitForFunction(id => typeof journal !== 'undefined' && journal[id] && journal[id].notes, tradeId);
    eq(await page.evaluate(id => journal[id].notes, tradeId), 'e2e: waited for the retest, sized down');
    eq(errors, [], 'no uncaught errors');
  });
  await t('a playbook gives a trade its checklist, and the Review tab grades it', async () => {
    await page.click('#demoBtn'); await page.waitForSelector('#tbody tr.trow'); // the reload above left no trades
    await page.click('#topnav [data-tab="review"]');
    await page.click('#pbNew');
    await page.fill('#pbName', 'Breakout retest');
    await page.fill('#pbRules', 'Wait for the retest\nStop under the range');
    await page.click('#pbSave');
    await page.waitForSelector('[data-pbedit]');
    await page.click('#topnav [data-tab="dash"]');
    const id = await page.locator('#tbody tr.trow').nth(1).getAttribute('data-id');
    await page.click(`#tbody tr.trow[data-id="${id}"]`);
    await page.fill(`[data-j="setup"][data-id="${id}"]`, 'breakout retest');
    await page.click(`[data-save="${id}"]`);
    await page.locator(`.pbrules[data-id="${id}"] .pbrule`).first().click();
    await page.waitForFunction(i => journal[i].pb && journal[i].pb.ok.length === 1, id);
    await page.click('#topnav [data-tab="review"]');
    const card = await page.locator('.diag-card', { has: page.locator('[data-pbedit]') }).innerText();
    ok(/Broke a rule\s*1 trade/.test(card), card);
    eq(errors, [], 'no uncaught errors');
  });
  await t('dark by default, even on a device set to light (journal and Daruma)', async () => {
    const { page: lp, errors: le } = await openPage({ width: 390, height: 800 }, { colorScheme: 'light' });
    for (const path of ['/', '/daruma']) { await lp.goto(BASE + path); await lp.waitForFunction(() => typeof settings !== 'undefined');
      ok(await lp.evaluate(() => matchMedia('(prefers-color-scheme: light)').matches), 'the device is light');
      ok(!(await lp.evaluate(() => document.body.classList.contains('light'))), 'but the app is dark: ' + path); }
    eq(le, [], 'no uncaught errors'); await lp.close();
  });
  await t('TS9 is the default colorway on both screens; a pick cycles, carries across and survives a reload', async () => {
    const { page: cp, errors: ce } = await openPage({ width: 1280, height: 800 });
    await cp.goto(BASE + '/'); await cp.waitForFunction(() => typeof SRV !== 'undefined' && SRV.enabled && SRV.rev > 0 && document.body.classList.contains('ts9'));
    eq(await cp.evaluate(() => getComputedStyle(document.body).backgroundColor), 'rgb(5, 7, 5)', 'the TS9 ground');
    eq(await cp.evaluate(() => document.getElementById('themeBtn').textContent), '◧ TS9');
    await cp.evaluate(() => setColorway('ink')); await cp.waitForFunction(() => settings.colorway === 'ink' && !document.body.classList.contains('ts9'));
    eq(await cp.evaluate(() => document.getElementById('themeBtn').textContent), '◧ INK', 'the footer button follows');
    // the pick reaches the server (a fresh Daruma session takes the server's copy)
    let synced = false;
    for (let i = 0; i < 40 && !synced; i++) { await new Promise(r => setTimeout(r, 250));
      const d = await (await fetch(BASE + '/api/data', { headers: { Authorization: 'Bearer ' + TOKEN } })).json(); synced = !!(d.snapshot && d.snapshot.settings && d.snapshot.settings.colorway === 'ink'); }
    ok(synced, 'the pick is on the server');
    await cp.reload(); await cp.waitForFunction(() => typeof SRV !== 'undefined' && SRV.rev > 0 && settings.colorway === 'ink', null, { timeout: 10000 });
    ok(!(await cp.evaluate(() => document.body.classList.contains('ts9') || document.body.classList.contains('bb'))), 'Ink survives a reload');
    await cp.goto(BASE + '/daruma'); await cp.waitForFunction(() => typeof settings !== 'undefined' && settings.colorway === 'ink');
    ok(!(await cp.evaluate(() => document.body.classList.contains('ts9'))), 'and carries to Daruma');
    await cp.evaluate(() => setColorway('ts9')); await cp.waitForFunction(() => document.body.classList.contains('ts9'));
    eq(await cp.evaluate(() => getComputedStyle(document.getElementById('pz')).getPropertyValue('--pz-acc').trim()), '#7dff4f', 'Daruma takes the TS9 accent');
    eq(ce, [], 'no uncaught errors'); await cp.close();
  });
  await t('Light appearance applies everywhere, survives a reload, and is there before first paint', async () => {
    await page.evaluate(() => setAppearance('light'));
    ok(await page.evaluate(() => document.body.classList.contains('light')));
    await page.reload();
    // the first-paint script runs before the app's code: check at DOMContentLoaded's earliest point
    ok(await page.evaluate(() => document.body.classList.contains('light')), 'light on reload');
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    eq(bg, 'rgb(243, 245, 248)', 'the light background');
    await page.evaluate(() => setAppearance('dark'));
    ok(!(await page.evaluate(() => document.body.classList.contains('light'))));
    eq(errors, [], 'no uncaught errors');
  });
  await page.close();

  await t('an edit made right before a reload is kept, not replaced by the server\'s older copy', async () => {
    const { page: p, errors: errs } = await openPage({ width: 1366, height: 900 });
    await p.goto(BASE + '/'); await p.waitForFunction(() => typeof SRV !== 'undefined' && SRV.enabled && SRV.rev > 0);
    // the edit's save waits 800 ms; reload before it goes out
    await p.evaluate(async () => { settings.wallets.push({ address: '0x' + '5e'.repeat(20), label: 'just added' }); await Store.set(S_KEY, settings); });
    await p.reload();
    await p.waitForFunction(() => typeof SRV !== 'undefined' && SRV.enabled && settings.wallets.some(w => w.label === 'just added'), null, { timeout: 10000 });
    // and it reaches the server
    let onServer = false;
    for (let i = 0; i < 40 && !onServer; i++) { await new Promise(r => setTimeout(r, 250));
      const d = await (await fetch(BASE + '/api/data', { headers: { Authorization: 'Bearer ' + TOKEN } })).json();
      onServer = (d.snapshot.wallets || []).some(w => w.label === 'just added'); }
    ok(onServer, 'sent to the server after the restart');
    // another device's newer save still wins over a stale local copy
    await p.evaluate(async () => { settings.wallets = settings.wallets.filter(w => w.label !== 'just added'); await Store.set(S_KEY, settings); });
    await new Promise(r => setTimeout(r, 1500));
    const cur = await (await fetch(BASE + '/api/data', { headers: { Authorization: 'Bearer ' + TOKEN } })).json();
    await fetch(BASE + '/api/data', { method: 'PUT', headers: { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ rev: cur.rev, snapshot: { ...cur.snapshot, wallets: [...(cur.snapshot.wallets || []), { address: '0x' + '6f'.repeat(20), label: 'other device' }] } }) });
    await p.evaluate(async () => { settings.riskDefault = 123; await Store.set(S_KEY, settings); });
    await p.reload();
    await p.waitForFunction(() => typeof SRV !== 'undefined' && SRV.enabled && settings.wallets.some(w => w.label === 'other device'), null, { timeout: 10000 });
    eq(errs, []);
    await p.close();
  });

  console.log('\nPasskeys (Chrome virtual authenticator)');
  await t('a member adds a passkey in Pulse, then signs in with it on a fresh session', async () => {
    // WebAuthn refuses IP addresses as a site ID: this test talks to the server as localhost
    const LB = BASE.replace('127.0.0.1', 'localhost');
    const j = await (await fetch(BASE + '/api/social/join', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ handle: 'pk_e2e' }) })).json();
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
    await p.route('**/*', r => r.request().url().startsWith(LB) ? r.continue() : r.abort());
    const cdp = await ctx.newCDPSession(p); await cdp.send('WebAuthn.enable');
    await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true } });
    await p.addInitScript(k => { if (!sessionStorage.getItem('seeded')) { localStorage.setItem('pz_social_key', k); localStorage.setItem('srv_token', 'e2e-token'); sessionStorage.setItem('seeded', '1'); } }, j.key);
    await p.goto(LB + '/daruma'); await p.waitForFunction(() => typeof SOC !== 'undefined' && SOC.me);
    await p.evaluate(async () => { pzS.demo = true; await loadDemo(); location.hash = '#account'; });
    await p.click('#socPkAdd');
    await p.waitForSelector('[data-pk-del]');
    await p.evaluate(() => { localStorage.removeItem('pz_social_key'); localStorage.removeItem('srv_token'); });
    await p.reload();
    await p.click('.pz-acct summary'); await p.click('#socPkLogin');
    await p.waitForFunction(() => localStorage.getItem('pz_social_key'));
    eq(await p.evaluate(() => SOC.me && SOC.me.handle), 'pk_e2e');
    ok(await p.evaluate(k => localStorage.getItem('pz_social_key') !== k, j.key), 'a new device key');
    eq(errs, [], 'no uncaught errors');
    await ctx.close();
  });

  console.log('\nOffline (service worker)');
  await t('after one visit the app opens offline, scripts and all, from the service worker cache', async () => {
    const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    const p = await ctx.newPage(); const errs = [];
    p.on('pageerror', e => errs.push(e.message));
    await p.goto(BASE + '/');
    await p.waitForFunction(() => navigator.serviceWorker && navigator.serviceWorker.controller, null, { timeout: 15000 }).catch(() => {});
    if (!(await p.evaluate(() => !!(navigator.serviceWorker && navigator.serviceWorker.controller)))) await p.reload(); // first visit installs; the reload is controlled
    await p.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 15000 });
    await p.reload(); await p.waitForSelector('#demoBtn', { state: 'visible' }); // fetched through the worker: now cached
    // empty the browser's HTTP cache, so what loads next can only come from the service worker
    const cdp = await ctx.newCDPSession(p); await cdp.send('Network.clearBrowserCache');
    await ctx.setOffline(true);
    await p.reload();
    await p.waitForSelector('#demoBtn', { state: 'visible' });
    await p.click('#demoBtn');
    await p.waitForSelector('#tbody tr.trow');
    eq(errs, [], 'no uncaught errors offline');
    await ctx.close();
  });

  console.log('\nOpened from disk (file://, no server)');
  await t('ledger.html opened straight from disk loads its app/ scripts and works offline', async () => {
    const { page: p, errors: errs } = await openPage({ width: 1366, height: 900 }, { token: false });
    await p.route('file://**', r => r.continue());
    within('file', await timed('file', async () => {
      await p.goto('file://' + join(here, '..', 'ledger.html'));
      await p.waitForSelector('#demoBtn', { state: 'visible' });
      await p.click('#demoBtn');
      await p.waitForSelector('#tbody tr.trow');
    }));
    ok(await p.evaluate(() => allTrades.length) >= 50);
    eq(await p.evaluate(() => SRV.enabled), false, 'no server, no sync');
    eq(errs, [], 'no uncaught errors');
    await p.close();
  });

  console.log('\nPulse (phone)');
  await t('Pulse opens at phone width with sample data and no errors, inside the budget', async () => {
    const { page: p, errors: errs } = await openPage({ width: 390, height: 844 });
    within('pulse', await timed('pulse', async () => {
      await p.goto(BASE + '/daruma');
      await p.waitForSelector('#pz', { state: 'visible' });
      await p.waitForFunction(() => document.getElementById('pz').innerText.trim().length > 100);
    }));
    const width = await p.evaluate(() => document.documentElement.scrollWidth);
    ok(width <= 390, 'no sideways scrolling on a phone (page is ' + width + ' px wide)');
    eq(errs, [], 'no uncaught errors');
    await p.close();
  });

  await t('the journal tab: with sample data every chart draws its trade inside its own candles, offline', async () => {
    const { page: p, errors: errs } = await openPage({ width: 1280, height: 900 }, { token: false });
    await p.goto(BASE + '/daruma'); await p.click('#pzDemo');
    await p.waitForFunction(() => allTrades.length > 20 && document.querySelector('.pz-rings'));
    await p.evaluate(() => { location.hash = '#journal'; });
    await p.waitForFunction(() => document.querySelectorAll('.pz-snapsvg').length >= 4, null, { timeout: 15000 });
    const chk = await p.evaluate(() => Object.entries(PZ_SNAP).filter(([, s]) => s.st === 'ok').map(([id, s]) => { const t = allTrades.find(x => x.id === id);
      const lo = Math.min(...s.c.map(c => c[2])), hi = Math.max(...s.c.map(c => c[1])); return [t.coin, t.avgEntry >= lo && t.avgEntry <= hi && (t.isOpen || (t.avgExit >= lo && t.avgExit <= hi))]; }));
    ok(chk.length >= 4 && chk.every(x => x[1]), JSON.stringify(chk));
    ok(await p.evaluate(() => document.querySelectorAll('.pz-trade .pz-side').length >= 4 && document.querySelectorAll('.pz-rp-dot').length >= 8), 'side pills and a dot per fill');
    await p.click('.pz-trade [data-pz-rpi="1"]');
    ok(/Fill 2 of 2/.test(await p.textContent('.pz-trade .pz-rp-lbl')), 'a dot jumps to its fill');
    eq(await p.evaluate(() => document.querySelectorAll('.pz-trade .pz-snapsvg circle[r="8"]').length), 1, 'and the chart rings it');
    eq(errs, [], 'no uncaught errors'); await p.close();
  });

  console.log('\nPulse: tilt alerts and the week card');
  for (const width of [360, 1280]) await t(`at ${width} px: a tilt banner, the break timer, and a PNG of the week (1080×1350 and 1080×1080)`, async () => {
    const { page: p, errors: errs } = await openPage({ width, height: 860 }, { token: false });
    await p.goto(BASE + '/daruma');
    await p.click('#pzDemo');
    await p.waitForFunction(() => allTrades.length > 20 && document.querySelector('.pz-rings'));
    // three losses in the last few minutes, as a refresh would bring them. Headless Chromium always
    // says notifications are denied, so permission is stood in for and notifications caught on their way out
    const pick = await p.evaluate(async () => {
      window.__notes = [];
      ServiceWorkerRegistration.prototype.showNotification = async function (t) { __notes.push('sw:' + t); };
      window.Notification = function (t) { __notes.push('page:' + t); }; window.Notification.permission = 'granted';
      const base = allTrades.find(t => !t.isOpen && t.market !== 'spot'), now = Date.now();
      [9, 6, 3].forEach((m, i) => allTrades.unshift(Object.assign({}, base, { id: 'tilt-e2e-' + i, openTime: now - (m + 1) * 60000, closeTime: now - m * 60000, isOpen: false, net: -40, pnl: -39, fees: 1 })));
      const a = pzTiltAlertCheck(); pzRender(); return a && a.k; });
    eq(pick, 'streak3');
    const banner = await p.textContent('.pz-talert');
    ok(/3 losses in 6 minutes\. This is when revenge trades happen\. Step away for 15 minutes\?/.test(banner), banner);
    await p.waitForFunction(() => __notes.length > 0); eq(await p.evaluate(() => __notes), ['sw:Three losses close together'], 'a system notification too, through the service worker');
    eq(await p.evaluate(() => pzTiltAlertCheck()), null, 'the same fills again: nothing new to say');
    // Taking a break: a 15-minute timer you can see, and the break logged on the day
    await p.click('[data-pz-ta="break"]');
    await p.waitForSelector('#pzQuietLeft');
    ok(/^1[45]:[0-5]\d$/.test(await p.textContent('#pzQuietLeft')), await p.textContent('#pzQuietLeft'));
    const br = await p.evaluate(() => (journal['day:' + dayKey(Date.now())].breaks || []).slice(-1)[0]);
    eq([br.src, br.p, br.min], ['alert', 'streak3', 15]);
    await p.click('[data-pz-quiet="end"]');
    eq(await p.$('.pz-talert'), null, 'the banner is answered');
    // Dismiss, and the switch in Settings
    await p.evaluate(() => { _pzTaMem = null; localStorage.removeItem('pzTiltAlerts'); pzTiltAlertCheck(); pzRender(); });
    await p.click('.pz-talert [data-pz-ta="dismiss"]');
    eq(await p.$('.pz-talert'), null, 'dismissed');
    await p.click('[data-pz-sheet]'); await p.click('#pzSheet [data-pz-ta="toggle"]');
    eq(await p.evaluate(() => settings.pzTiltAlerts), false, 'tilt alerts off');
    await p.keyboard.press('Escape');
    eq(await p.evaluate(() => { _pzTaMem = null; localStorage.removeItem('pzTiltAlerts'); return pzTiltAlertCheck(); }), null, 'off means no alert');
    // Share my week: a PNG at both sizes, in both colours, and a download
    await p.evaluate(() => { location.hash = '#progress'; });
    await p.click('[data-pz-wk="open"]');
    const dims = () => p.evaluate(async () => { const b = pzS.wk.blob, i = await createImageBitmap(b); return [b.type, i.width, i.height, document.getElementById('pzWkImg').src.slice(0, 5)]; });
    await p.waitForFunction(() => pzS.wk && pzS.wk.blob);
    eq(await dims(), ['image/png', 1080, 1350, 'blob:']);
    const n0 = await p.evaluate(() => pzS.wk.n);
    // wait for the square image itself (the portrait one is still on hand until it's drawn)
    await p.click('[data-pz-wk="fmt:square"]'); await p.waitForFunction(n => pzS.wk.n > n && pzS.wk.blob && pzS.wk.drawn && pzS.wk.drawn.startsWith('square/'), n0);
    eq(await dims(), ['image/png', 1080, 1080, 'blob:']);
    await p.click('[data-pz-wk="theme:light"]'); await p.click('[data-pz-wk="show:badges"]');
    await p.waitForFunction(() => pzS.wk.theme === 'light' && pzS.wk.show.badges === false && pzS.wk.m && pzS.wk.m.badges.length === 0);
    ok(!/\$/.test(JSON.stringify(await p.evaluate(() => pzS.wk.m))), 'no dollar amounts on the card');
    const [dl] = await Promise.all([p.waitForEvent('download'), p.click('[data-pz-wk="dl"]')]);
    ok(/^daruma-week-\d{4}-\d{2}-\d{2}-square\.png$/.test(dl.suggestedFilename()), dl.suggestedFilename());
    const sw = await p.evaluate(() => document.documentElement.scrollWidth);
    ok(sw <= width, 'no sideways scrolling (page is ' + sw + ' px wide)');
    eq(errs, [], 'no console errors');
    await p.close();
  });

  console.log('\nOther venues');
  await t('a Lighter address is found and loaded with nothing but the address', async () => {
    const { page: p, errors: errs } = await openPage({ width: 1366, height: 900 });
    const L1 = '0x' + 'ab'.repeat(20), T0 = Date.parse('2026-09-01T00:00:00Z');
    const tr = (id, ms, side, sz, px, before, eq) => ({ trade_id: id, type: 'trade', market_id: 1, size: String(sz), price: String(px), usd_amount: String(sz * px),
      ask_id: 9, bid_id: 8, ask_account_id: side === 'A' ? 5 : 1, bid_account_id: side === 'B' ? 5 : 1, is_maker_ask: true, timestamp: ms,
      maker_fee: 20, taker_fee: 200, taker_position_size_before: before, taker_entry_quote_before: eq, maker_position_size_before: before, maker_entry_quote_before: eq });
    const answers = {
      '/api/v1/accountsByL1Address': { code: 200, sub_accounts: [{ index: 5 }] },
      '/api/v1/orderBooks': { code: 200, order_books: [{ symbol: 'BTC', market_id: 1, market_type: 'perp' }] },
      '/api/v1/trades': { code: 200, trades: [tr(2, T0 + 3600e3, 'A', 1, 120, '1', '100'), tr(1, T0, 'B', 1, 100, '0', '0')], next_cursor: '' },
      '/api/v1/fundings': { code: 200, fundings: [] },
      '/api/v1/account': { code: 200, accounts: [{ index: 5, collateral: '500', positions: [] }] },
    };
    // Hyperliquid has never seen this address (userRole "missing"), so only the Lighter account is added
    await p.route('https://api.hyperliquid.xyz/**', r => r.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' },
      body: JSON.parse(r.request().postData() || '{}').type === 'userRole' ? '{"role":"missing"}' : '[]' }));
    await p.route('https://mainnet.zklighter.elliot.ai/**', r => { const a = answers[new URL(r.request().url()).pathname];
      return r.fulfill({ status: a ? 200 : 404, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify(a || { code: 404 }) }); });
    await p.goto(BASE + '/');
    await p.waitForSelector('#walletsBtn');
    if (await p.$eval('#setupPanel', e => e.classList.contains('hide'))) await p.click('#walletsBtn');
    await p.fill('#walletAddr', L1); await p.click('#addWallet');
    await p.waitForFunction(() => /Added on Lighter/.test(document.getElementById('status').textContent));
    ok(/Lighter 0xabab/.test(await p.textContent('#wallets')), 'the chip names the venue');
    await p.click('#loadAll');
    await p.waitForSelector('#tbody tr.trow');
    const row = await p.textContent('#tbody tr.trow');
    ok(/BTC/.test(row) && /Lighter/.test(row), row.replace(/\s+/g, ' ').slice(0, 120));
    ok(/2 fills → 1 perp/.test(await p.textContent('#status')), await p.textContent('#status'));
    // Bybit / Binance: the dialog checks the key's shape here, then asks the exchange through the server
    if (await p.$eval('#setupPanel', e => e.classList.contains('hide'))) await p.click('#walletsBtn');
    await p.click('#cexBtn');
    await p.waitForSelector('.modal.cexbox');
    await p.click('[data-cexv="binance"]');
    ok(/Enable Reading/.test(await p.textContent('#cexSteps')));
    await p.fill('#cexKey', 'short'); await p.click('[data-cex="go"]');
    await p.waitForFunction(() => /doesn’t look right/.test(document.getElementById('cexErr').textContent));
    await p.fill('#cexKey', 'A'.repeat(64)); await p.fill('#cexSecret', 'B'.repeat(64)); await p.click('[data-cex="go"]');
    // this test server is offline, so the relay reports it can't reach Binance — the request went browser → server → exchange
    await p.waitForFunction(() => /reach Binance/.test(document.getElementById('cexErr').textContent));
    await p.keyboard.press('Escape');
    eq(await p.$('.modal.cexbox'), null);
    eq(errs, []);
    await p.close();
  });

  console.log('\nInstall as an app');
  await t('the journal and Pulse both pass Chrome’s installability check, with PNG home-screen icons', async () => {
    for (const [path, icon] of [['/', '/icons/ledger-180.png'], ['/daruma', '/icons/pulse-180.png']]) {
      const { page: p, errors: errs } = await openPage({ width: 390, height: 844 });
      await p.goto(BASE + path);
      await p.waitForFunction(() => !!(navigator.serviceWorker && navigator.serviceWorker.controller), null, { timeout: 15000 });
      const cdp = await p.context().newCDPSession(p);
      const man = await cdp.send('Page.getAppManifest');
      ok(/\/(manifest|pulse)\.webmanifest$/.test(man.url), path + ' manifest: ' + man.url);
      eq((await cdp.send('Page.getInstallabilityErrors')).installabilityErrors, [], path + ' is installable');
      eq(await p.$eval('link[rel=apple-touch-icon]', l => l.getAttribute('href')), icon);
      const M = JSON.parse(man.data);
      ok(M.icons.some(i => i.sizes === '512x512' && i.purpose === 'maskable') && M.icons.some(i => i.sizes === '192x192'), JSON.stringify(M.icons));
      for (const i of M.icons) eq((await fetch(BASE + i.src)).headers.get('content-type'), 'image/png', i.src);
      eq(errs, []);
      await p.close();
    }
  });

  console.log('\nAdmin panel');
  await t('every admin tab renders for the owner, inside the budget', async () => {
    const { page: p, errors: errs } = await openPage({ width: 1280, height: 900 });
    within('admin', await timed('admin', async () => {
      await p.goto(BASE + '/admin#overview');
      await p.waitForSelector('#view .tile');
    }));
    const tabs = await p.$$eval('#tabs a', as => as.map(a => a.getAttribute('href').slice(1)));
    ok(tabs.length >= 10 && tabs.includes('wallets'), 'tabs: ' + tabs.join(','));
    for (const tab of tabs) {
      await p.goto(BASE + '/admin#' + tab);
      await p.waitForFunction(tb => document.querySelector('#tabs [aria-current]')?.getAttribute('href') === '#' + tb && document.getElementById('view').innerText.trim().length > 20, tab);
    }
    eq(errs, [], 'no uncaught errors across ' + tabs.length + ' tabs');
    await p.close();
  });
  await t('the owner adds an admin by name; the link signs them in on another browser', async () => {
    const { page: p, errors: errs } = await openPage({ width: 1280, height: 900 });
    await p.goto(BASE + '/admin#members');
    await p.waitForSelector('#adminToggle');
    await p.click('#adminToggle'); await p.fill('#adHandle', 'co_admin'); await p.click('#adCreate');
    await p.waitForSelector('.okbox .code');
    const link = await p.$eval('.okbox [data-copy^="http"]', b => b.dataset.copy);
    ok(/\/admin#code=[A-Z0-9]+$/.test(link), link);
    // a different person, a different browser: no token, nothing stored
    const { page: q, errors: errs2 } = await openPage({ width: 1280, height: 900 }, { token: false });
    await q.goto(link);
    await q.waitForSelector('#view .tile');
    eq(await q.textContent('#whoami'), 'Admin · @co_admin');
    await q.goto(BASE + '/admin#members'); await q.waitForSelector('#mRows');
    eq(await q.$('#adminToggle'), null, 'only the owner adds admins');
    eq(await q.evaluate(() => localStorage.getItem('srv_token')), null, 'never the access token');
    // and Pulse on that browser is signed in as the same profile
    await q.goto(BASE + '/daruma'); await q.waitForFunction(() => typeof SOC !== 'undefined' && SOC.me && SOC.me.handle === 'co_admin', null, { timeout: 10000 });
    eq(errs, []); eq(errs2, []);
    await p.close(); await q.close();
  });
  await t('a wrong token is refused with a message, not a blank page', async () => {
    const { page: p, errors: errs } = await openPage({ width: 1280, height: 900 }, { token: false });
    await p.addInitScript(() => { try { localStorage.setItem('srv_token', 'wrong'); } catch (e) {} });
    await p.goto(BASE + '/admin');
    await p.waitForSelector('#loginErr:not(.hide)');
    ok(/token/i.test(await p.textContent('#loginErr')));
    eq(errs, []);
    await p.close();
  });

  // Admin two-factor, on a server of its own (the owner turns it on here), as localhost: WebAuthn
  // refuses IP addresses as a site ID. Codes come from admin2fa.js's own TOTP.
  console.log('\nAdmin two-factor');
  const A2F = require(join(here, '..', 'admin2fa.js'));
  const app2 = createApp({ dataDir: mkdtempSync(join(tmpdir(), 'ledger-e2e-2fa-')), auth: TOKEN, htmlPath: join(here, '..', 'ledger.html'), push: false, offsiteTimer: false,
    fetchImpl: async () => { throw new Error('offline'); } });
  const LB2 = await new Promise(r => app2.listen(0, '127.0.0.1', () => r('http://localhost:' + app2.address().port)));
  const totpNow = (secret, ahead = 0) => A2F.totp(A2F.b32decode(secret), Date.now() + ahead);
  // a fresh browser (no session cookie) carrying the token, with a virtual passkey device that can be shared
  const ownerCtx = async (width, auth) => {
    const ctx = await browser.newContext({ viewport: { width, height: 900 } }), p = await ctx.newPage(), errs = [];
    p.on('pageerror', e => errs.push(e.message));
    p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|frame-ancestors/.test(m.text())) errs.push(m.text()); });
    await p.route('**/*', r => r.request().url().startsWith(LB2) ? r.continue() : r.abort());
    await p.addInitScript(tok => { try { localStorage.setItem('srv_token', tok); } catch (e) {} }, TOKEN);
    const cdp = await ctx.newCDPSession(p); await cdp.send('WebAuthn.enable');
    const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'usb', hasResidentKey: false, hasUserVerification: true, isUserVerified: true } });
    if (auth) for (const c of auth.creds) await cdp.send('WebAuthn.addCredential', { authenticatorId, credential: c });
    const noSideways = async () => ok(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no sideways scroll at ' + width + ' px');
    return { ctx, p, errs, cdp, authenticatorId, noSideways };
  };
  let secret = null, creds = null, recovery = null;
  try {
    await t('1280 px: the Security card sets up an authenticator app (QR code) and an admin passkey, with recovery codes', async () => {
      const { ctx, p, errs, cdp, authenticatorId, noSideways } = await ownerCtx(1280);
      await p.goto(LB2 + '/admin#settings');
      await p.waitForSelector('#a2fCard [data-a2f="totpstart"]');
      ok(/Two-factor off/.test(await p.textContent('#a2fCard')));
      await p.click('[data-a2f="totpstart"]');
      await p.waitForSelector('#a2fCard .a2f-qr svg');
      secret = (await p.textContent('#a2fSecret')).replace(/\s/g, ''); ok(/^[A-Z2-7]{32}$/.test(secret), secret);
      ok(/^otpauth:\/\/totp\//.test(await p.getAttribute('#a2fCard .a2f-uri a', 'href')));
      await p.fill('#a2fTotpCode', totpNow(secret)); await p.click('[data-a2f="totpok"]');
      await p.waitForSelector('#a2fCodes');
      recovery = await p.$$eval('#a2fCodes span', s => s.map(x => x.textContent)); eq(recovery.length, 10);
      await p.click('[data-a2f="codesdone"]');
      await p.fill('#a2fPkName', 'Desk key'); await p.click('[data-a2f="pkadd"]');
      await p.waitForFunction(() => /Desk key/.test(document.getElementById('a2fCard').textContent) && /Two-factor on/.test(document.getElementById('a2fCard').textContent));
      ok(/1 passkey and authenticator app/.test(await p.textContent('#a2fCard')));
      creds = (await cdp.send('WebAuthn.getCredentials', { authenticatorId })).credentials; eq(creds.length, 1);
      await noSideways();
      await p.screenshot({ path: join(tmpdir(), 'e2e-admin2fa-security-1280.png'), fullPage: true });
      // the panel keeps working in this browser: its session came with the first factor
      await p.goto(LB2 + '/admin#members'); await p.waitForSelector('#mRows');
      eq(errs, []);
      await ctx.close();
    });
    await t('1280 px: a new browser with the token gets the second step on the sign-in screen; a passkey opens the panel', async () => {
      const { ctx, p, errs, noSideways } = await ownerCtx(1280, { creds });
      await p.goto(LB2 + '/admin');
      await p.waitForSelector('#a2fStep [data-a2f="stepPk"]');
      ok(await p.isHidden('#login'), 'the step takes the sign-in card’s place'); ok(await p.isHidden('#app'));
      await noSideways();
      await p.screenshot({ path: join(tmpdir(), 'e2e-admin2fa-step-1280.png') });
      await p.click('[data-a2f="stepPk"]');
      await p.waitForSelector('#view .tile');
      eq(await p.textContent('#whoami'), 'Owner'); eq(await p.$('#a2fStep'), null);
      eq(errs, []);
      await ctx.close();
    });
    await t('360 px: the second step with an authenticator code, a wrong one first; the Security card fits', async () => {
      const { ctx, p, errs, noSideways } = await ownerCtx(360);
      await p.goto(LB2 + '/admin#settings');
      await p.waitForSelector('#a2fCode');
      eq(await p.$('#a2fStep [data-a2f="stepPk"]') !== null, true, 'the passkey button is offered');
      await noSideways();
      await p.screenshot({ path: join(tmpdir(), 'e2e-admin2fa-step-360.png') });
      await p.fill('#a2fCode', '000000' === totpNow(secret, 30000) ? '111111' : '000000'); await p.press('#a2fCode', 'Enter');
      await p.waitForSelector('#a2fErr:not(.hide)'); ok(/didn’t work/.test(await p.textContent('#a2fErr')));
      await p.fill('#a2fCode', totpNow(secret, 30000)); await p.click('[data-a2f="stepCode"]'); // the next step: the setup used this one
      await p.waitForSelector('#a2fCard [data-a2f="rcnew"]');
      ok(/9 of 10 left|10 of 10 left/.test(await p.textContent('#a2fCard')));
      await noSideways();
      await p.screenshot({ path: join(tmpdir(), 'e2e-admin2fa-security-360.png'), fullPage: true });
      eq(errs, []);
      await ctx.close();
    });
    await t('360 px: a session that ends while the panel is open asks again in a dialog, then the action goes through; sign out ends it', async () => {
      const { ctx, p, errs, noSideways } = await ownerCtx(360);
      await p.goto(LB2 + '/admin');
      await p.waitForSelector('#a2fCode');
      await p.fill('#a2fCode', recovery[0]); await p.press('#a2fCode', 'Enter');
      await p.waitForSelector('#view .tile');
      await ctx.clearCookies();
      await p.goto(LB2 + '/admin#settings'); // the hash change re-renders from the loaded data, no call yet
      await p.waitForSelector('#sSave');
      await p.click('#sSave');
      await p.waitForSelector('.a2f-ov #a2fCode');
      eq(await p.$eval('#a2fStep .card', el => el.getAttribute('aria-modal')), 'true');
      await noSideways();
      await p.fill('#a2fCode', recovery[1]); await p.click('[data-a2f="stepCode"]');
      await p.waitForFunction(() => /Settings saved/.test(document.getElementById('note').textContent));
      eq(await p.$('#a2fStep'), null);
      const cookie = (await ctx.cookies()).find(c => c.name === 'pz_admin2fa');
      ok(cookie && cookie.httpOnly && cookie.sameSite === 'Strict' && cookie.path === '/api/social/admin', JSON.stringify(cookie));
      await Promise.all([p.waitForNavigation(), p.click('#signout')]);
      await p.waitForSelector('#a2fStep'); // the token comes back with this test's page, the session doesn't
      let st = 0; for (let i = 0; i < 20 && st !== 401; i++) { st = (await fetch(LB2 + '/api/social/admin/overview', { headers: { Authorization: 'Bearer ' + TOKEN, Cookie: 'pz_admin2fa=' + cookie.value } })).status; if (st !== 401) await new Promise(r => setTimeout(r, 100)); }
      eq(st, 401, 'signing out ended the session');
      eq(errs, []);
      await ctx.close();
    });
    await t('cancelling the second step says what’s needed instead of “wrong token”', async () => {
      const { ctx, p, errs } = await ownerCtx(1280);
      await p.goto(LB2 + '/admin');
      await p.waitForSelector('#a2fStep [data-a2f="cancel"]'); await p.click('[data-a2f="cancel"]');
      await p.waitForSelector('#loginErr:not(.hide)');
      ok(/second step/.test(await p.textContent('#loginErr')), await p.textContent('#loginErr'));
      eq(errs, []);
      await ctx.close();
    });
  } finally { await new Promise(r => app2.close(r)); }
  await t('ADMIN_2FA=required, 360 px: the first sign-in sets up an authenticator app from a QR code, shows the recovery codes, then opens the panel', async () => {
    const app3 = createApp({ dataDir: mkdtempSync(join(tmpdir(), 'ledger-e2e-2fa-req-')), auth: TOKEN, htmlPath: join(here, '..', 'ledger.html'), push: false, offsiteTimer: false,
      admin2fa: 'required', fetchImpl: async () => { throw new Error('offline'); } });
    const LB3 = await new Promise(r => app3.listen(0, '127.0.0.1', () => r('http://localhost:' + app3.address().port)));
    const ctx = await browser.newContext({ viewport: { width: 360, height: 800 } }), p = await ctx.newPage(), errs = [];
    p.on('pageerror', e => errs.push(e.message));
    p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|frame-ancestors/.test(m.text())) errs.push(m.text()); });
    await p.route('**/*', r => r.request().url().startsWith(LB3) ? r.continue() : r.abort());
    await p.addInitScript(tok => { try { localStorage.setItem('srv_token', tok); } catch (e) {} }, TOKEN);
    try {
      await p.goto(LB3 + '/admin');
      await p.waitForSelector('#a2fStep [data-a2f="stepTotp"]');
      ok(/Set up two-factor/.test(await p.textContent('#a2fStep')));
      await p.click('[data-a2f="stepTotp"]');
      await p.waitForSelector('#a2fStep .a2f-qr svg');
      ok(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'no sideways scroll');
      const sec = (await p.textContent('#a2fSecret')).replace(/\s/g, '');
      await p.fill('#a2fStepTotp', totpNow(sec)); await p.press('#a2fStepTotp', 'Enter');
      await p.waitForSelector('#a2fCodes'); eq((await p.$$('#a2fCodes span')).length, 10);
      await p.click('[data-a2f="stepdone"]');
      await p.waitForSelector('#view .tile');
      eq(errs, []);
    } finally { await ctx.close(); await new Promise(r => app3.close(r)); }
  });
} finally {
  await browser.close();
  await new Promise(r => app.close(r));
  console.log('\nTimings (ms): ' + Object.entries(timings).map(([k, v]) => k + ' ' + v).join(' · '));
}
report('e2e');
