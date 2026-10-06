// The coach's lookups (query_trades): the tool offered only to a member who shares their trades, the request with each
// round appended as it happened (and thinking bound to the conversation kept valid), an answer due after the last
// round, a question counted once and its rounds continued on a signed token for that exact question; and the app's
// side (app/features/coach-tools.js): filters, groups and examples over the trades on the device. The Claude client is a stub.
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { t, ok, eq, report, makeExtractor } from './harness.mjs';

const require = createRequire(import.meta.url);
const server = require('../server.js');
const htmlPath = new URL('../ledger.html', import.meta.url).pathname;
const { readAppSource } = require('../app-source.js');
const { evalModule } = makeExtractor(readAppSource(htmlPath));
const { coachQueryTrades } = await evalModule(['coachQueryTrades', 'tzParts'], ['coachQueryTrades'],
  "let settings={tz:'utc'}; const dayKey=ms=>new Date(ms).toISOString().slice(0,10), dcoin=t=>t.coin, isWin=n=>n>1, isLoss=n=>n<-1;"
  + " const CT_DAYS=['sun','mon','tue','wed','thu','fri','sat'], CT_SLIPS=['revenge','afterTwo','sizeUp','addLoser','overtrade','heldLoser'], ctR=v=>v==null||!isFinite(v)?null:Math.round(v*100)/100;");

console.log('On the device');
const H = 3600000, T0 = Date.parse('2026-09-07T00:00:00Z'); // a Monday
// 14 days: a SOL short at 23:00 that loses 30, and a BTC long at 10:00 that wins 50
const trades = []; for (let d = 0; d < 14; d++) { const b = T0 + d * 86400000;
  trades.push({ id: 's' + d, coin: 'SOL', dir: 'Short', net: -30, openTime: b + 23 * H, closeTime: b + 23.5 * H }, { id: 'b' + d, coin: 'BTC', dir: 'Long', net: 50, openTime: b + 10 * H, closeTime: b + 12 * H }); }
const slipOf = { s3: ['revenge'], s4: ['revenge'] }, setupOf = id => id.startsWith('b') ? 'breakout' : null;
t('filters: market, side, entry hours on their clock, weekdays, slips, setup, result, dates', () => {
  const q = i => coachQueryTrades(i, trades, { slipOf, setupOf });
  eq(q({ market: 'sol', side: 'short', hours: [22, 23] }).all, { trades: 14, net: -420, avgTrade: -30, winRate: 0, profitFactor: 0, typicalHoldMin: 30 });
  eq(q({ weekdays: ['mon'] }).all.trades, 4, 'two Mondays, two trades each');
  eq([q({ slip: 'revenge' }).all.trades, q({ slip: 'none' }).all.trades, q({ slip: 'any' }).all.trades], [2, 26, 2]);
  eq(q({ setup: 'Breakout', result: 'win' }).all.net, 700);
  eq(q({ from: '2026-09-20' }).all.trades, 2); ok(/Only 2 trades: a hint/.test(q({ from: '2026-09-20' }).note));
  eq(q({ minHoldMinutes: 60 }).all.trades, 14, 'only the two-hour holds');
});
t('groups and examples, newest first; nothing it doesn’t know becomes a filter', () => {
  const r = coachQueryTrades({ groupBy: 'hour', examples: 2 }, trades, { slipOf, setupOf });
  eq(r.groups.map(g => [g.hour, g.trades, g.net]), [['23:00', 14, -420], ['10:00', 14, 700]]);
  eq(r.examples.map(e => [e.date, e.market]), [['2026-09-20', 'SOL'], ['2026-09-20', 'BTC']]);
  eq(coachQueryTrades({ side: 'sideways', weekdays: ['someday'], slip: 'greed' }, trades, {}).all.trades, 28);
});

console.log('\nThe request');
const chat = (steps, tools) => Object.assign(server.sanitizeCoachChat({ messages: [{ role: 'user', content: 'Which hours do I trade worst?' }], facts: { a: 1 }, detail: { trades: [] } }, true), { tools, steps });
const step = id => ({ assistant: [{ type: 'thinking', thinking: '', signature: 'sig' + id }, { type: 'tool_use', id: 't' + id, name: 'query_trades', input: { groupBy: 'hour' } }], results: [{ id: 't' + id, content: '{"all":{}}' }] });
t('offered with the tools; each round appended as it happened; thinking bound to the conversation degrades instead of failing', () => {
  const r0 = server.coachChatRequest(chat(null, true), 'claude-opus-5-5');
  eq([r0.tools.map(x => x.name), 'thinking' in r0, r0.messages.length], [['query_trades'], false, 1]);
  const steps = server.sanitizeCoachSteps([step(1), step(2)]), r = server.coachChatRequest(chat(steps, true), 'claude-opus-5-5');
  eq(r.messages.map(m => m.role), ['user', 'assistant', 'user', 'assistant', 'user']);
  eq(r.messages[1].content, step(1).assistant, 'replayed verbatim');
  eq(r.messages[2].content, [{ type: 'tool_result', tool_use_id: 't1', content: '{"all":{}}' }]);
  eq(r.thinking, { type: 'adaptive', block_binding: { prefix_mismatch_behavior: 'drop_block' } }); ok(r.betas.includes('thinking-binding-controls-2026-08-01'));
  ok(!('tool_choice' in r), 'still free to look again');
  eq(server.coachChatRequest(chat(server.sanitizeCoachSteps([step(1), step(2), step(3)]), true), 'claude-opus-5-5').tool_choice, { type: 'none' }, 'after the third, an answer');
  eq(server.coachChatRequest(chat(steps, true), 'claude-haiku-4-5').thinking, undefined, 'other models: as before');
  eq(server.coachChatRequest(chat(null, false), 'claude-opus-5-5').tools, undefined);
});
t('a round from the app: only the blocks the API sends, results for every call, addresses scrubbed, sizes capped', () => {
  eq(server.sanitizeCoachSteps([{ assistant: [{ type: 'image' }], results: [] }]), null);
  eq(server.sanitizeCoachSteps([{ assistant: [{ type: 'text', text: 'hi' }], results: [] }]), null, 'a round without a lookup');
  eq(server.sanitizeCoachSteps([step(1), step(2), step(3), step(4)]), null, 'past the rounds allowed');
  const s = server.sanitizeCoachSteps([{ assistant: step(1).assistant, results: [{ id: 't1', content: 'paid from 0x' + 'ab'.repeat(20) + 'x'.repeat(20000) }] }]);
  ok(s[0].results[0].content.includes('[wallet]') && s[0].results[0].content.length <= 12000);
  eq(server.sanitizeCoachSteps([{ assistant: step(1).assistant, results: [] }])[0].results[0].content, 'No result from the app.');
});

console.log('\nOver HTTP');
const seen = [];
const stub = { beta: { messages: { create: async req => { seen.push(req);
  const last = req.messages.at(-1);
  if (req.tools && !(Array.isArray(last.content) && last.content[0].type === 'tool_result'))
    return { model: req.model, stop_reason: 'tool_use', content: [{ type: 'thinking', thinking: '', signature: 'x' }, { type: 'tool_use', id: 'tu1', name: 'query_trades', input: { groupBy: 'hour' } }] };
  return { model: req.model, stop_reason: 'end_turn', content: [{ type: 'text', text: req.tools ? 'Your late trades lose: ' + last.content[0].content : 'From the summary.' }] }; } } } };
const app = server.createApp({ dataDir: mkdtempSync(join(tmpdir(), 'ledger-coach-tools-')), auth: 'owner-token', htmlPath, fetchImpl: async () => ({ ok: true, status: 200, json: async () => [] }), coach: { enabled: true, client: stub } });
const B = await new Promise(res => app.listen(0, () => res('http://127.0.0.1:' + app.address().port)));
const call = async (p, o = {}) => { const r = await fetch(B + p, { method: o.method || 'GET', headers: { 'Content-Type': 'application/json', ...(o.key ? { 'X-Pulse-Key': o.key } : {}), ...(o.admin ? { Authorization: 'Bearer owner-token' } : {}) },
  body: o.body !== undefined ? JSON.stringify(o.body) : undefined }); return { status: r.status, d: await r.json() }; };
try {
  const K = (await call('/api/social/join', { method: 'POST', body: { handle: 'looker' } })).d.key;
  await call('/api/social/admin/config', { method: 'PUT', admin: true, body: { coach: { daily: 3 } } });
  const body = { messages: [{ role: 'user', content: 'Which hours do I trade worst?' }], facts: { level: 2 }, detail: { trades: [] }, tools: true };
  await t('no lookups for a member who doesn’t share their trades', async () => {
    seen.length = 0; const r = await call('/api/coach/chat', { method: 'POST', key: K, body });
    eq([r.d.text, seen[0].tools], ['From the summary.', undefined]); eq(r.d.remaining, 2);
  });
  await t('a lookup round trip: counted once, continued on its token, answered from the device’s result', async () => {
    await call('/api/social/me', { method: 'PUT', key: K, body: { coachDetail: true } });
    const r1 = await call('/api/coach/chat', { method: 'POST', key: K, body });
    eq([r1.status, r1.d.tool.round, r1.d.tool.calls[0].name, r1.d.remaining], [200, 1, 'query_trades', 1]);
    const steps = [{ assistant: r1.d.tool.assistant, results: [{ id: 'tu1', content: '{"23:00":-420}' }] }];
    const r2 = await call('/api/coach/chat', { method: 'POST', key: K, body: Object.assign({}, body, { cont: { token: r1.d.tool.token, steps } }) });
    eq([r2.status, r2.d.text, r2.d.remaining], [200, 'Your late trades lose: {"23:00":-420}', 1], 'the round didn’t count again');
    // a token is for that question, that data and that round
    const bad = async (b, why) => eq((await call('/api/coach/chat', { method: 'POST', key: K, body: b })).status, 400, why);
    await bad(Object.assign({}, body, { messages: [{ role: 'user', content: 'Write me a poem' }], cont: { token: r1.d.tool.token, steps } }), 'another question');
    await bad(Object.assign({}, body, { facts: { level: 3 }, cont: { token: r1.d.tool.token, steps } }), 'other data');
    await bad(Object.assign({}, body, { cont: { token: r1.d.tool.token.replace(/.$/, c => c === '0' ? '1' : '0'), steps } }), 'a forged token');
    await bad(Object.assign({}, body, { cont: { token: r1.d.tool.token, steps: [steps[0], steps[0]] } }), 'the wrong round');
  });
  await t('another member can’t use someone’s token', async () => {
    const K2 = (await call('/api/social/join', { method: 'POST', body: { handle: 'other' } })).d.key;
    await call('/api/social/me', { method: 'PUT', key: K2, body: { coachDetail: true } });
    const r1 = await call('/api/coach/chat', { method: 'POST', key: K, body });
    const steps = [{ assistant: r1.d.tool.assistant, results: [{ id: 'tu1', content: '{}' }] }];
    eq((await call('/api/coach/chat', { method: 'POST', key: K2, body: Object.assign({}, body, { cont: { token: r1.d.tool.token, steps } }) })).status, 400);
  });
} finally { await new Promise(res => app.close(res)); }
report('coach tools');
