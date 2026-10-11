import assert from "node:assert/strict";
import dns from "node:dns/promises";
import { readFileSync } from "node:fs";
import { Readable } from "node:stream";
import vm from "node:vm";
import net from "node:net";
import handler from "../api/lampac.js";

const lookup = dns.lookup;
const fetch = globalThis.fetch;
let lookupStarted = false;
let statusCode;
let body;
dns.lookup = () => {
  lookupStarted = true;
  return new Promise(() => {});
};
globalThis.fetch = () => new Promise(() => {});

const res = {
  setHeader() {},
  status(code) { statusCode = code; return this; },
  json(value) { body = value; return this; },
};
const target = Buffer.from("https://dns-timeout.invalid/lite/events").toString("base64url");
const started = Date.now();
try {
  await handler({ method: "GET", url: `/api/lampac?u=${target}`, headers: {} }, res);
} finally {
  dns.lookup = lookup;
  globalThis.fetch = fetch;
}

assert.equal(lookupStarted, true, "relay should resolve the target hostname");
assert.equal(statusCode, 502, "a stalled DNS lookup should fail as an upstream error");
assert.equal(body?.error, "upstream");
assert.ok(Date.now() - started < 6500, "relay must return before Vercel's request deadline");
console.log("lampac relay DNS timeout check passed");

const source = readFileSync(new URL("../api/lampac.js", import.meta.url), "utf8");
const bodyHelpers = source.slice(source.indexOf("function readAll("), source.indexOf("// Rewrites an m3u8 body"));
const { readAll, peekHead } = vm.runInNewContext(`${bodyHelpers}; ({readAll, peekHead})`, { Buffer });
for (const text of ["catalog", "results", "", JSON.stringify({type: "movie", data: []}), JSON.stringify({type: "season", data: "x".repeat(500)})]) {
  const stream = Readable.from([Buffer.from(text.slice(0, 80)), Buffer.from(text.slice(80))]);
  const head = await peekHead(stream, 64, 1024);
  const remaining = readAll(stream, 1024 - head.length);
  stream.resume();
  const tail = await Promise.race([remaining, new Promise((_, reject) => setTimeout(() => reject(new Error("finished body hung")), 100))]);
  assert.equal(Buffer.concat([head, tail]).toString(), text);
}
console.log("lampac complete short body checks passed");

const addressHelpers = source.slice(source.indexOf("function isPublicIp("), source.indexOf("function hmacKey("));
let dnsCalls = 0;
const {resolveTarget} = vm.runInNewContext(`${addressHelpers}; ({resolveTarget})`, {
  net, hostsCache: {list: ["138-16-177-21.nip.io", "127-0-0-1.nip.io", "999-0-0-1.nip.io"]},
  dns: {lookup() { dnsCalls++; throw new Error("unexpected DNS"); }},
  setTimeout, clearTimeout, DNS_TIMEOUT_MS: 10,
});
const pinned = await resolveTarget(new URL("https://138-16-177-21.nip.io/lite/events"));
assert.equal(pinned.ip, "138.16.177.21");
assert.equal(pinned.family, 4);
await assert.rejects(resolveTarget(new URL("https://127-0-0-1.nip.io")), /blocked address/);
await assert.rejects(resolveTarget(new URL("https://999-0-0-1.nip.io")), /blocked address/);
assert.equal(dnsCalls, 0, "fleet IP pinning must not wait on external DNS");
console.log("lampac fleet address pinning checks passed");
