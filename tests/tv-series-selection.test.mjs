import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/pages/TVPage.jsx", import.meta.url), "utf8");
const selector = source.indexOf('className={`season-btn');
const callback = /onClick=\{\(\) => \{([\s\S]*?)\n\s*\}\}/.exec(source.slice(selector));
assert.ok(selector >= 0 && callback, "find the production season-selection callback");

test("selecting a season clears playback and its pending autoplay before rendering a null episode", () => {
  const state = { playing: true, selectedEp: { episode_number: 2 }, selectedSeason: 1 };
  const calls = [];
  const requestedEpisodeRef = { current: 2 };
  const requestedEpisodeResolvedRef = { current: false };
  const scope = {
    resetAutoplayRef: { current: () => calls.push("cancel-autoplay") },
    requestedEpisodeRef,
    requestedEpisodeResolvedRef,
    setPlaying: (value) => { calls.push("playing"); state.playing = value; },
    setSelectedEp: (value) => { calls.push("episode"); state.selectedEp = value; },
    setSelectedSeason: (value) => { state.selectedSeason = value; },
    onRouteChange: (...route) => calls.push(route),
    s: { season_number: 2 },
  };
  new Function(...Object.keys(scope), callback[1])(...Object.values(scope));
  assert.deepEqual(state, { playing: false, selectedEp: null, selectedSeason: 2 });
  assert.doesNotThrow(() => state.playing && state.selectedEp.episode_number);
  assert.equal(calls[0], "cancel-autoplay");
  assert.deepEqual(calls.at(-1), [2, undefined]);
  assert.equal(requestedEpisodeRef.current, undefined);
  assert.equal(requestedEpisodeResolvedRef.current, true);
});
