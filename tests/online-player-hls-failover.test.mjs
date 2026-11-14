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
const refreshCallbackEnd = source.indexOf("\n  }, [fleetFailover]);", refreshCallbackStart);
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
  const updater = new Function("previous", "ls", "forceReattach", "progressKey", streamUpdaterBody);
  const previous = { hls: "https://cdn.test/video.m3u8", viaRelay: false };
  const next = updater(previous, { hls: previous.hls, viaRelay: false }, false);
  assert.equal(next, previous);
});

test("same-URL manual retry after HLS teardown creates a fresh stream instance", () => {
  const updater = new Function("previous", "ls", "forceReattach", "progressKey", streamUpdaterBody);
  const previous = { hls: "https://cdn.test/video.m3u8", viaRelay: false };
  const manualRetryResolved = true;
  const forceReattach = manualRetryResolved;
  const next = updater(previous, { hls: previous.hls, viaRelay: false }, forceReattach);
  assert.notEqual(next, previous);
  assert.equal(next.hls, previous.hls);
});

test("same-URL automatic recovery forces a fresh media-engine attachment", () => {
  const updater = new Function("previous", "ls", "forceReattach", "progressKey", streamUpdaterBody);
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
  const attachPause = new Function("recoveryPendingRef", "userPausedRef", "syncStateRef = { current: null }", pauseAttachBody);
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
    syncRole: null,
    syncTrackerRef: { current: { lastSeekAt: 0 } },
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

test("a seek that never lands counts as a stall", () => {
  const monitor = createStallMonitor({ v: { currentTime: 42, paused: false, ended: false, seeking: true, readyState: 1 } });
  monitor.checkStall(20_000);
  assert.deepEqual(monitor.calls.at(-1), ["refreshCurrentSource"]);
});

test("pause, hidden tab, and ready buffer do not trigger stall recovery", () => {
  for (const overrides of [
    { userPausedRef: { current: true } },
    { document: { hidden: true } },
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

function createRefreshHelper(refresh, sourceLeft = false) {
  const calls = [];
  const env = {
    fleetFailover: () => { calls.push(["failover"]); return sourceLeft; },
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
    ["failover"],
    ["state", "error"],
    ["error", "Воспроизведение остановилось. Источник не удалось восстановить."],
    ["recovering", false],
  ]);
});

test("a failed same-source recovery moves to another source when one is left", async () => {
  const helper = createRefreshHelper(async () => false, true);
  assert.equal(await helper.run(), true);
  assert.equal(helper.env.recoveryFailedRef.current, false);
  assert.ok(!helper.calls.some(([name, value]) => name === "state" && value === "error"));
  assert.deepEqual(helper.calls.slice(-2), [["failover"], ["recovering", false]]);
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

test("in a room, the room's own seeks do not hide a stalled stream from the watchdog", () => {
  const syncTrackerRef = { current: { lastSeekAt: 0 } };
  const monitor = createStallMonitor({ syncRole: "host", syncTrackerRef });
  // Every 10 s the sync jumps forward over a stream that has stopped delivering.
  for (let at = 10_000; at <= 20_000; at += 10_000) {
    monitor.v.currentTime += 10;
    syncTrackerRef.current.lastSeekAt = at;
    monitor.v.seeking = true;
    monitor.checkStall(at);
  }
  assert.deepEqual(monitor.calls.at(-1), ["refreshCurrentSource"]);
});

test("in a room, a paused room holds a fresh attachment paused and a playing one does not", () => {
  const attach = (playing) => {
    const userPausedRef = { current: !playing };
    new Function("recoveryPendingRef", "userPausedRef", "syncStateRef", pauseAttachBody)(
      { current: false }, userPausedRef, { current: { playing } },
    );
    return userPausedRef.current;
  };
  assert.equal(attach(false), true);
  assert.equal(attach(true), false);
});

test("fatal errors are counted per trouble spot, not per film", () => {
  const hlsAttach = source.slice(source.indexOf("const attachHls = async () => {"), source.indexOf(marker));
  assert.match(hlsAttach, /hls\.on\(Hls\.Events\.FRAG_CHANGED, \(\) => \{ errCountRef\.current = 0; \}\)/);
});

test("a same-source refresh is not announced as a source switch", () => {
  assert.match(source, /\{switching && !\(state === "loading" && hasMedia\) && \(/);
});


test("a new episode with the same media URL still attaches a fresh stream", () => {
  const updater = new Function("previous", "ls", "forceReattach", "progressKey", streamUpdaterBody);
  for (const kind of ["hls", "mp4", "embed"]) {
    const previous = { [kind]: "https://cdn.test/shared", progressKey: "tv_1_s1e1" };
    const next = updater(previous, { [kind]: previous[kind] }, false, "tv_1_s1e2");
    assert.notEqual(next, previous);
    assert.equal(next.progressKey, "tv_1_s1e2");
    assert.equal(updater(next, { [kind]: previous[kind] }, false, "tv_1_s1e2"), next);
  }
});

test("native waiting events cannot set an embed's loading state", () => {
  const start = source.indexOf("const onWaiting = ");
  const end = source.indexOf(";\n", start);
  const callback = source.slice(start + "const onWaiting = ".length, end);
  const values = [];
  const engineRef = { current: "embed" };
  const onWaiting = new Function("engineRef", "setWaiting", `return (${callback})`)(engineRef, (v) => values.push(v));
  onWaiting();
  assert.deepEqual(values, []);
  engineRef.current = "hls";
  onWaiting();
  assert.deepEqual(values, [true]);
});

test("native attachment listeners cannot fire against the next stream", () => {
  const start = source.indexOf("const attachNative = (src) => {");
  const end = source.indexOf("\n    const attachEmbed", start);
  const attachEvents = new AbortController();
  const calls = [];
  const v = new EventTarget();
  const env = {
    v, attachEvents, disposed: false, engineRef: { current: null },
    setRecovering: () => calls.push("recovering"), rateRef: { current: 1 },
    reapplyVolume: () => calls.push("volume"), resumeAt: () => calls.push("resume"),
    prebufferingRef: { current: true }, isLampac: false, hadPlayedRef: { current: false },
    setState: () => calls.push("state"), setError: () => calls.push("error"),
  };
  const attach = new Function(...Object.keys(env), source.slice(start, end) + "return attachNative;")(...Object.values(env));
  attach("old.mp4");
  attachEvents.abort();
  v.dispatchEvent(new Event("loadedmetadata"));
  v.dispatchEvent(new Event("error"));
  assert.deepEqual(calls, []);
});

function reflectFleet({ ready = true, previousStream, nextStream }) {
  const marker = '// ── Reflect the Lampac fleet';
  const start = source.indexOf('  useEffect(() => {', source.indexOf(marker));
  const end = source.indexOf('\n  // Fleet inline notice', start);
  const calls = [];
  let stream = { hls: 'old.m3u8', progressKey: 'tv_1_s1e1' };
  const env = {
    useEffect: (effect) => effect(), isLampac: true, profileReady: ready, progressKey: 'tv_1_s1e2',
    lampac: { stream: nextStream }, previousEpisodeStreamRef: { current: previousStream },
    recoveryFailedRef: { current: false }, fleetPlayedRef: { current: false },
    loadingEnteredAtRef: { current: 0 }, loadingExitRef: { current: null },
    forceStreamReattachRef: { current: false }, MIN_DISPLAY_MS: 0,
    setStream: (update) => { stream = update(stream); calls.push(['stream', stream]); },
    setState: (v) => calls.push(['state', v]), setError() {}, setSubtitles() {}, setAudioNames() {}, setMeta() {},
  };
  new Function(...Object.keys(env), source.slice(start, end))(...Object.values(env));
  return { calls, stream };
}

test("episode profile refresh cannot reattach the previous hook snapshot", () => {
  const old = { hls: 'old.m3u8' };
  assert.deepEqual(reflectFleet({ ready: false, previousStream: old, nextStream: old }).calls, []);
  assert.deepEqual(reflectFleet({ previousStream: old, nextStream: old }).calls, []);
  const { stream } = reflectFleet({ previousStream: old, nextStream: { ...old } });
  assert.equal(stream.progressKey, 'tv_1_s1e2');
});

test("new episode preferences do not copy the previous video clock into its resume", () => {
  const start = source.indexOf('  useEffect(() => {', source.indexOf('// Fleet inline notice'));
  const effectStart = source.indexOf('  useEffect(() => {', start + 1);
  const end = source.indexOf('\n  // ── Switching watchdog', effectStart);
  const calls = [];
  const env = {
    useEffect: (effect) => effect(), prebuffering: false, isLampac: true, profileReady: true,
    lampac: { stream: { hls: 'new.m3u8' }, sourcePreference: { providerId: 'habster:collaps' } },
    previousEpisodeStreamRef: { current: { hls: 'old.m3u8' } },
    attachedKeyRef: { current: 'tv_1_s1e1' }, progressKey: 'tv_1_s1e2',
    videoRef: { current: { currentTime: 600 } }, resumeTargetRef: { current: null }, checkpointRef: { current: null },
    storage: { get: () => ({ tv_1_s1e2: 12 }) }, STORAGE_KEYS: { RESUME_TIME: 'resume' },
    persistCheckpoint: (position) => calls.push(position),
  };
  new Function(...Object.keys(env), source.slice(effectStart, end))(...Object.values(env));
  assert.deepEqual(calls, [12]);
});

test("returning A to B to A waits for this selection's profile refresh", () => {
  const start = source.indexOf("  const checkpointRef = ");
  const end = source.indexOf("  const checkpointItem = ", start);
  const declaration = source.slice(start, end);
  const complete = /setProfileReady\w+\((\w+)\);/.exec(source)?.[0];
  assert.ok(complete, "find the production profile-ready transition");
  let readyKey = null, memo, memoKey;
  const render = (progressKey) => new Function("useRef", "useState", "useMemo", "checkpoint", "progressKey",
    declaration + `return { ready: profileReady, complete: () => { ${complete} } };`)(
      (value) => ({ current: value }), () => [readyKey, (value) => { readyKey = value; }],
      (factory, [key]) => { if (memoKey !== key) { memo = factory(); memoKey = key; } return memo; }, null, progressKey,
    );
  const first = render("A");
  first.complete();
  assert.equal(render("A").ready, true);
  assert.equal(render("B").ready, false);
  assert.equal(render("A").ready, false);
});

test("old viewing intervals keep their own episode metadata during switch cleanup", () => {
  const start = source.indexOf("  const commitViewingSession = useCallback(");
  const end = source.indexOf("\n  // Count only wall-clock intervals", start);
  const recorded = [];
  const oldItem = { id: "1", type: "tv", season: 1, episode: 1 };
  const checkpointItemRef = { current: oldItem };
  const viewingSessionRef = { current: null };
  const env = {
    useCallback: (callback) => callback, useEffect: (effect) => effect(),
    progressKey: "tv_1_s1e1", checkpointItemRef, viewingSessionRef,
    prebuffering: false, newPlaybackSessionId: () => "session",
    recordViewingSession: (value) => { recorded.push(value); },
  };
  const commit = new Function(...Object.keys(env), source.slice(start, end) + "return commitViewingSession;")(...Object.values(env));
  viewingSessionRef.current.segments.push({ start: 1000, end: 5000 });
  checkpointItemRef.current = { ...oldItem, episode: 2 };
  commit();
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].item.episode, 1);
  assert.equal(recorded[0].progressKey, "tv_1_s1e1");
});
