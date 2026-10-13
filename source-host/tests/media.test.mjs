import assert from "node:assert/strict";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import http from "node:http";
import { once } from "node:events";
import { Readable } from "node:stream";
import test from "node:test";
import { createMedia } from "../media.mjs";
import { createTransport } from "../transport.mjs";

const SECRET = "media-test-secret-that-is-not-production";
const ENGINE_KEY = "00112233445566778899aabbccddeeff";

function lampacProxyLink(url, headers = {}, suffix = ".m3u8") {
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-128-cbc", Buffer.from(ENGINE_KEY, "hex"), iv);
  const encrypted = Buffer.concat([iv, cipher.update(JSON.stringify({ u: url, hb: 987654321, hc: Object.keys(headers).length, h: headers })), cipher.final()]);
  return `/proxy/${encrypted.toString("base64url")}${suffix}`;
}

function fakeResponse(body = "ok", statusCode = 200, headers = {}) {
  const response = Readable.from([Buffer.from(body)]);
  response.statusCode = statusCode;
  response.headers = headers;
  return response;
}

function sealedToken(payload) {
  const key = createHash("sha256").update(SECRET).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(payload)), cipher.final()]);
  return `v1.${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${encrypted.toString("base64url")}`;
}

async function startServer() {
  const seenRanges = [];
  let slowClosed = false;
  let authorizationForwarded = false;
  let handleMedia = null;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://local.test");
    if (url.pathname === "/v1/media" && handleMedia) {
      handleMedia(req, res, url.searchParams.get("token"));
    } else if (url.pathname === "/lite/json" || url.pathname === "/lite/split") {
      res.setHeader("content-type", "application/json");
      res.write('{"ok":');
      setTimeout(() => res.end("true}"), 5);
    } else if (url.pathname === "/lite/redirect") {
      res.writeHead(302, { location: "/lite/json" }).end();
    } else if (url.pathname === "/lite/denied") {
      res.writeHead(403).end("forbidden");
    } else if (url.pathname === "/lite/slow") {
      // Deliberately leave headers pending to exercise the request deadline.
    } else if (url.pathname === "/proxy/master.m3u8") {
      authorizationForwarded ||= Boolean(req.headers.authorization);
      res.setHeader("content-type", "application/vnd.apple.mpegurl");
      res.end("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100000,RESOLUTION=160x90\nquality.m3u8\n");
    } else if (url.pathname === "/proxy/quality.m3u8") {
      res.setHeader("content-type", "application/vnd.apple.mpegurl");
      res.end(`#EXTM3U\n#${"x".repeat(8 * 1024 * 1024 + 10)}\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:2,\nsegment.ts\n#EXT-X-ENDLIST\n`);
    } else if (url.pathname === "/proxy/ranged.m3u8") {
      res.setHeader("content-type", "application/vnd.apple.mpegurl");
      res.end('#EXTM3U\n#EXT-X-MAP:URI="init-range.bin",BYTERANGE="8@4"\n#EXT-X-BYTERANGE:6@20\nsegment-range.ts\n');
    } else if (url.pathname === "/proxy/sniff-split") {
      res.setHeader("content-type", "text/plain");
      res.flushHeaders();
      res.write("#EX");
      setTimeout(() => { res.write("TM3U\n#EXTINF:2,\n"); setTimeout(() => res.end("segment.ts\n"), 5); }, 15);
    } else if (url.pathname === "/proxy/sniff-octet") {
      res.setHeader("content-type", "application/octet-stream");
      res.end("#EXTM3U\n#EXTINF:2,\nsegment.ts\n");
    } else if (url.pathname === "/proxy/hls-html.m3u8") {
      res.setHeader("content-type", "text/html; charset=UTF-8");
      res.end("#EXTM3U\n#EXTINF:2,\nsegment.ts\n");
    } else if (url.pathname === "/proxy/range-ignored.m3u8") {
      seenRanges.push(`${url.pathname} ${req.headers.range}`);
      res.writeHead(200, { "content-type": "application/vnd.apple.mpegurl", "content-length": Buffer.byteLength("#EXTM3U\n#EXTINF:2,\nrange-ignored-segment.ts\n") });
      res.end("#EXTM3U\n#EXTINF:2,\nrange-ignored-segment.ts\n");
    } else if (url.pathname === "/proxy/range-ignored-segment.ts") {
      seenRanges.push(`${url.pathname} ${req.headers.range}`);
      const bytes = Buffer.alloc(188, 0x47);
      res.writeHead(200, { "content-type": "video/mp2t", "content-length": bytes.length });
      res.end(bytes);
    } else if (["/proxy/init-range.bin", "/proxy/segment-range.ts"].includes(url.pathname)) {
      seenRanges.push(`${url.pathname} ${req.headers.range}`);
      const range = /bytes=(\d+)-(\d+)/.exec(req.headers.range || "");
      res.writeHead(206, { "content-type": "video/mp2t", "content-range": `bytes ${range[1]}-${range[2]}/1000`, "content-length": "16" }).end(Buffer.alloc(16, 4));
    } else if (/^\/proxy\/file-[0-9a-f]{2}\.bin$/i.test(url.pathname)) {
      const first = Number.parseInt(url.pathname.slice("/proxy/file-".length, -4), 16);
      res.setHeader("content-type", "application/octet-stream");
      res.end(Buffer.from([first, 0, 0, 0, 0x66, 0x74, 0x79, 0x70, 0, 0, 0, 0]));
    } else if (["/proxy/key.bin", "/proxy/init.mp4", "/proxy/segment.ts"].includes(url.pathname)) {
      if (url.pathname === "/proxy/key.bin") res.end(Buffer.alloc(16, 9));
      else res.end(Buffer.alloc(128, 7));
    } else if (url.pathname === "/proxy/range.bin") {
      seenRanges.push(req.headers.range);
      const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || "");
      if (range) {
        res.writeHead(206, {
          "content-type": "video/mp2t",
          "content-range": `bytes ${range[1]}-${range[2]}/200000000`,
          "content-length": "16",
        });
      }
      res.end(Buffer.alloc(16, 4));
    } else if (url.pathname === "/proxy/html") {
      res.writeHead(200, { "content-type": "text/html" }).end("<html>upstream login</html>");
    } else if (url.pathname === "/proxy/json.bin") {
      res.writeHead(200, { "content-type": "application/octet-stream" }).end('{"error":"provider login required"}');
    } else if (url.pathname === "/proxy/denied") {
      res.writeHead(403).end("forbidden");
    } else if (url.pathname === "/proxy/empty") {
      res.writeHead(200, { "content-type": "video/mp2t" }).end();
    } else if (url.pathname === "/proxy/slow-media") {
      res.writeHead(200, { "content-type": "video/mp2t" });
      res.write(Buffer.from("chunk"));
      req.on("close", () => { slowClosed = true; });
    } else if (url.pathname.startsWith("/proxy/")) {
      res.end("local-proxy-fallback");
    } else {
      res.writeHead(404).end("not found");
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    server, base, seenRanges,
    slowClosed: () => slowClosed,
    authorizationForwarded: () => authorizationForwarded,
    attachMedia: (handler) => { handleMedia = handler; },
  };
}

async function closeServer(server) {
  server.closeAllConnections();
  server.close();
  await once(server, "close");
}

async function httpGet(rawUrl, { headers = {}, method = "GET" } = {}) {
  const response = await fetch(rawUrl, { headers, method });
  return { response, body: Buffer.from(await response.arrayBuffer()) };
}

test("transport validates private destinations, redirects, status, split bodies and deadlines", async (t) => {
  const fixture = await startServer();
  t.after(() => closeServer(fixture.server));
  const transport = createTransport({ engineUrl: `${fixture.base}/` });
  assert.deepEqual(await transport.json(`${fixture.base}/lite/split`), { ok: true });
  assert.deepEqual(await transport.json(`${fixture.base}/lite/redirect`), { ok: true });
  await assert.rejects(transport.json(`${fixture.base}/lite/denied`), (error) => error.status === 403 && !error.message.includes(fixture.base));
  await assert.rejects(transport.json(`${fixture.base}/lite/slow`, { timeout: 30 }), { code: "UPSTREAM_TIMEOUT", status: 504 });

  const otherOrigin = createTransport({ engineUrl: "https://public.example/" });
  await assert.rejects(otherOrigin.request(`${fixture.base}/lite/json`), { code: "SSRF_BLOCKED" });
  await assert.rejects(otherOrigin.request("http://[::ffff:7f00:1]/lite/json"), { code: "SSRF_BLOCKED" });
  await assert.rejects(otherOrigin.request("http://[::ffff:127.0.0.1]/lite/json"), { code: "SSRF_BLOCKED" });
});

test("transport retries one opted-in direct GET 404 at the same final URL only", async (t) => {
  const fixture = await startServer();
  t.after(() => closeServer(fixture.server));
  const calls = [];
  let segmentAttempts = 0;
  const transport = createTransport({
    engineUrl: `${fixture.base}/`,
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    requestOnceImpl: async (url, options) => {
      calls.push({ url: url.href, method: options.method, headers: { ...options.headers } });
      if (url.pathname === "/start") return fakeResponse("", 302, { location: "https://cdn.example.test/media.ts" });
      if (url.pathname === "/media.ts" && ++segmentAttempts === 1) return fakeResponse("missing", 404);
      return fakeResponse("segment-bytes", 200, { "content-type": "video/mp2t" });
    },
  });
  const result = await transport.request("https://redirect.example.test/start", {
    method: "GET",
    headers: { range: "bytes=0-99", referer: "https://provider.example/watch", cookie: "source=session" },
    retryNotFound: true,
  });
  assert.deepEqual(calls.map(({ url }) => url), [
    "https://redirect.example.test/start",
    "https://cdn.example.test/media.ts",
    "https://cdn.example.test/media.ts",
  ], "retry repeats the same final public resource without restarting or consuming another redirect");
  assert.equal(calls[1].method, "GET");
  assert.equal(calls[2].method, "GET");
  assert.deepEqual(calls[1].headers, { range: "bytes=0-99", referer: "https://provider.example/watch" });
  assert.deepEqual(calls[2].headers, calls[1].headers, "Range and safe headers are identical on retry");
  assert.equal(Buffer.concat(await Array.fromAsync(result.response)).toString(), "segment-bytes");

  for (const [url, expectedCalls] of [
    [`${fixture.base}/lite/denied`, 1],
    ["https://cdn.example.test/denied", 1],
  ]) {
    let attempts = 0;
    const noRetry = createTransport({
      engineUrl: `${fixture.base}/`,
      lookup: async () => [{ address: "93.184.216.34", family: 4 }],
      requestOnceImpl: async () => { attempts++; return fakeResponse("denied", url.startsWith("https:") ? 503 : 404); },
    });
    await assert.rejects(noRetry.request(url, { retryNotFound: true }), { code: "UPSTREAM_HTTP_ERROR" });
    assert.equal(attempts, expectedCalls, "engine 404 and direct 503 are not retried");
  }

  let defaultOffCalls = 0;
  const defaultOff = createTransport({
    engineUrl: `${fixture.base}/`,
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    requestOnceImpl: async () => { defaultOffCalls++; return fakeResponse("missing", 404); },
  });
  await assert.rejects(defaultOff.json("https://cdn.example.test/provider.json"), { status: 404 });
  assert.equal(defaultOffCalls, 1, "JSON/provider requests do not opt into retry");

  let postCalls = 0;
  const post = createTransport({
    engineUrl: `${fixture.base}/`,
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    requestOnceImpl: async () => { postCalls++; return fakeResponse("missing", 404); },
  });
  await assert.rejects(post.request("https://cdn.example.test/post", { method: "POST", retryNotFound: true }), { status: 404 });
  assert.equal(postCalls, 1, "non-GET/HEAD methods are never retried");

  let headCalls = 0;
  const head = createTransport({
    engineUrl: `${fixture.base}/`,
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    requestOnceImpl: async () => fakeResponse("", ++headCalls === 1 ? 404 : 200),
  });
  const headResult = await head.request("https://cdn.example.test/head.ts", { method: "HEAD", retryNotFound: true });
  headResult.response.resume();
  assert.equal(headCalls, 2, "HEAD requests share the one-retry policy");

  let repeated404Calls = 0;
  const repeated404 = createTransport({
    engineUrl: `${fixture.base}/`,
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    requestOnceImpl: async () => { repeated404Calls++; return fakeResponse("missing", 404); },
  });
  await assert.rejects(repeated404.request("https://cdn.example.test/missing.ts", { retryNotFound: true }), { status: 404 });
  assert.equal(repeated404Calls, 2, "a second 404 is surfaced without a further attempt");

  const aborted = new AbortController();
  let abortedCalls = 0;
  const abortAfter404 = createTransport({
    engineUrl: `${fixture.base}/`,
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    requestOnceImpl: async () => { abortedCalls++; aborted.abort(); return fakeResponse("missing", 404); },
  });
  await assert.rejects(abortAfter404.request("https://cdn.example.test/aborted.ts", { signal: aborted.signal, retryNotFound: true }), { name: "AbortError" });
  assert.equal(abortedCalls, 1, "an abort after the first 404 prevents retry");

  let deadlineCalls = 0;
  const slow404 = createTransport({
    engineUrl: `${fixture.base}/`,
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    requestOnceImpl: async (_url, options) => {
      deadlineCalls++;
      await new Promise((resolve) => setTimeout(resolve, options.timeout + 5));
      return fakeResponse("missing", 404);
    },
  });
  await assert.rejects(slow404.request("https://cdn.example.test/slow.ts", { timeout: 20, retryNotFound: true }), { code: "UPSTREAM_TIMEOUT", status: 504 });
  assert.equal(deadlineCalls, 1, "the retry cannot extend the original request deadline");
});

test("media opts probe and playback into bounded direct-404 retry before responding", async (t) => {
  const fixture = await startServer();
  t.after(() => closeServer(fixture.server));
  const counts = new Map();
  const transport = createTransport({
    engineUrl: `${fixture.base}/`,
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    requestOnceImpl: async (url) => {
      const count = (counts.get(url.pathname) || 0) + 1;
      counts.set(url.pathname, count);
      if (["/probe/master.m3u8", "/probe/segment.ts", "/playback.m3u8", "/playback-segment.ts"].includes(url.pathname) && count === 1) {
        return fakeResponse("missing", 404);
      }
      if (url.pathname === "/probe/master.m3u8") return fakeResponse("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100000\nquality.m3u8\n", 200, { "content-type": "application/vnd.apple.mpegurl" });
      if (url.pathname === "/probe/quality.m3u8") return fakeResponse("#EXTM3U\n#EXTINF:2,\nsegment.ts\n#EXT-X-ENDLIST\n", 200, { "content-type": "application/vnd.apple.mpegurl" });
      if (url.pathname === "/probe/segment.ts" || url.pathname === "/playback-segment.ts") return fakeResponse(Buffer.alloc(188, 0x47), 200, { "content-type": "video/mp2t" });
      if (url.pathname === "/playback.m3u8") return fakeResponse("#EXTM3U\n#EXTINF:2,\nplayback-segment.ts\n#EXT-X-ENDLIST\n", 200, { "content-type": "application/vnd.apple.mpegurl" });
      return fakeResponse("missing", 404);
    },
  });
  const media = createMedia({ transport, secret: SECRET, publicOrigin: fixture.base });
  fixture.attachMedia(media.handle);
  const probe = await media.probe({ url: "https://cdn.example.test/probe/master.m3u8" });
  assert.equal(probe.ok, true);
  assert.deepEqual(Object.fromEntries(counts), {
    "/probe/master.m3u8": 2,
    "/probe/quality.m3u8": 1,
    "/probe/segment.ts": 2,
  });

  const root = await httpGet(media.url({ url: "https://cdn.example.test/playback.m3u8" }));
  assert.equal(root.response.status, 200, "playback sends no error response before the retry succeeds");
  const childUrl = root.body.toString("utf8").split("\n").find((line) => line.includes("/v1/media?token="));
  assert(childUrl);
  const child = await httpGet(childUrl);
  assert.equal(child.response.status, 200);
  assert.equal(child.body.length, 188);
  assert.equal(counts.get("/playback.m3u8"), 2);
  assert.equal(counts.get("/playback-segment.ts"), 2);
});

test("transport unwraps exact-engine AES proxy links and filters provider headers", async (t) => {
  const fixture = await startServer();
  t.after(() => closeServer(fixture.server));
  let captured;
  const transport = createTransport({
    engineUrl: `${fixture.base}/`,
    engineKey: ENGINE_KEY,
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    requestOnceImpl: async (url, options) => { captured = { url, options }; return fakeResponse("direct-media"); },
  });
  const link = lampacProxyLink("https://cdn.example.test/video.m3u8?access=private", {
    Referer: "https://provider.example/watch",
    Origin: "https://provider.example",
    Cookie: "session=provider-cookie",
    "User-Agent": "Lampac player",
    Authorization: "must-not-forward",
    "X-Private-Header": "must-not-forward",
  });
  const { response, url } = await transport.request(`${fixture.base}${link}`, {
    headers: { range: "bytes=0-99", "accept-encoding": "identity", authorization: "viewer-secret" },
  });
  assert.equal(url.href, "https://cdn.example.test/video.m3u8?access=private");
  assert.equal(captured.url.href, url.href);
  assert.deepEqual(captured.options.headers, {
    referer: "https://provider.example/watch",
    origin: "https://provider.example",
    cookie: "session=provider-cookie",
    "user-agent": "Lampac player",
    range: "bytes=0-99",
    "accept-encoding": "identity",
  });
  assert.equal(Buffer.concat(await Array.fromAsync(response)).toString(), "direct-media");

  const redirects = [];
  const redirecting = createTransport({
    engineUrl: `${fixture.base}/`,
    engineKey: ENGINE_KEY,
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    requestOnceImpl: async (target, options) => {
      redirects.push({ origin: target.origin, headers: { ...options.headers } });
      return target.hostname === "origin.example.test"
        ? fakeResponse("", 302, { location: "https://cdn-two.example.test/final.m3u8" })
        : fakeResponse("redirected");
    },
  });
  const redirected = await redirecting.request(`${fixture.base}${lampacProxyLink("https://origin.example.test/redirect.m3u8", { Cookie: "one-origin-only", Referer: "https://provider.example/watch" })}`);
  assert.deepEqual(redirects.map((value) => value.origin), ["https://origin.example.test", "https://cdn-two.example.test"]);
  assert.equal(redirects[0].headers.cookie, "one-origin-only");
  assert.equal(redirects[1].headers.cookie, undefined);
  assert.equal(redirected.headers.cookie, undefined);
  assert.equal(redirected.headerOrigin, "https://cdn-two.example.test");
});

test("transport unwraps an AES proxy link returned by the engine as a redirect", async (t) => {
  const fixture = await startServer();
  t.after(() => closeServer(fixture.server));
  const calls = [];
  const transport = createTransport({
    engineUrl: `${fixture.base}/`,
    engineKey: ENGINE_KEY,
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    requestOnceImpl: async (url, options) => {
      calls.push({ url, headers: { ...options.headers } });
      if (url.origin === fixture.base) {
        return fakeResponse("", 302, {
          location: `${fixture.base}${lampacProxyLink("https://cdn.example.test/zetdb/master.m3u8", {
            Referer: "https://provider.example/watch",
            Cookie: "session=provider-token",
            "User-Agent": "Lampac player",
          })}`,
        });
      }
      return fakeResponse("#EXTM3U\n", 200, { "content-type": "application/vnd.apple.mpegurl" });
    },
  });
  const result = await transport.request(`${fixture.base}/lite/videodb/manifest.m3u8?link=encrypted`, {
    headers: { range: "bytes=0-99", "accept-encoding": "identity" },
  });
  assert.deepEqual(calls.map(({ url }) => url.origin), [fixture.base, "https://cdn.example.test"]);
  assert.equal(calls[1].url.pathname, "/zetdb/master.m3u8");
  assert.equal(calls[1].headers.referer, "https://provider.example/watch");
  assert.equal(calls[1].headers.cookie, "session=provider-token");
  assert.equal(calls[1].headers["user-agent"], "Lampac player");
  assert.equal(calls[1].headers.range, "bytes=0-99");
  assert.equal(calls[1].headers["accept-encoding"], "identity");
  assert.equal(result.url.href, "https://cdn.example.test/zetdb/master.m3u8");
  assert.equal(result.headerOrigin, "https://cdn.example.test");
});

test("transport waits for trusted engine readiness without spending the upstream deadline", async (t) => {
  const fixture = await startServer();
  t.after(() => closeServer(fixture.server));
  const engineCalls = [];
  const transport = createTransport({
    engineUrl: `${fixture.base}/`,
    beforeEngineRequest: async () => {
      engineCalls.push(Date.now());
      await new Promise((resolve) => setTimeout(resolve, 15));
    },
    requestOnceImpl: async (url) => url.pathname === "/lite/redirect"
      ? fakeResponse("", 302, { location: "/lite/final" })
      : fakeResponse("ready"),
  });
  const { response } = await transport.request(`${fixture.base}/lite/redirect`, { timeout: 20 });
  assert.equal(Buffer.concat(await Array.fromAsync(response)).toString(), "ready");
  assert.equal(engineCalls.length, 2, "the callback runs before each exact-engine request, including redirect hops");

  const external = createTransport({
    engineUrl: `${fixture.base}/`,
    engineKey: ENGINE_KEY,
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    beforeEngineRequest: () => { throw new Error("engine readiness callback must not run for CDN requests"); },
    requestOnceImpl: async (url) => fakeResponse(url.hostname),
  });
  const direct = await external.request("https://cdn.example.test/direct.mp4");
  assert.equal(Buffer.concat(await Array.fromAsync(direct.response)).toString(), "cdn.example.test");
  const unwrapped = await external.request(`${fixture.base}${lampacProxyLink("https://cdn.example.test/proxy.mp4", { Referer: "https://provider.example/watch" })}`);
  assert.equal(Buffer.concat(await Array.fromAsync(unwrapped.response)).toString(), "cdn.example.test");
});

test("transport passes engine readiness cancellation through without issuing the request", async (t) => {
  const fixture = await startServer();
  t.after(() => closeServer(fixture.server));
  let networkCalls = 0;
  const transport = createTransport({
    engineUrl: `${fixture.base}/`,
    beforeEngineRequest: (signal) => new Promise((resolve, reject) => {
      const onAbort = () => reject(signal.reason || Object.assign(new Error("aborted"), { name: "AbortError" }));
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    }),
    requestOnceImpl: async () => { networkCalls++; return fakeResponse("unexpected"); },
  });
  const controller = new AbortController();
  const pending = transport.request(`${fixture.base}/lite/json`, { signal: controller.signal });
  setTimeout(() => controller.abort(), 10);
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(networkCalls, 0);
});

test("transport rejects decrypted private destinations and leaves unsupported MD5 proxy links local", async (t) => {
  const fixture = await startServer();
  t.after(() => closeServer(fixture.server));
  const transport = createTransport({ engineUrl: `${fixture.base}/`, engineKey: ENGINE_KEY });
  const privateLink = lampacProxyLink(`${fixture.base}/lite/json`);
  await assert.rejects(transport.request(`${fixture.base}${privateLink}`), { code: "SSRF_BLOCKED" });

  const oldLink = `${fixture.base}/proxy/${"0123456789abcdef".repeat(2)}.m3u8`;
  const { response, url } = await transport.request(oldLink);
  assert.equal(url.href, oldLink);
  assert.equal(Buffer.concat(await Array.fromAsync(response)).toString(), "local-proxy-fallback");
  assert.throws(() => createTransport({ engineUrl: fixture.base, engineKey: "not-hex" }), /16-byte hex key/);
});

test("media carries unwrapped provider headers to same-origin children, probe variants, and no cross-origin cookie", async (t) => {
  const fixture = await startServer();
  t.after(() => closeServer(fixture.server));
  const localMedia = createMedia({ transport: createTransport({ engineUrl: `${fixture.base}/` }), secret: SECRET, publicOrigin: fixture.base });
  fixture.attachMedia(localMedia.handle);
  const htmlTypedPlaylist = `${fixture.base}/proxy/hls-html.m3u8`;
  const htmlTypedProbe = await localMedia.probe({ url: htmlTypedPlaylist });
  assert.equal(htmlTypedProbe.ok, true, `a valid #EXTM3U playlist can be returned with text/html MIME (${htmlTypedProbe.reason || "unknown"})`);
  const htmlTypedBody = await httpGet(localMedia.url({ url: htmlTypedPlaylist }));
  assert.equal(htmlTypedBody.response.status, 200);
  assert.match(htmlTypedBody.body.toString("utf8"), /\/v1\/media\?token=/);

  const calls = [];
  const transport = createTransport({
    engineUrl: `${fixture.base}/`,
    engineKey: ENGINE_KEY,
    lookup: async () => [{ address: "93.184.216.34", family: 4 }],
    requestOnceImpl: async (url, options) => {
      calls.push({ path: url.pathname, host: url.hostname, headers: { ...options.headers } });
      if (url.pathname === "/probe/master.m3u8") return fakeResponse("#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100000\nquality.m3u8\n", 200, { "content-type": "application/vnd.apple.mpegurl" });
      if (url.pathname === "/probe/quality.m3u8") return fakeResponse("#EXTM3U\n#EXTINF:2,first\nsegment.ts\n#EXTINF:3.5,second\nsegment.ts\n#EXT-X-ENDLIST\n", 200, { "content-type": "application/vnd.apple.mpegurl" });
      if (url.pathname === "/probe/live.m3u8") return fakeResponse("#EXTM3U\n#EXTINF:2,\nsegment.ts\n", 200, { "content-type": "application/vnd.apple.mpegurl" });
      if (url.pathname === "/probe/malformed-duration.m3u8") return fakeResponse("#EXTM3U\n#EXTINF:unknown,\nsegment.ts\n#EXT-X-ENDLIST\n", 200, { "content-type": "application/vnd.apple.mpegurl" });
      if (url.pathname === "/probe/file.mp4") return fakeResponse(Buffer.from([0, 0, 0, 8, 0x66, 0x74, 0x79, 0x70, 0, 0, 0, 0]), 200, { "content-type": "video/mp4" });
      if (url.pathname === "/video/master.m3u8") return fakeResponse("#EXTM3U\n#EXTINF:2,\nsegment.ts\n", 200, { "content-type": "application/vnd.apple.mpegurl" });
      if (url.pathname === "/video/cross.m3u8") return fakeResponse("#EXTM3U\n#EXTINF:2,\nhttps://assets.example.test/segment.ts\n", 200, { "content-type": "application/vnd.apple.mpegurl" });
      if (url.pathname.endsWith("segment.ts")) return fakeResponse(Buffer.alloc(188, 0x47), 200, { "content-type": "video/mp2t", "content-length": "188" });
      return fakeResponse("not found", 404);
    },
  });
  const media = createMedia({ transport, secret: SECRET, publicOrigin: fixture.base });
  fixture.attachMedia(media.handle);
  const providerHeaders = { Referer: "https://provider.example/watch", Cookie: "session=source" };
  const makeEngineUrl = (url) => `${fixture.base}${lampacProxyLink(url, providerHeaders)}`;

  const probe = await media.probe({ url: makeEngineUrl("https://cdn.example.test/probe/master.m3u8") });
  assert.equal(probe.ok, true);
  assert.equal(probe.url, "https://cdn.example.test/probe/master.m3u8", "probe keeps the ABR master URL after inspecting a child variant");
  assert.deepEqual(probe.headers, { referer: providerHeaders.Referer, cookie: "session=source" });
  assert.equal(probe.headerOrigin, "https://cdn.example.test");
  assert.equal(probe.duration, 5.5, "duration sums all EXTINF entries in the inspected VOD leaf playlist");
  const probeCalls = calls.splice(0);
  assert.deepEqual(probeCalls.map(({ path }) => path), ["/probe/master.m3u8", "/probe/quality.m3u8", "/probe/segment.ts"]);
  assert(probeCalls.every(({ headers }) => headers.cookie === "session=source" && headers.referer === providerHeaders.Referer));

  const fileProbe = await media.probe({ url: makeEngineUrl("https://cdn.example.test/probe/file.mp4") });
  assert.equal(fileProbe.ok, true);
  assert.equal(fileProbe.url, "https://cdn.example.test/probe/file.mp4");
  assert.deepEqual(fileProbe.headers, { referer: providerHeaders.Referer, cookie: "session=source" });
  assert.equal(fileProbe.headerOrigin, "https://cdn.example.test");
  assert.equal(Object.hasOwn(fileProbe, "duration"), false, "file responses do not invent a duration");

  const liveProbe = await media.probe({ url: makeEngineUrl("https://cdn.example.test/probe/live.m3u8") });
  assert.equal(liveProbe.ok, true);
  assert.equal(liveProbe.duration, null, "a playlist without ENDLIST is live or unknown duration");
  const malformedDurationProbe = await media.probe({ url: makeEngineUrl("https://cdn.example.test/probe/malformed-duration.m3u8") });
  assert.equal(malformedDurationProbe.ok, true);
  assert.equal(malformedDurationProbe.duration, null, "malformed EXTINF entries must not become partial duration estimates");

  const root = await httpGet(media.url({ url: makeEngineUrl("https://cdn.example.test/video/master.m3u8") }));
  assert.equal(root.response.status, 200);
  const sameOriginChild = root.body.toString("utf8").split("\n").find((line) => line.includes("/v1/media?token="));
  assert(sameOriginChild);
  const child = await httpGet(sameOriginChild);
  assert.equal(child.response.status, 200);
  assert.equal(calls.at(-1).headers.cookie, "session=source");
  assert.equal(calls.at(-1).headers.referer, providerHeaders.Referer);

  const crossPlaylist = await httpGet(media.url({ url: makeEngineUrl("https://cdn.example.test/video/cross.m3u8") }));
  assert.equal(crossPlaylist.response.status, 200);
  const crossChild = crossPlaylist.body.toString("utf8").split("\n").find((line) => line.includes("/v1/media?token="));
  assert(crossChild);
  const beforeCrossChild = calls.length;
  const fetchedCrossChild = await httpGet(crossChild);
  assert.equal(fetchedCrossChild.response.status, 200);
  assert.equal(calls[beforeCrossChild].host, "assets.example.test");
  assert.equal(calls[beforeCrossChild].headers.cookie, undefined, "provider cookies do not cross the playlist origin");
  assert.equal(calls[beforeCrossChild].headers.referer, providerHeaders.Referer);
});

test("media rewrites large HLS playlists, probes map/key/segment, and preserves ranged responses", async (t) => {
  const fixture = await startServer();
  t.after(() => closeServer(fixture.server));
  const transport = createTransport({ engineUrl: `${fixture.base}/` });
  const media = createMedia({ transport, secret: SECRET, publicOrigin: fixture.base });
  fixture.attachMedia(media.handle);
  const opaque = media.url({ url: `${fixture.base}/proxy/master.m3u8`, headers: { Referer: "https://provider.example/", Authorization: "must-not-forward" } });
  assert(!opaque.includes("master.m3u8"));
  assert.deepEqual(await media.probe({ url: `${fixture.base}/proxy/master.m3u8` }), {
    ok: true,
    kind: "hls",
    url: `${fixture.base}/proxy/master.m3u8`,
    headers: {},
    headerOrigin: fixture.base,
    bytes: 128,
    initBytes: true,
    encrypted: true,
    duration: 2,
  });
  const rangedProbe = await media.probe({ url: `${fixture.base}/proxy/ranged.m3u8` });
  assert.equal(rangedProbe.kind, "hls");
  assert.deepEqual(fixture.seenRanges.slice(-2), ["/proxy/init-range.bin bytes=4-11", "/proxy/segment-range.ts bytes=20-25"]);
  for (const path of ["sniff-split", "sniff-octet"]) {
    const { response, body } = await httpGet(media.url({ url: `${fixture.base}/proxy/${path}` }));
    assert.equal(response.headers.get("content-type"), "application/vnd.apple.mpegurl");
    assert.match(body.toString("utf8"), /\/v1\/media\?token=/);
    assert(!body.toString("utf8").includes("segment.ts"));
  }
  const ignoredRangeRoot = media.url({ url: `${fixture.base}/proxy/range-ignored.m3u8` });
  const ignoredRangePlaylist = await httpGet(ignoredRangeRoot, { headers: { range: "bytes=0-100" } });
  assert.equal(ignoredRangePlaylist.response.status, 200, "an upstream that ignores Range still returns its complete playlist");
  assert.equal(ignoredRangePlaylist.response.headers.get("content-range"), null);
  const ignoredRangeChild = ignoredRangePlaylist.body.toString("utf8").split("\n").find((line) => line.includes("/v1/media?token="));
  assert(ignoredRangeChild);
  const ignoredRangeSegment = await httpGet(ignoredRangeChild, { headers: { range: "bytes=0-99" } });
  assert.equal(ignoredRangeSegment.response.status, 200, "a normal segment remains playable when its origin ignores Range");
  assert.equal(ignoredRangeSegment.response.headers.get("content-range"), null);
  assert.equal(ignoredRangeSegment.body.length, 188);
  assert.deepEqual(fixture.seenRanges.slice(-2), ["/proxy/range-ignored.m3u8 bytes=0-100", "/proxy/range-ignored-segment.ts bytes=0-99"]);
  for (const first of ["<", "[", "{"]) {
    const probe = await media.probe({ url: `${fixture.base}/proxy/file-${first.charCodeAt(0).toString(16)}.bin` });
    assert.equal(probe.kind, "file");
  }
  assert.throws(() => createMedia({ transport, secret: "too short" }), /32 bytes/);

  const root = await httpGet(opaque, { headers: { authorization: "viewer-secret" } });
  assert.equal(root.response.status, 200);
  assert.equal(fixture.authorizationForwarded(), false);
  const child = root.body.toString("utf8").split("\n").find((line) => line.includes("/v1/media?token="));
  assert(child);
  const rewritten = await httpGet(child);
  assert.equal(rewritten.response.status, 200);
  const text = rewritten.body.toString("utf8");
  assert(text.length > 8 * 1024 * 1024);
  assert.match(text, /URI="http:\/\/127\.0\.0\.1:\d+\/v1\/media\?token=/);
  assert(!text.includes('URI="key.bin"'));

  const rangeToken = new URL(media.url({ url: `${fixture.base}/proxy/range.bin` })).searchParams.get("token");
  const ranged = await httpGet(`${fixture.base}/v1/media?token=${encodeURIComponent(rangeToken)}`, { headers: { range: "bytes=10-999000000" } });
  assert.equal(ranged.response.status, 206);
  assert.equal(ranged.response.headers.get("content-range"), `bytes 10-${10 + 96 * 1024 * 1024 - 1}/200000000`);
  assert.equal(fixture.seenRanges.at(-1), `bytes=10-${10 + 96 * 1024 * 1024 - 1}`);
  const invalid = await httpGet(`${fixture.base}/v1/media?token=${encodeURIComponent(rangeToken)}`, { headers: { range: "bytes=bad" } });
  assert.equal(invalid.response.status, 416);
});

test("HLS compression negotiates gzip without changing signed children or ranged media", async (t) => {
  const fixture = await startServer();
  t.after(() => closeServer(fixture.server));
  const media = createMedia({ transport: createTransport({ engineUrl: `${fixture.base}/` }), secret: SECRET, publicOrigin: fixture.base });
  fixture.attachMedia(media.handle);
  const playlistUrl = media.url({ url: `${fixture.base}/proxy/quality.m3u8`, nodeOnly: true });
  const compressed = await new Promise((resolve, reject) => {
    http.get(playlistUrl, { headers: { "accept-encoding": "br, GZip;q=0.5" } }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("error", reject);
      response.on("end", () => resolve({ headers: response.headers, body: Buffer.concat(chunks) }));
    }).on("error", reject);
  });
  assert.equal(compressed.headers["content-encoding"], "gzip");
  assert.equal(compressed.headers.vary, "Accept-Encoding");
  assert.equal(Number(compressed.headers["content-length"]), compressed.body.length);
  const { gunzipSync } = await import("node:zlib");
  const decoded = gunzipSync(compressed.body).toString("utf8");
  assert(decoded.startsWith("#EXTM3U\n"));
  assert(compressed.body.length < Buffer.byteLength(decoded));
  const child = decoded.split("\n").find((line) => line.startsWith(`${fixture.base}/v1/media?`));
  assert(child);
  const resource = media.resource(new URL(child).searchParams.get("token"));
  assert.equal(resource.url, `${fixture.base}/proxy/segment.ts`);
  assert.equal(resource.nodeOnly, true);
  const identity = await httpGet(playlistUrl, { headers: { "accept-encoding": "*;q=1, gzip;q=0" } });
  assert.equal(identity.response.headers.get("content-encoding"), null, "explicit gzip refusal wins over wildcard");
  assert(identity.body.toString("utf8").startsWith("#EXTM3U\n"));
  const ranged = await httpGet(playlistUrl, { headers: { range: "bytes=0-100", "accept-encoding": "gzip" } });
  assert.equal(ranged.response.headers.get("content-encoding"), null, "Range is never compressed");
  const head = await httpGet(playlistUrl, { method: "HEAD", headers: { "accept-encoding": "gzip" } });
  assert.equal(head.body.length, 0);
  assert.equal(head.response.headers.get("content-encoding"), null);
});

test("media rejects fake video errors, empty bodies, tampered and expired tokens, and aborts upstream", async (t) => {
  const fixture = await startServer();
  t.after(() => closeServer(fixture.server));
  const transport = createTransport({ engineUrl: `${fixture.base}/` });
  const media = createMedia({ transport, secret: SECRET, publicOrigin: fixture.base });
  fixture.attachMedia(media.handle);
  for (const path of ["html", "json.bin", "empty", "denied"]) {
    const target = media.url({ url: `${fixture.base}/proxy/${path}` });
    const { response } = await httpGet(target);
    assert.equal(response.status, 502);
  }
  const tampered = new URL(media.url({ url: `${fixture.base}/proxy/range.bin` }));
  const token = tampered.searchParams.get("token");
  const parts = token.split(".");
  parts[3] = `${parts[3][0] === "A" ? "B" : "A"}${parts[3].slice(1)}`;
  tampered.searchParams.set("token", parts.join("."));
  assert.equal((await httpGet(tampered.toString())).response.status, 404);
  tampered.searchParams.set("token", `${token}.extra`);
  assert.equal((await httpGet(tampered.toString())).response.status, 404, "tokens with extra components are rejected");
  const expired = sealedToken({ url: `${fixture.base}/proxy/range.bin`, headers: {}, exp: Date.now() - 1 });
  assert.equal((await httpGet(`${fixture.base}/v1/media?token=${expired}`)).response.status, 404);

  const slowToken = new URL(media.url({ url: `${fixture.base}/proxy/slow-media` })).searchParams.get("token");
  const client = http.get(`${fixture.base}/v1/media?token=${encodeURIComponent(slowToken)}`);
  await once(client, "response");
  client.destroy();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(fixture.slowClosed(), true);
});
