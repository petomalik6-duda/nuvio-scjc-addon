const { test } = require('node:test');
const assert = require('node:assert/strict');
const { withTimeout } = require('../lib/with-timeout');
test('timeout timer is cancelled on early success and failure', async () => {
  const original = global.clearTimeout;
  let cleared = 0;
  global.clearTimeout = timer => { cleared++; return original(timer); };
  try {
    assert.equal(await withTimeout(Promise.resolve(42)), 42);
    await assert.rejects(withTimeout(Promise.reject(new Error('network'))), /network/);
    assert.equal(cleared, 2);
  } finally { global.clearTimeout = original; }
});
test('a slow operation times out', async () => {
  const keepAlive = setTimeout(() => {}, 1000);
  try { await assert.rejects(withTimeout(new Promise(() => {}), 5), /PERSISTENT_CACHE_TIMEOUT/); }
  finally { clearTimeout(keepAlive); }
});
