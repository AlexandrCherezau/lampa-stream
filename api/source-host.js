import { Readable } from "node:stream";
const EMBED_ORIGIN = "https://befriend.stravers.live";
// Collaps refuses requests from the platform the main host runs on, so a second host serves only it.
const SECOND_HOST_PREFIX = "h2.";
const SECOND_HOST_GRACE_MS = 15_000;
const HEARTBEAT_MS = 10_000;

export const maxDuration = 300;

const servedBySecondHost = (providerId) => typeof providerId === "string" && providerId.endsWith(":collaps");

function hostOrigin(value) {
  const origin = new URL(value);
  if (!/^https?:$/.test(origin.protocol) || origin.username || origin.password) throw new Error("Invalid host URL");
  return origin;
}

function hostRequest(origin, key, path, method, body, signal) {
  return fetch(new URL(path, origin), {
    method,
    headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body,
    signal,
  });
}

async function* sourceEvents(body) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      let name = "message";
      let data = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event: ")) name = line.slice(7);
        else if (line.startsWith("data: ")) data += line.slice(6);
      }
      if (!data) continue;
      try { yield { name, data: JSON.parse(data) }; } catch { /* a broken event is skipped */ }
    }
  }
}

// One answer from two hosts: the main one without Collaps, the second one with nothing else.
async function mergedDiscovery(res, main, second, body, abort) {
  const secondAbort = new AbortController();
  const stopSecond = () => secondAbort.abort();
  abort.signal.addEventListener("abort", stopSecond, { once: true });
  const write = (name, data) => { if (!res.writableEnded) res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`); };
  const heartbeat = setInterval(() => { if (!res.writableEnded) res.write(": searching\n\n"); }, HEARTBEAT_MS);
  let candidates = 0;
  let complete = true;
  const secondDone = (async () => {
    const upstream = await hostRequest(second.origin, second.key, "/v1/discover", "POST", body, secondAbort.signal);
    if (!upstream.ok || !upstream.body) throw new Error("Second host unavailable");
    for await (const { name, data } of sourceEvents(upstream.body)) {
      if (!["candidate", "provider"].includes(name) || !servedBySecondHost(data.providerId)) continue;
      if (name === "candidate") { candidates++; write(name, { ...data, id: SECOND_HOST_PREFIX + data.id }); }
      else write(name, data);
    }
  })().catch(() => { complete = false; });
  try {
    for await (const { name, data } of sourceEvents(main.body)) {
      if (name === "done") { complete &&= data.complete !== false; continue; }
      if (["candidate", "provider"].includes(name) && servedBySecondHost(data.providerId)) continue;
      if (name === "candidate") candidates++;
      write(name, data);
    }
    let grace;
    await Promise.race([secondDone, new Promise((resolve) => { grace = setTimeout(resolve, SECOND_HOST_GRACE_MS); })]);
    clearTimeout(grace);
    stopSecond();
    await secondDone;
    write("done", { candidates, complete });
  } finally {
    clearInterval(heartbeat);
    abort.signal.removeEventListener("abort", stopSecond);
    stopSecond();
    if (!res.writableEnded) res.end();
  }
}

export default async function handler(req, res) {
  const op = new URL(req.url, "http://localhost").searchParams.get("op");
  const paths = { discover: "/v1/discover", resolve: "/v1/resolve", providers: "/v1/providers" };
  if (!paths[op]) return res.status(404).json({ error: "NOT_FOUND" });
  if (req.method !== (op === "providers" ? "GET" : "POST")) return res.status(405).json({ error: "METHOD_NOT_ALLOWED" });
  if (!process.env.SOURCE_HOST_URL) return res.status(503).json({ error: "HOST_NOT_CONFIGURED", message: "Сервер источников ещё не подключён" });
  const abort = new AbortController();
  const onClose = () => { if (!res.writableEnded) abort.abort(); };
  res.once("close", onClose);
  const deadline = setTimeout(() => abort.abort(), 290_000);
  let stream;
  try {
    const second = process.env.COLLAPS_HOST_URL
      ? { origin: hostOrigin(process.env.COLLAPS_HOST_URL), key: process.env.COLLAPS_HOST_KEY || "" } : null;
    const forSecond = op === "resolve" && !!second && typeof req.body?.id === "string" && req.body.id.startsWith(SECOND_HOST_PREFIX);
    const origin = forSecond ? second.origin : hostOrigin(process.env.SOURCE_HOST_URL);
    const key = forSecond ? second.key : process.env.SOURCE_API_KEY;
    const payload = forSecond ? { ...req.body, id: req.body.id.slice(SECOND_HOST_PREFIX.length) } : req.body;
    const body = op === "providers" ? undefined : JSON.stringify(payload);
    if (body && Buffer.byteLength(body) > 32 * 1024) return res.status(413).json({ error: "REQUEST_TOO_LARGE" });
    const upstream = await hostRequest(origin, key, paths[op], req.method, body, abort.signal);
    res.status(upstream.status);
    res.setHeader("Cache-Control", "no-store");
    if (op === "discover" && upstream.ok && /text\/event-stream/i.test(upstream.headers.get("content-type") || "")) {
      res.setHeader("Cache-Control", "no-store, no-transform");
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders?.();
      if (second) {
        await mergedDiscovery(res, upstream, second, body, abort);
      } else {
        stream = Readable.fromWeb(upstream.body);
        await new Promise((resolve, reject) => {
          stream.once("error", reject);
          res.once("close", resolve);
          res.once("finish", resolve);
          stream.pipe(res);
        });
      }
    } else {
      const data = await upstream.json();
      if (op === "resolve" && upstream.ok) {
        // Video travels directly from our host: Vercel functions have response limits.
        const absolute = (url) => {
          const value = new URL(url, origin);
          if (value.origin !== origin.origin || value.pathname !== "/v1/media" || !value.searchParams.get("token")) throw new Error("Invalid media URL");
          return value.toString();
        };
        // An embedded player is the third party's own page, not media on our host.
        if (data.kind !== "embed") data.selected.url = absolute(data.selected.url);
        else if (new URL(data.selected.url).origin !== EMBED_ORIGIN) throw new Error("Unexpected embedded player origin");
        data.qualities = (data.qualities || []).map((value) => ({ ...value, url: absolute(value.url) }));
        data.subtitles = (data.subtitles || []).map((value) => ({ ...value, url: absolute(value.url) }));
      }
      res.json(data);
    }
  } catch {
    if (!res.headersSent) res.status(502).json({ error: "HOST_UNAVAILABLE", message: "Сервер источников временно недоступен" });
    else if (!res.writableEnded) res.destroy();
  } finally {
    clearTimeout(deadline);
    res.off("close", onClose);
    if (!stream?.readableEnded) stream?.destroy();
  }
}
