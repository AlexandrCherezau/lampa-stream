import assert from "node:assert/strict";
import { createSourceSession, discoverSources } from "../src/utils/source-host-client.js";
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
  assert.equal(state.balanser, "alpha");
  assert.equal(session.reportPlaybackFailure(), true);
  await tick(); await tick();
  assert.deepEqual(calls, ["a", "b"]);
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
  assert.deepEqual(calls, ["a1", "b1", "a2"], "try another provider before its remaining voices");
  assert.equal(state.voice, "a2");
  assert.equal(session.reportPlaybackFailure(), true);
  await tick(); await tick();
  assert.deepEqual(calls, ["a1", "b1", "a2", "b2"]);
  assert.equal(state.voice, "b2");
  assert.equal(session.reportPlaybackFailure(), false);
  await tick(); await tick();
  assert.equal(calls.length, 4, "exhausted candidates are not retried forever");
  assert.match(state.sourceError.message, /Не найдено/);
  session.stop();
}

async function manualFailureAndStaleRequests() {
  const manual = deferred();
  const lateManual = deferred();
  const stale = deferred();
  let oldBCalls = 0;
  let state;
  let title = "old";
  const session = createSourceSession({
    publish: (value) => { state = value; },
    discover: async (value, { onEvent }) => { title = value.title; onEvent("candidate", candidate(`${value.title}-a`, `${value.title}-alpha`)); onEvent("candidate", candidate(`${value.title}-b`, `${value.title}-beta`)); },
    resolve: async (id) => {
      if (id === "old-a") return result("https://media.test/old.m3u8");
      if (id === "old-b") return oldBCalls++ === 0 ? manual.promise : lateManual.promise;
      if (id === "new-a") return stale.promise;
      return result("https://media.test/new-b.m3u8");
    },
  });
  await session.start({ title: "old" });
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
await skipRangesFollowActiveStream();
await audioNamesFollowActiveStream();
console.log("Source-host client checks passed: progressive fallback, explicit 4K choice, per-voice recovery, provider rotation, exhausted candidates, manual/stale requests, empty and prepare-only discovery, split SSE, audio labels.");
