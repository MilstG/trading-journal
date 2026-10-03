// Mentor trade reviews: a member sends one trade to the league's mentors, the mentors comment and
// mark it reviewed, the member replies. Who can see a thread (the member, the mentors while the
// member lets mentors in, admins read-only), the limits, and what goes when a thread or a member
// does — over real HTTP.
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { t, ok, eq, report, makeExtractor, storedText } from './harness.mjs';
import { readAppSource } from '../app-source.js';

const require = createRequire(import.meta.url);
const S = require('../social.js');
const server = require('../server.js');
const htmlPath = new URL('../ledger.html', import.meta.url).pathname;
const U = s => Date.parse(s + 'Z');

console.log('\nWhat a trade carries');
const TR = { coin: 'BTC', label: 'BTC', side: 'long', market: 'perp', openedAt: U('2026-10-01T10:00:00'), closedAt: U('2026-10-01T14:30:00'),
  entry: 60000, exit: 61200, stop: 59400, target: 62000, size: 2, pct: 2.0123, r: 1.98765, usd: 412.345, setup: 'Breakout retest',
  note: 'Took it at the retest.\n\n\n\nHeld to the first target.', plan: 'Only A setups before noon.' };
t('the summary: market, side, times, prices, a size range, % and R; dollars only for members who share them', () => {
  eq(S.sanitizeReviewTrade(TR, { usd: false }), { coin: 'BTC', side: 'long', market: 'perp', openedAt: TR.openedAt, closedAt: TR.closedAt, label: 'BTC',
    entry: 60000, stop: 59400, target: 62000, exit: 61200, size: 2, pct: 2.01, r: 1.99, setup: 'Breakout retest',
    note: 'Took it at the retest.\n\nHeld to the first target.', plan: 'Only A setups before noon.' });
  eq(S.sanitizeReviewTrade(TR, { usd: true }).usd, 412.35);
});
t('an open trade has no exit or result; nonsense is refused or dropped', () => {
  const o = S.sanitizeReviewTrade(Object.assign({}, TR, { closedAt: null }), { usd: true });
  eq([o.closedAt, o.exit, o.pct, o.r, o.usd], [null, undefined, undefined, undefined, undefined]);
  eq(S.sanitizeReviewTrade(Object.assign({}, TR, { coin: '<script>' })), null);
  eq(S.sanitizeReviewTrade(Object.assign({}, TR, { side: 'up' })), null);
  eq(S.sanitizeReviewTrade(Object.assign({}, TR, { openedAt: 'yesterday' })), null);
  const x = S.sanitizeReviewTrade(Object.assign({}, TR, { closedAt: TR.openedAt - 1, size: 99, pct: null, note: 'n'.repeat(5000), entry: -1 }));
  eq([x.closedAt, x.size, x.pct, x.note.length, x.entry], [null, 4, undefined, 1500, undefined]);
  eq(S.sanitizeReviewTrade(Object.assign({}, TR, { pct: null, r: '' })).pct, undefined);
});

console.log('\nWhat the app sends');
const X = await makeExtractor(readAppSource(htmlPath)).evalModule(['mrTradeKey', 'mrSizeRange', 'mrSummary']);
t('the server knows a trade by a short hash of its id, never the id (it holds the wallet address)', () => {
  const id = '0x' + 'a'.repeat(40) + ':BTC:1727780000000', k = X.mrTradeKey(id);
  ok(/^[a-z0-9]{6,32}$/.test(k) && !k.includes('aaaa'), k); eq(X.mrTradeKey(id), k); ok(X.mrTradeKey(id + '1') !== k);
  eq([999, 1000, 25000, 999999, 5e6].map(X.mrSizeRange), [0, 1, 2, 3, 4]);
});
t('the summary of a journal trade: the plan’s stop and target, the note (with what’s typed but unsaved), dollars only on request', () => {
  const tr = { id: 'x', coin: 'BTC', dir: 'Short', market: 'perp', openTime: 1, closeTime: 2, avgEntry: 100, avgExit: 90, maxSize: 30, net: 290.5 };
  const j = { notes: 'Faded the spike.', setup: 'Fade', plan: { entry: '100', stop: '105', target: '' } };
  eq(X.mrSummary(tr, j, { label: 'BTC', r: 1.5, pct: 9.68, plan: 'A setups only', extra: ' Was I early? ' }), { coin: 'BTC', label: 'BTC', side: 'short', market: 'perp',
    openedAt: 1, closedAt: 2, entry: 100, exit: 90, stop: 105, target: null, size: 1, pct: 9.68, r: 1.5, usd: null, setup: 'Fade', note: 'Faded the spike.\n\nWas I early?', plan: 'A setups only' });
  eq(X.mrSummary(tr, j, { usd: true }).usd, 290.5);
  const open = X.mrSummary(Object.assign({}, tr, { isOpen: true }), null, { usd: true, r: 1, pct: 2 });
  eq([open.closedAt, open.exit, open.pct, open.r, open.usd, open.note], [null, null, null, null, null, '']);
});

console.log('\nThe review thread over HTTP');
let clock = U('2026-10-02T09:00:00');
const dataDir = mkdtempSync(join(tmpdir(), 'ledger-reviews-'));
const app = server.createApp({ dataDir, auth: 'owner-token', htmlPath, now: () => clock, push: false, pushTick: false, offsiteTimer: false, trustProxy: true,
  fetchImpl: async () => ({ ok: true, status: 200, json: async () => [] }) });
const B = await new Promise(res => app.listen(0, () => res('http://127.0.0.1:' + app.address().port)));
const call = async (p, o = {}) => { const r = await fetch(B + '/api/social' + p, { ...o, headers: { 'Content-Type': 'application/json', ...(o.key ? { 'X-Pulse-Key': o.key } : {}), ...(o.admin ? { Authorization: 'Bearer owner-token' } : {}) }, body: o.body ? JSON.stringify(o.body) : undefined });
  return { status: r.status, d: await r.json() }; };
// members join with mentors kept out, so each test lets them in when it needs to
const join_ = async h => (await call('/join', { method: 'POST', body: { handle: h, share: { mentor: false } } })).d.key;
const idOf = async h => (await call('/admin/members', { admin: true })).d.members.find(m => m.handle === h).id;
const act = async (h, action) => call('/admin/members/' + await idOf(h), { method: 'POST', admin: true, body: { action } });
const inbox = async k => (await call('/inbox', { key: k })).d.items;
const share = (k, key, extra) => call('/reviews', { method: 'POST', key: k, body: Object.assign({ key, trade: TR }, extra || {}) });
let A, C, M2, D, E, rid;
try {
  A = await join_('alice'); C = await join_('carol'); M2 = await join_('mona'); D = await join_('dave'); E = await join_('erin');
  await t('sending needs mentors let in, and a mentor on the server', async () => {
    eq((await share(A, 'tradeaaa1')).status, 403);
    await call('/me', { method: 'PUT', key: A, body: { share: { mentor: true } } });
    eq((await share(A, 'tradeaaa1')).status, 409, 'no mentors appointed yet');
    await act('carol', 'mentor'); await act('mona', 'mentor');
    eq((await share(A, 'BAD KEY!')).status, 400); eq((await call('/reviews', { method: 'POST', key: A, body: { key: 'tradeaaa1', trade: { coin: 'BTC' } } })).status, 400);
  });
  await t('a member sends a trade: the mentors get it in their inbox and in “Trades to review”', async () => {
    const r = await share(A, 'tradeaaa1', { text: 'Did I size this right?' });
    eq(r.status, 200); rid = r.d.review.id; ok(/^[a-f0-9]{12}$/.test(rid));
    eq([r.d.role, r.d.review.key, r.d.review.handle, r.d.review.trade.usd, r.d.review.waiting, r.d.review.reviewed], ['mentee', 'tradeaaa1', 'alice', undefined, true, null]);
    eq(r.d.comments.map(c => [c.handle, c.text, c.mentor, c.mine]), [['alice', 'Did I size this right?', false, true]]);
    for (const k of [C, M2]) { const it = (await inbox(k))[0]; eq([it.kind, it.text, it.url], ['mentor', '@alice sent a trade for review: BTC long', '/daruma#tr/' + rid]); }
    const L = (await call('/reviews', { key: C })).d;
    eq([L.toReview.length, L.toReview[0].id, L.toReview[0].key, L.toReview[0].trade.size, L.mine], [1, rid, null, 2, []]);
    eq((await call('/reviews', { key: D })).d.toReview, null, 'not a mentor: no list');
    eq((await call('/reviews', { key: A })).d.mine.map(x => x.id), [rid]);
  });
  await t('only the member and the mentors see the thread', async () => {
    eq((await call('/reviews/' + rid, { key: D })).status, 404);
    eq((await call('/reviews/' + rid + '/comments', { method: 'POST', key: D, body: { text: 'hi' } })).status, 404);
    eq((await call('/reviews/' + rid, { key: C })).d.role, 'mentor');
    eq((await call('/reviews/nothexatall', { key: A })).status, 404);
  });
  await t('mentors comment (more than once), the member replies, a mentor marks it reviewed', async () => {
    clock += 60000; eq((await call('/reviews/' + rid + '/comments', { method: 'POST', key: C, body: { text: 'Size was fine. The entry was early.' } })).status, 200);
    clock += 60000; await call('/reviews/' + rid + '/comments', { method: 'POST', key: C, body: { text: 'Wait for the candle to close next time.' } });
    const ai = await inbox(A); eq([ai[0].text, ai[0].url, ai[0].title], ['@carol on your BTC long: Wait for the candle to close next time.', '/daruma#tr/' + rid, 'Your mentor on a trade']);
    eq((await call('/reviews', { key: C })).d.toReview[0].waiting, false, 'answered');
    const monaBefore = (await inbox(M2)).length;
    clock += 60000; await call('/reviews/' + rid + '/comments', { method: 'POST', key: A, body: { text: 'Got it, thanks.' } });
    eq((await inbox(C))[0].text, '@alice replied on their BTC long: Got it, thanks.');
    eq((await inbox(M2)).length, monaBefore, 'the reply goes to the mentor in the thread');
    eq((await call('/reviews', { key: C })).d.toReview[0].waiting, true, 'their turn again');
    eq((await call('/reviews/' + rid + '/reviewed', { method: 'POST', key: A, body: {} })).status, 403, 'the member can’t mark it');
    const r = await call('/reviews/' + rid + '/reviewed', { method: 'POST', key: C, body: { done: true } });
    eq([r.d.review.reviewed.by, r.d.review.waiting], ['carol', false]);
    eq((await inbox(A))[0].text, '@carol reviewed your BTC long ✓');
    const th = (await call('/reviews/' + rid, { key: A })).d;
    eq(th.comments.map(c => [c.handle, c.mentor]), [['alice', false], ['carol', true], ['carol', true], ['alice', false]]);
    eq([th.review.comments, th.review.reviewed.by], [4, 'carol']);
  });
  await t('sending the same trade again updates it in place: no new thread, no new alert, no day slot used', async () => {
    const before = (await inbox(C)).length;
    const r = await share(A, 'tradeaaa1', { trade: Object.assign({}, TR, { note: 'Edited note' }) });
    eq([r.d.review.id, r.d.review.trade.note, r.d.review.reviewed.by], [rid, 'Edited note', 'carol']);
    eq((await inbox(C)).length, before);
  });
  await t('dollars only while the member shares dollar P&L', async () => {
    await call('/me', { method: 'PUT', key: A, body: { share: { usd: true } } });
    eq((await share(A, 'tradeaaa1')).d.review.trade.usd, 412.35);
    eq((await call('/reviews/' + rid, { key: C })).d.review.trade.usd, 412.35);
    await call('/me', { method: 'PUT', key: A, body: { share: { usd: false } } });
    eq((await call('/reviews/' + rid, { key: C })).d.review.trade.usd, undefined, 'hidden again at once');
  });
  await t('opting out of mentors closes every thread to them at once (the member keeps it); opting back in reopens it', async () => {
    await call('/me', { method: 'PUT', key: A, body: { share: { mentor: false } } });
    eq((await call('/reviews/' + rid, { key: C })).status, 404);
    eq((await call('/reviews/' + rid + '/comments', { method: 'POST', key: C, body: { text: 'still here?' } })).status, 404);
    eq((await call('/reviews', { key: C })).d.toReview, []);
    eq((await call('/reviews/' + rid, { key: A })).d.comments.length, 4);
    eq((await share(A, 'tradebbb2')).status, 403, 'and no new ones go out');
    await call('/me', { method: 'PUT', key: A, body: { share: { mentor: true } } });
    eq((await call('/reviews/' + rid, { key: C })).status, 200);
  });
  await t('a mentor the owner stands down loses access; a suspended member’s threads are closed to mentors', async () => {
    await act('mona', 'unmentor'); eq((await call('/reviews/' + rid, { key: M2 })).status, 404); eq((await call('/reviews', { key: M2 })).d.toReview, null);
    await act('alice', 'ban'); eq((await call('/reviews/' + rid, { key: C })).status, 404); await act('alice', 'unban');
  });
  await t('admins read every thread for moderation, read-only; members can’t use the admin view', async () => {
    const L = await call('/admin/reviews', { admin: true }); eq(L.d.reviews.map(r => [r.id, r.handle, r.key]), [[rid, 'alice', null]]);
    const th = await call('/admin/reviews/' + rid, { admin: true }); eq([th.d.role, th.d.comments.length, th.d.comments.every(c => !c.mine)], ['admin', 4, true]);
    eq((await call('/admin/reviews/' + rid + '/comments', { method: 'POST', admin: true, body: { text: 'x' } })).status, 404, 'no writing');
    eq((await call('/admin/reviews', { key: D })).status, 401);
    await call('/admin/members/' + await idOf('erin'), { method: 'POST', admin: true, body: { action: 'admin' } });
    eq((await call('/admin/reviews/' + rid, { key: E })).d.review.id, rid, 'an admin member, with their own key');
    eq((await call('/reviews/' + rid, { key: E })).status, 404, 'the member view stays mentee-and-mentors only');
  });
  await t('limits: long text is cut, comments are rate limited, threads and daily sends are capped', async () => {
    clock += 3600001; const r = await call('/reviews/' + rid + '/comments', { method: 'POST', key: C, body: { text: 'x'.repeat(5000) } });
    eq(r.d.comments[r.d.comments.length - 1].text.length, 1000);
    eq((await call('/reviews/' + rid + '/comments', { method: 'POST', key: C, body: { text: '  ' } })).status, 400);
    let st = []; for (let i = 0; i < 60; i++) st.push((await call('/reviews/' + rid + '/comments', { method: 'POST', key: C, body: { text: 'c' + i } })).status);
    eq([st.filter(s => s === 200).length, st[st.length - 1]], [59, 429], '60 an hour, per member');
    clock += 3600001;
    for (let i = 0; i < 200 && st[st.length - 1] !== 409; i++) { clock += 61000; st.push((await call('/reviews/' + rid + '/comments', { method: 'POST', key: i % 2 ? A : C, body: { text: 'n' + i } })).status); }
    eq(st[st.length - 1], 409); eq((await call('/reviews/' + rid, { key: A })).d.review.comments, 200);
    clock += 86400000; st = [];
    for (let i = 0; i < 11; i++) st.push((await share(A, 'daycap' + i)).status);
    eq([st.slice(0, 10).every(s => s === 200), st[10]], [true, 429]);
  });
  await t('the member can take a trade back: the thread goes with it', async () => {
    const id = (await call('/reviews', { key: A })).d.mine.find(x => x.key === 'daycap0').id;
    eq((await call('/reviews/' + id, { method: 'DELETE', key: C })).status, 403);
    eq((await call('/reviews/' + id, { method: 'DELETE', key: A })).status, 200);
    eq((await call('/reviews/' + id, { key: A })).status, 404);
  });
  await t('deleting a profile takes what it wrote: a mentor’s comments go, and a member’s trades and threads go entirely', async () => {
    clock += 86400000; const id = (await share(A, 'tradeccc3', { text: 'Second one' })).d.review.id;
    await call('/reviews/' + id + '/comments', { method: 'POST', key: C, body: { text: 'Carol was here' } });
    await call('/reviews/' + id + '/reviewed', { method: 'POST', key: C, body: {} });
    const cid = await idOf('carol');
    eq((await call('/me', { method: 'DELETE', key: C })).status, 200);
    const th = (await call('/reviews/' + id, { key: A })).d;
    eq([th.comments.map(c => c.text), th.review.comments, th.review.reviewed.by], [['Second one'], 1, null]);
    const db = require('../db.js').open(dataDir);
    try { eq(db.q('SELECT count(*) AS n FROM review_comments WHERE member = ? OR text = ?').get(cid, 'Carol was here').n, 0); eq(db.q('SELECT count(*) AS n FROM reviews WHERE reviewer = ?').get(cid).n, 0); }
    finally { db.close(); }
    const aid = await idOf('alice');
    eq((await call('/me', { method: 'DELETE', key: A })).status, 200);
    const left = storedText(dataDir); ok(!left.includes(aid) && !left.includes('Second one') && !left.includes('Took it at the retest'), 'nothing of alice’s is left');
    eq((await call('/admin/reviews', { admin: true })).d.reviews, []);
  });
} finally { app.close(); }
report('reviews');
