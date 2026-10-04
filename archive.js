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
  const service = 's3', hdrs = Object.assign({ host: o.host }, o.headers || {});
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
  async function request(method, path, query, opts, retried) {
    opts = opts || {};
    const r = region || 'us-east-1', host = hostFor(r), date = new Date(now()), payloadHash = sha256('');
    const headers = { 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate(date), 'x-amz-request-payer': 'requester' };
    const s = signV4({ method, host, path, query, headers, payloadHash, region: r, keyId: cfg.keyId, secret: cfg.secret, date });
    const url = 'https://' + host + enc(path, true) + (s.query ? '?' + s.query : '');
    const res = await fetchFn(url, { method, headers: Object.assign({ Authorization: s.authorization }, headers), redirect: 'manual', signal: AbortSignal.timeout(opts.timeout || 180000) });
    const text = res.ok && opts.binary ? null : await res.text().catch(() => '');
    if (!res.ok) {
      const br = (res.headers && res.headers.get && res.headers.get('x-amz-bucket-region')) || xmlText(text || '', 'Region');
      if (!retried && br && br !== r) { region = br; return request(method, path, query, opts, true); }
      const code = xmlText(text || '', 'Code') || ('HTTP ' + res.status), msg = xmlText(text || '', 'Message') || '';
      const e = new Error('S3 ' + code + (msg ? ': ' + msg : '') + (res.status === 403 ? ' — check ARCHIVE_AWS_KEY_ID / ARCHIVE_AWS_SECRET and the key’s policy (s3:GetObject and s3:ListBucket on the bucket)' : ''));
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
  return { list, get, region: () => region, host: () => hostFor(region || 'us-east-1') };
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
function seamWindows(fills, E, opts) {
  opts = opts || {}; const maxDays = opts.maxDays || 14;
  const perp = (fills || []).filter(f => f && typeof f.coin === 'string' && !f.coin.includes('/') && !f.coin.startsWith('@')).sort((a, b) => a.time - b.time);
  const trades = E.reconstructTrades(perp, 'x', 'perp');
  const times = {}; for (const f of perp) (times[f.coin] = times[f.coin] || []).push(f.time);
  const seams = [], skipped = [], hours = new Set();
  for (const t of trades) for (const g of (t.gapTimes || [])) {
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
    prefix: String(env.ARCHIVE_PREFIX || 'node_fills/hourly/').replace(/^\/+/, '').replace(/\/*$/, '/'),
    costPerGB: Math.max(0, parseFloat(env.ARCHIVE_COST_PER_GB) || 0.09), maxDays: Math.max(1, parseInt(env.ARCHIVE_MAX_WINDOW_DAYS, 10) || 14) };
  const configured = !!(cfg.keyId && cfg.secret);
  const s3 = configured ? s3Client({ keyId: cfg.keyId, secret: cfg.secret, bucket: cfg.bucket, region: cfg.region, fetchImpl: deps.fetchImpl, now: deps.now }) : null;
  const need = () => { if (!configured) { const e = new Error('the archive isn’t configured: set ARCHIVE_AWS_KEY_ID and ARCHIVE_AWS_SECRET on the server (an AWS key with s3:GetObject and s3:ListBucket on ' + cfg.bucket + ')'); e.code = 503; throw e; } };
  const gb = b => b / 1073741824, cost = b => +(gb(b) * cfg.costPerGB).toFixed(2);
  let lastCheck = null, job = null;
  const dayCache = new Map(); // day -> [{key,size,hour}]
  const hourNum = key => { const m = /\/(\d{1,2})(?:\.[A-Za-z0-9]+)?$/.exec(key); return m ? +m[1] : null; };
  async function dayKeys(day) {
    if (dayCache.has(day)) return dayCache.get(day);
    const r = await s3.list(cfg.prefix + day + '/');
    const rows = r.keys.map(k => ({ key: k.key, size: k.size, hour: hourNum(k.key) })).filter(k => k.hour != null);
    dayCache.set(day, rows); return rows;
  }
  // the archive's days, oldest and newest
  async function days() {
    const r = await s3.list(cfg.prefix, '/', 20);
    const ds = r.prefixes.map(p => p.slice(cfg.prefix.length).replace(/\/$/, '')).filter(d => /^\d{8}$/.test(d)).sort();
    return { days: ds, first: ds[0] || null, last: ds[ds.length - 1] || null, truncated: r.truncated };
  }
  // the hours a wallet's seams need, which of them the archive has, their bytes and cost
  async function plan(addr, fills, archiveDays) {
    const sw = seamWindows(fills, deps.engine, { maxDays: cfg.maxDays });
    const have = new Set(archiveDays), items = [], missing = [], byDay = {};
    for (const h of sw.hours) (byDay[dayKeyOf(h)] = byDay[dayKeyOf(h)] || []).push(hourInDay(h));
    let listedDays = 0;
    for (const day of Object.keys(byDay).sort()) {
      if (!have.has(day)) { for (const hr of byDay[day]) missing.push(day + '/' + hr); continue; }
      const rows = await dayKeys(day); listedDays++;
      for (const hr of byDay[day]) { const k = rows.find(x => x.hour === hr); if (k) items.push(k); else missing.push(day + '/' + hr); }
    }
    const bytes = items.reduce((s, k) => s + k.size, 0);
    return { address: addr, seams: sw.seams.length, skippedLong: sw.skipped, hours: sw.hours.length, items, missing, bytes, estGB: +gb(bytes).toFixed(3), estCost: cost(bytes), listedDays };
  }
  async function check(wallets) {
    need();
    const d = await days(); const out = { bucket: cfg.bucket, prefix: cfg.prefix, region: s3.region(), costPerGB: cfg.costPerGB, archive: d, sampleDay: null, wallets: [] };
    if (d.last) { const rows = await dayKeys(d.last); const bytes = rows.reduce((s, k) => s + k.size, 0); out.sampleDay = { day: d.last, hours: rows.length, bytes, perHour: rows.length ? Math.round(bytes / rows.length) : 0, firstKey: rows[0] && rows[0].key }; }
    for (const w of wallets || []) {
      try { const p = await plan(w.address, w.fills || deps.readFills(w.address) || [], d.days); delete p.items; out.wallets.push(p); }
      catch (e) { out.wallets.push({ address: w.address, error: e.message }); }
    }
    lastCheck = Object.assign({ at: Date.now() }, out); return out;
  }
  // one hour, decoded: what the file looks like and what it holds for the given addresses
  async function sample(o) {
    need(); o = o || {};
    let key = o.key;
    if (!key) { const d = o.day || (await days()).last; if (!d) throw Object.assign(new Error('the archive has no days under ' + cfg.prefix), { code: 404 });
      const rows = await dayKeys(d); const k = o.hour != null ? rows.find(x => x.hour === +o.hour) : rows[0]; if (!k) throw Object.assign(new Error('no file for ' + d + '/' + (o.hour != null ? o.hour : '*')), { code: 404 }); key = k.key; }
    const buf = await s3.get(key, { maxBytes: 512 * 1024 * 1024 }), dec = decodeObject(buf);
    const res = { key, bytes: buf.length, encoding: dec.encoding, textBytes: Buffer.byteLength(dec.text), preview: dec.text.slice(0, 1500), wallets: {} };
    for (const a of (o.addresses || [])) { const x = extractFills(dec.text, a); res.wallets[a] = { fills: x.fills.length, first: x.fills[0] || null }; res.lines = x.lines; res.parsed = x.parsed; res.fillsSeen = x.seen; res.shapes = x.shapes; }
    if (!o.addresses || !o.addresses.length) { const x = extractFills(dec.text, '0x'); res.lines = x.lines; res.parsed = x.parsed; res.fillsSeen = x.seen; res.shapes = x.shapes; }
    return res;
  }
  // the backfill: plan, refuse past the budget, then download hour by hour in the background
  async function backfill(o) {
    need(); o = o || {};
    if (job && job.state === 'running') throw Object.assign(new Error('a backfill is already running'), { code: 409 });
    const addr = String(o.address || '').toLowerCase(), fills = deps.readFills(addr) || [];
    if (!fills.length) throw Object.assign(new Error('no server fill cache for ' + addr + ' — refresh it first'), { code: 404 });
    const d = await days(), p = await plan(addr, fills, d.days);
    const maxGB = parseFloat(o.maxGB) > 0 ? parseFloat(o.maxGB) : 2; // GB; the caller's cap, however small
    if (gb(p.bytes) > maxGB) throw Object.assign(new Error('the plan is ' + p.estGB + ' GB (about $' + p.estCost + ') — over the ' + maxGB + ' GB budget; raise maxGB to go ahead'), { code: 413, plan: Object.assign({}, p, { items: undefined }) });
    const items = p.items.slice();
    job = { state: 'running', address: addr, startedAt: Date.now(), total: items.length, done: 0, bytes: 0, fills: 0, errors: 0, lastKey: null, plan: Object.assign({}, p, { items: undefined }), dryRun: !!o.dryRun };
    if (o.dryRun) { job.state = 'done'; job.finishedAt = Date.now(); return job; }
    const found = [], cur = job;
    (async () => {
      for (const it of items) {
        if (cur !== job || cur.state !== 'running') return;
        try { const buf = await s3.get(it.key, { maxBytes: 1024 * 1024 * 1024 }); cur.bytes += buf.length; const dec = decodeObject(buf);
          const x = extractFills(dec.text, addr); found.push(...x.fills); cur.fills += x.fills.length; }
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
  function stop() { if (job && job.state === 'running') { job.state = 'stopped'; job.finishedAt = Date.now(); } return job; }
  const status = () => ({ configured, bucket: cfg.bucket, prefix: cfg.prefix, region: s3 ? s3.region() : null, costPerGB: cfg.costPerGB, maxWindowDays: cfg.maxDays, lastCheck, job });
  return { configured, cfg, check, sample, backfill, stop, status, plan: (addr, fills, archiveDays) => { need(); return plan(addr, fills, archiveDays); } };
}

module.exports = { signV4, s3Client, lz4Decode, decodeObject, extractFills, normFill, seamWindows, createArchive, amzDate, enc };
