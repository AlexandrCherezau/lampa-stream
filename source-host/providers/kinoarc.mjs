import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { parseHabsterPlayer } from "./habster.mjs";

const ORIGIN = "https://kinoarc.net";
const EMBED_ORIGIN = "https://api.nextembed.ws";
const BODY_LIMIT = 1024 * 1024;
const imdbId = (value) => typeof value === "string" && /^tt\d{7,12}$/.test(value);
const positiveId = (value) => Number.isSafeInteger(value) && value > 0;
const normalized = (value) => typeof value === "string" ? value.normalize("NFC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim() : "";

function validateTitle(title) {
  if (!title || !["movie", "tv"].includes(title.type) || (title.imdbId != null && !imdbId(title.imdbId))) throw new Error("Kinoarc needs a valid title and IMDb ID");
  if (title.type === "tv" && (!Number.isSafeInteger(title.season) || title.season < 0 || !Number.isSafeInteger(title.episode) || title.episode < 1)) throw new Error("Kinoarc needs an exact season and episode");
}

export function createKinoarcProvider({ transport } = {}) {
  if (typeof transport?.request !== "function") throw new TypeError("transport.request is required");

  async function readText(raw, signal, headers) {
    signal.throwIfAborted();
    const target = new URL(raw);
    const { response, url } = await transport.request(target, { signal, timeout: 8_000, publicOnly: true, headers: { "accept-encoding": "identity", ...headers } });
    const encoding = String(response.headers["content-encoding"] || "identity").toLowerCase();
    const decoder = encoding === "gzip" ? createGunzip() : encoding === "br" ? createBrotliDecompress() : encoding === "deflate" ? createInflate() : null;
    const body = decoder || response;
    const forwardError = (error) => decoder?.destroy(error);
    if (decoder) { response.on("error", forwardError); response.pipe(decoder); }
    const abort = () => { response.destroy(signal.reason); decoder?.destroy(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    try {
      signal.throwIfAborted();
      if (!url || String(url) !== target.href) throw new Error("Kinoarc returned an unsupported redirect");
      if (!decoder && encoding !== "identity") throw new Error("Kinoarc returned unsupported content encoding");
      if (response.statusCode < 200 || response.statusCode >= 300) throw new Error(`Kinoarc returned HTTP ${response.statusCode}`);
      if (Number(response.headers["content-length"]) > BODY_LIMIT) throw new Error("Kinoarc response is too large");
      const chunks = [];
      let size = 0;
      for await (const chunk of body) {
        size += chunk.length;
        if (size > BODY_LIMIT) throw new Error("Kinoarc response is too large");
        chunks.push(chunk);
      }
      signal.throwIfAborted();
      return Buffer.concat(chunks, size).toString("utf8");
    } finally { signal.removeEventListener("abort", abort); response.removeListener("error", forwardError); decoder?.destroy(); response.destroy(); }
  }

  async function lookup(id, signal) {
    const raw = JSON.parse(await readText(`${ORIGIN}/api/v1/players/collaps?imdb_id=${id}`, signal, { accept: "application/json" }));
    if (raw?.available === false) return null;
    if (raw?.available !== true || typeof raw.embed_url !== "string") throw new Error("Kinoarc returned invalid player data");
    const embed = new URL(raw.embed_url);
    if (embed.origin !== EMBED_ORIGIN || embed.username || embed.password || embed.search || embed.hash || embed.pathname !== `/embed/imdb/${id}`) throw new Error("Kinoarc returned an unsupported embed or title");
    return embed.href;
  }

  async function* discover(title, { signal } = {}) {
    validateTitle(title);
    const bounded = signal ? AbortSignal.any([signal, AbortSignal.timeout(8_000)]) : AbortSignal.timeout(8_000);
    bounded.throwIfAborted();
    let id = title.imdbId;
    if (!id) {
      if (!positiveId(title.tmdbId)) return;
      const path = title.type === "movie" ? "movie" : "tv";
      const data = JSON.parse(await readText(`${ORIGIN}/api/v1/catalog/tmdb/${path}/${title.tmdbId}?append_to_response=external_ids&language=ru`, bounded, { accept: "application/json" }));
      const names = [title.title, title.originalTitle].map(normalized).filter(Boolean);
      const date = title.type === "movie" ? data?.release_date : data?.first_air_date;
      if (data?.id !== title.tmdbId || ![data?.title, data?.name, data?.original_title, data?.original_name].some((name) => names.includes(normalized(name)))
        || (title.year != null && String(date || "").slice(0, 4) !== String(title.year)) || !imdbId(data?.external_ids?.imdb_id)) return;
      id = data.external_ids.imdb_id;
    }
    if (!await lookup(id, bounded)) return;
    bounded.throwIfAborted();
    const candidate = { providerId: "kinoarc:collaps", providerName: "Kinoarc · Collaps", catalogSource: "kinoarc", voiceId: "multi", voiceName: "Мультиаудио", qualityHint: "Auto", season: title.type === "tv" ? title.season : null, episode: title.type === "tv" ? title.episode : null };
    Object.defineProperty(candidate, "ref", { value: { type: title.type, imdbId: id, ...(title.type === "tv" ? { season: title.season, episode: title.episode } : {}) }, enumerable: false });
    yield candidate;
  }

  async function resolve(candidate, { signal } = {}) {
    const ref = candidate?.ref;
    if (candidate?.providerId !== "kinoarc:collaps" || candidate.catalogSource !== "kinoarc" || candidate.voiceId !== "multi" || !ref || !imdbId(ref.imdbId)
      || (ref.type === "tv" ? candidate.season !== ref.season || candidate.episode !== ref.episode : ref.type !== "movie" || candidate.season != null || candidate.episode != null || ref.season != null || ref.episode != null)) throw new Error("Invalid Kinoarc source reference");
    validateTitle(ref);
    const bounded = signal ? AbortSignal.any([signal, AbortSignal.timeout(8_000)]) : AbortSignal.timeout(8_000);
    const embed = await lookup(ref.imdbId, bounded);
    if (!embed) throw new Error("Kinoarc did not return the requested title");
    const parsed = parseHabsterPlayer(await readText(embed, bounded, { referer: `${ORIGIN}/`, origin: ORIGIN, accept: "text/html" }), ref);
    const headers = { referer: embed, origin: EMBED_ORIGIN };
    return { qualities: [{ label: "Auto", type: "hls", url: parsed.hls, headers, publicOnly: true }], audioNames: parsed.audioNames,
      subtitles: parsed.subtitles.map((subtitle) => ({ ...subtitle, headers, publicOnly: true })) };
  }
  return { discover, resolve };
}
