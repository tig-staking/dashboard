(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('node:crypto').webcrypto);
  else root.TigChain = factory(root.crypto);
}(typeof globalThis !== 'undefined' ? globalThis : this, function (crypto) {
  'use strict';
  var HASH = /^0x[0-9a-fA-F]{64}$/;
  function validHash(value) { return typeof value === 'string' && HASH.test(value); }
  async function anchor(provider, number) {
    var block = await provider.getBlock(number);
    if (!block || block.number !== number || !validHash(block.hash) || !Number.isSafeInteger(block.timestamp) || block.timestamp <= 0) {
      throw new Error('Missing verified block header at ' + number);
    }
    return { number: number, hash: block.hash.toLowerCase(), timestamp: block.timestamp };
  }
  function sameHash(a, b) { return validHash(a) && validHash(b) && a.toLowerCase() === b.toLowerCase(); }
  async function planReplay(provider, metadata, firstBlock, head) {
    var last = Number(metadata.lastBlock);
    if (!Number.isSafeInteger(last) || last < firstBlock - 1) return { fromBlock: firstBlock, reason: 'initial' };
    if (head < last) throw new Error('RPC head is behind the stored data');
    if (last < firstBlock) return { fromBlock: firstBlock, reason: 'initial' };
    if (!validHash(metadata.lastBlockHash)) return { fromBlock: Math.max(firstBlock, last - 9999), reason: 'legacy verification' };
    if (sameHash((await anchor(provider, last)).hash, metadata.lastBlockHash)) return { fromBlock: last + 1, reason: 'continue' };
    var points = (Array.isArray(metadata.anchors) ? metadata.anchors : []).filter(function (point) {
      return Number.isSafeInteger(point.number) && point.number >= firstBlock && point.number < last && validHash(point.hash);
    }).sort(function (a, b) { return b.number - a.number; });
    for (var i = 0; i < points.length; i++) {
      if (sameHash((await anchor(provider, points[i].number)).hash, points[i].hash)) {
        return { fromBlock: points[i].number + 1, reason: 'chain reorganization' };
      }
    }
    return { fromBlock: firstBlock, reason: 'chain reorganization; rebuilding history' };
  }
  function appendAnchor(points, point, fromBlock) {
    var byNumber = new Map();
    (points || []).forEach(function (item) {
      if (Number.isSafeInteger(item.number) && item.number < fromBlock && validHash(item.hash)) byNumber.set(item.number, item);
    });
    byNumber.set(point.number, point);
    return Array.from(byNumber.values()).sort(function (a, b) { return a.number - b.number; }).slice(-64);
  }
  function assertLog(log, block) {
    if (!block || log.removed || Number(log.blockNumber) !== block.number || !sameHash(log.blockHash, block.hash)) {
      throw new Error('Log belongs to a replaced or unverified block at ' + log.blockNumber);
    }
  }
  async function verifyPrefix(provider, metadata, fromBlock) {
    var points = Array.isArray(metadata.anchors) ? metadata.anchors.slice() : [];
    if (validHash(metadata.lastBlockHash)) points.push({ number: Number(metadata.lastBlock), hash: metadata.lastBlockHash });
    points = points.filter(function (p) { return Number.isSafeInteger(p.number) && p.number < fromBlock && validHash(p.hash); }).sort(function (a, b) { return b.number - a.number; });
    if (points.length && !sameHash(points[0].hash, (await anchor(provider, points[0].number)).hash)) throw new Error('Chain changed before batch; retry from a verified checkpoint');
  }
  async function digest(transactions) {
    if (!crypto || !crypto.subtle) throw new Error('Snapshot integrity verification is unavailable');
    var bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(transactions)));
    return '0x' + Array.from(new Uint8Array(bytes)).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
  }
  async function prepareSnapshot(data, expected) {
    if (!data || !data.metadata || !data.config || !Array.isArray(data.transactions)) throw new Error('Invalid staking snapshot');
    var meta = data.metadata, config = data.config;
    if (String(config.token).toLowerCase() !== expected.token.toLowerCase() ||
        String(config.staking).toLowerCase() !== expected.staking.toLowerCase() || config.firstBlock !== expected.firstBlock) throw new Error('Snapshot contract mismatch');
    if (!Number.isSafeInteger(meta.lastBlock) || meta.lastBlock < expected.firstBlock - 1 ||
        !Number.isSafeInteger(meta.lastSync) || meta.lastSync <= 0 || meta.lastSync > Date.now() + 300000 ||
        (meta.total !== undefined && meta.total !== data.transactions.length)) throw new Error('Invalid snapshot coverage');
    if (meta.lastBlockHash != null && !validHash(meta.lastBlockHash)) throw new Error('Invalid snapshot block hash');
    var hash = await digest(data.transactions);
    if (meta.contentHash != null && !sameHash(hash, meta.contentHash)) throw new Error('Snapshot content hash mismatch');
    var ids = new Set();
    var rows = data.transactions.map(function (tx) {
      var type = ({ stake: 'lock', unstake: 'withdraw' })[tx.type] || tx.type;
      if (!validHash(tx.hash) || !Number.isSafeInteger(tx.blockNumber) || tx.blockNumber < expected.firstBlock || tx.blockNumber > meta.lastBlock ||
          !Number.isSafeInteger(tx.logIndex) || tx.logIndex < 0 || !Number.isSafeInteger(tx.timestamp) || tx.timestamp <= 0 ||
          !/^0x[0-9a-fA-F]{40}$/.test(tx.address) || !/^\d+$/.test(String(tx.value)) ||
          !['lock', 'claim', 'unlock', 'relock', 'withdraw', 'reward'].includes(type)) throw new Error('Invalid snapshot event');
      var id = tx.hash + '-' + tx.logIndex;
      if ((tx.id && tx.id !== id) || ids.has(id)) throw new Error('Duplicate or inconsistent snapshot event');
      ids.add(id);
      if (tx.blockHash != null && !validHash(tx.blockHash)) throw new Error('Invalid event block hash');
      if (type === 'unlock' && (!Number.isSafeInteger(tx.withdrawableTime) || tx.withdrawableTime <= 0)) throw new Error('Invalid withdrawal time');
      return Object.assign({}, tx, { id: id, type: type });
    });
    rows.sort(function (a, b) { return a.blockNumber - b.blockNumber || a.logIndex - b.logIndex; });
    return { rows: rows, metadata: {
      lastBlock: meta.lastBlock, lastSync: meta.lastSync, lastBlockHash: meta.lastBlockHash || null,
      lastBlockTimestamp: meta.lastBlockTimestamp || null, anchors: meta.anchors || [],
      snapshotSig: [meta.lastBlock, meta.lastBlockHash || 'legacy', hash].join('|'),
      snapshotCreatedAt: meta.lastSync, snapshotCount: rows.length, snapshotLastBlock: meta.lastBlock
    } };
  }
  return { validHash: validHash, sameHash: sameHash, anchor: anchor, planReplay: planReplay,
    appendAnchor: appendAnchor, assertLog: assertLog, verifyPrefix: verifyPrefix, digest: digest, prepareSnapshot: prepareSnapshot };
}));
