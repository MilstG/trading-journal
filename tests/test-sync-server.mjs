// The server's side of persistence: a restore's pre-restore copy (the state it replaced is kept,
// listed and restorable — "today's snapshot" was overwritten by the restore's own save), and the
// weekly digest (never built off a skipped refresh, never posted twice by overlapping runs).
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync, readdirSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import zlib from 'node:zlib';
import { t, ok, eq, report } from './harness.mjs';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const { createApp } = require('../server.js');
const htmlPath = join(here, '..', 'ledger.html');
const reply = x => new Response(JSON.stringify(x), { status: 200, headers: { 'content-type': 'application/json' } });

console.log('\nSnapshots: the state a restore replaces is kept');
await t('a restore keeps what it replaced as a pre-restore copy, listed and fetchable; later saves don’t touch it', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'ledger-prerestore-'));
  const app = createApp({ dataDir, auth: 't', htmlPath, push: false, offsiteTimer: false, fetchImpl: async () => { throw new Error('offline'); } });
  const base = await new Promise(r => app.listen(0, '127.0.0.1', () => r('http://127.0.0.1:' + app.address().port)));
  const H = { Authorization: 'Bearer t', 'Content-Type': 'application/json' };
  const put = async (rev, journal, extra) => (await fetch(base + '/api/data', { method: 'PUT', headers: H, body: JSON.stringify(Object.assign({ rev, snapshot: { journal } }, extra)) })).status;
  const list = async () => (await (await fetch(base + '/api/snapshots', { headers: H })).json()).snapshots;
  try {
    // the audit's repro: today's work {a, b}; a restore {old}; one more edit {old, c}
    eq(await put(0, { a: 'today work 1' }), 200); eq(await put(1, { a: 'today work 1', b: 'today work 2' }), 200);
    eq((await list()).filter(s => s.kind === 'pre-restore').length, 0, 'ordinary saves keep no extra copies');
    eq(await put(2, { old: 'restored from an older snapshot' }, { restore: true }), 200);
    eq(await put(3, { old: 'restored', c: 'one more edit' }), 200);
    const snaps = await list(), pre = snaps.filter(s => s.kind === 'pre-restore');
    eq(pre.length, 1, 'one copy, made by the restore');
    ok(/^pre-restore-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/.test(pre[0].id) && /Z$/.test(pre[0].at), JSON.stringify(pre[0]));
    eq(snaps[0].id, pre[0].id, 'newest first: the copy sorts before its own day');
    eq(snaps.find(s => !s.kind).id, snaps.find(s => !s.kind).date, 'a day keeps its date as its id');
    const got = await (await fetch(base + '/api/snapshots/' + pre[0].id, { headers: H })).json();
    eq(got.snapshot.journal, { a: 'today work 1', b: 'today work 2' }, 'today’s work before the restore is recoverable');
    eq(got.rev, 2);
    eq((await fetch(base + '/api/snapshots/pre-restore-../../x', { headers: H })).status, 404, 'only well-formed names are served');
    // a save that drops most of the journal at once (a stale or broken client's wipe) is kept the same way
    const twelve = Object.fromEntries(Array.from({ length: 12 }, (_, i) => ['day:' + i, { review: 'n' + i }]));
    eq(await put(4, twelve), 200); eq((await list()).filter(s => s.kind === 'pre-restore').length, 1, 'replacing 2 small entries isn’t a wipe');
    eq(await put(5, {}), 200);
    eq((await list()).filter(s => s.kind === 'pre-restore').length, 2);
    // pruned to the newest 5; the daily snapshots are untouched by the pruning
    for (let i = 0; i < 6; i++) { await new Promise(r => setTimeout(r, 2)); eq(await put(6 + i, { ['k' + i]: 1 }, { restore: true }), 200); }
    const after = await list();
    eq(after.filter(s => s.kind === 'pre-restore').length, 5); eq(after.filter(s => !s.kind).length, 1);
    eq(readdirSync(join(dataDir, 'snapshots')).filter(f => f.endsWith('.tmp')), []);
  } finally { app.close(); }
});

console.log('\nWeekly digest');
// a closed trade in LAST week, so there is a digest to write
const lastWeekFills = () => {
  const nowD = new Date(), dow = (nowD.getUTCDay() + 6) % 7;
  const monday = Date.UTC(nowD.getUTCFullYear(), nowD.getUTCMonth(), nowD.getUTCDate() - dow), ct = monday - 3 * 864e5;
  const f = (side, px, time, sp, pnl, tid) => ({ coin: 'SOL', side, sz: '1', px: String(px), time, startPosition: sp, closedPnl: pnl, fee: '0', crossed: true, dir: '', tid, oid: tid });
  return [f('B', 100, ct - 3600e3, '0', '0', 1), f('A', 600, ct, '1', '500', 2)];
};
async function digestServer(fetchImpl, hookDelay) {
  const posts = [];
  const hook = http.createServer((req, res) => { let b = ''; req.on('data', c => b += c);
    req.on('end', () => { posts.push(JSON.parse(b).text); setTimeout(() => res.end('ok'), hookDelay || 0); }); });
  await new Promise(r => hook.listen(0, r));
  const dataDir = mkdtempSync(join(tmpdir(), 'ledger-digest-')), A = '0x' + 'd'.repeat(40);
  mkdirSync(join(dataDir, 'fills'), { recursive: true });
  const fills = lastWeekFills();
  writeFileSync(join(dataDir, 'fills', A + '.json.gz'), zlib.gzipSync(JSON.stringify({ v: 1, last: fills[1].time, count: 2, savedAt: Date.now(), truncated: false, fills })));
  writeFileSync(join(dataDir, 'ledger-data.json'), JSON.stringify({ rev: 1, snapshot: { journal: {}, settings: {}, wallets: [{ address: A, label: 'a' }] } }));
  const app = createApp({ dataDir, auth: 's', htmlPath, fetchImpl, push: false, offsiteTimer: false, noTelegramLoop: true,
    alerts: { webhook: 'http://127.0.0.1:' + hook.address().port + '/hook' }, diskStat: () => ({ free: 10 * 1024 ** 3, total: 20 * 1024 ** 3 }) });
  const digests = () => { try { return readdirSync(join(dataDir, 'reports')).filter(f => /^weekly-/.test(f)); } catch (e) { return []; } };
  return { app, posts, digests, dataDir, close: () => { app.close(); hook.close(); } };
}
const exchange = (gate) => async (url, o) => {
  if (gate) await gate;
  const ty = JSON.parse(o.body).type;
  if (ty === 'clearinghouseState') return reply({ assetPositions: [], marginSummary: { accountValue: '0' } });
  if (ty === 'spotClearinghouseState') return reply({ balances: [] });
  if (ty === 'spotMetaAndAssetCtxs') return reply([{ universe: [], tokens: [] }, []]);
  return reply([]);
};

await t('a tick that finds a refresh already running skips the digest too (it would be built from stale caches)', async () => {
  let release; const gate = new Promise(r => { release = r; });
  const S = await digestServer(exchange(gate));
  try {
    const slow = S.app._runScheduledRefresh(); // e.g. the boot or a manual refresh, still fetching
    eq(await S.app._scheduledTick(), null, 'the tick skipped');
    eq(S.digests(), [], 'no digest written off the caches the running refresh hasn’t updated yet');
    release(); eq(await slow, 'ran');
    await S.app._scheduledTick();
    eq(S.digests().length, 1, 'the next tick after a good refresh writes it');
    eq(S.posts.filter(p => p.includes('Week ending')).length, 1);
  } finally { S.close(); }
});

await t('two overlapping digest runs post the week once', async () => {
  const S = await digestServer(exchange(null), 300); // a slow webhook: the second run starts while the first is posting
  try {
    eq(await S.app._runScheduledRefresh(), 'ran');
    await Promise.all([S.app._maybeDigest(), S.app._maybeDigest()]);
    eq(S.posts.filter(p => p.includes('Week ending')).length, 1, JSON.stringify(S.posts));
    const f = S.digests(); eq(f.length, 1);
    eq(JSON.parse(readFileSync(join(S.dataDir, 'reports', f[0]), 'utf8')).webhookSent, true, 'marked sent');
    await S.app._maybeDigest();
    eq(S.posts.filter(p => p.includes('Week ending')).length, 1, 'and not again on the next run');
  } finally { S.close(); }
});

report('sync-server');
