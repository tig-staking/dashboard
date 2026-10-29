# Snapshot and browser recovery

Staking checkpoints store the scanned block's hash, timestamp, a SHA-256 digest of the event list and up to 64 earlier checkpoint hashes. Before continuing, both the builder and browser compare the stored hash with the RPC chain. If it changed, they replay from the newest surviving checkpoint, deleting the replaced tail. With no surviving checkpoint they rebuild from the configured first block. A lagging RPC causes a retry rather than a rollback.

Each scanned range checks event block hashes and real timestamps, then checks its boundary and the retained prefix again before committing. Missing headers, undecodable events and changed blocks prevent advancement. RPC responses remain a trust boundary: hash checks cannot prove that an RPC returned every matching event.

The browser validates snapshot configuration, coverage, event identities and the content digest before import. Its import signature includes actual event content, so corrections with unchanged counts or heights are applied. A newer snapshot can replace a longer local history. An older snapshot generation cannot overwrite an already imported newer generation.

Event replacement and progress metadata share one IndexedDB transaction. A failed or interrupted transaction preserves the previous complete state. Statistics read events and metadata together. Clearing or losing the browser database triggers a fresh snapshot import on the next load. Denied, unavailable, blocked or full browser storage switches to an in-memory store with the same operations and atomic replacement. The last complete cached state is retained when possible; subsequent sync continues in this tab. A visible notice explains that data will be downloaded again after reload. Invalid event writes still fail rather than being disguised as a storage outage. Saved addresses also remain available for the session if localStorage writes are denied.

Top 500 snapshots check that their staking checkpoint is on the same chain and recheck the block before publication. Browser catch-up validates transfer headers and removes a ranking whose base block was reorganized. If the indexer is unavailable and the previous holder snapshot is no longer canonical, holder discovery must wait for a valid candidate source; it cannot safely infer all candidates from a replaced fork.

## Migration limitation

Snapshots predating hash checkpoints have no historical chain identity to compare. The first migration only replayed their last 10,000 blocks. The separate `Verify Full Staking History` workflow now rebuilds all staking logs from the configured first block, obtains every event block's hash and real timestamp, and checks range boundaries. It freezes its target, saves resumable progress in Actions artifacts and never modifies production data directly. Re-running on the same branch restores the latest checkpoint. A replaced target or corrupted checkpoint prevents certification.

Only a complete rescan produces `verified-data.json` and `report.json`. The report compares missing, extra and corrected events against the source snapshot. After review, this complete result can replace data.json and the normal sync catches up its tail before publication. The `historyVerification` metadata records coverage and is carried forward by subsequent verified syncs. The connection details display whether historical verification has completed. RPC completeness remains a trust boundary, as described above.

## Historical staking rank

Ranks use integer token units and address order for ties. The address timeline records its own events and every rank change caused by another address, in block/log order. External rank changes do not become wallet transactions. The chart is stepped and extends to the displayed data block.
