const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { ethers } = require('ethers');
const html = fs.readFileSync(`${__dirname}/index.html`, 'utf8');
const start = html.indexOf('  function replayActiveWei(');
const end = html.indexOf('  function computePersonalWallet(', start);
const context = vm.createContext({ ethers, isFoundation: () => false,
  normalizeType: t => ({ stake: 'lock', unstake: 'withdraw' })[t] || t });
vm.runInContext(html.slice(start, end), context);
const alice = '0x' + '1'.repeat(40), bob = '0x' + '2'.repeat(40);
function event(address, type, amount, logIndex, blockNumber = 1) {
  return { address, type, value: ethers.parseUnits(amount, 18).toString(), valueTig: Number(amount),
    logIndex, blockNumber, timestamp: 1000 + blockNumber };
}

test('inspector ranks the peak event before a same-block unlock', () => {
  const events = [event(bob, 'lock', '50', 0), event(alice, 'lock', '100', 1), event(alice, 'unlock', '100', 2)];
  const result = context.computeWalletHistory(alice, events);
  assert.equal(result.peakBal, 100);
  assert.equal(result.peakRank, '#1 of 2');
  assert.equal(result.timeline[0].rank, 1);
  assert.equal(result.timeline[1].rank, null);
  assert.equal(result.curStaked, 0);
  assert.equal(result.curPending, 100);
});

test('complete exits leave no phantom active balance', () => {
  const events = [event(alice, 'lock', '0.1', 0), event(alice, 'claim', '0.2', 1),
    event(alice, 'unlock', '0.3', 2), event(alice, 'withdraw', '0.3', 3)];
  assert.equal(context.replayActiveWei(events).get(alice), 0n);
  const result = context.computeWalletHistory(alice, events);
  assert.equal(result.curStaked, 0);
  assert.equal(result.curPending, 0);
  assert.equal(result.totalWithdrawn, 0.3);
  assert.equal(result.timeline.at(-1).rank, null);
});

test('historical ranks respect event order and relocking restores active stake', () => {
  const events = [event(alice, 'lock', '100', 1), event(alice, 'unlock', '40', 2),
    event(alice, 'relock', '10', 3), event(alice, 'withdraw', '30', 4)];
  const result = context.computeWalletHistory(alice, events.slice().reverse());
  assert.equal(result.curStaked, 70);
  assert.equal(result.curPending, 0);
  assert.equal(result.totalWithdrawn, 30);
  assert.equal(result.peakRank, '#1 of 1');
});

test('dashboard scripts parse and the chart library is loaded', () => {
  for (const [, script] of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new vm.Script(script);
  assert.match(html, /<script[^>]+src="https:\/\/cdn\.jsdelivr\.net\/npm\/chart\.js@4\.4\.9\/dist\/chart\.umd\.min\.js"/);
});

test('small positive TIG balances never display as zero', () => {
  const start = html.indexOf('  function fmt(n)');
  const end = html.indexOf('  function fmt2(', start);
  vm.runInContext(html.slice(start, end), context);
  assert.equal(context.fmt(1e-18), '<0.01');
  assert.equal(context.fmt(0.3), '0.3');
  assert.equal(context.fmt(0), '0');
});

async function dashboardStats(events) {
  const statsContext = vm.createContext({ ethers, db: { all: async () => events },
    statsCache: null, statsCacheTime: 0, pendingPeriodSec: 28 * 86400,
    C: { COHORT_DIAMOND: 180, COHORT_LONG: 90, COHORT_MEDIUM: 30, DORMANCY_DAYS: 90 },
    isBlacklisted: () => false, isFoundation: () => false,
    normalizeType: context.normalizeType,
    clamp: (v, lo, hi) => Math.max(lo, Math.min(hi, v)) });
  vm.runInContext(html.slice(html.indexOf('  var TIERS = ['), html.indexOf('  function escapeHtml(')), statsContext);
  vm.runInContext(html.slice(html.indexOf('  function consumePending('), html.indexOf('  function makeChart(')), statsContext);
  vm.runInContext(html.slice(start, end), statsContext);
  return statsContext.getStats(false);
}

test('dashboard joins checksum and lowercase addresses for holder metadata and alerts', async () => {
  const checksum = ethers.getAddress('0x' + 'ab'.repeat(20));
  const now = Math.floor(Date.now() / 1000);
  const old = now - 200 * 86400;
  const events = [
    { ...event(checksum, 'lock', '100', 0, 1), timestamp: old },
    { ...event(checksum.toLowerCase(), 'lock', '50', 0, 2), timestamp: now - 200 },
    { ...event(checksum, 'unlock', '20', 0, 3), timestamp: now - 100 }
  ];
  const result = await dashboardStats(events);
  assert.equal(result.holders.length, 1);
  assert.equal(result.holders[0].balance, 130);
  assert.equal(result.holders[0].firstSeen, old);
  assert.equal(result.holders[0].txCount, 3);
  assert.equal(result.holders[0].pending, 20);
  assert.equal(result.stats.totalStakers, 1);
  assert.equal(result.cohorts[0].key, 'diamond');
  assert.equal(result.cohorts[0].netFlow7d, 30);
  assert.equal(result.tiers.find(tier => tier.key === 'crab').netFlow7d, 30);
  assert.equal(result.whaleAlerts[0].unstaked, 20);
  assert.equal(events[0].address, checksum, 'stored events must remain unchanged');
});

test('dashboard replays blocks in chain order when timestamps tie', async () => {
  const events = [event(alice, 'lock', '100', 100, 1), event(alice, 'unlock', '40', 0, 2)]
    .map(tx => ({ ...tx, timestamp: 1000 }));
  const result = await dashboardStats(events.slice().reverse());
  assert.equal(result.holders[0].balance, 60);
  assert.equal(result.totalStakedSeries.at(-1).val, 60);
  assert.equal(result.sorted[0].blockNumber, 1);
});
