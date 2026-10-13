// ── OnlinePlayer: in-app player for the "Онлайн" (Collaps) source ───────────
// Lampa's online viewing, extracted. Resolves a TMDB movie/episode to a
// Collaps stream and plays it.
//
// Engine priority: DASH (dash.js) → HLS (hls.js) → error.
//   • DASH carries up to 4K + multi-audio (RU dubs) on Collaps; HLS is capped
//     at ~720p. So we prefer DASH when available.
//   • dash.js is loaded from a local vendor bundle (public/vendor/dash.all.min.js)
//     because the npm registry in this env ships a broken dash.js package.
//
// Features (both engines):
//   • Multi-audio with Russian dub default
//   • Quality selector (DASH representations / HLS levels: Auto + 4K/1080p/…)
//   • Playback speed (0.5×–2×)
//   • Subtitles (Collaps `cc` VTT tracks)
//   • Intro/outro skip for anime (AniSkip via AniList idMal) — auto + manual
//   • ±10s seek + full keyboard shortcuts
//   • Resume from last position, click-to-play, auto-hide controls, buffer bar

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
// hls.js (~150KB) is loaded lazily ONLY when an HLS stream actually attaches,
// so it stays out of the initial movie-page bundle. dash.js is likewise lazy
// (desktop-only vendor bundle). Both keep the movie chunk small for fast nav.
let _HlsPromise = null;
function loadHls() {
  if (!_HlsPromise) {
    _HlsPromise = import("hls.js").then((m) => m.default).catch((error) => {
      _HlsPromise = null;
      throw error;
    });
  }
  return _HlsPromise;
}
// dash.js is loaded lazily (only on desktop) to avoid shipping its 779KB
// bundle to mobile, where HLS (ABR) is preferred for faster startup.
import {
  tmdbFetch,
  fetchAnilistData,
  isAnimeContent,
  imgUrl,
} from "../utils/api";
import { fetchAniSkipTimings, resolveAnimeEpisode } from "../utils/aniSkip";
import { fetchIntroDbTimings, mergeTimings, providerSkipRanges } from "../utils/introDetect";
import { applySync as applyWatchSync } from "../utils/watchParty";
import { storage, STORAGE_KEYS, getStoredVolume, getStoredMuted, setStoredVolume, setStoredMuted, setCappedMap } from "../utils/storage";
import {
  collapsResolve,
  collapsFindKp,
  labelAudioTracks,
  preferredRuTrackIndex,
} from "../utils/collaps-client";
import useSourceHost, { SWITCH_WATCHDOG_MS } from "../utils/useSourceHost";
import { PiPIcon } from "./Icons";

const fmt = (s) => {
  if (s == null || !isFinite(s)) return "0:00";
  s = Math.max(0, s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = Math.floor(s % 60);
  const pad = (n) => (n < 10 ? "0" : "") + n;
  return h > 0 ? `${h}:${pad(m)}:${pad(ss)}` : `${m}:${pad(ss)}`;
};

function skipEndFor(segment, timings) {
  const range = typeof segment === "object" ? segment : timings?.[segment];
  if (!range) return null;
  const post = timings?.postCredits;
  if ((segment === "outro" || typeof segment === "object") && post && post.startTime < range.endTime && post.endTime > range.startTime) {
    if (post.startTime <= range.startTime) return null;
    return Math.min(range.endTime, post.startTime);
  }
  return range.endTime;
}

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
// Fleet stall watchdog window. A freshly-attached fleet stream that hasn't reached
// genuine playback (currentTime advancing) within this long — AND has barely
// buffered — is a throughput stall (segments trickling through the relay), not a
// slow-but-working start. Observed legitimate cold starts are 2.3–3.1 s; the stall
// disaster was ~63 s. ~2× the slowest legit start gives margin while killing the
// stall fast. Only acts before first real playback (see the watchdog effect).
const FLEET_STALL_MS = 7000;
const MIN_DISPLAY_MS = 250;
const DISPLAY_ERROR_AFTER_MS = 4000;

// ── Load dash.js once from the local vendor bundle ───────────────────────────
let _dashLoader = null;
function loadDashJs() {
  if (window.dashjs) return Promise.resolve(window.dashjs);
  if (_dashLoader) return _dashLoader;
  _dashLoader = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    // Absolute URL: a relative "./vendor/…" resolves against the DOCUMENT
    // url, so on a deep-linked /movie/<id> load (vercel.json serves
    // index.html there) the script 404s, DASH silently dies and playback
    // falls back to the ~720p HLS ladder with no error shown.
    s.src = `${import.meta.env.BASE_URL}vendor/dash.all.min.js?v=2`;
    // Clear the watchdog once the script settles either way — the old
    // version left an 8 s timer pending after every successful load and
    // could reject a loader that had already resolved.
    const done = (fn) => (arg) => { clearTimeout(watchdog); fn(arg); };
    s.onload = () => done(resolve)(window.dashjs);
    s.onerror = () => done(reject)(new Error("dash.js failed to load"));
    const watchdog = setTimeout(() => {
      if (!window.dashjs) reject(new Error("dash.js load timeout"));
    }, 8000);
    document.head.appendChild(s);
  }).catch((error) => {
    _dashLoader = null;
    throw error;
  });
  return _dashLoader;
}

// ── Icons ────────────────────────────────────────────────────────────────────
const PauseI = () => (<svg viewBox="0 0 24 24" fill="currentColor" width="22" height="22"><rect x="6" y="4" width="4" height="16" /><rect x="14" y="4" width="4" height="16" /></svg>);
const PlayI = () => (<svg viewBox="0 0 24 24" fill="currentColor" width="22" height="22"><polygon points="5 3 19 12 5 21 5 3" /></svg>);
const FullscreenI = () => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20"><path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M3 16v3a2 2 0 0 0 2 2h3" /></svg>);
const VolumeI = () => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor" stroke="none" /><path d="M15.5 8.5a5 5 0 0 1 0 7M19 5a9 9 0 0 1 0 14" /></svg>);
const MuteI = () => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" fill="currentColor" stroke="none" /><line x1="23" y1="9" x2="17" y2="15" /><line x1="17" y1="9" x2="23" y2="15" /></svg>);
const AudioI = () => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20"><path d="M3 18v-6a9 9 0 0 1 18 0v6" /><path d="M21 19a2 2 0 0 1-2 2h-1a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2h3zM3 19a2 2 0 0 0 2 2h1a2 2 0 0 0 2-2v-3a2 2 0 0 0-2-2H3z" /></svg>);
const SubI = () => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20"><rect x="2" y="4" width="20" height="16" rx="2" /><path d="M7 15h4M15 15h2M7 11h2M13 11h4" /></svg>);
const GearI = () => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>);
const Back10I = () => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20"><path d="M12 5V2L7 6l5 4V7a6 6 0 1 1-6 6" /><text x="12" y="17" fontSize="7" fill="currentColor" stroke="none" textAnchor="middle" fontWeight="700">10</text></svg>);
const Fwd10I = () => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20"><path d="M12 5V2l5 4-5 4V7a6 6 0 1 0 6 6" /><text x="12" y="17" fontSize="7" fill="currentColor" stroke="none" textAnchor="middle" fontWeight="700">10</text></svg>);
// Fleet-only glyphs (Lampac): balancer = stacked servers, voice/dub = globe+dot.
const BalancerI = () => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20"><rect x="3" y="4" width="18" height="6" rx="1.5" /><rect x="3" y="14" width="18" height="6" rx="1.5" /><line x1="7" y1="7" x2="7.01" y2="7" /><line x1="7" y1="17" x2="7.01" y2="17" /></svg>);
const VoiceI = () => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20"><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" /></svg>);

export default function OnlinePlayer({
  apiKey, item, details, type = "movie", season = null, episode = null,
  progressKey, saveProgress, onMarkWatched, watchedThreshold = 20,
  // Which source drives this player: "online" (Collaps) or "lampac" (the
  // balancer fleet). The two share all playback UI; only stream resolution
  // differs — Collaps via collapsResolve here, Lampac via useLampacSource.
  provider = "online",
  // ── Source-failed hook (optional): fires when a non-Lampac provider cannot
  // resolve a stream for this title (Collaps 410, host not allowed, etc.).
  // The parent (MoviePage/TVPage) uses it to auto-switch playerSource to
  // "lampac" and remount with the multi-balancer picker, so a viewer never
  // sits on a hard error screen when another source has the film. Lampac
  // itself has 16 balancers and surfaces its own dead-balancer notice inline
  // via useLampacSource — this hook does NOT fire when provider === "lampac".
  onSourceFailed = null,
  // ── Next episode (TV only): called once when the ending/outro starts (or when
  // only `watchedThreshold` seconds remain, as a fallback when no outro timing
  // is known). The parent (TVPage) turns this into the autoplay-next countdown.
  onNext = null,
  // ── Watch Together (optional; no-op when absent — normal MoviePage/TVPage) ──
  syncRole = null, // "host" | "follower" | null
  syncState = null, // follower: { playing, position, updatedAt } from the room
  onPlaybackState = null, // host: cb({ playing, position }) on local control changes
}) {
  const videoRef = useRef(null);
  const hlsRef = useRef(null);
  const dashRef = useRef(null);
  const engineRef = useRef(null); // "dash" | "hls"
  const containerRef = useRef(null);
  const progressTimerRef = useRef(null);
  const skipTimerRef = useRef(null);
  // Resume-seek guard: while set, the progress interval must NOT save (the seek
  // is still settling and currentTime can momentarily read 0, which would
  // overwrite the real saved position). Cleared on `seeked` (or after 5s safety).
  const resumeTargetRef = useRef(null);
  const seekTargetTimerRef = useRef(null);
  const sourceSelectionRef = useRef(0);
  const sourceSeekTimerRef = useRef(null);
  const hideTimerRef = useRef(null);
  const subsAddedRef = useRef(false);
  const errCountRef = useRef(0);
  const resumeDoneRef = useRef(false); // seek to saved timecode once per stream
  // True once ANY stream has actually attached. Used by the Lampac path to decide
  // whether a resolve error should blank the player (nothing ever played) or just
  // show an inline notice (a switch failed but the current media is fine).
  const hadPlayedRef = useRef(false);
  // Genuine-playback signal for the fleet: `play`/`playing` fire the instant
  // hls.js calls v.play() on MANIFEST_PARSED — before a single segment has
  // decoded — so hadPlayedRef flips true even on a stream that immediately dies
  // with bufferAppendError, which would defeat failover. This flips true ONLY
  // when currentTime actually advances (frames rendered). Reset per episode, not
  // per stream, so a post-playback quality/dub switch stays protected. Mirrors the
  // hook's confirmedRef (set via notePlaying).
  const fleetPlayedRef = useRef(false);
  const lastFleetTimeRef = useRef(null);
  const hoverRafRef = useRef(null); // rAF throttle for seek-hover tooltip
  const loadingEnteredAtRef = useRef(0); // when the loading overlay was raised
  const loadingWatchdogRef = useRef(null); // 4s timer → swap spinner for inline error
  const loadingExitRef = useRef(null); // pending MIN_DISPLAY_MS exit transition
  const saveRef = useRef(saveProgress); saveRef.current = saveProgress;
  const markWatchedRef = useRef(onMarkWatched); markWatchedRef.current = onMarkWatched;

  const [state, setState] = useState("loading");
  const [error, setError] = useState("");
  const [stream, setStream] = useState(null); // {dash?, hls?}
  const [audioNames, setAudioNames] = useState([]);
  const [subtitles, setSubtitles] = useState([]);
  const [meta, setMeta] = useState("");

  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(() => getStoredMuted());
  const [volume, setVolume] = useState(() => getStoredVolume());
  // Ref mirror of volume/muted (same pattern as saveRef/markWatchedRef above) so
  // the engine-attach effect (and its event handlers, registered once per
  // stream) can always read the LATEST user-set volume/mute without needing
  // them in its dependency array (which would tear down and re-create the
  // dash.js/hls.js engine on every volume tick).
  const volumeRef = useRef(1); volumeRef.current = volume;
  const mutedRef = useRef(false); mutedRef.current = muted;
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);
  const [waiting, setWaiting] = useState(false);

  const [audioTracks, setAudioTracks] = useState([]);
  const [audioId, setAudioId] = useState(-1);
  const [showTracks, setShowTracks] = useState(false);

  // Quality (engine-agnostic list of {id,label,height})
  const [levels, setLevels] = useState([]);
  const [currentLevel, setCurrentLevel] = useState(-1);
  const [showQuality, setShowQuality] = useState(false);

  const [rate, setRate] = useState(1);
  const [showSpeed, setShowSpeed] = useState(false);

  const [subId, setSubId] = useState(-1);
  const [showSubs, setShowSubs] = useState(false);

  // ── Cast-on-pause (Kinopoisk-style): real name + character + photo ──────────
  const [cast, setCast] = useState([]); // [{ id, name, character, profile }]

  const [skipTimings, setSkipTimings] = useState(null);
  const [skipPrompt, setSkipPrompt] = useState(null);
  const [introSkipMode] = useState(() => storage.get(STORAGE_KEYS.INTRO_SKIP_MODE) || "manual");
  // Confirmed IntroDB timings for movies/series; users can choose manual or auto.
  const [generalSkipMode] = useState(
    () => storage.get(STORAGE_KEYS.SKIP_HEURISTIC_MODE) || "manual",
  );
  const [resolvedImdbId, setResolvedImdbId] = useState(
    () => item?.imdb_id || details?.imdb_id || details?.external_ids?.imdb_id || null,
  );
  // Next-episode callback stays live; reset its one-shot guard per episode.
  const onNextRef = useRef(onNext);
  onNextRef.current = onNext;
  const nextFiredRef = useRef(false);

  const [controlsVisible, setControlsVisible] = useState(true);
  const [hoverTime, setHoverTime] = useState(null);

  // Fullscreen mirror (ref) so the mobile landscape auto-fullscreen effect can
  // read the current fullscreen state inside async/orientation handlers without
  // going stale (same ref-mirror pattern used for saveRef/markWatchedRef above).
  const fullscreenRef = useRef(false); fullscreenRef.current = fullscreen;
  // Picture-in-Picture (mobile only).
  const [pipActive, setPipActive] = useState(false);
  // True ONLY while the current fullscreen was auto-triggered by us (landscape
  // rotation). Prevents fighting the user's manual toggle.
  const _autoFsRef = useRef(false);
  // Mobile detection — render-gates the PiP button and gates the landscape
  // auto-fullscreen effect. Same pattern as the engine-selection effect above.
  const isMobile = typeof window !== "undefined" && (
    window.matchMedia?.("(max-width: 768px)")?.matches ||
    /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || "")
  );

  // ── Lampac fleet source (provider === "lampac") ─────────────────────────────
  // The Collaps path resolves a single {dash,hls} up front and lets the engine
  // own audio/quality. The Lampac fleet is different: balancers, dubs (озвучки)
  // and qualities are DISTINCT files — switching any of them re-resolves and
  // re-attaches. `useLampacSource` owns that whole descent; this component only
  // reflects its {hls|mp4} into the same engine + shows the extra pickers.
  // Always called (React hook rules); it no-ops internally when !enabled.
  const isLampac = provider === "lampac";
  const lampac = useSourceHost({
    enabled: isLampac, apiKey, item, details, type, season, episode,
  });
  // Fleet pickers (empty for Collaps → their menus don't render).
  const balansers = isLampac ? lampac.balansers : [];
  const voices = isLampac ? lampac.voices : [];
  const srcQualities = isLampac ? lampac.qualities : [];
  const [showBalanser, setShowBalanser] = useState(false);
  const [showVoice, setShowVoice] = useState(false);
  // Inline notice that never blanks the player (dead balancer, stale link): the
  // picker stays up so the viewer can switch. Distinct from `error` (fatal).
  const [notice, setNotice] = useState(null);
  // True while the fleet re-resolves after a balancer/voice/quality switch. The
  // <video> stays mounted; cleared on `seeked` (or `playing`) via clearSwitching.
  const switching = isLampac ? lampac.switching : false;

  // Ref mirrors of the fleet's failover hooks so the engine error handlers
  // (registered once per stream, closed over stale props) always reach the live
  // callbacks. A byte-probe can't prove a stream decodes — only the <video>/engine
  // can — so a fatal error before first playback asks the hook to try the next
  // balancer, and the first real `playing` locks the current one in.
  const reportFleetFailureRef = useRef(null);
  reportFleetFailureRef.current = isLampac ? lampac.reportPlaybackFailure : null;
  const noteFleetPlayingRef = useRef(null);
  noteFleetPlayingRef.current = isLampac ? lampac.notePlaying : null;
  // Persist the exact clock when an exhausted HLS network retry hands playback
  // to the next source. Keeping this before fleetFailover also makes the callback
  // dependency explicit instead of reaching through a stale closure.
  const saveResumeTime = useCallback((t) => {
    try {
      const map = storage.get(STORAGE_KEYS.RESUME_TIME) || {};
      map[progressKey] = Math.max(0, Math.round(t * 10) / 10); // 0.1s precision
      setCappedMap(STORAGE_KEYS.RESUME_TIME, map);
    } catch {}
  }, [progressKey]);
  // Advance to the next fleet balancer when a stream that resolved fine won't
  // actually play. Returns true if it jumped (→ keep the player in loading), false
  // when the fleet is exhausted (→ let the caller settle into the error screen).
  const fleetFailover = useCallback((preservePosition = false, position) => {
    const fn = reportFleetFailureRef.current;
    if (!fn) return false;
    const video = videoRef.current;
    const previousTarget = resumeTargetRef.current;
    const currentPosition = position ?? video?.currentTime;
    const target = preservePosition && Number.isFinite(currentPosition) && currentPosition > 0
      ? currentPosition : null;
    if (target != null) {
      saveResumeTime(target);
      resumeTargetRef.current = target;
    }
    if (fn()) {
      // A new descent is in flight: blank the dead stream and show loading rather
      // than the terminal error screen. For a late network failure the saved
      // target is applied by the next stream's normal resume path.
      setStream(null);
      setError("");
      setState("loading");
      return true;
    }
    if (target != null) resumeTargetRef.current = previousTarget;
    return false;
  }, [saveResumeTime]);

  // Mirror `levels` into a ref so the DASH/HLS quality-change listeners (closures
  // captured once at attach time) map the engine's level index to our UI index
  // against the CURRENT list, not the empty array they closed over.
  const levelsRef = useRef([]);
  levelsRef.current = levels;
  // Same for the playback rate: the engine resets playbackRate to 1 on each
  // media load, so we re-apply the user's chosen rate once metadata is ready.
  const rateRef = useRef(1);
  rateRef.current = rate;

  const destroyAll = useCallback(() => {
    // destroy(), not reset(): reset() only tears down the MediaSource — the
    // MediaPlayer itself (event-bus listeners, BufferController/ScheduleController
    // timers, the refcount into the dash.js core) survives. Every stream change
    // (each TV episode, every balancer/dub/quality switch) used to leak one live
    // player whose timers kept firing against a dead MediaSource on the same
    // thread as video decoding — the "jankier the longer I watch" report.
    if (dashRef.current) {
      try { dashRef.current.destroy(); }
      catch { try { dashRef.current.reset(); } catch {} }
      dashRef.current = null;
    }
    if (hlsRef.current) { try { hlsRef.current.destroy(); } catch {} hlsRef.current = null; }
    // Native path (mp4 / Safari HLS): no engine object, so tear down the element
    // directly — clear the src and force a load() so the old media stops loading
    // and the next stream attaches cleanly (a lingering src would keep buffering
    // the previous file and can wedge the new attach).
    if (engineRef.current === "native") {
      const v = videoRef.current;
      if (v) { try { v.removeAttribute("src"); v.load(); } catch {} }
    }
    engineRef.current = null;
  }, []);

  // ── Precise resume timecodes (seconds) ───────────────────────────────────────
  // progress (percentage) drives the UI bar + "watched" threshold + sync; this
  // parallel map stores the EXACT second the viewer reached, so a reload resumes
  // to the right moment instead of a rounded percentage (off by up to ~1% of the
  // duration). Falls back to the percentage if no timecode is stored yet (e.g.
  // data saved by an older build), so existing users keep working.
  const resumeAt = useCallback((v) => {
    if (resumeDoneRef.current) return;
    const dur = v.duration;
    if (!dur || !isFinite(dur)) return; // not ready yet (HLS can fire early)
    try {
      const tMap = storage.get(STORAGE_KEYS.RESUME_TIME) || {};
      const pMap = storage.get(STORAGE_KEYS.WATCH_PROGRESS) || {};
      let t = resumeTargetRef.current ?? tMap[progressKey];
      if (typeof t !== "number") {
        const pct = pMap[progressKey];
        t = typeof pct === "number" ? (pct / 100) * dur : null; // legacy fallback
      }
      if (typeof t !== "number" || t < 5 || (resumeTargetRef.current == null && t > dur - 10)) return;
      t = Math.min(t, dur - 0.1);
      // Mark a resume-seek in flight so the progress interval doesn't overwrite
      // the saved position with a stale 0 while the seek settles. Cleared on
      // `seeked` (see the video-events effect) or after 5s as a safety net.
      resumeTargetRef.current = t;
      setTimeout(() => { if (resumeTargetRef.current === t) resumeTargetRef.current = null; }, 5000);
      v.currentTime = t;
      resumeDoneRef.current = true;
    } catch {}
  }, [progressKey]);

  // ── Prefetch the HLS engine chunk on mount ──────────────────────────────────
  // loadHls() used to be called only after the stream URL was already in hand,
  // so the ~150 KB hls.js chunk's fetch+eval sat directly on the
  // time-to-first-frame path (mobile always uses HLS; desktop uses it as the
  // DASH fallback). Kicking the dynamic import at mount overlaps it with
  // stream resolution. The promise is module-cached — later callers await the
  // same one.
  useEffect(() => { loadHls().catch(() => {}); }, []);

  // ── Resolve the Collaps stream (provider === "online") ──────────────────────
  useEffect(() => {
    if (isLampac) return; // the Lampac fleet resolves via useLampacSource below
    let cancelled = false;
    const controller = new AbortController();
    (async () => {
      setState("loading"); setError(""); setStream(null);
      setAudioNames([]); setSubtitles([]);
      try {
        let imdbId = item?.imdb_id || details?.imdb_id || details?.external_ids?.imdb_id || null;
        if (!imdbId && apiKey && item?.id) {
          const extPath = type === "tv" ? `/tv/${item.id}/external_ids` : `/movie/${item.id}/external_ids`;
          try { const ext = await tmdbFetch(extPath, apiKey, { signal: controller.signal }); imdbId = ext?.imdb_id || null; } catch {}
        }
        if (cancelled) return;
        if (imdbId) setResolvedImdbId(imdbId);
        let res = null;
        if (imdbId) res = await collapsResolve({ imdbId, type, season, episode }, { signal: controller.signal });
        if (!res?.ok && !cancelled) {
          const title = item?.title || item?.name || "";
          const year = (item?.release_date || item?.first_air_date || "").slice(0, 4) || null;
          if (title) {
            const kp = await collapsFindKp({ query: title, year }, { signal: controller.signal });
            if (!cancelled && kp?.ok && kp.kinopoiskId) {
              res = await collapsResolve({ kinopoiskId: kp.kinopoiskId, type, season, episode }, { signal: controller.signal });
              if (!cancelled) setMeta(`Кинопоиск: ${kp.title || ""}`);
            }
          }
        }
        if (cancelled) return;
        if (!res?.ok || (!res.hls && !res.dash)) {
          // Tell the parent so it can switch the playerSource to "lampac"
          // and remount the player with the multi-balancer picker. The Collaps
          // embed domain rotates every few weeks — a 410 here is "Collaps lost
          // this title's iframe", not "this film is unobtainable" (the Lampac
          // fleet almost always has a working balancer for the same imdb/kp).
          if (onSourceFailed && !cancelled) onSourceFailed({ provider: "online", error: res?.error || "Collaps: тайтл не найден" });
          setState("error"); setError(res?.error || "Не удалось найти онлайн-источник на Collaps"); return;
        }
        setStream({ dash: res.dash, hls: res.hls });
        setAudioNames(res.audioNames || []);
        setSubtitles(res.subtitles || []);
        setState("ready");
      } catch (e) {
        if (!cancelled) { setState("error"); setError(e?.message || "Ошибка разрешения онлайн-источника"); }
      }
    })();
    return () => { cancelled = true; controller.abort(); destroyAll(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.id, type, season, episode, apiKey, isLampac]);

  // ── Reflect the Lampac fleet's resolved stream into the engine (provider ===
  // "lampac"). The hook owns the whole descent (balancer → dub → quality → a
  // direct-or-relayed URL); here we only map its {hls|mp4} onto the same {stream}
  // the attach effect consumes, and mirror its inline state (voices, qualities,
  // subtitles, meta, sourceError) into the player's own UI. Switching a balancer
  // /dub/quality re-runs the hook, which hands us a new stream → the attach
  // effect re-attaches while <video> stays mounted (switching keeps it seamless).
  useEffect(() => {
    if (!isLampac) return;
    const ls = lampac.stream;
    if (!ls) {
      // No stream yet: loading unless the hook surfaced an inline error and we
      // have nothing playing. A dead balancer must NOT blank a running film.
      // `fleetPlayedRef` (real frames decoded), not `hadPlayedRef` (which flips on
      // the premature `play` event even for a stream that dies on first append),
      // is the honest "something actually played" signal here — otherwise an
      // exhausted-pool error after a false start would never reach the screen.
      if (lampac.sourceError && !fleetPlayedRef.current) {
        const exit = () => { setState("error"); setError(lampac.sourceError.message || "Источник недоступен"); };
        if (loadingExitRef.current) { clearTimeout(loadingExitRef.current); loadingExitRef.current = null; }
        if (loadingWatchdogRef.current) { clearTimeout(loadingWatchdogRef.current); loadingWatchdogRef.current = null; }
        const elapsed = loadingEnteredAtRef.current ? Date.now() - loadingEnteredAtRef.current : MIN_DISPLAY_MS;
        if (elapsed < MIN_DISPLAY_MS) loadingExitRef.current = setTimeout(exit, MIN_DISPLAY_MS - elapsed);
        else exit();
      } else if (!fleetPlayedRef.current) {
        loadingEnteredAtRef.current = Date.now();
        if (loadingWatchdogRef.current) clearTimeout(loadingWatchdogRef.current);
        loadingWatchdogRef.current = setTimeout(() => {
          // Discovery is taking too long — swap the spinner for an inline notice so
          // the overlay never sits frozen. Aborts are handled by the cleanup below.
          if (loadingEnteredAtRef.current && Date.now() - loadingEnteredAtRef.current >= DISPLAY_ERROR_AFTER_MS) {
            setState("error");
            setError("Долгое опрашивание балансеров. Попробуйте другой источник или подождите.");
          }
        }, DISPLAY_ERROR_AFTER_MS);
        setState("loading");
      }
      return () => {
        if (loadingWatchdogRef.current) { clearTimeout(loadingWatchdogRef.current); loadingWatchdogRef.current = null; }
        if (loadingExitRef.current) { clearTimeout(loadingExitRef.current); loadingExitRef.current = null; }
      };
    }
    if (loadingWatchdogRef.current) { clearTimeout(loadingWatchdogRef.current); loadingWatchdogRef.current = null; }
    const exit = () => {
      loadingEnteredAtRef.current = 0;
      setError("");
      setState("ready");
      setStream((previous) => previous?.mp4 === ls.mp4 && previous?.hls === ls.hls && previous?.viaRelay === ls.viaRelay
        ? previous : ls.mp4 ? { mp4: ls.mp4, viaRelay: ls.viaRelay } : { hls: ls.hls, viaRelay: ls.viaRelay });
      setSubtitles(lampac.subtitles || []);
      setMeta(lampac.meta || "");
    };
    const elapsed = loadingEnteredAtRef.current ? Date.now() - loadingEnteredAtRef.current : MIN_DISPLAY_MS;
    if (elapsed < MIN_DISPLAY_MS) loadingExitRef.current = setTimeout(exit, MIN_DISPLAY_MS - elapsed);
    else exit();
    return () => {
      if (loadingExitRef.current) { clearTimeout(loadingExitRef.current); loadingExitRef.current = null; }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLampac, lampac.stream, lampac.sourceError, lampac.subtitles, lampac.meta]);

  // Fleet inline notice (non-fatal): show the hook's sourceError as an overlay
  // ONLY once a stream has genuinely played (frames decoded) — before that, a
  // failure is still driving auto-failover and belongs in the error/loading state,
  // not a dismissable overlay on top of nothing.
  useEffect(() => {
    if (!isLampac) { setNotice(null); return; }
    setNotice(lampac.sourceError && fleetPlayedRef.current ? lampac.sourceError.message : null);
  }, [isLampac, lampac.sourceError]);

  // ── Switching watchdog: the overlay can NEVER outlive a switch ────────────────
  // The `switching` freeze is cleared by the hook (aborted/stale/error descents) or
  // by the player on `seeked`/`playing`. This is the last-resort backstop for the
  // gap neither covers: media that ATTACHES on a switch but silently never reaches
  // `playing` (autoplay blocked with no gesture, a MediaSource that stalls in
  // `waiting` without a fatal error). Without it, rapid back-and-forth switching
  // could leave the dim+spin overlay up forever ("вечная загрузка"). It only ever
  // force-drops the freeze so the UI is usable again — failover itself stays with
  // the engine error handlers and the hook, so a merely autoplay-blocked switch is
  // NOT mistaken for a dead source. Re-armed on each new switch; disarmed the
  // instant the freeze clears on its own.
  //
  // F3 fix: deps are `[isLampac, switching]` only. The previous `[… , lampac.stream]`
  // re-armed a FRESH 14 s timer on every successful stream attach (and again on the
  // next null), so a sequence of healthy 2 s switches stacked ~14 s of patience on
  // top of each other — perceived as "очень долгое". `switching` is the actual signal
  // for "a switch is in flight": it flips false→true in the resolve effect
  // (L1139, gated on hadStreamRef) for first descents, in selectQuality (L1365)
  // for source-quality swaps, and in the manual-retry re-raise. `lampac.stream`
  // changing is a downstream consequence, not a new switch.
  useEffect(() => {
    if (!isLampac || !switching) return;
    const t = setTimeout(() => { lampac.clearSwitching(); }, SWITCH_WATCHDOG_MS);
    return () => clearTimeout(t);
  }, [isLampac, switching]);

  useEffect(() => () => {
    if (sourceSeekTimerRef.current) clearTimeout(sourceSeekTimerRef.current);
  }, []);

  // ── Fleet throughput-stall watchdog: fail over a stream that never plays ──────
  // A byte-probe samples only the FIRST ~128 KB of the resolved media, so a
  // balancer whose first segment arrives fast but whose deeper segments trickle
  // through the relay (observed: zetflix `e3q_` segments at 20-26 s each → ~63 s to
  // first frame) passes the probe yet never actually plays — and emits NO fatal
  // error, so neither the engine ERROR handlers nor the hook's failover ever fire.
  // The probe fundamentally cannot predict sustained throughput; only the <video>
  // element can. This is the one signal that catches it: a fresh fleet stream that
  // hasn't reached genuine playback within FLEET_STALL_MS AND still can't buffer
  // far enough ahead to advance (readyState < HAVE_FUTURE_DATA) is stalling — walk
  // to the next (probe-ranked, fastest-first) balancer. Guarded so it only acts
  // BEFORE first real playback (fleetPlayedRef); a stream that already played and
  // then rebuffers mid-film is not a source failure. Re-armed on each new attach
  // (stream identity changes), disarmed the instant playback latches.
  //   • loadedmetadata fired and readyState ≥ HAVE_FUTURE_DATA at the deadline =
  //     autoplay gesture missing — nudge play(), do NOT fail over.
  //   • loadedmetadata fired but readyState < HAVE_FUTURE_DATA = trickle — fail over.
  //   • loadedmetadata NEVER fired but readyState ≥ HAVE_FUTURE_DATA = bytes flowing
  //     past a moov that lives far ahead (vkmovie's 2–8 MB moov, cdnvideohub's
  //     similar). readyState went up as soon as the first 64 KB Range landed; the
  //     player will never reach playback. Fail over. This is the "0:00/0:00
  //     forever" symptom that the previous readyState-only watchdog missed.
  //   • no metadata, no data = genuine trickle, fail over.
  // Progressive MP4 metadata can take ~9 s; give files a bounded 14 s grace while HLS keeps 7 s.
  useEffect(() => {
    if (!isLampac || !stream) return;
    const v = videoRef.current;
    if (!v) return;
    let metaSeen = false;
    const onMeta = () => { metaSeen = true; };
    v.addEventListener("loadedmetadata", onMeta, { once: true });
    const t = setTimeout(() => {
      if (fleetPlayedRef.current) return;              // genuine playback latched → healthy
      const rs = v.readyState;
      if (!metaSeen && rs >= 3 /* HAVE_FUTURE_DATA */) {
        // bytes flowing but moov still ahead — the previous watchdog couldn't see
        // this; the player will sit at 0:00/0:00 forever otherwise.
        fleetFailover();
        return;
      }
      if (metaSeen && rs >= 3) { try { v.play?.().catch(() => {}); } catch {} return; }
      // No forward progress and not enough buffered to advance: a throughput stall
      // the probe couldn't see and no error will report. Jump to the next balancer.
      fleetFailover();
    }, stream.mp4 ? SWITCH_WATCHDOG_MS : FLEET_STALL_MS);
    return () => {
      clearTimeout(t);
      v.removeEventListener("loadedmetadata", onMeta);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLampac, stream, fleetFailover]);

  // ── AniList + AniSkip (intro/outro) for anime ───────────────────────────────
  useEffect(() => {
    if (introSkipMode === "off" || type !== "tv" || !episode || !duration) return;
    let cancelled = false;
    const controller = new AbortController();
    (async () => {
      try {
        if (!isAnimeContent(item, details)) return;
        let mapped = await resolveAnimeEpisode(item?.id, season, episode, controller.signal);
        if (cancelled || mapped?.ambiguous) return;
        if (!mapped) {
          // A title search identifies the base anime, never an arbitrary sequel.
          if (Number(season) !== 1) return;
          const title = details?.original_name || details?.original_title || item?.original_name || item?.name || item?.original_title || item?.title || "";
          const data = await fetchAnilistData(title, "ANIME", item?.id);
          if (cancelled || !data?.idMal) return;
          mapped = { malId: data.idMal, episode: Number(episode) };
        }
        const timings = await fetchAniSkipTimings(
          mapped.malId,
          mapped.episode,
          duration,
          { signal: controller.signal },
        );
        if (cancelled) return;
        if (timings) setSkipTimings((prev) => mergeTimings(timings, prev));
      } catch {}
    })();
    return () => { cancelled = true; controller.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.id, season, episode, introSkipMode, type, details, duration]);

  // ── Fetch cast (real name + character + photo) for the pause overlay ────────
  // Movies: /movie/{id}/credits. TV: /tv/{id}/credits (series main cast). Top
  // ~10 billed, with a profile photo. Shown when the user pauses — like the
  // Kinopoisk player's cast panel (this is the full cast, not frame-recognized).
  useEffect(() => {
    if (!apiKey || !item?.id) { setCast([]); return; }
    let cancelled = false;
    // Deferred: cast is only rendered on the PAUSE overlay, but the fetch
    // used to fire at mount — competing for the same HTTP/1.1 sockets as
    // the first video segments on the most latency-sensitive window of
    // playback. Wait until playback has had time to latch, then fetch.
    const t = setTimeout(async () => {
      try {
        const path = type === "tv" ? `/tv/${item.id}/credits` : `/movie/${item.id}/credits`;
        const d = await tmdbFetch(path, apiKey);
        if (cancelled) return;
        const list = (d.cast || [])
          .slice(0, 12)
          .map((c) => ({ id: c.id, name: c.name, character: c.character, profile: c.profile_path }))
          .filter((c) => c.name);
        if (!cancelled) setCast(list);
      } catch { if (!cancelled) setCast([]); }
    }, 4000);
    return () => { cancelled = true; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item?.id, type, apiKey]);

  // ── Confirmed IntroDB segments for movies and TV ────────────────────────────
  useEffect(() => {
    if (!stream || !duration || !Number.isFinite(duration)) return;
    let cancelled = false;
    const controller = new AbortController();
    setSkipTimings((prev) => {
      if (!prev) return prev;
      const safe = {};
      for (const key of ["intro", "recap", "outro", "postCredits"])
        if (prev[key]?.endTime <= duration + 2) safe[key] = prev[key];
      return mergeTimings(safe, null);
    });
    (async () => {
      try {
        let imdbId = item?.imdb_id || details?.imdb_id || details?.external_ids?.imdb_id || resolvedImdbId;
        if (!imdbId && apiKey && item?.id) {
          const path = type === "tv" ? `/tv/${item.id}/external_ids` : `/movie/${item.id}/external_ids`;
          imdbId = (await tmdbFetch(path, apiKey))?.imdb_id || null;
          if (imdbId && !cancelled) setResolvedImdbId(imdbId);
        }
        if (cancelled || !imdbId) return;
        const timings = await fetchIntroDbTimings({
          imdbId, type, season, episode, duration, signal: controller.signal,
        });
        if (!cancelled && timings) setSkipTimings((prev) => mergeTimings(prev, timings));
      } catch {}
    })();
    return () => { cancelled = true; controller.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stream, duration, item?.id, item?.imdb_id, details, type, season, episode, apiKey, resolvedImdbId]);

  // ── Attach engine when stream is ready (DASH preferred → 4K) ────────────────
  // Re-arm the once-per-episode next trigger on a genuine episode change only —
  // NOT on every `stream` change. On the fleet a balancer/dub/quality switch
  // re-resolves into a new stream mid-episode; resetting here (instead of in the
  // attach effect) keeps that switch from re-firing autoplay over the credits.
  useEffect(() => {
    nextFiredRef.current = false;
    hadPlayedRef.current = false;
    setResolvedImdbId(item?.imdb_id || details?.imdb_id || details?.external_ids?.imdb_id || null);
    setSkipTimings(null);
    setSkipPrompt(null);
    fleetPlayedRef.current = false;
    lastFleetTimeRef.current = null;
  }, [item?.id, item?.imdb_id, details?.imdb_id, details?.external_ids?.imdb_id, season, episode]);

  useEffect(() => () => {
    clearTimeout(seekTargetTimerRef.current);
    seekTargetTimerRef.current = null;
    resumeTargetRef.current = null;
  }, [item?.id, season, episode]);

  useEffect(() => {
    if (!stream) return;
    const v = videoRef.current;
    if (!v) return;
    destroyAll();
    resumeDoneRef.current = false; // allow one resume seek for this stream
    subsAddedRef.current = false;  // re-add subtitle <track>s for the new media
    setCurrent(0); setDuration(0); setBuffered(0);
    // New media attaches at currentTime 0; forget the previous attempt's clock so
    // the fleet playback latch measures forward motion from THIS stream's start.
    lastFleetTimeRef.current = null;
    fleetPlayedRef.current = false;
    setAudioTracks([]); setAudioId(-1);
    setLevels([]); setCurrentLevel(-1);
    errCountRef.current = 0;
    // Guard so an async attachHls (which awaits the dynamic hls.js import) bails
    // out if the effect cleaned up (stream change / unmount) before Hls loaded —
    // otherwise we'd attach a new Hls to a gone video and leak it.
    let disposed = false;

    // Re-apply the user's previously-set volume/mute to the underlying
    // <video> element. dash.js's player.initialize()/reset() and hls.js's
    // attachMedia() do NOT preserve the element's .volume across a source
    // swap in all browsers — and even when the element itself is reused,
    // dash.js's internal VideoModel can reset playback properties on
    // (re)initialize. Without this, switching episodes (or a Lampac
    // balancer/dub/quality file) silently resets playback to 100% while the
    // UI (bound to React state) still shows the old value. Call this right
    // after the new source/engine attaches (STREAM_INITIALIZED /
    // MANIFEST_PARSED) and again on loadedmetadata as a safety net for any
    // engine/browser that applies it late.
    const reapplyVolume = () => {
      try { v.volume = volumeRef.current; } catch {}
      try { v.muted = mutedRef.current; } catch {}
    };

    // Native <video> playback — for progressive MP4/MKV (Lampac torrent & some
    // balancer files) and for Safari's built-in HLS. No engine object: the
    // element loads the URL directly, so quality/audio come from the file (the
    // Lampac source-quality picker handles the distinct-file switch instead).
    const attachNative = (src) => {
      engineRef.current = "native";
      v.src = src;
      const onMeta = () => {
        try { v.playbackRate = rateRef.current || 1; } catch {}
        reapplyVolume();
        resumeAt(v);
        v.play().catch(() => {});
      };
      v.addEventListener("loadedmetadata", onMeta, { once: true });
      // A native media error can't recover in-place (no ABR ladder): surface it
      // so the Lampac path can show an inline notice and keep the picker up.
      v.addEventListener("error", () => {
        if (disposed) return;
        if (isLampac) {
          // Real frames decoded already → leave the player as-is (a mid-play CDN
          // drop is not a reason to blank a film the viewer was watching).
          if (fleetPlayedRef.current) return;
          // Nothing truly played: a resolved MP4/MKV that won't decode → next
          // balancer (the byte-probe can't catch a bad container); only when the
          // pool is exhausted does the terminal error show.
          if (fleetFailover()) return;
          setState("error"); setError("Поток недоступен");
          return;
        }
        setState((s) => (hadPlayedRef.current ? s : "error"));
        if (!hadPlayedRef.current) setError("Поток недоступен");
      }, { once: true });
    };

    const attachDash = async () => {
      if (!stream.dash) return false;
      try {
        const dashjs = await loadDashJs();
        if (disposed) return false;
        const EVENTS = dashjs.MediaPlayer.events;
        const player = dashjs.MediaPlayer().create();
        dashRef.current = player;
        engineRef.current = "dash";
        player.initialize(v, stream.dash, true);
        // ABR ON with a 1080p-class ceiling. Pinning the rung (the old
        // `autoSwitchBitrate:{video:false}` + setQualityFor) meant a bandwidth
        // dip could never downshift — the engine just rebuffered, which is the
        // #1 source of visible stalls. ABR drops to 720p/480p instead. The
        // 12 Mbps ceiling keeps 4K (40+ Mbps) out of the auto path so the
        // shared Fast-Origin-Transfer quota can't be burned by one film; 4K
        // stays one click away in the picker.
        player.updateSettings({
          streaming: {
            abr: {
              autoSwitchBitrate: { video: true },
              maxBitrate: { video: 12_000_000 },
            },
            cacheInitSegments: true,
            // Deeper buffer headroom at the ceiling rung: a CDN hiccup shorter
            // than the target is absorbed instead of surfacing as a stall.
            buffer: { bufferTimeAtTopQuality: 60 },
          },
        });

        const buildDashQuality = () => {
          try {
            // dash.js 4.x API: getBitrateInfoListFor(type) → [{qualityIndex, bitrate, width, height}]
            const list = (player.getBitrateInfoListFor ? player.getBitrateInfoListFor("video") : []) || [];
            if (!list.length) return;
            // Dedup by height (Collaps failover can duplicate), keep highest bitrate
            const byHeight = new Map();
            for (const b of list) {
              const h = b.height || 0;
              if (!h) continue;
              const cur = byHeight.get(h);
              if (!cur || (b.bitrate || 0) > (cur.bitrate || 0)) byHeight.set(h, b);
            }
            const lvls = [...byHeight.values()]
              .sort((a, b) => (b.height || 0) - (a.height || 0))
              .map((b) => ({
                id: b.qualityIndex,
                height: b.height,
                label: b.height >= 2160 ? "4K" : `${b.height}p`,
                _qidx: b.qualityIndex,
              }));
            setLevels(lvls);
            // Default: ABR (Auto) capped at the 12 Mbps ceiling from
            // updateSettings — the engine starts on a mid rung (fast first
            // frame) and adapts up/down with the network. Do NOT pin with
            // setQualityFor here: a pinned rung can't downshift on a dip.
            // The old default pinned 1080p (setQualityFor) — same quota
            // intent, but it traded every network hiccup for a rebuffer.
            setCurrentLevel(-1);
          } catch {}
        };

        const buildDashAudio = () => {
          try {
            // dash.js 4.x: getTracksFor(type) → audio track objects
            const tracks = (player.getTracksFor ? player.getTracksFor("audio") : []) || [];
            const labeled = tracks.map((t, i) => ({
              id: i,
              name: audioNames[i] || t.labels?.lang || t.labels?.[0]?.text || t.lang || `Аудио ${i + 1}`,
              lang: t.lang || "",
              _track: t,
            }));
            setAudioTracks(labeled);
            const ruIdx = preferredRuTrackIndex(
              tracks.map((t, i) => ({ id: i, name: audioNames[i] || t.lang || "", lang: t.lang || "" })),
              audioNames,
            );
            if (ruIdx >= 0 && tracks[ruIdx]) {
              try { player.setCurrentTrack(tracks[ruIdx]); setAudioId(ruIdx); } catch {}
            }
          } catch {}
        };

        player.on(EVENTS.STREAM_INITIALIZED, () => {
          buildDashQuality();
          buildDashAudio();
          try { v.playbackRate = rateRef.current || 1; } catch {}
          reapplyVolume();
          resumeAt(v);
          v.play().catch(() => {});
          // F4: early `clearSwitching` on a fresh fleet attach. dash.js's STREAM_INITIALIZED
          // fires when the MPD parses — earlier than the first decoded frame that `playing`
          // would react to, and reliably (it is the engine's "we have a stream" signal,
          // not "frames are decoding"). The two prior clearSwitching triggers both have
          // gaps: `seeked` never fires when currentTime starts at 0 (a first descent or a
          // non-resume quality swap), and `playing` can take seconds on a slow CDN even
          // though the manifest is ready and the UI should already be usable. Skip when a
          // resume seek is pending — there the overlay has to stay up until the seek lands
          // (the user explicitly sees "Переключаем источник…" until playback resumes at
          // the saved offset), matching the `seeked` clearSwitching path below.
          if (resumeTargetRef.current == null) lampac.clearSwitching?.();
        });
        // Keep currentLevel in sync when ABR or user changes quality. The
        // listener closed over the empty initial `levels`; read the live list
        // via levelsRef so the mapping is against the built quality list.
        player.on(EVENTS.QUALITY_CHANGE_RENDERED, (e) => {
          if (e.mediaType === "video") {
            const idx = levelsRef.current.findIndex((l) => l._qidx === e.newQuality);
            if (idx >= 0) setCurrentLevel(idx);
          }
        });
        player.on(EVENTS.ERROR, (e) => {
          // Network-class errors (a fragment/segment/key download that failed)
          // are transient by nature: the fleet CDN blips constantly and dash.js
          // retries them internally. The old code fell back to HLS on the FIRST
          // error of any kind — throwing away a working DASH stream (its 4K
          // ladder + RU dubs) for the 720p HLS path over one hiccup. Only a
          // non-network error (manifest load, MediaSource attach, decode) or a
          // sustained run of network errors justifies the swap.
          const code = String(e?.error?.code || e?.error?.message || "").toLowerCase();
          const transient = /download|segment|fragment|key|abort|timeout|network/.test(code);
          errCountRef.current += 1;
          const giveUp = !transient || errCountRef.current > 3;
          if (giveUp && stream.hls) {
            // F8 fix: `player.reset()` only tears down the MediaSource — the
            // MediaPlayer ITSELF (its event listeners, its internal state, the
            // refcount into the dash.js core) survives. After we null
            // `dashRef`, hls.js attaches its own listeners to the same <video>,
            // and any leftover dash.js listener on a future event tick fires
            // into a destroyed MediaPlayer — once observed: a fatal error
            // arrives after attachHls has succeeded, dash.js tries to recover
            // an already-gone MediaSource, the next event turns into
            // "Cannot read properties of null (reading 'getSourceBuffer')".
            // `player.destroy()` is dash.js's full teardown — nulls the
            // internal video model, removes every listener it registered,
            // releases the MediaSource. After that the <video> is dash-free
            // and hls.js owns it cleanly.
            try { player.destroy(); } catch {}
            dashRef.current = null; engineRef.current = null;
            attachHls();
          } else if (giveUp) {
            // No HLS ladder to fall back to: surface it, but only after the
            // retries are truly exhausted (transient errors never get here).
            setState("error");
            setError("Ошибка DASH: " + ((e && (e.error || e.message)) || "unknown"));
          }
        });
        return true;
      } catch {
        return false;
      }
    };

    const attachHls = async () => {
      if (!stream.hls) { setState("error"); setError("Поток недоступен (нет DASH/HLS)"); return; }
      const Hls = await loadHls();
      if (disposed) return; // effect cleaned up while hls.js was loading
      // Safari / iOS play HLS natively (and hls.js reports !isSupported there):
      // hand the URL to the element with the full native lifecycle (resume seek,
      // rate re-apply, error surface) instead of a bare src assignment.
      if (!Hls.isSupported()) { attachNative(stream.hls); return; }
      // Resume-aware start position. hls.js defaults to startPosition:-1 (load
      // from fragment 0). For a mid-film resume, setting v.currentTime AFTER the
      // manifest parses does NOT redirect the in-flight fragment loader: hls.js
      // has already begun fetching from 0, buffers ~8 early segments, hits an
      // early endOfStream, and re-attaches to finally seek-load the target —
      // the "warm double-attach" that made a resumed film take ~3-4× a cold
      // start. Handing hls.js the saved timecode up front makes the very first
      // fragment request land at the resume offset, so a warm resume attaches
      // once and reaches playback as fast as a cold start. This is hls.js's own
      // resume mechanism (no seek-nudge hacks). Skip it when the title is
      // essentially finished (progress ≥ 95%): start from 0, matching resumeAt's
      // `t > dur-10` guard — we have no duration here, so the stored percentage
      // is the finished-check proxy. Legacy percentage-only saves (no timecode)
      // fall through to -1 and resumeAt's post-parse seek, unchanged.
      let startPosition = -1;
      try {
        const tMap = storage.get(STORAGE_KEYS.RESUME_TIME) || {};
        const pMap = storage.get(STORAGE_KEYS.WATCH_PROGRESS) || {};
        const t = resumeTargetRef.current ?? tMap[progressKey];
        const pct = pMap[progressKey];
        if (typeof t === "number" && t >= 5 && (resumeTargetRef.current != null || typeof pct !== "number" || pct < 95)) startPosition = t;
      } catch {}
      // Buffer config (defaults were maxBufferLength 30 s / maxMaxBufferLength
      // 600 s / maxBufferSize 60 MB): a 30 s forward buffer leaves the playhead
      // one hiccup away from a rebuffer on a flaky CDN, and 60 MB forces
      // eviction well before the 600 s ceiling on high-bitrate rungs.
      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: false,
        backBufferLength: 30,
        capLevelToPlayerSize: true,
        maxBufferLength: 60,
        maxMaxBufferLength: 300,
        maxBufferSize: 120 * 1000 * 1000,
        fragLoadingMaxRetry: 6,
        fragLoadingTimeOut: 20000,
        startPosition,
      });
      hlsRef.current = hls; engineRef.current = "hls";
      hls.loadSource(stream.hls); hls.attachMedia(v);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        // Dedup HLS levels by height (Collaps has failover duplicates)
        const seen = new Map();
        for (const l of (hls.levels || [])) {
          if (!l.height) continue;
          const cur = seen.get(l.height);
          if (!cur || (l.bitrate || 0) > (cur.bitrate || 0)) seen.set(l.height, l);
        }
        const lvls = [...seen.values()]
          .sort((a, b) => (b.height || 0) - (a.height || 0))
          .map((l, i) => ({ id: i, height: l.height, label: l.height >= 2160 ? "4K" : `${l.height}p`, _hlsLevel: l.height }));
        setLevels(lvls);
        // ABR (Auto) on ALL form factors. The old desktop path pinned
        // `hls.currentLevel = <1080p index>`, which disables ABR entirely:
        // a bandwidth dip can't downshift, so the engine rebuffers instead
        // (the classic mid-film stall). ABR starts on a mid rung (fast first
        // frame) and adapts up/down with the network.
        hls.currentLevel = -1;
        setCurrentLevel(-1);
        // Preserve the old default's quota intent: cap the AUTO rung at
        // 1080p so 4K (40+ Mbps) can't be auto-selected and burn the shared
        // Fast-Origin-Transfer budget. 4K stays one click away in the picker.
        {
          const lv = hls.levels || [];
          let capIdx = -1;
          for (let i = 0; i < lv.length; i++) {
            if ((lv[i].height || 0) > 0 && (lv[i].height || 0) <= 1080) capIdx = i;
          }
          if (capIdx >= 0) hls.autoLevelCapping = capIdx;
        }
        reapplyVolume();
        resumeAt(v);
        try { v.playbackRate = rateRef.current || 1; } catch {}
        reapplyVolume();
        v.play().catch(() => {});
        // F4: see dash STREAM_INITIALIZED note above. MANIFEST_PARSED is hls.js's
        // "we have a stream" signal — fires as soon as the master m3u8 has been
        // parsed and the level list is available, well before the first frame
        // decodes. Same skip-when-resume-pending guard.
        if (resumeTargetRef.current == null) lampac.clearSwitching?.();
      });
      hls.on(Hls.Events.LEVEL_SWITCHED, (_e, data) => {
        const h = hls.levels?.[data.level]?.height;
        const idx = levelsRef.current.findIndex((l) => l.height === h);
        if (idx >= 0) setCurrentLevel(idx);
      });
      hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, () => {
        const tracks = hls.audioTracks || [];
        const labeled = labelAudioTracks(tracks, audioNames);
        setAudioTracks(labeled);
        const pref = preferredRuTrackIndex(tracks, audioNames);
        if (pref >= 0) { try { hls.audioTrack = pref; setAudioId(pref); } catch {} }
      });
      hls.on(Hls.Events.ERROR, (_e, data) => {
        if (!data?.fatal) return;
        errCountRef.current += 1;
        const attempts = errCountRef.current;
        const giveUp = (why, preservePosition = false) => {
          // hls.destroy() detaches the media element and may reset currentTime.
          // Capture before teardown so a late network failover resumes accurately.
          const position = preservePosition ? (resumeTargetRef.current ?? videoRef.current?.currentTime) : null;
          try { hls.destroy(); } catch {} hlsRef.current = null;
          // Fleet & not yet truly playing → walk to the next balancer; only when
          // the pool is exhausted does the terminal error screen show. After
          // confirmed playback, only exhausted HLS network retries may use the
          // remaining source pool; decode errors keep their existing behavior.
          if (isLampac && (!fleetPlayedRef.current || preservePosition) && fleetFailover(preservePosition, position)) return;
          setState("error"); setError("Поток прерван (CDN нестабилен). " + why);
        };
        // Fleet, nothing decoded yet: the byte-probe let this balancer through but
        // its segments won't append (classic Zetflix bufferAppendError) or its CDN
        // is down. The two fatal classes need OPPOSITE responses here:
        //   • NETWORK_ERROR can be a one-off segment/relay blip → allow ONE cheap
        //     startLoad() retry (re-fetching often clears a transient 5xx/timeout).
        //   • MEDIA_ERROR means the bytes ARRIVED but won't DECODE. recoverMediaError()
        //     just flushes the MediaSource and re-appends the SAME undecodable
        //     segments — on the bad Scarface run that flush-and-retry churned ~8 s
        //     before erroring a second time and only THEN failing over (13.5 s to
        //     first frame). A byte-probe can prove bytes, never that they decode, so
        //     with a live failover pool a sibling that decodes cleanly is one hop
        //     away: a decode failure fails over AT ONCE instead of nursing a stream
        //     that has already proven it can't play.
        // Only forward motion on the <video> element proves real playback; once that
        // latches we're in the branch below, where recoverMediaError IS the right
        // call (mid-film there is no pool to jump to).
        if (isLampac && !fleetPlayedRef.current) {
          try {
            if (attempts <= 1 && data.type === Hls.ErrorTypes.NETWORK_ERROR) { hls.startLoad(); return; }
          } catch {}
          giveUp(data.details || data.type);
          return;
        }
        try {
          // HLS marks NETWORK_ERROR fatal only after its fragment retry policy is
          // exhausted. On an owned source we already have alternatives, so don't
          // repeat another four startLoad cycles after that fatal signal.
          if (isLampac && data.type === Hls.ErrorTypes.NETWORK_ERROR) giveUp(data.details || data.type, true);
          else if (data.type === Hls.ErrorTypes.NETWORK_ERROR && attempts <= 4) hls.startLoad();
          else if (data.type === Hls.ErrorTypes.MEDIA_ERROR && attempts <= 4) hls.recoverMediaError();
          else giveUp(data.details || data.type);
        } catch {}
      });
    };

    // Engine selection (priority: DASH on desktop → HLS everywhere).
    //   Desktop (wide screen): try DASH first (up to 4K + multi-audio), fall
    //     back to HLS if DASH fails or is absent.
    //   Mobile: skip DASH entirely — dash.js is a 779KB bundle that slows
    //     startup, HLS ABR is faster on cellular, and 4K is wasted on a small
    //     screen. Go straight to HLS.
    //   When stream.dash is null (e.g. Kuroko no Basket — HLS-only, 720p max),
    //     skip attachDash() entirely to save an async call. The guard inside
    //     attachDash still catches this, but routing it here makes the intent
    //     explicit and avoids the await overhead.
    const isMobile = typeof window !== "undefined" && (
      window.matchMedia?.("(max-width: 768px)")?.matches ||
      /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent || "")
    );
    (async () => {
      // Progressive file (Lampac torrent / direct MP4-MKV balancer) → native
      // element; no DASH/HLS engine, the container is the whole stream.
      if (stream.mp4) {
        attachNative(stream.mp4);
      } else if (stream.dash && !isMobile) {
        const ok = await attachDash();
        if (!ok) attachHls();
      } else if (stream.hls) {
        attachHls();
      } else {
        setState("error"); setError("Поток недоступен (нет DASH/HLS)");
      }
    })();
    return () => { disposed = true; destroyAll(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stream]);

  // ── Add Collaps `cc` subtitles as <track> elements once ────────────────────
  useEffect(() => {
    if (state !== "ready" || subsAddedRef.current) return;
    const v = videoRef.current;
    if (!v || subtitles.length === 0) return;
    Array.from(v.querySelectorAll("track[data-cc]")).forEach((t) => t.remove());
    subtitles.forEach((s, i) => {
      const t = document.createElement("track");
      t.kind = "subtitles"; t.label = s.name; t.srclang = `cc${i}`; t.src = s.proxyUrl || s.url;
      t.default = false; t.setAttribute("data-cc", "1"); v.appendChild(t);
    });
    subsAddedRef.current = true;
    // Do NOT touch textTracks' mode here. Per the HTML spec, `hidden` means
    // the track is ACTIVE and parsed (the browser downloads and builds cues
    // for every VTT immediately), while the default `disabled` defers the
    // fetch until the track is actually selected. Collaps ships several `cc`
    // tracks — forcing `hidden` started N VTT downloads at the exact moment
    // the first video segments were being fetched. selectSub() flips the
    // chosen track to `showing` on demand, which loads it lazily.
  }, [state, subtitles]);

  // ── Video element events ────────────────────────────────────────────────────
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    // rAF throttle for the 4 Hz timeupdate / per-segment progress events:
    // each raw event used to setState → full re-render of this ~1900-line
    // component (30 useState, the whole controls bar) while frames decode.
    // Coalesce to one setState per animation frame and skip no-op values.
    let timeRaf = 0;
    let lastSetT = -1;
    const onTime = () => {
      const t = v.currentTime || 0;
      if (timeRaf) return;
      timeRaf = requestAnimationFrame(() => {
        timeRaf = 0;
        if (Math.abs(t - lastSetT) > 0.05) { lastSetT = t; setCurrent(t); }
      });
      // Genuine-playback latch for the fleet: currentTime advanced by a small,
      // playback-sized step (not a seek jump, and not while a resume seek is still
      // settling) → real frames are decoding, so lock this balancer in and stop
      // treating later errors as a reason to failover. (v.play() alone fires
      // `playing`/`play` even on a stream that dies on the first segment append,
      // which is exactly the Zetflix bufferAppendError case failover must catch.)
      // The window is bounded on purpose: the >0.1 floor treats "decoded one frame
      // then stalled" as NOT-played (so a dying stream still fails over), and the
      // <2 ceiling rejects a seek/MediaSource-reset jump that slipped past the
      // seek guards below. A false latch would disable failover for good, so bias
      // toward under-latching.
      if (isLampac && !fleetPlayedRef.current && resumeTargetRef.current == null && !v.seeking) {
        const prev = lastFleetTimeRef.current;
        if (prev != null && t > prev + 0.1 && t < prev + 2) {
          fleetPlayedRef.current = true;
          noteFleetPlayingRef.current?.();
        }
        lastFleetTimeRef.current = t;
      }
    };
    const onDur = () => setDuration(v.duration || 0);
    const onPlay = () => { setPlaying(true); hadPlayedRef.current = true; };
    const onPause = () => { setPlaying(false); if (v.currentTime > 0 && resumeTargetRef.current == null) saveResumeTime(v.currentTime); };
    // resume-seek settled → safe to save again. Also the moment a post-switch
    // seek lands, so drop the fleet's `switching` freeze here (the new media has
    // attached and is at the right position — the UI can unfreeze).
    const onSeeked = () => {
      if (resumeTargetRef.current != null && Math.abs(v.currentTime - resumeTargetRef.current) > 1) return;
      resumeTargetRef.current = null;
      clearTimeout(seekTargetTimerRef.current);
      seekTargetTimerRef.current = null;
      if (isLampac) lampac.clearSwitching();
    };
    const onRate = () => setRate(v.playbackRate || 1);
    const onVol = () => { setVolume(v.volume); setMuted(v.muted); };
    const onWaiting = () => setWaiting(true);
    // Playback actually running → clear the switch freeze even when no resume
    // seek fired (a fresh balancer/dub that starts at 0 emits no `seeked`).
    const onPlaying = () => { setWaiting(false); hadPlayedRef.current = true; if (isLampac) lampac.clearSwitching(); };
    const onCanPlay = () => setWaiting(false);
    // `progress` fires on every appended chunk — one re-render per segment
    // during a buffer fill. Same rAF coalescing + no-op skip as onTime.
    let progRaf = 0;
    let lastSetB = -1;
    const onProgress = () => {
      try {
        if (!v.buffered?.length || progRaf) return;
        const end = v.buffered.end(v.buffered.length - 1) || 0;
        progRaf = requestAnimationFrame(() => {
          progRaf = 0;
          if (Math.abs(end - lastSetB) > 0.5) { lastSetB = end; setBuffered(end); }
        });
      } catch {}
    };
    const onLoadedMeta = () => {
      setDuration(v.duration || 0);
      // Safety net: re-apply the user's volume/mute here too, in case the
      // engine (dash.js/hls.js) or native <video> attaches the new source
      // before our STREAM_INITIALIZED/MANIFEST_PARSED re-apply runs, or resets
      // it afterwards on internal re-init. Cheap no-op if already correct.
      try { v.volume = volumeRef.current; v.muted = mutedRef.current; } catch {}
      resumeAt(v);
      // F4 (native path): covers the mp4 / Safari native HLS / progressive file
      // attach (no dash/hls engine callbacks). loadedmetadata is the universal
      // "the new media is attached and we have its duration" signal. Same
      // skip-when-resume-pending guard as the engine-specific clears above —
      // while a saved-offset seek is still settling, the overlay has to stay.
      if (isLampac && resumeTargetRef.current == null) lampac.clearSwitching?.();
    };
    v.addEventListener("timeupdate", onTime); v.addEventListener("durationchange", onDur);
    v.addEventListener("play", onPlay); v.addEventListener("pause", onPause);
    v.addEventListener("seeked", onSeeked);
    v.addEventListener("ratechange", onRate); v.addEventListener("volumechange", onVol);
    v.addEventListener("waiting", onWaiting); v.addEventListener("playing", onPlaying);
    v.addEventListener("canplay", onCanPlay); v.addEventListener("progress", onProgress);
    v.addEventListener("loadedmetadata", onLoadedMeta);
    return () => {
      if (timeRaf) { cancelAnimationFrame(timeRaf); timeRaf = 0; }
      if (progRaf) { cancelAnimationFrame(progRaf); progRaf = 0; }
      v.removeEventListener("timeupdate", onTime); v.removeEventListener("durationchange", onDur);
      v.removeEventListener("play", onPlay); v.removeEventListener("pause", onPause);
      v.removeEventListener("seeked", onSeeked);
      v.removeEventListener("ratechange", onRate); v.removeEventListener("volumechange", onVol);
      v.removeEventListener("waiting", onWaiting); v.removeEventListener("playing", onPlaying);
      v.removeEventListener("canplay", onCanPlay); v.removeEventListener("progress", onProgress);
      v.removeEventListener("loadedmetadata", onLoadedMeta);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stream, progressKey]);

  // ── Watch Together sync ─────────────────────────────────────────────────────
  // Follower: enforce the host's playback state (drift-correct + play/pause)
  // immediately on every syncState change AND on a 500ms tick (expected
  // position advances with time, so we keep correcting between polls).
  //
  // syncState is a NEW object reference every poll (JSON.parse of the room
  // snapshot). We stash it in a ref so the 500ms tick reads the latest, and we
  // ALSO re-apply immediately whenever syncState changes (the [syncState] dep)
  // — this is the low-latency path: the moment a poll delivers a host
  // play/pause/seek, we apply it without waiting for the next tick.
  const syncStateRef = useRef(syncState);
  syncStateRef.current = syncState;
  useEffect(() => {
    if (syncRole !== "follower" || !syncState) return;
    const v = videoRef.current;
    if (!v) return;
    applyWatchSync(v, syncState);
  }, [syncRole, syncState]);
  useEffect(() => {
    if (syncRole !== "follower") return;
    const v = videoRef.current;
    if (!v) return;
    const apply = () => { if (syncStateRef.current) applyWatchSync(v, syncStateRef.current); };
    const tick = setInterval(apply, 500);
    return () => clearInterval(tick);
  }, [syncRole, stream]);

  useEffect(() => {
    if (syncRole !== "host" || !onPlaybackState) return;
    const v = videoRef.current;
    if (!v) return;
    const report = () => onPlaybackState({ playing: !v.paused, position: v.currentTime || 0 });
    const onPlay = () => report();
    const onPause = () => report();
    const onSeeked = () => report();
    const onRate = () => report();
    v.addEventListener("play", onPlay);
    v.addEventListener("pause", onPause);
    v.addEventListener("seeked", onSeeked);
    v.addEventListener("ratechange", onRate);
    return () => {
      v.removeEventListener("play", onPlay);
      v.removeEventListener("pause", onPause);
      v.removeEventListener("seeked", onSeeked);
      v.removeEventListener("ratechange", onRate);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncRole, onPlaybackState, stream]);

  // ── Progress reporting ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!stream) return;
    clearInterval(progressTimerRef.current);
    progressTimerRef.current = setInterval(() => {
      const v = videoRef.current;
      if (!v || !v.duration || !isFinite(v.duration)) return;
      // Don't save while a resume-seek is settling — currentTime can read 0 and
      // wipe the real saved position. The `seeked` event clears this guard.
      if (resumeTargetRef.current != null) return;
      const pct = Math.min(100, Math.round((v.currentTime / v.duration) * 100));
      saveRef.current?.(progressKey, pct);
      saveResumeTime(v.currentTime);
      // Auto-mark watched when only `watchedThreshold` seconds remain (matches
      // the desktop player's semantics — NOT a percentage, so reopening at 80%
      // doesn't instantly mark it watched). Default 20s before the end.
      const remaining = v.duration - v.currentTime;
      if (remaining >= 0 && remaining <= watchedThreshold) {
        markWatchedRef.current?.(progressKey);
      }
    }, 5000);
    return () => clearInterval(progressTimerRef.current);
  }, [stream, watchedThreshold, progressKey]);

  // ── Persist the exact resume timecode on hide / unmount ─────────────────────
  // The 5s timer + pause save cover normal playback; this captures the precise
  // stop point right before a reload / tab-switch / unmount, so reopening the
  // same movie or episode resumes to the exact second (not up to 5s stale).
  useEffect(() => {
    if (!stream) return;
    const flush = () => {
      const v = videoRef.current;
      if (v && v.duration && v.currentTime > 0) saveResumeTime(v.currentTime);
    };
    const onVis = () => { if (document.visibilityState === "hidden") flush(); };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("pagehide", flush);
    return () => {
      flush();
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("pagehide", flush);
    };
  }, [stream, saveResumeTime]);

  // ── Skip intro/outro/recap + next-episode-when-ending detection ───────────────
  // The active mode depends on the content: anime series use introSkipMode
  // (AniSkip, exact); everything else uses the general confirmed-segment mode.
  // content/timing change so the interval uses a stable mode.
  const isAnimeSeries = type === "tv" && episode && isAnimeContent(item, details);
  const activeSkipMode = isAnimeSeries ? introSkipMode : generalSkipMode;
  const providerSkips = useMemo(() => isLampac ? providerSkipRanges(lampac.skip, duration) : [], [isLampac, lampac.skip, duration]);
  useEffect(() => {
    const isFollower = syncRole === "follower";
    const skipActive = !isFollower && (skipTimings || providerSkips.length) && activeSkipMode !== "off";
    setSkipPrompt(null);
    // Run the 1s tick if either skip is active OR a next-episode callback is
    // wired (so we can switch episodes when skip is off). Followers cannot
    // seek locally; the host remains authoritative.
    if (!skipActive && (isFollower || !onNextRef.current)) { setSkipPrompt(null); return; }
    clearInterval(skipTimerRef.current);
    skipTimerRef.current = setInterval(() => {
      if (state !== "ready" || switching) { setSkipPrompt(null); return; }
      const v = videoRef.current; if (!v || !v.duration) return;
      const ct = v.currentTime;

      // ── Skip prompt / auto-skip (intro / outro / recap) ──
      if (skipActive) {
        const { intro, outro, recap } = skipTimings || {};
        const inRecap = recap && ct >= recap.startTime && ct < recap.endTime - 1;
        const inIntro = intro && ct >= intro.startTime && ct < intro.endTime - 1;
        const inOutro = outro && ct >= outro.startTime && ct < outro.endTime - 1;
        const candidate = inRecap ? "recap" : inIntro ? "intro" : inOutro ? "outro"
          : providerSkips.find((range) => ct >= range.startTime && ct < range.endTime - 1) || null;
        const seg = candidate && skipEndFor(candidate, skipTimings) > ct ? candidate : null;
        if (!seg) {
          setSkipPrompt(null);
        } else {
          setSkipPrompt(seg);
          // Unclassified provider ranges require a click, even in automatic mode.
          if (typeof seg === "string" && activeSkipMode === "auto" && !v.paused && !v.seeking) {
            v.currentTime = skipEndFor(seg, skipTimings);
            setSkipPrompt(null);
          }
        }
      }

      // Wait until the actual end threshold, and preserve known post-credit scenes.
      if (!isFollower && !v.paused && !v.seeking && onNextRef.current && !nextFiredRef.current) {
        const remaining = v.duration - ct;
        const nearEnd = remaining >= 0 && remaining <= watchedThreshold;
        const postCreditsDone = !skipTimings?.postCredits || ct >= skipTimings.postCredits.endTime;
        if (nearEnd && postCreditsDone) {
          nextFiredRef.current = true;
          onNextRef.current();
        }
      }
    }, 1000);
    return () => clearInterval(skipTimerRef.current);
  }, [skipTimings, providerSkips, activeSkipMode, onNext, watchedThreshold, syncRole, state, switching]);

  // ── Fullscreen state ────────────────────────────────────────────────────────
  useEffect(() => {
    const onFs = () => setFullscreen(!!document.fullscreenElement);
    const onWebkitFs = () => setFullscreen(!!document.webkitFullscreenElement);
    // iOS Safari fires these on the <video> element, not on document.
    const onBegin = () => setFullscreen(true);
    const onEnd = () => setFullscreen(false);
    document.addEventListener("fullscreenchange", onFs);
    document.addEventListener("webkitfullscreenchange", onWebkitFs);
    const v = videoRef.current;
    if (v) {
      v.addEventListener("webkitbeginfullscreen", onBegin);
      v.addEventListener("webkitendfullscreen", onEnd);
      v.addEventListener("enterfullscreen", onBegin);
      v.addEventListener("leavefullscreen", onEnd);
    }
    return () => {
      document.removeEventListener("fullscreenchange", onFs);
      document.removeEventListener("webkitfullscreenchange", onWebkitFs);
      if (v) {
        v.removeEventListener("webkitbeginfullscreen", onBegin);
        v.removeEventListener("webkitendfullscreen", onEnd);
        v.removeEventListener("enterfullscreen", onBegin);
        v.removeEventListener("leavefullscreen", onEnd);
      }
    };
  }, [stream]);

  // ── Picture-in-Picture state (mobile) ───────────────────────────────────────
  // Mirrors the PiP DOM state into React so the button can show active state.
  // Kept separate from the fullscreen effect above to avoid touching it.
  useEffect(() => {
    const v = videoRef.current;
    if (!v) return;
    const onEnter = () => setPipActive(true);
    const onLeave = () => setPipActive(false);
    v.addEventListener("enterpictureinpicture", onEnter);
    v.addEventListener("leavepictureinpicture", onLeave);
    return () => {
      v.removeEventListener("enterpictureinpicture", onEnter);
      v.removeEventListener("leavepictureinpicture", onLeave);
    };
  }, [stream]);

  // ── Mobile: auto-fullscreen on landscape rotation ───────────────────────────
  // When the phone rotates to landscape → enter fullscreen; back to portrait →
  // exit. `_autoFsRef` is true ONLY while the current fullscreen was auto-
  // triggered by us, so we never fight the user's manual toggle: if they
  // manually exit while still in landscape, we clear the flag and do NOT
  // re-enter until they rotate away and back. Applies to all viewers
  // (incl. followers) — landscape fullscreen is a viewing affordance, not a
  // playback control. Every orientation/fullscreen call is wrapped in try/catch.
  useEffect(() => {
    if (!isMobile) return;
    const v = videoRef.current;
    const el = containerRef.current;

    const isLandscape = () => {
      try {
        if (screen.orientation?.type?.startsWith("landscape")) return true;
      } catch {}
      try {
        const mql = window.matchMedia?.("(orientation: landscape)");
        if (mql) return !!mql.matches;
      } catch {}
      return false;
    };

    // Enter fullscreen — reuses the toggleFullscreen enter-branch logic
    // (container.requestFullscreen() / iOS video.webkitEnterFullscreen()).
    // No orientation.lock here: the user already physically rotated to
    // landscape, locking would fight the device's physical orientation.
    const enterFs = async () => {
      try {
        const reqFS =
          el?.requestFullscreen?.() ||
          el?.webkitRequestFullscreen?.() ||
          el?.webkitRequestFullScreen?.();
        if (reqFS && typeof reqFS.then === "function") {
          try { await reqFS; } catch {}
        }
        if (!document.fullscreenElement && v?.webkitEnterFullscreen) {
          try { v.webkitEnterFullscreen(); } catch {}
        }
      } catch {}
    };

    const exitFs = async () => {
      if (document.exitFullscreen) {
        try { await document.exitFullscreen(); } catch {}
      }
      if (v?.webkitExitFullscreen) {
        try { v.webkitExitFullscreen(); } catch {}
      }
    };

    const onOrientationChange = () => {
      const landscape = isLandscape();
      // fullscreenRef.current is up-to-date here (orientation events fire
      // asynchronously, well after any fullscreen state change has settled).
      if (landscape && !fullscreenRef.current) {
        _autoFsRef.current = true;
        enterFs();
      } else if (!landscape && _autoFsRef.current) {
        _autoFsRef.current = false;
        exitFs();
      }
    };

    // Initial check (may mount already in landscape).
    try { onOrientationChange(); } catch {}

    // Preferred: screen.orientation change event.
    try { screen.orientation?.addEventListener?.("change", onOrientationChange); } catch {}
    // Fallback: matchMedia change + legacy orientationchange.
    const mql = window.matchMedia?.("(orientation: landscape)");
    try { mql?.addEventListener?.("change", onOrientationChange); } catch {}
    try { window.addEventListener?.("orientationchange", onOrientationChange); } catch {}

    // If the user MANUALLY exits fullscreen while still in landscape, clear the
    // auto flag so we don't re-enter until they rotate away and back. Reads the
    // live DOM state (fullscreenchange fires after the change is applied), so
    // it's correct even though fullscreenRef may not have flushed yet.
    const onFsChange = () => {
      const inFs = !!(document.fullscreenElement || document.webkitFullscreenElement);
      if (!inFs && _autoFsRef.current && isLandscape()) {
        _autoFsRef.current = false;
      }
    };
    document.addEventListener("fullscreenchange", onFsChange);
    document.addEventListener("webkitfullscreenchange", onFsChange);
    if (v) v.addEventListener("webkitendfullscreen", onFsChange);

    return () => {
      try { screen.orientation?.removeEventListener?.("change", onOrientationChange); } catch {}
      try { mql?.removeEventListener?.("change", onOrientationChange); } catch {}
      try { window.removeEventListener?.("orientationchange", onOrientationChange); } catch {}
      document.removeEventListener("fullscreenchange", onFsChange);
      document.removeEventListener("webkitfullscreenchange", onFsChange);
      if (v) v.removeEventListener("webkitendfullscreen", onFsChange);
    };
  }, [isMobile, stream]);

  // ── Controls auto-hide ──────────────────────────────────────────────────────
  const showControls = useCallback(() => {
    setControlsVisible(true);
    clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => {
      if (videoRef.current && !videoRef.current.paused &&
          !showTracks && !showQuality && !showSpeed && !showSubs && !showBalanser && !showVoice)
        setControlsVisible(false);
    }, 3000);
  }, [showTracks, showQuality, showSpeed, showSubs, showBalanser, showVoice]);
  useEffect(() => { showControls(); return () => clearTimeout(hideTimerRef.current); }, [showControls, playing]);

  // ── Controls (engine-agnostic) ──────────────────────────────────────────────
  const togglePlay = () => { const v = videoRef.current; if (!v) return; if (v.paused) v.play().catch(() => {}); else v.pause(); };
  const seekTo = (ratio) => {
    const v = videoRef.current;
    if (!v || !Number.isFinite(v.duration) || v.duration <= 0 || !Number.isFinite(ratio)) return;
    const target = Math.min(v.duration, Math.max(0, ratio * v.duration));
    // A pending resume/source switch must follow the viewer's newer seek, or
    // the next reattach can start at the older saved offset and snap backward.
    resumeTargetRef.current = target;
    resumeDoneRef.current = true;
    saveResumeTime(target);
    clearTimeout(seekTargetTimerRef.current);
    seekTargetTimerRef.current = setTimeout(() => {
      if (resumeTargetRef.current === target) resumeTargetRef.current = null;
      seekTargetTimerRef.current = null;
    }, 5000);
    v.currentTime = target;
  };
  const seekBy = (delta) => { const v = videoRef.current; if (!v || !v.duration) return; seekTo((v.currentTime + delta) / v.duration); };
  const onSeekClick = (e) => { const v = videoRef.current; if (!v || !v.duration) return; const r = e.currentTarget.getBoundingClientRect(); seekTo((e.clientX - r.left) / r.width); };
  // rAF-throttled: mousemove fires 60+×/sec; only one setHoverTime per frame.
  const onSeekMove = (e) => {
    const v = videoRef.current;
    if (!v || !v.duration) return;
    const r = e.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    if (hoverRafRef.current) return;
    hoverRafRef.current = requestAnimationFrame(() => {
      hoverRafRef.current = null;
      setHoverTime(ratio * v.duration);
    });
  };
  const onSeekLeave = () => {
    if (hoverRafRef.current) { cancelAnimationFrame(hoverRafRef.current); hoverRafRef.current = null; }
    setHoverTime(null);
  };
  const toggleMute = () => { const v = videoRef.current; if (!v) return; v.muted = !v.muted; setMuted(v.muted); setStoredMuted(v.muted); };
  const changeVol = (val) => { const v = videoRef.current; if (!v) return; const vol = Math.min(1, Math.max(0, Number(val))); v.volume = vol; v.muted = vol === 0; setVolume(vol); setMuted(vol === 0); setStoredVolume(vol); setStoredMuted(vol === 0); };
  const setSpeed = (r) => { const v = videoRef.current; if (v) v.playbackRate = r; setRate(r); setShowSpeed(false); };
  const toggleFullscreen = async () => {
    const v = videoRef.current;
    if (!fullscreen) {
      // Try standard Fullscreen API on the container (works on desktop + Android Chrome).
      const el = containerRef.current;
      const reqFS =
        el?.requestFullscreen?.() ||
        el?.webkitRequestFullscreen?.() ||
        el?.webkitRequestFullScreen?.();
      if (reqFS && typeof reqFS.then === "function") {
        try { await reqFS; } catch {}
      }
      // iOS Safari: requestFullscreen on a div doesn't work — use the video
      // element's native fullscreen instead (webkitEnterFullscreen).
      if (!document.fullscreenElement && v?.webkitEnterFullscreen) {
        try { v.webkitEnterFullscreen(); } catch {}
      }
      // On mobile, lock to landscape for a proper fullscreen experience.
      try { await screen.orientation?.lock?.("landscape"); } catch {}
    } else {
      try { await screen.orientation?.unlock?.(); } catch {}
      if (document.exitFullscreen) {
        try { await document.exitFullscreen(); } catch {}
      }
      // iOS: exit via the video element.
      if (v?.webkitExitFullscreen) {
        try { v.webkitExitFullscreen(); } catch {}
      }
    }
  };

  // Picture-in-Picture toggle (mobile only; button is render-gated by isMobile).
  const togglePiP = async () => {
    if (document.pictureInPictureElement) {
      try { await document.exitPictureInPicture(); } catch {}
    } else if (document.pictureInPictureEnabled && videoRef.current) {
      try { await videoRef.current.requestPictureInPicture(); } catch {}
    }
  };

  const selectAudio = (idx) => {
    const track = audioTracks[idx];
    if (!track) { setShowTracks(false); return; }
    if (engineRef.current === "dash") {
      try { dashRef.current?.setCurrentTrack(track._track); } catch {}
    } else {
      try { if (hlsRef.current) hlsRef.current.audioTrack = track.id; } catch {}
    }
    setAudioId(idx); setShowTracks(false);
  };

  const selectQuality = (idx) => {
    // idx === -1 → Auto (ABR)
    if (engineRef.current === "dash") {
      const p = dashRef.current;
      if (!p) return;
      try {
        p.updateSettings({
          streaming: {
            abr: {
              autoSwitchBitrate: { video: idx < 0 },
              // An explicit pick is a manual override: lift the auto ceiling so
              // the 4K rung is actually reachable (the 12 Mbps ceiling exists
              // only to bound what ABR may pick on its own).
              maxBitrate: { video: idx < 0 ? 12_000_000 : Number.MAX_SAFE_INTEGER },
            },
          },
        });
        if (idx >= 0 && levels[idx]) p.setQualityFor("video", levels[idx]._qidx);
        setCurrentLevel(idx);
      } catch {}
    } else {
      const hls = hlsRef.current;
      if (!hls) return;
      if (idx < 0) { hls.currentLevel = -1; setCurrentLevel(-1); }
      else if (levels[idx]) {
        const origIdx = (hls.levels || []).findIndex((l) => l.height === levels[idx].height);
        if (origIdx >= 0) { hls.currentLevel = origIdx; setCurrentLevel(idx); }
      }
    }
    setShowQuality(false);
  };

  // ── Lampac fleet selectors ──────────────────────────────────────────────────
  // These do NOT touch the engine directly: each re-runs the hook's descent,
  // which hands back a new {hls|mp4} → the attach effect re-attaches. The hook
  // raises `switching` so <video> stays mounted for a seamless swap. The engine
  // `levels`/`audioTracks` above are the ABR ladder / in-file audio of ONE fleet
  // file; the fleet's dubs and distinct-file qualities are separate axes.
  const preserveSwitchPosition = () => {
    const time = resumeTargetRef.current ?? videoRef.current?.currentTime;
    if (time >= 5) {
      saveResumeTime(time);
      resumeTargetRef.current = time;
      return time;
    }
    return null;
  };
  const selectManualSource = (select) => {
    const selection = ++sourceSelectionRef.current;
    if (sourceSeekTimerRef.current) { clearTimeout(sourceSeekTimerRef.current); sourceSeekTimerRef.current = null; }
    const time = preserveSwitchPosition();
    Promise.resolve(select()).then((resolved) => {
      if (selection !== sourceSelectionRef.current) return;
      if (resolved !== true) {
        if (sourceSeekTimerRef.current) { clearTimeout(sourceSeekTimerRef.current); sourceSeekTimerRef.current = null; }
        if (time != null && resumeTargetRef.current === time) resumeTargetRef.current = null;
        lampac.clearSwitching?.();
        return;
      }
      if (time == null) return;
      sourceSeekTimerRef.current = setTimeout(() => {
        if (selection === sourceSelectionRef.current && resumeTargetRef.current === time) resumeTargetRef.current = null;
        sourceSeekTimerRef.current = null;
      }, SWITCH_WATCHDOG_MS);
    }).catch(() => {
      if (selection !== sourceSelectionRef.current) return;
      if (time != null && resumeTargetRef.current === time) resumeTargetRef.current = null;
      lampac.clearSwitching?.();
    });
  };
  const selectBalanser = (id) => { selectManualSource(() => lampac.selectBalanser?.(id)); setShowBalanser(false); };
  const selectVoice = (id) => { selectManualSource(() => lampac.selectVoice?.(id)); setShowVoice(false); };
  const selectSourceQuality = (id) => { selectManualSource(() => lampac.selectQuality?.(id)); setShowQuality(false); };

  const selectSub = (id) => {
    const v = videoRef.current; if (!v) return;
    const tracks = v.textTracks;
    for (let i = 0; i < tracks.length; i++) {
      if (tracks[i].label && subtitles.some((s) => s.name === tracks[i].label))
        tracks[i].mode = i === id ? "showing" : "hidden";
    }
    setSubId(id); setShowSubs(false);
  };
  const doSkip = () => {
    if (syncRole === "follower" || state !== "ready" || switching || !skipPrompt) return;
    if (typeof skipPrompt === "object" && !providerSkips.includes(skipPrompt)) return;
    const v = videoRef.current;
    const endTime = skipEndFor(skipPrompt, skipTimings);
    if (!v || !Number.isFinite(endTime) || endTime <= v.currentTime) return;
    v.currentTime = endTime;
    setSkipPrompt(null);
  };

  // ── Keyboard shortcuts (ref pattern, one stable listener) ───────────────────
  // In Watch Together, a follower must NOT control playback — the host's
  // play/pause/seek is authoritative and applied via sync. We hide the control
  // bar / big play / skip prompt (CSS via .torrplayer--follower), disable
  // click-to-play, and block playback keyboard shortcuts. Local viewing keys
  // (fullscreen, mute, volume) stay enabled since they don't affect sync.
  const isFollower = syncRole === "follower";
  const kbStateRef = useRef({});
  kbStateRef.current = {
    volume, rate, subId, audioId, audioTracks, levels, currentLevel, subtitles,
    togglePlay, seekBy, seekTo, changeVol, toggleMute, toggleFullscreen,
    setSpeed, selectSub, selectAudio, selectQuality, showControls, isFollower,
    // Fleet (Lampac): the dub/quality/balancer axes are DISTINCT files, resolved
    // by the hook. `a`/`q` prefer these over the in-file engine tracks when the
    // fleet exposes them; `b` cycles balancers.
    isLampac,
    balansers, voices, srcQualities,
    balanserId: isLampac ? lampac.balanser : null,
    voiceId: isLampac ? lampac.voice : null,
    srcQualityId: isLampac ? lampac.quality : null,
    selectBalanser, selectVoice, selectSourceQuality,
  };
  useEffect(() => {
    const onKey = (e) => {
      const tag = (e.target?.tagName || "").toLowerCase();
      if (tag === "input" || tag === "textarea" || e.target?.isContentEditable) return;
      const v = videoRef.current; if (!v) return;
      const s = kbStateRef.current;
      // Cycle a fleet list [{id}] by its active id → the next id (wraps).
      const cycleId = (list, activeId) => {
        if (!list?.length) return null;
        const i = list.findIndex((x) => x.id === activeId);
        return list[(i + 1) % list.length].id;
      };
      // Followers: only local viewing keys (fullscreen / mute / volume).
      if (s.isFollower && !["f", "m", "ArrowUp", "ArrowDown"].includes(e.key)) return;
      switch (e.key) {
        case " ": case "k": e.preventDefault(); s.togglePlay(); break;
        case "ArrowLeft": case "j": e.preventDefault(); s.seekBy(-10); break;
        case "ArrowRight": case "l": e.preventDefault(); s.seekBy(10); break;
        case "ArrowUp": e.preventDefault(); s.changeVol(s.volume + 0.05); break;
        case "ArrowDown": e.preventDefault(); s.changeVol(s.volume - 0.05); break;
        case "f": s.toggleFullscreen(); break;
        case "m": s.toggleMute(); break;
        case "<": s.setSpeed(Math.max(0.5, +(s.rate - 0.25).toFixed(2))); break;
        case ">": s.setSpeed(Math.min(2, +(s.rate + 0.25).toFixed(2))); break;
        case "c": if (s.subtitles.length) { const next = s.subId < 0 ? 0 : s.subId + 1 < s.subtitles.length ? s.subId + 1 : -1; s.selectSub(next); } break;
        case "a":
          // Fleet dub (озвучка) first — it's the real "audio" axis on Lampac;
          // fall back to the in-file audio track for Collaps / single-dub fleet.
          if (s.isLampac && s.voices.length > 1) { const id = cycleId(s.voices, s.voiceId); if (id) s.selectVoice(id); }
          else if (s.audioTracks.length > 1) { const next = (s.audioId + 1) % s.audioTracks.length; s.selectAudio(next); }
          break;
        case "q":
          // Fleet distinct-file quality first; else the engine ABR ladder.
          if (s.isLampac && s.srcQualities.length) { const id = cycleId(s.srcQualities, s.srcQualityId); if (id) s.selectSourceQuality(id); }
          else if (s.levels.length) { const next = s.currentLevel < 0 ? 0 : s.currentLevel + 1 < s.levels.length ? s.currentLevel + 1 : -1; s.selectQuality(next); }
          break;
        case "b":
          // Balancer / source — fleet only.
          if (s.isLampac && s.balansers.length > 1) { const id = cycleId(s.balansers, s.balanserId); if (id) s.selectBalanser(id); }
          break;
        default: if (/^[0-9]$/.test(e.key)) { e.preventDefault(); s.seekTo(Number(e.key) / 10); }
      }
      s.showControls();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // ── Close any open menu on outside click ────────────────────────────────────
  useEffect(() => {
    if (!showTracks && !showQuality && !showSpeed && !showSubs && !showBalanser && !showVoice) return;
    const onDown = () => { setShowTracks(false); setShowQuality(false); setShowSpeed(false); setShowSubs(false); setShowBalanser(false); setShowVoice(false); };
    const t = setTimeout(() => document.addEventListener("click", onDown), 0);
    return () => { clearTimeout(t); document.removeEventListener("click", onDown); };
  }, [showTracks, showQuality, showSpeed, showSubs, showBalanser, showVoice]);

  // ── RENDER: loading ─────────────────────────────────────────────────────────
  const srcTitle = isLampac ? "Lampac — балансеры · озвучки · 4K · торренты" : "Онлайн (Collaps) — русская озвучка · до 4K";
  // Once media has attached (or has genuinely played), the <video> element is
  // the player: the loading/error states render as OVERLAYS on top of it
  // instead of replacing the whole component. Unmounting the element — what
  // the full-screen branches below used to do — destroyed the decoder, the
  // MediaSource and the entire buffer, so every mid-film error or fleet
  // failover paid a cold re-buffer (plus the 7 s stall watchdog) to get back.
  // The full-screen branches stay for the honest "nothing ever played" case.
  const hasMedia = !!stream || hadPlayedRef.current || fleetPlayedRef.current;
  if (state === "loading" && !hasMedia) {
    return (
      <div className="torrpicker">
        <div className="torrpicker-head">
          <div className="torrplayer-title">{srcTitle}</div>
          <div className="torrpicker-status"><span className="torrpicker-busy">Поиск источника{meta ? ` · ${meta}` : ""}…</span></div>
        </div>
        <div className="torrpicker-list"><div className="torrpicker-empty">{isLampac ? "Опрашиваем балансеры" : "Подключаемся к Collaps"} и ищем {type === "tv" ? `серию ${season}x${episode}` : "фильм"}…</div></div>
      </div>
    );
  }
  if (state === "error" && !hasMedia) {
    return (
      <div className="torrpicker">
        <div className="torrpicker-head">
          <div className="torrplayer-title">{isLampac ? "Lampac" : "Онлайн (Collaps)"}</div>
          <div className="torrpicker-status"><span className="torrpicker-error">{error}</span></div>
        </div>
        <div className="torrpicker-list"><div className="torrpicker-empty">{isLampac
          ? "Ни один балансер не отдал ссылку на этот тайтл. Причины: у тайтла нет imdb_id / kinopoisk_id на TMDB, фильма нет во флоте, либо все CDN сейчас недоступны. Попробуйте источник «Онлайн», «Торренты» или другой."
          : "Не удалось найти онлайн-источник. Возможные причины: нет imdb_id у этого тайтла на TMDB, Collaps не имеет этой раздачи, или CDN временно недоступен. Попробуйте источник «Торренты» или другой."}</div></div>
        {/* Even when the auto-scan resolved nothing, the fleet may still have
            balancers whose descent needs a manual nudge — offer them here so the
            error screen isn't a dead-end (matches the in-player picker). */}
        {isLampac && balansers.length > 0 && (
          <div className="torrpicker-fallback">
            <div className="torrpicker-fallback-label">Попробовать балансер вручную:</div>
            <div className="torrpicker-fallback-row">
              {balansers.map((b) => (
                <button key={b.id} className="torrpicker-fallback-btn" onClick={() => selectBalanser(b.id)}>
                  {b.name}{b.torrent ? " ⇄" : ""}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
    );
  }

  const menuClass = "torrplayer-audio-menu";
  const currentQualityLabel = currentLevel < 0 ? "Авто" : levels[currentLevel]?.label || "Авто";
  // Fleet picker labels (Lampac only). `lampac.balanser` is the active slug;
  // `lampac.voice`/`lampac.quality` are the active ids inside the hook's lists.
  const activeBalanser = isLampac ? balansers.find((b) => b.id === lampac.balanser) : null;
  const activeVoice = isLampac ? voices.find((v) => v.id === lampac.voice) : null;
  const activeSrcQuality = isLampac ? srcQualities.find((q) => q.id === lampac.quality) : null;
  const voicePickerTitle = ["vkmovie", "rutubemovie"].includes(lampac.balanser)
    ? "Версия / озвучка"
    : "Озвучка";

  return (
    <div
      className={"torrplayer" + (isFollower ? " torrplayer--follower" : "") + (controlsVisible ? "" : " torrplayer--hidden-cursor")}
      ref={containerRef}
      onMouseMove={showControls}
      onMouseLeave={() => { if (videoRef.current && !videoRef.current.paused) setControlsVisible(false); }}
    >
      <video ref={videoRef} className="torrplayer-video" playsInline crossOrigin="anonymous" onClick={isFollower ? undefined : togglePlay} onDoubleClick={toggleFullscreen} />
      {waiting && <div className="torrplayer-spinner" />}
      {/* Re-resolving over a LIVE element (fleet failover mid-film, a retry):
          the element and its buffer stay mounted, only the overlay shows. */}
      {state === "loading" && hasMedia && (
        <div className="torrplayer-state-overlay">
          <div className="torrplayer-spinner" />
          <span className="torrplayer-state-overlay-label">Переключаем источник…</span>
        </div>
      )}
      {/* Fatal error over a live element: the viewer keeps the frame and the
          buffer, sees WHY it stopped, and the pickers stay usable. */}
      {state === "error" && hasMedia && (
        <div className="torrplayer-state-overlay">
          <span className="torrplayer-state-overlay-error">{error}</span>
          <span className="torrplayer-state-overlay-hint">Выберите другой балансер / озвучку / качество</span>
        </div>
      )}
      {/* Fleet re-resolve in flight (balancer/dub/quality swap): keep <video>
          mounted, just dim + spin over it. Cleared on `seeked`/`playing`. */}
      {switching && (
        <div className="torrplayer-switching">
          <div className="torrplayer-spinner" />
          <span className="torrplayer-switching-label">Переключаем источник…</span>
        </div>
      )}
      {/* Non-fatal fleet notice (dead balancer / stale link) while something is
          already playing — the pickers stay up so the viewer can switch. */}
      {notice && (
        <div className="torrplayer-notice" onClick={() => setNotice(null)} title="Скрыть">
          <span className="torrplayer-notice-text">{notice}</span>
        </div>
      )}
      {skipPrompt && state === "ready" && !switching && syncRole !== "follower" && (
        <button className="torrplayer-skip" onClick={doSkip}>
          <span className="torrplayer-skip-title">ПРОПУСТИТЬ</span>
          <span className="torrplayer-skip-sub">
            {skipPrompt === "intro" ? (isAnimeSeries ? "ОПЕНИНГ" : "ЗАСТАВКУ") : skipPrompt === "outro" ? (isAnimeSeries ? "ЭНДИНГ" : "ТИТРЫ") : skipPrompt === "recap" ? "РЕКАП" : "ФРАГМЕНТ"}
          </span>
        </button>
      )}
      {/* Host: show when paused. Follower: show ONLY as a "tap to start"
          fallback when the browser blocked autoplay (host is playing but our
          local video is still paused) — one tap unblocks play(), then sync owns
          it. When the host is the one paused, no button (follower just waits). */}
      {!playing && !waiting && (!isFollower || !!syncState?.playing) && (
        <button className="torrplayer-bigplay" onClick={togglePlay} title="Смотреть"><PlayI /></button>
      )}
      {/* Cast-on-pause (Kinopoisk-style): real name + character + photo */}
      {!playing && !waiting && cast.length > 0 && (
        <div className="torrplayer-cast">
          <div className="torrplayer-cast-title">В ролях</div>
          <div className="torrplayer-cast-row">
            {cast.map((c) => (
              <div className="torrplayer-cast-card" key={c.id}>
                {c.profile ? (
                  <img className="torrplayer-cast-photo" src={imgUrl(c.profile, "w185")} alt={c.name} loading="lazy" />
                ) : (
                  <div className="torrplayer-cast-photo torrplayer-cast-photo--empty">👤</div>
                )}
                <div className="torrplayer-cast-name">{c.name}</div>
                {c.character && <div className="torrplayer-cast-char">{c.character}</div>}
              </div>
            ))}
          </div>
        </div>
      )}
      <div className={"torrplayer-controls" + (controlsVisible ? "" : " torrplayer-controls--hidden")}>
        <button className="torrplayer-btn torrplayer-btn--seekback" onClick={() => seekBy(-10)} title="Назад 10с (← / J)"><Back10I /></button>
        <button className="torrplayer-btn torrplayer-btn--play" onClick={togglePlay} title={playing ? "Пауза (Space / K)" : "Смотреть (Space / K)"}>{playing ? <PauseI /> : <PlayI />}</button>
        <button className="torrplayer-btn torrplayer-btn--seekfwd" onClick={() => seekBy(10)} title="Вперёд 10с (→ / L)"><Fwd10I /></button>
        <button className="torrplayer-btn torrplayer-btn--mute" onClick={toggleMute} title={muted ? "Включить звук (M)" : "Выключить звук (M)"}>{muted || volume === 0 ? <MuteI /> : <VolumeI />}</button>
        <input className="torrplayer-volume" type="range" min={0} max={1} step={0.05} value={muted ? 0 : volume} onChange={(e) => changeVol(e.target.value)} title="Громкость (↑ / ↓)" />
        <span className="torrplayer-time">{fmt(current)} / {fmt(duration)}</span>
        <div className="torrplayer-seek" onClick={onSeekClick} onMouseMove={onSeekMove} onMouseLeave={onSeekLeave} title="Перемотка (0–9)">
          {duration > 0 && buffered > 0 && <div className="torrplayer-seek-buffer" style={{ width: `${(buffered / duration) * 100}%` }} />}
          <div className="torrplayer-seek-fill" style={{ width: `${duration ? (current / duration) * 100 : 0}%` }} />
          {hoverTime != null && <div className="torrplayer-seek-hover" style={{ left: `${duration ? (hoverTime / duration) * 100 : 0}%` }}>{fmt(hoverTime)}</div>}
        </div>

        {/* ── Fleet: Balancer picker (Lampac only) ─────────────────────────── */}
        {isLampac && balansers.length > 0 && (
          <div className="torrplayer-audio">
            <button
              className={"torrplayer-btn" + (showBalanser ? " torrplayer-btn--active" : "")}
              onClick={() => { setShowBalanser((v) => !v); setShowVoice(false); setShowTracks(false); setShowQuality(false); setShowSpeed(false); setShowSubs(false); }}
              title="Источник"
            >
              <BalancerI /><span className="torrplayer-audio-label">{activeBalanser?.name || "Источник"}</span>
            </button>
            {showBalanser && (
              <div className={menuClass + " torrplayer-audio-menu--wide"}>
                {balansers.map((b) => (
                  <button
                    key={b.id}
                    className={"torrplayer-audio-item" + (b.id === lampac.balanser ? " active" : "")}
                    onClick={() => selectBalanser(b.id)}
                  >
                    {b.name}{b.torrent ? " · торрент" : ""}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── Fleet: Voice / dub picker (Lampac only) ───────────────────────── */}
        {/* Show even on a single-dub title so the active озвучка is always
            visible — the previous `> 1` gate hid a dead button ("Озвучка"
            with no menu) when a balancer shipped one labelled-empty dub. */}
        {isLampac && voices.length >= 1 && (
          <div className="torrplayer-audio">
            <button
              className={"torrplayer-btn" + (showVoice ? " torrplayer-btn--active" : "")}
              onClick={() => { setShowVoice((v) => !v); setShowBalanser(false); setShowTracks(false); setShowQuality(false); setShowSpeed(false); setShowSubs(false); }}
              title={voicePickerTitle}
            >
              <VoiceI /><span className="torrplayer-audio-label">{activeVoice?.name || "Озвучка"}</span>
            </button>
            {showVoice && (
              <div className={menuClass + " torrplayer-audio-menu--wide"}>
                {voices.map((vo) => (
                  <button
                    key={vo.id}
                    className={"torrplayer-audio-item" + (vo.id === lampac.voice ? " active" : "")}
                    onClick={() => selectVoice(vo.id)}
                    title={`${vo.name}${vo.meta?.raw ? ` · ${vo.meta.raw}` : ""}`}
                  >
                    {vo.name}{vo.meta?.raw ? ` · ${vo.meta.raw}` : ""}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Speed */}
        <div className="torrplayer-audio">
          <button className="torrplayer-btn" onClick={() => { setShowSpeed((v) => !v); setShowTracks(false); setShowQuality(false); setShowSubs(false); setShowBalanser(false); setShowVoice(false); }} title="Скорость (< >)"><GearI /><span className="torrplayer-audio-label">{rate}×</span></button>
          {showSpeed && (
            <div className={menuClass}>
              {SPEEDS.map((s) => (<button key={s} className={"torrplayer-audio-item" + (s === rate ? " active" : "")} onClick={() => setSpeed(s)}>{s}×{s === 1 ? " (норма)" : ""}</button>))}
            </div>
          )}
        </div>

        {/* Subtitles */}
        {subtitles.length > 0 && (
          <div className="torrplayer-audio">
            <button className={"torrplayer-btn" + (subId >= 0 ? " torrplayer-btn--active" : "")} onClick={() => { setShowSubs((v) => !v); setShowTracks(false); setShowQuality(false); setShowSpeed(false); setShowBalanser(false); setShowVoice(false); }} title="Субтитры (C)"><SubI /><span className="torrplayer-audio-label">{subId >= 0 ? "Вкл" : "Выкл"}</span></button>
            {showSubs && (
              <div className={menuClass}>
                <button className={"torrplayer-audio-item" + (subId < 0 ? " active" : "")} onClick={() => selectSub(-1)}>Выключить</button>
                {subtitles.map((s, i) => (<button key={i} className={"torrplayer-audio-item" + (i === subId ? " active" : "")} onClick={() => selectSub(i)}>{s.name}</button>))}
              </div>
            )}
          </div>
        )}

        {/* Audio */}
        {audioTracks.length > 1 && (
          <div className="torrplayer-audio">
            <button className={"torrplayer-btn" + (audioId >= 0 ? " torrplayer-btn--active" : "")} onClick={() => { setShowTracks((v) => !v); setShowQuality(false); setShowSpeed(false); setShowSubs(false); setShowBalanser(false); setShowVoice(false); }} title="Аудиодорожка (A)"><AudioI /><span className="torrplayer-audio-label">{audioTracks[audioId]?.name || `Аудио ${(audioId ?? -1) + 1}`}</span></button>
            {showTracks && (
              <div className={menuClass}>
                {audioTracks.map((t, i) => (<button key={i} className={"torrplayer-audio-item" + (i === audioId ? " active" : "")} onClick={() => selectAudio(i)}>{t.name}</button>))}
              </div>
            )}
          </div>
        )}

        {/* Quality — engine ABR levels (both providers) + fleet distinct-file
            qualities (Lampac only). The fleet qualities are separate files, so
            picking one re-resolves the stream; the engine levels are the ABR
            ladder inside the ONE file currently attached. */}
        {(levels.length > 0 || (isLampac && srcQualities.length > 0)) && (
          <div className="torrplayer-audio">
            <button className="torrplayer-btn" onClick={() => { setShowQuality((v) => !v); setShowBalanser(false); setShowVoice(false); setShowTracks(false); setShowSpeed(false); setShowSubs(false); }} title="Качество (Q)"><span className="torrplayer-audio-label">{isLampac && activeSrcQuality ? activeSrcQuality.label : currentQualityLabel}</span></button>
            {showQuality && (
              <div className={menuClass}>
                {isLampac && srcQualities.length > 0 && (
                  <>
                    <div className="torrplayer-audio-head">Источник</div>
                    {srcQualities.map((q) => (
                      <button
                        key={q.id}
                        className={"torrplayer-audio-item" + (q.id === lampac.quality ? " active" : "")}
                        onClick={() => selectSourceQuality(q.id)}
                      >
                        {q.label}{q.height >= 2160 ? " ⭐" : ""}
                      </button>
                    ))}
                  </>
                )}
                {levels.length > 0 && (
                  <>
                    {isLampac && srcQualities.length > 0 && <div className="torrplayer-audio-head">Поток (ABR)</div>}
                    <button className={"torrplayer-audio-item" + (currentLevel < 0 ? " active" : "")} onClick={() => selectQuality(-1)}>Авто</button>
                    {levels.map((l, i) => (<button key={i} className={"torrplayer-audio-item" + (i === currentLevel ? " active" : "")} onClick={() => selectQuality(i)}>{l.label}{l.height >= 2160 ? " ⭐" : ""}</button>))}
                  </>
                )}
              </div>
            )}
          </div>
        )}

        {isMobile && typeof document !== "undefined" && document.pictureInPictureEnabled && (<button className={"torrplayer-btn torrplayer-btn--pip" + (pipActive ? " torrplayer-btn--active" : "")} onClick={togglePiP} title="Картинка в картинке"><PiPIcon /></button>)}
        <button className="torrplayer-btn torrplayer-btn--fs" onClick={toggleFullscreen} title="Полный экран (F)"><FullscreenI /></button>
      </div>
    </div>
  );
}
