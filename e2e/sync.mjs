// Browser checks of server sync under a second device: the real app in Chromium against the real
// server, offline. The unit suite tests/test-sync-client.mjs runs the same sync code in node; this
// drives the actual buttons — the paste modal and History's restore — and a real reload.
// Run: node e2e/sync.mjs (Playwright with Chromium needed, as for e2e/run.mjs).
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
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

const TOKEN = 'e2e-sync';
const dataDir = mkdtempSync(join(tmpdir(), 'ledger-e2e-sync-'));
const app = createApp({ dataDir, auth: TOKEN, htmlPath: join(here, '..', 'ledger.html'), push: false, offsiteTimer: false,
  fetchImpl: async () => { throw new Error('offline'); } });
const BASE = await new Promise(r => app.listen(0, '127.0.0.1', () => r('http://127.0.0.1:' + app.address().port)));
const H = { Authorization: 'Bearer ' + TOKEN, 'Content-Type': 'application/json' };
const get = async () => (await fetch(BASE + '/api/data', { headers: H })).json();
const put = async (rev, snapshot) => (await fetch(BASE + '/api/data', { method: 'PUT', headers: H, body: JSON.stringify({ rev, snapshot }) })).status;
const otherDevice = async fn => { const cur = await get(); const s = JSON.parse(JSON.stringify(cur.snapshot)); fn(s); eq(await put(cur.rev, s), 200); };
const W = c => '0x' + c.repeat(40);
const browser = await chromium.launch();

async function openPage() {
  const page = await browser.newPage(); const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', d => d.accept());
  await page.route('**/*', r => r.request().url().startsWith(BASE) ? r.continue() : r.abort());
  await page.addInitScript(tok => { try { localStorage.setItem('srv_token', tok); } catch (e) {} }, TOKEN);
  return { page, errors };
}
const booted = page => page.waitForFunction(() => typeof SRV !== 'undefined' && SRV.enabled && /Server sync/.test((document.querySelector('#datafile') || {}).textContent || ''), null, { timeout: 15000 });
const settled = page => page.waitForFunction(() => !_srvWriting && !JSON.parse(localStorage.getItem('srv_sync') || '{}').dirty, null, { timeout: 15000 });

try {
  await put(0, { app: 'ledger', wallets: [{ address: W('1'), label: 'main' }], settings: { tz: 'utc' }, journal: { 'day:2026-09-30': { review: 'GOOD NOTE' } } });
  const { page, errors } = await openPage();
  await page.goto(BASE + '/'); await booted(page);

  await t('a pasted full backup after another device saved: both land, and the status says restored only then', async () => {
    await otherDevice(s => { s.journal['day:2026-10-02'] = { review: 'from phone' }; });
    const backup = { app: 'ledger', version: 8, wallets: [{ address: W('3'), label: 'backup' }], settings: { tz: 'utc' }, journal: { 'day:2026-09-01': { review: 'RESTORED A' } } };
    await page.evaluate(b => { document.getElementById('pasteBox').value = JSON.stringify(b); document.getElementById('modalLoad').click(); }, backup);
    await page.waitForFunction(() => /^Backup restored: /.test(document.getElementById('status').textContent), null, { timeout: 15000 });
    const s = (await get()).snapshot;
    eq(Object.keys(s.journal).sort(), ['day:2026-09-01', 'day:2026-09-30', 'day:2026-10-02']);
    eq(s.wallets.map(w => w.address), [W('3')]);
    eq(errors, []);
  });

  await t('History → restore after another device wiped the journal: the server keeps the snapshot, and a “before restore” copy appears', async () => {
    await settled(page);
    mkdirSync(join(dataDir, 'snapshots'), { recursive: true });
    writeFileSync(join(dataDir, 'snapshots', '2026-09-30.json'), JSON.stringify({ rev: 1, snapshot: { app: 'ledger', wallets: [{ address: W('1') }], settings: { tz: 'utc' }, journal: { 'day:2026-09-30': { review: 'GOOD NOTE' } } } }));
    await otherDevice(s => { s.journal = {}; });
    await page.evaluate(() => toggleSnapHistory());
    await page.waitForSelector('.snapRestore[data-d="2026-09-30"]', { state: 'attached' }); // the bar sits in a panel hidden once wallets exist
    await Promise.all([page.waitForNavigation({ timeout: 15000 }), page.evaluate(() => document.querySelector('.snapRestore[data-d="2026-09-30"]').click())]);
    await booted(page);
    eq((await get()).snapshot.journal, { 'day:2026-09-30': { review: 'GOOD NOTE' } });
    eq(await page.evaluate(() => Object.keys(journal)), ['day:2026-09-30']);
    ok(readdirSync(join(dataDir, 'snapshots')).some(f => f.startsWith('pre-restore-')));
    await page.evaluate(() => toggleSnapHistory());
    await page.waitForSelector('.snapRestore[data-d^="pre-restore-"]', { state: 'attached' });
    ok(/before restore/.test(await page.textContent('.snapRestore[data-d^="pre-restore-"]')));
  });

  await t('a reload keeps auto-refresh off and the tax preset (settings the snapshot used to wipe)', async () => {
    await settled(page);
    await page.evaluate(async () => { settings.autoRefresh = false; settings.pzTiltAlerts = false; settings.taxExport = { preset: 'uk', cur: 'GBP' }; await Store.set(S_KEY, settings); });
    await settled(page);
    await page.reload(); await booted(page);
    eq(await page.evaluate(() => [settings.autoRefresh, settings.pzTiltAlerts, settings.taxExport]), [false, false, { preset: 'uk', cur: 'GBP' }]);
    eq(errors, []);
  });
} finally { await browser.close(); app.close(); }
report('e2e sync');
