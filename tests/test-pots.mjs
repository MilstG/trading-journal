// XP pots: buy-ins on group duels and competitions, held when a member joins and paid out on merit
// when it settles. The settings, the pot's size, the split and who moved XP to whom (pots.js), then
// both kinds over HTTP: buy-ins leaving and coming back to the stake balance, payouts, the monthly
// limit between two members, and the cap on measures the apps report themselves.
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { t, ok, eq, report } from './harness.mjs';

const require = createRequire(import.meta.url);
const Pots = require('../pots.js');
const server = require('../server.js');
const htmlPath = new URL('../ledger.html', import.meta.url).pathname;
const DAY = 86400000;

console.log('\nSettings and terms');
t('the owner’s pot settings are clamped; the default burn never tops the ceiling', () => {
  const c = Pots.sanitizePotCfg(null);
  eq([c.pods, c.podMaxBuyIn, c.comps, c.compMaxBuyIn, c.burnPct, c.burnMax, c.pairCapMonth, c.selfMax, c.oneSeat, c.minEntrants], [true, 250, true, 1000, 0, 20, 1000, 100, true, 3]);
  const x = Pots.sanitizePotCfg({ burnPct: 30, burnMax: 10, podMaxBuyIn: -5, minEntrants: 1, oneSeat: false }, c);
  eq([x.burnPct, x.burnMax, x.podMaxBuyIn, x.minEntrants, x.oneSeat], [10, 10, 0, 2, false]);
});
t('a pot’s terms: within the league’s cap, a split the format allows', () => {
  eq(Pots.sanitizePotTerms({}), { buyIn: 0, pay: null }, 'no buy-in: no pot');
  eq(Pots.sanitizePotTerms({ buyIn: 100, pay: 'top3' }, null, 'pod'), { buyIn: 100, pay: 'wta' }, 'a group duel can’t pay three places');
  eq(Pots.sanitizePotTerms({ buyIn: 100 }, null, 'comp').pay, 'top3');
  ok(/at most 250 XP|can be here is 250/.test(Pots.sanitizePotTerms({ buyIn: 300 }, null, 'pod').error));
  ok(/doesn’t allow/.test(Pots.sanitizePotTerms({ buyIn: 50 }, Pots.sanitizePotCfg({ pods: false }), 'pod').error));
});
t('the pot’s size: buy-ins and overlay, less the burn (rounded down)', () => {
  eq(Pots.potSize(400, 10), { gross: 400, burned: 40, pot: 360 });
  eq(Pots.potSize(333, 5), { gross: 333, burned: 16, pot: 317 });
  eq(Pots.potSize(300, 0), { gross: 300, burned: 0, pot: 300 });
});

console.log('\nThe split');
const row = (id, place, q = true) => ({ id, place, q });
t('winner takes all, top 2, top 3, and the rounding remainder to first place', () => {
  eq(Pots.payouts(300, [row('a', 1), row('b', 2)], 'wta').paid, { a: 300 });
  eq(Pots.payouts(300, [row('a', 1), row('b', 2), row('c', 3)], 'top2').paid, { a: 210, b: 90 });
  eq(Pots.payouts(100, [row('a', 1), row('b', 2), row('c', 3)], 'top3').paid, { a: 60, b: 30, c: 10 });
  eq(Pots.payouts(101, [row('a', 1), row('b', 2), row('c', 3)], 'top3').paid, { a: 61, b: 30, c: 10 });
});
t('tied places share the prizes for the places they cover', () => {
  eq(Pots.payouts(1000, [row('a', 1), row('b', 1), row('c', 3)], 'top3').paid, { a: 450, b: 450, c: 100 });
  eq(Pots.payouts(1000, [row('a', 1), row('b', 2), row('c', 2), row('d', 4)], 'top2').paid, { a: 700, b: 150, c: 150 });
});
t('places nobody qualified for flow to those who did; nobody qualified: a refund', () => {
  eq(Pots.payouts(1000, [row('a', 1), row('b', 2), row('c', 3, false)], 'top3').paid, { a: 667, b: 333 });
  eq(Pots.payouts(1000, [row('a', 1, false), row('b', 2, false)], 'wta'), { refund: true, paid: {} });
});
t('the top quarter: k places, k to 1; survivors split: equal shares', () => {
  const n = 12, rows = Array.from({ length: n }, (_, i) => row('p' + i, i + 1));
  eq(Pots.payouts(600, rows, 'topq', n).paid, { p0: 300, p1: 200, p2: 100 });
  eq(Pots.payouts(100, [row('a', 1), row('b', 2), row('c', 3), row('d', 4, false)], 'surv').paid, { a: 34, b: 33, c: 33 });
});
t('who moved XP to whom: each loss spread over the winners in proportion to their gains', () => {
  eq(Pots.pairFlows({ a: 110, b: -10, c: -100 }), [['b', 'a', 10], ['c', 'a', 100]]);
  eq(Pots.pairFlows({ a: 50, b: 50, c: -100 }), [['c', 'a', 50], ['c', 'b', 50]]);
  eq(Pots.pairFlows({ a: 0, b: 0 }), []);
});

console.log('\nOver HTTP');
let clock = Date.parse('2026-09-02T15:00:00Z'); // a Wednesday
const dataDir = mkdtempSync(join(tmpdir(), 'ledger-pots-'));
const app = server.createApp({ dataDir, auth: 'owner-token', htmlPath, now: () => clock, push: false, pushTick: false, trustProxy: true,
  fetchImpl: async () => ({ ok: true, status: 200, json: async () => [] }) });
const B = await new Promise(res => app.listen(0, () => res('http://127.0.0.1:' + app.address().port)));
let ipN = 0;
const call = async (p, o = {}) => { const r = await fetch(B + '/api/social' + p, { method: o.method || 'GET',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': o.ip || '10.0.0.1', ...(o.key ? { 'X-Pulse-Key': o.key } : {}), ...(o.owner ? { Authorization: 'Bearer owner-token' } : {}) },
    body: o.body !== undefined ? JSON.stringify(o.body) : undefined });
  return { status: r.status, d: await r.json().catch(() => ({})) }; };
const K = {};
const join_ = async h => (K[h] = (await call('/join', { method: 'POST', ip: '10.0.4.' + (++ipN), body: { handle: h } })).d.key);
// earned XP 2,000 for everyone; days: [key, score, journaled]
const post = (h, days) => call('/stats', { method: 'POST', key: K[h], body: { xp: 2000, level: 4, days: days.map(([k, s, j]) => ({ k, s, j: !!j, r: !!j })), xpDays: {} } });
const me = async h => (await call('/me', { key: K[h] })).d.me;
const bal = async h => (await me(h)).balance;
const podNew = (from, to, terms) => call('/pods', { method: 'POST', key: K[from], body: Object.assign({ to, type: 'clean', period: 'week', verified: false }, terms) });
const podAct = (h, id, action) => call('/pods/' + id, { method: 'POST', key: K[h], body: { action } });
const podOf = async (h, id) => (await call('/duels', { key: K[h] })).d.pods.find(p => p.id === id);
const inbox = async h => (await call('/inbox', { key: K[h] })).d.items.map(x => x.text);
const dk = (from, i) => new Date(Date.parse(from) + i * DAY).toISOString().slice(0, 10);

try {
  for (const h of ['ann', 'bob', 'cat', 'dee', 'eve']) { await join_(h); await post(h, []); }
  await call('/admin/config', { method: 'PUT', owner: true, body: { unlocksOn: false, standing: { on: false } } });
  let pod;
  await t('a group duel with a buy-in: the creator’s leaves the balance now, each invitee’s when they accept', async () => {
    ok(/apps report themselves, a buy-in can be at most 100 XP/.test((await podNew('ann', ['bob', 'cat'], { buyIn: 150 })).d.error), 'clean days from the app: 100 at most');
    const r = await podNew('ann', ['bob', 'cat', 'dee'], { buyIn: 100, pay: 'top2' }); eq(r.status, 200, JSON.stringify(r.d)); pod = r.d.pod.id;
    eq([r.d.pod.pot.buyIn, r.d.pod.pot.pay, r.d.pod.pot.gross], [100, 'top2', 100]);
    eq([await bal('ann'), await bal('bob')], [1900, 2000], 'held from the creator; nothing from an invitee yet');
    ok((await inbox('bob')).some(x => /100 XP buy-in each/.test(x)));
    await podAct('bob', pod, 'accept'); await podAct('cat', pod, 'accept'); await podAct('dee', pod, 'decline');
    eq([await bal('bob'), await bal('cat'), await bal('dee')], [1900, 1900, 2000]);
    const v = await podOf('ann', pod); eq([v.status, v.start, v.pot.gross, v.pot.pot], ['active', '2026-09-07', 300, 300]);
    eq((await me('ann')).stakes.slice(-1)[0].xp, -100, 'the buy-in is in the stake record');
  });
  await t('called off before the start: every buy-in comes back', async () => {
    const r = await podNew('ann', ['eve', 'dee'], { buyIn: 50, type: 'journal' }); eq(r.status, 200, JSON.stringify(r.d));
    await podAct('eve', r.d.pod.id, 'accept'); eq([await bal('ann'), await bal('eve')], [1850, 1950]);
    eq((await podAct('ann', r.d.pod.id, 'cancel')).status, 200);
    eq([await bal('ann'), await bal('eve')], [1900, 2000]);
    ok((await inbox('eve')).some(x => /Your buy-in is back/.test(x)));
  });
  await t('settled: the pot is paid on merit; earned XP and levels never move', async () => {
    clock = Date.parse('2026-09-10T18:00:00Z');
    await post('ann', [[dk('2026-09-07', 0), 90], [dk('2026-09-07', 1), 85], [dk('2026-09-07', 2), 80]]);
    await post('bob', [[dk('2026-09-07', 0), 90], [dk('2026-09-07', 1), 75]]);
    await post('cat', [[dk('2026-09-07', 0), 72]]);
    clock = Date.parse('2026-09-15T09:00:00Z');
    const v = await podOf('ann', pod); eq([v.status, v.pot.done, v.pot.mine.won], ['done', true, 210]);
    eq([await bal('ann'), await bal('bob'), await bal('cat')], [2110, 1990, 1900], 'ann +210, bob +90 on their 100 each');
    const m = await me('ann'); eq(m.stats ? m.stats.xp : 2000, 2000);
    ok(m.stakes.some(s => s.xp === 210 && /from the pot/.test(s.why)));
    ok(!m.grants.some(g => /pot/.test(g.why)), 'never a grant: the level doesn’t move');
    ok((await inbox('bob')).some(x => /\+90 XP from the pot/.test(x)));
  });
  await t('the monthly limit between two members: no more staked events once it’s reached', async () => {
    await call('/admin/config', { method: 'PUT', owner: true, body: { pots: { pairCapMonth: 100 } } });
    const r = await podNew('ann', ['cat', 'eve'], { buyIn: 50 }); eq(r.status, 409);
    ok(/You and @cat have moved 100 XP between you this month/.test(r.d.error), r.d.error);
    eq((await podNew('ann', ['cat', 'eve'])).status, 200, 'without a buy-in it goes ahead');
    await call('/admin/config', { method: 'PUT', owner: true, body: { pots: { pairCapMonth: 1000 } } });
  });
  let cid;
  await t('a competition with a buy-in: entrants put it up when they join; backing out before the start gives it back', async () => {
    clock = Date.parse('2026-09-16T12:00:00Z');
    const big = await call('/admin/competitions', { method: 'POST', owner: true, body: { title: 'Journal pot', type: 'journal', start: '2026-09-21', end: '2026-09-27', buyIn: 150 } });
    ok(/at most 100 XP/.test(big.d.error), 'journaling comes from the app: 100 at most');
    const c = await call('/admin/competitions', { method: 'POST', owner: true, body: { title: 'Journal pot', type: 'journal', start: '2026-09-21', end: '2026-09-27', buyIn: 100, overlay: 100, burnPct: 10, pay: 'top3' } });
    eq(c.status, 200, JSON.stringify(c.d)); cid = c.d.id;
    for (const h of ['ann', 'bob', 'cat', 'dee']) eq((await call('/competitions/' + cid + '/join', { method: 'POST', key: K[h] })).status, 200);
    eq(await bal('dee'), 1900);
    await call('/competitions/' + cid + '/join', { method: 'DELETE', key: K.dee }); eq(await bal('dee'), 2000, 'before the start: back');
    const x = (await call('/competitions/' + cid, { key: K.ann })).d.competition.pot;
    eq([x.buyIn, x.overlay, x.burnPct, x.gross, x.burned, x.pot, x.field], [100, 100, 10, 400, 40, 360, 3]);
    clock = Date.parse('2026-09-22T12:00:00Z');
    ok(/closed to new entrants/.test((await call('/competitions/' + cid + '/join', { method: 'POST', key: K.eve })).d.error));
  });
  await t('results final: the pot (buy-ins and overlay, less the burn) goes to the top three', async () => {
    const wk = n => Array.from({ length: n }, (_, i) => [dk('2026-09-21', i), 80, true]);
    await post('ann', wk(5)); await post('bob', wk(3)); await post('cat', [[dk('2026-09-21', 0), 80, false]]);
    const before = { ann: await bal('ann'), bob: await bal('bob'), cat: await bal('cat') };
    clock = Date.parse('2026-09-30T12:00:00Z');
    const c = (await call('/competitions/' + cid, { key: K.ann })).d.competition;
    eq([c.status, c.pot.done, c.pot.mine.won], ['finished', true, 216]);
    eq([await bal('ann') - before.ann, await bal('bob') - before.bob, await bal('cat') - before.cat], [216, 108, 36], '60/30/10 of 360');
    ok((await inbox('ann')).some(x => /Journal pot: \+216 XP from the pot/.test(x)));
  });
  await t('too few entrants when it ends: every buy-in comes back', async () => {
    clock = Date.parse('2026-10-01T12:00:00Z');
    const c = (await call('/admin/competitions', { method: 'POST', owner: true, body: { title: 'Thin', type: 'journal', start: '2026-10-05', end: '2026-10-06', buyIn: 50 } })).d.id;
    await call('/competitions/' + c + '/join', { method: 'POST', key: K.eve }); eq(await bal('eve'), 1950);
    clock = Date.parse('2026-10-09T12:00:00Z'); await call('/duels', { key: K.eve });
    await call('/competitions/' + c, { key: K.eve });
    eq(await bal('eve'), 2000); ok((await inbox('eve')).some(x => /too few entrants/.test(x)));
  });
  await t('removing a competition before it pays out gives every buy-in back', async () => {
    const c = (await call('/admin/competitions', { method: 'POST', owner: true, body: { title: 'Gone', type: 'journal', start: '2026-10-19', end: '2026-10-25', buyIn: 40 } })).d.id;
    await call('/competitions/' + c + '/join', { method: 'POST', key: K.eve }); eq(await bal('eve'), 1960);
    eq((await call('/admin/competitions/' + c, { method: 'DELETE', owner: true })).status, 200); eq(await bal('eve'), 2000);
  });
} finally { await new Promise(r => app.close(r)); }
report('pots');
