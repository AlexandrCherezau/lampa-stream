// ── Discover: browse the whole TMDB catalog with filters + pagination ────────
// A dedicated tab for "show me everything": pick movies or TV, filter by genre,
// year, minimum rating and sort order, then page through the results (20/page).
// Reuses the same age-restriction + "hide anime" filtering as the home page so
// the user's global preferences apply here too.

import { useState, useEffect, useMemo, useCallback } from "react";
import MediaCard from "../components/MediaCard";
import { tmdbFetch, filterAnime } from "../utils/api";
import { storage, STORAGE_KEYS } from "../utils/storage";
import { useRatings, getRatingForItem } from "../utils/useRatings";
import { isRestricted } from "../utils/ageRating";

const GENRE_CACHE_KEY = "streambert_genreCache";
const GENRE_CACHE_TTL = 1000 * 60 * 60 * 24 * 30; // 30 days — genres rarely change

const DEFAULT_FILTERS = {
  mediaType: "movie", // "movie" | "tv"
  genreId: "", // "" = any genre
  year: "", // "" = any year
  minRating: 0, // 0 = any
  sortBy: "popularity.desc",
};

const SORT_OPTIONS = [
  { id: "popularity.desc", label: "Самые популярные" },
  { id: "vote_average.desc", label: "С высоким рейтингом" },
  { id: "primary_release_date.desc", label: "Сначала новые" },
  { id: "primary_release_date.asc", label: "Сначала старые" },
  { id: "revenue.desc", label: "Самые кассовые" },
  { id: "original_title.asc", label: "Название А–Я" },
];
// TV uses first_air_date.* instead of primary_release_date.*
const tvSort = (s) => s.replace("primary_release_date", "first_air_date");

const MIN_RATING_OPTIONS = [
  { id: 0, label: "Любой рейтинг" },
  { id: 5, label: "★ 5.0+" },
  { id: 6, label: "★ 6.0+" },
  { id: 7, label: "★ 7.0+" },
  { id: 8, label: "★ 8.0+" },
];

// Build the year dropdown: current year down to 1960, plus "Any".
const YEAR_OPTIONS = (() => {
  const now = new Date().getFullYear();
  const opts = [{ id: "", label: "Любой год" }];
  for (let y = now; y >= 1960; y--) opts.push({ id: String(y), label: String(y) });
  return opts;
})();

function loadFilters() {
  const saved = storage.get(STORAGE_KEYS.DISCOVER_FILTERS) || {};
  return { ...DEFAULT_FILTERS, ...saved };
}

// Genre lists differ between movie and TV, so fetch + cache both.
async function loadGenres(apiKey) {
  const cached = (() => {
    try {
      const raw = localStorage.getItem(GENRE_CACHE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  })();
  if (cached && cached.ts && Date.now() - cached.ts < GENRE_CACHE_TTL) {
    return cached.data;
  }
  try {
    const [m, t] = await Promise.all([
      tmdbFetch("/genre/movie/list", apiKey),
      tmdbFetch("/genre/tv/list", apiKey),
    ]);
    const data = {
      movie: (m.genres || []).map((g) => ({ id: String(g.id), label: g.name })),
      tv: (t.genres || []).map((g) => ({ id: String(g.id), label: g.name })),
    };
    try {
      localStorage.setItem(GENRE_CACHE_KEY, JSON.stringify({ ts: Date.now(), data }));
    } catch {}
    return data;
  } catch {
    return { movie: [], tv: [] };
  }
}

export default function DiscoverPage({
  apiKey,
  onSelect,
  watched,
  onMarkWatched,
  onMarkUnwatched,
  progress,
}) {
  const [filters, setFilters] = useState(loadFilters);
  const [genres, setGenres] = useState({ movie: [], tv: [] });
  const [results, setResults] = useState([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Fetch genre lists once (when the token arrives).
  useEffect(() => {
    if (!apiKey) return;
    let mounted = true;
    loadGenres(apiKey).then((g) => mounted && setGenres(g));
    return () => {
      mounted = false;
    };
  }, [apiKey]);

  const persist = useCallback((next) => {
    setFilters(next);
    storage.set(STORAGE_KEYS.DISCOVER_FILTERS, next);
  }, []);

  // Whenever a filter changes, reset to page 1.
  const updateFilter = useCallback(
    (patch) => {
      persist({ ...filters, ...patch });
      setPage(1);
    },
    [filters, persist],
  );

  // Fetch the discover page whenever filters/page/apiKey change.
  useEffect(() => {
    if (!apiKey) return;
    let mounted = true;
    setLoading(true);
    setError(null);
    const isMovie = filters.mediaType === "movie";
    const params = new URLSearchParams();
    params.set("sort_by", isMovie ? filters.sortBy : tvSort(filters.sortBy));
    params.set("include_adult", "false");
    params.set("page", String(page));
    if (filters.genreId) {
      params.set("with_genres", filters.genreId);
    }
    if (filters.year) {
      params.set(isMovie ? "primary_release_year" : "first_air_date_year", filters.year);
    }
    if (filters.minRating > 0) {
      params.set("vote_average.gte", String(filters.minRating));
      // Require enough votes so "highest rated" isn't dominated by 1-vote obscurities.
      params.set("vote_count.gte", "200");
    } else if (filters.sortBy === "vote_average.desc") {
      params.set("vote_count.gte", "200");
    }
    tmdbFetch(`/discover/${filters.mediaType}?${params.toString()}`, apiKey)
      .then((data) => {
        if (!mounted) return;
        const items = (data.results || []).map((i) => ({
          ...i,
          media_type: filters.mediaType,
        }));
        setResults(items);
        setTotalPages(Math.min(data.total_pages || 1, 500)); // TMDB caps at 500
      })
      .catch((e) => {
        if (!mounted) return;
        setError(e?.message || "Не удалось загрузить");
        setResults([]);
      })
      .finally(() => mounted && setLoading(false));
    return () => {
      mounted = false;
    };
  }, [apiKey, filters, page]);

  // Age-restriction filtering (same as home page).
  const { ratingsMap, ageLimitSetting } = useRatings(results);
  const itemRestricted = useCallback(
    (item) => isRestricted(getRatingForItem(item, ratingsMap).minAge, ageLimitSetting),
    [ratingsMap, ageLimitSetting],
  );

  const visible = useMemo(() => {
    return filterAnime(results).filter((i) => !itemRestricted(i));
  }, [results, itemRestricted]);

  const genreOptions = genres[filters.mediaType] || [];

  return (
    <div className="fade-in">
      <div className="library-header">
        <div className="library-title">Каталог</div>
        <div className="library-sub">Ищите фильмы и сериалы с помощью фильтров</div>
      </div>

      {/* Padded content (side gutters consistent with .section, tightens on mobile) */}
      <div className="page-pad">
        {/* ── Filter bar ── */}
        <div
          className="discover-filters"
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 10,
          alignItems: "center",
          margin: "8px 0 24px",
          padding: 14,
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: 12,
        }}
      >
        {/* Movies / TV toggle */}
        <div
          style={{ display: "flex", gap: 0, border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden" }}
        >
          {["movie", "tv"].map((t) => (
            <button
              key={t}
              onClick={() => updateFilter({ mediaType: t, genreId: "" })}
              style={{
                padding: "9px 16px",
                background: filters.mediaType === t ? "var(--red)" : "transparent",
                color: filters.mediaType === t ? "#fff" : "var(--text2)",
                border: "none",
                cursor: "pointer",
                fontWeight: 600,
                fontSize: 13,
              }}
            >
              {t === "movie" ? "Фильмы" : "Сериалы"}
            </button>
          ))}
        </div>

        <Select
          value={filters.genreId}
          onChange={(v) => updateFilter({ genreId: v })}
          options={[{ id: "", label: "Любой жанр" }, ...genreOptions]}
        />
        <Select
          value={filters.year}
          onChange={(v) => updateFilter({ year: v })}
          options={YEAR_OPTIONS}
        />
        <Select
          value={String(filters.minRating)}
          onChange={(v) => updateFilter({ minRating: Number(v) })}
          options={MIN_RATING_OPTIONS}
        />
        <Select
          value={filters.sortBy}
          onChange={(v) => updateFilter({ sortBy: v })}
          options={SORT_OPTIONS}
        />
      </div>

      {/* ── Results ── */}
      {loading && (
        <div className="loader">
          <div className="spinner" />
        </div>
      )}
      {!loading && error && (
        <div style={{ padding: 40, textAlign: "center", color: "var(--text2)" }}>
          {error}
        </div>
      )}
      {!loading && !error && visible.length === 0 && (
        <div style={{ padding: 40, textAlign: "center", color: "var(--text3)" }}>
          No titles match these filters.
        </div>
      )}
      {!loading && !error && visible.length > 0 && (
        <>
          <div className="cards-grid">
            {visible.map((item) => {
              const type = item.media_type === "tv" ? "tv" : "movie";
              const r = getRatingForItem(item, ratingsMap);
              const pk = type === "movie" ? `movie_${item.id}` : `tv_${item.id}`;
              return (
                <MediaCard
                  key={`${item.media_type}_${item.id}`}
                  item={item}
                  onClick={onSelect}
                  progress={progress?.[pk] || 0}
                  watched={watched}
                  onMarkWatched={onMarkWatched}
                  onMarkUnwatched={onMarkUnwatched}
                  ageRating={r.cert}
                  restricted={itemRestricted(item)}
                />
              );
            })}
          </div>

          {/* ── Pagination ── */}
          <div
            className="discover-pager"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 14,
              margin: "32px 0 8px",
              flexWrap: "wrap",
            }}
          >
            <button
              className="btn"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              style={{ opacity: page <= 1 ? 0.4 : 1 }}
            >
              ← Prev
            </button>
            <span style={{ color: "var(--text2)", fontSize: 14 }}>
              Page <b style={{ color: "var(--text)" }}>{page}</b> / {totalPages}
            </span>
            <button
              className="btn"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              style={{ opacity: page >= totalPages ? 0.4 : 1 }}
            >
              Next →
            </button>
          </div>
        </>
      )}
      </div>
    </div>
  );
}

// ── Small styled <select> ────────────────────────────────────────────────────
function Select({ value, onChange, options }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      style={{
        padding: "9px 12px",
        background: "var(--surface2)",
        border: "1px solid var(--border)",
        borderRadius: 8,
        color: "var(--text)",
        fontSize: 13,
        cursor: "pointer",
        minWidth: 120,
      }}
    >
      {options.map((o) => (
        <option key={o.id} value={o.id}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
