# TIG Staking Dashboard

Static dashboard for the TIG token on Base. GitHub Actions refreshes `data.json` and `holders.json` every 30 minutes. The browser loads these snapshots first and then tries to catch up with newer blocks.

## Top 500 TIG

The **Top 500 TIG** tab ranks addresses by:

`TIG in wallet + active TIG in TokenLocker + TIG unlocked but not yet withdrawn`

It ranks **addresses**, not people. Exchange, vesting, custody, and contract addresses can represent many owners. The TokenLocker contract and burn addresses are excluded as separate entries to avoid double counting.

`holders.js` gets the top 1000 liquid holder candidates from Blockscout's public CSV endpoint and adds every address with an open TokenLocker balance from the staking events. It reads each candidate's ERC-20 `balanceOf` on-chain at the **same block** as the staking snapshot, using Multicall3. Values and sorting use integer wei. The script refuses to publish a ranking when the 500th combined balance does not exceed the first excluded liquid-holder balance. This is a candidate coverage check, not a proof that Blockscout's index is fully current; the tab shows the snapshot block and falls back to it if live RPC catch-up fails.

The browser replays TIG transfers and staking events after the snapshot block. It queries on-chain balances for newly seen addresses. A live rank is shown only after catch-up completes.

### Holder age labels

Top 500 addresses have four age labels: Fresh (under 30 days), Established (30–179 days), Long-term (180–364 days), and Diamond (365+ days). Age means time since the first positive TIG transfer received on Base, **not uninterrupted holding or the age of the current balance**. Selling and buying again does not reset this date. Known contracts retain their descriptive names.

`holder-history.js` traverses incoming TIG transfers in Blockscout's REST API for new top 500 addresses. A fully traversed history establishes the earliest receipt, cached in `holders.json.firstReceived`. A positive receipt at least 365 days old already proves the Diamond tier: it is cached separately in `receivedBy` and shown as “at least” that age, without claiming an exact first date. Later refreshes reuse verified dates. Zero-value and outgoing transfers do not count. Missing, incomplete, invalid, or unavailable histories display “Age unavailable”; staking age is never substituted. Scheduled history refreshes have a two-minute work budget plus in-flight request completion, so an API outage does not hold up balance updates. The browser reads the cache without making per-address history requests. For the initial backfill, run `node holder-history.js`; it saves progress every 10 addresses.

## Address lookup and analysis

Open `?address=0x...#mytig` to inspect an address without saving or connecting a wallet. Wallet, staking and pending balances are displayed at the same Base block; incomplete wallet reads never contribute to a combined total. Addresses may optionally be saved in this browser. All five sections are available on desktop and mobile, and section/address navigation supports browser Back.

The shared chart period selects 7, 30, 90 UTC calendar days or all history. Charts also expose data tables and CSV exports; ranking exports respect the address filter. Exports include the data block, available as-of timestamp and export time. Cooldown windows are rolling 24-hour intervals, labeled accordingly. The inspector's rank history includes changes caused by every address's staking events, in block/log order, with exact integer token balances and address ordering for ties.

`Up to date` requires a successful live catch-up in the current browser session, recent data and a small absolute lag to the observed chain head. Snapshot, catching-up, unavailable and out-of-date states are separate. Live ranking updates are published only when all required reads succeed and candidate coverage remains sufficient; failed updates retain the last verified ranking.

## Local development

```sh
npm ci
npm test
npm run sync
```

`npm run sync` reads free public Base RPC endpoints and Blockscout. A failed range leaves the latest verified checkpoint in place. The first staking sync from an empty `data.json` is much slower than an incremental refresh.

Both the browser and staking builder use `rpc.js`: every JSON-RPC request has a 10-second timeout and fails over on HTTP errors, JSON-RPC errors, or invalid responses. Log ranges shrink down to one block when providers impose a smaller range limit. The staking builder saves verified checkpoints every 20,000 blocks; a failed later range keeps that progress. GitHub Actions commits completed checkpoints even if staking catch-up or the separate holders refresh fails. A 12-minute catch-up work budget lets the next scheduled run resume large backlogs.

If Blockscout holder discovery is unavailable, the holder builder verifies the previous snapshot block hash, retains its candidates and coverage cutoff, and discovers additional candidates from every TIG transfer since that block. All balances are queried again at the new staking snapshot block. Addresses untouched by those transfers retain their old upper bound; publication still requires the new 500th balance to exceed it. Verified holder age dates are preserved while indexer history refreshes are deferred during the outage.

## Storage recovery and full history verification

When IndexedDB is denied, blocked, unavailable or full, the dashboard continues with an in-memory cache and a visible session-only notice. Failed writes preserve coherent data and progress. Saved addresses also have a session fallback if localStorage is denied.

The manual `Verify Full Staking History` workflow (or `node verify-history.js`) rebuilds historical logs from the configured first block into a separate checkpoint. It verifies event block hashes and timestamps, can resume after interruption, and produces a complete snapshot plus a comparison report. It does not overwrite production data. An optional `HISTORY_RPC_URL` Actions secret supplies a private archive RPC; public providers remain supported with request scheduling and retries. See [DATA-INTEGRITY.md](DATA-INTEGRITY.md) for coverage, publication and RPC trust limits.
