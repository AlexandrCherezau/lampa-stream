import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { cubFeed } from "../utils/cub-client";
import { filterAnime } from "../utils/api";
import { useRatings, getRatingForItem } from "../utils/useRatings";
import { isRestricted } from "../utils/ageRating";
import ProgressiveGrid from "../utils/useProgressiveList.jsx";
import MediaCard from "./MediaCard";
import TrendingCarousel from "./TrendingCarousel";

export default function CubFeedSection({ feed, title, offline, viewMode, onSelect, watched, onMarkWatched, onMarkUnwatched, loadFeed = cubFeed, sourceLabel = "CUB" }) {
  const [items, setItems] = useState([]);
  const [page, setPage] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [unmapped, setUnmapped] = useState(0);
  const requestRef = useRef(null);
  const nextPageRef = useRef(1);
  const { ratingsMap, ageLimitSetting } = useRatings(items);
  const visibleItems = useMemo(() => filterAnime(items), [items]);
  const enrichedRatings = useMemo(() => Object.fromEntries(
    items.map((item) => {
      const rating = getRatingForItem(item, ratingsMap);
      return [`${item.media_type}_${item.id}`, { ...rating, restricted: isRestricted(rating.minAge, ageLimitSetting) }];
    }),
  ), [items, ratingsMap, ageLimitSetting]);

  const loadPage = useCallback(async (requestedPage) => {
    if (offline || requestRef.current) return;
    const controller = new AbortController();
    requestRef.current = controller;
    nextPageRef.current = requestedPage;
    setLoading(true);
    setError(false);
    try {
      const data = await loadFeed(feed, requestedPage, { signal: controller.signal });
      if (controller.signal.aborted) return;
      setItems((previous) => {
        const seen = new Set();
        return [...(requestedPage === 1 ? [] : previous), ...data.results].filter((item) => {
          const key = `${item.media_type}_${item.id}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
      });
      setPage(data.page);
      setTotalPages(data.total_pages);
      setUnmapped(data.unmapped || 0);
    } catch {
      if (!controller.signal.aborted) setError(true);
    } finally {
      if (requestRef.current === controller) {
        requestRef.current = null;
        if (!controller.signal.aborted) setLoading(false);
      }
    }
  }, [feed, offline, loadFeed]);

  useEffect(() => {
    loadPage(1);
    return () => {
      requestRef.current?.abort();
      requestRef.current = null;
    };
  }, [loadPage]);

  return (
    <section className="section" aria-label={`${sourceLabel}: ${title}`}>
      {viewMode === "list" || visibleItems.length === 0 ? (
        <>
          <div className="section-title">{title}</div>
          <ProgressiveGrid items={visibleItems}>
            {(visible) => visible.map((item) => {
              const rating = enrichedRatings[`${item.media_type}_${item.id}`];
              return <MediaCard key={`${item.media_type}_${item.id}`} item={item} onClick={onSelect}
                watched={watched} onMarkWatched={onMarkWatched} onMarkUnwatched={onMarkUnwatched}
                ageRating={rating?.cert} restricted={rating?.restricted} />;
            })}
          </ProgressiveGrid>
        </>
      ) : (
        <TrendingCarousel items={visibleItems} title={title} onSelect={onSelect} ratingsMap={enrichedRatings} />
      )}
      <div style={{ marginTop: 16 }} aria-live="polite">
        {error && <p role="alert" style={{ color: "var(--text2)" }}>Не удалось загрузить подборку. Уже загруженные фильмы доступны.</p>}
        {!loading && !error && page > 0 && items.length === 0 && <p style={{ color: "var(--text2)" }}>В подборке пока нет фильмов.</p>}
        {!loading && !error && unmapped > 0 && <p style={{ color: "var(--text2)" }}>Некоторые фильмы пока недоступны в каталоге: {unmapped}.</p>}
        {(loading || error || page < totalPages) && (
          <button className="btn btn-secondary" disabled={loading || offline}
            onClick={() => loadPage(error ? nextPageRef.current : page + 1)}>
            {loading ? "Загрузка…" : error ? "Повторить" : "Показать ещё"}
          </button>
        )}
      </div>
    </section>
  );
}
