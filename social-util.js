'use strict';
// social-util.js — the small pure helpers the social layer and its modules share (social.js, leagues.js):
// day keys and ISO weeks, clamping and cleaning what a browser sends, the tiers and the competition kinds.
const TIERS = ['Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond'];
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const COMP_TYPES = ['discipline', 'survivor', 'journal', 'return'];
const clampNum = (v, lo, hi) => { if (v !== null && typeof v === 'object') return null; const n = +v; return isFinite(n) ? Math.min(hi, Math.max(lo, n)) : null; };
const cleanText = (s, max) => String(s == null || typeof s === 'object' ? '' : s).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);
const utcDayKey = ms => new Date(ms).toISOString().slice(0, 10);
const addDaysKey = (k, n) => utcDayKey(Date.parse(k + 'T00:00:00Z') + n * 86400000);
// ISO week ('GGGG-Www') of a 'YYYY-MM-DD' key — same math as the client's isoWeekOfKey.
function isoWeekOfKey(k) {
  const d = new Date(k + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7) + 3);
  const ft = new Date(Date.UTC(d.getUTCFullYear(), 0, 4)); ft.setUTCDate(ft.getUTCDate() - ((ft.getUTCDay() + 6) % 7) + 3);
  return d.getUTCFullYear() + '-W' + String(1 + Math.round((d - ft) / (7 * 86400000))).padStart(2, '0');
}
const avg = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;

module.exports = { TIERS, DAY_RE, COMP_TYPES, clampNum, cleanText, utcDayKey, addDaysKey, isoWeekOfKey, avg };
