// AniSkip API v2 https://api.aniskip.com/api-docs
// Uses MyAnimeList IDs (not AniList IDs).
// Response: { found, results: [{ interval: { startTime, endTime }, skipType: "op"|"ed"|... }] }

const ANISKIP_API = "https://api.aniskip.com/v2";
const CACHE_KEY = "streambert_aniskipCache";
const CACHE_TTL = 1000 * 60 * 60 * 24 * 7; // 7 days
const MAX_CACHE_ENTRIES = 100;

// TMDB combines seasons/cours that MAL stores as separate anime.
// Dataset: https://github.com/Fribb/anime-lists (refresh with update-anime-map.mjs).
export async function resolveAnimeEpisode(tmdbId, season, episode, signal) {
  if (signal?.aborted || tmdbId == null || season == null || episode == null ||
      !Number.isInteger(Number(tmdbId)) || Number(tmdbId) <= 0 ||
      !Number.isInteger(Number(season)) || Number(season) < 0 ||
      !Number.isInteger(Number(episode)) || Number(episode) <= 0) return null;
  const { default: mappings } = await import("./anime-season-map.json", { with: { type: "json" } });
  if (signal?.aborted) return null;
  const entries = mappings[`${Number(tmdbId)}:${Number(season)}`] || [];
  if (!entries.length) return null;
  const eligible = entries.filter(([offset]) => Number(episode) > offset);
  const offset = eligible.at(-1)?.[0];
  const matches = eligible.filter(([start]) => start === offset);
  // Conflicting mappings cannot safely pick a season by title similarity.
  if (matches.length !== 1) return { ambiguous: true };
  return { malId: matches[0][1], episode: Number(episode) - offset };
}

function getCache() {
  try {
    const cache = JSON.parse(localStorage.getItem(CACHE_KEY) || "{}");
    return cache && typeof cache === "object" && !Array.isArray(cache) ? cache : {};
  } catch {
    return {};
  }
}

function setCache(cache) {
  try {
    const now = Date.now();
    for (const [key, value] of Object.entries(cache)) {
      if (!value?.expiresAt || value.expiresAt <= now) delete cache[key];
    }
    const entries = Object.entries(cache).sort((a, b) => a[1].expiresAt - b[1].expiresAt);
    for (const [key] of entries.slice(0, Math.max(0, entries.length - MAX_CACHE_ENTRIES))) delete cache[key];
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch {}
}

function validateCachedTimings(data, len) {
  if (!data || typeof data !== "object") return null;
  const result = {};
  for (const key of ["intro", "outro", "recap"]) {
    const startTime = Number(data[key]?.startTime);
    const endTime = Number(data[key]?.endTime);
    if (Number.isFinite(startTime) && Number.isFinite(endTime) && startTime >= 0 &&
        endTime > startTime && (!len || endTime <= len + 2)) result[key] = { startTime, endTime };
  }
  return Object.keys(result).length ? result : null;
}

export function clearAniSkipCache() {
  try {
    localStorage.removeItem(CACHE_KEY);
  } catch {}
}

/**
 * Fetch intro/outro/recap timings for an episode, with 7-day localStorage cache.
 * @param {number} malId  MyAnimeList ID (anilistData.idMal)
 * @param {number} episodeNumber
 * @param {number} episodeLength  Episode duration in SECONDS. Passing the real
 *   duration lets AniSkip return the skip-time submission whose episode length
 *   matches this stream — important when a dub/encode shifts the OP/ED relative
 *   to the original Japanese air. 0 = unknown (returns any submission, may be
 *   misaligned). Cached per (malId, episode, length).
 * @returns {{ intro?: { startTime, endTime }, outro?: { startTime, endTime }, recap?: { startTime, endTime } } | null}
 */
export async function fetchAniSkipTimings(malId, episodeNumber, episodeLength = 0, { signal } = {}) {
  if (signal?.aborted || !Number.isInteger(Number(malId)) || Number(malId) <= 0 ||
      !Number.isInteger(Number(episodeNumber)) || Number(episodeNumber) <= 0) return null;

  const len = Number.isFinite(Number(episodeLength)) ? Number(Number(episodeLength).toFixed(3)) : 0;
  const cacheKey = `${malId}_${episodeNumber}_${len}`;
  const cache = getCache();
  const hit = cache[cacheKey];
  if (hit && Date.now() < hit.expiresAt) {
    const valid = validateCachedTimings(hit.data, len);
    if (valid || hit.data === null) return valid;
    delete cache[cacheKey];
  }

  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(abort, 5000);
  try {
    const res = await fetch(
      `${ANISKIP_API}/skip-times/${malId}/${episodeNumber}` +
        `?types[]=op&types[]=ed&types[]=mixed-op&types[]=mixed-ed&types[]=recap&episodeLength=${len}`,
      { signal: controller.signal },
    );

    // 404 = no data for this episode, cache as null
    if (res.status === 404) {
      cache[cacheKey] = { data: null, expiresAt: Date.now() + CACHE_TTL };
      setCache(cache);
      return null;
    }
    if (!res.ok) return null;

    const data = await res.json();
    if (!data.found || !data.results?.length) {
      cache[cacheKey] = { data: null, expiresAt: Date.now() + CACHE_TTL };
      setCache(cache);
      return null;
    }

    const result = {};
    for (const entry of data.results) {
      const { skipType, interval } = entry;
      const startTime = Number(interval?.startTime);
      const endTime = Number(interval?.endTime);
      if (!Number.isFinite(startTime) || !Number.isFinite(endTime) || startTime < 0 ||
          endTime <= startTime || (len > 0 && endTime > len + 2)) continue;
      const segment = { startTime, endTime };
      // op / mixed-op → intro,  ed / mixed-ed → outro,  recap → recap
      if (skipType === "op" || skipType === "mixed-op") {
        result.intro = segment;
      } else if (skipType === "ed" || skipType === "mixed-ed") {
        result.outro = segment;
      } else if (skipType === "recap") {
        result.recap = segment;
      }
    }

    const timings = Object.keys(result).length > 0 ? result : null;
    cache[cacheKey] = { data: timings, expiresAt: Date.now() + CACHE_TTL };
    setCache(cache);
    return timings;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}
