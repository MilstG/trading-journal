#!/usr/bin/env node
// archive-indexer.js — rewrites Hyperliquid's node-data archive into an index by wallet, so one
// wallet's whole history is a few small files instead of 300 GB of hourly files.
//
// Runs on a machine inside AWS, in the archive's region (ap-northeast-1): reading S3 from there costs
// no transfer. Each hour of the archive (node_fills_by_block/hourly/{day}/{hour}.lz4, every wallet's
// fills) is streamed, decoded and split by the first three hex characters of the wallet address into
// 4,096 shards; a day's shards are written to the index bucket as
//   {prefix}d/{YYYYMMDD}/{shard}.jsonl.gz      one line per fill: [address, fill] (the archive's own format)
//   {prefix}d/{YYYYMMDD}/_done                  the day's summary, written last — the resume marker
//   {prefix}progress.json                       the latest summary, for whoever wants to watch
// A wallet's history is then its shard's file for every day, ~1/4096 of the archive.
//
// Usage (the index bucket must be in the same region as the archive):
//   node archive-indexer.js build  --bucket my-hl-index [--from 20250525] [--to 20261003] [--workers 3]
//   node archive-indexer.js daily  --bucket my-hl-index          # yesterday and any recent day still missing
//   (either one skips finished days, so a scheduled `build` keeps the index whole and current; days of the
//   last --recheck 7 are listed again and redone if the archive has hours their marker didn't count)
//   node archive-indexer.js status --bucket my-hl-index
// Credentials: the EC2 instance role (IMDSv2), or AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY in the environment.
// No dependencies: archive.js beside this file is all it needs.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');
const A = require(path.join(__dirname, 'archive.js'));

const SOURCE_BUCKET = process.env.SOURCE_BUCKET || 'hl-mainnet-node-data';
const REGION = process.env.AWS_REGION || 'ap-northeast-1';
const NEW_FROM = '20250727', OLD_FROM = '20250525'; // node_fills_by_block begins; node_fills (same format) before it
const SHARD = addr => String(addr).slice(2, 5).toLowerCase(); // 0x + 3 hex = 4,096 shards
const ADDR_OK = a => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a);
const SHARD_OK = sh => /^[0-9a-f]{3}$/.test(sh); // checked again where a shard name meets the filesystem
const SLICE_BYTES = +process.env.SLICE_MB * 1048576 || 24 * 1048576; // lines held per worker before they are compressed and handed over
const dayStr = ms => { const d = new Date(ms); return d.getUTCFullYear() + String(d.getUTCMonth() + 1).padStart(2, '0') + String(d.getUTCDate()).padStart(2, '0'); };
const dayMs = s => Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));
const sourcePrefix = day => (day >= NEW_FROM ? 'node_fills_by_block/hourly/' : 'node_fills/hourly/') + day + '/';
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

/* ---------------- one hour, in a worker: download, decode, split by shard ---------------- */
// Returns {hour, fills, bytes, members: {shard: gzip member}}: each shard's lines as one gzip member,
// so the main thread appends it to the shard's file (concatenated members are one valid gzip stream).
async function splitHour(src, key, onMembers, sliceBytes) {
  const buf = await src.get(key, { maxBytes: 2 * 1024 * 1024 * 1024 });
  const LIMIT = sliceBytes || SLICE_BYTES;
  let parts = new Map(), held = 0; let fills = 0, lines = 0, sample = null, slices = 0; const shapes = {}; let members = {};
  // the lines gathered so far, one gzip member per shard: handed to onMembers (the main thread
  // appends them to the day's files) or kept when there is no callback. Called every LIMIT bytes
  // of lines and at the end, so an hour of 300k fills never sits in memory whole — the first
  // build died of that (the kernel killed node at 3.6 GB on a 4 GB machine).
  const flush = async () => { if (!parts.size) return; const m = {};
    for (const [sh, arr] of parts) m[sh] = zlib.gzipSync(arr.join('\n') + '\n', { level: 6 });
    parts = new Map(); held = 0; slices++;
    if (onMembers) await onMembers(m); else for (const sh in m) members[sh] = members[sh] ? Buffer.concat([members[sh], m[sh]]) : m[sh]; };
  const pending = []; // flushes queued by the synchronous walk; awaited in order below
  // only a real address names a shard: the shard becomes a file name, so a malformed user field is dropped here
  const keep = (addr, fill, shape) => { if (!ADDR_OK(addr)) { shapes.badAddress = (shapes.badAddress || 0) + 1; return; } shapes[shape] = (shapes[shape] || 0) + 1; const sh = SHARD(addr); let arr = parts.get(sh); if (!arr) { arr = []; parts.set(sh, arr); } const line = JSON.stringify([addr, fill]); arr.push(line); held += line.length; fills++;
    if (held >= LIMIT) { const snap = parts; parts = new Map(); held = 0; pending.push(snap); } };
  // the same walk as archive.js's extractFills: [address, fill] pairs (under "events" or anywhere a
  // few levels deep), {user, fill} objects, and fills carrying their user — so the older dataset's
  // lines land in the index too, whatever wraps them
  const walk = (n, d) => {
    if (!n || typeof n !== 'object' || d > 10) return;
    if (Array.isArray(n)) {
      if (n.length === 2 && typeof n[0] === 'string' && /^0x[0-9a-fA-F]{40}$/.test(n[0]) && A.isFill(n[1])) return keep(n[0], n[1], 'pair');
      for (const x of n) walk(x, d + 1); return;
    }
    if (A.isFill(n)) { const u = n.user || n.address; if (typeof u === 'string') { const f = Object.assign({}, n); delete f.user; delete f.address; return keep(u, f, 'user'); } }
    if (n.fill && A.isFill(n.fill) && typeof n.user === 'string') return keep(n.user, n.fill, 'obj');
    for (const k in n) walk(n[k], d + 1);
  };
  const onLine = s => {
    if (!s.trim()) return; lines++; if (sample == null) sample = s.slice(0, 400);
    let j; try { j = JSON.parse(s); } catch (e) { return; }
    walk(j, 0);
  };
  // the decoder is synchronous: it is run in steps of its output so the queued slices can be
  // compressed and handed over between steps instead of piling up until the end
  const drain = async () => { while (pending.length) { const snap = pending.shift(); const was = parts; parts = snap; await flush(); parts = was; } };
  let rest = '';
  const feed = chunk => { let s = 0; for (let i = 0; i < chunk.length; i++) if (chunk[i] === 10) { onLine(rest + chunk.toString('utf8', s, i)); rest = ''; s = i + 1; } if (s < chunk.length) rest += chunk.toString('utf8', s); };
  if (buf.length >= 4 && buf.readUInt32LE(0) === 0x184D2204) { for await (const _ of A.lz4Steps(buf, feed)) await drain(); }
  else if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) { feed(A.gunzipCapped(buf)); await drain(); } // a gzip bomb stops at the cap
  else { feed(buf); await drain(); }
  if (rest) onLine(rest);
  await drain(); await flush();
  return { key, lines, fills, bytes: buf.length, members, shapes, sample, slices };
}
if (!isMainThread) {
  const src = A.s3Client({ bucket: SOURCE_BUCKET, region: REGION, credentials: A.roleCredentials() });
  parentPort.on('message', async key => {
    try { const r = await splitHour(src, key, async m => { parentPort.postMessage({ slice: true, key, members: m }, Object.values(m).map(b => b.buffer)); });
      parentPort.postMessage({ ok: true, r }); }
    catch (e) { parentPort.postMessage({ ok: false, key, error: e.message }); }
  });
}

/* ---------------- the main thread: days, workers, uploads, markers ---------------- */
// What a run does with one day, given its _done marker (or null) and how many hourly files the archive
// lists for it: 'done' (indexed, and the archive has no more hours than the marker counted), 'empty'
// (nothing in the archive), 'wait' (a day of the last two still short of 24 hours: Hyperliquid uploads
// each hour with a lag, and a day marked done short of hours would stay short), else 'index'. An older
// day short of hours is indexed as it is: the archive has gaps of its own.
const recentDay = (day, now, n) => day >= dayStr(now - n * 86400e3);
function dayPlan(day, done, nHours, now) {
  if (done && A.isIndexed(done) && (done.hours || 0) >= nHours) return 'done';
  if (!nHours) return 'empty';
  if (nHours < 24 && recentDay(day, now, 2)) return 'wait';
  return 'index';
}
function parseArgs(argv) {
  const o = { cmd: argv[0] || 'status', bucket: process.env.INDEX_BUCKET || '', prefix: (process.env.INDEX_PREFIX || 'index/v1/').replace(/\/*$/, '/'), workers: +process.env.WORKERS || Math.max(1, Math.min(4, os.cpus().length)), work: process.env.WORKDIR || path.join(os.tmpdir(), 'hl-index'), recheck: +process.env.RECHECK_DAYS || 7 };
  for (let i = 1; i < argv.length; i++) { const k = argv[i], v = argv[i + 1];
    if (k === '--bucket') { o.bucket = v; i++; } else if (k === '--prefix') { o.prefix = v.replace(/\/*$/, '/'); i++; } else if (k === '--from') { o.from = v; i++; } else if (k === '--to') { o.to = v; i++; }
    else if (k === '--workers') { o.workers = +v; i++; } else if (k === '--work') { o.work = v; i++; } else if (k === '--days') { o.days = +v; i++; } else if (k === '--recheck') { o.recheck = +v; i++; } }
  return o;
}
async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (!o.bucket) { console.error('an index bucket is needed: --bucket my-hl-index (or INDEX_BUCKET)'); process.exit(2); }
  const creds = A.roleCredentials();
  const src = A.s3Client({ bucket: SOURCE_BUCKET, region: REGION, credentials: creds });
  const idx = A.s3Client({ bucket: o.bucket, region: REGION, credentials: creds, noPayer: true });
  const yesterday = dayStr(Date.now() - 86400e3);
  if (o.cmd === 'status') {
    let p = null; try { p = JSON.parse((await idx.get(o.prefix + 'progress.json')).toString('utf8')); } catch (e) {}
    const days = await idx.list(o.prefix + 'd/', '/', 20);
    const ds = days.prefixes.map(x => x.slice((o.prefix + 'd/').length).replace(/\/$/, '')).filter(d => /^\d{8}$/.test(d)).sort();
    console.log(JSON.stringify({ bucket: o.bucket, prefix: o.prefix, days: ds.length, first: ds[0] || null, last: ds[ds.length - 1] || null, progress: p }, null, 2)); return;
  }
  // which days
  let days = [];
  if (o.cmd === 'build') { const from = o.from || OLD_FROM, to = o.to || yesterday; for (let t = dayMs(from); t <= dayMs(to); t += 86400e3) days.push(dayStr(t)); }
  else if (o.cmd === 'daily') { const back = o.days || 7; for (let i = back; i >= 1; i--) days.push(dayStr(Date.now() - i * 86400e3)); }
  else { console.error('unknown command ' + o.cmd); process.exit(2); }
  log(o.cmd + ': ' + days.length + ' day(s) ' + days[0] + ' → ' + days[days.length - 1] + ', ' + o.workers + ' worker(s), work dir ' + o.work);
  fs.mkdirSync(o.work, { recursive: true });
  // the workers
  const workers = Array.from({ length: o.workers }, () => new Worker(__filename));
  const idle = workers.slice(); const waiting = [];
  let appendTo = null; // the day's directory; slices arriving from the workers are appended there
  const streamed = new Set(); // hours that have handed over at least one slice: not retried in place (their lines would land twice), the day is redone instead
  const run = key => new Promise((resolve, reject) => { const go = w => { const onMsg = m => {
      if (m.slice) { streamed.add(m.key); for (const sh in m.members) if (SHARD_OK(sh)) fs.appendFileSync(path.join(appendTo, sh + '.jsonl.gz'), Buffer.from(m.members[sh])); return; }
      w.off('message', onMsg); idle.push(w); if (waiting.length) waiting.shift()(idle.pop()); m.ok ? resolve(m.r) : reject(new Error(m.error)); }; w.on('message', onMsg); w.postMessage(key); };
    idle.length ? go(idle.pop()) : waiting.push(go); });
  let total = { days: 0, hours: 0, fills: 0, bytes: 0 }, emptyDays = 0; const t0 = Date.now();
  const redoDays = [];
  const pass = async (list, redo) => {
    for (const day of list) { streamed.clear();
      const done = await A.doneSummary(idx, o.prefix + 'd/' + day + '/_done');
      // an indexed day outside the recheck window is final; inside it the archive is listed again,
      // since a day indexed while Hyperliquid was still uploading its last hours has more of them now
      if (done && A.isIndexed(done) && !recentDay(day, Date.now(), o.recheck)) { log(day + ' already indexed'); continue; }
      const hours = (await src.list(sourcePrefix(day))).keys.filter(k => /\/\d{1,2}(\.lz4)?$/.test(k.key)).sort((a, b) => +(/\/(\d+)/.exec(a.key.slice(-7))[1]) - +(/\/(\d+)/.exec(b.key.slice(-7))[1]));
      const plan = dayPlan(day, done, hours.length, Date.now());
      if (plan === 'done') { log(day + ' already indexed (' + done.hours + ' hours)'); continue; }
      if (plan === 'empty') { log(day + ': no files in the archive'); continue; }
      if (plan === 'wait') { log(day + ': ' + hours.length + '/24 hours in the archive so far — left for the next run'); continue; }
      if (done && A.isIndexed(done)) log(day + ': indexed with ' + (done.hours || 0) + ' hours, the archive has ' + hours.length + ' now — indexing it again');
      else if (done) log(day + ': marked done earlier but with no fills in it — indexing it again');
      const dir = path.join(o.work, day); fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true }); appendTo = dir;
      const sum = { day, hours: 0, fills: 0, bytes: 0, lines: 0, failed: [], shapes: {}, sample: null }; const td = Date.now();
      // every hour of the day through the workers; each result is appended to the day's shard files as it lands
      await Promise.all(hours.map(async h => {
        let r = null; for (let attempt = 0; attempt < 3 && !r; attempt++) { try { r = await run(h.key); } catch (e) { if (attempt === 2 || streamed.has(h.key)) { sum.failed.push(h.key + ': ' + e.message); log('  ' + h.key + ' failed: ' + e.message); break; } } }
        if (!r) return;
        for (const sh in r.members) if (SHARD_OK(sh)) fs.appendFileSync(path.join(dir, sh + '.jsonl.gz'), Buffer.from(r.members[sh])); // (none when the worker streamed them)
        sum.hours++; sum.fills += r.fills; sum.bytes += r.bytes; sum.lines += r.lines; for (const k in r.shapes) sum.shapes[k] = (sum.shapes[k] || 0) + r.shapes[k]; if (!sum.sample && r.sample) sum.sample = r.sample;
      }));
      if (sum.failed.length) { log(day + ': ' + sum.failed.length + ' hour(s) failed — the day is left unmarked' + (redo ? ', run again' : ' and will be tried once more at the end')); fs.rmSync(dir, { recursive: true, force: true }); if (!redo) redoDays.push(day); continue; }
      // a day of the archive always has fills; none found means the lines have a shape the walk
      // doesn't know — say what a line looks like, leave the day unmarked, and give up after a few
      if (sum.lines && !sum.fills) { emptyDays++; log(day + ': ' + sum.hours + ' hours, ' + sum.lines + ' lines, but no fills recognised in them — the day is left unmarked. A line looks like: ' + (sum.sample || '(empty)'));
        if (emptyDays >= 3) throw new Error('three days in a row with no recognisable fills — stopping instead of reading the whole archive for nothing; the sample lines above show the format');
        continue; }
      emptyDays = 0;
      // upload the day's shards, then the marker
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl.gz')); let up = 0, upBytes = 0;
      const queue = files.slice(); const uploader = async () => { for (;;) { const f = queue.shift(); if (!f) return; const body = fs.readFileSync(path.join(dir, f));
        for (let attempt = 0; attempt < 4; attempt++) { try { await idx.put(o.prefix + 'd/' + day + '/' + f, body, 'application/gzip'); break; } catch (e) { if (attempt === 3) throw e; await new Promise(r => setTimeout(r, 500 * (attempt + 1))); } }
        up++; upBytes += body.length; } };
      await Promise.all(Array.from({ length: 24 }, uploader));
      delete sum.sample; sum.shards = up; sum.indexBytes = upBytes; sum.seconds = Math.round((Date.now() - td) / 1000); sum.at = new Date().toISOString();
      await idx.put(o.prefix + 'd/' + day + '/_done', Buffer.from(JSON.stringify(sum)), 'application/json');
      total.days++; total.hours += sum.hours; total.fills += sum.fills; total.bytes += sum.bytes;
      await idx.put(o.prefix + 'progress.json', Buffer.from(JSON.stringify({ lastDay: day, lastSummary: sum, run: total, startedAt: new Date(t0).toISOString(), at: sum.at })), 'application/json');
      fs.rmSync(dir, { recursive: true, force: true });
      log(day + ': ' + sum.hours + ' hours, ' + sum.fills.toLocaleString('en-US') + ' fills, ' + (sum.bytes / 1048576).toFixed(0) + ' MB read, ' + up + ' shards (' + (upBytes / 1048576).toFixed(0) + ' MB) in ' + sum.seconds + 's');
    } };
  try { await pass(days, false); if (redoDays.length) { log('second pass over ' + redoDays.length + ' day(s) that failed'); await pass(redoDays.slice(), true); } }
  finally { for (const w of workers) w.terminate(); }
  log('done: ' + total.days + ' day(s), ' + total.hours + ' hours, ' + total.fills.toLocaleString('en-US') + ' fills, ' + (total.bytes / 1073741824).toFixed(1) + ' GB read in ' + Math.round((Date.now() - t0) / 60000) + ' min');
}
if (isMainThread) { if (require.main === module) main().catch(e => { console.error(e.message || e); process.exit(1); }); }
// the day's _done marker and whether it counts as indexed live in archive.js: the server reads the index by the same rule
module.exports = { splitHour, SHARD, sourcePrefix, dayStr, parseArgs, dayPlan, isIndexed: A.isIndexed };
