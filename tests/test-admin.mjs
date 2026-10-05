// The owner's controls (v0.4): configurable levels, XP, feature levels and coach allowance; leagues
// you can create, search and join several of; reward badges; making, editing and boosting members;
// opt-in global leaderboards; league-only competitions. Over real HTTP with a stubbed Hyperliquid.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { t, ok, eq, report, xpLogFor } from './harness.mjs';
import { readAppSource } from '../app-source.js'; // ledger.html with its app/*.js inlined, in load order

const require = createRequire(import.meta.url);
const SC = require('../social-config.js');
const S = require('../social.js');
const server = require('../server.js');
const htmlPath = new URL('../ledger.html', import.meta.url).pathname;

console.log('\nConfig');
t('levels: a curve or a table of thresholds, with custom titles', () => {
  const c = SC.sanitizeLevels({}, null);
  eq([SC.levelStart(c, 1), SC.levelStart(c, 2), SC.levelStart(c, 3), SC.levelStart(c, 5)], [0, 400, 1200, 4000]);
  eq(SC.levelOf(c, 1199), 2); eq(SC.levelOf(c, 1200), 3);
  const tb = SC.sanitizeLevels({ mode: 'table', thresholds: '100, 300, 250, 900, x', titles: 'Pup\nWolf\n\nAlpha' }, c);
  eq(tb.thresholds, [100, 300, 900], 'ascending only'); eq(tb.titles, ['Pup', 'Wolf', 'Alpha']);
  eq([SC.levelOf(tb, 99), SC.levelOf(tb, 100), SC.levelOf(tb, 5000)], [1, 2, 4]);
  eq(SC.sanitizeLevels({ mode: 'table', thresholds: [] }, c).mode, 'curve', 'an empty table falls back to the curve');
});
t('XP weights, feature levels and the coach allowance are clamped', () => {
  const x = SC.sanitizeXp({ discipline: 9, checkin: -5, review: '40', bogus: 1 }, null);
  eq([x.discipline, x.checkin, x.review, x.bogus], [5, 0, 40, undefined]);
  const m = SC.sanitizeModules({ coach: 0, deep: 7, nope: 3 }, null); eq([m.coach, m.deep, m.nope, m.trends], [1, 7, undefined, 2]);
  const co = SC.sanitizeCoachCfg({ daily: 9999, members: false, detail: 'yes' }, null); eq([co.daily, co.members, co.detail], [500, false, true]);
});
t('custom profiles and question overrides', () => {
  const p = SC.sanitizeProfiles({ custom: [{ name: 'Night owl', base: 'scalper', eod: ['What woke you up?', ''] }, { name: '' }, { id: 'day', name: 'Clash' }],
    overrides: { swing: { eod: ['Thesis intact?'] }, hacker: { eod: ['x'] } } }, null);
  eq(p.custom.map(x => [x.id.replace(/-\d+$/, '-n'), x.base, x.eod.length]), [['night-owl', 'scalper', 1], ['day-n', 'day', 0]], 'a clash with a built-in id gets a suffix');
  eq(Object.keys(p.overrides), ['swing']);
});
t('badges and leagues', () => {
  const b = SC.sanitizeBadge({ name: 'Iron hands', icon: '🛡️🛡️🛡️', metric: 'streak', value: '20', xp: 99999 }, null);
  eq([b.metric, b.value, b.xp, Array.from(b.icon).length <= 2], ['streak', 20, 10000, true]);
  eq(SC.sanitizeBadge({ name: 'Manual', metric: 'nope' }).metric, null, 'unknown measure = awarded by hand');
  const L = SC.sanitizeLeague({ name: 'Disciplined', metric: 'discipline', period: 'month' }, null);
  eq([L.metric, L.period, L.tiers, L.open], ['discipline', 'month', false, true]);
});
t('rollover by any measure', () => {
  const E = [['a', 50], ['b', 40], ['c', 0], ['d', 10]].map(([id, value]) => ({ id, tier: 1, value }));
  eq(S.leagueRolloverBy(E), [{ id: 'a', from: 1, to: 2 }, { id: 'c', from: 1, to: 0 }]);
  eq(S.isoWeekMonday('2026-W40'), '2026-09-28');
});

console.log('\nHTTP');
const listen = app => new Promise(res => app.listen(0, () => res('http://127.0.0.1:' + app.address().port)));
const fetchImpl = async () => ({ ok: true, status: 200, json: async () => [] });
let clock = Date.parse('2026-09-30T12:00:00Z');
// a v0.3 data file: two members, tiers, no leagues yet
const dataDir = mkdtempSync(join(tmpdir(), 'ledger-admin-'));
writeFileSync(join(dataDir, 'social.json'), JSON.stringify({ v: 1, config: { unlocks: { trends: 3, share: 3, compete: 6 } }, follows: {}, events: [], comps: {}, league: { week: '2026-W40' },
  members: { aa11: { id: 'aa11', handle: 'oldtimer', keyHash: 'x', createdAt: 1, tier: 2, share: S.sanitizeShare({}), stats: null, weekXp: {} } } }));
const app = server.createApp({ dataDir, auth: 'owner-token', htmlPath, fetchImpl, now: () => clock });
const B = await listen(app);
const call = async (p, o = {}) => { const r = await fetch(B + '/api/social' + p, { method: o.method || 'GET',
    headers: { 'Content-Type': 'application/json', ...(o.key ? { 'X-Pulse-Key': o.key } : {}), ...(o.admin ? { Authorization: 'Bearer owner-token' } : {}) },
    body: o.body !== undefined ? JSON.stringify(o.body) : undefined });
  return { status: r.status, d: await r.json() }; };
const adm = (p, method, body) => call('/admin' + p, { method, body, admin: true });
// a member at some XP: the day parts that add up to it (the server works out the XP and level; the ones sent are ignored)
const st = (level, xp, extra) => Object.assign({ xp, level, week: '2026-W40', streak: 3, best: 5, days: [], xpLog: xpLogFor(xp, new Date(clock).toISOString().slice(0, 10)) }, extra || {});
let A, Bk, Cid;
try {
  await t('a v0.3 league becomes the main league, numbered, with everyone in it at their tier; old unlock levels carry over', async () => {
    const cfg = (await call('/config')).d;
    eq([cfg.modules.trends, cfg.modules.compete, cfg.modules.coach], [3, 6, 1]);
    eq(cfg.levels.titles[0], 'Rookie'); eq(cfg.xp.review, 15);
    const L = (await adm('/leagues', 'GET')).d.leagues;
    eq(L.map(x => [x.id, x.num, x.metric, x.tiers, x.autoJoin]), [['main', 1001, 'xp', true, true]]);
    eq(L[0].roster, [{ id: 'aa11', handle: 'oldtimer', tier: 2 }]);
  });
  await t('the owner creates a member; they sign in with the 7-day code and land in the auto-join leagues', async () => {
    const r = await adm('/members', 'POST', { handle: 'invitee', unlocked: true });
    eq(r.status, 200); ok(/^[A-Z2-9]{10}$/.test(r.d.code)); Cid = r.d.id;
    eq((await adm('/members', 'POST', { handle: 'invitee' })).status, 409);
    clock += 3 * 86400000; // days later
    const s = await call('/link/finish', { method: 'POST', body: { code: r.d.code } });
    eq(s.status, 200); eq(s.d.me.handle, 'invitee'); eq(s.d.me.unlocked, true); eq(s.d.me.leagues.map(l => l.id), ['main']);
    A = s.d.key;
    eq((await call('/link/finish', { method: 'POST', body: { code: r.d.code } })).status, 400, 'single use');
    const again = await adm('/members/' + Cid, 'POST', { action: 'code' }); ok(again.d.code, 'a new code any time (lost phone)');
  });
  await t('edit, unlock, coach allowance, XP boosts and their removal', async () => {
    eq((await adm('/members/' + Cid, 'POST', { action: 'edit', handle: 'renamed_1', address: '0x' + 'b'.repeat(40) })).status, 200);
    await adm('/members/' + Cid, 'POST', { action: 'coach', daily: 3 });
    await adm('/members/' + Cid, 'POST', { action: 'grant', xp: 500, why: 'Won the October cup', announce: true });
    eq((await adm('/members/' + Cid, 'POST', { action: 'grant', xp: 0 })).status, 400);
    const me = (await call('/me', { key: A })).d.me;
    eq(me.handle, 'renamed_1'); eq(me.grants.map(g => [g.xp, g.why]), [[500, 'Won the October cup']]); eq(me.coach.limit, 3);
    const feed = (await adm('/events', 'GET')).d.events; ok(feed.some(e => e.text === 'got +500 XP: Won the October cup'));
    await adm('/members/' + Cid, 'POST', { action: 'ungrant', id: me.grants[0].id });
    eq((await call('/me', { key: A })).d.me.grants, []);
    await adm('/members/' + Cid, 'POST', { action: 'coach', daily: null });
    eq((await call('/me', { key: A })).d.me.coach.limit, 3, 'unlocked members get the unlocked allowance: 3 since the coach went to 3 a day');
  });
  await t('reward badges: earned when a measure crosses its value, or awarded by hand; titles follow the level table', async () => {
    Bk = (await call('/join', { method: 'POST', body: { handle: 'bravo' } })).d.key;
    const auto = (await adm('/badges', 'POST', { name: 'Level 3 club', icon: '🥉', metric: 'level', value: 3, xp: 100 })).d.id;
    const hand = (await adm('/badges', 'POST', { name: 'Mentor', icon: '🧭' })).d.id;
    await call('/stats', { method: 'POST', key: Bk, body: st(2, 900) });
    eq((await call('/me', { key: Bk })).d.me.awards, []);
    await call('/stats', { method: 'POST', key: Bk, body: st(3, 1300) });
    eq((await call('/me', { key: Bk })).d.me.awards.map(a => [a.name, a.xp]), [['Level 3 club', 100]]);
    const bid = (await adm('/members', 'GET')).d.members.find(m => m.handle === 'bravo').id;
    await adm('/members/' + bid, 'POST', { action: 'award', badge: hand });
    eq((await call('/profile/bravo', { key: A })).d.profile.awards.map(a => a.name).sort(), ['Level 3 club', 'Mentor'], 'others see them');
    await adm('/members/' + bid, 'POST', { action: 'revoke', badge: hand });
    eq((await call('/me', { key: Bk })).d.me.awards.length, 1);
    await adm('/config', 'PUT', { levels: { titles: ['Pup', 'Cub', 'Wolf'] } });
    eq((await call('/me', { key: Bk })).d.me.title, 'Wolf');
    eq((await adm('/badges', 'GET')).d.badges.find(b => b.id === auto).earned, 1);
  });
  let club;
  await t('leagues: the owner creates them; members search by name or number, read the details, and join several', async () => {
    const r = await adm('/leagues', 'POST', { name: 'Discipline Club', desc: 'Verified discipline, monthly', metric: 'discipline', period: 'month', invite: 'calm' });
    club = r.d.id; await adm('/leagues', 'POST', { name: 'Secret', open: false });
    const byName = (await call('/leagues?q=discipline', { key: A })).d.leagues; eq(byName.map(l => [l.name, l.num, l.joined, l.inviteRequired]), [['Discipline Club', 1002, false, true]]);
    eq((await call('/leagues?q=%231002', { key: A })).d.leagues.map(l => l.id), [club], 'by number');
    eq((await call('/leagues?q=secret', { key: A })).d.leagues, [], 'closed leagues stay hidden');
    const info = (await call('/leagues/1002', { key: A })).d.league;
    eq([info.name, info.metricLabel, info.period, info.members], ['Discipline Club', 'Discipline (verified)', 'month', 0]);
    eq((await call('/leagues/' + club + '/join', { method: 'POST', key: A, body: { invite: 'nope' } })).status, 403);
    eq((await call('/leagues/' + club + '/join', { method: 'POST', key: A, body: { invite: 'calm' } })).d.league.joined, true);
    eq((await call('/me', { key: A })).d.me.leagues.map(l => l.id).sort(), [club, 'main'].sort(), 'in two leagues at once');
    const lg = (await call('/league?id=' + club, { key: A })).d; eq([lg.league.name, lg.board], ['Discipline Club', 'discipline']);
    eq(lg.mine.length, 2);
  });
  await t('global leaderboards: everyone who opted in, whatever their league', async () => {
    await call('/stats', { method: 'POST', key: A, body: st(4, 2600) });
    // new members start on the global boards; both switch off to start from an empty board
    for (const k of [A, Bk]) await call('/me', { method: 'PUT', key: k, body: { share: { global: false } } });
    let g = (await call('/leaderboard?board=level&scope=global', { key: A })).d;
    eq([g.rows.length, g.need], [0, 'global'], 'nobody opted in yet');
    await call('/me', { method: 'PUT', key: A, body: { share: { global: true } } });
    await call('/me', { method: 'PUT', key: Bk, body: { share: { global: true } } });
    g = (await call('/leaderboard?board=level&scope=global', { key: A })).d;
    eq(g.rows.map(r => r.handle), ['renamed_1', 'bravo']); eq(g.optedIn, true);
    const inClub = (await call('/leaderboard?board=level&league=' + club, { key: A })).d;
    eq(inClub.rows.map(r => r.handle), ['renamed_1'], 'a league board is just its members');
  });
  await t('league-only competitions, and competitions locked below their level unless unlocked', async () => {
    const c = (await adm('/competitions', 'POST', { title: 'Club cup', type: 'journal', start: '2026-10-01', end: '2026-10-20', league: club })).d.id;
    eq((await call('/competitions', { key: Bk })).d.competitions.some(x => x.id === c), false, 'not in the club: not listed');
    eq((await call('/competitions/' + c + '/join', { method: 'POST', key: Bk })).status, 404);
    eq((await call('/competitions/' + c + '/join', { method: 'POST', key: A })).status, 200, 'member, and unlocked past the level-6 lock');
    const open = (await adm('/competitions', 'POST', { title: 'Open cup', type: 'journal', start: '2026-10-01', end: '2026-10-20' })).d.id;
    const r = await call('/competitions/' + open + '/join', { method: 'POST', key: Bk });
    eq([r.status, r.d.error], [403, 'Competitions unlock at level 6.']);
  });
  await t('each tiered league rolls over on its own measure', async () => {
    const st2 = (await adm('/leagues', 'POST', { name: 'Streakers', metric: 'streak', tiers: true, everyone: true })).d.id;
    const ids = (await adm('/members', 'GET')).d.members.map(m => m.id);
    for (const id of ids) await adm('/members/' + id, 'POST', { action: 'tier', league: st2, tier: 1 });
    clock = Date.parse('2026-10-06T12:00:00Z'); await call('/config');
    const L = (await adm('/leagues', 'GET')).d.leagues.find(l => l.id === st2);
    eq(L.roster.filter(r => r.tier !== 1).length, 0, 'three members: too few to move (four needed)');
    await adm('/members', 'POST', { handle: 'fourth', leagues: [st2] });
    const fid = (await adm('/members', 'GET')).d.members.find(m => m.handle === 'fourth').id;
    await adm('/members/' + fid, 'POST', { action: 'tier', league: st2, tier: 1 });
    clock = Date.parse('2026-10-13T12:00:00Z'); await call('/config');
    const L2 = (await adm('/leagues', 'GET')).d.leagues.find(l => l.id === st2).roster;
    eq(L2.filter(r => r.tier === 2).length, 1, 'top streak moves up'); eq(L2.filter(r => r.tier === 0).length, 1, 'bottom moves down');
  });
  await t('a monthly league moves people once a month, not every week', async () => {
    const mo = (await adm('/leagues', 'POST', { name: 'Monthly streaks', metric: 'streak', period: 'month', tiers: true, everyone: true })).d.id;
    const ids = (await adm('/leagues', 'GET')).d.leagues.find(l => l.id === mo).roster.map(r => r.id);
    ok(ids.length >= 4); for (const id of ids) await adm('/members/' + id, 'POST', { action: 'tier', league: mo, tier: 1 });
    clock = Date.parse('2026-10-20T12:00:00Z'); await call('/config');
    eq((await adm('/leagues', 'GET')).d.leagues.find(l => l.id === mo).roster.filter(r => r.tier !== 1).length, 0, 'a new week in the same month: nobody moves');
    clock = Date.parse('2026-11-03T12:00:00Z'); await call('/config');
    ok((await adm('/leagues', 'GET')).d.leagues.find(l => l.id === mo).roster.some(r => r.tier !== 1), 'a new month: promotion and relegation');
    await adm('/leagues/' + mo, 'DELETE');
  });
  await t('a reward badge the owner takes back stays taken back', async () => {
    const bid = (await adm('/badges', 'POST', { name: 'Anyone', metric: 'level', op: 'gte', value: 1 })).d.id;
    eq((await adm('/members', 'GET')).d.members.find(m => m.id === Cid).awards.includes(bid), true, 'earned at once');
    await adm('/members/' + Cid, 'POST', { action: 'revoke', badge: bid });
    await call('/stats', { method: 'POST', key: A, body: { xp: 50, level: 2 } });
    eq((await adm('/members', 'GET')).d.members.find(m => m.id === Cid).awards.includes(bid), false, 'the next sync doesn’t hand it back');
    await adm('/members/' + Cid, 'POST', { action: 'award', badge: bid });
    eq((await adm('/members', 'GET')).d.members.find(m => m.id === Cid).awards.includes(bid), true);
    eq((await adm('/members/' + Cid, 'POST', { action: 'coach' })).status, 400, 'a coach allowance needs a number');
    await adm('/badges/' + bid, 'DELETE');
  });
  await t('leaving a league; deleting one; the main league stays', async () => {
    eq((await call('/leagues/' + club + '/join', { method: 'DELETE', key: A })).d.league.joined, false);
    eq((await adm('/leagues/main', 'DELETE')).status, 400);
    eq((await adm('/leagues/' + club, 'DELETE')).status, 200);
  });
  await t('the coach allowance counts per member per day', async () => {
    const soc = app._social; ok(soc, 'server exposes the social instance for the coach');
    await adm('/members/' + Cid, 'POST', { action: 'coach', daily: 2 });
    const req = { headers: { 'x-pulse-key': A } };
    let s = soc.coach.statusFor(req); eq([s.allowed, s.remaining], [true, 2]);
    soc.coach.count(s.member); soc.coach.count(s.member);
    s = soc.coach.statusFor(req); eq([s.allowed, s.remaining], [false, 0]); ok(/today’s 2 coach messages/.test(s.reason));
    clock += 86400000; eq(soc.coach.statusFor(req).remaining, 2, 'a new day');
    await adm('/config', 'PUT', { coach: { members: false } });
    ok(/hasn’t opened the coach/.test(soc.coach.statusFor(req).reason));
  });
  await t('settings out of range are refused by name and range, not clamped and “Saved”; a stored config still loads', async () => {
    const before = (await adm('/overview', 'GET')).d.config;
    for (const [body, re] of [
      [{ xp: { checkin: 5000 } }, /^XP rules → checkin must be from 0 to 1000 \(not 5000\)\.$/],
      [{ xp: { discipline: -1 } }, /XP rules → discipline must be from 0 to 5/],
      [{ coach: { packs: { cost: 0 } } }, /^Coach → packs → cost must be from 1 to 100000/],
      [{ modules: { coach: 0 } }, /Features → coach must be from 1 to 100/],
      [{ levels: { base: 'lots' } }, /Levels → base needs a number from 10 to 5000/],
      [{ mentorXp: { rateMin: 50, rateMax: 10 } }, /lowest rate \(50\) is above the highest \(10\)/],
      [{ mentorXp: { holdHours: 1 } }, /Mentoring XP → holdHours must be from 12 to 336/],
      [{ pots: { burnMax: 10, burnPct: 20 } }, /Buy-ins → burnPct must be from 0 to 10 \(not 20\)/],
      [{ guestCap: -3 }, /Levels stop at/], [{ guestCap: '' }, /Levels stop at/],
      // the two lists: a threshold below the one before (kept as [500] once, capping everyone at level 2), and tiers
      [{ levels: { mode: 'table', thresholds: '500, 100, 50' } }, /^Levels → thresholds must go up: level 3 \(100 XP\) needs more XP than level 2 \(500 XP\)\.$/],
      [{ levels: { mode: 'table', thresholds: '1500, 2500, 400' } }, /level 4 \(400 XP\)/],
      [{ levels: { mode: 'table', thresholds: [300, 'lots'] } }, /"lots" isn’t an amount of XP/],
      [{ levels: { thresholds: Array.from({ length: 100 }, (_, i) => 100 * (i + 1)) } }, /at most 99/],
      [{ mult: { tiers: [[500, 50]] } }, /weeks must be a whole number from 1 to 104 \(not 500\)/],
      [{ mult: { tiers: [[2, 9]] } }, /multiplier must be from 1\.01 to 3 \(not 9\)/],
      [{ mult: { tiers: [[2, 1.05], [4, 1.01]] } }, /must both go up, tier by tier \(2w 1\.05× then 4w 1\.01×\)/],
      [{ mult: { tiers: Array.from({ length: 9 }, (_, i) => [i + 1, 1.1 + i / 10]) } }, /at most 8, not 9/],
      [{ mult: { tiers: [[2, 1.05], 'x'] } }, /"x" isn’t \[weeks, multiplier\]/], [{ mult: { tiers: [] } }, /at least one/]]) {
      const r = await adm('/config', 'PUT', Object.assign({ open: !before.open }, body));
      eq(r.status, 400, JSON.stringify(body)); ok(re.test(r.d.error), r.d.error);
    }
    const after = (await adm('/overview', 'GET')).d.config;
    eq([after.open, after.xp, after.coach, after.guestCap, after.levels, after.mult], [before.open, before.xp, before.coach, before.guestCap, before.levels, before.mult], 'nothing in a refused request is applied');
    // what's valid is stored as typed: a string table, out-of-order tiers that are fine once sorted (as the sanitizer keeps them)
    const ok2 = await adm('/config', 'PUT', { levels: { mode: 'table', thresholds: '300, 800 1500' }, mult: { tiers: [[8, 1.2], [2, 1.05], [104, 3]] } });
    eq([ok2.status, ok2.d.config.levels.thresholds, ok2.d.config.mult.tiers], [200, [300, 800, 1500], [[2, 1.05], [8, 1.2], [104, 3]]]);
    await adm('/config', 'PUT', { levels: before.levels, mult: before.mult });
    eq(SC.levelsError({ mode: 'curve', base: 300 }), null, 'no thresholds in the request, nothing to check');
    eq((await adm('/config', 'PUT', { xp: { checkin: 1000, discipline: 2.5 }, coach: { packs: { cost: 1 } }, mentorXp: { rateMin: 10, rateMax: 10 }, guestCap: 0 })).status, 200, 'the edges are fine');
    // loading is separate: a config written by hand (or an older version) is still clamped into shape
    eq(SC.sanitizeXp({ checkin: 5000 }, null).checkin, 1000);
    eq(SC.rangeError('XP rules', { checkin: 20, review: '15' }, null, SC.sanitizeXp), null);
  });
  await t('removing a member', async () => {
    eq((await adm('/members/' + Cid, 'POST', { action: 'remove' })).status, 200);
    eq((await call('/me', { key: A })).status, 401);
  });
} finally { await new Promise(res => app.close(res)); }

console.log('\nAdmin panel');
t('the Routines tab shows the same default questions the app asks', () => {
  const lit = (src, start) => { const i = src.indexOf(start); ok(i >= 0, start); const j = i + src.slice(i).search(/\n\s*};/); return (0, eval)('(' + src.slice(i + start.length - 1, src.indexOf('}', j + 1) + 1) + ')'); };
  const app = lit(readAppSource(htmlPath), 'const PZ_ROUTINES={');
  const admin = lit(readFileSync(new URL('../admin.html', import.meta.url).pathname, 'utf8'), 'const ROUTINES={');
  eq(Object.keys(admin), Object.keys(app));
  for (const k of Object.keys(app)) eq([admin[k].name, admin[k].morning, admin[k].eod], [app[k].name, app[k].morning, app[k].eod], k);
  eq(Object.keys(app), SC.PROFILES);
});

t('Save levels refuses what the server refuses, instead of saving a trimmed table', () => {
  const src = readFileSync(new URL('../admin.html', import.meta.url).pathname, 'utf8'), i = src.indexOf('function levelProblem(');
  const levelProblem = (0, eval)('(' + src.slice(i, src.indexOf('return null; }', i) + 14) + ')');
  for (const s of ['500, 100, 50', '1500, 2500, 400', '300 x', '0, 5', '300, 800, 1500', '', '300\n800']) {
    const srv = SC.levelsError({ thresholds: s }); eq(!!levelProblem(s), !!srv, JSON.stringify(s) + ' → ' + srv);
  }
  ok(/level 3 \(100 XP\) needs more XP than level 2 \(500 XP\)/.test(levelProblem('500, 100, 50')));
  ok(/if\(bad&&body\.mode==='table'\)\{ UI\.levelDraft=levelDraft\(\); render\(\); return note\(/.test(src), 'Save shows the preview and the error');
});

report('admin');
