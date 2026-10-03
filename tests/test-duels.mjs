// Duels: one member challenges another for a week or a month. The terms, the dates and the score
// (pure, duels.js), then the whole life of a duel over HTTP: challenge, counter, accept, the live
// score, settling (record, XP, feed), decline, expiry, withdraw, forfeit, the limits, and the
// admin's settings and cancel. No network.
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { t, ok, eq, report } from './harness.mjs';

const require = createRequire(import.meta.url);
const Duels = require('../duels.js');
const server = require('../server.js');
const htmlPath = new URL('../ledger.html', import.meta.url).pathname;
const DAY = 86400000;

console.log('Terms, dates and scores');
t('terms: a real type the league allows; conditions only where they apply', () => {
  eq(Duels.sanitizeTerms({ type: 'poker' }).error, 'Pick what to compete on.');
  ok(/doesn’t run/.test(Duels.sanitizeTerms({ type: 'ret' }).error), '% return is off by default');
  const d = Duels.sanitizeTerms({ type: 'disc', period: 'month', minDays: 99, msg: '  loser\nbuys   coffee  ' });
  eq([d.period, d.verified, d.minDays, d.ddCap, d.msg], ['month', true, 20, null, 'loser buys coffee']);
  eq(Duels.sanitizeTerms({ type: 'xp', verified: true }).verified, false, 'XP isn’t read from fills');
  const cfg = Duels.sanitizeDuelCfg({ types: { ret: true } });
  eq(Duels.sanitizeTerms({ type: 'ret' }, cfg).ddCap, 0.08, 'a drawdown cap always comes with % return');
});
t('dates: the next whole week or month, starting today only when today is the Monday or the 1st', () => {
  eq(Duels.windowFor('week', Date.parse('2026-10-07T15:00:00Z')), { start: '2026-10-12', end: '2026-10-18' }); // a Wednesday
  eq(Duels.windowFor('week', Date.parse('2026-10-12T08:00:00Z')), { start: '2026-10-12', end: '2026-10-18' }); // that Monday
  eq(Duels.windowFor('month', Date.parse('2026-10-07T15:00:00Z')), { start: '2026-11-01', end: '2026-11-30' });
  eq(Duels.windowFor('month', Date.parse('2026-12-01T00:30:00Z')), { start: '2026-12-01', end: '2026-12-31' });
});
const dd = (type, extra) => Object.assign({ type, start: '2026-10-12', end: '2026-10-18', verified: false, minDays: 3, ddCap: 0.08 }, extra);
const mem = (id, scores, extra) => Object.assign({ id, share: {}, stats: { days: scores.map(([k, s, j, r]) => ({ k: '2026-10-' + k, s, j: !!j, r: !!r })), xpDays: {} } }, extra);
t('Discipline: the higher average wins, but only with the agreed trading days', () => {
  const A = mem('a', [['12', 90], ['13', 80], ['14', 70]]), B = mem('b', [['12', 100], ['13', 95]]);
  const s = Duels.standing(dd('disc'), A, B, '2026-10-20');
  eq([s.lead, s.a.score, s.b.score], ['a', 80, 98]); ok(/fewer than 3/.test(s.why), s.why);
  eq(Duels.standing(dd('disc', { minDays: 2 }), A, B, '2026-10-20').lead, 'b');
  eq(Duels.standing(dd('disc'), A, mem('b', [['11', 100], ['19', 100], ['20', 100]]), '2026-10-20').b.n, 0, 'days outside the dates don’t count');
});
t('verified duels read only the server’s own Discipline days', () => {
  const A = mem('a', [['12', 100], ['13', 100], ['14', 100]], { share: { verify: true }, vdays: [{ k: '2026-10-12', s: 50 }, { k: '2026-10-13', s: 60 }, { k: '2026-10-14', s: 70 }] });
  const B = mem('b', [['12', 80], ['13', 80], ['14', 80]]);
  const s = Duels.standing(dd('disc', { verified: true }), A, B, '2026-10-20');
  eq([s.a.score, s.b.n, s.b.verifiedMissing], [60, 0, true]);
});
t('clean days, last one standing, journaling, XP and capped returns', () => {
  const A = mem('a', [['12', 90, 1, 1], ['13', 60, 1, 1], ['14', 75, 1, 0]]), B = mem('b', [['12', 72], ['13', 71], ['15', 40, 1, 1]]);
  const c = Duels.standing(dd('clean'), A, B, '2026-10-20'); eq([c.a.score, c.b.score, c.lead], [2, 2, 'a'], 'level on count: higher average wins');
  const sv = Duels.standing(dd('survive'), A, B, '2026-10-20'); eq([sv.a.fell, sv.b.fell, sv.lead], ['2026-10-13', '2026-10-15', 'b'], 'lasted longer');
  eq(Duels.standing(dd('survive'), mem('a', [['12', 90]]), mem('b', [['12', 95]]), '2026-10-20').lead, null, 'both standing: level');
  const j = Duels.standing(dd('journal'), A, B, '2026-10-20'); eq([j.a.score, j.b.score, j.lead], [2, 1, 'a']);
  A.stats.xpDays = { '2026-10-12': 40, '2026-10-30': 999 }; B.stats.xpDays = { '2026-10-13': 55 };
  eq(Duels.standing(dd('xp'), A, B, '2026-10-20').lead, 'b');
  const r = dd('ret', { money: { a: { ret: 0.2, dd: 0.12 }, b: { ret: 0.01, dd: 0.02 } } });
  const rs = Duels.standing(r, A, B, '2026-10-20'); eq([rs.lead, rs.a.out], ['b', true], 'past the cap loses, whatever the return');
});
t('turning verification off mid-duel counts as falling on day one in last one standing', () => {
  const v = k => ({ k: '2026-10-' + k, s: 90 });
  const A = mem('a', [], { share: { verify: true }, vdays: [v('12'), v('13'), { k: '2026-10-14', s: 40 }] }), B = mem('b', [], { share: { verify: false }, vdays: [v('12')] });
  const s = Duels.standing(dd('survive', { verified: true }), A, B, '2026-10-20');
  eq([s.b.fell, s.lead], ['2026-10-12', 'a']); ok(/verification off/.test(s.b.note), s.b.note);
});
t('XP duels count process XP only: XP won in duels comes off the day it landed', () => {
  const A = mem('a', [], { grants: [{ xp: 300, at: Date.parse('2026-10-13T10:00:00Z'), duel: 'x' }, { xp: -50, at: Date.parse('2026-10-14T10:00:00Z'), duel: 'y' }] });
  A.stats.xpDays = { '2026-10-13': 340, '2026-10-14': 20 }; A.stats.tz = 'UTC';
  const s = Duels.sideScore(dd('xp'), A, '2026-10-20'); eq([s.score, s.marks.map(m => m.s)], [60, [40, 20]]);
});
t('stakes: capped per duel, and by a share of your XP across open duels', () => {
  eq(Duels.sanitizeTerms({ type: 'disc', stake: 9999 }).stake, 500);
  eq(Duels.sanitizeTerms({ type: 'disc', stake: 100 }, Duels.sanitizeDuelCfg({ stakes: false })).stake, 0, 'off: no stake');
  eq([Duels.stakeRoom(1000, 0), Duels.stakeRoom(1000, 200), Duels.stakeRoom(100000, 0), Duels.stakeRoom(50, 0)], [250, 50, 500, 12]);
});

console.log('\nOver HTTP');
let clock = Date.parse('2026-10-07T15:00:00Z'); // a Wednesday
const dataDir = mkdtempSync(join(tmpdir(), 'ledger-duels-'));
const mk = () => server.createApp({ dataDir, auth: 'owner-token', htmlPath, now: () => clock, push: false, pushTick: false, trustProxy: true,
  fetchImpl: async () => ({ ok: true, status: 200, json: async () => [] }) });
let app = mk();
const listen = () => new Promise(res => app.listen(0, () => res('http://127.0.0.1:' + app.address().port)));
let B = await listen();
let ipN = 0;
const call = async (p, o = {}) => { const r = await fetch(B + '/api/social' + p, { method: o.method || 'GET',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': o.ip || '10.0.0.1', ...(o.key ? { 'X-Pulse-Key': o.key } : {}), ...(o.owner ? { Authorization: 'Bearer owner-token' } : {}) },
    body: o.body !== undefined ? JSON.stringify(o.body) : undefined });
  return { status: r.status, d: await r.json().catch(() => ({})) }; };
const join_ = async h => (await call('/join', { method: 'POST', ip: '10.0.2.' + (++ipN), body: { handle: h, share: { feed: true } } })).d.key;
const days = (pairs, xp) => ({ xp: 100, days: pairs.map(([k, s]) => ({ k, s, j: s >= 70, r: s >= 70 })), xpDays: xp || {} });
const send = (key, to, terms) => call('/duels', { method: 'POST', key, body: Object.assign({ to, type: 'disc', period: 'week', verified: false }, terms) });
const mine = async (key) => (await call('/duels', { key })).d;
const inbox = async key => (await call('/inbox', { key })).d.items.map(x => x.text);
let ann, bob, cat, dee;
try {
  ann = await join_('ann'); bob = await join_('bob'); cat = await join_('cat'); dee = await join_('dee');
  await t('duels unlock at level 3 by default', async () => {
    eq((await call('/config')).d.modules.duels, 3);
    const r = await send(ann, 'bob'); eq(r.status, 403); ok(/level 3/.test(r.d.error));
    await call('/admin/config', { method: 'PUT', owner: true, body: { modules: { duels: 1 }, standing: { on: false } } }); // the rest of this file plays at level 1 (standing has its own tests: test-trader-age-server)
  });
  let id;
  await t('a challenge reaches the other side; verified duels need verification switched on', async () => {
    ok(/Verify my discipline/.test((await send(ann, 'bob', { verified: true })).d.error));
    const r = await send(ann, '@bob', { msg: 'loser buys coffee' }); eq(r.status, 200, JSON.stringify(r.d)); id = r.d.duel.id;
    eq([r.d.duel.status, r.d.duel.mine, r.d.duel.awaiting, r.d.duel.preview], ['pending', 'sent', false, { start: '2026-10-12', end: '2026-10-18' }]);
    const b = await mine(bob); eq([b.duels[0].mine, b.duels[0].awaiting, b.duels[0].msg], ['received', true, 'loser buys coffee']);
    ok((await inbox(bob)).some(x => /@ann challenged you to a Discipline duel/.test(x)));
    eq((await send(ann, 'bob')).status, 409, 'one duel at a time between two people');
    eq((await send(ann, 'ann')).status, 409);
  });
  await t('suggesting other terms sends it back; only the side it’s waiting on can answer', async () => {
    eq((await call('/duels/' + id, { method: 'POST', key: ann, body: { action: 'accept' } })).status, 409, 'not your turn');
    const c = await call('/duels/' + id, { method: 'POST', key: bob, body: { action: 'counter', type: 'clean', period: 'week', verified: false } });
    eq([c.status, c.d.duel.type, c.d.duel.awaiting, c.d.duel.countered], [200, 'clean', false, true]);
    ok((await inbox(ann)).some(x => /suggested different terms/.test(x)));
    const c2 = await call('/duels/' + id, { method: 'POST', key: ann, body: { action: 'counter', type: 'disc', period: 'week', verified: false, minDays: 2 } });
    eq(c2.d.duel.minDays, 2);
  });
  await t('accepting fixes the dates: the next Monday to Sunday', async () => {
    const a = await call('/duels/' + id, { method: 'POST', key: bob, body: { action: 'accept' } });
    eq([a.status, a.d.duel.status, a.d.duel.start, a.d.duel.end], [200, 'active', '2026-10-12', '2026-10-18']);
    ok((await inbox(ann)).some(x => /accepted your Discipline duel/.test(x)));
  });
  await t('the live score follows both sides’ days; outside the dates nothing counts', async () => {
    clock = Date.parse('2026-10-14T18:00:00Z');
    await call('/stats', { method: 'POST', key: ann, body: days([['2026-10-11', 10], ['2026-10-12', 90], ['2026-10-13', 70]]) });
    await call('/stats', { method: 'POST', key: bob, body: days([['2026-10-12', 60], ['2026-10-13', 70], ['2026-10-14', 65]]) });
    const v = (await mine(ann)).duels.find(x => x.id === id);
    eq([v.me.score, v.them.score, v.lead], [80, 65, 'me']); eq(v.me.marks.map(m => m.k), ['2026-10-12', '2026-10-13']);
    const w = (await mine(bob)).duels.find(x => x.id === id); eq(w.lead, 'them');
  });
  await t('settled the day after it ends: a record, the winner’s XP and a feed line', async () => {
    clock = Date.parse('2026-10-19T12:00:00Z');
    eq((await mine(ann)).duels.find(x => x.id === id).status, 'active', 'not yet: the last day’s syncs may still come in');
    clock = Date.parse('2026-10-20T09:00:00Z');
    const a = await mine(ann), v = a.duels.find(x => x.id === id);
    eq([v.status, v.result.outcome, v.result.xp, a.record], ['done', 'won', 100, { w: 1, l: 0, d: 0 }]);
    eq((await mine(bob)).record, { w: 0, l: 1, d: 0 });
    const me = (await call('/me', { key: ann })).d.me; ok((me.grants || []).some(g => g.xp === 100 && /duel/.test(g.why)), 'the XP arrives as a grant');
    const prof = (await call('/profile/ann', { key: cat })).d.profile; eq(prof.duels, { w: 1, l: 0, d: 0 });
    const feed = (await call('/feed?scope=discover', { key: cat })).d; ok(JSON.stringify(feed).includes('won a Discipline duel against @bob'), 'both share milestones: the loser is named');
    ok((await inbox(bob)).some(x => /won your Discipline duel/.test(x)));
  });
  await t('declined: no new challenge from the same person that week; expiry after 48 hours', async () => {
    const r = await send(cat, 'dee'); await call('/duels/' + r.d.duel.id, { method: 'POST', key: dee, body: { action: 'decline' } });
    ok(/declined a challenge from you/.test((await send(cat, 'dee')).d.error));
    const r2 = await send(dee, 'cat'); eq(r2.status, 200, 'the other way round is fine');
    clock += 49 * 3600000;
    eq((await mine(dee)).duels.find(x => x.id === r2.d.duel.id).status, 'expired');
    ok((await inbox(dee)).some(x => /expired/.test(x)));
  });
  await t('withdraw a sent challenge; back out before the start (nothing counts); forfeit a running duel (no league bonus)', async () => {
    const w = await send(ann, 'cat'); eq((await call('/duels/' + w.d.duel.id, { method: 'POST', key: ann, body: { action: 'cancel' } })).d.duel.status, 'cancelled');
    const f = await send(bob, 'cat'); await call('/duels/' + f.d.duel.id, { method: 'POST', key: cat, body: { action: 'accept' } });
    const early = await call('/duels/' + f.d.duel.id, { method: 'POST', key: cat, body: { action: 'forfeit' } });
    eq([early.d.duel.status, (await mine(bob)).record.w], ['cancelled', 0], 'backing out before it starts: no result');
    ok((await inbox(bob)).some(x => /backed out/.test(x)));
    const g = await send(bob, 'cat'); const acc = await call('/duels/' + g.d.duel.id, { method: 'POST', key: cat, body: { action: 'accept' } });
    clock = Date.parse(acc.d.duel.start + 'T12:00:00Z');
    const ff = await call('/duels/' + g.d.duel.id, { method: 'POST', key: cat, body: { action: 'forfeit' } });
    eq([ff.d.duel.result.outcome, ff.d.duel.result.forfeit], ['lost', 'me']);
    const b = (await mine(bob)), bv = b.duels.find(x => x.id === g.d.duel.id); eq([b.record.w, bv.result.xp], [1, 0], 'a forfeit wins the duel, not the league’s XP');
  });
  await t('anyone can be challenged; partners, follows and league-mates are offered as quick picks', async () => {
    await call('/follow/cat', { method: 'POST', key: ann });
    const d = await mine(ann); ok(d.people.some(p => p.handle === 'cat' && p.rel === 'following'), JSON.stringify(d.people));
    ok(!d.people.some(p => p.handle === 'ann'), 'never yourself');
  });
  await t('XP stakes: both put up the same, the winner takes the other’s, within what each can cover', async () => {
    await call('/stats', { method: 'POST', key: ann, body: Object.assign(days([]), { xp: 1000 }) });
    await call('/stats', { method: 'POST', key: dee, body: Object.assign(days([]), { xp: 100 }) });
    eq((await mine(ann)).room, 250, '25% of 1000');
    ok(/at most 250 XP/.test((await send(ann, 'dee', { type: 'xp', stake: 300 })).d.error));
    ok(/@dee can’t cover/.test((await send(ann, 'dee', { type: 'xp', stake: 100 })).d.error));
    await call('/stats', { method: 'POST', key: dee, body: Object.assign(days([]), { xp: 1000 }) });
    ok(/apps report themselves, at most 100 XP/.test((await send(ann, 'dee', { type: 'xp', stake: 200 })).d.error), 'process XP is reported by the app: 100 XP at most by default');
    await call('/admin/config', { method: 'PUT', owner: true, body: { pots: { selfMax: 1000 } } });
    const r = await send(ann, 'dee', { type: 'xp', stake: 200 }); eq([r.status, r.d.duel.stake], [200, 200], JSON.stringify(r.d));
    eq((await mine(ann)).room, 50, 'what you proposed is riding');
    eq((await mine(dee)).room, 250, 'a challenge waiting on you commits nothing yet');
    ok((await inbox(dee)).some(x => /200 XP each at stake/.test(x)));
    const a = await call('/duels/' + r.d.duel.id, { method: 'POST', key: dee, body: { action: 'accept' } }); eq(a.status, 200, JSON.stringify(a.d));
    const st = a.d.duel.start; clock = Date.parse(st + 'T15:00:00Z');
    await call('/stats', { method: 'POST', key: ann, body: Object.assign(days([], { [st]: 10 }), { xp: 1000 }) });
    await call('/stats', { method: 'POST', key: dee, body: Object.assign(days([], { [st]: 50 }), { xp: 1000 }) });
    clock = Date.parse(a.d.duel.end + 'T12:00:00Z') + 2 * DAY;
    const dv = (await mine(dee)).duels.find(x => x.id === r.d.duel.id), av = (await mine(ann)).duels.find(x => x.id === r.d.duel.id);
    eq([dv.result.outcome, dv.result.xp, dv.result.stake, av.result.outcome, av.result.stake], ['won', 100, 200, 'lost', -200]);
    // stakes move the balance, never earned XP: the bonus is a grant (it counts toward the level), the stake isn't
    const ma = (await call('/me', { key: ann })).d.me, md = (await call('/me', { key: dee })).d.me;
    ok(!ma.grants.some(g => g.xp < 0), 'a lost stake costs no earned XP: ' + JSON.stringify(ma.grants));
    ok(ma.stakes.some(g => g.xp === -200 && /Lost a Process XP duel to @dee/.test(g.why)), JSON.stringify(ma.stakes));
    ok(md.grants.some(g => g.xp === 100 && /Won a Process XP duel/.test(g.why)), 'the league’s bonus is earned XP');
    ok(!md.grants.some(g => /staked by/.test(g.why)));
    ok(md.stakes.some(g => g.xp === 200 && /staked by @ann/.test(g.why)));
    eq([ma.stakeNet, ma.balance, md.stakeNet, md.balance], [-200, 800, 200, 1200]);
    eq([(await mine(ann)).room, (await mine(dee)).room], [200, 300], 'what you can stake is 25% of the balance');
    ok((await inbox(ann)).some(x => /−200 XP/.test(x)));
  });
  await t('the server holds the unlock level the owner sets', async () => {
    await call('/admin/config', { method: 'PUT', owner: true, body: { unlocksOn: true, modules: { duels: 3 } } });
    const r = await send(cat, 'dee'); eq(r.status, 403); ok(/level 3/.test(r.d.error));
    await call('/admin/config', { method: 'PUT', owner: true, body: { modules: { duels: 1 } } });
  });
  await t('limits: open duels per member, people who don’t take challenges, types the league switched off', async () => {
    await call('/admin/config', { method: 'PUT', owner: true, body: { duels: { maxOpen: 1 } } });
    eq((await send(ann, 'dee')).status, 200);
    ok(/1 duels going/.test((await send(ann, 'bob')).d.error));
    await call('/me', { method: 'PUT', key: bob, body: { share: { duels: false } } });
    ok(/isn’t taking challenges/.test((await send(cat, 'bob')).d.error));
    ok(/doesn’t run/.test((await send(cat, 'dee', { type: 'ret' })).d.error));
  });
  await t('admins see every duel and can cancel one without a result; settings survive a restart', async () => {
    const A = (await call('/admin/duels', { owner: true })).d;
    eq([A.counts.active, A.counts.pending, A.config.maxOpen], [0, 1, 1]);
    const open = A.open[0]; eq([open.a, open.b, open.status], ['ann', 'dee', 'pending']);
    eq((await call('/admin/duels/' + open.id, { method: 'POST', owner: true, body: { action: 'cancel' } })).status, 200);
    ok((await inbox(dee)).some(x => /cancelled by the league’s admins/.test(x)));
    eq((await call('/admin/duels/' + open.id, { method: 'POST', key: ann, body: { action: 'cancel' } })).status, 401, 'members can’t');
    await new Promise(r => app.close(r)); app = mk(); B = await listen();
    eq((await call('/admin/duels', { owner: true })).d.config.maxOpen, 1);
    eq((await mine(ann)).record, { w: 1, l: 1, d: 0 }, 'won the first, lost the staked one');
    const c = (await call('/config')).d; eq([c.modules.duels, c.duels.on], [1, true]);
  });
  await t('stakes paid out as grants before the split move off earned XP once; the duel bonus stays', async () => {
    await new Promise(r => app.close(r));
    const { DatabaseSync } = await import('node:sqlite'), db = new DatabaseSync(join(dataDir, 'pulse.db'));
    const row = db.prepare('SELECT id, data FROM members').all().map(r => ({ id: r.id, m: JSON.parse(r.data) })).find(r => r.m.handle === 'cat');
    row.m.grants = [{ id: 'g1', xp: 100, why: 'Won a Discipline duel', at: clock, duel: 'dx' }, { id: 'g2', xp: 150, why: 'Won 150 XP staked by @ann', at: clock, duel: 'dx' },
      { id: 'g3', xp: -50, why: 'Lost a Clean days duel to @dee', at: clock, duel: 'dy' }, { id: 'g4', xp: 40, why: 'Bonus from the league owner', at: clock }];
    db.prepare('UPDATE members SET data = ? WHERE id = ?').run(JSON.stringify(row.m), row.id);
    const kv = k => JSON.parse(db.prepare('SELECT v FROM kv WHERE k = ?').get(k).v);
    const mg = kv('migrations'); ok(mg.stakeSplit, 'recorded'); delete mg.stakeSplit;
    db.prepare('UPDATE kv SET v = ? WHERE k = ?').run(JSON.stringify(mg), 'migrations'); db.close();
    app = mk(); B = await listen();
    const me = (await call('/me', { key: cat })).d.me;
    eq([me.grants.map(g => g.id), me.stakes.map(g => g.id), me.stakeNet], [['g1', 'g4'], ['g2', 'g3'], 100]);
    await new Promise(r => app.close(r)); app = mk(); B = await listen();
    eq((await call('/me', { key: cat })).d.me.stakeNet, 100, 'once: a restart doesn’t move it again');
  });
  await t('a server still on the first default (free duels) moves to level 3 once; a level the owner set stays', async () => {
    await new Promise(r => app.close(r));
    const { DatabaseSync } = await import('node:sqlite'), db = new DatabaseSync(join(dataDir, 'pulse.db'));
    const kv = k => JSON.parse(db.prepare('SELECT v FROM kv WHERE k = ?').get(k).v), put = (k, v) => db.prepare('UPDATE kv SET v = ? WHERE k = ?').run(JSON.stringify(v), k);
    const mg = kv('migrations'); ok(mg.duels3, 'the update is recorded'); delete mg.duels3; put('migrations', mg); db.close(); // as before this release
    app = mk(); B = await listen();
    eq((await call('/config')).d.modules.duels, 3, 'level 1 from the old default becomes 3');
    await call('/admin/config', { method: 'PUT', owner: true, body: { modules: { duels: 1 } } });
    await new Promise(r => app.close(r)); app = mk(); B = await listen();
    eq((await call('/config')).d.modules.duels, 1, 'the owner’s choice survives a restart');
  });
} finally { await new Promise(r => app.close(r)); }

report('duels');
