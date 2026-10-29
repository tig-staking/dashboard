(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('ethers').ethers);
  else root.TigRpc = factory(root.ethers);
}(typeof globalThis !== 'undefined' ? globalThis : this, function (ethers) {
  'use strict';
  var URLS = ['https://base-rpc.publicnode.com', 'https://base.drpc.org', 'https://1rpc.io/base'];

  // A responsive RPC may still reject historical logs. Bound each real request,
  // including HTTP throttling, and rotate without discarding completed ranges.
  function createProvider(urls, options) {
    urls = urls || URLS;
    options = options || {};
    var request = options.fetch || fetch;
    var active = 0;
    class BaseProvider extends ethers.JsonRpcProvider {
      constructor() { super(urls[0], 8453, { staticNetwork: true, batchMaxCount: 1, cacheTimeout: -1 }); }
      async _send(payload) {
        var failures = [], start = active;
        for (var attempt = 0; attempt < urls.length; attempt++) {
          var index = (start + attempt) % urls.length;
          try {
            var response = await request(urls[index], {
              method: 'POST', headers: { 'content-type': 'application/json' },
              body: JSON.stringify(payload), signal: AbortSignal.timeout(options.timeoutMs || 10000)
            });
            if (!response.ok) throw new Error('HTTP ' + response.status);
            var data = await response.json();
            if (!data || data.id !== payload.id || data.error || !Object.hasOwn(data, 'result')) {
              throw new Error(JSON.stringify(data && data.error || data));
            }
            active = index;
            return [data];
          } catch (error) { failures.push(urls[index] + ': ' + error.message); }
        }
        throw new Error(payload.method + ' failed on all RPCs: ' + failures.join('; '));
      }
    }
    return new BaseProvider();
  }
  return { URLS: URLS, createProvider: createProvider };
}));
