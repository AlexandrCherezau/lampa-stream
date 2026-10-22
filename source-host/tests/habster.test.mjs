import assert from "node:assert/strict";
import test from "node:test";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";
import { createHabsterProvider, parseHabsterEmbed, parseHabsterAllohaEmbed, parseHabsterPlayer, selectAllohaEpisodeVoice } from "../providers/habster.mjs";

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
const collect = async (iterator, limit = 2) => { const items = []; for await (const item of iterator) { items.push(item); if (items.length >= limit) break; } return items; };

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
  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].providerId, "habster:alloha");
  const collapsCandidate = candidates[1];
  assert.equal(collapsCandidate.providerId, "habster:collaps");
  assert.equal(collapsCandidate.voiceName, "Мультиаудио");
  assert.equal(Object.keys(collapsCandidate).includes("ref"), false);
  assert.deepEqual(collapsCandidate.ref, { type: "movie", kinopoiskId: 328 });
  assert.equal(requests.length, 0, "known Kinopoisk titles need no availability preflight");
  const cold = createHabsterProvider({ transport });
  const resolved = await cold.resolve(collapsCandidate);
  assert.equal(refreshes, 1);
  assert.equal(resolved.qualities[0].type, "hls");
  assert.deepEqual(resolved.audioNames, source.audio.names);
  assert(resolved.qualities.every((q) => q.publicOnly === true));
  assert(resolved.subtitles.every((s) => s.publicOnly === true));
  assert.equal(new URL(resolved.qualities[0].headers.referer).searchParams.get("token"), "public-fixture-1");
  await assert.rejects(cold.resolve({ ...collapsCandidate, ref: collapsCandidate.ref, catalogSource: "vi3000" }), /Invalid Habster/);
  await assert.rejects(cold.resolve({ ...collapsCandidate, ref: { ...collapsCandidate.ref, kinopoiskId: -1 } }), /valid Kinopoisk/);
  await assert.rejects(cold.resolve({ ...collapsCandidate, ref: collapsCandidate.ref, episode: 1 }), /episode reference/);
  assert.equal(requests.length, 2, "invalid references must not reach the network");
});

test("Habster bounds HTTP errors/body size and propagates cancellation through stalled bodies", async () => {
  for (const body of [response("bad", {}, 403), response("x", { "content-length": 1024 * 1024 + 1 }), response("x".repeat(1024 * 1024 + 1))]) {
    const adapter = createHabsterProvider({ transport: { async request() { return body; } } });
    const [, candidate] = await collect(adapter.discover(movie));
    await assert.rejects(adapter.resolve(candidate), /HTTP 403|too large/);
  }
  const controller = new AbortController();
  const adapter = createHabsterProvider({ transport: { async request() {
    const stream = new Readable({ read() {} }); stream.headers = {}; stream.statusCode = 200;
    setImmediate(() => controller.abort());
    return { response: stream };
  } } });
  const [, candidate] = await collect(adapter.discover(movie));
  await assert.rejects(adapter.resolve(candidate, { signal: controller.signal }), { name: "AbortError" });
  await assert.rejects(collect(adapter.discover(movie, { signal: controller.signal })), { name: "AbortError" });
  await assert.rejects(collect(adapter.discover({ ...movie, kinopoiskId: "328" })), /valid Kinopoisk/);
  await assert.rejects(collect(adapter.discover({ ...movie, type: "tv", season: 2 })), /exact season and episode/);
});

test("Habster bounds decoded compressed responses rather than only compressed wire bytes", async () => {
  const good = createHabsterProvider({ transport: { async request(raw) {
    return response(gzipSync(new URL(raw).origin === "https://habster.sbs" ? page() : player()), { "content-encoding": "gzip" });
  } } });
  const [, candidate] = await collect(good.discover(movie));
  assert.equal((await good.resolve(candidate)).qualities[0].url, source.hls);
  const bomb = createHabsterProvider({ transport: { async request() {
    return response(gzipSync("x".repeat(1024 * 1024 + 1)), { "content-encoding": "gzip" });
  } } });
  await assert.rejects(bomb.resolve(candidate), /too large/);
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
  const [alloha, candidate] = await collect(adapter.discover(title), 2);
  assert.deepEqual(alloha.ref, { type: "tv", kinopoiskId: 328, voiceId: "default", season: 2, episode: 3 });
  assert.deepEqual(candidate.ref, { type: "tv", kinopoiskId: 328, season: 2, episode: 3 });
  assert.equal(candidate.providerId, "habster:collaps");
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
  assert.deepEqual(episode.ref, { type: "tv", kinopoiskId: 5494049, voiceId: "default", season: 2, episode: 3 });
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

const allohaPage = (id = 328, origin = "https://befriend.stravers.live") => `var KP_ID='${id}'; var BEFRIEND_SRC='${origin}/?token=public-fixture&kp=' + KP_ID;`;

function allohaFixtureTransport({ bundle = "/build/app.v1.js", guard = "g".repeat(380), waitBundle } = {}) {
  const stats = { bundles: 0, posts: 0 };
  let signalPost;
  let signalSecondPost;
  const postStarted = new Promise((resolve) => { signalPost = resolve; });
  const twoPostsStarted = new Promise((resolve) => { signalSecondPost = resolve; });
  return {
    stats,
    postStarted,
    twoPostsStarted,
    transport: { async request(raw, options) {
      const url = new URL(raw);
      if (url.origin === "https://habster.sbs") {
        const id = Number(url.pathname.split("/").at(-1));
        return response(allohaPage(id).replace("public-fixture", `fixture-${id}`));
      }
      if (url.origin !== "https://befriend.stravers.live") throw new Error(`Unexpected fixture URL: ${url.origin}`);
      if (url.pathname === "/") {
        const id = Number(url.searchParams.get("kp"));
        const currentBundle = typeof bundle === "function" ? bundle() : bundle;
        return response(`<meta name="viewporti" content="abcdefghi"><script src="${currentBundle}"></script><script>fileList = JSON.parse('{"type":"movie","active":{"id":${id + 1000}}}')</script>`);
      }
      if (url.pathname.startsWith("/build/")) {
        stats.bundles++;
        if (waitBundle) await waitBundle;
        return response(`return r['a'](1,'${guard}')`);
      }
      if (url.pathname.startsWith("/bnsi/movies/")) {
        assert.equal(options.method, "POST");
        stats.posts++;
        signalPost();
        if (stats.posts === 2) signalSecondPost();
        const id = Number(url.pathname.split("/").at(-1));
        return response(JSON.stringify({ hlsSource: [{ audioId: "1", label: "Audio", default: true,
          quality: { "720": `https://cdn.test/${id}.m3u8` } }], tracks: [], pnr: "wss://befriend.stravers.live/ws/", pnk: `sid-${id}` }));
      }
      throw new Error(`Unexpected Alloha path: ${url.pathname}`);
    } },
  };
}

async function allohaDefault(adapter, kinopoiskId) {
  return (await adapter.discover({ ...movie, kinopoiskId }).next()).value;
}

test("Habster Alloha reads a matching anonymous page literal and rejects injected origin/title/expression", () => {
  const url = new URL(parseHabsterAllohaEmbed(allohaPage(), 328));
  assert.equal(url.origin, "https://befriend.stravers.live");
  assert.equal(url.searchParams.get("kp"), "328");
  assert.throws(() => parseHabsterAllohaEmbed(allohaPage(329), 328), /does not match/);
  for (const origin of ["http://befriend.stravers.live", "https://befriend.stravers.live.evil.test", "https://user:pass@befriend.stravers.live", "https://evil.test"]) {
    assert.throws(() => parseHabsterAllohaEmbed(allohaPage(328, origin), 328), /unsupported/);
  }
  for (const replacement of ["/?kp=329&token=public-fixture&kp=", "/?token=public-fixture&other=evil&kp=", "/embed?token=public-fixture&kp=", "/?kp="]) {
    assert.throws(() => parseHabsterAllohaEmbed(allohaPage().replace("/?token=public-fixture&kp=", replacement), 328), /unsupported/);
  }
  assert.throws(() => parseHabsterAllohaEmbed(allohaPage().replace(" + KP_ID", " + execute()"), 328), /unavailable/);
  assert.throws(() => parseHabsterAllohaEmbed(allohaPage().replace(" + KP_ID", " + KP_ID + '#evil'"), 328), /unavailable/);
});

test("Alloha serial translation matching fails closed except for the observed anonymous numeric singleton", () => {
  const choice = { name: "Red Head Sound" };
  const rhs = { id: "2", name: "(Russian) Red Head Sound" };
  assert.equal(selectAllohaEpisodeVoice([{ id: "1", name: "1" }, rhs], choice), rhs);
  assert.equal(selectAllohaEpisodeVoice([rhs], { name: "Дубляж Red Head Sound" }), rhs);
  assert.deepEqual(selectAllohaEpisodeVoice([{ id: "1", name: "1" }], { name: "Coldfilm" }), { id: "1", name: "1" });
  assert.throws(() => selectAllohaEpisodeVoice([{ id: "1", name: "Original" }], choice), /selected series translation/);
  assert.throws(() => selectAllohaEpisodeVoice([rhs, { id: "3", name: "Red Head Sound" }], choice), /selected series translation/);
});

test("Habster exposes native Alloha qualities and independent voice candidates from a shared anonymous session", async () => {
  let calls = 0, playbackCalls = 0;
  const data = { hlsSource: [
    { audioId: "1", label: "MovieDalen", default: true, quality: { "2160": "https://cdn.test/4k.m3u8 or https://backup.test/4k.m3u8", "720": "https://cdn.test/720.m3u8" } },
    { audioId: "2", label: "HDrezka Studio", quality: { "2160": "https://cdn.test/4k-ru.m3u8", "720": "https://cdn.test/720-ru.m3u8" } },
  ], tracks: [{ kind: "subtitles", label: "Русские", language: "ru", src: "https://cdn.test/ru.vtt" }], pnr: "wss://befriend.stravers.live/ws/", pnk: "anonymous-fixture" };
  const transport = { async request(raw, options) {
    const url = new URL(raw);
    assert.equal(options.publicOnly, true);
    if (url.origin === "https://habster.sbs") { calls++; return response(allohaPage().replace("public-fixture", `public-fixture-${calls}`)); }
    if (url.pathname === "/") return response(`<meta name="viewporti" content="abcdefghi"><script src="/build/app.fixture.js"></script><script>fileList = JSON.parse('{"type":"movie","active":{"id":123}}')</script>`);
    if (url.pathname === "/build/app.fixture.js") return response(`return r['a'](1,'${"x".repeat(380)}')`);
    assert.equal(url.pathname, "/bnsi/movies/123");
    assert.equal(options.method, "POST");
    assert.equal(new URLSearchParams(options.body).get("token"), `public-fixture-${calls}`);
    assert.equal(new URLSearchParams(options.body).get("audio"), "");
    assert.equal(new URLSearchParams(options.body).get("subtitle"), "");
    assert.equal(options.headers.origin, "https://befriend.stravers.live");
    assert.match(options.headers.borth, /^[0-9a-f]{64}\|/);
    return response(JSON.stringify(data));
  } };
  const allohaPlayback = async (_url, voice, { signal }) => { playbackCalls++; assert.equal(voice.id, "1"); assert(signal instanceof AbortSignal); return "anonymous-edge-fixture"; };
  const adapter = createHabsterProvider({ transport, allohaPlayback });
  const iterator = adapter.discover(movie);
  const first = (await iterator.next()).value;
  assert.equal(first.providerId, "habster:alloha");
  assert.equal(first.voiceId, "default");
  assert.equal(calls, 0, "default source is available before any player metadata I/O");
  assert.equal(JSON.stringify(first).includes("token"), false);
  const pending = adapter.resolve(first);
  const remaining = await collect(iterator, 10);
  const resolved = await pending;
  assert.deepEqual(remaining.map((item) => item.voiceId), ["multi", "alloha:1", "alloha:2"]);
  assert.equal(calls, 1); assert.equal(playbackCalls, 1);
  assert.equal(resolved.kind, undefined, "there is no iframe resolve variant");
  assert.deepEqual(resolved.qualities.map((item) => item.label), ["720p", "2160p"]);
  assert(resolved.qualities.every((item) => item.publicOnly && item.type === "hls"));
  assert.equal(resolved.qualities[1].height, 2160);
  assert.deepEqual(resolved.audioNames, ["MovieDalen"]);
  const russian = await adapter.resolve(remaining[2]);
  assert.deepEqual(russian.audioNames, ["HDrezka Studio"]);
  assert.equal(russian.qualities[1].url, "https://cdn.test/4k-ru.m3u8");
  assert.equal(russian.subtitles[0].publicOnly, true);
  assert.equal(russian.qualities[0].headers.authorizations, `Bearer ${"x".repeat(380)}`);
  await createHabsterProvider({ transport, allohaPlayback }).resolve(first);
  assert.equal(calls, 2, "a cold instance uses fresh title-specific public token data");
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const shared = createHabsterProvider({ allohaPlayback, transport: { async request(raw, options) {
    if (new URL(raw).origin === "https://habster.sbs") await gate;
    return transport.request(raw, options);
  } } });
  const controller = new AbortController();
  const cancelled = shared.resolve(first, { signal: controller.signal });
  const survivor = shared.resolve(first);
  controller.abort();
  await assert.rejects(cancelled, { name: "AbortError" });
  release();
  assert.equal((await survivor).qualities[1].height, 2160, "one caller cannot abort a shared anonymous metadata refresh");
  await assert.rejects(adapter.resolve({ ...first, ref: first.ref, voiceId: "embedded" }), /Invalid Habster/);
  await assert.rejects(adapter.resolve({ ...first, ref: { ...first.ref, voiceId: "alloha:3" } }), /Invalid Habster/);
  await assert.rejects(adapter.resolve({ ...first, voiceId: "alloha:3", ref: { ...first.ref, voiceId: "alloha:3" } }), /requested audio/);
  await assert.rejects(adapter.resolve({ ...first, voiceId: "alloha:3", ref: { ...first.ref, type: "tv", voiceId: "alloha:3", season: 1, episode: 1 }, season: 1, episode: 1 }), /exact series translation/);
});

test("Habster Alloha resolves the exact serial episode from the public episode map before using native HLS", async () => {
  const id = 5512084;
  const title = { type: "tv", kinopoiskId: id, title: "Reference series", season: 2, episode: 6, catalogSource: "habster" };
  const fileList = { type: "serial", active: { id: 900, id_translation: 13, seasons: 2, episode: 6 }, translationList: [13, 234], all: {
    1: { 1: { t234: { id: 101, id_translation: 234, seasons: 1, episode: 1, translation: "Dub", uhd: 1 } } },
    2: { 6: {
      t13: { id: 206, id_translation: 13, seasons: 2, episode: 6, translation: "Original", uhd: 0 },
      t234: { id: 207, id_translation: 234, seasons: 2, episode: 6, translation: "Red Head Sound", uhd: 1 },
    } },
  } };
  const media = { hlsSource: [{ audioId: "1", label: "Original", default: true,
    quality: { "720": "https://cdn.test/720.m3u8", "2160": "https://cdn.test/4k.m3u8" } },
  { audioId: "2", label: "(Russian) Red Head Sound", default: false,
    quality: { "720": "https://cdn.test/rhs-720.m3u8", "2160": "https://cdn.test/rhs-4k.m3u8" } }], tracks: [],
  pnr: "wss://befriend.stravers.live/ws/", pnk: "serial-session" };
  const requests = [];
  const adapter = createHabsterProvider({ allohaPlayback: async () => "serial-edge", transport: { async request(raw, options) {
    const url = new URL(raw); requests.push({ url, options });
    if (url.origin === "https://habster.sbs") {
      assert.equal(url.pathname, `/series/${id}`);
      return response(allohaPage(id));
    }
    if (url.pathname === "/") {
      assert.equal(url.searchParams.get("kp"), String(id));
      return response(`<meta name="viewporti" content="abcdefghi"><script src="/build/app.serial.js"></script><script>fileList = JSON.parse('${JSON.stringify(fileList)}')</script>`);
    }
    if (url.pathname === "/build/app.serial.js") return response(`return r['a'](1,'${"g".repeat(380)}')`);
    if (url.pathname.startsWith("/bnsi/")) {
      assert(["/bnsi/movies/206", "/bnsi/movies/207"].includes(url.pathname), "Alloha uses the exact selected episode/translation ID through its public movie resolver");
      assert.equal(options.method, "POST");
      const body = new URLSearchParams(options.body);
      assert.equal(body.get("token"), "public-fixture");
      assert.equal(body.get("av1"), "true");
      return response(JSON.stringify(media));
    }
    throw new Error(`Unexpected Alloha URL: ${url.pathname}`);
  } } });
  const iterator = adapter.discover(title);
  const candidate = (await iterator.next()).value;
  assert.equal(candidate.providerId, "habster:alloha");
  assert.deepEqual(candidate.ref, { type: "tv", kinopoiskId: id, voiceId: "default", season: 2, episode: 6 });
  assert.equal(requests.length, 0, "the Alloha option appears without waiting on source metadata");
  assert.equal((await iterator.next()).value.providerId, "habster:collaps");
  const original = (await iterator.next()).value;
  assert.deepEqual(original.ref, { type: "tv", kinopoiskId: id, voiceId: "alloha-translation:13", season: 2, episode: 6, translationId: "13" });
  const redHeadSound = (await iterator.next()).value;
  assert.equal(redHeadSound.voiceId, "alloha-translation:234", "episode-map translations remain independent choices");
  assert.equal(redHeadSound.qualityHint, "До 4K");
  assert.deepEqual(redHeadSound.ref, { type: "tv", kinopoiskId: id, voiceId: "alloha-translation:234", season: 2, episode: 6, translationId: "234" });
  const result = await adapter.resolve(candidate);
  assert.deepEqual(result.qualities.map(({ label, height }) => [label, height]), [["720p", 720], ["2160p", 2160]]);
  assert.deepEqual(result.audioNames, ["Original"]);
  assert(result.qualities.every((quality) => quality.publicOnly));
  assert.equal(requests.filter(({ url }) => url.pathname.startsWith("/bnsi/")).length, 1);
  const alternate = await adapter.resolve(redHeadSound);
  assert.deepEqual(alternate.audioNames, ["(Russian) Red Head Sound"]);
  assert(alternate.qualities.some((quality) => quality.height === 2160));
  assert.equal(requests.filter(({ url }) => url.pathname.startsWith("/bnsi/")).length, 2, "translation IDs have separate cache entries and POSTs");
  assert.deepEqual(requests.filter(({ url }) => url.pathname.startsWith("/bnsi/")).map(({ url }) => url.pathname).sort(), ["/bnsi/movies/206", "/bnsi/movies/207"]);

  const wrongEpisode = { ...candidate, season: 1, ref: { ...candidate.ref, season: 1 } };
  await assert.rejects(adapter.resolve(wrongEpisode), /requested series episode/);
  assert.equal(requests.filter(({ url }) => url.pathname.startsWith("/bnsi/")).length, 2, "a missing episode never falls through to active.id or another episode");
});

test("Habster starts Alloha source lookup alongside the bundle and shares one guard fetch across titles", async () => {
  let releaseBundle;
  const bundleGate = new Promise((resolve) => { releaseBundle = resolve; });
  const fixture = allohaFixtureTransport({ waitBundle: bundleGate });
  const adapter = createHabsterProvider({ transport: fixture.transport, allohaPlayback: async () => "edge" });
  const first = await allohaDefault(adapter, 328);
  const second = await allohaDefault(adapter, 329);

  const firstResolve = adapter.resolve(first);
  await fixture.postStarted;
  assert.equal(fixture.stats.bundles, 1);
  const secondResolve = adapter.resolve(second);
  await fixture.twoPostsStarted;
  assert.equal(fixture.stats.posts, 2, "the bnsi request starts while the shared bundle response is still pending");
  assert.equal(fixture.stats.bundles, 1, "distinct film titles share the same in-flight versioned bundle request");

  releaseBundle();
  const [a, b] = await Promise.all([firstResolve, secondResolve]);
  assert.equal(a.qualities[0].headers.authorizations, `Bearer ${"g".repeat(380)}`);
  assert.equal(b.qualities[0].headers.authorizations, a.qualities[0].headers.authorizations);
});

test("Habster refreshes a failed guard and follows the current hashed bundle URL", async () => {
  let bundle = "/build/app.v1.js";
  let guard = "bad";
  const fixture = allohaFixtureTransport({ bundle: () => bundle, guard });
  const adapter = createHabsterProvider({ transport: {
    async request(raw, options) {
      const url = new URL(raw);
      if (url.pathname.startsWith("/build/")) {
        fixture.stats.bundles++;
        return response(guard === "bad" ? "no guard here" : `return r['a'](1,'${guard}')`);
      }
      return fixture.transport.request(raw, options);
    },
  }, allohaPlayback: async () => "edge" });
  const first = await allohaDefault(adapter, 338);
  await assert.rejects(adapter.resolve(first), /protocol guard is unavailable/);
  assert.equal(fixture.stats.bundles, 1);

  guard = "h".repeat(380);
  await adapter.resolve(first);
  assert.equal(fixture.stats.bundles, 2, "a failed parse is evicted and the same URL is fetched again");

  bundle = "/build/app.v2.js";
  const next = await allohaDefault(adapter, 339);
  const resolved = await adapter.resolve(next);
  assert.equal(fixture.stats.bundles, 3, "bundle URL rotation forces a fresh guard fetch");
  assert.equal(resolved.qualities[0].headers.authorizations, `Bearer ${guard}`);
});

test("Habster aborts a stalled title POST when the parallel guard request fails", async () => {
  let releaseBundle;
  const bundleGate = new Promise((resolve) => { releaseBundle = resolve; });
  const fixture = allohaFixtureTransport({ guard: "bad", waitBundle: bundleGate });
  let signalPostStarted;
  const postStarted = new Promise((resolve) => { signalPostStarted = resolve; });
  let postAborted = false;
  const adapter = createHabsterProvider({ transport: { async request(raw, options) {
    if (new URL(raw).pathname.startsWith("/bnsi/movies/")) {
      const stream = new Readable({ read() {} }); stream.headers = {}; stream.statusCode = 200;
      options.signal.addEventListener("abort", () => { postAborted = true; }, { once: true });
      signalPostStarted();
      return { response: stream };
    }
    return fixture.transport.request(raw, options);
  } }, allohaPlayback: async () => "edge" });
  const candidate = await allohaDefault(adapter, 348);
  const pending = adapter.resolve(candidate);
  await postStarted;
  releaseBundle();
  await assert.rejects(pending, /protocol guard is unavailable/);
  assert.equal(postAborted, true, "the losing per-title POST is cancelled immediately after the guard fails");
});

test("a title deadline stops waiting for a shared guard without cancelling other titles", async (t) => {
  const deadline = new AbortController();
  const originalTimeout = AbortSignal.timeout;
  let titleTimeouts = 0;
  AbortSignal.timeout = (ms) => ms === 20_000 && titleTimeouts++ === 0 ? deadline.signal : originalTimeout(ms);
  let releaseBundle;
  const bundleGate = new Promise((resolve) => { releaseBundle = resolve; });
  t.after(() => { AbortSignal.timeout = originalTimeout; releaseBundle(); });
  const fixture = allohaFixtureTransport({ waitBundle: bundleGate });
  let guardSignal;
  let postEnded = false;
  const adapter = createHabsterProvider({ transport: { async request(raw, options) {
    const path = new URL(raw).pathname;
    if (path.startsWith("/build/")) guardSignal = options.signal;
    const result = await fixture.transport.request(raw, options);
    if (path.startsWith("/bnsi/")) result.response.once("end", () => { postEnded = true; });
    return result;
  } }, allohaPlayback: async () => "edge" });
  const first = await allohaDefault(adapter, 349);
  const pending = adapter.resolve(first).then(() => "resolved", (error) => error.message);
  await fixture.postStarted;
  while (!postEnded) await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  deadline.abort(new Error("title deadline"));
  const outcome = await Promise.race([pending, new Promise((resolve) => setTimeout(() => resolve("still waiting"), 50))]);
  assert.equal(outcome, "title deadline", "completed POST must not let the shared guard extend this title's budget");
  assert.equal(guardSignal.aborted, false);
  const second = await allohaDefault(adapter, 350);
  const survivor = adapter.resolve(second);
  releaseBundle();
  assert.equal((await survivor).qualities[0].label, "720p");
  assert.equal(fixture.stats.bundles, 1, "another title still receives the same independent guard fetch");
});
