// Settling capped duels and pots on readings the server can stand behind (the fourth audit, AUDIT-4: D1,
// D2, D5). A drawdown that can't be read is never "not over": switching "Show % return" off after the start
// is out, like changing wallets, and so is still having no reading a week after the end. A duel waits for
// readings from after its last day, and asks for them itself. A deleted member's buy-in stays in a pot
// that has started. Wallets' account values are stubbed; repro scripts from the audit, as tests.
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { t, ok, eq, report } from './harness.mjs';

const require = createRequire(import.meta.url);
const server = require('../server.js');
const htmlPath = new URL('../ledger.html', import.meta.url).pathname;
const DAY = 864e5, A = i => '0x' + String(i).repeat(40);
let clock = Date.parse('2026-09-02T15:00:00Z'); // a Wednesday
// account values: steady +1 a day on 1,000 from Aug 20; a crash wallet drops 400 (40%) on Wed Sep 9; a dark
// wallet has no data at all
const T0 = Date.parse('2026-08-20T00:00:00Z'), CRASH = Date.parse('2026-09-09T00:00:00Z'), SERIES = {};
const series = crash => () => { const pn = [], av = []; for (let ms = T0; ms <= clock; ms += 6 * 3600e3) { const v = crash && ms >= CRASH ? -400 : (ms - T0) / DAY; pn.push([ms, String(v)]); av.push([ms, String(1000 + v)]); }
  return [['month', { accountValueHistory: av, pnlHistory: pn }], ['allTime', { accountValueHistory: av, pnlHistory: pn }]]; };
const fetchImpl = async (url, o) => { let b = {}; try { b = JSON.parse(o.body); } catch (e) {}
  const f = b.type === 'portfolio' && SERIES[String(b.user).toLowerCase()];
  return { ok: true, status: 200, json: async () => f ? f() : [] }; };
const dataDir = mkdtempSync(join(tmpdir(), 'ledger-settle-'));
const app = server.createApp({ dataDir, auth: 'owner-token', htmlPath, now: () => clock, push: false, pushTick: false, offsiteTimer: false, trustProxy: true, fetchImpl, behaviorFor: async () => [] });
const B = await new Promise(res => app.listen(0, () => res('http://127.0.0.1:' + app.address().port)));
let ipN = 0;
const call = async (p, o = {}) => { const r = await fetch(B + '/api/social' + p, { method: o.method || 'GET',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': o.ip || '10.0.0.1', ...(o.key ? { 'X-Pulse-Key': o.key } : {}), ...(o.owner ? { Authorization: 'Bearer owner-token' } : {}) },
    body: o.body !== undefined ? JSON.stringify(o.body) : undefined });
  return { status: r.status, d: await r.json().catch(() => ({})) }; };
const until = async (f, ms = 4000) => { const end = Date.now() + ms; for (;;) { const v = await f(); if (v || Date.now() > end) return v; await new Promise(r => setTimeout(r, 30)); } };
const settle = () => new Promise(r => setTimeout(r, 80));
const K = {}, N = {};
const join_ = async (h, i, kind) => { N[h] = i; if (kind) SERIES[A(i)] = kind === 'dark' ? () => [] : series(kind === 'crash');
  K[h] = (await call('/join', { method: 'POST', ip: '10.0.8.' + (++ipN), body: { handle: h, address: A(i), share: { ret: true, verify: true, feed: true } } })).d.key; };
const days = scores => ({ xp: 5000, tz: 'UTC', days: scores.map((s, i) => ({ k: new Date(Date.parse('2026-09-07') + i * DAY).toISOString().slice(0, 10), s, j: true, r: true })) });
const post = async (h, scores) => { await call('/stats', { method: 'POST', key: K[h], body: days(scores) }); await settle(); };
const send = (from, to, terms) => call('/duels', { method: 'POST', key: K[from], body: Object.assign({ to, type: 'disc', period: 'week', verified: false, ddCap: 0.10 }, terms) });
const duelOf = async (h, id) => (await call('/duels', { key: K[h] })).d.duels.find(x => x.id === id);
const idOf = async h => (await call('/admin/members', { owner: true })).d.members.find(m => m.handle === h).id;

try {
  await call('/admin/config', { method: 'PUT', owner: true, body: { requireClaim: false, unlocksOn: false, modules: { duels: 1 }, standing: { on: false } } });
  await join_('ann', 1, 'crash'); await join_('bob', 2, 'flat'); await join_('cat', 3, 'crash'); await join_('dee', 4, 'flat'); await join_('eve', 5, 'dark'); await join_('fay', 6, 'flat');
  const ids = {};
  for (const [a, b] of [['ann', 'bob'], ['cat', 'dee'], ['eve', 'fay']]) { const r = await send(a, b); eq(r.status, 200, JSON.stringify(r.d)); ids[a] = r.d.duel.id;
    eq((await call('/duels/' + r.d.duel.id, { method: 'POST', key: K[b], body: { action: 'accept' } })).d.duel.start, '2026-09-07'); }
  // the same week, a capped group duel and a capped competition with ann in both
  const pod = (await call('/pods', { method: 'POST', key: K.ann, body: { to: ['bob', 'dee'], type: 'disc', period: 'week', verified: false, minDays: 2, ddCap: 0.10 } })).d.pod.id;
  for (const h of ['bob', 'dee']) await call('/pods/' + pod, { method: 'POST', key: K[h], body: { action: 'accept' } });
  const comp = (await call('/admin/competitions', { method: 'POST', owner: true, body: { title: 'Capped journal', type: 'journal', start: '2026-09-07', end: '2026-09-13', ddCap: 0.10 } })).d.id;
  for (const h of ['ann', 'bob', 'dee']) eq((await call('/competitions/' + comp + '/join', { method: 'POST', key: K[h] })).status, 200);
  clock = Date.parse('2026-09-08T12:00:00Z');
  for (const h of ['ann', 'cat', 'eve']) await post(h, [90, 90]);
  for (const h of ['bob', 'fay']) await post(h, [80, 80]);
  await post('dee', [85, 85]);

  await t('D1: switching “Show % return” off after the start is out at once, like changing wallets', async () => {
    eq((await call('/me', { method: 'PUT', key: K.ann, body: { share: { ret: false, usd: false } } })).status, 200);
    const v = await duelOf('bob', ids.ann); eq([v.lead, v.them.out], ['me', true]); ok(/stopped sharing % return/.test(v.them.note), v.them.note);
    const pv = (await call('/duels', { key: K.bob })).d.pods.find(x => x.id === pod), pa = pv.members.find(m => m.handle === 'ann');
    eq([pv.lead, pa.out], ['dee', true], 'in a group duel too'); ok(/stopped sharing % return/.test(pa.note), pa.note);
    const cr = (await call('/competitions/' + comp, { key: K.bob })).d.competition.standings.find(r => r.handle === 'ann');
    eq([cr.out, cr.note], [true, 'Out: stopped sharing returns'], 'and in a competition');
  });
  await t('D2: a duel is settled on readings from after its last day, which the server asks for itself', async () => {
    clock = Date.parse('2026-09-11T12:00:00Z');
    for (const h of ['bob', 'fay']) await post(h, [80, 80, 80, 80, 80]); await post('dee', [85, 85, 85, 85, 85]); // cat and ann never open the app again
    await post('eve', [95, 95, 95, 95, 95]);
    clock = Date.parse('2026-09-15T09:00:00Z');
    const d = await until(async () => { const x = await duelOf('dee', ids.cat); return x.status === 'done' ? x : null; });
    ok(d, 'settled once both wallets were read after the end');
    eq(d.result.outcome, 'won', 'cat’s Wednesday crash was read at the end: out'); ok(/Out: drawdown 41.2%/.test(d.them.note), d.them.note);
    const a = await until(async () => { const x = await duelOf('bob', ids.ann); return x.status === 'done' ? x : null; });
    eq(a.result.outcome, 'won', 'ann hid her returns and crashed: she loses, whatever her Discipline');
    const pd = await until(async () => { const x = (await call('/duels', { key: K.dee })).d.pods.find(y => y.id === pod); return x.status === 'done' ? x : null; });
    eq([pd.result.won, pd.members.find(m => m.handle === 'ann').place], [true, 3], 'the group duel: dee wins, ann placed last');
    const cf = await until(async () => { const c = (await call('/competitions/' + comp, { key: K.bob })).d.competition; return c.status === 'finished' && c.standings.every(r => !/waiting/.test(r.note)) ? c : null; });
    eq(cf.standings.find(r => r.handle === 'ann').out, true, 'the competition: out, not paid on her last snapshot');
  });
  await t('D1: no drawdown reading at all a week after the end is out, never “not over”', async () => {
    eq((await duelOf('fay', ids.eve)).status, 'active', 'waits for a reading from eve’s wallet');
    clock = Date.parse('2026-09-21T09:00:00Z');
    const d = await until(async () => { const x = await duelOf('fay', ids.eve); return x.status === 'done' ? x : null; });
    ok(d, 'settled a week late'); eq(d.result.outcome, 'won', 'eve’s 95s don’t win without a drawdown reading'); ok(/no drawdown reading/.test(d.them.note), d.them.note);
  });
  await t('D5: a member removed after a pot started leaves their buy-in in it; the pot is paid in full', async () => {
    for (const h of ['bob', 'dee', 'fay', 'cat']) await call('/admin/members/' + await idOf(h), { method: 'POST', owner: true, body: { action: 'grant', xp: 1000 } });
    const r = await call('/pods', { method: 'POST', key: K.bob, body: { to: ['dee', 'fay', 'cat'], type: 'clean', period: 'week', verified: false, buyIn: 50, pay: 'wta' } });
    eq(r.status, 200, JSON.stringify(r.d)); const id = r.d.pod.id;
    for (const h of ['dee', 'fay', 'cat']) eq((await call('/pods/' + id, { method: 'POST', key: K[h], body: { action: 'accept' } })).status, 200);
    clock = Date.parse('2026-09-29T12:00:00Z'); // started (Sep 28)
    eq((await call('/me', { method: 'DELETE', key: K.cat })).status, 409, 'cat can’t delete with a buy-in riding');
    await call('/admin/members/' + await idOf('cat'), { method: 'POST', owner: true, body: { action: 'remove' } });
    await call('/duels', { key: K.bob }); // a sweep
    const p = (await call('/duels', { key: K.bob })).d.pods.find(x => x.id === id); eq(p.pot.gross, 200, 'still 4 × 50');
    clock = Date.parse('2026-09-30T20:00:00Z');
    await call('/stats', { method: 'POST', key: K.bob, body: { xp: 5000, tz: 'UTC', days: [{ k: '2026-09-28', s: 90 }, { k: '2026-09-29', s: 90 }, { k: '2026-09-30', s: 90 }] } });
    clock = Date.parse('2026-10-06T09:00:00Z');
    const done = await until(async () => { const x = (await call('/duels', { key: K.bob })).d.pods.find(y => y.id === id); return x.status === 'done' ? x : null; });
    eq([done.result.won, done.pot.mine.won], [true, 200]);
  });
} finally { await new Promise(r => app.close(r)); }

report('duel settlement');
