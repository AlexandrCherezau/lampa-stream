import assert from 'node:assert/strict';
import { lampacQuery, lampacWarmBalanser, lampacBalanser } from '../src/utils/lampac-client.js';
import { normalizeEvents } from '../src/utils/lampac-browser.js';
const anime = new URLSearchParams(lampacQuery({ title: 'Волейбол!!', serial: true, originalLanguage: 'ja', anime: true, tmdbId: 60863 }));
assert.equal(anime.get('original_language'), 'ja');
assert.equal(anime.get('anime'), '1');
assert.equal(anime.get('tmdb_id'), '60863');
const movie = new URLSearchParams(lampacQuery({ title: 'Бойцовский клуб', serial: false, originalLanguage: 'en', anime: false, tmdbId: -1 }));
assert.equal(movie.get('serial'), '0');
assert.equal(movie.has('anime'), false);
assert.equal(movie.has('tmdb_id'), false);
const events = normalizeEvents([
  { balanser: 'kodik', name: 'Kodik', url: 'https://test/kodik' },
  { balanser: 'phantom', name: 'Phantom', url: 'https://test/phantom' },
  { balanser: 'moonanime', name: 'MoonAnime', url: 'https://test/moon' },
]);
assert.deepEqual(events.map(e => e.balanser), ['kodik', 'phantom']);
const originalFetch = globalThis.fetch;
let calls = 0;
let release;
globalThis.fetch = async () => { calls++; await new Promise(r => { release = r; }); return Response.json({ type: 'movie', data: [] }); };
try {
  const url = 'https://138-16-177-21.nip.io/lite/kodik';
  const extra = { title: 'Волейбол!!', original_language: 'ja' };
  const warm = lampacWarmBalanser(url, { extra });
  assert.ok(warm?.then, 'warm waves must await their real requests');
  const ctrl = new AbortController();
  const cancelled = lampacBalanser(url, { extra, signal: ctrl.signal });
  const actual = lampacBalanser(url, { extra: { original_language: 'ja', title: 'Волейбол!!' } });
  ctrl.abort();
  assert.equal((await cancelled).kind, 'cancelled');
  const timedOut = await lampacBalanser(url, { extra, timeout: 5 });
  assert.equal(timedOut.kind, 'no-link');
  assert.equal(calls, 1, 'warm and real requests share transport even with reordered query');
  release();
  assert.equal((await actual).ok, true);
  await warm;
  const fresh = lampacBalanser(url, { extra });
  assert.equal(calls, 2, 'finished media URL responses must not be cached');
  release();
  assert.equal((await fresh).ok, true);
  globalThis.fetch = async () => new Response('catalog', { status: 503 });
  const missing = await lampacBalanser(url);
  assert.equal(missing.ok, false);
  assert.match(missing.error, /нет выбранного фильма или серии/);
  globalThis.fetch = async () => new Response('upstream down', { status: 503 });
  assert.match((await lampacBalanser(url)).error, /временно недоступен/);
  console.log('Lampac checks passed: language, film/anime coverage, Russian filtering, shared warm, cancellation, timeout and fresh URLs');
} finally { globalThis.fetch = originalFetch; }
