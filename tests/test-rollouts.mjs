// Staged rollouts (rollouts.js, Admin → Insights): a feature for a random share of members, fixed by a hash, hidden
// from the rest by the app, and measured by the group each member was dealt (intention to treat).
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { t, ok, eq, report } from './harness.mjs';

const require = createRequire(import.meta.url);
const R = require('../rollouts.js');
const server = require('../server.js');
const htmlPath = new URL('../ledger.html', import.meta.url).pathname;
const r = { id: 'abc', feature: 'drills', share: 30, start: '2026-10-01', end: '2026-10-28' };

t('the owner’s choices are checked', () => {
  eq(R.sanitizeRollout({ feature: 'drills', share: '30', weeks: 4 }), { feature: 'drills', share: 30, weeks: 4 });
  ok(R.sanitizeRollout({ feature: 'nope', share: 50, weeks: 4 }).error); ok(R.sanitizeRollout({ feature: 'eval', share: 99, weeks: 4 }).error); ok(R.sanitizeRollout({ feature: 'eval', share: 50, weeks: 20 }).error);
});
t('groups: fixed for a member, about the share asked, different for another test', () => {
  const ids = Array.from({ length: 4000 }, (_, i) => 'm' + i), on = ids.filter(id => R.inGroup(id, r));
  ok(on.length > 1050 && on.length < 1350, 'about 30%: ' + on.length);
  eq(ids.map(id => R.inGroup(id, r)), ids.map(id => R.inGroup(id, r)), 'the same every time');
  const other = ids.filter(id => R.inGroup(id, Object.assign({}, r, { id: 'xyz' })));
  ok(other.filter(id => on.includes(id)).length < on.length * 0.5, 'a new test deals new groups');
});
t('what a member’s app is told: only tests running today', () => {
  const all = { a: r, b: { id: 'b', feature: 'eval', share: 100, start: '2026-11-01', end: '2026-11-30' }, c: Object.assign({}, r, { id: 'c', feature: 'luck', endedAt: 1 }) };
  eq(Object.keys(R.forMember(all, 'm1', '2026-10-05')), ['drills']);
  eq(R.forMember(all, 'm1', '2026-12-01'), {});
});
t('what it did: each member against their own days before, got it against didn’t, with an interval', () => {
  const day = i => new Date(Date.UTC(2026, 9, 1 + i)).toISOString().slice(0, 10);
  const members = Array.from({ length: 200 }, (_, i) => { const id = 'u' + i, on = R.inGroup(id, r);
    const days = []; for (let d = -10; d < 10; d++) days.push({ k: day(d), s: 60 + (d >= 0 && on ? 8 : 0) + (i % 5) }); return { id, vdays: days }; });
  const E = R.effect(r, members, { now: Date.parse('2026-10-10T12:00:00Z'), iters: 300 });
  eq([E.window.from, E.window.to, E.window.before], ['2026-10-01', '2026-10-10', '2026-09-21']);
  eq([E.on, E.off, E.diff.v, E.sure], [8, 0, 8, true]);
  eq(E.groups.on.n + E.groups.off.n, 200); eq(E.groups.on.verified, E.groups.on.measured);
  const few = R.effect(r, members.slice(0, 4), { now: Date.parse('2026-10-10T12:00:00Z') }); eq(few.diff.v, null, 'too few measured to say');
});
const app = server.createApp({ dataDir: mkdtempSync(join(tmpdir(), 'ledger-rollouts-')), auth: 'owner-token', htmlPath, push: false, pushTick: false, offsiteTimer: false, statsSweep: false, trustProxy: true,
  fetchImpl: async () => ({ ok: true, status: 200, json: async () => [] }) });
const B = await new Promise(res => app.listen(0, () => res('http://127.0.0.1:' + app.address().port)));
let ipN = 0;
const call = async (p, o = {}) => { const res = await fetch(B + '/api/social' + p, { method: o.method || 'GET', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.11.0.' + (++ipN), ...(o.key ? { 'X-Pulse-Key': o.key } : {}), ...(o.owner ? { Authorization: 'Bearer owner-token' } : {}) },
  body: o.body !== undefined ? JSON.stringify(o.body) : undefined }); return { status: res.status, d: await res.json().catch(() => ({})) }; };
try {
  await t('the owner starts one; members are told their group; it ends for everyone', async () => {
    const keys = []; for (let i = 0; i < 12; i++) keys.push((await call('/join', { method: 'POST', body: { handle: 'ro' + i } })).d.key);
    eq((await call('/admin/rollouts', { method: 'POST', key: keys[0], body: { feature: 'luck', share: 50, weeks: 2 } })).status, 401);
    const st = await call('/admin/rollouts', { method: 'POST', owner: true, body: { feature: 'luck', share: 50, weeks: 2 } }); eq(st.status, 200);
    eq((await call('/admin/rollouts', { method: 'POST', owner: true, body: { feature: 'luck', share: 40, weeks: 2 } })).status, 409, 'one test per feature');
    const seen = []; for (const k of keys) seen.push((await call('/me', { key: k })).d.me.rollouts.luck);
    ok(seen.includes(true) && seen.includes(false), JSON.stringify(seen));
    const list = (await call('/admin/rollouts', { owner: true })).d; eq([list.rollouts.length, list.rollouts[0].live, list.rollouts[0].effect.groups.on.n + list.rollouts[0].effect.groups.off.n], [1, true, 12]);
    await call('/admin/rollouts/' + st.d.rollout.id, { method: 'POST', owner: true, body: { action: 'end' } });
    eq((await call('/me', { key: keys[0] })).d.me.rollouts, {});
  });
} finally { await new Promise(res => app.close(res)); }
report('rollouts');
