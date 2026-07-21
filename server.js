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
//   GET  /api/v1/breakdown?by=coin|dir|market|wallet|tag|dow|hour
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
  'openRiskModel', 'whatIfStats', 'whatIfModel',
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
  if (/^\d+$/.test(v)) return parseInt(v, 10);
  const t = Date.parse(v);
  return isNaN(t) ? null : t;
};
const qnum = (v, dflt) => { const n = parseFloat(v); return isFinite(n) ? n : dflt; };
const csvCell = (v) => {
  if (v == null) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};

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
  const marketFile = path.join(dataDir, 'market.json');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(attDir, { recursive: true });
  fs.mkdirSync(fillsDir, { recursive: true });
  fs.mkdirSync(fundingDir, { recursive: true });
  const ATT_KEY = /^[A-Za-z0-9_-]{1,200}$/;   // base64url of the trade id
  const MAX_ATT = 8 * 1024 * 1024;            // per-trade attachment set

  // Guard against the easy mistake of deploying server.js next to an older ledger.html:
  // the API would work while the app silently ran browser-only (no token prompt, no sync).
  // Detected once at boot, surfaced in the logs and on /api/health.
  let appSyncCapable = false;
  try { appSyncCapable = fs.readFileSync(htmlPath, 'utf8').includes('initServerSync'); } catch (e) {}

  // Analytics engine — extracted from the same HTML this server serves.
  const engine = buildEngine(htmlPath, opts.fetchImpl || ((...a) => globalThis.fetch(...a)));
  const E = engine.ctx; // undefined when !engine.ok — every v1 route checks first

  const readData = () => {
    try { return JSON.parse(fs.readFileSync(dataFile, 'utf8')); } catch (e) { return null; }
  };
  const writeData = (obj) => {
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
    res.writeHead(code, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(body);
  };

  /* ---------------- server-side data caches (per wallet, gzip JSON) ---------------- */
  const fillsFile = a => path.join(fillsDir, a.toLowerCase() + '.json.gz');
  const fundingFile = a => path.join(fundingDir, a.toLowerCase() + '.json.gz');
  const readFillCache = a => { const c = gzRead(fillsFile(a)); return (c && c.v === 1 && Array.isArray(c.fills)) ? c : null; };
  const readFundingCache = a => { const c = gzRead(fundingFile(a)); return (c && c.v === 1 && Array.isArray(c.rows)) ? c : null; };
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

  async function fetchPositionsSrv(addr, hip3Dexs) {
    // Client fetchPositions carries browser-only HIP-3 diagnostics (IndexedDB, status bar);
    // this is the same call pattern minus those, built on the extracted hlPost/mapClearinghouse.
    let positions = [], accountValue = null;
    try {
      const s = await E.hlPost({ type: 'clearinghouseState', user: addr });
      positions = E.mapClearinghouse(s, '');
      accountValue = s.marginSummary ? parseFloat(s.marginSummary.accountValue) : null;
    } catch (e) {}
    for (const dex of (hip3Dexs || [])) {
      try {
        const s = await E.hlPost({ type: 'clearinghouseState', user: addr, dex });
        positions = positions.concat(E.mapClearinghouse(s, dex));
      } catch (e) {}                    // a dead/renamed dex shouldn't sink the whole load
    }
    return { positions, accountValue };
  }

  async function doRefresh(body) {
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
    let positions = [], accVals = [], spotHold = [], spotAccVals = [];
    let portAll = 0, portPerp = 0, portAllHas = false, portPerpHas = false;

    for (const w of wallets) {
      const res = { address: w.address, label: w.label || '', newFills: 0, fills: 0, truncated: false, error: null };
      try {
        const cache = body.full ? null : readFillCache(w.address);
        const since = (cache && cache.last) ? cache.last + 1 : 0;
        const fr = await E.fetchAllFills(w.address, since);
        let fills;
        if (cache) {
          const seen = new Set(cache.fills.map(fillId));
          fills = cache.fills.slice();
          for (const f of fr.fills) if (!seen.has(fillId(f))) { seen.add(fillId(f)); fills.push(f); res.newFills++; }
        } else { fills = fr.fills; res.newFills = fills.length; res.truncated = !!fr.truncated; }
        const last = fills.reduce((m, f) => f.time > m ? f.time : m, 0);
        gzWrite(fillsFile(w.address), { v: 1, last, count: fills.length, savedAt: Date.now(), truncated: res.truncated, fills });
        res.fills = fills.length;

        // funding: full refetch each refresh — matches the client, keeps semantics identical
        const frows = await E.fetchFunding(w.address);
        gzWrite(fundingFile(w.address), { v: 1, savedAt: Date.now(), rows: frows });

        const hip3 = E.hip3DexsFromFills(fills);
        const [ch, sbal, port] = await Promise.all([
          fetchPositionsSrv(w.address, hip3),
          E.fetchSpotState(w.address),
          E.fetchPortfolio(w.address),
        ]);
        ch.positions.forEach(p => p.wallet = { address: w.address, label: w.label || '' });
        positions = positions.concat(ch.positions);
        if (ch.accountValue != null) accVals.push(ch.accountValue);
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
      } catch (e) { res.error = e && e.message || String(e); }
      out.wallets.push(res);
    }

    const market = {
      fetchedAt: Date.now(),
      positions,
      accountValue: accVals.length ? accVals.reduce((a, b) => a + b, 0) : null,
      spotHoldings: spotHold,
      spotAccountValue: spotAccVals.length ? spotAccVals.reduce((a, b) => a + b, 0) : null,
      hlPnl: { all: portAllHas ? portAll : null, perp: portPerpHas ? portPerp : null },
      spotMaps,
    };
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
    try { for (const f of fs.readdirSync(fillsDir).sort()) parts.push(f + ':' + fs.statSync(path.join(fillsDir, f)).mtimeMs); } catch (e) {}
    try { parts.push('m:' + fs.statSync(marketFile).mtimeMs); } catch (e) {}
    const snap = currentSnapshot();
    parts.push('w:' + snapWallets(snap).map(w => w.address.toLowerCase()).join(','));
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
    const from = parseTime(q.from), to = parseTime(q.to);
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
      liquidated: !!t.liquidated,
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

  /* ---------------- v1 endpoint docs (served at GET /api/v1) ---------------- */
  const FILTER_DOC = 'market, wallet, coin, dir, status=open|closed|all, outcome=win|loss|be, tag, q, from, to, tz=utc|local';
  const V1_DOCS = [
    { method: 'GET',  path: '/api/v1', auth: 'none', desc: 'this index' },
    { method: 'POST', path: '/api/v1/refresh', auth: 'full', desc: 'fetch fills/funding/positions from Hyperliquid into server caches; body {wallets?,full?,force?}; min interval 15s unless force' },
    { method: 'GET',  path: '/api/v1/meta', auth: 'read', desc: 'freshness, wallet cache state, engine status, trade counts' },
    { method: 'GET',  path: '/api/v1/trades', auth: 'read', desc: 'trade list; filters (' + FILTER_DOC + ') + sort, order, limit (<=1000), offset, events=1' },
    { method: 'GET',  path: '/api/v1/trades/:id', auth: 'read', desc: 'one trade with fill events and journal entry' },
    { method: 'GET',  path: '/api/v1/stats', auth: 'read', desc: 'computeStats over the filtered set; filters as above' },
    { method: 'GET',  path: '/api/v1/equity', auth: 'read', desc: 'cumulative equity points, daily series, drawdown diagnostics; filters' },
    { method: 'GET',  path: '/api/v1/calendar', auth: 'read', desc: 'net PnL per calendar day (tz-aware); filters' },
    { method: 'GET',  path: '/api/v1/breakdown', auth: 'read', desc: 'grouped stats; by=coin|dir|market|wallet|tag|dow|hour; filters' },
    { method: 'GET',  path: '/api/v1/projection', auth: 'read', desc: 'Monte Carlo forward sim; horizon (days, default 90), paths (<=2000, default 400), block, seed, lookback (days); filters' },
    { method: 'GET',  path: '/api/v1/kelly', auth: 'read', desc: 'Kelly sizing from filtered closed trades' },
    { method: 'GET',  path: '/api/v1/risk', auth: 'read', desc: 'open-position risk model over last refreshed positions' },
    { method: 'GET',  path: '/api/v1/positions', auth: 'read', desc: 'cached positions/spot/account snapshot; ?live=1 (full auth) refetches' },
    { method: 'GET',  path: '/api/v1/spot/lots', auth: 'read', desc: 'FIFO 8949-style spot cost-basis lots; wallet= optional' },
    { method: 'GET',  path: '/api/v1/whatif', auth: 'read', desc: 'counterfactual replay removing trades matching field/op/value (op: eq|ne|lt|lte|gt|gte|in); filters' },
    { method: 'GET',  path: '/api/v1/journal', auth: 'read', desc: 'journal entries keyed by trade id (read-only)' },
    { method: 'GET',  path: '/api/v1/journal/:id', auth: 'read', desc: 'one journal entry (read-only)' },
    { method: 'GET',  path: '/api/v1/tags', auth: 'read', desc: 'distinct journal tags with usage counts' },
    { method: 'GET',  path: '/api/v1/export/trades.csv', auth: 'read', desc: 'flat CSV of the filtered trades; filters' },
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
      let body = {};
      try { body = JSON.parse(await readBody(req)) || {}; } catch (e) { body = {}; }
      if (_refreshing) return send(409, { error: 'refresh already running' });
      if (!body.force && Date.now() - _lastRefreshAt < REFRESH_MIN_MS)
        return send(429, { error: 'refreshed ' + Math.round((Date.now() - _lastRefreshAt) / 1000) + 's ago — min interval 15s (pass force:true to override)', lastSummary: _lastRefreshSummary });
      _refreshing = true;
      try {
        const summary = await doRefresh(body);
        _lastRefreshAt = Date.now(); _lastRefreshSummary = summary;
        const { trades } = ensureTrades();
        summary.trades = {
          total: trades.length,
          perp: trades.filter(t => t.market === 'perp').length,
          spot: trades.filter(t => t.market === 'spot').length,
          open: trades.filter(t => t.isOpen).length,
        };
        return send(200, summary);
      } catch (e) { return fail(e); }
      finally { _refreshing = false; }
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
        const id = decodeURIComponent(tradeM[1]);
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
          return { key, n: s.n, net: s.net, fees: s.fees, winRate: s.winRate,
            profitFactor: s.profitFactor === Infinity ? null : s.profitFactor,
            expectancy: s.expectancy, avgR: s.avgR, avgHold: s.avgHold, maxDD: s.maxDD };
        }).sort((a, b) => b.net - a.net);
        return send(200, { by, groups: out });
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

      if (url === '/api/v1/risk') {
        setEngineState(query);
        if (!engine.ok) throw { code: 503, msg: 'analytics engine unavailable' };
        const market = readMarket();
        if (!market) return send(409, { error: 'no market snapshot yet — POST /api/v1/refresh first' });
        return send(200, { fetchedAt: market.fetchedAt, accountValue: market.accountValue,
          risk: E.openRiskModel(market.positions || []) });
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
        let fills = [];
        for (const w of wallets) { const fc = readFillCache(w.address); if (fc) fills = fills.concat(fc.fills); }
        const spotFills = fills.filter(f => !E.isPerp(f.coin)).sort((a, b) => a.time - b.time);
        return send(200, { fills: spotFills.length, lots: E.spotFifoLots(spotFills, nameByCoin) });
      }

      if (url === '/api/v1/whatif') {
        const { closed } = prepare(query);
        const pred = predFromQuery(query);
        const model = E.whatIfModel(closed, pred);
        return send(200, { rule: { field: query.field, op: query.op || 'eq', value: query.value }, model });
      }

      if (url === '/api/v1/journal') {
        const snap = currentSnapshot();
        return send(200, { journal: snap.journal || {} });
      }
      const jM = url.match(/^\/api\/v1\/journal\/(.+)$/);
      if (jM) {
        const snap = currentSnapshot();
        const id = decodeURIComponent(jM[1]);
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

  const readBody = (req) => new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length;
      if (size > MAX_BODY) { reject(new Error('payload too large')); req.destroy(); return; }
      chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });

  const server = http.createServer((req, res) => {
    const [url, qs] = (req.url || '/').split('?');
    const query = Object.fromEntries(new URLSearchParams(qs || ''));

    // Optional CORS for /api/* — exact-origin, opt-in via CORS_ORIGIN, off by default.
    if (corsOrigin && url.startsWith('/api/')) {
      res.setHeader('Access-Control-Allow-Origin', corsOrigin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET, PUT, POST, DELETE, OPTIONS');
      if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    }

    // --- static: the app itself ---
    if (req.method === 'GET' && (url === '/' || url === '/index.html' || url === '/ledger.html')) {
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

    // --- PWA assets (tiny, inline — no extra files to deploy) ---
    if (req.method === 'GET' && url === '/sw.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-cache' });
      // network-first for the app shell so updates land immediately; cached copy = offline fallback.
      // API and exchange calls are never intercepted.
      return res.end(
        "const C='ledger-v1';" +
        "self.addEventListener('install',e=>{self.skipWaiting();e.waitUntil(caches.open(C).then(c=>c.add('/')))});" +
        "self.addEventListener('activate',e=>{e.waitUntil(clients.claim())});" +
        "self.addEventListener('fetch',e=>{const u=new URL(e.request.url);" +
        "if(u.origin!==location.origin||u.pathname.startsWith('/api/'))return;" +
        "if(e.request.mode==='navigate'||u.pathname==='/'){e.respondWith(" +
        "fetch(e.request).then(r=>{const cp=r.clone();caches.open(C).then(c=>c.put('/',cp));return r;})" +
        ".catch(()=>caches.match('/')));}});");
    }
    if (req.method === 'GET' && url === '/manifest.webmanifest') {
      res.writeHead(200, { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'no-cache' });
      return res.end(JSON.stringify({ name: 'Ledger', short_name: 'Ledger',
        start_url: '/', display: 'standalone', background_color: '#0c0e14', theme_color: '#0c0e14',
        icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }] }));
    }
    if (req.method === 'GET' && url === '/icon.svg') {
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'max-age=86400' });
      return res.end('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">'
        + '<rect width="100" height="100" rx="18" fill="#0c0e14"/>'
        + '<path d="M20 72 L38 50 L52 60 L80 28" stroke="#8b93ff" stroke-width="7" fill="none" stroke-linecap="round" stroke-linejoin="round"/>'
        + '<circle cx="80" cy="28" r="6" fill="#2fd08c"/></svg>');
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

module.exports = { createApp, buildEngine, ENGINE_FNS };
