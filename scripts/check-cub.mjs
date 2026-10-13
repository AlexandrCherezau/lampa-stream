import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import handler, { normalizeCubFeed } from "../api/cub.js";
import { cubFeed } from "../src/utils/cub-client.js";

const fixture = {
  page: 1, total_pages: 2, total_results: 40,
  results: [
    { id: 120, title: "The Lord of the Rings", release_date: "2001-12-18", poster_path: "/poster.jpg", kinopoisk_id: 328, imdb_id: "tt0120737" },
    { id: "1396", name: "Breaking Bad", first_air_date: "2008-01-20" },
    ...[0, -1, 1.2, Number.MAX_SAFE_INTEGER + 1, "120x", "01", "120\n", true, null].map((id) => ({ id, title: "Invalid" })),
    { id: 1, title: "Ambiguous", name: "Ambiguous" },
    { id: 2, name: "Person", media_type: "person" },
    null,
  ],
};
const normalized = normalizeCubFeed(fixture, 1);
assert.deepEqual(normalized.results.map(({ id, media_type }) => [id, media_type]), [[120, "movie"], [1396, "tv"]]);
assert.equal(normalized.results[0].kinopoisk_id, 328);
assert.equal(normalized.results[0].imdb_id, "tt0120737");
assert.equal(normalized.results[0].poster_path, "/poster.jpg");
assert.equal(normalized.results[0].catalogSource, "vi3000");
assert.equal(normalized.total_results, 40);
assert.throws(() => normalizeCubFeed({ ...fixture, page: 2 }, 1));
assert.throws(() => normalizeCubFeed({ ...fixture, total_pages: -1 }, 1));

function response() {
  const res = new EventEmitter();
  res.headers = {};
  res.setHeader = (key, value) => { res.headers[key.toLowerCase()] = value; };
  res.status = (value) => { res.statusCode = value; return res; };
  res.json = (value) => { res.value = value; res.writableEnded = true; return res; };
  res.end = () => { res.writableEnded = true; return res; };
  return res;
}
async function call(query, method = "GET", res = response()) {
  await handler({ method, url: `/api/cub?${query}`, headers: { authorization: "private", cookie: "private" } }, res);
  return res;
}
const originalFetch = globalThis.fetch;
try {
  globalThis.fetch = async () => { throw new Error("Invalid input must not fetch"); };
  for (const query of ["", "feed=unknown", "feed=constructor", "feed=fire&page=0", "feed=fire&page=10001", "feed=fire&page=-1",
    "feed=fire&page=1.5", "feed=fire&page=01", "feed=fire&page=1%0A", "feed=fire&page=1&page=2", "feed=fire&feed=latest", "feed=fire&url=https://private.test"]) {
    assert.equal((await call(query)).statusCode, 400);
  }
  globalThis.fetch = async (url) => Response.json({ ...fixture, page: Number(url.searchParams.get("page")), total_pages: 10_000 });
  assert.equal((await call("feed=latest&page=10000")).statusCode, 200);
  assert.equal((await call("feed=fire", "POST")).statusCode, 405);
  assert.equal((await call("feed=fire", "OPTIONS")).statusCode, 204);
  const routes = { now_playing: "/?sort=now_playing&page=1", latest: "/?sort=latest&page=1", fire: "/top/fire/movie?page=1", hundred: "/top/hundred/movie?page=1" };
  for (const [feed, path] of Object.entries(routes)) {
    globalThis.fetch = async (url, opts) => {
      assert.equal(url.href, `https://tmdb.cub.best${path}`);
      assert.deepEqual(opts.headers, { accept: "application/json" });
      assert.equal(opts.redirect, "error");
      return Response.json(fixture);
    };
    const res = await call(`feed=${feed}`);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.value, normalized);
    assert.match(res.headers["cache-control"], /s-maxage=300/);
    assert.equal(res.listenerCount("close"), 0);
  }
  for (const upstream of [new Response("private upstream error", { status: 403 }), new Response("not-json", { headers: { "content-type": "application/json" } }),
    Response.json({}), new Response("oversized", { headers: { "content-type": "application/json", "content-length": "1048577" } }),
    new Response("x".repeat(1048577), { headers: { "content-type": "application/json" } })]) {
    globalThis.fetch = async () => upstream;
    const res = await call("feed=fire");
    assert.equal(res.statusCode, 502);
    assert.equal(res.value.error, "CUB_UNAVAILABLE");
    assert.equal(res.headers["cache-control"], "no-store");
    assert.equal(JSON.stringify(res.value).includes("private upstream"), false);
  }
  const res = response();
  globalThis.fetch = (_url, { signal }) => new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    queueMicrotask(() => { res.destroyed = true; res.emit("close"); });
  });
  await call("feed=fire", "GET", res);
  assert.equal(res.value, undefined, "disconnected callers must not receive a response");
  assert.equal(res.listenerCount("close"), 0);

  const originalTimer = globalThis.setTimeout;
  try {
    globalThis.setTimeout = (fn) => originalTimer(fn, 10);
    globalThis.fetch = async (_url, { signal }) => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"page":1'));
        signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
      },
    }), { headers: { "content-type": "application/json" } });
    const timedOut = await call("feed=fire");
    assert.equal(timedOut.statusCode, 504, "the API deadline must include a stalled body");
    assert.equal(timedOut.value.error, "CUB_TIMEOUT");
  } finally { globalThis.setTimeout = originalTimer; }

  let calls = 0;
  globalThis.fetch = async (url, opts) => {
    calls++;
    const params = new URL(url, "http://local.test").searchParams;
    assert.equal(opts.headers.accept, "application/json");
    return Response.json({ ...normalized, page: Number(params.get("page")) });
  };
  assert.deepEqual(await cubFeed("latest", 1), normalized);
  await cubFeed("latest", 1);
  assert.equal(calls, 1, "a successful feed/page is cached");
  await cubFeed("latest", 2);
  await cubFeed("fire", 1);
  assert.equal(calls, 3, "cache keys must include both feed and page");
  const originalNow = Date.now;
  try {
    Date.now = () => originalNow() + 5 * 60 * 1000;
    await cubFeed("latest", 1);
    assert.equal(calls, 4, "expired catalog pages must refresh");
  } finally { Date.now = originalNow; }
  for (const [feed, page] of [["unknown", 1], ["fire", 0], ["fire", 10001], ["fire", "1"], ["fire", 1.5]]) {
    await assert.rejects(cubFeed(feed, page), TypeError);
  }
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(cubFeed("latest", 1, { signal: cancelled.signal }), { name: "AbortError" });
  globalThis.fetch = (_url, { signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
  const caller = new AbortController();
  const pending = cubFeed("fire", 2, { signal: caller.signal });
  caller.abort();
  await assert.rejects(pending, { name: "AbortError" });
  globalThis.fetch = async () => Response.json({ message: "Каталог недоступен" }, { status: 502 });
  await assert.rejects(cubFeed("fire", 2), /Каталог недоступен/);
  globalThis.fetch = async () => Response.json({ ...normalized, page: 2, results: [{ id: 0, media_type: "movie" }] });
  await assert.rejects(cubFeed("fire", 2), /неверный ответ/);
  globalThis.fetch = async () => new Response("not JSON");
  await assert.rejects(cubFeed("fire", 2), /неверный ответ/);
  globalThis.fetch = async () => { throw new Error("private network error"); };
  await assert.rejects(cubFeed("fire", 2), /Каталог CUB временно недоступен/);
} finally {
  globalThis.fetch = originalFetch;
}
const clientSource = (await readFile(new URL("../src/utils/cub-client.js", import.meta.url), "utf8")).replace(/export /g, "");
const context = vm.createContext({ URLSearchParams, setTimeout, clearTimeout, console,
  AbortSignal: { timeout: () => AbortSignal.timeout(10), any: (signals) => AbortSignal.any(signals) },
  fetch: (_url, { signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })),
});
vm.runInContext(clientSource, context);
context.caller = new AbortController();
const timedClient = await Promise.race([
  vm.runInContext('cubFeed("fire", 1, { signal: caller.signal })', context).then(() => "resolved", () => "timed-out"),
  new Promise((resolve) => setTimeout(() => resolve("hung"), 100)),
]);
context.caller.abort();
assert.equal(timedClient, "timed-out", "caller cancellation must not remove the client's timeout");
console.log("CUB API/client validation, normalization, bounds, cache and cancellation checks passed");
