// Watch Together room rules, free of any platform API: the Durable Object runs
// them in production and the tests run them directly. The room's clock is the
// server's; a client never sends a timestamp.

// Silent this long = gone. A hidden, silent tab is throttled to one ping a minute.
export const PEER_TTL_MS = 90_000;
export const RECONNECT_GRACE_MS = 12_000; // a closed socket may come back (reload, network switch)
export const ROOM_IDLE_TTL_MS = 6 * 3600_000;
const CHAT_KEEP = 60;
const CHAT_MAX_LEN = 500;
const CHAT_MIN_GAP_MS = 250;
const NAME_MAX_LEN = 24;
const MAX_PEERS = 20;
const MAX_POSITION = 48 * 3600;
export const REACTIONS = ["😂", "😮", "😢", "🔥", "❤️"];

// No 0/O or 1/I: codes get dictated over the phone.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const CODE_LENGTH = 6;
const CODE_RE = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`);

export function generateCode(randomBytes) {
  // 256 is a multiple of the alphabet's 32 letters, so % carries no bias.
  return Array.from(randomBytes(CODE_LENGTH), (byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join("");
}

// Accepts the old alphabet's letters too: the lookup then just finds no room.
export function normalizeCode(value) {
  const code = String(value ?? "").trim().toUpperCase();
  return /^[A-Z0-9]{4,12}$/.test(code) ? code : null;
}

export const isGeneratedCode = (code) => CODE_RE.test(code);

export function cleanName(value, fallback) {
  // eslint-disable-next-line no-control-regex
  const name = String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, NAME_MAX_LEN);
  return name || fallback || "Зритель";
}

// Only what a client needs to find and show the title; anything else is dropped.
export function cleanMedia(media) {
  if (!media || typeof media !== "object") return null;
  const tmdbId = Number(media.tmdbId);
  if (media.type !== "movie" && media.type !== "tv") return null;
  if (!Number.isInteger(tmdbId) || tmdbId <= 0) return null;
  const text = (value, max) => (typeof value === "string" && value ? value.slice(0, max) : null);
  const posterPath = text(media.posterPath, 80);
  const imdbId = text(media.imdbId, 16);
  const whole = (value, min) => (Number.isInteger(value) && value >= min && value < 10_000 ? value : min);
  return {
    type: media.type,
    tmdbId,
    title: text(media.title, 200) || "Без названия",
    originalTitle: text(media.originalTitle, 200),
    originalLanguage: text(media.originalLanguage, 8),
    releaseDate: text(media.releaseDate, 10),
    posterPath: posterPath && /^\/[\w.-]+$/.test(posterPath) ? posterPath : null,
    imdbId: imdbId && /^tt\d+$/.test(imdbId) ? imdbId : null,
    runtime: Number.isInteger(media.runtime) && media.runtime > 0 && media.runtime < 2000 ? media.runtime : null,
    ...(media.type === "tv" ? { season: whole(media.season, 0), episode: whole(media.episode, 1) } : {}),
  };
}

export function createRoom({ code, hostId, name, now }) {
  const hostName = cleanName(name, "Ведущий");
  return {
    code,
    hostId,
    control: "all",
    media: null,
    rev: 0,
    play: { playing: false, position: 0, rate: 1, updatedAt: now, seq: 0, by: null },
    chat: [],
    chatSeq: 0,
    who: { [hostId]: { name: hostName, joinedAt: now, lastSeen: now, buffering: false, duration: null } },
    lastActive: now,
  };
}

export const canControl = (room, peerId) => room.control === "all" || room.hostId === peerId;

// What clients see. Last-seen times stay on the server.
export function publicRoom(room) {
  const who = {};
  for (const [peerId, peer] of Object.entries(room.who)) {
    who[peerId] = { name: peer.name, joinedAt: peer.joinedAt, buffering: !!peer.buffering, duration: peer.duration ?? null };
  }
  const { code, hostId, control, media, rev, play, chat } = room;
  return { code, hostId, control, media, rev, play, chat, who };
}

const whoPatch = (room) => ({ who: publicRoom(room).who, hostId: room.hostId });

// With nobody watching, the room's clock stops where it was.
function freezeIfEmpty(room, now) {
  if (Object.keys(room.who).length > 0 || !room.play.playing) return;
  const position = room.play.position + (Math.max(0, now - room.play.updatedAt) / 1000) * room.play.rate;
  room.play = { ...room.play, playing: false, position: Math.min(MAX_POSITION, position), updatedAt: now };
  room.lastActive = now;
}

function promoteIfHostGone(room) {
  if (room.who[room.hostId]) return false;
  const next = Object.entries(room.who).sort(([, a], [, b]) => a.joinedAt - b.joinedAt)[0];
  if (!next) return false;
  room.hostId = next[0];
  return true;
}

// Each result: { error } or { patch?, chat?, reaction?, closed?, persist }.
// `persist: false` marks changes not worth a storage write.
export function applyCommand(room, peerId, command, now) {
  const peer = room.who[peerId];
  const type = command?.t;

  if (type === "join") {
    const name = cleanName(command.name, peer?.name);
    if (!peer && Object.keys(room.who).length >= MAX_PEERS) return { error: "room_full" };
    if (peer) {
      peer.lastSeen = now;
      if (peer.name === name) return { persist: false };
      peer.name = name;
    } else {
      room.who[peerId] = { name, joinedAt: now, lastSeen: now, buffering: false, duration: null };
    }
    promoteIfHostGone(room);
    room.lastActive = now;
    return { patch: whoPatch(room), joined: !peer, persist: true };
  }

  if (!peer) return { error: "not_joined" };
  peer.lastSeen = now;
  room.lastActive = now;

  switch (type) {
    case "leave": {
      delete room.who[peerId];
      promoteIfHostGone(room);
      freezeIfEmpty(room, now);
      return { patch: whoPatch(room), left: peer.name, persist: true };
    }
    case "play": {
      if (!canControl(room, peerId)) return { error: "not_allowed" };
      // A report from the previous title must not move the new one.
      if (command.rev !== room.rev) return { persist: false };
      const position = Number(command.position);
      const rate = Number(command.rate);
      room.play = {
        playing: !!command.playing,
        position: Number.isFinite(position) ? Math.min(MAX_POSITION, Math.max(0, position)) : 0,
        rate: Number.isFinite(rate) ? Math.min(4, Math.max(0.25, rate)) : 1,
        updatedAt: now,
        seq: room.play.seq + 1,
        by: peerId,
      };
      return { patch: { play: room.play }, persist: true };
    }
    case "media": {
      if (!canControl(room, peerId)) return { error: "not_allowed" };
      const media = cleanMedia(command.media);
      if (!media) return { error: "bad_media" };
      room.media = media;
      room.rev += 1;
      // Paused at the start: everyone loads, then someone presses play.
      room.play = { playing: false, position: 0, rate: 1, updatedAt: now, seq: room.play.seq + 1, by: peerId };
      for (const other of Object.values(room.who)) { other.buffering = false; other.duration = null; }
      return { patch: { media, rev: room.rev, play: room.play, ...whoPatch(room) }, persist: true };
    }
    case "chat": {
      const text = String(command.text ?? "").trim().slice(0, CHAT_MAX_LEN);
      if (!text) return { error: "empty" };
      if (now - (peer.chatAt || 0) < CHAT_MIN_GAP_MS) return { error: "too_fast" };
      peer.chatAt = now;
      room.chatSeq += 1;
      const message = { id: room.chatSeq, by: peerId, name: peer.name, text, ts: now };
      room.chat = [...room.chat, message].slice(-CHAT_KEEP);
      return { chat: message, persist: true };
    }
    case "react": {
      if (!REACTIONS.includes(command.emoji)) return { error: "bad_reaction" };
      if (now - (peer.reactAt || 0) < CHAT_MIN_GAP_MS) return { persist: false };
      peer.reactAt = now;
      return { reaction: { emoji: command.emoji, name: peer.name, by: peerId }, persist: false };
    }
    case "status": {
      const buffering = !!command.buffering;
      const duration = Number(command.duration);
      const known = Number.isFinite(duration) && duration > 0 ? Math.round(duration) : null;
      if (peer.buffering === buffering && peer.duration === known) return { persist: false };
      peer.buffering = buffering;
      peer.duration = known;
      return { patch: whoPatch(room), persist: true };
    }
    case "control": {
      if (room.hostId !== peerId) return { error: "not_allowed" };
      if (command.mode !== "all" && command.mode !== "host") return { error: "bad_mode" };
      room.control = command.mode;
      return { patch: { control: room.control }, persist: true };
    }
    case "host": {
      if (room.hostId !== peerId) return { error: "not_allowed" };
      if (!Object.hasOwn(room.who, String(command.target))) return { error: "no_such_peer" };
      room.hostId = command.target;
      return { patch: { hostId: room.hostId }, persist: true };
    }
    case "close": {
      if (room.hostId !== peerId) return { error: "not_allowed" };
      return { closed: true };
    }
    default:
      return { error: "bad_command" };
  }
}

// Remove peers that went silent. `isOnline` answers for live transports.
export function sweep(room, now, isOnline = () => false) {
  let changed = false;
  for (const [peerId, peer] of Object.entries(room.who)) {
    if (isOnline(peerId)) { peer.lastSeen = now; continue; }
    if (now - peer.lastSeen >= PEER_TTL_MS) { delete room.who[peerId]; changed = true; }
  }
  if (promoteIfHostGone(room)) changed = true;
  if (changed) freezeIfEmpty(room, now);
  return changed ? whoPatch(room) : null;
}

// A closed socket: the peer gets a short grace, then the next sweep drops them.
export function markDisconnected(room, peerId, now) {
  const peer = room.who[peerId];
  if (peer) peer.lastSeen = Math.min(peer.lastSeen, now - PEER_TTL_MS + RECONNECT_GRACE_MS);
}
