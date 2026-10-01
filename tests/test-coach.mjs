// The coach layer: plain-language findings, the confidence phrasebook, habit tracking, the
// question asked after each trade, and the server's opt-in weekly letter (with a stubbed
// Claude client — the suite stays offline). Functions are extracted from ledger.html itself.
import { readFileSync, mkdtempSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import { t, ok, eq, near, report, makeExtractor } from './harness.mjs';

const require = createRequire(import.meta.url);
const server = require('../server.js');
const html = readFileSync(new URL('../ledger.html', import.meta.url), 'utf8');
const { grabFn } = makeExtractor(html);
const grabConst = (name) => {
  const i = html.indexOf('const ' + name + '=');
  if (i < 0) throw new Error('const not found: ' + name);
  return html.slice(i, html.indexOf(';\n', i) + 1);
};

const FNS = ['_erf', '_lgamma', '_ibetaReg', '_tCdf', 'confLevel', 'confWords', 'sampleWords', 'usdPlain', 'signedPlain', 'daysPlain', 'welchP',
  'bucketPhrase', 'bucketHabit', 'habitSentence', 'habitDayResults', 'habitSummary', 'resolveHabitSpec',
  'behaviorSignals', 'buildFindings', 'tradeQuestion', 'nfPlan', 'addedToLoser', 'retPct',
  'nfPlan', 'planAdherence', 'isJournaled', 'processDays', 'nfRules', 'nfMedian'];
const CONSTS = ['HABIT_LIBRARY', 'PROCESS_W'];

const DAY = 86400000;
const ctx = { _be: 50, journal: {}, _excM: {}, settings: { rules: {} }, Date, Math, console, Object, JSON, isFinite, Set, Map };
Object.assign(ctx, {
  tzMidnight: ms => Math.floor(ms / DAY) * DAY, dayKey: ms => new Date(ms).toISOString().slice(0, 10),
  isWin: n => n > ctx._be, isLoss: n => n < -ctx._be, dcoin: x => x.symbol || x.coin, dispMarket: c => c,
  _avg: a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0,
  _std: a => { if (a.length < 2) return 0; const m = a.reduce((s, x) => s + x, 0) / a.length; return Math.sqrt(a.reduce((s, x) => s + (x - m) * (x - m), 0) / (a.length - 1)); },
  fmtUsd: (n, dp) => (n < 0 ? '-$' : '$') + Math.abs(n).toFixed(dp == null ? 2 : dp).replace(/\B(?=(\d{3})+(?!\d))/g, ','),
  fmtDur: ms => Math.round(ms / 3600e3 * 10) / 10 + 'h',
  edgeLabel: d => d, sizeBucketFn: () => t => (t.maxSize >= 10 ? 'largest 25%' : t.maxSize <= 2 ? 'smallest 25%' : 'middle'),
  bucketize: () => [], assetContribution: () => ({ worst: [], best: [], neg: 0, markets: 0 }),
});
vm.createContext(ctx);
vm.runInContext(CONSTS.map(grabConst).join('\n') + '\n' + [...new Set(FNS)].map(grabFn).join('\n')
  + '\nthis.HABIT_LIBRARY=HABIT_LIBRARY; this.PROCESS_W=PROCESS_W;', ctx);

const T0 = Date.UTC(2026, 5, 1, 9);
const mk = (id, i, net, extra) => Object.assign({ id, coin: 'BTC', dir: 'Long', openTime: T0 + i * 3 * 3600e3,
  closeTime: T0 + i * 3 * 3600e3 + 3600e3, durationMs: 3600e3, avgEntry: 100, avgExit: 100 + net / 10, maxSize: 5, net }, extra || {});
const stats = (closed) => { const net = closed.reduce((s, x) => s + x.net, 0);
  return { net, expectancy: net / closed.length, fees: 10, fund: 0, maxDD: -500, longL: 4, sharpe: null }; };

console.log('\nPhrasebook');
t('confidence words come from p-values, sample words from counts', () => {
  eq(ctx.confLevel(0.004), 'strong'); eq(ctx.confLevel(0.03), 'likely'); eq(ctx.confLevel(0.2), 'early'); eq(ctx.confLevel(null), 'early');
  eq(ctx.confWords('strong'), 'Very likely real');
  ok(ctx.sampleWords(250).includes('solid')); ok(ctx.sampleWords(5).includes('handful'));
});
t('money reads like a person wrote it', () => {
  eq(ctx.usdPlain(-3163.58), '$3,164'); eq(ctx.usdPlain(41.2), '$41.20'); eq(ctx.usdPlain(40), '$40');
  eq(ctx.signedPlain(-114.27), '−$114'); eq(ctx.daysPlain(123 * DAY), '18 weeks'); eq(ctx.daysPlain(DAY), '1 day');
});
t('welchP separates clearly different groups and not identical ones', () => {
  const a = Array.from({ length: 30 }, (_, i) => -50 + (i % 5)), b = Array.from({ length: 30 }, (_, i) => 40 + (i % 5));
  ok(ctx.welchP(a, b) < 0.001); ok(ctx.welchP(a, a.slice()) > 0.9); eq(ctx.welchP([1, 2], b), null);
});
t('bucket phrases and the habits they map to', () => {
  eq(ctx.bucketPhrase('hour', '18–24h'), 'trades closed between 18:00 and 24:00');
  eq(ctx.bucketPhrase('setup', 'fade'), 'the “fade” setup');
  eq(ctx.bucketHabit('market', 'ETH').pid, 'mkt:ETH');
  eq(ctx.bucketHabit('dow', 'Mon'), null); // not checkable on a trade as a rule
});

console.log('\nFindings');
t('tilt: trades soon after a loss become a plain-language leak with a habit attached', () => {
  // every 4th trade loses; the trade right after it is opened 10 minutes later and loses too
  const closed = [];
  for (let i = 0; i < 48; i++) {
    const afterLoss = i > 0 && (i - 1) % 4 === 0;
    closed.push(mk('t' + i, i, i % 4 === 0 ? -200 : (afterLoss ? -100 : 150), { openTime: afterLoss ? closed[i - 1].closeTime + 600e3 : T0 + i * 3 * 3600e3 }));
    closed[i].closeTime = closed[i].openTime + 3600e3;
  }
  const F = ctx.buildFindings(closed, stats(closed), {});
  const f = F.find(x => x.id === 'tilt');
  ok(f, 'tilt finding present'); eq(f.tone, 'leak');
  eq(f.title, 'You trade worse right after a loss');
  ok(/wait an hour/i.test(f.action)); eq(f.habit.tpl, 'cool-off');
  ok(!/p-value|expectancy|Sharpe/i.test(f.title + f.body + f.action), 'no jargon outside "the numbers"');
  ok(/p=/.test(f.evidence), 'the statistics live in the evidence line');
  for (let i = 1; i < F.length; i++) ok(F[i - 1].rank >= F[i].rank, 'ranked by money at stake × confidence');
});
t('a clean record says so instead of inventing problems', () => {
  const closed = Array.from({ length: 12 }, (_, i) => mk('c' + i, i * 3, 100 + i, { durationMs: 3600e3 }));
  const s = stats(closed); s.maxDD = 0;
  const F = ctx.buildFindings(closed, s, {});
  ok(F.some(f => f.id === 'clean' || f.tone === 'edge'));
  ok(!F.some(f => f.tone === 'leak'));
});
t('drawdown percentages over 100% are said in dollars', () => {
  const closed = Array.from({ length: 12 }, (_, i) => mk('d' + i, i, -60));
  const F = ctx.buildFindings(closed, stats(closed), { cdd: { pct: 2.1, dd: -2909, since: 81 } });
  const f = F.find(x => x.id === 'in-drawdown');
  eq(f.title, 'You’re $2,909 below your peak');
});

console.log('\nHabits');
const days = [
  { key: '2026-06-01', parts: { journal: 1, plan: 1 } },
  { key: '2026-06-02', parts: { journal: 0.5, plan: 1 } },
  { key: '2026-06-03', parts: { journal: 1 } },
];
const byDay = { '2026-06-01': [{ coin: 'ETH' }], '2026-06-02': [{ coin: 'BTC' }, { coin: 'BTC' }, { coin: 'BTC' }, { coin: 'BTC' }], '2026-06-03': [{ coin: 'BTC' }] };
t('process habits follow the matching process-score part; missing parts are skipped', () => {
  const r = ctx.habitDayResults({ kind: 'process', part: 'plan' }, days, byDay, null, null, {});
  eq(r.map(x => x.kept), [true, true]); // day 3 had no plan part at all
  eq(ctx.habitSummary(ctx.habitDayResults({ kind: 'process', part: 'journal' }, days, byDay, null, null, {})), { kept: 2, total: 3, rate: 2 / 3 });
});
t('avoid habits are kept on days with no matching trade; cap habits count trades', () => {
  eq(ctx.habitDayResults({ kind: 'avoid' }, days, byDay, x => x.coin === 'ETH', null, {}).map(x => x.kept), [false, true, true]);
  eq(ctx.habitDayResults({ kind: 'cap', cap: 3 }, days, byDay, null, null, {}).map(x => x.kept), [true, false, true]);
  eq(ctx.habitDayResults({ kind: 'cap', cap: 3 }, days, byDay, null, '2026-06-02', {}).length, 2, 'fromKey limits the window');
});
t('self-written habits read the day journal’s "I followed the plan"', () => {
  const J = { 'day:2026-06-01': { adherence: true }, 'day:2026-06-03': { adherence: null } };
  eq(ctx.habitDayResults({ kind: 'self' }, days, byDay, null, null, J).map(x => x.kept), [true, false, false]);
});
t('library specs resolve, finding overrides win, and sentences read naturally', () => {
  const spec = ctx.resolveHabitSpec({ tpl: 'day-cap', cap: 2, when: 'I’ve taken 2 trades today' });
  eq(spec.kind, 'cap'); eq(spec.cap, 2);
  eq(ctx.habitSentence(spec), 'When I’ve taken 2 trades today, I’m done for the day.');
  eq(ctx.resolveHabitSpec({ tpl: 'nope' }), null);
  ok(ctx.HABIT_LIBRARY.every(h => h.when && h.then && ['process', 'avoid', 'cap'].includes(h.kind)));
});
t('process score: "rules kept" only counts once rules exist', () => {
  const a = mk('p1', 0, 100);
  const on = ctx.processDays([a], {}, { dayOf: ctx.dayKey, violIds: new Set() })[0];
  const off = ctx.processDays([a], {}, { dayOf: ctx.dayKey, violIds: new Set(), rulesActive: false })[0];
  eq(on.parts.rules, 1); eq(off.parts.rules, undefined);
  eq(off.score, 0, 'an unjournaled day with no rules is not a good-process day');
});

t('a plan with only a stop still counts; entry falls back to the trade average', () => {
  eq(ctx.nfPlan({ plan: { entry: '', stop: 95, target: '' } }), { entry: null, stop: 95, target: null });
  eq(ctx.nfPlan({ plan: { entry: 100, stop: '' } }), null, 'no stop, no plan');
  const tr = mk('so', 0, 50, { avgEntry: 100, avgExit: 105 });
  const pa = ctx.planAdherence([tr], { so: { plan: { entry: '', stop: 97, at: tr.openTime + 1 } } }, {});
  eq(pa.n, 1); eq(pa.items[0].stopHonored, true); near(pa.items[0].realizedR, 50 / (3 * 5));
});

console.log('\nAfter-trade questions');
t('the question fits what happened', () => {
  const tr = mk('q', 0, 50, { avgEntry: 100, avgExit: 105 });
  ok(/through your stop/.test(ctx.tradeQuestion(tr, { plan: { entry: 100, stop: 97 } }, { maePct: 4 }).q));
  ok(/past your planned stop/.test(ctx.tradeQuestion(mk('q2', 0, -80, { avgExit: 95 }), { plan: { entry: 100, stop: 97 } }, null).q));
  ok(/at its best/.test(ctx.tradeQuestion(mk('q3', 0, 1, { avgExit: 100.02 }), {}, { mfePct: 3 }).q));
  ok(/known you were wrong/.test(ctx.tradeQuestion(mk('q4', 0, -120), {}, null).q));
  ok(/see again/.test(ctx.tradeQuestion(mk('q5', 0, 300), {}, null).q));
});

console.log('\nCoach mode switch');
t('coach mode defaults on and only an explicit false turns it off', () => {
  const coachOn = (settings, PZ) => (0, eval)('(function(settings,PZ){ return (' + grabFn('coachOn') + ')(); })')(settings, !!PZ);
  eq(coachOn({}), true); eq(coachOn({ coachMode: true }), true); eq(coachOn({ coachMode: false }), false);
  eq(coachOn({ coachMode: false }, true), true, 'the Pulse view always shows the coach and game layers');
});
t('every coaching surface checks the switch; sync and backups carry it', () => {
  for (const fn of ['renderCoach', 'habitsSectionHtml', 'processSectionHtml', 'lastWeekFocusHtml', 'loadCoachLetter', 'findingCardHtml'])
    ok(grabFn(fn).includes('coachOn()'), fn + ' ignores coach mode');
  ok(html.includes("'calWeeks','coachMode','pzTheme','pzPlugs','pzProfile','pzMarket','pzLayout','pzLessons','pzGoals'];"), 'synced settings field');
  ok(html.includes('coachMode:settings.coachMode, pzTheme'), 'in backups');
  ok(html.includes("typeof data.settings.coachMode==='boolean'"), 'restored from backups/sync');
});

console.log('\nCoach letter (server)');
t('the facts allowlist drops anything that is not an aggregate', () => {
  const f = server.sanitizeCoachFacts({ week: '2026-W39', trades: 12, net: -114.271, wallet: '0xabc', notes: 'secret',
    findings: [{ title: 'x', action: 'y', confidence: 'z', raw: [1, 2] }], lessons: ['a', 'b', 'c', 'd'], habits: 'nope' });
  eq(f.net, -114.27); eq(f.wallet, undefined); eq(f.notes, undefined);
  eq(f.findings, [{ title: 'x', action: 'y', confidence: 'z' }]); eq(f.lessons.length, 3); eq(f.habits, undefined);
  eq(server.sanitizeCoachFacts('nope'), null); eq(server.sanitizeCoachFacts({ lessons: Array(5).fill('x'.repeat(5000)) }).lessons[0].length, 200);
});
t('the request uses the default model, medium effort and the default refusal fallback', () => {
  const r = server.coachLetterRequest({ week: 'W' });
  eq(r.model, 'claude-opus-5-5'); eq(r.output_config, { effort: 'medium' });
  eq(r.fallbacks, 'default'); eq(r.betas, ['server-side-fallback-2026-07-01']);
  ok(!('thinking' in r), 'thinking left to the model default (adaptive)');
  ok(r.system.includes('never invent') || r.system.includes('Use only numbers present'));
});
t('refusals and empty answers become errors, text blocks are joined', () => {
  eq(server.coachLetterText({ stop_reason: 'refusal', content: [] }).error, 'the model declined to write this letter');
  eq(server.coachLetterText({ stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }] }).error, 'the model returned no text');
  eq(server.coachLetterText({ stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text: ' Dear trader. ' }] }).text, 'Dear trader.');
});

const listen = app => new Promise(res => app.listen(0, () => res('http://127.0.0.1:' + app.address().port)));
const H = { Authorization: 'Bearer secret', 'Content-Type': 'application/json' };
await t('POST writes the letter through the client, stores it, GET returns it; off means 404', async () => {
  const seen = [];
  const stub = { beta: { messages: { create: async (req) => { seen.push(req); return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'A steady week.' }] }; } } } };
  const dataDir = mkdtempSync(join(tmpdir(), 'ledger-coach-'));
  const app = server.createApp({ dataDir, auth: 'secret', htmlPath: new URL('../ledger.html', import.meta.url).pathname, coach: { enabled: true, client: stub } });
  const b = await listen(app);
  try {
    eq((await fetch(b + '/api/coach/status')).status, 401, 'needs the token');
    eq(await (await fetch(b + '/api/coach/status', { headers: H })).json(), { enabled: true, model: 'claude-opus-5-5', share: false });
    eq((await fetch(b + '/api/coach/letter/2026-W39', { headers: H })).status, 404);
    const r = await fetch(b + '/api/coach/letter/2026-W39', { method: 'POST', headers: H, body: JSON.stringify({ facts: { trades: 3, net: 10, wallet: '0xabc' } }) });
    eq(r.status, 200); eq((await r.json()).text, 'A steady week.');
    ok(!seen[0].messages[0].content.includes('0xabc'), 'non-allowlisted fields never reach the model');
    ok(seen[0].messages[0].content.includes('2026-W39'), 'week pinned from the URL');
    ok(existsSync(join(dataDir, 'reports', 'letter-2026-W39.json')));
    eq((await (await fetch(b + '/api/coach/letter/2026-W39', { headers: H })).json()).text, 'A steady week.');
    eq((await fetch(b + '/api/coach/letter/2026-W39', { method: 'POST', headers: H, body: '{"facts":"x"}' })).status, 400);
  } finally { await new Promise(res => app.close(res)); }
  const off = server.createApp({ dataDir: mkdtempSync(join(tmpdir(), 'ledger-coach-')), auth: 'secret', htmlPath: new URL('../ledger.html', import.meta.url).pathname, coach: { enabled: false } });
  const b2 = await listen(off);
  try {
    eq((await fetch(b2 + '/api/coach/letter/2026-W39', { method: 'POST', headers: H, body: '{"facts":{}}' })).status, 404);
    eq((await (await fetch(b2 + '/api/coach/status', { headers: H })).json()).enabled, false);
  } finally { await new Promise(res => off.close(res)); }
});
await t('a failing Claude call surfaces as a readable error, not a crash', async () => {
  const stub = { beta: { messages: { create: async () => { throw new Error('socket hang up'); } } } };
  const app = server.createApp({ dataDir: mkdtempSync(join(tmpdir(), 'ledger-coach-')), auth: 'secret', htmlPath: new URL('../ledger.html', import.meta.url).pathname, coach: { enabled: true, client: stub } });
  const b = await listen(app);
  try {
    const r = await fetch(b + '/api/coach/letter/2026-W40', { method: 'POST', headers: H, body: '{"facts":{"trades":1}}' });
    eq(r.status, 502); ok(/unreachable: socket hang up/.test((await r.json()).error));
  } finally { await new Promise(res => app.close(res)); }
});

report('coach');
