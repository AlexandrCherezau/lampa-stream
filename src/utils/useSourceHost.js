import { useEffect, useRef, useState } from "react";
import { tmdbFetch, isAnimeContent } from "./api";
import { collapsFindKp } from "./collaps-client";
import { createSourceSession } from "./source-host-client";

export const SWITCH_WATCHDOG_MS = 14_000;

export default function useSourceHost({ enabled, apiKey, item, details, type, season, episode }) {
  const [value, setValue] = useState({ balansers: [], voices: [], qualities: [], subtitles: [], stream: null });
  const session = useRef(null);
  if (!session.current) session.current = createSourceSession({ publish: setValue });
  const title = details?.title || details?.name || item?.title || item?.name;
  const imdbId = details?.imdb_id || details?.external_ids?.imdb_id || item?.imdb_id;
  const existingKinopoiskId = [details?.kinopoisk_id, details?.kinopoiskId, item?.kinopoisk_id, item?.kinopoiskId]
    .filter((value) => typeof value === "number" || typeof value === "string")
    .map(Number)
    .find((value) => Number.isSafeInteger(value) && value > 0) ?? null;
  const year = (details?.release_date || details?.first_air_date || item?.release_date || item?.first_air_date || "").slice(0, 4);
  const originalTitle = details?.original_title || details?.original_name || item?.original_title || item?.original_name || title;
  const language = details?.original_language || item?.original_language;
  const anime = isAnimeContent(item, details);
  const catalogSource = item?.catalogSource === "vi3000" ? "vi3000" : null;
  const runtimeMinutes = type === "movie" ? Number(details?.runtime ?? item?.runtime) : NaN;
  const validRuntimeMinutes = Number.isSafeInteger(runtimeMinutes) && runtimeMinutes >= 1 && runtimeMinutes <= 1440
    ? runtimeMinutes
    : null;
  useEffect(() => {
    if (!enabled || !title || (type === "tv" && (season == null || episode == null))) return;
    const controller = new AbortController();
    let alive = true;
    (async () => {
      const [external, kp] = await Promise.all([
        !imdbId && apiKey && item?.id ? tmdbFetch(`/${type}/${item.id}/external_ids`, apiKey, { signal: controller.signal }).catch(() => null) : null,
        existingKinopoiskId ? null : collapsFindKp({ query: title, originalTitle, year, type }, { signal: controller.signal }).catch(() => null),
      ]);
      if (!alive) return;
      const params = { type, title, originalTitle, language, anime, tmdbId: item?.id,
        ...(catalogSource ? { catalogSource } : {}),
        ...(year ? { year: Number(year) } : {}), ...(imdbId || external?.imdb_id ? { imdbId: imdbId || external.imdb_id } : {}),
        ...(existingKinopoiskId || (kp?.ok && kp.kinopoiskId)
          ? { kinopoiskId: existingKinopoiskId || kp.kinopoiskId }
          : {}),
        ...(validRuntimeMinutes != null ? { runtimeMinutes: validRuntimeMinutes } : {}),
        ...(type === "tv" ? { season: Number(season), episode: Number(episode) } : {}),
      };
      session.current.start(params);
    })();
    return () => { alive = false; controller.abort(); session.current.stop(); };
  }, [enabled, apiKey, item?.id, title, originalTitle, language, anime, year, imdbId, existingKinopoiskId, validRuntimeMinutes, catalogSource, type, season, episode]);
  return { ...value, ...session.current };
}
