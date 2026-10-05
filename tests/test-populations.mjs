// Two populations out of one list (engine.js: tradeRow / moneyRow). Completed trades are counted,
// rated and listed; realized money is summed. A spot position and the day rows that carry its
// sells are never both in a sum, and a day row is never a trade. The guards here keep it so:
// no file builds a closed-trade list from allTrades by hand (closedTrades / realizedMoney /
// periodTrades do), the server names the population on every closed list it takes, and
// computeStats' two inputs read the right rows.
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { t, ok, eq, near, report, makeExtractor } from './harness.mjs';
import { readAppSource } from '../app-source.js';

const here = dirname(fileURLToPath(import.meta.url)), root = join(here, '..');
const html = readAppSource(join(root, 'ledger.html'));
const { evalModule } = makeExtractor(html);

console.log('\nTrade rows and money rows');
t('no app file builds a closed-trade list from allTrades by hand: closedTrades / realizedMoney / periodTrades do', () => {
  const files = [...readdirSync(join(root, 'app')).filter(f => f.endsWith('.js')).map(f => 'app/' + f),
    ...readdirSync(join(root, 'app/features')).filter(f => f.endsWith('.js')).map(f => 'app/features/' + f)];
  const allowed = [ // the helpers themselves, and two bookkeeping reads that want every closed row (ids to purge, the off-record count)
    'function closedTrades(f){', 'function realizedMoney(f){', 'function periodTrades(){',
    'closedIds=new Set(allTrades.filter(t=>!t.isOpen).map(t=>t.id))', 'offN=allTrades.filter(t=>!t.isOpen&&t.offRecord).length'];
  const bad = [];
  for (const f of files) readFileSync(join(root, f), 'utf8').split('\n').forEach((l, i) => {
    if (/allTrades\.filter\(\s*\(?\s*[a-z]\s*\)?\s*=>\s*!\s*[a-z]\.isOpen/.test(l) && !allowed.some(a => l.includes(a))) bad.push(f + ':' + (i + 1) + ' ' + l.trim().slice(0, 100)); });
  eq(bad, [], 'hand-built closed lists — use closedTrades(f) for trades or realizedMoney(f) for money:\n' + bad.join('\n'));
});
t('the server names the population on every closed list it takes (E.tradeRow / E.moneyRow)', () => {
  const allowed = ['peerSummary(trades.filter(x => !x.isOpen && x.closeTime)', 'inWin = trades.filter(x => !x.isOpen && x.closeTime >= from)']; // `trades` is cut to trade rows two lines above
  const bad = [];
  readFileSync(join(root, 'server.js'), 'utf8').split('\n').forEach((l, i) => {
    if (/\btrades\.filter\(\s*[a-z]\s*=>\s*!\s*[a-z]\.isOpen/.test(l) && !/E\.(tradeRow|moneyRow)/.test(l) && !allowed.some(a => l.includes(a))) bad.push('server.js:' + (i + 1) + ' ' + l.trim().slice(0, 110)); });
  eq(bad, [], 'closed lists on the server without E.tradeRow / E.moneyRow:\n' + bad.join('\n'));
});

const PRE = "const _be=50;const isWin=n=>n>_be,isLoss=n=>n<-_be,isBE=n=>Math.abs(n)<=_be;let spotMaps={nameByCoin:{}};"
  + "const _avg=a=>a.length?a.reduce((x,y)=>x+y,0)/a.length:0;const _std=a=>0;let journal={},settings={tz:'utc'},_oneR=null;"
  + "const tzParts=ms=>{const d=new Date(ms);return {y:d.getUTCFullYear(),mo:d.getUTCMonth(),day:d.getUTCDate(),h:d.getUTCHours(),dow:d.getUTCDay()};};"
  + "const dayKey=ms=>new Date(ms).toISOString().slice(0,10);const tzMidnight=ms=>Date.parse(dayKey(ms));const addDays=(ms,n)=>ms+n*864e5;";
const S = await evalModule(['computeStats', 'dailyPnl', 'dailySeriesCalendar', 'sharpeStats', 'sortinoAnnual', 'retPct', 'rFor', 'riskFor', 'avgLossOf', 'tradeRow', 'moneyRow'],
  ['computeStats', 'tradeRow', 'moneyRow'], PRE).catch(e => ({ err: e }));
t('computeStats: trade rows are counted, money rows are summed; a spot position and its day rows are never both', () => {
  if (S.err) throw S.err;
  const D = Date.UTC(2026, 5, 15, 12), base = { fees: 0, funding: 0, takerNotional: 0 };
  const perp = { ...base, market: 'perp', isOpen: false, openTime: D - 3600e3, closeTime: D, net: 100, fees: 2, pnl: 102, durationMs: 3600e3, makerNotional: 1000 };
  const pos = { ...base, market: 'spot', spotPos: true, isOpen: false, openTime: D - 7200e3, closeTime: D + 60e3, net: 30, fees: 1, pnl: 31, durationMs: 7200e3, makerNotional: 500 }; // a round trip
  const moved = { ...base, market: 'spot', spotPos: true, movedOut: true, isOpen: false, openTime: D - 9000e3, closeTime: D - 8000e3, net: -0.5, fees: 0.5, pnl: 0, durationMs: 1000e3, makerNotional: 400 }; // left without a sale
  const held = { ...base, market: 'spot', spotPos: true, isOpen: true, openTime: D - 86400e3, closeTime: D, net: 5, fees: 1, pnl: 6, durationMs: 86400e3, makerNotional: 900 }; // still held, partly sold
  const day = { ...base, market: 'spot', spotRz: true, isOpen: false, openTime: D - 7200e3, closeTime: D + 60e3, net: 35, fees: 2, pnl: 37, durationMs: 7260e3, makerNotional: 1800 }; // the day's realized: pos's and held's sells
  const all = [perp, pos, moved, held, day];
  const closed = all.filter(x => !x.isOpen && S.tradeRow(x) && !x.movedOut), money = all.filter(S.moneyRow);
  eq(closed, [perp, pos], 'completed trades: the perp trade and the spot round trip'); eq(money, [perp, day], 'money: the perp trade and the day row');
  const s = S.computeStats(closed, money);
  eq([s.n, s.wins, s.losses, s.breakeven], [2, 1, 0, 1], 'two trades: the perp win and the spot scratch');
  near(s.net, 135, 1e-9, 'perp 100 + the day row 35 — the position is not summed again'); near(s.fees, 4, 1e-9); near(s.volume, 2800, 1e-9, 'perp 1,000 + the day row 1,800');
  const naive = S.computeStats(all.filter(x => !x.isOpen), all);
  ok(naive.n === 4 && naive.net > s.net, 'every row at once would count the balance that left as a trade and the spot sells twice (' + naive.n + ' trades, net ' + naive.net + ')');
});
// The measured rule (engine.js: measured / notionalOf / holdOf): a row whose entry is unknown (partialHistory)
// carries a stand-in entry and a size that includes what was held before, so no file multiplies
// maxSize by avgEntry on its own — notionalOf does, and answers null for such a row. (The sizing-creep
// card once reported a "$3,817 median" built from exactly those rows.)
t('no app file sizes a trade by hand: notionalOf does, and a stand-in entry has no size', () => {
  const raw = /maxSize\s*(\|\|\s*0\))?\s*\*\s*\(?\+?t\.avgEntry|\(\+t\.maxSize\|\|0\)\*\(\+t\.avgEntry/;
  const files = [...readdirSync(join(root, 'app')).filter(f => f.endsWith('.js')).map(f => 'app/' + f),
    ...readdirSync(join(root, 'app/features')).filter(f => f.endsWith('.js')).map(f => 'app/features/' + f), 'server.js'];
  const bad = [];
  for (const f of files) readFileSync(join(root, f), 'utf8').split('\n').forEach((line, i) => {
    if (raw.test(line) && !/function notionalOf\(|function retPct\(/.test(line)) bad.push(f + ':' + (i + 1));
  });
  eq(bad, [], 'size products outside notionalOf / retPct');
  ok(/function notionalOf\(t\)\{ return measured\(t\)&&/.test(readFileSync(join(root, 'app/engine.js'), 'utf8')), 'notionalOf answers null for an unmeasured row');
});

report('populations');
