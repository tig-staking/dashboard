const fs = require('fs');
const { ethers } = require('ethers');

const CONFIG = {
  STAKE: '0x9f6b29e498ef6bee4a050fa1f29c31dbe6c6aef4',
  FIRST_BLOCK: 26498642,
  RPC: 'https://mainnet.base.org',
  FILE_PATH: './data.json'
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

async function run() {
  const provider = new ethers.JsonRpcProvider(CONFIG.RPC);
  const iface = new ethers.Interface(LOCKER_ABI);

  let existingData = { metadata: { lastBlock: CONFIG.FIRST_BLOCK - 1 }, transactions: [] };
  if (fs.existsSync(CONFIG.FILE_PATH)) {
    try {
      existingData = JSON.parse(fs.readFileSync(CONFIG.FILE_PATH, 'utf8'));
    } catch (e) {
      console.log('Tworzenie nowej bazy...');
    }
  }

  const currentBlock = await provider.getBlockNumber();
  const fromBlock = (existingData.metadata.lastBlock || CONFIG.FIRST_BLOCK) + 1;

  if (fromBlock > currentBlock) {
    console.log('Baza jest już aktualna.');
    return;
  }

  console.log(`Pobieranie bloków od ${fromBlock} do ${currentBlock}...`);

  const topics = Object.keys(EVENT_TYPE).map(name => iface.getEvent(name).topicHash);
  const logs = await provider.getLogs({
    address: CONFIG.STAKE,
    fromBlock: fromBlock,
    toBlock: currentBlock,
    topics: [topics]
  });

  const newTxs = logs.map(log => {
    const parsed = iface.parseLog({ topics: log.topics, data: log.data });
    const type = EVENT_TYPE[parsed.name];
    const args = parsed.args;
    return {
      id: `${log.transactionHash}-${log.index}`,
      hash: log.transactionHash,
      logIndex: log.index,
      blockNumber: Number(log.blockNumber),
      address: args.user || args[0],
      type: type,
      value: args.amount.toString(),
      valueTig: Number(ethers.formatUnits(args.amount, 18)),
      timestamp: Math.floor(Date.now() / 1000) // przybliżony czas serwera
    };
  });

  const allTxs = [...(existingData.transactions || []), ...newTxs];

  const payload = {
    version: 4,
    metadata: {
      lastBlock: currentBlock,
      lastSync: Date.now(),
      total: allTxs.length
    },
    transactions: allTxs
  };

  fs.writeFileSync(CONFIG.FILE_PATH, JSON.stringify(payload, null, 2));
  console.log(`Zapisano ${newTxs.length} nowych zdarzeń. Łącznie: ${allTxs.length}`);
}

run().catch(console.error);
