import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = (await readFile(new URL("../src/utils/useSourceHost.js", import.meta.url), "utf8"))
  .replace(/^import .*;$/gm, "").replace(/export default /g, "").replace(/export /g, "");
async function run(web, item, type = "movie", coordinates = {}) {
  let cleanup;
  const started = [];
  const calls = [];
  const context = vm.createContext({ window: { __webShim: web }, AbortController,
    useState: () => [{}, () => {}], useRef: () => ({ current: null }),
    useEffect: (fn) => { cleanup = fn(); }, isAnimeContent: () => false,
    createSourceSession: () => ({ start: (value) => started.push(value), stop: () => calls.push("stop") }),
    tmdbFetch: async () => { calls.push("external"); if (web) return new Promise(() => {}); return { imdb_id: "tt0120737" }; },
    collapsFindKp: async () => { calls.push("legacy-kp"); if (web) return new Promise(() => {}); return { ok: true, kinopoiskId: 328 }; },
  });
  vm.runInContext(source, context);
  context.args = { enabled: true, apiKey: "fixture-key", item, type, ...coordinates };
  vm.runInContext("useSourceHost(args)", context);
  await new Promise((resolve) => setTimeout(resolve, 0));
  return { started, calls, cleanup };
}
const item = { id: 120, title: "Movie", original_title: "Original", release_date: "2001-12-18" };
for (const catalogSource of [undefined, "vi3000", "habster", "zona"]) {
  const app = await run(true, { ...item, catalogSource });
  assert.equal(app.started.length, 1, "web discovery starts even if browser ID lookups would hang");
  assert.deepEqual(app.calls, [], "no browser KP/TMDB lookup blocks web startup");
  assert.equal(app.started[0].tmdbId, 120);
  assert.equal(app.started[0].catalogSource, catalogSource);
  assert.equal(app.started[0].kinopoiskId, undefined, "unknown IDs are left for validated backend discovery");
  app.cleanup();
  assert.deepEqual(app.calls, ["stop"]);
}
const known = await run(true, { ...item, kinopoisk_id: 328, imdb_id: "tt0120737" });
assert.equal(known.started[0].kinopoiskId, 328);
assert.equal(known.started[0].imdbId, "tt0120737");
const tv = await run(true, { id: 1396, name: "Series", first_air_date: "2008-01-20" }, "tv", { season: 1, episode: 2 });
assert.equal(tv.started[0].season, 1);
assert.equal(tv.started[0].episode, 2);
assert.deepEqual(tv.calls, []);
const desktop = await run(false, item);
assert.deepEqual(desktop.calls, ["external", "legacy-kp"]);
assert.equal(desktop.started[0].imdbId, "tt0120737");
assert.equal(desktop.started[0].kinopoiskId, 328);
console.log("Source startup starts web discovery immediately, preserves known IDs/episodes and desktop lookup behavior");
