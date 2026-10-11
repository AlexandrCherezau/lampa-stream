import assert from "node:assert/strict";
import { createCipheriv } from "node:crypto";
import http from "node:http";
import { EventEmitter, once } from "node:events";
import { Readable } from "node:stream";
import test from "node:test";
import { createMedia } from "../media.mjs";
import { createSourceServer } from "../server.mjs";
import { createTransport } from "../transport.mjs";

const SECRET = "relay-security-test-secret-long-enough";
const API_KEY = "relay-security-api-key";
const ENGINE_KEY = "00112233445566778899aabbccddeeff";

function proxyLink(url) {
  const iv = Buffer.from("0123456789abcdef");
  const cipher = createCipheriv("aes-128-cbc", Buffer.from(ENGINE_KEY, "hex"), iv);
  const encrypted = Buffer.concat([iv, cipher.update(JSON.stringify({ u: url, h: { Referer: "https://provider.example/watch", Cookie: "sid=provider" } })), cipher.final()]);
  return `/proxy/${encrypted.toString("base64url")}.m3u8`;
}

async function serve(options = {}) {
  const server = createSourceServer({
    engineUrl: "http://lampac.internal:9118/",
    secret: SECRET,
    apiKey: API_KEY,
    adapter: { async *discover() {}, async resolve() { throw new Error("unused"); } },
    media: { async handle(_req, res, token) { res.writeHead(200, { "content-type": "text/plain" }).end(`handled:${token}`); }, resource(token) { return { url: `https://cdn.example.test/${token}` }; } },
    transport: { async route(resource) { return { kind: "direct", url: resource.url, headers: resource.headers || {}, headerOrigin: new URL(resource.url).origin }; } },
    ...options,
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    close: async () => { server.closeAllConnections(); server.close(); await once(server, "close"); },
  };
}

test("transport.route distinguishes trusted Lampac AES, native engine, and public media", async () => {
  const calls = [];
  const transport = createTransport({
    engineUrl: "http://lampac.internal:9118/",
    engineKey: ENGINE_KEY,
    lookup: async (host) => {
      calls.push(host);
      return [{ address: "93.184.216.34", family: 4 }];
    },
  });

  const native = await transport.route({ url: "http://lampac.internal:9118/lite/proxy?id=1" });
  assert.equal(native.kind, "engine");
  assert.equal(native.headerOrigin, "http://lampac.internal:9118");

  const direct = await transport.route({ url: "http://lampac.internal:9118" + proxyLink("https://cdn.example.test/master.m3u8"), headers: { range: "bytes=0-10" } });
  assert.equal(direct.kind, "direct");
  assert.equal(direct.url, "https://cdn.example.test/master.m3u8");
  assert.equal(direct.headers.cookie, "sid=provider");
  assert.deepEqual(calls, ["cdn.example.test"]);

  const external = await transport.route({ url: "https://video.example.test/movie.mp4", headers: { cookie: "session=secret", referer: "https://provider.example/" }, headerOrigin: "https://other.example" });
  assert.equal(external.kind, "direct");
  assert.equal(external.headers.cookie, undefined, "cross-origin header origin must remove cookies");
  assert.equal(external.headers.referer, "https://provider.example/");
});

test("transport.route rejects native engine paths outside the safe API and private DNS answers", async () => {
  const transport = createTransport({
    engineUrl: "https://lampac.example.test/",
    lookup: async (host) => host === "private.example.test"
      ? [{ address: "10.0.0.8", family: 4 }]
      : [{ address: "93.184.216.34", family: 4 }],
  });
  await assert.rejects(transport.route({ url: "https://lampac.example.test/AdminPanel" }), { code: "BAD_URL" });
  await assert.rejects(transport.route({ url: "https://private.example.test/video.m3u8" }), { code: "SSRF_BLOCKED" });
  await assert.rejects(transport.route({ url: "http://127.0.0.1/private" }), { code: "SSRF_BLOCKED" });
});

test("AES-wrapped DNS failures preserve only the normalized target host and DNS code", async () => {
  const dnsFailure = Object.assign(new Error("do not expose resolver details"), { code: "ENOTFOUND" });
  const transport = createTransport({
    engineUrl: "http://lampac.internal:9118/",
    engineKey: ENGINE_KEY,
    lookup: async () => { throw dnsFailure; },
  });
  const wrapped = `http://lampac.internal:9118${proxyLink("https://cdn.example.test/private/path?token=private-value")}`;
  const expected = (error) => error.code === "DNS_ERROR" && error.status === 502
    && error.targetHost === "cdn.example.test" && error.dnsCode === "ENOTFOUND";

  await assert.rejects(transport.route({ url: wrapped }), expected);
  await assert.rejects(transport.request(wrapped), expected);
});

test("media DNS diagnostics name the AES target without logging wrapper or provider secrets", async () => {
  const dnsFailure = Object.assign(new Error("private resolver detail"), { code: "ENOTFOUND" });
  const transport = createTransport({
    engineUrl: "http://lampac.internal:9118/",
    engineKey: ENGINE_KEY,
    lookup: async () => { throw dnsFailure; },
  });
  const media = createMedia({ transport, secret: SECRET });
  const targetUrl = "https://cdn.example.test/private/path?token=private-value";
  const wrapped = `http://lampac.internal:9118${proxyLink(targetUrl)}`;
  const forbiddenLogText = [wrapped, targetUrl, "private-value", "provider", "sid=provider", "private resolver detail"];
  const originalWarn = console.warn;
  const originalError = console.error;
  let probeLog = [];
  let upstreamLog = [];
  try {
    console.warn = (...args) => { probeLog = args; };
    const probe = await media.probe({ url: wrapped });
    assert.deepEqual({ ok: probe.ok, reason: probe.reason }, { ok: false, reason: "DNS_ERROR" });

    const tokenUrl = media.url({ url: wrapped });
    const token = new URL(tokenUrl, "http://origin.example").searchParams.get("token");
    const req = new EventEmitter();
    req.headers = {};
    req.method = "GET";
    const res = new EventEmitter();
    res.writableEnded = false;
    res.destroyed = false;
    res.writeHead = (status) => { res.statusCode = status; };
    res.end = () => { res.writableEnded = true; };
    console.error = (...args) => { upstreamLog = args; };
    await media.handle(req, res, token);
    assert.equal(res.statusCode, 502);
  } finally {
    console.warn = originalWarn;
    console.error = originalError;
  }

  for (const [label, args] of [["probe", probeLog], ["upstream", upstreamLog]]) {
    const text = args.map(String).join(" ");
    assert.match(text, /cdn\.example\.test/, `${label} log includes the actual CDN hostname`);
    assert.match(text, /ENOTFOUND/, `${label} log includes the DNS resolver code`);
    for (const secret of forbiddenLogText) assert.equal(text.includes(secret), false, `${label} log omits ${secret}`);
  }
});

test("private media-route requires bearer auth and rejects a tampered opaque token", async (t) => {
  const transport = {
    async route(resource) {
      assert.equal(resource.url, "https://cdn.example.test/master.m3u8");
      return { kind: "direct", url: resource.url, headers: {}, headerOrigin: "https://cdn.example.test" };
    },
  };
  const media = createMedia({ transport: { async request() { throw new Error("unused"); } }, secret: SECRET });
  const token = new URL(media.url({ url: "https://cdn.example.test/master.m3u8" }), "https://origin.example.test").searchParams.get("token");
  const app = await serve({ media, transport });
  t.after(app.close);

  const privateUrl = `${app.base}/v1/media-route?token=${encodeURIComponent(token)}`;
  assert.equal((await fetch(privateUrl)).status, 401);
  const allowed = await fetch(privateUrl, { headers: { authorization: `Bearer ${API_KEY}` } });
  assert.equal(allowed.status, 200);
  assert.equal((await allowed.json()).url, "https://cdn.example.test/master.m3u8");

  const tampered = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;
  const rejected = await fetch(`${app.base}/v1/media-route?token=${encodeURIComponent(tampered)}`, { headers: { authorization: `Bearer ${API_KEY}` } });
  assert.equal(rejected.status, 404);
  assert.equal((await rejected.json()).error, "MEDIA_UNAVAILABLE");
});

test("media relay redirects opaque tokens; relay key bypasses redirect only for the relay request", async (t) => {
  let handledToken;
  const media = {
    url(resource) { return `https://origin.example.test/v1/media?token=opaque%2F${resource.id}`; },
    resource(token) { return { url: `https://cdn.example.test/${token}` }; },
    async handle(_req, res, token) { handledToken = token; res.writeHead(206).end("media"); },
  };
  const app = await serve({ media, mediaRelayUrl: "https://relay.example.test", publicOrigin: "https://origin.example.test" });
  t.after(app.close);

  const redirected = await fetch(`${app.base}/v1/media?token=opaque-token`, { redirect: "manual" });
  assert.equal(redirected.status, 302);
  const location = new URL(redirected.headers.get("location"));
  assert.equal(location.origin, "https://relay.example.test");
  assert.equal(location.pathname, "/v1/media");
  assert.equal(location.searchParams.get("token"), "opaque-token");
  assert.equal(location.searchParams.has("url"), false, "redirect must not reveal upstream media URL");

  const served = await fetch(`${app.base}/v1/media?token=opaque-token`, { headers: { "x-source-relay-key": API_KEY } });
  assert.equal(served.status, 206);
  assert.equal(await served.text(), "media");
  assert.equal(handledToken, "opaque-token");
});

test("sealed node-only HLS media stays on Node through child resources while ordinary and tampered tokens stay safe", async (t) => {
  const upstreamRequests = [];
  const transport = {
    async route(resource) { return { kind: "direct", url: resource.url, headers: {}, headerOrigin: new URL(resource.url).origin }; },
    async request(rawUrl) {
      const url = new URL(rawUrl);
      upstreamRequests.push(url);
      const playlist = url.pathname.endsWith("master.m3u8");
      const body = playlist ? "#EXTM3U\n#EXTINF:2,\nsegment.ts\n#EXT-X-ENDLIST\n" : Buffer.from([0x47, 1, 2, 3]);
      const response = Readable.from([Buffer.from(body)]);
      response.statusCode = 200;
      response.headers = { "content-type": playlist ? "application/vnd.apple.mpegurl" : "video/mp2t" };
      return { response, url, headers: {}, headerOrigin: url.origin };
    },
  };
  const media = createMedia({ transport, secret: SECRET });
  const app = await serve({ media, transport, mediaRelayUrl: "https://relay.example.test" });
  t.after(app.close);

  const nodeOnlyUrl = media.url({ url: "https://cdn.example.test/master.m3u8", nodeOnly: true });
  const rootToken = new URL(nodeOnlyUrl, app.base).searchParams.get("token");
  assert.equal(media.resource(rootToken).nodeOnly, true, "the encrypted token seals nodeOnly metadata");
  const root = await fetch(`${app.base}/v1/media?token=${encodeURIComponent(rootToken)}`, { redirect: "manual" });
  assert.equal(root.status, 200, "node-only root media bypasses the Worker redirect without relay auth");
  assert.equal(root.headers.get("access-control-allow-origin"), "*");
  const playlist = await root.text();
  const childUrl = playlist.split("\n").find((line) => line.includes("/v1/media?token="));
  assert(childUrl);
  const childToken = new URL(childUrl, app.base).searchParams.get("token");
  assert.equal(media.resource(childToken).nodeOnly, true, "rewritten HLS children inherit the sealed Node-only flag");
  const child = await fetch(new URL(childUrl, app.base), { redirect: "manual" });
  assert.equal(child.status, 200, "node-only HLS children stay on Node without relay auth");
  assert.deepEqual(Array.from(new Uint8Array(await child.arrayBuffer())), [0x47, 1, 2, 3]);
  assert.deepEqual(upstreamRequests.map((url) => url.pathname), ["/master.m3u8", "/segment.ts"]);

  const ordinaryUrl = media.url({ url: "https://cdn.example.test/movie.mp4" });
  const ordinaryToken = new URL(ordinaryUrl, app.base).searchParams.get("token");
  assert.equal(media.resource(ordinaryToken).nodeOnly, false);
  const redirected = await fetch(`${app.base}/v1/media?token=${encodeURIComponent(ordinaryToken)}&nodeOnly=true`, { redirect: "manual" });
  assert.equal(redirected.status, 302, "a query parameter cannot override the sealed node-only setting");
  assert.equal(new URL(redirected.headers.get("location")).origin, "https://relay.example.test");

  const tampered = ordinaryToken.slice(0, -1) + (ordinaryToken.endsWith("A") ? "B" : "A");
  const rejected = await fetch(`${app.base}/v1/media?token=${encodeURIComponent(tampered)}&nodeOnly=true`, { redirect: "manual" });
  assert.equal(rejected.status, 404, "tampered tokens cannot bypass the Worker redirect or crash the handler");
});
