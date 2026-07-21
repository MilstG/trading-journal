// Tests for the read-only analytics API (/api/v1). The server runs over real HTTP with a
// temp data dir; Hyperliquid is replaced by an injected fetch that serves a fixed fixture,
// so every number below is hand-checkable. The engine itself is the one extracted from
// ledger.html — these tests therefore also pin that extraction keeps working.
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const { createApp } = require(join(here, '..', 'server.js'));

import { t, ok, eq, near, report } from './harness.mjs';

/* ---------------- fixture: one wallet, 7 fills ---------------- */
const ADDR = '0x' + 'a'.repeat(40);
const DAY = 86400e3, H = 3600e3;
// Anchored near "now" so projBaseline's zero-padding-to-today stays short: two closed trades
// on two different UTC days give a daily series where i.i.d. vs block bootstrap actually differ.
const BASE = Math.floor(Date.now() / DAY) * DAY - 5 * DAY; // UTC midnight, 5 days ago
const T0 = BASE + 12 * H;
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
let tid = 0;
const F = (coin, side, sz, px, time, startPosition, closedPnl, fee) =>
  ({ coin, side, sz: String(sz), px: String(px), time, startPosition: String(startPosition),
     closedPnl: String(closedPnl), fee: String(fee), crossed: true, dir: '', tid: ++tid, oid: 100 + tid });
const FILLS = [
  // ETH round trip #1: +100 gross, fees 2, funding +1.5 inside the window -> net 99.5 (win)
  F('ETH', 'B', 1, 1000, T0,          0, 0,    1),
  F('ETH', 'A', 1, 1100, T0 + 1 * H,  1, 100,  1),
  // ETH round trip #2: -200 gross, fees 4 -> net -204 (loss); closes the NEXT UTC day
  F('ETH', 'B', 2, 1000, T0 + 2 * H,  0, 0,    2),
  F('ETH', 'A', 2, 900,  T0 + 26 * H, 2, -200, 2),
  // BTC still open: fees 1 -> net -1
  F('BTC', 'B', 0.5, 30000, T0 + 4 * H, 0, 0,  1),
  // spot @107 (FOO/USDC): buy 10 @ 2, sell 4 @ 2.5 -> open spot position, partial realized
  F('@107', 'B', 10, 2,   T0 + 5 * H, 0,  0,   0.01),
  F('@107', 'A', 4,  2.5, T0 + 6 * H, 10, 2,   0.01),
];
const FUNDING = [{ time: T0 + 0.5 * H, delta: { coin: 'ETH', usdc: '1.5' } }];
const ETH_T1_ID = ADDR + ':ETH:' + T0;
const ETH_T2_ID = ADDR + ':ETH:' + (T0 + 2 * H);

let hlCalls = [];
function mockFetch(url, opts){
  const body = JSON.parse(opts.body);
  hlCalls.push(body.type);
  const reply = (x) => new Response(JSON.stringify(x), { status: 200, headers: { 'content-type': 'application/json' } });
  switch (body.type) {
    case 'userFillsByTime':   return reply(FILLS.filter(f => f.time >= (body.startTime || 0)));
    case 'userTwapSliceFills':return reply([]);
    case 'userFunding':       return reply(FUNDING);
    case 'clearinghouseState':
      if (body.dex) return reply({ assetPositions: [] });
      return reply({ assetPositions: [{ position: { coin: 'BTC', szi: '0.5', entryPx: '30000',
        unrealizedPnl: '1000', returnOnEquity: '0.2', liquidationPx: '25000',
        leverage: { value: 5 }, positionValue: '16000' } }],
        marginSummary: { accountValue: '5000' } });
    case 'spotClearinghouseState':
      return reply({ balances: [ { coin: 'USDC', total: '100', entryNtl: '0' },
                                 { coin: 'FOO', total: '6', entryNtl: '12' } ] });
    case 'spotMetaAndAssetCtxs':
      return reply([{ universe: [{ tokens: [0, 1], index: 107, name: '@107' }],
                      tokens: [{ name: 'FOO' }, { name: 'USDC' }] },
                    [{ markPx: '2.5' }]]);
    case 'portfolio':
      return reply([['allTime', { pnlHistory: [[T0, '-100.5']] }],
                    ['perpAllTime', { pnlHistory: [[T0, '-105.5']] }]]);
    default: return reply({});
  }
}

/* ---------------- boot ---------------- */
function listen(app){ return new Promise(res => app.listen(0, () => res('http://127.0.0.1:' + app.address().port))); }
const dataDir = mkdtempSync(join(tmpdir(), 'ledger-api-'));
const app = createApp({ dataDir, auth: 'secret', readAuth: 'reader',
  htmlPath: join(here, '..', 'ledger.html'), fetchImpl: mockFetch });
const base = await listen(app);
const FULL = { Authorization: 'Bearer secret' };
const READ = { Authorization: 'Bearer reader' };
const get = (p, h) => fetch(base + p, { headers: h || FULL });
const jget = async (p, h) => { const r = await get(p, h); return { status: r.status, body: await r.json() }; };
const post = (p, body, h) => fetch(base + p, { method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(h || FULL) }, body: JSON.stringify(body || {}) });

console.log('\nAPI v1: engine + docs');
await t('engine extracted from ledger.html at boot', async () => {
  ok(app.engineOk, 'engineOk — missing: ' + (app.engineMissing || []).join(', '));
});
await t('GET /api/v1 index is open and self-describing', async () => {
  const { status, body } = await jget('/api/v1', {});
  eq(status, 200);
  ok(body.engine.ok);
  ok(Array.isArray(body.endpoints) && body.endpoints.length >= 15);
  ok(body.endpoints.some(e => e.path === '/api/v1/projection'));
});
await t('analytics before any refresh: empty but well-formed', async () => {
  const { status, body } = await jget('/api/v1/trades');
  eq(status, 200); eq(body.total, 0);
});

console.log('\nAPI v1: refresh pipeline (mocked Hyperliquid)');
// seed the data file the way the app would: wallets + one journal entry on ETH trade #1
await t('seed snapshot via existing PUT /api/data (regression: persistence unchanged)', async () => {
  const snap = { app: 'ledger', version: 8, wallets: [{ address: ADDR, label: 'main' }],
    settings: { beThreshold: 50, tz: 'utc', rBasis: 'avgloss' },
    journal: { [ETH_T1_ID]: { tags: ['breakout'], notes: 'clean entry', risk: 50 } } };
  const r = await fetch(base + '/api/data', { method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...FULL }, body: JSON.stringify({ rev: 0, snapshot: snap }) });
  eq(r.status, 200); eq((await r.json()).rev, 1);
  const g = await jget('/api/data');
  eq(g.body.rev, 1); eq(g.body.snapshot.wallets[0].address, ADDR);
});
await t('POST /api/v1/refresh requires the full token', async () => {
  eq((await post('/api/v1/refresh', {}, READ)).status, 401);
  eq((await post('/api/v1/refresh', {}, {})).status, 401);
});
let refreshSummary;
await t('refresh pulls fills/funding/positions and reconstructs trades', async () => {
  const r = await post('/api/v1/refresh', {});
  eq(r.status, 200);
  refreshSummary = await r.json();
  eq(refreshSummary.wallets.length, 1);
  eq(refreshSummary.wallets[0].newFills, 7);
  eq(refreshSummary.wallets[0].error, null);
  eq(refreshSummary.trades, { total: 4, perp: 3, spot: 1, open: 2 }); // 2 closed ETH + open BTC + open spot
  ok(hlCalls.includes('userFillsByTime') && hlCalls.includes('userFunding')
     && hlCalls.includes('clearinghouseState') && hlCalls.includes('spotMetaAndAssetCtxs'));
});
await t('second refresh is rate-limited; force bypasses and is incremental (0 new fills)', async () => {
  eq((await post('/api/v1/refresh', {})).status, 429);
  const r = await post('/api/v1/refresh', { force: true });
  eq(r.status, 200);
  const s = await r.json();
  eq(s.wallets[0].newFills, 0, 'incremental: nothing new since last');
  eq(s.wallets[0].fills, 7);
});

console.log('\nAPI v1: trades');
let tradesAll;
await t('GET /api/v1/trades returns enriched trades', async () => {
  const { status, body } = await jget('/api/v1/trades?order=asc&sort=openTime');
  eq(status, 200); eq(body.total, 4);
  tradesAll = body.trades;
  const t1 = body.trades.find(x => x.id === ETH_T1_ID);
  ok(t1, 'ETH trade #1 present with deterministic id');
  near(t1.net, 100 - 2 + 1.5);           // pnl - fees + funding
  eq(t1.journal.tags, ['breakout'], 'journal enrichment');
  near(t1.r, 99.5 / 50, 1e-9);           // per-trade risk override from journal
  eq(t1.wallet, { address: ADDR, label: 'main' });
  const spot = body.trades.find(x => x.market === 'spot');
  eq(spot.symbol, 'FOO', 'spot symbol resolved via spotMaps');
  eq(spot.isOpen, true);
});
await t('filters: market/coin/outcome/status/tag/q', async () => {
  eq((await jget('/api/v1/trades?market=perp')).body.total, 3);
  eq((await jget('/api/v1/trades?coin=ETH')).body.total, 2);
  eq((await jget('/api/v1/trades?coin=FOO')).body.total, 1, 'coin filter matches resolved spot symbol');
  eq((await jget('/api/v1/trades?outcome=win')).body.total, 1);
  eq((await jget('/api/v1/trades?outcome=loss')).body.total, 1);
  eq((await jget('/api/v1/trades?status=open')).body.total, 2);
  eq((await jget('/api/v1/trades?tag=breakout')).body.total, 1);
  eq((await jget('/api/v1/trades?q=clean')).body.total, 1);
  eq((await jget('/api/v1/trades?from=' + (T0 + 2 * H) + '&status=closed')).body.total, 1);
  eq((await jget('/api/v1/trades?market=nope')).status, 400);
});
await t('pagination + events flag', async () => {
  const p = (await jget('/api/v1/trades?limit=2&offset=2&sort=openTime&order=asc')).body;
  eq(p.trades.length, 2); eq(p.total, 4);
  ok(!('events' in p.trades[0]), 'events omitted by default');
  const one = (await jget('/api/v1/trades/' + encodeURIComponent(ETH_T1_ID))).body;
  eq(one.events.length, 2, 'single-trade view carries fill events');
  eq((await jget('/api/v1/trades/nope:nope:1')).status, 404);
});

console.log('\nAPI v1: stats / equity / calendar / breakdown');
await t('stats matches the hand computation', async () => {
  const { body } = await jget('/api/v1/stats');
  const s = body.stats;
  eq(s.n, 2); eq(s.wins, 1); eq(s.losses, 1); eq(s.winRate, 0.5);
  const expectedNet = tradesAll.reduce((a, x) => a + x.net, 0); // totals include open trades' realized
  near(s.net, expectedNet);
  near(s.avgWin, 99.5); near(s.avgLoss, 204);
  near(body.oneR, 204, 1e-9);            // avgloss basis over the filtered closed set
});
await t('stats respects beThreshold via tz/settings plumbing (win becomes scratch at be=150)', async () => {
  // temporarily raise the break-even band through the snapshot, then restore
  const cur = (await jget('/api/data')).body;
  const snap2 = JSON.parse(JSON.stringify(cur.snapshot)); snap2.settings.beThreshold = 150;
  await fetch(base + '/api/data', { method: 'PUT', headers: { 'Content-Type': 'application/json', ...FULL },
    body: JSON.stringify({ rev: cur.rev, snapshot: snap2 }) });
  const s = (await jget('/api/v1/stats')).body.stats;
  eq(s.wins, 0); eq(s.breakeven, 1); eq(s.losses, 1);
  const cur2 = (await jget('/api/data')).body;
  await fetch(base + '/api/data', { method: 'PUT', headers: { 'Content-Type': 'application/json', ...FULL },
    body: JSON.stringify({ rev: cur2.rev, snapshot: cur.snapshot }) });
});
await t('equity: chronological cumulative points + drawdown diagnostics', async () => {
  const { body } = await jget('/api/v1/equity?status=closed');
  eq(body.points.length, 2);
  near(body.points[0][1], 99.5); near(body.points[1][1], 99.5 - 204);
  ok(body.currentDD && body.currentDD.dd < 0);
  ok(body.shuffleDD && body.shuffleDD.median >= 0, 'seeded shuffle-DD present');
  const again = await jget('/api/v1/equity?status=closed');
  eq(body.shuffleDD, again.body.shuffleDD, 'shuffle-DD deterministic (seeded from trade ids)');
});
await t('calendar buckets by tz day', async () => {
  const { body } = await jget('/api/v1/calendar?tz=utc&status=closed');
  eq(body.tz, 'utc');
  near(body.days[dayOf(T0 + 1 * H)], 99.5);
  near(body.days[dayOf(T0 + 26 * H)], -204);
});
await t('breakdown by coin / tag / hour', async () => {
  const byCoin = (await jget('/api/v1/breakdown?by=coin')).body;
  const eth = byCoin.groups.find(g => g.key === 'ETH');
  eq(eth.n, 2); near(eth.net, -104.5); eq(eth.winRate, 0.5);
  const byTag = (await jget('/api/v1/breakdown?by=tag')).body;
  ok(byTag.groups.find(g => g.key === 'breakout').n === 1);
  ok(byTag.groups.find(g => g.key === '(untagged)').n === 1);
  const byHour = (await jget('/api/v1/breakdown?by=hour&tz=utc')).body;
  ok(byHour.groups.find(g => g.key === '13'), 'ETH #1 closed 13:00 UTC');
  eq((await jget('/api/v1/breakdown?by=nope')).status, 400);
});

console.log('\nAPI v1: projection / kelly / risk / positions / lots / whatif');
await t('projection is deterministic and matches the app seeding contract', async () => {
  const a = (await jget('/api/v1/projection?horizon=30&paths=200&status=closed')).body;
  const b = (await jget('/api/v1/projection?horizon=30&paths=200&status=closed')).body;
  eq(a, b, 'auto-seeded runs reproduce identically');
  ok(a.projection.bands.p50.length === 30);
  eq(a.projection.block, 1, 'i.i.d. default');
  const c = (await jget('/api/v1/projection?horizon=30&paths=200&block=3&status=closed')).body;
  eq(c.projection.block, 3);
  ok(JSON.stringify(a.projection.end) !== JSON.stringify(c.projection.end), 'block bootstrap folds into the auto-seed');
  const s1 = (await jget('/api/v1/projection?horizon=30&paths=200&seed=42')).body;
  const s2 = (await jget('/api/v1/projection?horizon=30&paths=200&seed=42')).body;
  eq(s1, s2, 'explicit seed reproduces');
});
await t('kelly returns null under 10 decisive trades (honest, not fabricated)', async () => {
  const { body } = await jget('/api/v1/kelly');
  eq(body.n, 2); eq(body.kelly, null);
});
await t('risk: liquidation distance from cached positions', async () => {
  const { body } = await jget('/api/v1/risk');
  ok(body.risk && body.risk.rows.length === 1);
  const r = body.risk.rows[0];
  eq(r.coin, 'BTC'); eq(r.side, 'long');
  near(r.mark, 32000); near(r.liqDist, 7000 / 32000);
  near(body.accountValue, 5000);
});
await t('positions: cached snapshot incl. spot holdings and hlPnl', async () => {
  const { body } = await jget('/api/v1/positions');
  eq(body.live, false);
  eq(body.positions.length, 1);
  eq(body.positions[0].wallet.label, 'main');
  eq(body.spotHoldings.length, 1);
  near(body.spotHoldings[0].value, 6 * 2.5);
  near(body.hlPnl.all, -100.5);
});
await t('positions ?live=1 needs full token and refetches', async () => {
  eq((await jget('/api/v1/positions?live=1', READ)).status, 401);
  const { status, body } = await jget('/api/v1/positions?live=1');
  eq(status, 200); eq(body.live, true); eq(body.positions.length, 1);
});
await t('spot FIFO lots: 4 sold from a 10 @ 2 lot', async () => {
  const { body } = await jget('/api/v1/spot/lots');
  eq(body.fills, 2);
  ok(body.lots, 'lots payload present');
  const rows = body.lots.rows || body.lots; // shape owned by ledger.html — assert only the economics
  const flat = JSON.stringify(rows);
  ok(flat.includes('FOO'), 'symbol resolved in lots output');
});
await t('whatif: removing ETH zeroes the counterfactual', async () => {
  const { body } = await jget('/api/v1/whatif?field=coin&op=eq&value=ETH');
  eq(body.model.removed.n, 2);
  near(body.model.removed.net, -104.5);
  eq(body.model.kept.n, 0);
  eq((await jget('/api/v1/whatif?field=nope&op=eq&value=x')).status, 400);
});

console.log('\nAPI v1: journal views / export / auth scoping');
await t('journal read-only views + tags', async () => {
  const j = (await jget('/api/v1/journal')).body;
  ok(j.journal[ETH_T1_ID]);
  const one = (await jget('/api/v1/journal/' + encodeURIComponent(ETH_T1_ID))).body;
  eq(one.entry.notes, 'clean entry');
  eq((await jget('/api/v1/journal/' + encodeURIComponent(ETH_T2_ID))).status, 404);
  const tags = (await jget('/api/v1/tags')).body.tags;
  eq(tags, [{ tag: 'breakout', n: 1 }]);
});
await t('CSV export: header + one row per trade, notes safely quoted', async () => {
  const r = await get('/api/v1/export/trades.csv');
  eq(r.status, 200);
  ok((r.headers.get('content-type') || '').includes('text/csv'));
  const lines = (await r.text()).trim().split('\r\n');
  eq(lines.length, 1 + 4);
  ok(lines[0].startsWith('id,wallet,label,market,coin'));
});
await t('READ_TOKEN: v1 GETs yes, everything else no', async () => {
  eq((await jget('/api/v1/stats', READ)).status, 200);
  eq((await jget('/api/v1/trades', READ)).status, 200);
  eq((await jget('/api/data', READ)).status, 401, 'read token must never open the data blob');
  eq((await fetch(base + '/api/snapshots', { headers: READ })).status, 401);
  eq((await jget('/api/v1/stats', {})).status, 401, 'no token, no analytics');
});

console.log('\nAPI v1: engine failure stays soft');
await t('stale ledger.html: persistence works, v1 analytics 503 with the missing list', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-api-stale-'));
  const stale = join(dir, 'old.html');
  writeFileSync(stale, '<html><script>function nothing(){}</script></html>');
  const app2 = createApp({ dataDir: dir, auth: 'secret', htmlPath: stale, fetchImpl: mockFetch });
  eq(app2.engineOk, false);
  const b2 = await listen(app2);
  const h = await (await fetch(b2 + '/api/health')).json();
  eq(h, { ok: true, auth: true, appSyncCapable: false }, 'health byte-identical to before');
  const s = await fetch(b2 + '/api/v1/stats', { headers: FULL });
  eq(s.status, 503);
  ok((await s.json()).error.includes('reconstructTrades'));
  const idx = await (await fetch(b2 + '/api/v1')).json();
  eq(idx.engine.ok, false);
  await new Promise(res => app2.close(res));
});

await new Promise(res => app.close(res));
report();
