// The AI coach chat: who may ask (a member within today's allowance, or the owner), what reaches the
// model (the app's summary with wallet addresses scrubbed; trades and notes only when the member
// opted in), and the request shape. The Claude client is a stub — no network, no key.
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { t, ok, eq, report } from './harness.mjs';

const require = createRequire(import.meta.url);
const server = require('../server.js');
const htmlPath = new URL('../ledger.html', import.meta.url).pathname;

console.log('\nRequest');
t('the conversation must end with the trader; old turns drop off; addresses never reach the model', () => {
  const W = '0x' + 'ab'.repeat(20);
  const c = server.sanitizeCoachChat({ messages: [{ role: 'assistant', content: 'hi' }, { role: 'user', content: 'how was my day?' }, { role: 'system', content: 'x' }],
    facts: { today: { discipline: 75 }, wallet: W, note: 'traded on ' + W }, detail: { trades: [{ coin: 'BTC', net: -40 }] } }, false);
  eq(c.messages, [{ role: 'user', content: 'how was my day?' }]);
  ok(!c.facts.includes(W) && c.facts.includes('[wallet]')); eq(c.detail, null, 'no trades unless the member opted in');
  ok(server.sanitizeCoachChat({ messages: [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }] }).error);
  eq(server.sanitizeCoachChat({ messages: [{ role: 'user', content: 'q' }], detail: { trades: [1] } }, true).detail, '{"trades":[1]}');
});
t('request: the coaching prompt is cached, the data comes after it, quick answers, server-side fallback', () => {
  const r = server.coachChatRequest({ messages: [{ role: 'user', content: 'q' }], facts: '{"a":1}', detail: null }, 'claude-opus-5-5');
  eq(r.model, 'claude-opus-5-5'); eq(r.system[0].cache_control, { type: 'ephemeral' }); ok(r.system[1].text.includes('{"a":1}'));
  eq(r.output_config, { effort: 'low' }); eq([r.betas, r.fallbacks], [['server-side-fallback-2026-07-01'], 'default']);
  ok(!('thinking' in r) && !('temperature' in r));
  ok(/Never give trade signals/.test(r.system[0].text));
});

console.log('\nHTTP');
const listen = app => new Promise(res => app.listen(0, () => res('http://127.0.0.1:' + app.address().port)));
const seen = [];
const stub = { beta: { messages: { create: async req => { seen.push(req);
  if (req.messages.at(-1).content === 'refuse') return { stop_reason: 'refusal', content: [] };
  return { model: req.model, stop_reason: 'end_turn', content: [{ type: 'text', text: 'Clean day. Tomorrow: stop after two losses.' }] }; } } } };
const mk = (enabled) => server.createApp({ dataDir: mkdtempSync(join(tmpdir(), 'ledger-coach-')), auth: 'owner-token', htmlPath,
  fetchImpl: async () => ({ ok: true, status: 200, json: async () => [] }), coach: { enabled, client: stub } });
const app = mk(true), B = await listen(app);
const call = async (p, o = {}) => { const r = await fetch(B + p, { method: o.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(o.key ? { 'X-Pulse-Key': o.key } : {}), ...(o.admin ? { Authorization: 'Bearer owner-token' } : {}) },
    body: o.body !== undefined ? JSON.stringify(o.body) : undefined });
  return { status: r.status, d: await r.json() }; };
const ask = (key, content, extra) => call('/api/coach/chat', { method: 'POST', key, body: Object.assign({ messages: [{ role: 'user', content }], facts: { level: 3 } }, extra || {}) });
try {
  let K;
  await t('a member asks within the allowance; each answered message counts', async () => {
    K = (await call('/api/social/join', { method: 'POST', body: { handle: 'asker' } })).d.key;
    await call('/api/social/admin/config', { method: 'PUT', admin: true, body: { coach: { daily: 2 } } });
    eq((await call('/api/coach/chat', { key: K })).d.remaining, 2);
    const r = await ask(K, 'Review my day');
    eq(r.status, 200); eq(r.d.text, 'Clean day. Tomorrow: stop after two losses.'); eq(r.d.remaining, 1);
    eq((await ask(K, 'refuse')).status, 422, 'a refusal is a readable error');
    eq((await call('/api/coach/chat', { key: K })).d.remaining, 1, 'refused messages don’t count');
    await ask(K, 'and tomorrow?');
    const over = await ask(K, 'one more');
    eq(over.status, 429); ok(/today’s 2 coach messages/.test(over.d.error));
  });
  await t('trades and notes go only to members who switched it on, and only if the owner allows it', async () => {
    await call('/api/social/admin/config', { method: 'PUT', admin: true, body: { coach: { daily: 10 } } });
    seen.length = 0; await ask(K, 'q', { detail: { trades: [{ coin: 'ETH' }] } });
    ok(!seen[0].system[1].text.includes('ETH'));
    await call('/api/social/me', { method: 'PUT', key: K, body: { coachDetail: true } });
    seen.length = 0; await ask(K, 'q', { detail: { trades: [{ coin: 'ETH' }] } });
    ok(seen[0].system[1].text.includes('ETH'));
    await call('/api/social/admin/config', { method: 'PUT', admin: true, body: { coach: { detail: false } } });
    seen.length = 0; await ask(K, 'q', { detail: { trades: [{ coin: 'ETH' }] } });
    ok(!seen[0].system[1].text.includes('ETH'));
  });
  await t('the owner asks with the access token; strangers can’t', async () => {
    eq((await call('/api/coach/chat', { method: 'POST', body: { messages: [{ role: 'user', content: 'hi' }] } })).status, 401);
    const o = await call('/api/coach/chat', { method: 'POST', admin: true, body: { messages: [{ role: 'user', content: 'hi' }] } });
    eq(o.status, 200); eq(o.d.limit, null, 'unlimited unless the owner sets a budget');
    eq((await call('/api/coach/chat', { method: 'POST', key: 'nope', body: { messages: [{ role: 'user', content: 'hi' }] } })).status, 401);
  });
  await t('members locked out by the owner, by level, or with the coach off', async () => {
    await call('/api/social/admin/config', { method: 'PUT', admin: true, body: { modules: { coach: 5 } } });
    const r = await ask(K, 'q'); eq(r.status, 429); eq(r.d.error, 'The coach unlocks at level 5.');
    await call('/api/social/admin/config', { method: 'PUT', admin: true, body: { modules: { coach: 1 }, coach: { members: false } } });
    eq((await ask(K, 'q')).status, 429);
  });
} finally { await new Promise(res => app.close(res)); }
await t('parallel requests and time-zone switches can’t get past the daily allowance', async () => {
  let calls = 0;
  const slow = { beta: { messages: { create: async req => { calls++; await new Promise(r => setTimeout(r, 150));
    return { model: req.model, stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] }; } } } };
  const a2 = server.createApp({ dataDir: mkdtempSync(join(tmpdir(), 'ledger-coach-')), auth: 'owner-token', htmlPath,
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => [] }), coach: { enabled: true, client: slow } });
  const b = await listen(a2);
  const h = (key, extra) => ({ 'Content-Type': 'application/json', ...(key ? { 'X-Pulse-Key': key } : {}), ...(extra || {}) });
  try {
    const k = (await (await fetch(b + '/api/social/join', { method: 'POST', headers: h(), body: JSON.stringify({ handle: 'racer' }) })).json()).key;
    await fetch(b + '/api/social/admin/config', { method: 'PUT', headers: h(null, { Authorization: 'Bearer owner-token' }), body: JSON.stringify({ coach: { daily: 2 } }) });
    const ask = () => fetch(b + '/api/coach/chat', { method: 'POST', headers: h(k), body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }) }).then(r => r.status);
    const st = await Promise.all(Array.from({ length: 6 }, ask));
    eq(st.filter(x => x === 200).length, 2, 'only the allowance is answered'); eq(calls, 2, 'the model is only asked twice');
    for (const tz of ['Etc/GMT+12', 'Pacific/Kiritimati', 'Asia/Tokyo']) {
      await fetch(b + '/api/social/stats', { method: 'POST', headers: h(k), body: JSON.stringify({ xp: 10, level: 1, tz }) });
      eq(await ask(), 429, 'a new time zone doesn’t start a new day: ' + tz);
    }
    eq(calls, 2);
  } finally { await new Promise(res => a2.close(res)); }
});
await t('with COACH_AI off the chat says how to switch it on', async () => {
  const off = mk(false), b = await listen(off);
  try { const k = (await (await fetch(b + '/api/social/join', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ handle: 'nobody' }) })).json()).key;
    const r = await fetch(b + '/api/coach/chat', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Pulse-Key': k }, body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }) });
    eq(r.status, 404); ok(/COACH_AI=1/.test((await r.json()).error)); }
  finally { await new Promise(res => off.close(res)); }
});

report('coach-chat');
