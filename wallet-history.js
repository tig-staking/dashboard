(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('ethers').ethers);
  else root.TigHistory = factory(root.ethers);
}(typeof globalThis !== 'undefined' ? globalThis : this, function (ethers) {
  'use strict';
  var cache = new WeakMap();
  function typeOf(tx) { return ({ stake: 'lock', unstake: 'withdraw' })[tx.type] || tx.type; }
  function amount(tx) { return tx.value != null ? BigInt(tx.value) : ethers.parseUnits(Number(tx.valueTig || 0).toFixed(18), 18); }
  function tig(value) { return Number(ethers.formatUnits(value, 18)); }
  function nextBalance(balance, type, value) {
    if (type === 'lock' || type === 'claim' || type === 'relock') return balance + value;
    if (type === 'unlock') return balance > value ? balance - value : 0n;
    return balance;
  }
  function replayActiveWei(events) {
    var balances = new Map();
    events.forEach(function (tx) {
      var address = String(tx.address).toLowerCase();
      balances.set(address, nextBalance(balances.get(address) || 0n, typeOf(tx), amount(tx)));
    });
    return balances;
  }
  // Keep one ordered list, updated at the changed address. Binary searches avoid
  // sorting all holders at each event, including events of other wallets.
  function compare(a, b) { return a.value === b.value ? (a.address < b.address ? -1 : a.address > b.address ? 1 : 0) : a.value > b.value ? -1 : 1; }
  function position(list, item) {
    var lo = 0, hi = list.length;
    while (lo < hi) { var mid = (lo + hi) >>> 1; if (compare(list[mid], item) < 0) lo = mid + 1; else hi = mid; }
    return lo;
  }
  function computeWalletHistory(addr, source) {
    if (!addr || !source) return null;
    var target = addr.toLowerCase(), memo = cache.get(source);
    if (memo && memo.has(target)) return memo.get(target);
    if (!memo) { memo = new Map(); cache.set(source, memo); }
    var balances = new Map(), active = [], userTxs = [], timeline = [];
    var pending = 0n, withdrawn = 0n, peak = 0n, peakTime = 0, peakRank = 'N/A', previousRank = null;
    var events = source.slice().sort(function (a, b) { return Number(a.blockNumber) - Number(b.blockNumber) || Number(a.logIndex || 0) - Number(b.logIndex || 0); });
    events.forEach(function (tx) {
      var address = String(tx.address).toLowerCase(), type = typeOf(tx), value = amount(tx);
      var old = balances.get(address) || 0n, balance = nextBalance(old, type, value);
      if (balance !== old) {
        if (old > 0n) active.splice(position(active, { address: address, value: old }), 1);
        if (balance > 0n) active.splice(position(active, { address: address, value: balance }), 0, { address: address, value: balance });
      }
      balances.set(address, balance);
      var mine = address === target, targetBalance = balances.get(target) || 0n;
      var rank = targetBalance > 0n ? position(active, { address: target, value: targetBalance }) + 1 : null;
      if (mine) {
        userTxs.push(tx);
        if (type === 'unlock') pending += value;
        else if (type === 'relock' || type === 'withdraw') pending = pending > value ? pending - value : 0n;
        if (type === 'withdraw') withdrawn += value;
        if (balance > peak) { peak = balance; peakTime = tx.timestamp; peakRank = '#' + rank + ' of ' + active.length; }
      }
      if (mine || (userTxs.length && rank !== previousRank)) {
        timeline.push({ ts: tx.timestamp, blockNumber: tx.blockNumber, logIndex: tx.logIndex,
          staked: tig(targetBalance), rank: rank, type: mine ? type : 'rank', value: mine ? tig(value) : 0, tx: mine ? tx : null });
      }
      previousRank = rank;
    });
    var result = userTxs.length ? { address: addr, userTxs: userTxs, curStaked: tig(balances.get(target) || 0n), curPending: tig(pending),
      totalWithdrawn: tig(withdrawn), peakBal: tig(peak), peakTime: peakTime || userTxs[0].timestamp, peakRank: peakRank,
      firstSeen: userTxs[0].timestamp, lastSeen: userTxs[userTxs.length - 1].timestamp, timeline: timeline } : null;
    memo.set(target, result);
    return result;
  }
  return { replayActiveWei: replayActiveWei, computeWalletHistory: computeWalletHistory };
}));
