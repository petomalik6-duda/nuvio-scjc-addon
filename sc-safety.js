'use strict';

const realFetch = global.fetch;
const SC_HOST = 'stream-cinema.online';
const BLOCK_MS = Math.max(60_000, Number(process.env.SC_BREAKER_MS || 30 * 60 * 1000));
const OK_TTL_MS = Math.max(60_000, Number(process.env.SC_TOKEN_OK_TTL_MS || 5 * 60 * 1000));

let blockedUntil = 0;
let validatedUntil = 0;
let validationPromise = null;

function synthetic(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' }
  });
}

if (realFetch) {
  global.fetch = async function safeFetch(input, init) {
    let url;
    try {
      url = new URL(typeof input === 'string' ? input : input?.url || String(input));
    } catch {
      return realFetch(input, init);
    }

    if (url.hostname !== SC_HOST) return realFetch(input, init);

    // Never mint/refresh SC tokens automatically. A validated backup token or
    // a manually supplied 32-character token must be used instead.
    if (url.pathname === '/kodi/auth/token') {
      console.warn('[SC_SAFETY] blocked automatic auth/token request');
      return synthetic(403, 'Automatic Stream Cinema token creation is disabled');
    }

    const now = Date.now();
    if (blockedUntil > now) {
      return synthetic(503, 'Stream Cinema circuit breaker is open after token rejection');
    }

    if (validatedUntil > now) return realFetch(input, init);

    if (validationPromise) {
      const ok = await validationPromise;
      if (!ok) return synthetic(503, 'Stream Cinema circuit breaker is open after token rejection');
      return realFetch(input, init);
    }

    let resolveValidation;
    validationPromise = new Promise((resolve) => { resolveValidation = resolve; });
    try {
      const res = await realFetch(input, init);
      if (res.ok) {
        validatedUntil = Date.now() + OK_TTL_MS;
        blockedUntil = 0;
        resolveValidation(true);
      } else if ([401, 403, 404, 429].includes(res.status)) {
        validatedUntil = 0;
        blockedUntil = Date.now() + BLOCK_MS;
        console.warn('[SC_SAFETY] circuit opened', JSON.stringify({ status: res.status, blockMs: BLOCK_MS }));
        resolveValidation(false);
      } else {
        resolveValidation(true);
      }
      return res;
    } catch (err) {
      resolveValidation(true);
      throw err;
    } finally {
      validationPromise = null;
    }
  };
}
