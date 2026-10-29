const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { ethers } = require('ethers');
const html = fs.readFileSync(`${__dirname}/index.html`, 'utf8');
const address = n => '0x' + n.toString(16).padStart(40, '0');
const hash = n => '0x' + n.toString(16).padStart(64, '0');
const transfer = (from, to, value) => ({
  blockNumber: 101, blockHash: hash(101),
  topics: [ethers.id('Transfer(address,address,uint256)'), ethers.zeroPadValue(from, 32), ethers.zeroPadValue(to, 32)],
  data: ethers.toBeHex(value)
});
function liveContext({ logs = [], balanceOf = async () => 0n, getLogs, target = 101 } = {}) {
  const elements = new Map();
  const candidates = Array.from({ length: 500 }, (_, i) => ({ address: address(i + 100), wallet: '100', locked: '0', pending: '0' }));
  const snapshot = { block: 100, blockHash: hash(100), candidateCutoff: '99', candidates };
  const oldRanking = [{ address: address(100), total: 100n }];
  let paints = 0;
  const ctx = vm.createContext({
    TigChain: require('./chain-state'),
    ethers: { ...ethers, Contract: class { balanceOf(...args) { return balanceOf(...args); } } },
    document: { getElementById: id => { if (!elements.has(id)) elements.set(id, { textContent: '' }); return elements.get(id); } },
    holderSnapshot: snapshot, holderRanking: oldRanking, holderRankingBlock: 100, holderRefreshBusy: false,
    provider: { getLogs: getLogs || (async () => logs), getBlock: async number => ({ number, hash: hash(number), timestamp: 1700000000 + number * 2 }) },
    db: { state: async () => ({ metadata: { lastBlock: target, lastBlockHash: hash(target) }, transactions: [] }) },
    C: { TIG: address(1), MAX_BATCH_RETRIES: 12, RPC_DELAY_MS: 0 }, ERC20_ABI: [],
    EXCLUDED_HOLDER_ADDRESSES: new Set([address(0)]),
    normalizeType: t => t, isRateLimit: () => false, connectRPC: async () => {}, sleep: async () => {},
    renderTop500: () => paints++, errText: e => e.message, console: { warn() {} }
  });
  vm.runInContext(html.slice(html.indexOf('  function holderWei('), html.indexOf('  function holderAmount(')), ctx);
  vm.runInContext(html.slice(html.indexOf('  function rankHolderRows('), html.indexOf('  async function loadHolderSnapshot(')), ctx);
  vm.runInContext(html.slice(html.indexOf('  async function refreshHolderLive('), html.indexOf('  var drawerReturnFocus')), ctx);
  return { ctx, oldRanking, elements, paints: () => paints };
}

test('a failed second balance lookup cannot reuse the first address balance', async () => {
  const a = address(1), b = address(2), calls = [];
  const { ctx, oldRanking, paints, elements } = liveContext({
    logs: [transfer(address(0), a, 1n), transfer(address(0), b, 1n)],
    balanceOf: async key => { calls.push(key); if (key === b) throw Error('B unavailable'); return 123n; }
  });
  await ctx.refreshHolderLive();
  assert.equal(calls.filter(key => key === b).length, 5);
  assert.ok(ctx.holderRanking === oldRanking);
  assert.equal(paints(), 0);
  assert.match(elements.get('top500Status').textContent, /100.*unavailable/);
});

test('live rankings retain the previous verified result when candidate coverage is lost', async () => {
  const logs = Array.from({ length: 500 }, (_, i) => transfer(address(i + 100), address(0), 2n));
  const { ctx, oldRanking, elements } = liveContext({ logs });
  await ctx.refreshHolderLive();
  assert.ok(ctx.holderRanking === oldRanking);
  assert.match(elements.get('top500Status').textContent, /coverage/i);
});

test('Top 500 log catch-up supports a provider limited to 50 blocks', async () => {
  const ranges = [];
  const { ctx, paints } = liveContext({ target: 201, getLogs: async ({ fromBlock, toBlock }) => {
    ranges.push([fromBlock, toBlock]);
    if (toBlock - fromBlock + 1 > 50) throw Error('50 block limit');
    return [];
  } });
  await ctx.refreshHolderLive();
  assert.equal(paints(), 1);
  assert.equal(ctx.holderRankingBlock, 201);
  const accepted = ranges.filter(([a, b]) => b - a + 1 <= 50);
  assert.equal(accepted[0][0], 101);
  assert.equal(accepted.at(-1)[1], 201);
});

test('a newer holder snapshot cannot be overwritten by an older in-flight live update', async () => {
  const { ctx, oldRanking } = liveContext({ getLogs: async () => {
    ctx.holderSnapshot = { ...ctx.holderSnapshot, block: 102 };
    ctx.holderRankingBlock = 102;
    return [];
  } });
  await ctx.refreshHolderLive();
  assert.ok(ctx.holderRanking === oldRanking);
  assert.equal(ctx.holderRankingBlock, 102);
});

test('a holder snapshot from an orphaned block is removed from the ranking', async () => {
  const { ctx, paints, elements } = liveContext();
  ctx.holderSnapshot.blockHash = hash(999);
  await ctx.refreshHolderLive();
  assert.equal(ctx.holderRanking.length, 0);
  assert.equal(ctx.holderRankingBlock, 0);
  assert.equal(paints(), 1);
  assert.match(elements.get('top500Status').textContent, /reorganization/);
});

test('live holder updates reject transfers from another fork', async () => {
  const { ctx, oldRanking, elements } = liveContext({ logs: [{ ...transfer(address(0), address(1), 1n), blockHash: hash(999) }] });
  await ctx.refreshHolderLive();
  assert.ok(ctx.holderRanking === oldRanking);
  assert.match(elements.get('top500Status').textContent, /unverified/);
});

test('old or unverified data never receives a fresh status', () => {
  const line = { textContent: '', innerHTML: '' };
  const now = Date.now();
  const ctx = vm.createContext({ document: { getElementById: () => line }, syncing: false,
    syncHealth: { verifiedBlock: 200, checkedAt: now, error: '' }, chainHead: 200,
    uiState: { lastUiData: { block: 200 } }, C: { INTERVAL: 300000 } });
  vm.runInContext(html.slice(html.indexOf('  function updateFreshLine('), html.indexOf('  function buildIface(')), ctx);
  ctx.updateFreshLine(now - 7 * 86400000, false);
  assert.doesNotMatch(line.innerHTML + line.textContent, /Data fresh|Up to date/);
  ctx.syncHealth.verifiedBlock = 0;
  ctx.updateFreshLine(now, false);
  assert.match(line.textContent + line.innerHTML, /Snapshot/);
  ctx.syncHealth.verifiedBlock = 200;
  ctx.updateFreshLine(now, false);
  assert.match(line.textContent + line.innerHTML, /Up to date/);
  ctx.syncHealth.error = 'RPC unavailable';
  ctx.updateFreshLine(now, false);
  assert.doesNotMatch(line.innerHTML, /Up to date/);
});

test('wallet balances are refreshed and displayed only at the staking block', async () => {
  const calls = [];
  const ctx = vm.createContext({ ethers: { Contract: class { async balanceOf(key, options) { calls.push(options.blockTag); return 40n; } } },
    C: { TIG: address(1) }, ERC20_ABI: [], provider: {}, db: { meta: async () => 200 },
    uiState: { lastUiData: { block: 200 } }, valueToTig: Number, errText: e => e.message,
    connectRPC: async () => {}, renderMyTig() {} });
  vm.runInContext(html.slice(html.indexOf('  var myWalletBalanceCache'), html.indexOf('  function renderMyTig(')), ctx);
  ctx.myWalletBalanceCache.set(address(1), { value: 100, block: 100, time: Date.now() });
  await ctx.refreshMyWalletBalances([{ address: address(1) }], 200);
  assert.deepEqual(calls, [200]);
  assert.equal(ctx.walletBalanceAtBlock(address(1), 100), null);
  assert.equal(ctx.walletBalanceAtBlock(address(1), 200).value, 40);
});

test('address permalinks accept only full Ethereum addresses', () => {
  const ctx = vm.createContext({ URL });
  vm.runInContext(html.slice(html.indexOf('  function addressFromUrl('), html.indexOf('  function openAddress(')), ctx);
  assert.equal(ctx.addressFromUrl('https://example.test/?address=' + address(123) + '#mytig'), address(123));
  assert.equal(ctx.addressFromUrl('https://example.test/?address=0x123'), null);
  assert.equal(ctx.addressFromUrl('https://example.test/?address=%3Cscript%3E'), null);
  assert.equal(ctx.addressFromUrl('https://example.test/'), null);
});
