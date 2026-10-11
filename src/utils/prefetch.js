// ── Detail-page chunk prefetch ───────────────────────────────────────────────
// The detail pages (Movie/TV) are lazy()-loaded in App.jsx, so the first click
// on a poster pays the chunk download before anything renders — a visible
// freeze on a cold navigation. Hovering/focusing a card is a near-certain
// predictor of that click, and the dynamic import is free after the first call
// (same module instance React.lazy holds). One call per media type is enough;
// the import itself is the cache.
let done = new Set();

export function prefetchDetailPage(mediaType) {
  const kind = mediaType === "tv" ? "tv" : "movie";
  if (done.has(kind)) return;
  done.add(kind);
  try {
    // Same specifiers as App.jsx's lazy() calls — Rollup resolves them to the
    // same chunks, so this warms the cache the lazy boundary will read.
    const p = kind === "tv" ? import("../pages/TVPage") : import("../pages/MoviePage");
    if (p && typeof p.catch === "function") p.catch(() => { done.delete(kind); });
  } catch {
    done.delete(kind);
  }
}
