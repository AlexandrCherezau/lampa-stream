import { Readable } from "node:stream";

export const maxDuration = 300;

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
    const origin = new URL(process.env.SOURCE_HOST_URL);
    if (!/^https?:$/.test(origin.protocol) || origin.username || origin.password) throw new Error("Invalid host URL");
    const body = op === "providers" ? undefined : JSON.stringify(req.body);
    if (body && Buffer.byteLength(body) > 32 * 1024) return res.status(413).json({ error: "REQUEST_TOO_LARGE" });
    const upstream = await fetch(new URL(paths[op], origin), {
      method: req.method,
      headers: { "content-type": "application/json", ...(process.env.SOURCE_API_KEY ? { authorization: `Bearer ${process.env.SOURCE_API_KEY}` } : {}) },
      body,
      signal: abort.signal,
    });
    res.status(upstream.status);
    res.setHeader("Cache-Control", "no-store");
    if (op === "discover" && upstream.ok && /text\/event-stream/i.test(upstream.headers.get("content-type") || "")) {
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("X-Accel-Buffering", "no");
      res.flushHeaders?.();
      stream = Readable.fromWeb(upstream.body);
      await new Promise((resolve, reject) => {
        stream.once("error", reject);
        res.once("close", resolve);
        res.once("finish", resolve);
        stream.pipe(res);
      });
    } else {
      const data = await upstream.json();
      if (op === "resolve" && upstream.ok) {
        // Video travels directly from our host: Vercel functions have response limits.
        const absolute = (url) => {
          const value = new URL(url, origin);
          if (value.origin !== origin.origin || value.pathname !== "/v1/media" || !value.searchParams.get("token")) throw new Error("Invalid media URL");
          return value.toString();
        };
        data.selected.url = absolute(data.selected.url);
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
