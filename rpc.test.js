const test = require('node:test');
const assert = require('node:assert/strict');
const { createProvider } = require('./rpc');

test('RPC rotates on log errors even when the first endpoint serves block numbers', async () => {
  const calls = [];
  const provider = createProvider(['https://limited.test', 'https://working.test'], {
    fetch: async (url, options) => {
      const payload = JSON.parse(options.body);
      calls.push([url, payload.method]);
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: payload.id,
        ...(url.includes('limited') && payload.method === 'eth_getLogs'
          ? { error: { code: -32011, message: 'request limit reached' } }
          : { result: payload.method === 'eth_blockNumber' ? '0x64' : [] }) }));
    }
  });
  try {
    assert.equal(await provider.getBlockNumber(), 100);
    assert.deepEqual(await provider.getLogs({ fromBlock: 1, toBlock: 50 }), []);
    assert.equal(await provider.getBlockNumber(), 100);
    assert.deepEqual(calls.map(call => call[0]), [
      'https://limited.test', 'https://limited.test', 'https://working.test', 'https://working.test'
    ]);
  } finally { provider.destroy(); }
});

test('RPC fails over after HTTP throttling, a timeout, or malformed data', async () => {
  let attempts = 0;
  const provider = createProvider(['https://throttled.test', 'https://timeout.test', 'https://malformed.test', 'https://ok.test'], {
    timeoutMs: 20,
    fetch: async (url, options) => {
      attempts++;
      if (url.includes('throttled')) return new Response('', { status: 429 });
      if (url.includes('timeout')) return new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason));
        // Keep the test event loop alive until AbortSignal.timeout fires.
        setTimeout(resolve, 40);
      });
      const payload = JSON.parse(options.body);
      return new Response(JSON.stringify(url.includes('malformed') ? {} : { id: payload.id, result: '0x65' }));
    }
  });
  try { assert.equal(await provider.getBlockNumber(), 101); assert.equal(attempts, 4); }
  finally { provider.destroy(); }
});

test('RPC reports an exhausted pool instead of returning an empty log range', async () => {
  const provider = createProvider(['https://failed.test'], {
    fetch: async () => new Response('', { status: 503 })
  });
  try { await assert.rejects(provider.getLogs({ fromBlock: 1, toBlock: 2 }), /eth_getLogs failed on all RPCs.*503/); }
  finally { provider.destroy(); }
});
