import assert from "node:assert/strict";
import test from "node:test";
import { Readable } from "node:stream";
import { createHabsterProvider, parseHabsterEmbed, parseHabsterPlayer } from "../providers/habster.mjs";

const movie = { type: "movie", kinopoiskId: 328, title: "Movie", catalogSource: "habster" };
const page = (id = 328, origin = "https://api.initem.ws") => `var KP_ID='${id}';var VARIYT_SRC='${origin}/embed/kp/'+KP_ID+'?host=partner.test&token=public-fixture';`;
const source = { hls: "https://cdn.test/movie/master.m3u8", audio: { names: ["Русский", "English"] },
  cc: [{ url: "https://cdn.test/ru.vtt", name: "Русские" }] };
const player = (value = source) => `makePlayer({ source: ${JSON.stringify(value)}, p2p: { callback: function(){throw Error('never execute')} } });`;
const response = (text, headers = {}, statusCode = 200) => {
  const stream = Readable.from([Buffer.from(text)]);
  stream.headers = headers; stream.statusCode = statusCode;
  return { response: stream };
};
const collect = async (iterator) => { const items = []; for await (const item of iterator) items.push(item); return items; };

test("Habster reads only the exact public embed literal and matching Kinopoisk title", () => {
  assert.equal(new URL(parseHabsterEmbed(page(), 328)).pathname, "/embed/kp/328");
  assert.throws(() => parseHabsterEmbed(page(329), 328), /does not match/);
  for (const origin of ["http://api.initem.ws", "https://evil.test", "https://api.initem.ws.evil.test", "https://user:pass@api.initem.ws"]) {
    assert.throws(() => parseHabsterEmbed(page(328, origin), 328), /unsupported/);
  }
  assert.throws(() => parseHabsterEmbed(page().replace("+KP_ID+", "+steal()+"), 328), /unavailable/);
  assert.throws(() => parseHabsterEmbed(page().replace("/embed/kp/", "/embed/movie/"), 328), /unsupported/);
});

test("Habster extracts HLS/subtitles without executing player JavaScript and selects exact TV episodes", () => {
  assert.deepEqual(parseHabsterPlayer(player(), movie), { hls: source.hls, audioNames: source.audio.names,
    subtitles: [{ url: source.cc[0].url, label: "Русские", language: null }] });
  assert.equal(parseHabsterPlayer(player().replace('"hls":', 'hls:'), movie).hls, source.hls);
  const series = { type: "tv", season: 2, episode: 3 };
  const seasons = [{ season: 1, episodes: [{ episode: 3, hls: "https://cdn.test/wrong.m3u8" }] },
    { season: 2, episodes: [{ episode: 1, hls: "https://cdn.test/wrong.m3u8" }, { episode: 3, ...source }] }];
  const html = `makePlayer({playlist:{seasons:${JSON.stringify(seasons)}}});`;
  assert.equal(parseHabsterPlayer(html, series).hls, source.hls);
  assert.deepEqual(parseHabsterPlayer(html, series).audioNames, source.audio.names);
  assert.throws(() => parseHabsterPlayer(html, { ...series, episode: 4 }), /requested episode/);
  assert.throws(() => parseHabsterPlayer(html, { ...series, season: 3 }), /requested season/);
  assert.throws(() => parseHabsterPlayer(player({ hls: "javascript:alert(1)" }), movie), /unsupported media/);
  assert.throws(() => parseHabsterPlayer(player({ hls: source.hls, cc: [{ url: "http://cdn.test/sub.vtt" }] }), movie), /unsupported media/);
  assert.throws(() => parseHabsterPlayer("makePlayer({source:{hls:evil()}})", movie), /HLS stream/);
  assert.throws(() => parseHabsterPlayer("makePlayer({ source: {", movie), /incomplete/);
  for (const names of [null, "Русский", [1], [" "], ["x".repeat(201)], Array(33).fill("Русский")]) {
    assert.throws(() => parseHabsterPlayer(player({ ...source, audio: { names } }), movie), /invalid audio names/);
    const tv = `makePlayer({playlist:{seasons:${JSON.stringify([{ season: 2, episodes: [{ episode: 3, ...source, audio: { names } }] }])}}});`;
    assert.throws(() => parseHabsterPlayer(tv, series), /invalid audio names/);
  }
  assert.deepEqual(parseHabsterPlayer(player({ hls: source.hls }), movie).audioNames, []);
  assert.deepEqual(parseHabsterPlayer(player({ ...source, audio: { names: [" Русский "] } }), movie).audioNames, ["Русский"]);
});

test("Habster discovery is immediate and cold resolve reads page-derived URLs with public-only media provenance", async () => {
  const requests = [];
  let refreshes = 0;
  const transport = { async request(raw, opts) {
    const url = new URL(raw); requests.push(url);
    assert.equal(opts.publicOnly, true);
    assert.equal(opts.timeout, 12_000);
    assert(opts.signal instanceof AbortSignal);
    if (url.origin === "https://habster.sbs") {
      assert.equal(url.pathname, "/film/328");
      refreshes++;
      return response(page().replace("public-fixture", `public-fixture-${refreshes}`));
    }
    assert.equal(url.origin, "https://api.initem.ws");
    assert.equal(opts.headers.referer, "https://habster.sbs/");
    assert.equal(opts.headers.origin, "https://habster.sbs");
    return response(player());
  } };
  const candidates = await collect(createHabsterProvider({ transport }).discover(movie));
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].providerId, "habster:collaps");
  assert.equal(candidates[0].voiceName, "Мультиаудио");
  assert.equal(Object.keys(candidates[0]).includes("ref"), false);
  assert.deepEqual(candidates[0].ref, { type: "movie", kinopoiskId: 328 });
  assert.equal(requests.length, 0, "known Kinopoisk titles need no availability preflight");
  const cold = createHabsterProvider({ transport });
  const resolved = await cold.resolve(candidates[0]);
  assert.equal(refreshes, 1);
  assert.equal(resolved.qualities[0].type, "hls");
  assert.deepEqual(resolved.audioNames, source.audio.names);
  assert(resolved.qualities.every((q) => q.publicOnly === true));
  assert(resolved.subtitles.every((s) => s.publicOnly === true));
  assert.equal(new URL(resolved.qualities[0].headers.referer).searchParams.get("token"), "public-fixture-1");
  await assert.rejects(cold.resolve({ ...candidates[0], ref: candidates[0].ref, catalogSource: "vi3000" }), /Invalid Habster/);
  await assert.rejects(cold.resolve({ ...candidates[0], ref: { ...candidates[0].ref, kinopoiskId: -1 } }), /valid Kinopoisk/);
  await assert.rejects(cold.resolve({ ...candidates[0], ref: candidates[0].ref, episode: 1 }), /episode reference/);
  assert.equal(requests.length, 2, "invalid references must not reach the network");
});

test("Habster bounds HTTP errors/body size and propagates cancellation through stalled bodies", async () => {
  for (const body of [response("bad", {}, 403), response("x", { "content-length": 1024 * 1024 + 1 }), response("x".repeat(1024 * 1024 + 1))]) {
    const adapter = createHabsterProvider({ transport: { async request() { return body; } } });
    const [candidate] = await collect(adapter.discover(movie));
    await assert.rejects(adapter.resolve(candidate), /HTTP 403|too large/);
  }
  const controller = new AbortController();
  const adapter = createHabsterProvider({ transport: { async request() {
    const stream = new Readable({ read() {} }); stream.headers = {}; stream.statusCode = 200;
    setImmediate(() => controller.abort());
    return { response: stream };
  } } });
  const [candidate] = await collect(adapter.discover(movie));
  await assert.rejects(adapter.resolve(candidate, { signal: controller.signal }), { name: "AbortError" });
  await assert.rejects(collect(adapter.discover(movie, { signal: controller.signal })), { name: "AbortError" });
  await assert.rejects(collect(adapter.discover({ ...movie, kinopoiskId: "328" })), /valid Kinopoisk/);
  await assert.rejects(collect(adapter.discover({ ...movie, type: "tv", season: 2 })), /exact season and episode/);
});

test("Habster TV discovery preserves the exact episode in sealed references and cold refresh", async () => {
  const title = { ...movie, type: "tv", season: 2, episode: 3 };
  const adapter = createHabsterProvider({ transport: { async request(raw) {
    const url = new URL(raw);
    if (url.origin === "https://habster.sbs") {
      assert.equal(url.pathname, "/series/328");
      return response(page());
    }
    return response(`makePlayer({playlist:{seasons:${JSON.stringify([{ season: 2, episodes: [{ episode: 3, ...source }] }])}}});`);
  } } });
  const [candidate] = await collect(adapter.discover(title));
  assert.deepEqual(candidate.ref, { type: "tv", kinopoiskId: 328, season: 2, episode: 3 });
  assert.equal((await adapter.resolve(candidate)).qualities[0].url, source.hls);
  assert.deepEqual((await adapter.resolve(candidate)).audioNames, source.audio.names);
  await assert.rejects(adapter.resolve({ ...candidate, ref: candidate.ref, episode: 4 }), /episode reference/);
});

test("Habster maps missing KP only through one exact title/year/type search and matching public info", async () => {
  const title = { type: "movie", title: "Человек-паук: Новый день", originalTitle: "Spider-Man: Brand New Day", year: 2026, imdbId: "tt22084616" };
  const card = { kp_id: "5494049", name_ru: title.title, name: title.originalTitle, year: 2026, category: "movie" };
  const info = { kinopoiskId: 5494049, nameRu: title.title, nameOriginal: title.originalTitle, year: 2026, type: "FILM", imdbId: title.imdbId };
  const requests = [];
  const adapter = createHabsterProvider({ transport: { async request(raw, opts) {
    const url = new URL(raw); requests.push(url);
    assert.equal(url.origin, "https://habster.sbs");
    assert.equal(opts.publicOnly, true);
    if (url.pathname === "/search.php") {
      assert.equal(url.searchParams.get("q"), title.originalTitle);
      return response(JSON.stringify({ results: [{ ...card, kp_id: "838", year: 2002 }, card, { ...card, category: "serial", kp_id: "100" }] }));
    }
    assert.equal(url.pathname, "/getinfo.php");
    assert.equal(url.searchParams.get("kp_id"), "5494049");
    return response(JSON.stringify(info));
  } } });
  const [candidate] = await collect(adapter.discover(title));
  assert.equal(candidate.ref.kinopoiskId, 5494049);
  assert.equal(candidate.ref.type, "movie");
  assert.equal(requests.length, 2, "neither the title page nor player embed is an availability preflight");
  const tvTitle = { ...title, type: "tv", season: 2, episode: 3 };
  const tv = createHabsterProvider({ transport: { async request(raw) {
    return response(JSON.stringify(new URL(raw).pathname === "/search.php"
      ? { results: [{ ...card, category: "series" }] } : { ...info, type: "MINI_SERIES" }));
  } } });
  const [episode] = await collect(tv.discover(tvTitle));
  assert.deepEqual(episode.ref, { type: "tv", kinopoiskId: 5494049, season: 2, episode: 3 });
});

test("Habster refuses ambiguous titles, years, categories, IDs and mismatched info/IMDb without guessing", async () => {
  const title = { type: "movie", title: "Exact film", year: 2026, imdbId: "tt1234567" };
  const card = { kp_id: "123", name_ru: "Exact film", year: 2026, category: "movie" };
  const info = { kinopoiskId: 123, nameRu: title.title, year: 2026, type: "FILM", imdbId: title.imdbId };
  for (const [results, metadata, expectedCalls] of [
    [[{ ...card, name_ru: "Another film" }], info, 1],
    [[{ ...card, year: 2025 }], info, 1],
    [[{ ...card, category: "serial" }], info, 1],
    [[{ ...card, kp_id: "https://evil.test/123" }], info, 1],
    [[card, { ...card, kp_id: "124" }], info, 1],
    [[card], { ...info, imdbId: "tt7654321" }, 2],
    [[card], { ...info, kinopoiskId: 124 }, 2],
    [[card], { ...info, type: "TV_SERIES" }, 2],
    [[card], { ...info, year: 2025 }, 2],
    [[card], { ...info, nameRu: "Another film" }, 2],
  ]) {
    let calls = 0;
    const adapter = createHabsterProvider({ transport: { async request() { return response(JSON.stringify(++calls === 1 ? { results } : metadata)); } } });
    assert.deepEqual(await collect(adapter.discover(title)), []);
    assert.equal(calls, expectedCalls);
  }
  let calls = 0;
  const adapter = createHabsterProvider({ transport: { async request() { calls++; throw new Error("unexpected request"); } } });
  assert.deepEqual(await collect(adapter.discover({ ...title, year: undefined })), []);
  assert.equal(calls, 0, "without an exact year there is no safe Habster search");
});

test("Habster search+info shares a three-second body deadline and follows caller cancellation", async () => {
  let bodyAborted = false;
  const adapter = createHabsterProvider({ transport: { async request(_raw, opts) {
    const stream = new Readable({ read() {} }); stream.headers = {}; stream.statusCode = 200;
    opts.signal.addEventListener("abort", () => { bodyAborted = true; }, { once: true });
    return { response: stream };
  } } });
  const before = Date.now();
  await assert.rejects(collect(adapter.discover({ type: "movie", title: "Exact film", year: 2026 })), { name: "TimeoutError" });
  assert(bodyAborted);
  assert(Date.now() - before < 4000);
  const controller = new AbortController();
  const pending = collect(adapter.discover({ type: "movie", title: "Exact film", year: 2026 }, { signal: controller.signal }));
  controller.abort();
  await assert.rejects(pending, { name: "AbortError" });
});
