import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import test from "node:test";
import { mkdtemp, writeFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSourceServer, validateTitle } from "../server.mjs";
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
  const health = await fetch(app.base + "/healthz");
  const instanceId = health.headers.get("x-source-instance");
  assert.match(instanceId, /^[a-f0-9-]{36}$/);
  assert.equal((await health.json()).engineReady, false);
  const immediateMedia = await fetch(app.base + "/v1/media?token=test");
  assert.equal(immediateMedia.status, 204);
  assert.equal(immediateMedia.headers.get("x-source-instance"), instanceId);
  await assert.rejects(stat(engineReadyFile + ".start"), { code: "ENOENT" });
  const pending = post(app.base, "/v1/discover", { type: "movie", title: "Movie" });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(discovered, false);
  assert.equal((await stat(engineReadyFile + ".start")).mode & 0o777, 0o600);
  assert.equal((await fetch(app.base + "/v1/media?token=test")).status, 204);
  await writeFile(engineReadyFile, "ready");
  const response = await pending;
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-source-instance"), instanceId);
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

test("sealed native and vi provider namespaces preserve Node quality routing and public restrictions", async (t) => {
  const scenarios = [undefined, "vi3000"].flatMap((catalogSource) => ["zetflixdb", "cdnvideohub", "hdvb"].map((id) => ({
    providerId: catalogSource ? `vi3000:${id}` : id, catalogSource, expected: id !== "hdvb",
  })));
  scenarios.push({ providerId: "vi3000:cdnvideohub", expected: false },
    { providerId: "vi3000:cdnvideohub:extra", catalogSource: "vi3000", expected: false });
  scenarios.push(...[undefined, "vi3000"].flatMap((catalogSource) => ["file", "hls"].map((kind) => ({
    providerId: catalogSource ? "vi3000:filmix" : "filmix", catalogSource, kind, expected: catalogSource === "vi3000" && kind === "file",
  }))));
  scenarios.push({ providerId: "vi3000:filmix", kind: "file", expected: false },
    { providerId: "vi3000:filmix:extra", catalogSource: "vi3000", kind: "file", expected: false });
  for (const { providerId, catalogSource, expected, kind = "hls" } of scenarios) {
    const signed = [];
    const extension = kind === "file" ? "mp4" : "m3u8";
    const adapter = {
      async *discover() { yield candidate({ providerId, providerName: providerId, catalogSource }); },
      async resolve() { return { qualities: [
        { label: "1080p", height: 1080, url: `https://cdn.test/master.${extension}`, publicOnly: catalogSource === "vi3000" },
        { label: "720p", height: 720, url: `https://cdn.test/lower.${extension}`, publicOnly: catalogSource === "vi3000" },
      ] }; },
    };
    const media = createMedia({ transport: { async request() { throw new Error("unused"); } },
      secret: "test-secret-that-is-long-enough-for-this-suite", publicOrigin: "https://media.test" });
    media.probe = async (quality) => {
      assert.equal(quality.publicOnly, catalogSource === "vi3000");
      return { ok: true, kind, url: `https://cdn.test/verified.${extension}`, publicOnly: false, nodeOnly: false };
    };
    const sign = media.url;
    media.url = (resource) => {
      signed.push(resource);
      return sign(resource);
    };
    const app = await start(adapter, media, "", undefined, { viAdapter: adapter });
    t.after(() => app.close());
    const discovery = await post(app.base, "/v1/discover", { type: "movie", title: "Movie", catalogSource });
    const reader = sseReader(discovery.body);
    const { data: { id } } = await reader.until("candidate");
    await reader.drain();
    const resolved = await post(app.base, "/v1/resolve", { id, catalogSource: catalogSource ? "native" : "vi3000", providerId: "vi3000:filmix", nodeOnly: !expected,
      kind: kind === "file" ? "hls" : "file" });
    assert.equal(resolved.status, 200);
    const result = await resolved.json();
    assert.equal(result.kind, kind, "routing uses the actual probe kind rather than client input");
    assert.equal(signed.length, 2);
    assert.deepEqual(signed.map((resource) => resource.nodeOnly), [expected, expected], providerId);
    for (const quality of result.qualities) {
      const resource = media.resource(new URL(quality.url).searchParams.get("token"));
      assert.equal(resource.nodeOnly, expected, `${providerId} retains routing in every sealed quality`);
      assert.equal(resource.publicOnly, catalogSource === "vi3000", `${providerId} keeps its public DNS restriction`);
    }
    assert.equal(signed[1].url, `https://cdn.test/verified.${extension}`, "the selected redirected quality keeps both flags");
    assert.equal(signed[0].url, `https://cdn.test/master.${extension}`, "unselected qualities inherit the same routing policy");
  }
});

test("CUB vi titles and sealed sources use the remote plane after restart without waiting for the native engine", async (t) => {
  assert.equal(validateTitle({ type: "movie", title: "Movie", catalogSource: "vi3000" }).catalogSource, "vi3000");
  for (const catalogSource of [null, "native", "https://arbitrary.test", false]) {
    assert.throws(() => validateTitle({ type: "movie", title: "Movie", catalogSource }), /источник каталога/);
  }
  const directory = await mkdtemp(join(tmpdir(), "vi-plane-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ready = join(directory, "ready");
  let nativeCalls = 0;
  let viResolutions = 0;
  const adapter = {
    async *discover() { nativeCalls++; throw new Error("native adapter must not handle CUB cards"); },
    async resolve() { nativeCalls++; throw new Error("native adapter must not resolve vi sources"); },
  };
  const viAdapter = {
    async *discover(title) {
      assert.equal(title.catalogSource, "vi3000");
      yield candidate({ providerId: "vi3000:filmix", providerName: "vi3000 · Filmix", catalogSource: "vi3000",
        ref: { origin: "https://api-m.vi3000.top", url: "https://cdn.test/movie.mp4" } });
    },
    async resolve(value) {
      viResolutions++;
      assert.equal(value.catalogSource, "vi3000");
      assert.equal(value.providerId, "vi3000:filmix");
      assert.equal(value.ref.origin, "https://api-m.vi3000.top");
      return { qualities: [{ label: "720p", height: 720, url: "https://cdn.test/movie.mp4", publicOnly: true }],
        subtitles: [{ label: "Russian", language: "ru", url: "https://cdn.test/ru.vtt", publicOnly: true }] };
    },
  };
  const media = makeMedia();
  media.probe = async (quality) => { assert.equal(quality.publicOnly, true); return { ok: true, kind: "file" }; };
  const signed = [];
  media.url = (resource) => { signed.push(resource); return "https://media.test/v1/media?token=sealed"; };
  let id;
  const first = await start(adapter, media, "", undefined, { viAdapter, engineReadyFile: ready });
  try {
    const discovery = await fetch(`${first.base}/v1/discover`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "movie", title: "Movie", tmdbId: 120, catalogSource: "vi3000" }),
      signal: AbortSignal.timeout(1000),
    });
    assert.equal(discovery.status, 200);
    const reader = sseReader(discovery.body);
    const frame = await reader.until("candidate");
    assert.equal(frame.data.catalogSource, "vi3000");
    id = frame.data.id;
    await reader.drain();
  } finally { await first.close(); }
  const second = await start(adapter, media, "", undefined, { viAdapter, engineReadyFile: ready });
  t.after(() => second.close());
  const resolved = await fetch(`${second.base}/v1/resolve`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, catalogSource: "native" }), signal: AbortSignal.timeout(1000),
  });
  assert.equal(resolved.status, 200);
  assert.equal((await resolved.json()).source.catalogSource, "vi3000");
  assert.equal(viResolutions, 1);
  assert.equal(nativeCalls, 0);
  assert.deepEqual(signed.map((resource) => resource.publicOnly), [true, true]);
  await assert.rejects(stat(`${ready}.start`), { code: "ENOENT" });
});

test("Habster sealed sources survive restart, skip the engine and keep direct public-only delivery", async (t) => {
  assert.equal(validateTitle({ type: "movie", title: "Movie", catalogSource: "habster" }).catalogSource, "habster");
  const directory = await mkdtemp(join(tmpdir(), "habster-plane-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ready = join(directory, "ready");
  const adapter = {
    async *discover() { throw new Error("Wrong native adapter"); },
    async resolve() { throw new Error("Wrong native adapter"); },
  };
  const habsterAdapter = {
    async *discover(title) {
      assert.equal(title.kinopoiskId, 328);
      yield candidate({ providerId: "habster:collaps", catalogSource: "habster", season: null, episode: null,
        ref: { type: "movie", kinopoiskId: 328 } });
    },
    async resolve(value) {
      assert.deepEqual(value.ref, { type: "movie", kinopoiskId: 328 });
      return { audioNames: ["Рус. Дублированный", "English"], qualities: [{ label: "Auto", url: "https://cdn.test/movie.m3u8", publicOnly: true }],
        subtitles: [{ label: "RU", url: "https://cdn.test/ru.vtt", publicOnly: true }] };
    },
  };
  const signed = [];
  const viAdapter = { async *discover(title) { assert.equal(title.catalogSource, "vi3000"); }, async resolve() { throw new Error("Wrong vi adapter"); } };
  const media = makeMedia();
  media.probe = async (resource) => {
    assert.equal(resource.publicOnly, true);
    return { ok: true, kind: "hls", duration: 10_000, publicOnly: false, nodeOnly: false };
  };
  media.url = (resource) => { signed.push(resource); return "https://media.test/v1/media?token=sealed"; };
  let id;
  const first = await start(adapter, media, "", undefined, { habsterAdapter, viAdapter, engineReadyFile: ready });
  try {
    const discovery = await post(first.base, "/v1/discover", { type: "movie", title: "Movie", kinopoiskId: 328, catalogSource: "habster" });
    const stream = sseReader(discovery.body);
    const frame = await stream.until("candidate");
    assert.equal(frame.data.catalogSource, "habster");
    assert.equal(JSON.stringify(frame.data).includes("kinopoiskId"), false);
    id = frame.data.id;
    await stream.drain();
  } finally { await first.close(); }
  const second = await start(adapter, media, "", undefined, { habsterAdapter, viAdapter, engineReadyFile: ready });
  t.after(() => second.close());
  const resolved = await post(second.base, "/v1/resolve", { id, catalogSource: "vi3000", nodeOnly: false, publicOnly: false });
  assert.equal(resolved.status, 200);
  const result = await resolved.json();
  assert.equal(result.source.catalogSource, "habster");
  assert.deepEqual(result.audioNames, ["Рус. Дублированный", "English"]);
  assert.deepEqual(signed.map((resource) => resource.publicOnly), [true, true]);
  assert.deepEqual(signed.map((resource) => resource.nodeOnly), [true, true]);
  await assert.rejects(stat(`${ready}.start`), { code: "ENOENT" });
});

test("Habster emits first before a cold native engine, then streams the original fleet without changing sealed provenance", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "habster-first-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const type of ["movie", "tv"]) {
    const ready = join(directory, type);
    const coords = type === "tv" ? { season: 2, episode: 3 } : { season: null, episode: null };
    let nativeCalls = 0;
    const habsterAdapter = {
      async *discover(title) {
        assert.equal(title.kinopoiskId, 5494049);
        assert.equal(title.type, type);
        if (type === "tv") assert.deepEqual([title.season, title.episode], [2, 3]);
        yield candidate({ providerId: "habster:collaps", catalogSource: "habster", ...coords,
          ref: { type, kinopoiskId: title.kinopoiskId, ...(type === "tv" ? coords : {}) } });
      },
      async resolve(value) {
        assert.equal(value.catalogSource, "habster");
        return { qualities: [{ label: "Auto", type: "hls", url: "https://cdn.test/first.m3u8", publicOnly: true }] };
      },
    };
    const adapter = { async *discover(title) {
      nativeCalls++;
      assert.equal(title.catalogSource, undefined);
      yield candidate({ ...coords });
    } };
    const app = await start(adapter, makeMedia(), "", undefined, { habsterAdapter, engineReadyFile: ready });
    try {
      const response = await fetch(app.base + "/v1/discover", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ type, title: "Movie", kinopoiskId: 5494049, ...(type === "tv" ? coords : {}) }), signal: AbortSignal.timeout(1500) });
      const stream = sseReader(response.body);
      const first = await stream.until("candidate");
      assert.equal(first.data.providerId, "habster:collaps");
      assert.equal(nativeCalls, 0);
      assert.equal((await post(app.base, "/v1/resolve", { id: first.data.id, catalogSource: "vi3000" })).status, 200);
      await writeFile(ready, "ready");
      await stream.drain();
      assert.deepEqual(stream.frames.filter((frame) => frame.event === "candidate").map((frame) => frame.data.providerId), ["habster:collaps", "hdvb"]);
      assert.equal(stream.frames.find((frame) => frame.event === "done").data.complete, true);
    } finally { await app.close(); }
  }
});

test("Habster failures fall back, missing KP skips Habster, and catalog fallback keeps the public vi plane", async (t) => {
  for (const catalogSource of [undefined, "vi3000", "habster"]) for (const kinopoiskId of [undefined, 5494049]) {
    let habsterCalls = 0;
    const fleet = { async *discover(title) {
      assert.equal(title.catalogSource, catalogSource === "habster" ? "vi3000" : catalogSource);
      yield candidate({ providerId: catalogSource ? "vi3000:cdnvideohub" : "hdvb", catalogSource: catalogSource ? "vi3000" : undefined });
    } };
    const app = await start(fleet, makeMedia(), "", undefined, { viAdapter: fleet, habsterAdapter: { async *discover() {
      habsterCalls++;
      throw new Error("upstream URL with private details must not leak");
    } } });
    try {
      const response = await post(app.base, "/v1/discover", { type: "movie", title: "Movie", catalogSource, kinopoiskId });
      const text = await response.text();
      assert.match(text, /event: candidate/);
      assert.equal(habsterCalls, kinopoiskId ? 1 : 0);
      assert.equal(text.includes("private details"), false);
      assert.equal(text.includes('"providerId":"habster:collaps","providerName":"Habster · Collaps","status":"unavailable"'), Boolean(kinopoiskId));
      assert.match(text, /"complete":true/);
    } finally { await app.close(); }
  }
});

test("Habster resolve has an eight-second budget while disconnect aborts background discovery", async (t) => {
  let discoveryAborted = false;
  let resolveAborted = false;
  const habsterAdapter = {
    async *discover() { yield candidate({ providerId: "habster:collaps", catalogSource: "habster", season: null, episode: null }); },
    async resolve(_candidate, { signal }) {
      await new Promise((_resolve, reject) => signal.addEventListener("abort", () => { resolveAborted = true; reject(signal.reason); }, { once: true }));
    },
  };
  const app = await start({ async *discover(_title, { signal }) {
    await new Promise((_resolve, reject) => signal.addEventListener("abort", () => { discoveryAborted = true; reject(signal.reason); }, { once: true }));
  } }, makeMedia(), "", undefined, { habsterAdapter });
  t.after(() => app.close());
  const response = await post(app.base, "/v1/discover", { type: "movie", title: "Movie", kinopoiskId: 5494049 });
  const stream = sseReader(response.body);
  const first = await stream.until("candidate");
  const before = Date.now();
  const resolved = await post(app.base, "/v1/resolve", { id: first.data.id });
  assert.equal(resolved.status, 504);
  assert.equal((await resolved.json()).error, "TIMEOUT");
  assert(resolveAborted);
  assert(Date.now() - before < 9500, "Habster failure must not consume the native 45-second resolution budget");
  await stream.cancel();
  for (let i = 0; i < 50 && !discoveryAborted; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert(discoveryAborted);
});

test("a background fleet failure preserves an already emitted and resolvable Habster source", async (t) => {
  const habsterAdapter = {
    async *discover() { yield candidate({ providerId: "habster:collaps", catalogSource: "habster", season: null, episode: null }); },
    async resolve() { return { qualities: [{ label: "Auto", type: "hls", url: "https://cdn.test/first.m3u8", publicOnly: true }] }; },
  };
  const app = await start({ async *discover() { throw new Error("native failed"); } }, makeMedia(), "", undefined, { habsterAdapter });
  t.after(() => app.close());
  const response = await post(app.base, "/v1/discover", { type: "movie", title: "Movie", kinopoiskId: 5494049 });
  const stream = sseReader(response.body);
  const first = await stream.until("candidate");
  await stream.drain();
  assert.equal(first.data.providerId, "habster:collaps");
  assert.equal(stream.frames.find((frame) => frame.event === "done").data.complete, false);
  assert.equal((await post(app.base, "/v1/resolve", { id: first.data.id })).status, 200);
});

test("only sealed Zetflix movie candidates use Node media routing", async (t) => {
  for (const catalogSource of [undefined, "vi3000"]) for (const scenario of [
    { name: "movie", candidateFields: { season: undefined, episode: undefined }, discoverType: "movie", expected: true,
      spoof: { type: "tv", season: 1, episode: 14 } },
    { name: "series", candidateFields: { season: 1, episode: 14 }, discoverType: "tv", expected: false,
      spoof: { type: "movie", season: null, episode: null } },
  ]) {
    const signed = [];
    const adapter = {
      async *discover() {
        yield candidate({ providerId: catalogSource ? "vi3000:zetflix" : "zetflix", providerName: "Zetflix", catalogSource, ...scenario.candidateFields });
      },
      async resolve() {
        return { qualities: [
          { label: "1080p", height: 1080, url: "https://cdn.test/master.m3u8", publicOnly: catalogSource === "vi3000" },
          { label: "720p", height: 720, url: "https://cdn.test/lower.m3u8", publicOnly: catalogSource === "vi3000" },
        ] };
      },
    };
    const media = makeMedia();
    media.url = (resource) => {
      signed.push(resource);
      return `https://media.test/v1/media?token=${resource.label}`;
    };
    const app = await start(adapter, media, "", undefined, { viAdapter: adapter });
    t.after(() => app.close());
    const discovery = await post(app.base, "/v1/discover", {
      type: scenario.discoverType,
      title: "Movie or show",
      catalogSource,
      ...(scenario.discoverType === "tv" ? { season: 1, episode: 14 } : {}),
    });
    const reader = sseReader(discovery.body);
    const { data: { id } } = await reader.until("candidate");
    await reader.drain();
    const result = await (await post(app.base, "/v1/resolve", { id, ...scenario.spoof, catalogSource: catalogSource ? "native" : "vi3000", providerId: "vi3000:cdnvideohub" })).json();
    assert.equal(result.qualities.length, 2, `${scenario.name} should retain every quality`);
    assert.deepEqual(signed.map((resource) => resource.nodeOnly), [scenario.expected, scenario.expected],
      `routing must use sealed ${scenario.name} metadata, not resolve request fields`);
    assert.deepEqual(signed.map((resource) => resource.publicOnly), [catalogSource === "vi3000", catalogSource === "vi3000"]);
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
