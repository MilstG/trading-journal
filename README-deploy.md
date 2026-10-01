# Deploying Ledger on Railway

Ledger stays a client-side app: all fill reconstruction, statistics, mining, and
excursion analysis run in your browser, talking directly to Hyperliquid. The
companion server (`server.js`, zero npm dependencies) only serves the HTML and
persists one JSON blob — journal entries, wallets, settings, and MAE/MFE
measurements — so they survive reboots, redeploys, and device switches.

## Repo layout

```
ledger.html     the app (unchanged single file — still works from file:// too)
server.js       companion server: persistence + read-only analytics API (/api/v1),
                scheduled refresh, webhook alerts, weekly digests, server backups
help.html       built-in user guide, served at /help (a Help button appears in the app)
social.js       Pulse's leagues, competitions, feed, badges and member accounts (/api/social)
social-config.js  the admin panel's settings and their sanitizers (levels, XP, features, coach, routines)
admin.html      the owner's admin panel, served at /admin
badges.html     a member's public badge page, served at /b/<name>
vendor/         eth-sig.js — signature recovery for wallet claims (bundled, no install)
tech.html       technical reference, served at /docs
db.js           the social layer's SQLite storage (DATA_DIR/pulse.db), its schema and the one-time social.json import
package.json    start script + node version, 22.13+ for node:sqlite (one optional dependency, the Anthropic SDK, used only with COACH_AI)
tests/          test suites (`npm test`; CI runs them on every push)
```

## Railway setup (once)

1. **New project → Deploy from GitHub repo** (or `railway up` from this folder).
   The included `railway.json` sets the start command to **`node server.js`**
   (not `npm start`). This matters: when npm sits between Railway and node,
   the SIGTERM Railway sends on every redeploy makes npm exit non-zero with
   `npm error signal SIGTERM`, and the deployment gets flagged as failed even
   though the server shut down cleanly. Running node directly lets the
   graceful-shutdown handler in `server.js` receive the signal and exit 0.
   If you ever override the start command in the Railway UI, keep it as
   `node server.js`.

2. **Attach a Volume — this is the persistence.** Service → Settings → Volumes →
   Add Volume, mount path **`/data`**. The server auto-detects `/data` and stores
   `ledger-data.json` there (with a `.bak` of the previous revision).
   ⚠ Without a volume, Railway's filesystem is wiped on every redeploy and your
   journal WILL be lost. The server logs a warning at boot if `/data` is missing.

3. **Set `AUTH_TOKEN`** in Service → Variables to a long random string
   (e.g. `openssl rand -hex 24`). Your journal contains wallet addresses and
   trading notes; without a token, anyone who finds the URL can read and write it.

4. Open the generated URL. The app detects the server, asks for the token once
   (remembered per browser), pulls the server snapshot, and from then on every
   journal edit auto-saves within ~1 second. The status bar shows
   `☁ Server sync · rev N · saved`.

## How syncing behaves

- **Reboots/redeploys:** data lives on the volume; the server is stateless.
- **Two devices:** writes carry a revision number. A stale write is refused
  (HTTP 409); the client then applies the newer server state but **merges your
  unsynced edits on top** — journal entries you touched since the last sync,
  and settings fields you changed — and re-syncs the merge at the new
  revision. Neither device's note is silently lost.
- **Stays in the browser (by design):** candle caches and fill caches
  (re-fetchable, large) and journal image attachments. "Backup all" still
  exports everything exportable as a portable JSON.
- **Pulse (`/pulse`):** the same app in its simple dial view, installable as
  its own app. Visitors without the access token keep their journal in their
  own browser and never write to the server; set `AUTH_TOKEN` before sharing
  the link, or everyone who opens it shares your journal.
- **Social + admin:** Pulse's leagues, competitions, feed and posts live in an
  SQLite database, `DATA_DIR/pulse.db` (with `pulse.db-wal` beside it while the server
  runs: back up both, or stop the server first), and members' pictures in
  `DATA_DIR/media/` (2 GB in all). It uses Node's built-in `node:sqlite`, so the
  server needs **Node 22.13 or newer** (`engines` in `package.json` says so; Railway
  follows it) and still installs nothing. A server upgraded from an older version
  imports `DATA_DIR/social.json` once on its first start and renames it
  `social.json.migrated`. Also on the volume: 50 days of each verifying
  member's public fills in `DATA_DIR/social-fills/`. The owner's panel is at `/admin`
  and needs `AUTH_TOKEN` (without it the admin API refuses every request). It manages
  members (add, edit, XP boosts, full unlocks, sign-in codes), leagues, reward badges,
  levels and XP, feature levels, the AI coach's allowances and routines. Public badge
  pages (`/b/<name>`, opt-in per member) need `badges.html` deployed next to `server.js`.
  Members' encrypted journals (ciphertext only; the server can't read them) live in
  `DATA_DIR/vault/`. Wallet claims need `vendor/eth-sig.js` deployed next to
  `social.js` — it's in the repo, with no install step.
- **Standalone still works:** the same `ledger.html` opened from disk or any
  static host simply skips server sync (the boot probe gets no answer) and
  falls back to the linked-data-file / browser storage modes.

## Environment variables

| Var                    | Default                          | Notes |
|------------------------|----------------------------------|-------|
| `PORT`                 | `8080`                           | Railway injects this automatically |
| `AUTH_TOKEN`           | *(empty = API open — don't)*     | Bearer token — everything |
| `READ_TOKEN`           | *(unset)*                        | Optional second token: `GET /api/v1/*` only — for scripts and dashboards. It reads trades, P&L, journal notes, wallet addresses and open positions, so share it only with people you'd show the journal to |
| `CORS_ORIGIN`          | *(unset)*                        | Exact origin allowed to call `/api/*` from a browser app |
| `PUBLIC_ORIGIN`        | *(unset)*                        | The address people open Pulse at (e.g. `https://pulse.example.com`; comma-separate several). Wallet sign-in messages name only this site, so a look-alike site can't collect a valid signature. Not needed on Railway, whose edge only passes the service's own domains (custom ones included); set it when self-hosting |
| `TRUST_PROXY`          | on when on Railway               | Read the visitor's address from `X-Forwarded-For` (the last entry) for rate limits. Only turn on behind a proxy that sets it |
| `DATA_DIR`             | `/data` if present, else `./data`| Where the journal, caches, reports, and backups live |
| `REFRESH_INTERVAL_MIN` | *(unset = off)*                  | Refresh server caches from Hyperliquid on a timer (first run ~30s after boot) |
| `ALERT_WEBHOOK`        | *(unset)*                        | Discord/Slack/ntfy/JSON endpoint for alerts + weekly digests |
| `ALERT_LIQ_PCT`        | `10`                             | Alert when a position is within this % of liquidation |
| `ALERT_DAILY_LOSS`     | *(app's saved rule)*             | $ daily-loss alert threshold |
| `ALERT_FUNDING_24H`    | *(unset = off)*                  | Alert when funding paid per 24h exceeds this $ |
| `TELEGRAM_BOT_TOKEN`   | *(unset)*                        | Telegram bot (from @BotFather): alert/digest delivery + read-only commands |
| `TELEGRAM_CHAT_ID`     | *(unset)*                        | Comma-separated chat-id allowlist; other chats are ignored silently |
| `NUDGE_HOUR`           | *(unset = off)*                  | End-of-day journaling nudge after this hour (0–23); needs `REFRESH_INTERVAL_MIN` and a delivery channel |
| `NUDGE_TZ`             | `UTC`                            | Fallback IANA zone for `NUDGE_HOUR` and "today" until the app reports its own (it follows the app's clock setting) |
| `TELEGRAM_SHARE_CHAT_ID` | *(unset)*                     | Accountability partner/group chat(s) for Review → Progress → "Send to partner" (needs `TELEGRAM_BOT_TOKEN`) |
| `COACH_AI`             | *(unset = off)*                  | `1` enables the AI weekly letter in Review and the AI coach chat in Pulse (needs `ANTHROPIC_API_KEY`; Railway's `npm install` pulls the optional SDK). Chat allowances are set in `/admin` → Coach |
| `ANTHROPIC_API_KEY`    | *(unset)*                        | Claude API key, only read when `COACH_AI=1` |
| `COACH_AI_MODEL`       | `claude-opus-5-5`                | Model for the weekly letter and the coach chat |
| `PUSH`                 | *(on)*                           | `0` switches web push reminders off. On by default: the server makes its own push keys (VAPID) once, in `DATA_DIR/vapid.json` |
| `PUSH_SUBJECT`         | `mailto:pulse@localhost`         | Contact the browsers' push services can reach you at — set a real `mailto:` or `https://` address |
| `WHOOP_CLIENT_ID` / `WHOOP_CLIENT_SECRET` | *(unset)*  | Lets people connect WHOOP for readiness. Register an app at developer.whoop.com with the redirect URL `<PUBLIC_ORIGIN>/api/wear/whoop/callback` |
| `OURA_CLIENT_ID` / `OURA_CLIENT_SECRET`   | *(unset)*  | The same for Oura (cloud.ouraring.com → OAuth applications), redirect `<PUBLIC_ORIGIN>/api/wear/oura/callback` |

The analytics API, scheduled refresh, alerts, and weekly digests are documented
in the main [README](README.md).

## Verifying persistence

After entering a journal note, redeploy the service, reload the page:
the note should still be there and the rev counter advanced. Or from a shell:
`curl -H "Authorization: Bearer $AUTH_TOKEN" https://<your-app>.up.railway.app/api/data`
