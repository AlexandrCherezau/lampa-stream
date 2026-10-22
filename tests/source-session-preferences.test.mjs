import test from "node:test";
import assert from "node:assert/strict";
import { createSourceSession } from "../src/utils/source-host-client.js";

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

test("cooldown skips automatic retries, expires, and still allows manual retry", async () => {
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
  assert.deepEqual(calls.sort(), ["cooldown-1", "other"]);
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

test("missing media does not cool down another voice or title, while upstream 503 does", async (t) => {
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
    assert.equal(Boolean(first.stream), status !== 503);
    assert.deepEqual(calls, status === 503 ? [`bad${status}`] : [`bad${status}`, "other-voice"]);
    calls = [];
    const second = await run(["other-title"]);
    assert.equal(Boolean(second.stream), status !== 503);
    assert.deepEqual(calls, status === 503 ? [] : ["other-title"]);
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
