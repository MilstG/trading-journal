# Second-pass audit — September 20, 2026

> **Status: addressed.** Every finding below (R2-H1–H3, M1–M11, L1–L16) was fixed, the
> performance batch applied, and every suggested improvement/feature built, in the commits
> following this document on the same branch. The text is preserved as the audit record;
> line numbers refer to the revision that was audited.

Scope: adversarial review of the code added in the first fix/feature wave (client and
server), plus a fresh-eyes sweep of regions the first audit covered lightly (render
pipeline, PDF writers, Project tab, guardrails, filters). Three independent review passes;
every finding below was verified against the code, and the server capital findings were
reproduced live against a booted server with a mocked exchange. Line numbers refer to the
current files at this commit.

Baseline: all 311 tests green; no XSS in any of the new innerHTML sinks (checked one by
one); worker library dependencies for the new paths are complete; the round-1 fixes to
fill/funding pagination, the worker watchdog, the t-CDF, and the scenario/cluster math all
re-verified clean.

---

## High severity

### R2-H1. CSV import silently corrupts locale-formatted numbers — `ledger.html:5159`
`parseFloat` stops at the first comma: a quoted US-format price `"1,234.50"` imports as
`px=1`, and an EU decimal-comma `1234,56` as `1234`. Both pass the `px>0`/`sz>0` validity
gates, so a normal spreadsheet export (thousands separators, quoted per RFC-4180 — which
`csvParseRows` dutifully unwraps) produces a whole journal of wrong prices, sizes, and
derived PnL under a cheerful "N rows mapped" status. **Fix:** normalize numbers (strip
thousands separators; detect decimal-comma per column), and reject rather than accept when
a column's values are ambiguous.

### R2-H2. `/api/v1/capital` mixes all-wallet trades with saved-wallet flows — `server.js:1032-1050`
`ensureTrades()` unions saved wallets with every wallet that has a fill cache (covering
`body.wallets` refreshes, which do write ledger caches), but the flows loop iterates
`snapWallets()` only. Reproduced: refreshing a saved wallet ($10k deposit, +$99) plus a
non-saved one ($99k deposit, +$499) returns `realized=597` against `totIn=10000` — the
second wallet's profit is counted against a capital base missing its $99k deposit, so
roc/rocAnnual/maxDDpctCap are drastically wrong. Corollary: with only body-refreshed
wallets, the endpoint 409s "no capital-flow caches yet" even though the caches exist.
**Fix:** build the flows wallet set the same way `ensureTrades` builds its trade set (scan
`ledgerDir`).

### R2-H3. Stale derived state family: paste/remove-wallet leave capital flows (and friends) behind
- `loadFromPaste` (`ledger.html:5194`) resets positions/equity/hlPnl but not
  `ledFlows`/`ledSkipped` — paste a friend's fills or a CSV after loading your own wallet
  and the "Capital & true return" card computes a confident, entirely fictional return:
  your old deposits as the denominator, the pasted trades' PnL as the numerator.
- `removeWallet` (`ledger.html:5012`) filters trades/positions but not `ledFlows`, and
  never recomputes `accountValue`/`spotAccountValue` — the removed wallet's deposits and
  equity linger in the capital card until the next full load.
- `_riskClusters` (`ledger.html:2060`) is keyed by the coin set only, but the cached
  result embeds dollar exposures — after any 3-minute auto-refresh that changes sizes with
  the same coins held, the cluster lines show stale dollars indefinitely.

**Fix (one hook):** a `resetDerivedState()` called from `loadFromPaste`, `removeWallet`,
and backup-restore that clears/filters `ledFlows`, `ledSkipped`, `_riskClusters`,
`_shockPct`, and `_excCache`; and include position sizes (or `market.fetchedAt`-style
stamp) in the cluster cache key.

## Medium severity

### Client
- **M1. `_dirtyJ` set semantics can still lose an edit** (`ledger.html:802,820`): on PUT
  success, `sentDirty.forEach(id=>_dirtyJ.delete(id))` deletes an id that was re-edited
  while the PUT was in flight (same id, Set semantics). If the *next* PUT 409s, the newer
  edit is no longer treated as dirty and the other device's older entry wins — the exact
  loss the guard exists to prevent. **Fix:** `_dirtyJ` as `Map(id → edit counter)`; clear
  only entries whose counter is unchanged.
- **M2. 409 reverts local settings edits** (`ledger.html:806-817`): journal ids get the
  dirty-merge, but the server snapshot's settings are applied wholesale — the goal/rule/tz
  change that triggered the PUT silently bounces back on conflict.
- **M3. CSV header alias shadowing** (`ledger.html:5138,5146`): `ALIAS.side` includes
  `'type'` and mapping takes the *first* header matching any alias — a Binance-style
  `…,Type,Side,…` header maps side←Type; `sideOf('LIMIT')` nulls every row ("no row
  parsed cleanly" despite a perfect Side column), and a Type column with open/close values
  silently mis-signs positions. **Fix:** rank aliases by specificity; exact `side`
  /`direction` always beats loose matches.
- **M4. Leaderboard Sharpe is always "—"** (`ledger.html:5999`): reads `ss.sharpe`, but
  `sharpeStats` returns `{sr, srDaily, lo, hi, …}` — no `.sharpe` key. Every wallet/setup
  Sharpe in the Review leaderboard renders a dash. (Line 2486 uses `sh.sr` correctly.)
- **M5. Custom range + table date filters ignore the tz toggle** (`ledger.html:5242,4444`):
  `new Date(v+'T00:00:00')` is always local, while every other boundary honors
  `settings.tz` — with tz=UTC, range boundaries shift by the local offset relative to the
  calendar/day views built from the same dates. Also `fTo` uses `T23:59:59` (no `.999`)
  while `applyRange` uses `.999`.
- **M6. Benchmark chart async race** (`ledger.html:3267,4041-4084`): no stale-token guard
  (the miner has one); a Diagnostic re-render during the awaited candle fetch lets the old
  continuation draw on a detached canvas or destroy the newer run's chart. Intermittently
  blank benchmark after quick tab flips.
- **M7. Guardrail cooldown counts concurrent trades as "after a loss"**
  (`ledger.html:4336`): the close-ordered adjacent-pair gap check is also true for
  *negative* gaps (trades opened hours before the loss closed), so the tilt-leak
  expectancy in the banner is computed over the wrong set for anyone running concurrent
  positions. The Diagnostic's own `priorClose` does it right — reuse it.
- **M8. Pagination doesn't reset on side/outcome filter change** (`ledger.html:4470`):
  `_tblSig` omits `fSide` and `fOut`.

### Server
- **M9. Per-wallet capital keeps account-wide equity** (`server.js:1051`): `?wallet=`
  narrows flows and trades but `equityNow` stays the whole account — reproduced
  `impliedPnl ≈ −$89k` of fictitious loss for a wallet holding most of the deposits.
  Null out equity/impliedPnl (or fetch per-wallet equity) when `wallet=` is present.
- **M10. Zombie refresh can clobber a newer refresh** (`server.js:809-829`): the watchdog
  timeout releases the mutex without cancelling `doRefresh` and doesn't set
  `_lastRefreshAt`, so a retry starts immediately; the zombie's late cache writes then
  overwrite fresher data with stale bytes stamped fresh. Realistic on multi-wallet
  accounts against a slow API (page loops can genuinely exceed 5 minutes). **Fix:** a
  generation counter checked before every write; set `_lastRefreshAt` on timeout too.
- **M11. Refresh swallows invalid/oversized bodies** (`server.js:799`): malformed JSON or
  a too-large body becomes `{}` — a typo'd `{"wallets":[…],"full":true}` runs a default
  incremental refresh instead of erroring. Distinguish empty (fine) from unparseable
  (400) and oversized (413).

## Low severity

- **L1** `%zz` in `/api/v1/trades/:id` and `/journal/:id` → logged 500 instead of 400
  (`decodeURIComponent` throws inside the try) (`server.js:891,1152`).
- **L2** `_alertSent` grows forever (day-scoped keys never pruned); double-post window
  between overlapping `maybeAlert` calls (dedupe recorded only after the webhook await);
  `gatherAlertState` failures swallowed with no log (`server.js:659-671`).
- **L3** Digest header off by one: "Week ending <Monday>" describes the week ending
  Sunday (`server.js:697,724`); `computeStats(wk, wk)` passes closed as `allv`.
- **L4** `cacheSig` omits funding/ledger mtimes and wallet labels — the memo staying
  fresh relies on funding writes coinciding with fills writes; label renames serve stale
  labels until next refresh (`server.js:458`).
- **L5** `funding24h` (alerts) covers saved wallets only while `todayNet` covers all
  cached wallets — same asymmetry as R2-H2, smaller stakes (`server.js:645`).
- **L6** CSV formula guard misses the leading-whitespace bypass (`" =HYPERLINK(…)"`)
  (`server.js:183`).
- **L7** CSV import epoch heuristic: `"20260920"` parses as seconds → Aug 1970 and
  imports silently; microsecond stamps pass as ms (`ledger.html:5150`). Same-millisecond
  fills in a descending-order CSV are walked in reversed order by the average-cost
  derivation (`ledger.html:5169`). Imported fills hardcode `crossed:true`, fabricating a
  100%-taker signal for the maker/taker analytics (`ledger.html:5163`).
- **L8** `fetchLedgerUpdates` dedupe key omits amount/destination — two same-type,
  same-ms transfers with equal/empty hash collapse to one flow (`ledger.html:1024`).
- **L9** `maxDDpctCap` only evaluated at new *dollar* troughs, so a proportionally deeper
  drawdown against smaller capital is missed; the % and $ in the tooltip can come from
  different troughs (`ledger.html:1080`).
- **L10** Funding/ledger "interrupted" warnings are immediately overwritten by later
  status lines, and the page-cap exhaustion sets no flag at all — partial funding/capital
  data is invisible (`ledger.html:1011,1030`).
- **L11** Day-journal "recent days" loop steps by 86400000 ms with local-tz keys — DST
  transitions duplicate or skip a date chip (`ledger.html:4818`).
- **L12** Setup-scorecard badges mislabel all-negative setups ("fading… still positive"
  when both halves are negative; "improving" when discovery lost money)
  (`ledger.html:2861`).
- **L13** Between a close and the next ratchet pass, `_excM` briefly holds an open-window
  measurement under the closed trade's id — short mis-window for the miner's exc families
  (`ledger.html:3901`).
- **L14** Calendar heatmap intensity scaled by out-of-window days (one monster day a year
  ago washes out the visible 26 weeks) (`ledger.html:2174`); tape timestamps print local
  clock while day-bucketing tz-aware (`ledger.html:4668`).
- **L15** MiniPDF: `→` measured as one glyph but emitted as two (`textR` misalignment);
  the JPEG SOF scanner mis-steps on legal 0xFF fill bytes (latent — canvas JPEGs don't
  pad); tax-PDF summary tables lose column headers across page breaks
  (`ledger.html:5436-5603`).
- **L16** Projection "per calendar day" divides by first-trade-to-now rather than the
  lookback window (pauses inflate the pace 9× in the stated scenario), and the empty-
  lookback early-return drops the sizer (`ledger.html:1413,4862`).

## Performance (highest impact, measured against the code)

1. **Full dashboard re-render per keystroke**: `beThresh` and `riskDefault` are wired to
   `input` and call `render()` directly — 9 Chart.js destroy/rebuilds and ≥3 re-sorts of
   the trade set per keypress. Debounce + `change` is the cheapest big win
   (`ledger.html:5217`).
2. **No decimation on per-trade line charts**: equity, diag equity/HWM, and rolling
   expectancy build one point *and one `fmtDate` label string* per trade on category
   axes — at 20-30k trades, ~100k date formats per render. Min-max/LTTB bucketing to
   ~1-2k points preserves the drawn pixels exactly.
3. **`attributeFunding` is O(trades × funding rows) per coin** (`ledger.html:1244`): a
   2-year BTC account ≈ 35M row visits per wallet, re-run on every 3-minute auto-refresh
   (in the worker, so hidden but hot). A two-pointer sweep over close-ordered trades makes
   it O((T+F)·log F).
4. Diagnostic Monte Carlo (`bootstrapMeanCI`/`mcMaxDD`/`fwdMaxDD`, up to ~4k iterations)
   runs synchronously on the main thread on *every* diag render, including each journal
   save. Server-side, `readData()` full-parses the snapshot 2-3× per request — cache it
   on the data file's mtime.

## Suggested improvements & features (round 2)

1. **One `resetDerivedState()` hook** — fixes the whole staleness family (R2-H3) in one
   place and prevents the next feature from repeating it.
2. **Honest sync**: dirty-map with edit counters (M1) + re-apply local settings fields
   changed since last sync on 409 (M2).
3. **Refresh generation token** server-side (M10) and strict body validation (M11).
4. **Capital card v2**: fix the wallet set (R2-H2/M9), then add a per-type flow breakdown
   (deposits vs vault parks vs transfers) and a money-weighted return (XIRR) beside the
   time-weighted ROC — the signed dated flows + live equity are exactly XIRR's inputs.
   Overlay deposit/withdrawal markers on the equity chart.
5. **Data-health line** in the reconcile strip: persistent flags for truncated fills,
   partial funding/ledger fetches, and storage failures, instead of transient status
   messages that get overwritten (L10 + round-1's quota warning).
6. **CSV importer hardening**: number normalizer, alias specificity ranking, date-format
   rejection, descending same-ms ordering, and an honest `crossed:null` so maker/taker
   analytics skip imported fills.
7. **Tripwire counts open PnL**: the daily-loss banner uses realized net only — a trader
   deep underwater on open positions gets no warning until they close. `openPositions`
   uPnL is already live; fold it in as a second, clearly-labeled line.
8. **Calendar → day journal**: click a heatmap day to open that date's day-journal entry;
   scale heatmap color by the visible window (L14); make the window expandable.
9. **Perf batch**: debounced settings inputs, chart decimation, two-pointer
   `attributeFunding`, move diag Monte Carlo into the worker, mtime-cached `readData`.
10. **Ops polish**: boot-time scheduled run (Railway redeploys reset the interval, so the
    Monday digest can slip a full interval), digest label fix (L3), alert-dedupe
    hardening + failure logging (L2), `_alertSent` pruning.
