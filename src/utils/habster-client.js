import { tmdbFetch } from "./api";

const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

export async function habsterFeed(feed, page = 1, { signal, apiKey } = {}) {
  if (feed !== "popular" || page !== 1) throw new TypeError("Неверная лента или страница каталога");
  signal?.throwIfAborted();
  if (!apiKey) throw new Error("Для загрузки каталога нужен ключ TMDB");
  const hit = cache.get(apiKey);
  if (hit && Date.now() < hit.expires) return hit.data;
  const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
  const response = await fetch("/api/habster?feed=popular&page=1", { headers: { accept: "application/json" }, signal: requestSignal });
  const data = await response.json();
  if (!response.ok) throw new Error("Каталог Habster временно недоступен");
  if (data?.page !== 1 || data.total_pages !== 1 || !Array.isArray(data.results) || data.results.length > 20
    || (data.unmapped != null && (!Number.isSafeInteger(data.unmapped) || data.unmapped < 0 || data.unmapped > 20))
    || data.results.some((item) => !Number.isSafeInteger(item?.kinopoisk_id) || item.kinopoisk_id < 1
      || !["movie", "tv"].includes(item.media_type) || !/^tt\d{5,12}$/.test(item.imdb_id))) {
    throw new Error("Каталог Habster вернул неверный ответ");
  }
  const results = new Array(data.results.length);
  let next = 0;
  let failed = 0;
  const mappings = Promise.all(Array.from({ length: Math.min(4, data.results.length) }, async () => {
    while (next < data.results.length) {
      requestSignal.throwIfAborted();
      const index = next++;
      const item = data.results[index];
      try {
        const found = await tmdbFetch(`/find/${item.imdb_id}?external_source=imdb_id`, apiKey, { signal: requestSignal });
        requestSignal.throwIfAborted();
        const matches = item.media_type === "movie" ? found?.movie_results : found?.tv_results;
        if (matches?.length !== 1 || !Number.isSafeInteger(matches[0]?.id) || matches[0].id < 1) continue;
        results[index] = { ...matches[0], media_type: item.media_type, kinopoisk_id: item.kinopoisk_id,
          imdb_id: item.imdb_id, catalogSource: "habster" };
      } catch {
        requestSignal.throwIfAborted();
        failed++;
      }
    }
  }));
  // TMDB's shared request queue can outlive an abort before its fetch starts.
  await new Promise((resolve, reject) => {
    const abort = () => reject(requestSignal.reason);
    requestSignal.addEventListener("abort", abort, { once: true });
    mappings.then(resolve, reject).finally(() => requestSignal.removeEventListener("abort", abort));
    if (requestSignal.aborted) abort();
  });
  requestSignal.throwIfAborted();
  const cards = results.filter(Boolean);
  if (!cards.length && failed) throw new Error("Не удалось загрузить фильмы Habster");
  const normalized = { page: 1, total_pages: 1, results: cards, unmapped: (data.unmapped || 0) + data.results.length - cards.length };
  if (!failed && !data.unmapped) {
    cache.delete(apiKey);
    if (cache.size >= 4) cache.delete(cache.keys().next().value);
    cache.set(apiKey, { data: normalized, expires: Date.now() + CACHE_TTL });
  }
  return normalized;
}
