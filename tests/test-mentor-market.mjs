// Picking mentors and paying them: a directory of mentors with their rate, slots and track record;
// members pick up to two, and their days and trades go to those only. A mentor sets a rate inside the
// owner's range; the first trade with each is free, later ones hold XP until the mentor marks the trade
// reviewed with a comment (paid, less the owner's pool share) or the hold runs out (returned). Paying
// comes out of the member's XP to spend, never their level.
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { t, ok, eq, report, makeExtractor } from './harness.mjs';
import { readAppSource } from '../app-source.js';

const require = createRequire(import.meta.url);
const server = require('../server.js');
const htmlPath = new URL('../ledger.html', import.meta.url).pathname;
const DAY = 864e5, HOUR = 36e5, key = ms => new Date(ms).toISOString().slice(0, 10);
let clock = Date.parse('2026-10-20T20:00:00Z');

const dataDir = mkdtempSync(join(tmpdir(), 'ledger-mmk-'));
const app = server.createApp({ dataDir, auth: 'owner-token', htmlPath, now: () => clock, push: false, pushTick: false, offsiteTimer: false, trustProxy: true,
  fetchImpl: async () => ({ ok: true, status: 200, json: async () => [] }) });
const B = await new Promise(res => app.listen(0, () => res('http://127.0.0.1:' + app.address().port)));
let ipN = 0;
const call = async (p, o = {}) => { const r = await fetch(B + '/api/social' + p, { method: o.method || 'GET', headers: { 'Content-Type': 'application/json', ...(p === '/join' ? { 'X-Forwarded-For': '10.0.1.' + (++ipN) } : {}), ...(o.key ? { 'X-Pulse-Key': o.key } : {}), ...(o.admin ? { Authorization: 'Bearer owner-token' } : {}) }, body: o.body ? JSON.stringify(o.body) : undefined });
  return { status: r.status, d: await r.json().catch(() => ({})) }; };
const join_ = async h => (await call('/join', { method: 'POST', body: { handle: h } })).d.key;
const idOf = async h => (await call('/admin/members', { admin: true })).d.members.find(m => m.handle === h).id;
const me = async k => (await call('/me', { key: k })).d.me;
const stats = (k, xp) => call('/stats', { method: 'POST', key: k, body: { xp, level: 3, tz: 'UTC', days: [{ k: key(clock), s: 80 }] } });
const act = (k, h, action, extra) => call('/mentors/' + h, { method: 'POST', key: k, body: Object.assign({ action }, extra || {}) });
let tn = 0; const TR = () => ({ coin: 'ETH', label: 'ETH', side: 'long', market: 'perp', openedAt: clock - 5 * HOUR - (++tn) * 60000, closedAt: clock - HOUR, entry: 1, exit: 2 });
const send = (k, body) => call('/reviews', { method: 'POST', key: k, body: Object.assign({ key: 'trade' + String(++tn).padStart(4, '0'), trade: TR() }, body) });
const comment = (k, id, text = 'Your stop moved twice. Leave it.') => call('/reviews/' + id + '/comments', { method: 'POST', key: k, body: { text } });
const done = (k, id) => call('/reviews/' + id + '/reviewed', { method: 'POST', key: k, body: { done: true } });
const inbox = async k => (await call('/inbox', { key: k })).d.items;
const grant = async (h, xp) => call('/admin/members/' + await idOf(h), { method: 'POST', admin: true, body: { action: 'grant', xp } });

let MIA, KAI, LEO, NED, OLU, PAM;
try {
  await call('/admin/config', { method: 'PUT', admin: true, body: { requireClaim: false, unlocksOn: false, standing: { on: false } } });
  MIA = await join_('mia'); KAI = await join_('kai'); LEO = await join_('leo'); NED = await join_('ned'); OLU = await join_('olu'); PAM = await join_('pam');
  for (const h of ['mia', 'kai', 'leo']) await call('/admin/members/' + await idOf(h), { method: 'POST', admin: true, body: { action: 'mentor' } });
  // XP to spend is the server's ledger, never the total an app reports: each starts with an owner's grant
  for (const [h, k, xp] of [['mia', MIA, 500], ['kai', KAI, 300], ['leo', LEO, 100], ['ned', NED, 120], ['olu', OLU, 30], ['pam', PAM, 400]]) {
    await stats(k, xp); await call('/admin/members/' + await idOf(h), { method: 'POST', admin: true, body: { action: 'grant', xp, why: 'Starting balance' } }); }

  await t('the owner’s range: 0 to 100 XP a trade, no pool share and 72 hours to review by default; a minimum above the maximum moves it', async () => {
    const c = (await call('/config')).d.mentorXp; eq([c.rates, c.rateMin, c.rateMax, c.poolPct, c.holdHours], [true, 0, 100, 0, 72]);
    const r = (await call('/admin/config', { method: 'PUT', admin: true, body: { mentorXp: { rateMin: 150 } } }));
    const c2 = (await call('/config')).d.mentorXp; eq([c2.rateMin, c2.rateMax], [150, 150], JSON.stringify(r.d).slice(0, 200));
    await call('/admin/config', { method: 'PUT', admin: true, body: { mentorXp: { rateMin: 0, rateMax: 60, poolPct: 10 } } });
    const c3 = (await call('/config')).d.mentorXp; eq([c3.rateMin, c3.rateMax, c3.poolPct], [0, 60, 10]);
  });
  await t('a mentor sets their own rate and slots; the rate is kept inside the owner’s range; members can’t set one', async () => {
    eq((await call('/me', { method: 'PUT', key: MIA, body: { mentorRate: 40, mentorSlots: 2 } })).status, 200);
    await call('/me', { method: 'PUT', key: KAI, body: { mentorRate: 500 } });
    const m = await me(MIA); eq([m.mentorRate, m.mentorSlots], [40, 2]);
    eq((await me(KAI)).mentorRate, 60, 'kai asked 500; the owner’s maximum is 60');
    eq((await me(LEO)).mentorRate, 0, 'free unless they set one');
    await call('/me', { method: 'PUT', key: NED, body: { mentorRate: 30 } }); eq((await me(NED)).mentorRate, null);
  });
  await t('the directory lists every mentor with rate, slots and a track record; sorting and the room filter work', async () => {
    const d = (await call('/mentors?sort=rate', { key: NED })).d;
    eq(d.mentors.map(x => [x.handle, x.rate, x.slots.total, x.firstFree]), [['leo', 0, 5, false], ['mia', 40, 2, true], ['kai', 60, 5, true]]);
    eq(d.mentors[0].record, { reviewed: 0, replyMs: null, back: null, mentees: 0, results: { age: 0, pw: 0, plug: 0 } });
    eq([d.me.picks, d.me.max, d.me.wallet], [[], 2, { balance: 120, held: 0, spent: 0 }]);
    eq(d.rates.poolPct, 10);
    eq((await call('/mentors/mia', { key: NED })).d.mentor.handle, 'mia');
    eq((await call('/mentors/ned', { key: MIA })).status, 404, 'not a mentor');
  });
  await t('picking needs mentors let in, takes at most two, and a full mentor offers a waitlist', async () => {
    await call('/me', { method: 'PUT', key: NED, body: { share: { mentor: false } } }); // on by default
    const r = await act(NED, 'mia', 'pick'); eq([r.status, r.d.needsLetIn], [409, true]);
    eq((await act(NED, 'mia', 'pick', { letIn: true })).status, 200);
    eq((await me(NED)).myMentors, ['mia']);
    ok((await inbox(MIA)).some(x => x.title === 'A new mentee' && /@ned picked you/.test(x.text)));
    eq((await act(NED, 'kai', 'pick')).status, 200);
    eq((await act(NED, 'leo', 'pick')).status, 409, 'a third');
    await call('/me', { method: 'PUT', key: OLU, body: { share: { mentor: true } } }); await call('/me', { method: 'PUT', key: PAM, body: { share: { mentor: true } } });
    eq((await act(OLU, 'mia', 'pick')).status, 200);
    const full = await act(PAM, 'mia', 'pick'); eq([full.status, full.d.full], [409, true], 'mia takes two');
    eq((await act(PAM, 'leo', 'wait')).status, 409, 'leo has room: pick instead');
    eq((await act(PAM, 'mia', 'wait')).status, 200);
    eq((await call('/mentors/mia', { key: PAM })).d.mentor.waiting, true);
    eq((await call('/mentors?open=1', { key: PAM })).d.mentors.map(x => x.handle).sort(), ['kai', 'leo']);
  });
  await t('picked mentors are the only ones who see a member’s days and trades', async () => {
    eq((await call('/mentor/ned', { key: MIA })).status, 200);
    eq((await call('/mentor/ned', { key: LEO })).status, 404, 'leo wasn’t picked');
    ok(!(await call('/mentor', { key: LEO })).d.mentees.some(x => x.handle === 'ned'));
    ok((await call('/mentor', { key: MIA })).d.mentees.find(x => x.handle === 'ned').picked);
    ok((await call('/mentor', { key: LEO })).d.mentees.some(x => x.handle === 'pam'), 'pam picked no one: every mentor sees her');
  });
  let first, held;
  await t('with two mentors a trade names one; the first trade with a paid mentor is free, the next holds their rate', async () => {
    const r0 = await send(NED, {}); eq([r0.status, r0.d.mentors], [400, ['mia', 'kai']]);
    const r1 = await send(NED, { to: 'mia' }); eq(r1.status, 200); first = r1.d.review;
    eq([first.to, first.fee.state, first.fee.xp], ['mia', 'free', 0]);
    const lst = (await call('/reviews', { key: NED })).d;
    eq(lst.to.map(x => [x.handle, x.rate, x.firstFree]), [['mia', 40, false], ['kai', 60, true]]);
    eq((await send(NED, { to: 'mia', fee: 30 })).status, 409, 'the rate is 40, the app agreed to 30');
    const r2 = await send(NED, { to: '@mia', fee: 40 }); eq(r2.status, 200); held = r2.d.review;
    eq([held.fee.state, held.fee.xp, held.fee.until], ['held', 40, clock + 72 * HOUR]);
    const m = await me(NED); eq(m.wallet, { balance: 80, held: 40, spent: 0 });
    ok((await inbox(MIA)).some(x => /sent a trade for review: ETH long \(40 XP when you mark it reviewed\)/.test(x.text)));
    ok(!(await inbox(KAI)).some(x => /sent a trade for review/.test(x.text)), 'only the mentor it went to hears');
  });
  await t('a trade sent to one mentor is theirs alone', async () => {
    eq((await call('/reviews/' + held.id, { key: KAI })).status, 404);
    ok(!(await call('/reviews', { key: KAI })).d.toReview.some(x => x.id === held.id));
    ok((await call('/reviews', { key: MIA })).d.toReview.some(x => x.id === held.id));
  });
  await t('not enough XP to spend: the trade doesn’t go', async () => {
    // what the app reports never pays a mentor (audit X1): only the server's ledger does
    await stats(NED, 1000000); eq((await me(NED)).wallet.balance, 80, 'a posted total of a million changes nothing');
    await grant('ned', -50); // a correction from the owner
    const r = await send(NED, { to: 'mia' }); eq(r.status, 409); ok(/you have 30 XP to spend \(40 more is held/.test(r.d.error), r.d.error);
    await grant('ned', 50); await stats(NED, 120);
  });
  await t('marked reviewed without a word pays nothing; with a comment the hold is paid, less the pool’s 10%', async () => {
    eq((await done(MIA, held.id)).d.fee, 0);
    const lvl0 = (await me(NED)).level; // the league's level for the XP the app reports (120: level 1)
    clock += 2 * HOUR; await comment(MIA, held.id);
    const r = await done(MIA, held.id); eq([r.d.fee, r.d.review.fee.state], [36, 'paid']);
    eq((await done(MIA, held.id)).d.fee, 0, 'once');
    eq((await me(NED)).wallet, { balance: 80, held: 0, spent: 40 });
    eq((await me(NED)).level, lvl0, 'paying never lowers a level');
    const mx = (await me(MIA)).mentorXp; eq([mx.days[key(clock)].fee, mx.days[key(clock)].paid], [36, 1]);
    const pool = (await call('/admin/pool', { admin: true })).d; eq([pool.xp, pool.total, pool.log[0].fee, pool.log[0].xp, pool.log[0].from, pool.log[0].to], [4, 4, 40, 4, 'ned', 'mia']);
    eq((await call('/admin/pool', { key: NED })).status, 401);
  });
  await t('a hold the mentor doesn’t act on comes back after 72 hours', async () => {
    const r = (await send(NED, { to: 'kai' })).d.review; eq(r.fee.state, 'free');
    const h = (await send(NED, { to: 'kai', fee: 60 })).d.review; eq(h.fee.state, 'held');
    eq((await me(NED)).wallet.held, 60);
    clock += 73 * HOUR;
    eq((await call('/reviews/' + h.id, { key: NED })).d.review.fee.state, 'held', 'only the sweep moves it');
    await call('/reviews', { key: NED });
    eq((await call('/reviews/' + h.id, { key: NED })).d.review.fee.state, 'refunded');
    eq((await me(NED)).wallet, { balance: 80, held: 0, spent: 40 });
    ok((await inbox(NED)).some(x => x.title === 'XP returned' && /@kai didn’t mark it reviewed within 72 hours\. The 60 XP held/.test(x.text)));
    eq((await done(KAI, h.id)).d.fee, 0, 'a late review is free');
  });
  await t('taking a trade back returns held XP, and an untouched free first trade stays free', async () => {
    await grant('olu', 270);
    const f = (await send(OLU, {})).d.review; eq([f.to, f.fee.state], ['mia', 'free']);
    eq((await call('/reviews/' + f.id, { method: 'DELETE', key: OLU })).status, 200);
    const f2 = (await send(OLU, {})).d.review; eq(f2.fee.state, 'free', 'mia said nothing on the first one');
    await comment(MIA, f2.id); await call('/reviews/' + f2.id, { method: 'DELETE', key: OLU });
    const h = (await send(OLU, {})).d.review; eq(h.fee.state, 'held', 'mia answered the second: the free one is used');
    eq((await me(OLU)).wallet.held, 40);
    await call('/reviews/' + h.id, { method: 'DELETE', key: OLU });
    eq((await me(OLU)).wallet, { balance: 300, held: 0, spent: 0 });
  });
  await t('dropping a mentor returns what’s held for them and tells whoever’s waiting', async () => {
    const h = (await send(OLU, {})).d.review; eq(h.fee.state, 'held');
    eq((await act(OLU, 'mia', 'drop')).status, 200);
    eq((await call('/reviews/' + h.id, { key: OLU })).d.review.fee.state, 'refunded');
    eq((await me(OLU)).wallet.held, 0);
    ok((await inbox(PAM)).some(x => x.title === 'A mentor slot opened' && /@mia has room/.test(x.text)));
    eq((await call('/mentors/mia', { key: PAM })).d.mentor.waiting, false, 'told once');
    eq((await act(PAM, 'mia', 'pick')).status, 200);
  });
  await t('a mentor stood down: their holds come back; letting mentors out drops every pick', async () => {
    await stats(PAM, 400);
    eq((await send(PAM, {})).d.review.fee.state, 'free');
    const h = (await send(PAM, {})).d.review; eq(h.fee.state, 'held');
    await call('/admin/members/' + await idOf('mia'), { method: 'POST', admin: true, body: { action: 'unmentor' } });
    eq((await call('/reviews/' + h.id, { key: PAM })).d.review.fee.state, 'refunded');
    ok((await inbox(PAM)).some(x => /@mia isn’t a mentor here any more\./.test(x.text)));
    eq((await me(PAM)).myMentors, [], 'a pick that isn’t a mentor any more doesn’t count');
    await call('/admin/members/' + await idOf('mia'), { method: 'POST', admin: true, body: { action: 'mentor' } });
    eq((await me(NED)).myMentors, ['mia', 'kai']);
    await call('/me', { method: 'PUT', key: NED, body: { share: { mentor: false } } });
    eq((await me(NED)).myMentors, []);
  });
  await t('the track record counts reviews with a comment, the median first reply, and waits for 10 reviews before a return rate', async () => {
    const rec = (await call('/mentors/mia', { key: LEO })).d.mentor.record;
    eq([rec.reviewed, rec.back, rec.mentees], [1, null, 3], JSON.stringify(rec));
    eq(rec.replyMs, 2 * HOUR, 'mia answered ned two hours after he sent it (the trade olu took back went with its thread)');
  });
  await t('rates off: every review is free', async () => {
    await call('/admin/config', { method: 'PUT', admin: true, body: { mentorXp: { rates: false } } });
    eq((await call('/mentors/kai', { key: LEO })).d.mentor.rate, 0);
  });
} finally { await new Promise(r => app.close(r)); }

console.log('\nIn the app');
const src = readAppSource(htmlPath), { grabFn } = makeExtractor(src);
t('the directory, a mentor’s page and the send sheet are Daruma screens', () => {
  ok(/'mentors'/.test(grabFn('pzTab')) || src.includes("^mentors\\/"), 'routed');
  ok(grabFn('socMentorsHtml').includes('/mentors?'));
  ok(grabFn('socMentorPageHtml').includes('/mentors/'));
});
t('a mentor fee is mentoring XP for the mentor (levels), never XP the payer loses from their level', () => {
  ok(grabFn('gameContext').includes("bonuses.push({key:k,xp:d.xp,why:'mentoring',src:'mentor'})"));
});
report('mentor market');
