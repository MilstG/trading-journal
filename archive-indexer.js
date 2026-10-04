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
const dayStr = ms => { const d = new Date(ms); return d.getUTCFullYear() + String(d.getUTCMonth() + 1).padStart(2, '0') + String(d.getUTCDate()).padStart(2, '0'); };
const dayMs = s => Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8));
const sourcePrefix = day => (day >= NEW_FROM ? 'node_fills_by_block/hourly/' : 'node_fills/hourly/') + day + '/';
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

/* ---------------- one hour, in a worker: download, decode, split by shard ---------------- */
// Returns {hour, fills, bytes, members: {shard: gzip member}}: each shard's lines as one gzip member,
// so the main thread appends it to the shard's file (concatenated members are one valid gzip stream).
async function splitHour(src, key) {
  const buf = await src.get(key, { maxBytes: 2 * 1024 * 1024 * 1024 });
  const parts = new Map(); let fills = 0, lines = 0;
  const onLine = s => {
    if (!s.trim()) return; lines++;
    let j; try { j = JSON.parse(s); } catch (e) { return; }
    const ev = Array.isArray(j) ? j : (j && Array.isArray(j.events) ? j.events : null); if (!ev) return;
    for (const e of ev) { if (!Array.isArray(e) || e.length !== 2 || typeof e[0] !== 'string' || !e[1] || typeof e[1] !== 'object') continue;
      const sh = SHARD(e[0]); let arr = parts.get(sh); if (!arr) { arr = []; parts.set(sh, arr); } arr.push(JSON.stringify(e)); fills++; }
  };
  // the same line splitter as extractFillsFromObject, over the streaming decoder
  let rest = '';
  const feed = chunk => { let s = 0; for (let i = 0; i < chunk.length; i++) if (chunk[i] === 10) { onLine(rest + chunk.toString('utf8', s, i)); rest = ''; s = i + 1; } if (s < chunk.length) rest += chunk.toString('utf8', s); };
  if (buf.length >= 4 && buf.readUInt32LE(0) === 0x184D2204) A.lz4Stream(buf, feed);
  else if (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b) feed(zlib.gunzipSync(buf));
  else feed(buf);
  if (rest) onLine(rest);
  const members = {};
  for (const [sh, arr] of parts) members[sh] = zlib.gzipSync(arr.join('\n') + '\n', { level: 6 });
  return { key, lines, fills, bytes: buf.length, members };
}
if (!isMainThread) {
  const src = A.s3Client({ bucket: SOURCE_BUCKET, region: REGION, credentials: A.roleCredentials() });
  parentPort.on('message', async key => {
    try { const r = await splitHour(src, key); parentPort.postMessage({ ok: true, r }, Object.values(r.members).map(b => b.buffer)); }
    catch (e) { parentPort.postMessage({ ok: false, key, error: e.message }); }
  });
}

/* ---------------- the main thread: days, workers, uploads, markers ---------------- */
function parseArgs(argv) {
  const o = { cmd: argv[0] || 'status', bucket: process.env.INDEX_BUCKET || '', prefix: (process.env.INDEX_PREFIX || 'index/v1/').replace(/\/*$/, '/'), workers: +process.env.WORKERS || Math.max(1, Math.min(4, os.cpus().length)), work: process.env.WORKDIR || path.join(os.tmpdir(), 'hl-index') };
  for (let i = 1; i < argv.length; i++) { const k = argv[i], v = argv[i + 1];
    if (k === '--bucket') { o.bucket = v; i++; } else if (k === '--prefix') { o.prefix = v.replace(/\/*$/, '/'); i++; } else if (k === '--from') { o.from = v; i++; } else if (k === '--to') { o.to = v; i++; }
    else if (k === '--workers') { o.workers = +v; i++; } else if (k === '--work') { o.work = v; i++; } else if (k === '--days') { o.days = +v; i++; } }
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
  const run = key => new Promise((resolve, reject) => { const go = w => { const onMsg = m => { w.off('message', onMsg); idle.push(w); if (waiting.length) waiting.shift()(idle.pop()); m.ok ? resolve(m.r) : reject(new Error(m.error)); }; w.on('message', onMsg); w.postMessage(key); };
    idle.length ? go(idle.pop()) : waiting.push(go); });
  let total = { days: 0, hours: 0, fills: 0, bytes: 0 }; const t0 = Date.now();
  try {
    for (const day of days) {
      if (await idx.head(o.prefix + 'd/' + day + '/_done')) { log(day + ' already indexed'); continue; }
      const hours = (await src.list(sourcePrefix(day))).keys.filter(k => /\/\d{1,2}(\.lz4)?$/.test(k.key)).sort((a, b) => +(/\/(\d+)/.exec(a.key.slice(-7))[1]) - +(/\/(\d+)/.exec(b.key.slice(-7))[1]));
      if (!hours.length) { log(day + ': no files in the archive'); continue; }
      const dir = path.join(o.work, day); fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
      const sum = { day, hours: 0, fills: 0, bytes: 0, lines: 0, failed: [] }; const td = Date.now();
      // every hour of the day through the workers; each result is appended to the day's shard files as it lands
      await Promise.all(hours.map(async h => {
        let r = null; for (let attempt = 0; attempt < 3 && !r; attempt++) { try { r = await run(h.key); } catch (e) { if (attempt === 2) { sum.failed.push(h.key + ': ' + e.message); log('  ' + h.key + ' failed: ' + e.message); } } }
        if (!r) return;
        for (const sh in r.members) fs.appendFileSync(path.join(dir, sh + '.jsonl.gz'), Buffer.from(r.members[sh]));
        sum.hours++; sum.fills += r.fills; sum.bytes += r.bytes; sum.lines += r.lines;
      }));
      if (sum.failed.length) { log(day + ': ' + sum.failed.length + ' hour(s) failed — the day is left unmarked, run again'); continue; }
      // upload the day's shards, then the marker
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl.gz')); let up = 0, upBytes = 0;
      const queue = files.slice(); const uploader = async () => { for (;;) { const f = queue.shift(); if (!f) return; const body = fs.readFileSync(path.join(dir, f));
        for (let attempt = 0; attempt < 4; attempt++) { try { await idx.put(o.prefix + 'd/' + day + '/' + f, body, 'application/gzip'); break; } catch (e) { if (attempt === 3) throw e; await new Promise(r => setTimeout(r, 500 * (attempt + 1))); } }
        up++; upBytes += body.length; } };
      await Promise.all(Array.from({ length: 24 }, uploader));
      sum.shards = up; sum.indexBytes = upBytes; sum.seconds = Math.round((Date.now() - td) / 1000); sum.at = new Date().toISOString();
      await idx.put(o.prefix + 'd/' + day + '/_done', Buffer.from(JSON.stringify(sum)), 'application/json');
      total.days++; total.hours += sum.hours; total.fills += sum.fills; total.bytes += sum.bytes;
      await idx.put(o.prefix + 'progress.json', Buffer.from(JSON.stringify({ lastDay: day, lastSummary: sum, run: total, startedAt: new Date(t0).toISOString(), at: sum.at })), 'application/json');
      fs.rmSync(dir, { recursive: true, force: true });
      log(day + ': ' + sum.hours + ' hours, ' + sum.fills.toLocaleString('en-US') + ' fills, ' + (sum.bytes / 1048576).toFixed(0) + ' MB read, ' + up + ' shards (' + (upBytes / 1048576).toFixed(0) + ' MB) in ' + sum.seconds + 's');
    }
  } finally { for (const w of workers) w.terminate(); }
  log('done: ' + total.days + ' day(s), ' + total.hours + ' hours, ' + total.fills.toLocaleString('en-US') + ' fills, ' + (total.bytes / 1073741824).toFixed(1) + ' GB read in ' + Math.round((Date.now() - t0) / 60000) + ' min');
}
if (isMainThread) { if (require.main === module) main().catch(e => { console.error(e.message || e); process.exit(1); }); }
module.exports = { splitHour, SHARD, sourcePrefix, dayStr, parseArgs };
