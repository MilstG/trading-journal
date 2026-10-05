// Exchange relay for Bybit and Binance — zero dependencies.
//
// Neither exchange answers a browser directly (no CORS), so the app signs each request in the
// browser with the member's read-only API key and posts it here; this relay forwards it and hands
// back the exchange's answer. The API secret never reaches the server: what passes through is the
// key, a timestamp and a signature that expires within seconds.
//
// What the relay will forward is fixed below: GET only, to the exchanges' own hosts, on the
// read-only endpoints the app uses, with only the signing headers. Anything else is refused, so
// it can't be used as a general proxy.
//
// Exchanges refuse some countries by IP (Bybit and Binance both refuse the US). When the
// exchange refuses this server's location the answer says so ({geo:true}), and the server can
// pass requests on to a second copy of itself running somewhere the exchange serves:
//   CEX_RELAY_URL=https://relay.example.com        (both exchanges)
//   CEX_RELAY_URL_BYBIT / CEX_RELAY_URL_BINANCE   (per exchange; wins over CEX_RELAY_URL)
//   CEX_RELAY_SECRET=<long random string>         (the same value on both servers)
// The far copy runs with CEX_RELAY_ONLY=1 and the same CEX_RELAY_SECRET: it then answers
// nothing but /api/health and this relay, and only to callers that present the secret.
'use strict';

const HOSTS = {
  bybit: { api: 'api.bybit.com' },
  binance: { api: 'api.binance.com', fapi: 'fapi.binance.com' },
};
// the read-only endpoints the app calls (venues.js), per exchange and host
const PATHS = {
  bybit: { api: ['/v5/market/time', '/v5/user/query-api', '/v5/execution/list', '/v5/account/transaction-log',
    '/v5/position/list', '/v5/account/wallet-balance', '/v5/market/kline'] },
  binance: {
    api: ['/sapi/v1/account/apiRestrictions'],
    fapi: ['/fapi/v1/time', '/fapi/v1/income', '/fapi/v3/positionRisk', '/fapi/v3/account', '/fapi/v1/ticker/price',
      '/fapi/v1/userTrades', '/fapi/v1/klines'],
  },
};
const HEADERS = {
  bybit: ['x-bapi-api-key', 'x-bapi-timestamp', 'x-bapi-recv-window', 'x-bapi-sign'],
  binance: ['x-mbx-apikey'],
};
const QUERY_RE = /^[A-Za-z0-9=&%._~-]{0,4096}$/;
const HVAL_RE = /^[A-Za-z0-9._+/=-]{1,256}$/;
const MAX_ANSWER = 8 * 1024 * 1024;

// an exchange refusing the caller's country: Binance answers 451; Bybit's CDN a 403 page
function geoRefusal(status, body) {
  const s = String(body || '').slice(0, 2000);
  if (status === 451) return true;
  if (status === 403 && /restricted location|block access from your country|not available in your (country|region)|CloudFront/i.test(s)) return true;
  return false;
}
function geoDetail(body) {
  const s = String(body || '');
  try { const j = JSON.parse(s); if (j && j.msg) return String(j.msg).slice(0, 200); } catch (e) {}
  const m = s.match(/block access from your country|restricted location[^<."]*/i);
  return m ? m[0].slice(0, 200) : 'restricted region';
}

// Checks a relay request body; returns {venue, host, path, query, headers} or {error}.
function checkRequest(b) {
  if (!b || typeof b !== 'object') return { error: 'expected JSON' };
  const venue = b.venue;
  if (!HOSTS[venue]) return { error: 'unknown exchange' };
  const host = b.host;
  if (typeof host !== 'string' || !HOSTS[venue][host]) return { error: 'host not allowed' };
  if (typeof b.path !== 'string' || !PATHS[venue][host].includes(b.path)) return { error: 'endpoint not allowed: ' + String(b.path).slice(0, 60) };
  const query = b.query == null ? '' : b.query;
  if (typeof query !== 'string' || !QUERY_RE.test(query)) return { error: 'bad query' };
  const headers = {};
  const hin = b.headers && typeof b.headers === 'object' ? b.headers : {};
  const keys = Object.keys(hin);
  if (keys.length > 8) return { error: 'too many headers' };
  for (const k of keys) {
    const lk = k.toLowerCase();
    if (!HEADERS[venue].includes(lk)) return { error: 'header not allowed: ' + k.slice(0, 40) };
    const v = hin[k];
    if (typeof v !== 'string' || !HVAL_RE.test(v)) return { error: 'bad header value: ' + k.slice(0, 40) };
    headers[lk] = v;
  }
  return { venue, host, path: b.path, query, headers };
}

function createCexRelay(opts) {
  opts = opts || {};
  const env = opts.env || process.env;
  const fetchImpl = opts.fetchImpl || ((...a) => globalThis.fetch(...a));
  const now = opts.now || (() => Date.now());
  const secret = String(env.CEX_RELAY_SECRET || '');
  const relayOnly = /^(1|true|yes)$/i.test(String(env.CEX_RELAY_ONLY || ''));
  const upstream = v => String(env['CEX_RELAY_URL_' + v.toUpperCase()] || env.CEX_RELAY_URL || '').replace(/\/+$/, '');
  const hostOf = (venue, host) => venue === 'bybit' && host === 'api' && /^[a-z0-9.-]+$/i.test(env.BYBIT_API_HOST || '') ? env.BYBIT_API_HOST : HOSTS[venue][host];
  const perMin = Math.max(10, parseInt(env.CEX_RELAY_PER_MIN, 10) || 1200);
  const counts = new Map(); // caller -> {min, n}

  // a caller's budget: a full first load is a few hundred requests, so the default is generous
  function allow(who) {
    const m = Math.floor(now() / 60000);
    let c = counts.get(who);
    if (!c || c.min !== m) { c = { min: m, n: 0 }; counts.set(who, c); }
    if (counts.size > 5000) for (const [k, v] of counts) if (v.min !== m) counts.delete(k);
    return ++c.n <= perMin;
  }

  async function forward(r) {
    const up = upstream(r.venue);
    if (up) { // chained: the far copy does the asking
      if (!secret) return { status: 0, error: 'CEX_RELAY_URL is set but CEX_RELAY_SECRET is not' };
      // the shared secret rides in a header: never over plain http to another machine
      if (!/^https:\/\//i.test(up) && !/^http:\/\/(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?$/i.test(up)) return { status: 0, error: 'CEX_RELAY_URL must start with https://' };
      let res;
      try {
        res = await fetchImpl(up + '/api/cex/relay', { method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(30000),
          headers: { 'Content-Type': 'application/json', 'X-Relay-Secret': secret },
          body: JSON.stringify({ venue: r.venue, host: r.host, path: r.path, query: r.query, headers: r.headers }) });
      } catch (e) { return { status: 0, error: 'the relay at ' + up + ' didn’t answer (' + (e && e.message || e) + ')' }; }
      let j = null; try { j = await res.json(); } catch (e) {}
      if (!res.ok || !j) return { status: 0, error: 'the relay at ' + up + ' answered HTTP ' + res.status + (j && j.error ? ': ' + j.error : '') };
      return { status: j.status, body: j.body, geo: !!j.geo, detail: j.detail, via: 'relay' };
    }
    const url = 'https://' + hostOf(r.venue, r.host) + r.path + (r.query ? '?' + r.query : '');
    let res;
    try {
      res = await fetchImpl(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(25000),
        headers: Object.assign({ 'Accept': 'application/json', 'User-Agent': 'ledger-relay' }, r.headers) });
    } catch (e) { return { status: 0, error: 'couldn’t reach ' + (r.venue === 'bybit' ? 'Bybit' : 'Binance') + ' (' + (e && e.message || e) + ')' }; }
    let body = '';
    try { body = await res.text(); } catch (e) {}
    if (body.length > MAX_ANSWER) return { status: 0, error: 'the exchange’s answer was too large' };
    if (geoRefusal(res.status, body)) return { status: res.status, body: '', geo: true, detail: geoDetail(body) };
    return { status: res.status, body };
  }

  // POST /api/cex/relay. `who` is the authenticated caller ('owner', 'm:<id>', 'relay'), or null.
  async function handle(body, who) {
    if (!who) return [401, { error: 'unauthorized' }];
    if (!allow(who)) return [429, { error: 'too many exchange requests — wait a minute' }];
    const r = checkRequest(body);
    if (r.error) return [400, { error: r.error }];
    const out = await forward(r);
    if (out.error) return [502, { error: out.error }];
    return [200, out];
  }
  // the far copy: only callers presenting the shared secret
  function relayCaller(req) {
    const s = req.headers['x-relay-secret'];
    if (!secret || typeof s !== 'string') return null;
    // compare bytes, not characters: a header byte over 0x7F is two bytes in UTF-8, and unequal
    // lengths would make timingSafeEqual throw (and take the server down with it)
    const A = Buffer.from(s), B = Buffer.from(secret);
    return A.length === B.length && require('crypto').timingSafeEqual(A, B) ? 'relay' : null;
  }
  return { handle, relayCaller, relayOnly, chained: v => !!upstream(v), secretSet: !!secret };
}

module.exports = { createCexRelay, checkRequest, geoRefusal, PATHS, HOSTS };
