// "Подборки": a fan of three posters per theme, opening the catalogue with that
// theme already filtered.
import { useEffect, useMemo, useState } from "react";
import { filterAnime, imgUrl, tmdbFetch } from "../utils/api";
import { STORAGE_KEYS, storage } from "../utils/storage";
import { clearedForAge, useRatings } from "../utils/useRatings";

const DECKS = [
  { genre: 878, title: "Фантастика, над которой думаешь" },
  { genre: 53, title: "Держит в напряжении" },
  { genre: 35, title: "Лёгкое, чтобы выдохнуть" },
  { genre: 18, title: "Сильные драмы" },
];

export default function CollectionDecks({ apiKey, onNavigate }) {
  const [candidates, setCandidates] = useState({});
  const allCandidates = useMemo(() => Object.values(candidates).flat(), [candidates]);
  const { ratingsMap, ageLimitSetting } = useRatings(allCandidates);
  const posters = useMemo(() => Object.fromEntries(Object.entries(candidates).map(([genre, movies]) => [
    genre,
    movies.filter((movie) => clearedForAge(movie, ratingsMap, ageLimitSetting)).slice(0, 3),
  ])), [candidates, ratingsMap, ageLimitSetting]);

  useEffect(() => {
    if (!apiKey) return undefined;
    const controller = new AbortController();
    DECKS.forEach(({ genre }) => {
      tmdbFetch(`/discover/movie?include_adult=false&sort_by=vote_average.desc&vote_count.gte=3000&with_genres=${genre}`, apiKey, { signal: controller.signal, priority: "low" })
        .then((data) => {
          const found = filterAnime(data.results || []).filter((movie) => movie.poster_path).slice(0, 10).map((movie) => ({ ...movie, media_type: "movie" }));
          setCandidates((prev) => ({ ...prev, [genre]: found }));
        })
        .catch(() => {});
    });
    return () => controller.abort();
  }, [apiKey]);

  const ready = DECKS.filter(({ genre }) => posters[genre]?.length === 3);
  if (!ready.length) return null;

  const open = (genre) => {
    storage.set(STORAGE_KEYS.DISCOVER_FILTERS, { mediaType: "movie", genreId: String(genre), year: "", minRating: 0, sortBy: "vote_average.desc" });
    onNavigate("discover");
  };

  return (
    <section className="poster-row collection-decks" aria-label="Подборки">
      <div className="poster-row__head"><h2 className="section-title">Подборки</h2></div>
      <div className="collection-decks__grid">
        {ready.map(({ genre, title }) => (
          <button key={genre} type="button" className="deck" onClick={() => open(genre)}>
            <span className="deck__fan" aria-hidden="true">
              {posters[genre].map((movie) => <img key={movie.id} src={imgUrl(movie.poster_path, "w185")} alt="" loading="lazy" decoding="async" />)}
            </span>
            <span className="deck__title">{title}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
