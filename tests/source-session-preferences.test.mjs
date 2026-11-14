import test from "node:test";
import assert from "node:assert/strict";
import { createSourceSession, discoverSources } from "../src/utils/source-host-client.js";
import { storage, STORAGE_KEYS } from "../src/utils/storage.js";

const candidate = (id, voiceId, voiceName) => ({
  id, providerId: "habster:alloha", providerName: "Habster · Alloha", voiceId, voiceName,
});
const result = (quality = "720p") => ({
  kind: "hls", selected: { label: quality, url: `https://media.invalid/${quality}.m3u8` },
  qualities: [{ label: quality, height: 720 }], subtitles: [], audioNames: [],
});
const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function globalPreference(t, initial = null) {
  let value = initial;
  const writes = [];
  t.mock.method(storage, "get", (key) => key === STORAGE_KEYS.GLOBAL_SOURCE_PREFERENCE ? value : null);
  t.mock.method(storage, "set", (key, next) => {
    assert.equal(key, STORAGE_KEYS.GLOBAL_SOURCE_PREFERENCE);
    value = next;
    writes.push(next);
  });
  return { writes, get value() { return value; } };
}

for (const { name, global, title, expected } of [
  { name: "newer global provider overrides the title's voice and quality", global: { providerId: "global", updatedAt: 200 },
    title: { providerId: "title", voiceId: "dub", quality: "2160p", updatedAt: 100 }, expected: { id: "global-default", quality: undefined } },
  { name: "global provider overrides a title preference with a newer checkpoint timestamp", global: { providerId: "global", updatedAt: 100 },
    title: { providerId: "title", voiceId: "dub", quality: "2160p", updatedAt: 200 }, expected: { id: "global-default", quality: undefined } },
  { name: "global provider overrides a title preference with an equal timestamp", global: { providerId: "global", updatedAt: 100 },
    title: { providerId: "title", voiceId: "dub", quality: "2160p", updatedAt: 100 }, expected: { id: "global-default", quality: undefined } },
  { name: "matching global provider keeps the title's own voice and quality", global: { providerId: "title", updatedAt: 200 },
    title: { providerId: "title", voiceId: "dub", quality: "2160p", updatedAt: 100 }, expected: { id: "title-dub", quality: "2160p" } },
  { name: "matching global provider keeps a title voice restored by name", global: { providerId: "title", updatedAt: 100 },
    title: { providerId: "title", voiceName: "dub", quality: "2160p", updatedAt: 200 }, expected: { id: "title-dub", quality: "2160p" } },
  { name: "no global pick restores the title's voice and quality as before", global: null,
    title: { providerId: "title", voiceId: "dub", voiceName: "dub", quality: "2160p", updatedAt: 200 }, expected: { id: "title-dub", quality: "2160p" } },
  { name: "global pick applies when the title has no checkpoint", global: { providerId: "global", updatedAt: 200 },
    title: null, expected: { id: "global-default", quality: undefined } },
  { name: "newer audio-only checkpoint cannot suppress the global provider", global: { providerId: "global", updatedAt: 100 },
    title: { audio: { lang: "ru" }, quality: "2160p", updatedAt: 200 }, expected: { id: "global-default", quality: undefined } },
  { name: "legacy title checkpoint yields to a timestamped global pick", global: { providerId: "global", updatedAt: 200 },
    title: { providerId: "title", voiceId: "dub", quality: "2160p" }, expected: { id: "global-default", quality: undefined } },
  { name: "malformed global timestamp leaves the title alone", global: { providerId: "global", updatedAt: "bad" },
    title: { providerId: "title", voiceId: "dub", quality: "2160p" }, expected: { id: "title-dub", quality: "2160p" } },
]) test(name, async (t) => {
  const saved = globalPreference(t, global);
  const calls = [];
  const session = createSourceSession({ publish() {},
    discover: async (_title, { onEvent }) => {
      for (const [id, providerId, voiceId] of [["title-default", "title", "default"], ["title-dub", "title", "dub"], ["global-default", "global", "default"]]) {
        onEvent("candidate", { ...candidate(id, voiceId, voiceId), providerId, providerName: providerId });
      }
    },
    resolve: async (id, quality) => { calls.push({ id, quality }); return result(); },
  });
  try {
    await session.start({ title: name }, title);
    await tick();
    assert.deepEqual(calls, [expected]);
    assert.deepEqual(saved.writes, []);
  } finally { session.stop(); }
});

for (const unavailable of ["missing", "fails"]) test(`unavailable global provider (${unavailable}) uses automatic fallback without saving it`, async (t) => {
  const saved = globalPreference(t, { providerId: "preferred", updatedAt: 200 });
  const calls = [];
  let state;
  const session = createSourceSession({ publish: (value) => { state = value; },
    discover: async (_title, { onEvent }) => {
      for (const id of ["fallback", ...(unavailable === "fails" ? ["preferred"] : [])]) {
        onEvent("candidate", { ...candidate(id, id, id), providerId: id, providerName: id });
      }
    },
    resolve: async (id, quality) => {
      calls.push({ id, quality });
      if (id === "preferred") throw new Error("unavailable");
      return result();
    },
  });
  try {
    await session.start({ title: unavailable }, { providerId: "old-title", quality: "2160p", updatedAt: 100 });
    for (let i = 0; i < 5 && !state.stream; i++) await tick();
    assert.equal(state.balanser, "fallback");
    assert.equal(state.sourcePreference, null);
    assert.deepEqual(calls, unavailable === "fails" ? [{ id: "preferred", quality: undefined }, { id: "fallback", quality: undefined }] : [{ id: "fallback", quality: undefined }]);
    assert.deepEqual(saved.writes, []);
    assert.deepEqual(saved.value, { providerId: "preferred", updatedAt: 200 });
  } finally { session.stop(); }
});

test("only manual picks save a global provider, surviving automatic hops and episode restarts", async (t) => {
  const saved = globalPreference(t);
  t.mock.method(Date, "now", () => 500);
  let state;
  const session = createSourceSession({ publish: (value) => { state = value; },
    discover: async (_title, { onEvent }) => {
      for (const id of ["first", "picked"]) onEvent("candidate", { ...candidate(id, id, id), providerId: id, providerName: id });
    },
    resolve: async () => result(),
  });
  try {
    await session.start({ type: "tv", title: "Series", season: 1, episode: 1 }); await tick();
    assert.deepEqual(saved.writes, []);
    await session.selectBalanser("picked");
    assert.deepEqual(saved.value, { providerId: "picked", updatedAt: 500 });
    session.notePlaying();
    session.abandonCurrent(); await tick();
    assert.equal(state.balanser, "first");
    assert.equal(saved.writes.length, 1);
    await session.start({ type: "tv", title: "Series", season: 1, episode: 2 }); await tick();
    assert.equal(state.balanser, "picked");
    assert.equal(saved.writes.length, 1);
    await session.selectVoice("picked");
    await session.selectQuality("2160p");
    assert.equal(saved.writes.length, 3);
    assert.deepEqual(saved.value, { providerId: "picked", updatedAt: 500 });
  } finally { session.stop(); }
});

test("restores a saved stable voice and quality before starting another discovered voice", async () => {
  const calls = [];
  const snapshots = [];
  const session = createSourceSession({
    publish: (state) => snapshots.push(state),
    resolve: async (id, quality) => { calls.push({ id, quality }); return result(quality || "720p"); },
    discover: async (_title, { onEvent }) => {
      onEvent("candidate", candidate("temporary-candidate-a", "default", "Основная озвучка"));
      onEvent("candidate", candidate("temporary-candidate-b", "alloha:7", "Red Head Sound"));
    },
  });
  session.start({ type: "movie", title: "Fixture" }, {
    providerId: "habster:alloha", voiceId: "alloha:7", voiceName: "Red Head Sound", quality: "2160p",
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [{ id: "temporary-candidate-b", quality: "2160p" }]);
  const active = snapshots.at(-1);
  assert.deepEqual(active.sourcePreference, {
    providerId: "habster:alloha", voiceId: "alloha:7", voiceName: "Red Head Sound",
  });
  assert.equal(JSON.stringify(active.sourcePreference).includes("temporary-candidate-b"), false);
  session.stop();
});

test("falls back after discovery if the saved stable voice is no longer available", async () => {
  const calls = [];
  const session = createSourceSession({
    publish() {},
    resolve: async (id, quality) => { calls.push({ id, quality }); return result(); },
    discover: async (_title, { onEvent }) => {
      onEvent("candidate", candidate("temporary-candidate", "default", "Основная озвучка"));
    },
  });
  session.start({ type: "movie", title: "Fixture" }, {
    providerId: "habster:alloha", voiceId: "alloha:7", voiceName: "Red Head Sound", quality: "2160p",
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [{ id: "temporary-candidate", quality: undefined }]);
  session.stop();
});

test("keeps the fast first-candidate path when there is no saved source preference", async () => {
  const calls = [];
  const session = createSourceSession({
    publish() {},
    resolve: async (id, quality) => { calls.push({ id, quality }); return result(); },
    discover: async (_title, { onEvent }) => {
      onEvent("candidate", candidate("temporary-candidate", "default", "Основная озвучка"));
    },
  });
  session.start({ type: "movie", title: "Fixture" }, { audio: { name: "Russian", lang: "ru" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [{ id: "temporary-candidate", quality: undefined }]);
  session.stop();
});

test("races two distinct providers and ignores an aborted late result", async () => {
  const slow = deferred();
  const calls = [];
  let state;
  const ready = deferred();
  const session = createSourceSession({
    publish: (value) => { state = value; if (value.stream) ready.resolve(); },
    discover: async (_title, { onEvent }) => {
      onEvent("candidate", { ...candidate("slow", "v1", "Original"), providerId: "slow", providerName: "Slow" });
      onEvent("candidate", { ...candidate("fast", "v2", "Original"), providerId: "fast", providerName: "Fast" });
    },
    resolve: (id, _quality, signal) => {
      calls.push(id);
      if (id === "slow") return slow.promise;
      return Promise.resolve(result("fast"));
    },
  });
  const started = session.start({ title: "Race" });
  await ready.promise;
  assert.deepEqual(calls, ["slow", "fast"]);
  assert.equal(state.balanser, "fast");
  slow.resolve({ kind: "hls", selected: { url: "https://media.invalid/late.m3u8" } });
  await started;
  await tick();
  assert.equal(state.stream.hls, "https://media.invalid/fast.m3u8");
  session.stop();
});

test("does not race duplicate voices from one provider", async () => {
  const calls = [];
  let state;
  const ready = deferred();
  const session = createSourceSession({
    publish: (value) => { state = value; if (value.stream) ready.resolve(); },
    discover: async (_title, { onEvent }) => {
      onEvent("candidate", { ...candidate("voice-1", "a", "Voice 1"), providerId: "same", providerName: "Same" });
      onEvent("candidate", { ...candidate("voice-2", "b", "Voice 2"), providerId: "same", providerName: "Same" });
      onEvent("candidate", { ...candidate("other", "c", "Voice 3"), providerId: "other", providerName: "Other" });
    },
    resolve: async (id) => { calls.push(id); return result(id); },
  });
  await session.start({ title: "Distinct providers" });
  await ready.promise;
  assert.deepEqual(calls, ["voice-1", "other"]);
  assert.equal(state.balanser, "same");
  session.stop();
});

test("manual selection cancels pending automatic races and keeps the current stream on failure", async () => {
  const automatic = deferred();
  let automaticAborted = false;
  let state;
  const session = createSourceSession({
    publish: (value) => { state = value; },
    discover: async (_title, { onEvent }) => {
      onEvent("candidate", { ...candidate("current", "c", "Current"), providerId: "current", providerName: "Current" });
      onEvent("candidate", { ...candidate("slow", "s", "Slow"), providerId: "slow", providerName: "Slow" });
      onEvent("candidate", { ...candidate("manual", "m", "Manual"), providerId: "manual", providerName: "Manual" });
    },
    resolve: async (id, _quality, signal) => {
      if (id === "slow") { signal.addEventListener("abort", () => { automaticAborted = true; }, { once: true }); return automatic.promise; }
      if (id === "manual") throw Object.assign(new Error("manual failed"), { status: 503 });
      return result("current");
    },
  });
  const started = session.start({ title: "Manual" });
  await tick(); await tick();
  assert.equal(state.balanser, "current");
  const previous = state.stream;
  assert.equal(await session.selectBalanser("manual"), false);
  assert.equal(automaticAborted, true);
  assert.equal(state.balanser, "current");
  assert.deepEqual(state.stream, previous);
  assert.match(state.sourceError.message, /manual failed/);
  automatic.resolve(result("late"));
  await started;
  await tick();
  assert.deepEqual(state.stream, previous);
  session.stop();
});

test("a saved provider arriving inside its short headstart wins the initial race", async () => {
  const calls = [];
  let state;
  const ready = deferred();
  const discovery = deferred();
  const session = createSourceSession({
    publish: (value) => { state = value; if (value.stream) ready.resolve(); },
    discover: async (_title, { onEvent }) => {
      onEvent("candidate", { ...candidate("ordinary", "o", "Ordinary"), providerId: "ordinary", providerName: "Ordinary" });
      await discovery.promise;
      onEvent("candidate", { ...candidate("saved", "s", "Saved"), providerId: "saved", providerName: "Saved" });
    },
    resolve: async (id) => { calls.push(id); return result(id); },
  });
  const started = session.start({ title: "Preference" }, { providerId: "saved", voiceId: "s", voiceName: "Saved" });
  await new Promise((resolve) => setTimeout(resolve, 50));
  discovery.resolve();
  await ready.promise;
  assert.equal(state.balanser, "saved");
  assert.ok(calls.includes("saved"));
  await started;
  session.stop();
});

test("a late saved provider does not replace an already-started fallback", async () => {
  let lateEvent;
  const calls = [];
  let state;
  const ready = deferred();
  const session = createSourceSession({
    publish: (value) => { state = value; if (value.stream) ready.resolve(); },
    discover: async (_title, { onEvent }) => { lateEvent = onEvent; onEvent("candidate", { ...candidate("fallback", "f", "Fallback"), providerId: "fallback", providerName: "Fallback" }); },
    resolve: async (id) => { calls.push(id); return result(id); },
  });
  await session.start({ title: "Late preference" }, { providerId: "saved", voiceId: "s", voiceName: "Saved" });
  await new Promise((resolve) => setTimeout(resolve, 1_600));
  await ready.promise;
  const playing = state.stream;
  lateEvent("candidate", { ...candidate("saved", "s", "Saved"), providerId: "saved", providerName: "Saved" });
  await tick();
  assert.equal(state.balanser, "fallback");
  assert.deepEqual(state.stream, playing);
  assert.deepEqual(calls, ["fallback"]);
  session.stop();
});

test("cooldown sends automatic retries to the back of the queue, expires, and still allows manual retry", async () => {
  const calls = [];
  let state;
  const first = createSourceSession({
    publish: (value) => { state = value; },
    discover: async (_title, { onEvent }) => {
      onEvent("candidate", { ...candidate("cooldown-1", "1", "First"), providerId: "cooldown-test", providerName: "Cooling" });
      onEvent("candidate", { ...candidate("cooldown-2", "2", "Second"), providerId: "cooldown-test", providerName: "Cooling" });
      onEvent("candidate", { ...candidate("other", "o", "Other"), providerId: "other-cooldown-test", providerName: "Other" });
    },
    resolve: async (id) => {
      calls.push(id);
      throw Object.assign(new Error("temporarily unavailable"), { status: 503 });
    },
  });
  await first.start({ title: "Cooldown" });
  for (let i = 0; i < 5 && !state.sourceError; i++) await tick();
  assert.deepEqual(calls.slice(-1), ["cooldown-2"], "the cooling voice is tried only after every other source");
  assert.deepEqual([...calls].sort(), ["cooldown-1", "cooldown-2", "other"]);
  first.stop();

  const realNow = Date.now;
  try {
    Date.now = () => realNow() + 31_000;
    const expiredCalls = [];
    const expired = createSourceSession({
      publish: (value) => { state = value; },
      discover: async (_title, { onEvent }) => onEvent("candidate", {
        ...candidate("cooldown-after-expiry", "3", "Third"), providerId: "cooldown-test", providerName: "Cooling",
      }),
      resolve: async (id) => { expiredCalls.push(id); return result("expired"); },
    });
    await expired.start({ title: "Cooldown expired" });
    for (let i = 0; i < 5 && !state.stream; i++) await tick();
    assert.deepEqual(expiredCalls, ["cooldown-after-expiry"]);
    expired.stop();
  } finally { Date.now = realNow; }

  let manualCalls = 0;
  const manual = createSourceSession({
    publish: (value) => { state = value; },
    discover: async (_title, { onEvent }) => onEvent("candidate", {
      ...candidate("manual-cooldown", "m", "Manual"), providerId: "manual-cooldown-test", providerName: "Manual",
    }),
    resolve: async () => {
      if (++manualCalls === 1) throw Object.assign(new Error("rate limited"), { status: 429 });
      return result("manual-retry");
    },
  });
  await manual.start({ title: "Manual cooldown" });
  for (let i = 0; i < 5 && !state.sourceError; i++) await tick();
  assert.equal(await manual.selectBalanser("manual-cooldown-test"), true);
  assert.equal(manualCalls, 2);
  assert.equal(state.stream.hls, "https://media.invalid/manual-retry.m3u8");
  manual.stop();
});

test("accumulated candidates still race distinct providers after an absent saved voice", async () => {
  const calls = [];
  const slow = deferred();
  let state;
  const session = createSourceSession({
    publish: (value) => { state = value; },
    discover: async (_title, { onEvent }) => {
      for (const id of ["a1", "a2", "b1"]) onEvent("candidate", {
        ...candidate(id, id, id), providerId: id[0], providerName: id[0],
      });
    },
    resolve: async (id) => { calls.push(id); return id[0] === "a" ? slow.promise : result("fast"); },
  });
  await session.start({ title: "Absent preference" }, { providerId: "missing", voiceId: "missing" });
  await tick();
  assert.deepEqual(calls, ["a1", "b1"]);
  assert.equal(state.balanser, "b");
  session.stop();
  slow.resolve(result("late"));
});

test("one failed voice never blocks another voice or title, whatever the upstream answered", async (t) => {
  let calls = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    const { id } = JSON.parse(options.body);
    calls.push(id);
    if (id.startsWith("bad")) return new Response(JSON.stringify({ error: "MEDIA_UNAVAILABLE",
      sourceMediaCode: "UPSTREAM_HTTP_ERROR", sourceUpstreamStatus: Number(id.slice(3)) }), { status: 502 });
    return new Response(JSON.stringify(result()), { status: 200 });
  });
  for (const status of [404, 451, 503]) {
    const providerId = `upstream-${status}`;
    const source = (id) => ({ ...candidate(id, id, id), providerId, providerName: providerId });
    const run = async (ids) => {
      let state;
      const session = createSourceSession({ publish: (value) => { state = value; },
        discover: async (_title, { onEvent }) => ids.forEach((id) => onEvent("candidate", source(id))),
      });
      await session.start({ title: "Fixture" });
      await tick(); await tick();
      session.stop();
      return state;
    };
    calls = [];
    const first = await run([`bad${status}`, "other-voice"]);
    assert.ok(first.stream);
    assert.deepEqual(calls, [`bad${status}`, "other-voice"]);
    calls = [];
    const second = await run(["other-title"]);
    assert.ok(second.stream);
    assert.deepEqual(calls, ["other-title"]);
  }
});

test("a failed explicit quality does not cool down a provider with working automatic quality", async () => {
  const provider = { ...candidate("quality-candidate", "v", "Voice"), providerId: "quality-cooldown-test" };
  let calls = 0;
  let state;
  const session = createSourceSession({
    publish: (value) => { state = value; },
    discover: async (_title, { onEvent }) => onEvent("candidate", provider),
    resolve: async (_id, quality) => {
      calls++;
      if (quality) throw Object.assign(new Error("one rendition unavailable"), { status: 502, sourceUpstreamStatus: 503 });
      return result();
    },
  });
  await session.start({ title: "First title" });
  await tick();
  session.notePlaying();
  const playing = state.stream;
  assert.equal(await session.selectQuality("2160p"), false);
  assert.deepEqual(state.stream, playing);
  await session.start({ title: "Second title" });
  await tick();
  assert.equal(calls, 3);
  assert.ok(state.stream);
  session.stop();
});

test("saved voice gets its headstart to resolve even when discovery has already finished", async () => {
  const calls = [];
  const saved = deferred();
  let state;
  const session = createSourceSession({ publish: (value) => { state = value; },
    discover: async (_title, { onEvent }) => {
      onEvent("candidate", { ...candidate("ordinary", "o", "Ordinary"), providerId: "ordinary" });
      onEvent("candidate", { ...candidate("saved", "s", "Saved"), providerId: "saved" });
    },
    resolve: async (id) => { calls.push(id); return id === "saved" ? saved.promise : result("ordinary"); },
  });
  await session.start({ title: "Saved voice" }, { providerId: "saved", voiceId: "s" });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.deepEqual(calls, ["saved"]);
  saved.resolve(result("saved"));
  await tick();
  assert.equal(state.balanser, "saved");
  session.stop();
});

test("local server congestion and cold startup do not poison provider health", async () => {
  for (const [code, status] of [["BUSY", 429], ["ENGINE_STARTING", 503]]) {
    let calls = 0;
    let state;
    const session = createSourceSession({ publish: (value) => { state = value; },
      discover: async (_title, { onEvent }) => onEvent("candidate", {
        ...candidate(code, "v", "Voice"), providerId: `local-${code}`,
      }),
      resolve: async () => {
        if (++calls === 1) throw Object.assign(new Error(code), { code, status });
        return result();
      },
    });
    await session.start({ title: "Before capacity frees" });
    await tick();
    await session.start({ title: "After capacity frees" });
    await tick();
    assert.equal(calls, 2);
    assert.ok(state.stream);
    session.stop();
  }
});

test("automatic source deadlines abort stalled providers and let the next provider start", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls = [];
  const aborted = [];
  const slow = deferred();
  let state;
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const session = createSourceSession({ publish: (value) => { state = value; },
    discover: async (_title, { onEvent }) => ["a", "b", "c"].forEach((id) => onEvent("candidate", {
      ...candidate(id, id, id), providerId: `deadline-${id}`,
    })),
    resolve: async (id, _quality, signal) => {
      calls.push(id);
      if (id === "c") return result("fast");
      signal.addEventListener("abort", () => aborted.push(id), { once: true });
      return slow.promise;
    },
  });
  await session.start({ title: "Bounded sources" });
  await flush();
  assert.deepEqual(calls, ["a", "b"]);
  t.mock.timers.tick(10_000);
  await flush(); await flush();
  assert.deepEqual(aborted, ["a", "b"]);
  assert.deepEqual(calls, ["a", "b", "c"]);
  assert.equal(state.balanser, "deadline-c");
  slow.resolve(result("late"));
  await flush();
  assert.equal(state.balanser, "deadline-c");
  session.stop();
});

test("discovery retries a busy server before the stream starts, then gives up", async () => {
  const realFetch = globalThis.fetch;
  const busy = () => new Response(JSON.stringify({ error: "BUSY", message: "busy" }), { status: 429 });
  const stream = () => new Response("event: candidate\ndata: {\"id\":\"a\"}\n\n");
  try {
    let calls = 0;
    globalThis.fetch = async () => (++calls < 3 ? busy() : stream());
    const events = [];
    await discoverSources({ type: "movie" }, { onEvent: (name, value) => events.push([name, value.id]), busyRetryDelays: [1, 1] });
    assert.equal(calls, 3);
    assert.deepEqual(events, [["candidate", "a"]]);

    calls = 0;
    globalThis.fetch = async () => { calls++; return busy(); };
    await assert.rejects(discoverSources({ type: "movie" }, { onEvent() {}, busyRetryDelays: [1] }), (error) => error.status === 429);
    assert.equal(calls, 2);

    calls = 0;
    const controller = new AbortController();
    globalThis.fetch = async () => { calls++; controller.abort(new Error("left")); return busy(); };
    await assert.rejects(discoverSources({ type: "movie" }, { signal: controller.signal, onEvent() {}, busyRetryDelays: [60_000] }));
    assert.equal(calls, 1);

    calls = 0;
    const leaving = new AbortController();
    globalThis.fetch = async () => { calls++; setTimeout(() => leaving.abort(new Error("left")), 1); return busy(); };
    await assert.rejects(discoverSources({ type: "movie" }, { signal: leaving.signal, onEvent() {}, busyRetryDelays: [60_000] }), /left/);
    assert.equal(calls, 1);

    calls = 0;
    globalThis.fetch = async () => { calls++; return new Response("{}", { status: 502 }); };
    await assert.rejects(discoverSources({ type: "movie" }, { onEvent() {}, busyRetryDelays: [1] }), (error) => error.status === 502);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});
