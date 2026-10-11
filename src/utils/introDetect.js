const INTRODB_ENDPOINT = "/api/introdb";
const INTRODB_CACHE_TTL = 1000 * 60 * 60 * 24;
const introDbCache = new Map();

function validSegment(segment, duration) {
  const startTime = Number(segment?.start_sec);
  const endTime = Number(segment?.end_sec);
  const confidence = Number(segment?.confidence);
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime) ||
      !Number.isFinite(confidence) || confidence < 0.5 ||
      startTime < 0 || endTime <= startTime || endTime > duration + 2) return null;
  return { startTime, endTime };
}

/** Fetch confirmed IntroDB segments for a movie or TV episode. */
export async function fetchIntroDbTimings({ imdbId, type, season, episode, duration, signal }) {
  if (signal?.aborted || !/^tt\d+$/.test(imdbId || "") || !Number.isFinite(duration) || duration <= 0) return null;
  if (type === "tv" && (season == null || episode == null ||
      !Number.isInteger(Number(season)) || Number(season) < 0 ||
      !Number.isInteger(Number(episode)) || Number(episode) <= 0)) return null;

  const params = new URLSearchParams({ imdb_id: imdbId });
  if (type === "tv") {
    params.set("season", String(season));
    params.set("episode", String(episode));
  } else {
    params.set("is_movie", "true");
  }
  const cacheKey = `${params.toString()}_${Math.round(duration)}`;
  const cached = introDbCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.data;
  if (cached) introDbCache.delete(cacheKey);

  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  const timeout = setTimeout(abort, 5000);
  try {
    const response = await fetch(`${INTRODB_ENDPOINT}?${params}`, { signal: controller.signal });
    if (!response.ok) return null;
    const data = await response.json();
    const timings = {};
    for (const [sourceKey, targetKey] of [["intro", "intro"], ["recap", "recap"], ["outro", "outro"], ["post_credits", "postCredits"]]) {
      const segment = validSegment(data?.[sourceKey], duration);
      if (segment) timings[targetKey] = segment;
    }
    const result = Object.keys(timings).length ? timings : null;
    introDbCache.set(cacheKey, { data: result, expiresAt: Date.now() + INTRODB_CACHE_TTL });
    if (introDbCache.size > 100) introDbCache.delete(introDbCache.keys().next().value);
    return result;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

// Compatibility for legacy player callers: there is no safe generic fallback.
export function fallbackTimings() {
  return null;
}

/** Merge confirmed sources; the first argument wins per segment. */
export function mergeTimings(primary, secondary) {
  const out = {};
  for (const key of ["intro", "recap", "outro", "postCredits"]) {
    if (primary?.[key]) out[key] = primary[key];
    else if (secondary?.[key]) out[key] = secondary[key];
  }
  return Object.keys(out).length ? out : null;
}
