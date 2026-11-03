import assert from "node:assert/strict";
import test from "node:test";
import {
  PEER_TTL_MS, RECONNECT_GRACE_MS, applyCommand, cleanMedia, cleanName, createRoom, generateCode,
  isGeneratedCode, markDisconnected, normalizeCode, publicRoom, sweep,
} from "./rooms-core.mjs";

const T0 = 1_000_000;
const movie = { type: "movie", tmdbId: 550, title: "Бойцовский клуб" };

function roomWithGuest() {
  const room = createRoom({ code: "ABCDEF", hostId: "host", name: "Аня", now: T0 });
  applyCommand(room, "guest", { t: "join", name: "Боря" }, T0 + 1000);
  return room;
}

test("generated codes are unambiguous and survive normalisation", () => {
  const code = generateCode((n) => new Uint8Array(n).map((_, i) => i * 37));
  assert.equal(code.length, 6);
  assert.ok(isGeneratedCode(code));
  assert.equal(normalizeCode(` ${code.toLowerCase()} `), code);
  assert.equal(normalizeCode("../x"), null);
  assert.equal(isGeneratedCode("ABC100"), false);
});

test("names and media are limited to what clients need", () => {
  assert.equal(cleanName("  "), "Зритель");
  assert.equal(cleanName("a\u0000b".padEnd(50, "c")).length, 24);
  assert.equal(cleanMedia({ type: "person", tmdbId: 1 }), null);
  assert.equal(cleanMedia({ type: "movie", tmdbId: -1 }), null);
  const media = cleanMedia({ ...movie, posterPath: "/../evil", extra: "x".repeat(9000), imdbId: "javascript:1" });
  assert.equal(media.posterPath, null);
  assert.equal(media.imdbId, null);
  assert.equal(media.extra, undefined);
  assert.deepEqual(
    [cleanMedia({ type: "tv", tmdbId: 1, season: 2, episode: 3 }).season, cleanMedia({ type: "tv", tmdbId: 1, season: "x" }).episode],
    [2, 1],
  );
});

test("a new title starts paused at zero and a report from the old title is ignored", () => {
  const room = roomWithGuest();
  applyCommand(room, "host", { t: "media", media: movie }, T0 + 2000);
  assert.equal(room.rev, 1);
  applyCommand(room, "host", { t: "play", playing: true, position: 12, rate: 1, rev: 1 }, T0 + 3000);
  assert.deepEqual([room.play.playing, room.play.position, room.play.by], [true, 12, "host"]);

  applyCommand(room, "host", { t: "media", media: { ...movie, tmdbId: 13 } }, T0 + 4000);
  assert.deepEqual([room.play.playing, room.play.position], [false, 0]);
  const stale = applyCommand(room, "host", { t: "play", playing: true, position: 7000, rate: 1, rev: 1 }, T0 + 4100);
  assert.equal(stale.patch, undefined);
  assert.equal(room.play.position, 0);
});

test("who may control playback follows the room's mode", () => {
  const room = roomWithGuest();
  applyCommand(room, "host", { t: "media", media: movie }, T0);
  assert.ok(applyCommand(room, "guest", { t: "play", playing: true, position: 1, rev: 1 }, T0).patch);

  assert.equal(applyCommand(room, "guest", { t: "control", mode: "host" }, T0).error, "not_allowed");
  applyCommand(room, "host", { t: "control", mode: "host" }, T0);
  assert.equal(applyCommand(room, "guest", { t: "play", playing: false, position: 1, rev: 1 }, T0).error, "not_allowed");
  assert.equal(applyCommand(room, "guest", { t: "media", media: movie }, T0).error, "not_allowed");
  assert.equal(applyCommand(room, "stranger", { t: "chat", text: "hi" }, T0).error, "not_joined");
});

test("position and rate from a client are clamped", () => {
  const room = roomWithGuest();
  applyCommand(room, "host", { t: "play", playing: true, position: "NaN", rate: 99, rev: 0 }, T0);
  assert.deepEqual([room.play.position, room.play.rate], [0, 4]);
  applyCommand(room, "host", { t: "play", playing: true, position: -5, rate: 0, rev: 0 }, T0);
  assert.deepEqual([room.play.position, room.play.rate], [0, 0.25]);
});

test("the host role passes to the earliest guest as soon as the host leaves", () => {
  const room = roomWithGuest();
  applyCommand(room, "late", { t: "join", name: "Вера" }, T0 + 5000);
  const result = applyCommand(room, "host", { t: "leave" }, T0 + 6000);
  assert.equal(room.hostId, "guest");
  assert.equal(result.left, "Аня");
  assert.equal(result.patch.hostId, "guest");
});

test("a dropped host keeps the role through a reload, and loses it after the grace", () => {
  const room = roomWithGuest();
  const dropped = T0 + 10_000;
  markDisconnected(room, "host", dropped);
  const online = (peerId) => peerId === "guest";

  assert.equal(sweep(room, dropped + RECONNECT_GRACE_MS - 1000, online), null);
  assert.equal(room.hostId, "host");

  applyCommand(room, "host", { t: "join", name: "Аня" }, dropped + 2000);
  assert.equal(sweep(room, dropped + RECONNECT_GRACE_MS + 1000, online), null);

  markDisconnected(room, "host", dropped + 20_000);
  const patch = sweep(room, dropped + 20_000 + RECONNECT_GRACE_MS + 1000, online);
  assert.equal(patch.hostId, "guest");
  assert.equal(room.who.host, undefined);
});

test("a silent peer disappears after the TTL", () => {
  const room = roomWithGuest();
  assert.equal(sweep(room, T0 + PEER_TTL_MS - 1, () => false), null);
  const patch = sweep(room, T0 + 1000 + PEER_TTL_MS, () => false);
  assert.deepEqual(Object.keys(patch.who), []);
});

test("the host can hand over the role and close the room, guests cannot", () => {
  const room = roomWithGuest();
  assert.equal(applyCommand(room, "guest", { t: "close" }, T0).error, "not_allowed");
  assert.equal(applyCommand(room, "host", { t: "host", target: "ghost" }, T0).error, "no_such_peer");
  applyCommand(room, "host", { t: "host", target: "guest" }, T0);
  assert.equal(room.hostId, "guest");
  assert.equal(applyCommand(room, "host", { t: "close" }, T0).error, "not_allowed");
  assert.equal(applyCommand(room, "guest", { t: "close" }, T0).closed, true);
});

test("chat keeps order, trims text and slows a flood; reactions are a fixed set", () => {
  const room = roomWithGuest();
  assert.equal(applyCommand(room, "host", { t: "chat", text: "   " }, T0).error, "empty");
  const first = applyCommand(room, "host", { t: "chat", text: "x".repeat(900) }, T0 + 1000);
  assert.equal(first.chat.text.length, 500);
  assert.equal(first.chat.name, "Аня");
  assert.equal(applyCommand(room, "host", { t: "chat", text: "flood" }, T0 + 1100).error, "too_fast");
  for (let i = 0; i < 70; i += 1) applyCommand(room, "guest", { t: "chat", text: `m${i}` }, T0 + 2000 + i * 300);
  assert.equal(room.chat.length, 60);
  assert.equal(room.chat.at(-1).text, "m69");
  assert.ok(room.chat.at(-1).id > room.chat[0].id);

  assert.equal(applyCommand(room, "guest", { t: "react", emoji: "<img>" }, T0).error, "bad_reaction");
  assert.equal(applyCommand(room, "guest", { t: "react", emoji: "🔥" }, T0 + 100_000).reaction.emoji, "🔥");
});

test("buffering status is kept and shared; last-seen stays private", () => {
  const room = roomWithGuest();
  const result = applyCommand(room, "guest", { t: "status", buffering: true, duration: 8380.4 }, T0);
  assert.equal(result.persist, true);
  assert.deepEqual([result.patch.who.guest.buffering, result.patch.who.guest.duration], [true, 8380]);
  assert.equal(applyCommand(room, "guest", { t: "status", buffering: true, duration: 8380 }, T0).patch, undefined);
  assert.equal(publicRoom(room).who.guest.lastSeen, undefined);
  assert.equal(publicRoom(room).chatSeq, undefined);
});

test("a full room refuses new peers but not returning ones", () => {
  const room = roomWithGuest();
  for (let i = 0; i < 18; i += 1) applyCommand(room, `p${i}`, { t: "join", name: "x" }, T0);
  assert.equal(applyCommand(room, "one-too-many", { t: "join", name: "x" }, T0).error, "room_full");
  assert.equal(applyCommand(room, "guest", { t: "join", name: "Боря" }, T0).error, undefined);
});

test("an empty room's clock stops, so coming back later does not land further on", () => {
  const room = roomWithGuest();
  applyCommand(room, "host", { t: "play", playing: true, position: 100, rate: 1, rev: 0 }, T0);
  applyCommand(room, "guest", { t: "leave" }, T0 + 10_000);
  assert.equal(room.play.playing, true);
  applyCommand(room, "host", { t: "leave" }, T0 + 20_000);
  assert.deepEqual([room.play.playing, room.play.position], [false, 120]);
});

test("rejoining with an empty name keeps the name; a crafted handover target is refused", () => {
  const room = createRoom({ code: "ABCDEF", hostId: "host", name: "", now: T0 });
  assert.equal(room.who.host.name, "Ведущий");
  applyCommand(room, "host", { t: "join", name: "" }, T0);
  assert.equal(room.who.host.name, "Ведущий");
  assert.equal(applyCommand(room, "host", { t: "host", target: "__proto__" }, T0).error, "no_such_peer");
  assert.equal(room.hostId, "host");
  assert.equal(applyCommand(room, "host", null, T0).error, "bad_command");
});
