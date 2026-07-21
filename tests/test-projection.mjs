// Projection engine (Project tab) and tax-statement PDF tests.
// Functions are extracted from ledger.html itself so the tests exercise exactly what ships.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, '..', 'ledger.html'), 'utf8');

import { t, ok, eq, near, report, makeExtractor } from './harness.mjs';
const { grabBlock, grabFn, evalFn, evalClass } = makeExtractor(html);

// globals the extracted functions expect
globalThis._rng = Math.random;
globalThis.tzMidnight = ms => { const d = new Date(ms); d.setUTCHours(0,0,0,0); return d.getTime(); };
globalThis.addDays = (ms, n) => ms + n * 86400000;
globalThis.isWin  = n => n > 50;
globalThis.isLoss = n => n < -50;
globalThis.dcoin  = tr => tr.symbol || tr.coin;
globalThis.fmtUsd = (n, dp = 2) => {
  if (n === null || n === undefined || isNaN(n)) return '\u2014';
  const s = n < 0 ? '-' : '';
  return s + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
};

globalThis._srand = evalFn('_srand');
globalThis._hashSeed = evalFn('_hashSeed');
const projBaseline    = evalFn('projBaseline');
const projectForward  = evalFn('projectForward');
const projMilestones  = evalFn('projMilestones');
const taxStatementModel = evalFn('taxStatementModel');
const renderTaxPdfDoc = evalFn('renderTaxPdfDoc');
const MiniPDF = evalClass('MiniPDF');
globalThis.MiniPDF = MiniPDF;

const DAY = 86400000;
const NOW = Date.UTC(2026, 6, 10, 12, 0, 0); // fixed "now" for determinism

function mkTrade(o){
  return Object.assign({ isOpen:false, market:'perp', dir:'Long', coin:'BTC', symbol:'BTC',
    maxSize:1, avgEntry:100, pnl:o.net!=null?o.net:0, fees:0, funding:0,
    durationMs:3600000, openTime:(o.closeTime||NOW)-3600000 }, o);
}

console.log('projBaseline');
await t('daily series spans first trade day through today, flat days included', () => {
  const trades = [
    mkTrade({ closeTime: NOW - 9*DAY, net: 100 }),
    mkTrade({ closeTime: NOW - 9*DAY, net:  50 }),   // same day, aggregated
    mkTrade({ closeTime: NOW - 4*DAY, net: -80 }),
    mkTrade({ closeTime: NOW,         net: 200 }),
  ];
  const b = projBaseline(trades, 30, NOW);
  ok(b, 'baseline null');
  ok(b.daily.length === 10, 'expected 10 calendar days, got ' + b.daily.length);
  near(b.daily[0], 150); near(b.daily[5], -80); near(b.daily[9], 200);
  near(b.daily[1], 0, 1e-12); // flat day present
  ok(b.activeDays === 3 && b.calDays === 10, 'active/cal days wrong');
  near(b.total, 270); near(b.perDay, 27); ok(b.trades === 4);
});
await t('lookback window excludes older trades; win rate uses the break-even band', () => {
  const trades = [
    mkTrade({ closeTime: NOW - 100*DAY, net: 9999 }), // outside 30d window
    mkTrade({ closeTime: NOW - 5*DAY, net: 100 }),    // win
    mkTrade({ closeTime: NOW - 4*DAY, net: -100 }),   // loss
    mkTrade({ closeTime: NOW - 3*DAY, net: 10 }),     // scratch (|n|<=50)
  ];
  const b = projBaseline(trades, 30, NOW);
  ok(b.trades === 3, 'window filter failed');
  near(b.winRate, 0.5);
  near(b.expectancy, 10 / 3);
});
await t('open trades and empty windows are handled', () => {
  ok(projBaseline([mkTrade({ closeTime: NOW, net: 5, isOpen: true })], 30, NOW) === null);
  ok(projBaseline([mkTrade({ closeTime: NOW - 90*DAY, net: 5 })], 30, NOW) === null);
});

console.log('projectForward');
await t('deterministic for a fixed seed', () => {
  const daily = [10, -5, 30, 0, 12, -20, 8];
  const a = projectForward(daily, 60, 200, 1234);
  const b = projectForward(daily, 60, 200, 1234);
  ok(JSON.stringify(a.bands.p50) === JSON.stringify(b.bands.p50), 'p50 differs run-to-run');
  ok(a.end.p95 === b.end.p95 && a.probPositive === b.probPositive, 'summary differs');
});
await t('auto-seed derived from the data is also deterministic', () => {
  const daily = [10, -5, 30, 0, 12];
  const a = projectForward(daily, 40, 150);
  const b = projectForward(daily, 40, 150);
  ok(JSON.stringify(a.end) === JSON.stringify(b.end), 'auto-seeded runs differ');
});
await t('quantile bands are ordered p05<=p25<=p50<=p75<=p95 on every day', () => {
  const daily = [100, -80, 40, 0, 65, -30, 20, 5];
  const f = projectForward(daily, 120, 300, 7);
  for (let d = 0; d < 120; d++){
    const { p05, p25, p50, p75, p95 } = f.bands;
    ok(p05[d] <= p25[d] && p25[d] <= p50[d] && p50[d] <= p75[d] && p75[d] <= p95[d],
      'band ordering violated at day ' + d);
  }
});
await t('constant daily PnL collapses every band onto the exact line', () => {
  const f = projectForward([100], 30, 50, 99);
  for (let d = 0; d < 30; d++){
    near(f.bands.p05[d], 100 * (d + 1)); near(f.bands.p95[d], 100 * (d + 1));
  }
  near(f.end.p50, 3000);
  ok(f.probPositive === 1, 'all-positive daily must give probPositive 1');
});
await t('degenerate inputs return null', () => {
  ok(projectForward([], 30) === null);
  ok(projectForward(null, 30) === null);
  ok(projectForward([1, 2], 0) === null);
});

console.log('projMilestones');
await t('walks the 1/2/2.5/5 ladder strictly above start', () => {
  const m = projMilestones(1200, 4);
  ok(JSON.stringify(m) === JSON.stringify([2000, 2500, 5000, 10000]), 'got ' + JSON.stringify(m));
  const z = projMilestones(0, 3);
  ok(JSON.stringify(z) === JSON.stringify([100, 200, 250]), 'got ' + JSON.stringify(z));
  ok(projMilestones(100, 2)[0] === 200, 'must be strictly above start');
  ok(projMilestones(NaN).length === 0);
});

console.log('taxStatementModel');
const stTrades = [
  mkTrade({ closeTime: Date.UTC(2025, 10, 5),  net: 100,  pnl: 110, fees: 12, funding: 2,  symbol: 'BTC' }),
  mkTrade({ closeTime: Date.UTC(2025, 11, 20), net: -50,  pnl: -45, fees: 6,  funding: 1,  symbol: 'ETH' }),
  mkTrade({ closeTime: Date.UTC(2026, 0, 3),   net: 300,  pnl: 310, fees: 11, funding: 1,  symbol: 'SOL' }),
  mkTrade({ closeTime: Date.UTC(2026, 0, 15),  net: -20,  pnl: -18, fees: 3,  funding: 1,  symbol: 'BTC' }),
  mkTrade({ closeTime: Date.UTC(2026, 2, 1),   net: 70,   pnl: 75,  fees: 5,  funding: 0,  symbol: 'HYPE' }),
  mkTrade({ closeTime: Date.UTC(2026, 2, 2),   net: 1,    pnl: 1,   fees: 0,  funding: 0,  isOpen: true }), // excluded
];
await t('groups by UTC tax year with continuous running balance', () => {
  const m = taxStatementModel(stTrades, [{ label: 'main', address: '0xabc' }], '2026-07-10T00:00:00.000Z');
  ok(m.years.length === 2 && m.years[0].year === 2025 && m.years[1].year === 2026);
  near(m.years[0].open, 0); near(m.years[0].close, 50);
  near(m.years[1].open, m.years[0].close, 1e-9); // balance carries across years
  near(m.endBalance, 400);
  ok(m.grand.n === 5, 'open trade must be excluded');
  ok(m.generated === '2026-07-10T00:00:00Z');
});
await t('monthly subtotals sum to year totals; each line satisfies pnl+fees+funding=net', () => {
  const m = taxStatementModel(stTrades, []);
  for (const Y of m.years){
    const mn = Y.months.reduce((s, x) => s + x.net, 0);
    near(mn, Y.totals.net, 1e-9);
    ok(Y.months.reduce((s, x) => s + x.n, 0) === Y.totals.n);
    for (const ln of Y.lines) near(ln.pnl + ln.fees + ln.funding, ln.net, 1e-9);
  }
  const y26 = m.years[1];
  ok(y26.months[0].wins === 1 && y26.months[0].losses === 1, 'Jan W/L wrong');
  ok(y26.lines[0].fees <= 0, 'fees must be shown as a negative cost');
});
await t('returns null with no closed trades', () => {
  ok(taxStatementModel([mkTrade({ closeTime: NOW, isOpen: true })], []) === null);
});

console.log('MiniPDF');
await t('emits a structurally valid multi-page PDF', () => {
  const pdf = new MiniPDF();
  pdf.text(50, 700, 'Hello (world) \\ back', { size: 10, bold: true });
  pdf.newPage();
  pdf.text(50, 700, 'Page two \u2014 em dash \u00b7 dot');
  pdf.line(40, 100, 500, 100); pdf.rect(40, 200, 100, 20);
  const out = pdf.output();
  ok(out.startsWith('%PDF-1.4'), 'bad header');
  ok(out.endsWith('%%EOF'), 'bad trailer');
  ok((out.match(/\/Type \/Page /g) || []).length === 2, 'expected 2 pages');
  ok(out.includes('/Count 2'), 'page tree count wrong');
  ok(out.includes('\\(world\\)'), 'parens not escaped');
  ok(!/[^\x00-\x7F]/.test(out), 'non-ASCII leaked into the PDF (breaks Length byte math)');
  ok(out.includes('- em dash . dot'), 'unicode not transliterated');
});
await t('stream /Length matches actual bytes and xref offsets point at objects', () => {
  const pdf = new MiniPDF();
  pdf.text(10, 10, 'x'); pdf.newPage(); pdf.text(10, 10, 'y');
  const out = pdf.output();
  const re = /<< \/Length (\d+) >>\nstream\n([\s\S]*?)\nendstream/g;
  let m2, streams = 0;
  while ((m2 = re.exec(out))){ streams++; ok(+m2[1] === m2[2].length, 'Length mismatch'); }
  ok(streams === 2, 'expected 2 content streams');
  const xr = out.indexOf('xref');
  const size = +out.match(/\/Size (\d+)/)[1];
  const offsets = out.slice(xr).split('\n').slice(3, 3 + size - 1).map(l => +l.slice(0, 10)); // skip 'xref', '0 N', free entry
  offsets.forEach((off, i) => ok(out.slice(off).startsWith((i + 1) + ' 0 obj'), 'xref offset ' + (i + 1) + ' wrong'));
});
await t('Courier width math keeps right-aligned text on the anchor', () => {
  const pdf = new MiniPDF();
  pdf.textR(500, 100, '$1,234.56', { size: 8 });
  const op = pdf.pages[0][0];
  const x = +op.match(/1 0 0 1 ([\d.]+) /)[1];
  near(x + '$1,234.56'.length * 0.6 * 8, 500, 0.01);
});

console.log('renderTaxPdfDoc');
await t('statement renders with headers, years, totals, and page footers', () => {
  const m = taxStatementModel(stTrades, [{ label: 'main', address: '0x1234567890abcdef' }]);
  const out = renderTaxPdfDoc(m);
  ok(out.startsWith('%PDF-1.4') && out.endsWith('%%EOF'));
  ok(out.includes('ACCOUNT STATEMENT'), 'missing title');
  ok(out.includes('TAX YEAR 2025') && out.includes('TAX YEAR 2026'), 'missing year sections');
  ok(out.includes('Page 1 of'), 'missing footer');
  ok(out.includes('Not tax advice'), 'missing disclaimer');
  ok(!/[^\x00-\x7F]/.test(out), 'non-ASCII leaked into statement');
});
await t('large histories paginate and repeat the detail header', () => {
  const many = [];
  for (let i = 0; i < 400; i++)
    many.push(mkTrade({ closeTime: Date.UTC(2026, 0, 1) + i * 3600000 * 6, net: (i % 3 ? 40 : -25), pnl: (i % 3 ? 42 : -23), fees: 2, funding: 0, symbol: 'BTC' }));
  const out = renderTaxPdfDoc(taxStatementModel(many, []));
  const pages = (out.match(/\/Type \/Page /g) || []).length;
  ok(pages >= 5, 'expected multi-page output, got ' + pages);
  ok(out.includes('Page ' + pages + ' of ' + pages), 'last footer wrong');
  ok((out.match(/\(BALANCE\)/g) || []).length >= pages - 1, 'detail header not repeated across pages');
});

report();
