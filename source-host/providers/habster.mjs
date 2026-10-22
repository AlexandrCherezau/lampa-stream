import { allohaUserAgent, parseAllohaBootstrap, parseAllohaSerialEpisode, parseAllohaGuard, parseAllohaSources, openAllohaPlayback } from "./alloha-protocol.mjs";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

const ORIGIN = "https://habster.sbs";
const EMBED_ORIGIN = "https://api.initem.ws";
const ALLOHA_ORIGIN = "https://befriend.stravers.live";
const BODY_LIMIT = 1024 * 1024;
const GUARD_CACHE_TTL = 10 * 60_000;

function literal(value) {
  if (value.startsWith('"')) return JSON.parse(value);
  if (!/^'[^'\\]*'$/.test(value)) throw new Error("Habster returned an unsupported embed expression");
  return value.slice(1, -1);
}

export function parseHabsterEmbed(html, kinopoiskId) {
  const id = /\b(?:var|let|const)\s+KP_ID\s*=\s*(['"])([1-9]\d*)\1\s*;/.exec(html)?.[2];
  if (id !== String(kinopoiskId)) throw new Error("Habster page does not match the requested Kinopoisk ID");
  const expression = /\b(?:var|let|const)\s+VARIYT_SRC\s*=\s*((?:"(?:\\.|[^"\\])*"|'[^'\\]*'))\s*\+\s*KP_ID\s*\+\s*((?:"(?:\\.|[^"\\])*"|'[^'\\]*'))\s*;/.exec(html);
  if (!expression) throw new Error("Habster Collaps embed is unavailable");
  let url;
  try { url = new URL(literal(expression[1]) + id + literal(expression[2])); }
  catch { throw new Error("Habster returned an invalid embed URL"); }
  if (url.origin !== EMBED_ORIGIN || url.username || url.password || url.pathname !== `/embed/kp/${id}` || url.hash) {
    throw new Error("Habster returned an unsupported embed origin or title");
  }
  return url.href;
}

// Read the public bootstrap URL; never execute its player JavaScript.
export function parseHabsterAllohaEmbed(html, kinopoiskId) {
  const id = /\b(?:var|let|const)\s+KP_ID\s*=\s*(['"])([1-9]\d*)\1\s*;/.exec(html)?.[2];
  if (id !== String(kinopoiskId)) throw new Error("Habster page does not match the requested Kinopoisk ID");
  const expression = /\b(?:var|let|const)\s+BEFRIEND_SRC\s*=\s*((?:"(?:\\.|[^"\\])*"|'[^'\\]*'))\s*\+\s*KP_ID\s*;/.exec(html);
  if (!expression) throw new Error("Habster Alloha embed is unavailable");
  let url;
  try { url = new URL(literal(expression[1]) + id); }
  catch { throw new Error("Habster returned an invalid Alloha embed URL"); }
  if (url.origin !== ALLOHA_ORIGIN || url.username || url.password || url.pathname !== "/" || url.hash
    || url.searchParams.getAll("kp").length !== 1 || url.searchParams.get("kp") !== id
    || [...url.searchParams.keys()].some((key) => !["kp", "token"].includes(key))
    || url.searchParams.getAll("token").length !== 1 || !url.searchParams.get("token")) {
    throw new Error("Habster returned an unsupported Alloha embed origin or title");
  }
  return url.href;
}

// Read data literals only; never execute the surrounding player JavaScript.
function balanced(text, start) {
  const stack = [];
  let quote = "";
  for (let i = start; i < text.length; i++) {
    const char = text[i];
    if (quote) {
      if (char === "\\") i++;
      else if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'") { quote = char; continue; }
    if (char === "{" || char === "[") stack.push(char);
    else if (char === "}" || char === "]") {
      if (stack.pop() !== (char === "}" ? "{" : "[")) throw new Error("Habster returned invalid player data");
      if (!stack.length) return text.slice(start, i + 1);
    }
  }
  throw new Error("Habster returned incomplete player data");
}

function jsonArray(text, key) {
  const match = new RegExp(`(?:"${key}"|\\b${key})\\s*:\\s*\\[`).exec(text);
  if (!match) return [];
  try { return JSON.parse(balanced(text, match.index + match[0].length - 1)); }
  catch { throw new Error("Habster returned invalid player data"); }
}

function mediaUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error("Habster returned an invalid media URL"); }
  if (url.protocol !== "https:" || url.username || url.password) throw new Error("Habster returned an unsupported media URL");
  return url.href;
}

function audioNames(value = []) {
  if (!Array.isArray(value) || value.length > 32 || value.some((name) => typeof name !== "string" || !name.trim() || name.length > 200)) {
    throw new Error("Habster returned invalid audio names");
  }
  return value.map((name) => name.trim());
}

export function selectAllohaEpisodeVoice(voices, episodeChoice) {
  const normalizedVoice = (value) => normalizedName(value).replace(/^(?:russian|english|ukrainian|original|дубляж)\s+/, "");
  const target = normalizedVoice(episodeChoice.name);
  const matches = voices.filter((voice) => normalizedVoice(voice.name) === target);
  if (matches.length === 1) return matches[0];
  // Some episodes expose a single anonymous track whose label is its track ID.
  // Only that proven shape may stand in for the bootstrap translation name.
  if (matches.length === 0 && voices.length === 1 && /^\d{1,8}$/.test(voices[0].name)
    && voices[0].name === voices[0].id) return voices[0];
  throw new Error("Habster Alloha did not return the selected series translation");
}

export function parseHabsterPlayer(html, title) {
  const start = html.indexOf("makePlayer({");
  if (start < 0) throw new Error("Habster Collaps player data is unavailable");
  const player = balanced(html, start + "makePlayer(".length);
  let source;
  if (title.type === "tv") {
    const seasons = jsonArray(player, "seasons").filter((item) => Number(item?.season) === title.season);
    if (seasons.length !== 1) throw new Error("Habster did not return the requested season");
    const episodes = (Array.isArray(seasons[0].episodes) ? seasons[0].episodes : [])
      .filter((item) => Number(item?.episode) === title.episode);
    if (episodes.length !== 1) throw new Error("Habster did not return the requested episode");
    source = episodes[0];
  } else {
    const match = /(?:"source"|\bsource)\s*:\s*\{/.exec(player);
    if (!match) throw new Error("Habster did not return movie source data");
    const data = balanced(player, match.index + match[0].length - 1);
    const hls = /(?:"hls"|\bhls)\s*:\s*("(?:\\.|[^"\\])*")/.exec(data);
    const audio = /(?:"audio"|\baudio)\s*:\s*\{/.exec(data);
    const audioData = audio ? balanced(data, audio.index + audio[0].length - 1) : "";
    if (/(?:"names"|\bnames)\s*:/.test(audioData) && !/(?:"names"|\bnames)\s*:\s*\[/.test(audioData)) {
      throw new Error("Habster returned invalid audio names");
    }
    source = { hls: hls ? JSON.parse(hls[1]) : null, cc: jsonArray(data, "cc"), audio: { names: jsonArray(audioData, "names") } };
  }
  if (!source.hls) throw new Error("Habster did not return an HLS stream for the requested title");
  return { hls: mediaUrl(source.hls), audioNames: audioNames(source.audio?.names), subtitles: (Array.isArray(source.cc) ? source.cc : []).map((subtitle, index) => ({
    url: mediaUrl(subtitle?.url), label: String(subtitle.name || `Субтитры ${index + 1}`), language: subtitle.language || null,
  })) };
}

function validateTitle(title) {
  if (!title || !["movie", "tv"].includes(title.type) || !Number.isSafeInteger(title.kinopoiskId) || title.kinopoiskId < 1) {
    throw new Error("Habster needs a valid Kinopoisk ID and title type");
  }
  if (title.type === "tv" && (!Number.isSafeInteger(title.season) || title.season < 0 || !Number.isSafeInteger(title.episode) || title.episode < 1)) {
    throw new Error("Habster needs an exact season and episode");
  }
}

const normalizedName = (value) => typeof value === "string" ? value.normalize("NFC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim() : "";
const positiveId = (value) => ["string", "number"].includes(typeof value) && /^[1-9]\d*$/.test(String(value))
  && Number.isSafeInteger(Number(value)) ? Number(value) : null;

export function createHabsterProvider({ transport, allohaPlayback = openAllohaPlayback } = {}) {
  if (typeof transport?.request !== "function") throw new TypeError("transport.request is required");
  const allohaCache = new Map();
  let allohaGuardCache = null;
  async function readText(url, signal, headers, request = {}) {
    const bounded = signal ? AbortSignal.any([signal, AbortSignal.timeout(12_000)]) : AbortSignal.timeout(12_000);
    const { response } = await transport.request(url, { signal: bounded, timeout: 12_000, publicOnly: true, headers, ...request });
    const encoding = String(response.headers["content-encoding"] || "identity").toLowerCase();
    const decoder = encoding === "gzip" ? createGunzip() : encoding === "br" ? createBrotliDecompress() : encoding === "deflate" ? createInflate() : null;
    const body = decoder || response;
    const forwardError = (error) => decoder?.destroy(error);
    if (decoder) { response.on("error", forwardError); response.pipe(decoder); }
    const abort = () => { response.destroy(bounded.reason); decoder?.destroy(bounded.reason); };
    bounded.addEventListener("abort", abort, { once: true });
    try {
      bounded.throwIfAborted();
      if (!decoder && encoding !== "identity") throw new Error("Habster source returned unsupported content encoding");
      if (response.statusCode < 200 || response.statusCode >= 300) throw new Error(`Habster source returned HTTP ${response.statusCode}`);
      if (Number(response.headers["content-length"]) > BODY_LIMIT) throw new Error("Habster source response is too large");
      const chunks = [];
      let size = 0;
      for await (const chunk of body) {
        size += chunk.length;
        if (size > BODY_LIMIT) throw new Error("Habster source response is too large");
        chunks.push(chunk);
      }
      bounded.throwIfAborted();
      return Buffer.concat(chunks, size).toString("utf8");
    } finally { bounded.removeEventListener("abort", abort); response.removeListener("error", forwardError); decoder?.destroy(); response.destroy(); }
  }
  function awaitSignal(promise, signal) {
    if (!signal) return promise;
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const abort = () => reject(signal.reason || new Error("Habster request was cancelled"));
      signal.addEventListener("abort", abort, { once: true });
      promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
  }
  function loadAllohaGuard(bundleUrl, headers) {
    const now = Date.now();
    if (allohaGuardCache?.url === bundleUrl && allohaGuardCache.expires > now) return allohaGuardCache.promise;
    const entry = { url: bundleUrl, expires: now + GUARD_CACHE_TTL, promise: null };
    entry.promise = (async () => {
      const bounded = AbortSignal.timeout(20_000);
      const guard = parseAllohaGuard(await readText(bundleUrl, bounded, headers));
      if (allohaGuardCache === entry) entry.expires = Date.now() + GUARD_CACHE_TTL;
      return guard;
    })().catch((error) => {
      if (allohaGuardCache === entry) allohaGuardCache = null;
      throw error;
    });
    allohaGuardCache = entry;
    return entry.promise;
  }
  async function loadAlloha(title, signal, requestedTranslationId = null) {
    const { kinopoiskId } = title;
    const cacheKey = `${title.type}:${kinopoiskId}:${title.season ?? ""}:${title.episode ?? ""}:${requestedTranslationId ?? "default"}`;
    const now = Date.now();
    for (const [id, entry] of allohaCache) if (entry.expires < now) allohaCache.delete(id);
    let entry = allohaCache.get(cacheKey);
    if (!entry) {
      if (allohaCache.size >= 8) {
        const cached = [...allohaCache].find(([, value]) => value.ready);
        if (cached) allohaCache.delete(cached[0]);
        else throw new Error("Habster Alloha has too many simultaneous title requests");
      }
      const titleController = new AbortController();
      const bounded = AbortSignal.any([titleController.signal, AbortSignal.timeout(20_000)]);
      const promise = (async () => {
        try {
          const page = await readText(`${ORIGIN}/${title.type === "tv" ? "series" : "film"}/${kinopoiskId}`, bounded, { accept: "text/html" });
          const embed = parseHabsterAllohaEmbed(page, kinopoiskId);
          const headers = { referer: `${ORIGIN}/`, "user-agent": allohaUserAgent, accept: "text/html" };
          const bootstrap = parseAllohaBootstrap(await readText(embed, bounded, headers));
          let playbackId = bootstrap.movieId;
          let episodeChoice = null;
          if (title.type === "tv") {
            if (bootstrap.type !== "serial") throw new Error("Habster Alloha did not return a series");
            episodeChoice = parseAllohaSerialEpisode(bootstrap, title.season, title.episode, requestedTranslationId);
            playbackId = episodeChoice.id;
          } else if (bootstrap.type !== "movie") throw new Error("Habster Alloha did not return a movie");
          const guardPromise = loadAllohaGuard(bootstrap.bundleUrl, headers);
          const form = new URLSearchParams({ token: new URL(embed).searchParams.get("token"), av1: "true", autoplay: "0", audio: "", subtitle: "" });
          const dataPromise = readText(`${ALLOHA_ORIGIN}/bnsi/movies/${playbackId}`, bounded, {
            referer: embed, origin: ALLOHA_ORIGIN, "user-agent": allohaUserAgent,
            "content-type": "application/x-www-form-urlencoded", "x-requested-with": "XMLHttpRequest", borth: bootstrap.borth,
          }, { method: "POST", body: form.toString() }).then(JSON.parse);
          const [guard, data] = await awaitSignal(Promise.all([guardPromise, dataPromise]), bounded);
          const sources = parseAllohaSources(data);
          const primary = episodeChoice ? selectAllohaEpisodeVoice(sources.voices, episodeChoice)
            : sources.voices.find((voice) => voice.default) || sources.voices[0];
          const edgeHash = await allohaPlayback(sources.websocketUrl, primary, { signal: bounded });
          return { ...sources, primary, episodeChoice, episodeChoices: episodeChoice?.choices || [], headers: { referer: embed, origin: ALLOHA_ORIGIN, "user-agent": allohaUserAgent,
            authorizations: `Bearer ${guard}`, "accepts-controls": edgeHash } };
        } finally { titleController.abort(); }
      })();
      entry = { promise, expires: now + 45_000, ready: false };
      allohaCache.set(cacheKey, entry);
      promise.then(() => { entry.ready = true; }, () => { if (allohaCache.get(cacheKey) === entry) allohaCache.delete(cacheKey); });
    }
    return awaitSignal(entry.promise, signal);
  }
  function allohaCandidate(title, voice, episodeChoice = null) {
    const voiceId = episodeChoice ? `alloha-translation:${episodeChoice.translationId}` : voice ? `alloha:${voice.id}` : "default";
    const candidate = { providerId: "habster:alloha", providerName: "Habster · Alloha", catalogSource: "habster",
      voiceId, voiceName: episodeChoice?.name || voice?.name || "Основная озвучка",
      qualityHint: title.type === "movie" ? "До 4K" : episodeChoice ? (episodeChoice.uhd ? "До 4K" : "Auto") : "Auto",
      season: title.type === "tv" ? title.season : null, episode: title.type === "tv" ? title.episode : null };
    Object.defineProperty(candidate, "ref", { value: { type: title.type, kinopoiskId: title.kinopoiskId, voiceId,
      ...(title.type === "tv" ? { season: title.season, episode: title.episode,
        ...(episodeChoice ? { translationId: episodeChoice.translationId } : {}) } : {}) }, enumerable: false });
    return candidate;
  }
  async function refresh(title, signal) {
    validateTitle(title);
    const page = `${ORIGIN}/${title.type === "tv" ? "series" : "film"}/${title.kinopoiskId}`;
    const html = await readText(page, signal, { accept: "text/html" });
    const embed = parseHabsterEmbed(html, title.kinopoiskId);
    const headers = { referer: `${ORIGIN}/`, origin: ORIGIN };
    const resolved = parseHabsterPlayer(await readText(embed, signal, { ...headers, accept: "text/html" }), title);
    const mediaHeaders = { referer: embed, origin: EMBED_ORIGIN };
    return { qualities: [{ label: "Auto", type: "hls", url: resolved.hls, headers: mediaHeaders, publicOnly: true }], audioNames: resolved.audioNames,
      subtitles: resolved.subtitles.map((subtitle) => ({ ...subtitle, headers: mediaHeaders, publicOnly: true })) };
  }
  async function findKinopoiskId(title, signal) {
    if (!Number.isSafeInteger(title.year) || title.year < 1880 || title.year > 2200) return null;
    const names = [title.title, title.originalTitle].map(normalizedName).filter(Boolean);
    if (!names.length) return null;
    const bounded = signal ? AbortSignal.any([signal, AbortSignal.timeout(3_000)]) : AbortSignal.timeout(3_000);
    const search = new URL("/search.php", ORIGIN);
    search.searchParams.set("q", title.originalTitle || title.title);
    const data = JSON.parse(await readText(search, bounded, { accept: "application/json" }));
    if (!Array.isArray(data?.results) || data.results.length > 100) throw new Error("Habster returned invalid search results");
    const ids = new Set(data.results.filter((item) => Number(item?.year) === title.year
      && (title.type === "movie" ? item?.category === "movie" : ["serial", "series"].includes(item?.category))
      && [item?.name_ru, item?.name].some((name) => names.includes(normalizedName(name))))
      .map((item) => positiveId(item.kp_id)).filter(Boolean));
    if (ids.size !== 1) return null;
    const [id] = ids;
    const info = JSON.parse(await readText(`${ORIGIN}/getinfo.php?kp_id=${id}`, bounded, { accept: "application/json" }));
    if (positiveId(info?.kinopoiskId) !== id || Number(info?.year) !== title.year
      || (title.type === "movie" ? info?.type !== "FILM" : !["TV_SERIES", "MINI_SERIES", "TV_SHOW"].includes(info?.type))
      || ![info?.nameRu, info?.nameEn, info?.nameOriginal].some((name) => names.includes(normalizedName(name)))
      || (title.imdbId && info?.imdbId !== title.imdbId)) return null;
    return id;
  }
  async function* discover(title, { signal } = {}) {
    signal?.throwIfAborted();
    if (title?.kinopoiskId == null) {
      if (!["movie", "tv"].includes(title?.type)) throw new Error("Habster needs a valid title type");
      const kinopoiskId = await findKinopoiskId(title, signal);
      if (!kinopoiskId) return;
      title = { ...title, kinopoiskId };
    }
    validateTitle(title);
    signal?.throwIfAborted();
    yield allohaCandidate(title);
    const candidate = { providerId: "habster:collaps", providerName: "Habster · Collaps", catalogSource: "habster",
      voiceId: "multi", voiceName: "Мультиаудио", qualityHint: "Auto", season: title.type === "tv" ? title.season : null,
      episode: title.type === "tv" ? title.episode : null };
    Object.defineProperty(candidate, "ref", { value: { type: title.type, kinopoiskId: title.kinopoiskId,
      ...(title.type === "tv" ? { season: title.season, episode: title.episode } : {}) }, enumerable: false });
    yield candidate;
    const sources = await loadAlloha(title, signal);
    if (title.type === "tv") {
      for (const choice of sources.episodeChoices) {
        yield allohaCandidate(title, null, choice);
      }
    } else {
      for (const voice of sources.voices) yield allohaCandidate(title, voice);
    }
  }
  async function resolve(candidate, { signal } = {}) {
    const alloha = candidate?.providerId === "habster:alloha";
    if (!["habster:collaps", "habster:alloha"].includes(candidate?.providerId) || candidate.catalogSource !== "habster"
      || (alloha ? !/^(default|alloha:\d{1,8}|alloha-translation:[1-9]\d{0,7})$/.test(candidate.voiceId) || candidate.ref?.voiceId !== candidate.voiceId : candidate.voiceId !== "multi")) {
      throw new Error("Invalid Habster source reference");
    }
    validateTitle(candidate.ref);
    if ((candidate.ref.type === "tv" && (candidate.season !== candidate.ref.season || candidate.episode !== candidate.ref.episode
      || !Number.isSafeInteger(candidate.ref.season) || !Number.isSafeInteger(candidate.ref.episode)))
      || (candidate.ref.type === "movie" && (candidate.season != null || candidate.episode != null))) throw new Error("Invalid Habster episode reference");
    if (alloha) {
      const translationCandidate = candidate.ref.type === "tv" && /^alloha-translation:[1-9]\d{0,7}$/.test(candidate.voiceId);
      if (candidate.ref.type === "tv" && candidate.voiceId !== "default" && !translationCandidate) throw new Error("Habster Alloha needs an exact series translation");
      const translationId = translationCandidate ? candidate.voiceId.slice("alloha-translation:".length) : null;
      if (translationCandidate && candidate.ref.translationId !== translationId) throw new Error("Invalid Habster series translation reference");
      if (!translationCandidate && candidate.ref.translationId != null) throw new Error("Invalid Habster series translation reference");
      const sources = await loadAlloha(candidate.ref, signal, translationId);
      const voice = candidate.voiceId === "default" || translationCandidate ? sources.primary
        : sources.voices.find((item) => `alloha:${item.id}` === candidate.voiceId);
      if (!voice) throw new Error("Habster Alloha did not return the requested audio track");
      const qualities = voice.qualities.map((quality) => ({ label: quality.label, height: quality.height, type: "hls",
        url: quality.urls[0], headers: sources.headers, publicOnly: true }));
      qualities.sort((a, b) => a.height === 720 ? -1 : b.height === 720 ? 1 : b.height - a.height);
      return { qualities, audioNames: [voice.name], subtitles: sources.subtitles.map((subtitle) => ({ ...subtitle, headers: sources.headers, publicOnly: true })) };
    }
    return refresh(candidate.ref, signal);
  }
  return { discover, resolve };
}
