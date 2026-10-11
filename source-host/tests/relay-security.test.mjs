import assert from "node:assert/strict";
import { createCipheriv } from "node:crypto";
import http from "node:http";
import { once } from "node:events";
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
