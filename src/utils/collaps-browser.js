// Browser-side Collaps resolver. On the web build the stream must be resolved
// from the BROWSER's IP, not the server's: Collaps CDN segment tokens are
// IP-bound, so if the server fetches the embed (server IP) but the browser
// fetches segments (phone IP), segments return 410. Resolving client-side keeps
// the embed → manifest → segments all on the same (browser) IP.
//
// The embed HOST rotates (delivembd → luxembd → ortified → …); a hardcoded
// host is why every title started returning HTTP 422. The live embed URL is
// resolved through bhcesh (CORS-open, IP-agnostic search API); each result
// carries the authoritative current `iframe_url`. The parser is a faithful port
// of the server-side parseCollaps (src/ipc/collaps.js).

const BHCESH_BASE = "https://api.bhcesh.me";
const BHCESH_TOKEN = "eedefb541aeba871dcfc756e6b31c02e";
const COLLAPS_HOST = "kinokrad.my";
const UA = ""; // browsers send their own UA; can't override (and shouldn't)

async function fetchText(url, { headers = {}, timeout = 20000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal, cache: "no-store" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

function extractMakePlayer(html) {
  const i = html.indexOf("makePlayer({");
  if (i < 0) return null;
  const body = html.slice(i + "makePlayer(".length);
  let depth = 0;
  let end = -1;
  let inStr = false;
  let strCh = "";
  for (let idx = 0; idx < body.length; idx++) {
    const ch = body[idx];
    if (inStr) {
      if (ch === "\\") { idx++; continue; }
      if (ch === strCh) inStr = false;
      continue;
    }
    if (ch === '"' || ch === "'") { inStr = true; strCh = ch; continue; }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) { end = idx; break; }
    }
  }
  if (end < 0) return null;
  return body.slice(0, end + 1);
}

function extractNames(obj, from = 0) {
  const re = /"names"\s*:\s*(\[[^\]]*\])/g;
  re.lastIndex = from;
  const m = re.exec(obj);
  if (!m) return [];
  try { return JSON.parse(m[1]); } catch { return []; }
}

function matchHls(chunk) {
  const m = chunk.match(/"?hls"?\s*:\s*"([^"]+\.m3u8[^"]*)"/);
  return m ? m[1] : null;
}

function extractJsonArray(obj, key) {
  const keyRe = new RegExp('"?(' + key + ')"?\\s*:\\s*\\[');
  const m = keyRe.exec(obj);
  if (!m) return null;
  const start = m.index + m[0].length - 1;
  let depth = 0;
  let inStr = false;
  let strCh = "";
  for (let idx = start; idx < obj.length; idx++) {
    const ch = obj[idx];
    if (inStr) {
      if (ch === "\\") { idx++; continue; }
      if (ch === strCh) inStr = false;
      continue;
    }
    if (ch === '"' || ch === "'") { inStr = true; strCh = ch; continue; }
    if (ch === "[") depth++;
    else if (ch === "]") {
      depth--;
      if (depth === 0) return obj.slice(start, idx + 1);
    }
  }
  return null;
}

export function parseCollaps(html, { type, season, episode } = {}) {
  const obj = extractMakePlayer(html);
  if (!obj) return { ok: false, error: "makePlayer не найден на странице embed" };

  const isTv = type === "tv";
  let hls = null;
  let dash = null;
  let audioNames = [];
  let subtitles = [];
  let duration = 0;

  if (isTv) {
    const arr = extractJsonArray(obj, "seasons");
    let seasons = null;
    if (arr) { try { seasons = JSON.parse(arr); } catch { seasons = null; } }
    if (!seasons || !seasons.length) return { ok: false, error: "Сезоны не найдены на Collaps" };
    let seasonObj = seasons.find((s) => Number(s.season) === Number(season));
    if (!seasonObj && season == null) seasonObj = seasons[0];
    if (!seasonObj) return { ok: false, error: "Сезон не найден на Collaps" };
    const episodes = seasonObj.episodes || [];
    let ep = episodes.find((e) => Number(e.episode) === Number(episode));
    if (!ep && episode == null) ep = episodes[0];
    if (!ep) return { ok: false, error: "Серия " + season + "x" + episode + " не найдена на Collaps" };
    hls = ep.hls || null;
    dash = ep.dash || ep.dasha || null;
    audioNames = (ep.audio && ep.audio.names) || [];
    subtitles = Array.isArray(ep.cc) ? ep.cc.map((c, i) => ({ url: c.url, name: c.name || "Субтитры " + (i + 1) })) : [];
    duration = ep.duration || 0;
    if (!hls && !dash) return { ok: false, error: "Поток не найден для серии " + season + "x" + episode };
  } else {
    const srcIdx = obj.search(/"?source"?\s*:\s*\{/);
    const from = srcIdx >= 0 ? srcIdx : 0;
    const sourceBlock = srcIdx >= 0 ? obj.slice(from, from + 4000) : obj;
    hls = matchHls(sourceBlock) || matchHls(obj);
    const dashM = sourceBlock.match(/"?dash"?\s*:\s*"([^"]+\.mpd[^"]*)"/);
    dash = dashM ? dashM[1] : null;
    audioNames = extractNames(obj);
    const ccArr = extractJsonArray(obj, "cc");
    if (ccArr) { try { const cc = JSON.parse(ccArr); subtitles = cc.map((c, i) => ({ url: c.url, name: c.name || "Субтитры " + (i + 1) })); } catch {} }
    if (!hls && !dash) return { ok: false, error: "Поток не найден в source Collaps" };
  }
  return { ok: true, hls, dash, audioNames, subtitles, duration };
}

// imdb_id/kinopoisk_id → the live iframe embed URL via bhcesh, or null. The imdb
// id must be BARE digits ("0167404", not "tt0167404").
async function resolveIframe({ imdbId, kinopoiskId }) {
  const q = new URLSearchParams({ token: BHCESH_TOKEN });
  if (imdbId) q.set("imdb_id", String(imdbId).replace(/^tt/i, ""));
  else if (kinopoiskId) q.set("kinopoisk_id", String(kinopoiskId));
  else return null;
  try {
    const r = await fetch(`${BHCESH_BASE}/franchise/details?${q}`, { cache: "no-store" });
    if (!r.ok) return null;
    const j = await r.json().catch(() => null);
    return (j && typeof j.iframe_url === "string" && j.iframe_url) || null;
  } catch {
    return null;
  }
}

// Resolve a Collaps stream from the browser. The kinopoisk-id-by-title fallback
// still hits the server (/api/collaps/find-kp) since that's not IP-bound.
export async function collapsResolveBrowser({ imdbId, kinopoiskId, type, season, episode }, findKp) {
  if (!imdbId && !kinopoiskId) return { ok: false, error: "Нужен imdb_id или kinopoisk_id" };
  const iframe = await resolveIframe({ imdbId, kinopoiskId });
  if (!iframe) return { ok: false, error: "Collaps: тайтл не найден в каталоге" };
  // The embed CDN requires `Origin: https://kinokrad.my` — browser fetch()
  // can't forge that, so the SPA goes through /api/collaps which sets the
  // partner identity server-side and streams the HTML back.
  const target = iframe + (iframe.includes("?") ? "&" : "?") + "host=" + COLLAPS_HOST;
  const b64 = (s) => {
    const bytes = new TextEncoder().encode(s);
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  };
  const url = "/api/collaps?u=" + b64(target);
  try {
    const html = await fetchText(url);
    return parseCollaps(html, { type, season: Number(season), episode: Number(episode) });
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
