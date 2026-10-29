const test = require('node:test');
const assert = require('node:assert/strict');
const { IDBFactory } = require('fake-indexeddb');
const Cache = require('./cache-store');
const { createStore } = require('./browser-store');
const options = extra => ({ name: 'cache', version: 1, getIndexedDB: () => new IDBFactory(), ...extra });
const original = [{ id: 'prefix', blockNumber: 1 }, { id: 'tail', blockNumber: 9 }];
test('missing or denied IndexedDB supports the same coherent state and corrected snapshots in memory', async () => {
  for (const getter of [() => undefined, () => { throw new DOMException('Denied', 'SecurityError'); }]) {
    const modes = [], db = createStore(options({ getIndexedDB: getter, onModeChange: mode => modes.push(mode) }));
    await db.open();
    await db.replaceSnapshot(original, { lastBlock: 9 });
    await db.commitRange(9, [{ id: 'new', blockNumber: 10 }], { lastBlock: 10 });
    assert.equal(db.mode(), 'memory'); assert.equal(modes.length, 1);
    const state = await db.state();
    assert.deepEqual(state.transactions.map(t => t.id), ['prefix', 'new']);
    assert.equal(state.metadata.lastBlock, 10);
    state.transactions[0].id = 'mutated';
    assert.equal((await db.state()).transactions[0].id, 'prefix');
    await db.clear(); assert.equal(await db.count(), 0); assert.equal(await db.meta('lastBlock'), undefined);
  }
});
test('blocked or hanging opens switch to memory, and a late connection is closed', async () => {
  for (const blocked of [true, false]) {
    const request = {}, db = createStore(options({ openTimeoutMs: 5, getIndexedDB: () => ({ open: () => { if (blocked) queueMicrotask(() => request.onblocked()); return request; } }) }));
    await db.open(); assert.equal(db.mode(), 'memory');
    let closed = 0; request.result = { close: () => closed++ }; await request.onsuccess();
    assert.equal(closed, 1);
  }
});
test('quota exhaustion keeps the previous complete state and retries the failed range in memory', async () => {
  const factory = new IDBFactory(), db = createStore(options({ getIndexedDB: () => factory }));
  await db.replaceSnapshot(original, { lastBlock: 9 });
  const commit = Cache.commitRange;
  try {
    Cache.commitRange = async () => { throw new DOMException('Full', 'QuotaExceededError'); };
    await db.commitRange(9, [{ id: 'corrected', blockNumber: 8 }], { lastBlock: 8 });
    assert.equal(db.mode(), 'memory');
    assert.equal(await db.meta('lastBlock'), 8);
    assert.deepEqual((await db.all()).map(t => t.id), ['prefix', 'corrected']);
    const persistent = createStore(options({ getIndexedDB: () => factory }));
    assert.equal(await persistent.meta('lastBlock'), 9);
    assert.deepEqual((await persistent.all()).map(t => t.id), ['prefix', 'tail']);
    await persistent.close();
  } finally { Cache.commitRange = commit; await db.close(); }
});
test('invalid writes are rejected atomically in both modes and do not trigger storage fallback', async () => {
  for (const getter of [() => new IDBFactory(), () => undefined]) {
    const db = createStore(options({ getIndexedDB: getter }));
    await db.replaceSnapshot(original, { lastBlock: 9 }); const mode = db.mode();
    await assert.rejects(db.replaceSnapshot([{ id: 'invalid', bad: () => {} }], { lastBlock: 1 }), { name: 'DataCloneError' });
    assert.equal(db.mode(), mode);
    assert.equal(await db.count(), 2); assert.equal(await db.meta('lastBlock'), 9);
    await db.close();
  }
});
test('concurrent memory writes are serialized and progress never points past missing events', async () => {
  const db = createStore(options({ getIndexedDB: () => undefined }));
  await db.replaceSnapshot([], { lastBlock: 0 });
  await Promise.all([db.commitRange(1, [{ id: 'one', blockNumber: 1 }], { lastBlock: 1 }), db.commitRange(2, [{ id: 'two', blockNumber: 2 }], { lastBlock: 2 })]);
  assert.equal(await db.count(), 2); assert.equal(await db.meta('lastBlock'), 2);
});
