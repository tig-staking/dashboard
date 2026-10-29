const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { ethers } = require('ethers');
const { readRange, verifyHistory } = require('./verify-history');
const { LOCKER_ABI } = require('./sync');
const hash = n => '0x' + n.toString(16).padStart(64, '0');
const config = { token: '0x' + '1'.repeat(40), staking: '0x' + '2'.repeat(40), firstBlock: 1, blacklist: [] };
const header = number => ({ number, hash: hash(number), timestamp: 1700000000 + number * 3 });
const iface = new ethers.Interface(LOCKER_ABI);
function log(n) { return { ...iface.encodeEventLog(iface.getEvent('TokensLocked'), [config.token, 100n, 100n]), blockNumber: n, blockHash: hash(n), transactionHash: hash(n + 100), index: 0 }; }
function files(dir) { return { file: path.join(dir, 'checkpoint.json'), resultFile: path.join(dir, 'verified.json'), reportFile: path.join(dir, 'report.json'), checkpointBlocks: 3 }; }
test('historical verification resumes a separate checkpoint and corrects missing, extra and inaccurate events', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tig-history-'));
  const source = { config, metadata: { lastBlock: 9 }, transactions: [{ id: hash(102) + '-0', blockNumber: 2, address: config.token, value: '100', type: 'lock', logIndex: 0, timestamp: 1 }, { id: 'orphan', blockNumber: 4 }] };
  let fail = true; const ranges = [];
  const provider = { getBlock: async n => header(n), getLogs: async ({ fromBlock, toBlock }) => {
    ranges.push([fromBlock, toBlock]); if (fail && fromBlock > 3) throw Error('temporary upstream outage');
    return [2, 5, 8].filter(n => n >= fromBlock && n <= toBlock).map(log);
  } };
  try {
    // Fail at the header boundary rather than invoking RPC range retries in this fixture.
    const failProvider = { ...provider, getBlock: async n => { if (n === 6) throw Error('temporary upstream outage'); return header(n); } };
    await assert.rejects(verifyHistory(failProvider, source, files(dir)), /outage/);
    assert.equal(JSON.parse(fs.readFileSync(files(dir).file)).metadata.lastBlock, 3);
    assert.equal(fs.existsSync(files(dir).resultFile), false);
    fail = false; ranges.length = 0;
    const result = await verifyHistory(provider, source, files(dir));
    assert.equal(result.complete, true); assert.equal(ranges[0][0], 4);
    assert.deepEqual([result.comparison.added, result.comparison.removed, result.comparison.corrected], [2, 1, 1]);
    const data = JSON.parse(fs.readFileSync(files(dir).resultFile));
    assert.equal(data.transactions.length, 3); assert.equal(data.transactions[0].timestamp, header(2).timestamp);
    assert.equal(data.metadata.historyVerification.fromBlock, 1); assert.equal(data.metadata.historyVerification.throughBlock, 9);
    assert.equal(source.transactions[0].timestamp, 1, 'production source is never modified');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('a changed frozen target or inconsistent event hash cannot produce a verified result', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tig-history-fork-'));
  const source = { config, metadata: { lastBlock: 6 }, transactions: [] };
  try {
    const provider = { getBlock: async n => header(n), getLogs: async () => [{ ...log(2), blockHash: hash(999) }] };
    await assert.rejects(readRange(provider, config, 1, 3), /unverified/);
    await verifyHistory({ getBlock: async n => header(n), getLogs: async () => [] }, source, files(dir));
    await assert.rejects(verifyHistory({ getBlock: async n => ({ ...header(n), hash: hash(999) }), getLogs: async () => [] }, source, files(dir)), /target was reorganized/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
