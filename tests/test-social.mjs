// Social layer (social.js + Pulse's social client): stats validation, feed events, returns
// from the chain, league promotion, leaderboards, competitions, and the member and admin API
// over real HTTP with a stubbed Hyperliquid. Also the client's unlock and habit helpers.
import { readFileSync, mkdtempSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { t, ok, eq, near, report, makeExtractor, storedText } from './harness.mjs';

const require = createRequire(import.meta.url);
const S = require('../social.js');
const server = require('../server.js');
const htmlPath = new URL('../ledger.html', import.meta.url).pathname;
const html = readFileSync(htmlPath, 'utf8');
const { grabFn } = makeExtractor(html);

console.log('\nValidation');
t('stats are clamped and filtered: bad days, badges and oversized text never get stored', () => {
  const s = S.sanitizeStats({ xp: -5, level: 9999, streak: 'x', week: 'nope', weekXp: 1e9,
    days: [{ k: '2026-09-01', s: 180, b: 1, j: 0 }, { k: 'bad', s: 50 }], badges: [{ id: 'ok-1', t: 'Fine' }, { id: 'BAD ID', t: 'x' }],
    habits: ['a'.repeat(500), '', 'b', 'c', 'd', 'e', 'f'] });
  eq(s.xp, 0); eq(s.level, 500); eq(s.streak, 0); eq(s.week, null); eq(s.weekXp, 1e6);
  eq(s.days, [{ k: '2026-09-01', s: 100, b: true, j: false }]);
  eq(s.badges, [{ id: 'ok-1', t: 'Fine', c: '', r: 0, k: null, d: '' }]);
  eq(s.habits.length, 5); eq(s.habits[0].length, 140);
});
t('sharing defaults keep money and the address private', () => {
  const sh = S.sanitizeShare({ usd: true, profile: 'yes' });
  eq(sh, { profile: true, boards: true, global: false, page: false, feed: true, habits: true, verify: true, ret: false, usd: true, addr: false, mentor: false });
});
t('a sharing key added later (verify) stays off for existing members until they switch it on', () => {
  const old = { profile: true, boards: true, feed: true, habits: true, ret: false, usd: false, addr: false };
  eq(S.sanitizeShare({}, old).verify, false);
  eq(S.sanitizeShare({ verify: true }, old).verify, true);
  eq(S.sanitizeShare({}, undefined).verify, true, 'new members get the default');
});
t('competitions need a known type, a title and a window of at most 92 days', () => {
  ok(!S.sanitizeComp({ type: 'lottery', title: 'x', start: '2026-10-01', end: '2026-10-07' }));
  ok(!S.sanitizeComp({ type: 'discipline', title: 'x', start: '2026-10-07', end: '2026-10-01' }));
  ok(!S.sanitizeComp({ type: 'discipline', title: 'x', start: '2026-01-01', end: '2026-06-01' }));
  const c = S.sanitizeComp({ type: 'return', title: 'Sprint', start: '2026-10-01', end: '2026-10-14' });
  eq(c.ddCap, 0.08); eq(c.minDays, 3);
  eq(S.sanitizeComp({ type: 'journal', title: 'J', start: '2026-10-01', end: '2026-10-30' }).minDays, 10);
});

console.log('\nFeed events');
const base = S.sanitizeStats({ xp: 900, level: 2, streak: 6, badges: [{ id: 'a', t: 'A' }], habits: ['When x, y.'], challengesDone: 1 });
t('milestones become feed posts: level, streak marks, new badges, challenges and habits', () => {
  const next = S.sanitizeStats({ xp: 1300, level: 3, streak: 7, badges: [{ id: 'a', t: 'A' }, { id: 'b', t: 'Walked away' }],
    habits: ['When x, y.', 'When I lose twice, I stop.'], challengesDone: 2, lastChallenge: 'When done, stop.' });
  const E = S.eventsFromStats(base, next, S.sanitizeShare({}));
  eq(E.map(e => e.type), ['level', 'streak', 'badge', 'challenge', 'habit']);
  eq(E[1].text, 'hit a 7-day discipline streak'); eq(E[2].text, 'unlocked Walked away'); eq(E[4].quote, 'When I lose twice, I stop.');
});
t('no posts on a first sync, with the feed off, or for habits kept private', () => {
  const next = S.sanitizeStats({ level: 5, habits: ['When a, b.'] });
  eq(S.eventsFromStats(null, next, S.sanitizeShare({})), []);
  eq(S.eventsFromStats(base, next, S.sanitizeShare({ feed: false })), []);
  eq(S.eventsFromStats(base, next, S.sanitizeShare({ habits: false })).map(e => e.type), ['level']);
});

console.log('\nReturns from the chain');
const port = (av, pnl) => [['month', { accountValueHistory: av, pnlHistory: pnl }]];
t('return and drawdown come from the P&L series, so deposits count as neither', () => {
  // 1000 start, +200 deposit on day 2 (account value jumps, P&L doesn't), dip of 50 then +100 overall
  const r = S.portfolioStats(port([[1, '1000'], [2, '1200'], [3, '1150'], [4, '1300']], [[1, '0'], [2, '0'], [3, '-50'], [4, '100']]), 'month');
  near(r.ret, 0.1, 1e-9); near(r.dd, 0.05, 1e-9); eq(r.usd, 100);
  eq(S.portfolioStats(port([[1, '0']], [[1, '0'], [2, '5']]), 'month'), null, 'no starting equity, no ratio');
  eq(S.portfolioStats([], 'month'), null);
});
t('a competition window clips the series', () => {
  const r = S.portfolioStats(port([[1, '1000'], [5, '1000']], [[1, '0'], [2, '-100'], [3, '0'], [4, '50']]), 'month', 3, 4);
  near(r.ret, 0.05, 1e-9); eq(r.dd, 0);
});

console.log('\nLeague');
t('each week the top quarter (max 5) with XP moves up and the bottom quarter moves down', () => {
  const mk = (id, tier, xp) => ({ id, tier, weekXp: { '2026-W40': xp } });
  const M = [mk('a', 1, 500), mk('b', 1, 400), mk('c', 1, 300), mk('d', 1, 200), mk('e', 1, 100), mk('f', 1, 50), mk('g', 1, 0), mk('h', 1, 0),
    mk('x', 0, 10), mk('y', 0, 0), mk('z', 0, 0), mk('w', 0, 0)];
  const mv = S.leagueRollover(M, '2026-W40');
  eq(mv.filter(m => m.from === 1 && m.to === 2).map(m => m.id), ['a', 'b']);
  eq(mv.filter(m => m.from === 1 && m.to === 0).map(m => m.id).sort(), ['g', 'h']);
  eq(mv.filter(m => m.from === 0).map(m => m.id), ['x'], 'bronze: nobody drops, zero XP never promotes');
  eq(S.leagueRollover([mk('a', 0, 9), mk('b', 0, 1)], '2026-W40'), [], 'under four traders: no moves');
});
t('sitting a week out counts as zero XP: idle members drop before active ones', () => {
  const act = (id, xp) => ({ id, tier: 1, weekXp: { '2026-W40': xp } }), idle = id => ({ id, tier: 1, weekXp: {} });
  const mv = S.leagueRollover([act('a', 50), act('b', 40), act('c', 30), act('d', 5), idle('w'), idle('x'), idle('y'), idle('z')], '2026-W40');
  eq(mv.filter(m => m.to === 0).map(m => m.id).sort(), ['y', 'z']);
  ok(!mv.some(m => m.id === 'd' && m.to === 0), 'the active trader with 5 XP stays');
});

console.log('\nBoards and competitions');
const day = (k, s, b, j) => ({ k, s, b: !!b, j: !!j });
const members = [
  { id: '1', handle: 'alpha', tier: 0, share: S.sanitizeShare({ ret: true }), stats: S.sanitizeStats({ xp: 5000, level: 5, streak: 3, days: [day('2026-09-28', 90), day('2026-09-29', 80), day('2026-09-30', 70)] }),
    vdays: [day('2026-09-28', 90), day('2026-09-29', 80), day('2026-09-30', 70)], money: { ret: 0.2, dd: 0.3, usd: 900 }, weekXp: { '2026-W40': 300 } },
  { id: '2', handle: 'bravo', tier: 0, share: S.sanitizeShare({ ret: true }), stats: S.sanitizeStats({ xp: 900, level: 2, streak: 9, days: [day('2026-09-29', 60), day('2026-09-30', 100)] }),
    vdays: [day('2026-09-29', 60), day('2026-09-30', 100)], money: { ret: 0.05, dd: 0.02, usd: 50 }, weekXp: { '2026-W40': 500 } },
  { id: '4', handle: 'delta', tier: 0, share: S.sanitizeShare({}), stats: S.sanitizeStats({ xp: 10, days: [day('2026-09-28', 100), day('2026-09-29', 100), day('2026-09-30', 100)] }), weekXp: {} },
  { id: '3', handle: 'charlie', tier: 1, share: S.sanitizeShare({ boards: false }), stats: S.sanitizeStats({ xp: 99999, streak: 99 }), weekXp: { '2026-W40': 999 } },
];
const opts = { todayKey: '2026-09-30', week: '2026-W40', tier: 0 };
t('process boards skip people who opted out; discipline counts only server-verified days (3 minimum)', () => {
  eq(S.boardRows(members, 'xp', opts).map(r => r.handle), ['bravo', 'alpha', 'delta']);
  eq(S.boardRows(members, 'streak', opts).map(r => [r.handle, r.value]), [['bravo', 9], ['alpha', 3], ['delta', 0]]);
  eq(S.boardRows(members, 'discipline', opts).map(r => [r.handle, r.value]), [['alpha', 80]], 'delta’s self-posted 100s never reach the board');
  eq(S.boardRows(members.map(m => m.id === '1' ? { ...m, share: { ...m.share, verify: false } } : m), 'discipline', opts), [], 'verification off: off the board');
});
t('money boards: over 25% drawdown leaves % return; return/drawdown ranks the careful trader first', () => {
  eq(S.boardRows(members, 'ret', opts).map(r => r.handle), ['bravo']);
  eq(S.boardRows(members, 'riskadj', opts).map(r => r.handle), ['bravo', 'alpha']);
  eq(S.boardRows(members, 'usd', opts), [], 'nobody opted in to dollars');
});
t('competition standings for each type', () => {
  const ent = { entrants: { 1: {}, 2: {} }, start: '2026-09-28', end: '2026-10-04' };
  const disc = S.compStandings({ ...ent, type: 'discipline', minDays: 3 }, members, '2026-09-30');
  eq(disc.map(r => [r.handle, r.score]), [['alpha', 80], ['bravo', null]]);
  const unv = S.compStandings({ ...ent, entrants: { 4: {} }, type: 'discipline', minDays: 1 }, members, '2026-09-30');
  eq(unv[0].score, null); eq(unv[0].note, 'Needs a wallet to verify', 'unverified entrants don’t score, and are told why');
  ok(/2 of 3 trading days/.test(disc[1].note));
  const m2 = members.map(m => m.id === '1' ? { ...m, stats: { ...m.stats, days: [day('2026-09-28', 90), day('2026-09-29', 80, true)] } } : m);
  const surv = S.compStandings({ ...ent, type: 'survivor' }, m2, '2026-09-30');
  eq(surv.map(r => [r.handle, r.out]), [['bravo', false], ['alpha', true]]);
  const m3 = members.map(m => m.id === '2' ? { ...m, stats: { ...m.stats, days: [day('2026-09-28', 1, 0, 1), day('2026-09-29', 1, 0, 1), day('2026-09-30', 1, 0, 0)] } } : m);
  eq(S.compStandings({ ...ent, type: 'journal', minDays: 2 }, m3, '2026-09-30').map(r => [r.handle, r.score]), [['bravo', 2], ['alpha', 0]]);
  const ret = S.compStandings({ ...ent, type: 'return', ddCap: 0.08, money: { 1: { ret: 0.3, dd: 0.1 }, 2: { ret: 0.01, dd: 0.01 } } }, members, '2026-09-30');
  eq(ret.map(r => [r.handle, r.out]), [['bravo', false], ['alpha', true]], 'over the drawdown cap finishes last');
});

console.log('\nHTTP');
const listen = app => new Promise(res => app.listen(0, () => res('http://127.0.0.1:' + app.address().port)));
const PORT = port([[Date.parse('2026-09-01'), '1000'], [Date.parse('2026-09-30'), '1100']], [[Date.parse('2026-09-01'), '0'], [Date.parse('2026-09-15'), '-20'], [Date.parse('2026-09-30'), '100']]);
let hlCalls = 0;
// alpha's public fills: two clean days, then a loss and a re-entry five minutes later (a revenge
// entry) — so the server's verified Discipline is 100, 100, 50
const ALPHA = '0x' + 'a'.repeat(40);
const fl = (side, sz, px, startPosition, closedPnl, iso, i) => ({ coin: 'ETH', side, sz: String(sz), px: String(px), startPosition: String(startPosition),
  closedPnl: String(closedPnl), fee: '0', crossed: true, time: Date.parse(iso), tid: i, oid: i });
const FILLS = [fl('B', 1, 100, 0, 0, '2026-09-28T10:00:00Z', 1), fl('A', 1, 110, 1, 10, '2026-09-28T11:00:00Z', 2),
  fl('B', 1, 100, 0, 0, '2026-09-29T10:00:00Z', 3), fl('A', 1, 110, 1, 10, '2026-09-29T11:00:00Z', 4),
  fl('B', 1, 100, 0, 0, '2026-09-30T09:00:00Z', 5), fl('A', 1, 90, 1, -10, '2026-09-30T10:00:00Z', 6),
  fl('B', 1, 95, 0, 0, '2026-09-30T10:05:00Z', 7), fl('A', 1, 96, 1, 1, '2026-09-30T10:35:00Z', 8)];
let slowFor = null;
const fetchImpl = async (url, o) => { hlCalls++; const b = JSON.parse(o.body);
  if (slowFor && String(b.user).toLowerCase() === slowFor && b.type === 'userFillsByTime') await new Promise(r => setTimeout(r, 250));
  const out = b.type === 'portfolio' ? PORT
    : b.type === 'userFillsByTime' && String(b.user).toLowerCase() === ALPHA ? FILLS.filter(f => f.time >= (b.startTime || 0)) : [];
  return { ok: true, status: 200, json: async () => out }; };
let clock = Date.parse('2026-09-30T12:00:00Z');
const dataDir = mkdtempSync(join(tmpdir(), 'ledger-social-'));
const app = server.createApp({ dataDir, auth: 'owner-token', htmlPath, fetchImpl, now: () => clock });
const B = await listen(app);
const call = async (p, o = {}) => { const r = await fetch(B + '/api/social' + p, { ...o, headers: { 'Content-Type': 'application/json', ...(o.key ? { 'X-Pulse-Key': o.key } : {}), ...(o.admin ? { Authorization: 'Bearer owner-token' } : {}) }, body: o.body ? JSON.stringify(o.body) : undefined });
  return { status: r.status, d: await r.json() }; };
const tick = () => new Promise(r => setTimeout(r, 30));
let A, Bk;
try {
  // competitions unlock at level 4 by default; these tests join at level 1
  await call('/admin/config', { method: 'PUT', admin: true, body: { unlocksOn: false } });
  await t('joining: names are validated and unique; the key is returned once and only its hash is stored', async () => {
    eq((await call('/join', { method: 'POST', body: { handle: 'no spaces' } })).status, 400);
    const a = await call('/join', { method: 'POST', body: { handle: 'alpha_1', address: '0x' + 'a'.repeat(40), share: { ret: true } } });
    eq(a.status, 200); ok(a.d.key && a.d.key.length === 48); A = a.d.key;
    eq((await call('/join', { method: 'POST', body: { handle: 'ALPHA_1' } })).status, 409);
    const b = await call('/join', { method: 'POST', body: { handle: 'bravo' } }); Bk = b.d.key;
    const raw = storedText(dataDir);
    ok(!raw.includes(A) && !raw.includes(Bk), 'keys are never written');
    eq((await call('/me')).status, 401);
    eq((await call('/me', { key: A })).d.me.handle, 'alpha_1');
  });
  await t('returns are read on chain for opted-in members only', async () => {
    await tick();
    ok(hlCalls >= 1, 'portfolio fetched for alpha');
    const lb = await call('/leaderboard?board=ret', { key: Bk });
    eq(lb.d.rows.map(r => r.handle), ['alpha_1']); near(lb.d.rows[0].value, 0.1, 1e-9);
    eq(lb.d.optedIn, false, 'bravo is told they are not on the board');
  });
  await t('stats posts feed the league, the boards and the feed', async () => {
    const st = (xp, level, streak) => ({ xp, level, week: '2026-W40', weekXp: xp / 10, streak, best: streak,
      days: [{ k: '2026-09-28', s: 90 }, { k: '2026-09-29', s: 80 }, { k: '2026-09-30', s: 70 }] });
    eq((await call('/stats', { method: 'POST', key: A, body: st(1000, 2, 6) })).status, 200);
    await call('/stats', { method: 'POST', key: A, body: st(1300, 3, 7) });
    await call('/stats', { method: 'POST', key: Bk, body: st(500, 2, 1) });
    const lg = await call('/league', { key: A });
    eq(lg.d.rows.map(r => [r.handle, r.value, r.me]), [['alpha_1', 130, true], ['bravo', 50, false]]);
    const disc = await call('/leaderboard?board=discipline', { key: A });
    eq(disc.d.rows.map(r => [r.handle, r.value]), [['alpha_1', 83]], 'the board shows the score recomputed from fills (100, 100, 50), not the posted 90/80/70');
    ok(/^verified/.test(disc.d.rows[0].sub));
    const bl = (await call('/leaderboard?board=discipline', { key: Bk })).d;
    eq(bl.optedIn, true); eq(bl.verifyState, 'no-wallet', 'bravo is told to add a wallet, not left waiting');
    const feed = await call('/feed?scope=discover', { key: Bk });
    ok(feed.d.events.some(e => e.handle === 'alpha_1' && e.text === 'reached level 3 · Journeyman'));
    ok(feed.d.events.some(e => e.text === 'hit a 7-day discipline streak'));
  });
  await t('following, the following feed, kudos (never on your own post) and profiles', async () => {
    eq((await call('/feed', { key: Bk })).d.events.filter(e => e.handle === 'alpha_1').length, 0);
    eq((await call('/follow/alpha_1', { method: 'POST', key: Bk })).d.following, true);
    const f = await call('/feed', { key: Bk });
    const ev = f.d.events.find(e => e.handle === 'alpha_1'); ok(ev);
    eq((await call('/kudos/' + ev.id, { method: 'POST', key: Bk })).d, { kudos: 1, liked: true });
    eq((await call('/kudos/' + ev.id, { method: 'POST', key: A })).status, 400);
    const p = await call('/profile/alpha_1', { key: Bk });
    eq(p.d.profile.isFollowing, true); eq(p.d.profile.followers, 1); eq(p.d.profile.address, undefined, 'address stays hidden');
    near(p.d.profile.ret, 0.1, 1e-9);
    eq((await call('/profile/alpha_1', { key: A })).d.profile.address, '0x' + 'a'.repeat(40), 'you see your own');
    await call('/me', { method: 'PUT', key: A, body: { share: { profile: false } } });
    eq((await call('/profile/alpha_1', { key: Bk })).d.profile.private, true);
  });
  await t('admin needs the owner token; competitions, join rules and standings', async () => {
    eq((await call('/admin/overview')).status, 401);
    eq((await call('/admin/overview', { key: A })).status, 401, 'a member key is not admin');
    const mk = await call('/admin/competitions', { method: 'POST', admin: true, body: { title: 'Cup', type: 'discipline', start: '2026-09-28', end: '2026-10-04', minDays: 2 } });
    eq(mk.status, 200);
    const rc = await call('/admin/competitions', { method: 'POST', admin: true, body: { title: 'Sprint', type: 'return', start: '2026-09-01', end: '2026-10-10' } });
    eq((await call('/competitions/' + rc.d.id + '/join', { method: 'POST', key: Bk })).status, 400, 'return comps need an address and opted-in returns');
    eq((await call('/competitions/' + mk.d.id + '/join', { method: 'POST', key: A })).d.joined, true);
    await call('/competitions/' + mk.d.id + '/join', { method: 'POST', key: Bk });
    const c = await call('/competitions/' + mk.d.id, { key: Bk });
    eq(c.d.competition.standings.map(r => [r.handle, r.score]), [['alpha_1', 83], ['bravo', null]], 'only verified days score');
    eq(c.d.competition.me.rank, 2);
    const list = await call('/competitions', { key: A });
    eq(list.d.competitions.length, 2); ok(list.d.competitions.find(x => x.id === mk.d.id).joined);
  });
  await t('owner moderation: suspend hides a member everywhere; config changes reach /config', async () => {
    const ms = await call('/admin/members', { admin: true });
    const b = ms.d.members.find(m => m.handle === 'bravo');
    await call('/admin/members/' + b.id, { method: 'POST', admin: true, body: { action: 'ban' } });
    eq((await call('/me', { key: Bk })).status, 403);
    eq((await call('/league', { key: A })).d.rows.map(r => r.handle), ['alpha_1']);
    await call('/admin/config', { method: 'PUT', admin: true, body: { open: false, unlocks: { trends: 5 } } });
    const cfg = (await call('/config')).d;
    eq(cfg.open, false); eq(cfg.unlocks.trends, 5);
    eq((await call('/join', { method: 'POST', body: { handle: 'late' } })).status, 403);
    await call('/admin/announce', { method: 'POST', admin: true, body: { text: 'Survivor starts Monday' } });
    const ev = await call('/admin/events', { admin: true });
    const ann = ev.d.events.find(e => e.text === 'Survivor starts Monday'); ok(ann && ann.admin);
    eq((await call('/admin/events/' + ann.id, { method: 'DELETE', admin: true })).status, 200);
  });
  await t('a new week runs promotion once, on the first request', async () => {
    await call('/admin/config', { method: 'PUT', admin: true, body: { open: true } });
    const keys = [];
    for (const h of ['carl1', 'carl2', 'carl3']) keys.push((await call('/join', { method: 'POST', body: { handle: h } })).d.key);
    for (let i = 0; i < 3; i++) await call('/stats', { method: 'POST', key: keys[i], body: { xp: 10, level: 1, week: '2026-W40', weekXp: i * 10 } });
    clock = Date.parse('2026-10-06T12:00:00Z'); // Tuesday of W41
    await call('/config');
    const me = await call('/me', { key: A });
    eq(me.d.tier, 1, 'alpha had the most XP in Bronze and moved up to Silver');
    const again = await call('/me', { key: A }); eq(again.d.tier, 1, 'no second promotion in the same week');
  });
  await t('opting out of returns hides your return-competition result too', async () => {
    const k = (await call('/join', { method: 'POST', body: { handle: 'rita', address: '0x' + 'c'.repeat(40), share: { ret: true } } })).d.key;
    await tick();
    const rc = await call('/admin/competitions', { method: 'POST', admin: true, body: { title: 'Ret', type: 'return', start: '2026-09-10', end: '2026-10-08' } });
    eq((await call('/competitions/' + rc.d.id + '/join', { method: 'POST', key: k })).d.joined, true); await tick();
    const before = (await call('/competitions/' + rc.d.id, { key: A })).d.competition.standings.find(r => r.handle === 'rita');
    ok(/%/.test(before.note), 'visible while opted in: ' + before.note);
    await call('/me', { method: 'PUT', key: k, body: { share: { ret: false } } });
    const after = (await call('/competitions/' + rc.d.id, { key: A })).d.competition.standings.find(r => r.handle === 'rita');
    ok(!/%/.test(after.note), 'hidden after opting out: ' + after.note);
    eq((await call('/admin/members', { admin: true })).d.members.find(m => m.handle === 'rita').address, '0x' + 'c'.repeat(40), 'the address stays until the client clears it');
    await call('/me', { method: 'PUT', key: k, body: { address: null } });
    eq((await call('/admin/members', { admin: true })).d.members.find(m => m.handle === 'rita').address, null);
  });
  await t('malformed requests get a 400 or 404, never an internal error, and prototype keys resolve to nothing', async () => {
    eq((await call('/join', { method: 'POST', body: null })).status, 400);
    const r = await fetch(B + '/api/social/join', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '[1,2]' }); eq(r.status, 400);
    eq((await call('/me', { method: 'PUT', key: A, body: 7 })).status, 400);
    eq((await call('/profile/%E0%A4%A', { key: A })).status, 400);
    eq((await call('/competitions/__proto__', { key: A })).status, 404);
    eq((await call('/competitions/constructor/join', { method: 'POST', key: A })).status, 404);
    eq((await call('/admin/members/__proto__', { method: 'POST', admin: true, body: { action: 'ban' } })).status, 404);
    eq(({}).banned, undefined, 'Object.prototype untouched');
    const j = await call('/join', { method: 'POST', body: { handle: 'arrayaddr', address: ['0x' + 'e'.repeat(40)] } });
    eq((await call('/admin/members', { admin: true })).d.members.find(m => m.handle === 'arrayaddr').address, null);
    await call('/me', { method: 'DELETE', key: j.d.key });
  });
  await t('a member can’t flood the feed, and habit posts repeat only for new habits', async () => {
    const k = (await call('/join', { method: 'POST', body: { handle: 'spammer' } })).d.key;
    await call('/stats', { method: 'POST', key: k, body: { level: 1 } });
    for (let i = 0; i < 25; i++) await call('/stats', { method: 'POST', key: k, body: { level: 1, habits: ['When ' + i + ', stop.'] } });
    const ev = (await call('/admin/events', { admin: true })).d.events.filter(e => e.handle === 'spammer');
    ok(ev.length <= 12, ev.length + ' posts in a day');
    await call('/me', { method: 'DELETE', key: k });
  });
  await t('kudos only on posts you can see', async () => {
    const k = (await call('/join', { method: 'POST', body: { handle: 'ghost', share: { feed: true } } })).d.key;
    const ev = (await call('/admin/events', { admin: true })).d.events.find(e => e.handle === 'ghost');
    const id = (await call('/admin/members', { admin: true })).d.members.find(m => m.handle === 'ghost').id;
    await call('/admin/members/' + id, { method: 'POST', admin: true, body: { action: 'ban' } });
    eq((await call('/kudos/' + ev.id, { method: 'POST', key: A })).status, 404);
    await call('/admin/members/' + id, { method: 'POST', admin: true, body: { action: 'remove' } });
    void k;
  });
  await t('verification follows a wallet change made mid-fetch, and scores days on the member’s own clock', async () => {
    slowFor = ALPHA;
    const k = (await call('/join', { method: 'POST', body: { handle: 'switcher', address: ALPHA } })).d.key;
    await call('/me', { method: 'PUT', key: k, body: { address: '0x' + 'f'.repeat(40) } });
    await new Promise(r => setTimeout(r, 400)); slowFor = null;
    await call('/leaderboard?board=discipline', { key: k }); await tick();
    const m = (await call('/admin/members', { admin: true })).d.members.find(x => x.handle === 'switcher');
    eq(m.address, '0x' + 'f'.repeat(40));
    const lb = (await call('/leaderboard?board=discipline', { key: k })).d;
    ok(!lb.rows.some(r => r.handle === 'switcher'), 'the old wallet’s score never lands on the new one');
    await call('/me', { method: 'DELETE', key: k });
    // same fills, New York clock: the 09:00–10:35 UTC trades on the 30th stay on the 30th, and the
    // 10:00/11:00 UTC trades on the 28th and 29th stay put; a 02:00 UTC trade would move a day back
    clock += 2 * 3600000; // past the five-joins-an-hour limit this suite has used up
    const ny = (await call('/join', { method: 'POST', body: { handle: 'newyorker', address: ALPHA } })).d.key;
    await call('/stats', { method: 'POST', key: ny, body: { level: 1, tz: 'America/New_York' } });
    await call('/me', { method: 'PUT', key: ny, body: { share: { verify: false } } });
    await call('/me', { method: 'PUT', key: ny, body: { share: { verify: true } } }); await tick(); await tick();
    const prof = (await call('/profile/newyorker', { key: ny })).d.profile;
    eq(prof.verified, true);
    await call('/me', { method: 'DELETE', key: ny });
  });
  await t('leaving deletes the profile, posts and entries', async () => {
    eq((await call('/me', { method: 'DELETE', key: A })).status, 200);
    eq((await call('/me', { key: A })).status, 401);
    ok(!storedText(dataDir).includes('alpha_1'));
  });
} finally { await new Promise(res => app.close(res)); }
await t('with no AUTH_TOKEN the admin API refuses instead of opening to everyone', async () => {
  const open = server.createApp({ dataDir: mkdtempSync(join(tmpdir(), 'ledger-social-')), auth: '', htmlPath, fetchImpl });
  const b = await listen(open);
  try { eq((await fetch(b + '/api/social/admin/overview')).status, 403);
    eq((await (await fetch(b + '/api/social/config')).json()).enabled, false, 'the league reports closed');
    eq((await fetch(b + '/api/social/join', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ handle: 'friend' }) })).status, 403,
      'no joining while the owner’s journal is open to anyone');
    const pg = await fetch(b + '/admin'); eq(pg.status, 200); ok((await pg.text()).includes('Pulse admin')); }
  finally { await new Promise(res => open.close(res)); }
});

console.log('\nClient helpers');
const ctx = { Math, Object, Array, String, JSON, Intl, settings: { tz: "utc" } };
vm.createContext(ctx);
vm.runInContext('const PZ_UNLOCK_DEFAULTS=' + html.slice(html.indexOf('const PZ_UNLOCK_DEFAULTS=') + 25, html.indexOf(';\n', html.indexOf('const PZ_UNLOCK_DEFAULTS='))) + ';\n'
  + ['pzNeeds', 'socHabitSpec', 'pzSocialStats', 'pzClockZone'].map(grabFn).join('\n') + '\nfunction habitSentence(s){ return "When "+s.when+", "+s.then+"."; }', ctx);
t('unlock levels: owner settings, off switch and sample data', () => {
  eq(ctx.pzNeeds('trends', 1), 2); eq(ctx.pzNeeds('trends', 2), 0);
  eq(ctx.pzNeeds('compete', 3, { unlocksOn: true, unlocks: { compete: 6 } }), 6);
  eq(ctx.pzNeeds('compete', 1, { unlocksOn: false, unlocks: { compete: 6 } }), 0);
  eq(ctx.pzNeeds('trends', 1, undefined, true), 0, 'sample data shows everything');
  eq(ctx.pzNeeds('unknown', 1), 0);
});
t('a shared habit sentence becomes a self-graded habit', () => {
  eq(ctx.socHabitSpec('When I close two losing trades in a row, I stop for the day.'), { kind: 'self', when: 'I close two losing trades in a row', then: 'I stop for the day' });
  eq(ctx.socHabitSpec('Always use a stop.').then, 'Always use a stop');
});
t('only process numbers go out: no trades, notes, P&L or addresses in the stats payload', () => {
  const g = { xp: { total: 1234 }, level: { level: 3 }, nowWeek: '2026-W40', weekXp: 210, streak: { current: 4, best: 9, shields: 1 },
    challenges: [{ status: 'done', ch: { spec: { when: 'a', then: 'b' } } }, { status: 'missed' }],
    achievements: [{ id: 'x', title: 'X', at: '2026-09-01' }, { id: 'y', title: 'Y', at: null }],
    days: [{ key: '2026-09-30', score: 88, breached: false, parts: { journal: 1 }, net: -500, n: 3 }] };
  const p = ctx.pzSocialStats(g, ['When a, b.']);
  eq(Object.keys(p).sort(), ['badgeN', 'badgeTotal', 'badges', 'best', 'challengesDone', 'days', 'habits', 'lastChallenge', 'level', 'shields', 'streak', 'tz', 'week', 'weekXp', 'xp', 'xpDays']);
  eq(p.days, [{ k: '2026-09-30', s: 88, b: false, j: true }], 'a day carries its score and flags — never its P&L');
  eq(p.badges, [{ id: 'x', t: 'X' }]); eq(p.lastChallenge, 'When a, b.');
});
t('the wallet address goes to the server only when a money toggle or “show address” needs it', () => {
  const c2 = { settings: { wallets: [{ address: '0xabc' }] } }; vm.createContext(c2); vm.runInContext(grabFn('socAddressFor'), c2);
  eq(c2.socAddressFor({ profile: true, boards: true }), null);
  eq(c2.socAddressFor({ ret: true }), '0xabc'); eq(c2.socAddressFor({ addr: true }), '0xabc');
  c2.settings.wallets = []; eq(c2.socAddressFor({ ret: true }), null);
  ok(!/address:w\?w\.address/.test(grabFn('socAction')), 'join and save go through socAddressFor');
});
t('adopting the same shared habit twice keeps one copy', () => {
  ok(grabFn('adoptHabit').includes('h.when===String(spec.when'));
});
t('Pulse never posts sample data, and routes profiles and competitions by hash', () => {
  ok(grabFn('socSync').includes('pzS.demo') && grabFn('socSync').includes('!settings.wallets.length'));
  ok(grabFn('pzTab').includes("return 'profile'") && grabFn('pzTab').includes("return 'comp'"));
  ok(existsSync(new URL('../admin.html', import.meta.url).pathname));
});

report('social');
