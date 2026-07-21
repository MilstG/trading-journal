# Ledger — Hyperliquid Trading Journal & Analytics

Ledger reconstructs your complete trading history from Hyperliquid fill data and
turns it into something you can actually learn from: a journal, a statistics
engine that knows the difference between edge and noise, a pattern miner with
proper multiple-comparison correction, and candle-based stop/exit analysis.

It is one HTML file. No build step, no framework, no account, no tracking. All
computation happens in your browser, talking directly to Hyperliquid's public
API. Open `ledger.html` from disk and it works; serve it with the included
companion server and your journal persists across devices and reboots.

---

## Table of contents

1. [Getting started](#getting-started)
2. [Loading your data](#loading-your-data)
3. [The Trades view](#the-trades-view)
4. [The journal](#the-journal)
5. [The Diagnostic view](#the-diagnostic-view)
6. [The pattern miner](#the-pattern-miner)
7. [Price excursions (MAE/MFE)](#price-excursions-maemfe)
8. [The Review view](#the-review-view)
9. [Filters, periods, and settings](#filters-periods-and-settings)
10. [Exports and backups](#exports-and-backups)
11. [Persistence: three modes](#persistence-three-modes)
12. [Deploying with the companion server](#deploying-with-the-companion-server)
13. [The analytics API](#the-analytics-api-apiv1)
14. [Concepts and definitions](#concepts-and-definitions)
15. [Limitations, stated honestly](#limitations-stated-honestly)
16. [Development and testing](#development-and-testing)

---

## Getting started

1. Open `ledger.html` in a modern browser (Chrome/Edge recommended — the
   optional link-a-data-file feature needs the File System Access API).
2. Paste a wallet address (0x…) and click **Add**. Add as many as you like;
   each can be labeled.
3. Click **Load all**. Ledger pages through your fill history, reconstructs
   trades, fetches funding history and open positions, and renders everything.
4. Explore the views in the top navigation: **Trades**, **Diagnostic**,
   **Review**, and **Project**.

Subsequent loads are incremental: fills are cached in your browser (IndexedDB)
and only new activity is fetched. **Shift-click Load all** to force a full
re-fetch if something looks off.

No wallet? **Paste data manually** accepts raw fill JSON (e.g. copied from an
API response) and runs the same reconstruction.

## Loading your data

**What gets fetched per wallet:** the full fill history (paginated), funding
payment history, open perp positions from the main clearinghouse, and — if your
fills reveal activity on HIP-3 builder-deployed DEXes — each of those
clearinghouses too (HIP-3 positions carry a purple `hip3` pill). Spot balances
come from spot state, and spot pair indices (`@210`-style) are resolved to
their real token names via the exchange registry.

**What reconstruction produces:** position-level trades with entry/exit
averages, peak size, duration, fees split by maker/taker, entry drift (how much
worse your average entry got as you scaled in), liquidation flags, and funding
attributed to the exact holding window. A fill that flips you long→short is
correctly split into a closing leg and an opening leg. Perp and spot are
reconstructed separately — use the **Perp / Spot / Combined** market toggle to
choose what every view shows.

## The Trades view

The main dashboard:

- **Header stats** — net PnL, win rate, profit factor, expectancy, fees, and
  more for the current market/period selection.
- **Charts** — equity curve, daily PnL, net PnL by hour / day-of-week / month /
  coin / side, a day×hour heatmap, and long-vs-short comparison. Hour and
  weekday charts respect the timezone toggle (local/UTC).
- **Open-book net exposure** — your current open positions and spot holdings
  with entry-based values. Dust remainders of mostly-sold spot bags are
  filtered out.
- **The trade table** — every reconstructed trade, sortable, paginated,
  filterable (see [Filters](#filters-periods-and-settings)). Click a row to
  expand it into the journal editor.

## The journal

Every trade row expands into a journal entry:

- **Tags** — freeform, autocompleted from your existing tags.
- **Setup** — what the trade was (breakout, fade, news…).
- **Rating** — 1–5 stars for execution quality, independent of outcome.
- **Mistake flags** — chased, oversized, no-stop, revenge, fomo, early-exit…
- **Planned risk ($)** — what 1R was for this trade. Powers R-multiples
  everywhere; if unset, a fallback 1R (configurable basis, see Settings) is used.
- **Notes** — free text.
- **Attachments** — paste or drop screenshots; stored in this browser.

Everything you journal becomes analytical fuel: tags, setups, ratings, and
mistake flags are all mined as pattern-miner families, and the Review view
tracks journaling completeness. Once you've run Price excursions, each trade's
expanded row also shows its MAE/MFE (with ≈ marking approximate measurements).

## The Diagnostic view

The statistician's view of your trading. Sections top to bottom:

- **Verdict** — a letter grade with plain-English reasoning: are you net
  profitable, is your Sharpe's lower confidence bound above zero (edge
  distinguishable from noise), and do you have enough trades to say so.
- **Statistical reliability** — Sharpe with CI, bootstrap CI on mean PnL,
  Monte-Carlo drawdown expectations (is your current drawdown normal for your
  strategy or a red flag), Wilson-interval win rate.
- **Equity & edge over time** — equity vs high-water mark, rolling 30-trade
  expectancy (continuous edge-decay view), and **PnL decomposition** — stacked
  monthly bars of price PnL vs funding vs fees, revealing whether a
  price-profitable strategy is quietly bleeding through costs.
- **Regime — when your edge changed** — permutation-tested change-point
  detection on your return series ("your edge shifted around March 14").
- **Result distribution** — histogram of outcomes in $, %, or R, with
  configurable binning and a breakeven threshold; win/loss shape, profit
  quality, best & worst.
- **Position sizing** — size-dependence test (do you trade worse when sized
  up?), R-multiple distribution, sizing calculator.
- **Execution & costs** — maker/taker split, fee drag over time, entry-drift
  quality, liquidations.
- **Behavioral states at entry** — your performance after 2+ losses, in the
  revenge window (quick re-entry after a loss), when overtraded on the day,
  etc., each tested for significance.
- **Edge breakdown** — a dimension selector (coin, hour, weekday, setup, tag…)
  showing exactly where your edge is and isn't, with reliability shading.
- **What if I stopped doing X** — pick any condition the miner knows about and
  deterministically replay your actual trade sequence *without* those trades:
  side-by-side net, expectancy, win rate, drawdown, and an
  actual-vs-counterfactual equity chart. This is what turns a miner finding
  into a dollar number. (Hindsight removal is the optimistic bound, and the
  panel says so.)
- **Drawdown recovery & streak depth**, **Risk & discipline**,
  **Recommendations**, and the two on-demand engines below.
- **Export report / Export PDF** (top right) — snapshot this entire view,
  including any miner/excursion results on screen, as a self-contained HTML
  file or a print-grade PDF with charts embedded as images. For archiving
  monthly reviews or handing to an accountant/backer.

An **$ / % basis toggle** switches the analytical basis between dollar PnL and
percent-of-notional return for the distribution, miner, and related panels.

## The pattern miner

**Run pattern miner + deep scan** mines your closed trades for conditions under
which you perform significantly differently. Families include: hour band,
weekday, session, coin, direction, hold-time bucket, size bucket, behavioral
state at entry, execution style (taker-heavy / maker-mostly), chased entries
(worst-quartile entry drift), journal tags / setups / mistakes / ratings, and —
once you've run excursions — excursion shape (deep/shallow adverse excursion,
"gave back a peak"). It tests singles and cross-family pairs (e.g. *taker-heavy
× after-2-losses*).

Significance is by permutation test with **Benjamini–Hochberg FDR correction at
10%**, split into **Validated patterns** (survived correction) and **Suggestive
only** (didn't — shown for honesty, not for action). Results are grouped into
"Repeat these — your edges" and "Avoid / fix these — your leaks," with
uplift estimates and bootstrap CIs.

Runs are **deterministic**: the RNG seeds from your exact data selection, so
the same trades always reproduce the same p-values (the seed is shown in the
footer). The scan runs in a background worker with live progress — the UI never
freezes. And the standing caveat is printed with every result: this is
correlational and in-sample; validated patterns are hypotheses to trade
deliberately and re-test, not guarantees.

## Price excursions (MAE/MFE)

**Fetch candles + compute excursions** measures, from exchange candles, how far
each trade ran *against* you (max adverse excursion) and *in your favor* (max
favorable excursion) between entry and exit. It answers two questions fill
history alone cannot:

- **Your stops — what winners endure:** typical winner pullback, the "90% of
  winners stayed within X% (Y R)" line, and typical loser drawdown. If stop
  room beyond X% protected almost nothing, you know where your stop belongs.
- **Your exits — profit kept vs given back:** typical winner peak, cents kept
  of every $1 of peak open profit, total dollars given back after the peak, and
  losers that peaked like winners before closing red (exit problems, not entry
  problems).

Results render as those two cards, a plain-English verdict, a scatter of every
trade (worst dip → final outcome, with a dashed line at the 90% winner
boundary), per-trade MAE/MFE lines in the journal, new miner families, and an
**open-position monitor** comparing each live position's drawdown-so-far
against your winner history — flagging any that are already
"beyond winner territory."

**Precision and the ratchet.** The exchange retains only ~5,000 recent candles
per interval (1m ≈ 3.5 days back, 15m ≈ 52 days). Older short trades therefore
can only be measured with coarse candles; those are marked ≈, excluded from the
statistics, and reported separately. But **measurements are saved permanently**
the moment they're taken: a trade measured while fine candles still existed
stays precise forever, re-runs load instantly from saved measurements, and the
approximate bucket only shrinks. Run excursions every week or two and precision
simply accumulates. Candles cache locally too (see **Clear candle cache** in
the toolbar — clearing candles never touches saved measurements).

## The Review view

A structured self-review: **This week** and **Highlights · last 30 days**
summaries, best & worst trades, journaling completeness (how much of your
recent activity is actually tagged/rated/noted), highest- and
lowest-probability conditions pulled from your data, actionable ideas, and
**Focus for next week** — a short list of concrete things your own numbers say
to do differently.

## The Project view

Forward visualization of your current performance — explicitly a *what-if*,
not a forecast. Pick a lookback window (30 days … all history) and a horizon
(1 month … 2 years); Ledger builds your calendar-daily net series (flat days
included) and bootstrap-resamples it forward 400 times with the same seeded
PRNG the miner uses, so results are reproducible for a given data selection.

You get:

- **Your current pace** — avg per calendar day, trades/week, win rate,
  expectancy per trade over the lookback.
- **If you keep this up** — straight-line per-week / per-month / per-year
  numbers off your average day.
- **Simulated horizon outcomes** — median, 25th/75th/95th percentile paths and
  the share of simulations that finish green.
- **Drawdown reality-check** — the honest companion to the fan chart: the max
  peak-to-trough dip *inside* each simulated path, reported as median / 1-in-4
  / 1-in-20 quantiles. The fan shows where paths end; this shows how ugly the
  ride gets on the way.
- **Sizing at this edge** — full-Kelly and quarter-Kelly risk fractions (and $
  at your live account value) from the same trades the projection is built on,
  with the usual "in-sample, edges drift" caveats attached.
- **Milestones** — the next round-number realized-PnL targets and roughly when
  the median simulated pace reaches them.
- A **fan chart** of possible cumulative-PnL paths (median line, middle-50%
  and middle-90% bands).
- A **resampling toggle**: i.i.d. daily (the classic bootstrap) or 5/7-day
  *block* bootstrap, which samples contiguous runs of days and so preserves
  your hot/cold streaks — bands typically widen, which is the more honest
  picture. Both modes are seeded and fully reproducible.

The page says it plainly: markets don't owe anyone their past distribution.
Treat it as positive visualization of staying the course, nothing more.

## Filters, periods, and settings

- **Market toggle:** Perp / Spot / Combined — applies to every view.
- **Period:** preset windows or a custom from/to date range.
- **Trade table filters:** coin, side, outcome, flag (liquidated…), rating,
  tag, wallet, free-text search, date range; one-click clear.
- **Timezone (⏱):** toggles all time-of-day and weekday analysis between local
  and UTC — one switch, applied everywhere consistently.
- **Theme:** two color schemes.
- **R basis:** what 1R means when a trade has no planned risk journaled —
  average loss, fixed $ amount, or other bases.
- **Breakeven threshold:** the ±$ band treated as "scratch" rather than
  win/loss in the distribution analysis.

## Exports and backups

| Button | What you get |
|---|---|
| **Export CSV** | The trade table as CSV. |
| **Tax CSV** | Clean 14-column, ISO-8601, CRLF file of realized results — importable into tax tooling. |
| **Tax PDF** | Bank-statement-style PDF for your accountant: cover summary per tax year, monthly subtotals, and every realized trade with a running balance and page footers. Generated entirely client-side by a built-in dependency-free PDF writer (base-14 Courier fonts) — nothing leaves your machine, and the strict CSP stays intact. |
| **Spot lots** | 8949-style lot-level CSV for spot: FIFO cost basis, one row per lot consumed by each sale — quantity, acquired/disposed dates, proceeds, basis, gain, short/long term. Sales of tokens that were transferred or airdropped in (no on-exchange purchase) are emitted at zero cost with an explicit `UNKNOWN BASIS` note for your accountant to resolve. Built from the locally cached fills. |
| **Export journal** | Journal entries as JSON. |
| **Backup all** | Everything portable in one JSON: journal, wallets, settings, saved MAE/MFE measurements, and per-wallet fill caches (which preserve history beyond the API's pagination cap — keep these). Restore via **Open existing** or by importing on another device. |
| **Export report** (Diagnostic) | Self-contained HTML snapshot of the entire Diagnostic view with charts as images. |
| **Export PDF** (Diagnostic) | Print-grade PDF sibling of the report: headline stats, every visible chart embedded as a JPEG image (the built-in PDF writer gained DCTDecode image XObjects for this), and the recommendations — opens anywhere, no browser needed. |
| **Clear candle cache** | Frees the (large) cached candles; saved measurements are kept. |

## Persistence: three modes

1. **Browser-only (default).** Everything lives in this browser's storage.
   Fine for a single machine; export backups periodically.
2. **Linked data file.** Bind your journal/wallets/settings to a real JSON
   file on disk (File System Access API); auto-saves on every change. Put the
   file in a cloud-synced folder for cross-device use.
3. **Server sync.** Serve the app with the companion server and everything
   important auto-saves to it (~1s after each edit) and loads on every visit —
   survives reboots and redeploys, works across devices. The status bar shows
   `☁ Server sync · rev N · saved`. Concurrent edits from two devices are
   revision-checked: a stale write is refused and that client loads the newer
   state instead of silently clobbering it.

In all modes, image attachments and the fill/candle caches stay in the browser
(large; re-fetchable or re-attachable). "Backup all" is the full portable copy.

## Deploying with the companion server

```
npm start        # serves ledger.html + persistence API on :8080
```

`server.js` has **zero npm dependencies**. Its core duties are unchanged: serve
the HTML and persist one JSON blob with atomic writes, a `.bak` of the previous
revision, and bearer-token auth. All in-app analytics remain in your browser.
It additionally exposes an optional **read-only analytics API** — see the next
section.

For **Railway** specifically, see [README-deploy.md](README-deploy.md). The two
things you must not skip: **attach a Volume at `/data`** (Railway's filesystem
is wiped on redeploy — no volume, no persistence) and **set `AUTH_TOKEN`**
(your journal contains wallet addresses and notes; don't leave the API open on
a public URL). The app asks for the token once per browser.

## The analytics API (`/api/v1`)

The companion server exposes a **read-only** HTTP API over your trading data,
for scripts, dashboards, or anything else that wants programmatic access. It
never writes user data: journal, wallets and settings can only change through
the app's own sync (`PUT /api/data`).

**The engine is the app itself.** At boot the server extracts the pure
functions (`reconstructTrades`, `computeStats`, `projectForward`,
`kellyFromTrades`, `openRiskModel`, `spotFifoLots`, …) from the very
`ledger.html` it serves and evaluates them in an isolated `node:vm` context —
the same single-source-of-truth trick the test harness uses. No math is
reimplemented; when the app's logic changes, the API's answers change with it
on the next deploy. If the served HTML predates a function the API needs,
analytics return `503` naming what's missing while the app and persistence run
untouched.

**Feeding it data.** The API computes from server-side caches
(`DATA_DIR/fills/`, `DATA_DIR/funding/`, `DATA_DIR/market.json`), populated by:

```
POST /api/v1/refresh          # body: {wallets?:[...], full?:true, force?:true}
```

which fetches fills (incrementally, same dedupe key as the app), funding,
positions (HIP-3 dexs included, derived from fills), spot balances and
portfolio PnL from Hyperliquid. Refreshes are mutexed and rate-limited to one
per 15 s unless `force`. Wallets default to the ones saved in the app.

**Endpoints.** `GET /api/v1` returns a machine-readable index of everything
below, including auth mode and filter docs.

| Endpoint | What it returns |
| --- | --- |
| `GET /api/v1/meta` | data revision, per-wallet cache freshness, engine status, trade counts |
| `GET /api/v1/trades` | filtered/sorted/paginated trades, journal-enriched, with per-trade R |
| `GET /api/v1/trades/:id` | one trade incl. fill events |
| `GET /api/v1/stats` | full `computeStats` output over the filtered set + the 1R basis used |
| `GET /api/v1/equity` | cumulative equity points, calendar daily series, current/underwater/shuffle drawdown |
| `GET /api/v1/calendar` | net PnL per calendar day (tz-aware) |
| `GET /api/v1/breakdown?by=` | grouped stats by `coin, dir, market, wallet, tag, dow, hour` |
| `GET /api/v1/projection` | Monte Carlo fan (`horizon, paths, block, seed, lookback`) — same deterministic seeding contract as the Project tab |
| `GET /api/v1/kelly` | Kelly sizing from the filtered closed set (`null` under 10 decisive trades) |
| `GET /api/v1/risk` | open-position risk model: liquidation distances, concentration, danger list |
| `GET /api/v1/positions` | cached positions/spot/account snapshot; `?live=1` refetches (full token) |
| `GET /api/v1/spot/lots` | FIFO 8949-style spot cost-basis lots |
| `GET /api/v1/whatif` | counterfactual replay removing trades matching `field/op/value` |
| `GET /api/v1/journal`, `/journal/:id`, `/tags` | read-only journal views |
| `GET /api/v1/export/trades.csv` | flat CSV of the filtered trades |

**Filters** (shared by trades/stats/equity/calendar/breakdown/projection/
kelly/whatif/export): `market=perp|spot|combined`, `wallet`, `coin` (matches
raw coin or resolved spot symbol), `dir`, `status=open|closed|all`,
`outcome=win|loss|be` (uses your saved break-even band), `tag`, `q` (notes
substring), `from`/`to` (ms epoch or ISO), `tz=utc|local`. Note `local` is the
*server's* timezone — API consumers should prefer `utc`. The 1R basis for R
multiples is pinned to the filtered closed set, mirroring the app's period
behavior.

**Access control.** Three layers, weakest wins nothing it shouldn't:

- `AUTH_TOKEN` — everything, unchanged.
- `READ_TOKEN` (optional) — may `GET /api/v1/*` and **nothing else**: it cannot
  read or write `/api/data`, trigger refreshes, fetch live positions, or touch
  attachments/snapshots. Safe to hand to a script or a friend's dashboard.
- `CORS_ORIGIN` (optional, exact origin) — lets a browser app on another
  origin call `/api/*`. Off by default.

```bash
# examples
curl -H "Authorization: Bearer $READ_TOKEN" 'https://your.app/api/v1/stats?market=perp'
curl -H "Authorization: Bearer $READ_TOKEN" 'https://your.app/api/v1/breakdown?by=tag'
curl -H "Authorization: Bearer $AUTH_TOKEN" -X POST 'https://your.app/api/v1/refresh'
curl -H "Authorization: Bearer $READ_TOKEN" -o trades.csv 'https://your.app/api/v1/export/trades.csv?status=closed'
```

## Concepts and definitions

- **Net PnL** = price PnL − fees ± funding, attributed per trade. Funding
  payments land on the trade whose holding window they fall inside.
- **R-multiple** — result divided by planned risk. Uses your journaled risk
  when present, otherwise the configurable 1R fallback.
- **Expectancy** — average net per trade; **rolling expectancy** = the same
  over a moving 30-trade window.
- **MAE / MFE** — max adverse / favorable excursion: the worst and best the
  price went during the trade, measured from your size-weighted entry over
  candle highs/lows.
- **FDR (Benjamini–Hochberg)** — when you test hundreds of patterns, some look
  significant by luck. FDR correction bounds the expected fraction of false
  discoveries among what's reported as validated (here: 10%).
- **Permutation test** — significance measured by shuffling reality: how often
  does a random relabeling of your own trades produce an effect this large?
- **Wilson interval** — a win-rate confidence interval that behaves sensibly
  at small sample sizes.
- **hip3 pill** — position/trade on a HIP-3 builder-deployed DEX rather than
  the main perp clearinghouse.
- **Open-position risk panel** (Dashboard, under the position strip) — the
  open book summarized as *risk* rather than a list: per-position distance to
  liquidation sorted nearest-first, net directional exposure by coin netted
  across wallets (HIP-3 dexs included), concentration, and a warning callout
  for anything within 10% of its liquidation price.

## Limitations, stated honestly

- The fills API paginates ~60 pages deep (~120k fills). Wallets beyond that
  can't be fully backfilled — existing local caches preserve older history, so
  keep backups. Caches are now gzip-compressed in IndexedDB
  (`CompressionStream`, ~5–10× smaller; plain-JSON fallback on old browsers,
  and backups always store the portable uncompressed shape).
- Spot FIFO lots are only as complete as the fill history: tokens transferred
  or airdropped in have no on-exchange purchase, so their sales are exported
  at zero cost with an explicit `UNKNOWN BASIS` flag rather than a guessed
  number.
- Candle retention caps how precisely *old, short* trades can be measured;
  such measurements are marked ≈ and excluded from excursion statistics rather
  than allowed to distort them. The ratchet makes this a shrinking problem.
- Excursions can't see intra-candle sequencing; values within one candle's
  range are approximate by nature. Excursion $ uses peak notional; MAE-so-far
  on an open position shifts if you scale in (it's measured from your current
  average entry).
- The miner is correlational and in-sample. "Validated" means it survived
  multiple-comparison correction on *your past data* — a hypothesis to trade
  deliberately and re-test, never a guarantee.
- Server sync is last-writer-wins with conflict detection (no silent
  clobbering), not field-level merge.
- Open-position monitoring compares against your full winner history; if you
  mix long-horizon spot bags with perp scalps in Combined view, that baseline
  comparison is apples-to-oranges — read those flags with judgment.

## Development and testing

```
npm test         # or: node tests/run-all.mjs
```

128 tests across five suites cover reconstruction (flips, funding windows,
spot/perp separation), the Web Worker dispatcher end-to-end with byte-parity
against the synchronous fallback, excursion math and the retention/ratchet
behavior, miner families and determinism, and the server over real HTTP (auth,
revision conflicts, restart survival). The suites extract functions **directly
from `ledger.html`**, so they test exactly what ships — there is no second copy
of the code to drift out of sync.

Architecture in one paragraph: everything is in `ledger.html` — UI, engine,
and a Web Worker built at runtime from a Blob of the page's own function
sources (single-file constraint, no separate worker script). Chart.js and fonts
are inlined; the CSP allows network access to `api.hyperliquid.xyz` and the
app's own origin only. Heavy compute (reconstruction, permutation mining) runs
in the worker with a synchronous fallback; fills and candles cache in
IndexedDB with incremental refresh.
