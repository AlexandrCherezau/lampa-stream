import http from "node:http";
import crypto from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createLampacProvider } from "./providers/lampac.mjs";
import { createTransport } from "./transport.mjs";
import { createMedia } from "./media.mjs";

const CANDIDATE_TTL = 12 * 60 * 60_000;
const DISCOVERY_MS = 50_000;
const RESOLVE_MS = 45_000;
const PROVIDER_ORDER = ["vibix", "animedia", "hdvb", "kodik", "aniliberty", "zetflixdb", "phantom", "veoveo", "vkmovie", "animevost", "zetflix"];

function failure(message, status = 400, code = "INVALID_REQUEST") {
  return Object.assign(new Error(message), { status, code });
}

export function validateTitle(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw failure("Нужны параметры фильма или сериала");
  const title = {};
  if (!["movie", "tv"].includes(value.type)) throw failure("Неверный тип: movie или tv");
  title.type = value.type;
  for (const key of ["title", "originalTitle", "language"]) {
    if (value[key] == null) continue;
    if (typeof value[key] !== "string" || value[key].length > (key === "language" ? 8 : 300)) throw failure(`Неверный параметр ${key}`);
    title[key] = value[key].trim();
  }
  if (!title.title && !title.originalTitle) throw failure("Нужно название");
  for (const key of ["tmdbId", "kinopoiskId", "year"]) {
    if (value[key] == null || value[key] === "") continue;
    const number = Number(value[key]);
    if (!Number.isSafeInteger(number) || number < 1 || (key === "year" && (number < 1880 || number > 2200))) throw failure(`Неверный параметр ${key}`);
    title[key] = number;
  }
  if (value.imdbId != null) {
    if (!/^tt\d{5,12}$/.test(value.imdbId)) throw failure("Неверный IMDb ID");
    title.imdbId = value.imdbId;
  }
  title.anime = value.anime === true;
  if (value.runtimeMinutes != null) {
    if (title.type !== "movie") throw failure("Runtime доступен только для фильма");
    const runtimeMinutes = Number(value.runtimeMinutes);
    if (!Number.isSafeInteger(runtimeMinutes) || runtimeMinutes < 1 || runtimeMinutes > 1440) throw failure("Неверный runtimeMinutes");
    title.runtimeMinutes = runtimeMinutes;
  }
  if (title.type === "tv") {
    for (const key of ["season", "episode"]) {
      const number = Number(value[key]);
      if (!Number.isSafeInteger(number) || number < (key === "season" ? 0 : 1) || number > 10_000) throw failure(`Нужно точное значение ${key}`);
      title[key] = number;
    }
  }
  return title;
}

async function bodyJson(req) {
  let bytes = 0;
  const chunks = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 32 * 1024) throw failure("Слишком большой запрос", 413);
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw failure("Неверный JSON"); }
}

function json(res, status, value) {
  if (res.destroyed || res.writableEnded) return;
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
}

function equalSecret(a, b) {
  const left = Buffer.from(a || "");
  const right = Buffer.from(b || "");
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

const publicCandidate = (candidate) => ({
  id: candidate.id,
  providerId: candidate.providerId,
  providerName: candidate.providerName,
  voiceId: candidate.voiceId,
  voiceName: candidate.voiceName,
  qualityHint: candidate.qualityHint,
  season: candidate.season,
  episode: candidate.episode,
});

export function createSourceServer({ engineUrl, engineKey, engineReadyFile = "", secret, apiKey = "", publicOrigin = "", mediaRelayUrl = "", adapter, media, transport } = {}) {
  if (!engineUrl && !adapter) throw new Error("SOURCE_ENGINE_URL is required");
  if (Buffer.byteLength(secret || "") < 32) throw new Error("SOURCE_HOST_SECRET must contain at least 32 bytes");
  if (mediaRelayUrl && (!apiKey || new URL(mediaRelayUrl).protocol !== "https:" || new URL(mediaRelayUrl).origin === publicOrigin)) throw new Error("Media relay needs a separate HTTPS origin and private API key");
  const candidateKey = crypto.createHash("sha256").update(secret).update("\0sources").digest();
  transport ||= createTransport({ engineUrl, engineKey, beforeEngineRequest: waitForEngine });
  media ||= createMedia({ transport, secret, publicOrigin });
  adapter ||= createLampacProvider({ baseUrl: engineUrl, fetchJson: transport.json, providerOrder: PROVIDER_ORDER });
  const providers = new Map();
  let discoveries = 0;
  let resolutions = 0;
  const startedAt = Date.now();

  async function waitForEngine(signal) {
    const until = Date.now() + 120_000;
    if (engineReadyFile && !existsSync(engineReadyFile)) writeFileSync(`${engineReadyFile}.start`, "", { flag: "a", mode: 0o600 });
    while (engineReadyFile && !existsSync(engineReadyFile)) {
      if (Date.now() >= until) throw failure("Сервер источников запускается, повторите запрос", 503, "ENGINE_STARTING");
      await delay(100, undefined, { signal });
    }
  }

  function remember(candidate, runtimeMinutes) {
    // Containers can restart or route the next request to another instance.
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", candidateKey, iv);
    const storedCandidate = { ...candidate, ref: candidate.ref };
    delete storedCandidate.runtimeMinutes;
    const payload = JSON.stringify({ candidate: storedCandidate, runtimeMinutes, expires: Date.now() + CANDIDATE_TTL });
    const encrypted = Buffer.concat([cipher.update(payload, "utf8"), cipher.final()]);
    const id = ["c1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
    if (id.length > 24 * 1024) throw failure("Слишком большой ответ источника", 502, "SOURCE_FAILED");
    return publicCandidate({ ...candidate, id });
  }

  function readCandidate(id) {
    try {
      const [version, iv, tag, encrypted, extra] = id.split(".");
      if (version !== "c1" || extra !== undefined || !iv || !tag || !encrypted) throw new Error("Invalid source");
      for (const part of [iv, tag, encrypted]) {
        if (Buffer.from(part, "base64url").toString("base64url") !== part) throw new Error("Invalid encoding");
      }
      if (Buffer.from(iv, "base64url").length !== 12 || Buffer.from(tag, "base64url").length !== 16) throw new Error("Invalid source");
      const decipher = crypto.createDecipheriv("aes-256-gcm", candidateKey, Buffer.from(iv, "base64url"));
      decipher.setAuthTag(Buffer.from(tag, "base64url"));
      const { candidate, runtimeMinutes, expires } = JSON.parse(Buffer.concat([decipher.update(Buffer.from(encrypted, "base64url")), decipher.final()]).toString("utf8"));
      if (!Number.isFinite(expires) || expires <= Date.now() || !candidate?.providerId) throw new Error("Expired source");
      Object.defineProperty(candidate, "ref", { value: candidate.ref, enumerable: false });
      if (runtimeMinutes !== undefined) Object.defineProperty(candidate, "runtimeMinutes", { value: runtimeMinutes, enumerable: false });
      candidate.id = id;
      return candidate;
    } catch { throw failure("Обновите список источников", 410, "SOURCE_EXPIRED"); }
  }

  function record(provider, patch) {
    const previous = providers.get(provider) || { providerId: provider };
    providers.set(provider, { ...previous, ...patch, updatedAt: new Date().toISOString() });
  }

  const server = http.createServer(async (req, res) => {
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-headers", "content-type, authorization, range");
    res.setHeader("access-control-expose-headers", "content-length, content-range, accept-ranges");
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
    const path = new URL(req.url, "http://localhost");
    if (path.pathname === "/healthz" && req.method === "GET") {
      return json(res, 200, { ok: true, engineReady: !engineReadyFile || existsSync(engineReadyFile), version: "1.0.0", uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000) });
    }
    if (path.pathname === "/v1/media" && ["GET", "HEAD"].includes(req.method)) {
      try {
        if (mediaRelayUrl && !equalSecret(req.headers["x-source-relay-key"], apiKey)) {
          const resource = media.resource(path.searchParams.get("token"));
          if (!resource.nodeOnly) {
            const location = new URL("/v1/media", mediaRelayUrl);
            location.searchParams.set("token", path.searchParams.get("token") || "");
            res.writeHead(302, { location: location.href, "cache-control": "no-store" }).end();
            return;
          }
        }
        await media.handle(req, res, path.searchParams.get("token"));
      }
      catch (error) { json(res, error.status || 502, { error: error.code || "MEDIA_FAILED", message: "Видео временно недоступно" }); }
      return;
    }
    if (apiKey && !equalSecret(req.headers.authorization, `Bearer ${apiKey}`)) return json(res, 401, { error: "UNAUTHORIZED" });
    if (path.pathname === "/v1/media-route" && req.method === "GET") {
      try { return json(res, 200, await transport.route(media.resource(path.searchParams.get("token")), { signal: AbortSignal.timeout(15_000) })); }
      catch (error) { return json(res, error.status || 502, { error: "MEDIA_UNAVAILABLE" }); }
    }
    if (path.pathname === "/v1/providers" && req.method === "GET") return json(res, 200, { providers: [...providers.values()] });
    if (!["/v1/discover", "/v1/resolve"].includes(path.pathname)) return json(res, 404, { error: "NOT_FOUND" });
    if (req.method !== "POST") return json(res, 405, { error: "METHOD_NOT_ALLOWED" });

    const controller = new AbortController();
    const onClose = () => { if (!res.writableEnded) controller.abort(); };
    res.once("close", onClose);
    let deadline;
    try {
      const body = await bodyJson(req);
      if (path.pathname === "/v1/discover") {
        const title = validateTitle(body);
        await waitForEngine(controller.signal);
        if (discoveries >= 4) throw failure("Сервер занят, повторите запрос", 429, "BUSY");
        discoveries++;
        deadline = setTimeout(() => controller.abort(failure("Истекло время поиска", 504, "TIMEOUT")), DISCOVERY_MS);
        res.writeHead(200, { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" });
        res.flushHeaders();
        const event = (name, value) => { if (!res.destroyed) res.write(`event: ${name}\ndata: ${JSON.stringify(value)}\n\n`); };
        const heartbeat = setInterval(() => { if (!res.destroyed) res.write(": searching\n\n"); }, 10_000);
        let count = 0;
        try {
          event("start", { type: title.type, season: title.season, episode: title.episode });
          for await (const candidate of adapter.discover(title, { signal: controller.signal })) {
            if (controller.signal.aborted) break;
            if (candidate.error) {
              record(candidate.providerId, { providerName: candidate.providerName, status: "unavailable", error: "Источник не предоставил выбранную запись" });
              event("provider", { providerId: candidate.providerId, providerName: candidate.providerName, status: "unavailable" });
              continue;
            }
            record(candidate.providerId, { providerName: candidate.providerName, status: "discovered" });
            event("candidate", remember(candidate, title.runtimeMinutes));
            count++;
          }
          event("done", { candidates: count, complete: !controller.signal.aborted });
        } catch (error) {
          event("error", { error: controller.signal.aborted ? "TIMEOUT" : "ENGINE_UNAVAILABLE", message: "Не удалось получить все источники" });
          event("done", { candidates: count, complete: false });
        } finally {
          clearInterval(heartbeat);
          discoveries--;
          res.end();
        }
      } else {
        if (typeof body.id !== "string" || body.id.length > 24 * 1024) throw failure("Неверный источник");
        if (body.quality != null && (typeof body.quality !== "string" || body.quality.length > 40)) throw failure("Неверное качество");
        const candidate = readCandidate(body.id);
        await waitForEngine(controller.signal);
        if (resolutions >= 8) throw failure("Сервер занят, повторите запрос", 429, "BUSY");
        resolutions++;
        deadline = setTimeout(() => controller.abort(failure("Истекло время проверки", 504, "TIMEOUT")), RESOLVE_MS);
        try {
          const resolved = await adapter.resolve(candidate, { signal: controller.signal });
          const qualities = resolved.qualities || [];
          if (!qualities.length) throw failure("Источник не предоставил видео", 502, "NO_MEDIA");
          const wanted = body.quality == null ? null : String(body.quality);
          const order = wanted == null
            ? qualities.slice().sort((a, b) => Math.abs((a.height || 720) - 720) - Math.abs((b.height || 720) - 720))
            : qualities.filter((quality) => quality.label === wanted);
          if (!order.length) throw failure("Качество недоступно", 404, "QUALITY_NOT_FOUND");
          let selected;
          let probe;
          let shortVod = false;
          for (const quality of order) {
            if (controller.signal.aborted) break;
            try {
              probe = await media.probe(quality, { signal: controller.signal });
              if (probe.ok && candidate.runtimeMinutes && probe.kind === "hls" && Number.isFinite(probe.duration)
                && probe.duration < candidate.runtimeMinutes * 30) {
                shortVod = true;
                continue;
              }
              if (probe.ok) { selected = quality; break; }
            } catch (error) {
              if (controller.signal.aborted) break;
            }
          }
          if (controller.signal.aborted) throw controller.signal.reason || failure("Истекло время проверки", 504, "TIMEOUT");
          if (!selected) {
            if (shortVod) throw failure("Источник вернул слишком короткое видео", 502, "MEDIA_DURATION_MISMATCH");
            throw failure("Видео не загружается, выберите другой источник", 502, "MEDIA_UNAVAILABLE");
          }
          record(candidate.providerId, { providerName: candidate.providerName, status: "verified", verifiedAt: new Date().toISOString() });
          // Keep the verified redirect target; dynamic engine manifests need a browser again.
          // shortcut: keep these failing Worker paths on Node until relay playback is verified.
          const variants = qualities.map((quality) => ({ label: quality.label, height: quality.height,
            url: media.url({ ...(quality === selected && probe.url ? { ...quality, url: String(probe.url), headers: probe.headers || quality.headers, headerOrigin: probe.headerOrigin } : quality), nodeOnly: ["zetflixdb", "cdnvideohub"].includes(candidate.providerId) || (candidate.providerId === "zetflix" && candidate.season == null && candidate.episode == null) }),
          }));
          const subtitles = (resolved.subtitles || []).map((subtitle) => ({ label: subtitle.label, language: subtitle.language, url: media.url(subtitle) }));
          json(res, 200, {
            source: publicCandidate(candidate),
            qualities: variants,
            selected: variants[qualities.indexOf(selected)],
            kind: probe.kind,
            subtitles,
            duration: resolved.duration,
            skip: resolved.skip,
          });
        } catch (error) {
          record(candidate.providerId, { status: "unavailable", error: "Видео не прошло проверку" });
          throw error;
        } finally { resolutions--; }
      }
    } catch (error) {
      json(res, error.status || 502, { error: error.code || (controller.signal.aborted ? "TIMEOUT" : "SOURCE_FAILED"), message: error.status ? error.message : "Источник временно недоступен" });
    } finally {
      clearTimeout(deadline);
      res.off("close", onClose);
    }
  });
  server.requestTimeout = 60_000;
  server.headersTimeout = 15_000;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const secret = process.env.SOURCE_HOST_SECRET || (process.env.SOURCE_HOST_SECRET_FILE ? readFileSync(process.env.SOURCE_HOST_SECRET_FILE, "utf8").trim() : "");
  const server = createSourceServer({
    engineUrl: process.env.SOURCE_ENGINE_URL,
    engineKey: process.env.SOURCE_ENGINE_KEY,
    engineReadyFile: process.env.SOURCE_ENGINE_READY_FILE,
    mediaRelayUrl: process.env.SOURCE_MEDIA_RELAY_URL,
    secret,
    apiKey: process.env.SOURCE_API_KEY || "",
    publicOrigin: process.env.SOURCE_PUBLIC_ORIGIN || "",
  });
  const port = Number(process.env.PORT || 9120);
  server.listen(port, process.env.HOST || "0.0.0.0", () => console.log(`Source host listening on port ${port}`));
  for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => { server.close(); setTimeout(() => process.exit(0), 10_000).unref(); });
}
