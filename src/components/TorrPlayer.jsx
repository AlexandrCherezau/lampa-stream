// ── TorrPlayer: in-app player for the TorrServer "Торренты" source ──────────
// Owns the whole flow for this source: pick a torrent (search via Jackett /
// existing TorrServer DB / add a magnet) → resolve to a TorrServer stream URL →
// play with hls.js (multi-audio HLS) selecting the RU dub by default, with a
// raw-stream + external-player fallback. Reports progress back to the page.
//
// The Russian-audio ability comes from the torrent content itself (RU dub
// tracks in the mkv), surfaced through the local TorrServer — the browser
// `<video>`/hls.js engine only gets multi-audio when TorrServer serves HLS
// (#EXT-X-MEDIA audio renditions). When HLS isn't available we fall back to
// the raw stream and offer launching mpv/VLC (which always works with any
// container + any audio track).

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
// hls.js (~150KB) loaded lazily only when a torrent HLS stream attaches, so it
// stays out of the initial bundle. Shared cache with OnlinePlayer's loader.
let _HlsPromise = null;
function loadHls() {
  if (!_HlsPromise) _HlsPromise = import("hls.js").then((m) => m.default);
  return _HlsPromise;
}
import {
  torrPing,
  torrList,
  torrAdd,
  torrAddFile,
  torrGet,
  torrStream,
  torrExternal,
  torrSearch,
  torrGetCfg,
  torrSetCfg,
  torrRem,
  pickTorrentFile,
  normalizeFiles,
  preferredAudioTrackIndex,
  guessEpisodeFileIndex,
  bestFileName,
  hashFromResult,
} from "../utils/torrserver-client";
import { storage, formatBytes, STORAGE_KEYS, setCappedMap } from "../utils/storage";
import { getPlaybackCheckpoint, waitForViewingProfile, savePlaybackCheckpoint, flushViewingProfile, recordViewingSession, registerViewingProfileClosingCapture } from "../utils/viewingProfile";
import { crossedPlaybackPosition, crossedWatchedThreshold, hasGenuinePlaybackForEnd, shouldApplyResumePosition } from "../utils/playbackCompletion";
import { fetchAniSkipTimings } from "../utils/aniSkip";
import { fallbackTimings, mergeTimings } from "../utils/introDetect";
import { fetchAnilistData, isAnimeContent } from "../utils/api";
import { CloseIcon, ExternalLinkIcon, SourceIcon } from "./Icons";

const fmt = (s) => {
  if (!s || !isFinite(s)) return "0:00";
  const m = Math.floor(s / 60);
  const ss = Math.floor(s % 60);
  return `${m}:${ss < 10 ? "0" : ""}${ss}`;
};

const stableTrackText = (value) => String(value || "").normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

function newPlaybackSessionId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  globalThis.crypto?.getRandomValues?.(bytes);
  if (!bytes.some(Boolean)) for (let i = 0; i < bytes.length; i++) bytes[i] = Math.random() * 256;
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function applySavedEmbeddedSubtitle(video, preference) {
  if (!video?.textTracks) return;
  const external = new Set(Array.from(video.querySelectorAll("track[data-cc]"), (element) => element.track));
  const tracks = Array.from(video.textTracks).filter((track) => !external.has(track));
  const lang = stableTrackText(preference?.lang);
  const name = stableTrackText(preference?.name);
  const selected = preference?.enabled && preference.kind === "embedded"
    ? tracks.find((track) => stableTrackText(track.language) === lang && stableTrackText(track.label) === name)
      || (lang ? tracks.find((track) => stableTrackText(track.language) === lang) : null)
      || (name ? tracks.find((track) => stableTrackText(track.label) === name) : null)
    : null;
  for (const track of tracks) track.mode = track === selected ? "showing" : "disabled";
}

// Small inline icons
const PlayI = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" width="22" height="22">
    <polygon points="5 3 19 12 5 21 5 3" />
  </svg>
);
const PauseI = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" width="22" height="22">
    <rect x="6" y="4" width="4" height="16" />
    <rect x="14" y="4" width="4" height="16" />
  </svg>
);
const Back10I = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20">
    <path d="M12 5V2L7 6l5 4V7a6 6 0 1 1-6 6" />
    <text x="12" y="17" fontSize="7" fill="currentColor" stroke="none" textAnchor="middle" fontWeight="700">10</text>
  </svg>
);
const Fwd10I = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20">
    <path d="M12 5V2l5 4-5 4V7a6 6 0 1 0 6 6" />
    <text x="12" y="17" fontSize="7" fill="currentColor" stroke="none" textAnchor="middle" fontWeight="700">10</text>
  </svg>
);
const FullscreenI = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20">
    <path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M3 16v3a2 2 0 0 0 2 2h3" />
  </svg>
);
const VolumeI = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20">
    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor" stroke="none" />
    <path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a9 9 0 0 1 0 14" />
  </svg>
);
const MuteI = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20">
    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor" stroke="none" />
    <line x1="23" y1="9" x2="17" y2="15" />
    <line x1="17" y1="9" x2="23" y2="15" />
  </svg>
);
const AudioI = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20">
    <path d="M3 18v-6a9 9 0 0 1 18 0v6" />
    <path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z" />
  </svg>
);
const SearchI = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18">
    <circle cx="11" cy="11" r="8" />
    <path d="m21 21-4.35-4.35" />
  </svg>
);
const PlusI = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18">
    <line x1="12" y1="5" x2="12" y2="19" />
    <line x1="5" y1="12" x2="19" y2="12" />
  </svg>
);

export default function TorrPlayer({
  queryTitle,
  isTv = false,
  season = null,
  episode = null,
  title,
  progressKey,
  saveProgress,
  onMarkWatched,
  watchedThreshold = 20,
  torrentHint = null, // optional magnet/hash to pre-add
  // ── Skip intro/outro/recap + next-episode (optional; need item/details for
  // anime AniSkip detection). type is derived from isTv. ──
  item = null,
  details = null,
  onNext = null,
}) {
  const videoRef = useRef(null);
  const resumeTargetRef = useRef(null);
  const resumeTargetTimerRef = useRef(null);
  const [checkpoint, setCheckpoint] = useState(() => {
    try { return progressKey ? getPlaybackCheckpoint(progressKey) : null; } catch { return null; }
  });
  const checkpointRef = useRef(checkpoint); checkpointRef.current = checkpoint;
  const [profileReadyKey, setProfileReadyKey] = useState(null);
  const profileReady = profileReadyKey === progressKey;
  const viewingItem = useMemo(() => ({
    type: isTv ? "tv" : "movie", id: String(item?.id || /^(?:movie|tv)_(\d+)/.exec(progressKey || "")?.[1] || ""),
    title: String(details?.title || details?.name || item?.title || item?.name || title || queryTitle || ""),
    ...(item?.poster_path ? { poster_path: item.poster_path } : {}),
    ...(isTv ? { season: Number(season), episode: Number(episode) } : {}),
    genres: (Array.isArray(details?.genres) ? details.genres : [])
      .filter((genre) => Number.isSafeInteger(Number(genre?.id)) && genre?.name)
      .map((genre) => ({ id: Number(genre.id), name: String(genre.name) })),
    ...(details?.imdb_id || item?.imdb_id ? { imdb_id: details?.imdb_id || item?.imdb_id } : {}),
  }), [isTv, item, details, title, queryTitle, season, episode, progressKey]);
  const viewingItemRef = useRef(viewingItem); viewingItemRef.current = viewingItem;
  const viewingSessionRef = useRef(null);
  const hlsRef = useRef(null);
  const errCountRef = useRef(0);
  const containerRef = useRef(null);
  const progressTimerRef = useRef(null);
  const saveRef = useRef(saveProgress);
  saveRef.current = saveProgress;
  const markWatchedRef = useRef(onMarkWatched);
  markWatchedRef.current = onMarkWatched;
  const persistCheckpoint = useCallback((position, preferencePatch = null, flush = false, updateState = true) => {
    if (!progressKey || !viewingItem.id) return;
    const previous = checkpointRef.current || {};
    const value = {
      position: Number.isFinite(position) && position >= 0 ? Math.round(position * 1000) / 1000 : (previous.position || 0),
      duration: Number.isFinite(videoRef.current?.duration) && videoRef.current.duration > 0 ? videoRef.current.duration : (previous.duration || 0),
      item: viewingItem,
      preferences: preferencePatch ? { ...(previous.preferences || {}), ...preferencePatch } : (previous.preferences || {}),
    };
    checkpointRef.current = value;
    if (updateState) setCheckpoint(value);
    try { savePlaybackCheckpoint(progressKey, value, { flush }); } catch {}
  }, [progressKey, viewingItem]);

  useEffect(() => {
    let live = true;
    const controller = new AbortController();
    let local = null;
    try { local = progressKey ? getPlaybackCheckpoint(progressKey) : null; } catch {}
    checkpointRef.current = local;
    setCheckpoint(local);
    (async () => {
      try { await waitForViewingProfile({ timeoutMs: 8000, signal: controller.signal }); } catch {}
      if (!live || controller.signal.aborted) return;
      let latest = local;
      try { latest = progressKey ? (getPlaybackCheckpoint(progressKey) || local) : null; } catch {}
      if (latest) {
        checkpointRef.current = latest;
        setCheckpoint(latest);
        if (Number.isFinite(latest.position) && latest.position >= 0) {
          try {
            const map = storage.get(STORAGE_KEYS.RESUME_TIME) || {};
            map[progressKey] = latest.position;
            setCappedMap(STORAGE_KEYS.RESUME_TIME, map);
          } catch {}
        }
      }
      setProfileReadyKey(progressKey);
    })();
    return () => { live = false; controller.abort(); };
  }, [progressKey]);

  const [cfg, setCfg] = useState(null);
  const [tab, setTab] = useState("search"); // search | db | add
  const [searchQuery, setSearchQuery] = useState(queryTitle || "");
  const [results, setResults] = useState([]);
  const [dbTorrents, setDbTorrents] = useState([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");

  // Chosen torrent + file
  const [activeHash, setActiveHash] = useState(null);
  const [files, setFiles] = useState([]);
  const [fileIndex, setFileIndex] = useState(null);

  // Playback
  const [stream, setStream] = useState(null); // {raw, hls}
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);
  const [audioTracks, setAudioTracks] = useState([]);
  const [audioId, setAudioId] = useState(-1);
  const [showTracks, setShowTracks] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [controlsVisible, setControlsVisible] = useState(true);
  const hideTimerRef = useRef(null);

  // ── Skip intro/outro/recap + next-episode-when-ending ──────────────────────
  // Anime series use AniSkip (exact, via AniList idMal); movies & non-anime
  // use safe fallback timings (no audio tap → no mute risk). Both default to
  // "manual" so the skip buttons appear out of the box.
  const [skipTimings, setSkipTimings] = useState(null);
  const skipTimingsRef = useRef(skipTimings);
  skipTimingsRef.current = skipTimings;
  const [skipPrompt, setSkipPrompt] = useState(null);
  const [introSkipMode] = useState(
    () => storage.get(STORAGE_KEYS.INTRO_SKIP_MODE) || "manual",
  );
  // Default "off", not "manual": the fallback timings fabricate a ~30 s intro
  // for ANY title (they exist to keep the anime path safe, not to guess), so
  // the old default put a "ПРОПУСТИТЬ ИНТРО" button over the first 30 seconds
  // of every film and every non-anime episode. Viewers who want it enable it
  // in Settings; the button now means what it says.
  const [heuristicSkipMode] = useState(
    () => storage.get(STORAGE_KEYS.SKIP_HEURISTIC_MODE) || "off",
  );
  const skipTimerRef = useRef(null);
  const onNextRef = useRef(onNext);
  onNextRef.current = onNext;
  const nextFiredRef = useRef(false);
  // Refs for the auto-pick-on-episode-change effect: read the latest values
  // without adding them to the effect's deps (which would retrigger on every
  // file/state change and fight the user's manual file selection).
  const activeHashRef = useRef(activeHash); activeHashRef.current = activeHash;
  const filesRef = useRef(files); filesRef.current = files;
  const fileIndexRef = useRef(fileIndex); fileIndexRef.current = fileIndex;
  const pickFileManuallyRef = useRef(null);
  const type = isTv ? "tv" : "movie";
  const isAnimeSeries =
    type === "tv" && !!episode && !!item && isAnimeContent(item, details);
  const activeSkipMode = isAnimeSeries ? introSkipMode : heuristicSkipMode;

  // Load config + initial listing + (optionally) auto-search
  useEffect(() => {
    (async () => {
      // Reachability check FIRST: if TorrServer is down/booting, say so now
      // instead of letting every follow-up call (add/get/stream) time out
      // one by one. torrPing has its own 5 s deadline.
      try {
        const p = await torrPing();
        if (p && p.ok === false) {
          setError("TorrServer недоступен. Проверьте адрес в Настройках → TorrServer.");
        }
      } catch (err) {
        setError(err?.message || "TorrServer недоступен. Проверьте адрес в Настройках → TorrServer.");
      }
      let c = {};
      try { c = (await torrGetCfg()) || {}; } catch (err) { setError(err?.message || "Не удалось прочитать настройки TorrServer"); }
      setCfg(c);
      try {
        const list = await torrList();
        if (list?.ok) setDbTorrents(list.list || []);
      } catch {}
      if (torrentHint) {
        await handleAdd(torrentHint, "Из источника", c);
      } else if (c.jackettUrl) {
        runSearch(queryTitle, c);
      } else {
        setTab("db");
      }
    })();
    return () => {
      destroyHls();
      clearInterval(progressTimerRef.current);
      clearInterval(skipTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const destroyHls = useCallback(() => {
    if (hlsRef.current) {
      try {
        hlsRef.current.destroy();
      } catch {}
      hlsRef.current = null;
    }
  }, []);

  // ── Search via Jackett ───────────────────────────────────────────────────────
  const runSearch = useCallback(async (q, c = cfg) => {
    if (!q) return;
    setBusy("search");
    setError("");
    setResults([]);
    let res;
    try { res = await torrSearch(q); }
    catch (err) { setBusy(""); setError(err?.message || "Поиск не удался"); return; }
    setBusy("");
    if (!res?.ok) {
      setError(res?.error || "Поиск не удался");
      return;
    }
    setResults(res.results || []);
    if (!(res.results || []).length) setError("Ничего не найдено. Настройте Jackett или добавьте magnet вручную.");
  }, [cfg]);

  // ── Add a magnet/hash/torrent and resolve files ─────────────────────────────
  const handleAdd = useCallback(
    async (link, displayTitle, c = cfg) => {
      setBusy("add");
      setError("");
      let res;
      try { res = await torrAdd({ link, title: `[Lampa-Stream] ${displayTitle || ""}` }); }
      catch (err) { setBusy(""); setError(err?.message || "Не удалось добавить торрент"); return false; }
      setBusy("");
      if (!res?.ok) {
        setError(res?.error || "Не удалось добавить торрент");
        return false;
      }
      const t = res.torrent || {};
      const hash = (t.hash || t.Hash || hashFromResult({ magnet: link }) || "").toLowerCase();
      if (!hash) {
        setError("TorrServer не вернул hash торрент-файла");
        return false;
      }
      setActiveHash(hash);
      const fl = normalizeFiles(t);
      setFiles(fl);
      return pickFileAndPlay(hash, fl, c);
    },
    [cfg],
  );

  // ── Choose file index (TV episode guess / movie largest) then build stream ──
  const pickFileAndPlay = useCallback(
    async (hash, fl, c = cfg) => {
      let idx;
      if (isTv) idx = guessEpisodeFileIndex(fl, { season, episode });
      else {
        let best = fl[0];
        for (const f of fl) if ((f.size || 0) > (best.size || 0)) best = f;
        idx = best?.index ?? 0;
      }
      setFileIndex(idx);
      const fileName = bestFileName(fl, idx);
      setBusy("stream");
      setError("");
      let s;
      try { s = await torrStream({ hash, index: idx, fileName }); }
      catch (err) { setBusy(""); setError(err?.message || "TorrServer недоступен. Проверьте адрес в Настройках."); return; }
      setBusy("");
      if (!s?.ok) {
        setError(s?.error || "TorrServer недоступен. Проверьте адрес в Настройках.");
        return;
      }
      setStream({ raw: s.raw, hls: s.hls });
    },
    [cfg, isTv, season, episode],
  );

  // ── When stream URL changes, attach hls.js or raw src ──────────────────────
  useEffect(() => {
    if (!stream || !profileReady) return;
    const v = videoRef.current;
    if (!v) return;
    destroyHls();
    errCountRef.current = 0;
    setCurrent(0);
    setDuration(0);
    setAudioTracks([]);
    setAudioId(-1);
    setSkipTimings(null);
    setSkipPrompt(null);
    nextFiredRef.current = false; // new file → allow one next-episode trigger

    // Resume from the exact saved timecode (same mechanism as OnlinePlayer).
    // Handed to hls.js as startPosition so the FIRST fragment request lands
    // at the resume offset — without it, a resumed film buffers from 0 and
    // re-attaches (~3-4× a cold start). The raw path seeks on loadedmetadata.
    // Skip an essentially-finished title (progress ≥ 95%).
    let resumeStart = -1;
    try {
      const tMap = storage.get(STORAGE_KEYS.RESUME_TIME) || {};
      const pMap = storage.get(STORAGE_KEYS.WATCH_PROGRESS) || {};
      const t = checkpointRef.current?.position ?? tMap[progressKey];
      const pct = pMap[progressKey];
      if (shouldApplyResumePosition({ position: t, progressPercent: pct, hasExplicitCheckpoint: Number.isFinite(checkpointRef.current?.position) })) resumeStart = t;
    } catch {}
    resumeTargetRef.current = resumeStart >= 0.5 ? resumeStart : null;
    clearTimeout(resumeTargetTimerRef.current);
    if (resumeStart >= 0.5) {
      // Native HLS/raw players can miss `seeked` on some browsers. Never let a
      // stalled initial resume suppress watch-time sampling indefinitely.
      resumeTargetTimerRef.current = setTimeout(() => {
        if (resumeTargetRef.current === resumeStart) resumeTargetRef.current = null;
        resumeTargetTimerRef.current = null;
      }, 5000);
    }

    const tryExternalOnly = () => {
      // TorrServer reachable but no HLS → raw may still play mp4. Clear any
      // previous src first: a lingering src keeps buffering the old file and
      // can wedge the new attach.
      try { v.removeAttribute("src"); v.load(); } catch {}
      v.src = stream.raw;
      v.addEventListener("loadedmetadata", () => applySavedEmbeddedSubtitle(v, checkpointRef.current?.preferences?.subtitle), { once: true });
      // The native path has no ABR ladder and no retry: a decode failure is
      // terminal, so surface it instead of leaving a dead play button with
      // no message and no recovery path.
      v.addEventListener("error", () => {
        setError("Поток недоступен. Попробуйте другой файл торрента или внешний плеер.");
      }, { once: true });
      if (resumeStart >= 0.5) {
        v.addEventListener("loadedmetadata", () => { try { v.currentTime = resumeStart; } catch {} }, { once: true });
      }
      v.play().catch(() => {});
    };

    // Guard: if the effect cleans up (stream change/unmount) while hls.js is
    // still being dynamically imported, bail before attaching.
    let disposed = false;

    (async () => {
      if (!stream.hls) { tryExternalOnly(); return; }
      const Hls = await loadHls();
      if (disposed) return;
      if (Hls.isSupported()) {
        // Buffer config tuned for TorrServer: every segment must first be
        // PRODUCED by TorrServer fetching the corresponding torrent pieces,
        // so a 30 s forward buffer (hls.js default) leaves the playhead one
        // piece-fetch hiccup away from a rebuffer. A 120 s forward buffer
        // plus patient fragment timeouts/retries absorb the legitimately
        // slow-but-working case instead of surfacing it as a stall.
        const hls = new Hls({
          enableWorker: true,
          lowLatencyMode: false,
          backBufferLength: 60,
          capLevelToPlayerSize: true,
          maxBufferLength: 120,
          maxMaxBufferLength: 600,
          maxBufferSize: 200 * 1000 * 1000,
          fragLoadingMaxRetry: 8,
          fragLoadingTimeOut: 30000,
          fragLoadingMaxRetryTimeout: 60000,
          startPosition: resumeStart,
        });
        hlsRef.current = hls;
        hls.loadSource(stream.hls);
        hls.attachMedia(v);
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          v.play().catch(() => {});
        });
        hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, () => {
          const tracks = hls.audioTracks || [];
          const labeled = tracks.map((t, i) => ({ id: i, name: t.name || t.lang || `Аудио ${i + 1}`, lang: t.lang || "" }));
          setAudioTracks(labeled);
          const saved = checkpointRef.current?.preferences?.audio;
          const savedLang = stableTrackText(saved?.lang), savedName = stableTrackText(saved?.name);
          let pref = saved ? labeled.findIndex((track) => savedLang && savedName
            ? stableTrackText(track.lang) === savedLang && stableTrackText(track.name) === savedName : false) : -1;
          if (pref < 0 && savedLang) pref = labeled.findIndex((track) => stableTrackText(track.lang) === savedLang);
          if (pref < 0 && savedName) pref = labeled.findIndex((track) => stableTrackText(track.name) === savedName);
          if (pref < 0) pref = preferredAudioTrackIndex(tracks, cfg?.preferAudio);
          if (pref >= 0) {
            try {
              hls.audioTrack = pref;
              setAudioId(pref);
            } catch {}
          }
        });
        hls.on(Hls.Events.ERROR, (_e, data) => {
          if (!data?.fatal) return;
          // Retry ladder before surrendering to the raw stream: a single
          // transient segment failure (a slow piece, a blip) used to drop
          // the whole engine immediately.
          errCountRef.current += 1;
          if (errCountRef.current <= 4) {
            try {
              if (data.type === Hls.ErrorTypes.NETWORK_ERROR) { hls.startLoad(); return; }
              if (data.type === Hls.ErrorTypes.MEDIA_ERROR) { hls.recoverMediaError(); return; }
            } catch {}
          }
          // Fall back to raw stream (works for mp4) — HLS unavailable on this build
          destroyHls();
          tryExternalOnly();
        });
      } else {
        // No hls.js support (unlikely in Electron) — try native HLS, else raw
        v.src = stream.hls;
        v.play().catch(() => tryExternalOnly());
      }
    })();

    return () => { disposed = true; clearTimeout(resumeTargetTimerRef.current); destroyHls(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stream, profileReady]);

  // ── Video element events ────────────────────────────────────────────────────
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    // rAF-coalesced timeupdate: each raw event (4 Hz) used to setState →
    // full re-render of this component while frames decode. One setState per
    // animation frame, skipping no-op values.
    let timeRaf = 0;
    let lastSetT = -1;
    const onTime = () => {
      const t = v.currentTime || 0;
      if (timeRaf) return;
      timeRaf = requestAnimationFrame(() => {
        timeRaf = 0;
        if (Math.abs(t - lastSetT) > 0.05) { lastSetT = t; setCurrent(t); }
      });
    };
    const onDur = () => setDuration(v.duration || 0);
    const onPlay = () => setPlaying(true);
    const onPause = () => {
      setPlaying(false);
      // Persist the exact position on pause so a reopen resumes here.
      try {
        const map = storage.get(STORAGE_KEYS.RESUME_TIME) || {};
        map[progressKey] = Math.max(0, Math.round((resumeTargetRef.current ?? v.currentTime ?? 0) * 10) / 10);
        setCappedMap(STORAGE_KEYS.RESUME_TIME, map);
      } catch {}
      persistCheckpoint(resumeTargetRef.current ?? v.currentTime ?? 0, null, false);
      // Let the session sampler append its final segment before flushing the
      // shared outbox at the end of this pause event dispatch.
      Promise.resolve().then(() => flushViewingProfile({ keepalive: true, priority: true })).catch(() => {});
    };
    const onWaiting = () => setWaiting(true);
    const onPlaying = () => setWaiting(false);
    const onCanPlay = () => setWaiting(false);
    const onSeeked = () => {
      if (resumeTargetRef.current != null && Math.abs(v.currentTime - resumeTargetRef.current) <= 1) {
        resumeTargetRef.current = null;
        clearTimeout(resumeTargetTimerRef.current);
        resumeTargetTimerRef.current = null;
      }
    };
    const tracks = v.textTracks;
    const onTrackChange = () => {
      const selected = Array.from(tracks || []).find((track) => track.mode === "showing");
      if (selected) persistCheckpoint(v.currentTime || checkpointRef.current?.position || 0, { subtitle: {
        enabled: true, kind: "embedded", name: String(selected.label || ""), lang: String(selected.language || ""),
      } });
      else if (checkpointRef.current?.preferences?.subtitle?.enabled) persistCheckpoint(v.currentTime || checkpointRef.current?.position || 0, {
        subtitle: { enabled: false, kind: "embedded", name: "", lang: "" },
      });
    };
    tracks?.addEventListener?.("change", onTrackChange);
    v.addEventListener("timeupdate", onTime);
    v.addEventListener("durationchange", onDur);
    v.addEventListener("play", onPlay);
    v.addEventListener("pause", onPause);
    v.addEventListener("waiting", onWaiting);
    v.addEventListener("playing", onPlaying);
    v.addEventListener("canplay", onCanPlay);
    v.addEventListener("seeked", onSeeked);
    return () => {
      if (timeRaf) { cancelAnimationFrame(timeRaf); timeRaf = 0; }
      v.removeEventListener("timeupdate", onTime);
      v.removeEventListener("durationchange", onDur);
      v.removeEventListener("play", onPlay);
      v.removeEventListener("pause", onPause);
      v.removeEventListener("waiting", onWaiting);
      v.removeEventListener("playing", onPlaying);
      v.removeEventListener("canplay", onCanPlay);
      v.removeEventListener("seeked", onSeeked);
      tracks?.removeEventListener?.("change", onTrackChange);
      if (v.duration && v.currentTime > 0) persistCheckpoint(resumeTargetRef.current ?? v.currentTime, null, false, false);
    };
  }, [stream, progressKey, profileReady, persistCheckpoint]);

  // ── Auto-hide controls during playback (3s of inactivity) ───────────────────
  const showControls = useCallback(() => {
    setControlsVisible(true);
    clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => {
      const v = videoRef.current;
      if (v && !v.paused && !v.ended) setControlsVisible(false);
    }, 3000);
  }, []);
  useEffect(() => {
    if (!stream) return;
    showControls();
    return () => clearTimeout(hideTimerRef.current);
  }, [stream, showControls]);

  // ── Progress reporting + watched threshold ──────────────────────────────────
  useEffect(() => {
    if (!stream) return;
    clearInterval(progressTimerRef.current);
    progressTimerRef.current = setInterval(() => {
      const v = videoRef.current;
      if (!v || !v.duration) return;
      if (resumeTargetRef.current != null) return;
      const pct = Math.min(100, Math.round((v.currentTime / v.duration) * 100));
      // saveProgress(progressKey, pct) — 2-arg signature used by both pages
      saveRef.current?.(progressKey, pct);
      // Persist the exact timecode too, so a reopen resumes at the same
      // second (OnlinePlayer's mechanism; the torrent source had none).
      try {
        const map = storage.get(STORAGE_KEYS.RESUME_TIME) || {};
        map[progressKey] = Math.max(0, Math.round(v.currentTime * 10) / 10);
        setCappedMap(STORAGE_KEYS.RESUME_TIME, map);
      } catch {}
      if (v.currentTime > 0 && !v.paused && !v.waiting && !v.seeking && resumeTargetRef.current == null) persistCheckpoint(v.currentTime);
    }, 5000);
    return () => clearInterval(progressTimerRef.current);
  }, [stream, watchedThreshold, persistCheckpoint]);

  const commitViewingSession = useCallback((completedAt = null) => {
    const session = viewingSessionRef.current;
    if (!session || session.progressKey !== progressKey || !session.segments.length || !viewingItemRef.current?.id) return;
    try {
      Promise.resolve(recordViewingSession({
        sessionId: session.sessionId, progressKey, item: viewingItemRef.current,
        segments: session.segments.map((segment) => ({ ...segment })),
        ...(completedAt || session.completedAt ? { completedAt: completedAt || session.completedAt } : {}),
      }, { flush: Boolean(completedAt || session.completedAt) })).catch(() => {});
    } catch {}
  }, [progressKey]);

  useEffect(() => {
    const sessionId = newPlaybackSessionId();
    viewingSessionRef.current = { sessionId, progressKey, segments: [], lastSample: null, playedMediaSeconds: 0, lastFlushAt: 0, completedAt: null };
    return () => commitViewingSession();
  }, [progressKey, commitViewingSession]);

  useEffect(() => {
    if (!stream || !profileReady || !progressKey) return;
    const video = videoRef.current;
    const sample = () => {
      const session = viewingSessionRef.current;
      if (!video || !session || session.progressKey !== progressKey) return;
      if (video.paused || video.seeking || video.waiting || video.readyState < 2 || resumeTargetRef.current != null) { session.lastSample = null; return; }
      const now = Date.now(), currentTime = Number(video.currentTime);
      if (!Number.isFinite(currentTime)) { session.lastSample = null; return; }
      const previous = session.lastSample;
      session.lastSample = { wall: now, media: currentTime };
      if (!previous) return;
      const wallElapsed = now - previous.wall, mediaElapsed = currentTime - previous.media;
      if (wallElapsed <= 0 || wallElapsed > 2200 || mediaElapsed <= 0.08 || mediaElapsed > wallElapsed / 1000 * 2.2 + 0.15) return;
      const segment = { start: previous.wall, end: now };
      const last = session.segments.at(-1);
      if (last && segment.start <= last.end + 1200) last.end = Math.max(last.end, segment.end);
      else session.segments.push(segment);
      session.playedMediaSeconds = (session.playedMediaSeconds || 0) + mediaElapsed;
      const naturallyReachedOutro = crossedPlaybackPosition(previous.media, currentTime, Number(skipTimingsRef.current?.outro?.startTime), wallElapsed);
      const naturallyReachedWatchedThreshold = crossedWatchedThreshold(previous.media, currentTime, video.duration, watchedThreshold, wallElapsed);
      if (!session.completedAt && (naturallyReachedWatchedThreshold || naturallyReachedOutro)) {
        session.completedAt = now;
        markWatchedRef.current?.(progressKey);
        commitViewingSession(now);
      }
      if (now - session.lastFlushAt >= 12_000) { session.lastFlushAt = now; commitViewingSession(); }
    };
    const timer = setInterval(sample, 1000);
    const reset = () => { if (viewingSessionRef.current) viewingSessionRef.current.lastSample = null; };
    const onPause = () => {
      reset();
      commitViewingSession();
      Promise.resolve(flushViewingProfile({ keepalive: true, priority: true })).catch(() => {});
    };
    const ended = () => {
      reset();
      const session = viewingSessionRef.current;
      if (session && !session.completedAt && session.segments.length && hasGenuinePlaybackForEnd(session.playedMediaSeconds, video?.duration)) {
        session.completedAt = Date.now();
        markWatchedRef.current?.(progressKey);
      }
      commitViewingSession(session?.completedAt || null);
    };
    const captureClosingState = () => {
      const currentVideo = videoRef.current;
      if (currentVideo && currentVideo.duration && currentVideo.currentTime >= 0) {
        const position = resumeTargetRef.current ?? currentVideo.currentTime;
        try {
          const map = storage.get(STORAGE_KEYS.RESUME_TIME) || {};
          map[progressKey] = Math.max(0, Math.round(position * 1000) / 1000);
          setCappedMap(STORAGE_KEYS.RESUME_TIME, map);
        } catch {}
        persistCheckpoint(position, null, false, false);
      }
      reset();
      commitViewingSession();
    };
    const unregisterClosingCapture = registerViewingProfileClosingCapture(captureClosingState);
    video?.addEventListener("seeking", reset);
    video?.addEventListener("waiting", reset);
    video?.addEventListener("pause", onPause);
    video?.addEventListener("ended", ended);
    return () => {
      clearInterval(timer);
      video?.removeEventListener("seeking", reset);
      video?.removeEventListener("waiting", reset);
      video?.removeEventListener("pause", onPause);
      video?.removeEventListener("ended", ended);
      captureClosingState();
      unregisterClosingCapture();
      Promise.resolve(flushViewingProfile()).catch(() => {});
    };
  }, [stream, profileReady, progressKey, watchedThreshold, commitViewingSession, persistCheckpoint]);

  // ── AniList + AniSkip (intro/outro/recap) for anime ─────────────────────────
  // Same source as OnlinePlayer: resolve TMDB → AniList idMal → AniSkip exact
  // timestamps. Only for anime series (AniSkip is episode-based). Best-effort:
  // a RU-dub torrent may shift the OP/ED a few seconds, but the user can dismiss.
  useEffect(() => {
    // Gate on duration: it is a dep (better-aligned OP/ED once the real length
    // is known), so without the guard the fetch ran twice per episode.
    if (introSkipMode === "off" || !isAnimeSeries || !duration) return;
    let cancelled = false;
    (async () => {
      try {
        const t = item?.name || item?.title || "";
        const data = await fetchAnilistData(t, "ANIME", item?.id);
        if (cancelled || !data?.idMal) return;
        const timings = await fetchAniSkipTimings(
          data.idMal,
          Number(episode),
          duration || 0,
        );
        if (cancelled) return;
        setSkipTimings((prev) => mergeTimings(timings, prev) || timings);
      } catch {}
    })();
    return () => { cancelled = true; };
    // duration is a dep so we re-fetch with the real episodeLength once metadata
    // loads — better-aligned OP/ED for dub/encode versions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.id, episode, introSkipMode, isAnimeSeries, duration]);

  // ── Heuristic intro/outro for movies & non-anime series (safe fallback) ──────
  // No public timestamp source for non-anime, so use fallbackTimings: ~30s intro
  // (studio logos) + credits estimate (last ~8% of runtime) for the outro. No
  // audio tap → no risk of muting the stream. The outro drives next-episode.
  useEffect(() => {
    if (heuristicSkipMode === "off" || isAnimeSeries) return;
    let cancelled = false;
    const run = async () => {
      const v = videoRef.current;
      if (!v) return;
      if (!v.duration || !isFinite(v.duration)) {
        if (!cancelled) setTimeout(run, 500);
        return;
      }
      const heuristic = fallbackTimings(v.duration);
      if (cancelled || !heuristic) return;
      setSkipTimings((prev) => mergeTimings(prev, heuristic) || heuristic);
    };
    const t = setTimeout(run, 1200);
    return () => { cancelled = true; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stream, heuristicSkipMode, isAnimeSeries]);

  // ── Skip detection + next-episode-when-ending (1s tick) ─────────────────────
  // Runs when skip is active OR a next-episode callback is wired. Shows the
  // skip button (manual) / auto-jumps (auto) for intro/outro/recap, and fires
  // onNext once when the outro starts (or remaining ≤ threshold as fallback).
  useEffect(() => {
    const skipActive = skipTimings && activeSkipMode !== "off";
    if (!skipActive && !onNext) { setSkipPrompt(null); return; }
    clearInterval(skipTimerRef.current);
    skipTimerRef.current = setInterval(() => {
      const v = videoRef.current; if (!v || !v.duration) return;
      const ct = v.currentTime;

      if (skipActive) {
        const { intro, outro, recap } = skipTimings;
        const inRecap = recap && ct >= recap.startTime && ct < recap.endTime - 1;
        const inIntro = intro && ct >= intro.startTime && ct < intro.endTime - 1;
        const inOutro = outro && ct >= outro.startTime && ct < outro.endTime - 1;
        const seg = inRecap ? "recap" : inIntro ? "intro" : inOutro ? "outro" : null;
        if (!seg) {
          setSkipPrompt(null);
        } else {
          setSkipPrompt(seg);
          if (activeSkipMode === "auto") {
            v.currentTime = Number(skipTimings[seg].endTime);
            setSkipPrompt(null);
          }
        }
      }

      if (onNextRef.current && !nextFiredRef.current) {
        const outro = skipTimings?.outro;
        const remaining = v.duration - ct;
        const outroStarted = !!outro && ct >= outro.startTime;
        const nearEnd = remaining >= 0 && remaining <= watchedThreshold;
        if (outroStarted || nearEnd) {
          nextFiredRef.current = true;
          onNextRef.current();
        }
      }
    }, 1000);
    return () => clearInterval(skipTimerRef.current);
  }, [skipTimings, activeSkipMode, onNext, watchedThreshold]);

  // ── Auto-pick the new episode's file when the episode/season prop changes ──
  // Without this, changing the episode in TVPage (via autoplay-next or by
  // clicking an episode) would change the `episode` prop but TorrPlayer would
  // keep playing the old file — so "next episode" never actually switched. This
  // switches to the guessed file for the new episode. Reads latest state from
  // refs so it only fires on episode/season change, never on a manual file pick
  // (which would otherwise override the user's choice).
  useEffect(() => {
    if (!isTv || episode == null) return;
    const hash = activeHashRef.current;
    const fl = filesRef.current;
    if (!hash || !fl.length) return;
    const idx = guessEpisodeFileIndex(fl, { season, episode });
    if (idx == null || idx === fileIndexRef.current) return; // already on it
    pickFileManuallyRef.current?.(idx);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [episode, season]);

  // ── Reset skip/next-episode state when the episode changes ──────────────────
  // The stream-attach effect handles this when the file changes, but for
  // single-file torrents (no stream change on episode change) we still need a
  // fresh per-episode state — otherwise nextFiredRef stays true from the prior
  // episode (blocking the next trigger) and stale skipTimings are used.
  useEffect(() => {
    nextFiredRef.current = false;
    setSkipTimings(null);
    setSkipPrompt(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [episode, season]);

  // ── Controls ────────────────────────────────────────────────────────────────
  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) v.play().catch(() => {});
    else v.pause();
  };
  const seekTo = (position) => {
    const v = videoRef.current;
    if (!v || !Number.isFinite(v.duration) || v.duration <= 0 || !Number.isFinite(position)) return;
    const target = Math.max(0, Math.min(v.duration, position));
    resumeTargetRef.current = target;
    clearTimeout(resumeTargetTimerRef.current);
    resumeTargetTimerRef.current = setTimeout(() => {
      if (resumeTargetRef.current === target) resumeTargetRef.current = null;
      resumeTargetTimerRef.current = null;
    }, 5000);
    v.currentTime = target;
  };
  const seekBy = (delta) => {
    const v = videoRef.current;
    if (!v || !v.duration) return;
    seekTo(v.currentTime + delta);
  };
  const seek = (e) => {
    const v = videoRef.current;
    if (!v || !v.duration) return;
    const r = e.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    seekTo(ratio * v.duration);
  };
  const toggleMute = () => {
    const v = videoRef.current;
    if (!v) return;
    v.muted = !v.muted;
    setMuted(v.muted);
  };
  const changeVol = (e) => {
    const v = videoRef.current;
    if (!v) return;
    const vol = Math.min(1, Math.max(0, Number(e.target.value)));
    v.volume = vol;
    v.muted = vol === 0;
    setVolume(vol);
    setMuted(vol === 0);
  };
  const toggleFullscreen = () => {
    if (!fullscreen) containerRef.current?.requestFullscreen?.();
    else document.exitFullscreen?.();
  };
  useEffect(() => {
    const onFs = () => setFullscreen(!!document.fullscreenElement);
    document.addEventListener("fullscreenchange", onFs);
    return () => document.removeEventListener("fullscreenchange", onFs);
  }, []);
  const selectAudio = (id) => {
    const hls = hlsRef.current;
    if (!hls) return;
    try {
      hls.audioTrack = id;
      setAudioId(id);
    } catch {}
    setShowTracks(false);
    const track = audioTracks.find((value) => value.id === id);
    if (track) persistCheckpoint(videoRef.current?.currentTime || checkpointRef.current?.position || 0, { audio: {
      name: String(track.name || ""), lang: String(track.lang || ""),
    } });
  };
  const doSkip = () => {
    if (!skipPrompt || !skipTimings?.[skipPrompt]) return;
    const v = videoRef.current;
    if (!v) return;
    seekTo(Number(skipTimings[skipPrompt].endTime));
    setSkipPrompt(null);
  };
  const openExternal = () => {
    const url = stream?.raw || stream?.hls;
    if (!url) return;
    torrExternal(url, Math.floor(videoRef.current?.currentTime || 0));
  };
  const pickFileManually = async (idx) => {
    setFileIndex(idx);
    setBusy("stream");
    const fileName = bestFileName(files, idx);
    let s;
    try { s = await torrStream({ hash: activeHash, index: idx, fileName }); }
    catch (err) { setBusy(""); setError(err?.message || "Не удалось получить поток"); return; }
    setBusy("");
    if (s?.ok) setStream({ raw: s.raw, hls: s.hls });
    else setError(s?.error || "Не удалось получить поток");
  };
  pickFileManuallyRef.current = pickFileManually;

  // ── pick an existing DB torrent ────────────────────────────────────────────
  const playDb = async (t) => {
    const hash = (t.hash || t.Hash || "").toLowerCase();
    if (!hash) return;
    setBusy("get");
    let got;
    try { got = await torrGet(hash); }
    catch (err) { setBusy(""); setError(err?.message || "Не удалось получить торрент"); return; }
    setBusy("");
    const torrent = got?.ok ? got.torrent : t;
    setActiveHash(hash);
    const fl = normalizeFiles(torrent);
    setFiles(fl);
    pickFileAndPlay(hash, fl);
  };

  const removeDb = async (t) => {
    const hash = (t.hash || t.Hash || "").toLowerCase();
    if (!hash) return;
    try { await torrRem(hash); } catch {}
    let list;
    try { list = await torrList(); } catch {}
    if (list?.ok) setDbTorrents(list.list || []);
  };

  const onPickTorrentFile = async () => {
    let picked;
    try { picked = await pickTorrentFile(); }
    catch (err) { setError(err?.message || "Не удалось выбрать файл"); return; }
    if (!picked?.ok) return;
    setBusy("add");
    let res;
    try { res = await torrAddFile(picked.path, queryTitle || activeHash || ""); }
    catch (err) { setBusy(""); setError(err?.message || "Не удалось добавить .torrent"); return; }
    setBusy("");
    if (!res?.ok) {
      setError(res?.error || "Не удалось добавить .torrent");
      return;
    }
    const t = res.torrent || {};
    const hash = (t.hash || t.Hash || "").toLowerCase();
    setActiveHash(hash);
    const fl = normalizeFiles(t);
    setFiles(fl);
    pickFileAndPlay(hash, fl);
  };

  const [magnetInput, setMagnetInput] = useState("");

  // ────────────────────────────────────────────────────────────────────────────
  // RENDER
  // ────────────────────────────────────────────────────────────────────────────
  if (stream) {
    return (
      <div
        className={"torrplayer" + (controlsVisible ? "" : " torrplayer--hidden-cursor")}
        ref={containerRef}
        onMouseMove={showControls}
        onMouseLeave={() => { if (videoRef.current && !videoRef.current.paused) setControlsVisible(false); }}
      >
        <video
          ref={videoRef}
          className="torrplayer-video"
          playsInline
          crossOrigin="anonymous"
          poster=""
          onClick={togglePlay}
          onDoubleClick={toggleFullscreen}
        />
        {waiting && <div className="torrplayer-spinner" />}
        {!playing && !waiting && (
          <button className="torrplayer-bigplay" onClick={togglePlay} title="Смотреть">
            {playing ? <PauseI /> : <PlayI />}
          </button>
        )}
        {/* Skip intro / outro / recap button (manual mode) */}
        {skipPrompt && (
          <button className="torrplayer-skip" onClick={doSkip}>
            <span className="torrplayer-skip-title">ПРОПУСТИТЬ</span>
            <span className="torrplayer-skip-sub">
              {skipPrompt === "intro"
                ? "ИНТРО"
                : skipPrompt === "outro"
                  ? "ЭНДИНГ"
                  : "РЕКАП"}
            </span>
          </button>
        )}
        {/* File selector for multi-file torrents */}
        {files.length > 1 && (
          <div className="torrplayer-filebar">
            <span className="torrplayer-filebar-label">Файл:</span>
            <select
              value={fileIndex ?? ""}
              onChange={(e) => pickFileManually(Number(e.target.value))}
            >
              {files.map((f) => (
                <option key={f.index} value={f.index}>
                  {f.name}
                  {f.size ? ` (${formatBytes(f.size)})` : ""}
                </option>
              ))}
            </select>
            <button
              className="player-overlay-btn"
              onClick={() => {
                setStream(null);
                destroyHls();
                setActiveHash(null);
              }}
              title="Выбрать другой торрент"
            >
              <SourceIcon /> Другой
            </button>
          </div>
        )}
        {/* Controls */}
        <div className={"torrplayer-controls" + (controlsVisible ? "" : " torrplayer-controls--hidden")}>
          <button className="torrplayer-btn torrplayer-btn--seekback" onClick={() => seekBy(-10)} title="Назад 10с"><Back10I /></button>
          <button className="torrplayer-btn torrplayer-btn--play" onClick={togglePlay} title={playing ? "Пауза" : "Смотреть"}>
            {playing ? <PauseI /> : <PlayI />}
          </button>
          <button className="torrplayer-btn torrplayer-btn--seekfwd" onClick={() => seekBy(10)} title="Вперёд 10с"><Fwd10I /></button>
          <button className="torrplayer-btn torrplayer-btn--mute" onClick={toggleMute} title={muted ? "Включить звук" : "Выключить звук"}>
            {muted ? <MuteI /> : <VolumeI />}
          </button>
          <input
            className="torrplayer-volume"
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={muted ? 0 : volume}
            onChange={changeVol}
            title="Громкость"
          />
          <span className="torrplayer-time">
            {fmt(current)} / {fmt(duration)}
          </span>
          <div className="torrplayer-seek" onClick={seek}>
            <div
              className="torrplayer-seek-fill"
              style={{ width: `${duration ? (current / duration) * 100 : 0}%` }}
            />
          </div>
          {audioTracks.length > 1 && (
            <div className="torrplayer-audio">
              <button
                className="torrplayer-btn torrplayer-btn--audio"
                onClick={() => setShowTracks((v) => !v)}
                title="Аудиодорожка"
              >
                <AudioI />
                <span className="torrplayer-audio-label">
                  {audioTracks[audioId]?.name || `Аудио ${(audioId ?? -1) + 1}`}
                </span>
              </button>
              {showTracks && (
                <div className="torrplayer-audio-menu">
                  {audioTracks.map((t) => (
                    <button
                      key={t.id}
                      className={"torrplayer-audio-item" + (t.id === audioId ? " active" : "")}
                      onClick={() => selectAudio(t.id)}
                    >
                      {t.name}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          <button className="torrplayer-btn torrplayer-btn--external" onClick={openExternal} title="Открыть в mpv/VLC">
            <ExternalLinkIcon size={18} />
          </button>
          <button className="torrplayer-btn torrplayer-btn--fs" onClick={toggleFullscreen} title="Полный экран">
            <FullscreenI />
          </button>
        </div>
        {busy && <div className="torrplayer-busy">{busy === "stream" ? "Подключение к TorrServer…" : busy}</div>}
      </div>
    );
  }

  // ── Picker UI (no stream yet) ───────────────────────────────────────────────
  return (
    <div className="torrpicker">
      <div className="torrpicker-head">
        <div className="torrpicker-title">Торренты (TorrServer) — русская озвучка</div>
        <div className="torrpicker-status">
          {busy && <span className="torrpicker-busy">{busyLabel(busy)}…</span>}
          {error && <span className="torrpicker-error">{error}</span>}
        </div>
      </div>

      <div className="torrpicker-tabs">
        <button className={tab === "search" ? "active" : ""} onClick={() => setTab("search")}>
          <SearchI /> Поиск
        </button>
        <button className={tab === "db" ? "active" : ""} onClick={() => setTab("db")}>
          <SourceIcon /> Мои торренты ({dbTorrents.length})
        </button>
        <button className={tab === "add" ? "active" : ""} onClick={() => setTab("add")}>
          <PlusI /> Добавить
        </button>
      </div>

      {tab === "search" && (
        <div className="torrpicker-search">
          <div className="torrpicker-searchbar">
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={queryTitle || "Название + год"}
              onKeyDown={(e) => e.key === "Enter" && runSearch(searchQuery)}
            />
            <button className="torrpicker-go" onClick={() => runSearch(searchQuery)}>
              Найти
            </button>
          </div>
          {!cfg?.jackettUrl && (
            <div className="torrpicker-hint">
              Поиск через Jackett не настроен. Укажите адрес Jackett + API-ключ в
              Настройках → TorrServer, либо откройте вкладку «Добавить» и вставьте magnet.
            </div>
          )}
          <div className="torrpicker-list">
            {results.map((r, i) => (
              <div className="torrpicker-item" key={i}>
                <div className="torrpicker-item-main">
                  <div className="torrpicker-item-title">{r.title}</div>
                  <div className="torrpicker-item-meta">
                    {r.tracker && <span>{r.tracker}</span>}
                    {r.size > 0 && <span>{formatBytes(r.size)}</span>}
                    {r.seeders != null && <span>↑{r.seeders}</span>}
                    {r.categoryDesc && <span>{r.categoryDesc}</span>}
                  </div>
                </div>
                <button
                  className="torrpicker-item-go"
                  disabled={!!busy}
                  onClick={() => handleAdd(r.magnet || r.link, queryTitle)}
                >
                  Смотреть
                </button>
              </div>
            ))}
            {!busy && !results.length && !error && (
              <div className="torrpicker-empty">Введите название и нажмите «Найти».</div>
            )}
          </div>
        </div>
      )}

      {tab === "db" && (
        <div className="torrpicker-list">
          {!dbTorrents.length && (
            <div className="torrpicker-empty">
              В TorrServer нет торрентов. Найдите через Поиск или добавьте magnet.
            </div>
          )}
          {dbTorrents.map((t, i) => (
            <div className="torrpicker-item" key={i}>
              <div className="torrpicker-item-main">
                <div className="torrpicker-item-title">{t.title || t.name || "Торрент"}</div>
                <div className="torrpicker-item-meta">
                  <span>{(t.hash || t.Hash || "").slice(0, 12)}…</span>
                  {t.size > 0 && <span>{formatBytes(t.size)}</span>}
                </div>
              </div>
              <button className="torrpicker-item-go" disabled={!!busy} onClick={() => playDb(t)}>
                Смотреть
              </button>
              <button className="torrpicker-item-del" disabled={!!busy} onClick={() => removeDb(t)}>
                ✕
              </button>
            </div>
          ))}
        </div>
      )}

      {tab === "add" && (
        <div className="torrpicker-add">
          <label className="torrpicker-label">Magnet-ссылка или хеш</label>
          <textarea
            className="torrpicker-textarea"
            rows={3}
            value={magnetInput}
            onChange={(e) => setMagnetInput(e.target.value)}
            placeholder="magnet:?xt=urn:btih:…  или  40-значный хеш"
          />
          <button
            className="torrpicker-go"
            disabled={!magnetInput.trim() || !!busy}
            onClick={() => handleAdd(magnetInput.trim(), queryTitle)}
          >
            Добавить и смотреть
          </button>
          <div className="torrpicker-or">— или —</div>
          <button className="torrpicker-go" disabled={!!busy} onClick={onPickTorrentFile}>
            Выбрать .torrent файл
          </button>
        </div>
      )}
    </div>
  );
}

function busyLabel(b) {
  return { search: "Поиск", add: "Добавление", get: "Получение", stream: "Подключение" }[b] || "Работа";
}
