// First positive TIG receipt, not a claim about uninterrupted ownership.
const TOKEN = '0x0c03ce270b4826ec62e7dd007f0b716068639f7b';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let nextRequest = 0;
async function paceRequest() {
  const now = Date.now();
  const delay = Math.max(0, nextRequest - now);
  nextRequest = Math.max(now, nextRequest) + 2100;
  if (delay) await pause(delay);
}

function firstReceipt(rows, address, block, timestamp) {
  for (const row of rows) {
    if (String(row.contractAddress).toLowerCase() !== TOKEN) throw new Error('Wrong token in history');
    if (!/^\d+$/.test(String(row.value))) throw new Error('Invalid transfer value');
    const time = Number(row.timeStamp), height = Number(row.blockNumber);
    if (!Number.isSafeInteger(time) || time <= 0 || time > timestamp || !Number.isSafeInteger(height) || height > block) throw new Error('Invalid transfer position');
    if (String(row.to).toLowerCase() === address && BigInt(row.value) > 0n) return time;
  }
  return null;
}

async function getFirstReceipt(address, block, timestamp, deadline = Infinity) {
  let cursor = {}, earliest = null;
  const seenCursors = new Set();
  // REST history is newest first. Only a fully traversed history establishes a first receipt.
  for (let page = 0; page < 200; page++) {
    if (Date.now() >= deadline) throw new Error('History refresh time budget reached');
    const params = new URLSearchParams({ token: TOKEN, filter: 'to', ...cursor });
    let data;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        if (Date.now() >= deadline) throw new Error('History refresh time budget reached');
        await paceRequest();
        const response = await fetch('https://base.blockscout.com/api/v2/addresses/' + address + '/token-transfers?' + params, { signal: AbortSignal.timeout(20000) });
        if (response.status === 429) {
          await pause(Math.min(60000, Math.max(1000, Number(response.headers.get('x-ratelimit-reset')) || 30000)));
          throw new Error('History rate limited');
        }
        if (!response.ok) throw new Error('History HTTP ' + response.status);
        data = await response.json();
        if (!Array.isArray(data.items) || !Object.hasOwn(data, 'next_page_params')) throw new Error('History unavailable');
        break;
      } catch (error) {
        if (attempt === 2) throw error;
        await pause(1000 * (attempt + 1));
      }
    }
    for (const item of data.items) {
      if (Number(item.block_number) > block) continue;
      const row = { contractAddress: item.token?.address_hash || item.token?.address, to: item.to?.hash,
        value: item.total?.value, blockNumber: item.block_number, timeStamp: Date.parse(item.timestamp) / 1000 };
      const first = firstReceipt([row], address, block, timestamp);
      if (first && (!earliest || first < earliest)) earliest = first;
    }
    if (data.next_page_params === null) return earliest ? {firstReceived: earliest} : null;
    // A receipt over a year ago proves the top tier without claiming an exact first date.
    if (earliest && timestamp - earliest >= 365 * 86400) return {receivedBy: earliest};
    const key = JSON.stringify(data.next_page_params);
    if (seenCursors.has(key)) throw new Error('Repeated history cursor');
    seenCursors.add(key);
    cursor = data.next_page_params;
    await pause(500);
  }
  return null;
}

async function enrichHolderHistory(payload, previous = {}, checkpoint = () => {}, timeBudgetMs = 120000) {
  const deadline = Date.now() + timeBudgetMs;
  const cache = {};
  for (const [address, time] of Object.entries(previous.firstReceived || {})) {
    if (/^0x[0-9a-f]{40}$/.test(address) && Number.isSafeInteger(time) && time > 0 && time <= payload.timestamp) cache[address] = time;
  }
  const bounds = {};
  for (const [address, time] of Object.entries(previous.receivedBy || {})) {
    if (/^0x[0-9a-f]{40}$/.test(address) && Number.isSafeInteger(time) && time > 0 && payload.timestamp - time >= 365 * 86400) bounds[address] = time;
  }
  const pending = payload.candidates.slice(0, 500).map(row => row.address.toLowerCase())
    .filter(a => !cache[a] && !bounds[a] && a !== '0x4cb16d4153123a74bc724d161050959754f378d8');
  payload.firstReceived = cache;
  payload.receivedBy = bounds;
  let completed = 0, failed = 0;
  async function worker() {
    while (pending.length && Date.now() < deadline) {
      const address = pending.shift();
      try {
        const first = await getFirstReceipt(address, payload.block, payload.timestamp, deadline);
        if (first?.firstReceived) cache[address] = first.firstReceived;
        else if (first?.receivedBy) bounds[address] = first.receivedBy;
        else failed++;
      } catch (error) { failed++; console.warn('History unavailable:', address, error.message); }
      completed++;
      if (completed % 10 === 0) { checkpoint(); console.log('Holder histories checked:', completed, 'verified:', Object.keys(cache).length + Object.keys(bounds).length); }
      await pause(600);
    }
  }
  await Promise.all(Array.from({length: 6}, worker));
  payload.firstReceived = cache;
  payload.holderAgeMethod = 'First positive TIG receipt on Base; a receipt at least 365 days old suffices for Diamond. Not continuous holding duration.';
  console.log('Holder history cache:', Object.keys(cache).length + Object.keys(bounds).length, 'unavailable:', failed);
  return payload;
}

module.exports = { firstReceipt, getFirstReceipt, enrichHolderHistory };
if (require.main === module) {
  const fs = require('node:fs');
  const payload = JSON.parse(fs.readFileSync('holders.json', 'utf8'));
  function save() {
    fs.writeFileSync('holders.json.tmp', JSON.stringify(payload));
    fs.renameSync('holders.json.tmp', 'holders.json');
  }
  enrichHolderHistory(payload, payload, save, Infinity).then(save).catch(error => { console.error(error); process.exitCode = 1; });
}
