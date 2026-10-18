import assert from "node:assert/strict";
import test from "node:test";
import { Readable } from "node:stream";
import { createVidSrcProvider } from "../providers/vidsrc.mjs";

const movie = { type: "movie", tmdbId: 550, title: "Fight Club", originalTitle: "Fight Club", year: 1999, imdbId: "tt0137523" };
const key = "a".repeat(64);
const script = `var _y=\`${key}\`,Vy=\`${key}\`;`;
const html = '<script type="module" src="/assets/main-ab12.js"></script>';
const response = (body, headers = {}, statusCode = 200) => {
  const stream = Readable.from([Buffer.from(typeof body === "string" ? body : JSON.stringify(body))]);
  stream.headers = headers; stream.statusCode = statusCode;
  return { response: stream };
};
const movieData = (override = {}) => ({ result: true, type: "movie", title: "Fight Club", tmdb_id: "550",
  imdb_id: "tt0137523", year: 1999, sources: [{ url: "https://media.test/master.m3u8", tracks: [
    { file: "https://media.test/en.vtt", label: "English" }, { label: "No URL" },
  ], qualities: [] }], ...override });

function fixture(data = movieData(), { scriptText = script, htmlText = html, sourceStatus = 200 } = {}) {
  const requests = [];
  const transport = { async request(rawUrl, options) {
    const url = new URL(rawUrl); requests.push({ url, options });
    assert.equal(options.publicOnly, true);
    assert.equal(options.timeout, 12_000);
    assert(options.signal instanceof AbortSignal);
    if (url.href === "https://vidsrc.pm/") return response(htmlText);
    if (url.pathname === "/assets/main-ab12.js") return response(scriptText);
    assert.equal(url.origin, "https://vidsrc.pm");
    assert.equal(url.searchParams.get("source"), "scrapify");
    assert.equal(options.headers["x-player-key"], key);
    assert.equal(options.headers.referer, `https://vidsrc.pm/embed/${url.pathname.replace("/api/vidora/v1/", "")}`);
    return response(data, {}, sourceStatus);
  } };
  return { requests, provider: createVidSrcProvider({ transport }) };
}

async function candidate(provider, title = movie) {
  const found = [];
  for await (const item of provider.discover(title)) found.push(item);
  assert.equal(found.length, 1);
  return found[0];
}

test("VidSrc discovery is network-free and selected movie resolves to public HLS/subtitles", async () => {
  const { requests, provider } = fixture();
  const item = await candidate(provider);
  assert.equal(requests.length, 0);
  assert.deepEqual({ providerId: item.providerId, providerName: item.providerName, catalogSource: item.catalogSource,
    voiceId: item.voiceId, voiceName: item.voiceName, season: item.season, episode: item.episode }, {
    providerId: "vidsrc:pm", providerName: "VidSrc.pm", catalogSource: "vidsrc", voiceId: "original",
    voiceName: "Основная дорожка", season: null, episode: null,
  });
  assert.equal(Object.keys(item).includes("ref"), false);
  assert.deepEqual(item.ref, { type: "movie", tmdbId: 550, title: "Fight Club", originalTitle: "Fight Club", year: 1999, imdbId: "tt0137523" });
  const resolved = await provider.resolve(item);
  assert.equal(resolved.qualities.length, 1);
  assert.deepEqual(resolved.qualities[0], { label: "Auto", type: "hls", url: "https://media.test/master.m3u8",
    headers: { referer: "https://vidsrc.pm/embed/movie/550" }, publicOnly: true });
  assert.deepEqual(resolved.subtitles, [{ url: "https://media.test/en.vtt", label: "English", language: null,
    headers: { referer: "https://vidsrc.pm/embed/movie/550" }, publicOnly: true }]);
  assert.deepEqual(resolved.audioNames, []);
  assert.equal(requests.length, 3, "selected resolve reads homepage, static bundle and API");
  assert.equal(requests[2].url.pathname, "/api/vidora/v1/movie/550");
});

test("VidSrc TV resolve requests and seals the exact season and episode", async () => {
  const title = { ...movie, type: "tv", tmdbId: 1396, title: "Breaking Bad", originalTitle: "Breaking Bad", year: 2008,
    imdbId: "tt0903747", season: 2, episode: 3 };
  const data = { result: true, type: "tv", title: "Breaking Bad", tmdb_id: "1396", imdb_id: "tt0903747", year: 2008,
    season: 2, episode: 3, sources: [{ url: "https://media.test/episode.m3u8", tracks: [] }] };
  const { requests, provider } = fixture(data);
  const item = await candidate(provider, title);
  assert.deepEqual(item.ref, { type: "tv", tmdbId: 1396, title: "Breaking Bad", originalTitle: "Breaking Bad", year: 2008,
    imdbId: "tt0903747", season: 2, episode: 3 });
  assert.equal(item.season, 2);
  assert.equal(item.episode, 3);
  await provider.resolve(item);
  assert.equal(requests[2].url.pathname, "/api/vidora/v1/tv/1396/2/3");
});

test("VidSrc refuses metadata for another or incomplete movie/episode", async () => {
  for (const data of [
    movieData({ tmdb_id: "551" }), movieData({ type: "tv" }), movieData({ title: "Different film" }),
    movieData({ year: 2000 }), movieData({ imdb_id: "tt7654321" }), movieData({ result: false }),
    movieData({ sources: [] }), movieData({ sources: [{ url: "https://media.test/a.m3u8" }, { url: "https://media.test/b.m3u8" }] }),
  ]) {
    const { provider } = fixture(data);
    await assert.rejects(provider.resolve(await candidate(provider)), /different or incomplete|no unique source/);
  }
  const tv = { ...movie, type: "tv", tmdbId: 1396, title: "Breaking Bad", season: 1, episode: 2 };
  for (const data of [
    { result: true, type: "tv", title: "Breaking Bad", tmdb_id: "1396", season: 1, episode: 1, sources: [{ url: "https://media.test/a.m3u8" }] },
    { result: true, type: "tv", title: "Breaking Bad", tmdb_id: "1396", season: 2, episode: 2, sources: [{ url: "https://media.test/a.m3u8" }] },
  ]) {
    const { provider } = fixture(data);
    await assert.rejects(provider.resolve(await candidate(provider, tv)), /different or incomplete/);
  }
});

test("VidSrc rejects forged references, unsafe media URLs, missing keys and failed HTTP", async () => {
  const forged = fixture();
  const item = await candidate(forged.provider);
  await assert.rejects(forged.provider.resolve({ ...item, voiceId: "dub" }), /Invalid VidSrc/);
  await assert.rejects(forged.provider.resolve({ ...item, ref: { ...item.ref, tmdbId: 551 } }), /different or incomplete/);
  for (const badUrl of ["http://media.test/a.m3u8", "https://user:pass@media.test/a.m3u8", "javascript:alert(1)"]) {
    const { provider } = fixture(movieData({ sources: [{ url: badUrl, tracks: [] }] }));
    await assert.rejects(provider.resolve(await candidate(provider)), /unsupported media URL|invalid media URL/);
  }
  for (const scriptText of ["no player key", `var a=\`${key}\`,b=\`${"b".repeat(64)}\`;`]) {
    const { provider } = fixture(movieData(), { scriptText });
    await assert.rejects(provider.resolve(await candidate(provider)), /key is unavailable or ambiguous/);
  }
  const { provider: failed } = fixture(movieData(), { sourceStatus: 503 });
  await assert.rejects(failed.resolve(await candidate(failed)), /HTTP 503/);
});

test("VidSrc bounds bodies and propagates aborts through public-only requests", async () => {
  const tooLarge = createVidSrcProvider({ transport: { async request() { return response("x".repeat(1024 * 1024 + 1)); } } });
  await assert.rejects(tooLarge.resolve(await candidate(tooLarge)), /too large/);

  const controller = new AbortController();
  const stalled = createVidSrcProvider({ transport: { async request(_url, options) {
    assert.equal(options.publicOnly, true);
    const stream = new Readable({ read() {} }); stream.headers = {}; stream.statusCode = 200;
    setImmediate(() => controller.abort());
    return { response: stream };
  } } });
  const item = await candidate(stalled);
  await assert.rejects(stalled.resolve(item, { signal: controller.signal }), { name: "AbortError" });
  await assert.rejects(candidate(stalled, { ...movie, tmdbId: 0 }), /valid TMDB ID/);
  await assert.rejects(candidate(stalled, { ...movie, type: "tv", season: 1 }), /exact season and episode/);
});

test("cancelling one cold VidSrc resolve does not cancel another viewer", async () => {
  const first = new AbortController();
  const second = new AbortController();
  let started;
  const firstStarted = new Promise((resolve) => { started = resolve; });
  let homes = 0;
  const provider = createVidSrcProvider({ transport: { async request(rawUrl, { signal }) {
    const url = new URL(rawUrl);
    if (url.pathname === "/" && ++homes === 1) {
      started();
      return new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    }
    return response(url.pathname === "/" ? html : url.pathname.startsWith("/assets/") ? script : movieData());
  } } });
  const item = await candidate(provider);
  const cancelled = assert.rejects(provider.resolve(item, { signal: first.signal }), { name: "AbortError" });
  await firstStarted;
  const independent = provider.resolve(item, { signal: second.signal });
  first.abort();
  await cancelled;
  assert.equal((await independent).qualities[0].url, "https://media.test/master.m3u8");
  assert.equal(second.signal.aborted, false);
  assert.equal(homes, 2);
  await provider.resolve(item);
  assert.equal(homes, 2, "successful key is cached for later viewers");
});
