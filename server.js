// Ledger companion server — zero dependencies, ~150 lines.
//
// The app stays client-only in spirit: all reconstruction, mining, and analytics run in
// the browser exactly as before. This server does two things only:
//   1. serve ledger.html
//   2. persist one JSON blob (journal + wallets + settings + MAE/MFE measurements)
//      at DATA_DIR/ledger-data.json, with optimistic-concurrency revisions so two
//      devices can't silently clobber each other.
//
// Railway notes:
//   - Railway's filesystem is EPHEMERAL across deploys. Attach a Volume (mount path
//     /data) or journal entries WILL vanish on every redeploy. The server prefers
//     /data automatically when it exists; override with DATA_DIR.
//   - Set AUTH_TOKEN in the service variables. Without it the API is open to anyone
//     who finds the URL — your journal and wallet addresses are sensitive.
//   - Railway injects PORT; nothing to configure.
//
// API:
//   GET  /api/health         -> {ok:true, auth:<bool>}          (no auth required)
//   GET  /api/data           -> {rev, snapshot|null}             (auth)
//   PUT  /api/data {rev,snapshot} -> {rev:new}                   (auth)
//        stale rev -> 409 {rev, snapshot}  (current server state, client refreshes)
//
// Writes are atomic (tmp + rename) and the previous version is kept as .bak.

'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MAX_BODY = 25 * 1024 * 1024; // journal snapshots are small; this is generous headroom

function timingSafeEq(a, b) {
  const A = Buffer.from(String(a)), B = Buffer.from(String(b));
  if (A.length !== B.length) return false;
  return crypto.timingSafeEqual(A, B);
}

function createApp(opts) {
  opts = opts || {};
  const dataDir = opts.dataDir
    || process.env.DATA_DIR
    || (fs.existsSync('/data') ? '/data' : path.join(__dirname, 'data'));
  const auth = opts.auth !== undefined ? opts.auth : (process.env.AUTH_TOKEN || '');
  const htmlPath = opts.htmlPath
    || [path.join(__dirname, 'ledger.html'), path.join(__dirname, 'index.html')]
       .find(p => fs.existsSync(p))
    || path.join(__dirname, 'ledger.html');
  const dataFile = path.join(dataDir, 'ledger-data.json');
  const attDir = path.join(dataDir, 'att');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(attDir, { recursive: true });
  const ATT_KEY = /^[A-Za-z0-9_-]{1,200}$/;   // base64url of the trade id
  const MAX_ATT = 8 * 1024 * 1024;            // per-trade attachment set

  // Guard against the easy mistake of deploying server.js next to an older ledger.html:
  // the API would work while the app silently ran browser-only (no token prompt, no sync).
  // Detected once at boot, surfaced in the logs and on /api/health.
  let appSyncCapable = false;
  try { appSyncCapable = fs.readFileSync(htmlPath, 'utf8').includes('initServerSync'); } catch (e) {}

  const readData = () => {
    try { return JSON.parse(fs.readFileSync(dataFile, 'utf8')); } catch (e) { return null; }
  };
  const writeData = (obj) => {
    const tmp = dataFile + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj));
    try { if (fs.existsSync(dataFile)) fs.copyFileSync(dataFile, dataFile + '.bak'); } catch (e) {}
    fs.renameSync(tmp, dataFile);
  };
  const authOk = (req) => {
    if (!auth) return true;
    return timingSafeEq(req.headers['authorization'] || '', 'Bearer ' + auth);
  };
  const json = (res, code, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(code, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(body);
  };

  const server = http.createServer((req, res) => {
    const url = (req.url || '/').split('?')[0];

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

module.exports = { createApp };
