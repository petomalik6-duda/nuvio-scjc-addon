'use strict';
function withTimeout(promise, ms = 1500) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('PERSISTENT_CACHE_TIMEOUT')), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
module.exports = { withTimeout };
