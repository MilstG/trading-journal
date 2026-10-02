# Ledger — Hyperliquid Trading Journal & Analytics

Ledger reconstructs your complete trading history from Hyperliquid fill data and
turns it into something you can actually learn from: a journal, a statistics
engine that knows the difference between edge and noise, a pattern miner with
proper multiple-comparison correction, and candle-based stop/exit analysis.

It is one HTML page and its scripts in `app/`. No build step, no framework, no
account, no tracking. All computation happens in your browser, talking directly to
Hyperliquid's public API. Open `ledger.html` from disk (keep the `app/` folder next
to it) and it works; serve it with the included companion server and your journal
persists across devices and reboots.

---

## Table of contents

1. [Getting started](#getting-started)
2. [Loading your data](#loading-your-data)
3. [The Trades view](#the-trades-view)
4. [The journal](#the-journal)
4. [Keel: the simple view (`/keel`)](#keel-the-simple-view-keel)
4. [Social, unlocks and the admin panel](#social-unlocks-and-the-admin-panel)
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
   optional link-a-data-file feature needs the File System Access API). Copy or
   download it together with the `app/` folder beside it; the page loads its code
   from there.
2. Paste a wallet address (0x…) and click **Add**. Add as many as you like;
   each can be labeled.
3. Click **Load all**. Ledger pages through your fill history, reconstructs
   trades, fetches funding history and open positions, and renders everything.
4. Explore the views in the top navigation: **Trades**, **Diagnostic**,
   **Review**, and **Project**.

Subsequent loads are incremental: fills are cached in your browser (IndexedDB)
and only new activity is fetched. **Shift-click Load all** to force a full
re-fetch if something looks off. A persistent **data-health strip** under the
header flags anything incomplete — truncated fill history, partial funding or
capital-flow fetches, failing browser storage — for as long as it's true,
instead of a status message that scrolls away.

No wallet? **Paste data manually** accepts raw fill JSON (e.g. copied from an
API response) and runs the same reconstruction. It also accepts **CSV** — a
header row plus columns for time, symbol, side, price, and size, matched
against common aliases with exact names beating loose ones — so fills
exported from another venue or a hand-built spreadsheet feed the exact same
engine. Locale-formatted numbers ("1,234.50", "1.234,56") parse correctly and
ambiguous values are rejected rather than guessed; fee and realized-PnL
columns are used when present, otherwise position and PnL are derived by
average cost (exact when the file carries each coin's full history, and the
status line says when derivation was used). Imported fills carry no
maker/taker execution style, and the analytics count them in neither rather
than fabricating one.

Just looking? **Load sample data** (on the empty state and in the setup panel)
generates a seeded, deterministic five-month synthetic history — four perp
coins with a realistic fat left tail plus a spot position — and runs it through
the exact same import pipeline, so every panel is populated without pasting a
wallet. Nothing is fetched and nothing is saved; reload or add a real address
to clear it.

## Loading your data

**Exchanges.** Ledger reads four venues, and pools them into one journal:

| Venue | What you give it | How it's read | History |
|---|---|---|---|
| **Hyperliquid** | a 0x wallet address | its public API, from the browser | the latest 10,000 fills, then everything Ledger keeps |
| **Lighter** | the same kind of 0x address | its public API, from the browser | everything (paged back to the first trade) |
| **Bybit** | a **read-only** API key | signed in your browser, relayed by your server | 2 years |
| **Binance** (USD-M futures) | a **read-only** API key | signed in your browser, relayed by your server | 3 months, then everything Ledger keeps |

Paste an address in **Add** (or Keel's first screen) and Ledger checks both
Hyperliquid and Lighter for it, adding each one that has an account: no choice to
make, no file to export. A Lighter account's sub-accounts are each their own position
stream. Lighter reports each fill's prior position and entry cost, so its P&L is exact;
funding comes from Lighter's public hourly rates times the position you held (its
per-payment history needs a login), which matches Lighter's own funding totals.

For **Bybit or Binance**, use **Connect exchange** (Keel: *Connect a read-only API key*)
and paste an API key and secret. Ledger refuses a key that can trade, transfer or
withdraw. The secret never leaves your browser: it's kept in this browser's storage
(never in settings, sync, backups or the encrypted journal), each request is signed
there, and your server only passes the signed, seconds-long request on, because
neither exchange accepts calls from a web page directly. So each device connects the
key once, and the server must be reachable (see README-deploy, *Exchange APIs*, on
which regions the exchanges answer). Positions held from before the history begins
are worked out from today's position. Binance hedge-mode legs are separate trades;
Bybit's history doesn't say which hedge-mode side a fill was on, so those read as
one-way (the data-health strip says so). Binance BNB-paid fees are priced at today's
BNB price; fees in other coins aren't counted and are named.

Trades from other venues carry a small venue tag in the trade list. Price
excursions and replay use that exchange's own candles. The server's scheduled
refresh, alerts, digests, wallet claims and verified Discipline still read
Hyperliquid only.

**What gets fetched per wallet:** the full fill history (paginated), funding
payment history (paginated too — heavy accounts get complete funding, not one
capped page), the capital-flow ledger (deposits, withdrawals, vault and
cross-account transfers), open perp positions from the main clearinghouse,
and — if your fills reveal activity on HIP-3 builder-deployed DEXes — each of
those clearinghouses too (HIP-3 positions carry a purple `hip3` pill). Spot
balances come from spot state, and spot pair indices (`@210`-style) are
resolved to their real token names via the exchange registry.

**What reconstruction produces:** position-level trades with entry/exit
averages, peak size, duration, fees split by maker/taker, entry drift (how much
worse your average entry got as you scaled in), liquidation flags, and funding
attributed to the exact holding window. A fill that flips you long→short is
correctly split into a closing leg and an opening leg. Perp and spot are
reconstructed separately — use the **Perp / Spot / Combined** market toggle to
choose what every view shows.

**Spot trades.** A spot trade closes when you sell out; the dust a full exit
leaves behind (spot buy fees come out of the token you bought) counts as flat.
Selling part of a position realizes a closed trade for the amount sold, at the
position's average cost, and the rest stays open. Buy fees paid in the token are
priced in dollars, and since the exchange's realized P&L already includes them,
they're shown in fees but not subtracted twice. Spot trades read as pairs
(`HYPE/USDC`) so they never merge with the perp of the same name. Keel counts
every market for XP, streaks and Today; its Stats screens have their own
**All markets · Perps · Spot** switch.

**Load time.** Opening the app shows your saved data at once (trades rebuilt
from the cached fills and funding, positions as they were last time) while a
refresh runs behind it. Fills, funding and capital flows are each cached with a
watermark, so a refresh fetches only what's new; spot metadata and every
wallet's requests run in parallel (two wallets at a time). A new device on a
server with `AUTH_TOKEN` seeds its caches from the server's copy in one
download (`GET /api/v1/cache/<address>`). The page itself is served gzipped
with an ETag, and the installed app opens from its cached copy and updates in
the background.

**Layout.** The journal has a sidebar with its four sections (Dashboard, Review,
Diagnostic, Project), Wallets and Load all; on a phone the sections move to a
bottom tab bar. Review and Diagnostic are long, so a sticky bar of their
sections sits above them: tap one to jump there, and it follows along as you
scroll. It uses the same design as Keel and the admin panel (Inter, rounded cards),
in dark, light and the black-and-amber colorway.

**Install it on your phone.** Served over https, the journal (`/`) and Keel
(`/keel`) are two installable apps, each with its own manifest and icons
(PNG 192 and 512, a maskable 512 for Android's shapes, and a 180 home-screen icon
for iPhone). On Android and desktop Chrome, **Install app** (beside Wallets in the
journal, or the card on Keel's Today screen) opens the browser's install prompt.
On iPhone, tap **Share** in Safari, then **Add to Home Screen**; the same button and card
say so. Installed, both open full screen and start from their cached copy.

## The coach

Everything Ledger measures is also said in plain words. At the top of the
dashboard a **coach card** gives four lines, computed in the browser from your
own trades and journal:

- **Last session** — the last trading day's result and process score, read the
  way a coach would: "A good loss: you did your part and the market said no",
  or "Green for the wrong reasons — no plan before the first trade".
- **Today** — the single next action, in priority order: write today's plan if
  it's missing; answer the question about a trade that closed in the last 24
  hours; otherwise the top leak from your numbers, with one click to adopt it
  as a habit.
- **This week** — your focus habit and a dot per trading day (kept / missed).
- **Remember** — one of your own weekly lessons, matched to the focus habit
  when one mentions it.

Below it, **wins** — "5 good-process days in a row", "every planned stop
honored this week", "good loss on Tue", "you're breaking your rule far less
since you made it". Reinforcement, not only correction.

**Habits** (Review) are when-then plans — "When I close a losing trade, I wait
an hour before the next entry" — tracked day by day from your data: the
library covers planning, stops, journaling, the loss limit, cool-offs, two
strikes, not chasing a red day, size caps and trade caps, and you can write your
own (tracked by the day journal's "I followed the plan"). **One habit is this
week's focus**; the coach, the weekly review ("last week's focus: kept 4 of 5
days — keep it?") and the optional AI letter all follow it.

**After every trade, one question** chosen for what happened — held through
the stop, gave back a big gain, added to a loser, a clean winner — shown above
the notes and in the journal inbox, where a one-line answer saves to the notes.

**Progress (Review).** A game layer that rewards process, never profit or
activity:

- **XP and levels** — a trading day earns its process score (0–100) in XP,
  however many trades it had; +25 for each day the focus habit holds, +150 per
  completed weekly challenge, +50 per achievement. Levels by default start at
  200·n·(n−1) XP, titled Rookie → Legend (the tenth title stays from level 10 on);
  on a server, the owner can change the curve, the titles and every XP amount.
- **Discipline streak with shields** — consecutive trading days at process 70+;
  days without trades never break it. A finished perfect week (every trading
  day 70+, at least three) earns a shield (max two) that absorbs one miss.
- **Weekly challenge** — one target a week, picked from your biggest leak (or a
  core habit), graded day by day; "Pick another" swaps it.
- **Achievements** — thirteen, for moments that are hard in real trading:
  walked away at the limit, sat out after two losses, ten good losses, twenty
  stops honored in a row, a thirty-day journal, a perfect week, a rule kept for
  a month, challenges completed…
- **Personal bests** against your past self, and **discipline saved** — an
  estimate of what keeping your rules and avoid-habits has saved (trades you'd
  have taken at the old rate minus the ones you took, times what they averaged).
- **Monthly report card** and **Share this week** — PNG images with grades and
  process numbers but no dollar amounts, plus copyable text; with
  `TELEGRAM_SHARE_CHAT_ID` set on the server, "Send to partner" posts the text
  to an accountability partner or group.

The coach card shows your level and shields and the week's challenge.

**Coach mode switch.** All of this is optional. The settings panel (⚙) has a
**Coach mode** switch, and the coach card has a "hide coach" link. Off hides
everything added with the coach, habits and progress work: the coach card,
habits and the weekly focus, wins, progress (XP, streaks, challenges,
achievements, cards), the process score and the calendar's Process view, the
journal inbox, prep (and its pattern-miner conditions), rules
from findings (+ rule buttons, their rules-card section, the live warning chip),
the missing-stop chip, live-plan badges and rows, the replay chart's plan lines,
the question after each trade, the AI letter and the server's end-of-day nudge.
The Diagnostic's recommendations fall back to a plain list. Nothing is deleted:
switch it back on and everything returns as it was; the setting syncs across
devices and travels in backups.

**Coach's letter (optional AI).** With `COACH_AI=1` and an Anthropic or OpenAI API key on
the companion server, the weekly review gets a "Write my letter" button: the AI coach
writes a short plain-language note on the week (what went well, the one thing
to work on, tied to your focus habit). Only an aggregate summary is sent —
counts, averages, habit sentences, finding headlines and your own one-line
lessons — and the button shows exactly that summary before anything is sent.
No fills, wallet addresses, trade notes or screenshots leave the server.

## Keel: the simple view (`/keel`)

Open `https://your-server/keel` for a phone-first, gamified view of the same
data. It's useful with zero effort — everything on the Today screen is read from
your fills — and gets sharper the more you log.

- **Form** (0–100, 50 = your usual): your recent trading against your own earlier
  trading — average trade, win rate, and distance from your 30-day high. "Recent"
  is the last 7 days when they hold 5+ trades, else your last 5 trades.
- **Discipline** (0–100): the share of a day's trades with none of six slips, all
  read from fills — re-entering within 15 minutes of a loss, trading on after two
  losses in a row, sizing up right after a loss, adding to a losing position, more
  trades than your usual day, and holding a loser over 3× your usual winner hold.
  A loss here is a fixed "more than $1", so the server can verify the same score.
- **Load** (50 = your usual day, 100 = twice it): trades opened and size traded
  today against your median day. Set a trade cap or loss limit in Prep and
  Load also tracks them.
- **Bonus XP** for what you choose to log, never a penalty for skipping it:
  morning prep +10, plan before your first trade +15, trades journaled +15, stops
  written +10, loss limit respected +10, end-of-day review +15. A day's XP is its
  Discipline score plus that bonus, plus achievements, kept challenges and focus
  habits. The league owner can change every one of these numbers and the level
  curve (see the admin panel).

Five tabs: **Today**, **Stats** (P&L, win rate, average trade, profit factor,
fees, daily P&L, best and worst markets and hours; deeper insights unlock with
level. **See in-depth stats** opens the full picture for the same range: equity
curve and drawdown, results/risk/consistency figures, what each Discipline slip
cost against clean trades, plan vs execution, how trades land, P&L by hour and
weekday, fees and funding, and tables by market, side, position size, holding
time, month, market volatility and trend;
**How the scores work** spells out every formula), **Prep** (readiness, today's trade cap,
loss limit and plan) and **Progress** (level, XP, streak and shields, the
weekly challenge, badges, share cards). A quick journal screen rates and notes
unjournaled trades from the last 30 days — the ✎ count at the top of Today and Progress opens it. Each card there has a step-through
under its chart: one fill at a time, in plain words ("You added 0.5 at 64,210.
Holding 1.5, average 64,100. Open P&L +$30, banked +$0."), with the fill marked on
the chart; ← → work too. On a wide screen the tabs become a sidebar.

**Plan a trade.** The *Plan your next trade* card on Today opens a short form:
market, long or short, stop (required), target and entry (optional), and one line
on why. The plan waits in your journal (synced like any note) and attaches itself
to your next trade on that market and side that opens within 24 hours — the
trade's stop and target come from it, it counts as a plan written live, and the
line becomes the trade's setup if it has none. No trade in 24 hours and it
expires; old plans are cleared after 30 days. A trade that already has a plan
keeps it. Stats → **Your plans** shows the share of trades with a plan, how
often you followed it, and one sentence on what not following it cost
("Exiting early cost you about $120 over the last 30 days").

**Share my week.** On Progress (from the level share cards unlock at), **Share my
week** draws an image of the week on your clock (last week until this one has a
trading day): its Discipline average as a ring, clean days (70+) out of trading
days, the streak, level and XP gained, the duel record and the top badges (this
week's first, by tier). It has no dollar amounts and no P&L, on purpose; badges for
results are left off too. Choose 4:5 (1080×1350) or square (1080×1080), dark or
light, and whether level, duel record and badges show; then **Share…** (the phone's
share sheet, where the browser can share files), **Download**, or **Copy image**.
It's drawn on a canvas in the browser: nothing is sent anywhere. The model the card
draws from is `pzWeekCardModel` in `app/pulse-screens.js`.

**Your layout.** Every Keel screen (Today, Stats, Progress) has **Customize
this screen** at the bottom: show or hide each section, or reset to the default.
On Today you can also put the cards below the dials in your own order (the up and
down arrows next to each one); the top of the screen stays where it is.
Your choices sync with your settings. Today's default is lean: today's one thing
(the focus you set in last night's review), the dials, net / entries / risk
used, your session with today's rules as kept-or-broken chips, the one next
step (morning prep or review), what's due for XP this week, and the last seven
trading days; level and league standing and the full last-day card can be
switched on.

**Today, in depth.** Under the dials: the day in numbers (net, trades against
your cap, win rate, fees, open positions with unrealized P&L, risk used against
your loss limit), your level, today's XP, streak and league standing; **your
session** (today's P&L curve over your loss-limit line, each trade drawn from
entry to exit, slips circled, your plan time, stop time and "now" marked);
**your plan, live** (each structured rule kept, broken or not yet tested, with a
countdown to your stop time); open positions against your usual size and winner
hold time, flagged when there's no stop; **right now** (whether this hour is one
of your best or worst, minutes since your last loss and the re-entry window);
the last trading day's score and the lesson you wrote; the last seven trading
days; and what's coming up (challenge, habits due, leaks being plugged,
competitions ending).

**Plans the app can check.** Besides the free-text plan, Prep takes
structured rules that are checked against your fills at the end of the day:
which setups and markets you'll trade, a stop time, a maximum number of open
positions and "stop after two losses". Setups are picked from chips (your own
past tags, kept consistent), so **See in-depth stats** can break results down
**by setup** and **by your own execution rating**. Notes themselves are not
read by any model; only these structured fields are compared with results.

**Routines.** Keel detects how you trade from the last 90 days (scalper, day,
swing or position trader; you can override it, and the league owner can add
profiles of their own) and adapts the morning questions (after five days of
answers, the ones you keep giving show as one-tap **usuals** under each question,
plus your setups under the setup question) and the **end-of-day
review**: a rating, a few profile-specific questions, the lesson and tomorrow's
one thing. The review pays XP and feeds the report cards and the coach.

**Report cards.** Weekly and monthly, with a letter grade, habit-by-habit
results, the period's best and worst trade, slips and what they cost, and how
it compares with the previous period; shareable as an image.

**Building habits.** Progress shows a **leak map** (each recurring slip, what it
cost, and whether it's shrinking), a one-tap **plug this leak** loop that turns a leak
into a habit checked from your fills: three clean trading weeks in a row plug it
and earn a badge (only weeks you traded in count: a week traded without that slip
adds one, a week with the slip starts the count again, and a week with no trading
is skipped), **per-habit streaks** with
shields, **good moments** (the times you followed a rule that usually costs you)
and **saved you** estimates. Today shows **live nudges** when a trigger you
tend to slip after is happening right now (a fresh loss, a fast re-entry).

**Badges.** About 270 badges in 45 families (discipline, consistency,
journaling, risk, P&L, habits, social …), each with six tiers from Bronze to
Legend; new ones are revealed as you earn the earlier ones. Members can switch
on a public **badge page** at `/b/<name>` to share.

**Readiness from a wearable.** Prep can take readiness from **WHOOP** or
**Oura** (sign in once; the owner registers an app with each and sets its keys, see
the deploy guide) or from **Apple Health** through a personal link an iPhone
Shortcut posts the morning's HRV, resting heart rate and sleep to. WHOOP's recovery
and Oura's readiness are used as they are; for Apple Health readiness is HRV against
your own 30-day median (60%) and hours asleep against eight (40%). A day's wearable
score replaces the prep answers as its readiness (the answers still earn their
XP), so Stats' readiness-versus-discipline comparison shows which days your
discipline breaks. Days sync every 30 minutes while Keel is open and are stored
with your journal.

**Tilt meter and quiet mode.** A live reading (0–100) on Today of the triggers
that come before a blow-up: losses in a row (30 points at three), a loss in the
last 15 minutes (20), entries at 1.5× your usual size (15), four entries in an
hour or twice your usual day (15), three quarters of your risk budget used (10)
and low readiness from your prep (10). Profit plays no part. At 65 a new
loss or entry turns on **quiet mode**: a full-screen card that lists what pushed
the reading up, brings back the lesson you wrote about that slip, and offers a
15-minute break with a countdown (or "I'm calm"). One answer covers one episode.
Optionally the browser notifies you when it happens.

**Tilt alerts.** After each refresh that brings new fills for today, Keel checks
today's fills for five specific patterns and, when one shows up, puts a calm banner
at the top of Today that names it ("3 losses in 40 minutes. This is when revenge
trades happen. Step away for 15 minutes?"): a re-entry within 15 minutes of a loss,
3 losses within 45 minutes, a trade over 1.5× your usual size right after a loss,
more trades than your prep's max trades (or well past your usual day: over
1.5× its median, at least 3), and your loss limit 80% used or reached (the same
limit as the tripwire, which keeps its own notification: one, not two). Only what
happened in the last hour counts, and "today" is today on your clock. **Taking a
break** starts the same 15-minute break as quiet mode, with its countdown, and logs
it on the day (`breaks`, marked as from an alert); breaks never change Discipline.
**Dismiss** puts it away. Each pattern is said at most once a day, and never within
30 minutes of the last alert (`pzTiltAlerts` and `pzTiltAlertPick` in
`app/progress.js`). With notification permission, the alert also comes as a system
notification through the service worker, and while a session is live (a trade in
the last two hours) the refresh keeps running in a background tab so it can.
Settings → **Tilt alerts** turns them off. With Keel closed, members who share
verified Discipline get the same alerts as a push (pref kind `tilt`, on by default,
**Tilt alerts while Keel is closed** under Reminders): the server reads their public
fills every 5 minutes (four members a minute at most) and runs the same two
functions on their clock; the plan and loss-limit checks need the journal, so those
two are app-only. When Keel was open on one of their devices in the last 10
minutes, the app says it instead.

**Market conditions.** Each day is tagged from BTC's daily candles: *volatile*,
*normal* or *quiet* (the day's high–low range against the median of the 30 days
before) and *trending up/down*, *mixed* or *choppy* (the 7-day efficiency ratio:
net move over the sum of daily moves). In-depth stats breaks results down by
volatility and by trend and says so when you lose in one and make it back in
another ("You lose on volatile days … and make it back on normal days"); Today's
**Before you trade** shows today's conditions and how you do on days like it, with how you
usually do at this hour and how long since your last loss (a warning in the 15 minutes after
one). It shows during the hours you usually trade, or once you've traded today.

**Lessons library.** Each review's lesson line and its mistake answer become
lessons (you can add your own). They come back on Today after 1, 3, 7, 14, 30 and
60 days: "I still live by it" moves one to the next step, "I slipped on it"
restarts it tomorrow; one kept through all six is kept for good. Lessons are
tagged with the slip they're about (from their words or that day's slips), and
quiet mode shows the one that matches what's tilting you.

**Process goals.** Up to three at a time, on Progress: a month's Discipline
average (70/80/90, at least five trading days), weeks without one slip (2/4/8;
the clock restarts after one), a share of the month's trades journaled, a
number of days prepped in the month, or weeks inside your loss limit. Each shows a
progress ring and on-track / behind; reaching one earns the **Goal getter**
badge family.

**Trade charts.** Every card on the quick journal screen carries a candle chart
of the trade (the same cached candles as the excursion scan) with entry and exit
marked and your written stop and target drawn in.

**Fees and funding.** In-depth stats shows your maker share of volume, average
fee in basis points, fees against your result on price and funding paid, with
one line each when it matters — e.g. how much entering half your taker volume
with limit orders would have kept.

**AI coach.** With `COACH_AI=1`, a **Coach** tab lets members chat with Claude
about their trading, within a daily allowance (10 messages by default; the owner
sets a server-wide default, overrides it per member, and has a larger default for fully unlocked
members). The coach receives a summary of the member's numbers, habits and
leaks; trades and notes are added only when the member switches that on (and
the owner allows it). Wallet addresses are scrubbed. Messages aren't stored on
the server, only the daily count.

Keel is the same page (`ledger.html` and its `app/` scripts): it switches on its own path (or `?keel`
when opened from disk), so every loader, cache and sync path is shared. It
always shows the coach and progress layers, whatever the full app's coach-mode
switch says. It has its own install metadata (`/pulse.webmanifest`), so "Add to
Home Screen" from `/keel` installs a separate **Keel** app.

To make Keel the site's front page, set `HOME_VIEW=keel` on the server: `/` then
redirects to `/keel`, and the full journal is at `/ledger.html` (Keel's "full
journal" links, the admin panel and the installed journal app go there).

Keel used to be called Pulse. `/pulse` still opens it (the address bar then shows
`/keel`), and phones that installed Pulse update in place. Inside the code the old
name stays (`app/pulse*.js`, the `pz` prefix, the `X-Pulse-Key` header,
`DATA_DIR/pulse.db`, the icon files), so no stored data, key or install had to move.

**Sharing the link.** A visitor pastes their own public address (read-only: no
wallet connection, no signing) and their journal stays in their browser. On a
server with `AUTH_TOKEN` set, nothing they do is sent to your server; the owner
signs in once from Keel's settings to sync. Without `AUTH_TOKEN`, everyone who
opens the link shares one journal, so set it before sharing (Keel's settings
warn about this).

## Social, unlocks and the admin panel

Keel has a **Social** tab that runs entirely on your own server (`social.js`,
stored in an SQLite database, `DATA_DIR/pulse.db`, with uploaded pictures in
`DATA_DIR/media/`). There is no central service: the people you send your `/keel`
link to join *your* league. A server upgraded from an older version imports its
`social.json` on the first start and keeps the file as `social.json.migrated`.

- **Leagues.** New members join the main league by default: five tiers (Bronze → Diamond). Each ISO
  week, traders in a tier are ranked by the XP they earned that week; the top quarter
  (up to 5) move up and the bottom quarter move down, once at least four traders are
  in the tier. The owner can add more leagues, each ranked on its own metric (XP,
  verified discipline, streak, all-time XP, % return, $ P&L or return/drawdown),
  weekly or monthly, with or without tiers, listed or behind an invite code. Members
  can be in several at once, and find listed leagues under **Social → Find leagues**
  by name or number, with a page showing the rules and top five before joining.
- **Global leaderboards** (opt-in). Under Social → Boards, the same categories
  across every member regardless of league — only for members who switch on
  **Show me on the global boards**. Pick the category from **Ranked by**.
- **Leaderboards.** Weekly XP (your league), discipline (7-day average, minimum 3
  trading days, **verified**: the server recomputes each member's Discipline from
  their public fills with the app's own code, so it can't be typed in), streak, all-time XP, and — only for traders who opt in — return /
  drawdown, % return (dropped over 25% drawdown) and dollar P&L, all over 30 days.
- **Competitions** (listed under Social → League), created by the owner: *Discipline* (best average process score),
  *Survivor* (never hit your daily loss limit), *Journal streak*, and *Return under a
  drawdown cap*. Prizes are badges and bragging rights, never money.
- **Following and the feed.** Level-ups, streak milestones, badges, completed
  challenges and adopted habits post to the feed; others can give kudos, follow you,
  and adopt a habit you run with one tap. The feed pages back through everything
  (**Show older**).
- **Posts.** **Post a trade** (Social → Feed, your profile, or **Share** on a trade
  in the journal) shares one of three things: *a trade you took* (picked from your
  journal, with its chart attached as a picture), *a trade you're planning* (market,
  side, entry, stop, target, timeframe, setup), or *a note*. Each has a thesis and up
  to four pictures, which the app shrinks to WebP before uploading. A plan's levels
  are fixed once posted; afterwards you add what happened (took it, closed at a price,
  or didn't take it — or link the trade from your journal) and a line on how it went.
  Results show in R (from the stop) and %, and in dollars only if you share dollar
  P&L. Results are worked out once, when the exit is known, and never rewritten; R is
  capped at ±100. A trade gets an **On chain** mark only from a wallet the member
  *claimed* by signing: it needs a fill on the right side (a buy for a long's entry) in
  that market within a minute of when it opened and within 3% of the entry price, and
  for a closed trade the opposite side near the close and the exit, from the last 50
  days of fills. Changing the trade's times or exit checks it again; a plan can't be
  marked as taken before it was posted. Plans carry "A member's own plan, shared for
  accountability. Not advice." Posts take comments (the author gets a note in their
  inbox), kudos and reports; ten posts and 40 pictures a day per member (deleting
  doesn't give the slot back). The thesis and the update can each be changed for 15
  minutes after they're written.
- **Profile picture and bio.** Under **What you share**: a square picture (shrunk to
  256 px in the browser) and a bio of up to 160 characters, shown on your profile and
  next to your name across Social.
- **Moderation.** Members report a post or comment from its page; reports collect
  under **Feed & reports** in the admin panel, grouped, with **Remove** or **Keep**.
  The owner can also remove any post, clear a member's picture or bio, and switch
  off posts, planned-trade posts or pictures.
- **What you share.** Profile, process boards, feed and habits are on by default;
  % return, dollar P&L and the wallet address are off. The journal, notes and trades
  never leave the browser: only XP, level, streak, badges, habit sentences and each
  trading day's process score and flags are sent. The switches are grouped into
  Profile, Boards and Sensitive; claiming a wallet, devices, journal sync and leaving
  live one level down, under **What you share → Account**.

- **Your profile.** Taking part (duels, partners, mentors, leagues, competitions)
  starts with **Create your profile** under Social: a name, what you share, and which of
  the owner's default rankings to join (the leagues set to auto-join, each a switch, on by
  default). A profile without any league works: duels and partners don't need one.
- **Find people** (Social → Find people, `#people`). Everyone with a public profile, and
  every mentor, most recently active first: picture, level, bio, trading style, shared
  leagues and what they're open to. Search by name or bio; filter **Open to duels**,
  **Looking for a partner** (members who switch that on under What you share) or
  **Mentors**. Each card can challenge, ask to partner or ask to mentor. Never trades,
  P&L or wallets.
- **Accountability partners.** Up to three per member, by mutual request (Social →
  Feed, or from Find people). Partners see each other's streak, the last 14 days' Discipline scores and
  which slips happened — never trades, P&L or wallets — can send a nudge (one every
  six hours) and set a shared challenge for the week that the other can adopt as a
  habit. Today shows a slim row per partner.
- **Seasons.** The owner can give a league monthly or quarterly seasons. Its ranking
  then covers the season so far; when a season ends, the top three get a badge
  (🏆 🥈 🥉), a place in the league's **hall of fame** (on its info page) and a
  notification, and the next season starts from zero.
- **Mentors.** The owner marks members as mentors in the admin panel. Members who
  switch on **Let mentors see my days** (What you share → Profile) show up on the
  mentor's **Mentees** screen with each day's score, slips and the lesson they wrote
  that night, and the mentor can leave a note on any day. Notes arrive in the
  member's inbox (Today → New for you) and as a push notification. Members can ask a
  particular mentor from Find people or the mentor's profile (**Ask to mentor me**, once a
  day per mentor): it switches on Let mentors see my days after a yes, tells that mentor,
  and puts the member first on their Mentees screen with an "asked for you" tag.
- **Trade reviews.** A member who lets mentors in can send one trade to the league's
  mentors: **Ask mentor** on a Keel journal card, or **Ask my mentor to review this
  trade** under an expanded trade in the full journal. What goes is the shape of a trade
  post (market, side, open and close times, entry, exit, planned stop and target, %
  and R, a size range instead of the size) plus their note and the day's plan; the
  dollar result only with **Show dollar P&L** on (and it's hidden again if they switch
  that off). The server knows the trade by a hash of its id, never the id itself (it
  holds the wallet address). Mentors see it under **Trades to review** (Social →
  Reviews, `#reviews`), comment as often as they like and mark it **Reviewed ✓**; the
  member gets each comment in their inbox, replies in the thread (Keel `#tr/<id>`, or
  under the trade in the journal) and sees **Reviewed by @mentor**. Only the member
  and the server's mentors see a thread, and only while the member lets mentors in:
  switching that off, a suspension, or the owner standing a mentor down closes it at
  once. Admins read every thread for moderation, read-only (`GET
  /api/social/admin/reviews[/<id>]`, and in Keel under Reviews). Limits: 10 new trades a
  day, 60 comments an hour, 1,000 characters a comment, 200 comments a thread, the newest
  100 trades per member. The member can take a trade back (its thread goes with it);
  deleting a profile removes its trades and threads, and its comments on anyone else's.
  Stored in `pulse.db` (`reviews`, `review_comments`). Routes: `GET/POST /reviews`,
  `GET/DELETE /reviews/<id>`, `POST /reviews/<id>/comments`, `POST /reviews/<id>/reviewed`.
- **Reminders (web push).** In Keel's settings, **Remind me on this device** sends a
  morning prep reminder and, on days you traded and haven't reviewed, an evening
  review reminder, at times you pick on your own clock; partner nudges, mentor notes,
  season results and tilt alerts (see Tilt alerts above) come the same way. It's standard web push, encrypted end to end
  (RFC 8291) with the server's own keys — no third-party service. On iPhone it needs
  Keel added to the Home Screen.

**Trust model.** Process numbers are computed by each member's browser and are
self-reported. Money numbers are never taken from the browser: the server reads
them from Hyperliquid's public `portfolio` endpoint for the member's wallet, and only
when they opted in. Naming an address proves nothing; *claiming* it does (below).
Addresses stay hidden by default and the owner can remove anyone.

**Claiming a wallet.** Under Social → What you share → Account, **Claim with my wallet**
asks the browser wallet (MetaMask, Rabby, or a wallet app's built-in browser) to sign
a Sign-In with Ethereum message (EIP-4361). It's a signature, not a transaction: no
gas, nothing moves. The server writes the message and keeps it by a single-use nonce
for 10 minutes, then recovers the signer itself (`vendor/eth-sig.js`, the audited
noble libraries bundled in — nothing to install). A claimed wallet is locked to one
profile: nobody else can name it, anyone who had typed it loses it, others see a ✓,
and only another signature from that wallet moves it. The owner can switch on
**Only count claimed wallets**, after which verified Discipline, returns and return
competitions only use claimed wallets. Smart-contract wallets (which can't produce a
plain signature) and email-login wallets without an exportable key can't claim yet.

**Passkeys.** Under Account, a signed-in member can **Add a passkey on this
device**. After that, "Sign in with a passkey" works on any device where that
passkey is available: Face ID, a fingerprint or the device PIN, synced through
iCloud Keychain, Google Password Manager and the like. No code and no wallet
needed. The server checks everything the WebAuthn spec requires of a site
(`webauthn.js`, no dependencies): the ceremony, a single-use challenge, this
site's origin and RP ID, user presence, the signature (ES256, Ed25519 or
RS256), and a signature counter that never goes backwards. It stores only the
public key. Passkeys belong to one site: set `PUBLIC_ORIGIN` when self-hosting so
they're tied to your real address. A member can hold up to 10, and remove any of
them. Each sign-in issues a fresh device key, like the other sign-in methods.

**Wallet approval.** Under Admin → **Wallets** the owner can switch on **Wallets need
my approval**. From then on, a member's wallet counts for returns, verified Discipline
and return competitions only after the owner approves its address. Until then the
server doesn't read it on chain at all. Members can still join and use Keel, and are
told their wallet is waiting (or wasn't accepted). Decisions are stored per address, so
a rejected wallet stays rejected under a new profile. Wallets the owner attaches to a
member count as approved, and switching approval on approves the wallets already in
use, so nobody's numbers disappear (each stays reviewable). The Wallets tab lists
waiting wallets first, shows whether the member joined with your invite code, and takes
single or bulk approve/reject decisions with an optional note (e.g. "paid"). It is the
manual base for automatic rules like "approve wallets that joined with my code" or
"approve paying subscribers".

In the Members list and on each member's page, approving is **Verify** and rejecting
is **Unverify**, one click each. An **unverified** wallet never counts, whether
approval is switched on or off. With approval off, a wallet you haven't reviewed
still counts as before.
**Mapping wallets to members.** On a member's page (Wallets card), or under Admin →
**Wallets** (a row nobody uses, or the *Map a wallet to a member* card), an admin can
map any address to a member. A wallet belongs to one member: one that is mapped, claimed
by signature or someone else's main wallet is refused until it's freed there, and
members can't take a mapped wallet as their own or join with it. Mapping a wallet
approves it. A member with no wallet gets the mapped one as their main wallet; **Make main**
switches it later (the old main stays mapped). The AI coach allowance counts across every
wallet a member has. A signature still wins: claiming a mapped wallet moves it to the claimer.
The sign-in message names the site it's for. When self-hosting, set `PUBLIC_ORIGIN` to
your Keel address so the server only writes messages for that site and a look-alike
page can't collect a usable signature (on Railway the edge already guarantees the
address, custom domains included).

**Your profile on every device.** Each device holds its own random key (only hashes
are stored; up to 10 per member). A new device signs in with the claimed wallet, or
with a one-time 10-character code from a signed-in device (**Add a device**; single
use, 10 minutes) — the way in for a phone without a wallet app. **Sign out other
devices** revokes every key but the current one.

**Encrypted journal sync.** Members can turn on **Your journal on every device**
with a sync passphrase. The browser stretches it (PBKDF2-SHA-256, 310,000 rounds) into
an AES-256-GCM key and encrypts the journal, wallets and settings before sending;
the server stores only ciphertext (`DATA_DIR/vault/`, 6 MB per member, 1 GB in all),
with a revision number so a stale write gets the newer copy back to merge — edits
made on this device since its last sync win per journal entry. There is no reset:
lose the passphrase and the synced copy can't be opened. The key is kept in the
browser so you don't retype it; **Stop syncing on this device** forgets it. The owner
already syncs the whole journal with `AUTH_TOKEN`, so this is for members only, and
the owner can switch it off.

**Unlocks.** Keel features unlock with level — by default deeper Stats insights at level 2, share
cards at 3 and joining competitions at 4. XP only comes from process, so unlocking rewards good habits. The owner can
map every feature (insights, in-depth stats, share cards, competitions, AI coach,
end-of-day review, report cards) to a level, switch unlocks off, or **fully unlock**
chosen members. Sample data shows everything. The full journal at `/` is never locked.

**Admins.** You can share the panel without sharing your access token. Members →
**Add admin**, type a name, and send them the link it shows (good for 7 days): opening it
signs them in to the panel, and to Keel, with their own profile. An existing member becomes
an admin by ticking **Admin** under Access on their page. Admins can do everything in the
panel except add or remove admins or change another admin's profile; their key never
opens your journal, backups or the server's other routes. Removing or suspending an admin
closes the panel to them at once. The Admins card lists who did what recently, and
wallet decisions record who made them.

**Two-factor for the admin panel.** Optional, per person: under **Settings → Security**
the owner and each admin can add **admin passkeys** (Face ID, a fingerprint, the device
PIN or a security key) and an **authenticator app** (RFC 6238 codes: scan the QR code, or
type the key shown under it). The first one switches two-factor on for that person and
comes with **ten one-time recovery codes**, shown once (stored hashed; **Make new codes**
replaces them). From then on the panel needs the token or admin sign-in **plus** a second
step: on the sign-in screen it asks for a passkey, a code from the app or a recovery code,
and keeps that browser signed in for 12 hours (an `HttpOnly`, `SameSite=Strict` cookie,
`Secure` over https, sent only to `/api/social/admin/`; it opens nothing without the
token or key, and **Sign out** ends it). A session that runs out while the panel is open
asks again in a dialog and carries on. Admin passkeys are separate from Keel passkeys:
they never sign anyone in to Keel. The Security card also shows the owner which admins
have two-factor, a switch to **require it of every admin** (those without it are asked to
set it up the next time they open the panel), and **Reset** for an admin who lost their
factors. Wrong codes are rate-limited: five for one person within 10 minutes lock codes
for that person for `AUTH_LOCK_MIN` minutes (twice as long on each lock in a row; a
passkey still works meanwhile), and each wrong code or failed passkey also counts toward
the address lockout (`AUTH_FAIL_MAX`). Two-factor only ever guards the admin panel's API,
`/api/social/admin/*`: the access token keeps working alone for `/api/v1`, `/api/data`,
backups, the full journal and scripts. Set `ADMIN_2FA` on the server:

- `optional` (the default) — each person chooses, as above.
- `required` — the owner and every admin need it. Someone with nothing set up yet gets
  the setup screen right after signing in, and the panel opens once they've added a
  passkey or an app. While it's required, nobody can remove their last factor.
- `off` — never asked for; anything already set up is kept for when it's back on.

**Lost every factor?** On the server, run `node server.js --reset-admin-2fa` (same
`DATA_DIR`), or set `ADMIN_2FA_RESET=1` and restart (on Railway: add the variable, let it
redeploy, then delete the variable). Either clears **the owner's** factors and ends every
admin session; admins keep theirs (reset an admin's from the Security card). A given
`ADMIN_2FA_RESET` value resets only once, so leaving it set doesn't keep wiping it; use a
new value (`2`, …) to reset again. Everything lives in `DATA_DIR/admin-2fa.json` (mode
`0600`): passkey public keys, authenticator-app secrets, and hashes of the recovery codes
and sessions. If that file can't be read, the admin panel answers 503 instead of
dropping everyone's second factor, until it's fixed or reset.

**Admin panel (`/admin`).** Sign in with `AUTH_TOKEN` (the owner) or as an admin. The
sections sit in a sidebar, grouped (People, Compete, Progress, Coaching, Community),
with counts for open reports and wallets waiting for you; on a phone they fold into a
menu under the top bar. Each page opens with its title, what it's for and its main
action. Sections:

- **Overview** — members, activity, duels, competitions, peer groups, posts and coach
  use at a glance; **Needs your attention** (reports, wallets waiting, a closed league,
  server settings to fix); top XP, tiers and recent admin activity.
- **Members** — search and filter; **add a member** (you get a 7-day sign-in code and a
  `/keel#link=CODE` link to send them); per member: rename, set or clear the wallet
  (unless claimed), **map more wallets** to them by hand (or make one their main wallet,
  the one their numbers are read from), **boost XP** (or correct it) with a reason they see, fully unlock,
  their coach allowance, leagues and tiers, award or take back reward badges, a new
  sign-in code, suspend or delete. Members' addresses are visible to you; others see them only if the member chose to show theirs.
  - **Several at once:** tick members, or everyone on the page, then **Verify
    wallets**, **Unverify wallets**, **Suspend**, **Restore** or **Delete**.
    Deleting 5 or more asks you to type DELETE. Admins can't act on other admins
    (only the owner can) or on themselves, and anyone skipped is listed with the
    reason.
  - **More filters:** wallet unverified, wallet waiting for you, and no wallet.
- **Duels** — on/off, which kinds are allowed, the winner's XP and the limits,
  the ladder (on/off, K, duels to be listed) and group duels (on/off, most
  people), the ladder season's top 10, every duel and group duel running or
  waiting (with cancel) and recent results.
- **Insights** — the whole league at once, or any segment of it. Filter by style,
  trade size, experience and activity (the "Traders like you" ranges), league,
  level, month joined, verified, and when last seen. For whatever is in view:
  - **Headline medians:** Discipline over 30 days, days journaled, win rate,
    profit factor and 30-day return.
  - **From joining to active:** joined → wallet → synced → traded → journaled →
    seen in 30 / 7 days → verified.
  - **Week by week:** Discipline, members trading and days journaled for the last
    8 weeks, plus the slips that happen most.
  - **How members spread** on any measure (a histogram with deciles).
  - **Segments:** a table split by any dimension (click one to look at it), and
    retention by month joined.
  - **Members:** a sortable list, including **"Slipping"** (Discipline down 10 or
    more on the 30 days before).

  A segment with fewer than 5 members shows its size only.
- **Each member's page** has a **Performance** card:
  - Their segment, a bar per trading day of Discipline, and the trend against the
    30 days before.
  - Days journaled and reviewed, win rate, profit factor, average win ÷ loss,
    fees, revenge entries, trades a week, typical hold, 30-day return and
    drawdown, streak and XP.
  - For each measure: where they stand in the league, and among traders like them
    (estimated from their peer group's deciles).
  - Their most common slips, and the habits they're working on.

  Members are told in Profile & privacy that the owner and admins can see their
  stats. Members who switch off "Traders like you" keep their win rate, profit
  factor and fees hidden from you too.
- **Benchmarks** — "Traders like you": contributors, peer groups and settings
  (smallest group, when to split groups, whether seed wallets count), a rebuild
  button, and **seed wallets**: paste any text and every 0x address in it is
  queued, read from its public fills in the background, and counted; re-analyze
  them all, or one, at any time.
- **Leagues** — create, edit and delete leagues (metric, period, tiers, listed,
  invite code, auto-join), and add or remove members.
- **Competitions** — create them for everyone or one league; delete.
- **Badges** — your own reward badges: earned automatically when a metric crosses a
  value (level, XP, streak, 30-day discipline or return, days in the league …) or
  awarded by hand, each paying the XP you set.
- **Levels & XP** — levels on a curve or a table of thresholds, level titles, a live
  preview, and the XP every action pays.
- **Features** — the level each feature unlocks at.
- **Coach** — on/off for members, daily allowances, your own limit, whether members
  may share trades and notes, today's usage.
- **Routines** — replace the built-in profiles' questions and add your own profiles.
- **Wallets** — wallet approval on/off, and approve or reject each member's wallet
  (single or in bulk, with a note); waiting wallets come first.
- **Feed** — announcements and moderation. **Settings** — open/closed, invite code,
  claimed wallets only, encrypted sync, and **Security**: two-factor for the panel (above).

Without `AUTH_TOKEN` the admin API refuses every request instead of opening to everyone.

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
- **Setup** — what the trade was (breakout, fade, news…). Your playbook names
  are suggested as you type.
- **Playbook checklist** — when the setup names one of your playbooks, its rules
  appear as a checklist. Tick the ones you followed: before you enter (open
  trades have journal rows) or when you review. Ticks save at once.
- **Rating** — 1–5 stars for execution quality, independent of outcome.
- **Mistake flags** — chased, oversized, no-stop, revenge, fomo, early-exit…
- **Planned risk ($)** — what 1R was for this trade. Powers R-multiples
  everywhere; if unset, a fallback 1R (configurable basis, see Settings) is used.
- **Trade plan** — entry / stop / target. Open positions have journal rows
  too: a plan saved while the position is open is badged **written live**, one
  last changed after the close **written after close**, and the two are scored
  separately under Plan adherence (hindsight plans flatter stop discipline).
  Perp positions opened in the last 7 days with no written stop get a
  dashboard nudge. Once the trade closes, a line under the plan shows the
  planned R:R, the achieved R and a verdict (see **Plan vs outcome** below).
- **Notes** — free text.
- **Attachments** — paste or drop screenshots; stored in this browser (and on
  the server when synced). The ✎ on a thumbnail opens a mark-up editor: arrows,
  lines, boxes, a pen and text labels in four colours, with undo. **Save**
  replaces the screenshot; **Save as a copy** keeps the original and adds the
  marked-up version next to it.

**Playbooks** (Review → Playbooks) are your setups with their rules written down:
a name ("Breakout retest") and one rule per line ("Wait for the retest", "Stop
under the range"). For each playbook, the section compares trades that kept
every rule with trades that broke at least one: count, win rate and result per
trade (in R where the risk is known, else in dollars). It also shows the gap
between them ("following the playbook is worth +0.6R per trade") and, per rule,
how often you keep it and what breaking it cost. Only trades with a ticked
checklist are graded. A rule you add later doesn't grade older trades, and
rewording a rule starts its history fresh. Gaps built on fewer than 10 trades a
side are marked *early*. Playbooks sync across devices and ride backups, and
Keel offers their names first when you tag a setup.

**Price chart** on the expanded row draws the trade on real candles: every
entry/add and close fill, average entry/exit, your planned stop and target as
dotted lines, and ✕ marks at the worst and best prices while the trade was on.
When price traded through your planned stop and the position stayed open, the
chart says so.

**Replay** plays that chart forward one candle at a time, from just before the
entry, so you can watch the trade unfold the way you lived it. Fills appear when
they happened. The exit line and the worst/best marks appear only at the end. A
readout shows the position, average entry and P&L so far at each bar (gross,
before fees, and in R when the risk is known), and your journal note sits
underneath. You can play, pause, step a bar back or forward, scrub, and switch
between 1×, 3× and 8×. **⇤ / ⇥** jump from fill to fill, and the readout names
the fill ("Fill 2 of 4: add 0.5 @ 64,210") with the position size, average entry,
unrealised and realised P&L after it; the latest fill marker is drawn larger. With
coach mode on, your plan (stop, target, verdict) sits under the chart with your note. The controls work
from the keyboard: ← → one bar, Shift+← → one fill, Space play/pause, Home/End.
**📎 Attach chart** saves the chart as it looks right now to the trade's
screenshots, ready to mark up with ✎.

**Plan vs outcome.** Every closed trade with a written stop gets one verdict,
decided from prices: **followed the plan** (out at the stop, give or take 10% of
1R for slippage, at or past the target, or no target set), **exited early**
(out before the target, stop not hit), **stop moved or widened** (out beyond the
stop: a bigger loss than planned) or **held past the stop** (price traded through
the stop while you were in — a fill beyond it, or the candles' worst price once
Price excursions has run — and you stayed). 1R is the distance from your actual
entry to the stop, so a clean stop-out is −1R; planned R:R uses the planned
entry. Both are gross, before fees. The cost of a deviation is measured against
what the plan would have paid: the −1R stop-out for a moved stop or a hold past
it, the target for an early exit — but only when the target printed while you
held (otherwise nobody knows, and it's listed as not costed). Diagnostic → **Plan
vs outcome** has the full table: share of trades planned, adherence, average R
followed vs not, each deviation's count, average R and cost, and planned vs
achieved R by setup.

Everything you journal becomes analytical fuel: tags, setups, ratings, and
mistake flags are all mined as pattern-miner families, and the Review view
tracks journaling completeness. Once you've run Price excursions, each trade's
expanded row also shows its MAE/MFE (with ≈ marking approximate measurements).
Trades where you added while underwater (detected from the fill stream against
your running average entry, not a proxy) carry an **avg'd down** badge and feed
the miner and the rule engine.

**The day journal** (Review tab) adds a per-day layer: bias, pre-market plan,
an end-of-day review, a plan-adherence check, and a **committed max loss** —
which, when set, becomes that day's tripwire threshold on the dashboard. The
number you chose calmly before the session is the one enforced when the
session goes sideways — and the tripwire counts **open losses** toward the
limit too, so being deep underwater on open positions trips it before you
close (open gains never license more risk). Day entries sync and back up
with the trade journal, and **clicking any day in the calendar heatmap**
opens that date's entry (the heatmap scales its colors over the visible
window and toggles between 26 and 52 weeks).

The day journal also carries a **Prep** score — sleep, stress and
focus, 1–5. Once about ten trades carry one, the pattern miner tests them as
conditions (`slept badly`, `high stress`, `low focus`, `sharp focus`), so how
you felt becomes a measured edge or leak. Day entries record `plannedAt`, when
a plan first existed for the day, so the process score can tell a plan written
before the first entry from one written afterwards.

**Monthly goals** (also Review) hold the month to three optional commitments:
a net target (with straight-line projection and needed daily pace), a max
acceptable intramonth drawdown, and a trades/week cap.

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
- **Where the money came from** — your best and worst five markets, ranked by
  what share of the period's result each is responsible for. The primary
  percentage is share of one side: a market's profit as a fraction of the total
  profit made by *every* profitable market (so the column sums to exactly 100%
  within a side, and "these five produced 84% of my profit" is literally true).
  A secondary "% of net" figure divides by your bottom line instead — the direct
  answer to "how much of my result is this market" — but winners and losers
  offset, so it can exceed 100% and is hidden whenever net is small next to the
  gross sides. Its own **$ / % toggle**: dollars reward size and frequency and
  answer "cutting this market saves $Y"; percent sums per-trade return on
  notional, which is additive and size-neutral, so a small market traded well
  can outrank a big one you churn. This is attribution, not edge quality — the
  Edge breakdown below is the per-market expectancy view.
- **Capital & true return** — deposits, withdrawals, and transfers from the
  exchange ledger give the app the missing denominator: return on
  *time-weighted average capital employed* (with annualization), a
  **money-weighted XIRR** beside it (TWR grades the strategy, XIRR grades the
  account), max drawdown as a % of the capital present at the trough, a net
  flow-mix row (external vs vault vs transfers), and implied all-time PnL
  (live equity minus net deposited). Deposits and withdrawals are also drawn
  as markers on the dashboard equity curve, so capital events explain its
  steps. Account-wide by nature, so this card ignores the view/period filters
  and says so. Unclassifiable ledger entries are counted and shown, never
  silently mixed in.
- **Setup scorecards** — every journaled setup tracked as its own little
  strategy: per-setup equity curves and an early-vs-recent expectancy split
  with an improving / fading / flipped-negative verdict. The standing re-test
  the miner's own caveat asks for.
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
- **Rules from findings** (in Discipline & rules) — any leak in the pattern
  miner has a **+ rule** button, and a what-if replay that would have made
  money offers **Make this a rule**. A rule stores the condition's stable id
  and frozen thresholds (the same mechanism as pinned patterns) in
  `settings.rules.custom`, so it syncs and backs up with the built-in rules. Each
  one shows its breaks and their dollar cost, and answers **did the rule
  work?**: the share of trades breaking it before it was made vs since,
  one-sided two-proportion test (`working` at p < 0.10, `improving`, `not
  followed yet`, or `collecting` until 10 trades exist since). Conditions known
  at entry (market, direction, size, streak state, setup, tag, check-in) are
  **live**: an open position that breaks one shows a warning chip on the
  dashboard. Hold time, excursion shape and close-hour conditions are scored
  after the close only.
- **Plan adherence** — stop-honored rate, target-hit rate, planned vs realized
  R, the cost of blown stops. With excursions measured, a trade where price
  went *through* the stop and you held on counts as a broken stop even if the
  exit recovered (approximate ≈ measurements never convict). Plans written
  live and after the close are reported separately.
- **Plan vs outcome** — every planned trade's verdict (followed, exited early,
  stop moved or widened, held past the stop), adherence, average R followed vs
  not, what each kind of deviation cost against the plan, and planned vs
  achieved R by setup. Definitions under *The journal* above.
- **What if I stopped doing X** — pick any condition the miner knows about and
  deterministically replay your actual trade sequence *without* those trades:
  side-by-side net, expectancy, win rate, drawdown, and an
  actual-vs-counterfactual equity chart. This is what turns a miner finding
  into a dollar number. (Hindsight removal is the optimistic bound, and the
  panel says so.)
- **Drawdown recovery & streak depth**, **Risk & discipline**,
  **What your numbers say**, and the two on-demand engines below.
- **What your numbers say** — the recommendations as plain-language cards:
  what's happening ("You trade worse right after a loss"), one thing to do
  about it, and how sure the numbers are in words ("Very likely real",
  "Probably real", "Early signal — keep watching", from permutation, FDR and
  Welch tests underneath). The statistics fold away under "The numbers"; cards
  are ranked by money at stake × confidence, and many carry **Adopt as habit**.
  The dashboard coach uses the same cards.
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
"beyond winner territory." An **Update open positions** button re-measures
live positions entry-to-now on demand (closed trades reload instantly from
saved measurements), so the monitor tracks a position while it's still open.

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

A structured self-review: **Journal inbox**, **Process**, **This week** and **Highlights · last 30 days**
summaries, best & worst trades, journaling completeness (how much of your
recent activity is actually tagged/rated/noted), highest- and
lowest-probability conditions pulled from your data, actionable ideas, and
**Focus for next week** — a short list of concrete things your own numbers say
to do differently.

It also carries the habit loops:

- **Journal inbox** — closed trades from the last 30 days with nothing
  journaled, one at a time: type the setup, press 1–5 to rate, tick mistakes,
  Enter saves and moves on. A **streak** counts consecutive trading days where
  every trade is journaled (today never breaks it while it's still being traded).
- **Process** — a 0–100 **process score** per trading day, graded on how you
  traded rather than what the market paid: plan filed before the first entry
  (20), trades breaking no rule (20), trades with a live plan (15), planned
  stops honored (15), no entries after the day's loss limit broke (10), trades
  journaled (20). Parts that don't apply that day drop out of the weighting,
  and the two planning parts only count from the first day each habit was
  used, so older history isn't graded against habits that didn't exist yet.
  Alongside it, **process vs outcome** sorts the last 60 trading days into
  good process on green and red days, and poor process on green and red days;
  many "poor process, green" days means the market is carrying you.
  The dashboard's Daily PnL calendar toggles to process scores (**PnL / Process**).

- **Day journal** — pre-market plan (bias, plan, committed max loss) and
  end-of-day review. A committed max loss becomes today's tripwire threshold.
- **Weekly review wizard** — three questions about the last completed Mon–Sun
  week (best/worst trade prefilled): what worked, what changes, and a one-line
  lesson. Answers are keyed `week:GGGG-Www` on the same journal plumbing as
  everything else (sync, backup, conflict merge), and every lesson feeds a
  browsable **lessons library** with the latest surfaced on top.
- **Monthly goals** — target, max drawdown, trades/week cap vs the month so far.
- **Costs & variance** — your current **Hyperliquid fee tier** from exact
  trailing-14-day fill volume (perps plus twice spot, as Hyperliquid counts it,
  with spot flow priced at spot rates), distance to the next tier, and last month's
  taker flow re-priced one tier up / at maker rates (base schedule, hardcoded —
  verify against app.hyperliquid.xyz/fees); plus **variance expectations**, a
  seeded simulation from your own win rate and distribution: the probability of
  loss streaks over the next 200 trades and the 1-in-20 bad month at current
  sizing — decided calmly, before it happens.

Two guardrail chips watch the dashboard alongside the tripwire: **unplanned
trading** (2+ trades today with no day-journal plan filed) and **risk creep**
(median entry notional of the last 20 trades outrunning your actual capital
growth), plus **rule broken** (an open position breaking one of your live
rules from findings) and **no stop written** (a recent perp position with no
trade plan). If notifications were granted (asked only when you save a loss limit),
the tripwire also fires a desktop notification when the tab is backgrounded.

### Routine vs results

**Review → Routine vs results** answers the long-run question: does your
discipline actually pay? It opens with **Habits vs results · day by day**,
which shows from your third trading day:

- **A scatter, one dot per trading day.** Across is your *habit score*: the
  share of your habits you kept that day. Up and down is the day's result in
  $ P&L, % return on notional or R (a toggle). A dashed trend line runs through
  the dots, and from 8 days a rank correlation says in plain words whether days
  with more habits kept come with better results. Hover or tap a dot for the
  day, the habits it missed and its trades.
- **Average day by habit score.** Days grouped into bands (under 50, 50–69,
  70–89, 90–100), with the average result in each band.
- **Which habits pay.** For each habit, the average day when you kept it minus
  the average day when you didn't.

The habit score only counts the habits you actually use. A habit you've never
kept (say, the end-of-day review) isn't held against every day. Stops honored
and the loss limit stay out of the score, because they can only fail on a
losing day.

Keel tells the same story simply, for people getting started, under **Stats →
Do your habits pay?** (near the top, for the range you pick). It gives a plain
answer ("On days you kept most of your habits, you made $281 more a day"), a
"how sure" meter ("Too early to tell", "Not clear yet — could be luck", "Looks
real", "Clear pattern") and two tiles: habit days and other days, with their
average day and how many were green. When the link is real it names the habit to
protect. **See the breakdown** adds a three-step staircase (few, some or most
habits kept) and the habits ranked by what they're worth a day. There's no
scatter and no statistics in Keel; those stay in the full journal. It never
claims a link before 8 days or without a significant one, and it says so when
sloppier days did better.

Below that, over your whole history in the current view:

- **Week by week.** Average result per trade as bars, with your routine score
  as a line.
- **Two curves.** Cumulative results of trades on disciplined days (routine
  score 70+) and on all other days.
- **The numbers.**
  - Same-week link: Spearman correlation with a 1,000-shuffle permutation
    p-value.
  - Next-week link: does a disciplined week predict the *following* week? That's
    closer to cause and effect, because it can't run backwards.
  - Per-trade result on disciplined days vs the rest, with a bootstrapped 90%
    range for the difference.
  - Whether the link is growing, over a rolling 12-week window.
- **Which habits pay.** Plan before the first trade, rules kept, stops written,
  check-in, end-of-day review, journaling, and no revenge entries, sizing up,
  adding to losers or overtrading. Each shows days kept vs missed and the
  difference per trade, marked *holds up* (it survives a false-discovery check
  across all the habits), *suggestive* or *could be chance*.

Two choices keep it honest:

- **The routine score here is outcome-blind.** It's the share of the day's
  trades free of revenge entries, sizing up after a loss, adding to a loser and
  overtrading. The two Discipline checks that can only fail on a losing trade
  (holding a loser, trading on after two losses) are left out, so a red day
  can't lower the score by itself and manufacture a link. For the same reason,
  habits that follow from the result ("stayed under the loss limit", "stops
  honored") are listed but not tested.
- **Results are in R** (or % return on notional when most trades have no
  planned risk), so trading bigger never counts as trading better.

The week-by-week part needs 8 weeks of trading before it claims anything, and it says so when your
score never varied. Keel's "Does discipline pay?" card adds a one-line
whole-history summary with the habit that pays most. Every number is seeded, so
it reproduces.

**Every chart explains itself.** Hover any chart (tap on a phone) for the
numbers behind the point and a line on what the chart shows. Bar charts by
market, month, weekday, hour, session and side also give trades, wins and
losses, win rate, the average trade and the best and worst trade.

### Duels

Members challenge each other 1 on 1 for a week or a month. Anyone in the league
can be challenged: from their profile (**Challenge to a duel**), by name under
**Social → Duels**, or from the quick picks there (your partners, people you
follow and your leagues' members). Money is never staked; XP can be.

- **What you can compete on:**
  - **Discipline:** the higher average wins. It can require a minimum number of
    trading days, so nobody wins by not trading.
  - **Clean days:** more trading days at 70+ wins.
  - **Last one standing:** the first trading day under 70 loses.
  - **Journal streak:** more days with every trade journaled and the day reviewed.
  - **Process XP:** more XP earned from process.
  - **% return with a drawdown cap.** Going past the cap loses outright. Both
    sides must share % return. This type is off unless the owner switches it on.
  - **Verified scoring.** The first three can be scored "verified from fills",
    which reads the Discipline the server computes from each wallet, instead of
    what the apps report.
- **How it runs.** The other side has 48 hours to accept, decline or **suggest
  changes**, which sends the challenge back with new terms. An accepted duel runs
  from the next Monday (or the 1st, for a month), so nobody gets a head start.
  A live card on Today and under Duels shows both scores and each day's mark, and
  a notification comes when the lead changes.
- **XP stakes.** A challenge can put XP on the line: both sides put up the same
  amount and the winner takes the other's (a draw gives both back). A duel can
  stake at most 500 XP, and at most 25% of a member's XP can ride on their open
  duels at once (the owner sets both). The other side's limit is checked too.
  XP won in a duel doesn't count toward a Process XP duel.
- **Results.** A duel is settled the day after it ends. The winner gets a feed
  line (naming the loser only if they share milestones too), the stake, and an XP
  bonus the owner sets (default +100, the same for every duel and only for a duel
  played to the end). Before the start date either side can **back out** and
  nothing counts; after it, a **forfeit** gives the other side the win and the
  stake. In a verified Last one standing duel, switching verification off counts
  as falling on the first day.
  Records (won, lost, drawn) show on profiles, with a **Rematch** button.
- **Limits.** At most 3 open duels per member, 5 new challenges a day, and no new
  challenge to someone who declined you in the last week. Members switch off
  **Accept duel challenges** under Profile & privacy.
- **Admin → Duels:**
  - Switch duels on or off, choose the allowed types, and set the XP bonus,
    the limits and XP stakes (on or off, the most per duel, the most of a
    member's XP at stake).
  - Switch the ladder on or off and set K and the duels to be listed; switch
    group duels on or off and set their most people (3 to 6).
  - See the ladder's current season and its top 10, and the last podium.
  - See every duel and group duel running or waiting, and cancel one without a
    result.
  - "Duels" is a Keel feature that unlocks at level 3 (1,200 XP on the default
    curve), so members have a record to compete on and XP to stake. Change the
    level under Features (1 makes it free); the server enforces it too.

#### Duel ladder

Every member has a duel rating, shown on their profile next to their record
and on the Duels screen.

- **Rating.** Elo-style: everyone starts at 1000, and each 1v1 result (win, loss
  or draw, forfeits included) moves both sides by up to K points (32 by
  default). What one side gains the other loses, and beating a higher rating
  counts more. Duels backed out of before the start, and duels the admins
  cancel, don't count. Group duels don't change ratings.
- **Ladder.** The Duels screen ranks members with at least 3 rated duels (the
  owner sets the number). Only members who share their profile and take
  challenges are listed; everyone sees their own rating.
- **Seasons.** One per calendar quarter. The season standing is rating points
  gained during it. A season closes on the 2nd day of the next quarter, once its
  last duels have settled. The top 3 with points gained are notified, get a
  season badge (Duel season champion, runner-up or podium; system badges like
  league seasons) and a feed line if they share milestones. Then every rating
  moves 25% of the way back to 1000. Past podiums stay on the Duels screen.

#### Group duels

A member sets up a group duel ("pod") for 3 to 6 people (the owner sets the
most) from **Social → Duels → Group duel**: Discipline, clean days, last one
standing, journaling or process XP (no % return, no XP stakes), for a week or a
month, verified from fills if everyone has verification on. They pick people
with the same quick picks as a 1v1, or by name; anyone who takes challenges can
be invited.

- **Invites.** Each invitee has 48 hours to accept or decline. Once 3 people
  (the creator included) are in, the dates are fixed: the next Monday, or the
  1st. Invitations still open can be accepted until the start. With fewer than
  3 in after 48 hours, the group duel lapses. Before the start, the creator can
  call it off and others can back out; if that leaves fewer than 3, it waits
  for more answers again or, once the 48 hours are up, it's off.
- **Scoring.** Each member is scored like one side of a 1v1, then ranked:
  the higher score wins; in last one standing, whoever falls last (equal
  results share a place; several still standing share first). A member whose
  wallet changes mid-duel is out, and so is one who leaves after the start.
  Anyone out places last.
- **Results.** Settled the day after it ends. Everyone gets a placing; a sole
  winner gets the league's duel XP bonus (only if at least one other member
  played to the end). Profiles show "Group duels won". A group duel counts once
  toward each member's open-duel limit, invitations included.
- **Notifications.** Invites, the start, lead changes (once a day at most) and
  the result.

### Traders like you

Members see how their last 90 days compare with anonymous traders of the same
style (scalper, day, swing, position), trade size range, experience and activity:
a simple card in **Keel → Stats** ("better than 64 of 100 traders like you",
plus the one habit that most separates the best quarter of their group from them)
and a detailed table in the journal's **Review**, where they pick which
dimensions to match and see each group's spread.

- **What's shared.** Each member's app works out a summary of about a dozen
  numbers (Discipline, revenge trades, % journaled, win rate, profit factor,
  average win ÷ loss, fees, trades a week, typical hold) and the four ranges, and
  sends it with its usual sync. No trades, coins, amounts or wallet; other members only
  ever see groups, while the owner and admins can see a member's own summary (they're
  told so in Profile & privacy). Returns
  and drawdown are added only from wallets read on chain. It's **on by default**;
  members switch it off under Profile & privacy ("Count me in Traders like you"),
  which removes them from the next build. They can still see the comparison.
- **Peer groups.** Built at most daily, and within minutes of new summaries.
  A group needs at least 25 traders (the owner can set 10 or more); below 200
  contributors only "everyone" and "same style" groups exist. Only each group's
  deciles leave the server, and a "best quarter" figure only when it covers at
  least 10 traders. A trader counts with 15 closed trades in the last 90 days, over at
  least 2 weeks; the owner sets the bar (10–100 trades) and the look-back (90 or 180
  days) in Admin → Benchmarks, and changing either re-reads the seed wallets it affects.
- **Seed wallets.** To get started before you have many members, the owner can
  bulk-add public Hyperliquid wallets in Admin → Benchmarks. The server reads
  each one's last 90 days of fills, a few seconds apart, and runs the same
  summary function the app uses (plus the wallet's 30-day return). Wallets with
  under the bar, or with more than 20,000 fills (bots, market makers), are left
  out. Counted wallets are re-read weekly; up to 5,000. **Re-analyze all** (or
  **Re-read** on one row) reads them again now, with today's settings and their
  latest fills: counted wallets keep counting until their new read lands, and
  the page shows the progress and updates itself while it runs.
- **The seed table** shows what was read from each wallet:
  - segment: style, trade size, experience and pace;
  - trades, win rate and profit factor;
  - realised P&L in dollars over the look-back, 30-day return and drawdown, and
    account value.

  You can filter it by status and sort it by P&L, return, profit factor, win rate,
  trades, account value or drawdown. The dollar figures are for you only; they
  never go into the groups. Left-out wallets show how many trades they had.
  "How traders are grouped" in the same tab spells out the rules.
- **Traders like you who improved.** The server keeps each contributor's
  summary weekly (members and seed wallets; at most one snapshot a week, about
  26 weeks, never sent out). At each build it looks, per peer group, at everyone
  followed for 8–12 weeks and finds who moved from the group's bottom half to
  its top half on Discipline or profit factor. It then compares the median
  change for those improvers with the median change for everyone else: trades a
  week, revenge share, hold time, journaling, fees, win rate, average win ÷ loss,
  and, for members, how often each slip showed up in their synced days. Changes
  are ranked by effect size (the gap between the two medians over the spread of
  everyone's changes). A change is shown only when both sides have at least 5
  traders and the group has at least the smallest group size followed that long.
  If a group can't say anything yet, a broader one is used, as with the spreads.
  `GET /api/social/bench` returns it as `improvers: {key, n, nOthers, panel,
  changes: [{metric, label, unit, improversDelta, othersDelta, from, to, n,
  nOthers, effect, text}], note}`, where `note` says plainly why nothing is shown.
  Keel → Stats has a simple card, "What traders like you changed when they
  improved", with two or three changes. Each has **Make it my habit**, which adds
  the matching habit or plugs the matching leak, and a tooltip with the numbers.
  The journal's Review has the full table. Admin → Benchmarks shows improvers per
  group and the top changes overall. Members who switch off "Count me in" lose
  their history at once; members who leave or are removed, and seed wallets taken
  out, lose theirs at the next build.
- It's a Keel feature like the others, **free at level 1**. Set a level under
  Admin → Features to make it an unlock. The AI coach sees the member's standing
  (group spreads only) and can use it to make a habit concrete. It also sees up
  to three things improvers changed.

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
- **Appearance:** Auto (follows your device's light/dark setting, live), Dark
  or Light, applied to the full journal and Keel (Keel → Settings has the same
  switch). It syncs with your settings and is applied before the first paint, so
  a light-mode phone never flashes the dark palette. In light mode, profit/loss
  colours are deepened to hold contrast on white.
- **Colors:** two dark-mode colorways, INK and BB (black & amber).
- **R basis:** what 1R means when a trade has no planned risk journaled —
  average loss, fixed $ amount, or other bases.
- **Breakeven threshold:** the ±$ band treated as "scratch" rather than
  win/loss in the distribution analysis.

## Exports and backups

These sit under **Export & tools** above the trade table (the clock and colour
switches moved into **Settings**).

| Button | What you get |
|---|---|
| **Export CSV** | The trade table as CSV. |
| **Tax CSV** | Clean 14-column, ISO-8601, CRLF file of realized results — importable into tax tooling. |
| **Tax PDF** | Bank-statement-style PDF for your accountant: cover summary per tax year, monthly subtotals, and every realized trade with a running balance and page footers. Generated entirely client-side by a built-in dependency-free PDF writer (base-14 Courier fonts) — nothing leaves your machine, and the strict CSP stays intact. |
| **Spot lots** | 8949-style lot-level CSV for spot: FIFO cost basis, one row per lot consumed by each sale — quantity, acquired/disposed dates, proceeds, basis, gain, short/long term. Sales of tokens that were transferred or airdropped in (no on-exchange purchase) are emitted at zero cost with an explicit `UNKNOWN BASIS` note for your accountant to resolve. Built from the locally cached fills. |
| **Tax export by country…** | Tax exports set up for your country, with a preview per tax year before you download. **US**: FIFO lots, short vs long term. **UK**: HMRC's matching for cryptoassets (same day, then the next 30 days, then the Section 104 pool), on the 6 April tax year. **Germany**: FIFO, with coins held more than a year marked tax-free and the year's tax-free total shown. **Australia**: FIFO, flagging gains that may get the 50% CGT discount, on the 1 July income year. **Canada**: adjusted cost base (average cost), flagging possible superficial losses. **Other**: FIFO by calendar year. Set a report currency and paste a daily rate table (`YYYY-MM-DD,rate`, units per 1 USD, e.g. from your central bank). Each fill converts at its own date, and the download stays disabled until every fill has a rate. Two CSVs: spot disposals (asset, quantity, dates, proceeds, costs including fees, gain, matching rule, flag) and closed perp trades (realized P&L, fees, funding and net, each converted at the close date). Every wallet is pooled, since tax is per person. It computes gains, not tax. **Not tax advice.** |
| **Koinly CSV / CoinTracker CSV** (in Tax export by country…) | Files in the import formats of the two most used crypto tax tools. **Koinly** (universal format): `Date, Sent Amount, Sent Currency, Received Amount, Received Currency, Fee Amount, Fee Currency, Net Worth Amount, Net Worth Currency, Label, Description, TxHash`, dates `YYYY-MM-DD HH:mm:ss` UTC. **CoinTracker**: `Date, Received Quantity, Received Currency, Sent Quantity, Sent Currency, Fee Amount, Fee Currency, Tag`, dates `MM/DD/YYYY HH:mm:ss` UTC. Spot fills are trades (the fee in its own coin). Perps keep the other exports' treatment, one closed trade at its close time: realised profit is received, a loss sent (Koinly `realized gain`, CoinTracker `margin_gain` / `margin_loss`), with the trade's fees in the fee column; its funding is its own row (paid: Koinly `margin fee`, CoinTracker `margin_fee`; received: `realized gain` / `margin_gain`); a fee rebate is `realized gain` / `margin_rebate`. Deposits and withdrawals (capital flows) are untagged transfers in USDC. Amounts stay in the coins traded (both tools price them in your currency); Net Worth is the USD value where the quote is a stablecoin. Pick all history, one tax year (the country's tax year) or a date range. |
| **Export journal** | Journal entries as JSON. |
| **Backup all** | Everything portable in one JSON: journal, wallets, settings, saved MAE/MFE measurements, and per-wallet fill caches (which preserve history beyond the API's pagination cap — keep these). Restore via **Open existing** or by importing on another device. |
| **Backup to server** | (shown when server sync is connected) The same full backup, stored gzipped on the companion server under `DATA_DIR/backups/` — newest 10 kept. List and fetch them back via `GET /api/backups`. |
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
   revision-checked: a stale write is refused, and that client loads the newer
   state, re-applies the journal entries and settings fields it changed since
   its last sync on top, and saves the merge — neither device's edit to a
   different entry is lost.

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

It also serves the **built-in documentation**: `/help` is the end-user guide
(a **Help** button appears in the app once the server is detected) and `/docs`
is the technical reference. Both are self-contained pages (`help.html`,
`tech.html`) with no auth — they contain no user data — and redeploy with the
app so they stay in step with it.

For **Railway** specifically, see [README-deploy.md](README-deploy.md). The two
things you must not skip: **attach a Volume at `/data`** (Railway's filesystem
is wiped on redeploy — no volume, no persistence) and **set `AUTH_TOKEN`**
(your journal contains wallet addresses and notes; don't leave the API open on
a public URL). The app asks for the token once per browser.

### Automation: scheduled refresh, alerts, weekly digests

All opt-in via environment variables, still zero dependencies:

- `REFRESH_INTERVAL_MIN=30` — refresh the server-side caches from Hyperliquid
  on a timer, so monitoring works without anyone opening the app.
- `ALERT_WEBHOOK=https://…` — Discord, Slack, ntfy, or any JSON-accepting
  endpoint (the body is shaped per receiver). Fires when something needs a
  human *during* the session: a position within `ALERT_LIQ_PCT` (default 10)
  percent of liquidation, the daily loss limit crossed (`ALERT_DAILY_LOSS`,
  falling back to the app's saved daily-loss rule), funding bleed beyond
  `ALERT_FUNDING_24H` dollars per day, or a drawdown deeper than the
  Monte-Carlo 95th percentile for your own return stream. Alerts dedupe per
  position / per day with a 6-hour cooldown.
- With the schedule on, the first run of each ISO week writes a **weekly
  digest** of the previous week (trades, net, win rate, expectancy, fees,
  prior-week comparison, best/worst market) to `DATA_DIR/reports/` — 26 kept —
  and posts a one-line summary to the delivery channels. Read them back via
  `GET /api/v1/digests`.
- `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` (comma-separated chat-id
  allowlist) — a **two-way Telegram bot**, still zero dependencies. Alerts and
  digests are delivered to those chats alongside (or instead of) the webhook,
  and a long-polling command loop answers `/today` (realized PnL vs your daily
  limit), `/risk` (open book + liquidation distances), `/stats` (last 30 days),
  `/goals` (month vs plan), and `/digest` — the phone as a read-only terminal.
  Messages from chats outside the allowlist are ignored silently; the bot can
  never write journal data. Get a token from @BotFather; your chat id from
  e.g. @userinfobot.
- **Ops health.** With the schedule on, the server also watches itself: when
  `HEALTH_FAIL_RUNS` (default 3) scheduled refreshes fail in a row — every
  alert and nudge is then quietly working from stale data — or the data volume
  passes `HEALTH_DISK_PCT` (default 90) percent full or drops under
  `HEALTH_DISK_MIN_MB` (default 100) free, one message goes to the delivery
  channels (repeated at most daily while it lasts), plus a one-line "working
  again" when the refresh recovers. `GET /api/v1/meta` reports the current
  failure streak, last error, and disk free/total.
- `OFFSITE_*` — **encrypted off-site backups** to any S3-compatible bucket
  (R2, S3, B2, MinIO). Every server backup is mirrored, and a bundle of
  `DATA_DIR` ships daily. Both are encrypted with AES-256-GCM from the
  `OFFSITE_KEY` passphrase before upload, and the newest `OFFSITE_KEEP` (30) of
  each are kept. A failed upload is sent to the delivery channels. Restore
  with `node offsite.js restore <key> <dir>`. Setup and the full variable list
  are in [README-deploy.md](README-deploy.md#off-site-backups).
- `NUDGE_HOUR=18` — an **end-of-day journaling nudge**: once a day, on the
  first scheduled run after that hour — in the app's own day-journal time zone
  (UTC when the app's clock toggle is on UTC, otherwise the browser zone the app
  reports; `NUDGE_TZ`, e.g. `Europe/Berlin`, is the fallback until it has) — if trades closed today have nothing journaled or the day has no
  end-of-day review, one message goes to the delivery channels ("3 of 4 trades
  not journaled, no end-of-day review yet"). Deduped per day across restarts;
  needs `REFRESH_INTERVAL_MIN`. "Today" is the same calendar day the day
  journal uses, so a review you wrote is always found.
- `COACH_AI=1` + `ANTHROPIC_API_KEY` (or `OPENAI_API_KEY`, see below) — the **coach's weekly letter** (see
  The coach) and the **AI coach chat** in Keel (`/api/coach/chat`: a member's
  key or the owner token; 3 messages a day per profile and per wallet (profiles that share a
  wallet share its 3), set in the admin panel's Coach tab; admins and the owner have no limit,
  and any admin can reset a member's count for the day from their page; low effort
  for quick replies). Uses the official `@anthropic-ai/sdk`, installed as an *optional*
  dependency: without `COACH_AI` the server never loads it and stays
  dependency-free. Model `COACH_AI_MODEL` (default `claude-opus-5-5`), medium
  effort, with the API's default refusal fallback. **OpenAI instead:** set
  `COACH_AI_PROVIDER=openai` (or just a `gpt-…` model) and `OPENAI_API_KEY`; the
  server calls the Responses API directly (no package), with `store: false` so OpenAI
  keeps no stored copy, reasoning effort low for chat and medium for letters
  (`COACH_AI_EFFORT` overrides, `none` sends none), default model `gpt-5.6-luna`.
  `OPENAI_BASE_URL` points it at a compatible endpoint (Azure, Bedrock). `POST /api/share` (full
  token) posts a text to `TELEGRAM_SHARE_CHAT_ID` for accountability sharing.
  `POST /api/coach/letter/<week>`
  (full token) takes `{facts}` — re-filtered through a server-side allowlist —
  and stores the letter in `DATA_DIR/reports/letter-<week>.json`.

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
| `GET /api/v1/breakdown?by=` | grouped stats by `coin, dir, market, wallet, tag, dow, hour`, plus per-group contribution shares and a ranked best/worst `contribution` block (`basis=usd|pct`, `top=N`) |
| `GET /api/v1/projection` | Monte Carlo fan (`horizon, paths, block, seed, lookback`) — same deterministic seeding contract as the Project tab |
| `GET /api/v1/kelly` | Kelly sizing from the filtered closed set (`null` under 10 decisive trades) |
| `GET /api/v1/capital` | capital flows + time-weighted return-on-capital model (account-wide; `wallet=` optional) |
| `GET /api/v1/digests`, `/digests/YYYY-MM-DD` | stored weekly digests (written automatically when scheduled refresh is on) |
| `GET /api/v1/risk` | open-position risk model: liquidation distances, concentration, danger list |
| `GET /api/v1/positions` | cached positions/spot/account snapshot; `?live=1` refetches (full token) |
| `GET /api/v1/spot/lots` | FIFO 8949-style spot cost-basis lots |
| `GET /api/v1/whatif` | counterfactual replay removing trades matching `field/op/value` |
| `GET /api/v1/journal`, `/journal/:id`, `/tags` | read-only journal views |
| `GET /api/v1/export/trades.csv` | flat CSV of the filtered trades |
| `GET /api/v1/metrics` | flat monitoring numbers (trades/net today and total, drawdown, exposure, account values) for Grafana/Home-Assistant; `?format=prom` emits Prometheus text |
| `DELETE /api/v1/cache/:addr` | (full token) evict one wallet's server caches — cleans up removed wallets and `body.wallets` experiments |

**Filters** (shared by trades/stats/equity/calendar/breakdown/projection/
kelly/whatif/export): `market=perp|spot|combined`, `wallet`, `coin` (matches
raw coin or resolved spot symbol), `dir`, `status=open|closed|all`,
`outcome=win|loss|be` (uses your saved break-even band), `tag`, `q` (notes
substring), `from`/`to` (ms or seconds epoch, ISO time, or `YYYY-MM-DD` —
a whole day on the `tz` clock, `to` inclusive), `tz=utc|local`. Note `local` is the
*server's* timezone — API consumers should prefer `utc`. The 1R basis for R
multiples is pinned to the filtered closed set, mirroring the app's period
behavior.

**Access control.** Three layers, weakest wins nothing it shouldn't:

- `AUTH_TOKEN` — everything, unchanged.
- `READ_TOKEN` (optional) — may `GET /api/v1/*` and **nothing else**: it cannot
  read or write `/api/data`, trigger refreshes, refetch live positions, or touch
  attachments/snapshots. It does read what the analytics show — trades, P&L, journal
  notes (`/api/v1/journal`), wallet addresses and the cached positions — so give it
  to scripts and dashboards, and only to people you'd show the journal to.
- `CORS_ORIGIN` (optional, exact origin) — lets a browser app on another
  origin call `/api/*`. Off by default.
- **Brute-force lockout.** Every 401 is delayed 300 ms, and wrong tokens are
  counted per client address: `AUTH_FAIL_MAX` (default 20) wrong guesses inside
  10 minutes lock that address out of every token-gated route for
  `AUTH_LOCK_MIN` (default 15) minutes — a 429 with `Retry-After`, even for the
  right token. A request with no token at all, or a `READ_TOKEN` asking for a
  full-token route, never counts as a guess. A wrong admin second-factor code or
  passkey does count.
- **Admin two-factor** (`ADMIN_2FA`, see *Two-factor for the admin panel* above) only
  gates `/api/social/admin/*`. Nothing here, and nothing else the token opens, ever asks
  for a second factor.

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
  for anything within 10% of its liquidation price. Two on-demand tools live
  here too: **correlation clusters** (one click fetches ~90 days of daily
  candles per held coin, computes real pairwise correlations, and nets
  exposure within co-moving clusters — five alt longs at 0.8 correlation
  shown as the single bet they are, with cluster-netted vs independent
  directional exposure side by side) and **scenario shock** (mark the whole
  book ±5/10/20% and see the PnL impact, % of account, and exactly which
  positions cross their liquidation price — first-order, stated as such).

## Limitations, stated honestly

- Bybit and Binance only answer from countries they serve, and they decide by the
  IP address of whatever calls them, which here is your server. A server in the US
  is refused by both. The app says so in plain words when it happens, and
  README-deploy (*Exchange APIs*) shows how to put a small relay somewhere they
  serve. Binance's API only returns the last 3 months; Ledger keeps everything it
  has loaded from then on, so load regularly.
- The exchange serves only the **10,000 most recent fills** per wallet. A wallet
  with more can't be fully backfilled from scratch: the data-health strip flags
  it, and trades whose opening fills fall before that window are marked partial.
  Existing local and server caches keep the older history once they have it, so
  load regularly and keep backups. Caches are now gzip-compressed in IndexedDB
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
- Server sync merges at the level of journal entries and settings fields:
  when two devices edit *different* entries or fields, both edits survive a
  conflict. When both edit the *same* journal entry before syncing, the device
  that syncs second keeps its version of that entry — there is no
  character-level merge inside one note.
- Open-position monitoring compares against your full winner history; if you
  mix long-horizon spot bags with perp scalps in Combined view, that baseline
  comparison is apples-to-oranges — read those flags with judgment.

## Development and testing

```
npm test           # or: node tests/run-all.mjs — offline, no dependencies
npm run test:e2e   # browser smoke tests (needs Playwright, see below)
```

About 620 tests across 33 suites cover reconstruction (flips, funding
windows, spot/perp separation, partial-history flagging), the Web Worker
dispatcher end-to-end with byte-parity against the synchronous fallback,
excursion math and the retention/ratchet behavior, miner families and
determinism, capital-flow classification and the time-weighted return model,
webhook alert thresholds and the Telegram command router, CSV import
(quoting, alias mapping, average-cost derivation), correlation clustering and
scenario shock, monthly goals, add-to-loser detection, the fee-tier model,
ISO-week boundaries, variance expectations and risk-creep thresholds, rules
from findings and their follow-through test, live plans and the
held-through-stop check, check-in conditions, the journal inbox and streak, the
process score, the end-of-day nudge, demo-fill
generation through real reconstruction, the Student-t CDF against reference
values, a whole-file parse check of every script block, and the server over
real HTTP (auth, revision conflicts, restart survival, the capital endpoint,
digest lifecycle, server-held backups, the metrics endpoint). The suites extract functions **directly from `ledger.html`**, so
they test exactly what ships — there is no second copy of the code to drift
out of sync. `tests/test-budget.mjs` adds a size budget: the build fails if
app (`ledger.html` plus every `app/` script, what a visitor downloads) grows past
its raw or gzipped budget, so growth is a choice rather than a drift.

**Browser smoke tests** (`e2e/run.mjs`) run the real app in Chromium against the
real server, fully offline (every request off the local server is blocked). They
boot the full journal with a token, load sample data, open every tab, save a journal
note and check it reaches the server and survives a reload, check that a reload
takes every `app/` script from cache, open the app offline through the service
worker, open `ledger.html` straight from disk, open Keel at phone width (no
sideways scroll), open every admin tab, and run admin two-factor at 360 and 1280 px
(setting up an app from its QR code and a passkey in Chrome's virtual authenticator,
the second step on the sign-in screen and as a dialog when a session ends, sign-out,
`ADMIN_2FA=required` first-time setup), failing on any uncaught page error. Each step also has a time budget (boot 3 s, sample data 4 s, a tab switch
2.5 s; `E2E_SLOW=2` doubles them for slow machines, and CI uses that). Playwright is
deliberately not a dependency of the repo: install it with
`npm i --no-save playwright && npx playwright install chromium`. CI runs these in a
separate job on every push.

Architecture in one paragraph: `ledger.html` holds the markup, styles and fonts,
and loads its code from `app/` as ordinary scripts, in order: vendored Chart.js,
then seventeen parts from `core.js` (storage, sync, the exchange API) and
`engine.js` (reconstruction and analytics) through the views, Keel and `plans.js`
(plan vs outcome) to `boot.js`, which runs last. The parts share one global scope, the way the single
inline script did. **The one rule:** code that runs *while a part loads* (as
opposed to inside a function called later) may only use names from that part or
an earlier one. The browser smoke tests catch a break, since every part loads on
every page. No build step: edit a part, reload. The server sends each part
gzipped under a content hash (`app/engine.js?v=…`), so browsers keep them for a
year and still pick up a deploy at once, and the offline cache stores them. The
server's analytics engine and the test suites read the app through
`app-source.js`, which returns the page with every part inlined in load order,
so they still extract the exact code that ships. The Web Worker is built at
runtime from a Blob of the app's own function sources (no separate worker
script). The CSP allows network access to `api.hyperliquid.xyz`,
`mainnet.zklighter.elliot.ai` and the app's own origin only (Bybit and Binance go
through the server's relay, `cex-relay.js`). Heavy compute (reconstruction, permutation mining) runs
in the worker with a synchronous fallback; fills and candles cache in
IndexedDB with incremental refresh.
