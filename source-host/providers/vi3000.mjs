import { createLampacProvider } from "./lampac.mjs";

const ORIGIN = "https://api-m.vi3000.top";
const REGISTRY = `${ORIGIN}/api/plugin/lampac/hosts`;
const BODY_LIMIT = 1024 * 1024;
const HOST_TTL = 10 * 60 * 1000;

export function parseVi3000Response(text) {
  const value = text.trim();
  const embedded = /^</.test(value) ? /data-json=(["'])(.*?)\1/is.exec(value)?.[2] : value;
  if (!embedded) throw new Error("vi3000 did not return structured source data");
  try {
    const json = JSON.parse(embedded);
    if (!json || typeof json !== "object") throw new Error();
    return json;
  } catch { throw new Error("vi3000 returned invalid source JSON"); }
}

export function createVi3000Provider({ transport } = {}) {
  if (typeof transport?.request !== "function") throw new TypeError("transport.request is required");
  let hosts = [];
  let hostsAt = 0;

  async function readJson(rawUrl, { signal, timeout = 12_000 } = {}) {
    timeout = Math.min(timeout, 12_000);
    const bounded = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout);
    const { response } = await transport.request(rawUrl, { signal: bounded, timeout, publicOnly: true, headers: { accept: "application/json" } });
    const abort = () => response.destroy(bounded.reason);
    bounded.addEventListener("abort", abort, { once: true });
    try {
      bounded.throwIfAborted();
      if (Number(response.headers["content-length"]) > BODY_LIMIT) throw new Error("vi3000 source response is too large");
      const chunks = [];
      let size = 0;
      for await (const chunk of response) {
        size += chunk.length;
        if (size > BODY_LIMIT) throw new Error("vi3000 source response is too large");
        chunks.push(chunk);
      }
      bounded.throwIfAborted();
      return parseVi3000Response(Buffer.concat(chunks, size).toString("utf8"));
    } finally {
      bounded.removeEventListener("abort", abort);
      response.destroy();
    }
  }

  async function registry(signal) {
    if (hosts.length && Date.now() - hostsAt < HOST_TTL) return hosts;
    const json = await readJson(REGISTRY, { signal, timeout: 8_000 });
    if (!Array.isArray(json.hosts)) throw new Error("vi3000 host registry is unavailable");
    const valid = [...new Set(json.hosts.filter((host) => typeof host === "string" && host.length <= 253
      && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(host))
      .map((host) => host.toLowerCase()))].slice(0, 20);
    if (!valid.length) throw new Error("vi3000 host registry has no valid public hosts");
    hosts = valid;
    hostsAt = Date.now();
    return hosts;
  }

  function adapter(origin) {
    return createLampacProvider({
      baseUrl: origin,
      providerFilter: (provider) => /^[a-z0-9_-]{1,64}$/i.test(String(provider?.balanser || ""))
        && provider.balanser !== "pidtor" && provider.show !== false && provider.enable !== false,
      fetchJson: async (rawUrl, opts) => {
        const url = new URL(rawUrl);
        if (origin === ORIGIN && url.pathname === "/lite/events") {
          const id = url.searchParams.get("tmdb_id");
          if (!/^[1-9]\d*$/.test(id || "")) return [];
          const filmix = new URL("/api/filmix/lite", ORIGIN);
          filmix.searchParams.set("id", id);
          filmix.searchParams.set("source", "tmdb");
          return [{ balanser: "filmix", name: "Filmix", url: filmix.href }];
        }
        return readJson(url, opts);
      },
    });
  }

  function wrap(candidate) {
    const value = { ...candidate, providerId: `vi3000:${candidate.providerId}`,
      providerName: `vi3000 · ${candidate.providerName || candidate.providerId}`, catalogSource: "vi3000" };
    if (candidate.ref) Object.defineProperty(value, "ref", { value: candidate.ref, enumerable: false });
    return value;
  }

  async function* discover(title, { signal } = {}) {
    signal?.throwIfAborted();
    for await (const candidate of adapter(ORIGIN).discover(title, { signal })) yield wrap(candidate);
    let registered;
    try { registered = await registry(signal); }
    catch (error) {
      signal?.throwIfAborted();
      yield { providerId: "vi3000:registry", providerName: "vi3000", error: "vi3000 host registry is unavailable" };
      return;
    }
    for (const host of registered) {
      let found = false;
      try {
        for await (const candidate of adapter(`https://${host}`).discover(title, { signal })) {
          if (candidate.ref) found = true;
          yield wrap(candidate);
        }
      } catch (error) {
        signal?.throwIfAborted();
        yield { providerId: "vi3000:registry", providerName: "vi3000", error: "vi3000 source host is unavailable" };
      }
      if (found) return;
    }
  }

  async function resolve(candidate, { signal } = {}) {
    if (candidate?.catalogSource !== "vi3000" || !/^vi3000:[a-z0-9_-]{1,64}$/i.test(candidate.providerId || "")) throw new Error("Invalid vi3000 source reference");
    const origin = candidate.ref?.origin;
    if (origin !== ORIGIN && !(await registry(signal)).some((host) => origin === `https://${host}`)) throw new Error("Unregistered vi3000 source origin");
    const resolved = await adapter(origin).resolve({ ...candidate, ref: candidate.ref, providerId: candidate.providerId.slice(7) }, { signal });
    return { ...resolved, qualities: resolved.qualities.map((quality) => ({ ...quality, publicOnly: true })),
      subtitles: (resolved.subtitles || []).map((subtitle) => ({ ...subtitle, publicOnly: true })) };
  }

  return { discover, resolve };
}
