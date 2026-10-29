const test = require('node:test');
const assert = require('node:assert/strict');
const { IDBFactory } = require('fake-indexeddb');
const Cache = require('./cache-store');
async function database() {
  const factory = new IDBFactory();
  return new Promise((resolve, reject) => {
    const req = factory.open('cache', 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('txs', { keyPath: 'id' }).createIndex('block', 'blockNumber');
      req.result.createObjectStore('meta', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
  });
}
test('corrected snapshots remove old events even at a lower block and record count', async () => {
  const db = await database();
  try {
    await Cache.replaceSnapshot(db, [{ id: 'a', blockNumber: 1 }, { id: 'orphan', blockNumber: 10 }], { lastBlock: 10, snapshotSig: 'old' });
    await Cache.replaceSnapshot(db, [{ id: 'b', blockNumber: 1 }], { lastBlock: 9, snapshotSig: 'corrected' });
    assert.deepEqual(await Cache.readState(db), { transactions: [{ id: 'b', blockNumber: 1 }], metadata: { lastBlock: 9, snapshotSig: 'corrected' } });
  } finally { db.close(); }
});
test('failed snapshot replacement rolls back both the clear and metadata changes', async () => {
  const db = await database();
  try {
    await Cache.replaceSnapshot(db, [{ id: 'old', blockNumber: 10 }], { lastBlock: 10 });
    const before = await Cache.readState(db);
    await assert.rejects(Cache.replaceSnapshot(db, [{ id: 'bad', blockNumber: 1, bad: () => {} }], { lastBlock: 1 }));
    assert.deepEqual(await Cache.readState(db), before);
  } finally { db.close(); }
});
test('a replay replaces the entire tail, including empty canonical ranges', async () => {
  const db = await database();
  try {
    await Cache.replaceSnapshot(db, [{ id: 'prefix', blockNumber: 1 }, { id: 'orphan', blockNumber: 10 }, { id: 'future', blockNumber: 20 }], { lastBlock: 20, snapshotSig: 'base' });
    await Cache.commitRange(db, 10, [{ id: 'canonical', blockNumber: 12 }], { lastBlock: 15, lastBlockHash: 'verified' });
    const state = await Cache.readState(db);
    assert.deepEqual(state.transactions.map(t => t.id).sort(), ['canonical', 'prefix']);
    assert.equal(state.metadata.lastBlock, 15);
    assert.equal(state.metadata.snapshotSig, 'base');
    await Cache.commitRange(db, 10, [], { lastBlock: 11 });
    assert.deepEqual((await Cache.readState(db)).transactions.map(t => t.id), ['prefix']);
  } finally { db.close(); }
});
test('failed tail replay preserves the original events and cursor', async () => {
  const db = await database();
  try {
    await Cache.replaceSnapshot(db, [{ id: 'old', blockNumber: 10 }], { lastBlock: 10 });
    const before = await Cache.readState(db);
    await assert.rejects(Cache.commitRange(db, 10, [{ id: 'bad', bad: () => {} }], { lastBlock: 12 }));
    assert.deepEqual(await Cache.readState(db), before);
  } finally { db.close(); }
});
