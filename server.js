'use strict';

const http = require('node:http');
const { URL } = require('node:url');

const VERSION = '2.1.0';
const PORT = Number(process.env.PORT || 10000);
const CDER_MANIFEST_URL = String(process.env.CDER_MANIFEST_URL || '').trim();
const FSWS_ADDON_BASE = String(process.env.FSWS_ADDON_BASE || 'https://fastshare-stremio-addon-v5-0-smart.onrender.com').trim().replace(/\/$/, '');
const FALLBACK_TIMEOUT_MS = Math.max(2500, Number(process.env.FSWS_TIMEOUT_MS || 8500));
const MAX_COMBINED_STREAMS = Math.max(20, Number(process.env.MAX_COMBINED_STREAMS || 80));
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
  { id:'scx-series-sk', type:'series', name:'🇸🇰 SC+: Seriály so SK', source:'sc-series-filter', languages:['SK'] },
  { id:'scx-concerts', type:'movie', name:'🎤 SC+: Koncerty', source:'sc-movie-filter', genre:'Music', concertOnly:true },
  { id:'scx-music', type:'movie', name:'🎵 SC+: Hudba a koncerty', source:'sc-movie-filter', genre:'Music' }
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

function isConcertLike(meta) {
  const name = fold(meta && meta.name).replace(/\s+-\s+[A-Z,+ ]+$/, '');
  return /\bLIVE\b|\bCONCERT\b|\bKONCERT\b|\bTOUR\b|\bUNPLUGGED\b|\bONE NIGHT ONLY\b|\bHOMECOMING\b|\bWEMBLEY\b|\bOLYMPIA\b|\bLIVE SESSION\b|\bLIVE PERFORMANCE\b|\bLIVE EXPERIENCE\b|\bMUSIC FESTIVAL\b/.test(name);
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


async function externalJson(url, ttlMs = 20_000) {
  const key = 'external:' + url;
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && hit.expiresAt > now) return hit.value;
  if (inflight.has(key)) return inflight.get(key);

  const work = (async () => {
    await acquire();
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FALLBACK_TIMEOUT_MS);
      try {
        const response = await fetch(url, {
          headers:{ 'accept':'application/json', 'user-agent':'SCJC-cder-bridge/' + VERSION },
          signal:controller.signal
        });
        if (!response.ok) throw new Error('HTTP_' + response.status);
        const body = await response.json();
        cache.set(key, { value:body, expiresAt:Date.now() + ttlMs });
        return body;
      } finally {
        clearTimeout(timer);
      }
    } finally {
      release();
    }
  })();

  inflight.set(key, work);
  try { return await work; }
  finally { inflight.delete(key); }
}

function extractImdb(value, seen = new Set(), depth = 0) {
  if (depth > 8 || value == null) return null;
  if (typeof value === 'string') {
    const m = value.match(/\btt\d{5,12}\b/i);
    return m ? m[0].toLowerCase() : null;
  }
  if (typeof value !== 'object' || seen.has(value)) return null;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = extractImdb(item, seen, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  const priority = ['imdb_id','imdbId','imdb','external_ids','id'];
  for (const key of priority) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      const hit = extractImdb(value[key], seen, depth + 1);
      if (hit) return hit;
    }
  }
  for (const item of Object.values(value)) {
    const hit = extractImdb(item, seen, depth + 1);
    if (hit) return hit;
  }
  return null;
}

async function resolveImdb(type, id, knownMetaBody = null) {
  const raw = String(id || '');
  const first = raw.split(':')[0];
  if (/^tt\d+$/i.test(first)) return first.toLowerCase();
  const direct = extractImdb(knownMetaBody);
  if (direct) return direct;
  try {
    const body = await upstreamJson('/meta/' + type + '/' + first + '.json');
    return extractImdb(body);
  } catch {
    return null;
  }
}

function fallbackId(id, imdb) {
  if (!imdb) return null;
  const raw = String(id || '');
  const parts = raw.split(':');
  if (parts.length >= 3 && /^\d+$/.test(parts[1]) && /^\d+$/.test(parts[2])) {
    return imdb + ':' + parts[1] + ':' + parts[2];
  }
  const sm = raw.match(/(?:^|:)s?(\d{1,2})e(\d{1,3})$/i);
  if (sm) return imdb + ':' + Number(sm[1]) + ':' + Number(sm[2]);
  return imdb;
}

function humanSize(bytes) {
  const n = Number(bytes || 0);
  if (!Number.isFinite(n) || n <= 0) return '';
  const units = ['B','KB','MB','GB','TB'];
  let v = n, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  const digits = i >= 3 ? 1 : 0;
  return v.toFixed(digits) + ' ' + units[i];
}

function streamSize(stream) {
  const hinted = Number(stream?.behaviorHints?.videoSize || stream?.videoSize || stream?.size || 0);
  if (hinted > 0) return hinted;
  const text = [stream?.title, stream?.name, stream?.description, stream?.behaviorHints?.filename].filter(Boolean).join(' ');
  const m = text.match(/(\d+(?:[.,]\d+)?)\s*(TB|TIB|GB|GIB|MB|MIB)\b/i);
  if (!m) return 0;
  const value = Number(m[1].replace(',', '.'));
  const unit = m[2].toUpperCase();
  const mult = unit.startsWith('T') ? 1024 ** 4 : unit.startsWith('G') ? 1024 ** 3 : 1024 ** 2;
  return Math.round(value * mult);
}

function streamQuality(stream) {
  const text = fold([stream?.name, stream?.title, stream?.description, stream?.behaviorHints?.filename].filter(Boolean).join(' '));
  if (/\b(2160P|4K|UHD)\b/.test(text)) return '4K';
  if (/\b1080P\b/.test(text)) return '1080p';
  if (/\b720P\b/.test(text)) return '720p';
  if (/\b480P\b/.test(text)) return '480p';
  return '';
}

function streamProvider(stream) {
  const text = fold([stream?.name, stream?.title, stream?.description].filter(Boolean).join(' '));
  if (text.includes('FASTSHARE')) return 'FastShare';
  if (text.includes('WEBSHARE')) return 'Webshare';
  return 'Stream Cinema';
}

function streamLanguage(stream) {
  const raw = [stream?.name, stream?.title, stream?.description, stream?.behaviorHints?.filename].filter(Boolean).join(' ');
  const text = fold(raw);
  const czSubs = /\b(CZ|CZE|CS|CZECH)\b.{0,16}\b(SUB|SUBS|TIT|TITULKY|FORCED)\b/.test(text);
  const skSubs = /\b(SK|SVK|SLOVAK)\b.{0,16}\b(SUB|SUBS|TIT|TITULKY|FORCED)\b/.test(text);
  const czExplicit = /🇨🇿/.test(raw) || /\b(CZ|CZE|CS|CZECH)\b.{0,18}\b(AUDIO|DAB|DABING|DUB|DUBBING)\b/.test(text);
  const skExplicit = /🇸🇰/.test(raw) || /\b(SK|SVK|SLOVAK)\b.{0,18}\b(AUDIO|DAB|DABING|DUB|DUBBING)\b/.test(text);
  const standaloneCz = !czSubs && /(?:^|[^A-Z])(CZ|CZE|CZECH)(?:[^A-Z]|$)/.test(text);
  const standaloneSk = !skSubs && /(?:^|[^A-Z])(SK|SVK|SLOVAK)(?:[^A-Z]|$)/.test(text);
  const cz = czExplicit || standaloneCz;
  const sk = skExplicit || standaloneSk;
  const genericDub = /\b(DABING|DUBBING|DUBBED|DAB|DUB)\b/.test(text);
  const multi = /\b(MULTI|DUAL AUDIO)\b/.test(text);
  const en = /🇬🇧/.test(raw) || /\b(EN|ENG|ENGLISH)\b.{0,18}\b(AUDIO|DUB|DUBBING)\b/.test(text);

  if (cz && sk) return { rank:50, flag:'🇨🇿🇸🇰', label:'CZ/SK', dubbed:true };
  if (cz) return { rank:45, flag:'🇨🇿', label:'CZ', dubbed:true };
  if (sk) return { rank:44, flag:'🇸🇰', label:'SK', dubbed:true };
  if (genericDub) return { rank:35, flag:'🎙️', label:'Dabing', dubbed:true };
  if (multi) return { rank:25, flag:'🌐', label:'MULTI', dubbed:false };
  if (en) return { rank:10, flag:'🇬🇧', label:'EN', dubbed:false };
  if (czSubs) return { rank:5, flag:'🇨🇿', label:'CZ titulky', dubbed:false };
  if (skSubs) return { rank:5, flag:'🇸🇰', label:'SK titulky', dubbed:false };
  return { rank:0, flag:'', label:'Audio ?', dubbed:false };
}

function decorateStream(stream) {
  const provider = streamProvider(stream);
  const language = streamLanguage(stream);
  const size = streamSize(stream);
  const quality = streamQuality(stream);
  const info = [language.flag, language.label, quality, humanSize(size), provider].filter(Boolean).join(' • ');
  const originalTitle = String(stream?.title || '').trim();
  return {
    ...stream,
    name: [language.flag, language.label, provider].filter(Boolean).join(' ') || provider,
    title: originalTitle ? info + '\n' + originalTitle : info,
    behaviorHints: {
      ...(stream?.behaviorHints || {}),
      ...(size ? { videoSize:size } : {})
    },
    __rankLanguage:language.rank,
    __rankSize:size
  };
}

function mergeAndSortStreams(...groups) {
  const seen = new Set();
  const out = [];
  for (const stream of groups.flat()) {
    if (!stream || typeof stream !== 'object') continue;
    const key = String(stream.url || stream.infoHash || stream.ytId || stream.externalUrl || JSON.stringify(stream)).trim();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(decorateStream(stream));
  }
  out.sort((a,b) =>
    (b.__rankLanguage - a.__rankLanguage) ||
    (b.__rankSize - a.__rankSize)
  );
  return out.slice(0, MAX_COMBINED_STREAMS).map(({__rankLanguage,__rankSize,...stream}) => stream);
}

async function fallbackStreams(type, id, imdb) {
  const mapped = fallbackId(id, imdb);
  if (!mapped || !FSWS_ADDON_BASE) return [];
  try {
    const body = await externalJson(
      FSWS_ADDON_BASE + '/stream/' + encodeURIComponent(type) + '/' + encodeURIComponent(mapped) + '.json',
      20_000
    );
    return Array.isArray(body?.streams) ? body.streams : [];
  } catch {
    return [];
  }
}

function preferredLocalizedTitle(metaPayload) {
  const details = metaPayload?.meta?.localizedTitleData?.aliasDetails;
  if (!Array.isArray(details)) return '';
  const cs = details.find(x => ['cs','cz','cze'].includes(String(x?.language || '').toLowerCase()) && x?.title);
  if (cs) return String(cs.title);
  const sk = details.find(x => ['sk','svk'].includes(String(x?.language || '').toLowerCase()) && x?.title);
  return sk?.title ? String(sk.title) : '';
}

async function fallbackMeta(type, imdb) {
  if (!imdb || !FSWS_ADDON_BASE) return null;
  try {
    return await externalJson(
      FSWS_ADDON_BASE + '/debug/meta/' + encodeURIComponent(type) + '/' + encodeURIComponent(imdb) + '.json',
      6 * 60 * 60 * 1000
    );
  } catch {
    return null;
  }
}

async function enrichedMeta(type, id, route) {
  const cderBody = await upstreamJson(route);
  const imdb = await resolveImdb(type, id, cderBody);
  if (!imdb) return cderBody;
  const ext = await fallbackMeta(type, imdb);
  const base = cderBody?.meta && typeof cderBody.meta === 'object' ? cderBody.meta : {};
  const raw = ext?.meta?.raw && typeof ext.meta.raw === 'object' ? ext.meta.raw : {};
  const localName = preferredLocalizedTitle(ext);
  const merged = {
    ...raw,
    ...base,
    id:base.id || String(id).split(':')[0],
    name:base.name || localName || raw.name || raw.title,
    imdb_id:imdb,
    imdbId:imdb,
    tmdbId:ext?.meta?.localizedTitleData?.tmdbId || base.tmdbId || raw.tmdbId
  };
  if (Array.isArray(base.videos)) merged.videos = base.videos;
  return { ...cderBody, meta:merged };
}

function upstreamCatalogPath(type, id, skip, genre) {
  const extras = [];
  if (genre) extras.push('genre=' + encodeURIComponent(genre));
  if (skip) extras.push('skip=' + Number(skip));
  if (!extras.length) return '/catalog/' + type + '/' + id + '.json';
  return '/catalog/' + type + '/' + id + '/' + extras.join('&') + '.json';
}

async function customCatalog(custom, extra) {
  const requestedSkip = Math.max(0, Number(extra.get('skip') || 0));
  const need = requestedSkip + PAGE_SIZE;
  const matched = [];

  for (let page = 0; page < MAX_SCAN_PAGES && matched.length < need; page += 1) {
    const upstreamSkip = page * UPSTREAM_SCAN_SIZE;
    let body;
    try {
      body = await upstreamJson(upstreamCatalogPath(custom.type, custom.source, upstreamSkip, custom.genre));
    } catch {
      break;
    }
    const metas = Array.isArray(body && body.metas) ? body.metas : [];
    if (!metas.length) break;

    for (const meta of metas) {
      if (Array.isArray(custom.languages) && !matchesLanguages(meta, custom.languages)) continue;
      if (custom.concertOnly && !isConcertLike(meta)) continue;
      matched.push(meta);
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

    if (parts[0] === 'meta') {
      const type = parts[1];
      const id = decodeURIComponent(String(parts.slice(2).join('/') || '')).replace(/\.json$/i, '');
      try {
        return json(res, 200, await enrichedMeta(type, id, route + u.search));
      } catch {
        return json(res, 200, { meta:null });
      }
    }

    if (parts[0] === 'stream') {
      const type = parts[1];
      const id = decodeURIComponent(String(parts.slice(2).join('/') || '')).replace(/\.json$/i, '');
      try {
        const cderPromise = upstreamJson(route + u.search).catch(() => ({ streams:[] }));
        const imdbPromise = resolveImdb(type, id).catch(() => null);
        const [cderBody, imdb] = await Promise.all([cderPromise, imdbPromise]);
        const extra = await fallbackStreams(type, id, imdb);
        const cderStreams = Array.isArray(cderBody?.streams) ? cderBody.streams : [];
        return json(res, 200, { streams:mergeAndSortStreams(cderStreams, extra) });
      } catch {
        return json(res, 200, { streams:[] });
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
  });
}

module.exports = {
  manifest,
  safeRoute,
  fold,
  languageFlags,
  matchesLanguages,
  isConcertLike,
  extractImdb,
  streamLanguage,
  streamSize,
  mergeAndSortStreams,
  upstreamCatalogPath
};
