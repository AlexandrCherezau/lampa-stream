import assert from "node:assert/strict";
import { createLampacProvider } from "../providers/lampac.mjs";

const baseUrl = "https://lampac.test/";
const movieTitle = {
  type: "movie",
  title: "Fight Club",
  originalTitle: "Fight Club",
  year: "1999",
  kinopoiskId: 361,
  imdbId: "tt0137523",
  tmdbId: 550,
};

function response(type, data, more = {}) {
  return { type, data, ...more };
}

async function collect(iterable) {
  const values = [];
  for await (const value of iterable) values.push(value);
  return values;
}

async function testMovieProvidersAndResolve() {
  const calls = [];
  const fetchJson = async (raw) => {
    const url = new URL(raw);
    calls.push(url);
    if (url.pathname === "/lite/events") {
      return [
        { name: "Zetflix", balanser: "zetflix", url: `${baseUrl}lite/zetflix` },
        { name: "ZetflixDB", balanser: "zetflixdb", url: `${baseUrl}lite/zetflixdb` },
        { name: "Phantom", balanser: "phantom", url: `${baseUrl}lite/phantom` },
        { name: "VeoVeo", balanser: "veoveo", url: `${baseUrl}lite/veoveo` },
        { name: "VK Movie", balanser: "vkmovie", url: `${baseUrl}lite/vkmovie` },
        { name: "Kodik", balanser: "kodik", url: `${baseUrl}lite/kodik` },
        { name: "KinoUkr", balanser: "kinoukr", url: `${baseUrl}lite/kinoukr` },
        { name: "Torrent", balanser: "pidtor", url: `${baseUrl}lite/pidtor` },
        { name: "HTML", balanser: "kinotochka", url: `${baseUrl}lite/kinotochka` },
      ];
    }
    if (url.pathname === "/lite/zetflix") {
      assert.equal(url.searchParams.get("kinopoisk_id"), "361");
      assert.equal(url.searchParams.get("imdb_id"), "tt0137523");
      return response("movie", [{
        method: "play",
        url: "https://cdn.example/master.m3u8",
        quality: {
          "1080p": "https://cdn.example/1080.m3u8",
          "720p": "https://cdn.example/720.m3u8",
        },
        translate: "Дубляж",
        headers: "{'Referer': 'https://source.example/'}",
        subtitles: [{ name: "Русские", url: "https://cdn.example/ru.vtt", language: "ru" }],
        segments: { skip: [{ start: 5, end: 10 }], ad: [{ start: 0, end: 5 }] },
      }]);
    }
    if (url.pathname === "/lite/zetflixdb") {
      return response("movie", [{ method: "play", url: "https://cdn.example/videodb/manifest.m3u8?token=x", maxquality: "1080" }]);
    }
    if (url.pathname === "/lite/phantom") return response("movie", [{ method: "play", url: "https://cdn.example/phantom/master.m3u8" }]);
    if (url.pathname === "/lite/veoveo") return response("movie", [{ method: "play", url: "https://cdn.example/veoveo/master.m3u8" }]);
    throw new Error(`Unexpected endpoint ${url.pathname}`);
  };
  const provider = createLampacProvider({ baseUrl, fetchJson });
  const candidates = await collect(provider.discover(movieTitle));
  assert.deepEqual(candidates.map((candidate) => candidate.providerId), ["zetflix", "zetflixdb", "phantom", "veoveo"]);
  assert.equal(calls.some((url) => url.pathname === "/lite/vkmovie"), false, "unvetted reaction catalog is excluded");
  assert.equal(calls.filter((url) => url.pathname === "/lite/zetflix")[0].searchParams.get("serial"), "0");
  assert.equal(Object.keys(candidates[0]).includes("ref"), false, "private refs are non-enumerable");

  const zetflix = candidates[0];
  assert.equal(JSON.stringify(zetflix).includes("cdn.example"), false);
  const resolved = await provider.resolve(zetflix);
  assert.deepEqual(resolved.qualities.map((quality) => [quality.label, quality.height]), [["1080p", 1080], ["720p", 720]]);
  assert.equal(resolved.qualities[0].headers.Referer, "https://source.example/");
  assert.deepEqual(resolved.subtitles, [{ label: "Русские", url: "https://cdn.example/ru.vtt", language: "ru" }]);
  assert.deepEqual(resolved.skip, [{ start: 5, end: 10 }], "source skip markers are retained without ad ranges");

  const zetflixDb = await provider.resolve(candidates[1]);
  assert.equal(zetflixDb.qualities[0].height, 1080);
  assert.match(zetflixDb.qualities[0].url, /videodb\/manifest\.m3u8/);
  assert.equal(calls.filter((url) => url.pathname === "/lite/zetflix").length, 2, "Zetflix refreshes its selected provider item before resolve");
  assert.equal(calls.filter((url) => url.pathname === "/lite/zetflixdb").length, 2, "ZetflixDB index is re-entered exactly once during resolve");
}

async function testSimilarExactMatchAndAmbiguity() {
  const queries = [];
  const fetchJson = async (raw) => {
    const url = new URL(raw);
    queries.push(url);
    if (url.pathname === "/lite/events") return [{ name: "KinoGo", balanser: "kinogo", url: `${baseUrl}lite/kinogo` }];
    if (url.pathname === "/lite/kinogo" && !url.searchParams.has("id")) {
      return response("similar", [
        { title: "Fight Club (1999)", year: "1999", url: `${baseUrl}lite/kinogo?id=1` },
        { title: "Fight Club (2023)", year: "2023", url: `${baseUrl}lite/kinogo?id=2` },
      ]);
    }
    return response("movie", [{ method: "play", url: "https://cdn.example/fc.mp4" }]);
  };
  const provider = createLampacProvider({ baseUrl, fetchJson });
  const candidates = await collect(provider.discover(movieTitle));
  assert.equal(candidates.length, 1);
  assert.equal(queries.filter((url) => url.pathname === "/lite/kinogo").length, 2);

  const ambiguous = createLampacProvider({
    baseUrl,
    fetchJson: async (raw) => {
      const url = new URL(raw);
      if (url.pathname === "/lite/events") return [{ name: "KinoGo", balanser: "kinogo", url: `${baseUrl}lite/kinogo` }];
      return response("similar", [
        { title: "Fight Club", year: "1999", url: `${baseUrl}lite/kinogo?id=1` },
        { title: "Fight Club", year: "1999", url: `${baseUrl}lite/kinogo?id=2` },
      ]);
    },
  });
  assert.equal((await collect(ambiguous.discover(movieTitle))).length, 0);
}

async function testTvSeasonEpisodeAndVoices() {
  const fetchJson = async (raw) => {
    const url = new URL(raw);
    if (url.pathname === "/lite/events") return [{ name: "HDVB", balanser: "hdvb", url: `${baseUrl}lite/hdvb` }];
    if (url.pathname === "/lite/hdvb" && !url.searchParams.has("season")) {
      return response("season", [
        { id: 1, name: "1 сезон", url: `${baseUrl}lite/hdvb?season=1` },
        { id: 2, name: "2 сезон", url: `${baseUrl}lite/hdvb?season=2` },
      ]);
    }
    if (url.searchParams.get("voice") === "Dub B") {
      return response("episode", [
        { method: "call", url: `${baseUrl}lite/hdvb/video?e=14&voice=b`, e: 14, name: "14 серия" },
      ], { voice: [{ id: "dub2", name: "Dub B", active: true }] });
    }
    if (url.searchParams.get("voice") === "Broken") throw new Error("voice endpoint timed out");
    if (url.searchParams.get("season") === "1") {
      return response("episode", [
        { method: "call", url: `${baseUrl}lite/hdvb/video?e=14`, e: 14, name: "14 серия" },
        { method: "call", url: `${baseUrl}lite/hdvb/video?e=15`, e: 15, name: "15 серия" },
      ], { voice: [
        { id: "dub1", name: "Dub A", active: true, url: null },
        { id: "broken", name: "Broken", active: false, url: `${baseUrl}lite/hdvb?season=1&voice=Broken` },
        { id: "dub2", name: "Dub B", active: false, url: `${baseUrl}lite/hdvb?season=1&voice=Dub+B` },
      ] });
    }
    throw new Error(`Unexpected TV request ${url}`);
  };
  const provider = createLampacProvider({ baseUrl, fetchJson });
  const results = await collect(provider.discover({ type: "tv", title: "Show", originalTitle: "Show", year: "2020", season: 1, episode: 14 }));
  const candidates = results.filter((value) => value.ref);
  assert.equal(candidates.length, 2);
  assert.deepEqual(candidates.map((candidate) => [candidate.voiceName, candidate.season, candidate.episode]), [
    ["Dub A", 1, 14], ["Dub B", 1, 14],
  ]);
  assert.equal(new URL(candidates[0].ref.providerUrl).searchParams.get("season"), "1");
  assert.equal(new URL(candidates[0].ref.providerUrl).searchParams.has("voice"), false);
  assert.equal(new URL(candidates[1].ref.providerUrl).searchParams.get("voice"), "Dub B");
  assert.deepEqual(results.filter((value) => value.error).map((value) => value.providerId), ["hdvb"]);
  assert.match(results.find((value) => value.error).error, /Broken/);
}

async function testCallFallbackAndAbort() {
  const fetchJson = async () => {
    throw new Error("call failed");
  };
  const provider = createLampacProvider({ baseUrl, fetchJson });
  const candidate = {
    ref: {
      origin: new URL(baseUrl).origin,
      url: `${baseUrl}lite/zetflix/video?e=1`,
      method: "call",
      stream: "https://cdn.example/published.m3u8",
      headers: {},
      item: { method: "call", url: `${baseUrl}lite/zetflix/video?e=1` },
    },
  };
  const fallback = await provider.resolve(candidate);
  assert.equal(fallback.qualities[0].url, "https://cdn.example/published.m3u8");

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(provider.resolve(candidate, { signal: controller.signal }), { name: "AbortError" });
}

async function testZetflixDbManifestPrimesCookieAndHonorsAbort() {
  const calls = [];
  const fetchJson = async (raw, { signal } = {}) => {
    const url = new URL(raw);
    calls.push(url.pathname);
    if (url.pathname === "/lite/zetflixdb/video") {
      return { method: "play", url: "https://cdn.example/videodb/manifest.m3u8?token=opaque" };
    }
    if (url.pathname === "/lite/zetflixdb") return response("movie", [{
      method: "play", title: "Fight Club", year: "1999", translate: "Dub A",
      url: "https://cdn.example/videodb/manifest.m3u8?token=fresh",
    }]);
    throw new Error(`Unexpected endpoint ${url.pathname}`);
  };
  const provider = createLampacProvider({ baseUrl, fetchJson });
  const candidate = {
    providerId: "zetflixdb",
    ref: {
      origin: new URL(baseUrl).origin,
      providerUrl: `${baseUrl}lite/zetflixdb`,
      method: "call",
      url: `${baseUrl}lite/zetflixdb/video`,
      stream: "https://cdn.example/fallback.m3u8",
      headers: {},
      voiceName: "Dub A",
      item: { method: "call", url: `${baseUrl}lite/zetflixdb/video`, title: "Fight Club", year: "1999", translate: "Dub A" },
    },
  };
  const resolved = await provider.resolve(candidate);
  assert.deepEqual(calls, ["/lite/zetflixdb"], "resolve must refresh the exact provider JSON before opening the old call URL");
  assert.match(resolved.qualities[0].url, /token=fresh/, "resolve must use the media URL returned by the fresh index response");

  let rejectPrime;
  const abortingProvider = createLampacProvider({
    baseUrl,
    fetchJson: async (raw, { signal } = {}) => {
      const url = new URL(raw);
      if (url.pathname === "/lite/zetflixdb/video") return { method: "play", url: "https://cdn.example/videodb/manifest.m3u8" };
      if (url.pathname === "/lite/zetflixdb") {
        return new Promise((resolve, reject) => {
          rejectPrime = reject;
          signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })), { once: true });
        });
      }
      throw new Error(`Unexpected endpoint ${url.pathname}`);
    },
  });
  const controller = new AbortController();
  const resolving = abortingProvider.resolve(candidate, { signal: controller.signal });
  while (!rejectPrime) await new Promise((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(resolving, { name: "AbortError" }, "an aborted cookie prime must not return the candidate's fallback stream");
}

async function testZetflixDbRefreshPreservesMovieVoiceAndRejectsAmbiguity() {
  const candidate = {
    providerId: "zetflixdb", voiceName: "MVO | Позитив",
    ref: {
      origin: new URL(baseUrl).origin,
      providerUrl: `${baseUrl}lite/zetflixdb?title=Fight+Club&original_title=Fight+Club&year=1999`,
      method: "play", url: "https://cdn.example/videodb/manifest.m3u8?old=1", headers: {},
      item: { title: "Fight Club", year: "1999", translate: "MVO | Позитив", url: "https://cdn.example/videodb/manifest.m3u8?old=1" },
    },
  };
  let called = 0;
  const provider = createLampacProvider({
    baseUrl,
    fetchJson: async (raw) => {
      called++;
      assert.equal(new URL(raw).pathname, "/lite/zetflixdb");
      return response("movie", [
        { title: "Fight Club", year: "1999", translate: "DUB | Официальный", url: "https://cdn.example/wrong-voice.m3u8" },
        { title: "Fight Club", year: "1999", translate: "MVO | Позитив", url: "https://cdn.example/fresh-voice.m3u8" },
        { title: "Fight Club 2", year: "2024", translate: "MVO | Позитив", url: "https://cdn.example/wrong-title.m3u8" },
      ]);
    },
  });
  const resolved = await provider.resolve(candidate);
  assert.equal(called, 1);
  assert.equal(resolved.qualities[0].url, "https://cdn.example/fresh-voice.m3u8");

  const ambiguous = createLampacProvider({
    baseUrl,
    fetchJson: async () => response("movie", [
      { title: "Fight Club", year: "1999", translate: "MVO | Позитив", url: "https://cdn.example/a.m3u8" },
      { title: "Fight Club", year: "1999", translate: "MVO | Позитив", url: "https://cdn.example/b.m3u8" },
    ]),
  });
  await assert.rejects(ambiguous.resolve(candidate), /uniquely refresh/);
}

async function testZetflixDbRefreshPrecedesCallAndNeverUsesStaleFallback() {
  const candidate = {
    providerId: "zetflixdb", voiceName: "Dub A",
    ref: {
      origin: new URL(baseUrl).origin,
      providerUrl: `${baseUrl}lite/zetflixdb?title=Fight+Club&year=1999`,
      method: "call", url: `${baseUrl}lite/zetflixdb/stale-call`, stream: "https://cdn.example/stale.m3u8", headers: {},
      item: { method: "call", title: "Fight Club", year: "1999", translate: "Dub A", url: `${baseUrl}lite/zetflixdb/stale-call` },
    },
  };
  const calls = [];
  const provider = createLampacProvider({
    baseUrl,
    fetchJson: async (raw) => {
      const url = new URL(raw);
      calls.push(url.pathname);
      if (url.pathname === "/lite/zetflixdb") return response("movie", [{
        method: "call", title: "Fight Club", year: "1999", translate: "Dub A",
        url: `${baseUrl}lite/zetflixdb/fresh-call`,
      }]);
      if (url.pathname === "/lite/zetflixdb/fresh-call") return { method: "play", url: "https://cdn.example/fresh-call.m3u8" };
      throw new Error("Stale call URL must never be requested");
    },
  });
  const resolved = await provider.resolve(candidate);
  assert.deepEqual(calls, ["/lite/zetflixdb", "/lite/zetflixdb/fresh-call"]);
  assert.equal(resolved.qualities[0].url, "https://cdn.example/fresh-call.m3u8");

  const noFreshFallback = createLampacProvider({
    baseUrl,
    fetchJson: async (raw) => {
      const url = new URL(raw);
      if (url.pathname === "/lite/zetflixdb") return response("movie", [{
        method: "call", title: "Fight Club", year: "1999", translate: "Dub A", url: `${baseUrl}lite/zetflixdb/fresh-call`,
      }]);
      throw new Error("Fresh call unavailable");
    },
  });
  await assert.rejects(noFreshFallback.resolve(candidate), /Fresh call unavailable/);
}

async function testZetflixDbRefreshAcceptsSingleCallObject() {
  const candidate = {
    providerId: "zetflixdb", voiceName: "Dub A",
    ref: {
      origin: new URL(baseUrl).origin,
      providerUrl: `${baseUrl}lite/zetflixdb?title=Fight+Club&year=1999`,
      method: "call", url: `${baseUrl}lite/zetflixdb/stale-call`, headers: {},
      item: { method: "call", title: "Fight Club", year: "1999", translate: "Dub A", url: `${baseUrl}lite/zetflixdb/stale-call` },
    },
  };
  const provider = createLampacProvider({
    baseUrl,
    fetchJson: async (raw) => {
      const url = new URL(raw);
      if (url.pathname === "/lite/zetflixdb") return {
        method: "call", title: "Fight Club", year: "1999", translate: "Dub A",
        url: `${baseUrl}lite/zetflixdb/fresh-call`,
      };
      if (url.pathname === "/lite/zetflixdb/fresh-call") return { method: "play", url: "https://cdn.example/fresh-object.m3u8" };
      throw new Error("Unexpected stale or non-selected URL");
    },
  });
  const resolved = await provider.resolve(candidate);
  assert.equal(resolved.qualities[0].url, "https://cdn.example/fresh-object.m3u8");
}

async function testZetflixDbRefreshPreservesExactTvEpisodeAndVoice() {
  const candidate = {
    providerId: "zetflixdb", voiceId: "dub-b", voiceName: "Dub B", season: 1, episode: 14,
    ref: {
      origin: new URL(baseUrl).origin,
      providerUrl: `${baseUrl}lite/zetflixdb?season=1&voice=b`,
      method: "play", url: "https://cdn.example/videodb/manifest.m3u8?old=1", headers: {},
      item: { method: "play", e: 14, translate: "Dub B", url: "https://cdn.example/videodb/manifest.m3u8?old=1" },
    },
  };
  const episodeJson = (active, episodes = [{ e: 14, translate: "Dub B", url: "https://cdn.example/videodb/manifest.m3u8?fresh=episode14" }]) => response("episode", episodes, {
    voice: [
      { id: "dub-a", name: "Dub A", active: false },
      { id: "dub-b", name: "Dub B", active },
    ],
  });
  const provider = createLampacProvider({ baseUrl, fetchJson: async () => episodeJson(true) });
  const resolved = await provider.resolve(candidate);
  assert.equal(resolved.qualities[0].url, "https://cdn.example/videodb/manifest.m3u8?fresh=episode14");

  const inactive = createLampacProvider({ baseUrl, fetchJson: async () => episodeJson(false) });
  await assert.rejects(inactive.resolve(candidate), /selected voice/);

  const ambiguousEpisode = createLampacProvider({
    baseUrl,
    fetchJson: async () => episodeJson(true, [
      { e: 14, translate: "Dub B", url: "https://cdn.example/a.m3u8" },
      { e: 14, translate: "Dub B", url: "https://cdn.example/b.m3u8" },
    ]),
  });
  await assert.rejects(ambiguousEpisode.resolve(candidate), /selected episode and voice/);

  const wrongSeason = createLampacProvider({
    baseUrl,
    fetchJson: async () => episodeJson(true, [{ s: 2, e: 14, translate: "Dub B", url: "https://cdn.example/wrong-season.m3u8" }]),
  });
  await assert.rejects(wrongSeason.resolve(candidate), /selected episode and voice/);

  const staleRoot = createLampacProvider({ baseUrl, fetchJson: async () => response("season", [{ id: 1, name: "Season 1" }]) });
  await assert.rejects(staleRoot.resolve({ ...candidate, ref: { ...candidate.ref, providerUrl: `${baseUrl}lite/zetflixdb` } }), /selected episode/);
}

async function testZetflixRefreshesExactEpisodeBeforeCallAndRejectsStaleCandidate() {
  const candidate = {
    providerId: "zetflix", voiceId: "Dub B", voiceName: "Dub B", season: 1, episode: 14,
    ref: {
      origin: new URL(baseUrl).origin,
      providerUrl: `${baseUrl}lite/zetflix?serial=1&s=1&t=Dub+B&rjson=true`,
      method: "call",
      url: `${baseUrl}lite/zetflix/video?stale=call`,
      stream: `${baseUrl}lite/zetflix/video?stale=play`,
      headers: {},
      item: { method: "call", s: 1, e: 14, name: "14 серия", details: "Dub B" },
    },
  };
  const calls = [];
  const provider = createLampacProvider({
    baseUrl,
    fetchJson: async (raw) => {
      const url = new URL(raw);
      calls.push(url.pathname + url.search);
      if (url.pathname === "/lite/zetflix" && url.searchParams.get("t") === "Dub B") {
        return response("episode", [{
          method: "call", s: 1, e: 14, details: "Dub B", name: "14 серия",
          url: `${baseUrl}lite/zetflix/video?fresh=call`,
          stream: `${baseUrl}lite/zetflix/video?fresh=play`,
        }], { voice: [{ name: "Dub B", active: true, url: `${baseUrl}lite/zetflix?serial=1&s=1&t=Dub+B` }] });
      }
      if (url.pathname === "/lite/zetflix/video" && url.searchParams.get("fresh") === "call") {
        return { method: "play", quality: { "720p": "https://cdn.example/fresh-episode14.m3u8" } };
      }
      throw new Error("A stale episode URL or unexpected endpoint was requested");
    },
  });
  const resolved = await provider.resolve(candidate);
  assert.deepEqual(calls, [
    "/lite/zetflix?serial=1&s=1&t=Dub+B&rjson=true",
    "/lite/zetflix/video?fresh=call",
  ], "a cold resolver must refresh the selected voice/episode endpoint before calling it");
  assert.equal(resolved.qualities[0].url, "https://cdn.example/fresh-episode14.m3u8");

  const wrongVoiceCalls = [];
  const wrongVoice = createLampacProvider({
    baseUrl,
    fetchJson: async (raw) => {
      const url = new URL(raw);
      wrongVoiceCalls.push(url.pathname);
      return response("episode", [{ method: "play", s: 1, e: 14, details: "Dub A", url: "https://cdn.example/stale.m3u8" }], {
        voice: [{ name: "Dub A", active: true }],
      });
    },
  });
  await assert.rejects(wrongVoice.resolve(candidate), /selected voice/);
  assert.deepEqual(wrongVoiceCalls, ["/lite/zetflix"], "a refresh mismatch must fail before stale call or stream fallback");

  const wrongEpisodeCalls = [];
  const wrongEpisode = createLampacProvider({
    baseUrl,
    fetchJson: async (raw) => {
      wrongEpisodeCalls.push(new URL(raw).pathname);
      return response("episode", [{ method: "play", s: 1, e: 13, details: "Dub B", url: "https://cdn.example/stale.m3u8" }], {
        voice: [{ name: "Dub B", active: true }],
      });
    },
  });
  await assert.rejects(wrongEpisode.resolve(candidate), /selected episode and voice/);
  assert.deepEqual(wrongEpisodeCalls, ["/lite/zetflix"], "a wrong refreshed episode must not fall back to the old candidate URL");
}

async function testExternalCallEndpointAndProviderError() {
  const seen = [];
  const fetchJson = async (raw) => {
    const url = new URL(raw);
    seen.push(url);
    if (url.pathname === "/lite/events") return [
      { name: "Zetflix", balanser: "zetflix", url: `${baseUrl}lite/zetflix` },
      { name: "HDVB", balanser: "hdvb", url: `${baseUrl}lite/hdvb` },
    ];
    if (url.pathname === "/lite/zetflix") return response("movie", [{
      method: "call",
      url: "https://resolver.example/call?id=1",
      stream: "https://cdn.example/stream.m3u8",
    }]);
    if (url.origin === "https://resolver.example") return { method: "play", quality: { "720p": "https://media.example/720.m3u8" } };
    throw new Error("provider backend unavailable");
  };
  const provider = createLampacProvider({ baseUrl, fetchJson });
  const results = await collect(provider.discover(movieTitle));
  const candidates = results.filter((value) => value.ref);
  const failures = results.filter((value) => value.error);
  assert.equal(candidates.length, 1);
  assert.deepEqual(failures.map((value) => value.providerId), ["hdvb"]);
  const resolved = await provider.resolve(candidates[0]);
  assert.equal(resolved.qualities[0].url, "https://media.example/720.m3u8");
  assert(seen.some((url) => url.origin === "https://resolver.example"), "call URLs must be used unchanged");
}

async function testProviderOrderCompletionAndEarlyClose() {
  const started = [];
  let slowAborted = false;
  const fetchJson = async (raw, { signal } = {}) => {
    const url = new URL(raw);
    if (url.pathname === "/lite/events") return [
      { name: "Zetflix", balanser: "zetflix", url: `${baseUrl}lite/zetflix` },
      { name: "Vibix", balanser: "vibix", url: `${baseUrl}lite/vibix` },
      { name: "HDVB", balanser: "hdvb", url: `${baseUrl}lite/hdvb` },
      { name: "Kinogo", balanser: "kinogo", url: `${baseUrl}lite/kinogo` },
    ];
    const id = url.pathname.split("/").at(-1);
    started.push(id);
    if (id === "zetflix") {
      return new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => {
          slowAborted = true;
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        }, { once: true });
      });
    }
    return response("movie", [{ method: "play", url: `https://cdn.example/${id}.m3u8` }]);
  };
  const provider = createLampacProvider({ baseUrl, fetchJson, providerOrder: ["hdvb", "zetflix"] });
  const iterator = provider.discover(movieTitle);
  const first = await iterator.next();
  assert.equal(first.value.providerId, "hdvb", "preferred quick provider should be started first");
  assert.deepEqual(started.slice(0, 3), ["hdvb", "zetflix", "vibix"]);
  await iterator.return();
  assert.equal(slowAborted, true, "closing discovery should abort outstanding provider calls");
}

async function testAnimeRetainsRussianMovieProviders() {
  const fetchJson = async (raw) => {
    const url = new URL(raw);
    if (url.pathname === "/lite/events") return ["vibix", "phantom", "collaps", "kodik", "kinoukr", "vkmovie"]
      .map((balanser) => ({ name: balanser, balanser, url: `${baseUrl}lite/${balanser}` }));
    assert.equal(url.searchParams.get("anime"), "1");
    return response("episode", [{ method: "play", url: "https://cdn.example/episode14.m3u8", e: 14 }]);
  };
  const provider = createLampacProvider({ baseUrl, fetchJson });
  const results = await collect(provider.discover({ type: "tv", title: "Волейбол!!", anime: true, season: 1, episode: 14 }));
  assert.deepEqual(results.map((value) => value.providerId), ["vibix", "phantom", "collaps", "kodik"],
    "anime must retain Russian general providers without adding foreign or unvetted catalogs");
  assert(results.every((value) => value.season === 1 && value.episode === 14));
}

async function testEpisodeSeasonAndBlockedEntries() {
  let selectedSeason = false;
  let episodeSeason = 1;
  const provider = createLampacProvider({ baseUrl, fetchJson: async (raw) => {
    const url = new URL(raw);
    if (url.pathname === "/lite/events") return [{ name: "Vibix", balanser: "vibix", url: `${baseUrl}lite/vibix` }];
    if (selectedSeason && !url.searchParams.has("s")) return response("season", [{ id: 3, url: `${baseUrl}lite/vibix?s=3` }]);
    return response("episode", [{ ...(episodeSeason == null ? {} : { s: episodeSeason }), e: 1, url: "https://cdn.example/episode1.m3u8" }]);
  } });
  const title = { type: "tv", title: "Волейбол!!", anime: true, season: 3, episode: 1 };
  assert.equal((await collect(provider.discover(title))).length, 0, "season 1 must not be relabelled as season 3");
  episodeSeason = null;
  assert.equal((await collect(provider.discover(title))).length, 0, "an unmarked episode cannot establish a later season");
  selectedSeason = true;
  assert.equal((await collect(provider.discover(title))).length, 1, "a selected season endpoint can supply unmarked episodes");
  episodeSeason = 1;
  assert.equal((await collect(provider.discover(title))).length, 0, "an explicit conflicting season overrides the endpoint selection");
  episodeSeason = 3;
  assert.equal((await collect(provider.discover(title))).length, 1);

  const filmix = createLampacProvider({ baseUrl, fetchJson: async (raw) => new URL(raw).pathname === "/lite/events"
    ? [{ name: "Filmix", balanser: "filmix", url: `${baseUrl}lite/filmix` }]
    : response("movie", [
      { translate: "Заблокировано правообладателем!", url: "https://cdn.example/placeholder.mp4" },
      { translate: "Дубляж", url: "https://cdn.example/movie.mp4" },
    ]) });
  assert.deepEqual((await collect(filmix.discover(movieTitle))).map((value) => value.voiceName), ["Дубляж"],
    "a provider's explicit blocked placeholder must never become a playable voice");
  const ref = { origin: new URL(baseUrl).origin, method: "play", url: "https://cdn.example/old.mp4", item: { s: 1, e: 1, url: "https://cdn.example/old.mp4" } };
  await assert.rejects(provider.resolve({ providerId: "vibix", season: 3, episode: 1, ref }), /selected season/);
  await assert.rejects(filmix.resolve({ providerId: "filmix", voiceName: "Заблокировано правообладателем!", ref }), /blocked placeholder/);
}

await testMovieProvidersAndResolve();
await testSimilarExactMatchAndAmbiguity();
await testTvSeasonEpisodeAndVoices();
await testCallFallbackAndAbort();
await testZetflixDbManifestPrimesCookieAndHonorsAbort();
await testZetflixDbRefreshPreservesMovieVoiceAndRejectsAmbiguity();
await testZetflixDbRefreshPrecedesCallAndNeverUsesStaleFallback();
await testZetflixDbRefreshAcceptsSingleCallObject();
await testZetflixDbRefreshPreservesExactTvEpisodeAndVoice();
await testZetflixRefreshesExactEpisodeBeforeCallAndRejectsStaleCandidate();
await testExternalCallEndpointAndProviderError();
await testProviderOrderCompletionAndEarlyClose();
await testAnimeRetainsRussianMovieProviders();
await testEpisodeSeasonAndBlockedEntries();
console.log("Lampac provider adapter tests passed");
