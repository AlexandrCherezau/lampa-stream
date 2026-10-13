const ORIGIN = "https://habster.sbs";
const EMBED_ORIGIN = "https://api.initem.ws";
const BODY_LIMIT = 1024 * 1024;

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

export function createHabsterProvider({ transport } = {}) {
  if (typeof transport?.request !== "function") throw new TypeError("transport.request is required");
  async function readText(url, signal, headers) {
    const bounded = signal ? AbortSignal.any([signal, AbortSignal.timeout(12_000)]) : AbortSignal.timeout(12_000);
    const { response } = await transport.request(url, { signal: bounded, timeout: 12_000, publicOnly: true, headers });
    const abort = () => response.destroy(bounded.reason);
    bounded.addEventListener("abort", abort, { once: true });
    try {
      bounded.throwIfAborted();
      if (response.statusCode < 200 || response.statusCode >= 300) throw new Error(`Habster source returned HTTP ${response.statusCode}`);
      if (Number(response.headers["content-length"]) > BODY_LIMIT) throw new Error("Habster source response is too large");
      const chunks = [];
      let size = 0;
      for await (const chunk of response) {
        size += chunk.length;
        if (size > BODY_LIMIT) throw new Error("Habster source response is too large");
        chunks.push(chunk);
      }
      bounded.throwIfAborted();
      return Buffer.concat(chunks, size).toString("utf8");
    } finally { bounded.removeEventListener("abort", abort); response.destroy(); }
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
    const candidate = { providerId: "habster:collaps", providerName: "Habster · Collaps", catalogSource: "habster",
      voiceId: "multi", voiceName: "Мультиаудио", qualityHint: "Auto", season: title.type === "tv" ? title.season : null,
      episode: title.type === "tv" ? title.episode : null };
    Object.defineProperty(candidate, "ref", { value: { type: title.type, kinopoiskId: title.kinopoiskId,
      ...(title.type === "tv" ? { season: title.season, episode: title.episode } : {}) }, enumerable: false });
    yield candidate;
  }
  async function resolve(candidate, { signal } = {}) {
    if (candidate?.providerId !== "habster:collaps" || candidate.catalogSource !== "habster" || candidate.voiceId !== "multi") {
      throw new Error("Invalid Habster source reference");
    }
    validateTitle(candidate.ref);
    if ((candidate.ref.type === "tv" && (candidate.season !== candidate.ref.season || candidate.episode !== candidate.ref.episode))
      || (candidate.ref.type === "movie" && (candidate.season != null || candidate.episode != null))) throw new Error("Invalid Habster episode reference");
    return refresh(candidate.ref, signal);
  }
  return { discover, resolve };
}
