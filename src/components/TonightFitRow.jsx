// "Успею сегодня": films that fit the time left tonight, each with its end time.
import { useEffect, useMemo, useState } from "react";
import { filterAnime, tmdbFetch } from "../utils/api";
import { clockAfter, useMinuteClock } from "../utils/endTime";
import { clearedForAge, getRatingForItem, useRatings } from "../utils/useRatings";
import MediaCard from "./MediaCard";
import PosterRow from "./PosterRow";

const TIMES = [
  { minutes: 125, label: "Около 2 часов" },
  { minutes: 150, label: "До 2,5 часа" },
  { minutes: 180, label: "До 3 часов" },
];
const CANDIDATES = 14;

export default function TonightFitRow({ apiKey, history, watched, onSelect, onMarkWatched, onMarkUnwatched }) {
  const [limit, setLimit] = useState(TIMES[1].minutes);
  const [loaded, setLoaded] = useState({ limit: null, items: [] });
  const now = useMinuteClock();

  useEffect(() => {
    if (!apiKey) return undefined;
    const controller = new AbortController();
    const { signal } = controller;
    const seen = new Set((history || []).filter((h) => h.media_type !== "tv").map((h) => h.id));
    tmdbFetch(`/discover/movie?include_adult=false&sort_by=popularity.desc&vote_count.gte=1500&vote_average.gte=7&with_runtime.gte=70&with_runtime.lte=${limit}`, apiKey, { signal, priority: "low" })
      .then((data) => {
        const fresh = filterAnime(data.results || []).filter((movie) => !seen.has(movie.id)).slice(0, CANDIDATES);
        // The list has no runtime, and an end time without it would be a guess.
        return Promise.all(fresh.map((movie) => tmdbFetch(`/movie/${movie.id}`, apiKey, { signal, priority: "low" })
          .then((full) => ({ ...movie, runtime: full.runtime, media_type: "movie" }))
          .catch(() => null)));
      })
      .then((movies) => {
        if (!signal.aborted) setLoaded({ limit, items: movies.filter((movie) => movie?.runtime > 0 && movie.runtime <= limit) });
      })
      .catch(() => { if (!signal.aborted) setLoaded({ limit, items: [] }); });
    return () => controller.abort();
    // History only filters what was already seen; a new entry need not refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey, limit]);

  const { ratingsMap, ageLimitSetting } = useRatings(loaded.items);
  const items = useMemo(() => loaded.items.filter((item) => clearedForAge(item, ratingsMap, ageLimitSetting)), [loaded.items, ratingsMap, ageLimitSetting]);

  // Nothing at all to show (no catalogue yet, or the request failed): no empty shelf.
  if (!loaded.limit) return null;

  const controls = (
    <div className="time-chips" role="group" aria-label="Сколько есть времени">
      {TIMES.map(({ minutes, label }) => (
        <button key={minutes} type="button" className={`time-chip${limit === minutes ? " is-active" : ""}`} aria-pressed={limit === minutes} onClick={() => setLimit(minutes)}>{label}</button>
      ))}
    </div>
  );

  return (
    <PosterRow title="Успею сегодня" controls={controls}>
      {items.map((item) => (
        <MediaCard
          key={item.id}
          item={item}
          onClick={onSelect}
          progress={0}
          watched={watched}
          onMarkWatched={onMarkWatched}
          onMarkUnwatched={onMarkUnwatched}
          ageRating={getRatingForItem(item, ratingsMap).cert}
          note={`до ${clockAfter(item.runtime, now)}`}
        />
      ))}
    </PosterRow>
  );
}
