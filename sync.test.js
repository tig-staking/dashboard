const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ethers } = require('ethers');
const { syncCheckpoint } = require('./sync');

test('sync saves verified checkpoints and keeps them when a later timestamp fetch fails', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tig-sync-'));
  const cwd = process.cwd();
  const iface = new ethers.Interface(['event TokensLocked(address indexed user, uint256 amount, uint256 locked)']);
  const encoded = iface.encodeEventLog(iface.getEvent('TokensLocked'), ['0x' + '1'.repeat(40), 10n, 10n]);
  const provider = {
    getBlock: async number => number === 20001 ? null : { number, hash: '0x' + String(number).padStart(64, '0'), timestamp: 1700000000 + number * 2 },
    getLogs: async ({ fromBlock }) => fromBlock === 1 || fromBlock === 20001 ? [{
      ...encoded, blockNumber: fromBlock, blockHash: '0x' + String(fromBlock).padStart(64, '0'), index: 0, transactionHash: '0x' + String(fromBlock).padStart(64, '0')
    }] : []
  };
  try {
    process.chdir(dir);
    fs.writeFileSync('data.json', JSON.stringify({ config: { firstBlock: 1 }, metadata: { lastBlock: 0 }, transactions: [] }));
    assert.equal(await syncCheckpoint(provider, 40000), true);
    const saved = fs.readFileSync('data.json', 'utf8');
    const data = JSON.parse(saved);
    assert.equal(data.metadata.lastBlock, 20000);
    assert.equal(data.transactions.length, 1);
    assert.equal(data.transactions[0].timestamp, 1700000002);
    await assert.rejects(syncCheckpoint(provider, 40000), /Missing verified block header.*20001/);
    assert.equal(fs.readFileSync('data.json', 'utf8'), saved);
  } finally {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sync removes orphan events after a fork and refuses a checkpoint that changes mid-fetch', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tig-fork-')), cwd = process.cwd();
  const hash = n => '0x' + n.toString(16).padStart(64, '0');
  const header = number => ({ number, hash: hash(number), timestamp: 1700000000 + number * 2 });
  try {
    process.chdir(dir);
    const data = { config: { firstBlock: 1 }, metadata: { lastBlock: 10, lastBlockHash: hash(999), anchors: [header(5)] }, transactions: [{ id: 'prefix', blockNumber: 1 }, { id: 'orphan', blockNumber: 9 }] };
    fs.writeFileSync('data.json', JSON.stringify(data));
    await syncCheckpoint({ getBlock: async n => header(n), getLogs: async () => [] }, 12);
    const saved = fs.readFileSync('data.json', 'utf8'), canonical = JSON.parse(saved);
    assert.deepEqual(canonical.transactions.map(tx => tx.id), ['prefix']);
    assert.equal(canonical.metadata.fromBlock, 6);
    assert.equal(canonical.metadata.lastBlockHash, hash(12));
    let changed = false;
    await assert.rejects(syncCheckpoint({ getBlock: async n => ({ ...header(n), hash: changed && n === 14 ? hash(999) : hash(n) }), getLogs: async () => { changed = true; return []; } }, 14), /Chain changed/);
    assert.equal(fs.readFileSync('data.json', 'utf8'), saved);
  } finally { process.chdir(cwd); fs.rmSync(dir, { recursive: true, force: true }); }
});
