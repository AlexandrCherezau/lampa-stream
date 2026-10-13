import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import net from "node:net";
import { spawn } from "node:child_process";
import { createProfileHandler } from "../api/_lib/_profile.mjs";

const redisServerBin = process.env.PROFILE_REDIS_SERVER;
const testRedis = redisServerBin ? test : test.skip;

function parseResp(buffer, offset = 0) {
  if (offset >= buffer.length) return null;
  const type = String.fromCharCode(buffer[offset]);
  const lineEnd = buffer.indexOf("\r\n", offset);
  if (lineEnd < 0) return null;
  const line = buffer.toString("utf8", offset + 1, lineEnd);
  if (type === "+") return [line, lineEnd + 2];
  if (type === "-") return [new Error(line), lineEnd + 2];
  if (type === ":") return [Number(line), lineEnd + 2];
  if (type === "$") {
    const length = Number(line);
    if (length === -1) return [null, lineEnd + 2];
    const end = lineEnd + 2 + length;
    if (buffer.length < end + 2) return null;
    return [buffer.toString("utf8", lineEnd + 2, end), end + 2];
  }
  if (type === "*") {
    const length = Number(line);
    if (length === -1) return [null, lineEnd + 2];
    let cursor = lineEnd + 2;
    const values = [];
    for (let i = 0; i < length; i++) {
      const parsed = parseResp(buffer, cursor);
      if (!parsed) return null;
      if (parsed[0] instanceof Error) return parsed;
      values.push(parsed[0]); cursor = parsed[1];
    }
    return [values, cursor];
  }
  throw new Error(`Unsupported RESP type ${type}`);
}

function redisCommand(port, args) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1");
    let chunks = Buffer.alloc(0);
    let settled = false;
    const fail = (error) => { if (!settled) { settled = true; socket.destroy(); reject(error); } };
    socket.once("error", fail);
    socket.once("connect", () => {
      const payload = `*${args.length}\r\n${args.map((arg) => {
        const value = String(arg);
        return `$${Buffer.byteLength(value)}\r\n${value}\r\n`;
      }).join("")}`;
      socket.write(payload);
    });
    socket.on("data", (chunk) => {
      chunks = Buffer.concat([chunks, chunk]);
      const parsed = parseResp(chunks);
      if (!parsed) return;
      settled = true;
      socket.end();
      if (parsed[0] instanceof Error) reject(parsed[0]);
      else resolve(parsed[0]);
    });
    socket.setTimeout(5000, () => fail(new Error("Redis command timed out")));
  });
}

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function startRedis() {
  const port = await reservePort();
  const process = spawn(redisServerBin, ["--port", String(port), "--bind", "127.0.0.1", "--protected-mode", "no", "--save", "", "--appendonly", "no", "--daemonize", "no"], { stdio: "ignore" });
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (process.exitCode != null) throw new Error(`redis-server exited ${process.exitCode}`);
    try { await redisCommand(port, ["PING"]); return { port, process }; } catch { await new Promise((resolve) => setTimeout(resolve, 40)); }
  }
  process.kill("SIGTERM");
  throw new Error("redis-server did not start");
}

function makeCall(port, beforeCommand = async () => {}) {
  let logicalNow = Date.now();
  const fetchImpl = async (_url, init) => {
    const command = JSON.parse(init.body);
    try {
      await beforeCommand(command);
      const result = await redisCommand(port, command);
      return { ok: true, async json() { return { result }; } };
    } catch (error) {
      return { ok: true, async json() { return { error: String(error.message || error) }; } };
    }
  };
  const handler = createProfileHandler({
    env: { UPSTASH_REDIS_REST_URL: "http://127.0.0.1:1", UPSTASH_REDIS_REST_TOKEN: "test-only", PROFILE_DATA_SECRET: "b".repeat(64) },
    fetchImpl,
    now: () => logicalNow,
  });
  const call = async (method, url = "/api/profile", { body, credential } = {}) => {
    let status = 200;
    let payload;
    const res = {
      setHeader() {},
      status(code) { status = code; return this; },
      json(value) { payload = value; return this; },
      end() { return this; },
    };
    await handler({ method, url, headers: credential ? { authorization: `Bearer ${credential}`, "x-real-ip": "127.0.0.1" } : { "x-real-ip": "127.0.0.1" }, body }, res);
    return { status, body: payload };
  };
  call.advance = (milliseconds) => { logicalNow += milliseconds; };
  return call;
}

testRedis("real Redis executes profile Lua merge, pairing, expiry, revoke, cjson arrays and idempotency", async (t) => {
  const { port, process } = await startRedis();
  t.after(() => process.kill("SIGTERM"));
  const call = makeCall(port);
  const secondInstance = makeCall(port);
  const genres = [{ id: 18, name: "Drama" }, { id: 878, name: "Science Fiction" }];
  const item = { type: "movie", id: "42", title: "Redis integration", genres, poster_path: "/poster/42.jpg" };
  const created = await call("POST", "/api/profile", { body: { tmdbToken: "encrypted-integration-token" } });
  assert.equal(created.status, 201);
  const { credential, deviceId } = created.body;
  const patch = {
    mutationId: crypto.randomUUID(), deviceId,
    checkpoints: [
      { progressKey: "movie_42", item, position: 140, duration: 900, preferences: { subtitle: { enabled: false, kind: "external", lang: "en", name: "English" } }, baseRevision: 0 },
      { progressKey: "movie_43", item: { type: "movie", id: "43", title: "No genres", genres: [] }, position: 0, duration: 900, preferences: {}, baseRevision: 0 },
    ],
    sessions: [
      { sessionId: crypto.randomUUID(), progressKey: "movie_42", item, segments: [{ start: 1000, end: 4000 }, { start: 3000, end: 6000 }] },
      { sessionId: crypto.randomUUID(), progressKey: "movie_43", item: { type: "movie", id: "43", title: "No genres", genres: [] }, segments: [] },
    ],
    library: {
      saved: { movie_42: { value: item, baseRevision: 0 } },
      ratings: { movie_42: { value: { score: 9, ratedAt: Date.now(), item }, baseRevision: 0 } },
    },
  };
  let saved = await call("PATCH", "/api/profile", { credential, body: patch });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  assert.deepEqual(saved.body.snapshot.checkpoints.movie_42.item.genres, genres);
  assert.deepEqual(saved.body.snapshot.checkpoints.movie_43.item.genres, []);
  assert.deepEqual(saved.body.snapshot.sessions[patch.sessions[0].sessionId].segments, [{ start: 1000, end: 6000 }]);
  assert.deepEqual(saved.body.snapshot.sessions[patch.sessions[1].sessionId].segments, []);
  assert.equal(saved.body.snapshot.library.ratings.movie_42.value.score, 9);
  assert.equal(Array.isArray(saved.body.snapshot.checkpoints.movie_42.item.genres), true);
  assert.equal(JSON.stringify(saved.body.snapshot).includes("credentialHash"), false);
  const stableRevision = saved.body.revision;
  saved = await call("PATCH", "/api/profile", { credential, body: patch });
  assert.equal(saved.body.revision, stableRevision, "same mutation ID must not apply twice");

  const stale = { ...patch, mutationId: crypto.randomUUID(), checkpoints: [{ ...patch.checkpoints[0], position: 30, baseRevision: 0 }], sessions: [], library: {} };
  saved = await call("PATCH", "/api/profile", { credential, body: stale });
  assert.equal(saved.body.snapshot.checkpoints.movie_42.position, 140);
  const rewind = { ...stale, mutationId: crypto.randomUUID(), checkpoints: [{ ...stale.checkpoints[0], baseRevision: saved.body.revision }] };
  saved = await call("PATCH", "/api/profile", { credential, body: rewind });
  assert.equal(saved.body.snapshot.checkpoints.movie_42.position, 30);

  const concurrentSession = (id) => ({
    mutationId: crypto.randomUUID(), deviceId,
    sessions: [{ sessionId: crypto.randomUUID(), progressKey: "movie_42", item, segments: [{ start: Date.now(), end: Date.now() + 1500 }] }],
  });
  const [one, two] = await Promise.all([
    call("PATCH", "/api/profile", { credential, body: concurrentSession("one") }),
    secondInstance("PATCH", "/api/profile", { credential, body: concurrentSession("two") }),
  ]);
  assert.equal(one.status, 200);
  assert.equal(two.status, 200);
  const afterConcurrent = await secondInstance("GET", "/api/profile", { credential });
  assert.equal(Object.keys(afterConcurrent.body.sessions).length, 4, "concurrent instances must not overwrite each other's session");

  const resetSessionId = crypto.randomUUID();
  const priorHistory = `${item.type}_${item.id}_before-clear`;
  const beforeClear = await call("PATCH", "/api/profile", { credential, body: {
    mutationId: crypto.randomUUID(), deviceId,
    checkpoints: [{ progressKey: "movie_42", item, position: 250, duration: 900, preferences: {}, baseRevision: afterConcurrent.body.revision }],
    sessions: [{ sessionId: resetSessionId, progressKey: "movie_42", item, segments: [{ start: Date.now() - 5000, end: Date.now() - 1000 }], completedAt: Date.now() - 1000 }],
    library: {
      watched: { movie_42: { value: true, baseRevision: afterConcurrent.body.revision } },
      history: { [priorHistory]: { value: { ...item, watchedAt: Date.now() - 1000 }, baseRevision: afterConcurrent.body.revision } },
    },
  } });
  assert.equal(beforeClear.status, 200);
  const clearedAt = Date.now() - 1_000;
  const clearMutationId = crypto.randomUUID();
  const cleared = await call("POST", "/api/profile?op=watch/clear", { credential, body: { mutationId: clearMutationId, deviceId, clearedAt } });
  assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
  const resetRevision = cleared.body.revision;
  assert.equal(cleared.body.snapshot.watchResetRevision, resetRevision);
  assert.deepEqual(cleared.body.snapshot.checkpoints, {});
  assert.deepEqual(cleared.body.snapshot.sessions, {});
  assert.deepEqual(cleared.body.snapshot.library.watched, {});
  assert.deepEqual(cleared.body.snapshot.library.history, {});
  assert.ok(cleared.body.snapshot.library.saved.movie_42, "clear preserves saved items");
  assert.ok(cleared.body.snapshot.library.ratings.movie_42, "clear preserves ratings");

  const oldSessionId = crypto.randomUUID();
  const crossingSessionId = crypto.randomUUID();
  const staleAfterClear = await secondInstance("PATCH", "/api/profile", { credential, body: {
    mutationId: crypto.randomUUID(), deviceId,
    checkpoints: [{ progressKey: "movie_42", item, position: 15, duration: 900, preferences: {}, baseRevision: beforeClear.body.revision }],
    sessions: [
      { sessionId: oldSessionId, progressKey: "movie_42", item, segments: [{ start: clearedAt - 5000, end: clearedAt - 1000 }], completedAt: clearedAt - 1000 },
      { sessionId: crossingSessionId, progressKey: "movie_42", item, segments: [{ start: clearedAt - 2000, end: clearedAt + 1000 }], completedAt: clearedAt - 1 },
    ],
    library: {
      watched: { movie_42: { value: true, baseRevision: beforeClear.body.revision } },
      history: { stale_after_clear: { value: { ...item, watchedAt: clearedAt - 1 }, baseRevision: beforeClear.body.revision } },
    },
  } });
  assert.equal(staleAfterClear.status, 200, JSON.stringify(staleAfterClear.body));
  assert.equal(staleAfterClear.body.snapshot.checkpoints.movie_42, undefined);
  assert.equal(staleAfterClear.body.snapshot.library.watched.movie_42, undefined);
  assert.equal(staleAfterClear.body.snapshot.library.history.stale_after_clear, undefined);
  assert.equal(staleAfterClear.body.snapshot.sessions[oldSessionId], undefined);
  assert.deepEqual(staleAfterClear.body.snapshot.sessions[crossingSessionId].segments, [{ start: clearedAt, end: clearedAt + 1000 }]);
  assert.equal(staleAfterClear.body.snapshot.sessions[crossingSessionId].completedAt, undefined);
  const freshAfterClear = await call("PATCH", "/api/profile", { credential, body: {
    mutationId: crypto.randomUUID(), deviceId,
    checkpoints: [{ progressKey: "movie_42", item, position: 20, duration: 900, preferences: {}, baseRevision: resetRevision }],
    library: { watched: { movie_42: { value: true, baseRevision: resetRevision } } },
  } });
  assert.equal(freshAfterClear.status, 200);
  assert.equal(freshAfterClear.body.snapshot.checkpoints.movie_42.position, 20, "new post-clear rewind is accepted");
  const clearAgain = await secondInstance("POST", "/api/profile?op=watch/clear", { credential, body: { mutationId: clearMutationId, deviceId, clearedAt } });
  assert.equal(clearAgain.status, 200);
  assert.equal(clearAgain.body.revision, freshAfterClear.body.revision);
  assert.equal(clearAgain.body.snapshot.checkpoints.movie_42.position, 20, "duplicate clear receipt is idempotent");

  for (let index = 0; index < 130; index += 1) {
    const churn = await secondInstance("PATCH", "/api/profile", { credential, body: { mutationId: crypto.randomUUID(), deviceId, displayName: `Clear receipt churn ${index}` } });
    assert.equal(churn.status, 200);
  }
  const afterReceiptEviction = await call("GET", "/api/profile", { credential });
  assert.equal(afterReceiptEviction.body.mutationReceipts, undefined);
  const newlyRecorded = await call("PATCH", "/api/profile", { credential, body: {
    mutationId: crypto.randomUUID(), deviceId,
    checkpoints: [{ progressKey: "movie_42", item, position: 31, duration: 900, preferences: {}, baseRevision: afterReceiptEviction.body.revision }],
  } });
  assert.equal(newlyRecorded.body.snapshot.checkpoints.movie_42.position, 31);
  const clearReplayAfterEviction = await secondInstance("POST", "/api/profile?op=watch/clear", { credential, body: { mutationId: clearMutationId, deviceId, clearedAt } });
  assert.equal(clearReplayAfterEviction.status, 200);
  assert.equal(clearReplayAfterEviction.body.revision, newlyRecorded.body.revision);
  assert.equal(clearReplayAfterEviction.body.snapshot.checkpoints.movie_42.position, 31, "durable clear identity survives eviction from the general mutation receipt ring");
  const oldCutoffReplay = await call("POST", "/api/profile?op=watch/clear", { credential, body: { mutationId: crypto.randomUUID(), deviceId, clearedAt: clearedAt - 1 } });
  assert.equal(oldCutoffReplay.body.revision, newlyRecorded.body.revision);
  assert.equal(oldCutoffReplay.body.snapshot.checkpoints.movie_42.position, 31, "an older clear cutoff cannot erase newer viewing");
  const legitimateSecondClear = await call("POST", "/api/profile?op=watch/clear", { credential, body: { mutationId: crypto.randomUUID(), deviceId, clearedAt: Date.now() } });
  assert.equal(legitimateSecondClear.status, 200);
  assert.ok(legitimateSecondClear.body.revision > newlyRecorded.body.revision);
  assert.equal(legitimateSecondClear.body.snapshot.checkpoints.movie_42, undefined, "a genuinely newer clear still takes effect");

  const pairing = await call("POST", "/api/profile?op=pair/create", { credential, body: { deviceName: "Phone" } });
  const claim = await call("POST", "/api/profile?op=pair/claim", { body: { shortCode: pairing.body.shortCode, deviceName: "Phone" } });
  const ownerSnapshot = await call("GET", "/api/profile", { credential });
  assert.equal(ownerSnapshot.body.pendingPairings[claim.body.requestId].tokenHash, undefined);
  assert.equal(ownerSnapshot.body.pendingPairings[claim.body.requestId].pollTokenHash, undefined);
  assert.equal(JSON.stringify(ownerSnapshot.body).includes(pairing.body.requestToken), false);
  assert.equal(JSON.stringify(ownerSnapshot.body).includes(claim.body.pollToken), false);
  const unknownBearer = await call("GET", "/api/profile", { credential: "X".repeat(48) });
  assert.equal(unknownBearer.status, 401);
  const wrongPoll = await call("POST", "/api/profile?op=pair/poll", { body: { requestId: claim.body.requestId, pollToken: "X".repeat(48) } });
  assert.equal(wrongPoll.status, 401);
  assert.equal((await call("POST", "/api/profile?op=pair/poll", { body: { requestId: claim.body.requestId, pollToken: claim.body.pollToken } })).status, 202);
  assert.equal((await call("POST", "/api/profile?op=pair/approve", { credential, body: { requestId: claim.body.requestId } })).status, 200);
  const profileTTLAfterApproval = Number(await redisCommand(port, ["TTL", `profile:v1:${created.body.profileId}`]));
  const requestTTLAfterApproval = Number(await redisCommand(port, ["TTL", `profile:pair-request:v1:${claim.body.requestId}`]));
  assert.ok(profileTTLAfterApproval > 365 * 24 * 60 * 60, `profile TTL was shortened to ${profileTTLAfterApproval}s after owner approval`);
  assert.ok(requestTTLAfterApproval > 0 && requestTTLAfterApproval <= 10 * 60, `pair request TTL should remain short, got ${requestTTLAfterApproval}s`);
  const secondPairing = await call("POST", "/api/profile?op=pair/create", { credential, body: { deviceName: "Second phone" } });
  const secondClaim = await call("POST", "/api/profile?op=pair/claim", { body: { shortCode: secondPairing.body.shortCode, deviceName: "Second phone" } });
  assert.equal(secondClaim.status, 202);
  assert.equal((await call("POST", "/api/profile?op=pair/approve", { credential, body: { requestId: secondClaim.body.requestId } })).status, 200);
  const phone = await call("POST", "/api/profile?op=pair/poll", { body: { requestId: claim.body.requestId, pollToken: claim.body.pollToken } });
  assert.equal(phone.status, 200);
  const usedRequestTTL = Number(await redisCommand(port, ["TTL", `profile:pair-request:v1:${claim.body.requestId}`]));
  assert.ok(usedRequestTTL > 0 && usedRequestTTL <= 10 * 60, `used pair request persisted too long: ${usedRequestTTL}s`);
  const secondPhone = await call("POST", "/api/profile?op=pair/poll", { body: { requestId: secondClaim.body.requestId, pollToken: secondClaim.body.pollToken } });
  assert.equal(secondPhone.status, 200, "claiming another phone must not delete an approved request that is still being polled");
  assert.equal((await call("GET", "/api/profile", { credential })).body.pendingPairings[claim.body.requestId], undefined);
  assert.equal((await call("GET", "/api/profile", { credential: phone.body.credential })).status, 200);

  let reachedCreateEval;
  const createReady = new Promise((resolve) => { reachedCreateEval = resolve; });
  let releaseCreateEval;
  const releaseCreate = new Promise((resolve) => { releaseCreateEval = resolve; });
  const delayedCreate = makeCall(port, async (command) => {
    if (command[0] === "EVAL" && String(command[1]).includes("profile:pair-create:v1")) { reachedCreateEval(); await releaseCreate; }
  });
  const racedCreatePromise = delayedCreate("POST", "/api/profile?op=pair/create", { credential: secondPhone.body.credential, body: { deviceName: "Revoked creator" } });
  await createReady;
  assert.equal((await call("POST", "/api/profile?op=revoke", { credential, body: { deviceId: secondPhone.body.deviceId } })).status, 200);
  releaseCreateEval();
  const racedCreate = await racedCreatePromise;
  assert.equal(racedCreate.status, 401, "pair creation Lua rechecks a caller revoked after the route read");

  const racePair = await call("POST", "/api/profile?op=pair/create", { credential, body: { deviceName: "Race phone" } });
  const raceClaim = await call("POST", "/api/profile?op=pair/claim", { body: { shortCode: racePair.body.shortCode, deviceName: "Race phone" } });
  let reachedApproveEval;
  const approveReady = new Promise((resolve) => { reachedApproveEval = resolve; });
  let releaseApproveEval;
  const release = new Promise((resolve) => { releaseApproveEval = resolve; });
  const delayedPhone = makeCall(port, async (command) => {
    if (command[0] === "EVAL" && String(command[1]).includes("profile:pair-approve:v1")) { reachedApproveEval(); await release; }
  });
  const racedApprovalPromise = delayedPhone("POST", "/api/profile?op=pair/approve", { credential: phone.body.credential, body: { requestId: raceClaim.body.requestId } });
  await approveReady;
  assert.equal((await call("POST", "/api/profile?op=revoke", { credential, body: { deviceId: phone.body.deviceId } })).status, 200);
  releaseApproveEval();
  const racedApproval = await racedApprovalPromise;
  assert.equal(racedApproval.status, 401, "Lua rechecks caller revocation after the authenticated route read");
  assert.equal((await call("POST", "/api/profile?op=pair/poll", { body: { requestId: raceClaim.body.requestId, pollToken: raceClaim.body.pollToken } })).status, 202);

  assert.equal((await call("GET", "/api/profile", { credential: phone.body.credential })).status, 401);
  assert.equal((await call("GET", "/api/profile?include=bootstrapToken", { credential })).body.bootstrapToken, "encrypted-integration-token");

  const stalePair = await call("POST", "/api/profile?op=pair/create", { credential, body: { deviceName: "Old phone" } });
  const staleRequest = await call("POST", "/api/profile?op=pair/claim", { body: { shortCode: stalePair.body.shortCode, deviceName: "Old phone" } });
  assert.ok((await call("GET", "/api/profile", { credential })).body.pendingPairings[staleRequest.body.requestId]);
  call.advance(10 * 60 * 1000 + 1);
  assert.equal((await call("GET", "/api/profile", { credential })).body.pendingPairings[staleRequest.body.requestId], undefined);
  const freshPair = await call("POST", "/api/profile?op=pair/create", { credential, body: { deviceName: "New phone" } });
  const freshRequest = await call("POST", "/api/profile?op=pair/claim", { body: { shortCode: freshPair.body.shortCode, deviceName: "New phone" } });
  const afterCleanup = await call("GET", "/api/profile", { credential });
  assert.deepEqual(Object.keys(afterCleanup.body.pendingPairings), [freshRequest.body.requestId]);

  const expired = await call("POST", "/api/profile?op=pair/create", { credential, body: { deviceName: "Tablet" } });
  const tokenHash = crypto.createHash("sha256").update(expired.body.requestToken).digest("hex");
  await redisCommand(port, ["EXPIRE", `profile:pair-code:v1:${expired.body.shortCode}`, "0"]);
  await redisCommand(port, ["EXPIRE", `profile:pair-token:v1:${tokenHash}`, "0"]);
  const expiredClaim = await call("POST", "/api/profile?op=pair/claim", { body: { shortCode: expired.body.shortCode } });
  assert.equal(expiredClaim.status, 410);

  const expiresWhileApproved = await call("POST", "/api/profile?op=pair/create", { credential, body: { deviceName: "Late poll" } });
  const lateClaim = await call("POST", "/api/profile?op=pair/claim", { body: { shortCode: expiresWhileApproved.body.shortCode, deviceName: "Late poll" } });
  call.advance(590_000);
  assert.equal((await call("POST", "/api/profile?op=pair/approve", { credential, body: { requestId: lateClaim.body.requestId } })).status, 200);
  call.advance(20_001);
  const latePoll = await call("POST", "/api/profile?op=pair/poll", { body: { requestId: lateClaim.body.requestId, pollToken: lateClaim.body.pollToken } });
  assert.equal(latePoll.status, 410, "approval must not extend a pairing beyond its original expiresAt");

  const expiresBeforeApproval = await call("POST", "/api/profile?op=pair/create", { credential, body: { deviceName: "Late approval" } });
  const lateApprovalClaim = await call("POST", "/api/profile?op=pair/claim", { body: { shortCode: expiresBeforeApproval.body.shortCode, deviceName: "Late approval" } });
  call.advance(600_001);
  await redisCommand(port, ["EXPIRE", `profile:pair-request:v1:${lateApprovalClaim.body.requestId}`, "600"]);
  const lateApproval = await call("POST", "/api/profile?op=pair/approve", { credential, body: { requestId: lateApprovalClaim.body.requestId } });
  assert.equal(lateApproval.status, 410, "approval Lua rejects requests past logical expiresAt even when Redis TTL is renewed");
});
