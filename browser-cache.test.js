const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const { ethers } = require('ethers');
const TigChain = require('./chain-state');
const html = fs.readFileSync(`${__dirname}/index.html`, 'utf8');
const hash = n => '0x' + n.toString(16).padStart(64, '0');
const addr = '0x' + '1'.repeat(40);
const config = { token: addr, staking: '0x' + '2'.repeat(40), firstBlock: 1 };
test('browser import applies same-height corrections, removes a live tail and ignores older snapshots', async () => {
  let state = { transactions: [], metadata: {} }, writes = 0, now = Date.now() - 1000;
  let snapshot = { config, metadata: { lastBlock: 10, lastSync: now, total: 1 }, transactions: [{ hash: hash(8), id: hash(8) + '-0', logIndex: 0, blockNumber: 8, timestamp: 1700000016, address: addr, value: '100', type: 'lock' }] };
  const ctx = vm.createContext({ TigChain, C: { TIG: config.token, STAKE: config.staking, FIRST_BLOCK: 1 },
    fetch: async () => ({ ok: true, json: async () => structuredClone(snapshot) }),
    db: { state: async () => state, replaceSnapshot: async (transactions, metadata) => { state = { transactions, metadata }; writes++; } },
    document: { getElementById: () => ({ textContent: '' }) }, pendingPeriodSec: 2419200,
    valueToTig: Number, isBlacklisted: () => false, setProgress() {}, invalidateCache() {}, myWalletBalanceCache: new Map(), console
  });
  vm.runInContext(html.slice(html.indexOf('  async function loadSnapshotIfNeeded('), html.indexOf('  async function loadSnapshotIfEmpty(')), ctx);
  assert.equal(await ctx.loadSnapshotIfNeeded(), true);
  state.transactions.push({ id: 'live-tail', blockNumber: 11 }); state.metadata.lastBlock = 11;
  snapshot.transactions[0].value = '50'; snapshot.metadata.lastSync = now + 1;
  assert.equal(await ctx.loadSnapshotIfNeeded(), true);
  assert.equal(state.transactions.length, 1);
  assert.equal(state.transactions[0].value, '50');
  assert.equal(state.metadata.lastBlock, 10);
  assert.equal(await ctx.loadSnapshotIfNeeded(), false);
  snapshot.metadata.lastSync = now;
  snapshot.transactions[0].value = '75';
  assert.equal(await ctx.loadSnapshotIfNeeded(), false);
  assert.equal(writes, 2);
});
function scanContext({ changed = false, invalidLog = false, invalidPrefix = false } = {}) {
  const iface = new ethers.Interface(['event TokensLocked(address indexed user, uint256 amount, uint256 locked)']);
  const encoded = iface.encodeEventLog(iface.getEvent('TokensLocked'), [addr, 10n, 10n]);
  const logs = Array.from({ length: 81 }, (_, i) => ({ ...encoded, blockNumber: i + 2, blockHash: hash(invalidLog ? 999 : i + 2), transactionHash: hash(i + 100), index: 0 }));
  let committed = null, queried = false;
  const elements = new Map();
  const ctx = vm.createContext({ TigChain, lockerIface: iface, eventTopics: [iface.getEvent('TokensLocked').topicHash], EVENT_TYPE: { TokensLocked: 'lock' }, valueToTig: Number, isBlacklisted: () => false,
    provider: { getBlock: async n => ({ number: n, hash: hash((changed && queried && n === 82) || (invalidPrefix && n === 1) ? 999 : n), timestamp: 1700000000 + n * 3 }), getLogs: async () => { queried = true; return logs; } },
    db: { count: async () => 81, state: async () => ({ metadata: { anchors: [{ number: 1, hash: hash(1) }] } }), commitRange: async (fromBlock, rows, metadata) => { committed = { fromBlock, rows, metadata }; } },
    document: { getElementById: id => { if (!elements.has(id)) elements.set(id, { textContent: '', classList: { remove() {} } }); return elements.get(id); } },
    C: { BLOCK_CONCURRENCY: 8, FIRST_BLOCK: 1, STAKE: config.staking, BATCH_MAX: 1000, REFRESH_EVERY_N: 100, CHART_EVERY_N: 100, MAX_BATCH_RETRIES: 1, BATCH_MIN: 1 },
    currentBatchSize: 100, stopReq: false, chainHead: 82, setDot() {}, setProgress() {}, setAppVisibility() {},
    sleep: async () => {}, liveRefresh: async () => {}, errText: e => e.message, isRateLimit: () => false, connectRPC: async () => {}, ensureAnchor: async () => {}, console
  });
  vm.runInContext(html.slice(html.indexOf('  async function fetchBlockTimestamps('), html.indexOf('  async function getResumeFrom(')), ctx);
  vm.runInContext(html.slice(html.indexOf('  function parseLogToRow('), html.indexOf('  async function loadSnapshotIfNeeded(')), ctx);
  return { ctx, committed: () => committed };
}
test('browser batches above 80 events keep real timestamps and atomically commit their anchor', async () => {
  const { ctx, committed } = scanContext();
  assert.equal(await ctx.scanBlocks(2, 82, 'fast'), true);
  const result = committed();
  assert.equal(result.rows.length, 81);
  for (const row of result.rows) assert.equal(row.timestamp, 1700000000 + row.blockNumber * 3);
  assert.equal(result.metadata.lastBlockHash, hash(82));
  assert.equal(result.fromBlock, 2);
});
test('a changed batch, orphaned log or replaced prefix never advances the browser cache', async () => {
  for (const options of [{ changed: true }, { invalidLog: true }, { invalidPrefix: true }]) {
    const { ctx, committed } = scanContext(options);
    assert.equal(await ctx.scanBlocks(2, 82, 'fast'), false);
    assert.equal(committed(), null);
  }
});
