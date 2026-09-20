'use strict';

const http = require('node:http');
const { URL } = require('node:url');

const VERSION = '2.0.0';
const PORT = Number(process.env.PORT || 10000);
const CDER_MANIFEST_URL = String(process.env.CDER_MANIFEST_URL || '').trim();
const PAGE_SIZE = 50;
const UPSTREAM_SCAN_SIZE = 100;
const MAX_SCAN_PAGES = 8;
const MAX_CONCURRENCY = Math.max(1, Number(process.env.CDER_MAX_CONCURRENCY || 3));
const DEFAULT_BACKOFF_MS = Math.max(60_000, Number(process.env.CDER_BACKOFF_MS || 5 * 60 * 1000));

const VERIFIED_CATALOGS = [
  { id:'sc-movie-latest', type:'movie', name:' ⏳SC: Najnovšie filmy', extra:['skip'] },
  { id:'sc-movie-popular', type:'movie', name:' ⏳SC: Populárne filmy', extra:['search','skip'] },
  { id:'sc-series-latest', type:'series', name:' ⏳SC: Najnovšie seriály', extra:['skip'] },
  { id:'sc-series-popular', type:'series', name:' ⏳SC: Populárne seriály', extra:['search','skip'] },
  { id:'sc-movie-trending', type:'movie', name:' 🔥 SC: Populárne teraz (filmy)', extra:['genre','skip'] },
  { id:'sc-movie-watching', type:'movie', name:' 👁 SC: Práve sa pozerajú (filmy)', extra:['genre','skip'] },
  { id:'sc-series-trending', type:'series', name:' 🔥 SC: Populárne teraz (seriály)', extra:['genre','skip'] },
  { id:'sc-series-watching', type:'series', name:' 👁 SC: Práve sa pozerajú (seriály)', extra:['genre','skip'] },
  { id:'sc-movie-filter', type:'movie', name:'🔧 SC: Filter filmov', extra:['genre','year','letter','skip'] },
  { id:'sc-series-filter', type:'series', name:'🔧 SC: Filter seriálov', extra:['genre','year','letter','skip'] }
];

const CUSTOM_CATALOGS = [
  { id:'scx-movie-dubbed-latest', type:'movie', name:'🇨🇿🇸🇰 SC+: Novinky dabované filmy', source:'sc-movie-latest', languages:['CZ','SK'] },
  { id:'scx-series-dubbed-latest', type:'series', name:'🇨🇿🇸🇰 SC+: Novinky dabované seriály', source:'sc-series-latest', languages:['CZ','SK'] },
  { id:'scx-movie-cz', type:'movie', name:'🇨🇿 SC+: Filmy s CZ', source:'sc-movie-filter', languages:['CZ'] },
  { id:'scx-movie-sk', type:'movie', name:'🇸🇰 SC+: Filmy so SK', source:'sc-movie-filter', languages:['SK'] },
  { id:'scx-series-cz', type:'series', name:'🇨🇿 SC+: Seriály s CZ', source:'sc-series-filter', languages:['CZ'] },
  { id:'scx-series-sk', type:'series', name:'🇸🇰 SC+: Seriály so SK', source:'sc-series-filter', languages:['SK'] }
];

const verifiedMap = new Map(VERIFIED_CATALOGS.map((c) => [c.id, c]));
const customMap = new Map(CUSTOM_CATALOGS.map((c) => [c.id, c]));
const cache = new Map();
const inflight = new Map();
let upstreamBackoffUntil = 0;
let active = 0;
const waiters = [];

function upstreamBase() {
  if (!CDER_MANIFEST_URL) throw new Error('CDER_MANIFEST_URL is not configured');
  const u = new URL(CDER_MANIFEST_URL);
  u.pathname = u.pathname.replace(/\/manifest\.json$/i, '/');
  u.search = '';
  u.hash = '';
  return u;
}

function json(res, status, body, extraHeaders) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, Object.assign({
    'content-type':'application/json; charset=utf-8',
    'content-length':data.length,
    'access-control-allow-origin':'*',
    'cache-control':'no-store'
  }, extraHeaders || {}));
  res.end(data);
}

function html(res, status, body) {
  const data = Buffer.from(body);
  res.writeHead(status, {
    'content-type':'text/html; charset=utf-8',
    'content-length':data.length,
    'cache-control':'no-store'
  });
  res.end(data);
}

function manifest() {
  const catalogs = VERIFIED_CATALOGS.map((c) => ({
    id:c.id,
    type:c.type,
    name:c.name,
    extra:c.extra.map((name) => ({ name, isRequired:false }))
  })).concat(CUSTOM_CATALOGS.map((c) => ({
    id:c.id,
    type:c.type,
    name:c.name,
    extra:[{ name:'skip', isRequired:false }]
  })));

  return {
    id:'community.scjc.cder.bridge',
    version:VERSION,
    name:'SCJC + cder',
    description:'Safe Nuvio/Stremio bridge over a working cder Stream Cinema addon. No direct KRA/SC login or token refresh.',
    resources:[
      { name:'catalog', types:['movie','series'], idPrefixes:['tt','sc'] },
      { name:'meta', types:['movie','series'], idPrefixes:['tt','sc'] },
      { name:'stream', types:['movie','series'], idPrefixes:['tt','sc'] }
    ],
    types:['movie','series'],
    catalogs,
    idPrefixes:['tt','sc'],
    behaviorHints:{ configurable:false, configurationRequired:false }
  };
}

function safeRoute(pathname) {
  const parts = String(pathname || '/').split('/').filter(Boolean);
  const roots = new Set(['manifest.json','catalog','meta','stream','health','configure']);
  if (parts.length >= 2 && !roots.has(parts[0]) && roots.has(parts[1])) parts.shift();
  return '/' + parts.join('/');
}

function parseExtraSegment(segment, searchParams) {
  const out = new URLSearchParams();
  if (segment) {
    let raw = decodeURIComponent(String(segment).replace(/\.json$/i, ''));
    for (const pair of raw.split('&')) {
      const i = pair.indexOf('=');
      if (i >= 0) out.set(pair.slice(0, i), pair.slice(i + 1));
    }
  }
  for (const [k,v] of searchParams.entries()) out.set(k,v);
  return out;
}

function fold(v) {
  return String(v || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
}

function languageFlags(meta) {
  const tail = fold(meta && meta.name).slice(-100);
  return {
    CZ:/\bCZ\b/.test(tail),
    SK:/\bSK\b/.test(tail)
  };
}

function matchesLanguages(meta, languages) {
  const flags = languageFlags(meta);
  return languages.some((lang) => flags[lang]);
}

function retryAfterMs(headers) {
  const raw = headers && headers.get ? headers.get('retry-after') : null;
  if (!raw) return DEFAULT_BACKOFF_MS;
  const sec = Number(raw);
  if (Number.isFinite(sec) && sec >= 0) return Math.max(60_000, sec * 1000);
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(60_000, at - Date.now()) : DEFAULT_BACKOFF_MS;
}

function ttlFor(path) {
  if (/\/stream\//.test(path)) return 20_000;
  if (/\/meta\//.test(path)) return 10 * 60 * 1000;
  if (/\/catalog\//.test(path)) return 2 * 60 * 1000;
  return 5 * 60 * 1000;
}

async function acquire() {
  if (active < MAX_CONCURRENCY) {
    active += 1;
    return;
  }
  await new Promise((resolve) => waiters.push(resolve));
  active += 1;
}

function release() {
  active = Math.max(0, active - 1);
  const next = waiters.shift();
  if (next) next();
}

async function upstreamJson(path, options) {
  const key = path;
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) return hit.value;

  if (upstreamBackoffUntil > now) {
    if (hit) return hit.value;
    const err = new Error('CDER_BACKOFF');
    err.code = 'CDER_BACKOFF';
    throw err;
  }

  if (inflight.has(key)) return inflight.get(key);

  const work = (async () => {
    await acquire();
    try {
      const url = new URL(path.replace(/^\//,''), upstreamBase());
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Number((options && options.timeoutMs) || 12000));
      try {
        const response = await fetch(url, {
          headers:{ 'accept':'application/json', 'user-agent':'SCJC-cder-bridge/' + VERSION },
          signal:controller.signal
        });
        const text = await response.text();
        let body = null;
        try { body = text ? JSON.parse(text) : null; } catch {}

        if (response.status === 429) {
          upstreamBackoffUntil = Date.now() + retryAfterMs(response.headers);
          if (hit) return hit.value;
          const err = new Error('CDER_RATE_LIMIT');
          err.code = 'CDER_RATE_LIMIT';
          throw err;
        }

        if (!response.ok || body == null) {
          if (hit) return hit.value;
          const err = new Error('CDER_HTTP_' + response.status);
          err.status = response.status;
          throw err;
        }

        cache.set(key, { value:body, expiresAt:Date.now() + ttlFor(path) });
        return body;
      } finally {
        clearTimeout(timer);
      }
    } finally {
      release();
    }
  })();

  inflight.set(key, work);
  try {
    return await work;
  } finally {
    inflight.delete(key);
  }
}

function upstreamCatalogPath(type, id, skip) {
  if (!skip) return '/catalog/' + type + '/' + id + '.json';
  return '/catalog/' + type + '/' + id + '/skip=' + Number(skip) + '.json';
}

async function customCatalog(custom, extra) {
  const requestedSkip = Math.max(0, Number(extra.get('skip') || 0));
  const need = requestedSkip + PAGE_SIZE;
  const matched = [];

  for (let page = 0; page < MAX_SCAN_PAGES && matched.length < need; page += 1) {
    const upstreamSkip = page * UPSTREAM_SCAN_SIZE;
    let body;
    try {
      body = await upstreamJson(upstreamCatalogPath(custom.type, custom.source, upstreamSkip));
    } catch {
      break;
    }
    const metas = Array.isArray(body && body.metas) ? body.metas : [];
    if (!metas.length) break;

    for (const meta of metas) {
      if (matchesLanguages(meta, custom.languages)) matched.push(meta);
    }

    if (metas.length < UPSTREAM_SCAN_SIZE) break;
  }

  return { metas:matched.slice(requestedSkip, requestedSkip + PAGE_SIZE) };
}

function emptyFor(route) {
  if (route.startsWith('/catalog/')) return { metas:[] };
  if (route.startsWith('/stream/')) return { streams:[] };
  if (route.startsWith('/meta/')) return { meta:null };
  return { ok:false, error:'upstream unavailable' };
}

function configurePage(req) {
  const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0];
  const host = req.headers.host || 'nuvio-scjc-addon.onrender.com';
  const manifestUrl = proto + '://' + host + '/manifest.json';
  return [
    '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>SCJC + cder</title><style>body{font-family:system-ui;max-width:760px;margin:40px auto;padding:0 18px;background:#111;color:#eee}code{word-break:break-all;background:#222;padding:4px 7px;border-radius:6px}.ok{padding:14px;background:#16391f;border-radius:10px}a{color:#8ab4ff}</style></head><body>',
    '<h1>SCJC + cder</h1>',
    '<p>Tento variant nepoužíva vlastný KRA login ani Stream Cinema auth/token. Všetky catalog/meta/stream požiadavky idú cez nakonfigurovaný cder addon.</p>',
    '<div class="ok"><b>Manifest URL:</b><br><code>' + manifestUrl + '</code></div>',
    '<p>Pridané sú aj CZ/SK katalógy filtrované z cder výsledkov. Pri 429 sa requesty neopakujú; používa sa cache/backoff.</p>',
    '<p><a href="/health">Health</a></p></body></html>'
  ].join('');
}

async function handle(req, res) {
  try {
    const u = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin':'*',
        'access-control-allow-headers':'*',
        'access-control-allow-methods':'GET,OPTIONS'
      });
      return res.end();
    }

    const route = safeRoute(u.pathname);

    if (route === '/' || route === '/configure') return html(res, 200, configurePage(req));

    if (route === '/health') {
      return json(res, 200, {
        ok:true,
        version:VERSION,
        mode:'cder-proxy',
        upstreamConfigured:!!CDER_MANIFEST_URL,
        directKraLogin:false,
        directScAuth:false,
        cacheEntries:cache.size,
        upstreamBackoffSeconds:Math.max(0, Math.ceil((upstreamBackoffUntil - Date.now()) / 1000)),
        at:new Date().toISOString()
      });
    }

    if (route === '/manifest.json') {
      return json(res, 200, manifest(), { 'cache-control':'public, max-age=300' });
    }

    const parts = route.split('/').filter(Boolean);

    if (parts[0] === 'catalog') {
      const type = parts[1];
      const id = decodeURIComponent(String(parts[2] || '')).replace(/\.json$/i, '');
      const custom = customMap.get(id);
      if (custom && custom.type === type) {
        const extra = parseExtraSegment(parts[3], u.searchParams);
        try {
          return json(res, 200, await customCatalog(custom, extra));
        } catch {
          return json(res, 200, { metas:[] });
        }
      }

      const known = verifiedMap.get(id);
      if (!known || known.type !== type) return json(res, 200, { metas:[] });

      try {
        const body = await upstreamJson(route + u.search);
        return json(res, 200, body);
      } catch {
        return json(res, 200, { metas:[] });
      }
    }

    if (parts[0] === 'meta' || parts[0] === 'stream') {
      try {
        const body = await upstreamJson(route + u.search);
        return json(res, 200, body);
      } catch {
        return json(res, 200, emptyFor(route));
      }
    }

    return json(res, 404, { error:'not found' });
  } catch (err) {
    console.error('[SERVER_ERROR]', JSON.stringify({ message:err && err.message ? err.message : String(err) }));
    return json(res, 500, { ok:false, error:'internal error' });
  }
}

if (require.main === module) {
  http.createServer(handle).listen(PORT, '0.0.0.0', () => {
    console.log('SCJC + cder v' + VERSION + ' listening on :' + PORT);
    setTimeout(async () => {
      for (const hiddenId of ['sc-concert-latest','sc-concerts-latest','sc-koncert-latest','sc-koncerts-latest','sc-movie-concert']) {
        try {
          const body = await upstreamJson('/catalog/movie/' + hiddenId + '.json');
          const metas = Array.isArray(body && body.metas) ? body.metas : [];
          console.log('[CONCERT_ROUTE_PROBE]', JSON.stringify({
            id:hiddenId,
            count:metas.length,
            samples:metas.slice(0,5).map((m) => ({ id:m && m.id || null, name:m && m.name || null }))
          }));
        } catch (err) {
          console.warn('[CONCERT_ROUTE_PROBE]', JSON.stringify({ id:hiddenId, error:err && err.message ? err.message : String(err) }));
        }
      }
      for (const genre of ['Music','Hudba','Concert','Koncert']) {
        try {
          const body = await upstreamJson('/catalog/movie/sc-movie-filter/genre=' + encodeURIComponent(genre) + '.json');
          const metas = Array.isArray(body && body.metas) ? body.metas : [];
          console.log('[CONCERT_PROBE]', JSON.stringify({
            genre,
            count:metas.length,
            samples:metas.slice(0,8).map((m) => ({ id:m && m.id || null, name:m && m.name || null }))
          }));
        } catch (err) {
          console.warn('[CONCERT_PROBE]', JSON.stringify({ genre, error:err && err.message ? err.message : String(err) }));
        }
      }
    }, 1200).unref?.();
  });
}

module.exports = {
  manifest,
  safeRoute,
  fold,
  languageFlags,
  matchesLanguages,
  upstreamCatalogPath
};
