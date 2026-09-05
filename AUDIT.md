# Code audit — September 2026

Scope: `ledger.html` (full app), `server.js`, test suites. All 257 tests pass at the
audited revision. Line numbers refer to the current files. Findings are ordered by
severity; each was verified against the actual code, not inferred.

The overall architecture is unusually strong for a single-file app: the
extract-functions-from-the-shipped-HTML trick keeps server, tests, and app on one
source of truth; writes are atomic with backups; the statistics engine is honest
(permutation tests, BH-FDR, seeded determinism, stated caveats). The findings below
are the gaps.

---

## High severity

### H1. Pasting `{"fills":[...]}` destroys the journal — `ledger.html:4672`
The paste-modal branch guard is `!Array.isArray(data) && typeof data==='object' && !data.coin`.
An object of the advertised import shape `{"fills":[...]}` has no `journal`/`wallets`/`settings`
key, so it falls through to `journal = data; await Store.set(J_KEY, journal)` — the entire
journal (notes, ratings, plans, risk) is overwritten with `{fills:[...]}`, persisted, and
pushed to server sync. The intended fallback `data.fills || []` at 4686 is unreachable for
plain objects. **Fix:** check `data.fills` first (route to `loadFromPaste`), before the
journal-restore branch.

### H2. `fetchFunding` doesn't paginate — `ledger.html:945`
One `userFunding` request with `startTime: 0`; Hyperliquid caps the response, so accounts
with more funding events than one page silently lose all older rows. `attributeFunding`
then computes `net = pnl − fees + funding` with funding partially missing — the headline
all-in numbers are wrong for exactly the heavy accounts the app targets, and the
`catch → []` at 948 makes a total outage indistinguishable from "no funding". **Fix:**
paginate like `fetchAllFills` (loop advancing `startTime`, same dedupe idiom), and surface
fetch failure instead of returning `[]`.

### H3. Stored XSS via `setStatus` innerHTML + unescaped identifiers — `ledger.html:1116`
`setStatus` assigns messages via `innerHTML`, and callers interpolate wallet labels
(`labelFor(w)` at 4443/4492) and HIP-3 dex names derived from fill `coin` strings (4491)
without `esc()`. Wallet labels and fills enter verbatim through `applySnapshot` (730) and
the paste modal, so a shared/imported backup with a label like `<img src=x onerror=…>`
executes script on next load — and the CSP's `script-src 'unsafe-inline'` offers no
backstop. **Fix:** make `setStatus` escape by default (take text, or `esc()` every
interpolated identifier at call sites).

### H4. Attachment images injected without validation — `ledger.html:4113, 4641`
`loadAttachments` injects `<img src="${src}">` with no check that entries are
`data:image/…` URLs, and `syncAttDown` stores whatever JSON array `/api/att/<key>`
returns. A compromised or hostile sync server gets HTML injection (`"><img onerror=…`);
the full-size viewer compounds it with `document.write` into an `about:blank` window that
shares the app's origin. The server validates on PUT (`server.js:1096`), but the client
must not trust the read path. **Fix:** validate `src.startsWith('data:image/')` before
render on the client, and set attachment `src` via DOM APIs, not string HTML.

---

## Medium severity

### M1. Backup restore via paste drops fill caches and MAE/MFE measurements — `ledger.html:4673`
`backupAll` exports `fillCaches` and `excRows` precisely because they preserve history
beyond the API's 60-page cap, and `applySnapshot` (735–740) can restore them — but the
paste-modal "full backup" branch applies journal/wallets/settings inline and never touches
`data.fillCaches`/`data.excRows`. Restoring a backup by pasting (the main in-app restore
path) silently loses old fill history and all persisted precise excursion measurements.

### M2. Fill-pagination boundary can permanently drop same-millisecond fills — `ledger.html:935`
After a full batch, the next page starts at `max(time)+1`; fills sharing the boundary
timestamp that didn't fit in the batch are skipped. The dedupe set already makes `+1`
unnecessary. The loss bakes into the incremental cache (`fcache.last+1` at 4449), so a
missed fill never returns without a Shift-click full refetch. **Fix:** resume at
`max(time)` and rely on dedupe.

### M3. Incremental fetch ignores the truncation signal — `ledger.html:4448`
On the cached path, `fr.truncated` is never checked. If >60 pages accrued since the last
load, the new fills are gapped, the watermark still advances, and the hole is permanent
and unreported. **Fix:** on `truncated` in incremental mode, warn and offer a full
refetch instead of merging.

### M4. Sync conflict (409) silently discards the local edit — `ledger.html:775`
On revision conflict the client applies the server snapshot wholesale; the journal
note/tag just typed on this device is replaced by the other device's state. With
whole-object `journal=data.journal` replacement there is no merge. **Fix (incremental):**
re-apply the just-edited trade's entry on top of the incoming snapshot before saving, or
merge journal per trade id with a `updatedAt` stamp per entry.

### M5. Trade CSV export reads `j.note`; the field is `j.notes` — `ledger.html:4698`
The `note` column of the trade CSV is always empty (journal uses `notes` everywhere else:
4060, 4134, 3977). One-character fix; the server-side CSV (`server.js:927`) gets it right.

### M6. Day/month bucketing uses three different clocks
The rule engine and daily-loss tripwire bucket by UTC day (`nfUtcDay` at 5142–5196) while
other day analytics honor `settings.tz`; a US-timezone trader's "daily loss limit" resets
at 4–5 pm local. `feeDragByMonth` (3843) and the monthly chart (1923) bucket months with
local `Date` methods while the adjacent monthly decomposition uses `tzParts` (2858) — two
monthly cards on the same page can disagree in UTC mode. Overtrading day-bucketing uses
raw `floor(closeTime/86400000)` (2572). **Fix:** route all day/month keys through one
tz-aware helper.

### M7. Cooldown-rule scoring binary-searches an unsorted array — `ledger.html:3169`
The array is sorted by `openTime` but searched by `closeTime`; with overlapping trades
(normal on perps) `closeTime` isn't monotone, so the search misattributes and misses
violations. It also only inspects the single nearest prior close, so a loss 5 minutes
ago is invisible if any win closed since. **Fix:** sort a copy by `closeTime`, and check
all closes inside the cooldown window.

### M8. IndexedDB writes report success on failure — `ledger.html:678, 4459`
`idbSet` resolves on `tx.onerror` and exceptions are swallowed; the fill cache — the thing
protecting history beyond the API cap — can silently fail to persist (e.g. quota), and the
next load quietly refetches only 60 pages. **Fix:** reject on error, surface quota
failures in the status bar, and call `navigator.storage.persist()` at startup.

### M9. Truncated candle fetch recorded as full coverage — `ledger.html:3199, 3325`
`fetchCandles` can return short (12-page cap / short-page break), but the caller merges
the entire requested range into `cache.ranges`. On the unchunked paths (benchmark,
per-trade candles), a partial response permanently poisons the per-coin candle cache —
the gap is never refetched and excursions over it are silently wrong. **Fix:** merge only
up to the last candle actually received.

---

## Low severity / robustness

- **L1** `excSummary` splits winners by `net>0` instead of the break-even band used
  everywhere else (`ledger.html:3242` vs `isWin` at 1144); scratch trades count as winners
  in stop/capture stats. `capture` also divides all-in net by pure-price MFE, so it can
  exceed 100¢.
- **L2** Mistake checkboxes and star ratings mutate the in-memory journal but only persist
  if "Save journal" is also clicked (`ledger.html:4643`); edits vanish on reload.
- **L3** `settings.pins` (pinned patterns forward-tracker) and `settings.attribBasis` are
  excluded from snapshot/backup/sync (`ledger.html:726, 731`), so pins — a deliberately
  long-horizon feature — are lost on any restore or device move.
- **L4** No worker-job timeout (`ledger.html:3112`): a hung (not crashed) miner worker
  leaves "Scanning…" forever. Add a watchdog + cancel.
- **L5** Server-snapshot metadata (`s.date`, `s.rev`) injected without `esc()`
  (`ledger.html:825`) — the one unescaped server-JSON sink outside attachments.
- **L6** `writeServer` has no in-flight guard (unlike `writeLinked`, `ledger.html:767` vs
  839): concurrent PUTs can interleave and regress `SRV.rev`, manufacturing spurious 409s
  (which, via M4, cost edits).
- **L7** State-analysis p-values use a normal CDF on a Welch statistic at n as low as 10
  (`ledger.html:2963`) — anti-conservative in the small-sample regime the FDR gate is
  meant to police; use a t-distribution.
- **L8** Dex-filter changes invalidate the miner cache but not the excursion cache
  (`ledger.html:4581` vs key at 3439) — stale excursion results can render for the wrong
  trade universe when lengths coincide.
- **L9** `autoRatchet` retries permanently unmeasurable trades on every 3-minute
  auto-refresh (`ledger.html:3619`) — persistent "attempted" marking would stop the churn.
- **L10** Miner cache key omits journal edits (`ledger.html:2899`): newly added
  tags/setups don't refresh mined patterns until trade count changes.
- **L11** Session labels ("Asia 21–05") are local-clock definitions but bucket by the tz
  toggle (`ledger.html:1932`) — mislabeled sessions in UTC mode for non-UTC users.
- **L12** `spotFifoLots` buy with base-token fee ≥ quantity yields a near-infinite unit
  cost (`ledger.html:1438`) — flag/skip instead of emitting absurd tax rows.
- **L13** Trades starting mid-history (truncated cache) fabricate `avgEntry` from the exit
  price (`ledger.html:1073`); PnL stays correct but `retPct`/`entryDrift` are wrong and
  nothing flags them.
- **L14** Object URLs from every export are never `revokeObjectURL`'d; export buttons and
  journal save are un-awaited async whose failures become unhandled rejections.
- **L15** Two divergent Kelly implementations (`ledger.html:3879` half-Kelly vs `1301`
  quarter-Kelly with autocorrelation haircut) show conflicting suggested risk on
  different tabs — unify on one function.
- **L16** `loadAll`'s `opts.auto` flag is accepted but never read (`ledger.html:4430`), so
  a background refresh while offline raises the same error banners every 3 minutes.
- **L17** Tape summary counts closed trades but labels them "fills" (`ledger.html:4188`).
- **L18** Complement-prune in `mineInsights` uses exact float equality on summed dollars
  (`ledger.html:1636`), so complementary pairs (weekend/weekday) can both consume result
  slots.
- **L19** Diagnostic-PDF chart aspect ratio distorts when the 300pt height cap engages
  (`ledger.html:4963`) — shrink width proportionally.

## Server (`server.js`)

- **S1** CSV formula injection: `csvCell` (line 178) quotes but doesn't neutralize
  leading `= + - @`; journal notes/tags flow into `/api/v1/export/trades.csv` and open as
  formulas in Excel/Sheets. Prefix-escape (`'`) cells starting with those characters.
  Same applies to the client-side CSV exports.
- **S2** No watchdog on refresh: if a Hyperliquid fetch hangs (browser-derived `hlPost`
  has retries but no overall timeout), `_refreshing` stays `true` and every future
  `/api/v1/refresh` returns 409 until restart. Wrap `doRefresh` in a timeout
  (e.g. `AbortSignal.timeout` passed through to fetch, or a 5-minute deadline).
- **S3** No rate limiting on auth: a public URL allows unlimited bearer-token guessing.
  The compare is timing-safe and a long random token is fine in practice, but a tiny
  per-IP failure delay would cost nothing.
- **S4** Attachments have a per-key cap (8 MB) but no total quota — unbounded disk growth
  on a small Railway volume.
- **S5** The shared `vm` context is mutated per request (`E.settings`, `E._oneR`) while
  `doRefresh` awaits network between `E.*` calls. Today this is safe only because the
  refresh path never reads the mutable knobs — a fragile invariant worth a comment or a
  per-request state object.
- **S6** `applyFilters` from/to compare `t.closeTime` even for open trades — filtering a
  date window excludes/includes open trades by their last-event time; document or use
  `openTime` for opens.
- **S7** Brace-matching extraction (`grabFn`) breaks if a target function ever contains an
  unbalanced brace inside a string/regex literal. Boot-time validation catches it
  (engine disables, 503s), which is the right failure mode — just noting the constraint
  belongs in a comment near the top of `ledger.html` so future edits don't trip it.

## Verified sound (worth knowing)

Permutation-test mechanics, add-one p-value smoothing, BH-FDR step-up, seeded PRNG
determinism (self-seeds from a data hash when unset), the worker crash path (rejects
in-flight promises and rebuilds), PDF byte-offset math (latin1-faithful writer), the
revision-checked sync protocol on the server side, atomic writes + `.bak` + rotating
snapshots, and the READ_TOKEN privilege separation are all correct as implemented.

---

# Suggested new features

Ordered roughly by (usefulness to a discretionary Hyperliquid trader) ÷ (build cost),
given what the codebase already has.

**1. Deposit/withdrawal ledger → true return on capital.** Hyperliquid exposes
`userNonFundingLedgerUpdates` (deposits, withdrawals, transfers). Fetch it alongside
fills and you unlock: real %-return equity curve (deposit-adjusted), max drawdown as a
percentage of capital actually at risk, and correct Kelly $ floors. The CSS already
carries a "deposit-adjusted" comment — the design anticipated this. This is the single
biggest analytical upgrade available: today all % figures are notional-based because the
app can't see capital.

**2. Server-side scheduled refresh + alerting.** The server already has
`POST /api/v1/refresh` and `openRiskModel`. Add a `REFRESH_CRON` env (a `setInterval` is
enough — zero deps) and an optional webhook URL (Telegram/Discord/ntfy) that fires on:
position within N% of liquidation, daily loss tripwire crossed, drawdown beyond the
Monte-Carlo p95 expectation, or funding bleed above a threshold. The phone-notification
half of a journal is the half that changes behavior *during* the session, and all the
detection math already exists.

**3. Day-level journal (pre-market plan / post-market review).** The journal is
per-trade only. A daily note keyed `YYYY-MM-DD` — plan, bias, max-loss commitment,
end-of-day review — with adherence checkboxes would complete the review loop the Review
tab already grades ("journaling completeness"). Cheap: it's one more keyspace in the
existing snapshot/sync plumbing, and the calendar heatmap is the natural surface.

**4. Real add-to-loser detection.** The rule engine proxies "no adds to losers" via
`entryDrift > 0`, but per-fill `events` arrays are already on every trade. Detect actual
adds while underwater (fill below avg entry on a long while unrealized PnL < 0), score
them as a first-class mistake family, and feed the miner. Data's already there.

**5. Setup scorecards over time.** The miner finds setups that work; a small "per-setup
equity curve + rolling expectancy" card (reusing the rolling-window machinery from edge
decay) would show whether each named setup is improving or rotting — the practical
follow-through on "trade deliberately and re-test" that the miner's caveat asks for.

**6. Generic fill-CSV import.** The paste path accepts Hyperliquid JSON only. A
column-mapping CSV importer (time, coin, side, px, sz, fee) would let people bring
history from other venues or exports into the same reconstruction engine — the single
biggest audience expander for the cost of one mapping UI, with everything downstream
unchanged.

**7. Correlation/cluster exposure.** The risk panel nets exposure per coin, but five alt
longs are one BTC-beta bet. With candles already cached, compute pairwise return
correlations of held coins and report *effective* concentration (cluster-netted
exposure). `riskConcentration` is the natural home.

**8. Scenario shock on the open book.** `openRiskModel` knows entries, sizes, and
liquidation prices. Add "mark everything −X% / +X%" → PnL impact, margin usage, and
which positions liquidate. Two dozen lines on top of existing data, and it turns the
risk panel from descriptive to predictive.

**9. Monthly goals vs actual.** Projection has milestones; Review has weekly focus. A
small "this month vs plan" card (target $, max acceptable DD, trades/week cap) closes
the loop between the projection math and daily behavior.

**10. Excursion re-run for open positions.** After a successful run, the excursion
engine won't re-measure until a trade closes or the period changes — so the open-position
"beyond winner territory" monitor goes stale while the position is still open. Add a
re-run affordance (or fold MAE-so-far updates into the 3-minute auto-refresh).

**11. Weekly digest export automation.** The Diagnostic HTML/PDF report exists; with
feature 2's scheduler, a weekly self-contained report written to `DATA_DIR/reports/` (or
posted to the webhook) makes the monthly-review habit automatic.

**12. Surface what's already built but hidden.** Quick wins: the benchmark
(you-vs-buy-and-hold) card only appears after candles exist — advertise it with an empty
state; `drawdownEpisodes` computes worst-episode depth that nothing renders; pasted spot
trades never resolve `@N` symbols because the paste path skips `fetchSpotMaps` — one call
fixes it.

Deliberately not suggested: accounts/multi-user, a build step, frameworks, or moving
analytics server-side — the single-file, client-first architecture is a feature and all
of the above fits inside it.
