import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createEmbedMedia } from "../src/utils/embed-media.js";

const source = readFileSync(new URL("../src/components/OnlinePlayer.jsx", import.meta.url), "utf8");
const controlsStart = source.indexOf("  const activatePrebuffer = useCallback(");
const controlsEnd = source.indexOf("\n  useEffect(", controlsStart);
const playStart = source.indexOf("    const onPlay = () => {");
const playEnd = source.indexOf("\n    const onPause =", playStart);
assert.ok(controlsStart >= 0 && controlsEnd > controlsStart && playStart >= 0 && playEnd > playStart);

test("a prebuffered frame play promotes once, preserves the adapter, and never echoes play or pause", () => {
  const video = new EventTarget();
  const frame = new EventTarget();
  const target = new EventTarget();
  const commands = [];
  frame.contentWindow = { postMessage: (data) => commands.push(JSON.parse(data)) };
  const media = createEmbedMedia({ video, frame, url: "https://frame.test", target });
  const prebufferingRef = { current: true };
  const userPausedRef = { current: true };
  const hlsRef = { current: { config: { maxBufferLength: 6, maxMaxBufferLength: 6 } } };
  const hadPlayedRef = { current: false };
  let prebuffering = true, playing = false, starts = 0, registeredPlay;
  const env = {
    useCallback: (callback) => callback, videoRef: { current: video },
    prebufferingRef, userPausedRef, hlsRef, hadPlayedRef, engineRef: { current: "embed" },
    volumeRef: { current: 0.6 }, mutedRef: { current: false },
    setPrebuffering: (value) => { prebuffering = value; },
    setPlaying: (value) => { playing = value; },
    // TVPage reuses its ordinary episode activation and registered play callback.
    onPrebufferStarted: () => { starts++; registeredPlay(); },
  };
  const controls = new Function(...Object.keys(env), source.slice(controlsStart, controlsEnd)
    + source.slice(playStart, playEnd) + "return { onPlay, activateAndPlay };")(...Object.values(env));
  registeredPlay = controls.activateAndPlay;
  video.addEventListener("play", controls.onPlay);
  const receive = (event, time) => {
    const message = new Event("message");
    Object.assign(message, { source: frame.contentWindow, origin: "https://frame.test", data: JSON.stringify({ event, time }) });
    target.dispatchEvent(message);
  };

  assert.equal(prebuffering, true);
  assert.deepEqual(commands, []);
  receive("play", 0);
  assert.equal(prebufferingRef.current, false);
  assert.equal(prebuffering, false);
  assert.equal(playing, true);
  assert.equal(userPausedRef.current, false);
  assert.equal(hadPlayedRef.current, true);
  assert.equal(video.volume, 0.6);
  assert.equal(video.muted, false);
  assert.deepEqual(hlsRef.current.config, { maxBufferLength: 60, maxMaxBufferLength: 300 });
  receive("timeupdate", 0.25);
  receive("play", 0.25);
  assert.equal(starts, 1);
  assert.equal(video.currentTime, 0.25, "the same adapter keeps receiving the clock");
  assert.deepEqual(commands.filter(({ api }) => api === "play" || api === "pause"), []);
  registeredPlay();
  assert.deepEqual(commands.filter(({ api }) => api === "play" || api === "pause"), [], "even a ready embed cannot be restarted by prebuffer activation");
  media.destroy();
});
