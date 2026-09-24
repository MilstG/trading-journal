// Webhook alert derivation (scheduled refresh + alerts feature). alertsFrom is pure —
// thresholds and dedupe keys are pinned here without a server, caches, or network.
import { t, ok, eq, report } from './harness.mjs';
import { alertsFrom, postWebhook, telegramReply } from '../server.js';

const CFG = { liqPct: 10, dailyLoss: 500, funding24h: 100, cooldownMs: 0 };

console.log('\nalertsFrom thresholds');
t('near-liquidation position alerts; safe one does not', () => {
  const a = alertsFrom({ risk: [
    { coin: 'BTC', side: 'long', liqDist: 0.08, notional: 12000, wallet: { address: '0xabc' } },
    { coin: 'ETH', side: 'short', liqDist: 0.45, notional: 8000 },
  ], todayKey: 'd', todayNet: 0, funding24h: 0 }, CFG);
  eq(a.length, 1);
  ok(a[0].key === 'liq:BTC:0xabc');
  ok(a[0].text.includes('8.0% from liquidation'));
});
t('daily loss fires at the limit, keyed to the day so it re-arms tomorrow', () => {
  const a = alertsFrom({ risk: [], todayKey: '2026-9-5', todayNet: -600, funding24h: 0 }, CFG);
  eq(a.length, 1); eq(a[0].key, 'dailyloss:2026-9-5');
  const b = alertsFrom({ risk: [], todayKey: '2026-9-5', todayNet: -400, funding24h: 0 }, CFG);
  eq(b.length, 0); // under the limit
});
t('funding bleed uses paid (negative) funding', () => {
  const a = alertsFrom({ risk: [], todayKey: 'd', todayNet: 0, funding24h: -150 }, CFG);
  eq(a.length, 1); ok(a[0].text.includes('Funding bleed'));
  eq(alertsFrom({ risk: [], todayKey: 'd', todayNet: 0, funding24h: 150 }, CFG).length, 0); // RECEIVING funding is not an alert
});
t('drawdown alert only beyond the Monte-Carlo p95', () => {
  const base = { risk: [], todayKey: 'd', todayNet: 0, funding24h: 0 };
  eq(alertsFrom({ ...base, currentDD: -900, ddP95: 1000 }, CFG).length, 0);
  const a = alertsFrom({ ...base, currentDD: -1200, ddP95: 1000 }, CFG);
  eq(a.length, 1); eq(a[0].key, 'dd');
});
t('thresholds set to 0 disable their alerts', () => {
  const off = { liqPct: 0, dailyLoss: 0, funding24h: 0 };
  const a = alertsFrom({ risk: [{ coin: 'BTC', side: 'long', liqDist: 0.01, notional: 1 }],
    todayKey: 'd', todayNet: -1e9, funding24h: -1e9 }, off);
  eq(a.length, 0);
});

console.log('\npostWebhook body shaping');
async function capture(url) {
  let got = null;
  const orig = globalThis.fetch;
  globalThis.fetch = async (u, o) => { got = { url: u, ...o }; return { ok: true }; };
  try { await postWebhook(url, 'hello'); } finally { globalThis.fetch = orig; }
  return got;
}
await t('discord gets {content}', async () => {
  const g = await capture('https://discord.com/api/webhooks/x/y');
  eq(JSON.parse(g.body), { content: 'hello' });
});
await t('slack gets {text}', async () => {
  const g = await capture('https://hooks.slack.com/services/x');
  eq(JSON.parse(g.body), { text: 'hello' });
});
await t('ntfy gets a plain-text body', async () => {
  const g = await capture('https://ntfy.sh/mytopic');
  eq(g.body, 'hello'); eq(g.headers['Content-Type'], 'text/plain');
});
await t('anything else gets generic {text} JSON', async () => {
  const g = await capture('https://example.com/hook');
  eq(JSON.parse(g.body), { text: 'hello' });
});
await t('non-2xx throws so the caller can log it', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 500 });
  let threw = false;
  try { await postWebhook('https://example.com/h', 'x'); } catch (e) { threw = true; }
  finally { globalThis.fetch = orig; }
  ok(threw);
});

console.log('\ntelegramReply command router');
t('engine-down state answers every command with the same explanation', () => {
  ok(telegramReply('/today', { engineOk: false }).includes('engine unavailable'));
  ok(telegramReply('/risk', null).includes('engine unavailable'));
});
t('/today reports net, count, and the daily limit both sides of the line', () => {
  const under = telegramReply('/today', { engineOk: true, todayNet: -200, todayN: 3, tripLimit: 500 });
  ok(under.includes('-$200') && under.includes('3 trades') && under.includes('Daily limit: $500'));
  const over = telegramReply('/today', { engineOk: true, todayNet: -650, todayN: 5, tripLimit: 500 });
  ok(over.includes('⛔') && over.includes('step away'));
  const noLimit = telegramReply('/today', { engineOk: true, todayNet: 100, todayN: 1, tripLimit: 0 });
  ok(!noLimit.includes('limit'));
});
t('/risk summarizes the book and lists liquidation dangers', () => {
  const st = { engineOk: true, accountValue: 25000, risk: { positions: 2, gross: 40000, skew: -10000,
    dangers: [{ coin: 'DOGE', side: 'long', liqDistPct: 6.5 }] } };
  const r = telegramReply('/risk', st);
  ok(r.includes('2 position(s)') && r.includes('gross $40,000') && r.includes('short $10,000'));
  ok(r.includes('account $25,000'));
  ok(r.includes('DOGE long (6.5% away)'));
  const safe = telegramReply('/risk', { engineOk: true, risk: { positions: 1, gross: 100, skew: 100, dangers: [] } });
  ok(safe.includes('No positions within 10%'));
  ok(telegramReply('/risk', { engineOk: true }).includes('refresh first'));
});
t('/stats formats the 30d summary; empty window says so', () => {
  const s = telegramReply('/stats', { engineOk: true, stats30: { n: 12, net: 340, winRate: 0.583,
    expectancy: 28.3, profitFactor: 1.62, fees: 41 } });
  ok(s.includes('12 trades') && s.includes('win rate 58%') && s.includes('PF 1.62'));
  ok(telegramReply('/stats', { engineOk: true }).includes('No closed trades'));
});
t('/goals reports month vs plan; unset goals point at the Review tab', () => {
  const g = telegramReply('/goals', { engineOk: true, goals: { net: 800, target: 2000, n: 9,
    projected: 2400, intraDD: -300, maxDD: 1000, tradesPerWeek: 4.5, maxTradesWeek: 10 } });
  ok(g.includes('$800 / $2,000 target') && g.includes('Projected month-end: $2,400'));
  ok(g.includes('DD -$300 vs cap -$1,000') && g.includes('4.5 trades/wk vs cap 10'));
  ok(telegramReply('/goals', { engineOk: true }).includes('No monthly goals set'));
});
t('/digest returns the stored digest text or explains there is none', () => {
  eq(telegramReply('/digest', { engineOk: true, digest: 'weekly text' }), 'weekly text');
  ok(telegramReply('/digest', { engineOk: true }).includes('No weekly digest'));
});
t('unknown commands get the help text listing every command', () => {
  const h = telegramReply('/help', { engineOk: true });
  for (const c of ['/today', '/risk', '/stats', '/goals', '/digest']) ok(h.includes(c));
  ok(h.includes('read-only'));
});

report('alerts');
