import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createProfileHandler } from "../api/_lib/_profile.mjs";

const SECRET = "c".repeat(64);

function memoryBlobStore() {
  const blobs = new Map();
  let etagSequence = 0;
  let beforePut = async () => {};
  let beforeHead = async () => {};
  return {
    blobs,
    setBeforePut(callback) { beforePut = callback || (async () => {}); },
    setBeforeHead(callback) { beforeHead = callback || (async () => {}); },
    async get(pathname, options) {
      assert.equal(options.access, "private");
      assert.equal(options.useCache, false);
      const found = blobs.get(pathname);
      if (!found) return null;
      return {
        statusCode: 200,
        stream: new Response(found.body).body,
        blob: { etag: found.etag, size: Buffer.byteLength(found.body) },
      };
    },
    async head(pathname, options) {
      assert.equal(options.access, "private");
      await beforeHead(pathname);
      const found = blobs.get(pathname);
      if (!found) throw new Error("missing blob");
      return { etag: found.etag };
    },
    async put(pathname, body, options) {
      assert.equal(options.access, "private");
      assert.equal(options.addRandomSuffix, false);
      await beforePut(pathname, options);
      const current = blobs.get(pathname);
      if (options.ifMatch) {
        if (!current || current.etag !== options.ifMatch) {
          const error = new Error("etag conflict");
          error.name = "BlobPreconditionFailedError";
          throw error;
        }
      } else if (current) {
        const error = new Error("already exists");
        error.name = "BlobAlreadyExistsError";
        throw error;
      }
      if (!options.ifMatch) assert.equal(options.allowOverwrite, false);
      const etag = `"etag-${++etagSequence}"`;
      blobs.set(pathname, { body: String(body), etag });
      return { pathname, etag };
    },
    async del(pathnames, options) {
      assert.equal(options.access, "private");
      for (const pathname of pathnames) blobs.delete(pathname);
    },
  };
}

function makeHarness(store, clock = { value: 1_800_000_000_000 }) {
  const env = { PROFILE_STORAGE_BACKEND: "blob", PROFILE_DATA_SECRET: SECRET };
  const handler = createProfileHandler({ env, blobStore: store, now: () => clock.value });
  async function call(method, url = "/api/profile", { body, credential, ip = "192.0.2.40", handler: other = handler } = {}) {
    const headers = { "x-real-ip": ip };
    if (credential) headers.authorization = `Bearer ${credential}`;
    let status = 200;
    let payload;
    const res = {
      setHeader() {},
      status(code) { status = code; return this; },
      json(value) { payload = value; return this; },
      end() { return this; },
    };
    await other({ method, url, headers, body }, res);
    return { status, body: payload };
  }
  return { call, handler, clock, newHandler: () => createProfileHandler({ env, blobStore: store, now: () => clock.value }) };
}

const movie = { type: "movie", id: "5494049", title: "Private Blob Test", year: 2026, poster_path: "/abc/poster.jpg", genres: [{ id: 18, name: "Drama" }] };
const checkpoint = (position, baseRevision) => ({ progressKey: "movie_5494049", item: movie, position, duration: 1200, preferences: { providerId: "habster", voiceName: "Studio", subtitle: { enabled: false, lang: "en" } }, baseRevision });

test("private Blob profiles persist across handlers, sync data, pair, restore lost poll responses and revoke", async () => {
  const store = memoryBlobStore();
  const first = makeHarness(store);
  const created = await first.call("POST", "/api/profile", { body: { displayName: "Alex", deviceName: "Laptop", tmdbToken: "blob-token" } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.deepEqual(created.body.snapshot.syncPolicy, { backgroundFlushMs: 300_000, pollIntervalMs: 120_000 });
  const second = first.newHandler();
  let snapshot = await first.call("GET", "/api/profile", { credential: created.body.credential, handler: second });
  assert.equal(snapshot.status, 200);
  assert.equal(snapshot.body.tmdbTokenCiphertext, undefined);
  assert.equal(JSON.stringify(snapshot.body).includes("credentialHash"), false);
  const bootstrap = await first.call("GET", "/api/profile?include=bootstrapToken", { credential: created.body.credential, handler: second });
  assert.equal(bootstrap.body.bootstrapToken, "blob-token");

  const patch = await first.call("PATCH", "/api/profile", { credential: created.body.credential, body: {
    mutationId: crypto.randomUUID(), deviceId: created.body.deviceId,
    checkpoints: [checkpoint(120, 0)],
    library: { saved: { movie_5494049: { value: movie, baseRevision: 0 } }, ratings: { movie_5494049: { value: { score: 9, ratedAt: 1_800_000_000_000, item: movie }, baseRevision: 0 } } },
  }, handler: second });
  assert.equal(patch.status, 200, JSON.stringify(patch.body));
  assert.equal(patch.body.snapshot.checkpoints.movie_5494049.position, 120);
  assert.equal(patch.body.snapshot.library.ratings.movie_5494049.value.score, 9);

  const stalePatch = await first.call("PATCH", "/api/profile", { credential: created.body.credential, body: {
    mutationId: crypto.randomUUID(), deviceId: created.body.deviceId, checkpoints: [checkpoint(10, 0)],
  }, handler: second });
  assert.equal(stalePatch.body.snapshot.checkpoints.movie_5494049.position, 120);

  const pairing = await first.call("POST", "/api/profile?op=pair/create", { credential: created.body.credential, body: { deviceName: "Phone" }, handler: second });
  assert.equal(pairing.status, 201);
  const claimId = crypto.randomUUID();
  const claimBody = { shortCode: pairing.body.shortCode, deviceName: "Phone", claimId };
  const claim = await first.call("POST", "/api/profile?op=pair/claim", { body: claimBody, handler: second });
  assert.equal(claim.status, 202);
  const claimRetry = await first.call("POST", "/api/profile?op=pair/claim", { body: claimBody, handler: first.handler });
  assert.equal(claimRetry.body.pollToken, claim.body.pollToken);
  assert.equal(claimRetry.body.requestId, claim.body.requestId);
  const differentClaim = await first.call("POST", "/api/profile?op=pair/claim", { body: { ...claimBody, claimId: crypto.randomUUID() }, handler: second });
  assert.equal(differentClaim.status, 409);
  const ownerState = await first.call("GET", "/api/profile", { credential: created.body.credential, handler: second });
  assert.equal(ownerState.body.pendingPairings[claim.body.requestId].pollTokenHash, undefined);
  assert.equal(ownerState.body.pendingPairings[claim.body.requestId].claimIdHash, undefined);
  assert.equal(JSON.stringify(ownerState.body).includes(pairing.body.requestToken), false);
  assert.equal((await first.call("POST", "/api/profile?op=pair/approve", { credential: created.body.credential, body: { requestId: claim.body.requestId }, handler: second })).status, 200);
  const credentialsBeforePendingPoll = [...store.blobs.keys()].filter((path) => path.includes("/credentials/")).length;
  assert.equal((await first.call("POST", "/api/profile?op=pair/poll", { body: { requestId: claim.body.requestId, pollToken: "x".repeat(48) }, handler: second })).status, 401);
  assert.equal([...store.blobs.keys()].filter((path) => path.includes("/credentials/")).length, credentialsBeforePendingPoll);
  const issued = await first.call("POST", "/api/profile?op=pair/poll", { body: { requestId: claim.body.requestId, pollToken: claim.body.pollToken }, handler: second });
  assert.equal(issued.status, 200, JSON.stringify(issued.body));
  const retryAfterLostResponse = await first.call("POST", "/api/profile?op=pair/poll", { body: { requestId: claim.body.requestId, pollToken: claim.body.pollToken }, handler: first.handler });
  assert.equal(retryAfterLostResponse.status, 200);
  assert.equal(retryAfterLostResponse.body.credential, issued.body.credential);
  assert.equal(retryAfterLostResponse.body.deviceId, issued.body.deviceId);
  assert.equal((await first.call("GET", "/api/profile", { credential: issued.body.credential, handler: second })).status, 200);
  assert.equal((await first.call("POST", "/api/profile?op=revoke", { credential: created.body.credential, body: { deviceId: issued.body.deviceId }, handler: second })).status, 200);
  assert.equal((await first.call("GET", "/api/profile", { credential: issued.body.credential, handler: first.handler })).status, 401);
});

test("Blob supersession requires the exact accepted write receipt and preserves per-device sequence ordering", async () => {
  const store = memoryBlobStore();
  const harness = makeHarness(store);
  const created = await harness.call("POST", "/api/profile", { body: { tmdbToken: "token" } });
  const { credential, deviceId } = created.body;
  const firstMutation = crypto.randomUUID();
  const first = await harness.call("PATCH", "/api/profile", { credential, body: {
    mutationId: firstMutation, deviceId, checkpoints: [{ ...checkpoint(100, 0), clientSeq: 1 }],
  } });
  const noOpMutation = crypto.randomUUID();
  const noOp = await harness.call("PATCH", "/api/profile", { credential, body: {
    mutationId: noOpMutation, deviceId, checkpoints: [{ ...checkpoint(50, 0), clientSeq: 1 }],
  } });
  assert.equal(noOp.status, 200, JSON.stringify(noOp.body));
  assert.equal(noOp.body.snapshot.checkpoints.movie_5494049.position, 100);
  const unrelated = await harness.call("PATCH", "/api/profile", { credential, body: {
    mutationId: crypto.randomUUID(), deviceId, supersedesMutationIds: [noOpMutation],
    checkpoints: [{ ...checkpoint(250, 0), clientSeq: 2 }],
  } });
  assert.equal(unrelated.body.snapshot.checkpoints.movie_5494049.position, 100);
  const latest = await harness.call("PATCH", "/api/profile", { credential, body: {
    mutationId: crypto.randomUUID(), deviceId, supersedesMutationIds: [firstMutation],
    checkpoints: [{ ...checkpoint(300, 0), clientSeq: 3 }],
  } });
  assert.equal(latest.body.snapshot.checkpoints.movie_5494049.position, 300);
  assert.equal(JSON.stringify(latest.body.snapshot).includes("writeMutationId"), false);
  assert.equal(first.body.snapshot.checkpoints.movie_5494049.clientSeq, 1);
});

test("Blob CAS rechecks device revocation after conflict and concurrent polls issue one recoverable credential", async () => {
  const store = memoryBlobStore();
  const harness = makeHarness(store);
  const created = await harness.call("POST", "/api/profile", { body: { tmdbToken: "token" } });
  const pairing = await harness.call("POST", "/api/profile?op=pair/create", { credential: created.body.credential, body: { deviceName: "Phone" } });
  const claim = await harness.call("POST", "/api/profile?op=pair/claim", { body: { shortCode: pairing.body.shortCode, claimId: crypto.randomUUID() } });
  await harness.call("POST", "/api/profile?op=pair/approve", { credential: created.body.credential, body: { requestId: claim.body.requestId } });

  const other = harness.newHandler();
  const pollResults = await Promise.all([
    harness.call("POST", "/api/profile?op=pair/poll", { body: { requestId: claim.body.requestId, pollToken: claim.body.pollToken } }),
    harness.call("POST", "/api/profile?op=pair/poll", { body: { requestId: claim.body.requestId, pollToken: claim.body.pollToken }, handler: other, ip: "192.0.2.41" }),
  ]);
  assert.deepEqual(pollResults.map((result) => result.status), [200, 200]);
  assert.equal(pollResults[0].body.credential, pollResults[1].body.credential);

  const phone = pollResults[0].body;
  const profilePath = [...store.blobs.keys()].find((path) => path.endsWith(`${created.body.profileId}.json`));
  assert.ok(profilePath);
  let reached;
  const blocked = new Promise((resolve) => { reached = resolve; });
  let release;
  const resume = new Promise((resolve) => { release = resolve; });
  let shouldPause = true;
  store.setBeforePut(async (path, options) => {
    if (shouldPause && path === profilePath && options.ifMatch) { shouldPause = false; reached(); await resume; }
  });
  const raced = harness.call("PATCH", "/api/profile", { credential: phone.credential, body: { mutationId: crypto.randomUUID(), deviceId: phone.deviceId, checkpoints: [checkpoint(5, 0)] } });
  await blocked;
  const revoked = await harness.call("POST", "/api/profile?op=revoke", { credential: created.body.credential, body: { deviceId: phone.deviceId }, handler: other });
  assert.equal(revoked.status, 200);
  release();
  const racedResult = await raced;
  assert.equal(racedResult.status, 401, "a losing stale CAS retries after the owner revoked its caller");
});

test("Blob write ETag cannot authorize a stale body if another mutation lands between validation and HEAD", async () => {
  const store = memoryBlobStore();
  const harness = makeHarness(store);
  const created = await harness.call("POST", "/api/profile", { body: { tmdbToken: "token" } });
  const profilePath = `personal-cinema/v1/profiles/${created.body.profileId}.json`;
  let injected = false;
  store.setBeforeHead(async (path) => {
    if (injected || path !== profilePath) return;
    injected = true;
    const current = JSON.parse(store.blobs.get(path).body);
    current.revision += 1;
    current.displayName = "Concurrent update";
    const etag = `"external-${current.revision}"`;
    store.blobs.set(path, { body: JSON.stringify(current), etag });
  });
  const result = await harness.call("PATCH", "/api/profile", { credential: created.body.credential, body: {
    mutationId: crypto.randomUUID(), deviceId: created.body.deviceId, checkpoints: [checkpoint(75, 1)],
  } });
  assert.equal(injected, true);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.snapshot.displayName, "Concurrent update", JSON.stringify(result.body));
  assert.equal(result.body.snapshot.checkpoints.movie_5494049.position, 75);
});

test("Blob retries an SDK generic conflict by re-reading and merging against the winning revision", async () => {
  const store = memoryBlobStore();
  const harness = makeHarness(store);
  const created = await harness.call("POST", "/api/profile", { body: { tmdbToken: "token" } });
  const profilePath = `personal-cinema/v1/profiles/${created.body.profileId}.json`;
  let injected = false;
  store.setBeforePut(async (path, options) => {
    if (injected || path !== profilePath || !options.ifMatch) return;
    injected = true;
    const current = JSON.parse(store.blobs.get(path).body);
    current.revision += 1;
    current.displayName = "Concurrent update";
    store.blobs.set(path, { body: JSON.stringify(current), etag: `"external-${current.revision}"` });
    throw new Error("temporary write conflict");
  });
  const result = await harness.call("PATCH", "/api/profile", { credential: created.body.credential, body: {
    mutationId: crypto.randomUUID(), deviceId: created.body.deviceId, checkpoints: [checkpoint(80, 1)],
  } });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(injected, true);
  assert.equal(result.body.snapshot.displayName, "Concurrent update");
  assert.equal(result.body.snapshot.checkpoints.movie_5494049.position, 80);
});

test("concurrent Blob checkpoint writers retry with jitter and preserve both records", async () => {
  const store = memoryBlobStore();
  const harness = makeHarness(store);
  const created = await harness.call("POST", "/api/profile", { body: { tmdbToken: "token" } });
  const profilePath = `personal-cinema/v1/profiles/${created.body.profileId}.json`;
  let writesAtBarrier = 0;
  let releaseBarrier;
  const barrier = new Promise((resolve) => { releaseBarrier = resolve; });
  store.setBeforePut(async (path, options) => {
    if (path !== profilePath || !options.ifMatch || writesAtBarrier >= 2) return;
    writesAtBarrier += 1;
    if (writesAtBarrier === 2) releaseBarrier();
    else await barrier;
  });
  const mutations = [0, 1].map((index) => harness.call("PATCH", "/api/profile", {
    credential: created.body.credential,
    ip: `192.0.2.${60 + index}`,
    body: {
      mutationId: crypto.randomUUID(), deviceId: created.body.deviceId,
      checkpoints: [{ ...checkpoint(100 + index, 0), progressKey: `movie_parallel-${index}`, item: { ...movie, id: `parallel-${index}` }, clientSeq: 1 }],
    },
  }));
  const results = await Promise.all(mutations);
  assert.deepEqual(results.map((result) => result.status), [200, 200]);
  const snapshot = await harness.call("GET", "/api/profile", { credential: created.body.credential });
  assert.deepEqual(Object.keys(snapshot.body.checkpoints).sort(), ["movie_parallel-0", "movie_parallel-1"]);
});

test("Blob clear receipt and cutoff survive receipt eviction and preserve post-clear progress", async () => {
  const store = memoryBlobStore();
  const harness = makeHarness(store);
  const created = await harness.call("POST", "/api/profile", { body: { tmdbToken: "token" } });
  const deviceId = created.body.deviceId;
  const clearId = crypto.randomUUID();
  const cutoff = harness.clock.value - 1;
  const clear = await harness.call("POST", "/api/profile?op=watch/clear", { credential: created.body.credential, body: { mutationId: clearId, deviceId, clearedAt: cutoff } });
  assert.equal(clear.status, 200);
  for (let i = 0; i < 130; i += 1) {
    const result = await harness.call("PATCH", "/api/profile", { credential: created.body.credential, body: { mutationId: crypto.randomUUID(), deviceId, displayName: `mutation ${i}` } });
    assert.equal(result.status, 200);
  }
  const state = await harness.call("GET", "/api/profile", { credential: created.body.credential });
  const fresh = await harness.call("PATCH", "/api/profile", { credential: created.body.credential, body: { mutationId: crypto.randomUUID(), deviceId, checkpoints: [checkpoint(40, state.body.revision)] } });
  const replay = await harness.call("POST", "/api/profile?op=watch/clear", { credential: created.body.credential, body: { mutationId: clearId, deviceId, clearedAt: cutoff } });
  assert.equal(replay.body.revision, fresh.body.revision);
  assert.equal(replay.body.snapshot.checkpoints.movie_5494049.position, 40);
  const oldCutoff = await harness.call("POST", "/api/profile?op=watch/clear", { credential: created.body.credential, body: { mutationId: crypto.randomUUID(), deviceId, clearedAt: cutoff - 1 } });
  assert.equal(oldCutoff.body.snapshot.checkpoints.movie_5494049.position, 40);
  harness.clock.value += 2;
  const newer = await harness.call("POST", "/api/profile?op=watch/clear", { credential: created.body.credential, body: { mutationId: crypto.randomUUID(), deviceId, clearedAt: harness.clock.value } });
  assert.equal(newer.status, 200);
  assert.equal(newer.body.snapshot.checkpoints.movie_5494049, undefined);
});

test("Blob creation rate limit is durable across handler instances", async () => {
  const store = memoryBlobStore();
  const harness = makeHarness(store);
  for (let index = 0; index < 8; index += 1) {
    const result = await harness.call("POST", "/api/profile", { body: { tmdbToken: `token-${index}` }, ip: "198.51.100.80" });
    assert.equal(result.status, 201);
  }
  const limited = await harness.call("POST", "/api/profile", { body: { tmdbToken: "token-excess" }, ip: "198.51.100.80", handler: harness.newHandler() });
  assert.equal(limited.status, 429);
});

test("Blob pairing state prunes expired offers while preserving live approved and issued requests", async () => {
  const store = memoryBlobStore();
  const harness = makeHarness(store);
  const created = await harness.call("POST", "/api/profile", { body: { tmdbToken: "token" } });
  const credential = created.body.credential;
  const firstPair = await harness.call("POST", "/api/profile?op=pair/create", { credential, body: { deviceName: "Approved phone" } });
  const claim = await harness.call("POST", "/api/profile?op=pair/claim", { body: { shortCode: firstPair.body.shortCode, claimId: crypto.randomUUID(), deviceName: "Approved phone" } });
  await harness.call("POST", "/api/profile?op=pair/approve", { credential, body: { requestId: claim.body.requestId } });
  const issued = await harness.call("POST", "/api/profile?op=pair/poll", { body: { requestId: claim.body.requestId, pollToken: claim.body.pollToken } });
  assert.equal(issued.status, 200);
  const replayBeforeExpiry = await harness.call("POST", "/api/profile?op=pair/poll", { body: { requestId: claim.body.requestId, pollToken: claim.body.pollToken } });
  assert.equal(replayBeforeExpiry.body.credential, issued.body.credential);

  harness.clock.value += 9 * 60 * 1000;
  const livePair = await harness.call("POST", "/api/profile?op=pair/create", { credential, body: { deviceName: "Next phone" } });
  const liveClaim = await harness.call("POST", "/api/profile?op=pair/claim", { body: { shortCode: livePair.body.shortCode, claimId: crypto.randomUUID(), deviceName: "Next phone" } });
  await harness.call("POST", "/api/profile?op=pair/approve", { credential, body: { requestId: liveClaim.body.requestId } });
  const profilePath = `personal-cinema/v1/profiles/${created.body.profileId}.json`;
  let profile = JSON.parse(store.blobs.get(profilePath).body);
  assert.equal(profile.pendingPairings[claim.body.requestId].status, "used", "issued request stays replayable until its expiry");
  assert.equal(profile.pendingPairings[liveClaim.body.requestId].status, "approved", "approved unconsumed request survives before its expiry");

  const expiredCode = firstPair.body.shortCode;
  for (let index = 0; index < 200; index += 1) {
    harness.clock.value += 10 * 60 * 1000 + 1;
    const result = await harness.call("POST", "/api/profile?op=pair/create", { credential, body: { deviceName: `Phone ${index}` } });
    assert.equal(result.status, 201, JSON.stringify(result.body));
  }
  profile = JSON.parse(store.blobs.get(profilePath).body);
  assert.equal(Object.keys(profile.pairOffers).length, 1);
  assert.deepEqual(profile.pendingPairings, {});
  assert.equal([...store.blobs.keys()].filter((path) => path.startsWith("personal-cinema/v1/pair-codes/")).length, 1);
  assert.equal([...store.blobs.keys()].filter((path) => path.startsWith("personal-cinema/v1/pair-tokens/")).length, 1);
  assert.equal([...store.blobs.keys()].filter((path) => path.startsWith("personal-cinema/v1/pair-requests/")).length, 0);
  const expiredLookup = await harness.call("POST", "/api/profile?op=pair/claim", { body: { shortCode: expiredCode, claimId: crypto.randomUUID() } });
  assert.equal(expiredLookup.status, 410);
  for (let index = 1; index < 32; index += 1) {
    assert.equal((await harness.call("POST", "/api/profile?op=pair/create", { credential, body: { deviceName: `Live ${index}` } })).status, 201);
  }
  const capped = await harness.call("POST", "/api/profile?op=pair/create", { credential, body: { deviceName: "Over limit" } });
  assert.equal(capped.status, 429);
  profile = JSON.parse(store.blobs.get(profilePath).body);
  assert.equal(Object.keys(profile.pairOffers).length, 32);
  assert.equal([...store.blobs.keys()].filter((path) => path.startsWith("personal-cinema/v1/pair-codes/")).length, 32, "rejected offers do not leave code locators behind");
});
