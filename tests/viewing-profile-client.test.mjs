import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createViewingProfileStore } from '../src/utils/viewingProfile.js';
import { mergeProfileSnapshot, validateCheckpoint, validateSession, validateLibrary } from '../api/_lib/_profile.mjs';

const film = { type: 'movie', id: 550, title: 'Бойцовский клуб', genres: [{ id: 18, name: 'Драма' }] };
const prefs = { providerId: 'habster:alloha', voiceId: 'alloha:123', voiceName: 'Дубляж', subtitle: { enabled: false }, audio: { name: 'Русский', lang: 'ru' } };
const blank = () => ({ revision: 0, profileId: 'qa', devices: {}, pendingPairings: {}, displayName: 'QA', checkpoints: {}, sessions: {}, library: { saved: {}, watched: {}, history: {}, ratings: {} } });
const memory = (initial = {}) => {
  const values = structuredClone(initial);
  return { values, read: (key) => structuredClone(values[key] ?? null), write: (key, value) => { values[key] = structuredClone(value); }, remove: (key) => { delete values[key]; } };
};
const response = (value, status = 200) => ({ ok: status < 400, status, json: async () => structuredClone(value) });
function fixture({ initial = {}, linked = true } = {}) {
  const disk = memory({ ...(linked ? { viewingProfileAuth: { credential: 'qa-only', profileId: 'qa', deviceId: 'desktop' } } : {}), ...initial });
  const cloud = { value: blank(), requests: [], offline: false, patchWait: null, receipts: new Set(), secureToken: null };
  const options = { ...disk, events: null, uuid: randomUUID, secure: { get: async () => 'tmdb-fixture', set: async (_, value) => { cloud.secureToken = value; } }, fetchImpl: async (url, options) => {
    const body = options.body && JSON.parse(options.body);
    cloud.requests.push({ url, method: options.method, body });
    if (cloud.offline || cloud.bootstrapFails && url.includes('bootstrapToken')) throw new Error('offline');
    if (options.method === 'POST') {
      if (url.includes('watch/clear')) {
        assert.equal(body.deviceId, 'desktop');
        cloud.value = { ...cloud.value, revision: cloud.value.revision + 1, watchResetRevision: cloud.value.revision + 1, watchClearedAt: body.clearedAt, checkpoints: {}, sessions: {}, library: { ...cloud.value.library, history: {}, watched: {} } };
        return response({ snapshot: cloud.value });
      }
      if (url.includes('pair/poll')) return response({ status: 'approved', credential: 'phone-grant', profileId: 'qa', deviceId: 'phone', snapshot: cloud.value });
      return response({ credential: 'qa-only', profileId: 'qa', deviceId: 'desktop', snapshot: cloud.value }, 201);
    }
    if (options.method === 'PATCH') {
      if (cloud.patchWait) await cloud.patchWait;
      if (!cloud.receipts.has(body.mutationId)) {
        cloud.receipts.add(body.mutationId);
        const patch = { checkpoints: body.checkpoints.map(validateCheckpoint), sessions: body.sessions.map(validateSession), library: validateLibrary(body.library) };
        cloud.value = mergeProfileSnapshot(cloud.value, patch, { deviceId: body.deviceId, now: 10000 });
      }
      return response({ snapshot: cloud.value });
    }
    return response({ ...cloud.value, ...(url.includes('bootstrapToken') ? { bootstrapToken: 'tmdb-transferred' } : {}) });
  } };
  const store = createViewingProfileStore(options);
  return { store, cloud, disk, reload: () => createViewingProfileStore(options) };
}

test('unlinked playback is immediate and persists only semantic preferences', async () => {
  const { store, cloud, disk } = fixture({ linked: false });
  store.saveCheckpoint('movie_550', { item: film, position: 40.123, duration: 500, preferences: { ...prefs, candidateId: 'sealed-secret', url: 'https://private/secret', headers: { Authorization: 'secret' } } });
  await store.wait();
  assert.equal(cloud.requests.length, 0);
  assert.equal(store.getCheckpoint('movie_550').position, 40.123);
  assert.deepEqual(store.getCheckpoint('movie_550').preferences, prefs);
  assert.ok(!JSON.stringify(disk.values.viewingData).includes('secret'));
  assert.strictEqual(store.getSnapshot(), store.getSnapshot());
});

test('a stale offline queue cannot overwrite a newer other-device position; a fresh rewind can', async () => {
  const { store, cloud } = fixture();
  cloud.value = mergeProfileSnapshot(cloud.value, { checkpoints: [{ progressKey: 'movie_550', item: film, position: 50, duration: 100, preferences: prefs, baseRevision: 0 }] }, { deviceId: 'desktop', now: 1 });
  await store.refresh();
  cloud.offline = true;
  store.saveCheckpoint('movie_550', { item: film, position: 60, duration: 100, preferences: prefs });
  await store.flush();
  assert.equal(store.getSnapshot().status, 'offline');
  cloud.value = mergeProfileSnapshot(cloud.value, { checkpoints: [{ progressKey: 'movie_550', item: film, position: 90, duration: 100, preferences: prefs, baseRevision: 1 }] }, { deviceId: 'phone', now: 2 });
  cloud.offline = false;
  await store.refresh();
  assert.equal(store.getCheckpoint('movie_550').position, 90);
  store.saveCheckpoint('movie_550', { item: film, position: 18.321, duration: 100, preferences: prefs });
  await store.flush();
  assert.equal(cloud.value.checkpoints.movie_550.position, 18.321);
});

test('a checkpoint written during a request survives acknowledgement and advances its own base', async () => {
  const { store, cloud } = fixture();
  let release;
  cloud.patchWait = new Promise((resolve) => { release = resolve; });
  store.saveCheckpoint('movie_550', { item: film, position: 12, duration: 100, preferences: prefs });
  const pending = store.flush();
  store.saveCheckpoint('movie_550', { item: film, position: 34, duration: 100, preferences: prefs });
  release(); cloud.patchWait = null;
  await pending;
  assert.equal(cloud.value.checkpoints.movie_550.position, 34);
  assert.equal(store.getCheckpoint('movie_550').position, 34);
  assert.equal(cloud.requests.filter((r) => r.method === 'PATCH').length, 2);
});

test('retry preserves the persisted mutation ID across reload and retains ratings/library metadata', async () => {
  const { store, cloud, disk, reload } = fixture({ initial: { saved: { movie_550: { ...film, media_type: 'movie', poster_path: '/poster.jpg' } }, history: [{ ...film, media_type: 'movie', watchedAt: 5000 }] } });
  cloud.offline = true;
  store.rate(film, 9);
  await store.flush();
  const mutationId = disk.values.viewingData.batch.payload.mutationId;
  cloud.offline = false;
  const reopened = reload();
  await reopened.flush();
  assert.equal(cloud.requests.filter((r) => r.method === 'PATCH').at(-1).body.mutationId, mutationId);
  assert.equal(cloud.value.library.ratings.movie_550.value.item.title, film.title);
  reopened.rate(film, null);
  await reopened.flush();
  assert.equal(reopened.getRating(film), null);
  assert.equal(cloud.value.library.ratings.movie_550.deleted, true);
});

test('creating a profile imports local library and intervals without losing their real metadata', async () => {
  const { store, cloud, disk } = fixture({ linked: false, initial: { saved: { movie_550: { ...film, media_type: 'movie', poster_path: '/poster.jpg' } }, history: [{ ...film, media_type: 'movie', watchedAt: 5000 }] } });
  store.saveSession({ sessionId: randomUUID(), progressKey: 'movie_550', item: film, segments: [{ start: 1000, end: 5000 }] });
  await store.create();
  assert.equal(cloud.value.library.saved.movie_550.value.title, film.title);
  assert.equal(cloud.value.library.history.movie_550.value.watchedAt, 5000);
  assert.equal(disk.values.saved.movie_550.media_type, 'movie');
  assert.equal(Object.values(cloud.value.sessions)[0].deviceId, 'desktop');
});

test('bootstrap token is transferred to secure storage after a one-time phone grant', async () => {
  const { store, cloud } = fixture({ linked: false });
  cloud.value.checkpoints.movie_550 = { progressKey: 'movie_550', item: film, position: 321.5, duration: 1000, preferences: prefs, revision: 0 };
  await store.pollPairing({ requestId: 'request', pollToken: 'poll' });
  assert.equal(cloud.secureToken, 'tmdb-transferred');
  assert.equal(store.getCheckpoint('movie_550').position, 321.5);
  assert.equal(store.getSnapshot().status, 'ready');
});

test('an in-flight response cannot reattach a disconnected profile', async () => {
  const { store, cloud } = fixture();
  let release;
  cloud.patchWait = new Promise((resolve) => { release = resolve; });
  store.saveCheckpoint('movie_550', { item: film, position: 10, duration: 100, preferences: prefs });
  const pending = store.flush();
  store.disconnect(); release();
  await pending;
  assert.equal(store.getSnapshot().profileId, null);
  assert.equal(store.getSnapshot().status, 'local');
});

test('a granted phone retries catalogue bootstrap after network failure and reload', async () => {
  const { store, cloud, disk, reload } = fixture({ linked: false });
  cloud.bootstrapFails = true;
  assert.equal((await store.pollPairing({ requestId: 'qa', pollToken: 'qa' })).status, 'approved');
  assert.equal(store.getSnapshot().status, 'offline');
  assert.equal(disk.values.viewingProfileAuth.needsBootstrap, true);
  cloud.bootstrapFails = false;
  const reopened = reload();
  await reopened.refresh();
  assert.equal(cloud.secureToken, 'tmdb-transferred');
  assert.equal(disk.values.viewingProfileAuth.needsBootstrap, undefined);
  assert.equal(reopened.getSnapshot().status, 'ready');
});

test('long fragmented sessions fit API limits and retries do not fabricate extra intervals', () => {
  const { store } = fixture({ linked: false });
  const sessionId = randomUUID();
  const segments = Array.from({ length: 450 }, (_, i) => ({ start: i * 2000, end: i * 2000 + 1000 }));
  store.saveSession({ sessionId, progressKey: 'movie_550', item: film, segments });
  store.saveSession({ sessionId, progressKey: 'movie_550', item: film, segments });
  const sessions = Object.values(store.getData().sessions);
  assert.equal(sessions.length, 3);
  assert.equal(sessions.reduce((n, value) => n + value.segments.length, 0), 450);
  sessions.forEach(validateSession);
});

test('watch clear removes local/cloud watch data while preserving personal ratings', async () => {
  const { store, cloud, disk } = fixture();
  store.saveCheckpoint('movie_550', { item: film, position: 40, duration: 100, preferences: prefs });
  store.saveSession({ sessionId: randomUUID(), progressKey: 'movie_550', item: film, segments: [{ start: Date.now() - 10000, end: Date.now() - 1000 }] });
  store.rate(film, 9);
  await store.flush();
  await store.clearWatch();
  await store.refresh();
  assert.equal(store.getCheckpoint('movie_550'), null);
  assert.deepEqual(disk.values.resumeTime, {});
  assert.deepEqual(cloud.value.sessions, {});
  assert.equal(store.getRating(film).score, 9);
});

test('a remote watch reset clears legacy native maps and an old offline outbox', async () => {
  const { store, cloud, disk } = fixture({ initial: { progress: { movie_550: 40 }, resumeTime: { movie_550: 40 }, dlTime_movie_550: 40 } });
  store.saveCheckpoint('movie_550', { item: film, position: 50, duration: 100, preferences: prefs });
  cloud.value = { ...cloud.value, revision: 3, watchResetRevision: 3, watchClearedAt: Date.now() };
  await store.refresh();
  assert.equal(store.getCheckpoint('movie_550'), null);
  assert.deepEqual(disk.values.progress, {});
  assert.deepEqual(disk.values.resumeTime, {});
  assert.equal(disk.values.dlTime_movie_550, undefined);
  assert.equal(cloud.requests.filter((r) => r.method === 'PATCH').length, 0);
});

test('offline clear keeps subsequent local playback and syncs it after the reset', async () => {
  const { store, cloud } = fixture();
  cloud.offline = true;
  await store.clearWatch();
  store.saveCheckpoint('movie_550', { item: film, position: 15, duration: 100, preferences: prefs });
  cloud.offline = false;
  await store.refresh();
  assert.equal(cloud.value.checkpoints.movie_550.position, 15);
  assert.equal(store.getCheckpoint('movie_550').position, 15);
});

test('an offline clear never follows a user into a different profile', async () => {
  const { store, cloud } = fixture();
  cloud.offline = true;
  await store.clearWatch();
  store.disconnect();
  cloud.offline = false;
  await store.create();
  assert.equal(cloud.requests.filter((r) => r.url.includes('watch/clear')).length, 1);
  assert.equal(store.getSnapshot().status, 'ready');
});

test('disabled watch history records neither checkpoints nor monthly viewing intervals', async () => {
  const { store, cloud } = fixture({ initial: { historyEnabled: false } });
  store.saveCheckpoint('movie_550', { item: film, position: 40, duration: 100, preferences: prefs });
  store.saveSession({ sessionId: randomUUID(), progressKey: 'movie_550', item: film, segments: [{ start: 1000, end: 5000 }] });
  await store.flush();
  assert.equal(store.getCheckpoint('movie_550'), null);
  assert.deepEqual(store.getData().sessions, {});
  assert.equal(cloud.requests.length, 0);
});
