import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import handler, { normalizeHabsterCard } from "../api/habster.js";

const movie = { kp_id: "328", type: "film" };
const info = { kinopoiskId: 328, imdbId: "tt0120737", type: "FILM", nameRu: "Властелин колец" };
assert.deepEqual(normalizeHabsterCard(movie, info), {
  kinopoisk_id: 328, imdb_id: "tt0120737", media_type: "movie", title: info.nameRu, catalogSource: "habster",
});
assert.equal(normalizeHabsterCard({ kp_id: 1396, type: "series" }, { ...info, kinopoiskId: 1396, type: "TV_SERIES" }).media_type, "tv");
for (const id of [true, null, "", "01", "328x", 1.5, -1, 0, Number.MAX_SAFE_INTEGER + 1]) {
  assert.equal(normalizeHabsterCard({ ...movie, kp_id: id }, { ...info, kinopoiskId: id }), null);
}
for (const bad of [{ ...info, kinopoiskId: 329 }, { ...info, imdbId: "not-an-id" },
  { ...info, type: "TV_SERIES" }, { ...info, nameRu: "" }, { ...info, nameRu: "x".repeat(301) }]) {
  assert.equal(normalizeHabsterCard(movie, bad), null);
}
const config = JSON.parse(await readFile(new URL("../vercel.json", import.meta.url)));
assert.deepEqual(config.rewrites.find((route) => ["/api/habster", "/(.*)"].includes(route.source)),
  { source: "/api/habster", destination: "/api/habster" });
function response() {
  const res = new EventEmitter();
  res.headers = {};
  res.setHeader = (key, value) => { res.headers[key.toLowerCase()] = value; };
  res.status = (value) => { res.statusCode = value; return res; };
  res.json = (value) => { res.value = value; res.writableEnded = true; return res; };
  res.end = () => { res.writableEnded = true; return res; };
  return res;
}
async function call(query = "feed=popular", method = "GET", res = response()) {
  await handler({ method, url: `/api/habster?${query}`, headers: { cookie: "private", authorization: "private" } }, res);
  return res;
}
const originalFetch = globalThis.fetch;
try {
  globalThis.fetch = () => { throw new Error("Invalid requests must not fetch"); };
  for (const query of ["", "feed=fire", "feed=popular&page=2", "feed=popular&page=01", "feed=popular&page=1&page=1",
    "feed=popular&feed=popular", "feed=popular&url=https://private.test"]) assert.equal((await call(query)).statusCode, 400);
  assert.equal((await call("feed=popular", "POST")).statusCode, 405);
  assert.equal((await call("feed=popular", "OPTIONS")).statusCode, 204);
  let active = 0;
  let maximum = 0;
  globalThis.fetch = async (url, opts) => {
    assert.equal(url.origin, "https://habster.sbs");
    assert.equal(opts.redirect, "error");
    assert.deepEqual(opts.headers, { accept: "application/json" });
    if (url.pathname === "/popular.php") return Response.json(Array.from({ length: 8 }, (_, i) => ({ ...movie, kp_id: String(i + 1) })));
    assert.equal(url.pathname, "/getinfo.php");
    assert.deepEqual([...url.searchParams.keys()], ["kp_id"]);
    maximum = Math.max(maximum, ++active);
    await new Promise((resolve) => setTimeout(resolve, 3));
    active--;
    return Response.json({ ...info, kinopoiskId: Number(url.searchParams.get("kp_id")) });
  };
  const success = await call();
  assert.equal(success.statusCode, 200);
  assert.equal(success.value.results.length, 8);
  assert.equal(success.value.unmapped, 0);
  assert.equal(maximum, 4, "metadata fanout is bounded");
  assert.match(success.headers["cache-control"], /s-maxage=300/);
  assert.equal(success.listenerCount("close"), 0);
  globalThis.fetch = async (url) => url.pathname === "/popular.php"
    ? Response.json([movie, movie, { ...movie, kp_id: true }, { ...movie, kp_id: "329" }])
    : url.searchParams.get("kp_id") === "328" ? Response.json(info) : new Response("private error", { status: 503 });
  const partial = await call();
  assert.equal(partial.statusCode, 200);
  assert.equal(partial.value.results.length, 1);
  assert.equal(partial.value.unmapped, 3);
  assert.equal(partial.headers["cache-control"], "no-store", "transient metadata failures must not be cached");
  for (const make of [() => Response.json({}), () => Response.json(Array(21).fill(movie)),
    () => new Response("private", { status: 403 }), () => new Response("not-json", { headers: { "content-type": "application/json" } }),
    () => new Response("x".repeat(1048577), { headers: { "content-type": "application/json" } }),
    () => new Response("x", { headers: { "content-type": "application/json", "content-length": "1048577" } })]) {
    globalThis.fetch = async () => make();
    const failed = await call();
    assert.equal(failed.statusCode, 502);
    assert.equal(failed.headers["cache-control"], "no-store");
    assert.equal(JSON.stringify(failed.value).includes("private"), false);
  }
  globalThis.fetch = async (url) => url.pathname === "/popular.php" ? Response.json([movie]) : new Response("", { status: 503 });
  assert.equal((await call()).statusCode, 502, "total metadata outage must not look like an empty successful catalog");
  const disconnected = response();
  globalThis.fetch = (_url, { signal }) => new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    queueMicrotask(() => { disconnected.destroyed = true; disconnected.emit("close"); });
  });
  await call("feed=popular", "GET", disconnected);
  assert.equal(disconnected.value, undefined);
  assert.equal(disconnected.listenerCount("close"), 0);
  const originalTimer = globalThis.setTimeout;
  try {
    globalThis.setTimeout = (fn) => originalTimer(fn, 10);
    globalThis.fetch = async (_url, { signal }) => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("["));
        signal.addEventListener("abort", () => controller.error(signal.reason), { once: true });
      },
    }), { headers: { "content-type": "application/json" } });
    assert.equal((await call()).statusCode, 504, "deadline includes a stalled response body");
  } finally { globalThis.setTimeout = originalTimer; }
} finally { globalThis.fetch = originalFetch; }
console.log("Habster API normalization, fixed routes, concurrency, deadlines and cancellation checks passed");
