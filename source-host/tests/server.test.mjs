import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { mkdtemp, writeFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSourceServer } from "../server.mjs";
import { createMedia } from "../media.mjs";
import { createTransport } from "../transport.mjs";

const apiKey = "server-test-api-key";
const auth = { authorization: `Bearer ${apiKey}` };

async function start(adapter, media, key = "", secret = "test-secret-that-is-long-enough-for-this-suite", options = {}) {
  const server = createSourceServer({ engineUrl: "http://127.0.0.1:29118/", secret, adapter, media, apiKey: key, ...options });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    server,
    base: `http://127.0.0.1:${server.address().port}`,
    async close() {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
}

async function post(base, path, body, headers = {}) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function makeMedia({ unavailable = new Set(), kinds = {} } = {}) {
  const probes = [];
  return {
    probes,
    async probe(quality) {
      probes.push(quality.label);
      return unavailable.has(quality.label)
        ? { ok: false, reason: "dead" }
        : { ok: true, kind: kinds[quality.label] || "hls" };
    },
    url(resource) { return `https://media.test/v1/media?token=${resource.label || "subtitle"}`; },
    async handle(_req, res) { res.writeHead(204).end(); },
  };
}

function candidate(extra = {}) {
  return {
    providerId: "hdvb",
    providerName: "HDVB",
    voiceId: "ru",
    voiceName: "Русская",
    qualityHint: "720p",
    season: 1,
    episode: 14,
    url: "http://127.0.0.1:29118/lite/private?secret=engine-token",
    ref: { url: "http://127.0.0.1:29118/lite/private?secret=engine-token" },
    ...extra,
  };
}

function parseFrame(frame) {
  const event = /^event: ([^\n]+)/m.exec(frame)?.[1];
  const data = /^data: (.+)$/m.exec(frame)?.[1];
  return event ? { event, data: data ? JSON.parse(data) : null } : null;
}

function sseReader(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  const frames = [];
  return {
    frames,
    async until(eventName) {
      while (!frames.some((frame) => frame.event === eventName)) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
        const split = text.split("\n\n");
        text = split.pop();
        for (const raw of split) {
          const frame = parseFrame(raw);
          if (frame) frames.push(frame);
        }
      }
      return frames.find((frame) => frame.event === eventName) || null;
    },
    async drain() {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value, { stream: true });
        const split = text.split("\n\n");
        text = split.pop();
        for (const raw of split) {
          const frame = parseFrame(raw);
          if (frame) frames.push(frame);
        }
      }
    },
    cancel() { return reader.cancel(); },
  };
}

test("strict TV coordinates, progressive safe SSE, and caller engine URLs", async (t) => {
  let seenTitle;
  let releaseSlowProvider;
  const slowProvider = new Promise((resolve) => { releaseSlowProvider = resolve; });
  const adapter = {
    async *discover(title) {
      seenTitle = title;
      yield candidate({
        url: "http://engine.internal/lite/provider?secret=hidden",
        ref: { url: "http://engine.internal/lite/provider?secret=hidden" },
      });
      await slowProvider;
    },
    async resolve() { return { qualities: [] }; },
  };
  const media = makeMedia();
  const app = await start(adapter, media);
  t.after(() => app.close());

  for (const bad of [
    { type: "tv", title: "Show", season: 1.5, episode: 14 },
    { type: "tv", title: "Show", season: 1, episode: 0 },
    { type: "tv", title: "Show", season: 1 },
  ]) {
    const invalid = await post(app.base, "/v1/discover", bad);
    assert.equal(invalid.status, 400);
  }

  const response = await post(app.base, "/v1/discover", {
    type: "tv", title: "Show", season: 1, episode: 14,
    engineUrl: "http://127.0.0.1:29118/lite/attacker-controlled",
  });
  assert.equal(response.status, 200);
  const stream = sseReader(response.body);
  const emitted = await stream.until("candidate");
  assert(emitted);
  assert.equal(stream.frames.some((frame) => frame.event === "done"), false, "candidate must arrive while the provider is still pending");
  assert.deepEqual([seenTitle.season, seenTitle.episode], [1, 14]);
  assert.equal(Object.hasOwn(seenTitle, "engineUrl"), false, "client input cannot override the configured engine URL");
  assert.deepEqual(Object.keys(emitted.data).sort(), ["episode", "id", "providerId", "providerName", "qualityHint", "season", "voiceId", "voiceName"].sort());
  assert(!JSON.stringify(emitted.data).includes("engine.internal"));
  assert(!JSON.stringify(emitted.data).includes("engine-token"));
  releaseSlowProvider();
  await stream.drain();
  assert.equal(stream.frames.find((frame) => frame.event === "done").data.candidates, 1);
});

test("resolution skips a dead default quality, honors manual quality, and rejects unknown source ids", async (t) => {
  const resolved = [];
  const adapter = {
    async *discover() { yield candidate({ marker: "private-adapter-ref" }); },
    async resolve(value) {
      resolved.push(value);
      return {
        qualities: [
          { label: "720p", height: 720, url: "http://engine.internal/720.m3u8" },
          { label: "1080p", height: 1080, url: "http://engine.internal/1080.mp4" },
          { label: "480p", height: 480, url: "http://engine.internal/480.m3u8" },
        ],
        subtitles: [],
      };
    },
  };
  const media = makeMedia({ unavailable: new Set(["720p"]), kinds: { "480p": "file" } });
  const app = await start(adapter, media);
  t.after(() => app.close());
  const discovery = await post(app.base, "/v1/discover", { type: "tv", title: "Show", season: 1, episode: 14 });
  const stream = sseReader(discovery.body);
  const event = await stream.until("candidate");
  const id = event.data.id;
  await stream.drain();

  const unavailable = await post(app.base, "/v1/resolve", { id: "unknown-source-id" });
  assert.equal(unavailable.status, 410);
  assert.equal((await unavailable.json()).error, "SOURCE_EXPIRED");

  const automatic = await post(app.base, "/v1/resolve", { id });
  assert.equal(automatic.status, 200);
  const automaticResult = await automatic.json();
  assert.deepEqual(media.probes, ["720p", "480p"]);
  assert.equal(automaticResult.selected.label, "480p");
  assert.equal(automaticResult.kind, "file");
  assert(!JSON.stringify(automaticResult).includes("engine.internal"));
  assert(!JSON.stringify(automaticResult).includes("marker"));

  media.probes.length = 0;
  const manual = await post(app.base, "/v1/resolve", { id, quality: "1080p" });
  assert.equal(manual.status, 200);
  assert.equal((await manual.json()).selected.label, "1080p");
  assert.deepEqual(media.probes, ["1080p"], "explicit selection probes only that exact label");
  assert.equal(resolved.length, 2);
});

test("API key gates private routes and a disconnected discovery aborts its adapter", async (t) => {
  let aborted = false;
  const adapter = {
    async *discover(_title, { signal }) {
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      aborted = signal.aborted;
    },
    async resolve() { throw new Error("not used"); },
  };
  const app = await start(adapter, makeMedia(), apiKey);
  t.after(() => app.close());
  assert.equal((await fetch(`${app.base}/v1/providers`)).status, 401);
  assert.equal((await post(app.base, "/v1/discover", { type: "movie", title: "Movie" })).status, 401);

  const response = await post(app.base, "/v1/discover", { type: "movie", title: "Movie" }, auth);
  assert.equal(response.status, 200);
  const stream = sseReader(response.body);
  await stream.until("start");
  await stream.cancel();
  for (let attempt = 0; attempt < 30 && !aborted; attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(aborted, true, "closing the HTTP client should abort provider discovery");
});

test("sealed source ids survive a new instance and reject tampering, another secret and expiry", async (t) => {
  let resolved;
  const adapter = {
    async *discover() {
      const value = candidate();
      Object.defineProperty(value, "ref", { value: value.ref, enumerable: false });
      yield value;
    },
    async resolve(value) {
      resolved = value;
      return { qualities: [{ label: "720p", height: 720, url: "https://private.cdn.test/file.m3u8" }] };
    },
  };
  const first = await start(adapter, makeMedia());
  const discovery = await post(first.base, "/v1/discover", { type: "movie", title: "Movie", runtimeMinutes: 139 });
  const stream = sseReader(discovery.body);
  const { data: discovered } = await stream.until("candidate");
  const { id } = discovered;
  assert.equal(Object.hasOwn(discovered, "runtimeMinutes"), false, "movie runtime remains private in the sealed candidate");
  await stream.drain();
  await first.close();

  const second = await start(adapter, makeMedia());
  t.after(() => second.close());
  assert.equal((await post(second.base, "/v1/resolve", { id })).status, 200);
  assert.equal(resolved.ref.url, "http://127.0.0.1:29118/lite/private?secret=engine-token");
  assert.equal(Object.keys(resolved).includes("ref"), false);
  assert.equal(resolved.runtimeMinutes, 139, "the encrypted runtime hint survives instance replacement");
  assert.equal(Object.keys(resolved).includes("runtimeMinutes"), false, "the provider adapter does not receive an enumerable runtime hint");
  const parts = id.split(".");
  parts[3] = (parts[3][0] === "A" ? "B" : "A") + parts[3].slice(1);
  assert.equal((await post(second.base, "/v1/resolve", { id: parts.join(".") })).status, 410);
  assert.equal((await post(second.base, "/v1/resolve", { id: id + ".extra" })).status, 410);

  const other = await start(adapter, makeMedia(), "", "another-secret-long-enough-for-this-suite");
  t.after(() => other.close());
  assert.equal((await post(other.base, "/v1/resolve", { id })).status, 410);
  const actualNow = Date.now;
  try {
    Date.now = () => actualNow() + 13 * 60 * 60_000;
    assert.equal((await post(second.base, "/v1/resolve", { id })).status, 410);
  } finally { Date.now = actualNow; }
});

test("cold containers serve media immediately while metadata waits for the private engine", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "source-ready-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const engineReadyFile = join(directory, "ready");
  let discovered = false;
  const adapter = {
    async *discover() { discovered = true; yield candidate(); },
    async resolve() { throw new Error("not used"); },
  };
  const app = await start(adapter, makeMedia(), "", undefined, { engineReadyFile });
  t.after(() => app.close());
  assert.equal((await (await fetch(app.base + "/healthz")).json()).engineReady, false);
  assert.equal((await fetch(app.base + "/v1/media?token=test")).status, 204);
  await assert.rejects(stat(engineReadyFile + ".start"), { code: "ENOENT" });
  const pending = post(app.base, "/v1/discover", { type: "movie", title: "Movie" });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(discovered, false);
  assert.equal((await stat(engineReadyFile + ".start")).mode & 0o777, 0o600);
  assert.equal((await fetch(app.base + "/v1/media?token=test")).status, 204);
  await writeFile(engineReadyFile, "ready");
  const response = await pending;
  assert.equal(response.status, 200);
  assert.match(await response.text(), /event: candidate/);
  assert.equal((await (await fetch(app.base + "/healthz")).json()).engineReady, true);
});

test("cold media waits for the engine when a provider owns its playlist endpoint", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "source-media-ready-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const engineReadyFile = join(directory, "ready");
  let requests = 0;
  const engine = http.createServer((_req, res) => {
    requests++;
    res.writeHead(200, { "content-type": "video/mp4" }).end(Buffer.from("00000018667479706d70343200000000", "hex"));
  });
  engine.listen(0, "127.0.0.1");
  await once(engine, "listening");
  t.after(async () => { engine.closeAllConnections(); engine.close(); await once(engine, "close"); });
  const engineUrl = `http://127.0.0.1:${engine.address().port}`;
  const secret = "media-readiness-secret-long-enough-for-the-suite";
  const app = await start({}, undefined, "", secret, { engineUrl, engineReadyFile });
  t.after(() => app.close());
  const signer = createMedia({ transport: createTransport({ engineUrl }), secret });
  const pending = fetch(app.base + signer.url({ url: engineUrl + "/lite/vibix/video.m3u8" }));
  for (let attempt = 0; attempt < 50; attempt++) {
    try { await stat(engineReadyFile + ".start"); break; }
    catch { await new Promise((resolve) => setTimeout(resolve, 10)); }
  }
  assert.equal((await stat(engineReadyFile + ".start")).mode & 0o777, 0o600);
  assert.equal(requests, 0);
  await writeFile(engineReadyFile, "ready");
  const response = await pending;
  assert.equal(response.status, 200);
  assert.equal((await response.arrayBuffer()).byteLength, 16);
  assert.equal(requests, 1);
});

test("resolution preserves the verified target when providers repeat quality labels", async (t) => {
  const adapter = {
    async *discover() { yield candidate(); },
    async resolve() { return { qualities: [
      { label: "720p", height: 720, url: "http://engine.internal/dead" },
      { label: "720p", height: 720, url: "http://engine.internal/dynamic-manifest" },
    ] }; },
  };
  const media = makeMedia();
  let signed;
  media.probe = async (quality) => quality.url.endsWith("dead") ? { ok: false } : {
    ok: true, kind: "hls", url: "https://cdn.test/master.m3u8", headers: { referer: "https://provider.test/" }, headerOrigin: "https://cdn.test",
  };
  media.url = (resource) => {
    if (resource.url === "https://cdn.test/master.m3u8") { signed = resource; return "https://media.test/v1/media?token=verified"; }
    return "https://media.test/v1/media?token=unverified";
  };
  const app = await start(adapter, media);
  t.after(() => app.close());
  const discovery = await post(app.base, "/v1/discover", { type: "movie", title: "Movie" });
  const reader = sseReader(discovery.body);
  const { data: { id } } = await reader.until("candidate");
  await reader.drain();
  const result = await (await post(app.base, "/v1/resolve", { id })).json();
  assert.equal(result.selected.url, "https://media.test/v1/media?token=verified");
  assert.equal(signed.headers.referer, "https://provider.test/");
  assert.equal(signed.headerOrigin, "https://cdn.test");
});

test("ZetflixDB and CDNVideoHub quality media tokens are sealed for direct Node serving", async (t) => {
  for (const providerId of ["zetflixdb", "cdnvideohub", "hdvb"]) {
    const signed = [];
    const adapter = {
      async *discover() { yield candidate({ providerId, providerName: providerId }); },
      async resolve() { return { qualities: [
        { label: "1080p", height: 1080, url: "https://cdn.test/master.m3u8" },
        { label: "720p", height: 720, url: "https://cdn.test/lower.m3u8" },
      ] }; },
    };
    const media = makeMedia();
    media.url = (resource) => {
      signed.push(resource);
      return `https://media.test/v1/media?token=${resource.label}`;
    };
    const app = await start(adapter, media);
    t.after(() => app.close());
    const discovery = await post(app.base, "/v1/discover", { type: "movie", title: "Movie" });
    const reader = sseReader(discovery.body);
    const { data: { id } } = await reader.until("candidate");
    await reader.drain();
    assert.equal((await post(app.base, "/v1/resolve", { id })).status, 200);
    assert.equal(signed.length, 2);
    assert.deepEqual(signed.map((resource) => resource.nodeOnly), [providerId !== "hdvb", providerId !== "hdvb"]);
  }
});

test("automatic movie quality skips a short VOD without rejecting the full-length alternative", async (t) => {
  const adapter = {
    async *discover() { yield candidate(); },
    async resolve() { return { qualities: [
      { label: "720p", height: 720, url: "https://cdn.test/short.m3u8" },
      { label: "1080p", height: 1080, url: "https://cdn.test/full.m3u8" },
    ] }; },
  };
  const media = makeMedia();
  const probes = [];
  media.probe = async (quality) => {
    probes.push(quality.label);
    return { ok: true, kind: "hls", duration: quality.height === 720 ? 3652 : 8349 };
  };
  const app = await start(adapter, media);
  t.after(() => app.close());
  const discovery = await post(app.base, "/v1/discover", { type: "movie", title: "Fight Club", runtimeMinutes: 139 });
  const stream = sseReader(discovery.body);
  const { data: { id } } = await stream.until("candidate");
  await stream.drain();

  const automatic = await post(app.base, "/v1/resolve", { id });
  assert.equal(automatic.status, 200);
  assert.equal((await automatic.json()).selected.label, "1080p");
  assert.deepEqual(probes, ["720p", "1080p"]);

  probes.length = 0;
  const manual = await post(app.base, "/v1/resolve", { id, quality: "720p" });
  assert.equal(manual.status, 502);
  assert.equal((await manual.json()).error, "MEDIA_DURATION_MISMATCH");
  assert.deepEqual(probes, ["720p"], "manual quality must not silently switch");

  probes.length = 0;
  media.probe = async (quality) => {
    probes.push(quality.label);
    return { ok: quality.height === 720, kind: "hls", duration: 3652 };
  };
  const mixedFailure = await post(app.base, "/v1/resolve", { id });
  assert.equal(mixedFailure.status, 502);
  assert.equal((await mixedFailure.json()).error, "MEDIA_DURATION_MISMATCH");
  assert.deepEqual(probes, ["720p", "1080p"]);
});

test("movie runtime rejects grossly short HLS and accepts full length across sealed candidate resolves", async (t) => {
  let duration = 3652;
  let kind = "hls";
  let probeCalls = 0;
  const adapter = {
    async *discover() { yield candidate(); },
    async resolve() { return { qualities: [
      { label: "720p", height: 720, url: "https://cdn.test/movie-720.m3u8" },
      { label: "1080p", height: 1080, url: "https://cdn.test/movie-1080.m3u8" },
    ] }; },
  };
  const media = makeMedia();
  media.probe = async () => { probeCalls++; return { ok: true, kind, duration }; };
  const app = await start(adapter, media);
  t.after(() => app.close());

  for (const request of [
    { type: "movie", title: "Movie", runtimeMinutes: 0 },
    { type: "movie", title: "Movie", runtimeMinutes: 1441 },
    { type: "movie", title: "Movie", runtimeMinutes: 1.5 },
    { type: "tv", title: "Show", season: 1, episode: 1, runtimeMinutes: 45 },
  ]) {
    assert.equal((await post(app.base, "/v1/discover", request)).status, 400);
  }

  const discovery = await post(app.base, "/v1/discover", { type: "movie", title: "Fight Club", runtimeMinutes: 139 });
  const stream = sseReader(discovery.body);
  const { data: discovered } = await stream.until("candidate");
  await stream.drain();
  assert.equal(Object.hasOwn(discovered, "runtimeMinutes"), false);

  const short = await post(app.base, "/v1/resolve", { id: discovered.id });
  assert.equal(short.status, 502);
  assert.equal((await short.json()).error, "MEDIA_DURATION_MISMATCH");
  assert.equal(probeCalls, 2, "all automatic qualities must be checked before rejecting a short VOD");

  duration = null;
  const unknownLength = await post(app.base, "/v1/resolve", { id: discovered.id });
  assert.equal(unknownLength.status, 200, "unknown/live playlist duration keeps the prior behavior");

  kind = "file";
  duration = 1;
  const directFile = await post(app.base, "/v1/resolve", { id: discovered.id });
  assert.equal(directFile.status, 200, "direct files keep the prior behavior without an HLS duration");

  kind = "hls";
  duration = 8349;
  const fullLength = await post(app.base, "/v1/resolve", { id: discovered.id });
  assert.equal(fullLength.status, 200);
  assert.equal((await fullLength.json()).selected.label, "720p");
  assert.equal(probeCalls, 5);
});
