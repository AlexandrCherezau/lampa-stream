import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import handler, { normalizeZonaCard } from "../api/zona.js";

const movie = { id: "328", name_rus: "Властелин колец", name_original: "The Lord of the Rings", year: 2001, serial: false, adult: false };
const info = { kinopoiskId: 328, imdbId: "tt0120737", type: "FILM", nameRu: movie.name_rus, nameOriginal: movie.name_original, year: 2001 };
assert.deepEqual(normalizeZonaCard(movie, { ...info, url: "https://private.test", token: "private" }), {
  kinopoisk_id: 328, imdb_id: "tt0120737", media_type: "movie", title: movie.name_rus, catalogSource: "zona",
});
for (const id of [true, null, "", "01", "328x", "328\n", 1.5, -1, 0, Number.MAX_SAFE_INTEGER + 1]) {
  assert.equal(normalizeZonaCard({ ...movie, id }, { ...info, kinopoiskId: id }), null);
}
for (const bad of [{ ...movie, serial: true }, { ...movie, serial: "false" }, { ...movie, adult: true },
  { ...movie, year: "2001" }, { ...movie, year: 0 }, { ...movie, name_rus: null, name_original: null }]) {
  assert.equal(normalizeZonaCard(bad, info), null);
}
for (const bad of [{ ...info, kinopoiskId: 329 }, { ...info, kinopoiskId: "328" }, { ...info, imdbId: "not-an-id" },
  { ...info, imdbId: "tt0120737\n" }, { ...info, type: "TV_SERIES" }, { ...info, year: 2002 },
  { ...info, nameRu: "Другой фильм", nameOriginal: "Other", nameEn: "Other" }]) {
  assert.equal(normalizeZonaCard(movie, bad), null);
}
assert(normalizeZonaCard({ ...movie, name_rus: " ВЛАСТЕЛИН—КОЛЕЦ! " }, info), "punctuation and case must not create an unrelated title");

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
  await handler({ method, url: `/api/zona?${query}`, headers: { cookie: "private", authorization: "private" } }, res);
  return res;
}
const catalog = (docs = [movie], start = 0, numFound = docs.length) => ({ response: { docs, start, numFound } });
const originalFetch = globalThis.fetch;
try {
  globalThis.fetch = () => { throw new Error("Invalid requests must not fetch"); };
  for (const query of ["", "feed=fire", "feed=constructor", "feed=popular&page=0", "feed=popular&page=01", "feed=popular&page=1%0A",
    "feed=popular&page=-1", "feed=popular&page=1.5", "feed=popular&page=10001", "feed=popular&page=1&page=1", "feed=popular&feed=popular",
    "feed=popular&q=*:*", "feed=popular&sort=seeds", "feed=popular&url=https://private.test", "feed=popular&kinopoisk_id=328"]) {
    assert.equal((await call(query)).statusCode, 400);
  }
  assert.equal((await call("feed=popular", "POST")).statusCode, 405);
  assert.equal((await call("feed=popular", "OPTIONS")).statusCode, 204);
  let active = 0;
  let maximum = 0;
  globalThis.fetch = async (url, opts) => {
    assert.equal(opts.redirect, "error");
    assert.deepEqual(opts.headers, { accept: "application/json" });
    assert(opts.signal instanceof AbortSignal);
    if (url.origin === "https://zsolr3.zonasearch.com") {
      assert.equal(url.pathname, "/solr/movie/select/");
      assert.deepEqual(Object.fromEntries(url.searchParams), { q: "serial:false AND adult:false", sort: "popularity desc", rows: "20", start: "0", wt: "json", fl: "id,name_rus,name_original,year,serial,adult" });
      return Response.json(catalog(Array.from({ length: 8 }, (_, i) => ({ ...movie, id: String(i + 1) }))));
    }
    assert.equal(url.origin, "https://habster.sbs");
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
  assert.equal(success.value.page, 1);
  assert.equal(success.value.total_pages, 1);
  assert.equal(success.value.unmapped, 0);
  assert.equal(maximum, 4);
  assert.match(success.headers["cache-control"], /s-maxage=300/);
  assert.equal(success.listenerCount("close"), 0);
  globalThis.fetch = async (url) => url.origin.includes("zonasearch")
    ? Response.json(catalog([], Number(url.searchParams.get("start")), 1_038_660))
    : Response.json(info);
  const lastPage = await call("feed=popular&page=10000");
  assert.equal(lastPage.statusCode, 200);
  assert.equal(lastPage.value.page, 10000);
  assert.equal(lastPage.value.total_pages, 10000, "public pagination is capped");
  globalThis.fetch = async () => Response.json(catalog([], 0, 0));
  const empty = await call();
  assert.equal(empty.statusCode, 200);
  assert.equal(empty.value.total_pages, 1, "empty catalogs preserve the client pagination contract");
  assert.deepEqual(empty.value.results, []);

  globalThis.fetch = async (url) => url.origin.includes("zonasearch")
    ? Response.json(catalog([movie, movie, { ...movie, id: true }, { ...movie, id: "329" }]))
    : url.searchParams.get("kp_id") === "328" ? Response.json(info) : new Response("private error", { status: 503 });
  const partial = await call();
  assert.equal(partial.statusCode, 200);
  assert.equal(partial.value.results.length, 1);
  assert.equal(partial.value.unmapped, 3);
  assert.equal(partial.headers["cache-control"], "no-store");
  globalThis.fetch = async (url) => url.origin.includes("zonasearch") ? Response.json(catalog()) : Response.json({ ...info, year: 2002 });
  const mismatched = await call();
  assert.equal(mismatched.statusCode, 200);
  assert.equal(mismatched.value.unmapped, 1);
  assert.deepEqual(mismatched.value.results, []);
  assert.equal(mismatched.headers["cache-control"], "no-store", "unmapped metadata must not be cached as a complete page");
  for (const make of [() => Response.json({}), () => Response.json(catalog(Array(21).fill(movie))),
    () => Response.json(catalog([movie], 20)), () => Response.json(catalog([movie], 0, -1)),
    () => new Response("private", { status: 403 }), () => new Response("not-json", { headers: { "content-type": "application/json" } }),
    () => new Response("x".repeat(1048577), { headers: { "content-type": "application/json" } }),
    () => new Response("x", { headers: { "content-type": "application/json", "content-length": "1048577" } })]) {
    globalThis.fetch = async () => make();
    const failed = await call();
    assert.equal(failed.statusCode, 502);
    assert.equal(failed.headers["cache-control"], "no-store");
    assert.equal(JSON.stringify(failed.value).includes("private"), false);
  }
  globalThis.fetch = async (url) => url.origin.includes("zonasearch") ? Response.json(catalog()) : new Response("", { status: 503 });
  assert.equal((await call()).statusCode, 502, "total metadata outage must not look like an empty catalog");

  const disconnected = response();
  let bodyCancelled = false;
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode("{"));
      setTimeout(() => { disconnected.destroyed = true; disconnected.emit("close"); }, 5);
    },
    cancel() { bodyCancelled = true; },
  }), { headers: { "content-type": "application/json" } });
  await call("feed=popular", "GET", disconnected);
  assert.equal(disconnected.value, undefined);
  assert.equal(bodyCancelled, true, "caller cancellation must cancel a stalled body even without upstream cooperation");
  assert.equal(disconnected.listenerCount("close"), 0);
  const originalTimer = globalThis.setTimeout;
  try {
    globalThis.setTimeout = (fn) => originalTimer(fn, 10);
    let cancelled = false;
    globalThis.fetch = async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode("{")); },
      cancel() { cancelled = true; },
    }), { headers: { "content-type": "application/json" } });
    const timedOut = await call();
    assert.equal(timedOut.statusCode, 504, "deadline includes a stalled body");
    assert.equal(timedOut.value.error, "ZONA_TIMEOUT");
    assert.equal(cancelled, true);
  } finally { globalThis.setTimeout = originalTimer; }
} finally { globalThis.fetch = originalFetch; }
console.log("Zona API exact-title normalization, fixed public query, pagination, bounds, partial failures, deadlines and cancellation checks passed");
