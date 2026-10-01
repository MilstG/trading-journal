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
4. [Pulse: the simple view (`/pulse`)](#pulse-the-simple-view-pulse)
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
   optional link-a-data-file feature needs the File System Access API).
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
(`HYPE/USDC`) so they never merge with the perp of the same name. Pulse counts
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
journal inbox, the session check-in (and its pattern-miner conditions), rules
from findings (+ rule buttons, their rules-card section, the live warning chip),
the missing-stop chip, live-plan badges and rows, the replay chart's plan lines,
the question after each trade, the AI letter and the server's end-of-day nudge.
The Diagnostic's recommendations fall back to a plain list. Nothing is deleted:
switch it back on and everything returns as it was; the setting syncs across
devices and travels in backups.

**Coach's letter (optional AI).** With `COACH_AI=1` and an Anthropic API key on
the companion server, the weekly review gets a "Write my letter" button: Claude
writes a short plain-language note on the week (what went well, the one thing
to work on, tied to your focus habit). Only an aggregate summary is sent —
counts, averages, habit sentences, finding headlines and your own one-line
lessons — and the button shows exactly that summary before anything is sent.
No fills, wallet addresses, trade notes or screenshots leave the server.

## Pulse: the simple view (`/pulse`)

Open `https://your-server/pulse` for a phone-first, gamified view of the same
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
  today against your median day. Set a trade cap or loss limit in the check-in and
  Load also tracks them.
- **Bonus XP** for what you choose to log, never a penalty for skipping it:
  check-in +10, plan before your first trade +15, trades journaled +15, stops
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
**How the scores work** spells out every formula), **Check-in** (readiness, today's trade cap,
loss limit and plan) and **Progress** (level, XP, streak and shields, the
weekly challenge, badges, share cards). A quick journal screen rates and notes
unjournaled trades. On a wide screen the tabs become a sidebar.

**Your layout.** Every Pulse screen (Today, Stats, Progress) has **Customize
this screen** at the bottom: show or hide each section, or reset to the default.
Your choices sync with your settings. Today's default is lean: today's one thing
(the focus you set in last night's review), the dials, net / entries / risk
used, your session with today's rules as kept-or-broken chips, the one next
step (check-in or review), what's due for XP this week, and the last seven
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

**Plans the app can check.** Besides the free-text plan, the check-in takes
structured rules that are checked against your fills at the end of the day:
which setups and markets you'll trade, a stop time, a maximum number of open
positions and "stop after two losses". Setups are picked from chips (your own
past tags, kept consistent), so **See in-depth stats** can break results down
**by setup** and **by your own execution rating**. Notes themselves are not
read by any model; only these structured fields are compared with results.

**Routines.** Pulse detects how you trade from the last 90 days (scalper, day,
swing or position trader; you can override it, and the league owner can add
profiles of their own) and adapts the morning questions and the **end-of-day
review**: a rating, a few profile-specific questions, the lesson and tomorrow's
one thing. The review pays XP and feeds the report cards and the coach.

**Report cards.** Weekly and monthly, with a letter grade, habit-by-habit
results, the period's best and worst trade, slips and what they cost, and how
it compares with the previous period; shareable as an image.

**Building habits.** Progress shows a **leak map** (each recurring slip, what it
cost, and whether it's shrinking), a one-tap **plug it** loop that turns a leak
into a two-week habit and graduates to a badge, **per-habit streaks** with
shields, **good moments** (the times you followed a rule that usually costs you)
and **saved you** estimates. Today shows **live nudges** when a trigger you
tend to slip after is happening right now (a fresh loss, a fast re-entry).

**Badges.** About 270 badges in 45 families (discipline, consistency,
journaling, risk, P&L, habits, social …), each with six tiers from Bronze to
Legend; new ones are revealed as you earn the earlier ones. Members can switch
on a public **badge page** at `/b/<name>` to share.

**Readiness from a wearable.** The check-in can take readiness from **WHOOP** or
**Oura** (sign in once; the owner registers an app with each and sets its keys, see
the deploy guide) or from **Apple Health** through a personal link an iPhone
Shortcut posts the morning's HRV, resting heart rate and sleep to. WHOOP's recovery
and Oura's readiness are used as they are; for Apple Health readiness is HRV against
your own 30-day median (60%) and hours asleep against eight (40%). A day's wearable
score replaces the check-in answers as its readiness (the answers still earn their
XP), so Stats' readiness-versus-discipline comparison shows which days your
discipline breaks. Days sync every 30 minutes while Pulse is open and are stored
with your journal.

**Tilt meter and quiet mode.** A live reading (0–100) on Today of the triggers
that come before a blow-up: losses in a row (30 points at three), a loss in the
last 15 minutes (20), entries at 1.5× your usual size (15), four entries in an
hour or twice your usual day (15), three quarters of your risk budget used (10)
and low readiness from the check-in (10). Profit plays no part. At 65 a new
loss or entry turns on **quiet mode**: a full-screen card that lists what pushed
the reading up, brings back the lesson you wrote about that slip, and offers a
15-minute break with a countdown (or "I'm calm"). One answer covers one episode.
Optionally the browser notifies you when it happens.

**Market conditions.** Each day is tagged from BTC's daily candles: *volatile*,
*normal* or *quiet* (the day's high–low range against the median of the 30 days
before) and *trending up/down*, *mixed* or *choppy* (the 7-day efficiency ratio:
net move over the sum of daily moves). In-depth stats breaks results down by
volatility and by trend and says so when you lose in one and make it back in
another ("You lose on volatile days … and make it back on normal days"); Today's
**Right now** shows today's conditions and how you do on days like it.

**Lessons library.** Each review's lesson line and its mistake answer become
lessons (you can add your own). They come back on Today after 1, 3, 7, 14, 30 and
60 days: "I still live by it" moves one to the next step, "I slipped on it"
restarts it tomorrow; one kept through all six is kept for good. Lessons are
tagged with the slip they're about (from their words or that day's slips), and
quiet mode shows the one that matches what's tilting you.

**Process goals.** Up to three at a time, on Progress: a month's Discipline
average (70/80/90, at least five trading days), weeks without one slip (2/4/8;
the clock restarts after one), a share of the month's trades journaled, a
number of check-ins in the month, or weeks inside your loss limit. Each shows a
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

Pulse is the same `ledger.html`: the page switches on its own path (or `?pulse`
when opened from disk), so every loader, cache and sync path is shared. It
always shows the coach and progress layers, whatever the full app's coach-mode
switch says. It has its own install metadata (`/pulse.webmanifest`), so "Add to
Home Screen" from `/pulse` installs a separate **Pulse** app.

**Sharing the link.** A visitor pastes their own public address (read-only: no
wallet connection, no signing) and their journal stays in their browser. On a
server with `AUTH_TOKEN` set, nothing they do is sent to your server; the owner
signs in once from Pulse's settings to sync. Without `AUTH_TOKEN`, everyone who
opens the link shares one journal, so set it before sharing (Pulse's settings
warn about this).

## Social, unlocks and the admin panel

Pulse has a **Social** tab that runs entirely on your own server (`social.js`,
stored in `DATA_DIR/social.json`). There is no central service: the people you
send your `/pulse` link to join *your* league.

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
  and adopt a habit you run with one tap.
- **What you share.** Profile, process boards, feed and habits are on by default;
  % return, dollar P&L and the wallet address are off. The journal, notes and trades
  never leave the browser: only XP, level, streak, badges, habit sentences and each
  trading day's process score and flags are sent. The switches are grouped into
  Profile, Boards and Sensitive; claiming a wallet, devices, journal sync and leaving
  live one level down, under **What you share → Account**.

- **Accountability partners.** Up to three per member, by mutual request (Social →
  Feed). Partners see each other's streak, the last 14 days' Discipline scores and
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
  member's inbox (Today → New for you) and as a push notification.
- **Reminders (web push).** In Pulse's settings, **Remind me on this device** sends a
  morning check-in reminder and, on days you traded and haven't reviewed, an evening
  review reminder, at times you pick on your own clock; partner nudges, mentor notes
  and season results come the same way. It's standard web push, encrypted end to end
  (RFC 8291) with the server's own keys — no third-party service. On iPhone it needs
  Pulse added to the Home Screen.

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
The sign-in message names the site it's for. When self-hosting, set `PUBLIC_ORIGIN` to
your Pulse address so the server only writes messages for that site and a look-alike
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

**Unlocks.** Pulse features unlock with level — by default deeper Stats insights at level 2, share
cards at 3 and joining competitions at 4 — plus colour themes (Ember 3, Aurora 5,
Gold 8). XP only comes from process, so unlocking rewards good habits. The owner can
map every feature (insights, in-depth stats, share cards, competitions, AI coach,
end-of-day review, report cards) to a level, switch unlocks off, or **fully unlock**
chosen members. Sample data shows everything. The full journal at `/` is never locked.

**Admin panel (`/admin`).** Sign in with `AUTH_TOKEN`. Tabs:

- **Overview** — members, activity, tiers, top XP, coach use and setup warnings.
- **Members** — search and filter; **add a member** (you get a 7-day sign-in code and a
  `/pulse#link=CODE` link to send them); per member: rename, set or clear the wallet
  (unless claimed), **boost XP** (or correct it) with a reason they see, fully unlock,
  their coach allowance, leagues and tiers, award or take back reward badges, a new
  sign-in code, suspend or delete. Members' addresses are visible to you; others see them only if the member chose to show theirs.
- **Leagues** — create, edit and delete leagues (metric, period, tiers, listed,
  invite code, auto-join), and add or remove members.
- **Competitions** — create them for everyone or one league; delete.
- **Badges** — your own reward badges: earned automatically when a metric crosses a
  value (level, XP, streak, 30-day discipline or return, days in the league …) or
  awarded by hand, each paying the XP you set.
- **Levels & XP** — levels on a curve or a table of thresholds, level titles, a live
  preview, and the XP every action pays.
- **Features** — the level each feature and theme unlocks at.
- **Coach** — on/off for members, daily allowances, your own limit, whether members
  may share trades and notes, today's usage.
- **Routines** — replace the built-in profiles' questions and add your own profiles.
- **Feed** — announcements and moderation. **Settings** — open/closed, invite code,
  claimed wallets only, encrypted sync.

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
- **Setup** — what the trade was (breakout, fade, news…).
- **Rating** — 1–5 stars for execution quality, independent of outcome.
- **Mistake flags** — chased, oversized, no-stop, revenge, fomo, early-exit…
- **Planned risk ($)** — what 1R was for this trade. Powers R-multiples
  everywhere; if unset, a fallback 1R (configurable basis, see Settings) is used.
- **Trade plan** — entry / stop / target. Open positions have journal rows
  too: a plan saved while the position is open is badged **written live**, one
  last changed after the close **written after close**, and the two are scored
  separately under Plan adherence (hindsight plans flatter stop discipline).
  Perp positions opened in the last 7 days with no written stop get a
  dashboard nudge.
- **Notes** — free text.
- **Attachments** — paste or drop screenshots; stored in this browser.

**Price chart** on the expanded row draws the trade on real candles: every
entry/add and close fill, average entry/exit, your planned stop and target as
dotted lines, and ✕ marks at the worst and best prices while the trade was on.
When price traded through your planned stop and the position stayed open, the
chart says so.

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

The day journal also carries a **session check-in** — sleep, stress and
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
  trailing-14-day fill volume, distance to the next tier, and last month's
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

These sit under **Export & tools** above the trade table (the clock and colour
switches moved into **Settings**).

| Button | What you get |
|---|---|
| **Export CSV** | The trade table as CSV. |
| **Tax CSV** | Clean 14-column, ISO-8601, CRLF file of realized results — importable into tax tooling. |
| **Tax PDF** | Bank-statement-style PDF for your accountant: cover summary per tax year, monthly subtotals, and every realized trade with a running balance and page footers. Generated entirely client-side by a built-in dependency-free PDF writer (base-14 Courier fonts) — nothing leaves your machine, and the strict CSP stays intact. |
| **Spot lots** | 8949-style lot-level CSV for spot: FIFO cost basis, one row per lot consumed by each sale — quantity, acquired/disposed dates, proceeds, basis, gain, short/long term. Sales of tokens that were transferred or airdropped in (no on-exchange purchase) are emitted at zero cost with an explicit `UNKNOWN BASIS` note for your accountant to resolve. Built from the locally cached fills. |
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
- `NUDGE_HOUR=18` — an **end-of-day journaling nudge**: once a day, on the
  first scheduled run after that hour — in the app's own day-journal time zone
  (UTC when the app's clock toggle is on UTC, otherwise the browser zone the app
  reports; `NUDGE_TZ`, e.g. `Europe/Berlin`, is the fallback until it has) — if trades closed today have nothing journaled or the day has no
  end-of-day review, one message goes to the delivery channels ("3 of 4 trades
  not journaled, no end-of-day review yet"). Deduped per day across restarts;
  needs `REFRESH_INTERVAL_MIN`. "Today" is the same calendar day the day
  journal uses, so a review you wrote is always found.
- `COACH_AI=1` + `ANTHROPIC_API_KEY` — the **coach's weekly letter** (see
  The coach) and the **AI coach chat** in Pulse (`/api/coach/chat`: a member's
  key or the owner token; per-day allowances from the admin panel; low effort
  for quick replies). Uses the official `@anthropic-ai/sdk`, installed as an *optional*
  dependency: without `COACH_AI` the server never loads it and stays
  dependency-free. Model `COACH_AI_MODEL` (default `claude-opus-5-5`), medium
  effort, with the API's default refusal fallback. `POST /api/share` (full
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
  for anything within 10% of its liquidation price. Two on-demand tools live
  here too: **correlation clusters** (one click fetches ~90 days of daily
  candles per held coin, computes real pairwise correlations, and nets
  exposure within co-moving clusters — five alt longs at 0.8 correlation
  shown as the single bet they are, with cluster-netted vs independent
  directional exposure side by side) and **scenario shock** (mark the whole
  book ±5/10/20% and see the PnL impact, % of account, and exactly which
  positions cross their liquidation price — first-order, stated as such).

## Limitations, stated honestly

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
- Server sync is last-writer-wins with conflict detection (no silent
  clobbering), not field-level merge.
- Open-position monitoring compares against your full winner history; if you
  mix long-horizon spot bags with perp scalps in Combined view, that baseline
  comparison is apples-to-oranges — read those flags with judgment.

## Development and testing

```
npm test         # or: node tests/run-all.mjs
```

428 tests across twenty-two suites cover reconstruction (flips, funding
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
out of sync.

Architecture in one paragraph: everything is in `ledger.html` — UI, engine,
and a Web Worker built at runtime from a Blob of the page's own function
sources (single-file constraint, no separate worker script). Chart.js and fonts
are inlined; the CSP allows network access to `api.hyperliquid.xyz` and the
app's own origin only. Heavy compute (reconstruction, permutation mining) runs
in the worker with a synchronous fallback; fills and candles cache in
IndexedDB with incremental refresh.
