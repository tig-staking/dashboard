// A separate, resumable rebuild. This command never writes production data.json.
const fs = require('node:fs');
const path = require('node:path');
const { ethers } = require('ethers');
const Chain = require('./chain-state');
const { createProvider } = require('./rpc');
const { getLogsChunk, LOCKER_ABI, EVENT_TYPE } = require('./sync');
const iface = new ethers.Interface(LOCKER_ABI);
const topics = [Object.keys(EVENT_TYPE).map(name => iface.getEvent(name).topicHash)];

async function parallel(items, concurrency, work) {
  const results = new Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) { const i = next++; results[i] = await work(items[i]); }
  }));
  return results;
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.tmp', JSON.stringify(data)); fs.renameSync(file + '.tmp', file);
}
async function readRange(provider, config, fromBlock, toBlock, deadline) {
  const boundary = await Chain.anchor(provider, toBlock), windows = [];
  for (let n = fromBlock; n <= toBlock; n += 10000) windows.push([n, Math.min(n + 9999, toBlock)]);
  const logs = (await parallel(windows, 3, ([from, to]) => getLogsChunk(provider, config.staking, topics, from, to, { deadline, delayMs: 0 }))).flat();
  const headers = new Map(await parallel([...new Set(logs.map(log => Number(log.blockNumber)))], 8, async n => [n, await Chain.anchor(provider, n)]));
  const blacklist = new Set(config.blacklist.map(a => a.toLowerCase()));
  const rows = logs.map(log => {
    if (log.blockNumber < fromBlock || log.blockNumber > toBlock) throw new Error('Event outside verified range');
    const header = headers.get(Number(log.blockNumber)); Chain.assertLog(log, header);
    const parsed = iface.parseLog(log), type = parsed && EVENT_TYPE[parsed.name];
    if (!type) throw new Error('Undecodable staking event');
    const address = ethers.getAddress(parsed.args.user), value = parsed.args.amount.toString();
    const withdrawableTime = type === 'unlock' ? Number(parsed.args.withdrawableTime) : 0;
    if (type === 'unlock' && (!Number.isSafeInteger(withdrawableTime) || withdrawableTime <= 0)) throw new Error('Invalid withdrawal time');
    return { id: log.transactionHash + '-' + log.index, hash: log.transactionHash, logIndex: log.index,
      blockNumber: Number(log.blockNumber), blockHash: header.hash, timestamp: header.timestamp,
      address, type, value, valueTig: Number(ethers.formatUnits(value, 18)), blacklisted: blacklist.has(address.toLowerCase()) ? 1 : 0, withdrawableTime };
  }).sort((a, b) => a.blockNumber - b.blockNumber || a.logIndex - b.logIndex);
  if (new Set(rows.map(row => row.id)).size !== rows.length) throw new Error('Duplicate events returned by RPC');
  if (!Chain.sameHash(boundary.hash, (await Chain.anchor(provider, toBlock)).hash)) throw new Error('Chain changed during historical verification');
  return { rows, boundary };
}
function compareHistory(original, rebuilt, target) {
  const old = new Map(original.filter(tx => tx.blockNumber <= target).map(tx => [tx.id, tx]));
  const fresh = new Map(rebuilt.map(tx => [tx.id, tx]));
  const fields = ['blockNumber', 'logIndex', 'timestamp', 'type', 'value', 'withdrawableTime'];
  const added = [], removed = [], corrected = [];
  fresh.forEach((tx, id) => {
    const before = old.get(id);
    if (!before) added.push(id);
    else if (fields.some(field => String(before[field] || 0) !== String(tx[field] || 0)) || String(before.address).toLowerCase() !== tx.address.toLowerCase()) corrected.push(id);
  });
  old.forEach((_, id) => { if (!fresh.has(id)) removed.push(id); });
  return { originalEvents: old.size, verifiedEvents: fresh.size, added: added.length, removed: removed.length, corrected: corrected.length,
    examples: { added: added.slice(0, 20), removed: removed.slice(0, 20), corrected: corrected.slice(0, 20) } };
}
async function verifyHistory(provider, source, options = {}) {
  const file = options.file || '.history/checkpoint.json', resultFile = options.resultFile || '.history/verified-data.json';
  const reportFile = options.reportFile || '.history/report.json', deadline = options.deadline || Infinity;
  const config = source.config, first = config.firstBlock;
  let checkpoint;
  if (fs.existsSync(file)) checkpoint = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (checkpoint) {
    await Chain.prepareSnapshot(checkpoint, { token: config.token, staking: config.staking, firstBlock: first });
    if (!checkpoint.metadata.verificationTarget) throw new Error('Checkpoint has no frozen verification target');
  }
  const target = checkpoint?.metadata.verificationTarget || await Chain.anchor(provider, source.metadata.lastBlock);
  if (!Chain.sameHash(target.hash, (await Chain.anchor(provider, target.number)).hash)) throw new Error('Verification target was reorganized; start a new rebuild');
  let data = checkpoint || { version: 4, engine: 'TokenLocker-getLogs', config, metadata: { lastBlock: first - 1, lastSync: Date.now() }, transactions: [] };
  let plan = await Chain.planReplay(provider, data.metadata, first, target.number);
  while (plan.fromBlock <= target.number) {
    if (Date.now() >= deadline) return { complete: false, throughBlock: data.metadata.lastBlock, target: target.number };
    const end = Math.min(plan.fromBlock + (options.checkpointBlocks || 250000) - 1, target.number);
    const range = await readRange(provider, config, plan.fromBlock, end, deadline);
    await Chain.verifyPrefix(provider, data.metadata, plan.fromBlock);
    const rows = data.transactions.filter(tx => tx.blockNumber < plan.fromBlock).concat(range.rows);
    data = { version: 4, engine: 'TokenLocker-getLogs', config, exported: new Date().toISOString(),
      metadata: { lastBlock: end, lastBlockHash: range.boundary.hash, lastBlockTimestamp: range.boundary.timestamp,
        lastSync: Date.now(), total: rows.length, contentHash: await Chain.digest(rows),
        anchors: Chain.appendAnchor(data.metadata.anchors, range.boundary, plan.fromBlock), verificationTarget: target }, transactions: rows };
    writeJson(file, data);
    console.log(JSON.stringify({ throughBlock: end, target: target.number, percent: ((end - first + 1) / (target.number - first + 1) * 100).toFixed(2), events: rows.length }));
    plan = { fromBlock: end + 1 };
  }
  if (!Chain.sameHash(target.hash, (await Chain.anchor(provider, target.number)).hash)) throw new Error('Verification target changed before completion');
  await Chain.prepareSnapshot(data, { token: config.token, staking: config.staking, firstBlock: first });
  const completedAt = new Date().toISOString();
  const comparison = compareHistory(source.transactions, data.transactions, target.number);
  data.metadata.historyVerification = { fromBlock: first, throughBlock: target.number, throughHash: target.hash, completedAt,
    method: 'Full eth_getLogs rescan and event block headers' };
  delete data.metadata.verificationTarget;
  const report = { ...data.metadata.historyVerification, contentHash: data.metadata.contentHash, comparison };
  writeJson(resultFile, data); writeJson(reportFile, report);
  return { complete: true, ...report };
}
async function run() {
  const deadline = Date.now() + 45 * 60 * 1000, provider = createProvider(undefined, { deadline });
  try {
    const result = await verifyHistory(provider, JSON.parse(fs.readFileSync('data.json', 'utf8')), { deadline });
    console.log(JSON.stringify(result, null, 2));
    if (!result.complete) process.exitCode = 2;
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, result.complete ? 'Full historical rescan completed. See report.json and verified-data.json in the artifact.\n' : 'Verification incomplete; the artifact contains resumable verified progress.\n');
  }
  finally { provider.destroy(); }
}
if (require.main === module) run().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { readRange, verifyHistory, compareHistory };
