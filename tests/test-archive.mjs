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
// a frame by hand: the descriptor with its real header checksum, the blocks ([bytes, stored?]), the end mark
const frame = (flg, blocks, bd = 0x40) => { const desc = Buffer.from([flg, bd]), parts = [Buffer.from([0x04, 0x22, 0x4d, 0x18]), desc, Buffer.from([(A.xxh32(desc) >>> 8) & 0xff])];
  for (const [b, stored] of blocks) { const h = Buffer.alloc(4); h.writeUInt32LE((b.length | (stored ? 0x80000000 : 0)) >>> 0); parts.push(h, Buffer.from(b)); }
  return Buffer.concat([...parts, Buffer.alloc(4)]); };
const lz4Err = (b, opts) => { try { const out = A.lz4Decode(b, opts); return 'decoded ' + out.length + ' bytes'; } catch (e) { return e.message; } };
t('xxHash32 matches its published vectors (the checksum LZ4 frames carry)', () => {
  eq([A.xxh32(Buffer.alloc(0)), A.xxh32(Buffer.from('abc')), A.xxh32(Buffer.from('Nobody inspects the spammish repetition'))], [0x02CC5D05, 0x32D153FF, 0xE2293B2F]);
});
t('a literal run longer than its block throws instead of returning bytes it never wrote', () => {
  const b = frame(0x60, [[[0xF0, 80, ...Buffer.from('abcdefghij')]]]); // 15 + 80 = 95 literals claimed, 10 present
  ok(/literal run of 95 bytes passes the end of its block/.test(lz4Err(b)), lz4Err(b));
  ok(/truncated literal length/.test(lz4Err(frame(0x60, [[[0xF0, 255]]]))), 'a length cut off mid-way');
  let got = null; A.lz4Stream(frame(0x60, [[[0x30, ...Buffer.from('abc')]]]), c => { got = Buffer.from(c).toString(); }); eq(got, 'abc', 'a well-formed one still decodes');
});
t('a match offset of zero, or past the bytes written (or, with independent blocks, past the block’s own), throws', () => {
  ok(/bad match offset/.test(lz4Err(frame(0x60, [[[0x10, 0x41, 0x00, 0x00, 0x10, 0x42]]]))), 'offset 0');
  ok(/bad match offset/.test(lz4Err(frame(0x60, [[[0x10, 0x41, 0x05, 0x00, 0x10, 0x42]]]))), 'offset 5 with 1 byte written');
  ok(/truncated match/.test(lz4Err(frame(0x60, [[[0x10, 0x41, 0x05]]]))), 'an offset cut in half');
  const blocks = [[[0x80, ...Buffer.from('abcdefgh')]], [[0x00, 0x08, 0x00, 0x10, 0x7a]]]; // the second block copies 4 bytes from the first
  eq(A.lz4Decode(frame(0x40, blocks)).toString(), 'abcdefghabcdz', 'linked blocks may reach back');
  ok(/bad match offset/.test(lz4Err(frame(0x60, blocks))), 'independent ones may not');
});
t('output is bounded: by the cap (a bomb) and by the block maximum the descriptor declares', () => {
  const run = n => [0x1F, 0x61, 0x01, 0x00, ...Array(n).fill(0xFF), 0x00, 0x10, 0x62]; // 'a', then a repeat of it 19 + 255n long, then 'b'
  eq(A.lz4Decode(frame(0x60, [[run(200)]])).toString(), 'a'.repeat(51020) + 'b', 'an overlapping repeat decodes');
  ok(/output over the 1000 byte limit/.test(lz4Err(frame(0x60, [[run(200)]]), { maxOut: 1000 })), lz4Err(frame(0x60, [[run(200)]]), { maxOut: 1000 }));
  ok(/past its 65536 byte maximum/.test(lz4Err(frame(0x60, [[run(300)]]))), 'a block decoding past 64 KB under a 64 KB descriptor');
  ok(/past its 65536 byte maximum/.test(lz4Err(frame(0x60, [[Buffer.alloc(65537), true]]))), 'a stored block too');
  ok(/output over the 10 byte limit/.test(lz4Err(frame(0x60, [[Buffer.alloc(11), true]]), { maxOut: 10 })), 'and under the cap');
});
t('header, block and content checksums are verified; a stored content size is held to', () => {
  const good = Buffer.from(INDEP, 'base64'), bad = i => { const b = Buffer.from(good); b[i] ^= 1; return lz4Err(b); };
  ok(/header checksum mismatch/.test(bad(14)), bad(14)); ok(/block checksum mismatch/.test(bad(30)), bad(30)); ok(/content checksum mismatch/.test(bad(good.length - 1)), bad(good.length - 1));
  const desc = Buffer.concat([Buffer.from([0x68, 0x40]), Buffer.from([5, 0, 0, 0, 0, 0, 0, 0])]); // content size 5, 3 bytes follow
  const short = Buffer.concat([Buffer.from([0x04, 0x22, 0x4d, 0x18]), desc, Buffer.from([(A.xxh32(desc) >>> 8) & 0xff, 3, 0, 0, 0x80, 0x61, 0x62, 0x63, 0, 0, 0, 0])]);
  ok(/decodes to 3 bytes, its header says 5/.test(lz4Err(short)), lz4Err(short));
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

t('the streaming reader finds the same fills as the whole-text one, from lz4, gzip and plain, with a preview', () => {
  const whole = A.extractFills(TEXT, ADDR);
  for (const [name, buf] of [['lz4 linked', Buffer.from(LINKED, 'base64')], ['lz4 indep', Buffer.from(INDEP, 'base64')], ['gzip', zlib.gzipSync(Buffer.from(TEXT))], ['plain', Buffer.from(TEXT)]]) {
    const s = A.extractFillsFromObject(buf, ADDR, { preview: 40 });
    eq([s.lines, s.parsed, s.seen, s.fills.length], [whole.lines, whole.parsed, whole.seen, whole.fills.length], name);
    eq(s.fills.map(f => f.tid), whole.fills.map(f => f.tid), name + ' order'); eq(s.preview, TEXT.slice(0, 40), name + ' preview');
  }
  // a line cut across chunks: the streaming decoder hands blocks of a few bytes here
  const chunks = []; A.lz4Stream(Buffer.from(LINKED, 'base64'), c => chunks.push(Buffer.from(c)));
  eq(sha(Buffer.concat(chunks)), TEXT_SHA, 'the blocks concatenate to the original');
});
t('a gzip bomb stops at the cap: the reader, decodeObject and the indexer’s gunzip alike', () => {
  const bomb = zlib.gzipSync(Buffer.alloc(8 << 20)); ok(bomb.length < 64 << 10, 'kilobytes that inflate to 8 MB');
  for (const f of [() => A.extractFillsFromObject(bomb, ADDR, { maxOut: 1 << 20 }), () => A.decodeObject(bomb, { maxOut: 1 << 20 }), () => A.gunzipCapped(bomb, 1 << 20)]) {
    let msg = null; try { f(); } catch (e) { msg = e.message; } ok(/gzip: output over the 1048576 byte limit/.test(msg), msg); }
  eq(A.gunzipCapped(bomb, 8 << 20).length, 8 << 20, 'at the cap it inflates whole');
});
t('several addresses are read in one pass, each into its own list', () => {
  const x = A.extractFillsFromObject(Buffer.from(LINKED, 'base64'), [ADDR, '0x' + '2'.repeat(40)]);
  eq([x.fills.length, x.byAddress[ADDR].length, x.byAddress['0x' + '2'.repeat(40)].length], [12, 12, 0]);
});
await t('a download is capped by the bytes that arrive, whatever Content-Length claims', async () => {
  const body = Buffer.alloc(5000, 1), sent = [];
  const c = hdrs => A.s3Client({ keyId: 'k', secret: 's', bucket: 'b', region: 'us-east-1', fetchImpl: async () => new Response(new ReadableStream({ pull(ctl) { const i = sent.length; if (i === 5) return ctl.close(); sent.push(i); ctl.enqueue(body.subarray(i * 1000, (i + 1) * 1000)); } }), { status: 200, headers: hdrs }) });
  for (const h of [{}, { 'content-length': '10' }]) { sent.length = 0;
    const err = await c(h).get('x', { maxBytes: 2048 }).then(() => null, e => e);
    ok(err && err.code === 'TooLarge' && /over the 2048 byte limit/.test(err.message), JSON.stringify(h) + ': ' + (err && err.message)); ok(sent.length <= 4, 'the read stopped at the cap: ' + sent.length + ' chunks pulled'); }
  sent.length = 0; eq((await c({}).get('x', { maxBytes: 5000 })).length, 5000, 'at the cap it arrives whole');
  const declared = await c({ 'content-length': '9999' }).get('x', { maxBytes: 2048 }).then(() => null, e => e.message); ok(/9999 bytes — over the 2048/.test(declared), 'a declared size over the cap is refused before reading: ' + declared);
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
t('scope: exits (the default) keeps only seams on trades that lost their exits; all adds the entry seams', () => {
  // ETH: closed off the record (an exit seam). BTC: went flat in the fills, then a later fill starts from a held position (an entry seam)
  const fills = [F('ETH', 'B', 10, 1000, T0, 0), F('ETH', 'B', 2, 1200, T0 + 2 * 3600e3, 0),
    F('BTC', 'B', 1, 1, T0, 0), F('BTC', 'A', 1, 1, T0 + 60e3, 1, 0), F('BTC', 'A', 1, 1, T0 + 5 * 3600e3, 3, 0)];
  const ex = A.seamWindows(fills, E), all = A.seamWindows(fills, E, { scope: 'all' });
  eq(ex.seams.map(w => w.coin), ['ETH']); ok(all.seams.length >= ex.seams.length && all.seams.some(w => w.coin === 'BTC'), JSON.stringify(all.seams));
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
const INDEX = {}; // the index by wallet, filled in below once the fixtures exist
const s3Calls = [];
const xmlEsc = s => s.replace(/&/g, '&amp;');
function fakeS3(url, init) {
  const u = new URL(url); s3Calls.push({ path: u.pathname, q: Object.fromEntries(u.searchParams), auth: init.headers.Authorization, payer: init.headers['x-amz-request-payer'], token: init.headers['x-amz-security-token'] });
  if (/^other-account-index\./.test(u.hostname)) return new Response('<Error><Code>AccessDenied</Code><Message>User: arn:aws:iam::233207006248:user/ledger-archive is not authorized to perform: s3:ListBucket on resource: "arn:aws:s3:::other-account-index" because no resource-based policy allows the s3:ListBucket action</Message></Error>', { status: 403 });
  if (/^missing-index\./.test(u.hostname)) return new Response('<Error><Code>NoSuchBucket</Code><Message>The specified bucket does not exist</Message></Error>', { status: 404 }); // an index bucket not created yet
  if (/^my-hl-index\./.test(u.hostname)) { // the index bucket (no requester pays)
    if (u.pathname === '/') { const prefix = u.searchParams.get('prefix') || '', delim = u.searchParams.get('delimiter'); const keys = Object.keys(INDEX).filter(k => k.startsWith(prefix)).sort();
      let body = '<ListBucketResult><IsTruncated>false</IsTruncated>';
      if (delim) { const ps = [...new Set(keys.map(k => prefix + k.slice(prefix.length).split(delim)[0] + delim))]; for (const p of ps) body += '<CommonPrefixes><Prefix>' + xmlEsc(p) + '</Prefix></CommonPrefixes>'; }
      else for (const k of keys) body += '<Contents><Key>' + xmlEsc(k) + '</Key><Size>' + INDEX[k].length + '</Size></Contents>';
      return new Response(body + '</ListBucketResult>', { status: 200 }); }
    const key = decodeURIComponent(u.pathname.slice(1)); const b = INDEX[key];
    if (init.method === 'PUT') { INDEX[key] = Buffer.from(init.body || ''); return new Response('', { status: 200 }); }
    if (!b) return new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 });
    if (init.method === 'HEAD') return new Response(null, { status: 200, headers: { 'content-length': String(b.length) } });
    return new Response(b, { status: 200, headers: { 'content-length': String(b.length) } });
  }
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
// the index by wallet, as archive-indexer.js writes it: the wallet's shard for two days, one day empty for it, markers (with the day's fill count — a marker without fills isn't a finished day) and progress
const shard = ADDR.slice(2, 5);
const idxLine = f => JSON.stringify([ADDR, f]) + '\n';
INDEX['index/v1/d/20260615/' + shard + '.jsonl.gz'] = Buffer.concat([zlib.gzipSync(idxLine(seamFills[0])), zlib.gzipSync(idxLine(lostFill))]); // two gzip members, as appended hour by hour
INDEX['index/v1/d/20260615/_done'] = Buffer.from('{"day":"20260615","hours":24,"fills":812345}');
INDEX['index/v1/d/20260616/' + shard + '.jsonl.gz'] = zlib.gzipSync(idxLine(seamFills[1]) + idxLine(seamFills[2]) + JSON.stringify(['0x' + '9'.repeat(40), lostFill]) + '\n');
INDEX['index/v1/d/20260616/_done'] = Buffer.from('{"day":"20260616","hours":24,"fills":790112}');
INDEX['index/v1/d/20260617/_done'] = Buffer.from('{"day":"20260617","hours":24,"fills":801876}'); // the wallet had no fills that day: no shard file
INDEX['index/v1/progress.json'] = Buffer.from(JSON.stringify({ lastDay: '20260617', lastSummary: { fills: 123456 } }));
await t('without the key the endpoints say what is missing; the owner token is required', async () => {
  const app = mk({}); const base = await listen(app);
  try {
    const st = await call(base, '/api/v1/archive'); eq(st.status, 200); eq(st.body.configured, false);
    eq((await call(base, '/api/v1/archive/check', {})).status, 503);
    eq((await call(base, '/api/v1/archive', undefined, { Authorization: 'Bearer nope' })).status, 401);
  } finally { app.close(); }
});
await t('an open server (no AUTH_TOKEN) refuses the archive: nobody but the owner spends its AWS budget', async () => {
  const dirO = mkdtempSync(join(tmpdir(), 'ledger-archive-open-'));
  const appO = createApp({ dataDir: dirO, auth: '', htmlPath: join(here, '..', 'ledger.html'), push: false, pushTick: false, offsiteTimer: false, fetchImpl: hlFetch,
    archiveEnv: { ARCHIVE_AWS_KEY_ID: 'AKIATEST', ARCHIVE_AWS_SECRET: 'sekrit' } });
  const bO = await listen(appO);
  try {
    eq((await call(bO, '/api/v1/archive', undefined, {})).status, 403);
    eq((await call(bO, '/api/v1/archive/backfill', { address: ADDR, maxGB: 1 }, { 'Content-Type': 'application/json' })).status, 403);
  } finally { appO.close(); }
});
const app = mk({ ARCHIVE_AWS_KEY_ID: 'AKIATEST', ARCHIVE_AWS_SECRET: 'sekrit', ARCHIVE_COST_PER_GB: '1', ARCHIVE_PREFIX: 'node_fills/hourly/' });
const base = await listen(app);
try {
  // put the wallet and its fills in place: a snapshot with the wallet, and the cache file the refresh would have written
  await fetch(base + '/api/data', { method: 'POST', headers: FULL, body: JSON.stringify({ snapshot: { wallets: [{ address: ADDR, label: 'main' }], settings: {}, journal: {} } }) });
  const { writeFileSync, mkdirSync } = await import('node:fs');
  mkdirSync(join(dataDir, 'fills'), { recursive: true });
  writeFileSync(join(dataDir, 'fills', ADDR + '.json.gz'), zlib.gzipSync(JSON.stringify({ v: 1, last: SEAM_AT + 60e3, count: 3, savedAt: Date.now(), truncated: false, fills: seamFills })));
  await t('PUT /api/v1/cache/:addr merges the browser’s fills into the server’s copy (and creates it)', async () => {
    const other = '0x' + 'a'.repeat(40);
    const r = await fetch(base + '/api/v1/cache/' + other, { method: 'PUT', headers: FULL, body: JSON.stringify({ fills: seamFills.slice(0, 2), twapFull: true }) });
    eq(r.status, 200); eq(await r.json(), { ok: true, added: 2, count: 2 });
    const r2 = await fetch(base + '/api/v1/cache/' + other, { method: 'PUT', headers: FULL, body: JSON.stringify({ fills: seamFills }) });
    eq(await r2.json(), { ok: true, added: 1, count: 3 }, 'only the new one is added');
    const m = await call(base, '/api/v1/cache/' + other + '?meta=1'); eq([m.body.fills.count, m.body.fills.twapFull], [3, true]);
    eq((await fetch(base + '/api/v1/cache/' + other, { method: 'PUT', headers: FULL, body: JSON.stringify({ fills: 'no' }) })).status, 400);
    eq((await fetch(base + '/api/v1/cache/' + other, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
  });
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

console.log('\nWith an index by wallet');
await t('backfill reads the wallet’s shard for every day of the index and merges its whole history; check reports the index', async () => {
  const dir3 = mkdtempSync(join(tmpdir(), 'ledger-archive3-'));
  const { writeFileSync, mkdirSync } = await import('node:fs');
  mkdirSync(join(dir3, 'fills'), { recursive: true });
  writeFileSync(join(dir3, 'fills', ADDR + '.json.gz'), zlib.gzipSync(JSON.stringify({ v: 1, last: SEAM_AT + 60e3, count: 3, savedAt: Date.now(), truncated: false, fills: seamFills })));
  const app3 = createApp({ dataDir: dir3, auth: 'owner', htmlPath: join(here, '..', 'ledger.html'), push: false, pushTick: false, offsiteTimer: false, fetchImpl: hlFetch,
    archiveEnv: { ARCHIVE_AWS_KEY_ID: 'AKIATEST', ARCHIVE_AWS_SECRET: 'sekrit', ARCHIVE_PREFIX: 'node_fills/hourly/', ARCHIVE_INDEX_BUCKET: 'my-hl-index', ARCHIVE_INDEX_REGION: 'ap-northeast-1' } });
  const b3 = await listen(app3);
  try {
    const st = await call(b3, '/api/v1/archive'); eq(st.body.index, { bucket: 'my-hl-index', prefix: 'index/v1/' });
    const c = await call(b3, '/api/v1/archive/check', { wallets: [ADDR] }); eq([c.body.index.days.length, c.body.index.first, c.body.index.last, c.body.index.progress.lastDay], [3, '20260615', '20260617', '20260617']);
    s3Calls.length = 0;
    const bf = await call(b3, '/api/v1/archive/backfill', { address: ADDR }); eq(bf.status, 202); eq(bf.body.source, 'index');
    let s; for (let i = 0; i < 100; i++) { s = (await call(b3, '/api/v1/archive')).body; if (s.job.state !== 'running') break; await new Promise(x => setTimeout(x, 30)); }
    eq([s.job.state, s.job.total, s.job.indexFiles, s.job.fills, s.job.added, s.job.cacheCount], ['done', 3, 2, 4, 1, 4], JSON.stringify(s.job));
    ok(!s3Calls.some(c => c.payer && /my-hl-index/.test(c.path + '')), 'no requester-pays header to our own bucket');
    const full = await call(b3, '/api/v1/cache/' + ADDR); ok(full.body.fills.fills.some(f => f.tid === 7777), 'the lost close came back from the index');
    const tr = E.reconstructTrades(full.body.fills.fills, ADDR, 'perp'); ok(tr.every(x => !x.offRecord && !x.gaps));
    // the hours path is still there when asked for
    const h = await call(b3, '/api/v1/archive/backfill', { address: ADDR, source: 'hours', maxGB: 1 }); eq(h.body.total, 0, 'no seams left to hunt');
  } finally { app3.close(); }
});
// the archive on its own, with a cache writer that records what it was asked to write
const arch = (env, fetchImpl) => { const writes = [];
  const a = A.createArchive({ env: Object.assign({ ARCHIVE_AWS_KEY_ID: 'AKIATEST', ARCHIVE_AWS_SECRET: 'sekrit', ARCHIVE_PREFIX: 'node_fills/hourly/', ARCHIVE_INDEX_BUCKET: 'my-hl-index', ARCHIVE_INDEX_REGION: 'ap-northeast-1' }, env || {}),
    fetchImpl: fetchImpl || hlFetch, engine: E, readFills: () => seamFills, writeFills: (addr, f, info) => { writes.push({ addr, fills: f, info }); return { added: f.length, count: f.length }; }, log: () => {} });
  return Object.assign(a, { writes }); };
const settle = async a => { for (let i = 0; i < 300 && a.status().job.state === 'running'; i++) await new Promise(r => setTimeout(r, 10)); return a.status().job; };
// a fetch that holds the GETs it matches until released, and says when the first one is waiting
const gated = match => { let enter, release; const entered = new Promise(r => { enter = r; }), open = new Promise(r => { release = r; });
  return { entered, release: () => release(), fetch: async (url, init) => { if (init.method === 'GET' && match(new URL(url).pathname)) { enter(); await open; } return hlFetch(url, init); } }; };
await t('a dry run from the index lists the days and never downloads a shard or writes', async () => {
  const a = arch(); s3Calls.length = 0;
  const j = await a.backfill({ address: ADDR, dryRun: true });
  eq([j.state, j.source, j.total, j.dryRun, j.incompleteDays], ['done', 'index', 3, true, []]);
  await new Promise(r => setTimeout(r, 30)); eq(a.writes.length, 0, 'nothing written');
  ok(!s3Calls.some(c => /\.jsonl\.gz$/.test(c.path)), 'no shard was read');
});
await t('a second start while the first is still planning is refused', async () => {
  const a = arch(); const p1 = a.backfill({ address: ADDR }), p2 = a.backfill({ address: ADDR }).then(() => null, e => e);
  const e2 = await p2; ok(e2 && e2.code === 409, 'the second start: ' + (e2 && e2.message));
  eq((await p1).source, 'index'); eq((await settle(a)).state, 'done'); eq(a.writes.length, 1, 'one job, one write');
  const h = arch({ ARCHIVE_INDEX_BUCKET: '' }); const q1 = h.backfill({ address: ADDR, maxGB: 1 }), q2 = h.backfill({ address: ADDR, maxGB: 1 }).then(() => null, e => e);
  eq((await q2 || {}).code, 409, 'the hours plan too'); await q1; await settle(h);
  // a refused plan (over budget) leaves no running job behind, and the last job stays on record
  const over = await h.backfill({ address: ADDR, maxGB: 1e-9 }).then(() => null, e => e); eq(over.code, 413); eq(h.status().job.state, 'done');
});
await t('a job stopped while downloading writes nothing: from the index, and from the hours with the stop landing on the last one', async () => {
  const g = gated(p => /\.jsonl\.gz$/.test(p)), a = arch({}, g.fetch);
  const j = await a.backfill({ address: ADDR }); await g.entered;
  eq(a.stop().state, 'stopped'); g.release();
  await new Promise(r => setTimeout(r, 50)); eq(j.state, 'stopped'); eq(a.writes.length, 0, 'the index job merged nothing');
  const g2 = gated(p => /\/node_fills\/hourly\/\d+\/13$/.test(p)), h = arch({ ARCHIVE_INDEX_BUCKET: '' }, g2.fetch); // 13:00 is the plan's last hour
  const hj = await h.backfill({ address: ADDR, maxGB: 1 }); eq([hj.source, hj.total], ['hours', 4]); await g2.entered;
  eq(hj.done, 3, 'three hours read, the last one in flight'); h.stop(); g2.release();
  await new Promise(r => setTimeout(r, 50)); eq(hj.state, 'stopped'); eq(a.writes.length + h.writes.length, 0, 'the hours job merged nothing either');
  const again = await h.backfill({ address: ADDR, maxGB: 1 }); eq(again.state, 'running', 'a stopped job doesn’t block the next'); await settle(h); eq(h.writes.length, 1);
});
await t('the index downloads are held to maxGB: past it the job fails and writes nothing', async () => {
  const a = arch(); await a.backfill({ address: ADDR, maxGB: 1e-9 }); const j = await settle(a);
  eq(j.state, 'failed'); ok(/budget/.test(j.lastError), j.lastError); eq(a.writes.length, 0);
});
await t('a day without its _done marker (or with one that counts no fills) is reported incomplete, not read as a quiet day', async () => {
  const P = 'index/t9/d/', gz = f => zlib.gzipSync(idxLine(f)), done = n => Buffer.from(JSON.stringify({ hours: 24, fills: n }));
  INDEX[P + '20260615/' + shard + '.jsonl.gz'] = gz(seamFills[0]); INDEX[P + '20260615/_done'] = done(9);
  INDEX[P + '20260616/' + shard + '.jsonl.gz'] = gz(lostFill); // the upload stopped here: shards, no marker
  INDEX[P + '20260617/' + shard + '.jsonl.gz'] = gz(seamFills[1]); INDEX[P + '20260617/_done'] = done(0); // a marker over nothing
  INDEX[P + '20260619/_done'] = done(9); // the wallet was quiet that day; the 18th is missing altogether
  const a = arch({ ARCHIVE_INDEX_PREFIX: 'index/t9/' });
  const d = await a.indexDays(); eq([d.days, d.incomplete, d.first, d.last], [['20260615', '20260619'], ['20260616', '20260617', '20260618'], '20260615', '20260619']);
  const j0 = await a.backfill({ address: ADDR, dryRun: true }); eq([j0.state, j0.incompleteDays], ['incomplete', ['20260616', '20260617', '20260618']]);
  await a.backfill({ address: ADDR }); const j = await settle(a);
  eq([j.state, j.total, j.indexFiles, j.fills], ['incomplete', 2, 1, 1], JSON.stringify(j)); ok(/3 day\(s\).*not finished.*20260616, 20260617, 20260618/.test(j.note), j.note);
  eq(a.writes[0].fills.map(f => f.tid), [seamFills[0].tid], 'only the finished day’s fills are merged');
  const late = await a.backfill({ address: ADDR, fromDay: '20260618' }); eq([late.total, late.incompleteDays], [1, ['20260618']]); await settle(a);
});
await t('an index bucket that does not exist yet: check says so, and backfill falls back to the hours plan', async () => {
  const dir4 = mkdtempSync(join(tmpdir(), 'ledger-archive4-'));
  const { writeFileSync, mkdirSync } = await import('node:fs');
  mkdirSync(join(dir4, 'fills'), { recursive: true });
  writeFileSync(join(dir4, 'fills', ADDR + '.json.gz'), zlib.gzipSync(JSON.stringify({ v: 1, last: SEAM_AT + 60e3, count: 3, savedAt: Date.now(), truncated: false, fills: seamFills })));
  const app4 = createApp({ dataDir: dir4, auth: 'owner', htmlPath: join(here, '..', 'ledger.html'), push: false, pushTick: false, offsiteTimer: false, fetchImpl: hlFetch,
    archiveEnv: { ARCHIVE_AWS_KEY_ID: 'AKIATEST', ARCHIVE_AWS_SECRET: 'sekrit', ARCHIVE_PREFIX: 'node_fills/hourly/', ARCHIVE_INDEX_BUCKET: 'missing-index', ARCHIVE_INDEX_REGION: 'ap-northeast-1' } });
  const b4 = await listen(app4);
  try {
    const c = await call(b4, '/api/v1/archive/check', { wallets: [ADDR] }); ok(/NoSuchBucket/.test(c.body.index.error), 'check names the missing bucket: ' + JSON.stringify(c.body.index)); eq(c.body.wallets[0].seams, 1, 'the hours plan is still computed');
    const x = A.s3Client({ keyId: 'AKIATEST', secret: 'sekrit', bucket: 'other-account-index', region: 'ap-northeast-1', fetchImpl: hlFetch, noPayer: true });
    const err = await x.list('index/v1/d/', '/', 1).then(() => null, e => e.message); ok(/different AWS account.*bucket policy/.test(err), 'cross-account denial names the bucket policy: ' + err);
    const bf = await call(b4, '/api/v1/archive/backfill', { address: ADDR, maxGB: 1 }); eq(bf.status, 202, JSON.stringify(bf.body));
    eq(bf.body.source, 'hours'); ok(/missing-index.*NoSuchBucket/.test(bf.body.indexSkipped), 'the job says why the index was skipped: ' + bf.body.indexSkipped); eq(bf.body.total, 4, 'the seam window’s hours');
    let s; for (let i = 0; i < 100; i++) { s = (await call(b4, '/api/v1/archive')).body; if (s.job.state !== 'running') break; await new Promise(x => setTimeout(x, 30)); }
    eq([s.job.state, s.job.done, s.job.fills, s.job.added], ['done', 4, 1, 1], JSON.stringify(s.job));
  } finally { app4.close(); }
});
await t('the server never keeps a combined fill next to its pieces: PUT, archive merge and the startup pass all clean it', async () => {
  const dir5 = mkdtempSync(join(tmpdir(), 'ledger-archive5-'));
  const { writeFileSync, mkdirSync } = await import('node:fs');
  mkdirSync(join(dir5, 'fills'), { recursive: true });
  const T = T0 + 5 * H, oid = 4242;
  const agg = { coin: 'ETH', px: '1000', sz: '3', side: 'B', time: T, startPosition: '0', dir: 'Open Long', closedPnl: '0', hash: '0xa', oid, crossed: true, fee: '1', tid: 1, feeToken: 'USDC' };
  const p2 = Object.assign({}, agg, { sz: '2', startPosition: '1', tid: 2, hash: '0x' + '0'.repeat(64) }); // the archive's second piece of the same order
  // a stored cache that already holds both: cleaned on the way up
  writeFileSync(join(dir5, 'fills', ADDR + '.json.gz'), zlib.gzipSync(JSON.stringify({ v: 1, last: T, count: 2, savedAt: Date.now(), truncated: false, fills: [agg, p2] })));
  const app5 = createApp({ dataDir: dir5, auth: 'owner', htmlPath: join(here, '..', 'ledger.html'), push: false, pushTick: false, offsiteTimer: false, fetchImpl: hlFetch });
  const b5 = await listen(app5);
  try {
    let full = await call(b5, '/api/v1/cache/' + ADDR); eq(full.body.fills.fills.map(f => f.tid), [1], 'the startup pass removed the piece');
    // PUT the piece again: merged by id it is new, by position it is covered — not kept
    const pr = await fetch(b5 + '/api/v1/cache/' + ADDR, { method: 'PUT', headers: FULL, body: JSON.stringify({ fills: [p2] }) }); const put = { status: pr.status, body: await pr.json() };
    eq([put.status, put.body.added, put.body.count], [200, 0, 1], JSON.stringify(put.body));
    full = await call(b5, '/api/v1/cache/' + ADDR); eq(full.body.fills.fills.length, 1);
  } finally { app5.close(); }
});
await t('the indexer splits an hour into shards as gzip members; its arguments and day arithmetic', async () => {
  const I = (await import('../archive-indexer.js')).default || createRequire(import.meta.url)('../archive-indexer.js');
  const r = await I.splitHour({ get: async () => Buffer.from(LINKED, 'base64') }, 'node_fills_by_block/hourly/20260615/12.lz4');
  eq([r.lines, r.fills, Object.keys(r.members).sort()], [12, 24, ['111', 'c84']]);
  const lines = zlib.gunzipSync(Buffer.concat([r.members['c84'], r.members['c84']])).toString().trim().split('\n'); eq(lines.length, 24, 'members concatenate into one gzip stream');
  eq(JSON.parse(lines[0])[0], ADDR);
  eq(I.SHARD('0xC846E513F1FB448E744D5C8E911E87BCCC0DFB20'), 'c84'); eq([I.sourcePrefix('20250726'), I.sourcePrefix('20250727')], ['node_fills/hourly/20250726/', 'node_fills_by_block/hourly/20250727/']);
  // the older dataset's shapes: [time, [address, fill]] lines, {user, fill} objects, fills carrying their user — all land as [address, fill]
  const fill = { coin: 'ETH', px: '1', sz: '2', side: 'B', time: T0, tid: 5, oid: 6 };
  const oldText = [JSON.stringify(['2025-05-25T10:00:00.1', [ADDR, fill]]), JSON.stringify({ user: ADDR, fill }), JSON.stringify(Object.assign({ user: '0x' + 'a'.repeat(40) }, fill)), JSON.stringify({ time: '2025-05-25T10:00:01', events: [[ADDR, fill]] })].join('\n') + '\n';
  const r2 = await I.splitHour({ get: async () => Buffer.from(oldText) }, 'node_fills/hourly/20250525/10');
  eq([r2.lines, r2.fills, Object.keys(r2.members).sort(), r2.shapes], [4, 4, ['aaa', 'c84'], { pair: 2, obj: 1, user: 1 }]);
  const c84 = zlib.gunzipSync(r2.members['c84']).toString().trim().split('\n').map(l => JSON.parse(l)); eq(c84.length, 3); ok(c84.every(x => x[0] === ADDR && x[1].coin === 'ETH' && !('user' in x[1])));
  eq(JSON.parse(zlib.gunzipSync(r2.members['aaa']).toString())[1].tid, 5);
  ok(typeof r2.sample === 'string' && r2.sample.startsWith('["2025-05-25'), 'the first line is kept as a sample');
  // a user field that isn't an address never names a shard (the shard becomes a file name)
  const badText = [JSON.stringify(Object.assign({ user: '0x/../../etc/x' }, fill)), JSON.stringify({ user: '0x..', fill }), JSON.stringify(Object.assign({ user: ADDR }, fill))].join('\n');
  const r4 = await I.splitHour({ get: async () => Buffer.from(badText) }, 'node_fills/hourly/20250525/11');
  eq([r4.fills, Object.keys(r4.members), r4.shapes.badAddress], [1, ['c84'], 2]);
  // sliced: with a tiny slice size the worker hands members over several times; the day's file (members appended in order) still reads as the same lines
  const got = {}; let handed = 0;
  const r3 = await I.splitHour({ get: async () => Buffer.from(LINKED, 'base64') }, 'node_fills_by_block/hourly/20260615/12.lz4', async m => { handed++; for (const sh in m) got[sh] = got[sh] ? Buffer.concat([got[sh], m[sh]]) : m[sh]; }, 600);
  ok(handed >= 3 && r3.slices === handed, 'several slices were handed over: ' + handed + ' / ' + r3.slices); eq(Object.keys(r3.members).length, 0, 'nothing kept when a callback takes the slices');
  const whole = zlib.gunzipSync(r.members['c84']).toString(), sliced = zlib.gunzipSync(got['c84']).toString(); eq(sliced, whole, 'the sliced shard file holds the same lines in the same order');
  // a day marked done with no fills in it is not indexed
  eq([I.isIndexed({ fills: 0, hours: 24 }), I.isIndexed({ fills: 3 }), I.isIndexed(null)], [false, true, false]);
  // a day still uploading is left for the next run, never marked short; a day marked short is redone once the archive has more
  const NOW = Date.UTC(2026, 9, 5, 3, 30), M = { fills: 9, hours: 24 };
  eq([I.dayPlan('20261004', null, 22, NOW), I.dayPlan('20261003', null, 23, NOW), I.dayPlan('20261002', null, 23, NOW), I.dayPlan('20261004', null, 24, NOW), I.dayPlan('20261004', null, 0, NOW)], ['wait', 'wait', 'index', 'index', 'empty']);
  eq([I.dayPlan('20261003', M, 24, NOW), I.dayPlan('20261003', { fills: 9, hours: 22 }, 24, NOW), I.dayPlan('20261003', { fills: 0, hours: 24 }, 24, NOW)], ['done', 'index', 'index']);
  eq(I.parseArgs(['build', '--recheck', '30']).recheck, 30); eq(I.parseArgs(['daily']).recheck, 7);
  const o = I.parseArgs(['build', '--bucket', 'b', '--from', '20250801', '--to', '20250802', '--workers', '2']); eq([o.cmd, o.bucket, o.from, o.to, o.workers, o.prefix], ['build', 'b', '20250801', '20250802', 2, 'index/v1/']);
});
await t('role credentials: the environment’s key wins, and a session token is signed as a header', async () => {
  const creds = A.roleCredentials(null, { AWS_ACCESS_KEY_ID: 'AKIAENV', AWS_SECRET_ACCESS_KEY: 's', AWS_SESSION_TOKEN: 'tok' });
  eq(await creds(), { keyId: 'AKIAENV', secret: 's', token: 'tok' });
  const seen = []; const c = A.s3Client({ bucket: 'b', region: 'us-east-1', credentials: creds, fetchImpl: async (url, init) => { seen.push(init.headers); return new Response('', { status: 200 }); } });
  await c.probe('HEAD', '/x', {}); eq(seen[0]['x-amz-security-token'], 'tok'); ok(/SignedHeaders=[^,]*x-amz-security-token/.test(seen[0].Authorization));
});

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
