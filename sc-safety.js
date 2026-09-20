'use strict';

const realFetch = global.fetch;
const CDER_MANIFEST_URL = String(process.env.CDER_MANIFEST_URL || '').trim();

if (realFetch && CDER_MANIFEST_URL) {
  const timer = setTimeout(async () => {
    try {
      const response = await realFetch(CDER_MANIFEST_URL, {
        headers: { 'accept': 'application/json', 'user-agent': 'SCJC-cder-probe/1.0' }
      });
      const raw = await response.text();
      let manifest = null;
      try { manifest = raw ? JSON.parse(raw) : null; } catch {}
      const safe = {
        status: response.status,
        ok: response.ok,
        id: manifest?.id || null,
        version: manifest?.version || null,
        name: manifest?.name || null,
        resources: Array.isArray(manifest?.resources) ? manifest.resources.map((r) => typeof r === 'string' ? r : r?.name).filter(Boolean) : [],
        catalogs: Array.isArray(manifest?.catalogs) ? manifest.catalogs.map((c) => ({
          id: c?.id || null,
          type: c?.type || null,
          name: c?.name || null,
          extra: Array.isArray(c?.extra) ? c.extra.map((e) => e?.name).filter(Boolean) : []
        })) : [],
        idPrefixes: Array.isArray(manifest?.idPrefixes) ? manifest.idPrefixes : []
      };
      console.log('[CDER_PROBE]', JSON.stringify(safe));
    } catch (err) {
      console.warn('[CDER_PROBE] failed', JSON.stringify({ message: err?.message || String(err) }));
    }
  }, 1200);
  timer.unref?.();
}
const SC_HOST = 'stream-cinema.online';
const KRA_HOST = 'api.kra.sk';
const BLOCK_MS = Math.max(60_000, Number(process.env.SC_BREAKER_MS || 30 * 60 * 1000));
const OK_TTL_MS = Math.max(60_000, Number(process.env.SC_TOKEN_OK_TTL_MS || 5 * 60 * 1000));

const guards = new Map();

function guardFor(key) {
  const k = String(key || 'default').toLowerCase();
  let g = guards.get(k);
  if (!g) {
    g = { blockedUntil: 0, validatedUntil: 0, validationPromise: null };
    guards.set(k, g);
  }
  return g;
}

function synthetic(status, message) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' }
  });
}

function safePath(raw) {
  return String(raw || '').replace(/\/(?:eyJ|[A-Za-z0-9_-]{80,})[^/]*(?=\/|$)/g, '/[config]');
}

function requestUuid(input, init) {
  try {
    const h = new Headers(init?.headers || (typeof input === 'object' ? input?.headers : undefined) || {});
    return String(h.get('x-uuid') || h.get('X-Uuid') || 'default').trim().toLowerCase();
  } catch {
    return 'default';
  }
}

function retryAfterMs(res) {
  try {
    const raw = res?.headers?.get?.('retry-after');
    if (!raw) return BLOCK_MS;
    const sec = Number(raw);
    if (Number.isFinite(sec) && sec >= 0) return Math.max(60_000, sec * 1000);
    const at = Date.parse(raw);
    return Number.isFinite(at) ? Math.max(60_000, at - Date.now()) : BLOCK_MS;
  } catch {
    return BLOCK_MS;
  }
}

function normalizedBodyFor(url) {
  const p = String(url || '');
  if (/\/catalog\//.test(p)) return JSON.stringify({ metas: [] });
  if (/\/stream\//.test(p)) return JSON.stringify({ streams: [] });
  if (/\/meta\//.test(p)) return JSON.stringify({ meta: null });
  return null;
}

// Never expose transient upstream protection as an HTTP error to Nuvio.
// Catalog/meta/stream endpoints degrade to an empty 200 response instead.
try {
  const http = require('node:http');
  const originalCreateServer = http.createServer;
  http.createServer = function(...args) {
    const idx = args.findIndex((v) => typeof v === 'function');
    if (idx >= 0) {
      const listener = args[idx];
      args[idx] = function(req, res) {
        const originalWriteHead = res.writeHead;
        const originalWrite = res.write;
        const originalEnd = res.end;
        let replacement = null;

        res.writeHead = function(statusCode, ...rest) {
          const status = Number(statusCode);
          const body = status >= 400 ? normalizedBodyFor(req?.url) : null;
          if (body != null) {
            replacement = Buffer.from(body);
            console.warn('[CLIENT_GUARD] normalized upstream error', JSON.stringify({ status, url: safePath(req?.url) }));
            return originalWriteHead.call(this, 200, {
              'content-type': 'application/json; charset=utf-8',
              'content-length': replacement.length,
              'access-control-allow-origin': '*',
              'cache-control': 'no-store'
            });
          }
          if (status >= 500) {
            console.error('[HTTP_5XX]', JSON.stringify({ status, url: safePath(req?.url) }));
          }
          return originalWriteHead.call(this, statusCode, ...rest);
        };

        res.write = function(chunk, ...rest) {
          if (replacement) return true;
          return originalWrite.call(this, chunk, ...rest);
        };

        res.end = function(chunk, ...rest) {
          if (replacement) {
            const body = replacement;
            replacement = null;
            return originalEnd.call(this, body);
          }
          return originalEnd.call(this, chunk, ...rest);
        };

        return listener(req, res);
      };
    }
    return originalCreateServer.apply(this, args);
  };
} catch {}

if (realFetch) {
  global.fetch = async function safeFetch(input, init) {
    let url;
    try {
      url = new URL(typeof input === 'string' ? input : input?.url || String(input));
    } catch {
      return realFetch(input, init);
    }

    const uuid = requestUuid(input, init);
    const guard = guardFor(uuid);
    const now = Date.now();

    // Once SC rejects this UUID/token, stop KRA login/list/download traffic too.
    // This prevents Nuvio's parallel catalog loading from causing a login burst.
    if (url.hostname === KRA_HOST) {
      if (guard.blockedUntil > now) {
        return synthetic(503, 'KRA calls paused while Stream Cinema protection is active');
      }
      const res = await realFetch(input, init);
      if (res.status === 429) {
        const wait = retryAfterMs(res);
        guard.blockedUntil = Date.now() + wait;
        guard.validatedUntil = 0;
        console.warn('[KRA_SAFETY] rate limit detected', JSON.stringify({ blockMs: wait }));
      }
      return res;
    }

    if (url.hostname !== SC_HOST) return realFetch(input, init);

    // Never mint/refresh SC tokens automatically. A validated backup token or
    // manually supplied 32-character token must be used instead.
    if (url.pathname === '/kodi/auth/token') {
      guard.blockedUntil = Math.max(guard.blockedUntil, Date.now() + BLOCK_MS);
      guard.validatedUntil = 0;
      console.warn('[SC_SAFETY] blocked automatic auth/token request', JSON.stringify({ blockMs: BLOCK_MS }));
      return synthetic(404, 'Automatic Stream Cinema token creation is disabled');
    }

    if (guard.blockedUntil > now) {
      return synthetic(404, 'Stream Cinema circuit breaker is open after token rejection');
    }

    if (guard.validatedUntil > now) return realFetch(input, init);

    if (guard.validationPromise) {
      const ok = await guard.validationPromise;
      if (!ok) return synthetic(404, 'Stream Cinema circuit breaker is open after token rejection');
      return realFetch(input, init);
    }

    let resolveValidation;
    guard.validationPromise = new Promise((resolve) => { resolveValidation = resolve; });
    try {
      const res = await realFetch(input, init);
      if (res.ok) {
        guard.validatedUntil = Date.now() + OK_TTL_MS;
        guard.blockedUntil = 0;
        resolveValidation(true);
      } else if ([401, 403, 404, 429].includes(res.status)) {
        guard.validatedUntil = 0;
        const wait = res.status === 429 ? retryAfterMs(res) : BLOCK_MS;
        guard.blockedUntil = Date.now() + wait;
        console.warn('[SC_SAFETY] circuit opened', JSON.stringify({ status: res.status, blockMs: wait }));
        resolveValidation(false);
      } else {
        resolveValidation(true);
      }
      return res;
    } catch (err) {
      resolveValidation(true);
      throw err;
    } finally {
      guard.validationPromise = null;
    }
  };
}
