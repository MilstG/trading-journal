// Other venues: Lighter and Arcus (by wallet address), Bybit and Binance (read-only API keys through
// the server's relay). The app's real venues.js runs in a sandbox against mock exchanges built from
// each API's documented answers (Lighter's and Arcus's from live samples); the Bybit and Binance mocks check
// the request signatures, so the signing is tested, not just the parsing. The relay is the real
// cex-relay.js module, and the server route is exercised over HTTP.
import { readFileSync, mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { webcrypto, createHmac } from 'node:crypto';
import vm from 'node:vm';
import { t, ok, eq, near, report, makeExtractor } from './harness.mjs';
import { readAppSource } from '../app-source.js';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const htmlPath = join(here, '..', 'ledger.html');
const html = readAppSource(htmlPath);
const { grabFn } = makeExtractor(html);
const constLine = name => { const m = html.match(new RegExp('^const ' + name + '=.*$', 'm')); if (!m) throw new Error(name + ' not found'); return m[0]; };
const Relay = require('../cex-relay.js');
const server = require('../server.js');

const ENGINE = ['isPerp', 'newTrade', 'tallyFill', 'reconstructTrades', 'attributeFunding', 'deriveFillPositions', 'initialPositions',
  'ltNormTrade', 'ltFundingEstimate', 'ltxNormLog', 'ltDeriveMixed', 'ltBackfillInitial', 'arNormFill', 'cexCoin', 'cexSymbol', 'bybitNormExec', 'binanceNormTrade', 'gzipBytes', 'gunzipStr',
  'packFillCache', 'unpackFillCache', 'validFillCache'].map(grabFn).join('\n');
const SHIMS = `
const _slept=[]; const sleep=ms=>{ _slept.push(ms); return Promise.resolve(); };
const _idb=new Map();
async function idbGet(k){ const v=_idb.get(k); return v===undefined?undefined:v; }
async function idbSet(k,v){ _idb.set(k,v); }
async function idbDel(k){ _idb.delete(k); }
const walletShort=a=>a; const labelFor=w=>w&&(w.label||w.address)||'';
let _fetchHealth={funding:false,ledger:false};
let SRV={enabled:true,token:'owner-token'};
let srvFetch=async()=>{ throw new Error('no server'); };
let settings={wallets:[]}; const S_KEY='s'; const Store={set:async()=>{}};
async function reconstructCompute(fills,frows,addr){ return {perp:attributeFunding(reconstructTrades(fills,addr,'perp'),frows),spot:attributeFunding(reconstructTrades(fills,addr,'spot'),[])}; }
${constLine('arCoin')}
${constLine('CEX_QUOTES')}
${constLine('STABLES')}
${constLine('cacheExtras')}
`;
const venuesSrc = readFileSync(join(here, '..', 'app', 'venues.js'), 'utf8');

// a fresh app sandbox with its own storage; fetch = the Lighter mock, srvFetch = through the relay
function sandbox(lighterFetch) {
  const ctx = vm.createContext({ console, setTimeout, clearTimeout, AbortController, crypto: webcrypto, TextEncoder, TextDecoder, Blob, Response,
    CompressionStream, DecompressionStream, URL, URLSearchParams, AbortSignal, Promise, JSON, Math, Date, Array, Object, Set, Map, String, Number, parseFloat,
    fetch: lighterFetch || (async () => { throw new Error('offline'); }) });
  vm.runInContext(ENGINE + '\n' + SHIMS + '\n' + venuesSrc, ctx);
  return { ctx, run: code => vm.runInContext(code, ctx) };
}
const jsonRes = (obj, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => obj, text: async () => JSON.stringify(obj) });

/* ============================ Lighter ============================ */
const L1 = '0x3f4ec7684F679F83c782e485b358A2D43045d6A2', IDX = 702384, H = 3600e3;
const T0 = Date.parse('2026-09-01T00:00:00Z');
// trades as /api/v1/trades returns them (fields from a live sample), newest first
const ltTrade = (id, ms, side, sz, px, extra) => Object.assign({
  trade_id: id, trade_id_str: String(id), tx_hash: 'h' + id, type: 'trade', market_id: 1, market_kind: 'perps', size: String(sz), price: String(px),
  usd_amount: String(sz * px), ask_id: 900 + id, bid_id: 800 + id, ask_account_id: side === 'A' ? IDX : 1, bid_account_id: side === 'B' ? IDX : 1,
  is_maker_ask: true, timestamp: ms, maker_fee: 20, taker_fee: 200 }, extra);
const LT_TRADES = [ // oldest first here; served newest first
  // open long 1 BTC @100 (taker: bid side, maker is the ask)
  ltTrade(1, T0, 'B', 1, 100, { taker_position_size_before: '0', taker_entry_quote_before: '0', maker_position_size_before: '5', maker_entry_quote_before: '500' }),
  // add 1 @110, same millisecond as the next fill: order must follow trade ids
  ltTrade(2, T0 + 5 * H, 'B', 1, 110, { taker_position_size_before: '1', taker_entry_quote_before: '100', maker_position_size_before: '4', maker_entry_quote_before: '400' }),
  // close 2 @120 as the maker (ask side): Lighter's entry quote gives the exact P&L (120-105)*2 = 30
  ltTrade(3, T0 + 5 * H, 'A', 2, 120, { maker_position_size_before: '2', maker_entry_quote_before: '210', taker_position_size_before: '0', taker_entry_quote_before: '0' }),
  // a spot buy and sell (ETH/USDC, market 2048): position walked from the history
  ltTrade(4, T0 + 6 * H, 'B', 2, 50, { market_id: 2048, market_kind: 'spot' }),
  ltTrade(5, T0 + 7 * H, 'A', 2, 55, { market_id: 2048, market_kind: 'spot', is_maker_ask: false }),
];
let ltCalls = [];
let HL_ROLE = {}; // Hyperliquid's userRole answers, by address (absent = "missing")
// the explorer's record of a trade (explorer.elliot.ai /accounts/{index}/logs, fields from live samples)
const ltxLog = (hash, ms, o) => ({ tx_type: 'InternalClaimOrder', hash, time: new Date(ms).toISOString(), status: 'executed', pubdata_type: o.type || 'Trade',
  pubdata: { trade_pubdata: { trade_type: o.tradeType || 0, market_index: o.market == null ? 1 : o.market, is_taker_ask: o.takerAsk ? 1 : 0, maker_fee: o.makerFee == null ? 20 : o.makerFee,
    taker_fee: o.takerFee == null ? 200 : o.takerFee, taker_account_index: String(o.taker), maker_account_index: String(o.maker), fee_account_index: '0', price: String(o.px), size: String(o.sz) } } });
// the explorer's copy of an API trade: same hash, sides, price, size and fee rates
const ltxOf = tr => ltxLog(tr.tx_hash, tr.timestamp, { market: tr.market_id, takerAsk: !tr.is_maker_ask, taker: tr.is_maker_ask ? tr.bid_account_id : tr.ask_account_id,
  maker: tr.is_maker_ask ? tr.ask_account_id : tr.bid_account_id, px: tr.price, sz: tr.size, makerFee: tr.maker_fee, takerFee: tr.taker_fee });
let ltxCalls = [];
function lighterMock(opts = {}) {
  const trades = opts.trades || LT_TRADES;
  return async (url, o) => {
    const u = new URL(url);
    if (u.host === 'api.hyperliquid.xyz') { const b = JSON.parse(o.body); eq(b.type, 'userRole'); return jsonRes({ role: HL_ROLE[b.user] || 'missing' }); }
    if (u.host === 'explorer.elliot.ai') { ltxCalls.push(u.pathname + u.search); // newest first, by offset
      // listed newest first (opts.explorerList: as given, the order the explorer really lists them in)
      const q = Object.fromEntries(u.searchParams), logs = opts.explorerList || (typeof opts.explorer === 'function' ? opts.explorer() : opts.explorer || []).slice().sort((a, b) => Date.parse(b.time) - Date.parse(a.time));
      ok(/LiquidationTrade/.test(q.pub_data_type || ''), 'asks for the trade records only');
      return jsonRes(u.pathname === '/api/accounts/' + IDX + '/logs' ? logs.slice(+q.offset, +q.offset + +q.limit) : []); }
    ltCalls.push(u.pathname + u.search);
    const q = Object.fromEntries(u.searchParams);
    if (u.pathname === '/api/v1/accountsByL1Address')
      return q.l1_address.toLowerCase() === L1.toLowerCase() ? jsonRes({ code: 200, l1_address: L1, sub_accounts: [{ index: IDX }] }) : jsonRes({ code: 21100, message: 'account not found' }, 400);
    if (u.pathname === '/api/v1/orderBooks')
      return jsonRes({ code: 200, order_books: [{ symbol: 'BTC', market_id: 1, market_type: 'perp' }, { symbol: 'SOL', market_id: 3, market_type: 'perp' }, { symbol: 'ETH/USDC', market_id: 2048, market_type: 'spot' }] });
    if (u.pathname === '/api/v1/trades') {
      const desc = trades.slice().sort((a, b) => b.timestamp - a.timestamp || b.trade_id - a.trade_id);
      const start = q.cursor ? +q.cursor : 0, lim = +q.limit;
      const page = desc.slice(start, start + lim);
      return jsonRes({ code: 200, trades: page, next_cursor: start + lim < desc.length ? String(start + lim) : '' });
    }
    if (u.pathname === '/api/v1/fundings') { // hourly; longs pay 0.01 per unit per hour
      const rows = []; for (let s = +q.start_timestamp; s <= +q.end_timestamp; s += 3600) if (s * 1000 >= T0 && s * 1000 <= T0 + 10 * H) rows.push({ timestamp: s, value: '0.01', rate: '0.0001', direction: 'long' });
      return jsonRes({ code: 200, resolution: '1h', fundings: rows });
    }
    if (u.pathname === '/api/v1/account')
      return jsonRes({ code: 200, total: 1, accounts: [{ index: IDX, collateral: '1000', positions: opts.positions || [] }] });
    if (u.pathname === '/api/v1/candles')
      return jsonRes({ code: 200, r: '1h', c: [{ t: T0, o: 100, h: 105, l: 99, c: 104 }, { t: T0 + H, o: 104, h: 112, l: 103, c: 110 }] });
    return jsonRes({ code: 20001, message: 'unknown' }, 400);
  };
}

console.log('\nLighter (wallet address only)');
await t('one address: trades rebuilt with exact P&L, fees in millionths, funding from the hourly rate', async () => {
  ltCalls = [];
  const S = sandbox(lighterMock());
  const r = await S.run(`loadLighterWallet({address:'lighter:${L1}',label:'L'},false)`);
  const perp = r.trades.filter(x => x.market === 'perp'), spot = r.trades.filter(x => x.market === 'spot' && x.spotPos), spotRz = r.trades.filter(x => x.spotRz);
  eq(perp.length, 1); const tr = perp[0];
  eq([tr.coin, tr.dir, tr.isOpen ? 1 : 0, tr.venue], ['BTC', 'Long', 0, 'lighter']);
  near(tr.pnl, 30); near(tr.avgEntry, 105); near(tr.avgExit, 120);
  // taker fees 200/1e6 of 100 and 110; maker 20/1e6 of 240
  near(tr.fees, (100 + 110) * 200 / 1e6 + 240 * 20 / 1e6);
  // funding: long 1 BTC for hours 1-5 → -0.01 × 5 (the 0h row is at the first fill: position still 0)
  near(tr.funding, -0.05);
  ok(tr.id.startsWith('lighter:' + L1 + ':BTC:'), 'id carries the venue address');
  eq(tr.wallet, { address: 'lighter:' + L1, label: 'L' });
  eq(spot.length, 1); eq(spot[0].coin, 'ETH/USDC'); near(spot[0].pnl, 10); eq(spot[0].symbol, 'ETH/USDC'); ok(!spot[0].isOpen, 'bought 2, sold 2: a round trip');
  eq(spotRz.length, 1, 'one day row carries the money'); near(spotRz[0].pnl, 10); eq(spotRz[0].symbol, 'ETH/USDC');
  near(r.accountValue, 1000); eq(r.nFills, 5);
});
await t('a very long history stops at 40k trades and the next load carries on further back', async () => {
  const many = Array.from({ length: 40050 }, (_, i) => ltTrade(i + 1, T0 + i * 1000, i % 2 ? 'A' : 'B', 1, 100, { market_id: 2048, market_kind: 'spot' }));
  const S = sandbox(lighterMock({ trades: many }));
  const r1 = await S.run(`loadLighterWallet({address:'lighter:${L1}'},false)`);
  eq(r1.nFills, 40000); ok(r1.truncNote, 'the gap is noted');
  const r2 = await S.run(`loadLighterWallet({address:'lighter:${L1}'},false)`);
  eq(r2.nFills, 40050, 'the older 50 arrive on the next load'); ok(!/very long history/.test(r2.truncNote || ''), 'and the note goes: ' + r2.truncNote);
});
await t('the next load fetches one page and adds only what is new', async () => {
  ltCalls = [];
  const S = sandbox(lighterMock());
  await S.run(`loadLighterWallet({address:'lighter:${L1}'},false)`);
  const more = LT_TRADES.concat([ltTrade(6, T0 + 9 * H, 'B', 1, 130, { taker_position_size_before: '0', taker_entry_quote_before: '0' })]);
  S.ctx.fetch = lighterMock({ trades: more, positions: [{ market_id: 1, symbol: 'BTC', sign: 1, position: '1', avg_entry_price: '130', position_value: '130', unrealized_pnl: '0', liquidation_price: '50', initial_margin_fraction: '20' }] });
  ltCalls = [];
  const r = await S.run(`loadLighterWallet({address:'lighter:${L1}'},false)`);
  eq(r.added, 1); eq(r.cached, true);
  eq(ltCalls.filter(c => c.startsWith('/api/v1/trades')).length, 1);
  const open = r.trades.find(x => x.isOpen); ok(open && open.coin === 'BTC' && !open.orphan);
  eq(r.positions.map(p => [p.coin, p.szi, p.lev, p.venue]), [['BTC', 1, 5, 'lighter']]);
});
await t('an open trade Lighter no longer holds is marked closed off the record', async () => {
  const S = sandbox(lighterMock({ trades: [ltTrade(1, T0, 'B', 1, 100, { taker_position_size_before: '0', taker_entry_quote_before: '0' })] }));
  const r = await S.run(`loadLighterWallet({address:'lighter:${L1}'},false)`);
  ok(r.trades[0].isOpen && r.trades[0].orphan);
});
await t('opening the app rebuilds the same trades from storage alone, no network', async () => {
  const S = sandbox(lighterMock());
  const live = await S.run(`loadLighterWallet({address:'lighter:${L1}'},false)`);
  S.ctx.fetch = async () => { throw new Error('offline'); };
  const boot = await S.run(`venueBootTrades({address:'lighter:${L1}'})`);
  eq(boot.map(x => [x.id, +x.pnl.toFixed(6), +x.funding.toFixed(6)]).sort(), live.trades.map(x => [x.id, +x.pnl.toFixed(6), +x.funding.toFixed(6)]).sort());
});
await t('pasting an address finds the venues it trades on', async () => {
  HL_ROLE = {};
  const S = sandbox(lighterMock());
  eq(await S.run(`walletIdsFor('${L1}')`), ['lighter:' + L1], 'Hyperliquid has never seen it, Lighter has it');
  HL_ROLE[L1] = 'user';
  eq(await S.run(`walletIdsFor('${L1}')`), [L1, 'lighter:' + L1]);
  const other = '0x' + '12'.repeat(20);
  eq(await S.run(`walletIdsFor('${other}')`), [other], 'nothing anywhere yet: Hyperliquid');
  HL_ROLE[other] = 'user';
  eq(await S.run(`walletIdsFor('${other}')`), [other], 'a Hyperliquid account only');
  eq(await S.run(`walletIdsFor('${other}',['lighter'])`), ['lighter:' + other]);
  HL_ROLE = {};
});
await t('Hyperliquid is never dropped on doubt, and a dead venue never holds the add up', async () => {
  const mock = lighterMock();
  const down = host => async (url, o) => { if (new URL(url).host === host) throw new TypeError('Failed to fetch'); return mock(url, o); };
  // Lighter unreachable: Hyperliquid, as before Lighter existed
  let S = sandbox(down('mainnet.zklighter.elliot.ai'));
  eq(await S.run(`walletIdsFor('${L1}')`), [L1]);
  // Hyperliquid unreachable but Lighter has an account: both (Hyperliquid isn't known to be empty)
  S = sandbox(down('api.hyperliquid.xyz'));
  eq(await S.run(`walletIdsFor('${L1}')`), [L1, 'lighter:' + L1]);
  // a Hyperliquid error page (not JSON): kept
  S = sandbox(async (url, o) => new URL(url).host === 'api.hyperliquid.xyz' ? { ok: false, status: 502, json: async () => { throw new Error('html'); } } : mock(url, o));
  eq(await S.run(`walletIdsFor('${L1}')`), [L1, 'lighter:' + L1]);
  // Lighter hangs: the check gives up after its time limit (aborted), Hyperliquid is added
  S = sandbox(async (url, o) => new URL(url).host === 'api.hyperliquid.xyz' ? mock(url, o)
    : new Promise((_, rej) => o.signal.addEventListener('abort', () => rej(new Error('aborted')))));
  const t0 = Date.now(); eq(await S.run(`walletIdsFor('${L1}')`), [L1]); const ms = Date.now() - t0;
  ok(ms >= 4900 && ms < 6000, 'gave up after ~5 s: ' + ms);
});
await t('Lighter is asked a little over once a second (60 a minute without a key), its explorer once every 1.4 s', async () => {
  const S = sandbox(lighterMock());
  await S.run(`loadLighterWallet({address:'lighter:${L1}'},false)`);
  const slept = S.run('_slept.slice()'); ok(slept.length > 3 && slept.every(ms => ms >= 1050), 'every Lighter call waits its turn: ' + [...new Set(slept)]);
  S.run('_slept.length=0'); await S.run(`ltxGet('/accounts/1/logs?limit=1&offset=0&pub_data_type='+LTX_TYPES)`); ok(S.run('_slept[0]') >= 1334, 'explorer: ' + S.run('_slept[0]'));
});
await t('explorer records → fills: sides from maker/taker, fees in millionths, liquidations only on the taker, deleverages at quote/size', () => {
  const S = sandbox(), sym = `id=>({1:'BTC',3:'SOL',2048:'ETH/USDC'})[id]`;
  const n = log => S.run(`ltxNormLog(${JSON.stringify(log)},${IDX},${sym})`);
  const mk = n(ltxLog('a1', T0, { taker: 9, maker: IDX, takerAsk: true, px: 100, sz: 2 })); // the taker sold to us
  eq([mk.side, mk.crossed, mk.px, mk.sz, mk.fee, mk.time, mk.tid, mk.hash, mk.src, mk.acct, mk.coin], ['B', false, '100', '2', '0.004', T0, 'a1', 'a1', 'x', IDX, 'BTC']);
  const tk = n(ltxLog('a2', T0, { taker: IDX, maker: 9, takerAsk: true, px: 100, sz: 2, market: 2048 }));
  eq([tk.side, tk.crossed, tk.fee, tk.coin], ['A', true, '0.04', 'ETH/USDC']);
  const liq = n(ltxLog('a3', T0, { taker: IDX, maker: 9, takerAsk: true, px: 18, sz: 5, tradeType: 1, takerFee: 10000, type: 'LiquidationTrade', market: 3 }));
  eq([liq.liquidation, liq.fee], [{ method: 'liquidation' }, '0.9']);
  eq(n(ltxLog('a4', T0, { taker: 9, maker: IDX, takerAsk: true, px: 18, sz: 5, tradeType: 1, type: 'LiquidationTrade' })).liquidation, undefined, 'the maker took the other side, it wasn’t liquidated');
  const del = n({ hash: 'a5', time: new Date(T0).toISOString(), pubdata_type: 'DeleverageWithFunding', pubdata: { deleverage_pubdata_with_funding: { bankrupt_account_index: String(IDX), deleverager_account_index: '281474976710654', market_index: 1, size: '0.9', quote: '100958557736', is_taker_ask: 1, funding_rate_prefix_sum: 1 } } });
  eq([del.side, del.fee, del.liquidation.method], ['A', '0', 'deleverage']); near(+del.px, 100958.557736 / 0.9, 1e-6);
  eq(n(ltxLog('a6', T0, { taker: 8, maker: 9, px: 1, sz: 1 })), null, 'another account’s trade');
  eq(n({ hash: 'a7', time: new Date(T0).toISOString(), pubdata_type: 'L2Transfer', pubdata: { l2_transfer_pubdata: {} } }), null);
});
// older trades only the explorer has, then LT_TRADES (which it has too, same hashes)
const LTX_OLD = [
  ltxLog('x1', T0 - 10 * H, { taker: IDX, maker: 1, takerAsk: false, px: 90, sz: 2 }),           // buy 2 BTC @90 (taker)
  ltxLog('x2', T0 - 8 * H, { taker: 1, maker: IDX, takerAsk: false, px: 100, sz: 2 }),           // sell 2 @100 as the maker: +20, flat
  ltxLog('x3', T0 - 6 * H, { taker: IDX, maker: 1, takerAsk: false, px: 20, sz: 5, market: 3 }), // SOL: buy 5 @20
  ltxLog('x4', T0 - 5 * H, { taker: IDX, maker: 1, takerAsk: true, px: 18, sz: 5, market: 3, tradeType: 1, takerFee: 10000, type: 'LiquidationTrade' }), // liquidated @18: −10
];
const seedScan = (S, st) => S.run(`idbSet('ltx:lighter:${L1}',${JSON.stringify(st || { [IDX]: { scans: [{ off: 0, floor: 0 }] } })})`);
await t('older Lighter history from the explorer: merged behind the load, never twice, P&L walked into the API’s', async () => {
  const S = sandbox(lighterMock({ explorer: LTX_OLD.concat(LT_TRADES.map(ltxOf)) }));
  seedScan(S); // as a first load of a long history leaves it (the API's newest ~3,000 don't reach the start)
  const r1 = await S.run(`loadLighterWallet({address:'lighter:${L1}'},false)`);
  ok(/older history loading in the background/.test(r1.truncNote), r1.truncNote);
  ltxCalls = [];
  const pass = await S.run(`ltBackfillPass({address:'lighter:${L1}'},120)`);
  eq(pass.fills.length, 9, 'four older records and the five the API has'); eq(pass.xs[IDX].scans, [], 'a short page: the explorer’s first record reached');
  const fresh = await S.run(`ltMergeBackfill({address:'lighter:${L1}'},${JSON.stringify(pass.fills)},${JSON.stringify(pass.xs)})`);
  eq(fresh.map(f => f.hash), ['x1', 'x2', 'x3', 'x4'], 'what the API has is skipped (same hashes), the rest goes in oldest first');
  const r = await S.run(`loadLighterWallet({address:'lighter:${L1}'},false)`);
  eq(r.nFills, 9); eq(r.truncNote, null, 'nothing left to read');
  const perp = r.trades.filter(x => x.market === 'perp').sort((a, b) => a.openTime - b.openTime);
  eq(perp.map(x => [x.coin, x.dir, +x.pnl.toFixed(6), x.liquidated ? 1 : 0]), [['BTC', 'Long', 20, 0], ['SOL', 'Long', -10, 1], ['BTC', 'Long', 30, 0]]);
  near(perp[1].fees, 20 * 5 * 200 / 1e6 + 18 * 5 * 0.01, 1e-9, 'the liquidation fee is the taker’s 1%');
  S.ctx.fetch = async () => { throw new Error('offline'); };
  const boot = await S.run(`venueBootTrades({address:'lighter:${L1}'})`);
  eq(boot.map(x => [x.id, +x.pnl.toFixed(6)]).sort(), r.trades.map(x => [x.id, +x.pnl.toFixed(6)]).sort(), 'and the same from storage alone');
});
await t('the explorer’s list order is the order trades executed: its times are noisy and run late, the API’s anchor them', async () => {
  // as on the live explorer: e1 then e2 executed just before the API's first trade (T0), but the explorer
  // stamps them 60-90 s late, and out of order with each other; its copies of the API's trades run late too
  const late = (log, ms) => ({ ...log, time: new Date(ms).toISOString() });
  const list = LT_TRADES.slice().reverse().map(tr => late(ltxOf(tr), tr.timestamp + 90e3))
    .concat([late(ltxLog('e2', 0, { taker: 1, maker: IDX, takerAsk: false, px: 100, sz: 2 }), T0 + 60e3),  // sell 2 @100 (as the maker)
      late(ltxLog('e1', 0, { taker: IDX, maker: 1, takerAsk: false, px: 90, sz: 2 }), T0 + 70e3)]);    // buy 2 @90, listed after (older), stamped later
  const S = sandbox(lighterMock({ explorerList: list }));
  seedScan(S);
  await S.run(`loadLighterWallet({address:'lighter:${L1}'},false)`);
  const pass = await S.run(`ltBackfillPass({address:'lighter:${L1}'},120)`);
  await S.run(`ltMergeBackfill({address:'lighter:${L1}'},${JSON.stringify(pass.fills)},${JSON.stringify(pass.xs)})`);
  const r = await S.run(`loadLighterWallet({address:'lighter:${L1}'},false)`);
  const perp = r.trades.filter(x => x.market === 'perp').sort((a, b) => a.openTime - b.openTime || a.closeTime - b.closeTime);
  eq(perp.map(x => [x.dir, +x.pnl.toFixed(6), x.isOpen ? 1 : 0]), [['Long', 20, 0], ['Long', 30, 0]], 'bought 2 @90, sold @100, flat before the API’s first trade');
  const fills = (await S.run(`venueCache('flc:lighter:${L1}')`)).fills.sort((a, b) => a.time - b.time || (+a.tid || 0) - (+b.tid || 0));
  eq(fills.filter(f => f.coin === 'BTC').map(f => f.tid).slice(0, 3), ['e1', 'e2', '1'], 'in the order they executed');
});
await t('a coin only the explorer has starts from today’s position minus its fills, and an API fill replaces the explorer’s copy', async () => {
  // SOL bought 5 before the explorer's first record and 5 more in it: today Lighter holds 10. The explorer
  // pass also catches a BTC trade made after the load (y2), which the API serves on the next load.
  const old = [ltxLog('y1', T0 - 6 * H, { taker: IDX, maker: 1, takerAsk: false, px: 20, sz: 5, market: 3 }),
    ltxLog('y2', T0 + 9 * H, { taker: IDX, maker: 1, takerAsk: false, px: 130, sz: 1 })];
  const sol = [{ market_id: 3, symbol: 'SOL', sign: 1, position: '10', avg_entry_price: '20', position_value: '200', unrealized_pnl: '0', liquidation_price: '0', initial_margin_fraction: '20' }];
  const S = sandbox(lighterMock({ explorer: old, positions: sol }));
  seedScan(S);
  await S.run(`loadLighterWallet({address:'lighter:${L1}'},false)`);
  const pass = await S.run(`ltBackfillPass({address:'lighter:${L1}'},120)`);
  await S.run(`ltMergeBackfill({address:'lighter:${L1}'},${JSON.stringify(pass.fills)},${JSON.stringify(pass.xs)})`);
  const r = await S.run(`loadLighterWallet({address:'lighter:${L1}'},false)`);
  const solT = r.trades.find(x => x.coin === 'SOL'); ok(solT && solT.isOpen && !solT.orphan, 'one open SOL trade, still held');
  near(+r.trades.find(x => x.coin === 'SOL').avgEntry, 20, 1e-9);
  const sf = (await S.run(`venueBootTrades({address:'lighter:${L1}'})`)).find(x => x.coin === 'SOL'); ok(sf && sf.isOpen, 'offline too');
  // the API now serves y2 itself (same hash): its exact copy takes the explorer's place
  const apiCopy = ltTrade(50, T0 + 9 * H, 'B', 1, 130, { tx_hash: 'y2', taker_position_size_before: '0', taker_entry_quote_before: '0', maker_position_size_before: '0', maker_entry_quote_before: '0' });
  S.ctx.fetch = lighterMock({ trades: LT_TRADES.concat([apiCopy]), explorer: old, positions: sol });
  await S.run(`loadLighterWallet({address:'lighter:${L1}'},false)`);
  const after = (await S.run(`venueCache('flc:lighter:${L1}')`)).fills.filter(f => f.hash === 'y2');
  eq(after.map(f => [f.tid, f.src || 'api', f.startPosition]), [['50', 'api', '0']]);
});
await t('a long explorer history is read a pass at a time; new trades pushing offsets never skip or double one', async () => {
  const older = Array.from({ length: 250 }, (_, i) => ltxLog('z' + i, T0 - (300 - i) * 60e3, { taker: 1, maker: IDX, takerAsk: i % 2 === 0, px: 100, sz: 1 }));
  let newer = [];
  const S = sandbox(lighterMock({ explorer: () => older.concat(newer), trades: [] }));
  seedScan(S);
  await S.run(`loadLighterWallet({address:'lighter:${L1}'},false)`).catch(() => null); // no API trades at all: fine
  let merged = 0;
  for (let k = 0; k < 6; k++) {
    // between passes, 30 newer trades arrive at the top of the explorer's list
    newer = newer.concat(Array.from({ length: 30 }, (_, i) => ltxLog('n' + k + '-' + i, T0 + (k * 30 + i) * 1000, { taker: 1, maker: IDX, takerAsk: true, px: 100, sz: 1 })));
    const pass = await S.run(`ltBackfillPass({address:'lighter:${L1}'},1)`); if (!pass) break;
    merged += (await S.run(`ltMergeBackfill({address:'lighter:${L1}'},${JSON.stringify(pass.fills)},${JSON.stringify(pass.xs)})`)).length;
  }
  const fills = (await S.run(`venueCache('flc:lighter:${L1}')`)).fills;
  const z = fills.filter(f => /^z/.test(f.hash));
  eq(z.length, 250, 'every older record once'); eq(new Set(fills.map(f => f.hash)).size, fills.length, 'none twice');
  eq(await S.run(`ltBackfillPass({address:'lighter:${L1}'},1)`), null, 'and the scan is done');
});
await t('passes meet in the right order where the bound makes times equal', async () => {
  // 150 sells/buys alternating, all stamped later than the API's first trade (T0): every one is held to T0,
  // so only their order tells the position. Read one page a pass: the second pass's records are older.
  const list = LT_TRADES.slice().reverse().map(ltxOf).concat(Array.from({ length: 150 }, (_, i) =>
    ({ ...ltxLog('q' + i, 0, { taker: IDX, maker: 1, takerAsk: i % 2 === 0, px: 100 + (i % 2 ? 0 : 1), sz: 1 }), time: new Date(T0 + 5000).toISOString() })));
  // listed newest first: q0 sells (closing the long q1 opened), q1 buys … q149 buys first, from flat
  const S = sandbox(lighterMock({ explorerList: list }));
  seedScan(S);
  await S.run(`loadLighterWallet({address:'lighter:${L1}'},false)`);
  for (let k = 0; k < 4; k++) { const p = await S.run(`ltBackfillPass({address:'lighter:${L1}'},1)`); if (!p) break;
    await S.run(`ltMergeBackfill({address:'lighter:${L1}'},${JSON.stringify(p.fills)},${JSON.stringify(p.xs)})`); }
  const r = await S.run(`loadLighterWallet({address:'lighter:${L1}'},false)`);
  const old = r.trades.filter(x => x.market === 'perp' && x.avgEntry === 100); // the API's trade opens at 100 and 110 (105)
  eq(old.length, 75, 'buy 1 then sell 1, seventy-five times: 75 round trips'); ok(old.every(x => !x.isOpen && Math.abs(x.pnl - 1) < 1e-9), 'each bought at 100, sold at 101');
});
await t('a full refetch rebuilds the cache from the API, so the explorer is read again from the top', async () => {
  const many = Array.from({ length: 3000 }, (_, i) => ltTrade(i + 1, T0 + i * 1000, i % 2 ? 'A' : 'B', 1, 100, { market_id: 2048, market_kind: 'spot' }));
  const S = sandbox(lighterMock({ trades: many }));
  seedScan(S, { [IDX]: { scans: [] } }); // an earlier backfill finished
  await S.run(`loadLighterWallet({address:'lighter:${L1}'},true)`);
  eq(await S.run(`idbGet('ltx:lighter:${L1}')`), { [IDX]: { scans: [{ off: 0, floor: 0 }] } });
});
await t('a first load the API serves whole needs no explorer; one that fills its ~3,000 starts a scan', async () => {
  let S = sandbox(lighterMock());
  await S.run(`loadLighterWallet({address:'lighter:${L1}'},false)`);
  eq(await S.run(`idbGet('ltx:lighter:${L1}')`), { [IDX]: { scans: [] } });
  const many = Array.from({ length: 3000 }, (_, i) => ltTrade(i + 1, T0 + i * 1000, i % 2 ? 'A' : 'B', 1, 100, { market_id: 2048, market_kind: 'spot' }));
  S = sandbox(lighterMock({ trades: many }));
  await S.run(`loadLighterWallet({address:'lighter:${L1}'},false)`);
  eq(await S.run(`idbGet('ltx:lighter:${L1}')`), { [IDX]: { scans: [{ off: 0, floor: 0 }] } });
});
await t('candles come from Lighter for Lighter trades', async () => {
  const S = sandbox(lighterMock());
  const c = await S.run(`venueFetchCandles('lighter','BTC','1h',${T0},${T0 + 2 * H})`);
  eq(c.rows, [[T0, 105, 99, 104, 100], [T0 + H, 112, 103, 110, 104]]);
  eq(S.run(`candleVenue({venue:'lighter'})+'|'+candleVenue({venue:'hyperliquid'})+'|'+candleVenue({})`), 'lighter||');
});
await t('wallet ids: venue, raw address, readable short form, and cache validation', () => {
  const S = sandbox();
  eq(S.run(`[venueOfAddr('lighter:0xab'),venueOfAddr('0xab'),venueOfAddr('bybit:0123456789ab'),venueRaw('binance:0123456789ab')]`), ['lighter', 'hyperliquid', 'bybit', '0123456789ab']);
  const ok2 = S.run(`[validFillCache('lighter:${L1}',{v:2,fills:[],last:0}),validFillCache('bybit:0123456789ab',{v:2,fills:[],last:0}),validFillCache('bybit:xyz',{v:2,fills:[],last:0}),validFillCache('kraken:${L1}',{v:2,fills:[],last:0})]`);
  eq(ok2, [true, true, false, false]);
});

/* ============================ Arcus ============================ */
const AR = '0x8880c996750f93e4acc7769a203ec9f8ed8e9275', US = 1000; // Arcus times are microseconds
// fills as /v1/fills returns them (fields from a live sample). Arcus's closedPnl is net of the fee.
const arFill = (id, ms, side, sz, px, fee, closedPnl, extra) => Object.assign({
  tradeId: String(id), orderId: 'o' + id, address: AR, accountIndex: 0, marketId: 1, marketDisplayName: 'BTC-USD', side, originalSize: String(sz), size: String(sz),
  price: String(px), fee: String(fee), closedPnl: String(closedPnl), role: fee ? 'TAKER' : 'MAKER', positionEffect: 'OPEN_LONG', createdAt: ms * US + (id % 997) }, extra);
const AR_FILLS = { // per sub-account, oldest first
  0: [
    arFill(1, T0, 'BUY', 1, 100, 0.05, -0.05),                                     // open long 1 @100 (taker)
    arFill(2, T0 + H, 'BUY', 1, 110, 0, 0, { positionEffect: 'ADD_LONG' }),          // add 1 @110 (maker, no fee)
    arFill(3, T0 + 5 * H, 'SELL', 2, 120, 0.12, 29.88, { positionEffect: 'CLOSE_LONG' }), // (120-105)×2 − 0.12
  ],
  1: [
    arFill(11, T0, 'SELL', 1, 50, 0.025, -0.025, { accountIndex: 1, marketId: 2, marketDisplayName: 'NVDA-USD', positionEffect: 'OPEN_SHORT' }),
    // force-closed, recorded before Arcus filled closedPnl in on liquidations ("0"): the fee is the penalty
    arFill(12, T0 + 3 * H, 'BUY', 1, 60, 0.3, 0, { accountIndex: 1, marketId: 2, marketDisplayName: 'NVDA-USD', positionEffect: 'CLOSE_SHORT', liquidation: { method: 'LIQUIDATION', liquidatedUser: 'iIDJlnUPk+Ssx3aa' } }),
  ],
};
const AR_FUND = { 0: [{ marketId: 1, marketDisplayName: 'BTC-USD', fundingRate: '0.0001', size: '2', payment: '-0.5', time: (T0 + 2 * H) * US }], 1: [] };
let arCalls = [];
function arcusMock(opts = {}) {
  const fills = opts.fills || AR_FILLS, fund = opts.fund || AR_FUND, accounts = opts.accounts || { 0: { equity: '1000', positions: {} }, 1: { equity: '250', positions: {} } };
  return async (url) => {
    const u = new URL(url), q = Object.fromEntries(u.searchParams);
    if (u.host === 'api.hyperliquid.xyz') return jsonRes({ role: 'missing' });
    if (u.host !== 'api.arcus.xyz') return jsonRes({ code: 20001, message: 'unknown' }, 400);
    arCalls.push(u.pathname + u.search);
    if (q.address && q.address !== AR) return jsonRes({ error: 'address not on access whitelist' }, 403);
    const idx = +(q.accountIndex || 0);
    if (u.pathname === '/v1/account') return accounts[idx] ? jsonRes({ accountIndex: idx, address: AR, netQuoteBalance: '0', ...accounts[idx] }) : jsonRes({ error: 'this account has no activity yet' }, 404);
    // newest first, from/to inclusive (µs), at most `limit`; from and to must be ≥ 1e14 when sent. As live:
    // a row with no time (0) comes last, and only when no `from` is sent; funding without `from` is 30 days.
    const page = (rows, tOf) => { if (q.from != null) ok(+q.from >= 1e14, 'from is in microseconds'); if (q.to != null) ok(+q.to >= 1e14, 'to is in microseconds: ' + q.to);
      const lim = Math.min(1000, +q.limit || 1000), to = q.to != null ? +q.to : Infinity, from = q.from != null ? +q.from : -Infinity;
      return rows.filter(r => tOf(r) >= from && tOf(r) <= to).sort((a, b) => tOf(b) - tOf(a)).slice(0, lim); };
    if (u.pathname === '/v1/fills') { const f = page(fills[idx] || [], r => r.createdAt); return jsonRes({ fills: f, total: f.length }); }
    if (u.pathname === '/v1/funding') { ok(q.from != null, 'funding is always asked with from'); const f = page(fund[idx] || [], r => r.time); return jsonRes({ fundingPayments: f, total: f.length }); }
    if (u.pathname === '/v1/candles') return jsonRes({ candles: [ // newest first, as the live API answers
      { marketDisplayName: 'BTC-USD', timeframe: '1h', openTime: (T0 + H) * US, open: '104', high: '112', low: '103', close: '110' },
      { marketDisplayName: 'BTC-USD', timeframe: '1h', openTime: T0 * US, open: '100', high: '105', low: '99', close: '104' }] });
    return jsonRes({ error: 'Not found' }, 404);
  };
}

console.log('\nArcus (wallet address only)');
await t('one address: each sub-account its own stream, P&L gross of fees, funding as Arcus booked it', async () => {
  arCalls = [];
  const S = sandbox(arcusMock());
  const r = await S.run(`loadArcusWallet({address:'arcus:${AR}',label:'A'},false)`);
  eq(r.trades.length, 2);
  const btc = r.trades.find(x => x.coin === 'BTC'), nvda = r.trades.find(x => x.coin === 'NVDA');
  eq([btc.dir, btc.isOpen ? 1 : 0, btc.venue, btc.market], ['Long', 0, 'arcus', 'perp']);
  near(btc.pnl, 30, 1e-9, 'the fee is added back: closedPnl here is gross, as Hyperliquid’s'); near(btc.fees, 0.17); near(btc.avgEntry, 105);
  near(btc.funding, -0.5);
  ok(btc.id.startsWith('arcus:' + AR + ':BTC:'), 'the main account keeps the plain wallet id (a second sub-account never renames its trades): ' + btc.id);
  ok(nvda.id.startsWith('arcus:' + AR + '#1:NVDA:'), 'another sub-account is its own stream: ' + nvda.id);
  eq([nvda.dir, nvda.liquidated ? 1 : 0], ['Short', 1]);
  near(nvda.pnl, -10, 1e-9, 'an old liquidation row reading "0": its P&L is walked from the history'); near(nvda.fees, 0.325);
  near(r.accountValue, 1250); eq(r.nFills, 5); eq(r.truncNote, null);
  eq(arCalls.filter(c => c.startsWith('/v1/account')).length, 10, 'every sub-account index is asked once');
});
await t('a liquidation Arcus did price keeps its closedPnl as given (already net of the trading fee)', () => {
  const S = sandbox();
  const f = S.run(`arNormFill(${JSON.stringify(arFill(5, T0, 'SELL', 1, 90, 0.4, -10.2, { liquidation: { method: 'LIQUIDATION', liquidatedUser: 'x' } }))},0)`);
  eq([f.closedPnl, f.fee, f.liquidation, f.crossed, f.side, f.time], ['-10.2', '0.4', { method: 'LIQUIDATION' }, true, 'A', T0]);
  const adl = S.run(`arNormFill(${JSON.stringify(arFill(6, T0, 'SELL', 1, 90, 0, 3, { liquidation: { method: 'ADL', liquidatedUser: 'x' } }))},2)`);
  eq([adl.closedPnl, adl.acct, adl.liquidation.method], ['3', 2, 'ADL']);
  eq(S.run(`[arCoin('BTC-USD'),arCoin('f-usd'),arCoin('SPX')]`), ['BTC', 'F', 'SPX']);
});
await t('pages of 1,000 overlap at their edges: every fill once, newest page first', async () => {
  const many = Array.from({ length: 2500 }, (_, i) => arFill(i + 1, T0 + Math.floor(i / 2) * 1000, i % 2 ? 'SELL' : 'BUY', 1, 100, 0, 0, { createdAt: (T0 + Math.floor(i / 2) * 1000) * US }));
  const S = sandbox(arcusMock({ fills: { 0: many }, accounts: { 0: { equity: '1', positions: {} } } }));
  arCalls = [];
  const r = await S.run(`loadArcusWallet({address:'arcus:${AR}'},false)`);
  eq(r.nFills, 2500, 'two fills share each microsecond, so pages overlap by one: deduplicated');
  eq(arCalls.filter(c => c.startsWith('/v1/fills')).length, 3);
});
await t('a very long history stops at 60 pages and the next load carries on further back', async () => {
  const N = 60050, many = Array.from({ length: N }, (_, i) => arFill(i + 1, T0 + i * 1000, i % 2 ? 'SELL' : 'BUY', 1, 100, 0, 0, { createdAt: (T0 + i * 1000) * US }));
  const S = sandbox(arcusMock({ fills: { 0: many }, accounts: { 0: { equity: '1', positions: {} } } }));
  const r1 = await S.run(`loadArcusWallet({address:'arcus:${AR}'},false)`);
  ok(r1.nFills >= 59000 && r1.nFills < N, 'stopped at the page cap: ' + r1.nFills); ok(r1.truncNote, 'the gap is noted');
  const r2 = await S.run(`loadArcusWallet({address:'arcus:${AR}'},false)`);
  eq(r2.nFills, N, 'the older ones arrive on the next load'); eq(r2.truncNote, null, 'and the note goes');
});
await t('fills with no time (createdAt 0) are read and placed by trade id, never sent as a page bound', async () => {
  // 999 timed fills and one untimed: the oldest page is full, with the untimed row last (as Arcus serves it)
  const id = i => i < 499 ? i + 1 : i + 2; // ids 1…499 and 501…1000 timed; 500 untimed
  const many = Array.from({ length: 999 }, (_, i) => arFill(id(i), T0 + i * 1000, i % 2 ? 'SELL' : 'BUY', 1, 100, 0, 0, { createdAt: (T0 + i * 1000) * US }));
  const untimed = arFill(500, 0, 'BUY', 1, 100, 0, 0, { createdAt: 0 });
  const S = sandbox(arcusMock({ fills: { 0: many.concat([untimed]) }, accounts: { 0: { equity: '1', positions: {} } } }));
  arCalls = [];
  const r = await S.run(`loadArcusWallet({address:'arcus:${AR}'},false)`);
  eq(r.nFills, 1000, 'the untimed fill is in');
  const fills = (await S.run(`venueCache('flc:arcus:${AR}')`)).fills, f500 = fills.find(f => f.tid === '500');
  eq(f500.time, T0 + 498 * 1000, 'it takes the time of the fill before it by id');
  ok(arCalls.filter(c => c.startsWith('/v1/fills')).every(c => !/[?&]from=/.test(c)), 'the history read to its start without from: ' + arCalls[10]);
});
await t('a full page is charged its rows too (20 + 1,000/20 = 70), and the bucket waits it out', async () => {
  const many = Array.from({ length: 1000 }, (_, i) => arFill(i + 1, T0 + i * 1000, 'BUY', 1, 100, 0, 0, { createdAt: (T0 + i * 1000) * US }));
  const S = sandbox(arcusMock({ fills: { 0: many } }));
  S.run('_arTok=1200; _arAt=Date.now();');
  await S.run(`arGet('/v1/fills?address=${AR}&accountIndex=0&limit=1000',20,20)`);
  near(S.run('_arTok'), 1130, 2);
  await S.run(`arGet('/v1/account?address=${AR}&accountIndex=0',2,0)`);
  near(S.run('_arTok'), 1128, 2, 'an account read costs its base only');
});
await t('the next load asks only for what is newer, and adds only what is new', async () => {
  const S = sandbox(arcusMock());
  await S.run(`loadArcusWallet({address:'arcus:${AR}'},false)`);
  const more = { 0: AR_FILLS[0].concat([arFill(4, T0 + 9 * H, 'BUY', 1, 130, 0.065, -0.065)]), 1: AR_FILLS[1] };
  S.ctx.fetch = arcusMock({ fills: more, accounts: { 0: { equity: '1000', positions: { 1: { marketId: 1, marketDisplayName: 'BTC-USD', side: 'LONG', size: '1', averageEntryPrice: '130', leverage: '5', positionValueNotional: '130', unrealizedPnl: '0' } } } } });
  arCalls = [];
  const r = await S.run(`loadArcusWallet({address:'arcus:${AR}'},false)`);
  eq(r.added, 1); eq(r.cached, true);
  const fq = arCalls.filter(c => c.startsWith('/v1/fills'));
  ok(fq.length === 2 && fq.every(c => +new URL('http://x' + c).searchParams.get('from') > 1e15), 'one page a sub-account, from the newest fill held: ' + fq.join(' '));
  const open = r.trades.find(x => x.isOpen); ok(open && open.coin === 'BTC' && !open.orphan);
  eq(r.positions.map(p => [p.coin, p.szi, p.lev, p.venue]), [['BTC', 1, 5, 'arcus']]);
  eq(r.trades.filter(x => x.coin === 'NVDA').length, 1, 'sub-account 1 has no activity now (404): its trades are still read from the cache');
});
await t('opening the app rebuilds the same Arcus trades from storage alone, no network', async () => {
  const S = sandbox(arcusMock());
  const live = await S.run(`loadArcusWallet({address:'arcus:${AR}'},false)`);
  S.ctx.fetch = async () => { throw new Error('offline'); };
  const boot = await S.run(`venueBootTrades({address:'arcus:${AR}'})`);
  eq(boot.map(x => [x.id, +x.pnl.toFixed(6), +x.funding.toFixed(6), +x.fees.toFixed(6)]).sort(), live.trades.map(x => [x.id, +x.pnl.toFixed(6), +x.funding.toFixed(6), +x.fees.toFixed(6)]).sort());
});
await t('pasting an address finds it on Arcus; Hyperliquid stays unless it says it has never seen it', async () => {
  const S = sandbox(arcusMock());
  eq(await S.run(`walletIdsFor('${AR}')`), ['arcus:' + AR], 'Hyperliquid has never seen it, Arcus has it');
  const other = '0x' + '12'.repeat(20);
  eq(await S.run(`walletIdsFor('${other}')`), [other], 'not let in on Arcus (403): Hyperliquid, as before');
  eq(await S.run(`walletIdsFor('${other}',['arcus'])`), ['arcus:' + other]);
  S.ctx.fetch = async (url, o) => new URL(url).host === 'api.arcus.xyz' ? { ok: false, status: 502, json: async () => { throw new Error('html'); } } : arcusMock()(url, o);
  eq(await S.run(`walletIdsFor('${AR}')`), [AR], 'Arcus unreachable: Hyperliquid is kept');
});
await t('candles come from Arcus for Arcus trades, oldest first', async () => {
  const S = sandbox(arcusMock());
  const c = await S.run(`venueFetchCandles('arcus','BTC','1h',${T0},${T0 + 2 * H})`);
  eq(c.rows, [[T0, 105, 99, 104, 100], [T0 + H, 112, 103, 110, 104]]);
  eq(S.run(`candleVenue({venue:'arcus'})`), 'arcus');
});
await t('Arcus wallet ids: venue, raw address, and cache validation', () => {
  const S = sandbox();
  eq(S.run(`[venueOfAddr('arcus:0xab'),venueRaw('arcus:0xab'),VENUE_NAMES.arcus]`), ['arcus', '0xab', 'Arcus']);
  eq(S.run(`[validFillCache('arcus:${AR}',{v:2,fills:[],last:0}),validFillCache('arcus:0x12',{v:2,fills:[],last:0})]`), [true, false]);
});

/* ============================ Bybit / Binance through the relay ============================ */
const NOW = Date.parse('2026-09-30T12:00:00Z');
const BY = { key: 'BYBITKEY0123456789', secret: 'BYBITSECRET0123456789abcdef' };
const BN = { key: 'BINANCEKEY0123456789abcdefghij', secret: 'BINANCESECRET0123456789abcdefghij' };
const hmac = (s, m) => createHmac('sha256', s).update(m).digest('hex');
let exCalls = [], bybitReadOnly = 1, binanceRestr = { enableReading: true, enableFutures: false, enableWithdrawals: false };
let bybitPositions = [];
// the exchanges, as the relay reaches them: Bybit V5 and Binance USD-M, with signature checks
async function exchangeMock(url, o) {
  const u = new URL(url), q = Object.fromEntries(u.searchParams), h = o.headers || {};
  exCalls.push(u.host + u.pathname);
  if (u.host === 'api.bybit.com') {
    if (u.pathname === '/v5/market/time') return jsonRes({ retCode: 0, result: {}, time: NOW });
    if (u.pathname === '/v5/market/kline') return jsonRes({ retCode: 0, result: { list: [[String(NOW - H), '100', '105', '99', '104', '1', '1']] } });
    const ts = h['x-bapi-timestamp'], want = hmac(BY.secret, ts + h['x-bapi-api-key'] + h['x-bapi-recv-window'] + u.search.slice(1));
    if (h['x-bapi-api-key'] !== BY.key) return jsonRes({ retCode: 10003, retMsg: 'API key is invalid.' });
    if (h['x-bapi-sign'] !== want) return jsonRes({ retCode: 10004, retMsg: 'error sign!' });
    if (Math.abs(+ts - NOW) > 20000) return jsonRes({ retCode: 10002, retMsg: 'invalid request, please check your server timestamp' });
    if (u.pathname === '/v5/user/query-api') return jsonRes({ retCode: 0, result: { readOnly: bybitReadOnly, expiredAt: '2026-12-29T00:00:00Z' } });
    if (u.pathname === '/v5/execution/list') {
      const a = +q.startTime, b = +q.endTime;
      const ex = q.category === 'linear' ? [
        { symbol: 'BTCUSDT', execType: 'Trade', side: 'Buy', execPrice: '100', execQty: '1', execFee: '0.06', feeCurrency: 'USDT', isMaker: false, execTime: String(NOW - 10 * H), execId: 'e1', orderId: 'o1' },
        { symbol: 'BTCUSDT', execType: 'Funding', side: 'Buy', execPrice: '100', execQty: '1', execFee: '0.01', execTime: String(NOW - 9 * H), execId: 'f1', orderId: '' },
        { symbol: 'BTCUSDT', execType: 'Trade', side: 'Sell', execPrice: '110', execQty: '1', execFee: '0.022', feeCurrency: 'USDT', isMaker: true, execTime: String(NOW - 8 * H), execId: 'e2', orderId: 'o2' },
        { symbol: 'ETHUSDT', execType: 'Trade', side: 'Sell', execPrice: '50', execQty: '1', execFee: '0.03', feeCurrency: 'USDT', isMaker: false, execTime: String(NOW - 7 * H), execId: 'e3', orderId: 'o3' },
      ] : [];
      const inWin = ex.filter(e => +e.execTime >= a && +e.execTime <= b);
      return jsonRes({ retCode: 0, result: { list: inWin.slice().reverse(), nextPageCursor: '' } });
    }
    if (u.pathname === '/v5/account/transaction-log') {
      const rows = [{ id: 'x1', symbol: 'BTCUSDT', type: 'SETTLEMENT', funding: '-0.5', transactionTime: String(NOW - 9 * H) }].filter(r => +r.transactionTime >= +q.startTime && +r.transactionTime <= +q.endTime);
      return jsonRes({ retCode: 0, result: { list: rows, nextPageCursor: '' } });
    }
    if (u.pathname === '/v5/position/list') return jsonRes({ retCode: 0, result: { list: q.settleCoin === 'USDT' ? bybitPositions : [], nextPageCursor: '' } });
    if (u.pathname === '/v5/account/wallet-balance') return jsonRes({ retCode: 0, result: { list: [{ totalEquity: '1234.5' }] } });
  }
  if (u.host === 'fapi.binance.com' || u.host === 'api.binance.com') {
    if (u.pathname === '/fapi/v1/time') return jsonRes({ serverTime: NOW });
    if (u.pathname === '/fapi/v1/ticker/price') return jsonRes({ symbol: 'BNBUSDT', price: '600' });
    const qs = u.search.slice(1), i = qs.lastIndexOf('&signature=');
    if (h['x-mbx-apikey'] !== BN.key) return jsonRes({ code: -2014, msg: 'API-key format invalid.' }, 401);
    if (i < 0 || qs.slice(i + 11) !== hmac(BN.secret, qs.slice(0, i))) return jsonRes({ code: -1022, msg: 'Signature for this request is not valid.' }, 400);
    if (u.pathname === '/sapi/v1/account/apiRestrictions') return jsonRes(binanceRestr);
    if (u.pathname === '/fapi/v1/income') {
      const rows = [
        { symbol: 'BTCUSDT', incomeType: 'COMMISSION', income: '-0.04', time: NOW - 10 * H, tranId: 1 },
        { symbol: 'BTCUSDT', incomeType: 'FUNDING_FEE', income: '-0.25', time: NOW - 9 * H, tranId: 2 },
      ].filter(r => r.time >= +q.startTime && r.time <= +q.endTime);
      return jsonRes(rows);
    }
    if (u.pathname === '/fapi/v3/positionRisk') return jsonRes([]);
    if (u.pathname === '/fapi/v3/account') return jsonRes({ totalMarginBalance: '777.7' });
    if (u.pathname === '/fapi/v1/userTrades') {
      eq(q.symbol, 'BTCUSDT');
      const rows = [
        { symbol: 'BTCUSDT', id: 11, orderId: 1, side: 'BUY', price: '100', qty: '2', realizedPnl: '0', commission: '0.04', commissionAsset: 'USDT', time: NOW - 10 * H, maker: false, positionSide: 'BOTH' },
        { symbol: 'BTCUSDT', id: 12, orderId: 2, side: 'SELL', price: '105', qty: '2', realizedPnl: '10', commission: '0.0001', commissionAsset: 'BNB', time: NOW - 8 * H, maker: true, positionSide: 'BOTH' },
      ].filter(r => r.time >= +q.startTime && r.time <= +q.endTime);
      return jsonRes(rows);
    }
  }
  return jsonRes({ error: 'unexpected ' + url }, 404);
}
// srvFetch → the real relay module (as the server route calls it) → the exchange mock
function viaRelay(S, env = {}, fetchImpl = exchangeMock) {
  const relay = Relay.createCexRelay({ env, fetchImpl, now: () => NOW });
  S.ctx.__relayFetch = async (p, o) => {
    eq(p, '/api/cex/relay');
    const [code, out] = await relay.handle(JSON.parse(o.body), 'owner');
    return jsonRes(out, code);
  };
  S.ctx.Date = class extends Date { static now() { return NOW + 3000; } }; // this device's clock runs 3 s fast
  S.run('srvFetch=__relayFetch');
  return relay;
}

console.log('\nBybit (read-only API key)');
await t('connecting checks the key is read-only and keeps it on this device', async () => {
  const S = sandbox(); viaRelay(S);
  bybitReadOnly = 0;
  let err = null; try { await S.run(`cexConnect('bybit','${BY.key}','${BY.secret}','')`); } catch (e) { err = e.message; }
  ok(/can trade or move funds/.test(err), err);
  eq(S.run('settings.wallets.length'), 0);
  bybitReadOnly = 1;
  const r = await S.run(`cexConnect('bybit','${BY.key}','${BY.secret}','Main')`);
  ok(/^bybit:[0-9a-f]{12}$/.test(r.address)); ok(r.added); ok(/2026-12-29/.test(r.note));
  eq(S.run('settings.wallets'), [{ address: r.address, label: 'Main' }]);
  eq(S.run(`_idb.get('cexcred:${r.address}').apiSecret`), BY.secret);
  err = null; try { await S.run(`cexConnect('bybit','${BY.key}','WRONGSECRET00000000','')`); } catch (e) { err = e.message; }
  ok(/signature/.test(err), err);
});
await t('trades, fees and funding load in signed 7-day windows; funding executions are not trades', async () => {
  exCalls = []; bybitPositions = [];
  const S = sandbox(); viaRelay(S);
  const { address } = await S.run(`cexConnect('bybit','${BY.key}','${BY.secret}','')`);
  const r = await S.run(`loadBybitWallet({address:'${address}',label:'B'},false)`);
  const btc = r.trades.find(x => x.coin === 'BTC');
  ok(btc && !btc.isOpen); near(btc.pnl, 10); near(btc.fees, 0.082); near(btc.funding, -0.5); eq(btc.venue, 'bybit');
  near(r.accountValue, 1234.5);
  const wins = exCalls.filter(c => c === 'api.bybit.com/v5/execution/list').length;
  ok(wins >= 2 * 104 && wins <= 2 * 106, 'two years of 7-day windows per category: ' + wins);
  // ETH sold with no buy in the history and no position now: it was held from before — a closed long, entry unknown
  const eth = r.trades.find(x => x.coin === 'ETH'); ok(eth && !eth.isOpen && eth.dir === 'Long' && eth.partialHistory);
});
await t('a position older than the history is seeded from today’s position', async () => {
  bybitPositions = [{ symbol: 'ETHUSDT', side: 'Buy', size: '2', avgPrice: '45', unrealisedPnl: '10', liqPrice: '0', leverage: '3', positionValue: '100', positionIdx: 0 }];
  const S = sandbox(); viaRelay(S);
  const { address } = await S.run(`cexConnect('bybit','${BY.key}','${BY.secret}','')`);
  const r = await S.run(`loadBybitWallet({address:'${address}'},false)`);
  const eth = r.trades.find(x => x.coin === 'ETH');
  ok(eth.isOpen && eth.dir === 'Long' && !eth.orphan, 'held 3, sold 1, still long 2');
  eq(r.positions.map(p => [p.coin, p.szi, p.liq, p.venue]), [['ETH', 2, null, 'bybit']]);
  // the cache keeps the seed so opening the app offline agrees
  const boot = await S.run(`venueBootTrades({address:'${address}'})`);
  ok(boot.find(x => x.coin === 'ETH').dir === 'Long');
  bybitPositions = [];
});
await t('a returning load asks only from the last fill on', async () => {
  const S = sandbox(); viaRelay(S);
  const { address } = await S.run(`cexConnect('bybit','${BY.key}','${BY.secret}','')`);
  await S.run(`loadBybitWallet({address:'${address}'},false)`);
  exCalls = [];
  const r = await S.run(`loadBybitWallet({address:'${address}'},false)`);
  eq(r.added, 0); ok(exCalls.filter(c => c.endsWith('/v5/execution/list')).length <= 2, 'one window per category');
});

console.log('\nBinance (read-only API key)');
await t('a key that can trade is refused; a reading key connects', async () => {
  const S = sandbox(); viaRelay(S);
  binanceRestr = { enableReading: true, enableFutures: true };
  let err = null; try { await S.run(`cexConnect('binance','${BN.key}','${BN.secret}','')`); } catch (e) { err = e.message; }
  ok(/enableFutures/.test(err), err);
  binanceRestr = { enableReading: true, enableFutures: false, enableWithdrawals: false };
  const r = await S.run(`cexConnect('binance','${BN.key}','${BN.secret}','')`);
  ok(/^binance:[0-9a-f]{12}$/.test(r.address));
});
await t('symbols come from the income history; P&L is Binance’s own; BNB fees are priced', async () => {
  exCalls = [];
  const S = sandbox(); viaRelay(S);
  const { address } = await S.run(`cexConnect('binance','${BN.key}','${BN.secret}','')`);
  const r = await S.run(`loadBinanceWallet({address:'${address}',label:'N'},false)`);
  const btc = r.trades.find(x => x.coin === 'BTC');
  ok(btc && !btc.isOpen); near(btc.pnl, 10); near(btc.fees, 0.04 + 0.0001 * 600); near(btc.funding, -0.25); eq(btc.venue, 'binance');
  near(r.accountValue, 777.7);
  ok(/last 3 months/.test(r.truncNote), r.truncNote);
  const days = exCalls.filter(c => c.endsWith('/fapi/v1/userTrades')).length;
  ok(days >= 13 && days <= 14, '89 days in 7-day windows for the one symbol: ' + days);
  // the symbol list is kept, so the next load still knows BTCUSDT after its income ages out
  eq(await S.run(`(async()=>(await venueCache('flc:${address}')).syms)()`), ['BTCUSDT']);
});
await t('hedge-mode legs are separate trades and funding goes to the leg that held the position', async () => {
  const S = sandbox();
  const F = (id, side, sz, px, t, leg, pnl) => ({ coin: 'BTC', side, sz: String(sz), px: String(px), time: t, fee: '0', feeToken: 'USDC', tid: String(id), oid: '', closedPnl: String(pnl || 0), leg });
  S.ctx.FILLS = [F(1, 'B', 1, 100, 1000, 'LONG'), F(2, 'A', 3, 100, 2000, 'SHORT'), F(3, 'A', 1, 110, 5000, 'LONG', 10), F(4, 'B', 3, 90, 9000, 'SHORT', 30)];
  const out = await S.run(`(async()=>{ const legs=binanceLegs(FILLS); binanceDerive(legs,{}); const fr=legFunding(legs,[{time:1500,coin:'BTC',usdc:-1},{time:6000,coin:'BTC',usdc:2}]);
    const r=await reconstructStreams([...legs],fr,{address:'binance:0123456789ab'},'binance'); return {fr,tr:r.perp.map(t=>[t.dir,t.pnl,t.funding,t.id.includes('#LONG')||t.id.includes('#SHORT')])}; })()`);
  eq(out.fr.map(r => r.stream), ['LONG', 'SHORT']);
  eq(out.tr.sort(), [['Long', 10, -1, true], ['Short', 30, 2, true]]);
});

console.log('\nTrades that begin before the history');
t('a fill on a position held before the history belongs to the side that was held', () => {
  const S = sandbox();
  const tr = fills => S.run(`reconstructTrades(${JSON.stringify(fills)},'0xw','perp').map(t=>[t.dir,t.isOpen?'open':'closed',+t.closeSz.toFixed(6),+t.openSz.toFixed(6)]).sort()`);
  const F = (side, sz, sp, t = 1000) => ({ coin: 'BTC', side, sz: String(sz), px: '110', time: t, startPosition: String(sp), closedPnl: '0', fee: '0', tid: t, oid: t });
  eq(tr([F('A', 1, 1)]), [['Long', 'closed', 1, 0]], 'closing a long held from before');
  eq(tr([F('B', 1, -1)]), [['Short', 'closed', 1, 0]], 'closing a short held from before');
  eq(tr([F('A', 3, 1)]), [['Long', 'closed', 1, 0], ['Short', 'open', 0, 2]], 'flipping through it');
  eq(tr([F('A', 1, 2)]), [['Long', 'open', 1, 0]], 'reducing it');
  eq(tr([F('B', 1, 2)]), [['Long', 'open', 0, 1]], 'adding to it');
  eq(tr([F('A', 1, 0)]), [['Short', 'open', 0, 1]], 'a fresh short');
  eq(tr([F('B', 1, 0), F('A', 1, 1, 2000)]), [['Long', 'closed', 1, 1]], 'an ordinary round trip');
});

console.log('\nRelay (cex-relay.js)');
t('forwards only the read-only endpoints, hosts and signing headers it knows', () => {
  ok(!Relay.checkRequest({ venue: 'bybit', host: 'api', path: '/v5/execution/list', query: 'a=1', headers: { 'X-BAPI-SIGN': 'ab' } }).error);
  const refuse = [
    { venue: 'bybit', host: 'api', path: '/v5/order/create' },
    { venue: 'binance', host: 'fapi', path: '/fapi/v1/order' },
    { venue: 'binance', host: 'evil.example.com', path: '/fapi/v1/time' },
    { venue: 'kraken', host: 'api', path: '/x' },
    { venue: 'bybit', host: 'api', path: '/v5/market/time', headers: { Cookie: 'x' } },
    { venue: 'bybit', host: 'api', path: '/v5/market/time', headers: { 'X-BAPI-SIGN': 'a\r\nX-Evil: 1' } },
    { venue: 'bybit', host: 'api', path: '/v5/market/time', query: 'a=1#frag' },
    { venue: 'bybit', host: 'api', path: '/v5/market/time/../../v5/order/create' },
  ];
  for (const b of refuse) ok(Relay.checkRequest(b).error, JSON.stringify(b));
});
await t('a refused location is reported as such, not as a broken key', async () => {
  const relay = Relay.createCexRelay({ env: {}, fetchImpl: async () => ({ ok: false, status: 451, text: async () => '{"code":0,"msg":"Service unavailable from a restricted location according to b. Eligibility in https://www.binance.com/en/terms."}' }) });
  const [code, out] = await relay.handle({ venue: 'binance', host: 'fapi', path: '/fapi/v1/time' }, 'owner');
  eq(code, 200); ok(out.geo && /restricted location/.test(out.detail));
  const relay2 = Relay.createCexRelay({ env: {}, fetchImpl: async () => ({ ok: false, status: 403, text: async () => '<HTML><BODY>The Amazon CloudFront distribution is configured to block access from your country.</BODY></HTML>' }) });
  const [, out2] = await relay2.handle({ venue: 'bybit', host: 'api', path: '/v5/market/time' }, 'owner');
  ok(out2.geo);
  // and the app turns it into the hosting advice
  const S = sandbox(); viaRelay(S, {}, async () => ({ ok: false, status: 451, text: async () => '{"msg":"restricted location"}' }));
  let err = null; try { await S.run(`cexConnect('binance','${BN.key}','${BN.secret}','')`); } catch (e) { err = e.message; }
  ok(/refused your server’s location/.test(err) && /README-deploy/.test(err), err);
});
await t('a chained relay never sends its shared secret over plain http to another machine', async () => {
  let sent = 0; const f = async () => { sent++; return { ok: true, status: 200, json: async () => ({ status: 200, body: '{}' }) }; };
  const far = Relay.createCexRelay({ env: { CEX_RELAY_URL: 'http://relay.example.com', CEX_RELAY_SECRET: 's3cret-shared-value' }, fetchImpl: f });
  const [, out] = await far.handle({ venue: 'bybit', host: 'api', path: '/v5/market/time' }, 'owner');
  ok(/must start with https/.test(out.error), JSON.stringify(out)); eq(sent, 0);
  for (const u of ['https://relay.example.com', 'http://127.0.0.1:9000']) {
    const r = Relay.createCexRelay({ env: { CEX_RELAY_URL: u, CEX_RELAY_SECRET: 's3cret-shared-value' }, fetchImpl: f });
    eq((await r.handle({ venue: 'bybit', host: 'api', path: '/v5/market/time' }, 'owner'))[1].via, 'relay', u); }
});
await t('no caller, no relay; each caller has a per-minute budget', async () => {
  const relay = Relay.createCexRelay({ env: { CEX_RELAY_PER_MIN: '10' }, fetchImpl: exchangeMock, now: () => NOW });
  eq((await relay.handle({ venue: 'bybit', host: 'api', path: '/v5/market/time' }, null))[0], 401);
  for (let i = 0; i < 10; i++) eq((await relay.handle({ venue: 'bybit', host: 'api', path: '/v5/market/time' }, 'm:1'))[0], 200);
  eq((await relay.handle({ venue: 'bybit', host: 'api', path: '/v5/market/time' }, 'm:1'))[0], 429);
  eq((await relay.handle({ venue: 'bybit', host: 'api', path: '/v5/market/time' }, 'm:2'))[0], 200);
});
const TIME = { venue: 'bybit', host: 'api', path: '/v5/market/time' };
await t('everyone together has a per-minute ceiling too', async () => {
  let clock = NOW; const relay = Relay.createCexRelay({ env: { CEX_RELAY_PER_MIN: '10', CEX_RELAY_ALL_PER_MIN: '15' }, fetchImpl: exchangeMock, now: () => clock });
  for (let i = 0; i < 10; i++) eq((await relay.handle(TIME, 'm:1'))[0], 200);
  for (let i = 0; i < 5; i++) eq((await relay.handle(TIME, 'm:2'))[0], 200);
  eq((await relay.handle(TIME, 'm:2'))[0], 429, 'm:2 is under its own budget, but the relay’s is spent');
  eq((await relay.handle(TIME, 'm:3'))[0], 429, 'a new caller too');
  clock += 60000; eq((await relay.handle(TIME, 'm:3'))[0], 200, 'the next minute');
});
await t('only so many requests wait on an exchange at once', async () => {
  const gates = []; const f = (u, o) => new Promise((res, rej) => gates.push({ res: () => res(exchangeMock(u, o)), rej }));
  const relay = Relay.createCexRelay({ env: { CEX_RELAY_IN_FLIGHT: '2' }, fetchImpl: f, now: () => NOW });
  const a = relay.handle(TIME, 'm:1'), b = relay.handle(TIME, 'm:2');
  await new Promise(r => setTimeout(r, 0)); eq(gates.length, 2);
  const [code, out] = await relay.handle(TIME, 'm:3'); eq(code, 503); ok(/busy/.test(out.error)); eq(gates.length, 2, 'never sent');
  gates[0].res(); gates[1].rej(new Error('socket hang up'));
  eq((await a)[0], 200); eq((await b)[0], 502, 'a failed one gives its place back too');
  const c = relay.handle(TIME, 'm:3'), d = relay.handle(TIME, 'm:3');
  await new Promise(r => setTimeout(r, 0)); eq(gates.length, 4); gates[2].res(); gates[3].res();
  eq([(await c)[0], (await d)[0]], [200, 200]);
});
await t('an oversized answer is cut off as it streams in, without a Content-Length', async () => {
  let pulled = 0; const endless = () => new Response(new ReadableStream({ pull(c) { pulled++; c.enqueue(new Uint8Array(1 << 20).fill(32)); } }), { status: 200 });
  const relay = Relay.createCexRelay({ env: {}, fetchImpl: async () => endless(), now: () => NOW });
  const [code, out] = await relay.handle(TIME, 'owner');
  eq(code, 502); ok(/too large/.test(out.error), out.error); ok(pulled <= 12, 'stopped near 8 MB, read ' + pulled + ' MB');
  // and from a chained relay, whose answer is the far copy's
  pulled = 0; const chained = Relay.createCexRelay({ env: { CEX_RELAY_URL: 'https://relay.example.com', CEX_RELAY_SECRET: 's3cret-shared-value' }, fetchImpl: async () => endless(), now: () => NOW });
  const [code2, out2] = await chained.handle(TIME, 'owner');
  eq(code2, 502); ok(/too much/.test(out2.error), out2.error); ok(pulled <= 20, 'read ' + pulled + ' MB');
  // a Content-Length past the cap is refused before reading anything
  pulled = 0; const big = Relay.createCexRelay({ env: {}, fetchImpl: async () => { const r = endless(); r.headers.set('content-length', String(9 * 1024 * 1024)); return r; }, now: () => NOW });
  ok(/too large/.test((await big.handle(TIME, 'owner'))[1].error)); ok(pulled <= 1);
  // a normal streamed answer still comes through whole
  const fine = Relay.createCexRelay({ env: {}, fetchImpl: async () => new Response('{"time":' + NOW + ',"x":"é"}', { status: 200 }), now: () => NOW });
  eq(JSON.parse((await fine.handle(TIME, 'owner'))[1].body), { time: NOW, x: 'é' });
});

console.log('\nRelay over HTTP (server.js)');
const listen = app => new Promise(res => app.listen(0, () => res('http://127.0.0.1:' + app.address().port)));
const post = (B, body, headers = {}) => fetch(B + '/api/cex/relay', { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })
  .then(async r => ({ status: r.status, d: await r.json() }));
const hlFetch = async () => ({ ok: true, status: 200, json: async () => [] });
// the far copy, somewhere the exchange serves: relay only, behind the shared secret
let farCalls = 0;
const far = server.createApp({ dataDir: mkdtempSync(join(tmpdir(), 'ledger-far-')), auth: 'far-owner', htmlPath, fetchImpl: hlFetch,
  cexEnv: { CEX_RELAY_ONLY: '1', CEX_RELAY_SECRET: 's3cret-shared-value' }, cexFetch: async (u, o) => { farCalls++; return exchangeMock(u, o); } });
const FAR = await listen(far);
// the main server: in a region the exchange refuses, so it chains to the far copy
const main = server.createApp({ dataDir: mkdtempSync(join(tmpdir(), 'ledger-main-')), auth: 'owner-token', htmlPath, fetchImpl: hlFetch,
  cexEnv: { CEX_RELAY_URL: FAR, CEX_RELAY_SECRET: 's3cret-shared-value' },
  cexFetch: async (u, o) => u.startsWith(FAR) ? fetch(u, o) : { ok: false, status: 403, text: async () => 'block access from your country' } });
const MAIN = await listen(main);
try {
  await t('the owner’s token opens the relay; no token, no relay', async () => {
    eq((await post(MAIN, { venue: 'bybit', host: 'api', path: '/v5/market/time' })).status, 401);
    const r = await post(MAIN, { venue: 'bybit', host: 'api', path: '/v5/market/time' }, { Authorization: 'Bearer owner-token' });
    eq(r.status, 200); eq(JSON.parse(r.d.body).time, NOW); eq(r.d.via, 'relay'); ok(farCalls === 1);
  });
  await t('a relay-only copy answers its health check and the relay — with the secret — and nothing else', async () => {
    eq((await fetch(FAR + '/api/health')).status, 200);
    eq((await fetch(FAR + '/')).status, 404);
    eq((await fetch(FAR + '/api/data', { headers: { Authorization: 'Bearer far-owner' } })).status, 404);
    eq((await post(FAR, { venue: 'bybit', host: 'api', path: '/v5/market/time' }, { Authorization: 'Bearer far-owner' })).status, 401, 'its owner token is not the relay secret');
    eq((await post(FAR, { venue: 'bybit', host: 'api', path: '/v5/market/time' }, { 'X-Relay-Secret': 'wrong-secret-value!' })).status, 401);
    eq((await post(FAR, { venue: 'bybit', host: 'api', path: '/v5/order/create' }, { 'X-Relay-Secret': 's3cret-shared-value' })).status, 400);
  });
  await t('GET is refused and the body is size-limited', async () => {
    eq((await fetch(MAIN + '/api/cex/relay', { headers: { Authorization: 'Bearer owner-token' } })).status, 405);
    eq((await post(MAIN, { venue: 'bybit', host: 'api', path: '/v5/market/time', query: 'a'.repeat(70000) }, { Authorization: 'Bearer owner-token' })).status, 413);
  });
} finally { main.close(); far.close(); }

report('venues');
