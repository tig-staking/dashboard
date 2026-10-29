const test = require('node:test');
const assert = require('node:assert/strict');
const { decimalToWei, stakingBalances, csvCandidates, rankRows } = require('./holders-core');
const { getLogsChunk } = require('./sync');
const { cachedCandidates } = require('./holders');
const { TOKEN, STAKING } = require('./holders-core');

const A = '0x' + '1'.repeat(40);
const B = '0x' + '2'.repeat(40);
const C = '0x' + '3'.repeat(40);
const tx = (blockNumber, logIndex, address, type, amount) =>
  ({ blockNumber, logIndex, address, type, value: String(decimalToWei(amount)) });

test('wallet, locked, and pending balance count once after unlock and relock', () => {
  const staking = stakingBalances([
    tx(1, 0, A, 'lock', '100'),
    tx(2, 0, A, 'unlock', '40'),
    tx(3, 0, A, 'relock', '15'),
    tx(4, 0, A, 'withdraw', '10'),
    tx(5, 0, A, 'claim', '5')
  ], 5);
  assert.equal(staking.get(A).locked, decimalToWei('80'));
  assert.equal(staking.get(A).pending, decimalToWei('15'));
  const ranked = rankRows(new Map([[A, decimalToWei('20')], [B, decimalToWei('110')]]), staking);
  assert.equal(ranked[0].address, A);
  assert.equal(ranked[0].total, decimalToWei('115'));
});

test('incomplete staking history is rejected', () => {
  assert.throws(() => stakingBalances([tx(1, 0, A, 'unlock', '1')], 1), /incomplete/);
});

test('TokenLocker custody is omitted as a separate ranked holder', () => {
  const ranked = rankRows(new Map([[A, decimalToWei('100')], [B, decimalToWei('20')]]),
    new Map([[B, { locked: decimalToWei('80'), pending: 0n }]]), new Set([A]));
  assert.equal(ranked.length, 1);
  assert.equal(ranked[0].address, B);
  assert.equal(ranked[0].total, decimalToWei('100'));
});

test('CSV candidate order and precision are checked', () => {
  const csv = 'HolderAddress,Balance\r\n' + [A + ',3.000000000000000001', B + ',2', C + ',1'].join('\r\n');
  const result = csvCandidates(csv, 2);
  assert.deepEqual(result.addresses, [A, B]);
  assert.equal(result.cutoff, decimalToWei('1'));
  assert.throws(() => csvCandidates('HolderAddress,Balance\n' + B + ',1\n' + A + ',2', 1), /sorted/);
});

test('cached holder candidates preserve their coverage bound and exact replay start', () => {
  const previous = { version: 1, token: TOKEN, staking: STAKING, block: 100,
    candidateCutoff: '5', candidates: Array.from({ length: 500 }, (_, i) => ({
      address: '0x' + (i + 100).toString(16).padStart(40, '0'), wallet: '6', locked: '0', pending: '0'
    })) };
  const cached = cachedCandidates(previous, 200);
  assert.equal(cached.fromBlock, 101);
  assert.equal(cached.cutoff, 5n);
  assert.equal(cached.addresses.length, 500);
  assert.throws(() => cachedCandidates(previous, 99), /verified/);
  assert.throws(() => cachedCandidates({ ...previous, candidateCutoff: '6' }, 200), /coverage/);
  assert.throws(() => cachedCandidates({ ...previous, candidates: previous.candidates.slice(0, 499) }, 200), /verified/);
  const duplicate = previous.candidates.slice(); duplicate[499] = duplicate[0];
  assert.throws(() => cachedCandidates({ ...previous, candidates: duplicate }, 200), /coverage/);
});

test('RPC retries the smaller block range instead of the rejected range', async () => {
  const ranges = [];
  const provider = { getLogs: async ({ fromBlock, toBlock }) => {
    ranges.push([fromBlock, toBlock]);
    if (toBlock - fromBlock + 1 > 200) throw new Error('range limited to 200');
    return Array.from({ length: toBlock - fromBlock + 1 }, (_, i) => ({ blockNumber: fromBlock + i }));
  } };
  const rows = await getLogsChunk(provider, A, [], 1, 401);
  assert.equal(ranges[0][0], 1);
  assert.equal(ranges[0][1], 401);
  assert.ok(ranges[1][1] < 401);
  assert.equal(rows.length, 401);
  assert.deepEqual(rows.map(row => row.blockNumber), Array.from({ length: 401 }, (_, i) => i + 1));
});
