// The trade journal editor's pure parts: tags de-duplicated without regard to case (and the tag
// filter listing each name once), a trade plan checked against the trade's own side before it's
// saved, and a failed wallet load named for what went wrong. Extracted from the shipped app.
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { t, ok, eq, report, makeExtractor } from './harness.mjs';
import { readAppSource } from '../app-source.js';

const here = dirname(fileURLToPath(import.meta.url));
const html = readAppSource(join(here, '..', 'ledger.html'));
const { evalModule } = makeExtractor(html);

const PRELUDE = `
const walletShort=a=>String(a||'').slice(0,6)+'…'+String(a||'').slice(-4);
const labelFor=w=>w&&(w.label||walletShort(w.address))||'';
`;
const M = await evalModule(['parseTags', 'tagOptions', 'planCoinKey', 'pplanCheck', 'tradePlanCheck', 'loadFailNote'],
  ['parseTags', 'tagOptions', 'tradePlanCheck', 'loadFailNote'], PRELUDE);
const { parseTags, tagOptions, tradePlanCheck, loadFailNote } = M;

console.log('\ntags');
t('a tag list keeps one spelling per name, the first, and drops blanks', () => {
  eq(parseTags('scalp, , SCALP, scalp ,  fomo'), ['scalp', 'fomo']);
  eq(parseTags('A-Setup,a-setup,Trend'), ['A-Setup', 'Trend']);
  eq(parseTags(''), []); eq(parseTags(' , ,'), []); eq(parseTags(null), []);
});
t('the tag filter lists each name once, keyed in lower case, sorted', () => {
  const J = { a: { tags: ['scalp', 'FOMO'] }, b: { tags: ['SCALP', 'breakout'] }, c: { notes: 'x' }, 'day:2026-01-01': { bias: 'up' }, d: null };
  eq(tagOptions(J), [['breakout', 'breakout'], ['fomo', 'FOMO'], ['scalp', 'scalp']]);
  eq(tagOptions({}), []);
});

console.log('\ntrade plan check');
const long = { coin: 'BTC', dir: 'Long', avgEntry: 100 }, short = { coin: 'BTC', dir: 'Short', avgEntry: 100 };
t('a short with its stop below the entry (and target above) is refused, in Daruma’s words', () => {
  eq(tradePlanCheck(short, NaN, 95, 120), 'For a short, the stop goes above the entry.');
  eq(tradePlanCheck(short, 100, 95, NaN), 'For a short, the stop goes above the entry.');
  eq(tradePlanCheck(short, NaN, 110, 120), 'For a short, the target goes below the stop.');
  eq(tradePlanCheck(short, NaN, 110, 90), '');
});
t('a long: stop below the entry, target above it; a blank entry is the trade’s own', () => {
  eq(tradePlanCheck(long, NaN, 105, NaN), 'For a long, the stop goes below the entry.');
  eq(tradePlanCheck(long, 110, 105, 120), '', 'a planned entry above the fill is the plan’s entry');
  eq(tradePlanCheck(long, NaN, 95, 98), 'For a long, the target goes above the entry.');
  eq(tradePlanCheck(long, NaN, 95, 110), '');
  eq(tradePlanCheck({ coin: 'PURR/USDC', dir: 'Spot', avgEntry: 1 }, NaN, 1.2, NaN), 'For a long, the stop goes below the entry.', 'spot is a long');
});
t('without a stop only the target is checked; an empty plan is fine', () => {
  eq(tradePlanCheck(short, NaN, NaN, 120), 'For a short, the target goes below the entry.');
  eq(tradePlanCheck(short, NaN, NaN, 80), '');
  eq(tradePlanCheck(long, NaN, NaN, NaN), '');
});

console.log('\nwallet load failures');
t('a network failure names the venue and the wallet, not “no activity”', () => {
  const w = { address: '0xabc', label: 'main' };
  eq(loadFailNote(w, 'Network error reaching Hyperliquid — check your connection.'), 'Couldn’t reach Hyperliquid for main — check your connection');
  eq(loadFailNote(w, 'API 500'), 'Couldn’t load main — API 500');
  ok(!/No activity/.test(loadFailNote(w, '')));
});

report('journal edit');
