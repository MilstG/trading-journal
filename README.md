# Ledger

A self-contained, single-file trading journal and analytics tool for the [Hyperliquid](https://hyperliquid.xyz) DEX. Built for personal trade analysis — trade history, position tracking, statistical analysis, and tax export — with **zero backend dependencies**.

Open `ledger.html` in a browser and it works. No server, no build step, no external network calls beyond the Hyperliquid API itself.

---

## Design philosophy

Ledger is deliberately client-only. Everything the app needs — Chart.js, all fonts, all logic — is inlined into a single HTML file. This keeps the tool fully offline-capable, self-hostable, and immune to dependency rot or supply-chain surprises. A strict CSP meta tag enforces this: the only outbound requests are to the Hyperliquid API.

Server-backed architectures (continuous DB ingestion, pre-aggregated summaries) would allow handling larger fill counts, and that's why services like Hyperdash scale further. But that complexity isn't warranted for a personal tool, so it's been evaluated and intentionally rejected. The one place this constraint bites — main-thread freezing on heavy computation — has a client-only fix planned (see Roadmap).

---

## Features

### Trade history & reconstruction
- Fetches fill history from the Hyperliquid API with incremental, cached fetching backed by IndexedDB.
- Reconstructs trades from raw fills, including correct handling of flip trades (positions that reverse direction in a single fill sequence).
- Shift-click forces a full re-fetch, bypassing the local cache.

### Position tracking (main DEX + HIP-3)
Hyperliquid runs both a main validator-operated perpetuals DEX and HIP-3 builder-deployed perpetual markets, which live on **separate clearinghouses with independent margining**. Ledger surfaces positions from both.

- The **Open Book** panel shows positions across the main DEX and every relevant HIP-3 clearinghouse.
- HIP-3 dexes are discovered by scanning already-fetched fills (`hip3DexsFromFills()`) rather than making extra API calls — fills already carry `dex:COIN`-prefixed coin names, making them the natural discovery source.
- Per-dex error isolation: one failing clearinghouse doesn't break the others.
- Coin-name normalization handles both bare and `dex`-prefixed formats.
- HIP-3 positions are tagged with a purple **`hip3`** pill.
- Account value intentionally remains **main-dex-only**, with tooltips that make this explicit.

### Statistical analysis
- Deep-scan states panel with **Benjamini-Hochberg FDR correction** to control false-discovery rate across many simultaneous hypotheses.
- Miner with proper out-of-sample behavior.
- Unified, DST-safe timezone toggle: all time-of-day aggregation routes through a single layer, so the timezone switch is consistent everywhere.

### API resilience
- Exponential backoff with `Retry-After` header support.
- Incremental fetching to avoid re-pulling the full history each session.

### Tax export
- Single, clean, rectangular **14-column CSV**.
- Full wallet addresses, ISO-8601 timestamps, CRLF line endings.
- Summaries live in the in-app status line, *not* mixed into the CSV — clean rectangular output is non-negotiable for downstream tax tooling, since mixing table formats, summary rows, and prose breaks any parser.

---

## Getting started

1. Open `ledger.html` (also distributed as `index.html`) in any modern browser.
2. Enter the wallet address you want to analyze.
3. Ledger fetches fills, reconstructs trades, and populates the panels.

Cached fills persist in IndexedDB between sessions. Shift-click the fetch control to force a full re-fetch.

---

## Architecture

| Concern        | Implementation                                              |
|----------------|-------------------------------------------------------------|
| App shell      | Single-file HTML (`ledger.html` / `index.html`)             |
| Charting       | Chart.js 4.4.1 (inlined)                                     |
| Fonts          | IBM Plex Mono, Barlow Condensed, Inter (all inlined)        |
| Local storage  | IndexedDB (fill cache)                                       |
| Data source    | Hyperliquid `clearinghouseState` (with `dex` param for HIP-3) + fill history endpoints |
| Security       | Strict CSP meta tag                                          |

---

## Testing

A Node.js test harness (`test-hip3.mjs`) extracts functions directly from the HTML source and runs against them. This keeps tests co-located with the single-file architecture instead of forking logic into a separate module.

Current suite: **31 passing tests**, covering fill reconstruction, miner out-of-sample behavior, FDR correctness, and HIP-3 edge cases.

```bash
node test-hip3.mjs
```

---

## Known caveats

- **HIP-3 payload shape unverified in-browser.** The exact format of real per-dex `clearinghouseState` responses (bare vs. `dex`-prefixed coin names) couldn't be confirmed from the Node test environment. The normalizer handles both formats, but the live payload shape still needs browser verification against a real account.

---

## Roadmap

Development works from an explicit audit list; items are *deferred*, not dropped.

- **Web Worker offload** (audit item #6, deferred) — the correct fix for main-thread freezing during heavy reconstruction and miner permutation runs. This is the key remaining scalability item, and it fits the self-contained philosophy since it needs no backend. The bottleneck is main-thread blocking, not data volume per se.
- **Range-fetching with cached reconstructed trades** — lower priority. Only becomes relevant if a wallet exceeds ~120k fills, the current hard ceiling from 60-page pagination.
- Remaining unaddressed items from the original audit list.

---

## License

Personal project. Not a product.
