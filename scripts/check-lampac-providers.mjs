import assert from "node:assert/strict";
import { normalizeEvents, BALANSER_LABELS, TORRENT_BALANSERS, normalizeSimilar, normalizeMovie, normalizeEpisodes, episodeSource } from "../src/utils/lampac-browser.js";

const events = normalizeEvents([
  { balanser: "phantom", name: "Phantom", url: "https://fleet.example/lite/phantom" },
  { balanser: "kinogo", name: "Kinogo", url: "https://fleet.example/lite/kinogo" },
  { balanser: "pidtor", name: "Pidtor", url: "https://fleet.example/lite/pidtor" },
  { balanser: "rutubemovie", name: "Old name", url: "https://fleet.example/lite/rutubemovie" },
  { balanser: "vkmovie", name: "Old name", url: "https://fleet.example/lite/vkmovie" },
  { balanser: "zetflix", name: "Zetflix", url: "https://fleet.example/lite/zetflix" },
  { balanser: "zetflixdb", name: "ZetflixDB", url: "https://fleet.example/lite/zetflixdb" },
]);

assert.deepEqual(events.map((entry) => entry.balanser), [
  "phantom", "kinogo", "pidtor", "rutubemovie", "vkmovie", "zetflix", "zetflixdb",
]);
assert.deepEqual(events.map((entry) => entry.name), [
  "Phantom", "Kinogo", "Торренты", "Rutube", "VK Видео", "Zetflix", "ZetflixDB",
]);
assert.equal(events.find((entry) => entry.balanser === "pidtor").torrent, true);
assert.equal(events.find((entry) => entry.balanser === "phantom").torrent, false);
assert.equal(BALANSER_LABELS.rutubemovie, "Rutube");
assert.equal(TORRENT_BALANSERS.has("pidtor"), true);

const duplicate = normalizeEvents([
  { balanser: "PHANTOM", name: "Phantom", url: "https://fleet.example/lite/phantom" },
  { balanser: "phantom", name: "Duplicate", url: "https://fleet.example/lite/phantom-2" },
  { balanser: "kinotochka", name: "HTML duplicate", url: "https://fleet.example/lite/kinotochka" },
]);
assert.deepEqual(duplicate.map((entry) => entry.balanser), ["phantom"]);

console.log(`Lampac provider fixtures passed (${events.length} requested providers)`);

const match = (data, ctx = {title: "Волейбол!!", originalTitle: "Haikyu!!", year: 2014}) => normalizeSimilar({data}, ctx).best;
const catalog = [
 {title: "Волейбол!! / Haikyuu!!", year: 2014, url: "https://source/series"},
 {title: "Волейбол!! — Спешл / Haikyuu!!: Special", year: 2014, url: "https://source/special"},
];
assert.equal(match(catalog)?.url, "https://source/series");
assert.equal(match([{title: "Волейбол!!", url: "https://source/series"}, {title: "Волейбол!! 2", url: "https://source/season2"}])?.url, "https://source/series");
assert.equal(match([{title: "Волейбол!!", year: 2015, url: "https://source/wrong-year"}]), null);
assert.equal(match([{title: "Волейбол!!", url: "https://source/a"}, {title: "Волейбол!!", url: "https://source/b"}]), null);
console.log("Lampac title matching checks passed: bilingual titles, absent year and ambiguous matches");

const callItem = {method: "call", url: "https://source/video?id=14", stream: "https://source/video?id=14&play=true", stream_p: "/api/lampac?u=stream", name: "14 серия", e: 14};
const episodeCall = episodeSource(normalizeEpisodes({data: [callItem]}).episodes[0]);
const movieCall = normalizeMovie({data: [callItem]}).voices[0];
for (const call of [episodeCall, movieCall]) {
  assert.equal(call.method, "call", "quality resolver remains the first choice");
  assert.equal(call.stream, callItem.stream);
  assert.equal(call.streamProxyUrl, callItem.stream_p);
}
assert.equal(episodeSource({item: {...callItem, stream: "javascript:bad"}}).stream, null);
console.log("Lampac published stream normalization checks passed");
