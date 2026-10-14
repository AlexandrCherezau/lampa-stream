import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createViewingProfileStore } from '../src/utils/viewingProfile.js';

const endpoint = process.env.PROFILE_TEST_URL;
function device(name) {
  const disk = new Map();
  let catalogueToken = '';
  const localQaIp = `2001:db8:${randomUUID()}`;
  const store = createViewingProfileStore({ endpoint, events: null, uuid: randomUUID, deviceName: () => name,
    timers: { setTimeout: (...args) => { const timer = setTimeout(...args); timer.unref?.(); return timer; }, clearTimeout, setInterval, clearInterval },
    fetchImpl: async (url, options) => {
      const started = Date.now();
      const requested = options.body ? JSON.parse(options.body).checkpoints?.map((value) => ({ position: value.position, baseRevision: value.baseRevision, clientSeq: value.clientSeq })) : undefined;
      try {
        const result = await fetch(url, { ...options, headers: { ...options.headers, ...(['localhost', '127.0.0.1'].includes(new URL(endpoint).hostname) ? { 'x-real-ip': localQaIp } : {}) } });
        if (process.env.PROFILE_TEST_TRACE === '1' && requested?.length) {
          const body = await result.clone().json();
          console.log('Profile QA PATCH', JSON.stringify({ device: name, status: result.status, elapsedMs: Date.now() - started, requested, saved: Object.values(body.snapshot?.checkpoints || {}).map((value) => ({ position: value.position, revision: value.revision, clientSeq: value.clientSeq })), error: body.error }));
        }
        return result;
      } catch (failure) {
        if (process.env.PROFILE_TEST_TRACE === '1' && requested?.length) console.log('Profile QA PATCH', JSON.stringify({ device: name, elapsedMs: Date.now() - started, requested, error: failure.name }));
        throw failure;
      }
    },
    read: (key) => structuredClone(disk.get(key) ?? null), write: (key, value) => disk.set(key, structuredClone(value)), remove: (key) => disk.delete(key),
    secure: { get: async () => catalogueToken, set: async (_, value) => { catalogueToken = value; } } });
  return { store, token: () => catalogueToken, disk };
}

test('two independent clients pair through real HTTP storage and transfer exact film/episode preferences', { skip: !endpoint }, async () => {
  const desktop = device('QA desktop'), phone = device('QA phone');
  await desktop.store.create({ displayName: 'QA cinema', tmdbToken: 'catalogue-fixture-not-a-real-key' });
  const pair = await desktop.store.beginPairing();
  const request = await phone.store.claimPairing({ shortCode: pair.shortCode });
  assert.equal((await phone.store.pollPairing(request)).status, 'pending');
  await desktop.store.refresh();
  assert.ok(desktop.store.getSnapshot().pairings.some((value) => value.requestId === request.requestId));
  await desktop.store.approvePairing(request.requestId);
  assert.equal((await phone.store.pollPairing(request)).status, 'approved');
  assert.equal(phone.token(), 'catalogue-fixture-not-a-real-key');
  const genres = [{ id: 53, name: 'Триллер' }];
  const preferences = { providerId: 'habster:alloha', voiceId: 'alloha:52', voiceName: 'Русский дубляж', subtitle: { enabled: true, kind: 'external', name: 'Русский', lang: 'ru' }, audio: { name: 'Русский', lang: 'ru' } };
  desktop.store.saveCheckpoint('movie_550', { item: { type: 'movie', id: 550, title: 'QA фильм', genres }, position: 1234.567, duration: 6000, preferences });
  desktop.store.saveCheckpoint('tv_1399_s1e2', { item: { type: 'tv', id: 1399, title: 'QA серия', season: 1, episode: 2, genres }, position: 456.789, duration: 3000, preferences: { ...preferences, subtitle: { enabled: false } } });
  desktop.store.rate({ type: 'movie', id: 550, title: 'QA фильм', genres }, 9);
  const sessionId = randomUUID();
  desktop.store.saveSession({ sessionId, progressKey: 'movie_550', item: { type: 'movie', id: 550, title: 'QA фильм', genres }, segments: [{ start: Date.now() - 10000, end: Date.now() }], completedAt: Date.now() });
  await desktop.store.flush();
  assert.equal(desktop.store.getSnapshot().status, 'ready');
  await phone.store.wait();
  assert.equal(phone.store.getCheckpoint('movie_550').position, 1234.567);
  assert.deepEqual(phone.store.getCheckpoint('movie_550').preferences, preferences);
  assert.equal(phone.store.getCheckpoint('tv_1399_s1e2').position, 456.789);
  assert.deepEqual(phone.store.getCheckpoint('tv_1399_s1e2').preferences.subtitle, { enabled: false });
  assert.equal(phone.store.getRating({ type: 'movie', id: 550 }).score, 9);
  assert.equal(phone.store.getData().sessions[sessionId].segments.length, 1);
  phone.store.saveCheckpoint('movie_550', { ...phone.store.getCheckpoint('movie_550'), position: 400 });
  await phone.store.flush();
  await desktop.store.refresh();
  assert.equal(desktop.store.getCheckpoint('movie_550').position, 400);
  await desktop.store.clearWatch();
  await phone.store.refresh();
  assert.equal(phone.store.getCheckpoint('movie_550'), null);
  assert.deepEqual(phone.disk.get('resumeTime'), {});
  assert.deepEqual(phone.store.getData().sessions, {});
  assert.equal(phone.store.getRating({ type: 'movie', id: 550 }).score, 9);
  await desktop.store.revokeDevice(phone.store.getSnapshot().deviceId);
  await phone.store.refresh();
  assert.equal(phone.store.getSnapshot().status, 'error');
});
