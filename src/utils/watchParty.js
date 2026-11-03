// Watch Together client: the connection to a room and the playback sync.
//
// A room is one Durable Object (workers-api/rooms-worker.mjs). Everyone holds a
// WebSocket to it, so a pause reaches the others in a network round trip. If the
// socket cannot open, the same commands go over HTTP with polling, directly or
// through /api/room when the Worker's host itself is unreachable. Each peer
// resolves its own stream; only playback state is shared.
//
// `room.play` is the shared clock, stamped with server time. Every player steers
// towards it, including whoever just changed it, so nobody has to be the source
// of truth for position and a peer's wrong local clock cannot cause drift.

import { isWebBuild } from "./api";

const WORKER_URL = import.meta.env.VITE_ROOMS_URL || "https://lampa-rooms.ocr-gemini-proxy.workers.dev";

const OPEN_TIMEOUT_MS = 5000;
const PING_MS = 15_000;
const PONG_TIMEOUT_MS = 10_000;
const RECONNECT_MIN_MS = 500;
const RECONNECT_MAX_MS = 15_000;
const POLL_MS = 1000;
const HTTP_JOIN_MS = 15_000;
const CLOCK_SAMPLES = 3;
const CLOCK_RESYNC_MS = 5 * 60_000;
const REQUEST_TIMEOUT_MS = 4000;
// How long a change made here outranks a poll that left before the server had it.
const LOCAL_PLAY_HOLD_MS = 1500;

const PEER_SECRET_KEY = "lampa_stream_wt_peer";

// A random per-browser secret: the peer id is its hash, and it stays stable across
// reloads so a reloading host is still the host.
let memorySecret = null;
const newSecret = () => Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, "0")).join("");
export function getWtPeerSecret() {
  try {
    let secret = localStorage.getItem(PEER_SECRET_KEY);
    if (!secret) {
      secret = newSecret();
      localStorage.setItem(PEER_SECRET_KEY, secret);
    }
    return secret;
  } catch {
    // Storage blocked: this visit still gets an identity of its own.
    memorySecret ??= newSecret();
    return memorySecret;
  }
}

async function peerIdOf(secret) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export const normalizeRoomCode = (value) => String(value ?? "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");

// ── HTTP ─────────────────────────────────────────────────────────────────────
const canProxy = () => isWebBuild() || (typeof window !== "undefined" && !window.electron);
let useProxy = false;

const directUrl = (code) => `${WORKER_URL}/rooms${code ? `/${encodeURIComponent(code)}` : ""}`;
const proxyUrl = (code) => `/api/room${code ? `?code=${encodeURIComponent(code)}` : ""}`;

async function request(code, secret, init = {}) {
  const options = {
    ...init,
    cache: "no-store",
    // A blocked host often drops packets instead of refusing them.
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { Authorization: `Bearer ${secret}`, ...(init.body ? { "Content-Type": "application/json" } : {}) },
  };
  const attempt = (proxied) => fetch(proxied ? proxyUrl(code) : directUrl(code), options);
  try {
    return await attempt(useProxy);
  } catch (error) {
    if (!canProxy()) throw error;
    const response = await attempt(!useProxy);
    useProxy = !useProxy;
    return response;
  }
}

async function jsonOrThrow(response, label) {
  const data = await response.json().catch(() => null);
  if (!data) throw new Error(`${label} ${response.status}`);
  return data;
}

export async function createRoom(secret, name) {
  const response = await request(null, secret, { method: "POST", body: JSON.stringify({ name }) });
  const data = await jsonOrThrow(response, "create");
  if (!response.ok || !data.code) throw new Error(data.error || `create ${response.status}`);
  return data.code;
}

export async function fetchRoom(secret, code) {
  const response = await request(code, secret);
  const data = await jsonOrThrow(response, "room");
  if (!response.ok && response.status !== 404) throw new Error(data.error || `room ${response.status}`);
  return { room: data.room ?? null, now: data.now };
}

async function postCommand(secret, code, command, keepalive = false) {
  const response = await request(code, secret, { method: "POST", body: JSON.stringify(command), keepalive });
  return jsonOrThrow(response, "command");
}

// ── Connection ───────────────────────────────────────────────────────────────
export class RoomConnection {
  constructor({ code, secret, name, onRoom, onLink, onEvent, onClosed }) {
    Object.assign(this, { code, secret, name, onRoom, onLink, onEvent, onClosed });
    this.room = null;
    this.peerId = null;
    this.offset = 0; // server time minus local time
    this.bestRtt = Infinity;
    this.stopped = false;
    this.ws = null;
    this.live = false;
    this.attempts = 0;
    this.timers = new Set();
    this.pollTimer = null;
    this.pollRun = 0;
    this.leaving = false;
    this.serverPlay = null;
    this.localPlayAt = 0;
    this.onWake = () => { if (!this.live && !this.stopped) this.connect(); };
  }

  now() { return Date.now() + this.offset; }

  start() {
    window.addEventListener("online", this.onWake);
    document.addEventListener("visibilitychange", this.onWake);
    // Polling never gets the server's answer, so the id is also worked out here.
    peerIdOf(this.secret).then((id) => { this.peerId ??= id; }).catch(() => {});
    this.connect();
  }

  stop() {
    this.stopped = true;
    window.removeEventListener("online", this.onWake);
    document.removeEventListener("visibilitychange", this.onWake);
    this.clearTimers();
    this.stopPolling();
    if (this.ws) { const ws = this.ws; this.ws = null; try { ws.close(1000); } catch { /* already closed */ } }
  }

  later(fn, ms) {
    const id = setTimeout(() => { this.timers.delete(id); fn(); }, ms);
    this.timers.add(id);
    return id;
  }

  every(fn, ms) {
    const id = setInterval(fn, ms);
    this.timers.add(id);
    return id;
  }

  clearTimers() {
    for (const id of this.timers) { clearTimeout(id); clearInterval(id); }
    this.timers.clear();
  }

  connect() {
    if (this.stopped || (this.ws && this.ws.readyState <= WebSocket.OPEN)) return;
    this.clearTimers();
    let ws;
    try {
      ws = new WebSocket(`${WORKER_URL.replace(/^http/, "ws")}/rooms/${encodeURIComponent(this.code)}/ws`);
    } catch {
      this.dropped(null);
      return;
    }
    this.ws = ws;
    const openTimer = this.later(() => { if (!this.live) { try { ws.close(); } catch { /* ignored */ } this.dropped(ws); } }, OPEN_TIMEOUT_MS);
    ws.onopen = () => ws.send(JSON.stringify({ t: "hello", secret: this.secret, name: this.name }));
    ws.onmessage = (event) => {
      if (ws !== this.ws) return;
      if (event.data === "pong") { this.lastPong = Date.now(); return; }
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.t === "snapshot" && !this.live) { clearTimeout(openTimer); this.timers.delete(openTimer); this.wentLive(ws); }
      this.handle(message);
    };
    ws.onclose = (event) => {
      if (ws !== this.ws) return;
      if (event.code === 4000 || event.code === 4004) { this.finish(); return; }
      if (event.code === 4003) { this.finish("room_full"); return; }
      this.dropped(ws);
    };
    ws.onerror = () => {};
  }

  wentLive(ws) {
    this.live = true;
    this.attempts = 0;
    this.stopPolling();
    this.onLink?.("live");
    this.measureClock(ws);
    this.every(() => this.measureClock(ws), CLOCK_RESYNC_MS);
    this.lastPong = Date.now();
    this.lastPing = 0;
    this.every(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      // Measured from the last ping: a hidden tab's timer may be a minute late.
      if (this.lastPing > this.lastPong && Date.now() - this.lastPing > PONG_TIMEOUT_MS) {
        try { ws.close(); } catch { /* ignored */ }
        this.dropped(ws);
        return;
      }
      this.lastPing = Date.now();
      ws.send("ping");
    }, PING_MS);
  }

  dropped(ws) {
    if (this.stopped || (ws && ws !== this.ws)) return;
    this.ws = null;
    this.live = false;
    this.clearTimers();
    this.fallBack();
    const delay = Math.min(RECONNECT_MAX_MS, RECONNECT_MIN_MS * 2 ** this.attempts);
    this.attempts += 1;
    this.later(() => this.connect(), delay + Math.random() * 300);
  }

  // Keeps the room usable while the socket is away.
  fallBack() {
    if (this.pollTimer || this.stopped) return;
    this.onLink?.("polling");
    this.lastHttpJoin = 0;
    this.pollRun += 1;
    const run = this.pollRun;
    const current = () => run === this.pollRun && !this.stopped;
    const poll = async () => {
      if (!current()) return;
      try {
        if (Date.now() - this.lastHttpJoin > HTTP_JOIN_MS) {
          this.lastHttpJoin = Date.now();
          const joined = await postCommand(this.secret, this.code, { t: "join", name: this.name });
          if (joined.error === "room_full") { this.finish("room_full"); return; }
        }
        const sent = Date.now();
        const { room, now } = await fetchRoom(this.secret, this.code);
        if (!current()) return;
        this.sampleClock(sent, now);
        if (!room) { this.finish(); return; }
        this.acceptPolled(room);
        this.onLink?.("polling");
      } catch {
        if (!current()) return;
        this.onLink?.("lost");
      }
      this.pollTimer = setTimeout(poll, POLL_MS);
    };
    this.pollTimer = setTimeout(poll, 0);
  }

  stopPolling() {
    this.pollRun += 1;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }

  acceptPolled(room) {
    this.serverPlay = room.play;
    const holdLocal = this.room && Date.now() - this.localPlayAt < LOCAL_PLAY_HOLD_MS && room.rev === this.room.rev;
    this.room = holdLocal ? { ...room, play: this.room.play } : room;
    this.onRoom?.(this.room);
  }

  measureClock(ws) {
    this.bestRtt = Infinity; // Re-measure: the route and the local clock both change.
    for (let i = 0; i < CLOCK_SAMPLES; i += 1) {
      this.later(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "time", sent: Date.now() }));
      }, i * 400);
    }
  }

  // The fastest round trip gives the most honest clock estimate.
  sampleClock(sent, serverNow) {
    if (!Number.isFinite(serverNow)) return;
    const received = Date.now();
    const rtt = received - sent;
    if (rtt < 0 || rtt > this.bestRtt) return;
    this.bestRtt = rtt;
    this.offset = serverNow - (sent + received) / 2;
  }

  handle(message) {
    switch (message.t) {
      case "snapshot":
        this.peerId = message.peerId;
        if (this.bestRtt === Infinity) this.offset = message.now - Date.now();
        this.room = message.room;
        this.serverPlay = message.room.play;
        this.onRoom?.(this.room);
        break;
      case "patch": {
        if (!this.room) return;
        const chat = message.chat && !this.room.chat.some((m) => m.id === message.chat.id)
          ? [...this.room.chat, message.chat].slice(-60)
          : this.room.chat;
        this.room = { ...this.room, ...message.patch, chat };
        if (message.patch?.play) this.serverPlay = message.patch.play;
        this.onRoom?.(this.room);
        // Dropped by the server while still here (another tab left, a long sleep).
        if (message.patch?.who && !message.patch.who[this.peerId]) this.rejoin();
        if (message.reaction) this.onEvent?.({ type: "reaction", ...message.reaction });
        if (message.joined) this.onEvent?.({ type: "joined", ...message.joined });
        if (message.left) this.onEvent?.({ type: "left", ...message.left });
        break;
      }
      case "time":
        this.sampleClock(message.sent, message.now);
        break;
      case "error":
        if (message.error === "not_joined") this.rejoin();
        if (message.for === "play") this.undoLocalPlay();
        this.onEvent?.({ type: "error", error: message.error, for: message.for });
        break;
      case "closed":
        this.finish();
        break;
      default:
    }
  }

  rejoin() {
    if (this.leaving || !this.live || this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ t: "hello", secret: this.secret, name: this.name }));
  }

  undoLocalPlay() {
    if (!this.room || !this.serverPlay) return;
    this.localPlayAt = 0;
    this.room = { ...this.room, play: this.serverPlay };
    this.onRoom?.(this.room);
  }

  finish(reason = "closed") {
    if (this.stopped) return;
    this.stop();
    this.onClosed?.(reason);
  }

  // Resolves { ok } or { error }. Over a live socket the answer is the broadcast.
  async send(command) {
    if (this.stopped) return { error: "stopped" };
    if (command.t === "leave") this.leaving = true;
    if (this.live && this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(command));
      return { ok: true };
    }
    try {
      const result = await postCommand(this.secret, this.code, command, command.t === "leave");
      if (result.error === "not_joined") this.lastHttpJoin = 0;
      if (result.error && command.t === "play") this.undoLocalPlay();
      if (result.now) this.pollSoon();
      return result;
    } catch {
      return { error: "network" };
    }
  }

  pollSoon() {
    if (!this.pollTimer) return;
    fetchRoom(this.secret, this.code).then(({ room }) => {
      if (room && !this.stopped) this.acceptPolled(room);
    }).catch(() => {});
  }

  // Shows a local change at once; the server's broadcast then confirms it.
  setPlayLocally(play) {
    if (!this.room) return;
    this.localPlayAt = Date.now();
    this.room = { ...this.room, play: { ...this.room.play, ...play } };
    this.onRoom?.(this.room);
  }
}

// ── Sync ─────────────────────────────────────────────────────────────────────
const IN_SYNC = 0.15; // seconds: close enough to stop steering
const STEER_FROM = 0.3; // below this a viewer cannot tell
const SEEK_FROM = 2.5;
// A viewer whose network cannot keep up would otherwise loop seek → rebuffer →
// behind again. After repeated seeks only speed steers, until the gap gets large.
const SEEK_FROM_STRUGGLING = 10;
const SEEK_COOLDOWN_MS = 3000;
const STRUGGLE_WINDOW_MS = 30_000;
const STRUGGLE_SEEKS = 2;
const STEER_RATE = 0.08;

export const createSyncTracker = () => ({ seeks: [], lastSeekAt: 0, steering: false, appliedRate: null });

export function expectedPosition(play, serverNow) {
  if (!play) return 0;
  if (!play.playing) return play.position;
  return play.position + (Math.max(0, serverNow - play.updatedAt) / 1000) * (play.rate || 1);
}

// Moves one <video> towards the room's clock. Called on every state change and on
// a short tick, so it must be cheap and safe to repeat.
export function syncVideo(video, play, serverNow, tracker, wallNow = Date.now()) {
  if (!video || !play) return;
  const duration = video.duration;
  if (!duration || !Number.isFinite(duration)) return;
  const baseRate = play.rate || 1;
  const expected = Math.min(duration, Math.max(0, expectedPosition(play, serverNow)));
  const setRate = (rate) => {
    tracker.steering = rate !== baseRate;
    tracker.appliedRate = rate;
    if (Math.abs(video.playbackRate - rate) > 0.001) video.playbackRate = rate;
  };

  // Finished here while the room's clock also ran out: stay on the last frame.
  if (video.ended && expected >= duration - 2) return;

  if (play.playing && video.paused) video.play()?.catch?.(() => {});
  else if (!play.playing && !video.paused) video.pause();

  if (video.seeking) return;
  const drift = expected - (video.currentTime || 0);
  const gap = Math.abs(drift);

  const seekTo = () => {
    tracker.lastSeekAt = wallNow;
    tracker.seeks = [...tracker.seeks.filter((at) => wallNow - at < STRUGGLE_WINDOW_MS), wallNow];
    try { video.currentTime = expected; } catch { /* not seekable yet */ }
  };

  if (!play.playing) {
    setRate(baseRate);
    if (gap > STEER_FROM && wallNow - tracker.lastSeekAt >= 500) seekTo();
    return;
  }

  const recentSeeks = tracker.seeks.filter((at) => wallNow - at < STRUGGLE_WINDOW_MS).length;
  const seekFrom = recentSeeks >= STRUGGLE_SEEKS ? SEEK_FROM_STRUGGLING : SEEK_FROM;
  if (gap > seekFrom) {
    setRate(baseRate);
    if (wallNow - tracker.lastSeekAt >= SEEK_COOLDOWN_MS) seekTo();
  } else if (gap > STEER_FROM || (tracker.steering && gap > IN_SYNC)) {
    setRate(baseRate * (1 + Math.sign(drift) * STEER_RATE));
  } else {
    setRate(baseRate);
  }
}
