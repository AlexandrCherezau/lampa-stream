// Web shim: defines window.electron.* via fetch() to the server API.
// Only runs when there is NO window.electron already (i.e. not in Electron,
// where preload.js sets it via contextBridge). Safe to always import.
//
// This makes the desktop renderer work unchanged as a web app: the same
// components call window.electron.collapsResolve(...), secureGet("apikey"),
// tmdbProxyGet(), etc., and here they map to /api/* on the server.

if (!window.electron) {
  // Vercel/web mode: no server-side session. The site password is checked
  // client-side, and each visitor enters their OWN TMDB Read Access Token,
  // stored in localStorage. TMDB calls go through the /api/tmdb serverless
  // proxy. Collaps streams are resolved client-side (IP-bound tokens).
  // Mark this as the web shim so other modules can detect it synchronously.
  window.__webShim = true;

  const LS_SITE_PWD = "lampa_stream_site_pwd";
  const LS_TMDB = "lampa_stream_tmdb_token";

  // ── Collaps browser-side resolver (inlined, no separate module needed) ──────
  // The browser fetches the embed HTML, parses makePlayer, returns the stream URL.
  // Segment tokens match the browser's IP → no 410, which is why this must run
  // client-side. The embed HOST rotates (delivembd → luxembd → ortified → …); we
  // resolve the live one through bhcesh instead of hardcoding. The embed CDN
  // requires `Origin: https://kinokrad.my` (browser fetch() can't forge that), so
  // we go through our own /api/collaps relay which sets the partner identity and
  // streams the HTML back.
  const BHCESH_BASE = "https://api.bhcesh.me";
  const BHCESH_TOKEN = "eedefb541aeba871dcfc756e6b31c02e";
  const COLLAPS_HOST = "kinokrad.my";
  const b64u = (s) => {
    const bytes = new TextEncoder().encode(s);
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  };

  // imdb_id/kinopoisk_id → the live iframe embed URL, or null. bhcesh wants the
  // imdb id as BARE digits ("0167404", not "tt0167404").
  async function collapsResolveIframe({ imdbId, kinopoiskId }, signal) {
    const q = new URLSearchParams({ token: BHCESH_TOKEN });
    if (imdbId) q.set("imdb_id", String(imdbId).replace(/^tt/i, ""));
    else if (kinopoiskId) q.set("kinopoisk_id", String(kinopoiskId));
    else return null;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 12000);
    try {
      const r = await fetch(`${BHCESH_BASE}/franchise/details?${q}`, { cache: "no-store", signal: signal ? AbortSignal.any([signal, ctrl.signal]) : ctrl.signal });
      if (!r.ok) return null;
      const j = await r.json().catch(() => null);
      return (j && typeof j.iframe_url === "string" && j.iframe_url) || null;
    } catch {
      return null;
    } finally {
      clearTimeout(t);
    }
  }

  function extractMakePlayer(html) {
    const i = html.indexOf("makePlayer({");
    if (i < 0) return null;
    const body = html.slice(i + 11);
    let depth = 0, end = -1, inStr = false, strCh = "";
    for (let idx = 0; idx < body.length; idx++) {
      const ch = body[idx];
      if (inStr) { if (ch === "\\") { idx++; continue; } if (ch === strCh) inStr = false; continue; }
      if (ch === '"' || ch === "'") { inStr = true; strCh = ch; continue; }
      if (ch === "{") depth++;
      else if (ch === "}") { depth--; if (depth === 0) { end = idx; break; } }
    }
    if (end < 0) return null;
    return body.slice(0, end + 1);
  }

  function extractJsonArray(obj, key) {
    const re = new RegExp('"?(' + key + ')"?\\s*:\\s*\\[');
    const m = re.exec(obj);
    if (!m) return null;
    const start = m.index + m[0].length - 1;
    let depth = 0, inStr = false, strCh = "";
    for (let idx = start; idx < obj.length; idx++) {
      const ch = obj[idx];
      if (inStr) { if (ch === "\\") { idx++; continue; } if (ch === strCh) inStr = false; continue; }
      if (ch === '"' || ch === "'") { inStr = true; strCh = ch; continue; }
      if (ch === "[") depth++;
      else if (ch === "]") { depth--; if (depth === 0) return obj.slice(start, idx + 1); }
    }
    return null;
  }

  function extractNames(obj) {
    const m = /"names"\s*:\s*(\[[^\]]*\])/.exec(obj);
    if (!m) return [];
    try { return JSON.parse(m[1]); } catch { return []; }
  }

  function matchHls(chunk) {
    const m = chunk.match(/"?hls"?\s*:\s*"([^"]+\.m3u8[^"]*)"/);
    return m ? m[1] : null;
  }

  function parseCollapsHtml(html, type, season, episode) {
    const obj = extractMakePlayer(html);
    if (!obj) return { ok: false, error: "makePlayer not found" };
    let hls = null, dash = null, audioNames = [], subtitles = [], duration = 0;
    if (type === "tv") {
      const arr = extractJsonArray(obj, "seasons");
      let seasons = null;
      if (arr) { try { seasons = JSON.parse(arr); } catch {} }
      if (!seasons || !seasons.length) return { ok: false, error: "No seasons" };
      const sObj = season == null ? seasons[0] : seasons.find((s) => Number(s.season) === Number(season));
      if (!sObj) return { ok: false, error: "Season not found" };
      const eps = sObj.episodes || [];
      const ep = episode == null ? eps[0] : eps.find((e) => Number(e.episode) === Number(episode));
      if (!ep) return { ok: false, error: "Episode not found" };
      hls = ep.hls || null;
      dash = ep.dash || ep.dasha || null;
      audioNames = (ep.audio && ep.audio.names) || [];
      subtitles = Array.isArray(ep.cc) ? ep.cc.map((c, i) => ({ url: c.url, name: c.name || "Sub " + (i + 1) })) : [];
      duration = ep.duration || 0;
    } else {
      const srcIdx = obj.search(/"?source"?\s*:\s*\{/);
      const from = srcIdx >= 0 ? srcIdx : 0;
      const block = srcIdx >= 0 ? obj.slice(from, from + 4000) : obj;
      hls = matchHls(block) || matchHls(obj);
      const dm = block.match(/"?dash"?\s*:\s*"([^"]+\.mpd[^"]*)"/);
      dash = dm ? dm[1] : null;
      audioNames = extractNames(obj);
      const ccArr = extractJsonArray(obj, "cc");
      if (ccArr) { try { const cc = JSON.parse(ccArr); subtitles = cc.map((c, i) => ({ url: c.url, name: c.name || "Sub " + (i + 1) })); } catch {} }
    }
    if (!hls && !dash) return { ok: false, error: "No stream URL" };
    return { ok: true, hls, dash, audioNames, subtitles, duration };
  }

  // ── Collaps embed cache (session) ──────────────────────────────────────────
  // The embed URL (keyed by imdbId / kinopoiskId) returns the SAME HTML for
  // every season/episode of a show — it contains the full makePlayer object
  // with all seasons. Re-fetching on every episode switch is wasteful (a full
  // HTTP round-trip + parse). Cache the raw HTML for 10 min and re-parse with
  // the new season/episode on a hit. Keyed by id so different shows don't
  // collide.
  const _collapsCache = new Map(); // key → { html, expiresAt }
  const COLLAPS_CACHE_TTL = 10 * 60 * 1000;

  async function collapsResolveWeb(args, { signal } = {}) {
    signal?.throwIfAborted();
    const { imdbId, kinopoiskId, type, season, episode } = args;
    if (!imdbId && !kinopoiskId) return { ok: false, error: "Need imdb or kp id" };
    const cacheKey = imdbId ? `imdb:${imdbId}` : `kp:${kinopoiskId}`;
    const now = Date.now();
    const cached = _collapsCache.get(cacheKey);
    if (cached && now < cached.expiresAt) {
      // Re-parse the cached HTML for the requested season/episode — no fetch.
      try {
        return parseCollapsHtml(cached.html, type, season, episode);
      } catch {
        _collapsCache.delete(cacheKey); // corrupt — re-fetch below
      }
    }
    const iframe = await collapsResolveIframe({ imdbId, kinopoiskId }, signal);
    signal?.throwIfAborted();
    if (!iframe) return { ok: false, error: "Collaps: тайтл не найден в каталоге" };
    // The embed page reads `host=` as a route hint.
    //
    // DIRECT FIRST, relay as fallback. The old comment claimed the CDN requires
    // `Origin: https://kinokrad.my` (unforgeable from the browser), forcing the
    // /api/collaps hop. Re-measured 2026-08-25 on embed/movie/376 (Lost): the CDN
    // now answers 200 + makePlayer to ANY Origin and reflects it back in
    // Access-Control-Allow-Origin — the partner gate is gone. Meanwhile every
    // Vercel/Worker egress IP IS block-listed upstream (410 Gone on all three
    // embed hosts), so routing the HTML through the relay now GUARANTEES failure
    // while a direct browser fetch succeeds end-to-end (verified through
    // master → variant → segment for S3E18). Direct also keeps the HTML tokens
    // bound to the same IP hls.js will pull segments from.
    const target = iframe + (iframe.includes("?") ? "&" : "?") + "host=" + COLLAPS_HOST;
    const grab = async (url) => {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 20000);
      try {
        const res = await fetch(url, { signal: signal ? AbortSignal.any([signal, ctrl.signal]) : ctrl.signal, cache: "no-store" });
        if (!res.ok) return null;
        return await res.text();
      } catch {
        return null;
      } finally {
        clearTimeout(t);
      }
    };
    let html = await grab(target);
    signal?.throwIfAborted();
    if (!html) html = await grab("/api/collaps?u=" + b64u(target));
    signal?.throwIfAborted();
    if (!html) return { ok: false, error: "HTTP 410" };
    _collapsCache.set(cacheKey, { html, expiresAt: now + COLLAPS_CACHE_TTL });
    return parseCollapsHtml(html, type, season, episode);
  }

  // ── Server config (Express only): shared TMDB token + auth check ──────────
  // On the Express server (server/index.js), GET /api/config returns the shared
  // TMDB Read Access Token behind the session cookie, so visitors don't each
  // need their own token. On Vercel there is no /api/config (404) → we fall
  // back to the per-visitor token in localStorage (SetupScreen). Cached after
  // the first call.
  let _config = null;
  let _configTried = false;
  async function getConfig() {
    if (_configTried) return _config;
    _configTried = true;
    try {
      const r = await fetch("/api/config", { cache: "no-store" });
      if (r.status === 401) {
        // Express: not logged in → send to the server-rendered login page.
        if (location.pathname !== "/login") location.href = "/login";
        return null;
      }
      if (!r.ok) return null; // 404 on Vercel → no shared token
      _config = await r.json();
      return _config;
    } catch {
      return null;
    }
  }

  window.electron = {
    // ── TMDB token: a per-visitor token (localStorage) wins; otherwise fall
    // back to the Express server's shared token via /api/config. null → the
    // SetupScreen (Vercel per-visitor flow).
    secureGet: async (key) => {
      if (key === "apikey") {
        try { const local = localStorage.getItem(LS_TMDB); if (local) return local; } catch {}
        const c = await getConfig();
        return c ? c.tmdbToken : null;
      }
      return null;
    },
    secureSet: async (key, value) => {
      if (key === "apikey") {
        try {
          if (value) localStorage.setItem(LS_TMDB, value);
          else localStorage.removeItem(LS_TMDB);
        } catch {}
      }
    },

    // ── TMDB proxy: signal "web mode" so api.js uses /api/tmdb + /api/img ──
    tmdbProxyGet: async () => ({ on: true, web: true }),
    tmdbProxySet: async () => ({ on: true, web: true }),

    // ── Collaps online source: resolved IN the browser (IP-bound tokens) ───
    collapsResolve: async (args, options) => collapsResolveWeb(args, options),
    collapsFindKp: async (args, { signal } = {}) => {
      // kinopoisk-id-by-title: not IP-bound, can go direct from the browser.
      const qs = new URLSearchParams({ ...args }).toString();
      try {
        const r = await fetch(
          "https://kinopoiskapiunofficial.tech/api/v2.1/films/search-by-keyword?" +
            qs.replace("query=", "keyword="),
          { signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(8000)]) : AbortSignal.timeout(8000), headers: { "X-API-KEY": "2d55adfd-019d-4567-bbf7-67d503f61b5a" } },
        );
        const json = await r.json();
        const films = json.films || [];
        let best = null;
        if (args.year) best = films.find((f) => String(f.year) === String(args.year));
        if (!best && films.length) best = films[0];
        if (!best) return { ok: false, error: "Кинопоиск ID не найден" };
        return { ok: true, kinopoiskId: best.filmId, title: best.nameRu || best.nameEn, year: best.year };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },

    // ── App info ───────────────────────────────────────────────────────────
    getAppVersion: async () => "web",
    getPlatform: async () => "web",

    // ── Browser-native fallbacks ───────────────────────────────────────────
    openExternal: (url) => {
      try {
        window.open(url, "_blank", "noopener");
      } catch {}
      return Promise.resolve(true);
    },
    showNotification: async (title, body) => {
      try {
        if ("Notification" in window && Notification.permission === "granted") {
          new Notification(title, { body });
        }
      } catch {}
    },

    // ── TorrServer source: not available on web (online-only) ──────────────
    torrPing: async () => ({ ok: false, error: "TorrServer source is desktop-only" }),
    torrList: async () => ({ ok: false, list: [] }),
    torrAdd: async () => ({ ok: false, error: "desktop-only" }),
    torrAddFile: async () => ({ ok: false, error: "desktop-only" }),
    torrGet: async () => ({ ok: false }),
    torrRem: async () => ({ ok: false }),
    torrStream: async () => ({ ok: false }),
    torrExternal: async () => ({ ok: false }),
    torrSearch: async () => ({ ok: false, results: [] }),
    torrGetCfg: async () => ({}),
    torrSetCfg: async () => ({}),
    pickTorrentFile: async () => ({ ok: false }),

    // ── Desktop-only IPC stubs (no-ops; the web app uses the Онлайн source) ─
    // Window controls, downloads, updates, PiP, webview VidSrc, backups, etc.
    // — not applicable in a browser. Returning benign values keeps components
    // that call them from crashing.
    windowMinimize: () => {}, windowToggleMaximize: () => {}, windowClose: () => {},
    windowIsMaximized: async () => false, quitApp: () => {}, setZoomFactor: () => {},
    getInstallPath: async () => null, getAppVersion: async () => "web",
    getCacheSize: async () => 0, getDownloadsSize: async () => 0,
    clearAppCache: async () => ({}), clearWatchData: async () => ({}),
    resetApp: async () => ({}),
    getDownloads: async () => [], runDownload: async () => ({}),
    deleteDownload: async () => ({}), deleteAllDownloads: async () => ({}),
    scanDirectory: async () => ({ files: [] }), pickFolder: async () => ({ ok: false }),
    fileExists: async () => false, openPath: async () => {},
    openPathAtTime: async () => {}, showInFolder: async () => {},
    getVideoDuration: async () => ({ ok: false }),
    searchSubtitles: async () => ({ ok: false }),
    downloadSubtitlesForFile: async () => ({ ok: false }),
    getSubtitleUrl: async () => null, deleteSubtitleFile: async () => {},
    pruneSubtitlePaths: async () => ({}),
    checkDownloader: async () => ({ ok: false }),
    getBlockStats: async () => ({}), fetchReleaseImage: async () => null,
    detectUpdateFormat: async () => null, downloadAndInstallUpdate: async () => ({}),
    cancelUpdate: () => {}, offBlockedUpdate: () => {}, onBlockedUpdate: () => {},
    onUpdateProgress: () => {}, offUpdateProgress: () => {},
    onConfirmClose: () => {}, offConfirmClose: () => {},
    onScheduledBackupRequested: () => {}, offScheduledBackupRequested: () => {},
    onSubtitleFound: () => {}, offSubtitleFound: () => {},
    onWindowMaximize: () => {}, offWindowMaximize: () => {},
    onWebviewEnterFullscreen: () => {}, offWebviewEnterFullscreen: () => {},
    onWebviewLeaveFullscreen: () => {}, offWebviewLeaveFullscreen: () => {},
    onM3u8Found: () => {}, offM3u8Found: () => {},
    onPipOpened: () => {}, offPipOpened: () => {}, onPipClosed: () => {}, offPipClosed: () => {},
    openPipWindow: async () => {}, closePipWindow: async () => {},
    getPipWebContentsId: async () => null, queryVideoProgress: async () => null,
    playerStopped: () => {},
    performScheduledBackup: async () => ({}),
    getScheduledBackupSettings: async () => ({}),
    setScheduledBackupSettings: async () => ({}),
    wyzieOpenRedeem: async () => ({}), wyzieValidateKey: async () => ({ ok: false }),
    onDownloadProgress: () => {}, offDownloadProgress: () => {},
  };
}
