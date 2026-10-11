// ── Watch Together client: transport + playback sync ─────────────────────────
// Rooms live in a shared Upstash Redis. The backend (Vercel api/room.js or
// Express /api/room) holds one JSON snapshot per room; we poll it adaptively and
// apply host→follower playback sync with drift correction. Host-leader model:
// the host's play/pause/seek is authoritative; followers match it. If the host
// leaves, the backend auto-promotes a follower.
//
// Identity/auth: the TMDB token is the per-peer secret, sent as
// `Authorization: Bearer`; peerId = sha256(token). The room `code` is the
// shareable secret. (Same auth model as /api/tmdb.)

import { storage, STORAGE_KEYS } from "./storage";
import { isWebBuild } from "./api";

// Seek only if local vs expected position differs by more than this. 0.5s
// looked "tight" but fought the transport: the host only pushes on
// play/pause/seek, so between pushes the follower's expected position is
// EXTRAPOLATED from play.updatedAt — any clock skew or push latency > 0.5s
// produced a correction twice per second (the 500ms tick), and each correction
// is a real seek, i.e. a re-buffer at the new position. 1.5s is still far
// below what a viewer perceives as desync while letting the extrapolation
// breathe.
const DRIFT_THRESHOLD = 1.5; // seconds
// Minimum spacing between two drift corrections. Without it, a single bad
// push (or a slow network) chained corrections: seek → buffer → still drifted
// → seek again, each one stuttering playback for the follower.
const SEEK_COOLDOWN_MS = 2500;
let _lastSeekAt = 0;

// ── Web Crypto sha256 (hex) — peerId from the WT peer secret ─────────────────
async function sha256Hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function myPeerId(token) {
  if (!token) return null;
  try {
    return await sha256Hex(String(token).trim());
  } catch {
    return null;
  }
}

// ── Per-browser peer secret (the WT Bearer + identity) ──────────────────────
// We use a random per-browser secret as the room `Authorization: Bearer` and as
// the input to myPeerId() — NOT the TMDB token. Two reasons:
//  1. Identity: on the Express web server every visitor shares the SAME TMDB
//     token (handed out by /api/config), so sha256(token) would be identical
//     for all visitors → host-only checks collapse (any visitor could delete or
//     hijack anyone's room) and `who` collapses to a single presence entry. A
//     per-browser random secret gives each visitor a unique peerId on every
//     deployment (Express, Vercel, desktop) and fixes the collapse.
//  2. Security: the TMDB token is no longer sent to /api/room; only the random
//     secret is. The room server only ever sees sha256(secret) as the peerId.
// Persisted in localStorage so a browser keeps a stable identity across reloads
// (a host stays the host of rooms they created); generated synchronously via
// crypto.getRandomValues (available in all renderer/browser contexts).
const WT_PEER_KEY = "lampa_stream_wt_peer";
export function getWtPeerSecret() {
  try {
    let s = localStorage.getItem(WT_PEER_KEY);
    if (!s) {
      const bytes = new Uint8Array(24);
      crypto.getRandomValues(bytes);
      s = Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
      localStorage.setItem(WT_PEER_KEY, s);
    }
    return s;
  } catch {
    return null;
  }
}

// ── /api/room endpoint ───────────────────────────────────────────────────────
// Web → same-origin /api/room (Vercel fn or Express route). Desktop → a
// user-configured WT_ENDPOINT, else a build-time VITE_WATCH_ENDPOINT, else null
// (the UI shows "backend not configured" so the user can set it).
//
// We detect "web" via isWebBuild() (reads window.__webShim at CALL time) AND a
// direct `!window.electron` fallback. isWebBuild() MUST be lazy (a function),
// not a module-load const: api.js is bundled into a chunk that can execute
// BEFORE src/web/shim.js sets window.__webShim, so a const would capture
// `false` and permanently break web detection — Watch Together would show
// "backend not configured" on the website even though the backend is fine.
// Reading at call time (after the shim ran) fixes it. The `!window.electron`
// fallback covers the rare no-shim-at-all case.
export function roomEndpoint() {
  const isWeb =
    isWebBuild() ||
    (typeof window !== "undefined" && !window.electron);
  if (isWeb) return "/api/room";
  let v = storage.get(STORAGE_KEYS.WT_ENDPOINT) || import.meta.env.VITE_WATCH_ENDPOINT || "";
  v = String(v || "").trim().replace(/\/$/, "");
  if (!v) return null;
  if (/\/api\/room\/?$/.test(v)) return v;
  return v.replace(/\/$/, "") + "/api/room";
}

export function setRoomEndpoint(url) {
  const clean = (url || "").trim().replace(/\/$/, "");
  if (clean) storage.set(STORAGE_KEYS.WT_ENDPOINT, clean);
  else storage.remove(STORAGE_KEYS.WT_ENDPOINT);
}

export async function createRoom(token, { name, media } = {}) {
  const ep = roomEndpoint();
  if (!ep) throw new Error("sync endpoint not configured");
  const r = await fetch(ep, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name, media }),
    cache: "no-store",
  });
  if (!r.ok) throw new Error(`create ${r.status}`);
  return r.json(); // { code, room }
}

export async function pollRoom(token, code) {
  const ep = roomEndpoint();
  if (!ep) throw new Error("sync endpoint not configured");
  const r = await fetch(`${ep}?code=${encodeURIComponent(code)}`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!r.ok) throw new Error(`poll ${r.status}`);
  return r.json(); // { room } | { room: null }
}

export async function hostPushPlay(token, code, { playing, position }) {
  const ep = roomEndpoint();
  const r = await fetch(`${ep}?code=${encodeURIComponent(code)}&op=play`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ playing, position }),
    cache: "no-store",
    keepalive: true,
  });
  return r.ok;
}

export async function hostPushMedia(token, code, media) {
  const ep = roomEndpoint();
  const r = await fetch(`${ep}?code=${encodeURIComponent(code)}&op=media`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ media }),
    cache: "no-store",
    keepalive: true,
  });
  return r.ok;
}

export async function heartbeat(token, code, name) {
  const ep = roomEndpoint();
  const r = await fetch(`${ep}?code=${encodeURIComponent(code)}&op=heartbeat`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
    cache: "no-store",
    keepalive: true,
  });
  return r.ok;
}

export async function sendChat(token, code, text) {
  const ep = roomEndpoint();
  const r = await fetch(`${ep}?code=${encodeURIComponent(code)}&op=chat`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
    cache: "no-store",
    keepalive: true,
  });
  return r.ok;
}

export async function closeRoom(token, code) {
  const ep = roomEndpoint();
  const r = await fetch(`${ep}?code=${encodeURIComponent(code)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  return r.ok;
}

// ── Voice-chat signaling (rides on the room HTTP API; SDP/ICE are opaque) ────
// The server stores each message in a per-recipient mailbox (Redis LIST
// sig:{code}:{targetPeerId}, TTL 60s) and drains it on poll. `msg` is an opaque
// WebRTC payload (SDP or ICE candidate) — we never inspect it here, and the
// server never inspects it either. keepalive on send so a signaling write
// survives even if the tab is backgrounded mid-negotiation. Same Bearer-token
// auth as the rest of /api/room (token = the WT per-peer secret).
export async function sendSignal(token, code, target, msg) {
  const ep = roomEndpoint();
  if (!ep) return false;
  const r = await fetch(`${ep}?code=${encodeURIComponent(code)}&op=signal`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ target, msg }),
    cache: "no-store",
    keepalive: true,
  });
  return r.ok;
}

export async function pollSignals(token, code) {
  const ep = roomEndpoint();
  if (!ep) return [];
  const r = await fetch(`${ep}?code=${encodeURIComponent(code)}&op=signal-poll`, {
    headers: { Authorization: `Bearer ${token}` },
    cache: "no-store",
  });
  if (!r.ok) return [];
  const data = await r.json().catch(() => ({}));
  return Array.isArray(data.signals) ? data.signals : [];
}

/**
 * Enforce host playback state on a follower's <video>. Idempotent + cheap; call
 * on each poll and on each syncState change. Computes the host's expected
 * position accounting for elapsed time since `play.updatedAt`, seeks only on
 * drift > threshold, and matches play/pause immediately.
 *
 * When the host is PAUSED, we seek to the exact `play.position` (not the
 * elapsed-corrected expected) so a follower lands precisely where the host
 * paused, with no drift from time-since-updateAt.
 *
 * Returns true if a seek was applied (caller can bump the poll to fast mode).
 */
export function applySync(video, play) {
  if (!video || !play) return false;
  if (!video.duration || !isFinite(video.duration)) return false;
  const now = Date.now();
  // Host paused → exact position. Host playing → position + elapsed since the
  // host's update (the host keeps playing in real time between pushes).
  const expected = play.playing
    ? play.position + (now - play.updatedAt) / 1000
    : play.position;
  let sought = false;
  const myPos = video.currentTime || 0;
  if (Math.abs(myPos - expected) > DRIFT_THRESHOLD) {
    if (now - _lastSeekAt >= SEEK_COOLDOWN_MS) {
      _lastSeekAt = now;
      try { video.currentTime = Math.max(0, Math.min(video.duration, expected)); sought = true; } catch {}
    }
  }
  if (play.playing && video.paused) video.play().catch(() => {});
  else if (!play.playing && !video.paused) video.pause();
  return sought;
}
