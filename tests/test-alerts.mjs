// Webhook alert derivation (scheduled refresh + alerts feature). alertsFrom is pure —
// thresholds and dedupe keys are pinned here without a server, caches, or network.
import { t, ok, eq, report } from './harness.mjs';
import { alertsFrom, postWebhook } from '../server.js';

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

report('alerts');
