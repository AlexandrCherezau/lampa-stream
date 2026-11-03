import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import MediaCard from "../components/MediaCard";
import ProgressiveGrid from "../utils/useProgressiveList.jsx";
import PosterCoverflow from "../components/PosterCoverflow";
import PosterRow from "../components/PosterRow";
import TonightFitRow from "../components/TonightFitRow";
import CollectionDecks from "../components/CollectionDecks";
import {
  tmdbFetch,
  filterAnime,
} from "../utils/api";
import { clockAfter, minutesLeft, useMinuteClock } from "../utils/endTime";
import { useRatings, getRatingForItem, clearedForAge } from "../utils/useRatings";
import { isRestricted } from "../utils/ageRating";
import { loadHomeLayout, loadHomeViewMode } from "../utils/homeLayout";

/**
 * Extract up to `count` unique, recently watched items from the user's
 * history (within the last 30 days).  Returns newest-first and dedupes
 * by TMDB id + media_type so we don't fire duplicate API calls.
 */
function getRecentHistoryItems(history, count = 5) {
  if (!history || history.length === 0) return [];
  const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const recent = history
    .filter((h) => h.watchedAt && h.watchedAt > thirtyDaysAgo)
    .sort((a, b) => b.watchedAt - a.watchedAt);

  const seen = new Set();
  const unique = [];
  for (const item of recent) {
    const key = `${item.media_type || "movie"}_${item.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
    if (unique.length >= count) break;
  }
  return unique;
}

const CONTINUE_LIMIT = 12; // The whole list lives in the library.
const TODAY = new Date().toISOString().slice(0, 10);

export default function HomePage({
  trending,
  trendingTV,
  loading,
  onSelect,
  progress,
  inProgress,
  offline,
  onRetry,
  watched,
  onMarkWatched,
  onMarkUnwatched,
  history,
  apiKey,
  onNavigate,
}) {
  // Drop anime from every discovery surface when the "Hide anime" setting is on.
  const trendingMoviesRaw = useMemo(() => filterAnime(trending), [trending]);
  const trendingTVRaw = useMemo(() => filterAnime(trendingTV), [trendingTV]);
  const [recommendedItems, setRecommendedItems] = useState([]);
  const [topRatedItems, setTopRatedItems] = useState([]);

  // Load layout config (order + visibility) once on mount
  const [layout] = useState(() => loadHomeLayout());
  const { order: rowOrder, visible: rowVisible } = layout;

  const [viewMode] = useState(() => loadHomeViewMode());

  // All items for batch ratings fetch
  const allItems = useMemo(
    () => [
      ...inProgress,
      ...trending.map((i) => ({ ...i, media_type: "movie" })),
      ...trendingTV.map((i) => ({ ...i, media_type: "tv" })),
      ...recommendedItems,
      ...topRatedItems,
    ],
    [inProgress, trending, trendingTV, recommendedItems, topRatedItems],
  );

  const { ratingsMap, ageLimitSetting } = useRatings(allItems);

  const getRating = useCallback(
    (item) => getRatingForItem(item, ratingsMap),
    [ratingsMap],
  );
  const itemRestricted = useCallback(
    (item) =>
      isRestricted(getRatingForItem(item, ratingsMap).minAge, ageLimitSetting),
    [ratingsMap, ageLimitSetting],
  );

  // Enrich ratingsMap with restricted flag for carousels
  const enrichedRatingsMap = useMemo(() => {
    const out = {};
    for (const [k, v] of Object.entries(ratingsMap)) {
      out[k] = { ...v, restricted: isRestricted(v.minAge, ageLimitSetting) };
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ratingsMap, ageLimitSetting]);

  // Filter recommended items that exceed age limit setting (and anime, if hidden)
  const filteredRecommendedItems = useMemo(() => {
    return filterAnime(recommendedItems).filter((item) => !itemRestricted(item));
  }, [recommendedItems, itemRestricted]);

  // Fetch personalised recommendations from multiple recent history items
  useEffect(() => {
    if (!apiKey || offline || !history || history.length === 0) return;
    const sources = getRecentHistoryItems(history, 5);
    if (sources.length === 0) return;

    const controller = new AbortController();

    // Build a Set of already-watched TMDB ids for dedup
    const watchedIds = new Set(
      (history || []).map((h) => `${h.media_type || "movie"}_${h.id}`),
    );

    // For each source, try /recommendations first, fall back to /similar
    const fetches = sources.map((source) => {
      const type = source.media_type === "tv" ? "tv" : "movie";
      return tmdbFetch(`/${type}/${source.id}/recommendations`, apiKey, {
        signal: controller.signal,
      })
        .then((data) => {
          const results = (data.results || []).map((i) => ({
            ...i,
            media_type: type,
          }));
          if (results.length > 0) return results;
          // Fall back to /similar if /recommendations returned nothing
          return tmdbFetch(`/${type}/${source.id}/similar`, apiKey, {
            signal: controller.signal,
          }).then((d) =>
            (d.results || []).map((i) => ({ ...i, media_type: type })),
          );
        })
        .catch(() => []);
    });

    Promise.all(fetches)
      .then((arrays) => {
        // Interleave results from each source for variety
        const merged = [];
        const maxLen = Math.max(...arrays.map((a) => a.length));
        for (let i = 0; i < maxLen; i++) {
          for (const arr of arrays) {
            if (arr[i]) merged.push(arr[i]);
          }
        }

        // Deduplicate and filter out already-watched items
        const seen = new Set();
        const deduped = merged.filter((item) => {
          const key = `${item.media_type}_${item.id}`;
          if (seen.has(key) || watchedIds.has(key)) return false;
          seen.add(key);
          return true;
        });

        setRecommendedItems(deduped.slice(0, 20));
      })
      .catch((e) => {
        if (e.name !== "AbortError")
          console.warn("Recommendations fetch failed", e);
      });

    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey, offline, history?.length]);

  // Fetch top rated movies + TV, merge and shuffle
  useEffect(() => {
    if (!apiKey || offline) return;
    const controller = new AbortController();
    Promise.all([
      tmdbFetch("/movie/top_rated?page=1", apiKey, {
        signal: controller.signal,
      }),
      tmdbFetch("/tv/top_rated?page=1", apiKey, { signal: controller.signal }),
    ])
      .then(([moviesData, tvData]) => {
        const movies = (moviesData.results || [])
          .slice(0, 8)
          .map((i) => ({ ...i, media_type: "movie" }));
        const tv = (tvData.results || [])
          .slice(0, 8)
          .map((i) => ({ ...i, media_type: "tv" }));
        // Interleave movies and TV for variety
        const merged = [];
        const max = Math.max(movies.length, tv.length);
        for (let i = 0; i < max; i++) {
          if (movies[i]) merged.push(movies[i]);
          if (tv[i]) merged.push(tv[i]);
        }
        setTopRatedItems(merged);
      })
      .catch((e) => {
        if (e.name !== "AbortError") console.warn("Top rated fetch failed", e);
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiKey, offline]);

  // Wide cards need a still and a runtime, and history entries carry neither.
  const [continueDetails, setContinueDetails] = useState({});
  const continueItems = useMemo(() => inProgress.slice(0, CONTINUE_LIMIT), [inProgress]);
  const continueIds = continueItems.map((item) => `${item.media_type === "tv" ? "tv" : "movie"}/${item.id}`).join(",");
  useEffect(() => {
    if (!apiKey || offline || !continueIds) return undefined;
    const controller = new AbortController();
    continueIds.split(",").forEach((key) => {
      tmdbFetch(`/${key}`, apiKey, { signal: controller.signal, priority: "low" })
        .then((data) => setContinueDetails((prev) => ({ ...prev, [key]: data })))
        .catch(() => {});
    });
    return () => controller.abort();
  }, [apiKey, offline, continueIds]);
  const now = useMinuteClock();

  // Stable pre-built item arrays for carousels, capped at 10
  const trendingMovieItems = useMemo(
    () => trendingMoviesRaw.slice(0, 10).map((i) => ({ ...i, media_type: "movie" })),
    [trendingMoviesRaw],
  );
  const trendingTVItems = useMemo(
    () => trendingTVRaw.slice(0, 10).map((i) => ({ ...i, media_type: "tv" })),
    [trendingTVRaw],
  );
  const visibleTopRated = useMemo(() => filterAnime(topRatedItems), [topRatedItems]);
  const heroItems = useMemo(
    () => trendingMovieItems
      .filter((item) => (item.release_date || "") <= TODAY && clearedForAge(item, ratingsMap, ageLimitSetting))
      .slice(0, 7),
    [trendingMovieItems, ratingsMap, ageLimitSetting],
  );

  return (
    <div className="fade-in">
      {/* ── Offline ── */}
      {offline && (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            minHeight: "60vh",
            gap: 16,
            color: "var(--text2)",
          }}
        >
          <div style={{ fontSize: 48 }}>📡</div>
          <div style={{ fontSize: 20, fontWeight: 600, color: "var(--text)" }}>
            Нет подключения к интернету
          </div>
          <div style={{ fontSize: 14, color: "var(--text3)" }}>
            Для подборок и поиска нужен интернет. Загрузки и библиотека работают
            и без него.
          </div>
          <button
            className="btn btn-primary"
            style={{ marginTop: 8 }}
            onClick={onRetry}
          >
            Повторить
          </button>
        </div>
      )}

      {!offline && loading && (
        /* Skeletons, not a spinner: the page shape is visible immediately, so
           the wait reads as "content arriving" instead of "app working". The
           real rows swap in underneath the same grid geometry — no layout jump. */
        <div className="home-skeletons">
          {[0, 1, 2, 3].map((row) => (
            <div key={row} className="section">
              <div className="section-title skeleton-text" />
              <div className="cards-grid">
                {Array.from({ length: 10 }, (_, i) => (
                  <div key={i} className="skeleton-card">
                    <div className="skeleton-poster" />
                    <div className="skeleton-text skeleton-card-title" />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {!offline && !loading && heroItems.length > 0 && (
        <PosterCoverflow
          items={heroItems}
          apiKey={apiKey}
          progress={progress}
          watched={watched}
          onSelect={onSelect}
        />
      )}

      {/* ── Rows in user-configured order ── */}
      <div className="home-shelves">
      {rowOrder.map((id) => {
        if (!rowVisible[id]) return null;

        if (id === "continue") {
          if (inProgress.length === 0) return null;
          return (
            <PosterRow key="continue" title="Продолжить просмотр" wide>
              {continueItems.map((item) => {
                const type = item.media_type === "tv" ? "tv" : "movie";
                const isSeries = type === "tv";
                const pk = isSeries
                  ? `tv_${item.id}_s${item.season}e${item.episode}`
                  : `movie_${item.id}`;
                const pct = progress[pk] || 0;
                const full = continueDetails[`${type}/${item.id}`];
                const runtime = isSeries ? full?.episode_run_time?.[0] : full?.runtime;
                const place = isSeries ? `S${item.season}E${item.episode}` : null;
                const ends = runtime > 0 ? `закончите в ${clockAfter(minutesLeft(runtime, pct), now)}` : null;
                const rating = getRating(item);
                return (
                  <MediaCard
                    key={`${item.media_type}_${item.id}`}
                    item={{ ...item, backdrop_path: item.backdrop_path || full?.backdrop_path }}
                    onClick={onSelect}
                    progress={pct}
                    watched={watched}
                    onMarkWatched={onMarkWatched}
                    onMarkUnwatched={onMarkUnwatched}
                    ageRating={rating.cert}
                    restricted={itemRestricted(item)}
                    wide
                    note={[place, ends].filter(Boolean).join(", ") || null}
                    noteTone="plain"
                  />
                );
              })}
            </PosterRow>
          );
        }

        if (id === "tonightFit") {
          return (
            <TonightFitRow
              key="tonightFit"
              apiKey={offline ? null : apiKey}
              history={history}
              watched={watched}
              onSelect={onSelect}
              onMarkWatched={onMarkWatched}
              onMarkUnwatched={onMarkUnwatched}
            />
          );
        }

        if (id === "collections") {
          return <CollectionDecks key="collections" apiKey={offline ? null : apiKey} onNavigate={onNavigate} />;
        }

        const renderRow = (key, title, items, ranked = false) => (
          <PosterRow key={key} title={title} ranked={ranked}>
            {items.map((item) => {
              const rd = enrichedRatingsMap[`${item.media_type === "tv" ? "tv" : "movie"}_${item.id}`] || {};
              return (
                <MediaCard
                  key={`${item.media_type}_${item.id}`}
                  item={item}
                  onClick={onSelect}
                  progress={0}
                  watched={watched}
                  onMarkWatched={onMarkWatched}
                  onMarkUnwatched={onMarkUnwatched}
                  ageRating={rd.cert}
                  restricted={rd.restricted}
                />
              );
            })}
          </PosterRow>
        );

        // Render a section as a flat cards-grid (list view)
        const renderList = (key, title, titleHighlight, items) => {
          if (!items || items.length === 0) return null;
          return (
            <div key={key} className="section">
              <div className="section-title">
                {titleHighlight ? (
                  <>
                    {title}&nbsp;
                    <span style={{ color: "var(--red)" }}>
                      {titleHighlight}
                    </span>
                  </>
                ) : (
                  title
                )}
              </div>
              <ProgressiveGrid items={items}>
                {(visible) => visible.map((item) => {
                  const type = item.media_type === "tv" ? "tv" : "movie";
                  const rk = `${type}_${item.id}`;
                  const rd = enrichedRatingsMap[rk] || {};
                  return (
                    <MediaCard
                      key={`${item.media_type}_${item.id}`}
                      item={item}
                      onClick={onSelect}
                      progress={0}
                      watched={watched}
                      onMarkWatched={onMarkWatched}
                      onMarkUnwatched={onMarkUnwatched}
                      ageRating={rd.cert}
                      restricted={rd.restricted}
                    />
                  );
                })}
              </ProgressiveGrid>
            </div>
          );
        };

        if (id === "recommended") {
          if (filteredRecommendedItems.length === 0) return null;
          if (viewMode === "list")
            return renderList(
              "recommended",
              "Рекомендации для вас",
              null,
              filteredRecommendedItems,
            );
          return renderRow("recommended", "Рекомендации для вас", filteredRecommendedItems);
        }

        if (id === "trendingMovies") {
          if (trendingMovieItems.length === 0) return null;
          if (viewMode === "list")
            return renderList(
              "trendingMovies",
              "Популярные фильмы",
              null,
              trendingMovieItems,
            );
          return renderRow("trendingMovies", "Популярные фильмы", trendingMovieItems, true);
        }

        if (id === "trendingTV") {
          if (trendingTVItems.length === 0) return null;
          if (viewMode === "list")
            return renderList(
              "trendingTV",
              "Популярные сериалы",
              null,
              trendingTVItems,
            );
          return renderRow("trendingTV", "Популярные сериалы", trendingTVItems);
        }

        if (id === "topRated") {
          if (visibleTopRated.length === 0) return null;
          if (viewMode === "list")
            return renderList("topRated", "С высоким рейтингом", null, visibleTopRated);
          return renderRow("topRated", "С высоким рейтингом", visibleTopRated);
        }

        return null;
      })}
      </div>
    </div>
  );
}
