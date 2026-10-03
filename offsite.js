// Encrypted off-site backups — zero dependencies.
//
// The server's own backups live on the same Railway volume as the data they protect: one
// deleted volume, one bad migration, and both are gone. With OFFSITE_* set, the server
// also ships an ENCRYPTED copy to any S3-compatible bucket (AWS S3, Cloudflare R2,
// Backblaze B2, MinIO, …):
//
//   - every "Backup to server" (POST /api/backup), as it is made
//   - once a day, a bundle of DATA_DIR: journal, social/members, vault, fill/funding/ledger
//     caches, attachments, reports, push keys (re-fetchable or redundant bits are skipped)
//
// Everything is encrypted before it leaves the process (AES-256-GCM, key from the
// OFFSITE_KEY passphrase via scrypt, fresh salt + IV per object), so the bucket provider
// sees only ciphertext. LOSE THE PASSPHRASE AND THE BACKUPS ARE UNREADABLE — keep it
// somewhere other than the server.
//
// Restoring (same env vars set, or pass them inline):
//   node offsite.js list                         objects in the bucket, newest first
//   node offsite.js get <key> <out-file>         download + decrypt (a backup JSON, or a bundle)
//   node offsite.js restore <key|file> <dir>     unpack a DATA_DIR bundle into <dir>
//   node offsite.js decrypt <in> <out>           decrypt a file you downloaded yourself
//
// Env: OFFSITE_ENDPOINT (e.g. https://<account>.r2.cloudflarestorage.com or
//      https://s3.eu-west-1.amazonaws.com), OFFSITE_BUCKET, OFFSITE_ACCESS_KEY_ID,
//      OFFSITE_SECRET_ACCESS_KEY, OFFSITE_KEY (the encryption passphrase),
//      OFFSITE_REGION (default: 'auto' for R2, else 'us-east-1'), OFFSITE_PREFIX
//      (default 'ledger/'), OFFSITE_KEEP (newest N of each kind kept, default 30).

'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

/* ---------------- encryption ---------------- */
// Layout: MAGIC(6) | salt(16) | iv(12) | ciphertext | tag(16). scrypt N=2^15 keeps a
// brute force of a weak passphrase expensive while costing ~50 ms per object here.
const MAGIC = Buffer.from('LDGRE1');
const SCRYPT = { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
function encrypt(plain, passphrase) {
  if (!passphrase) throw new Error('no encryption passphrase (OFFSITE_KEY)');
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const key = crypto.scryptSync(String(passphrase), salt, 32, SCRYPT);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([MAGIC, salt, iv, body, c.getAuthTag()]);
}
function decrypt(blob, passphrase) {
  if (!Buffer.isBuffer(blob) || blob.length < MAGIC.length + 44 || !blob.subarray(0, MAGIC.length).equals(MAGIC))
    throw new Error('not an encrypted Ledger backup');
  const o = MAGIC.length, salt = blob.subarray(o, o + 16), iv = blob.subarray(o + 16, o + 28);
  const tag = blob.subarray(blob.length - 16), body = blob.subarray(o + 28, blob.length - 16);
  const key = crypto.scryptSync(String(passphrase), salt, 32, SCRYPT);
  const d = crypto.createDecipheriv('aes-256-gcm', key, iv);
  d.setAuthTag(tag);
  try { return Buffer.concat([d.update(body), d.final()]); }
  catch (e) { throw new Error('decryption failed — wrong OFFSITE_KEY, or the file is damaged'); }
}

/* ---------------- DATA_DIR bundle ---------------- */
// gzip( repeated: JSON header line {p, n, m} + "\n" + n raw bytes ). No base64, no tar
// path-length limits (attachment keys run to 200 chars); unpacked by restoreBundle below.
const BUNDLE_SKIP = new Set(['backups', 'snapshots', 'social-fills', 'market.json']); // mirrored separately, redundant, or re-fetchable
// SQLite databases (pulse.db: members, the feed, reviews — backed up nowhere else) run in WAL mode:
// committed rows sit in pulse.db-wal until a checkpoint moves them into pulse.db. Reading the two
// files one after the other, with the server writing in between, could pair an old pulse.db with a
// WAL a checkpoint had already restarted — a bundle that opens cleanly, passes integrity_check, and
// is missing everything since the last checkpoint. So a database ships as one consistent copy made
// by SQLite itself (VACUUM INTO, through a connection of its own: it reads one snapshot of the
// committed data, WAL included, while the server keeps writing), and its -wal/-shm never ship.
const SQLITE_MAGIC = Buffer.from('SQLite format 3\0');
function isSqlite(file) {
  let fd; try { fd = fs.openSync(file, 'r'); const b = Buffer.alloc(16); return fs.readSync(fd, b, 0, 16, 0) === 16 && b.equals(SQLITE_MAGIC); }
  catch (e) { return false; } finally { if (fd != null) try { fs.closeSync(fd); } catch (e) {} }
}
let _DatabaseSync;
function sqliteSnapshot(file) {
  if (_DatabaseSync === undefined) { // node:sqlite is built in from Node 22.13 (db.js runs on it); quiet its "experimental" warning
    const emit = process.emitWarning;
    process.emitWarning = function (w, ...a) { if (/SQLite/i.test(String(w && w.message || w))) return; return emit.call(process, w, ...a); };
    try { _DatabaseSync = require('node:sqlite').DatabaseSync; } catch (e) { _DatabaseSync = null; } finally { process.emitWarning = emit; }
  }
  if (!_DatabaseSync) throw new Error('node:sqlite is unavailable, so ' + path.basename(file) + ' cannot be copied consistently');
  const tmp = file + '.offsite-' + process.pid + '-' + crypto.randomBytes(4).toString('hex') + '.tmp'; // .tmp: never itself bundled
  const db = new _DatabaseSync(file); // read-write only so a WAL database opens even without its -shm; VACUUM INTO never writes to it
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.prepare('VACUUM INTO ?').run(tmp);
    return fs.readFileSync(tmp);
  } finally { try { db.close(); } catch (e) {} try { fs.unlinkSync(tmp); } catch (e) {} }
}
// one file's bytes for the bundle: a database as its consistent copy, anything else as it is
async function bundleBytes(full, f) { return f.sqlite ? sqliteSnapshot(full) : fs.promises.readFile(full); }
function collectFiles(dataDir, opts) {
  opts = opts || {};
  const maxBytes = opts.maxBytes || Infinity;
  const out = []; let total = 0; const skipped = [];
  const walk = (rel) => {
    let names; try { names = fs.readdirSync(path.join(dataDir, rel)).sort(); } catch (e) { return; }
    for (const n of names) {
      const r = rel ? rel + '/' + n : n;
      if (!rel && BUNDLE_SKIP.has(n)) continue;
      if (/\.(tmp|bak)$/.test(n)) continue;
      let st; try { st = fs.statSync(path.join(dataDir, r)); } catch (e) { continue; }
      if (st.isDirectory()) { walk(r); continue; }
      if (!st.isFile()) continue;
      const e = { p: r, n: st.size, m: st.mtimeMs };
      if (isSqlite(path.join(dataDir, r))) e.sqlite = true;
      out.push(e); total += st.size;
    }
  };
  walk('');
  // a database's -wal / -shm / -journal are inside its consistent copy: they never ship on their own
  const dbs = new Set(out.filter(f => f.sqlite).map(f => f.p));
  for (let i = out.length - 1; i >= 0; i--) {
    const m = /^(.*)-(wal|shm|journal)$/.exec(out[i].p);
    if (m && dbs.has(m[1])) { total -= out[i].n; out.splice(i, 1); }
  }
  // over the cap: attachments go first (the largest and the most re-attachable), then the
  // fill caches; the journal itself always ships
  for (const dropDir of ['att/', 'fills/', 'funding/', 'ledger/']) {
    if (total <= maxBytes) break;
    for (let i = out.length - 1; i >= 0; i--) if (out[i].p.startsWith(dropDir)) { total -= out[i].n; out.splice(i, 1); }
    skipped.push(dropDir.slice(0, -1));
  }
  return { files: out, total, skipped };
}
function packBundle(dataDir, opts) {
  const { files, total, skipped } = collectFiles(dataDir, opts);
  const parts = [];
  for (const f of files) {
    let buf; try { buf = f.sqlite ? sqliteSnapshot(path.join(dataDir, f.p)) : fs.readFileSync(path.join(dataDir, f.p)); }
    catch (e) { if (f.sqlite) throw e; continue; } // vanished mid-walk; a database that can't be copied fails the bundle, loudly
    parts.push(Buffer.from(JSON.stringify({ p: f.p, n: buf.length, m: Math.round(f.m) }) + '\n'), buf);
  }
  return { buf: zlib.gzipSync(Buffer.concat(parts)), files: files.length, bytes: total, skipped };
}
// The same bundle for the daily ship, without holding up the server: files are read and the whole
// thing is gzipped off the event loop (libuv's pool), so requests keep flowing meanwhile.
async function packBundleAsync(dataDir, opts) {
  const { files, total, skipped } = collectFiles(dataDir, opts);
  const parts = [];
  for (const f of files) {
    let buf; try { buf = await bundleBytes(path.join(dataDir, f.p), f); } catch (e) { if (f.sqlite) throw e; continue; }
    parts.push(Buffer.from(JSON.stringify({ p: f.p, n: buf.length, m: Math.round(f.m) }) + '\n'), buf);
  }
  const gz = await new Promise((res, rej) => zlib.gzip(Buffer.concat(parts), (e, out) => e ? rej(e) : res(out)));
  return { buf: gz, files: files.length, bytes: total, skipped };
}
function unpackBundle(gz) {
  const raw = zlib.gunzipSync(gz);
  const out = []; let i = 0;
  while (i < raw.length) {
    const nl = raw.indexOf(0x0a, i);
    if (nl < 0) throw new Error('bundle truncated');
    const h = JSON.parse(raw.subarray(i, nl).toString('utf8'));
    const start = nl + 1, end = start + h.n;
    if (end > raw.length) throw new Error('bundle truncated at ' + h.p);
    out.push({ p: h.p, m: h.m, data: raw.subarray(start, end) });
    i = end;
  }
  return out;
}
function restoreBundle(gz, dir) {
  const root = path.resolve(dir);
  const files = unpackBundle(gz);
  for (const f of files) {
    const dest = path.resolve(root, f.p);
    if (!dest.startsWith(root + path.sep)) throw new Error('refusing a path outside the target: ' + f.p);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, f.data);
    if (f.m) try { fs.utimesSync(dest, new Date(f.m), new Date(f.m)); } catch (e) {}
  }
  return files.length;
}

/* ---------------- S3 (SigV4, path-style) ---------------- */
const sha256hex = b => crypto.createHash('sha256').update(b).digest('hex');
const hmac = (k, s) => crypto.createHmac('sha256', k).update(s).digest();
// RFC 3986: everything but unreserved characters is percent-encoded (S3's canonical form)
const uriEnc = (s, keepSlash) => encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase())
  .replace(keepSlash ? /%2F/g : /$^/, '/');
// Pure signer: returns the Authorization header for one request. `headers` must include
// host, x-amz-date and x-amz-content-sha256; every header passed is signed.
function sigv4({ method, path: p, query, headers, region, service, accessKeyId, secretAccessKey }) {
  const amzDate = headers['x-amz-date'], day = amzDate.slice(0, 8);
  const names = Object.keys(headers).map(h => h.toLowerCase()).sort();
  const lower = {}; for (const k in headers) lower[k.toLowerCase()] = String(headers[k]).trim().replace(/\s+/g, ' ');
  const cq = Object.keys(query || {}).sort().map(k => uriEnc(k) + '=' + uriEnc(String(query[k]))).join('&');
  const creq = [method, p, cq, names.map(n => n + ':' + lower[n]).join('\n') + '\n', names.join(';'), lower['x-amz-content-sha256']].join('\n');
  const scope = day + '/' + region + '/' + (service || 's3') + '/aws4_request';
  const sts = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(creq)].join('\n');
  const kSign = hmac(hmac(hmac(hmac('AWS4' + secretAccessKey, day), region), service || 's3'), 'aws4_request');
  return 'AWS4-HMAC-SHA256 Credential=' + accessKeyId + '/' + scope + ', SignedHeaders=' + names.join(';')
    + ', Signature=' + crypto.createHmac('sha256', kSign).update(sts).digest('hex');
}
function configFrom(env) {
  env = env || process.env;
  const endpoint = String(env.OFFSITE_ENDPOINT || '').replace(/\/+$/, '');
  const cfg = {
    endpoint, bucket: env.OFFSITE_BUCKET || '', accessKeyId: env.OFFSITE_ACCESS_KEY_ID || '',
    secretAccessKey: env.OFFSITE_SECRET_ACCESS_KEY || '', passphrase: env.OFFSITE_KEY || '',
    region: env.OFFSITE_REGION || (/r2\.cloudflarestorage\.com/.test(endpoint) ? 'auto' : 'us-east-1'),
    prefix: env.OFFSITE_PREFIX !== undefined ? env.OFFSITE_PREFIX : 'ledger/',
    keep: Math.max(1, parseInt(env.OFFSITE_KEEP, 10) || 30),
  };
  const missing = ['endpoint', 'bucket', 'accessKeyId', 'secretAccessKey', 'passphrase'].filter(k => !cfg[k]);
  cfg.enabled = missing.length === 0;
  cfg.partial = missing.length > 0 && missing.length < 5; // some set, some not: almost certainly a mistake
  cfg.missing = missing;
  if (cfg.enabled && !/^https?:\/\//.test(endpoint)) { cfg.enabled = false; cfg.partial = true; cfg.missing = ['endpoint (must start with https://)']; }
  return cfg;
}
function createClient(cfg, fetchImpl) {
  const f = fetchImpl || ((...a) => globalThis.fetch(...a));
  const u = new URL(cfg.endpoint);
  const basePath = u.pathname.replace(/\/+$/, '');
  async function req(method, key, { query, body, headers } = {}) {
    const p = basePath + '/' + uriEnc(cfg.bucket) + (key != null ? '/' + uriEnc(key, true) : '');
    const payload = body || Buffer.alloc(0);
    const h = Object.assign({ host: u.host, 'x-amz-date': new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''),
      'x-amz-content-sha256': sha256hex(payload) }, headers || {});
    h.authorization = sigv4({ method, path: p, query, headers: h, region: cfg.region, accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey });
    const qs = Object.keys(query || {}).sort().map(k => uriEnc(k) + '=' + uriEnc(String(query[k]))).join('&');
    const sendH = Object.assign({}, h); delete sendH.host; // fetch sets Host itself
    const res = await f(u.origin + p + (qs ? '?' + qs : ''), { method, headers: sendH, body: method === 'PUT' ? payload : undefined,
      signal: AbortSignal.timeout(120000) });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      const code = (t.match(/<Code>([^<]+)<\/Code>/) || [])[1];
      throw new Error('bucket ' + method + ' HTTP ' + res.status + (code ? ' ' + code : ''));
    }
    return res;
  }
  const xmlUnesc = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  return {
    put: (key, buf) => req('PUT', key, { body: buf, headers: { 'content-type': 'application/octet-stream' } }),
    get: async key => Buffer.from(await (await req('GET', key)).arrayBuffer()),
    del: key => req('DELETE', key),
    async list(prefix) {
      const out = []; let token = null;
      for (let page = 0; page < 100; page++) {
        const query = { 'list-type': '2', prefix: prefix || '' };
        if (token) query['continuation-token'] = token;
        const xml = await (await req('GET', null, { query })).text();
        for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
          const g = tag => { const x = m[1].match(new RegExp('<' + tag + '>([^<]*)</' + tag + '>')); return x ? xmlUnesc(x[1]) : null; };
          out.push({ key: g('Key'), size: +g('Size') || 0, lastModified: g('LastModified') });
        }
        const next = xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/);
        if (!/<IsTruncated>true<\/IsTruncated>/.test(xml) || !next) break;
        token = xmlUnesc(next[1]);
      }
      return out;
    },
  };
}

/* ---------------- the server-side shipper ---------------- */
// kind: 'backup' (an app "Backup all" JSON, already gzipped) or 'data' (a DATA_DIR bundle).
// Keys sort by time: <prefix><kind>/<ISO stamp>.<ext>.enc — so pruning is "drop the oldest".
function createOffsite({ cfg, dataDir, fetchImpl, maxBundleBytes, log }) {
  const client = createClient(cfg, fetchImpl);
  const warn = log || (m => console.warn('[ledger] offsite: ' + m));
  const state = { lastOkAt: 0, lastError: null, lastKey: null, lastDataAt: 0, busy: false };
  const stamp = () => new Date().toISOString().replace(/[:.]/g, '-');
  async function prune(kind) {
    const items = (await client.list(cfg.prefix + kind + '/')).filter(o => o.key.endsWith('.enc')).sort((a, b) => a.key < b.key ? -1 : 1);
    while (items.length > cfg.keep) await client.del(items.shift().key);
  }
  async function ship(kind, gzBuf, ext) {
    const key = cfg.prefix + kind + '/' + stamp() + '.' + ext + '.enc';
    try {
      await client.put(key, encrypt(gzBuf, cfg.passphrase));
      state.lastOkAt = Date.now(); state.lastError = null; state.lastKey = key;
      try { await prune(kind); } catch (e) { warn('prune failed: ' + e.message); } // a stored copy beats a tidy bucket
      return key;
    } catch (e) { state.lastError = e.message; warn(kind + ' upload failed: ' + e.message); throw e; }
  }
  return {
    state,
    client,
    shipBackup: gzBuf => ship('backup', gzBuf, 'json.gz'),
    async shipData() {
      if (state.busy) return null;
      state.busy = true;
      try {
        const b = await packBundleAsync(dataDir, { maxBytes: maxBundleBytes });
        if (b.skipped.length) warn('bundle over the size cap — left out: ' + b.skipped.join(', '));
        const key = await ship('data', b.buf, 'bundle.gz');
        state.lastDataAt = Date.now();
        return { key, files: b.files, bytes: b.buf.length, skipped: b.skipped };
      } finally { state.busy = false; }
    },
    // the scheduler calls this every run; it ships at most once per `everyMs`
    async maybeShipData(everyMs) {
      if (Date.now() - state.lastDataAt < everyMs) return null;
      try { return await this.shipData(); } catch (e) { return null; }
    },
  };
}

module.exports = { encrypt, decrypt, sigv4, configFrom, createClient, createOffsite, packBundle, packBundleAsync, unpackBundle, restoreBundle, collectFiles };

/* ---------------- CLI ---------------- */
if (require.main === module) {
  (async () => {
    const [cmd, a, b] = process.argv.slice(2);
    const cfg = configFrom();
    const need = (...ks) => { const miss = ks.filter(k => !cfg[k]); if (miss.length) { console.error('missing: ' + miss.join(', ') + ' (set the OFFSITE_* variables)'); process.exit(2); } };
    const maybeGunzip = buf => (buf[0] === 0x1f && buf[1] === 0x8b) ? buf : null;
    if (cmd === 'list') {
      need('endpoint', 'bucket', 'accessKeyId', 'secretAccessKey');
      const items = (await createClient(cfg).list(cfg.prefix)).sort((x, y) => x.key < y.key ? 1 : -1);
      for (const o of items) console.log(o.key + '\t' + (o.size / 1024).toFixed(0) + ' KB\t' + (o.lastModified || ''));
      if (!items.length) console.log('(nothing under ' + (cfg.prefix || '/') + ')');
    } else if (cmd === 'get' && a && b) {
      need('endpoint', 'bucket', 'accessKeyId', 'secretAccessKey', 'passphrase');
      const plain = decrypt(await createClient(cfg).get(a), cfg.passphrase);
      fs.writeFileSync(b, /\.json\.gz\.enc$/.test(a) && !/\.gz$/.test(b) ? zlib.gunzipSync(plain) : plain);
      console.log('wrote ' + b);
    } else if (cmd === 'decrypt' && a && b) {
      need('passphrase');
      const plain = decrypt(fs.readFileSync(a), cfg.passphrase);
      fs.writeFileSync(b, /\.json\.gz\.enc$/.test(a) && !/\.gz$/.test(b) ? zlib.gunzipSync(plain) : plain);
      console.log('wrote ' + b);
    } else if (cmd === 'restore' && a && b) {
      need('passphrase');
      const blob = fs.existsSync(a) ? fs.readFileSync(a)
        : (need('endpoint', 'bucket', 'accessKeyId', 'secretAccessKey'), await createClient(cfg).get(a));
      const gz = maybeGunzip(decrypt(blob, cfg.passphrase));
      if (!gz) { console.error('not a DATA_DIR bundle'); process.exit(1); }
      console.log('restored ' + restoreBundle(gz, b) + ' files into ' + path.resolve(b));
    } else {
      console.error('usage: node offsite.js list | get <key> <out> | restore <key|file> <dir> | decrypt <in> <out>');
      process.exit(2);
    }
  })().catch(e => { console.error(e.message || e); process.exit(1); });
}
