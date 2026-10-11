import { useState, useEffect, useRef, useCallback, memo } from "react";
import { imgUrl, isAnimeContent, posterSize } from "../utils/api";
import useElementWidth from "../utils/useElementWidth";
import { prefetchDetailPage } from "../utils/prefetch";
import {
  PlayIcon,
  FilmIcon,
  TVIcon,
  WatchedIcon,
  RatingShieldIcon,
  RatingLockIcon,
} from "./Icons";

// Unreleased detection — one shared "today" for every card instead of a fresh
// Date() per render (this used to run on every reconciliation of every card).
const TODAY = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; })();

const MediaCard = memo(function MediaCard({
  item,
  onClick,
  progress,
  watched,
  onMarkWatched,
  onMarkUnwatched,
  ageRating,
  restricted,
}) {
  const title = item.title || item.name;
  const year = (item.release_date || item.first_air_date || "").slice(0, 4);
  const isTV = item.media_type === "tv";
  const isAnime = isAnimeContent(item);

  // Hover/focus on a card is a near-certain predictor of a click: warm the
  // detail-page chunk now so the navigation doesn't pay for it.
  const warmChunk = useCallback(() => prefetchDetailPage(item.media_type), [item.media_type]);

  // Unreleased detection
  const rawDate = item.release_date || item.first_air_date;
  const isUnreleased = rawDate ? new Date(rawDate) > TODAY : false;

  // Build watched key for TV cards from Continue Watching we get season/episode
  const watchedKey = isTV
    ? item.season != null && item.episode != null
      ? `tv_${item.id}_s${item.season}e${item.episode}`
      : `tv_${item.id}`
    : `movie_${item.id}`;

  const isWatched = !!watched?.[watchedKey];

  // Poster slots are fluid (auto-fill grid, 100–191 px across breakpoints and
  // compact mode), so the rung is chosen from the measured width. Until the
  // first measurement lands the <img> is held back rather than guessing a size —
  // useElementWidth resolves within the same commit, before paint.
  const [posterRef, posterWidth] = useElementWidth();

  // Context menu state
  const [menu, setMenu] = useState(null); // { x, y }
  const menuRef = useRef(null);

  // For TV series cards without a specific episode, watched marking is disabled
  const canMarkWatched = !isTV || (item.season != null && item.episode != null);

  const openMenu = useCallback(
    (e) => {
      if (!canMarkWatched) return; // no context menu for whole series
      e.preventDefault();
      e.stopPropagation();
      setMenu({ x: e.clientX, y: e.clientY });
    },
    [canMarkWatched],
  );

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    window.addEventListener("click", close);
    window.addEventListener("contextmenu", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("contextmenu", close);
    };
  }, [menu]);

  const handleMarkWatched = (e) => {
    e.stopPropagation();
    onMarkWatched?.(watchedKey);
    setMenu(null);
  };
  const handleMarkUnwatched = (e) => {
    e.stopPropagation();
    onMarkUnwatched?.(watchedKey);
    setMenu(null);
  };

  return (
    <>
      <div
        className={`card${isWatched ? " ep-watched" : ""}${isUnreleased ? " card--unreleased" : ""}`}
        onClick={() => onClick(item)}
        onMouseEnter={warmChunk}
        onFocus={warmChunk}
        onTouchStart={warmChunk}
        onContextMenu={isUnreleased ? undefined : openMenu}
      >
        <div className="card-poster" ref={posterRef}>
          {item.poster_path ? (
            posterWidth > 0 && (
              <img
                src={imgUrl(item.poster_path, posterSize(posterWidth))}
                alt={title}
                loading="lazy"
                decoding="async"
              />
            )
          ) : (
            <div className="no-poster">
              {isTV ? <TVIcon /> : <FilmIcon />}
              <span style={{ fontSize: 10, color: "var(--text3)" }}>
                No Image
              </span>
            </div>
          )}
          {ageRating && (
            <div
              className={`card-age-badge${restricted ? " card-age-badge--restricted" : ""}`}
            >
              {restricted ? (
                <RatingLockIcon size={9} />
              ) : (
                <RatingShieldIcon size={9} />
              )}
              {ageRating}
            </div>
          )}

          <div className="card-overlay">
            {isUnreleased ? (
              <div className="card-unreleased-overlay">
                <span className="card-unreleased-label">🔒 Unreleased</span>
              </div>
            ) : (
              <div className="card-play">
                <PlayIcon />
              </div>
            )}
          </div>
          {!isUnreleased && progress > 0 && !isWatched && (
            <div className="card-progress">
              <div
                className="card-progress-fill"
                style={{ width: `${Math.min(progress, 100)}%` }}
              />
            </div>
          )}
          {!isUnreleased && isWatched && (
            <div className="card-watched-badge">
              <WatchedIcon size={26} />
            </div>
          )}
        </div>
        <div className="card-info">
          <div className="card-title" title={title}>
            {title}
          </div>
          <div className="card-year">
            {isTV && item.season != null && item.episode != null
              ? `S${item.season}E${item.episode}${item.episodeName ? ` · ${item.episodeName}` : ""}`
              : `${year} · ${isTV ? "Сериал" : "Фильм"}`}
          </div>
        </div>
        <span
          className={`card-badge${isUnreleased ? " card-badge--unreleased" : ""}${isAnime && !isUnreleased ? " card-badge--anime" : ""}`}
        >
          {isUnreleased ? "СКОРО" : isAnime ? "АНИМЕ" : isTV ? "СЕРИАЛ" : "HD"}
        </span>
      </div>

      {menu && (
        <div
          ref={menuRef}
          className="context-menu"
          style={{ top: menu.y, left: menu.x }}
          onClick={(e) => e.stopPropagation()}
        >
          {isWatched ? (
            <button className="context-menu-item" onClick={handleMarkUnwatched}>
              ↩ Отметить непросмотренным
            </button>
          ) : (
            <button className="context-menu-item" onClick={handleMarkWatched}>
              ✓ Отметить просмотренным
            </button>
          )}
        </div>
      )}
    </>
  );
});
export default MediaCard;
