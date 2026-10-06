// Mentoring as a relationship both sides agree to: mentors see nobody by default; a member asks, the
// mentor takes them on or says no (or takes requests on at once while they have room), and either side
// can end it. Then what they do together: threads under day notes, the week's focus and how often its
// slip comes up, the mentee at a glance, a reminder before held XP goes back, "did this help?" in the
// track record, and the one-time carry-over of relationships that were already working.
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { t, ok, eq, report, storedText } from './harness.mjs';

const require = createRequire(import.meta.url);
const server = require('../server.js');
const htmlPath = new URL('../ledger.html', import.meta.url).pathname;
const DAY = 864e5, HOUR = 36e5, key = ms => new Date(ms).toISOString().slice(0, 10);
let clock = Date.parse('2026-10-20T20:00:00Z');

const dataDir = mkdtempSync(join(tmpdir(), 'ledger-mrel-'));
const mkApp = () => server.createApp({ dataDir, auth: 'owner-token', htmlPath, now: () => clock, push: false, pushTick: false, offsiteTimer: false, trustProxy: true,
  fetchImpl: async () => ({ ok: true, status: 200, json: async () => [] }) });
let app = mkApp();
let B = await new Promise(res => app.listen(0, () => res('http://127.0.0.1:' + app.address().port)));
let ipN = 0;
const call = async (p, o = {}) => { const r = await fetch(B + '/api/social' + p, { method: o.method || 'GET', headers: { 'Content-Type': 'application/json', ...(p === '/join' ? { 'X-Forwarded-For': '10.0.2.' + (++ipN) } : {}), ...(o.key ? { 'X-Pulse-Key': o.key } : {}), ...(o.admin ? { Authorization: 'Bearer owner-token' } : {}) }, body: o.body ? JSON.stringify(o.body) : undefined });
  return { status: r.status, d: await r.json().catch(() => ({})) }; };
const join_ = async (h, extra) => (await call('/join', { method: 'POST', body: Object.assign({ handle: h }, extra || {}) })).d.key;
const idOf = async h => (await call('/admin/members', { admin: true })).d.members.find(m => m.handle === h).id;
const me = async k => (await call('/me', { key: k })).d;
const inbox = async k => (await call('/inbox', { key: k })).d.items;
const ask = (k, h, extra) => call('/mentors/' + h, { method: 'POST', key: k, body: Object.assign({ action: 'pick', letIn: true }, extra || {}) });
const answer = (k, h, a, text) => call('/mentor/' + h + '/' + a, { method: 'POST', key: k, body: text ? { text } : {} });
let tn = 0; const TR = () => ({ coin: 'ETH', label: 'ETH', side: 'long', market: 'perp', openedAt: clock - 5 * HOUR - (++tn) * 60000, closedAt: clock - HOUR, entry: 1, exit: 2 });
const send = (k, body) => call('/reviews', { method: 'POST', key: k, body: Object.assign({ key: 'trade' + String(++tn).padStart(4, '0'), trade: TR() }, body) });
const days = (n, f) => Array.from({ length: n }, (_, i) => ({ k: key(clock - (n - 1 - i) * DAY), s: 70, ...(f(i) ? { f: f(i) } : {}), l: 'lesson ' + i }));

let MIA, KAI, NED, OLU, PAM;
try {
  await call('/admin/config', { method: 'PUT', admin: true, body: { requireClaim: false, unlocksOn: false, standing: { on: false } } });
  MIA = await join_('mia'); KAI = await join_('kai'); NED = await join_('ned'); OLU = await join_('olu'); PAM = await join_('pam');
  for (const h of ['mia', 'kai']) await call('/admin/members/' + await idOf(h), { method: 'POST', admin: true, body: { action: 'mentor' } });
  for (const [h, k] of [['ned', NED], ['olu', OLU], ['pam', PAM]]) { await call('/stats', { method: 'POST', key: k, body: { xp: 10, level: 1, tz: 'UTC', days: [] } });
    await call('/admin/members/' + await idOf(h), { method: 'POST', admin: true, body: { action: 'grant', xp: 500, why: 'Start' } }); }

  await t('a new member lets no mentor in, and no mentor sees them until one takes them on', async () => {
    eq((await me(NED)).share.mentor, false);
    await call('/me', { method: 'PUT', key: OLU, body: { share: { mentor: true } } });
    eq((await call('/mentor', { key: MIA })).d.mentees, [], 'letting mentors in isn’t asking one');
    eq((await call('/mentor/olu', { key: MIA })).status, 404);
    await call('/stats', { method: 'POST', key: OLU, body: { xp: 10, level: 1, tz: 'UTC', days: [{ k: key(clock), s: 60, l: 'nobody reads this yet' }] } });
    ok(!storedText(dataDir).includes('nobody reads this yet'), 'no lesson is kept while no mentor can read it');
  });
  await t('asking: the mentor hears it with what the member wants help with, sees them at a glance, and decides', async () => {
    const r = await ask(NED, 'mia', { text: 'I revenge trade after a stop-out' });
    eq([r.status, r.d.took, r.d.me.requests, r.d.me.picks, r.d.share.mentor], [200, false, ['mia'], [], true]);
    eq((await call('/mentors/mia', { key: NED })).d.mentor.requested, true);
    ok((await inbox(MIA)).some(x => x.title === 'A mentoring request' && /@ned would like you to mentor them\. “I revenge trade after a stop-out”/.test(x.text)));
    const d = (await call('/mentor', { key: MIA })).d;
    eq([d.mentees, d.requests.map(x => [x.handle, x.text]), d.slots, d.auto], [[], [['ned', 'I revenge trade after a stop-out']], { used: 0, total: 5 }, false]);
    eq((await call('/mentor/ned', { key: MIA })).status, 404, 'days stay closed until a yes');
    eq((await send(NED, {})).status, 409, 'no trades before a yes');
    eq((await ask(NED, 'mia')).status, 409, 'asked already');
  });
  await t('two at most, counting open requests; taking a request back frees the place', async () => {
    eq((await ask(NED, 'kai')).status, 200);
    await call('/admin/members/' + await idOf('pam'), { method: 'POST', admin: true, body: { action: 'mentor' } });
    const third = await ask(NED, 'pam'); eq(third.status, 409); ok(/mentors or open requests/.test(third.d.error));
    eq((await call('/mentors/kai', { method: 'POST', key: NED, body: { action: 'drop' } })).d.me.requests, ['mia']);
    eq((await call('/mentor', { key: KAI })).d.requests, []);
    await call('/admin/members/' + await idOf('pam'), { method: 'POST', admin: true, body: { action: 'unmentor' } });
  });
  await t('saying no: the member hears it and can ask that mentor again in a week', async () => {
    eq((await answer(KAI, 'ned', 'decline')).status, 404, 'not kai’s request');
    eq((await answer(MIA, 'ned', 'decline', 'Full this month')).status, 200);
    ok((await inbox(NED)).some(x => /@mia can’t take you on right now: “Full this month”/.test(x.text)));
    const again = await ask(NED, 'mia'); eq([again.status, again.d.declined], [409, true]);
    eq((await call('/mentors/mia', { key: NED })).d.mentor.declinedUntil, clock + 7 * DAY);
    clock += 7 * DAY + 1000;
    eq((await ask(NED, 'mia', { text: 'Second try' })).status, 200);
  });
  await t('taking someone on opens their days and trades; slots count those taken on', async () => {
    await call('/me', { method: 'PUT', key: MIA, body: { mentorSlots: 1 } });
    eq((await ask(OLU, 'mia')).status, 200, 'mia has room: a request is fine');
    const a = await answer(MIA, 'ned', 'accept'); eq([a.status, a.d.mentee.handle], [200, 'ned']);
    ok((await inbox(NED)).some(x => x.title === 'You have a mentor' && /@mia took you on/.test(x.text)));
    eq((await me(NED)).me.myMentors, ['mia']);
    eq((await call('/mentor/ned', { key: MIA })).status, 200);
    const full = await answer(MIA, 'olu', 'accept'); eq([full.status, full.d.full], [409, true], 'one slot, and ned has it');
    eq((await ask(PAM, 'mia')).d.full, true, 'full: a new request waits on the waitlist instead');
    await call('/me', { method: 'PUT', key: MIA, body: { mentorSlots: 5 } });
    eq((await answer(MIA, 'olu', 'accept')).status, 200);
  });
  await t('a mentor who takes requests on at once while they have room', async () => {
    eq((await call('/me', { method: 'PUT', key: KAI, body: { mentorAuto: true } })).d.me.mentorAuto, true);
    eq((await call('/mentors/kai', { key: PAM })).d.mentor.auto, true);
    const r = await ask(PAM, 'kai'); eq([r.d.took, r.d.me.picks], [true, ['kai']]);
    ok((await inbox(KAI)).some(x => x.title === 'A new mentee' && /@pam picked you/.test(x.text)));
    eq((await call('/mentor/pam', { key: KAI })).status, 200);
  });
  await t('letting mentors out ends the mentoring and drops open requests', async () => {
    const Q = await join_('quin'); await ask(Q, 'mia');
    eq((await call('/mentor', { key: MIA })).d.requests.map(x => x.handle), ['quin']);
    await call('/me', { method: 'PUT', key: Q, body: { share: { mentor: false } } });
    eq((await call('/mentor', { key: MIA })).d.requests, []);
    eq((await me(Q)).me.mentorRequests, []);
  });
  let nid;
  await t('a note has a thread: the member answers in one tap or a reply, the mentor answers back', async () => {
    await call('/stats', { method: 'POST', key: NED, body: { xp: 10, level: 1, tz: 'UTC', days: [{ k: key(clock), s: 55, f: ['revenge'], l: 'Walk away after a stop' }] } });
    nid = (await call('/mentor/ned/notes', { method: 'POST', key: MIA, body: { day: key(clock), text: 'Set a 15-minute timer after every stop.' } })).d.note.id;
    eq((await call('/notes/' + nid + '/reply', { method: 'POST', key: NED, body: { ack: 'maybe' } })).status, 400);
    eq((await call('/notes/' + nid + '/reply', { method: 'POST', key: NED, body: { ack: 'try' } })).d.note.ack, 'try');
    ok((await inbox(MIA)).some(x => x.title === 'Your note landed' && /@ned will try what you said/.test(x.text)));
    const r = await call('/notes/' + nid + '/reply', { method: 'POST', key: NED, body: { text: 'Does the timer count on a winning day?' } });
    eq(r.d.note.replies.map(y => [y.by, y.mentor]), [['ned', false]]);
    ok((await inbox(MIA)).some(x => x.title === 'A reply to your note'));
    eq((await call('/mentor', { key: MIA })).d.mentees.find(x => x.handle === 'ned').unread, 1);
    const page = (await call('/mentor/ned', { key: MIA })).d.mentee; eq([page.notes[0].ack, page.notes[0].replies.length], ['try', 1]);
    eq((await call('/mentor', { key: MIA })).d.mentees.find(x => x.handle === 'ned').unread, 0, 'opening the page reads it');
    eq((await call('/mentor/ned/notes/' + nid + '/reply', { method: 'POST', key: KAI, body: { text: 'x' } })).status, 404, 'not kai’s mentee');
    const back = await call('/mentor/ned/notes/' + nid + '/reply', { method: 'POST', key: MIA, body: { text: 'Every stop, every day.' } });
    eq(back.d.note.replies.map(y => [y.by, y.mentor, y.text]), [['ned', false, 'Does the timer count on a winning day?'], ['mia', true, 'Every stop, every day.']]);
    ok((await inbox(NED)).some(x => x.title === 'Your mentor answered'));
    eq((await call('/notes/' + nid + '/reply', { method: 'POST', key: NED, body: { ack: null } })).d.note.ack, null, 'the tap can be taken back');
  });
  await t('the week’s focus: the member sees it, and how often its slip has come up since against the four weeks before', async () => {
    // ned's last 28 days: revenge on every other day; after the focus is set, on one of five
    await call('/stats', { method: 'POST', key: NED, body: { xp: 10, level: 1, tz: 'UTC', days: days(28, i => i % 2 ? ['revenge'] : i % 7 === 0 ? ['overtrade'] : null) } });
    eq((await call('/mentor/ned/focus', { method: 'POST', key: MIA, body: { text: '' } })).status, 400);
    const f = (await call('/mentor/ned/focus', { method: 'POST', key: MIA, body: { text: 'No new trade for 15 minutes after a stop', slip: 'revenge' } })).d.focus;
    eq([f.text, f.slip, f.from, f.progress.since, f.progress.before], ['No new trade for 15 minutes after a stop', 'revenge', key(clock), { days: 1, slip: 1 }, { days: 27, slip: 13 }]);
    ok((await inbox(NED)).some(x => x.title === 'Your focus this week'));
    clock += 4 * DAY;
    const later = days(32, i => i < 28 ? (i % 2 ? ['revenge'] : null) : i === 30 ? ['revenge'] : null);
    await call('/stats', { method: 'POST', key: NED, body: { xp: 10, level: 1, tz: 'UTC', days: later } });
    const mine = (await call('/notes', { key: NED })).d.focus;
    eq(mine.map(x => [x.by, x.progress.since]), [['mia', { days: 5, slip: 2 }]], 'the day it was set and one since');
    eq((await call('/mentor', { key: MIA })).d.mentees.find(x => x.handle === 'ned').focus.text, 'No new trade for 15 minutes after a stop');
    eq((await call('/mentor/ned/focus', { method: 'DELETE', key: MIA })).d.focus, null);
    eq((await call('/notes', { key: NED })).d.focus, []);
  });
  await t('the mentee at a glance: each slip, latest 14 trading days against the 14 before, and the trades they sent you', async () => {
    await call('/stats', { method: 'POST', key: NED, body: { xp: 10, level: 1, tz: 'UTC', days: days(28, i => i < 14 ? ['revenge', 'sizeUp'] : i % 7 === 0 ? ['revenge'] : null).map((d, i) => Object.assign(d, { s: i < 14 ? 50 : 80 })) } });
    const r = await send(NED, {}); eq(r.status, 200);
    const m = (await call('/mentor/ned', { key: MIA })).d.mentee;
    eq(m.insight.slips, [{ k: 'revenge', recent: 2, before: 14 }, { k: 'sizeUp', recent: 0, before: 14 }]);
    eq(m.insight.discipline, { recent: 80, before: 50, nRecent: 14, nBefore: 14 });
    eq(m.reviews.map(x => x.id), [r.d.review.id]);
    eq((await call('/mentor/ned', { key: KAI })).status, 404);
  });
  await t('held XP: the mentor is reminded once, a quarter of the hold time before it goes back', async () => {
    await call('/me', { method: 'PUT', key: MIA, body: { mentorRate: 30 } });
    eq((await send(NED, { fee: 30 })).d.review.fee.state, 'free', 'the first trade with a paid mentor');
    const r = await send(NED, { fee: 30 }); eq(r.d.review.fee.state, 'held');
    clock += 50 * HOUR; await call('/reviews', { key: MIA });
    ok(!(await inbox(MIA)).some(x => x.title === 'A review is due'), 'not yet at 50 of 72 hours');
    clock += 5 * HOUR; await call('/reviews', { key: MIA });
    const due = (await inbox(MIA)).filter(x => x.title === 'A review is due'); eq(due.length, 1);
    ok(/About 17 hours left on @ned’s ETH long\. Comment and mark it reviewed for the 30 XP/.test(due[0].text), due[0].text);
    clock += 2 * HOUR; await call('/reviews', { key: MIA });
    eq((await inbox(MIA)).filter(x => x.title === 'A review is due').length, 1, 'once');
  });
  await t('“did this review help?”: the member answers once it’s reviewed; the track record shows the share of yeses from five answers', async () => {
    const ids = [];
    for (let i = 0; i < 5; i++) { clock += 61000; const r = await send(NED, { fee: 30 }); ids.push(r.d.review.id);
      await call('/reviews/' + r.d.review.id + '/comments', { method: 'POST', key: MIA, body: { text: 'Look at the entry.' } }); }
    eq((await call('/reviews/' + ids[0] + '/helped', { method: 'POST', key: NED, body: { helped: true } })).status, 409, 'not reviewed yet');
    for (const id of ids) await call('/reviews/' + id + '/reviewed', { method: 'POST', key: MIA, body: { done: true } });
    eq((await call('/reviews/' + ids[0] + '/helped', { method: 'POST', key: MIA, body: { helped: true } })).status, 403, 'the mentor can’t answer for them');
    for (const [i, v] of [true, true, true, false].entries()) eq((await call('/reviews/' + ids[i] + '/helped', { method: 'POST', key: NED, body: { helped: v } })).d.review.helped, v);
    let rec = (await call('/mentors/mia', { key: OLU })).d.mentor.record; eq([rec.helped, rec.answers], [null, 4], 'four answers: too few to say');
    await call('/reviews/' + ids[4] + '/helped', { method: 'POST', key: NED, body: { helped: true } });
    rec = (await call('/mentors/mia', { key: OLU })).d.mentor.record; eq([rec.helped, rec.answers], [80, 5]);
    await call('/reviews/' + ids[3] + '/helped', { method: 'POST', key: NED, body: { helped: null } });
    eq((await call('/mentors/mia', { key: OLU })).d.mentor.record.answers, 4, 'an answer can be taken back');
    eq((await call('/mentors?sort=helped', { key: OLU })).status, 200);
  });
  await t('the mentor lets a mentee go: held XP goes back, the focus goes, the slot opens', async () => {
    await call('/mentor/ned/focus', { method: 'POST', key: MIA, body: { text: 'Keep the timer' } });
    const r = await send(NED, { fee: 30 }); eq(r.d.review.fee.state, 'held');
    const before = (await me(NED)).me.wallet.held;
    eq((await answer(KAI, 'ned', 'release')).status, 404);
    eq((await answer(MIA, 'ned', 'release', 'You’re ready to fly solo')).status, 200);
    ok((await inbox(NED)).some(x => x.title === 'Mentoring ended' && /“You’re ready to fly solo”/.test(x.text)));
    ok(before >= 30, before); const after = await me(NED); eq([after.me.myMentors, after.me.wallet.held], [[], 0], 'everything held for mia comes back');
    eq((await call('/mentor/ned', { key: MIA })).status, 404);
    eq((await call('/notes', { key: NED })).d.focus, []);
  });
  await t('in the app: the request, note thread, focus and helped screens are there', async () => {
    const src = (await import('../app-source.js')).readAppSource(htmlPath);
    for (const s of ['data-soc-mreq="accept"', 'data-soc-mrelease', 'data-soc-nack', 'data-soc-focus="save"', 'data-mr-helped', 'Ask @\'+h+\' to mentor me', 'function socMentorFocusHtml', 'function mrQueueSort']) ok(src.includes(s), s);
  });
  await t('upgrading: working relationships carry over once, up to two, most recent first; everyone else is seen by nobody', async () => {
    // the state a server had before: members let mentors in without picking; mentors left notes and comments
    const ids = { mia: await idOf('mia'), kai: await idOf('kai') };
    const V = await join_('vera'), W = await join_('walt'), X = await join_('xena');
    for (const k of [V, W, X]) await call('/me', { method: 'PUT', key: k, body: { share: { mentor: true } } });
    const vid = await idOf('vera'), wid = await idOf('walt');
    app.close();
    const db = require('../db.js').open(dataDir);
    try {
      const mig = JSON.parse(db.q("SELECT v FROM kv WHERE k = 'migrations'").get().v); delete mig.mentorOptIn;
      db.q("UPDATE kv SET v = ? WHERE k = 'migrations'").run(JSON.stringify(mig));
      const C = JSON.parse((db.q("SELECT v FROM kv WHERE k = 'comments'").get() || { v: '{}' }).v);
      C[vid] = [{ id: 'old1', by: ids.mia, day: null, text: 'Old note', at: clock - 10 * DAY, read: true }, { id: 'old2', by: ids.kai, day: null, text: 'Newer note', at: clock - 2 * DAY, read: true }];
      C[wid] = [{ id: 'old3', by: ids.mia, day: null, text: 'Long ago', at: clock - 200 * DAY, read: true }];
      db.q("INSERT OR REPLACE INTO kv (k, v) VALUES ('comments', ?)").run(JSON.stringify(C));
    } finally { db.close(); }
    app = mkApp(); B = await new Promise(res => app.listen(0, () => res('http://127.0.0.1:' + app.address().port)));
    eq((await me(V)).me.myMentors, ['kai', 'mia'], 'kai’s note is the more recent');
    eq((await me(W)).me.myMentors, [], 'a note from 200 days ago isn’t a working relationship');
    eq((await me(X)).me.myMentors, []);
    eq((await call('/mentor/vera', { key: MIA })).status, 200); eq((await call('/mentor/walt', { key: MIA })).status, 404);
  });
} finally { app.close(); }
report('mentor relationship');
