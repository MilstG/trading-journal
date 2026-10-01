// Ledger companion server — zero dependencies.
//
// The app stays client-only in spirit: all reconstruction, mining, and analytics still run
// in the browser exactly as before. On top of the original persistence duties this server
// now also exposes a READ-ONLY analytics API (/api/v1) whose engine is the app itself:
// the pure functions (reconstructTrades, computeStats, projectForward, …) are extracted
// from the served ledger.html at boot and evaluated in a node:vm context — the same
// single-source-of-truth trick the test harness uses. No logic is reimplemented; if the
// app's math changes, the API's math changes with it on the next deploy.
//
// Railway notes:
//   - Railway's filesystem is EPHEMERAL across deploys. Attach a Volume (mount path
//     /data) or journal entries WILL vanish on every redeploy. The server prefers
//     /data automatically when it exists; override with DATA_DIR.
//   - Set AUTH_TOKEN in the service variables. Without it the API is open to anyone
//     who finds the URL — your journal and wallet addresses are sensitive.
//   - Optionally set READ_TOKEN to mint a second, weaker credential: it can GET
//     /api/v1/* (analytics) and nothing else — it can never read or write /api/data,
//     trigger refreshes, or touch attachments. Safe to hand to scripts/friends.
//   - Optionally set CORS_ORIGIN (exact origin, e.g. https://tools.example.com) to let
//     a browser app on another origin consume /api/*. Off by default.
//   - Railway injects PORT; nothing to configure.
//
// Persistence API (unchanged):
//   GET  /api/health         -> {ok:true, auth:<bool>, appSyncCapable} (no auth)
//   GET  /api/data           -> {rev, snapshot|null}                   (AUTH_TOKEN)
//   PUT  /api/data {rev,snapshot} -> {rev:new}                         (AUTH_TOKEN)
//        stale rev -> 409 {rev, snapshot}
//   GET  /api/snapshots , GET /api/snapshots/YYYY-MM-DD               (AUTH_TOKEN)
//   GET/PUT/DELETE /api/att/<key>                                     (AUTH_TOKEN)
//   POST /api/backup , GET /api/backups , GET /api/backups/<name>     (AUTH_TOKEN)
//        server-held copies of the app's "Backup all" JSON (gzipped, newest 10 kept)
//   GET  /help , GET /docs  -> built-in user guide / technical reference (no auth)
//
// Analytics API v1 (read-only; GET = AUTH_TOKEN or READ_TOKEN, POST = AUTH_TOKEN):
//   GET  /api/v1                       self-describing endpoint index (no auth — docs only)
//   POST /api/v1/refresh               fetch fills/funding/positions from Hyperliquid into
//                                      server-side caches and rebuild trades
//                                      body {wallets?:[addr], full?:bool, force?:bool}
//   GET  /api/v1/meta                  freshness, wallet cache state, engine status
//   GET  /api/v1/trades                filterable/sortable/paginated trade list
//   GET  /api/v1/trades/:id            one trade incl. fill events + journal entry
//   GET  /api/v1/stats                 computeStats over the filtered set
//   GET  /api/v1/equity                cumulative equity points + drawdown diagnostics
//   GET  /api/v1/calendar              net PnL per calendar day
//   GET  /api/v1/breakdown?by=…&basis=usd|pct&top=N   grouped stats + contribution shares
//   GET  /api/v1/projection            Monte Carlo forward simulation (projectForward)
//   GET  /api/v1/kelly                 Kelly sizing from the filtered closed set
//   GET  /api/v1/risk                  open-position risk model (openRiskModel)
//   GET  /api/v1/positions             cached positions/spot/account snapshot (?live=1 refetches; AUTH_TOKEN)
//   GET  /api/v1/spot/lots             FIFO 8949-style spot cost-basis lots
//   GET  /api/v1/whatif                counterfactual replay: remove trades matching a rule
//   GET  /api/v1/journal , /api/v1/journal/:id , /api/v1/tags   (read-only journal views)
//   GET  /api/v1/export/trades.csv     flat CSV of the filtered trades
//
//   Common filters (trades/stats/equity/calendar/breakdown/projection/kelly/whatif/export):
//     market=perp|spot|combined  wallet=0x…  coin=SYM  dir=Long|Short|Spot
//     status=open|closed|all  outcome=win|loss|be  tag=NAME  q=notes-substring
//     from=<ms|ISO>  to=<ms|ISO>  tz=utc|local   (tz default: saved setting, else utc;
//     note "local" here is the SERVER's timezone — prefer utc for API consumers)
//
// Writes are atomic (tmp + rename) and the previous version is kept as .bak.

'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const vm = require('vm');
const { createSocial } = require('./social.js');

const MAX_BODY = 25 * 1024 * 1024; // journal snapshots are small; this is generous headroom

function timingSafeEq(a, b) {
  const A = Buffer.from(String(a)), B = Buffer.from(String(b));
  if (A.length !== B.length) return false;
  return crypto.timingSafeEqual(A, B);
}

/* ============================ analytics engine ============================ */
// Extracted verbatim from ledger.html. Every name here must exist in the served HTML;
// anything missing disables the engine (v1 analytics 503) but never the persistence API.
const ENGINE_FNS = [
  // time layer + reconstruction
  'tzParts', 'tzMidnight', 'addDays', 'isPerp', 'newTrade', 'tallyFill',
  'reconstructTrades', 'attributeFunding', 'hip3DexsFromFills', 'mapClearinghouse',
  'spotMapsFrom', 'spotFifoLots',
  // stats
  'dailyPnl', 'dailySeriesCalendar', 'sharpeStats', 'sortinoAnnual', 'retPct',
  'riskFor', 'rFor', 'avgLossOf', 'computeOneR', 'computeStats',
  // projection / risk / counterfactuals
  '_srand', '_hashSeed', 'bootstrapMeanCI', 'mcMaxDD', 'projBaseline', 'projectForward',
  'projMilestones', 'currentDD', 'underwaterStats', 'fwdMaxDD', 'kellyFromTrades',
  'openRiskModel', 'whatIfStats', 'whatIfModel', 'walkForward', 'riskConcentration',
  'cusumDrift', 'decayAssess',
  // capital flows -> return on capital
  'fetchLedgerUpdates', 'capitalFlows', 'capitalModel', 'xirrFromFlows',
  // goals (Telegram /goals + future endpoints)
  'monthlyGoalModel',
  // the end-of-day nudge counts unjournaled trades with the app's own definition
  'isJournaled',
  // Pulse's Discipline score, recomputed from a member's public fills to verify the social boards
  'nfMedian', 'addedToLoser', 'pzBehaviorDays',
  // Hyperliquid client (retry/backoff/pagination identical to the browser's)
  'hlPost', 'fetchAllFills', 'fetchFunding', 'fetchSpotMaps', 'fetchSpotState', 'fetchPortfolio',
];
// Trivial one-line consts the extracted functions lean on. Consts aren't brace-extractable,
// so — exactly like the test suites — they are re-declared here. Keep in sync with ledger.html.
const ENGINE_SHIMS = `
const _avg=a=>a.length?a.reduce((x,y)=>x+y,0)/a.length:0;
const _std=a=>{ if(a.length<2)return 0; const m=_avg(a); return Math.sqrt(a.reduce((s,x)=>s+(x-m)*(x-m),0)/(a.length-1)); };
const dayKey=ms=>{ const p=tzParts(ms); return p.y+'-'+String(p.mo+1).padStart(2,'0')+'-'+String(p.day).padStart(2,'0'); };
const tzHour=ms=>tzParts(ms).h;
const tzDow=ms=>tzParts(ms).dow;
const isWin =n=>n>_be;
const isLoss=n=>n<-_be;
const isBE  =n=>Math.abs(n)<=_be;
`;

function grabBlock(html, header) {
  const i = html.indexOf(header);
  if (i < 0) return null;
  let d = 0;
  for (let p = html.indexOf('{', i); p < html.length; p++) {
    if (html[p] === '{') d++;
    if (html[p] === '}') { d--; if (!d) return html.slice(i, p + 1); }
  }
  return null;
}
function grabFn(html, name) {
  return grabBlock(html, 'async function ' + name + '(')
      || grabBlock(html, 'function ' + name + '(');
}

// Builds an isolated context holding the app's pure functions. Mutable knobs the app keeps
// as globals (settings, journal, _be, _oneR, _rng) live as context properties so the server
// can set them per request; all per-request compute is synchronous, so this is race-free.
// CAREFUL: doRefresh awaits network between E.* calls while GETs may run — that stays safe
// only because the refresh path (hlPost/fetch*/mapClearinghouse/hip3DexsFromFills) never
// reads those mutable knobs. Don't add settings/_be/_oneR dependence to fetch-path functions.
function buildEngine(htmlPath, fetchImpl) {
  let html;
  try { html = fs.readFileSync(htmlPath, 'utf8'); }
  catch (e) { return { ok: false, missing: ['<ledger.html unreadable: ' + e.message + '>'] }; }
  const missing = [], blocks = [];
  for (const n of ENGINE_FNS) {
    const b = grabFn(html, n);
    if (b) blocks.push(b); else missing.push(n);
  }
  if (missing.length) return { ok: false, missing };
  const ctx = {
    console,
    fetch: fetchImpl,
    setTimeout, clearTimeout,
    API: 'https://api.hyperliquid.xyz/info',
    sleep: (ms) => new Promise(r => setTimeout(r, ms)),
    setStatus: () => {},              // browser status bar — no-op on the server
    _rng: Math.random,                // reassigned by _srand for seeded runs
    _be: 50, _oneR: null,             // break-even band + 1R basis, set per request
    settings: { tz: 'utc' }, journal: {},
  };
  vm.createContext(ctx);
  try {
    vm.runInContext(blocks.join('\n') + '\n' + ENGINE_SHIMS, ctx, { filename: 'ledger-engine.js' });
  } catch (e) {
    return { ok: false, missing: ['<engine eval failed: ' + e.message + '>'] };
  }
  for (const n of ENGINE_FNS) if (typeof ctx[n] !== 'function')
    return { ok: false, missing: ['<' + n + ' did not evaluate to a function>'] };
  return { ok: true, missing: [], ctx };
}

/* ============================ small helpers ============================ */
const gzWrite = (file, obj) => {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, zlib.gzipSync(JSON.stringify(obj)));
  fs.renameSync(tmp, file);
};
const gzRead = (file) => {
  try { return JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8')); }
  catch (e) { return null; }
};
const ADDR_RE = /^0x[0-9a-fA-F]{40}$/;
const fillId = f => f.tid + '-' + f.oid + '-' + f.time;
const parseTime = (v) => {
  if (v == null || v === '') return null;
  // 9–10 digits is a Unix time in SECONDS (what most scripts send); longer is milliseconds
  if (/^\d{9,10}$/.test(v)) return parseInt(v, 10) * 1000;
  if (/^\d+$/.test(v)) return parseInt(v, 10);
  const t = Date.parse(v);
  return isNaN(t) ? null : t;
};
const qnum = (v, dflt) => { const n = parseFloat(v); return isFinite(n) ? n : dflt; };
const csvCell = (v) => {
  if (v == null) return '';
  let s = String(v);
  // Formula-injection guard: journal notes/tags flow into this CSV and open in Excel or
  // Sheets, where a leading = @ (or a +/- that isn't a number) executes as a formula.
  // Checked on the whitespace-trimmed value — some importers trim before formula
  // detection, so " =HYPERLINK(…)" was a bypass. Real negative numbers pass untouched.
  const t0 = s.replace(/^[\s]+/, '');
  if (/^[=@]/.test(t0) || (/^[+-]/.test(t0) && !isFinite(Number(t0)))) s = "'" + s;
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

/* ---------------- alerts: pure derivation + webhook delivery ---------------- */
// Derive alert lines from a plain state snapshot. Pure and exported so thresholds are
// testable without a server, caches, or network. Keys dedupe repeats: liq alerts key per
// position, day-scoped alerts re-arm next day, the drawdown alert re-arms after cooldown.
function alertsFrom(state, cfg) {
  const out = [];
  const money = (n) => '$' + Math.abs(Math.round(n)).toLocaleString('en-US');
  if (cfg.liqPct > 0) for (const r of (state.risk || [])) {
    if (r.liqDist != null && r.liqDist * 100 <= cfg.liqPct)
      out.push({ key: 'liq:' + r.coin + ':' + ((r.wallet && r.wallet.address) || ''),
        text: '⚠ ' + r.coin + ' ' + r.side + ' is ' + (r.liqDist * 100).toFixed(1) + '% from liquidation (notional ' + money(r.notional) + ')' });
  }
  if (cfg.dailyLoss > 0 && state.todayNet <= -cfg.dailyLoss)
    out.push({ key: 'dailyloss:' + state.todayKey,
      text: '⛔ Daily loss limit: down ' + money(state.todayNet) + ' today (limit ' + money(cfg.dailyLoss) + '). Step away.' });
  if (cfg.funding24h > 0 && state.funding24h <= -cfg.funding24h)
    out.push({ key: 'funding:' + state.todayKey,
      text: '💸 Funding bleed: ' + money(state.funding24h) + ' paid in the last 24h (threshold ' + money(cfg.funding24h) + ')' });
  if (state.currentDD != null && state.ddP95 != null && -state.currentDD > state.ddP95)
    out.push({ key: 'dd',
      text: '📉 Drawdown ' + money(state.currentDD) + ' exceeds the 95th-percentile expectation (' + money(state.ddP95) + ') for your own shuffled return stream — statistically unusual for your strategy, not routine variance.' });
  return out;
}
// Pure command router for the Telegram bot: (command, state) -> reply text. state is the
// plain-data snapshot buildBotState assembles; exported so the reply wording and threshold
// logic are testable without a bot, network, or engine.
function telegramReply(cmd, st) {
  const money = n => (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-US');
  const pct = x => x == null ? '—' : Math.round(x * 100) + '%';
  if (!st || st.engineOk === false) return 'Analytics engine unavailable on the server — persistence still works.';
  switch (cmd) {
    case '/today': {
      let t = 'Today: ' + money(st.todayNet || 0) + ' across ' + (st.todayN || 0) + ' trade' + ((st.todayN || 0) === 1 ? '' : 's') + '.';
      if (st.tripLimit > 0) t += (st.todayNet <= -st.tripLimit
        ? ' ⛔ Past your ' + money(st.tripLimit) + ' daily limit — step away.'
        : ' Daily limit: ' + money(st.tripLimit) + '.');
      return t;
    }
    case '/risk': {
      if (!st.risk) return 'No position snapshot yet — refresh first (or wait for the schedule).';
      let t = st.risk.positions + ' position(s) · gross ' + money(st.risk.gross) + ' · net '
        + (st.risk.skew >= 0 ? 'long ' : 'short ') + money(Math.abs(st.risk.skew));
      if (st.accountValue != null) t += ' · account ' + money(st.accountValue);
      if (st.risk.dangers && st.risk.dangers.length)
        t += '\n⚠ near liquidation: ' + st.risk.dangers.map(d => d.coin + ' ' + d.side
          + (d.liqDistPct != null ? ' (' + d.liqDistPct.toFixed(1) + '% away)' : '')).join(', ');
      else t += '\nNo positions within 10% of liquidation.';
      return t;
    }
    case '/stats': {
      if (!st.stats30) return 'No closed trades in the last 30 days.';
      const s = st.stats30;
      return 'Last 30d: ' + s.n + ' trades · net ' + money(s.net) + ' · win rate ' + pct(s.winRate)
        + ' · expectancy ' + money(s.expectancy) + '/trade'
        + (s.profitFactor != null ? ' · PF ' + s.profitFactor.toFixed(2) : '') + ' · fees ' + money(s.fees);
    }
    case '/goals': {
      if (!st.goals) return 'No monthly goals set (Review tab → Monthly goals).';
      const g = st.goals;
      let t = 'Month: ' + money(g.net) + (g.target != null ? ' / ' + money(g.target) + ' target' : '') + ' over ' + g.n + ' trades.';
      if (g.projected != null) t += ' Projected month-end: ' + money(g.projected) + '.';
      if (g.maxDD != null) t += ' Intramonth DD ' + money(g.intraDD) + ' vs cap ' + money(-g.maxDD) + '.';
      if (g.maxTradesWeek != null) t += ' ' + g.tradesPerWeek.toFixed(1) + ' trades/wk vs cap ' + g.maxTradesWeek + '.';
      return t;
    }
    case '/digest': return st.digest || 'No weekly digest stored yet.';
    default:
      return 'Ledger bot — read-only.\n/today — realized PnL today + limit\n/risk — open book + liquidation distances\n/stats — last 30 days\n/goals — month vs plan\n/digest — latest weekly digest';
  }
}
/* ---------------- end-of-day journaling nudge (pure parts) ---------------- */
// Calendar day + hour of `ms` in an IANA time zone — the nudge fires by the trader's clock,
// and the day key must match the app's 'day:YYYY-MM-DD' journal entries.
const _zoneFmt = new Map(); // building an Intl.DateTimeFormat is costly; one per zone is plenty
function zonedDayHour(ms, tz) {
  tz = tz || 'UTC';
  let f = _zoneFmt.get(tz);
  if (!f) { f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', hourCycle: 'h23' }); _zoneFmt.set(tz, f); }
  const parts = {};
  for (const p of f.formatToParts(new Date(ms))) parts[p.type] = p.value;
  return { day: parts.year + '-' + parts.month + '-' + parts.day, hour: parseInt(parts.hour, 10) % 24 };
}
// (state, cfg) -> {key, text} | null. Fires once per day, at or after cfg.hour, only when
// something is actually missing: trades closed today with nothing journaled, or no review.
function nudgeFrom(st, cfg) {
  if (!cfg || !Number.isInteger(cfg.hour) || cfg.hour < 0 || cfg.hour > 23 || !st || st.hour < cfg.hour || !st.tradesToday) return null;
  const missing = [];
  if (st.unjournaled) missing.push(st.unjournaled + ' of ' + st.tradesToday + ' trade' + (st.tradesToday === 1 ? '' : 's') + ' not journaled');
  if (!st.hasReview) missing.push('no end-of-day review yet');
  if (!missing.length) return null;
  return { key: 'nudge:' + st.dayKey,
    text: '📝 End of day: ' + missing.join(', ') + '. Five minutes now — a setup, a rating, one line of review — is what the pattern miner and your process score run on.' };
}
/* ---------------- coach's weekly letter (optional AI, opt-in) ---------------- */
// COACH_AI=1 lets the Review tab ask Claude for a short plain-language weekly letter. Only an
// aggregate summary the app builds and shows the user first is ever sent (counts, averages,
// habit sentences, finding headlines, their own one-line lessons) — never fills, wallet
// addresses, trade notes or screenshots. sanitizeCoachFacts is the allowlist that enforces it.
const COACH_SYSTEM = [
  'You are a calm, experienced trading coach writing a short weekly letter to one trader.',
  'You get a JSON summary of their week built by their journal app: results, a process score',
  '(0-100, how well they followed their own process, independent of profit), their habits and',
  'how often they kept them, findings from their own statistics, their wins, and lessons they wrote.',
  '',
  'Write 150-220 words in plain, warm, direct language, second person. No jargon: never say',
  'p-value, expectancy, Sharpe, drawdown percentile or similar; say what it means instead.',
  'Structure: one or two sentences on how the week went, putting process before profit; what went',
  'well; the one thing to work on next week, tied to their focus habit when they have one; one',
  'sentence of encouragement. Use only numbers present in the summary and never invent any.',
  'Do not predict markets or suggest specific trades, entries, coins or position sizes.',
  'Plain text only: no headings, no bullet lists, no markdown.',
].join('\n');
function sanitizeCoachFacts(f) {
  if (!f || typeof f !== 'object' || Array.isArray(f)) return null;
  const str = (v, n) => (typeof v === 'string' ? v.slice(0, n || 200) : undefined);
  const num = v => (typeof v === 'number' && isFinite(v) ? Math.round(v * 100) / 100 : undefined);
  const arr = (v, n, fn) => (Array.isArray(v) ? v.slice(0, n).map(fn).filter(x => x != null) : undefined);
  const habit = h => (h && typeof h === 'object' ? { habit: str(h.habit, 200), kept: num(h.kept), total: num(h.total) } : null);
  const out = {
    week: str(f.week, 20), trades: num(f.trades), net: num(f.net), winRate: num(f.winRate),
    prevWeek: f.prevWeek && typeof f.prevWeek === 'object' ? { trades: num(f.prevWeek.trades), net: num(f.prevWeek.net) } : undefined,
    process: f.process && typeof f.process === 'object' ? { thisWeek: num(f.process.thisWeek), last20: num(f.process.last20), prev20: num(f.process.prev20),
      goodDays: num(f.process.goodDays), days: num(f.process.days), weakestPart: str(f.process.weakestPart, 80) } : undefined,
    quadrants60: f.quadrants60 && typeof f.quadrants60 === 'object' ? { goodGreen: num(f.quadrants60.goodGreen), goodRed: num(f.quadrants60.goodRed),
      poorGreen: num(f.quadrants60.poorGreen), poorRed: num(f.quadrants60.poorRed) } : undefined,
    focus: habit(f.focus) || undefined,
    challenge: habit(f.challenge) || undefined,
    level: str(f.level, 40), streak: num(f.streak),
    habits: arr(f.habits, 8, habit),
    journaled: f.journaled && typeof f.journaled === 'object' ? { n: num(f.journaled.n), of: num(f.journaled.of) } : undefined,
    findings: arr(f.findings, 5, x => (x && typeof x === 'object' ? { title: str(x.title, 160), action: str(x.action, 220), confidence: str(x.confidence, 60) } : null)),
    wins: arr(f.wins, 5, x => str(x, 160)),
    lessons: arr(f.lessons, 3, x => str(x, 200)),
  };
  if (JSON.stringify(out).length > 12000) return null;
  return out;
}
/* ---------------- AI coach chat (Pulse): opt-in, per-member daily allowance ---------------- */
// The app sends a summary it built from the member's own journal (scores, stats, slips, plan vs
// execution, habits, today's routine) and, only if the member switched it on, their recent trades
// and notes. Wallet addresses are scrubbed from both. Nothing is stored on the server.
const COACH_CHAT_SYSTEM = [
  'You are the coach inside Pulse, a trading journal. You talk with one trader about their own trading,',
  'using the data their journal app attached (JSON). Their process scores are explained below; profit is',
  'never part of a process score.',
  '',
  'How you coach: calm, warm, direct, second person. Put process before profit. Prefer one concrete next',
  'step over a list. Praise specific good behaviour you can see in the data. When something went wrong,',
  'name the pattern without judgement and tie it to their own numbers and their current focus habit or',
  'leak. Use only numbers present in the data; never invent figures. If the data cannot answer, say so',
  'and say what they could log to find out.',
  '',
  'Never give trade signals, price predictions, entries, targets, coin picks or position sizes for',
  'future trades, and never tell them to trade more. You may discuss past trades and their own rules.',
  'If they seem to be in distress or chasing losses, suggest stepping away first.',
  '',
  'Keep answers short: usually 60-180 words, plain text, at most a few short lines or a short list.',
  'No headings. When asked for an end-of-day review: what went well, the one thing to fix, and one',
  'focus for tomorrow. When asked to plan the day: their limits, their focus habit, and one if-then rule.',
  '',
  'Scores, for reference: Discipline 0-100 = share of the day\'s closed trades without any of six slips',
  '(revenge entry within 15 min of a loss, trading on after two losses in a row, sizing up after a loss,',
  'adding to a loser, overtrading past 1.5x their usual day, holding a loser over 3x their usual winner).',
  'Form: 50 = their usual recent results. Load: 50 = their usual day\'s activity. Readiness: from their',
  'morning check-in (sleep, calm, focus).',
].join('\n');
// Deep-copies an attached JSON summary within limits, scrubbing wallet addresses.
function scrubCoachData(v, depth) {
  if (depth > 6) return undefined;
  if (typeof v === 'string') return v.replace(/0x[0-9a-fA-F]{40}/g, '[wallet]').slice(0, 1200);
  if (typeof v === 'number') return isFinite(v) ? Math.round(v * 1000) / 1000 : undefined;
  if (typeof v === 'boolean' || v === null) return v;
  if (Array.isArray(v)) return v.slice(0, 120).map(x => scrubCoachData(x, depth + 1));
  if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v).slice(0, 80)) { if (/^(address|wallet|addr)$/i.test(k)) continue; o[k.slice(0, 40)] = scrubCoachData(v[k], depth + 1); } return o; }
  return undefined;
}
// -> {messages, facts, detail} or {error}
function sanitizeCoachChat(b, detailAllowed) {
  if (!b || typeof b !== 'object') return { error: 'invalid body' };
  let msgs = (Array.isArray(b.messages) ? b.messages : []).filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .map(m => ({ role: m.role, content: m.content.slice(0, 4000) })).slice(-16);
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();
  if (!msgs.length || msgs[msgs.length - 1].role !== 'user') return { error: 'expected a conversation ending with your message' };
  const facts = JSON.stringify(scrubCoachData(b.facts && typeof b.facts === 'object' ? b.facts : {}, 0));
  if (facts.length > 40000) return { error: 'the attached summary is too large' };
  let detail = null;
  if (detailAllowed && b.detail && typeof b.detail === 'object') { detail = JSON.stringify(scrubCoachData(b.detail, 0)); if (detail.length > 60000) detail = detail.slice(0, 60000); }
  return { messages: msgs, facts, detail };
}
function coachChatRequest(chat, model) {
  const m = model || 'claude-opus-5-5';
  const req = {
    model: m,
    max_tokens: 2000, // answers are a short paragraph or two
    system: [
      { type: 'text', text: COACH_CHAT_SYSTEM, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'Trader data from their journal app (JSON):\n' + chat.facts
        + (chat.detail ? '\n\nTheir recent trades and journal notes (they chose to share these):\n' + chat.detail : '') },
    ],
    messages: chat.messages,
  };
  if (!/haiku|claude-3|sonnet-4-[05]|opus-4-[015]\b|opus-4-0|sonnet-4-5/.test(m)) req.output_config = { effort: 'low' }; // conversational: quick answers
  if (/^claude-(opus-5|fable-5|mythos-5|sonnet-5-5)/.test(m)) { req.betas = ['server-side-fallback-2026-07-01']; req.fallbacks = 'default'; }
  return req;
}
// Options are gated by model, so COACH_AI_MODEL can point anywhere: effort is rejected by
// Haiku 4.5 and older Sonnet/Opus generations, and server-side fallbacks exist only for the
// Claude 5-generation models (on a safety decline they retry on Anthropic's recommended model).
function coachLetterRequest(facts, model) {
  const m = model || 'claude-opus-5-5';
  const req = {
    model: m,
    max_tokens: 16000,
    system: COACH_SYSTEM,
    messages: [{ role: 'user', content: 'This week\'s summary from my journal:\n\n' + JSON.stringify(facts, null, 1) }],
  };
  if (!/haiku|claude-3|sonnet-4-[05]|opus-4-[015]\b|opus-4-0|sonnet-4-5/.test(m)) req.output_config = { effort: 'medium' };
  if (/^claude-(opus-5|fable-5|mythos-5|sonnet-5-5)/.test(m)) { req.betas = ['server-side-fallback-2026-07-01']; req.fallbacks = 'default'; }
  return req;
}
// -> {text} or {error}. Refusals and empty answers become a readable error, never a blank letter.
function coachLetterText(msg) {
  if (!msg) return { error: 'no response' };
  if (msg.stop_reason === 'refusal') return { error: 'the model declined to write this letter' };
  const text = (msg.content || []).filter(b => b && b.type === 'text').map(b => b.text).join('\n').trim();
  return text ? { text } : { error: 'the model returned no text' };
}
// Best-effort webhook post; shapes the body for the common receivers.
async function postWebhook(url, text) {
  let body, headers = { 'Content-Type': 'application/json' };
  if (/discord\.com|discordapp\.com/.test(url)) body = JSON.stringify({ content: text });
  else if (/hooks\.slack\.com/.test(url)) body = JSON.stringify({ text });
  else if (/ntfy\.sh/.test(url)) { body = text; headers = { 'Content-Type': 'text/plain' }; }
  else body = JSON.stringify({ text });
  // a receiver that accepts the connection and never answers must not stall alerts, nudges
  // and the digest behind it: every outbound call gets a deadline
  const res = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error('webhook HTTP ' + res.status);
}

function createApp(opts) {
  opts = opts || {};
  const dataDir = opts.dataDir
    || process.env.DATA_DIR
    || (fs.existsSync('/data') ? '/data' : path.join(__dirname, 'data'));
  const auth = opts.auth !== undefined ? opts.auth : (process.env.AUTH_TOKEN || '');
  const readAuth = opts.readAuth !== undefined ? opts.readAuth : (process.env.READ_TOKEN || '');
  const corsOrigin = opts.corsOrigin !== undefined ? opts.corsOrigin : (process.env.CORS_ORIGIN || '');
  const htmlPath = opts.htmlPath
    || [path.join(__dirname, 'ledger.html'), path.join(__dirname, 'index.html')]
       .find(p => fs.existsSync(p))
    || path.join(__dirname, 'ledger.html');
  const dataFile = path.join(dataDir, 'ledger-data.json');
  const attDir = path.join(dataDir, 'att');
  const fillsDir = path.join(dataDir, 'fills');
  const fundingDir = path.join(dataDir, 'funding');
  const ledgerDir = path.join(dataDir, 'ledger');
  const marketFile = path.join(dataDir, 'market.json');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(attDir, { recursive: true });
  fs.mkdirSync(fillsDir, { recursive: true });
  fs.mkdirSync(fundingDir, { recursive: true });
  fs.mkdirSync(ledgerDir, { recursive: true });
  const reportsDir = path.join(dataDir, 'reports');
  fs.mkdirSync(reportsDir, { recursive: true });
  const backupsDir = path.join(dataDir, 'backups');
  fs.mkdirSync(backupsDir, { recursive: true });
  const BACKUP_RE = /^backup-[A-Za-z0-9-]+\.json\.gz$/;
  const BACKUP_KEEP = 10;
  const ATT_KEY = /^[A-Za-z0-9_-]{1,200}$/;   // base64url of the trade id
  const MAX_ATT = 8 * 1024 * 1024;            // per-trade attachment set
  const MAX_ATT_TOTAL = 512 * 1024 * 1024;    // whole store — Railway volumes are small, and per-key caps alone allow unbounded growth
  const attDirSize = () => {
    try { let s = 0; for (const f of fs.readdirSync(attDir)) s += fs.statSync(path.join(attDir, f)).size; return s; }
    catch (e) { return 0; }
  };

  // Guard against the easy mistake of deploying server.js next to an older ledger.html:
  // the API would work while the app silently ran browser-only (no token prompt, no sync).
  // Detected once at boot, surfaced in the logs and on /api/health.
  let appSyncCapable = false;
  try { appSyncCapable = fs.readFileSync(htmlPath, 'utf8').includes('initServerSync'); } catch (e) {}

  // Analytics engine — extracted from the same HTML this server serves.
  const engine = buildEngine(htmlPath, opts.fetchImpl || ((...a) => globalThis.fetch(...a)));
  const E = engine.ctx; // undefined when !engine.ok — every v1 route checks first

  // mtime-cached: cacheSig, setEngineState and ensureTrades each read the snapshot, which
  // used to mean 2-3 full JSON parses of the whole data blob per request
  let _dataCache = { mtime: 0, data: null };
  const readData = () => {
    try {
      const st = fs.statSync(dataFile);
      if (_dataCache.data && _dataCache.mtime === st.mtimeMs) return _dataCache.data;
      const d = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
      _dataCache = { mtime: st.mtimeMs, data: d };
      return d;
    } catch (e) { return null; }
  };
  const writeData = (obj) => {
    _dataCache.mtime = 0; // invalidate — the rename below may land within the same ms
    const tmp = dataFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj));
    try { if (fs.existsSync(dataFile)) fs.copyFileSync(dataFile, dataFile + '.bak'); } catch (e) {}
    fs.renameSync(tmp, dataFile);
    snapshotDaily(obj);
  };
  // Rotating daily snapshots: one file per calendar day (UTC), overwritten within the day,
  // pruned to the newest SNAP_KEEP. One bad sync or fat-fingered wipe is otherwise a single
  // .bak away from permanent. Snapshot failures never fail the write itself.
  const snapDir = path.join(dataDir, 'snapshots');
  const SNAP_KEEP = 14;
  const SNAP_RE = /^(\d{4}-\d{2}-\d{2})\.json$/;
  const snapshotDaily = (obj) => {
    try {
      fs.mkdirSync(snapDir, { recursive: true });
      const day = new Date().toISOString().slice(0, 10);
      const tmp = path.join(snapDir, day + '.json.tmp');
      fs.writeFileSync(tmp, JSON.stringify(obj));
      fs.renameSync(tmp, path.join(snapDir, day + '.json'));
      const days = fs.readdirSync(snapDir).filter(f => SNAP_RE.test(f)).sort();
      while (days.length > SNAP_KEEP) fs.unlinkSync(path.join(snapDir, days.shift()));
    } catch (e) { console.warn('[ledger] snapshot failed: ' + e.message); }
  };
  const listSnapshots = () => {
    try {
      return fs.readdirSync(snapDir).filter(f => SNAP_RE.test(f)).sort().reverse().map(f => {
        const st = fs.statSync(path.join(snapDir, f));
        let rev = null;
        try { rev = JSON.parse(fs.readFileSync(path.join(snapDir, f), 'utf8')).rev; } catch (e) {}
        return { date: f.slice(0, 10), bytes: st.size, rev };
      });
    } catch (e) { return []; }
  };
  const authOk = (req) => {
    if (!auth) return true;
    return timingSafeEq(req.headers['authorization'] || '', 'Bearer ' + auth);
  };
  // READ_TOKEN grants exactly one thing: GETs under /api/v1. It never opens /api/data,
  // attachments, snapshots, or any write path. When no AUTH_TOKEN is set at all the whole
  // server is open (unchanged from before) and this distinction is moot.
  const readOk = (req) => authOk(req)
    || (!!readAuth && timingSafeEq(req.headers['authorization'] || '', 'Bearer ' + readAuth));
  const json = (res, code, obj) => {
    const body = JSON.stringify(obj);
    const write = () => {
      res.writeHead(code, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(body);
    };
    // Flat 300ms on every 401: turns online brute-force of the bearer tokens from
    // thousands of guesses/second into three per second, at zero cost to real clients
    // (a legitimate client only ever sees 401 once, at token entry).
    if (code === 401) setTimeout(write, 300);
    else write();
  };

  /* ---------------- server-side data caches (per wallet, gzip JSON) ---------------- */
  const fillsFile = a => path.join(fillsDir, a.toLowerCase() + '.json.gz');
  const fundingFile = a => path.join(fundingDir, a.toLowerCase() + '.json.gz');
  const ledgerFile = a => path.join(ledgerDir, a.toLowerCase() + '.json.gz');
  const readFillCache = a => { const c = gzRead(fillsFile(a)); return (c && c.v === 1 && Array.isArray(c.fills)) ? c : null; };
  const readFundingCache = a => { const c = gzRead(fundingFile(a)); return (c && c.v === 1 && Array.isArray(c.rows)) ? c : null; };
  const readLedgerCache = a => { const c = gzRead(ledgerFile(a)); return (c && c.v === 1 && Array.isArray(c.rows)) ? c : null; };
  const readMarket = () => { try { return JSON.parse(fs.readFileSync(marketFile, 'utf8')); } catch (e) { return null; } };

  const currentSnapshot = () => {
    const d = readData();
    return (d && d.snapshot) || { wallets: [], settings: {}, journal: {} };
  };
  const snapWallets = (snap) => (Array.isArray(snap.wallets) ? snap.wallets : [])
    .filter(w => w && ADDR_RE.test(w.address || ''));

  /* ---------------- refresh: Hyperliquid -> caches (mirrors the client's loadAll) ---------------- */
  let _refreshing = false, _lastRefreshAt = 0, _lastRefreshSummary = null;
  const REFRESH_MIN_MS = 15000;
  // Generation counter: a doRefresh that outlives its watchdog becomes a zombie whose late
  // cache writes would overwrite a NEWER refresh's data with stale bytes stamped fresh.
  // Each run captures the generation at start; the watchdog bumps it on timeout, and every
  // write checks it first — a superseded run dies at its next write instead of clobbering.
  let _refreshGen = 0;

  async function fetchPositionsSrv(addr, hip3Dexs) {
    // Client fetchPositions carries browser-only HIP-3 diagnostics (IndexedDB, status bar);
    // this is the same call pattern minus those, built on the extracted hlPost/mapClearinghouse.
    let positions = [], accountValue = null, withdrawable = null;
    try {
      const s = await E.hlPost({ type: 'clearinghouseState', user: addr });
      positions = E.mapClearinghouse(s, '');
      accountValue = s.marginSummary ? parseFloat(s.marginSummary.accountValue) : null;
      if (s.withdrawable != null) withdrawable = parseFloat(s.withdrawable);
    } catch (e) {}
    for (const dex of (hip3Dexs || [])) {
      try {
        const s = await E.hlPost({ type: 'clearinghouseState', user: addr, dex });
        positions = positions.concat(E.mapClearinghouse(s, dex));
      } catch (e) {}                    // a dead/renamed dex shouldn't sink the whole load
    }
    return { positions, accountValue, withdrawable };
  }

  async function doRefresh(body) {
    const gen = ++_refreshGen;
    const fresh = () => { if (gen !== _refreshGen) throw { code: 409, msg: 'superseded by a newer refresh' }; };
    const snap = currentSnapshot();
    let wallets = snapWallets(snap);
    if (Array.isArray(body.wallets) && body.wallets.length) {
      const want = body.wallets.map(String);
      const bad = want.find(a => !ADDR_RE.test(a));
      if (bad) throw { code: 400, msg: 'invalid wallet address: ' + bad };
      wallets = want.map(a => wallets.find(w => w.address.toLowerCase() === a.toLowerCase())
                          || { address: a, label: '' });
    }
    if (!wallets.length) throw { code: 400, msg: 'no wallets: none saved in the app and none passed in body.wallets' };

    const spotMaps = await E.fetchSpotMaps();
    const out = { wallets: [], startedAt: Date.now() };
    let positions = [], accVals = [], freeVals = [], spotHold = [], spotAccVals = [];
    let portAll = 0, portPerp = 0, portAllHas = false, portPerpHas = false;

    for (const w of wallets) {
      if (gen !== _refreshGen) break; // superseded: stop fetching, the final fresh() below reports it
      const res = { address: w.address, label: w.label || '', newFills: 0, fills: 0, truncated: false, error: null };
      try {
        const cache = body.full ? null : readFillCache(w.address);
        const since = (cache && cache.last) ? cache.last : 0; // resume AT the watermark — dedupe below handles the overlap, boundary-ms fills are never skipped
        const fr = await E.fetchAllFills(w.address, since);
        let fills;
        if (cache) {
          const seen = new Set(cache.fills.map(fillId));
          fills = cache.fills.slice();
          for (const f of fr.fills) if (!seen.has(fillId(f))) { seen.add(fillId(f)); fills.push(f); res.newFills++; }
          res.truncated = !!cache.truncated || !!fr.truncated; // a gap found once stays flagged
        } else { fills = fr.fills; res.newFills = fills.length; res.truncated = !!fr.truncated; }
        const last = fills.reduce((m, f) => f.time > m ? f.time : m, 0);
        fresh(); gzWrite(fillsFile(w.address), { v: 1, last, count: fills.length, savedAt: Date.now(), truncated: res.truncated, fills });
        res.fills = fills.length;

        // funding: full refetch each refresh — matches the client, keeps semantics identical
        const frows = await E.fetchFunding(w.address);
        fresh(); gzWrite(fundingFile(w.address), { v: 1, savedAt: Date.now(), rows: frows });

        // capital flows (deposits/withdrawals/transfers) — small, full refetch like funding
        const led = await E.fetchLedgerUpdates(w.address);
        fresh(); gzWrite(ledgerFile(w.address), { v: 1, savedAt: Date.now(), rows: led });

        const hip3 = E.hip3DexsFromFills(fills);
        const [ch, sbal, port] = await Promise.all([
          fetchPositionsSrv(w.address, hip3),
          E.fetchSpotState(w.address),
          E.fetchPortfolio(w.address),
        ]);
        ch.positions.forEach(p => p.wallet = { address: w.address, label: w.label || '' });
        positions = positions.concat(ch.positions);
        if (ch.accountValue != null) accVals.push(ch.accountValue);
        if (ch.withdrawable != null) freeVals.push(ch.withdrawable);
        if (port.all != null) { portAll += port.all; portAllHas = true; }
        if (port.perp != null) { portPerp += port.perp; portPerpHas = true; }
        let spotVal = 0;
        sbal.forEach(b => {
          const mark = spotMaps.markBySym[b.coin] || (b.coin === 'USDC' ? 1 : 0);
          const value = b.total * mark; spotVal += value;
          if (b.coin !== 'USDC' && b.total > 1e-9 && (value >= 1 || b.entry >= 1))
            spotHold.push({ coin: b.coin, total: b.total, entry: b.entry, mark, value,
              uPnl: value - b.entry, wallet: { address: w.address, label: w.label || '' } });
        });
        if (sbal.length) spotAccVals.push(spotVal);
      } catch (e) { res.error = (e && (e.message || e.msg)) || String(e); } // internal throws carry .msg — '[object Object]' helps nobody
      out.wallets.push(res);
    }

    const market = {
      fetchedAt: Date.now(),
      positions,
      accountValue: accVals.length ? accVals.reduce((a, b) => a + b, 0) : null,
      accountFree: freeVals.length ? freeVals.reduce((a, b) => a + b, 0) : null,
      spotHoldings: spotHold,
      spotAccountValue: spotAccVals.length ? spotAccVals.reduce((a, b) => a + b, 0) : null,
      hlPnl: { all: portAllHas ? portAll : null, perp: portPerpHas ? portPerp : null },
      spotMaps,
    };
    fresh(); // last checkpoint before the market snapshot lands
    const tmp = marketFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(market));
    fs.renameSync(tmp, marketFile);
    _tradesMemo = null;
    out.finishedAt = Date.now();
    return out;
  }

  /* ---------------- trades: rebuilt from caches, memoized ---------------- */
  let _tradesMemo = null; // {sig, trades, builtAt}
  function cacheSig() {
    const parts = [];
    // funding + ledger mtimes are load-bearing, not decorative: today they only ever change
    // alongside a fills write, but that invariant was accidental — any future path writing
    // funding alone would have served stale trades forever. Labels invalidate too, so a
    // wallet rename shows up without waiting for the next refresh.
    for (const [tag, dir] of [['', fillsDir], ['f', fundingDir], ['l', ledgerDir]]) {
      try { for (const f of fs.readdirSync(dir).sort()) parts.push(tag + f + ':' + fs.statSync(path.join(dir, f)).mtimeMs); } catch (e) {}
    }
    try { parts.push('m:' + fs.statSync(marketFile).mtimeMs); } catch (e) {}
    const snap = currentSnapshot();
    parts.push('w:' + snapWallets(snap).map(w => w.address.toLowerCase() + ':' + (w.label || '')).join(','));
    return parts.join('|');
  }
  function ensureTrades() {
    if (!engine.ok) throw { code: 503, msg: 'analytics engine unavailable — the served ledger.html is missing: ' + engine.missing.join(', ') };
    const sig = cacheSig();
    if (_tradesMemo && _tradesMemo.sig === sig) return _tradesMemo;
    const snap = currentSnapshot();
    const market = readMarket();
    const nameByCoin = (market && market.spotMaps && market.spotMaps.nameByCoin) || {};
    // wallets = saved wallets ∪ anything we have a fill cache for (covers body.wallets refreshes)
    const wallets = snapWallets(snap).slice();
    try {
      for (const f of fs.readdirSync(fillsDir)) {
        const a = f.replace(/\.json\.gz$/, '');
        if (ADDR_RE.test(a) && !wallets.find(w => w.address.toLowerCase() === a)) wallets.push({ address: a, label: '' });
      }
    } catch (e) {}
    let trades = [];
    for (const w of wallets) {
      const fc = readFillCache(w.address);
      if (!fc || !fc.fills.length) continue;
      const frows = (readFundingCache(w.address) || { rows: [] }).rows;
      // exactly the client's reconstructCompute fallback path:
      const perp = E.attributeFunding(E.reconstructTrades(fc.fills, w.address, 'perp'), frows);
      const spot = E.attributeFunding(E.reconstructTrades(fc.fills, w.address, 'spot'), []);
      spot.forEach(t => t.symbol = nameByCoin[t.coin] || t.coin);
      [...perp, ...spot].forEach(t => t.wallet = { address: w.address, label: w.label || '' });
      trades = trades.concat(perp, spot);
    }
    trades.sort((a, b) => b.openTime - a.openTime);
    _tradesMemo = { sig, trades, builtAt: Date.now() };
    return _tradesMemo;
  }

  /* ---------------- request-scoped engine state + filtering ---------------- */
  const S_DEFAULTS = { beThreshold: 50, rBasis: 'avgloss', riskDefault: null, tz: 'utc' };
  function setEngineState(query) {
    if (!engine.ok) throw { code: 503, msg: 'analytics engine unavailable — the served ledger.html is missing: ' + engine.missing.join(', ') };
    const snap = currentSnapshot();
    const s = Object.assign({}, S_DEFAULTS, snap.settings || {});
    if (query.tz === 'utc' || query.tz === 'local') s.tz = query.tz;
    else if (s.tz !== 'utc' && s.tz !== 'local') s.tz = 'utc';
    E.settings = s;
    E.journal = (snap.journal && typeof snap.journal === 'object') ? snap.journal : {};
    E._be = (s.beThreshold != null && isFinite(s.beThreshold)) ? s.beThreshold : 50;
    return { snap, settings: s };
  }
  function applyFilters(trades, q) {
    const be = E._be;
    const market = q.market && q.market !== 'combined' ? q.market : null;
    if (market && market !== 'perp' && market !== 'spot') throw { code: 400, msg: 'market must be perp|spot|combined' };
    const wallet = q.wallet ? String(q.wallet).toLowerCase() : null;
    const coin = q.coin ? String(q.coin).toUpperCase() : null;
    const dir = q.dir || null;
    const status = q.status || 'all';
    const outcome = q.outcome || null;
    const tag = q.tag || null;
    const text = q.q ? String(q.q).toLowerCase() : null;
    // A bare date is a whole calendar day on the requested clock (tz=utc|local): from= is its
    // first millisecond and to= its LAST, so to=2026-09-01 includes Sept 1 (like the app's range).
    const dayBound = (v, end) => {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v == null ? '' : v));
      if (!m) return parseTime(v);
      const y = +m[1], mo = +m[2] - 1, d = +m[3], utc = !(E.settings && E.settings.tz === 'local');
      const at = dd => utc ? Date.UTC(y, mo, dd) : new Date(y, mo, dd).getTime();
      return end ? at(d + 1) - 1 : at(d);
    };
    const from = dayBound(q.from, false), to = dayBound(q.to, true);
    return trades.filter(t => {
      if (market && t.market !== market) return false;
      if (wallet && (!t.wallet || t.wallet.address.toLowerCase() !== wallet)) return false;
      if (coin && String(t.coin).toUpperCase() !== coin && String(t.symbol || '').toUpperCase() !== coin) return false;
      if (dir && t.dir !== dir) return false;
      if (status === 'open' && !t.isOpen) return false;
      if (status === 'closed' && t.isOpen) return false;
      if (from != null && t.closeTime < from) return false;
      if (to != null && t.closeTime > to) return false;
      if (outcome) {
        if (t.isOpen) return false;
        if (outcome === 'win' && !(t.net > be)) return false;
        if (outcome === 'loss' && !(t.net < -be)) return false;
        if (outcome === 'be' && !(Math.abs(t.net) <= be)) return false;
      }
      if (tag || text) {
        const j = E.journal[t.id] || {};
        if (tag && !(Array.isArray(j.tags) && j.tags.includes(tag))) return false;
        if (text && !String(j.notes || '').toLowerCase().includes(text)) return false;
      }
      return true;
    });
  }
  // Standard prep: engine state -> filter -> pin _oneR to the filtered closed set,
  // mirroring the client's render() (_oneR = computeOneR(periodTrades())).
  function prepare(query) {
    const { settings } = setEngineState(query);
    const { trades, builtAt } = ensureTrades();
    const all = applyFilters(trades, query);
    const closed = all.filter(t => !t.isOpen);
    E._oneR = E.computeOneR(closed);
    return { all, closed, settings, builtAt };
  }
  function shapeTrade(t, withEvents) {
    const j = E.journal[t.id] || null;
    return {
      id: t.id, wallet: t.wallet || null, market: t.market, coin: t.coin,
      symbol: t.symbol || null, dir: t.dir, isOpen: !!t.isOpen,
      openTime: t.openTime, closeTime: t.closeTime, durationMs: t.durationMs,
      openSz: t.openSz, closeSz: t.closeSz, maxSize: t.maxSize,
      avgEntry: t.avgEntry, avgExit: t.avgExit, firstEntryPx: t.firstEntryPx,
      entryDrift: t.entryDrift, pnl: t.pnl, fees: t.fees, funding: t.funding || 0,
      net: t.net, r: E.rFor(t), retPct: E.retPct(t),
      fills: t.fills, makerFills: t.makerFills, takerFills: t.takerFills,
      liquidated: !!t.liquidated, partialHistory: !!t.partialHistory,
      journal: j,
      ...(withEvents ? { events: t.events || [] } : {}),
    };
  }
  const dayKeyN = (ms) => {
    const p = E.tzParts(ms);
    return p.y + '-' + String(p.mo + 1).padStart(2, '0') + '-' + String(p.day).padStart(2, '0');
  };

  /* ---------------- whatif rule -> predicate ---------------- */
  const WHATIF_FIELDS = {
    coin: t => String(t.coin).toUpperCase(), symbol: t => String(t.symbol || t.coin).toUpperCase(),
    dir: t => t.dir, market: t => t.market,
    wallet: t => (t.wallet && t.wallet.address || '').toLowerCase(),
    net: t => t.net, durationms: t => t.durationMs,
    hour: t => E.tzParts(t.closeTime).h, dow: t => E.tzParts(t.closeTime).dow,
    tag: null, // special-cased: membership in journal tags
  };
  function predFromQuery(q) {
    const field = String(q.field || '').toLowerCase();
    const op = String(q.op || 'eq').toLowerCase();
    const raw = q.value;
    if (!(field in WHATIF_FIELDS)) throw { code: 400, msg: 'field must be one of ' + Object.keys(WHATIF_FIELDS).join('|') };
    if (raw == null || raw === '') throw { code: 400, msg: 'value is required' };
    if (field === 'tag') {
      if (op !== 'eq' && op !== 'ne') throw { code: 400, msg: 'tag supports op=eq|ne' };
      const want = String(raw);
      return t => {
        const j = E.journal[t.id] || {};
        const has = Array.isArray(j.tags) && j.tags.includes(want);
        return op === 'eq' ? has : !has;
      };
    }
    const get = WHATIF_FIELDS[field];
    const numeric = field === 'net' || field === 'durationms' || field === 'hour' || field === 'dow';
    const cmp = numeric ? parseFloat(raw) : String(raw).toUpperCase() === String(raw) && (field === 'coin' || field === 'symbol')
      ? String(raw).toUpperCase() : String(raw);
    const list = op === 'in' ? String(raw).split(',').map(s => numeric ? parseFloat(s) : (field === 'coin' || field === 'symbol' ? s.toUpperCase() : s)) : null;
    const norm = v => (field === 'coin' || field === 'symbol') ? String(v).toUpperCase()
      : field === 'wallet' ? String(v).toLowerCase() : v;
    switch (op) {
      case 'eq':  return t => get(t) === norm(cmp);
      case 'ne':  return t => get(t) !== norm(cmp);
      case 'lt':  return t => get(t) <  cmp;
      case 'lte': return t => get(t) <= cmp;
      case 'gt':  return t => get(t) >  cmp;
      case 'gte': return t => get(t) >= cmp;
      case 'in':  return t => list.map(norm).includes(get(t));
      default: throw { code: 400, msg: 'op must be eq|ne|lt|lte|gt|gte|in' };
    }
  }

  /* ---------------- scheduled refresh + webhook alerts ---------------- */
  // REFRESH_INTERVAL_MIN=30 keeps the server-side caches fresh without anyone opening the
  // app; ALERT_WEBHOOK (Discord/Slack/ntfy/generic-JSON) then gets pinged when something
  // needs a human: a position near liquidation, the daily loss limit crossed, a drawdown
  // beyond the Monte-Carlo p95 for this return stream, or heavy funding bleed. Alerting is
  // the half of a journal that changes behavior DURING the session, not after it.
  const refreshEveryMin = opts.refreshEveryMin !== undefined ? opts.refreshEveryMin
    : parseFloat(process.env.REFRESH_INTERVAL_MIN || '0');
  const alertCfg = Object.assign({
    webhook: process.env.ALERT_WEBHOOK || '',
    liqPct: parseFloat(process.env.ALERT_LIQ_PCT || '10'),        // % from liquidation
    dailyLoss: parseFloat(process.env.ALERT_DAILY_LOSS || '0'),   // $; 0 = fall back to the app's saved daily-loss rule
    funding24h: parseFloat(process.env.ALERT_FUNDING_24H || '0'), // $ paid per 24h; 0 = off
    cooldownMs: 6 * 3600e3,
  }, opts.alerts || {});

  // NUDGE_HOUR (0–23, unset = off) + NUDGE_TZ (IANA, default UTC): once a day after that hour,
  // if trades closed today are unjournaled or the day has no end-of-day review, say so on the
  // same channels as alerts. Read-only like everything else here — it only counts.
  // The zone used for "today" and for NUDGE_HOUR follows the app's own day-journal calendar
  // (settings.tz 'utc' -> UTC; 'local' -> the browser zone the app records as settings.tzZone),
  // so the review the nudge looks for is keyed to the same date the trader wrote it under.
  // NUDGE_TZ is the fallback when the app hasn't reported a zone yet.
  const nudgeCfg = Object.assign({
    // strict: parseInt('6pm') is 6 and parseInt('25') is 25 — anything but a bare 0-23 is refused below
    hour: process.env.NUDGE_HOUR != null && process.env.NUDGE_HOUR !== ''
      ? (/^\s*\d{1,2}\s*$/.test(process.env.NUDGE_HOUR) ? parseInt(process.env.NUDGE_HOUR, 10) : NaN) : null,
    tz: process.env.NUDGE_TZ || 'UTC',
  }, opts.nudge || {});
  const validZone = z => { try { zonedDayHour(0, z); return true; } catch (e) { return false; } };
  function nudgeZone(settings) {
    const st = settings || {};
    if (st.tz === 'utc') return 'UTC';
    if (typeof st.tzZone === 'string' && validZone(st.tzZone)) return st.tzZone;
    return nudgeCfg.tz;
  }
  try { zonedDayHour(Date.now(), nudgeCfg.tz); }
  catch (e) { console.warn('[ledger] NUDGE_TZ "' + nudgeCfg.tz + '" is not a valid IANA time zone — using UTC'); nudgeCfg.tz = 'UTC'; }
  if (nudgeCfg.hour != null && !(Number.isInteger(nudgeCfg.hour) && nudgeCfg.hour >= 0 && nudgeCfg.hour <= 23)) {
    console.warn('[ledger] NUDGE_HOUR "' + process.env.NUDGE_HOUR + '" is not an hour 0–23 — the journaling nudge is off');
    nudgeCfg.hour = null;
  }

  const coachCfg = Object.assign({
    enabled: /^(1|on|true|yes)$/i.test(process.env.COACH_AI || ''),
    model: process.env.COACH_AI_MODEL || 'claude-opus-5-5',
    client: null, // tests inject a stub with beta.messages.create
  }, opts.coach || {});
  let _coachClient = null;
  function coachClient() {
    if (coachCfg.client) return coachCfg.client;
    if (_coachClient) return _coachClient;
    let SDK;
    try { SDK = require('@anthropic-ai/sdk'); }
    catch (e) { throw { code: 503, msg: 'COACH_AI is on but @anthropic-ai/sdk is not installed — run npm install' }; }
    const Anthropic = SDK.default || SDK;
    _coachClient = new Anthropic(); // credentials: ANTHROPIC_API_KEY (or any source the SDK resolves)
    return _coachClient;
  }
  async function writeCoachLetter(facts) {
    const client = coachClient();
    let msg;
    try { msg = await client.beta.messages.create(coachLetterRequest(facts, coachCfg.model)); }
    catch (e) {
      const SDK = (() => { try { const m = require('@anthropic-ai/sdk'); return m.default || m; } catch (e2) { return null; } })();
      if (SDK && e instanceof SDK.AuthenticationError) throw { code: 502, msg: 'Claude API rejected the key — check ANTHROPIC_API_KEY' };
      if (SDK && e instanceof SDK.RateLimitError) throw { code: 429, msg: 'Claude API rate limit — try again in a minute' };
      if (SDK && e instanceof SDK.APIError) throw { code: 502, msg: 'Claude API error ' + (e.status || '') + ': ' + e.message };
      throw { code: 502, msg: 'Claude API unreachable: ' + ((e && e.message) || e) };
    }
    const r = coachLetterText(msg);
    if (r.error) throw { code: 502, msg: r.error };
    return { text: r.text, model: (msg && msg.model) || coachCfg.model }; // a fallback may have served it
  }
  async function coachChat(chat) {
    const client = coachClient();
    let msg;
    try { msg = await client.beta.messages.create(coachChatRequest(chat, coachCfg.model)); }
    catch (e) {
      const SDK = (() => { try { const m = require('@anthropic-ai/sdk'); return m.default || m; } catch (e2) { return null; } })();
      if (SDK && e instanceof SDK.AuthenticationError) throw { code: 502, msg: 'The server’s Anthropic API key was rejected.' };
      if (SDK && e instanceof SDK.RateLimitError) throw { code: 429, msg: 'The coach is busy — try again in a minute.' };
      if (SDK && e instanceof SDK.APIError) throw { code: 502, msg: 'The coach hit an error (' + (e.status || '') + ').' };
      throw { code: 502, msg: 'The coach couldn’t be reached.' };
    }
    if (msg && msg.stop_reason === 'refusal') throw { code: 422, msg: 'The coach can’t help with that one. Try asking about your own trading process.' };
    const r = coachLetterText(msg);
    if (r.error) throw { code: 502, msg: 'The coach returned an empty answer — try again.' };
    return { text: r.text, model: (msg && msg.model) || coachCfg.model };
  }

  /* ---------------- Telegram bot: delivery channel + read-only commands ---------------- */
  // TELEGRAM_BOT_TOKEN (from @BotFather) + TELEGRAM_CHAT_ID (comma-separated chat-id
  // allowlist) turn on two things: alert/digest delivery to those chats, and a long-polling
  // command bot (/today /risk /stats /goals /digest). Read-only by design — no command can
  // write journal data. Messages from chats outside the allowlist are ignored silently:
  // the journal is private, and even an error reply would confirm the bot is alive.
  const telegramCfg = Object.assign({
    token: process.env.TELEGRAM_BOT_TOKEN || '',
    chats: String(process.env.TELEGRAM_CHAT_ID || '').split(',').map(s => s.trim()).filter(Boolean),
    // accountability partner / group: receives only what the trader explicitly shares
    shareChats: String(process.env.TELEGRAM_SHARE_CHAT_ID || '').split(',').map(s => s.trim()).filter(Boolean),
  }, opts.telegram || {});
  const tgApi = (method) => 'https://api.telegram.org/bot' + telegramCfg.token + '/' + method;
  async function tgSend(chatId, text) {
    const res = await fetch(tgApi('sendMessage'), { method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: String(text).slice(0, 4000) }), signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error('telegram HTTP ' + res.status);
  }
  async function tgBroadcast(text, chats) {
    let sent = 0, lastErr = null;
    for (const c of (chats || telegramCfg.chats)) {
      try { await tgSend(c, text); sent++; } catch (e) { lastErr = e; }
    }
    if (!sent) throw lastErr || new Error('no telegram chats configured');
    return sent;
  }
  // One predicate + one sender for "somewhere to deliver alerts and digests". Webhook and
  // Telegram are peers; success on either channel counts as delivered (a half-failed send
  // still reached a human, and per-channel retry bookkeeping isn't worth the complexity).
  const hasDelivery = () => !!(alertCfg.webhook || (telegramCfg.token && telegramCfg.chats.length));
  async function deliver(text) {
    let ok = 0, lastErr = null;
    if (alertCfg.webhook) { try { await postWebhook(alertCfg.webhook, text); ok++; } catch (e) { lastErr = e; } }
    if (telegramCfg.token && telegramCfg.chats.length) { try { await tgBroadcast(text); ok++; } catch (e) { lastErr = e; } }
    if (!ok) throw lastErr || new Error('no delivery channel configured');
    return ok;
  }
  // Plain-data snapshot for the pure telegramReply router. Every field beyond engineOk is
  // optional — the router degrades to "refresh first" answers when caches are cold.
  function buildBotState() {
    if (!engine.ok) return { engineOk: false };
    const snap = currentSnapshot();
    setEngineState({});
    const { trades } = ensureTrades();
    const closed = trades.filter(t => !t.isOpen && t.closeTime).sort((a, b) => a.closeTime - b.closeTime);
    // "today" on the trader's calendar (the app's clock setting), not the container's zone
    const zone = nudgeZone(snap.settings);
    const dayOf = (ms) => zonedDayHour(ms, zone).day;
    const todayKey = dayOf(Date.now());
    let todayNet = 0, todayN = 0;
    for (const t of closed) if (dayOf(t.closeTime) === todayKey) { todayNet += t.net; todayN++; }
    const rules = (snap.settings && snap.settings.rules) || {};
    const st = { engineOk: true, todayNet, todayN, tripLimit: parseFloat(rules.dailyLossLimit) || 0 };
    const market = readMarket();
    if (market) {
      st.accountValue = market.accountValue;
      const rm = E.openRiskModel(market.positions || []);
      st.risk = rm ? { positions: rm.positions, gross: rm.gross, skew: rm.skew,
        dangers: rm.danger.map(r => ({ coin: r.coin, side: r.side,
          liqDistPct: r.liqDist != null ? r.liqDist * 100 : null })) }
        : { positions: 0, gross: 0, skew: 0, dangers: [] };
    }
    const w30 = closed.filter(t => t.closeTime >= Date.now() - 30 * 86400000);
    if (w30.length) {
      E._oneR = E.computeOneR(w30);
      const s = E.computeStats(w30, w30);
      st.stats30 = { n: w30.length, net: s.net, winRate: s.winRate, expectancy: s.expectancy,
        profitFactor: isFinite(s.profitFactor) ? s.profitFactor : null, fees: s.fees };
    }
    try { const g = E.monthlyGoalModel(closed, (snap.settings && snap.settings.goals) || null); if (g) st.goals = g; } catch (e) {}
    try {
      const files = fs.readdirSync(reportsDir).filter(f => /^weekly-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
      if (files.length) st.digest = digestText(JSON.parse(fs.readFileSync(path.join(reportsDir, files[files.length - 1]), 'utf8')));
    } catch (e) {}
    return st;
  }
  let _tgOffset = 0;
  async function telegramLoop() {
    for (;;) {
      try {
        const res = await fetch(tgApi('getUpdates') + '?timeout=50&offset=' + _tgOffset);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const j = await res.json();
        for (const u of ((j && j.result) || [])) {
          _tgOffset = u.update_id + 1;
          const msg = u.message;
          if (!msg || typeof msg.text !== 'string') continue;
          const chat = String(msg.chat && msg.chat.id);
          if (!telegramCfg.chats.includes(chat)) continue; // strangers: silence, not an error reply
          const cmd = msg.text.trim().split(/[\s@]/)[0].toLowerCase();
          let reply;
          try { reply = telegramReply(cmd, buildBotState()); }
          catch (e) { reply = 'Server error building the answer: ' + ((e && (e.msg || e.message)) || e); }
          try { await tgSend(chat, reply); } catch (e) { console.warn('[ledger] telegram send failed: ' + e.message); }
        }
      } catch (e) { await new Promise(r => setTimeout(r, 10000)); } // network trouble: back off, keep polling
    }
  }
  if (telegramCfg.token && telegramCfg.chats.length && !opts.noTelegramLoop) {
    telegramLoop();
    console.log('[ledger] telegram bot polling (' + telegramCfg.chats.length + ' allowed chat'
      + (telegramCfg.chats.length === 1 ? '' : 's') + ')');
  }

  function gatherAlertState() {
    if (!engine.ok) return null;
    const snap = currentSnapshot();
    setEngineState({});
    const { trades } = ensureTrades();
    const closed = trades.filter(t => !t.isOpen && t.closeTime).sort((a, b) => a.closeTime - b.closeTime);
    const market = readMarket();
    const risk = market ? E.openRiskModel(market.positions || []) : null;
    // "today" on the trader's calendar (the app's clock setting), not the container's zone
    const zone = nudgeZone(snap.settings);
    const dayOf = (ms) => zonedDayHour(ms, zone).day;
    const todayKey = dayOf(Date.now());
    let todayNet = 0; for (const t of closed) if (dayOf(t.closeTime) === todayKey) todayNet += t.net;
    // every cached wallet, not just saved ones — todayNet already covers all cached
    // wallets via ensureTrades, and the two feeding different wallet sets skewed alerts
    let funding24h = 0; const cut = Date.now() - 86400000;
    try { for (const f of fs.readdirSync(fundingDir)) { const a = f.replace(/\.json\.gz$/, '');
      if (!ADDR_RE.test(a)) continue;
      const fc = readFundingCache(a);
      if (fc) for (const r of fc.rows) if (r.time >= cut && isFinite(r.usdc)) funding24h += r.usdc; } } catch (e) {}
    const nets = closed.map(t => t.net);
    let currentDD = null, ddP95 = null;
    if (nets.length >= 20) {
      currentDD = E.currentDD(nets).dd;
      E._srand(E._hashSeed('alerts|' + nets.length));
      const mc = E.mcMaxDD(nets, 1000); if (mc) ddP95 = mc.p95;
    }
    return { risk: (risk && risk.rows) || [], todayKey, todayNet, funding24h, currentDD, ddP95,
      rulesDailyLoss: (snap.settings && snap.settings.rules && parseFloat(snap.settings.rules.dailyLossLimit)) || 0 };
  }
  // Alert dedupe state survives restarts: Railway redeploys reset process memory, and
  // without this every deploy re-fired any currently-true alert.
  const alertStateFile = path.join(dataDir, 'alert-state.json');
  const _alertSent = new Map();
  try { const st = JSON.parse(fs.readFileSync(alertStateFile, 'utf8'));
    if (st && typeof st === 'object') for (const k in st) if (isFinite(st[k])) _alertSent.set(k, st[k]);
  } catch (e) {}
  const saveAlertState = () => {
    try { const tmp = alertStateFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(_alertSent)));
      fs.renameSync(tmp, alertStateFile);
    } catch (e) {}
  };
  let _alertBusy = false;
  async function maybeAlert() {
    if (!hasDelivery() || _alertBusy) return; // overlapping calls (scheduled tick + manual refresh) posted duplicates
    _alertBusy = true;
    try {
      let state;
      try { state = gatherAlertState(); }
      catch (e) { console.warn('[ledger] alert state failed: ' + ((e && (e.msg || e.message)) || e)); return; } // a dead alert path deserves a log line, not silence
      if (!state) return;
      const cfg = { ...alertCfg, dailyLoss: alertCfg.dailyLoss > 0 ? alertCfg.dailyLoss : state.rulesDailyLoss };
      const now = Date.now();
      const due = alertsFrom(state, cfg).filter(a => now - (_alertSent.get(a.key) || 0) >= alertCfg.cooldownMs);
      if (due.length) {
        for (const a of due) _alertSent.set(a.key, now); // record BEFORE the await — the send window was the double-post race
        try { await deliver(due.map(a => a.text).join('\n')); }
        catch (e) { for (const a of due) _alertSent.delete(a.key); console.warn('[ledger] alert delivery failed: ' + e.message); } // failed post re-arms
      }
      for (const [k, ts] of _alertSent) if (now - ts > 7 * 86400e3) _alertSent.delete(k); // day-scoped keys otherwise accrete forever
      saveAlertState();
    } finally { _alertBusy = false; }
  }
  function gatherNudgeState(now) {
    if (!engine.ok) return null;
    const snap = currentSnapshot();
    setEngineState({});
    const { trades } = ensureTrades();
    const zone = nudgeZone(snap.settings);
    const z = zonedDayHour(now, zone);
    const J = (snap.journal && typeof snap.journal === 'object') ? snap.journal : {};
    // only trades from the last ~day can be "today": skip formatting the whole history
    const today = trades.filter(t => !t.isOpen && t.closeTime && t.closeTime > now - 36 * 3600e3
      && zonedDayHour(t.closeTime, zone).day === z.day);
    const de = J['day:' + z.day];
    return { dayKey: z.day, hour: z.hour, tradesToday: today.length,
      unjournaled: today.filter(t => !E.isJournaled(J[t.id])).length,
      hasReview: !!(de && de.review && String(de.review).trim()) };
  }
  async function maybeNudge() {
    if (!hasDelivery() || nudgeCfg.hour == null) return;
    try { const st = currentSnapshot().settings; if (st && st.coachMode === false) return; } catch (e) {} // coach mode off in the app
    const now = Date.now();
    let n;
    try { n = nudgeFrom(gatherNudgeState(now), nudgeCfg); }
    catch (e) { console.warn('[ledger] nudge state failed: ' + ((e && (e.msg || e.message)) || e)); return; }
    if (!n || _alertSent.has(n.key)) return;
    _alertSent.set(n.key, now); saveAlertState(); // once per day, across restarts too
    try { await deliver(n.text); }
    catch (e) { _alertSent.delete(n.key); saveAlertState(); console.warn('[ledger] nudge delivery failed: ' + e.message); }
  }
  async function runScheduledRefresh() {
    if (_refreshing) return;
    _refreshing = true;
    let watchdog = null; // same 5-minute deadline as the POST route — a hang must not pin the mutex
    try {
      const summary = await Promise.race([
        doRefresh({}),
        new Promise((_, reject) => { watchdog = setTimeout(() => {
          _refreshGen++; _lastRefreshAt = Date.now(); // invalidate the zombie + keep the 15s gate honest
          reject(new Error('timed out'));
        }, 5 * 60000); if (watchdog.unref) watchdog.unref(); }),
      ]);
      _lastRefreshAt = Date.now(); _lastRefreshSummary = summary;
    }
    catch (e) { console.warn('[ledger] scheduled refresh failed: ' + ((e && (e.msg || e.message)) || e)); }
    finally { clearTimeout(watchdog); _refreshing = false; }
    await maybeAlert();
    await maybeNudge();
  }
  /* ---------------- weekly digest ---------------- */
  // Once per ISO week (first scheduled run after Monday 00:00 UTC) a digest of the PREVIOUS
  // week lands in DATA_DIR/reports/ (kept: 26 weeks) and, when a webhook is configured, a
  // one-paragraph summary is posted — the monthly-review habit, automated down to weekly.
  function weeklyDigest() {
    if (!engine.ok) return null;
    const nowD = new Date();
    const dow = (nowD.getUTCDay() + 6) % 7; // Monday=0
    const monday = Date.UTC(nowD.getUTCFullYear(), nowD.getUTCMonth(), nowD.getUTCDate() - dow);
    const tag = new Date(monday).toISOString().slice(0, 10);
    const file = path.join(reportsDir, 'weekly-' + tag + '.json');
    if (fs.existsSync(file)) {
      // already written — but a digest whose webhook post failed is retried on the next
      // scheduled run instead of being lost until someone reads the reports dir
      try {
        const prevD = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (hasDelivery() && prevD && prevD.webhookSent === false)
          return { file, digest: prevD, text: digestText(prevD), resend: true };
      } catch (e) {}
      return null;
    }
    setEngineState({});
    const { trades } = ensureTrades();
    const WEEK = 7 * 86400000;
    const win = (a, b) => trades.filter(t => !t.isOpen && t.closeTime >= a && t.closeTime < b);
    const wk = win(monday - WEEK, monday), prev = win(monday - 2 * WEEK, monday - WEEK);
    if (!wk.length && !prev.length) return null; // nothing to say — don't write empty reports
    const sumNet = a => a.reduce((x, t) => x + t.net, 0);
    E._oneR = E.computeOneR(wk);
    const s = wk.length ? E.computeStats(wk, wk) : null;
    const best = wk.length ? wk.reduce((m, t) => t.net > m.net ? t : m) : null;
    const worst = wk.length ? wk.reduce((m, t) => t.net < m.net ? t : m) : null;
    const digest = {
      week: tag, from: monday - WEEK, to: monday, generatedAt: Date.now(),
      n: wk.length, net: +sumNet(wk).toFixed(2), prevN: prev.length, prevNet: +sumNet(prev).toFixed(2),
      stats: s, best: best ? { coin: best.symbol || best.coin, net: best.net } : null,
      worst: worst ? { coin: worst.symbol || worst.coin, net: worst.net } : null,
      webhookSent: !hasDelivery(), // no delivery channel configured counts as nothing pending
    };
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(digest, null, 2)); fs.renameSync(tmp, file);
    try { // prune to the newest 26 weeks
      const files = fs.readdirSync(reportsDir).filter(f => /^weekly-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
      while (files.length > 26) fs.unlinkSync(path.join(reportsDir, files.shift()));
    } catch (e) {}
    return { file, text: digestText(digest), digest };
  }
  // one text builder for fresh digests and webhook retries alike
  function digestText(d) {
    const money = n => (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-US');
    const s = d.stats;
    const endTag = new Date(d.to - 86400000).toISOString().slice(0, 10); // the window is [from, to) — it ENDS the Sunday before `to`
    return '📒 Week ending ' + endTag + ': ' + d.n + ' trades, net ' + money(d.net)
      + (s ? ' · win rate ' + Math.round((s.winRate || 0) * 100) + '% · expectancy ' + money(s.expectancy || 0) + '/trade · fees ' + money(s.fees || 0) : '')
      + ' · prior week ' + money(d.prevNet) + ' over ' + d.prevN + ' trades'
      + (d.best ? ' · best ' + d.best.coin + ' ' + money(d.best.net) : '')
      + (d.worst ? ' · worst ' + d.worst.coin + ' ' + money(d.worst.net) : '');
  }
  function maybeDigest() {
    try {
      const d = weeklyDigest();
      if (d) {
        if (!d.resend) console.log('[ledger] weekly digest written: ' + d.file);
        if (hasDelivery()) deliver(d.text)
          .then(() => { // mark sent so the next run doesn't repeat it
            try { d.digest.webhookSent = true;
              const tmp = d.file + '.tmp';
              fs.writeFileSync(tmp, JSON.stringify(d.digest, null, 2)); fs.renameSync(tmp, d.file);
            } catch (e) {}
          })
          .catch(e => console.warn('[ledger] digest delivery failed (will retry next run): ' + e.message));
      }
    } catch (e) { console.warn('[ledger] weekly digest failed: ' + ((e && (e.msg || e.message)) || e)); }
  }
  if (refreshEveryMin > 0) {
    const t = setInterval(() => { runScheduledRefresh().then(maybeDigest); }, Math.max(1, refreshEveryMin) * 60000);
    if (t.unref) t.unref(); // never keep the process alive just for the schedule
    // one run shortly after boot: every redeploy resets the interval, so with long
    // intervals the Monday digest and liquidation alerts could slip by a full period
    const boot = setTimeout(() => { runScheduledRefresh().then(maybeDigest); }, 30000);
    if (boot.unref) boot.unref();
    console.log('[ledger] scheduled refresh every ' + refreshEveryMin + ' min (first run ~30s after boot)'
      + (hasDelivery() ? ' with alert delivery' : ' (no ALERT_WEBHOOK / TELEGRAM_BOT_TOKEN set — refresh only)')
      + (nudgeCfg.hour != null && hasDelivery() ? '; journaling nudge after ' + nudgeCfg.hour + ':00 (app time zone, fallback ' + nudgeCfg.tz + ')' : ''));
  } else if (nudgeCfg.hour != null) {
    console.warn('[ledger] NUDGE_HOUR is set but REFRESH_INTERVAL_MIN is not — the nudge runs on the refresh schedule, so it will never fire');
  }

  /* ---------------- v1 endpoint docs (served at GET /api/v1) ---------------- */
  const FILTER_DOC = 'market, wallet, coin, dir, status=open|closed|all, outcome=win|loss|be, tag, q, from, to (ms or seconds epoch, ISO time, or YYYY-MM-DD = that whole day on the tz clock, to inclusive; compared with closeTime, which for an open trade is its last fill — same semantics as the app), tz=utc|local';
  const V1_DOCS = [
    { method: 'GET',  path: '/api/v1', auth: 'none', desc: 'this index' },
    { method: 'POST', path: '/api/v1/refresh', auth: 'full', desc: 'fetch fills/funding/positions from Hyperliquid into server caches; body {wallets?,full?,force?}; min interval 15s unless force' },
    { method: 'GET',  path: '/api/v1/meta', auth: 'read', desc: 'freshness, wallet cache state, engine status, trade counts' },
    { method: 'GET',  path: '/api/v1/trades', auth: 'read', desc: 'trade list; filters (' + FILTER_DOC + ') + sort, order, limit (<=1000), offset, events=1' },
    { method: 'GET',  path: '/api/v1/trades/:id', auth: 'read', desc: 'one trade with fill events and journal entry' },
    { method: 'GET',  path: '/api/v1/stats', auth: 'read', desc: 'computeStats over the filtered set; filters as above' },
    { method: 'GET',  path: '/api/v1/equity', auth: 'read', desc: 'cumulative equity points, daily series, drawdown diagnostics; filters' },
    { method: 'GET',  path: '/api/v1/calendar', auth: 'read', desc: 'net PnL per calendar day (tz-aware); filters' },
    { method: 'GET',  path: '/api/v1/breakdown', auth: 'read', desc: 'grouped stats + per-group contribution shares; by=coin|dir|market|wallet|tag|dow|hour; basis=usd|pct ranks by dollars or summed return points; top=N (default 5) sizes the best/worst lists; filters' },
    { method: 'GET',  path: '/api/v1/projection', auth: 'read', desc: 'Monte Carlo forward sim; horizon (days, default 90), paths (<=2000, default 400), block, seed, lookback (days); filters' },
    { method: 'GET',  path: '/api/v1/kelly', auth: 'read', desc: 'Kelly sizing from filtered closed trades' },
    { method: 'GET',  path: '/api/v1/capital', auth: 'read', desc: 'capital flows (deposits/withdrawals/transfers) + time-weighted return-on-capital model and money-weighted xirr; account-wide — ignores filters; wallet= optional' },
    { method: 'DELETE', path: '/api/v1/cache/:addr', auth: 'full', desc: 'evict one wallet\'s server caches (fills/funding/ledger) — cleans up body.wallets experiments and removed wallets' },
    { method: 'GET',  path: '/api/v1/walkforward', auth: 'read', desc: 'rolling walk-forward expectancy (trailing train / out-of-sample test blocks) vs in-sample; train, step, seed; filters' },
    { method: 'GET',  path: '/api/v1/risk', auth: 'read', desc: 'open-position risk model over last refreshed positions' },
    { method: 'GET',  path: '/api/v1/positions', auth: 'read', desc: 'cached positions/spot/account snapshot; ?live=1 (full auth) refetches' },
    { method: 'GET',  path: '/api/v1/spot/lots', auth: 'read', desc: 'FIFO 8949-style spot cost-basis lots; wallet= optional' },
    { method: 'GET',  path: '/api/v1/whatif', auth: 'read', desc: 'counterfactual replay removing trades matching field/op/value (op: eq|ne|lt|lte|gt|gte|in); filters' },
    { method: 'GET',  path: '/api/v1/digests', auth: 'read', desc: 'stored weekly digests (newest first); /api/v1/digests/YYYY-MM-DD fetches one. Written automatically when REFRESH_INTERVAL_MIN is set' },
    { method: 'GET',  path: '/api/v1/journal', auth: 'read', desc: 'journal entries keyed by trade id (read-only)' },
    { method: 'GET',  path: '/api/v1/journal/:id', auth: 'read', desc: 'one journal entry (read-only)' },
    { method: 'GET',  path: '/api/v1/tags', auth: 'read', desc: 'distinct journal tags with usage counts' },
    { method: 'GET',  path: '/api/v1/export/trades.csv', auth: 'read', desc: 'flat CSV of the filtered trades; filters' },
    { method: 'GET',  path: '/api/v1/metrics', auth: 'read', desc: 'flat monitoring numbers (trades, PnL today/total, drawdown, exposure, account value); ?format=prom for Prometheus text' },
  ];

  /* ---------------- v1 router ---------------- */
  async function handleV1(req, res, url, query) {
    const send = (code, obj) => json(res, code, obj);
    const fail = (e) => e && e.code ? send(e.code, { error: e.msg }) : (console.error('[ledger] v1 error:', e), send(500, { error: 'internal error: ' + (e && e.message || e) }));

    if (url === '/api/v1' || url === '/api/v1/') {
      return send(200, {
        name: 'ledger-api', version: 1,
        engine: { ok: engine.ok, missing: engine.missing },
        auth: {
          full: auth ? 'Bearer AUTH_TOKEN — everything' : 'DISABLED (no AUTH_TOKEN set — server is open)',
          read: readAuth ? 'Bearer READ_TOKEN — GET /api/v1/* only' : 'not configured',
          cors: corsOrigin || 'disabled',
        },
        filters: FILTER_DOC,
        endpoints: V1_DOCS,
      });
    }

    // POST /api/v1/refresh — the only v1 route with side effects (server caches only,
    // never user data). Full token required; READ_TOKEN is deliberately not enough.
    if (url === '/api/v1/refresh') {
      if (req.method !== 'POST') return send(405, { error: 'method not allowed' });
      if (!authOk(req)) return send(401, { error: 'unauthorized' });
      if (!engine.ok) return send(503, { error: 'analytics engine unavailable — missing: ' + engine.missing.join(', ') });
      // an empty body is fine ({}); an unparseable or oversized one is an ERROR — silently
      // treating a typo'd {"wallets":[…]} as a default all-wallets refresh helped nobody
      let raw;
      try { raw = await readBody(req); }
      catch (e) { return send(413, { error: 'body too large' }); }
      let body = {};
      if (raw && raw.trim()) {
        try { body = JSON.parse(raw); } catch (e) { return send(400, { error: 'body must be valid JSON' }); }
        if (!body || typeof body !== 'object' || Array.isArray(body)) return send(400, { error: 'body must be a JSON object' });
      }
      if (_refreshing) return send(409, { error: 'refresh already running' });
      if (!body.force && Date.now() - _lastRefreshAt < REFRESH_MIN_MS)
        return send(429, { error: 'refreshed ' + Math.round((Date.now() - _lastRefreshAt) / 1000) + 's ago — min interval 15s (pass force:true to override)', lastSummary: _lastRefreshSummary });
      _refreshing = true;
      // Watchdog: hlPost retries but has no overall deadline, so a hung Hyperliquid fetch
      // used to pin _refreshing=true forever — every later refresh 409'd until a restart.
      // On timeout the zombie doRefresh may still finish its atomic cache writes in the
      // background; that's harmless, and the mutex is released so refreshes work again.
      let watchdog = null;
      try {
        const summary = await Promise.race([
          doRefresh(body),
          new Promise((_, reject) => {
            watchdog = setTimeout(() => {
              _refreshGen++;              // invalidate the zombie — its next write throws instead of clobbering
              _lastRefreshAt = Date.now(); // and a retry still honors the 15s gate
              reject({ code: 504, msg: 'refresh timed out after 5 minutes — Hyperliquid slow or unreachable; try again' });
            }, 5 * 60000);
            if (watchdog.unref) watchdog.unref();
          }),
        ]);
        _lastRefreshAt = Date.now(); _lastRefreshSummary = summary;
        const { trades } = ensureTrades();
        summary.trades = {
          total: trades.length,
          perp: trades.filter(t => t.market === 'perp').length,
          spot: trades.filter(t => t.market === 'spot').length,
          open: trades.filter(t => t.isOpen).length,
        };
        maybeAlert(); // fire-and-forget: a manual refresh should trigger the same monitoring
        return send(200, summary);
      } catch (e) { return fail(e); }
      finally { clearTimeout(watchdog); _refreshing = false; }
    }

    // evict one wallet's server-side caches (fills/funding/ledger) — the cure for a
    // body.wallets experiment or a removed wallet haunting capital/alert aggregates
    const cacheM = url.match(/^\/api\/v1\/cache\/(0x[0-9a-fA-F]{40})$/);
    if (cacheM) {
      if (req.method !== 'DELETE') return send(405, { error: 'method not allowed' });
      if (!authOk(req)) return send(401, { error: 'unauthorized' });
      const a = cacheM[1];
      let removed = 0;
      for (const file of [fillsFile(a), fundingFile(a), ledgerFile(a)]) {
        try { fs.unlinkSync(file); removed++; } catch (e) {}
      }
      _tradesMemo = null;
      return send(200, { ok: true, removed });
    }

    // everything below is GET + read scope
    if (req.method !== 'GET') return send(405, { error: 'method not allowed' });
    if (!readOk(req)) return send(401, { error: 'unauthorized' });

    try {
      if (url === '/api/v1/meta') {
        const d = readData();
        const snap = currentSnapshot();
        const market = readMarket();
        const wallets = snapWallets(snap).map(w => {
          const fc = readFillCache(w.address);
          return { address: w.address, label: w.label || '',
            fills: fc ? fc.count : 0, last: fc ? fc.last : null,
            cachedAt: fc ? fc.savedAt : null, truncated: fc ? !!fc.truncated : false };
        });
        let counts = null;
        if (engine.ok) {
          try {
            setEngineState(query);
            const { trades, builtAt } = ensureTrades();
            counts = { total: trades.length,
              perp: trades.filter(t => t.market === 'perp').length,
              spot: trades.filter(t => t.market === 'spot').length,
              open: trades.filter(t => t.isOpen).length, builtAt };
          } catch (e) {}
        }
        return send(200, {
          rev: (d && d.rev) || 0, updatedAt: (d && d.updatedAt) || null,
          engine: { ok: engine.ok, missing: engine.missing },
          wallets, trades: counts,
          market: market ? { fetchedAt: market.fetchedAt, positions: (market.positions || []).length,
            accountValue: market.accountValue, spotAccountValue: market.spotAccountValue, hlPnl: market.hlPnl } : null,
          settings: (() => { const s = Object.assign({}, S_DEFAULTS, snap.settings || {});
            return { beThreshold: s.beThreshold, rBasis: s.rBasis, riskDefault: s.riskDefault, tz: s.tz }; })(),
          refresh: { running: _refreshing, lastAt: _lastRefreshAt || null },
        });
      }

      // Flat monitoring numbers for dashboards (Grafana/Uptime-Kuma/Home Assistant).
      // JSON by default; ?format=prom emits Prometheus exposition text (numbers only).
      if (url === '/api/v1/metrics') {
        if (!engine.ok) throw { code: 503, msg: 'analytics engine unavailable' };
        const d = readData();
        const market = readMarket();
        const m = { updated_at: null, trades_total: null, open_trades: null, net_total: null,
          net_today: null, trades_today: null, current_drawdown: null,
          open_positions: market ? (market.positions || []).length : null,
          gross_exposure: null, net_exposure: null,
          account_value: market ? market.accountValue : null,
          spot_account_value: market ? market.spotAccountValue : null };
        if (d && d.updatedAt) { const t = Date.parse(d.updatedAt); if (isFinite(t)) m.updated_at = t; }
        if (market) {
          const rm = E.openRiskModel(market.positions || []);
          m.gross_exposure = rm ? rm.gross : 0;
          m.net_exposure = rm ? rm.skew : 0;
        }
        setEngineState({});
        const { trades } = ensureTrades();
        const closed = trades.filter(t => !t.isOpen && t.closeTime);
        m.trades_total = trades.length;
        m.open_trades = trades.filter(t => t.isOpen).length;
        m.net_total = +closed.reduce((s, t) => s + t.net, 0).toFixed(2);
        const todayKey = dayKeyN(Date.now());
        let tn = 0, tc = 0;
        for (const t of closed) if (dayKeyN(t.closeTime) === todayKey) { tn += t.net; tc++; }
        m.net_today = +tn.toFixed(2); m.trades_today = tc;
        const nets = [...closed].sort((a, b) => a.closeTime - b.closeTime).map(t => t.net);
        if (nets.length) m.current_drawdown = +E.currentDD(nets).dd.toFixed(2);
        if (query.format === 'prom') {
          let text = '';
          for (const k in m) if (m[k] != null && isFinite(m[k])) text += 'ledger_' + k + ' ' + m[k] + '\n';
          res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8', 'Cache-Control': 'no-store' });
          return res.end(text);
        }
        return send(200, m);
      }

      if (url === '/api/v1/trades') {
        const { all } = prepare(query);
        const sortKey = query.sort || 'openTime';
        const SORTS = ['openTime', 'closeTime', 'net', 'pnl', 'fees', 'durationMs', 'coin', 'maxSize'];
        if (!SORTS.includes(sortKey)) throw { code: 400, msg: 'sort must be one of ' + SORTS.join('|') };
        const dirn = query.order === 'asc' ? 1 : -1;
        const sorted = [...all].sort((a, b) => {
          const A = a[sortKey], B = b[sortKey];
          return (typeof A === 'string' ? A.localeCompare(B) : (A || 0) - (B || 0)) * dirn;
        });
        const limit = Math.min(1000, Math.max(1, Math.floor(qnum(query.limit, 100))));
        const offset = Math.max(0, Math.floor(qnum(query.offset, 0)));
        const page = sorted.slice(offset, offset + limit);
        return send(200, { total: sorted.length, offset, limit,
          trades: page.map(t => shapeTrade(t, query.events === '1')) });
      }

      const tradeM = url.match(/^\/api\/v1\/trades\/(.+)$/);
      if (tradeM) {
        setEngineState(query);
        const { trades } = ensureTrades();
        let id; try { id = decodeURIComponent(tradeM[1]); } catch (e) { throw { code: 400, msg: 'malformed percent-encoding in id' }; }
        const t = trades.find(x => x.id === id);
        if (!t) return send(404, { error: 'no trade with id ' + id });
        const closed = trades.filter(x => !x.isOpen);
        E._oneR = E.computeOneR(closed);   // 1R basis over the full closed set for a single lookup
        return send(200, shapeTrade(t, true));
      }

      if (url === '/api/v1/stats') {
        const { all, closed, settings } = prepare(query);
        const stats = E.computeStats(closed, all);
        return send(200, { n: closed.length, openN: all.length - closed.length,
          oneR: E._oneR, beThreshold: E._be, tz: settings.tz, stats });
      }

      if (url === '/api/v1/equity') {
        const { all, closed } = prepare(query);
        const chron = [...all].sort((a, b) => a.closeTime - b.closeTime);
        let cum = 0;
        const points = chron.map(t => { cum += t.net; return [t.closeTime, +cum.toFixed(6)]; });
        const nets = chron.map(t => t.net);
        const closedChron = [...closed].sort((a, b) => a.closeTime - b.closeTime);
        // deterministic seeded shuffle-DD, same seeding idiom as the app's diagnostics tabs
        let shuffleDD = null;
        if (nets.length >= 2) {
          E._srand(E._hashSeed('api-equity|' + nets.length + '|' + (chron.length ? chron[0].id + '|' + chron[chron.length - 1].id : '')));
          shuffleDD = E.mcMaxDD(nets, 2000);
        }
        return send(200, {
          points,
          daily: E.dailySeriesCalendar(all),
          currentDD: nets.length ? E.currentDD(nets) : null,
          underwater: closedChron.length ? E.underwaterStats(closedChron) : null,
          shuffleDD,
        });
      }

      if (url === '/api/v1/calendar') {
        const { all, settings } = prepare(query);
        const days = {};
        for (const t of all) { const k = dayKeyN(t.closeTime); days[k] = +(((days[k] || 0) + t.net)).toFixed(6); }
        return send(200, { tz: settings.tz, days });
      }

      if (url === '/api/v1/breakdown') {
        const { closed } = prepare(query);
        const by = String(query.by || 'coin').toLowerCase();
        const basis = String(query.basis || 'usd').toLowerCase() === 'pct' ? 'pct' : 'usd';
        const top = Math.max(1, Math.min(50, Math.floor(qnum(query.top, 5))));
        const keyFn = {
          coin: t => t.symbol || t.coin, dir: t => t.dir, market: t => t.market,
          wallet: t => (t.wallet && (t.wallet.label || t.wallet.address)) || '?',
          dow: t => String(E.tzParts(t.closeTime).dow),
          hour: t => String(E.tzParts(t.closeTime).h),
          tag: null,
        }[by];
        if (keyFn === undefined) throw { code: 400, msg: 'by must be coin|dir|market|wallet|tag|dow|hour' };
        const groups = {};
        const push = (k, t) => (groups[k] = groups[k] || []).push(t);
        for (const t of closed) {
          if (by === 'tag') {
            const tags = ((E.journal[t.id] || {}).tags) || [];
            if (!tags.length) push('(untagged)', t); else tags.forEach(tg => push(tg, t));
          } else push(keyFn(t), t);
        }
        const out = Object.entries(groups).map(([key, ts]) => {
          const s = E.computeStats(ts, ts);
          const rets = ts.map(t => E.retPct(t)).filter(r => r !== null);
          const sumRet = rets.reduce((a, r) => a + r, 0);
          return { key, n: s.n, net: s.net, fees: s.fees, winRate: s.winRate,
            profitFactor: s.profitFactor === Infinity ? null : s.profitFactor,
            expectancy: s.expectancy, avgR: s.avgR, avgHold: s.avgHold, maxDD: s.maxDD,
            sumRet, meanRet: rets.length ? sumRet / rets.length : null,
            v: basis === 'pct' ? sumRet : s.net };
        }).sort((a, b) => b.net - a.net);
        // Contribution shares, mirroring assetContribution() in ledger.html. The primary
        // denominator is the summed contribution of the groups on the SAME side, so shares total
        // exactly 1 within a side and "these five produced 84% of the profit" is literally true.
        // shareNet divides by the bottom line instead: the honest answer to "how much of my result
        // is this", but winners and losers offset, so it can exceed 1 or go negative and is flagged
        // via netMeaningful when the net is small next to the gross sides.
        // by=tag is NOT a partition (a two-tag trade is counted twice), so partition=false warns
        // consumers that the side totals are inflated by double-counting.
        const pos = out.reduce((a, r) => a + (r.v > 0 ? r.v : 0), 0);
        const neg = out.reduce((a, r) => a + (r.v < 0 ? -r.v : 0), 0);
        const total = out.reduce((a, r) => a + r.v, 0);
        for (const r of out) {
          const d = r.v > 0 ? pos : neg;
          r.share = d > 0 ? Math.abs(r.v) / d : 0;
          r.shareNet = total !== 0 ? r.v / Math.abs(total) : null;
        }
        const ranked = [...out].sort((a, b) => b.v - a.v || String(a.key).localeCompare(String(b.key)));
        const best = ranked.filter(r => r.v > 0).slice(0, top);
        const worst = ranked.filter(r => r.v < 0).slice(-top).reverse();
        // netMeaningful gates shareNet on both the cause (net small vs gross) and the symptom
        // (any single group's share of net being absurd). At 5% of gross a group can report
        // "704% of net" — correct, useless. Mirrors assetContribution() in ledger.html.
        const maxNetShare = Math.max(0, ...out.map(r => r.shareNet == null ? 0 : Math.abs(r.shareNet)));
        const contribution = {
          basis, top, pos, neg, total, maxNetShare,
          netMeaningful: (pos + neg) > 0 && Math.abs(total) >= 0.1 * (pos + neg) && maxNetShare <= 3,
          partition: by !== 'tag',
          groups: out.length,
          others: Math.max(0, out.length - best.length - worst.length),
          bestShare: pos > 0 ? best.reduce((a, r) => a + r.v, 0) / pos : 0,
          worstShare: neg > 0 ? worst.reduce((a, r) => a - r.v, 0) / neg : 0,
          best: best.map(r => r.key), worst: worst.map(r => r.key),
        };
        return send(200, { by, basis, groups: basis === 'pct' ? ranked : out, contribution });
      }

      if (url === '/api/v1/projection') {
        const { all } = prepare(query);
        const lookback = Math.max(0, Math.floor(qnum(query.lookback, 0)));
        const horizon = Math.max(1, Math.min(3650, Math.floor(qnum(query.horizon, qnum(query.days, 90)))));
        const paths = Math.max(50, Math.min(2000, Math.floor(qnum(query.paths, 400))));
        const block = Math.max(0, Math.floor(qnum(query.block, 0)));
        const seed = query.seed != null && query.seed !== '' && query.seed !== 'auto' ? (parseInt(query.seed, 10) >>> 0) : null;
        const base = E.projBaseline(all, lookback);
        if (!base) return send(200, { baseline: null, projection: null, note: 'no closed trades in the selected window' });
        const projection = E.projectForward(base.daily, horizon, paths, seed, block);
        const { daily, ...baseline } = base;
        return send(200, {
          horizon, paths, block: projection ? projection.block : block, seed: seed != null ? seed : 'auto',
          baseline: query.daily === '1' ? base : baseline,
          projection,
          milestones: E.projMilestones(base.total, 4),
        });
      }

      if (url === '/api/v1/kelly') {
        const { closed } = prepare(query);
        return send(200, { n: closed.length, kelly: E.kellyFromTrades(closed) });
      }

      if (url === '/api/v1/capital') {
        setEngineState(query);
        // capital is account-wide: all closed trades, no view/period filters (wallet= narrows
        // both the flows and the trades to one address, which stays internally consistent)
        const { trades } = ensureTrades();
        const snap = currentSnapshot();
        // SAME union rule as ensureTrades: saved wallets ∪ anything holding a ledger cache.
        // body.wallets refreshes write ledger caches for non-saved wallets too — reading
        // flows from saved wallets only counted those wallets' trades against a capital
        // base missing their deposits.
        const savedSet = new Set(snapWallets(snap).map(w => w.address.toLowerCase()));
        let wallets = snapWallets(snap).slice();
        let hasNonSaved = false;
        try {
          for (const f of fs.readdirSync(ledgerDir)) {
            const a = f.replace(/\.json\.gz$/, '');
            if (ADDR_RE.test(a) && !wallets.find(w => w.address.toLowerCase() === a)) { wallets.push({ address: a, label: '' }); hasNonSaved = true; }
          }
        } catch (e) {}
        if (query.wallet) {
          if (!ADDR_RE.test(query.wallet)) throw { code: 400, msg: 'invalid wallet address' };
          wallets = [{ address: query.wallet }];
        }
        let flows = [], skipped = 0, cachedAt = null;
        for (const w of wallets) {
          const lc = readLedgerCache(w.address);
          if (!lc) continue;
          if (cachedAt == null || lc.savedAt < cachedAt) cachedAt = lc.savedAt;
          const cf = E.capitalFlows(lc.rows, w.address);
          for (const f of cf.flows) flows.push({ ...f, wallet: w.address });
          skipped += cf.skipped;
        }
        if (!flows.length) return send(409, { error: 'no capital-flow caches yet — POST /api/v1/refresh first' });
        flows.sort((a, b) => a.time - b.time);
        const wset = new Set(wallets.map(w => w.address.toLowerCase()));
        const closedAll = trades.filter(t => !t.isOpen && t.closeTime
          && (!query.wallet || (t.wallet && wset.has(t.wallet.address.toLowerCase()))));
        const market = readMarket();
        // Equity-based outputs (impliedPnl, xirr) need equity and flows to cover the SAME
        // wallet set. market equity reflects the last refresh's saved wallets, so it is
        // withheld when wallet= narrows the flows OR when non-saved cached wallets (from
        // body.wallets refreshes) contribute flows the equity can't see. DELETE
        // /api/v1/cache/:addr evicts a stale wallet's caches to restore the full picture.
        const equityNow = !query.wallet && !hasNonSaved && market && (market.accountValue != null || market.spotAccountValue != null)
          ? (market.accountValue || 0) + (market.spotAccountValue || 0) : null;
        return send(200, { flows: flows.length, skipped, cachedAt,
          ...(hasNonSaved ? { note: 'non-saved cached wallets contribute flows; equity-based outputs withheld — evict stale caches via DELETE /api/v1/cache/:addr' } : {}),
          model: E.capitalModel(flows, closedAll, equityNow),
          xirr: E.xirrFromFlows(flows, equityNow) }); // money-weighted annual return; null without matching live equity
      }


      if (url === '/api/v1/walkforward') {
        const { closed } = prepare(query);
        const opts = {};
        const tr = parseInt(query.train, 10); if (Number.isFinite(tr) && tr > 0) opts.train = tr;
        const st = parseInt(query.step, 10);  if (Number.isFinite(st) && st > 0) opts.step = st;
        // seed the shared PRNG so the bootstrap CI is reproducible per identical request
        const seed = query.seed != null && query.seed !== '' && query.seed !== 'auto'
          ? (parseInt(query.seed, 10) >>> 0) : E._hashSeed('wf:' + closed.length);
        E._srand(seed);
        const wf = E.walkForward(closed, opts);
        if (!wf) return send(200, { walkforward: null, note: 'need ≥20 closed trades (and ≥ train+step) in the selected view' });
        return send(200, { seed, walkforward: wf });
      }

      if (url === '/api/v1/risk') {
        setEngineState(query);
        if (!engine.ok) throw { code: 503, msg: 'analytics engine unavailable' };
        const market = readMarket();
        if (!market) return send(409, { error: 'no market snapshot yet — POST /api/v1/refresh first' });
        const risk = E.openRiskModel(market.positions || []);
        return send(200, { fetchedAt: market.fetchedAt, accountValue: market.accountValue,
          risk, concentration: risk ? E.riskConcentration(risk) : null });
      }

      if (url === '/api/v1/positions') {
        setEngineState(query);
        if (!engine.ok) throw { code: 503, msg: 'analytics engine unavailable' };
        if (query.live === '1') {
          if (!authOk(req)) return send(401, { error: 'live refetch requires the full token' });
          const snap = currentSnapshot();
          const wallets = snapWallets(snap);
          if (!wallets.length) return send(400, { error: 'no wallets saved in the app' });
          let positions = [], accVals = [];
          for (const w of wallets) {
            const fc = readFillCache(w.address);
            const hip3 = fc ? E.hip3DexsFromFills(fc.fills) : [];
            const ch = await fetchPositionsSrv(w.address, hip3);
            ch.positions.forEach(p => p.wallet = { address: w.address, label: w.label || '' });
            positions = positions.concat(ch.positions);
            if (ch.accountValue != null) accVals.push(ch.accountValue);
          }
          return send(200, { live: true, fetchedAt: Date.now(), positions,
            accountValue: accVals.length ? accVals.reduce((a, b) => a + b, 0) : null });
        }
        const market = readMarket();
        if (!market) return send(409, { error: 'no market snapshot yet — POST /api/v1/refresh first' });
        return send(200, { live: false, fetchedAt: market.fetchedAt,
          positions: market.positions || [], accountValue: market.accountValue,
          spotHoldings: market.spotHoldings || [], spotAccountValue: market.spotAccountValue,
          hlPnl: market.hlPnl || { all: null, perp: null } });
      }

      if (url === '/api/v1/spot/lots') {
        setEngineState(query);
        if (!engine.ok) throw { code: 503, msg: 'analytics engine unavailable' };
        const market = readMarket();
        const nameByCoin = (market && market.spotMaps && market.spotMaps.nameByCoin) || {};
        const snap = currentSnapshot();
        let wallets = snapWallets(snap);
        if (query.wallet) {
          if (!ADDR_RE.test(query.wallet)) throw { code: 400, msg: 'invalid wallet address' };
          wallets = [{ address: query.wallet }];
        }
        // FIFO runs per wallet, exactly like the app's Spot-lots export: pooling wallets let one
        // wallet's sale consume another wallet's cheaper lot, so the API and the CSV disagreed.
        const merge = (a, b) => { // rows/open concat, per-year totals and counts summed
          if (Array.isArray(a) && Array.isArray(b)) return a.concat(b);
          if (typeof a === 'number' && typeof b === 'number') return a + b;
          if (a && b && typeof a === 'object' && typeof b === 'object') {
            const o = { ...a }; for (const k in b) o[k] = k in o ? merge(o[k], b[k]) : b[k]; return o; }
          return b === undefined ? a : b;
        };
        let lots = null, n = 0;
        for (const w of wallets) {
          const fc = readFillCache(w.address); if (!fc) continue;
          const sf = fc.fills.filter(f => !E.isPerp(f.coin)).sort((a, b) => a.time - b.time);
          if (!sf.length) continue;
          n += sf.length;
          const L = E.spotFifoLots(sf, nameByCoin);
          for (const r of (L.rows || [])) r.wallet = w.address;
          for (const r of (L.open || [])) r.wallet = w.address;
          lots = lots ? merge(lots, L) : L;
        }
        return send(200, { fills: n, lots: lots || E.spotFifoLots([], nameByCoin) });
      }

      if (url === '/api/v1/whatif') {
        const { closed } = prepare(query);
        const pred = predFromQuery(query);
        const model = E.whatIfModel(closed, pred);
        return send(200, { rule: { field: query.field, op: query.op || 'eq', value: query.value }, model });
      }

      if (url === '/api/v1/digests') {
        let files = [];
        try { files = fs.readdirSync(reportsDir).filter(f => /^weekly-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort().reverse(); } catch (e) {}
        return send(200, { digests: files.map(f => f.slice(7, 17)) });
      }
      const digM = url.match(/^\/api\/v1\/digests\/(\d{4}-\d{2}-\d{2})$/);
      if (digM) {
        try { return send(200, JSON.parse(fs.readFileSync(path.join(reportsDir, 'weekly-' + digM[1] + '.json'), 'utf8'))); }
        catch (e) { return send(404, { error: 'no digest for week ' + digM[1] }); }
      }

      if (url === '/api/v1/journal') {
        const snap = currentSnapshot();
        return send(200, { journal: snap.journal || {} });
      }
      const jM = url.match(/^\/api\/v1\/journal\/(.+)$/);
      if (jM) {
        const snap = currentSnapshot();
        let id; try { id = decodeURIComponent(jM[1]); } catch (e) { throw { code: 400, msg: 'malformed percent-encoding in id' }; }
        const e = (snap.journal || {})[id];
        return e ? send(200, { id, entry: e }) : send(404, { error: 'no journal entry for ' + id });
      }
      if (url === '/api/v1/tags') {
        const snap = currentSnapshot();
        const counts = {};
        Object.values(snap.journal || {}).forEach(j => (j.tags || []).forEach(t => counts[t] = (counts[t] || 0) + 1));
        return send(200, { tags: Object.entries(counts).map(([tag, n]) => ({ tag, n })).sort((a, b) => b.n - a.n || a.tag.localeCompare(b.tag)) });
      }

      if (url === '/api/v1/export/trades.csv') {
        const { all } = prepare(query);
        const cols = ['id', 'wallet', 'label', 'market', 'coin', 'symbol', 'dir', 'isOpen',
          'openTime', 'openISO', 'closeTime', 'closeISO', 'durationMs', 'maxSize', 'avgEntry', 'avgExit',
          'pnl', 'fees', 'funding', 'net', 'r', 'retPct', 'fills', 'liquidated', 'tags', 'notes'];
        const rows = [cols.join(',')];
        for (const t of [...all].sort((a, b) => a.closeTime - b.closeTime)) {
          const j = E.journal[t.id] || {};
          rows.push([t.id, t.wallet && t.wallet.address, t.wallet && t.wallet.label, t.market, t.coin,
            t.symbol || '', t.dir, t.isOpen ? 1 : 0,
            t.openTime, new Date(t.openTime).toISOString(), t.closeTime, new Date(t.closeTime).toISOString(),
            t.durationMs, t.maxSize, t.avgEntry, t.avgExit, t.pnl, t.fees, t.funding || 0, t.net,
            E.rFor(t), E.retPct(t), t.fills, t.liquidated ? 1 : 0,
            (j.tags || []).join(';'), j.notes || ''].map(csvCell).join(','));
        }
        res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': 'attachment; filename="ledger-trades.csv"',
          'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        return res.end(rows.join('\r\n'));
      }

      return send(404, { error: 'not found — GET /api/v1 lists all endpoints' });
    } catch (e) { return fail(e); }
  }

  const readBody = (req, max = MAX_BODY) => new Promise((resolve, reject) => {
    let size = 0, tooBig = false; const chunks = [];
    req.on('data', c => { size += c.length;
      // stop buffering but keep reading, so the 413 can still be written back
      if (size > max) { if (!tooBig) { tooBig = true; chunks.length = 0; reject(new Error('payload too large')); } return; }
      chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });

  // Social layer for Pulse (leagues, competitions, following) and the owner's admin API.
  // Verified Discipline for social members: their last 50 days of public fills (cached per address,
  // fetched incrementally), rebuilt into trades and scored by the app's own pzBehaviorDays.
  const socialFillsDir = path.join(dataDir, 'social-fills');
  fs.mkdirSync(socialFillsDir, { recursive: true });
  // one fetch per address at a time (two members naming the same wallet share it)
  const behaviorInflight = new Map();
  const zoneDay = (tz) => { let f; try { f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }); }
    catch (e) { f = new Intl.DateTimeFormat('en-CA', { timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }); }
    return ms => f.format(ms); };
  const behaviorFor = (addr, tz) => {
    const k = String(addr).toLowerCase() + '|' + (tz || 'UTC');
    if (!behaviorInflight.has(k)) behaviorInflight.set(k, behaviorForOnce(addr, tz).finally(() => behaviorInflight.delete(k)));
    return behaviorInflight.get(k);
  };
  const behaviorForOnce = async (addr, tz) => {
    if (!engine.ok || !E.pzBehaviorDays) return null;
    const a = String(addr).toLowerCase(); if (!/^0x[0-9a-f]{40}$/.test(a)) return null;
    const f = path.join(socialFillsDir, a + '.json.gz'), since = (opts.now || Date.now)() - 50 * 86400000;
    const c = gzRead(f), have = c && c.v === 1 && Array.isArray(c.fills) ? c.fills : [];
    // the cache is saved sorted, so its last fill is the newest (no spread over huge arrays)
    const from = have.length ? Math.max(since, have[have.length - 1].time + 1) : since;
    const r = await E.fetchAllFills(a, from);
    const seen = new Set(), fills = [];
    for (const x of have.concat(r.fills || [])) { if (!x || x.time < since) continue; const k = x.tid + ':' + x.time; if (seen.has(k)) continue; seen.add(k); fills.push(x); }
    fills.sort((x, y) => x.time - y.time);
    gzWrite(f, { v: 1, fills, savedAt: Date.now() });
    // attributeFunding sets each trade's net (P&L − fees); funding rows aren't fetched here — they
    // barely move one trade's result and never decide whether it was a loss by more than $1
    const trades = [...E.attributeFunding(E.reconstructTrades(fills, a, 'perp'), []), ...E.attributeFunding(E.reconstructTrades(fills, a, 'spot'), [])];
    const closed = trades.filter(t => !t.isOpen && t.closeTime);
    // days on the member's own clock (the zone their app reports), so both sides score the same days
    return E.pzBehaviorDays(closed, { dayOf: zoneDay(tz || 'UTC'), isLoss: n => n < -1 /* same fixed rule as the app's PZ_LOSS */ })
      .map(d => ({ k: d.key, s: d.score, n: d.n }));
  };
  const forgetAddress = (addr) => { try { fs.unlinkSync(path.join(socialFillsDir, String(addr).toLowerCase() + '.json.gz')); } catch (e) {} };
  // Wallet sign-in messages name the site the member signs for. Pin it (PUBLIC_ORIGIN, comma-separated)
  // so a look-alike site can't get a message for its own domain. Behind Railway's edge the Host header
  // can only be one of the service's own domains (custom ones included), so it's trusted there unpinned.
  const publicOrigins = (opts.publicOrigins !== undefined ? opts.publicOrigins : String(process.env.PUBLIC_ORIGIN || '').split(','))
    .map(x => String(x).trim()).filter(Boolean);
  const hostVetted = opts.hostVetted !== undefined ? !!opts.hostVetted : !!(process.env.RAILWAY_ENVIRONMENT_NAME || process.env.RAILWAY_ENVIRONMENT);
  // Behind a proxy (Railway), rate limits need the client's address, not the proxy's: the last
  // X-Forwarded-For entry is the one the proxy added. TRUST_PROXY=1 turns this on elsewhere.
  const trustProxy = opts.trustProxy !== undefined ? !!opts.trustProxy
    : process.env.TRUST_PROXY ? /^(1|on|true|yes)$/i.test(process.env.TRUST_PROXY) : !!(process.env.RAILWAY_ENVIRONMENT_NAME || process.env.RAILWAY_ENVIRONMENT);
  const clientIp = req => { const xf = trustProxy && req.headers['x-forwarded-for'];
    if (xf) { const last = String(xf).split(',').map(x => x.trim()).filter(Boolean).pop(); if (last) return last.slice(0, 64); }
    return (req.socket && req.socket.remoteAddress) || ''; };
  const social = createSocial({ dataDir, json, authOk, adminConfigured: !!auth, fetchImpl: opts.fetchImpl, now: opts.now,
    behaviorFor, verifyAvailable: engine.ok, forgetAddress, publicOrigins, hostVetted, clientIp, coachAvailable: coachCfg.enabled });

  const server = http.createServer((req, res) => {
    const [url, qs] = (req.url || '/').split('?');
    const query = Object.fromEntries(new URLSearchParams(qs || ''));

    // Optional CORS for /api/* — exact-origin, opt-in via CORS_ORIGIN, off by default.
    if (corsOrigin && url.startsWith('/api/')) {
      res.setHeader('Access-Control-Allow-Origin', corsOrigin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-Pulse-Key');
      res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, POST, DELETE, OPTIONS');
      if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    }

    // --- static: the app itself ---
    // /pulse is the same app opened in its simple dial view (the page switches on its own path);
    // /pulse/ redirects so the page's relative links (help, sw.js, api/v1) resolve from the root.
    if (req.method === 'GET' && url === '/pulse/') {
      res.writeHead(302, { Location: '/pulse' + (qs ? '?' + qs : '') });
      return res.end();
    }
    if (req.method === 'GET' && (url === '/' || url === '/index.html' || url === '/ledger.html' || url === '/pulse')) {
      fs.readFile(htmlPath, (err, buf) => {
        if (err) return json(res, 500, { error: 'app HTML not found on server' });
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-cache',
          'X-Content-Type-Options': 'nosniff',
          'Referrer-Policy': 'no-referrer',
        });
        res.end(buf);
      });
      return;
    }

    // --- built-in documentation: /help (user guide) and /docs (technical reference).
    // No auth: pure documentation, no user data. Served from files next to server.js so
    // they redeploy with the app and stay in step with it.
    const docFile = req.method === 'GET' && (url === '/help' || url === '/help.html') ? 'help.html'
      : req.method === 'GET' && (url === '/docs' || url === '/tech.html') ? 'tech.html' : null;
    if (docFile) {
      fs.readFile(path.join(__dirname, docFile), (err, buf) => {
        if (err) return json(res, 404, { error: docFile + ' not deployed alongside server.js' });
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Cache-Control': 'no-cache',
          'X-Content-Type-Options': 'nosniff',
          'Referrer-Policy': 'no-referrer',
        });
        res.end(buf);
      });
      return;
    }

    // --- PWA assets (tiny, inline — no extra files to deploy) ---
    if (req.method === 'GET' && url === '/sw.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-cache' });
      // network-first for the app shell so updates land immediately; cached copy = offline fallback.
      // API and exchange calls are never intercepted.
      return res.end(
        // Only the app shell is cached: '/' and '/pulse' serve the same file, so either one
        // refreshes the copy; other pages (help, docs) pass through and never overwrite it.
        "const C='ledger-v2',S=['/','/index.html','/ledger.html','/pulse'];" +
        "self.addEventListener('install',e=>{self.skipWaiting();e.waitUntil(caches.open(C).then(c=>c.add('/')))});" +
        "self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(x=>x!==C).map(x=>caches.delete(x)))).then(()=>clients.claim()))});" +
        "self.addEventListener('fetch',e=>{const u=new URL(e.request.url);" +
        "if(u.origin!==location.origin||u.pathname.startsWith('/api/')||e.request.method!=='GET')return;" +
        "if(S.includes(u.pathname)){e.respondWith(" +
        "fetch(e.request).then(r=>{if(r.ok){const cp=r.clone();caches.open(C).then(c=>c.put('/',cp));}return r;})" +
        ".catch(()=>caches.match('/')));}});");
    }
    if (req.method === 'GET' && url === '/manifest.webmanifest') {
      res.writeHead(200, { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'no-cache' });
      return res.end(JSON.stringify({ name: 'Ledger', short_name: 'Ledger',
        start_url: '/', display: 'standalone', background_color: '#0c0e14', theme_color: '#0c0e14',
        icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }] }));
    }
    if (req.method === 'GET' && url === '/pulse.webmanifest') {
      res.writeHead(200, { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'no-cache' });
      return res.end(JSON.stringify({ id: '/pulse', name: 'Pulse — Ledger', short_name: 'Pulse',
        description: 'Readiness, discipline and risk for your trading day.',
        start_url: '/pulse', scope: '/', display: 'standalone', background_color: '#0A0C0F', theme_color: '#0A0C0F',
        icons: [{ src: '/pulse-icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }] }));
    }
    if (req.method === 'GET' && url === '/pulse-icon.svg') {
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'max-age=86400' });
      return res.end('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 180 180">'
        + '<rect width="180" height="180" rx="38" fill="#0A0C0F"/>'
        + '<circle cx="90" cy="90" r="52" fill="none" stroke="#232830" stroke-width="18"/>'
        + '<path d="M90 38a52 52 0 1 1-49.5 36" fill="none" stroke="#3FE0A0" stroke-width="18" stroke-linecap="round"/></svg>');
    }
    if (req.method === 'GET' && url === '/icon.svg') {
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'max-age=86400' });
      return res.end('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">'
        + '<rect width="100" height="100" rx="18" fill="#0c0e14"/>'
        + '<path d="M20 72 L38 50 L52 60 L80 28" stroke="#8b93ff" stroke-width="7" fill="none" stroke-linecap="round" stroke-linejoin="round"/>'
        + '<circle cx="80" cy="28" r="6" fill="#2fd08c"/></svg>');
    }

    // --- social (/api/social/*): members authenticate with their own key, admin with AUTH_TOKEN ---
    if (url === '/api/social' || url.startsWith('/api/social/')) {
      social.handle(req, res, url, query).catch(e => {
        try { json(res, 500, { error: 'internal error: ' + (e && e.message || e) }); } catch (e2) {}
      });
      return;
    }
    // --- the owner's admin panel (a static page; every action it takes needs AUTH_TOKEN) ---
    if (req.method === 'GET' && (url === '/admin' || url === '/admin.html')) {
      fs.readFile(path.join(__dirname, 'admin.html'), (err, buf) => {
        if (err) return json(res, 404, { error: 'admin.html not deployed alongside server.js' });
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache',
          'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' });
        res.end(buf);
      });
      return;
    }

    // --- a member's public badge page: /b/<name> (the page reads /api/social/public/<name>) ---
    const bM = req.method === 'GET' && url.match(/^\/b\/([A-Za-z0-9_]{3,20})$/);
    if (bM) {
      fs.readFile(path.join(__dirname, 'badges.html'), 'utf8', (err, page) => {
        if (err) return json(res, 404, { error: 'badges.html not deployed alongside server.js' });
        // the name goes into the title and link-preview tags; it's [A-Za-z0-9_] by the route, so no escaping is needed
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache',
          'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' });
        res.end(page.split('__HANDLE__').join(bM[1]));
      });
      return;
    }

    // --- health: unauthenticated so the client can detect the server and whether auth is on ---
    if (req.method === 'GET' && url === '/api/health') {
      return json(res, 200, { ok: true, auth: !!auth, appSyncCapable });
    }

    // --- analytics API v1 (read-only) ---
    if (url === '/api/v1' || url.startsWith('/api/v1/')) {
      handleV1(req, res, url, query).catch(e => {
        try { json(res, 500, { error: 'internal error: ' + (e && e.message || e) }); } catch (e2) {}
      });
      return;
    }

    // --- snapshot history: list rotating daily snapshots, fetch one by date (auth) ---
    if (url === '/api/snapshots') {
      if (!authOk(req)) return json(res, 401, { error: 'unauthorized' });
      if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });
      return json(res, 200, { snapshots: listSnapshots() });
    }
    const snapM = url.match(/^\/api\/snapshots\/(\d{4}-\d{2}-\d{2})$/);
    if (snapM) {
      if (!authOk(req)) return json(res, 401, { error: 'unauthorized' });
      if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });
      try {
        const d = JSON.parse(fs.readFileSync(path.join(snapDir, snapM[1] + '.json'), 'utf8'));
        return json(res, 200, d);
      } catch (e) { return json(res, 404, { error: 'no snapshot for ' + snapM[1] }); }
    }

    // --- server-held full backups: the client's "Backup all" JSON, gzipped, newest 10 kept ---
    // Daily snapshots only cover the synced blob; this captures everything exportable
    // (fill caches, attachments metadata, candles — whatever the client bundles) on demand.
    if (url === '/api/backup') {
      if (!authOk(req)) return json(res, 401, { error: 'unauthorized' });
      if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
      let size = 0; const chunks = []; let aborted = false;
      req.on('data', (c) => { size += c.length;
        if (size > MAX_BODY) { aborted = true; json(res, 413, { error: 'payload too large' }); req.destroy(); return; }
        chunks.push(c); });
      req.on('end', () => {
        if (aborted) return;
        let body;
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch (e) { return json(res, 400, { error: 'invalid JSON' }); }
        // shape check keeps a stray POST from burning the retained slots
        if (!body || typeof body !== 'object' || body.app !== 'ledger')
          return json(res, 400, { error: "expected the app's backup JSON (app:'ledger')" });
        const name = 'backup-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json.gz';
        try { gzWrite(path.join(backupsDir, name), body); }
        catch (e) { return json(res, 500, { error: 'write failed: ' + e.message }); }
        try {
          const files = fs.readdirSync(backupsDir).filter(f => BACKUP_RE.test(f)).sort();
          while (files.length > BACKUP_KEEP) fs.unlinkSync(path.join(backupsDir, files.shift()));
        } catch (e) {}
        return json(res, 200, { ok: true, name });
      });
      return;
    }
    if (url === '/api/backups') {
      if (!authOk(req)) return json(res, 401, { error: 'unauthorized' });
      if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });
      let out = [];
      try {
        out = fs.readdirSync(backupsDir).filter(f => BACKUP_RE.test(f)).sort().reverse()
          .map(f => { const st = fs.statSync(path.join(backupsDir, f));
            return { name: f, bytes: st.size, savedAt: st.mtimeMs }; });
      } catch (e) {}
      return json(res, 200, { backups: out });
    }
    // --- coach's weekly letter (opt-in AI): everything here needs the full token ---
    if (url === '/api/coach/status') {
      if (!authOk(req)) return json(res, 401, { error: 'unauthorized' });
      return json(res, 200, { enabled: !!coachCfg.enabled, model: coachCfg.enabled ? coachCfg.model : null,
        share: !!(telegramCfg.token && telegramCfg.shareChats.length) });
    }
    // --- share a weekly card's text with an accountability partner (TELEGRAM_SHARE_CHAT_ID) ---
    if (url === '/api/share') {
      if (!authOk(req)) return json(res, 401, { error: 'unauthorized' });
      if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
      if (!(telegramCfg.token && telegramCfg.shareChats.length)) return json(res, 404, { error: 'sharing is off (set TELEGRAM_BOT_TOKEN and TELEGRAM_SHARE_CHAT_ID)' });
      (async () => {
        let body; try { body = JSON.parse(await readBody(req)); } catch (e) { return json(res, 400, { error: 'invalid JSON' }); }
        const text = body && typeof body.text === 'string' ? body.text.trim().slice(0, 1500) : '';
        if (!text) return json(res, 400, { error: 'expected {text}' });
        try { const sent = await tgBroadcast(text, telegramCfg.shareChats); return json(res, 200, { ok: true, sent }); }
        catch (e) { return json(res, 502, { error: 'telegram: ' + ((e && e.message) || 'send failed') }); }
      })();
      return;
    }
    // --- AI coach chat: a member (X-Pulse-Key) within today's allowance, or the owner (AUTH_TOKEN) ---
    if (url === '/api/coach/chat') {
      const memberAsk = !!req.headers['x-pulse-key'];
      const st = memberAsk ? social.coach.statusFor(req) : authOk(req) && auth ? social.coach.ownerStatus() : null;
      if (!st) return json(res, 401, { error: memberAsk ? 'not a member' : 'unauthorized' });
      const pub = { enabled: coachCfg.enabled, allowed: st.allowed, reason: st.reason, limit: st.limit, used: st.used, remaining: st.remaining,
        detail: st.detail, detailAllowed: st.detailAllowed, who: st.who };
      if (req.method === 'GET') return json(res, 200, pub);
      if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
      if (!coachCfg.enabled) return json(res, 404, { error: 'The AI coach isn’t switched on for this server yet. The owner turns it on with COACH_AI=1 and an Anthropic API key.' });
      if (!st.allowed) return json(res, 429, Object.assign(pub, { error: st.reason }));
      (async () => {
        let body; try { body = JSON.parse(await readBody(req, 256 * 1024)); } catch (e) { return json(res, e.message === 'payload too large' ? 413 : 400, { error: e.message === 'payload too large' ? 'That’s too much to send at once.' : 'invalid JSON' }); }
        const chat = sanitizeCoachChat(body, st.detail);
        if (chat.error) return json(res, 400, { error: chat.error });
        // check and reserve in one step, after the body arrived: requests sent in parallel can't all pass
        const now = memberAsk ? social.coach.statusFor(req) : social.coach.ownerStatus();
        if (!now || !now.allowed) return json(res, 429, { error: (now && now.reason) || 'not allowed' });
        const who = now.who === 'member' ? now.member : null;
        social.coach.count(who, 1);
        try {
          const r = await coachChat(chat);
          const after = memberAsk ? social.coach.statusFor(req) : social.coach.ownerStatus();
          return json(res, 200, { text: r.text, remaining: after.remaining, limit: after.limit, used: after.used });
        } catch (e) { social.coach.count(who, -1); return json(res, e.code || 500, { error: e.msg || e.message || String(e) }); } // only answered messages count
      })();
      return;
    }
    const letM = url.match(/^\/api\/coach\/letter\/(\d{4}-W\d{2})$/);
    if (letM) {
      if (!authOk(req)) return json(res, 401, { error: 'unauthorized' });
      const file = path.join(reportsDir, 'letter-' + letM[1] + '.json');
      if (req.method === 'GET') {
        try { return json(res, 200, JSON.parse(fs.readFileSync(file, 'utf8'))); }
        catch (e) { return json(res, 404, { error: 'no letter for ' + letM[1] }); }
      }
      if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' });
      if (!coachCfg.enabled) return json(res, 404, { error: 'the AI coach letter is off (set COACH_AI=1 on the server)' });
      (async () => {
        let body;
        try { body = JSON.parse(await readBody(req)); } catch (e) { return json(res, 400, { error: 'invalid JSON' }); }
        const facts = sanitizeCoachFacts(body && body.facts);
        if (!facts) return json(res, 400, { error: 'expected {facts: {...}} (aggregate summary, under 12KB)' });
        facts.week = letM[1];
        try {
          const w = await writeCoachLetter(facts);
          const rec = { week: letM[1], text: w.text, model: w.model, writtenAt: Date.now() };
          try { const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(rec, null, 2)); fs.renameSync(tmp, file); } catch (e) {}
          return json(res, 200, rec);
        } catch (e) { return json(res, e.code || 500, { error: e.msg || e.message || String(e) }); }
      })();
      return;
    }
    const bkM = url.match(/^\/api\/backups\/(backup-[A-Za-z0-9-]+\.json\.gz)$/);
    if (bkM) {
      if (!authOk(req)) return json(res, 401, { error: 'unauthorized' });
      if (req.method !== 'GET') return json(res, 405, { error: 'method not allowed' });
      const obj = gzRead(path.join(backupsDir, bkM[1]));
      if (!obj) return json(res, 404, { error: 'no such backup' });
      return json(res, 200, obj);
    }

    if (url === '/api/data') {
      if (!authOk(req)) return json(res, 401, { error: 'unauthorized' });

      if (req.method === 'GET') {
        const d = readData();
        return json(res, 200, { rev: (d && d.rev) || 0, snapshot: (d && d.snapshot) || null });
      }

      if (req.method === 'PUT') {
        let size = 0; const chunks = [];
        let aborted = false;
        req.on('data', (c) => {
          size += c.length;
          if (size > MAX_BODY) {
            aborted = true;
            json(res, 413, { error: 'payload too large' });
            req.destroy();
            return;
          }
          chunks.push(c);
        });
        req.on('end', () => {
          if (aborted) return;
          let body;
          try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
          catch (e) { return json(res, 400, { error: 'invalid JSON' }); }
          if (!body || typeof body !== 'object' || typeof body.rev !== 'number'
              || !body.snapshot || typeof body.snapshot !== 'object')
            return json(res, 400, { error: 'expected {rev:number, snapshot:object}' });
          const cur = readData();
          const curRev = (cur && cur.rev) || 0;
          if (body.rev !== curRev)
            return json(res, 409, { rev: curRev, snapshot: (cur && cur.snapshot) || null });
          const next = { rev: curRev + 1, snapshot: body.snapshot, updatedAt: new Date().toISOString() };
          try { writeData(next); } catch (e) { return json(res, 500, { error: 'write failed: ' + e.message }); }
          return json(res, 200, { rev: next.rev });
        });
        return;
      }

      return json(res, 405, { error: 'method not allowed' });
    }

    // --- journal image attachments: /api/att/<base64url-key> ---
    const attMatch = url.match(/^\/api\/att\/([^/]+)$/);
    if (attMatch) {
      if (!authOk(req)) return json(res, 401, { error: 'unauthorized' });
      const key = attMatch[1];
      if (!ATT_KEY.test(key)) return json(res, 400, { error: 'bad attachment key' });
      const file = path.join(attDir, key + '.json');
      if (req.method === 'GET') {
        return fs.readFile(file, (err, buf) => err
          ? json(res, 404, { error: 'not found' })
          : (res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }), res.end(buf)));
      }
      if (req.method === 'PUT') {
        let size = 0; const chunks = []; let aborted = false;
        req.on('data', c => { size += c.length;
          if (size > MAX_ATT) { aborted = true; json(res, 413, { error: 'attachments too large' }); req.destroy(); return; }
          chunks.push(c); });
        req.on('end', () => { if (aborted) return;
          let arr; try { arr = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) { return json(res, 400, { error: 'invalid JSON' }); }
          if (!Array.isArray(arr) || !arr.every(x => typeof x === 'string' && x.startsWith('data:image/')))
            return json(res, 400, { error: 'expected array of image data URLs' });
          let existing = 0; try { existing = fs.statSync(file).size; } catch (e) {}
          if (attDirSize() - existing + size > MAX_ATT_TOTAL)
            return json(res, 507, { error: 'attachment store full (' + Math.round(MAX_ATT_TOTAL / 1024 / 1024) + ' MB cap) — delete attachments from old trades first' });
          try { fs.writeFileSync(file + '.tmp', JSON.stringify(arr)); fs.renameSync(file + '.tmp', file); }
          catch (e) { return json(res, 500, { error: 'write failed' }); }
          return json(res, 200, { ok: true, count: arr.length }); });
        return;
      }
      if (req.method === 'DELETE') {
        try { fs.unlinkSync(file); } catch (e) {}
        return json(res, 200, { ok: true });
      }
      return json(res, 405, { error: 'method not allowed' });
    }

    return json(res, 404, { error: 'not found' });
  });
  server.appSyncCapable = appSyncCapable;
  server.engineOk = engine.ok;
  server.engineMissing = engine.missing;
  server._weeklyDigest = weeklyDigest;       // exposed for tests — generation is time-gated in production
  server._gatherAlertState = gatherAlertState; // exposed for tests
  server._buildBotState = buildBotState;       // exposed for tests — the loop itself needs a live bot
  server._social = social; // tests reach the coach allowance through this
  return server;
}

if (require.main === module) {
  const port = parseInt(process.env.PORT, 10) || 8080;
  const app = createApp();
  if (!process.env.AUTH_TOKEN)
    console.warn('[ledger] WARNING: AUTH_TOKEN is not set — the persistence API is open to anyone with the URL.');
  if (!fs.existsSync('/data') && !process.env.DATA_DIR)
    console.warn('[ledger] WARNING: no /data volume detected — data will NOT survive redeploys. Attach a Railway Volume at /data.');
  if (!app.appSyncCapable)
    console.warn('[ledger] WARNING: the served HTML has no server-sync client (no initServerSync found).\n'
      + '           You are deploying an OLD ledger.html. The API works, but the app will run browser-only:\n'
      + '           no token prompt, no syncing, journal entries stay in the browser. Update ledger.html.');
  if (!app.engineOk)
    console.warn('[ledger] WARNING: analytics engine disabled — ledger.html is missing: '
      + app.engineMissing.join(', ') + '\n           /api/v1 analytics will return 503; persistence and the app itself are unaffected.');
  else
    console.log('[ledger] analytics engine ready (' + ENGINE_FNS.length + ' functions extracted from ledger.html)');
  const srv = app.listen(port, () => console.log('[ledger] listening on :' + port));

  // Graceful shutdown. Railway sends SIGTERM to the running container on every redeploy;
  // without a handler Node dies with exit code 143 (non-zero) and Railway marks the
  // deployment "Crashed" on every push. Close cleanly and exit 0 instead. The timer is a
  // backstop in case a client holds a connection open past the drain window.
  const shutdown = (sig) => {
    console.log('[ledger] ' + sig + ' received — shutting down');
    srv.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

module.exports = { sanitizeCoachChat, coachChatRequest, scrubCoachData, createApp, buildEngine, ENGINE_FNS, alertsFrom, postWebhook, telegramReply, nudgeFrom, zonedDayHour,
  sanitizeCoachFacts, coachLetterRequest, coachLetterText };
