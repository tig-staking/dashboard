const fs = require('fs');
const { ethers } = require('ethers');

const CONFIG = {
  STAKE: '0x9F6b29E498Ef6BEe4a050fa1F29c31DBE6c6aEF4',
  FIRST_BLOCK: 26498642,
  RPC: 'https://mainnet.base.org',
  FILE_PATH: './data.json',
  PENDING_PERIOD_SEC: 2419200
};

const LOCKER_ABI = [
  'event TokensLocked(address indexed user, uint256 amount, uint256 locked)',
  'event TokensUnlocked(address indexed user, uint256 amount, uint256 locked, uint256 withdrawableTime)',
  'event TokensWithdrawn(address indexed user, uint256 amount)',
  'event TokensRelocked(address indexed user, uint256 amount, uint256 locked)',
  'event TokensClaimed(address indexed user, uint256 amount, uint256 locked)',
  'event TokensRewarded(address indexed user, uint256 amount, uint256 totalClaimable)'
];

const EVENT_TYPE = {
  TokensLocked: 'lock',
  TokensUnlocked: 'unlock',
  TokensWithdrawn: 'withdraw',
  TokensRelocked: 'relock',
  TokensClaimed: 'claim',
  TokensRewarded: 'reward'
};

function valueToTig(val) {
  try {
    return Number(ethers.formatUnits(val, 18));
  } catch (e) {
    return 0;
  }
}

async function run() {
  if (!fs.existsSync(CONFIG.FILE_PATH)) {
    console.error('Brak pliku data.json!');
    return;
  }

  const existingData = JSON.parse(fs.readFileSync(CONFIG.FILE_PATH, 'utf8'));
  const provider = new ethers.JsonRpcProvider(CONFIG.RPC);
  const iface = new ethers.Interface(LOCKER_ABI);

  const currentBlock = await provider.getBlockNumber();
  const lastBlock = existingData.metadata?.lastBlock || CONFIG.FIRST_BLOCK;
  const fromBlock = lastBlock + 1;

  if (fromBlock > currentBlock) {
    console.log('Baza jest już w 100% aktualna.');
    return;
  }

  console.log(`Pobieranie bloków od ${fromBlock} do ${currentBlock}...`);

  const topics = [
    Object.keys(EVENT_TYPE).map(name => iface.getEvent(name).topicHash)
  ];

  // Pobieramy zdarzenia w paczkach po max 10 000 bloków
  const newTxs = [];
  const chunkSize = 5000;

  for (let s = fromBlock; s <= currentBlock; s += chunkSize) {
    const e = Math.min(s + chunkSize - 1, currentBlock);
    const logs = await provider.getLogs({
      address: CONFIG.STAKE,
      fromBlock: s,
      toBlock: e,
      topics: topics
    });

    for (const log of logs) {
      try {
        const parsed = iface.parseLog({ topics: log.topics, data: log.data });
        if (!parsed) continue;
        const type = EVENT_TYPE[parsed.name];
        if (!type) continue;

        const args = parsed.args;
        const user = args.user || args[0];
        const amt = args.amount || args[1];
        const ts = Math.floor(Date.now() / 1000);

        let withdrawableTime = 0;
        if (type === 'unlock') {
          withdrawableTime = Number(args.withdrawableTime || args[3] || (ts + CONFIG.PENDING_PERIOD_SEC));
        }

        newTxs.push({
          id: `${log.transactionHash}-${log.index}`,
          hash: log.transactionHash,
          logIndex: log.index,
          blockNumber: Number(log.blockNumber),
          address: user,
          type: type,
          value: amt.toString(),
          valueTig: valueToTig(amt),
          timestamp: ts,
          blacklisted: CONFIG.BLACKLIST?.includes(user) ? 1 : 0,
          withdrawableTime: withdrawableTime
        });
      } catch (err) {}
    }
  }

  const allTxs = [...(existingData.transactions || []), ...newTxs];

  const payload = {
    version: 4,
    engine: 'TokenLocker-getLogs',
    exported: new Date().toISOString(),
    config: existingData.config || {
      token: "0x0C03Ce270B4826Ec62e7DD007f0B716068639F7B",
      staking: "0x9F6b29E498Ef6BEe4a050fa1F29c31DBE6c6aEF4",
      firstBlock: CONFIG.FIRST_BLOCK,
      blacklist: ["0x30FeC1f3690F3207d1A239dB392f62C9CD1deF3F"],
      pendingPeriodSec: CONFIG.PENDING_PERIOD_SEC
    },
    metadata: {
      lastBlock: currentBlock,
      lastSync: Date.now(),
      total: allTxs.length
    },
    transactions: allTxs
  };

  fs.writeFileSync(CONFIG.FILE_PATH, JSON.stringify(payload));
  console.log(`Dopisano ${newTxs.length} nowych transakcji. Łącznie w bazie: ${allTxs.length} transakcji.`);
}

run().catch(console.error);
