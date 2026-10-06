// Relying less on what the app reports: a focus habit the server can check from the wallet's fills (plugging a slip,
// a trade cap) pays its XP on a verified day only when the fills agree it was kept (social.js xplDay, the app's
// xpLog.f). Other focus habits, and days the server didn't read, are paid as the app reports them, as before.
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { t, ok, eq, report } from './harness.mjs';

const require = createRequire(import.meta.url);
const server = require('../server.js');
const Soc = require('../social.js');
const htmlPath = new URL('../ledger.html', import.meta.url).pathname;
const A = h => '0x' + h.repeat(40);
const clock = Date.parse('2026-10-07T15:00:00Z');
// the wallet as the server reads it: Oct 5 had a revenge entry and 6 trades; Oct 6 was clean with 2
const VD = { [A('b')]: [{ k: '2026-10-05', s: 67, n: 6, f: ['revenge'] }, { k: '2026-10-06', s: 100, n: 2 }] };
const app = server.createApp({ dataDir: mkdtempSync(join(tmpdir(), 'ledger-focusv-')), auth: 'owner-token', htmlPath, now: () => clock, push: false, pushTick: false, offsiteTimer: false, trustProxy: true,
  behaviorFor: async a => VD[a] || [], fetchImpl: async () => ({ ok: true, status: 200, json: async () => [] }) });
const B = await new Promise(res => app.listen(0, () => res('http://127.0.0.1:' + app.address().port)));
let ipN = 0;
const call = async (p, o = {}) => { const r = await fetch(B + '/api/social' + p, { method: o.method || 'GET', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': '10.12.0.' + (++ipN),
  ...(o.key ? { 'X-Pulse-Key': o.key } : {}), ...(o.owner ? { Authorization: 'Bearer owner-token' } : {}) }, body: o.body !== undefined ? JSON.stringify(o.body) : undefined });
  return { status: r.status, d: await r.json().catch(() => ({})) }; };
const until = async (f, ms = 4000) => { const end = Date.now() + ms; for (;;) { const v = await f(); if (v || Date.now() > end) return v; await new Promise(r => setTimeout(r, 30)); } };

t('the app’s claim is checked in shape: a checkable habit, its XP within the day’s extra', () => {
  const s = Soc.sanitizeStats({ tz: 'UTC', xpLog: { '2026-10-05': { s: 70, e: 25, f: { k: 'slip', x: 'revenge', p: 25 } }, '2026-10-06': { e: 10, f: { k: 'slip', x: 'greed', p: 10 } }, '2026-10-04': { e: 5, f: { k: 'cap', x: 3, p: 99 } } } },
    { todayOf: () => '2026-10-07', keepDays: 60 });
  eq(s.xpLog['2026-10-05'].f, { k: 'slip', x: 'revenge', p: 25 }); eq(s.xpLog['2026-10-06'].f, undefined, 'not a slip'); eq(s.xpLog['2026-10-04'].f, { k: 'cap', x: 3, p: 5 }, 'never more than the extra it sits in');
});
try {
  await call('/admin/config', { method: 'PUT', owner: true, body: { requireClaim: false, unlocksOn: false, standing: { on: false } } });
  await t('a verified day pays a checkable focus habit only when the fills agree', async () => {
    const k = (await call('/join', { method: 'POST', body: { handle: 'bob', address: A('b'), share: { verify: true } } })).d.key;
    await until(async () => { const m = (await call('/me', { key: k })).d.me; return m && m.ledger && m.ledger.verified > 0; });
    const post = log => call('/stats', { method: 'POST', key: k, body: { tz: 'UTC', xpLog: log } });
    const base = { '2026-10-05': { s: 67 }, '2026-10-06': { s: 100 } };
    const r0 = (await post(base)).d;
    // plugging revenge entries: claimed kept both days; the fills had one on Oct 5
    const r1 = (await post({ '2026-10-05': { s: 67, e: 25, f: { k: 'slip', x: 'revenge', p: 25 } }, '2026-10-06': { s: 100, e: 25, f: { k: 'slip', x: 'revenge', p: 25 } } })).d;
    eq(r1.xp - r0.xp, 25, 'Oct 6 pays; Oct 5 doesn’t: the fills show a revenge entry');
    // a cap of 3 trades: Oct 5 had 6
    const r2 = (await post({ '2026-10-05': { s: 67, e: 25, f: { k: 'cap', x: 3, p: 25 } }, '2026-10-06': { s: 100, e: 25, f: { k: 'cap', x: 3, p: 25 } } })).d;
    eq(r2.xp - r0.xp, 25);
    // a habit the server can't check (a journal habit) is paid as the app reports it
    const r3 = (await post({ '2026-10-05': { s: 67, e: 25 }, '2026-10-06': { s: 100, e: 25 } })).d;
    eq(r3.xp - r0.xp, 50);
  });
} finally { await new Promise(r => app.close(r)); }
report('focus verify');
