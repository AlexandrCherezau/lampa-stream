// localStorage-based persistence (works in both Vite dev and prod)

const PREFIX = "streambert_";

export const storage = {
  get(key) {
    try {
      const raw = localStorage.getItem(PREFIX + key);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(PREFIX + key, JSON.stringify(value));
      if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("streambert:storage-write", { detail: { key, value } }));
    } catch {}
  },
  remove(key) {
    try {
      localStorage.removeItem(PREFIX + key);
      if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("streambert:storage-write", { detail: { key, value: null } }));
    } catch {}
  },
  // Remove all streambert_ keys (used by reset)
  clearAll() {
    try {
      Object.keys(localStorage)
        .filter((k) => k.startsWith(PREFIX))
        .forEach((k) => localStorage.removeItem(k));
    } catch {}
  },
};

// ── Capped map persistence ──────────────────────────────────────────────────
// Several maps (resume timecodes, watch progress) grow one entry per title AND
// per episode ever watched. Unbounded, they (a) bloat the localStorage blob
// toward the 5 MB quota and (b) make every save a synchronous JSON.parse +
// JSON.stringify of the whole map on the main thread — during playback, on the
// same thread as video decoding. `setCappedMap` evicts the oldest-inserted
// entries once the map passes `cap`, keeping the recent tail the viewer
// actually resumes.
export function setCappedMap(key, map, cap = 300) {
  try {
    let m = map;
    const keys = Object.keys(m);
    if (keys.length > cap) {
      m = {};
      // Object key order is insertion order, so the first keys are the oldest.
      for (const k of keys.slice(keys.length - cap)) m[k] = map[k];
    }
    storage.set(key, m);
  } catch {}
}

// Centralised storage key registry
export const STORAGE_KEYS = {
  API_KEY: "apikey",
  UPDATE_SOURCE: "updateSource",
  PLAYER_SOURCE: "playerSource",
  ALLMANGA_DUB_MODE: "allmangaDubMode",
  WATCH_PROGRESS: "progress",
  WATCHED: "watched",
  HISTORY: "history",
  SAVED: "saved",
  SAVED_ORDER: "savedOrder",
  LOCAL_FILES: "localFiles",
  DOWNLOAD_PATH: "downloadPath",
  DOWNLOADER_FOLDER: "downloaderFolder",
  START_PAGE: "startPage",
  AGE_LIMIT: "ageLimit",
  RATING_COUNTRY: "ratingCountry",
  WATCHED_THRESHOLD: "watchedThreshold",
  HOME_ROW_ORDER: "homeRowOrder",
  HOME_ROW_VISIBLE: "homeRowVisible",
  HOME_VIEW_MODE: "homeViewMode",
  AUTO_CHECK_UPDATES: "autoCheckUpdates",
  INVIDIOUS_BASE: "invidiousBase",
  // Subtitle settings
  SUBTITLE_ENABLED: "subtitleDownload",
  SUBTITLE_LANG: "subtitleLang",
  // NOTE: SUBDL_API_KEY, WYZIE_API_KEY and API_KEY are stored encrypted via secureStorage
  SUBDL_API_KEY: "subdlApiKey",
  WYZIE_API_KEY: "wyzieApiKey",
  // Appearance & behaviour
  ACCENT_COLOR: "accentColor",
  ACCENT_IN_PLAYER: "accentInPlayer",
  THEME: "theme",
  CUSTOM_THEME_VARS: "customThemeVars",
  FONT_SIZE: "fontSize",
  COMPACT_MODE: "compactMode",
  REDUCE_ANIMATIONS: "reduceAnimations",
  LIBRARY_SORT: "librarySort",
  HISTORY_ENABLED: "historyEnabled",
  // Notification preferences
  NOTIFY_DOWNLOAD_COMPLETE: "notifyDownloadComplete",
  NOTIFY_NEW_EPISODE: "notifyNewEpisode",
  // TMDB metadata lang (BCP-47 locale, e.g. "de-DE")
  TMDB_LANG: "tmdbLang",
  // Anime opening/ending/recap skip (AniSkip)
  // Values: "off" | "auto" | "manual"
  INTRO_SKIP_MODE: "introSkipMode",
  // Confirmed IntroDB intro/recap/credits for movies and non-anime series.
  // Values: "off" | "auto" | "manual". Separate from INTRO_SKIP_MODE so the user
  // can enable AniSkip for anime while leaving general skipping off (or vice
  // versa). Anime series still use INTRO_SKIP_MODE (AniSkip, exact).
  SKIP_HEURISTIC_MODE: "skipHeuristicMode",
  // Autoplay next preferences
  AUTOPLAY_NEXT_ENABLED: "autoplayNextEnabled",
  AUTOPLAY_NEXT_DURATION: "autoplayNextDuration",
  AUTOPLAY_NEXT_LAYOUT: "autoplayNextLayout",
  // Lampac picker state per IMDB id (so balancer/voice/quality survive between
  // episodes of the same series and across opens of the same movie). Keys look
  // up via getLampacState(imdbId); writes go through setLampacState().
  LAMPAC_STATE: "streambert_lampacState",
  // Player volume / mute — survive full player remounts (source change,
  // key={playerSource}). Single global value, not per-title.
  PLAYER_VOLUME: "streambert_playerVolume",
  PLAYER_MUTED: "streambert_playerMuted",
  AUTOPLAY_NEXT_INSTANT: "autoplayNextInstant",
  // Download page UI preferences
  DL_SORT_BY: "dlSortBy",
  DL_SORT_DIR: "dlSortDir",
  DL_SHOW_UNTRACKED: "dlShowUntracked",
  // Cache for new-episode startup check
  EPISODE_RELEASE_CACHE: "episodeReleaseCache",
  // Per-episode fallback source when the default (typically AllManga) lacks
  // the title. Shape: { [epKey]: sourceId }.
  SOURCE_FAILOVER_CACHE: "sourceFailoverCache",
  // Precise resume timecodes per movie/episode (seconds, 0.1s precision).
  // Parallel to WATCH_PROGRESS (which stores percentages for the UI bar); this
  // stores the exact second so a reload resumes to the right moment. Keyed by
  // the same progressKey (movie_<id> / tv_<id>_s<season>e<episode>).
  RESUME_TIME: "resumeTime",
  // Hide anime (Japanese animation) from all discovery surfaces — search,
  // trending, top rated, recommendations. The user's own library/history are
  // left alone. Detection reuses isAnimeContent (genre 16 + lang ja / country JP).
  HIDE_ANIME: "hideAnime",
  // Discover page last-used filters ({ mediaType, genreId, year, minRating,
  // sortBy }) so reopening the tab restores the user's filter selection.
  DISCOVER_FILTERS: "discoverFilters",
  // ── Watch Together (watch-party rooms) ─────────────────────────────────────
  // Display name shown to other viewers in a room; the room code itself is the
  // shareable secret (kept in component state / URL ?room=, not persisted long).
  WT_NAME: "wtName",
  WT_LAST_CODE: "wtLastCode",
  // Desktop only: the /api/room URL the Electron app talks to (web uses
  // same-origin). Optional — if unset the tab shows "backend not configured".
  WT_ENDPOINT: "wtEndpoint",
};

export const getApiKey = () => storage.get(STORAGE_KEYS.API_KEY);

// ── Source failover cache ────────────────────────────────────────────────────
// AllManga doesn't always have every episode; rather than nag the user every
// time, remember the working alternate source per (tmdbId, season, ep, dub).
// Max 200 entries
const FAILOVER_CACHE_MAX = 200;

export const getFailoverSource = (epKey) => {
  const cache = storage.get(STORAGE_KEYS.SOURCE_FAILOVER_CACHE) || {};
  return cache[epKey]?.sourceId || null;
};

export const setFailoverSource = (epKey, sourceId) => {
  const cache = storage.get(STORAGE_KEYS.SOURCE_FAILOVER_CACHE) || {};
  // Evict oldest entries when at capacity (insertion order via Object.keys)
  const keys = Object.keys(cache);
  if (keys.length >= FAILOVER_CACHE_MAX) {
    const evict = keys.slice(0, keys.length - FAILOVER_CACHE_MAX + 1);
    evict.forEach((k) => delete cache[k]);
  }
  cache[epKey] = { sourceId, ts: Date.now() };
  storage.set(STORAGE_KEYS.SOURCE_FAILOVER_CACHE, cache);
};

export const clearFailoverSource = (epKey) => {
  const cache = storage.get(STORAGE_KEYS.SOURCE_FAILOVER_CACHE) || {};
  if (cache[epKey] !== undefined) {
    delete cache[epKey];
    storage.set(STORAGE_KEYS.SOURCE_FAILOVER_CACHE, cache);
  }
};

// ── Lampac picker state per IMDB id ──────────────────────────────────────────
// Persist the user's balancer / voice / quality picks per title (imdb_id for
// movies, series imdb_id for tv) so an episode switch inside a series — or a
// re-open of the same film — restores the picker without a manual re-pick.
// Stored as a flat map keyed by imdbId; each entry holds whatever subset of
// {balanser, voice, quality} the caller wrote.
const LAMPAC_STATE_MAX = 500;
const sanitizeLampacState = (s) => {
  if (!s || typeof s !== "object") return null;
  const out = {};
  if (typeof s.balanser === "string" && s.balanser) out.balanser = s.balanser;
  if (typeof s.voice === "string" && s.voice) out.voice = s.voice;
  if (typeof s.quality === "string" && s.quality) out.quality = s.quality;
  return Object.keys(out).length ? out : null;
};
export const getLampacState = (imdbId) => {
  if (!imdbId) return null;
  const cache = storage.get(STORAGE_KEYS.LAMPAC_STATE) || {};
  return sanitizeLampacState(cache[imdbId]);
};
export const setLampacState = (imdbId, partial) => {
  if (!imdbId) return;
  const cache = storage.get(STORAGE_KEYS.LAMPAC_STATE) || {};
  const cur = sanitizeLampacState(cache[imdbId]) || {};
  const next = { ...cur, ...sanitizeLampacState(partial) };
  if (!Object.keys(next).length) return;
  cache[imdbId] = next;
  // Evict oldest entries when at capacity (insertion order via Object.keys)
  const keys = Object.keys(cache);
  if (keys.length > LAMPAC_STATE_MAX) {
    const evict = keys.slice(0, keys.length - LAMPAC_STATE_MAX);
    evict.forEach((k) => delete cache[k]);
  }
  storage.set(STORAGE_KEYS.LAMPAC_STATE, cache);
};
export const clearLampacState = (imdbId) => {
  const cache = storage.get(STORAGE_KEYS.LAMPAC_STATE) || {};
  if (cache[imdbId] !== undefined) {
    delete cache[imdbId];
    storage.set(STORAGE_KEYS.LAMPAC_STATE, cache);
  }
};

// ── Player volume / mute (single global value, not per-title) ──────────────────
const clampVol = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.min(1, Math.max(0, n));
};
export const getStoredVolume = () => {
  const v = clampVol(storage.get(STORAGE_KEYS.PLAYER_VOLUME));
  return v == null ? 1 : v;
};
export const getStoredMuted = () => {
  const raw = storage.get(STORAGE_KEYS.PLAYER_MUTED);
  return raw === true || raw === "true";
};
export const setStoredVolume = (v) => {
  const c = clampVol(v);
  if (c != null) storage.set(STORAGE_KEYS.PLAYER_VOLUME, c);
};
export const setStoredMuted = (m) => storage.set(STORAGE_KEYS.PLAYER_MUTED, !!m);

// ── Shared helpers ────────────────────────────────────────────────────────────

/** True when running inside Electron (contextBridge exposed). */
export const isElectron = typeof window !== "undefined" && !!window.electron;

/** Format a byte count into a human-readable string. */
export function formatBytes(bytes) {
  if (bytes === null || bytes === undefined) return "…";
  if (bytes === -1) return null; // unavailable
  if (bytes === 0) return "0 B";
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  if (bytes < 1024 * 1024 * 1024)
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + " GB";
}

// ── Secure storage for sensitive keys ────────────────────────────────────────
// Uses Electron safeStorage (OS keychain / DPAPI / libsecret).
// All methods are async. Non-Electron environments silently fall back to no-op.
//
// Sensitive keys managed here (NOT stored in localStorage):
//   "apikey"      - TMDB API key
//   "subdlApiKey" - SubDL API key
//   "wyzieApiKey" - Wyzie API key

// Check at call time (not module-load) so the web shim — which defines
// window.electron after this module is imported — is picked up correctly.
const hasSecureBridge = () =>
  typeof window !== "undefined" && !!window.electron?.secureGet;

export const secureStorage = {
  /** Read an encrypted value. Returns null if not set. */
  async get(key) {
    if (!hasSecureBridge()) return null;
    return window.electron.secureGet(key);
  },

  /** Write an encrypted value. Pass null/empty to delete. */
  async set(key, value) {
    if (!hasSecureBridge()) return;
    return window.electron.secureSet(key, value ?? "");
  },
};

/**
 * Clears all app caches, Electron browser cache, AniList, EpisodeGroup,
 * AniSkip, and dlDur_ keys. Single source of truth used by Settings
 * "Clear Cache" button and post-update cache clearing in App.jsx.
 */
export async function clearAppCaches() {
  if (isElectron) {
    try {
      await window.electron.clearAppCache();
    } catch {}
  }
  localStorage.removeItem("streambert_anilistCache");
  localStorage.removeItem("streambert_episodeGroupCache");
  localStorage.removeItem("streambert_aniskipCache");
  for (const key of Object.keys(localStorage)) {
    if (key.startsWith("dlDur_")) localStorage.removeItem(key);
  }
}
