// Other venues: Lighter (by wallet address), Bybit and Binance (read-only API keys through the
// server's relay). The app's real venues.js runs in a sandbox against mock exchanges built from
// each API's documented answers (Lighter's from live samples); the Bybit and Binance mocks check
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
  'ltNormTrade', 'ltFundingEstimate', 'cexCoin', 'cexSymbol', 'bybitNormExec', 'binanceNormTrade', 'gzipBytes', 'gunzipStr',
  'packFillCache', 'unpackFillCache', 'validFillCache'].map(grabFn).join('\n');
const SHIMS = `
const sleep=()=>Promise.resolve();
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
function lighterMock(opts = {}) {
  const trades = opts.trades || LT_TRADES;
  return async (url, o) => {
    const u = new URL(url);
    if (u.host === 'api.hyperliquid.xyz') { const b = JSON.parse(o.body); eq(b.type, 'userRole'); return jsonRes({ role: HL_ROLE[b.user] || 'missing' }); }
    ltCalls.push(u.pathname + u.search);
    const q = Object.fromEntries(u.searchParams);
    if (u.pathname === '/api/v1/accountsByL1Address')
      return q.l1_address.toLowerCase() === L1.toLowerCase() ? jsonRes({ code: 200, l1_address: L1, sub_accounts: [{ index: IDX }] }) : jsonRes({ code: 21100, message: 'account not found' }, 400);
    if (u.pathname === '/api/v1/orderBooks')
      return jsonRes({ code: 200, order_books: [{ symbol: 'BTC', market_id: 1, market_type: 'perp' }, { symbol: 'ETH/USDC', market_id: 2048, market_type: 'spot' }] });
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
  eq(r2.nFills, 40050, 'the older 50 arrive on the next load'); eq(r2.truncNote, null, 'and the note goes');
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
await t('no caller, no relay; each caller has a per-minute budget', async () => {
  const relay = Relay.createCexRelay({ env: { CEX_RELAY_PER_MIN: '10' }, fetchImpl: exchangeMock, now: () => NOW });
  eq((await relay.handle({ venue: 'bybit', host: 'api', path: '/v5/market/time' }, null))[0], 401);
  for (let i = 0; i < 10; i++) eq((await relay.handle({ venue: 'bybit', host: 'api', path: '/v5/market/time' }, 'm:1'))[0], 200);
  eq((await relay.handle({ venue: 'bybit', host: 'api', path: '/v5/market/time' }, 'm:1'))[0], 429);
  eq((await relay.handle({ venue: 'bybit', host: 'api', path: '/v5/market/time' }, 'm:2'))[0], 200);
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
