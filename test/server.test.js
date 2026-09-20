'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const addon = require('../server');

test('manifest exposes only SCJC extension catalogs and never duplicates club.cder resources', () => {
  const manifest = addon.manifest();
  const ids = manifest.catalogs.map(c => c.id);
  const resources = manifest.resources.map(r => r.name);

  assert.equal(manifest.version, '2.8.0');
  assert.deepEqual(resources, ['catalog']);

  assert.equal(ids.includes('sc-movie-latest'), false);
  assert.equal(ids.includes('sc-series-latest'), false);
  assert.equal(ids.includes('sc-movie-popular'), false);
  assert.equal(ids.includes('sc-series-popular'), false);

  assert.ok(ids.includes('scx-movie-dubbed-latest'));
  assert.ok(ids.includes('scx-series-dubbed-latest'));
  assert.ok(ids.includes('scx-search-movies'));
  assert.ok(ids.includes('scx-search-series'));
  assert.ok(ids.includes('scx-search-concerts'));
  assert.ok(ids.includes('scx-concerts'));

  const search = manifest.catalogs.find(c => c.id === 'scx-search-movies');
  assert.deepEqual(search.extra.map(x => x.name), ['search', 'skip']);
  assert.equal(search.extra[0].isRequired, true);
});

test('old configured paths remain compatible', () => {
  assert.equal(
    addon.routeContext('/oldEncryptedToken/catalog/movie/sc-movie-latest.json'),
    '/catalog/movie/sc-movie-latest.json'
  );
  assert.equal(addon.routeContext('/manifest.json'), '/manifest.json');
});

test('catalog items are standardized to IMDb IDs while preserving cder source mapping', () => {
  const input = {
    metas:[{
      id:'sc71394',
      type:'movie',
      name:'The Odyssey - EN',
      background:'https://images.metahub.space/background/medium/tt33764258/img'
    }]
  };

  const output = addon.standardizeCatalogBody('movie', input);
  assert.equal(output.metas[0].id, 'tt33764258');
  assert.equal(output.metas[0].imdb_id, 'tt33764258');
  assert.equal(addon.cderSourceId('movie', 'tt33764258'), 'sc71394');
});

test('series episode video IDs are standardized to IMDb season episode IDs', () => {
  const videos = addon.standardizeVideos([
    { id:'sc123:1:1', title:'Episode 1' },
    { id:'sc123:2:4', title:'Episode 4' }
  ], 'tt1234567');

  assert.equal(videos[0].id, 'tt1234567:1:1');
  assert.equal(videos[1].id, 'tt1234567:2:4');
});

test('CZ/SK dubbing ranks before larger English files', () => {
  const GB = 1024 ** 3;
  const streams = addon.mergeAndSortStreams([
    {
      url:'https://example.test/en',
      description:'EN audio 4K',
      behaviorHints:{ videoSize:30 * GB }
    },
    {
      url:'https://example.test/cz-small',
      description:'CZ audio 1080p',
      behaviorHints:{ videoSize:10 * GB }
    },
    {
      url:'https://example.test/cz-large',
      description:'CZ audio 1080p',
      behaviorHints:{ videoSize:20 * GB }
    }
  ]);

  assert.equal(streams[0].url, 'https://example.test/cz-large');
  assert.equal(streams[1].url, 'https://example.test/cz-small');
  assert.equal(streams[2].url, 'https://example.test/en');
  assert.match(streams[0].name, /🇨🇿/);
  assert.match(streams[0].title, /20\.0 GB/);
});

test('CZ subtitles are not mistaken for CZ dubbing', () => {
  const subtitles = addon.streamLanguage({ description:'CZ titulky / EN audio' });
  const dubbing = addon.streamLanguage({ description:'CZ audio / EN subs' });

  assert.equal(subtitles.label, 'EN');
  assert.equal(subtitles.dubbed, false);
  assert.equal(dubbing.label, 'CZ');
  assert.equal(dubbing.dubbed, true);
});

test('stream feature parser adds modern video and audio badges', () => {
  const features = addon.streamFeatures({
    title:'2160p Dolby Vision Atmos HEVC'
  });

  assert.deepEqual(features, ['DV', 'Atmos', 'HEVC']);
  assert.equal(addon.streamQuality({ title:'2160p Dolby Vision' }), '4K');
});

test('concert detector recognizes live concert titles', () => {
  assert.equal(addon.isConcertLike({ name:'Sting: Live at the Olympia Paris' }), true);
  assert.equal(addon.isConcertLike({ name:'Ordinary dramatic movie' }), false);
});

test('search catalog path is encoded and paginated correctly', () => {
  assert.equal(
    addon.upstreamCatalogPath('movie', 'sc-movie-popular', 100, null, 'Sting Live'),
    '/catalog/movie/sc-movie-popular/search=Sting%20Live&skip=100.json'
  );
});

test('bounded TTL cache evicts oldest entries and can retain stale values', () => {
  const cache = new addon.TTLCache(2);
  cache.set('a', 1, -1);
  cache.set('b', 2, 60_000);
  cache.set('c', 3, 60_000);

  assert.equal(cache.size, 2);
  assert.equal(cache.getStale('a'), undefined);
  assert.equal(cache.getFresh('b'), 2);
  assert.equal(cache.getFresh('c'), 3);

  const stale = new addon.TTLCache(2);
  stale.set('expired', 9, -1);
  assert.equal(stale.getFresh('expired'), undefined);
  assert.equal(stale.getStale('expired'), 9);
});

test('health payload does not expose secrets and reports bounded cache state', () => {
  const health = addon.healthPayload();
  const serialized = JSON.stringify(health);

  assert.equal(health.version, '2.8.0');
  assert.equal(health.directKraLogin, false);
  assert.equal(health.directScAuth, false);
  assert.equal(health.optionalFastshareWebshare, false);
  assert.equal(serialized.includes('CDER_MANIFEST_URL'), false);
  assert.ok(health.cache.maxEntries >= 200);
});


test('catalog pagination uses 100 items per page and stops at 800', () => {
  assert.equal(addon.PAGE_SIZE, 100);
  assert.equal(addon.MAX_CATALOG_ITEMS, 800);
  assert.deepEqual(addon.catalogPageWindow(0), { skip:0, limit:100, need:100 });
  assert.deepEqual(addon.catalogPageWindow(700), { skip:700, limit:100, need:800 });
  assert.deepEqual(addon.catalogPageWindow(800), { skip:800, limit:0, need:800 });
  assert.deepEqual(addon.catalogPageWindow(900), { skip:900, limit:0, need:900 });
});


test('hard cder traffic limits protect club.cder and KRA', () => {
  assert.equal(addon.MAX_CONCURRENCY, 1);
  assert.ok(addon.CDER_MIN_INTERVAL_MS >= 2000);
  assert.ok(addon.CDER_BUDGET_MAX <= 8);
  assert.ok(addon.CDER_BUDGET_WINDOW_MS >= 15 * 60 * 1000);
  assert.ok(addon.MAX_TOTAL_SOURCE_PAGES <= 8);
  assert.ok(addon.SEARCH_MAX_TOTAL_SOURCE_PAGES <= 2);
});


test('derived catalog state is safe to store and restore from persistent cache', () => {
  const state = {
    metas:[
      { id:'tt0133093', name:'Matrix - CZ' },
      { id:'tt12637874', name:'Fallout - CZ' }
    ],
    seen:new Set(['tt0133093|Matrix - CZ','tt12637874|Fallout - CZ']),
    nextPage:3,
    done:false
  };
  const serialized = addon.serializeDerivedState(state);
  assert.deepEqual(serialized.seen, ['tt0133093|Matrix - CZ','tt12637874|Fallout - CZ']);
  assert.equal(serialized.nextPage, 3);

  const restored = addon.reviveDerivedState(JSON.parse(JSON.stringify(serialized)));
  assert.equal(restored.nextPage, 3);
  assert.equal(restored.done, false);
  assert.equal(restored.seen.has('tt0133093|Matrix - CZ'), true);
  assert.equal(restored.metas.length, 2);
});

test('persistent cache records can distinguish fresh from stale without network access', () => {
  assert.equal(addon.persistentFresh({ expiresAt:Date.now() + 60_000, value:{ok:true} }), true);
  assert.equal(addon.persistentFresh({ expiresAt:Date.now() - 1, value:{ok:true} }), false);
  assert.ok(addon.PERSISTENT_RETENTION_MS >= 24 * 60 * 60 * 1000);
});
