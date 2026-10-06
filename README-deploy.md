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
social.js       Daruma's leagues, competitions, feed, badges and member accounts (/api/social)
social-config.js  the admin panel's settings and their sanitizers (levels, XP, features, coach, routines)
admin.html      the owner's admin panel, served at /admin
badges.html     a member's public badge page, served at /b/<name>
vendor/         eth-sig.js — signature recovery for wallet claims (bundled, no install)
tech.html       technical reference, served at /docs
db.js           the social layer's SQLite storage (DATA_DIR/pulse.db), its schema and the one-time social.json import
package.json    start script + node version, 22.13+ for node:sqlite (one optional dependency, the Anthropic SDK, used only with COACH_AI on Anthropic)
webauthn.js     passkey (WebAuthn) checks for Daruma sign-in, no dependencies
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
   Until it's set, the journal's sync bar, Daruma and `/admin` say so (and the
   admin panel stays closed).

4. Open the generated URL. The app detects the server, asks for the token once
   (remembered per browser), pulls the server snapshot, and from then on every
   journal edit auto-saves within ~1 second. The status bar shows
   `☁ Server sync · rev N · saved`.

## How syncing behaves

- **Reboots/redeploys:** data lives on the volume; the server is stateless.
- **Two devices:** writes carry a revision number. A stale write is refused
  (HTTP 409); the client then applies the newer server state but **merges your
  unsynced edits on top** — settings fields you changed, wallets you added or
  removed (merged by address), and journal entries you touched since the last
  sync, **field by field**: each is compared with the copy both devices last
  agreed on, so a tag added on the phone and a note written on the laptop both
  stay; lists (tags, mistakes) merge item by item; an entry deleted on one device
  and edited on the other is kept. When **both devices changed the same text**
  (the same note), neither is dropped: the merged note holds the other device's
  text, then a line `——— also edited on another device; this device’s version: ———`,
  then this device's, and the sync bar shows "⚠ N notes edited on two devices —
  both versions kept" until the next reload, so you can tidy it up. Any other
  value both changed (a rating, a setup) keeps the device that saved last. The
  merge is re-synced at the new revision. An open tab also checks for a newer
  revision when it comes back into view or gets focus, and once a minute while
  visible (a tiny `GET /api/data?only=rev`), and takes it the same way, so it
  doesn't sit on a stale "saved". A restore (a pasted backup or journal, or a server
  snapshot) counts as an edit of everything it touched, and says "restored"
  only once the server has saved it; the server first keeps the state it
  replaces as `snapshots/pre-restore-<time>.json` (newest 5, listed in the
  app's snapshot history as "before restore"). A few settings stay per
  device and never sync: auto-refresh and tilt notifications.
- **Closing right after an edit:** a save goes out 0.8 s after the last change.
  If the page is closed or reloaded before that, the browser remembers it has
  unsent edits and the server revision they were made on; at the next start, if
  no other device has saved since, it keeps its own copy and sends it (rather
  than taking the server's older one). Plugs and habits merge item by item.
- **The server's data goes backwards:** redeployed without its volume, the
  volume wiped, or `DATA_DIR` restored from an older bundle. Every write records
  the store's id (made at its first save) and the time of each revision, and the
  browser remembers which version it last matched. A server that comes back
  empty, with another store, or with an older (or rewritten) revision is not
  "another device saved": the browser keeps its own copy, merges it over the
  server's (entries only one side has are kept; one both have goes to the later
  edit) and saves it back as a restore, so the server first keeps what it had as
  "before restore". The status line says what happened. A server whose data file
  disappears while it runs answers `503` instead of "no data yet" until it's back
  (or restarted). To really go back to an older copy, use **History → restore**:
  that is a restore, and wins.
- **Stays in the browser (by design):** candle caches and fill caches
  (re-fetchable, large). Journal image attachments sync on their own, per trade
  (`/api/att`, size-capped), so they follow you to other devices, but they aren't
  in the daily snapshots or in "Backup all", which still exports everything else
  as a portable JSON. "Backup to server" copies sit in the sync bar's **History**,
  ready to restore.
- **Daruma (`/daruma`):** the same app in its simple dial view, installable as
  its own app. Visitors without the access token keep their journal in their
  own browser and never write to the server; set `AUTH_TOKEN` before sharing
  the link, or everyone who opens it shares your journal.
- **Social + admin:** Daruma's leagues, competitions, feed and posts live in an
  SQLite database, `DATA_DIR/pulse.db` (with `pulse.db-wal` beside it while the server
  runs: back up both, or stop the server first; the off-site bundle ships one consistent
  copy made by SQLite itself), and members' pictures in
  `DATA_DIR/media/` (2 GB in all). It uses Node's built-in `node:sqlite`, so the
  server needs **Node 22.13 or newer** (`engines` in `package.json` says so; Railway
  follows it) and still installs nothing. A server upgraded from an older version
  imports `DATA_DIR/social.json` once on its first start and renames it
  `social.json.migrated`. Also on the volume: 50 days of each verifying
  member's public fills in `DATA_DIR/social-fills/`. The owner's panel is at `/admin`
  and needs `AUTH_TOKEN` (without it the admin API refuses every request, and the panel
  says so as it opens). It signs in with the token this browser's journal has saved, and
  keeps a token typed there only once it has worked; its **Sign out** signs out of the
  panel only, so the journal on that browser keeps syncing. Plus a second
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
| `AUTH_FAIL_MAX`        | `20`                             | Wrong tokens from one address within 10 minutes before that address is locked out (429) of every token-gated route. Each distinct wrong token counts once, however many requests carry it (a page's parallel calls, a stale saved token retrying) |
| `AUTH_LOCK_MIN`        | `15`                             | How long that lockout lasts, in minutes |
| `ADMIN_2FA`            | `optional`                       | Second factor for the admin panel (`/api/social/admin/*` only; the token keeps working alone everywhere else): `optional` — each person turns it on by adding an admin passkey or an authenticator app under Settings → Security; `required` — the owner and every admin need it; `off` — never asked for. An unrecognised value counts as `required` |
| `ADMIN_2FA_RESET`      | *(unset)*                        | Escape hatch if the owner lost every second factor: set it (e.g. `1`), restart, then remove it. Clears the owner's admin passkeys, app and recovery codes and ends every admin session; each value resets once. Or run `node server.js --reset-admin-2fa` |
| `CORS_ORIGIN`          | *(unset)*                        | Exact origin allowed to call `/api/*` from a browser app |
| `PUBLIC_ORIGIN`        | *(unset)*                        | The address people open Daruma at (e.g. `https://pulse.example.com`; comma-separate several). Wallet sign-in messages name only this site, so a look-alike site can't collect a valid signature. Not needed on Railway, whose edge only passes the service's own domains (custom ones included); set it when self-hosting |
| `ARCHIVE_AWS_KEY_ID` / `ARCHIVE_AWS_SECRET` | *(unset)* | An AWS access key that can read Hyperliquid's node-data archive (`s3:GetObject` and `s3:ListBucket` on `hl-mainnet-node-data`, a requester-pays bucket — the transfer is billed to that AWS account). Turns on Data health → **Recover from the archive** (and Wallets ▾ → **Archive**; owner token only, refused when `AUTH_TOKEN` is unset), which pulls the fills the public API no longer serves (TWAP slices older than ~3 months) for the hours a wallet's seams need. See "Recovering fills from Hyperliquid's archive" |
| `ARCHIVE_COST_PER_GB`  | `0.09`                           | The egress price used in the archive's estimates |
| `ARCHIVE_MAX_WINDOW_DAYS` | `14`                          | A seam wider than this (days between a coin's last served fill and the fill that revealed the gap) is skipped by the backfill and reported instead |
| `ARCHIVE_BUCKET` / `ARCHIVE_PREFIX` / `ARCHIVE_REGION` | `hl-mainnet-node-data` / `node_fills_by_block/hourly/` / *(learned)* | Where the archive is; only for a mirror or a format change |
| `ARCHIVE_INDEX_BUCKET` / `ARCHIVE_INDEX_PREFIX` / `ARCHIVE_INDEX_REGION` | *(unset)* / `index/v1/` / *(learned)* | The index by wallet built by `archive-indexer.js` (see "An index by wallet"). With it set, Backfill reads a wallet's whole history from the index instead of hunting hours |
| `DEFAULT_THEME`        | *(unset = `ts9`)*                | The colorway the app opens in for anyone who hasn't picked one: `ts9` (acid green on black), `ink` (midnight) or `bb` (black & amber). Flip it and restart to re-theme every screen without a code change; a user's own pick always wins |
| `HOME_VIEW`            | *(unset = journal)*              | `daruma` (or `keel`, its earlier name) makes the site's root (`/`) redirect to Daruma (`/daruma`), for a site that's mainly Daruma. The full journal stays at `/ledger.html`, and the installed journal app opens there |
| `TRUST_PROXY`          | on when on Railway               | Read the visitor's address from `X-Forwarded-For` (the last entry) for rate limits. Only turn on behind a proxy that sets it |
| `DATA_DIR`             | `/data` if present, else `./data`| Where the journal, caches, reports, and backups live |
| `REFRESH_INTERVAL_MIN` | *(unset = off)*                  | Refresh server caches from Hyperliquid on a timer (first run ~30s after boot) |
| `STATS_SWEEP`          | on                               | Members' returns and verified Discipline re-read in the background: every 4 h for members seen this week or in a running comp/duel, 12 h for this month, 2 days for the last 6 months. `off` leaves it to the boards and profiles people open |
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
| `COACH_AI`             | *(unset = off)*                  | `1` enables the AI weekly letter in Review and the AI coach chat in Daruma (needs `ANTHROPIC_API_KEY`, or `OPENAI_API_KEY` with OpenAI; Railway's `npm install` pulls the optional SDK). Chat allowances are set in `/admin` → Coach |
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

## Recovering fills from Hyperliquid's archive

Hyperliquid keeps TWAP slice fills for about three months and ordinary fills for a finite time. A
wallet added to Ledger later has **seams**: a perp fill that starts from a position no earlier fill
reaches. The data-health strip counts them, keeps the affected trades out of the stats, and leads the
all-time headline with Hyperliquid's own P&L figure. The fills themselves still exist: Hyperliquid's
node software streams every fill of every address into a requester-pays S3 bucket
(`hl-mainnet-node-data`, `node_fills_by_block/hourly/{YYYYMMDD}/{hour}.lz4`), and the server can read it.

1. In AWS, create an IAM user with this policy and an access key:
   `{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":["s3:GetObject","s3:ListBucket"],"Resource":["arn:aws:s3:::hl-mainnet-node-data","arn:aws:s3:::hl-mainnet-node-data/*"]}]}`
2. Set `ARCHIVE_AWS_KEY_ID` and `ARCHIVE_AWS_SECRET` on the service and redeploy. Nothing is
   downloaded until you ask.
3. In the journal, Data health → **Recover from the archive…** → **Check coverage**: the archive's
   first and last day, one day's size, and per wallet the hours its seams need, how many of them the
   archive has, and what they would cost (`$0.09/GB` by default). **Fetch a sample hour** shows a
   file's format and how many of the wallet's fills it holds.
4. **Backfill** downloads only those hours (within the GB cap you set; a plan over the cap is refused
   with its size), keeps the wallet's fills, and merges them into the server's fill cache
   (`GET /api/v1/archive` reports progress). The journal then merges the server's copy into the
   browser's cache on its next load and reconstructs: the seams close, the trades come back with
   their real exits, and the fill-based total moves toward the verified figure.

Hours before the archive's first day stay unrecoverable; the exchange's own figure covers them. The
same endpoints work from scripts: `POST /api/v1/archive/check`, `/sample`, `/backfill`
(`{address, maxGB, scope}`), `/stop`, all with the owner token.

### An index by wallet (for many wallets, or for good)

Hunting hours works for one wallet. For every member's wallet, forever, build the index once:
`archive-indexer.js` rewrites each hour of the archive into 4,096 files by the first three hex
characters of the wallet address, one set per day (`index/v1/d/{YYYYMMDD}/{shard}.jsonl.gz`, each
line `[address, fill]`), so one wallet's whole history is its shard's file for every day — about
1/4096 of the archive, a few MB a month. It runs on a machine **inside AWS, in the archive's
region (`ap-northeast-1`)**, where reading S3 costs no transfer: the whole archive (300 GB and
growing 0.7 GB a day) is read for the price of the instance hours; the index is kept in a bucket of
yours in the same region (~$0.023/GB-month) and read by the server with the same key.

1. **Bucket**: S3 → Create bucket, in **Asia Pacific (Tokyo)**, e.g. `hl-fills-index-<yourname>`,
   defaults otherwise. Create it **in the same AWS account as the `ledger-archive` user** (in the
   new project-based AWS experience each project can be its own account: the user and the bucket
   must be in the same one). If Check coverage then says `AccessDenied … because no
   resource-based policy allows`, the bucket landed in another account: either re-create it next to
   the user, or give the user access from the bucket's side (S3 → the bucket → Permissions → Bucket
   policy) with a statement allowing `arn:aws:iam::<account>:user/ledger-archive` the actions
   `s3:ListBucket` on `arn:aws:s3:::hl-fills-index-<yourname>` and `s3:GetObject` on
   `arn:aws:s3:::hl-fills-index-<yourname>/*`. Until the index is readable (or while it has no
   finished day yet) Backfill falls back to the hours plan on its own and says so.
2. **Role for the machine**: IAM → Roles → Create role → AWS service → EC2 → attach
   `AmazonS3ReadOnlyAccess` plus an inline policy allowing `s3:PutObject`, `s3:GetObject`,
   `s3:DeleteObject`, `s3:ListBucket` on `arn:aws:s3:::hl-fills-index-<yourname>` and `/*`. Name it
   `ledger-indexer`.
3. **Machine**: EC2 (region Tokyo) → Launch instance: Amazon Linux 2023 (64-bit **Arm**),
   `t4g.medium` (2 vCPU, 4 GB; the whole archive takes a few hours), 30 GB disk, IAM instance
   profile `ledger-indexer`, no inbound ports needed. In **Advanced details → User data**, paste the
   script below with your bucket and your Ledger server's address. It installs Node, fetches the two
   files from your server, builds the index, and installs a daily timer that indexes yesterday.
4. Watch: Data health → Recover from the archive → **Check coverage** shows the index's days as
   they land (`progress.json`: its "last day" is the build's position); or EC2 → the instance →
   Monitor and troubleshoot → Get system log, where the script reports each step and the build log's
   first lines. A running build keeps the CPU near 100%. The build runs as a systemd service that
   restarts where it left off if it dies (each finished day is marked in the bucket), and the
   workers hand their output over in slices, so an hour of 300k fills needs well under 1 GB.
5. **Railway → Variables**: `ARCHIVE_INDEX_BUCKET=hl-fills-index-<yourname>`,
   `ARCHIVE_INDEX_REGION=ap-northeast-1`. From then on every load brings old history back by itself:
   the browser asks `GET /api/v1/archive-fills/<wallet>` (the owner for any wallet, a Pulse member for
   their own) for the wallet's archived fills — the whole history once, then only new days — and
   merges them; nobody presses anything. **Backfill** still reads a wallet's whole history
   from the index (every day it has, a few MB) instead of hunting hours; `source: "hours"` on the
   endpoint still takes the old path.
6. When the build is done, switch to the schedule below: a machine that starts twice a day,
   catches the index up and stops itself costs cents a month instead of running all the time.

```bash
#!/bin/bash
# user data for the indexer machine (Amazon Linux 2023, arm64). Fill in the two lines below.
# Every step reports to the system log (EC2 → Actions → Monitor and troubleshoot → Get system log).
INDEX_BUCKET=hl-fills-index-yourname
LEDGER=https://your-app.up.railway.app
say() { echo "hl-index: $*" | tee /dev/console; }
# swap, as a safety net: without it a busy hour that outgrows RAM gets the build killed outright
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile && echo '/swapfile none swap sw 0 0' >>/etc/fstab && say "swap on"
dnf install -y nodejs20 >/var/log/indexer-install.log 2>&1 || dnf install -y nodejs >>/var/log/indexer-install.log 2>&1
NODE=$(command -v node || ls /usr/bin/node-* 2>/dev/null | head -1); say "node is ${NODE:-MISSING} $($NODE -v 2>/dev/null)"
mkdir -p /opt/hl-index && cd /opt/hl-index
for f in archive.js archive-indexer.js; do
  if curl -fSL -o "$f" "$LEDGER/archive/$f" 2>/tmp/curl.err; then say "fetched $f ($(wc -c <"$f") bytes)"; else say "FAILED to fetch $LEDGER/archive/$f: $(cat /tmp/curl.err)"; fi
done
# the one-time build, as a service that restarts where it left off if it ever dies
cat >/etc/systemd/system/hl-index-build.service <<EOF
[Unit]
Description=Hyperliquid fills index: the one-time build
After=network-online.target
StartLimitIntervalSec=3600
StartLimitBurst=5
[Service]
Type=simple
WorkingDirectory=/opt/hl-index
Environment=INDEX_BUCKET=$INDEX_BUCKET WORKDIR=/var/tmp/hl-index
ExecStart=$NODE /opt/hl-index/archive-indexer.js build --workers 2
Restart=on-failure
RestartSec=30
StandardOutput=append:/var/log/hl-index-build.log
StandardError=append:/var/log/hl-index-build.log
EOF
# the daily catch-up (yesterday and any of the last 7 days still missing)
cat >/etc/systemd/system/hl-index-daily.service <<EOF
[Service]
Type=oneshot
WorkingDirectory=/opt/hl-index
Environment=INDEX_BUCKET=$INDEX_BUCKET WORKDIR=/var/tmp/hl-index
ExecStart=$NODE /opt/hl-index/archive-indexer.js daily
EOF
cat >/etc/systemd/system/hl-index-daily.timer <<EOF
[Timer]
OnCalendar=*-*-* 03:30:00 UTC
Persistent=true
[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload && systemctl enable --now hl-index-daily.timer && systemctl start hl-index-build.service
say "build started as hl-index-build.service into s3://$INDEX_BUCKET (log: /var/log/hl-index-build.log)"
# two minutes in, copy the build log's tail to the system log, so progress or the error shows there
(sleep 120; echo "hl-index: build log after 2 min:"; tail -n 15 /var/log/hl-index-build.log) >/dev/console 2>&1 &
```

The build is resumable: each finished day carries a `_done` marker, and a rerun (or the daily timer)
skips them. `node archive-indexer.js status --bucket …` prints the index's days and the last
summary. Costs: a `t4g.medium` for the build (~$0.03/h, a few hours), then the schedule below (the disk,
~$2.90/month, and cents of running time), the index's storage (~$4–6/month for everything), S3
requests (~$9 once for the 1.8M files). No
transfer, because the machine and both buckets share a region.

### Keeping the index current for pennies: a machine that wakes, catches up and stops

A machine left running costs every hour (`t4g.medium` ~$25/month, `t4g.nano` ~$3) for a job that
takes a few minutes a day. Instead, let it sleep: a schedule starts it twice a day, it runs `build`
(which skips every finished day, so it fills any day still missing, the gaps a stopped build left
included, then yesterday) and powers itself off. You pay the minutes it runs (cents a month) and its
disk (30 GB, ~$2.90/month). No shell on the machine is needed: everything goes through the console.

Before switching, let a build that is still running finish (Check coverage → the index's "last
day" stops moving, or the system log shows `done:`). Switching mid-build is safe too, since the
next run resumes where it stopped; it just runs longer that time.

1. **The machine runs this on every boot.** EC2 → the instance → Instance state → **Stop**. Then
   Actions → Instance settings → **Edit user data**, replace it with the script below (your bucket
   and server filled in), Save. Keep the type `t4g.medium`: it is billed by the second, so a bigger
   machine finishing sooner costs about the same, and it has the memory a busy hour needs.
2. **Shutdown means stop.** Actions → Instance settings → *Change shutdown behavior*: **Stop**
   (the default; "Terminate" would delete the machine the first time it finishes).
3. **The schedule.** EventBridge → **Scheduler** → Create schedule, in Tokyo: *Recurring*, cron
   `30 1,13 * * ? *` (01:30 and 13:30 UTC), flexible window off → Target: *All APIs* → **Amazon
   EC2** → **StartInstances**, input `{"InstanceIds": ["i-…your instance id…"]}` → Permissions: *Use
   existing role* (the console can't create one for an "All APIs" target). Make it once in IAM →
   Roles → Create role → *Custom trust policy*, principal `scheduler.amazonaws.com`, action
   `sts:AssumeRole`; no managed policies; name `hl-index-wake`; then on the role → Add permissions →
   Create inline policy allowing `ec2:StartInstances` on
   `arn:aws:ec2:ap-northeast-1:*:instance/i-…your instance id…`. Back on the schedule, refresh the
   role list, pick it → Create. Hyperliquid uploads each hour with a lag of an hour or two: a day
   still short of hours is left for the next run rather than marked finished short, so the 13:30 run
   completes the day the 01:30 run saw partly, and the index trails the exchange by half a day at most.
4. Check it the next day: Check coverage shows the index's last day as yesterday, and EC2 → the
   instance → Monitor and troubleshoot → **Get system log** shows the last run's summary.

To keep the machine on for a look around, set `STAY_ON=1` in the user data before starting it (and
back to `0` after). Starting it while it is already running does nothing, so a long catch-up is
never started twice.

```
Content-Type: multipart/mixed; boundary="//"
MIME-Version: 1.0

--//
Content-Type: text/cloud-config; charset="us-ascii"
MIME-Version: 1.0
Content-Transfer-Encoding: 7bit
Content-Disposition: attachment; filename="cloud-config.txt"

#cloud-config
cloud_final_modules:
- [scripts-user, always]

--//
Content-Type: text/x-shellscript; charset="us-ascii"
MIME-Version: 1.0
Content-Transfer-Encoding: 7bit
Content-Disposition: attachment; filename="userdata.txt"

#!/bin/bash
# every boot: refresh the indexer from your server, catch the index up, power off
INDEX_BUCKET=hl-fills-index-yourname
LEDGER=https://your-app.up.railway.app
STAY_ON=0
say() { echo "hl-index: $*" | tee /dev/console; }
# the always-on setup's units: the schedule replaces them
systemctl disable --now hl-index-daily.timer hl-index-build.service >/dev/null 2>&1
command -v node >/dev/null || dnf install -y nodejs20 >/var/log/indexer-install.log 2>&1 || dnf install -y nodejs >>/var/log/indexer-install.log 2>&1
NODE=$(command -v node || ls /usr/bin/node-* 2>/dev/null | head -1)
mkdir -p /opt/hl-index && cd /opt/hl-index
for f in archive.js archive-indexer.js; do # the newest version from your server; the copy on disk if it can't be reached
  curl -fsSL -o "$f.new" "$LEDGER/archive/$f" && mv "$f.new" "$f" || say "kept the old $f (couldn't fetch it)"
done
if [ "$STAY_ON" = 1 ]; then say "STAY_ON=1: not running, not powering off"; exit 0; fi
say "catching up s3://$INDEX_BUCKET"
# a transient unit, so boot finishes; the power-off comes after the run whatever its outcome, and
# a run that hangs is cut off after 10 hours
systemd-run --unit=hl-index-run --setenv=INDEX_BUCKET=$INDEX_BUCKET --setenv=WORKDIR=/var/tmp/hl-index \
  /bin/sh -c "timeout 10h $NODE /opt/hl-index/archive-indexer.js build --workers 2 >>/var/log/hl-index-build.log 2>&1;
    echo \"hl-index: run ended (exit \$?): \$(tail -n 3 /var/log/hl-index-build.log | tr '\n' ' ')\" >/dev/console; shutdown -h +1"
--//--
```

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
headers. It never sees an API secret. It's open to the owner's token and to Daruma
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
| `CEX_RELAY_ALL_PER_MIN` | `6000` | Relayed requests per minute from everyone together (never below `CEX_RELAY_PER_MIN`) |
| `CEX_RELAY_IN_FLIGHT` | `32` | Relayed requests waiting on an exchange at once; past it the relay answers 503 |
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
