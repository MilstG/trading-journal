// A member whose standing lapsed is off the leaderboards, and so off everything a board ranks: the weekly
// promotion, a season's podium and a league's top five (the fourth audit, AUDIT-4: X6). Repro from the audit.
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { t, ok, eq, report, xpLogFor } from './harness.mjs';

const require = createRequire(import.meta.url);
const server = require('../server.js');
const htmlPath = new URL('../ledger.html', import.meta.url).pathname;
let clock = Date.parse('2026-10-01T12:00:00Z'); // a Thursday (2026-W40)
const dataDir = mkdtempSync(join(tmpdir(), 'ledger-lapsed-'));
const app = server.createApp({ dataDir, auth: 'owner-token', htmlPath, now: () => clock, push: false, pushTick: false, offsiteTimer: false, trustProxy: true,
  fetchImpl: async () => ({ ok: true, status: 200, json: async () => [] }) });
const B = await new Promise(res => app.listen(0, () => res('http://127.0.0.1:' + app.address().port)));
let ipN = 0;
const call = async (p, o = {}) => { const r = await fetch(B + '/api/social' + p, { method: o.method || 'GET',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': o.ip || '10.0.0.1', ...(o.key ? { 'X-Pulse-Key': o.key } : {}), ...(o.owner ? { Authorization: 'Bearer owner-token' } : {}) },
    body: o.body !== undefined ? JSON.stringify(o.body) : undefined });
  return { status: r.status, d: await r.json().catch(() => ({})) }; };
const K = {};
const join_ = async h => { const r = await call('/join', { method: 'POST', ip: '10.0.9.' + (++ipN), body: { handle: h } }); if (!r.d.key) throw new Error(JSON.stringify(r)); return (K[h] = r.d.key); };
const idOf = async h => (await call('/admin/members', { owner: true })).d.members.find(m => m.handle === h).id;
const xp = (h, day, n) => call('/stats', { method: 'POST', key: K[h], body: { tz: 'UTC', xpLog: xpLogFor(n, day) } }); // one day's parts, adding up to n
const top = async () => (await call('/leagues/main', { key: K.amy })).d.league.top.map(r => r.handle);

try {
  await call('/admin/config', { method: 'PUT', owner: true, body: { requireClaim: false, unlocksOn: false } }); // standing on, as by default
  await call('/admin/leagues/main', { method: 'PUT', owner: true, body: { season: 'month' } });
  for (const h of ['lazy', 'amy', 'ben', 'cal', 'dov']) await join_(h);
  // everyone but lazy is fully unlocked (never locked); lazy has no verified wallet, so lapses after 14 days
  for (const h of ['amy', 'ben', 'cal', 'dov']) await call('/admin/members/' + await idOf(h), { method: 'POST', owner: true, body: { action: 'unlock' } });
  for (const [h, n] of [['lazy', 800], ['amy', 500], ['ben', 400], ['cal', 300], ['dov', 200]]) await xp(h, '2026-10-01', n);

  await t('before the lapse: on the boards like anyone', async () => {
    eq((await top())[0], 'lazy');
  });
  await t('lapsed: never promoted at the rollover (ranked as 0), and off a league’s top five', async () => {
    clock = Date.parse('2026-10-16T12:00:00Z');
    eq((await call('/me', { key: K.lazy })).d.me.standing.state, 'lapsed');
    eq([(await call('/me', { key: K.lazy })).d.tier, (await call('/me', { key: K.amy })).d.tier], [0, 1], 'the most XP in Bronze, but amy moves up');
    await xp('lazy', '2026-10-16', 800); await xp('amy', '2026-10-16', 100);
    const t5 = await top(); ok(!t5.includes('lazy'), JSON.stringify(t5)); eq(t5[0], 'amy');
    ok(!(await call('/league', { key: K.amy })).d.rows.some(r => r.handle === 'lazy'), 'as on the league table');
  });
  await t('lapsed: off a season’s podium', async () => {
    clock = Date.parse('2026-11-02T09:00:00Z');
    const hall = (await call('/leagues/main', { key: K.amy })).d.league.hall;
    eq(hall[0].podium.map(p => p.handle), ['amy', 'ben', 'cal']);
    ok(!(await call('/me', { key: K.lazy })).d.me.awards.some(a => /^season-/.test(a.id)), 'no season badge');
  });
} finally { await new Promise(r => app.close(r)); }

report('lapsed standing and boards');
