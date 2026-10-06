'use strict';
// rollouts.js — staged rollouts: a Daruma feature switched on for a random share of members, so what it does can be
// measured against the members who didn't get it, instead of against the members who chose it.
//
// The owner picks a feature (one of FEATURES: Daruma's own features, each a card or a screen the app can leave out),
// the share of members who get it, and how many weeks the test runs. Each member's group is fixed by a hash of their
// id and the rollout's (inGroup): the same member is always in the same group, a new member is assigned when they
// join, and nobody can move themselves. The app hides the feature from the members who don't get it.
//
// What it did (effect): each member's Discipline over the test, minus their own over as many days before it, the
// members who got it against those who didn't (intention to treat: everyone counts in the group they were dealt,
// whether they used it or not), with a 95% interval by resampling members. Verified days from fills where a member
// has them, else the days their app reports, said which. Pure functions; social.js keeps the rollouts.

const crypto = require('crypto');
const Research = require('./research.js');
const DAY = 86400000;
// what can be rolled out: the feature ids the app registers with pzFeature (app/features/*.js)
const FEATURES = { priced: 'Your costliest slip (Today card)', luck: 'Your week, measured (Today card)', rules: 'Your rules, replayed (Today card)',
  drills: 'Replay drills', eval: 'Evaluation', finding: 'Finding of the week', firstlook: 'Your first look', offday: 'Days off the screen',
  recap: 'Monthly recap', age: 'Trader Age', playbooks: 'Playbooks', invite: 'Invite' };
const keyOf = ms => new Date(ms).toISOString().slice(0, 10);
const addDays = (k, n) => keyOf(Date.parse(k + 'T00:00:00Z') + n * DAY);

// the owner's new rollout -> {feature, share (5–95%), weeks (1–12)} or {error}
function sanitizeRollout(b) {
  if (!b || typeof b !== 'object') return { error: 'expected {feature, share, weeks}' };
  if (!Object.prototype.hasOwnProperty.call(FEATURES, b.feature)) return { error: 'Pick a feature that can be rolled out.' };
  const share = Math.round(+b.share), weeks = Math.round(+b.weeks);
  if (!(share >= 5 && share <= 95)) return { error: 'The share who get it must be from 5% to 95% (not ' + b.share + ').' };
  if (!(weeks >= 1 && weeks <= 12)) return { error: 'A test runs from 1 to 12 weeks (not ' + b.weeks + ').' };
  return { feature: b.feature, share, weeks };
}
// is this member in the group that gets it? A hash of both ids, so it never changes and nobody chooses
function inGroup(memberId, r) {
  const h = crypto.createHash('sha256').update(String(r.id) + '|' + String(memberId)).digest();
  return h.readUInt32BE(0) / 4294967296 < r.share / 100;
}
const live = (r, today) => r && !r.endedAt && today >= r.start && today <= r.end;
// what a member's app is told: {feature: true | false} for the rollouts running now (true: they get it)
function forMember(rollouts, memberId, today) {
  const out = {}; for (const r of Object.values(rollouts || {})) if (live(r, today)) out[r.feature] = inGroup(memberId, r); return out;
}
// members: [{id, at (joined, ms), vdays: [{k, s}], days: [{k, s}]}] -> the test's groups and what it did
function effect(r, members, o) {
  o = Object.assign({ now: Date.now(), minDays: 3, iters: 1000 }, o || {});
  const to = r.endedAt ? keyOf(Math.min(r.endedAt, Date.parse(r.end + 'T23:59:59Z'))) : [keyOf(o.now), r.end].sort()[0];
  const len = Math.max(1, Math.round((Date.parse(to) - Date.parse(r.start)) / DAY) + 1), before = addDays(r.start, -len);
  const groups = { on: { n: 0, measured: 0, verified: 0 }, off: { n: 0, measured: 0, verified: 0 } }, units = [];
  for (const m of members || []) {
    if (!m || (m.at && keyOf(m.at) > to)) continue; // joined after it ended
    const g = inGroup(m.id, r) ? 'on' : 'off', G = groups[g]; G.n++;
    const V = Array.isArray(m.vdays) && m.vdays.length, D = V ? m.vdays : (Array.isArray(m.days) ? m.days : []);
    const avg = (a, b) => { const x = D.filter(d => d && d.k >= a && d.k <= b && isFinite(d.s)); return x.length >= o.minDays ? x.reduce((s, d) => s + d.s, 0) / x.length : null; };
    const pre = avg(before, addDays(r.start, -1)), post = avg(r.start, to); if (pre == null || post == null) continue;
    G.measured++; if (V) G.verified++; units.push({ g, d: post - pre });
  }
  const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null;
  const diff = s => { const a = s.filter(u => u.g === 'on').map(u => u.d), b = s.filter(u => u.g === 'off').map(u => u.d); return a.length && b.length ? mean(a) - mean(b) : null; };
  const b = groups.on.measured >= o.minDays && groups.off.measured >= o.minDays ? Research.boot(units, diff, { iters: o.iters, seed: 97 }) : { v: null, lo: null, hi: null, n: units.length };
  const r1 = v => v == null ? null : Math.round(v * 10) / 10;
  return { window: { from: r.start, to, before }, groups, on: r1(mean(units.filter(u => u.g === 'on').map(u => u.d))), off: r1(mean(units.filter(u => u.g === 'off').map(u => u.d))),
    diff: { v: r1(b.v), lo: r1(b.lo), hi: r1(b.hi) }, sure: b.lo != null && (b.lo > 0 || b.hi < 0) };
}

module.exports = { FEATURES, sanitizeRollout, inGroup, forMember, effect, live };
