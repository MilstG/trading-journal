// "Traders like you who improved": each contributor's weekly history (members and seed wallets),
// who moved from the bottom half of their group to the top half over 8–12 weeks, the medians of
// what changed for them against everyone else, the minimum sizes that keep it anonymous, the API
// shape, and the opt-out. Network is stubbed; the server's clock is moved a week at a time.
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { t, ok, eq, report, makeExtractor } from './harness.mjs';
import { readAppSource } from '../app-source.js';

const require = createRequire(import.meta.url);
const Bench = require('../bench.js');
const server = require('../server.js');
const htmlPath = new URL('../ledger.html', import.meta.url).pathname;
const DAY = 86400000, WEEK = 7 * DAY, T0 = Date.parse('2026-07-06T12:00:00Z');
const dayKey = ms => new Date(ms).toISOString().slice(0, 10);

// A group of 24 day traders followed for 11 weeks. 0–7 improve from week 6 (Discipline from the
// bottom half to the top; fewer trades, no quick re-entries, 3x the journaling, no sizing up after
// a loss); 8–11 stay at the bottom; 12–23 stay at the top. Profit factor is flat for everyone.
const KIND = i => i < 8 ? 'imp' : i < 12 ? 'low' : 'high';
const sumOf = (i, w) => { const k = KIND(i), late = k === 'imp' && w >= 6;
  return { ok: true, v: 1, n: 60, style: 'day', size: 's2', exp: 'e2', act: 'a2', pf: 1.2, wr: 50, pay: 1.1, fees: 20, hold: 80,
    disc: k === 'imp' ? (late ? 85 + i : 30 + i) : k === 'low' ? 20 + i : 60 + i,
    tw: late ? 12 : 20, rev: k === 'imp' ? (late ? 0.5 : 10) : k === 'low' ? 8 : 3, jour: k === 'imp' ? (late ? 30 : 10) : k === 'low' ? 20 : 25 }; };
const daysOf = (i, w, at) => Array.from({ length: 20 }, (_, d) => ({ k: dayKey(at - d * DAY), s: 80,
  f: KIND(i) === 'imp' ? (w < 6 && d % 5 < 2 ? ['sizeUp'] : []) : d % 10 === 0 ? ['sizeUp'] : [] }));

console.log('Weekly history');
t('a snapshot is compact: the week, nine numbers, the slip rates; missing ones at the end are dropped', () => {
  const s = Bench.histSnap(sumOf(0, 0), T0, { afterTwo: 0, sizeUp: 40, addLoser: 0, overtrade: 0, heldLoser: 0 });
  eq(s, [Bench.weekOf(T0), 30, 10, 10, 50, 1.2, 1.1, 20, 20, 80, [0, 40, 0, 0, 0]]);
  eq(Bench.histSnap({ disc: 50, rev: 2, jour: null, wr: 40, pf: 1, pay: 1, fees: 5, tw: 9, hold: null }, T0), [Bench.weekOf(T0), 50, 2, null, 40, 1, 1, 5, 9]);
  eq([Bench.histVal(s, 'tw'), Bench.histVal(s, 'sizeUp'), Bench.histVal(s.slice(0, 10), 'sizeUp')], [20, 40, null]);
});
t('at most one snapshot a week; about 26 weeks are kept', () => {
  let L = [];
  for (let w = 0; w < 30; w++) for (const extra of [0, 2 * DAY]) L = Bench.histPush(L, Bench.histSnap(sumOf(0, w), T0 + w * WEEK + extra)).list;
  eq(L.length, 26, 'two a week offered, one a week kept, the oldest four gone');
  eq(L[0][0], Bench.weekOf(T0) + 4); eq(L[25][0], Bench.weekOf(T0) + 29);
  eq(Bench.histPush(L, Bench.histSnap(sumOf(0, 0), T0)).added, false, 'an older week never goes in after a newer one');
  eq(Bench.histTrim(L, Bench.weekOf(T0) + 60), [], 'nothing left once it is all older than 26 weeks');
});
t('slip rates: share of trading days with each slip over 4 weeks, nothing under 5 days', () => {
  eq(Bench.slipRates(daysOf(0, 0, T0), T0).sizeUp, 40);
  eq(Bench.slipRates(daysOf(0, 9, T0), T0).sizeUp, 0);
  eq(Bench.slipRates(daysOf(0, 0, T0).slice(0, 4), T0), null);
  eq(Bench.slipRates(daysOf(0, 0, T0 - 60 * DAY), T0), null, 'days older than 4 weeks don’t count');
});

console.log('\nWho improved, and what changed');
const world = (N, last, o = {}) => Array.from({ length: N }, (_, i) => { let h = [];
  for (let w = 0; w <= last; w++) { const at = T0 + w * WEEK; h = Bench.histPush(h, Bench.histSnap(o.sum ? o.sum(i, w) : sumOf(i, w), at, o.slips === false ? null : Bench.slipRates(daysOf(i, w, at), at))).list; }
  return { dims: { style: 'day', size: 's2', exp: 'e2', act: 'a2' }, hist: h }; });
const groups = { all: { dims: {}, n: 24 }, 'style=day': { dims: { style: 'day' }, n: 24 }, 'style=swing': { dims: { style: 'swing' }, n: 30 } };
const AT = T0 + 10 * WEEK;
t('bottom half to top half on Discipline over 8–12 weeks: 8 improvers against 16 others', () => {
  const I = Bench.buildImprovers(world(24, 10), { groups }, { min: 10 }, AT);
  eq([I.all.panel, I.all.n, I.all.nOthers], [24, 8, 16]);
  eq(I['style=swing'], { panel: 0, n: 0, nOthers: 0, changes: [], why: 'history' }, 'a group nobody here belongs to');
});
t('medians of the changes, ranked by effect size, in plain words', () => {
  const C = Bench.buildImprovers(world(24, 10), { groups }, { min: 10 }, AT).all.changes, by = Object.fromEntries(C.map(c => [c.metric, c]));
  eq(C.map(c => c.metric).sort(), ['jour', 'rev', 'sizeUp', 'tw'], 'what didn’t differ (win rate, fees, hold…) isn’t listed');
  for (let i = 1; i < C.length; i++) ok(Math.abs(C[i - 1].effect) >= Math.abs(C[i].effect), 'biggest effect first');
  eq([by.tw.improversDelta, by.tw.othersDelta, by.tw.unit, by.tw.n, by.tw.nOthers], [-40, 0, 'pct', 8, 16]);
  eq(by.tw.text, 'They cut trades per week by about 40%');
  eq([by.rev.improversDelta, by.rev.from, by.rev.to], [-9.5, 10, 0.5]); eq(by.rev.text, 'They stopped re-entering within 15 minutes of a loss');
  eq([by.jour.improversDelta, by.jour.othersDelta], [20, 0]); eq(by.jour.text, 'They journaled 3× more');
  eq([by.sizeUp.improversDelta, by.sizeUp.othersDelta], [-40, 0]); eq(by.sizeUp.text, 'They stopped sizing up right after a loss');
  eq(Object.keys(by.tw).sort(), ['effect', 'from', 'improversDelta', 'label', 'metric', 'n', 'nOthers', 'othersDelta', 'text', 'to', 'unit']);
});
t('wording for the other directions, and for holding steady while the others moved', () => {
  eq(Bench.impText('tw', 25, 0), 'They traded about 25% more often');
  eq(Bench.impText('tw', 2, 40), 'Trades per week stayed about the same for them, while the others traded about 40% more often');
  eq(Bench.impText('jour', 8, 0, 20, 28), 'They journaled about 8 more of every 100 trades');
  eq(Bench.impText('rev', -4, 0, 9, 5), 'They re-entered within 15 minutes of a loss less often (about 4 fewer in every 100 trades)');
  eq(Bench.impText('hold', -30, 0), 'They closed their trades about 30% sooner');
  eq(Bench.impText('wr', 6.4, 0), 'They raised their win rate by about 6 points');
});
t('too little history, too few improvers, or a change measured for under 5: nothing is reported', () => {
  eq(Bench.buildImprovers(world(24, 6), { groups }, { min: 10 }, T0 + 6 * WEEK).all.why, 'history', 'only 6 weeks so far');
  eq(Bench.buildImprovers(world(24, 10), { groups }, { min: 25 }, AT).all, { panel: 24, n: 0, nOthers: 0, changes: [], why: 'history' }, 'a panel under `min`');
  eq(Bench.buildImprovers(world(24, 13), { groups }, { min: 10 }, T0 + 13 * WEEK).all.n, 8, '8–12 weeks back still finds the start');
  eq(Bench.buildImprovers(world(24, 10), { groups }, { min: 10 }, AT + 5 * WEEK).all.why, 'history', 'a history that stopped weeks ago isn’t current');
  const few = Bench.buildImprovers(world(24, 10, { sum: (i, w) => sumOf(i >= 4 && i < 8 ? 8 + (i % 4) : i, w) }), { groups }, { min: 10 }, AT).all;
  eq([few.n, few.why, few.changes], [4, 'few', []], '4 improvers: too few to compare');
  const noSlips = Bench.buildImprovers(world(24, 10).map((e, i) => i < 4 ? e : { dims: e.dims, hist: e.hist.map(s => s.slice(0, 10)) }), { groups }, { min: 10 }, AT).all;
  ok(noSlips.n === 8 && !noSlips.changes.some(c => c.metric === 'sizeUp'), 'slips known for only 4 improvers (seeds have none): left out');
});

console.log('\nIn the app: each change maps to a habit, and its numbers read plainly');
{ const habits = [];
  const { peerImpHabit, peerImpHas, peerImpFmt, peerImpTip } = await makeExtractor(readAppSource(htmlPath)).evalModule(['peerImpHabit', 'peerImpHas', 'peerImpFmt', 'peerImpTip'], null, 'const habitsList = () => globalThis.__H;');
  globalThis.__H = habits;
  t('“Make it my habit” picks a leak to plug, a library habit, or a written one', () => {
    eq(peerImpHabit({ metric: 'tw', improversDelta: -40 }), { slip: 'overtrade' });
    eq(peerImpHabit({ metric: 'rev', improversDelta: -9 }), { slip: 'revenge' });
    eq(peerImpHabit({ metric: 'jour', improversDelta: 20 }), { tpl: 'journal-all' });
    eq(peerImpHabit({ metric: 'sizeUp', improversDelta: -40 }), { slip: 'sizeUp' });
    eq(peerImpHabit({ metric: 'fees', improversDelta: -5 }), { tpl: 'maker-half' }, 'the maker-share habit, checked from fills');
    eq(peerImpHabit({ metric: 'tw', improversDelta: 30 }), null, 'trading more isn’t offered as a habit');
    ok(!peerImpHas({ slip: 'revenge' })); habits.push({ kind: 'slip', slip: 'revenge' }, { tpl: 'journal-all' });
    ok(peerImpHas({ slip: 'revenge' }) && peerImpHas({ tpl: 'journal-all' }) && !peerImpHas({ slip: 'overtrade' }), 'already in your habits');
  });
  t('the tooltip has both medians and how many each covers', () => {
    const c = { metric: 'tw', label: 'Trades per week', unit: 'pct', improversDelta: -40, othersDelta: 2, n: 8, nOthers: 16 };
    eq(peerImpTip(c), 'Trades per week\nTraders who improved: −40% (median of 8)\nThe others: +2% (median of 16)\nChange over 8 to 12 weeks');
    eq([peerImpFmt({ unit: 'pts' }, -9.54), peerImpFmt({ unit: 'x' }, 0.3), peerImpFmt({ unit: 'pct' }, 0)], ['−9.5 pts', '+0.30', '0%']);
  });
}

console.log('\nThe API, leaving and switching off');
const W = c => '0x' + c.repeat(40);
const fl = (side, sz, px, start, pnl, ms, i) => ({ coin: 'ETH', side, sz: String(sz), px: String(px), startPosition: String(start), closedPnl: String(pnl), fee: '0.5', crossed: true, time: ms, tid: i, oid: i });
let T = T0;
const fetchImpl = async (url, o) => { const b = JSON.parse(o.body), u = String(b.user || '').toLowerCase();
  if (b.type !== 'userFillsByTime' || u !== W('1')) return { ok: true, status: 200, json: async () => [] };
  const F = []; for (let i = 0; i < 40; i++) { const t0 = T - (i + 1) * DAY; F.push(fl('B', 10, 100, 0, 0, t0, 2 * i + 1), fl('A', 10, i % 3 ? 102 : 99, 10, i % 3 ? 20 : -10, t0 + 2 * 3600e3, 2 * i + 2)); }
  return { ok: true, status: 200, json: async () => F.filter(f => f.time >= (b.startTime || 0)) }; };
const dataDir = mkdtempSync(join(tmpdir(), 'ledger-improvers-'));
const app = server.createApp({ dataDir, auth: 'owner-token', htmlPath, fetchImpl, now: () => T, push: false, pushTick: false, offsiteTimer: false, seedDelay: 0, trustProxy: true });
const B = await new Promise(res => app.listen(0, () => res('http://127.0.0.1:' + app.address().port)));
const S = () => app._social.state();
const call = async (p, o = {}) => { const r = await fetch(B + '/api/social' + p, { method: o.method || 'GET',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': o.ip || '10.0.0.1', ...(o.key ? { 'X-Pulse-Key': o.key } : {}), ...(o.owner ? { Authorization: 'Bearer owner-token' } : {}) },
    body: o.body !== undefined ? JSON.stringify(o.body) : undefined });
  return { status: r.status, d: await r.json().catch(() => ({})) }; };
const rebuild = () => call('/admin/bench', { method: 'POST', owner: true, body: { action: 'rebuild' } });
const waitFor = async (f, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await f()) return true; await new Promise(r => setTimeout(r, 20)); } return false; };
const keys = [], ids = [], Q = '/bench?style=day&size=s2&exp=e2&act=a2';
try {
  await t('a week at a time: every counted summary gets one snapshot a week, seed wallets too', async () => {
    await call('/admin/config', { method: 'PUT', owner: true, body: { bench: { min: 10, splitAt: 0 } } });
    for (let i = 0; i < 24; i++) { const r = (await call('/join', { method: 'POST', ip: '10.0.2.' + (i + 1), body: { handle: 'imp' + i } })).d; keys.push(r.key); ids.push(r.me.id); }
    eq((await call('/admin/bench', { method: 'POST', owner: true, body: { action: 'seed', text: W('1') } })).d.added, 1);
    ok(await waitFor(async () => (await call('/admin/bench', { owner: true })).d.seedCounts.ok === 1), 'the seed wallet was read');
    for (let w = 0; w <= 10; w++) { T = T0 + w * WEEK;
      for (let i = 0; i < 24; i++) eq((await call('/stats', { method: 'POST', key: keys[i], body: { xp: 10 + w, days: daysOf(i, w, T), bench: sumOf(i, w) } })).status, 200);
      await rebuild();
      if (w === 3) { await call('/stats', { method: 'POST', key: keys[0], body: { xp: 99, days: daysOf(0, w, T), bench: sumOf(0, w) } }); await rebuild(); } }
    const H = S().benchHist;
    eq(H['m:' + ids[0]].length, 11, 'eleven weeks, one snapshot each (a second sync in week 3 added none)');
    eq(H['m:' + ids[0]][10][10], [0, 0, 0, 0, 0], 'slip rates from the synced days');
    ok(Array.isArray(H['s:' + W('1')]) && H['s:' + W('1')].length >= 1, 'the seed wallet has a history too');
    ok(H['s:' + W('1')].every(s => s.length <= 10), 'and no slips: seeds have no synced days');
  });
  await t('GET /bench carries the improvers of your most specific group: counts, medians and words only', async () => {
    const r = (await call(Q, { key: keys[20] })).d, I = r.improvers;
    eq(Object.keys(I).sort(), ['changes', 'dims', 'key', 'n', 'nOthers', 'note', 'panel', 'weeks']);
    eq([I.key, I.n, I.nOthers, I.panel, I.note], ['style=day|size=s2|exp=e2|act=a2', 8, 16, 24, '']);
    const tw = I.changes.find(c => c.metric === 'tw'); eq([tw.improversDelta, tw.othersDelta, tw.text], [-40, 0, 'They cut trades per week by about 40%']);
    ok(I.changes.some(c => c.text === 'They journaled 3× more') && I.changes.some(c => c.text === 'They stopped re-entering within 15 minutes of a loss'));
    const s = JSON.stringify(I); ok(!/imp\d|m:|0x/.test(s) && !ids.some(id => s.includes(id)), 'no handle, member id or wallet in it');
    eq((await call(Q, { owner: true })).d.improvers.n, 8, 'the owner sees the same');
    const a = (await call('/admin/bench', { owner: true })).d;
    eq(a.groups.find(g => g.key === 'all').imp, '8 of 24 followed 8–12 weeks'); ok(a.improvers.includes('They cut trades per week by about 40%')); eq(a.histFor, 25);
  });
  await t('switching off removes your history at once, and you from the next build', async () => {
    await call('/me', { method: 'PUT', key: keys[0], body: { share: { bench: false } } });
    eq(S().benchHist['m:' + ids[0]], undefined);
    await rebuild(); const I = (await call(Q, { key: keys[5] })).d.improvers; eq([I.panel, I.n], [23, 7]);
    await call('/stats', { method: 'POST', key: keys[0], body: { xp: 200, days: daysOf(0, 10, T), bench: sumOf(0, 10) } }); await rebuild();
    eq(S().benchHist['m:' + ids[0]], undefined, 'a switched-off member’s app syncing again adds nothing');
  });
  await t('members who leave, members removed and seed wallets taken out lose their history', async () => {
    eq((await call('/me', { method: 'DELETE', key: keys[1] })).status, 200); eq(S().benchHist['m:' + ids[1]], undefined);
    S().members[ids[2]].banned = true; await call('/admin/bench', { method: 'POST', owner: true, body: { action: 'remove', which: 'all' } });
    eq([S().benchHist['m:' + ids[2]], S().benchHist['s:' + W('1')]], [undefined, undefined]);
    const I = (await call(Q, { key: keys[5] })).d.improvers; eq([I.panel, I.n, I.nOthers], [21, 5, 16]);
  });
  await t('not enough history or too few improvers: it says so plainly, with no changes', async () => {
    await call('/me', { method: 'PUT', key: keys[3], body: { share: { bench: false } } }); await rebuild();
    const I = (await call(Q, { key: keys[5] })).d.improvers; eq([I.n, I.changes], [4, []]);
    eq(I.note, 'Too few traders like you improved to compare yet: 4 did. It needs at least 5 who improved and 5 who didn’t.');
    T += 13 * WEEK; for (let i = 4; i < 24; i++) await call('/stats', { method: 'POST', key: keys[i], body: { xp: 300, bench: sumOf(i, 10) } }); await rebuild();
    const J = (await call(Q, { key: keys[5] })).d.improvers; eq(J.changes, []);
    ok(/^Not enough history yet: it needs 10 traders like you followed for 8 to 12 weeks, and \d+ (is|are) so far\.$/.test(J.note), J.note);
  });
} finally { await new Promise(r => app.close(r)); }

report('improvers');
