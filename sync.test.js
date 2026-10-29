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
    getBlock: async number => number === 20001 ? null : { timestamp: 1700000000 + number * 2 },
    getLogs: async ({ fromBlock }) => fromBlock === 1 || fromBlock === 20001 ? [{
      ...encoded, blockNumber: fromBlock, index: 0, transactionHash: '0x' + String(fromBlock).padStart(64, '0')
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
    await assert.rejects(syncCheckpoint(provider, 40000), /Missing real timestamp.*20001/);
    assert.equal(fs.readFileSync('data.json', 'utf8'), saved);
  } finally {
    process.chdir(cwd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
