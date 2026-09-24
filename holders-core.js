const TOKEN = '0x0C03Ce270B4826Ec62e7DD007f0B716068639F7B';
const STAKING = '0x9F6b29E498Ef6BEe4a050fa1F29c31DBE6c6aEF4';
const ZERO = '0x0000000000000000000000000000000000000000';
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

function address(value) {
  if (!ADDRESS_RE.test(String(value))) throw new Error('Invalid address: ' + value);
  return String(value).toLowerCase();
}

function decimalToWei(value) {
  if (!/^\d+(?:\.\d{1,18})?$/.test(String(value))) throw new Error('Invalid TIG amount: ' + value);
  const [whole, fraction = ''] = String(value).split('.');
  return BigInt(whole) * 10n ** 18n + BigInt(fraction.padEnd(18, '0'));
}

function stakingBalances(transactions, throughBlock) {
  const balances = new Map();
  const rows = transactions.filter(t => Number(t.blockNumber) <= throughBlock)
    .sort((a, b) => Number(a.blockNumber) - Number(b.blockNumber) || Number(a.logIndex) - Number(b.logIndex));
  for (const tx of rows) {
    const key = address(tx.address);
    const value = BigInt(tx.value);
    if (value < 0n) throw new Error('Negative staking event');
    const entry = balances.get(key) || { locked: 0n, pending: 0n };
    switch (tx.type) {
      case 'lock':
      case 'claim':
        entry.locked += value; break;
      case 'unlock':
        entry.locked -= value; entry.pending += value; break;
      case 'relock':
        entry.pending -= value; entry.locked += value; break;
      case 'withdraw':
        entry.pending -= value; break;
      case 'reward':
        break;
      default: throw new Error('Unknown staking event: ' + tx.type);
    }
    if (entry.locked < 0n || entry.pending < 0n) {
      throw new Error('Staking events are incomplete for ' + key + ' at ' + tx.blockNumber);
    }
    balances.set(key, entry);
  }
  return balances;
}

function csvCandidates(csv, count = 1000) {
  const lines = csv.trim().split(/\r?\n/);
  if (lines[0] !== 'HolderAddress,Balance') throw new Error('Unexpected Blockscout CSV header');
  if (lines.length <= count) throw new Error('Too few token holders in CSV');
  const rows = [];
  const seen = new Set();
  let previous = null;
  for (const line of lines.slice(1, count + 2)) {
    const [rawAddress, rawAmount, extra] = line.split(',');
    if (extra !== undefined) throw new Error('Unexpected CSV columns');
    const key = address(rawAddress);
    const amount = decimalToWei(rawAmount);
    if (seen.has(key)) throw new Error('Duplicate token holder: ' + key);
    if (previous !== null && amount > previous) throw new Error('Token holders are not sorted');
    seen.add(key); previous = amount;
    rows.push({ address: key, wallet: amount });
  }
  return { addresses: rows.slice(0, count).map(r => r.address), cutoff: rows[count].wallet };
}

function rankRows(walletBalances, staking, excluded = new Set()) {
  const all = new Set([...walletBalances.keys(), ...staking.keys()]);
  const rows = [];
  for (const key of all) {
    if (excluded.has(key)) continue;
    const wallet = walletBalances.get(key) || 0n;
    const stake = staking.get(key) || { locked: 0n, pending: 0n };
    const total = wallet + stake.locked + stake.pending;
    if (total <= 0n) continue;
    rows.push({ address: key, wallet, locked: stake.locked, pending: stake.pending, total });
  }
  rows.sort((a, b) => a.total === b.total
    ? a.address.localeCompare(b.address)
    : a.total > b.total ? -1 : 1);
  return rows;
}

module.exports = { TOKEN, STAKING, ZERO, address, decimalToWei, stakingBalances, csvCandidates, rankRows };
