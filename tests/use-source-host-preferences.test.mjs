import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("episode restarts use the latest preference while checkpoint writes leave discovery running", async (t) => {
  let source = await readFile(new URL("../src/utils/useSourceHost.js", import.meta.url), "utf8");
  source = source.replace(/import \{ ([^}]+) \} from "[^"]+";/g, (_line, names) =>
    `const { ${names} } = globalThis.__preferenceHookStubs;`);
  const refs = [];
  let cursor = 0;
  let callback;
  let dependencies;
  let previousDependencies;
  let cleanup;
  const starts = [];
  const stubs = {
    useRef: (current) => refs[cursor++] ||= { current },
    useState: (value) => [value, () => {}],
    useEffect: (effect, deps) => { callback = effect; dependencies = deps; },
    tmdbFetch: async () => null,
    isAnimeContent: () => false,
    collapsFindKp: async () => null,
    createSourceSession: () => ({ start: (title, preference) => starts.push({ title, preference }), stop() {} }),
  };
  const previousWindow = globalThis.window;
  globalThis.__preferenceHookStubs = stubs;
  globalThis.window = { __webShim: true };
  t.after(() => {
    delete globalThis.__preferenceHookStubs;
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  });
  const { default: useSourceHost } = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  const render = async (episode, preference) => {
    cursor = 0;
    useSourceHost({ enabled: true, item: { id: 43, name: "Series" }, type: "tv", season: 1, episode, sourcePreference: preference });
    if (!previousDependencies || dependencies.some((value, index) => !Object.is(value, previousDependencies[index]))) {
      cleanup?.();
      cleanup = callback();
      previousDependencies = dependencies;
    }
    await new Promise((resolve) => setImmediate(resolve));
  };
  t.after(() => cleanup?.());
  await render(1, { providerId: "first" });
  await render(1, { providerId: "picked", voiceId: "dub", quality: "2160p" });
  assert.equal(starts.length, 1);
  await render(2, { providerId: "picked", voiceId: "dub", quality: "2160p" });
  assert.equal(starts.length, 2);
  assert.equal(starts[1].title.episode, 2);
  assert.deepEqual(starts[1].preference, { providerId: "picked", voiceId: "dub", quality: "2160p" });
});
