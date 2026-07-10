# Deploying Ledger on Railway

Ledger stays a client-side app: all fill reconstruction, statistics, mining, and
excursion analysis run in your browser, talking directly to Hyperliquid. The
companion server (`server.js`, zero npm dependencies) only serves the HTML and
persists one JSON blob — journal entries, wallets, settings, and MAE/MFE
measurements — so they survive reboots, redeploys, and device switches.

## Repo layout

```
ledger.html     the app (unchanged single file — still works from file:// too)
server.js       companion server
package.json    start script + node version (no dependencies to install)
tests/          test suites (`npm test`)
```

## Railway setup (once)

1. **New project → Deploy from GitHub repo** (or `railway up` from this folder).
   Railway autodetects Node from `package.json` and runs `npm start`.

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
  (HTTP 409) and that client loads the newer server state instead of
  overwriting it — last writer wins, silently clobbering never happens.
- **Stays in the browser (by design):** candle caches and fill caches
  (re-fetchable, large) and journal image attachments. "Backup all" still
  exports everything exportable as a portable JSON.
- **Standalone still works:** the same `ledger.html` opened from disk or any
  static host simply skips server sync (the boot probe gets no answer) and
  falls back to the linked-data-file / browser storage modes.

## Environment variables

| Var          | Default                          | Notes                              |
|--------------|----------------------------------|------------------------------------|
| `PORT`       | `8080`                           | Railway injects this automatically |
| `AUTH_TOKEN` | *(empty = API open — don't)*     | Bearer token for `/api/data`       |
| `DATA_DIR`   | `/data` if present, else `./data`| Where `ledger-data.json` lives     |

## Verifying persistence

After entering a journal note, redeploy the service, reload the page:
the note should still be there and the rev counter advanced. Or from a shell:
`curl -H "Authorization: Bearer $AUTH_TOKEN" https://<your-app>.up.railway.app/api/data`
