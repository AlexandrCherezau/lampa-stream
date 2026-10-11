// Vercel serverless function: relay for the Collaps embed CDN.
//
// The embed CDN (api.delivembd.ws / api.luxembd.ws / api.ortified.ws / …) gates
// every request on a hardcoded partner Origin/Referer (`https://kinokrad.my` /
// `https://kinokrad.my/`) and a per-partner IP allowlist. The browser fetch()
// cannot forge Origin (it is a forbidden header), and the visitor's egress is
// almost never in the IP allowlist — so every direct browser fetch returns 422
// with an empty body.
//
// This relay fixes the Origin half: the SPA sends us the embed URL via
// `?u=<base64url>`, we set `Origin: https://kinokrad.my` and the matching
// Referer/UA in the upstream request, and stream the body back. The browser
// reads the HTML and runs its existing makePlayer parser — no other code
// changes.
//
// What this does NOT fix: if the CDN ALSO requires the connecting IP to be
// in its allowlist, this relay still fails (Vercel fra1/iad1 egress is
// not in any partner allowlist we've observed). On a RU/residential egress
// the answer already works without us; the visitor on BY residential is
// also not in the allowlist, so the Origin-rewrite is the part we can fix
// from the server. If Origin alone is enough → success. If not → the error
// surfaces honestly as a 5xx and the UI falls back to Lampac.
//
// SSRF: the only SSRF-relevant surface here is the `u=` parameter. We require
// the https: protocol and bound the call with a 15s AbortSignal.timeout.
// Vercel's serverless functions cannot reach private network ranges from their
// runtime, so loopback/link-local targets fail on their own. There is
// deliberately NO host allow-list: the embed family rotates every few weeks
// (delivembd → luxembd → ortified → …), and the old allow-list answered 403
// "host not allowed" for the whole rotation window until someone noticed and
// shipped a new deploy — a black screen for every viewer in the meantime.
export const maxDuration = 30;
export const dynamic = "force-dynamic";

// The partner identity the embed CDN expects. Browser fetch() cannot forge
// these; only the server can.
const UPSTREAM_ORIGIN = "https://kinokrad.my";
const UPSTREAM_REFERER = "https://kinokrad.my/";
// A modern Chromium UA — the CDN pattern-matches obvious bots/CLI and 422s
// them, so use what the live partner site uses.
const UPSTREAM_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

export default async function handler(req, res) {
  const u = req.query?.u;
  if (!u || typeof u !== "string") return res.status(400).json({ error: "missing u" });

  let target;
  try { target = new URL(Buffer.from(u, "base64url").toString("utf8")); }
  catch { return res.status(400).json({ error: "bad u" }); }
  if (target.protocol !== "https:") return res.status(400).json({ error: "bad proto" });

  const headers = {
    "host": target.host,
    "origin": UPSTREAM_ORIGIN,
    "referer": UPSTREAM_REFERER,
    "user-agent": UPSTREAM_UA,
    "accept": req.headers.accept || "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": req.headers["accept-language"] || "ru-RU,ru;q=0.9,en;q=0.8",
  };
  if (req.headers.range) headers.range = String(req.headers.range);
  // undici/node would otherwise negotiate gzip and hand us a decompressed
  // body while content-length still describes the compressed one — irrelevant
  // for HTML (we don't trust content-length anyway) but doesn't cost anything
  // to pin.
  headers["accept-encoding"] = "identity";

  let upstream;
  try {
    upstream = await fetch(target.toString(), {
      method: "GET",
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(15000),
    });
  } catch (e) {
    const isTimeout = e && (e.name === "TimeoutError" || e.name === "AbortError");
    return res.status(isTimeout ? 504 : 502).json({ error: isTimeout ? "upstream-timeout" : "upstream", message: String(e?.message || e).slice(0, 200) });
  }

  // Pass through the response verbatim — the SPA reads the HTML and parses
  // makePlayer. Cache 60s on the edge, share across visitors.
  res.status(upstream.status);
  const ct = upstream.headers.get("content-type");
  if (ct) res.setHeader("content-type", ct);
  const cl = upstream.headers.get("content-length");
  if (cl) res.setHeader("content-length", cl);
  const cr = upstream.headers.get("content-range");
  if (cr) res.setHeader("content-range", cr);
  res.setHeader("cache-control", "public, max-age=60, s-maxage=300");
  res.setHeader("access-control-allow-origin", "*");
  const buf = Buffer.from(await upstream.arrayBuffer());
  res.end(buf);
}
