// Pure normalisers for the Lampac balancer fleet (player source "lampac").
//
// Nothing here touches window/fetch on purpose: every function takes JSON that
// the relay already fetched, so the tricky parts (voice labels, quality dicts,
// episode numbering) can be reasoned about — and fixed — without a browser.
//
// Shapes below are what the live fleet actually returns (probed, not guessed):
//   /lite/events         -> [{name:"Filmix", balanser:"filmix", url:".../lite/filmix", url_p}]
//   /lite/<b>?rjson=true -> {type:"movie",   data:[item...]}
//                           {type:"season",  data:[{method:"link", id, url, name:"1 сезон"}]}
//                           {type:"episode", voice:[{name,url,active}], data:[ep...]}
//                           {type:"similar", data:[{title, year, url, details}]}
//   item.method          -> "play" (url playable) | "call" (GET url -> {method:"play", url, quality})
//   item.quality         -> {"1080p": url, ...} — DISTINCT URLS, not HLS levels
//   item.headers         -> object (rjson) or python-dict string "{'Origin': 'https://vkvideo.ru'}"
//   episode.stream       -> url + "&play=true"; answers m3u8 directly, so prefer it over url
//   <key>_p              -> sibling minted by our relay: the same URL routed (and, for
//                           third-party CDNs, signed) through it. Absent when the relay may
//                           not vouch for that host — then only the raw URL exists and the
//                           browser has to try the CDN directly (works when it sends ACAO).

export const LAMPAC_FALLBACK_HOSTS = [
  // Verified 2026-10-07; dynamic host discovery still refreshes this list.
  "138-16-177-21.nip.io",
  "62-113-116-188.nip.io",
  "138-16-174-90.nip.io",
];

// kinotochka answers HTML instead of JSON; collaps duplicates this project's own
// «Онлайн» source, which resolves it client-side (its CDN tokens are IP-bound, so
// going through the fleet actively breaks it).
export const LAMPAC_BLACKLIST = new Set(["kinotochka", "collaps"]);

// Balancers that serve the title but not in Russian — Ukrainian / Georgian /
// original-language catalogues. Measured on Interstellar: kinoukr, uafilm,
// geosaitebi return non-Russian or original-language dubs (geosaitebi's name is
// literally "ფილმები ქართულად" = films in Georgian); uakino is the Ukrainian
// counterpart of the same catalogue and only ever answered `similar` with no
// exact hit on every RU title probed. They burn the scout's 6-connection budget
// on dubs the viewer will never pick, and they are precisely the "мусорные
// источники" that leave the poor-window open while it waits for a Russian sibling.
export const LAMPAC_NON_RU_BLACKLIST = new Set([
  "kinoukr",
  "uakino",
  "uafilm",
  "geosaitebi",
  "eneyida",
  "kinoflix",
  "moonanime",
]);

// Lampac ships its own display `name` per balancer, so this map is only an
// override for the few whose name says nothing to a Russian-speaking viewer.
export const BALANSER_LABELS = {
  pidtor: "Торренты",
  rutubemovie: "Rutube",
  vkmovie: "VK Видео",
  cdnvideohub: "CDN Video Hub",
};

// Balancers whose payload is a torrent stream (MKV, no HLS wrapper) — playable
// only when the container happens to hold H.264/AAC.
export const TORRENT_BALANSERS = new Set(["pidtor"]);

// ------------------------------------------------------------------ primitives

// Lampac keys the JSON/HTML switch off a query param, and some balancers echo it
// back as `rjson=False` in the URLs they hand out. Going through URLSearchParams
// (not a regex) keeps an `rjson=` that lives inside an encoded `iframe=` intact.
export function withRjson(url) {
  try {
    const u = new URL(url);
    u.searchParams.delete("rjson");
    u.searchParams.set("rjson", "true");
    return u.toString();
  } catch {
    return url;
  }
}

export function withParams(url, params) {
  try {
    const u = new URL(url);
    for (const [k, v] of Object.entries(params || {})) {
      if (v === undefined || v === null || v === "") continue;
      u.searchParams.set(k, String(v));
    }
    return u.toString();
  } catch {
    return url;
  }
}

// Swap only the host of a URL, preserving path + query (id_file, token_movie, …).
// The fleet shares one session store, so a `call` token minted on host A resolves
// on host B — this is what lets a wedged call endpoint be retried on a sibling.
export function withHost(url, host) {
  try {
    const u = new URL(url);
    u.host = host;
    return u.toString();
  } catch {
    return url;
  }
}

export function parseHeaders(raw) {
  if (!raw) return {};
  if (typeof raw === "object") return { ...raw };
  try {
    const j = JSON.parse(raw);
    if (j && typeof j === "object") return j;
  } catch {
    /* python-dict string below */
  }
  const out = {};
  const re = /'([^']+)'\s*:\s*'([^']*)'/g;
  let m;
  while ((m = re.exec(raw))) out[m[1]] = m[2];
  return out;
}

export function qualityHeight(label) {
  const s = String(label || "");
  // "1080p", "1080", "1920x1080" and "4K" all appear across balancers (zetflixdb
  // labels its dict "1080" with no p, zetflix the same file "1080p").
  const m = /(\d{3,4})\s*p\b/i.exec(s) || /^\s*(\d{3,4})\s*$/.exec(s) || /x\s*(\d{3,4})\b/i.exec(s);
  if (m) return Number(m[1]);
  if (/4k|2160/i.test(s)) return 2160;
  if (/fullhd/i.test(s)) return 1080;
  if (/\bhd\b/i.test(s)) return 720;
  return 0;
}

export function hostOf(url) {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

// ------------------------------------------------------------------- balancers
//
// Lampac supplies its own display `name` next to the technical `balanser`, so we
// keep it and only override the few opaque ones. `maxquality` is NOT present at
// the events stage, so no "4K" badge can be shown before a balancer is opened.

export function normalizeEvents(json) {
  const list = Array.isArray(json) ? json : Array.isArray(json?.data) ? json.data : [];
  const out = [];
  const seen = new Set();
  for (const e of list) {
    const balanser = String(e?.balanser || "").trim().toLowerCase();
    if (!balanser || !e?.url || LAMPAC_BLACKLIST.has(balanser) || LAMPAC_NON_RU_BLACKLIST.has(balanser) || seen.has(balanser)) continue;
    seen.add(balanser);
    out.push({
      balanser,
      rawUrl: e.url,
      proxyUrl: e.url_p || null,
      name: BALANSER_LABELS[balanser] || String(e?.name || balanser),
      torrent: TORRENT_BALANSERS.has(balanser),
    });
  }
  return out;
}

// ------------------------------------------------------------- voice labelling

//
// Three balancers abuse the label fields, each differently (all verified live on
// Fight Club):
//   phantom : voice_name = "2160p"  (a quality!),  translate = "Дублированный"
//   pidtor  : voice_name = "107.56 GB /  HDR  / H.265  / 20" (torrent meta)
//   vkmovie : translate  = "Бойцовский клуб (1999)" (the film title, not a dub)
// So: trust `translate` first, accept `voice_name`/`details` only when they don't
// look like a quality or a torrent line, and drop a label that is just the title.

const QUALITY_LABEL_RE = /^\s*(4k|\d{3,4}\s*p|\d{3,4}x\d{3,4})\s*$/i;
const TORRENT_META_RE = /\d+([.,]\d+)?\s*(gb|mb|tb)\b/i;

export function isQualityLabel(s) {
  return QUALITY_LABEL_RE.test(String(s || ""));
}

export function isTorrentMeta(s) {
  return TORRENT_META_RE.test(String(s || ""));
}

const norm = (s) =>
  String(s || "")
    .toLowerCase()
    .replace(/[«»"'`]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

// True when the "voice" is really the movie's own name — vkmovie fills `translate`
// with the upload's title ("Бойцовский клуб (1999) DUB 1920x1080 60fps"), which as
// a dub selector is noise.
export function looksLikeTitle(label, { title, originalTitle } = {}) {
  const l = norm(label);
  if (!l) return true;
  if (/\(\s*(19|20)\d{2}\s*\)/.test(String(label))) return true;
  for (const t of [title, originalTitle]) {
    const n = norm(t);
    if (n && n.length > 2 && (l === n || l.startsWith(n + " ") || l.includes(n))) return true;
  }
  return false;
}

export function voiceLabel(item, ctx = {}) {
  const cand = [item?.translate, item?.voice_name, item?.details, item?.name];
  for (const raw of cand) {
    const s = String(raw || "").trim();
    if (!s || isQualityLabel(s) || isTorrentMeta(s)) continue;
    if (looksLikeTitle(s, ctx)) continue;
    return s;
  }
  return "";
}

// "107.56 GB /  HDR  / H.265  / 20" → {size, tags:["HDR","H.265"], seeds:20}
export function torrentMeta(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  const parts = s.split("/").map((p) => p.trim()).filter(Boolean);
  const out = { raw: s, size: "", tags: [], seeds: null };
  for (const p of parts) {
    if (!out.size && TORRENT_META_RE.test(p)) out.size = p;
    else if (/^\d+$/.test(p)) out.seeds = Number(p);
    else out.tags.push(p);
  }
  return out;
}

// ------------------------------------------------------------------- qualities
//
// `quality` / `mp4quality` are label → URL dicts of DISTINCT files, so switching
// them means re-attaching the engine (unlike HLS levels, which the engine owns).
// The relay adds `quality_p` / `mp4quality_p` with the same labels; a label
// missing from `_p` means the relay may not vouch for that host, so we keep the
// raw URL and let the browser try the CDN directly.

export function extractQualities(item) {
  if (!item || typeof item !== "object") return [];
  const dict = item.quality && typeof item.quality === "object" && !Array.isArray(item.quality)
    ? item.quality
    : item.mp4quality && typeof item.mp4quality === "object" && !Array.isArray(item.mp4quality)
      ? item.mp4quality
      : null;
  const proxied = dict === item.quality ? item.quality_p : item.mp4quality_p;
  const out = [];
  if (dict) {
    for (const [label, url] of Object.entries(dict)) {
      if (typeof url !== "string" || !/^https?:\/\//i.test(url)) continue;
      out.push({
        label: String(label),
        height: qualityHeight(label),
        url,
        proxyUrl: (proxied && typeof proxied === "object" && proxied[label]) || null,
      });
    }
  }
  out.sort((a, b) => b.height - a.height || a.label.localeCompare(b.label));
  // Dedupe by URL: several balancers repeat the same file under two labels.
  const seen = new Set();
  const uniq = out.filter((q) => (seen.has(q.url) ? false : (seen.add(q.url), true)));
  if (uniq.length) return uniq;
  const single = item.stream || item.url;
  if (typeof single === "string" && /^https?:\/\//i.test(single)) {
    return [{
      label: item.maxquality || "auto",
      height: qualityHeight(item.maxquality),
      url: single,
      proxyUrl: (item.stream ? item.stream_p : item.url_p) || null,
    }];
  }
  return [];
}

// Default quality. On the proxied path 2160p is ~8-12 GB per film against a
// project-wide Vercel transfer quota, so it is never the default — the viewer has
// to ask for it explicitly.
export function pickDefaultQuality(list, { mobile = false, capped = true } = {}) {
  if (!Array.isArray(list) || !list.length) return null;
  const limit = mobile ? 720 : capped ? 1080 : 4320;
  const fit = list.find((q) => q.height && q.height <= limit);
  if (fit) return fit;
  // Everything is above the cap (or unlabeled) → take the smallest known height,
  // falling back to the last entry (the list is sorted desc).
  const withH = list.filter((q) => q.height);
  return withH.length ? withH[withH.length - 1] : list[list.length - 1];
}

// Playback START quality — the rung we actually attach FIRST, and (crucially) the
// rung the scout measures its pre-roll on, so the score reflects the real
// time-to-first-frame instead of a heavier rung's. This is what makes a Lampac
// balancer start "like Collaps".
//
// Collaps ships ONE HLS master and hls.js opens on a low level, then ramps up via
// in-file ABR. Lampac's rungs are SEPARATE files with no ABR ramp, so the closest
// equivalent is to open on a light HD rung. Measured on Интерстеллар/phantom, the
// first segment per rung is 2160p 9.0 MB / 1080p 4.26 MB / 720p 2.54 MB (~568 ms
// relay) / 480p 1.03 MB (~245 ms): 720p is the sweet spot — a sub-second pre-roll
// that still clears the HD floor, roughly half the 1080p transfer, while the full
// 2160p→360p ladder stays in the picker for an explicit bump. 2160p is never
// auto-started (the Vercel transfer quota is project-wide).
//
// The probe rung and the playback rung MUST be the same one, or the score promises
// a speed the viewer never gets — so both call sites use THIS function.
// Balancers whose smallest available rung still ships a heavy moov (vkmovie's
// 720p is 2.54 MB — too large for a sub-second pre-roll, so the scout always
// ranks it last). Drop these to 480p on the probe rung so the measured pre-roll
// reflects a rung that actually starts fast, not one that costs the whole
// score race to a 5.6 s moov.
const START_HEIGHT_CAP_PER_BALANSER = {
  vkmovie: 480,
};

export const START_HEIGHT_CAP = 720;
export function pickStartQuality(list, { mobile = false, balanser = "" } = {}) {
  if (!Array.isArray(list) || !list.length) return null;
  const perBalancer = START_HEIGHT_CAP_PER_BALANSER[String(balanser || "").toLowerCase()] || START_HEIGHT_CAP;
  const limit = mobile ? 480 : perBalancer;
  // list is sorted desc by height → the first entry ≤ limit is the highest rung
  // that still starts fast.
  const fit = list.find((q) => q.height && q.height <= limit);
  if (fit) return fit;
  // Everything is above the cap (or unlabeled): take the smallest KNOWN height so a
  // 2160p-only source never auto-pulls 4K, falling back to the last entry.
  const withH = list.filter((q) => q.height);
  return withH.length ? withH[withH.length - 1] : list[list.length - 1];
}

// ---------------------------------------------------------------- voice entries

let voiceSeq = 0;

function voiceFromItem(item, ctx, index) {
  const label = voiceLabel(item, ctx);
  const method = item?.method === "call" ? "call" : "play";
  // A "call" item's `url` is a JSON endpoint, not media: its real quality list only
  // exists in the resolved payload (phantom returns 2160p at the item level but
  // 1080p/720p/480p/360p after the call), so don't invent one here.
  const qualities = method === "play" ? extractQualities(item) : [];
  const meta = isTorrentMeta(item?.voice_name) ? torrentMeta(item.voice_name) : null;
  // For a `call` item the resolve hop MUST hit the JSON endpoint (`url`), not the
  // `stream` shortcut — the shortcut plays directly but only ever at the top
  // quality (phantom's is 4K AV1), bypassing both the quality dict and the
  // ≤1080p proxied-path cap. `play` items have no call, so prefer their direct
  // `stream` m3u8 over the extra-hop `url`.
  const isCall = method === "call";
  const url = isCall ? item?.url || "" : item?.stream || item?.url || "";
  const proxyUrl = isCall
    ? item?.url_p || null
    : (item?.stream ? item?.stream_p : item?.url_p) || null;
  return {
    id: `v${++voiceSeq}`,
    index,
    name: label || (index === 0 ? "Основная" : `Вариант ${index + 1}`),
    method,
    url,
    proxyUrl,
    stream: typeof item?.stream === "string" && /^https?:\/\//i.test(item.stream) ? item.stream : null,
    streamProxyUrl: item?.stream_p || null,
    headers: parseHeaders(item?.headers),
    maxquality: item?.maxquality || (qualities[0]?.label ?? ""),
    qualities,
    meta,
    subtitles: normalizeSubtitles(item),
  };
}

// hdvb hands back three items all called "Дубляж [Лицензия]" and cdnvideohub two
// "Неизвестный": without a suffix the selector looks broken.
function dedupeNames(list) {
  const count = new Map();
  for (const v of list) count.set(v.name, (count.get(v.name) || 0) + 1);
  const seen = new Map();
  for (const v of list) {
    if (count.get(v.name) < 2) continue;
    const n = (seen.get(v.name) || 0) + 1;
    seen.set(v.name, n);
    v.name = `${v.name} · ${n}`;
  }
  return list;
}

export function normalizeSubtitles(item) {
  const raw = item?.subtitles || item?.subtitle;
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  list.forEach((s, i) => {
    const url = typeof s === "string" ? s : s?.url || s?.link;
    if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return;
    const proxied = typeof s === "object" ? s.url_p || s.link_p : null;
    out.push({
      name: (typeof s === "object" && (s.label || s.name)) || `Субтитры ${i + 1}`,
      url,
      proxyUrl: proxied || null,
    });
  });
  return out;
}

// ------------------------------------------------------------------- top shapes

export function lampacKind(json) {
  const t = String(json?.type || "").toLowerCase();
  if (t === "movie" || t === "season" || t === "episode" || t === "similar") return t;
  // Some balancers omit `type` and answer a bare play object.
  if (json?.method === "play" && json?.url) return "movie";
  if (Array.isArray(json?.voice) && Array.isArray(json?.data)) return "episode";
  return "";
}

export function normalizeMovie(json, ctx = {}) {
  const items = Array.isArray(json?.data) ? json.data : json?.method === "play" ? [json] : [];
  const voices = dedupeNames(
    items.filter((it) => it && (it.url || it.stream)).map((it, i) => voiceFromItem(it, ctx, i)),
  );
  return { kind: "movie", voices, maxquality: json?.maxquality || "" };
}

// Resolution of a `method:"call"` item: {method:"play", url, quality:{…}}.
export function normalizeResolved(json) {
  if (!json || typeof json !== "object") return null;
  const qualities = extractQualities(json);
  const url = json.url || json.stream || qualities[0]?.url || "";
  if (!url) return null;
  return {
    url,
    proxyUrl: json.url_p || json.stream_p || qualities[0]?.proxyUrl || null,
    qualities,
    headers: parseHeaders(json.headers),
    subtitles: normalizeSubtitles(json),
  };
}

export function normalizeSeasons(json) {
  const list = Array.isArray(json?.data) ? json.data : [];
  const seasons = [];
  for (const s of list) {
    if (!s?.url) continue;
    const num = Number(s.id ?? (/(\d+)/.exec(String(s.name || ""))?.[1] ?? NaN));
    seasons.push({
      number: Number.isFinite(num) ? num : seasons.length + 1,
      name: s.name || `${Number.isFinite(num) ? num : seasons.length + 1} сезон`,
      url: s.url,
      proxyUrl: s.url_p || null,
    });
  }
  seasons.sort((a, b) => a.number - b.number);
  return { kind: "season", seasons, maxquality: json?.maxquality || "" };
}

// Episode payloads carry the voice list at the TOP level (one entry per dub, each
// a link that re-fetches the whole season), while `data` holds that dub's episodes.
// phantom numbers from 0 ("0 серия" = a pilot/prologue), so never assume e === i+1.
export function normalizeEpisodes(json, ctx = {}) {
  const eps = (Array.isArray(json?.data) ? json.data : [])
    .filter((e) => e && (e.stream || e.url))
    .map((e, i) => {
      const num = Number(e.e ?? /(\d+)/.exec(String(e.name || ""))?.[1] ?? NaN);
      return {
        index: i,
        season: Number(e.s) || ctx.season || 0,
        episode: Number.isFinite(num) ? num : i + 1,
        name: e.name || `${Number.isFinite(num) ? num : i + 1} серия`,
        // `stream` answers m3u8 straight away; `url` costs one more JSON hop.
        item: e,
      };
    });
  const voices = dedupeNames(
    (Array.isArray(json?.voice) ? json.voice : [])
      .filter((v) => v?.url)
      .map((v, i) => ({
        id: `s${++voiceSeq}`,
        index: i,
        name: String(v.name || "").trim() || `Озвучка ${i + 1}`,
        url: v.url,
        proxyUrl: v.url_p || null,
        active: !!v.active,
        meta: isTorrentMeta(v.name) ? torrentMeta(v.name) : null,
      })),
  );
  return { kind: "episode", episodes: eps, voices };
}

// `similar` is a disambiguation list, not content: the balancer could not match the
// title and wants a pick. Prefer one exact title alias with a compatible year;
// otherwise keep the existing unique-year fallback.
export function normalizeSimilar(json, ctx = {}) {
  const list = (Array.isArray(json?.data) ? json.data : []).filter((s) => s?.url);
  const items = list.map((s) => ({
    title: String(s.title || "").trim(),
    year: Number(s.year) || 0,
    details: s.details || "",
    url: s.url,
    proxyUrl: s.url_p || null,
  }));
  const year = Number(ctx.year) || 0;
  let best = null;
  const exact = items.filter((s) =>
    (!year || !s.year || s.year === year) && s.title.split(/\s+\/\s+/).some((alias) =>
      [ctx.title, ctx.originalTitle].some((title) => title && norm(alias) === norm(title)),
    ),
  );
  if (exact.length === 1) best = exact[0];
  else if (!exact.length && year) {
    const sameYear = items.filter((s) => s.year === year);
    if (sameYear.length === 1) best = sameYear[0];
  }
  return { kind: "similar", items, best };
}

// Episode → the item we actually play. A `call` episode (phantom) ships a
// `stream` shortcut too, but that shortcut only ever serves the top quality
// (4K AV1), bypassing both the quality dict and the proxied-path ≤1080p cap — so
// for `call` we take the JSON `url` and let the resolve hop pick quality. A
// `play` episode has no call, so its direct-m3u8 `stream` is preferred over the
// extra-hop `url`.
export function episodeSource(ep) {
  const it = ep?.item || {};
  const isCall = it.method === "call";
  if (isCall) {
    return {
      method: "call",
      stream: typeof it.stream === "string" && /^https?:\/\//i.test(it.stream) ? it.stream : null,
      streamProxyUrl: it.stream_p || null,
      url: it.url,
      proxyUrl: it.url_p || null,
      headers: parseHeaders(it.headers),
      qualities: extractQualities(it),
      subtitles: normalizeSubtitles(it),
    };
  }
  const useStream = typeof it.stream === "string" && /^https?:\/\//i.test(it.stream);
  return {
    method: "play",
    url: useStream ? it.stream : it.url,
    proxyUrl: useStream ? it.stream_p || null : it.url_p || null,
    headers: parseHeaders(it.headers),
    qualities: extractQualities(it),
    subtitles: normalizeSubtitles(it),
  };
}
