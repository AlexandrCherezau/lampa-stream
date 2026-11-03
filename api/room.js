// Watch Together fallback path: same-origin access to the rooms Worker for
// browsers whose network blocks its host. Rooms themselves live in
// workers-api/rooms-worker.mjs; this only forwards the request.
//
//   POST /api/room                 → POST /rooms
//   GET  /api/room?code=CODE       → GET  /rooms/CODE
//   POST /api/room?code=CODE       → POST /rooms/CODE

const WORKER_URL = process.env.ROOMS_WORKER_URL || "https://lampa-rooms.ocr-gemini-proxy.workers.dev";
const CODE_RE = /^[A-Z0-9]{4,12}$/;
const TIMEOUT_MS = 8000;

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET" && req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });

  const authorization = req.headers.authorization || "";
  if (!authorization.startsWith("Bearer ")) return res.status(401).json({ error: "missing_token" });

  const code = String(req.query?.code ?? "").toUpperCase();
  if (code && !CODE_RE.test(code)) return res.status(req.method === "GET" ? 200 : 404).json({ room: null, error: "not_found" });
  if (!code && req.method === "GET") return res.status(400).json({ error: "missing_code" });

  try {
    const upstream = await fetch(`${WORKER_URL}/rooms${code ? `/${code}` : ""}`, {
      method: req.method,
      headers: { Authorization: authorization, "Content-Type": "application/json" },
      body: req.method === "POST" ? JSON.stringify(req.body ?? {}) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = await upstream.text();
    return res.status(upstream.status).setHeader("Content-Type", "application/json").send(body);
  } catch {
    return res.status(502).json({ error: "rooms_unreachable" });
  }
}
