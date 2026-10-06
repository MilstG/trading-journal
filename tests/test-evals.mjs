// The evaluation (evals.js, social.js /evals, app/features/evals.js): a prop-firm-style test read from the member's
// account. The rules and their presets, the equity curve from the portfolio's P&L (deposits don't move it), the daily
// loss and drawdown limits failing it at once, the target with trading days and the consistency rule passing it, then
// over HTTP: who can start one, the account at the start, a pass paying its badge once, a breach failing it.
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { t, ok, eq, report } from './harness.mjs';

const require = createRequire(import.meta.url);
const Ev = require('../evals.js');
const server = require('../server.js');
const htmlPath = new URL('../ledger.html', import.meta.url).pathname;
const DAY = 864e5, H = 3600e3;
const T0 = Date.parse('2026-09-01T00:00:00Z');
// a portfolio answer from a P&L function (every 4 hours from T0 to `to`) on a starting account value
const pf = (pnl, to, av0 = 1000) => { const pn = [], av = []; for (let ms = T0; ms <= to; ms += 4 * H) { const v = pnl(ms); pn.push([ms, String(v)]); av.push([ms, String(av0 + v)]); }
  return [['day', { accountValueHistory: av.slice(-6), pnlHistory: pn.slice(-6) }], ['month', { accountValueHistory: av, pnlHistory: pn }], ['allTime', { accountValueHistory: av, pnlHistory: pn }]]; };
const ev = (rules, startAt, startAv) => ({ rules: Ev.sanitizeRules(rules), startAt, endAt: startAt + Ev.sanitizeRules(rules).days * DAY, startAv });

console.log('Rules');
t('a preset by name; numbers changed make it your own; everything clamped', () => {
  eq(Ev.sanitizeRules({ preset: 'sprint' }), Object.assign({ preset: 'sprint' }, (({ label, ...r }) => r)(Ev.PRESETS.sprint)));
  eq(Ev.sanitizeRules({ preset: 'standard', target: 6 }).preset, 'custom');
  const r = Ev.sanitizeRules({ custom: true, days: 500, daily: 0, dd: 99, minDays: 99, consistency: 5 });
  eq([r.days, r.daily, r.dd, r.minDays, r.consistency], [60, 0.5, 60, 60, 10]);
  eq(Ev.sanitizeRules({ consistency: 0 }).consistency, 0, 'off');
  eq(Ev.rulesText(Ev.PRESETS.standard), '+8% target · 5% daily loss · 10% drawdown · 5 trading days · no day over 40% of the profit · 30 days');
});

console.log('\nThe account, read');
t('steady gains: the profit on the account at the start; every day the same, so no day stands out', () => {
  const e = ev({ preset: 'standard' }, T0 + DAY, 1010), at = T0 + 9 * DAY;
  const st = Ev.evalState(e, pf(ms => (ms - T0) / DAY * 10, at), at);
  eq([st.eq, st.profit, st.ddUsed, st.breach], [1090, 7.92, 0, null]);
  ok(st.bestShare > 12 && st.bestShare < 13, 'one day of eight: ' + st.bestShare);
  eq(Ev.evalStatus(e, st, 8, at).st, 'live', '7.92% is short of 8%');
  const st2 = Ev.evalState(e, pf(ms => (ms - T0) / DAY * 10, at + DAY), at + DAY);
  eq(Ev.evalStatus(e, st2, 8, at + DAY), { st: 'passed', why: '+8.91% with 8 trading days' });
  eq(Ev.evalStatus(e, st2, 3, at + DAY).st, 'live', 'the target alone isn’t enough: 3 of 5 trading days');
});
t('a day that loses past the daily limit fails it at once, even when the day ends better', () => {
  const e = ev({ preset: 'standard' }, T0, 1000), dip = T0 + 2 * DAY + 8 * H, at = T0 + 4 * DAY;
  const st = Ev.evalState(e, pf(ms => ms === dip ? -60 : 0, at), at);
  eq([st.breach.why, st.breach.k, st.breach.pct], ['daily', '2026-09-03', 6]);
  eq(Ev.evalStatus(e, st, 3, at).st, 'failed'); ok(/Lost 6% of the starting account in a day/.test(Ev.evalStatus(e, st, 3, at).why));
});
t('drawdown: from the start, or trailing from the high', () => {
  // up 100 over four days, then down 90 over five (18 a day: under the 5% daily limit)
  const f = ms => { const d = (ms - T0) / DAY; return d <= 4 ? d * 25 : Math.max(10, 100 - (d - 4) * 18); }, at = T0 + 10 * DAY;
  const fixed = Ev.evalState(ev({ custom: true, dd: 8, daily: 5, trail: false }, T0, 1000), pf(f, at), at);
  eq([fixed.breach, fixed.ddUsed], [null, 0], 'never below the start');
  const trail = Ev.evalState(ev({ custom: true, dd: 8, daily: 5, trail: true }, T0, 1000), pf(f, at), at);
  eq(trail.breach.why, 'dd'); ok(trail.breach.pct >= 8);
});
t('consistency: reaching the target on one big day isn’t a pass; time running out ends it', () => {
  const e = ev({ preset: 'standard' }, T0, 1000), at = T0 + 5 * DAY + 12 * H, big = T0 + 5 * DAY;
  const st = Ev.evalState(e, pf(ms => ms >= big ? 90 : (ms - T0) / DAY * 2, at), at);
  ok(st.profit >= 8 && st.bestShare > 40, JSON.stringify([st.profit, st.bestShare]));
  eq(Ev.evalStatus(e, st, 6, at).st, 'live');
  eq(Ev.evalStatus(e, st, 6, e.endAt + 1).why, 'Reached the target, but one day made ' + st.bestShare + '% of the profit (the rule is 40%)');
});
t('the account at the start: the last reading at or before it', () => {
  eq(Ev.accountAt(pf(ms => (ms - T0) / DAY * 10, T0 + 3 * DAY), T0 + DAY + H), 1010);
  eq(Ev.accountAt([], T0), null);
});

console.log('\nOver HTTP');
let clock = T0 + DAY + H; const A = i => '0x' + String(i).repeat(40), SERIES = {};
const fetchImpl = async (url, o) => { let b = {}; try { b = JSON.parse(o.body); } catch (e) {}
  const f = b.type === 'portfolio' && SERIES[String(b.user).toLowerCase()];
  return { ok: true, status: 200, json: async () => f ? pf(f.pnl, clock, f.av0) : [] }; };
// every day from Sep 1 is a trading day with 3 trades
const behaviorFor = async () => Array.from({ length: 40 }, (_, i) => ({ k: new Date(T0 + i * DAY).toISOString().slice(0, 10), s: 90, n: i * DAY + T0 <= clock ? 3 : 0, f: [] })).filter(d => d.n);
const app = server.createApp({ dataDir: mkdtempSync(join(tmpdir(), 'ledger-evals-')), auth: 'owner-token', htmlPath, now: () => clock, push: false, pushTick: false, offsiteTimer: false, trustProxy: true, statsSweep: false, fetchImpl, behaviorFor });
const B = await new Promise(res => app.listen(0, () => res('http://127.0.0.1:' + app.address().port)));
let ipN = 0;
const call = async (p, o = {}) => { const r = await fetch(B + '/api/social' + p, { method: o.method || 'GET',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.9.0.' + (++ipN), ...(o.key ? { 'X-Pulse-Key': o.key } : {}), ...(o.owner ? { Authorization: 'Bearer owner-token' } : {}) },
    body: o.body !== undefined ? JSON.stringify(o.body) : undefined });
  return { status: r.status, d: await r.json().catch(() => ({})) }; };
const until = async (f, ms = 4000) => { const end = Date.now() + ms; for (;;) { const v = await f(); if (v || Date.now() > end) return v; await new Promise(r => setTimeout(r, 40)); } };
const K = {};
const join_ = async (h, i, series, share) => { if (series) SERIES[A(i)] = series;
  K[h] = (await call('/join', { method: 'POST', body: { handle: h, address: i ? A(i) : undefined, share: Object.assign({ verify: true, feed: true }, share) } })).d.key; };
try {
  await call('/admin/config', { method: 'PUT', owner: true, body: { requireClaim: false, unlocksOn: false, standing: { on: false } } });
  await join_('ann', 1, { pnl: ms => (ms - T0) / DAY * 10 }); await join_('bob', 2, { pnl: ms => ms >= T0 + 3 * DAY ? -70 : 0 });
  await join_('cat', 0); await join_('dee', 4, { pnl: () => 0, av0: 50 }); await join_('eve', 5, { pnl: () => 0 }, { verify: false });
  await t('who can start one: a wallet, verified trading days, an account worth testing', async () => {
    eq((await call('/evals', { key: K.cat })).d.can, 'Add a wallet first: the evaluation is read from your account.');
    ok(/Verify my discipline/.test((await call('/evals', { key: K.eve })).d.can));
    const r = await call('/evals', { method: 'POST', key: K.dee, body: { preset: 'standard' } }); eq(r.status, 409); ok(/at least \$100/.test(r.d.error), r.d.error);
    eq((await call('/evals')).status, 401);
  });
  let annId, bobId;
  await t('starting reads the account now; one at a time', async () => {
    const r = await call('/evals', { method: 'POST', key: K.ann, body: { preset: 'standard' } }); eq(r.status, 200, JSON.stringify(r.d));
    annId = r.d.eval.id; eq([r.d.eval.st, r.d.eval.startAv, r.d.eval.rules.preset], ['live', 1010, 'standard']);
    eq((await call('/evals', { method: 'POST', key: K.ann, body: { preset: 'sprint' } })).status, 409);
    bobId = (await call('/evals', { method: 'POST', key: K.bob, body: { preset: 'standard' } })).d.eval.id;
  });
  await t('a breach between readings fails it, and says why', async () => {
    clock = T0 + 4 * DAY;
    const e = await until(async () => { const x = (await call('/evals', { key: K.bob })).d.mine.find(y => y.id === bobId); return x.st !== 'live' ? x : null; });
    eq(e.st, 'failed'); ok(/Lost 7% of the starting account in a day/.test(e.why), e.why);
    ok((await call('/evals', { key: K.bob })).d.can, 'and the next waits a day');
  });
  await t('reaching the target with the trading days in passes it: the badge and its XP, once', async () => {
    clock = T0 + 10 * DAY;
    const e = await until(async () => { const x = (await call('/evals', { key: K.ann })).d.mine.find(y => y.id === annId); return x.st !== 'live' ? x : null; });
    eq(e.st, 'passed', JSON.stringify(e)); ok(e.prog.tradingDays >= 5);
    const b = (await call('/admin/badges', { owner: true })).d.badges.find(x => x.id === 'eval-standard'); eq([b.xp, b.earned], [300, 1]);
    const d = (await call('/evals', { key: K.ann })).d; eq(d.passed.map(p => [p.handle, p.preset, p.profit]), [['ann', 'standard', null]], 'profit stays hidden without % return shared');
  });
  await t('stopping one: only your own, only while it runs', async () => {
    clock += 2 * DAY;
    const id = (await call('/evals', { method: 'POST', key: K.ann, body: { custom: true, rules: { custom: true, target: 3, daily: 4, dd: 8, minDays: 2, consistency: 0, days: 7 } } })).d.eval.id;
    eq((await call('/evals/' + id, { method: 'POST', key: K.bob, body: { action: 'abandon' } })).status, 404);
    eq((await call('/evals/' + id, { method: 'POST', key: K.ann, body: { action: 'abandon' } })).d.eval.st, 'abandoned');
    eq((await call('/evals/' + id, { method: 'POST', key: K.ann, body: { action: 'abandon' } })).status, 409);
  });
  await t('the owner’s switch and settings', async () => {
    eq((await call('/admin/config', { method: 'PUT', owner: true, body: { evals: { xp: 9999 } } })).status, 400);
    await call('/admin/config', { method: 'PUT', owner: true, body: { evals: { on: false } } });
    eq((await call('/evals', { key: K.dee })).d.can, 'Evaluations are switched off on this server.');
    eq((await call('/config')).d.evals, { on: false, xp: 300 });
  });
} finally { await new Promise(r => app.close(r)); }
report('evals');
