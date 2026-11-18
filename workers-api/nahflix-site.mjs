// The site's API as a Worker: the same handlers Vercel ran, behind a small Node-style router.
// Static files are served by the platform; only /api/* reaches this code.
import http from "node:http";
import { httpServerHandler } from "cloudflare:node";
import tmdb from "../api/tmdb.js";
import room from "../api/room.js";
import introdb from "../api/introdb.js";
import sourceHost from "../api/source-host.js";
import collaps from "../api/collaps.js";
import cub from "../api/cub.js";
import habster from "../api/habster.js";
import zona from "../api/zona.js";
import lampac from "../api/lampac.js";
import { createBlobProfileHandler } from "../api/_lib/_blob-profile.mjs";
import { ProfileStore, profileBlobStore } from "./profile-store.mjs";

export { ProfileStore };

const PORT = 8080;
const BODY_LIMIT = 1024 * 1024;
const ROOMS_ORIGIN = "https://lampa-rooms.ocr-gemini-proxy.workers.dev";

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > BODY_LIMIT) reject(Object.assign(new Error("Request body is too large"), { status: 413 }));
      else chunks.push(chunk);
    });
    req.once("end", () => resolve(Buffer.concat(chunks, size)));
    req.once("error", reject);
  });
}

// Workers of one account reach each other through bindings, not their public addresses.
function routeBoundOrigins(bindings) {
  const publicFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const service = bindings.get(url.origin);
    if (service) return service.fetch(input, init);
    if (init?.redirect !== "error") return publicFetch(input, init);
    // The platform has no "error" redirect mode: refuse the redirect ourselves.
    return publicFetch(input, { ...init, redirect: "manual" }).then((response) => {
      if (response.status < 300 || response.status >= 400) return response;
      response.body?.cancel();
      throw new TypeError("Unexpected redirect");
    });
  };
}

function start(env) {
  const bindings = new Map([[ROOMS_ORIGIN, env.ROOMS]]);
  if (env.SOURCE_HOST_URL) bindings.set(new URL(env.SOURCE_HOST_URL).origin, env.SOURCE_HOST);
  routeBoundOrigins(bindings);
  const profile = createBlobProfileHandler({ env, blobStore: profileBlobStore(env.PROFILES) });
  const routes = [
    ["/api/source-host", sourceHost], ["/api/cub", cub], ["/api/habster", habster], ["/api/zona", zona],
    ["/api/introdb", introdb], ["/api/tmdb", tmdb], ["/api/room", room], ["/api/profile", profile],
    ["/api/lampac", lampac], ["/api/collaps", collaps],
  ];

  http.createServer(async (req, res) => {
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (value) => {
      if (!res.getHeader("content-type")) res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify(value));
      return res;
    };
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS");
    try {
      const url = new URL(req.url, "http://localhost");
      const handler = routes.find(([prefix]) => url.pathname === prefix || url.pathname.startsWith(`${prefix}/`))?.[1];
      if (!handler) return res.status(404).json({ error: "NOT_FOUND" });
      // The platform's own header is the only client address a visitor cannot forge.
      const address = req.headers["cf-connecting-ip"] || "";
      req.ip = address;
      req.headers["x-real-ip"] = address;
      delete req.headers["x-forwarded-for"];
      req.query = Object.fromEntries(url.searchParams);
      if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && /^application\/json\b/i.test(req.headers["content-type"] || "")) {
        const raw = await readBody(req);
        try { req.body = raw.length ? JSON.parse(raw.toString("utf8")) : {}; }
        catch { return res.status(400).json({ error: "INVALID_JSON" }); }
      }
      await handler(req, res);
    } catch (error) {
      if (!res.headersSent) res.status(error?.status || 500).json({ error: "HANDLER_FAILED" });
      else res.destroy();
    }
  }).listen(PORT);
  return httpServerHandler({ port: PORT });
}

let handler;
export default {
  fetch(request, env, context) {
    handler ||= start(env);
    return handler.fetch(request, env, context);
  },
};
