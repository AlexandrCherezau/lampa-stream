import {
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
  lazy,
  Suspense,
} from "react";
import ErrorBoundary from "./components/ErrorBoundary";
import KeyboardShortcutsModal from "./components/KeyboardShortcutsModal";
import WindowTitlebar from "./components/WindowTitlebar";
import { storage, secureStorage, STORAGE_KEYS } from "./utils/storage";
import {
  applyAccentColor,
  applyTheme,
  ACCENT_PRESETS,
} from "./utils/appearance";
import { collectBackupData } from "./utils/backup";
import { tmdbFetch, setApiErrorHandlers, setTmdbProxyBase, tmdbApiBase, setWebOnly, withLanguage } from "./utils/api";
import { clearAppCaches } from "./utils/storage";
import { startViewingProfileSync } from "./utils/viewingProfile";

import Sidebar from "./components/Sidebar";
import MobileTopBar from "./components/MobileTopBar";
import SearchModal from "./components/SearchModal";
import SetupScreen from "./components/SetupScreen";
import CloseConfirmModal from "./components/CloseConfirmModal";
import UpdateModal from "./components/UpdateModal";
import "./styles/personal-cinema.css";

// Lazy-loaded pages: each chunk is only downloaded when the user first visits
const HomePage = lazy(() => import("./pages/HomePage"));
const MoviePage = lazy(() => import("./pages/MoviePage"));
const TVPage = lazy(() => import("./pages/TVPage"));
const LibraryPage = lazy(() => import("./pages/LibraryPage"));
const DiscoverPage = lazy(() => import("./pages/DiscoverPage"));
const WatchTogetherPage = lazy(() => import("./pages/WatchTogetherPage"));
const SettingsPage = lazy(() => import("./pages/SettingsPage"));
const DownloadsPage = lazy(() => import("./pages/DownloadsPage"));
const PersonalDevicesPage = lazy(() => import("./pages/PersonalDevicesPage"));
const MonthlyRecapPage = lazy(() => import("./pages/MonthlyRecapPage"));
const TonightPage = lazy(() => import("./pages/TonightPage"));

const ROUTE_PAGES = new Set(["home", "discover", "history", "settings", "together", "downloads", "devices", "recap", "tonight", "movie", "tv"]);
function catalogMetadata(item) {
  if (!["vi3000", "habster", "zona"].includes(item?.catalogSource)) return {};
  const kinopoiskId = [item.kinopoisk_id, item.kinopoiskId]
    .filter((value) => typeof value === "number" || typeof value === "string")
    .map(Number).find((value) => Number.isSafeInteger(value) && value > 0);
  const imdbId = item.imdb_id || item.external_ids?.imdb_id;
  return { catalogSource: item.catalogSource, ...(kinopoiskId ? { kinopoisk_id: kinopoiskId } : {}),
    ...(typeof imdbId === "string" && /^tt\d{5,12}$/.test(imdbId) ? { imdb_id: imdbId } : {}) };
}
function readRoute(url = new URL(window.location.href)) {
  const parts = url.pathname.split("/").filter(Boolean);
  const slug = parts[0] || "home";
  const page = slug === "library" ? "history" : slug;
  if (!ROUTE_PAGES.has(page)) return { page: "home", selected: null };
  if (page === "movie" || page === "tv") {
    if (parts.length !== 2) return { page: "home", selected: null };
    const id = /^\d+$/.test(parts[1] || "") ? Number(parts[1]) : 0;
    if (!Number.isSafeInteger(id) || id < 1) return { page: "home", selected: null };
    const seasonValue = url.searchParams.get("season");
    const episodeValue = url.searchParams.get("episode");
    const season = seasonValue !== null && /^(0|[1-9]\d*)$/.test(seasonValue) ? Number(seasonValue) : undefined;
    const episode = episodeValue && /^[1-9]\d*$/.test(episodeValue) ? Number(episodeValue) : undefined;
    const remembered = window.history.state?.appRoute;
    const source = url.searchParams.get("catalogSource");
    const catalog = ["vi3000", "habster", "zona"].includes(source)
      ? { ...catalogMetadata(remembered?.page === page && remembered.selected?.id === id && remembered.selected?.catalogSource === source ? remembered.selected : null), catalogSource: source }
      : {};
    return { page, selected: { id, media_type: page, ...catalog, ...(Number.isSafeInteger(season) ? { season } : {}), ...(Number.isSafeInteger(episode) ? { episode } : {}) } };
  }
  if (parts.length > 1) return { page: "home", selected: null };
  if (page === "devices") {
    const pairToken = new URLSearchParams(url.hash.replace(/^#/, "")).get("pair");
    return { page, selected: pairToken ? { pairToken } : null };
  }
  const section = url.searchParams.get("section");
  return { page, selected: page === "settings" && section ? { section } : null };
}
function routeUrl(page, selected) {
  if (page === "movie" || page === "tv") {
    const url = `/${page}/${encodeURIComponent(selected.id)}`;
    const query = new URLSearchParams();
    if (page === "tv" && selected.season != null && Number.isSafeInteger(Number(selected.season)) && Number(selected.season) >= 0) query.set("season", selected.season);
    if (page === "tv" && Number(selected.episode) > 0) query.set("episode", selected.episode);
    if (["vi3000", "habster", "zona"].includes(selected.catalogSource)) query.set("catalogSource", selected.catalogSource);
    return url + (query.size ? `?${query}` : "");
  }
  const slug = page === "history" ? "library" : page === "home" ? "" : page;
  const query = page === "settings" && selected?.section ? `?section=${encodeURIComponent(selected.section)}` : "";
  return `/${slug}${query}`;
}
function historyRoute(page, selected) {
  // Pair tokens are transient capabilities; keep them only in React memory.
  return { page, selected: page === "devices" && selected?.pairToken ? null : selected };
}
import {
  checkForUpdatesWithFallback,
  DEFAULT_UPDATE_SOURCE,
} from "./utils/updates";

export default function App() {
  // apiKey loaded async from secure storage (OS keychain)
  const [apiKey, setApiKey] = useState(null);
  const [apiKeyLoaded, setApiKeyLoaded] = useState(false);
  const [skipped, setSkipped] = useState(false);
  const [apiKeyStatus, setApiKeyStatus] = useState("checking"); // 'checking' | 'ok' | 'invalid_token' | 'unreachable'
  const [initialRoute] = useState(() => readRoute());
  const initialPage = initialRoute.page === "home" && location.pathname === "/" ? storage.get("startPage") || "home" : initialRoute.page;
  const [page, setPage] = useState(initialPage);
  const [selected, setSelected] = useState(() => initialRoute.selected);
  const routeIndexRef = useRef(window.history.state?.appIndex || 0);
  const currentRouteRef = useRef({ page: initialPage, selected: initialRoute.selected });
  const [wtInitialCode, setWtInitialCode] = useState(null); // ?room= deep-link
  const [showSearch, setShowSearch] = useState(false);
  const [dlSearchOpen, setDlSearchOpen] = useState(false);
  const [librarySort, setLibrarySort] = useState(
    () => storage.get(STORAGE_KEYS.LIBRARY_SORT) || "manual",
  );
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [platform, setPlatform] = useState(null);

  // Navigation history stack for Ctrl+Z back navigation
  const [navStack, setNavStack] = useState(() => window.history.state?.appStack || []);
  const navStackRef = useRef(navStack);
  useEffect(() => { navStackRef.current = navStack; }, [navStack]);

  // Pair tokens live in the fragment so they are not sent as URL query data.
  // Capture into React state first, then scrub the address bar immediately.
  useEffect(() => {
    if (initialRoute.page !== "devices" || !initialRoute.selected?.pairToken) return;
    const appStack = (window.history.state?.appStack || []).map((entry) => historyRoute(entry.page, entry.selected));
    setNavStack(appStack);
    navStackRef.current = appStack;
    window.history.replaceState({ ...window.history.state, appRoute: { page: "devices", selected: null }, appStack }, "", "/devices");
  }, []);

  const [saved, setSaved] = useState(() => storage.get("saved") || {});
  // Separate order array for drag-and-drop reordering
  const [savedOrder, setSavedOrder] = useState(
    () => storage.get("savedOrder") || null,
  );
  const [progress, setProgress] = useState(() => storage.get("progress") || {});
  const [history, setHistory] = useState(() => storage.get("history") || []);
  const [watched, setWatched] = useState(() => storage.get("watched") || {});
  const [toast, setToast] = useState(null);
  const [updateBanner, setUpdateBanner] = useState(null);
  const [showUpdateModal, setShowUpdateModal] = useState(false);
  // null | "checking" | { entries: object[] } | "none"
  const [episodeCheckStatus, setEpisodeCheckStatus] = useState(null);
  const episodeDismissTimerRef = useRef(null);

  const [trending, setTrending] = useState([]);
  const [trendingTV, setTrendingTV] = useState([]);
  const [loadingHome, setLoadingHome] = useState(false);
  const [offline, setOffline] = useState(() => !navigator.onLine);

  // ── Player accent + subtitle lang ─────────────────────────────────────────
  // Computed once here and passed as a prop to MoviePage / TVPage so neither
  // page needs to touch storage.  Refreshed via "streambert:player-settings-changed".
  const readPlayerSettings = () => {
    const accentId = storage.get(STORAGE_KEYS.ACCENT_COLOR) || "red";
    const inPlayer = storage.get(STORAGE_KEYS.ACCENT_IN_PLAYER) !== false; // default true
    const accentHex = inPlayer
      ? (ACCENT_PRESETS.find((p) => p.id === accentId)?.color ?? null)
      : null;
    const subtitleLang = storage.get(STORAGE_KEYS.SUBTITLE_LANG) || null;
    return { accentColor: accentHex, subtitleLang };
  };
  const [playerSettings, setPlayerSettings] = useState(readPlayerSettings);

  // ── Scheduled backup: run on startup if due ─────────────────────────────────
  useEffect(() => {
    if (!window.electron?.onScheduledBackupRequested) return;
    const handler = window.electron.onScheduledBackupRequested(async () => {
      try {
        const settings = await window.electron.getScheduledBackupSettings();
        if (!settings?.enabled || !settings?.path) return;
        const data = collectBackupData();
        await window.electron.performScheduledBackup({ data, settings });
      } catch {
        // silently ignore errors on scheduled backup
      }
    });
    return () => window.electron.offScheduledBackupRequested(handler);
  }, []);

  // Hydrate direct movie/TV links after the private TMDB token is available.
  useEffect(() => {
    if (!apiKey || !selected?.id || selected.title || selected.name) return;
    let cancelled = false;
    tmdbFetch(`/${page}/${selected.id}`, apiKey).then((item) => {
      if (!cancelled && item?.id) setSelected((current) => current?.id === item.id ? { ...item, ...current, media_type: page } : current);
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [apiKey, page, selected?.id, selected?.title, selected?.name]);

  // ── Post-update cache flush ───────────────────────────────────────────────
  // On every start, compare the running version against the last-seen version.
  // If they differ the app was just updated -> clear all caches to prevent problems
  useEffect(() => {
    if (!window.electron?.getAppVersion) return;
    window.electron.getAppVersion().then((version) => {
      const lastVersion = localStorage.getItem("streambert_lastVersion");
      if (lastVersion && lastVersion !== version) {
        clearAppCaches();
      }
      localStorage.setItem("streambert_lastVersion", version);
    });
  }, []);

  // ── Startup update check ─────────────────────────────────────────────────
  useEffect(() => {
    if (!storage.get("autoCheckUpdates")) return;
    const source =
      storage.get(STORAGE_KEYS.UPDATE_SOURCE) || DEFAULT_UPDATE_SOURCE;
    checkForUpdatesWithFallback(source)
      .then((r) => {
        if (r.hasUpdate) setUpdateBanner(r);
      })
      .catch(() => {}); // silently ignore network errors on startup
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Startup: new-episode notification check ──────────────────────────────
  // Only runs once the API key has been loaded from secure storage (i.e. the
  // app is fully started and past the setup screen). Shows an in-app status
  // pill while checking, then either a result card or a brief "nothing new" message.
  useEffect(() => {
    if (!apiKeyLoaded) return;
    const notifyPref = storage.get(STORAGE_KEYS.NOTIFY_NEW_EPISODE);
    if (notifyPref === false || notifyPref === 0) return;

    let cancelled = false;

    async function checkNewEpisodes() {
      // Small grace period so the UI has fully painted before start
      await new Promise((r) => setTimeout(r, 1200));
      if (cancelled) return;

      if (!apiKey || cancelled) return;

      const tvSeries = Object.values(saved).filter(
        (item) => item && item.media_type === "tv" && item.id,
      );
      if (!tvSeries.length) return;

      // Only re-check entries older than 12 h
      const cache = storage.get(STORAGE_KEYS.EPISODE_RELEASE_CACHE) || {};
      const now = Date.now();
      const CACHE_TTL = 12 * 60 * 60 * 1000;
      const toCheck = tvSeries.filter(
        (s) => !cache[s.id] || now - (cache[s.id].checkedAt || 0) > CACHE_TTL,
      );

      if (!toCheck.length) {
        setEpisodeCheckStatus("none");
        episodeDismissTimerRef.current = setTimeout(() => {
          if (!cancelled) setEpisodeCheckStatus(null);
        }, 2000);
        return;
      }

      // Only show loading pill when there's actually something to check
      setEpisodeCheckStatus("checking");

      const BATCH = 3;
      // Each entry: { title, season, id, seriesItem }
      const newEpisodeEntries = [];

      for (let i = 0; i < toCheck.length && !cancelled; i += BATCH) {
        const batch = toCheck.slice(i, i + BATCH);
        await Promise.all(
          batch.map(async (series) => {
            try {
              const data = await tmdbFetch(`/tv/${series.id}`, apiKey);
              if (cancelled) return;

              const prev = cache[series.id] || {};
              const lastEp = data.last_episode_to_air;
              const lastDate = lastEp?.air_date || null;
              const isFirstCheck = !prev.checkedAt;

              // Parse air_date strings as local midnight to avoid UTC offset issues
              const parseLocalDate = (d) => {
                if (!d) return null;
                const [y, m, day] = d.split("-").map(Number);
                return new Date(y, m - 1, day);
              };

              const todayLocal = new Date();
              todayLocal.setHours(0, 0, 0, 0);
              const sevenDaysAgo = new Date(todayLocal);
              sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

              if (isFirstCheck) {
                // First time: notify if latest episode aired in last 7 days
                const lastParsed = parseLocalDate(lastDate);
                if (lastParsed && lastParsed >= sevenDaysAgo) {
                  newEpisodeEntries.push({
                    title:
                      series.title ||
                      series.name ||
                      data.name ||
                      "Неизвестный сериал",
                    season: lastEp?.season_number ?? null,
                    id: series.id,
                    seriesItem: series,
                  });
                }
              } else {
                // Subsequent checks: notify when last_episode_to_air changed
                // (new episode aired) compared to what got cached.
                // Migration: old cache entries only have nextEpDate, not lastEpDate.
                // In that case treat as first check to avoid false positives.
                const prevLastDate = prev.lastEpDate ?? null;
                const isMigratingOldCache =
                  prev.checkedAt && prevLastDate === null;

                if (isMigratingOldCache) {
                  // Just update the cache with lastEpDat
                } else {
                  const lastParsed = parseLocalDate(lastDate);
                  const prevParsed = parseLocalDate(prevLastDate);

                  const isNewEpisode =
                    lastDate &&
                    lastDate !== prevLastDate &&
                    lastParsed &&
                    lastParsed >= sevenDaysAgo &&
                    (!prevParsed || lastParsed > prevParsed);

                  if (isNewEpisode) {
                    newEpisodeEntries.push({
                      title:
                        series.title ||
                        series.name ||
                        data.name ||
                        "Неизвестный сериал",
                      season: lastEp?.season_number ?? null,
                      id: series.id,
                      seriesItem: series,
                    });
                  }
                }
              }

              cache[series.id] = {
                lastEpDate: lastDate,
                // keep nextEpDate for reference but don't use it for detection
                nextEpDate: data.next_episode_to_air?.air_date || null,
                checkedAt: now,
              };
            } catch {}
          }),
        );
        if (i + BATCH < toCheck.length && !cancelled) {
          await new Promise((r) => setTimeout(r, 400));
        }
      }

      if (cancelled) return;

      storage.set(STORAGE_KEYS.EPISODE_RELEASE_CACHE, cache);

      if (newEpisodeEntries.length === 0) {
        setEpisodeCheckStatus("none");
        // Auto-dismiss after 2 s
        episodeDismissTimerRef.current = setTimeout(() => {
          if (!cancelled) setEpisodeCheckStatus(null);
        }, 2000);
        return;
      }

      // Show in-app result card
      setEpisodeCheckStatus({ entries: newEpisodeEntries });

      // Also fire OS notification
      if (window.electron?.showNotification) {
        const names = newEpisodeEntries.map((e) => e.title);
        const body =
          names.length === 1
            ? `${names[0]} has a new episode.`
            : `${names.slice(0, 3).join(", ")}${
                names.length > 3 ? ` and ${names.length - 3} more` : ""
              } have new episodes.`;
        window.electron.showNotification({
          title: "Доступны новые серии",
          body,
          silent: false,
        });
      }
    }

    checkNewEpisodes().catch(() => {
      if (!cancelled) setEpisodeCheckStatus(null);
    });
    return () => {
      cancelled = true;
      clearTimeout(episodeDismissTimerRef.current);
    };
  }, [apiKeyLoaded]);

  // ── Downloads state ──────────────────────────────────────────────────────
  const [downloads, setDownloads] = useState([]);
  const [highlightDownload, setHighlightDownload] = useState(null);
  const [closeConfirm, setCloseConfirm] = useState(null); // { count }

  // ── Load API key from secure storage on startup ──
  useEffect(() => {
    let mounted = true;
    // Wire the main-process TMDB proxy base (local 127.0.0.1 forwarder) so the
    // renderer's TMDB calls go through it when enabled — bypasses the regional
    // TMDB block with a system VPN and preserves the Bearer token.
    window.electron?.tmdbProxyGet?.().then((p) => {
      if (!mounted) return;
      // Web mode: p.web=true → use same-origin /api/tmdb + /api/img routes.
      // Desktop: p.on + p.port → local 127.0.0.1 proxy. Else direct.
      if (p && p.web) setTmdbProxyBase("web");
      else if (p && p.on && p.port) setTmdbProxyBase(p.port);
      else setTmdbProxyBase(null);
    }).catch(() => {});
    secureStorage.get("apikey").then((val) => {
      if (!mounted) return;
      setApiKey(val || null);
      setApiKeyLoaded(true);
    });
    return () => {
      mounted = false;
    };
  }, []);

  // ── Detect platform for Windows titlebar ──────────────────────────────────
  useEffect(() => {
    if (!window.electron?.getPlatform) return;
    let mounted = true;
    window.electron.getPlatform().then((p) => {
      if (!mounted) return;
      setPlatform(p);
      if (p === "web") {
        // Web: no desktop window titlebar; enable mobile/web CSS hooks.
        document.documentElement.setAttribute("data-web", "1");
        setWebOnly(true);
      } else if (p === "win32" || p === "linux") {
        document.documentElement.setAttribute("data-win-titlebar", "1");
      }
    });
    return () => {
      mounted = false;
    };
  }, []);

  // Listen for close confirmation request from main process
  useEffect(() => {
    if (!window.electron) return;
    const handler = window.electron.onConfirmClose((data) =>
      setCloseConfirm(data),
    );
    return () => window.electron.offConfirmClose(handler);
  }, []);

  // ── Register global API error handlers ──────────────────────────────────
  // Fire on any tmdbFetch call that returns 401/403 or network failure
  useEffect(() => {
    setApiErrorHandlers(
      () => setApiKeyStatus("invalid_token"), // 401 / 403
      () => setApiKeyStatus("unreachable"), // network failure
    );
  }, []);

  // ── Validate the API key (startup + the banner's Retry button) ────────────
  // A stable callback, not an inline effect body: the Retry button used to do
  // `setApiKeyStatus("checking") || window.location.reload()` — the setter
  // returns undefined, so the || ALWAYS fired a full page reload (losing all
  // in-memory caches and the SPA state) instead of re-running the check.
  const recheckApiKey = useCallback(() => {
    if (!apiKey) {
      setApiKeyStatus("ok");
      return;
    }
    setApiKeyStatus("checking");
    const controller = new AbortController();
    // Use withLanguage to canonicalize query param order — TMDB has a per-token
    // routing bug where /configuration without the right query order hangs ~8s.
    // Also add a client-side timeout so this never blocks startup indefinitely.
    fetch(`${tmdbApiBase()}${withLanguage("/configuration")}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(11000)]),
    })
      .then((res) => {
        if (res.status === 401 || res.status === 403)
          setApiKeyStatus("invalid_token");
        else setApiKeyStatus("ok");
      })
      .catch((err) => {
        if (err.name === "AbortError") return;
        setApiKeyStatus("unreachable");
      });
    return () => controller.abort();
  }, [apiKey]);

  useEffect(() => {
    const cancel = recheckApiKey();
    return cancel;
  }, [recheckApiKey]);

  // Load persisted downloads on startup + immediately prune missing files
  useEffect(() => {
    if (!window.electron) return;
    let mounted = true;
    window.electron.getDownloads().then(async (list) => {
      if (!mounted || !Array.isArray(list)) return;

      const pruned = [...list];
      const toRemove = new Set();

      await Promise.all(
        pruned.map(async (d) => {
          if (d.status !== "completed" || !d.filePath) return;
          const exists = await window.electron.fileExists(d.filePath);
          if (!exists) {
            // File gone, remove from registry silently
            window.electron.deleteDownload({ id: d.id, filePath: null });
            toRemove.add(d.id);
            return;
          }
          // Prune subtitle paths that no longer exist
          if (
            d.subtitlePaths?.length > 0 &&
            window.electron.pruneSubtitlePaths
          ) {
            const res = await window.electron.pruneSubtitlePaths(d.id);
            if (res?.ok) d.subtitlePaths = res.subtitlePaths;
          }
        }),
      );

      if (mounted) setDownloads(pruned.filter((d) => !toRemove.has(d.id)));
    });
    return () => {
      mounted = false;
    };
  }, []);

  // Listen for live progress events from main process
  useEffect(() => {
    if (!window.electron) return;
    const handler = window.electron.onDownloadProgress((update) => {
      // ── Desktop notification ──────────────────────
      if (
        update.status === "completed" &&
        storage.get(STORAGE_KEYS.NOTIFY_DOWNLOAD_COMPLETE) !== false &&
        window.electron.showNotification
      ) {
        window.electron.showNotification({
          title: "Загрузка завершена",
          body: update.name || "Файл скачан.",
          silent: false,
        });
      }

      setDownloads((prev) => {
        const idx = prev.findIndex((d) => d.id === update.id);
        if (idx === -1) {
          // Unknown id: either the entry was deleted (stale event after SIGKILL)
          // or a genuine race on first event.
          if (!update.name) return prev;
          return [update, ...prev];
        }
        const updated = [...prev];
        updated[idx] = { ...updated[idx], ...update };
        return updated;
      });
    });
    return () => window.electron.offDownloadProgress(handler);
  }, []);

  const handleDownloadStarted = useCallback((newEntry) => {
    setDownloads((prev) => {
      // Guard: if a progress event already added this id (race), just update it
      const idx = prev.findIndex((d) => d.id === newEntry.id);
      if (idx !== -1) {
        const updated = [...prev];
        updated[idx] = { ...updated[idx], ...newEntry };
        return updated;
      }
      return [newEntry, ...prev];
    });
  }, []);

  const handleDeleteDownload = useCallback((id) => {
    setDownloads((prev) => prev.filter((d) => d.id !== id));
  }, []);

  // Active download count for sidebar badge
  const activeDownloadCount = useMemo(
    () => downloads.filter((d) => d.status === "downloading").length,
    [downloads],
  );

  // ── Trending, single shared fetch fn avoids code duplication ────────────
  // Results are cached in localStorage for 30 min to avoid redundant API calls
  // and to keep trending data out of RAM between restarts.
  // The cache stores the active metadata language; if it differs from the
  // current setting the cache is treated as stale and data is re-fetched.
  const fetchTrending = useCallback(() => {
    if (!apiKey) return;
    const cached = storage.get("trendingCache");
    const CACHE_TTL = 30 * 60 * 1000; // 30 minutes
    const currentLang = storage.get(STORAGE_KEYS.TMDB_LANG) || "ru-RU";
    if (
      cached &&
      cached.ts &&
      cached.lang === currentLang &&
      Date.now() - cached.ts < CACHE_TTL
    ) {
      setTrending(cached.movies || []);
      setTrendingTV(cached.tv || []);
      return;
    }
    setLoadingHome(true);
    // Use /trending/all/week (stable) instead of /trending/movie/week +
    // /trending/tv/week — those two intermittently stall on TMDB's side (hang
    // without responding), which left the Home carousel spinning forever. The
    // combined feed returns both movie + tv items with a media_type field.
    tmdbFetch("/trending/all/week", apiKey)
      .then((all) => {
        const results = all.results || [];
        const movies = results.filter((r) => r.media_type === "movie");
        const tv = results.filter((r) => r.media_type === "tv");
        setTrending(movies);
        setTrendingTV(tv);
        storage.set("trendingCache", {
          movies,
          tv,
          ts: Date.now(),
          lang: currentLang,
        });
      })
      .catch(() => {})
      .finally(() => setLoadingHome(false));
  }, [apiKey]);

  useEffect(() => {
    fetchTrending();
  }, [fetchTrending]);

  const retryHome = useCallback(() => {
    if (offline) return;
    fetchTrending();
  }, [offline, fetchTrending]);

  // ── Sync librarySort when changed from Settings ───────────────────────────
  useEffect(() => {
    const handler = (e) => setLibrarySort(e.detail);
    window.addEventListener("streambert:library-sort-changed", handler);
    return () =>
      window.removeEventListener("streambert:library-sort-changed", handler);
  }, []);

  // ── Re-fetch trending immediately when metadata language changes ──────────
  useEffect(() => {
    const handler = () => fetchTrending();
    window.addEventListener("streambert:tmdb-lang-changed", handler);
    return () =>
      window.removeEventListener("streambert:tmdb-lang-changed", handler);
  }, [fetchTrending]);

  // ── Refresh player settings (accent + subtitle lang) after save ───────────
  useEffect(() => {
    const handler = () => setPlayerSettings(readPlayerSettings());
    window.addEventListener("streambert:player-settings-changed", handler);
    return () =>
      window.removeEventListener("streambert:player-settings-changed", handler);
  }, []);
  useEffect(() => {
    // Accent colour
    const accent = storage.get(STORAGE_KEYS.ACCENT_COLOR) || "red";
    applyAccentColor(accent);
    // Theme
    const theme = storage.get(STORAGE_KEYS.THEME) || "dark";
    const customVars = storage.get(STORAGE_KEYS.CUSTOM_THEME_VARS) || null;
    applyTheme(theme, customVars);
    // Font size
    const font = storage.get(STORAGE_KEYS.FONT_SIZE) || "normal";
    const zoomMap = { sm: 0.85, normal: 1, lg: 1.15 };
    const factor = zoomMap[font] ?? 1;
    if (window.electron?.setZoomFactor) window.electron.setZoomFactor(factor);
    // Compact mode
    const compact = !!storage.get(STORAGE_KEYS.COMPACT_MODE);
    document.body.classList.toggle("compact-mode", compact);
    // Reduce animations
    const noAnim = !!storage.get(STORAGE_KEYS.REDUCE_ANIMATIONS);
    document.body.classList.toggle("no-anim", noAnim);
  }, []);
  useEffect(() => {
    const goOnline = () => setOffline(false);
    const goOffline = () => setOffline(true);
    window.addEventListener("online", goOnline);
    window.addEventListener("offline", goOffline);
    return () => {
      window.removeEventListener("online", goOnline);
      window.removeEventListener("offline", goOffline);
    };
  }, []);

  // ── Deep link: ?room=CODE → open Watch Together and pre-fill the join ───────
  useEffect(() => {
    try {
      const code = new URLSearchParams(window.location.search).get("room");
      if (code) {
        setWtInitialCode(code.toUpperCase());
        setPage("together");
        setSelected(null);
        const route = { page: "together", selected: null };
        currentRouteRef.current = route;
        window.history.replaceState({ ...window.history.state, appRoute: route, appIndex: routeIndexRef.current, appStack: window.history.state?.appStack || [] }, "", "/together");
      } else {
        const route = { page, selected };
        currentRouteRef.current = route;
        window.history.replaceState({ ...window.history.state, appRoute: historyRoute(page, selected), appIndex: routeIndexRef.current, appStack: (window.history.state?.appStack || []).map((entry) => historyRoute(entry.page, entry.selected)) }, "", routeUrl(page, selected));
      }
    } catch {}
  }, []);

  // ── Navigation ────────────────────────────────────────────────────────────
  // Refs so navigate/navigateBack never need page/selected as deps
  const pageRef = useRef(page);
  const selectedRef = useRef(selected);
  useEffect(() => {
    pageRef.current = page;
  }, [page]);
  useEffect(() => {
    selectedRef.current = selected;
  }, [selected]);

  const navigateBack = useCallback(() => {
    if (!navStackRef.current.length) return;
    window.history.back();
  }, []);

  const navigate = useCallback((pg, data = null) => {
    const route = { page: pg, selected: data };
    const stack = [...navStackRef.current.map((entry) => historyRoute(entry.page, entry.selected)), historyRoute(pageRef.current, selectedRef.current)];
    routeIndexRef.current += 1;
    currentRouteRef.current = route;
    pageRef.current = pg;
    selectedRef.current = data;
    window.history.pushState({ appRoute: historyRoute(pg, data), appIndex: routeIndexRef.current, appStack: stack }, "", routeUrl(pg, data));
    setNavStack(stack);
    setSelected(data);
    setPage(pg);
    setShowSearch(false);
    // After navigating away, the previous page's component unmounts
    if (typeof gc === "function") {
      requestIdleCallback(() => gc(), { timeout: 2000 });
    }
  }, []);

  useEffect(() => {
    const onPopState = (event) => {
      const route = event.state?.appRoute || readRoute();
      const nextIndex = event.state?.appIndex || 0;
      const distance = nextIndex - routeIndexRef.current;
      if (event.state?.appStack) setNavStack(event.state.appStack);
      else if (distance < 0) setNavStack((prev) => prev.slice(0, distance));
      else if (distance > 0) setNavStack((prev) => [...prev, currentRouteRef.current]);
      routeIndexRef.current = nextIndex;
      currentRouteRef.current = route;
      pageRef.current = route.page;
      selectedRef.current = route.selected || null;
      setPage(route.page);
      setSelected(route.selected || null);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const updateTvRoute = useCallback((season, episode) => {
    const current = selectedRef.current;
    if (!current) return;
    const updated = { ...current, season, ...(episode ? { episode } : { episode: undefined }) };
    const route = { page: "tv", selected: updated };
    selectedRef.current = updated;
    currentRouteRef.current = route;
    window.history.replaceState({ ...window.history.state, appRoute: route }, "", routeUrl("tv", updated));
  }, []);

  // Stable identity callbacks for the app chrome: inline arrows here are fresh
  // closures on every App render, which defeats memo() on Sidebar/MobileTopBar
  // — and App re-renders on every playback progress tick (every 5 s during a
  // film), so the chrome (and its saved-list of poster <img>s) re-rendered
  // with it. Stable props let the memos bail out.
  const openSearch = useCallback(() => setShowSearch(true), []);
  const openShortcuts = useCallback(() => setShowShortcuts(true), []);
  const goSettings = useCallback(() => navigate("settings"), [navigate]);

  // ── Keyboard shortcuts ────────────────────────────────────────────────────
  useEffect(() => {
    const handler = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "f") {
        e.preventDefault();
        setShowSearch(true);
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        if (pageRef.current === "downloads") {
          e.preventDefault();
          setDlSearchOpen(true);
        }
      }
      if (e.key === "Escape") {
        setShowSearch(false);
        setShowShortcuts(false);
      }
      if (e.key === "?" && !e.ctrlKey && !e.metaKey) {
        const tag = (e.target?.tagName || "").toUpperCase();
        if (tag !== "INPUT" && tag !== "TEXTAREA") {
          e.preventDefault();
          setShowShortcuts((v) => !v);
        }
      }
      // Ctrl+Z / Cmd+Z → navigate back
      if ((e.metaKey || e.ctrlKey) && e.key === "z" && !e.shiftKey) {
        e.preventDefault();
        navigateBack();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "r") {
        e.preventDefault();
        window.location.reload();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [navigateBack]);

  // ── Helpers ───────────────────────────────────────────────────────────────
  const toastTimerRef = useRef(null);
  const showToast = useCallback((msg) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast(msg);
    toastTimerRef.current = setTimeout(() => setToast(null), 2500);
  }, []);

  const getMediaType = useCallback(
    (item) => item.media_type || (item.first_air_date ? "tv" : "movie"),
    [],
  );

  const handleSelectResult = useCallback(
    (item) => {
      navigate(item.media_type === "tv" ? "tv" : "movie", item);
    },
    [navigate],
  );

  const saveApiKey = useCallback((key) => {
    secureStorage.set("apikey", key);
    setApiKey(key);
  }, []);

  useEffect(() => {
    const stop = startViewingProfileSync();
    const applyRemoteState = (event) => {
      const data = event.detail || {};
      if (data.saved && typeof data.saved === "object") {
        setSaved(data.saved);
        setSavedOrder((current) => {
          const order = current || [];
          const merged = [...order.filter((key) => data.saved[key]), ...Object.keys(data.saved).filter((key) => !order.includes(key))];
          storage.set("savedOrder", merged);
          return merged;
        });
      }
      if (Array.isArray(data.history)) setHistory(data.history);
      if (data.watched && typeof data.watched === "object") setWatched(data.watched);
      if (data.progress && typeof data.progress === "object") setProgress(data.progress);
      if (data.resumeTime && typeof data.resumeTime === "object") {
        for (const [key, value] of Object.entries(data.resumeTime)) storage.set(`dlTime_${key}`, value);
      }
      if (typeof data.apiKey === "string" && data.apiKey) saveApiKey(data.apiKey);
    };
    window.addEventListener("streambert:profile-remote-applied", applyRemoteState);
    return () => {
      if (typeof stop === "function") stop();
      window.removeEventListener("streambert:profile-remote-applied", applyRemoteState);
    };
  }, [saveApiKey]);

  const changeApiKey = useCallback(() => {
    secureStorage.set("apikey", "");
    setApiKey(null);
    setApiKeyLoaded(true);
    setSkipped(false);
  }, []);

  // Ref so toggleSave never needs `saved` as a dep (avoids recreation on every save)
  const savedRef = useRef(saved);
  useEffect(() => {
    savedRef.current = saved;
  }, [saved]);

  const toggleSave = useCallback(
    (item) => {
      const mt = getMediaType(item);
      const id = `${mt}_${item.id}`;
      const currentSaved = savedRef.current;
      const isRemoving = !!currentSaved[id];
      const next = { ...currentSaved };

      if (isRemoving) {
        delete next[id];
        showToast("Удалено из избранного");
        setSavedOrder((prev) => {
          const currentOrder = prev || Object.keys(currentSaved);
          const newOrder = currentOrder.filter((k) => k !== id);
          storage.set("savedOrder", newOrder);
          return newOrder;
        });
      } else {
        next[id] = {
          id: item.id,
          title: item.title || item.name,
          poster_path: item.poster_path,
          media_type: mt,
          vote_average: item.vote_average,
          year: (item.release_date || item.first_air_date || "").slice(0, 4),
          ...catalogMetadata(item),
        };
        showToast("Добавлено в избранное");
        setSavedOrder((prev) => {
          const currentOrder = prev || Object.keys(currentSaved);
          const newOrder = [...currentOrder, id];
          storage.set("savedOrder", newOrder);
          return newOrder;
        });
      }
      setSaved(next);
      storage.set("saved", next);
    },
    [showToast, getMediaType],
  );

  const isSaved = useCallback(
    (item) => {
      const id = `${getMediaType(item)}_${item.id}`;
      return !!saved[id];
    },
    [saved, getMediaType],
  );

  const addHistory = useCallback((item) => {
    // Respect the "disable watch history" setting
    const historyEnabled = storage.get(STORAGE_KEYS.HISTORY_ENABLED);
    if (historyEnabled === 0 || historyEnabled === false) return;
    // TMDB details omit catalog provenance; retain the matching selected card.
    const selectedItem = selectedRef.current;
    const catalog = selectedItem?.id === item.id && getMediaType(selectedItem) === getMediaType(item)
      ? catalogMetadata(selectedItem) : catalogMetadata(item);
    const entry = {
      id: item.id,
      title: item.title || item.name,
      poster_path: item.poster_path,
      media_type: getMediaType(item),
      ...catalog,
      watchedAt: Date.now(),
      // Store as numbers so the progress key always matches exactly
      season: item.season != null ? Number(item.season) : null,
      episode: item.episode != null ? Number(item.episode) : null,
      episodeName: item.episodeName || null,
    };
    // Functional update - never reads stale history from closure
    setHistory((prev) => {
      // For TV: dedupe per episode (same show+season+episode).
      // For movies: dedupe by id+media_type as before.
      const filtered = prev.filter((h) => {
        if (h.id !== entry.id || h.media_type !== entry.media_type) return true;
        if (entry.media_type === "tv") {
          return !(h.season === entry.season && h.episode === entry.episode);
        }
        return false;
      });
      const next = [entry, ...filtered].slice(0, 100);
      storage.set("history", next);
      return next;
    });
  }, []); // no deps needed

  // Debounced disk write. The state update itself is immediate (the UI must
  // reflect it), but the JSON.stringify + synchronous localStorage.setItem of
  // the WHOLE progress map used to run on every 5 s playback tick — a main
  // thread block during decoding. The map is flushed at most once per 30 s,
  // and immediately on pagehide so a close never loses the last position.
  const progressFlushRef = useRef(null);
  const progressLatestRef = useRef(null);
  const flushProgress = useCallback(() => {
    progressFlushRef.current = null;
    if (progressLatestRef.current) {
      storage.set("progress", progressLatestRef.current);
      progressLatestRef.current = null;
    }
  }, []);
  useEffect(() => {
    const onHide = () => flushProgress();
    window.addEventListener("pagehide", onHide);
    document.addEventListener("visibilitychange", onHide);
    return () => {
      window.removeEventListener("pagehide", onHide);
      document.removeEventListener("visibilitychange", onHide);
      flushProgress();
    };
  }, [flushProgress]);

  const saveProgress = useCallback((key, pct) => {
    // Functional update - without this, TVPage's setInterval keeps spreading
    // the progress object from when the interval was created, overwriting
    // saves from other episodes (classic stale closure bug).
    setProgress((prev) => {
      if (prev[key] === pct) return prev; // no change - skip write
      const next = { ...prev, [key]: pct };
      progressLatestRef.current = next;
      if (!progressFlushRef.current) {
        progressFlushRef.current = setTimeout(flushProgress, 30000);
      }
      return next;
    });
  }, [flushProgress]);

  const markWatched = useCallback((key) => {
    setWatched((prev) => {
      const next = { ...prev, [key]: true };
      storage.set("watched", next);
      return next;
    });
  }, []);

  const markUnwatched = useCallback((key) => {
    setWatched((prev) => {
      const next = { ...prev };
      delete next[key];
      storage.set("watched", next);
      return next;
    });
  }, []);

  const removeHistory = useCallback((item) => {
    setHistory((prev) => {
      const next = prev.filter((h) => {
        if (h.id !== item.id || h.media_type !== item.media_type) return true;
        if (item.media_type === "tv") {
          return !(h.season === item.season && h.episode === item.episode);
        }
        return false;
      });
      storage.set("history", next);
      return next;
    });
  }, []);

  // Memoized, avoids re-filtering on every download-progress event
  // Pre-compute progress keys for history items once; only re-runs when history changes.
  const historyWithKeys = useMemo(
    () =>
      history
        .filter((h) => {
          if (h.media_type === "tv" && (h.season == null || h.episode == null))
            return false;
          return true;
        })
        .map((h) => ({
          ...h,
          _pk:
            h.media_type === "movie"
              ? `movie_${h.id}`
              : `tv_${h.id}_s${h.season}e${h.episode}`,
        })),
    [history],
  );

  // Filter by progress/watched
  const inProgress = useMemo(
    () =>
      historyWithKeys.filter((h) => {
        if (watched[h._pk]) return false;
        const pct = progress[h._pk];
        return pct != null && pct > 2 && pct < 98;
      }),
    [historyWithKeys, progress, watched],
  );

  // Memoized, avoids re-mapping on every download-progress event
  const savedList = useMemo(() => {
    const orderedKeys = savedOrder
      ? savedOrder.filter((k) => saved[k])
      : Object.keys(saved);
    const list = orderedKeys.map((k) => saved[k]).filter(Boolean);
    if (librarySort === "title")
      return [...list].sort((a, b) =>
        (a.title || "").localeCompare(b.title || ""),
      );
    if (librarySort === "rating")
      return [...list].sort(
        (a, b) => (b.vote_average || 0) - (a.vote_average || 0),
      );
    if (librarySort === "year")
      return [...list].sort((a, b) =>
        (b.year || "").localeCompare(a.year || ""),
      );
    return list;
  }, [saved, savedOrder, librarySort]);

  const handleReorderSaved = useCallback((newOrder) => {
    setSavedOrder(newOrder);
    storage.set("savedOrder", newOrder);
  }, []);

  // Stable handler
  const handleGoToDownloads = useCallback(
    (id) => {
      setHighlightDownload(id || null);
      navigate("downloads");
    },
    [navigate],
  );

  if (!apiKeyLoaded) return null; // wait for secure storage to resolve
  if (!apiKey && !skipped && page !== "devices" && page !== "settings")
    return <SetupScreen onSave={saveApiKey} onSkip={() => setSkipped(true)} />;

  const hasCustomTitlebar = platform === "win32" || platform === "linux";

  return (
    <ErrorBoundary>
      {hasCustomTitlebar && <WindowTitlebar />}
      <div>
        <Sidebar
          page={page}
          onNavigate={navigate}
          onSearch={openSearch}
          savedList={savedList}
          activeDownloads={activeDownloadCount}
          onReorderSaved={handleReorderSaved}
          onRemoveSaved={toggleSave}
          canGoBack={navStack.length > 0}
          onBack={navigateBack}
          onShowShortcuts={openShortcuts}
        />

        <div className="main">
          {/* Mobile-only top bar (Back/Search/Settings). Hidden on desktop via CSS. */}
          <MobileTopBar
            page={page}
            canGoBack={navStack.length > 0}
            onBack={navigateBack}
            onSearch={openSearch}
            onSettings={goSettings}
            onNavigate={navigate}
          />
          {/* ── API key status banner ── */}
          {/* Suspense boundary: lazy page chunks are fetched on first visit */}
          {apiKeyStatus === "invalid_token" && (
            <div className="api-status-banner api-status-error">
              <span>
                ⚠ Your TMDB token is invalid, not set or has been revoked.
                Movies and shows won't load.
              </span>
              <button className="api-status-btn" onClick={changeApiKey}>
                Update Token
              </button>
            </div>
          )}
          {apiKeyStatus === "unreachable" && (
            <div className="api-status-banner api-status-warn">
              <span>
                ⚠ Cannot reach TMDB, check your internet connection. Content may
                not load.
              </span>
              <button className="api-status-btn" onClick={recheckApiKey}>
                Retry
              </button>
            </div>
          )}
          <Suspense
            fallback={
              <div
                style={{
                  color: "var(--text2)",
                  padding: 48,
                  textAlign: "center",
                  fontSize: 15,
                }}
              >
                Laden…
              </div>
            }
          >
            {page === "home" && (
              <HomePage
                trending={trending}
                trendingTV={trendingTV}
                loading={loadingHome}
                onSelect={handleSelectResult}
                progress={progress}
                inProgress={inProgress}
                offline={offline}
                onRetry={retryHome}
                watched={watched}
                onMarkWatched={markWatched}
                onMarkUnwatched={markUnwatched}
                history={history}
                apiKey={apiKey}
              />
            )}
            {page === "movie" && selected && (
              <MoviePage
                key={selected.id}
                item={selected}
                apiKey={apiKey}
                playerSettings={playerSettings}
                onSave={() => toggleSave(selected)}
                isSaved={isSaved(selected)}
                onHistory={addHistory}
                progress={progress}
                saveProgress={saveProgress}
                onBack={() => navStack.length ? navigateBack() : navigate("home")}
                onSettings={(section) =>
                  navigate("settings", { section: section || null })
                }
                onDownloadStarted={handleDownloadStarted}
                watched={watched}
                onMarkWatched={markWatched}
                onMarkUnwatched={markUnwatched}
                downloads={downloads}
                onGoToDownloads={handleGoToDownloads}
                onSelect={handleSelectResult}
              />
            )}
            {page === "tv" && selected && (
              <TVPage
                key={`${selected.id}-${selected.season ?? ""}-${selected.episode ?? ""}`}
                item={selected}
                apiKey={apiKey}
                onRouteChange={updateTvRoute}
                playerSettings={playerSettings}
                onSave={() => toggleSave(selected)}
                isSaved={isSaved(selected)}
                onHistory={addHistory}
                progress={progress}
                saveProgress={saveProgress}
                onBack={() => navStack.length ? navigateBack() : navigate("home")}
                onSettings={(section) =>
                  navigate("settings", { section: section || null })
                }
                onDownloadStarted={handleDownloadStarted}
                watched={watched}
                onMarkWatched={markWatched}
                onMarkUnwatched={markUnwatched}
                downloads={downloads}
                onGoToDownloads={handleGoToDownloads}
              />
            )}
            {page === "history" && (
              <LibraryPage
                history={history}
                inProgress={inProgress}
                saved={savedList}
                progress={progress}
                onSelect={handleSelectResult}
                watched={watched}
                onMarkWatched={markWatched}
                onMarkUnwatched={markUnwatched}
                onRemoveHistory={removeHistory}
              />
            )}
            {page === "discover" && (
              <DiscoverPage
                apiKey={apiKey}
                onSelect={handleSelectResult}
                watched={watched}
                onMarkWatched={markWatched}
                onMarkUnwatched={markUnwatched}
                progress={progress}
              />
            )}
            {page === "together" && (
              <WatchTogetherPage
                apiKey={apiKey}
                initialCode={wtInitialCode}
                progress={progress}
                watched={watched}
                onMarkWatched={markWatched}
                onMarkUnwatched={markUnwatched}
              />
            )}
            {page === "settings" && (
              <SettingsPage
                apiKey={apiKey}
                onChangeApiKey={changeApiKey}
                initialSection={selected?.section}
              />
            )}
            {page === "downloads" && (
              <DownloadsPage
                downloads={downloads}
                onDeleteDownload={handleDeleteDownload}
                onHistory={addHistory}
                onSaveProgress={saveProgress}
                progress={progress}
                watched={watched}
                onMarkWatched={markWatched}
                onMarkUnwatched={markUnwatched}
                highlightId={highlightDownload}
                onClearHighlight={() => setHighlightDownload(null)}
                onSelect={handleSelectResult}
                searchOpen={dlSearchOpen}
                onSearchClose={() => setDlSearchOpen(false)}
                onSettings={(section) =>
                  navigate("settings", { section: section || null })
                }
                onUpdateDownload={(id, updates) =>
                  setDownloads((prev) =>
                    prev.map((d) => (d.id === id ? { ...d, ...updates } : d)),
                  )
                }
              />
            )}
            {page === "devices" && <PersonalDevicesPage initialPairToken={selected?.pairToken} apiKey={apiKey} onApiKeySaved={saveApiKey} onNavigateSettings={() => navigate("settings")} />}
            {page === "recap" && <MonthlyRecapPage history={history} />}
            {page === "tonight" && <TonightPage apiKey={apiKey} history={history} watched={watched} onSelect={handleSelectResult} />}
          </Suspense>
        </div>

        {showSearch && (
          <SearchModal
            apiKey={apiKey}
            onSelect={handleSelectResult}
            onClose={() => setShowSearch(false)}
            offline={offline}
          />
        )}
        {updateBanner && (
          <div
            style={{
              position: "fixed",
              top: hasCustomTitlebar ? 32 : 0,
              left: 0,
              right: 0,
              zIndex: 9999,
              background: "rgba(229,9,20,0.92)",
              backdropFilter: "blur(8px)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 16,
              padding: "10px 24px",
              boxShadow: "0 2px 16px rgba(0,0,0,0.4)",
              fontSize: 14,
              fontWeight: 500,
              color: "#fff",
            }}
          >
            <span>🎉 Streambert v{updateBanner.latest} is available!</span>
            <button
              onClick={() => setShowUpdateModal(true)}
              style={{
                color: "#fff",
                fontWeight: 700,
                background: "rgba(255,255,255,0.18)",
                border: "1px solid rgba(255,255,255,0.4)",
                borderRadius: 6,
                padding: "4px 12px",
                fontSize: 13,
                cursor: "pointer",
              }}
            >
              Install Update
            </button>
            <button
              onClick={() => setUpdateBanner(null)}
              style={{
                background: "transparent",
                border: "none",
                color: "rgba(255,255,255,0.7)",
                cursor: "pointer",
                fontSize: 18,
                lineHeight: 1,
                padding: "0 4px",
              }}
              aria-label="Закрыть"
            >
              ×
            </button>
          </div>
        )}
        {showUpdateModal && updateBanner && (
          <UpdateModal
            updateInfo={updateBanner}
            activeDownloads={activeDownloadCount}
            onClose={() => setShowUpdateModal(false)}
          />
        )}
        {toast && <div className="toast">{toast}</div>}

        {/* ── Episode check status pill / result card ── */}
        {episodeCheckStatus && (
          <div
            style={{
              position: "fixed",
              bottom: 24,
              left: "calc(var(--sidebar) + 24px)",
              zIndex: 500,
              background: "var(--surface2)",
              border: "1px solid var(--border)",
              borderRadius: "var(--radius)",
              boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
              animation: "slideUp 0.3s ease",
              minWidth: 260,
              maxWidth: 400,
            }}
          >
            {episodeCheckStatus === "checking" && (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "12px 18px",
                  fontSize: 14,
                  color: "var(--text2)",
                }}
              >
                <span
                  style={{
                    display: "inline-block",
                    width: 14,
                    height: 14,
                    border: "2px solid var(--text3)",
                    borderTopColor: "var(--red)",
                    borderRadius: "50%",
                    animation: "spin 0.7s linear infinite",
                    flexShrink: 0,
                  }}
                />
                Checking for new episodes…
              </div>
            )}

            {episodeCheckStatus === "none" && (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  padding: "12px 18px",
                  fontSize: 14,
                  color: "var(--text3)",
                }}
              >
                <span style={{ fontSize: 16 }}>✓</span>
                No new episodes found
              </div>
            )}

            {episodeCheckStatus?.entries && (
              <div style={{ padding: "14px 18px" }}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    marginBottom: 10,
                  }}
                >
                  <div
                    style={{
                      fontSize: 13,
                      fontWeight: 700,
                      color: "var(--text)",
                      display: "flex",
                      alignItems: "center",
                      gap: 7,
                    }}
                  >
                    <span style={{ color: "var(--red)", fontSize: 15 }}>
                      🎬
                    </span>
                    New episode
                    {episodeCheckStatus.entries.length > 1 ? "s" : ""} available
                  </div>
                  <button
                    onClick={() => {
                      clearTimeout(episodeDismissTimerRef.current);
                      setEpisodeCheckStatus(null);
                    }}
                    style={{
                      background: "none",
                      border: "none",
                      color: "var(--text3)",
                      cursor: "pointer",
                      fontSize: 18,
                      lineHeight: 1,
                      padding: "0 2px",
                    }}
                    aria-label="Закрыть"
                  >
                    ×
                  </button>
                </div>
                <ul
                  style={{
                    margin: 0,
                    padding: 0,
                    listStyle: "none",
                    display: "flex",
                    flexDirection: "column",
                    gap: 4,
                  }}
                >
                  {episodeCheckStatus.entries.slice(0, 5).map((entry) => (
                    <li
                      key={entry.id}
                      className="episode-check-item"
                      onClick={() => {
                        clearTimeout(episodeDismissTimerRef.current);
                        navigate("tv", {
                          ...entry.seriesItem,
                          season: entry.season ?? 1,
                        });
                        setEpisodeCheckStatus(null);
                      }}
                      style={{
                        fontSize: 13,
                        color: "var(--text2)",
                        padding: "5px 0",
                        paddingBottom: 7,
                        borderBottom: "1px solid var(--border)",
                        cursor: "pointer",
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        gap: 8,
                        borderRadius: 4,
                        transition: "color 0.15s",
                      }}
                    >
                      <span
                        style={{
                          flex: 1,
                          minWidth: 0,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {entry.title}
                      </span>
                      {entry.season != null && (
                        <span
                          style={{
                            fontSize: 11,
                            color: "var(--text3)",
                            background: "var(--surface3)",
                            borderRadius: 4,
                            padding: "1px 6px",
                            flexShrink: 0,
                          }}
                        >
                          Season {entry.season}
                        </span>
                      )}
                    </li>
                  ))}
                  {episodeCheckStatus.entries.length > 5 && (
                    <li
                      style={{
                        fontSize: 12,
                        color: "var(--text3)",
                        paddingTop: 2,
                      }}
                    >
                      +{episodeCheckStatus.entries.length - 5} more
                    </li>
                  )}
                </ul>
              </div>
            )}
          </div>
        )}
        {closeConfirm && (
          <CloseConfirmModal
            count={closeConfirm.count}
            onConfirm={() => {
              setCloseConfirm(null);
              window.electron.respondClose(true);
            }}
            onCancel={() => {
              setCloseConfirm(null);
              window.electron.respondClose(false);
            }}
          />
        )}
        {showShortcuts && (
          <KeyboardShortcutsModal onClose={() => setShowShortcuts(false)} />
        )}
      </div>
    </ErrorBoundary>
  );
}
