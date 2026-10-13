import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMonthlyRecap, recapMonthRange, unionViewingIntervals, listRecapMonths } from '../src/utils/viewingStats.js';

test('actual intervals are clipped to local month boundaries; overlaps and retries count once', () => {
  const { start, end } = recapMonthRange('2026-10');
  const item = { type: 'movie', id: 1, genres: [{ id: 18, name: 'Драма' }, { id: 18, name: 'Драма' }] };
  const recap = buildMonthlyRecap({ sessions: {
    a: { progressKey: 'movie_1', item, segments: [{ start: start - 1000, end: start + 2000 }, { start: start + 5000, end: start + 8000 }], completedAt: start + 8000 },
    b: { progressKey: 'movie_1', item, segments: [{ start: start + 1000, end: start + 2000 }, { start: end - 1000, end: end + 2000 }], completedAt: start + 8000 },
  } }, { month: '2026-10' });
  assert.equal(recap.watchMs, 6000);
  assert.equal(recap.completedMovies, 1);
  assert.equal(recap.days.reduce((n, day) => n + day.watchMs, 0), 6000);
  assert.equal(recap.genres[0].watchMs, 6000);
});

test('episodes, personal ratings, deletions, and legacy history are represented honestly', () => {
  const { start } = recapMonthRange('2026-10');
  const recap = buildMonthlyRecap({ history: [{ id: 1 }], sessions: {
    a: { item: { type: 'tv', id: 2 }, progressKey: 'tv_2_s1e1', completedAt: start + 1000, segments: [] },
    b: { item: { type: 'tv', id: 2 }, progressKey: 'tv_2_s1e1', completedAt: start + 2000, segments: [] },
    c: { item: { type: 'tv', id: 2 }, progressKey: 'tv_2_s1e2', completedAt: start + 2000, segments: [] },
  }, ratings: { a: { value: { score: 9, ratedAt: start + 500, item: { title: 'A' } } }, b: { deleted: true, value: { score: 10, ratedAt: start + 500 } }, c: { value: { score: 10, ratedAt: start - 500 } } } }, { month: '2026-10' });
  assert.equal(recap.completedEpisodes, 2);
  assert.equal(recap.watchMs, 0);
  assert.equal(recap.coverage.legacyEntries, 1);
  assert.deepEqual(recap.topRatings.map((r) => r.item.title), ['A']);
});

test('day spans follow DST and the month list includes actual viewing/rating months', () => {
  const range = recapMonthRange('2026-03', 'America/New_York');
  assert.equal((range.end - range.start) / 3600000, 31 * 24 - 1);
  assert.deepEqual(listRecapMonths({ sessions: { a: { segments: [{ start: Date.UTC(2026, 0, 31, 20), end: Date.UTC(2026, 1, 1, 2) }] } } }, 'Europe/Minsk', Date.UTC(2026, 9, 14)), ['2026-10', '2026-02', '2026-01']);
  assert.deepEqual(unionViewingIntervals([{ start: 3, end: 7 }, { start: 1, end: 4 }, { start: 9, end: 8 }]), [{ start: 1, end: 7 }]);
});

test('two overlapping devices share genre time without doubling the actual viewing total', () => {
  const { start } = recapMonthRange('2026-10');
  const sessions = { a: { item: { type: 'movie', id: 1, genres: [{ id: 18, name: 'Драма' }] }, segments: [{ start, end: start + 10000 }] },
    b: { item: { type: 'movie', id: 2, genres: [{ id: 35, name: 'Комедия' }] }, segments: [{ start: start + 5000, end: start + 15000 }] } };
  const recap = buildMonthlyRecap({ sessions }, { month: '2026-10' });
  assert.equal(recap.watchMs, 15000);
  assert.equal(recap.genres.reduce((n, genre) => n + genre.watchMs, 0), recap.watchMs);
  assert.equal(recap.genres[0].watchMs, 7500);
});

test('recorded history entries are not mislabeled as legacy records without timing', () => {
  const { start } = recapMonthRange('2026-10');
  const recap = buildMonthlyRecap({ history: [{ id: 1, media_type: 'movie' }, { id: 2, media_type: 'tv', season: 1, episode: 2 }, { id: 3, media_type: 'movie' }],
    sessions: { a: { progressKey: 'movie_1', item: { type: 'movie', id: 1 }, segments: [{ start, end: start + 1000 }] }, b: { progressKey: 'tv_2_s1e2', item: { type: 'tv', id: 2 }, segments: [{ start, end: start + 1000 }] } } }, { month: '2026-10' });
  assert.equal(recap.coverage.legacyEntries, 1);
});
