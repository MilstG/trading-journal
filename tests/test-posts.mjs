// SQLite storage and members' posts: the one-time import of social.json, rows that survive a restart,
// trade posts (R from the prices, fixed plans, outcomes, the on-chain mark), images and profile
// pictures, comments, reports and the owner's moderation, and paging through the feed.
import { mkdtempSync, writeFileSync, existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { t, ok, eq, report, storedText, makeExtractor } from './harness.mjs';

const require = createRequire(import.meta.url);
const S = require('../social.js');
const server = require('../server.js');
const htmlPath = new URL('../ledger.html', import.meta.url).pathname;

console.log('\nTrade posts');
t('R and % come from the prices; a plan’s levels must sit on the right sides of the entry', () => {
  const plan = S.sanitizeTrade({ coin: 'BTC', side: 'long', entry: 100, stop: 95, target: 110 }, null, { kind: 'plan' });
  eq([plan.status, plan.stop, plan.target], ['planned', 95, 110]);
  eq(S.sanitizeTrade({ coin: 'BTC', side: 'short', entry: 100, stop: 95 }, null, { kind: 'plan' }), null, 'a short’s stop is above the entry');
  eq(S.sanitizeTrade({ coin: 'BTC', side: 'long', entry: 100, target: 90 }, null, { kind: 'plan' }), null);
  eq(S.sanitizeTrade({ coin: '<script>', side: 'long', entry: 1 }, null, {}), null);
  const closed = S.sanitizeTrade({ status: 'closed', exit: 90, r: 9, usd: -50 }, plan, { usd: false });
  eq([closed.status, closed.r, closed.pct, closed.usd], ['closed', -2, -10, undefined], 'the client’s R is ignored when the stop is known');
  const taken = S.sanitizeTrade({ coin: 'ETH', side: 'Short', entry: 100, exit: 90, status: 'closed', r: 1.4, usd: 12 }, null, { kind: 'trade', usd: true });
  eq([taken.r, taken.pct, taken.usd], [1.4, 10, 12], 'no stop: the journal’s R is kept');
});
t('status only moves forward; only a plan that never happened can be cancelled', () => {
  const plan = S.sanitizeTrade({ coin: 'SOL', side: 'long', entry: 10, stop: 9 }, null, { kind: 'plan' });
  const open = S.sanitizeTrade({ status: 'open', openedAt: Date.UTC(2026, 9, 1) }, plan, {});
  eq(open.status, 'open');
  eq(S.sanitizeTrade({ status: 'cancelled' }, open, {}).status, 'open');
  eq(S.sanitizeTrade({ status: 'cancelled' }, plan, {}).status, 'cancelled');
  const shut = S.sanitizeTrade({ status: 'closed', exit: 12 }, open, {});
  eq([shut.status, shut.exit], ['closed', 12]);
  eq(S.sanitizeTrade({ status: 'open' }, shut, {}).status, 'closed');
  eq(S.sanitizeTrade({ status: 'closed', exit: 20 }, shut, {}).exit, 12, 'the exit is fixed once given');
  eq(S.sanitizeTrade({ coin: 'SOL', side: 'long', entry: 10, status: 'planned' }, null, { kind: 'trade' }).status, 'open', 'a trade taken isn’t a plan');
});

console.log('\nStorage');
const listen = app => new Promise(res => app.listen(0, () => res('http://127.0.0.1:' + app.address().port)));
const close = app => new Promise(res => app.close(res));
let clock = Date.UTC(2026, 9, 28, 9, 0);
const dataDir = mkdtempSync(join(tmpdir(), 'posts-'));
// a v0.5 file: one member, a milestone with kudos, a league
writeFileSync(join(dataDir, 'social.json'), JSON.stringify({ v: 1, config: { open: true }, follows: { aa11: [] }, comps: {}, league: { week: '2026-W44' },
  members: { aa11: { id: 'aa11', handle: 'oldtimer', keyHash: 'x', createdAt: 1, tier: 1, share: S.sanitizeShare({}), stats: { xp: 50, level: 2, days: [] }, weekXp: {} } },
  events: [{ id: 'ev1', at: clock - 3600000, member: 'aa11', type: 'level', text: 'reached level 2', quote: '', kudos: ['zz99'] }] }));
const checks = [];
let checkOk = true;
const tradeCheck = async (addr, tr) => { checks.push([addr, tr.coin]); return checkOk && tr.coin === 'BTC'; };
const sig = require('../vendor/eth-sig.js'), KA = '0x' + '11'.repeat(32), WA = sig.addressOfPrivateKey(KA);
const mk = () => server.createApp({ dataDir, auth: 'owner-token', htmlPath, now: () => clock, pushTick: false, push: false, tradeCheck,
  fetchImpl: async () => ({ ok: true, status: 200, json: async () => [] }) });
let app = mk(), B = await listen(app);
const call = async (p, o = {}) => { const r = await fetch(B + '/api/social' + p, { method: o.method || 'GET',
    headers: { 'Content-Type': o.type || 'application/json', ...(o.key ? { 'X-Pulse-Key': o.key } : {}), ...(o.admin ? { Authorization: 'Bearer owner-token' } : {}) },
    body: o.raw !== undefined ? o.raw : o.body !== undefined ? JSON.stringify(o.body) : undefined });
  const ct = r.headers.get('content-type') || '';
  return { status: r.status, headers: r.headers, d: ct.includes('json') ? await r.json() : Buffer.from(await r.arrayBuffer()) }; };
const join_ = async (h, body) => (await call('/join', { method: 'POST', body: Object.assign({ handle: h }, body) })).d.key;
const webp = n => Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 '), Buffer.alloc(n)]);
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40)]);
const upload = (key, buf, kind) => call('/media' + (kind ? '?kind=' + kind : ''), { method: 'POST', key, raw: buf, type: 'application/octet-stream' });
try {
  await t('the first start imports social.json once, keeps it as .migrated, and moves the feed into rows', async () => {
    eq((await call('/config')).status, 200);
    ok(!existsSync(join(dataDir, 'social.json')) && existsSync(join(dataDir, 'social.json.migrated')));
    ok(existsSync(join(dataDir, 'pulse.db')));
    const list = (await call('/admin/members', { admin: true })).d.members;
    eq(list.map(m => m.handle), ['oldtimer']);
    const ev = (await call('/admin/events', { admin: true })).d.events;
    eq([ev.length, ev[0].text, ev[0].kudos], [1, 'reached level 2', 1]);
  });
  let A, Bk, C;
  await t('members and posts survive a restart; only changed rows are written', async () => {
    A = await join_('alice', { address: WA }); Bk = await join_('bobby');
    await call('/follow/alice', { method: 'POST', key: Bk });
    const p = await call('/posts', { method: 'POST', key: A, body: { kind: 'note', text: 'Waiting for the open.\n\n\n\nNo trades before 10.' } });
    eq(p.status, 200); eq(p.d.post.text, 'Waiting for the open.\n\nNo trades before 10.', 'line breaks kept, runs of blank lines folded');
    await close(app); app = mk(); B = await listen(app);
    eq((await call('/me', { key: A })).d.me.handle, 'alice');
    eq((await call('/me', { key: Bk })).d.me.following, 1);
    const f = (await call('/feed', { key: Bk })).d.events;
    ok(f.some(e => e.type === 'post' && e.post.kind === 'note'));
  });
  let planId;
  await t('a planned trade: levels fixed, outcome added later, R from the prices, dollars only when shared', async () => {
    const r = await call('/posts', { method: 'POST', key: A, body: { kind: 'plan', text: 'Breakout retest on the 4h.', trade: { coin: 'BTC', side: 'long', entry: 60000, stop: 59000, target: 63000, setup: 'Breakout', tf: '4h' } } });
    eq(r.status, 200); planId = r.d.post.id;
    eq([r.d.post.post.kind, r.d.post.post.trade.status, r.d.post.post.verified], ['plan', 'planned', false]);
    const bad = await call('/posts', { method: 'POST', key: A, body: { kind: 'plan', text: 'x', trade: { coin: 'BTC', side: 'long', entry: 60000, stop: 61000 } } });
    eq(bad.status, 400);
    clock += 20 * 60000;
    eq((await call('/posts/' + planId, { method: 'PUT', key: A, body: { text: 'rewritten after the fact' } })).status, 409, 'the thesis is fixed after 15 minutes');
    eq((await call('/posts/' + planId, { method: 'PUT', key: Bk, body: { outcome: 'x' } })).status, 403);
    const opened = clock - 5 * 60000;
    const u = await call('/posts/' + planId, { method: 'PUT', key: A, body: { trade: { status: 'closed', exit: 62000, openedAt: opened, closedAt: clock, entry: 1, stop: 2, usd: 400 }, outcome: 'Took two thirds at 62k.' } });
    eq(u.status, 200);
    const tr = u.d.post.post.trade;
    eq([tr.status, tr.entry, tr.stop, tr.r, tr.pct, tr.usd], ['closed', 60000, 1000 * 59, 2, 3.33, undefined]);
    eq(u.d.post.post.outcome, 'Took two thirds at 62k.');
  });
  await t('the mark needs a wallet proved by signature, and belongs to the trade as it stands', async () => {
    await new Promise(r => setTimeout(r, 30));
    eq((await call('/posts/' + planId, { key: Bk })).d.post.post.verified, false, 'a typed address proves nothing');
    eq(checks.length, 0, 'and isn’t even checked');
    // alice signs for the wallet
    const st = await call('/claim/start', { method: 'POST', key: A, body: { address: WA } });
    eq((await call('/claim/finish', { method: 'POST', key: A, body: { nonce: st.d.nonce, signature: sig.signPersonal(st.d.message, KA) } })).status, 200);
    const r = await call('/posts', { method: 'POST', key: A, body: { kind: 'trade', text: '', trade: { coin: 'BTC', side: 'long', entry: 61000, status: 'open', openedAt: clock - 60000 } } });
    eq(r.status, 200, 'a trade from the journal needs no text');
    await new Promise(r2 => setTimeout(r2, 30));
    eq((await call('/posts/' + r.d.post.id, { key: Bk })).d.post.post.verified, true); eq(checks[0], [WA.toLowerCase(), 'BTC']);
    // closing it is a new version: checked again before the mark shows
    checkOk = false;
    await call('/posts/' + r.d.post.id, { method: 'PUT', key: A, body: { trade: { status: 'closed', exit: 99999, closedAt: clock } } });
    await new Promise(r2 => setTimeout(r2, 30));
    eq([(await call('/posts/' + r.d.post.id, { key: Bk })).d.post.post.verified, checks.length], [false, 2]);
    await call('/posts/' + r.d.post.id, { method: 'PUT', key: A, body: { outcome: 'edit one' } }); await call('/posts/' + r.d.post.id, { method: 'PUT', key: A, body: { outcome: 'edit two' } });
    await new Promise(r2 => setTimeout(r2, 30)); eq(checks.length, 2, 'editing the words doesn’t fetch fills again');
    checkOk = true;
  });
  await t('a plan can’t be marked as taken before it was posted; results are fixed once known', async () => {
    const p = (await call('/posts', { method: 'POST', key: A, body: { kind: 'plan', text: 'x', trade: { coin: 'SOL', side: 'long', entry: 100, stop: 95 } } })).d.post;
    const u = (await call('/posts/' + p.id, { method: 'PUT', key: A, body: { trade: { status: 'closed', exit: 110, openedAt: clock - 5 * 86400000, closedAt: clock - 4 * 86400000 } } })).d.post.post.trade;
    eq([u.status, u.openedAt, u.closedAt, u.r], ['closed', undefined, undefined, 2]);
    const t2 = (await call('/posts', { method: 'POST', key: A, body: { kind: 'trade', trade: { coin: 'ETH', side: 'short', entry: 100, exit: 90, status: 'closed', r: 9, usd: 5 } } })).d.post;
    const again = (await call('/posts/' + t2.id, { method: 'PUT', key: A, body: { trade: { status: 'closed', r: 50, usd: 999 } } })).d.post.post.trade;
    eq([again.r, again.pct], [9, 10]);
    eq((await call('/posts', { method: 'POST', key: A, body: { kind: 'plan', text: 'x', trade: { coin: 'SOL', side: 'long', entry: 100, stop: 99.999 } } })).status, 400, 'a stop a hair from the entry');
    eq(S.sanitizeTrade({ coin: '@107', label: 'PURR/USDC', side: 'long', entry: 1 }, null, {}).label, 'PURR/USDC');
    eq(S.sanitizeTrade({ coin: 'BTC', label: 'ETH', side: 'long', entry: 1 }, null, {}).label, undefined, 'a perp shows its own name');
    // an update can be fixed for 15 minutes, then it stands
    clock += 16 * 60000;
    eq((await call('/posts/' + p.id, { method: 'PUT', key: A, body: { outcome: 'first' } })).status, 200);
    eq((await call('/posts/' + p.id, { method: 'PUT', key: A, body: { outcome: 'second' } })).status, 200);
    clock += 16 * 60000;
    eq((await call('/posts/' + p.id, { method: 'PUT', key: A, body: { outcome: 'rewritten' } })).status, 409);
  });
  t('fills back up a post only on the right side, near the times and prices given', () => {
    const T0 = Date.UTC(2026, 9, 28, 9), f = (side, px, dt) => ({ coin: 'BTC', side, px: String(px), time: T0 + dt });
    const t = { coin: 'BTC', side: 'long', entry: 60000, openedAt: T0, status: 'closed', exit: 62000, closedAt: T0 + 3600000 };
    eq(server.fillsMatchTrade([f('B', 60100, 20000), f('A', 61900, 3600000 - 5000)], t), true);
    eq(server.fillsMatchTrade([f('A', 60100, 20000), f('A', 61900, 3600000)], t), false, 'a sell isn’t a long’s entry');
    eq(server.fillsMatchTrade([f('B', 50000, 0), f('A', 61900, 3600000)], t), false, 'the price is off');
    eq(server.fillsMatchTrade([f('B', 60000, 0), f('A', 70000, 3600000)], t), false, 'the exit is off');
    eq(server.fillsMatchTrade([f('B', 60000, 0)], Object.assign({}, t, { status: 'open' })), true);
  });
  let img;
  await t('images: WebP, JPEG or PNG by their first bytes, nothing else; served with long caching once used', async () => {
    eq((await upload(A, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'))).status, 415);
    eq((await upload(null, webp(10))).status, 401);
    eq((await upload(A, webp(1600 * 1024))).status, 413);
    const u = await upload(A, webp(2000)); eq(u.status, 200); img = u.d.id; ok(/^[a-f0-9]{24}$/.test(img));
    eq((await call('/media/' + img)).status, 404, 'not served until a post uses it');
    eq((await call('/posts', { method: 'POST', key: Bk, body: { text: 'hi', media: [img] } })).status, 400, 'someone else’s upload');
    const p = await call('/posts', { method: 'POST', key: A, body: { text: 'Chart attached', media: [img] } });
    eq(p.d.post.post.media, ['/api/social/media/' + img]);
    const g = await call('/media/' + img);
    eq([g.status, g.headers.get('content-type'), g.headers.get('x-content-type-options')], [200, 'image/webp', 'nosniff']);
    ok(/immutable/.test(g.headers.get('cache-control'))); eq(g.d.length, webp(2000).length);
    eq((await call('/posts', { method: 'POST', key: A, body: { text: 'again', media: [img] } })).status, 400, 'an image belongs to one post');
  });
  await t('a profile picture and a 160-character bio; a new picture replaces the old file', async () => {
    eq((await upload(A, webp(300 * 1024), 'avatar')).status, 413);
    const a1 = (await upload(A, png, 'avatar')).d.id;
    eq((await call('/me', { method: 'PUT', key: A, body: { avatar: img } })).status, 400, 'a post image isn’t a profile picture');
    const r = await call('/me', { method: 'PUT', key: A, body: { avatar: a1, bio: 'Swing trader. '.repeat(20) } });
    eq(r.d.me.av, '/api/social/media/' + a1); eq(r.d.me.bio.length, 160);
    eq((await call('/media/' + a1)).headers.get('content-type'), 'image/png');
    const a2 = (await upload(A, webp(500), 'avatar')).d.id;
    await call('/me', { method: 'PUT', key: A, body: { avatar: a2 } });
    eq((await call('/media/' + a1)).status, 404);
    ok(!readdirSync(join(dataDir, 'media')).includes(a1), 'the old file is gone');
    const prof = (await call('/profile/alice', { key: Bk })).d;
    eq([prof.profile.av, prof.profile.bio.slice(0, 5)], ['/api/social/media/' + a2, 'Swing']);
    ok(prof.posts.length >= 3 && prof.posts.every(p => p.type === 'post' && p.av === '/api/social/media/' + a2));
    eq((await call('/me', { method: 'PUT', key: A, body: { avatar: null } })).d.me.av, null);
  });
  let cid;
  await t('comments: the author hears about them; a comment goes when its writer or the post’s author deletes it', async () => {
    C = await join_('carol');
    const r = await call('/posts/' + planId + '/comments', { method: 'POST', key: C, body: { text: 'Nice patience on the retest.' } });
    eq(r.status, 200); cid = r.d.comment.id; eq([r.d.comment.handle, r.d.comments], ['carol', 1]);
    ok((await call('/inbox', { key: A })).d.items.some(i => i.kind === 'comment' && i.post === planId));
    const p = (await call('/posts/' + planId, { key: Bk })).d;
    eq([p.post.post.comments, p.comments.length, p.comments[0].canDelete], [1, 1, false]);
    const c2 = (await call('/posts/' + planId + '/comments', { method: 'POST', key: Bk, body: { text: 'Agree' } })).d.comment.id;
    eq((await call('/comments/' + c2, { method: 'DELETE', key: C })).status, 404);
    eq((await call('/comments/' + c2, { method: 'DELETE', key: A })).status, 200, 'the post’s author can');
    eq((await call('/posts/' + planId, { key: Bk })).d.post.post.comments, 1);
  });
  await t('kudos are a row each and counted on the post', async () => {
    eq((await call('/kudos/' + planId, { method: 'POST', key: Bk })).d, { kudos: 1, liked: true });
    eq((await call('/kudos/' + planId, { method: 'POST', key: C })).d.kudos, 2);
    eq((await call('/kudos/' + planId, { method: 'POST', key: Bk })).d, { kudos: 1, liked: false });
    eq((await call('/kudos/' + planId, { method: 'POST', key: A })).status, 400);
    const f = (await call('/feed?scope=discover', { key: C })).d.events.find(e => e.id === planId);
    eq([f.kudos, f.liked], [1, true]);
  });
  await t('reports reach the owner, grouped; removing deletes the post with its comments and images', async () => {
    const pid = (await call('/feed?scope=discover', { key: C })).d.events.find(e => e.post && e.post.media.length).id;
    eq((await call('/report', { method: 'POST', key: C, body: { post: pid, why: 'spam' } })).status, 200);
    eq((await call('/report', { method: 'POST', key: Bk, body: { post: pid } })).status, 200);
    eq((await call('/report', { method: 'POST', key: A, body: { post: pid } })).status, 400, 'not your own');
    eq((await call('/report', { method: 'POST', key: Bk, body: { comment: cid, why: 'rude' } })).status, 200);
    const rs = (await call('/admin/reports', { admin: true })).d.reports;
    eq(rs.length, 2); const pr = rs.find(r => !r.comment);
    eq([pr.n, pr.why, pr.post.id], [2, ['spam'], pid]);
    eq((await call('/admin/overview', { admin: true })).d.reports, 3);
    eq((await call('/admin/reports/' + pr.id, { method: 'POST', admin: true, body: { action: 'remove' } })).status, 200);
    eq((await call('/posts/' + pid, { key: C })).status, 404);
    eq((await call('/media/' + img)).status, 404);
    const cr = (await call('/admin/reports', { admin: true })).d.reports;
    eq(cr.length, 1); eq(cr[0].comment.text, 'Nice patience on the retest.');
    await call('/admin/reports/' + cr[0].id, { method: 'POST', admin: true, body: { action: 'dismiss' } });
    eq((await call('/admin/reports', { admin: true })).d.reports.length, 0);
    eq((await call('/report', { method: 'POST', key: Bk, body: { comment: cid, why: 'still rude' } })).status, 200);
    eq((await call('/admin/reports', { admin: true })).d.reports.length, 1, 'after the owner kept it, it can be reported again');
    await call('/admin/reports/' + (await call('/admin/reports', { admin: true })).d.reports[0].id, { method: 'POST', admin: true, body: { action: 'dismiss' } });
    eq((await call('/posts/' + planId, { key: C })).d.comments.length, 1, 'dismissed: the comment stays');
  });
  await t('the owner can switch planned-trade posts and images off', async () => {
    await call('/admin/config', { method: 'PUT', admin: true, body: { posts: { plans: false, images: false } } });
    eq((await call('/config')).d.posts, { on: true, plans: false, images: false });
    eq((await call('/posts', { method: 'POST', key: Bk, body: { kind: 'plan', text: 'x', trade: { coin: 'BTC', side: 'long', entry: 1 } } })).status, 403);
    eq((await upload(Bk, webp(10))).status, 403);
    await call('/admin/config', { method: 'PUT', admin: true, body: { posts: { plans: true, images: true } } });
  });
  await t('the feed pages by cursor, newest first, without repeats', async () => {
    for (let i = 0; i < 10; i++) { clock += 1000; await call('/posts', { method: 'POST', key: C, body: { text: 'note ' + i } }); }
    const seen = []; let next = null, pages = 0;
    do { const r = (await call('/feed?scope=discover&kind=posts&limit=5' + (next ? '&before=' + next : ''), { key: Bk })).d;
      seen.push(...r.events.map(e => e.id)); next = r.next; pages++; } while (next && pages < 10);
    eq(new Set(seen).size, seen.length); ok(seen.length >= 12 && pages >= 3);
    const fol = (await call('/feed', { key: Bk })).d.events;
    ok(fol.every(e => !e.handle || e.handle === 'alice' || e.handle === 'bobby'), 'following: only people you follow');
    eq((await call('/posts', { method: 'POST', key: C, body: { text: 'eleventh' } })).status, 429, 'ten posts a day');
    const mine = (await call('/feed?scope=discover&kind=posts', { key: C })).d.events.find(e => e.mine);
    await call('/posts/' + mine.id, { method: 'DELETE', key: C });
    eq((await call('/posts', { method: 'POST', key: C, body: { text: 'after a delete' } })).status, 429, 'deleting doesn’t give the slot back');
  });
  await t('a banned author’s posts and pictures disappear; leaving deletes them for good', async () => {
    const list = (await call('/admin/members', { admin: true })).d.members, alice = list.find(m => m.handle === 'alice');
    const av = (await upload(A, webp(100), 'avatar')).d.id; await call('/me', { method: 'PUT', key: A, body: { avatar: av } });
    await call('/admin/members/' + alice.id, { method: 'POST', admin: true, body: { action: 'ban' } });
    eq((await call('/posts/' + planId, { key: Bk })).status, 404); eq((await call('/media/' + av)).status, 404);
    await call('/admin/members/' + alice.id, { method: 'POST', admin: true, body: { action: 'unban' } });
    eq((await call('/posts/' + planId, { key: Bk })).status, 200);
    eq((await call('/me', { method: 'DELETE', key: A })).status, 200);
    eq((await call('/posts/' + planId, { key: Bk })).status, 404);
    const st = storedText(dataDir); ok(!st.includes('Breakout retest') && !st.includes('Nice patience') && !st.includes(alice.id));
    eq(readdirSync(join(dataDir, 'media')).length, 0);
  });
} finally { await close(app); }

console.log('\nIn the app');
const X = makeExtractor(readFileSync(htmlPath, 'utf8'));
await t('Today’s cards keep your order: a move swaps neighbours, cards added later go at the end', async () => {
  const flow = /const PZ_FLOW=(\{[^\n]*\});/.exec(readFileSync(htmlPath, 'utf8'))[1];
  const M = await X.evalModule(['pzOrdered', 'pzMove'], null, 'export const settings = {};\nconst PZ_FLOW=' + flow + ';');
  eq(M.pzOrdered('today'), null, 'no order until you move something');
  ok(M.pzMove('today', 'next', -1));
  const o = M.pzOrdered('today');
  eq(o.slice(3, 6), ['next', 'positions', 'now']);
  eq(M.pzMove('today', 'tilt', -1), false, 'the first card can’t go higher');
  M.settings.pzLayout.today._order = ['week', 'tilt', 'gone'];
  const o2 = M.pzOrdered('today');
  eq([o2[0], o2[1], o2.length, o2.includes('gone')], ['week', 'tilt', 13, false]);
});
t('profile pictures are learned from any answer and dropped when removed', () => {
  const SOC = { avs: {} }; const learn = (0, eval)('(SOC=>' + X.grabFn('socLearnAv') + ')')(SOC);
  learn({ events: [{ handle: 'Alice', av: '/api/social/media/a' }, { handle: 'bob', av: null }], me: { profile: { handle: 'carol', av: '/x' } } }, 0);
  eq(SOC.avs, { alice: '/api/social/media/a', carol: '/x' });
  learn({ handle: 'alice', av: null }, 0); eq(Object.keys(SOC.avs), ['carol']);
});

report('posts');
