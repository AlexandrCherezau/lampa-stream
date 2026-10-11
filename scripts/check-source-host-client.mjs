import assert from "node:assert/strict";
import { createSourceSession, discoverSources } from "../src/utils/source-host-client.js";

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
  const session = createSourceSession({
    publish: (value) => { state = value; if (value.stream) playbackReady.resolve(); },
    discover: async (_title, { onEvent }) => {
      onEvent("candidate", candidate("one", "working"));
      await discoveryGate.promise;
      onEvent("candidate", candidate("two", "sibling"));
      discoveryFinished = true;
    },
    resolve: async (id) => result(`https://media.test/${id}.m3u8`),
  });
  const started = session.start({ title: "Film" });
  await playbackReady.promise;
  assert.equal(discoveryFinished, false, "playback starts before discovery finishes");
  assert.deepEqual(state.stream, { hls: "https://media.test/one.m3u8" });
  discoveryGate.resolve();
  await started;
  assert.equal(state.balanser, "working");
  assert.equal(state.sourceError, null);
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

await progressiveRecoveryWithState();
await decoderFailureUsesSibling();
await manualFailureAndStaleRequests();
await emptyDiscoveryAndSplitSse();
console.log("Source-host client checks passed: progressive fallback, decoder failure, manual/stale requests, empty discovery, split SSE.");
