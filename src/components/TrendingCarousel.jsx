import { useState, useEffect, useRef, useCallback, useMemo, memo } from "react";
import { imgUrl, isAnimeContent, posterSize } from "../utils/api";
import useElementWidth from "../utils/useElementWidth";
import { StarIcon, ChevronLeftIcon, ChevronRightIcon } from "./Icons";

const VISIBLE = 5;
const HALF = Math.floor(VISIBLE / 2);

// ── Helpers ───────────────────────────────────────────────────────────────────

// ── Shared focus tracking (ONE listener for ALL carousels) ───────────────────
// Each carousel used to register its OWN scroll + resize listener, and every
// handler did a live querySelectorAll(".carousel-section") plus ~3
// getBoundingClientRect() per section — a forced synchronous layout flush per
// scroll event. With 4 carousels on the Home page that is 4 listeners × 4
// sections × 3 rect reads per scroll frame (~48 layout reads/frame at 60 Hz,
// double at 120 Hz): the direct cause of the reported scrolling jank. One
// shared rAF-throttled listener now measures ONCE per frame and hands every
// carousel its verdict through a ref callback (no re-render).
const focusSubs = new Set();
let focusRaf = 0;
let focusBound = false;

function measureFocus() {
  focusRaf = 0;
  const scrollRoot = document.querySelector(".main");
  const rootTop = scrollRoot ? scrollRoot.getBoundingClientRect().top : 0;
  const rootHeight = scrollRoot
    ? scrollRoot.getBoundingClientRect().height
    : window.innerHeight;
  const all = document.querySelectorAll(".carousel-section");
  let bestEl = null;
  let bestRatio = -1;
  all.forEach((el) => {
    const r = el.getBoundingClientRect();
    const visTop = Math.max(r.top, rootTop);
    const visBottom = Math.min(r.bottom, rootTop + rootHeight);
    const px = Math.max(0, visBottom - visTop);
    const ratio = r.height > 0 ? px / r.height : 0;
    if (ratio > bestRatio) {
      bestRatio = ratio;
      bestEl = el;
    }
  });
  for (const cb of focusSubs) cb(bestEl, bestRatio);
}

function scheduleFocusMeasure() {
  if (focusRaf) return;
  focusRaf = requestAnimationFrame(measureFocus);
}

function subscribeFocus(cb) {
  focusSubs.add(cb);
  if (!focusBound) {
    focusBound = true;
    // scroll events don't bubble, so a div scroller (.main) never reaches a
    // window listener — bind both. Double delivery is harmless: the rAF
    // throttle coalesces them into one measurement.
    const main = document.querySelector(".main");
    window.addEventListener("scroll", scheduleFocusMeasure, { passive: true });
    if (main) main.addEventListener("scroll", scheduleFocusMeasure, { passive: true });
    window.addEventListener("resize", scheduleFocusMeasure, { passive: true });
  }
  return () => {
    focusSubs.delete(cb);
    if (!focusSubs.size && focusBound) {
      focusBound = false;
      if (focusRaf) { cancelAnimationFrame(focusRaf); focusRaf = 0; }
      const main = document.querySelector(".main");
      window.removeEventListener("scroll", scheduleFocusMeasure);
      if (main) main.removeEventListener("scroll", scheduleFocusMeasure);
      window.removeEventListener("resize", scheduleFocusMeasure);
    }
  };
}

// ── Sub-components ────────────────────────────────────────────────────────────

const RatingBadge = memo(function RatingBadge({ cert, restricted }) {
  if (!cert) return null;
  return (
    <span
      className={`carousel-rating-badge${restricted ? " carousel-rating-badge--restricted" : ""}`}
      title={restricted ? "Age-restricted" : `Rated ${cert}`}
    >
      {cert}
    </span>
  );
});

const CarouselSlot = memo(function CarouselSlot({
  item,
  offset,
  onSelect,
  onFocus,
  animating,
  ageRating,
  restricted,
  isAnime,
  posterWidth,
  posterRef,
}) {
  if (!item) return null;
  const isCenter = offset === 0;
  const abs = Math.abs(offset);
  const title = item.title || item.name;
  const year = (item.release_date || item.first_air_date || "").slice(0, 4);
  // One rung for every slot, sized for the centre (the biggest, and the only one
  // read closely). Sizing each slot to its own `scale()` would look tempting —
  // the ±2 slots render at 54 % — but items rotate through the offsets, so the
  // same poster would be re-fetched at a new width on every step. A single URL
  // is served from cache for the whole cycle.
  const poster = posterWidth
    ? imgUrl(item.poster_path, posterSize(posterWidth))
    : null;

  const scale = isCenter ? 1 : abs === 1 ? 0.75 : 0.54;
  const opacity = isCenter ? 1 : abs === 1 ? 0.65 : 0.35;
  const tx = offset * 230;

  // Stable date comparison — avoids new Date() on every render by caching today
  const rawDate = item.release_date || item.first_air_date;
  const isUnreleased = useMemo(() => {
    if (!rawDate) return false;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return new Date(rawDate) > today;
  }, [rawDate]);

  const releaseLabel = useMemo(
    () =>
      rawDate
        ? new Date(rawDate).toLocaleDateString(undefined, {
            month: "short",
            day: "numeric",
            year: "numeric",
          })
        : null,
    [rawDate],
  );

  return (
    <div
      className={`carousel-item${isCenter ? " carousel-item--active" : ""}${animating ? " carousel-item--animating" : ""}`}
      style={{
        transform: `translateX(${tx}px) scale(${scale})`,
        opacity,
        zIndex: isCenter ? 10 : abs === 1 ? 6 : 2,
        cursor: "pointer",
        pointerEvents: "auto",
      }}
      onClick={isCenter ? onSelect : onFocus}
    >
      <div className="carousel-poster-wrap" ref={posterRef}>
        {item.poster_path ? (
          poster && (
            <img
              src={poster}
              alt={title}
              className="carousel-poster"
              draggable={false}
              loading={abs > 1 ? "lazy" : "eager"}
              decoding="async"
              /* lowercase: React 18 has no fetchPriority prop and warns on
                 camelCase unknown attributes, but passes lowercase through. */
              fetchpriority={isCenter ? "high" : undefined}
            />
          )
        ) : (
          <div className="carousel-poster carousel-poster--placeholder">
            <span>{title}</span>
          </div>
        )}

        {isUnreleased && (
          <div className="carousel-unreleased-overlay">
            <span className="carousel-unreleased-label">🔒 Coming Soon</span>
            {releaseLabel && (
              <span className="carousel-unreleased-date">{releaseLabel}</span>
            )}
          </div>
        )}

        {isCenter && item.vote_average > 0 && (
          <div className="carousel-score">
            <StarIcon size={10} />
            {item.vote_average.toFixed(1)}
          </div>
        )}
        {isCenter && (
          <div className="carousel-badge-wrap">
            <RatingBadge cert={ageRating} restricted={restricted} />
          </div>
        )}
        {isCenter && isAnime && (
          <div className="carousel-anime-badge">АНИМЕ</div>
        )}
      </div>

      {isCenter && (
        <div className="carousel-info">
          <div className="carousel-info__title">{title}</div>
          <div className="carousel-info__meta">
            {year && <span>{year}</span>}
            {item.media_type && (
              <span className="carousel-info__type">
                {item.media_type === "tv" ? "Сериал" : "Фильм"}
              </span>
            )}
          </div>
        </div>
      )}
    </div>
  );
});

// ── Main component ────────────────────────────────────────────────────────────

export default function TrendingCarousel({
  items,
  onSelect,
  title,
  titleHighlight,
  ratingsMap = {},
}) {
  const count = items.length;
  const activeRef = useRef(0);
  const [active, setActive] = useState(0);
  const [direction, setDirection] = useState(1);
  const [animating, setAnimating] = useState(false);

  const intervalRef = useRef(null);
  const isFocusedRef = useRef(false);
  const wheelThrottle = useRef(false);
  const touchStartX = useRef(null);
  const containerRef = useRef(null);
  const animTimeout = useRef(null);
  const sectionRef = useRef(null);

  // ── Navigation ─────────────────────────────────────────────────────────────

  const go = useCallback(
    (idx) => {
      const next = ((idx % count) + count) % count;
      const curr = activeRef.current;
      if (next === curr) return;
      const fwd = (next - curr + count) % count;
      setDirection(fwd <= count / 2 ? 1 : -1);
      setAnimating(true);
      clearTimeout(animTimeout.current);
      animTimeout.current = setTimeout(() => setAnimating(false), 420);
      activeRef.current = next;
      setActive(next);
    },
    [count],
  );

  const goNext = useCallback(() => go(activeRef.current + 1), [go]);
  const goPrev = useCallback(() => go(activeRef.current - 1), [go]);

  const startCycle = useCallback(() => {
    clearInterval(intervalRef.current);
    intervalRef.current = setInterval(() => go(activeRef.current + 1), 4500);
  }, [go]);

  // resetInterval: always restarts cycle (used after manual interaction)
  const resetInterval = useCallback(() => startCycle(), [startCycle]);

  // ── Focus-aware auto-cycle ─────────────────────────────────────────────────
  // Only the carousel that is MOST visible in .main cycles automatically.

  useEffect(() => {
    if (count <= 1) return;
    const sectionEl = sectionRef.current;
    if (!sectionEl) return;
    const scrollRoot = document.querySelector(".main");

    const updateFocus = (bestEl, bestRatio) => {
      const should = bestEl === sectionEl && bestRatio > 0.1;
      if (should && !isFocusedRef.current) {
        isFocusedRef.current = true;
        startCycle();
      } else if (!should && isFocusedRef.current) {
        isFocusedRef.current = false;
        clearInterval(intervalRef.current);
      }
    };

    const unsub = subscribeFocus(updateFocus);

    // IntersectionObserver for out-of-view fast-path (stop immediately when hidden)
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) {
          isFocusedRef.current = false;
          clearInterval(intervalRef.current);
        } else {
          // Back on screen: re-measure through the shared listener so every
          // carousel's verdict updates together in one layout pass.
          scheduleFocusMeasure();
        }
      },
      { root: scrollRoot, threshold: 0 },
    );
    observer.observe(sectionEl);

    // Initial check after first paint
    const id = requestAnimationFrame(() => measureFocus());

    return () => {
      unsub();
      observer.disconnect();
      cancelAnimationFrame(id);
      clearInterval(intervalRef.current);
    };
  }, [count, startCycle]);

  // ── Wheel ──────────────────────────────────────────────────────────────────

  const handleWheel = useCallback(
    (e) => {
      // Only capture the event when the gesture is horizontal.
      const isHorizontal = Math.abs(e.deltaX) > Math.abs(e.deltaY);
      if (!isHorizontal) return;

      e.preventDefault();
      if (wheelThrottle.current) return;
      wheelThrottle.current = true;
      setTimeout(() => {
        wheelThrottle.current = false;
      }, 600);
      if (e.deltaX > 0) {
        goNext();
      } else {
        goPrev();
      }
      resetInterval();
    },
    [goNext, goPrev, resetInterval],
  );

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.addEventListener("wheel", handleWheel, { passive: false });
    return () => el.removeEventListener("wheel", handleWheel);
  }, [handleWheel]);

  // ── Touch ──────────────────────────────────────────────────────────────────

  const onTouchStart = useCallback((e) => {
    touchStartX.current = e.touches[0].clientX;
  }, []);
  const onTouchEnd = useCallback(
    (e) => {
      if (touchStartX.current === null) return;
      const dx = e.changedTouches[0].clientX - touchStartX.current;
      touchStartX.current = null;
      if (Math.abs(dx) < 40) return;
      dx < 0 ? goNext() : goPrev();
      resetInterval();
    },
    [goNext, goPrev, resetInterval],
  );

  const handlePrev = useCallback(() => {
    goPrev();
    resetInterval();
  }, [goPrev, resetInterval]);
  const handleNext = useCallback(() => {
    goNext();
    resetInterval();
  }, [goNext, resetInterval]);
  const handleDot = useCallback(
    (i) => {
      go(i);
      resetInterval();
    },
    [go, resetInterval],
  );

  // ── Slot & rating data ─────────────────────────────────────────────────────

  // Stable slot array — only rebuilt when active or count changes
  const slots = useMemo(
    () =>
      Array.from({ length: VISIBLE }, (_, i) => {
        const offset = i - HALF;
        const idx = (((active + offset) % count) + count) % count;
        return { offset, idx };
      }),
    [active, count],
  );

  // Stable per-slot onSelect/onFocus handlers — keyed by offset so memo works
  const slotHandlers = useMemo(() => {
    const handlers = {};
    for (let i = 0; i < VISIBLE; i++) {
      const offset = i - HALF;
      const idx = (((active + offset) % count) + count) % count;
      if (offset === 0) {
        handlers[offset] = {
          onSelect: () => onSelect(items[idx]),
          onFocus: null,
        };
      } else {
        const captured = idx;
        handlers[offset] = {
          onSelect: null,
          onFocus: () => {
            go(captured);
            resetInterval();
          },
        };
      }
    }
    return handlers;
  }, [active, count, items, onSelect, go, resetInterval]);

  const activeItem = items[active];
  const activeType = activeItem?.media_type === "tv" ? "tv" : "movie";
  const activeRatingKey = activeItem ? `${activeType}_${activeItem.id}` : null;
  const activeRating = activeRatingKey ? ratingsMap[activeRatingKey] || {} : {};

  // Every slot has the same CSS width (`.carousel-poster-wrap`, 170 px / 120 px
  // on mobile) — `scale()` is a transform and doesn't change layout width — so
  // one measurement, taken on the centre slot, sizes all five. The ref rides on
  // the slot whose DOM node is keyed by offset, so it stays attached across
  // rotations.
  const [posterRef, posterWidth] = useElementWidth();

  const dotCount = Math.min(count, 15);

  if (!items || count === 0) return null;

  return (
    <div className="carousel-section" ref={sectionRef}>
      <div className="section-title">
        {titleHighlight ? (
          <>
            {title}&nbsp;
            <span style={{ color: "var(--red)" }}>{titleHighlight}</span>
          </>
        ) : (
          title
        )}
      </div>

      <div
        className="carousel-wrapper"
        ref={containerRef}
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
      >
        <button
          className="carousel-btn carousel-btn--left"
          onClick={handlePrev}
          aria-label="Предыдущий"
        >
          <ChevronLeftIcon size={22} />
        </button>

        <div
          className={`carousel-track${animating ? ` carousel-track--dir-${direction > 0 ? "fwd" : "bwd"}` : ""}`}
        >
          {slots.map(({ offset, idx }) => {
            const isCenter = offset === 0;
            const ratingData = isCenter ? activeRating : {};
            const h = slotHandlers[offset];
            return (
              <CarouselSlot
                key={offset}
                item={items[idx]}
                offset={offset}
                onSelect={h.onSelect}
                onFocus={h.onFocus}
                animating={animating}
                ageRating={isCenter ? ratingData.cert : null}
                restricted={isCenter ? ratingData.restricted : false}
                isAnime={isCenter ? isAnimeContent(items[idx]) : false}
                posterWidth={posterWidth}
                posterRef={isCenter ? posterRef : undefined}
              />
            );
          })}
        </div>

        <button
          className="carousel-btn carousel-btn--right"
          onClick={handleNext}
          aria-label="Следующий"
        >
          <ChevronRightIcon size={22} />
        </button>
      </div>

      <div className="carousel-dots">
        {Array.from({ length: dotCount }, (_, i) => (
          <button
            key={`dot-${i}`}
            className={`carousel-dot${active === i ? " carousel-dot--active" : ""}`}
            onClick={() => handleDot(i)}
            aria-label={`Перейти к ${i + 1}`}
          />
        ))}
        {count > 15 && (
          <span className="carousel-dots__more">+{count - 15}</span>
        )}
      </div>
    </div>
  );
}
