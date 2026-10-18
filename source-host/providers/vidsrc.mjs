const ORIGIN = "https://vidsrc.pm";
const BODY_LIMIT = 1024 * 1024;
const KEY_TTL = 10 * 60_000;

const normalized = (value) => typeof value === "string"
  ? value.normalize("NFC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim() : "";
const positiveId = (value) => ["string", "number"].includes(typeof value) && /^[1-9]\d*$/.test(String(value))
  && Number.isSafeInteger(Number(value)) ? Number(value) : null;

function validateTitle(title) {
  const tmdbId = positiveId(title?.tmdbId);
  if (!title || !["movie", "tv"].includes(title.type) || !tmdbId
    || ![title.title, title.originalTitle].some((name) => normalized(name))) {
    throw new Error("VidSrc needs a valid TMDB ID, title and type");
  }
  if (title.type === "tv" && (!Number.isSafeInteger(title.season) || title.season < 0
    || !Number.isSafeInteger(title.episode) || title.episode < 1)) throw new Error("VidSrc needs an exact season and episode");
  if (title.year != null && (!Number.isSafeInteger(title.year) || title.year < 1880 || title.year > 2200)) {
    throw new Error("VidSrc needs a valid release year");
  }
  if (title.imdbId != null && !/^tt\d{5,12}$/.test(title.imdbId)) throw new Error("VidSrc received an invalid IMDb ID");
  return tmdbId;
}

function metadataMatches(data, ref) {
  const tmdbId = positiveId(data?.tmdb_id);
  const names = [ref.title, ref.originalTitle].map(normalized).filter(Boolean);
  return data?.result === true && data.type === ref.type && tmdbId === ref.tmdbId
    && typeof data.title === "string" && names.includes(normalized(data.title))
    && (ref.year == null || Number(data.year) === ref.year)
    && (!ref.imdbId || data.imdb_id === ref.imdbId)
    && (ref.type !== "tv" || (Number(data.season) === ref.season && Number(data.episode) === ref.episode));
}

function mediaUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error("VidSrc returned an invalid media URL"); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error("VidSrc returned an unsupported media URL");
  return url.href;
}

function parsePlayerKey(script) {
  if (typeof script !== "string" || script.length > BODY_LIMIT) throw new Error("VidSrc player bundle is too large");
  const keys = new Set([...script.matchAll(/[`"']([0-9a-f]{64})[`"']/gi)].map((match) => match[1]));
  if (keys.size !== 1) throw new Error("VidSrc player key is unavailable or ambiguous");
  return [...keys][0];
}

function subtitleTracks(value) {
  if (!Array.isArray(value) || value.length > 64) throw new Error("VidSrc returned invalid subtitle tracks");
  return value.filter((track) => track && typeof track === "object" && track.file).map((track, index) => ({
    url: mediaUrl(track.file), label: typeof track.label === "string" && track.label.trim() ? track.label.trim() : `Субтитры ${index + 1}`,
    language: null,
  }));
}

export function createVidSrcProvider({ transport } = {}) {
  if (typeof transport?.request !== "function") throw new TypeError("transport.request is required");
  let keyCache = null;

  async function readText(rawUrl, { signal, headers = {} } = {}) {
    const bounded = signal ? AbortSignal.any([signal, AbortSignal.timeout(12_000)]) : AbortSignal.timeout(12_000);
    const { response } = await transport.request(rawUrl, { signal: bounded, timeout: 12_000, publicOnly: true, headers });
    const abort = () => response.destroy(bounded.reason);
    bounded.addEventListener("abort", abort, { once: true });
    try {
      bounded.throwIfAborted();
      if (response.statusCode < 200 || response.statusCode >= 300) throw new Error(`VidSrc returned HTTP ${response.statusCode}`);
      if (Number(response.headers["content-length"]) > BODY_LIMIT) throw new Error("VidSrc response is too large");
      const chunks = [];
      let size = 0;
      for await (const chunk of response) {
        size += chunk.length;
        if (size > BODY_LIMIT) throw new Error("VidSrc response is too large");
        chunks.push(chunk);
      }
      bounded.throwIfAborted();
      return Buffer.concat(chunks, size).toString("utf8");
    } finally {
      bounded.removeEventListener("abort", abort);
      response.destroy();
    }
  }

  async function playerKey(signal) {
    if (keyCache?.expires > Date.now()) return keyCache.value;
    const html = await readText(`${ORIGIN}/`, { signal, headers: { accept: "text/html" } });
    const assets = [...html.matchAll(/(?:src\s*=\s*["']|)(\/assets\/main-[A-Za-z0-9_-]+\.js)(?:["'])/g)].map((match) => match[1]);
    if (assets.length !== 1) throw new Error("VidSrc player bundle is missing or ambiguous");
    const bundleUrl = new URL(assets[0], ORIGIN);
    const script = await readText(bundleUrl, { signal, headers: { referer: `${ORIGIN}/`, accept: "text/javascript" } });
    const value = parsePlayerKey(script);
    keyCache = { value, expires: Date.now() + KEY_TTL };
    return value;
  }

  async function* discover(title, { signal } = {}) {
    signal?.throwIfAborted();
    const tmdbId = validateTitle(title);
    const ref = Object.freeze({ type: title.type, tmdbId, title: title.title || "", originalTitle: title.originalTitle || "",
      ...(title.year == null ? {} : { year: title.year }), ...(title.imdbId ? { imdbId: title.imdbId } : {}),
      ...(title.type === "tv" ? { season: title.season, episode: title.episode } : {}) });
    const candidate = { providerId: "vidsrc:pm", providerName: "VidSrc.pm", catalogSource: "vidsrc", voiceId: "original",
      voiceName: "Основная дорожка", qualityHint: "Auto", season: ref.type === "tv" ? ref.season : null,
      episode: ref.type === "tv" ? ref.episode : null };
    Object.defineProperty(candidate, "ref", { value: ref, enumerable: false });
    yield candidate;
  }

  async function resolve(candidate, { signal } = {}) {
    const ref = candidate?.ref;
    if (candidate?.providerId !== "vidsrc:pm" || candidate.catalogSource !== "vidsrc" || candidate.voiceId !== "original"
      || !ref || (candidate.type != null && ref.type !== candidate.type) || ref.tmdbId !== positiveId(ref.tmdbId)
      || (ref.type === "tv" ? candidate.season !== ref.season || candidate.episode !== ref.episode
        : ref.type !== "movie" || candidate.season != null || candidate.episode != null || ref.season != null || ref.episode != null)) {
      throw new Error("Invalid VidSrc source reference");
    }
    validateTitle({ ...ref, tmdbId: ref.tmdbId });
    if (candidate.ref.title !== candidate.title && candidate.title !== undefined
      || candidate.ref.originalTitle !== candidate.originalTitle && candidate.originalTitle !== undefined) {
      throw new Error("Invalid VidSrc title reference");
    }
    signal?.throwIfAborted();
    const key = await playerKey(signal);
    const path = ref.type === "movie" ? `/api/vidora/v1/movie/${ref.tmdbId}`
      : `/api/vidora/v1/tv/${ref.tmdbId}/${ref.season}/${ref.episode}`;
    const url = new URL(path, ORIGIN);
    url.searchParams.set("source", "scrapify");
    const referer = `${ORIGIN}/embed/${ref.type}/${ref.tmdbId}${ref.type === "tv" ? `/${ref.season}/${ref.episode}` : ""}`;
    const data = JSON.parse(await readText(url, { signal, headers: { accept: "application/json", referer, "x-player-key": key } }));
    if (!metadataMatches(data, ref)) throw new Error("VidSrc returned a different or incomplete title");
    if (!Array.isArray(data.sources) || data.sources.length !== 1 || !data.sources[0]?.url) {
      throw new Error("VidSrc returned no unique source for the requested title");
    }
    const source = data.sources[0];
    const headers = { referer };
    return { qualities: [{ label: "Auto", type: "hls", url: mediaUrl(source.url), headers, publicOnly: true }],
      audioNames: [], subtitles: subtitleTracks(source.tracks || []).map((track) => ({ ...track, headers, publicOnly: true })) };
  }

  return { discover, resolve };
}
