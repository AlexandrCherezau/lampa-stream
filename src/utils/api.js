// TMDB endpoints. When the main-process TMDB proxy is ON (default, for
// Russia/no-VPN), the renderer calls the local proxy http://127.0.0.1:<port>
// which forwards to the real api.themoviedb.org / image.tmdb.org with the
// user's Bearer token preserved. setTmdbProxyBase() is called by App on
// startup after querying the proxy state.
let TMDB_BASE = "https://api.themoviedb.org/3";
let IMG_BASE = "https://image.tmdb.org/t/p";
export function setTmdbProxyBase(port) {
  if (port === "web") {
    // Web mode: same-origin server routes. The Vercel serverless fn is at
    // /api/tmdb (handles both API and images via /api/tmdb/img/...).
    TMDB_BASE = "/api/tmdb/3";
    IMG_BASE = "/api/tmdb/img/t/p";
  } else if (port) {
    TMDB_BASE = `http://127.0.0.1:${port}/api/3`;
    IMG_BASE = `http://127.0.0.1:${port}/img/t/p`;
  } else {
    TMDB_BASE = "https://api.themoviedb.org/3";
    IMG_BASE = "https://image.tmdb.org/t/p";
  }
}
export const tmdbApiBase = () => TMDB_BASE;
export const tmdbImgBase = () => IMG_BASE;

// ── TMDB metadata language ────────────────────────────────────────────────────
// Read lazily from localStorage so it always reflects the current setting.
// Falls back to "ru" (short form — see withLanguage for why).
function getTmdbLanguage() {
  try {
    const raw = localStorage.getItem("streambert_tmdbLang");
    if (!raw) return "ru";
    const val = JSON.parse(raw);
    // Normalize "ru-RU" → "ru": TMDB's backend has a per-token routing bug where
    // the full "ru-RU" locale causes certain endpoints to hang indefinitely, while
    // the short "ru" form responds instantly with identical Russian content.
    if (typeof val === "string" && val.includes("-")) return val.split("-")[0];
    return val || "ru";
  } catch {
    return "ru";
  }
}

// Append the language query param to a TMDB path, canonicalizing query param
// ORDER — this is critical. TMDB has a backend routing bug (per Read Access
// Token) where the query-string parameter order determines whether a request
// hangs ~8s or responds in ~0.3s. The winning order is endpoint-specific:
//
//   /trending/*  →  page=1 FIRST, then language
//   everything else (genre, configuration, movie, discover, tv, search)  →
//                  language FIRST, then page=1 (added if not already present)
//
// "ru-RU" is normalized to "ru" by getTmdbLanguage() (same bug: full locale
// hangs, short form works, identical Russian content returned).
export function withLanguage(path) {
  const lang = getTmdbLanguage();
  const qIdx = path.indexOf("?");
  if (qIdx === -1) {
    // No query yet. /trending needs page first; others get language first.
    if (path.includes("/trending/")) return `${path}?page=1&language=${lang}`;
    return `${path}?language=${lang}`;
  }
  const base = path.slice(0, qIdx);
  const search = path.slice(qIdx + 1);
  const params = new URLSearchParams(search);
  // Always ensure language is set (caller may have added a different one).
  params.set("language", lang);
  // Rebuild in the order TMDB's backend expects for this token.
  const isTrending = base.includes("/trending/");
  const langStr = params.get("language");
  params.delete("language");
  const pageStr = params.get("page");
  // Ensure a page param exists (TMDB routing bug: its presence/position matters
  // even on endpoints that don't paginate — /genre, /configuration).
  if (!pageStr) params.set("page", "1");
  const pageVal = params.get("page");
  params.delete("page");
  // Remaining params keep their order (sort_by, with_genres, etc.).
  const rest = params.toString();
  let query;
  if (isTrending) {
    query = `page=${pageVal}&language=${langStr}${rest ? `&${rest}` : ""}`;
  } else {
    query = `language=${langStr}&page=${pageVal}${rest ? `&${rest}` : ""}`;
  }
  return `${base}?${query}`;
}

export const imgUrl = (path, size = "w500") =>
  path ? `${IMG_BASE}/${size}${path}` : null;

// TMDB serves a fixed ladder of widths per image kind. Asking for the rung that
// matches the DEVICE pixels a slot actually needs — CSS px × DPR — instead of a
// hardcoded w342 is the largest single transfer saving on the home page: a
// ~190 px card on a 1× display needs w185 (15.8 KB), not w342 (52.4 KB), and
// posters were 877 KB of a 1012 KB cold load.
//
// A rung may be slightly narrower than the slot it fills — the browser upscales
// and `object-fit: cover` plus a poster's own softness hide a few per cent. How
// much is acceptable depends on density, so the default tolerance follows it: at
// 1× a ~5 % stretch is the most that still looks crisp, while at 2× ~15 % is
// past what the eye resolves — and that looser bound is exactly what keeps
// retina posters on w342 rather than stepping up to w500 (74 KB). DPR is capped
// at 2 because a 3× rung buys nothing visible on an image this small.
function pickRung(rungs, cssWidth, tolerance) {
  const dpr =
    typeof window !== "undefined"
      ? Math.min(window.devicePixelRatio || 1, 2)
      : 1;
  const need = cssWidth * dpr * (tolerance ?? (dpr >= 2 ? 0.85 : 0.95));
  // Nothing wide enough → clamp to the top rung. Never fall through to
  // "original", which is unbounded (backdrops there run ~1 MB).
  return rungs.find((w) => w >= need) ?? rungs.at(-1);
}

const POSTER_RUNGS = [92, 154, 185, 342, 500, 780];
export function posterSize(cssWidth, tolerance) {
  return `w${pickRung(POSTER_RUNGS, cssWidth, tolerance)}`;
}

// Episode stills have their own, much shorter ladder.
const STILL_RUNGS = [92, 185, 300];
export function stillSize(cssWidth, tolerance) {
  return `w${pickRung(STILL_RUNGS, cssWidth, tolerance)}`;
}

// Backdrops sit behind a 35–45 % dark overlay and a gradient, so they tolerate a
// bigger stretch than a poster the eye reads directly — hence the fixed, looser
// 0.82. That is what lets a ~890 px content column take w780 (42.7 KB) instead
// of w1280 (142.5 KB); windows wider than ~950 px still get w1280.
const BACKDROP_RUNGS = [300, 780, 1280];
export function backdropSize(cssWidth, tolerance = 0.82) {
  return `w${pickRung(BACKDROP_RUNGS, cssWidth, tolerance)}`;
}

// Width the page content actually spans, for the full-bleed backdrops. `.main`
// is the app's scroll container and is always already in the DOM when a page
// renders a backdrop (those are gated on fetched data), so reading it during
// render is a synchronous, accurate substitute for measuring after mount —
// which would cost an extra render and delay the request by a frame. The
// viewport fallback is wider than the content column, so it can only ever
// over-estimate, never ask for too small a rung.
export function contentWidth() {
  if (typeof document === "undefined") return 1280;
  return (
    document.querySelector(".main")?.clientWidth || window.innerWidth || 1280
  );
}

// NOTE on images: on web these go through /api/tmdb/img/... on purpose. The
// audience is in Russia, where image.tmdb.org is DNS-poisoned/blocked, so a
// direct <img src="https://image.tmdb.org/..."> simply fails to connect
// (verified locally: ECONNREFUSED after 200 ms). api/tmdb.js now sends
// `immutable` cache headers for /img/*, so the Vercel edge and the browser both
// keep them and the function is only invoked on a true cold miss.

// Global auth-error callback, registered by App on mount
let _onAuthError = null;
let _onUnreachable = null;
export const setApiErrorHandlers = (onAuth, onUnreachable) => {
  _onAuthError = onAuth;
  _onUnreachable = onUnreachable;
};

// ── TMDB response cache ──────────────────────────────────────────────────────
// Two tiers:
//  • memory (Map)         — 5 min TTL, the hot path for in-session navigation.
//  • localStorage mirror  — 30 min TTL, so a page RELOAD doesn't refetch the
//    whole home page. Metadata this stale is indistinguishable from fresh, and
//    App.jsx already keeps a 30-min trending cache on the same reasoning.
// Only reasonably small payloads are mirrored (a few big /discover pages would
// blow the ~5 MB localStorage quota for no benefit).
const _tmdbCache = new Map(); // key → { data, expiresAt }
const TMDB_CACHE_TTL = 5 * 60 * 1000;
const TMDB_DISK_TTL = 30 * 60 * 1000;
const TMDB_DISK_KEY = "streambert_tmdbDiskCache";
// The mirror is a reload-survival nicety, not a second cache tier: its whole
// blob is re-serialized in ONE synchronous JSON.stringify + localStorage.setItem
// on the main thread, 1.5 s after the first response of a cold load — exactly
// when the user starts scrolling. 120 entries × 120 KB = up to ~14 MB of JSON
// work per flush (a visible multi-hundred-ms hitch). Sizing it to ~1 MB worst
// case keeps the same reload-survival benefit for the metadata payloads that
// actually fit, and the size gate below already refuses the big /discover
// responses that would blow the budget.
const TMDB_DISK_MAX_ENTRIES = 48;
const TMDB_DISK_MAX_ENTRY_BYTES = 24 * 1024;

let _disk = null; // key → { d: data, e: expiresAt }
let _diskDirty = false;
let _diskFlushTimer = null;

function diskRead() {
  if (_disk) return _disk;
  try {
    const raw = localStorage.getItem(TMDB_DISK_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    _disk = parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    _disk = {};
  }
  // Drop anything already expired so the blob can't grow monotonically.
  const now = Date.now();
  for (const k of Object.keys(_disk)) {
    if (!_disk[k] || now >= _disk[k].e) delete _disk[k];
  }
  return _disk;
}

function diskFlush() {
  _diskFlushTimer = null;
  if (!_diskDirty || !_disk) return;
  _diskDirty = false;
  try {
    const keys = Object.keys(_disk);
    if (keys.length > TMDB_DISK_MAX_ENTRIES) {
      // Evict soonest-to-expire first (≈ least recently written).
      keys
        .sort((a, b) => _disk[a].e - _disk[b].e)
        .slice(0, keys.length - TMDB_DISK_MAX_ENTRIES)
        .forEach((k) => delete _disk[k]);
    }
    localStorage.setItem(TMDB_DISK_KEY, JSON.stringify(_disk));
  } catch {
    // Quota exceeded (or private mode): drop the mirror entirely rather than
    // retrying forever. The memory tier keeps working.
    _disk = {};
    try {
      localStorage.removeItem(TMDB_DISK_KEY);
    } catch {}
  }
}

function diskWrite(key, data) {
  let serialized;
  try {
    serialized = JSON.stringify(data);
  } catch {
    return;
  }
  if (serialized.length > TMDB_DISK_MAX_ENTRY_BYTES) return;
  const disk = diskRead();
  disk[key] = { d: data, e: Date.now() + TMDB_DISK_TTL };
  _diskDirty = true;
  // Batch writes: a cold home page resolves ~40 requests, and one
  // JSON.stringify of the whole blob per response would be the new bottleneck.
  if (!_diskFlushTimer) _diskFlushTimer = setTimeout(diskFlush, 1500);
}

// Never lose the tail of the mirror to a tab close mid-window.
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => {
    if (_diskFlushTimer) { clearTimeout(_diskFlushTimer); _diskFlushTimer = null; }
    diskFlush();
  });
}

/** Clears the in-memory TMDB cache and the persisted trending cache.
 * Calling this when the metadata language changes. */
export function clearTmdbCache() {
  _tmdbCache.clear();
  _disk = {};
  _diskDirty = false;
  try {
    localStorage.removeItem("streambert_trendingCache");
    localStorage.removeItem(TMDB_DISK_KEY);
  } catch {}
}

// ── Request queue (concurrency measured, not fixed) ──────────────────────────
// Prevents bursts of 10-20 parallel requests from carousel/similar-rows rapid
// navigation from hammering the API and triggering rate-limit responses.
//
// Two priority lanes. Everything the user is waiting to SEE (trending rows,
// details, search) runs normal; background enrichment that only decorates
// already-visible cards (age-rating badges — ~40 calls on a cold home page)
// runs `low` and is only admitted when no normal request is queued. Before
// this split, the badges could take all 4 slots and push the rows that matter
// behind them.
//
// The lane width is transport-dependent: on HTTP/1.1 the browser opens six
// connections per origin, so 4 in flight leaves headroom for the winning
// stream's own playlist/segment fetches. On h2/h3 everything multiplexes over
// one connection and the real limit is the API's patience — a cold home page
// resolves ~40 requests, which at 4 lanes is ~4 s of serialized RTTs and at 8
// is half that. nextHopProtocol is read from the browser's own resource
// timings for same-origin responses, so it costs nothing.
let _inflight = 0;
const _waiters = []; // normal priority
const _waitersLow = [];
const MAX_INFLIGHT = (() => {
  try {
    const entries = performance?.getEntriesByType?.("resource") || [];
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (!e?.nextHopProtocol) continue;
      if (e.name && typeof location !== "undefined" && e.name.indexOf(location.origin) !== 0) continue;
      if (e.nextHopProtocol === "h2" || e.nextHopProtocol === "h3") return 8;
      break;
    }
  } catch { /* fall through to the conservative default */ }
  return 4;
})();

function _acquireSlot(low = false) {
  if (_inflight < MAX_INFLIGHT && (!low || _waiters.length === 0)) {
    _inflight++;
    return Promise.resolve();
  }
  return new Promise((resolve) => (low ? _waitersLow : _waiters).push(resolve));
}

function _releaseSlot() {
  _inflight--;
  const next = _waiters.length > 0 ? _waiters : _waitersLow;
  if (next.length > 0) {
    _inflight++;
    next.shift()();
  }
}

export const tmdbFetch = async (path, apiKey, opts = {}) => {
  const localizedPath = withLanguage(path);
  const cacheKey = `${apiKey}|${localizedPath}`;
  const cached = _tmdbCache.get(cacheKey);
  if (cached && Date.now() < cached.expiresAt) return cached.data;
  // Reload survivor: hydrate the memory tier from the localStorage mirror.
  const onDisk = diskRead()[cacheKey];
  if (onDisk && Date.now() < onDisk.e) {
    _tmdbCache.set(cacheKey, {
      data: onDisk.d,
      expiresAt: Date.now() + TMDB_CACHE_TTL,
    });
    return onDisk.d;
  }

  await _acquireSlot(opts.priority === "low");

  let res;
  try {
    res = await fetch(`${TMDB_BASE}${localizedPath}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: opts.signal ?? AbortSignal.timeout(10000),
    });
  } catch (e) {
    _releaseSlot();
    // An AbortController abort is expected on navigation-away; don't flag it as
    // unreachable (that would show the warning banner for a deliberate cancel).
    if (e && e.name === "AbortError") throw e;
    _onUnreachable?.();
    throw new Error("TMDB unreachable");
  } finally {
    // releaseSlot is called in the catch above for network errors;
    // for successful responses it is called immediately below, before
    // parsing, so the slot is held only during the actual in-flight
    // request, not during res.json().
  }

  _releaseSlot();

  if (res.status === 401 || res.status === 403) {
    _onAuthError?.();
    throw new Error(`TMDB ${res.status}`);
  }

  if (!res.ok) throw new Error(`TMDB ${res.status}`);
  const data = await res.json();
  _tmdbCache.set(cacheKey, { data, expiresAt: Date.now() + TMDB_CACHE_TTL });
  diskWrite(cacheKey, data);

  // Evict stale entries to prevent unbounded memory growth
  if (_tmdbCache.size > 80) {
    const now = Date.now();
    for (const [k, v] of _tmdbCache) {
      if (now >= v.expiresAt) _tmdbCache.delete(k);
    }
  }

  return data;
};

// Documentation:
// https://www.videasy.to/docs
// https://vsembed.su/api/
// https://www.vidking.net/#documentation

// ── Player Sources ────────────────────────────────────────────────────────────
// supportsProgress: true = executeJavaScript tracking works for this source
export const PLAYER_SOURCES = [
  {
    id: "videasy",
    label: "Videasy",
    tag: null,
    note: null,
    supportsProgress: true,
    colorParam: "color", // hex without # → e.g. "e50914"
    langParam: null, // no subtitle lang param
    params: {
      overlay: "true",
    },
    movieUrl: (id) => `https://player.videasy.to/movie/${id}`,
    tvUrl: (id, season, ep) =>
      `https://player.videasy.to/tv/${id}/${season}/${ep}`,
  },
  {
    id: "vidsrc",
    label: "VidSrc",
    tag: null,
    note: null,
    supportsProgress: true,
    progressViaFrames: true, // video is in a nested iframe, needs main-process frame query
    colorParam: null, // vidsrc doesn't support color param
    langParam: "ds_lang", // ISO 639-1 language code
    params: {},
    movieUrl: (id) => `https://vsembed.su/embed/movie/${id}`,
    tvUrl: (id, season, ep) =>
      `https://vsembed.su/embed/tv/${id}/${season}/${ep}`,
  },
  {
    id: "vidking",
    label: "Vidking",
    tag: null,
    note: null,
    supportsProgress: true,
    colorParam: "color", // hex without # → e.g. "e50914"
    langParam: null,
    params: {
      autoPlay: "true",
    },
    movieUrl: (id) => `https://www.vidking.net/embed/movie/${id}`,
    tvUrl: (id, season, ep) =>
      `https://www.vidking.net/embed/tv/${id}/${season}/${ep}`,
  },
  {
    id: "allmanga",
    label: "AllManga",
    tag: "ANIME",
    note: null,
    supportsProgress: true,
    async: true,
    params: {},
    movieUrl: (_id) => "https://allmanga.to",
    tvUrl: (_id, _season, _ep) => "https://allmanga.to",
  },
  {
    // TorrServer source — uses our own in-app hls.js player (src/components/TorrPlayer)
    // instead of a webview embed, so it can play Russian-dubbed audio tracks from
    // local torrent files via the user's TorrServer (YouROK MatriX).
    id: "torrserver",
    label: "Торренты",
    tag: "RU",
    note: "Локальный TorrServer (рус. озвучка)",
    supportsProgress: true,
    inApp: true, // renderer renders <TorrPlayer>, not a <webview>
    params: {},
    movieUrl: (_id) => "about:blank",
    tvUrl: (_id, _season, _ep) => "about:blank",
  },
  {
    // Collaps online source — Lampa's online viewing, extracted. Multi-audio HLS
    // with Russian dubs, played in-app via hls.js (src/components/OnlinePlayer).
    id: "online",
    label: "Онлайн",
    tag: "RU",
    note: "Collaps · русская озвучка, без торрентов",
    supportsProgress: true,
    inApp: true,
    params: {},
    movieUrl: (_id) => "about:blank",
    tvUrl: (_id, _season, _ep) => "about:blank",
  },
  {
    // Own source host; keep the stored id so existing per-title preferences work.
    id: "lampac",
    label: "Источники",
    tag: "RU",
    note: "Озвучки и качество",
    supportsProgress: true,
    inApp: true,
    webOnly: true, // relay-backed; no <webview>, no desktop egress path
    params: {},
    movieUrl: (_id) => "about:blank",
    tvUrl: (_id, _season, _ep) => "about:blank",
  },
];

// True for sources that render their own in-app player (no webview embed).
export const sourceIsInApp = (sourceId) =>
  PLAYER_SOURCES.find((s) => s.id === sourceId)?.inApp ?? false;

// On the web build, webview-based sources (Videasy/VidSrc/Vidking/AllManga) don't
// work (no <webview> in a browser), so only in-app sources are offered. App.jsx
// calls setWebOnly(true) when running on the web platform.
let _webOnly = false;
export function setWebOnly(v) {
  _webOnly = !!v;
}
export function isWebOnly() {
  return _webOnly;
}
export function availableSources() {
  // On web, only in-app sources work (no <webview> in a browser): the Collaps
  // "Онлайн" source and the relay-backed Lampac fleet. isWebBuild() reads
  // window.__webShim (set synchronously by the web shim before React mounts);
  // _webOnly is set asynchronously in App.jsx after getPlatform() resolves.
  // Check BOTH so the source picker never lists broken webview sources on web,
  // even on the very first render before the async _webOnly flag flips —
  // otherwise the picker would briefly offer Vidking/VidSrc/etc. and selecting
  // one would spin forever (no <webview> in a browser).
  if (isWebBuild() || _webOnly) {
    return PLAYER_SOURCES.filter((s) => s.id === "online" || s.id === "lampac");
  }
  // Desktop: everything except the web-only relay sources (Lampac needs the
  // same-origin relay it can't reach from the packaged app).
  return PLAYER_SOURCES.filter((s) => !s.webOnly);
}
export const getSourceUrl = (
  sourceId,
  type,
  id,
  season,
  ep,
  extraParams = {},
  // Optional: accent hex (with or without #) and subtitle ISO lang code
  accentColor = null,
  subtitleLang = null,
) => {
  const src =
    PLAYER_SOURCES.find((s) => s.id === sourceId) ?? PLAYER_SOURCES[0];
  const baseUrl =
    type === "movie" ? src.movieUrl(id) : src.tvUrl(id, season, ep);
  const url = new URL(baseUrl);

  Object.entries(src.params || {}).forEach(([key, value]) => {
    url.searchParams.set(key, value);
  });

  // Inject accent color into the player if the source supports it
  if (accentColor && src.colorParam) {
    url.searchParams.set(src.colorParam, accentColor.replace(/^#/, ""));
  }

  if (subtitleLang && src.langParam) {
    url.searchParams.set(src.langParam, subtitleLang);
  }

  Object.entries(extraParams).forEach(([key, value]) => {
    if (value != null) {
      url.searchParams.set(key, value);
    }
  });

  return url.toString();
};

export const sourceSupportsProgress = (sourceId) =>
  PLAYER_SOURCES.find((s) => s.id === sourceId)?.supportsProgress ?? false;

export const sourceProgressViaFrames = (sourceId) =>
  PLAYER_SOURCES.find((s) => s.id === sourceId)?.progressViaFrames ?? false;

export const sourceIsAsync = (sourceId) =>
  PLAYER_SOURCES.find((s) => s.id === sourceId)?.async ?? false;

// Return the next non-async source after `currentId` in PLAYER_SOURCES order
export const getNextNonAsyncSource = (currentId) => {
  const nonAsync = PLAYER_SOURCES.filter((s) => !s.async);
  if (nonAsync.length === 0) return null;
  const idx = nonAsync.findIndex((s) => s.id === currentId);
  // If currentId is itself non-async, return the next one (wrap around).
  // If currentId is async (e.g. AllManga), just return the first non-async.
  if (idx < 0) return nonAsync[0].id;
  return nonAsync[(idx + 1) % nonAsync.length].id;
};

// Sources that require a transparent webRequest intercept to load properly
export const NEEDS_INTERCEPT = ["vidsrc"];

// ── AniList API (anime metadata) ──────────────────────────────────────────────
const ANILIST_API = "https://graphql.anilist.co";

// Strip "(Source: ...)", "Note: ..." and similar attribution lines from AniList descriptions
export const cleanAnilistDescription = (desc) => {
  if (!desc) return desc;
  // Remove HTML by stripping all < and > characters and anything between them.
  // Splitting on < and dropping the tag portion of each chunk is immune to
  // unclosed/malformed tags and avoids any regex that starts with "<" (which
  // static analysers flag as potentially incomplete).
  let clean = desc
    .split("<")
    .map((chunk, i) => (i === 0 ? chunk : chunk.slice(chunk.indexOf(">") + 1)))
    .join("")
    .replace(/>/g, "");
  // Remove everything from "(Source:" onwards (including multi-line variants)
  clean = clean.replace(/\(Source:[^)]*\)/gi, "");
  // Remove "Note: ..." sentences/paragraphs at the end
  clean = clean.replace(/\bNote:[^\n]*/gi, "");
  // Remove trailing whitespace, newlines, punctuation left over
  clean = clean.replace(/[\s\n]+$/, "").trim();
  return clean;
};

const ANILIST_QUERY = `
query ($search: String, $type: MediaType) {
  Media(search: $search, type: $type, sort: SEARCH_MATCH) {
    id
    idMal
    title { romaji english native }
    description(asHtml: false)
    coverImage { extraLarge large }
    bannerImage
    genres
    averageScore
    episodes
    status
    season
    seasonYear
    studios(isMain: true) { nodes { name } }
    startDate { year month }
    relations {
      edges {
        relationType
        node {
          id
          type
          format
          title { romaji english }
          episodes
          startDate { year month }
          seasonYear
        }
      }
    }
  }
}`;

// ── AniList cache (localStorage + in-memory) ──────────────────────────────────
const ANILIST_CACHE_KEY = "streambert_anilistCache";
const ANILIST_CACHE_TTL = 1000 * 60 * 60 * 24 * 7; // 7 days

// loaded once on first use, flushed to localStorage on write.
let _anilistCache = null;

function getAnilistCache() {
  if (_anilistCache) return _anilistCache;
  try {
    const raw = localStorage.getItem(ANILIST_CACHE_KEY);
    _anilistCache = raw ? JSON.parse(raw) : {};
  } catch {
    _anilistCache = {};
  }
  // Evict stale entries once on load
  const now = Date.now();
  for (const key of Object.keys(_anilistCache)) {
    if (now - _anilistCache[key].ts > ANILIST_CACHE_TTL) {
      delete _anilistCache[key];
    }
  }
  return _anilistCache;
}

let _anilistFlushTimer = null;
function flushAnilistCache() {
  if (_anilistFlushTimer) clearTimeout(_anilistFlushTimer);
  _anilistFlushTimer = setTimeout(() => {
    _anilistFlushTimer = null;
    try {
      localStorage.setItem(ANILIST_CACHE_KEY, JSON.stringify(_anilistCache));
    } catch {}
  }, 500);
}

// tmdbId is used as the cache key (unique per show) while title is used for the AniList search query.
export const fetchAnilistData = async (
  title,
  type = "ANIME",
  tmdbId = null,
) => {
  const cacheKey = tmdbId
    ? `${type}__tmdb_${tmdbId}`
    : `${type}__${title.toLowerCase().trim()}`;

  const cache = getAnilistCache();
  const entry = cache[cacheKey];
  if (entry && Date.now() - entry.ts <= ANILIST_CACHE_TTL) {
    // Sanity-check: make sure cached data actually belongs to this title.
    const cachedTitles = [
      entry.data?.title?.romaji,
      entry.data?.title?.english,
      entry.data?.title?.native,
    ]
      .filter(Boolean)
      .map((t) => t.toLowerCase());
    const searchTitle = title.toLowerCase();
    const isMismatch =
      entry.data !== null &&
      cachedTitles.length > 0 &&
      !cachedTitles.some(
        (t) => t.includes(searchTitle) || searchTitle.includes(t),
      );
    if (!isMismatch) return entry.data;
    // Mismatch detected
    delete cache[cacheKey];
    flushAnilistCache();
  }

  try {
    const res = await fetch(ANILIST_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        query: ANILIST_QUERY,
        variables: { search: title, type },
      }),
    });
    const json = await res.json();
    const data = json?.data?.Media || null;

    cache[cacheKey] = { data, ts: Date.now() };
    flushAnilistCache();

    return data;
  } catch {
    if (entry) return entry.data;
    return null;
  }
};

/**
 * Build an ordered list of seasons from AniList data.
 * AniList represents each season of a series as a separate Media entry
 * linked by SEQUEL/PREQUEL relations. This function walks the SEQUEL chain
 * starting from the fetched entry and returns seasons sorted by air date.
 *
 * Returns: [{ seasonNum, title, episodes, year, month }]
 */
export const buildAnilistSeasons = (anilistData) => {
  if (!anilistData) return null;

  const main = {
    id: anilistData.id,
    title:
      anilistData.title?.english ||
      anilistData.title?.romaji ||
      anilistData.title?.native,
    episodes: anilistData.episodes || null,
    year: anilistData.startDate?.year || anilistData.seasonYear || 9999,
    month: anilistData.startDate?.month || 0,
  };

  // Collect direct TV-format sequels from relations
  const sequels = (anilistData.relations?.edges || [])
    .filter(
      (e) =>
        e.relationType === "SEQUEL" &&
        e.node.type === "ANIME" &&
        (e.node.format === "TV" || e.node.format === "TV_SHORT"),
    )
    .map((e) => ({
      id: e.node.id,
      title: e.node.title?.english || e.node.title?.romaji,
      episodes: e.node.episodes || null,
      year: e.node.startDate?.year || e.node.seasonYear || 9999,
      month: e.node.startDate?.month || 0,
    }));

  const all = [main, ...sequels].sort((a, b) =>
    a.year !== b.year ? a.year - b.year : a.month - b.month,
  );

  return all.map((s, i) => ({ seasonNum: i + 1, ...s }));
};

// TMDB genre ID 16 = Animation. Treat it as anime when origin_country includes JP or language is jp
export const isAnimeContent = (item, details) => {
  const d = details || item;
  const lang = d.original_language;
  const countries = d.origin_country || [];
  const genreIds = d.genre_ids || (d.genres || []).map((g) => g.id);
  const hasAnimation = genreIds.includes(16);
  return hasAnimation && (lang === "ja" || countries.includes("JP"));
};

// ── "Hide anime" user setting ────────────────────────────────────────────────
// When enabled, anime (Japanese animation, per isAnimeContent) is filtered out
// of every discovery surface: search results, trending, top rated, and
// recommendations. Reads localStorage lazily so it always reflects the current
// setting. The user's own library/history/continue-watching are NOT filtered.
export function hideAnimeEnabled() {
  try {
    // Stored as 1/0 (matching COMPACT_MODE/REDUCE_ANIMATIONS); coerce to bool.
    return !!JSON.parse(localStorage.getItem("streambert_hideAnime"));
  } catch {
    return false;
  }
}
// Filter a list of items, dropping anime when the setting is on. Returns the
// list unchanged (or []) when off — safe to pipe any array through.
export function filterAnime(items) {
  const arr = items || [];
  if (!hideAnimeEnabled()) return arr;
  return arr.filter((i) => !isAnimeContent(i));
}

// Default sources
export const ANIME_DEFAULT_SOURCE = "allmanga";
export const NON_ANIME_DEFAULT_SOURCE = "vidking";
// True when running as the web build (browser, no Electron preload). On web the
// ONLY working source is "online" (Collaps); webview/torrent sources need
// Electron.
//
// IMPORTANT: this is a FUNCTION, not a module-load const. api.js can be placed
// by the bundler in a chunk (the lazy movie chunk) that executes BEFORE
// src/web/shim.js sets window.__webShim — a `const` captured `false` at that
// moment would permanently break web detection (Watch Together would show
// "backend not configured", the source picker would list broken webview
// sources, etc.). Reading window.__webShim at CALL time — after the shim has
// run — is robust against chunk load order. Callers must call isWebBuild(), not
// cache it at module load.
export function isWebBuild() {
  return typeof window !== "undefined" && !!window.__webShim;
}

// ── Episode Group fetch (localStorage + in-memory cache, 7-day TTL) ─────────
// Episode groups almost never change -> cache aggressively across sessions.
const EG_CACHE_KEY = "streambert_episodeGroupCache";
const EG_CACHE_TTL = 1000 * 60 * 60 * 24 * 7; // 7 days

let _egCache = null;

function getEgCache() {
  if (_egCache) return _egCache;
  try {
    const raw = localStorage.getItem(EG_CACHE_KEY);
    _egCache = raw ? JSON.parse(raw) : {};
  } catch {
    _egCache = {};
  }
  // Evict stale entries once on load
  const now = Date.now();
  for (const key of Object.keys(_egCache)) {
    if (now - _egCache[key].ts > EG_CACHE_TTL) delete _egCache[key];
  }
  return _egCache;
}

let _egFlushTimer = null;
function flushEgCache() {
  if (_egFlushTimer) clearTimeout(_egFlushTimer);
  _egFlushTimer = setTimeout(() => {
    _egFlushTimer = null;
    try {
      localStorage.setItem(EG_CACHE_KEY, JSON.stringify(_egCache));
    } catch {}
  }, 500);
}

export const fetchEpisodeGroup = async (groupId, apiKey) => {
  const cache = getEgCache();
  const entry = cache[groupId];
  if (entry && Date.now() - entry.ts <= EG_CACHE_TTL) return entry.data;

  const data = await tmdbFetch(`/tv/episode_group/${groupId}`, apiKey);
  cache[groupId] = { data, ts: Date.now() };
  flushEgCache();
  return data;
};
