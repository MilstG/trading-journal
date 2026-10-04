# Fifth-pass audit: data accuracy and representation after the fill-history work — October 4, 2026

> **Status: addressed.** The findings F1–F9 and V1–V3 below landed in this change with regression
> tests in `tests/test-fill-gaps.mjs`; the rest are judgement calls left as they are, with the
> reasoning. All unit suites, the size budget and the 40 browser smoke tests (`e2e/run.mjs`) green.

Scope: everything the six "data side" changes touched (PRs 74–79: TWAP paging, seams and
off-record trades, the verified headline, Hyperliquid's curve for equity and drawdown, the
archive recovery) and every screen that reads trades downstream of them — stats cards, charts,
the tape, guardrails, the capital model, the trades table, Daruma's Stats tile, exports.

Method: the full code path read end to end, with the engine and loader functions extracted into
Node the way `tests/harness.mjs` does and run on synthetic fill histories. **[repro]** findings
were reproduced that way; **[read]** findings were verified by reading the full path.

---

## Fixed in this change

**F1 · [repro] The "verified figure takes over" test compared realized-only fills against an unrealized-inclusive number.**
`verifiedFigure` (`app/engine.js`) summed closed trades' net and set it against Hyperliquid's
all-time perp P&L, which is account-based and includes open positions' unrealized P&L and open
trades' partial realizations. Any wallet with more than max($2,500, 5%) of its P&L sitting in
open positions tripped the "material gap" rule with whole fills: the Net PnL card switched to
Hyperliquid's figure, the equity chart to Hyperliquid's weekly curve, max drawdown to that
curve's fall, the Volume card to the exchange's volume. The old reconstruction banner had the
same flaw, but it was a banner; after PR 78 it redrew half the dashboard. Now the gap is judged
against the fills plus open trades' realized and the open positions' and holdings' unrealized
(Hyperliquid wallets only), and the figure returns both bases (`rec` closed, `live` with the
open book).

**F2 · [read] A perp seam made the spot view lead with Hyperliquid's spot figure.**
With any seam, `verifiedFigure('spot')` returned the account's figure minus perps, so the spot
Net PnL card, curve and drawdown showed a number that includes unsold holdings' unrealized
P&L, airdrops and transferred tokens — none of which the spot fills ever had, and the seam
check is perp-only (spot balances move without fills). Spot now never leads with it; combined
and perp still do.

**F3 · [repro] A position opened off the record after the fills saw the coin go flat was not a seam.**
`reconstructTrades` only looked for seams on an open trade. A trade that closed on record,
followed by a fill whose `startPosition` is nonzero (the position was opened in fills the
exchange no longer serves), was filed as plain partial history with `gaps` 0. Coverage then
read whole, the data-health line stayed silent and the "Trade stats: partial" segment never
showed, even though fills were provably missing. It is now recorded as one seam on the new
trade (partial history, the exchange's `closedPnl` still counts). A history that merely starts
mid-position is still not a seam.

**F4 · [read] Off-record results leaked into places built "from every closed trade".**
Off-record trades (closed, part of their P&L gone with the missing fills) were out of the stats
but still counted in: the tape's "TODAY +$X · N closed trades" and chips; the guardrails'
sizing-creep and after-loss models; the Diagnostic's Capital & true return (realized, return on
capital, drawdown against capital); the load status line's trade counts. Each now leaves them
out, as the coach, progress and fee tier already did. The tax CSV keeps exporting them (the
realized part is real money) but its status line now says how many rows are incomplete.

**F5 · [read] A brand-new cache was marked as holding every TWAP slice even when the slice fetch was cut short.**
`loadWallet` (and the server's refresh) set `twapFull` to true whenever there was no cache, so
a first load whose by-time slice call failed over to the newest-2,000 fallback never went back
for the older slices: seams forever that one more load would have closed. `fetchAllFills` now
reports `twapPartial`, and a new cache is marked full only when the slices were.

**F6 · [read] Representation: off-record trades vanished from the trades table.**
They were filtered with the stats, so a TWAP-heavy wallet's history looked thinner than it was
and the notes attached to those trades were unreachable. The table now lists them with an
**INCOMPLETE** badge (and **PARTIAL** on trades whose entry was partly off the record), while
every statistic still leaves them out. Orphans stay hidden as before.

**F7 · [read] Representation: the Net PnL card led with an unrealized-inclusive figure beside an Unrealized card.**
The card's sub-line now says "unrealized incl." (journal card and Daruma's tile), so the two
cards are not read as additive.

## Charts, heatmaps and tables (second pass, rendered in Chromium on the sample data)

Every dashboard chart, both heatmaps, the Diagnostic's charts, the Review's, the Project fan and
the trades table were rendered at 1366 px (all time and a 30-day period) and read against the
numbers behind them. The figures agree across surfaces: the 30-day pulse strip, the Net PnL card
and the table count all said the same trades and the same net. No console errors on any tab.

**V1 · [repro] The month chart labelled bars "May 26", which reads as a day.** Now "May ’26".

**V2 · [repro] A trade whose every opening fill predates the history showed its exit price as its
entry.** The reconstruction stands the exit price in for the unknown entry (so P&L stays right)
and only the return % was blanked. The table's ENTRY column showed the stand-in with nothing to
say so, and the replay chart drew an "entry" line at the exit. The column now shows a dash with
the reason, the replay chart draws no entry line, and every partial-history trade carries a
**PARTIAL** badge whose tip says which part is missing (opened before the history, grown off the
record, or opened off the record).

**V3 · [read] The Diagnostic's "price vs funding vs fees" decomposition double-counted a spot buy's
token fee**, which is already inside the exchange's closedPnl basis, so its "net" footer could
differ from the trades' own net in the spot and combined views. The fee bar is now net of it.

Checked and left as is: the equity curve's deposit and withdrawal markers; the calendar's colour
scale over the visible weeks only; sessions pinned to UTC while the hour chart follows the clock
toggle (both say so); the R-multiple and win/loss distributions; the Diagnostic's equity-vs-high-
water, rolling expectancy, walk-forward and result-distribution charts; the Project fan's bands;
Daruma's daily bars. "Max drawdown · 154% of best cumulative profit" on a net-negative account is
arithmetically right (the fall exceeds the peak it fell from) and the tip explains the base; it
reads oddly but was not changed.

## Checked and left as is

- **Period and range views** fall back to the fill-based figures on every card and chart, as
  intended; `verifiedHeadline` gates on period, custom range and dex filter.
- **Daruma's Stats → All** reads the same `verifiedFigure` as the journal, per its market toggle.
- **TWAP paging** resumes at the boundary millisecond and dedupes by `tid-oid-time`; the
  fallback marks a full 2,000 as partial. Correct in the tests and by reading.
- **Seam detection tolerance** is relative (1e-6 of position) with a 1e-9 floor: safe for
  million-unit meme coins and sub-0.001 BTC alike. Same-millisecond groups are chained by
  `startPosition` before the check runs.
- **Archive merge** (`srvArchived`) keys fills the same way as every other merge; the browser
  cache records `archivedAt` so the server's copy is pulled once per backfill.
- **Multi-venue accounts**: Hyperliquid's curve and figure exclude Lighter/CEX trades by design
  and the caption says whose curve it is. Acceptable, noted here so it is not mistaken for a gap.
- **Hyperliquid's curve has roughly one point a week**, so the drawdown it gives can be
  shallower than the trade-by-trade one; the tip says so.

**F8 · [read] A wallet the exchange didn't answer for made the verified figure understate, and lead.**
With several wallets, `hlPnl` summed only the portfolio answers that arrived; a failed call for
one wallet left the others' sum as "Hyperliquid's figure", which then differed materially from
the fills and took over the card. `hlPnl.partial` now marks a load where a Hyperliquid wallet
got no portfolio answer: the figure never leads, the reconstruction banner stays quiet, and the
Verified strip says a wallet is missing.

**F9 · [live] TWAP slice fills are not in `userFills`, and the merge is now immune either way.**
Checked on 26 leaderboard wallets (4 with slices, 458–2,000 each): no slice matched an ordinary
fill by trade id or by content. `fetchAllFills` still keys a slice out when an ordinary fill with
the same coin, time, side, size, price and starting position is already there, so a change on the
exchange's side could never double-count an execution and read as a seam on every TWAP.

## Verified against the live exchange (October 4, 2026)

Picked 26 small, active wallets from Hyperliquid's leaderboard and pulled their whole history
(`userFillsByTime`, `userTwapSliceFillsByTime`, `userFunding`, `clearinghouseState`, `portfolio`).

- **`pnlHistory` is realized plus unrealized.** On every wallet with an open position, the
  portfolio endpoint's last perp P&L point matched closedPnl − fees + funding **+ unrealized**
  (within $1–$40 on most, within ~1.5% on the rest, mark prices moving); realized alone was off by
  exactly the unrealized. This is the basis of F1. Hyperdash reads the same endpoint, so the
  headline agrees with it by construction; its trader page is a JavaScript shell to a fetch, so
  its figures could not be read directly.
- **Fill notional equals the exchange's `vlm`** to within $70 on $20M–$104M, perps and spot
  alike, so the coverage share is exact where the fills are whole.
- **The curve is current and roughly weekly**: the last point was 0 minutes old on every wallet,
  45–104 points over 6–20 months.
- **TWAP slices**: see F9.
