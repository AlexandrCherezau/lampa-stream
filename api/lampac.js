// Vercel serverless relay for the Lampac balancer fleet (source "lampac").
//
// Why this exists: the fleet lives on *.nip.io hosts that hard-403 any request
// carrying a foreign Origin or Referer (verified on .m3u8/.ts/.mp4 alike, and on
// the OPTIONS preflight too). A browser can therefore never fetch them directly,
// while a server can — the tokens are content-derived and NOT IP-bound, so a URL
// minted for one egress works from another.
//
// Security model (this file is reachable by anyone, so it must not become an
// SSRF gadget):
//   * Every resolved address is checked against loopback/private/link-local/
//     CGNAT/multicast/ULA, and the socket connects to the VALIDATED address with
//     SNI set to the hostname, so DNS cannot be re-pointed after the check.
//     (This — not the old host allow-list — is what makes 127.0.0.1.nip.io-style
//     tricks unreachable: the name may say anything, the address is what counts.)
//   * Redirects are followed manually, re-validating each hop.
//   * Only range/accept/accept-language/user-agent cross from the client, so
//     the visitor's TMDB Authorization header can never be replayed upstream.
//
// Deliberately NOT restricted: which hosts may be proxied. The relay forwards
// any http(s) URL it is handed — fleet hosts and third-party CDNs alike. An
// allow-list (exact fleet match + HMAC-signed exceptions) used to gate this, and
// it broke playback outright: every third-party CDN (cdnsqu.com and friends)
// 403'd "host not allowed" whenever LAMPAC_PROXY_SECRET wasn't set on the
// deployment, and those CDNs send no ACAO header, so the browser could not
// fetch them directly either — one missing env var turned the film into a black
// screen. The trade-off is accepted knowingly: this is a bandwidth relay, and
// the private-address check above is what keeps it from being pointed at the
// deployment's own infrastructure.
import https from "node:https";
import http from "node:http";
import dns from "node:dns/promises";
import net from "node:net";
import crypto from "node:crypto";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

const HOSTS_URL = "https://api-m.vi3000.top/api/plugin/lampac/hosts";
const CONTROL_HOSTS = new Set(["api-m.vi3000.top"]);
// Used until the live list answers, and whenever it fails. Keep this in sync
// with the frontend fallback in src/utils/lampac-browser.js. The fleet rotates; when
// it does, the live HOSTS_URL refreshes this cache on the next request, but a
// freshly-deployed cold start with a dead upstream would otherwise pin us to
// the old set and silently 502 every relay. Bump this when the live list does.
const FALLBACK_HOSTS = [
  "138-16-177-21.nip.io",
  "62-113-116-188.nip.io",
  "138-16-174-90.nip.io",
];

const HOSTS_TTL_MS = 10 * 60 * 1000;
// Largest window we will ever relay when the client did NOT name an end.
// Doubles as the accounting quantum for the Vercel transfer quota and keeps
// progressive mp4/mkv from running into maxDuration mid-body.
const RANGE_WINDOW = 8 * 1024 * 1024;
// Ceiling for a range the CLIENT explicitly asked for. The native mp4 attach
// path asks `bytes=0-34M` to pull a 34 MB moov in one request; clamping that
// to RANGE_WINDOW forced 4 extra sequential serverless round trips — each a
// fresh invocation re-entering liveHosts() — before frame 1 (the app measured
// 8.7-12.5 s to first frame on those titles). A range that names its end is
// the media element saying exactly what it needs; the accounting cap only has
// to bound the OPEN-ENDED case (a bare `bytes=N-`, "just start sending").
const RANGE_MAX_EXPLICIT = 96 * 1024 * 1024;
const PLAYLIST_MAX = 8 * 1024 * 1024;
// Deadline on the upstream RESPONSE HEADERS. Sized from measurement: a healthy
// hop1 answers in 98-2131 ms across the fleet (worst legitimate observation:
// vkmovie 2131 ms) and a healthy `call` hop in 571-725 ms, so 6 s is a ~3x margin
// over anything that has ever succeeded. It was 20 s, which protected nothing —
// the balancers that need longer never answer at all (vibix / kinogo / uakino 502
// at ~20 s on every title) and each one held a serverless invocation, and one of
// the browser's six connections, for the full twenty seconds before failing.
const HEADERS_TIMEOUT_MS = 6000;
const DNS_TIMEOUT_MS = 4000;
const IDLE_TIMEOUT_MS = 60000;
const SIG_TTL_S = 12 * 3600;
const MAX_HOPS = 5;

const b64u = (s) => Buffer.from(s, "utf8").toString("base64url");
const unb64u = (s) => Buffer.from(String(s), "base64url").toString("utf8");

// ---------------------------------------------------------------- fleet list

let hostsCache = { at: 0, list: FALLBACK_HOSTS.slice() };
// Per-host black-box timestamp of the last EGRESS failure from this Vercel
// region. liveHosts() skips a host while it is in the "dead" window — a
// filtered fleet host that passes the discovery endpoint but is throttled at
// the network edge (a Cloudflare rule against Vercel's egress range is the
// common case) would otherwise pin every relay to a 6-second header timeout
// for the entire TTL. Without this, "грузит, загружается, опять грузить" is
// the only thing the viewer sees until a new fleet is announced.
const DEAD_HOST_TTL_MS = 5 * 60 * 1000;
const HOST_PROBE_TIMEOUT_MS = 4000;
// Cache-aside over the cold-start fleet probe. A previous probe's `ok` verdict
// stays good for an hour — without this, every cold-cache `liveHosts()` would
// eat the relay's first 4 s per host again on the next deploy. The probe is
// already gated by `DEAD_HOST_TTL_MS` for FAILURES, so a genuinely bad host
// still gets re-tested in minutes; this only skips re-testing hosts that
// already answered yes recently.
const HOST_OK_TTL_MS = 60 * 60 * 1000;
const hostOk = new Map(); // host → ts at which the verdict expires
const deadHosts = new Map(); // host → ts at which it may be reconsidered

// Head-probe a single fleet host from THIS Vercel function's egress and decide
// if it is reachable. A 4-second deadline (smaller than HEADERS_TIMEOUT_MS=6000)
// keeps the discovery budget bounded; the request body is discarded — we only
// need to know the headers come back. Any 2xx / 3xx / 4xx is "alive": the
// balancers return 4xx on a missing title, not 0-byte timeouts.
async function probeHostFromVercel(host) {
  const url = `https://${host}/lite/events?title=__probe__&year=2000&serial=0&rjson=true`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), HOST_PROBE_TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: ctrl.signal, redirect: "manual" });
    return r.status > 0 && r.status < 600;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

let hostsRefreshing = false;

// Background fleet-list refresh. The old liveHosts() ran this INLINE: a cold
// (or TTL-expired) cache paid a 6 s HOSTS_URL fetch plus a parallel per-host
// probe fan-out BEFORE opening the upstream socket, so the first request of
// every fresh isolate saw nothing for up to ~10 s — and the browser's probe
// deadline aborted long before that, wasting the whole invocation. Module
// scope outlives the invocation, so we now serve the cached/fallback list
// immediately and refresh behind it; the next request gets the fresh list.
async function refreshHosts() {
  let list = null;
  try {
    const r = await fetch(HOSTS_URL, { signal: AbortSignal.timeout(6000) });
    const j = await r.json();
    list = (Array.isArray(j?.hosts) ? j.hosts : [])
      .map((h) => String(h).trim().toLowerCase())
      .filter((h) => /^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(h));
  } catch {
    /* fall through to whatever we already had */
  }
  let next = list?.length ? list : hostsCache.list;
  // Per-host egress probe — fire all in parallel so the budget is one round-trip,
  // not 5×HEADERS_TIMEOUT_MS. Hosts that pass today get the live list; hosts
  // that fail (or that are in the dead-host window) are kept out of the
  // returned list so the browser never races to a black hole. Any host that
  // survives the probe is the keeper; the rest of the fleet is also discarded
  // from the public list — keeping them on the menu would put the viewer back
  // on a per-request 6-second timeout when the picked host happens to wedge.
  const now = Date.now();
  const verdicts = await Promise.all(next.map(async (h) => {
    const deadUntil = deadHosts.get(h) || 0;
    if (deadUntil > now) return { h, ok: false, reason: "recently-dead" };
    const okUntil = hostOk.get(h) || 0;
    if (okUntil > now) return { h, ok: true, reason: "cached" };
    const ok = await probeHostFromVercel(h);
    return { h, ok };
  }));
  const live = [];
  for (const v of verdicts) {
    if (v.ok) live.push(v.h);
    else deadHosts.set(v.h, now + DEAD_HOST_TTL_MS);
  }
  // Stamp successful probes so the next deploy's cold cache doesn't repeat
  // them. A failed probe isn't cached here (deadHosts owns that).
  for (const v of verdicts) {
    if (v.ok && v.reason !== "cached") hostOk.set(v.h, now + HOST_OK_TTL_MS);
  }
  if (!live.length) {
    // All probes failed — keep the previous list (better a known-slow fleet
    // than nothing) and re-try on the next TTL window. The dead-window keys
    // still expire so we'll re-probe them naturally.
    live.push(...hostsCache.list);
  }
  // Stamp the time even on failure: retry on the next TTL window, not on every
  // request (a dead discovery endpoint would otherwise add 6s to each relay).
  hostsCache = { at: Date.now(), list: live };
}

async function liveHosts() {
  if (Date.now() - hostsCache.at < HOSTS_TTL_MS) return hostsCache.list;
  if (!hostsRefreshing) {
    hostsRefreshing = true;
    refreshHosts()
      .catch(() => {})
      .finally(() => { hostsRefreshing = false; });
  }
  // Serve what we have right now; the refresh lands for the next invocation.
  return hostsCache.list;
}

// ------------------------------------------------------------ address safety

function isPublicIp(ip) {
  const ver = net.isIP(ip);
  if (ver === 4) {
    const p = ip.split(".").map(Number);
    const [a, b] = p;
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 169 && b === 254) return false;             // link-local / IMDS
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 192 && b === 0) return false;               // 192.0.0/24, TEST-NET-1
    if (a === 100 && b >= 64 && b <= 127) return false;   // CGNAT
    if (a >= 224) return false;                           // multicast + reserved
    return true;
  }
  if (ver === 6) {
    const s = ip.toLowerCase();
    if (s === "::" || s === "::1") return false;
    const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPublicIp(mapped[1]);
    if (/^fe[89ab]/.test(s)) return false;                // fe80::/10
    if (/^f[cd]/.test(s)) return false;                   // fc00::/7 ULA
    if (s.startsWith("ff")) return false;                 // multicast
    return true;
  }
  return false;
}

async function resolveTarget(target) {
  const host = target.hostname.toLowerCase();
  // A literal IP in the URL never goes through DNS, so validate it as-is.
  if (net.isIP(host)) {
    if (!isPublicIp(host)) throw new Error("blocked address");
    return { ip: host, family: net.isIP(host) };
  }
  // nip.io encodes the address in its hostname; known fleet nodes need no DNS round trip.
  const embedded = hostsCache.list.includes(host) && host.match(/^(\d{1,3}-\d{1,3}-\d{1,3}-\d{1,3})\.nip\.io$/);
  if (embedded) {
    const ip = embedded[1].replaceAll("-", ".");
    if (net.isIP(ip) !== 4 || !isPublicIp(ip)) throw new Error("blocked address");
    return { ip, family: 4 };
  }
  let addrs;
  let timer;
  try {
    addrs = await Promise.race([
      dns.lookup(host, { all: true, verbatim: true }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("dns timeout")), DNS_TIMEOUT_MS); }),
    ]);
  } catch {
    throw new Error("dns");
  } finally {
    clearTimeout(timer);
  }
  // Reject if ANY address is private: a host that resolves to both a public and
  // a private address is a rebinding attempt, not a legitimate CDN.
  if (!addrs.length || addrs.some((a) => !isPublicIp(a.address))) throw new Error("blocked address");
  return { ip: addrs[0].address, family: addrs[0].family };
}

// ------------------------------------------------------------------ signature

function hmacKey() {
  return process.env.LAMPAC_PROXY_SECRET || "";
}

function sign(u, h, exp) {
  return crypto.createHmac("sha256", hmacKey()).update(`${u}|${h || ""}|${exp}`).digest("base64url");
}

// Builds the relative self-URL for a child resource. EVERY child URL now routes
// through the relay, signed or not. The old shape returned null for any host we
// couldn't "vouch for" (no LAMPAC_PROXY_SECRET configured → no signature), which
// left the original CDN URL in the playlist for the browser to fetch directly —
// and a CDN that doesn't send ACAO then failed with a CORS error instead of a
// playable stream. That vouch-or-die path is gone: the relay proxies whatever
// the fleet hands out, which is what makes third-party CDNs (cdnsqu.com and
// friends) work with no secret configured at all. Signing still happens when a
// secret IS set (the URLs stay self-describing), it's just no longer required.
function selfUrl(absUrl, hdrB64) {
  try { new URL(absUrl); } catch { return null; } // only absolute URLs are relayable
  const q = new URLSearchParams({ u: b64u(absUrl) });
  if (hdrB64) q.set("h", hdrB64);
  if (hmacKey()) {
    const exp = String(Math.floor(Date.now() / 1000) + SIG_TTL_S);
    q.set("exp", exp);
    q.set("sig", sign(b64u(absUrl), hdrB64 || "", exp));
  }
  return `/api/lampac?${q}`;
}

// ------------------------------------------------------------------- upstream

// Only these client headers reach the upstream. An allow-list (rather than a
// deny-list) guarantees Authorization never leaks: in this project that header
// carries the visitor's own TMDB read token.
const CLIENT_HEADERS = ["range", "accept", "accept-language", "user-agent"];

function requestOnce(target, headers, method, pinned, clientRes) {
  const mod = target.protocol === "http:" ? http : https;
  return new Promise((resolve, reject) => {
    const req = mod.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === "http:" ? 80 : 443),
        path: target.pathname + target.search,
        method,
        headers: { ...headers, host: target.host },
        servername: net.isIP(target.hostname) ? undefined : target.hostname,
        // Connect to the address we already validated. Without this the OS would
        // resolve the name a second time and could get a different (private) answer.
        lookup: (_h, opts, cb) =>
          (opts && opts.all ? cb(null, [{ address: pinned.ip, family: pinned.family }]) : cb(null, pinned.ip, pinned.family)),
      },
      (res) => {
        clearTimeout(timer);
        if (clientRes) clientRes.off("close", onClientGone);
        resolve(res);
      },
    );
    // Deadline on the HEADERS only. A deadline covering the whole response would
    // abort the video body mid-stream (v1 did exactly that: TimeoutError thrown
    // from a already-returned handler -> 500 + container recycle).
    const timer = setTimeout(() => {
      req.destroy(new Error("headers timeout"));
    }, HEADERS_TIMEOUT_MS);
    // The body path already tears down when the viewer seeks away (see the pipe
    // below). This is the same rule for the phase BEFORE any byte arrives, and it
    // is the more expensive phase to leak: the scout aborts probes constantly (a
    // tightened cap, a winner appearing, a title switch), and without this the
    // upstream socket lived until the headers deadline regardless. Measured with
    // `ss -tnp`: three probes aborted by the client at t=1293 ms kept their
    // upstream connections open until t≈21.7 s — on Vercel that is a paid
    // invocation per abandoned probe, for the full timeout, every single time.
    const onClientGone = () => {
      clearTimeout(timer);
      req.destroy(new Error("client gone"));
    };
    if (clientRes) clientRes.once("close", onClientGone);
    req.on("error", (e) => {
      clearTimeout(timer);
      if (clientRes) clientRes.off("close", onClientGone);
      reject(e);
    });
    req.end();
  });
}

// Manual redirect following: `redirect: "follow"` would jump to an unvalidated
// host behind our back. pidtor relies on this (302 -> /ts/stream).
// Every hop is proxied unconditionally (no host allow-list) — the only address
// rule that remains is resolveTarget's private-IP rejection, which keeps the
// relay from being pointed at the deployment's own infrastructure.
function isFleetMediaUrl(target) {
  const host = target.hostname.toLowerCase();
  const knownFleet = hostsCache.list.includes(host) && /^\d{1,3}-\d{1,3}-\d{1,3}-\d{1,3}\.nip\.io$/.test(host);
  if (!knownFleet) return false;
  return target.searchParams.get("play") === "true" || /\.(?:m3u8|mp4)$/i.test(target.pathname);
}

export async function openUpstream(startUrl, headers, method, clientRes) {
  let target = startUrl;
  const triedFleetHosts = new Set([target.hostname.toLowerCase()]);
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    // A client that left mid-descent must not start another hop. Without this a
    // 5-hop redirect chain keeps opening sockets for a response nobody will read.
    if (clientRes?.destroyed) {
      throw Object.assign(new Error("client gone"), { status: 499 });
    }
    const pinned = await resolveTarget(target);
    let res = await requestOnce(target, headers, method, pinned, clientRes);
    // A balancer can mark one fleet node unavailable while a sibling serves
    // the same content URL. Retry only first-hop media URLs known to this
    // fleet, and only on an explicit upstream 5xx. Each sibling goes through
    // resolveTarget/requestOnce again, retaining address validation and TLS SNI.
    if (hop === 0 && res.statusCode >= 500 && isFleetMediaUrl(target)) {
      let lastRetryError;
      for (const host of hostsCache.list) {
        if (clientRes?.destroyed) {
          throw Object.assign(new Error("client gone"), { status: 499 });
        }
        const sibling = host.toLowerCase();
        if (triedFleetHosts.has(sibling)) continue;
        triedFleetHosts.add(sibling);
        const retryTarget = new URL(target);
        retryTarget.hostname = sibling;
        if (res) res.resume();
        res = null;
        try {
          const retryPinned = await resolveTarget(retryTarget);
          res = await requestOnce(retryTarget, headers, method, retryPinned, clientRes);
          target = retryTarget;
        } catch (error) {
          if (clientRes?.destroyed || error?.status === 499 || error?.message === "client gone") {
            throw Object.assign(new Error("client gone"), { status: 499 });
          }
          lastRetryError = error;
          continue;
        }
        if (res.statusCode < 500) {
          break;
        }
      }
      if (!res) throw lastRetryError || Object.assign(new Error("upstream retry failed"), { status: 502 });
    }
    const loc = res.headers.location;
    if (res.statusCode >= 300 && res.statusCode < 400 && loc) {
      res.resume();
      let next;
      try { next = new URL(loc, target); } catch { throw Object.assign(new Error("bad redirect"), { status: 502 }); }
      if (next.protocol !== "http:" && next.protocol !== "https:") {
        throw Object.assign(new Error("bad redirect proto"), { status: 502 });
      }
      target = next;
      continue;
    }
    return { res, finalUrl: target };
  }
  throw Object.assign(new Error("too many redirects"), { status: 502 });
}

// -------------------------------------------------------------- body rewrites

// Lampac hands out header blobs in two shapes: a real object (rjson=true) and a
// python-dict string ("{'Origin': 'https://vkvideo.ru'}").
function parseHdr(raw) {
  if (!raw) return {};
  if (typeof raw === "object") return raw;
  try {
    const j = JSON.parse(raw);
    if (j && typeof j === "object") return j;
  } catch { /* python dict below */ }
  const out = {};
  const re = /'([^']+)'\s*:\s*'([^']*)'/g;
  let m;
  while ((m = re.exec(raw))) out[m[1]] = m[2];
  return out;
}

// Rewrites one complete chunk of playlist text (all lines end with \n, or the
// chunk is the final carry) — the shared core behind the streaming path.
function rewriteM3u8Text(text, baseUrl, hdrB64) {
  const abs = (u) => {
    try { return new URL(u, baseUrl).toString(); } catch { return null; }
  };
  const map = (u) => {
    const a = abs(u);
    if (!a) return u;
    return selfUrl(a, hdrB64) || a;
  };
  return text
    .split("\n")
    .map((raw) => {
      const line = raw.trimEnd();
      if (!line) return line;
      if (line[0] === "#") return line.replace(/URI="([^"]+)"/g, (_m, u) => `URI="${map(u)}"`);
      return map(line);
    })
    .join("\n");
}

// Keys whose string values are playable/fetchable URLs in Lampac's rjson output.
const URL_KEYS = new Set(["url", "stream", "link", "manifest", "subtitle"]);

// Walks a balancer JSON and adds a `<key>_p` sibling holding the relayed form
// of each URL. Every URL is relayable — no host vetting, no signature needed.
function annotateJson(node, hdrB64, depth = 0) {
  if (!node || depth > 12) return node;
  if (Array.isArray(node)) {
    node.forEach((v) => annotateJson(v, hdrB64, depth + 1));
    return node;
  }
  if (typeof node !== "object") return node;
  const localHdr = node.headers ? b64u(JSON.stringify(parseHdr(node.headers))) : hdrB64;
  for (const [k, v] of Object.entries(node)) {
    if (typeof v === "string" && /^https?:\/\//i.test(v) && URL_KEYS.has(k)) {
      const p = selfUrl(v, localHdr);
      if (p) node[`${k}_p`] = p;
    } else if (v && typeof v === "object") {
      // quality / mp4quality are label -> URL dictionaries, not nested items.
      if ((k === "quality" || k === "mp4quality") && !Array.isArray(v)) {
        const out = {};
        for (const [label, qu] of Object.entries(v)) {
          if (typeof qu !== "string" || !/^https?:\/\//i.test(qu)) continue;
          const p = selfUrl(qu, localHdr);
          if (p) out[label] = p;
        }
        if (Object.keys(out).length) node[`${k}_p`] = out;
      } else {
        annotateJson(v, localHdr, depth + 1);
      }
    }
  }
  return node;
}

// --------------------------------------------------------------------- handler

function clampRange(raw) {
  if (!raw) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(raw).trim());
  if (!m) return null;
  if (m[1] === "") return raw;                       // suffix range, pass through
  const start = Number(m[1]);
  // Open-ended: cap the window (accounting + maxDuration safety).
  if (m[2] === "") return `bytes=${start}-${start + RANGE_WINDOW - 1}`;
  // Explicit end: honor it (the media element knows what it needs — a big
  // moov must arrive in ONE round trip, not one per RANGE_WINDOW), bounded
  // only by the hard ceiling above.
  const end = Math.min(Number(m[2]), start + RANGE_MAX_EXPLICIT - 1);
  return `bytes=${start}-${end}`;
}

function readAll(stream, limit) {
  if (stream.readableEnded) return Promise.resolve(Buffer.alloc(0));
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    stream.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        stream.destroy();
        reject(new Error("body too large"));
        return;
      }
      chunks.push(c);
    });
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });
}

// Reads up to `n` bytes off the stream and hands them back WITHOUT consuming
// the rest — the stream is paused, so the caller can keep piping it. Returns
// null when the body exceeds `limit` (the caller answers 502). Used to sniff
// #EXTM3U before deciding between the streaming and buffered paths.
function peekHead(stream, n, limit) {
  if (stream.readableEnded) return Promise.resolve(Buffer.alloc(0));
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      stream.off("data", onData);
      stream.off("end", onEnd);
      stream.off("error", onErr);
      stream.pause();
      resolve(Buffer.concat(chunks));
    };
    const onData = (c) => {
      size += c.length;
      if (size > limit) {
        if (done) return;
        done = true;
        stream.off("data", onData);
        stream.off("end", onEnd);
        stream.off("error", onErr);
        stream.destroy();
        resolve(null);
        return;
      }
      chunks.push(c);
      if (size >= n) finish();
    };
    const onEnd = finish;
    const onErr = (e) => {
      if (done) return;
      done = true;
      reject(e);
    };
    stream.on("data", onData);
    stream.on("end", onEnd);
    stream.on("error", onErr);
    stream.resume();
  });
}

// Rewrites an m3u8 body to the client while it streams through: complete lines
// are rewritten and flushed the moment they arrive, a partial trailing line is
// carried until its newline shows up. `head` is the already-consumed peek (it
// belongs to the body, not to anything else). The client-gone and idle
// teardowns mirror the binary path below — an abandoned probe must not keep
// pulling upstream bytes.
export function streamRewriteM3u8(up, res, head, baseUrl, hdrB64) {
  let carry = head.toString("utf8");
  let size = head.length;
  const flushLines = (final) => {
    if (!final) {
      const nl = carry.lastIndexOf("\n");
      if (nl < 0) return;
      const ready = carry.slice(0, nl + 1);
      carry = carry.slice(nl + 1);
      res.write(rewriteM3u8Text(ready, baseUrl, hdrB64));
      return;
    }
    if (carry) res.write(rewriteM3u8Text(carry, baseUrl, hdrB64));
    carry = "";
  };
  const stop = () => {
    cleanup();
    up.destroy();
    res.end();
  };
  const cleanup = () => {
    up.off("data", onData);
    up.off("end", onEnd);
    up.off("error", onErr);
    res.off("close", stop);
  };
  const onData = (c) => {
    size += c.length;
    if (size > PLAYLIST_MAX) { stop(); return; }
    carry += c.toString("utf8");
    flushLines(false);
  };
  const onEnd = () => {
    flushLines(true);
    cleanup();
    res.end();
  };
  const onErr = () => {
    cleanup();
    res.destroy();
  };
  res.on("close", stop);
  if (up.readableEnded) {
    flushLines(true);
    cleanup();
    res.end();
    return;
  }
  if (up.socket) up.setTimeout(IDLE_TIMEOUT_MS, stop);
  up.on("data", onData);
  up.on("end", onEnd);
  up.on("error", onErr);
  up.resume();
}

export default async function handler(req, res) {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "*");
  res.setHeader("access-control-expose-headers", "content-length, content-range, accept-ranges");
  res.setHeader("cache-control", "no-store");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET" && req.method !== "HEAD") return res.status(405).json({ error: "method" });

  const q = new URL(req.url, "http://x").searchParams;
  const uRaw = q.get("u");
  if (!uRaw) return res.status(400).json({ error: "missing u" });

  let target;
  try {
    target = new URL(unb64u(uRaw));
  } catch {
    return res.status(400).json({ error: "bad u" });
  }
  if (target.protocol !== "https:" && target.protocol !== "http:") {
    return res.status(400).json({ error: "bad proto" });
  }

  const hdrB64 = q.get("h") || "";
  const hosts = new Set(await liveHosts());
  const targetHost = target.hostname.toLowerCase();
  const isFleet = hosts.has(targetHost) || CONTROL_HOSTS.has(targetHost);

  // NO host allow-list on purpose. The relay proxies whatever URL the fleet
  // handed out: fleet hosts, third-party CDNs (cdnsqu.com and friends), all of
  // it, signed or not. The previous `!isFleet && !signedOk → 403 host not
  // allowed` gate hard-failed every third-party CDN whenever
  // LAMPAC_PROXY_SECRET wasn't configured on the deployment — and those CDNs
  // are exactly the ones that send no ACAO header, so the browser could not
  // fetch them directly either. One config value stood between the viewer and
  // a black screen. The remaining guards are unchanged: private/link-local
  // address rejection (resolveTarget), the header allow-list, and the
  // per-request range clamp.

  const fwd = {};
  for (const k of CLIENT_HEADERS) {
    const v = req.headers[k];
    if (typeof v === "string" && v) fwd[k] = v;
  }
  const clamped = clampRange(fwd.range);
  if (clamped) fwd.range = clamped;
  // undici/node would otherwise negotiate gzip and hand us a decompressed body
  // while content-length still describes the compressed one -> truncated JSON.
  fwd["accept-encoding"] = "identity";
  // Item headers (e.g. Origin: https://vkvideo.ru) are meant for the CDN. The
  // fleet itself 403s on any foreign Origin, so never replay them there.
  if (!isFleet) Object.assign(fwd, parseHdr(hdrB64 ? unb64u(hdrB64) : ""));

  let up, finalUrl;
  try {
    ({ res: up, finalUrl } = await openUpstream(target, fwd, req.method, res));
  } catch (e) {
    const code = e?.status || 502;
    // The client is already gone; writing a status would only throw. Just stop.
    if (code === 499 || e?.message === "client gone") return;
    return res.status(code).json({ error: "upstream", message: String(e?.message || e).slice(0, 200) });
  }

  const ct = up.headers["content-type"] || "";
  const wantJson = q.get("json") === "1" || /json/i.test(ct);
  const maybeText = wantJson || /mpegurl|text\/plain/i.test(ct) || /\.m3u8(\?|$)/i.test(finalUrl.pathname + finalUrl.search);

  if (maybeText && req.method !== "HEAD") {
    // ── Streaming m3u8 path ──────────────────────────────────────────────────
    // Peek the head of the body, and if it is a playlist, rewrite it LINE BY
    // LINE while the bytes are still arriving. The old shape buffered the
    // whole manifest first (readAll) — zetflix's is 1.3 MB / 1701 URIs, so
    // hls.js waited for the entire transfer plus the full rewrite before it
    // saw byte one. The player only needs the #EXTM3U header and the first
    // variant lines to start, so each completed line is flushed immediately.
    const head = await peekHead(up, 64, PLAYLIST_MAX);
    if (head === null) {
      if (!res.headersSent) res.status(502).json({ error: "body", message: "body too large" });
      return;
    }
    let sniff = head.toString("utf8");
    if (sniff.charCodeAt(0) === 0xfeff) sniff = sniff.slice(1); // strip a UTF-8 BOM
    if (/^\s*#EXTM3U/.test(sniff)) {
      res.status(up.statusCode || 200);
      res.setHeader("content-type", "application/vnd.apple.mpegurl");
      // The playlist is a pure function of the request URL (u/h are baked in),
      // so it is shareable across visitors: 60 s browser / 5 min edge with a
      // 10 min stale window. Signed `_p` children carry a 12 h expiry, well
      // clear of any of these TTLs. Never cache an upstream failure.
      if ((up.statusCode || 200) === 200) {
        res.setHeader("cache-control", "public, max-age=60, s-maxage=300, stale-while-revalidate=600");
      } else {
        res.setHeader("cache-control", "no-store");
      }
      streamRewriteM3u8(up, res, head, finalUrl.toString(), hdrB64);
      return;
    }
    // ── Buffered path (JSON / anything else) ────────────────────────────────
    // peekHead left the stream paused; resume it explicitly so the read below
    // never depends on Node's attach-a-data-listener-resumes behavior.
    let buf;
    try {
      const tail = readAll(up, PLAYLIST_MAX - head.length);
      up.resume();
      buf = Buffer.concat([head, await tail]);
    } catch (e) {
      if (!res.headersSent) res.status(502).json({ error: "body", message: String(e?.message || e).slice(0, 120) });
      return;
    }
    let text = buf.toString("utf8");
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

    if (wantJson) {
      try {
        const json = annotateJson(JSON.parse(text), hdrB64);
        res.status(up.statusCode || 200);
        res.setHeader("content-type", "application/json; charset=utf-8");
        // Balancer JSON is equally shareable: it is the same catalogue payload
        // for every visitor, and the relay's own fleet host list is what varies.
        res.setHeader(
          "cache-control",
          (up.statusCode || 200) === 200
            ? "public, max-age=30, s-maxage=120, stale-while-revalidate=300"
            : "no-store",
        );
        return res.end(JSON.stringify(json));
      } catch {
        // Not JSON after all (kinotochka answers with HTML) — hand it back raw
        // so the client can blacklist the balancer instead of guessing.
      }
    }
    res.status(up.statusCode || 200);
    if (ct) res.setHeader("content-type", ct);
    return res.end(buf);
  }

  res.status(up.statusCode || 200);
  for (const k of ["content-type", "content-range", "accept-ranges", "content-length", "content-disposition"]) {
    const v = up.headers[k];
    if (v) res.setHeader(k, v);
  }
  if (req.method === "HEAD") {
    up.destroy();
    return res.end();
  }

  // A browser that seeks abandons the socket. Without this the upstream keeps
  // pushing bytes we throw away — pure quota burn on every seek.
  const stop = () => up.destroy();
  res.on("close", stop);
  if (up.socket) up.setTimeout(IDLE_TIMEOUT_MS, stop);

  await new Promise((resolve) => {
    up.on("error", () => {
      res.destroy();
      resolve();
    });
    up.on("end", resolve);
    res.on("close", resolve);
    up.pipe(res);
  });
}




