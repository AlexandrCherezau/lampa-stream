// Local test server: serves the built SPA (dist/) AND the three Vercel
// serverless functions on a SINGLE origin, so every same-origin /api/* fetch
// the app makes (/api/tmdb, /api/room, /api/lampac) resolves exactly as it does
// on Vercel. There is no hosted counterpart to run locally — production is
// Vercel functions — so this shim reproduces that contract for `npm run web`.
//
// Why Express with regex routes (not app.use mounts): on Vercel each function
// receives the ORIGINAL request URL (its vercel.json rewrites collapse the path
// to the function but the handler re-derives the real path itself, e.g.
// api/tmdb.js does url.pathname.replace(/^\/api\/tmdb/,"")). app.use('/api/tmdb')
// would STRIP that prefix from req.url and break the handler; a path pattern via
// app.all leaves req.url intact, matching Vercel's behavior.
//
// ESM note: the api/*.js files use `import`/`export` with no "type":"module" in
// package.json. Node (>=23) auto-detects ESM syntax, so importing them from this
// .mjs works (the same mechanism the /tmp verify scripts already rely on).
import express from "express";
import compression from "compression";
import path from "node:path";
import crypto from "node:crypto";
import dns from "node:dns";
import { fileURLToPath } from "node:url";
import { fetch as undiciFetch, Agent } from "undici";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const DIST = path.join(ROOT, "dist");
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "127.0.0.1";

// ── DoH resolver (LOCAL-ONLY) ────────────────────────────────────────────────
// This dev machine is inside Russia and its system resolver POISONS TMDB
// (api.themoviedb.org → 127.0.0.1), exactly the block the desktop app's
// main-process DoH proxy exists to defeat. On Vercel this never happens (its
// network is outside Russia), so api/tmdb.js correctly uses a plain fetch and is
// left untouched. Here we transparently repair only the TMDB hostnames by
// resolving them over DoH (Cloudflare 1.1.1.1, itself pinned so the DoH query
// can't be poisoned) and pinning the result into the fetch engine.
//
// Why override globalThis.fetch rather than setGlobalDispatcher(): Node ships its
// OWN bundled copy of undici behind the global fetch, distinct from this npm
// `undici` module instance — so setGlobalDispatcher() here would configure a copy
// the global fetch never consults (verified: our lookup fired 0×, ECONNREFUSED).
// Replacing globalThis.fetch with npm-undici's fetch bound to our Agent makes
// api/tmdb.js's `fetch(...)` route through the DoH-pinned dispatcher.
const DOH_HOSTS = new Set(["api.themoviedb.org", "image.tmdb.org"]);
const dohCache = new Map(); // host → { at, ips:[{address,family}] }
const DOH_TTL_MS = 5 * 60 * 1000;
// Pin the DoH endpoint itself to 1.1.1.1 so resolving TMDB never routes back
// through the poisoned system resolver.
const dohAgent = new Agent({ connect: { lookup: (_h, _o, cb) => cb(null, [{ address: "1.1.1.1", family: 4 }]) } });

async function dohLookup(host) {
  const hit = dohCache.get(host);
  if (hit && Date.now() - hit.at < DOH_TTL_MS) return hit.ips;
  const r = await undiciFetch(
    `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=A`,
    { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(6000), dispatcher: dohAgent },
  );
  const j = await r.json();
  const ips = (j.Answer || []).filter((a) => a.type === 1).map((a) => ({ address: a.data, family: 4 }));
  if (!ips.length) throw new Error(`DoH: no A record for ${host}`);
  dohCache.set(host, { at: Date.now(), ips });
  return ips;
}

// undici connect.lookup: DoH for TMDB hosts, system DNS for everything else
// (the fleet's *.nip.io and api-m.vi3000.top resolve fine locally).
const tmdbAgent = new Agent({
  connect: {
    lookup(host, opts, cb) {
      if (!DOH_HOSTS.has(host)) return dns.lookup(host, opts, cb);
      dohLookup(host).then(
        (ips) => (opts && opts.all ? cb(null, ips) : cb(null, ips[0].address, ips[0].family)),
        () => dns.lookup(host, opts, cb), // fall back to system DNS on DoH failure
      );
    },
  },
});
globalThis.fetch = (input, init = {}) => undiciFetch(input, { dispatcher: tmdbAgent, ...init });

// The api/*.js handlers are imported AFTER the fetch override above so the
// module-eval order can't capture the original global fetch (they don't, but
// this keeps the intent explicit).
const { default: lampac } = await import("../api/lampac.js");
const { default: room } = await import("../api/room.js");
const { default: introdb } = await import("../api/introdb.js");
const { default: sourceHost } = await import("../api/source-host.js");
const { default: collaps } = await import("../api/collaps.js");
const { default: cub } = await import("../api/cub.js");
// TMDB: use the canned mock so the local dev server can drive the full flow
// without a real token. Set MOCK_TMDB=1 to use the offline /tmp/tmdb-mock.mjs stub.
const tmdbModule = await (process.env.MOCK_TMDB === "1" ? import("/tmp/tmdb-mock.mjs") : import("../api/tmdb.js"));
const { default: tmdb } = tmdbModule;

// The relay signs third-party-CDN <key>_p siblings only when this is set
// (verifySig fails closed otherwise → filmix/veoveo etc. would 403). Fleet
// *.nip.io balancers work unsigned regardless. Generate an ephemeral one for
// the test run if the environment didn't supply it, so ALL balancers are
// testable locally.
if (!process.env.LAMPAC_PROXY_SECRET) {
  process.env.LAMPAC_PROXY_SECRET = "local-" + crypto.randomBytes(16).toString("hex");
}

const app = express();
app.disable("x-powered-by");
// gzip text responses. Vercel's edge does this for us in production; locally the
// 92 KB CSS / 162 KB JS chunks were being shipped raw, which made the dev server
// look far slower than prod. `filter` skips already-compressed binaries (images,
// woff2, the proxied TMDB posters) where gzip only burns CPU.
app.use(
  compression({
    threshold: 1024,
    filter: (req, res) => {
      const ct = res.getHeader("Content-Type");
      if (typeof ct === "string" && /^(image|video|audio|font)\//.test(ct)) return false;
      return compression.filter(req, res);
    },
  }),
);
app.use(express.json({ limit: "1mb" })); // api/room reads req.body (POST/PUT)

// Adapt a Vercel (req,res)=>Promise handler to an Express route: swallow async
// rejections into a 500 instead of an unhandled-rejection process crash.
const wrap = (h) => (req, res) =>
  Promise.resolve(h(req, res)).catch((e) => {
    if (!res.headersSent) {
      res.status(500).json({ error: "handler", message: String(e?.message || e).slice(0, 200) });
    }
  });

// /api/lampac?u=… — query-param relay, no path segments.
app.all("/api/lampac", wrap(lampac));
app.all("/api/introdb", wrap(introdb));
app.all("/api/source-host", wrap(sourceHost));
app.all("/api/collaps", wrap(collaps));
app.all("/api/cub", wrap(cub));
// /api/tmdb, /api/tmdb/3/…, /api/tmdb/img/… — handler re-derives the sub-path.
app.all(/^\/api\/tmdb(?:\/.*)?$/, wrap(tmdb));
// /api/room and /api/room?code=…&op=…
app.all(/^\/api\/room(?:\/.*)?$/, wrap(room));

// Static SPA. base:"./" in vite.config → relative asset paths, so serving dist/
// at the origin root works. index.html is served for "/".
// Cache policy mirrors vercel.json so local timings reflect production: hashed
// /assets/* are immutable, index.html must always be revalidated.
app.use(
  express.static(DIST, {
    setHeaders(res, filePath) {
      if (/[/\\]assets[/\\]/.test(filePath)) {
        res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
      } else if (filePath.endsWith("index.html")) {
        res.setHeader("Cache-Control", "no-cache");
      }
    },
  }),
);
// SPA fallback (mirrors vercel.json's /((?!api/).*) → /index.html): any non-/api
// GET that didn't match a static file returns the app shell for client routing.
app.get(/^\/(?!api\/).*/, (_req, res) => {
  res.setHeader("Cache-Control", "no-cache");
  res.sendFile(path.join(DIST, "index.html"));
});

app.listen(PORT, HOST, () => {
  const secretState = process.env.LAMPAC_PROXY_SECRET ? "set (third-party balancers signable)" : "NOT set";
  console.log(`\n  lampa-stream local test server`);
  console.log(`  ▶  http://localhost:${PORT}`);
  console.log(`     /api/tmdb   → api.themoviedb.org (needs your TMDB token in Settings)`);
  console.log(`     /api/lampac → Lampac fleet relay   LAMPAC_PROXY_SECRET: ${secretState}`);
  console.log(`     /api/room   → Watch Together (dead without Upstash env — expected)\n`);
});
