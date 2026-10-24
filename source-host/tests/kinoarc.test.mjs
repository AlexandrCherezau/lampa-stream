import assert from "node:assert/strict";
import test from "node:test";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import { createKinoarcProvider } from "../providers/kinoarc.mjs";

const movie = { type: "movie", title: "Animals", imdbId: "tt31049299" };
const embed = "https://api.nextembed.ws/embed/imdb/tt31049299";
const source = { hls: "https://cdn.test/master.m3u8", audio: { names: ["Русский", "English"] }, cc: [{ url: "https://cdn.test/ru.vtt", name: "Русские" }] };
const player = (value = source) => `makePlayer({source:${JSON.stringify(value)}});`;
const collect = async (iterator) => { const values = []; for await (const value of iterator) values.push(value); return values; };
function response(raw, text, headers = {}, statusCode = 200) {
  const body = Readable.from([Buffer.isBuffer(text) ? text : Buffer.from(text)]);
  body.headers = headers; body.statusCode = statusCode;
  return { response: body, url: new URL(raw) };
}
function fixture({ lookup = { available: true, embed_url: embed }, html = player(), metadata = null, request } = {}) {
  const requests = [];
  const transport = { async request(raw, options) {
    const url = new URL(raw); requests.push({ url, options });
    assert.equal(options.publicOnly, true);
    assert.equal(options.timeout, 8000);
    assert(options.signal instanceof AbortSignal);
    if (request) return request(url, options);
    if (url.pathname.startsWith("/api/v1/catalog/tmdb/")) return response(raw, JSON.stringify(metadata));
    if (url.origin === "https://kinoarc.net") return response(raw, JSON.stringify(lookup));
    return response(raw, html);
  } };
  return { adapter: createKinoarcProvider({ transport }), requests };
}

test("Kinoarc discovers IMDb Collaps and fresh native HLS preserves audio/subtitles without an iframe", async () => {
  const first = fixture();
  const [candidate] = await collect(first.adapter.discover(movie));
  assert.equal(first.requests.length, 1);
  assert.equal(first.requests[0].url.searchParams.get("imdb_id"), movie.imdbId);
  assert.equal(candidate.providerId, "kinoarc:collaps");
  assert.equal(candidate.catalogSource, "kinoarc");
  assert.equal(Object.keys(candidate).includes("ref"), false);
  assert.deepEqual(candidate.ref, { type: "movie", imdbId: movie.imdbId });
  const cold = fixture();
  const resolved = await cold.adapter.resolve(candidate);
  assert.equal(cold.requests.length, 2, "a cold instance rechecks lookup instead of trusting a stale embed");
  assert.equal(resolved.qualities[0].url, source.hls);
  assert.equal(resolved.qualities[0].type, "hls");
  assert.equal(resolved.qualities[0].publicOnly, true);
  assert.deepEqual(resolved.qualities[0].headers, { referer: embed, origin: "https://api.nextembed.ws" });
  assert.deepEqual(resolved.audioNames, source.audio.names);
  assert.equal(resolved.subtitles[0].label, "Русские");
  assert.equal(resolved.subtitles[0].publicOnly, true);
  await cold.adapter.resolve(candidate);
  assert.equal(cold.requests.length, 4, "manual retry always obtains fresh player media");
});

test("Kinoarc enriches missing IMDb through exact TMDB identity/name/year without a browser lookup", async () => {
  const title = { type: "tv", title: "Волейбол!!", originalTitle: "ハイキュー!!", tmdbId: 60863, year: 2014, season: 1, episode: 14 };
  const metadata = { id: 60863, name: title.title, original_name: title.originalTitle, first_air_date: "2014-04-06", external_ids: { imdb_id: "tt3398540" } };
  const f = fixture({ metadata, lookup: { available: true, embed_url: "https://api.nextembed.ws/embed/imdb/tt3398540" } });
  const [candidate] = await collect(f.adapter.discover(title));
  assert.equal(f.requests.length, 2);
  assert.equal(f.requests[0].url.pathname, "/api/v1/catalog/tmdb/tv/60863");
  assert.equal(f.requests[0].url.searchParams.get("append_to_response"), "external_ids");
  assert.deepEqual(candidate.ref, { type: "tv", imdbId: "tt3398540", season: 1, episode: 14 });
  for (const wrong of [{ ...metadata, id: 60864 }, { ...metadata, first_air_date: "2015-01-01" },
    { ...metadata, name: "Wrong", original_name: "Another" }, { ...metadata, external_ids: {} }]) {
    const invalid = fixture({ metadata: wrong });
    assert.deepEqual(await collect(invalid.adapter.discover(title)), []);
    assert.equal(invalid.requests.length, 1, "mismatched metadata must not reach player lookup");
  }
  const noIds = fixture();
  assert.deepEqual(await collect(noIds.adapter.discover({ type: "movie", title: "Unknown" })), []);
  assert.equal(noIds.requests.length, 0);
});

test("Kinoarc selects the exact TV episode and rejects altered references before network I/O", async () => {
  const title = { ...movie, type: "tv", season: 2, episode: 3 };
  const html = `makePlayer({playlist:{seasons:${JSON.stringify([{ season: 1, episodes: [{ episode: 3, hls: "https://cdn.test/wrong.m3u8" }] },
    { season: 2, episodes: [{ episode: 1, hls: "https://cdn.test/wrong.m3u8" }, { episode: 3, ...source }] }])}}});`;
  const f = fixture({ html });
  const [candidate] = await collect(f.adapter.discover(title));
  assert.equal((await f.adapter.resolve(candidate)).qualities[0].url, source.hls);
  const before = f.requests.length;
  for (const altered of [{ ...candidate, ref: candidate.ref, season: 1 }, { ...candidate, ref: candidate.ref, episode: 4 },
    { ...candidate, ref: candidate.ref, catalogSource: "habster" }, { ...candidate, ref: candidate.ref, voiceId: "untrusted" },
    { ...candidate, ref: { ...candidate.ref, imdbId: "https://evil.test/" } }]) await assert.rejects(f.adapter.resolve(altered), /Invalid|valid/);
  assert.equal(f.requests.length, before);
  const missing = fixture({ html: "makePlayer({playlist:{seasons:[]}});" });
  await assert.rejects(missing.adapter.resolve(candidate), /requested season/);
  await assert.rejects(collect(f.adapter.discover({ ...title, episode: undefined })), /exact/);
});

test("Kinoarc rejects foreign/private/mismatched embeds, malformed lookup and unavailable titles", async () => {
  for (const invalid of ["http://api.nextembed.ws/embed/imdb/tt31049299", "https://127.0.0.1/embed/imdb/tt31049299",
    "https://api.nextembed.ws.evil.test/embed/imdb/tt31049299", "https://user:pass@api.nextembed.ws/embed/imdb/tt31049299",
    embed + "?token=untrusted", embed + "#fragment", embed.replace("31049299", "1234567"), embed.replace("nextembed.ws", "nextembed.ws:444")]) {
    const f = fixture({ lookup: { available: true, embed_url: invalid } });
    await assert.rejects(collect(f.adapter.discover(movie)), /unsupported/);
    assert.equal(f.requests.length, 1);
  }
  const absent = fixture({ lookup: { available: false, embed_url: null } });
  assert.deepEqual(await collect(absent.adapter.discover(movie)), []);
  for (const lookup of [null, [], { available: "true", embed_url: embed }, { available: true }]) await assert.rejects(collect(fixture({ lookup }).adapter.discover(movie)), /invalid/);
  const redirected = fixture({ request: async (url) => ({ ...response(url, JSON.stringify({ available: true, embed_url: embed })), url: new URL("https://other.test/") }) });
  await assert.rejects(collect(redirected.adapter.discover(movie)), /redirect/);
});

test("Kinoarc bounds decoded body size, handles HTTP/encoding errors and cancels stalled bodies", async () => {
  for (const [body, headers, status] of [["denied", {}, 403], ["x", { "content-length": 1024 * 1024 + 1 }, 200],
    [gzipSync("x".repeat(1024 * 1024 + 1)), { "content-encoding": "gzip" }, 200], ["x", { "content-encoding": "unknown" }, 200]]) {
    const f = fixture({ request: async (url) => response(url, body, headers, status) });
    await assert.rejects(collect(f.adapter.discover(movie)), /HTTP 403|too large|encoding/);
  }
  const zipped = fixture({ request: async (url) => response(url, gzipSync(JSON.stringify({ available: false })), { "content-encoding": "gzip" }) });
  assert.deepEqual(await collect(zipped.adapter.discover(movie)), []);
  const controller = new AbortController();
  let requestSignal;
  const stalled = fixture({ request: async (url, options) => {
    requestSignal = options.signal;
    const body = new Readable({ read() {} }); body.headers = {}; body.statusCode = 200;
    setImmediate(() => controller.abort());
    return { response: body, url };
  } });
  await assert.rejects(collect(stalled.adapter.discover(movie, { signal: controller.signal })), { name: "AbortError" });
  assert(requestSignal.aborted);
});
