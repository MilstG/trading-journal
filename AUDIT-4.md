# Fourth-pass audit: the XP economy, inner mechanics, and performance — October 3, 2026

> **Status: addressed.** Every finding below is fixed, with a regression test, except X3, which is
> mitigated (see "Resolution" at the end for what that means and what stays self-reported). The
> performance work landed with a heavy-account browser test. 83 suites / 1,251 tests and the three
> browser suites (`e2e/run.mjs`, `e2e/sync.mjs`, `e2e/heavy.mjs`) green at the merged revision.

Scope: the XP game end to end (how XP is earned in the app, what the server accepts and pays
on, duels, group duels, competitions and XP pots), the mechanics underneath it (the daily
Discipline score and its parts, trade reconstruction, the coach's statistics, sync and the
server's own state), plus a measured performance profile at large account sizes.

Method: five independent review passes, one per area, and one profiling pass in a real
Chromium against the real server. Findings marked **[repro]** were reproduced by running the
code: extracted app functions in Node the way `tests/harness.mjs` does, or end to end against
`createApp()` from `server.js` on a temp data dir over HTTP. The most serious ones were then
re-run a second time independently. **[read]** findings were verified by reading the full code
path. Earlier audits' fixed items were not re-reported.

---

## The one thing to understand first: who decides a member's XP

Every XP-type number is computed in the member's browser and posted to the server as-is.
`gameContext()` (`app/progress.js:193`) builds XP from the member's trades and local journal;
`pzSocialStats` (`app/pulse-social.js:63-80`) posts `xp`, `level`, `weekXp`, `xpDays` and
`streak`; `sanitizeStats` (`social.js:150-176`) only clamps ranges (xp 0–1e8, level 1–500,
weekXp 0–1e6, 1e5 per day). It never checks one number against another, never derives level
from xp (`SC.levelOf` exists but social.js never calls it), and `/stats` has no rate limit.

```
 app (trades + local journal, both fully user-controlled)
   └─ gameContext() ──► xp, level, weekXp, xpDays, streak ──POST /stats──► stored as reported
                                                                              │
 server-only:  grants (duel wins, admin)  ─┐                                  ▼
               mentor XP, awards          ─┴─► folded into xp BY THE APP ──► stats.xp
               stakeNet (stake results)  ──────────────────────────────────► + stakeNet
                                                                              = balanceOf()
                                                                                │
   boards · league promotion · seasons · owner badges · level gates · duel & pot stakes
```

That design was a reasonable one while XP only drew the member's own dial. It stopped being
reasonable when XP became **stakeable**: a duel or pot moves real `stakeNet` from an honest
member to whoever wins, and the winner's balance rests on a number they typed. The server
already has the honest alternative — the verified Discipline days it reads from fills
(`vdays`) — and the Discipline board already uses it.

---

## Critical

**X1. A member with no trades can post any XP balance and win honest members' XP** [repro]
(`social.js:166-168`, `771`, `1267-1268`, `3086-3107`). `balanceOf = max(0, stats.xp + stakeNet)`,
and `stats.xp` is whatever the app posted. Reproduced: a fresh profile posts
`{xp: 1e8, level: 500}`; `/me` shows balance 100,000,000 and duel room 500 (the per-duel cap).
It challenges an honest member (2,000 XP) to a Process-XP duel at the self-reported cap of 100,
posts `xpDays` of 1e5 for the duel's days, and wins: the honest member ends at
`stakeNet −100, balance 1900`, the forger at `+100` plus the +100 win grant. The forger's own
losses never bite, because their balance can be re-posted at will. Pot buy-ins work the same
way (`potRoomOf`, pot room 25,000,000). What limits it today: 100 per self-reported duel, 500
per verified duel, 1,000 per pair per month, three open duels, and standing locking duels after
the 14-day grace — and every new no-wallet profile gets a fresh 14 days (joins: 5/hour/IP).
README (~1399-1404) says the balance is "kept by the server"; only `stakeNet` is.
**Fix:** make the stakeable balance a server ledger: verified XP from `vdays` + grants + awards +
mentor XP + `stakeNet`. As a stopgap, cap stakeable XP at a server-computed figure (e.g. the
verified Discipline sum) and refuse stakes from profiles without a verified wallet.

## High

**X2. Level, all-time XP, weekly XP, streak, owner badges, league promotion and season podiums
are all forgeable** [repro] (`social.js:150-176`, `295-297`, `718-722`, `829-857`, `946-965`,
`1868`). Same forged profile: #1 on Weekly XP, All-time XP and Streak boards; public page reads
"Level 500 · Legend, 100,000,000 XP, streak 10,000"; an owner badge "xp ≥ 50,000 (+500 XP)" was
auto-awarded by `awardCheck`; promoted Bronze → Silver at the weekly rollover. A second profile
posted `{xp: 0, level: 500}` and was stored as level 500 with 0 XP — and level gates (duels at
level 3, the coach, competitions: `lockedFor`, `social.js:1547`, `3292`) read that posted level.
`xpDays` can also be back-filled for past season days during the one-day grace before
`closeSeason`, and for future days (any `YYYY-MM-DD` is accepted). **Cheap fix:** recompute level
with `SC.levelOf(S.config.levels, xp)` and ignore the posted one; require
`weekXp ≈ Σ xpDays(week)` and `xp ≥ Σ xpDays`; reject `xpDays`/week keys in the future or before
the current week; cap per-day XP at the most the configured weights can pay (~100× discipline +
bonuses); rate-limit `/stats`. **Real fix:** score XP boards, rollover and seasons from `vdays`,
as the Discipline board already is.

**X3. The app-side inputs to XP are fully user-controlled, so even an unmodified client can be
fed arbitrary XP** [read] (`app/pulse-social.js:63-80`). XP comes from any wallet pasted into
settings (any public address works — someone else's good trading becomes your Discipline) and
from the local journal, which a crafted backup restore or a JSON edit rewrites freely
(`day:` entries with `sleep`, `eod.at`, huge `maxLoss`). This is why X2's consistency checks
alone are not enough: the numbers would be consistent and still invented. **Fix:** as X1/X2 —
server-derived XP from verified wallets; at minimum, league XP only from the first verified
wallet.

**X4. Bonus XP can be backdated onto any past trading day** [repro] (`app/progress.js:549-560`
`pzBonus`, `app/habits-coach.js:463-466`, `app/journal.js:1158-1175`, `app/data-io.js:462`).
A month-old day with two losing trades (−$1,300) and no entry earns 0 bonus. Open it from the
calendar, save any plan text, max loss 1e9 and Sleep = 5: the bonus becomes
`{checkin: 10, plan: 8, limit: 10}` = +28 XP. Repeatable on every historical day. The same parts
are posted as `o.p`, `o.pl`, `o.lm` and raise the *verified* Trader Age (see X12), hence the
multiplier, and feed the Self-aware / Inside-the-lines / check-in badges. README promises
"plan **before** your first trade" and "loss limit **respected**". **Fix:** timestamp check-in
and loss limit as `plannedAt` already is; pay only when set before the day's first entry (or at
least on the same day); no limit credit for a `maxLoss` set after the first entry.

**D1. Turning off return sharing mid-event escapes the drawdown cap — duels, group duels and
competitions** [repro] (`social.js:973` `refreshMoney` returns early unless
`share.ret || share.usd`; `1006-1016` `d.money`/`p.money` keep the last snapshot; `3023-3027` only
competition money is cleared; `duels.js:52` `ddCheck` treats no data as "not over").
Reproduced: a Discipline duel, 10% cap, 100 XP staked. Ann switches off "% return" the day after
the start and draws down 41%; she **wins** (+100 stake, +100 bonus). Cat, in a mirror duel,
keeps sharing and is "Out: drawdown 41.2%, past the 10% cap". Same in a capped pod (a 40%
drawdown member won the 150 XP pot) and a capped competition ("drawdown: waiting for data",
then paid). **Fix:** treat losing `canDd()` after the start like a wallet move (out / last
place), or keep reading the wallet for running capped events regardless of share toggles; never
let a missing reading count as "not over" at settlement.

**D2. Duels and group duels settle on stale data, and scores can be posted for future days**
[repro] (`social.js:1375`, `1536` settle once `today > end+1` with no freshness gate;
`social.js:144-150` accepts any date). Competitions wait until each entrant was read after the
end (`fresh()`, `:1691`); duels and pods don't, and a member's numbers refresh only on their own
activity. Reproduced: Ann posts Discipline days for Mon–Fri on Tuesday and never opens the app
again; her 40% Wednesday drawdown is never read; she wins the capped, staked duel. **Fix:**
refresh both sides' money and `vdays` before settling and require readings dated after the end,
with a deadline like competitions; reject days later than the member's local today.

**E1. "Does discipline pay?" finds a strong link on pure coin flips — the routine score is not
outcome-blind** [repro] (`app/habits-coach.js:494-501` `RV_BLIND`, `540` `routineVsResults`,
`597` `habitLink`). The comment says the score leaves out checks that can only fail on a losing
trade so a red day "can't manufacture a correlation" — but it keeps `revenge` and `sizeUp`,
which can only fire *after* a loss that usually sits in the same day's results. 140 days of
identical behaviour (4 trades/day, each opened 5 min after the previous close, same size) with
coin-flip ±1R outcomes: weekly Spearman ρ = **0.87, p = 0.001**; "discipline dividend"
**+0.81R/trade** (90% range 0.68–0.94); "No revenge entries" habit **p = 4e-38**; `habitLink`
ρ = 0.58 → "Strong link: cleaner days, better results". Expected: no link. This is the
headline claim of the coach, and it currently confirms itself. **Fix:** condition on the
opportunity — compare post-loss entries that slipped with post-loss entries that didn't
(`pzBehaviorDays` already tracks `chances`/`kept`), or exclude the triggering loss from that
day's result. At minimum drop `revenge`/`sizeUp` from `RV_BLIND`.

## Medium

**X5. Deleting and recreating a profile wipes stake debt** [repro] (`social.js:3034`
`DELETE /me`, `915` `dropMember`, `2468`). Cat loses a 100 XP stake (`stakeNet −100`, balance
1,900); the winner keeps +100. Cat deletes the profile, rejoins under the same handle, posts the
same `xp: 2000` (the app recomputes it from the local journal): `stakeNet 0`, balance 2,000.
XP created from nothing; repeatable after every loss. **Fix:** carry negative `stakeNet` per
claimed/used wallet onto a new profile; at minimum refuse `DELETE /me` while `stakeNet < 0` or
with open staked duels or pots.

**X6. Members with lapsed standing are hidden from leaderboards but still promoted, still on
season podiums and a league's top five** [repro] (`social.js:954-955` rollover filters only
`banned`; `1870` `closeSeason`; `3123` league page `top` — versus `3158/3160` where the board does
filter `standingLapsed`). A lapsed, locked member (duels refused, absent from the Weekly XP
board) was still moved up a tier at rollover and listed on `/leagues/main`. **Fix:** apply
`standingOn() && standingLapsed(m)` to rollover entries, `closeSeason` rows and the league `top`;
treat lapsed members as 0.

**X7. Weekly challenge and focus habit can be swapped after the fact** [read]
(`app/progress.js:159-172` grades from this Monday; `330-335`, `app/pulse.js:1461-1464` "Pick
another" stays available even when `missed`; `app/habits-coach.js:884-886`; `progress.js:229-231`).
On Sunday a user can cycle candidates until one was kept every day since Monday: a guaranteed
+150, plus the challenge achievements (+50 each) and Challenger badges. Switching focus habit on
Sunday pays +25 for every kept day of the whole week. **Fix:** store `at` on a swap and grade
from `max(Monday, at)`, or lock both after the week's first trading day.

**X8. Badge XP can be farmed by repetition, and lands in this week's league XP** [repro for
goals, read for the rest]. *Goals:* a `checkin` goal is done as soon as n ≥ target, and
check-ins can be on non-trading or backdated days; clear and recreate it and each counts for
Goal getter (`progress.js:1175`, `788-790`; `pulse-screens.js:866-873`) — 24 recycled goals
reach all five tiers = +155 XP. *Toolbox:* retired habits still count
(`progress.js:1176`): adopt-and-retire 12 custom habits = +315 XP. *Leak plugged:* deduped by
`slip|done`, so re-plugging the same leak counts again (`progress.js:1177`, `1272-1280`), contrary
to the "one leak counts once" comment. Badge keys are today's date, so all of it flows into
`weekXpBase`. **Fix:** count distinct goal kinds per month and refuse goals already met at
creation; count distinct templates; dedupe plugs by slip.

**X9. XP, levels and earned badges can be taken away retroactively** [read]. README: "XP
already earned never changes". But retiring a habit removes its habit-days/habit-run badges and
kept-month achievement (`habitsList()` drops retired habits, `progress.js:226`, `1162-1164`);
re-adopting resets `createdAt` and its history (`habits-coach.js:864`); the 41st goal pushes the
oldest done goal out (`slice(-40)`, `pulse-screens.js:872`); toggling the timezone, removing a
wallet, or the owner changing XP weights re-scores all history, and a level can drop. Nothing
earned is stored — every rebuild re-derives everything. **Fix:** an award ledger (id, date, XP)
that only grows; or at least count retired habits in badges.

**X10. XP depends on the view and dex filters** [read] (`app/habits-coach.js:1090`
`coachContext` uses `allTrades.filter(viewFilter)`; `app/engine.js:1187` `viewFilter` includes
`dexFilter`; `app/boot.js:37`). Daruma forces `view='combined'` but not `dexView`, which is a
synced setting with no control on the Daruma side: with "main" (or a subset of HIP-3 dexes)
selected, those trades silently leave Discipline, XP and the posted stats — a way to
cherry-pick clean dexes — while the server's verified score includes them. The full app's
Progress panel starts in `view='perp'` and shows a different XP/level for anyone who trades
spot. **Fix:** build the game and Discipline context from `allTrades.filter(t => !t.orphan)`,
independent of `view` and `dexView`.

**D3. A % return duel's minimum trading days can be met with app-reported days** [repro]
(`duels.js:152` `td = verifiedDays || appDays`; `social.js:820` exempts `ret` from the 100 XP
self-report cap). With verification off, a member who never trades (wallet P&L flat) posts five
app "trading days" (some in the future), challenges a 500 XP % return duel, and wins against a
member who traded to −1.1%: +500 + 100 XP. README: "sitting flat can't win". **Fix:** for `ret`,
and for minimum days on any staked event, count only `vdays` or on-chain activity; otherwise
apply `selfMax`.

**D4. Accepting on a Monday (or the 1st) starts the duel on a day already played** [repro]
(`duels.js:116-125` `windowFor` starts today when today is Monday/the 1st; used at accept,
`social.js:2827`, and a pod's third acceptance, `:2733`). Ann posts a Monday score of 50; Bob
accepts a Last-one-standing duel at Monday 21:00 UTC; start = that Monday, Ann is already "Out".
For % return the window counts from Monday 00:00 UTC. README: "nobody gets a head start".
**Fix:** start on the next Monday/1st strictly after acceptance (or at acceptance time for
on-chain measures).

**E2. The loss-limit part (+10 XP) misses entries after the breach, and the Daruma risk dial
ignores partial closes** [repro] (`app/habits-coach.js:465-469` `processDays`; `app/pulse.js:45-50`
`pzRisk`). `parts.limit` checks only trades that *closed* that day: limit $100, a −$150 trade
closes 10:00, trade B opens 10:30 and closes tomorrow → `limit = 1`, `breached = true`, and
"Respected your loss limit" pays +10. And a −$300 partial close today on a still-open position
(limit $200) fires the tripwire (which reads per-fill `rz`) while Today says "inside your loss
limit" and `processDays` sees no breach. **Fix:** look for entries in (breachAt, end of day)
across all trades including open ones; compute the day's realized result from `rz`, as
`dailyLossToday` does.

**E3. A stop-out with normal slippage counts as "stop not honored"** [repro]
(`app/habits-coach.js:127` `planAdherence`: `exitOk = avgExit >= stop`, no tolerance). Long, stop
90, exit 89.9 → `stopHonored = false`, the `stops` part is 0, the day's process score 30 — while
`planVerdict` (`app/plans.js`, ±10% of risk) says "followed". Nearly every real stop slips, so
this hits the `stops` part, the "Stops honored" habit, the twenty-in-a-row achievement and the
coach's "every planned stop honored" win. **Fix:** share `planVerdict`'s tolerance.

**E4. A revenge entry is missed when any other trade closes in between** [repro]
(`app/progress.js:481-486` `pzBehaviorDays` checks only the latest close). −$200 loss closes
10:00, a concurrent winner closes 10:05, a new entry at 10:06 → no flag, score 100. Expected
`revenge` (README: re-entering within 15 minutes of a loss). `evaluateRules`' cooldown had this
exact bug and was fixed (`habits-coach.js:38-47`); Discipline still has it, as does `sizeUp`.
**Fix:** scan every close in the 15-minute / 2-hour window for a loss.

## Low

**X11. The one-time `stakeSplit` migration can understate balances** [read]
(`social.js:589-591`). It subtracts moved stake grants from the last posted `stats.xp`; if that
post predates the grants, they are subtracted twice, and `Math.max(0, …)` drops any excess. A
member who never reopens the app keeps the understated balance. **Fix:** subtract only grants
with `at ≤ m.statsAt`.

**X12. The "verified" Trader Age takes ~20% of its rating from app-reported parts** [read]
(`social.js:3097-3099` `logd` from `/stats`, `1051-1056`; `trader-age.js:56-59`). Posting
`lm:1, pl:1, p:1, jn:1` on every day adds up to ~13 rating points — enough to lift a member over
the standing bar of 60, which is the main brake on X1/X2 after the grace period; it also raises
the multiplier tier and can trigger 25 XP Trader Age milestone payouts to mentors. **Fix:** a
fills-only variant (Discipline + steadiness, reweighted) for standing and mentor outcomes.

**X13. Mentor XP can be farmed with sock mentees; the daily cap follows a timezone the mentor
picks** [read] (`social.js:1135-1157`, `2947`, `2997`). `sameOwner` compares wallets only (a
no-wallet mentee always passes); `menteeActive` trusts app-reported days; delete-and-resend of a
review creates a new review id that pays again. `mxDay` uses the mentor's posted `stats.tz`, so
hopping between `Etc/GMT-14` and `Etc/GMT+12` reaches up to three date buckets at once (draws up
to two days' cap early). **Fix:** require a verified wallet for `menteeActive`; fix the mentor
day to UTC or a stored tz; key review pay on (mentee, trade).

**X14. Mentoring XP leaks into league XP** [read] (`app/progress.js:265`, `1213-1217`). `xpBase`
removes only `src:'mentor'` bonuses; the Teacher / Made-a-difference badges and the XP/level
badges computed from mentor-inclusive `xpByDay` still go into weekly XP and `xpDays`. README and
the code comment both say mentoring stays out of leagues. **Fix:** tag those badge families
`src:'mentor'`.

**X15. Late XP never reaches the league week it belongs to** [read] (`app/pulse-social.js:66`).
Only the current week's `weekXp` is posted, so journaling Sunday's trades on Monday (or late
fills) changes last week's XP locally but never on the server. **Fix:** post the last two weeks,
or have the server sum `xpDays`.

**X16. DST bug in `lastCompletedWeekRange`** [repro] (`app/tools.js:584-590`). `now − dow·86400000`
crosses a 25-hour day: at 2026-11-01 23:30 America/New_York it returns Tue 2026-10-27 as "this
Monday" (22:30 is correct). A stats post in that hour drops Monday from `weekXp`; a challenge set
then runs Tuesday to Tuesday. **Fix:** compute Monday from calendar fields, as `addDays` does.

**X17. "Where this week's XP came from" doesn't add up to the week's XP** [read]
(`app/pulse-screens.js:20-24`). The breakdown sums score + bonus before the multiplier, so it
disagrees with "+N this week" whenever the multiplier is above 1. **Fix:** add a "Multiplier"
row = `weekXp − Σ`.

**D5. A deleted member's buy-in disappears instead of staying in the pot** [repro]
(`dropMember`, `social.js:915-930`, leaves `potIn`; `potTidy` `:1489` and `compPot` `:1675` then
`potRefund` a missing member, which deletes the buy-in without crediting anyone). A started
4-person pot (4 × 50): one forfeits (stays in), one deletes their profile → gross 150, not 200. A
losing player can shrink the winner's pot. **Fix:** after the start, treat a missing member like
a forfeit (`potKeep`); refund only before it.

**D6. Duel settlement commits member rows before the duel's own status** [read]
(`social.js:1349-1360`: `save(m)`, `save(w)` inside `duelSettle`, each its own transaction;
`'duels'` saved later by `duelSweep`). A crash, or a throw in `notify`/`pushEvent`, between them
reloads the duel as active, and it settles again — the loser is debited twice. Pods already do
this right. **Fix:** `touch()` inside `duelSettle` and one `save` with `'duels'` in the same
transaction.

**D7. Alt profiles on one wallet can duel each other** [read] (`duelProblem`,
`social.js:1276-1300`, has no `seatTaken`-style check; that exists only for pots). Two profiles
on one wallet can play duels out to farm the +100 win bonus and ladder rating for season
badges; the pair cap limits only stakes. **Fix:** apply the `walletsOf` overlap check to duel
creation and acceptance.

**D8. The duel compose screen offers stakes the server will refuse** [read]
(`app/pulse-social.js:865` `stakeMax` ignores `selfMax`; `:741` `duelPrize`). For journal,
Process-XP and unverified Discipline duels the UI enables 250/500 and says "Up to 500 XP here";
the server answers 409 "at most 100". `duelPrize` promises "the winner takes the other's" though
`duelSettle` trims to the monthly pair cap. **Fix:** apply `selfMax` as the pod screen does
(`:952`); mention the monthly limit.

**E5. "Plan before your first trade" only looks at trades that open and close the same day**
[repro] (`app/habits-coach.js:457`). First entry 08:00 (closes tomorrow), plan written 09:00,
second entry 10:00 closed today → `plan = 1`, +15 XP; expected 0.5. **Fix:** take the day's first
entry from all trades, open ones included.

**E6. Pasting JSON fills without `startPosition` builds a nonsense trade** [repro]
(`app/data-io.js:709-710`; only the CSV path runs `deriveFillPositions`). Buy 1 @100, sell 1 @110
→ one *open Short*, `closeSz` 2, `avgEntry` 0. Expected a closed Long, +10. **Fix:** derive
positions when missing, or reject the paste.

**E7. Pending plans never attach to spot trades** [read] (`app/plans.js` `pplanMatches` compares
against `'Long'`/`'Short'`; spot trades carry `dir = 'Spot'`). A "PURR long" plan always expires.
**Fix:** let a Long plan match `dir === 'Spot'`.

**E8. README says XP and streaks follow the process score; the code uses Discipline** [read]
(README "The coach" vs `app/progress.js:200-205`, `248`). The Daruma section is right; "The coach"
section is stale. It also doesn't mention that a late plan earns half (8 XP).

---

## Sync, persistence and the server

**S1. High — Restoring a backup or a server snapshot is silently undone if another device has
saved since this tab loaded** [repro] (`app/data-io.js:685-691` full-backup paste, `:706` journal
paste; `app/core.js:315` History → restore; the 409 handler `app/core.js:258-287`). No restore
path marks the journal ids dirty in `_dirtyJ` (`vaultMarkAll` only marks them for the vault). The
next save is at a stale rev, gets 409, and the handler applies the server's snapshot over the
restore, lays back only `_dirtyJ` ids (none), and takes wallets from the server copy. The status
line still says "Backup restored". History restore also reloads right after an unchecked
`writeServer()` — if a save is in flight, `writeServer` only sets `_srvAgain` and the reload
throws the restore away. Reproduced: device A at rev 1, device B wipes the journal (rev 2), A
restores the 2026-09-30 snapshot → server rev 3 with journal `{}`, the app shows `{}`. A pasted
backup with 2 notes and 1 wallet after another device saved → only the other device's note and
0 wallets. Same root cause, smaller: a wallet added or removed here is dropped on any 409 (the
comment says "last write wins"; the server always wins). **Fix:** mark the union of before/after
journal ids dirty and treat restored settings/wallets as local edits — or make restore a forced
write (GET rev, PUT, retry on 409 without merging); report success / reload only after a 2xx;
merge wallets by address as `vaultMerge` does.

**S2. High — Five device settings are wiped on every reload when the server is in use** [repro]
(`app/core.js:328` `initServerSync` → `applySnapshot`, with `app/core.js:58-70` and
`app/boot.js:20`). `initServerSync` runs before `boot.js` loads `settings` from the store, so the
global is still the default `{wallets: [], riskDefault: null}`; `applySnapshot` copies in the
server's fields and `rawSet(S_KEY, settings)` overwrites the stored settings. Every field that
`snapshot()` doesn't carry is lost: `autoRefresh`, `pzTiltAlerts`, `pzTiltNotify`,
`pzCoachDetail`, `taxExport`. This branch runs on every normal boot. Reproduced: set
`autoRefresh = false`, `pzTiltAlerts = false` and a `taxExport` preset, let the save finish
(mark `{rev: 2, dirty: false}`), reload → all three `undefined`; auto-refresh and tilt alerts
switch themselves back on. **Fix:** start `applySnapshot` from the stored settings
(`settings = await Store.get(S_KEY) || settings`); and decide per field whether it syncs (add it
to `snapshot()`) or is device-local (its own key).

**S3. Medium — Off-site DATA_DIR bundles can silently miss committed SQLite data** [repro]
(`offsite.js:63-80` `collectFiles`, `:96-104` `packBundleAsync`; `db.js:65` WAL mode).
`pulse.db`, `-shm` and `-wal` are read by separate async reads with the event loop running in
between; a checkpoint plus the next write restarting the WAL yields the old database file with a
fresh WAL (a large `pulse.db` read in 512 KB chunks can even straddle a checkpoint). Reproduced:
50 member rows in the WAL, a checkpoint and one write after `pulse.db` is read → the restored
bundle has **0 members**, and `integrity_check` says `ok`. `pulse.db` (members, feed, reviews) is
backed up nowhere else. **Fix:** `VACUUM INTO` a temp file (or the backup API) and ship that as
`pulse.db`, without `-wal`/`-shm`.

**S4. Medium — "Today's pre-restore state stays in today's snapshot" is false** [repro]
(`server.js:631-653` `writeData`/`snapshotDaily` overwrite today's file on every write; the text at
`app/core.js:307`, `:310`). The restore's own PUT and every later save replace
`snapshots/<today>.json`, and `.bak` holds only the previous write. Three PUTs — today's work
`{a, b}`, the restore `{old}`, one more edit `{old, c}` — leave today's snapshot as
`{old, c}`: the `{a, b}` work is gone. **Fix:** keep `snapshots/pre-restore-<ts>.json` before a
restore (or any write that drops many journal keys), or keep each day's first write; else fix the
text.

**S5. Low — The weekly digest can be built from stale caches, and posted twice** [read]
(`server.js:1534-1535` with `:1642-1646`). When `_refreshing` is set, `runScheduledRefresh()`
returns at once but `.then(maybeDigest)` still runs, bypassing the "wait for a good refresh"
guard (which checks only `failStreak`): a Monday tick during a manual/boot refresh writes the
week's digest from caches up to an interval old, and it's never rebuilt. Two overlapping digest
calls both see `webhookSent: false` and both post. **Fix:** return a "skipped" flag and skip the
digest; give `maybeDigest` an in-progress guard like `_alertBusy`.

Checked and sound: the `/api/data` PUT (rev read, check and write in one synchronous handler;
tmp + rename; `.bak` never taken from a damaged file; mtime cache invalidated on write); the
refresh generation counter; the SQLite `save()` keeping rows dirty on a failed transaction;
migrations in transactions; admin TOTP replay protection, `timingSafeEqual`, single-use recovery
codes and challenges; passkey single-use challenges and counter check; server-written SIWE
messages with single-use nonces; bearer-token comparison and lockout; push reminders marked
before sending; persisted alert/nudge dedupe; the off-site cadence across restarts; and the
settings baseline added in ba500cd for its stated case.

---

## Checked and found correct

- Pot arithmetic: `gross − floor(burn)` split by `payouts` conserves XP exactly; ties share
  prizes and the rounding remainder goes to first. Cancel / expire / decline refunds, the
  counter-after-accept block, the self-duel block, and the fixes in c8df538 (empty caps,
  competition tie places, the migration) all behaved correctly.
- No in-process double-spend or double settlement: stake checks, `potHold` and settlement are
  synchronous; `status = 'done'` guards re-entry. (Two server instances on one database are not
  supported — each would roll over and overwrite the other.)
- League rollover, seasons and the ladder are persisted and idempotent across restarts.
- Banned members are excluded from rollover, boards, seasons, the ladder and mentor pay, and
  blocked from `/stats`.
- Grants and mentor XP enter the balance exactly once (via the app's total); stake results stay
  out of the app's total. No double counting among achievements, badges and challenges.
- Client `levelFor`/`pzLevelStart` and server `levelOf`/`levelStart` agree (the server clamps a
  posted level to 500, the formulas go to 1000).
- `isoWeekOfKey` across W53 years and year rollover; `disciplineStreak` shields; the multiplier
  applied once per day to score + bonus only.
- Trade reconstruction through flips (long 1 → sell 3 → short 2) and spot partial sales;
  deterministic seeding of every Monte Carlo; `diagScan` FDR, `stateAnalysis` Welch df,
  `changePoint`, `edgeSignificance`, Sharpe/Sortino, the tz/day helpers.

---

## Performance

Measured in Chromium against the real server, with the built-in sample history scaled up
(repeated across time blocks and coin groups; empty journal — real journals make the coach and
game heavier, not lighter). Every item in AUDIT-2's performance list has landed and holds: the
dashboard tab stays under 100 ms even at 31k trades.

| History | Trades | Diagnostic tab | Review tab | Full `render()` | Longest main-thread task |
|---|---|---|---|---|---|
| sample (what e2e uses) | 102 | 272 ms | 147 ms | 229 ms | 0.4 s |
| ~1.5 years | 2,055 | 791 ms | 324 ms | 430 ms | 0.8 s |
| ~3 years | 12,623 | 2.3 s | 523 ms | 1.2 s | 2.4 s |
| heavy trader | 31,233 | **5.6 s** | 1.1 s | 2.2 s | **5.0 s** |

The e2e budgets don't see any of this: they run on ~100 trades with ~5× headroom.

**P1. The Diagnostic tab redoes heavy statistics on the main thread on every render, and renders
twice** (once on open, again when the worker's Monte Carlo lands). Per render at 31k trades:
`walkForward`'s 800-pass bootstrap over every trade ≈ 600 ms (`app/engine.js:596` — outside the
`_diagMC` memo and the worker); `changePoint`'s 200-shuffle permutation test ≈ 550 ms
(`app/diagnostic.js:1031`, via `renderDistribution`, unmemoized); `minerScan` structured-cloning
the trade pool into the worker ≈ 400 ms (`:1185`); `diagScan` and `wireWhatIf` ≈ 650 ms each.
**Fix:** fold `walkForward` and `changePoint` into the `diagmc` worker job and its memo key; memo
the remaining sync panels on the same key so the second render is cheap; send the miner its pool
once per data version. Expected: 5.6 s → under 1 s.

**P2. Trader Age history is recomputed in full on every game rebuild** (`taHistory`,
`app/features/trader-age.js:94-97`, via `pzBadgeCatalog`, `app/progress.js:1220`). It runs a full
`traderAge` (≤200 days × a 20-day window, with `isoWeekOfKey` date allocations) for every trading
day: ~1.2 s per rebuild in the browser profile; 101 / 373 / 809 ms for 150 / 400 / 800 days in
Node. `gameContext` itself is memoized, so this isn't per render — it's per rebuild: every
journal save, every new fill in a live session, every `/me` change, every day rollover.
`pzBadgeCatalog` also runs twice per rebuild and `habitProgress` ~4× per habit. **Fix:** compute
incrementally from the earliest changed day (each day's value depends only on the trailing
window), cache ISO weeks per key.

**P3. A heavy-account e2e case.** Add a 10k–30k-trade run with real budgets so these wins are
measured and can't regress.

**P4. Later:** Daruma downloads 539 KB gzipped, including diagnostic, excursion and tools code it
may never run — candidates for load-on-first-use. The server (`social.js` boards built in memory)
has not been profiled.

---

## Roadmap

0. **Stop losing users' data (S1, S2).** Both are small, contained fixes in `app/core.js` /
   `app/data-io.js` and both lose work silently today. Then S4 (a pre-restore copy) and S3
   (a consistent SQLite snapshot for off-site).
1. **Make the server the source of truth for anything stakeable or ranked (X1, X2, X3, X5, X12).**
   A server ledger: verified XP from `vdays` + grants + awards + mentor XP + `stakeNet`; boards,
   rollover and seasons from it. Until then, the stopgaps: derive level server-side, consistency
   and date checks on `/stats`, rate limit, no stakes without a verified wallet, no profile
   deletion with debt.
2. **Close the duel escapes (D1, D2, D3, D4, D6).** Missing data is never "not over"; freshness
   before settlement; future days rejected; windows start after acceptance; one transaction per
   settlement.
3. **Fix the discipline measurements XP is built on (E1–E5).** E1 first: it is the coach's
   central claim and it currently confirms itself on noise.
4. **Make earned XP stable and unfarmable (X4, X7, X8, X9, X10).** An append-only award ledger
   solves X9 and makes X4/X7/X8 checkable; timestamps on check-ins and limits; the game context
   independent of view/dex filters.
5. **Performance P1–P3.**
6. The Lows.

---

## Resolution

Fixed in five parallel change sets, merged together and re-tested as one. The ones with a
visible effect on members, the owner, or numbers already on screen:

- **XP that moves is now the server's own ledger (X1, X2, X5, D-series).** The balance behind
  stakes, pot buy-ins, mentor fees and coach packs is verified Discipline XP (from the wallet's
  fills, × the Discipline weight × that week's multiplier) + owner grants + server-checked badges
  + mentoring XP ± stake and pot results − fees and purchases (`ledgerOf`, `social.js`). It is not
  floored at zero; a negative balance blocks stakes and spending until earned back. Staking needs
  "Verify my discipline". **Members without a verified wallet now have no stakeable balance**, and
  existing balances drop to what the server can vouch for (a one-time migration credits verified
  days already on file). The XP the app reports is still shown as the member's XP, but the server
  derives the level from it, sums weekly XP from the days itself, rejects future days, freezes a
  day after a week, caps a day at the most the configured weights can pay, and rate-limits
  `/stats`. A profile can't be deleted with XP riding or a negative balance; debt beyond its
  verified XP follows its wallets to a new profile.
- **Duels:** a side that stops sharing returns mid-event, or has no drawdown reading at the end,
  is out; settlement waits for readings taken after the last day (up to a week); a duel accepted
  on a Monday or the 1st starts at the next one; settlement is one transaction; alts on one
  wallet can't duel each other.
- **Discipline and its XP (E1–E5, X4, X10):** the routine-vs-results test now compares like with
  like (post-loss entries that slipped vs those that didn't, days with equal chances), so the
  coin-flip history reads "no link"; stops get the planVerdict slippage band; revenge/size-up see
  every close in the window; the loss limit reads fills, open entries included. Logging earns XP
  only when done in time (`plannedAt` / `limitAt` / `checkinAt`); fields saved before the stamps
  existed keep the benefit of the doubt they always had. XP, level and streak read every trade,
  whatever the view and dex filters show. Scores shift accordingly — mostly up for stop-outs with
  slippage, down where an entry after a breach had been missed.
- **What's earned stays earned (X7–X9, X14):** an append-only award ledger (`settings.pzEarned`,
  synced and merged across devices) keeps achievements, challenges and badges; swaps grade from
  the swap day; badges count distinct goals, habits and leaks. Daily XP itself still re-derives
  when the underlying data changes, and the README now says exactly that.
- **Sync (S1–S5):** restores survive another device's save and report success only after the
  server confirms; reloads lay the server snapshot over local settings (tilt alerts, coach detail
  and the tax preset now sync; auto-refresh and tilt notifications stay per device); the server
  keeps a pre-restore copy; off-site bundles carry a `VACUUM INTO` snapshot of `pulse.db`.

**What X3 leaves self-reported, by design:** the XP shown, its boards and levels (bounded as above,
never backing anything that moves XP); the Trader Age multiplier, which still reads app-reported
logging parts (verified XP can be up to the top tier's factor above fills-only); any public wallet
feeding verified XP if the owner switches off "only count claimed wallets"; a season's last week
during its one-day grace. Mentor fees are not counted toward the monthly pair cap. README
"Limitations" lists these.

**Performance, measured after (31k trades):** Diagnostic 5.3 s → ~0.7 s (no main-thread task over
~0.5 s), full `render()` 2.2 s → ~0.35 s, Daruma 557 → 509 KB gzipped (the Diagnostic, excursion
and export code moved to journal-only files). Results are bit-identical to before, pinned by
`tests/test-perf-paths.mjs` and `e2e/heavy.mjs` (`npm run test:e2e:heavy`, also in CI). Still
known: the very first render after importing a 30k-trade history is one ~0.6 s task (mostly
Chart.js on a cold dashboard; the import itself now yields before it); the Diagnostic's no-worker
fallback is slower than before (~8 s at 31k, it now includes the walk-forward and change point it
used to redo every render); league boards cost ~20 ms at 2,000 members (linear).
