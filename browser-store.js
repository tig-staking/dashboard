(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./cache-store'));
  else root.TigStorage = factory(root.TigCache);
}(typeof globalThis !== 'undefined' ? globalThis : this, function (Cache) {
  'use strict';
  function copy(value) { return structuredClone(value); }
  function MemoryStore(initial) { this.data = copy(initial || { transactions: [], metadata: {} }); }
  MemoryStore.prototype.state = async function () { return copy(this.data); };
  MemoryStore.prototype.replaceSnapshot = async function (rows, metadata) {
    var next = copy({ transactions: rows, metadata: metadata }); this.data = next; return rows.length;
  };
  MemoryStore.prototype.commitRange = async function (from, rows, metadata) {
    var fresh = copy({ transactions: rows, metadata: metadata });
    var byId = new Map(this.data.transactions.filter(function (row) { return row.blockNumber < from; }).map(function (row) { return [row.id, row]; }));
    fresh.transactions.forEach(function (row) { byId.set(row.id, row); });
    this.data = { transactions: Array.from(byId.values()), metadata: Object.assign({}, this.data.metadata, fresh.metadata) };
    return rows.length;
  };
  MemoryStore.prototype.all = async function () { return copy(this.data.transactions); };
  MemoryStore.prototype.count = async function () { return this.data.transactions.length; };
  MemoryStore.prototype.meta = async function (key) { return copy(this.data.metadata[key]); };
  MemoryStore.prototype.setMeta = async function (key, value) { var next = copy(value); this.data.metadata[key] = next; };
  MemoryStore.prototype.clear = async function () { this.data = { transactions: [], metadata: {} }; };
  function storageError(error) { return error && ['SecurityError', 'QuotaExceededError', 'InvalidStateError', 'UnknownError', 'AbortError', 'NotFoundError', 'VersionError', 'TimeoutError'].includes(error.name); }
  function request(db, store, mode, action) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(store, mode), req = action(tx.objectStore(store));
      tx.oncomplete = function () { resolve(req && req.result); };
      tx.onabort = function () { reject(tx.error || new DOMException('Storage transaction aborted', 'AbortError')); };
    });
  }
  function createStore(options) {
    var persistent = null, memory = null, mirror = new MemoryStore(), opening = null, queue = Promise.resolve();
    async function fallback(error) {
      if (memory) return;
      if (persistent) {
        try { mirror = new MemoryStore(await Cache.readState(persistent)); } catch (_) {}
        persistent.close(); persistent = null;
      }
      memory = mirror;
      if (options.onModeChange) options.onModeChange({ mode: 'memory', reason: error && error.name || 'Unavailable' });
    }
    async function open() {
      if (memory || persistent) return;
      if (opening) return opening;
      opening = new Promise(function (resolve) {
        var req, settled = false;
        var timer = setTimeout(function () { fail(new DOMException('Storage open timed out', 'TimeoutError')); }, options.openTimeoutMs || 4000);
        function fail(error) {
          if (settled) return; settled = true; clearTimeout(timer);
          fallback(error).then(resolve);
        }
        try { req = options.getIndexedDB().open(options.name, options.version); }
        catch (error) { fail(error); return; }
        req.onerror = function () { fail(req.error); };
        req.onblocked = function () { fail(new DOMException('Storage is blocked by another tab', 'InvalidStateError')); };
        req.onupgradeneeded = function () {
          var db = req.result;
          if (settled) { req.transaction.abort(); return; }
          if (!db.objectStoreNames.contains('txs')) {
            var txs = db.createObjectStore('txs', { keyPath: 'id' });
            txs.createIndex('block', 'blockNumber'); txs.createIndex('time', 'timestamp'); txs.createIndex('type', 'type'); txs.createIndex('addr', 'address'); txs.createIndex('hash', 'hash');
          }
          if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
        };
        req.onsuccess = async function () {
          if (settled) { req.result.close(); return; }
          persistent = req.result;
          persistent.onversionchange = function () { if (persistent) persistent.close(); persistent = null; };
          try { mirror = new MemoryStore(await Cache.readState(persistent)); }
          catch (error) { fail(error); return; }
          settled = true; clearTimeout(timer); resolve();
        };
      });
      try { await opening; } finally { opening = null; }
    }
    async function disk(method, args) {
      if (method === 'state' || method === 'all') {
        var state = await Cache.readState(persistent); mirror = new MemoryStore(state);
        return method === 'state' ? state : state.transactions;
      }
      if (method === 'replaceSnapshot' || method === 'commitRange') {
        var result = await Cache[method].apply(null, [persistent].concat(args)); await mirror[method].apply(mirror, args); return result;
      }
      if (method === 'clear') { await Cache.replaceSnapshot(persistent, [], {}); return mirror.clear(); }
      if (method === 'count') return request(persistent, 'txs', 'readonly', function (s) { return s.count(); });
      if (method === 'meta') { var item = await request(persistent, 'meta', 'readonly', function (s) { return s.get(args[0]); }); return item && item.value; }
      if (method === 'setMeta') { await request(persistent, 'meta', 'readwrite', function (s) { s.put({ key: args[0], value: args[1] }); }); return mirror.setMeta.apply(mirror, args); }
      throw new Error('Unknown storage operation');
    }
    var api = { open: open, mode: function () { return memory ? 'memory' : 'persistent'; } };
    ['state', 'all', 'count', 'meta', 'setMeta', 'replaceSnapshot', 'commitRange', 'clear'].forEach(function (method) {
      api[method] = function () {
        var args = Array.from(arguments);
        var operation = queue.then(async function () {
          await open();
          if (memory) return memory[method].apply(memory, args);
          try { return await disk(method, args); }
          catch (error) { if (!storageError(error)) throw error; await fallback(error); return memory[method].apply(memory, args); }
        });
        queue = operation.catch(function () {}); return operation;
      };
    });
    api.close = async function () { await queue; if (persistent) persistent.close(); persistent = null; };
    return api;
  }
  return { createStore: createStore, MemoryStore: MemoryStore };
}));
