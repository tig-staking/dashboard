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

`holder-history.js` traverses incoming TIG transfers in Blockscout's REST API for new top 500 addresses. A fully traversed history establishes the earliest receipt, cached in `holders.json.firstReceived`. A positive receipt at least 365 days old already proves the Diamond tier: it is cached separately in `receivedBy` and shown as “at least” that age, without claiming an exact first date. Later refreshes reuse verified dates. Zero-value and outgoing transfers do not count. Missing, incomplete, invalid, or unavailable histories display “History unavailable”; staking age is never substituted. Scheduled history refreshes have a two-minute work budget plus in-flight request completion, so an API outage does not hold up balance updates. The browser reads the cache without making per-address history requests. For the initial backfill, run `node holder-history.js`; it saves progress every 10 addresses.

## Local development

```sh
npm ci
npm test
npm run sync
```

`npm run sync` reads free public Base RPC endpoints and Blockscout. A failed refresh leaves the previous snapshot in place. The first staking sync from an empty `data.json` is much slower than an incremental refresh.
