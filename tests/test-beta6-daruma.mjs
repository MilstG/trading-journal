// Daruma's phone beta (the sixth round, AUDIT-6): a note sent to a mentor is kept in the journal (D1), one %
// per trade card (D2), Daruma's note on trades closed off the record says it once per trade, ever, in words that
// fit spot (D3), "% return" starts off for new profiles only (D4), one source and one window for a member's
// 7-day Discipline everywhere (D5), an open duel is named before a second challenge is written (D6), and a
// profile knows where you stand as partners (D8). Client code runs from the app files; the server over HTTP.
import vm from 'node:vm';
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { t, ok, eq, report, makeExtractor } from './harness.mjs';
import { readAppSource } from '../app-source.js';

const require = createRequire(import.meta.url);
const server = require('../server.js');
const htmlPath = new URL('../ledger.html', import.meta.url).pathname;
const html = readAppSource(htmlPath);
const { grabFn } = makeExtractor(html);
const grabConst = name => { const i = html.indexOf('const ' + name + '='); if (i < 0) throw new Error(name); return html.slice(i, html.indexOf(';\n', i) + 1); };

console.log('\nD1 · Ask mentor keeps the note in the journal');
const mk = () => { const posts = [];
  const c = { Math, Object, Array, String, Number, JSON, isFinite, Date, Set, Map, console, posts, PZ: true, J_KEY: 'j',
    pzS: { jr: { T1: 4 }, mrAsk: null }, journal: {}, _excM: {}, location: { hash: '#journal' },
    allTrades: [{ id: 'T1', coin: 'BTC', dir: 'Long', market: 'perp', openTime: 1, closeTime: 2, avgEntry: 100, avgExit: 97, maxSize: 1, net: -3.05 }],
    SOC: { me: { handle: 'bravo' }, share: { mentor: true }, cache: {} },
    Store: { set: async () => {} }, markJEdit: () => {}, pzNote: () => {}, pzRender: () => {}, pzCanonSetup: s => s, playbookFor: () => null, pbList: () => [],
    tradeQuestion: () => ({ q: 'Was this a good trade that didn’t work?' }), rFor: () => null, dayKey: () => 'k', dispMarket: x => x, dcoin: t => t.coin, retPct: t => t.net / (t.maxSize * t.avgEntry) * 100,
    socFetch: async (p, o) => { posts.push({ p, body: o && o.body ? JSON.parse(o.body) : null }); if (p === '/reviews' && !o) return c.reviewsList; return { review: { id: 'r1', to: 'alpha_owner' } }; } };
  c.ensureJ = id => c.journal[id] || (c.journal[id] = {});
  vm.createContext(c);
  vm.runInContext(['mrTradeKey', 'mrSizeRange', 'mrSummary', 'mrShare', 'mrAction', 'pzSaveJournal'].map(grabFn).join('\n'), c);
  return c; };
const card = () => { const ta = { value: '  held through the dip  ' }, setup = { value: 'breakout' };
  const sec = { dataset: { pzTrade: 'T1' }, querySelector: s => s === 'textarea' ? ta : s === 'input[type=text]' ? setup : null };
  return { sec, ta, btn: { dataset: { mrShare: 'T1' }, closest: s => s === '[data-pz-trade]' ? sec : null } }; };
await t('typed and not saved, then Ask mentor: the journal keeps it, the trade leaves the backlog, the mentor gets it once', async () => {
  const c = mk(), { btn, ta } = card();
  c.reviewsList = { to: [{ handle: 'alpha_owner', rate: 0 }], rates: { holdHours: 48 } }; // one free mentor: it goes straight away
  ok(await c.mrAction(btn));
  const j = c.journal.T1; eq([j.notes, j.setup, j.rating], ['Was this a good trade that didn’t work?\nheld through the dip', 'breakout', 4]);
  eq(ta.value, '', 'the box is emptied, so a later Save doesn’t add the same line again');
  const sent = c.posts.find(x => x.p === '/reviews' && x.body); eq(sent.body.to, 'alpha_owner');
  eq(sent.body.trade.note, 'Was this a good trade that didn’t work?\nheld through the dip', 'the note, once (from the journal entry)');
  eq(c.location.hash, '#tr/r1');
});
await t('two mentors to pick from: saved before the picker opens, and the picker carries nothing unsaved', async () => {
  const c = mk(), { btn } = card();
  c.reviewsList = { to: [{ handle: 'alpha_owner', rate: 0 }, { handle: 'charlie', rate: 50 }], rates: { holdHours: 48 } };
  ok(await c.mrAction(btn));
  eq(c.location.hash, '#askmentor'); ok(c.journal.T1.notes.endsWith('held through the dip')); eq(c.pzS.mrAsk.extra, '');
});
await t('nothing typed: Ask mentor still sends, and writes nothing to the journal', async () => {
  const c = mk(), { btn, ta, sec } = card(); ta.value = ''; sec.querySelector = s => s === 'textarea' ? ta : s === 'input[type=text]' ? { value: '' } : null; c.pzS.jr = {};
  c.reviewsList = { to: [], rates: { holdHours: 48 } };
  ok(await c.mrAction(btn)); eq(c.journal.T1, undefined); ok(c.posts.some(x => x.p === '/reviews' && x.body));
});
t('the card shows its question above the box, so the line it saves is one the trader saw', () => {
  const src = grabFn('pzJournalHtml');
  ok(/<label class="pz-noteq" for="pzNoteT_/.test(src), 'a visible label'); ok(!/placeholder="\$\{esc\(q\)\}"/.test(src), 'not a placeholder that a 2-row box cuts off');
});

console.log('\nD2 · one % on a trade card');
t('the card’s % is the trade’s return (retPct), the same as its question and the mentor thread', () => {
  const src = grabFn('pzJournalHtml'); ok(/pct=t\.isOpen\?null:retPct\(t\)/.test(src)); ok(!/avgExit\/t\.avgEntry-1/.test(src), 'not the price move');
  const c = { Math, isFinite, console, nfPlan: () => null, isWin: n => n > 1, isLoss: n => n < -1, addedToLoser: () => false };
  c.retPct = t => t.partialHistory ? null : t.net / (t.maxSize * t.avgEntry) * 100; vm.createContext(c);
  vm.runInContext(grabFn('tradeQuestion'), c);
  const tr = { dir: 'Long', avgEntry: 100, avgExit: 97.75, maxSize: 10, net: -30.5 }; // price −2.25%, return −3.05% after fees
  const q = c.tradeQuestion(tr, {}, { mfePct: 2 }).q; ok(q.includes('closed at −3.05%'), q);
});

console.log('\nD3 · trades closed off the record');
{ const store = {}, c = { Math, Object, Array, String, JSON, console, dispMarket: x => x, dcoin: t => t.coin,
    localStorage: { getItem: k => k in store ? store[k] : null, setItem: (k, v) => { store[k] = String(v); } } };
  vm.createContext(c); vm.runInContext(grabConst('ORPH_TOLD') + '\n' + grabFn('orphanLines') + '\n' + grabFn('orphanNoteOnce'), c);
  const perp = { id: 'p1', coin: 'ETH', market: 'perp', dir: 'Long' }, spot = { id: 's1', coin: 'HYPE/USDC', market: 'spot', dir: 'Long' }, spot2 = { id: 's2', coin: 'USDH/USDC', market: 'spot', dir: 'Long' };
  t('spot is never called a liquidation: a balance that left the wallet; perps say liquidation or a gap', () => {
    const L = c.orphanLines([perp, spot, spot2], x => x.coin);
    eq(L, ['1 position (ETH) closed without a closing fill in your history: likely a liquidation or a gap in the history',
      '2 spot balances are no longer in your wallet (HYPE/USDC, USDH/USDC): sent, staked or sold where the fills don’t show it']);
    ok(!/liquidat/.test(c.orphanLines([spot], x => x.coin)[0]));
  });
  t('said once per trade on this device, not on every open; a new one is said alone', () => {
    const first = c.orphanNoteOnce([spot, spot2]); ok(/^2 spot balances are no longer in your wallet/.test(first), first);
    eq(c.orphanNoteOnce([spot, spot2]), null, 'the next open: nothing');
    const next = c.orphanNoteOnce([spot, spot2, perp]); ok(/^1 position \(ETH long\)/.test(next) && !/spot/.test(next), next);
  });
  t('storage that throws (a private window) still says it, and never breaks the load', () => {
    c.localStorage = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
    ok(c.orphanNoteOnce([perp])); });
  t('the full journal’s data-health strip uses the same words', () => { ok(/items\.push\(orphanLines\(orph,/.test(grabFn('renderDataHealth'))); });
}

console.log('\nD4 · % return starts off');
t('the join screen starts with % return off and names it among what stays hidden', () => {
  const c = { Math, Object, Array, String, JSON, console, SOC: { cfg: { open: true, members: 2 }, draft: null }, pzS: {},
    PZ_COL: { low: 'red' }, pzHead: (a, b) => b, socRefCardHtml: () => '', pzLinkCardHtml: () => '', pzI: () => '', socInviteCode: () => '', esc: x => String(x) };
  vm.createContext(c);
  vm.runInContext([grabConst('SOC_DEFAULT_SHARE'), grabConst('SOC_SHARE_ROWS'), grabConst('SOC_SHARE_GROUPS')].join('\n') + '\n' + ['socToggles', 'socToggleRows', 'socJoinHtml'].map(grabFn).join('\n'), c);
  eq(vm.runInContext('SOC_DEFAULT_SHARE.ret', c), false);
  const h = c.socJoinHtml(); ok(/hidden: show % return, show dollar p&amp;l|hidden: show % return, show dollar p&l/.test(h), h.match(/hidden:[^·]*/));
  ok(/data-soc-draft="ret" aria-checked="false"/.test(h));
});

console.log('\nServer');
let clock = Date.parse('2026-10-05T12:00:00Z'); // a Monday
const BEH = {}; // the days the server scores from a wallet's fills
const app = server.createApp({ dataDir: mkdtempSync(join(tmpdir(), 'beta6-')), auth: 'owner-token', htmlPath, now: () => clock, push: false, pushTick: false, offsiteTimer: false, trustProxy: true,
  fetchImpl: async () => ({ ok: true, status: 200, json: async () => [] }), behaviorFor: async addr => BEH[String(addr).toLowerCase()] || [] });
const B = await new Promise(res => app.listen(0, () => res('http://127.0.0.1:' + app.address().port)));
let ipN = 0;
const call = async (p, o = {}) => { const r = await fetch(B + '/api/social' + p, { method: o.method || 'GET',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': o.ip || '10.0.0.1', ...(o.key ? { 'X-Pulse-Key': o.key } : {}), ...(o.owner ? { Authorization: 'Bearer owner-token' } : {}) },
    body: o.body !== undefined ? JSON.stringify(o.body) : undefined });
  return { status: r.status, d: await r.json().catch(() => ({})) }; };
const until = async (f, ms = 4000) => { const end = Date.now() + ms; for (;;) { const v = await f(); if (v || Date.now() > end) return v; await new Promise(r => setTimeout(r, 30)); } };
const K = {};
const join_ = async (h, body) => { K[h] = (await call('/join', { method: 'POST', ip: '10.0.9.' + (++ipN), body: Object.assign({ handle: h }, body || {}) })).d.key; return K[h]; };
// trading days on the app's side: ten of them over three weeks, most recent last (none this Monday)
const KEYS = ['2026-09-14', '2026-09-16', '2026-09-18', '2026-09-21', '2026-09-23', '2026-09-25', '2026-09-28', '2026-09-30', '2026-10-01', '2026-10-02'];
try {
  await call('/admin/config', { method: 'PUT', owner: true, body: { requireClaim: false, unlocksOn: false, modules: { duels: 1 }, standing: { on: false } } });
  await t('D4: a new profile shares % return only when it asks to; one that asks keeps it', async () => {
    await join_('alpha'); eq((await call('/me', { key: K.alpha })).d.share.ret, false);
    await join_('rita', { address: '0x' + '9'.repeat(40), share: { ret: true } }); eq((await call('/me', { key: K.rita })).d.share.ret, true);
  });
  const ADDR = '0x' + 'b'.repeat(40);
  // reported: 60 on every day; verified: 90 on the last seven (the server's reading of the same wallet)
  BEH[ADDR] = KEYS.map((k, i) => ({ k, s: i >= 3 ? 90 : 40, n: 2, f: i === 9 ? ['revenge'] : [] }));
  await join_('bravo', { address: ADDR, share: { verify: true, profile: true, duels: true, mentor: true } });
  await call('/stats', { method: 'POST', key: K.bravo, body: { xp: 900, level: 2, tz: 'UTC', days: KEYS.map(k => ({ k, s: 60, f: ['sizeUp', 'revenge'] })) } });
  await t('D5: the partner card, a mentor’s list and the duel form read one 7-day figure: the last 7 trading days, verified when the wallet is', async () => {
    const r = await call('/partners', { method: 'POST', key: K.alpha, body: { handle: 'bravo' } });
    await call('/partners/' + r.d.partner.id + '/accept', { method: 'POST', key: K.bravo });
    const v = await until(async () => { const x = (await call('/partners', { key: K.alpha })).d.partners[0].view; return x.verified7 ? x : null; });
    eq([v.avg7, v.slips7, v.n7, v.verified7], [90, 1, 7, true], 'not the 60 the app reported, and not a calendar week (no trading this Monday)');
    const w = (await call('/duels/with/bravo', { key: K.alpha })).d.other; eq([w.week, w.weekVerified, w.weekN], [90, true, 7]);
    const ids = (await call('/admin/members', { owner: true })).d.members;
    await call('/admin/members/' + ids.find(m => m.handle === 'rita').id, { method: 'POST', owner: true, body: { action: 'mentor' } });
    await call('/mentors/rita', { method: 'POST', key: K.bravo, body: { action: 'pick', letIn: true } }); await call('/mentor/bravo/accept', { method: 'POST', key: K.rita, body: {} });
    const me = (await call('/mentor', { key: K.rita })).d.mentees.find(x => x.handle === 'bravo'); eq([me.avg7, me.slips7, me.verified7], [90, 1, true]);
  });
  await t('D5: without verification, the last 7 days the app reported (their own window, not this calendar week)', async () => {
    await join_('cora', { share: { verify: false, profile: true } });
    await call('/stats', { method: 'POST', key: K.cora, body: { xp: 50, level: 1, tz: 'UTC', days: KEYS.map((k, i) => ({ k, s: i < 3 ? 0 : 70, f: i === 9 ? ['afterTwo'] : [] })) } });
    const w = (await call('/duels/with/cora', { key: K.alpha })).d.other; eq([w.week, w.weekVerified, w.weekN], [70, false, 7]);
  });
  await t('D6: once a challenge is out or accepted, the form, People and the profile say so (and it’s no “first duel together”)', async () => {
    let x = (await call('/duels/with/bravo', { key: K.alpha })).d; eq([x.busy, x.h2h], [false, { w: 0, l: 0, d: 0, open: 0 }]);
    const s = await call('/duels', { method: 'POST', key: K.alpha, body: { to: 'bravo', type: 'disc', period: 'week', verified: false } }); eq(s.status, 200, JSON.stringify(s.d));
    x = (await call('/duels/with/bravo', { key: K.alpha })).d; eq([x.busy.status, x.busy.awaiting, x.h2h.open], ['pending', 'them', 1]);
    eq((await call('/duels/with/alpha', { key: K.bravo })).d.busy.awaiting, 'me');
    await call('/duels/' + s.d.duel.id, { method: 'POST', key: K.bravo, body: { action: 'accept' } });
    x = (await call('/duels/with/bravo', { key: K.alpha })).d; eq([x.busy.status, x.busy.start, x.h2h.open], ['active', '2026-10-12', 1]);
    const p = (await call('/people?f=duels', { key: K.alpha })).d.people.find(y => y.handle === 'bravo'); eq(p.duelWith, 'active');
    eq((await call('/profile/bravo', { key: K.alpha })).d.profile.duelWith, 'active');
    eq((await call('/profile/cora', { key: K.alpha })).d.profile.duelWith, null);
  });
  await t('D8: a profile knows where you stand as partners: asked, sent, active', async () => {
    eq((await call('/profile/cora', { key: K.alpha })).d.profile.partner, null);
    await call('/partners', { method: 'POST', key: K.alpha, body: { handle: 'cora' } });
    eq((await call('/profile/cora', { key: K.alpha })).d.profile.partner, 'sent');
    eq((await call('/profile/alpha', { key: K.cora })).d.profile.partner, 'asked');
    eq((await call('/profile/bravo', { key: K.alpha })).d.profile.partner, 'active');
    eq((await call('/profile/alpha', { key: K.alpha })).d.profile.partner, undefined, 'not on your own');
  });
} finally { app.close(); }

console.log('\nClient copy');
t('D6/D13: the open duel in one line, and a duel not started yet is “accepted”, not running', () => {
  const c = { Date, console }; vm.createContext(c);
  vm.runInContext(grabConst('duelDate') + '\n' + grabFn('socDuelBusyTxt'), c);
  eq(c.socDuelBusyTxt({ status: 'active', start: '2099-10-12' }, 'bravo'), 'You and @bravo already have a duel: accepted, it starts Oct 12.');
  eq(c.socDuelBusyTxt({ status: 'pending', awaiting: 'them' }, 'bravo'), 'Your challenge to @bravo is waiting for an answer.');
  const src = grabFn('socDuelsHtml'); ok(/grp\('Accepted · starts soon',soon\)/.test(src)); ok(/act=d\.duels\.filter\(v=>v\.status==='active'&&v\.me\)/.test(src));
});
t('D14: a slip row reads its count and, in words, the period before', () => {
  const src = grabFn('pzReportHtml'); ok(src.includes("'(same)':(a<b?'▼':'▲')+' was '+b"));
});
t('D17: a challenge to avoid a size bucket or a setup reads as English', () => {
  const c = { console, habitSentence: () => 'x' }; vm.createContext(c); vm.runInContext(grabFn('pzChallengeTitle'), c);
  eq(c.pzChallengeTitle({ kind: 'avoid', when: 'I’m about to take one of my largest 25% trades' }), 'No trades in your largest 25% this week');
  eq(c.pzChallengeTitle({ kind: 'avoid', when: 'I’m about to take the “breakout” setup' }), 'No “breakout” setups this week');
  eq(c.pzChallengeTitle({ kind: 'avoid', when: 'I’m about to take one of my short trades' }), 'No short trades this week');
});

t('D15: a review’s status names who it waits on, for each side', () => {
  const c = { esc: x => String(x) }; vm.createContext(c); vm.runInContext(grabFn('mrBadge'), c);
  const r = { waiting: true, to: 'alpha_owner', reviewed: null };
  ok(c.mrBadge(r, 'mentee').includes('Waiting for @alpha_owner')); ok(c.mrBadge(r, 'mentor').includes('Waiting for your reply'));
  ok(c.mrBadge(Object.assign({}, r, { to: null }), 'mentee').includes('Waiting for a mentor')); ok(c.mrBadge(r, null).includes('Waiting for @alpha_owner'));
  ok(/x\.mentor&&!x\.mine\?/.test(grabFn('mrThreadInner')), 'your own comment reads “You”, not “You mentor”');
});

report('beta6 daruma');
