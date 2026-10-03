// Referrals: a member's link (their handle, or a code of their own once their wallet is claimed) brings
// someone in on the terms of that day (the owner's amounts, or a running promotion's). Once the new member
// is active (a claimed wallet no member used before and enough trading days, read from that wallet), the
// referrer earns a bonus, the new member a welcome bonus, and the referrer a share of the new member's
// trading XP each week for the first months, paid once a week can't change any more. Referral XP raises
// levels and XP to spend, never XP by day (leagues, duels). A monthly cap limits referrals that pay.
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { t, ok, eq, report, makeExtractor } from './harness.mjs';
import { readAppSource } from '../app-source.js';

const require = createRequire(import.meta.url);
const server = require('../server.js');
const sig = require('../vendor/eth-sig.js');
const htmlPath = new URL('../ledger.html', import.meta.url).pathname;
const DAY = 864e5, key = ms => new Date(ms).toISOString().slice(0, 10);
let clock = Date.parse('2026-10-20T12:00:00Z'); // a Tuesday, 2026-W43
const K = n => '0x' + String(n).padStart(2, '0').repeat(32), W = n => sig.addressOfPrivateKey(K(n)).toLowerCase();
// each wallet's trading days, as the server's wallet reader scores them: n trades a day, Discipline s
const DAYS = {};
const traded = (addr, from, n, s = 80) => { DAYS[addr] = Array.from({ length: n }, (_, i) => ({ k: key(from + i * DAY), s, n: 3 })); };
const behaviorFor = async addr => DAYS[addr] || [];

const dataDir = mkdtempSync(join(tmpdir(), 'ledger-ref-'));
const app = server.createApp({ dataDir, auth: 'owner-token', htmlPath, now: () => clock, push: false, pushTick: false, offsiteTimer: false, behaviorFor, trustProxy: true,
  fetchImpl: async () => ({ ok: true, status: 200, json: async () => [] }) });
const B = await new Promise(res => app.listen(0, () => res('http://127.0.0.1:' + app.address().port)));
let ipN = 0;
const call = async (p, o = {}) => { const r = await fetch(B + '/api/social' + p, { method: o.method || 'GET', headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': o.ip || '10.0.3.' + (++ipN % 250), ...(o.key ? { 'X-Pulse-Key': o.key } : {}), ...(o.admin ? { Authorization: 'Bearer owner-token' } : {}) }, body: o.body ? JSON.stringify(o.body) : undefined });
  return { status: r.status, d: await r.json().catch(() => ({})) }; };
const until = async (f, ms = 4000) => { const end = Date.now() + ms; for (;;) { const v = await f(); if (v || Date.now() > end) return v; await new Promise(r => setTimeout(r, 40)); } };
const join_ = async (h, extra) => { const r = await call('/join', { method: 'POST', body: Object.assign({ handle: h }, extra || {}) }); if (r.status !== 200) throw new Error(JSON.stringify(r.d)); return r.d.key; };
const me = async k => (await call('/me', { key: k })).d.me;
const idOf = async h => (await call('/admin/members', { admin: true })).d.members.find(m => m.handle === h).id;
const claim = async (k, n) => { const st = await call('/claim/start', { method: 'POST', key: k, body: { address: W(n) } });
  const r = await call('/claim/finish', { method: 'POST', key: k, body: { nonce: st.d.nonce, signature: sig.signPersonal(st.d.message, K(n)) } }); if (r.status !== 200) throw new Error(JSON.stringify(r.d)); };
const refs = k => call('/referrals', { key: k });
const inbox = async k => (await call('/inbox', { key: k })).d.items;
// the stats an app posts (so the server keeps the member's XP); the trading days themselves come from the wallet
const stats = k => call('/stats', { method: 'POST', key: k, body: { xp: 10, level: 1, tz: 'UTC', days: [{ k: key(clock), s: 80 }] } });
// the periodic check runs at most every 10 minutes
const tick = async k => { clock += 11 * 60000; await call('/me', { key: k }); };

let MIA, KAI, LEO, NED, OLU;
try {
  await call('/admin/config', { method: 'PUT', admin: true, body: { requireClaim: false, unlocksOn: false, standing: { on: false } } });
  MIA = await join_('mia', { address: W(1) }); await claim(MIA, 1);

  await t('on by default; the league config says what someone joining today gets', async () => {
    const c = (await call('/config')).d.referrals;
    eq([c.on, c.rx, c.ex, c.pct, c.wk, c.ad, c.aw, c.promo, c.linksMax], [true, 100, 50, 20, 26, 5, 30, null, 5]);
  });
  await t('a link is a handle (any member) or a code of one’s own; it says who it’s from, and visits count once a day per address', async () => {
    const r = await call('/ref/MIA'); eq([r.status, r.d.handle, r.d.terms.ex], [200, 'mia', 50]);
    eq((await call('/ref/nobody')).status, 404);
    await call('/ref/mia/visit', { method: 'POST', ip: '10.9.9.1' }); await call('/ref/mia/visit', { method: 'POST', ip: '10.9.9.1' }); await call('/ref/mia/visit', { method: 'POST', ip: '10.9.9.2' });
    eq((await refs(MIA)).d.link, { code: 'mia', visits: 2, joins: 0, active: 0 });
  });
  await t('custom links: only for a fully validated member; codes are checked, unique, never someone else’s name, and capped', async () => {
    KAI = await join_('kai', { address: W(2) });
    const r = await call('/referrals/links', { method: 'POST', key: KAI, body: { code: 'kai-x' } }); eq(r.status, 403);
    eq((await refs(KAI)).d.why, 'claim');
    for (const [code, want] of [['ab', 400], ['-dash', 400], ['has space', 400], ['kai', 409], ['mia', 409]]) eq((await call('/referrals/links', { method: 'POST', key: MIA, body: { code } })).status, want, code);
    eq((await call('/referrals/links', { method: 'POST', key: MIA, body: { code: 'Mia-Twitter', label: 'Twitter bio' } })).d.link, { code: 'mia-twitter', label: 'Twitter bio', at: clock, visits: 0, joins: 0, active: 0 });
    eq((await call('/referrals/links', { method: 'POST', key: KAI, body: { code: 'mia-twitter' } })).status, 403, 'kai still unvalidated');
    await claim(KAI, 2);
    eq((await call('/referrals/links', { method: 'POST', key: KAI, body: { code: 'mia-twitter' } })).status, 409, 'taken');
    for (const c of ['m2', 'm3', 'm4', 'm5'].map(x => 'mia-' + x)) eq((await call('/referrals/links', { method: 'POST', key: MIA, body: { code: c } })).status, 200);
    eq((await call('/referrals/links', { method: 'POST', key: MIA, body: { code: 'mia-m6' } })).status, 409, 'five links by default');
    eq((await call('/referrals/links/mia-m5', { method: 'DELETE', key: MIA })).status, 200);
    eq((await call('/referrals/links/mia-m4', { method: 'DELETE', key: KAI })).status, 404, 'not kai’s');
    eq((await call('/ref/mia-twitter')).d.handle, 'mia');
  });
  await t('joining through a link records the referral on that day’s terms and tells the referrer; a custom code counts its join', async () => {
    await call('/ref/mia-twitter/visit', { method: 'POST', ip: '10.9.9.3' });
    LEO = await join_('leo', { address: W(3), share: { verify: true }, ref: 'MIA-TWITTER' });
    const R = (await refs(MIA)).d;
    eq(R.links.find(l => l.code === 'mia-twitter'), { code: 'mia-twitter', label: 'Twitter bio', at: R.links[0].at, visits: 1, joins: 1, active: 0 });
    const L = R.refs[0]; eq([L.handle, L.code, L.st, L.why, L.days, L.need, L.terms.rx, L.terms.ex], ['leo', 'mia-twitter', 'pending', 'claim', 0, 5, 100, 50]);
    ok((await inbox(MIA)).some(x => /@leo joined through your invite/.test(x.text)));
    eq((await refs(LEO)).d.mine.by, 'mia');
    const noRef = await join_('zed', { ref: 'nobody' }); eq((await refs(noRef)).d.mine, null, 'an unknown code is ignored');
  });
  await t('not active until the wallet is claimed and the wallet shows enough trading days after joining', async () => {
    traded(W(3), clock - 3 * DAY, 6); // 3 days before joining (don't count) and 3 after
    await claim(LEO, 3); await stats(LEO);
    await until(async () => (await refs(MIA)).d.refs[0].why === 'days');
    eq((await refs(MIA)).d.refs[0].days, 3);
    traded(W(3), clock - 3 * DAY, 9); clock += 5 * DAY; await call('/me', { method: 'PUT', key: LEO, body: { share: { verify: true } } });
    await tick(LEO); await until(async () => { await tick(LEO); return (await refs(MIA)).d.refs[0].st === 'active'; });
    const R = (await refs(MIA)).d; eq([R.refs[0].st, R.earned.bonus, R.earned.all, R.links.find(l => l.code === 'mia-twitter').active], ['active', 100, 100, 1]);
    eq((await refs(LEO)).d.earned.welcome, 50);
  });
  await t('referral XP raises the total and XP to spend, never XP by day (leagues and duels)', async () => {
    const m = await me(MIA); ok(m.refXp === 100); ok(m.wallet.balance >= 100, JSON.stringify(m.wallet));
    const day = Object.values(m.xpDays || {}).reduce((a, x) => a + x, 0); ok(day < 100, 'no referral XP in the XP by day');
    ok((await me(LEO)).wallet.balance >= 50);
    ok((await inbox(LEO)).some(x => x.title === 'Welcome bonus'));
  });
  await t('the share: 20% of the new member’s trading XP from joining, a week at a time once the week is fixed', async () => {
    let R = (await refs(MIA)).d; eq(R.earned.share, 0, 'W43 ends Sunday Oct 25 and is fixed a week later');
    clock = Date.parse('2026-11-03T12:00:00Z'); await tick(MIA); await tick(MIA);
    R = (await refs(MIA)).d; const L = R.refs[0];
    const wk43 = DAYS[W(3)].filter(x => x.k >= '2026-10-20' && x.k <= '2026-10-25');
    const w = (await call('/config')).d.xp.discipline;
    eq(L.weeksPaid, 1); eq(L.shared, Math.floor(wk43.reduce((a, x) => a + Math.round(x.s * w), 0) * 0.2), 'Discipline × the league’s weight, joining day on');
    eq(R.earned.share, L.shared); ok((await inbox(MIA)).some(x => x.title === 'Referral share'));
    clock += 7 * DAY; await tick(MIA); eq((await refs(MIA)).d.refs[0].weeksPaid, 2);
  });
  await t('the owner’s monthly cap: past it, a referral activates (the welcome is paid) but earns the referrer nothing', async () => {
    await call('/admin/config', { method: 'PUT', admin: true, body: { referrals: { monthlyCap: 1 } } });
    clock = Date.parse('2026-11-10T12:00:00Z');
    // leo activated in October: November has room for one
    NED = await join_('ned', { address: W(4), share: { verify: true }, ref: 'mia' }); traded(W(4), clock, 6); await claim(NED, 4); await stats(NED);
    OLU = await join_('olu', { address: W(5), share: { verify: true }, ref: 'mia' }); traded(W(5), clock, 6); await claim(OLU, 5); await stats(OLU);
    clock += 6 * DAY; await tick(MIA); await until(async () => { await tick(MIA); return (await refs(MIA)).d.refs.filter(r => r.st === 'active').length === 3; });
    const R = (await refs(MIA)).d, capped = R.refs.filter(r => r.capped);
    eq(capped.length, 1); eq(R.earned.bonus, 200); eq(R.paidThisMonth, 2);
    eq((await refs(capped[0].handle === 'ned' ? NED : OLU)).d.earned.welcome, 50);
  });
  await t('a wallet that already activated a referral never does again (delete and rejoin pays nothing)', async () => {
    eq((await call('/me', { method: 'DELETE', key: OLU })).status, 200);
    const P = await join_('pat', { address: W(5), share: { verify: true }, ref: 'kai' }); await claim(P, 5); await stats(P);
    clock += 11 * 60000; await until(async () => { await tick(P); return (await refs(KAI)).d.refs[0].st === 'void'; });
    eq((await refs(KAI)).d.refs[0].why, 'wallet');
  });
  await t('a promotion sets the terms for members who join while it runs; past it, the defaults; dates are checked', async () => {
    const day = key(clock);
    eq((await call('/admin/config', { method: 'PUT', admin: true, body: { referrals: { promo: { on: true, from: day, to: '2026-01-01' } } } })).status, 400);
    await call('/admin/config', { method: 'PUT', admin: true, body: { referrals: { referrerXp: 120, promo: { on: true, label: 'Launch week', from: day, to: key(clock + 2 * DAY), referrerXp: 300, refereeXp: 150, sharePct: 30 } } } });
    eq((await call('/ref/mia')).d.terms.promo, 'Launch week');
    const Q = await join_('quin', { ref: 'mia' }); eq((await refs(Q)).d.mine.terms, { rx: 300, ex: 150, pct: 30, wk: 26, ad: 5, aw: 30, promo: 'Launch week', until: key(clock + 2 * DAY) });
    clock += 3 * DAY;
    const c = (await call('/config')).d.referrals; eq([c.rx, c.ex, c.pct, c.promo], [120, 50, 20, null]);
    eq((await refs(Q)).d.mine.terms.rx, 300, 'locked in on the day they joined');
  });
  await t('the owner: every referral and code, voiding one stops its share, and switching off closes the routes', async () => {
    const A = (await call('/admin/referrals', { admin: true })).d;
    eq(A.refs.map(r => r.handle).sort(), ['leo', 'ned', 'pat', 'quin'], 'olu deleted their profile'); ok(A.links.some(l => l.code === 'mia-twitter' && l.handle === 'mia' && l.joins === 1)); eq(A.earners[0].handle, 'mia');
    const leo = A.refs.find(r => r.handle === 'leo');
    eq((await call('/admin/referrals/' + leo.id, { method: 'POST', admin: true, body: { action: 'void' } })).status, 200);
    const before = (await refs(MIA)).d.earned.share; clock += 14 * DAY; await tick(MIA);
    eq((await refs(MIA)).d.earned.share > before, true, 'ned still pays (he wasn’t capped)');
    eq((await refs(MIA)).d.refs.find(r => r.handle === 'leo').st, 'void');
    eq((await call('/admin/referrals/links/mia-m2', { method: 'DELETE', admin: true })).status, 200);
    eq((await call('/ref/mia-m2')).status, 404);
    eq((await call('/admin/overview', { admin: true })).d.referrals, { void: 2, active: 1, pending: 1 }, 'ned active; leo voided by the owner, pat’s wallet already counted; quin pending');
    await call('/admin/config', { method: 'PUT', admin: true, body: { referrals: { on: false } } });
    eq((await refs(MIA)).status, 403); eq((await call('/ref/mia')).status, 404); eq((await call('/config')).d.referrals, { on: false });
    const X = await join_('xan', { ref: 'mia' }); await call('/admin/config', { method: 'PUT', admin: true, body: { referrals: { on: true } } });
    eq((await refs(X)).d.mine, null, 'joining while off records nothing');
  });
  await t('a deleted member’s codes go with them', async () => {
    eq((await call('/me', { method: 'DELETE', key: MIA })).status, 200);
    eq((await call('/ref/mia-twitter')).status, 404);
  });
} finally { await new Promise(r => app.close(r)); }

console.log('\nIn the app');
const src = readAppSource(htmlPath), { grabFn } = makeExtractor(src);
t('the Invite screen is a Daruma feature, and a ?ref= link is kept until joining and sent with it', () => {
  ok(src.includes("pzFeature({id:'invite'"));
  ok(src.includes("searchParams.get('ref')"));
  ok(/ref:socRefCode\(\)/.test(src), 'sent with /join');
});
t('Recruiter badges count activations, and their XP stays out of leagues like mentoring’s', () => {
  ok(src.includes("['recruiter',"));
  ok(/b\.fam==='recruiter'/.test(grabFn('pzBadgeCatalog')));
});
report('referrals');
