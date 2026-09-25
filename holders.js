/** Build a block-pinned Top 500 candidate snapshot from free Blockscout and Base RPC data. */
const fs = require('node:fs');
const { enrichHolderHistory } = require('./holder-history');
const { ethers } = require('ethers');
const { TOKEN, STAKING, ZERO, address, stakingBalances, csvCandidates, rankRows } = require('./holders-core');

const CSV_URL = 'https://base.blockscout.com/api/v2/tokens/' + TOKEN + '/holders/csv';
const RPCS = [
  'https://mainnet.base.org',
  'https://1rpc.io/base',
  'https://base.drpc.org'
];
const TARGET = 1000;
const BATCH = 100;
const PAUSE_MS = 350;
const MULTICALL = '0xcA11bde05977b3631167028862bE2a173976CA11';
const MULTICALL_IFACE = new ethers.Interface([
  'function aggregate3(tuple(address target,bool allowFailure,bytes callData)[] calls) payable returns (tuple(bool success,bytes returnData)[] returnData)'
]);
const TOKEN_IFACE = new ethers.Interface([
  'function balanceOf(address) view returns (uint256)',
  'event Transfer(address indexed from,address indexed to,uint256 value)'
]);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const hexBlock = block => '0x' + block.toString(16);

async function request(url, options, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) throw new Error(url + ': HTTP ' + response.status);
    return response;
  } finally { clearTimeout(timer); }
}

async function rpc(method, params, start = 0) {
  let lastError;
  for (let attempt = 0; attempt < 9; attempt++) {
    const url = RPCS[(start + attempt) % RPCS.length];
    try {
      const response = await request(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
      });
      const result = await response.json();
      if (result.error || result.result === undefined) throw new Error(JSON.stringify(result.error || result));
      return result.result;
    } catch (error) {
      lastError = error;
      await sleep(Math.min(10000, 500 * 2 ** attempt));
    }
  }
  throw new Error(method + ' failed: ' + lastError);
}

async function tokenBalances(addresses, block) {
  const balances = new Map();
  const tag = hexBlock(block);
  for (let offset = 0; offset < addresses.length; offset += BATCH) {
    const chunk = addresses.slice(offset, offset + BATCH);
    const calls = chunk.map(key => ({
      target: TOKEN, allowFailure: false,
      callData: TOKEN_IFACE.encodeFunctionData('balanceOf', [key])
    }));
    const callData = MULTICALL_IFACE.encodeFunctionData('aggregate3', [calls]);
    let lastError;
    let result;
    for (let attempt = 0; attempt < 9; attempt++) {
      try {
        const raw = await rpc('eth_call', [{ to: MULTICALL, data: callData }, tag], attempt);
        result = MULTICALL_IFACE.decodeFunctionResult('aggregate3', raw)[0];
        if (result.length !== calls.length) throw new Error('Incomplete multicall');
        chunk.forEach((key, index) => {
          const item = result[index];
          if (!item.success) throw new Error('balanceOf reverted for ' + key);
          balances.set(key, TOKEN_IFACE.decodeFunctionResult('balanceOf', item.returnData)[0]);
        });
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        await sleep(Math.min(10000, 500 * 2 ** attempt));
      }
    }
    if (lastError) throw new Error('balanceOf failed at ' + offset + ': ' + lastError);
    if ((offset / BATCH) % 10 === 0) console.log('Balances', Math.min(offset + BATCH, addresses.length), '/', addresses.length);
    await sleep(PAUSE_MS);
  }
  return balances;
}

async function changedAddresses(fromBlock, toBlock) {
  const changed = new Set();
  const topic = TOKEN_IFACE.getEvent('Transfer').topicHash;
  for (let start = fromBlock; start <= toBlock; start += 1500) {
    const end = Math.min(start + 1499, toBlock);
    const logs = await rpc('eth_getLogs', [{
      address: TOKEN, topics: [topic], fromBlock: hexBlock(start), toBlock: hexBlock(end)
    }]);
    for (const log of logs) {
      if (log.topics.length !== 3) throw new Error('Unexpected TIG Transfer log');
      changed.add(address('0x' + log.topics[1].slice(-40)));
      changed.add(address('0x' + log.topics[2].slice(-40)));
    }
  }
  return changed;
}

async function run() {
  const data = JSON.parse(fs.readFileSync('data.json', 'utf8'));
  const block = Number(data.metadata?.lastBlock);
  if (!Number.isSafeInteger(block) || block < Number(data.config?.firstBlock)) throw new Error('Invalid staking snapshot block');
  if (!Array.isArray(data.transactions)) throw new Error('Missing staking transactions');
  const chainHead = Number(BigInt(await rpc('eth_blockNumber', [])));
  if (chainHead - block > 15000) throw new Error('Staking snapshot is too old for holders snapshot');
  const blockInfo = await rpc('eth_getBlockByNumber', [hexBlock(block), false]);
  if (!blockInfo || !blockInfo.hash) throw new Error('Missing snapshot block');

  const staking = stakingBalances(data.transactions, block);
  console.log('Staking addresses', staking.size, 'at block', block);
  let csv;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      csv = await (await request(CSV_URL, {}, 45000)).text();
      break;
    } catch (error) {
      if (attempt === 4) throw error;
      await sleep(1000 * 2 ** attempt);
    }
  }
  const candidates = csvCandidates(csv, TARGET);
  const all = new Set(candidates.addresses);
  const afterCsvHead = Number(BigInt(await rpc('eth_blockNumber', [])));
  if (afterCsvHead - block > 15000) throw new Error('Holder discovery interval is too large');
  const changed = await changedAddresses(block + 1, afterCsvHead);
  changed.forEach(key => all.add(key));
  console.log('Changed addresses since snapshot block', changed.size);
  staking.forEach((balance, key) => {
    if (balance.locked + balance.pending > 0n) all.add(key);
  });
  all.delete(address(STAKING));
  const keys = [...all].sort();
  const wallets = await tokenBalances(keys, block);
  const excluded = new Set([
    address(STAKING), address(ZERO),
    '0x0000000000000000000000000000000000000001',
    '0x000000000000000000000000000000000000dead'
  ]);
  const ranked = rankRows(wallets, staking, excluded);
  if (ranked.length < 500 || ranked[499].total <= candidates.cutoff) {
    throw new Error('Candidate coverage is insufficient for a Top 500 ranking');
  }
  const supply = BigInt(await rpc('eth_call', [{ to: TOKEN, data: '0x18160ddd' }, hexBlock(block)]));
  const payload = {
    version: 1,
    token: TOKEN,
    staking: STAKING,
    block,
    blockHash: blockInfo.hash,
    timestamp: Number(BigInt(blockInfo.timestamp)),
    generatedAt: new Date().toISOString(),
    source: 'Blockscout holder candidates; on-chain balanceOf and staking events at one block',
    totalSupply: supply.toString(),
    candidateCount: keys.length,
    candidateCutoff: candidates.cutoff.toString(),
    candidates: ranked.map(row => ({
      address: row.address,
      wallet: row.wallet.toString(),
      locked: row.locked.toString(),
      pending: row.pending.toString()
    })),
    top500: ranked.slice(0, 500).map((row, index) => ({
      rank: index + 1,
      address: row.address,
      wallet: row.wallet.toString(),
      locked: row.locked.toString(),
      pending: row.pending.toString(),
      total: row.total.toString()
    }))
  };
  let previous = {};
  try { previous = JSON.parse(fs.readFileSync('holders.json', 'utf8')); } catch (_) {}
  await enrichHolderHistory(payload, previous);
  const temp = 'holders.json.tmp';
  fs.writeFileSync(temp, JSON.stringify(payload));
  fs.renameSync(temp, 'holders.json');
  console.log('Wrote holders.json at', block, 'with', payload.candidateCount, 'candidates');
}

if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { run, tokenBalances };
