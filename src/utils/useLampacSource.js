// React hook that turns the Lampac balancer fleet into the same {hls|mp4}
// stream shape OnlinePlayer already understands, plus the balancer/voice/quality
// selectors the fleet needs and Collaps never did.
//
// All network lives in lampac-client.js; all pure logic in lampac-browser.js.
// This hook is only orchestration + React state, so the tricky sequencing
// (kp-id first, `similar` auto-hop, season→episode descent, `call` resolve,
// direct-first playback) sits in one readable place instead of leaking into the
// 1200-line player.
//
// Contract consumed by OnlinePlayer:
//   stream       {hls}|{mp4}|null      — same field names as the Collaps path
//   balansers[]  {id,name,torrent}     — source picker
//   balanser     active id (string)
//   voices[]     {id,name,meta}        — dub picker (replaces in-stream audio)
//   voice        active id
//   qualities[]  {id,label,height}     — "source" qualities (distinct files)
//   quality      active id
//   selectBalanser / selectVoice / selectQuality (id)
//   switching    bool — re-attach in flight; player keeps <video> mounted
//   sourceError  {kind,message}|null — inline, never state="error"
//   meta         string
//   subtitles[]  {name,url,proxyUrl} — player builds <track>s from these

import { useCallback, useEffect, useRef, useState } from "react";
import { tmdbFetch, isAnimeContent } from "./api";
import { collapsFindKp } from "./collaps-client";
import { lampacEvents, lampacWarmBalanser, lampacBalanser, lampacResolveCall, playableUrl, probeMediaUrl } from "./lampac-client";
import { storage, getLampacState, setLampacState } from "./storage";
import {
  lampacKind,
  normalizeMovie,
  normalizeSeasons,
  normalizeEpisodes,
  normalizeSimilar,
  normalizeResolved,
  episodeSource,
  extractQualities,
  pickStartQuality,
} from "./lampac-browser.js";

const HLS_RE = /\.m3u8(\?|$)/i;
const MP4_RE = /\.(mp4|mkv|webm|m4v|mov)(\?|$)/i;

// A playable {url,viaRelay} + the ORIGINAL url → {hls|mp4} for the player. The
// relay wrapper hides the file extension, so the container is judged from the
// raw url. Fleet proxy URLs (`/proxy/<b64>` with no extension) match NEITHER
// regex even though every Lampac `method:"play"` item is a progressive MP4;
// defaulting those to {hls} made hls.js load them as playlists and the player
// sat at 0:00/0:00 forever ("vkmovie не грузит"). Fall through to {mp4} when
// the URL has no extension and the viaRelay marker is set — fleet proxy is
// always progressive.
function streamShape(src, rawUrl) {
  if (!src?.url) return null;
  const raw = String(rawUrl || "");
  if (HLS_RE.test(raw)) return { hls: src.url, viaRelay: src.viaRelay };
  if (MP4_RE.test(raw)) return { mp4: src.url, viaRelay: src.viaRelay };
  // No extension in the URL — fleet proxy URLs. Treat as mp4 by default; hls
  // items from the fleet keep their `extension` because the relay hands them
  // out via _p siblings with the original m3u8 path.
  return { mp4: src.url, viaRelay: src.viaRelay };
}

// TMDB → the identifiers Lampac matches on. imdb_id and kinopoisk_id both widen
// balancer coverage — measured on Scarface: title+year alone answers 16
// balancers, +imdb_id the same 16 (but from cache, 114 ms vs 520 ms), +kinopoisk_id
// 20, the four extras (zetflix, zetflixdb, cdnvideohub, kinoflix) being kp-keyed
// only. Worth having, NOT worth blocking discovery on: see the discovery effect,
// which asks the fleet with what it already has and merges the widened list when
// these land.
//
// `base` is everything obtainable without a request. A movie's TMDB details
// already carry imdb_id, so for a film the external_ids hop is skipped entirely.
async function resolveIds({ apiKey, item, type, base, signal = null }) {
  const ids = { ...base };
  const [ext, kp] = await Promise.all([
    !ids.imdbId && apiKey && item?.id
      ? tmdbFetch(
          type === "tv" ? `/tv/${item.id}/external_ids` : `/movie/${item.id}/external_ids`,
          apiKey,
          { signal },
        ).catch((e) => { if (e?.name === "AbortError") throw e; return null; })
      : null,
    ids.title
      ? collapsFindKp({ query: ids.title, year: ids.year }, { signal }).catch(() => null)
      : null,
  ]);
  if (!ids.imdbId && ext?.imdb_id) ids.imdbId = ext.imdb_id;
  if (kp?.ok && kp.kinopoiskId) ids.kinopoiskId = kp.kinopoiskId;
  return ids;
}

// The identifiers we have right now, from props alone — no network.
function baseIds({ item, details }) {
  const title = details?.title || details?.name || item?.title || item?.name || "";
  return {
    title,
    originalTitle: details?.original_title || details?.original_name || item?.original_title || item?.original_name || title,
    originalLanguage: details?.original_language || item?.original_language || "",
    anime: isAnimeContent(item, details),
    tmdbId: item?.id,
    year: (details?.release_date || details?.first_air_date || item?.release_date || item?.first_air_date || "").slice(0, 4) || "",
    // /movie/{id} includes imdb_id; /tv/{id} does not (that needs external_ids).
    imdbId: details?.imdb_id || item?.imdb_id || null,
    kinopoiskId: null,
  };
}

// The `extra` params every first balancer hop carries (Lampac echoes them back
// into the URLs it hands out, so later hops pass the returned URL untouched).
function searchQuery(ids, type) {
  return {
    title: ids.title || ids.originalTitle || "",
    original_title: ids.originalTitle || ids.title || "",
    year: ids.year || undefined,
    serial: type === "tv" ? "1" : "0",
    imdb_id: ids.imdbId || undefined,
    kinopoisk_id: ids.kinopoiskId || undefined,
    original_language: ids.originalLanguage || undefined,
    anime: ids.anime ? "1" : undefined,
    tmdb_id: ids.tmdbId || undefined,
    rjson: "true",
  };
}

// How long discovery waits for the widening id lookups before asking the fleet
// with what props alone already gave it. Measured from here: external_ids lands
// in ~120–300 ms, the kp lookup in ~200–600 ms — so a short grace usually catches
// the cheap one for free while never letting the slow one gate the first fleet
// request. Whatever arrives late still triggers one additive re-ask.
//
// It is only ever paid when imdb_id is still MISSING, because that id is the one
// that improves how each balancer matches the title (fewer `similar` dead ends).
// The kp id merely widens the list — kp-keyed balancers arrive as extra failover
// candidates via the re-ask, so waiting for it would be 300 ms for nothing. A
// movie's TMDB details already carry imdb_id, so films skip the grace entirely.
const IDS_GRACE_MS = 300;

// The dub that should be selected before the viewer touches anything: the one
// Lampac flagged `active`, else the first.
function defaultVoiceIndex(voices) {
  const i = voices.findIndex((v) => v.active);
  return i >= 0 ? i : 0;
}

function pickEpisode(episodes, want) {
  if (!episodes.length) return null;
  const n = Number(want);
  return episodes.find((e) => e.episode === n) || null;
}

// ── Per-series descent caches ────────────────────────────────────────────────
// A series is watched episode by episode, and every episode click used to
// re-run the WHOLE descent: title hop → seasons list → season payload. All of
// it is identical for every episode of the same season — only the final
// episode-payload read differs, and that payload is shared by the whole
// season too. So the title result and the season payload are cached per
// (balanser, series[, season]) for the session: episode 2..N skip three round
// trips through the relay, the next season skips one. Short TTL because fleet
// URLs can rotate; a stale entry fails into the existing retry paths.
const SERIES_CACHE_TTL = 10 * 60 * 1000;
const titleDescentCache = new Map(); // seriesKey → { at, json }  (hop1 result)
const seasonDescentCache = new Map(); // seriesKey|season → { at, json }  (season payload)

function descentCacheGet(map, key) {
  const hit = map.get(key);
  if (hit && Date.now() - hit.at < SERIES_CACHE_TTL) return hit.json;
  map.delete(key);
  return null;
}
function descentCacheSet(map, key, json) {
  map.set(key, { at: Date.now(), json });
  // Bound the maps: a long session touches many series, and each payload is
  // hundreds of KB.
  if (map.size > 16) map.delete(map.keys().next().value);
}

// Resolves ONE balancer down to {voices, source} where source is the item we
// will actually play ({method,url,proxyUrl,headers,qualities,subtitles}). Throws
// a tagged error ({kind}) on any dead end so the hook can show it inline.
//
// `signal` is a real AbortSignal and is threaded into every hop: when the scout
// gives up on this balancer (or the viewer switches away) the in-flight relay
// request is aborted rather than abandoned. Abandoning it would leave it holding
// one of the browser's six connections to our own origin — which is exactly the
// contention that used to make the winning stream start late.
async function loadContext({ entry, query, ids, type, season, episode, voiceIdx, signal, onHop1 = null }) {
  const fail = (message, kind = "no-link") => {
    throw Object.assign(new Error(message), { kind });
  };
  const stop = () => { if (signal?.aborted) fail("cancelled", "cancelled"); };
  // Identity of the SERIES (not the episode) — the cache key prefix shared by
  // every episode of this show on this balancer.
  const seriesKey = `${entry.balanser}|${type}|${ids?.imdbId || ids?.kinopoiskId || ids?.title || query || ""}`;
  // First hop carries the search query; the fleet echoes season/voice params back
  // into the URLs it hands out, so later hops pass the returned URL untouched.
  // For a series the title result is identical for every episode, so a warm
  // cache skips the hop entirely (episode 2..N of a season pay zero title hops).
  let r;
  const cachedTitle = type === "tv" ? descentCacheGet(titleDescentCache, seriesKey) : null;
  if (cachedTitle) {
    onHop1?.();
    r = { ok: true, json: cachedTitle };
  } else {
    r = await lampacBalanser(entry.rawUrl, { extra: query, proxyUrl: entry.proxyUrl, signal });
    stop();
    // The host answered its first hop → it is ALIVE. Tell the scout so the
    // first-hop (dead-host) deadline is dropped and only the total budget
    // governs the rest of the descent.
    onHop1?.();
    if (!r.ok) fail(r.error || "Балансер не ответил", r.kind || "no-link");
    // Remember the title result for the next episode of this series.
    if (type === "tv") descentCacheSet(titleDescentCache, seriesKey, r.json);
  }

  let kind = lampacKind(r.json);

  // `similar`: the balancer couldn't match the title and wants a pick. Auto-hop
  // when exactly one candidate matches the year; otherwise give up on this one.
  if (kind === "similar") {
    const sim = normalizeSimilar(r.json, ids);
    if (!sim.best) fail("Нет точного совпадения", "no-link");
    r = await lampacBalanser(sim.best.url, { proxyUrl: sim.best.proxyUrl, signal });
    stop();
    if (!r.ok) fail(r.error || "Балансер не ответил", r.kind || "no-link");
    kind = lampacKind(r.json);
  }

  // ── Movie: voices are the playable items themselves ──────────────────────────
  if (type !== "tv") {
    if (kind !== "movie") fail("Фильм не найден у этого балансера", "no-link");
    const { voices } = normalizeMovie(r.json, ids);
    if (!voices.length) fail("Нет озвучек", "no-link");
    const idx = voiceIdx != null && voiceInRange(voiceIdx, voices) ? voiceIdx : 0;
    return { voices, activeIdx: idx, source: voices[idx] };
  }

  // ── TV: balancer → seasons → the season's episode+voice payload ─────────────
  if (kind === "season") {
    const { seasons } = normalizeSeasons(r.json);
    if (!seasons.length) fail("Сезоны не найдены", "no-link");
    const want = Number(season);
    const pick = seasons.find((s) => s.number === want);
    if (!pick) fail("Сезон не найден у этого источника", "no-link");
    const seasonKey = `${seriesKey}|${pick.number}`;
    let seasonJson = type === "tv" ? descentCacheGet(seasonDescentCache, seasonKey) : null;
    if (!seasonJson) {
      const rs2 = await lampacBalanser(pick.url, { proxyUrl: pick.proxyUrl, signal });
      stop();
      if (!rs2.ok) {
        // Drop a possibly-stale cached payload so the next attempt re-fetches
        // instead of failing into the same dead URL again.
        if (type === "tv") seasonDescentCache.delete(seasonKey);
        fail("Сезон не открылся", "no-link");
      }
      seasonJson = rs2.json;
      if (type === "tv") descentCacheSet(seasonDescentCache, seasonKey, seasonJson);
    }
    kind = lampacKind(seasonJson);
    r = { ok: true, json: seasonJson };
  }
  if (kind !== "episode") fail("Серии не найдены", "no-link");

  // The first episode payload belongs to whatever dub Lampac defaulted to. If the
  // viewer picked another dub, re-fetch that dub's season for its episode list.
  let epJson = r.json;
  let { voices } = normalizeEpisodes(epJson, { season });
  if (!voices.length) {
    // Some balancers answer a single-dub series with no voice[] — synthesise one.
    voices = [{ id: "s0", index: 0, name: "Основная", url: null, proxyUrl: null, active: true, meta: null }];
  }
  const activeIdx = voiceIdx != null && voiceInRange(voiceIdx, voices) ? voiceIdx : defaultVoiceIndex(voices);
  const chosen = voices[activeIdx];
  if (chosen?.url && !chosen.active) {
    const rv = await lampacBalanser(chosen.url, { proxyUrl: chosen.proxyUrl, signal });
    stop();
    if (!rv.ok || lampacKind(rv.json) !== "episode") fail("Выбранная озвучка недоступна", "no-link");
    epJson = rv.json;
  }
  const { episodes } = normalizeEpisodes(epJson, { season });
  const ep = pickEpisode(episodes, episode);
  if (!ep) fail("Серия не найдена", "no-link");
  return { voices, activeIdx, source: episodeSource(ep) };
}

function voiceInRange(i, voices) {
  return Number.isInteger(i) && i >= 0 && i < voices.length;
}

// A source item ({method,url,proxyUrl,headers,qualities}) → the real quality list.
// `call` items need one more JSON hop before any playable URL (and their true
// quality dict) exists; `play` items already carry it.
async function resolveSource(source, { signal = null, spread = true } = {}) {
  if (source?.method === "call") {
    const rr = await lampacResolveCall(source.url, {
      headers: source.headers,
      proxyUrl: source.proxyUrl,
      signal,
      spread,
    });
    if (!rr.ok) {
      // A provider's published stream may work even when its quality resolver fails.
      if (source.stream && rr.kind !== "cancelled" && !signal?.aborted) {
        return resolveSource({ ...source, method: "play", url: source.stream, proxyUrl: source.streamProxyUrl }, { signal, spread });
      }
      return { ok: false, error: rr.error, kind: rr.kind || "stale" };
    }
    const norm = normalizeResolved(rr.json);
    if (!norm) return { ok: false, error: "Пустой ответ", kind: "no-link" };
    return {
      ok: true,
      qualities: norm.qualities.length ? norm.qualities : extractQualities(rr.json),
      subtitles: norm.subtitles,
      fallback: { url: norm.url, proxyUrl: norm.proxyUrl, headers: norm.headers },
    };
  }
  const qualities = source?.qualities?.length ? source.qualities : extractQualities(source || {});
  return {
    ok: true,
    qualities,
    subtitles: source?.subtitles || [],
    fallback: { url: source?.url, proxyUrl: source?.proxyUrl, headers: source?.headers || {} },
  };
}

// Stable id for a quality entry (label can repeat across heights, so key on both).
const qId = (q) => `${q.height || 0}:${q.label}`;

// Balancer entries → the shape the picker consumes.
const pubList = (list) => list.map((b) => ({ id: b.balanser, name: b.name, torrent: b.torrent }));

// Key for a probe's resolved descent. Season/episode are in it because a probe
// resolved the DEFAULT dub of one specific episode — a different one has to be
// walked properly. Caching `ctx` itself across episodes is unsafe: `ctx.source`
// carries a per-episode URL that goes stale within minutes and would, on the next
// episode switch, hand the resolve effect a `source` for the PREVIOUS episode —
// stream-dead → user picks another balancer → UI snaps to whatever the scout had
// in flight (the "CDN Video Hub self-switch" bug).
const probeKey = (slug, season, episode) => `${slug}|${season ?? ""}|${episode ?? ""}`;
// A `call` hop's URL goes stale within minutes ("Ссылка устарела"), so a handed-over
// context is only trusted for as long as the start-up it was meant for.
const PROBE_TTL = 45000;

// ── Learned balancer ranking ─────────────────────────────────────────────────
// The fleet's order is title-agnostic, and some balancers fail on nearly
// everything from this network: measured repeatedly, kinobase / kinogo / vibix /
// uakino answer 503 or run the clock out to a 502, and zetflix resolves and then
// dies on the first segment append. Probing those first spends the whole budget
// before a working sibling is even asked. So remember how each one has actually
// behaved and let that reorder the list — learned, not a hardcoded blacklist, so
// a balancer that comes back to life recovers on its own.
const LS_BAL = "lampac_bal";
const BAL_CLAMP = 4;
let balScores = null;

// A COLD visitor has an empty ranking, so the fleet's own order stands — and the
// fleet puts losers first. Measured on Человек-паук (fresh localStorage): the
// first wave was filmix / pizdatoehd / kinobase / phantom, three of them burning
// the FULL scout cap (4032 / 4033 ms) and phantom burning 7001 ms (cap +
// CALL_GRACE), with kinogo taking the freed slot for another 4001 ms. The actual
// winner, rutubemovie, could not even LAUNCH until 4857 ms — every slot was held
// by a balancer that was never going to answer. Playback began at 9607 ms.
//
// So the ranking starts SEEDED with what the fleet has actually been measured to
// do, instead of at zero. Snapshot across Интерстеллар / Начало / Матрица /
// Человек-паук, hop1 unless noted:
//   working — rutubemovie 3/3 (98-115 ms), hdvb 3/3 (109-194), pidtor 3/3 (~350)
//   passable — pizdatoehd 3/3 but answers `similar` with n=230; veoveo 3/3
//     (370-698); geosaitebi 3/3 (615-854); vkmovie 3/3 (491-2131) but its media
//     is an 8.2 MB-header mp4 (scored -5287 — it passes and is still terrible)
//   wedging — vibix / kinogo / uakino all 502 at ~20 s, EVERY title
//   slow-failing — kinobase 8215-20009, eneyida ~8220, uafilm ~9150,
//     leproduction 1181-2210, kinoukr ~500, filmix 1/3
//   phantom — hop1 is the FASTEST in the fleet (115 ms, 7 items, mq=2160p) but
//     its `call` hop is dead on all five hosts (502 at 20079/20577/21112/20600/
//     20586 ms). Demoted, NOT cut: it keeps the only 2160p ladder in the fleet,
//     so the moment its call recovers a single success pulls it back up.
//
// This is a SEED, not a blacklist, and the distinction is the whole point:
//   * it only applies to a balancer the visitor has NO stored score for, so real
//     local experience always wins (their network is the authority on their
//     network);
//   * noteBal moves seeded entries exactly like any other, in both directions;
//   * nothing is removed from the list — every balancer is still probed, and
//     advance() still walks the un-probed tail, so a revived host recovers on
//     its own with no code change.
// Values are clamped to ±BAL_CLAMP, same as learned ones.
// Re-measured 2026-08-06 across Интерстеллар / Во все тяжкие / Дюна 2, and the
// table moved enough to invalidate the previous seed:
//   • filmix is 3/3 at 483-562 ms — it was seeded -2 from a 1/3 sample. Its
//     Интерстеллар mp4 still carries a 34 MB moov, but that is the PROBE's job
//     (prerollMs) and not a reason to ask it late.
//   • kinogo has degraded from "502 at ~20 s" to answering no headers at all
//     (>12 s, 3/3) — same class as uakino now.
//   • collaps is 3/3 and fast, and is deliberately NOT here: LAMPAC_BLACKLIST
//     drops it at discovery because this project resolves it client-side (its CDN
//     tokens are IP-bound, so the fleet's copy is broken by design).
//   • the seed used to conflate "fails" with "fails EXPENSIVELY", which is the
//     distinction that actually matters now that a slot is the scarce resource:
//     vibix 503s at 26-96 ms and eneyida at ~1.1 s — they cost a slot almost
//     nothing and free it for the next wave, so they rank ahead of kinobase /
//     kinogo / uakino, which hold one for seconds before failing.
//   • pizdatoehd answers `similar` with n=230 (no exact hit) on every title
//     probed, so it should not be spending a first-wave slot on fleet order alone.
//   • kinoukr / uafilm / uakino / geosaitebi are additionally cut before the scan
//     by LAMPAC_NON_RU_BLACKLIST; they stay listed here so the ranking is still
//     correct if that gate is ever relaxed.
const BAL_SEED = {
  // 2026-08-15 fleet probe: every host × every balancer returns 000/8s except
  // veoveo (answers 200 with real data on Lost S1E11). veoveo is promoted
  // above the rest of the fleet; the user-confirmed ranking is preserved on
  // healthy days via the learned `balScores` map, which overrides this seed.
  rutubemovie: 3,
  veoveo: 3,
  hdvb: 2,
  filmix: 2,
  pidtor: 1,
  vkmovie: 1,    // user-confirmed preferred
  zetflix: 1,    // user-confirmed preferred
  pizdatoehd: -1,
  leproduction: -2,
  vibix: -2,
  eneyida: -2,
  // phantom returned 503 on every host × title probed 2026-08-14 (25/25); its
  // backend is currently dead fleet-side. -3 keeps it ahead of the broken
  // blacklist tier so a future revival is one `noteBal(ok)` away from being
  // race-eligible again, without making it the cold-start default while it
  // half-loads.
  phantom: -3,
  kinoukr: -3,
  kinobase: -4,
  uafilm: -4,
  kinogo: -4,
  uakino: -4,
};

// User-confirmed preferred balancers for the picker UI. The scout race is
// ordered by BAL_SEED + a learned ranking; this set is the VIEW filter on
// top of that — balancers in this set appear at the top of the picker when
// any of them survive the scout, so the viewer doesn't have to scroll past
// cdnvideohub/hdvb/etc every title. To customise: edit this list.
const PREFERRED_PICKER = new Set([
  "rutubemovie", "rutube", "phantom", "vkmovie", "zetflix",
  "filmix", "pidtor",
]);

function balStats() {
  if (balScores) return balScores;
  const raw = storage.get(LS_BAL);
  balScores = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  return balScores;
}

// Effective weight: the visitor's own measurement when it exists, the seed
// otherwise. `in` rather than a truthiness test — noteBal stores a genuine 0
// (a balancer that failed once and recovered once), and that IS learned
// experience, so it must override the seed rather than fall through to it.
function balWeight(slug) {
  const s = balStats();
  if (slug in s) return Number(s[slug]) || 0;
  const seed = BAL_SEED[slug];
  return typeof seed === "number" ? seed : 0;
}

function noteBal(slug, ok, weight = 1) {
  if (!slug) return;
  const s = balStats();
  // Start from the effective weight so the very first real observation moves off
  // the seed instead of off zero — otherwise one success would rocket a known
  // wedger straight past a proven balancer.
  const cur = balWeight(slug);
  const next = Math.max(-BAL_CLAMP, Math.min(BAL_CLAMP, cur + (ok ? weight : -weight)));
  if (slug in s && next === Number(s[slug] || 0)) return;
  s[slug] = next;
  // Debounced write: a scan calls noteBal once per probe verdict (up to ~17 per
  // title), and each write used to JSON.stringify the whole map and do a
  // synchronous localStorage.setItem on the main thread — on the critical path
  // between the click and the first frame. The in-memory map is authoritative
  // for the session; the flush lands at most once per window (and on pagehide).
  if (!balFlushTimer) {
    balFlushTimer = setTimeout(() => {
      balFlushTimer = null;
      try { storage.set(LS_BAL, balStats()); } catch {}
    }, BAL_FLUSH_MS);
  }
}

let balFlushTimer = null;
const BAL_FLUSH_MS = 1000;
if (typeof window !== "undefined") {
  // Never lose the last second of learning to a tab close.
  window.addEventListener("pagehide", () => {
    if (balFlushTimer) { clearTimeout(balFlushTimer); balFlushTimer = null; }
    try { storage.set(LS_BAL, balStats()); } catch {}
  });
}

// Stable — equal scores keep the fleet's own priority.
function rankEntries(entries) {
  return entries
    .map((e, i) => ({ e, i, w: balWeight(e.balanser) }))
    .sort((a, b) => b.w - a.w || a.i - b.i)
    .map((x) => x.e);
}

// ── Balancer scout tuning ────────────────────────────────────────────────────
// The scout's ONE job is to hand the player a stream fast. Everything here is a
// bounded cost paid before the first frame, so every constant is chosen as "the
// smallest value that still answers the question", not "the value that never
// misjudges".
//
// The previous shape of this block was the reason the app felt slow, and it is worth
// naming precisely because the fix is structural rather than a re-tune. It had three
// WAITING windows — compare (1500 ms), poor (3500 ms) and up to two poor renewals —
// so a title whose survivors were all merely-adequate spent up to ~10.5 s
// DELIBERATELY not starting anything, on the theory that a leaner sibling might
// still appear. Combined with a 4000 ms per-probe cap on four slots, the floor on
// time-to-first-frame was seconds even when a perfectly good stream had been
// certified in the first 300 ms.
//
// The model now is a single absolute DECISION DEADLINE. From the moment the scan
// starts, the scout has SCAN_DECIDE_MS to look around; whatever the best survivor is
// at that instant starts playing. A clearly-great survivor still fires immediately,
// so the healthy case pays nothing at all, and the worst case is bounded by one
// number instead of by a renewal chain.
//
// The relay is SAME-ORIGIN, so how many probes may run at once is set by the
// transport: HTTP/1.1 gives the browser six connections shared with the winning
// stream's own playlist/segment fetches, while HTTP/2 (Vercel's edge, and any
// https:// origin) multiplexes on one. Measured on Scarface under h1: the first
// certain winner was known at 195 ms yet playback began at 4533 ms because eighteen
// probes were still holding the pipe. So concurrency is measured, not guessed.
// 2026-08-15: during the fleet outage veoveo was the only survivor buried
// under 14 dead siblings. The browser/Worker only has so many sockets, so
// cranking concurrency is bounded — we pick the largest number that lets
// the winner's own hops still race without queueing. On h1 we used 4 (≤6
// minus 2 for the winner); on h2 we used 8. With the fleet in rough shape
// the wins don't show up in the first wave as often, so the tail of probes
// matters more — bump both numbers and let the browser schedule them.
const SCAN_CONCURRENCY_H1 = 6;     // ≤6 minus headroom for the winner's own hops
const SCAN_CONCURRENCY_H2 = 10;    // multiplexed: the limit is the fleet's patience
const SCAN_CONCURRENCY_AFTER = 3;  // once a winner is certain, yield the pipe
// Which of the two applies. `nextHopProtocol` on our own resource timings is the
// honest answer and costs nothing — no request is made, we just read what the
// browser already recorded for same-origin responses it has fetched. Unknown or
// empty (very old browsers, or a document served from cache with no timing entries)
// falls back to the conservative h1 number.
let scanConcurrencyCache = 0;
function scanConcurrency() {
  if (scanConcurrencyCache) return scanConcurrencyCache;
  let h2 = false;
  try {
    const entries = performance?.getEntriesByType?.("resource") || [];
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (!e?.nextHopProtocol) continue;
      // Same-origin only: a CDN's protocol says nothing about ours.
      if (e.name && e.name.indexOf(location.origin) !== 0) continue;
      h2 = e.nextHopProtocol === "h2" || e.nextHopProtocol === "h3";
      break;
    }
  } catch { h2 = false; }
  scanConcurrencyCache = h2 ? SCAN_CONCURRENCY_H2 : SCAN_CONCURRENCY_H1;
  return scanConcurrencyCache;
}
// Per-probe budget while the probe is still DESCENDING (balancer JSON → optional
// `call` hop → CORS probe) and has produced no media bytes. See the SPLIT below:
// this total only applies once the host has answered its first hop — the
// first-hop deadline (HOP1_CAP_MS) is what bounds dead hosts. The measured
// fleet: a healthy first hop is 98-714 ms across every working balancer
// (rutubemovie 98-115, hdvb 109-194, filmix 483-562, veoveo 370-698, pidtor ~350),
// while the failures are not near-misses but different by an order of magnitude —
// kinobase 8.2-20 s, eneyida ~8.2 s, uakino/kinogo no headers at all.
// 2026-08-15 fleet outage: 14/17 balancers dead-on-arrival (TLS timeout,
// 503). Each dead probe still eats up to 1.8 s before the cap aborts, so the
// cumulative wait at SCAN_CONCURRENCY=4 was 4–5 wasted seconds before the
// alive sibling (veoveo) even got a slot. Tighten the per-probe cap so dead
// hosts bail fast and the live ones get a slot sooner.
//
// The deadline is now SPLIT in two, because "dead" and "cold" need opposite
// treatment and one number cannot serve both:
//   • HOP1_CAP_MS — no response headers on the FIRST hop by then → the host
//     is dead (TLS timeout / headerless 503). Abort at once, reclaim the slot.
//   • SCAN_CAP_MS — the TOTAL probe budget for a host that HAS answered hop1.
//     Such a host is alive; its remaining descent (season/voice/`call` hops)
//     legitimately takes seconds on a cold relay — the file's own measurements
//     put the healthy `call` hop at 2.5–4.4 s and filmix's cold first hop at
//     3.4 s. The old single 900 ms cap killed those mid-descent (the CALL_GRACE
//     extension only reached 2.7 s < 4.4 s), so working balancers were
//     systematically disqualified and re-probed wave after wave.
// Cold healthy first hops can take over three seconds.
const HOP1_CAP_MS = 4000;
const SCAN_CAP_MS = 4500;
const SCAN_CAP_AFTER_MS = 700;     // after a winner: nothing is waiting on these
const SCAN_POOL_TARGET = 2;        // survivors banked → stop scouting entirely
// Hard wall-clock deadline on everything after the winner fires. The pool is a
// nice-to-have from that moment on and un-probed balancers lose nothing: advance()
// appends them after the pool and tries them lazily if the winner won't decode.
const SCAN_TAIL_MS = 1500;
// Tail when the fired survivor is GREAT (fast + HD): the failover pool is a
// nice-to-have from that moment, and every extra probe holds one of the
// browser's six connections while the winner's manifest/segments queue.
const GREAT_TAIL_MS = 600;
// ── The decision deadline ────────────────────────────────────────────────────
// Wall-clock from the scan's start within which the scout must commit. At this point
// the best survivor so far fires, whatever it is; if NOTHING has survived yet the
// scan simply continues (there is nothing to fire) and the next passing probe is
// judged against rule 1 below.
//
// 2026-08-15 fleet outage: with 14 dead siblings the 1200 ms deadline expired
// before veoveo had a chance. Working balancers all certify inside ~700 ms of
// their launch, and the first wave launches at t≈0, so 1200 ms was previously
// enough. With the 2026-08-15 cap tightened from 1800 → 900 ms the worst-case
// of one wave is 900 ms, so the deadline can be tightened too — a live balancer
// that's still loading at 800 ms is a future problem we can live with.
const SCAN_DECIDE_MS = 900;
// One bounded extension of that deadline, granted only for the case it exists to
// protect: the best survivor is visibly SD (or offers no ladder at all) and a probe
// that could plausibly carry HD/4K is still in flight. This is what keeps "у phantom
// пропал выбор разрешение, а у них 4к" fixed without reintroducing a waiting window
// — it is granted once, it is short, and it is skipped entirely whenever the best
// survivor already offers HD.
const SCAN_HOLD_MS = 500;
// A probe that has already resolved its descent and is READING MEDIA BYTES gets this
// much extra time, once, past its cap. The cap exists to stop balancers that HANG,
// and a probe streaming bytes is the opposite of hung. Measured on Во все тяжкие:
// filmix's cold first hop took 3420 ms and its `postid` hop 241 ms, so a byte-probe
// of a DIRECT cdnsqu.com file was aborted 335 ms in — four milliseconds under the
// old cap — and the scout threw away a direct survivor it had all but confirmed.
// Smaller than it used to be because the read itself is now much smaller: fast-mode
// probes sample 32-64 KB and size the first segment from content-range rather than
// transferring it (see probeMediaUrl's `fast` option). Granted once, so it can never
// compound.
const PROBE_GRACE_MS = 800;
// Same one-shot pattern for the `call` hop's JSON reply. Sized from measurement, NOT
// from the worst case: the healthy call hop now answers in 2.5-4.4s on the fleet
// (up from 571-725 ms when the fleet was 121ms-warm), so 1.8s matches the new
// reality — protecting the probe from being aborted just as the call hop is
// about to answer. phantom's call is dead on all five hosts (502 at ~20 s), so no
// grace could save it — it is demoted in BAL_SEED instead, which keeps it probed,
// keeps it reachable via advance(), and lets one success pull its 2160p ladder
// straight back up.
const CALL_GRACE_MS = 1800;
// How many balancers to warm on the detail page (see lampacWarm). Tracks the scout's
// first wave, so the warm-up covers exactly the hops that are about to be on the
// critical path and none that aren't. Sized to SCAN_CONCURRENCY_H1 so the WHOLE
// first wave starts from the fleet's cache — with WARM_BAL_N = 4 the wave's probes
// 5-6 were guaranteed cold and their cold hop1 (up to ~3.4 s) was the first thing
// on the critical path after the click.
const WARM_BAL_N = 6;
// …warmed two at a time, not four: the relay is same-origin, and the detail page is
// simultaneously loading its own poster/backdrop through it. Two leaves four of the
// browser's six connections free, so warming can never be the thing that makes the
// page feel slow.
const WARM_BAL_CONCURRENCY = 2;

// ── Switch / descent safety net ──────────────────────────────────────────────
// A switch (or a first descent) that never reaches playback must not spin forever.
// Two independent guards close every "eternal loading" path:
//   • the resolve/quality effects ABORT their own hops after SWITCH_DESCENT_MS —
//     far under the relay's 25 s per-hop cap, since a healthy descent is 1–4 s, so
//     a wedged relay connection is reclaimed in seconds instead of held to 25 s;
//   • a post-attach watchdog drops the `switching` freeze if the freshly-attached
//     media never fires `playing` within SWITCH_WATCHDOG_MS (autoplay blocked, a
//     stalled MediaSource, a 404-after-attach), then advances (auto) or lets the
//     viewer pick again (manual) instead of leaving the overlay up.
// A manually-picked `call` balancer (phantom) commonly fails on a STALE resolve;
// re-descending re-fetches the balancer page and a fresh call URL, which is what
// repopulates its 4K quality list — so a manual pick RE-DESCENDS a bounded number
// of times rather than silently jumping to a different balancer or dead-ending
// with an empty picker.
const SWITCH_DESCENT_MS = 12000;
export const SWITCH_WATCHDOG_MS = 14000;
const MANUAL_RETRY_MAX = 2;
const MANUAL_RETRY_BACKOFF_MS = 400;

// Rate a passing probe verdict (from probeMediaUrl). Higher = the player will reach
// `playing` sooner. Speed NEVER turns a pass into a fail (a slow balancer still
// streams, just poorly) — it only decides which survivor to start on and how the
// failover pool is ordered, so an imperfect estimate can at worst pick an equally
// good balancer, never exclude a working one.
//
// The ranking quantity is PREDICTED TIME TO FIRST FRAME, because that is what the
// viewer experiences and because the two obvious proxies each lie:
//   • "direct" alone lies. Filmix's Интерстеллар is a CORS-open 1.7 GB mp4 that the
//     old scoring made an instant winner — while its 34.4 MB `moov` must land in full
//     before frame 1 (measured 8.7-12.5 s). rutubemovie serves the same film through
//     the RELAY in ~1.5 s because its segments are 60 KB.
//   • manifest speed alone lies. A master m3u8 arrives in a few KB whether its
//     segments are 60 KB or 5.4 MB (kinogo/phantom), and zetflix's deep relay
//     segments trickle at 20-26 s each with no error at all.
//
// So the score is built from BYTES, which are known exactly, rather than from
// throughput samples, which are not. probeMediaUrl reads content-range on every hop,
// so the manifest's full size and the first segment's full size are both declared
// facts even in fast mode where only 64 KB / 1 byte was actually transferred;
// prerollMs converts them at one rate per path (direct vs relay). Throughput readings
// are still consumed when present (the interactive, non-fast path measures them) but
// nothing depends on their existence — a fast-mode verdict with segKbps 0 scores on
// exactly the same scale.
const DIRECT_BONUS = 900;
// Pre-roll we treat as free: below this the wait is dominated by the descent, not
// by the transfer, and penalising it would only add noise.
const PREROLL_FREE_MS = 600;
// …and the resolution the source actually OFFERS, which speed alone ignores. Measured
// on Груз 200: filmix won twice at 720x404 while phantom served 1280x720 within
// 1.5 s of it, and on Интерстеллар phantom carries a full 2160p→360p ladder. The
// viewer's complaint ("у phantom пропал выбор разрешение, а у них 4к" / "и где выбор")
// is about WHICH source wins, so the ladder is part of the verdict now. Deliberately
// bounded well under DIRECT_BONUS: it breaks near-ties and never buys a source that is
// a whole second slower, because a 4K ladder nobody can start is worth nothing.
const HEIGHT_BONUS = { 2160: 260, 1080: 190, 720: 100 };
const LADDER_STEP_BONUS = 55;   // per extra rung, capped below
const LADDER_MAX_BONUS = 165;
// Height the source resolves at: its own dict first (that IS the picker's contents),
// else what the master manifest declared. 0 = genuinely unknown, never penalised.
const probeHeight = (v) => Math.max(v?.maxHeight || 0, v?.height || 0);
function qualityBonus(v) {
  const h = probeHeight(v);
  let b = 0;
  if (h >= 2160) b = HEIGHT_BONUS[2160];
  else if (h >= 1080) b = HEIGHT_BONUS[1080];
  else if (h >= 720) b = HEIGHT_BONUS[720];
  return b + Math.min(LADDER_MAX_BONUS, Math.max(0, (v?.ladder || 1) - 1) * LADDER_STEP_BONUS);
}
function prerollPenalty(v) {
  const ms = v?.prerollMs || 0;
  return ms <= PREROLL_FREE_MS ? 0 : ms - PREROLL_FREE_MS;
}
// A manifest hls.js must download WHOLE before it can request a fragment. Judged by
// its DECLARED size, so a pathological master (zetflix: 1.3 MB / 1701 URIs) is
// recognised from its content-range even when the probe read only 64 KB of it. The
// penalty is per-100 KB and capped: a 2.8 MB hdvb manifest is a real cost, but never
// a bigger one than a genuinely dead segment path.
const MANIFEST_FREE_KB = 96;
const MANIFEST_PENALTY_PER_KB = 0.4;
const MANIFEST_MAX_PENALTY = 500;
function manifestPenalty(v) {
  const kb = Math.round((v?.manifestBytes || v?.bytes || 0) / 1024);
  if (kb <= MANIFEST_FREE_KB) return 0;
  return Math.min(MANIFEST_MAX_PENALTY, Math.round((kb - MANIFEST_FREE_KB) * MANIFEST_PENALTY_PER_KB));
}
function probeScore(v) {
  if (!v || !v.ok) return -1;
  const bonus = v.direct ? DIRECT_BONUS : 0;
  let s = 1500;
  if (v.kind === "media") {
    // A progressive file: the only cost that isn't already in prerollMs is how fast
    // the head arrived, which the read did measure. Absent (fast mode reads too
    // little to time meaningfully), the pre-roll estimate carries the whole judgement.
    s += Math.min(1000, v.kbps || 0);
  } else {
    s -= manifestPenalty(v);
    // A throughput reading, when one exists, is worth something — but it is a bonus
    // rather than a requirement, so a fast-mode verdict is not penalised for lacking
    // one. `capped` means the manifest never ended inside the read budget, which in
    // fast mode is merely "bigger than 64 KB" and is already priced by
    // manifestPenalty — so it no longer carries its own charge.
    s += Math.min(600, Math.round((v.segKbps || 0) / 2));
  }
  return s + bonus + qualityBonus(v) - prerollPenalty(v);
}

// A survivor good enough to start on THE INSTANT it appears, with no deliberation at
// all. This is the fast path the whole design leans on: on a healthy title the first
// or second probe to land is great, fires immediately, and the decision deadline is
// never even consulted.
//
// "Great" means the pre-roll is small enough that no sibling could plausibly beat it
// — not merely that the stream is direct. The old rule fired filmix's 34 MB moov
// immediately and locked the viewer into an 8-12 s wait while a 1.5 s relay-HLS
// sibling was still probing. A candidate whose pre-roll is real (a 4-5 MB first
// segment, a multi-MB mp4 header) is merely a CANDIDATE: it competes on score at the
// decision deadline instead of firing on arrival.
//
// A playlist has additionally proved its SEGMENT path by reaching here at all —
// probeMediaUrl fetches the first segment and fails the probe on a 4xx, so a manifest
// that is 200/CORS-open with dead segments (veoveo: api.rstprgapipt.com manifest
// acao=*, segments 401/403) never becomes a verdict in the first place.
const GREAT_PREROLL_MS = 900;
// …and a source that is fast but visibly SD is not "great" either. Measured on
// Груз 200: filmix resolved a single 480p file and, being direct and light, fired
// instantly at 720x404 — while phantom's 1280x720 was certified ~1.5 s later and
// never got the chance. Below this height the candidate competes at the deadline
// instead of firing at once, so the worst case is SCAN_DECIDE_MS and the best case is
// HD instead of SD. An unknown height (0) is not held back — absence of a dict is not
// evidence of SD.
const GREAT_MIN_HEIGHT = 720;
// …and a manifest the player must swallow whole before its first fragment request is
// pre-roll too, however fast it arrives. Bounded here rather than scored, because
// "great" is a claim about the whole start, not just the segment.
const GREAT_MAX_MANIFEST_KB = 512;
function probeGreat(v) {
  if (!v || !v.ok) return false;
  if ((v.prerollMs || 0) > GREAT_PREROLL_MS) return false;
  const h = probeHeight(v);
  if (h && h < GREAT_MIN_HEIGHT) return false;
  if (v.kind === "media") {
    // Direct is great on its own (no relay, and its byte range is served by a CDN
    // that just proved it answers). A relayed progressive file needs to have shown
    // real throughput — but only when a reading exists; fast mode reads 32 KB, which
    // is too little to time, and the pre-roll estimate above already carries the
    // judgement in that case.
    if (v.direct) return true;
    return v.kbps ? v.kbps >= 300 : (v.prerollBytes || 0) > 0;
  }
  // Playlist: the segment path is alive (a dead one failed the probe) and the block
  // before frame 1 is small. Throughput is used when measured and not required when
  // absent — a fast-mode verdict reports segKbps 0 by design, and demanding it here
  // would make every relayed HLS source non-great and push every title to the
  // deadline, which is exactly the dead air this rewrite removes.
  if (Math.round((v.manifestBytes || v.bytes || 0) / 1024) > GREAT_MAX_MANIFEST_KB) return false;
  if (v.segStatus != null && v.segStatus >= 400) return false;
  return v.segKbps ? v.segKbps >= 200 : (v.segBytes || 0) > 0;
}

// Parallel balancer scout on an absolute decision deadline.
//
// The fleet returns balancers best-first, but balancer[0] frequently can't match a
// given title (it answers `similar` with no exact hit, 503s, or times out) even when a
// lower-priority sibling plays it fine — so blindly taking [0] dead-ends on titles the
// fleet can actually serve. This probes them concurrently, caps each one so a hung
// host can't squat on a slot, and commits by exactly two rules:
//
//   1. a GREAT survivor fires the instant its verdict lands — no deliberation, and
//      this is the common case on a healthy title;
//   2. otherwise, at the DECISION DEADLINE (SCAN_DECIDE_MS from the scan's start,
//      plus at most one SCAN_HOLD_MS extension when the best survivor is SD and an
//      HD-capable probe is still in flight), whatever scored best fires.
//
// If nothing has survived by the deadline there is nothing to fire, so the scan keeps
// going and rule 1 applies to whatever lands next — the deadline is a commitment
// point, never a give-up point.
//
// What this replaces is the reason the app felt slow. The previous version had a
// compare window (1500 ms), a longer poor window (3500 ms) and up to two renewals of
// it, so a title whose survivors were all merely-adequate could spend ~10.5 s
// deliberately not starting anything while it waited for a leaner sibling that, on
// the Interstellar class of title, does not exist. The deadline model keeps the one
// thing those windows bought — not committing to a 34 MB-moov start when a lean
// sibling is one probe away — because 1200 ms is longer than every healthy balancer's
// entire descent, so the real siblings have all reported by then anyway.
//
// After firing it TIGHTENS: shorter caps, lower concurrency, a hard SCAN_TAIL_MS wall
// clock, and a stop once SCAN_POOL_TARGET survivors are banked, aborting whatever is
// still in flight. A byte-probe pass is necessary but NOT sufficient (a balancer can
// return a valid master m3u8 yet die on the first segment append — only the <video>
// element is the true judge), so the pool exists so the player can walk to the next
// candidate when a stream that looked fine refuses to decode. Stopping early does not
// shrink that coverage: advance() appends every un-probed balancer after the pool, so
// they are tried lazily instead of pre-probed.
//
// Every probe gets its own AbortSignal (handed to probeOk) and the cap ABORTS it
// rather than merely abandoning the promise — an abandoned fetch keeps its
// connection, which is precisely what used to delay the winning stream.
function scanBalancers(entries, probeOk, {
  concurrency = scanConcurrency(),
  concurrencyAfter = SCAN_CONCURRENCY_AFTER,
  cap = SCAN_CAP_MS,
  capAfter = SCAN_CAP_AFTER_MS,
  tail = SCAN_TAIL_MS,
  poolTarget = SCAN_POOL_TARGET,
  decideMs = SCAN_DECIDE_MS,
  holdMs = SCAN_HOLD_MS,
  onFirst,
  signal,
} = {}) {
  return new Promise((resolve) => {
    const n = entries.length;
    if (!n) { resolve([]); return; }
    const state = new Array(n).fill(0); // 0 pending · 1 ok · -1 fail
    const verdict = new Array(n).fill(null); // probeMediaUrl result for the passes
    const slots = new Array(n).fill(null); // in-flight: {ctrl, timer, at}
    let launched = 0, done = 0, passed = 0;
    let firstFired = false, settled = false;
    let decideTimer = null, held = false;
    let tailTimer = null;
    // Launch/finish stamps per probe — diagnostics only (see finish()'s sink push).
    const scanT0 = Date.now();
    const startAt = new Array(n).fill(0), endAt = new Array(n).fill(0);

    // Priority-ordered by SPEED, then fleet order: the failover pool should walk
    // toward the fastest survivor, not merely the highest-priority one.
    const survivorsByScore = () => {
      const out = [];
      for (let i = 0; i < n; i++) if (state[i] === 1) out.push(i);
      out.sort((a, b) => probeScore(verdict[b]) - probeScore(verdict[a]) || a - b);
      return out;
    };

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(tailTimer);
      clearTimeout(decideTimer);
      signal?.removeEventListener("abort", finish);
      for (let i = 0; i < n; i++) {
        const s = slots[i];
        if (!s) continue;
        clearTimeout(s.timer);
        clearTimeout(s.capTimer);
        if (s.hop1Timer) clearTimeout(s.hop1Timer);
        s.ctrl.abort();
        slots[i] = null;
      }
      // Opt-in scan report. Costs nothing unless something has already created the
      // sink (the local test harness does; nothing in the app ever does), and it is
      // the only way to see WHY a balancer won without re-deriving the whole descent
      // outside the app. Deliberately a plain array push, no formatting, no logging.
      try {
        const sink = typeof globalThis !== "undefined" && globalThis.__lampacScan;
        if (Array.isArray(sink)) {
          sink.push(entries.map((e, i) => ({
            bal: e.balanser, state: state[i], score: probeScore(verdict[i]),
            great: probeGreat(verdict[i]),
            // WHEN each probe ran, relative to the scan's own start. Without this a
            // slow descent is indistinguishable from a late launch, and the two need
            // opposite fixes (tighter caps vs more concurrency).
            at: startAt[i] ? startAt[i] - scanT0 : null,
            ms: startAt[i] && endAt[i] ? endAt[i] - startAt[i] : null,
            v: verdict[i] && {
              kind: verdict[i].kind, direct: verdict[i].direct, prerollMs: verdict[i].prerollMs,
              prerollBytes: verdict[i].prerollBytes, segKbps: verdict[i].segKbps,
              maxHeight: verdict[i].maxHeight, ladder: verdict[i].ladder, reason: verdict[i].reason,
            },
          })));
        }
      } catch { /* diagnostics must never break a scan */ }
      resolve(survivorsByScore().map((i) => entries[i]));
    };
    if (signal?.aborted) { finish(); return; }
    signal?.addEventListener("abort", finish, { once: true });

    const arm = (i, ms) => {
      const s = slots[i];
      if (!s) return;
      clearTimeout(s.timer);
      s.timer = setTimeout(() => s.ctrl.abort(), Math.max(0, ms));
      if (s.capTimer) {
        clearTimeout(s.capTimer);
        s.capTimer = setTimeout(() => s.capResolve(false), Math.max(0, ms));
      }
    };
    // One-shot FIRST-HOP deadline (HOP1_CAP_MS): a host that has produced no
    // response headers on its first hop by now is dead, whatever its total
    // budget says — abort immediately and hand the slot to the next balancer.
    // Cleared the instant the first hop answers (onHop1), after which only the
    // total SCAN_CAP_MS governs.
    const onHop1 = (i) => {
      const s = slots[i];
      if (!s || s.hop1Seen) return;
      s.hop1Seen = true;
      if (s.hop1Timer) { clearTimeout(s.hop1Timer); s.hop1Timer = null; }
    };

    // One-shot deadline extension for a probe that has finished its descent and is
    // now reading media bytes — see PROBE_GRACE_MS. `extra` is folded into every
    // later re-arm (including tighten's) so the grant survives a winner appearing.
    const graceBytes = (i) => {
      const s = slots[i];
      if (!s || settled || s.extra) return;
      s.extra = PROBE_GRACE_MS;
      arm(i, (firstFired ? capAfter : cap) + s.extra - (Date.now() - s.at));
    };
    // Same one-shot pattern for the call hop: the healthy call answers in ~0.6-0.7 s
    // on every fleet host, so a probe that's resolved its descent and is awaiting the
    // call response would otherwise be aborted right at its cap and lose its qualities
    // ladder — see CALL_GRACE_MS.
    const graceCall = (i) => {
      const s = slots[i];
      if (!s || settled || s.extra) return;
      s.extra = CALL_GRACE_MS;
      arm(i, (firstFired ? capAfter : cap) + s.extra - (Date.now() - s.at));
    };
    // A probe already running when the winner appears keeps its original deadline
    // otherwise — which is how six balancers each sat on a connection for the full
    // 6 s while the stream that had already won waited behind them.
    const tighten = () => {
      const now = Date.now();
      for (let i = 0; i < n; i++) {
        const s = slots[i];
        if (s) arm(i, Math.min(cap + s.extra - (now - s.at), capAfter + s.extra));
      }
    };

    // Highest-scoring survivor so far; ties resolve to fleet priority because the
    // loop only replaces on a strict improvement.
    const bestNow = () => {
      let b = -1;
      for (let i = 0; i < n; i++) {
        if (state[i] !== 1) continue;
        if (b < 0 || probeScore(verdict[i]) > probeScore(verdict[b])) b = i;
      }
      return b;
    };

    const fire = (i) => {
      if (firstFired) return;
      firstFired = true;
      clearTimeout(decideTimer);
      try {
        const sink = typeof globalThis !== "undefined" && globalThis.__lampacScan;
        if (Array.isArray(sink)) {
          sink.push({
            fired: entries[i].balanser, score: probeScore(verdict[i]),
            great: probeGreat(verdict[i]), at: Date.now(), ms: Date.now() - scanT0,
          });
        }
      } catch { /* diagnostics must never break a scan */ }
      if (onFirst) onFirst(entries[i]);
      tighten();
      // From here the pool is a nice-to-have and the stream is what matters.
      // A GREAT survivor needs no further scouting at all — cut the tail short
      // so the remaining probes stop holding the browser's connections while
      // the winner's own manifest/segments queue behind them (measured on
      // Scarface under h1: winner known at 195 ms, playback at 4533 ms because
      // eighteen probes still held the pipe). Un-probed balancers lose nothing:
      // advance() appends them lazily if the winner won't decode.
      tailTimer = setTimeout(finish, probeGreat(verdict[i]) ? GREAT_TAIL_MS : tail);
    };

    // THE DECISION DEADLINE. Fired once, decideMs after the scan started (see
    // SCAN_DECIDE_MS). Whatever scored best at this instant gets the viewer.
    //
    // Two things it deliberately does NOT do:
    //   • it does not give up. With no survivor yet there is nothing to fire, so the
    //     scan simply carries on and `passedDeadline` makes the next passing probe
    //     fire on arrival regardless of how good it is;
    //   • it does not wait for a "better" sibling on score grounds. That was the poor
    //     window, and on titles whose survivors are all heavy relayed HLS the sibling
    //     it waited for did not exist — pure dead air. The single exception is
    //     RESOLUTION, below, because a wrong choice there is not recoverable by
    //     waiting a moment longer: the viewer gets an SD stream with no 4K in the
    //     picker at all, which is the "у phantom пропал выбор разрешение, а у них 4к"
    //     complaint. That hold is granted at most once and is short.
    let passedDeadline = false;
    const decide = () => {
      if (firstFired || settled) return;
      passedDeadline = true;
      const b = bestNow();
      if (b < 0) return; // nothing to commit to yet → rule 1 takes over
      const h = probeHeight(verdict[b]);
      const sd = h > 0 && h < GREAT_MIN_HEIGHT;
      // Is a candidate that could plausibly carry HD still coming? Only in-flight or
      // un-launched probes count, and only when the current best is visibly SD.
      const moreComing = done < n;
      if (sd && moreComing && !held) {
        held = true;
        decideTimer = setTimeout(decide, holdMs);
        return;
      }
      fire(b);
    };
    decideTimer = setTimeout(decide, decideMs);

    const maybeFirst = () => {
      if (firstFired) return;
      const best = bestNow();
      if (best < 0) return;              // nothing has passed yet → keep probing
      // Rule 1: a clearly-great survivor starts at once. The healthy case, and it
      // costs exactly nothing — no window, no timer, no deliberation.
      if (probeGreat(verdict[best])) { fire(best); return; }
      // Past the deadline with no great candidate: the viewer has waited long enough,
      // take the best thing available now.
      if (passedDeadline && !held) { fire(best); return; }
      // Everything has resolved and the best is only adequate: no point waiting for a
      // deadline that can no longer change the answer.
      if (done === n) { fire(best); return; }
      // Otherwise: hold for the deadline, which is already armed.
    };

    const pump = () => {
      if (settled) return;
      // Enough is enough: a certain winner plus a couple of spare candidates is all
      // the failover pool ever consumes, and every further probe steals a
      // connection from the stream that is already starting.
      if (firstFired && passed >= poolTarget) { finish(); return; }
      const budget = firstFired ? concurrencyAfter : concurrency;
      while (launched < n && launched - done < budget) {
        const i = launched++;
        const ctrl = new AbortController();
        // The cap also resolves false directly: a probe step that ignores its
        // signal must not be able to hold the scan open past its deadline. Both
        // deadlines live on the slot so graceBytes/tighten can move them together.
        let capResolve;
        const capped = new Promise((r) => { capResolve = r; });
        slots[i] = { ctrl, timer: null, at: Date.now(), extra: 0, capTimer: null, capResolve, hop1Timer: null, hop1Seen: false };
        startAt[i] = slots[i].at;
        slots[i].capTimer = setTimeout(() => capResolve(false), firstFired ? capAfter : cap);
        slots[i].hop1Timer = setTimeout(() => {
          const s = slots[i];
          if (s && !s.hop1Seen) { s.ctrl.abort(); s.capResolve(false); }
        }, HOP1_CAP_MS);
        arm(i, firstFired ? capAfter : cap);
        Promise.race([
          Promise.resolve().then(() => probeOk(entries[i], ctrl.signal, () => graceBytes(i), () => graceCall(i), () => onHop1(i))).catch(() => false),
          capped,
        ]).then((res) => {
          const s = slots[i];
          endAt[i] = Date.now();
          if (s) { clearTimeout(s.timer); clearTimeout(s.capTimer); if (s.hop1Timer) clearTimeout(s.hop1Timer); s.ctrl.abort(); slots[i] = null; }
          if (settled) return;
          // probeOk now yields a verdict object (or false). Keep it for scoring.
          const v = res && typeof res === "object" && res.ok ? res : null;
          state[i] = v ? 1 : -1;
          if (v) { verdict[i] = v; passed++; }
          done++;
          maybeFirst();
          if (done === n) finish(); else pump();
        });
      }
    };
    pump();
  });
}

// Widened ids are worth memoising for the same reason the balancer listing is. The
// kinopoisk lookup measured 714 ms and (for a series) the external_ids hop 120-300 ms,
// and both were being paid AFTER the Play click, where they gate the additive
// /lite/events re-ask. Keyed by title identity rather than object identity so the
// detail page's warm-up and the descent that follows it share ONE lookup instead of
// racing two. Persisted to localStorage with a long TTL on top of the in-memory
// map: a kinopoisk_id is a pure function of the title and never changes, so every
// session after the first starts with the widened ids already in hand (the
// memory-only cache meant every reload re-paid ~1 s of lookups). A failed lookup
// is deliberately not cached so it stays retryable.
const IDS_CACHE_TTL = 10 * 60 * 1000;
const IDS_DISK_KEY = "lampac_idsCache";
const IDS_DISK_TTL = 30 * 24 * 60 * 60 * 1000;
const idsCache = new Map();
const idsInFlight = new Map();

// Seed the in-memory map from disk once. Entries older than the disk TTL are
// dropped on read; the map is bounded so a long history can't grow it forever.
let idsDiskSeeded = false;
function seedIdsFromDisk() {
  if (idsDiskSeeded) return;
  idsDiskSeeded = true;
  try {
    const saved = storage.get(IDS_DISK_KEY);
    if (!saved || typeof saved !== "object") return;
    const now = Date.now();
    for (const [key, v] of Object.entries(saved)) {
      if (v && typeof v.at === "number" && now - v.at < IDS_DISK_TTL) idsCache.set(key, v);
    }
  } catch { /* corrupt entry — start cold */ }
}
let idsFlushTimer = null;
function idsCacheFlush() {
  idsFlushTimer = null;
  try {
    const obj = {};
    const now = Date.now();
    for (const [key, v] of idsCache) {
      if (now - v.at < IDS_DISK_TTL) obj[key] = v;
    }
    storage.set(IDS_DISK_KEY, obj);
  } catch { /* quota — the memory tier keeps working */ }
}

function resolveIdsCached({ apiKey, item, type, base, signal = null }) {
  const key = `${type}:${item?.id}:${base.imdbId || ""}`;
  seedIdsFromDisk();
  const hit = idsCache.get(key);
  if (hit && Date.now() - hit.at < IDS_CACHE_TTL) return Promise.resolve({ ...base, imdbId: hit.value.imdbId || base.imdbId, kinopoiskId: hit.value.kinopoiskId || base.kinopoiskId });
  const live = idsInFlight.get(key);
  if (live) return live.then((ids) => ({ ...base, imdbId: ids.imdbId || base.imdbId, kinopoiskId: ids.kinopoiskId || base.kinopoiskId }));
  // F9: signal only threads into the LIVE call. A cached hit is instant (no
  // request), and an in-flight call is shared with `lampacWarm` whose consumer
  // has a longer lifetime than the discovery effect — aborting it from the
  // discovery effect would also abort the warm consumer's hop.
  const run = resolveIds({ apiKey, item, type, base, signal }).then((full) => {
    if (full && (full.kinopoiskId || full.imdbId)) {
      const entry = { at: Date.now(), value: full };
      idsCache.set(key, entry);
      if (!idsFlushTimer) idsFlushTimer = setTimeout(idsCacheFlush, 1500);
    }
    return full;
  });
  idsInFlight.set(key, run);
  run.then(() => idsInFlight.delete(key), () => idsInFlight.delete(key));
  return run;
}

// Warm the Lampac descent for a title the viewer is only LOOKING at.
//
// Three hops used to be paid, in series, AFTER the Play click, and all three are
// warm-up-able because Lampac caches its upstream matches per title:
//   • /lite/events — measured 1284 ms first ask, 121 ms repeat;
//   • the id lookups that widen it — kinopoisk 714 ms, external_ids 120-300 ms;
//   • each balancer's own first hop — filmix 3420 ms cold in a live descent against
//     756/146 ms first/repeat measured straight through the relay. That cold hop is
//     what made the scout abort a direct survivor 4 ms under its cap.
// Warming them here, while the viewer reads the page, empties the critical path: the
// scout's first wave then starts from the fleet's cache on every hop.
//
// Costs nothing extra — every request here is one the descent was going to make.
// Nothing is awaited, no failure is cached, and requests are deduped, so a warm-up
// racing the real descent shares its work instead of doubling it.
export function lampacWarm({ item, details, type = "movie", apiKey = null }) {
  if (!item?.id) return;
  const base = baseIds({ item, details });
  if (!base.title && !base.originalTitle) return;
  const evArgs = (ids) => ({
    ...ids, serial: type === "tv",
  });
  // Warm the balancers the scout's first wave will actually open, two at a time, in
  // the same learned order the descent ranks them in — so the hops that get warmed
  // are the hops that end up on the critical path. `serial:"0"/"1"` and the ids are
  // all that go in the query; season/episode are not part of a first hop, so one
  // warm-up serves every episode of a series.
  const warmBalansers = async (ids) => {
    const ev = await lampacEvents(evArgs(ids));
    if (!ev?.ok || !ev.balansers?.length) return;
    const query = searchQuery(ids, type);
    const picks = rankEntries(ev.balansers).filter((e) => !e.torrent).slice(0, WARM_BAL_N);
    for (let i = 0; i < picks.length; i += WARM_BAL_CONCURRENCY) {
      await Promise.all(
        picks.slice(i, i + WARM_BAL_CONCURRENCY).map((e) =>
          Promise.resolve(lampacWarmBalanser(e.rawUrl, { extra: query, proxyUrl: e.proxyUrl })),
        ),
      );
    }
  };
  try {
    // The LISTING to warm is the one discovery asks first: with imdb_id already in
    // hand (every film — TMDB movie details carry it) that is the props-only query.
    if (base.imdbId) lampacEvents(evArgs(base)).catch(() => {});
    // The BALANSER hops to warm are keyed on the WIDENED query, though — not this
    // one. Discovery overwrites queryRef the moment the id lookups land, and every
    // balancer hop (including the scout's) carries that widened query, so warming the
    // props-only variant would warm a string nobody asks for. On a page the viewer
    // has looked at before, resolveIdsCached answers instantly and this is immediate;
    // on a cold one it costs the kp lookup's ~700 ms, still seconds ahead of the click.
    resolveIdsCached({ apiKey, item, type, base })
      .then((full) => warmBalansers(full || base))
      .catch(() => {});
  } catch { /* never let a warm-up throw into a render */ }
}

// ─────────────────────────────────────────────────────────────────── the hook
export default function useLampacSource({ enabled, apiKey, item, details, type = "movie", season = null, episode = null }) {
  const [balansers, setBalansers] = useState([]);
  const [balanser, setBalanser] = useState(null);   // active balancer slug
  const [voices, setVoices] = useState([]);          // [{id,name,meta,active}]
  const [voiceIdx, setVoiceIdx] = useState(-1);      // user pick; -1 = auto/default
  const [voiceActive, setVoiceActive] = useState(0); // resolved index (UI highlight)
  const [qualities, setQualities] = useState([]);    // [{id,label,height}]
  const [qualityId, setQualityId] = useState(null);
  const [stream, setStream] = useState(null);        // {hls|mp4}|null
  const [subtitles, setSubtitles] = useState([]);
  const [switching, setSwitching] = useState(false);
  const [sourceError, setSourceError] = useState(null); // {kind,message}|null
  const [meta, setMeta] = useState("");
  // F5 "should this descent re-raise switching on retry?" latch: set TRUE in
  // fail()'s manual-retry branch so the resolve effect's L1151 gate skips the
  // setSwitching(true) for the retry. Mirrored from `switching` is the wrong
  // tool — every render would overwrite it back to `true` if no state change
  // happened between fail() and the retry, defeating the gate. Reset on every
  // "fresh" descent (resolve effect entry for a new switchSeq) and on every
  // manual user pick that legitimately wants the overlay back.
  const switchingRef = useRef(false);

  const genRef = useRef(0);          // bumps on show change (discover)
  const ctxGenRef = useRef(0);       // bumps on each resolved context
  const [ctxVersion, setCtxVersion] = useState(0);
  // Bumped to force the resolve effect to re-walk the SAME balancer (a manual pick
  // whose `call` URL came back stale — phantom — needs a fresh descent, which is
  // also what repopulates its 4K quality list). Nothing else touches it.
  const [resolveNonce, setResolveNonce] = useState(0);
  const entriesRef = useRef([]);     // raw balancer entries (rawUrl/proxyUrl)
  const idsRef = useRef(null);
  const queryRef = useRef(null);
  const qualsRef = useRef([]);       // resolved quality list (with url/proxyUrl)
  const fallbackRef = useRef(null);  // {url,proxyUrl,headers} when no quality dict
  const hadStreamRef = useRef(false);
  const streamKeyRef = useRef("");
  // TMDB details as of right now, read (not depended on) by discovery: a movie's
  // details carry imdb_id, which lets baseIds skip the external_ids hop entirely.
  // A ref rather than a dep so details arriving late can't restart discovery.
  const detailsRef = useRef(null);
  detailsRef.current = details;
  // slug → {at,key,ctx,rs}: the descent a passing probe already paid for, handed
  // to the resolve effect so the winner doesn't repeat it. Cleared per generation.
  const probeCtxRef = useRef(new Map());

  // ── Player-level failover pool ───────────────────────────────────────────────
  // A byte-probe proves a balancer SERVES bytes, never that its stream DECODES:
  // Zetflix hands back a valid master m3u8 yet dies on the first segment append
  // (bufferAppendError). So the probe winner is only a starting guess — the
  // <video>/engine is the sole true judge of playback. These refs let the hook
  // walk to the next candidate when the current one fails to RESOLVE (handled
  // here) or fails to PLAY (reported by the player):
  //   poolRef      probe survivors, priority order (the preferred candidates)
  //   triedRef     slugs already burned this show — never revisit
  //   confirmedRef flips true the instant a stream truly plays; after that a
  //                failure is inline, never a reason to jump balancers
  const poolRef = useRef([]);
  const triedRef = useRef(new Set());
  const confirmedRef = useRef(false);
  const manualRef = useRef(false); // user explicitly picked → don't auto-jump away
  const balanserRef = useRef(null);
  balanserRef.current = balanser;
  const notedRef = useRef(null); // slug whose playback verdict is already recorded
  // F10b: snapshot of the last balancer/voice/quality/stream that genuinely
  // PLAYED (notePlaying fired). When a later manual pick exhausts its retries
  // and something is still playing on the old stream, the picker label and the
  // quality list must snap back to what the viewer is actually watching —
  // otherwise the label shows the dead balancer ("pizdatoehd") while Filmix
  // keeps playing underneath, and the quality picker stays empty because the
  // failed descent's setQualities([]) was the last write. Captured at
  // notePlaying and restored in fail()'s terminal branch.
  const lastPlayedRef = useRef(null);
  // F10b: when fail() restores the last-played balancer, the resolve effect
  // would otherwise re-descend and REPLACE the still-playing stream with a
  // freshly-resolved one (an unnecessary re-attach + possible playback hiccup).
  // This flag tells the resolve effect "this balancer change is a display-only
  // restore — the stream is already live, skip the descent." One-shot, cleared
  // at the top of the resolve effect.
  const restoreSkipResolveRef = useRef(false);
  // Manual re-descent budget: a hand-picked `call` balancer (phantom is the
  // archetype) usually fails on a STALE resolve, and the fix is to re-walk it for a
  // fresh call URL — which is also what repopulates its 4K quality list. Keyed by
  // slug so switching away resets the count. Bumped by the resolve effect's fail().
  const manualRetryRef = useRef({ slug: null, n: 0 });
  // F10: the manual-retry `setTimeout` (resolve effect's `fail()` branch) was
  // never tracked. With rapid back-and-forth switching, two retries for balancer
  // A could queue while the user has already moved on to B, then C, then D — and
  // every queued timer still fires its `setResolveNonce(v=>v+1)`, each one
  // re-running the resolve effect for the LATEST balancer. The picker label
  // moves with every click (because `setBalanser` is synchronous), but the
  // descent retries a balancer the user is no longer on; if any of those
  // retries actually succeeds, `setStream` snaps back to a balancer the user
  // abandoned, and the quality picker stays empty because the corresponding
  // `setQualities` came in after the user already reset everything. The user's
  // experience is: label changes, qualities vanish, stream never updates. We
  // track the timer here so `selectBalanser`/`selectVoice`/`selectQuality` can
  // cancel any pending retry before kicking off the new switch.
  const manualRetryTimerRef = useRef(null);
  // Monotonic switch id: every balancer/voice/quality change bumps it, so a
  // watchdog armed for one switch can tell it has been superseded and bow out.
  const switchSeqRef = useRef(0);
  const lampacSlowRef = useRef(false); // discovery is slow; player can swap overlay message

  // Walk to the next untried balancer: probe-survivors first (best candidates),
  // then every remaining balancer best-first, so a title the fleet can serve at
  // all eventually lands on one that truly plays. Returns false when exhausted.
  const advance = useCallback(() => {
    manualRef.current = false; // a selected source that never played may fail over
    const entries = entriesRef.current;
    if (!entries.length) return false;
    if (balanserRef.current) triedRef.current.add(balanserRef.current);
    const pool = poolRef.current || [];
    const inPool = new Set(pool);
    const order = [...pool, ...entries.map((e) => e.balanser).filter((s) => !inPool.has(s))];
    const next = order.find((s) => !triedRef.current.has(s));
    if (!next) return false;
    // Drop the dead stream so the reflect effect can't resurrect it while the new
    // balancer descends (a meta/voices change would otherwise re-map the old,
    // non-playing shape back into the player and re-attach it).
    setStream(null);
    setVoiceIdx(-1);
    setQualities([]);
    setQualityId(null);
    setBalanser(next);
    return true;
  }, []);

  // The player calls this when the attached fleet stream fatally fails before it
  // ever played. Advances to the next candidate (→ true, show loading) or reports
  // exhaustion (→ false, the player settles into the terminal error screen).
  //
  // Both callbacks also close the learning loop: the <video> element is the only
  // true judge of a stream (Zetflix serves a valid master m3u8 and then dies on
  // the first segment append), so a real playback verdict is weighted heavier than
  // a byte-probe and is recorded at most once per balancer per show.
  const reportPlaybackFailure = useCallback(() => {
    const slug = balanserRef.current;
    // A stream that already played and then hiccuped is not a balancer failure —
    // notedRef guards that, since a success writes it first.
    if (slug && notedRef.current !== slug) {
      notedRef.current = slug;
      noteBal(slug, false, 2);
    }
    if (confirmedRef.current) return false;
    return advance();
  }, [advance]);

  // The player calls this the instant playback actually starts: locks in the
  // current balancer so later hiccups stay inline instead of jumping sources.
  const notePlaying = useCallback(() => {
    confirmedRef.current = true;
    const slug = balanserRef.current;
    if (slug && notedRef.current !== slug) {
      notedRef.current = slug;
      noteBal(slug, true, 2);
    }
    // F10b: the lastPlayed snapshot is now taken in the quality effect at
    // setStream-time (every delivered stream updates it), not here —
    // fleetPlayedRef gates this callback to fire only on the FIRST genuine play
    // per episode, so a snapshot taken here would go stale across a sequence of
    // successful balancer/quality switches. notePlaying's job is just the
    // confirmedRef lock + the learned-score write.
  }, []);

  // ── Discover balancers (once per show; season/episode do NOT re-run this) ────
  useEffect(() => {
    if (!enabled || !item?.id) return;
    const gen = ++genRef.current;
    // One real AbortController for the whole discovery generation. Every hop below
    // takes its signal, so leaving the page (or switching titles) actually CANCELS
    // the outstanding relay requests instead of letting ~20 of them run to
    // completion against a component that no longer exists.
    const ctrl = new AbortController();
    const alive = () => !ctrl.signal.aborted && gen === genRef.current;
    setStream(null); setSourceError(null); setSwitching(false);
    setBalansers([]); setBalanser(null);
    setVoices([]); setVoiceIdx(-1); setVoiceActive(0);
    setQualities([]); setQualityId(null); setSubtitles([]); setMeta("");
    hadStreamRef.current = false; streamKeyRef.current = "";
    poolRef.current = []; triedRef.current = new Set(); confirmedRef.current = false; manualRef.current = false;
    notedRef.current = null;
    lampacSlowRef.current = false;
    manualRetryRef.current = { slug: null, n: 0 };
    // F10: a show switch must also kill any pending manual-retry timer from the
    // previous show — otherwise it fires setResolveNonce for a balancer that no
    // longer exists in entriesRef (the discovery effect rebuilt the pool).
    if (manualRetryTimerRef.current) {
      clearTimeout(manualRetryTimerRef.current);
      manualRetryTimerRef.current = null;
    }
    switchSeqRef.current = 0;
    switchingRef.current = false; // F5: fresh show → no overlay to suppress re-raise on
    probeCtxRef.current = new Map();
    (async () => {
     try {
      // The identifiers we already have cost nothing; the ones that need a request
      // only WIDEN the fleet's answer (Scarface: 16 balancers → 20 with kp). So the
      // lookups run alongside discovery instead of in front of it, and we ask the
      // fleet with whatever is in hand once a short grace period is up.
      const base = baseIds({ item, details: detailsRef.current });
      idsRef.current = base;
      queryRef.current = searchQuery(base, type);
      // …and shared with the detail page's warm-up (resolveIdsCached), so a warmed
      // page has already paid the kp lookup's ~700 ms and the widened re-ask lands
      // immediately instead of trailing the Play click.
      const idsP = resolveIdsCached({ apiKey, item, type, base, signal: ctrl.signal }).then(
        (full) => {
          if (!alive()) return null;
          idsRef.current = full;
          queryRef.current = searchQuery(full, type); // later descents match better
          return full;
        },
        () => null,
      );
      // Only imdb_id is worth a grace period (it decides how well each balancer
      // matches the title). With it already in hand — every film — the fleet is
      // asked immediately and the kp id arrives via the additive re-ask.
      const ids = base.imdbId
        ? base
        : (await Promise.race([idsP, new Promise((r) => setTimeout(() => r(null), IDS_GRACE_MS))])) || base;
      if (!alive()) return;

      const askEvents = (i) =>
        lampacEvents(
          {
            ...i, serial: type === "tv",
          },
          { signal: ctrl.signal },
        );

      let started = false;
      const start = (entry) => {
        if (started || !entry || !alive()) return;
        started = true;
        setBalanser(entry.balanser); // → triggers the resolve effect
      };

      // If the user has a saved balancer for this IMDB id and it's in the live
      // fleet, prefer it over the scout's first-wave pick. Episodes within a
      // series share an imdb_id, so the saved pick survives the descent even
      // when the scout would otherwise burn budget re-discovering a balancer
      // the viewer already chose. Mark it tried so a duplicate probe doesn't
      // race the saved entry's own descent.
      // Restore the saved balancer for this IMDB id once the live fleet list
      // arrives. The previous form read getLampacState before events had
      // resolved, so entriesRef.current was still [] and the saved balancer
      // was never found — a viewer who closed the tab and re-opened the same
      // series got the fleet-default pick instead of their last source.
      // Defer with queueMicrotask so setBalansers (which fires below in the
      // same effect) commits before start() reads pool state.
      const applySavedBalancer = (savedAtCall) => {
        if (!savedAtCall?.balanser) return;
        const savedEntry = entriesRef.current.find((e) => e.balanser === savedAtCall.balanser);
        if (!savedEntry) return;
        triedRef.current.add(savedEntry.balanser);
        queueMicrotask(() => start(savedEntry));
      };
      // First try: the live fleet may already match (probe-typed fleet
      // changes can drop a balancer — if so we fall through to the scout).
      applySavedBalancer(getLampacState(idsRef.current?.imdbId));
      // Balancers the fleet only reveals once the widened ids land are appended as
      // extra failover candidates — advance() walks everything in entriesRef, so
      // they need no scout of their own.
      const merge = (list) => {
        const have = new Set(entriesRef.current.map((e) => e.balanser));
        const extra = list.filter((b) => !have.has(b.balanser));
        if (!extra.length) return [];
        entriesRef.current = [...entriesRef.current, ...extra];
        // Don't refresh the picker here — the screenshot showed phantom / zetflix /
        // cdnvideohub listed even when they had no stream for the title. Merged
        // balancers get a free slot in the failover pool via advance() instead.
        return extra;
      };

      const evT0 = Date.now();
      const ev = await askEvents(ids);
      if (!alive()) return;
      // Slow discovery: surface "Медленный опрос" so the overlay can swap to a
      // friendlier message instead of a frozen spinner. Cosmetic only — the
      // descent continues unchanged.
      if (Date.now() - evT0 > 2500 && !lampacSlowRef.current) {
        lampacSlowRef.current = true;
        setSourceError({ kind: "slow", message: "Медленный опрос балансеров" });
      }
      if (!ev.ok || !ev.balansers?.length) {
        setSourceError({ kind: ev.kind || "no-link", message: ev.error || "Балансеры не найдены" });
        return;
      }
      // Learned order first: a balancer that has 503'd or timed out on every recent
      // title should not be spending the scout's budget ahead of one that works.
      // The picker populates AFTER the scout completes (see below) — pre-populating
      // here would flash phantom/zetflix/cdnvideohub on every title for the 1–2 s
      // the scout needs, even when those balancers have no stream for this title.
      entriesRef.current = rankEntries(ev.balansers);

      // Second-chance saved-balancer restore, now that the live fleet is in
      // hand. The pre-events call above almost never matches because
      // entriesRef is still []; THIS is the path that actually restores the
      // viewer's last source after a cold re-open of the same series.
      // Re-read getLampacState in case the caller wrote to it between the two
      // attempts (defensive; usually identical to the first read).
      if (!started) applySavedBalancer(getLampacState(idsRef.current?.imdbId));

      // Ask again with the full ids if the grace period beat them here — purely
      // additive. The widened list only ever reveals kp-keyed balancers (zetflix,
      // zetflixdb, cdnvideohub, kinoflix), and every one observed so far is
      // relay-mandatory (its media loads only through /proxy/…). They are appended
      // as failover candidates and NOTHING more: starting one here would race
      // AHEAD of the direct-first scout and — because start() latches on its first
      // call — silently discard the scout's superior direct pick. That was exactly
      // the "relay zetflix plays instead of direct filmix" bug: the merge fired
      // start(zetflix) at ~450 ms while the scout only certified direct filmix at
      // ~1.6 s, and the late, better pick was ignored. So the merge now ONLY
      // appends; whatever the scout (or its exhaustion fallback at the end of this
      // effect / advance()) selects is what starts. A title the base list genuinely
      // can't serve still reaches these extras via advance() — probed-first if the
      // scout is still live, raw only as a last resort — never ahead of a direct win.
      if (ids === base) {
        idsP.then(async (full) => {
          if (!full || !alive()) return;
          if (full.imdbId === base.imdbId && full.kinopoiskId === base.kinopoiskId) return;
          const ev2 = await askEvents(full);
          if (!alive() || !ev2.ok) return;
          merge(ev2.balansers);
        }).catch(() => {}); // additive re-ask is best-effort; never an unhandled reject
      }

      // Don't blindly take balancer[0]: it often can't match a title a lower
      // sibling serves fine (answers `similar` with no exact hit, 503s, times
      // out) — or resolves a URL that dies on first append (Zetflix →
      // bufferAppendError). Probe them in parallel, actually fetching the first
      // bytes of the resolved media; start on the highest-priority survivor the
      // instant it's certain, and keep the rest as a failover pool the player
      // walks if the chosen stream looks fine but won't actually decode.
      const probeOk = async (entry, signal, onBytes, onCallAwaiting, onHop1) => {
        const usable = () => !signal.aborted && alive();
        try {
          const ctx = await loadContext({
            entry, query: queryRef.current, ids: idsRef.current,
            type, season, episode, voiceIdx: null, signal, onHop1,
          });
          // A balancer whose voices are ALL explicitly non-Russian is a dead end —
          // the viewer will never pick it, and keeping it in the scan burns a slot
          // that a Russian-speaking sibling needs. A voice is non-Russian only when
          // explicitly flagged (English, (UK), (PT), …) — an unlabelled default, a
          // Russian-titled voice, or a pirated RU dub all count as Russian. Measured
          // on Interstellar: veoveo answered only "Оригинал" (original-language, no RU
          // dub) → dropped; kinogo keeps "PiratVoice (одноголосый)" (a RU dub) →
          // survives. This is the озвучки half of the speed/4K/dubs requirement: the
          // scan never hands the viewer a source that cannot speak Russian.
          const hasNonRuFlag = (n) => /\(en\)|\(uk\)|\(pt\)|\(es\)|\(de\)|\(fr\)|english|original|оригинал|украин|україн|georgian|қазақ|deutsch|français|español|italiano|日本語|中文/.test(String(n || "").toLowerCase());
          const anyRu = ctx.voices.some((v) => !hasNonRuFlag(v?.name));
          if (ctx.voices.length && !anyRu) return false; // no RU dub at all
          // spread:false — the scan already runs several probes at once (see
          // scanConcurrency), and a per-probe host fan-out on top would blow the
          // connection budget on h1. A scan-time call just tries the hint/own host once
          // and fails cheaply if wedged; the interactive resolve (below) does the full
          // cross-host race. The healthy call hop answers in ~0.6-0.7 s
          // (CALL_GRACE_MS), so signal the scan to extend this probe's deadline the
          // moment we know the call hop is in flight — without it the scout cap
          // (SCAN_CAP_MS) could abort a call whose JSON reply was about to land, losing
          // that balancer's quality ladder and with it the 4K rungs.
          if (ctx.source?.method === "call") onCallAwaiting?.();
          const rs = await resolveSource(ctx.source, { signal, spread: false });
          if (!rs.ok || !usable()) return false;
          // Probe the rung playback will ACTUALLY start on (pickStartQuality, ~720p),
          // not a heavier default — otherwise the score would promise a pre-roll the
          // viewer never gets. For phantom this is the 720p rung (2.54MB seg, ~568ms)
          // instead of 1080p (4.26MB, ~852ms) or 2160p (9MB). The full 2160p→360p
          // ladder is still credited below from rs.qualities, so the picker keeps
          // every rung — "у phantom пропал выбор разрешение, а у них 4к" stays fixed.
          const def = pickStartQuality(rs.qualities, { balanser: entry.balanser });
          const pick = def || rs.fallback;
          if (!pick?.url && !pick?.proxyUrl) return false;
          // fast:true — this read is ON the viewer's critical path, so it transfers the
          // minimum that still answers "does this serve media, and how big is the block
          // before frame 1": ~32-64 KB instead of up to 256 KB, and the first segment is
          // SIZED from its content-range rather than sampled. The facts the verdict is
          // built from (declared manifest size, declared segment size, segment status)
          // are all exact either way; what is given up is a throughput sample that never
          // decided anything, because prerollMs is dominated by byte counts.
          const v = await probeMediaUrl(
            { url: pick.url, proxyUrl: pick.proxyUrl, headers: pick.headers || rs.fallback?.headers },
            { signal, onBytes, fast: true },
          );
          if (!usable()) return false;
          noteBal(entry.balanser, v.ok);
          // What LADDER this balancer offers, taken from its own dict rather than from
          // the manifest — that dict is exactly what fills the quality picker, so it is
          // the honest answer to "у phantom пропал выбор разрешение, а у них 4к". A
          // balancer that resolves a lone 480p file is a worse win than a sibling of
          // the same speed carrying 2160p/1080p/720p, and the scout can now say so.
          if (v.ok) {
            const hs = [...new Set(rs.qualities.map((q) => q.height || 0).filter(Boolean))].sort((a, b) => b - a);
            v.ladder = hs.length;
            v.maxHeight = hs[0] || 0;
          }
          // Hand the resolved descent over: without this the winner's very first
          // action is to repeat every hop the probe just made (balancer JSON, the
          // `call` hop, the CORS probe) — the single largest chunk of the old
          // start-up time, paid twice for no new information.
          if (v.ok) {
            probeCtxRef.current.set(entry.balanser, {
              at: Date.now(), key: probeKey(entry.balanser, season, episode), ctx, rs,
            });
          }
          // Return the full verdict so the scout can prefer a fast/lean survivor
          // over a merely-passing one; a falsy .ok reads as a fail upstream.
          return v.ok ? v : false;
        } catch (e) {
          if (usable() && e?.kind !== "cancelled") noteBal(entry.balanser, false);
          return false;
        }
      };
      const pass = await scanBalancers(entriesRef.current, probeOk, {
        onFirst: start,
        signal: ctrl.signal,
      });
      if (!alive()) return;
      // Priority-ordered survivors become the failover pool. If none survived the
      // byte-probe, fall back to the LEARNED-RANKED list, not the raw fleet order
      // — the fleet's first entry is usually the wedger that just made the probe
      // cap burn out.
      // Picker shows every fleet-listed balancer; pool (used by advance()) keeps
      // the survivor ordering. Width here matches what the user expects from
      // a "all sources" view — narrower filtering (preferred-only, survivor-only)
      // is opt-in and was removed because it broke manual fallback when several
      // balancers were down on the same title.
      const rankedAll = rankEntries(entriesRef.current);
      poolRef.current = (pass.length ? pass : rankedAll).map((b) => b.balanser);
      setBalansers(pubList(entriesRef.current));
      if (!started) start(pass[0] || rankedAll[0]);
     } catch (e) {
      // Discovery must NEVER throw into the void: an unhandled rejection here
      // (a normalizer choking on an unexpected shape, an ids-resolve reject that
      // slips a guard) would leave the player wedged on "Опрашиваем балансеры"
      // forever — the exact crash the user hit ("упало на опрашивании
      // балансеров"). A benign abort (unmount / title switch) is not a failure.
      if (!alive() || e?.name === "AbortError" || e?.kind === "cancelled") return;
      setSourceError({ kind: "no-link", message: "Не удалось опросить балансеры" });
     }
    })();
    return () => { ctrl.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, item?.id, type, apiKey, details?.original_language, details?.imdb_id, isAnimeContent(item, details)]);

  // ── Resolve the active balancer → voices + a playable source ─────────────────
  // Re-runs on balancer / season / episode / voice change. It never sets a hard
  // error state: a dead balancer shows an inline notice and leaves the picker up
  // so the viewer can switch. `switching` is raised only when a stream already
  // played (so the player keeps <video> mounted for a seamless swap).
  useEffect(() => {
    if (!enabled || !balanser) return;
    // F10b: a display-only restore (fail() snapped the picker back to the
    // still-playing balancer). The stream is already live — re-descending would
    // resolve a fresh URL and swap it in, interrupting playback. Skip the whole
    // descent; the refs/state were already repopulated by fail().
    if (restoreSkipResolveRef.current) {
      restoreSkipResolveRef.current = false;
      return;
    }
    const entry = entriesRef.current.find((e) => e.balanser === balanser);
    if (!entry) return;
    const myGen = genRef.current;
    const myCtx = ++ctxGenRef.current;
    const mySeq = ++switchSeqRef.current;
    // A real controller, not a duck-typed `{aborted}`: leaving this balancer must
    // release the connection its in-flight hops are holding, and only abort() does
    // that. `stale()` still covers the React-level races (generation bumps).
    const ctrl = new AbortController();
    const superseded = () => myGen !== genRef.current || myCtx !== ctxGenRef.current;
    const stale = () => ctrl.signal.aborted || superseded();
    // Bound the whole descent. A healthy one is 1–4 s; the relay's own per-hop cap
    // is 25 s, so without this a wedged connection (the exact cause of "уходит в
    // вечную загрузку" on rapid re-switching) would hold the freeze — and one of
    // the browser's six connections — for 25 s. Aborting at 12 s reclaims it fast
    // and routes into fail() (→ re-descend / advance / inline error).
    let timedOut = false;
    const killer = setTimeout(() => { timedOut = true; ctrl.abort(); }, SWITCH_DESCENT_MS);

    // F5: only raise `switching` if no previous descent on this switch has already
    // been "given up on" (cleared the overlay). A previous fail() in this descent
    // sets switchingRef.current = false; the retry via setResolveNonce bumps
    // switchSeqRef and re-enters here — without this gate it would re-raise the
    // overlay and the next fail→retry cycle would toggle it again (the
    // "36s on/off bursts" symptom).
    if (hadStreamRef.current && switchingRef.current) setSwitching(true);
    setSourceError(null);

    // A descent that fails before anything has confirmably played is not terminal
    // while candidates remain. Three recovery tiers, in order:
    //   1. A hand-picked `call` balancer that came back STALE/timed out (phantom is
    //      the archetype — its 4K list lives in the resolved call payload, and a
    //      stale call URL both blanks the picker and drops the stream). Re-walk the
    //      SAME balancer for a fresh call URL: that repopulates the quality list
    //      AND yields a live stream, which is exactly what "у phantom пропал выбор
    //      разрешение" needs. Bounded by MANUAL_RETRY_MAX so it can't spin.
    //   2. Auto-failover (advance) to the next candidate — only when the pick was
    //      nothing has confirmably played.
    //   3. Otherwise surface an inline sourceError and drop the freeze (the picker
    //      stays up so the viewer can choose another source).
    const fail = (kind, message) => {
      const recoverable = kind === "stale" || kind === "timeout" || !kind;
      if (manualRef.current && recoverable) {
        const r = manualRetryRef.current;
        if (r.slug !== balanser) { r.slug = balanser; r.n = 0; }
        if (r.n < MANUAL_RETRY_MAX) {
          r.n += 1;
          probeCtxRef.current.delete(balanser); // force a genuine re-walk
          // F5 fix: capture whether the WATCHDOG (OnlinePlayer.jsx:433) already
          // force-dropped `switching` for THIS descent. If it did, the user has
          // been waiting >14s and the overlay already came down — re-raising it
          // for the retry (the resolve effect's L1139 gate checks hadStreamRef,
          // which is still true for a previously-playing stream) produces the
          // "36s on/off bursts" symptom: overlay goes up at retry, the watchdog
          // arms fresh, the new descent also stalls, watchdog drops it again,
          // manual-retry re-raises it again. Instead: only re-raise if the
          // overlay is still up — i.e. the descent failed FAST enough that the
          // user is still inside the normal freeze window. If the overlay had
          // already been cleared (watchdog fired OR an earlier fail() in this
          // same descent set it), the retry just runs silently — the new
          // descent either lands a stream or surfaces an inline error, both of
          // which surface to the user without flickering the overlay. Read
          // switchingRef FRESH inside the setTimeout — if the WATCHDOG fired
          // during the 400 ms backoff (OnlinePlayer.jsx SWITCH_WATCHDOG_MS =
          // 14000, but a fast subsequent fail may also have hit), the overlay
          // is already down and we must NOT re-raise it.
          switchingRef.current = false; // mark "this descent is done", suppress re-raise
          // F10: track this timer so selectBalanser/selectVoice/selectQuality
          // can cancel it when the user moves on. The `mySeq !== switchSeqRef`
          // gate below ALSO covers the case where a select slipped in between
          // `fail()` and this timer firing (select* now bumps switchSeqRef),
          // but tracking the handle is the cheaper, deterministic kill: the
          // timer is cleared at the start of the new switch rather than
          // relying on the guard's stale-`mySeq` comparison at fire time.
          // Clear any prior retry timer first so two consecutive fails on the
          // same balancer don't stack two pending setResolveNonce bumps (the
          // second would re-run the resolve effect again after the first
          // already did — a wasted descent and, if the first retry already
          // succeeded, a needless snap-back).
          if (manualRetryTimerRef.current) clearTimeout(manualRetryTimerRef.current);
          manualRetryTimerRef.current = setTimeout(() => {
            manualRetryTimerRef.current = null;
            if (mySeq !== switchSeqRef.current || superseded()) return;
            if (switchingRef.current) setSwitching(true);
            setResolveNonce((v) => v + 1); // → this effect re-runs for the same balancer
          }, MANUAL_RETRY_BACKOFF_MS);
          return;
        }
      }
      if (!confirmedRef.current && advance()) return; // → resolve effect re-runs
      // F10b: snap the picker back to the balancer that's actually playing,
      // so the UI never shows "Filmix selected" with Filmix's empty quality
      // ladder on top of Lampac's still-playing stream. AUTO picks get this
      // because the system chose for them and the player should look consistent;
      // MANUAL picks do NOT — the user explicitly chose this balancer and
      // overriding their pick was the "переключает обратно" complaint. A manual
      // pick that failed after retries stays put with an inline error, and
      // the reflect effect's "don't blank a running film" branch keeps the
      // old stream playing underneath. The viewer can then pick again from
      // the still-open menu without the app silently undoing their choice.
      if (!manualRef.current) {
      const last = lastPlayedRef.current;
      if (last && last.slug && last.slug !== balanser) {
        // Surface the error as a dismissable inline notice (the player's
        // fleetPlayedRef branch renders it) rather than a hard error screen,
        // because the film is still playing.
        setSourceError({ kind: kind || "no-link", message: message || "Источник недоступен" });
        // Restore refs first so the quality effect (if it re-runs) sees the
        // playing balancer's ladder, not the dead one's empty list.
        qualsRef.current = last.qualities || [];
        fallbackRef.current = last.fallback;
        streamKeyRef.current = last.streamKey || "";
        hadStreamRef.current = true;
        setQualities(last.qualities ? last.qualities.map((q) => ({ id: qId(q), label: q.label, height: q.height })) : []);
        setQualityId(last.qualityId);
        // F10b: tell the resolve effect (which setBalanser re-triggers) to skip
        // the descent — the stream is still live on the old blob/src, and
        // re-resolving would swap it out and interrupt playback. We do NOT bump
        // ctxVersion: the quality effect's stream-key dedup
        // (`${ctxVersion}|${pick.url} === streamKeyRef.current`) needs the SAME
        // ctxVersion the live stream was built under, so the restored streamKey
        // still matches and the quality effect short-circuits without swapping
        // the playing stream. setQualityId(null → last.qualityId) is enough to
        // re-run the quality effect against the restored qualsRef.
        restoreSkipResolveRef.current = true;
        setBalanser(last.slug);
        setSwitching(false);
        return;
      }
      }
      setSourceError({ kind: kind || "no-link", message: message || "Источник недоступен" });
      setSwitching(false);
    };

    // The winning balancer was chosen BECAUSE a probe walked it all the way down to
    // real bytes moments ago. Re-walking it (balancer JSON → `call` hop → CORS
    // probe) buys nothing and was the single biggest chunk of the old start-up
    // time. Reuse that descent when it is for this exact episode, still fresh
    // (`call` URLs go stale within minutes) and for the default dub — the case the
    // probe actually resolved. A manual re-descent (resolveNonce bumped) skips the
    // handoff on purpose: it exists precisely to get a FRESH call URL.
    const takeHandoff = () => {
      const hit = probeCtxRef.current.get(balanser);
      if (!hit) return null;
      probeCtxRef.current.delete(balanser); // one-shot: a retry must re-descend
      if (voiceIdx >= 0) return null;
      if (hit.key !== probeKey(balanser, season, episode)) return null;
      if (Date.now() - hit.at > PROBE_TTL) return null;
      return hit;
    };

    (async () => {
      try {
        const reuse = takeHandoff();
        const ctx =
          reuse?.ctx ||
          (await loadContext({
            entry, query: queryRef.current, ids: idsRef.current,
            type, season, episode,
            voiceIdx: voiceIdx >= 0 ? voiceIdx : null,
            signal: ctrl.signal,
          }));
        if (stale()) return;
        setVoices(ctx.voices);
        setVoiceActive(ctx.activeIdx);
        setMeta(entry.name + (ctx.voices[ctx.activeIdx]?.meta?.raw ? ` · ${ctx.voices[ctx.activeIdx].meta.raw}` : ""));

        // Apply the user's saved voice for this title if it exists in the fresh
        // voices list — episodes within a series restore the same озвучка.
        const imdbKey = idsRef.current?.imdbId;
        const saved = imdbKey ? getLampacState(imdbKey) : null;
        if (saved?.voice) {
          const i = ctx.voices.findIndex((v) => v.id === saved.voice);
          if (i >= 0) {
            setVoiceIdx(i); // → next descent uses this dub
            setVoiceActive(i);
          }
        }

        const rs = await resolveSource(ctx.source, { signal: ctrl.signal });
        if (stale()) return;
        if (!rs.ok) { fail(rs.kind, rs.error); return; }

        // A live descent succeeded → this balancer's manual-retry budget is spent
        // and reset (the next stale event on it starts fresh).
        if (manualRetryRef.current.slug === balanser) manualRetryRef.current = { slug: null, n: 0 };
        qualsRef.current = rs.qualities;
        fallbackRef.current = rs.fallback;
        setSubtitles(rs.subtitles || []);
        const qualityItems = rs.qualities.map((q) => ({ id: qId(q), label: q.label, height: q.height }));
        setQualities(qualityItems);
        // START on the fast rung the scout probed (~720p), UNLESS the user has
        // a saved quality for this title — same rule as voice, so an episode
        // switch inside a series restores the viewer's last pick (including 4K).
        const def = pickStartQuality(rs.qualities, { balanser: entry.balanser });
        const savedId = saved?.quality && qualityItems.some((q) => q.id === saved.quality)
          ? saved.quality : null;
        setQualityId(savedId || (def ? qId(def) : null));
        setCtxVersion((v) => v + 1); // hand off to the stream effect
      } catch (e) {
        if (superseded()) return;                 // a newer switch owns the UI now
        if (timedOut) { fail("timeout", "Источник не ответил вовремя"); return; }
        // A benign abort (unmount) or a client-level cancel that ISN'T supersession
        // must still drop the freeze — leaving `switching` true here was the "вечная
        // загрузка" after rapid back-and-forth switching.
        if (ctrl.signal.aborted || e?.kind === "cancelled") { setSwitching(false); return; }
        fail(e?.kind, e?.message);
      } finally {
        clearTimeout(killer);
      }
    })();
    // F10: cancel any manual-retry timer THIS descent queued. The deps this
    // effect re-runs on (balanser/voice/resolveNonce) change precisely when a
    // new switch supersedes this one, so cleanup is the deterministic kill
    // point — the queued setResolveNonce++ can't fire after this return.
    return () => {
      clearTimeout(killer);
      ctrl.abort();
      if (manualRetryTimerRef.current) {
        clearTimeout(manualRetryTimerRef.current);
        manualRetryTimerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, balanser, season, episode, voiceIdx, resolveNonce]);

  // ── Chosen quality → a concrete playable URL (direct-first) ──────────────────
  // Separate from the resolve effect so switching quality is one cheap hop, not a
  // full balancer re-descent. Keyed on ctxVersion + qualityId.
  useEffect(() => {
    if (!enabled || !ctxVersion) return;
    const ctrl = new AbortController();
    // Bound the link-build hop too (playableUrl races a direct probe against the
    // relay). Same reasoning as the resolve effect: never let a wedged connection
    // hold the `switching` freeze open.
    let timedOut = false;
    const killer = setTimeout(() => { timedOut = true; ctrl.abort(); }, SWITCH_DESCENT_MS);
    // Same failover contract as the resolve effect: a link that won't build is
    // not terminal while untried balancers remain.
    const fail = (kind, message) => {
      if (!confirmedRef.current && advance()) return;
      setSourceError({ kind: kind || "no-link", message });
      setSwitching(false);
    };
    (async () => {
      try {
        const list = qualsRef.current;
        const chosen = (qualityId && list.find((q) => qId(q) === qualityId)) || null;
        const pick = chosen || fallbackRef.current;
        if (!pick?.url && !pick?.proxyUrl) {
          fail("no-link", "Нет ссылки на поток");
          return;
        }
        const key = `${ctxVersion}|${pick.url || pick.proxyUrl}`;
        if (key === streamKeyRef.current) { setSwitching(false); return; }
        const play = await playableUrl(
          { url: pick.url, proxyUrl: pick.proxyUrl, headers: pick.headers },
          { preferDirect: true, signal: ctrl.signal },
        );
        if (ctrl.signal.aborted) {
          // Aborted by supersession → the newer effect owns the UI; aborted by our
          // own timeout → surface it (don't leave the freeze up).
          if (timedOut) fail("timeout", "Поток не ответил вовремя");
          return;
        }
        const shape = streamShape(play, pick.url || pick.proxyUrl);
        if (!shape) {
          fail("no-link", "Поток недоступен");
          return;
        }
        streamKeyRef.current = key;
        hadStreamRef.current = true;
        setSourceError(null);
        setStream(shape);
        // F10b: snapshot the balancer/quality/stream-key the instant a stream is
        // DELIVERED (not on first-play, which only fires once per episode via
        // fleetPlayedRef). Every successful quality-effect run updates this, so a
        // later failed manual pick restores to the ACTUALLY-playing balancer, not
        // a stale one from before a sequence of successful switches. The stream
        // object itself isn't snapshotted — the player keeps the live <video>
        // attached, and restoring `balanser`+`streamKey`+`qualsRef` is enough for
        // the picker to reflect what's on screen without a re-attach.
        lastPlayedRef.current = {
          slug: balanser,
          qualities: qualsRef.current,
          qualityId,
          fallback: fallbackRef.current,
          streamKey: key,
        };
        // `switching` is dropped by the player on `seeked`, not here — clearing it
        // now would unfreeze the UI before the new media has attached.
      } catch (e) {
        // Without this catch a throw from playableUrl/streamShape became an
        // unhandled rejection AND left `switching` stuck true (вечная загрузка).
        // A supersession abort belongs to the newer effect; anything else routes
        // into fail() so an untried balancer can still take over.
        if (ctrl.signal.aborted && !timedOut) return;
        if (timedOut) { fail("timeout", "Поток не ответил вовремя"); return; }
        if (e?.kind === "cancelled") { setSwitching(false); return; }
        fail(e?.kind, e?.message || "Поток недоступен");
      } finally {
        clearTimeout(killer);
      }
    })();
    return () => { clearTimeout(killer); ctrl.abort(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, ctxVersion, qualityId]);

  // ── Selectors ────────────────────────────────────────────────────────────────
  const selectBalanser = useCallback((id) => {
    if (id === balanser) return;
    manualRef.current = true;   // explicit pick gets one bounded retry before failover
    // …but DON'T pre-confirm: a manual pick that never actually plays must still be
    // able to recover (re-descend a stale `call`, or surface an inline error).
    // Only genuine playback (notePlaying) sets confirmedRef. Clearing it here also
    // resets a confirm left over from a previously-playing balancer.
    confirmedRef.current = false;
    manualRetryRef.current = { slug: null, n: 0 };
    // F10: cancel any pending manual-retry `setTimeout` from the PREVIOUS
    // balancer's `fail()` branch. Without this, a queued `setResolveNonce++`
    // for the old balancer fires after the user has already moved on, each
    // queued timer re-running the resolve effect for the NEW balancer and
    // racing the fresh descent. `switchSeqRef` is also bumped so a retry that
    // slipped through its `mySeq !== switchSeqRef.current` gate (the old
    // descent's `mySeq` was captured at effect-entry, which pre-dates this
    // user pick) bails out before calling `setResolveNonce`.
    if (manualRetryTimerRef.current) {
      clearTimeout(manualRetryTimerRef.current);
      manualRetryTimerRef.current = null;
    }
    switchSeqRef.current += 1;
    triedRef.current.add(id);
    // Persist the new balancer pick under the title's imdb_id so the next
    // episode (or re-open of this film) starts on the same source without the
    // picker snapping back to the scout's first-wave winner.
    if (idsRef.current?.imdbId) setLampacState(idsRef.current.imdbId, { balanser: id });
    setVoiceIdx(-1);            // new balancer → its own default dub
    setQualities([]); setQualityId(null);
    // ── Stale-ref leak fix ────────────────────────────────────────────────────
    // Clearing only the React state (`setQualities([])`/`setQualityId(null)`)
    // left the QUALITY EFFECT (deps [ctxVersion, qualityId]) reading the OLD
    // balancer's `qualsRef`/`fallbackRef` on a `qualityId → null` re-run: `pick =
    // fallbackRef.current` (the old master) attached the previous source's stream
    // under the new picker, OR (if the stream-key dedup fired) left the old stream
    // pinned while the picker showed empty — the "выбор качества пропадает при
    // быстром переключении" symptom. `hadStreamRef` staying true also let a later
    // manual-retry re-raise `switching` after the watchdog had already cleared it.
    // Mirror the discovery effect's full reset (L928-932): zero the refs AND drop
    // `ctxVersion` to 0 so the quality effect's guard short-circuits until the
    // fresh descent re-bumps it (L1225). One source of truth.
    qualsRef.current = [];
    fallbackRef.current = null;
    hadStreamRef.current = false;
    streamKeyRef.current = "";
    setStream(null);
    setCtxVersion(0);
    setBalanser(id);
  }, [balanser]);

  const selectVoice = useCallback((id) => {
    const i = voices.findIndex((v) => v.id === id);
    if (i < 0 || i === voiceActive) return;
    // F10: same race as selectBalanser — cancel any pending manual-retry timer
    // from the prior dub's `fail()` branch and bump `switchSeqRef` so a queued
    // retry for the old dub can't fire `setResolveNonce` after this pick.
    if (manualRetryTimerRef.current) {
      clearTimeout(manualRetryTimerRef.current);
      manualRetryTimerRef.current = null;
    }
    switchSeqRef.current += 1;
    // Persist the voice pick so episode switches restore the same озвучка
    // without the viewer re-clicking the dub menu.
    if (idsRef.current?.imdbId) setLampacState(idsRef.current.imdbId, { voice: id });
    // Same stale-ref leak as selectBalanser: a dub switch re-resolves, and if that
    // resolve FAILS after a confirmed play, `fail()` skips the manual-retry branch
    // (dub switches never set manualRef) and skips `advance()` (confirmedRef is
    // true) → only setSourceError + setSwitching(false). The `setQualities([])`
    // below was the last write, so the picker stayed empty until a manual re-click.
    // Clearing the refs/ctxVersion here means the quality effect can never attach
    // the old dub's stream while the new dub's descent is in flight.
    setQualities([]); setQualityId(null);
    qualsRef.current = [];
    fallbackRef.current = null;
    hadStreamRef.current = false;
    streamKeyRef.current = "";
    setStream(null);
    setCtxVersion(0);
    setVoiceIdx(i);
  }, [voices, voiceActive]);

  const selectQuality = useCallback((id) => {
    if (id === qualityId) return;
    // F10: quality swap is its own switch — cancel any pending manual-retry
    // timer and bump `switchSeqRef` so the previous quality's `fail()`-queued
    // retry can't fire `setResolveNonce` and re-run the resolve effect against
    // the new qualityId.
    if (manualRetryTimerRef.current) {
      clearTimeout(manualRetryTimerRef.current);
      manualRetryTimerRef.current = null;
    }
    switchSeqRef.current += 1;
    // Persist the quality pick (incl. 4K) per imdb_id so the next episode
    // restores the same ladder rung instead of falling back to 720p.
    if (idsRef.current?.imdbId) setLampacState(idsRef.current.imdbId, { quality: id });
    if (hadStreamRef.current) {
      setSwitching(true);
      // F5: re-arm the re-raise gate — a fresh quality pick is a new switch and
      // its retry path is allowed to re-raise the overlay if it lands inside
      // the watchdog window.
      switchingRef.current = true;
    }
    setQualityId(id);
  }, [qualityId]);

  const clearSwitching = useCallback(() => setSwitching(false), []);

  return {
    stream,
    balansers,
    balanser,
    selectBalanser,
    voices,
    voice: voices[voiceActive]?.id ?? null,
    selectVoice,
    qualities,
    quality: qualityId,
    selectQuality,
    switching,
    clearSwitching,
    sourceError,
    subtitles,
    meta,
    reportPlaybackFailure,
    notePlaying,
  };
}

