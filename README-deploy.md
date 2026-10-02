# Deploying Ledger on Railway

Ledger stays a client-side app: all fill reconstruction, statistics, mining, and
excursion analysis run in your browser, talking directly to Hyperliquid. The
companion server (`server.js`, zero npm dependencies) only serves the HTML and
persists one JSON blob — journal entries, wallets, settings, and MAE/MFE
measurements — so they survive reboots, redeploys, and device switches.

## Repo layout

```
ledger.html     the app's page (markup, styles, fonts) — still works from file:// with app/ beside it
app/            the app's code: chart.umd.js + 15 parts loaded in order (core.js, venues.js … boot.js)
app-source.js   the page with app/ inlined — what the analytics engine and the tests read
server.js       companion server: persistence + read-only analytics API (/api/v1),
                scheduled refresh, webhook alerts, weekly digests, server backups
help.html       built-in user guide, served at /help (a Help button appears in the app)
social.js       Keel's leagues, competitions, feed, badges and member accounts (/api/social)
social-config.js  the admin panel's settings and their sanitizers (levels, XP, features, coach, routines)
admin.html      the owner's admin panel, served at /admin
badges.html     a member's public badge page, served at /b/<name>
vendor/         eth-sig.js — signature recovery for wallet claims (bundled, no install)
tech.html       technical reference, served at /docs
db.js           the social layer's SQLite storage (DATA_DIR/pulse.db), its schema and the one-time social.json import
package.json    start script + node version, 22.13+ for node:sqlite (one optional dependency, the Anthropic SDK, used only with COACH_AI on Anthropic)
webauthn.js     passkey (WebAuthn) checks for Keel sign-in, no dependencies
offsite.js      encrypted off-site backups to any S3-compatible bucket, plus the restore CLI
cex-relay.js    forwards browser-signed, read-only Bybit/Binance requests (POST /api/cex/relay)
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
- **Closing right after an edit:** a save goes out 0.8 s after the last change.
  If the page is closed or reloaded before that, the browser remembers it has
  unsent edits and the server revision they were made on; at the next start, if
  no other device has saved since, it keeps its own copy and sends it (rather
  than taking the server's older one). Plugs and habits merge item by item.
- **Stays in the browser (by design):** candle caches and fill caches
  (re-fetchable, large) and journal image attachments. "Backup all" still
  exports everything exportable as a portable JSON.
- **Keel (`/keel`):** the same app in its simple dial view, installable as
  its own app. Visitors without the access token keep their journal in their
  own browser and never write to the server; set `AUTH_TOKEN` before sharing
  the link, or everyone who opens it shares your journal.
- **Social + admin:** Keel's leagues, competitions, feed and posts live in an
  SQLite database, `DATA_DIR/pulse.db` (with `pulse.db-wal` beside it while the server
  runs: back up both, or stop the server first), and members' pictures in
  `DATA_DIR/media/` (2 GB in all). It uses Node's built-in `node:sqlite`, so the
  server needs **Node 22.13 or newer** (`engines` in `package.json` says so; Railway
  follows it) and still installs nothing. A server upgraded from an older version
  imports `DATA_DIR/social.json` once on its first start and renames it
  `social.json.migrated`. Also on the volume: 50 days of each verifying
  member's public fills in `DATA_DIR/social-fills/`. The owner's panel is at `/admin`
  and needs `AUTH_TOKEN` (without it the admin API refuses every request), plus a second
  factor where `ADMIN_2FA` asks for one (kept in `DATA_DIR/admin-2fa.json`; the panel's
  two-factor screens are `admin2fa-ui.js`, deployed next to `admin.html`). It manages
  members (add, edit, XP boosts, full unlocks, sign-in codes), leagues, reward badges,
  levels and XP, feature levels, the AI coach's allowances and routines. Public badge
  pages (`/b/<name>`, opt-in per member) need `badges.html` deployed next to `server.js`.
  Members' encrypted journals (ciphertext only; the server can't read them) live in
  `DATA_DIR/vault/`. Wallet claims need `vendor/eth-sig.js` deployed next to
  `social.js` — it's in the repo, with no install step.
- **Standalone still works:** the same `ledger.html` (with the `app/` folder beside
  it) opened from disk or any static host simply skips server sync (the boot probe gets no answer) and
  falls back to the linked-data-file / browser storage modes.

## Environment variables

| Var                    | Default                          | Notes |
|------------------------|----------------------------------|-------|
| `PORT`                 | `8080`                           | Railway injects this automatically |
| `AUTH_TOKEN`           | *(empty = API open — don't)*     | Bearer token — everything |
| `READ_TOKEN`           | *(unset)*                        | Optional second token: `GET /api/v1/*` only — for scripts and dashboards. It reads trades, P&L, journal notes, wallet addresses and open positions, so share it only with people you'd show the journal to |
| `AUTH_FAIL_MAX`        | `20`                             | Wrong tokens from one address within 10 minutes before that address is locked out (429) of every token-gated route |
| `AUTH_LOCK_MIN`        | `15`                             | How long that lockout lasts, in minutes |
| `ADMIN_2FA`            | `optional`                       | Second factor for the admin panel (`/api/social/admin/*` only; the token keeps working alone everywhere else): `optional` — each person turns it on by adding an admin passkey or an authenticator app under Settings → Security; `required` — the owner and every admin need it; `off` — never asked for. An unrecognised value counts as `required` |
| `ADMIN_2FA_RESET`      | *(unset)*                        | Escape hatch if the owner lost every second factor: set it (e.g. `1`), restart, then remove it. Clears the owner's admin passkeys, app and recovery codes and ends every admin session; each value resets once. Or run `node server.js --reset-admin-2fa` |
| `CORS_ORIGIN`          | *(unset)*                        | Exact origin allowed to call `/api/*` from a browser app |
| `PUBLIC_ORIGIN`        | *(unset)*                        | The address people open Keel at (e.g. `https://pulse.example.com`; comma-separate several). Wallet sign-in messages name only this site, so a look-alike site can't collect a valid signature. Not needed on Railway, whose edge only passes the service's own domains (custom ones included); set it when self-hosting |
| `TRUST_PROXY`          | on when on Railway               | Read the visitor's address from `X-Forwarded-For` (the last entry) for rate limits. Only turn on behind a proxy that sets it |
| `DATA_DIR`             | `/data` if present, else `./data`| Where the journal, caches, reports, and backups live |
| `REFRESH_INTERVAL_MIN` | *(unset = off)*                  | Refresh server caches from Hyperliquid on a timer (first run ~30s after boot) |
| `ALERT_WEBHOOK`        | *(unset)*                        | Discord/Slack/ntfy/JSON endpoint for alerts + weekly digests |
| `ALERT_LIQ_PCT`        | `10`                             | Alert when a position is within this % of liquidation |
| `ALERT_DAILY_LOSS`     | *(app's saved rule)*             | $ daily-loss alert threshold |
| `ALERT_FUNDING_24H`    | *(unset = off)*                  | Alert when funding paid per 24h exceeds this $ |
| `HEALTH_FAIL_RUNS`     | `3`                              | Tell the alert channels when this many scheduled refreshes fail in a row (and once more when it recovers). `0` = off |
| `HEALTH_DISK_PCT`      | `90`                             | Tell the alert channels when the data volume is this % full (`0` = off) … |
| `HEALTH_DISK_MIN_MB`   | `100`                            | … or has less than this many MB free (`0` = off). Health alerts repeat at most once a day; needs `REFRESH_INTERVAL_MIN` |
| `OFFSITE_ENDPOINT`     | *(unset = off)*                  | S3-compatible endpoint for **encrypted off-site backups**, e.g. `https://<account>.r2.cloudflarestorage.com` (R2), `https://s3.eu-west-1.amazonaws.com` (AWS), `https://s3.us-west-004.backblazeb2.com` (B2) |
| `OFFSITE_BUCKET`       | *(unset)*                        | Bucket name (create it first; path-style addressing) |
| `OFFSITE_ACCESS_KEY_ID` / `OFFSITE_SECRET_ACCESS_KEY` | *(unset)* | An API key that can put, get, list and delete objects in that bucket — scope it to that one bucket |
| `OFFSITE_KEY`          | *(unset)*                        | Encryption passphrase. Everything is encrypted before upload; **lose this and the off-site copies are unreadable** — keep it somewhere other than Railway |
| `OFFSITE_REGION`       | `auto` on R2, else `us-east-1`   | Signing region |
| `OFFSITE_PREFIX`       | `ledger/`                        | Key prefix inside the bucket |
| `OFFSITE_KEEP`         | `30`                             | Newest N of each kind (backups, data bundles) kept in the bucket |
| `OFFSITE_EVERY_H`      | `24`                             | How often a full `DATA_DIR` bundle ships |
| `OFFSITE_MAX_MB`       | `256`                            | Bundle size cap: past it, attachments are left out first, then fill caches; the journal always ships |
| `TELEGRAM_BOT_TOKEN`   | *(unset)*                        | Telegram bot (from @BotFather): alert/digest delivery + read-only commands |
| `TELEGRAM_CHAT_ID`     | *(unset)*                        | Comma-separated chat-id allowlist; other chats are ignored silently |
| `NUDGE_HOUR`           | *(unset = off)*                  | End-of-day journaling nudge after this hour (0–23); needs `REFRESH_INTERVAL_MIN` and a delivery channel |
| `NUDGE_TZ`             | `UTC`                            | Fallback IANA zone for `NUDGE_HOUR` and "today" until the app reports its own (it follows the app's clock setting) |
| `TELEGRAM_SHARE_CHAT_ID` | *(unset)*                     | Accountability partner/group chat(s) for Review → Progress → "Send to partner" (needs `TELEGRAM_BOT_TOKEN`) |
| `COACH_AI`             | *(unset = off)*                  | `1` enables the AI weekly letter in Review and the AI coach chat in Keel (needs `ANTHROPIC_API_KEY`, or `OPENAI_API_KEY` with OpenAI; Railway's `npm install` pulls the optional SDK). Chat allowances are set in `/admin` → Coach |
| `ANTHROPIC_API_KEY`    | *(unset)*                        | Claude API key, only read when `COACH_AI=1` |
| `COACH_AI_PROVIDER`    | `anthropic` (`openai` for a `gpt-…` model) | Which AI runs the coach: `anthropic` or `openai` |
| `COACH_AI_MODEL`       | `claude-opus-5-5`, or `gpt-5.6-luna` with OpenAI | Model for the weekly letter and the coach chat |
| `OPENAI_API_KEY`       | *(unset)*                        | OpenAI API key, read when the coach uses OpenAI (no package to install) |
| `COACH_AI_EFFORT`      | `low` chat, `medium` letter      | OpenAI reasoning effort for both; `none` sends no setting. Lower is cheaper |
| `OPENAI_BASE_URL`      | `https://api.openai.com/v1`      | A compatible endpoint instead (Azure OpenAI, AWS Bedrock's `/openai/v1`) |
| `PUSH`                 | *(on)*                           | `0` switches web push reminders off. On by default: the server makes its own push keys (VAPID) once, in `DATA_DIR/vapid.json` |
| `PUSH_SUBJECT`         | `mailto:pulse@localhost`         | Contact the browsers' push services can reach you at — set a real `mailto:` or `https://` address |
| `WHOOP_CLIENT_ID` / `WHOOP_CLIENT_SECRET` | *(unset)*  | Lets people connect WHOOP for readiness. Register an app at developer.whoop.com with the redirect URL `<PUBLIC_ORIGIN>/api/wear/whoop/callback` |
| `OURA_CLIENT_ID` / `OURA_CLIENT_SECRET`   | *(unset)*  | The same for Oura (cloud.ouraring.com → OAuth applications), redirect `<PUBLIC_ORIGIN>/api/wear/oura/callback` |

The analytics API, scheduled refresh, alerts, and weekly digests are documented
in the main [README](README.md).

## Off-site backups

The server's backups sit on the same volume as the data they protect. Set the five
required `OFFSITE_*` variables (endpoint, bucket, the two keys, and the passphrase) and
the server also sends an **encrypted** copy to an S3-compatible bucket: every
"Backup to server" as it's made, and a bundle of `DATA_DIR` (journal, members, vault,
caches, attachments, reports) once a day. Encryption is AES-256-GCM, keyed from
`OFFSITE_KEY`, done before anything leaves the server, so the storage provider only
ever holds ciphertext. If only some of the variables are set, the boot log warns and
off-site backups stay off. A failed upload goes to the alert channels.
`GET /api/v1/meta` shows the last success or error, and `POST /api/offsite/run` (full
token) ships a bundle right away, which is a good way to test the setup.

Cloudflare R2 is the cheapest fit: no egress fees, and 10 GB is free. Create a bucket and
an R2 API token with *Object Read & Write* on that one bucket.

To restore, run this on any machine with Node and the same `OFFSITE_*` variables:

```bash
node offsite.js list                                  # what's in the bucket
node offsite.js restore ledger/data/<stamp>.bundle.gz.enc ./data   # unpack a DATA_DIR
node offsite.js get ledger/backup/<stamp>.json.gz.enc backup.json  # an app backup → "Open existing"
```

Point `DATA_DIR` at the restored folder (or copy it onto a fresh volume) and start the server.

## Exchange APIs (Bybit, Binance)

Hyperliquid and Lighter are read straight from the browser and need nothing here.
Bybit and Binance don't accept calls from a web page, so the browser signs each
request with the member's read-only key and posts it to this server's
`POST /api/cex/relay`, which forwards it. The relay only forwards `GET`s to the
exchanges' own hosts, on the read-only endpoints the app uses, with only the signing
headers. It never sees an API secret. It's open to the owner's token and to Keel
members, and each caller gets `CEX_RELAY_PER_MIN` requests a minute.

**Region matters.** The exchanges refuse some countries by the caller's IP, and the
caller is your server. Both refuse the **US**, which rules out Railway's US regions.
Railway's EU West region is in the Netherlands, which Binance doesn't serve, and its
Southeast Asia region is in Singapore, which Bybit doesn't serve. The lists change, so check
each exchange's restricted-countries page. When an exchange refuses, the app tells the
member exactly that, not "bad key".

Two ways to fix it:

1. **Run the whole server in a region both serve** (e.g. a VPS in Japan or
   Germany, whatever the current lists allow).
2. **Keep the server where it is and add a relay** in a region the exchange serves:
   deploy this same repository a second time (another Railway service in a different
   region, or any small VM) with
   `CEX_RELAY_ONLY=1` and a long random `CEX_RELAY_SECRET`. It then answers nothing
   but `/api/health` and the relay, and only to callers that present the secret. On
   the main server set `CEX_RELAY_URL` to the relay's address and the same
   `CEX_RELAY_SECRET`. Per-exchange overrides (`CEX_RELAY_URL_BYBIT`,
   `CEX_RELAY_URL_BINANCE`) let each exchange use a relay in a region it serves.

| Var | Default | Notes |
|---|---|---|
| `CEX_RELAY_URL` | *(unset)* | Pass Bybit/Binance requests to a relay copy at this address instead of calling the exchange from here |
| `CEX_RELAY_URL_BYBIT` / `CEX_RELAY_URL_BINANCE` | *(unset)* | The same, per exchange (wins over `CEX_RELAY_URL`) |
| `CEX_RELAY_SECRET` | *(unset)* | Shared by the main server and the relay copy |
| `CEX_RELAY_ONLY` | *(off)* | `1` on the relay copy: relay and health check only |
| `CEX_RELAY_PER_MIN` | `1200` | Relayed requests per caller per minute (a first two-year Bybit load is a few hundred) |
| `BYBIT_API_HOST` | `api.bybit.com` | Another Bybit API host if your account lives on one (e.g. a regional entity's) |

If a member puts an IP restriction on their Binance key, it must include the IP the
exchange sees: the relay's, or this server's if there is no relay. Railway's outbound
IPs aren't fixed unless you enable a static IP, so a key without an IP restriction is
simpler. Bybit expires keys with no IP restriction after 90 days, and the app shows the
expiry date when the key is connected.

## Verifying persistence

After entering a journal note, redeploy the service, reload the page:
the note should still be there and the rev counter advanced. Or from a shell:
`curl -H "Authorization: Bearer $AUTH_TOKEN" https://<your-app>.up.railway.app/api/data`
