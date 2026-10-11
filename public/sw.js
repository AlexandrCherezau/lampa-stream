// ── Lampa-Stream service worker (web builds only) ───────────────────────────
// What it buys:
//   • repeat visits boot from cache — the shell paints before the network
//     answers, and hashed /assets/* never hit the network at all;
//   • TMDB metadata/images are served stale-while-revalidate, so a warm home
//     page renders from cache instantly and refreshes in the background;
//   • the app shell works offline (downloads/library are already local).
//
// What it must NEVER touch: /api/lampac (video segments, manifests, probes —
// per-request, per-seek, unbounded) and /api/room (live shared state). Those
// pass straight through, as does anything non-GET and anything cross-origin.
const VERSION = "v1";
const SHELL_CACHE = `lampa-shell-${VERSION}`;
const TMDB_CACHE = `lampa-tmdb-${VERSION}`;
const SHELL_URLS = ["/", "/index.html", "/logo.svg"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((c) => c.addAll(SHELL_URLS))
      .then(() => self.skipWaiting())
      .catch(() => { /* a failed precache must not block activation */ }),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k.startsWith("lampa-") && k !== SHELL_CACHE && k !== TMDB_CACHE)
            .map((k) => caches.delete(k)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

const isTmdb = (url) => url.pathname.startsWith("/api/tmdb/");

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // Streams and live room state are never cached.
  if (url.pathname.startsWith("/api/lampac") || url.pathname.startsWith("/api/room")) return;

  // Navigations: network-first so a deploy is picked up immediately, cache as
  // the offline fallback.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then((c) => c.put("/index.html", copy));
          return res;
        })
        .catch(() =>
          caches.match("/index.html").then((hit) => hit || caches.match("/")),
        ),
    );
    return;
  }

  // Hashed build assets: immutable — cache-first, forever.
  if (url.pathname.startsWith("/assets/") || url.pathname.startsWith("/vendor/")) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(SHELL_CACHE).then((c) => c.put(req, copy));
            }
            return res;
          }),
      ),
    );
    return;
  }

  // TMDB metadata + images: stale-while-revalidate.
  if (isTmdb(url)) {
    event.respondWith(
      caches.match(req).then((hit) => {
        const revalidate = fetch(req)
          .then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(TMDB_CACHE).then((c) => c.put(req, copy));
            }
            return res;
          })
          .catch(() => hit);
        return hit || revalidate;
      }),
    );
  }
});
