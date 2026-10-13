import assert from "node:assert/strict";
import test from "node:test";
import { Readable } from "node:stream";
import { createVi3000Provider, parseVi3000Response } from "../providers/vi3000.mjs";
import { createLampacProvider } from "../providers/lampac.mjs";

const title = { type: "movie", title: "Movie", year: 2001, tmdbId: 120, catalogSource: "vi3000" };
const filmix = { method: "play", url: "https://cdn.test/movie.mp4", quality: { "720p": "https://cdn.test/movie.mp4" }, translate: "Дубляж",
  subtitles: [{ language: "ru", name: "Русский", url: "https://cdn.test/ru.vtt" }] };
const collect = async (iterator) => { const items = []; for await (const item of iterator) items.push(item); return items; };
function response(body, headers = {}) {
  const stream = Readable.from([Buffer.from(typeof body === "string" ? body : JSON.stringify(body))]);
  stream.headers = headers;
  return { response: stream };
}

test("vi HTML parser accepts only JSON data attributes and never executes scripts", () => {
  assert.deepEqual(parseVi3000Response(`<div data-json='${JSON.stringify(filmix)}'></div><script>throw Error()</script>`), filmix);
  assert.deepEqual(parseVi3000Response(JSON.stringify(filmix)), filmix);
  assert.throws(() => parseVi3000Response("<script>({url:'movie'})</script>"), /structured/);
  assert.throws(() => parseVi3000Response('<div data-json="not JSON"></div>'), /invalid/);
  assert.throws(() => parseVi3000Response("null"), /invalid/);
});

test("vi uses the anonymous Filmix TMDB contract and public registry without changing native filters", async () => {
  const requests = [];
  const transport = { async request(raw, opts) {
    const url = new URL(raw);
    requests.push(url);
    assert.equal(opts.publicOnly, true);
    assert.deepEqual(opts.headers, { accept: "application/json" });
    assert(opts.timeout <= 12_000);
    if (url.pathname === "/api/plugin/lampac/hosts") return response({ hosts: ["fleet.test", "fleet.test", "https://evil.test", "evil.test/path", "user@evil.test", "", 123] });
    if (url.pathname === "/api/filmix/lite") {
      assert.equal(url.origin, "https://api-m.vi3000.top");
      assert.equal(url.searchParams.get("id"), "120");
      assert.equal(url.searchParams.get("source"), "tmdb");
      return response(`<div data-json='${JSON.stringify(filmix)}'></div>`);
    }
    if (url.pathname === "/lite/events") return response([
      { balanser: "fmovies", name: "English", url: "https://fleet.test/lite/fmovies" },
      { balanser: "pidtor", name: "Torrent", url: "https://fleet.test/lite/pidtor" },
      { balanser: "hidden", show: false, url: "https://fleet.test/lite/hidden" },
      { balanser: "foreign", url: "https://evil.test/lite/foreign" },
    ]);
    assert.equal(url.pathname, "/lite/fmovies", "unsupported, disabled and foreign entries must not be fetched");
    return response({ type: "movie", data: [{ ...filmix, translate: "Original" }] });
  } };
  const provider = createVi3000Provider({ transport });
  const candidates = await collect(provider.discover(title));
  assert.deepEqual(candidates.map((c) => c.providerId), ["vi3000:filmix", "vi3000:fmovies"]);
  assert(candidates.every((c) => c.catalogSource === "vi3000" && c.providerName.startsWith("vi3000 · ")));
  assert.equal(Object.keys(candidates[0]).includes("ref"), false);
  const cold = createVi3000Provider({ transport });
  const resolved = await cold.resolve(candidates[0]);
  assert.equal(resolved.qualities[0].url, filmix.url);
  assert(resolved.qualities.every((q) => q.publicOnly === true));
  assert(resolved.subtitles.every((q) => q.publicOnly === true));
  assert.equal((await cold.resolve(candidates[1])).qualities[0].url, filmix.url);
  await assert.rejects(cold.resolve({ ...candidates[0], ref: candidates[0].ref, catalogSource: "other" }), /Invalid vi3000/);
  await assert.rejects(cold.resolve({ ...candidates[1], ref: { ...candidates[1].ref, origin: "http://127.0.0.1:9118" } }), /Unregistered/);
  await collect(provider.discover(title));
  assert.equal(requests.filter((url) => url.pathname === "/api/plugin/lampac/hosts").length, 2, "host registry success is cached per adapter, including cold validation");
  const native = createLampacProvider({ baseUrl: "https://fleet.test", fetchJson: async (raw) => {
    assert.equal(new URL(raw).pathname, "/lite/events");
    return [{ balanser: "fmovies", url: "https://fleet.test/lite/fmovies" }];
  } });
  assert.deepEqual(await collect(native.discover(title)), [], "native RU filtering must remain unchanged");
});

test("vi rejects oversized bodies, reports registry failure and propagates cancellation", async () => {
  const tooLarge = createVi3000Provider({ transport: { async request(raw) {
    if (new URL(raw).pathname === "/api/plugin/lampac/hosts") return response({ hosts: [] });
    return response("x".repeat(1024 * 1024 + 1));
  } } });
  const results = await collect(tooLarge.discover(title));
  assert(results.every((r) => !r.ref));
  assert.match(results.find((r) => r.providerId === "vi3000:filmix").error, /too large/);
  assert.match(results.at(-1).error, /registry/);
  const invalidRegistry = createVi3000Provider({ transport: { async request(raw) {
    return new URL(raw).pathname === "/api/plugin/lampac/hosts" ? response({ hosts: ["https://private.test", "a.test:443"] }) : response(filmix);
  } } });
  assert.match((await collect(invalidRegistry.discover(title))).at(-1).error, /registry/);
  const caller = new AbortController();
  const stalled = createVi3000Provider({ transport: { async request() {
    const stream = new Readable({ read() {} }); stream.headers = {};
    setImmediate(() => caller.abort());
    return { response: stream };
  } } });
  await assert.rejects(collect(stalled.discover(title, { signal: caller.signal })), { name: "AbortError" });
});
