'use strict';
const http = require('node:http');
const crypto = require('node:crypto');
const { URL, URLSearchParams } = require('node:url');

const VERSION = '1.2.4';
const PORT = Number(process.env.PORT || 10000);
const KRASKA_BASE = 'https://api.kra.sk/';
const SC_BASE = 'https://stream-cinema.online/';
const USER_AGENT = 'Kodi/21.0 (Linux; Android) (sk;; ver2.6.6.0+k19)';
const LANGUAGE = process.env.LANGUAGE || 'sk';
const HDR = Number(process.env.HDR ?? 1);
const DV = Number(process.env.DOLBY_VISION ?? 0);
const OLD_MENU = Number(process.env.OLD_MENU ?? 1);
const RATE_LIMIT_BACKOFF_MS = Number(process.env.RATE_LIMIT_BACKOFF_MS || 60000);
const KRA_REFRESH_COOLDOWN_MS = 30000;
const CACHE_TTL_MS = 90000;
const MAX_STREAMS = 12;
const FALLBACK_RESERVED_SLOTS = 3;
const FALLBACK_ADDON_BASE = String(process.env.FALLBACK_ADDON_BASE || 'https://fastshare-stremio-addon-v5-0-smart.onrender.com').replace(/\/$/, '');
const MAX_SEASONS = 16;
const CATALOG_PAGE = 50;

const CATALOGS = [
  { id: 'sc_movies_latestd', type: 'movie', name: 'SC: Novinky dabované filmy', path: '/FMovies/latestd' },
  { id: 'sc_series_latestd', type: 'series', name: 'SC: Novinky dabované seriály', path: '/FSeries/latestd' },
  { id: 'sc_movies_latest', type: 'movie', name: 'SC: Najnovšie filmy', path: '/FMovies/latest' },
  { id: 'sc_series_latestt', type: 'series', name: 'SC: Najnovšie seriály', path: '/FSeries/latestt' },
  { id: 'sc_series_added', type: 'series', name: 'SC: Pridané seriály', path: '/FSeries/latest' },
  { id: 'sc_series_newep', type: 'series', name: 'SC: Nové epizódy', path: '/FSeries/newep' },
  { id: 'sc_concerts_latest', type: 'movie', name: 'SC: Nové koncerty', path: '/FKoncert/latest' },
  { id: 'sc_movies_newstream', type: 'movie', name: 'SC: Nové streamy filmov', path: '/FMovies/newstream' },
  { id: 'sc_movies_trending', type: 'movie', name: 'SC: Trendujúce filmy', path: '/FMovies/trending' },
  { id: 'sc_series_trending', type: 'series', name: 'SC: Trendujúce seriály', path: '/FSeries/trending' },
  { id: 'sc_movies_popular', type: 'movie', name: 'SC: Populárne filmy', path: '/FMovies/popular' },
  { id: 'sc_series_popular', type: 'series', name: 'SC: Populárne seriály', path: '/FSeries/popular' },
  { id: 'sc_movies_watching', type: 'movie', name: 'SC: Filmy TOP dnes', path: '/FMovies/watching' },
  { id: 'sc_series_watching', type: 'series', name: 'SC: Seriály TOP dnes', path: '/FSeries/watching' },
  { id: 'sc_movies_recommended', type: 'movie', name: 'SC: Filmy TOP 100 tipy', path: '/Recommended?type=0' },
  { id: 'sc_movies_kids', type: 'movie', name: 'SC: Kids filmy', path: '/FMovies/kids' },
  { id: 'sc_series_recommended', type: 'series', name: 'SC: Seriály TOP 100 tipy', path: '/Recommended?type=1' },
  { id: 'sc_series_kids', type: 'series', name: 'SC: Kids seriály', path: '/FSeries/kids' },
  { id: 'sc_concerts_all', type: 'movie', name: 'SC: Všetky koncerty', path: '/FKoncert/all' },
  { id: 'sc_documentaries_latest', type: 'movie', name: 'SC: Nové dokumenty', path: '/FDocu/latest' },
  { id: 'sc_documentaries_all', type: 'movie', name: 'SC: Všetky dokumenty', path: '/FDocu/all' },
  { id: 'sc_anime_movies', type: 'movie', name: 'SC: Anime filmy', path: '/FAnime/Movies' },
  { id: 'sc_anime_series', type: 'series', name: 'SC: Anime seriály', path: '/FAnime/Series' },
  { id: 'sc_hdr_latest', type: 'movie', name: 'SC: Novinky HDR', path: '/FHDR/latest' },
  { id: 'sc_hdr_all', type: 'movie', name: 'SC: Všetko HDR', path: '/FHDR/all' },
  { id: 'sc_dolbyvision', type: 'movie', name: 'SC: Dolby Vision', path: '/FHDR/dolbyvision' },
  { id: 'sc_sport', type: 'movie', name: 'SC: Šport', path: '/FSport' }
];

const catalogMap = new Map(CATALOGS.map(c => [c.id, c]));
const authStates = new Map();
const responseCache = new Map();

function envConfig() {
  const username = process.env.KRASKA_USERNAME || '';
  const password = process.env.KRASKA_PASSWORD || '';
  if (!username || !password) return null;
  const scUuid = String(process.env.SC_UUID || '').trim().toLowerCase();
  const scToken = String(process.env.SC_AUTH_TOKEN || '').trim();
  return { username, password, ...(isScUuid(scUuid) ? { scUuid } : {}), ...(isScToken(scToken) ? { scToken } : {}) };
}

function hashKey(v) {
  return crypto.createHash('sha256').update(String(v)).digest('hex');
}

function b64urlEncode(input) {
  return Buffer.from(input).toString('base64url');
}

function b64urlDecode(input) {
  return Buffer.from(String(input), 'base64url');
}

function encodeId(payload) {
  return 'scjc:' + b64urlEncode(JSON.stringify(payload));
}

function decodeId(id) {
  if (!String(id).startsWith('scjc:')) throw new Error('Unsupported id');
  return JSON.parse(b64urlDecode(String(id).slice(5)).toString('utf8'));
}

function configKey() {
  const secret = process.env.CONFIG_SECRET || '';
  return secret ? crypto.createHash('sha256').update(secret).digest() : null;
}

function encryptConfig(config) {
  const key = configKey();
  if (!key) throw new Error('CONFIG_SECRET is not configured');
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(config), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64url');
}

function decryptConfig(token) {
  const key = configKey();
  if (!key) throw new Error('CONFIG_SECRET is not configured');
  const raw = Buffer.from(token, 'base64url');
  if (raw.length < 29) throw new Error('Invalid configuration token');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const encrypted = raw.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const clear = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  const cfg = JSON.parse(clear.toString('utf8'));
  if (!cfg?.username || !cfg?.password) throw new Error('Configuration is incomplete');
  if (cfg.scUuid && !isScUuid(cfg.scUuid)) delete cfg.scUuid;
  if (cfg.scToken && !isScToken(cfg.scToken)) delete cfg.scToken;
  return cfg;
}

function isScUuid(v) {
  return /^[0-9a-f]{32}$/i.test(String(v || ''));
}

function isScToken(v) {
  return /^\S{32}$/.test(String(v || ''));
}

function newScUuid() {
  return crypto.randomUUID().replace(/-/g, '').toLowerCase();
}

function deviceUuid(config) {
  if (isScUuid(config?.scUuid)) return String(config.scUuid).toLowerCase();
  const explicit = String(process.env.SC_UUID || '').trim().toLowerCase();
  if (isScUuid(explicit)) return explicit;
  return hashKey(`scjc-device:${config?.username || ''}:${process.env.CONFIG_SECRET || 'env'}`).slice(0, 32);
}

function json(res, status, body, headers = {}) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': data.length,
    'access-control-allow-origin': '*',
    'cache-control': 'no-store',
    ...headers
  });
  res.end(data);
}

function html(res, status, body) {
  const data = Buffer.from(body);
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': data.length,
    'cache-control': 'no-store'
  });
  res.end(data);
}

class ApiError extends Error {
  constructor(message, { service = '', status = 0, body = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.service = service;
    this.status = Number(status || 0);
    this.body = body;
  }
}

async function fetchJson(url, options = {}, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    const text = await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = null; }
    return { ok: response.ok, status: response.status, body, text, headers: response.headers };
  } finally {
    clearTimeout(timer);
  }
}

function authState(config) {
  const key = hashKey(String(config.username).toLowerCase());
  let state = authStates.get(key);
  if (!state) {
    state = {
      key,
      uuid: deviceUuid(config),
      sessionId: '',
      scToken: '',
      scTokenSource: '',
      authPromise: null,
      lastKraRefreshAt: 0,
      lastKraRefreshOk: false,
      backoffUntil: 0,
      subscription: null,
      subscriptionAt: 0
    };
    authStates.set(key, state);
  }
  return state;
}

function apiHeaders(state, jsonBody = false) {
  return {
    'accept': 'application/json',
    'user-agent': USER_AGENT,
    'X-Uuid': state.uuid,
    ...(jsonBody ? { 'content-type': 'application/json' } : {})
  };
}

function retryAfterMs(headers) {
  const value = headers?.get?.('retry-after');
  if (!value) return RATE_LIMIT_BACKOFF_MS;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.max(1000, seconds * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(1000, at - Date.now()) : RATE_LIMIT_BACKOFF_MS;
}

function ensureNotBackedOff(state, service) {
  if (state.backoffUntil > Date.now()) {
    const seconds = Math.ceil((state.backoffUntil - Date.now()) / 1000);
    throw new ApiError(`${service} HTTP 429 - čakám ešte ${seconds}s, aby addon neposielal ďalšie požiadavky.`, { service, status: 429 });
  }
}

function observeRateLimit(state, service, response) {
  if (response.status === 429) {
    state.backoffUntil = Math.max(state.backoffUntil, Date.now() + retryAfterMs(response.headers));
  }
}

async function guardedJson(state, service, url, options = {}, timeoutMs = 20000) {
  ensureNotBackedOff(state, service);
  const r = await fetchJson(url, options, timeoutMs);
  observeRateLimit(state, service, r);
  return r;
}

function isAuthFailure(r) {
  const code = Number(r?.body?.error ?? r?.body?.code ?? 0);
  return r?.status === 401 || r?.status === 403 || [401, 403, 1001, 1002, 1003, 1005].includes(code);
}

function responseMessage(r, fallback) {
  return r?.body?.msg || r?.body?.message || r?.body?.error_message || fallback;
}

async function kraPost(state, endpoint, payload) {
  return guardedJson(state, 'KRA', new URL(endpoint, KRASKA_BASE), {
    method: 'POST',
    headers: apiHeaders(state, true),
    body: JSON.stringify(payload)
  });
}

async function kraLogin(config, state) {
  const r = await kraPost(state, 'api/user/login', {
    data: { username: config.username, password: config.password }
  });
  const sessionId = r.body?.session_id || r.body?.sessionId;
  if (!r.ok || !sessionId) {
    throw new ApiError(responseMessage(r, `KRA login HTTP ${r.status}`), { service: 'KRA', status: r.status, body: r.body });
  }
  state.sessionId = String(sessionId);
  state.scToken = '';
  state.scTokenSource = '';
  state.subscription = null;
  state.subscriptionAt = 0;
  return state.sessionId;
}

async function kraFileList(state) {
  const r = await kraPost(state, 'api/file/list', { data: {}, session_id: state.sessionId });
  if (!r.ok || r.body?.error) {
    if (isAuthFailure(r)) throw new ApiError('SESSION_EXPIRED', { service: 'KRA', status: r.status, body: r.body });
    return [];
  }
  return Array.isArray(r.body?.data) ? r.body.data : [];
}

async function kraDownloadLink(state, ident) {
  const r = await kraPost(state, 'api/file/download', { data: { ident }, session_id: state.sessionId });
  const link = r.body?.data?.link;
  if (!r.ok || !link) {
    if (isAuthFailure(r)) throw new ApiError('SESSION_EXPIRED', { service: 'KRA', status: r.status, body: r.body });
    throw new ApiError(responseMessage(r, `KRA resolve HTTP ${r.status}`), { service: 'KRA', status: r.status, body: r.body });
  }
  return String(link);
}

async function fetchScTokenFromBackup(state) {
  try {
    const files = await kraFileList(state);
    const matches = files.filter(x => x?.name === 'sc.json' && String(x?.ident || '').trim());
    if (matches.length !== 1) return null;
    const link = await kraDownloadLink(state, matches[0].ident);
    ensureNotBackedOff(state, 'KRA');
    const response = await fetch(link, {
      headers: { 'user-agent': USER_AGENT, 'X-Uuid': state.uuid }
    });
    if (!response.ok) return null;
    const token = (await response.text()).trim();
    return token.length === 32 ? token : null;
  } catch (err) {
    if (err instanceof ApiError && (err.status === 401 || err.status === 403 || err.message === 'SESSION_EXPIRED')) throw err;
    return null;
  }
}

async function deleteKraFile(state, ident) {
  try {
    await kraPost(state, 'api/file/delete', { data: { ident }, session_id: state.sessionId });
  } catch {}
}

function tusUploadUrl(location) {
  const s = String(location || '').trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  return 'https://upload.kra.sk' + s;
}

async function uploadScTokenBackupIfMissing(state, token) {
  if (String(token).length !== 32) return;
  let createdIdent = '';
  try {
    const create = await kraPost(state, 'api/file/create', {
      data: { name: 'sc.json' },
      shared: false,
      session_id: state.sessionId
    });
    if (Number(create.body?.error) === 1205) return;
    if (!create.ok || !create.body?.data) return;
    createdIdent = String(create.body.data.ident || '');
    const createLink = String(create.body.data.link || '');
    if (!createdIdent || !createLink) return;

    const createTus = await fetch(createLink, {
      method: 'POST',
      headers: {
        'Tus-Resumable': '1.0.0',
        'Upload-Metadata': `ident ${Buffer.from(createdIdent, 'utf8').toString('base64url')}`,
        'Upload-Length': String(Buffer.byteLength(token, 'utf8'))
      },
      body: Buffer.alloc(0)
    });
    if (createTus.status !== 201) {
      await deleteKraFile(state, createdIdent);
      return;
    }
    const location = createTus.headers.get('location') || '';
    const patchUrl = tusUploadUrl(location);
    if (!patchUrl) {
      await deleteKraFile(state, createdIdent);
      return;
    }
    const patch = await fetch(patchUrl, {
      method: 'PATCH',
      headers: {
        'Tus-Resumable': '1.0.0',
        'Upload-Offset': '0',
        'Content-Type': 'application/offset+octet-stream'
      },
      body: Buffer.from(token, 'utf8')
    });
    if (patch.status !== 204) await deleteKraFile(state, createdIdent);
  } catch {
    if (createdIdent) await deleteKraFile(state, createdIdent);
  }
}

async function scAuthToken(state, useBackup = true) {
  if (!state.sessionId) throw new ApiError('SESSION_EXPIRED', { service: 'KRA' });
  if (useBackup) {
    const backup = await fetchScTokenFromBackup(state);
    if (backup) {
      state.scToken = backup;
      state.scTokenSource = 'backup';
      return backup;
    }
  }

  const u = new URL('kodi/auth/token', SC_BASE);
  u.searchParams.set('krt', state.sessionId);
  u.searchParams.set('ver', '2.0');
  u.searchParams.set('uid', state.uuid);
  u.searchParams.set('lang', LANGUAGE);
  u.searchParams.set('skin', 'skin.estuary');
  u.searchParams.set('HDR', String(HDR));
  u.searchParams.set('DV', String(DV));
  u.searchParams.set('old', String(OLD_MENU));
  const r = await guardedJson(state, 'Stream Cinema', u, {
    method: 'POST',
    headers: apiHeaders(state, false)
  });
  const token = String(r.body?.token || '');
  if (!r.ok || !token) {
    if (r.status === 401 || r.status === 403) throw new ApiError('SESSION_EXPIRED', { service: 'Stream Cinema', status: r.status, body: r.body });
    throw new ApiError(responseMessage(r, `SC auth HTTP ${r.status}`), { service: 'Stream Cinema', status: r.status, body: r.body });
  }
  state.scToken = token;
  state.scTokenSource = 'auth';
  uploadScTokenBackupIfMissing(state, token).catch(() => {});
  return token;
}

async function withAuthLock(state, work) {
  if (state.authPromise) return state.authPromise;
  state.authPromise = (async () => work())();
  try { return await state.authPromise; }
  finally { state.authPromise = null; }
}

async function loginFlow(config, state) {
  await kraLogin(config, state);
  if (isScToken(config.scToken)) {
    state.scToken = String(config.scToken).trim();
    state.scTokenSource = 'manual';
  } else {
    await scAuthToken(state, true);
  }
  return state;
}

async function ensureAuth(config) {
  const state = authState(config);
  if (state.sessionId && state.scToken) return state;
  return withAuthLock(state, async () => {
    if (state.sessionId && state.scToken) return state;
    return loginFlow(config, state);
  });
}

async function refreshScToken(config, state = authState(config)) {
  return withAuthLock(state, async () => {
    if (!state.sessionId) return refreshKraSession(config, state, 'missing KRA session');
    if (isScToken(config.scToken)) {
      state.scToken = String(config.scToken).trim();
      state.scTokenSource = 'manual';
      return state;
    }
    state.scToken = '';
    state.scTokenSource = '';
    try {
      await scAuthToken(state, false);
      return state;
    } catch (err) {
      if (err instanceof ApiError && (err.status === 401 || err.status === 403 || err.message === 'SESSION_EXPIRED')) {
        return refreshKraSessionUnlocked(config, state, 'SC token refresh reported expired KRA session');
      }
      throw err;
    }
  });
}

async function refreshKraSessionUnlocked(config, state, reason = '') {
  const now = Date.now();
  if (now - state.lastKraRefreshAt < KRA_REFRESH_COOLDOWN_MS) {
    if (state.lastKraRefreshOk && state.sessionId && state.scToken) return state;
    throw new ApiError('SESSION_REFRESH_COOLDOWN', { service: 'KRA' });
  }
  state.lastKraRefreshAt = now;
  state.lastKraRefreshOk = false;
  state.sessionId = '';
  state.scToken = '';
  state.scTokenSource = '';
  state.subscription = null;
  state.subscriptionAt = 0;
  try {
    await kraLogin(config, state);
    if (isScToken(config.scToken)) {
      state.scToken = String(config.scToken).trim();
      state.scTokenSource = 'manual';
    } else {
      await scAuthToken(state, true);
    }
    state.lastKraRefreshOk = true;
    return state;
  } catch (err) {
    state.lastKraRefreshOk = false;
    throw err;
  }
}

async function refreshKraSession(config, state = authState(config), reason = '') {
  return withAuthLock(state, () => refreshKraSessionUnlocked(config, state, reason));
}

function replaceWs2Token(path, token) {
  if (!path.startsWith('/ws2/') || !token) return path;
  const parts = path.split('/');
  if (parts.length >= 4 && parts[1] === 'ws2') {
    parts[2] = token;
    return parts.join('/');
  }
  return path;
}

function buildScUrl(path, auth) {
  let p = String(path || '/');
  if (/^https?:\/\//i.test(p)) {
    const absolute = new URL(p);
    if (absolute.hostname !== new URL(SC_BASE).hostname) throw new Error('Unexpected Stream Cinema host');
    p = absolute.pathname + absolute.search;
  }
  p = replaceWs2Token(p, auth.scToken);
  if (!p.startsWith('/')) p = '/' + p;
  if (!p.startsWith('/kodi/')) p = '/kodi' + p;
  const u = new URL(p, SC_BASE);
  u.searchParams.set('uid', auth.uuid);
  u.searchParams.set('ver', '2.0');
  u.searchParams.set('DV', String(DV));
  u.searchParams.set('HDR', String(HDR));
  u.searchParams.set('lang', LANGUAGE);
  u.searchParams.set('old', String(OLD_MENU));
  u.searchParams.set('skin', 'skin.estuary');
  return u;
}

async function scGet(config, path, retried = false) {
  const cacheKey = hashKey(config.username + '|sc|' + path);
  if (!retried) {
    const c = responseCache.get(cacheKey);
    if (c && Date.now() - c.at < CACHE_TTL_MS) return c.body;
  }
  let state = await ensureAuth(config);
  let r = await guardedJson(state, 'Stream Cinema', buildScUrl(path, state), {
    headers: { ...apiHeaders(state, false), 'X-AUTH-TOKEN': state.scToken }
  });
  if ((r.status === 401 || r.status === 403) && !retried) {
    state = await refreshScToken(config, state);
    r = await guardedJson(state, 'Stream Cinema', buildScUrl(path, state), {
      headers: { ...apiHeaders(state, false), 'X-AUTH-TOKEN': state.scToken }
    });
  }
  if (!r.ok) {
    if (r.status === 404) {
      throw new ApiError('Stream Cinema auth token is not validated (HTTP 404). Use a valid 32-character SC Auth token in /configure.', { service: 'Stream Cinema', status: 401, body: r.body });
    }
    throw new ApiError(`SC HTTP ${r.status} for ${String(path).slice(0, 120)}`, { service: 'Stream Cinema', status: r.status, body: r.body });
  }
  if (!r.body || typeof r.body !== 'object') throw new Error('SC returned an empty/non-JSON response');
  responseCache.set(cacheKey, { at: Date.now(), body: r.body });
  return r.body;
}

async function scSearch(config, searchId, query) {
  const path = `/Search/${encodeURIComponent(searchId)}?search=${encodeURIComponent(query)}`;
  return scGet(config, path);
}

function modPow(base, exp, mod) {
  let result = 1n;
  base %= mod;
  while (exp > 0n) {
    if (exp & 1n) result = (result * base) % mod;
    exp >>= 1n;
    base = (base * base) % mod;
  }
  return result;
}

function base64UrlToBuffer(s) {
  return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function bufferToBigInt(buf) {
  return BigInt('0x' + Buffer.from(buf).toString('hex'));
}

function bigIntToBuffer(n, len) {
  let h = n.toString(16);
  if (h.length % 2) h = '0' + h;
  let b = Buffer.from(h, 'hex');
  if (len && b.length < len) b = Buffer.concat([Buffer.alloc(len - b.length), b]);
  return b;
}

const RSA_N = BigInt('0xC6A77A0A3436A24B49869F76BE507978827C0D7A1D9B3E2BF57D0AB3BC0E5FBD19F191559A2FC667C344142D230D48150C0A7B1D976924730456822553CD771D4E38E4B30DDF7384F7DDF51780ED359885BB4BFDF1B58458B15104966568DAF89BC5D4DA0895094DE65E5079B96F5ACB36AA28A52DA8B5863249A254EF1CA05DE26CF92352B9CD10564B3C08B16BC6405DBA43E044B9DAAC79028A1FCF1F09FB5E6DD2643B66B714D07D71B71A531225B782B52733BD5D6758A593D9C9D48F6F3A5BC505904785C821214296F554C292D022B06D12B25C9402E8A5BD4C3E5610753546082E1BBC5A8DA17A0DF88AB39ECDF9F2FBE6AC13683928661009734E1');
const RSA_E = 65537n;

function recoverSignedIdent(input) {
  try {
    const sig = base64UrlToBuffer(input);
    const k = Math.ceil(RSA_N.toString(2).length / 8);
    const m = modPow(bufferToBigInt(sig), RSA_E, RSA_N);
    const em = bigIntToBuffer(m, k);
    if (em[0] !== 0 || em[1] !== 1) return null;
    let i = 2;
    while (i < em.length && em[i] === 0xff) i++;
    if (em[i++] !== 0) return null;
    const data = em.subarray(i).toString('utf8');
    const mIdent = data.match(/(?:^|[|;\s])(?:ident|id)=([A-Za-z0-9_-]+)/i);
    if (mIdent) return mIdent[1];
    if (/^[A-Za-z0-9_-]{4,}$/.test(data)) return data;
    return null;
  } catch { return null; }
}

function decryptStreamCinemaIdent(v) {
  const s = String(v || '');
  if (s.startsWith('v0:')) return s.slice(3);
  if (/^v\d+:/.test(s)) return null;
  return s || null;
}

function versionIdent(s) {
  const version = Number(s?.version || 0);
  if (version === 0) return decryptStreamCinemaIdent(s?.url || s?.sid || s?.ident || '');
  const signed = s?.[`v${version}`];
  if (!signed) return null;
  return recoverSignedIdent(String(signed));
}

function stripKodi(v) {
  return String(v ?? '').replace(/\[\/?(?:COLOR|B|I|LIGHT)[^\]]*\]/gi, '').trim();
}

function firstValue(o, keys) {
  for (const k of keys) if (o?.[k]) return o[k];
  return undefined;
}

function asYear(v) {
  const m = String(v || '').match(/(?:19|20)\d{2}/);
  return m ? Number(m[0]) : undefined;
}

function asArray(v) {
  if (Array.isArray(v)) return v.filter(Boolean).map(stripKodi);
  if (typeof v === 'string') return v.split(/\s*[|,/]\s*/).filter(Boolean).map(stripKodi);
  return undefined;
}

function itemInfo(item) {
  return item?.info && typeof item.info === 'object' ? item.info : item || {};
}

function itemArt(item) {
  return item?.art && typeof item.art === 'object' ? item.art : {};
}

function imdbId(item) {
  const sources = [item?.unique_ids, item?.uniqueIds, item?.ids, itemInfo(item)?.unique_ids, itemInfo(item)?.uniqueIds, itemInfo(item)?.ids];
  for (const s of sources) {
    if (!s || typeof s !== 'object') continue;
    for (const [k, v] of Object.entries(s)) {
      if (/imdb/i.test(k)) {
        const m = String(v).match(/tt\d{5,}/);
        if (m) return m[0];
      }
    }
  }
  return undefined;
}

function itemPath(item) {
  if (item?.url) return String(item.url);
  if (item?.ident) return `/Play/${item.ident}`;
  return null;
}

function metaFromItem(item, type, forcedId = null) {
  const info = itemInfo(item);
  const art = itemArt(item);
  const path = itemPath(item);
  const title = stripKodi(info.title || item?.title || item?.name || 'Bez názvu');
  const year = asYear(info.year ?? info.yearRaw ?? item?.year);
  const id = forcedId || encodeId({ p: path, t: type, n: title, y: year || null });
  const meta = {
    id,
    type,
    name: title,
    poster: firstValue(art, ['poster', 'posterUrl', 'thumb', 'thumbnail', 'icon']) || undefined,
    background: firstValue(art, ['fanart', 'background', 'fanartUrl']) || undefined,
    description: stripKodi(info.plot || item?.plot || '') || undefined,
    releaseInfo: year ? String(year) : undefined,
    genres: asArray(info.genre ?? info.genreRaw),
    imdbRating: info.rating != null ? String(info.rating) : undefined,
    runtime: info.duration ? `${info.duration} min` : undefined,
    director: asArray(info.director ?? info.directorRaw),
    cast: Array.isArray(item?.cast) ? item.cast.map(x => x?.name).filter(Boolean) : undefined,
    imdb_id: imdbId(item)
  };
  return Object.fromEntries(Object.entries(meta).filter(([,v]) => v !== undefined && v !== null && v !== ''));
}

function parseExtra(extraSegment, searchParams) {
  const params = new URLSearchParams();
  if (extraSegment) {
    const raw = decodeURIComponent(extraSegment.replace(/\.json$/, ''));
    for (const [k,v] of new URLSearchParams(raw)) params.set(k,v);
  }
  for (const [k,v] of searchParams) params.set(k,v);
  return params;
}

function likelyPlayable(item) {
  const t = String(item?.type || '').toLowerCase();
  const u = String(item?.url || '');
  return !!item?.ident || u.includes('/Play/') || ['video','play','movie','episode','file'].includes(t);
}

function likelyDirectory(item) {
  return String(item?.type || '').toLowerCase() === 'dir' || (!!item?.url && !likelyPlayable(item));
}

function parseSeasonEpisode(title, url, fallbackEpisode = 1, seasonHint = 1) {
  const s = `${title || ''} ${url || ''}`;
  let m = s.match(/S(\d{1,3})\s*E(\d{1,4})/i) || s.match(/(\d{1,3})x(\d{1,4})/i);
  if (m) return { season: Number(m[1]), episode: Number(m[2]) };
  m = s.match(/season[^\d]*(\d{1,3}).*episode[^\d]*(\d{1,4})/i);
  if (m) return { season: Number(m[1]), episode: Number(m[2]) };
  m = String(title || '').match(/(?:ep(?:isode)?|diel|část|cast)[^\d]*(\d{1,4})/i);
  return { season: seasonHint || 1, episode: m ? Number(m[1]) : fallbackEpisode };
}

function parseSeasonHint(title, fallback) {
  const m = String(title || '').match(/(?:season|séria|seria|série|serie|S)[^\d]*(\d{1,3})/i);
  return m ? Number(m[1]) : fallback;
}

async function collectSeriesVideos(config, response) {
  const videos = [];
  const root = Array.isArray(response?.menu) ? response.menu : [];
  const addItems = (items, seasonHint = 1) => {
    let epFallback = 1;
    for (const item of items) {
      if (!likelyPlayable(item)) continue;
      const p = itemPath(item);
      if (!p) continue;
      const title = stripKodi(itemInfo(item).title || item.title || `Epizóda ${epFallback}`);
      const se = parseSeasonEpisode(title, p, epFallback++, seasonHint);
      videos.push({
        id: encodeId({ p, t: 'series', n: title, s: se.season, e: se.episode }),
        title,
        season: se.season,
        episode: se.episode,
        released: undefined
      });
    }
  };

  addItems(root, 1);
  if (videos.length) return videos;

  const seasons = root.filter(likelyDirectory).slice(0, MAX_SEASONS);
  for (let i = 0; i < seasons.length; i++) {
    const seasonItem = seasons[i];
    const p = itemPath(seasonItem);
    if (!p) continue;
    try {
      const seasonResponse = await scGet(config, p);
      addItems(Array.isArray(seasonResponse?.menu) ? seasonResponse.menu : [], parseSeasonHint(seasonItem.title, i + 1));
    } catch {}
  }
  return videos;
}

async function resolveStreamResponse(config, path, depth = 0) {
  if (!path || depth > 3) return null;
  const r = await scGet(config, path);
  if (Array.isArray(r?.strms) && r.strms.length) return r;
  const menu = Array.isArray(r?.menu) ? r.menu : [];
  const candidate = menu.find(likelyPlayable) || menu.find(x => itemPath(x));
  if (candidate) return resolveStreamResponse(config, itemPath(candidate), depth + 1);
  return r;
}

function audioLanguage(s) {
  const primary = stripKodi(s?.lang || '');
  const text = `${primary} ${s?.ainfo || ''} ${s?.title || ''} ${s?.name || ''}`.toLowerCase();
  const tests = [
    [/\b(cz|cs|cze|czech|cesky|česky|čeština|cesky dabing|český dabing)\b/i, { flag: '🇨🇿', code: 'CZ' }],
    [/\b(sk|slk|slo|slovak|slovensky|slovenčina|slovensky dabing|slovenský dabing)\b/i, { flag: '🇸🇰', code: 'SK' }],
    [/\b(en|eng|english)\b/i, { flag: '🇬🇧', code: 'EN' }],
    [/\b(de|ger|deu|german|deutsch)\b/i, { flag: '🇩🇪', code: 'DE' }],
    [/\b(pl|pol|polish|polski)\b/i, { flag: '🇵🇱', code: 'PL' }],
    [/\b(hu|hun|hungarian|magyar)\b/i, { flag: '🇭🇺', code: 'HU' }]
  ];
  for (const [re, value] of tests) if (re.test(text)) return value;
  return primary ? { flag: '🌐', code: primary.toUpperCase() } : { flag: '🌐', code: 'AUDIO' };
}

function streamProviderName(s) {
  const p = stripKodi(s?.provider || '');
  if (!p) return 'Stream Cinema';
  if (/^kraska$/i.test(p)) return 'KRA';
  return p;
}

function streamLabel(s) {
  const lang = audioLanguage(s);
  const details = [s?.quality, s?.ainfo, s?.vinfo, s?.size].filter(Boolean).map(stripKodi);
  return [`${lang.flag} ${lang.code}`, ...details].join(' • ');
}

function fallbackStreamId(type, payload, response) {
  const imdb = imdbId(response?.info) || imdbId(response) || imdbId(response?.menu?.[0]);
  if (!imdb) return null;
  if (type === 'series') {
    const nested = response?.info?.info || {};
    const season = Number(payload?.s ?? nested?.season ?? 0);
    const episode = Number(payload?.e ?? nested?.episode ?? 0);
    if (season > 0 && episode > 0) return `${imdb}:${season}:${episode}`;
  }
  return imdb;
}

function fallbackProviderName(stream) {
  const text = `${stream?.name || ''} ${stream?.title || ''} ${stream?.behaviorHints?.filename || ''}`;
  if (/\bwebshare\b/i.test(text) || /\[webshare\]/i.test(text)) return 'Webshare';
  if (/\bfastshare\b/i.test(text) || /\[fastshare\]/i.test(text)) return 'FastShare';
  return 'FastShare/Webshare';
}

function decorateFallbackStream(stream) {
  const url = String(stream?.url || '');
  if (!/^https?:\/\//i.test(url)) return null;
  const text = `${stream?.name || ''} ${stream?.title || ''} ${stream?.behaviorHints?.filename || ''}`;
  const lang = audioLanguage({ ainfo: text, title: text, name: text });
  const provider = fallbackProviderName(stream);
  return {
    ...stream,
    url,
    name: `${lang.flag} ${lang.code} • ${provider}`,
    title: stream?.title || text || provider,
    behaviorHints: { ...(stream?.behaviorHints || {}), notWebReady: false }
  };
}

async function fetchFallbackStreams(type, id) {
  if (!FALLBACK_ADDON_BASE || !id) return [];
  try {
    const url = `${FALLBACK_ADDON_BASE}/stream/${encodeURIComponent(type)}/${encodeURIComponent(id)}.json`;
    const r = await fetchJson(url, { headers: { accept: 'application/json', 'user-agent': USER_AGENT } }, 12000);
    if (!r.ok || !Array.isArray(r.body?.streams)) return [];
    return r.body.streams.map(decorateFallbackStream).filter(Boolean);
  } catch {
    return [];
  }
}

function streamRank(s) {
  const text = `${s?.quality || ''} ${s?.ainfo || ''} ${s?.vinfo || ''} ${s?.title || ''} ${s?.name || ''}`.toLowerCase();
  let score = 0;
  if (/2160|4k|uhd/.test(text)) score += 50;
  else if (/1080/.test(text)) score += 35;
  else if (/720/.test(text)) score += 20;
  if (/cz|cs|czech|čes|sk|slovak|sloven/.test(text)) score += 15;
  if (/atmos|truehd|dts.?hd|dts:x|eac3|ddp/.test(text)) score += 5;
  if (/kraska/i.test(String(s?.provider || ''))) score += 3;
  return score;
}

async function subscription(state) {
  if (state.subscription && Date.now() - state.subscriptionAt < 300000) return state.subscription;
  const r = await kraPost(state, 'api/user/info', { data: {}, session_id: state.sessionId });
  if (!r.ok || r.body?.error) {
    if (isAuthFailure(r)) throw new ApiError('SESSION_EXPIRED', { service: 'KRA', status: r.status, body: r.body });
    throw new ApiError(responseMessage(r, `KRA subscription HTTP ${r.status}`), { service: 'KRA', status: r.status, body: r.body });
  }
  state.subscription = r.body?.data || {};
  state.subscriptionAt = Date.now();
  return state.subscription;
}

async function checkSubscription(config, state = authState(config), force = false) {
  if (force) { state.subscription = null; state.subscriptionAt = 0; }
  const s = await subscription(state);
  const daysLeft = Number(s?.days_left ?? s?.daysLeft ?? 0);
  return { active: daysLeft > 0 || !!s?.subscribed_until, daysLeft, raw: s };
}

async function resolveKraIdent(config, state, ident) {
  try {
    return await kraDownloadLink(state, ident);
  } catch (err) {
    if (err instanceof ApiError && err.message === 'SESSION_EXPIRED') {
      const refreshed = await refreshKraSession(config, state, 'KRA stream resolve expired');
      return kraDownloadLink(refreshed, ident);
    }
    throw err;
  }
}

async function resolveOneStream(config, s) {
  const provider = String(s?.provider || '').toLowerCase();
  if (provider !== 'kraska') {
    const direct = String(s?.url || '');
    if (!/^https?:\/\//i.test(direct)) return null;
    return {
      url: direct,
      name: `${audioLanguage(s).flag} ${audioLanguage(s).code} • ${streamProviderName(s)}`,
      title: streamLabel(s),
      behaviorHints: { notWebReady: false }
    };
  }
  let state = await ensureAuth(config);
  let path = String(s?.url || '');
  if (!path) return null;
  let detail = await scGet(config, path);
  const v = Array.isArray(detail?.strms) ? detail.strms[0] : detail;
  const ident = versionIdent(v) || decryptStreamCinemaIdent(v?.ident || v?.sid || v?.url || '');
  if (!ident) return null;
  const sub = await checkSubscription(config, state);
  if (!sub.active) throw new ApiError('KRA subscription is inactive', { service: 'KRA', status: 403 });
  const url = await resolveKraIdent(config, state, ident);
  return {
    url,
    name: `${audioLanguage(s).flag} ${audioLanguage(s).code} • KRA`,
    title: streamLabel(s),
    behaviorHints: { notWebReady: false }
  };
}

function pageFromExtra(extra) {
  const skip = Number(extra.get('skip') || 0);
  const limit = Number(extra.get('limit') || CATALOG_PAGE);
  return Math.floor(skip / Math.max(1, limit)) + 1;
}

function catalogPath(catalog, extra) {
  let path = catalog.path;
  const u = new URL(path, 'https://x.invalid');
  const page = pageFromExtra(extra);
  u.searchParams.set('page', String(page));
  u.searchParams.set('limit', String(CATALOG_PAGE));
  if (extra.get('search')) u.searchParams.set('search', extra.get('search'));
  return u.pathname + '?' + u.searchParams.toString();
}

async function catalogMetas(config, catalog, extra) {
  const response = await scGet(config, catalogPath(catalog, extra));
  const menu = Array.isArray(response?.menu) ? response.menu : [];
  const metas = [];
  for (const item of menu) {
    const p = itemPath(item);
    if (!p) continue;
    metas.push(metaFromItem(item, catalog.type));
    if (metas.length >= CATALOG_PAGE) break;
  }
  return metas;
}

async function metaFor(config, type, id) {
  const payload = decodeId(id);
  if (!payload.p) return null;
  const response = await scGet(config, payload.p);
  const item = response?.info || response?.menu?.[0] || {};
  const meta = metaFromItem(item, type, id);
  if (type === 'series') {
    const videos = await collectSeriesVideos(config, response);
    if (videos.length) meta.videos = videos;
  }
  return meta;
}

function manifest(configured) {
  return {
    id: 'community.scjc.nuvio.bridge',
    version: VERSION,
    name: 'SCJC Nuvio Bridge',
    description: 'KRA / Stream Cinema catalogs and streams for Nuvio/Stremio-compatible clients.',
    resources: [
      { name: 'catalog', types: ['movie','series'], idPrefixes: ['scjc:'] },
      { name: 'meta', types: ['movie','series'], idPrefixes: ['scjc:'] },
      { name: 'stream', types: ['movie','series'], idPrefixes: ['scjc:'] }
    ],
    types: ['movie','series'],
    catalogs: CATALOGS.map(c => ({
      id: c.id,
      type: c.type,
      name: c.name,
      extra: [{ name: 'skip', isRequired: false }, { name: 'search', isRequired: false }]
    })),
    idPrefixes: ['scjc:'],
    behaviorHints: { configurable: true, configurationRequired: !configured }
  };
}

function configFromRequest(pathname) {
  const parts = pathname.split('/').filter(Boolean);
  const roots = new Set(['manifest.json','catalog','meta','stream','health','configure']);
  let token = null;
  let rest = parts;
  if (parts.length && !roots.has(parts[0])) {
    token = parts[0];
    rest = parts.slice(1);
  }
  if (token) return { config: decryptConfig(token), parts: rest, token };
  const cfg = envConfig();
  if (cfg) return { config: cfg, parts: rest, token: null };
  throw new Error('Addon is not configured. Open /configure or set KRASKA_USERNAME/KRASKA_PASSWORD.');
}

function configurePage(req, resultHtml = '') {
  const host = req.headers.host || `localhost:${PORT}`;
  const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0];
  const secureAvailable = !!configKey();
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SCJC Nuvio Bridge</title><style>body{font-family:system-ui;max-width:760px;margin:40px auto;padding:0 18px;background:#111;color:#eee}input,button{font:inherit;padding:12px;width:100%;box-sizing:border-box;margin:6px 0 16px;border-radius:8px;border:1px solid #444;background:#1b1b1b;color:#fff}button{cursor:pointer;background:#2b5cff}code{word-break:break-all;background:#222;padding:2px 5px;border-radius:4px}.ok{padding:14px;background:#16391f;border-radius:10px}.warn{padding:14px;background:#4b3212;border-radius:10px}a{color:#8ab4ff}</style></head><body><h1>SCJC Nuvio Bridge</h1><p>Addon používa iba tvoje vlastné KRA/Stream Cinema prihlásenie. Heslo sa neukladá do databázy; pri konfigurátore je zašifrované v install tokene pomocou <code>CONFIG_SECRET</code>.</p>${resultHtml}${secureAvailable ? `<form method="post" action="/configure"><label>KRA username</label><input name="username" required autocomplete="username"><label>KRA password</label><input name="password" type="password" required autocomplete="current-password"><label>SC Auth token (voliteľné, 32 znakov)</label><input name="scToken" autocomplete="off" maxlength="32" placeholder="Použi validný token z fungujúceho Stream Cinema klienta"><small>Ak ho necháš prázdny, addon skúsi sc.json z KRA. Nový token pri HTTP 404 automaticky nevytvára, aby nevznikol nevalidovaný login.</small><button type="submit">Vytvoriť manifest URL</button></form>` : `<div class="warn">CONFIG_SECRET nie je nastavený. Na Renderi ho pridaj ako Secret env premennú, alebo nastav KRASKA_USERNAME/KRASKA_PASSWORD a použi <code>${proto}://${host}/manifest.json</code>.</div>`}<p><a href="/health">Health</a></p></body></html>`;
}

async function handle(req, res) {
  try {
    const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,OPTIONS' });
      return res.end();
    }

    if (u.pathname === '/' || u.pathname === '/configure') {
      if (req.method === 'POST') {
        let body = '';
        for await (const chunk of req) body += chunk;
        const form = new URLSearchParams(body);
        const username = (form.get('username') || '').trim();
        const password = form.get('password') || '';
        const scToken = (form.get('scToken') || '').trim();
        if (!username || !password) return html(res, 400, configurePage(req, '<div class="warn">Chýba username alebo password.</div>'));
        if (scToken && !isScToken(scToken)) return html(res, 400, configurePage(req, '<div class="warn">SC Auth token musí mať presne 32 znakov bez medzier.</div>'));
        const token = encryptConfig({ username, password, scUuid: newScUuid(), ...(scToken ? { scToken } : {}) });
        const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0];
        const base = `${proto}://${req.headers.host}`;
        const manifestUrl = `${base}/${token}/manifest.json`;
        return html(res, 200, configurePage(req, `<div class="ok"><b>Manifest URL:</b><br><code>${manifestUrl}</code><p>V Nuvio pridaj tento manifest ako Stremio-compatible addon.</p></div>`));
      }
      return html(res, 200, configurePage(req));
    }

    if (u.pathname === '/health') {
      return json(res, 200, { ok: true, version: VERSION, node: process.version, configSecurity: configKey() ? 'encrypted' : 'env', at: new Date().toISOString() });
    }

    const { config, parts, token } = configFromRequest(u.pathname);
    const route = parts[0] || 'manifest.json';

    if (route === 'health') {
      const deep = u.searchParams.get('deep') === '1';
      const out = { ok: true, version: VERSION, node: process.version, configSecurity: configKey() ? 'encrypted' : 'env', configuredByToken: !!token, at: new Date().toISOString() };
      if (deep) {
        const state = await ensureAuth(config);
        const sub = await checkSubscription(config, state, true);
        out.auth = { ok: true, uuid: state.uuid, tokenLength: String(state.scToken || '').length, tokenSource: state.scTokenSource, subscriptionActive: sub.active, daysLeft: sub.daysLeft };
      }
      return json(res, 200, out);
    }

    if (route === 'manifest.json') {
      const configured = !!token || !!envConfig();
      return json(res, 200, manifest(configured), { 'cache-control': 'public, max-age=300' });
    }

    if (route === 'catalog') {
      const type = parts[1];
      const id = decodeURIComponent(String(parts[2] || '')).replace(/\.json$/, '');
      const catalog = catalogMap.get(id);
      if (!catalog || catalog.type !== type) return json(res, 200, { metas: [] });
      const extra = parseExtra(parts[3], u.searchParams);
      if (extra.get('search')) {
        const searchId = type === 'series' ? 'search-series' : 'search-movie';
        const response = await scSearch(config, searchId, extra.get('search'));
        const menu = Array.isArray(response?.menu) ? response.menu : [];
        return json(res, 200, { metas: menu.map(x => metaFromItem(x, type)).slice(0, CATALOG_PAGE) });
      }
      return json(res, 200, { metas: await catalogMetas(config, catalog, extra) });
    }

    if (route === 'meta') {
      const type = parts[1];
      const id = decodeURIComponent(String(parts[2] || '').replace(/\.json$/, ''));
      const meta = await metaFor(config, type, id);
      return json(res, 200, { meta });
    }

    if (route === 'stream') {
      const type = parts[1];
      const id = decodeURIComponent(String(parts[2] || '').replace(/\.json$/, ''));
      const payload = decodeId(id);
      if (!payload.p) return json(res, 200, { streams: [] });
      const response = await resolveStreamResponse(config, payload.p);
      const fallbackId = fallbackStreamId(type, payload, response);
      const fallbackPromise = fallbackId ? fetchFallbackStreams(type, fallbackId) : Promise.resolve([]);
      const raw = Array.isArray(response?.strms) ? response.strms.slice().sort((a,b) => streamRank(b) - streamRank(a)) : [];
      const seen = new Set();
      const candidateLimit = Math.max(MAX_STREAMS * 4, 24);
      const candidates = raw.slice(0, candidateLimit);

      const altCandidates = candidates.filter(s => {
        const provider = String(s?.provider || '').toLowerCase();
        return provider !== 'kraska' && /^https?:\/\//i.test(String(s?.url || ''));
      }).slice(0, Math.min(3, MAX_STREAMS));
      const altResolved = [];
      for (const s of altCandidates) {
        try {
          const resolved = await resolveOneStream(config, s);
          if (!resolved?.url || seen.has(resolved.url)) continue;
          seen.add(resolved.url);
          altResolved.push(resolved);
        } catch {}
      }

      const primary = [];
      const primaryLimit = Math.max(0, MAX_STREAMS - altResolved.length);
      for (const s of candidates) {
        if (primary.length >= primaryLimit) break;
        try {
          const resolved = await resolveOneStream(config, s);
          if (!resolved?.url || seen.has(resolved.url)) continue;
          seen.add(resolved.url);
          primary.push(resolved);
        } catch {}
      }

      const scResolved = [...primary, ...altResolved].slice(0, MAX_STREAMS);
      const fallbackRaw = await fallbackPromise;
      const fallbackResolved = [];
      for (const stream of fallbackRaw) {
        if (!stream?.url || seen.has(stream.url)) continue;
        seen.add(stream.url);
        fallbackResolved.push(stream);
      }

      if (!fallbackResolved.length) return json(res, 200, { streams: scResolved });

      const reserved = Math.min(FALLBACK_RESERVED_SLOTS, fallbackResolved.length, MAX_STREAMS);
      const scKeep = scResolved.slice(0, Math.max(0, MAX_STREAMS - reserved));
      const fallbackKeep = fallbackResolved.slice(0, Math.max(0, MAX_STREAMS - scKeep.length));
      return json(res, 200, { streams: [...scKeep, ...fallbackKeep] });
    }

    return json(res, 404, { error: 'not found', path: u.pathname });
  } catch (err) {
    const message = err?.message || String(err);
    const status = err instanceof ApiError && err.status >= 400 && err.status < 600 ? err.status : 500;
    return json(res, status, { ok: false, error: message, service: err?.service || undefined });
  }
}

if (require.main === module) {
  http.createServer(handle).listen(PORT, '0.0.0.0', () => {
    console.log(`SCJC Nuvio Bridge v${VERSION} listening on :${PORT}`);
  });
}

module.exports = {
  encodeId,
  decodeId,
  buildScUrl,
  decryptStreamCinemaIdent,
  recoverSignedIdent,
  versionIdent,
  replaceWs2Token,
  manifest,
  isScUuid,
  isScToken,
  newScUuid,
  deviceUuid,
  retryAfterMs,
  isAuthFailure,
  fallbackStreamId,
  decorateFallbackStream
};
