const MAX_TOKEN_LENGTH = 48 * 1024;
const MAX_PLAYLIST_BYTES = 16 * 1024 * 1024;
const PROVIDER_HEADERS = new Set(["accept", "accept-language", "cookie", "origin", "referer", "user-agent"]);
const RESPONSE_HEADERS = [
  "accept-ranges", "cache-control", "content-length", "content-range", "content-type",
  "etag", "last-modified",
];

function corsHeaders(extra = {}) {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, HEAD, OPTIONS",
    "access-control-allow-headers": "Accept, Accept-Language, Range",
    "access-control-expose-headers": "Accept-Ranges, Content-Length, Content-Range, Content-Type, ETag, Last-Modified",
    ...extra,
  };
}

function filteredResponseHeaders(source) {
  const headers = new Headers();
  for (const name of RESPONSE_HEADERS) {
    const value = source.get(name);
    if (value !== null) headers.set(name, value);
  }
  return headers;
}

function safeProviderHeaders(source) {
  const headers = new Headers();
  if (!source || typeof source !== "object" || Array.isArray(source)) return headers;
  for (const [name, value] of Object.entries(source)) {
    const key = name.toLowerCase();
    if (PROVIDER_HEADERS.has(key) && typeof value === "string" && !/[\r\n]/.test(value)) headers.set(key, value);
  }
  return headers;
}

function configuredSourceOrigin(env) {
  let source;
  try { source = new URL(env.SOURCE_HOST_URL); }
  catch { throw new Error("SOURCE_HOST_URL must be an HTTPS origin"); }
  if (source.protocol !== "https:" || source.username || source.password || source.pathname !== "/" || source.search || source.hash) {
    throw new Error("SOURCE_HOST_URL must be an HTTPS origin");
  }
  return source.origin;
}

function sourceEndpoint(sourceOrigin, pathname, token) {
  const url = new URL(pathname, sourceOrigin);
  url.searchParams.set("token", token);
  return url;
}

function parseMediaRoute(value) {
  if (!value || typeof value !== "object" || !["direct", "engine"].includes(value.kind) || typeof value.url !== "string") {
    throw new Error("invalid route response");
  }
  const url = new URL(value.url);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error("invalid media URL");
  return { kind: value.kind, url, headers: safeProviderHeaders(value.headers) };
}

function isHlsUrl(url) {
  return url.pathname.toLowerCase().endsWith(".m3u8");
}

function isHlsType(contentType) {
  return /mpegurl|vnd\.apple\.mpegurl/i.test(contentType || "");
}

function isHlsPrefix(bytes) {
  const prefix = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 4096)));
  return prefix.replace(/^\uFEFF/, "").trimStart().startsWith("#EXTM3U");
}

function withCors(response) {
  const headers = filteredResponseHeaders(response.headers);
  for (const [name, value] of Object.entries(corsHeaders())) headers.set(name, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

async function readPlaylist(response) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_PLAYLIST_BYTES) throw new Error("playlist too large");
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel(error).catch(() => {});
    throw error;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

function rewriteNodeMediaUrls(text, sourceOrigin, workerOrigin) {
  const oldPrefix = `${sourceOrigin}/v1/media?`;
  const newPrefix = `${workerOrigin}/v1/media?`;
  return text.replaceAll(oldPrefix, newPrefix);
}

async function fetchAndServeNodeMedia(request, fetchImpl, sourceOrigin, token, apiKey, routeUrl) {
  let response;
  try { response = await fetchNodeMedia(fetchImpl, sourceOrigin, token, apiKey, request.method, request.signal, request.headers.get("range")); }
  catch { return internalFailure(); }
  if (!response.ok) return internalFailure(publicStatus(response.status));
  const contentType = response.headers.get("content-type") || "";
  if (!isHlsType(contentType) && !isHlsUrl(routeUrl)) return withCors(response);
  let playlist;
  try { playlist = rewriteNodeMediaUrls(await readPlaylist(response), sourceOrigin, new URL(request.url).origin); }
  catch { return internalFailure(); }
  const headers = filteredResponseHeaders(response.headers);
  headers.delete("content-length");
  headers.delete("content-range");
  headers.delete("etag");
  headers.set("content-type", contentType || "application/vnd.apple.mpegurl");
  for (const [name, value] of Object.entries(corsHeaders())) headers.set(name, value);
  return new Response(request.method === "HEAD" ? null : playlist, { status: response.status, statusText: response.statusText, headers });
}

function streamWithPrefix(response, reader, firstChunk) {
  let pending = firstChunk;
  const body = new ReadableStream({
    async pull(controller) {
      if (pending) {
        controller.enqueue(pending);
        pending = null;
        return;
      }
      try {
        const { done, value } = await reader.read();
        if (done) controller.close();
        else controller.enqueue(value);
      } catch (error) {
        controller.error(error);
      }
    },
    cancel(reason) { return reader.cancel(reason); },
  });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

function requestHeaders(request, providerHeaders) {
  const headers = new Headers(providerHeaders);
  const range = request.headers.get("range");
  if (range) headers.set("range", range);
  return headers;
}

function internalFailure(status = 502) {
  return new Response("Media source unavailable", {
    status,
    headers: corsHeaders({ "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" }),
  });
}

function publicStatus(status) {
  return [400, 401, 403, 404, 405, 410, 416, 429].includes(status) ? status : 502;
}

async function fetchNodeMedia(fetchImpl, sourceOrigin, token, apiKey, method, signal, range) {
  const url = sourceEndpoint(sourceOrigin, "/v1/media", token);
  const headers = { "x-source-relay-key": apiKey };
  if (range) headers.range = range;
  return fetchImpl(url, {
    method,
    redirect: "manual",
    signal,
    headers,
  });
}

export async function handleSourceMediaRequest(request, env, fetchImpl = fetch) {
  const workerOrigin = new URL(request.url).origin;
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders() });
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method not allowed", { status: 405, headers: corsHeaders({ allow: "GET, HEAD, OPTIONS" }) });
  }

  let sourceOrigin;
  try { sourceOrigin = configuredSourceOrigin(env); }
  catch { return internalFailure(503); }
  if (typeof env.SOURCE_API_KEY !== "string" || !env.SOURCE_API_KEY) return internalFailure(503);
  const token = new URL(request.url).searchParams.get("token") || "";
  if (!token || token.length > MAX_TOKEN_LENGTH) return internalFailure(404);

  let routeResponse;
  try {
    routeResponse = await fetchImpl(sourceEndpoint(sourceOrigin, "/v1/media-route", token), {
      method: "GET",
      redirect: "manual",
      signal: request.signal,
      headers: { authorization: `Bearer ${env.SOURCE_API_KEY}` },
    });
  } catch {
    return internalFailure();
  }
  if (!routeResponse.ok) return internalFailure(publicStatus(routeResponse.status));

  let route;
  try { route = parseMediaRoute(await routeResponse.json()); }
  catch { return internalFailure(); }

  const mediaRequestHeaders = requestHeaders(request, route.headers);
  const mediaPathLooksHls = isHlsUrl(route.url);
  if (route.kind === "engine" || mediaPathLooksHls) {
    return fetchAndServeNodeMedia(request, fetchImpl, sourceOrigin, token, env.SOURCE_API_KEY, route.url);
  }

  let response;
  try {
    response = await fetchImpl(route.url, {
      method: request.method,
      redirect: "manual",
      signal: request.signal,
      headers: mediaRequestHeaders,
    });
  } catch {
    return internalFailure();
  }
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel().catch(() => {});
    // Redirected bytes currently pass through the Node/Vercel media route.
    // If large redirected binaries need direct Worker streaming, the metadata
    // route must first return a Node-validated redirect target and safe headers.
    return fetchAndServeNodeMedia(request, fetchImpl, sourceOrigin, token, env.SOURCE_API_KEY, route.url);
  }
  if (response.status === 403 || response.status === 404) {
    await response.body?.cancel().catch(() => {});
    return fetchAndServeNodeMedia(request, fetchImpl, sourceOrigin, token, env.SOURCE_API_KEY, route.url);
  }
  if (!response.ok) {
    const status = response.status;
    await response.body?.cancel().catch(() => {});
    return internalFailure(publicStatus(status));
  }
  const contentType = response.headers.get("content-type") || "";
  if (request.method !== "HEAD" && isHlsType(contentType)) {
    await response.body?.cancel().catch(() => {});
    return fetchAndServeNodeMedia(request, fetchImpl, sourceOrigin, token, env.SOURCE_API_KEY, route.url);
  }
  if (request.method !== "HEAD" && !isHlsType(contentType) && !mediaPathLooksHls && response.body) {
    let reader;
    try {
      reader = response.body.getReader();
      const { done, value } = await reader.read();
      if (done) {
        reader.releaseLock();
        return withCors(new Response(null, { status: response.status, statusText: response.statusText, headers: response.headers }));
      }
      if (isHlsPrefix(value)) {
        await reader.cancel();
        return fetchAndServeNodeMedia(request, fetchImpl, sourceOrigin, token, env.SOURCE_API_KEY, route.url);
      }
      response = streamWithPrefix(response, reader, value);
    } catch {
      return internalFailure();
    }
  }
  return withCors(response);
}

export default {
  fetch(request, env) {
    return handleSourceMediaRequest(request, env);
  },
};
