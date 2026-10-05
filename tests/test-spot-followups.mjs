// AUDIT-6: what the whole-position spot change (fb6acb1) left behind, fixed and pinned here.
//  - the server's "today" (alerts, the Telegram bot) and its weekly digest counted spot twice, or on the wrong day
//  - dust left by an exit made the next position on that coin "opened before the history"
//  - notes written on the old per-sell-run spot ids (and on day rows the inbox offered) matched nothing
//  - spot day rows were cut at the browser's midnight whatever the app's clock
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { t, ok, eq, near, report, makeExtractor } from './harness.mjs';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const { readAppSource } = require(join(here, '..', 'app-source.js'));
const { createApp } = require(join(here, '..', 'server.js'));
const SRC = readAppSource(join(here, '..', 'ledger.html'));
const { grabFn } = makeExtractor(SRC);
const DAY = 864e5, H = 36e5;

const ctx = { Math, Object, Array, String, Number, JSON, isFinite, Date, Set, Map, parseFloat, console, settings: { tz: 'utc' } };
vm.createContext(ctx);
vm.runInContext(['tzParts', 'tzMidnight', 'isPerp', 'newTrade', 'tallyFill', 'reconstructTrades', 'retPct', 'tradeRow', 'moneyRow', 'migrateSpotJournalIds'].map(grabFn).join('\n'), ctx);
let id = 0;
const F = (coin, side, sz, px, time, start, closedPnl, fee = 0, feeToken = 'USDC') => ({ coin, side, sz: String(sz), px: String(px), time, startPosition: String(start), closedPnl: String(closedPnl), fee: String(fee), feeToken, tid: ++id, oid: id, crossed: true, dir: side === 'B' ? 'Buy' : 'Sell' });

console.log('\nSpot positions');
t('dust an exit left is flat: the next position on that coin is whole, with an entry and a return', () => {
  const T = Date.UTC(2026, 8, 1);
  // buy 10 (0.007 HYPE fee, 9.993 arrive), sell 9.99: 0.003 HYPE ($0.12) is left and read as flat; a week later buy and sell again
  const fills = [F('@107', 'B', 10, 40, T, 0, 0, 0.007, 'HYPE'), F('@107', 'A', 9.99, 44, T + H, 9.993, 39.6, 0.3),
    F('@107', 'B', 5, 40, T + 7 * DAY, 0.003, 0, 0.0035, 'HYPE'), F('@107', 'A', 4.99, 42, T + 8 * DAY, 4.9995, 9.8, 0.15)];
  const tr = ctx.reconstructTrades(fills, '0xw', 'spot').filter(x => x.spotPos).sort((a, b) => a.openTime - b.openTime);
  eq(tr.map(x => [!!x.isOpen, !!x.partialHistory, x.openSz]), [[false, false, 10], [false, false, 5]]);
  ok(ctx.retPct(Object.assign({ net: tr[1].pnl - tr[1].fees }, tr[1])) > 0, 'the second trade has a return');
  // a real holding from before the history (worth more than dust) is still partial
  const held = ctx.reconstructTrades([F('@108', 'A', 5, 40, T, 20, 10)], '0xw', 'spot').find(x => x.spotPos);
  ok(held.partialHistory, 'a $800 holding sold from is partial history');
});

console.log('\nJournal ids from the per-sell-run spot build');
t('notes on old sell-run ids, on a held rest and on day rows land on the position that holds them, once', () => {
  const T = Date.UTC(2026, 6, 1);
  // a stack bought once and sold in three steps, a buy in between: the old build made two trades of it
  const fills = [F('@107', 'B', 30, 40, T, 0, 0), F('@107', 'A', 10, 45, T + DAY, 30, 50), F('@107', 'B', 10, 42, T + 2 * DAY, 20, 0),
    F('@107', 'A', 10, 47, T + 3 * DAY, 30, 60), F('@107', 'A', 5, 50, T + 4 * DAY, 20, 45)];
  const trades = ctx.reconstructTrades(fills, '0xw', 'spot');
  const pos = trades.find(x => x.spotPos), rz = trades.find(x => x.spotRz && x.closeTime === T + 3 * DAY);
  eq(pos.id, '0xw:spot:@107:' + T); ok(pos.isOpen, 'still held');
  let edits = [];
  ctx.markJEdit = i => edits.push(i); ctx._sample = null;
  ctx.journal = {
    ['0xw:spot:@107:' + (T + DAY + 1)]: { notes: 'sold the second leg too early', tags: ['fomo'], updatedAt: 1 }, // a later sell run
    ['0xw:spot:@107:' + T + ':held']: { rating: 4, tags: ['swing'], updatedAt: 2 }, // the still-held rest
    [rz.id]: { setup: 'breakout', updatedAt: 3 }, // a day row the inbox offered
    ['0xw:spot:@999:' + T]: { notes: 'a coin with no position: left alone' },
  };
  eq(vm.runInContext('migrateSpotJournalIds', ctx)(trades), 3);
  const j = ctx.journal[pos.id];
  eq([j.notes, j.tags, j.rating, j.setup], ['sold the second leg too early', ['fomo', 'swing'], 4, 'breakout']);
  ok(ctx.journal['0xw:spot:@107:' + T + ':held'], 'the old keys stay for a device still on the old build');
  eq(edits, [pos.id, pos.id, pos.id], 'each move is an edit, so it syncs');
  edits = [];
  eq(vm.runInContext('migrateSpotJournalIds', ctx)(trades), 0, 'laying them on again changes nothing'); eq(edits, []);
  // notes written on both: appended, not replaced
  ctx.journal[pos.id].notes = 'my own note';
  vm.runInContext('migrateSpotJournalIds', ctx)(trades);
  eq(ctx.journal[pos.id].notes, 'my own note\n\nsold the second leg too early');
});

console.log('\nThe clock');
t('spot day rows end at midnight on the app’s clock, and the reconstruction cache key carries the clock', () => {
  ok(/kind==='reconstruct'\)\{if\(d\.payload\.tz\)settings\.tz=d\.payload\.tz/.test(SRC), 'the worker takes the app’s clock');
  ok(/runInWorker\('reconstruct',\{fills,frows,addr,tz:settings\.tz\}\)/.test(SRC), 'reconstructCompute sends it');
  ok(/const recSig=[^\n]*settings\.tz[^\n]*settings\.tzZone/.test(SRC), 'a memo built on the other clock is not reused');
  const T = Date.UTC(2026, 9, 1, 23), fills = [F('@107', 'B', 10, 40, T - 2 * H, 0, 0), F('@107', 'A', 5, 50, T, 10, 50), F('@107', 'A', 5, 52, T + 3 * H, 5, 60)];
  ctx.settings.tz = 'utc';
  eq(ctx.reconstructTrades(fills, '0xw', 'spot').filter(x => x.spotRz && x.pnl).map(x => x.pnl), [60, 50], 'UTC: 23:00 and 02:00 are two days');
});

console.log('\nThe server’s today and its weekly digest');
await t('alerts, the bot and the digest count spot once, by the day it was realized', async () => {
  const ADDR = '0x' + 'c'.repeat(40);
  const nowD = new Date(), dow = (nowD.getUTCDay() + 6) % 7, monday = Date.UTC(nowD.getUTCFullYear(), nowD.getUTCMonth(), nowD.getUTCDate() - dow);
  const lw = monday - 4 * DAY + 12 * H, now = Date.now() - 60e3;
  const FILLS = [
    F('@107', 'B', 10, 40, lw, 0, 0), F('@107', 'A', 10, 30, lw + H, 10, -100), // last week: a round trip, -100
    F('PURR/USDC', 'B', 1000, 0.1, lw - DAY, 0, 0), F('PURR/USDC', 'A', 500, 0.2, lw + 2 * H, 1000, 50), // last week: +50 sold, half still held
    F('@107', 'B', 100, 40, now - 10 * 60e3, 0, 0), F('@107', 'A', 50, 34, now, 100, -300), // today: -300 on a partial sell, still held
  ];
  const reply = x => new Response(JSON.stringify(x), { status: 200, headers: { 'content-type': 'application/json' } });
  const fetchImpl = async (url, opts) => { const b = JSON.parse(opts.body);
    switch (b.type) {
      case 'userFillsByTime': return reply(FILLS.filter(f => f.time >= (b.startTime || 0)));
      case 'clearinghouseState': return reply({ assetPositions: [], marginSummary: { accountValue: '0' } });
      case 'spotClearinghouseState': return reply({ balances: [{ coin: 'USDC', total: '1000', entryNtl: '0' }, { coin: 'HYPE', total: '50', entryNtl: '2000' }, { coin: 'PURR', total: '500', entryNtl: '50' }] });
      case 'spotMetaAndAssetCtxs': return reply([{ universe: [{ tokens: [1, 0], index: 107, name: '@107' }, { tokens: [2, 0], index: 0, name: 'PURR/USDC' }], tokens: [{ name: 'USDC', index: 0 }, { name: 'HYPE', index: 1 }, { name: 'PURR', index: 2 }] }, []]);
      case 'portfolio': return reply([]);
      default: return reply([]);
    } };
  const app = createApp({ dataDir: mkdtempSync(join(tmpdir(), 'ledger-spotfu-')), auth: 'secret', htmlPath: join(here, '..', 'ledger.html'), fetchImpl, push: false, pushTick: false, offsiteTimer: false });
  const base = await new Promise(r => app.listen(0, '127.0.0.1', () => r('http://127.0.0.1:' + app.address().port)));
  const HD = { Authorization: 'Bearer secret', 'Content-Type': 'application/json' };
  try {
    const snap = { app: 'ledger', version: 8, wallets: [{ address: ADDR, label: 'main' }], settings: { tz: 'utc', rules: { dailyLossLimit: 400 } }, journal: {} };
    await fetch(base + '/api/data', { method: 'PUT', headers: HD, body: JSON.stringify({ rev: 0, snapshot: snap }) });
    eq((await fetch(base + '/api/v1/refresh', { method: 'POST', headers: HD, body: '{}' })).status, 200);
    const d = app._weeklyDigest().digest;
    eq([d.n, d.net], [1, -50], 'last week: one trade done, -50 realized (the held PURR’s sale counts as money, not a trade)');
    const a = app._gatherAlertState(), b = app._buildBotState();
    near(a.todayNet, -300, 1e-6, 'the alert sees today’s partial sell'); near(b.todayNet, -300, 1e-6, 'so does the bot'); eq(b.todayN, 0, 'and no trade closed today');
    const m = await (await fetch(base + '/api/v1/metrics', { headers: HD })).json();
    eq([m.net_today, m.trades_today], [-300, 0], '/metrics agrees');
  } finally { await new Promise(r => app.close(r)); }
});

report('spot follow-ups');
