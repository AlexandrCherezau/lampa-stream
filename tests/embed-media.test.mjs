import test from "node:test";
import assert from "node:assert/strict";
import { createEmbedMedia } from "../src/utils/embed-media.js";

const URL_ = "https://player.example/?kp=1&token=t";
const ORIGIN = "https://player.example";

function fixture() {
  const sent = [];
  const contentWindow = { postMessage: (data, origin) => sent.push({ data: JSON.parse(data), raw: data, origin }) };
  const video = new EventTarget();
  const target = new EventTarget();
  const events = [];
  for (const type of ["loadedmetadata", "canplay", "timeupdate", "play", "playing", "pause", "seeking", "seeked", "durationchange", "ended"]) {
    video.addEventListener(type, () => events.push(type));
  }
  let readyCalls = 0;
  const frame = new EventTarget();
  frame.contentWindow = contentWindow;
  const media = createEmbedMedia({ video, frame, url: URL_, target, onReady: () => { readyCalls += 1; } });
  const receive = (data, { source = contentWindow, origin = ORIGIN } = {}) => {
    const event = new Event("message");
    Object.assign(event, { data: typeof data === "string" ? data : JSON.stringify(data), source, origin });
    target.dispatchEvent(event);
  };
  return { sent, video, frame, events, media, receive, ready: () => readyCalls };
}

test("controls reach the frame as JSON strings addressed to its origin only", async () => {
  const f = fixture();
  f.receive({ event: "timeupdate", time: 1 });
  f.sent.length = 0;
  await f.video.play();
  f.video.pause();
  f.video.currentTime = 600;
  assert.deepEqual(f.sent.map((value) => value.raw), ['{"api":"play"}', '{"api":"pause"}', '{"api":"seek","value":600}']);
  assert.ok(f.sent.every((value) => value.origin === ORIGIN));
  assert.equal(f.video.currentTime, 600);
  assert.equal(f.video.seeking, true);
});

test("pre-ready controls cannot interrupt the frame's first click with a pause", async () => {
  const f = fixture();
  await f.video.play();
  f.video.pause();
  f.frame.dispatchEvent(new Event("load"));
  f.receive({ event: "play", time: 0 });
  f.video.pause();
  assert.deepEqual(f.sent, [], "neither loading nor the first play allows a control echo");
  f.receive({ event: "timeupdate", time: 0.25 });
  f.video.pause();
  assert.deepEqual(f.sent.at(-1).data, { api: "pause" }, "ordinary pause still works after startup");
});

test("the frame's messages become media events and element state", () => {
  const f = fixture();
  assert.equal(f.video.readyState, 0);
  assert.equal(f.video.paused, true);
  f.receive({ event: "play", time: 0 });
  assert.equal(f.video.paused, false);
  f.receive({ event: "timeupdate", time: 1.5 });
  assert.equal(f.video.currentTime, 1.5);
  assert.equal(f.video.readyState, 4);
  f.receive({ event: "duration", time: 7200 });
  assert.equal(f.video.duration, 7200);
  f.receive({ event: "seek", time: 600 });
  assert.equal(f.video.currentTime, 600);
  assert.equal(f.video.seeking, false);
  f.receive({ event: "pause", time: 600 });
  assert.equal(f.video.paused, true);
  assert.deepEqual(f.events, ["play", "playing", "timeupdate", "durationchange", "loadedmetadata", "canplay", "seeked", "timeupdate", "pause"]);
});

test("the player counts as started only once its clock moves, and only once", () => {
  const f = fixture();
  f.receive({ event: "timeupdate", time: 0 });
  assert.equal(f.ready(), 0);
  f.receive({ event: "timeupdate", time: 0.3 });
  f.receive({ event: "timeupdate", time: 0.6 });
  assert.equal(f.ready(), 1);
  assert.equal(f.sent.filter((value) => value.data.api === "duration").length >= 1, true);
});

test("metadata waits for the duration, because a resume seek needs it", () => {
  const f = fixture();
  let durationAtMetadata;
  f.video.addEventListener("loadedmetadata", () => { durationAtMetadata = f.video.duration; });
  f.receive({ event: "timeupdate", time: 0.3 });
  assert.equal(durationAtMetadata, undefined);
  f.receive({ event: "duration", time: 7200 });
  f.receive({ event: "duration", time: 7200 });
  assert.equal(durationAtMetadata, 7200);
  assert.equal(f.events.filter((type) => type === "loadedmetadata").length, 1);
});

test("a seek holds the clock until answered, and a missing answer cannot leave it stuck", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture();
  f.receive({ event: "timeupdate", time: 10 });
  f.video.currentTime = 600;
  f.receive({ event: "timeupdate", time: 10.25 });
  assert.equal(f.video.currentTime, 600, "a stale tick must not snap the seek bar back");
  assert.equal(f.video.seeking, true);
  t.mock.timers.tick(5000);
  assert.equal(f.video.seeking, false);
  assert.equal(f.events.filter((type) => type === "seeked").length, 1);
  f.receive({ event: "timeupdate", time: 601 });
  assert.equal(f.video.currentTime, 601);
  f.video.currentTime = 900;
  f.media.destroy();
  t.mock.timers.tick(5000);
  assert.equal(f.events.filter((type) => type === "seeked").length, 1, "no event after teardown");
});

test("a loaded frame counts as alive even though the player stays silent until clicked", () => {
  const f = fixture();
  assert.equal(f.media.responded, false);
  f.frame.dispatchEvent(new Event("load"));
  assert.equal(f.media.responded, true);
});

test("nothing starts the player before the viewer's own click, which would start it muted", async () => {
  const f = fixture();
  const plays = () => f.sent.filter((value) => value.data.api === "play").length;
  await f.video.play();
  f.frame.dispatchEvent(new Event("load"));
  f.receive({ event: "pause", time: 0 });
  assert.equal(plays(), 0);
  f.receive({ event: "play", time: 0 });
  f.receive({ event: "timeupdate", time: 0.3 });
  await f.video.play();
  assert.equal(plays(), 1, "once it runs, our button works");
});

test("a loaded frame counts as alive even though the player stays silent until clicked", () => {
  const f = fixture();
  assert.equal(f.media.responded, false);
  f.frame.dispatchEvent(new Event("load"));
  assert.equal(f.media.responded, true);
});

test("nothing starts the player before the viewer's own click, which would start it muted", async () => {
  const f = fixture();
  const plays = () => f.sent.filter((value) => value.data.api === "play").length;
  await f.video.play();
  f.frame.dispatchEvent(new Event("load"));
  f.receive({ event: "pause", time: 0 });
  assert.equal(plays(), 0);
  f.receive({ event: "play", time: 0 });
  f.receive({ event: "timeupdate", time: 0.3 });
  await f.video.play();
  assert.equal(plays(), 1, "once it runs, our button works");
});

test("messages from another window, another origin or with bad data are ignored", () => {
  const f = fixture();
  f.receive({ event: "timeupdate", time: 50 }, { source: {} });
  f.receive({ event: "timeupdate", time: 50 }, { origin: "https://evil.example" });
  f.receive("{not json");
  f.receive({ event: "timeupdate", time: "soon" });
  assert.equal(f.video.currentTime, 0);
  assert.deepEqual(f.events, []);
});

test("destroy restores the element and stops listening", () => {
  const f = fixture();
  f.media.destroy();
  assert.equal(Object.hasOwn(f.video, "currentTime"), false);
  assert.equal(Object.hasOwn(f.video, "play"), false);
  f.receive({ event: "play", time: 0 });
  assert.deepEqual(f.events, []);
});
