import { createDecipheriv, createHmac, createHash, createCipheriv } from "node:crypto";

const SITE = "https://mkissa.to";
const API = "https://api.mkissa.net";
const CLOCK = "https://allanime.day";
const BUILD_ID = "181";
const EPOCH_MS = 604_800_000;
const EPOCH_GRACE_MS = 86_400_000;
// Public build-181 profile statically extracted from the first-party client bundle.
// Keep the fragments and derivation constants together: mkissa rotates them as one profile.
// shortcut: this profile supports build 181, update it when the public client rotates.
const CRYPTO_PROFILE = Object.freeze({
  saltMul: 60,
  saltAdd: 175,
  fragMul: 44,
  fragAdd: 1,
  fragments: ["Yh7GkKY7p1E=", "GhmFaOUHEGk=", "prExpp5kt+4=", "FSm6Hdvb+S4="],
  bootPrefix: "UZQjku7:",
  bootJoin: ":",
  bootParts: ["buildId", "group", "host", "epoch", "lane"],
});
function deriveMask(buildId = BUILD_ID) {
  const text = String(buildId || "");
  const seed = Buffer.alloc(32);
  for (let index = 0; index < seed.length; index += 1) {
    seed[index] = (text.charCodeAt(index % Math.max(text.length, 1)) || 0)
      ^ ((index * CRYPTO_PROFILE.saltMul + CRYPTO_PROFILE.saltAdd) & 255);
  }
  const mask = Buffer.alloc(32);
  for (let fragmentIndex = 0; fragmentIndex < CRYPTO_PROFILE.fragments.length; fragmentIndex += 1) {
    const fragment = Buffer.from(CRYPTO_PROFILE.fragments[fragmentIndex], "base64");
    for (let byteIndex = 0; byteIndex < 8; byteIndex += 1) {
      const offset = fragmentIndex * 8 + byteIndex;
      mask[offset] = fragment[byteIndex] ^ seed[offset]
        ^ ((fragmentIndex * CRYPTO_PROFILE.fragMul + byteIndex * CRYPTO_PROFILE.fragAdd) & 255);
    }
  }
  return mask;
}
const BOOT_MASK = deriveMask();
const SEARCH_HASH = "8b319a0fda488e4319f1b6d99093ba12802f3fc039572f39bcc02d5f9b9d9b02";
const EPISODE_HASH = "670bbf38d0868f446e2346c1e956ca2c40c416e733ca248fd54e04f1c8b99145";
const LANE = "k7";
const MAX_BODY = 1024 * 1024;
const TIMEOUT = 12_000;

const normalized = (value) => typeof value === "string"
  ? value.normalize("NFC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim() : "";

function abortSignal(signal) {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT)]) : AbortSignal.timeout(TIMEOUT);
}

async function readJson(transport, rawUrl, { signal, headers = {} } = {}) {
  const bounded = abortSignal(signal);
  const { response } = await transport.request(rawUrl, { signal: bounded, timeout: TIMEOUT, publicOnly: true, headers });
  const abort = () => response.destroy(bounded.reason);
  bounded.addEventListener("abort", abort, { once: true });
  try {
    bounded.throwIfAborted();
    if (response.statusCode < 200 || response.statusCode >= 300) throw new Error(`AllManga returned HTTP ${response.statusCode}`);
    if (Number(response.headers["content-length"]) > MAX_BODY) throw new Error("AllManga response is too large");
    const chunks = [];
    let size = 0;
    for await (const chunk of response) {
      size += chunk.length;
      if (size > MAX_BODY) throw new Error("AllManga response is too large");
      chunks.push(chunk);
    }
    bounded.throwIfAborted();
    return JSON.parse(Buffer.concat(chunks, size).toString("utf8"));
  } finally {
    bounded.removeEventListener("abort", abort);
    response.destroy();
  }
}

function bootToken({ buildId, epoch, group, host, lane }) {
  if (buildId !== BUILD_ID || !Number.isSafeInteger(epoch) || typeof group !== "string" || typeof host !== "string") {
    throw new Error("AllManga crypto profile is invalid or outdated");
  }
  const first = createHmac("sha256", BOOT_MASK).update(`${CRYPTO_PROFILE.bootPrefix}${buildId}`).digest();
  const fields = { buildId, group, host: host.replace(/^www\./i, "").toLowerCase(), epoch: String(epoch), lane: String(lane || "").toLowerCase() };
  const input = CRYPTO_PROFILE.bootParts.map((part) => fields[part] ?? "").join(CRYPTO_PROFILE.bootJoin);
  return createHmac("sha256", first).update(input).digest("hex");
}

function makeAaReq({ key, epoch, buildId, queryHash, lane, now = Date.now() }) {
  const ts = Math.floor(now / 300_000) * 300_000;
  const iv = createHash("sha256").update(`${epoch}:${buildId}:${queryHash}:${ts}:${lane}`).digest().subarray(0, 12);
  const payload = Buffer.from(JSON.stringify({ v: 1, ts, epoch, buildId, qh: queryHash, k: lane }));
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(payload), cipher.final(), cipher.getAuthTag()]);
  return Buffer.concat([Buffer.from([1]), iv, ciphertext]).toString("base64");
}

function decryptResponse(value, key) {
  if (typeof value !== "string" || value.length > MAX_BODY * 2) throw new Error("AllManga returned invalid encrypted episode data");
  const bytes = Buffer.from(value, "base64");
  if (bytes.length < 30 || bytes[0] !== 1) throw new Error("AllManga returned unsupported episode data");
  const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(1, 13));
  decipher.setAuthTag(bytes.subarray(-16));
  return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(13, -16)), decipher.final()]).toString("utf8"));
}

function buildKey(partB) {
  const bytes = Buffer.from(partB, "base64");
  if (bytes.length < 32) throw new Error("AllManga bootstrap key is incomplete");
  return Buffer.from(bytes.subarray(0, 32).map((value, index) => value ^ BOOT_MASK[index]));
}

function mediaUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error("AllManga returned an invalid media URL"); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error("AllManga returned an unsupported media URL");
  return url.href;
}

function decodeClockPath(encoded) {
  if (typeof encoded !== "string" || encoded.length > 8192) throw new Error("AllManga source reference is invalid");
  const value = encoded.replaceAll("--", "");
  if (!value.length || value.length % 2 || !/^[0-9a-f]+$/i.test(value)) throw new Error("AllManga source reference is unsupported");
  let path = "";
  for (let index = 0; index < value.length; index += 2) path += String.fromCharCode(parseInt(value.slice(index, index + 2), 16) ^ 56);
  if (!path.startsWith("/") || path.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(path)) throw new Error("AllManga source path is invalid");
  return path.replace(/clock(?=\?|$)/, "clock.json");
}

function exactShow(edges, title) {
  if (!Array.isArray(edges) || edges.length > 100) throw new Error("AllManga returned invalid search results");
  const wanted = [title.title, title.originalTitle].map(normalized).filter(Boolean);
  const matches = edges.filter((show) => {
    const names = [show.name, show.englishName, show.nativeName, ...(Array.isArray(show.altNames) ? show.altNames : [])]
      .map((value) => normalized(typeof value === "string" ? value : value?.name)).filter(Boolean);
    return wanted.some((name) => names.includes(name))
      && (title.year == null || Number(show.airedStart?.year) === title.year)
      && String(show.type || "").toLowerCase() === (title.type === "movie" ? "movie" : "tv");
  });
  if (matches.length !== 1) throw new Error(matches.length ? "AllManga title match is ambiguous" : "AllManga has no exact title match");
  return matches[0];
}

function apiUrl(variables, extensions) {
  const url = new URL("/api", API);
  url.searchParams.set("variables", JSON.stringify(variables));
  url.searchParams.set("extensions", JSON.stringify(extensions));
  return url.href;
}

function exactEpisode(episode, show, title, candidate) {
  const requested = String(title.episode);
  const sourceShow = episode?.show;
  const names = [sourceShow?.name, sourceShow?.englishName, sourceShow?.nativeName].map(normalized).filter(Boolean);
  const wanted = [title.title, title.originalTitle].map(normalized).filter(Boolean);
  if (String(episode?.episodeString) !== requested || sourceShow?._id !== show._id
    || !wanted.some((name) => names.includes(name))
    || (title.year != null && Number(sourceShow?.airedStart?.year) !== title.year)
    || String(sourceShow?.type || "").toLowerCase() !== "tv"
    || candidate.season !== title.season || candidate.episode !== title.episode) {
    throw new Error("AllManga did not return the exact requested series episode");
  }
  return episode;
}

export function createAllMangaProvider({ transport } = {}) {
  if (typeof transport?.request !== "function") throw new TypeError("transport.request is required");

async function currentBuild(signal) {
    const data = await readJson(transport, `${SITE}/_app/version.json`, { signal });
    if (String(data?.version ?? data?.buildId ?? "") !== BUILD_ID) throw new Error("AllManga crypto profile changed; update the public build profile");
    return BUILD_ID;
  }

  async function search(title, signal) {
    const buildId = await currentBuild(signal);
    const variables = { search: { sortBy: "Top", query: title.originalTitle || title.title, listProfile: "" }, limit: 26, page: 1, translationType: "sub" };
    const response = await readJson(transport, apiUrl(variables, { persistedQuery: { version: 1, sha256Hash: SEARCH_HASH } }), {
      signal, headers: { referer: `${SITE}/`, origin: SITE, "x-build-id": buildId, accept: "application/json" },
    });
    if (response?.errors?.length) throw new Error("AllManga search failed");
    const show = exactShow(response?.data?.shows?.edges, title);
    return { show, buildId };
  }

  async function cryptoContext(buildId, signal) {
    const host = new URL(SITE).hostname;
    const group = "mkissa";
    const now = Date.now();
    const epoch = Math.floor(now / EPOCH_MS);
    const epochs = now - epoch * EPOCH_MS < EPOCH_GRACE_MS && epoch > 0
      ? [epoch, epoch - 1] : [epoch];
    const url = new URL("/client-crypto/v1/bootstrap", API);
    url.searchParams.set("buildId", buildId);
    url.searchParams.set("k", LANE);
    let lastError;
    for (const requestedEpoch of epochs) {
      const headers = { referer: `${SITE}/`, origin: SITE, "x-build-id": buildId,
        "x-aa-boot": bootToken({ buildId, epoch: requestedEpoch, group, host, lane: LANE }), accept: "application/json" };
      try {
        const data = await readJson(transport, url.href, { signal, headers });
        if (!Number.isSafeInteger(data?.epoch) || typeof data.partB !== "string") throw new Error("AllManga bootstrap response is invalid");
        if (!epochs.includes(data.epoch)) throw new Error("AllManga returned a crypto epoch outside the current grace window");
        return { epoch: data.epoch, key: buildKey(data.partB) };
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error("AllManga bootstrap failed");
  }

  async function* discover(title, { signal } = {}) {
    signal?.throwIfAborted();
    // shortcut: no trusted TMDB-to-catalogue season mapping; enable later seasons only after adding one.
    if (title?.anime !== true || title.type !== "tv" || ![title.title, title.originalTitle].some((name) => normalized(name))
      || title.season !== 1 || !Number.isSafeInteger(title.episode) || title.episode < 1
      || (title.year != null && (!Number.isSafeInteger(title.year) || title.year < 1900 || title.year > 2200))) return;
    const ref = Object.freeze({ title: title.title || "", originalTitle: title.originalTitle || "", year: title.year ?? null,
      type: "tv", season: title.season, episode: title.episode });
    for (const [voiceId, voiceName] of [["sub", "SUB"], ["dub", "DUB"]]) {
      const candidate = { providerId: "allmanga", providerName: "AllManga", catalogSource: "allmanga", voiceId, voiceName,
        qualityHint: "Auto", season: ref.season, episode: ref.episode };
      Object.defineProperty(candidate, "ref", { value: ref, enumerable: false });
      yield candidate;
    }
  }

  async function resolve(candidate, { signal } = {}) {
    const ref = candidate?.ref;
    if (candidate?.providerId !== "allmanga" || candidate.catalogSource !== "allmanga" || !["sub", "dub"].includes(candidate.voiceId)
      || candidate.voiceName !== candidate.voiceId.toUpperCase() || !ref || ref.type !== "tv"
      || candidate.season !== ref.season || candidate.episode !== ref.episode
      || ref.season !== 1 || !Number.isSafeInteger(ref.episode) || ref.episode < 1) {
      throw new Error("Invalid AllManga source reference");
    }
    signal?.throwIfAborted();
    const title = { ...ref, anime: true };
    const { show, buildId } = await search(title, signal);
    const crypto = await cryptoContext(buildId, signal);
    const query = { showId: show._id, translationType: candidate.voiceId, episodeString: String(ref.episode) };
    const aaReq = makeAaReq({ key: crypto.key, epoch: crypto.epoch, buildId, queryHash: EPISODE_HASH, lane: LANE });
    const episodeResponse = await readJson(transport, apiUrl(query, { persistedQuery: { version: 1, sha256Hash: EPISODE_HASH }, aaReq, k: LANE }), {
      signal, headers: { referer: `${SITE}/`, origin: SITE, "x-build-id": buildId, accept: "application/json" },
    });
    if (episodeResponse?.errors?.length) {
      const requiresChallenge = episodeResponse.errors.some((item) =>
        /captcha|challenge/i.test(`${item?.message || ""} ${item?.extensions?.code || ""}`));
      if (requiresChallenge) throw new Error("AllManga requires a site challenge before this episode can play");
      throw new Error("AllManga episode request failed");
    }
    const encrypted = episodeResponse?.data?.tobeparsed;
    const episode = encrypted ? decryptResponse(encrypted, crypto.key).episode : episodeResponse?.data?.episode;
    exactEpisode(episode, show, title, candidate);
    const providers = episode.sourceUrls;
    if (!Array.isArray(providers) || providers.length > 32) throw new Error("AllManga returned invalid source metadata");
    const direct = providers.filter((source) => source?.sourceName === "Default");
    if (direct.length !== 1) throw new Error("AllManga has no unique direct-media source");
    const path = decodeClockPath(direct[0].sourceUrl);
    const clockUrl = new URL(path, CLOCK);
    if (clockUrl.origin !== CLOCK || clockUrl.hostname !== "allanime.day" || !clockUrl.pathname.endsWith("/clock.json")) {
      throw new Error("AllManga clock URL escaped its public origin");
    }
    const clock = await readJson(transport, clockUrl.href, { signal, headers: { referer: `${CLOCK}/`, accept: "application/json" } });
    if (!Array.isArray(clock?.links) || !clock.links.length || clock.links.length > 32) throw new Error("AllManga returned no playable media links");
    const qualities = [];
    const subtitles = [];
    for (const link of clock.links) {
      if (!link || typeof link.link !== "string") continue;
      const url = mediaUrl(link.link);
      if (link.hls === true || /\.m3u8(?:$|\?)/i.test(url)) qualities.push({ label: String(link.resolutionStr || "Auto"), type: "hls", url, headers: { referer: `${CLOCK}/` }, publicOnly: true });
      if (Array.isArray(link.subtitles)) for (const [index, sub] of link.subtitles.slice(0, 16).entries()) {
        if (typeof sub?.src !== "string") continue;
        subtitles.push({ url: mediaUrl(sub.src), label: String(sub.label || `Subtitle ${index + 1}`), language: sub.lang || null, headers: { referer: `${CLOCK}/` }, publicOnly: true });
      }
    }
    if (!qualities.length) throw new Error("AllManga direct source is not HLS media");
    return { qualities, audioNames: [], subtitles };
  }

  return { discover, resolve };
}

export const allMangaProtocol = Object.freeze({ makeAaReq, decryptResponse, bootToken, decodeClockPath, exactShow, deriveMask });
