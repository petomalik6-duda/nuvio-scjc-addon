'use strict';

const http = require('node:http');
const { URL, URLSearchParams } = require('node:url');

const VERSION = '2.6.1';
const PORT = Number(process.env.PORT || 10000);
const CDER_MANIFEST_URL = String(process.env.CDER_MANIFEST_URL || '').trim();
const MAX_CONCURRENCY = Math.max(1, Number(process.env.CDER_MAX_CONCURRENCY || 1));
const CDER_MIN_INTERVAL_MS = Math.max(0, Number(process.env.CDER_MIN_INTERVAL_MS || 750));
const DEFAULT_BACKOFF_MS = Math.max(5 * 60 * 1000, Number(process.env.CDER_BACKOFF_MS || 30 * 60 * 1000));
const CDER_TIMEOUT_MS = Math.max(3_000, Number(process.env.CDER_TIMEOUT_MS || 10_000));
const CACHE_MAX_ENTRIES = Math.max(200, Number(process.env.CACHE_MAX_ENTRIES || 2000));
const ID_MAP_MAX_ENTRIES = Math.max(500, Number(process.env.ID_MAP_MAX_ENTRIES || 5000));
const PAGE_SIZE = 100;
const MAX_CATALOG_ITEMS = 800;
const UPSTREAM_SCAN_SIZE = 100;
const DERIVED_CATALOG_CACHE_TTL_MS = 30 * 60 * 1000;
const DERIVED_CATALOG_CACHE_MAX = 250;
const MAX_TOTAL_SOURCE_PAGES = 40;
const SEARCH_MAX_TOTAL_SOURCE_PAGES = 8;

const CORE_CATALOGS = [
  { id:'sc-movie-latest', type:'movie', name:'⏳ SC: Najnovšie filmy', extra:['skip'], visible:true },
  { id:'sc-movie-popular', type:'movie', name:'⭐ SC: Populárne filmy', extra:['skip'], visible:true },
  { id:'sc-series-latest', type:'series', name:'⏳ SC: Najnovšie seriály', extra:['skip'], visible:true },
  { id:'sc-series-popular', type:'series', name:'⭐ SC: Populárne seriály', extra:['skip'], visible:true },
  { id:'sc-movie-trending', type:'movie', name:'🔥 SC: Populárne teraz (filmy)', extra:['genre','skip'], visible:true },
  { id:'sc-movie-watching', type:'movie', name:'👁 SC: Práve sa pozerajú (filmy)', extra:['genre','skip'], visible:true },
  { id:'sc-series-trending', type:'series', name:'🔥 SC: Populárne teraz (seriály)', extra:['genre','skip'], visible:true },
  { id:'sc-series-watching', type:'series', name:'👁 SC: Práve sa pozerajú (seriály)', extra:['genre','skip'], visible:true },

  // Internal sources for derived catalogs. Hidden from the home screen.
  { id:'sc-movie-filter', type:'movie', name:'SC movie filter', extra:['genre','year','letter','skip'], visible:false },
  { id:'sc-series-filter', type:'series', name:'SC series filter', extra:['genre','year','letter','skip'], visible:false }
];

const CUSTOM_CATALOGS = [
  { id:'scx-movie-dubbed-latest', type:'movie', name:'🇨🇿🇸🇰 SC+: Novinky dabované filmy', source:'sc-movie-latest', languages:['CZ','SK'], scanPages:2 },
  { id:'scx-series-dubbed-latest', type:'series', name:'🇨🇿🇸🇰 SC+: Novinky dabované seriály', source:'sc-series-latest', languages:['CZ','SK'], scanPages:2 },
  { id:'scx-movie-cz', type:'movie', name:'🇨🇿 SC+: Filmy s CZ', source:'sc-movie-filter', languages:['CZ'], scanPages:2 },
  { id:'scx-movie-sk', type:'movie', name:'🇸🇰 SC+: Filmy so SK', source:'sc-movie-filter', languages:['SK'], scanPages:2 },
  { id:'scx-series-cz', type:'series', name:'🇨🇿 SC+: Seriály s CZ', source:'sc-series-filter', languages:['CZ'], scanPages:2 },
  { id:'scx-series-sk', type:'series', name:'🇸🇰 SC+: Seriály so SK', source:'sc-series-filter', languages:['SK'], scanPages:2 },
  { id:'scx-concerts', type:'movie', name:'🎤 SC+: Koncerty', source:'sc-movie-filter', genre:'Music', concertOnly:true, scanPages:2 },
  { id:'scx-music', type:'movie', name:'🎵 SC+: Hudba a koncerty', source:'sc-movie-filter', genre:'Music', scanPages:1 },

  { id:'scx-search-movies', type:'movie', name:'🔎 SC+: Hľadať filmy', source:'sc-movie-popular', searchMode:'upstream', scanPages:2 },
  { id:'scx-search-series', type:'series', name:'🔎 SC+: Hľadať seriály', source:'sc-series-popular', searchMode:'upstream', scanPages:2 },
  { id:'scx-search-concerts', type:'movie', name:'🔎🎤 SC+: Hľadať koncerty', source:'sc-movie-popular', searchMode:'upstream', concertOnly:true, scanPages:2 }
];

const coreMap = new Map(CORE_CATALOGS.map(c => [c.id, c]));
const customMap = new Map(CUSTOM_CATALOGS.map(c => [c.id, c]));

const metrics = {
  startedAt:Date.now(),
  upstreamRequests:0,
  upstreamSuccess:0,
  upstreamErrors:0,
  upstream429:0,
  timeouts:0,
  staleServed:0,
  totalLatencyMs:0,
  lastSuccessAt:null,
  lastError:null
};

class TTLCache {
  constructor(maxEntries = 2000) {
    this.maxEntries = maxEntries;
    this.map = new Map();
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
  }

  getFresh(key) {
    const item = this.map.get(key);
    if (!item) {
      this.misses += 1;
      return undefined;
    }
    if (item.expiresAt <= Date.now()) {
      this.misses += 1;
      return undefined;
    }
    this.hits += 1;
    this.map.delete(key);
    this.map.set(key, item);
    return item.value;
  }

  getStale(key) {
    const item = this.map.get(key);
    if (!item) return undefined;
    this.map.delete(key);
    this.map.set(key, item);
    return item.value;
  }

  set(key, value, ttlMs) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, { value, expiresAt:Date.now() + ttlMs });
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
      this.evictions += 1;
    }
  }

  get size() {
    return this.map.size;
  }
}

class BoundedMap {
  constructor(maxEntries = 5000) {
    this.maxEntries = maxEntries;
    this.map = new Map();
  }

  get(key) {
    if (!this.map.has(key)) return undefined;
    const value = this.map.get(key);
    this.map.delete(key);
    this.map.set(key, value);
    return value;
  }

  set(key, value) {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  get size() {
    return this.map.size;
  }
}

const cache = new TTLCache(CACHE_MAX_ENTRIES);
const derivedCatalogCache = new TTLCache(DERIVED_CATALOG_CACHE_MAX);
const cderIdMap = new BoundedMap(ID_MAP_MAX_ENTRIES);
const inflight = new Map();
const waiters = [];
let active = 0;
let upstreamBackoffUntil = 0;
let lastUpstreamStartedAt = 0;

function upstreamBase() {
  if (!CDER_MANIFEST_URL) throw new Error('CDER_MANIFEST_URL is not configured');
  const url = new URL(CDER_MANIFEST_URL);
  url.pathname = url.pathname.replace(/\/manifest\.json$/i, '/');
  url.search = '';
  url.hash = '';
  return url;
}

function json(res, status, body, extraHeaders = {}) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'content-type':'application/json; charset=utf-8',
    'content-length':data.length,
    'access-control-allow-origin':'*',
    'cache-control':'no-store',
    ...extraHeaders
  });
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
  const catalogs = CORE_CATALOGS
    .filter(c => c.visible)
    .map(c => ({
      id:c.id,
      type:c.type,
      name:c.name,
      extra:c.extra.map(name => ({ name, isRequired:false }))
    }))
    .concat(CUSTOM_CATALOGS.map(c => ({
      id:c.id,
      type:c.type,
      name:c.name,
      extra:c.searchMode
        ? [{ name:'search', isRequired:true }, { name:'skip', isRequired:false }]
        : [{ name:'skip', isRequired:false }]
    })));

  return {
    id:'community.scjc.cder.bridge',
    version:VERSION,
    name:'SCJC + cder',
    description:'Safe Nuvio/Stremio bridge over cder Stream Cinema with standard IMDb IDs, search, metadata normalization and CZ/SK-first stream sorting.',
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

function routeContext(pathname) {
  const parts = String(pathname || '/').split('/').filter(Boolean);
  const roots = new Set(['manifest.json','catalog','meta','stream','health','configure']);
  // Backward compatibility with old encrypted/configured manifest paths.
  if (parts.length >= 2 && !roots.has(parts[0]) && roots.has(parts[1])) parts.shift();
  return '/' + parts.join('/');
}

function parseExtraSegment(segment, searchParams) {
  const out = new URLSearchParams();
  if (segment) {
    const raw = decodeURIComponent(String(segment).replace(/\.json$/i, ''));
    for (const pair of raw.split('&')) {
      const i = pair.indexOf('=');
      if (i >= 0) out.set(pair.slice(0, i), pair.slice(i + 1));
    }
  }
  for (const [key, value] of searchParams.entries()) out.set(key, value);
  return out;
}

function fold(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toUpperCase();
}

function languageFlags(meta) {
  const tail = fold(meta?.name).slice(-120);
  return {
    CZ:/\bCZ\b/.test(tail),
    SK:/\bSK\b/.test(tail)
  };
}

function matchesLanguages(meta, languages) {
  const flags = languageFlags(meta);
  return languages.some(lang => flags[lang]);
}

function isConcertLike(meta) {
  const text = fold([
    meta?.name,
    meta?.description,
    ...(Array.isArray(meta?.genres) ? meta.genres : [])
  ].filter(Boolean).join(' '));

  return /\bLIVE\b|\bCONCERT\b|\bKONCERT\b|\bTOUR\b|\bUNPLUGGED\b|\bONE NIGHT ONLY\b|\bHOMECOMING\b|\bWEMBLEY\b|\bOLYMPIA\b|\bLIVE SESSION\b|\bLIVE PERFORMANCE\b|\bLIVE EXPERIENCE\b|\bMUSIC FESTIVAL\b/.test(text);
}

function retryAfterMs(headers) {
  const raw = headers?.get?.('retry-after');
  if (!raw) return DEFAULT_BACKOFF_MS;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.max(60_000, seconds * 1000);
  const absolute = Date.parse(raw);
  return Number.isFinite(absolute) ? Math.max(60_000, absolute - Date.now()) : DEFAULT_BACKOFF_MS;
}

function ttlFor(path) {
  if (/\/stream\//.test(path)) return 25_000;
  if (/\/meta\//.test(path)) return 12 * 60 * 60 * 1000;
  if (/[?/&]search=/.test(path)) return 2 * 60 * 1000;
  if (/\/catalog\//.test(path)) return 5 * 60 * 1000;
  return 5 * 60 * 1000;
}

async function acquire() {
  if (active < MAX_CONCURRENCY) {
    active += 1;
    return;
  }
  await new Promise(resolve => waiters.push(resolve));
  active += 1;
}

function release() {
  active = Math.max(0, active - 1);
  const next = waiters.shift();
  if (next) next();
}

async function throttleUpstream() {
  const waitMs = Math.max(0, lastUpstreamStartedAt + CDER_MIN_INTERVAL_MS - Date.now());
  if (waitMs > 0) await new Promise(resolve => setTimeout(resolve, waitMs));
  lastUpstreamStartedAt = Date.now();
}

function openBackoff(code, status = null, ms = DEFAULT_BACKOFF_MS) {
  upstreamBackoffUntil = Math.max(upstreamBackoffUntil, Date.now() + Math.max(60_000, ms));
  recordError(code, status);
}

function recordError(code, status = null) {
  metrics.lastError = { code, status, at:new Date().toISOString() };
}

async function upstreamJson(path, options = {}) {
  const key = path;
  const fresh = cache.getFresh(key);
  if (fresh !== undefined) return fresh;

  const stale = cache.getStale(key);
  if (upstreamBackoffUntil > Date.now()) {
    if (stale !== undefined) {
      metrics.staleServed += 1;
      return stale;
    }
    const error = new Error('CDER_BACKOFF');
    error.code = 'CDER_BACKOFF';
    throw error;
  }

  if (inflight.has(key)) return inflight.get(key);

  const work = (async () => {
    await acquire();
    await throttleUpstream();
    const started = Date.now();
    metrics.upstreamRequests += 1;

    try {
      const url = new URL(path.replace(/^\//, ''), upstreamBase());
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Number(options.timeoutMs || CDER_TIMEOUT_MS));

      try {
        const response = await fetch(url, {
          headers:{
            accept:'application/json',
            'user-agent':'SCJC-cder-bridge/' + VERSION
          },
          signal:controller.signal
        });

        const text = await response.text();
        let body = null;
        try {
          body = text ? JSON.parse(text) : null;
        } catch {
          body = null;
        }

        if (response.status === 429) {
          metrics.upstream429 += 1;
          metrics.upstreamErrors += 1;
          openBackoff('CDER_RATE_LIMIT', 429, Math.max(DEFAULT_BACKOFF_MS, retryAfterMs(response.headers)));
          if (stale !== undefined) {
            metrics.staleServed += 1;
            return stale;
          }
          const error = new Error('CDER_RATE_LIMIT');
          error.code = 'CDER_RATE_LIMIT';
          error.status = 429;
          throw error;
        }

        if (!response.ok || body == null) {
          metrics.upstreamErrors += 1;
          const isCatalog = /\/catalog\//.test(path);
          if (isCatalog && [401,403,404].includes(response.status)) {
            openBackoff('CDER_CATALOG_BLOCK_' + response.status, response.status);
          } else if (isCatalog && response.status >= 500) {
            openBackoff('CDER_CATALOG_HTTP_' + response.status, response.status, Math.min(DEFAULT_BACKOFF_MS, 5 * 60 * 1000));
          } else {
            recordError('CDER_HTTP_' + response.status, response.status);
          }
          if (stale !== undefined) {
            metrics.staleServed += 1;
            return stale;
          }
          const error = new Error('CDER_HTTP_' + response.status);
          error.status = response.status;
          throw error;
        }

        cache.set(key, body, ttlFor(path));
        metrics.upstreamSuccess += 1;
        metrics.lastSuccessAt = new Date().toISOString();
        return body;
      } catch (error) {
        if (error?.name === 'AbortError') {
          metrics.timeouts += 1;
          metrics.upstreamErrors += 1;
          if (/\/catalog\//.test(path)) openBackoff('CDER_CATALOG_TIMEOUT', null);
          else recordError('CDER_TIMEOUT', null);
          if (stale !== undefined) {
            metrics.staleServed += 1;
            return stale;
          }
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    } finally {
      metrics.totalLatencyMs += Date.now() - started;
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

function extractImdb(value, seen = new Set(), depth = 0) {
  if (depth > 8 || value == null) return null;

  if (typeof value === 'string') {
    const match = value.match(/\btt\d{5,12}\b/i);
    return match ? match[0].toLowerCase() : null;
  }

  if (typeof value !== 'object' || seen.has(value)) return null;
  seen.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = extractImdb(item, seen, depth + 1);
      if (found) return found;
    }
    return null;
  }

  const priority = ['imdb_id','imdbId','imdb','external_ids','id'];
  for (const key of priority) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      const found = extractImdb(value[key], seen, depth + 1);
      if (found) return found;
    }
  }

  for (const item of Object.values(value)) {
    const found = extractImdb(item, seen, depth + 1);
    if (found) return found;
  }

  return null;
}

function cderMapKey(type, imdb) {
  return String(type || '') + ':' + String(imdb || '').toLowerCase();
}

function rememberCderId(type, meta) {
  if (!meta || typeof meta !== 'object') return meta;

  const originalRoot = String(meta.id || '').split(':')[0];
  const imdb = extractImdb(meta);
  if (!imdb || !/^tt\d+$/i.test(imdb)) return meta;

  if (/^sc/i.test(originalRoot)) cderIdMap.set(cderMapKey(type, imdb), originalRoot);

  return {
    ...meta,
    id:imdb,
    imdb_id:imdb,
    imdbId:imdb
  };
}

function standardizeCatalogBody(type, body) {
  const metas = Array.isArray(body?.metas)
    ? body.metas.map(meta => rememberCderId(type, meta))
    : [];
  return { ...body, metas };
}

function cderSourceId(type, publicId) {
  const raw = String(publicId || '');
  const parts = raw.split(':');
  const root = parts[0];

  if (/^sc/i.test(root)) return raw;
  if (!/^tt\d+$/i.test(root)) return raw;

  const mapped = cderIdMap.get(cderMapKey(type, root));
  if (!mapped) return raw;

  return [mapped, ...parts.slice(1)].join(':');
}

function standardizeVideos(videos, imdb) {
  if (!Array.isArray(videos) || !imdb) return videos;

  return videos.map(video => {
    if (!video || typeof video !== 'object') return video;
    const raw = String(video.id || '');
    const suffix = raw.includes(':') ? raw.split(':').slice(1) : [];
    return {
      ...video,
      id:suffix.length ? [imdb, ...suffix].join(':') : imdb
    };
  });
}

function tmdbIdFromMeta(meta) {
  if (meta?.tmdbId || meta?.tmdb_id) return Number(meta.tmdbId || meta.tmdb_id) || null;

  for (const link of Array.isArray(meta?.links) ? meta.links : []) {
    const match = String(link?.url || '').match(/themoviedb\.org\/(?:movie|tv)\/(\d+)/i);
    if (match) return Number(match[1]);
  }

  return null;
}

async function enrichedMeta(type, publicId) {
  const sourceId = cderSourceId(type, publicId);
  const body = await upstreamJson('/meta/' + type + '/' + encodeURIComponent(sourceId) + '.json');
  const base = body?.meta && typeof body.meta === 'object' ? body.meta : {};

  const publicRoot = String(publicId || '').split(':')[0];
  const imdb = /^tt\d+$/i.test(publicRoot)
    ? publicRoot.toLowerCase()
    : extractImdb(base);

  if (!imdb) return body;

  if (/^sc/i.test(String(sourceId).split(':')[0])) {
    cderIdMap.set(cderMapKey(type, imdb), String(sourceId).split(':')[0]);
  }

  const meta = {
    ...base,
    id:imdb,
    imdb_id:imdb,
    imdbId:imdb
  };

  const tmdbId = tmdbIdFromMeta(base);
  if (tmdbId) meta.tmdbId = tmdbId;
  if (Array.isArray(base.videos)) meta.videos = standardizeVideos(base.videos, imdb);

  return { ...body, meta };
}

function streamText(stream) {
  const supplemental = [
    stream?.audio,
    stream?.audios,
    stream?.language,
    stream?.languages,
    stream?.behaviorHints?.audio,
    stream?.behaviorHints?.languages
  ];

  return [
    stream?.name,
    stream?.title,
    stream?.description,
    stream?.behaviorHints?.filename,
    ...supplemental.map(value => {
      if (value == null) return '';
      return typeof value === 'string' ? value : JSON.stringify(value);
    })
  ].filter(Boolean).join(' ');
}

function humanSize(bytes) {
  const n = Number(bytes || 0);
  if (!Number.isFinite(n) || n <= 0) return '';

  const units = ['B','KB','MB','GB','TB'];
  let value = n;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }

  return value.toFixed(index >= 3 ? 1 : 0) + ' ' + units[index];
}

function streamSize(stream) {
  const hinted = Number(stream?.behaviorHints?.videoSize || stream?.videoSize || stream?.size || 0);
  if (hinted > 0) return hinted;

  const match = streamText(stream).match(/(\d+(?:[.,]\d+)?)\s*(TB|TIB|GB|GIB|MB|MIB)\b/i);
  if (!match) return 0;

  const value = Number(match[1].replace(',', '.'));
  const unit = match[2].toUpperCase();
  const multiplier = unit.startsWith('T') ? 1024 ** 4 : unit.startsWith('G') ? 1024 ** 3 : 1024 ** 2;
  return Math.round(value * multiplier);
}

function streamQuality(stream) {
  const text = fold(streamText(stream));
  if (/\b(2160P|4K|UHD)\b/.test(text)) return '4K';
  if (/\b1080P\b/.test(text)) return '1080p';
  if (/\b720P\b/.test(text)) return '720p';
  if (/\b480P\b/.test(text)) return '480p';
  return '';
}

function streamFeatures(stream) {
  const text = fold(streamText(stream));
  const features = [];

  if (/\b(DOLBY VISION|DOVI|DV)\b/.test(text)) features.push('DV');
  else if (/\bHDR10\+\b/.test(text)) features.push('HDR10+');
  else if (/\bHDR10\b|\bHDR\b/.test(text)) features.push('HDR');

  if (/\b(DOLBY ATMOS|ATMOS)\b/.test(text)) features.push('Atmos');
  if (/\b(DTS:X|DTS X)\b/.test(text)) features.push('DTS:X');

  if (/\b(AV1)\b/.test(text)) features.push('AV1');
  else if (/\b(HEVC|H\.?265|X265)\b/.test(text)) features.push('HEVC');

  return features;
}

function streamLanguage(stream) {
  const raw = streamText(stream);
  const text = fold(raw);

  const czSubs = /\b(CZ|CZE|CS|CZECH)\b.{0,20}\b(SUB|SUBS|TIT|TITULKY|FORCED)\b/.test(text);
  const skSubs = /\b(SK|SVK|SLOVAK)\b.{0,20}\b(SUB|SUBS|TIT|TITULKY|FORCED)\b/.test(text);

  const czExplicit =
    /🇨🇿/.test(raw) ||
    /\b(CZ|CZE|CS|CZECH)\b\s*(?:[:=|,\/-]\s*)?(AUDIO|DAB|DABING|DUB|DUBBING)\b/.test(text) ||
    /\b(AUDIO|DAB|DABING|DUB|DUBBING)\b\s*(?:[:=|,\/-]\s*)?(CZ|CZE|CS|CZECH)\b/.test(text);

  const skExplicit =
    /🇸🇰/.test(raw) ||
    /\b(SK|SVK|SLOVAK)\b\s*(?:[:=|,\/-]\s*)?(AUDIO|DAB|DABING|DUB|DUBBING)\b/.test(text) ||
    /\b(AUDIO|DAB|DABING|DUB|DUBBING)\b\s*(?:[:=|,\/-]\s*)?(SK|SVK|SLOVAK)\b/.test(text);

  const standaloneCz = !czSubs && /(?:^|[^A-Z])(CZ|CZE|CZECH)(?:[^A-Z]|$)/.test(text);
  const standaloneSk = !skSubs && /(?:^|[^A-Z])(SK|SVK|SLOVAK)(?:[^A-Z]|$)/.test(text);

  const cz = czExplicit || standaloneCz;
  const sk = skExplicit || standaloneSk;
  const genericDub = /\b(DABING|DUBBING|DUBBED|DAB|DUB)\b/.test(text);
  const multi = /\b(MULTI|DUAL AUDIO)\b/.test(text);
  const en = /🇬🇧/.test(raw) || /\b(EN|ENG|ENGLISH)\b(?:.{0,20}\b(AUDIO|DUB|DUBBING)\b)?/.test(text);

  if (cz && sk) return { rank:50, flag:'🇨🇿🇸🇰', label:'CZ/SK', dubbed:true };
  if (cz) return { rank:50, flag:'🇨🇿', label:'CZ', dubbed:true };
  if (sk) return { rank:50, flag:'🇸🇰', label:'SK', dubbed:true };
  if (genericDub) return { rank:35, flag:'🎙️', label:'Dabing', dubbed:true };
  if (multi) return { rank:25, flag:'🌐', label:'MULTI', dubbed:false };
  if (en) return { rank:10, flag:'🇬🇧', label:'EN', dubbed:false };
  if (czSubs) return { rank:5, flag:'🇨🇿', label:'CZ titulky', dubbed:false };
  if (skSubs) return { rank:5, flag:'🇸🇰', label:'SK titulky', dubbed:false };
  return { rank:0, flag:'', label:'Audio ?', dubbed:false };
}

function decorateStream(stream) {
  const language = streamLanguage(stream);
  const size = streamSize(stream);
  const quality = streamQuality(stream);
  const features = streamFeatures(stream);

  const info = [
    language.flag,
    language.label,
    quality,
    ...features,
    humanSize(size),
    'Stream Cinema'
  ].filter(Boolean).join(' • ');

  const originalTitle = String(stream?.title || '').trim();
  const originalDescription = String(stream?.description || '').trim();

  return {
    ...stream,
    name:[language.flag, language.label, 'Stream Cinema'].filter(Boolean).join(' '),
    title:originalTitle ? info + '\n' + originalTitle : (originalDescription ? info + '\n' + originalDescription : info),
    description:originalDescription ? info + '\n' + originalDescription : info,
    behaviorHints:{
      ...(stream?.behaviorHints || {}),
      ...(size ? { videoSize:size } : {})
    },
    __rankLanguage:language.rank,
    __rankSize:size,
    __rankQuality:quality === '4K' ? 4 : quality === '1080p' ? 3 : quality === '720p' ? 2 : quality === '480p' ? 1 : 0
  };
}

function mergeAndSortStreams(streams) {
  const seen = new Set();
  const out = [];

  for (const stream of Array.isArray(streams) ? streams : []) {
    if (!stream || typeof stream !== 'object') continue;

    const key = String(
      stream.url ||
      stream.infoHash ||
      stream.ytId ||
      stream.externalUrl ||
      JSON.stringify(stream)
    ).trim();

    if (seen.has(key)) continue;
    seen.add(key);
    out.push(decorateStream(stream));
  }

  out.sort((a, b) =>
    (b.__rankLanguage - a.__rankLanguage) ||
    (b.__rankSize - a.__rankSize) ||
    (b.__rankQuality - a.__rankQuality)
  );

  return out.map(({ __rankLanguage, __rankSize, __rankQuality, ...stream }) => stream);
}

function catalogPageWindow(value) {
  const skip = Math.max(0, Math.floor(Number(value) || 0));
  if (skip >= MAX_CATALOG_ITEMS) return { skip, limit:0, need:skip };
  const limit = Math.min(PAGE_SIZE, MAX_CATALOG_ITEMS - skip);
  return { skip, limit, need:skip + limit };
}

function derivedCatalogKey(custom, search) {
  return custom.id + '|' + fold(search || '');
}

function newDerivedCatalogState() {
  return {
    metas:[],
    seen:new Set(),
    nextPage:0,
    done:false
  };
}

function upstreamCatalogPath(type, id, skip, genre, search) {
  const extras = [];
  if (genre) extras.push('genre=' + encodeURIComponent(genre));
  if (search) extras.push('search=' + encodeURIComponent(search));
  if (skip) extras.push('skip=' + Number(skip));

  if (!extras.length) return '/catalog/' + type + '/' + id + '.json';
  return '/catalog/' + type + '/' + id + '/' + extras.join('&') + '.json';
}

async function customCatalog(custom, extra) {
  const window = catalogPageWindow(extra.get('skip'));
  const search = String(extra.get('search') || '').trim();

  if (window.limit === 0) return { metas:[] };
  if (custom.searchMode && !search) return { metas:[] };

  const key = derivedCatalogKey(custom, search);
  let state = derivedCatalogCache.getFresh(key);
  if (!state) state = newDerivedCatalogState();

  const totalPageLimit = custom.searchMode
    ? SEARCH_MAX_TOTAL_SOURCE_PAGES
    : MAX_TOTAL_SOURCE_PAGES;
  const maxPagesThisRequest = Math.max(1, Math.min(2, Number(custom.scanPages || 1)));
  let pagesThisRequest = 0;

  while (
    state.metas.length < window.need &&
    state.metas.length < MAX_CATALOG_ITEMS &&
    !state.done &&
    state.nextPage < totalPageLimit &&
    pagesThisRequest < maxPagesThisRequest
  ) {
    const upstreamSkip = state.nextPage * UPSTREAM_SCAN_SIZE;
    let body;

    try {
      body = await upstreamJson(
        upstreamCatalogPath(
          custom.type,
          custom.source,
          upstreamSkip,
          custom.genre,
          custom.searchMode === 'upstream' ? search : ''
        )
      );
    } catch {
      break;
    }

    state.nextPage += 1;
    pagesThisRequest += 1;

    const metas = Array.isArray(body?.metas) ? body.metas : [];
    if (!metas.length) {
      state.done = true;
      break;
    }

    for (const meta of metas) {
      if (Array.isArray(custom.languages) && !matchesLanguages(meta, custom.languages)) continue;
      if (custom.concertOnly && !isConcertLike(meta)) continue;

      const normalized = rememberCderId(custom.type, meta);
      const dedupeKey = String(normalized?.id || meta?.id || '') + '|' + String(normalized?.name || '');
      if (state.seen.has(dedupeKey)) continue;

      state.seen.add(dedupeKey);
      state.metas.push(normalized);

      if (state.metas.length >= MAX_CATALOG_ITEMS) {
        state.done = true;
        break;
      }
    }

    if (metas.length < UPSTREAM_SCAN_SIZE) state.done = true;
  }

  derivedCatalogCache.set(key, state, DERIVED_CATALOG_CACHE_TTL_MS);

  return {
    metas:state.metas.slice(window.skip, window.skip + window.limit)
  };
}

function publicOrigin(req) {
  const proto = String(req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim() || 'https';
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || 'nuvio-scjc-addon.onrender.com').split(',')[0].trim();
  return proto + '://' + host;
}

function configurePage(req) {
  const manifestUrl = publicOrigin(req) + '/manifest.json';
  return [
    '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>SCJC + cder</title>',
    '<style>body{font-family:system-ui;max-width:760px;margin:40px auto;padding:0 18px;background:#111;color:#eee}code{word-break:break-all;background:#222;padding:5px 8px;border-radius:6px}.ok{padding:14px;background:#16391f;border-radius:10px}a{color:#8ab4ff}</style>',
    '</head><body>',
    '<h1>SCJC + cder v' + VERSION + '</h1>',
    '<p>Čistý cder bridge: bez priameho KRA loginu, bez Stream Cinema auth/token a bez sekundárneho FastShare/Webshare proxy.</p>',
    '<div class="ok"><b>Manifest URL:</b><br><code>' + manifestUrl + '</code></div>',
    '<p>Filmy a seriály sa publikujú so štandardnými IMDb <code>tt...</code> ID, takže ostatné nainštalované stream addony ich môžu nájsť samostatne.</p>',
    '<p><a href="/health">Health</a></p>',
    '</body></html>'
  ].join('');
}

function healthPayload() {
  const avgLatencyMs = metrics.upstreamRequests
    ? Math.round(metrics.totalLatencyMs / metrics.upstreamRequests)
    : 0;

  return {
    ok:true,
    version:VERSION,
    mode:'cder-proxy',
    upstreamConfigured:!!CDER_MANIFEST_URL,
    directKraLogin:false,
    directScAuth:false,
    optionalFastshareWebshare:false,
    cache:{
      size:cache.size,
      maxEntries:CACHE_MAX_ENTRIES,
      hits:cache.hits,
      misses:cache.misses,
      evictions:cache.evictions
    },
    catalogs:{
      pageSize:PAGE_SIZE,
      maxItems:MAX_CATALOG_ITEMS,
      derivedStates:derivedCatalogCache.size,
      derivedStateMax:DERIVED_CATALOG_CACHE_MAX
    },
    idMap:{
      size:cderIdMap.size,
      maxEntries:ID_MAP_MAX_ENTRIES
    },
    upstream:{
      active,
      queued:waiters.length,
      inflight:inflight.size,
      maxConcurrency:MAX_CONCURRENCY,
      minIntervalMs:CDER_MIN_INTERVAL_MS,
      requests:metrics.upstreamRequests,
      success:metrics.upstreamSuccess,
      errors:metrics.upstreamErrors,
      rateLimited:metrics.upstream429,
      timeouts:metrics.timeouts,
      staleServed:metrics.staleServed,
      avgLatencyMs,
      backoffSeconds:Math.max(0, Math.ceil((upstreamBackoffUntil - Date.now()) / 1000)),
      lastSuccessAt:metrics.lastSuccessAt,
      lastError:metrics.lastError
    },
    uptimeSeconds:Math.floor((Date.now() - metrics.startedAt) / 1000),
    at:new Date().toISOString()
  };
}

async function handle(req, res) {
  try {
    const url = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin':'*',
        'access-control-allow-headers':'*',
        'access-control-allow-methods':'GET,OPTIONS'
      });
      return res.end();
    }

    const route = routeContext(url.pathname);

    if (route === '/' || route === '/configure') return html(res, 200, configurePage(req));

    if (route === '/health') return json(res, 200, healthPayload());

    if (route === '/manifest.json') {
      return json(res, 200, manifest(), { 'cache-control':'public, max-age=300' });
    }

    const parts = route.split('/').filter(Boolean);

    if (parts[0] === 'catalog') {
      const type = parts[1];
      const id = decodeURIComponent(String(parts[2] || '')).replace(/\.json$/i, '');

      const extra = parseExtraSegment(parts[3], url.searchParams);
      const page = catalogPageWindow(extra.get('skip'));
      if (page.limit === 0) return json(res, 200, { metas:[] });

      const custom = customMap.get(id);
      if (custom && custom.type === type) {
        try {
          return json(res, 200, await customCatalog(custom, extra));
        } catch {
          return json(res, 200, { metas:[] });
        }
      }

      const core = coreMap.get(id);
      if (!core || core.type !== type) return json(res, 200, { metas:[] });

      try {
        const body = await upstreamJson(route + url.search);
        return json(res, 200, standardizeCatalogBody(type, body));
      } catch {
        return json(res, 200, { metas:[] });
      }
    }

    if (parts[0] === 'meta') {
      const type = parts[1];
      const id = decodeURIComponent(String(parts.slice(2).join('/') || '')).replace(/\.json$/i, '');

      try {
        return json(res, 200, await enrichedMeta(type, id));
      } catch {
        return json(res, 200, { meta:null });
      }
    }

    if (parts[0] === 'stream') {
      const type = parts[1];
      const publicId = decodeURIComponent(String(parts.slice(2).join('/') || '')).replace(/\.json$/i, '');
      const sourceId = cderSourceId(type, publicId);

      try {
        const body = await upstreamJson('/stream/' + type + '/' + encodeURIComponent(sourceId) + '.json');
        return json(res, 200, {
          streams:mergeAndSortStreams(Array.isArray(body?.streams) ? body.streams : [])
        });
      } catch {
        return json(res, 200, { streams:[] });
      }
    }

    return json(res, 404, { error:'not found' });
  } catch (error) {
    console.error('[SERVER_ERROR]', JSON.stringify({
      name:error?.name || 'Error',
      message:error?.message || String(error)
    }));
    return json(res, 500, { ok:false, error:'internal error' });
  }
}

if (require.main === module) {
  http.createServer(handle).listen(PORT, '0.0.0.0', () => {
    console.log('SCJC + cder v' + VERSION + ' listening on :' + PORT);
  });
}

module.exports = {
  VERSION,
  PAGE_SIZE,
  MAX_CATALOG_ITEMS,
  MAX_CONCURRENCY,
  CDER_MIN_INTERVAL_MS,
  CORE_CATALOGS,
  CUSTOM_CATALOGS,
  TTLCache,
  BoundedMap,
  manifest,
  routeContext,
  parseExtraSegment,
  fold,
  languageFlags,
  matchesLanguages,
  isConcertLike,
  extractImdb,
  rememberCderId,
  standardizeCatalogBody,
  cderSourceId,
  standardizeVideos,
  tmdbIdFromMeta,
  streamSize,
  streamQuality,
  streamFeatures,
  streamLanguage,
  decorateStream,
  mergeAndSortStreams,
  catalogPageWindow,
  upstreamCatalogPath,
  healthPayload
};
