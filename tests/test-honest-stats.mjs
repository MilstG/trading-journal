// What the app says about its own numbers has to agree with itself: the coach's challenge row and
// streak win vs Progress, the walk-forward verdict and the Project view vs the Diagnostic's edge test,
// the drawdown % label, the Verified strip, and the break-even band (automatic, strict, the same on
// the server). Functions are extracted from the shipped source, as in every suite.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { t, ok, eq, near, report, makeExtractor } from './harness.mjs';
import { readAppSource } from '../app-source.js'; // ledger.html with its app/*.js inlined, in load order

const here = dirname(fileURLToPath(import.meta.url));
const html = readAppSource(join(here, '..', 'ledger.html'));
const serverSrc = readFileSync(join(here, '..', 'server.js'), 'utf8');
const { grabFn, evalModule } = makeExtractor(html);
const line = (src, start) => { const i = src.indexOf(start); if (i < 0) throw new Error('not found: ' + start); return src.slice(i, src.indexOf('\n', i)); };
const BE_LINES = ['const isWin =', 'const isLoss=', 'const isBE  ='];

// ---- the coach card (renderCoach) with everything around it stubbed ----
function coachCard({ status, res, gw = [], cw = [] }) {
  const el = { innerHTML: '', classList: { add() {}, remove() {} }, querySelectorAll: () => [], querySelector: () => null };
  const ctx = {
    $: id => id === 'coach' ? el : null, allTrades: [{}], coachOn: () => true, console,
    coachContext: () => ({ days: [], closed: [], findings: [] }), lastSessionLine: () => null,
    dayJKey: () => 'd', journal: { d: { plan: 'p' } }, isJournaled: () => true, Date, Promise, Set,
    gameContext: () => ({ current: { ch: { spec: {} }, res, status }, level: { level: 2, title: 'T', into: 1, need: 2 }, streak: { current: 5, shields: 0 } }),
    weekFocus: () => null, habitById: () => null, habitSentence: () => 'When I lose twice, I stop', dotsHtml: () => '<dots>',
    pzXpCfg: () => ({ challenge: 150 }), coachLesson: () => null, gameWins: () => gw, coachWins: () => cw,
    tzParts: () => ({ dow: 1, mo: 8, day: 3 }), DOWN: ['Sun', 'Mon'], MONTHS: Array(12).fill('Sep'),
    ensureWeekChallenge: () => Promise.resolve(false), shieldsHtml: () => '', esc: s => String(s),
  };
  vm.createContext(ctx);
  vm.runInContext(grabFn('renderCoach') + '; renderCoach();', ctx);
  return el.innerHTML;
}

console.log('\nCoach vs Progress');
t('a missed challenge says so on the coach card, as Progress does — no "+150 XP if it holds"', () => {
  const h = coachCard({ status: 'missed', res: [{ kept: false }, { kept: true }] });
  ok(h.includes('missed once') && h.includes('a new challenge comes Monday'), h);
  ok(!h.includes('XP if it holds all week'), 'still promises XP after the miss');
  ok(grabFn('progressSectionHtml').includes('missed once — a new challenge comes Monday'), 'Progress wording moved');
});
t('a challenge on track still shows the XP it pays, from the XP config', () => {
  const h = coachCard({ status: 'on track', res: [{ kept: true }] });
  ok(h.includes('+150 XP if it holds all week') && !h.includes('missed once'), h);
});
t('the streak win names the Discipline streak, and the PB dedupe still matches it', () => {
  const W = '5 trading days in a row at Discipline 70+';
  const h = coachCard({ status: 'on track', res: [], gw: ['New personal best: longest discipline streak (5 days)'], cw: [W, 'Good loss on Mon'] });
  ok(!h.includes(W), 'the same streak said twice');
  ok(h.includes('Good loss on Mon'));
  const h2 = coachCard({ status: 'on track', res: [], cw: [W] });
  ok(h2.includes(W));
  ok(!html.includes('good-process days in a row'), 'the old label survives somewhere');
});
t('coachWins: this week reads gameContext().streak (Discipline); a past week, the process score', () => {
  const ctx = {
    gameContext: () => ({ streak: { current: 6 } }), lastCompletedWeekRange: () => ({ to: 0 }), dayKey: ms => new Date(ms).toISOString().slice(0, 10),
    processTrend: () => ({ streak: 4, avg: null, prevAvg: null }), journalStreak: () => ({ current: 0 }), weekFocus: () => null,
    habitById: () => null, isoWeekKey: () => 'w', journal: {}, dayLabel: k => k, Date, Math,
  };
  vm.createContext(ctx);
  // yesterday's process score is 0 — the Discipline streak can still be 6, and the win must not call it "good process"
  const days = [{ key: '2026-01-01', score: 0, net: 5, parts: {} }];
  const cur = vm.runInContext('(' + grabFn('coachWins') + ')', ctx)({ days, trades: [], closed: [] });
  ok(cur.includes('6 trading days in a row at Discipline 70+'), JSON.stringify(cur));
  const past = vm.runInContext('(' + grabFn('coachWins') + ')', ctx)({ days, trades: [], closed: [] }, { from: Date.UTC(2025, 11, 22), to: Date.UTC(2025, 11, 29) });
  ok(past.includes('4 trading days in a row at process score 70+'), JSON.stringify(past));
});

console.log('\nWalk-forward verdict vs its own CI');
const wfVerdict = (0, eval)('(() => { const fmtUsd = n => (n < 0 ? "-$" : "$") + Math.abs(n).toFixed(2); return ' + grabFn('wfVerdict') + '; })()');
t('a positive walk-forward mean whose 95% CI spans 0 is "not yet distinguishable from noise"', () => {
  const v = wfVerdict({ wfExp: 38, retention: 0.9, wfCI: { lo: -16, hi: 92 } });
  ok(v.includes('not yet distinguishable from noise') && v.includes('-$16.00 to $92.00') && v.includes('includes 0'), v);
  ok(!v.includes('worth trusting') && !v.includes('Edge holds'), v);
  ok(wfVerdict({ wfExp: 38, retention: 0.3, wfCI: { lo: -16, hi: 92 } }).includes('keeps only 30%'));
});
t('only a CI that clears zero earns "the version worth trusting"', () => {
  ok(wfVerdict({ wfExp: 38, retention: 0.9, wfCI: { lo: 4, hi: 70 } }).includes('worth trusting'));
  ok(wfVerdict({ wfExp: 38, retention: 0.4, wfCI: { lo: 4, hi: 70 } }).includes('fraction of its in-sample size'));
  const pend = wfVerdict({ wfExp: 38, retention: 0.9, wfCI: null }, true), few = wfVerdict({ wfExp: 38, retention: 0.9, wfCI: null }, false);
  ok(!pend.includes('worth trusting') && pend.includes('computing'), pend);
  ok(!few.includes('worth trusting') && few.includes('too few'), few);
  ok(wfVerdict({ wfExp: -5, retention: -0.2, wfCI: { lo: -30, hi: 10 } }).includes('edge disappears'));
  eq(wfVerdict({ wfExp: null }), '');
});
t('the walk-forward badge is amber, not green, while its CI spans zero', () => {
  ok(grabFn('renderDiagnostic').includes("wf.wfExp>0?(wf.wfCI&&wf.wfCI.lo<=0?'mid':'ok')"));
  ok(grabFn('renderDiagnostic').includes('edgeEstablished(s.sharpeLo,boot)'), 'the headline uses the shared test');
});

console.log('\nProject vs the Diagnostic edge test');
const ENG = await evalModule(['edgeEstablished', 'edgeTest', 'sharpeStats', 'dailySeriesCalendar', '_srand', '_hashSeed', 'bootstrapMeanCI', 'ddPctOfBest', 'autoBeBand', 'beFixedOf', 'beBandFor'],
  ['edgeEstablished', 'edgeTest', 'ddPctOfBest', 'autoBeBand', 'beFixedOf', 'beBandFor'],
  `let _rng=Math.random, _be=50;
   const _avg=a=>a.length?a.reduce((x,y)=>x+y,0)/a.length:0;
   const _std=a=>{ if(a.length<2)return 0; const m=_avg(a); return Math.sqrt(a.reduce((s,x)=>s+(x-m)*(x-m),0)/(a.length-1)); };
   const tzMidnight=ms=>Math.floor(ms/864e5)*864e5, addDays=(ms,n)=>ms+n*864e5;`);
const DAY = 864e5, T0 = Date.UTC(2026, 0, 1);
const mkT = nets => nets.map((n, i) => ({ id: 't' + i, net: n, closeTime: T0 + i * DAY, isOpen: false }));
t('edgeEstablished is the headline test: Sharpe or expectancy lower bound above 0', () => {
  eq(ENG.edgeEstablished(0.2, null), true); eq(ENG.edgeEstablished(-0.1, { lo: 3 }), true);
  eq(ENG.edgeEstablished(-0.1, { lo: -3 }), false); eq(ENG.edgeEstablished(null, null), false);
});
t('edgeTest: a noisy small edge is not proven; a steady one is; deterministic', () => {
  const noisy = mkT(Array.from({ length: 40 }, (_, i) => (i % 2 ? 300 : -280) + (i % 7)));
  const a = ENG.edgeTest(noisy), b = ENG.edgeTest(noisy);
  eq(a.proven, false); ok(a.boot && a.boot.lo < 0, 'bootstrap CI spans 0'); eq(a, b, 'same trades, same answer');
  eq(ENG.edgeTest(mkT(Array.from({ length: 40 }, (_, i) => 50 + (i % 5)))).proven, true);
  eq(ENG.edgeTest(mkT([10, 20])).proven, false, 'under 5 trades proves nothing');
});
t('edgeTest seeds and sizes its bootstrap like the Diagnostic Monte Carlo', () => {
  ok(grabFn('_diagMCInput').includes("_hashSeed('diag|'+N+'|'+(N?closed[0].id+'|'+closed[N-1].id:''))") && grabFn('_diagMCInput').includes('B:N>3000?800:2000'));
  ok(grabFn('edgeTest').includes("_hashSeed('diag|'+N+'|'+closed[0].id+'|'+closed[N-1].id)") && grabFn('edgeTest').includes('N>3000?800:2000'));
});
t('Project: "Simulated paths ending green", and the not-yet-proven label beside odds and milestones', () => {
  const src = grabFn('renderProjection');
  ok(!html.includes('Odds you finish green'), 'old label');
  ok(src.includes("mrow('Simulated paths ending green'") && src.includes('Not a probability'));
  ok(src.includes('If your average day holds — not yet a proven edge.') && src.includes('edgeTest(bt,bm)')); // the daily Sharpe runs on money rows (bm)
  ok(src.includes('${ifNote}') && src.includes("${msRows}${medPerDay>0?ifNote:''}"), 'label next to the odds and the milestones');
});

console.log('\nDrawdown % and the Verified strip');
t('max drawdown % is labeled as a share of best cumulative profit, not "off peak"', () => {
  eq(ENG.ddPctOfBest(0.838), '84% of best cumulative profit');
  eq(ENG.ddPctOfBest(0.042), '4.2% of best cumulative profit');
  eq(ENG.ddPctOfBest(1.54), '1.5× your best cumulative profit', 'a fall deeper than the best ever reached reads as a multiple');
  eq(ENG.ddPctOfBest(1), '1× your best cumulative profit');
  ok(!html.includes("% off peak'"), 'dashboard tile');
  ok(grabFn('computeStats').includes('const maxDDpct = peak>0 ? Math.abs(maxDD)/peak : null;'), 'computation unchanged');
  ok(html.includes("ddPctOfBest(s.maxDDpct):'peak to trough'") && html.includes("' · '+ddPctOfBest(s.maxDDpct)"), 'dashboard + Diagnostic use it');
});
t('the Verified strip says the number is Hyperliquid’s and recon is the gap to it', () => {
  ok(!html.includes('matches the app exactly'));
  const src = grabFn('renderReconcile');
  ok(src.includes("Hyperliquid's own account P&L figures") && src.includes('“recon” is how far the fill-based sum is from each'));
  ok(src.includes('doesn’t follow the period'), 'the strip says it is all time, whatever period is picked');
});

console.log('\nBreak-even band');
const BE = (0, eval)(`(() => { let _be = 50; ${BE_LINES.map(l => line(html, l)).join('\n')}
  return { set: v => { _be = v; }, isWin, isLoss, isBE }; })()`);
t('strict band: a trade exactly at the band is decided, not a scratch', () => {
  BE.set(10);
  eq([BE.isWin(10), BE.isBE(10), BE.isLoss(-10), BE.isBE(-10)], [true, false, true, false]);
  eq([BE.isBE(9.99), BE.isWin(9.99), BE.isBE(-9.99), BE.isLoss(-9.99)], [true, false, true, false]);
  BE.set(0);
  eq([BE.isBE(0), BE.isWin(0), BE.isLoss(0), BE.isWin(0.01), BE.isLoss(-0.01)], [true, false, false, true, true], 'band 0: only an exact 0 is a scratch');
});
t('the server classifies exactly like the app (shims and the outcome filter)', () => {
  for (const l of BE_LINES) eq(line(serverSrc, l), line(html, l));
  ok(serverSrc.includes("outcome === 'win' && !(t.net > 0 && t.net >= be)") && serverSrc.includes("outcome === 'be' && !(Math.abs(t.net) < be || t.net === 0)"));
  ok(serverSrc.includes("'autoBeBand', 'beFixedOf'") && serverSrc.includes('E.autoBeBand(ensureTrades().trades.filter(t => E.tradeRow(t) && !t.movedOut && !(t.offRecord && !t.isOpen)))'), 'the band is taken over trade rows, as the app does');
});
t('auto band: 5% of the median |net|, clamped $0.50–$50, open trades ignored', () => {
  // the beta report: a +$50 (+20%) winner was "B/E" and a −$41 loss neither win nor loss
  const small = [{ net: 50 }, { net: -41 }, { net: 12 }, { net: -8 }, { net: 30 }, { net: 9999, isOpen: true }];
  const b = ENG.autoBeBand(small); eq(b, 1.5);
  BE.set(b); ok(BE.isWin(50) && BE.isLoss(-41) && BE.isBE(1.2));
  eq(ENG.autoBeBand([{ net: 5000 }, { net: -9000 }]), 50, 'big accounts keep $50');
  eq(ENG.autoBeBand([{ net: 2 }, { net: -1 }]), 0.5, 'floor');
  eq(ENG.autoBeBand([]), 0.5);
  eq(ENG.autoBeBand([{ net: 99.5 }, { net: -204 }]), 7.59, 'median of two, rounded to cents');
});
t('a user-set band is kept; the old boot-written $50 (no beFixed) reads as auto', () => {
  eq(ENG.beFixedOf({}), null); eq(ENG.beFixedOf({ beThreshold: null }), null);
  eq(ENG.beFixedOf({ beThreshold: 50 }), null, 'legacy default');
  eq(ENG.beFixedOf({ beThreshold: 50, beFixed: true }), 50);
  eq(ENG.beFixedOf({ beThreshold: 20 }), 20); eq(ENG.beFixedOf({ beThreshold: 0 }), 0, '0 turns the band off');
  eq(ENG.beFixedOf({ beThreshold: -3 }), null);
  eq(ENG.beBandFor({ beThreshold: 20 }, [{ net: 1e6 }]), 20);
  eq(ENG.beBandFor({ beThreshold: 50 }, [{ net: 30 }, { net: -30 }]), 1.5);
});
t('boot no longer writes 50; render and Daruma resolve the band; sync and backups carry beFixed', () => {
  ok(!html.includes('settings.beThreshold=50'), 'boot still writes the old default');
  ok(!/_be=\(settings\.beThreshold!=null\?settings\.beThreshold:50\)/.test(html), 'a flat 50 fallback survives');
  ok(grabFn('render').includes('applyBeBand();') && grabFn('renderInner').includes('applyBeBand();'));
  ok(grabFn('syncBeInput').includes("'auto ('+fmtUsd(_be)+') ·'") && html.includes('<b id="beAuto"></b>'), 'Settings shows auto ($X)');
  ok(html.includes("'pageSize','beThreshold','beFixed','theme'") && html.includes('beFixed:settings.beFixed'));
  ok(html.includes('id="beThresh" min="0" step="any" placeholder="auto"'));
});

report('honest-stats');
