// Return leagues rank on their own window: a weekly league's % return board and its promotion read
// the league's week (Monday to Sunday), not the rolling 30 days the server-wide boards show. Over
// HTTP with a stubbed Hyperliquid.
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { t, ok, eq, near, report } from './harness.mjs';

const require = createRequire(import.meta.url);
const S = require('../social.js');
const server = require('../server.js');
const htmlPath = new URL('../ledger.html', import.meta.url).pathname;
const DAY = 86400000;

console.log('\nportfolioStats over a window');
t('a window with one point so far measures from the last point before it', () => {
  const res = [['month', { accountValueHistory: [[1, '1000'], [5, '1100']], pnlHistory: [[1, '0'], [3, '40'], [6, '100']] }]];
  near(S.portfolioStats(res, 'month', 5, 9).ret, 0.06, 1e-9, 'from 40 (the point before) to 100, on 1000');
  eq(S.portfolioStats(res, 'month', 7, 9), null, 'nothing in the window: nothing to say');
  near(S.portfolioStats(res, 'month', 2, 9).ret, 0.06, 1e-9, 'two points in the window: unchanged, from the first of them');
});

// four traders, daily points from Sep 8: each one's P&L at the end of Sunday Oct 4 and by Wednesday Oct 7
const T0 = Date.parse('2026-09-08T00:00:00Z'), MON = Date.parse('2026-10-05T00:00:00Z');
const PEOPLE = { // [P&L at Monday Oct 5, P&L by Wednesday Oct 7], on 1,000 of equity
  big: [300, 250], // a great month, a losing week
  steady: [20, 100], // a quiet month, the best week
  mid: [100, 140],
  flat: [0, 10] };
const ADDR = Object.fromEntries(Object.keys(PEOPLE).map((h, i) => [h, '0x' + String(i + 1).repeat(40)]));
const series = ([atMon, atWed], clockMs) => { const pn = [], av = [];
  for (let ms = T0; ms <= clockMs; ms += DAY) {
    const v = ms <= MON ? atMon * (ms - T0) / (MON - T0) : atMon + (atWed - atMon) * Math.min(1, (ms - MON) / (2 * DAY));
    pn.push([ms, String(v)]); av.push([ms, String(1000 + v)]); }
  return [['month', { accountValueHistory: av, pnlHistory: pn }], ['allTime', { accountValueHistory: av, pnlHistory: pn }]]; };
let clock = Date.parse('2026-10-07T12:00:00Z');
const fetchImpl = async (url, o) => { const b = JSON.parse(o.body), who = Object.keys(ADDR).find(h => ADDR[h] === String(b.user).toLowerCase());
  const out = b.type === 'portfolio' && who ? series(PEOPLE[who], clock) : [];
  return { ok: true, status: 200, json: async () => out }; };
const dataDir = mkdtempSync(join(tmpdir(), 'ledger-lwin-'));
const app = server.createApp({ dataDir, auth: 'owner-token', htmlPath, fetchImpl, now: () => clock, push: false, pushTick: false });
const B = await new Promise(res => app.listen(0, () => res('http://127.0.0.1:' + app.address().port)));
const call = async (p, o = {}) => { const r = await fetch(B + '/api/social' + p, { method: o.method || 'GET', headers: { 'Content-Type': 'application/json', ...(o.key ? { 'X-Pulse-Key': o.key } : {}), ...(o.admin ? { Authorization: 'Bearer owner-token' } : {}) }, body: o.body ? JSON.stringify(o.body) : undefined });
  return { status: r.status, d: await r.json() }; };
const adm = (p, method, body) => call('/admin' + p, { method, body, admin: true });
const settle = () => new Promise(r => setTimeout(r, 60));
const keys = {};
let LID;

console.log('\nOver HTTP');
try {
  await adm('/config', 'PUT', { requireClaim: false, unlocksOn: false });
  await t('a weekly % return league ranks on its week; the server-wide board on the last 30 days', async () => {
    const L = await adm('/leagues', 'POST', { name: 'Return weekly', metric: 'ret', tiers: true, autoJoin: true }); eq(L.status, 200, JSON.stringify(L.d)); LID = L.d.id;
    for (const h of Object.keys(PEOPLE)) { const j = await call('/join', { method: 'POST', body: { handle: h, address: ADDR[h], share: { ret: true, global: true } } });
      eq(j.status, 200, JSON.stringify(j.d)); keys[h] = j.d.key; await settle(); }
    const week = (await call('/leaderboard?board=ret&league=' + LID, { key: keys.flat })).d.rows;
    eq(week.map(r => r.handle), ['steady', 'mid', 'flat', 'big'], JSON.stringify(week));
    near(week[0].value, 0.08 / 1.02, 1e-6, 'steady: +80 this week on 1,020 at Monday');
    ok(week[3].value < 0, 'big lost money this week');
    const month = (await call('/leaderboard?board=ret&scope=global', { key: keys.flat })).d.rows;
    eq(month[0].handle, 'big', 'over 30 days the big month leads');
  });
  await t('promotion reads the week that closed, not the last 30 days', async () => {
    clock = Date.parse('2026-10-12T12:00:00Z'); await call('/config');
    const roster = (await adm('/leagues', 'GET')).d.leagues.find(l => l.id === LID).roster;
    const tierOf = h => roster.find(r => r.handle === h).tier;
    eq([tierOf('steady'), tierOf('big')], [1, 0], JSON.stringify(roster));
  });
} finally { await new Promise(r => app.close(r)); }
report('league windows');
