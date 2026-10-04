// archive.js — Hyperliquid's node-data archive on S3: the fills the public API no longer serves.
//
// Hyperliquid keeps TWAP slice fills for about three months and ordinary fills for a finite time, but
// its node software streams every fill of every address, in the API's own fill format, into a
// requester-pays S3 bucket (hl-mainnet-node-data, node_fills/hourly/{YYYYMMDD}/{hour}). This module
// reads it with no dependencies: SigV4 signing for ListObjectsV2 and GetObject, an LZ4 frame decoder
// (the archive's files are lz4 frames, gzip or plain JSON lines), a fill extractor that finds one
// address's fills in whatever line shape a file has, a planner that turns the seams
// reconstructTrades found into the hours worth downloading, and a backfill job that merges what it
// finds into the server's fill cache. Credentials come from the environment (ARCHIVE_AWS_KEY_ID,
// ARCHIVE_AWS_SECRET) and go nowhere but AWS; every request carries x-amz-request-payer, so the
// transfer is billed to that account — the planner says how much before anything is downloaded.
'use strict';
const crypto = require('crypto');
const zlib = require('zlib');

/* ============================ SigV4 (S3) ============================ */
const sha256 = b => crypto.createHash('sha256').update(b).digest('hex');
const hmac = (k, s) => crypto.createHmac('sha256', k).update(s).digest();
// RFC 3986 as AWS wants it: unreserved characters as they are, everything else %XX (upper case);
// a path keeps its slashes, a query value does not
const enc = (s, keepSlash) => { const e = encodeURIComponent(String(s)).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase()); return keepSlash ? e.replace(/%2F/g, '/') : e; };
const amzDate = d => d.toISOString().replace(/[:-]|\.\d{3}/g, ''); // 20130524T000000Z
// The signature for one request. Header names are lower-cased and values trimmed, headers and query
// parameters sorted, the path encoded once with its slashes kept — the canonical form AWS hashes.
function signV4(o) {
  const service = o.service || 's3', hdrs = Object.assign({ host: o.host }, o.headers || {});
  const canon = Object.keys(hdrs).map(k => [k.toLowerCase(), String(hdrs[k]).trim().replace(/\s+/g, ' ')]).sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  const signedHeaders = canon.map(h => h[0]).join(';'), canonHeaders = canon.map(h => h[0] + ':' + h[1] + '\n').join('');
  const q = Object.keys(o.query || {}).sort().map(k => enc(k) + '=' + enc(o.query[k] == null ? '' : o.query[k])).join('&');
  const canonicalRequest = [o.method, enc(o.path, true), q, canonHeaders, signedHeaders, o.payloadHash].join('\n');
  const stamp = amzDate(o.date), day = stamp.slice(0, 8), scope = day + '/' + o.region + '/' + service + '/aws4_request';
  const stringToSign = ['AWS4-HMAC-SHA256', stamp, scope, sha256(canonicalRequest)].join('\n');
  const kSign = hmac(hmac(hmac(hmac('AWS4' + o.secret, day), o.region), service), 'aws4_request');
  const signature = crypto.createHmac('sha256', kSign).update(stringToSign).digest('hex');
  return { authorization: 'AWS4-HMAC-SHA256 Credential=' + o.keyId + '/' + scope + ', SignedHeaders=' + signedHeaders + ', Signature=' + signature,
    canonicalRequest, stringToSign, signature, query: q };
}

/* ============================ S3 client ============================ */
const xmlText = (s, tag) => { const m = new RegExp('<' + tag + '>([^<]*)</' + tag + '>').exec(s); return m ? m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'") : null; };
const xmlAll = (s, tag) => { const out = [], re = new RegExp('<' + tag + '>([\\s\\S]*?)</' + tag + '>', 'g'); let m; while ((m = re.exec(s))) out.push(m[1]); return out; };
// GET and ListObjectsV2 against one bucket, requester pays. The bucket's region is learned from the
// first answer when it isn't the default: S3 names it (x-amz-bucket-region, or the error body) and
// the request is signed again for it.
function s3Client(cfg) {
  const fetchFn = cfg.fetchImpl || ((...a) => globalThis.fetch(...a)), now = cfg.now || Date.now;
  let region = cfg.region || null;
  const hostFor = r => cfg.bucket + '.s3.' + (r && r !== 'us-east-1' ? r + '.' : '') + 'amazonaws.com';
  // credentials may be a function (an EC2 role's, renewed by the caller) or fixed
  const creds = async () => typeof cfg.credentials === 'function' ? await cfg.credentials() : (cfg.credentials || { keyId: cfg.keyId, secret: cfg.secret, token: cfg.token });
  async function request(method, path, query, opts, retried) {
    opts = opts || {};
    const c = await creds();
    const r = region || 'us-east-1', host = hostFor(r), date = new Date(now()), payloadHash = opts.body ? sha256(opts.body) : sha256('');
    const headers = Object.assign({ 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate(date) }, cfg.noPayer ? {} : { 'x-amz-request-payer': 'requester' }, c.token ? { 'x-amz-security-token': c.token } : {}, opts.headers || {});
    const s = signV4({ method, host, path, query, headers, payloadHash, region: r, keyId: c.keyId, secret: c.secret, date });
    const url = 'https://' + host + enc(path, true) + (s.query ? '?' + s.query : '');
    const res = await fetchFn(url, { method, headers: Object.assign({ Authorization: s.authorization }, headers), body: opts.body, redirect: 'manual', signal: AbortSignal.timeout(opts.timeout || 180000) });
    const text = res.ok && opts.binary ? null : await res.text().catch(() => '');
    if (!res.ok) {
      const br = (res.headers && res.headers.get && res.headers.get('x-amz-bucket-region')) || xmlText(text || '', 'Region');
      if (!retried && br && br !== r) { region = br; return request(method, path, query, opts, true); }
      const code = xmlText(text || '', 'Code') || ('HTTP ' + res.status), msg = xmlText(text || '', 'Message') || '';
      // say which of the three things it is: the key id, the secret, or what the key is allowed to do
      const hint = code === 'InvalidAccessKeyId' ? ' — ARCHIVE_AWS_KEY_ID isn’t a key AWS knows; copy the Access key ID again'
        : code === 'SignatureDoesNotMatch' ? ' — the key is known but ARCHIVE_AWS_SECRET doesn’t match it; copy the secret again (or make a new access key)'
        : code === 'AccessDenied' && /no resource-based policy allows/.test(msg) ? ' — the key is accepted, but ' + cfg.bucket + ' belongs to a different AWS account than this IAM user (AWS says “resource-based” only across accounts): add a bucket policy on ' + cfg.bucket + ' (S3 → the bucket → Permissions → Bucket policy) that allows that user’s ARN s3:ListBucket on arn:aws:s3:::' + cfg.bucket + ' and s3:GetObject on arn:aws:s3:::' + cfg.bucket + '/*, or re-create the bucket in the user’s own account'
        : code === 'AccessDenied' ? ' — the key and secret are accepted, but this IAM user isn’t allowed to read the bucket: in IAM → Users → the user → Permissions, attach a policy with s3:ListBucket and s3:GetObject on arn:aws:s3:::' + cfg.bucket + ' and arn:aws:s3:::' + cfg.bucket + '/* (or the AWS-managed AmazonS3ReadOnlyAccess)'
        : res.status === 403 ? ' — check ARCHIVE_AWS_KEY_ID / ARCHIVE_AWS_SECRET and the key’s policy' : '';
      const e = new Error('S3 ' + code + (msg ? ': ' + msg : '') + hint);
      e.code = code; e.status = res.status; throw e;
    }
    if (opts.binary) { const len = +(res.headers.get('content-length') || 0); if (opts.maxBytes && len > opts.maxBytes) throw new Error('object is ' + len + ' bytes — over the ' + opts.maxBytes + ' byte limit');
      return Buffer.from(await res.arrayBuffer()); }
    return text;
  }
  // every key under a prefix (with sizes), or with a delimiter the "folders" directly under it
  async function list(prefix, delimiter, limitPages) {
    const keys = [], prefixes = []; let token = null, pages = 0;
    do {
      const q = { 'list-type': '2', prefix, 'max-keys': '1000' }; if (delimiter) q.delimiter = delimiter; if (token) q['continuation-token'] = token;
      const xml = await request('GET', '/', q);
      for (const c of xmlAll(xml, 'Contents')) keys.push({ key: xmlText(c, 'Key'), size: +(xmlText(c, 'Size') || 0), modified: xmlText(c, 'LastModified') });
      for (const p of xmlAll(xml, 'CommonPrefixes')) prefixes.push(xmlText(p, 'Prefix'));
      token = xmlText(xml, 'IsTruncated') === 'true' ? xmlText(xml, 'NextContinuationToken') : null; pages++;
    } while (token && pages < (limitPages || 50));
    return { keys, prefixes, truncated: !!token };
  }
  const get = (key, opts) => request('GET', '/' + key, {}, Object.assign({ binary: true }, opts || {}));
  const put = (key, body, contentType) => request('PUT', '/' + key, {}, { body, headers: { 'content-type': contentType || 'application/octet-stream', 'content-length': String(body.length) } });
  const del = (key) => request('DELETE', '/' + key, {}, {});
  // exists? (a HEAD that reports instead of throwing)
  const head = async key => { const p = await probe('HEAD', '/' + key, {}); return p.ok ? { size: p.size || 0 } : null; };
  // one request, reported rather than thrown: status, S3's error code and message, the region it names
  async function probe(method, path, query, regionOverride, opts) {
    opts = opts || {};
    const c = await creds();
    const r = regionOverride || region || 'us-east-1', host = hostFor(r), date = new Date(now()), payloadHash = sha256('');
    const headers = Object.assign({ 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate(date) }, opts.noPayer || cfg.noPayer ? {} : { 'x-amz-request-payer': 'requester' }, opts.range ? { range: opts.range } : {}, c.token ? { 'x-amz-security-token': c.token } : {});
    const s = signV4({ method, host, path, query, headers, payloadHash, region: r, keyId: c.keyId, secret: c.secret, date });
    const url = 'https://' + host + enc(path, true) + (s.query ? '?' + s.query : '');
    try {
      const res = await fetchFn(url, { method, headers: Object.assign({ Authorization: s.authorization }, headers), redirect: 'manual', signal: AbortSignal.timeout(30000) });
      const text = method === 'HEAD' ? '' : await res.text().catch(() => '');
      const total = /\/(\d+)$/.exec((res.headers.get && res.headers.get('content-range')) || ''); // a ranged GET: the object's whole size
      return { url, signedFor: r, status: res.status, ok: res.ok, code: xmlText(text, 'Code'), message: xmlText(text, 'Message'), size: total ? +total[1] : (+(res.headers.get && res.headers.get('content-length')) || null),
        bucketRegion: (res.headers.get && res.headers.get('x-amz-bucket-region')) || xmlText(text, 'Region') || null,
        prefixes: xmlAll(text, 'CommonPrefixes').map(p => xmlText(p, 'Prefix')).slice(0, 5), keys: xmlAll(text, 'Contents').map(c => xmlText(c, 'Key')).slice(0, 5), bytes: method === 'HEAD' ? null : text.length };
    } catch (e) { return { url, signedFor: r, error: e.message }; }
  }
  return { list, get, put, del, head, probe, region: () => region, host: () => hostFor(region || 'us-east-1'), setRegion: r => { region = r; } };
}

// AWS's own answer to "who is this key": the account and the user or role it belongs to (STS
// GetCallerIdentity, which every valid key may call). Tells a key made under the wrong user apart
// from a policy problem.
async function callerIdentity(cfg, fetchImpl, now) {
  const fetchFn = fetchImpl || ((...a) => globalThis.fetch(...a)), host = 'sts.amazonaws.com', body = 'Action=GetCallerIdentity&Version=2011-06-15';
  const date = new Date((now || Date.now)()), payloadHash = sha256(body);
  const headers = { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8', 'x-amz-date': amzDate(date) };
  const s = signV4({ method: 'POST', host, path: '/', query: {}, headers, payloadHash, region: 'us-east-1', service: 'sts', keyId: cfg.keyId, secret: cfg.secret, date });
  try {
    const res = await fetchFn('https://' + host + '/', { method: 'POST', headers: Object.assign({ Authorization: s.authorization }, headers), body, signal: AbortSignal.timeout(30000) });
    const text = await res.text().catch(() => '');
    return { status: res.status, account: xmlText(text, 'Account'), arn: xmlText(text, 'Arn'), userId: xmlText(text, 'UserId'), code: xmlText(text, 'Code'), message: xmlText(text, 'Message') };
  } catch (e) { return { error: e.message }; }
}

// ListAllMyBuckets, signed for us-east-1 at the service endpoint: allowed by any S3 read-only
// policy and refused by no bucket policy, so a denial here is the account itself (an AWS account
// still pending activation answers AccessDenied to every S3 call while IAM and STS already work).
async function listOwnBuckets(cfg, fetchImpl, now) {
  const fetchFn = fetchImpl || ((...a) => globalThis.fetch(...a)), host = 's3.amazonaws.com', date = new Date((now || Date.now)()), payloadHash = sha256('');
  const headers = { 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate(date) };
  const s = signV4({ method: 'GET', host, path: '/', query: {}, headers, payloadHash, region: 'us-east-1', keyId: cfg.keyId, secret: cfg.secret, date });
  try {
    const res = await fetchFn('https://' + host + '/', { method: 'GET', headers: Object.assign({ Authorization: s.authorization }, headers), signal: AbortSignal.timeout(30000) });
    const text = await res.text().catch(() => '');
    return { status: res.status, ok: res.ok, code: xmlText(text, 'Code'), message: xmlText(text, 'Message'), buckets: xmlAll(text, 'Name').length };
  } catch (e) { return { error: e.message }; }
}

// Credentials for a machine inside AWS: an EC2 instance role, read from the instance metadata service
// (IMDSv2) and renewed a few minutes before they expire. Env variables win when set (a laptop, a test).
function roleCredentials(fetchImpl, env) {
  env = env || process.env; const fetchFn = fetchImpl || ((...a) => globalThis.fetch(...a));
  if (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) return async () => ({ keyId: env.AWS_ACCESS_KEY_ID, secret: env.AWS_SECRET_ACCESS_KEY, token: env.AWS_SESSION_TOKEN || null });
  let cur = null;
  return async () => {
    if (cur && cur.expires - Date.now() > 5 * 60e3) return cur;
    const base = 'http://169.254.169.254/latest/';
    const tok = await (await fetchFn(base + 'api/token', { method: 'PUT', headers: { 'x-aws-ec2-metadata-token-ttl-seconds': '21600' }, signal: AbortSignal.timeout(5000) })).text();
    const h = { 'x-aws-ec2-metadata-token': tok };
    const role = (await (await fetchFn(base + 'meta-data/iam/security-credentials/', { headers: h, signal: AbortSignal.timeout(5000) })).text()).trim().split('\n')[0];
    if (!role) throw new Error('no IAM role is attached to this instance');
    const j = await (await fetchFn(base + 'meta-data/iam/security-credentials/' + role, { headers: h, signal: AbortSignal.timeout(5000) })).json();
    cur = { keyId: j.AccessKeyId, secret: j.SecretAccessKey, token: j.Token, expires: Date.parse(j.Expiration) || (Date.now() + 3600e3), role };
    return cur;
  };
}

/* ============================ LZ4 frames ============================ */
// A plain decoder for the LZ4 frame format (magic 0x184D2204): the descriptor, then blocks of
// (size, data), each either stored or LZ4-compressed, to the end mark. Blocks are decoded into one
// buffer per frame, so linked blocks (matches reaching back into the block before) just work;
// checksums are skipped, not verified. Skippable frames and several frames in a row are handled.
function lz4Decode(buf) {
  const chunks = []; let pos = 0;
  while (pos + 4 <= buf.length) {
    const magic = buf.readUInt32LE(pos);
    if (magic === 0x184D2204) pos = lz4Frame(buf, pos + 4, chunks);
    else if ((magic & 0xFFFFFFF0) === 0x184D2A50) pos += 8 + buf.readUInt32LE(pos + 4); // skippable frame
    else throw new Error('lz4: not a frame at byte ' + pos);
  }
  return Buffer.concat(chunks);
}
function lz4Frame(buf, pos, chunks) {
  const flg = buf[pos], bd = buf[pos + 1]; pos += 2;
  if ((flg >> 6) !== 1) throw new Error('lz4: unsupported frame version');
  const blockChecksum = !!(flg & 0x10), contentSize = !!(flg & 0x08), contentChecksum = !!(flg & 0x04), dictId = !!(flg & 0x01);
  if (contentSize) pos += 8; if (dictId) pos += 4; pos += 1; // header checksum
  const maxBlock = [0, 0, 0, 0, 64 << 10, 256 << 10, 1 << 20, 4 << 20][(bd >> 4) & 7] || (4 << 20);
  let out = Buffer.allocUnsafe(Math.max(maxBlock * 2, 1 << 20)), op = 0;
  const ensure = n => { if (op + n > out.length) { let L = out.length; while (op + n > L) L *= 2; const nb = Buffer.allocUnsafe(L); out.copy(nb, 0, 0, op); out = nb; } };
  for (;;) {
    if (pos + 4 > buf.length) throw new Error('lz4: truncated frame');
    const sz = buf.readUInt32LE(pos); pos += 4;
    if (sz === 0) break;
    const len = sz & 0x7FFFFFFF, end = pos + len;
    if (end > buf.length) throw new Error('lz4: truncated block');
    if (sz & 0x80000000) { ensure(len); buf.copy(out, op, pos, end); op += len; }
    else {
      let ip = pos;
      while (ip < end) {
        const token = buf[ip++]; let lit = token >> 4;
        if (lit === 15) { let b; do { b = buf[ip++]; lit += b; } while (b === 255); }
        ensure(lit); buf.copy(out, op, ip, ip + lit); op += lit; ip += lit;
        if (ip >= end) break; // the last sequence is literals only
        const offset = buf[ip] | (buf[ip + 1] << 8); ip += 2;
        let ml = (token & 15) + 4;
        if ((token & 15) === 15) { let b; do { b = buf[ip++]; ml += b; } while (b === 255); }
        if (!offset || offset > op) throw new Error('lz4: bad match offset');
        ensure(ml); let ref = op - offset;
        if (offset >= ml) { out.copy(out, op, ref, ref + ml); op += ml; }
        else for (let i = 0; i < ml; i++) out[op++] = out[ref++]; // overlapping: a repeating pattern
      }
    }
    pos = end; if (blockChecksum) pos += 4;
  }
  if (contentChecksum) pos += 4;
  chunks.push(out.subarray(0, op));
  return pos;
}
// The same decoder, streaming: each block is decoded and handed on, and only the last 64 KB of output
// is kept as history for the next block's matches (LZ4 offsets never reach further back). An hour of
// the archive is 20–50 MB compressed and several times that decoded; this reads it in a few MB.
function lz4Stream(buf, onChunk) {
  const WINDOW = 65536; let pos = 0;
  while (pos + 4 <= buf.length) {
    const magic = buf.readUInt32LE(pos);
    if ((magic & 0xFFFFFFF0) === 0x184D2A50) { pos += 8 + buf.readUInt32LE(pos + 4); continue; }
    if (magic !== 0x184D2204) throw new Error('lz4: not a frame at byte ' + pos);
    pos += 4;
    const flg = buf[pos], bd = buf[pos + 1]; pos += 2;
    if ((flg >> 6) !== 1) throw new Error('lz4: unsupported frame version');
    const blockChecksum = !!(flg & 0x10), contentSize = !!(flg & 0x08), contentChecksum = !!(flg & 0x04), dictId = !!(flg & 0x01);
    if (contentSize) pos += 8; if (dictId) pos += 4; pos += 1;
    const maxBlock = [0, 0, 0, 0, 64 << 10, 256 << 10, 1 << 20, 4 << 20][(bd >> 4) & 7] || (4 << 20);
    let out = Buffer.allocUnsafe(WINDOW + maxBlock * 2), op = 0; // history + this block
    const ensure = n => { if (op + n > out.length) { const nb = Buffer.allocUnsafe(Math.max(out.length * 2, op + n)); out.copy(nb, 0, 0, op); out = nb; } };
    for (;;) {
      if (pos + 4 > buf.length) throw new Error('lz4: truncated frame');
      const sz = buf.readUInt32LE(pos); pos += 4;
      if (sz === 0) break;
      const len = sz & 0x7FFFFFFF, end = pos + len; if (end > buf.length) throw new Error('lz4: truncated block');
      const start = op;
      if (sz & 0x80000000) { ensure(len); buf.copy(out, op, pos, end); op += len; }
      else {
        let ip = pos;
        while (ip < end) {
          const token = buf[ip++]; let lit = token >> 4;
          if (lit === 15) { let b; do { b = buf[ip++]; lit += b; } while (b === 255); }
          ensure(lit); buf.copy(out, op, ip, ip + lit); op += lit; ip += lit;
          if (ip >= end) break;
          const offset = buf[ip] | (buf[ip + 1] << 8); ip += 2;
          let ml = (token & 15) + 4;
          if ((token & 15) === 15) { let b; do { b = buf[ip++]; ml += b; } while (b === 255); }
          if (!offset || offset > op) throw new Error('lz4: bad match offset');
          ensure(ml); let ref = op - offset;
          if (offset >= ml) { out.copy(out, op, ref, ref + ml); op += ml; }
          else for (let i = 0; i < ml; i++) out[op++] = out[ref++];
        }
      }
      onChunk(out.subarray(start, op));
      // keep only the window: the next block may reach back at most 64 KB
      if (op > WINDOW) { out.copy(out, 0, op - WINDOW, op); op = WINDOW; }
      pos = end; if (blockChecksum) pos += 4;
    }
    if (contentChecksum) pos += 4;
  }
}
// One address's fills straight out of a downloaded object, line by line, without holding the decoded
// text: the same walk as extractFills, over a line buffer fed by the streaming decoder (lz4), by
// zlib's streaming inflate (gzip) or by the bytes themselves. Returns extractFills' shape plus the
// encoding and the first bytes of text (for a preview).
function extractFillsFromObject(buf, addr, opts) {
  opts = opts || {}; const previewMax = opts.preview || 0;
  const want = String(addr || '').toLowerCase(), out = [], shapes = {}; let lines = 0, parsed = 0, seen = 0, preview = '';
  const walk = (n, d) => {
    if (!n || typeof n !== 'object' || d > 10) return;
    if (Array.isArray(n)) {
      if (n.length === 2 && typeof n[0] === 'string' && isFill(n[1])) { seen++; shapes.pair = (shapes.pair || 0) + 1; if (n[0].toLowerCase() === want) out.push(normFill(n[1])); return; }
      for (const x of n) walk(x, d + 1); return;
    }
    if (isFill(n)) { const u = n.user || n.address; if (typeof u === 'string') { seen++; shapes.user = (shapes.user || 0) + 1; if (u.toLowerCase() === want) out.push(normFill(n)); return; } }
    if (n.fill && isFill(n.fill) && typeof n.user === 'string') { seen++; shapes.obj = (shapes.obj || 0) + 1; if (n.user.toLowerCase() === want) out.push(normFill(n.fill)); return; }
    for (const k in n) walk(n[k], d + 1);
  };
  const line = s => { if (!s.trim()) return; lines++; let j; try { j = JSON.parse(s); } catch (e) { return; } parsed++; walk(j, 0); };
  let rest = ''; // the partial line at the end of the previous chunk
  const feed = chunk => {
    if (preview.length < previewMax) preview += chunk.toString('utf8', 0, Math.min(chunk.length, previewMax - preview.length));
    // split on newlines in the bytes; a UTF-8 sequence never contains 0x0A, so cutting there is safe
    let s = 0;
    for (let i = 0; i < chunk.length; i++) if (chunk[i] === 10) { line(rest + chunk.toString('utf8', s, i)); rest = ''; s = i + 1; }
    if (s < chunk.length) rest += chunk.toString('utf8', s);
  };
  let encoding;
  if (buf.length >= 4 && buf.readUInt32LE(0) === 0x184D2204) { encoding = 'lz4'; lz4Stream(buf, feed); }
  else if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) { encoding = 'gzip'; feed(zlib.gunzipSync(buf)); }
  else { encoding = 'plain'; feed(buf); }
  if (rest) { line(rest); rest = ''; }
  return { fills: out, lines, parsed, seen, shapes, encoding, preview };
}
// a downloaded object as text, whatever it was compressed with
function decodeObject(buf) {
  if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) return { text: zlib.gunzipSync(buf).toString('utf8'), encoding: 'gzip' };
  if (buf.length >= 4 && buf.readUInt32LE(0) === 0x184D2204) return { text: lz4Decode(buf).toString('utf8'), encoding: 'lz4' };
  return { text: buf.toString('utf8'), encoding: 'plain' };
}

/* ============================ fills in a file ============================ */
const FILL_KEYS = ['coin', 'px', 'sz', 'side', 'time'];
const isFill = o => !!o && typeof o === 'object' && !Array.isArray(o) && FILL_KEYS.every(k => o[k] != null);
// a fill as the API would give it: time in ms, ids present (an older file without a tid is keyed by
// its hash, time, coin and size, so the same fill never lands twice)
function normFill(f) {
  const o = Object.assign({}, f);
  if (typeof o.time === 'string' && !/^\d+$/.test(o.time)) { const t = Date.parse(o.time.endsWith('Z') || /[+-]\d\d:\d\d$/.test(o.time) ? o.time : o.time + 'Z'); if (isFinite(t)) o.time = t; }
  else o.time = +o.time;
  if (o.time < 1e12) o.time *= 1000; // seconds
  if (o.tid == null) o.tid = 'ar:' + String(o.hash || '').slice(0, 18) + ':' + o.time + ':' + o.coin + ':' + o.sz + ':' + o.side;
  if (o.oid == null) o.oid = 0;
  delete o.user; delete o.address;
  return o;
}
// One address's fills in a file of JSON lines, whatever shape each line has: node_fills lines carry
// [address, fill] pairs under "events", older formats {user, fill} objects or fills with a user field.
// The walker finds all three anywhere in a line (a few levels deep), so a format change in the
// archive shows up as "shapes" in the sample rather than as silence.
function extractFills(text, addr) {
  const want = String(addr || '').toLowerCase(), out = [], shapes = {}; let lines = 0, parsed = 0, seen = 0;
  const walk = (n, d) => {
    if (!n || typeof n !== 'object' || d > 10) return;
    if (Array.isArray(n)) {
      if (n.length === 2 && typeof n[0] === 'string' && isFill(n[1])) { seen++; shapes.pair = (shapes.pair || 0) + 1; if (n[0].toLowerCase() === want) out.push(normFill(n[1])); return; }
      for (const x of n) walk(x, d + 1); return;
    }
    if (isFill(n)) { const u = n.user || n.address; if (typeof u === 'string') { seen++; shapes.user = (shapes.user || 0) + 1; if (u.toLowerCase() === want) out.push(normFill(n)); return; } }
    if (n.fill && isFill(n.fill) && typeof n.user === 'string') { seen++; shapes.obj = (shapes.obj || 0) + 1; if (n.user.toLowerCase() === want) out.push(normFill(n.fill)); return; }
    for (const k in n) walk(n[k], d + 1);
  };
  for (const line of String(text).split('\n')) { if (!line.trim()) continue; lines++; let j; try { j = JSON.parse(line); } catch (e) { continue; } parsed++; walk(j, 0); }
  return { fills: out, lines, parsed, seen, shapes };
}

/* ============================ what to download ============================ */
const HOUR = 3600e3;
const hourOf = ms => Math.floor(ms / HOUR);
const dayKeyOf = h => { const d = new Date(h * HOUR); return d.getUTCFullYear() + String(d.getUTCMonth() + 1).padStart(2, '0') + String(d.getUTCDate()).padStart(2, '0'); };
const hourInDay = h => new Date(h * HOUR).getUTCHours();
// The seams in a wallet's perp fills (engine: reconstructTrades) as time windows — from the coin's last
// served fill before the seam to the fill that revealed it — and the UTC hours they cover. Windows
// longer than maxDays are kept out of the hours (and reported), so one unexplained month doesn't
// turn into a month of downloads.
// scope 'exits' (the default): only the seams on trades that closed or shrank off the record — the fills
// that carry P&L; 'all' adds the seams where a position opened off the record, which cost only an entry.
function seamWindows(fills, E, opts) {
  opts = opts || {}; const maxDays = opts.maxDays || 14, all = opts.scope === 'all';
  const perp = (fills || []).filter(f => f && typeof f.coin === 'string' && !f.coin.includes('/') && !f.coin.startsWith('@')).sort((a, b) => a.time - b.time);
  const trades = E.reconstructTrades(perp, 'x', 'perp');
  const times = {}; for (const f of perp) (times[f.coin] = times[f.coin] || []).push(f.time);
  const seams = [], skipped = [], hours = new Set();
  for (const t of trades) for (const g of (t.gapTimes || [])) {
    if (!all && !t.offRecord) continue;
    const T = times[t.coin] || []; let lo = 0, hi = T.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (T[m] < g) lo = m + 1; else hi = m; }
    if (!lo) continue;
    const w = { coin: t.coin, from: T[lo - 1], to: g, days: +((g - T[lo - 1]) / 86400e3).toFixed(2) };
    if (w.days > maxDays) { skipped.push(w); continue; }
    seams.push(w);
    for (let h = hourOf(w.from); h <= hourOf(w.to); h++) hours.add(h);
  }
  return { seams, skipped, hours: [...hours].sort((a, b) => a - b) };
}

/* ============================ the archive, wired to a server ============================ */
// deps: { env, fetchImpl, now, engine (E, for reconstructTrades), readFills(addr) -> fills[],
//         writeFills(addr, newFills, info) -> {added}, log }
function createArchive(deps) {
  const env = deps.env || process.env, log = deps.log || (() => {});
  const cfg = { keyId: String(env.ARCHIVE_AWS_KEY_ID || '').trim(), secret: String(env.ARCHIVE_AWS_SECRET || '').trim(),
    bucket: String(env.ARCHIVE_BUCKET || 'hl-mainnet-node-data').trim(), region: String(env.ARCHIVE_REGION || '').trim() || null,
    prefix: String(env.ARCHIVE_PREFIX || 'node_fills_by_block/hourly/').replace(/^\/+/, '').replace(/\/*$/, '/'),
    costPerGB: Math.max(0, parseFloat(env.ARCHIVE_COST_PER_GB) || 0.09), maxDays: Math.max(1, parseInt(env.ARCHIVE_MAX_WINDOW_DAYS, 10) || 14) };
  // the index by wallet (archive-indexer.js), when one has been built: the same key reads it
  cfg.indexBucket = String(env.ARCHIVE_INDEX_BUCKET || '').trim(); cfg.indexPrefix = String(env.ARCHIVE_INDEX_PREFIX || 'index/v1/').replace(/^\/+/, '').replace(/\/*$/, '/');
  cfg.indexRegion = String(env.ARCHIVE_INDEX_REGION || '').trim() || null;
  const configured = !!(cfg.keyId && cfg.secret);
  const s3 = configured ? s3Client({ keyId: cfg.keyId, secret: cfg.secret, bucket: cfg.bucket, region: cfg.region, fetchImpl: deps.fetchImpl, now: deps.now }) : null;
  const ix = configured && cfg.indexBucket ? s3Client({ keyId: cfg.keyId, secret: cfg.secret, bucket: cfg.indexBucket, region: cfg.indexRegion, fetchImpl: deps.fetchImpl, now: deps.now, noPayer: true }) : null;
  const shardOf = a => String(a).slice(2, 5).toLowerCase();
  // the index's days (each a finished day: its _done marker exists) and its progress note
  async function indexDays() {
    if (!ix) return null;
    const r = await ix.list(cfg.indexPrefix + 'd/', '/', 20);
    const days = r.prefixes.map(p => p.slice((cfg.indexPrefix + 'd/').length).replace(/\/$/, '')).filter(d => /^\d{8}$/.test(d)).sort();
    let progress = null; try { progress = JSON.parse((await ix.get(cfg.indexPrefix + 'progress.json')).toString('utf8')); } catch (e) {}
    return { bucket: cfg.indexBucket, prefix: cfg.indexPrefix, days, first: days[0] || null, last: days[days.length - 1] || null, progress };
  }
  // one wallet's fills out of the index: its shard's file for every day (from `fromDay` on), a few at a time
  async function indexFetch(addr, fromDay, onProgress) {
    const d = await indexDays(); if (!d) throw Object.assign(new Error('no index bucket is configured (ARCHIVE_INDEX_BUCKET)'), { code: 503 });
    const days = d.days.filter(x => !fromDay || x >= fromDay), sh = shardOf(addr), fills = []; let bytes = 0, files = 0, missing = 0;
    const queue = days.slice();
    const worker = async () => { for (;;) { const day = queue.shift(); if (!day) return;
      let buf = null; try { buf = await ix.get(cfg.indexPrefix + 'd/' + day + '/' + sh + '.jsonl.gz'); } catch (e) { if (e.status === 404 || e.code === 'NoSuchKey') { missing++; continue; } throw e; }
      bytes += buf.length; files++;
      const x = extractFillsFromObject(buf, addr); fills.push(...x.fills);
      if (onProgress) onProgress({ done: files + missing, total: days.length, fills: fills.length, bytes }); } };
    await Promise.all(Array.from({ length: 8 }, worker));
    return { fills, days: days.length, files, missing, bytes, first: d.first, last: d.last };
  }
  const need = () => { if (!configured) { const e = new Error('the archive isn’t configured: set ARCHIVE_AWS_KEY_ID and ARCHIVE_AWS_SECRET on the server (an AWS key with s3:GetObject and s3:ListBucket on ' + cfg.bucket + ')'); e.code = 503; throw e; } };
  const gb = b => b / 1073741824, cost = b => +(gb(b) * cfg.costPerGB).toFixed(2);
  let lastCheck = null, job = null;
  // Reading by name when listing is refused. The archive's keys are predictable
  // ({prefix}{YYYYMMDD}/{hour}), so a bucket policy that allows GetObject but not ListBucket still
  // lets the exact hours be read: the naming variant (hour padded or not, an .lz4 suffix or not) is
  // learned from the first file that answers and kept. Without ListBucket, S3 answers 403 for a key
  // that doesn't exist, so "not 200" is read as "not there".
  let noList = false, naming = null;
  const NAMINGS = [{ pad: false, ext: '.lz4' }, { pad: false, ext: '' }, { pad: true, ext: '.lz4' }, { pad: true, ext: '' }]; // node_fills_by_block/hourly/20260918/9.lz4 is the documented shape
  const keyFor = (prefix, day, hour, nm) => prefix + day + '/' + (nm.pad ? String(hour).padStart(2, '0') : String(hour)) + nm.ext;
  const headCache = new Map(); // key -> {key,size,hour} | null
  async function headHour(day, hour, prefix) {
    prefix = prefix || cfg.prefix; const ck = prefix + day + '/' + hour;
    if (headCache.has(ck)) return headCache.get(ck);
    let found = null;
    for (const nm of (naming ? [naming] : NAMINGS)) {
      const key = keyFor(prefix, day, hour, nm), r = await s3.probe('HEAD', '/' + key, {});
      if (r.ok) { if (prefix === cfg.prefix) naming = nm; found = { key, size: r.size || 0, hour }; break; }
    }
    headCache.set(ck, found); return found;
  }
  const dayCache = new Map(); // day -> [{key,size,hour}] (listing mode)
  const hourNum = key => { const m = /\/(\d{1,2})(?:\.[A-Za-z0-9]+)?$/.exec(key); return m ? +m[1] : null; };
  const denied = e => e && (e.code === 'AccessDenied' || e.status === 403);
  // the objects for a day's hours (all of them, or the ones wanted): listed when the bucket allows it, read by name when it doesn't
  async function dayKeys(day, hoursWanted) {
    if (!noList) {
      if (dayCache.has(day)) return dayCache.get(day);
      try { const r = await s3.list(cfg.prefix + day + '/'); const rows = r.keys.map(k => ({ key: k.key, size: k.size, hour: hourNum(k.key) })).filter(k => k.hour != null); dayCache.set(day, rows); return rows; }
      catch (e) { if (!denied(e)) throw e; noList = true; }
    }
    const rows = []; for (const h of (hoursWanted || Array.from({ length: 24 }, (_, i) => i))) { const k = await headHour(day, h); if (k) rows.push(k); }
    return rows;
  }
  const dayStr = ms => dayKeyOf(hourOf(ms));
  // the archive's days: first and last from a listing, or — reading by name — the first day found by
  // probing noon files month by month back from today (36 months at most), then day by day
  async function days() {
    if (!noList) {
      try { const r = await s3.list(cfg.prefix, '/', 20); const ds = r.prefixes.map(p => p.slice(cfg.prefix.length).replace(/\/$/, '')).filter(d => /^\d{8}$/.test(d)).sort();
        return { days: ds, first: ds[0] || null, last: ds[ds.length - 1] || null, truncated: r.truncated, listed: true }; }
      catch (e) { if (!denied(e)) throw e; noList = true; }
    }
    const now = (deps.now || Date.now)(); let last = null;
    for (const back of [1, 2, 3, 5, 8, 14, 30, 60]) { const ds = dayStr(now - back * 86400e3); if (await headHour(ds, 12)) { last = ds; break; } } // the archive can lag by days
    if (!last) { const e = new Error('S3 refuses both to list ' + cfg.bucket + '/' + cfg.prefix + ' and to read any recent file by name (tried ' + keyFor(cfg.prefix, dayStr(now - 86400e3), 12, NAMINGS[0]) + ' and older): the key’s policy, or the bucket’s, allows neither'); e.code = 403; throw e; }
    const d0 = new Date(now); let firstMonth = null, prevMonth = null;
    for (let i = 0; i < 36; i++) { const m = new Date(Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth() - i, 1)), ds = dayStr(m.getTime());
      if (await headHour(ds, 12)) firstMonth = m; else { prevMonth = m; if (firstMonth) break; } }
    let first = firstMonth ? dayStr(firstMonth.getTime()) : null;
    if (firstMonth && prevMonth) { // the start is somewhere in the month before the first full one: find the day
      let lo = prevMonth.getTime(), hi = firstMonth.getTime(); // lo: missing, hi: present
      while (hi - lo > 86400e3) { const mid = lo + Math.floor((hi - lo) / 86400e3 / 2) * 86400e3; if (await headHour(dayStr(mid), 12)) hi = mid; else lo = mid; }
      first = dayStr(hi);
    }
    return { days: null, first, last, truncated: false, listed: false, note: 'listing is not allowed on this bucket; files are read by name, so the first and last day are found by probing and may be a day off' };
  }
  const haveDay = (d, day) => d.days ? d.days.includes(day) : (d.first ? day >= d.first && day <= d.last : false);
  // before node_fills_by_block began (2025-07-27) the older node_fills dataset holds the same fills in the
  // same format: a day the main dataset lacks is looked up there (listing only; its days are known)
  const OLD_PREFIX = String(env.ARCHIVE_PREFIX_OLD || 'node_fills/hourly/').replace(/^\/+/, '').replace(/\/*$/, '/');
  const oldDayCache = new Map();
  async function oldDayKeys(day) {
    if (noList || OLD_PREFIX === cfg.prefix) return [];
    if (oldDayCache.has(day)) return oldDayCache.get(day);
    let rows = [];
    try { const r = await s3.list(OLD_PREFIX + day + '/'); rows = r.keys.map(k => ({ key: k.key, size: k.size, hour: hourNum(k.key), old: true })).filter(k => k.hour != null); } catch (e) {}
    oldDayCache.set(day, rows); return rows;
  }
  // the hours a wallet's seams need, which of them the archive has, their bytes and cost
  async function plan(addr, fills, d, scope) {
    const sw = seamWindows(fills, deps.engine, { maxDays: cfg.maxDays, scope: scope === 'all' ? 'all' : 'exits' });
    const items = [], missing = [], byDay = {};
    for (const h of sw.hours) (byDay[dayKeyOf(h)] = byDay[dayKeyOf(h)] || []).push(hourInDay(h));
    let listedDays = 0;
    let fromOld = 0;
    for (const day of Object.keys(byDay).sort()) {
      if (!haveDay(d, day)) {
        const rows = await oldDayKeys(day); // the older dataset, if it has the day
        for (const hr of byDay[day]) { const k = rows.find(x => x.hour === hr); if (k) { items.push(k); fromOld++; } else missing.push(day + '/' + hr); }
        continue; }
      const rows = await dayKeys(day, byDay[day]); listedDays++;
      for (const hr of byDay[day]) { const k = rows.find(x => x.hour === hr); if (k) items.push(k); else missing.push(day + '/' + hr); }
    }
    const bytes = items.reduce((s, k) => s + k.size, 0);
    return { address: addr, scope: scope === 'all' ? 'all' : 'exits', seams: sw.seams.length, skippedLong: sw.skipped, hours: sw.hours.length, items, missing, fromOld, bytes, estGB: +gb(bytes).toFixed(3), estCost: cost(bytes), listedDays };
  }
  async function check(wallets, scope) {
    need();
    const d = await days(); const out = { bucket: cfg.bucket, prefix: cfg.prefix, region: s3.region(), costPerGB: cfg.costPerGB, archive: d, noList, sampleDay: null, wallets: [], index: null };
    if (ix) { try { out.index = await indexDays(); } catch (e) { out.index = { bucket: cfg.indexBucket, error: e.message }; } }
    if (d.last) { const rows = await dayKeys(d.last, noList ? [0, 6, 12, 18] : null); const bytes = rows.reduce((s, k) => s + k.size, 0);
      out.sampleDay = { day: d.last, hours: rows.length, bytes, perHour: rows.length ? Math.round(bytes / rows.length) : 0, firstKey: rows[0] && rows[0].key, sampled: noList }; }
    for (const w of wallets || []) {
      try { const p = await plan(w.address, w.fills || deps.readFills(w.address) || [], d, scope); delete p.items; out.wallets.push(p); }
      catch (e) { out.wallets.push({ address: w.address, error: e.message }); }
    }
    lastCheck = Object.assign({ at: Date.now() }, out); return out;
  }
  // one hour, decoded: what the file looks like and what it holds for the given addresses
  async function sample(o) {
    need(); o = o || {};
    let key = o.key;
    if (!key) { const d = o.day || (await days()).last; if (!d) throw Object.assign(new Error('the archive has no days under ' + cfg.prefix), { code: 404 });
      const hr = o.hour != null ? +o.hour : 12, rows = await dayKeys(d, [hr]); const k = rows.find(x => x.hour === hr) || rows[0];
      if (!k) throw Object.assign(new Error('no file for ' + d + '/' + hr), { code: 404 }); key = k.key; }
    const buf = await s3.get(key, { maxBytes: 512 * 1024 * 1024 });
    const res = { key, bytes: buf.length, wallets: {} };
    for (const a of ((o.addresses && o.addresses.length) ? o.addresses : ['0x'])) { const x = extractFillsFromObject(buf, a, { preview: 1500 });
      if (a !== '0x') res.wallets[a] = { fills: x.fills.length, first: x.fills[0] || null };
      Object.assign(res, { encoding: x.encoding, preview: x.preview, lines: x.lines, parsed: x.parsed, fillsSeen: x.seen, shapes: x.shapes }); }
    return res;
  }
  // the backfill: plan, refuse past the budget, then download hour by hour in the background
  async function backfill(o) {
    need(); o = o || {};
    if (job && job.state === 'running') throw Object.assign(new Error('a backfill is already running'), { code: 409 });
    const addr = String(o.address || '').toLowerCase(), fills = deps.readFills(addr) || [];
    if (!fills.length) throw Object.assign(new Error('no server fill cache for ' + addr + ' — refresh it first'), { code: 404 });
    // with an index: the wallet's shard files, every day the index has — its complete history there,
    // a few MB, no hour-hunting and no budget to speak of
    // — unless the index isn't usable yet (its bucket missing, unreadable, or still empty): then the
    // hours plan below runs as if no index were configured, and the job says why
    let indexSkipped = null;
    if (ix && o.source !== 'hours') {
      try { const d = await indexDays(); if (!d.days.length) indexSkipped = 'the index at ' + cfg.indexBucket + '/' + cfg.indexPrefix + ' has no finished days yet'; }
      catch (e) { indexSkipped = 'the index bucket ' + cfg.indexBucket + ' is not usable: ' + e.message; }
      if (indexSkipped) log('archive: ' + indexSkipped + ' — using the hours plan');
    }
    if (ix && o.source !== 'hours' && !indexSkipped) {
      job = { state: 'running', address: addr, source: 'index', startedAt: Date.now(), total: 0, done: 0, bytes: 0, fills: 0, errors: 0 };
      const cur = job;
      (async () => {
        try { const r = await indexFetch(addr, o.fromDay, p => { cur.total = p.total; cur.done = p.done; cur.fills = p.fills; cur.bytes = p.bytes; });
          cur.total = r.days; cur.done = r.days; cur.fills = r.fills.length; cur.bytes = r.bytes; cur.indexFiles = r.files; cur.indexFirst = r.first; cur.indexLast = r.last;
          const w = deps.writeFills(addr, r.fills, { hours: 0, bytes: r.bytes, index: true }); cur.added = w.added; cur.cacheCount = w.count; cur.state = 'done'; }
        catch (e) { cur.errors++; cur.lastError = e.message; cur.state = 'failed'; }
        cur.finishedAt = Date.now(); cur.cost = 0;
        log('archive: index backfill ' + addr + ' ' + cur.state + ' — ' + cur.fills + ' fills in the index, ' + (cur.added || 0) + ' new, ' + (cur.bytes / 1048576).toFixed(1) + ' MB');
      })();
      return job;
    }
    const d = await days(), p = await plan(addr, fills, d, o.scope);
    const maxGB = parseFloat(o.maxGB) > 0 ? parseFloat(o.maxGB) : 2; // GB; the caller's cap, however small
    if (gb(p.bytes) > maxGB) throw Object.assign(new Error('the plan is ' + p.estGB + ' GB (about $' + p.estCost + ') — over the ' + maxGB + ' GB budget; raise maxGB to go ahead'), { code: 413, plan: Object.assign({}, p, { items: undefined }) });
    const items = p.items.slice();
    job = { state: 'running', address: addr, source: 'hours', indexSkipped, startedAt: Date.now(), total: items.length, done: 0, bytes: 0, fills: 0, errors: 0, lastKey: null, plan: Object.assign({}, p, { items: undefined }), dryRun: !!o.dryRun };
    if (o.dryRun) { job.state = 'done'; job.finishedAt = Date.now(); return job; }
    const found = [], cur = job;
    (async () => {
      for (const it of items) {
        if (cur !== job || cur.state !== 'running') return;
        try { const buf = await s3.get(it.key, { maxBytes: 1024 * 1024 * 1024 }); cur.bytes += buf.length;
          const x = extractFillsFromObject(buf, addr); found.push(...x.fills); cur.fills += x.fills.length; }
        catch (e) { cur.errors++; cur.lastError = e.message; log('archive: ' + it.key + ': ' + e.message); }
        cur.done++; cur.lastKey = it.key;
      }
      try { const r = deps.writeFills(addr, found, { hours: items.length, bytes: cur.bytes }); cur.added = r.added; cur.cacheCount = r.count; }
      catch (e) { cur.errors++; cur.lastError = 'writing the cache: ' + e.message; }
      cur.cost = cost(cur.bytes); cur.state = cur.errors && !cur.done ? 'failed' : 'done'; cur.finishedAt = Date.now();
      log('archive: backfill ' + addr + ' done — ' + cur.done + '/' + cur.total + ' hours, ' + cur.fills + ' fills found, ' + (cur.added || 0) + ' new, ' + (cur.bytes / 1048576).toFixed(1) + ' MB');
    })().catch(e => { cur.state = 'failed'; cur.lastError = e.message; cur.finishedAt = Date.now(); });
    return job;
  }
  // The probes with their raw answers, for when a check fails and the reason isn't on the error: who
  // the key is, the bucket's region, a listing of the bucket root, of the dataset and of the other
  // one, and a read by name of yesterday's noon file under each — the case where the bucket's policy
  // allows GetObject but not ListBucket.
  async function diagnose() {
    need();
    const out = { keyId: cfg.keyId.slice(0, 4) + '…' + cfg.keyId.slice(-4), bucket: cfg.bucket, prefix: cfg.prefix, regionSetting: cfg.region || '(learned)', steps: {} };
    out.steps.identity = await callerIdentity(cfg, deps.fetchImpl, deps.now);
    out.steps.headBucket = await s3.probe('HEAD', '/', {});
    const learned = out.steps.headBucket.bucketRegion; if (learned && !cfg.region) s3.setRegion(learned);
    out.steps.listRoot = await s3.probe('GET', '/', { 'list-type': '2', delimiter: '/', 'max-keys': '5' });
    out.steps.listDataset = await s3.probe('GET', '/', { 'list-type': '2', prefix: cfg.prefix, delimiter: '/', 'max-keys': '5' });
    const alt = /node_fills_by_block/.test(cfg.prefix) ? 'node_fills/hourly/' : 'node_fills_by_block/hourly/';
    out.steps['list:' + alt] = await s3.probe('GET', '/', { 'list-type': '2', prefix: alt, delimiter: '/', 'max-keys': '5' });
    const day = out.steps.listDataset.prefixes && out.steps.listDataset.prefixes[0];
    if (day) { const hours = await s3.probe('GET', '/', { 'list-type': '2', prefix: day, 'max-keys': '3' }); out.steps.listDay = hours;
      const key = hours.keys && hours.keys[0]; if (key) out.steps.headObject = await s3.probe('HEAD', '/' + key, {}); }
    // by name: noon files of the last days (the archive can lag), under both datasets, every naming variant
    const nowMs = (deps.now || Date.now)(), yesterday = dayStr(nowMs - 86400e3), byName = {};
    for (const pfx of [cfg.prefix, alt]) { headCache.clear(); const was = naming; naming = null; let k = null;
      for (const back of [1, 2, 3, 5, 8, 14, 30]) { k = await headHour(dayStr(nowMs - back * 86400e3), 12, pfx); if (k) break; }
      if (pfx !== cfg.prefix) naming = was;
      byName[pfx] = k ? { ok: true, key: k.key, size: k.size } : { ok: false, tried: NAMINGS.map(nm => keyFor(pfx, yesterday, 12, nm)).concat(['… and the same for 2, 3, 5, 8, 14 and 30 days ago']) }; }
    out.steps.readByName = byName;
    // files that are known to exist: a documented node-data file, and the docs' own example in the market-data bucket.
    // GetObject answering here while the reads above don't means the archive lags, not a permission
    const known = {}; const KNOWN_NODE = 'node_fills_by_block/hourly/20260918/9.lz4', KNOWN_DOCS = { bucket: 'hyperliquid-archive', key: 'market_data/20230916/9/l2Book/SOL.lz4' };
    const R = { range: 'bytes=0-63' }; // a few bytes: enough to see the answer and its error code
    known[cfg.bucket + '/' + KNOWN_NODE] = await s3.probe('GET', '/' + KNOWN_NODE, {}, null, R);
    try { const other = s3Client({ keyId: cfg.keyId, secret: cfg.secret, bucket: KNOWN_DOCS.bucket, fetchImpl: deps.fetchImpl, now: deps.now });
      let p = await other.probe('GET', '/' + KNOWN_DOCS.key, {}, null, R); if (!p.ok && p.bucketRegion) p = await other.probe('GET', '/' + KNOWN_DOCS.key, {}, p.bucketRegion, R);
      known[KNOWN_DOCS.bucket + '/' + KNOWN_DOCS.key] = p; } catch (e) { known[KNOWN_DOCS.bucket + '/' + KNOWN_DOCS.key] = { error: e.message }; }
    out.steps.knownObjects = known;
    out.steps.ownBuckets = await listOwnBuckets(cfg, deps.fetchImpl, deps.now);
    // two reference reads owned by neither side: a public AWS Open Data file (no requester pays) and a
    // requester-pays file from another owner (arXiv). Cross-account reads in general vs requester pays in particular.
    const refs = {}; const REFS = [{ bucket: 'noaa-ghcn-pds', key: 'readme.txt', rp: false }, { bucket: 'arxiv', key: 'pdf/arXiv_pdf_manifest.xml', rp: true }];
    for (const r of REFS) { try { const c = s3Client({ keyId: cfg.keyId, secret: cfg.secret, bucket: r.bucket, fetchImpl: deps.fetchImpl, now: deps.now });
        let p = await c.probe('GET', '/' + r.key, {}, null, R); if (!p.ok && p.bucketRegion) p = await c.probe('GET', '/' + r.key, {}, p.bucketRegion, R);
        refs[r.bucket + '/' + r.key + (r.rp ? ' (requester pays)' : ' (public)')] = p; } catch (e) { refs[r.bucket + '/' + r.key] = { error: e.message }; } }
    // the public file two more ways: with no signature at all (the network and the bucket), and signed
    // without the requester-pays header (whether that header is what gets refused)
    try { const fetchFn = deps.fetchImpl || ((...a) => globalThis.fetch(...a)); const res = await fetchFn('https://' + REFS[0].bucket + '.s3.amazonaws.com/' + REFS[0].key, { method: 'HEAD', signal: AbortSignal.timeout(30000) });
      refs['the same, unsigned'] = { status: res.status, ok: res.ok }; } catch (e) { refs['the same, unsigned'] = { error: e.message }; }
    try { const c = s3Client({ keyId: cfg.keyId, secret: cfg.secret, bucket: REFS[0].bucket, fetchImpl: deps.fetchImpl, now: deps.now });
      refs['the same, signed without the requester-pays header'] = await c.probe('GET', '/' + REFS[0].key, {}, null, { noPayer: true, range: R.range }); } catch (e) { refs['the same, signed without the requester-pays header'] = { error: e.message }; }
    // GetBucketLocation on the public bucket: the new AWS experience's region policy allows it everywhere
    // while it denies object reads outside the project's own region — the two together are that policy's signature
    try { const c = s3Client({ keyId: cfg.keyId, secret: cfg.secret, bucket: REFS[0].bucket, fetchImpl: deps.fetchImpl, now: deps.now });
      refs['the same bucket, GetBucketLocation only'] = await c.probe('GET', '/', { location: '' }, null, { noPayer: true }); } catch (e) { refs['the same bucket, GetBucketLocation only'] = { error: e.message }; }
    out.steps.referenceReads = refs;
    const refPublic = refs[REFS[0].bucket + '/' + REFS[0].key + ' (public)'], refRP = refs[REFS[1].bucket + '/' + REFS[1].key + ' (requester pays)'];
    const refLoc = refs['the same bucket, GetBucketLocation only'];
    const refAnon = refs['the same, unsigned'], refNoPayer = refs['the same, signed without the requester-pays header'];
    const kn = known[cfg.bucket + '/' + KNOWN_NODE], kd = known[KNOWN_DOCS.bucket + '/' + KNOWN_DOCS.key], ob = out.steps.ownBuckets;
    const id = out.steps.identity, lr = out.steps.listRoot, ld = out.steps.listDataset, rn = byName[cfg.prefix], ra = byName[alt];
    const sigBad = [refPublic, refNoPayer, kn, kd].some(x => x && x.code === 'SignatureDoesNotMatch');
    out.verdict = id.code ? 'AWS does not accept this key at all (' + id.code + '): the key id or secret is wrong'
      : sigBad ? 'S3 rejects the signature of object reads (SignatureDoesNotMatch) while the service endpoint accepts it: a signing fault in Ledger’s S3 client for this request shape — report this output'
      : ld.ok ? 'everything answers: the archive is readable with this key' + (lr.ok ? '' : ' (the bucket root alone is not listable, which is fine)') + (out.steps.ownBuckets && !out.steps.ownBuckets.ok ? '; the denials below on other buckets are expected: this key is scoped to the archive, which is the right setup' : '')
      : ld.code === 'AccessDenied' && out.steps['list:' + alt].ok ? 'this key can read the archive, but not under ' + cfg.prefix + ' — the bucket allows ' + alt + ': set ARCHIVE_PREFIX=' + alt + ' on the server'
      : rn.ok ? 'listing is not allowed on this bucket, but its files can be read by name (' + rn.key + ', ' + rn.size + ' bytes): the check and the backfill work that way, nothing to change'
      : ra.ok ? 'listing is not allowed, and ' + cfg.prefix + ' has no file for yesterday noon, but ' + alt + ' has (' + ra.key + '): set ARCHIVE_PREFIX=' + alt + ' on the server'
      : kn.ok ? 'listing is not allowed and yesterday’s file isn’t there yet, but a known file reads fine (' + KNOWN_NODE + ', ' + kn.size + ' bytes): the archive lags a few days; the check finds its last day by probing — nothing to change'
      : kd.ok ? 'this key can read requester-pays data (the docs’ example in ' + KNOWN_DOCS.bucket + ' answers), but ' + cfg.bucket + ' refuses every read and listing: that bucket’s own policy does not allow this account, or it moved — nothing on the key’s side will change it'
      : ld.code === 'AccessDenied' && id.arn && ob && !ob.ok && !ob.error ? 'the key is ' + id.arn + ', AWS accepts it, and S3 refuses it everything — even listing the account’s own buckets (' + (ob.code || ob.status) + '), which no outside policy can refuse. That is the AWS account itself, not a permission: a new account is not served by S3 until AWS finishes activating it (payment verification, up to 24 hours; the console shows a banner meanwhile). Nothing to change here; try again later'
      : ld.code === 'AccessDenied' && id.arn && ob && ob.ok && refPublic && refPublic.ok && refRP && refRP.ok ? 'the key reads other accounts’ public and requester-pays data fine (' + REFS[0].bucket + ' and ' + REFS[1].bucket + ' answer), but both Hyperliquid buckets refuse it: their bucket policy does not allow this account — nothing on the key’s side will change it. The fallback is the estimate from Hyperliquid’s P&L curve'
      : ld.code === 'AccessDenied' && id.arn && ob && ob.ok && refPublic && refPublic.ok && refRP && !refRP.ok ? 'the key reads a public bucket (' + REFS[0].bucket + ') but no requester-pays bucket (' + REFS[1].bucket + ' is refused like Hyperliquid’s): AWS is not letting this account be billed for requester-pays downloads yet. That clears when the payment method is verified (Billing → Payment preferences; a new account can take up to 24 hours). Nothing to change here; try again later'
      : ld.code === 'AccessDenied' && id.arn && ob && ob.ok && refPublic && !refPublic.ok && refNoPayer && refNoPayer.ok ? 'the key reads a public file when the request carries no requester-pays header, and is refused the moment it does: AWS is not letting this account pay for requester-pays transfers yet — that is the payment method, not a permission. In the AWS console open Billing → Payment preferences and look for a verification step (a new account can take up to 24 hours); try again afterwards. Nothing to change in Ledger'
      : ld.code === 'AccessDenied' && id.arn && ob && ob.ok && refPublic && !refPublic.ok && refAnon && refAnon.ok && refLoc && refLoc.ok ? 'this is AWS’s new project-based experience (AWS Settings, projects, spend limits): AWS attaches a region policy to every project that allows only account-level S3 calls (ListAllMyBuckets, GetBucketLocation — both answer here) and denies object reads in every region but the project’s own. ' + cfg.bucket + ' is in ' + (ld.bucketRegion || 'another region') + ', so it is refused, as is any other account’s bucket; no IAM policy and no plan upgrade changes it. Fix: AWS Settings → Projects → Actions → Explore advanced features → activate (irreversible; it makes this a normal AWS organization you administer), then Projects → Manage this organization → Manage policies → Service control policies → the region policy → Edit → add "' + (ld.bucketRegion || 'ap-northeast-1') + '" to the RegionFloor statement’s aws:RequestedRegion list → Save. Then try again'
      : ld.code === 'AccessDenied' && id.arn && ob && ob.ok && refPublic && !refPublic.ok && refAnon && refAnon.ok ? 'the public file is reachable unsigned, and refused as soon as this key signs the request, with or without the requester-pays header: the whole account is denied cross-account reads, which no IAM policy can change — an AWS Organizations service control policy (the Free plan of an account opened since 15 July 2025, or a real organization’s) or a permissions boundary on the user. IAM’s policy simulator names which; on the Free plan, Billing → Upgrade to the Paid plan'
      : ld.code === 'AccessDenied' && id.arn && ob && ob.ok && refPublic && !refPublic.ok && refAnon && !refAnon.ok ? 'even an unsigned read of a public file fails from this server (' + (refAnon.status || refAnon.error) + '): the server cannot reach S3 object endpoints at all — a network or egress restriction on the host, not a permission'
      : ld.code === 'AccessDenied' && id.arn && ob && ob.ok && refPublic && !refPublic.ok ? 'the key lists its own buckets but cannot read even a public bucket (' + REFS[0].bucket + '): something on the user denies cross-account reads — in IAM → Users → ledger-archive, check Permissions for a deny statement and the Permissions boundary section'
      : ld.code === 'AccessDenied' && id.arn && ob && ob.ok ? 'the key is ' + id.arn + ' and S3 serves it (its own buckets list fine), but every read in ' + cfg.bucket + ' and in ' + KNOWN_DOCS.bucket + ' is refused: the identity lacks s3:GetObject on other accounts’ buckets — in IAM → Users → ledger-archive → Permissions, make sure AmazonS3ReadOnlyAccess (or the custom policy) is attached, and that no permissions boundary or deny policy sits on the user'
      : ld.code === 'AccessDenied' && id.arn ? 'the key is ' + id.arn + ' and AWS accepts it, but S3 refuses every read for it, in ' + cfg.bucket + ' and in ' + KNOWN_DOCS.bucket + ' alike: that identity has no effective policy allowing s3:GetObject (and s3:ListBucket). In IAM → Users → ledger-archive → Permissions, attach AmazonS3ReadOnlyAccess and wait a minute'
      : ld.bucketRegion && ld.bucketRegion !== ld.signedFor ? 'the bucket is in ' + ld.bucketRegion + ' but the request was signed for ' + ld.signedFor + ': set ARCHIVE_REGION=' + ld.bucketRegion
      : 'S3 answered ' + (ld.code || ld.status || ld.error) + (ld.message ? ': ' + ld.message : '');
    return out;
  }
  function stop() { if (job && job.state === 'running') { job.state = 'stopped'; job.finishedAt = Date.now(); } return job; }
  const status = () => ({ configured, bucket: cfg.bucket, prefix: cfg.prefix, region: s3 ? s3.region() : null, costPerGB: cfg.costPerGB, maxWindowDays: cfg.maxDays, noList, naming, index: ix ? { bucket: cfg.indexBucket, prefix: cfg.indexPrefix } : null, lastCheck, job });
  return { configured, cfg, check, sample, backfill, stop, status, diagnose, indexDays, indexFetch, plan: (addr, fills, d, scope) => { need(); return plan(addr, fills, d, scope); } };
}

module.exports = { signV4, s3Client, callerIdentity, listOwnBuckets, roleCredentials, lz4Stream, extractFillsFromObject, lz4Decode, decodeObject, extractFills, normFill, seamWindows, createArchive, amzDate, enc };
