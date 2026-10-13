import { createDecipheriv, createCipheriv, createHash, randomBytes } from "node:crypto";
import { brotliDecompressSync, gunzipSync, inflateSync, gzip } from "node:zlib";
import { promisify } from "node:util";
import { TransportError } from "./transport.mjs";

const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
const PLAYLIST_MAX = 16 * 1024 * 1024;
const RANGE_DEFAULT_MAX = 8 * 1024 * 1024;
const RANGE_LIMIT = 96 * 1024 * 1024;
const PROBE_PREFIX = 64 * 1024;
const PLAYLIST_CACHE_MS = 15_000;
const PLAYLIST_CACHE_LIMIT = 8;
const PLAYLIST_CACHE_BYTES = 1024 * 1024;
const HEADER_ALLOWLIST = new Set(["referer", "origin", "user-agent", "accept", "accept-language", "cookie", "authorizations", "accepts-controls"]);
const ORIGIN_BOUND_HEADERS = new Set(["cookie", "authorizations", "accepts-controls"]);
const RESPONSE_HEADERS = ["accept-ranges", "cache-control", "content-length", "content-range", "content-type", "etag", "last-modified", "content-encoding"];
const gzipAsync = promisify(gzip);

function mediaError(message, status = 502) {
  return Object.assign(new Error(message), { status });
}

function headersFor(resource) {
  const result = { "accept-encoding": "identity" };
  const targetOrigin = new URL(resource.url).origin;
  const headerOrigin = resource.headerOrigin || targetOrigin;
  for (const [name, value] of Object.entries(resource.headers || {})) {
    const key = name.toLowerCase();
    if (ORIGIN_BOUND_HEADERS.has(key) && targetOrigin !== headerOrigin) continue;
    if (HEADER_ALLOWLIST.has(key) && typeof value === "string" && !/[\r\n]/.test(value)) result[key] = value;
  }
  return result;
}

function decodeBody(bytes, encoding = "") {
  switch (encoding.toLowerCase()) {
    case "gzip": return gunzipSync(bytes, { maxOutputLength: PLAYLIST_MAX });
    case "br": return brotliDecompressSync(bytes, { maxOutputLength: PLAYLIST_MAX });
    case "deflate": return inflateSync(bytes, { maxOutputLength: PLAYLIST_MAX });
    default: return bytes;
  }
}

async function collect(response, maxBytes, { signal, prefix = false } = {}) {
  const chunks = [];
  let length = 0;
  try {
    for await (const chunk of response) {
      if (signal?.aborted) throw signal.reason || Object.assign(new Error("aborted"), { name: "AbortError" });
      const take = prefix ? Math.min(chunk.length, maxBytes - length) : chunk.length;
      if (take > 0) { chunks.push(chunk.subarray(0, take)); length += take; }
      if (prefix && length >= maxBytes) {
        response.destroy();
        break;
      }
      if (!prefix && length > maxBytes) {
        response.destroy();
        throw mediaError("Upstream media response is too large");
      }
    }
  } catch (error) {
    if (error.status) throw error;
    if (signal?.aborted) throw signal.reason || Object.assign(new Error("aborted"), { name: "AbortError" });
    if (response.destroyed && length >= maxBytes && prefix) return Buffer.concat(chunks, length);
    throw mediaError("Upstream media response ended early");
  }
  if (!length) throw mediaError("Upstream returned an empty media response");
  return Buffer.concat(chunks, length);
}

function isPlaylist(contentType, bytes) {
  return /mpegurl|vnd\.apple\.mpegurl/i.test(contentType || "") || playlistSignature(bytes);
}

function playlistSignature(bytes) {
  return bytes.toString("utf8", 0, Math.min(bytes.length, 16_384)).replace(/^\uFEFF/, "").trimStart().startsWith("#EXTM3U");
}

function looksLikeErrorPage(contentType, bytes) {
  const prefix = bytes.toString("utf8", 0, Math.min(bytes.length, 512)).replace(/^\uFEFF/, "").trimStart().toLowerCase();
  const playlist = playlistSignature(bytes);
  return /application\/(?:json|problem\+json)/i.test(contentType || "")
    || (/text\/html/i.test(contentType || "") && !playlist)
    || (!playlist && /^<!doctype\s+html\b|^<html\b|^<(?:head|body|script|title|meta|form)\b/.test(prefix))
    || /^\{\s*"[^"\r\n]+"\s*:/.test(prefix)
    || /^\[\s*(?:\{|\[|"(?:[^"\\]|\\.)*"|-?\d|true\b|false\b|null\b)/.test(prefix);
}

function hlsUri(value, base) {
  const raw = value.trim();
  if (!raw || /^(?:data:|skd:|urn:)/i.test(raw)) return raw;
  return new URL(raw, base).toString();
}

function rewritePlaylist(text, baseUrl, makeUrl) {
  const wrap = (raw) => {
    const target = hlsUri(raw, baseUrl);
    return /^https?:\/\//i.test(target) ? makeUrl(target) : target;
  };
  return text.split(/\r?\n/).map((line) => {
    if (!line || line[0] === "#") {
      return line.replace(/\bURI=(['"])(.*?)\1/gi, (_match, quote, raw) => `URI=${quote}${wrap(raw)}${quote}`);
    }
    return wrap(line);
  }).join("\n");
}

function parseRange(value) {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match || (!match[1] && !match[2])) return false;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return false;
    return { suffix: Math.min(suffix, RANGE_LIMIT) };
  }
  const start = Number(match[1]);
  if (!Number.isSafeInteger(start) || start < 0 || start > Number.MAX_SAFE_INTEGER - RANGE_LIMIT) return false;
  if (!match[2]) return { start, end: start + RANGE_DEFAULT_MAX - 1 };
  const end = Number(match[2]);
  if (!Number.isSafeInteger(end) || end < start) return false;
  return { start, end: Math.min(end, start + RANGE_LIMIT - 1) };
}

function rangeHeader(range) {
  if (!range) return null;
  return range.suffix ? `bytes=-${range.suffix}` : `bytes=${range.start}-${range.end}`;
}

function responseError(res, status, message) {
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(status, { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", ...(status === 416 ? { "content-range": "bytes */*" } : {}) });
  res.end(message);
}

function redirectUrl(publicOrigin, token) {
  const path = `/v1/media?token=${encodeURIComponent(token)}`;
  return publicOrigin ? new URL(path, publicOrigin).toString() : path;
}

function decodeTokenPart(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid");
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value) throw new Error("invalid");
  return bytes;
}

function parseToken(token, key) {
  try {
    const parts = String(token || "").split(".");
    if (parts[0] === "v2") return parseCompactToken(parts, key);
    if (parts.length !== 4 || parts[0] !== "v1") throw new Error("invalid");
    const iv = decodeTokenPart(parts[1]);
    const tag = decodeTokenPart(parts[2]);
    const ciphertext = decodeTokenPart(parts[3]);
    if (iv.length !== 12 || tag.length !== 16 || ciphertext.length === 0) throw new Error("invalid");
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const value = JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8"));
    if (!value || !Number.isFinite(value.exp) || value.exp <= Date.now() || typeof value.url !== "string") throw new Error("expired");
    if (value.publicOnly !== undefined && typeof value.publicOnly !== "boolean") throw new Error("invalid");
    return { ...value, publicOnly: value.publicOnly === true, nodeOnly: value.nodeOnly === true };
  } catch {
    throw mediaError("Invalid or expired media token", 404);
  }
}

function decryptGcmPart(ivPart, tagPart, ciphertextPart, key, aad) {
  const iv = decodeTokenPart(ivPart);
  const tag = decodeTokenPart(tagPart);
  const ciphertext = decodeTokenPart(ciphertextPart);
  if (iv.length !== 12 || tag.length !== 16 || ciphertext.length === 0) throw new Error("invalid");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  decipher.setAAD(Buffer.from(aad));
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function parseCompactToken(parts, key) {
  if (parts.length !== 7) throw new Error("invalid");
  const contextPrefix = parts.slice(0, 4).join(".");
  const context = JSON.parse(decryptGcmPart(parts[1], parts[2], parts[3], key, "source-host:v2:context").toString("utf8"));
  if (!context || typeof context.baseUrl !== "string" || !Number.isFinite(context.exp) || context.exp <= Date.now()
    || !context.headers || typeof context.headers !== "object" || Array.isArray(context.headers)
    || typeof context.headerOrigin !== "string" || typeof context.publicOnly !== "boolean" || typeof context.nodeOnly !== "boolean") throw new Error("invalid");
  const base = new URL(context.baseUrl);
  if (!/^https?:$/.test(base.protocol) || base.username || base.password) throw new Error("invalid");
  const child = JSON.parse(decryptGcmPart(parts[4], parts[5], parts[6], key, contextPrefix).toString("utf8"));
  if (!child || typeof child.ref !== "string" || typeof child.sameOrigin !== "boolean") throw new Error("invalid");
  const target = child.sameOrigin ? new URL(child.ref, base) : new URL(child.ref);
  if (!/^https?:$/.test(target.protocol) || target.username || target.password
    || (child.sameOrigin && target.origin !== base.origin) || (!child.sameOrigin && target.origin === base.origin)) throw new Error("invalid");
  const resource = { url: target.href, headers: context.headers, headerOrigin: context.headerOrigin,
    nodeOnly: context.nodeOnly, publicOnly: context.publicOnly, exp: context.exp };
  resource.headers = headersFor(resource);
  return resource;
}

function makeToken(resource, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const value = Buffer.from(JSON.stringify({
    url: String(resource.url),
    headers: headersFor(resource),
    headerOrigin: resource.headerOrigin || new URL(resource.url).origin,
    nodeOnly: resource.nodeOnly === true,
    publicOnly: resource.publicOnly === true,
    exp: Date.now() + TOKEN_TTL_MS,
  }));
  const encrypted = Buffer.concat([cipher.update(value), cipher.final()]);
  return `v1.${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${encrypted.toString("base64url")}`;
}

function makeCompactChildUrl(resource, baseUrl, key, publicOrigin) {
  const base = new URL(baseUrl);
  const contextIv = randomBytes(12);
  const contextCipher = createCipheriv("aes-256-gcm", key, contextIv);
  const exp = Math.min(Number.isFinite(resource.exp) ? resource.exp : Date.now() + TOKEN_TTL_MS, Date.now() + TOKEN_TTL_MS);
  const contextValue = Buffer.from(JSON.stringify({ baseUrl: base.href,
    headers: headersFor({ url: base.href, headers: resource.headers, headerOrigin: resource.headerOrigin }), headerOrigin: resource.headerOrigin || base.origin,
    nodeOnly: resource.nodeOnly === true, publicOnly: resource.publicOnly === true, exp }));
  contextCipher.setAAD(Buffer.from("source-host:v2:context"));
  const contextEncrypted = Buffer.concat([contextCipher.update(contextValue), contextCipher.final()]);
  const contextPrefix = `v2.${contextIv.toString("base64url")}.${contextCipher.getAuthTag().toString("base64url")}.${contextEncrypted.toString("base64url")}`;
  return (rawUrl) => {
    const target = new URL(rawUrl);
    if (!/^https?:$/.test(target.protocol) || target.username || target.password) throw new TypeError("resource.url must be credential-free HTTP(S)");
    const sameOrigin = target.origin === base.origin;
    let ref = target.href;
    if (sameOrigin) {
      const directory = base.pathname.slice(0, base.pathname.lastIndexOf("/") + 1);
      ref = target.pathname.startsWith(directory)
        ? `./${target.pathname.slice(directory.length)}${target.search}${target.hash}`
        : `${target.pathname}${target.search}${target.hash}`;
    }
    const childValue = Buffer.from(JSON.stringify({ sameOrigin, ref }));
    const childIv = randomBytes(12);
    const childCipher = createCipheriv("aes-256-gcm", key, childIv);
    childCipher.setAAD(Buffer.from(contextPrefix));
    const childEncrypted = Buffer.concat([childCipher.update(childValue), childCipher.final()]);
    const token = `${contextPrefix}.${childIv.toString("base64url")}.${childCipher.getAuthTag().toString("base64url")}.${childEncrypted.toString("base64url")}`;
    return redirectUrl(publicOrigin, token);
  };
}

async function readPlaylist(transport, resource, signal) {
  const { response, url, headers, headerOrigin } = await transport.request(resource.url, { headers: headersFor(resource), publicOnly: resource.publicOnly, signal, timeout: 15_000, retryNotFound: true });
  const raw = await collect(response, PLAYLIST_MAX, { signal });
  const bytes = decodeBody(raw, response.headers["content-encoding"]);
  const type = response.headers["content-type"] || "";
  if (looksLikeErrorPage(type, bytes) || !isPlaylist(type, bytes)) throw mediaError("Upstream did not return an HLS playlist");
  return { text: bytes.toString("utf8"), url, headers: headers || headersFor(resource), headerOrigin: headerOrigin || url.origin, cacheControl: response.headers["cache-control"] || "no-store" };
}

async function readProbeBytes(transport, url, headers, signal, range = true, publicOnly = false) {
  const requestHeaders = { ...headers, ...(range ? { range: range === true ? `bytes=0-${PROBE_PREFIX - 1}` : range } : {}) };
  const { response } = await transport.request(url, { headers: requestHeaders, publicOnly, signal, timeout: 15_000, retryNotFound: true });
  if (typeof range === "string" && response.statusCode !== 206) {
    response.resume();
    throw mediaError("Upstream did not honor the HLS byte range");
  }
  const type = response.headers["content-type"] || "";
  const bytes = await collect(response, PROBE_PREFIX, { signal, prefix: true });
  if (looksLikeErrorPage(type, bytes)) throw mediaError("Upstream returned an error page instead of media");
  return bytes;
}

function firstVariant(text) {
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    if (!/^#EXT-X-STREAM-INF:/i.test(lines[index])) continue;
    for (let next = index + 1; next < lines.length; next++) if (lines[next] && lines[next][0] !== "#") return lines[next].trim();
  }
  return null;
}

function firstMediaSegment(text) {
  const lines = text.split(/\r?\n/);
  const map = lines.find((line) => /^#EXT-X-MAP:/i.test(line));
  const key = lines.find((line) => /^#EXT-X-KEY:/i.test(line) && /METHOD=AES-128/i.test(line));
  let nextRange = null;
  let segment = null;
  let segmentRange = null;
  for (const line of lines) {
    const range = /^#EXT-X-BYTERANGE:(\d+)(?:@(\d+))?/i.exec(line);
    if (range) nextRange = { length: Number(range[1]), offset: range[2] ? Number(range[2]) : 0 };
    else if (line && line[0] !== "#") { segment = line.trim(); segmentRange = nextRange; break; }
  }
  const uriAttr = (line) => line && (/\bURI="([^"]+)"/i.exec(line)?.[1] || /\bURI='([^']+)'/i.exec(line)?.[1]);
  const mapRange = map && /\bBYTERANGE="(\d+)(?:@(\d+))?"/i.exec(map);
  return {
    map: uriAttr(map),
    mapRange: mapRange ? { length: Number(mapRange[1]), offset: Number(mapRange[2] || 0) } : null,
    key: uriAttr(key),
    segment,
    segmentRange,
  };
}

function vodDuration(text) {
  if (!/^#EXT-X-ENDLIST\s*$/m.test(text)) return null;
  const durations = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith("#EXTINF:")) continue;
    const match = /^#EXTINF:([0-9]+(?:\.[0-9]+)?)(?:,.*)?$/.exec(line);
    if (!match) return null;
    const seconds = Number(match[1]);
    if (!Number.isFinite(seconds) || seconds <= 0) return null;
    durations.push(seconds);
  }
  return durations.length ? durations.reduce((sum, seconds) => sum + seconds, 0) : null;
}

function rangeForProbe(range) {
  if (!range) return true;
  if (!Number.isSafeInteger(range.length) || !Number.isSafeInteger(range.offset) || range.length < 1 || range.offset < 0 || range.offset > Number.MAX_SAFE_INTEGER - range.length) {
    throw mediaError("Invalid HLS byte range");
  }
  const length = Math.min(PROBE_PREFIX, range.length);
  return `bytes=${range.offset}-${range.offset + length - 1}`;
}

function looksLikeFile(contentType, bytes) {
  if (/^(?:video|audio)\//i.test(contentType || "")) return true;
  const ts = bytes.length >= 188 && bytes[0] === 0x47 && (bytes.length < 376 || bytes[188] === 0x47) && (bytes.length < 564 || bytes[376] === 0x47);
  return (bytes.length >= 8 && bytes.toString("ascii", 4, 8) === "ftyp")
    || (bytes.length >= 4 && bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])))
    || ts
    || bytes.subarray(0, 3).toString("ascii") === "ID3"
    || bytes.subarray(0, 4).toString("ascii") === "OggS"
    || bytes.subarray(0, 3).toString("ascii") === "FLV";
}

async function inspectRoot(transport, resource, signal) {
  const { response, url, headers, headerOrigin } = await transport.request(resource.url, { headers: headersFor(resource), publicOnly: resource.publicOnly, signal, timeout: 15_000, retryNotFound: true });
  const contentType = response.headers["content-type"] || "";
  const iterator = response[Symbol.asyncIterator]();
  const first = await iterator.next();
  if (first.done || !first.value?.length) throw mediaError("Upstream returned an empty media response");
  const firstBytes = first.value.subarray(0, PROBE_PREFIX);
  if (looksLikeErrorPage(contentType, firstBytes)) throw mediaError("Upstream returned an error page instead of media");
  if (!isPlaylist(contentType, firstBytes)) {
    response.destroy();
    if (!looksLikeFile(contentType, firstBytes)) throw mediaError("Upstream did not return a media file");
    return { kind: "file", url, bytes: firstBytes.length, headers: headers || headersFor(resource), headerOrigin: headerOrigin || url.origin };
  }
  const chunks = [first.value];
  let size = first.value.length;
  if (size > PLAYLIST_MAX) throw mediaError("HLS playlist is too large");
  while (true) {
    const next = await iterator.next();
    if (next.done) break;
    size += next.value.length;
    if (size > PLAYLIST_MAX) throw mediaError("HLS playlist is too large");
    chunks.push(next.value);
  }
  const bytes = decodeBody(Buffer.concat(chunks, size), response.headers["content-encoding"]);
  if (!isPlaylist(contentType, bytes)) throw mediaError("Upstream returned an invalid playlist");
  return { kind: "hls", url, text: bytes.toString("utf8"), headers: headers || headersFor(resource), headerOrigin: headerOrigin || url.origin, cacheControl: response.headers["cache-control"] || "no-store" };
}

export function createMedia({ transport, secret, publicOrigin = "" } = {}) {
  if (!transport || typeof transport.request !== "function") throw new TypeError("transport.request is required");
  if (typeof secret !== "string" || Buffer.byteLength(secret) < 32) throw new TypeError("secret must be at least 32 bytes");
  if (publicOrigin) {
    const origin = new URL(publicOrigin);
    if (!/^https?:$/.test(origin.protocol)) throw new TypeError("publicOrigin must use HTTP(S)");
  }
  const key = createHash("sha256").update(String(secret)).digest();

  function url(resource) {
    if (!resource || typeof resource.url !== "string") throw new TypeError("resource.url is required");
    const target = new URL(resource.url);
    if (!/^https?:$/.test(target.protocol) || target.username || target.password) throw new TypeError("resource.url must be credential-free HTTP(S)");
    return redirectUrl(publicOrigin, makeToken(resource, key));
  }

  const playlistCache = new Map();
  function playlistKey(resource) {
    return createHash("sha256").update(JSON.stringify([String(resource.url), resource.publicOnly === true,
      resource.headerOrigin || new URL(resource.url).origin, Object.entries(headersFor(resource)).sort(([a], [b]) => a.localeCompare(b))])).digest("hex");
  }
  function cachePlaylists(documents) {
    for (const [key, value] of playlistCache) if (value.expires <= Date.now()) playlistCache.delete(key);
    for (const { resource, playlist } of documents) {
      if (resource.publicOnly !== true || new URL(resource.url).href !== playlist.url.href
        || Buffer.byteLength(playlist.text) > PLAYLIST_CACHE_BYTES) continue;
      const key = playlistKey(resource);
      playlistCache.delete(key);
      if (playlistCache.size >= PLAYLIST_CACHE_LIMIT) playlistCache.delete(playlistCache.keys().next().value);
      playlistCache.set(key, { playlist, expires: Date.now() + PLAYLIST_CACHE_MS });
    }
  }
  async function sendPlaylist(req, res, resource, playlist, statusCode, range, signal) {
    const inherited = { ...resource, headers: playlist.headers || resource.headers,
      headerOrigin: playlist.headerOrigin || playlist.url.origin };
    const compactChildUrl = resource.nodeOnly === true && resource.publicOnly === true
      ? makeCompactChildUrl(inherited, playlist.url, key, publicOrigin) : null;
    const rewritten = rewritePlaylist(playlist.text, playlist.url, (childUrl) => compactChildUrl
      ? compactChildUrl(childUrl)
      : url({ url: childUrl, headers: inherited.headers, headerOrigin: inherited.headerOrigin,
        nodeOnly: resource.nodeOnly, publicOnly: resource.publicOnly }));
    let payload = Buffer.from(rewritten);
    const output = { "content-type": "application/vnd.apple.mpegurl", "cache-control": playlist.cacheControl || "no-store", vary: "Accept-Encoding" };
    const acceptsGzip = String(req.headers["accept-encoding"] || "").toLowerCase().split(",").some((encoding) => {
      const match = /^gzip(?:\s*;\s*q=(0(?:\.\d{0,3})?|1(?:\.0{0,3})?))?$/.exec(encoding.trim());
      return match && Number(match[1] ?? 1) > 0;
    });
    if (!range && statusCode === 200 && payload.length >= 1024 && acceptsGzip) {
      const compressed = await gzipAsync(payload, { level: 1 });
      if (compressed.length < payload.length) {
        payload = compressed;
        output["content-encoding"] = "gzip";
      }
    }
    if (signal?.aborted) return;
    output["content-length"] = payload.length;
    res.writeHead(statusCode, output);
    res.end(payload);
    return;
  }

  async function handle(req, res, token) {
    let resource;
    try { resource = parseToken(token, key); }
    catch (error) { responseError(res, error.status || 404, "Media token is invalid or expired"); return; }
    const range = parseRange(req.headers.range);
    if (range === false) { responseError(res, 416, "Invalid range"); return; }
    const abort = new AbortController();
    const onClose = () => { if (!res.writableEnded) abort.abort(); };
    req.once("aborted", onClose);
    res.once("close", onClose);
    try {
      const cached = req.method === "GET" && !range ? playlistCache.get(playlistKey(resource)) : null;
      if (cached?.expires > Date.now()) {
        await sendPlaylist(req, res, resource, cached.playlist, 200, null, abort.signal);
        return;
      }
      if (cached) playlistCache.delete(playlistKey(resource));
      const headers = headersFor(resource);
      const requestedRange = rangeHeader(range);
      if (requestedRange) headers.range = requestedRange;
      const { response, url: finalUrl, headers: upstreamHeaders, headerOrigin } = await transport.request(resource.url, { headers, publicOnly: resource.publicOnly, method: req.method === "HEAD" ? "HEAD" : "GET", signal: abort.signal, timeout: 30_000, retryNotFound: true });
      const type = response.headers["content-type"] || "application/octet-stream";
      const honoredRange = !range || response.statusCode === 206;
      if (req.method === "HEAD" && looksLikeErrorPage(type, Buffer.alloc(0))) {
        response.resume();
        throw mediaError("Upstream returned an error page instead of media");
      }
      if (req.method === "HEAD") {
        const output = Object.fromEntries(RESPONSE_HEADERS
          .filter((name) => response.headers[name] !== undefined && (honoredRange || name !== "content-range"))
          .map((name) => [name, response.headers[name]]));
        res.writeHead(response.statusCode || 200, output);
        res.end();
        response.resume();
        return;
      }
      const iterator = response[Symbol.asyncIterator]();
      const playlistType = /mpegurl|vnd\.apple\.mpegurl/i.test(type);
      const initial = [];
      let initialSize = 0;
      let pendingNext = null;
      const sniffDeadline = Date.now() + 50;
      while (initialSize < (playlistType || /^(?:video|audio)\//i.test(type) ? 1 : 7)) {
        let part;
        if (pendingNext) {
          const remaining = sniffDeadline - Date.now();
          if (remaining <= 0) break;
          let timer;
          const result = await Promise.race([
            pendingNext.then((value) => ({ value })),
            new Promise((resolve) => { timer = setTimeout(() => resolve({ timeout: true }), remaining); }),
          ]);
          clearTimeout(timer);
          if (result.timeout) break;
          part = result.value;
          pendingNext = null;
        } else {
          part = await iterator.next();
        }
        if (part.done) break;
        initial.push(part.value);
        initialSize += part.value.length;
        if (!playlistType && !/^(?:video|audio)\//i.test(type)) {
          const currentPrefix = Buffer.concat(initial, initialSize).toString("utf8").trimStart();
          if (!"#EXTM3U".startsWith(currentPrefix)) break;
          if (currentPrefix.length >= 7) break;
          pendingNext = iterator.next();
        }
      }
      if (!initialSize) throw mediaError("Upstream returned an empty media response");
      const prefix = Buffer.concat(initial, initialSize);
      if (looksLikeErrorPage(type, prefix)) throw mediaError("Upstream returned an error page instead of media");
      if (playlistType || isPlaylist(type, prefix)) {
        const chunks = initial.slice();
        let size = initialSize;
        if (size > PLAYLIST_MAX) throw mediaError("HLS playlist is too large");
        while (true) {
          const part = pendingNext ? await pendingNext : await iterator.next();
          pendingNext = null;
          if (part.done) break;
          size += part.value.length;
          if (size > PLAYLIST_MAX) {
            response.destroy();
            throw mediaError("HLS playlist is too large");
          }
          chunks.push(part.value);
        }
        const body = decodeBody(Buffer.concat(chunks, size), response.headers["content-encoding"]);
        if (looksLikeErrorPage(type, body) || !isPlaylist(type, body)) throw mediaError("Upstream returned an invalid playlist");
        await sendPlaylist(req, res, resource, { text: body.toString("utf8"), url: finalUrl,
          headers: upstreamHeaders, headerOrigin, cacheControl: response.headers["cache-control"] }, response.statusCode || 200, range, abort.signal);
        return;
      }
      const outputHeaders = Object.fromEntries(RESPONSE_HEADERS
        .filter((name) => response.headers[name] !== undefined && (honoredRange || name !== "content-range"))
        .map((name) => [name, response.headers[name]]));
      if (!outputHeaders["content-type"]) outputHeaders["content-type"] = type;
      res.writeHead(response.statusCode || 200, outputHeaders);
      let bytes = 0;
      const write = async (chunk) => {
        if (!chunk?.length) return;
        bytes += chunk.length;
        if (!res.write(chunk)) await new Promise((resolve) => {
          const finish = () => {
            res.removeListener("drain", finish);
            res.removeListener("close", finish);
            abort.signal.removeEventListener("abort", finish);
            resolve();
          };
          res.once("drain", finish);
          res.once("close", finish);
          abort.signal.addEventListener("abort", finish, { once: true });
        });
      };
      for (const part of initial) await write(part);
      while (!abort.signal.aborted) {
        const next = pendingNext ? await pendingNext : await iterator.next();
        pendingNext = null;
        if (next.done) break;
        const chunk = next.value;
        if (abort.signal.aborted) break;
        await write(chunk);
      }
      if (!res.writableEnded && !abort.signal.aborted) res.end();
    } catch (error) {
      if (abort.signal.aborted) return;
      console.error("Media upstream failed", error.code || error.name, error.status || 502, error.targetHost || new URL(resource.url).host, error.dnsCode || "");
      responseError(res, error.status === 504 ? 504 : 502, error.status === 416 ? "Invalid range" : "Media source unavailable");
    } finally {
      req.removeListener("aborted", onClose);
      res.removeListener("close", onClose);
    }
  }

  async function probe(resource, { signal } = {}) {
    const pending = new AbortController();
    signal = signal ? AbortSignal.any([signal, pending.signal]) : pending.signal;
    try {
      let inspected = await inspectRoot(transport, resource, signal);
      if (inspected.kind === "file") return {
        ok: true,
        ...(resource.publicOnly === true ? { publicOnly: true } : {}),
        kind: "file",
        url: inspected.url.toString(),
        headers: inspected.headers,
        headerOrigin: inspected.headerOrigin,
        bytes: inspected.bytes,
      };
      let playlist = inspected;
      const documents = [{ resource, playlist }];
      let masters = 0;
      while (true) {
        const variant = firstVariant(playlist.text);
        if (!variant) break;
        if (masters >= 3) throw mediaError("Too many HLS master playlist levels");
        masters++;
        const child = {
          ...resource,
          url: new URL(variant, playlist.url).toString(),
          headers: playlist.headers,
          headerOrigin: playlist.headerOrigin,
        };
        playlist = await readPlaylist(transport, child, signal);
        documents.push({ resource: child, playlist });
      }
      const parts = firstMediaSegment(playlist.text);
      if (!parts.segment) throw mediaError("HLS playlist has no media segment");
      const checks = [
        parts.map && { url: new URL(parts.map, playlist.url).toString(), range: rangeForProbe(parts.mapRange) },
        parts.key && { url: new URL(parts.key, playlist.url).toString(), range: false, key: true },
        { url: new URL(parts.segment, playlist.url).toString(), range: rangeForProbe(parts.segmentRange) },
      ].filter(Boolean);
      const chunks = await Promise.all(checks.map(async (check) => {
        const bytes = await readProbeBytes(transport, check.url,
          headersFor({ ...resource, url: check.url, headers: playlist.headers, headerOrigin: playlist.headerOrigin }),
          signal, check.range, resource.publicOnly);
        if (check.key && bytes.length !== 16) throw mediaError("Invalid AES-128 HLS key");
        return bytes;
      }));
      signal.throwIfAborted();
      const segment = chunks.at(-1);
      if (vodDuration(playlist.text) != null) cachePlaylists(documents);
      return {
        ok: true,
        ...(resource.publicOnly === true ? { publicOnly: true } : {}),
        kind: "hls",
        url: inspected.url.toString(),
        headers: inspected.headers,
        headerOrigin: inspected.headerOrigin,
        bytes: segment.length,
        initBytes: parts.map ? true : false,
        encrypted: parts.key ? true : false,
        duration: vodDuration(playlist.text),
      };
    } catch (error) {
      console.warn("Media probe failed", error.code || error.name, error.status || 502, error.targetHost || new URL(resource.url).host, error.dnsCode || "");
      return { ok: false, kind: null, reason: error.status === 504 ? "timeout" : error.name === "AbortError" ? "aborted" : error.code || "probe-failed" };
    } finally { pending.abort(); }
  }

  return { url, handle, probe, resource: (token) => parseToken(token, key) };
}
