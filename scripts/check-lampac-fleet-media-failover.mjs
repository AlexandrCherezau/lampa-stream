import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import https from "node:https";

const originalRequest = https.request;
const attempts = [];
let scenario = "success";
https.request = (options, callback) => {
  const req = new EventEmitter();
  req.destroy = (error) => req.emit("error", error);
  req.end = () => {
    attempts.push(options);
    const host = options.hostname;
    if (scenario === "middle-timeout" && host === "62-113-116-188.nip.io") {
      setImmediate(() => req.emit("error", Object.assign(new Error("ETIMEDOUT"), { code: "ETIMEDOUT" })));
      return;
    }
    if (scenario === "all-timeout" && host !== "138-16-177-21.nip.io") {
      setImmediate(() => req.emit("error", Object.assign(new Error(`timeout at ${host}`), { code: "ETIMEDOUT" })));
      return;
    }
    const statusCode = host === "138-16-177-21.nip.io" ? 503 : 206;
    const response = new EventEmitter();
    response.statusCode = statusCode;
    response.headers = { "content-type": "video/mp4" };
    response.resume = () => {};
    setImmediate(() => callback(response));
  };
  return req;
};

try {
  const { openUpstream } = await import("../api/lampac.js");
  const target = new URL("https://138-16-177-21.nip.io/lite/animevost/video?id=abc&play=true&title=episode");
  const { res, finalUrl } = await openUpstream(target, { range: "bytes=0-32767" }, "GET");

  assert.equal(res.statusCode, 206);
  assert.equal(finalUrl.hostname, "62-113-116-188.nip.io");
  assert.deepEqual(attempts.map((request) => request.hostname), [
    "138-16-177-21.nip.io",
    "62-113-116-188.nip.io",
  ]);
  assert.deepEqual(attempts.map((request) => request.servername), [
    "138-16-177-21.nip.io",
    "62-113-116-188.nip.io",
  ]);
  assert.deepEqual(attempts.map((request) => request.lookup("unused", {}, (error, ip, family) => ({ error, ip, family }))), [
    { error: null, ip: "138.16.177.21", family: 4 },
    { error: null, ip: "62.113.116.188", family: 4 },
  ]);
  assert.equal(attempts[1].path, "/lite/animevost/video?id=abc&play=true&title=episode");

  attempts.length = 0;
  scenario = "middle-timeout";
  const recovered = await openUpstream(target, { range: "bytes=0-32767" }, "GET");
  assert.equal(recovered.res.statusCode, 206);
  assert.equal(recovered.finalUrl.hostname, "138-16-174-90.nip.io");
  assert.deepEqual(attempts.map((request) => request.hostname), [
    "138-16-177-21.nip.io",
    "62-113-116-188.nip.io",
    "138-16-174-90.nip.io",
  ]);

  attempts.length = 0;
  scenario = "all-timeout";
  await assert.rejects(
    openUpstream(target, { range: "bytes=0-32767" }, "GET"),
    (error) => error.code === "ETIMEDOUT" && error.message.includes("138-16-174-90.nip.io"),
  );
  assert.equal(attempts.length, 3, "all fleet hosts should be tried exactly once");

  attempts.length = 0;
  scenario = "success";
  const metadata = await openUpstream(
    new URL("https://138-16-177-21.nip.io/lite/events?title=episode"),
    {},
    "GET",
  );
  assert.equal(metadata.res.statusCode, 503);
  assert.equal(attempts.length, 1, "metadata requests must not retry on a sibling");

  console.log("lampac fleet media failover regression passed");
} finally {
  https.request = originalRequest;
}
