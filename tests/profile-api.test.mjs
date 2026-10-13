import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createProfileHandler, mergeProfileSnapshot, validateCheckpoint } from "../api/_lib/_profile.mjs";

const SECRET = "a".repeat(64);

function memoryUpstash() {
  const values = new Map();
  const counts = new Map();
  const makeResponse = (result, error) => ({ ok: true, async json() { return error ? { error } : { result }; } });
  return async (_url, init) => {
    const command = JSON.parse(init.body);
    if (command[0] === "GET") return makeResponse(values.get(command[1]) ?? null);
    if (command[0] !== "EVAL") throw new Error(`unexpected Redis command ${command[0]}`);
    const [, script, countRaw, ...rest] = command;
    const count = Number(countRaw);
    const keys = rest.slice(0, count);
    const args = rest.slice(count);
    if (script.includes("profile:rate-limit:v1")) {
      const n = (counts.get(keys[0]) || 0) + 1;
      counts.set(keys[0], n);
      return makeResponse(n);
    }
    if (script.includes("profile:create:v1")) {
      if (values.has(keys[0])) return makeResponse(null, "PROFILE_EXISTS");
      values.set(keys[0], args[0]);
      values.set(keys[1], args[2]);
      return makeResponse("OK");
    }
    if (script.includes("profile:merge:v1")) {
      const current = JSON.parse(values.get(keys[0]));
      const device = current.devices[args[1]];
      if (!device?.active || device.credentialHash !== args[5]) return makeResponse(null, "CREDENTIAL_REVOKED");
      const patch = JSON.parse(args[0]);
      const merged = mergeProfileSnapshot(current, patch, { deviceId: args[1], now: Number(args[2]) });
      const encoded = JSON.stringify(merged);
      if (Buffer.byteLength(encoded) > Number(args[3])) return makeResponse(null, "PROFILE_TOO_LARGE");
      values.set(keys[0], encoded);
      return makeResponse([encoded, String(merged.revision)]);
    }
    if (script.includes("profile:watch-clear:v1")) {
      const profile = JSON.parse(values.get(keys[0]));
      const device = profile.devices[args[1]];
      if (!device?.active || device.credentialHash !== args[5]) return makeResponse(null, "CREDENTIAL_REVOKED");
      if (profile.mutationReceipts?.[args[0]] || profile.watchClearMutationId === args[0] || Number(args[2]) <= (Number(profile.watchClearedAt) || 0)) return makeResponse([JSON.stringify(profile), String(profile.revision)]);
      const clearedAt = Math.min(Number(args[2]), Number(args[3]));
      profile.checkpoints = {}; profile.sessions = {};
      profile.library.history = {}; profile.library.watched = {};
      profile.revision += 1; profile.watchResetRevision = profile.revision; profile.watchClearedAt = clearedAt; profile.watchClearMutationId = args[0]; profile.updatedAt = Number(args[3]);
      profile.mutationReceipts ||= {}; profile.mutationOrder ||= [];
      profile.mutationReceipts[args[0]] = profile.revision; profile.mutationOrder.push(args[0]);
      while (profile.mutationOrder.length > 128) delete profile.mutationReceipts[profile.mutationOrder.shift()];
      const encoded = JSON.stringify(profile); values.set(keys[0], encoded);
      return makeResponse([encoded, String(profile.revision)]);
    }
    if (script.includes("profile:pair-create:v1")) {
      const profile = JSON.parse(values.get(keys[0]) || "null");
      if (!profile) return makeResponse(null, "PROFILE_MISSING");
      const caller = profile.devices[args[3]];
      if (!caller?.active || caller.credentialHash !== args[4]) return makeResponse(null, "CREDENTIAL_REVOKED");
      if (values.has(keys[1])) return makeResponse(null, "PAIR_COLLISION");
      values.set(keys[2], args[0]); values.set(keys[1], args[2]);
      return makeResponse("OK");
    }
    if (script.includes("profile:pair-claim:v1")) {
      const pairRaw = values.get(keys[0]);
      if (!pairRaw) return makeResponse(null, "PAIR_EXPIRED");
      const pair = JSON.parse(pairRaw);
      if (pair.claimed) return makeResponse(null, "PAIR_ALREADY_CLAIMED");
      const profile = JSON.parse(values.get(keys[1]));
      const request = { requestId: args[0], profileId: profile.profileId, deviceName: args[1], status: "pending", tokenHash: args[2], pollTokenHash: args[3], createdAt: Number(args[4]), expiresAt: Number(args[4]) + Number(args[5]) * 1000 };
      Object.assign(pair, { claimed: true, requestId: args[0], deviceName: args[1] });
      profile.pendingPairings[args[0]] = request; profile.updatedAt = Number(args[4]);
      values.set(keys[0], JSON.stringify(pair)); values.set(keys[1], JSON.stringify(profile)); values.set(keys[2], JSON.stringify(request));
      return makeResponse("OK");
    }
    if (script.includes("profile:pair-approve:v1")) {
      const profile = JSON.parse(values.get(keys[0]));
      const caller = profile.devices[args[4]];
      if (!caller?.active || caller.credentialHash !== args[5]) return makeResponse(null, "CREDENTIAL_REVOKED");
      const request = profile.pendingPairings[args[0]];
      if (!request) return makeResponse(null, "PAIR_REQUEST_MISSING");
      if (request.expiresAt <= Number(args[1])) { delete profile.pendingPairings[args[0]]; return makeResponse(null, "PAIR_EXPIRED"); }
      if (request.status !== "pending") return makeResponse(null, "PAIR_NOT_PENDING");
      request.status = "approved"; request.approvedAt = Number(args[1]); profile.updatedAt = Number(args[1]);
      const external = JSON.parse(values.get(keys[1]));
      external.status = "approved"; external.approvedAt = Number(args[1]);
      values.set(keys[0], JSON.stringify(profile)); values.set(keys[1], JSON.stringify(external));
      return makeResponse("OK");
    }
    if (script.includes("profile:pair-poll:v1")) {
      const profile = JSON.parse(values.get(keys[0]));
      const request = profile.pendingPairings[args[0]];
      if (!request) return makeResponse(null, "PAIR_REQUEST_MISSING");
      if (request.pollTokenHash !== args[1]) return makeResponse(null, "PAIR_TOKEN_INVALID");
      if (request.status !== "approved") return makeResponse(["pending"]);
      if (request.credentialIssued) return makeResponse(["used"]);
      const device = { deviceId: args[2], name: request.deviceName, active: true, createdAt: Number(args[4]), credentialHash: args[3] };
      profile.devices[args[2]] = device;
      delete profile.pendingPairings[args[0]];
      request.status = "used"; request.credentialIssued = true; request.deviceId = args[2]; request.issuedAt = Number(args[4]);
      profile.revision += 1; profile.updatedAt = Number(args[4]);
      const encoded = JSON.stringify(profile);
      values.set(keys[0], encoded);
      values.set(`${keys[1]}${args[3]}`, JSON.stringify({ profileId: profile.profileId, deviceId: args[2] }));
      values.set(keys[2], JSON.stringify(request));
      return makeResponse(["issued", encoded, String(profile.revision)]);
    }
    if (script.includes("profile:revoke:v1")) {
      const profile = JSON.parse(values.get(keys[0]));
      const caller = profile.devices[args[1]];
      if (!caller?.active || caller.credentialHash !== args[5]) return makeResponse(null, "CREDENTIAL_REVOKED");
      const target = profile.devices[args[0]];
      if (args[0] === args[1]) return makeResponse(null, "CANNOT_REVOKE_SELF");
      if (!target?.active) return makeResponse(null, "DEVICE_MISSING");
      values.delete(args[2]); target.active = false; target.revokedAt = Number(args[3]);
      profile.revision += 1; profile.updatedAt = Number(args[3]);
      const encoded = JSON.stringify(profile); values.set(keys[0], encoded);
      return makeResponse(encoded);
    }
    throw new Error(`unrecognized Lua script: ${script.slice(0, 50)}`);
  };
}

function makeHarness() {
  const fetchImpl = memoryUpstash();
  let currentTime = 1_800_000_000_000;
  const handler = createProfileHandler({
    env: { UPSTASH_REDIS_REST_URL: "https://redis.invalid", UPSTASH_REDIS_REST_TOKEN: "test-only", PROFILE_DATA_SECRET: SECRET },
    fetchImpl,
    now: () => currentTime,
  });
  async function call(method, url = "/api/profile", { body, credential, ip = "192.0.2.8" } = {}) {
    const headers = { "x-forwarded-for": ip };
    if (credential) headers.authorization = `Bearer ${credential}`;
    let status = 200;
    let payload;
    const res = {
      setHeader() {},
      status(code) { status = code; return this; },
      json(value) { payload = value; return this; },
      end() { return this; },
    };
    await handler({ method, url, headers, body }, res);
    return { status, body: payload };
  }
  return { call, advance: (ms) => { currentTime += ms; } };
}

const item = { type: "movie", id: "5494049", title: "Example", year: 2026, poster_path: "/abc/poster.jpg", vote_average: 8.2, genres: [{ id: 18, name: "Drama" }] };
const checkpoint = (position, baseRevision) => ({ progressKey: "movie_5494049", item, position, duration: 1200, preferences: { providerId: "alloha", providerName: "Habster", voiceId: "dub-1", voiceName: "Studio", subtitle: { enabled: false, name: "English", lang: "en" }, quality: "2160p" }, baseRevision });

test("private profile creates device credential, hides ciphertext and returns token only on explicit bootstrap", async () => {
  const { call } = makeHarness();
  const created = await call("POST", "/api/profile", { body: { displayName: "Alex", deviceName: "Desktop", tmdbToken: "tmdb-secret-value" } });
  assert.equal(created.status, 201);
  assert.match(created.body.credential, /^[A-Za-z0-9_-]{40,}$/);
  assert.equal(created.body.snapshot.displayName, "Alex");
  assert.equal(JSON.stringify(created.body).includes("tmdb-secret-value"), false);
  assert.equal(JSON.stringify(created.body.snapshot).includes("credentialHash"), false);

  const unauthorized = await call("GET", "/api/profile");
  assert.equal(unauthorized.status, 401);
  const unknownCredential = await call("GET", "/api/profile", { credential: "Z".repeat(48) });
  assert.equal(unknownCredential.status, 401);
  const snapshot = await call("GET", "/api/profile", { credential: created.body.credential });
  assert.equal(snapshot.status, 200);
  assert.equal(snapshot.body.tmdbTokenCiphertext, undefined);
  assert.equal(snapshot.body.bootstrapToken, undefined);
  const bootstrap = await call("GET", "/api/profile?include=bootstrapToken", { credential: created.body.credential });
  assert.equal(bootstrap.body.bootstrapToken, "tmdb-secret-value");
});

test("checkpoint merge protects a newer checkpoint from a stale offline outbox while allowing a current rewind", async () => {
  const { call } = makeHarness();
  const created = await call("POST", "/api/profile", { body: { tmdbToken: "token" } });
  const credential = created.body.credential;
  const deviceId = created.body.deviceId;
  let patch = await call("PATCH", "/api/profile", { credential, body: { mutationId: crypto.randomUUID(), deviceId, checkpoints: [checkpoint(90, 0)] } });
  assert.equal(patch.status, 200);
  assert.equal(patch.body.snapshot.checkpoints.movie_5494049.position, 90);
  const base = patch.body.revision;
  patch = await call("PATCH", "/api/profile", { credential, body: { mutationId: crypto.randomUUID(), deviceId, checkpoints: [checkpoint(140, base)] } });
  assert.equal(patch.body.snapshot.checkpoints.movie_5494049.position, 140);
  patch = await call("PATCH", "/api/profile", { credential, body: { mutationId: crypto.randomUUID(), deviceId, checkpoints: [checkpoint(22, base)] } });
  assert.equal(patch.body.snapshot.checkpoints.movie_5494049.position, 140);
  const currentRevision = patch.body.revision;
  patch = await call("PATCH", "/api/profile", { credential, body: { mutationId: crypto.randomUUID(), deviceId, checkpoints: [checkpoint(22, currentRevision)] } });
  assert.equal(patch.body.snapshot.checkpoints.movie_5494049.position, 22);
});

test("session delivery is idempotent and played intervals union without double counting", async () => {
  const { call } = makeHarness();
  const created = await call("POST", "/api/profile", { body: { tmdbToken: "token" } });
  const sessionId = crypto.randomUUID();
  const body = {
    mutationId: crypto.randomUUID(), deviceId: created.body.deviceId,
    sessions: [{ sessionId, progressKey: "movie_5494049", item, segments: [{ start: 1000, end: 3000 }, { start: 5000, end: 7000 }] }],
  };
  let result = await call("PATCH", "/api/profile", { credential: created.body.credential, body });
  assert.equal(result.status, 200);
  body.mutationId = crypto.randomUUID();
  body.sessions[0].segments = [{ start: 2500, end: 6000 }];
  result = await call("PATCH", "/api/profile", { credential: created.body.credential, body });
  const stored = result.body.snapshot.sessions[sessionId].segments;
  assert.deepEqual(stored, [{ start: 1000, end: 7000 }]);
  const mutationId = crypto.randomUUID();
  body.mutationId = mutationId;
  body.sessions[0].segments = [{ start: 8000, end: 9000 }];
  result = await call("PATCH", "/api/profile", { credential: created.body.credential, body });
  const revision = result.body.revision;
  result = await call("PATCH", "/api/profile", { credential: created.body.credential, body });
  assert.equal(result.body.revision, revision);
  assert.deepEqual(result.body.snapshot.sessions[sessionId].segments, [{ start: 1000, end: 7000 }, { start: 8000, end: 9000 }]);
});

test("clearing watch data is idempotent and blocks stale outbox resurrection while allowing fresh rewind", async () => {
  const { call } = makeHarness();
  const created = await call("POST", "/api/profile", { body: { tmdbToken: "token" } });
  const { credential, deviceId } = created.body;
  const key = "movie_5494049";
  const sessionId = crypto.randomUUID();
  const itemKey = "movie_5494049";
  const initial = await call("PATCH", "/api/profile", {
    credential,
    body: {
      mutationId: crypto.randomUUID(), deviceId,
      checkpoints: [checkpoint(300, 0)],
      sessions: [{ sessionId, progressKey: key, item, segments: [{ start: 1_799_999_990_000, end: 1_799_999_995_000 }], completedAt: 1_799_999_995_000 }],
      library: {
        saved: { [itemKey]: { value: item, baseRevision: 0 } },
        watched: { [itemKey]: { value: true, baseRevision: 0 } },
        history: { [`${itemKey}_played`]: { value: { ...item, watchedAt: 1_799_999_995_000 }, baseRevision: 0 } },
        ratings: { [itemKey]: { value: { score: 8, ratedAt: 1_799_999_995_000, item }, baseRevision: 0 } },
      },
    },
  });
  assert.equal(initial.status, 200);
  const clearedAt = 1_800_000_000_000;
  const mutationId = crypto.randomUUID();
  const clearBody = { mutationId, deviceId, clearedAt };
  const clear = await call("POST", "/api/profile?op=watch/clear", { credential, body: clearBody });
  assert.equal(clear.status, 200, JSON.stringify(clear.body));
  const resetRevision = clear.body.revision;
  assert.equal(clear.body.snapshot.watchResetRevision, resetRevision);
  assert.equal(clear.body.snapshot.watchClearedAt, clearedAt);
  assert.deepEqual(clear.body.snapshot.checkpoints, {});
  assert.deepEqual(clear.body.snapshot.sessions, {});
  assert.deepEqual(clear.body.snapshot.library.history, {});
  assert.deepEqual(clear.body.snapshot.library.watched, {});
  assert.ok(clear.body.snapshot.library.saved[itemKey]);
  assert.equal(clear.body.snapshot.library.ratings[itemKey].value.score, 8);

  const oldSessionId = crypto.randomUUID();
  const crossingSessionId = crypto.randomUUID();
  const stale = await call("PATCH", "/api/profile", {
    credential,
    body: {
      mutationId: crypto.randomUUID(), deviceId,
      checkpoints: [checkpoint(25, initial.body.revision)],
      sessions: [
        { sessionId: oldSessionId, progressKey: key, item, segments: [{ start: clearedAt - 2000, end: clearedAt - 1000 }], completedAt: clearedAt - 1000 },
        { sessionId: crossingSessionId, progressKey: key, item, segments: [{ start: clearedAt - 500, end: clearedAt + 2500 }], completedAt: clearedAt - 1 },
      ],
      library: {
        watched: { [itemKey]: { value: true, baseRevision: initial.body.revision } },
        history: { [`${itemKey}_stale`]: { value: { ...item, watchedAt: clearedAt - 100 }, baseRevision: initial.body.revision } },
      },
    },
  });
  assert.equal(stale.status, 200);
  assert.equal(stale.body.snapshot.checkpoints[key], undefined);
  assert.equal(stale.body.snapshot.library.watched[itemKey], undefined);
  assert.equal(stale.body.snapshot.library.history[`${itemKey}_stale`], undefined);
  assert.equal(stale.body.snapshot.sessions[oldSessionId], undefined);
  assert.deepEqual(stale.body.snapshot.sessions[crossingSessionId].segments, [{ start: clearedAt, end: clearedAt + 2500 }]);
  assert.equal(stale.body.snapshot.sessions[crossingSessionId].completedAt, undefined);

  const fresh = await call("PATCH", "/api/profile", {
    credential,
    body: {
      mutationId: crypto.randomUUID(), deviceId,
      checkpoints: [checkpoint(42, resetRevision)],
      sessions: [{ sessionId, progressKey: key, item, segments: [{ start: clearedAt + 3000, end: clearedAt + 5000 }] }],
      library: {
        watched: { [itemKey]: { value: true, baseRevision: resetRevision } },
        history: { [`${itemKey}_fresh`]: { value: { ...item, watchedAt: clearedAt + 5000 }, baseRevision: resetRevision } },
      },
    },
  });
  assert.equal(fresh.status, 200);
  assert.equal(fresh.body.snapshot.checkpoints[key].position, 42, "a legitimate rewind after clear is accepted");
  assert.equal(fresh.body.snapshot.library.watched[itemKey].value, true);
  assert.equal(fresh.body.snapshot.library.history[`${itemKey}_fresh`].value.watchedAt, clearedAt + 5000);

  const repeated = await call("POST", "/api/profile?op=watch/clear", { credential, body: clearBody });
  assert.equal(repeated.status, 200);
  assert.equal(repeated.body.revision, fresh.body.revision);
  assert.equal(repeated.body.snapshot.checkpoints[key].position, 42, "replaying clear receipt does not clear newer progress twice");
});

test("device pairing requires owner approval, gives per-request poll secret and revoke invalidates credentials", async () => {
  const { call, advance } = makeHarness();
  const owner = await call("POST", "/api/profile", { body: { tmdbToken: "token", deviceName: "Laptop" } });
  const unrelatedOwner = await call("POST", "/api/profile", { body: { tmdbToken: "other-token", deviceName: "Other laptop" } });
  const pairing = await call("POST", "/api/profile?op=pair/create", { credential: owner.body.credential, body: { deviceName: "Phone" } });
  assert.equal(pairing.status, 201);
  const claim = await call("POST", "/api/profile?op=pair/claim", { body: { shortCode: pairing.body.shortCode, deviceName: "Phone" } });
  assert.equal(claim.status, 202);
  assert.notEqual(claim.body.pollToken, pairing.body.requestToken);
  let polled = await call("POST", "/api/profile?op=pair/poll", { body: { requestId: claim.body.requestId, pollToken: claim.body.pollToken } });
  assert.equal(polled.status, 202);
  const ownerSnapshot = await call("GET", "/api/profile", { credential: owner.body.credential });
  assert.equal(ownerSnapshot.body.pendingPairings[claim.body.requestId].deviceName, "Phone");
  assert.equal(ownerSnapshot.body.pendingPairings[claim.body.requestId].pollTokenHash, undefined);
  assert.equal(ownerSnapshot.body.pendingPairings[claim.body.requestId].tokenHash, undefined);
  const crossProfileApproval = await call("POST", "/api/profile?op=pair/approve", {
    credential: unrelatedOwner.body.credential,
    body: { requestId: claim.body.requestId },
  });
  assert.equal(crossProfileApproval.status, 404);
  const wrongPollToken = await call("POST", "/api/profile?op=pair/poll", {
    body: { requestId: claim.body.requestId, pollToken: "Z".repeat(48) },
  });
  assert.equal(wrongPollToken.status, 401);
  const approved = await call("POST", "/api/profile?op=pair/approve", { credential: owner.body.credential, body: { requestId: claim.body.requestId } });
  assert.equal(approved.status, 200);
  const afterApproval = await call("GET", "/api/profile", { credential: owner.body.credential });
  assert.equal(afterApproval.body.pendingPairings[claim.body.requestId], undefined);
  polled = await call("POST", "/api/profile?op=pair/poll", { body: { requestId: claim.body.requestId, pollToken: claim.body.pollToken } });
  assert.equal(polled.status, 200);
  const phone = polled.body.credential;
  assert.equal((await call("GET", "/api/profile", { credential: phone })).status, 200);
  const repeated = await call("POST", "/api/profile?op=pair/poll", { body: { requestId: claim.body.requestId, pollToken: claim.body.pollToken } });
  assert.equal(repeated.status, 410);
  const revoke = await call("POST", "/api/profile?op=revoke", { credential: owner.body.credential, body: { deviceId: polled.body.deviceId } });
  assert.equal(revoke.status, 200);
  assert.equal((await call("GET", "/api/profile", { credential: phone })).status, 401);
  assert.equal((await call("PATCH", "/api/profile", { credential: phone, body: { mutationId: crypto.randomUUID(), deviceId: polled.body.deviceId } })).status, 401);
  assert.equal((await call("GET", "/api/profile", { credential: owner.body.credential })).status, 200);
  const selfRevoke = await call("POST", "/api/profile?op=revoke", { credential: owner.body.credential, body: { deviceId: owner.body.deviceId } });
  assert.equal(selfRevoke.status, 400);
  const afterIssuance = await call("GET", "/api/profile", { credential: owner.body.credential });
  assert.equal(afterIssuance.body.pendingPairings[claim.body.requestId], undefined);

  const expiringPair = await call("POST", "/api/profile?op=pair/create", { credential: owner.body.credential, body: { deviceName: "Tablet" } });
  const expiringClaim = await call("POST", "/api/profile?op=pair/claim", { body: { shortCode: expiringPair.body.shortCode, deviceName: "Tablet" } });
  const pending = await call("GET", "/api/profile", { credential: owner.body.credential });
  assert.equal(pending.body.pendingPairings[expiringClaim.body.requestId].expiresAt, expiringClaim.body.expiresAt);
  advance(10 * 60 * 1000 + 1);
  const expired = await call("GET", "/api/profile", { credential: owner.body.credential });
  assert.equal(expired.body.pendingPairings[expiringClaim.body.requestId], undefined);
});

test("short code claims are rate limited and no TMDB token persists when encryption key is missing", async () => {
  const { call } = makeHarness();
  const missingKey = createProfileHandler({ env: { UPSTASH_REDIS_REST_URL: "https://redis.invalid", UPSTASH_REDIS_REST_TOKEN: "test" }, fetchImpl: memoryUpstash() });
  const response = await new Promise((resolve) => missingKey(
    { method: "POST", url: "/api/profile", headers: {}, body: { tmdbToken: "sensitive" } },
    { setHeader() {}, status(status) { this.statusCode = status; return this; }, json(body) { resolve({ status: this.statusCode, body }); } },
  ));
  assert.equal(response.status, 503);
  assert.equal(response.body.error, "profile_encryption_unavailable");
  for (let i = 0; i < 12; i++) await call("POST", "/api/profile?op=pair/claim", { body: { shortCode: "ABCDEFGH" }, ip: "198.51.100.7" });
  const limited = await call("POST", "/api/profile?op=pair/claim", { body: { shortCode: "ABCDEFGH" }, ip: "198.51.100.7" });
  assert.equal(limited.status, 429);
});

test("anonymous profile creation is capped while normal polling cadence remains below its limit", async () => {
  const { call } = makeHarness();
  for (let i = 0; i < 8; i++) {
    const created = await call("POST", "/api/profile", { body: { tmdbToken: `qa-token-${i}` }, ip: "203.0.113.9" });
    assert.equal(created.status, 201);
  }
  const excessCreate = await call("POST", "/api/profile", { body: { tmdbToken: "qa-token-over-limit" }, ip: "203.0.113.9" });
  assert.equal(excessCreate.status, 429);

  const polling = makeHarness();
  for (let i = 0; i < 24; i++) {
    const result = await polling.call("POST", "/api/profile?op=pair/poll", { body: { requestId: "missing-request", pollToken: "p".repeat(48) }, ip: "203.0.113.10" });
    assert.equal(result.status, 410, "one poll every 2.5s remains under the per-minute limit");
  }
});

test("validation rejects signed URLs and mismatched progress keys", () => {
  assert.throws(() => validateCheckpoint({ ...checkpoint(10, 0), progressKey: "movie_123" }), /progress_key_mismatch/);
  assert.throws(() => validateCheckpoint({ ...checkpoint(10, 0), item: { ...item, poster_path: "https://cdn.invalid/poster.jpg?token=secret" } }), /invalid_poster_path/);
  const initial = { revision: 0, checkpoints: {}, sessions: {}, library: { saved: {}, watched: {}, history: {}, ratings: {} } };
  const merged = mergeProfileSnapshot(initial, { checkpoints: [checkpoint(10, 0)], sessions: [], library: {} }, { deviceId: "device", now: 10 });
  assert.equal(merged.checkpoints.movie_5494049.position, 10);
});

test("TV checkpoints use the canonical episode key and preserve subtitle selection state", async () => {
  const { call } = makeHarness();
  const created = await call("POST", "/api/profile", { body: { tmdbToken: "token" } });
  const episode = { type: "tv", id: "100", title: "Series", season: 2, episode: 4, imdb_id: "tt1234567", catalogSource: "tmdb" };
  const result = await call("PATCH", "/api/profile", {
    credential: created.body.credential,
    body: { mutationId: crypto.randomUUID(), deviceId: created.body.deviceId, checkpoints: [{ progressKey: "tv_100_s2e4", item: episode, position: 900, duration: 2400, baseRevision: 0, preferences: { subtitle: { enabled: false, kind: "external", name: "English SDH", lang: "en" } } }] },
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.snapshot.checkpoints.tv_100_s2e4.preferences.subtitle.enabled, false);
  assert.equal(result.body.snapshot.checkpoints.tv_100_s2e4.item.episode, 4);
});

test("library uses canonical wrapped values and retains tombstone revisions", async () => {
  const { call } = makeHarness();
  const created = await call("POST", "/api/profile", { body: { tmdbToken: "token" } });
  const itemKey = "movie_5494049";
  const historyValue = { ...item, watchedAt: 1_800_000_000_000, season: 1, episode: 3, episodeName: "Episode" };
  const result = await call("PATCH", "/api/profile", {
    credential: created.body.credential,
    body: {
      mutationId: crypto.randomUUID(), deviceId: created.body.deviceId,
      library: {
        saved: { [itemKey]: { value: item, baseRevision: 0 } },
        watched: { [itemKey]: { value: true, baseRevision: 0 } },
        history: { [`${itemKey}_played`]: { value: historyValue, baseRevision: 0 } },
        ratings: { [itemKey]: { value: { score: 8, ratedAt: 1_800_000_000_000, item }, baseRevision: 0 } },
      },
    },
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.snapshot.library.saved[itemKey].value.genres[0].name, "Drama");
  assert.equal(result.body.snapshot.library.watched[itemKey].value, true);
  assert.equal(result.body.snapshot.library.history[`${itemKey}_played`].value.watchedAt, 1_800_000_000_000);
  assert.equal(result.body.snapshot.library.ratings[itemKey].value.score, 8);
  assert.equal(typeof result.body.snapshot.library.ratings[itemKey].revision, "number");
  const tombstone = await call("PATCH", "/api/profile", {
    credential: created.body.credential,
    body: { mutationId: crypto.randomUUID(), deviceId: created.body.deviceId, library: { saved: { [itemKey]: { deleted: true, baseRevision: result.body.revision } } } },
  });
  assert.equal(tombstone.body.snapshot.library.saved[itemKey].deleted, true);
  assert.equal(tombstone.body.snapshot.library.saved[itemKey].revision, tombstone.body.revision);
});
