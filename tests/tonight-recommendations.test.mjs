import test from 'node:test';
import assert from 'node:assert/strict';
import { recommendTonight } from '../src/utils/tonightRecommendations.js';

const movie = (id, overrides = {}) => ({ id, title: `Film ${id}`, runtime: 110, genres: [{ id: 53, name: 'Триллер' }], release_date: '2020-01-01', vote_average: 7.5, ...overrides });
function catalogue(items, pages = 1) {
  const calls = [], details = new Map(items.map((item) => [item.id, item]));
  return { calls, load: async (path) => {
    calls.push(path);
    if (path.startsWith('/discover')) return { results: items, total_pages: pages };
    return details.get(Number(path.match(/\/movie\/(\d+)/)[1]));
  } };
}

test('five unique released titles fit the real detail runtime, mood, anime and watched filters', async () => {
  const items = [movie(1, { runtime: 121 }), movie(2, { release_date: '2200-01-01' }), movie(3, { runtime: null }), movie(4, { genres: [{ id: 35 }] }), movie(5, { original_language: 'ja', genres: [{ id: 16 }, { id: 53 }] }), movie(6), movie(7), ...[8, 9, 10, 11, 12, 12].map((id) => movie(id))];
  const source = catalogue(items);
  const result = await recommendTonight({ ...source, maxMinutes: 120, mood: 'tension', company: 'pair', hideAnime: true, history: [{ id: 6, media_type: 'movie' }], watched: { movie_7: true } });
  assert.deepEqual(new Set(result.items.map((item) => item.id)), new Set([8, 9, 10, 11, 12]));
  assert.equal(result.shortfall, false);
  assert.ok(source.calls[0].includes('with_runtime.lte=120'));
  assert.ok(result.items.every((item) => item.matchReason.includes('вдвоём')));
});

test('family rejects unknown or adult certificates and applies a stricter existing age limit', async () => {
  const items = Array.from({ length: 8 }, (_, i) => movie(i + 1, { genres: [{ id: 35 }, { id: 10751 }] }));
  const result = await recommendTonight({ ...catalogue(items), mood: 'laugh', company: 'family', ageLimit: 7, ageFor: async (item) => ({ minAge: item.id === 1 ? null : item.id === 2 ? 12 : 7 }) });
  assert.equal(result.items.length, 5);
  assert.ok(result.items.every((item) => item.id > 2 && item.minAge === 7));
});

test('honest shortfall never fills the five slots with wrong runtime or mood', async () => {
  const result = await recommendTonight({ ...catalogue([movie(1), movie(2, { runtime: 240 }), movie(3, { adult: true })]) });
  assert.equal(result.shortfall, true);
  assert.deepEqual(result.items.map((item) => item.id), [1]);
});

test('cancellation after discovery prevents stale details and results', async () => {
  const controller = new AbortController();
  const source = catalogue([movie(1)]);
  await assert.rejects(recommendTonight({ signal: controller.signal, load: async (path) => { const value = await source.load(path); controller.abort(); return value; } }), (error) => error.name === 'AbortError');
  assert.equal(source.calls.length, 1);
});

test('a failed detail catalogue reports an error rather than an empty success', async () => {
  await assert.rejects(recommendTonight({ load: async (path) => { if (path.startsWith('/discover')) return { results: [movie(1)] }; throw new Error('upstream'); } }), /проверить фильмы/);
});
