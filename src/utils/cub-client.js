const FEEDS = new Set(["now_playing", "latest", "fire", "hundred"]);
const cache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

export async function cubFeed(feed, page = 1, { signal } = {}) {
  if (!FEEDS.has(feed) || !Number.isSafeInteger(page) || page < 1 || page > 10_000) throw new TypeError("Неверная лента или страница каталога");
  signal?.throwIfAborted();
  const key = `${feed}:${page}`;
  const hit = cache.get(key);
  if (hit && Date.now() < hit.expires) return hit.data;
  const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(12_000)]) : AbortSignal.timeout(12_000);
  let response;
  try { response = await fetch(`/api/cub?feed=${feed}&page=${page}`, { headers: { accept: "application/json" }, signal: requestSignal }); }
  catch {
    requestSignal.throwIfAborted();
    throw new Error("Каталог CUB временно недоступен");
  }
  let data;
  try { data = await response.json(); }
  catch {
    requestSignal.throwIfAborted();
    throw new Error("Каталог CUB вернул неверный ответ");
  }
  if (!response.ok) throw new Error(data.message || "Каталог CUB временно недоступен");
  if (data?.page !== page || !Number.isSafeInteger(data.total_pages) || data.total_pages < 0 || !Array.isArray(data.results)
    || data.results.some((card) => !Number.isSafeInteger(card?.id) || card.id < 1 || !["movie", "tv"].includes(card.media_type))) {
    throw new Error("Каталог CUB вернул неверный ответ");
  }
  requestSignal.throwIfAborted();
  cache.delete(key);
  if (cache.size >= 32) cache.delete(cache.keys().next().value);
  cache.set(key, { data, expires: Date.now() + CACHE_TTL });
  return data;
}
