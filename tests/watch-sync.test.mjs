import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

// watchParty.js reads import.meta.env (Vite) and imports the app's api module, so
// only its sync section is loaded here: that part is pure.
const source = readFileSync(new URL("../src/utils/watchParty.js", import.meta.url), "utf8");
const syncSection = source.slice(source.indexOf("// ── Sync ─"));
const { createSyncTracker, expectedPosition, syncVideo } = await import(
  `data:text/javascript;base64,${Buffer.from(syncSection).toString("base64")}`
);

function fakeVideo(overrides = {}) {
  return {
    duration: 7200, currentTime: 100, paused: false, seeking: false, ended: false, playbackRate: 1, plays: 0, pauses: 0,
    play() { this.paused = false; this.plays += 1; return Promise.resolve(); },
    pause() { this.paused = true; this.pauses += 1; },
    ...overrides,
  };
}
const SERVER_NOW = 1_000_000;
const playing = (position, extra = {}) => ({ playing: true, position, rate: 1, updatedAt: SERVER_NOW, ...extra });

test("expected position runs on the room's clock and honours speed", () => {
  assert.equal(expectedPosition({ playing: false, position: 42, updatedAt: 0 }, SERVER_NOW), 42);
  assert.equal(expectedPosition({ playing: true, position: 10, rate: 1, updatedAt: SERVER_NOW - 5000 }, SERVER_NOW), 15);
  assert.equal(expectedPosition({ playing: true, position: 10, rate: 2, updatedAt: SERVER_NOW - 5000 }, SERVER_NOW), 20);
  // A patch that outran the clock estimate never rewinds.
  assert.equal(expectedPosition({ playing: true, position: 10, rate: 1, updatedAt: SERVER_NOW + 900 }, SERVER_NOW), 10);
});

test("a small gap is closed by speed, without a seek", () => {
  const video = fakeVideo({ currentTime: 99 });
  const tracker = createSyncTracker();
  syncVideo(video, playing(100), SERVER_NOW, tracker, 50_000);
  assert.equal(video.currentTime, 99);
  assert.equal(video.playbackRate, 1.08);
  assert.equal(tracker.steering, true);

  video.currentTime = 101;
  syncVideo(video, playing(100), SERVER_NOW, tracker, 50_100);
  assert.equal(video.playbackRate, 0.92);

  video.currentTime = 100.05;
  syncVideo(video, playing(100), SERVER_NOW, tracker, 50_200);
  assert.equal(video.playbackRate, 1);
  assert.equal(tracker.steering, false);
});

test("a large gap seeks once and respects the cooldown", () => {
  const video = fakeVideo({ currentTime: 50 });
  const tracker = createSyncTracker();
  syncVideo(video, playing(100), SERVER_NOW, tracker, 50_000);
  assert.equal(video.currentTime, 100);

  video.currentTime = 60;
  syncVideo(video, playing(100), SERVER_NOW, tracker, 51_000);
  assert.equal(video.currentTime, 60);
  syncVideo(video, playing(100), SERVER_NOW, tracker, 53_100);
  assert.equal(video.currentTime, 100);
});

test("a viewer who keeps falling behind stops seeking and catches up by speed", () => {
  const video = fakeVideo({ currentTime: 90 });
  const tracker = createSyncTracker();
  syncVideo(video, playing(100), SERVER_NOW, tracker, 50_000);
  video.currentTime = 94;
  syncVideo(video, playing(100), SERVER_NOW, tracker, 54_000);
  assert.equal(tracker.seeks.length, 2);

  video.currentTime = 94;
  syncVideo(video, playing(100), SERVER_NOW, tracker, 58_000);
  assert.equal(video.currentTime, 94);
  assert.equal(video.playbackRate, 1.08);

  // A gap too large to steer away still seeks.
  video.currentTime = 80;
  syncVideo(video, playing(100), SERVER_NOW, tracker, 62_000);
  assert.equal(video.currentTime, 100);

  // The struggle is forgotten after a while.
  video.currentTime = 94;
  syncVideo(video, playing(100), SERVER_NOW, tracker, 120_000);
  assert.equal(video.currentTime, 100);
});

test("play and pause follow the room; a paused room holds the exact frame", () => {
  const video = fakeVideo({ paused: true, currentTime: 100 });
  syncVideo(video, playing(100), SERVER_NOW, createSyncTracker(), 50_000);
  assert.equal(video.plays, 1);

  const tracker = createSyncTracker();
  const playingVideo = fakeVideo({ currentTime: 99.5, playbackRate: 1.08 });
  syncVideo(playingVideo, { playing: false, position: 120, rate: 1, updatedAt: 0 }, SERVER_NOW, tracker, 50_000);
  assert.equal(playingVideo.pauses, 1);
  assert.equal(playingVideo.currentTime, 120);
  assert.equal(playingVideo.playbackRate, 1);
});

test("nothing is touched before metadata or during a seek", () => {
  const noMeta = fakeVideo({ duration: NaN, paused: true, currentTime: 0 });
  syncVideo(noMeta, playing(100), SERVER_NOW, createSyncTracker(), 50_000);
  assert.deepEqual([noMeta.plays, noMeta.currentTime], [0, 0]);

  const seeking = fakeVideo({ seeking: true, currentTime: 10 });
  syncVideo(seeking, playing(100), SERVER_NOW, createSyncTracker(), 50_000);
  assert.equal(seeking.currentTime, 10);
});

test("a finished video stays finished, and a rewind brings it back", () => {
  const video = fakeVideo({ duration: 100, currentTime: 100, ended: true, paused: true });
  syncVideo(video, playing(100, { updatedAt: SERVER_NOW - 5000 }), SERVER_NOW, createSyncTracker(), 50_000);
  assert.deepEqual([video.plays, video.currentTime], [0, 100]);

  syncVideo(video, playing(40), SERVER_NOW, createSyncTracker(), 50_000);
  assert.equal(video.plays, 1);
  assert.equal(video.currentTime, 40);
});

test("the room's speed is the base for steering", () => {
  const video = fakeVideo({ currentTime: 100, playbackRate: 1 });
  syncVideo(video, playing(100, { rate: 1.5 }), SERVER_NOW, createSyncTracker(), 50_000);
  assert.equal(video.playbackRate, 1.5);
  video.currentTime = 99;
  syncVideo(video, playing(100, { rate: 1.5 }), SERVER_NOW, createSyncTracker(), 50_100);
  assert.equal(video.playbackRate, 1.62);
});
