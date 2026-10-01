// Pulse view (/pulse): the readiness, risk and trend math behind its dials, the next-step and
// coach lines, the path switch, and the server routes that make it a separately installable app.
import { readFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import vm from 'node:vm';
import { t, ok, eq, report, makeExtractor } from './harness.mjs';

const require = createRequire(import.meta.url);
const server = require('../server.js');
const htmlPath = new URL('../ledger.html', import.meta.url).pathname;
const html = readFileSync(htmlPath, 'utf8');
const { grabFn } = makeExtractor(html);
const grabConst = (name) => { const i = html.indexOf('const ' + name + '='); if (i < 0) throw new Error(name);
  return html.slice(i, html.indexOf(';\n', i) + 1); };

const ctx = { Math, Object, Array, String, JSON, isFinite, journal: {} };
Object.assign(ctx, {
  _be: 50, isWin: n => n > 50, isLoss: n => n < -50, isJournaled: j => !!(j && (j.notes || j.setup || j.rating)),
  _avg: a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0,
  dispMarket: x => x, dcoin: t => t.coin, dayLabel: k => k, isoWeekOfKey: k => k.slice(0, 7), usdPlain: v => '$' + Math.abs(v),
});
vm.createContext(ctx);
vm.runInContext(grabConst('PROCESS_W') + '\n' + ['nfMedian', 'pzReadiness', 'pzScoreOf', 'pzRisk', 'pzTrendStats',
  'pzReadinessLink', 'pzBars', 'pzHasPlan', 'pzBonusItems', 'pzCoachLine'].map(grabFn).join('\n'), ctx);

const DAY = 86400000, T0 = Date.UTC(2026, 8, 30, 12);
const dayOf = ms => new Date(ms).toISOString().slice(0, 10);
const mk = (id, dOff, net, extra) => Object.assign({ id, coin: 'ETH', dir: 'Long', openTime: T0 + dOff * DAY - 3600e3,
  closeTime: T0 + dOff * DAY, net, maxSize: 1, avgEntry: 100, isOpen: false }, extra || {});

console.log('\nReadiness');
t('the check-in maps to 0–100: sleep and focus weigh double, stress counts as calm', () => {
  eq(ctx.pzReadiness(null), null); eq(ctx.pzReadiness({}), null);
  eq(ctx.pzReadiness({ sleep: 5, stress: 1, focus: 5 }), 100);
  eq(ctx.pzReadiness({ sleep: 1, stress: 5, focus: 1 }), 20);
  eq(ctx.pzReadiness({ sleep: 3, stress: 4, focus: 4 }), 64);
  eq(ctx.pzReadiness({ focus: 4 }), 80, 'only the answers given count');
  eq(ctx.pzReadiness({ sleep: 9, focus: 0 }), null, 'out-of-range answers are ignored');
});
t('a day score from parts uses the process weights, over the parts that apply', () => {
  eq(ctx.pzScoreOf({ plan: 1, journal: 0.5 }), Math.round(100 * (20 + 10) / 40));
  eq(ctx.pzScoreOf({}), null);
});

console.log('\nRisk used');
const today = dayOf(T0);
t('risk used is the larger share of the trade cap and the loss limit; the day’s own numbers win', () => {
  const tr = [mk('a', 0, -150), mk('b', 0, 40), mk('c', -1, -500)];
  const r = ctx.pzRisk(tr, { maxTrades: 5, maxLoss: 400 }, { maxPerDay: 2, dailyLossLimit: 1000 }, today, dayOf);
  eq(r.trades, 2); eq(r.cap, 5); eq(r.limit, 400); eq(r.loss, 110);
  eq(r.used, Math.max(2 / 5, 110 / 400));
  const r2 = ctx.pzRisk(tr, null, { maxPerDay: 2, dailyLossLimit: 0 }, today, dayOf);
  eq(r2.cap, 2); eq(r2.used, 1, 'standing rule when the day sets none');
  eq(ctx.pzRisk(tr, null, {}, today, dayOf).used, null, 'no cap and no limit: nothing to measure');
});
t('a green day uses none of the loss limit; open trades count toward the cap', () => {
  const tr = [mk('a', 0, 300), mk('o', 0, 0, { isOpen: true, closeTime: null })];
  const r = ctx.pzRisk(tr, { maxTrades: 4, maxLoss: 200 }, {}, today, dayOf);
  eq(r.loss, 0); eq(r.trades, 2); eq(r.used, 0.5);
});
t('size vs usual compares today’s entries with the recent median, once there are five', () => {
  const prior = [1, 2, 3, 4].map(i => mk('p' + i, -i, 10, { maxSize: 1 }));
  eq(ctx.pzRisk([...prior, mk('a', 0, 5, { maxSize: 2 })], null, {}, today, dayOf).sizeX, null);
  const r = ctx.pzRisk([...prior, mk('p5', -5, 10), mk('a', 0, 5, { maxSize: 2 })], null, {}, today, dayOf);
  eq(r.sizeX, 2);
});

console.log('\nTrends');
const days = [{ key: '2026-09-01', score: 90, net: 200 }, { key: '2026-09-02', score: 40, net: -100 },
  { key: '2026-09-03', score: 80, net: 100 }, { key: '2026-08-01', score: 10, net: -999 }];
const byDay = { '2026-09-01': [{ net: 200 }, { net: -80 }], '2026-09-02': [{ net: -100 }], '2026-09-03': [{ net: 100 }, { net: 10 }] };
t('process vs results splits the range at 70 and reports the average day and trade win rate', () => {
  const s = ctx.pzTrendStats(days, byDay, '2026-09-01');
  eq(s.days.length, 3); eq(s.avg, 70);
  eq(s.hi.n, 2); eq(s.hi.avgNet, 150); eq(s.hi.winRate, 2 / 3, 'break-even trades are left out');
  eq(s.lo.n, 1); eq(s.lo.avgNet, -100); eq(s.lo.winRate, 0);
});
t('readiness vs discipline needs three check-in days on each side', () => {
  const J = {}; const ds = [];
  for (let i = 0; i < 6; i++) { const k = '2026-09-1' + i; ds.push({ key: k, score: i < 3 ? 90 : 50 });
    J['day:' + k] = i < 3 ? { sleep: 5, stress: 1, focus: 5 } : { sleep: 1, stress: 5, focus: 2 }; }
  eq(ctx.pzReadinessLink(ds, J), { hi: 90, lo: 50, n: 6 });
  eq(ctx.pzReadinessLink(ds.slice(0, 5), J), null);
});
t('long ranges switch to weekly bars', () => {
  eq(ctx.pzBars(days).unit, 'Daily score');
  const many = Array.from({ length: 45 }, (_, i) => ({ key: '2026-0' + (1 + Math.floor(i / 10)) + '-1' + (i % 10), score: 50 }));
  const b = ctx.pzBars(many); eq(b.unit, 'Weekly average'); ok(b.bars.length < 45);
});

console.log('\nBonus XP card and coach line');
t('the bonus card offers what’s left today and marks what’s earned; nothing is required', () => {
  const trades = [mk('a', 0, 10), mk('b', 0, 10)];
  ctx.journal = { a: { setup: 'x' } };
  const D = { dayE: null, todayTrades: trades, risk: { trades: 2, limit: 0 }, day: { bonus: { parts: {} } } };
  ctx.pzXpCfg = () => ({ checkin: 10, plan: 15, journal: 15, stops: 10, limit: 10, review: 15 }); ctx.pzLocked = () => 0;
  const items = ctx.pzBonusItems(D);
  eq(items.map(x => x.k), ['checkin', 'plan', 'journal', 'review'], 'the end-of-day review is on offer too');
  eq(items.find(x => x.k === 'journal').partial, true); eq(items.find(x => x.k === 'journal').hint, '1 of 2 journaled');
  const D2 = { dayE: { sleep: 4, plan: 'p', plannedAt: 1 }, todayTrades: [], risk: { trades: 0, limit: 400 }, day: null };
  const i2 = ctx.pzBonusItems(D2);
  eq(i2.find(x => x.k === 'checkin').done, true); eq(i2.find(x => x.k === 'plan').done, true, 'a plan before any trade counts');
  eq(i2.find(x => x.k === 'limit').hint, '$400 today');
  ctx.journal = {};
});
t('the coach line: limit hit, then today’s slips from fills, then load and form, then findings', () => {
  const D = (over) => Object.assign({ risk: { limit: 0, loss: 0, closed: [] }, day: null, load: null, form: null, ctx: { findings: [] } }, over);
  ok(/loss limit/.test(ctx.pzCoachLine(D({ risk: { limit: 100, loss: 120, closed: [] } }))));
  ok(/fifteen minutes of a loss/.test(ctx.pzCoachLine(D({ day: { behavior: { flags: { revenge: 1 } } } }))));
  ok(/after two losses/.test(ctx.pzCoachLine(D({ day: { behavior: { flags: { afterTwo: 1, revenge: 1 } } } }))), 'tilt outranks revenge');
  ok(/2\.0× your usual/.test(ctx.pzCoachLine(D({ load: { ratio: 2 } }))));
  ok(/trails your usual/.test(ctx.pzCoachLine(D({ form: { score: 20 } }))));
  eq(ctx.pzCoachLine(D({ ctx: { findings: [{ tone: 'edge', title: 'A', action: 'B' }, { tone: 'leak', title: 'Leak', action: 'Fix it.' }] } })), 'Leak. Fix it.');
});

console.log('\nPath switch and wiring');
t('the page switches on /pulse or ?pulse before the app script runs, and repoints the manifest', () => {
  const i = html.indexOf('<script>/* Pulse view'); ok(i > 0 && i < html.indexOf("const PZ=document.body.classList.contains('pz-mode');"));
  const early = html.slice(i + 8, html.indexOf('</script>', i));
  for (const [path, search, on] of [['/pulse', '', true], ['/pulse/', '', true], ['/', '?pulse', true], ['/x/ledger.html', '?pulse=1', true],
    ['/', '', false], ['/pulsex', '', false], ['/', '?impulse=1', false]]) {
    const cls = new Set(); const attrs = {};
    const el = n => ({ setAttribute: (k, v) => { attrs[n] = v; } });
    const sb = { location: { pathname: path, search, protocol: 'https:' }, document: { body: { classList: { add: c => cls.add(c) } },
      querySelector: s => el(s), title: '' } };
    vm.runInNewContext(early, sb);
    eq(cls.has('pz-mode'), on, path + search);
    if (on) eq(attrs['link[rel="manifest"]'], '/pulse.webmanifest');
  }
});
t('Pulse forces the coach layer on and redraws only its own view', () => {
  ok(grabFn('coachOn').includes('PZ||'));
  ok(grabFn('render').includes('if(PZ){') && grabFn('render').includes('pzRender(); return;'));
  ok(grabFn('setStatus').includes('pzNote(') && grabFn('setErr').includes('pzNote('));
});
t('re-renders keep typed input and focus in the settings sheet too, and journal cards stay in date order', () => {
  const r = grabFn('pzRender'); ok(r.includes("root.querySelectorAll('input[id],textarea[id]')") && r.includes('root.contains(act)'));
  ok(grabFn('pzJournalHtml').includes('<div class="pz-jgrid">${list.map(card)'));
  ok(grabFn('pzConnect').includes('_loading&&i<240'), 'waits out a background refresh');
});
t('a trade cap set in Pulse survives a save from the full app’s day journal', () => {
  ok(grabFn('wireDayJournal').includes('maxTrades:prevE.maxTrades||null'));
  ok(grabFn('nextDayEntry').includes("'maxTrades'"));
});

console.log('\nServer');
const listen = app => new Promise(res => app.listen(0, () => res('http://127.0.0.1:' + app.address().port)));
await t('/pulse serves the app, /pulse/ redirects, and Pulse has its own manifest and icon', async () => {
  const app = server.createApp({ dataDir: mkdtempSync(join(tmpdir(), 'ledger-pulse-')), auth: '', htmlPath });
  const b = await listen(app);
  try {
    const r = await fetch(b + '/pulse'); eq(r.status, 200); ok((await r.text()).includes('id="pzView"'));
    const rd = await fetch(b + '/pulse/?x=1', { redirect: 'manual' }); eq(rd.status, 302); eq(rd.headers.get('location'), '/pulse?x=1');
    const m = await (await fetch(b + '/pulse.webmanifest')).json();
    eq(m.start_url, '/pulse'); eq(m.id, '/pulse'); eq(m.short_name, 'Pulse'); eq(m.icons[0].src, '/pulse-icon.svg');
    const ic = await fetch(b + '/pulse-icon.svg'); eq(ic.headers.get('content-type'), 'image/svg+xml');
    const sw = await (await fetch(b + '/sw.js')).text();
    ok(sw.includes("'/pulse'") && !sw.includes("mode==='navigate'"), 'only the app shell is cached — help pages never overwrite it');
  } finally { await new Promise(res => app.close(res)); }
});

t('lists longer than ten page through ten at a time, and the page is kept in range', () => {
  const c = { esc: x => String(x), pzI: () => '', PZ_PAGES: {} }; vm.createContext(c);
  vm.runInContext('var PZ_PAGES={};\n' + grabFn('pzPage'), c);
  const list = Array.from({ length: 25 }, (_, i) => i);
  let p = c.pzPage('k', list); eq([p.items.length, p.items[0], p.pages], [10, 0, 3]); ok(/1–10 of 25/.test(p.html));
  c.PZ_PAGES.k = 2; p = c.pzPage('k', list); eq(p.items, [20, 21, 22, 23, 24]); ok(/disabled aria-label="Next page"/.test(p.html));
  c.PZ_PAGES.k = 9; p = c.pzPage('k', list.slice(0, 12)); eq([p.page, p.items.length], [1, 2], 'a shorter list pulls the page back in range');
  eq(c.pzPage('s', list.slice(0, 10)).html, '', 'ten or fewer: no pager');
});
report('pulse');
