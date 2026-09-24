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
