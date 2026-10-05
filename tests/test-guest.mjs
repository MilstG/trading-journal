// People without a profile: the level cap they stop at, the anonymous visitor count, the invite link
// that fills the code in, and wallet proof as the default for a new server (and not for an old one).
import { mkdtempSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { t, ok, eq, report, makeExtractor } from './harness.mjs';

const require = createRequire(import.meta.url);
const server = require('../server.js');
const htmlPath = new URL('../ledger.html', import.meta.url).pathname;
const { readAppSource } = require('../app-source.js');
const { grabFn } = makeExtractor(readAppSource(htmlPath));

// ---- the cap, in the app ----
const ctx = vm.createContext({});
vm.runInContext(`
  const LEVELS=['Rookie','Apprentice','Journeyman','Disciplined','Consistent','Professional','Veteran','Master','Grandmaster','Legend'];
  var PZ_CFG={rev:0,levels:null,xp:null};
  const PZ_UNLOCK_DEFAULTS={unlocksOn:true,unlocks:{trends:2,share:3,compete:4}};
  var SOC={cfg:null,key:null,me:null}, SRV={token:null,badAuth:false}, pzS={demo:false};
  ${['levelFor', 'pzLevelCfg', 'pzGuestCap', 'pzNeedsProfile', 'pzLockWord', 'pzUnlockCfg', 'pzNeeds', 'pzLocked'].map(grabFn).join('\n')}
`, ctx);
const run = code => vm.runInContext(code, ctx);
const cfg = o => run(`SOC.cfg=${JSON.stringify(Object.assign({ open: true, guestCap: 3, unlocksOn: true, modules: { trends: 2, share: 3, compete: 4, deep: 1, review: 1, reports: 1, coach: 1, peers: 1, duels: 3 } }, o))}`);

t('without a profile, levels stop at the cap; the XP still counts and the level it reached is kept', () => {
  cfg({});
  const L = run('levelFor(5000)'); // 4,000 starts level 5
  eq([L.level, L.capped, L.earned, L.xp, L.title], [3, true, 5, 5000, 'Journeyman']);
  eq(L.into, L.need, 'the bar shows full at the cap');
  eq(run('levelFor(1000)').level, 2, 'below the cap nothing changes');
  ok(!run('levelFor(1000)').capped);
});
t('share cards (level 3) stay open; anything past the cap needs a profile, not more XP', () => {
  cfg({});
  eq(run('pzLocked("share", levelFor(9999).level)'), 0);
  eq(run('pzLocked("compete", levelFor(9999).level)'), 4);
  eq(run('pzNeedsProfile(4)'), true); eq(run('pzLockWord(4)'), 'needs a profile');
  cfg({ modules: { trends: 5 } });
  eq(run('pzLocked("trends", levelFor(99999).level)'), 5, 'an owner who moves a feature past the cap moves it behind a profile');
});
t('members, the owner, the demo, a closed league and a cap of 0 are never capped', () => {
  cfg({});
  run('SOC.key="k"'); eq(run('levelFor(5000).level'), 5); run('SOC.key=null');
  run('SRV.token="t"'); eq(run('levelFor(5000).level'), 5); run('SRV.token=null');
  run('pzS.demo=true'); eq(run('levelFor(5000).level'), 5); run('pzS.demo=false');
  cfg({ open: false }); eq(run('levelFor(5000).level'), 5, 'nowhere to create a profile: no cap');
  cfg({ guestCap: 0 }); eq(run('levelFor(5000).level'), 5);
  run('SOC.cfg=null'); eq(run('levelFor(5000).level'), 5, 'no server: no cap');
  eq(run('pzLockWord(4)'), 'level 4');
});
t('the game is recomputed when the cap changes (joining lifts it at once)', () => {
  const src = grabFn('_gameKey'); // gameContext's memo key
  ok(grabFn('gameContext').includes('const key=_gameKey();'));
  ok(src.includes("'|'+(typeof pzGuestCap==='function'?pzGuestCap():0)"), 'the cap is part of the memo key');
});
t('the invite link fills the code in and leaves the address bar; joining forgets it', () => {
  const app = readAppSource(htmlPath);
  ok(app.includes("u.searchParams.get('invite')") && app.includes("u.searchParams.delete('invite')"));
  ok(app.includes('value="${esc(socInviteCode())}"'));
  ok(app.includes('localStorage.removeItem(SOC_INVITE_STORE)'));
});

// ---- the server ----
let clock = Date.parse('2026-10-20T12:00:00Z');
const dataDir = mkdtempSync(join(tmpdir(), 'ledger-guest-'));
const app = server.createApp({ dataDir, auth: 'owner-token', htmlPath, now: () => clock, push: false, pushTick: false, trustProxy: true, offsiteTimer: false,
  fetchImpl: async () => ({ ok: true, status: 200, json: async () => [] }) });
const B = await new Promise(r => app.listen(0, () => r('http://127.0.0.1:' + app.address().port)));
const call = async (p, o = {}) => { const r = await fetch(B + '/api/social' + p, { method: o.method || 'GET',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': o.ip || '10.0.0.1', ...(o.key ? { 'X-Pulse-Key': o.key } : {}), ...(o.owner ? { Authorization: 'Bearer owner-token' } : {}) },
    body: o.body !== undefined ? JSON.stringify(o.body) : undefined });
  return { status: r.status, d: await r.json().catch(() => ({})) }; };
const visitors = async () => (await call('/admin/overview', { owner: true })).d.visitors;
try {
  await t('a new server: the cap is level 3 and only claimed wallets count', async () => {
    const c = (await call('/config')).d;
    eq([c.guestCap, c.requireClaim], [3, true]);
  });
  await t('the owner sets the cap (0 = none); out of range is refused, not clamped to “no limit”', async () => {
    for (const [v, want] of [[5, 5], [0, 0], [3, 3]]) {
      eq((await call('/admin/config', { method: 'PUT', owner: true, body: { guestCap: v } })).status, 200);
      eq((await call('/config')).d.guestCap, want, String(v));
    }
    for (const v of [500, -2, -3, '', null, 2.5]) {
      const r = await call('/admin/config', { method: 'PUT', owner: true, body: { guestCap: v } });
      eq(r.status, 400, String(v)); ok(/Levels stop at .* from 1 to 100, or 0 for no limit/.test(r.d.error), r.d.error);
      eq((await call('/config')).d.guestCap, 3, 'unchanged after ' + String(v));
    }
    eq((await call('/admin/config', { method: 'PUT', body: { guestCap: 0 } })).status, 401, 'owner only');
  });
  await t('visitors: counted once a day per address, nothing identifying kept', async () => {
    for (const ip of ['10.0.0.1', '10.0.0.1', '10.0.0.2']) eq((await call('/visit', { method: 'POST', ip, body: {} })).status, 200);
    eq((await visitors()).today, 2);
    clock += 86400000;
    await call('/visit', { method: 'POST', ip: '10.0.0.1', body: {} });
    const v = await visitors(); eq(v.today, 1); eq(v.avg7, Math.round(3 / 7 * 10) / 10);
    const raw = readFileSync(join(dataDir, 'pulse.db')).toString('latin1') + readFileSync(join(dataDir, 'pulse.db-wal')).toString('latin1');
    ok(!raw.includes('10.0.0.1') && !raw.includes('10.0.0.2'), 'no address stored');
  });
  await t('a visitor who joins counts as converted; someone who joins straight away doesn’t', async () => {
    eq((await call('/join', { method: 'POST', ip: '10.1.0.1', body: { handle: 'from_visit', visitor: true } })).status, 200);
    eq((await call('/join', { method: 'POST', ip: '10.1.0.2', body: { handle: 'straight_in' } })).status, 200);
    const v = await visitors(); eq([v.conv30, v.joins30], [1, 2]);
  });
  await t('overview: wallet proof on, so no to-do; the unclaimed count is there for the owner', async () => {
    const o = (await call('/admin/overview', { owner: true })).d;
    eq(o.config.requireClaim, true); eq(typeof o.unclaimed, 'number');
  });
} finally { await new Promise(r => app.close(r)); }

await t('an existing server with members keeps counting unproven wallets until the owner turns proof on', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ledger-guest-old-'));
  const store = require('../db.js').open(dir);
  store.q('INSERT INTO kv (k, v) VALUES (?, ?)').run('config', JSON.stringify({ open: true, inviteCode: '' }));
  store.q('INSERT INTO members (id, data) VALUES (?, ?)').run('abc123', JSON.stringify({ id: 'abc123', handle: 'oldtimer', createdAt: 1, share: {}, address: '0x' + '1'.repeat(40) }));
  store.close();
  const a2 = server.createApp({ dataDir: dir, auth: 'owner-token', htmlPath, push: false, pushTick: false, offsiteTimer: false, fetchImpl: async () => ({ ok: true, status: 200, json: async () => [] }) });
  const b2 = await new Promise(r => a2.listen(0, () => r('http://127.0.0.1:' + a2.address().port)));
  try {
    const c = await (await fetch(b2 + '/api/social/config')).json();
    eq([c.requireClaim, c.guestCap], [false, 3], 'proof stays off; the cap (a new setting) applies');
    const o = await (await fetch(b2 + '/api/social/admin/overview', { headers: { Authorization: 'Bearer owner-token' } })).json();
    eq(o.unclaimed, 1, 'the admin to-do has its number');
  } finally { await new Promise(r => a2.close(r)); }
});

report('guest');
