import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import express from "express";
import compression from "compression";
import handler from "../api/source-host.js";

const previous = { url: process.env.SOURCE_HOST_URL, key: process.env.SOURCE_API_KEY };
let upstreamEnded = false;
let completion;
let acknowledge;
let upstreamTimer;
const source = http.createServer((req, res) => {
  if (req.url === "/v1/providers") {
    res.writeHead(200, { "content-type": "application/json" }).end('{"providers":[]}');
    return;
  }
  assert.equal(req.url, "/v1/discover");
  assert.equal(req.method, "POST");
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
  res.flushHeaders();
  res.write('event: candidate\ndata: {"id":"fixture","providerId":"fixture","voiceName":"Original"}\n\n');
  const finish = (reason) => {
    if (upstreamEnded) return;
    clearTimeout(upstreamTimer);
    upstreamEnded = true;
    completion = reason;
    res.end('event: done\ndata: {"candidates":1,"complete":true}\n\n');
  };
  acknowledge = () => finish("client-ack");
  upstreamTimer = setTimeout(() => finish("bounded-deadline"), 1200);
  res.once("close", () => clearTimeout(upstreamTimer));
});
const app = express();
app.use(compression({
  threshold: 1024,
  filter: (req, res) => {
    const type = res.getHeader("Content-Type");
    if (typeof type === "string" && /^(image|video|audio|font)\//.test(type)) return false;
    return compression.filter(req, res);
  },
}));
app.use(express.json());
app.all("/api/source-host", (req, res) => handler(req, res).catch(() => res.destroy()));
const gateway = http.createServer(app);
const caller = new AbortController();
let reader;
async function listen(server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}
async function close(server) {
  if (!server.listening) return;
  server.closeAllConnections();
  server.close();
  await once(server, "close");
}

try {
  process.env.SOURCE_HOST_URL = await listen(source);
  process.env.SOURCE_API_KEY = "gateway-fixture-key";
  const origin = await listen(gateway);
  const started = Date.now();
  const response = await fetch(`${origin}/api/source-host?op=discover`, {
    method: "POST", headers: { "content-type": "application/json", "accept-encoding": "gzip" },
    body: JSON.stringify({ type: "movie", title: "Fixture" }), signal: AbortSignal.any([caller.signal, AbortSignal.timeout(4000)]),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/event-stream/);
  reader = response.body.getReader();
  const decoder = new TextDecoder();
  let body = "";
  while (!body.includes("\n\n")) {
    const part = await reader.read();
    assert.equal(part.done, false, "the candidate frame must arrive");
    body += decoder.decode(part.value, { stream: true });
  }
  assert.match(body, /event: candidate\ndata: /);
  const firstCandidateMs = Date.now() - started;
  assert.equal(upstreamEnded, false, "first source candidate must reach the gzip-accepting client before upstream ends");
  assert.equal(response.headers.get("content-encoding"), null, "SSE must bypass compression buffering");
  assert.equal(response.headers.get("cache-control"), "no-store, no-transform");
  acknowledge();
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    body += decoder.decode(part.value, { stream: true });
  }
  assert.match(body, /event: done/);
  assert.equal(completion, "client-ack", "upstream ends only after the client acknowledges progress");
  const providers = await fetch(`${origin}/api/source-host?op=providers`);
  assert.equal(providers.headers.get("cache-control"), "no-store", "ordinary JSON cache behavior stays unchanged");
  assert.deepEqual(await providers.json(), { providers: [] });
  console.log(`Source gateway SSE progresses through real Express/compression before upstream completion (${firstCandidateMs} ms)`);
} finally {
  acknowledge?.();
  caller.abort();
  await reader?.cancel().catch(() => {});
  await close(gateway);
  await close(source);
  if (previous.url === undefined) delete process.env.SOURCE_HOST_URL; else process.env.SOURCE_HOST_URL = previous.url;
  if (previous.key === undefined) delete process.env.SOURCE_API_KEY; else process.env.SOURCE_API_KEY = previous.key;
}
