(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.TigCache = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  function readState(db) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(['txs', 'meta'], 'readonly');
      var rows = tx.objectStore('txs').getAll(), meta = tx.objectStore('meta').getAll();
      tx.oncomplete = function () {
        var metadata = {};
        meta.result.forEach(function (item) { metadata[item.key] = item.value; });
        resolve({ transactions: rows.result, metadata: metadata });
      };
      tx.onabort = function () { reject(tx.error || new Error('Cache read aborted')); };
    });
  }
  function write(db, fromBlock, items, metadata, replaceAll) {
    return new Promise(function (resolve, reject) {
      var tx = db.transaction(['txs', 'meta'], 'readwrite'), error;
      tx.oncomplete = function () { resolve(items.length); };
      tx.onabort = function () { reject(error || tx.error || new Error('Cache write aborted')); };
      function insert() {
        try {
          var store = tx.objectStore('txs'), meta = tx.objectStore('meta');
          items.forEach(function (row) { store.put(row); });
          Object.keys(metadata).forEach(function (key) { meta.put({ key: key, value: metadata[key] }); });
        } catch (e) { error = e; tx.abort(); }
      }
      try {
        var store = tx.objectStore('txs');
        if (replaceAll) {
          store.clear(); tx.objectStore('meta').clear(); insert();
        } else {
          var cursor = store.index('block').openCursor();
          cursor.onsuccess = function () {
            var item = cursor.result;
            if (!item) { insert(); return; }
            if (Number(item.key) < fromBlock) { item.continue(fromBlock); return; }
            item.delete(); item.continue();
          };
        }
      } catch (e) { error = e; tx.abort(); }
    });
  }
  return { readState: readState,
    replaceSnapshot: function (db, rows, metadata) { return write(db, 0, rows, metadata, true); },
    commitRange: function (db, fromBlock, rows, metadata) { return write(db, fromBlock, rows, metadata, false); }
  };
}));
