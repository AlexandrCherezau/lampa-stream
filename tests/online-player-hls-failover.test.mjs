import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/components/OnlinePlayer.jsx", import.meta.url), "utf8");
const marker = "hls.on(Hls.Events.ERROR, async (_e, data) => {";
const start = source.indexOf(marker);
const end = source.indexOf("\n      });\n    };", start);
assert.ok(start >= 0 && end > start, "find the production HLS error callback");
const callbackBody = source.slice(start + marker.length, end);
const names = ["Hls", "data", "hls", "errCountRef", "isLampac", "fleetPlayedRef", "fleetHasPlayedRef", "fleetFailover", "refreshCurrentSource", "setState", "setError", "hlsRef", "resumeTargetRef", "videoRef", "saveResumeTime"];
const streamUpdaterMarker = "setStream((previous) => {";
const updaterStart = source.indexOf(streamUpdaterMarker);
const updaterEnd = source.indexOf("\n      });", updaterStart);
assert.ok(updaterStart >= 0 && updaterEnd > updaterStart, "find the production stream identity updater");
const streamUpdaterBody = source.slice(updaterStart + streamUpdaterMarker.length, updaterEnd);
const pauseAttachStart = source.indexOf("const recoveringStream = recoveryPendingRef.current;");
const pauseAttachEnd = source.indexOf("resumeDoneRef.current = false;", pauseAttachStart);
assert.ok(pauseAttachStart >= 0 && pauseAttachEnd > pauseAttachStart, "find the production recovery pause-preservation branch");
const pauseAttachBody = source.slice(pauseAttachStart, pauseAttachEnd);
const monitorStart = source.indexOf("let lastTime = v.currentTime || 0;", source.indexOf("// A fatal engine error is not the only way"));
const monitorEnd = source.indexOf("const onReset = () => resetStall();", monitorStart);
assert.ok(monitorStart >= 0 && monitorEnd > monitorStart, "find the production playback-stall checker");
const monitorBody = source.slice(monitorStart, monitorEnd);
const monitorEffectStart = source.indexOf("// A fatal engine error is not the only way");
const monitorEffectEnd = source.indexOf("// ── AniList + AniSkip", monitorEffectStart);
assert.ok(monitorEffectStart >= 0 && monitorEffectEnd > monitorEffectStart, "find the production playback-stall effect");
const monitorEffect = source.slice(monitorEffectStart, monitorEffectEnd);
const hlsStart = source.indexOf("const attachHls = async () => {");
const hlsQualityStart = source.indexOf("const preferredQuality = recoveringStream ? recoveryQualityRef.current : null;", hlsStart);
const hlsQualityEnd = source.indexOf("recoveryQualityRef.current = null;", hlsQualityStart) + "recoveryQualityRef.current = null;".length;
assert.ok(hlsStart >= 0 && hlsQualityStart > hlsStart && hlsQualityEnd > hlsQualityStart, "find the production HLS quality restore branch");
const hlsQualityBody = source.slice(hlsQualityStart, hlsQualityEnd);
const refreshCallbackStart = source.indexOf("async (previousEngine = engineRef.current) => {", source.indexOf("const refreshCurrentSource = useCallback("));
const refreshCallbackEnd = source.indexOf("\n  }, []);", refreshCallbackStart);
assert.ok(refreshCallbackStart >= 0 && refreshCallbackEnd > refreshCallbackStart, "find the production same-source refresh callback");
const refreshCallback = source.slice(refreshCallbackStart, refreshCallbackEnd + 4);

function createCallback(options = {}) {
  const { played = false } = options;
  const refreshResult = Object.hasOwn(options, "refreshResult") ? options.refreshResult : false;
  const calls = [];
  const video = { currentTime: 135 };
  const resumeTargetRef = { current: null };
  const hls = {
    destroy() {
      calls.push(["destroy"]);
      video.currentTime = 0;
      calls.push(["pauseSaveResume", resumeTargetRef.current ?? video.currentTime]);
    },
    startLoad() { calls.push(["startLoad"]); },
    recoverMediaError() { calls.push(["recoverMediaError"]); },
  };
  const refs = {
    errCountRef: { current: 0 },
    fleetPlayedRef: { current: played },
    fleetHasPlayedRef: { current: played },
    hlsRef: { current: hls },
    resumeTargetRef,
    videoRef: { current: video },
  };
  const env = {
    Hls: { ErrorTypes: { NETWORK_ERROR: "networkError", MEDIA_ERROR: "mediaError" } },
    hls,
    isLampac: true,
    fleetFailover: () => { calls.push(["failover"]); return true; },
    refreshCurrentSource: async () => { calls.push(["refreshCurrentSource"]); return refreshResult; },
    setState: (value) => calls.push(["state", value]),
    setError: (value) => calls.push(["error", value]),
    saveResumeTime: (value) => calls.push(["saveResumeTime", value]),
    ...refs,
  };
  const invoke = new Function(...names, `return (async () => { ${callbackBody} })()`);
  return {
    calls,
    fire(type) { return invoke(...names.map((name) => name === "data" ? { fatal: true, type, details: "test" } : env[name])); },
  };
}

test("fatal startup network error can fail over before decoded playback", async () => {
  const run = createCallback();
  await run.fire("networkError");
  assert.deepEqual(run.calls.map(([name]) => name), ["destroy", "pauseSaveResume", "failover"]);
});

test("established stream retries transient fatal network errors on the same source", async () => {
  const run = createCallback({ played: true });
  await run.fire("networkError");
  assert.deepEqual(run.calls, [["startLoad"]]);
});

test("exhausted established stream refreshes the same source after saving position before teardown", async () => {
  const run = createCallback({ played: true, refreshResult: true });
  for (let attempt = 0; attempt < 5; attempt++) await run.fire("networkError");
  assert.equal(run.calls.filter(([name]) => name === "startLoad").length, 4);
  assert.equal(run.calls.some(([name]) => name === "failover"), false);
  assert.deepEqual(run.calls.slice(-4), [["saveResumeTime", 135], ["destroy"], ["pauseSaveResume", 135], ["refreshCurrentSource"]]);
  assert.equal(run.calls.some(([name]) => name === "state" || name === "error"), false);
});

test("failed same-source refresh reaches the terminal error after bounded HLS retries", async () => {
  const run = createCallback({ played: true });
  for (let attempt = 0; attempt < 5; attempt++) await run.fire("networkError");
  assert.equal(run.calls.filter(([name]) => name === "startLoad").length, 4);
  assert.equal(run.calls.some(([name]) => name === "failover"), false);
  assert.deepEqual(run.calls, [["startLoad"], ["startLoad"], ["startLoad"], ["startLoad"], ["saveResumeTime", 135], ["destroy"], ["pauseSaveResume", 135], ["refreshCurrentSource"], ["state", "error"], ["error", "Поток прерван (CDN нестабилен). test"]]);
});

test("stale or cancelled same-source refresh does not overwrite newer player state", async () => {
  const run = createCallback({ played: true, refreshResult: undefined });
  for (let attempt = 0; attempt < 5; attempt++) await run.fire("networkError");
  assert.equal(run.calls.some(([name]) => name === "state" || name === "error"), false);
});

test("late media decode error still invokes bounded in-place recovery", async () => {
  const run = createCallback({ played: true });
  await run.fire("mediaError");
  assert.deepEqual(run.calls, [["recoverMediaError"]]);
});

test("healthy same-URL discovery update preserves the current stream instance", () => {
  const updater = new Function("previous", "ls", "forceReattach", streamUpdaterBody);
  const previous = { hls: "https://cdn.test/video.m3u8", viaRelay: false };
  const next = updater(previous, { hls: previous.hls, viaRelay: false }, false);
  assert.equal(next, previous);
});

test("same-URL manual retry after HLS teardown creates a fresh stream instance", () => {
  const updater = new Function("previous", "ls", "forceReattach", streamUpdaterBody);
  const previous = { hls: "https://cdn.test/video.m3u8", viaRelay: false };
  const manualRetryResolved = true;
  const forceReattach = manualRetryResolved;
  const next = updater(previous, { hls: previous.hls, viaRelay: false }, forceReattach);
  assert.notEqual(next, previous);
  assert.equal(next.hls, previous.hls);
});

test("same-URL automatic recovery forces a fresh media-engine attachment", () => {
  const updater = new Function("previous", "ls", "forceReattach", streamUpdaterBody);
  const previous = { hls: "https://cdn.test/video.m3u8", viaRelay: false };
  const forceReattach = true;
  const next = updater(previous, { hls: previous.hls, viaRelay: false }, forceReattach);
  assert.notEqual(next, previous);
  assert.equal(next.hls, previous.hls);
  const forceSnapshot = source.indexOf("const forceReattach = forceStreamReattachRef.current;");
  const forceClear = source.indexOf("forceStreamReattachRef.current = false;", forceSnapshot);
  assert.ok(forceSnapshot >= 0 && forceSnapshot < forceClear && forceClear < updaterStart, "snapshot and clear the recovery flag before the pure state updater");
});

test("a fresh same-source attachment retains an explicit user pause", () => {
  const attachPause = new Function("recoveryPendingRef", "userPausedRef", pauseAttachBody);
  const userPausedRef = { current: true };
  const recoveryPendingRef = { current: true };
  attachPause(recoveryPendingRef, userPausedRef);
  assert.equal(userPausedRef.current, true);
  assert.equal(recoveryPendingRef.current, false);

  userPausedRef.current = false;
  attachPause({ current: false }, userPausedRef);
  assert.equal(userPausedRef.current, false);
});

test("same-source HLS recovery reapplies the saved engine quality when it exists", () => {
  const restore = new Function("recoveringStream", "recoveryQualityRef", "lvls", "hls", "setCurrentLevel", `${hlsQualityBody}; return recoveryQualityRef.current;`);
  const recoveryQualityRef = { current: "720p" };
  const hls = { levels: [{ height: 1080 }, { height: 720 }] };
  let selected = null;
  restore(true, recoveryQualityRef, [{ height: 1080, label: "1080p" }, { height: 720, label: "720p" }], hls, (index) => { selected = index; });
  assert.equal(hls.currentLevel, 1);
  assert.equal(selected, 1);
  assert.equal(recoveryQualityRef.current, null);
});

function createStallMonitor(overrides = {}) {
  const calls = [];
  const v = { currentTime: 42, paused: false, ended: false, seeking: false, readyState: 2 };
  const env = {
    v,
    document: { hidden: false },
    fleetPlayedRef: { current: true },
    userPausedRef: { current: false },
    switching: false,
    recoveryInFlightRef: { current: false },
    recoveryPendingRef: { current: false },
    refreshCurrentSource: async () => { calls.push(["refreshCurrentSource"]); return true; },
    saveResumeTime: (time) => calls.push(["saveResumeTime", time]),
    resumeTargetRef: { current: null },
    setState: (state) => calls.push(["state", state]),
    setError: (error) => calls.push(["error", error]),
    PLAYBACK_STALL_MS: 20_000,
    ...overrides,
  };
  const make = new Function(...Object.keys(env), `${monitorBody}; return { checkStall, resetStall };`);
  const originalNow = Date.now;
  let monitor;
  try {
    Date.now = () => 0;
    monitor = make(...Object.values(env));
  } finally {
    Date.now = originalNow;
  }
  return { ...monitor, calls, v, env };
}

test("a 20-second empty-buffer stall retries the same source at the saved clock position", async () => {
  const monitor = createStallMonitor();
  monitor.checkStall(19_999);
  assert.deepEqual(monitor.calls, []);
  monitor.checkStall(20_000);
  await Promise.resolve();
  assert.deepEqual(monitor.calls, [["saveResumeTime", 42], ["refreshCurrentSource"]]);
});

test("pause, hidden tab, seek, and ready buffer do not trigger stall recovery", () => {
  for (const overrides of [
    { userPausedRef: { current: true } },
    { document: { hidden: true } },
    { v: { currentTime: 42, paused: false, ended: false, seeking: true, readyState: 2 } },
    { v: { currentTime: 42, paused: false, ended: false, seeking: false, readyState: 3 } },
  ]) {
    const monitor = createStallMonitor(overrides);
    monitor.checkStall(100_000);
    assert.deepEqual(monitor.calls, []);
  }
});

test("clock movement and buffer readiness restart the stall deadline", async () => {
  const monitor = createStallMonitor();
  monitor.v.currentTime = 43;
  monitor.checkStall(19_999);
  monitor.v.readyState = 2;
  monitor.checkStall(39_998);
  assert.deepEqual(monitor.calls, []);
  monitor.resetStall(40_000);
  monitor.checkStall(59_999);
  assert.deepEqual(monitor.calls, []);
  monitor.checkStall(60_000);
  await Promise.resolve();
  assert.deepEqual(monitor.calls, [["saveResumeTime", 43], ["refreshCurrentSource"]]);
});

test("incoming bytes alone do not keep a stalled media clock alive", () => {
  assert.doesNotMatch(monitorEffect, /"progress"/);
});

function createRefreshHelper(refresh) {
  const calls = [];
  const env = {
    engineRef: { current: "hls" },
    refreshFleetSourceRef: { current: refresh },
    recoveryInFlightRef: { current: false },
    sourceSelectionRef: { current: 1 },
    recoveryFailedRef: { current: false },
    forceStreamReattachRef: { current: false },
    checkpointRef: { current: { preferences: { quality: "4K" } } },
    engineQualityPreferenceRef: { current: "720p" },
    recoveryQualityRef: { current: null },
    recoveryPendingRef: { current: false },
    setRecovering: (value) => calls.push(["recovering", value]),
    setError: (value) => calls.push(["error", value]),
    setState: (value) => calls.push(["state", value]),
  };
  const make = new Function(...Object.keys(env), `return (${refreshCallback})();`);
  return { run: () => make(...Object.values(env)), calls, env };
}

test("same-source recovery captures engine quality independently of Lampac source quality", () => {
  let resolveRefresh;
  const helper = createRefreshHelper(() => new Promise((resolve) => { resolveRefresh = resolve; }));
  helper.run();
  assert.equal(helper.env.recoveryQualityRef.current, "720p");
  resolveRefresh(false);
});

test("a stall-triggered failed same-source recovery settles the player error while Lampac is switching", async () => {
  let resolveRefresh;
  const helper = createRefreshHelper(() => new Promise((resolve) => { resolveRefresh = resolve; }));
  const monitor = createStallMonitor({ refreshCurrentSource: () => helper.run() });
  monitor.checkStall(20_000);
  resolveRefresh(false);
  await Promise.resolve();
  assert.deepEqual(helper.calls, [
    ["recovering", true],
    ["error", ""],
    ["state", "loading"],
    ["state", "error"],
    ["error", "Воспроизведение остановилось. Источник не удалось восстановить."],
    ["recovering", false],
  ]);
});

test("stale refresh completion after a new source selection cannot replace its state", async () => {
  let resolveRefresh;
  const helper = createRefreshHelper(() => new Promise((resolve) => { resolveRefresh = resolve; }));
  const pending = helper.run();
  helper.env.sourceSelectionRef.current += 1;
  resolveRefresh(false);
  assert.equal(await pending, undefined);
  assert.deepEqual(helper.calls, [["recovering", true], ["error", ""], ["state", "loading"], ["recovering", false]]);
});
