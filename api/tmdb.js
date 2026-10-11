// Vercel serverless function: forward TMDB API + image requests.
// Vercel's network is outside Russia, so it reaches api.themoviedb.org /
// image.tmdb.org directly — no DoH needed (that was only for the in-Russia PC).
// CORS is open (the visitor's browser is the only client).
//
// Token model: when TMDB_READ_TOKEN is configured on the deployment, EVERY
// request is made with it and the response is edge-shareable — TMDB read
// access is identical for all visitors, so one shared token costs one quota
// unit per unique URL instead of one per visitor per request. Without it, the
// visitor's own Bearer token is forwarded and the response stays `private`
// (it is keyed to their token). The desktop/Express flow already hands every
// visitor the same shared token; this makes the serverless path match.

// Upstream RESPONSE-HEADERS deadline. TMDB occasionally stalls on some
// endpoints (trending week, /popular/*) — without a deadline the function
// hangs until Vercel's platform timeout, which surfaces to the visitor as a
// client-side "Request timed out" instead of a fast 502. 6 s is well under
// Vercel's hobby maxDuration.
const HEADERS_TIMEOUT_MS = 6000;
// Body deadline: an IDLE timer, reset on every chunk. A headers-only timeout
// (the old single 8 s AbortSignal covered the body too) aborted large but
// healthy /discover payloads mid-transfer on a slow mobile link.
const BODY_IDLE_TIMEOUT_MS = 60000;

// Vercel function execution limit. Keep above HEADERS_TIMEOUT_MS so the
// timeout-abort produces a 502 response instead of Vercel killing the fn.
export const maxDuration = 60;

// Cache policy.
// Images: image.tmdb.org paths are content-addressed (the hash IS the filename),
// so a given /t/p/<size>/<hash>.jpg never changes → cache forever, and let the
// Vercel edge serve repeat hits so we stop paying a function invocation (and
// Fast Origin Transfer) for every poster. `stale-while-revalidate` keeps the
// edge answering instantly even past the TTL.
const IMG_CACHE_CONTROL =
  "public, max-age=31536000, immutable, s-maxage=31536000, stale-while-revalidate=86400";
// API (shared-token mode): plain TMDB metadata, identical for every visitor —
// edge-cacheable. 30 min browser / 5 min edge with a day-long stale window:
// metadata this old is indistinguishable from fresh, and an edge hit costs no
// TMDB quota at all.
const API_CACHE_CONTROL_SHARED =
  "public, max-age=1800, s-maxage=300, stale-while-revalidate=86400";
// API (per-visitor-token mode): the payload depends on whose token asked for
// it, so it stays out of any shared cache; the browser may reuse it for 5 min
// (mirrors the in-memory TMDB cache TTL and makes a page reload nearly free).
const API_CACHE_CONTROL_PRIVATE = "private, max-age=300, stale-while-revalidate=600";

export default async function handler(req, res) {
  // CORS preflight
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();

  // Route: /api/tmdb/3/movie/550  →  https://api.themoviedb.org/3/movie/550
  // Route: /api/tmdb/img/t/p/w500/x.jpg  →  https://image.tmdb.org/t/p/w500/x.jpg
  // (images are served through the same proxy to avoid mixed-content/CORS issues)
  const url = new URL(req.url, "http://x");
  const path = url.pathname.replace(/^\/api\/tmdb/, "");
  const isImage = path.startsWith("/img/");
  const target =
    (isImage ? "https://image.tmdb.org" : "https://api.themoviedb.org") +
    (isImage ? path.replace(/^\/img/, "") : path) +
    (url.search || "");

  const serverToken = process.env.TMDB_READ_TOKEN || "";
  const visitorToken = req.headers.authorization || "";
  const token = serverToken || visitorToken;
  const shared = !isImage && !!serverToken; // edge-shareable only in shared-token mode

  const ctrl = new AbortController();
  const headersTimer = setTimeout(() => ctrl.abort(new Error("headers timeout")), HEADERS_TIMEOUT_MS);
  let idleTimer = null;
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => ctrl.abort(new Error("body idle timeout")), BODY_IDLE_TIMEOUT_MS);
  };
  ctrl.signal.addEventListener("abort", () => { if (idleTimer) clearTimeout(idleTimer); });

  try {
    let upstream = await fetch(target, {
      headers: token ? { Authorization: `Bearer ${token.replace(/^Bearer\s+/i, "")}` } : {},
      signal: ctrl.signal,
    });
    clearTimeout(headersTimer);

    // A misconfigured deployment token must not break visitors who brought
    // their own: on a 401 in shared mode with a visitor token in hand, retry
    // once with theirs (and keep that response private — it is theirs).
    let sharedFinal = shared;
    if (upstream.status === 401 && shared && visitorToken && visitorToken !== token) {
      try { await upstream.arrayBuffer(); } catch {}
      upstream = await fetch(target, {
        headers: { Authorization: visitorToken },
        signal: ctrl.signal,
      });
      if (upstream.ok) sharedFinal = false;
    }

    res.status(upstream.status);
    // Pass through content-type; images need their real type.
    const ct = upstream.headers.get("content-type");
    if (ct) res.setHeader("Content-Type", ct);
    if (upstream.ok) {
      res.setHeader("Cache-Control", isImage ? IMG_CACHE_CONTROL : sharedFinal ? API_CACHE_CONTROL_SHARED : API_CACHE_CONTROL_PRIVATE);
      // The per-visitor response depends on whose token asked for it.
      if (!isImage && !sharedFinal) res.setHeader("Vary", "Authorization");
    } else {
      // Never cache an upstream failure — a transient 429/5xx must not stick.
      res.setHeader("Cache-Control", "no-store");
    }

    // HEAD, or a body-less response: nothing to stream.
    if (req.method === "HEAD" || !upstream.body) {
      if (idleTimer) clearTimeout(idleTimer);
      return res.end();
    }

    // Stream the body instead of buffering it: the old shape did
    // `Buffer.from(await upstream.arrayBuffer())`, which held the whole payload
    // in function memory and coupled the body read to a single 8 s deadline.
    const { Readable } = await import("node:stream");
    const body = Readable.fromWeb(upstream.body);
    armIdle();
    body.on("data", armIdle);
    res.on("close", () => { if (idleTimer) clearTimeout(idleTimer); body.destroy(); });
    body.pipe(res);
    return;
  } catch (e) {
    if (idleTimer) clearTimeout(idleTimer);
    const isTimeout = e && (e.name === "TimeoutError" || e.name === "AbortError" || /timeout/i.test(e.message || ""));
    res.setHeader("Cache-Control", "no-store");
    if (!res.headersSent) {
      res
        .status(isTimeout ? 504 : 502)
        .json({ error: isTimeout ? "TMDB upstream timeout" : "TMDB upstream error", message: e.message });
    } else {
      // Headers already went out (mid-body abort): kill the response so the
      // client sees a truncated body rather than a silently cut one.
      res.destroy();
    }
  }
}
