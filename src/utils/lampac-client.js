// Browser-side client for the Lampac fleet (player source "lampac").
//
// Unlike collaps-client.js this does NOT go through window.electron: there is no
// desktop counterpart to bridge to. Lampac's /lite/* endpoints hard-403 any
// request carrying a foreign Origin or Referer, so the browser can never reach
// them and every call has to pass through our own serverless relay
// (api/lampac.js) — which is same-origin, so a plain fetch() is all that's
// needed. Consequently the source is web-only (see availableSources()).
//
// The relay base is configurable: VITE_LAMPAC_RELAY lets the whole relay move to
// a Worker/VPS without touching any other file. Empty → this deployment's own
// /api/lampac.

import {
  LAMPAC_FALLBACK_HOSTS,
  hostOf,
  normalizeEvents,
  withRjson,
  withParams,
  withHost,
} from "./lampac-browser.js";
import { storage } from "./storage.js";

const HOSTS_URL = "https://api-m.vi3000.top/api/plugin/lampac/hosts";
const HOSTS_TTL = 10 * 60 * 1000;
// A persisted host list older than this is not trusted to start on.
const HOSTS_MAX_AGE = 24 * 60 * 60 * 1000;
const JSON_TIMEOUT = 25000;
const PROBE_TIMEOUT = 6000;
// The probe reads a bounded sample of the resolved media. Two caps because the
// two shapes need different amounts to be judged:
//   • a playlist we read up to PROBE_BYTE_CAP so we can count its segment URIs and
//     detect a pathological one (zetflix hands back a 1.3 MB / 1701-segment m3u8
//     that alone takes ~3.5 s to fetch+parse before a single frame decodes);
//   • a media body we only need a throughput SAMPLE of — PROBE_MEDIA_SAMPLE bytes,
//     timed, is enough to tell a 1 MB/s CDN from one that trickles at 60 KB/s.
const PROBE_BYTE_CAP = 256 * 1024;
const PROBE_MEDIA_SAMPLE = 128 * 1024;
// A DIRECT media body needs far less than that. Direct already dominates scoring
// (DIRECT_FLOOR) and makes a survivor "great" regardless of throughput, so the only
// thing the read must still prove is that the CDN actually serves bytes rather than
// a 403/redirect page. Measured on Груз 200 / filmix: reading the full 128 KB
// sample cost 325 ms of the viewer's wait for information that changed no decision.
const PROBE_DIRECT_SAMPLE = 16 * 1024;
// FAST mode (the scan's critical path) reads only enough of a progressive file to
// walk its top-level atom chain — mp4Preroll never seeks, it sums declared atom
// sizes and stops at `moov`/`mdat`, so a few hundred bytes normally suffice and
// 32 KB covers a file with an unusually fat `ftyp`/`free` prefix. That is still
// enough to catch the one thing that genuinely ruins a start (a 34 MB `moov`,
// filmix's Интерстеллар) while costing ~1/4 of the direct sample and ~1/8 of the
// relay one. See probeMediaUrl's `fast` option for why the playlist path skips its
// segment walk in the same mode.
const PROBE_HEAD_SAMPLE = 32 * 1024;
// …and how much of a MANIFEST fast mode reads. Everything the verdict needs lives
// at the top of an m3u8: the #EXTM3U line, the highest-RESOLUTION #EXT-X-STREAM-INF,
// the first variant URI, and (for a media playlist) the first #EXTINF + segment URI.
// The only thing the tail contributed was an exact URI count, and the pathological
// case that count existed to catch (zetflix's 1.3 MB / 1701-segment master) is now
// recognised from the DECLARED content length instead — which is exact, arrives with
// the headers, and costs nothing. 64 KB through the relay is ~60 ms against ~250 ms
// for the full 256 KB cap.
const PROBE_MANIFEST_SAMPLE = 64 * 1024;
// /lite/events per-host budget, how long to wait before ALSO asking the next host
// instead of waiting for the current one to fail, and how many may overlap (see
// lampacEvents).
const EVENTS_TIMEOUT = 5500;
const EVENTS_HEDGE_MS = 400;
const EVENTS_MAX_INFLIGHT = 3;
// A balancer listing is a pure function of the title query, and the fleet itself
// caches it per title: measured on Груз 200, the FIRST /lite/events took 1284 ms
// while a second one moments later (different query string — kinopoisk_id added,
// same title) answered in 121 ms. That 1.2 s is Lampac matching the title upstream,
// and it was being paid AFTER the Play click — over half of the whole start-up.
// So the answer is memoised here and, more importantly, can be warmed while the
// viewer is still reading the detail page (lampacWarmEvents). Short TTL: the
// listing does drift as balancers come and go, and a stale entry would cost a
// pointless descent.
const EVENTS_CACHE_TTL = 3 * 60 * 1000;
// A fleet `call` hop (phantom's /lite/<bal>/video?id_file=…) works on only SOME
// hosts at any moment — the others hang until the relay's header timeout and 502.
// The host that answered /lite/events is NOT reliably one of the good ones, so a
// call is resolved as a hedged race across hosts. Two regimes:
//   • WARM (callHostHint set): try only the hinted host first; it answers in ~25ms
//     so the hedge never fires and the call costs exactly one request.
//   • COLD (no hint): fan out fast — a short hedge and a wider in-flight window —
//     because we've no idea which host is healthy and the wedged ones each cost a
//     full CALL_HOST_TIMEOUT before releasing a slot. First good payload wins and
//     pins `callHostHint`, so only the first cold call pays the discovery cost.
// The `spread` flag gates the fan-out: the interactive resolve path spreads (the
// viewer is waiting, the connection budget is idle); the discovery scan does NOT
// (many probes run at once — a per-probe fan-out would blow the six-connection
// budget), so a scan-time call just tries the hint/own host once and fails cheaply
// if wedged, leaving that balancer as a lazy failover candidate.
const CALL_HEDGE_MS = 200;
const CALL_HOST_TIMEOUT = 5000;
const CALL_MAX_INFLIGHT = 5; // = fleet size: cold, race every host so the one healthy
                             // one is reached at its own speed, not after N timeouts.
// …and the SCAN regime, which is neither of the two above. A purely sequential walk
// (the old spread:false) is wrong for a reason that is now measured rather than
// guessed: on Груз 200 the five fleet hosts answered phantom's call hop
//   130-207 121 ms · 66-191 wedged 8 s+ · 88-218 wedged · 62-113 wedged · 58-169 3712 ms
// so landing on a wedged host first burns the scout's whole 4000 ms cap and phantom
// — the only source carrying 720p (and 2160p on other titles) — never certifies. The
// viewer then gets filmix's 480p by default, which is exactly "у phantom пропал
// выбор разрешение, а у них 4к". A full fan-out is still wrong (many probes run at
// once; five connections per call would starve the siblings it's racing), so the
// scan gets a middle regime: TWO hosts in flight, a short hedge, and a per-host
// timeout well under the scout's cap so a wedge is abandoned instead of waited out.
const SCAN_CALL_HEDGE_MS = 500;
const SCAN_CALL_MAX_INFLIGHT = 2;
// When a hinted host is in play AND we're in scan mode, give it this long alone
// before bringing in the second host — measured healthy call hop is 2.5-4.4s, so
// 2200ms covers the midpoint of the healthy range before pulling in a sibling.
// Normal hedging resumes after.
const SCAN_HINT_QUIET_MS = 2200;
// Per-host timeout for a scan-time `call` resolve. Measured 2026-08-05 across
// Fight Club / Interstellar / Scarface / Thor 2: the healthy fleet hosts answer
// phantom's call hop in 2.5-4.4s (3/5 hosts wedge to 502@~20s). 4500ms covers
// the full healthy range with ~100ms margin and stays well under the relay's
// 20s wedge. Slower than the 6000ms interactive timeout because a wedged scan
// host is recovered by a sibling that the hedge already pulled in.
const SCAN_CALL_HOST_TIMEOUT = 4500;

// Default relay: this deployment's own Vercel /api/lampac function. The fleet
// 403s every direct Origin, so the browser has to go through SOMETHING —
// Vercel is the same-origin path, no extra DNS hop, no Worker CPU cap. The
// vi3000.top Origin impersonation lives in api/lampac.js (line ~494).
//
// An optional Worker relay can be selected through VITE_LAMPAC_RELAY.
// Compare deployed latency and plan CPU limits before switching; local dev
// timings do not establish a production speed-up. Vercel stays the default.
const RELAY_BASE = (() => {
  let base = "";
  try {
    const env = String(import.meta.env?.VITE_LAMPAC_RELAY || "").trim();
    if (env) base = env;
  } catch {
    /* keep default */
  }
  return base.replace(/\/+$/, "");
})();
// Fallback for the (rare) case VITE_LAMPAC_RELAY points at a Worker AND the
// Worker 503s. Default empty → fallback disabled, which is correct when the
// default IS the same-origin Vercel function (no Worker to fall back from).
// Set VITE_LAMPAC_RELAY_FALLBACK explicitly to enable.
const VERCEL_RELAY_FALLBACK = (() => {
  let base = "";
  try {
    const env = String(import.meta.env?.VITE_LAMPAC_RELAY_FALLBACK || "").trim();
    if (env) base = env;
  } catch {
    /* keep default */
  }
  return base.replace(/\/+$/, "");
})();

const RELAY_PATH = "/api/lampac";

export const relayEndpoint = () => `${RELAY_BASE}${RELAY_PATH}`;

const b64u = (s) => {
  const bytes = new TextEncoder().encode(String(s));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

// Builds a relay URL for an arbitrary upstream. The relay proxies any host —
// fleet, control, or third-party CDN — signed or not (the old "unsigned → 403"
// host gate was removed). `_p` siblings minted by the relay are still preferred
// where they exist, because they carry the per-item CDN headers.
export function lampacProxy(url, { headers, json = false } = {}) {
  const q = new URLSearchParams({ u: b64u(url) });
  const h = headers && Object.keys(headers).length ? JSON.stringify(headers) : "";
  if (h) q.set("h", b64u(h));
  if (json) q.set("json", "1");
  return `${relayEndpoint()}?${q}`;
}

// A `_p` sibling minted by the relay is already a relative /api/lampac URL (and
// carries the HMAC for third-party CDNs). Re-point it at the configured relay
// without disturbing its signature — the signature covers u/h/exp, not the host.
export function proxied(pUrl) {
  if (typeof pUrl !== "string" || !pUrl) return null;
  if (!RELAY_BASE) return pUrl;
  return pUrl.startsWith(RELAY_PATH) ? RELAY_BASE + pUrl : pUrl;
}

// ---------------------------------------------------------------------- fetches

// Fetches an already-built relay URL and insists on JSON. Split out from
// relayJson so a `_p` sibling (which carries its own HMAC) can be fetched
// verbatim — the signature covers u/h/exp, so appending json=1 is safe.
//
// `signal` is the caller's own AbortSignal (the balancer scout's, say). It is
// ORed with the internal timeout, so an abandoned probe stops occupying one of
// the browser's six connections to our origin the moment it is abandoned —
// letting go of the promise would not have stopped the request.
async function fetchRelayJson(relayUrl, { timeout = JSON_TIMEOUT, signal = null } = {}) {
  if (signal?.aborted) return { ok: false, status: 0, error: "Отменено", kind: "cancelled" };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  const onAbort = () => ctrl.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  // Try the fallback relay once when the primary is unreachable or 5xx — the
  // Worker URL the user runs against is on a temp account (zinc-sunscreen per
  // memory, ~60 min TTL) or its own free tier, both of which return 5xx /
  // "Failed to fetch" / 530 from Cloudflare's edge before the relay URL
  // wrapping in fetchRelayJson can even produce a status. The 503 path was
  // the original trigger (CPU cap on the free tier); the temp-account case
  // asks for the fallback to also fire on network errors and 5xx so the
  // visitor doesn't see "Failed to fetch" when Vercel would have answered.
  const tryFallback = () => {
    if (!VERCEL_RELAY_FALLBACK) return null;
    const tail = relayUrl.slice(relayUrl.indexOf("?") + 1);
    return fetch(VERCEL_RELAY_FALLBACK + tail, { signal: ctrl.signal, cache: "no-store" })
      .then((v) => v.text().then((text) => {
        let json = null;
        try { json = JSON.parse(text); } catch {}
        if (v.ok && json && typeof json === "object") {
          return { ok: true, status: v.status, json };
        }
        return null;
      }))
      .catch(() => null);
  };
  try {
    const r = await fetch(relayUrl, {
      signal: ctrl.signal,
      cache: "no-store",
    });
    // 503 (CPU cap), 5xx (Worker gone / 530 from Cloudflare edge), 502/504
    // (gateway churn) — all reasons the primary might be down. Try once on
    // the fallback before giving up.
    if (r.status >= 500 && VERCEL_RELAY_FALLBACK) {
      const v = await tryFallback();
      if (v) return v;
    }
    const text = await r.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* balancer answered HTML — handled below */
    }
    if (!r.ok) {
      return { ok: false, status: r.status, error: json?.message || (r.status === 503 && /^(catalog|results)$/.test(text.trim())
        ? "У этого источника нет выбранного фильма или серии"
        : `Источник временно недоступен (HTTP ${r.status})`), kind: "no-link" };
    }
    if (!json || typeof json !== "object") {
      return { ok: false, status: r.status, error: "Балансер ответил не JSON", kind: "no-link" };
    }
    return { ok: true, status: r.status, json };
  } catch (e) {
    if (signal?.aborted) return { ok: false, status: 0, error: "Отменено", kind: "cancelled" };
    // Network-level failure on the primary (the Worker's host is unreachable,
    // DNS is down, the temp account is gone) — also try the fallback once
    // before reporting. The fallback shares the same signal/timeout so a
    // user's abandoned scout still aborts the second hop on time.
    if (VERCEL_RELAY_FALLBACK) {
      const v = await tryFallback();
      if (v) return v;
    }
    return {
      ok: false,
      status: 0,
      error: e?.name === "AbortError" ? "Источник не отвечает" : String(e?.message || e),
      kind: "no-link",
    };
  } finally {
    clearTimeout(t);
    signal?.removeEventListener("abort", onAbort);
  }
}

// Plain upstream URL → relay (fleet hosts, unsigned).
async function relayJson(url, { headers, timeout = JSON_TIMEOUT, signal = null } = {}) {
  return fetchRelayJson(lampacProxy(url, { headers, json: true }), { timeout, signal });
}

// Preferred JSON hop: a `_p` sibling when the relay minted one (it carries the
// per-item CDN headers), else the raw URL through the relay — which now accepts
// third-party hosts too, so the fallback is a real path, not a dead end.
export async function relayJsonPreferProxy(
  { url, proxyUrl, headers },
  { timeout = JSON_TIMEOUT, extra = null, signal = null } = {},
) {
  const p = proxied(proxyUrl);
  if (p) {
    // `_p` already encodes u/h; only json=1 has to be added, and it is not part
    // of the signed tuple.
    const sep = p.includes("?") ? "&" : "?";
    const r = await fetchRelayJson(`${p}${sep}json=1`, { timeout, signal });
    if (r.ok) return r;
    // The sibling went stale (>12 h) or its target died — the unsigned relay
    // path covers every host now, so fall through to it.
    if (r.status !== 403) return r;
  }
  if (!url) return { ok: false, status: 0, error: "Нет ссылки", kind: "no-link" };
  return relayJson(extra ? withParams(url, extra) : url, { headers, timeout, signal });
}

// ------------------------------------------------------------------ fleet hosts
//
// api-m.vi3000.top is fully CORS-open (only /lite/* is Origin-gated), so the host
// list can be fetched straight from the browser. Cached for 10 min; the hardcoded
// list is used until the first answer and whenever discovery fails.
//
// Discovery is never on the critical path. It costs a full RTT to a third-party
// host (~220 ms measured), and every caller already has a usable list: the one
// persisted from the last visit, or the hardcoded fallbacks. So callers get that
// list synchronously and the refresh lands in the background for the NEXT call.
// The only cost of a stale entry is one dead host in the /lite/events race, which
// that race is built to absorb.

const LS_HOSTS = "lampac_hosts";

let hostsCache = (() => {
  const saved = storage.get(LS_HOSTS);
  const list = Array.isArray(saved?.list) ? saved.list.filter((h) => typeof h === "string" && h) : [];
  const fresh = list.length && Date.now() - (Number(saved.at) || 0) < HOSTS_MAX_AGE;
  // `at: 0` on purpose — a persisted list is good enough to START on, but it must
  // still trigger a refresh, so it is never treated as within the 10-min TTL.
  return { at: 0, list: fresh ? list : LAMPAC_FALLBACK_HOSTS.slice() };
})();
let hostIdx = 0;
let hostsInFlight = null;
// The fleet host whose `call` hop last resolved cleanly. It makes the common
// case of the call race cost exactly one request. Never trusted blindly — a
// hint that 502s just loses the race. Persisted with a short TTL so a NEW TAB
// (or a reload) starts from the known-good host instead of re-paying the cold
// fan-out; the wrong-host case self-corrects because a 502 loses the race.
const CALL_HINT_KEY = "lampac_callHostHint";
const CALL_HINT_TTL = 30 * 60 * 1000;
let callHostHint = (() => {
  const saved = storage.get(CALL_HINT_KEY);
  if (saved && typeof saved.host === "string" && Date.now() - (Number(saved.at) || 0) < CALL_HINT_TTL) {
    return saved.host;
  }
  return null;
})();
function setCallHostHint(host) {
  callHostHint = host;
  try { storage.set(CALL_HINT_KEY, { host, at: Date.now() }); } catch {}
}
// query-string → {at, value} for /lite/events, plus the in-flight promises so a
// warm-up and a real ask never duplicate the request. Module-scoped (not
// localStorage): the listing carries per-session signed `_p` URLs, so persisting it
// across reloads would hand back siblings the relay no longer honours.
const eventsCache = new Map();
const eventsInFlight = new Map();

// Background refresh. Returns the promise so a caller that genuinely has nothing
// (never happens — there are always fallbacks) could await it.
function refreshHosts() {
  if (hostsInFlight) return hostsInFlight;
  hostsInFlight = (async () => {
    try {
      const r = await fetch(HOSTS_URL, { cache: "no-store", signal: AbortSignal.timeout(8000) });
      const j = await r.json();
      const list = (Array.isArray(j?.hosts) ? j.hosts : [])
        .map((h) => String(h).trim().toLowerCase())
        .filter((h) => /^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(h));
      // Stamp the time even on failure so a dead endpoint doesn't cost 8s per call.
      hostsCache = { at: Date.now(), list: list.length ? list : hostsCache.list };
      if (list.length) storage.set(LS_HOSTS, { at: Date.now(), list });
    } catch {
      hostsCache = { at: Date.now(), list: hostsCache.list };
    } finally {
      if (hostIdx >= hostsCache.list.length) hostIdx = 0;
      hostsInFlight = null;
    }
    return hostsCache.list;
  })();
  return hostsInFlight;
}

// Synchronous: the list to use right now. Kicks off a refresh when the cached one
// is past its TTL, but never waits for it.
export function lampacHostsNow() {
  if (Date.now() - hostsCache.at >= HOSTS_TTL) refreshHosts();
  return hostsCache.list;
}

export async function lampacHosts() {
  if (Date.now() - hostsCache.at < HOSTS_TTL) return hostsCache.list;
  return refreshHosts();
}

export function currentHost() {
  const list = hostsCache.list;
  return list[hostIdx % list.length];
}

// True for hosts that belong to the Lampac fleet itself. Used to pick the
// hedged cross-host race for `call` endpoints (any fleet host serves the whole
// catalogue) — NOT as a relay-acceptance test: the relay proxies every host.
export function isFleetHost(url) {
  const h = hostOf(url);
  if (!h) return false;
  return h === "api-m.vi3000.top" || hostsCache.list.includes(h);
}

// Any fleet host serves the whole catalogue, so a failure is a reason to rotate,
// not to give up.
export function rotateHost() {
  hostIdx = (hostIdx + 1) % Math.max(1, hostsCache.list.length);
  return currentHost();
}

// --------------------------------------------------------------------- /lite/*

// The query Lampac matches titles on. `kinopoisk_id` matters: with it the fleet
// answered 17 balancers for Breaking Bad against 13 without, because several
// balancers (zetflix, zetflixdb, cdnvideohub, kinoflix) are kp-keyed only.
export function lampacQuery({ title, originalTitle, year, serial, imdbId, kinopoiskId, originalLanguage, anime, tmdbId }) {
  const q = new URLSearchParams();
  q.set("title", title || originalTitle || "");
  q.set("original_title", originalTitle || title || "");
  if (year) q.set("year", String(year));
  q.set("serial", serial ? "1" : "0");
  if (imdbId) q.set("imdb_id", imdbId);
  if (kinopoiskId) q.set("kinopoisk_id", String(kinopoiskId));
  if (originalLanguage) q.set("original_language", String(originalLanguage));
  if (anime === true) q.set("anime", "1");
  const numericTmdbId = Number(tmdbId);
  if (Number.isInteger(numericTmdbId) && numericTmdbId > 0) q.set("tmdb_id", String(numericTmdbId));
  q.set("rjson", "true");
  return q.toString();
}

// Balancer list. Every fleet host serves the same catalogue, so which one answers
// is irrelevant — only how fast. The old serial loop paid the full timeout of each
// dead host before trying the next (a 9 s stall in front of a list a sibling
// answers in 350 ms), so this is a HEDGED race instead: ask the preferred host,
// and if it hasn't answered within EVENTS_HEDGE_MS ask the next one too, and so
// on up to EVENTS_MAX_INFLIGHT at a time. First usable answer wins and every
// straggler is aborted immediately, so it stops holding one of the browser's six
// connections to our own origin.
//
// Hedging, not a full fan-out: the common case still costs exactly one request,
// and only a genuinely slow host pulls in a second.
export async function lampacEvents(args, { signal = null, cache = true } = {}) {
  const hosts = lampacHostsNow();
  if (!hosts.length) return { ok: false, error: "Нет хостов", kind: "no-link" };
  // Rotated so the host that answered last time goes first.
  const order = hosts.map((_, i) => (hostIdx + i) % hosts.length);
  const qs = lampacQuery(args);

  // Memoised / warmable: see EVENTS_CACHE_TTL. A hit costs nothing and is the
  // difference between paying Lampac's ~1.2 s title match after the Play click and
  // paying it while the viewer is still looking at the poster. In-flight requests
  // are shared too, so a warm-up racing a real ask never doubles the work.
  if (cache) {
    const hit = eventsCache.get(qs);
    if (hit && Date.now() - hit.at < EVENTS_CACHE_TTL) return hit.value;
    const live = eventsInFlight.get(qs);
    if (live) return live;
  }

  const run = (async () => {
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  signal?.addEventListener("abort", onAbort, { once: true });

  let settle;
  const done = new Promise((r) => { settle = r; });
  let finished = false;
  let next = 0;        // index into `order` of the host to ask next
  let outstanding = 0; // requests in flight
  let last = "Источник не отвечает";
  const timers = [];
  const win = (v) => { if (!finished) { finished = true; settle(v); } };

  const launch = () => {
    if (finished || next >= order.length) return;
    const slot = order[next++];
    const host = hosts[slot];
    outstanding++;
    relayJson(`https://${host}/lite/events?${qs}`, { timeout: EVENTS_TIMEOUT, signal: ctrl.signal })
      .then((r) => {
        if (finished) return;
        if (r.ok) {
          const list = normalizeEvents(r.json);
          if (list.length) {
            hostIdx = slot; // the next descent starts on the host that answered
            win({ ok: true, host, balansers: list });
            return;
          }
          last = "Балансеры не найдены";
        } else if (r.kind !== "cancelled") {
          last = r.error;
        }
        launch(); // this host is out — bring in the next without waiting on a timer
      })
      .finally(() => {
        outstanding--;
        if (!finished && outstanding === 0 && next >= order.length) {
          win({ ok: false, error: last, kind: "no-link" });
        }
      });
  };

  // A host that neither answers nor fails must not block the list, so overlap one
  // more every EVENTS_HEDGE_MS until something wins.
  const hedge = () => {
    if (finished || next >= order.length) return;
    if (outstanding < EVENTS_MAX_INFLIGHT) launch();
    timers.push(setTimeout(hedge, EVENTS_HEDGE_MS));
  };
  launch();
  timers.push(setTimeout(hedge, EVENTS_HEDGE_MS));

  try {
    return await done;
  } finally {
    for (const t of timers) clearTimeout(t);
    ctrl.abort(); // drop every straggler — the answer is in
    signal?.removeEventListener("abort", onAbort);
  }
  })();

  if (!cache) return run;
  eventsInFlight.set(qs, run);
  try {
    const v = await run;
    // Only a real listing is worth caching: a failure is usually one bad host or an
    // abort, and pinning it for three minutes would break the very next attempt.
    if (v?.ok && v.balansers?.length) eventsCache.set(qs, { at: Date.now(), value: v });
    return v;
  } finally {
    eventsInFlight.delete(qs);
  }
}

// Warm ONE balancer's first hop. Each balancer caches its own upstream title match
// exactly as /lite/events does — measured on Во все тяжкие / filmix through the
// relay: 756 ms first, 146 ms repeat, and in a live descent that cold first hop cost
// 3420 ms, enough for the scout's per-probe cap to abort filmix's byte-probe the
// instant before it would have passed.
//
// Nothing is cached HERE, deliberately: a balancer's JSON carries signed `_p` URLs
// with their own expiry, so handing a stored copy back later could resolve to links
// the relay no longer honours. A real ask can await the matching warm request
// while it is in flight; after it settles, later asks still fetch a fresh result.
const WARM_BAL_TTL = 90 * 1000;
const warmedBal = new Map();
const warmBalInFlight = new Map();

function balancerRequestKey(url, extra, proxyUrl) {
  const full = extra ? withParams(withRjson(url), extra) : withRjson(url);
  try {
    const canonical = new URL(full);
    canonical.searchParams.sort();
    return `${canonical.toString()}|${proxyUrl || ""}`;
  } catch {
    return `${full}|${proxyUrl || ""}`;
  }
}

function waitForBalancer(promise, { signal, timeout }) {
  // ponytail: an aborted consumer leaves the warm request running for at most EVENTS_TIMEOUT (5.5 s); shared abort ownership needs ref-counting.
  if (signal?.aborted) return Promise.resolve({ ok: false, status: 0, error: "Отменено", kind: "cancelled" });
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const onAbort = () => finish({ ok: false, status: 0, error: "Отменено", kind: "cancelled" });
    const timer = setTimeout(() => finish({ ok: false, status: 0, error: "Источник не отвечает", kind: "no-link" }), timeout);
    signal?.addEventListener("abort", onAbort, { once: true });
    promise.then(finish, (error) => finish({ ok: false, status: 0, error: String(error?.message || error), kind: "no-link" }));
  });
}

export function lampacWarmBalanser(url, { extra = null, proxyUrl = null } = {}) {
  try {
    const key = balancerRequestKey(url, extra, proxyUrl);
    const at = warmedBal.get(key);
    if (at && Date.now() - at < WARM_BAL_TTL) return warmBalInFlight.get(key);
    warmedBal.set(key, Date.now());
    const request = requestBalanser(url, { extra, proxyUrl, timeout: EVENTS_TIMEOUT });
    warmBalInFlight.set(key, request);
    request.then(() => {
      if (warmBalInFlight.get(key) === request) warmBalInFlight.delete(key);
    }, () => {
      if (warmBalInFlight.get(key) === request) warmBalInFlight.delete(key);
    });
    return request;
  } catch { /* never let a warm-up throw into a render */ }
}

// One balancer. `extra` carries the season/voice params Lampac itself puts in the
// URLs it hands out, so pass a raw balancer URL plus the search query on first
// call and the returned URL untouched afterwards.
//
// Balancer endpoints live on the fleet, so unsigned is the normal path. A
// `proxyUrl` is used only when there are no `extra` params to add — appending
// params to a `_p` sibling would not change what it fetches (the target is
// encoded inside `u`), so in that case the raw URL has to be used.
export async function lampacBalanser(url, { extra = null, headers = null, proxyUrl = null, signal = null, timeout = JSON_TIMEOUT } = {}) {
  const key = balancerRequestKey(url, extra, proxyUrl);
  const warmRequest = !headers && warmBalInFlight.get(key);
  if (warmRequest) return waitForBalancer(warmRequest, { signal, timeout });
  return requestBalanser(url, { extra, headers, proxyUrl, signal, timeout });
}

async function requestBalanser(url, { extra = null, headers = null, proxyUrl = null, signal = null, timeout = JSON_TIMEOUT } = {}) {
  const full = extra ? withParams(withRjson(url), extra) : withRjson(url);
  const r = !extra && proxyUrl && !isFleetHost(full)
    ? await relayJsonPreferProxy({ url: full, proxyUrl, headers }, { signal, timeout })
    : await relayJson(full, { headers, signal, timeout });
  if (!r.ok) return r;
  return { ok: true, json: r.json, url: full };
}

// `method:"call"` items: one more JSON hop before a playable URL exists. This is
// also where the real quality dict shows up (phantom advertises 2160p on the item
// and returns a 6-entry 2160p→360p dict here).
//
// TWO endpoint shapes, handled differently:
//   • a THIRD-PARTY host (veoveo → api.rstprgapipt.com) — reached through its
//     `_p` sibling (or the plain relay path, which proxies any host). A sibling
//     is host-locked (its target is baked into the signed `u`), so no cross-host
//     race is possible or needed there. One shot.
//   • a FLEET host (phantom → <ip>.nip.io/lite/…/video) — resolvable on ANY fleet
//     host because the session store is shared, but WEDGED on most at any moment
//     (they hang the hop until the relay's 20 s header timeout → 502). So this is
//     a hedged race across hosts: hinted-healthy first, siblings pulled in on a
//     short timer, first good payload wins and pins the hint for next time. This
//     is what brings phantom's 4K picker back — the old single-host attempt landed
//     on a wedged host and returned {ok:false,kind:"stale"} with an empty list.
function callIsResolved(j) {
  return !!(j && (j.url || j.stream || j.quality || j.mp4quality));
}

async function resolveCallFleet(url, { headers, signal, timeout, spread = true }) {
  const hosts = lampacHostsNow();
  const own = hostOf(url);
  // Order: the pinned-healthy host, then the call's own host, then the rest — each
  // at most once. A hinted host that has since gone bad just loses the race.
  const order = [];
  const seen = new Set();
  for (const h of [callHostHint, own, ...hosts]) {
    if (h && !seen.has(h)) { seen.add(h); order.push(h); }
  }
  if (!order.length) return { ok: false, error: "Нет хостов", kind: "no-link" };
  // spread=false ⇒ the SCAN regime: two hosts in flight on a short hedge, each on a
  // tight per-host timeout (see SCAN_CALL_*). Bounded enough not to starve the
  // sibling probes, wide enough that a wedged host can't consume the scout's cap.
  // spread=true ⇒ interactive fan-out (below).
  const maxInflight = spread ? CALL_MAX_INFLIGHT : SCAN_CALL_MAX_INFLIGHT;
  const hostTimeout = spread ? CALL_HOST_TIMEOUT : SCAN_CALL_HOST_TIMEOUT;
  const hedgeMs = spread ? CALL_HEDGE_MS : SCAN_CALL_HEDGE_MS;

  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  signal?.addEventListener("abort", onAbort, { once: true });

  let settle;
  const done = new Promise((r) => { settle = r; });
  let finished = false, next = 0, outstanding = 0;
  let last = { ok: false, error: "Ссылка устарела", kind: "stale" };
  const timers = [];
  const win = (v) => { if (!finished) { finished = true; settle(v); } };

  const launch = () => {
    if (finished || next >= order.length) return;
    const host = order[next++];
    outstanding++;
    // withHost keeps id_file/token_movie; only the host swaps.
    relayJson(withHost(url, host), { headers, timeout: hostTimeout, signal: ctrl.signal })
      .then((r) => {
        if (finished) return;
        if (r.ok && callIsResolved(r.json)) {
          setCallHostHint(host); // pin: the next call (and the next tab) starts here, warm
          win({ ok: true, json: r.json });
          return;
        }
        // A 502/empty from this host — record and bring in the next immediately
        // (don't wait on the hedge timer for a host we already know is out).
        if (r.ok) last = { ok: false, error: "Ссылка устарела", kind: "stale" };
        else if (r.kind !== "cancelled") last = r;
        launch();
      })
      .finally(() => {
        outstanding--;
        if (!finished && outstanding === 0 && next >= order.length) win(last);
      });
  };
  const hedge = () => {
    if (finished || next >= order.length) return;
    if (outstanding < maxInflight) launch();
    timers.push(setTimeout(hedge, hedgeMs));
  };
  // Initial burst. WARM (hint present) → 1: order[0] is the just-worked host and
  // answers in ~100ms, so the hedge never fires and the call costs one connection.
  // COLD (no hint) → the whole fleet at once: order[0] is the minting host (often
  // wedged) and the sole healthy host may sit at index 3-4, so trickling it in at
  // CALL_HEDGE_MS steps wastes seconds before it's even contacted. Firing all five
  // lets the healthy one answer at its own cold speed (~2.8s), and the wedged
  // connections are freed the instant win() aborts the controller.
  // The scan starts one host (the hint, usually healthy and ~120 ms) and lets the
  // hedge bring in the second — so the common case still costs one connection.
  const initialBurst = spread ? (callHostHint ? 1 : Math.min(maxInflight, order.length)) : 1;
  for (let i = 0; i < initialBurst; i++) launch();
  // Both regimes hedge now. Without one, the scan's walk was purely error-driven —
  // fine for a host that 502s fast, useless against the wedged hosts measured above,
  // which return nothing at all until the timeout expires.
  // SCAN + hint: give the hinted host SCAN_HINT_QUIET_MS alone before the first
  // hedge — it's usually healthy (~120 ms), so firing the regular hedge on it
  // would pull in a sibling for nothing. Normal hedging resumes after.
  const firstHedgeMs = !spread && callHostHint ? SCAN_HINT_QUIET_MS : hedgeMs;
  timers.push(setTimeout(hedge, firstHedgeMs));

  try {
    return await done;
  } finally {
    for (const t of timers) clearTimeout(t);
    ctrl.abort();
    signal?.removeEventListener("abort", onAbort);
  }
}

export async function lampacResolveCall(url, { headers = null, proxyUrl = null, signal = null, timeout = JSON_TIMEOUT, spread = true } = {}) {
  // Third-party call endpoints only work through their signed `_p` sibling, and a
  // sibling is host-locked (its target is baked into the signed `u`) — so no
  // cross-host race is possible or needed there. Fleet calls take the hedge.
  const useFleet = !proxyUrl && isFleetHost(url);
  const r = useFleet
    ? await resolveCallFleet(url, { headers, signal, timeout, spread })
    : await relayJsonPreferProxy({ url, proxyUrl, headers }, { signal, timeout });
  if (!r.ok) return r;
  const j = r.json;
  if (!callIsResolved(j)) {
    return { ok: false, error: "Ссылка устарела", kind: "stale" };
  }
  return { ok: true, json: j };
}

// ---------------------------------------------------------------- direct-first
//
// Playing a CDN directly costs zero Vercel transfer, and the quota is project-wide
// (burning it takes /api/tmdb and /api/room down with it). Several balancer CDNs
// do send `access-control-allow-origin: *` (verified on v206.cinemap.cc and
// *.werkecdn.me), so probe before falling back to the relay.
//
// Deliberately a plain GET: adding a Range header makes it a non-simple request,
// which triggers a preflight the CDN may not answer even though the GET itself
// would have been fine.

// Per-host CORS verdict from probeDirect. Persisted with a TTL: a CDN's ACAO
// policy changes rarely, and a cold session used to re-probe every host on the
// first title (each probe is a full cross-origin GET on the critical path).
const DIRECT_CACHE_KEY = "lampac_directCache";
const DIRECT_CACHE_TTL = 24 * 60 * 60 * 1000;
const directCache = (() => {
  const m = new Map();
  try {
    const saved = storage.get(DIRECT_CACHE_KEY);
    if (saved && typeof saved === "object") {
      const now = Date.now();
      for (const [host, v] of Object.entries(saved)) {
        if (v && typeof v.at === "number" && now - v.at < DIRECT_CACHE_TTL) m.set(host, v.ok);
      }
    }
  } catch { /* corrupt entry — start cold */ }
  return m;
})();
let directFlushTimer = null;
function directCacheFlush() {
  directFlushTimer = null;
  try {
    const obj = {};
    for (const [host, ok] of directCache) obj[host] = { ok, at: Date.now() };
    storage.set(DIRECT_CACHE_KEY, obj);
  } catch { /* quota — the in-memory map keeps working */ }
}
function directCacheSet(host, ok) {
  directCache.set(host, ok);
  // Debounced: a scan probes several hosts at once, and each write used to be
  // a synchronous JSON.stringify + setItem on the critical path.
  if (!directFlushTimer) directFlushTimer = setTimeout(directCacheFlush, 1000);
}

export async function probeDirect(url, { signal = null } = {}) {
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  // nip.io fleet hosts 403 any foreign Origin by design — never worth a probe.
  if (host.endsWith(".nip.io")) return false;
  if (directCache.has(host)) return directCache.get(host);
  if (signal?.aborted) return false;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT);
  const onAbort = () => ctrl.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  let ok = false;
  try {
    const r = await fetch(url, { signal: ctrl.signal, cache: "no-store" });
    const acao = r.headers.get("access-control-allow-origin");
    const ownOrigin = typeof location !== "undefined" ? location.origin : null;
    // The browser's <video>/hls.js engine enforces CORS strictly — a CDN that
    // answers 200/206 but sends no ACAO will block the segment requests with
    // net::ERR_BLOCKED_BY_CLIENT (or the CORS preflight fails). Without the
    // header check here, probeDirect declared every reachable third-party host
    // "direct playable", and `playableUrl` then handed the browser a URL it
    // couldn't fetch. Require the response to allow our own origin (or '*').
    const corsOk = !acao || acao === "*" || (ownOrigin && acao === ownOrigin);
    ok = (r.ok || r.status === 206) && corsOk;
    // Read nothing: cancel as soon as the headers (and thus CORS) are known.
    try {
      r.body?.cancel();
    } catch {}
  } catch {
    ok = false;
  } finally {
    clearTimeout(t);
    signal?.removeEventListener("abort", onAbort);
  }
  // An abandoned probe proves nothing about the host — caching its `false` would
  // permanently route a CORS-open CDN through the relay.
  if (!(signal?.aborted && !ok)) directCacheSet(host, ok);
  return ok;
}

// Playback URL for one media link: direct when the CDN allows it, else the relay's
// signed form, else the relay's plain form (fleet hosts), else null when we cannot
// reach it at all.
export async function playableUrl({ url, proxyUrl, headers }, { preferDirect = true, signal = null } = {}) {
  if (!url && !proxyUrl) return null;
  if (preferDirect && url && (await probeDirect(url, { signal }))) {
    return { url, viaRelay: false };
  }
  const p = proxied(proxyUrl);
  if (p) return { url: p, viaRelay: true };
  if (url) {
    // No `_p` sibling. Fleet hosts hard-403 any direct browser fetch, so they
    // MUST go through the relay. Third-party CDNs send no ACAO either — and
    // the relay proxies ANY host now (the old "unsigned → 403" gate is gone),
    // so relay-first for everything; direct is only ever the preferred path
    // above, when the CDN actually answered the CORS probe.
    return { url: lampacProxy(url, { headers }), viaRelay: true };
  }
  return null;
}

// Confirms a resolved media link actually streams AND estimates how fast — the
// difference between a balancer that merely *resolves* and one that *plays well*.
// Two things stall the fleet even when a probe technically "passes":
//   1. a balancer that trickles bytes (zetflix segments at ~60 KB/s) — a 2 KB
//      probe can't see this, so we sample a timed window and report kbps;
//   2. a pathological master playlist (zetflix: 1.3 MB / 1701 segment URIs, ~3.5 s
//      just to fetch+parse through the relay before a frame decodes) — so we read
//      up to PROBE_BYTE_CAP, count URIs, and flag `capped` when it never ended.
// Returns a verdict object (not a bare bool): { ok, kind, bytes, ms, kbps, uris,
// capped, reason }. `ok:false` means it doesn't stream at all; the rest lets the
// scout prefer a lean, fast survivor over a bloated, slow one.
function concatChunks(chunks, total) {
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

// Non-empty, non-comment lines in an m3u8 are the URIs (variant streams in a
// master, segments in a media playlist). A raw count is a fine "is this heavy"
// proxy; a truncated last line only mis-counts by one.
function countPlaylistUris(text) {
  let n = 0;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line && line[0] !== "#") n++;
  }
  return n;
}

// -------------------------------------------------------- first-frame pre-roll
//
// "Direct and streams fast" does NOT bound time-to-first-frame, and the gap was
// costing whole seconds. Filmix's Интерстеллар is a CORS-open 1.7 GB mp4 that
// passes every existing check in ~40 ms — but its `moov` header is 34.4 MB and the
// browser must hold ALL of it before frame 1 (measured 8.7-12.5 s). rutubemovie
// serves the same film as 2-second HLS segments of ~60 KB: first frame ≈1.5 s.
// So the deciding quantity is neither "direct" nor manifest kbps but the size of
// the block the player must download before it can decode anything:
//   • progressive mp4 → ftyp+moov, whose sizes are declared in their own first 8
//     bytes, i.e. already inside the sample the probe has read;
//   • HLS → the first media segment, one manifest level down.
// Both are measured here so the scout can score on the wait the viewer will
// actually sit through.
const PROBE_VARIANT_SAMPLE = 16 * 1024;  // EXTINF + first URI live at the top
const PROBE_SEG_SAMPLE = 48 * 1024;      // enough to time the segment path
const PROBE_SEG_TIMEOUT = 3000;

const u32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const u64 = (b, o) => u32(b, o) * 4294967296 + u32(b, o + 4);
const isAtomType = (s) => /^[\x20-\x7e]{4}$/.test(s);

// Walk the top-level mp4 atom chain and return the bytes that precede `mdat`.
// `late` means the media came first and the header is somewhere past it — the
// browser will range-request the tail, a cost we can't size but shouldn't ignore.
function mp4Preroll(buf) {
  let off = 0, pre = 0;
  for (let i = 0; i < 8; i++) {
    if (off + 8 > buf.length) return { pre: null };
    let size = u32(buf, off);
    const type = String.fromCharCode(buf[off + 4], buf[off + 5], buf[off + 6], buf[off + 7]);
    if (!isAtomType(type)) return { pre: null };
    if (size === 1) {
      if (off + 16 > buf.length) return { pre: null };
      size = u64(buf, off + 8);
    }
    if (!(size > 0)) return { pre: null };
    if (type === "mdat") return { pre, late: true };
    pre += size;
    if (type === "moov") return { pre };
    off += size;
  }
  return { pre: null };
}

// #EXT-X-STREAM-INF entries of a master playlist, paired with the URI that follows.
function parseVariants(text) {
  const lines = text.split("\n");
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^#EXT-X-STREAM-INF/i.test(lines[i].trim())) continue;
    const bw = Number((/BANDWIDTH=(\d+)/i.exec(lines[i]) || [])[1] || 0);
    const height = Number((/RESOLUTION=\d+x(\d+)/i.exec(lines[i]) || [])[1] || 0);
    for (let j = i + 1; j < lines.length; j++) {
      const u = lines[j].trim();
      if (!u || u[0] === "#") continue;
      out.push({ bw, height, uri: u });
      break;
    }
  }
  return out;
}

// First media segment of a media playlist, with its declared duration.
function firstSegment(text) {
  const lines = text.split("\n");
  let dur = 0;
  for (const raw of lines) {
    const line = raw.trim();
    const m = /^#EXTINF:([\d.]+)/.exec(line);
    if (m) dur = Number(m[1]) || dur;
    if (line && line[0] !== "#") return { uri: line, dur };
  }
  return null;
}

const nowMs = () => (typeof performance !== "undefined" && performance.now ? performance.now() : Date.now());

// A relayed manifest's URL is same-origin and often root-relative ("/api/lampac?u=…"),
// and its rewritten URIs are too, so resolve against the document before joining.
const absUrl = (base, uri) => {
  try {
    const abs = typeof location !== "undefined" ? new URL(base, location.href).href : base;
    return new URL(uri, abs).href;
  } catch { return null; }
};

// Bounded, timed read of one URL. Returns the sample plus the FULL size when the
// server declares one (content-range beats content-length), so a 4 MB segment can
// be recognised from a 48 KB sample.
async function sampleUrl(url, { sample, timeout, signal }) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  const onAbort = () => ctrl.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  const t0 = nowMs();
  try {
    const r = await fetch(url, { headers: { range: `bytes=0-${sample - 1}` }, signal: ctrl.signal, cache: "no-store" });
    const cr = r.headers.get("content-range");
    const declared = cr ? Number(String(cr).split("/")[1]) : Number(r.headers.get("content-length") || 0);
    if (r.status >= 400) { try { r.body?.cancel(); } catch { /* already closed */ } return { status: r.status, bytes: 0, ms: 1, total: 0 }; }
    let bytes = 0;
    const chunks = [];
    if (r.body?.getReader) {
      const reader = r.body.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (value?.length) { chunks.push(value); bytes += value.length; }
        if (bytes >= sample) { try { await reader.cancel(); } catch { /* already closed */ } break; }
      }
    } else {
      const b = new Uint8Array(await r.arrayBuffer());
      chunks.push(b); bytes = b.length;
    }
    const ms = Math.max(1, Math.round(nowMs() - t0));
    return {
      status: r.status, bytes, ms, total: Number.isFinite(declared) && declared > 0 ? declared : bytes,
      kbps: Math.round((bytes / ms) * 1000 / 1024), buf: concatChunks(chunks, bytes),
    };
  } catch {
    return { status: 0, bytes: 0, ms: Math.max(1, Math.round(nowMs() - t0)), total: 0, aborted: true };
  } finally {
    clearTimeout(t);
    signal?.removeEventListener("abort", onAbort);
  }
}

// Descend a playlist to its first segment and measure what the player must hold
// before frame 1: the MEDIA playlist (hls.js downloads it whole — hdvb's is 2.8 MB,
// zetflix's 1.3 MB, and that alone is seconds through the relay) plus the first
// segment's real size, which content-range/content-length declares even though we
// only sample its first bytes. This is the number the old manifest-only probe was
// missing, and the reason a relay stream whose segments trickle (zetflix, 20-26 s
// each) used to pass as "lean and quick".
async function playlistPreroll(text, manifestUrl, { signal, deadline, fast = false, declaredTotal = 0 }) {
  const out = { height: 0, segStatus: null, preroll: 0, segKbps: 0, variantBytes: 0, walkMs: 0 };
  const left = () => Math.min(PROBE_SEG_TIMEOUT, Math.max(0, deadline - nowMs()));
  let mediaText = text, mediaUrl = manifestUrl;
  const vars = parseVariants(text);
  if (vars.length) {
    out.height = Math.max(...vars.map((v) => v.height || 0));
    // hls.js starts on a conservative level (abrEwmaDefaultEstimate 500 kbps), so the
    // LOWEST-bandwidth variant models the first fragment the player will actually pull.
    const lowest = vars.slice().sort((a, b) => (a.bw || Infinity) - (b.bw || Infinity))[0];
    const vUrl = absUrl(manifestUrl, lowest.uri);
    if (!vUrl || !left()) return out;
    const vr = await sampleUrl(vUrl, { sample: PROBE_VARIANT_SAMPLE, timeout: left(), signal });
    out.walkMs += vr.ms || 0;
    if (vr.status >= 400 || !vr.bytes) { out.segStatus = vr.status; return out; }
    out.variantBytes = vr.total;
    mediaText = new TextDecoder().decode(vr.buf);
    mediaUrl = vUrl;
  } else {
    // Already a media playlist: the block hls.js downloads whole is THIS file, and
    // its size is the one the first fetch declared (the sample may have been cut off
    // by the byte cap, so `text.length` would understate a pathological manifest).
    out.variantBytes = declaredTotal || 0;
  }
  const seg = firstSegment(mediaText);
  if (!seg) return out;
  const sUrl = absUrl(mediaUrl, seg.uri);
  if (!sUrl || !left()) return out;
  // FAST mode asks for one byte instead of 48 KB. Both facts the verdict needs
  // survive that: the STATUS (veoveo's manifest is 200/CORS-open while its segments
  // 401 — the whole reason this walk exists) and the segment's FULL size, which
  // content-range declares regardless of how little we requested. What is lost is a
  // throughput reading, and a 48 KB sample was never a trustworthy one anyway —
  // prerollMsFor is dominated by the byte count, which we still have exactly. So the
  // dead-segment guard is kept at one round trip instead of a transfer.
  const sr = await sampleUrl(sUrl, { sample: fast ? 1 : PROBE_SEG_SAMPLE, timeout: left(), signal });
  out.walkMs += sr.ms || 0;
  out.segStatus = sr.status;
  out.preroll = (out.variantBytes || 0) + (sr.total || 0);
  out.segKbps = fast ? 0 : sr.kbps || 0;
  out.segMs = sr.ms;
  out.segBytes = sr.total || 0;
  out.segDur = seg.dur || 0;
  return out;
}

// Pre-roll BYTES are exact (content-range and the mp4 atom chain both declare full
// sizes even when we only sample the first KB); turning them into the seconds a
// viewer waits needs a rate. Measured on this fleet, over transfers large enough to
// be rate- rather than latency-bound: a CORS-open CDN sustains 1.8-3.9 MB/s and the
// relay 0.6-1.2 MB/s. These are deliberately the LOW end — the estimate's job is to
// order candidates, and using one rate per path makes the ordering a comparison of
// byte sizes, which is the part we know exactly.
const RATE_DIRECT_KIBPS = 2048;
const RATE_RELAY_KIBPS = 1024;
// An mp4 whose moov sits after mdat: the browser range-reads the tail and we cannot
// size it from the head. Charge a moderate, non-fatal equivalent rather than 0.
const LATE_MOOV_EQUIV = 2 * 1024 * 1024;
// Time the pre-roll will take: the byte estimate, but never less than the time the
// probe ALREADY spent walking that path (a slow variant fetch is real wait, and on a
// small first segment the probe downloaded the whole thing, so its ms is the truth).
const prerollMsFor = (bytes, direct, observedMs = 0) =>
  Math.max(
    observedMs || 0,
    bytes ? Math.round((bytes / 1024) / (direct ? RATE_DIRECT_KIBPS : RATE_RELAY_KIBPS) * 1000) : 0,
  );

// `fast` trades throughput readings — which never decided anything, because
// prerollMsFor is dominated by the byte count and the byte count is DECLARED
// exactly — for the smallest transfer that still answers the two questions the
// scout actually asks: does this thing serve bytes at all, and how big is the block
// the player must hold before frame 1. In fast mode:
//   • the range request asks for PROBE_MANIFEST_SAMPLE instead of PROBE_BYTE_CAP;
//   • a progressive file stops at PROBE_HEAD_SAMPLE (the atom chain is at the head);
//   • the segment walk fetches ONE byte and reads content-range for the real size.
// Used by the scan, where every byte read is wait the viewer sits through. The
// interactive path can still call the full form.
export async function probeMediaUrl({ url, proxyUrl, headers }, { timeout = PROBE_TIMEOUT, signal = null, onBytes = null, fast = false } = {}) {
  const fail = (reason) => ({ ok: false, kind: null, bytes: 0, ms: 0, kbps: 0, uris: 0, capped: false, direct: false, prerollBytes: 0, prerollMs: 0, reason });
  const play = await playableUrl({ url, proxyUrl, headers }, { preferDirect: true, signal });
  if (!play?.url) return fail("no-url");
  if (signal?.aborted) return fail("aborted");
  // Whether the RESOLVED media plays without the relay (CORS-open CDN — the Collaps
  // model). This is the single most predictive speed signal: a direct stream has no
  // relay hop, no Fast-Origin-Transfer variance, and (for a playlist) its segments
  // will ALSO be direct — so a lean direct manifest is trustworthy, while a lean
  // RELAY manifest tells us nothing about how its segments will trickle. viaRelay
  // is false for both a CORS-open CDN and a last-resort third-party direct attempt;
  // either way the bytes we're about to read prove it's reachable direct.
  const direct = !play.viaRelay;
  const readCap = fast ? PROBE_MANIFEST_SAMPLE : PROBE_BYTE_CAP;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  const onAbort = () => ctrl.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  const t0 = nowMs();
  try {
    const r = await fetch(play.url, {
      headers: { range: `bytes=0-${readCap - 1}` },
      signal: ctrl.signal,
      cache: "no-store",
    });
    if (r.status >= 400) return fail("http");
    // How big the WHOLE resource is, per the server. content-range wins because a
    // 206's content-length only describes the slice we asked for. This is how a
    // pathological manifest is detected without reading it: exact, free, and it
    // arrives before the first body byte.
    const cr = r.headers.get("content-range");
    const declaredTotal = (() => {
      const n = cr ? Number(String(cr).split("/")[1]) : Number(r.headers.get("content-length") || 0);
      return Number.isFinite(n) && n > 0 ? n : 0;
    })();
    const classify = (headStr) => {
      if (/^\s*<(?:!doctype|html)/i.test(headStr)) return "html";
      return /#EXTM3U/.test(headStr) ? "playlist" : "media";
    };
    // Streaming read so we can time the transfer and stop at a bounded sample. Older
    // runtimes without a readable body fall back to a single buffered read.
    if (!r.body?.getReader) {
      const buf = new Uint8Array(await r.arrayBuffer());
      if (!buf.length) return fail("empty");
      const kind = classify(new TextDecoder().decode(buf.slice(0, 128)));
      if (kind === "html") return fail("html");
      const ms = Math.max(1, Math.round(nowMs() - t0));
      const uris = kind === "playlist" ? countPlaylistUris(new TextDecoder().decode(buf)) : 0;
      const mv = kind === "media" ? mp4Preroll(buf) : { pre: null };
      // ponytail: when the atom chain did NOT finish inside the head sample (mv.pre
      // == null) the moov sits past our 32 KB sample. Pretending preroll = 0 was
      // the path that fire-greened vkmovie / cdnvideohub whose true moov is multi-MB
      // — the player would start, freeze on the moov transfer, and from the UI look
      // exactly like "не грузит видео". Floor at LATE_MOOV_EQUIV so the verdict
      // competes on score at the decision deadline instead of firing instantly.
      const pre = mv.pre == null ? LATE_MOOV_EQUIV : mv.late ? LATE_MOOV_EQUIV : mv.pre;
      return { ok: true, kind, bytes: buf.length, ms, kbps: Math.round((buf.length / ms) * 1000 / 1024), uris, capped: false, direct,
               prerollBytes: pre, prerollMs: prerollMsFor(pre, direct), reason: "buffered" };
    }
    const reader = r.body.getReader();
    const chunks = [];
    let bytes = 0;
    let kind = null;
    const cancel = async () => { try { await reader.cancel(); } catch { /* already closed */ } };
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value?.length) continue;
      chunks.push(value);
      bytes += value.length;
      if (kind === null) {
        kind = classify(new TextDecoder().decode(chunks[0].slice(0, 128)));
        if (kind === "html") { await cancel(); return fail("html"); }
        // The upstream is streaming real media/manifest bytes: whatever deadline the
        // caller set for "this balancer might be hung" no longer applies. The scout
        // uses this to grant one bounded extension rather than aborting a probe that
        // is milliseconds from passing (see PROBE_GRACE_MS).
        try { onBytes?.(kind); } catch { /* a caller's hook must never break a probe */ }
      }
      // A playlist we read up to the cap (fast mode's cap is small — everything the
      // verdict needs is at the top); a media body we only need enough of to walk its
      // atom chain (fast) or to time (full). The read is on the viewer's critical
      // path, so every byte past "this really serves media" is pure added wait.
      const sample = kind === "playlist"
        ? readCap
        : fast ? PROBE_HEAD_SAMPLE : direct ? PROBE_DIRECT_SAMPLE : PROBE_MEDIA_SAMPLE;
      if (bytes >= sample) { await cancel(); break; }
    }
    const ms = Math.max(1, Math.round(nowMs() - t0));
    if (!bytes) return fail("empty");
    const kbps = Math.round((bytes / ms) * 1000 / 1024);
    const buf = concatChunks(chunks, bytes);
    if (kind === "playlist") {
      const text = new TextDecoder().decode(buf);
      const uris = countPlaylistUris(text);
      // Descend one level and size the first segment: the block the player must hold
      // before frame 1. Two fetches at most, both bounded and abortable, and they buy
      // the one thing a manifest read cannot tell us — whether the SEGMENT path is
      // alive (veoveo's manifest is 200/CORS-open while its segments 401).
      const pr = await playlistPreroll(text, play.url, { signal, deadline: t0 + timeout, fast, declaredTotal });
      if (pr.segStatus === 0) return fail("segment-timeout");
      if (pr.segStatus != null && pr.segStatus >= 400) return fail("segment-" + pr.segStatus);
      return {
        ok: true, kind, bytes, ms, kbps, uris, capped: bytes >= readCap, direct,
        // A manifest the player must download WHOLE counts toward the pre-roll, and
        // its size is declared rather than sampled — so a 1.3 MB master is scored as
        // 1.3 MB even though only 64 KB of it was read.
        manifestBytes: declaredTotal || bytes,
        prerollBytes: pr.preroll, prerollMs: prerollMsFor(pr.preroll, direct, pr.walkMs),
        segKbps: pr.segKbps, segMs: pr.segMs || 0, segDur: pr.segDur || 0, segBytes: pr.segBytes || 0,
        segStatus: pr.segStatus,
        height: pr.height || 0, reason: "playlist",
      };
    }
    // Progressive file: everything before `mdat` must land before frame 1, and its
    // size is declared in the atom chain we just read. If the chain did not finish
    // inside our 32 KB head (mp4Preroll returned null — vkmovie's 8 MB-moov and
    // cdnvideohub's heavy moov both hit this), charge LATE_MOOV_EQUIV as a floor:
    // pretending preroll = 0 would make the scout instant-fire the probe and
    // stall the player seconds later when the real moov arrives (the "не грузит
    // видео" symptom on those balancers).
    const mv = mp4Preroll(buf);
    const preroll = mv.pre == null ? LATE_MOOV_EQUIV : mv.late ? LATE_MOOV_EQUIV : mv.pre;
    return {
      ok: true, kind: "media", bytes, ms, kbps, uris: 0, capped: false, direct,
      prerollBytes: preroll, prerollMs: prerollMsFor(preroll, direct),
      lateMoov: !!mv.late, reason: "media",
    };
  } catch {
    return fail(signal?.aborted || ctrl.signal.aborted ? "aborted" : "err");
  } finally {
    clearTimeout(t);
    signal?.removeEventListener("abort", onAbort);
  }
}

// ------------------------------------------------------------- transfer counter
//
// Vercel Hobby's Fast Origin Transfer (~10 GB/mo) binds long before the 100 GB
// bandwidth allowance, and it is shared with /api/tmdb and /api/room, so an
// unchecked relay takes the whole site down. There is no server-side counter
// available (the Upstash vars are empty), so account for it in the browser: it
// cannot be authoritative, but it is enough to warn and to stop defaulting to
// 2160p once the month is mostly spent.

const LS_BYTES = "lampac_bytes";
export const RELAY_SOFT_LIMIT = 6 * 1024 * 1024 * 1024;
export const RELAY_HARD_LIMIT = 9 * 1024 * 1024 * 1024;

const monthKey = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};

export function relayBytes() {
  const raw = storage.get(LS_BYTES);
  if (!raw || raw.month !== monthKey()) return { month: monthKey(), bytes: 0 };
  return { month: raw.month, bytes: Number(raw.bytes) || 0 };
}

export function addRelayBytes(n) {
  const cur = relayBytes();
  const next = { month: cur.month, bytes: cur.bytes + Math.max(0, Number(n) || 0) };
  storage.set(LS_BYTES, next);
  return next.bytes;
}

// "how constrained are we right now" — drives the quality cap and the banner.
export function relayBudget() {
  const { bytes } = relayBytes();
  return {
    bytes,
    warn: bytes >= RELAY_SOFT_LIMIT,
    directOnly: bytes >= RELAY_HARD_LIMIT,
  };
}
