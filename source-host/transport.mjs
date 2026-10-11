import dns from "node:dns/promises";
import { createDecipheriv } from "node:crypto";
import http from "node:http";
import https from "node:https";
import net from "node:net";

const MAX_REDIRECTS = 5;
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const MAX_PROXY_TOKEN = 48 * 1024;
const PROXY_HEADER_ALLOWLIST = new Set(["referer", "origin", "user-agent", "accept", "accept-language", "cookie"]);
const REQUEST_HEADER_ALLOWLIST = new Set([...PROXY_HEADER_ALLOWLIST, "range", "accept-encoding"]);

export class TransportError extends Error {
  constructor(message, { code = "UPSTREAM_ERROR", status = 502, cause } = {}) {
    super(message, { cause });
    this.name = "TransportError";
    this.code = code;
    this.status = status;
  }
}

function ipv4Number(address) {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return parts.reduce((n, part) => n * 256 + part, 0);
}

function inV4(address, base, bits) {
  const ip = ipv4Number(address);
  const network = ipv4Number(base);
  return ip !== null && network !== null && Math.floor(ip / 2 ** (32 - bits)) === Math.floor(network / 2 ** (32 - bits));
}

function ipv6Number(address) {
  let value = address.toLowerCase().split("%", 1)[0];
  if (value.includes(".")) {
    const split = value.lastIndexOf(":");
    const v4 = ipv4Number(value.slice(split + 1));
    if (v4 === null) return null;
    value = `${value.slice(0, split)}:${(v4 >>> 16).toString(16)}:${(v4 & 0xffff).toString(16)}`;
  }
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const words = [...left, ...Array(missing).fill("0"), ...right];
  if (words.length !== 8 || words.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null;
  return words.reduce((n, part) => (n << 16n) | BigInt(`0x${part}`), 0n);
}

function isPrivateAddress(address) {
  const version = net.isIP(address);
  if (version === 4) return [
    ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
    ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
    ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24], ["203.0.113.0", 24],
    ["224.0.0.0", 4],
  ].some(([base, bits]) => inV4(address, base, bits));
  if (version !== 6) return true;
  const value = ipv6Number(address);
  if (value === null) return true;
  if ((value >> 32n) === 0xffffn) {
    const v4 = Number(value & 0xffffffffn);
    return isPrivateAddress([v4 >>> 24, (v4 >>> 16) & 255, (v4 >>> 8) & 255, v4 & 255].join("."));
  }
  const prefix = (bits) => value >> BigInt(128 - bits);
  return value === 0n || value === 1n
    || prefix(7) === 0x7en // fc00::/7
    || prefix(10) === 0x3fan // fe80::/10
    || prefix(8) === 0xffn // multicast
    || prefix(32) === 0x20010db8n; // documentation range is never a public destination
}

function abortError(signal) {
  return signal?.reason instanceof Error
    ? signal.reason
    : Object.assign(new Error("Request aborted"), { name: "AbortError", code: "ABORT_ERR" });
}

async function lookupPublicHost(hostname, signal, timeout, lookup = dns.lookup) {
  if (signal?.aborted) throw abortError(signal);
  let timer;
  let onAbort;
  try {
    return await Promise.race([
      lookup(hostname, { all: true, verbatim: true }),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new TransportError("Upstream DNS lookup timed out", { code: "UPSTREAM_TIMEOUT", status: 504 })), timeout);
        onAbort = () => reject(abortError(signal));
        signal?.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (onAbort) signal?.removeEventListener("abort", onAbort);
  }
}

async function validateDestination(url, engineOrigin, signal, timeout, lookup) {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new TransportError("Unsupported upstream protocol", { code: "BAD_URL" });
  if (url.username || url.password) throw new TransportError("Upstream credentials are not allowed", { code: "BAD_URL" });
  if (url.origin === engineOrigin) {
    if (!/^\/(?:lite|proxy)(?:\/|$)/.test(url.pathname)) throw new TransportError("Engine path is not allowed", { code: "BAD_URL" });
    return null;
  }
  let addresses;
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  try {
    addresses = net.isIP(hostname)
      ? [{ address: hostname, family: net.isIP(hostname) }]
      : await lookupPublicHost(hostname, signal, timeout, lookup);
  } catch (cause) {
    if (cause instanceof TransportError || cause.name === "AbortError") throw cause;
    throw Object.assign(new TransportError("Upstream DNS lookup failed", { code: "DNS_ERROR", cause }), {
      targetHost: hostname,
      dnsCode: cause.code || cause.name,
    });
  }
  if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
    throw new TransportError("Private upstream destination is not allowed", { code: "SSRF_BLOCKED" });
  }
  return addresses;
}

function decryptProxyPayload(pathname, key) {
  if (!key) return null;
  const match = /^\/proxy\/([A-Za-z0-9_-]+)(?:\.[A-Za-z0-9]{1,5})?$/.exec(pathname);
  if (!match || match[1].length > MAX_PROXY_TOKEN || match[1].length % 4 === 1) return null;
  try {
    const ciphertext = Buffer.from(match[1], "base64url");
    if (ciphertext.length < 32 || ciphertext.length > MAX_PROXY_TOKEN) return null;
    const iv = ciphertext.subarray(0, 16);
    const decipher = createDecipheriv("aes-128-cbc", key, iv);
    const payload = JSON.parse(Buffer.concat([decipher.update(ciphertext.subarray(16)), decipher.final()]).toString("utf8"));
    if (!payload || typeof payload.u !== "string" || Buffer.byteLength(payload.u) > 8192) return null;
    return payload;
  } catch {
    // MD5 and legacy non-AES proxy links are intentionally left to Lampac.
    return null;
  }
}

function proxyHeaders(payload, requestHeaders) {
  const merged = new Map();
  const provider = new Map();
  const add = (name, value, allowlist) => {
    const key = name.toLowerCase();
    if (!allowlist.has(key) || typeof value !== "string" || /[\r\n]/.test(value)) return;
    merged.set(key, value);
    if (PROXY_HEADER_ALLOWLIST.has(key)) provider.set(key, value);
  };
  if (payload.h && typeof payload.h === "object" && !Array.isArray(payload.h)) {
    for (const [name, value] of Object.entries(payload.h)) if (typeof name === "string") add(name, value, PROXY_HEADER_ALLOWLIST);
  }
  for (const [name, value] of Object.entries(requestHeaders || {})) add(name, value, REQUEST_HEADER_ALLOWLIST);
  return { request: Object.fromEntries(merged), provider: Object.fromEntries(provider) };
}

function allowedProviderHeaders(headers) {
  return Object.fromEntries(Object.entries(headers || {}).filter(([name, value]) =>
    PROXY_HEADER_ALLOWLIST.has(name.toLowerCase()) && typeof value === "string" && !/[\r\n]/.test(value))
    .map(([name, value]) => [name.toLowerCase(), value]));
}

function dropCookie(headers) {
  for (const name of Object.keys(headers)) if (name.toLowerCase() === "cookie") delete headers[name];
}

function requestOnce(url, { headers, method, signal, timeout, addresses }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal));
    const client = url.protocol === "https:" ? https : http;
    const pinnedLookup = addresses ? (_host, options, callback) => {
      const records = addresses.map(({ address, family }) => ({ address, family }));
      if (options?.all) callback(null, records);
      else callback(null, records[0].address, records[0].family);
    } : undefined;
    const req = client.request(url, {
      method,
      headers,
      lookup: pinnedLookup,
      servername: url.protocol === "https:" && net.isIP(url.hostname.replace(/^\[|\]$/g, "")) ? undefined : url.hostname.replace(/^\[|\]$/g, ""),
    });
    const timer = setTimeout(() => req.destroy(new TransportError("Upstream request timed out", { code: "UPSTREAM_TIMEOUT", status: 504 })), timeout);
    timer.unref?.();
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => req.destroy(abortError(signal));
    signal?.addEventListener("abort", onAbort, { once: true });
    req.once("response", (response) => {
      response.once("end", cleanup);
      response.once("close", cleanup);
      response.once("error", cleanup);
      resolve(response);
    });
    req.once("error", (error) => { cleanup(); reject(error); });
    req.end();
  });
}

function awaitEnd(response) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    response.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_JSON_BYTES) {
        response.destroy(new TransportError("Upstream JSON is too large", { code: "JSON_TOO_LARGE", status: 502 }));
        return;
      }
      chunks.push(chunk);
    });
    response.once("end", () => resolve(Buffer.concat(chunks, size)));
    response.once("aborted", () => reject(new TransportError("Upstream response ended early", { code: "UPSTREAM_TRUNCATED" })));
    response.once("error", (cause) => reject(cause instanceof TransportError ? cause : new TransportError("Upstream response read failed", { code: "UPSTREAM_READ_ERROR", cause })));
    response.once("close", () => {
      if (!response.complete) reject(new TransportError("Upstream response ended early", { code: "UPSTREAM_TRUNCATED" }));
    });
  });
}

export function createTransport({ engineUrl, engineKey, lookup = dns.lookup, requestOnceImpl = requestOnce, beforeEngineRequest } = {}) {
  const engine = new URL(engineUrl);
  if (!['http:', 'https:'].includes(engine.protocol)) throw new TypeError("engineUrl must use HTTP(S)");
  if (engineKey !== undefined && (typeof engineKey !== "string" || !/^[0-9a-f]{32}$/i.test(engineKey))) throw new TypeError("engineKey must be a 16-byte hex key");
  if (beforeEngineRequest !== undefined && typeof beforeEngineRequest !== "function") throw new TypeError("beforeEngineRequest must be a function");
  const proxyKey = engineKey ? Buffer.from(engineKey, "hex") : null;
  const engineOrigin = engine.origin;

  function unwrapResource(rawUrl, headers = {}) {
    let url = new URL(rawUrl, engine);
    let requestHeaders = { ...headers };
    let providerHeaders = allowedProviderHeaders(headers);
    let trustedEngine = engineOrigin;
    if (url.origin === engineOrigin) {
      const payload = decryptProxyPayload(url.pathname, proxyKey);
      if (payload) {
        try { url = new URL(payload.u); }
        catch { throw new TransportError("Lampac proxy payload has an invalid media URL", { code: "BAD_URL" }); }
        const decryptedHeaders = proxyHeaders(payload, headers);
        requestHeaders = decryptedHeaders.request;
        providerHeaders = decryptedHeaders.provider;
        trustedEngine = null;
      }
    }
    return { url, requestHeaders, providerHeaders, trustedEngine };
  }

  async function route(resource, { signal, timeout = 15_000 } = {}) {
    const headers = { ...(resource.headers || {}) };
    if (resource.headerOrigin && new URL(resource.url).origin !== resource.headerOrigin) dropCookie(headers);
    const { url, providerHeaders, trustedEngine } = unwrapResource(resource.url, headers);
    await validateDestination(url, trustedEngine, signal, timeout, lookup);
    return { kind: url.origin === engineOrigin ? "engine" : "direct", url: url.toString(), headers: providerHeaders, headerOrigin: url.origin };
  }

  async function request(rawUrl, { headers = {}, method = "GET", signal, timeout = 15_000, retryNotFound = false } = {}) {
    let { url, requestHeaders, providerHeaders, trustedEngine } = unwrapResource(rawUrl, headers);
    let deadline = Date.now() + timeout;
    let redirects = 0;
    let notFoundRetries = 0;
    while (true) {
      if (signal?.aborted) throw abortError(signal);
      if (url.origin === engineOrigin) {
        const payload = decryptProxyPayload(url.pathname, proxyKey);
        if (payload) {
          try { url = new URL(payload.u); }
          catch { throw new TransportError("Lampac proxy payload has an invalid media URL", { code: "BAD_URL" }); }
          // The new proxy payload defines target-specific headers. Carry only
          // range/encoding controls across this hop; never leak stale cookies
          // or origin headers from the redirecting host.
          const passthrough = Object.fromEntries(Object.entries(requestHeaders)
            .filter(([name]) => ["range", "accept-encoding"].includes(name.toLowerCase())));
          const decryptedHeaders = proxyHeaders(payload, passthrough);
          requestHeaders = decryptedHeaders.request;
          providerHeaders = decryptedHeaders.provider;
          trustedEngine = null;
        }
      }
      let remaining = deadline - Date.now();
      if (remaining <= 0) throw new TransportError("Upstream request timed out", { code: "UPSTREAM_TIMEOUT", status: 504 });
      const addresses = await validateDestination(url, trustedEngine, signal, remaining, lookup);
      if (url.origin === engineOrigin && trustedEngine === engineOrigin && beforeEngineRequest) {
        const waitStarted = Date.now();
        await beforeEngineRequest(signal);
        deadline += Date.now() - waitStarted;
        if (signal?.aborted) throw abortError(signal);
        remaining = deadline - Date.now();
        if (remaining <= 0) throw new TransportError("Upstream request timed out", { code: "UPSTREAM_TIMEOUT", status: 504 });
      }
      let response;
      try {
        response = await requestOnceImpl(url, { headers: requestHeaders, method, signal, timeout: deadline - Date.now(), addresses });
      } catch (cause) {
        if (cause instanceof TransportError || cause.name === "AbortError") throw cause;
        throw new TransportError("Upstream request failed", { code: "UPSTREAM_CONNECT_ERROR", cause });
      }
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        if (redirects >= MAX_REDIRECTS) throw new TransportError("Too many upstream redirects", { code: "TOO_MANY_REDIRECTS" });
        redirects++;
        const redirected = new URL(response.headers.location, url);
        if (redirected.origin !== url.origin) {
          dropCookie(requestHeaders);
          dropCookie(providerHeaders);
        }
        url = redirected;
        continue;
      }
      if (response.statusCode >= 400) {
        const status = response.statusCode;
        response.resume();
        if (signal?.aborted) throw abortError(signal);
        if (retryNotFound === true && status === 404 && notFoundRetries === 0
          && (method.toUpperCase() === "GET" || method.toUpperCase() === "HEAD")
          && url.origin !== engineOrigin && !signal?.aborted) {
          notFoundRetries++;
          continue;
        }
        throw new TransportError(`Upstream returned HTTP ${status}`, { code: "UPSTREAM_HTTP_ERROR", status });
      }
      return { response, url, headers: providerHeaders, headerOrigin: url.origin };
    }
  }

  async function json(rawUrl, { signal, timeout = 45_000 } = {}) {
    const { response } = await request(rawUrl, { signal, timeout, headers: { accept: "application/json" } });
    const bytes = await awaitEnd(response);
    try { return JSON.parse(bytes.toString("utf8")); }
    catch (cause) { throw new TransportError("Upstream returned invalid JSON", { code: "INVALID_JSON", cause }); }
  }

  return { request, json, route };
}
