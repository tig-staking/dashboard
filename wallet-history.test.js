const test = require('node:test');
const assert = require('node:assert/strict');
const History = require('./wallet-history');
const address = n => '0x' + n.toString(16).padStart(40, '0');
const event = (n, type, value, blockNumber) => ({ address: address(n), type, value: String(BigInt(value) * 10n ** 18n), timestamp: 1700000000 + blockNumber * 2, blockNumber, logIndex: 0 });
test('rank changes caused by other addresses appear without inventing wallet transactions', () => {
  const events = [event(1, 'lock', 100, 1), event(2, 'lock', 200, 2), event(2, 'unlock', 200, 3)];
  const result = History.computeWalletHistory(address(1), events);
  assert.deepEqual(result.timeline.map(p => p.rank), [1, 2, 1]);
  assert.deepEqual(result.timeline.map(p => p.staked), [100, 100, 100]);
  assert.equal(result.userTxs.length, 1);
  assert.equal(result.lastSeen, events[0].timestamp);
  assert.equal(result.peakRank, '#1 of 1');
});
test('exact balances and address ordering resolve ties consistently', () => {
  const events = [event(2, 'lock', 100, 1), event(1, 'lock', 100, 2)];
  events.push({ ...event(2, 'claim', 0, 3), value: '1' });
  assert.deepEqual(History.computeWalletHistory(address(2), events).timeline.map(p => p.rank), [1, 2, 1]);
});
test('full rank timelines match an independent replay with sorting at every event', () => {
  let seed = 76543;
  function random(max) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % max; }
  const events = Array.from({ length: 700 }, (_, i) => event(1 + random(20), ['lock', 'unlock', 'claim', 'relock', 'withdraw'][random(5)], random(20), i + 1));
  for (let target = 1; target <= 20; target++) {
    const key = address(target), balances = new Map(), expected = [];
    let seen = false, previousRank = null;
    for (const tx of events) {
      let value = balances.get(tx.address) || 0n, amt = BigInt(tx.value);
      if (['lock', 'claim', 'relock'].includes(tx.type)) value += amt;
      if (tx.type === 'unlock') value = value > amt ? value - amt : 0n;
      balances.set(tx.address, value);
      const ordered = [...balances].filter(([, v]) => v > 0n).sort((a, b) => a[1] === b[1] ? a[0].localeCompare(b[0]) : a[1] > b[1] ? -1 : 1);
      const rankIndex = ordered.findIndex(([a]) => a === key), rank = rankIndex < 0 ? null : rankIndex + 1;
      const mine = tx.address === key; seen ||= mine;
      if (mine || (seen && rank !== previousRank)) expected.push([tx.blockNumber, rank]);
      previousRank = rank;
    }
    assert.deepEqual(History.computeWalletHistory(key, events).timeline.map(p => [p.blockNumber, p.rank]), expected);
  }
});
