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
  fs.mkdirSync(dataDir, { recursive: true });

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

  return http.createServer((req, res) => {
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

    // --- health: unauthenticated so the client can detect the server and whether auth is on ---
    if (req.method === 'GET' && url === '/api/health') {
      return json(res, 200, { ok: true, auth: !!auth });
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

    return json(res, 404, { error: 'not found' });
  });
}

if (require.main === module) {
  const port = parseInt(process.env.PORT, 10) || 8080;
  const app = createApp();
  if (!process.env.AUTH_TOKEN)
    console.warn('[ledger] WARNING: AUTH_TOKEN is not set — the persistence API is open to anyone with the URL.');
  if (!fs.existsSync('/data') && !process.env.DATA_DIR)
    console.warn('[ledger] WARNING: no /data volume detected — data will NOT survive redeploys. Attach a Railway Volume at /data.');
  app.listen(port, () => console.log('[ledger] listening on :' + port));
}

module.exports = { createApp };
