// The XP economy, end to end over HTTP (the fourth audit, AUDIT-4: X1, X2, X5, X15, D4, D6, D7). What a
// member's app reports (stats.xp, level, XP by day) is shown and ranked within bounds, but anything that
// moves XP between members, or spends it, is paid from the server's own ledger: verified Discipline XP read
// from the wallet, grants, awards, mentoring and stake results. Repro scripts from the audit, as tests.
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { t, ok, eq, report } from './harness.mjs';

const require = createRequire(import.meta.url);
const server = require('../server.js');
const SC = require('../social-config.js');
const htmlPath = new URL('../ledger.html', import.meta.url).pathname;
const DAY = 864e5, key = ms => new Date(ms).toISOString().slice(0, 10);
const A = h => '0x' + h.repeat(40);
let clock = Date.parse('2026-10-07T15:00:00Z'); // a Wednesday (2026-W41)
// each wallet's Discipline days as the server scores them from fills
const VD = {}, vday = (k, s) => ({ k, s, n: 3 }), span = (from, n, s) => Array.from({ length: n }, (_, i) => vday(key(Date.parse(from + 'T12:00:00Z') + i * DAY), s));
VD[A('b')] = span('2026-10-02', 5, 80); VD[A('c')] = span('2026-10-02', 5, 80); VD[A('d')] = span('2026-10-02', 5, 80);
const behaviorFor = async addr => VD[addr] || [];
const dataDir = mkdtempSync(join(tmpdir(), 'ledger-xpecon-'));
const mk = () => server.createApp({ dataDir, auth: 'owner-token', htmlPath, now: () => clock, push: false, pushTick: false, offsiteTimer: false, trustProxy: true, behaviorFor,
  fetchImpl: async () => ({ ok: true, status: 200, json: async () => [] }) });
let app = mk();
const listen = () => new Promise(res => app.listen(0, () => res('http://127.0.0.1:' + app.address().port)));
let B = await listen(), ipN = 0;
const call = async (p, o = {}) => { const r = await fetch(B + '/api/social' + p, { method: o.method || 'GET',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': o.ip || '10.0.0.1', ...(o.key ? { 'X-Pulse-Key': o.key } : {}), ...(o.owner ? { Authorization: 'Bearer owner-token' } : {}) },
    body: o.body !== undefined ? JSON.stringify(o.body) : undefined });
  return { status: r.status, d: await r.json().catch(() => ({})) }; };
const until = async (f, ms = 4000) => { const end = Date.now() + ms; for (;;) { const v = await f(); if (v || Date.now() > end) return v; await new Promise(r => setTimeout(r, 30)); } };
const K = {};
const join_ = async (h, addr) => (K[h] = (await call('/join', { method: 'POST', ip: '10.0.7.' + (++ipN), body: Object.assign({ handle: h }, addr ? { address: addr, share: { verify: true } } : {}) })).d.key);
const me = async h => (await call('/me', { key: K[h] })).d.me;
const stats = (h, body) => call('/stats', { method: 'POST', key: K[h], body: Object.assign({ tz: 'UTC' }, body) });
const idOf = async h => (await call('/admin/members', { owner: true })).d.members.find(m => m.handle === h).id;
const mstate = async h => app._social.state().members[await idOf(h)];
const send = (from, to, terms) => call('/duels', { method: 'POST', key: K[from], body: Object.assign({ to, type: 'disc', period: 'week', verified: false }, terms) });
const act = (h, id, action) => call('/duels/' + id, { method: 'POST', key: K[h], body: { action } });
const duelOf = async (h, id) => (await call('/duels', { key: K[h] })).d.duels.find(x => x.id === id);
const verified = h => until(async () => { const m = await me(h); return m && m.ledger.verified > 0 ? m : null; });

try {
  await call('/admin/config', { method: 'PUT', owner: true, body: { requireClaim: false, unlocksOn: false, modules: { duels: 1 }, standing: { on: false } } });
  await join_('eve'); await join_('fay'); await join_('bob', A('b')); await join_('cat', A('c'));
  await verified('bob'); await verified('cat');

  await t('X1: a member with no trades posts any XP: it shows, but it’s no balance, and nothing can be staked on it', async () => {
    const forged = { xp: 1e8, level: 500, week: '2026-W41', weekXp: 1e6, streak: 10000, best: 10000, days: [{ k: '2026-10-06', s: 100 }], xpDays: { '2026-10-06': 1e5 } };
    eq((await stats('eve', forged)).status, 200);
    const e = await me('eve'); eq([e.balance, e.ledger.verified], [0, 0]);
    eq((await call('/duels', { key: K.eve })).d.room, 0, 'the audit’s repro: room 500 on a posted 100,000,000');
    const s = await send('eve', 'bob', { type: 'xp', stake: 100 }); eq(s.status, 409); ok(/verified wallet/.test(s.d.error), s.d.error);
    const p = await call('/pods', { method: 'POST', key: K.eve, body: { to: ['bob', 'cat'], type: 'clean', period: 'week', verified: false, buyIn: 50 } });
    eq(p.status, 409); ok(/verified wallet/.test(p.d.error), p.d.error);
  });
  await t('X1: the balance is the server’s ledger: verified Discipline XP from the wallet (score × the Discipline weight)', async () => {
    const b = await me('bob'); eq([b.ledger.verified, b.balance], [400, 400], '5 verified days at 80');
    await stats('bob', { xp: 2000, level: 4 }); eq((await me('bob')).balance, 400, 'what the app reports changes nothing');
    eq((await call('/duels', { key: K.bob })).d.room, 100, '25% of the balance');
    // switching verification off keeps what was credited (it was earned), but nothing can ride against others without it
    await call('/me', { method: 'PUT', key: K.bob, body: { share: { verify: false } } });
    eq([(await me('bob')).balance, (await call('/duels', { key: K.bob })).d.room], [400, 0]);
    await call('/me', { method: 'PUT', key: K.bob, body: { share: { verify: true } } }); await until(async () => (await call('/duels', { key: K.bob })).d.room === 100);
    // the owner's Discipline weight scales it on the next read
    await call('/admin/config', { method: 'PUT', owner: true, body: { xp: { discipline: 2 } } });
    clock += 31 * 60000; await stats('cat', { xp: 10 });
    eq((await until(async () => { const m = await me('cat'); return m.ledger.verified === 800 ? m : null; })).ledger.verified, 800);
    await call('/admin/config', { method: 'PUT', owner: true, body: { xp: { discipline: 1 } } });
    clock += 31 * 60000; await stats('cat', { xp: 10 }); await until(async () => (await me('cat')).ledger.verified === 400);
  });
  await t('X2: the level is the league’s for the XP, the posted one is ignored; the total is capped by what a perfect player could earn', async () => {
    await stats('fay', { xp: 0, level: 500 }); eq([(await me('fay')).level, (await me('fay')).xp], [1, 0], 'level 500 on 0 XP was stored as level 500');
    // a trader whose first fill was 10 days ago can't have more than 12 days at the daily cap, at the top multiplier
    const cap = SC.dayXpCap(SC.DEFAULTS.xp); eq(cap, 850);
    await stats('fay', { xp: 1e8, level: 500, firstAt: clock - 10 * DAY });
    const f = await me('fay'); eq(f.xp, Math.round(12 * cap * 1.5)); eq(f.level, SC.levelOf(SC.DEFAULTS.levels, f.xp));
    const e = await me('eve'); ok(e.xp < 1e8 && e.level < 500, 'without a first fill: capped from 2015 (' + e.xp + ', level ' + e.level + ')');
    ok((await me('eve')).streak <= 4300, 'a streak can’t be longer than the days there were');
  });
  await t('X2: XP by day is capped at what the weights pay, never later than today, and must add up to no more than the total', async () => {
    const x = (await mstate('eve')).stats.xpDays; eq(x['2026-10-06'], 850, 'a posted 100,000 is capped');
    eq((await stats('fay', { xp: 5000, xpDays: { '2026-10-06': 300, '2026-10-08': 300, '2026-05-01': 300 } })).status, 200);
    eq((await mstate('fay')).stats.xpDays, { '2026-10-06': 300 }, 'tomorrow and five months ago are dropped');
    const r = await stats('fay', { xp: 100, xpDays: { '2026-10-06': 500 } }); eq(r.status, 400); ok(/adds up to more than your total/.test(r.d.error));
    // the server's own grants on a day lift that day's cap (the app counts them in its XP by day)
    await call('/admin/members/' + await idOf('fay'), { method: 'POST', owner: true, body: { action: 'grant', xp: 1000 } });
    await stats('fay', { xp: 5000, xpDays: { '2026-10-07': 1700 } }); eq((await mstate('fay')).stats.xpDays['2026-10-07'], 1700);
    await stats('fay', { xp: 5000, xpDays: { '2026-10-07': 9000 } }); eq((await mstate('fay')).stats.xpDays['2026-10-07'], 1850);
  });
  await t('X2: weekly XP is the server’s sum of XP by day; the board and owner badges read the checked numbers', async () => {
    const lb = (await call('/leaderboard?board=xp', { key: K.bob })).d.rows; eq(lb.find(r => r.handle === 'eve').value, 850, 'not the posted 1,000,000');
    // an owner badge on a number the app reports is still awarded (it shows), but its XP never joins the balance
    const bid = (await call('/admin/badges', { method: 'POST', owner: true, body: { name: 'Whale', metric: 'xp', op: 'gte', value: 50000, xp: 500 } })).d.id;
    await stats('eve', { xp: 1e8, xpDays: { '2026-10-06': 1e5 } });
    ok((await me('eve')).awards.some(a => a.id === bid), 'awarded'); eq((await me('eve')).balance, 0, 'no XP to stake from it');
    const hand = (await call('/admin/badges', { method: 'POST', owner: true, body: { name: 'Helper', xp: 70 } })).d.id;
    await call('/admin/members/' + await idOf('eve'), { method: 'POST', owner: true, body: { action: 'award', badge: hand } });
    eq((await me('eve')).ledger.awards, 70, 'a badge the owner hands out is the owner’s word: it counts');
  });
  await t('X2: a day more than a week old keeps the XP first reported for it; a recent one can still change', async () => {
    await stats('cat', { xp: 5000, xpDays: { '2026-09-28': 100, '2026-10-05': 100 } });
    await stats('cat', { xp: 5000, xpDays: { '2026-09-28': 800, '2026-10-05': 300 } });
    const x = (await mstate('cat')).stats.xpDays; eq([x['2026-09-28'], x['2026-10-05']], [100, 300]);
  });
  await t('D7: two profiles on one wallet can’t duel each other', async () => {
    await join_('bob_alt', A('b'));
    const r = await send('bob_alt', 'bob'); eq(r.status, 409); ok(/share a wallet/.test(r.d.error), r.d.error);
    const p = await call('/pods', { method: 'POST', key: K.bob_alt, body: { to: ['bob', 'cat'], type: 'clean', period: 'week', verified: false } });
    eq(p.status, 409); ok(/shares a wallet/.test(p.d.error), p.d.error);
    eq((await call('/me', { method: 'DELETE', key: K.bob_alt })).status, 200);
  });
  let staked;
  await t('X5: a verified, staked duel; no deleting a profile while XP rides on it', async () => {
    const r = await send('bob', 'cat', { verified: true, stake: 100 }); eq(r.status, 200, JSON.stringify(r.d)); staked = r.d.duel.id;
    eq((await act('cat', staked, 'accept')).d.duel.start, '2026-10-12');
    const del = await call('/me', { method: 'DELETE', key: K.cat }); eq(del.status, 409); ok(/riding on 1 duel/.test(del.d.error), del.d.error);
  });
  await t('X15: late XP reaches the week it belongs to (the server sums XP by day)', async () => {
    clock = Date.parse('2026-10-12T10:00:00Z'); // Monday: Sunday's trades journaled late
    await stats('cat', { xp: 5000, xpDays: { '2026-10-05': 300, '2026-10-11': 250 } });
    eq((await mstate('cat')).weekXp['2026-W41'], 550);
  });
  await t('D4: a duel accepted on a Monday starts the Monday after, so nobody gets a head start', async () => {
    clock = Date.parse('2026-10-11T18:00:00Z');
    const r = await send('fay', 'eve', { type: 'survive' }); eq(r.status, 200, JSON.stringify(r.d));
    clock = Date.parse('2026-10-12T21:00:00Z');
    await stats('fay', { xp: 5000, days: [{ k: '2026-10-12', s: 50 }] });
    const a = await act('eve', r.d.duel.id, 'accept'); eq([a.d.duel.start, a.d.duel.end], ['2026-10-19', '2026-10-25']);
    eq(a.d.duel.them, undefined, 'not started: fay’s Monday 50 doesn’t put her out');
    await act('eve', r.d.duel.id, 'forfeit'); // backs out before the start
  });
  await t('X5: the stake is settled on the verified days read after the end', async () => {
    VD[A('b')] = [...VD[A('b')], ...span('2026-10-12', 5, 90)]; VD[A('c')] = [...VD[A('c')], ...span('2026-10-12', 5, 60)];
    clock = Date.parse('2026-10-20T09:00:00Z');
    const d = await until(async () => { const x = await duelOf('cat', staked); return x.status === 'done' ? x : null; });
    ok(d, 'settled once both wallets were read after the end'); eq([d.result.outcome, d.result.stake], ['lost', -100]);
    const c = await me('cat'); eq([c.ledger.verified, c.ledger.stakes, c.balance], [700, -100, 600]);
    const b = await me('bob'); eq([b.ledger.verified, b.ledger.stakes, b.ledger.granted, b.balance], [850, 100, 100, 1050], 'the win bonus on a verified duel is balance');
  });
  await t('X5: deleting and rejoining on the same wallet doesn’t wipe a lost stake', async () => {
    eq((await call('/me', { method: 'DELETE', key: K.cat })).status, 200);
    await join_('cat', A('c'));
    const c = await verified('cat'); eq([c.ledger.verified, c.ledger.carried, c.balance], [700, -100, 600], 'the 100 lost is still lost');
    ok((await call('/inbox', { key: K.cat })).d.items.some(x => /owed 100 XP/.test(x.text)), 'told why');
    // a balance below zero: no deleting until it’s earned back
    await call('/admin/members/' + await idOf('cat'), { method: 'POST', owner: true, body: { action: 'grant', xp: -1000 } });
    eq((await me('cat')).balance, -400, 'shown as a debt, not as 0');
    const del = await call('/me', { method: 'DELETE', key: K.cat }); eq(del.status, 409); ok(/balance is -400/.test(del.d.error), del.d.error);
    eq((await call('/duels', { key: K.cat })).d.room, 0, 'nothing can be staked while it’s below zero');
    await call('/admin/members/' + await idOf('cat'), { method: 'POST', owner: true, body: { action: 'grant', xp: 1000 } });
  });
  await t('D6: a duel’s result and its stake are written in one transaction: a failure part way never moves the stake twice', async () => {
    const r = await send('bob', 'cat', { verified: true, stake: 50 }); eq(r.status, 200, JSON.stringify(r.d)); const id = r.d.duel.id;
    await act('cat', id, 'accept');
    VD[A('b')] = [...VD[A('b')], ...span('2026-10-26', 5, 95)]; VD[A('c')] = [...VD[A('c')], ...span('2026-10-26', 5, 55)];
    const before = (await me('cat')).ledger.stakes;
    clock = Date.parse('2026-11-03T09:00:00Z');
    // both wallets read after the end, then the feed's table goes missing just as the winner's feed line is written
    for (const h of ['bob', 'cat']) { clock += 31 * 60000; await stats(h, { xp: 5000 }); }
    await until(async () => (await mstate('bob')).vAt > Date.parse('2026-11-01T23:59:59Z') && (await mstate('cat')).vAt > Date.parse('2026-11-01T23:59:59Z'));
    const { DatabaseSync } = await import('node:sqlite'), db = new DatabaseSync(join(dataDir, 'pulse.db'));
    db.exec('ALTER TABLE events RENAME TO events_away');
    const err = console.error; console.error = () => {}; // the server logs the failed request
    try { eq((await call('/duels', { key: K.cat })).status, 500, 'settling failed part way'); } finally { console.error = err; }
    db.exec('ALTER TABLE events_away RENAME TO events'); db.close();
    await new Promise(r => app.close(r)); app = mk(); B = await listen(); // a restart reads what was committed
    const d = await until(async () => { const x = await duelOf('cat', id); return x.status === 'done' ? x : null; });
    ok(d, 'settled again after the restart'); eq((await me('cat')).ledger.stakes, before - 50, 'the stake moved once');
  });
  await t('the update: wallets already read are credited from the verified days on file, once', async () => {
    const days = (await mstate('bob')).vdays.reduce((a, d) => a + Math.round(d.s), 0), bid = await idOf('bob');
    await new Promise(r => app.close(r));
    const { DatabaseSync } = await import('node:sqlite'), db = new DatabaseSync(join(dataDir, 'pulse.db'));
    const row = JSON.parse(db.prepare('SELECT data FROM members WHERE id = ?').get(bid).data); delete row.vxp; // as before this release
    db.prepare('UPDATE members SET data = ? WHERE id = ?').run(JSON.stringify(row), bid);
    const mg = JSON.parse(db.prepare('SELECT v FROM kv WHERE k = ?').get('migrations').v); delete mg.ledger;
    db.prepare('UPDATE kv SET v = ? WHERE k = ?').run(JSON.stringify(mg), 'migrations'); db.close();
    app = mk(); B = await listen();
    eq((await me('bob')).ledger.verified, days);
  });
  await t('verified XP from a wallet the owner rejects leaves the balance', async () => {
    eq((await call('/admin/wallets', { method: 'POST', owner: true, body: { action: 'reject', addresses: [A('d')] } })).status, 200);
    await join_('dan', A('d')); eq((await me('dan')).ledger.verified, 0, 'a rejected wallet is never read');
    await call('/admin/wallets', { method: 'POST', owner: true, body: { action: 'clear', addresses: [A('d')] } });
    eq((await verified('dan')).ledger.verified, 400);
    await call('/admin/wallets', { method: 'POST', owner: true, body: { action: 'reject', addresses: [A('d')] } });
    eq((await me('dan')).ledger.verified, 0);
  });
  await t('the stats rate limit: 60 posts in 10 minutes', async () => {
    let last = 0; for (let i = 0; i < 61; i++) last = (await stats('fay', { xp: 5000 })).status;
    eq(last, 429);
  });
} finally { await new Promise(r => app.close(r)); }

report('xp economy');
