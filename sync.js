/**
 * sync.js — offline snapshot builder for TIG Staking Dashboard
 * Writes/updates ./data.json in the format expected by the HTML loader.
 *
 * Compatibility notes (dashboard):
 *  - metadata.lastBlock  → resume pointer for browsers (`lastBlock` in IDB)
 *  - metadata.lastSync   → freshness
 *  - metadata.total      → optional display; dashboard uses txList.length
 *  - transactions[].id   → stable keyPath (hash-logIndex) for IndexedDB put()
 *  - timestamp           → MUST be real block time (not Date.now())
 *
 * Usage: node sync.js
 */
const fs = require('fs');
const { ethers } = require('ethers');
const { createProvider } = require('./rpc');
const Chain = require('./chain-state');

const CONFIG = {
  STAKE: '0x9F6b29E498Ef6BEe4a050fa1F29c31DBE6c6aEF4',
  TOKEN: '0x0C03Ce270B4826Ec62e7DD007f0B716068639F7B',
  FIRST_BLOCK: 26498642,
  FILE_PATH: './data.json',
  PENDING_PERIOD_SEC: 2419200, // 28d
  BLACKLIST: ['0x30FeC1f3690F3207d1A239dB392f62C9CD1deF3F'],
  CHUNK_SIZE: 10000,         // shrink automatically if a fallback has a smaller limit
  CHUNK_MIN: 1,              // some free RPCs allow only 50 blocks
  MAX_RETRIES: 12,           // zwiększono, by skrypt miał czas płynnie zmniejszyć zakres
  RPC_DELAY_MS: 250,
  BLOCK_TS_CONCURRENCY: 8,
  BASE_BLOCK_TIME: 2         // fallback estimate only
};

const LOCKER_ABI = [
  'event TokensLocked(address indexed user, uint256 amount, uint256 locked)',
  'event TokensUnlocked(address indexed user, uint256 amount, uint256 locked, uint256 withdrawableTime)',
  'event TokensWithdrawn(address indexed user, uint256 amount)',
  'event TokensRelocked(address indexed user, uint256 amount, uint256 locked)',
  'event TokensClaimed(address indexed user, uint256 amount, uint256 locked)',
  'event TokensRewarded(address indexed user, uint256 amount, uint256 totalClaimable)',
  'function pendingPeriod() view returns (uint256)'
];

const EVENT_TYPE = {
  TokensLocked: 'lock',
  TokensUnlocked: 'unlock',
  TokensWithdrawn: 'withdraw',
  TokensRelocked: 'relock',
  TokensClaimed: 'claim',
  TokensRewarded: 'reward'
};

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function valueToTig(val) {
  try {
    const n = Number(ethers.formatUnits(val, 18));
    return Number.isFinite(n) ? n : 0;
  } catch (e) {
    return 0;
  }
}

function normalizeAddr(a) {
  try {
    return ethers.getAddress(String(a));
  } catch (e) {
    return String(a || '');
  }
}

function lowerSet(list) {
  const s = new Set();
  (list || []).forEach((a) => {
    try { s.add(normalizeAddr(a).toLowerCase()); }
    catch (_) { s.add(String(a).toLowerCase()); }
  });
  return s;
}

function isRateLimit(err) {
  const m = String(err && err.message ? err.message : err).toLowerCase();
  return (
    m.includes('rate limit') ||
    m.includes('too many requests') ||
    m.includes('429') ||
    m.includes('-32016') ||
    m.includes('over rate') ||
    m.includes('capacity') ||
    m.includes('timeout') ||
    m.includes('413') ||
    m.includes('payload too large') ||
    m.includes('limited to')
  );
}

async function connectProvider(deadline) {
  const provider = createProvider(undefined, { deadline });
  try {
    const head = await provider.getBlockNumber();
    console.log('RPC pool OK @ block', head);
    return { provider, head };
  } catch (error) { provider.destroy(); throw error; }
}

async function fetchBlockTimestamps(provider, blockNumbers) {
  const unique = Array.from(new Set(blockNumbers.filter((n) => Number.isFinite(n))));
  const map = new Map();
  const conc = CONFIG.BLOCK_TS_CONCURRENCY;

  for (let i = 0; i < unique.length; i += conc) {
    const chunk = unique.slice(i, i + conc);
    const results = await Promise.allSettled(
      chunk.map((n) => Chain.anchor(provider, n))
    );
    results.forEach((r, j) => {
      if (r.status === 'fulfilled' && r.value && r.value.timestamp != null) {
        map.set(chunk[j], r.value);
      }
    });
    if (i + conc < unique.length) await sleep(40);
  }
  return map;
}

function loadExisting() {
  if (!fs.existsSync(CONFIG.FILE_PATH)) {
    return {
      version: 4,
      engine: 'TokenLocker-getLogs',
      config: {
        token: CONFIG.TOKEN,
        staking: CONFIG.STAKE,
        firstBlock: CONFIG.FIRST_BLOCK,
        blacklist: CONFIG.BLACKLIST.slice(),
        pendingPeriodSec: CONFIG.PENDING_PERIOD_SEC
      },
      metadata: {
        lastBlock: CONFIG.FIRST_BLOCK - 1,
        lastSync: 0,
        total: 0
      },
      transactions: []
    };
  }
  const raw = JSON.parse(fs.readFileSync(CONFIG.FILE_PATH, 'utf8'));
  if (!raw.metadata) raw.metadata = {};
  if (!Array.isArray(raw.transactions)) raw.transactions = [];
  if (!raw.config) {
    raw.config = {
      token: CONFIG.TOKEN,
      staking: CONFIG.STAKE,
      firstBlock: CONFIG.FIRST_BLOCK,
      blacklist: CONFIG.BLACKLIST.slice(),
      pendingPeriodSec: CONFIG.PENDING_PERIOD_SEC
    };
  }
  return raw;
}

function dedupeById(txs) {
  const map = new Map();
  for (const t of txs) {
    if (!t || !t.id) continue;
    if (!map.has(t.id)) map.set(t.id, t);
    else {
      const prev = map.get(t.id);
      if ((Number(t.timestamp) || 0) > 0 && (Number(t.timestamp) || 0) < (Number(prev.timestamp) || Infinity)) {
        map.set(t.id, t);
      }
    }
  }
  return Array.from(map.values());
}

async function getLogsChunk(provider, address, topics, fromBlock, toBlock, options = {}) {
  // Ograniczamy wielkość pierwszej paczki do bezpiecznego CHUNK_SIZE
  let size = Math.min(CONFIG.CHUNK_SIZE, toBlock - fromBlock + 1);
  let start = fromBlock;
  const out = [];

  while (start <= toBlock) {
    let attempt = 0;
    for (;;) {
      if (Date.now() >= (options.deadline || Infinity)) throw new Error('Log catch-up work budget reached');
      const end = Math.min(start + size - 1, toBlock);
      try {
        const logs = await provider.getLogs({
          address,
          fromBlock: start,
          toBlock: end,
          topics
        });
        out.push(...logs);
        start = end + 1;
        // powoli rośnij po udanym zapytaniu (max CHUNK_SIZE)
        size = Math.min(CONFIG.CHUNK_SIZE, Math.floor(size * 1.15) || CONFIG.CHUNK_SIZE);
        await sleep(options.delayMs ?? CONFIG.RPC_DELAY_MS);
        break;
      } catch (err) {
        if (Date.now() >= (options.deadline || Infinity)) throw new Error('Log catch-up work budget reached');
        attempt++;
        const msg = err && err.message ? err.message : String(err);
        if (attempt >= CONFIG.MAX_RETRIES) {
          throw new Error(`getLogs failed ${start}-${end} after ${attempt} tries: ${msg}`);
        }
        // w przypadku przekroczenia limitu RPC, natychmiast zmniejsz rozmiar zapytania
        if (isRateLimit(err) || /range|limit|response size|too large|413/i.test(msg)) {
          size = Math.max(CONFIG.CHUNK_MIN, Math.floor(size / 2));
        }
        const backoff = Math.min(20000, 800 * Math.pow(1.7, attempt));
        console.warn(`  retry ${attempt} range ${start}-${end} size→${size}: ${msg.slice(0, 120)}`);
        await sleep(backoff);
      }
    }
  }
  return out;
}

async function syncCheckpoint(provider, head, deadline) {
  const existingData = loadExisting();
  if (existingData.metadata.contentHash && !Chain.sameHash(existingData.metadata.contentHash, await Chain.digest(existingData.transactions))) throw new Error('Stored snapshot content hash mismatch');
  const firstBlock = Number(existingData.config.firstBlock) || CONFIG.FIRST_BLOCK;
  const plan = await Chain.planReplay(provider, existingData.metadata, firstBlock, head);
  const resumeFrom = plan.fromBlock;
  const currentBlock = Math.min(head, resumeFrom + 19999);
  const iface = new ethers.Interface(LOCKER_ABI);
  const stake = normalizeAddr(CONFIG.STAKE);

  let pendingPeriodSec =
    Number(existingData.config?.pendingPeriodSec) || CONFIG.PENDING_PERIOD_SEC;
  try {
    const c = new ethers.Contract(stake, LOCKER_ABI, provider);
    const pp = await c.pendingPeriod();
    const sec = Number(pp);
    if (Number.isFinite(sec) && sec > 0) {
      pendingPeriodSec = sec;
      console.log(`pendingPeriod on-chain: ${pendingPeriodSec}s`);
    }
  } catch (_) {
    console.log(`pendingPeriod fallback: ${pendingPeriodSec}s`);
  }

  const blacklist = lowerSet([
    ...(existingData.config?.blacklist || []),
    ...CONFIG.BLACKLIST
  ]);

  const lastBlock = Number(existingData.metadata?.lastBlock);

  if (resumeFrom > currentBlock) {
    console.log(`Baza już aktualna. lastBlock=${lastBlock}, head=${currentBlock}, txs=${(existingData.transactions || []).length}`);
    return false;
  }

  console.log(`Pobieranie bloków od ${resumeFrom} do ${currentBlock}...`);

  const topics = [
    Object.keys(EVENT_TYPE).map((name) => iface.getEvent(name).topicHash)
  ];

  const checkpoint = await Chain.anchor(provider, currentBlock);
  const logs = await getLogsChunk(provider, stake, topics, resumeFrom, currentBlock, { deadline });
  console.log(`Zebrano ${logs.length} logów. Parsowanie…`);

  const newTxs = [];
  const needBlocks = [];

  for (const log of logs) {
      const parsed = iface.parseLog({ topics: log.topics, data: log.data });
      if (!parsed) throw new Error('Unparseable staking event');
      const type = EVENT_TYPE[parsed.name];
      if (!type) throw new Error('Unknown staking event');

      const args = parsed.args;
      const user = normalizeAddr(args.user != null ? args.user : args[0]);
      const amt = args.amount != null ? args.amount : args[1];
      const bn = Number(log.blockNumber);
      if (!Number.isSafeInteger(bn) || bn < resumeFrom || bn > currentBlock) throw new Error('Log outside requested range');

      let withdrawableTime = 0;
      if (type === 'unlock') {
        const wt = args.withdrawableTime != null ? args.withdrawableTime : args[3];
        withdrawableTime = Number(wt);
        if (!Number.isSafeInteger(withdrawableTime) || withdrawableTime <= 0) throw new Error('Invalid on-chain withdrawal time');
      }

      needBlocks.push(bn);
      newTxs.push({
        id: `${log.transactionHash}-${log.index}`,
        hash: log.transactionHash,
        logIndex: log.index,
        blockNumber: bn,
        blockHash: log.blockHash,
        address: user,
        type,
        value: amt.toString(),
        valueTig: valueToTig(amt),
        timestamp: 0,
        blacklisted: blacklist.has(user.toLowerCase()) ? 1 : 0,
        withdrawableTime
      });
  }

  console.log(`Pobieranie timestampów bloków (${new Set(needBlocks).size} unikalnych)…`);
  const tsMap = await fetchBlockTimestamps(provider, needBlocks);

  for (let i = 0; i < newTxs.length; i++) {
    const block = tsMap.get(newTxs[i].blockNumber);
    if (!block) throw new Error('Missing verified block header at ' + newTxs[i].blockNumber);
    Chain.assertLog(logs[i], block);
    newTxs[i].timestamp = block.timestamp;
  }
  if (!Chain.sameHash(checkpoint.hash, (await Chain.anchor(provider, currentBlock)).hash)) throw new Error('Chain changed during checkpoint; snapshot not advanced');
  await Chain.verifyPrefix(provider, existingData.metadata, resumeFrom);
  const allTxs = dedupeById([...(existingData.transactions || []).filter(tx => tx.blockNumber < resumeFrom), ...newTxs]);

  allTxs.sort((a, b) => {
    const db = (a.blockNumber || 0) - (b.blockNumber || 0);
    if (db !== 0) return db;
    return (a.logIndex || 0) - (b.logIndex || 0);
  });

  const payload = {
    version: 4,
    engine: 'TokenLocker-getLogs',
    exported: new Date().toISOString(),
    config: {
      token: normalizeAddr(existingData.config?.token || CONFIG.TOKEN),
      staking: stake,
      firstBlock: Number(existingData.config?.firstBlock) || CONFIG.FIRST_BLOCK,
      blacklist: Array.from(blacklist).map((a) => {
        try { return ethers.getAddress(a); } catch { return a; }
      }),
      pendingPeriodSec
    },
    metadata: {
      lastBlock: currentBlock,
      lastBlockHash: checkpoint.hash,
      lastBlockTimestamp: checkpoint.timestamp,
      anchors: Chain.appendAnchor(existingData.metadata.anchors, checkpoint, resumeFrom),
      contentHash: await Chain.digest(allTxs),
      historyVerification: existingData.metadata.historyVerification ? {
        ...existingData.metadata.historyVerification, throughBlock: currentBlock, throughHash: checkpoint.hash
      } : undefined,
      lastSync: Date.now(),
      total: allTxs.length,
      version: existingData.exported || existingData.metadata?.version || '4',
      fromBlock: resumeFrom,
      added: newTxs.length
    },
    transactions: allTxs
  };

  const tmp = CONFIG.FILE_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(payload));
  fs.renameSync(tmp, CONFIG.FILE_PATH);

  console.log(
    `OK. +${newTxs.length} nowych (po dedupe w pliku: ${allTxs.length}). ` +
    `metadata.lastBlock=${currentBlock}, head=${currentBlock}`
  );
  console.log('Verified snapshot saved (' + plan.reason + ').');
  return currentBlock < head;
}

async function run() {
  const deadline = Date.now() + 12 * 60 * 1000;
  const { provider, head } = await connectProvider(deadline);
  try {
    while (await syncCheckpoint(provider, head, deadline)) {
      if (Date.now() >= deadline) throw new Error('Sync work budget reached; verified checkpoints saved for the next run');
    }
  } finally { provider.destroy(); }
}

if (require.main === module) run().catch((e) => {
  console.error(e);
  process.exit(1);
});
module.exports = { getLogsChunk, syncCheckpoint, run, LOCKER_ABI, EVENT_TYPE };
