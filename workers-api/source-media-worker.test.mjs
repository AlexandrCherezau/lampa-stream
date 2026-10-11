import assert from "node:assert/strict";
import test from "node:test";
import { handleSourceMediaRequest } from "./source-media-worker.mjs";

const env = {
  SOURCE_HOST_URL: "https://source.example.test",
  SOURCE_API_KEY: "worker-private-test-key",
};

function routeResponse(value, status = 200) {
  return Response.json(value, { status });
}

function makeRequest(path = "/v1/media?token=signed-token", init = {}) {
  return new Request(`https://media.example.workers.dev${path}`, init);
}

test("streams large direct media with Range and safe provider headers without exposing upstream URL", async () => {
  const calls = [];
  const bytes = new Uint8Array(4.8 * 1024 * 1024);
  bytes.fill(7);
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input);
    calls.push({ url, init });
    if (url.pathname === "/v1/media-route") {
      return routeResponse({
        kind: "direct",
        url: "https://cdn.example.test/video.mp4?sig=private",
        headers: { Referer: "https://provider.example/watch", Cookie: "origin-secret", Authorization: "drop-me" },
      });
    }
    return new Response(bytes, { status: 206, headers: {
      "content-type": "video/mp4",
      "content-range": "bytes 100-5033267/9000000",
      "accept-ranges": "bytes",
      "set-cookie": "must-not-leak=1",
    } });
  };
  const response = await handleSourceMediaRequest(makeRequest("/v1/media?token=opaque-signed-token", {
    headers: { range: "bytes=100-", origin: "https://app.example" },
  }), env, fetchImpl);
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("content-range"), "bytes 100-5033267/9000000");
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal((await response.arrayBuffer()).byteLength, bytes.byteLength, "response body streams without the Vercel response-size limit");
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url.origin, "https://source.example.test");
  assert.equal(calls[0].url.searchParams.get("token"), "opaque-signed-token");
  assert.equal(calls[0].init.headers.authorization, `Bearer ${env.SOURCE_API_KEY}`);
  assert.equal(calls[1].url.href, "https://cdn.example.test/video.mp4?sig=private");
  assert.equal(calls[1].init.headers.get("range"), "bytes=100-");
  assert.equal(calls[1].init.headers.get("referer"), "https://provider.example/watch");
  assert.equal(calls[1].init.headers.get("cookie"), "origin-secret");
  assert.equal(calls[1].init.headers.has("authorization"), false);
  assert.equal(response.url, "", "the upstream media URL is not exposed as the Worker response URL");
});

test("routes engine HLS through the private Node media handler and rewrites only its exact media prefix", async () => {
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input);
    calls.push({ url, init });
    if (url.pathname === "/v1/media-route") {
      return routeResponse({ kind: "engine", url: "http://127.0.0.1:9118/lite/vibix/video.m3u8", headers: {} });
    }
    return new Response([
      "#EXTM3U",
      "https://source.example.test/v1/media?token=child-signed-token",
      "https://source.example.test.evil/v1/media?token=untouched",
      "https://cdn.example.test/segment.ts",
    ].join("\n"), { headers: {
      "content-type": "application/vnd.apple.mpegurl",
      "content-length": "999",
      etag: "stale-etag",
    } });
  };
  const response = await handleSourceMediaRequest(makeRequest(), env, fetchImpl);
  assert.equal(response.status, 200);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].url.origin, "https://source.example.test");
  assert.equal(calls[1].url.pathname, "/v1/media");
  assert.equal(calls[1].url.searchParams.get("token"), "signed-token");
  assert.equal(calls[1].init.headers["x-source-relay-key"], env.SOURCE_API_KEY);
  const playlist = await response.text();
  assert.match(playlist, /https:\/\/media\.example\.workers\.dev\/v1\/media\?token=child-signed-token/);
  assert.match(playlist, /https:\/\/source\.example\.test\.evil\/v1\/media\?token=untouched/);
  assert.match(playlist, /https:\/\/cdn\.example\.test\/segment\.ts/);
  assert.equal(response.headers.get("content-length"), null, "rewritten playlist length is recalculated by the runtime");
  assert.equal(response.headers.get("etag"), null, "rewritten playlist does not retain the source ETag");
});

test("direct HLS sniffing falls back to Node rewrite and forwards the requested range", async () => {
  const calls = [];
  let cancelled = false;
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input);
    calls.push({ url, init });
    if (url.pathname === "/v1/media-route") {
      return routeResponse({ kind: "direct", url: "https://cdn.example.test/manifest", headers: {} });
    }
    if (url.origin === "https://cdn.example.test") {
      const body = new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode("#EXTM3U\n#EXTINF:2,\nsegment.ts\n")); },
        cancel() { cancelled = true; },
      });
      return new Response(body, { headers: { "content-type": "application/octet-stream" } });
    }
    return new Response("#EXTM3U\n", { headers: { "content-type": "application/vnd.apple.mpegurl" } });
  };
  const response = await handleSourceMediaRequest(makeRequest("/v1/media?token=t", { headers: { range: "bytes=0-99" } }), env, fetchImpl);
  assert.equal(cancelled, true);
  assert.equal(calls.length, 3);
  assert.equal(calls[1].init.headers.get("range"), "bytes=0-99");
  assert.equal(calls[2].url.pathname, "/v1/media");
  assert.equal(calls[2].init.headers.range, "bytes=0-99");
  assert.equal(response.headers.get("content-type"), "application/vnd.apple.mpegurl");
  assert.equal(await response.text(), "#EXTM3U\n");
});

test("direct CDN redirects fall back to Node so cookies never follow the redirect in the Worker", async () => {
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input);
    calls.push({ url, init });
    if (url.pathname === "/v1/media-route") {
      return routeResponse({ kind: "direct", url: "https://cdn.example.test/start.mp4", headers: { Cookie: "provider-secret" } });
    }
    if (url.origin === "https://cdn.example.test") {
      return new Response("", { status: 302, headers: { location: "https://redirect.example.test/final.mp4" } });
    }
    assert.equal(url.origin, "https://source.example.test", "the Worker delegates redirect resolution to the trusted Node transport");
    return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "video/mp4" } });
  };
  const response = await handleSourceMediaRequest(makeRequest(), env, fetchImpl);
  assert.equal(response.status, 200);
  assert.equal(calls.length, 3);
  assert.equal(calls[1].init.redirect, "manual");
  assert.equal(calls[1].init.headers.get("cookie"), "provider-secret");
  assert.equal(calls[2].url.pathname, "/v1/media");
  assert.equal(calls[2].init.headers["x-source-relay-key"], env.SOURCE_API_KEY);
  assert.equal(calls.some(({ url }) => url.origin === "https://redirect.example.test"), false);
  assert.deepEqual(Array.from(new Uint8Array(await response.arrayBuffer())), [1, 2, 3]);
});

test("forwards client cancellation to an in-flight CDN request", async () => {
  const controller = new AbortController();
  let observedSignal;
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input);
    if (url.pathname === "/v1/media-route") {
      return routeResponse({ kind: "direct", url: "https://cdn.example.test/slow.mp4", headers: {} });
    }
    observedSignal = init.signal;
    return new Promise((_resolve, reject) => {
      if (init.signal.aborted) reject(init.signal.reason);
      else init.signal.addEventListener("abort", () => reject(init.signal.reason || new Error("aborted")), { once: true });
    });
  };
  const pending = handleSourceMediaRequest(makeRequest("/v1/media?token=t", { signal: controller.signal }), env, fetchImpl);
  setTimeout(() => controller.abort(), 10);
  const response = await pending;
  assert(observedSignal instanceof AbortSignal);
  assert.equal(observedSignal.aborted, true);
  assert.equal(response.status, 502, "the disconnected caller will not wait on the upstream transfer");
});

test("returns an empty direct response without reusing a locked body stream", async () => {
  const fetchImpl = async (input) => {
    const url = new URL(input);
    if (url.pathname === "/v1/media-route") {
      return routeResponse({ kind: "direct", url: "https://cdn.example.test/empty.mp4", headers: {} });
    }
    return new Response(new ReadableStream({ start(controller) { controller.close(); } }), {
      status: 200,
      headers: { "content-type": "video/mp4", "cache-control": "public, max-age=60" },
    });
  };
  const response = await handleSourceMediaRequest(makeRequest(), env, fetchImpl);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "video/mp4");
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  assert.equal(await response.arrayBuffer().then((body) => body.byteLength), 0);
});

test("hides direct CDN error bodies and redirect headers", async () => {
  let cdnBodyCancelled = false;
  const fetchImpl = async (input) => {
    const url = new URL(input);
    if (url.pathname === "/v1/media-route") {
      return routeResponse({ kind: "direct", url: "https://cdn.example.test/private.mp4", headers: {} });
    }
    return new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode("private CDN diagnostic")); },
      cancel() { cdnBodyCancelled = true; },
    }), {
      status: 403,
      headers: { "content-type": "text/plain", location: "https://private.example.test/error", "x-upstream-secret": "hidden" },
    });
  };
  const response = await handleSourceMediaRequest(makeRequest(), env, fetchImpl);
  assert.equal(response.status, 403);
  assert.equal(await response.text(), "Media source unavailable");
  assert.equal(response.headers.get("location"), null);
  assert.equal(response.headers.get("x-upstream-secret"), null);
  assert.equal(cdnBodyCancelled, true);
});

for (const upstreamStatus of [403, 404]) test(`direct media ${upstreamStatus} falls back once to the authenticated Node relay`, async () => {
  const calls = [];
  let cdnBodyCancelled = false;
  const mediaBytes = new Uint8Array([0x47, 1, 2, 3, 4]);
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input);
    calls.push({ url, init });
    if (url.pathname === "/v1/media-route") {
      return routeResponse({ kind: "direct", url: "https://cdn.example.test/segment.ts?sig=private", headers: { Referer: "https://provider.example/watch" } });
    }
    if (url.origin === "https://cdn.example.test") {
      return new Response(new ReadableStream({
        start(controller) { controller.enqueue(new TextEncoder().encode("private CDN error body")); },
        cancel() { cdnBodyCancelled = true; },
      }), { status: upstreamStatus, headers: { "content-type": "text/plain", location: "https://private.example.test/error", "x-upstream-secret": "hidden" } });
    }
    assert.equal(url.origin, "https://source.example.test");
    assert.equal(url.pathname, "/v1/media");
    assert.equal(url.searchParams.get("token"), "opaque-signed-token");
    assert.equal(init.headers["x-source-relay-key"], env.SOURCE_API_KEY);
    assert.equal(init.headers.range, "bytes=0-4");
    return new Response(mediaBytes, { status: 206, headers: {
      "content-type": "video/mp2t",
      "content-range": "bytes 0-4/5000",
      "accept-ranges": "bytes",
      location: "https://private.example.test/node-location",
      "x-upstream-secret": "must-not-leak",
    } });
  };

  const response = await handleSourceMediaRequest(makeRequest("/v1/media?token=opaque-signed-token", {
    headers: { range: "bytes=0-4" },
  }), env, fetchImpl);
  assert.equal(response.status, 206);
  assert.equal(response.headers.get("content-range"), "bytes 0-4/5000");
  assert.equal(response.headers.get("content-type"), "video/mp2t");
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
  assert.equal(response.headers.get("location"), null);
  assert.equal(response.headers.get("x-upstream-secret"), null);
  assert.deepEqual(Array.from(new Uint8Array(await response.arrayBuffer())), Array.from(mediaBytes));
  assert.equal(cdnBodyCancelled, true);
  assert.equal(calls.length, 3, "exactly one authenticated Node fallback follows the direct failure");
  assert.equal(calls[0].init.headers.authorization, `Bearer ${env.SOURCE_API_KEY}`);
  assert.equal(calls[1].init.headers.has("x-source-relay-key"), false, "private relay key never goes to the CDN");
  assert.equal(calls[1].init.headers.get("referer"), "https://provider.example/watch");
});

test("direct 429 does not retry through the Node relay", async () => {
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(input);
    calls.push({ url, init });
    if (url.pathname === "/v1/media-route") return routeResponse({ kind: "direct", url: "https://cdn.example.test/rate-limited.mp4", headers: {} });
    return new Response("private rate-limit detail", { status: 429, headers: { "retry-after": "60" } });
  };
  const response = await handleSourceMediaRequest(makeRequest(), env, fetchImpl);
  assert.equal(response.status, 429);
  assert.equal(await response.text(), "Media source unavailable");
  assert.equal(response.headers.get("retry-after"), null);
  assert.equal(calls.length, 2, "non-403/404 failures are not retried through Node");
  assert.equal(calls[1].init.headers.has("x-source-relay-key"), false);
});

test("rejects invalid configuration/tokens, hides route errors, and handles CORS preflight", async () => {
  let fetchCount = 0;
  const fetchImpl = async () => { fetchCount++; return routeResponse({ error: "private diagnostic" }, 401); };
  const missingConfig = await handleSourceMediaRequest(makeRequest(), { ...env, SOURCE_HOST_URL: "http://source.example.test" }, fetchImpl);
  assert.equal(missingConfig.status, 503);
  const oversized = await handleSourceMediaRequest(makeRequest(`/v1/media?token=${"x".repeat(48 * 1024 + 1)}`), env, fetchImpl);
  assert.equal(oversized.status, 404);
  assert.equal(fetchCount, 0);
  const routeError = await handleSourceMediaRequest(makeRequest(), env, fetchImpl);
  assert.equal(routeError.status, 401);
  assert.equal(await routeError.text(), "Media source unavailable");
  const options = await handleSourceMediaRequest(makeRequest("/v1/media", { method: "OPTIONS" }), env, fetchImpl);
  assert.equal(options.status, 204);
  assert.equal(options.headers.get("access-control-allow-methods"), "GET, HEAD, OPTIONS");
  assert.equal(fetchCount, 1);
});
