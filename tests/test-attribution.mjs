// Per-market attribution: the "Where the money came from" panel + /api/v1/breakdown shares.
//
// The whole point of this panel is a denominator that doesn't lie, so that is what gets locked
// down: side shares total exactly 1, the two lists are disjoint by sign (the same contract
// test-edge-map pins for partitionConditions, which used to leak winners into the loser panel),
// the % basis can re-rank a small well-traded market above a big churned one, and the two
// degenerate cases that break a naive implementation — net near zero, net exactly zero — print
// nothing absurd and never divide by zero.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { t, ok, eq, near, report, makeExtractor } from './harness.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '..', 'ledger.html'), 'utf8');
const { grabFn } = makeExtractor(html);

// Consts aren't brace-extractable, so the few this leans on are re-declared, exactly as
// server.js's ENGINE_SHIMS does. dcoin is reduced to its non-spot branch: these fixtures are
// perps, so the spotMaps lookup is never reached. Keep in sync with ledger.html.
const assetContribution = (0, eval)(`(() => {
  let _be = 50;
  const isWin  = n => n > _be;
  const isLoss = n => n < -_be;
  const dcoin  = t => t.symbol || t.coin;
  function retPct(t){ const notional = t.maxSize * t.avgEntry; return notional > 0 ? t.net / notional * 100 : null; }
  ${grabFn('assetContribution')}
  return assetContribution;
})()`);

const mk = (coin, net, sz, px) => ({ coin, net, maxSize: sz, avgEntry: px, closeTime: 0 });
const keys = rs => rs.map(r => r.key);

// BTC: traded big and often, thin per-trade edge. kPEPE: small and rare, fat edge.
// DOGE/WIF: the leaks. ZERO: a market that netted exactly nothing.
const FIX = [
  mk('BTC', 4000, 1, 100000), mk('BTC', -1000, 1, 100000), mk('BTC', 2000, 1, 100000),
  mk('kPEPE', 900, 1000, 2), mk('kPEPE', 700, 1000, 2),
  mk('DOGE', -3000, 10000, 0.4), mk('DOGE', -1500, 10000, 0.4),
  mk('WIF', -400, 500, 2),
  mk('ZERO', 0, 1, 1000),
];

console.log('\nDenominators');
t('side shares total exactly 1 — the whole reason the panel is trustworthy', () => {
  const a = assetContribution(FIX, 'usd', 5);
  near(a.rows.filter(r => r.v > 0).reduce((x, r) => x + r.share, 0), 1, 1e-12);
  near(a.rows.filter(r => r.v < 0).reduce((x, r) => x + r.share, 0), 1, 1e-12);
  near(a.pos, 6600); near(a.neg, 4900); near(a.total, 1700);
});
t('a market that netted exactly zero still counts as traded, but joins neither list', () => {
  const a = assetContribution(FIX, 'usd', 5);
  eq(a.markets, 5);
  eq(a.others, 1);
  ok(!keys(a.best).includes('ZERO') && !keys(a.worst).includes('ZERO'));
});

console.log('\nRanking and partition');
t('$ basis ranks by dollars contributed, worst is most-negative first', () => {
  const a = assetContribution(FIX, 'usd', 5);
  eq(keys(a.best), ['BTC', 'kPEPE']);
  eq(keys(a.worst), ['DOGE', 'WIF']);
  near(a.best[0].share, 5000 / 6600);
  near(a.worst[0].share, 4500 / 4900);
  near(a.bestShare, 1); near(a.worstShare, 1);
});
t('best and worst are disjoint by sign — no market can appear in both', () => {
  const a = assetContribution(FIX, 'usd', 5);
  ok(a.best.every(r => r.v > 0), 'a non-winner leaked into best');
  ok(a.worst.every(r => r.v < 0), 'a non-loser leaked into worst');
  ok(!keys(a.best).some(k => keys(a.worst).includes(k)));
});
t('order is deterministic when contributions tie', () => {
  const tied = [mk('ZZZ', 500, 1, 1000), mk('AAA', 500, 1, 1000), mk('MMM', 500, 1, 1000)];
  eq(keys(assetContribution(tied, 'usd', 5).best), ['AAA', 'MMM', 'ZZZ']);
  eq(keys(assetContribution([...tied].reverse(), 'usd', 5).best), ['AAA', 'MMM', 'ZZZ']);
});

console.log('\nBasis');
t('% basis re-ranks: a small well-traded market outranks a big thin-edge one', () => {
  const u = assetContribution(FIX, 'usd', 5), p = assetContribution(FIX, 'pct', 5);
  eq(u.best[0].key, 'BTC', '$ basis rewards size and frequency');
  eq(p.best[0].key, 'kPEPE', '% basis is size-neutral and must flip the ranking');
  near(p.rows.find(r => r.key === 'kPEPE').v, 80);  // +45% then +35%
  near(p.rows.find(r => r.key === 'BTC').v, 5);     // +4% -1% +2%
  near(p.rows.filter(r => r.v > 0).reduce((x, r) => x + r.share, 0), 1, 1e-12);
});
t('% is summed return points, not averaged — attribution stays additive', () => {
  const p = assetContribution(FIX, 'pct', 5);
  const kp = p.rows.find(r => r.key === 'kPEPE');
  near(kp.sumRet, 80); near(kp.meanRet, 40);
  ok(kp.v === kp.sumRet, 'the ranked quantity must be the additive one');
});
t('an unknown basis string falls back to $ rather than producing a third mode', () => {
  eq(assetContribution(FIX, 'R', 5).basis, 'usd');
  eq(assetContribution(FIX, undefined, 5).basis, 'usd');
});

console.log('\nTruncation');
t('top-k coverage is honest when markets are left out of the lists', () => {
  const many = [];
  for (let i = 0; i < 8; i++) many.push(mk('W' + i, 1000 - i * 100, 1, 1000));
  const a = assetContribution(many, 'usd', 5);
  eq(a.best.length, 5);
  near(a.bestShare, 4000 / 5200);
  ok(a.bestShare < 1, 'coverage must not claim 100% when 3 markets are omitted');
  eq(a.others, 3);
});

console.log('\nDegenerate cases');
t('net near zero: "% of net" is flagged meaningless, not printed as 10000%', () => {
  const a = assetContribution([mk('BTC', 10000, 1, 100000), mk('DOGE', -9900, 1, 100000)], 'usd', 5);
  near(a.total, 100);
  eq(a.netMeaningful, false, 'net is 0.5% of gross — the ratio is noise');
  ok(Math.abs(a.rows[0].shareNet) > 50, 'and this is the absurd figure the flag suppresses');
  near(a.rows[0].share, 1, 1e-12, 'side shares stay perfectly valid');
});
// Regression: the first cut gated only on net-vs-gross at 5%, which let the real fixture through
// at 5.1% and rendered "BTC · 704% of net". Gating on the symptom too is what actually fixes it.
t('a market cannot print a 3-figure "% of net" just because it cleared the gross gate', () => {
  // The exact book that broke the first cut: +$6,600 made, -$7,310 lost, net -$710. That is 5.1%
  // of gross, so the old 5% gate passed it, and BTC rendered as "704% of net".
  const a = assetContribution([...FIX, mk('unit:TSLA', -2410, 5, 200)], 'usd', 5);
  near(a.total, -710); near(a.pos, 6600); near(a.neg, 7310);
  ok(Math.abs(a.total) > 0.05 * (a.pos + a.neg), 'clears the old 5%-of-gross gate');
  near(a.maxNetShare, 5000 / 710); ok(a.maxNetShare > 3, 'one market is 704% of net');
  eq(a.netMeaningful, false, 'so the of-net column must be suppressed anyway');
  near(a.rows.filter(r => r.v < 0).reduce((x, r) => x + r.share, 0), 1, 1e-12,
    'and the side shares are still exact — only the of-net read is unusable');
});
t('a HIP-3 market keeps its dex prefix as a distinct key', () => {
  const a = assetContribution([...FIX, mk('unit:TSLA', -2410, 5, 200)], 'usd', 5);
  ok(keys(a.worst).includes('unit:TSLA'), 'a builder-dex market must not collapse into the bare coin');
  ok(html.includes('esc(dispMarket(r.key))'), 'and must render as "TSLA (unit dex)"');
});
t('"% of net" is shown when it is actually informative', () => {
  const a = assetContribution([mk('BTC', 5000, 1, 100000), mk('DOGE', -800, 1, 100000)], 'usd', 5);
  eq(a.netMeaningful, true);
  ok(a.maxNetShare <= 3);
  near(a.rows[0].shareNet, 5000 / 4200);
});
t('net exactly zero: shareNet is null, no division by zero', () => {
  const a = assetContribution([mk('BTC', 5000, 1, 1000), mk('DOGE', -5000, 1, 1000)], 'usd', 5);
  eq(a.total, 0);
  eq(a.rows[0].shareNet, null);
  eq(a.netMeaningful, false);
  near(a.rows[0].share, 1, 1e-12);
});
t('all-winners and all-losers views never divide by an empty side', () => {
  const w = assetContribution([mk('BTC', 500, 1, 1000), mk('ETH', 300, 1, 1000)], 'usd', 5);
  eq(w.neg, 0); eq(w.worst.length, 0); eq(w.worstShare, 0); near(w.bestShare, 1);
  const l = assetContribution([mk('BTC', -500, 1, 1000), mk('ETH', -300, 1, 1000)], 'usd', 5);
  eq(l.pos, 0); eq(l.best.length, 0); eq(l.bestShare, 0); near(l.worstShare, 1);
});
t('a single market yields no ranking to draw', () => {
  const a = assetContribution([mk('BTC', 500, 1, 1000), mk('BTC', 200, 1, 1000)], 'usd', 5);
  eq(a.markets, 1);
  ok(html.includes('nothing to rank'), 'the panel must say so rather than render a one-row chart');
});
t('trades with no measurable notional are attributed in $, skipped in %', () => {
  const a = assetContribution([mk('BTC', 500, 0, 0), mk('ETH', 300, 1, 1000)], 'usd', 5);
  near(a.pos, 800);
  eq(a.rows.find(r => r.key === 'BTC').meanRet, null, 'no notional means no % to report');
  const p = assetContribution([mk('BTC', 500, 0, 0), mk('ETH', 300, 1, 1000)], 'pct', 5);
  eq(keys(p.best), ['ETH'], 'a %-less market cannot contribute return points');
});
t('break-even scratches count as trades but as neither win nor loss', () => {
  const a = assetContribution([mk('BTC', 10, 1, 1000), mk('BTC', 4000, 1, 1000)], 'usd', 5);
  const r = a.rows[0];
  eq([r.n, r.wins, r.losses], [2, 1, 0], 'the +$10 scratch sits inside the break-even band');
  near(r.winRate, 1);
});

console.log('\nWiring');
t('panel is rendered into the Diagnostic view above the equity section', () => {
  ok(html.includes('${assetAttribSection(closed)}'), 'section never rendered');
  const i = html.indexOf('${assetAttribSection(closed)}');
  ok(i > 0 && i < html.indexOf('<h2>Equity &amp; edge over time</h2>'), 'placed below the equity charts');
  ok(html.includes('function assetAttribHtml(closed,basis)'));
  ok(html.includes('function assetAttribSection(closed)'));
});
t('the basis toggle is wired, persisted, and separate from the miner basis', () => {
  ok(html.includes('wireAssetAttrib(closed);'), 'toggle never wired');
  ok(html.includes('id="attribBasisTog"') && html.includes('id="attribBox"'));
  ok(html.includes('settings.attribBasis'), 'basis must survive a reload');
  ok(!html.includes("settings.anaBasis=btn.dataset.b"), 'must not write the miner basis');
});
t('repainting the panel does not discard miner results', () => {
  const fn = html.slice(html.indexOf('function wireAssetAttrib(closed){'));
  const body = fn.slice(0, fn.indexOf('\n}'));
  ok(body.includes("$('attribBox')"), 'must repaint only its own box');
  ok(!body.includes('_minerCache'), 'must not invalidate the miner cache');
  ok(!body.includes('renderDiagnostic('), 'must not re-render the whole view');
});
t('the denominator ambiguity is explained in the UI, not just in tests', () => {
  ok(html.includes('sum to exactly 100% within the side'), 'primary denominator unexplained');
  ok(html.includes('winners and losers offset'), 'the of-net caveat must be stated on screen');
  ok(html.includes('attribution, not edge quality'), 'the size/frequency confound must be stated');
});
t('recommendations quantify the top leak and the profit concentration', () => {
  ok(html.includes("const A=assetContribution(closed,'usd',5);"), 'recs never consult attribution');
  ok(html.includes('of every dollar you lost this period'));
  ok(html.includes('this is a sizing problem, not a market to drop'),
    'a big-dollar leak with a fine per-trade return is a sizing call — say so');
});

console.log('\nServer parity (/api/v1/breakdown)');
const srv = readFileSync(join(here, '..', 'server.js'), 'utf8');
t('the same two denominators and the same gate exist server-side', () => {
  ok(srv.includes("r.share = d > 0 ? Math.abs(r.v) / d : 0;"));
  ok(srv.includes("r.shareNet = total !== 0 ? r.v / Math.abs(total) : null;"));
  ok(srv.includes('Math.abs(total) >= 0.1 * (pos + neg) && maxNetShare <= 3'),
    'client and server must agree on when shareNet is meaningful');
});
t('basis and top are parsed and clamped', () => {
  ok(srv.includes("String(query.basis || 'usd').toLowerCase() === 'pct' ? 'pct' : 'usd'"));
  ok(srv.includes('Math.max(1, Math.min(50, Math.floor(qnum(query.top, 5))))'), 'top must be bounded');
});
t('by=tag is flagged as a non-partition, since a two-tag trade is double-counted', () => {
  ok(srv.includes("partition: by !== 'tag'"));
});
t('default $ ordering is preserved so existing consumers do not shift', () => {
  ok(srv.includes("groups: basis === 'pct' ? ranked : out"));
});

report('attribution');
