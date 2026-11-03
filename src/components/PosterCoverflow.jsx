// Home page hero: a 3D row of posters. The middle poster's colour lights the page
// behind it, and the end time answers "will I finish tonight?" before any click.
import { useEffect, useMemo, useRef, useState } from "react";
import { imgUrl, posterSize, tmdbFetch } from "../utils/api";
import { clockAfter, formatRuntime, minutesLeft, useMinuteClock } from "../utils/endTime";
import { RESUME_MAX_PERCENT } from "../utils/playbackCompletion";
import { prefetchDetailPage } from "../utils/prefetch";
import usePosterGlow from "../utils/usePosterGlow";
import { ChevronLeftIcon, ChevronRightIcon, PlayIcon } from "./Icons";

const SWIPE_PX = 40;

export default function PosterCoverflow({ items, apiKey, progress, watched, onSelect }) {
  const count = items.length;
  // By id, not position: the list can shrink when age ratings arrive, and the
  // film in the middle must not change by itself.
  const [activeId, setActiveId] = useState(null);
  const active = Math.max(0, items.findIndex((slide) => slide.id === activeId));
  const item = items[active];
  const [details, setDetails] = useState({});
  const touchX = useRef(null);
  const now = useMinuteClock();
  const glow = usePosterGlow(item?.poster_path);

  const id = item?.id;
  useEffect(() => {
    if (!id || !apiKey || details[id]) return undefined;
    const controller = new AbortController();
    tmdbFetch(`/movie/${id}`, apiKey, { signal: controller.signal })
      .then((data) => setDetails((prev) => ({ ...prev, [id]: data })))
      .catch(() => {});
    return () => controller.abort();
  }, [id, apiKey, details]);

  const slides = useMemo(() => items.map((slide, index) => {
    // Shortest way round the ring, so the row wraps without a visible jump.
    const raw = ((index - active) % count + count) % count;
    const offset = raw > count / 2 ? raw - count : raw;
    return { slide, offset, abs: Math.abs(offset) };
  }), [items, active, count]);

  if (!item) return null;

  const go = (next) => setActiveId(items[((next % count) + count) % count].id);
  const info = details[item.id];
  const runtime = info?.runtime;
  const pct = progress?.[`movie_${item.id}`] || 0;
  const resumable = !watched?.[`movie_${item.id}`] && pct > 0 && pct < RESUME_MAX_PERCENT;
  const title = item.title || item.name;
  const genres = (info?.genres || []).slice(0, 2).map((genre) => genre.name.toLowerCase());
  const meta = [(item.release_date || "").slice(0, 4), ...genres, runtime ? formatRuntime(runtime) : null].filter(Boolean).join(", ");

  return (
    <section
      className="flow-hero"
      aria-label="Сейчас популярно"
      style={glow ? { "--flow-glow": glow } : undefined}
    >
      <div className="flow-hero__light" aria-hidden="true" />
      <div
        className="flow-stage"
        onTouchStart={(event) => { touchX.current = event.touches[0].clientX; }}
        onTouchEnd={(event) => {
          if (touchX.current == null) return;
          const moved = event.changedTouches[0].clientX - touchX.current;
          touchX.current = null;
          if (Math.abs(moved) > SWIPE_PX) go(active + (moved < 0 ? 1 : -1));
        }}
      >
        {slides.map(({ slide, offset, abs }) => (
          <button
            key={slide.id}
            type="button"
            className={`flow-slide${offset === 0 ? " flow-slide--active" : ""}`}
            style={{
              "--a": abs,
              "--g": Math.sign(offset),
              zIndex: 10 - abs,
              opacity: abs > 3 ? 0 : 1,
              pointerEvents: abs > 3 ? "none" : undefined,
            }}
            tabIndex={offset === 0 ? 0 : -1}
            aria-hidden={abs > 3 ? true : undefined}
            aria-label={`${offset === 0 ? "Открыть" : "Показать"}: ${slide.title || slide.name}`}
            onClick={() => (offset === 0 ? onSelect(slide) : go(active + offset))}
            onPointerEnter={offset === 0 ? () => prefetchDetailPage("movie") : undefined}
          >
            {slide.poster_path ? (
              <img
                src={imgUrl(slide.poster_path, posterSize(280))}
                alt=""
                draggable={false}
                decoding="async"
                loading={abs > 2 ? "lazy" : "eager"}
                fetchpriority={offset === 0 ? "high" : undefined}
              />
            ) : (
              <span className="flow-slide__blank">{slide.title || slide.name}</span>
            )}
          </button>
        ))}
        {count > 1 && <>
          <button type="button" className="flow-arrow flow-arrow--prev" aria-label="Предыдущий фильм" onClick={() => go(active - 1)}><ChevronLeftIcon /></button>
          <button type="button" className="flow-arrow flow-arrow--next" aria-label="Следующий фильм" onClick={() => go(active + 1)}><ChevronRightIcon /></button>
        </>}
      </div>
      <div className="flow-info">
        <h1 className="flow-info__title">{title}</h1>
        <p className="flow-info__meta">
          {meta && <span>{meta}</span>}
          {item.vote_average > 0 && <span className="flow-info__score">TMDB {item.vote_average.toFixed(1)}</span>}
        </p>
        <div className="flow-info__actions">
          <button type="button" className="btn btn-primary" onClick={() => onSelect(item)}>
            <PlayIcon /> {resumable ? "Продолжить" : "Смотреть"}
          </button>
          {runtime > 0 && (
            <span className="flow-info__ends">Закончите в {clockAfter(minutesLeft(runtime, resumable ? pct : 0), now)}</span>
          )}
        </div>
      </div>
    </section>
  );
}
