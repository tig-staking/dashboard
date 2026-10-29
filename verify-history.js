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
  const results = new Array(items.length); let next = 0, failure;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length && !failure) {
      const i = next++;
      try { results[i] = await work(items[i]); } catch (error) { failure = error; }
    }
  }));
  if (failure) throw failure;
  return results;
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.tmp', JSON.stringify(data)); fs.renameSync(file + '.tmp', file);
}
async function readRange(provider, config, fromBlock, toBlock, deadline) {
  const boundary = await Chain.anchor(provider, toBlock), windows = [];
  const window = provider.logWindow || 1000;
  for (let n = fromBlock; n <= toBlock; n += window) windows.push([n, Math.min(n + window - 1, toBlock)]);
  // Fetch headers as log windows arrive, while respecting a separate cap of
  // eight concurrent header reads. Both stages retain their per-host limits.
  const jobs = new Map(), pending = []; let active = 0;
  function pump() {
    while (active < 8 && pending.length) {
      const job = pending.shift(); active++;
      (async () => {
        try { job.resolve([job.number, await retryHeader(provider, job.number, deadline)]); }
        catch (error) { job.reject(error); }
        finally { active--; pump(); }
      })();
    }
  }
  function schedule(number) {
    if (jobs.has(number)) return;
    const result = new Promise((resolve, reject) => pending.push({ number, resolve, reject }));
    result.catch(() => {}); jobs.set(number, result); pump();
  }
  let groups, logError;
  try {
    groups = await parallel(windows, 3, async ([from, to]) => {
      const rows = await getLogsChunk(provider, config.staking, topics, from, to, { deadline, delayMs: 0 });
      rows.forEach(log => schedule(Number(log.blockNumber))); return rows;
    });
  } catch (error) { logError = error; }
  const results = await Promise.allSettled([...jobs.values()]);
  if (logError) throw logError;
  const failed = results.find(result => result.status === 'rejected');
  if (failed) throw failed.reason;
  const logs = groups.flat(), headers = new Map(results.map(result => result.value));
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
async function retryHeader(provider, number, deadline = Infinity) {
  for (let attempt = 0; ; attempt++) {
    try { return await Chain.anchor(provider, number); }
    catch (error) {
      if (attempt >= 5 || Date.now() >= deadline) throw error;
      await new Promise(resolve => setTimeout(resolve, Math.min(8000, 1000 * 2 ** attempt)));
    }
  }
}
function limitedFetch(request = fetch, intervalMs = 400) {
  const slots = new Map();
  return function (url, options) {
    const key = new URL(url).origin;
    if (!slots.has(key)) slots.set(key, { tail: Promise.resolve(), next: 0 });
    const slot = slots.get(key);
    const operation = slot.tail.then(async () => {
      if (slot.next > Date.now()) await new Promise(resolve => setTimeout(resolve, slot.next - Date.now()));
      slot.next = Date.now() + intervalMs;
      const response = await request(url, options);
      if (response.status === 429) slot.next = Date.now() + 5000;
      return response;
    });
    slot.tail = operation.catch(() => {});
    return operation;
  };
}
function createHistoryProvider(deadline, privateUrl = process.env.HISTORY_RPC_URL, factory = createProvider) {
  const request = limitedFetch();
  const logs = factory(privateUrl ? [privateUrl] : ['https://rpc-base.blockmachine.io', 'https://base.gateway.tenderly.co', 'https://8453.rpc.thirdweb.com'], { deadline, fetch: request });
  const headers = (privateUrl ? [privateUrl] : ['https://base.drpc.org', 'https://8453.rpc.thirdweb.com', 'https://base.gateway.tenderly.co'])
    .map(url => ({ provider: factory([url], { deadline, fetch: request }), availableAt: 0 }));
  let next = 0;
  return { logWindow: 10000, getLogs: filter => logs.getLogs(filter), async getBlock(number) {
      let lastError;
      for (let attempt = 0; attempt < headers.length * 3; attempt++) {
        const ready = headers.filter(item => item.availableAt <= Date.now());
        if (!ready.length) {
          if (Date.now() >= deadline) throw lastError || new Error('Archive work budget reached');
          await new Promise(resolve => setTimeout(resolve, Math.min(5000, Math.max(1, Math.min(...headers.map(item => item.availableAt)) - Date.now()))));
          attempt--; continue;
        }
        const selected = ready[next++ % ready.length];
        try { return await selected.provider.getBlock(number); }
        catch (error) {
          lastError = error;
          selected.availableAt = Date.now() + 20000;
          if (Date.now() >= deadline) throw error;
          if ((attempt + 1) % headers.length === 0) await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }
      throw lastError;
    },
    destroy() { logs.destroy(); headers.forEach(item => item.provider.destroy()); } };
}
async function run() {
  const deadline = Date.now() + 45 * 60 * 1000, provider = createHistoryProvider(deadline);
  try {
    const result = await verifyHistory(provider, JSON.parse(fs.readFileSync('data.json', 'utf8')), { deadline });
    console.log(JSON.stringify(result, null, 2));
    if (!result.complete) process.exitCode = 2;
    if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, result.complete ? 'Full historical rescan completed. See report.json and verified-data.json in the artifact.\n' : 'Verification incomplete; the artifact contains resumable verified progress.\n');
  }
  finally { provider.destroy(); }
}
if (require.main === module) run().catch(error => { console.error(String(error.stack || error).split(process.env.HISTORY_RPC_URL || '\u0000').join('<private RPC>')); process.exitCode = 1; });
module.exports = { readRange, verifyHistory, compareHistory, createHistoryProvider, limitedFetch };
