import test from "node:test";
import assert from "node:assert/strict";
import { crossedPlaybackPosition, crossedWatchedThreshold, hasGenuinePlaybackForEnd, shouldApplyResumePosition } from "../src/utils/playbackCompletion.js";

test("completion threshold requires a natural decoded-clock crossing", () => {
  assert.equal(crossedWatchedThreshold(69.2, 70.1, 90, 20, 1000), true);
  assert.equal(crossedWatchedThreshold(3, 70.1, 90, 20, 1000), false, "a seek jump cannot earn completion");
  assert.equal(crossedWatchedThreshold(70, 70.1, 90, 20, 1000), false, "resuming inside the threshold does not complete immediately");
  assert.equal(crossedWatchedThreshold(69.2, 70.1, 90, 20, 3000), false, "a suspended or buffered gap is not playback");
  assert.equal(crossedWatchedThreshold(69.2, 75, 90, 20, 1000), false, "implausible media-clock jumps are rejected");
  assert.equal(crossedPlaybackPosition(20, 21, 20.5, 1000), true, "a naturally reached outro boundary is valid");
  assert.equal(crossedPlaybackPosition(2, 21, 20.5, 1000), false, "jumping into an outro cannot earn completion");
  assert.equal(hasGenuinePlaybackForEnd(2.1, 90), true, "a resumed stream can complete on its genuine native end");
  assert.equal(hasGenuinePlaybackForEnd(0, 90), false, "an initial seek or ended event without decoded playback cannot complete");
  assert.equal(hasGenuinePlaybackForEnd(0.5, 90), false, "a tiny playback blip is not a completed viewing session");
});

test("an explicit cross-device checkpoint resumes at the saved point even inside the legacy completion range", () => {
  assert.equal(shouldApplyResumePosition({ position: 95, progressPercent: 96, duration: 100, hasExplicitCheckpoint: true }), true);
  assert.equal(shouldApplyResumePosition({ position: 99, progressPercent: 99, duration: 100, hasExplicitCheckpoint: true }), true);
  assert.equal(shouldApplyResumePosition({ position: 99, progressPercent: 99, duration: 100 }), false, "legacy near-complete entries still offer start over");
  assert.equal(shouldApplyResumePosition({ position: 96, progressPercent: 96 }), false);
  assert.equal(shouldApplyResumePosition({ position: 0, progressPercent: 0, hasExplicitCheckpoint: true }), false);
});
