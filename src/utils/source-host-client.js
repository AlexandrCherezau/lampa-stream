const ENDPOINT = "/api/source-host";
const PREPARED_RESULT_TTL = 15_000;
const PREPARED_CANDIDATE_TTL = 5 * 60_000;
const PREPARED_RESULT_EXPIRED = Symbol("prepared-result-expired");
const MAX_PREPARED_SOURCES = 4;
const SOURCE_PREFERENCE_HEADSTART_MS = 1_500;
const AUTO_RESOLVE_TIMEOUT_MS = 10_000;
const MAX_AUTO_RESOLVES = 2;
const REFRESH_TIMEOUT_MS = 20_000;
const MAX_AUTO_REFRESHES = 2;
const PROVIDER_COOLDOWN_MS = 30_000;
const preparedSources = new Map();
const providerCooldowns = new Map();

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
    throw Object.assign(new Error(error.message || "Источник временно недоступен"), { code: error.error, status: response.status,
      ...(error.sourceMediaCode === "UPSTREAM_HTTP_ERROR" && Number.isInteger(error.sourceUpstreamStatus)
        && error.sourceUpstreamStatus >= 400 && error.sourceUpstreamStatus <= 599
        ? { sourceUpstreamStatus: error.sourceUpstreamStatus } : {}),
    });
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
  let preparedEntry = null;
  try {
    await discover(title, {
      signal, prepareOnly: true,
      onEvent: (name, candidate) => {
        if (name !== "candidate" || candidate.providerId !== "habster:alloha" || signal?.aborted) return;
        const current = preparedSources.get(key);
        if (current) { preparedEntry = current; return; }
        const entry = { candidateExpires: Date.now() + PREPARED_CANDIDATE_TTL, resultExpires: 0,
          candidate, voiceId: candidate.voiceId, voiceName: candidate.voiceName, result: null, claimed: false };
        preparedEntry = entry;
        signal?.addEventListener("abort", () => {
          if (preparedSources.get(key) === entry) preparedSources.delete(key);
        }, { once: true });
        entry.promise = Promise.resolve(resolve(candidate.id, undefined, signal)).then((result) => {
          if (signal?.aborted || Date.now() >= entry.candidateExpires || preparedSources.get(key) !== entry) return null;
          resolvedStream(result);
          entry.result = result;
          entry.resultExpires = Date.now() + PREPARED_RESULT_TTL;
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
  await preparedEntry?.promise;
}

function preparedCandidateFor(title) {
  const key = titleKey(title);
  const entry = preparedSources.get(key);
  if (!entry) return null;
  if (Date.now() >= entry.candidateExpires) {
    preparedSources.delete(key);
    return null;
  }
  return entry.claimed ? null : entry.candidate;
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
  if (Date.now() >= entry.candidateExpires) {
    preparedSources.delete(key);
    return null;
  }
  if (candidate.providerId !== "habster:alloha" || candidate.voiceId !== entry.voiceId || candidate.voiceName !== entry.voiceName) return null;
  if (entry.claimed) return null;
  entry.claimed = true;
  const result = entry.result || await entry.promise;
  if (preparedSources.get(key) !== entry) return null;
  if (result && Date.now() < entry.resultExpires) {
    preparedSources.delete(key);
    return result;
  }
  return result ? PREPARED_RESULT_EXPIRED : null;
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

function coolingDown(providerId) {
  const until = providerCooldowns.get(providerId) || 0;
  if (until <= Date.now()) {
    providerCooldowns.delete(providerId);
    return false;
  }
  return true;
}

function recordProviderFailure(providerId, error) {
  if (["BUSY", "ENGINE_STARTING"].includes(error?.code)) return;
  // A gateway 502 alone can mean one missing film or quality, not a provider outage.
  const status = error?.sourceUpstreamStatus ?? (error?.status === 502 ? null : error?.status);
  if (status === 429 || status >= 500) providerCooldowns.set(providerId, Date.now() + PROVIDER_COOLDOWN_MS);
}

export function createSourceSession({ discover = discoverSources, resolve = resolveSource, publish }) {
  let generation = 0;
  let discovery;
  let resolving;
  let refreshing;
  let refreshAttempts = 0;
  let pending = false;
  let finished = false;
  let candidates = [];
  let failed = new Set();
  let active = null;
  let previous = null;
  let confirmed = false;
  let preparedCandidate = null;
  let preparedCandidateQueued = false;
  let preparedFallbackCandidate = null;
  let preparedFallbackQueued = false;
  let sourcePreference = null;
  let preferenceReleased = true;
  let preferenceTimer;
  let selectionEpoch = 0;
  const autoAttempts = new Map();
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
    if (!active && !pending && !autoAttempts.size && finished && !state.sourceError) emit({ sourceError: { message: "Не найдено работающего источника для этой записи" }, meta: "" });
  };
  const abortAutomaticAttempts = () => {
    selectionEpoch++;
    for (const attempt of autoAttempts.values()) attempt.controller.abort();
    autoAttempts.clear();
    pending = Boolean(resolving);
  };
  const activate = (candidate, result) => {
    const stream = resolvedStream(result);
    providerCooldowns.delete(candidate.providerId);
    previous = confirmed ? active : previous;
    active = { candidate, result };
    confirmed = false;
    emit({ stream,
      qualities: (result.qualities || []).map((value) => ({ id: value.label, label: value.height >= 2160 ? "4K" : value.label === "auto" ? "Авто" : value.label, height: value.height })),
      subtitles: (result.subtitles || []).map((value) => ({ name: value.label, language: value.language, url: value.url })),
      audioNames: result.audioNames || [],
      meta: `${candidate.providerName} · ${candidate.voiceName}`, sourceError: null, skip: result.skip || null,
    });
  };
  const startAutomatic = (candidate) => {
    const controller = new AbortController();
    const attempt = { candidate, controller, epoch: selectionEpoch, token: generation };
    autoAttempts.set(candidate.id, attempt);
    pending = true;
    emit({ sourceError: null, meta: active ? state.meta : `Проверяем ${candidate.providerName}…` });
    let timer;
    let timedOut = false;
    const timeout = new Promise((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(Object.assign(new Error("Источник не ответил вовремя"), { status: 504 }));
      }, AUTO_RESOLVE_TIMEOUT_MS);
    });
    const quality = sourcePreference && matchesSourcePreference(candidate, sourcePreference) ? sourcePreference.quality || undefined : undefined;
    const isPreparedCandidate = candidate.id === preparedCandidate?.id;
    const usePreparedResult = quality == null && isPreparedCandidate;
    const warm = usePreparedResult ? takePreparedResult(titleForSession, candidate) : null;
    const resolvingCandidate = Promise.resolve(warm).then((value) => {
      if (value && value !== PREPARED_RESULT_EXPIRED) return value;
      if (usePreparedResult && value !== PREPARED_RESULT_EXPIRED) {
        throw new Error("Предварительный источник больше недоступен");
      }
      // The sealed candidate outlives its short-lived media URL; refresh it on click.
      return resolve(candidate.id, quality, controller.signal);
    });
    Promise.race([resolvingCandidate, timeout])
      .then((result) => {
        if (timedOut || controller.signal.aborted || attempt.token !== generation || attempt.epoch !== selectionEpoch) return;
        resolvedStream(result);
        if (active || resolving) return;
        activate(candidate, result);
        abortAutomaticAttempts();
      })
      .catch((error) => {
        if (attempt.token !== generation || attempt.epoch !== selectionEpoch || (controller.signal.aborted && !timedOut)) return;
        if (quality == null) recordProviderFailure(candidate.providerId, error);
        failed.add(candidate.id);
        if (candidate.id === preparedCandidate?.id) queuePreparedFallback();
        if (sourcePreference && matchesSourcePreference(candidate, sourcePreference)) preferenceReleased = true;
      })
      .finally(() => {
        clearTimeout(timer);
        if (autoAttempts.get(candidate.id) !== attempt) return;
        autoAttempts.delete(candidate.id);
        pending = Boolean(resolving || autoAttempts.size);
        if (!active) next();
      });
  };
  const next = () => {
    if (active || resolving) return false;
    const failures = new Map();
    for (const value of candidates) {
      if (failed.has(value.id)) failures.set(value.providerId, (failures.get(value.providerId) || 0) + 1);
    }
    // Try every available provider before exhausting its alternate voices.
    const inFlight = new Set([...autoAttempts.values()].map(({ candidate }) => candidate.providerId));
    const available = candidates.filter((value) => !failed.has(value.id)
      && !autoAttempts.has(value.id) && !inFlight.has(value.providerId) && !coolingDown(value.providerId));
    const preferred = sourcePreference && available.find((value) => matchesSourcePreference(value, sourcePreference));
    // A cloud-restored source choice is useful only if it is restored before the
    // first frame. Give discovery time to surface that stable provider/voice
    // label instead of briefly starting a different dub. Once discovery ends,
    // the ordinary failover order remains available if the saved voice is gone.
    if (preferred && !autoAttempts.size) startAutomatic(preferred);
    if (sourcePreference && !preferenceReleased) return true;
    const remainingProviders = new Set([...autoAttempts.values()].map(({ candidate }) => candidate.providerId));
    const others = available.filter((value) => value !== preferred && !remainingProviders.has(value.providerId))
      .sort((a, b) => (failures.get(a.providerId) || 0) - (failures.get(b.providerId) || 0));
    for (const candidate of others) {
      if (autoAttempts.size >= MAX_AUTO_RESOLVES) break;
      if (remainingProviders.has(candidate.providerId)) continue;
      remainingProviders.add(candidate.providerId);
      startAutomatic(candidate);
    }
    if (autoAttempts.size) return true;
    settle();
    return !finished;
  };
  const queuePreparedFallback = () => {
    if (!preparedFallbackCandidate || preparedFallbackQueued || !preparedCandidate) return;
    candidates = candidates.filter((candidate) => candidate.id !== preparedCandidate.id);
    if (!candidates.some((candidate) => candidate.id === preparedFallbackCandidate.id)) candidates.push(preparedFallbackCandidate);
    preparedFallbackQueued = true;
  };
  const cancelRefresh = () => {
    refreshing?.controller.abort();
    refreshing = null;
  };
  function refreshCurrent() {
    if (refreshing) return refreshing.promise;
    if (resolving) return Promise.resolve(undefined);
    if (!active || !confirmed || refreshAttempts >= MAX_AUTO_REFRESHES) return Promise.resolve(false);
    const current = active;
    const controller = new AbortController();
    const token = generation;
    const epoch = selectionEpoch;
    const attempt = { controller };
    refreshing = attempt;
    refreshAttempts++;
    let timedOut = false;
    let search;
    let onAbort;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error("Истекло время восстановления источника"));
    }, REFRESH_TIMEOUT_MS);
    const stale = () => token !== generation || epoch !== selectionEpoch || active !== current || refreshing !== attempt;
    const quality = current.result.selected?.label;
    const work = async () => {
      let candidate = current.candidate;
      let result;
      try { result = await resolve(candidate.id, quality, controller.signal); }
      catch (error) {
        if (controller.signal.aborted || (error.code !== "SOURCE_EXPIRED" && error.status !== 410)) throw error;
        // Renew only this exact dub/episode; discovery must not substitute a sibling.
        search = new AbortController();
        candidate = await new Promise((accept, reject) => {
          let found;
          Promise.resolve(discover(titleForSession, {
            signal: AbortSignal.any([controller.signal, search.signal]),
            onEvent: (name, value) => {
              if (name !== "candidate" || found || controller.signal.aborted
                || !matchesSourcePreference(value, current.candidate)
                || stableLabel(value.voiceName) !== stableLabel(current.candidate.voiceName)
                || (value.season ?? null) !== (current.candidate.season ?? null)
                || (value.episode ?? null) !== (current.candidate.episode ?? null)) return;
              found = value;
              accept(value);
              search.abort();
            },
          })).then(() => { if (!found) reject(new Error("Выбранная озвучка больше недоступна")); }, reject);
        });
        result = await resolve(candidate.id, quality, controller.signal);
      }
      return { candidate, result };
    };
    emit({ switching: true, sourceError: null });
    attempt.promise = (async () => {
      try {
        const aborted = new Promise((_accept, reject) => {
          onAbort = () => reject(controller.signal.reason);
          controller.signal.addEventListener("abort", onAbort, { once: true });
        });
        const { candidate, result } = await Promise.race([work(), aborted]);
        if (stale() || controller.signal.aborted) return undefined;
        resolvedStream(result);
        if (candidate.id !== current.candidate.id) {
          candidates = candidates.filter((value) => value.id !== current.candidate.id && value.id !== candidate.id);
          candidates.push(candidate);
        }
        activate(candidate, result);
        confirmed = true;
        previous = null;
        return true;
      } catch (error) {
        if (stale() || (controller.signal.aborted && !timedOut)) return undefined;
        emit({ switching: false, sourceError: { message: error?.message || "Не удалось восстановить выбранный источник" } });
        return false;
      } finally {
        clearTimeout(timer);
        controller.signal.removeEventListener("abort", onAbort);
        search?.abort();
        if (refreshing === attempt) refreshing = null;
      }
    })();
    return attempt.promise;
  }
  async function choose(candidate, quality, manual) {
    if (manual) {
      cancelRefresh();
      refreshAttempts = 0;
      abortAutomaticAttempts();
      pending = false;
    }
    resolving?.abort();
    const controller = new AbortController();
    resolving = controller;
    const token = generation;
    pending = true;
    emit({ switching: Boolean(active), sourceError: null, meta: active ? state.meta : `Проверяем ${candidate.providerName}…` });
    try {
      const prepared = !manual && quality == null ? await takePreparedResult(titleForSession, candidate) : null;
      const result = prepared === PREPARED_RESULT_EXPIRED
        ? await resolve(candidate.id, quality, controller.signal)
        : prepared || await resolve(candidate.id, quality, controller.signal);
      if (controller.signal.aborted || token !== generation) return undefined;
      activate(candidate, result);
      return true;
    } catch (error) {
      if (controller.signal.aborted || token !== generation) return undefined;
      if (quality == null) recordProviderFailure(candidate.providerId, error);
      if (manual && active) {
        emit({ switching: false, sourceError: { message: error.message || "Не удалось переключить источник" } });
        return false;
      }
      failed.add(candidate.id);
      if (candidate.id === preparedCandidate?.id) queuePreparedFallback();
      return false;
    } finally {
      if (resolving === controller) {
        resolving = null;
        if (token === generation) {
          pending = false;
          if (!active) next();
        }
      }
    }
  }
  function stop() {
    generation++;
    cancelRefresh();
    refreshAttempts = 0;
    clearTimeout(preferenceTimer);
    preferenceTimer = undefined;
    abortAutomaticAttempts();
    discovery?.abort();
    resolving?.abort();
    resolving = null;
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
    preferenceReleased = !sourcePreference;
    preparedCandidate = preparedCandidateFor(title);
    preparedCandidateQueued = false;
    preparedFallbackCandidate = null;
    preparedFallbackQueued = false;
    candidates = []; failed = new Set(); active = previous = null; confirmed = false; finished = false;
    state = { stream: null, switching: false, sourceError: null, meta: "Ищем источники…", qualities: [], subtitles: [], audioNames: [], skip: null };
    emit();
    const token = generation;
    if (sourcePreference) preferenceTimer = setTimeout(() => {
      preferenceReleased = true;
      next();
    }, SOURCE_PREFERENCE_HEADSTART_MS);
    discovery = new AbortController();
    const controller = discovery;
    if (preparedCandidate && (!sourcePreference || matchesSourcePreference(preparedCandidate, sourcePreference))) {
      candidates.push(preparedCandidate);
      preparedCandidateQueued = true;
      emit();
      next();
    }
    try {
      await discover(title, { signal: controller.signal, onEvent: (name, value) => {
        if (token !== generation || controller.signal.aborted) return;
        if (name === "candidate" && preparedCandidateQueued && samePreparedVoice(value, preparedCandidate)) {
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
        if (![...autoAttempts.values()].some(({ candidate }) => matchesSourcePreference(candidate, sourcePreference))) {
          preferenceReleased = true;
          clearTimeout(preferenceTimer);
          preferenceTimer = undefined;
        }
        if (!active && !pending) next();
        settle();
      }
    }
  }
  return {
    start, stop, refreshCurrent,
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
      // Once frames have played, recovery must keep the viewer's source and dub.
      if (confirmed) return false;
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
