const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { requestText, tokenBalances } = require('./holders');
const { getLogsChunk } = require('./sync');
const { csvCandidates } = require('./holders-core');

test('CSV timeout covers the response body after successful headers', async () => {
  let timer;
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.write('HolderAddress,Balance\n');
    timer = setTimeout(() => res.end('late body'), 5000);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    await assert.rejects(requestText('http://127.0.0.1:' + server.address().port, {}, 100), /abort/i);
  } finally {
    clearTimeout(timer);
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});

test('a failed balance batch does not multiply RPC retry loops', async () => {
  let attempts = 0;
  await assert.rejects(tokenBalances(['0x' + '1'.repeat(40)], 100, async () => {
    attempts++;
    throw Error('RPC pool exhausted');
  }), /RPC pool exhausted/);
  assert.equal(attempts, 1);
});

test('a log catch-up deadline stops before starting another range', async () => {
  let attempts = 0;
  await assert.rejects(getLogsChunk({ getLogs: async () => { attempts++; return []; } },
    '0x' + '1'.repeat(40), [], 1, 20000, { deadline: Date.now() - 1 }), /work budget/);
  assert.equal(attempts, 0);
});

test('CSV discovery requires the excluded row needed to verify coverage', () => {
  const a = '0x' + '1'.repeat(40), b = '0x' + '2'.repeat(40);
  assert.throws(() => csvCandidates('HolderAddress,Balance\n' + a + ',2\n' + b + ',1', 2), /Too few.*coverage/);
});
