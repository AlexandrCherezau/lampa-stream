import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = (await readFile(new URL("../src/utils/habster-client.js", import.meta.url), "utf8"))
  .replace(/^import[^\n]+\n/, "").replace(/export /g, "");
const entries = Array.from({ length: 8 }, (_, index) => ({ kinopoisk_id: 1001 + index, imdb_id: `tt000100${index}`, media_type: "movie" }));
let payload = { page: 1, total_pages: 1, results: entries };
let fetches = 0;
let mappings = 0;
let active = 0;
let peak = 0;
let now = Date.now();
const seenKeys = [];
const context = vm.createContext({
  Date: class extends Date { static now() { return now; } },
  AbortSignal, setTimeout,
  fetch: async (url, options) => {
    fetches++;
    assert.equal(url, "/api/habster?feed=popular&page=1");
    assert.equal(options.headers.accept, "application/json");
    return Response.json(payload);
  },
  tmdbFetch: async (path, apiKey, { signal }) => {
    mappings++;
    seenKeys.push(apiKey);
    assert.match(path, /^\/find\/tt\d+\?external_source=imdb_id$/);
    peak = Math.max(peak, ++active);
    await new Promise((resolve) => setTimeout(resolve, 3));
    active--;
    signal.throwIfAborted();
    return { movie_results: [{ id: 550 + Number(path.match(/tt000100(\d)/)[1]), title: "Фильм" }] };
  },
});
vm.runInContext(source, context);
const load = vm.runInContext("habsterFeed", context);
const first = await load("popular", 1, { apiKey: "visitor-a" });
assert.equal(first.results.length, 8);
assert.equal(first.results[0].id, 550);
assert.equal(first.results[0].kinopoisk_id, 1001);
assert.equal(first.results[0].imdb_id, "tt0001000");
assert.equal(first.results[0].catalogSource, "habster");
assert.equal(peak, 4, "IMDb mapping must have at most four concurrent requests");
await load("popular", 1, { apiKey: "visitor-a" });
assert.equal(fetches, 1);
assert.equal(mappings, 8);
await load("popular", 1, { apiKey: "visitor-b" });
assert.equal(fetches, 2, "visitor switches must not reuse another token's catalog cache");
assert.deepEqual(seenKeys.slice(8), Array(8).fill("visitor-b"));
await load("popular", 1, { apiKey: "visitor-a" });
assert.equal(fetches, 2);
now += 5 * 60 * 1000;
await load("popular", 1, { apiKey: "visitor-a" });
assert.equal(fetches, 3, "five-minute cache entries must expire");
for (let index = 0; index < 5; index++) await load("popular", 1, { apiKey: `evict-${index}` });
assert.equal(vm.runInContext("cache.size", context), 4);
const beforeEvicted = fetches;
await load("popular", 1, { apiKey: "evict-0" });
assert.equal(fetches, beforeEvicted + 1, "the oldest visitor cache must be evicted");

payload = { ...payload, unmapped: 1 };
const beforePartial = fetches;
await load("popular", 1, { apiKey: "partial" });
await load("popular", 1, { apiKey: "partial" });
assert.equal(fetches, beforePartial + 2, "partially enriched upstream feeds must not be cached");
payload = { ...payload, unmapped: 0 };
context.tmdbFetch = async () => { throw new Error("Temporary TMDB failure"); };
const beforeFailure = fetches;
await assert.rejects(load("popular", 1, { apiKey: "failed" }), /Не удалось/);
await assert.rejects(load("popular", 1, { apiKey: "failed" }), /Не удалось/);
assert.equal(fetches, beforeFailure + 2);

const cancelled = new AbortController();
cancelled.abort();
await assert.rejects(load("popular", 1, { apiKey: "evict-0", signal: cancelled.signal }), { name: "AbortError" });
const waitForAbort = (signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
context.fetch = async (_url, { signal }) => waitForAbort(signal);
const caller = new AbortController();
const pending = load("popular", 1, { apiKey: "cancel-fetch", signal: caller.signal });
caller.abort();
await assert.rejects(pending, { name: "AbortError" });

const timeouts = [];
context.AbortSignal = { timeout: (milliseconds) => { timeouts.push(milliseconds); return AbortSignal.timeout(10); }, any: (signals) => AbortSignal.any(signals) };
async function assertDeadline(apiKey) {
  const caller = new AbortController();
  const result = await Promise.race([
    load("popular", 1, { apiKey, signal: caller.signal }).then(() => "resolved", (error) => error.name),
    new Promise((resolve) => setTimeout(() => resolve("hung"), 100)),
  ]);
  caller.abort();
  assert.equal(result, "TimeoutError");
}
await assertDeadline("fetch-deadline");
context.fetch = async () => Response.json(payload);
context.tmdbFetch = async (_path, _apiKey, { signal }) => waitForAbort(signal);
await assertDeadline("mapping-deadline");
context.tmdbFetch = async () => new Promise(() => {});
await assertDeadline("queued-mapping-deadline");
assert.deepEqual(timeouts, [30_000, 30_000, 30_000], "the whole feed and mapping must retain the 30-second budget with a caller signal");
console.log("Habster client identity, cache scope/bounds/TTL, partial retry, four-way mapping, cancellation and deadline checks passed");
