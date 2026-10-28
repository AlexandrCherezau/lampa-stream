import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/components/OnlinePlayer.jsx", import.meta.url), "utf8");
const marker = "hls.on(Hls.Events.ERROR, (_e, data) => {";
const start = source.indexOf(marker);
const end = source.indexOf("\n      });\n    };", start);
assert.ok(start >= 0 && end > start, "find the production HLS error callback");
const callbackBody = source.slice(start + marker.length, end);
const names = ["Hls", "data", "hls", "errCountRef", "isLampac", "fleetPlayedRef", "fleetHasPlayedRef", "fleetFailover", "setState", "setError", "hlsRef", "resumeTargetRef", "videoRef", "saveResumeTime"];

function createCallback({ played = false } = {}) {
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
    setState: (value) => calls.push(["state", value]),
    setError: (value) => calls.push(["error", value]),
    saveResumeTime: (value) => calls.push(["saveResumeTime", value]),
    ...refs,
  };
  const invoke = new Function(...names, callbackBody);
  return {
    calls,
    fire(type) { invoke(...names.map((name) => name === "data" ? { fatal: true, type, details: "test" } : env[name])); },
  };
}

test("fatal startup network error can fail over before decoded playback", () => {
  const run = createCallback();
  run.fire("networkError");
  assert.deepEqual(run.calls.map(([name]) => name), ["destroy", "pauseSaveResume", "failover"]);
});

test("established stream retries transient fatal network errors on the same source", () => {
  const run = createCallback({ played: true });
  run.fire("networkError");
  assert.deepEqual(run.calls, [["startLoad"]]);
});

test("exhausted established stream reports an error without changing source and saves its position before teardown", () => {
  const run = createCallback({ played: true });
  for (let attempt = 0; attempt < 5; attempt++) run.fire("networkError");
  assert.equal(run.calls.filter(([name]) => name === "startLoad").length, 4);
  assert.equal(run.calls.some(([name]) => name === "failover"), false);
  assert.deepEqual(run.calls, [["startLoad"], ["startLoad"], ["startLoad"], ["startLoad"], ["saveResumeTime", 135], ["destroy"], ["pauseSaveResume", 135], ["state", "error"], ["error", "Поток прерван (CDN нестабилен). test"]]);
});

test("late media decode error still invokes bounded in-place recovery", () => {
  const run = createCallback({ played: true });
  run.fire("mediaError");
  assert.deepEqual(run.calls, [["recoverMediaError"]]);
});
