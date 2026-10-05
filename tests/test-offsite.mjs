// Encrypted off-site backups (offsite.js): encryption, the S3 signer against vectors from
// botocore (the official AWS SDK's signer), the DATA_DIR bundle format, and the server
// wiring end to end against an in-process fake S3 that checks every request's signature.
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import zlib from 'node:zlib';
import { t, ok, eq, report } from './harness.mjs';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const O = require(join(here, '..', 'offsite.js'));
const { createApp } = require(join(here, '..', 'server.js'));

console.log('\nEncryption');
t('round-trips, and every object gets its own salt + IV', () => {
  const a = O.encrypt(Buffer.from('journal'), 'pass'), b = O.encrypt(Buffer.from('journal'), 'pass');
  ok(!a.equals(b), 'two encryptions of the same bytes differ');
  eq(O.decrypt(a, 'pass').toString(), 'journal');
  ok(!a.includes(Buffer.from('journal')), 'plaintext not visible');
});
t('wrong passphrase and tampering both fail loudly', () => {
  const a = O.encrypt(Buffer.from('journal'), 'pass');
  let e1 = null; try { O.decrypt(a, 'nope'); } catch (e) { e1 = e; }
  ok(e1 && /wrong OFFSITE_KEY/.test(e1.message));
  const bad = Buffer.from(a); bad[bad.length - 20] ^= 1;
  let e2 = null; try { O.decrypt(bad, 'pass'); } catch (e) { e2 = e; }
  ok(e2, 'GCM tag catches a flipped bit');
  let e3 = null; try { O.decrypt(Buffer.from('plain gzip'), 'pass'); } catch (e) { e3 = e; }
  ok(e3 && /not an encrypted/.test(e3.message));
});

console.log('\nS3 SigV4 signer (vectors generated with botocore)');
const V = JSON.parse(readFileSync(join(here, 's3-sigv4-vectors.json'), 'utf8'));
const enc = s => encodeURIComponent(s).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
for (const v of V) {
  t(v.method + ' ' + v.url.slice(0, 70), () => {
    const u = new URL(v.url); const q = {}; for (const [k, x] of u.searchParams) q[k] = x;
    const p = u.pathname.split('/').map(s => enc(decodeURIComponent(s))).join('/');
    const h = Object.assign({ host: u.host, 'x-amz-date': v.amzDate, 'x-amz-content-sha256': v.sha }, v.extra);
    eq(O.sigv4({ method: v.method, path: p, query: q, headers: h, region: v.region,
      accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' }), v.auth);
  });
}

console.log('\nConfig');
t('all five settings = on; some = half-configured (warned); none = off; endpoint must be a URL', () => {
  const full = { OFFSITE_ENDPOINT: 'https://x.r2.cloudflarestorage.com/', OFFSITE_BUCKET: 'b', OFFSITE_ACCESS_KEY_ID: 'k', OFFSITE_SECRET_ACCESS_KEY: 's', OFFSITE_KEY: 'p' };
  const c = O.configFrom(full);
  ok(c.enabled); eq(c.region, 'auto', 'R2 region'); eq(c.endpoint, 'https://x.r2.cloudflarestorage.com'); eq(c.prefix, 'ledger/'); eq(c.keep, 30);
  const half = O.configFrom({ OFFSITE_BUCKET: 'b' });
  ok(!half.enabled && half.partial && half.missing.includes('passphrase'));
  const none = O.configFrom({});
  ok(!none.enabled && !none.partial);
  const bad = O.configFrom({ ...full, OFFSITE_ENDPOINT: 'x.example.com' });
  ok(!bad.enabled && bad.partial);
  // the signed requests carry the bucket's keys: plain http is refused unless the bucket is on this machine
  ok(!O.configFrom({ ...full, OFFSITE_ENDPOINT: 'http://x.example.com' }).enabled);
  ok(O.configFrom({ ...full, OFFSITE_ENDPOINT: 'http://127.0.0.1:9000' }).enabled);
});

console.log('\nDATA_DIR bundle');
function fixtureDir() {
  const d = mkdtempSync(join(tmpdir(), 'ledger-bundle-'));
  writeFileSync(join(d, 'ledger-data.json'), '{"rev":3}');
  writeFileSync(join(d, 'ledger-data.json.bak'), 'old');
  writeFileSync(join(d, 'market.json'), '{}');
  for (const sub of ['att', 'fills', 'backups', 'social-fills', 'vault']) mkdirSync(join(d, sub));
  writeFileSync(join(d, 'att', 'k'.repeat(200)), Buffer.alloc(4000, 7)); // attachment keys run to 200 chars
  writeFileSync(join(d, 'fills', '0xabc.json.gz'), zlib.gzipSync('{"v":1}'));
  writeFileSync(join(d, 'backups', 'backup-x.json.gz'), 'mirrored separately');
  writeFileSync(join(d, 'social-fills', 'a.json.gz'), 'refetchable');
  writeFileSync(join(d, 'vault', 'm1.json'), '{"blob":"ciphertext"}');
  return d;
}
await t('packs the data that matters, skips the redundant, restores byte-exact', async () => {
  const d = fixtureDir();
  const b = O.packBundle(d);
  const ba = await O.packBundleAsync(d); eq(O.unpackBundle(ba.buf).map(f => f.p).sort(), O.unpackBundle(b.buf).map(f => f.p).sort(), 'the async pack holds the same files');
  const files = O.unpackBundle(b.buf).map(f => f.p).sort();
  eq(files, ['att/' + 'k'.repeat(200), 'fills/0xabc.json.gz', 'ledger-data.json', 'vault/m1.json']);
  const out = mkdtempSync(join(tmpdir(), 'ledger-restore-'));
  eq(O.restoreBundle(b.buf, out), 4);
  eq(readFileSync(join(out, 'ledger-data.json'), 'utf8'), '{"rev":3}');
  ok(readFileSync(join(out, 'att', 'k'.repeat(200))).equals(Buffer.alloc(4000, 7)));
});
t('over the size cap, attachments go first and the journal always ships', () => {
  const d = fixtureDir();
  const b = O.packBundle(d, { maxBytes: 1000 });
  eq(b.skipped, ['att']);
  ok(O.unpackBundle(b.buf).some(f => f.p === 'ledger-data.json'));
});
t('a bundle naming a path outside the target is refused', () => {
  const evil = zlib.gzipSync(Buffer.concat([Buffer.from(JSON.stringify({ p: '../escape.txt', n: 1, m: 0 }) + '\n'), Buffer.from('x')]));
  let err = null; try { O.restoreBundle(evil, mkdtempSync(join(tmpdir(), 'ledger-evil-'))); } catch (e) { err = e; }
  ok(err && /outside the target/.test(err.message));
});

t('restored files are owner-only whatever the umask, and nothing is written or bundled through a symlink', () => {
  const old = process.umask(0o022);
  try {
    const d = fixtureDir(), outside = mkdtempSync(join(tmpdir(), 'ledger-outside-'));
    writeFileSync(join(outside, 'secret.json'), 'OUTSIDE'); symlinkSync(join(outside, 'secret.json'), join(d, 'linked.json'));
    const b = O.packBundle(d);
    ok(!O.unpackBundle(b.buf).some(f => f.p === 'linked.json'), 'a symlink in the data dir is not followed into the bundle');
    const out = join(mkdtempSync(join(tmpdir(), 'ledger-restore-')), 'new');
    O.restoreBundle(b.buf, out);
    eq((statSync(out).mode & 0o777).toString(8), '700');
    eq((statSync(join(out, 'vault')).mode & 0o777).toString(8), '700');
    eq((statSync(join(out, 'ledger-data.json')).mode & 0o777).toString(8), '600');
    eq((statSync(join(out, 'vault', 'm1.json')).mode & 0o777).toString(8), '600');
    // a symlink already in the target, named like a bundled file or folder, is refused rather than written through
    const t2 = mkdtempSync(join(tmpdir(), 'ledger-restore-'));
    symlinkSync(join(outside, 'secret.json'), join(t2, 'ledger-data.json'));
    let err = null; try { O.restoreBundle(b.buf, t2); } catch (e) { err = e; } ok(err, 'file symlink refused');
    eq(readFileSync(join(outside, 'secret.json'), 'utf8'), 'OUTSIDE');
    const t3 = mkdtempSync(join(tmpdir(), 'ledger-restore-'));
    symlinkSync(outside, join(t3, 'vault'));
    err = null; try { O.restoreBundle(b.buf, t3); } catch (e) { err = e; } ok(err && /outside the target/.test(err.message), 'folder symlink refused');
    ok(!existsSync(join(outside, 'm1.json')));
  } finally { process.umask(old); }
});

await t('pulse.db ships as one consistent SQLite copy: rows still in the WAL survive a checkpoint mid-bundle, and no -wal/-shm ships', async () => {
  // the audit's repro: 50 members only in the WAL; while the bundle is being read, the server
  // checkpoints and writes again (restarting the WAL). Reading pulse.db and its -wal separately
  // shipped the old file with a fresh WAL: 0 members, integrity_check "ok".
  const Db = require(join(here, '..', 'db.js'));
  const fs = require('node:fs');
  for (const pack of ['packBundleAsync', 'packBundle']) {
    const d = mkdtempSync(join(tmpdir(), 'ledger-wal-'));
    const s = Db.open(d); s.db.exec('PRAGMA wal_autocheckpoint = 0');
    writeFileSync(join(d, 'ledger-data.json'), '{"rev":1}');
    for (let i = 0; i < 50; i++) s.q('INSERT INTO members (id, data) VALUES (?, ?)').run('m' + i, '{"id":"m' + i + '"}');
    ok(existsSync(join(d, 'pulse.db-wal')), 'the rows are in the WAL');
    // between any two reads of the bundle: a checkpoint, then the next write restarts the WAL
    const meddle = () => { s.db.exec('PRAGMA wal_checkpoint(PASSIVE)'); s.q('INSERT OR REPLACE INTO kv (k, v) VALUES (?, ?)').run('later', String(Math.random())); };
    const origA = fs.promises.readFile, origS = fs.readFileSync;
    fs.promises.readFile = async (p, ...a) => { const b = await origA(p, ...a); meddle(); return b; };
    fs.readFileSync = (p, ...a) => { const b = origS(p, ...a); if (String(p).startsWith(d)) meddle(); return b; };
    let b; try { b = await O[pack](d); } finally { fs.promises.readFile = origA; fs.readFileSync = origS; }
    const files = O.unpackBundle(b.buf).map(f => f.p).sort();
    eq(files, ['ledger-data.json', 'pulse.db'], pack + ': the database alone, never its -wal/-shm');
    ok(!fs.readdirSync(d).some(f => f.endsWith('.tmp')), pack + ': the temporary copy is cleaned up');
    const out = mkdtempSync(join(tmpdir(), 'ledger-wal-restored-'));
    O.restoreBundle(b.buf, out);
    const r = Db.open(out);
    eq(r.q('SELECT count(*) n FROM members').get().n, 50, pack + ': every committed member is in the restored copy');
    eq(r.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    r.close(); s.close();
  }
});

console.log('\nServer wiring (fake S3 that verifies signatures)');
const CREDS = { accessKeyId: 'AKTEST', secretAccessKey: 'shh' };
function fakeS3() {
  const objects = new Map(); const log = [];
  const srv = http.createServer((req, res) => {
    const chunks = []; req.on('data', c => chunks.push(c)); req.on('end', () => {
      const body = Buffer.concat(chunks);
      const u = new URL(req.url, 'http://x'); const q = Object.fromEntries(u.searchParams);
      const h = { host: req.headers.host, 'x-amz-date': req.headers['x-amz-date'], 'x-amz-content-sha256': req.headers['x-amz-content-sha256'] };
      if (req.headers['content-type'] && req.method === 'PUT') h['content-type'] = req.headers['content-type'];
      const want = O.sigv4({ method: req.method, path: u.pathname, query: q, headers: h, region: 'us-east-1', ...CREDS });
      if (req.headers.authorization !== want) { log.push('BADSIG ' + req.method); res.writeHead(403); return res.end('<Error><Code>SignatureDoesNotMatch</Code></Error>'); }
      const key = decodeURIComponent(u.pathname.replace(/^\/bkt\/?/, ''));
      log.push(req.method + ' ' + (key || '?' + u.search));
      if (req.method === 'PUT') { objects.set(key, body); res.writeHead(200); return res.end(); }
      if (req.method === 'DELETE') { objects.delete(key); res.writeHead(204); return res.end(); }
      if (req.method === 'GET' && !key) {
        const items = [...objects.keys()].filter(k => k.startsWith(q.prefix || '')).sort();
        res.writeHead(200, { 'content-type': 'application/xml' });
        return res.end('<ListBucketResult><IsTruncated>false</IsTruncated>' + items.map(k => '<Contents><Key>' + k + '</Key><Size>' + objects.get(k).length + '</Size></Contents>').join('') + '</ListBucketResult>');
      }
      if (req.method === 'GET' && objects.has(key)) { res.writeHead(200); return res.end(objects.get(key)); }
      res.writeHead(404); res.end('<Error><Code>NoSuchKey</Code></Error>');
    });
  });
  return { srv, objects, log };
}
const listen = s => new Promise(r => s.listen(0, '127.0.0.1', () => r('http://127.0.0.1:' + s.address().port)));

await t('a server backup is mirrored encrypted; /api/offsite/run ships a restorable bundle; retention prunes', async () => {
  const s3 = fakeS3(); const s3url = await listen(s3.srv);
  const dataDir = mkdtempSync(join(tmpdir(), 'ledger-offsite-'));
  const app = createApp({ dataDir, auth: 'secret', htmlPath: join(here, '..', 'ledger.html'), push: false, offsiteTimer: false,
    offsite: { endpoint: s3url, bucket: 'bkt', region: 'us-east-1', prefix: 'ledger/', keep: 2, passphrase: 'pp', ...CREDS } });
  const base = await listen(app);
  const H = { Authorization: 'Bearer secret', 'Content-Type': 'application/json' };
  eq((await fetch(base + '/api/data', { method: 'PUT', headers: H, body: JSON.stringify({ rev: 0, snapshot: { app: 'ledger', journal: { a: { notes: 'hi' } }, wallets: [] } }) })).status, 200);

  const bk = await (await fetch(base + '/api/backup', { method: 'POST', headers: H, body: JSON.stringify({ app: 'ledger', journal: { x: 1 } }) })).json();
  eq(bk.offsite, 'uploading');
  for (let i = 0; i < 50 && ![...s3.objects.keys()].some(k => k.startsWith('ledger/backup/')); i++) await new Promise(r => setTimeout(r, 20));
  const bkKey = [...s3.objects.keys()].find(k => k.startsWith('ledger/backup/'));
  ok(bkKey && bkKey.endsWith('.json.gz.enc'), 'backup object: ' + JSON.stringify(s3.log));
  eq(JSON.parse(zlib.gunzipSync(O.decrypt(s3.objects.get(bkKey), 'pp')).toString()), { app: 'ledger', journal: { x: 1 } });

  for (let i = 0; i < 3; i++) {
    const r = await fetch(base + '/api/offsite/run', { method: 'POST', headers: H });
    eq(r.status, 200, 'run ' + i);
    await new Promise(r => setTimeout(r, 5)); // distinct timestamps in the keys
  }
  const bundles = [...s3.objects.keys()].filter(k => k.startsWith('ledger/data/'));
  eq(bundles.length, 2, 'keep=2 prunes the oldest: ' + JSON.stringify(bundles));
  ok(!s3.log.some(l => l.startsWith('BADSIG')), 'every request signed correctly');
  const out = mkdtempSync(join(tmpdir(), 'ledger-offsite-restore-'));
  O.restoreBundle(O.decrypt(s3.objects.get(bundles.sort().pop()), 'pp'), out);
  ok(existsSync(join(out, 'ledger-data.json')), 'journal in the bundle');
  ok(readFileSync(join(out, 'ledger-data.json'), 'utf8').includes('"hi"'));
  ok(!existsSync(join(out, 'backups')), 'backups are mirrored separately, not bundled');

  const meta = await (await fetch(base + '/api/v1/meta', { headers: H })).json();
  ok(meta.offsite.enabled && meta.offsite.lastOkAt > 0 && !meta.offsite.lastError, JSON.stringify(meta.offsite));
  eq((await fetch(base + '/api/offsite/run', { method: 'POST' })).status, 401, 'needs the full token');
  await new Promise(r => app.close(r)); s3.srv.close();
});
await t('a rejected upload is reported (meta + 502), and off-site off answers 409', async () => {
  const s3 = fakeS3(); const s3url = await listen(s3.srv);
  const dataDir = mkdtempSync(join(tmpdir(), 'ledger-offsite-bad-'));
  const app = createApp({ dataDir, auth: 'secret', htmlPath: join(here, '..', 'ledger.html'), push: false, offsiteTimer: false,
    offsite: { endpoint: s3url, bucket: 'bkt', region: 'us-east-1', prefix: 'ledger/', keep: 2, passphrase: 'pp', accessKeyId: 'AKTEST', secretAccessKey: 'WRONG' } });
  const base = await listen(app);
  const H = { Authorization: 'Bearer secret' };
  const r = await fetch(base + '/api/offsite/run', { method: 'POST', headers: H });
  eq(r.status, 502); ok((await r.json()).error.includes('SignatureDoesNotMatch'));
  const meta = await (await fetch(base + '/api/v1/meta', { headers: H })).json();
  ok(/403/.test(meta.offsite.lastError), JSON.stringify(meta.offsite));
  await new Promise(r => app.close(r)); s3.srv.close();
  const off = createApp({ dataDir: mkdtempSync(join(tmpdir(), 'ledger-offsite-off-')), auth: 'secret', htmlPath: join(here, '..', 'ledger.html'), push: false });
  const b2 = await listen(off);
  eq((await fetch(b2 + '/api/offsite/run', { method: 'POST', headers: H })).status, 409);
  await new Promise(r => off.close(r));
});

report('offsite');
