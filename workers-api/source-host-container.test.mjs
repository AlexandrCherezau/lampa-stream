import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const sourceUrl = new URL("./source-host-container.mjs", import.meta.url);
let moduleSequence = 0;

async function loadWorker({ startupTimeoutMs, healthTimeoutMs, pollIntervalMs } = {}) {
  let source = await readFile(sourceUrl, "utf8");
  const workerImport = 'import { DurableObject } from "cloudflare:workers";';
  assert.ok(source.includes(workerImport), "the Worker must use the native Cloudflare DurableObject import");
  source = source.replace(workerImport, "class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }");
  if (startupTimeoutMs !== undefined) source = source.replace("const STARTUP_TIMEOUT_MS = 30_000;", `const STARTUP_TIMEOUT_MS = ${startupTimeoutMs};`);
  if (healthTimeoutMs !== undefined) source = source.replace("const HEALTH_FETCH_TIMEOUT_MS = 1_500;", `const HEALTH_FETCH_TIMEOUT_MS = ${healthTimeoutMs};`);
  if (pollIntervalMs !== undefined) source = source.replace("const HEALTH_POLL_INTERVAL_MS = 250;", `const HEALTH_POLL_INTERVAL_MS = ${pollIntervalMs};`);
  const encoded = Buffer.from(source).toString("base64");
  return import(`data:text/javascript;base64,${encoded}#${moduleSequence++}`);
}

function environment(overrides = {}) {
  return {
    SOURCE_HOST_SECRET: "test-source-secret-value-with-more-than-32-bytes",
    SOURCE_API_KEY: "test-private-api-key",
    SOURCE_PUBLIC_ORIGIN: "https://sources.example.test/",
    ...overrides,
  };
}

function createRuntime({ running = false, health, forward } = {}) {
  const state = {
    running,
    startCalls: 0,
    startOptions: [],
    healthCalls: 0,
    forwarded: [],
    inactivity: [],
    ports: [],
  };
  const container = {
    get running() { return state.running; },
    set running(value) { state.running = value; },
    start(options) {
      state.startCalls++;
      state.startOptions.push(options);
      state.running = true;
    },
    async setInactivityTimeout(durationMs) { state.inactivity.push(durationMs); },
    getTcpPort(port) {
      state.ports.push(port);
      return {
        fetch: async (request) => {
          if (new URL(request.url).pathname === "/healthz") {
            state.healthCalls++;
            return health ? health(request, state) : new Response("ok");
          }
          state.forwarded.push(request);
          return forward ? forward(request, state) : new Response("forwarded");
        },
      };
    },
  };
  const ctx = {
    container,
    async blockConcurrencyWhile(callback) { await callback(); },
  };
  return { ctx, container, state };
}

test("validates required secrets and HTTPS origin before starting, without reflecting values", async () => {
  const { SourceHostContainer } = await loadWorker();
  for (const invalid of [
    environment({ SOURCE_HOST_SECRET: "short" }),
    environment({ SOURCE_API_KEY: "" }),
    environment({ SOURCE_PUBLIC_ORIGIN: "http://sources.example.test" }),
    environment({ SOURCE_PUBLIC_ORIGIN: "https://sources.example.test/path" }),
  ]) {
    const runtime = createRuntime();
    const object = new SourceHostContainer(runtime.ctx, invalid);
    const response = await object.fetch(new Request("https://worker.example.test/healthz"));
    assert.equal(response.status, 503);
    assert.doesNotMatch(await response.text(), /test-source-secret|test-private-api-key|short/);
    assert.equal(runtime.state.startCalls, 0);
    assert.equal(runtime.state.healthCalls, 0);
  }
});

test("coalesces cold starts, preserves the original range request and streams its response, then reuses and restarts", async () => {
  const { SourceHostContainer } = await loadWorker();
  let releaseHealth;
  const healthGate = new Promise((resolve) => { releaseHealth = resolve; });
  const runtime = createRuntime({
    health: async () => { await healthGate; return new Response("ready"); },
    forward: async (request) => {
      if (new URL(request.url).pathname === "/v1/media")
        assert.equal(request.headers.get("range"), "bytes=4096-8191");
      return new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode("chunk-one"));
          controller.enqueue(new TextEncoder().encode("chunk-two"));
          controller.close();
        },
      }), { status: 206, headers: { "content-range": "bytes 4096-4113/9000", "content-type": "video/mp4" } });
    },
  });
  const object = new SourceHostContainer(runtime.ctx, environment());
  const firstRequest = new Request("https://worker.example.test/v1/media?token=opaque", { headers: { range: "bytes=4096-8191" } });
  const secondRequest = new Request("https://worker.example.test/v1/media?token=opaque", { headers: { range: "bytes=4096-8191" } });
  const first = object.fetch(firstRequest);
  const second = object.fetch(secondRequest);
  for (let attempt = 0; attempt < 40 && runtime.state.healthCalls === 0; attempt++) await new Promise((resolve) => setTimeout(resolve, 1));
  assert.equal(runtime.state.startCalls, 1);
  assert.equal(runtime.state.healthCalls, 1);
  releaseHealth();
  const [responseA, responseB] = await Promise.all([first, second]);
  assert.equal(responseA.status, 206);
  assert.equal(responseB.headers.get("content-range"), "bytes 4096-4113/9000");
  assert.equal(await responseA.text(), "chunk-onechunk-two");
  assert.equal(await responseB.text(), "chunk-onechunk-two");
  assert.equal(runtime.state.forwarded[0], firstRequest);
  assert.equal(runtime.state.forwarded[1], secondRequest);
  assert.equal(runtime.state.startOptions[0].enableInternet, true);
  assert.deepEqual(Object.keys(runtime.state.startOptions[0].env).sort(), ["SOURCE_API_KEY", "SOURCE_HOST_SECRET", "SOURCE_PUBLIC_ORIGIN"]);
  assert.equal(runtime.state.startOptions[0].env.SOURCE_PUBLIC_ORIGIN, "https://sources.example.test");
  assert.equal(runtime.state.inactivity[0], 10 * 60 * 1000);
  assert.ok(runtime.state.ports.every((port) => port === 9120));

  const warm = await object.fetch(new Request("https://worker.example.test/v1/providers"));
  assert.equal(await warm.text(), "chunk-onechunk-two");
  assert.equal(runtime.state.healthCalls, 1, "warmed media requests should not poll health every time");

  runtime.container.running = false;
  const restarted = await object.fetch(new Request("https://worker.example.test/v1/providers"));
  assert.equal(restarted.status, 206);
  assert.equal(runtime.state.startCalls, 2);
  assert.equal(runtime.state.healthCalls, 2);
});

test("constructor restores inactivity timeout for a running container", async () => {
  const { SourceHostContainer } = await loadWorker();
  const runtime = createRuntime({ running: true });
  new SourceHostContainer(runtime.ctx, environment());
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(runtime.state.inactivity, [10 * 60 * 1000]);
});

test("forward errors invalidate health state and return a generic response", async () => {
  const { SourceHostContainer } = await loadWorker();
  let failForward = false;
  const runtime = createRuntime({
    forward: async () => {
      if (failForward) throw new Error("private upstream failure detail");
      return new Response("ok");
    },
  });
  const object = new SourceHostContainer(runtime.ctx, environment());
  assert.equal((await object.fetch(new Request("https://worker.example.test/v1/providers"))).status, 200);
  failForward = true;
  const failed = await object.fetch(new Request("https://worker.example.test/v1/media"));
  assert.equal(failed.status, 503);
  assert.doesNotMatch(await failed.text(), /private upstream failure detail/);
  failForward = false;
  assert.equal((await object.fetch(new Request("https://worker.example.test/v1/providers"))).status, 200);
  assert.equal(runtime.state.healthCalls, 2, "a forwarding error must force a fresh readiness check");
});

test("health-fetch abort is bounded, failed initialization clears its promise, and the next request retries", async () => {
  const { SourceHostContainer } = await loadWorker({ startupTimeoutMs: 60, healthTimeoutMs: 10, pollIntervalMs: 2 });
  let ready = false;
  const runtime = createRuntime({
    health: async (request, state) => {
      if (ready) return new Response("ready");
      if (state.healthCalls === 1) {
        return new Promise((_resolve, reject) => request.signal.addEventListener("abort", () => reject(new Error("fetch timed out")), { once: true }));
      }
      return new Response("not ready", { status: 503 });
    },
  });
  const object = new SourceHostContainer(runtime.ctx, environment());
  const timedOut = await object.fetch(new Request("https://worker.example.test/v1/providers"));
  assert.equal(timedOut.status, 503);
  assert.ok(runtime.state.healthCalls > 1);
  assert.equal(object.initializationPromise, null);
  ready = true;
  const retry = await object.fetch(new Request("https://worker.example.test/v1/providers"));
  assert.equal(retry.status, 200);
  assert.equal(runtime.state.startCalls, 1, "the same running container is health-probed again without duplicate start");
});

test("Worker routes through one named Durable Object and forwards the exact Request", async () => {
  const { default: worker } = await loadWorker();
  const request = new Request("https://worker.example.test/v1/discover");
  let name;
  let forwarded;
  const response = new Response("ok", { status: 202 });
  const result = await worker.fetch(request, {
    SOURCE_HOST: { getByName(value) { name = value; return { fetch(input) { forwarded = input; return response; } }; } },
  });
  assert.equal(name, "source-host");
  assert.equal(forwarded, request);
  assert.equal(result, response);
});

test("container config resolves its root-context Dockerfile and exposes one secret-free singleton binding", async () => {
  const configUrl = new URL("./source-host-container.wrangler.json", import.meta.url);
  assert.ok(existsSync(configUrl), "the Durable Object Wrangler config must be present next to this Worker");
  const config = JSON.parse(await readFile(configUrl, "utf8"));
  const configDir = dirname(fileURLToPath(configUrl));
  const root = resolve(configDir, "..");
  assert.equal(config.main, "source-host-container.mjs");
  assert.equal(config.containers.length, 1);
  assert.equal(config.containers[0].class_name, "SourceHostContainer");
  assert.equal(config.containers[0].max_instances, 1);
  assert.equal(resolve(configDir, config.containers[0].image_build_context), root);
  assert.ok(existsSync(resolve(configDir, config.containers[0].image)), "configured container Dockerfile must resolve from the config directory");
  assert.deepEqual(config.durable_objects.bindings, [{ name: "SOURCE_HOST", class_name: "SourceHostContainer" }]);
  assert.equal(config.exports.SourceHostContainer.type, "durable-object");
  assert.equal(Object.hasOwn(config.vars || {}, "SOURCE_HOST_SECRET"), false);
  assert.equal(Object.hasOwn(config.vars || {}, "SOURCE_API_KEY"), false);
  assert.equal(Object.hasOwn(config.vars || {}, "SOURCE_MEDIA_RELAY_URL"), false);

  const dockerfile = await readFile(resolve(configDir, config.containers[0].image), "utf8");
  assert.match(dockerfile, /COPY source-host\/ \/app\//);
  assert.match(dockerfile, /SOURCE_ENGINE_URL/);

  const dockerignore = await readFile(`${resolve(configDir, config.containers[0].image)}.dockerignore`, "utf8");
  assert.match(dockerignore, /^\*\*/m, "the build context should be deny-by-default");
  for (const required of [
    "!source-host/", "!source-host/*.mjs", "!source-host/providers/", "!source-host/providers/*.mjs",
    "!infrastructure/lampac/Dockerfile.vercel", "!infrastructure/lampac/start-vercel.sh",
    "!infrastructure/lampac/config/vercel.init.conf",
  ]) assert.ok(dockerignore.split(/\r?\n/).includes(required), `Docker context must include ${required}`);
  assert.doesNotMatch(dockerignore, /^!(?:\.env|.*\.env|.*secret.*)$/m, "secret files must stay excluded from the build context");
});

test("POST body reaches the container through the original Request without worker-side parsing", async () => {
  const { SourceHostContainer } = await loadWorker();
  let receivedRequest;
  const runtime = createRuntime({
    forward: async (request) => {
      receivedRequest = request;
      assert.deepEqual(await request.json(), { title: "Fight Club", year: 1999 });
      return new Response("accepted", { status: 201 });
    },
  });
  const object = new SourceHostContainer(runtime.ctx, environment());
  const request = new Request("https://worker.example.test/v1/resolve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Fight Club", year: 1999 }),
  });
  const response = await object.fetch(request);
  assert.equal(receivedRequest, request);
  assert.equal(response.status, 201);
  assert.equal(await response.text(), "accepted");
});
