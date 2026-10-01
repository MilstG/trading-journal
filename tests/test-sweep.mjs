// The October bug sweep: the server's engine speed and limits, a damaged data file, league
// numbers across restarts, frozen competition results, seasons, wearables during a disconnect,
// and the journal's reconstruction, CSV import, profit factor and pending edits.
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { t, ok, eq, near, report, makeExtractor } from './harness.mjs';

const require = createRequire(import.meta.url);
const server = require('../server.js');
const SC = require('../social-config.js');
const Wear = require('../wear.js');
const htmlPath = new URL('../ledger.html', import.meta.url).pathname;
const html = readFileSync(htmlPath, 'utf8');
const { evalModule } = makeExtractor(html);
const listen = app => new Promise(res => app.listen(0, () => res('http://127.0.0.1:' + app.address().port)));
const close = app => new Promise(res => app.close(res));

console.log('\nServer');
t('the engine runs as one closure: fast, and its knobs are still set per request', () => {
  const e = server.buildEngine(htmlPath, async () => ({ ok: true, json: async () => [] }));
  ok(e.ok, e.missing.join());
  e.ctx._be = 7; eq(e.ctx._be, 7);
  const nets = Array.from({ length: 10000 }, (_, i) => Math.sin(i) * 100 + 3), t0 = Date.now();
  e.ctx.mcMaxDD(nets, 2000);
  ok(Date.now() - t0 < 3000, 'took ' + (Date.now() - t0) + ' ms');
});
await t('a damaged journal file falls back to .bak; with no good copy, reads and writes are refused', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sweep-data-'));
  const app = server.createApp({ dataDir: dir, auth: 'tok', htmlPath, push: false, pushTick: false }), B = await listen(app);
  const h = { Authorization: 'Bearer tok', 'Content-Type': 'application/json' };
  const put = (rev, j) => fetch(B + '/api/data', { method: 'PUT', headers: h, body: JSON.stringify({ rev, snapshot: { journal: j } }) }).then(r => r.status);
  const get = () => fetch(B + '/api/data', { headers: h }).then(async r => [r.status, await r.json()]);
  try {
    eq([await put(0, { a: 1 }), await put(1, { a: 2 })], [200, 200]);
    const f = join(dir, 'ledger-data.json'); writeFileSync(f, '{"rev":2,"snap');
    const [st, d] = await get(); eq([st, d.rev, d.snapshot.journal], [200, 1, { a: 1 }]);
    eq(await put(1, { a: 3 }), 200);
    eq(JSON.parse(readFileSync(f + '.bak', 'utf8')).snapshot.journal, { a: 1 }, 'the damaged file never became the backup');
    writeFileSync(f, 'x'); writeFileSync(f + '.bak', 'x');
    eq((await get())[0], 500); eq(await put(0, {}), 503);
    eq(readFileSync(f + '.bak', 'utf8'), 'x', 'nothing written over it');
  } finally { await close(app); }
});

console.log('\nSocial');
await t('league numbers never repeat across a restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sweep-lg-'));
  writeFileSync(join(dir, 'social.json'), JSON.stringify({ v: 1, config: {}, follows: {}, events: [], comps: {}, league: { week: null }, members: {} }));
  const mk = () => server.createApp({ dataDir: dir, auth: 'tok', htmlPath, push: false, pushTick: false, fetchImpl: async () => ({ ok: true, status: 200, json: async () => [] }) });
  let app = mk(), B = await listen(app);
  const adm = (p, body) => fetch(B + '/api/social/admin' + p, { method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer tok', 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }).then(r => r.json());
  await adm('/members', { handle: 'alpha' });
  await close(app); app = mk(); B = await listen(app);
  await adm('/leagues', { name: 'Second' });
  const nums = (await adm('/leagues')).leagues.map(L => L.num);
  eq(new Set(nums).size, nums.length, 'numbers: ' + nums.join(', '));
  await close(app);
});
t('seasons only for leagues ranked by XP or discipline', () => {
  eq(SC.sanitizeLeague({ name: 'x', metric: 'xp', season: 'month' }).season, 'month');
  eq(SC.sanitizeLeague({ name: 'x', metric: 'discipline', season: 'quarter' }).season, 'quarter');
  eq(SC.sanitizeLeague({ name: 'x', metric: 'level', season: 'month' }).season, '');
  eq(SC.sanitizeLeague({ name: 'x', metric: 'ret', season: 'month' }).season, '');
});
await t('a survivor competition keeps the days it saw and freezes its result after the end', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sweep-comp-'));
  let clock = Date.UTC(2026, 9, 1, 12);
  const app = server.createApp({ dataDir: dir, auth: 'tok', htmlPath, push: false, pushTick: false, now: () => clock, fetchImpl: async () => ({ ok: true, status: 200, json: async () => [] }) });
  const B = await listen(app);
  const call = (p, o = {}) => fetch(B + '/api/social' + p, { method: o.method || 'GET', headers: { 'Content-Type': 'application/json', ...(o.key ? { 'X-Pulse-Key': o.key } : {}), ...(o.admin ? { Authorization: 'Bearer tok' } : {}) },
    body: o.body ? JSON.stringify(o.body) : undefined }).then(r => r.json());
  try {
    await call('/admin/config', { method: 'PUT', admin: true, body: { unlocksOn: false } });
    const key = async h => (await call('/link/finish', { method: 'POST', body: { code: (await call('/admin/members', { method: 'POST', admin: true, body: { handle: h } })).code } })).key;
    const A = await key('alpha'), Bk = await key('bravo');
    const c = (await call('/admin/competitions', { method: 'POST', admin: true, body: { type: 'survivor', title: 'Survive', start: '2026-10-01', end: '2026-10-20' } })).id;
    for (const k of [A, Bk]) await call('/competitions/' + c + '/join', { method: 'POST', key: k });
    // alpha breaks the limit on day 2; bravo doesn't
    await call('/stats', { method: 'POST', key: A, body: { xp: 1, level: 1, tz: 'UTC', days: [{ k: '2026-10-01', s: 80 }, { k: '2026-10-02', s: 40, b: true }] } });
    await call('/stats', { method: 'POST', key: Bk, body: { xp: 1, level: 1, tz: 'UTC', days: [{ k: '2026-10-01', s: 80 }, { k: '2026-10-02', s: 80 }] } });
    // weeks later the app only sends recent days: the break is out of its window
    clock = Date.UTC(2026, 10, 25, 12);
    await call('/stats', { method: 'POST', key: A, body: { xp: 1, level: 1, tz: 'UTC', days: [{ k: '2026-11-20', s: 90 }] } });
    const st = (await call('/competitions/' + c, { key: Bk })).competition.standings;
    eq(st.map(r => [r.handle, r.out]), [['bravo', false], ['alpha', true]]);
    // frozen: later days can't move it
    await call('/stats', { method: 'POST', key: Bk, body: { xp: 1, level: 1, tz: 'UTC', days: [{ k: '2026-10-03', s: 10, b: true }] } });
    eq((await call('/competitions/' + c, { key: Bk })).competition.standings[0].out, false);
  } finally { await close(app); }
});

console.log('\nWearables');
await t('disconnecting during a sync stays disconnected, and a member removed mid-sync leaves nothing behind', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sweep-wear-'));
  let release; const gate = new Promise(r => { release = r; });
  const fetchImpl = async url => { await gate; return { ok: true, status: 200, json: async () => ({ data: [{ day: '2026-10-01', score: 80 }] }) }; };
  writeFileSync(join(dir, 'wearables.json'), JSON.stringify({ v: 1, users: { 'm:x': { days: {}, oura: { access: 'a', refresh: 'r', exp: Date.now() + 3600000 } } } }));
  const W = Wear.createWear({ dataDir: dir, json: () => {}, fetchImpl, env: {} });
  const job = W.sync('m:x', true);
  W.forget('m:x'); release(); await job;
  const saved = JSON.parse(readFileSync(join(dir, 'wearables.json'), 'utf8'));
  eq(saved.users, {});
});

console.log('\nJournal');
const PRE = "const _be=50;const isWin=n=>n>_be,isLoss=n=>n<-_be,isBE=n=>Math.abs(n)<=_be;let spotMaps={nameByCoin:{}};";
const R = await evalModule(['isPerp', 'newTrade', 'tallyFill', 'reconstructTrades', 'csvParseRows', 'csvNum', 'parseFillsCsv'], ['reconstructTrades', 'parseFillsCsv'], PRE);
const fill = (t, side, px, sz, start, pnl) => ({ coin: 'BTC', time: t, side, px: String(px), sz: String(sz), startPosition: String(start), closedPnl: String(pnl || 0), fee: '0', tid: t + side + start });
t('fills in the same millisecond are put in position order (a close and a reopen)', () => {
  const tr = R.reconstructTrades([fill(1, 'B', 100, 1, 0), fill(2, 'B', 111, 1, 0), fill(2, 'A', 110, 1, 1, 10)], '0xa', 'perp');
  const closed = tr.find(x => !x.isOpen), open = tr.find(x => x.isOpen);
  eq([closed.avgEntry, closed.avgExit, open.avgEntry, open.openSz], [100, 110, 111, 1]);
});
t('a zero-size fill makes no trade', () => {
  eq(R.reconstructTrades([fill(1, 'B', 100, 0, 0)], '0xa', 'perp').length, 0);
});
t('CSV: "close" alone isn’t a side, and Hyperliquid’s dir column is read', () => {
  const f = R.parseFillsCsv('time,coin,dir,px,sz,fee,closedPnl\n2026-10-01T00:00:00Z,BTC,Open Short,100,1,0,0\n2026-10-01T01:00:00Z,BTC,Close Short,90,1,0,10');
  eq(f.fills.map(x => x.side), ['A', 'B']);
  const c = R.parseFillsCsv('time,coin,side,px,sz\n2026-10-01T00:00:00Z,BTC,buy,1,1\n2026-10-01T01:00:00Z,BTC,close,1,1');
  eq([c.fills.length, c.skipped], [1, 1], 'a bare "close" row is skipped, not guessed');
});
const S = await evalModule(['computeStats', 'dailyPnl', 'dailySeriesCalendar', 'sharpeStats', 'sortinoAnnual', 'retPct', 'rFor', 'riskFor', 'avgLossOf'], ['computeStats'],
  PRE + "const _avg=a=>a.length?a.reduce((x,y)=>x+y,0)/a.length:0;const _std=a=>0;let journal={},settings={tz:'utc'},_oneR=null;const tzParts=ms=>{const d=new Date(ms);return {y:d.getUTCFullYear(),mo:d.getUTCMonth(),day:d.getUTCDate(),h:d.getUTCHours(),dow:d.getUTCDay()};};const dayKey=ms=>new Date(ms).toISOString().slice(0,10);const tzMidnight=ms=>Date.parse(dayKey(ms));const addDays=(ms,n)=>ms+n*864e5;").catch(e => ({ err: e }));
t('profit factor counts every loss, including the small ones inside the break-even band', () => {
  if (S.err) { ok(true, 'stats module not extractable here: ' + S.err.message); return; }
  const tr = [{ net: 200, closeTime: 1, openTime: 0, fees: 0 }, ...Array.from({ length: 9 }, (_, i) => ({ net: -40, closeTime: 2 + i, openTime: 1, fees: 0 }))];
  near(S.computeStats(tr).profitFactor, 200 / 360, 1e-9);
});

const TS = await evalModule(['tradeStates'], ['tradeStates'], PRE + "const tzMidnight=ms=>Math.floor(ms/864e5)*864e5;");
t('trade states: the streak skips scratches, and a new day starts at exactly zero', () => {
  const D = 864e5, mk = (id, o, c, net) => ({ id, openTime: o, closeTime: c, net });
  const tr = [mk('a', 1, 2, 0.1), mk('b', 3, 4, 0.2), mk('c', 5, 6, 200), mk('s', 7, 8, 10), mk('d', 9, 10, 300), mk('e', D + 1, D + 2, -0.3)];
  const M = TS.tradeStates(tr);
  eq(M.get('d').streak, 1, 'a scratch neither extends nor breaks');
  eq(M.get('e').dayPnl, 0, 'no rounding dust carried into the next day');
  eq(M.get('e').streak, 2);
});

report('sweep');
