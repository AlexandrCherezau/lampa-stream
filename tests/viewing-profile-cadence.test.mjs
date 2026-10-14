import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createViewingProfileStore } from '../src/utils/viewingProfile.js';
import { mergeProfileSnapshot, validateCheckpoint, validateSession, validateLibrary } from '../api/_lib/_profile.mjs';

const film = { type: 'movie', id: 550, title: 'Film' };
const policy = { backgroundFlushMs: 300000, pollIntervalMs: 120000 };
const response = (value) => ({ ok: true, status: 200, json: async () => structuredClone(value) });
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
function fixture() {
  let time = 1000000, nextTimer = 0;
  const jobs = new Map(), listeners = new Map();
  const disk = { viewingProfileAuth: { credential: 'qa', profileId: 'qa', deviceId: 'desktop' } };
  const cloud = { value: { revision: 0, checkpoints: {}, sessions: {}, library: { saved: {}, history: {}, watched: {}, ratings: {} }, devices: {}, pendingPairings: {}, syncPolicy: policy }, requests: [], offline: false, intercept: null, receipts: new Set() };
  const timers = {
    setTimeout: (fn, delay) => { const id = ++nextTimer; jobs.set(id, { fn, due: time + delay }); return id; },
    clearTimeout: (id) => jobs.delete(id),
    setInterval: (fn, delay) => { const id = ++nextTimer; jobs.set(id, { fn, due: time + delay, interval: delay }); return id; },
    clearInterval: (id) => jobs.delete(id),
  };
  const events = { addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: (name) => listeners.delete(name), dispatchEvent: () => {} };
  const merge = (body) => {
    if (!cloud.receipts.has(body.mutationId)) {
      cloud.receipts.add(body.mutationId);
      cloud.value = { ...mergeProfileSnapshot(cloud.value, { mutationId: body.mutationId, supersedesMutationIds: body.supersedesMutationIds, checkpoints: body.checkpoints.map(validateCheckpoint), sessions: body.sessions.map(validateSession), library: validateLibrary(body.library) }, { deviceId: body.deviceId, now: time }), syncPolicy: policy };
    }
    return response({ snapshot: cloud.value });
  };
  const options = { read: (key) => structuredClone(disk[key] ?? null), write: (key, value) => { disk[key] = structuredClone(value); }, remove: (key) => { delete disk[key]; }, now: () => time, timers, events, uuid: randomUUID, fetchImpl: async (url, options) => {
    const body = options.body && JSON.parse(options.body), request = { url, ...options, body };
    cloud.requests.push(request);
    if (cloud.offline) throw new Error('offline');
    if (cloud.intercept) { const result = cloud.intercept(request); if (result) return await result; }
    if (options.method === 'PATCH') return merge(body);
    if (url.includes('watch/clear')) {
      cloud.value = { ...cloud.value, revision: cloud.value.revision + 1, watchResetRevision: cloud.value.revision + 1, watchClearedAt: body.clearedAt, checkpoints: {}, sessions: {}, library: { ...cloud.value.library, history: {}, watched: {} } };
      return response({ snapshot: cloud.value });
    }
    if (url.includes('pair/create')) return response({ expiresAt: time + 60000 });
    return response(cloud.value);
  } };
  const advance = async (ms) => {
    const target = time + ms;
    while (true) {
      const entry = [...jobs.entries()].filter(([, job]) => job.due <= target).sort((a, b) => a[1].due - b[1].due)[0];
      if (!entry) break;
      const [id, job] = entry;
      time = job.due;
      if (job.interval) job.due += job.interval; else jobs.delete(id);
      job.fn(); await settle();
    }
    time = target; await settle();
  };
  const store = createViewingProfileStore(options);
  const checkpoint = (position, preferences = {}, extra) => store.saveCheckpoint('movie_550', { item: film, position, duration: 1000, preferences }, extra);
  return { store, cloud, disk, checkpoint, advance, merge, events: (name, detail) => listeners.get(name)?.({ type: name, detail }), reload: () => createViewingProfileStore(options), patches: () => cloud.requests.filter((r) => r.method === 'PATCH') };
}

test('100 local checkpoints coalesce into one Blob PATCH at the persisted deadline despite background GETs', async () => {
  const f = fixture();
  const stop = f.store.start(); await settle();
  for (let i = 1; i <= 100; i++) {
    f.checkpoint(i);
    if (i < 100) await f.advance(2000);
  }
  assert.equal(f.patches().length, 0);
  assert.equal(f.store.getCheckpoint('movie_550').position, 100);
  assert.equal(f.cloud.requests.filter((r) => r.method === 'GET').length, 2);
  await f.advance(101999);
  assert.equal(f.patches().length, 0);
  await f.advance(1);
  assert.equal(f.patches().length, 1);
  assert.equal(f.patches()[0].body.checkpoints[0].position, 100);
  stop();
});

test('semantic preferences and explicit pause flush promptly; unchanged preference heartbeats stay queued', async () => {
  const f = fixture(); await f.store.refresh();
  f.checkpoint(10, { voiceId: 'voice-a', subtitle: { enabled: false } }); await settle();
  assert.equal(f.patches().length, 1);
  for (let i = 11; i < 50; i++) f.checkpoint(i, { subtitle: { enabled: false }, voiceId: 'voice-a', url: 'ignored' });
  await settle(); assert.equal(f.patches().length, 1);
  f.checkpoint(50, { voiceId: 'voice-b', subtitle: { enabled: true, lang: 'en' } }); await settle();
  assert.equal(f.patches().length, 2);
  f.checkpoint(51, { voiceId: 'voice-b', subtitle: { enabled: true, lang: 'en' } }, { flush: true }); await settle();
  assert.equal(f.patches().length, 3);
  assert.equal(f.patches()[2].keepalive, true);
});

test('failed outbox and deadline survive reload without heartbeat retry floods; session intervals remain a union', async () => {
  const f = fixture(); const stopOriginal = f.store.start(); await settle();
  const id = randomUUID();
  f.store.saveSession({ sessionId: id, progressKey: 'movie_550', item: film, segments: [{ start: 1000, end: 5000 }] });
  f.checkpoint(25); f.cloud.offline = true;
  await f.advance(300000);
  assert.equal(f.patches().length, 1);
  const mutationId = f.disk.viewingData.batch.payload.mutationId;
  stopOriginal();
  const reopened = f.reload(); const stop = reopened.start(); await settle();
  for (let i = 0; i < 50; i++) {
    reopened.saveSession({ sessionId: id, progressKey: 'movie_550', item: film, segments: [{ start: 4000, end: 8000 }] });
    await f.advance(1200);
  }
  assert.equal(f.patches().length, 1);
  f.cloud.offline = false;
  await f.advance(240000);
  assert.equal(f.patches()[1].body.mutationId, mutationId);
  await f.advance(300000);
  assert.deepEqual(f.cloud.value.sessions[id].segments, [{ start: 1000, end: 8000 }]);
  stop();
});

test('background refresh preserves deadline but wait resolves stale offline queue authoritatively', async () => {
  const f = fixture(); await f.store.refresh(); f.checkpoint(20);
  f.cloud.value = { ...mergeProfileSnapshot(f.cloud.value, { checkpoints: [{ progressKey: 'movie_550', item: film, position: 99, duration: 1000, preferences: {}, baseRevision: 0 }] }, { deviceId: 'phone', now: 10 }), syncPolicy: policy };
  await f.store.refresh({ background: true });
  assert.equal(f.patches().length, 0);
  assert.equal(f.store.getCheckpoint('movie_550').position, 20);
  await f.store.wait();
  assert.equal(f.patches().length, 1);
  assert.equal(f.store.getCheckpoint('movie_550').position, 99);
});

test('owner pairing polls at 15s until deadline, then returns to 120s; focus refreshes immediately', async () => {
  const f = fixture(); const stop = f.store.start(); await settle();
  await f.store.beginPairing(); await f.advance(45000);
  assert.equal(f.cloud.requests.filter((r) => r.method === 'GET').length, 4);
  await f.advance(120000);
  assert.equal(f.cloud.requests.filter((r) => r.method === 'GET').length, 5);
  f.events('focus'); await settle();
  assert.equal(f.cloud.requests.filter((r) => r.method === 'GET').length, 6);
  stop();
});

test('pagehide sends the latest distinct keepalive batch before old background response and preserves session union', async () => {
  const f = fixture(); const stop = f.store.start(); await settle();
  let release;
  f.cloud.intercept = (request) => request.method === 'PATCH' && !request.keepalive ? new Promise((resolve) => { release = () => resolve(f.merge(request.body)); }) : null;
  const id = randomUUID();
  f.checkpoint(10); f.store.saveSession({ sessionId: id, progressKey: 'movie_550', item: film, segments: [{ start: 1000, end: 5000 }] });
  await f.advance(300000);
  assert.equal(f.patches().length, 1);
  f.checkpoint(34.567); f.store.saveSession({ sessionId: id, progressKey: 'movie_550', item: film, segments: [{ start: 4000, end: 9000 }] });
  f.events('pagehide'); await settle();
  assert.equal(f.patches().length, 2);
  assert.equal(f.patches()[1].keepalive, true);
  assert.notEqual(f.patches()[1].body.mutationId, f.patches()[0].body.mutationId);
  assert.equal(f.cloud.value.checkpoints.movie_550.position, 34.567);
  release(); await settle();
  assert.equal(f.store.getCheckpoint('movie_550').position, 34.567);
  assert.deepEqual(f.cloud.value.sessions[id].segments, [{ start: 1000, end: 9000 }]);
  assert.deepEqual(f.disk.viewingData.queue.checkpoints, {});
  stop();
});

test('three urgent generations supersede committed predecessors and older responses cannot overwrite the latest pause', async () => {
  const f = fixture(); const stop = f.store.start(); await settle();
  const held = [];
  f.cloud.intercept = (request) => {
    if (request.method !== 'PATCH' || held.length >= 2) return null;
    const accepted = f.merge(request.body);
    return new Promise((resolve, reject) => held.push({ resolve: () => resolve(accepted), reject }));
  };
  const id = randomUUID();
  f.checkpoint(10); f.store.saveSession({ sessionId: id, progressKey: 'movie_550', item: film, segments: [{ start: 1000, end: 5000 }] });
  await f.advance(300000);
  f.checkpoint(20); f.store.saveSession({ sessionId: id, progressKey: 'movie_550', item: film, segments: [{ start: 4000, end: 9000 }] });
  void f.store.flush({ keepalive: true }); await settle();
  f.checkpoint(30.789); f.store.saveSession({ sessionId: id, progressKey: 'movie_550', item: film, segments: [{ start: 8000, end: 12000 }] });
  void f.store.flush({ keepalive: true }); await settle();
  assert.equal(f.patches().length, 3);
  assert.deepEqual(f.patches()[2].body.supersedesMutationIds.sort(), f.patches().slice(0, 2).map((r) => r.body.mutationId).sort());
  assert.deepEqual(f.patches().map((r) => r.body.checkpoints[0].clientSeq), [1, 2, 3]);
  assert.equal(f.cloud.value.checkpoints.movie_550.position, 30.789);
  held[1].resolve(); await settle();
  assert.equal(f.store.getCheckpoint('movie_550').position, 30.789);
  held[0].reject(new Error('lost reply')); await settle();
  assert.equal(f.store.getCheckpoint('movie_550').position, 30.789);
  assert.equal(f.store.getSnapshot().status, 'ready');
  assert.deepEqual(f.cloud.value.sessions[id].segments, [{ start: 1000, end: 12000 }]);
  assert.deepEqual(f.disk.viewingData.queue.checkpoints, {});
  assert.equal(Object.keys(f.disk.viewingData.outbox).length, 1);
  f.cloud.intercept = null;
  await f.advance(300000);
  assert.equal(Object.keys(f.disk.viewingData.outbox).length, 0);
  assert.equal(f.cloud.value.checkpoints.movie_550.position, 30.789);
  stop();
});

test('lost response outbox survives reload and a new pause dispatches the latest snapshot before retrying the old mutation', async () => {
  const f = fixture(); const stop = f.store.start(); await settle();
  f.cloud.intercept = (request) => {
    if (request.method !== 'PATCH') return null;
    f.merge(request.body); return Promise.reject(new Error('response lost'));
  };
  f.checkpoint(10); await f.advance(300000);
  const oldId = f.patches()[0].body.mutationId;
  stop(); f.cloud.intercept = null;
  const reopened = f.reload();
  reopened.saveCheckpoint('movie_550', { item: film, position: 43.21, duration: 1000, preferences: {} }, { flush: true });
  assert.equal(f.patches().length, 2);
  assert.notEqual(f.patches()[1].body.mutationId, oldId);
  assert.deepEqual(f.patches()[1].body.supersedesMutationIds, [oldId]);
  assert.equal(f.patches()[1].body.checkpoints[0].clientSeq, 2);
  await settle();
  assert.equal(f.cloud.value.checkpoints.movie_550.position, 43.21);
  assert.equal(reopened.getCheckpoint('movie_550').position, 43.21);
  assert.equal(f.patches().at(-1).body.mutationId, oldId);
  assert.equal(Object.keys(f.disk.viewingData.outbox).length, 0);
});

test('completed sessions, ratings and library changes bypass the Blob heartbeat deadline', async () => {
  const f = fixture(); const stop = f.store.start(); await settle();
  f.store.saveSession({ sessionId: randomUUID(), progressKey: 'movie_550', item: film, segments: [{ start: 1000, end: 5000 }], completedAt: 5000 });
  await settle(); assert.equal(f.patches().length, 1);
  f.store.rate(film, 8); await settle(); assert.equal(f.patches().length, 2);
  f.disk.saved = { movie_550: film };
  f.events('streambert:storage-write', { key: 'saved', value: f.disk.saved });
  await settle(); assert.equal(f.patches().length, 3);
  assert.equal(f.cloud.value.library.saved.movie_550.value.title, film.title);
  stop();
});

test('latest urgent snapshot can supersede one committed predecessor while another predecessor is still missing', async () => {
  const f = fixture(); const stop = f.store.start(); await settle();
  let releaseOld, releaseMiddle;
  f.cloud.intercept = (request) => {
    if (request.method !== 'PATCH') return null;
    if (!releaseOld) {
      const accepted = f.merge(request.body);
      return new Promise((resolve) => { releaseOld = () => resolve(accepted); });
    }
    if (!releaseMiddle) return new Promise((resolve) => { releaseMiddle = () => resolve(f.merge(request.body)); });
    return null;
  };
  f.checkpoint(10); await f.advance(300000);
  f.checkpoint(20); void f.store.flush({ keepalive: true }); await settle();
  f.checkpoint(55.321); void f.store.flush({ keepalive: true }); await settle();
  assert.equal(f.patches().length, 3);
  assert.equal(f.cloud.value.checkpoints.movie_550.position, 55.321);
  releaseMiddle(); await settle(); releaseOld(); await settle();
  assert.equal(f.cloud.value.checkpoints.movie_550.position, 55.321);
  assert.equal(f.store.getCheckpoint('movie_550').position, 55.321);
  assert.equal(Object.keys(f.disk.viewingData.outbox).length, 0);
  stop();
});

test('an older receipt removes its stale queue overlay without reverting a newer other-device GET', async () => {
  const f = fixture(); const stop = f.store.start(); await settle();
  let release;
  f.cloud.intercept = (request) => {
    if (request.method !== 'PATCH') return null;
    const accepted = f.merge(request.body);
    return new Promise((resolve) => { release = () => resolve(accepted); });
  };
  f.checkpoint(10); await f.advance(300000);
  f.cloud.value = { ...mergeProfileSnapshot(f.cloud.value, { checkpoints: [{ progressKey: 'movie_550', item: film, position: 90, duration: 1000, preferences: {}, baseRevision: f.cloud.value.revision, clientSeq: 1 }] }, { deviceId: 'phone', now: 12 }), syncPolicy: policy };
  await f.store.refresh({ background: true });
  assert.equal(f.store.getCheckpoint('movie_550').position, 10);
  release(); await settle();
  assert.equal(f.store.getCheckpoint('movie_550').position, 90);
  assert.deepEqual(f.disk.viewingData.queue.checkpoints, {});
  stop();
});

test('pairing claim nonce survives a lost response and reload without persisting offer credentials', async () => {
  const f = fixture();
  f.cloud.intercept = (request) => request.url.includes('pair/claim') ? Promise.reject(new Error('lost claim response')) : null;
  const offer = { requestToken: 'private-offer-token-qa' };
  await assert.rejects(f.store.claimPairing(offer));
  const first = f.cloud.requests.at(-1).body.claimId;
  assert.match(first, /^[a-f0-9-]{36}$/);
  assert.equal(JSON.stringify(f.disk).includes(offer.requestToken), false);
  const reopened = f.reload();
  await assert.rejects(reopened.claimPairing(offer));
  assert.equal(f.cloud.requests.at(-1).body.claimId, first);
  const secondBrowser = fixture();
  await secondBrowser.store.claimPairing(offer);
  assert.notEqual(secondBrowser.cloud.requests.at(-1).body.claimId, first);
  await assert.rejects(reopened.claimPairing({ requestToken: 'different-private-offer' }));
  assert.notEqual(f.cloud.requests.at(-1).body.claimId, first);
});

test('wait drains a newer stale queue even when joining an already in-flight background batch', async () => {
  const f = fixture(); const stop = f.store.start(); await settle();
  let release;
  f.cloud.intercept = (request) => {
    if (request.method !== 'PATCH' || release) return null;
    const accepted = f.merge(request.body);
    return new Promise((resolve) => { release = () => resolve(accepted); });
  };
  f.checkpoint(10); await f.advance(300000); f.checkpoint(20);
  f.cloud.value = { ...mergeProfileSnapshot(f.cloud.value, { checkpoints: [{ progressKey: 'movie_550', item: film, position: 90, duration: 1000, preferences: {}, baseRevision: f.cloud.value.revision, clientSeq: 1 }] }, { deviceId: 'phone', now: 12 }), syncPolicy: policy };
  const waiting = f.store.wait(); await settle();
  release(); await waiting;
  assert.equal(f.patches().length, 2);
  assert.equal(f.store.getCheckpoint('movie_550').position, 90);
  assert.deepEqual(f.disk.viewingData.queue.checkpoints, {});
  stop();
});

for (const clear of ['remote', 'local']) {
  for (const bucket of ['ratings', 'saved']) {
    test(`${clear} watch clear preserves ${bucket} supersession after a mixed watch/library reply is lost`, async () => {
      const f = fixture(); const stop = f.store.start(); await settle();
      const id = randomUUID();
      f.checkpoint(25);
      f.store.saveSession({ sessionId: id, progressKey: 'movie_550', item: film, segments: [{ start: 1000, end: 5000 }] });
      f.cloud.intercept = (request) => {
        if (request.method !== 'PATCH') return null;
        f.merge(request.body);
        return Promise.reject(new Error('accepted reply lost'));
      };
      if (bucket === 'ratings') f.store.rate(film, 8);
      else {
        f.disk.saved = { movie_550: film };
        f.events('streambert:storage-write', { key: 'saved', value: f.disk.saved });
      }
      await settle();
      const oldId = f.patches()[0].body.mutationId;
      assert.equal(Object.keys(f.disk.viewingData.outbox).length, 1);
      f.cloud.intercept = null;
      if (clear === 'remote') {
        f.cloud.value = { ...f.cloud.value, revision: f.cloud.value.revision + 1, watchResetRevision: f.cloud.value.revision + 1, watchClearedAt: 1000000, checkpoints: {}, sessions: {}, library: { ...f.cloud.value.library, history: {}, watched: {} } };
        await f.store.refresh({ background: true });
      } else {
        f.cloud.offline = true;
        await f.store.clearWatch();
        assert.equal(f.disk.viewingData.retainedMutationIds.includes(oldId), true);
        f.cloud.offline = false;
      }
      assert.equal(Object.keys(f.disk.viewingData.outbox).length, 0);
      assert.equal(f.disk.viewingData.retainedMutationIds.includes(oldId), true);
      stop();
      const reopened = f.reload();
      const stopReloaded = reopened.start(); await settle();
      if (bucket === 'ratings') reopened.rate(film, 9);
      else {
        f.disk.saved = {};
        f.events('streambert:storage-write', { key: 'saved', value: {} });
      }
      await settle();
      const latest = f.patches().at(-1);
      assert.equal(latest.body.supersedesMutationIds.includes(oldId), true);
      assert.deepEqual(latest.body.checkpoints, []);
      assert.deepEqual(latest.body.sessions, []);
      if (bucket === 'ratings') {
        assert.equal(f.cloud.value.library.ratings.movie_550.value.score, 9);
        assert.equal(reopened.getRating(film).score, 9);
      } else assert.equal(f.cloud.value.library.saved.movie_550.deleted, true);
      assert.deepEqual(f.cloud.value.checkpoints, {});
      assert.deepEqual(f.cloud.value.sessions, {});
      assert.deepEqual(f.disk.viewingData.retainedMutationIds, []);
      stopReloaded();
    });
  }
}

const largeFilm = (id) => ({ type: 'movie', id, title: 'Ж'.repeat(240), genres: Array.from({ length: 16 }, (_, index) => ({ id: index + 1, name: 'Ж'.repeat(60) })) });
const bytes = (request) => new TextEncoder().encode(JSON.stringify(request.body)).byteLength;

test('Cyrillic title and genre metadata batches fit UTF-8 limits and every overflow record remains syncable', async () => {
  const f = fixture(); const stop = f.store.start(); await settle();
  for (let id = 1; id <= 30; id++) f.store.saveCheckpoint(`movie_${id}`, { item: largeFilm(id), position: id, duration: 1000, preferences: {} });
  await f.store.flush();
  assert.ok(f.patches().length > 1);
  assert.equal(Object.keys(f.cloud.value.checkpoints).length, 30);
  assert.deepEqual(f.disk.viewingData.queue.checkpoints, {});
  for (const request of f.patches()) assert.ok(bytes(request) <= 28 * 1024, `UTF-8 body was ${bytes(request)} bytes`);
  stop();
});

test('alive priorities use normal urgent fetch and held pauses leave aggregate keepalive room for the latest closing checkpoint', async () => {
  const f = fixture(); const stop = f.store.start(); await settle();
  const held = [];
  let activeBytes = 0, maxActiveBytes = 0;
  f.cloud.intercept = (request) => {
    if (request.method !== 'PATCH') return null;
    const accepted = f.merge(request.body);
    if (request.keepalive) { activeBytes += bytes(request); maxActiveBytes = Math.max(maxActiveBytes, activeBytes); }
    return new Promise((resolve) => held.push(() => { if (request.keepalive) activeBytes -= bytes(request); resolve(accepted); }));
  };
  for (let id = 1; id <= 30; id++) f.store.saveCheckpoint(`movie_${id}`, { item: largeFilm(id), position: id, duration: 1000, preferences: {} });
  f.store.saveCheckpoint('movie_31', { item: largeFilm(31), position: 31, duration: 1000, preferences: { voiceId: 'alive-priority' } });
  await settle();
  assert.equal(f.patches()[0].keepalive, false);
  f.store.rate(largeFilm(32), 8); await settle();
  assert.equal(f.patches()[1].keepalive, false);
  for (let i = 0; i < 5; i++) {
    f.store.saveCheckpoint('movie_31', { item: largeFilm(31), position: 40 + i, duration: 1000, preferences: { voiceId: 'alive-priority' } }, { flush: true });
    await settle();
    assert.ok(activeBytes <= 40 * 1024);
  }
  f.store.saveCheckpoint('movie_31', { item: largeFilm(31), position: 99.987, duration: 1000, preferences: { voiceId: 'alive-priority' } });
  f.events('pagehide'); await settle();
  const closing = f.patches().at(-1);
  assert.equal(closing.keepalive, true);
  assert.equal(closing.body.checkpoints[0].progressKey, 'movie_31');
  assert.equal(closing.body.checkpoints[0].position, 99.987);
  assert.ok(maxActiveBytes <= 60 * 1024);
  for (const request of f.patches()) assert.ok(bytes(request) <= 28 * 1024);
  f.cloud.intercept = null;
  while (held.length) { held.shift()(); await settle(); }
  await f.store.flush();
  assert.equal(Object.keys(f.cloud.value.checkpoints).length, 31);
  assert.equal(f.cloud.value.checkpoints.movie_31.position, 99.987);
  assert.deepEqual(f.disk.viewingData.queue.checkpoints, {});
  stop();
});

test('legacy oversized persisted batches are replaced by small packets while retaining their receipt ancestry', async () => {
  const f = fixture(); const stop = f.store.start(); await settle();
  for (let id = 1; id <= 30; id++) f.store.saveCheckpoint(`movie_${id}`, { item: largeFilm(id), position: id, duration: 1000, preferences: {} });
  stop();
  const payload = { mutationId: randomUUID(), deviceId: 'desktop', checkpoints: Object.values(f.disk.viewingData.queue.checkpoints).map((record) => record.value), sessions: [], library: {} };
  const legacy = { payload, entries: structuredClone(f.disk.viewingData.queue) };
  assert.ok(bytes({ body: payload }) > 64 * 1024);
  f.disk.viewingData.batch = legacy;
  f.disk.viewingData.outbox = { [payload.mutationId]: legacy };
  f.merge(payload);
  const reopened = f.reload();
  reopened.saveCheckpoint('movie_30', { item: largeFilm(30), position: 456.789, duration: 1000, preferences: {} }, { flush: true });
  await settle(); await reopened.flush();
  for (const request of f.patches()) assert.ok(bytes(request) <= 28 * 1024);
  assert.equal(f.patches()[0].body.supersedesMutationIds.includes(payload.mutationId), true);
  assert.equal(f.cloud.value.checkpoints.movie_30.position, 456.789);
  assert.equal(Object.keys(f.cloud.value.checkpoints).length, 30);
  assert.deepEqual(f.disk.viewingData.queue.checkpoints, {});
  assert.deepEqual(f.disk.viewingData.outbox, {});
});

test('three real player pause calls preserve keepalive reserve for the subsequent exact pagehide position', async () => {
  const f = fixture(); const stop = f.store.start(); await settle();
  const held = [];
  let activeBytes = 0, maxActiveBytes = 0;
  f.cloud.intercept = (request) => {
    if (request.method !== 'PATCH') return null;
    const accepted = f.merge(request.body);
    if (request.keepalive) { activeBytes += bytes(request); maxActiveBytes = Math.max(maxActiveBytes, activeBytes); }
    return new Promise((resolve) => held.push(() => { if (request.keepalive) activeBytes -= bytes(request); resolve(accepted); }));
  };
  for (let id = 1; id <= 30; id++) f.store.saveCheckpoint(`movie_${id}`, { item: largeFilm(id), position: id, duration: 1000, preferences: {} });
  for (let i = 0; i < 3; i++) {
    f.store.saveCheckpoint('movie_30', { item: largeFilm(30), position: 40 + i, duration: 1000, preferences: {} });
    void f.store.flush({ keepalive: true, priority: true });
    await settle();
    assert.equal(f.patches().length, i + 1);
    assert.equal(f.patches().at(-1).body.checkpoints[0].position, 40 + i);
    assert.ok(activeBytes <= 40 * 1024);
  }
  assert.equal(f.patches()[0].keepalive, true);
  f.store.saveCheckpoint('movie_30', { item: largeFilm(30), position: 99.987, duration: 1000, preferences: {} });
  f.events('pagehide'); await settle();
  assert.equal(f.patches().length, 4);
  const closing = f.patches()[3];
  assert.equal(closing.keepalive, true);
  assert.equal(closing.body.checkpoints[0].progressKey, 'movie_30');
  assert.equal(closing.body.checkpoints[0].position, 99.987);
  assert.ok(maxActiveBytes <= 60 * 1024);
  for (const request of f.patches()) assert.ok(bytes(request) <= 28 * 1024);
  f.cloud.intercept = null;
  while (held.length) { held.shift()(); await settle(); }
  await f.store.flush();
  assert.equal(f.cloud.value.checkpoints.movie_30.position, 99.987);
  assert.deepEqual(f.disk.viewingData.queue.checkpoints, {});
  stop();
});

test('late player closing capture sends the exact checkpoint and current session together before a single pagehide flush', async () => {
  const f = fixture(); const stop = f.store.start(); await settle();
  const held = [];
  let activeBytes = 0, maxActiveBytes = 0;
  f.cloud.intercept = (request) => {
    if (request.method !== 'PATCH') return null;
    const accepted = f.merge(request.body);
    if (request.keepalive) { activeBytes += bytes(request); maxActiveBytes = Math.max(maxActiveBytes, activeBytes); }
    return new Promise((resolve) => held.push(() => { if (request.keepalive) activeBytes -= bytes(request); resolve(accepted); }));
  };
  for (let id = 1; id <= 30; id++) f.store.saveCheckpoint(`movie_${id}`, { item: largeFilm(id), position: id, duration: 1000, preferences: {} });
  for (let i = 0; i < 3; i++) {
    f.store.saveCheckpoint('movie_30', { item: largeFilm(30), position: 40 + i, duration: 1000, preferences: {} });
    void f.store.flush({ keepalive: true, priority: true });
    await settle();
  }
  const sessionId = randomUUID();
  let position = 88.125;
  const unregister = f.store.registerClosingCapture(() => {
    f.store.saveCheckpoint('movie_30', { item: largeFilm(30), position, duration: 1000, preferences: {} });
    f.store.saveSession({ sessionId, progressKey: 'movie_30', item: largeFilm(30), segments: [{ start: 999000, end: 1000000 }], completedAt: 1000000 }, { flush: true });
  });
  f.events('visibilitychange'); await settle();
  assert.ok(activeBytes <= 40 * 1024);
  position = 99.987;
  const previousRequests = f.patches().length;
  f.events('pagehide'); await settle();
  assert.equal(f.patches().length, previousRequests + 1);
  const closing = f.patches().at(-1);
  assert.equal(closing.keepalive, true);
  assert.equal(closing.body.checkpoints[0].position, 99.987);
  assert.equal(closing.body.sessions[0].sessionId, sessionId);
  assert.equal(closing.body.sessions[0].completedAt, 1000000);
  assert.ok(maxActiveBytes <= 60 * 1024);
  unregister();
  f.cloud.intercept = null;
  while (held.length) { held.shift()(); await settle(); }
  await f.store.flush();
  assert.equal(f.cloud.value.checkpoints.movie_30.position, 99.987);
  assert.equal(f.cloud.value.sessions[sessionId].segments.length, 1);
  const sequence = f.disk.viewingData.clientSequences.movie_30;
  f.events('pagehide'); await settle();
  assert.equal(f.disk.viewingData.clientSequences.movie_30, sequence);
  stop();
});

test('closing sends the latest checkpoint first when old failed outboxes survive a newer successful pause', async () => {
  const f = fixture(); const stop = f.store.start(); await settle();
  const held = [];
  f.cloud.intercept = (request) => {
    if (request.method !== 'PATCH') return null;
    return new Promise((resolve, reject) => held.push({ resolve, reject, accepted: f.merge(request.body) }));
  };
  for (const position of [40, 41, 42]) {
    f.checkpoint(position);
    void f.store.flush({ keepalive: true, priority: true });
    await settle();
  }
  held[2].resolve(held[2].accepted); await settle();
  held[0].reject(new Error('lost old response')); held[1].reject(new Error('lost old response')); await settle();
  assert.equal(f.disk.viewingData.batch, undefined);
  assert.equal(Object.keys(f.disk.viewingData.outbox).length, 2);
  const unregister = f.store.registerClosingCapture(() => f.checkpoint(99.987));
  f.events('pagehide'); await settle();
  const closing = f.patches().at(-1);
  assert.equal(closing.keepalive, true);
  assert.equal(closing.body.checkpoints[0].position, 99.987);
  for (const old of f.patches().slice(0, 2)) assert.ok(closing.body.supersedesMutationIds.includes(old.body.mutationId));
  held[3].resolve(held[3].accepted); await settle();
  f.cloud.intercept = null;
  for (const waiting of held.slice(4)) { waiting.resolve(waiting.accepted); await settle(); }
  await f.store.flush();
  assert.equal(f.cloud.value.checkpoints.movie_550.position, 99.987);
  assert.deepEqual(f.disk.viewingData.queue.checkpoints, {});
  unregister(); stop();
});

test('default browser interval wrappers preserve the native global receiver', () => {
  const originalSet = globalThis.setInterval, originalClear = globalThis.clearInterval;
  let started = false, cleared = false;
  globalThis.setInterval = function (...args) {
    assert.equal(this, globalThis);
    started = true;
    return originalSet.apply(globalThis, args);
  };
  globalThis.clearInterval = function (...args) {
    assert.equal(this, globalThis);
    cleared = true;
    return originalClear.apply(globalThis, args);
  };
  try {
    const store = createViewingProfileStore({ read: () => null, write: () => {}, remove: () => {}, events: null });
    const stop = store.start();
    stop();
    assert.equal(started, true);
    assert.equal(cleared, true);
  } finally {
    globalThis.setInterval = originalSet;
    globalThis.clearInterval = originalClear;
  }
});
