# Ledger

A self-contained trading journal and analytics tool for [Hyperliquid](https://hyperliquid.xyz).
One HTML file, no build step, no framework, no tracking. All analysis runs in your
browser, talking directly to Hyperliquid's public API — your fills, journal, and
statistics never touch a third party.

Open `ledger.html` from disk and it works. Serve it with the included companion
server and it gains cross-device persistence. Same file either way.

## What it does

**Trade reconstruction.** Your on-chain history is a stream of fills; Ledger
rebuilds it into positions — entries, adds, partial closes, flips (a single fill
that closes a long and opens a short is split into its two legs), liquidations —
across the main perp DEX, HIP-3 builder-deployed DEXes, and spot. Funding
payments are attributed to the trades whose holding window they fall in, so every
trade's net is price PnL − fees ± funding, not just the exchange's `closedPnl`.

**Performance diagnostics.** Equity curve, drawdown, Sharpe with confidence
bounds (a verdict grade tells you whether your edge is distinguishable from
noise), win-rate and expectancy with Wilson intervals, bootstrap CIs on mean
return, Monte-Carlo drawdown expectations, rolling 30-trade expectancy,
change-point detection on the return series, size-dependence testing, and a
monthly PnL decomposition (price vs funding vs fees) that shows whether a
price-profitable strategy is quietly bleeding through costs.

**Pattern miner.** Mines your closed trades for conditions under which you trade
significantly better or worse — time of day, weekday, session, coin, direction,
hold time, size bucket, behavioral states (after losses, revenge-window,
overtrading), execution style (maker/taker), chased entries, journal tags, and
excursion-derived features — as singles and cross-family pairs. Significance
comes from permutation tests with Benjamini–Hochberg FDR correction, so it
reports "survives multiple-comparison correction," not p-hacked trivia. Runs are
deterministic: the RNG is seeded from the data selection, so identical data
reproduces identical results (the seed is displayed).

**Price excursions (MAE/MFE).** Fetches exchange candles to measure how far each
trade ran against you and in your favor. Answers the two questions fills alone
can't: are your stops sized to what winners actually endure ("90% of winners
never drew down more than X% / Y R"), and how much peak open profit you give
back ("you banked 59¢ of every $1"). Results appear as plain-English verdicts,
per-trade lines in the journal, miner features, and a live open-position monitor
that flags positions already "beyond winner territory." Candle retention is
limited on the exchange side, so measurements are a **ratchet**: once a trade is
measured it's persisted and never degrades — run it regularly and precision only
accumulates.

**Journal.** Tags, setup labels, star ratings, mistake flags, planned risk (for
R-multiples), free-text notes, and image attachments per trade. Everything
journaled becomes minable.

**Utilities.** Multi-wallet with per-wallet incremental fill caching, tax CSV
export, one-click self-contained HTML report export (charts embedded as images),
full JSON backup/restore, and a unified local/UTC timezone toggle.

## Architecture

```
ledger.html    the entire app: UI, engine, Web Worker (built at runtime from a
               Blob of the page's own functions), inlined Chart.js and fonts.
               Strict CSP; the only network peer is api.hyperliquid.xyz.
server.js      optional companion server (zero npm dependencies): serves the
               HTML and persists one JSON blob with revision checks.
package.json   start script; nothing to install.
tests/         Node test suites + runner. Tests extract functions directly from
               ledger.html, so they exercise exactly what ships.
```

Heavy work — reconstruction and the miner's permutation tests — runs in a Web
Worker so large wallets don't freeze the tab; if worker construction fails, the
same code runs synchronously on the main thread. Fills and candles cache in
IndexedDB and refresh incrementally.

## Running it

**Standalone:** open `ledger.html` in a browser. Data persists in that browser;
optionally link a data file (File System Access API) for a portable auto-saved
JSON, or use *Backup all*.

**Served with persistence:** `npm start` (or `node server.js`) and open
`http://localhost:8080`. The app detects the server and auto-saves journal,
wallets, settings, and excursion measurements to it — edits survive reboots and
work across devices. Set `AUTH_TOKEN` to protect the API. For Railway
deployment (volume setup, environment variables, verification steps), see
[README-deploy.md](README-deploy.md) — the short version is: **attach a Volume
at `/data` or nothing persists across redeploys.**

Add a wallet address, hit *Load all*, and explore the Overview / Trades /
Diagnostic views. The pattern miner and price excursions are on-demand buttons
inside Diagnostic (both cache their work).

## Data & privacy

Everything stays between your browser, your storage, and Hyperliquid's public
API. The companion server, if used, sees only the JSON blob you sync to it —
run it on your own infrastructure. Wallet addresses and journal notes are
sensitive; use `AUTH_TOKEN` on any deployment that has a public URL.

What lives where: journal/wallets/settings/measurements sync to the server (or
linked file); fill and candle caches stay in IndexedDB (re-fetchable); image
attachments stay in the browser that uploaded them.

## Limitations, stated honestly

- The fills API paginates ~60 pages deep; wallets beyond ~120k fills can't be
  fully backfilled (existing caches preserve older history — keep backups).
- Exchange candle retention (~5,000 candles per interval) caps how precisely
  old short trades can be measured; such trades are marked ≈ and excluded from
  excursion statistics rather than allowed to distort them.
- Excursions can't see intra-candle sequencing; values within one candle's
  range are approximate by nature.
- The miner is correlational and in-sample — validated patterns are hypotheses
  to trade deliberately and re-test, not guarantees, and the UI says so.
- Server sync is last-writer-wins with conflict detection (no silent clobber),
  not field-level merge.

## Testing

```
npm test          # or: node tests/run-all.mjs
```

128 tests across five suites: engine logic (reconstruction, flips, funding
attribution), the worker dispatcher exercised end-to-end with parity against the
synchronous path, excursion math and the retention/ratchet behavior, miner
families and determinism, and the server over real HTTP (auth, revision
conflicts, restart survival). Suites read `ledger.html` and extract the shipped
functions — there is no second copy of the code to drift.
