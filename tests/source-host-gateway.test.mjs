import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";

const MAIN = "https://main.example";
const SECOND = "https://second.example";
const sse = (events) => new Response(events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join(""), {
  headers: { "content-type": "text/event-stream; charset=utf-8" },
});

function response() {
  const res = new EventEmitter();
  Object.assign(res, {
    statusCode: 200, headers: {}, text: "", writableEnded: false, headersSent: false,
    status(code) { res.statusCode = code; return res; },
    setHeader(name, value) { res.headers[name.toLowerCase()] = value; },
    write(chunk) { res.headersSent = true; res.text += chunk; },
    end(chunk = "") { res.text += chunk; res.writableEnded = true; res.emit("finish"); },
    json(value) { res.end(JSON.stringify(value)); },
    destroy() { res.writableEnded = true; },
  });
  return res;
}

async function call(op, body, routes) {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), authorization: init.headers.authorization, body: init.body && JSON.parse(init.body) });
    return routes[new URL(url).origin](init);
  };
  Object.assign(process.env, { SOURCE_HOST_URL: MAIN, SOURCE_API_KEY: "main-key", COLLAPS_HOST_URL: SECOND, COLLAPS_HOST_KEY: "second-key" });
  try {
    const { default: handler } = await import("../api/source-host.js");
    const res = response();
    await handler({ url: `/api/source-host?op=${op}`, method: "POST", body }, res);
    return { res, calls };
  } finally {
    globalThis.fetch = realFetch;
  }
}

const events = (text) => text.split("\n\n").filter((block) => block.startsWith("event: "))
  .map((block) => [block.split("\n")[0].slice(7), JSON.parse(block.split("\n")[1].slice(6))]);

test("discovery takes Collaps from the second host and everything else from the main one", async () => {
  const { res } = await call("discover", { type: "movie" }, {
    [MAIN]: () => sse([
      ["start", { type: "movie" }],
      ["candidate", { id: "a", providerId: "habster:alloha" }],
      ["candidate", { id: "broken", providerId: "habster:collaps" }],
      ["provider", { providerId: "kinoarc:collaps", status: "unavailable" }],
      ["done", { candidates: 2, complete: true }],
    ]),
    [SECOND]: () => sse([
      ["start", { type: "movie" }],
      ["candidate", { id: "dup", providerId: "habster:alloha" }],
      ["candidate", { id: "c", providerId: "habster:collaps" }],
      ["done", { candidates: 2, complete: true }],
    ]),
  });
  const seen = events(res.text);
  assert.deepEqual(seen.filter(([name]) => name === "candidate").map(([, data]) => data.id).sort(), ["a", "h2.c"]);
  assert.equal(seen.filter(([name]) => name === "start").length, 1);
  assert.equal(seen.some(([name]) => name === "provider"), false);
  assert.deepEqual(seen.at(-1), ["done", { candidates: 2, complete: true }]);
});

test("a second host that fails leaves the main sources and marks the search incomplete", async () => {
  const { res } = await call("discover", { type: "movie" }, {
    [MAIN]: () => sse([["candidate", { id: "a", providerId: "habster:alloha" }], ["done", { candidates: 1, complete: true }]]),
    [SECOND]: () => new Response("down", { status: 503 }),
  });
  assert.deepEqual(events(res.text), [["candidate", { id: "a", providerId: "habster:alloha" }], ["done", { candidates: 1, complete: false }]]);
});

test("a second-host source is resolved there, with its own key, and may only point at that host", async () => {
  const { res, calls } = await call("resolve", { id: "h2.c" }, {
    [SECOND]: () => Response.json({ selected: { url: "/v1/media?token=t" }, qualities: [], subtitles: [] }),
  });
  assert.deepEqual(calls, [{ url: `${SECOND}/v1/resolve`, authorization: "Bearer second-key", body: { id: "c" } }]);
  assert.equal(JSON.parse(res.text).selected.url, `${SECOND}/v1/media?token=t`);
  const foreign = await call("resolve", { id: "h2.c" }, {
    [SECOND]: () => Response.json({ selected: { url: `${MAIN}/v1/media?token=t` } }),
  });
  assert.equal(foreign.res.statusCode, 502);
});

test("any other source is still resolved on the main host", async () => {
  const { calls } = await call("resolve", { id: "a" }, {
    [MAIN]: () => Response.json({ kind: "embed", selected: { url: "https://befriend.stravers.live/?kp=1&token=t" } }),
  });
  assert.deepEqual(calls, [{ url: `${MAIN}/v1/resolve`, authorization: "Bearer main-key", body: { id: "a" } }]);
});
