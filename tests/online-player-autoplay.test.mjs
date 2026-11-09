import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/components/OnlinePlayer.jsx", import.meta.url), "utf8");
const start = source.indexOf("  useEffect(() => {", source.indexOf("// ── Skip intro/outro/recap"));
const end = source.indexOf("\n  // ── Fullscreen state", start);
assert.ok(start >= 0 && end > start, "find the production autoplay effect");
const effect = source.slice(start, end);

function autoplay({ timings = null, role = null, providerSkips = [] } = {}) {
  const video = { currentTime: 0, duration: 30, paused: false, seeking: false };
  const calls = [];
  let tick = () => {};
  const env = {
    useEffect: (callback) => callback(),
    prebuffering: false, syncRole: role, activeSkipMode: "off", providerSkips,
    skipTimings: timings, skipTimerRef: { current: null }, nextFiredRef: { current: false },
    onNextRef: { current: () => calls.push(video.currentTime) }, onNext: () => {},
    setSkipPrompt() {}, state: "ready", switching: false, watchedThreshold: 20,
    videoRef: { current: video },
    setInterval: (callback) => { tick = callback; return 1; }, clearInterval() {},
  };
  new Function(...Object.keys(env), effect)(...Object.values(env));
  return { video, calls, at(time) { video.currentTime = time; tick(); } };
}

test("confirmed outro starts the five-second next countdown at 8s, before the 10s end threshold", () => {
  const player = autoplay({ timings: { outro: { startTime: 8, endTime: 29 } } });
  player.at(7);
  assert.deepEqual(player.calls, []);
  player.at(8);
  assert.deepEqual(player.calls, [8]);
  player.at(10);
  assert.deepEqual(player.calls, [8], "the end threshold must not restart the countdown");
});

test("the end threshold is a fallback, and cannot precede a known later outro", () => {
  const player = autoplay({ timings: { outro: { startTime: 24, endTime: 29 } } });
  player.at(10);
  assert.deepEqual(player.calls, []);
  player.at(24);
  assert.deepEqual(player.calls, [24]);
  for (const timings of [null, {}, { outro: { startTime: null } }, { outro: { startTime: NaN } }]) {
    const fallback = autoplay({ timings, providerSkips: [{ startTime: 2, endTime: 8 }] });
    fallback.at(8);
    assert.deepEqual(fallback.calls, [], "unclassified skip ranges cannot start autoplay");
    fallback.at(10);
    assert.deepEqual(fallback.calls, [10]);
  }
});

test("confirmed outro never cuts off a known post-credit scene", () => {
  const player = autoplay({ timings: { outro: { startTime: 8, endTime: 29 }, postCredits: { startTime: 25, endTime: 28 } } });
  for (const time of [8, 10, 25, 27]) player.at(time);
  assert.deepEqual(player.calls, []);
  player.at(28);
  assert.deepEqual(player.calls, [28]);
});

test("outro autoplay keeps pause, seek, follower and once-per-episode guards", () => {
  const timings = { outro: { startTime: 8, endTime: 29 } };
  const player = autoplay({ timings });
  player.video.paused = true;
  player.at(8);
  assert.deepEqual(player.calls, []);
  player.video.paused = false;
  player.video.seeking = true;
  player.at(8);
  assert.deepEqual(player.calls, []);
  player.video.seeking = false;
  player.at(8);
  player.at(9);
  assert.deepEqual(player.calls, [8]);
  const follower = autoplay({ timings, role: "follower" });
  follower.at(28);
  assert.deepEqual(follower.calls, []);
});
