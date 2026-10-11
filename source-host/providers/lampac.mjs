const RUS_MOVIE_PROVIDERS = new Set([
  "aladin", "cdnvideohub", "collaps", "fancdn", "filmix", "flixcdn", "getstv",
  "hdvb", "iremux", "kinobase", "kinogo", "leproduction", "mirage",
  "phantom", "pizdatoehd", "redheadsound", "rezka", "rutubemovie", "sakhtv",
  "spectre", "veoveo", "vibix", "videodb", "videoseed", "zetflix", "zetflixdb",
]);

const RUS_ANIME_PROVIDERS = new Set([
  "anidub", "aniliberty", "anilibria", "animedia", "animebesst", "animego",
  "animelib", "animeon", "animevost", "dreamerscast", "kodik", "mikai",
]);

const EXCLUDED_PROVIDERS = new Set([
  "kinotochka", "pidtor", "kinoukr", "uakino", "uafilm", "geosaitebi",
  "kinoflix", "eneyida", "moonanime", "asiage", "kinoteatrkg",
]);

const MAX_PROVIDER_CONCURRENCY = 3;
const MAX_HOPS = 5;
const MAX_PROVIDERS = 500;
const MAX_EPISODES = 10_000;

function normalizedText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("ru-RU")
    .replace(/ё/g, "е")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

function normalizedTitle(value) {
  return normalizedText(value).replace(/\s+(?:19|20)\d{2}\s*$/, "").trim();
}

function yearOf(value) {
  const text = String(value || "");
  const match = /(?:^|\D)((?:19|20)\d{2})(?:\D|$)/.exec(text);
  return match ? match[1] : "";
}

function httpUrl(raw, base) {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const url = new URL(raw, base);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function sameOriginUrl(raw, base) {
  const url = httpUrl(raw, base);
  if (!url || url.origin !== base.origin) return null;
  return url;
}

function withQuery(raw, base, input) {
  const url = sameOriginUrl(raw, base);
  if (!url) return null;
  const params = {
    title: input.title || input.originalTitle,
    original_title: input.originalTitle || input.title,
    year: input.year,
    serial: input.type === "tv" ? "1" : "0",
    imdb_id: input.imdbId,
    kinopoisk_id: input.kinopoiskId,
    tmdb_id: input.tmdbId,
    original_language: input.language,
    anime: input.anime ? "1" : undefined,
    rjson: "true",
  };
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }
  return url;
}

function asObject(value) {
  if (typeof value === "string") {
    const text = value.trim();
    if (!text || /^\s*</.test(text)) throw new Error("Lampac returned non-JSON content");
    try { value = JSON.parse(text); } catch { throw new Error("Lampac returned invalid JSON"); }
  }
  if (value && typeof value === "object" && value.ok === false) {
    throw new Error(String(value.error || value.message || "Lampac request failed"));
  }
  if (value && typeof value === "object" && Object.hasOwn(value, "json")) value = value.json;
  if (!value || typeof value !== "object") throw new Error("Lampac returned an empty response");
  return value;
}

function dataItems(json) {
  return Array.isArray(json?.data) ? json.data.slice(0, MAX_EPISODES) : [];
}

function exactSimilar(json, input) {
  const aliases = new Set([input.title, input.originalTitle].map(normalizedTitle).filter(Boolean));
  if (!aliases.size) return null;
  const matches = dataItems(json).filter((item) => {
    const title = normalizedTitle(item?.title || item?.name);
    return aliases.has(title);
  });
  if (!input.year) return matches.length === 1 ? matches[0] : null;
  const yearMatches = matches.filter((item) => yearOf(item?.year || item?.release_date || item?.date || item?.title) === String(input.year));
  if (yearMatches.length === 1) return yearMatches[0];
  if (yearMatches.length > 1 || matches.length !== 1) return null;
  const only = matches[0];
  return yearOf(only?.year || only?.release_date || only?.date || only?.title) ? null : only;
}

function kindOf(json) {
  const kind = String(json?.type || "").toLowerCase();
  if (kind) return kind;
  if (Array.isArray(json?.voice) && Array.isArray(json?.data)) return "episode";
  if (json?.method === "play" && json?.url) return "movie";
  return "";
}

function seasonNumber(item, fallback) {
  const id = Number(item?.id);
  if (Number.isInteger(id) && id >= 0) return id;
  const match = /(\d+)/.exec(String(item?.name || item?.title || ""));
  return match ? Number(match[1]) : fallback;
}

function episodeNumber(item, index) {
  const value = Number(item?.e);
  if (Number.isInteger(value) && value >= 0) return value;
  const match = /(?:^|\D)(\d+)(?:\D|$)/.exec(String(item?.name || item?.title || ""));
  return match ? Number(match[1]) : null;
}

function requestedEpisode(items, want, season, seasonSelected = false) {
  if (!Number.isInteger(Number(want))) return null;
  // shortcut: unmarked root episodes cover season 1 only; add season mappings for split catalogs.
  const matches = items.filter((item, index) => episodeNumber(item, index) === Number(want)
    && (item?.s != null && item.s !== "" ? Number(item.s) === Number(season) : seasonSelected || Number(season) === 1));
  return matches.length === 1 ? matches[0] : null;
}

function voiceItems(json) {
  const voices = Array.isArray(json?.voice)
    ? json.voice.filter((voice) => voice && (voice.url || voice.active === true))
    : [];
  return voices.length ? voices : [{ name: "Основная", active: true, url: null }];
}

function providerAllowed(provider, input) {
  const id = String(provider?.balanser || "").toLowerCase();
  if (!id || EXCLUDED_PROVIDERS.has(id)) return false;
  return RUS_MOVIE_PROVIDERS.has(id) || (input.anime && RUS_ANIME_PROVIDERS.has(id));
}

function heightOf(label) {
  const text = String(label || "");
  const match = /(\d{3,4})\s*p\b/i.exec(text) || /^\s*(\d{3,4})\s*$/.exec(text) || /x\s*(\d{3,4})\b/i.exec(text);
  if (match) return Number(match[1]);
  if (/4k|2160/i.test(text)) return 2160;
  return 0;
}

function sourceHeaders(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) return { ...value };
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  } catch { /* Lampac may return a Python dictionary string. */ }
  const headers = {};
  const pattern = /['"]([^'"]+)['"]\s*:\s*['"]([^'"]*)['"]/g;
  for (const match of value.matchAll(pattern)) headers[match[1]] = match[2];
  return headers;
}

function validMediaUrl(raw, base) {
  return httpUrl(raw, base)?.toString() || null;
}

function mediaQualities(item, base) {
  if (!item || typeof item !== "object") return [];
  const dict = item.quality && typeof item.quality === "object" && !Array.isArray(item.quality)
    ? item.quality
    : item.mp4quality && typeof item.mp4quality === "object" && !Array.isArray(item.mp4quality)
      ? item.mp4quality
      : null;
  const output = [];
  if (dict) {
    for (const [label, raw] of Object.entries(dict)) {
      const url = validMediaUrl(raw, base);
      if (url) output.push({ label, height: heightOf(label), url });
    }
  }
  if (!output.length) {
    const url = validMediaUrl(item.url || item.stream, base);
    if (url) output.push({ label: item.maxquality || "auto", height: heightOf(item.maxquality), url });
  }
  return output;
}

function subtitlesOf(item, base) {
  const raw = item?.subtitles || item?.subtitle;
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((subtitle, index) => {
    const url = validMediaUrl(typeof subtitle === "string" ? subtitle : subtitle?.url || subtitle?.link, base);
    if (!url) return [];
    return [{
      label: (typeof subtitle === "object" && (subtitle.label || subtitle.name)) || `Субтитры ${index + 1}`,
      url,
      language: typeof subtitle === "object" ? subtitle.language || subtitle.lang || null : null,
    }];
  });
}

function itemVoiceName(item) {
  return String(item?.translate || item?.voice_name || item?.name || "Основная");
}

function refreshedVideoDbItem(candidate, json, providerName = "ZetflixDB") {
  const label = String(providerName || "ZetflixDB");
  const ref = candidate.ref;
  if (candidate.season != null || candidate.episode != null) {
    if (kindOf(json) !== "episode") throw new Error(`${label} did not refresh the selected episode`);
    let voiceVerified = false;
    if (Array.isArray(json.voice) && json.voice.length) {
      const matchingVoices = json.voice.filter((voice) =>
        String(voice?.id ?? voice?.name ?? "") === String(candidate.voiceId)
        || String(voice?.name || "") === String(candidate.voiceName));
      if (matchingVoices.length !== 1 || matchingVoices[0].active !== true) {
        throw new Error(`${label} did not refresh the selected voice`);
      }
      voiceVerified = true;
    }
    const episode = requestedEpisode(dataItems(json), candidate.episode, candidate.season, true);
    if (!episode || (!voiceVerified && itemVoiceName(episode) !== String(candidate.voiceName))) {
      throw new Error(`${label} did not refresh the selected episode and voice`);
    }
    return episode;
  }

  if (!(["movie", ""].includes(kindOf(json)))) throw new Error(`${label} did not refresh the selected movie`);
  const previous = ref.item || {};
  const previousTitle = normalizedTitle(previous.title || previous.original_title || previous.name);
  const previousYear = yearOf(previous.year || previous.release_date || previous.date || previous.title);
  const endpoint = new URL(ref.providerUrl);
  const requestedTitles = new Set([endpoint.searchParams.get("title"), endpoint.searchParams.get("original_title")]
    .map(normalizedTitle).filter(Boolean));
  const requestedYear = endpoint.searchParams.get("year") || previousYear;
  const wantedVoice = String(candidate.voiceName || itemVoiceName(previous));
  const ids = ["id", "kinopoisk_id", "kinopoiskId", "imdb_id", "imdbId", "tmdb_id", "tmdbId"];
  const movieItems = kindOf(json) === "movie" ? dataItems(json) : (json.method ? [json] : []);
  const matches = movieItems.filter((item) => {
    if (itemVoiceName(item) !== wantedVoice) return false;
    for (const key of ids) {
      if (previous[key] != null && item?.[key] != null && String(previous[key]) !== String(item[key])) return false;
    }
    const title = normalizedTitle(item?.title || item?.original_title || item?.name);
    const aliases = new Set([...requestedTitles, previousTitle].filter(Boolean));
    if (title && aliases.size && !aliases.has(title)) return false;
    const year = yearOf(item?.year || item?.release_date || item?.date || item?.title);
    if (year && requestedYear && year !== String(requestedYear)) return false;
    return true;
  });
  if (matches.length !== 1) throw new Error(`${label} did not uniquely refresh the selected movie and voice`);
  return matches[0];
}

function assertInput(input) {
  if (!input || !["movie", "tv"].includes(input.type)) throw new TypeError("title.type must be movie or tv");
  if (!String(input.title || input.originalTitle || "").trim()) throw new TypeError("title or originalTitle is required");
  if (input.type === "tv" && (!Number.isInteger(Number(input.season)) || !Number.isInteger(Number(input.episode)))) {
    throw new TypeError("TV discovery requires season and episode");
  }
}

export function createLampacProvider({ baseUrl, fetchJson, remember = null, providerOrder = [] } = {}) {
  if (typeof fetchJson !== "function") throw new TypeError("fetchJson is required");
  const base = new URL(baseUrl);
  if (base.protocol !== "http:" && base.protocol !== "https:") throw new TypeError("baseUrl must use HTTP(S)");
  base.pathname = `${base.pathname.replace(/\/+$/, "")}/`;

  async function requestJson(url, signal) {
    if (signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
    return asObject(await fetchJson(url.toString(), { signal }));
  }

  async function walkProvider(provider, input, signal) {
    const entryUrl = withQuery(provider.url, base, input);
    if (!entryUrl) return { candidates: [], errors: [] };
    let providerJsonUrl = entryUrl;
    let json = await requestJson(entryUrl, signal);

    if (kindOf(json) === "similar") {
      const exact = exactSimilar(json, input);
      if (!exact?.url) return { candidates: [], errors: [] };
      const url = withQuery(exact.url_p || exact.url, base, input);
      if (!url) return { candidates: [], errors: [] };
      providerJsonUrl = url;
      json = await requestJson(url, signal);
    }

    if (input.type === "movie") {
      const items = kindOf(json) === "movie" ? dataItems(json) : (json.method ? [json] : []);
      return { candidates: buildCandidates(provider, items, input, null, null, providerJsonUrl), errors: [] };
    }

    let seasonSelected = false;
    if (kindOf(json) === "season") {
      const seasons = dataItems(json).map((item, index) => ({ item, number: seasonNumber(item, index + 1) }));
      const selected = seasons.filter((season) => season.number === Number(input.season));
      if (selected.length !== 1 || !selected[0].item?.url) return { candidates: [], errors: [] };
      const seasonUrl = withQuery(selected[0].item.url_p || selected[0].item.url, base, input);
      if (!seasonUrl) return { candidates: [], errors: [] };
      providerJsonUrl = seasonUrl;
      json = await requestJson(seasonUrl, signal);
      seasonSelected = true;
    }
    if (kindOf(json) !== "episode") return { candidates: [], errors: [] };

    const voices = voiceItems(json);
    const candidates = [];
    const errors = [];
    const active = voices.filter((voice) => voice.active === true);
    const defaultVoice = active.length === 1 ? active[0] : voices[0];
    for (const voice of voices) {
      let episodeJson = json;
      let episodeUrl = providerJsonUrl;
      if (voice !== defaultVoice && voice.url) {
        const voiceUrl = withQuery(voice.url_p || voice.url, base, input);
        if (!voiceUrl) continue;
        try {
          episodeUrl = voiceUrl;
          episodeJson = await requestJson(voiceUrl, signal);
        } catch (error) {
          if (error?.name === "AbortError" || signal?.aborted) throw error;
          errors.push(`${voice.name || voice.id || "voice"}: ${String(error?.message || error)}`);
          continue;
        }
      }
      const episodes = dataItems(episodeJson);
      const selected = requestedEpisode(episodes, input.episode, input.season, seasonSelected);
      if (!selected) continue;
      const values = buildCandidates(provider, [selected], input, Number(input.season), Number(input.episode), episodeUrl, voice);
      candidates.push(...values);
    }
    return { candidates, errors };
  }

  function buildCandidates(provider, items, input, season, episode, entryUrl, voice = null) {
    return items.flatMap((item, index) => {
      if (!item || (!item.url && !item.stream && !item.quality && !item.mp4quality)) return [];
      if (/^заблокировано(?: |$)/.test(normalizedText(itemVoiceName(item)))) return [];
      const method = item.method === "call" ? "call" : "play";
      const sourceUrl = method === "call" ? item.url : item.url || item.stream;
      if (!sourceUrl || !httpUrl(sourceUrl, base)) return [];
      const candidate = {
        providerId: String(provider.balanser).toLowerCase(),
        providerName: String(provider.name || provider.balanser),
        voiceId: String(voice?.id ?? voice?.name ?? item.id ?? index),
        voiceName: String(voice?.name || item.translate || item.voice_name || item.name || "Основная"),
        season,
        episode,
        qualityHint: item.maxquality || "",
        ref: {
          origin: base.origin,
          providerUrl: entryUrl.toString(),
          method,
          url: httpUrl(sourceUrl, base).toString(),
          stream: validMediaUrl(item.stream, base),
          headers: sourceHeaders(item.headers),
          item,
        },
      };
      if (typeof remember === "function") {
        const remembered = remember(candidate);
        if (remembered !== undefined && remembered !== null) candidate.id = remembered;
      }
      Object.defineProperty(candidate, "ref", { enumerable: false, configurable: false, writable: false, value: candidate.ref });
      return [candidate];
    });
  }

  async function* discover(title, { signal } = {}) {
    assertInput(title);
    const controller = new AbortController();
    const forwardAbort = () => controller.abort(signal?.reason);
    if (signal?.aborted) forwardAbort();
    else signal?.addEventListener("abort", forwardAbort, { once: true });
    const requestSignal = controller.signal;
    try {
    if (requestSignal.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
    const eventsUrl = new URL("lite/events", base);
    const eventParams = {
      title: title.title || title.originalTitle,
      original_title: title.originalTitle || title.title,
      year: title.year,
      serial: title.type === "tv" ? "1" : "0",
      imdb_id: title.imdbId,
      kinopoisk_id: title.kinopoiskId,
      tmdb_id: title.tmdbId,
      original_language: title.language,
      anime: title.anime ? "1" : undefined,
      rjson: "true",
    };
    for (const [key, value] of Object.entries(eventParams)) {
      if (value !== undefined && value !== null && value !== "") eventsUrl.searchParams.set(key, String(value));
    }
    const eventsJson = await requestJson(eventsUrl, requestSignal);
    const priorities = new Map(providerOrder.map((id, index) => [String(id).toLowerCase(), index]));
    const events = (Array.isArray(eventsJson) ? eventsJson : Array.isArray(eventsJson.data) ? eventsJson.data : [])
      .slice(0, MAX_PROVIDERS)
      .filter((provider) => providerAllowed(provider, title) && sameOriginUrl(provider.url, base))
      .map((provider, index) => ({ provider, index }))
      .sort((a, b) => (priorities.get(String(a.provider.balanser).toLowerCase()) ?? Number.MAX_SAFE_INTEGER)
        - (priorities.get(String(b.provider.balanser).toLowerCase()) ?? Number.MAX_SAFE_INTEGER) || a.index - b.index)
      .map(({ provider }) => provider);

    const running = new Map();
    let next = 0;
    const startProvider = (provider) => {
      const token = {};
      const job = Promise.resolve()
        .then(() => walkProvider(provider, title, requestSignal))
        .then(
          (result) => ({ token, provider, candidates: result.candidates, errors: result.errors, error: null }),
          (error) => ({ token, provider, candidates: [], error: String(error?.message || error), aborted: error?.name === "AbortError" }),
        );
      running.set(token, job);
    };
    while (next < events.length && running.size < MAX_PROVIDER_CONCURRENCY) startProvider(events[next++]);
    while (running.size) {
      if (requestSignal.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
      const settled = await Promise.race(running.values());
      running.delete(settled.token);
      if (next < events.length && !requestSignal.aborted) startProvider(events[next++]);
      if (settled.aborted || requestSignal.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
      if (settled.error) {
        yield { providerId: String(settled.provider.balanser).toLowerCase(), providerName: String(settled.provider.name || settled.provider.balanser), error: settled.error };
        continue;
      }
      for (const candidate of settled.candidates) yield candidate;
      for (const error of settled.errors || []) {
        yield { providerId: String(settled.provider.balanser).toLowerCase(), providerName: String(settled.provider.name || settled.provider.balanser), error };
      }
    }
    } finally {
      controller.abort();
      signal?.removeEventListener("abort", forwardAbort);
    }
  }

  async function resolve(candidate, { signal } = {}) {
    const ref = candidate?.ref;
    if (!ref || ref.origin !== base.origin || !httpUrl(ref.url, base)) throw new Error("Invalid Lampac candidate reference");
    if (candidate.episode != null && ref.item?.s != null && ref.item.s !== "" && Number(ref.item.s) !== Number(candidate.season)) {
      throw new Error("Lampac candidate does not match the selected season");
    }
    if (/^заблокировано(?: |$)/.test(normalizedText(candidate.voiceName))) throw new Error("Lampac candidate is a blocked placeholder");
    const providerId = String(candidate.providerId || "").toLowerCase();
    const isZetflixDb = providerId === "zetflixdb";
    const refreshProvider = isZetflixDb || providerId === "zetflix";
    const providerName = isZetflixDb ? "ZetflixDB" : "Zetflix";
    let item = ref.item;
    let currentUrl = httpUrl(ref.url, base);
    let method = ref.method;
    let lastCallError;
    let freshStream = null;
    let fallbackItem = ref.item;

    if (refreshProvider) {
      const providerUrl = sameOriginUrl(ref.providerUrl, base);
      if (!providerUrl) throw new Error("Invalid Lampac provider reference");
      const freshJson = await requestJson(providerUrl, signal);
      if (signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
      item = refreshedVideoDbItem(candidate, freshJson, providerName);
      fallbackItem = item;
      method = item.method === "call" ? "call" : "play";
      currentUrl = httpUrl(item.url || item.stream, base);
      freshStream = validMediaUrl(item.stream, base);
      if (!currentUrl) throw new Error(`${providerName} did not refresh the selected media URL`);
    }
    const wasCall = method === "call";

    for (let hop = 0; hop < MAX_HOPS && method === "call"; hop++) {
      if (signal?.aborted) throw Object.assign(new Error("aborted"), { name: "AbortError" });
      try {
        const result = await requestJson(currentUrl, signal);
        const nestedUrl = result.url || result.stream;
        if (result.method === "call" && nestedUrl) {
          currentUrl = httpUrl(nestedUrl, base);
          if (!currentUrl) throw new Error("Lampac call returned an invalid URL");
          item = result;
          method = "call";
          continue;
        }
        item = { ...result, headers: result.headers || item.headers };
        method = "play";
      } catch (error) {
        if (error?.name === "AbortError" || signal?.aborted) throw error;
        lastCallError = error;
        break;
      }
    }
    if (method === "call") lastCallError ||= new Error("Lampac call depth exceeded");
    if (lastCallError) {
      const stream = refreshProvider ? freshStream : ref.stream;
      if (!stream || signal?.aborted) throw lastCallError;
      item = { ...fallbackItem, method: "play", url: stream };
    }

    let qualities = mediaQualities(item, base);
    const fallbackStream = refreshProvider ? freshStream : ref.stream;
    if (!qualities.length && wasCall && fallbackStream && !signal?.aborted) {
      item = { ...fallbackItem, method: "play", url: fallbackStream };
      qualities = mediaQualities(item, base);
    }
    if (!qualities.length) throw lastCallError || new Error("Lampac source returned no playable quality");

    return {
      qualities: qualities
        .sort((a, b) => b.height - a.height)
        .map((quality) => ({ ...quality, headers: { ...sourceHeaders(item.headers || ref.headers) } })),
      subtitles: subtitlesOf(item, base),
      duration: Number(item.duration || item.runtime) || null,
      skip: item.skip || item.skips || item.segments?.skip || null,
    };
  }

  return { discover, resolve };
}
