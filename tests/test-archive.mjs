// Hyperliquid's node-data archive on S3 (archive.js): the fills the public API no longer serves.
// Pinned here: SigV4 against Amazon's own published example, the LZ4 frame decoder against files
// made by the reference encoder (linked and independent blocks, with and without checksums), the
// fill extractor over the line shapes the archive has had, the seam planner over the engine's own
// seams, and the whole flow over HTTP against a fake S3: check → sample → backfill → the wallet's
// cache holds the recovered fill and the browser's ?meta=1 sees it.
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import zlib from 'node:zlib';
import vm from 'node:vm';
import { t, ok, eq, near, report, makeExtractor } from './harness.mjs';
import { readAppSource } from '../app-source.js';

const require = createRequire(import.meta.url);
const A = require('../archive.js');
const { createApp } = require('../server.js');
const here = dirname(fileURLToPath(import.meta.url));
const html = readAppSource(join(here, '..', 'ledger.html'));
const { grabFn } = makeExtractor(html);

console.log('\nSigV4');
t('signs Amazon’s published GET Object example to the byte', () => {
  const s = A.signV4({ method: 'GET', host: 'examplebucket.s3.amazonaws.com', path: '/test.txt', query: {},
    headers: { range: 'bytes=0-9', 'x-amz-content-sha256': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', 'x-amz-date': '20130524T000000Z' },
    payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', region: 'us-east-1',
    keyId: 'AKIAIOSFODNN7EXAMPLE', secret: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', date: new Date('2013-05-24T00:00:00Z') });
  eq(s.signature, 'f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41');
  ok(s.authorization.startsWith('AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature='));
});
t('query parameters are sorted and encoded; a key keeps its slashes', () => {
  const s = A.signV4({ method: 'GET', host: 'b.s3.amazonaws.com', path: '/node_fills/hourly/20260615/12', query: { prefix: 'node_fills/hourly/', 'list-type': '2', delimiter: '/' },
    headers: {}, payloadHash: 'x', region: 'us-east-1', keyId: 'k', secret: 's', date: new Date(0) });
  eq(s.query, 'delimiter=%2F&list-type=2&prefix=node_fills%2Fhourly%2F');
  ok(s.canonicalRequest.split('\n')[1] === '/node_fills/hourly/20260615/12');
});

console.log('\nLZ4 frames');
const TEXT_SHA = '8b4ecca34bc9df927947717bec20da1d48ec2ee158798c64fec84c62de15920d', TEXT_LEN = 7692;
const LINKED = 'BCJNGGhADB4AAAAAAAD7jgMAAPMbeyJibG9ja190aW1lIjogIjIwMjYtMDYtMTVUMTI6MDA6MDAuMDAwIiwgKQDwNW51bWJlciI6IDEwMCwgImV2ZW50cyI6IFtbIjB4Yzg0NmU1MTNmMWZiNDQ4ZTc0NGQ1YzhlOTExZTg3YmNjYzBkZmIyTwBgeyJjb2lucwBASFlQRWAAIHB4DgBANDAuNQ4AIHN6DgASMXsAMXNpZJ4AEEEaAAOrAJAxNzgxNDM4NDABAPEALCAic3RhcnRQb3NpdGlvWACALTQxOTkuODI0ACBkabMAwCJDbG9zZSBTaG9ydBYAEGMPAEFkUG5sawASMnkAQGhhc2gQACAweKcAQiJvaWTtAADuAGBjcm9zc2URAJF0cnVlLCAiZmWYADAwLjFQABF0LAASNSwAcWZlZVRva2WLAJBVU0RDIn1dLCAlAR8xAQAUCSUBMEVUSGIAAiQBEzOSAQMkAQAZAAQiARBCDQAPIgEVAeEAAxsBkE9wZW4gTG9uZ0EACRkBITAuKAAPGAEDCRUBSGZhbHMWAQBLAAIUAR8yEQEDP119CoECDx8xgQIGHzGBAlEB2gEEXwESQdMAASwDBYECEjHxAQ+BAgIfOIECNwDuAA+BAhUALAAPgQL/Nx8ygQIGANcCDwIFTgHBBA+BAgofMoECCB83gQI3AO4AD4ECFQAsAA+BAv83HzOBAgYfMwIFURAz9QQPgQIKAJEGD4MHBR82gQI3AO4AD4ECFQAsAA+BAv83HzSBAgYfNIECUR80gQIOAAYKD4ECBR81gQI3AO4AD4ECFQAsAA+BAv83HzWBAgYfNYECUQKSDA+FDAkD9QsPBAoCHzSBAjcA7gAPgQIVACwAD4EC/zcfNoECBh82gQJRHzYCBQ4fNgQKCB8zgQI3AO4AD4ECFQAsAA+BAv83HzeBAgYfN4ECUR83gQIOHzeBAggfMoECNwDuAA+BAhUALAAPgQL/Nx84gQIGHziBAlEfOIECDh84gQIIHzGBAjcA7gAPgQIVACwAD4EC/zcfOYECBh85gQJRHzmBAg4fOYECCB8wgQI3AO4AD4ECFQAsAA+BAv82HzEKGQYQMRwYDwgUTRExhhcPhxEJAIgWAIoAD4UMAR84Chk3Ae4AD4ECFAEsAA+BAv83DwoZBhAx8BcPgQJODwoZDhAxggIPhxEEHzgKGTcB7gAPgQIVABoBD4EC/xBQfV1dfQoAAAAA';
const INDEP = 'BCJNGHxADB4AAAAAAADejgMAAPMbeyJibG9ja190aW1lIjogIjIwMjYtMDYtMTVUMTI6MDA6MDAuMDAwIiwgKQDwNW51bWJlciI6IDEwMCwgImV2ZW50cyI6IFtbIjB4Yzg0NmU1MTNmMWZiNDQ4ZTc0NGQ1YzhlOTExZTg3YmNjYzBkZmIyTwBgeyJjb2lucwBASFlQRWAAIHB4DgBANDAuNQ4AIHN6DgASMXsAMXNpZJ4AEEEaAAOrAJAxNzgxNDM4NDABAPEALCAic3RhcnRQb3NpdGlvWACALTQxOTkuODI0ACBkabMAwCJDbG9zZSBTaG9ydBYAEGMPAEFkUG5sawASMnkAQGhhc2gQACAweKcAQiJvaWTtAADuAGBjcm9zc2URAJF0cnVlLCAiZmWYADAwLjFQABF0LAASNSwAcWZlZVRva2WLAJBVU0RDIn1dLCAlAR8xAQAUCSUBMEVUSGIAAiQBEzOSAQMkAQAZAAQiARBCDQAPIgEVAeEAAxsBkE9wZW4gTG9uZ0EACRkBITAuKAAPGAEDCRUBSGZhbHMWAQBLAAIUAR8yEQEDP119CoECDx8xgQIGHzGBAlEB2gEEXwESQdMAASwDBYECEjHxAQ+BAgIfOIECNwDuAA+BAhUALAAPgQL/Nx8ygQIGANcCDwIFTgHBBA+BAgofMoECCB83gQI3AO4AD4ECFQAsAA+BAv83HzOBAgYfMwIFURAz9QQPgQIKAJEGD4MHBR82gQI3AO4AD4ECFQAsAA+BAv83HzSBAgYfNIECUR80gQIOAAYKD4ECBR81gQI3AO4AD4ECFQAsAA+BAv83HzWBAgYfNYECUQKSDA+FDAkD9QsPBAoCHzSBAjcA7gAPgQIVACwAD4EC/zcfNoECBh82gQJRHzYCBQ4fNgQKCB8zgQI3AO4AD4ECFQAsAA+BAv83HzeBAgYfN4ECUR83gQIOHzeBAggfMoECNwDuAA+BAhUALAAPgQL/Nx84gQIGHziBAlEfOIECDh84gQIIHzGBAjcA7gAPgQIVACwAD4EC/zcfOYECBh85gQJRHzmBAg4fOYECCB8wgQI3AO4AD4ECFQAsAA+BAv82HzEKGQYQMRwYDwgUTRExhhcPhxEJAIgWAIoAD4UMAR84Chk3Ae4AD4ECFAEsAA+BAv83DwoZBhAx8BcPgQJODwoZDhAxggIPhxEEHzgKGTcB7gAPgQIVABoBD4EC/xBQfV1dfQpir+siAAAAAC4KFco=';
const sha = b => createHash('sha256').update(b).digest('hex');
let TEXT = null;
t('a frame with linked blocks (the encoder’s default) decodes to the original', () => {
  const out = A.lz4Decode(Buffer.from(LINKED, 'base64')); eq(out.length, TEXT_LEN); eq(sha(out), TEXT_SHA); TEXT = out.toString('utf8');
});
t('independent blocks with block and content checksums and a stored size decode the same', () => {
  const out = A.lz4Decode(Buffer.from(INDEP, 'base64')); eq(sha(out), TEXT_SHA);
});
t('decodeObject tells lz4, gzip and plain apart; a skippable frame is skipped', () => {
  eq(A.decodeObject(Buffer.from(LINKED, 'base64')).encoding, 'lz4');
  const g = A.decodeObject(zlib.gzipSync(Buffer.from('{"a":1}\n'))); eq([g.encoding, g.text], ['gzip', '{"a":1}\n']);
  eq(A.decodeObject(Buffer.from('plain\n')).encoding, 'plain');
  const skip = Buffer.alloc(8); skip.writeUInt32LE(0x184D2A50, 0); skip.writeUInt32LE(0, 4);
  eq(sha(A.lz4Decode(Buffer.concat([skip, Buffer.from(LINKED, 'base64')]))), TEXT_SHA);
});
t('a truncated frame or a bad match offset is an error, not garbage', () => {
  let threw = 0; for (const b of [Buffer.from(LINKED, 'base64').subarray(0, 40), Buffer.from([0x04, 0x22, 0x4d, 0x18, 0x60, 0x40, 0x00, 0x05, 0, 0, 0, 0x10, 0xff, 0xff, 0x00, 0x00, 0x00, 0x00])]) { try { A.lz4Decode(b); } catch (e) { threw++; } }
  eq(threw, 2);
});

console.log('\nFills in a file');
const ADDR = '0xc846e513f1fb448e744d5c8e911e87bccc0dfb20';
t('node_fills lines: [address, fill] pairs under events — the wallet’s own, case-insensitively', () => {
  const x = A.extractFills(TEXT, ADDR.toUpperCase().replace('0X', '0x'));
  eq([x.lines, x.parsed, x.seen, x.fills.length], [12, 12, 24, 12]); eq(x.shapes, { pair: 24 });
  eq(x.fills[0].coin, 'HYPE'); eq(x.fills[0].tid, 5000); eq(x.fills[0].time, 1781438400000); ok(!('user' in x.fills[0]));
});
t('other shapes: {user, fill} objects and fills carrying a user field; times in seconds or ISO; a fill without ids gets a stable key', () => {
  const lines = [
    JSON.stringify({ user: ADDR, fill: { coin: 'ETH', px: '1', sz: '2', side: 'B', time: 1781438400, tid: 7, oid: 8 } }),
    JSON.stringify({ coin: 'ETH', px: '1', sz: '2', side: 'A', time: '2026-06-15T12:00:00.000', user: ADDR, hash: '0xabc' }),
    JSON.stringify({ user: '0x' + '2'.repeat(40), fill: { coin: 'ETH', px: '1', sz: '2', side: 'B', time: 1, tid: 9, oid: 9 } }),
    'not json',
  ].join('\n');
  const x = A.extractFills(lines, ADDR);
  eq([x.lines, x.parsed, x.seen, x.fills.length], [4, 3, 3, 2]); eq(x.shapes, { obj: 2, user: 1 });
  eq(x.fills[0].time, 1781438400000, 'seconds become milliseconds'); eq(x.fills[1].time, Date.UTC(2026, 5, 15, 12), 'an ISO time without a zone is UTC');
  ok(String(x.fills[1].tid).startsWith('ar:0xabc:'), 'no tid: keyed by hash, time, coin, size and side'); eq(x.fills[1].oid, 0);
});

console.log('\nWhat to download');
const ectx = { Math, Object, Array, String, Number, JSON, isFinite, Date, Set, Map, parseFloat };
vm.createContext(ectx);
vm.runInContext(['isPerp', 'newTrade', 'tallyFill', 'reconstructTrades'].map(grabFn).join('\n'), ectx);
const E = { reconstructTrades: ectx.reconstructTrades };
const T0 = Date.UTC(2026, 5, 15, 10, 30);
let tid = 0;
const F = (coin, side, sz, px, time, start, closedPnl = 0) => ({ coin, side, sz: String(sz), px: String(px), time, startPosition: String(start), closedPnl: String(closedPnl), fee: '0', feeToken: 'USDC', tid: ++tid, oid: ++tid, crossed: true, hash: '0x1' });
t('a seam becomes the hours between the coin’s last served fill and the fill that revealed it', () => {
  const fills = [F('ETH', 'B', 10, 1000, T0, 0), F('ETH', 'B', 2, 1200, T0 + 3 * 3600e3 + 60e3, 0), F('BTC', 'B', 1, 1, T0, 0)];
  const w = A.seamWindows(fills, E);
  eq(w.seams.length, 1); eq([w.seams[0].coin, w.seams[0].from, w.seams[0].to], ['ETH', T0, T0 + 3 * 3600e3 + 60e3]);
  eq(w.hours.length, 4, '10:30 → 13:31 covers the 10, 11, 12 and 13 o’clock files'); eq(w.skipped.length, 0);
});
t('a seam wider than the window limit is skipped and reported, not downloaded', () => {
  const w = A.seamWindows([F('ETH', 'B', 10, 1000, T0, 0), F('ETH', 'B', 2, 1200, T0 + 20 * 86400e3, 0)], E, { maxDays: 14 });
  eq([w.seams.length, w.skipped.length, w.hours.length], [0, 1, 0]); near(w.skipped[0].days, 20);
});
t('no seams, no hours; spot never counts', () => {
  eq(A.seamWindows([F('ETH', 'B', 1, 1, T0, 0), F('@107', 'A', 1, 1, T0 + 1, 50)], E).hours.length, 0);
});

console.log('\nOver HTTP, against a fake S3');
// the fake bucket: two days of hourly files; one holds the wallet's missing ETH close in lz4, another is plain
const DAY = d => { const x = new Date(d); return x.getUTCFullYear() + String(x.getUTCMonth() + 1).padStart(2, '0') + String(x.getUTCDate()).padStart(2, '0'); };
const H = 3600e3, SEAM_AT = T0 + 3 * H + 60e3; // the close we lost happened at T0 + 2h
const lostFill = { coin: 'ETH', px: '1100', sz: '10', side: 'A', time: T0 + 2 * H, startPosition: '10', dir: 'Close Long', closedPnl: '1000', hash: '0x9', oid: 777, crossed: true, fee: '1', tid: 7777, feeToken: 'USDC' };
const hourLine = (ms, events) => JSON.stringify({ block_time: new Date(ms).toISOString(), block_number: 1, events });
const objects = {}; // key -> Buffer
const day0 = DAY(T0), hours0 = [8, 9, 10, 11, 12, 13, 14];
for (const h of hours0) objects['node_fills/hourly/' + day0 + '/' + h] = Buffer.from(hourLine(Date.UTC(2026, 5, 15, h), [['0x' + '3'.repeat(40), { coin: 'SOL', px: '1', sz: '1', side: 'B', time: Date.UTC(2026, 5, 15, h), tid: 1, oid: 1 }]]) + '\n');
objects['node_fills/hourly/' + day0 + '/12'] = Buffer.from(hourLine(T0 + 2 * H, [[ADDR, lostFill], ['0x' + '3'.repeat(40), { coin: 'SOL', px: '1', sz: '1', side: 'B', time: T0 + 2 * H, tid: 1, oid: 1 }]]) + '\n');
objects['node_fills/hourly/20260614/5'] = Buffer.from(LINKED, 'base64');
objects['node_fills/hourly/20260601/12'] = Buffer.from(hourLine(Date.UTC(2026, 5, 1, 12), []) + '\n');
let DENY_LIST = false; // a bucket policy that allows GetObject but not ListBucket
const s3Calls = [];
const xmlEsc = s => s.replace(/&/g, '&amp;');
function fakeS3(url, init) {
  const u = new URL(url); s3Calls.push({ path: u.pathname, q: Object.fromEntries(u.searchParams), auth: init.headers.Authorization, payer: init.headers['x-amz-request-payer'] });
  if (!/^AWS4-HMAC-SHA256 Credential=AKIATEST\//.test(init.headers.Authorization || '')) return new Response('<Error><Code>AccessDenied</Code><Message>bad key</Message></Error>', { status: 403 });
  if (u.pathname === '/') { // ListObjectsV2
    if (DENY_LIST && init.method !== 'HEAD') return new Response('<Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>', { status: 403 });
    const prefix = u.searchParams.get('prefix') || '', delim = u.searchParams.get('delimiter');
    const keys = Object.keys(objects).filter(k => k.startsWith(prefix)).sort();
    let body = '<ListBucketResult><IsTruncated>false</IsTruncated>';
    if (delim) { const ps = [...new Set(keys.map(k => prefix + k.slice(prefix.length).split(delim)[0] + delim))]; for (const p of ps) body += '<CommonPrefixes><Prefix>' + xmlEsc(p) + '</Prefix></CommonPrefixes>'; }
    else for (const k of keys) body += '<Contents><Key>' + xmlEsc(k) + '</Key><Size>' + objects[k].length + '</Size></Contents>';
    return new Response(body + '</ListBucketResult>', { status: 200 });
  }
  const key = decodeURIComponent(u.pathname.slice(1)); const b = objects[key];
  if (!b) return new Response('<Error><Code>' + (DENY_LIST ? 'AccessDenied' : 'NoSuchKey') + '</Code></Error>', { status: DENY_LIST ? 403 : 404 }); // without ListBucket, S3 hides a missing key behind 403
  if (init.method === 'HEAD') return new Response(null, { status: 200, headers: { 'content-length': String(b.length) } });
  return new Response(b, { status: 200, headers: { 'content-length': String(b.length) } });
}
const hlFetch = async (url, init) => {
  if (/^https:\/\/(noaa-ghcn-pds|arxiv)\.s3/.test(url)) return new Response(/\?location/.test(url) ? '<LocationConstraint/>' : null, { status: 200, headers: { 'content-length': '10' } });
  if (/^https:\/\/s3\.amazonaws\.com\/$/.test(url)) return new Response('<ListAllMyBucketsResult><Buckets></Buckets></ListAllMyBucketsResult>', { status: 200 });
  if (/sts\.amazonaws\.com/.test(url)) return new Response('<GetCallerIdentityResponse><GetCallerIdentityResult><Arn>arn:aws:iam::123456789012:user/ledger-archive</Arn><UserId>AIDA</UserId><Account>123456789012</Account></GetCallerIdentityResult></GetCallerIdentityResponse>', { status: 200 });
  if (/amazonaws\.com/.test(url)) return fakeS3(url, init); return new Response('[]', { status: 200, headers: { 'content-type': 'application/json' } }); };
const dataDir = mkdtempSync(join(tmpdir(), 'ledger-archive-'));
const mk = env => createApp({ dataDir, auth: 'owner', htmlPath: join(here, '..', 'ledger.html'), push: false, pushTick: false, offsiteTimer: false, fetchImpl: hlFetch, archiveEnv: env });
const listen = app => new Promise(r => app.listen(0, '127.0.0.1', () => r('http://127.0.0.1:' + app.address().port)));
const FULL = { Authorization: 'Bearer owner', 'Content-Type': 'application/json' };
const call = async (base, p, body, h) => { const r = await fetch(base + p, { method: body === undefined ? 'GET' : 'POST', headers: h || FULL, body: body === undefined ? undefined : JSON.stringify(body) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
// the wallet's server cache: the open, then the fresh entry — the close between them is missing
const seamFills = [F('ETH', 'B', 10, 1000, T0, 0), F('ETH', 'B', 2, 1200, SEAM_AT, 0), F('ETH', 'A', 2, 1300, SEAM_AT + 60e3, 2, 200)];
await t('without the key the endpoints say what is missing; the owner token is required', async () => {
  const app = mk({}); const base = await listen(app);
  try {
    const st = await call(base, '/api/v1/archive'); eq(st.status, 200); eq(st.body.configured, false);
    eq((await call(base, '/api/v1/archive/check', {})).status, 503);
    eq((await call(base, '/api/v1/archive', undefined, { Authorization: 'Bearer nope' })).status, 401);
  } finally { app.close(); }
});
const app = mk({ ARCHIVE_AWS_KEY_ID: 'AKIATEST', ARCHIVE_AWS_SECRET: 'sekrit', ARCHIVE_COST_PER_GB: '1', ARCHIVE_PREFIX: 'node_fills/hourly/' });
const base = await listen(app);
try {
  // put the wallet and its fills in place: a snapshot with the wallet, and the cache file the refresh would have written
  await fetch(base + '/api/data', { method: 'POST', headers: FULL, body: JSON.stringify({ snapshot: { wallets: [{ address: ADDR, label: 'main' }], settings: {}, journal: {} } }) });
  const { writeFileSync, mkdirSync } = await import('node:fs');
  mkdirSync(join(dataDir, 'fills'), { recursive: true });
  writeFileSync(join(dataDir, 'fills', ADDR + '.json.gz'), zlib.gzipSync(JSON.stringify({ v: 1, last: SEAM_AT + 60e3, count: 3, savedAt: Date.now(), truncated: false, fills: seamFills })));
  await t('check: the archive’s days, a day’s size, and the wallet’s seam plan with bytes and cost', async () => {
    const r = await call(base, '/api/v1/archive/check', { wallets: [ADDR] });
    eq(r.status, 200, JSON.stringify(r.body));
    eq([r.body.archive.first, r.body.archive.last], ['20260601', day0]);
    eq(r.body.sampleDay.hours, 7);
    const w = r.body.wallets[0]; eq(w.address, ADDR); eq([w.seams, w.hours], [1, 4]); eq(w.missing, []);
    ok(w.bytes > 0 && w.estCost === +((w.bytes / 1073741824) * 1).toFixed(2));
    ok(s3Calls.every(c => c.payer === 'requester'), 'every request pays');
  });
  await t('sample: the file’s format and the wallet’s fills in it', async () => {
    const r = await call(base, '/api/v1/archive/sample', { day: '20260614', hour: 5, wallets: [ADDR] });
    eq(r.status, 200); eq(r.body.encoding, 'lz4'); eq(r.body.lines, 12); eq(r.body.wallets[ADDR].fills, 12);
    const p = await call(base, '/api/v1/archive/sample', { day: day0, hour: 12, wallets: [ADDR] }); eq(p.body.encoding, 'plain'); eq(p.body.wallets[ADDR].fills, 1);
  });
  await t('a plan over the cap is refused with its size; a dry run plans without downloading', async () => {
    const r = await call(base, '/api/v1/archive/backfill', { address: ADDR, maxGB: 0.0000001 });
    eq(r.status, 413); ok(/over the/.test(r.body.error)); eq(r.body.plan.hours, 4);
    const d = await call(base, '/api/v1/archive/backfill', { address: ADDR, maxGB: 1, dryRun: true });
    eq(d.status, 202); eq([d.body.state, d.body.total, d.body.done], ['done', 4, 0]);
  });
  await t('diagnose: each probe reports, and the verdict reads the archive as readable', async () => {
    const r = await call(base, '/api/v1/archive/diagnose', {});
    eq(r.status, 200, JSON.stringify(r.body)); ok(/readable/.test(r.body.verdict), r.body.verdict);
    ok(r.body.steps.listDataset.ok && r.body.steps.listDataset.prefixes.length === 3, JSON.stringify(r.body.steps.listDataset));
    ok(r.body.steps.identity && (r.body.steps.identity.status || r.body.steps.identity.error), 'STS was asked');
    eq(r.body.steps.headObject.status, 200);
  });
  await t('backfill: the four hours are read, the lost close is merged into the cache, and the browser can tell', async () => {
    const before = s3Calls.length;
    const r = await call(base, '/api/v1/archive/backfill', { address: ADDR, maxGB: 1 });
    eq(r.status, 202); ok(r.body.state === 'running' || r.body.state === 'done', r.body.state); eq(r.body.total, 4); // the fake S3 answers in-process, so it may already be done
    let st; for (let i = 0; i < 100; i++) { st = (await call(base, '/api/v1/archive')).body; if (st.job.state !== 'running') break; await new Promise(x => setTimeout(x, 30)); }
    eq(st.job.state, 'done', JSON.stringify(st.job)); eq([st.job.done, st.job.fills, st.job.added, st.job.cacheCount], [4, 1, 1, 4]);
    eq(s3Calls.slice(before).filter(c => c.path !== '/').length, 4, 'one GET per hour');
    const meta = await call(base, '/api/v1/cache/' + ADDR + '?meta=1'); eq(meta.body.fills.count, 4); ok(meta.body.fills.archived.at > 0); eq(meta.body.fills.archived.n, 1);
    const full = await call(base, '/api/v1/cache/' + ADDR); ok(full.body.fills.fills.some(f => f.tid === 7777)); eq(full.body.fills.archived.n, 1);
    // the seam is gone: the trades now close properly
    const tr = E.reconstructTrades(full.body.fills.fills, ADDR, 'perp'); ok(tr.every(x => !x.offRecord && !x.gaps)); eq(tr.length, 2);
    // again: nothing new to add, the cache keeps its count
    const again = await call(base, '/api/v1/archive/backfill', { address: ADDR, maxGB: 1 });
    eq(again.body.total, 0, 'no seams left, nothing to download');
  });
} finally { app.close(); }

console.log('\nWhen the bucket refuses to be listed');
await t('the archive is read by name: the first day is found by probing, the seam’s hours are read, the backfill works', async () => {
  DENY_LIST = true; s3Calls.length = 0;
  const dir2 = mkdtempSync(join(tmpdir(), 'ledger-archive2-'));
  const { writeFileSync, mkdirSync } = await import('node:fs');
  mkdirSync(join(dir2, 'fills'), { recursive: true });
  writeFileSync(join(dir2, 'fills', ADDR + '.json.gz'), zlib.gzipSync(JSON.stringify({ v: 1, last: SEAM_AT + 60e3, count: 3, savedAt: Date.now(), truncated: false, fills: seamFills })));
  const app2 = createApp({ dataDir: dir2, auth: 'owner', htmlPath: join(here, '..', 'ledger.html'), push: false, pushTick: false, offsiteTimer: false, fetchImpl: hlFetch,
    archiveEnv: { ARCHIVE_AWS_KEY_ID: 'AKIATEST', ARCHIVE_AWS_SECRET: 'sekrit', ARCHIVE_PREFIX: 'node_fills/hourly/' }, now: () => Date.UTC(2026, 5, 18, 9) }); // the archive lags: the newest file is three days old
  const b2 = await listen(app2);
  try {
    const d = await call(b2, '/api/v1/archive/diagnose', {});
    ok(/read by name/.test(d.body.verdict), d.body.verdict); ok(d.body.steps.readByName['node_fills/hourly/'].ok);
    const r = await call(b2, '/api/v1/archive/check', { wallets: [ADDR] });
    eq(r.status, 200, JSON.stringify(r.body)); eq(r.body.noList, true);
    eq([r.body.archive.first, r.body.archive.last, r.body.archive.days], ['20260601', day0, null]);
    const w = r.body.wallets[0]; eq([w.seams, w.hours, w.missing.length], [1, 4, 0]); ok(w.bytes > 0);
    ok(s3Calls.filter(c => c.path === '/' && c.q['list-type']).length >= 1, 'listing was tried once'); ok(!s3Calls.some(c => c.q.prefix && c.q.prefix.includes('2026061') && c.q['list-type'] && s3Calls.indexOf(c) > 3), 'then never again');
    const bf = await call(b2, '/api/v1/archive/backfill', { address: ADDR, maxGB: 1 });
    eq(bf.status, 202);
    let st; for (let i = 0; i < 100; i++) { st = (await call(b2, '/api/v1/archive')).body; if (st.job.state !== 'running') break; await new Promise(x => setTimeout(x, 30)); }
    eq([st.job.state, st.job.done, st.job.fills, st.job.added], ['done', 4, 1, 1]);
    eq(st.naming, { pad: false, ext: '' }); ok(r.body.archive.note, 'says the days were probed');
  } finally { app2.close(); DENY_LIST = false; }
});

report();
