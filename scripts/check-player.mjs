import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { fetchIntroDbTimings, fallbackTimings, mergeTimings, providerSkipRanges } from "../src/utils/introDetect.js";
import { fetchAniSkipTimings, resolveAnimeEpisode } from "../src/utils/aniSkip.js";
import introdb from "../api/introdb.js";

const originalFetch = globalThis.fetch;
const originalStorage = globalThis.localStorage;
try {
  assert.deepEqual(await resolveAnimeEpisode(60863, 1, 1), { malId: 20583, episode: 1 });
  assert.deepEqual(await resolveAnimeEpisode(60863, 3, 1), { malId: 32935, episode: 1 });
  assert.deepEqual(await resolveAnimeEpisode(60863, 4, 13), { malId: 38883, episode: 13 });
  assert.deepEqual(await resolveAnimeEpisode(60863, 4, 14), { malId: 40776, episode: 1 });
  assert.equal(await resolveAnimeEpisode(60863, null, 1), null);
  assert.equal(await resolveAnimeEpisode(60863, 3, 0), null);
  assert.equal(await resolveAnimeEpisode(999999999, 3, 1), null);
  assert.equal(await resolveAnimeEpisode(60863, 3, 1, AbortSignal.abort()), null);
  const stored = new Map();
  globalThis.localStorage = { getItem: (key) => stored.get(key), setItem: (key, value) => stored.set(key, value) };
  const segment = (start, end, confidence = 1) => ({ start_sec: start, end_sec: end, confidence });
  globalThis.fetch = async () => Response.json({ intro: segment(5, 10), recap: segment(-1, 5), outro: segment(90, 110), post_credits: segment(80, 90), bad: segment(0, 10, 0.1) });
  const timings = await fetchIntroDbTimings({ imdbId: "tt0111161", type: "movie", duration: 100 });
  assert.deepEqual(timings, { intro: { startTime: 5, endTime: 10 }, postCredits: { startTime: 80, endTime: 90 } });
  assert.equal(fallbackTimings(100), null);
  assert.deepEqual(providerSkipRanges([
    { start: 5, end: 10 }, { start: 80, end: 100 },
    { start: -1, end: 2 }, { start: 10, end: 5 }, { start: 3, end: 3 },
    { start: null, end: 10 }, { start: "5", end: 10 }, { start: 5, end: Infinity },
    { start: 90, end: 101 },
  ], 100), [{ startTime: 5, endTime: 10 }, { startTime: 80, endTime: 100 }]);
  assert.deepEqual(providerSkipRanges([{ start: 5, end: 10 }], NaN), []);
  assert.deepEqual(providerSkipRanges({ ad: [{ start: 5, end: 10 }] }, 100), []);
  assert.deepEqual(mergeTimings({ intro: { startTime: 1, endTime: 2 } }, timings).intro, { startTime: 1, endTime: 2 });
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({ found: true, results: [
    { skipType: "op", interval: { startTime: 5, endTime: 10 } },
    { skipType: "ed", interval: { startTime: 95, endTime: 200 } },
    { skipType: "recap", interval: { startTime: -5, endTime: 3 } },
  ] }); };
  assert.deepEqual(await fetchAniSkipTimings(1, 1, 100), { intro: { startTime: 5, endTime: 10 } });
  await fetchAniSkipTimings(1, 1, 100);
  assert.equal(calls, 1, "valid timings are cached");
  const aborted = AbortSignal.abort();
  assert.equal(await fetchAniSkipTimings(1, 2, 100, { signal: aborted }), null);
  assert.equal(await fetchIntroDbTimings({ imdbId: "tt0111161", type: "movie", duration: 100, signal: aborted }), null);
  assert.equal(calls, 1, "cancelled lookups must not start fetches");

  const window = {};
  let sourceCalls = 0;
  const html = 'makePlayer({"seasons":[{"season":0,"episodes":[{"episode":1,"hls":"https://test/one.m3u8"}]}]})';
  const context = { window, URLSearchParams, TextEncoder, AbortController, AbortSignal, setTimeout, clearTimeout, btoa,
    fetch: async (url) => { sourceCalls++; return String(url).includes("franchise/details") ? Response.json({ iframe_url: "https://test/embed" }) : new Response(html); },
  };
  vm.runInNewContext(readFileSync(new URL("../src/web/shim.js", import.meta.url), "utf8"), context);
  assert.equal((await window.electron.collapsResolve({ imdbId: "tt0111161", type: "tv", season: 0, episode: 1 })).ok, true);
  assert.equal((await window.electron.collapsResolve({ imdbId: "tt0111161", type: "tv", season: 0, episode: 2 })).ok, false, "missing episode must not play episode one");
  assert.equal((await window.electron.collapsResolve({ imdbId: "tt0111161", type: "tv", season: 2, episode: 1 })).ok, false);
  assert.equal(sourceCalls, 2, "episode changes reuse cached embed HTML");
  await assert.rejects(window.electron.collapsResolve({ imdbId: "tt9999999" }, { signal: aborted }), { name: "AbortError" });
  assert.equal(sourceCalls, 2);

  const response = { status(code) { this.code = code; return this; }, json(data) { this.data = data; return this; }, setHeader() {} };
  await introdb({ method: "GET", url: "/api/introdb?imdb_id=https://private" }, response);
  assert.equal(response.code, 400);
  await introdb({ method: "POST", url: "/api/introdb" }, response);
  assert.equal(response.code, 405);
  console.log("Player checks passed: range validation, cache, cancellation, exact episode and relay input");
} finally {
  globalThis.fetch = originalFetch;
  globalThis.localStorage = originalStorage;
}
