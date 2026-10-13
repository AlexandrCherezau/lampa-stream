const ENDPOINT = "/api/source-host";
const PREPARED_SOURCE_TTL = 15_000;
const MAX_PREPARED_SOURCES = 4;
const preparedSources = new Map();

function titleKey(title) {
  // Keep every field that can change a Habster lookup or the sealed runtime
  // validation in this key. In particular, never reuse a resolved URL when
  // the movie runtime was missing or differs from the player request.
  return JSON.stringify([
    title.type, title.title, title.originalTitle, title.tmdbId, title.year,
    title.imdbId, title.kinopoiskId, title.language, Boolean(title.anime),
    title.catalogSource, title.runtimeMinutes, title.season, title.episode,
  ]);
}

async function request(op, body, signal) {
  const response = await fetch(`${ENDPOINT}?op=${op}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal,
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw Object.assign(new Error(error.message || "Источник временно недоступен"), { code: error.error, status: response.status });
  }
  return response;
}

export async function discoverSources(title, { signal, onEvent, prepareOnly = false }) {
  const response = await request("discover", {
    ...title,
    ...(prepareOnly ? { prepareOnly: true } : {}),
  }, signal);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      pending = (pending + decoder.decode(value, { stream: !done })).replace(/\r\n/g, "\n");
      let boundary;
      while ((boundary = pending.indexOf("\n\n")) !== -1) {
        const block = pending.slice(0, boundary);
        pending = pending.slice(boundary + 2);
        const name = /^event:\s*(.+)$/m.exec(block)?.[1];
        const data = block.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
        if (name && data) onEvent(name, JSON.parse(data));
      }
      if (pending.length > 512 * 1024) throw new Error("Слишком большой ответ источника");
      if (done) break;
    }
  } finally { await reader.cancel().catch(() => {}); }
}

export async function resolveSource(id, quality, signal) {
  return (await request("resolve", { id, ...(quality ? { quality } : {}) }, signal)).json();
}

export async function prepareMovieSource(title, { signal, discover = discoverSources, resolve = resolveSource } = {}) {
  const runtime = Number(title.runtimeMinutes);
  if (!Number.isSafeInteger(runtime) || runtime < 1 || runtime > 1440) return;
  const key = titleKey(title);
  const expires = Date.now() + PREPARED_SOURCE_TTL;
  try {
    await discover(title, {
      signal, prepareOnly: true,
      onEvent: (name, candidate) => {
        if (name !== "candidate" || candidate.providerId !== "habster:alloha" || signal?.aborted) return;
        const current = preparedSources.get(key);
        if (current) return;
        const entry = { expires, candidate, voiceId: candidate.voiceId, voiceName: candidate.voiceName, result: null, claimed: false };
        signal?.addEventListener("abort", () => {
          if (preparedSources.get(key) === entry) preparedSources.delete(key);
        }, { once: true });
        entry.promise = Promise.resolve(resolve(candidate.id, undefined, signal)).then((result) => {
          if (signal?.aborted || Date.now() >= expires || preparedSources.get(key) !== entry) return null;
          resolvedStream(result);
          entry.result = result;
          return result;
        }).catch(() => {
          if (preparedSources.get(key) === entry) preparedSources.delete(key);
          return null;
        });
        preparedSources.set(key, entry);
        while (preparedSources.size > MAX_PREPARED_SOURCES) preparedSources.delete(preparedSources.keys().next().value);
      },
    });
  } catch {
    // Warming is opportunistic; ordinary playback discovery remains the fallback.
  }
}

function preparedCandidateFor(title) {
  const key = titleKey(title);
  const entry = preparedSources.get(key);
  if (!entry) return null;
  if (Date.now() >= entry.expires) {
    preparedSources.delete(key);
    return null;
  }
  return entry.claimed || !entry.result ? null : entry.candidate;
}

function samePreparedVoice(candidate, prepared) {
  if (!candidate || !prepared || candidate.providerId !== "habster:alloha" || prepared.providerId !== candidate.providerId) return false;
  const sameVoice = candidate.voiceId && prepared.voiceId
    ? candidate.voiceId === prepared.voiceId && candidate.voiceName === prepared.voiceName
    : candidate.voiceName === prepared.voiceName;
  return sameVoice && (candidate.season ?? null) === (prepared.season ?? null)
    && (candidate.episode ?? null) === (prepared.episode ?? null);
}

async function takePreparedResult(title, candidate) {
  const key = titleKey(title);
  const entry = preparedSources.get(key);
  if (!entry) return null;
  if (Date.now() >= entry.expires) {
    preparedSources.delete(key);
    return null;
  }
  if (candidate.providerId !== "habster:alloha" || candidate.voiceId !== entry.voiceId || candidate.voiceName !== entry.voiceName) return null;
  if (entry.claimed) return null;
  entry.claimed = true;
  const result = entry.result || await entry.promise;
  if (preparedSources.get(key) === entry) preparedSources.delete(key);
  return result;
}

function advertisedHeight(hint) {
  const text = String(hint || "");
  const knownHeights = [144, 240, 270, 360, 480, 530, 720, 1080, 1440, 1600, 2160, 4320];
  return Math.max(/\b4k\b/i.test(text) ? 2160 : 0,
    ...[...text.matchAll(/\b(\d{3,4})p?\b/gi)].map((match) => Number(match[1])).filter((height) => knownHeights.includes(height)));
}

function stableLabel(value) {
  return String(value || "").normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function matchesSourcePreference(candidate, preference) {
  if (!preference) return false;
  const providerId = String(preference.providerId || "");
  const voiceId = String(preference.voiceId || "");
  const provider = stableLabel(preference.providerName);
  const voice = stableLabel(preference.voiceName);
  const providerMatches = providerId ? candidate.providerId === providerId
    : !provider || stableLabel(candidate.providerName) === provider;
  const voiceMatches = voiceId ? candidate.voiceId === voiceId
    : !voice || stableLabel(candidate.voiceName) === voice;
  return providerMatches && voiceMatches;
}

function resolvedStream(result) {
  const url = result.selected?.url;
  if (!url) throw new Error("Источник не предоставил видео");
  if (result.kind === "hls") return { hls: url };
  if (result.kind === "file") return { mp4: url };
  throw new Error("Источник не предоставил поддерживаемое видео");
}

export function createSourceSession({ discover = discoverSources, resolve = resolveSource, publish }) {
  let generation = 0;
  let discovery;
  let resolving;
  let pending = false;
  let finished = false;
  let candidates = [];
  let failed = new Set();
  let active = null;
  let previous = null;
  let confirmed = false;
  let preparedCandidate = null;
  let preparedFallbackCandidate = null;
  let preparedFallbackQueued = false;
  let sourcePreference = null;
  let state = { stream: null, switching: false, sourceError: null, meta: "Ищем источники…", qualities: [], subtitles: [], audioNames: [], skip: null };
  const emit = (patch = {}) => {
    state = { ...state, ...patch };
    const byProvider = new Map();
    for (const candidate of candidates) {
      const height = advertisedHeight(candidate.qualityHint);
      const prior = byProvider.get(candidate.providerId);
      byProvider.set(candidate.providerId, {
        id: candidate.providerId, name: candidate.providerName,
        qualityHint: prior && prior.qualityHeight > height ? prior.qualityHint : candidate.qualityHint || "",
        qualityHeight: Math.max(height, prior?.qualityHeight || 0),
      });
    }
    const providers = [...byProvider.values()];
    publish({ ...state, balansers: providers, balanser: active?.candidate.providerId,
      voices: candidates.filter((value) => value.providerId === active?.candidate.providerId).map((value) => ({ id: value.id, name: value.voiceName })),
      voice: active?.candidate.id, quality: active?.result.selected?.label,
      sourcePreference: active ? {
        providerId: active.candidate.providerId,
        voiceId: active.candidate.voiceId || "",
        voiceName: active.candidate.voiceName || "",
      } : null,
    });
  };
  const settle = () => {
    if (!active && !pending && finished && !state.sourceError) emit({ sourceError: { message: "Не найдено работающего источника для этой записи" }, meta: "" });
  };
  const next = () => {
    if (active || pending) return false;
    const failures = new Map();
    for (const value of candidates) {
      if (failed.has(value.id)) failures.set(value.providerId, (failures.get(value.providerId) || 0) + 1);
    }
    // Try every available provider before exhausting its alternate voices.
    const available = candidates.filter((value) => !failed.has(value.id));
    const preferred = sourcePreference && available.find((value) => matchesSourcePreference(value, sourcePreference));
    // A cloud-restored source choice is useful only if it is restored before the
    // first frame. Give discovery time to surface that stable provider/voice
    // label instead of briefly starting a different dub. Once discovery ends,
    // the ordinary failover order remains available if the saved voice is gone.
    if (sourcePreference && !preferred && !finished) return true;
    const candidate = (preferred ? [preferred] : available)
      .sort((a, b) => (failures.get(a.providerId) || 0) - (failures.get(b.providerId) || 0))[0];
    if (candidate) { choose(candidate, preferred ? sourcePreference?.quality : undefined, false); return true; }
    settle();
    return !finished;
  };
  const queuePreparedFallback = () => {
    if (!preparedFallbackCandidate || preparedFallbackQueued || !preparedCandidate) return;
    candidates = candidates.filter((candidate) => candidate.id !== preparedCandidate.id);
    if (!candidates.some((candidate) => candidate.id === preparedFallbackCandidate.id)) candidates.push(preparedFallbackCandidate);
    preparedFallbackQueued = true;
  };
  async function choose(candidate, quality, manual) {
    resolving?.abort();
    const controller = new AbortController();
    resolving = controller;
    const token = generation;
    pending = true;
    emit({ switching: Boolean(active), sourceError: null, meta: active ? state.meta : `Проверяем ${candidate.providerName}…` });
    try {
      const prepared = !manual && quality == null ? await takePreparedResult(titleForSession, candidate) : null;
      const result = prepared || await resolve(candidate.id, quality, controller.signal);
      if (controller.signal.aborted || token !== generation) return undefined;
      const stream = resolvedStream(result);
      previous = confirmed ? active : previous;
      active = { candidate, result };
      confirmed = false;
      emit({ stream,
        qualities: (result.qualities || []).map((value) => ({ id: value.label, label: value.height >= 2160 ? "4K" : value.label === "auto" ? "Авто" : value.label, height: value.height })),
        subtitles: (result.subtitles || []).map((value) => ({ name: value.label, language: value.language, url: value.url })),
        audioNames: result.audioNames || [],
        meta: `${candidate.providerName} · ${candidate.voiceName}`, sourceError: null, skip: result.skip || null,
      });
      return true;
    } catch (error) {
      if (controller.signal.aborted || token !== generation) return undefined;
      if (manual && active) {
        emit({ switching: false, sourceError: { message: error.message || "Не удалось переключить источник" } });
        return false;
      }
      failed.add(candidate.id);
      if (candidate.id === preparedCandidate?.id) queuePreparedFallback();
      return false;
    } finally {
      if (resolving === controller && token === generation) {
        pending = false;
        if (!active) next();
      }
    }
  }
  function stop() {
    generation++;
    discovery?.abort();
    resolving?.abort();
    pending = false;
  }
  let titleForSession;
  async function start(title, preference = null) {
    stop();
    titleForSession = title;
    const stableSource = preference && typeof preference === "object"
      ? { providerId: String(preference.providerId || ""), voiceId: String(preference.voiceId || ""),
        providerName: String(preference.providerName || ""), voiceName: String(preference.voiceName || ""),
        quality: String(preference.quality || "") }
      : null;
    sourcePreference = stableSource && (stableSource.providerId || stableSource.voiceId || stableSource.providerName || stableSource.voiceName)
      ? stableSource : null;
    preparedCandidate = preparedCandidateFor(title);
    preparedFallbackCandidate = null;
    preparedFallbackQueued = false;
    candidates = []; failed = new Set(); active = previous = null; confirmed = false; finished = false;
    state = { stream: null, switching: false, sourceError: null, meta: "Ищем источники…", qualities: [], subtitles: [], audioNames: [], skip: null };
    emit();
    const token = generation;
    discovery = new AbortController();
    const controller = discovery;
    if (preparedCandidate && (!sourcePreference || matchesSourcePreference(preparedCandidate, sourcePreference))) {
      candidates.push(preparedCandidate);
      emit();
      next();
    }
    try {
      await discover(title, { signal: controller.signal, onEvent: (name, value) => {
        if (token !== generation || controller.signal.aborted) return;
        if (name === "candidate" && samePreparedVoice(value, preparedCandidate)) {
          preparedFallbackCandidate = value;
          if (failed.has(preparedCandidate.id)) {
            queuePreparedFallback();
            emit();
            next();
          }
          return;
        }
        if (name === "candidate" && !candidates.some((candidate) => candidate.id === value.id)) {
          candidates.push(value); emit(); next();
        }
      } });
    } catch (error) {
      if (token !== generation || controller.signal.aborted) return;
      if (!active && !pending) emit({ sourceError: { message: error.message }, meta: "" });
    } finally {
      if (token === generation && !controller.signal.aborted) {
        finished = true;
        if (!active && !pending) next();
        settle();
      }
    }
  }
  return {
    start, stop,
    selectBalanser: (id, quality) => {
      const providerCandidates = candidates.filter((value) => value.providerId === id);
      const requestedHeight = advertisedHeight(quality);
      const candidate = (requestedHeight ? providerCandidates.find((value) => advertisedHeight(value.qualityHint) >= requestedHeight) : null)
        || providerCandidates[0];
      return candidate ? choose(candidate, quality, true) : undefined;
    },
    selectVoice: (id) => {
      const candidate = candidates.find((value) => value.id === id);
      // Alloha provides each dub as a separate file with the same quality ladder.
      const quality = candidate?.providerId === "habster:alloha" && active?.candidate.providerId === candidate.providerId
        ? active.result.selected?.label : undefined;
      return candidate ? choose(candidate, quality === "auto" ? undefined : quality, true) : undefined;
    },
    selectQuality: (label) => active ? choose(active.candidate, label, true) : undefined,
    clearSwitching: () => emit({ switching: false }),
    notePlaying: () => { confirmed = true; previous = null; emit({ switching: false }); },
    reportPlaybackFailure: () => {
      if (!active) return pending || !finished;
      failed.add(active.candidate.id);
      if (previous) {
        active = previous; previous = null; confirmed = true;
        const result = active.result;
        emit({ stream: resolvedStream(result), switching: false,
          qualities: (result.qualities || []).map((value) => ({ id: value.label, label: value.height >= 2160 ? "4K" : value.label === "auto" ? "Авто" : value.label, height: value.height })),
          subtitles: (result.subtitles || []).map((value) => ({ name: value.label, language: value.language, url: value.url })),
          audioNames: result.audioNames || [],
          meta: `${active.candidate.providerName} · ${active.candidate.voiceName}`,
          skip: result.skip || null,
          sourceError: { message: "Выбранный поток не воспроизводится. Возвращаем предыдущий источник" },
        });
        return true;
      }
      if (active.candidate.id === preparedCandidate?.id) queuePreparedFallback();
      active = null; confirmed = false;
      emit({ stream: null, switching: false, sourceError: null, audioNames: [], skip: null });
      return next();
    },
  };
}
