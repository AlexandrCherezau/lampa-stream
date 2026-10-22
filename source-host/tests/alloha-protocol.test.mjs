import assert from "node:assert/strict";
import test from "node:test";
import { createAllohaBorth, parseAllohaBootstrap, parseAllohaSerialEpisode, parseAllohaGuard, parseAllohaSources, openAllohaPlayback } from "../providers/alloha-protocol.mjs";

const bootstrap = `<meta name="viewporti" content="abcdefghi"><script src="/build/app.fixture.js"></script><script>fileList = JSON.parse('{"type":"movie","active":{"id":123}}')</script>`;
const data = { hlsSource: [{ audioId: "1", label: "Русский", quality: { "2160": "https://cdn.test/4k.m3u8 or https://backup.test/4k.m3u8", "720": "https://cdn.test/720.m3u8" } }], pnr: "wss://befriend.stravers.live/ws/", pnk: "anonymous-fixture" };

test("Alloha safely reads the anonymous bootstrap, permutations and current public bundle guard", () => {
  assert.equal(createAllohaBorth("abcdefghi").split("|")[1], "edaficbgh");
  const parsed = parseAllohaBootstrap(bootstrap);
  assert.equal(parsed.movieId, "123");
  assert.equal(parsed.type, "movie");
  assert.equal(parsed.bundleUrl, "https://befriend.stravers.live/build/app.fixture.js");
  assert.match(parsed.borth, /^[a-f0-9]{64}\|edaficbgh$/);
  const guard = `return r['a'](0,'${"x".repeat(380)}')`;
  assert.equal(parseAllohaGuard(guard), "x".repeat(380));
  for (const html of [bootstrap.replace('content="abcdefghi"', 'content=""'), bootstrap.replace('"id":123', '"id":-1'), bootstrap.replace('/build/app.fixture.js', 'https://evil.test/build/app.fixture.js'), bootstrap.replace("JSON.parse('", "execute('")]) assert.throws(() => parseAllohaBootstrap(html));
  assert.throws(() => parseAllohaGuard("execute()"), /unavailable/);
  assert.throws(() => parseAllohaGuard(`${guard}; ${guard}`), /unavailable/);
  const currentBundleShape = `var strings=['ordinary','${"y".repeat(380)}','player'];`;
  assert.equal(parseAllohaGuard(currentBundleShape), "y".repeat(380), "the current bundle stores its guard in a string table");
  assert.throws(() => parseAllohaGuard(`${currentBundleShape}var another='${"z".repeat(380)}'`), /unavailable/);
});

test("Alloha serial bootstrap selects only the requested episode and a matching available translation", () => {
  const list = { type: "serial", active: { id: 206, id_translation: 13, seasons: 2, episode: 6 }, translationList: [13, 234], all: {
    1: { 1: { t234: { id: 101, id_translation: 234, seasons: 1, episode: 1, translation: "Dub", uhd: 1 } } },
    2: { 6: { t13: { id: 206, id_translation: 13, seasons: 2, episode: 6, translation: "Original", uhd: 0 } } },
  } };
  const html = bootstrap.replace('{"type":"movie","active":{"id":123}}', JSON.stringify(list));
  const parsed = parseAllohaBootstrap(html);
  assert.equal(parsed.type, "serial");
  assert.equal(parseAllohaSerialEpisode(parsed, 2, 6).id, "206");
  assert.equal(parseAllohaSerialEpisode(parsed, 2, 6).name, "Original");
  assert.equal(parseAllohaSerialEpisode(parsed, 1, 1).id, "101");
  assert.equal(parseAllohaSerialEpisode(parsed, 1, 1).uhd, true);
  assert.equal(parseAllohaSerialEpisode(parsed, 1, 1, 234).translationId, "234");
  assert.throws(() => parseAllohaSerialEpisode(parsed, 2, 6, 234), /matching series translation/);
  assert.throws(() => parseAllohaSerialEpisode(parsed, 2, 1), /requested series episode/);
  assert.throws(() => parseAllohaSerialEpisode(parsed, 0, 6), /exact series episode/);
  const ambiguous = { ...parsed, active: {}, translationList: [], all: { 1: { 1: {
    t234: { id: 101, id_translation: 234, seasons: 1, episode: 1, translation: "Dub" },
    t13: { id: 102, id_translation: 13, seasons: 1, episode: 1, translation: "Original" },
  } } } };
  assert.throws(() => parseAllohaSerialEpisode(ambiguous, 1, 1), /matching series translation/);
  const mismatch = { ...parsed, all: { 2: { 6: { t13: { id: 206, id_translation: 13, seasons: 1, episode: 6, translation: "Wrong" } } } } };
  assert.throws(() => parseAllohaSerialEpisode(mismatch, 2, 6), /invalid series episode/);
});

test("Alloha retains all quality/voice ladders and rejects private protocol origins, unsafe media and ambiguous voice IDs", () => {
  const parsed = parseAllohaSources(data);
  assert.deepEqual(parsed.voices[0].qualities.map(q => q.height), [720, 2160]);
  assert.equal(parsed.voices[0].qualities[1].urls.length, 2);
  assert.equal(new URL(parsed.websocketUrl).origin, "wss://befriend.stravers.live");
  for (const pnr of ["ws://befriend.stravers.live/ws/", "wss://evil.test/ws/", "wss://befriend.stravers.live/private", "wss://user:pass@befriend.stravers.live/ws/"]) assert.throws(() => parseAllohaSources({ ...data, pnr }), /unsupported/);
  assert.throws(() => parseAllohaSources({ ...data, hlsSource: [data.hlsSource[0], data.hlsSource[0]] }), /invalid audio/);
  assert.throws(() => parseAllohaSources({ ...data, hlsSource: [{ ...data.hlsSource[0], quality: { "2160": "javascript:execute()" } }] }), /unsupported/);
});

class PlaybackSocket extends EventTarget {
  static sockets = [];
  constructor() { super(); this.closed = false; PlaybackSocket.sockets.push(this); queueMicrotask(() => this.dispatchEvent(new Event("open"))); }
  send(raw) { this.sent = JSON.parse(raw); queueMicrotask(() => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "config_update", edge_hash: "anonymous_hash_fixture" }) }))); }
  close() { this.closed = true; }
}
test("Alloha obtains a normal playback session and closes its socket after metadata or caller cancellation", async () => {
  const voice = parseAllohaSources(data).voices[0];
  assert.equal(await openAllohaPlayback("wss://befriend.stravers.live/ws/", voice, { WebSocketImpl: PlaybackSocket }), "anonymous_hash_fixture");
  assert(PlaybackSocket.sockets.at(-1).closed);
  assert.equal(PlaybackSocket.sockets.at(-1).sent.resolution, "720");
  assert.equal(PlaybackSocket.sockets.at(-1).sent.track_id, "1");
  class StalledSocket extends PlaybackSocket { send() {} }
  const controller = new AbortController();
  const pending = openAllohaPlayback("wss://befriend.stravers.live/ws/", voice, { WebSocketImpl: StalledSocket, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  assert(PlaybackSocket.sockets.at(-1).closed);
});
