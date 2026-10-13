const ENDPOINT = "/api/source-host";

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

export async function discoverSources(title, { signal, onEvent }) {
  const response = await request("discover", title, signal);
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
  let state = { stream: null, switching: false, sourceError: null, meta: "Ищем источники…", qualities: [], subtitles: [], audioNames: [], skip: null };
  const emit = (patch = {}) => {
    state = { ...state, ...patch };
    const providers = [...new Map(candidates.map((value) => [value.providerId, { id: value.providerId, name: value.providerName }])).values()];
    publish({ ...state, balansers: providers, balanser: active?.candidate.providerId,
      voices: candidates.filter((value) => value.providerId === active?.candidate.providerId).map((value) => ({ id: value.id, name: value.voiceName })),
      voice: active?.candidate.id, quality: active?.result.selected?.label,
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
    const candidate = candidates.filter((value) => !failed.has(value.id))
      .sort((a, b) => (failures.get(a.providerId) || 0) - (failures.get(b.providerId) || 0))[0];
    if (candidate) { choose(candidate, undefined, false); return true; }
    settle();
    return !finished;
  };
  async function choose(candidate, quality, manual) {
    resolving?.abort();
    const controller = new AbortController();
    resolving = controller;
    const token = generation;
    pending = true;
    emit({ switching: Boolean(active), sourceError: null, meta: active ? state.meta : `Проверяем ${candidate.providerName}…` });
    try {
      const result = await resolve(candidate.id, quality, controller.signal);
      if (controller.signal.aborted || token !== generation) return undefined;
      if (!result.selected?.url || !["hls", "file"].includes(result.kind)) throw new Error("Источник не предоставил видео");
      previous = confirmed ? active : previous;
      active = { candidate, result };
      confirmed = false;
      emit({ stream: result.kind === "hls" ? { hls: result.selected.url } : { mp4: result.selected.url },
        qualities: result.qualities.map((value) => ({ id: value.label, label: value.label === "auto" ? "Авто" : value.label, height: value.height })),
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
  async function start(title) {
    stop();
    candidates = []; failed = new Set(); active = previous = null; confirmed = false; finished = false;
    state = { stream: null, switching: false, sourceError: null, meta: "Ищем источники…", qualities: [], subtitles: [], audioNames: [], skip: null };
    emit();
    const token = generation;
    discovery = new AbortController();
    const controller = discovery;
    try {
      await discover(title, { signal: controller.signal, onEvent: (name, value) => {
        if (token !== generation || controller.signal.aborted) return;
        if (name === "candidate" && !candidates.some((candidate) => candidate.id === value.id)) {
          candidates.push(value); emit(); next();
        }
      } });
    } catch (error) {
      if (token !== generation || controller.signal.aborted) return;
      if (!active && !pending) emit({ sourceError: { message: error.message }, meta: "" });
    } finally {
      if (token === generation && !controller.signal.aborted) { finished = true; settle(); }
    }
  }
  return {
    start, stop,
    selectBalanser: (id) => { const candidate = candidates.find((value) => value.providerId === id); return candidate ? choose(candidate, undefined, true) : undefined; },
    selectVoice: (id) => { const candidate = candidates.find((value) => value.id === id); return candidate ? choose(candidate, undefined, true) : undefined; },
    selectQuality: (label) => active ? choose(active.candidate, label, true) : undefined,
    clearSwitching: () => emit({ switching: false }),
    notePlaying: () => { confirmed = true; previous = null; emit({ switching: false }); },
    reportPlaybackFailure: () => {
      if (!active) return pending || !finished;
      failed.add(active.candidate.id);
      if (previous) {
        active = previous; previous = null; confirmed = true;
        const result = active.result;
        emit({ stream: result.kind === "hls" ? { hls: result.selected.url } : { mp4: result.selected.url }, switching: false,
          qualities: result.qualities.map((value) => ({ id: value.label, label: value.label === "auto" ? "Авто" : value.label, height: value.height })),
          subtitles: (result.subtitles || []).map((value) => ({ name: value.label, url: value.url })),
          audioNames: result.audioNames || [],
          meta: `${active.candidate.providerName} · ${active.candidate.voiceName}`,
          skip: result.skip || null,
          sourceError: { message: "Выбранный поток не воспроизводится. Возвращаем предыдущий источник" },
        });
        return true;
      }
      active = null; confirmed = false;
      emit({ stream: null, switching: false, sourceError: null, audioNames: [], skip: null });
      return next();
    },
  };
}
