import { storage, secureStorage } from './storage.js';
import { unionViewingIntervals } from './viewingStats.js';

const STATE_KEY = 'viewingData';
const AUTH_KEY = 'viewingProfileAuth';
const BATCH_BYTES = 28 * 1024;
const KEEPALIVE_BYTES = 60 * 1024;
const CLOSING_RESERVE_BYTES = 20 * 1024;
const encoder = new TextEncoder();
const jsonBytes = (value) => encoder.encode(JSON.stringify(value)).byteLength;
const BUCKETS = ['saved', 'watched', 'history', 'ratings'];
const clone = (value) => JSON.parse(JSON.stringify(value));
const object = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const equivalent = (a, b) => JSON.stringify(a, (_, value) => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]])) : value) === JSON.stringify(b, (_, value) => value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]])) : value);
const emptyLibrary = () => Object.fromEntries(BUCKETS.map((key) => [key, {}]));
const emptyQueue = () => ({ checkpoints: {}, sessions: {}, library: emptyLibrary() });
const profileErrorText = (code, status) => ({
  too_many_attempts: 'Слишком много попыток. Попробуйте позже.',
  pairing_expired: 'Код подключения истёк. Создайте новый на основном устройстве.',
  pairing_already_claimed: 'Этот код уже использован. Создайте новый код подключения.',
  pairing_not_found: 'Код подключения не найден. Проверьте его на основном устройстве.',
  pairing_already_used: 'Устройство уже подключилось по этому коду.',
  profile_too_large: 'Хранилище профиля заполнено. Локальные данные сохранены.',
  profile_storage_unavailable: 'Сервис синхронизации временно недоступен.',
  profile_encryption_unavailable: 'Сервис синхронизации временно недоступен.',
  unauthorized: 'Устройство отключено от профиля. Подключите его снова.',
}[code] || (status === 401 || status === 403 ? 'Нет доступа к профилю. Подключите устройство снова.' : 'Не удалось обновить профиль. Попробуйте ещё раз.'));
const contentKey = (item) => `${item?.type === 'tv' || item?.media_type === 'tv' ? 'tv' : 'movie'}_${item?.id}`;
const historyKey = (item) => item.type === 'tv' && item.season != null && item.episode != null ? `${contentKey(item)}_s${item.season}e${item.episode}` : contentKey(item);

export function canonicalViewingItem(item = {}) {
  const type = item.type === 'tv' || item.media_type === 'tv' ? 'tv' : 'movie';
  const out = { type, id: String(item.id), title: String(item.title || item.name || `${type === 'tv' ? 'Сериал' : 'Фильм'} ${item.id}`).slice(0, 240) };
  if (!/^[0-9]+$/.test(out.id)) throw new Error('Некорректный фильм');
  const year = Number(item.year || String(item.release_date || item.first_air_date || '').slice(0, 4));
  if (year >= 1870 && year <= 2200) out.year = year;
  if (typeof item.poster_path === 'string' && /^\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+$/.test(item.poster_path)) out.poster_path = item.poster_path.slice(0, 240);
  if (Number.isFinite(item.vote_average)) out.vote_average = item.vote_average;
  if (type === 'tv') for (const key of ['season', 'episode']) if (Number.isInteger(Number(item[key])) && item[key] != null) out[key] = Number(item[key]);
  for (const key of ['imdb_id', 'kinopoisk_id', 'catalogSource']) if (item[key] != null) out[key] = String(item[key]).slice(0, 120);
  out.genres = (item.genres || []).filter((genre) => genre && Number.isInteger(genre.id) && genre.name).slice(0, 16).map(({ id, name }) => ({ id, name: String(name).slice(0, 60) }));
  return out;
}

function canonicalPreferences(value = {}) {
  const result = {};
  for (const key of ['providerId', 'providerName', 'voiceId', 'voiceName']) if (typeof value[key] === 'string' && value[key].trim()) result[key] = value[key].slice(0, 120);
  const track = (v) => Object.fromEntries(['name', 'lang'].filter((key) => typeof v?.[key] === 'string').map((key) => [key, v[key].slice(0, key === 'lang' ? 32 : 120)]));
  if (value.audio) result.audio = track(value.audio);
  if (typeof value.subtitle?.enabled === 'boolean') result.subtitle = { ...track(value.subtitle), enabled: value.subtitle.enabled, ...(['external', 'embedded'].includes(value.subtitle.kind) ? { kind: value.subtitle.kind } : {}) };
  if (value.quality != null) result.quality = String(value.quality).slice(0, 40);
  return result;
}

function canonicalNativeLibrary(read) {
  const library = emptyLibrary();
  for (const bucket of ['saved', 'history']) for (const value of Object.values(read(bucket) || {})) {
    try {
      const item = canonicalViewingItem(value);
      if (bucket === 'history') {
        item.watchedAt = Number(value.watchedAt) || 0;
        if (value.episodeName) item.episodeName = String(value.episodeName).slice(0, 240);
      }
      library[bucket][bucket === 'history' ? historyKey(item) : contentKey(item)] = { value: item, revision: 0 };
    } catch {}
  }
  for (const [key, value] of Object.entries(object(read('watched')))) if (/^(movie|tv)_\d+(?:_s\d+e\d+)?$/.test(key)) library.watched[key] = { value: Boolean(value), revision: 0 };
  return library;
}

export function createViewingProfileStore({ read = storage.get, write = storage.set, remove = storage.remove, secure = secureStorage,
  fetchImpl = (...args) => fetch(...args), events = typeof window === 'undefined' ? null : window,
  now = () => Date.now(), timers = { setTimeout: (...args) => globalThis.setTimeout(...args), clearTimeout: (...args) => globalThis.clearTimeout(...args), setInterval: (...args) => globalThis.setInterval(...args), clearInterval: (...args) => globalThis.clearInterval(...args) }, uuid = () => crypto.randomUUID(), endpoint = '/api/profile', deviceName = () => /Mobile|Android|iPhone/i.test(globalThis.navigator?.userAgent || '') ? 'Телефон' : 'Компьютер' } = {}) {
  let auth = object(read(AUTH_KEY));
  let state = object(read(STATE_KEY));
  state = { ...state, revision: Number(state.revision) || 0, checkpoints: object(state.checkpoints), sessions: object(state.sessions), library: { ...canonicalNativeLibrary(read), ...object(state.library) },
    queue: { ...emptyQueue(), ...object(state.queue), library: { ...emptyLibrary(), ...object(state.queue?.library) } }, recordingStartedAt: state.recordingStartedAt || now() };
  if (state.clearRequest && state.clearRequest.profileId !== auth.profileId) delete state.clearRequest;
  let snapshot, pendingRefresh = null, pendingFlush = null, suppressStorage = false, debounceTimer = null, pollTimer = null, subscribers = new Set(), startCount = 0;
  let generation = 0, pendingUrgent = null, pairingDeadline = 0, lastPollAt = 0, requestSequence = 0, appliedSequence = 0, activeKeepaliveBytes = 0, priorityCheckpointKey = null;
  const activeBatches = new Set();
  const closingCaptures = new Set();
  let capturingClosingState = false;
  state.outbox = object(state.outbox);
  state.clientSequences = object(state.clientSequences);
  state.retainedMutationIds = Array.isArray(state.retainedMutationIds) ? state.retainedMutationIds : [];
  if (state.batch) state.outbox[state.batch.payload.mutationId] ||= state.batch;
  const nextSequence = (key, previous) => state.clientSequences[key] = Math.max(Number(state.clientSequences[key]) || 0, Number(previous?.clientSeq) || 0) + 1;
  const backgroundMs = () => Number(state.syncPolicy?.backgroundFlushMs) || 800;
  const pollMs = () => Number(state.syncPolicy?.pollIntervalMs) || 15000;
  const hasQueue = () => Boolean(state.batch || Object.keys(state.outbox).length || state.clearRequest || Object.values(state.queue.checkpoints).length || Object.values(state.queue.sessions).length || BUCKETS.some((bucket) => Object.keys(state.queue.library[bucket]).length));
  let status = auth.credential ? 'syncing' : 'local';
  let error = '';
  let remote = { devices: {}, pendingPairings: {}, displayName: '' };
  const linked = () => Boolean(auth.credential);
  const recordingEnabled = () => read('historyEnabled') !== false && read('historyEnabled') !== 0;
  const emit = () => {
    snapshot = { status, profileId: auth.profileId || null, deviceId: auth.deviceId || null, displayName: remote.displayName || '', devices: Object.values(object(remote.devices)), pairings: Object.values(object(remote.pendingPairings)), error,
      revision: state.revision, data: { checkpoints: state.checkpoints, sessions: state.sessions, library: state.library, recordingStartedAt: state.recordingStartedAt } };
    for (const fn of subscribers) fn();
  };
  const persist = () => { write(STATE_KEY, state); emit(); };
  const changeStatus = (next, message = '') => { status = next; error = message; emit(); };
  const nativeItem = (item) => ({ ...item, id: Number(item.id), media_type: item.type, year: item.year || '', season: item.season ?? null, episode: item.episode ?? null });
  const publishNative = (apiKey) => {
    const values = (bucket) => Object.values(state.library[bucket]).filter((r) => !r.deleted && r.value != null).map((r) => r.value);
    const saved = Object.fromEntries(values('saved').map((item) => [contentKey(item), nativeItem(item)]));
    const history = values('history').sort((a, b) => b.watchedAt - a.watchedAt).slice(0, 100).map(nativeItem);
    const watched = Object.fromEntries(Object.entries(state.library.watched).filter(([, r]) => !r.deleted).map(([key, r]) => [key, Boolean(r.value)]));
    const progress = { ...object(read('progress')) }, resumeTime = { ...object(read('resumeTime')) };
    for (const [key, checkpoint] of Object.entries(state.checkpoints)) {
      resumeTime[key] = checkpoint.position;
      if (checkpoint.duration > 0) progress[key] = Math.min(100, Math.round(checkpoint.position / checkpoint.duration * 100));
    }
    suppressStorage = true;
    for (const [key, value] of Object.entries({ saved, history, watched, progress, resumeTime })) write(key, value);
    suppressStorage = false;
    if (events && typeof CustomEvent !== 'undefined') events.dispatchEvent(new CustomEvent('streambert:profile-remote-applied', { detail: { saved, history, watched, progress, resumeTime, ...(apiKey ? { apiKey } : {}) } }));
  };
  const clearNativeWatch = () => {
    const keys = new Set([...Object.keys(object(read('progress'))), ...Object.keys(object(read('resumeTime'))), ...Object.keys(state.checkpoints)]);
    suppressStorage = true;
    for (const key of ['progress', 'resumeTime', 'history', 'watched']) remove(key);
    for (const key of keys) remove(`dlTime_${key}`);
    suppressStorage = false;
  };
  const clipSession = (session, cutoff) => {
    const segments = unionViewingIntervals((session.segments || []).map((part) => ({ start: Math.max(cutoff, part.start), end: part.end })));
    const result = { ...session, segments };
    if (!segments.length || result.completedAt < cutoff) delete result.completedAt;
    return result;
  };
  const discardWatchOutbox = () => {
    const retained = Object.values(state.outbox).filter((batch) => ['saved', 'ratings'].some((bucket) => Object.keys(batch.entries.library[bucket] || {}).some((key) => state.queue.library[bucket][key])));
    state.retainedMutationIds = [...new Set([...state.retainedMutationIds, ...retained.flatMap((batch) => [batch.payload.mutationId, ...(batch.payload.supersedesMutationIds || [])])])].slice(-30);
    delete state.batch;
    state.outbox = {};
  };
  const applyWatchReset = (value) => {
    const reset = Number(value.watchResetRevision) || 0;
    if (reset <= (state.watchResetRevision || 0)) return;
    clearNativeWatch();
    state.watchResetRevision = reset;
    state.watchClearedAt = Number(value.watchClearedAt) || 0;
    discardWatchOutbox();
    for (const [key, record] of Object.entries(state.queue.checkpoints)) if (record.value.baseRevision < reset) delete state.queue.checkpoints[key];
    for (const bucket of ['history', 'watched']) for (const [key, record] of Object.entries(state.queue.library[bucket])) if (record.value.baseRevision < reset) delete state.queue.library[bucket][key];
    for (const [key, record] of Object.entries(state.queue.sessions)) {
      record.value = clipSession(record.value, state.watchClearedAt);
      if (!record.value.segments.length) delete state.queue.sessions[key];
    }
  };
  const api = async (op = '', { method = 'GET', body, anonymous = false, keepalive = false, signal, priority = false } = {}) => {
    const requestGeneration = generation;
    const bytes = body ? jsonBytes(body) : 0;
    keepalive = keepalive && bytes <= KEEPALIVE_BYTES - (priority ? CLOSING_RESERVE_BYTES : 0) - activeKeepaliveBytes;
    if (keepalive) activeKeepaliveBytes += bytes;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) controller.abort();
    try {
      const response = await fetchImpl(`${endpoint}${op ? `?${op.startsWith('include=') ? op : `op=${op}`}` : ''}`, { method, headers: { 'Content-Type': 'application/json', ...(!anonymous && linked() ? { Authorization: `Bearer ${auth.credential}` } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}), signal: controller.signal, keepalive });
      let value;
      try { value = await response.json(); }
      catch { const invalid = new Error('Сервис синхронизации временно недоступен.'); invalid.status = response.status; throw invalid; }
      if (generation !== requestGeneration) { const changed = new Error('Профиль изменён'); changed.name = 'ProfileChangedError'; throw changed; }
      if (!response.ok) { const failure = new Error(profileErrorText(value.error, response.status)); failure.status = response.status; failure.code = value.error; throw failure; }
      return value;
    } finally { if (keepalive) activeKeepaliveBytes -= bytes; clearTimeout(timeout); signal?.removeEventListener('abort', abort); }
  };
  const failureStatus = (failure) => {
    if (failure.name === 'ProfileChangedError') return;
    if (failure.status === 401 || failure.status === 403) {
      generation++; pendingFlush = null; pendingUrgent = null; pendingRefresh = null; timers.clearTimeout(debounceTimer);
      auth = {}; remove(AUTH_KEY); state.queue = emptyQueue(); delete state.batch; state.outbox = {}; state.clientSequences = {}; state.retainedMutationIds = []; delete state.clearRequest; delete state.syncPolicy; delete state.nextFlushAt; delete state.pairClaim; pairingDeadline = 0; state.revision = 0;
      remote = { devices: {}, pendingPairings: {}, displayName: '' }; persist();
      changeStatus('error', 'Устройство отключено от профиля. Подключите его снова.');
    }
    else if (failure.status === 413) changeStatus('error', 'Облачное хранилище профиля заполнено. Локальный просмотр сохранён.');
    else changeStatus('offline', 'Нет связи с облаком. Просмотр сохранён на этом устройстве.');
  };
  const overlayQueue = () => {
    for (const [key, record] of Object.entries(state.queue.checkpoints)) state.checkpoints[key] = record.value;
    for (const [key, record] of Object.entries(state.queue.sessions)) state.sessions[key] = { ...record.value, segments: unionViewingIntervals([...(state.sessions[key]?.segments || []), ...record.value.segments]) };
    for (const bucket of BUCKETS) for (const [key, record] of Object.entries(state.queue.library[bucket])) state.library[bucket][key] = record.value;
  };
  const applyRemote = (value, batch = null) => {
    if (value.syncPolicy) state.syncPolicy = { backgroundFlushMs: Math.max(1000, Number(value.syncPolicy.backgroundFlushMs) || 300000), pollIntervalMs: Math.max(15000, Number(value.syncPolicy.pollIntervalMs) || 120000) };
    else delete state.syncPolicy;
    if (batch) {
      for (const bucket of ['checkpoints', 'sessions', ...BUCKETS]) {
        const captured = ['checkpoints', 'sessions'].includes(bucket) ? batch.entries[bucket] : batch.entries.library[bucket];
        const queued = ['checkpoints', 'sessions'].includes(bucket) ? state.queue[bucket] : state.queue.library[bucket];
        for (const [key, record] of Object.entries(captured || {})) {
          if (queued[key]?.version === record.version) delete queued[key];
          else if (queued[key] && bucket !== 'sessions') {
            const accepted = bucket === 'checkpoints' ? value.checkpoints?.[key] : value.library?.[bucket]?.[key];
            if (accepted?.deviceId === auth.deviceId && accepted.revision > record.value.baseRevision) queued[key].value.baseRevision = Math.max(queued[key].value.baseRevision, accepted.revision);
          }
        }
      }
    }
    if (Number(value.revision) < state.revision) { if (batch && Number(remote.revision) >= state.revision) applyRemote(remote); else persist(); return; }
    remote = clone(value);
    applyWatchReset(value);
    state.revision = Number(value.revision) || 0;
    state.checkpoints = object(value.checkpoints);
    state.sessions = object(value.sessions);
    state.library = { ...emptyLibrary(), ...object(value.library) };
    if (state.clearRequest) {
      state.checkpoints = {}; state.sessions = {};
      state.library.history = {}; state.library.watched = {};
    }
    overlayQueue();
    for (const [mutationId, pending] of Object.entries(state.outbox)) {
      const outstanding = ['checkpoints', 'sessions', ...BUCKETS].some((bucket) => {
        const entries = ['checkpoints', 'sessions'].includes(bucket) ? pending.entries[bucket] : pending.entries.library[bucket];
        const queue = ['checkpoints', 'sessions'].includes(bucket) ? state.queue[bucket] : state.queue.library[bucket];
        return Object.keys(entries || {}).some((key) => queue[key]);
      });
      if (!outstanding && jsonBytes(pending.payload) > BATCH_BYTES) {
        delete state.outbox[mutationId];
        if (state.batch?.payload.mutationId === mutationId) delete state.batch;
      }
    }
    if (!['saved', 'ratings'].some((bucket) => Object.keys(state.queue.library[bucket]).length)) state.retainedMutationIds = [];
    persist();
    publishNative();
  };
  const batchForQueue = (fresh = false, maxBytes = BATCH_BYTES) => {
    if (!fresh) {
      const waiting = Object.values(state.outbox).find((batch) => !activeBatches.has(batch.payload.mutationId) && jsonBytes(batch.payload) <= maxBytes);
      if (waiting) return waiting;
      if (state.batch && jsonBytes(state.batch.payload) <= maxBytes) return state.batch;
    }
    const entries = emptyQueue();
    const payload = { mutationId: uuid(), deviceId: auth.deviceId, ...(Object.keys(state.outbox).length || state.retainedMutationIds.length ? { supersedesMutationIds: [...new Set([...state.retainedMutationIds, ...Object.values(state.outbox).flatMap((batch) => [batch.payload.mutationId, ...(batch.payload.supersedesMutationIds || [])])])].slice(-30) } : {}), checkpoints: [], sessions: [], library: {} };
    const checkpoints = Object.entries(state.queue.checkpoints).sort((a, b) => Number(b[0] === priorityCheckpointKey) - Number(a[0] === priorityCheckpointKey) || b[1].value.updatedAt - a[1].value.updatedAt).slice(0, 30);
    const sessions = Object.entries(state.queue.sessions).sort((a, b) => Number(b[1].value.progressKey === priorityCheckpointKey) - Number(a[1].value.progressKey === priorityCheckpointKey)).slice(0, 8);
    const groups = [
      ['checkpoints', checkpoints.filter(([key]) => key === priorityCheckpointKey)],
      ['sessions', sessions.filter(([, record]) => record.value.progressKey === priorityCheckpointKey)],
      ['checkpoints', checkpoints.filter(([key]) => key !== priorityCheckpointKey)],
      ['sessions', sessions.filter(([, record]) => record.value.progressKey !== priorityCheckpointKey)],
      ...BUCKETS.map((bucket) => [bucket, Object.entries(state.queue.library[bucket]).slice(0, 30)]),
    ];
    let count = 0;
    for (const [bucket, records] of groups) {
      for (const [key, value] of records) {
        const next = clone(payload);
        if (bucket === 'checkpoints' || bucket === 'sessions') next[bucket].push(value.value);
        else { next.library[bucket] ||= {}; next.library[bucket][key] = value.value; }
        if (jsonBytes(next) > maxBytes) continue;
        Object.assign(payload, next);
        const records = ['checkpoints', 'sessions'].includes(bucket) ? entries[bucket] : entries.library[bucket];
        records[key] = clone(value);
        count++;
      }
    }
    if (!count) return null;
    state.batch = { payload, entries };
    state.outbox[payload.mutationId] = state.batch;
    persist();
    return state.batch;
  };
  const flush = ({ keepalive = false, background = false, priority = false } = {}) => {
    if (!linked()) return Promise.resolve(snapshot);
    if ((pendingFlush || pendingUrgent) && (background || (!keepalive && !priority))) {
      const waiting = pendingUrgent || pendingFlush;
      return background ? waiting : waiting.then(() => flush());
    }
    const urgent = Boolean((pendingFlush || pendingUrgent) && (keepalive || priority));
    const changedBatch = state.batch && ['checkpoints', 'sessions', ...BUCKETS].some((bucket) => {
      const queued = ['checkpoints', 'sessions'].includes(bucket) ? state.queue[bucket] : state.queue.library[bucket];
      const captured = ['checkpoints', 'sessions'].includes(bucket) ? state.batch.entries[bucket] : state.batch.entries.library[bucket];
      return Object.entries(queued).some(([key, record]) => captured?.[key]?.version !== record.version);
    });
    if (urgent && state.batch && !changedBatch && !state.clearRequest) return pendingUrgent || pendingFlush;
    const requestedBytes = Math.min(BATCH_BYTES, KEEPALIVE_BYTES - (priority ? CLOSING_RESERVE_BYTES : 0) - activeKeepaliveBytes);
    const maxBytes = keepalive && requestedBytes >= 8 * 1024 ? requestedBytes : BATCH_BYTES;
    const freshBatch = (keepalive || priority) && (!state.batch || changedBatch || jsonBytes(state.batch.payload) > maxBytes);
    const requestGeneration = generation, sequence = ++requestSequence;
    timers.clearTimeout(debounceTimer);
    delete state.nextFlushAt;
    const work = (async () => {
      try {
        for (let i = 0; i < 30; i++) {
          if (generation !== requestGeneration) break;
          if (state.clearRequest) {
            const clearRequest = state.clearRequest;
            changeStatus('syncing');
            const result = await api('watch/clear', { method: 'POST', body: { ...clearRequest, deviceId: auth.deviceId }, keepalive, priority });
            const revision = result.snapshot.watchResetRevision;
            for (const record of Object.values(state.queue.checkpoints)) record.value.baseRevision = revision;
            for (const bucket of ['history', 'watched']) for (const record of Object.values(state.queue.library[bucket])) record.value.baseRevision = revision;
            if (state.clearRequest === clearRequest) delete state.clearRequest;
            discardWatchOutbox();
            applyRemote(result.snapshot);
            continue;
          }
          const batch = batchForQueue(freshBatch && i === 0, maxBytes);
          if (!batch || activeBatches.has(batch.payload.mutationId)) break;
          activeBatches.add(batch.payload.mutationId);
          changeStatus('syncing');
          let result;
          try { result = await api('', { method: 'PATCH', body: batch.payload, keepalive, priority }); }
          finally { activeBatches.delete(batch.payload.mutationId); }
          delete state.outbox[batch.payload.mutationId];
          if (state.batch?.payload.mutationId === batch.payload.mutationId) delete state.batch;
          applyRemote(result.snapshot, batch);
          appliedSequence = Math.max(appliedSequence, sequence);
          if (background && state.syncPolicy) break;
        }
        if (generation === requestGeneration && sequence >= appliedSequence) changeStatus('ready');
      } catch (failure) { if (generation === requestGeneration && sequence >= appliedSequence) failureStatus(failure); }
      return snapshot;
    })().finally(() => {
      if (generation !== requestGeneration) return;
      if (urgent) { if (pendingUrgent === work) pendingUrgent = null; }
      else if (pendingFlush === work) pendingFlush = null;
      if (hasQueue()) schedule();
      else { delete state.nextFlushAt; persist(); }
    });
    if (urgent) pendingUrgent = work;
    else pendingFlush = work;
    return work;
  };
  const schedule = (immediate = false, keepalive = false) => {
    if (!linked() || capturingClosingState) return;
    timers.clearTimeout(debounceTimer);
    if (immediate) void flush({ keepalive, priority: true });
    else {
      if (!state.syncPolicy) state.nextFlushAt = now() + backgroundMs();
      else state.nextFlushAt ||= now() + backgroundMs();
      write(STATE_KEY, state);
      debounceTimer = timers.setTimeout(() => { delete state.nextFlushAt; void flush({ background: true }); }, Math.max(0, state.nextFlushAt - now()));
    }
  };
  const queueLibrary = (bucket, key, record) => {
    const baseRevision = state.queue.library[bucket][key]?.value.baseRevision ?? state.library[bucket][key]?.revision ?? state.revision;
    const value = { ...record, baseRevision, clientSeq: nextSequence(`${bucket}:${key}`, state.library[bucket][key]) };
    state.library[bucket][key] = value;
    if (linked()) state.queue.library[bucket][key] = { version: uuid(), value };
  };
  const refresh = ({ background = false } = {}) => {
    if (!linked()) return Promise.resolve(snapshot);
    if (pendingRefresh) return background ? pendingRefresh : pendingRefresh.then(() => flush());
    const requestGeneration = generation;
    pendingRefresh = (async () => {
      try {
        const value = await api(auth.needsBootstrap ? 'include=bootstrapToken' : '');
        if (auth.needsBootstrap && value.bootstrapToken) {
          await secure.set('apikey', value.bootstrapToken);
          delete auth.needsBootstrap; write(AUTH_KEY, auth);
          applyRemote(value); publishNative(value.bootstrapToken);
        } else applyRemote(value);
        if (!background || !state.syncPolicy) await flush();
        else { if (!pendingFlush && !pendingUrgent) changeStatus('ready'); if (hasQueue()) schedule(); }
      }
      catch (failure) { failureStatus(failure); }
      return snapshot;
    })().finally(() => { if (generation === requestGeneration) pendingRefresh = null; });
    return pendingRefresh;
  };
  const captureNative = (key, value) => {
    if (!['saved', 'history', 'watched'].includes(key)) return;
    const next = canonicalNativeLibrary((name) => name === key ? value : read(name))[key];
    for (const [recordKey, record] of Object.entries(next)) {
      const old = state.library[key][recordKey];
      if (!equivalent(old?.value, record.value) || old?.deleted) queueLibrary(key, recordKey, { value: record.value });
    }
    for (const [recordKey, old] of Object.entries(state.library[key])) if (!old.deleted && !next[recordKey]) queueLibrary(key, recordKey, { deleted: true });
    persist(); schedule(Boolean(state.syncPolicy));
  };
  const onWrite = (event) => { if (!suppressStorage) captureNative(event.detail?.key, event.detail?.value); };
  const onOnline = () => { lastPollAt = now(); void refresh(); };
  const onHide = (event) => {
    if (event?.type !== 'pagehide' && typeof document !== 'undefined' && document.visibilityState !== 'hidden') return;
    capturingClosingState = true;
    try {
      for (const capture of closingCaptures) {
        try { capture(); } catch {}
      }
    } finally { capturingClosingState = false; }
    void flush({ keepalive: true, priority: event?.type !== 'pagehide' });
  };
  const start = () => {
    if (!startCount++) {
      events?.addEventListener('streambert:storage-write', onWrite);
      events?.addEventListener('online', onOnline);
      events?.addEventListener('focus', onOnline);
      events?.addEventListener('pagehide', onHide);
      events?.addEventListener('visibilitychange', onHide);
      pollTimer = timers.setInterval(() => {
        const pairing = pairingDeadline > now() || Object.values(object(remote.pendingPairings)).some((request) => !request.expiresAt || Number(request.expiresAt) > now());
        if ((typeof document === 'undefined' || document.visibilityState !== 'hidden') && now() - lastPollAt >= (pairing ? 15000 : pollMs())) { lastPollAt = now(); void refresh({ background: true }); }
      }, 15000);
      lastPollAt = now();
      void refresh({ background: true });
    }
    let disposed = false;
    return () => { if (disposed) return; disposed = true; if (--startCount) return; timers.clearInterval(pollTimer); timers.clearTimeout(debounceTimer);
      events?.removeEventListener('streambert:storage-write', onWrite); events?.removeEventListener('online', onOnline); events?.removeEventListener('focus', onOnline); events?.removeEventListener('pagehide', onHide); events?.removeEventListener('visibilitychange', onHide); };
  };
  const adopt = async (grant, transferLocal = false) => {
    const local = clone(state);
    generation++;
    pendingRefresh = null; pendingFlush = null; pendingUrgent = null;
    auth = { credential: grant.credential, profileId: grant.profileId, deviceId: grant.deviceId, ...(!transferLocal ? { needsBootstrap: true } : {}) };
    write(AUTH_KEY, auth);
    state.queue = emptyQueue(); delete state.batch; state.outbox = {}; state.clientSequences = {}; state.retainedMutationIds = []; delete state.clearRequest; delete state.syncPolicy; delete state.nextFlushAt; delete state.pairClaim; pairingDeadline = 0; state.revision = 0;
    applyRemote(grant.snapshot);
    if (transferLocal) {
      for (const [key, value] of Object.entries(local.checkpoints)) saveCheckpoint(key, value);
      for (const value of Object.values(local.sessions)) saveSession(value);
      for (const bucket of BUCKETS) for (const [key, value] of Object.entries(local.library[bucket])) queueLibrary(bucket, key, value.deleted ? { deleted: true } : { value: value.value });
      persist(); publishNative(); await flush();
    }
    return snapshot;
  };
  const saveCheckpoint = (key, value, { flush: immediate = false } = {}) => {
    if (!recordingEnabled()) return;
    const item = canonicalViewingItem(value.item);
    if (historyKey(item) !== key) throw new Error('Позиция не соответствует фильму');
    const previous = state.checkpoints[key];
    const position = Number(value.position), duration = Number(value.duration);
    if (!Number.isFinite(position) || position < 0 || !Number.isFinite(duration) || duration < 0) return;
    const baseRevision = state.queue.checkpoints[key]?.value.baseRevision ?? previous?.revision ?? state.revision;
    const checkpoint = { progressKey: key, item, position, duration, preferences: canonicalPreferences(value.preferences), baseRevision, clientSeq: nextSequence(`checkpoint:${key}`, previous), updatedAt: now(), deviceId: auth.deviceId || 'local' };
    state.checkpoints[key] = checkpoint;
    priorityCheckpointKey = key;
    if (linked()) state.queue.checkpoints[key] = { version: uuid(), value: checkpoint };
    persist(); schedule(immediate || Boolean(state.syncPolicy && !equivalent(previous?.preferences || {}, checkpoint.preferences)), immediate);
    return checkpoint;
  };
  const saveSession = (value, { flush: immediate = false } = {}) => {
    if (!recordingEnabled()) return;
    const item = canonicalViewingItem(value.item);
    if (historyKey(item) !== value.progressKey) throw new Error('Просмотр не соответствует фильму');
    const previous = state.sessions[value.sessionId];
    const segments = unionViewingIntervals([...(previous?.segments || []), ...(value.segments || [])]);
    let session;
    for (let offset = 0; offset < Math.max(1, segments.length); offset += 200) {
      const sessionId = offset ? `${value.sessionId.slice(0, -6)}${(offset / 200).toString(16).padStart(6, '0')}` : value.sessionId;
      session = { sessionId, progressKey: value.progressKey, item, segments: segments.slice(offset, offset + 200), ...(value.completedAt || previous?.completedAt ? { completedAt: value.completedAt || previous.completedAt } : {}), deviceId: auth.deviceId || 'local' };
      state.sessions[sessionId] = session;
      if (linked()) state.queue.sessions[sessionId] = { version: uuid(), value: session };
    }
    persist(); schedule(immediate || Boolean(value.completedAt && value.completedAt !== previous?.completedAt));
    return session;
  };
  emit();
  return {
    getSnapshot: () => snapshot,
    subscribe: (fn) => { subscribers.add(fn); return () => subscribers.delete(fn); },
    registerClosingCapture: (capture) => { closingCaptures.add(capture); return () => closingCaptures.delete(capture); },
    start, refresh, flush,
    wait: async ({ timeoutMs = 8000, signal } = {}) => {
      if (!linked() || signal?.aborted) return snapshot;
      let timer, abort;
      const waiting = new Promise((resolve) => { timer = setTimeout(() => resolve(snapshot), timeoutMs); abort = () => resolve(snapshot); signal?.addEventListener('abort', abort, { once: true }); });
      try { return await Promise.race([refresh(), waiting]); } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
    },
    getCheckpoint: (key) => state.checkpoints[key] || null,
    saveCheckpoint, saveSession,
    getData: () => ({ ...snapshot.data, ratings: state.library.ratings, history: read('history') || [], watched: read('watched') || {}, recordingStartedAt: state.recordingStartedAt }),
    getRating: (item) => { const value = state.library.ratings[contentKey(item)]; return value?.deleted ? null : value?.value || null; },
    clearWatch: async () => {
      clearNativeWatch();
      state.checkpoints = {}; state.sessions = {}; state.library.history = {}; state.library.watched = {};
      state.queue.checkpoints = {}; state.queue.sessions = {}; state.queue.library.history = {}; state.queue.library.watched = {};
      discardWatchOutbox();
      state.recordingStartedAt = now();
      if (linked()) state.clearRequest = { mutationId: uuid(), clearedAt: now(), profileId: auth.profileId };
      persist(); publishNative();
      return flush({ keepalive: true });
    },
    rate: (item, score) => {
      if (score != null && (!Number.isInteger(score) || score < 1 || score > 10)) throw new Error('Оценка должна быть от 1 до 10');
      queueLibrary('ratings', contentKey(item), score == null ? { deleted: true } : { value: { score, ratedAt: now(), item: canonicalViewingItem(item) } });
      persist(); schedule(Boolean(state.syncPolicy));
    },
    create: async ({ displayName = 'Мой кинотеатр', deviceName: name, tmdbToken } = {}) => {
      tmdbToken ||= await secure.get('apikey');
      if (!tmdbToken) throw new Error('Сначала подключите каталог фильмов');
      const result = await api('', { method: 'POST', anonymous: true, body: { displayName, deviceName: name || deviceName(), tmdbToken } });
      await adopt(result, true); return snapshot;
    },
    beginPairing: async () => { const result = await api('pair/create', { method: 'POST', body: { deviceName: deviceName() } }); pairingDeadline = Number(result.expiresAt) || now() + 600000; return result; },
    claimPairing: async ({ shortCode, requestToken, deviceName: name, claimId } = {}) => {
      const code = String(shortCode || '').replace(/[\s-]/g, '').toUpperCase();
      const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(requestToken ? `token:${requestToken}` : `code:${code}`));
      const offerHash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
      if (!state.pairClaim || state.pairClaim.offerHash !== offerHash || state.pairClaim.expiresAt <= now()) state.pairClaim = { offerHash, claimId: claimId || uuid(), expiresAt: now() + 600000 };
      persist();
      return api('pair/claim', { method: 'POST', anonymous: true, body: { deviceName: name || deviceName(), claimId: claimId || state.pairClaim.claimId, ...(requestToken ? { requestToken } : { shortCode: code }) } });
    },
    pollPairing: async ({ requestId, pollToken, requestToken }) => {
      const result = await api('pair/poll', { method: 'POST', anonymous: true, body: { requestId, pollToken: pollToken || requestToken } });
      if (result.status === 'approved') {
        await adopt(result);
        await refresh();
      }
      return result;
    },
    approvePairing: async (requestId) => { const result = await api('pair/approve', { method: 'POST', body: { requestId } }); await refresh(); return result; },
    revokeDevice: async (deviceId) => { const result = await api('revoke', { method: 'POST', body: { deviceId } }); applyRemote(result.snapshot); return result; },
    disconnect: () => { generation++; pendingRefresh = null; pendingFlush = null; pendingUrgent = null; auth = {}; remove(AUTH_KEY); state.queue = emptyQueue(); delete state.batch; state.outbox = {}; state.clientSequences = {}; state.retainedMutationIds = []; delete state.clearRequest; delete state.syncPolicy; delete state.nextFlushAt; delete state.pairClaim; pairingDeadline = 0; state.revision = 0; remote = { devices: {}, pendingPairings: {}, displayName: '' }; persist(); changeStatus('local'); },
  };
}

let singleton;
const profile = () => singleton ||= createViewingProfileStore({ endpoint: typeof window !== 'undefined' && window.location?.protocol === 'file:' ? 'https://lampa-stream-six.vercel.app/api/profile' : '/api/profile' });
export const getViewingProfileSnapshot = () => profile().getSnapshot();
export const subscribeViewingProfile = (listener) => profile().subscribe(listener);
export const startViewingProfileSync = () => profile().start();
export const refreshViewingProfile = () => profile().refresh();
export const waitForViewingProfile = (options) => profile().wait(options);
export const getPlaybackCheckpoint = (key) => profile().getCheckpoint(key);
export const savePlaybackCheckpoint = (key, value, options) => profile().saveCheckpoint(key, value, options);
export const flushViewingProfile = (options) => profile().flush(options);
export const registerViewingProfileClosingCapture = (capture) => profile().registerClosingCapture(capture);
export const recordViewingSession = (value, options) => profile().saveSession(value, options);
export const getViewingData = () => profile().getData();
export const getPersonalRating = (item) => profile().getRating(item);
export const setPersonalRating = (item, score) => profile().rate(item, score);
export const createViewingProfile = (options) => profile().create(options);
export const beginDevicePairing = () => profile().beginPairing();
export const claimDevicePairing = (options) => profile().claimPairing(options);
export const pollDevicePairing = (options) => profile().pollPairing(options);
export const approveDevicePairing = (requestId) => profile().approvePairing(requestId);
export const revokeProfileDevice = (deviceId) => profile().revokeDevice(deviceId);
export const disconnectViewingProfile = () => profile().disconnect();
export const clearViewingHistory = () => profile().clearWatch();
