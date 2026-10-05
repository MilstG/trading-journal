# Sixth-pass audit: the last beta round and a performance walk — October 5, 2026

> **Status: addressed.** Every finding below is fixed with a regression test, except the few
> listed under "Left as they are" with the reasoning. All unit suites (95), the size budget and
> the three browser suites (`e2e/run.mjs`, `e2e/sync.mjs`, `e2e/heavy.mjs`) green at the merged revision.

Scope: the whole product one last time before release, the way users will meet it, plus a fresh
review of everything merged since AUDIT-5 (PRs 110–115: the archive's token session and indexer,
spot as whole positions with its money in day rows, the exchange's curve on the equity chart, the
perp P&L audit).

Method: five passes in parallel.

- **Journal** (`/`) at 1366, 768 and 390 px, light and dark, on three real wallets: 20,370 fills,
  one past the exchange's 10,000-fill window, one spot-only, one with open positions and a Lighter
  account.
- **Daruma** (`/daruma`) on 390 and 360 px phones, from a first run through to an owner and a
  member using the social layer together, on real wallets; offline reload; the PWA bits.
- **Server, sync and admin**: a deploy per README-deploy, the admin panel at 1280 and 360 px, two
  browsers on one token, backups, restores, the analytics API, and bad input of every kind.
- **A review of the newest changes**, with repros on synthetic histories and the live exchange.
- **Performance**: cold loads, the live load path, interactions, idle cost and the server, at the
  sample size, ~18k and ~31k trades, and on a live wallet (see "Performance").

Live data came from Hyperliquid's own API, relayed from the browser through Node.
**[live]** = seen in the browser on real data, **[repro]** = reproduced by a script,
**[read]** = verified by reading the full code path.

---

## The two that lose data

**S1 · [repro] A server whose data goes backwards made every browser throw its newer journal away.**
Two ways README-deploy itself describes: restoring `DATA_DIR` from an off-site bundle, and a
redeploy without the volume. A browser kept its own copy only when the server's revision equalled
the one it last saw; any other revision was read as "another device saved since: take theirs". So a
server restored to revision 1 while a browser held revision 2 rolled that browser back, and an
empty server that a new device saved to first wiped every other device on its next focus check.
Repro: 6 notes synced, the server redeployed empty, one note written from a new device → the first
device ended with 1 note, locally and in storage.
Now the server's data file carries a random store id, the time of each version and the times of
its recent revisions, and returns them with the revision. A browser that sees another store, a
lower revision, or its own revision with another time knows the server's copy was replaced: it
merges (entries only it has are kept, the later edit wins where both have one), pushes the result
as a restore (so the server keeps a "before restore" copy) and says so in plain words. Ordinary
multi-device sync is unchanged: within one store revisions only go up and the id never changes.
A deliberate rollback is still History → restore, which wins (README-deploy says so).

**S2 · [repro] "Open existing" on a Backup-all file wiped newer notes without asking, then
overwrote the backup without its fill caches.** README told users to restore that way. The file
was applied wholesale and linked as the auto-saved data file; the first edit rewrote it from a
snapshot that holds no fill caches. A backup (a file with fill caches) now goes through the same
confirm-and-merge as pasting one and is never linked; a plain data file asks before it merges into
a journal with notes; and the app refuses to write over a file holding fill caches, including one
an older build had linked.

Also in this family, found while fixing J8: **Shift-click "full refetch" replaced the fill cache**,
dropping every cached fill older than the exchange's 10,000-fill window and every fill recovered
from the archive. It now merges, as the server's full refresh does.

## Spot counted twice (the change since AUDIT-5)

**R1 · [repro][live] Spot P&L counted twice, and spot day rows counted as trades, everywhere the
whole-position change (fb6acb1) didn't switch readers to trade rows and money rows.** A spot
position (listed, counted) and the day rows its sells realized (summed) are two populations of one
list; readers that took both added spot twice. On the test wallet the Spot 30-day strip read
−$7,503 over 3 trades for −$3,751 over 1; the Project basis "15 trades" for 6; the journal inbox
asked for day rows the table never lists, so they could never clear. Synthetic truth (a spot round
trip +$100, a perp trade +$50, today) read "TODAY +$250 · 3 closed trades". Worst of it: **the
daily loss limit fired at half the limit** on a spot loss. Every reader now goes through two
helpers (`closedMoney` for sums, curves and time windows; `closedTrade` for counts, lists, the
inbox, rules and playbooks): the tape, the pulse strip, the Review digest, the weekly review, the
projection, playbooks, monthly goals, guardrails, the habit miner, the excursion fetches, the
Diagnostic's capital model, `verifiedFigure`'s "closed fills", the inbox and streak, the tripwire,
Daruma's Stats, plan check and share list. **[R2]** The server's alerts and Telegram "today" read
every fill today the way the app's tripwire does (a −$300 partial spot sell read $0 against a $400
limit), and the weekly digest counts spot once.

**R3 · [repro] Spot dropped out of the weekday × hour heatmap and the calendar's trade counts**
(a spot view with three round trips read "$10.00 · 0 trades"). Both count trades now.

**R4 · [repro] Dust an exit left marked the next position on that coin PARTIAL**, with no entry and
no return %, as if held before the history. Dust read as flat at the exit is flat at the next entry.

**R5 · [repro] Notes on spot trades written before the change matched nothing.** Spot used to be a
trade per sell run (`…:<time>`, the still-held rest `…:<first buy>:held`); it is now the whole
position. Each old note, and any note on a day row the inbox offered, is laid once onto the
position whose span holds it (notes appended, tags joined); the old key stays for a device still on
the old build.

**R6 · [repro] Spot day rows were cut at the browser's midnight whatever the app's clock.** The
reconstruction worker always ran on local time. It takes the app's clock now, the cache key carries
it, and switching the clock rebuilds them.

**R7 · [repro] The reconstruction banner fired on whole fills whenever an open position had
unrealized P&L** — AUDIT-5 F1 back through a merge. The note and the Verified strip's Total add the
open book's unrealized again.

**R8 · [repro] The exchange's curve stood in for the equity chart and drawdown where it doesn't
apply**: one wallet's curve shown as the account's when another wallet's portfolio didn't answer
(AUDIT-5 F8), and under a dex filter, the spot view, or a view holding Lighter/CEX trades. Its
drawdown tip said "because the fills are missing exits; pick a period" when neither was true. The
curve is dropped in those cases and the tip rewritten (periods keep it, labelled, by design).

**R9 · [live] The audit's "before the first fill" paragraph fired on dates alone** (a curve flat at
zero for 17 points before the first fill) **and said the archive lacked fills it has.** It now
needs the curve to have moved, and points to "Recover from the archive…" unless the gap ends before
the archive begins.

**R10 · [repro] An index backfill failed outright for a busy wallet**: 200,000 fills in a day
overflowed the call stack (`push(...)`). **R11 · [read]** A backfill whose hour downloads all
failed ended "done"; one where some failed now ends "incomplete", all "failed". The panel loads
recovered fills once per job (it reloaded on every reopening, and never for "incomplete").

**R12 · [repro]** "✓ every position change has its fill" showed when nothing was checked (pasted
fills, sample data, Lighter/CEX-only).

## Journal

**J1 · [live] On desktop the stats cards spilled off the right edge** at every width from 900 to
~1900 px (the long "Hyperliquid's figure…" sub-lines held `1fr` tracks open). The chart grids had
the same overflow. All use `minmax(0,1fr)` now; the stats go to 2 columns under 1200 px; the
sub-line wraps to two lines. Checked at 360–1900 px: no sideways scroll.

**J3 · [live] On a phone the trade table's Net PnL was off-screen** on real data (a wallet pill
pushed it to x = 362 at 390 px; AUDIT-5 B6 only held on the sample). The side folds into the market
cell, dates are short, the date moves under the market on a phone; Net, return, R and the journal
column fit at 360, 390 and 768 px.

**J4 · [live] The "fill history truncated" warning vanished on the next load**, and "fills whole
since" ignored it: the flag lived only for the load that saw it. The truncation and the first
fill's time are kept in the fill cache; "whole since" is the latest of the last seam and those.

**J5 · [live] The Diagnostic called a −$9,758 account "profitable, not yet distinguishable from
noise — $59,911 net"** when the fills held 56% of its volume. When Hyperliquid's figure leads or the
window starts before the fills are whole, the verdict says it is about the fills on record and
names the gap.

**J6 · [live]** Project's "Sizing at this edge" used all history while saying it used the
projection's basis; it does now.

**J7 · [repro]** The help page scrolled sideways on a phone (590 px wide at 390).

**J8 · [live] A full refetch needed Shift-click** (impossible on a phone) and couldn't help the
10,000-fill window anyway. "Full refetch" is a button in the data-health strip and the tools menu;
a window truncation points to the archive. Wrong copy ("60-page cap", "Shift-click on Refresh")
gone.

**Lows:** an empty period with open positions still showed a wall of zeros, and a reversed date
range was accepted silently (it is swapped, and said) (J9); the coach kept asking for today's plan
after it was saved (J10); "1 trades" and four other plurals (J11); one address's Hyperliquid and
Lighter accounts listed twice under one label (J12); the planned-risk placeholder showed "default
200" under the avg-loss basis (J13); "Earned the right way" for a day whose one trade was
self-flagged FOMO — wording only, scoring unchanged (J14); equity axes printed "$-40,000",
minutes on a 1.5-year span, and overlapped the first label (J15); tab names in help, tags shown
unnormalized, raw `xyz:` ids in "net by coin" (J16).

## Daruma

**D1 · [live] "Ask mentor" sent the note to the mentor but never saved it to the trade.** The card
is saved first now (Share had the same loss and gets the same fix).

**D2 · [live]** One card showed −2.25% (the price move) beside a question saying −3.1% and a thread
saying −3.05%; all show the trade's return.

**D3 · [live] "Closed without a closing fill — likely a liquidation" named spot balances**, came back
on every open, and sat over the duel form's Send button. Spot reads "no longer in your wallet";
each is said once (remembered across opens); toasts sit at the top on a phone.

**D4 · [read] "% return" was shared by default** although README and the join pitch ("rankings that
count process, never profit") say otherwise. Off for new profiles; existing choices kept.

**D5 · [live] One member's 7-day Discipline read 85, 63 and 84** on three screens, and "this week"
meant two windows. One source (server-verified days where the member verifies, else reported) and
one window, labelled "last 7 trading days".

**D6–D8 · [live]** Challenge was offered to someone you already had a duel with, said "first duel
together", and only refused at the bottom; disabled XP-stake buttons looked enabled; the profile
kept "Ask to be partners" after you were partners.

**Lows:** a minus sign alone on its line (D9); tap targets of 11–20 px across 15 controls, now a
44 px hit area without moving the layout (D10); the note box cut off its own question and then
saved it into the note (D11); offline, nothing said the data was a last load and a sixth "Coach" tab
appeared (D12); an accepted duel not yet started sat under "Running" (D13); report-card slips
printed last week's count as if it were the change (D14); "Waiting for a mentor" above "Sent to
@alpha", "You mentor" (D15); a wallet with no history said so three times and couldn't be removed
from the first-run screen (D16); the Social header's gear alone on a third row at 360 px, 82–92
badge chips on a profile, a stray "·", the dial's "Last" line wrapping, "No largest 25% trades
this week" (D17).

## Server, admin and the API

**S3 · [repro] Back online, unsent edits waited up to two minutes**; focus didn't retry. `online`,
focus and visibility now retry at once (once every 3 s at most, never during a lockout).

**S4 · [repro] Admin → Levels & XP rewrote bad input and said "saved"**: "500, 100, 50" became
`[500]` and capped every member at level 2; tiers were clamped or dropped. Refused now with the
problem named, in the panel and by the server.

**S5 · [repro] A data folder that disappeared at runtime answered like a fresh install**
(`{rev:0, snapshot:null}`, which fed S1), errors showed absolute paths, and uploads failed until a
restart once the folder came back. 503 "data file missing" after a revision was served; no paths in
answers; folders recreated before a write. An unusable `DATA_DIR` stops boot with one line, not a
stack trace.

**Lows:** `/api/v1` ignored unknown filter values and impossible dates (`status=bogus` returned
everything, `2026-02-31` became March 3) — a 400 naming the allowed values now (S6);
`/api/v1/journal/__proto__` answered 200 (S7); HEAD got 404 everywhere GET got 200, so uptime
monitors saw the site down (S8); the Members empty state was cut off at 360 px (S9).

## Left as they are

- **"Verify to keep your perks" on the server owner's own profile** (D17). The server can't tell
  which member profile is the owner's without the browser sending the access token on the profile
  read, which this change doesn't do. AUDIT-5 S3 already judged the banner deliberate for members.
- **Periods keep the exchange's mark-to-market curve** on the equity chart, labelled, beside the
  realized line (R8): what fb6acb1 set out to do; only the cases where it misleads are gated.
- **The help page stays dark** under the Light appearance (J16): it is served with a no-script CSP,
  and reading the setting would mean loosening it.
- **The fill cache's truncation record is the browser's**; the server's cache and its seeding path
  don't carry it yet (J4).
- **A server restored on purpose to an older file** now gets the browsers' newer notes merged back
  over it (S1). Deleted entries come back; History → restore is the way to roll back.

## What held up

No uncaught errors or console errors in any pass. Every tab, filter, period, sort and export on the
journal; journal entries round-trip through a reload, the server and the phone; tax CSV, tax PDF
and tax-by-country agree to the cent; SAND's funding matched the exchange's `userFunding` exactly.
Daruma's first run, about 28 screens at 360 and 390 px without sideways scroll, the full social
round trip (follow, duel, partners, mentoring, kudos), the manifest and the offline reload. The
server under kill -9 mid-save (2,690 saves, nothing lost), 40 parallel saves (one 200, 39 × 409),
a 22 MB save, the 25 MB cap, path traversal, the token lockout and the read-only token's reach,
two-browser merges, export/import round trips, every admin tab at both widths. The LZ4 decoder
round-trips 600 fuzzed frames byte-exact and stops a 4.5 GB claim at its 64 MB cap; the archive
endpoints refuse anything but the full token and can't be pointed at another host.
