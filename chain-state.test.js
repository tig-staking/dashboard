const test = require('node:test');
const assert = require('node:assert/strict');
const Chain = require('./chain-state');
const hash = n => '0x' + n.toString(16).padStart(64, '0');
const point = n => ({ number: n, hash: hash(n), timestamp: 1700000000 + n * 2 });
const provider = { getBlock: async n => point(n) };
const config = { token: '0x' + '1'.repeat(40), staking: '0x' + '2'.repeat(40), firstBlock: 1 };
function snapshot() {
  return { config, metadata: { lastBlock: 10, lastSync: Date.now(), total: 1, lastBlockHash: hash(10) },
    transactions: [{ id: hash(9) + '-1', hash: hash(9), logIndex: 1, blockNumber: 9,
      address: config.token, timestamp: 1700000018, type: 'lock', value: '100' }] };
}
test('a reorganization resumes after the latest surviving checkpoint', async () => {
  const meta = { lastBlock: 100, lastBlockHash: hash(999), anchors: [point(20), point(60), { ...point(80), hash: hash(888) }] };
  assert.deepEqual(await Chain.planReplay(provider, meta, 1, 110), { fromBlock: 61, reason: 'chain reorganization' });
  assert.equal((await Chain.planReplay(provider, { lastBlock: 100, lastBlockHash: hash(999) }, 1, 110)).fromBlock, 1);
});
test('normal continuation, legacy migration and a lagging RPC are distinct', async () => {
  assert.equal((await Chain.planReplay(provider, { lastBlock: 100, lastBlockHash: hash(100) }, 1, 100)).fromBlock, 101);
  assert.equal((await Chain.planReplay(provider, { lastBlock: 20000 }, 1, 20001)).fromBlock, 10001);
  await assert.rejects(Chain.planReplay(provider, { lastBlock: 100 }, 1, 99), /behind/);
  await assert.rejects(Chain.anchor({ getBlock: async () => null }, 1), /verified/);
});
test('replaying a tail drops replaced anchors and caps retained checkpoints', () => {
  const points = Array.from({ length: 100 }, (_, n) => point(n + 1));
  const result = Chain.appendAnchor(points, point(81), 80);
  assert.equal(result.length, 64);
  assert.equal(result.at(-1).number, 81);
  assert.ok(!result.some(p => p.number === 80 || p.number > 81));
});
test('events from removed blocks and changed prefixes cannot be committed', async () => {
  assert.throws(() => Chain.assertLog({ blockNumber: 10, blockHash: hash(11) }, point(10)), /replaced/);
  assert.throws(() => Chain.assertLog({ blockNumber: 10, blockHash: hash(10), removed: true }, point(10)), /replaced/);
  await assert.rejects(Chain.verifyPrefix(provider, { lastBlock: 10, lastBlockHash: hash(11) }, 11), /Chain changed/);
});
test('snapshot signatures detect same-count same-height corrections', async () => {
  const a = snapshot(), b = snapshot(); b.transactions[0].value = '50'; b.metadata.lastSync = a.metadata.lastSync;
  const first = await Chain.prepareSnapshot(a, config), corrected = await Chain.prepareSnapshot(b, config);
  assert.notEqual(first.metadata.snapshotSig, corrected.metadata.snapshotSig);
  assert.equal(a.transactions[0].valueTig, undefined, 'validation does not mutate downloaded data');
});
test('invalid coverage, wrong contracts, duplicates and content corruption are rejected', async () => {
  for (const mutate of [
    d => d.transactions[0].blockNumber = 11,
    d => d.config = { ...config, token: config.staking },
    d => { d.transactions.push({ ...d.transactions[0] }); d.metadata.total = 2; },
    d => d.metadata.contentHash = hash(55),
    d => d.transactions[0].timestamp = 0,
    d => { d.transactions[0].type = 'unlock'; d.transactions[0].withdrawableTime = 0; }
  ]) { const data = snapshot(); mutate(data); await assert.rejects(Chain.prepareSnapshot(data, config)); }
  const data = snapshot(); data.metadata.contentHash = await Chain.digest(data.transactions);
  assert.equal((await Chain.prepareSnapshot(data, config)).rows.length, 1);
});
