// Watch Together rooms: one Durable Object per room, so every change to a room
// happens in order and reaches everyone at once over a WebSocket. Clients that
// cannot hold a WebSocket use the same commands over HTTP (see api/room.js).
//
//   POST /rooms                 Bearer, {name}          → {code}
//   GET  /rooms/:code           Bearer                  → {room|null, now}
//   POST /rooms/:code           Bearer, {t, ...}        → {ok|error, now}
//   GET  /rooms/:code/ws        then {t:"hello", secret, name}
//
// A peer's id is the sha256 of a random secret its browser keeps; the code is
// the shareable secret. Socket liveness uses the runtime's ping auto-response,
// which does not wake the object.
import { DurableObject } from "cloudflare:workers";
import {
  PEER_TTL_MS, RECONNECT_GRACE_MS, ROOM_IDLE_TTL_MS, applyCommand, createRoom, generateCode, isGeneratedCode,
  markDisconnected, normalizeCode, publicRoom, sweep,
} from "./rooms-core.mjs";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
};
const MAX_BODY = 8 * 1024;
const SWEEP_MS = 20_000;
const CREATE_ATTEMPTS = 5;
const MAX_SOCKETS_PER_ROOM = 40;
const MAX_SOCKETS_PER_PEER = 3;
const HELLO_DEADLINE_MS = 15_000;
const COMMAND_WINDOW_MS = 10_000;
const COMMANDS_PER_WINDOW = 60;

const json = (body, status = 200) => Response.json(body, { status, headers: CORS });

async function peerIdOf(secret) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(secret)));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function bearer(request) {
  const header = request.headers.get("Authorization") || "";
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

const safeSend = (ws, message) => { try { ws.send(JSON.stringify(message)); } catch { /* the socket is going away */ } };
const safeClose = (ws, code, reason) => { try { ws.close(code, reason); } catch { /* already closed */ } };

async function readJson(request) {
  if (Number(request.headers.get("Content-Length")) > MAX_BODY) return null;
  const text = await request.text();
  if (text.length > MAX_BODY) return null;
  try { return JSON.parse(text); } catch { return null; }
}

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.room = undefined;
    this.httpSeen = new Map();
    this.budgets = new Map();
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async load() {
    if (this.room === undefined) this.room = (await this.ctx.storage.get("room")) ?? null;
    return this.room;
  }

  async save() {
    await this.ctx.storage.put("room", this.room);
  }

  async destroy() {
    this.room = null;
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.deleteAlarm();
  }

  // Per peer, across transports. Kept in memory: a limit, not a record.
  withinBudget(peerId, now) {
    const budget = this.budgets.get(peerId);
    if (!budget || now - budget.since >= COMMAND_WINDOW_MS) {
      this.budgets.set(peerId, { since: now, used: 1 });
      return true;
    }
    budget.used += 1;
    return budget.used <= COMMANDS_PER_WINDOW;
  }

  socketsOf(peerId) {
    return this.ctx.getWebSockets().filter((ws) => ws.deserializeAttachment()?.peerId === peerId);
  }

  isOnline(peerId, now) {
    if ((this.httpSeen.get(peerId) || 0) > now - PEER_TTL_MS) return true;
    return this.socketsOf(peerId).some((ws) => {
      const pinged = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() || 0;
      return Math.max(pinged, ws.deserializeAttachment()?.since || 0) > now - PEER_TTL_MS;
    });
  }

  broadcast(message) {
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.deserializeAttachment()?.peerId) safeSend(ws, message);
    }
  }

  async scheduleAlarm(now) {
    const populated = Object.keys(this.room.who).length > 0;
    await this.alarmBy(populated ? now + SWEEP_MS : this.room.lastActive + ROOM_IDLE_TTL_MS);
  }

  // Never postpones one already due, so a peer cycling its socket cannot starve the sweep.
  async alarmBy(time) {
    const current = await this.ctx.storage.getAlarm();
    if (current == null || time < current) await this.ctx.storage.setAlarm(time);
  }

  // Applies a command and tells everyone what changed.
  async run(peerId, command, now) {
    if (!this.withinBudget(peerId, now)) return { error: "too_fast" };
    const result = applyCommand(this.room, peerId, command, now);
    if (result.closed) {
      await this.destroy();
      for (const ws of this.ctx.getWebSockets()) {
        safeSend(ws, { t: "closed" });
        safeClose(ws, 4000, "closed");
      }
      return result;
    }
    if (result.error) return result;
    const { patch, chat, reaction, joined, left } = result;
    if (patch || chat || reaction) {
      const name = joined ? this.room.who[peerId]?.name : left;
      this.broadcast({
        t: "patch", now,
        ...(patch ? { patch } : {}),
        ...(chat ? { chat } : {}),
        ...(reaction ? { reaction } : {}),
        ...(joined ? { joined: { by: peerId, name } } : {}),
        ...(left ? { left: { by: peerId, name } } : {}),
      });
    }
    if (result.persist) await this.save();
    if (joined || left) await this.scheduleAlarm(now);
    return result;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const now = Date.now();
    await this.load();

    if (url.pathname.endsWith("/init")) {
      const { code, peerId, name } = await request.json();
      if (this.room) return json({ error: "exists" }, 409);
      this.room = createRoom({ code, hostId: peerId, name, now });
      await this.save();
      await this.scheduleAlarm(now);
      return json({ code });
    }

    if (url.pathname.endsWith("/ws")) {
      if (this.ctx.getWebSockets().length >= MAX_SOCKETS_PER_ROOM) return json({ error: "too_many_sockets" }, 429);
      const { 0: client, 1: server } = new WebSocketPair();
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ peerId: null, since: now });
      // With no room the answer comes on the hello; a socket that stays silent goes at the alarm.
      if (!this.room) await this.alarmBy(now + HELLO_DEADLINE_MS + 1000);
      return new Response(null, { status: 101, webSocket: client });
    }

    const secret = bearer(request);
    if (!secret) return json({ error: "missing_token" }, 401);
    const peerId = await peerIdOf(secret);

    if (request.method === "GET") {
      if (!this.room) return json({ room: null, now });
      if (this.room.who[peerId]) this.httpSeen.set(peerId, now);
      return json({ room: publicRoom(this.room), now });
    }

    if (!this.room) return json({ error: "room_not_found", now }, 404);
    const command = await readJson(request);
    if (!command) return json({ error: "bad_request", now }, 400);
    this.httpSeen.set(peerId, now);
    const result = await this.run(peerId, command, now);
    if (result.error) return json({ error: result.error, now }, result.error === "not_allowed" ? 403 : 400);
    return json({ ok: true, now });
  }

  async webSocketMessage(ws, data) {
    if (typeof data !== "string" || data.length > MAX_BODY) return;
    let message;
    try { message = JSON.parse(data); } catch { return; }
    const now = Date.now();
    await this.load();
    if (!this.room) { safeSend(ws, { t: "closed" }); safeClose(ws, 4004, "no room"); return; }

    const attachment = ws.deserializeAttachment() || {};
    if (message?.t === "hello") {
      if (!message.secret) { safeClose(ws, 4001, "no secret"); return; }
      const peerId = await peerIdOf(message.secret);
      const others = this.socketsOf(peerId).filter((other) => other !== ws);
      const result = others.length >= MAX_SOCKETS_PER_PEER
        ? { error: "too_many_tabs" }
        : await this.run(peerId, { t: "join", name: message.name }, now);
      if (result.error) { safeSend(ws, { t: "error", error: result.error }); safeClose(ws, 4003, result.error); return; }
      ws.serializeAttachment({ peerId, since: now });
      safeSend(ws, { t: "snapshot", now, peerId, room: publicRoom(this.room) });
      await this.scheduleAlarm(now);
      return;
    }
    if (!attachment.peerId) { safeClose(ws, 4001, "hello first"); return; }
    if (!message || typeof message !== "object") return;

    // Answers the client's clock estimate: `sent` comes back with server time.
    if (message.t === "time") { safeSend(ws, { t: "time", sent: message.sent, now }); return; }

    const result = await this.run(attachment.peerId, message, now);
    if (result.error) safeSend(ws, { t: "error", error: result.error, for: message.t });
  }

  async webSocketClose(ws) {
    const peerId = ws.deserializeAttachment()?.peerId;
    try { ws.close(); } catch { /* already closed */ }
    await this.load();
    if (!peerId || !this.room || this.socketsOf(peerId).some((other) => other !== ws)) return;
    const now = Date.now();
    markDisconnected(this.room, peerId, now);
    await this.save();
    await this.alarmBy(now + RECONNECT_GRACE_MS + 1000);
  }

  async webSocketError(ws) {
    await this.webSocketClose(ws);
  }

  async alarm() {
    const now = Date.now();
    await this.load();
    if (!this.room) {
      for (const ws of this.ctx.getWebSockets()) safeClose(ws, 4004, "no room");
      await this.ctx.storage.deleteAll();
      return;
    }
    for (const ws of this.ctx.getWebSockets()) {
      const { peerId, since } = ws.deserializeAttachment() || {};
      if (!peerId && now - (since || 0) > HELLO_DEADLINE_MS) safeClose(ws, 4001, "hello first");
    }
    const before = Object.keys(this.room.who).length;
    const patch = sweep(this.room, now, (peerId) => this.isOnline(peerId, now));
    if (patch) {
      if (Object.keys(this.room.who).length === 0) this.room.lastActive = now;
      this.broadcast({ t: "patch", now, patch });
      await this.save();
    }
    if (before === 0 && now >= this.room.lastActive + ROOM_IDLE_TTL_MS) { await this.destroy(); return; }
    await this.scheduleAlarm(now);
  }
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    const { pathname } = new URL(request.url);

    if (pathname === "/rooms" && request.method === "POST") {
      const secret = bearer(request);
      if (!secret) return json({ error: "missing_token" }, 401);
      const limited = await env.CREATE_LIMIT?.limit({ key: request.headers.get("CF-Connecting-IP") || "unknown" });
      if (limited && !limited.success) return json({ error: "too_fast" }, 429);
      const body = (await readJson(request)) || {};
      const peerId = await peerIdOf(secret);
      for (let attempt = 0; attempt < CREATE_ATTEMPTS; attempt += 1) {
        const code = generateCode((n) => crypto.getRandomValues(new Uint8Array(n)));
        const stub = env.ROOM.get(env.ROOM.idFromName(code));
        const made = await stub.fetch("https://room/init", { method: "POST", body: JSON.stringify({ code, peerId, name: body.name }) });
        if (made.ok) return json({ code, now: Date.now() });
      }
      return json({ error: "try_again" }, 503);
    }

    const match = pathname.match(/^\/rooms\/([^/]+)(\/ws)?$/);
    const code = match && normalizeCode(match[1]);
    // Only generated codes can exist, so a malformed guess never reaches an object.
    if (!code || !isGeneratedCode(code)) {
      if (match && !match[2] && request.method === "GET") return json({ room: null, now: Date.now() });
      return json({ error: "not_found" }, 404);
    }
    if (match[2] && request.headers.get("Upgrade") !== "websocket") return json({ error: "expected_websocket" }, 426);

    return env.ROOM.get(env.ROOM.idFromName(code)).fetch(request);
  },
};
