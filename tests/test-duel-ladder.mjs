// The duel ladder and group duels ("pods"). The rating maths and the pod ranking (pure, duels.js),
// then over HTTP: ratings from 1v1 results (forfeits count; backing out and admin cancels don't),
// who's listed, a season closing at the end of a quarter (podium, badge, notification, feed line,
// the soft reset), and a pod's whole life: create, invite, accept, start, the live score, lead
// changes, forfeits, settle, lapse, the open-duel limit, and the admin's settings and cancel. No network.
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

console.log('Rating maths and pod ranking');
t('Elo: start 1000, K 32; what one side gains the other loses; upsets move more', () => {
  eq(Duels.elo(1000, 1000, 1), { a: 1016, b: 984, delta: 16 });
  eq(Duels.elo(1000, 1000, 0.5).delta, 0, 'a draw between equals moves nothing');
  eq(Duels.elo(1000, 1000, 0).delta, -16);
  const fav = Duels.elo(1200, 1000, 1), dog = Duels.elo(1000, 1200, 1);
  eq([fav.delta, dog.delta], [8, 24], 'the favourite gains less than the underdog would');
  eq(Duels.elo(1200, 1000, 0.5).delta, -8, 'a draw against a weaker side costs the stronger one');
  eq(Duels.elo(1000, 1000, 1, 16).delta, 8, 'K sets the size of a move');
  eq(Duels.RATING0, 1000);
});
t('a new season pulls every rating a quarter of the way back to 1000', () => {
  eq([Duels.softReset(1200), Duels.softReset(800), Duels.softReset(1000), Duels.softReset(1030)], [1150, 850, 1000, 1023]);
});
t('settings: ladder on/off, K, minimum duels, pods on/off and size are clamped', () => {
  const c = Duels.sanitizeDuelCfg({ ladder: false, k: 999, ladderMin: 0, pods: false, podMax: 9 });
  eq([c.ladder, c.k, c.ladderMin, c.pods, c.podMax], [false, 100, 1, false, 6]);
  const d = Duels.sanitizeDuelCfg(null); eq([d.ladder, d.k, d.ladderMin, d.pods, d.podMax], [true, 32, 3, true, 6]);
  eq(Duels.sanitizeDuelCfg({ podMax: 1 }).podMax, 3);
});
t('pod terms: the process kinds, % return when the league runs it (with its cap), never a stake', () => {
  eq(Duels.sanitizePodTerms({ type: 'poker' }).error, 'Pick what to compete on.');
  ok(/doesn’t run/.test(Duels.sanitizePodTerms({ type: 'ret' }).error), '% return is off by default, as for a 1v1');
  const r = Duels.sanitizePodTerms({ type: 'ret', period: 'month', ddCap: 0.15 }, Duels.sanitizeDuelCfg({ types: { ret: true } }));
  eq([r.type, r.ddCap, r.minDays], ['ret', 0.15, 5], 'a month of % return needs 5 trading days by default');
  eq(Duels.sanitizePodTerms({ type: 'disc', ddCap: 0.2 }).ddCap, 0.2, 'a drawdown rule on a process kind');
  eq(Duels.sanitizePodTerms({ type: 'disc', ddCap: 0.2 }, Object.assign(Duels.sanitizeDuelCfg(null), { risk: Duels.sanitizeRiskCfg({ pod: 'off' }) })).ddCap, null, 'unless the owner switched the rule off for group duels');
  const p = Duels.sanitizePodTerms({ type: 'disc', period: 'month', stake: 500, minDays: 4 });
  eq([p.type, p.period, p.verified, p.minDays, p.stake], ['disc', 'month', true, 4, undefined]);
});
const side = (id, s, out) => ({ id, s, out: !!out });
t('pod ranking: higher wins, equal results share a place, anyone out is last', () => {
  const r = Duels.podRank({ type: 'clean' }, [side('a', { score: 3, avg: 80 }), side('b', { score: 4, avg: 75 }), side('c', { score: 3, avg: 80 }), side('d', { score: 9 }, true)]);
  eq(r.rows.map(x => x.id + x.place), ['b1', 'a2', 'c2', 'd4']); eq(r.lead, 'b');
  const lvl = Duels.podRank({ type: 'xp' }, [side('a', { score: 5 }), side('b', { score: 5 })]);
  eq([lvl.lead, lvl.rows.map(x => x.place)], [null, [1, 1]], 'a shared top: no leader');
});
t('pod ranking: Discipline needs the agreed days; last one standing ranks by who fell last', () => {
  const d = Duels.podRank({ type: 'disc', minDays: 3 }, [side('a', { n: 2, avg: 99 }), side('b', { n: 3, avg: 70 }), side('c', { n: 4, avg: 81 })]);
  eq(d.rows.map(x => x.id), ['c', 'b', 'a']);
  const s = Duels.podRank({ type: 'survive' }, [side('a', { fell: '2026-10-06' }), side('b', {}), side('c', { fell: '2026-10-08' }), side('d', {}, true)]);
  eq([s.rows.map(x => x.id + x.place), s.lead, s.why], [['b1', 'c2', 'a3', 'd4'], 'b', 'last one standing']);
  eq(Duels.podRank({ type: 'survive' }, [side('a', {}), side('b', {})]).lead, null, 'two still standing: level');
});

console.log('\nOver HTTP');
let clock = Date.parse('2026-09-02T15:00:00Z'); // a Wednesday in Q3
const dataDir = mkdtempSync(join(tmpdir(), 'ledger-ladder-'));
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
const K = {};
const join_ = async (h, extra) => (K[h] = (await call('/join', { method: 'POST', ip: '10.0.3.' + (++ipN), body: Object.assign({ handle: h, share: { feed: true } }, extra) })).d.key);
const days = pairs => ({ xp: 100, days: pairs.map(([k, s]) => ({ k, s, j: s >= 70, r: s >= 70 })), xpDays: {} });
const run = (h, from, scores) => call('/stats', { method: 'POST', key: K[h], body: days(scores.map((s, i) => [new Date(Date.parse(from) + i * DAY).toISOString().slice(0, 10), s])) });
const send = (from, to, terms) => call('/duels', { method: 'POST', key: K[from], body: Object.assign({ to, type: 'disc', period: 'week', verified: false }, terms) });
const act = (h, id, action) => call('/duels/' + id, { method: 'POST', key: K[h], body: { action } });
const mine = async h => (await call('/duels', { key: K[h] })).d;
const inbox = async h => (await call('/inbox', { key: K[h] })).d.items.map(x => x.text);
const podNew = (from, to, terms) => call('/pods', { method: 'POST', key: K[from], body: Object.assign({ to, type: 'clean', period: 'week', verified: false }, terms) });
const podAct = (h, id, action) => call('/pods/' + id, { method: 'POST', key: K[h], body: { action } });
const podOf = async (h, id) => (await mine(h)).pods.find(p => p.id === id);
const cfg = duels => call('/admin/config', { method: 'PUT', owner: true, body: { duels } });

try {
  for (const h of ['ann', 'bob', 'cat', 'dee', 'eve', 'fay']) await join_(h);
  await call('/admin/config', { method: 'PUT', owner: true, body: { modules: { duels: 1 }, standing: { on: false } } }); // standing has its own tests (test-trader-age-server)

  let ab, ac, ad;
  await t('a played duel moves both ratings; the result says by how much', async () => {
    ab = (await send('ann', 'bob')).d.duel.id; ac = (await send('ann', 'cat')).d.duel.id; ad = (await send('ann', 'dee')).d.duel.id;
    for (const [h, id] of [['bob', ab], ['cat', ac], ['dee', ad]]) eq((await act(h, id, 'accept')).d.duel.start, '2026-09-07');
    const L = (await mine('ann')).ladder; eq([L.on, L.me.r, L.me.n, L.k, L.min], [true, 1000, 0, 32, 3], 'everyone starts at 1000');
    clock = Date.parse('2026-09-08T12:00:00Z');
    const f = await act('cat', ac, 'forfeit'); eq([f.d.duel.result.outcome, f.d.duel.result.rating], ['lost', -16], 'a forfeit counts');
    clock = Date.parse('2026-09-09T20:00:00Z'); // a day is posted once it's played: one after the member's today is dropped
    await run('ann', '2026-09-07', [90, 90, 90]); await run('bob', '2026-09-07', [60, 60, 60]); await run('dee', '2026-09-07', [90, 90, 90]);
    clock = Date.parse('2026-09-15T09:00:00Z');
    const a = await mine('ann'), won = a.duels.find(x => x.id === ab), drew = a.duels.find(x => x.id === ad);
    const e1 = Duels.elo(1016, 1000, 1), e2 = Duels.elo(e1.a, 1000, 0.5);
    eq([won.result.outcome, won.result.rating, drew.result.outcome, drew.result.rating], ['won', e1.delta, 'draw', e2.delta]);
    eq([a.ladder.me.r, a.ladder.me.n], [e2.a, 3]);
    eq((await mine('bob')).ladder.me.r, e1.b); eq((await mine('dee')).ladder.me.r, e2.b);
    const p = (await call('/profile/ann', { key: K.eve })).d.profile; eq([p.rating, p.duels], [e2.a, { w: 2, l: 0, d: 1 }], 'the rating sits beside the record');
    eq((await call('/profile/eve', { key: K.ann })).d.profile.rating, null, 'no rated duels: no rating');
  });
  await t('backing out before the start and an admin cancel don’t move ratings', async () => {
    const before = (await mine('bob')).ladder.me;
    const x = (await send('bob', 'eve')).d.duel.id; await act('eve', x, 'accept'); await act('eve', x, 'forfeit');
    const y = (await send('bob', 'fay')).d.duel.id; await act('fay', y, 'accept');
    eq((await call('/admin/duels/' + y, { method: 'POST', owner: true, body: { action: 'cancel' } })).status, 200);
    eq((await mine('bob')).ladder.me, before); eq((await mine('eve')).ladder.me.n, 0);
  });
  await t('the ladder lists members with enough rated duels who share their profile and take challenges', async () => {
    let L = (await mine('bob')).ladder;
    eq([L.top.map(r => r.handle), L.me.rank, L.season.label, L.season.rows.map(r => r.handle)], [['ann'], null, 'Q3 2026', ['ann']]);
    await cfg({ ladderMin: 1 });
    L = (await mine('bob')).ladder; eq(L.top.map(r => r.handle), ['ann', 'dee', 'bob', 'cat']); eq([L.me.rank, L.season.rows.find(r => r.me).gain], [3, L.me.gain]);
    await call('/me', { method: 'PUT', key: K.bob, body: { share: { profile: false } } });
    await call('/me', { method: 'PUT', key: K.cat, body: { share: { duels: false } } });
    L = (await mine('bob')).ladder; eq([L.top.map(r => r.handle), L.me.rank, L.me.shown], [['ann', 'dee'], null, false], 'private profiles and members not taking challenges are left off');
    ok(L.me.r < 1000, 'you still see your own rating');
    await call('/me', { method: 'PUT', key: K.cat, body: { share: { duels: true } } });
  });
  await t('a season closes the second day of the next quarter: podium, badge, notification, feed line, soft reset', async () => {
    const annR = (await mine('ann')).ladder.me.r, deeR = (await mine('dee')).ladder.me.r;
    clock = Date.parse('2026-10-01T12:00:00Z');
    eq((await mine('ann')).ladder.season.id, '2026-Q3', 'the last day’s duels may still settle');
    clock = Date.parse('2026-10-02T12:00:00Z');
    const L = (await mine('ann')).ladder;
    eq([L.season.id, L.season.label, L.me.r, L.me.gain, L.season.rows.length], ['2026-Q4', 'Q4 2026', Duels.softReset(annR), 0, 0]);
    eq(L.hall, [{ label: 'Q3 2026', podium: [{ handle: 'ann', gain: annR - 1000 }, { handle: 'dee', gain: deeR - 1000 }] }], 'only points gained make the podium: two this time');
    eq((await mine('bob')).ladder.me.r, Duels.softReset(Duels.elo(1016, 1000, 1).b), 'everyone is pulled back, below 1000 too');
    ok((await inbox('ann')).some(x => /You finished #1 on the duel ladder for Q3 2026, with \+\d+ rating/.test(x)), 'the top three are told');
    ok((await inbox('dee')).some(x => /#2 on the duel ladder/.test(x)));
    const me = (await call('/me', { key: K.ann })).d.me; ok(me.awards.some(a => a.id === 'duel-gold'), JSON.stringify(me.awards));
    ok((await call('/me', { key: K.dee })).d.me.awards.some(a => a.id === 'duel-silver'));
    const prof = (await call('/profile/ann', { key: K.eve })).d.profile; ok(prof.awards.some(a => a.name === 'Duel season champion'), 'a system badge');
    { const fd = JSON.stringify((await call('/feed?scope=discover', { key: K.eve })).d); ok(fd.includes('won the Q3 2026 duel season'), fd); }
    const A = (await call('/admin/duels', { owner: true })).d.ladder; eq([A.season.id, A.top, A.last.podium], ['2026-Q4', [], ['ann', 'dee']]);
  });

  let pod;
  await t('a group duel: 3 to 6 people, the kinds the league runs, people who take challenges', async () => {
    ok(/doesn’t run/.test((await podNew('ann', ['bob', 'cat'], { type: 'ret' })).d.error), '% return only when the league runs it');
    ok(/Show % return/.test((await podNew('ann', ['bob', 'cat'], { type: 'disc', ddCap: 0.15 })).d.error), 'a drawdown rule needs a wallet that shares returns');
    eq((await podNew('ann', ['bob'])).d.error, 'Invite at least 2 people.');
    eq((await podNew('ann', ['bob', 'ann', '@BOB'])).d.error, 'Invite at least 2 people.', 'yourself and the same person twice don’t count');
    ok(/no member called @zed/.test((await podNew('ann', ['bob', 'zed'])).d.error));
    await call('/me', { method: 'PUT', key: K.fay, body: { share: { duels: false } } });
    ok(/@fay isn’t taking challenges/.test((await podNew('ann', ['bob', 'fay'])).d.error));
    await cfg({ podMax: 3 }); ok(/at most 3 people/.test((await podNew('ann', ['bob', 'cat', 'dee'])).d.error)); await cfg({ podMax: 6 });
    ok(/Verify my discipline/.test((await podNew('ann', ['bob', 'cat'], { type: 'disc', verified: true })).d.error), 'verified needs verification, as in a 1v1');
    const r = await podNew('ann', ['bob', 'cat', 'dee', 'eve'], { msg: 'Five of us' }); eq(r.status, 200, JSON.stringify(r.d)); pod = r.d.pod.id;
    eq([r.d.pod.status, r.d.pod.my, r.d.pod.in, r.d.pod.members.length, r.d.pod.preview], ['pending', 'in', 1, 5, { start: '2026-10-05', end: '2026-10-11' }]);
    ok((await inbox('bob')).some(x => /@ann invited you to a Clean days group duel \(a week\) with @cat, @dee, @eve: “Five of us” Answer within 48 hours/.test(x)));
    eq((await podOf('bob', pod)).my, 'invited');
  });
  await t('a pod counts once toward each member’s open-duel limit, invitations included', async () => {
    eq([(await mine('ann')).open, (await mine('bob')).open], [1, 1]);
    await cfg({ maxOpen: 1 });
    ok(/You have 1 duels going/.test((await send('ann', 'eve')).d.error));
    ok(/@bob has 1 duels going/.test((await send('fay', 'bob')).d.error), 'an invitation waiting on you counts too');
    ok(/You have 1 duels going/.test((await podNew('ann', ['cat', 'dee'])).d.error));
    await cfg({ maxOpen: 3 });
  });
  await t('three in starts it: the next Monday; latecomers can still join before the start', async () => {
    eq((await podAct('bob', pod, 'accept')).d.pod.status, 'pending', 'two in: still waiting');
    eq((await podAct('cat', pod, 'decline')).d.pod.my, 'declined');
    eq((await podAct('cat', pod, 'accept')).status, 409, 'a no is final');
    const a = await podAct('dee', pod, 'accept'); eq([a.d.pod.status, a.d.pod.start, a.d.pod.end, a.d.pod.in], ['active', '2026-10-05', '2026-10-11', 3]);
    ok((await inbox('ann')).some(x => /Clean days group duel is on, with @ann, @bob, @dee\. It runs Oct 5 – Oct 11/.test(x)));
    eq((await podAct('eve', pod, 'accept')).d.pod.in, 4);
    eq((await podAct('bob', pod, 'cancel')).status, 409, 'only the creator calls it off');
    ok(!(await mine('cat')).pods.some(p => p.id === pod), 'declined: off your list');
  });
  await t('the live score ranks everyone; a lead change is told once a day at most; forfeiting puts you last', async () => {
    clock = Date.parse('2026-10-05T18:00:00Z');
    eq((await podOf('fay', pod)), undefined);
    await run('dee', '2026-10-05', [80]);
    let v = await podOf('ann', pod); eq([v.lead, v.why, v.members[0].handle, v.members[0].score], ['dee', 'most clean days', 'dee', 1]);
    clock = Date.parse('2026-10-06T18:00:00Z');
    await run('ann', '2026-10-05', [80, 80]);
    v = await podOf('ann', pod); eq([v.lead, v.leadMe], ['ann', true]);
    ok((await inbox('dee')).some(x => /@ann took the lead in your Clean days group duel/.test(x)));
    ok((await inbox('ann')).some(x => /You took the lead in your Clean days group duel/.test(x)));
    await run('dee', '2026-10-05', [85, 85]); await mine('ann');
    eq((await inbox('ann')).filter(x => /took the lead/.test(x)).length, 1, 'not twice in a day');
    const f = await podAct('eve', pod, 'leave'); eq(f.d.pod.my, 'out');
    v = await podOf('ann', pod); eq(v.members.map(m => m.handle + (m.place || '')), ['dee1', 'ann2', 'bob3', 'eve4', 'cat'], 'the one who declined is listed, unplaced');
    eq((await podAct('ann', pod, 'cancel')).status, 409, 'running: it can’t be called off');
  });
  await t('settled the day after it ends: placings, the winner’s XP, pods won on profiles, no rating change', async () => {
    const r0 = (await mine('dee')).ladder.me.r;
    await run('bob', '2026-10-05', [90, 60, 60]);
    clock = Date.parse('2026-10-13T09:00:00Z');
    const v = await podOf('dee', pod);
    eq([v.status, v.result.won, v.result.place, v.result.of, v.result.xp, v.result.winner], ['done', true, 1, 4, 100, 'dee']);
    const b = await podOf('bob', pod); eq([b.result.place, b.result.xp], [3, 0]);
    ok((await inbox('bob')).some(x => /@dee won your Clean days group duel\. You placed 3rd of 4/.test(x)));
    ok((await inbox('dee')).some(x => /You won your Clean days group duel against 3 others\. \+100 XP/.test(x)));
    ok((await call('/me', { key: K.dee })).d.me.grants.some(g => g.xp === 100 && /group duel/.test(g.why)));
    eq((await call('/profile/dee', { key: K.cat })).d.profile.pods, { w: 1, n: 1 });
    eq((await call('/profile/eve', { key: K.cat })).d.profile.pods, { w: 0, n: 1 }, 'a forfeit still gets a placing');
    eq((await mine('dee')).ladder.me.r, r0, 'pods don’t move the rating');
    ok(JSON.stringify((await call('/feed?scope=discover', { key: K.cat })).d).includes('won a 4-person Clean days group duel'));
    eq((await mine('ann')).open, 0, 'over: off the limit');
  });
  await t('fewer than 3 in 48 hours: it lapses; backing out before the start can drop it below 3', async () => {
    await call('/me', { method: 'PUT', key: K.fay, body: { share: { duels: true } } });
    const p = (await podNew('ann', ['cat', 'fay'], { type: 'xp', period: 'month' })).d.pod.id;
    await podAct('cat', p, 'accept');
    clock += 49 * 3600000;
    const v = await podOf('ann', p); eq([v.status, v.members.find(m => m.handle === 'fay').st], ['lapsed', 'expired']);
    ok((await inbox('cat')).some(x => /didn’t start: fewer than 3 people accepted in 48 hours/.test(x)));
    eq((await podAct('fay', p, 'accept')).status, 409);
    const q = (await podNew('bob', ['cat', 'fay'])).d.pod.id; await podAct('cat', q, 'accept'); eq((await podAct('fay', q, 'accept')).d.pod.status, 'active');
    eq((await podAct('bob', q, 'leave')).status, 409, 'the creator calls it off instead');
    eq((await podAct('fay', q, 'leave')).d.pod.status, 'pending', 'two left: waiting again while invitations are open');
    eq((await podAct('bob', q, 'cancel')).d.pod.status, 'cancelled');
    ok((await inbox('cat')).some(x => /@bob called off the Clean days group duel/.test(x)));
  });
  await t('a member whose wallet moved mid-pod is out', async () => {
    for (const h of ['gus', 'hal', 'ivy']) await join_(h, { address: '0x' + String(h.length + ['gus', 'hal', 'ivy'].indexOf(h)).repeat(40) });
    const p = (await podNew('gus', ['hal', 'ivy'], { type: 'journal' })).d.pod.id; await podAct('hal', p, 'accept'); await podAct('ivy', p, 'accept');
    const st = (await podOf('gus', p)).start; clock = Date.parse(st + 'T12:00:00Z');
    await run('gus', st, [90]); await call('/me', { method: 'PUT', key: K.gus, body: { address: '0x' + '9'.repeat(40) } });
    const v = await podOf('hal', p), g = v.members.find(m => m.handle === 'gus');
    eq([g.out, g.note, g.place], [true, 'changed wallet mid-duel', 3]);
  });
  await t('admins see pods beside duels, cancel one, and switch pods and the ladder off', async () => {
    const r = await podNew('cat', ['dee', 'fay']); const id = r.d.pod.id;
    const A = (await call('/admin/duels', { owner: true })).d, row = A.open.find(x => x.id === id);
    eq([row.pod, row.names, row.status, row.awaiting, A.pods.open >= 1], [true, ['cat', 'dee', 'fay'], 'pending', '2 to answer', true]);
    ok(A.recent.some(x => x.pod && x.winner === 'dee'), 'the finished pod is in recent results');
    eq([A.config.ladder, A.config.k, A.config.ladderMin, A.config.pods, A.config.podMax], [true, 32, 1, true, 6]);
    eq((await call('/admin/duels/' + id, { method: 'POST', owner: true, body: { action: 'cancel' } })).status, 200);
    ok((await inbox('dee')).some(x => /group duel was cancelled by the league’s admins/.test(x)));
    eq((await podOf('cat', id)).status, 'cancelled');
    await cfg({ pods: false, ladder: false });
    ok(/Group duels are switched off/.test((await podNew('cat', ['dee', 'fay'])).d.error));
    const d = await mine('cat'); eq([d.podOn, d.ladder.on], [false, false]);
    const x = (await send('cat', 'fay')).d.duel.id; await act('fay', x, 'accept');
    clock = Date.parse((await mine('cat')).duels.find(v => v.id === x).start + 'T12:00:00Z'); await act('fay', x, 'forfeit');
    eq((await call('/profile/fay', { key: K.cat })).d.profile.rating, null, 'ladder off: no rating moves, none shown');
    await cfg({ pods: true, ladder: true, k: 16 });
  });
  await t('ratings, seasons and pods survive a restart', async () => {
    const before = (await mine('ann')).ladder;
    await new Promise(r => app.close(r)); app = mk(); B = await listen();
    const L = (await mine('ann')).ladder; eq([L.me.r, L.season.id, L.hall.length, L.k], [before.me.r, before.season.id, 1, 16]);
    ok((await mine('dee')).pods.some(p => p.id === pod && p.status === 'done'));
  });
} finally { await new Promise(r => app.close(r)); }

report('duel ladder');
