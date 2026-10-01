'use strict';
// Readiness from a wearable: WHOOP and Oura over OAuth (the owner registers an app with each and
// sets its client id and secret), Apple Health through an iPhone Shortcut that posts the day's
// numbers to a personal link. Each person's tokens and days live in DATA_DIR/wearables.json,
// keyed by who asked: the owner (AUTH_TOKEN) or a member (their Pulse key).
// Everything is normalized to one record per day: { score 0–100, hrv ms, rhr bpm, sleepH, src }.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const num = (v, lo, hi) => { const n = +v; return isFinite(n) && n >= lo && n <= hi ? n : null; };
const dayOf = iso => { const d = new Date(iso); return isNaN(d) ? null : d.toISOString().slice(0, 10); };
// the wearer's own calendar day: WHOOP stamps each record with the offset it was taken in
const localDay = (iso, off) => { const t = Date.parse(iso); if (!isFinite(t)) return null;
  const m = /^([+-])(\d{2}):?(\d{2})$/.exec(String(off || '')); const o = m ? (m[1] === '-' ? -1 : 1) * (+m[2] * 60 + +m[3]) : 0;
  return new Date(t + o * 60000).toISOString().slice(0, 10); };
const r1 = v => v == null ? null : Math.round(v * 10) / 10;

const PROVIDERS = {
  whoop: { name: 'WHOOP', env: 'WHOOP', scope: 'offline read:recovery read:sleep',
    auth: 'https://api.prod.whoop.com/oauth/oauth2/auth', token: 'https://api.prod.whoop.com/oauth/oauth2/token', api: 'https://api.prod.whoop.com/developer/v2' },
  oura: { name: 'Oura', env: 'OURA', scope: 'daily heartrate personal',
    auth: 'https://cloud.ouraring.com/oauth/authorize', token: 'https://api.ouraring.com/oauth/token', api: 'https://api.ouraring.com/v2/usercollection' },
};

// WHOOP: recovery records (score, resting HR, HRV) and sleeps (hours asleep), by the day they ended. Pure.
function whoopDays(recovery, sleep) {
  const out = {};
  for (const r of recovery || []) { if (!r || r.score_state !== 'SCORED' || !r.score) continue; const k = localDay(r.created_at, r.timezone_offset); if (!k) continue;
    out[k] = Object.assign(out[k] || {}, { score: num(r.score.recovery_score, 0, 100), rhr: num(r.score.resting_heart_rate, 20, 200), hrv: r1(num(r.score.hrv_rmssd_milli, 1, 400)) }); }
  for (const s of sleep || []) { if (!s || s.nap || !s.score || !s.score.stage_summary) continue; const k = localDay(s.end, s.timezone_offset); if (!k) continue;
    const st = s.score.stage_summary, asleep = (st.total_in_bed_time_milli || 0) - (st.total_awake_time_milli || 0);
    out[k] = Object.assign(out[k] || {}, { sleepH: asleep > 0 ? r1(asleep / 3600000) : null }); }
  return out;
}
// Oura: daily readiness (score), and the night's long sleep (HRV, lowest HR, hours). Pure.
function ouraDays(readiness, sleep) {
  const out = {};
  for (const r of readiness || []) { if (!r || !DAY_RE.test(r.day)) continue; out[r.day] = Object.assign(out[r.day] || {}, { score: num(r.score, 0, 100) }); }
  for (const s of sleep || []) { if (!s || !DAY_RE.test(s.day) || (s.type && s.type !== 'long_sleep')) continue;
    out[s.day] = Object.assign(out[s.day] || {}, { hrv: r1(num(s.average_hrv, 1, 400)), rhr: num(s.lowest_heart_rate, 20, 200), sleepH: s.total_sleep_duration ? r1(s.total_sleep_duration / 3600) : null }); }
  return out;
}
// Apple Health has no readiness score: this one is HRV against your own 30-day median (60%) and
// hours asleep against eight (40%). With fewer than five earlier HRV readings, HRV counts as average. Pure.
function appleScore(day, history) {
  const prior = (history || []).filter(d => d && d.hrv > 0).map(d => d.hrv).sort((a, b) => a - b);
  const med = prior.length >= 5 ? prior[Math.floor(prior.length / 2)] : null;
  const hrvS = day.hrv > 0 && med ? Math.max(0, Math.min(100, 50 + 100 * (day.hrv / med - 1))) : day.hrv > 0 ? 50 : null;
  const sleepS = day.sleepH > 0 ? Math.max(0, Math.min(100, day.sleepH / 8 * 100)) : null;
  if (hrvS == null && sleepS == null) return null;
  if (hrvS == null) return Math.round(sleepS); if (sleepS == null) return Math.round(hrvS);
  return Math.round(0.6 * hrvS + 0.4 * sleepS);
}

function createWear(opts) {
  const file = path.join(opts.dataDir, 'wearables.json');
  const json = opts.json, now = opts.now || (() => Date.now());
  const fetchImpl = opts.fetchImpl || ((...a) => globalThis.fetch(...a));
  const env = opts.env || process.env;
  let W; try { W = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { W = null; }
  if (!W || W.v !== 1) W = { v: 1, users: {} };
  const save = () => { const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(W), { mode: 0o600 }); fs.renameSync(tmp, file); };
  const states = new Map(); // OAuth state -> { uid, provider, nonce, exp }, single use, 10 minutes, at most 5 per person
  const syncing = new Map(); // uid -> the sync in flight
  const tzOf = opts.tzOf || (() => 'UTC');
  const zoneDay = (tz, ms) => { try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms); } catch (e) { return dayOf(new Date(ms).toISOString()); } };
  const timed = (url, o) => fetchImpl(url, Object.assign({ signal: AbortSignal.timeout ? AbortSignal.timeout(15000) : undefined }, o));
  const cfg = p => { const P = PROVIDERS[p]; const id = env[P.env + '_CLIENT_ID'], secret = env[P.env + '_CLIENT_SECRET']; return id && secret ? { id, secret } : null; };
  const user = uid => W.users[uid] = W.users[uid] || { days: {} };
  const originOf = req => opts.originOf ? opts.originOf(req) : null;
  const redirectUri = (req, p) => { const o = originOf(req); return o ? o + '/api/wear/' + p + '/callback' : null; };

  const form = o => Object.entries(o).map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');
  const tokenCall = async (p, params) => {
    const r = await timed(PROVIDERS[p].token, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: form(params) });
    const d = await r.json().catch(() => ({}));
    // a refresh token the provider no longer accepts means signing in again, not a network hiccup
    if (!r.ok || !d.access_token) throw Object.assign(new Error((d && (d.error_description || d.error)) || ('HTTP ' + r.status)),
      // only a refresh token the provider says is no longer valid is dropped (a misconfigured client secret isn't the member's fault)
      d && d.error === 'invalid_grant' || r.status === 401 ? { code: 401, dead: params.grant_type === 'refresh_token' && !!d && d.error === 'invalid_grant' } : {});
    return { access: d.access_token, refresh: d.refresh_token || null, exp: now() + (+d.expires_in || 3600) * 1000 - 60000 };
  };
  // Everything below that awaits checks afterwards that the person (and the connection) is still
  // there: a disconnect, or a member leaving, during a sync must not be undone when it finishes.
  const still = (uid, u, p) => W.users[uid] === u && (!p || !!u[p]);
  const accessFor = async (uid, p) => {
    const u = W.users[uid], t = u && u[p]; if (!t) return null;
    if (t.exp > now()) return t.access;
    const c = cfg(p); if (!c || !t.refresh) return null;
    const nt = await tokenCall(p, { grant_type: 'refresh_token', refresh_token: t.refresh, client_id: c.id, client_secret: c.secret, scope: PROVIDERS[p].scope });
    if (!still(uid, u, p) || u[p] !== t) return null;
    u[p] = Object.assign({}, t, nt, { refresh: nt.refresh || t.refresh }); save(); return nt.access;
  };
  const get = async (url, token) => { const r = await timed(url, { headers: { Authorization: 'Bearer ' + token } });
    if (r.status === 401) throw Object.assign(new Error('expired'), { code: 401 });
    if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); };
  // pages through a WHOOP collection (next_token), at most four pages
  const whoopAll = async (pathName, token, from, to) => { let next = null, out = [];
    for (let i = 0; i < 4; i++) { const q = 'start=' + encodeURIComponent(from + 'T00:00:00.000Z') + '&end=' + encodeURIComponent(to + 'T23:59:59.999Z') + '&limit=25' + (next ? '&nextToken=' + encodeURIComponent(next) : '');
      const d = await get(PROVIDERS.whoop.api + pathName + '?' + q, token); out = out.concat(d.records || []); next = d.next_token; if (!next) break; }
    return out; };
  const fetchDays = async (uid, p, from, to) => {
    const tok = await accessFor(uid, p); if (!tok) return null;
    if (p === 'whoop') return whoopDays(await whoopAll('/recovery', tok, from, to), await whoopAll('/activity/sleep', tok, from, to));
    const q = '?start_date=' + from + '&end_date=' + to;
    const rd = await get(PROVIDERS.oura.api + '/daily_readiness' + q, tok), sl = await get(PROVIDERS.oura.api + '/sleep' + q, tok);
    return ouraDays(rd.data, sl.data);
  };
  const merge = (uid, src, days) => { const u = W.users[uid]; if (!u) return;
    for (const [k, d] of Object.entries(days || {})) { if (!DAY_RE.test(k)) continue; u.days[k] = Object.assign({}, d, { src }); }
    const keep = Object.keys(u.days).sort().slice(-120); for (const k of Object.keys(u.days)) if (!keep.includes(k)) delete u.days[k]; };
  const status = uid => { const u = W.users[uid] || { days: {} };
    const prov = {}; for (const p of Object.keys(PROVIDERS)) prov[p] = { name: PROVIDERS[p].name, configured: !!cfg(p), connected: !!u[p],
      err: u[p] && u[p].err || (!u[p] && u.failed && u.failed.p === p && now() - u.failed.at < 3600000 ? (u.failed.why === 'denied' ? 'You didn’t allow access.' : 'Sign-in failed: ' + u.failed.why) : null) };
    prov.apple = { name: 'Apple Health', configured: true, connected: !!u.apple };
    const days = Object.keys(u.days).sort().slice(-60).map(k => Object.assign({ k }, u.days[k]));
    return { providers: prov, days, syncedAt: u.syncedAt || null }; };
  // one sync per person at a time, and a forced one at most every two minutes: the provider's
  // rate limit is shared by everyone on this server (it's the owner's app)
  const sync = (uid, force) => { if (syncing.has(uid)) return syncing.get(uid);
    const u = W.users[uid]; if (!u) return Promise.resolve(status(uid));
    if (u.syncedAt && now() - u.syncedAt < (force ? 2 : 15) * 60000) return Promise.resolve(status(uid));
    const job = syncOnce(uid).finally(() => syncing.delete(uid)); syncing.set(uid, job); return job; };
  const syncOnce = async (uid) => {
    const u = W.users[uid]; if (!u) return status(uid);
    const to = new Date(now() + 86400000).toISOString().slice(0, 10), from = new Date(now() - 30 * 86400000).toISOString().slice(0, 10);
    for (const p of Object.keys(PROVIDERS)) { if (!u[p]) continue; const cid = u[p].cid;
      const same = () => still(uid, u, p) && u[p].cid === cid; // still connected, and to the same sign-in
      try { const d = await fetchDays(uid, p, from, to); if (!same()) continue;
        if (d) { merge(uid, p, d); delete u[p].err; } else if (!(u[p].exp > now()) && !u[p].refresh) u[p].err = 'Sign in to ' + PROVIDERS[p].name + ' again.'; }
      catch (e) { if (!same()) continue; u[p].err = e.code === 401 ? 'Sign in to ' + PROVIDERS[p].name + ' again.' : 'Couldn’t reach ' + PROVIDERS[p].name + ' just now.'; if (e.code === 401) u[p].exp = 0; if (e.dead) u[p].refresh = null; /* stop retrying a refresh that can't work */ } }
    if (!still(uid, u)) return status(uid);
    u.syncedAt = now(); save(); return status(uid); };

  async function handle(req, res, url, query, uidOf) {
    const parts = url.split('/').slice(3), M = req.method; // ['', 'api', 'wear', ...]
    const p = parts[0] || '';
    // the provider sends the browser back here: no Pulse key on a redirect, the state says who it is
    if (PROVIDERS[p] && parts[1] === 'callback' && M === 'GET') {
      const st = states.get(String(query.state || '')); states.delete(String(query.state || ''));
      // the state is only good in the browser that started the sign-in (a cookie set at start):
      // a link someone else started can't attach your account to theirs
      const ck = /(?:^|;\s*)pulse_wear=([a-f0-9]{32})/.exec(String(req.headers.cookie || ''));
      // back to the check-in either way; a failed sign-in is shown there as the provider's error
      const back = (ok, why) => { if (!ok && why && st) { user(st.uid).failed = { p, why: String(why).slice(0, 200), at: now() }; save(); }
        res.writeHead(302, { Location: '/pulse#checkin' }); res.end(); };
      if (!st || st.exp < now() || st.provider !== p || !ck || ck[1] !== st.nonce) return back(false);
      if (!query.code) return back(false, 'denied');
      try { const c = cfg(p); const t = await tokenCall(p, { grant_type: 'authorization_code', code: String(query.code), redirect_uri: st.redirect, client_id: c.id, client_secret: c.secret });
        const u = user(st.uid); t.cid = crypto.randomBytes(6).toString('hex'); /* cid: this connection, so a sync of an older one can't touch it */ u[p] = t; delete u.failed; save(); sync(st.uid, true).catch(() => {}); }
      catch (e) { return back(false, e.message); }
      return back(true);
    }
    // Apple Health: the Shortcut posts with the personal token in the link
    if (p === 'apple' && !parts[1] && M === 'POST' && query.t) {
      const uid = Object.keys(W.users).find(k => W.users[k].apple && W.users[k].apple.h === sha(query.t));
      if (!uid) return json(res, 401, { error: 'That link was replaced or removed. Copy the new one from Pulse.' });
      const body = await readBody(req).catch(() => null); if (!body) return json(res, 400, { error: 'Send JSON: {"date":"2026-10-01","hrv":52,"restingHR":55,"sleepHours":7.2}' });
      const list = Array.isArray(body) ? body.slice(0, 60) : [body], u = user(uid); let n = 0;
      const today = zoneDay(tzOf(uid), now()), oldest = new Date(Date.parse(today) - 60 * 86400000).toISOString().slice(0, 10);
      for (const b of list) { if (!b || typeof b !== 'object' || Array.isArray(b)) continue;
        let k = today; if (b.date != null) { if (!DAY_RE.test(b.date) || isNaN(Date.parse(b.date + 'T00:00:00Z')) || new Date(b.date + 'T00:00:00Z').toISOString().slice(0, 10) !== b.date) continue; k = b.date; }
        if (k < oldest || k > new Date(Date.parse(today) + 86400000).toISOString().slice(0, 10)) continue;
        const d = { hrv: r1(num(b.hrv, 1, 400)), rhr: num(b.restingHR, 20, 200), sleepH: r1(num(b.sleepHours, 0, 24)) };
        if (d.hrv == null && d.sleepH == null && d.rhr == null) continue;
        const hist = Object.keys(u.days).filter(x => x < k && x >= new Date(Date.parse(k) - 30 * 86400000).toISOString().slice(0, 10)).map(x => u.days[x]);
        u.days[k] = Object.assign(d, { score: appleScore(d, hist), src: 'apple' }); n++; }
      const keep = Object.keys(u.days).sort().slice(-120); for (const x of Object.keys(u.days)) if (!keep.includes(x)) delete u.days[x];
      save(); return json(res, 200, { ok: true, days: n });
    }
    const uid = uidOf(req); if (!uid) return json(res, 401, { error: 'Sign in to Pulse first.' });
    if (!p && M === 'GET') return json(res, 200, status(uid));
    if (p === 'sync' && M === 'POST') return json(res, 200, await sync(uid, true));
    if (PROVIDERS[p] && parts[1] === 'start' && M === 'POST') {
      const c = cfg(p); if (!c) return json(res, 404, { error: PROVIDERS[p].name + ' isn’t set up on this server: the owner adds ' + PROVIDERS[p].env + '_CLIENT_ID and ' + PROVIDERS[p].env + '_CLIENT_SECRET.' });
      const redirect = redirectUri(req, p); if (!redirect) return json(res, 400, { error: 'Set PUBLIC_ORIGIN on the server so ' + PROVIDERS[p].name + ' knows where to send you back.' });
      for (const [k, v] of states) if (v.exp < now()) states.delete(k);
      const mine = [...states].filter(([, v]) => v.uid === uid); while (mine.length >= 5) states.delete(mine.shift()[0]);
      if (states.size > 5000) return json(res, 503, { error: 'Too many sign-ins in progress. Try again in a few minutes.' });
      const state = crypto.randomBytes(24).toString('hex'), nonce = crypto.randomBytes(16).toString('hex');
      states.set(state, { uid, provider: p, redirect, nonce, exp: now() + 10 * 60000 });
      res.setHeader('Set-Cookie', 'pulse_wear=' + nonce + '; Path=/api/wear; Max-Age=600; HttpOnly; SameSite=Lax' + (redirect.startsWith('https:') ? '; Secure' : ''));
      return json(res, 200, { url: PROVIDERS[p].auth + '?' + form({ response_type: 'code', client_id: c.id, redirect_uri: redirect, scope: PROVIDERS[p].scope, state }) });
    }
    if ((PROVIDERS[p] || p === 'apple') && !parts[1] && M === 'DELETE') { const u = user(uid); delete u[p];
      for (const k of Object.keys(u.days)) if (u.days[k].src === p) delete u.days[k]; save(); return json(res, 200, status(uid)); }
    if (p === 'apple' && parts[1] === 'token' && M === 'POST') {
      const t = crypto.randomBytes(18).toString('hex'); user(uid).apple = { h: sha(t), at: now() }; save();
      const o = originOf(req); return json(res, 200, { token: t, url: (o || '') + '/api/wear/apple?t=' + t });
    }
    return json(res, 404, { error: 'not found' });
  }
  const readBody = req => new Promise((resolve, reject) => { let size = 0; const ch = [];
    req.on('data', c => { size += c.length; if (size > 64 * 1024) { reject(new Error('too large')); return; } ch.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(ch).toString('utf8') || 'null')); } catch (e) { reject(e); } }); req.on('error', reject); });
  // a member who leaves (or is removed) takes their tokens and days with them
  const forget = uid => { if (W.users[uid]) { delete W.users[uid]; save(); } };
  return { handle, sync, status, forget };
}

module.exports = { createWear, whoopDays, ouraDays, appleScore, PROVIDERS };
