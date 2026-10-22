import assert from "node:assert/strict";
import { createSourceSession, discoverSources, prepareMovieSource } from "../src/utils/source-host-client.js";
import { labelAudioTracks } from "../src/utils/collaps-client.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};
const candidate = (id, providerId = id) => ({ id, providerId, providerName: `Provider ${providerId}`, voiceName: "Original" });
const result = (url) => ({ kind: "hls", selected: { url }, qualities: [{ label: "auto", height: 0 }] });

async function progressiveRecoveryWithState() {
  const discoveryGate = deferred();
  const playbackReady = deferred();
  let discoveryFinished = false;
  let state;
  const resolved = [];
  const session = createSourceSession({
    publish: (value) => { state = value; if (value.stream) playbackReady.resolve(); },
    discover: async (_title, { onEvent }) => {
      onEvent("candidate", candidate("one", "working"));
      await discoveryGate.promise;
      onEvent("candidate", candidate("two", "sibling"));
      discoveryFinished = true;
    },
    resolve: async (id) => { resolved.push(id); return result(`https://media.test/${id}.m3u8`); },
  });
  const started = session.start({ title: "Film" });
  await playbackReady.promise;
  assert.equal(discoveryFinished, false, "playback starts before discovery finishes");
  assert.deepEqual(state.stream, { hls: "https://media.test/one.m3u8" });
  const playingStream = state.stream;
  session.notePlaying();
  discoveryGate.resolve();
  await started;
  assert.equal(state.balanser, "working");
  assert.equal(state.sourceError, null);
  assert.equal(state.stream, playingStream, "late alternatives must not reattach the playing video");
  assert.deepEqual(resolved, ["one"], "background discovery must not resolve or select an alternative automatically");
  assert.deepEqual(state.balansers.map((value) => value.id), ["working", "sibling"]);
  await session.selectBalanser("sibling");
  assert.deepEqual(resolved, ["one", "two"], "late sources remain available for explicit selection");
}

async function decoderFailureUsesSibling() {
  const calls = [];
  let state;
  const session = createSourceSession({
    publish: (value) => { state = value; },
    discover: async (_title, { onEvent }) => { onEvent("candidate", candidate("a", "alpha")); onEvent("candidate", candidate("b", "beta")); },
    resolve: async (id) => { calls.push(id); return result(`https://media.test/${id}.m3u8`); },
  });
  await session.start({ title: "Film" });
  await tick();
  assert.equal(state.balanser, "alpha");
  assert.equal(session.reportPlaybackFailure(), true);
  await tick(); await tick();
  assert.deepEqual(calls, ["a", "b", "b"], "a sibling aborted by the winner is freshly resolved after decode failure");
  assert.deepEqual(state.stream, { hls: "https://media.test/b.m3u8" });
  assert.equal(state.balanser, "beta");
}

async function delayedHigherQualityRequiresManualChoice() {
  const gate = deferred();
  const ready = deferred();
  const resolutions = [];
  let state;
  const session = createSourceSession({
    publish: (value) => { state = value; if (value.stream) ready.resolve(); },
    discover: async (_title, { onEvent }) => {
      onEvent("candidate", { ...candidate("habster"), qualityHint: "Auto" });
      await gate.promise;
      onEvent("candidate", { ...candidate("vk-low", "vk"), qualityHint: "720p" });
      onEvent("candidate", { ...candidate("vk-high", "vk"), qualityHint: "2160p" });
      onEvent("candidate", { ...candidate("vk-later", "vk"), qualityHint: "1080p" });
      onEvent("candidate", { ...candidate("year"), qualityHint: "Фильм 2026" });
    },
    resolve: async (id, quality) => { resolutions.push({ id, quality }); return result(`https://media.test/${id}.m3u8`); },
  });
  const started = session.start({ title: "Film" });
  await ready.promise;
  const playing = state.stream;
  session.notePlaying();
  gate.resolve();
  await started;
  assert.equal(state.stream, playing, "a late 4K option must keep the confirmed playing stream");
  assert.deepEqual(resolutions, [{ id: "habster", quality: undefined }]);
  assert.equal(state.balansers.find((provider) => provider.id === "vk").qualityHeight, 2160,
    "provider quality reflects its highest voice, even if a lower-quality voice arrives later");
  assert.equal(state.balansers.find((provider) => provider.id === "year").qualityHeight, 0,
    "an incidental number must not advertise a resolution");
  assert.equal(await session.selectBalanser("vk", "2160p"), true);
  assert.deepEqual(resolutions.at(-1), { id: "vk-high", quality: "2160p" },
    "an explicit 4K choice resolves the voice advertising that rung and requests its exact quality");
  session.stop();
}

async function failedVoiceKeepsOtherVoices() {
  for (const failure of ["resolve", "decode"]) {
    const calls = [];
    let state;
    const session = createSourceSession({
      publish: (value) => { state = value; },
      discover: async (_title, { onEvent }) => {
        onEvent("candidate", candidate("bad", "alpha"));
        onEvent("candidate", candidate("good", "alpha"));
      },
      resolve: async (id) => {
        calls.push(id);
        if (failure === "resolve" && id === "bad") throw new Error("voice unavailable");
        return result(`https://media.test/${id}.m3u8`);
      },
    });
    await session.start({ title: "Film" });
    await tick();
    if (failure === "decode") assert.equal(session.reportPlaybackFailure(), true);
    await tick(); await tick();
    assert.deepEqual(calls, ["bad", "good"], `${failure} failure must not discard another voice from the same provider`);
    assert.deepEqual(state.stream, { hls: "https://media.test/good.m3u8" });
    assert.equal(state.sourceError, null);
    session.stop();
  }
}

async function fallbackRotatesProvidersAndStops() {
  const calls = [];
  let state;
  const session = createSourceSession({
    publish: (value) => { state = value; },
    discover: async (_title, { onEvent }) => {
      for (const [id, provider] of [["a1", "alpha"], ["a2", "alpha"], ["b1", "beta"], ["b2", "beta"]]) {
        onEvent("candidate", candidate(id, provider));
      }
    },
    resolve: async (id) => {
      calls.push(id);
      if (id.endsWith("1")) throw new Error("voice unavailable");
      return result(`https://media.test/${id}.m3u8`);
    },
  });
  await session.start({ title: "Film" });
  await tick(); await tick();
  assert.deepEqual(calls, ["a1", "b1", "a2", "b2"], "race one voice per provider before trying another voice");
  assert.equal(state.voice, "a2");
  assert.equal(session.reportPlaybackFailure(), true);
  await tick(); await tick();
  assert.deepEqual(calls, ["a1", "b1", "a2", "b2", "b2"]);
  assert.equal(state.voice, "b2");
  assert.equal(session.reportPlaybackFailure(), false);
  await tick(); await tick();
  assert.equal(calls.length, 5, "each candidate retries only after its first resolved stream fails to play");
  assert.match(state.sourceError.message, /Не найдено/);
  session.stop();
}

async function manualFailureAndStaleRequests() {
  const manual = deferred();
  const lateManual = deferred();
  const stale = deferred();
  let oldBCalls = 0;
  let newBCalls = 0;
  let state;
  let title = "old";
  const session = createSourceSession({
    publish: (value) => { state = value; },
    discover: async (value, { onEvent }) => { title = value.title; onEvent("candidate", candidate(`${value.title}-a`, `${value.title}-alpha`)); onEvent("candidate", candidate(`${value.title}-b`, `${value.title}-beta`)); },
    resolve: async (id, _quality, signal) => {
      if (id === "old-a") return result("https://media.test/old.m3u8");
      if (id === "old-b") {
        if (oldBCalls++ === 0) return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
        return oldBCalls === 2 ? manual.promise : lateManual.promise;
      }
      if (id === "new-a") return stale.promise;
      if (id === "new-b") newBCalls++;
      return result("https://media.test/new-b.m3u8");
    },
  });
  await session.start({ title: "old" });
  await tick();
  await tick();
  const priorStream = state.stream;
  const failedSelection = session.selectBalanser("old-beta");
  manual.reject(new Error("unavailable"));
  assert.equal(await failedSelection, false, "the current failed manual selection settles as failure");
  await tick();
  assert.deepEqual(state.stream, priorStream, "failed manual provider keeps the playing stream");
  assert.equal(state.balanser, "old-alpha", "the published selection stays on the source that is still playing");
  assert.match(state.sourceError.message, /unavailable/);

  const staleSelection = session.selectBalanser("old-beta");
  await session.start({ title: "new" });
  await tick();
  assert.equal(newBCalls, 1, "stopping a pending manual request releases the new title's automatic race");
  const latestSelection = session.selectBalanser("new-beta");
  assert.equal(await latestSelection, true, "the latest current selection settles as success");
  lateManual.resolve(result("https://media.test/old-late.m3u8"));
  assert.equal(await staleSelection, undefined, "an aborted prior selection is marked stale");
  stale.resolve(result("https://media.test/stale.m3u8"));
  await tick();
  assert.equal(title, "new");
  assert.deepEqual(state.stream, { hls: "https://media.test/new-b.m3u8" }, "stale resolution cannot replace a newer title's stream");
}

async function emptyDiscoveryAndSplitSse() {
  let state;
  const session = createSourceSession({ publish: (value) => { state = value; }, discover: async () => {} });
  await session.start({ title: "Missing" });
  assert.match(state.sourceError.message, /Не найдено/);

  const originalFetch = globalThis.fetch;
  const chunks = ["event: candi", "date\r", "\ndata: {\"id\":\"x\",", "\"providerId\":\"p\",\"providerName\":\"P\",\"voiceName\":\"V\"}\r", "\n\r", "\n"];
  globalThis.fetch = async () => new Response(new ReadableStream({
    pull(controller) {
      if (chunks.length) controller.enqueue(new TextEncoder().encode(chunks.shift()));
      else controller.close();
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
  const events = [];
  try { await discoverSources({ title: "Film" }, { onEvent: (...args) => events.push(args) }); }
  finally { globalThis.fetch = originalFetch; }
  assert.equal(events.length, 1);
  assert.equal(events[0][0], "candidate");
  assert.equal(events[0][1].id, "x");
}

async function prepareOnlyDiscoveryPreservesAbortSignal() {
  const originalFetch = globalThis.fetch;
  const controller = new AbortController();
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return new Response("event: done\ndata: {\"complete\":true}\n\n", {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };
  try {
    await discoverSources({ type: "movie", title: "Film", year: 2026 }, {
      prepareOnly: true, signal: controller.signal, onEvent: () => {},
    });
  } finally { globalThis.fetch = originalFetch; }
  assert.equal(new URL(request.url, "https://app.test").searchParams.get("op"), "discover");
  assert.deepEqual(JSON.parse(request.options.body), {
    type: "movie", title: "Film", year: 2026, prepareOnly: true,
  });
  assert.equal(request.options.signal, controller.signal, "navigation cleanup can abort the preparation request");
}

async function preparedMovieResolveIsBoundedAndExact() {
  const title = { type: "movie", title: "Warm Movie", tmdbId: 42, runtimeMinutes: 101 };
  const habster = { ...candidate("warm-id", "habster:alloha"), voiceId: "voice-1" };
  const preparedCalls = [];
  await prepareMovieSource(title, {
    discover: async (_title, options) => {
      assert.equal(options.prepareOnly, true);
      options.onEvent("candidate", habster);
    },
    resolve: async (...args) => { preparedCalls.push(args); return result("https://media.test/warm.m3u8"); },
  });
  assert.equal(preparedCalls.length, 1, "detail-page preparation resolves the default Alloha voice");

  let state;
  const playbackCalls = [];
  const discoveryGate = deferred();
  const streamReady = deferred();
  let discoveryFinished = false;
  const session = createSourceSession({
    publish: (value) => { state = value; if (value.stream) streamReady.resolve(); },
    discover: async (_title, { onEvent }) => {
      await discoveryGate.promise;
      onEvent("candidate", { ...habster, id: "fresh-signed-id" });
      onEvent("candidate", { ...habster, id: "alternate-signed-id", voiceId: "voice-2", voiceName: "Dub" });
      discoveryFinished = true;
    },
    resolve: async (...args) => { playbackCalls.push(args); return result("https://media.test/fresh.m3u8"); },
  });
  const playbackDiscovery = session.start(title);
  await streamReady.promise;
  assert.equal(discoveryFinished, false, "the cached stream is selected before ordinary Habster discovery finishes");
  assert.equal(state.stream.hls, "https://media.test/warm.m3u8");
  discoveryGate.resolve();
  await playbackDiscovery;
  assert.equal(discoveryFinished, true, "normal discovery continues in the background");
  assert.deepEqual(state.voices.map((voice) => voice.name), ["Original", "Dub"],
    "fresh discovery deduplicates only the prepared default voice and keeps alternate dubs");
  assert.equal(playbackCalls.length, 0, "first automatic choice reuses the early resolve");
  await session.selectQuality("2160p");
  assert.equal(playbackCalls.length, 1, "explicit quality selection always performs a fresh resolve");
  session.stop();

  const lateFallbackTitle = { ...title, tmdbId: 47 };
  await prepareMovieSource(lateFallbackTitle, {
    discover: async (_title, options) => options.onEvent("candidate", habster),
    resolve: async () => result("https://media.test/prepared-failover.m3u8"),
  });
  let lateEvent;
  const lateFallbackCalls = [];
  const lateWarmReady = deferred();
  const lateStreamReady = deferred();
  const lateFallbackSession = createSourceSession({
    publish: (value) => {
      if (value.stream?.hls === "https://media.test/prepared-failover.m3u8") lateWarmReady.resolve();
      if (value.stream?.hls === "https://media.test/fresh-failover.m3u8") lateStreamReady.resolve();
    },
    discover: async (_title, { onEvent }) => { lateEvent = onEvent; await deferredDiscovery.promise; },
    resolve: async (id) => {
      lateFallbackCalls.push(id);
      return result("https://media.test/fresh-failover.m3u8");
    },
  });
  const deferredDiscovery = deferred();
  const lateStart = lateFallbackSession.start(lateFallbackTitle);
  // The cached candidate is active while ordinary discovery is still held.
  await lateWarmReady.promise;
  assert.equal(lateFallbackCalls.length, 0);
  lateFallbackSession.reportPlaybackFailure();
  lateEvent("candidate", { ...habster, id: "late-fresh-signed-id" });
  await lateStreamReady.promise;
  assert.deepEqual(lateFallbackCalls, ["late-fresh-signed-id"]);
  deferredDiscovery.resolve();
  await lateStart;
  lateFallbackSession.stop();

  const pendingTitle = { ...title, tmdbId: 45 };
  const pendingResult = deferred();
  await prepareMovieSource(pendingTitle, {
    discover: async (_title, options) => options.onEvent("candidate", habster),
    resolve: () => pendingResult.promise,
  });
  let pendingState;
  const pendingPlaybackReady = deferred();
  let duplicateResolveCalls = 0;
  const pendingSession = createSourceSession({
    publish: (value) => { pendingState = value; if (value.stream) pendingPlaybackReady.resolve(); },
    discover: async (_title, { onEvent }) => {
      onEvent("candidate", { ...habster, id: "pending-playback-id" });
    },
    resolve: async () => { duplicateResolveCalls++; return result("https://media.test/duplicate.m3u8"); },
  });
  const pendingStart = pendingSession.start(pendingTitle);
  await tick();
  assert.equal(duplicateResolveCalls, 0, "click waits for the in-flight early resolve instead of duplicating it");
  pendingResult.resolve(result("https://media.test/pending-warm.m3u8"));
  await pendingPlaybackReady.promise;
  await pendingStart;
  assert.equal(duplicateResolveCalls, 0);
  assert.equal(pendingState.stream.hls, "https://media.test/pending-warm.m3u8");
  pendingSession.stop();

  const mismatchTitle = { ...title, runtimeMinutes: 102 };
  let mismatchResolves = 0;
  const mismatchSession = createSourceSession({
    publish: () => {},
    discover: async (_title, { onEvent }) => onEvent("candidate", { ...habster, id: "other-signed-id" }),
    resolve: async () => { mismatchResolves++; return result("https://media.test/mismatch.m3u8"); },
  });
  await mismatchSession.start(mismatchTitle);
  await tick();
  assert.equal(mismatchResolves, 1, "a different runtime cannot reuse the prepared sealed candidate");
  mismatchSession.stop();

  let expiredResolves = 0;
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 16_000;
    const expiredSession = createSourceSession({
      publish: () => {},
      discover: async (_title, { onEvent }) => onEvent("candidate", { ...habster, id: "expired-signed-id" }),
      resolve: async () => { expiredResolves++; return result("https://media.test/expired.m3u8"); },
    });
    await expiredSession.start(title);
    await tick();
    assert.equal(expiredResolves, 1, "prepared results expire after the short warm window");
    expiredSession.stop();
  } finally { Date.now = realNow; }

  const aborted = new AbortController();
  let abortSignal;
  await prepareMovieSource({ ...title, tmdbId: 43 }, {
    signal: aborted.signal,
    discover: async (_title, options) => options.onEvent("candidate", habster),
    resolve: async (_id, _quality, signal) => {
      abortSignal = signal;
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    },
  });
  aborted.abort();
  assert.equal(abortSignal, aborted.signal, "navigation cancellation reaches the early resolve request");
  const afterAbort = createSourceSession({
    publish: () => {},
    discover: async (_title, { onEvent }) => onEvent("candidate", { ...habster, id: "after-abort" }),
    resolve: async () => { throw new Error("expected ordinary resolve to fail in this fixture"); },
  });
  await afterAbort.start({ ...title, tmdbId: 43 });
  afterAbort.stop();

  const failedTitle = { ...title, tmdbId: 44 };
  const failedWarmResult = deferred();
  await prepareMovieSource(failedTitle, {
    discover: async (_title, options) => options.onEvent("candidate", habster),
    resolve: () => failedWarmResult.promise,
  });
  const fallbackCalls = [];
  const fallbackReady = deferred();
  const failedWarmSession = createSourceSession({
    publish: (value) => { if (value.stream) fallbackReady.resolve(); },
    discover: async (_title, { onEvent }) => onEvent("candidate", { ...habster, id: "failed-warm-fallback" }),
    resolve: async (id) => {
      fallbackCalls.push(id);
      if (id !== "failed-warm-fallback") throw new Error("prepared resolve failed");
      return result("https://media.test/fallback.m3u8");
    },
  });
  const failedWarmPlayback = failedWarmSession.start(failedTitle);
  failedWarmResult.reject(new Error("prepared resolve failed"));
  await fallbackReady.promise;
  await failedWarmPlayback;
  assert.deepEqual(fallbackCalls, ["failed-warm-fallback"],
    "if the prepared resolve fails, ordinary discovery's fresh signed candidate is still attempted");
  failedWarmSession.stop();

  const malformedTitle = { ...title, tmdbId: 46 };
  await prepareMovieSource(malformedTitle, {
    discover: async (_title, options) => options.onEvent("candidate", habster),
    resolve: async () => ({ kind: "hls", selected: {} }),
  });
  let malformedFallbackCalls = 0;
  const malformedSession = createSourceSession({
    publish: () => {},
    discover: async (_title, { onEvent }) => onEvent("candidate", { ...habster, id: "malformed-warm-fallback" }),
    resolve: async () => { malformedFallbackCalls++; return result("https://media.test/valid-fallback.m3u8"); },
  });
  await malformedSession.start(malformedTitle);
  await tick();
  assert.equal(malformedFallbackCalls, 1, "malformed prepared playback data falls back to a fresh resolve");
  malformedSession.stop();
}

async function skipRangesFollowActiveStream() {
  let state;
  const ranges = { a: [{ start: 5, end: 10 }], b: [{ start: 20, end: 30 }] };
  const session = createSourceSession({
    publish: (value) => { state = value; },
    discover: async (title, { onEvent }) => {
      if (title.title === "empty") return;
      for (const id of ["a", "b"]) onEvent("candidate", candidate(id));
    },
    resolve: async (id) => ({ ...result(`https://media.test/${id}.m3u8`), skip: ranges[id] }),
  });
  await session.start({ title: "Film" });
  await tick();
  assert.deepEqual(state.skip, ranges.a);
  session.notePlaying();
  await session.selectBalanser("b");
  assert.deepEqual(state.skip, ranges.b);
  session.reportPlaybackFailure();
  assert.deepEqual(state.skip, ranges.a, "restoring a stream restores its own skip intervals");
  await session.start({ title: "empty" });
  assert.equal(state.skip, null, "a new title cannot retain another source's intervals");
  session.stop();
}

async function audioNamesFollowActiveStream() {
  let state;
  const names = ["Рус. Дублированный", "Рус. Гоблин", "Українська", "English"];
  const tracks = names.map((_name, id) => ({ id, name: ["rus0", "rus1", "ukr2", "eng3"][id] }));
  const session = createSourceSession({
    publish: (value) => { state = value; },
    discover: async (title, { onEvent }) => {
      if (title.title === "empty") return;
      for (const id of ["habster", "native"]) onEvent("candidate", candidate(id));
    },
    resolve: async (id) => ({ ...result(`https://media.test/${id}.m3u8`), ...(id === "habster" ? { audioNames: names } : {}) }),
  });
  await session.start({ title: "Film" });
  await tick();
  assert.deepEqual(labelAudioTracks(tracks, state.audioNames).map((track) => track.name), names,
    "resolved studio labels replace generic HLS audio names");
  session.notePlaying();
  await session.selectBalanser("native");
  assert.deepEqual(state.audioNames, [], "a provider without labels cannot retain Habster studios");
  assert.deepEqual(labelAudioTracks(tracks, state.audioNames), tracks);
  session.reportPlaybackFailure();
  assert.deepEqual(state.audioNames, names, "restoring the playing source restores its own labels");
  await session.start({ title: "empty" });
  assert.deepEqual(state.audioNames, [], "a new title clears the prior source's labels");
  session.stop();
}

await progressiveRecoveryWithState();
await delayedHigherQualityRequiresManualChoice();
await decoderFailureUsesSibling();
await failedVoiceKeepsOtherVoices();
await fallbackRotatesProvidersAndStops();
await manualFailureAndStaleRequests();
await emptyDiscoveryAndSplitSse();
await prepareOnlyDiscoveryPreservesAbortSignal();
await preparedMovieResolveIsBoundedAndExact();
await skipRangesFollowActiveStream();
await audioNamesFollowActiveStream();
console.log("Source-host client checks passed: progressive fallback, explicit 4K choice, per-voice recovery, provider rotation, exhausted candidates, manual/stale requests, empty and prepare-only discovery, split SSE, audio labels.");
