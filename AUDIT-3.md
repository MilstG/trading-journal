# Third-pass audit & roadmap — September 24, 2026

> **Status: addressed.** Every fix (F1–F12) and improvement (I1–I4) below landed, and all
> ten roadmap features shipped in the same wave: the Telegram bot (delivery + read-only
> commands), fee-tier optimizer, weekly review wizard + lessons library, unplanned-trading
> guardrail, server-held backups, variance expectations, risk-creep detector, demo mode,
> tab-visible tripwire notifications, and `GET /api/v1/metrics`. 358 tests / 18 suites
> green at the merged revision.

Scope: adversarial review of the second fix/feature wave (the 10 commits it landed in),
plus a repo-hygiene sweep and a product-level roadmap now that two full audit cycles have
hardened the fundamentals. Findings were verified by reading each changed function in full
and, where marked, by directly executing the extracted functions. All 328 tests pass at
the reviewed revision.

---

## Fixes

### Medium

**F1. 409 settings merge: the baseline goes stale after a conflict is applied**
(`ledger.html:817-841`). `applySnapshot` overwrites settings with the remote values on a
409, but `_lastSyncedS` is only rebased on a *successful* PUT. When the conflict produces
no local merge (common — the PUT was triggered by a journal-free change), the baseline
keeps the pre-conflict values; on the *next* conflict the merge classifies server-origin
values as local edits and pushes them back, silently clobbering the other device's newer
edit. **Fix:** rebase `_lastSyncedS` after every 409 apply/merge, not only on PUT success.

**F2. All-in tripwire counts lifetime unrealized PnL against a daily limit**
(`ledger.html:6249-6254`). `uPnl` is unrealized-since-entry (for spot bags: cost basis,
possibly months old), so a long-held position down $2k against a $500 daily limit shows
"⛔ Daily loss limit hit including open positions" permanently, every day, with zero
trades — alarm fatigue that neuters the tripwire. **Fix:** intraday delta (open uPnL now
minus open uPnL at the first render after tz-midnight).

**F3. Server capital/alerts count ghost-wallet caches forever, against an equity that
excludes them** (`server.js:1095-1101`, `675-680`). The wallet union now includes every
file in `ledgerDir`/`fundingDir`, but caches are never evicted — one `body.wallets`
refresh for a non-saved wallet, or removing a wallet in the app, leaves its deposits,
trades, and funding counted forever, while `equityNow` reflects only the last refresh's
saved set, permanently skewing `impliedPnl` and `xirr`. **Fix:** evict caches for wallets
that leave the saved set (or a `DELETE /api/v1/cache/:addr`), and exclude non-saved cached
wallets from equity-based outputs.

### Low

- **F4.** `csvNum('(-5)')` returns **+5** — parens set the negative flag and the inner
  sign double-negates. Fee-rebate exports written as "(-0.25)" import sign-inverted.
  (Verified by execution.)
- **F5.** `dateBound(v, end)` adds a flat 24h−1ms, so on DST-transition days (local tz
  mode) the range end lands at 22:59 or 00:59 — a regression vs the old `'T23:59:59'`
  parse for two days a year. Use next-midnight−1 via `addDays`.
- **F6.** Removing a wallet leaves its data-health warnings up: `fillsTruncated` and
  `_fetchHealth` aren't filtered/reset by `removeWallet` or `resetDerivedState`.
- **F7.** XIRR silently vanishes at the extremes: a total-loss history (true answer −100%)
  and a >1000%/yr account both return null and the row disappears exactly when the number
  is most dramatic. Clamp and label ("<−99%", ">1000%/yr") instead. (Verified.)
- **F8.** `_dayJEditKey` is session-sticky: after a calendar click, the Review editor
  stays on that past date — tomorrow's plan and committed max loss typed there save to the
  old day and never arm the tripwire. Auto-reset when the tz-day rolls over.
- **F9.** Cosmetic: a superseded refresh logs `[object Object]` in per-wallet errors (the
  throw carries `.msg`, the logger reads `.message`).

### Repo hygiene

- **F10. No `.gitignore`.** A local `npm start` creates `data/ledger-data.json` — wallet
  addresses and journal notes — one careless `git add -A` away from being committed to a
  repo. Add `.gitignore` for `data/`, `node_modules/`, and editor droppings.
- **F11. No CI.** The repo has a 328-test suite and no workflow running it. A 10-line
  GitHub Actions workflow (`npm test` on push/PR, Node 18 + 22) makes every future change
  gated the way this branch's changes were.
- **F12. `README-deploy.md` is two waves stale.** The env-var table lacks `READ_TOKEN`,
  `CORS_ORIGIN`, `REFRESH_INTERVAL_MIN`, and the `ALERT_*` family; "How syncing behaves"
  still says "last writer wins", which the field-level merge has since replaced; the repo
  layout section doesn't mention the analytics API or automation.

## Improvements

- **I1.** Persist `_alertSent` (and the last digest state) under `DATA_DIR` so a redeploy
  doesn't re-fire recent alerts; retry a failed digest webhook on the next scheduled run.
- **I2.** First Diagnostic render on a huge account still blocks on the Monte-Carlo batch
  (memoization only helps re-renders) — move it into the existing worker as a follow-up.
- **I3.** Remove the HIP-3 coin-shape verification scaffolding (`hip3CoinShape`,
  `_hip3Seen`, `hip3shape:` IndexedDB keys) — round 1 identified it as one-shot
  instrumentation for a since-closed verification item; it still ships and prints
  status-bar notes.
- **I4.** The paste modal is doing four jobs (fills JSON, CSV, journal restore, full
  backup) behind one textarea — a file-picker row with an explicit type indicator would
  kill the residual "wrong branch" risk class for good.

## New features (roadmap, ranked)

1. **Telegram bot, two-way** — the webhook alerts are one-way. A zero-dependency
   long-poll loop (`TELEGRAM_BOT_TOKEN` + chat-id allowlist) answering `/today`, `/risk`,
   `/stats`, `/goals` from the server's caches turns the phone into a read-only terminal —
   and the alert channel gains acknowledgment ("got it, stepping away").
2. **Fee-tier optimizer** — Hyperliquid fees step by 14-day volume. The fills history
   knows your rolling volume: show current tier, distance to the next one, and what the
   last month's taker fees would have been one tier up / as maker — a concrete dollar
   answer to "does pushing for the next tier pay".
3. **Weekly review wizard + lessons library** — a guided flow on the Review tab (best
   trade, worst trade, "what would you repeat / change", keyed `week:YYYY-Www` on the
   existing journal plumbing), with every answer collected into a browsable lessons list —
   and one relevant lesson surfaced on load. The digest automates the numbers; this
   automates the *learning*.
4. **Unplanned-trading guardrail** — the day journal knows whether today has a plan; the
   tape knows whether you're trading. Trading with no plan filed gets a guardrail chip
   ("3 trades today, no plan — the review will ask why"). Cheap, and it closes the loop
   that makes the day journal a habit.
5. **Server-side backup retention** — "Backup all" is manual and browser-side. A
   `POST /api/backup` storing the last N full portable backups (fill caches included)
   under `DATA_DIR/backups/`, plus a one-click button — the fill history that can't be
   refetched past the API cap deserves more than one copy in IndexedDB.
6. **Variance expectations card** — from your win rate and trade frequency: "a 6-loss
   streak has a 78% chance of appearing somewhere in your next 200 trades; your worst
   plausible month at current sizing is −$X". Pure math the app already has (seeded MC),
   and the single best antidote to abandoning an edge mid-drawdown.
7. **Risk-creep detector** — rolling median notional vs equity trend: flags sizing that
   grows faster than capital (the classic post-win-streak failure), as a guardrail chip
   with the two trend lines.
8. **Demo mode** — a "load sample data" button generating a plausible synthetic fill
   history, so a new user (or a screenshot) sees every panel populated without pasting a
   wallet. The single biggest onboarding improvement available.
9. **Tab-visible tripwire notifications** — the browser Notification API (permission
   prompt, no push infrastructure): when the app is open in a background tab and the
   tripwire trips, the OS notification fires. The webhook covers the phone; this covers
   the desktop.
10. **`GET /api/v1/metrics`** — flat JSON (or Prometheus text) of the headline numbers
    (net, day PnL, open risk, drawdown, capital) for Grafana/Home-Assistant users; the
    READ_TOKEN scope already fits it.

Deliberately out (still): accounts/multi-user, frameworks, build steps, moving analytics
server-side, and trade *execution* of any kind — the journal observes; it never trades.
