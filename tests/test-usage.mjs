// What gets used in Daruma: marks counted on the device (app/features/usage.js), sent with the stats, kept 35 days
// per member, and shown to the owner as totals across members only (insights.js usageTable, GET /admin/usage).
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { t, ok, eq, report, makeExtractor } from './harness.mjs';

const require = createRequire(import.meta.url);
const I = require('../insights.js');
const server = require('../server.js');
const htmlPath = new URL('../ledger.html', import.meta.url).pathname;
const { readAppSource } = require('../app-source.js');
const { evalModule } = makeExtractor(readAppSource(htmlPath));
const { useMark } = await evalModule(['useMark'], ['useMark'], "const useKey=s=>String(s||'').toLowerCase().replace(/[^a-z0-9:_-]/g,'').slice(0,40);");

t('on the device: a screen or card once a day, presses counted', () => {
  const S = {};
  useMark(S, '2026-10-01', 'o', 'tab:Today'); useMark(S, '2026-10-01', 'o', 'tab:today'); useMark(S, '2026-10-01', 's', 'card:tilt');
  useMark(S, '2026-10-01', 'a', 'card:tilt', true); useMark(S, '2026-10-01', 'a', 'card:tilt', true);
  eq(S, { '2026-10-01': { o: ['tab:today'], s: ['card:tilt'], a: { 'card:tilt': 2 } } });
});
t('on the server: only well-formed keys and days, at most 14 days sent and 35 kept', () => {
  const u = I.sanitizeUse({ '2026-10-01': { o: ['tab:today', 'evil key', 'tab:x'.repeat(30)], s: ['card:tilt'], a: { 'card:tilt': 3.4, 'x:y': 2, 'tab:data': -1 } }, nope: {} });
  eq(u, { '2026-10-01': { o: ['tab:today'], s: ['card:tilt'], a: { 'card:tilt': 3 } } });
  const many = {}; for (let i = 0; i < 40; i++) many[new Date(Date.UTC(2026, 8, 1 + i)).toISOString().slice(0, 10)] = { o: ['tab:today'] };
  eq(Object.keys(I.sanitizeUse(many)).length, 14);
  let kept = {}; for (let i = 0; i < 40; i++) kept = I.mergeUse(kept, { [new Date(Date.UTC(2026, 8, 1 + i)).toISOString().slice(0, 10)]: { o: [], s: [], a: {} } });
  eq(Object.keys(kept).length, 35);
});
t('totals across members: reach, who acted, the bottom third flagged', () => {
  const now = Date.parse('2026-10-05T12:00:00Z');
  const ms = [{ id: 'a', use: { '2026-10-04': { o: ['tab:today', 'tab:data'], s: ['card:tilt', 'card:luck'], a: { 'card:tilt': 2, 'tab:data': 1 } } } },
    { id: 'b', use: { '2026-10-03': { o: ['tab:today'], s: ['card:tilt'], a: { 'card:tilt': 1 } } } }, { id: 'c', use: { '2026-08-01': { o: ['tab:drills'] } } }, { id: 'd' }];
  const U = I.usageTable(ms, { days: 30, now });
  eq(U.active, 2, 'c is outside the window');
  eq(U.rows.map(r => [r.key, r.opened, r.acted, r.presses, r.reach]), [['card:tilt', 2, 2, 3, 100], ['tab:data', 1, 1, 1, 50], ['tab:today', 2, 0, 0, 100], ['card:luck', 1, 0, 0, 50]]);
  eq(U.rows.filter(r => r.low).map(r => r.key), [], 'fewer than three of a kind: nothing to flag');
  const more = I.usageTable(ms.concat([{ id: 'e', use: { '2026-10-04': { s: ['card:week', 'card:tilt'], a: { 'card:week': 1 } } } }]), { days: 30, now });
  eq(more.rows.filter(r => r.low).map(r => r.key), ['card:luck'], 'of three cards, the one nobody pressed');
  ok(!JSON.stringify(U).includes('"a"') && !JSON.stringify(U).includes('"b"'), 'no member in it');
});
const app = server.createApp({ dataDir: mkdtempSync(join(tmpdir(), 'ledger-usage-')), auth: 'owner-token', htmlPath, push: false, pushTick: false, offsiteTimer: false, statsSweep: false, now: () => Date.parse('2026-10-05T12:00:00Z'),
  fetchImpl: async () => ({ ok: true, status: 200, json: async () => [] }) });
const B = await new Promise(res => app.listen(0, () => res('http://127.0.0.1:' + app.address().port)));
const call = async (p, o = {}) => { const r = await fetch(B + '/api/social' + p, { method: o.method || 'GET', headers: { 'Content-Type': 'application/json', ...(o.key ? { 'X-Pulse-Key': o.key } : {}), ...(o.owner ? { Authorization: 'Bearer owner-token' } : {}) },
  body: o.body !== undefined ? JSON.stringify(o.body) : undefined }); return { status: r.status, d: await r.json().catch(() => ({})) }; };
try {
  await t('sent with the stats; the owner sees totals; members can’t', async () => {
    const k = (await call('/join', { method: 'POST', body: { handle: 'user1' } })).d.key;
    await call('/stats', { method: 'POST', key: k, body: { tz: 'UTC', use: { '2026-10-04': { o: ['tab:today', 'tab:eval'], s: ['card:eval'], a: { 'card:eval': 1 } } } } });
    const U = (await call('/admin/usage?days=7', { owner: true })).d;
    eq([U.days, U.active, U.rows.find(r => r.key === 'card:eval').acted], [7, 1, 1]);
    eq((await call('/admin/usage', { key: k })).status, 401);
  });
} finally { await new Promise(r => app.close(r)); }
report('usage');
