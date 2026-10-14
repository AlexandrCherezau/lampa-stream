import crypto from "node:crypto";
import {
  PROFILE_MAX_BYTES,
  PROFILE_TTL_SECONDS,
  PAIR_TTL_SECONDS,
  ProfileError,
  boundedString,
  decryptToken,
  encryptToken,
  fail,
  finite,
  isRecord,
  mergeProfileSnapshot,
  publicSnapshot as basePublicSnapshot,
  uuid,
  validateCheckpoint,
  validateLibrary,
  validateSession,
} from "./_profile.mjs";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
  "Cache-Control": "no-store",
  Vary: "Authorization",
};
const MAX_CAS_ATTEMPTS = 12;
const LIVE_REQUESTS_LIMIT = 16;
const LIVE_OFFERS_LIMIT = 32;
const ID_RE = /^[a-zA-Z0-9:_-]{1,120}$/;
const SAFE_ERROR_CODES = new Set(["BLOB_PRECONDITION_FAILED", "BLOB_ALREADY_EXISTS", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN", "ECONNRESET", "ECONNREFUSED", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT"]);

const sha = (value) => crypto.createHash("sha256").update(value).digest("hex");
const mac = (key, value, encoding = "base64url") => crypto.createHmac("sha256", key).update(value).digest(encoding);
const profilePath = (profileId) => `personal-cinema/v1/profiles/${profileId}.json`;
const credentialPath = (hash) => `personal-cinema/v1/credentials/${hash}.json`;
const pairTokenPath = (hash) => `personal-cinema/v1/pair-tokens/${hash}.json`;
const pairCodePath = (code) => `personal-cinema/v1/pair-codes/${code}.json`;
const pairRequestPath = (requestId) => `personal-cinema/v1/pair-requests/${requestId}.json`;
const ratePath = (bucket, hash) => `personal-cinema/v1/rates/${bucket}/${hash}.json`;
const failStorage = () => fail(503, "profile_storage_unavailable");

function publicSnapshot(profile, timestamp = Date.now()) {
  const snapshot = basePublicSnapshot(profile, timestamp);
  snapshot.syncPolicy = { backgroundFlushMs: 300_000, pollIntervalMs: 120_000 };
  return snapshot;
}

function prunePairingState(profile, timestamp) {
  const cleanupPaths = [];
  for (const [tokenHash, offer] of Object.entries(profile.pairOffers || {})) {
    if (Number(offer.expiresAt) > timestamp) continue;
    delete profile.pairOffers[tokenHash];
    cleanupPaths.push(pairTokenPath(tokenHash));
    if (typeof offer.shortCode === "string" && /^[A-HJ-NP-Z2-9]{8}$/.test(offer.shortCode)) cleanupPaths.push(pairCodePath(offer.shortCode));
  }
  for (const [requestId, request] of Object.entries(profile.pendingPairings || {})) {
    if (Number(request.expiresAt) > timestamp) continue;
    delete profile.pendingPairings[requestId];
    cleanupPaths.push(pairRequestPath(requestId));
  }
  return cleanupPaths;
}

function randomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return [...crypto.randomBytes(8)].map((byte) => alphabet[byte % alphabet.length]).join("");
}

function profileMasterKey(env) {
  const value = env.PROFILE_DATA_SECRET || "";
  if (!/^[0-9a-f]{64}$/i.test(value)) fail(503, "profile_encryption_unavailable");
  return Buffer.from(value, "hex");
}

function requestIp(req) {
  const forwarded = req.headers?.["x-forwarded-for"] || "";
  return String(req.headers?.["x-real-ip"] || forwarded.split(",").at(-1) || req.ip || "unknown").trim().slice(0, 80);
}

function query(req) {
  const url = new URL(req.url || "/api/profile", "https://local.invalid");
  return { op: url.searchParams.get("op") || "", include: url.searchParams.get("include") || "" };
}

function send(res, status, body) {
  return res.status(status).json(body);
}

function responseStatus(error) {
  if (error instanceof ProfileError) return error.status;
  return 503;
}

function responseCode(error) {
  if (error instanceof ProfileError) return error.code;
  return "profile_storage_unavailable";
}

function isConflict(error) {
  return error?.name === "BlobPreconditionFailedError" || error?.name === "BlobAlreadyExistsError" ||
    error?.code === "BLOB_PRECONDITION_FAILED" || error?.code === "BLOB_ALREADY_EXISTS" ||
    error?.status === 409 || error?.status === 412 || /\bconflict\b|precondition|etag.{0,16}(?:mismatch|match)|if.?match/i.test(String(error?.message || ""));
}

function objectKind(path) {
  for (const kind of ["profiles", "credentials", "pair-tokens", "pair-codes", "pair-requests", "rates"]) {
    if (path.startsWith(`personal-cinema/v1/${kind}/`)) return kind;
  }
  return "other";
}

function createStoreAccess(store, diagnose) {
  async function getJson(path) {
    let result;
    try { result = await store.get(path, { access: "private", useCache: false }); }
    catch (error) { diagnose("get", path, error); failStorage(); }
    if (!result) return null;
    if (result.statusCode !== 200 || !result.stream || !result.blob?.etag) { diagnose("get_response", path, null, result.statusCode); failStorage(); }
    if (Number(result.blob.size) > PROFILE_MAX_BYTES) failStorage();
    let raw;
    try { raw = await new Response(result.stream).text(); } catch (error) { diagnose("get_body", path, error); failStorage(); }
    if (Buffer.byteLength(raw) > PROFILE_MAX_BYTES) failStorage();
    let value;
    try { value = JSON.parse(raw); } catch (error) { diagnose("get_json", path, error); failStorage(); }
    if (!isRecord(value)) { diagnose("get_json_shape", path); failStorage(); }
    return { value, etag: result.blob.etag };
  }

  async function putJson(path, value, etag, expectedValue) {
    const encoded = JSON.stringify(value);
    if (Buffer.byteLength(encoded) > PROFILE_MAX_BYTES) fail(413, "profile_too_large");
    const options = { access: "private", addRandomSuffix: false, allowOverwrite: false, contentType: "application/json" };
    if (etag) {
      options.allowOverwrite = true;
      try {
        const latest = await getJson(path);
        if (!latest || (expectedValue && JSON.stringify(latest.value) !== JSON.stringify(expectedValue))) return false;
        const metadata = typeof store.head === "function" ? await store.head(path, { access: "private" }) : null;
        const confirmed = await getJson(path);
        if (!confirmed || (expectedValue && JSON.stringify(confirmed.value) !== JSON.stringify(expectedValue))) return false;
        options.ifMatch = metadata?.etag || latest.etag;
      } catch (error) {
        diagnose("head", path, error);
        failStorage();
      }
    }
    try {
      await store.put(path, encoded, options);
      return true;
    } catch (error) {
      if (isConflict(error)) {
        let latestMatchesExpected;
        if (diagnose.inspectConflicts) {
          try {
            const latest = await store.get(path, { access: "private", useCache: false });
            latestMatchesExpected = !!latest && latest.blob?.etag === options.ifMatch;
          } catch {}
        }
        diagnose("put_conflict", path, error, undefined, { ifMatchProvided: !!options.ifMatch, ...(latestMatchesExpected == null ? {} : { latestMatchesExpected }) });
        return false;
      }
      diagnose("put", path, error);
      failStorage();
    }
  }

  async function deleteObjects(paths) {
    if (!paths.length || typeof store.del !== "function") return;
    try { await store.del(paths, { access: "private" }); } catch (error) { diagnose("delete", paths[0], error); }
  }

  return { getJson, putJson, deleteObjects };
}

async function loadBlobStore(options, env) {
  if (options.blobStore) return options.blobStore;
  if (options.blob) return options.blob;
  if (!env.BLOB_READ_WRITE_TOKEN && !(env.VERCEL_OIDC_TOKEN && env.BLOB_STORE_ID)) failStorage();
  try {
    const sdk = await import("@vercel/blob");
    const tokenOption = env.BLOB_READ_WRITE_TOKEN ? { token: env.BLOB_READ_WRITE_TOKEN } : {};
    return {
      get: (pathname, options) => sdk.get(pathname, { ...options, ...tokenOption }),
      head: (pathname, options) => sdk.head(pathname, { ...options, ...tokenOption }),
      put: (pathname, body, options) => sdk.put(pathname, body, { ...options, ...tokenOption }),
      del: (pathnames, options) => sdk.del(pathnames, { ...options, ...tokenOption }),
    };
  } catch { failStorage(); }
}

export function createBlobProfileHandler(options = {}) {
  const env = options.env || process.env;
  const now = options.now || (() => Date.now());
  const diagnose = (operation, path, error, statusCode, extra = {}) => {
    const code = SAFE_ERROR_CODES.has(error?.code) ? error.code : undefined;
    const name = typeof error?.name === "string" && /^[A-Za-z][A-Za-z0-9]{0,48}$/.test(error.name) ? error.name : undefined;
    const status = Number.isInteger(error?.status) ? error.status : Number.isInteger(error?.statusCode) ? error.statusCode : Number.isInteger(statusCode) ? statusCode : undefined;
    const causeCode = SAFE_ERROR_CODES.has(error?.cause?.code) ? error.cause.code : undefined;
    const causeName = typeof error?.cause?.name === "string" && /^[A-Za-z][A-Za-z0-9]{0,48}$/.test(error.cause.name) ? error.cause.name : undefined;
    const message = typeof error?.message === "string" ? error.message.toLowerCase() : "";
    const embeddedStatus = Number(message.match(/\b(?:status|http)\D{0,8}(\d{3})\b/)?.[1]);
    const messageClass = /etag|precondition|if.?match/.test(message) ? "conditional_write" : /fetch|network|socket|connect|dns/.test(message) ? "network" : /token|auth|unauthorized/.test(message) ? "authentication" : /rate.?limit|too many/.test(message) ? "rate_limit" : /not found|missing/.test(message) ? "missing_object" : /permission|forbidden/.test(message) ? "permission" : message ? "other" : undefined;
    const messageSignals = {
      mentionsEtag: /etag|entity.tag/.test(message),
      mentionsIfMatch: /if.?match/.test(message),
      mentionsOverwrite: /overwrite/.test(message),
      mentionsExists: /already exists|already present/.test(message),
      mentionsConflict: /conflict|precondition/.test(message),
    };
    const errorKeys = error && typeof error === "object" ? Object.getOwnPropertyNames(error).filter((key) => /^[A-Za-z][A-Za-z0-9]{0,32}$/.test(key)).sort() : [];
    const detail = { operation, objectKind: objectKind(path), ...(name ? { errorName: name } : {}), ...(code ? { errorCode: code } : {}), ...(status ? { statusCode: status } : {}), ...(Number.isInteger(embeddedStatus) ? { embeddedStatus } : {}), ...(causeName ? { causeName } : {}), ...(causeCode ? { causeCode } : {}), ...(messageClass ? { messageClass } : {}), ...(errorKeys.length ? { errorKeys } : {}), ...(error ? { messageSignals } : {}), ...extra };
    try {
      if (typeof options.onStorageDiagnostic === "function") options.onStorageDiagnostic("profile_blob_diagnostic", detail, error);
      else console.error("profile_blob_diagnostic", JSON.stringify(detail));
    } catch {}
  };
  diagnose.inspectConflicts = typeof options.onStorageDiagnostic === "function";
  let storeAccessPromise;

  async function storage() {
    if (!storeAccessPromise) storeAccessPromise = loadBlobStore(options, env).then((store) => createStoreAccess(store, diagnose));
    return storeAccessPromise;
  }

  async function getObject(path) {
    const client = await storage();
    return client.getJson(path);
  }

  async function putObject(path, value, etag, expectedValue) {
    const client = await storage();
    return client.putJson(path, value, etag, expectedValue);
  }

  async function deleteObjects(paths) {
    const client = await storage();
    await client.deleteObjects(paths);
  }

  async function getProfile(profileId) {
    const found = await getObject(profilePath(profileId));
    if (!found || found.value.profileId !== profileId) fail(404, "profile_not_found");
    if (Number(found.value.expiresAt || 0) <= now()) fail(404, "profile_not_found");
    return found;
  }

  function assertDevice(profile, deviceId, bearerHash) {
    const device = profile.devices?.[deviceId];
    if (!device?.active || device.credentialHash !== bearerHash) fail(401, "unauthorized");
    return device;
  }

  async function authenticate(req) {
    const authorization = req.headers?.authorization || "";
    const bearer = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (!/^[A-Za-z0-9_-]{40,80}$/.test(bearer)) fail(401, "unauthorized");
    const bearerHash = sha(bearer);
    const locator = await getObject(credentialPath(bearerHash));
    if (!locator || typeof locator.value.profileId !== "string" || typeof locator.value.deviceId !== "string") fail(401, "unauthorized");
    const profile = await getProfile(locator.value.profileId);
    assertDevice(profile.value, locator.value.deviceId, bearerHash);
    return { profile: profile.value, profileId: locator.value.profileId, deviceId: locator.value.deviceId, bearerHash };
  }

  async function mutateProfile(profileId, caller, mutate) {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const current = await getProfile(profileId);
      if (caller) assertDevice(current.value, caller.deviceId, caller.bearerHash);
      const next = structuredClone(current.value);
      const outcome = await mutate(next, current.value);
      const timestamp = now();
      const cleanupPaths = prunePairingState(next, timestamp);
      if (outcome?.write === false && cleanupPaths.length === 0) return { profile: current.value, value: outcome.value };
      next.revision = (Number(current.value.revision) || 0) + 1;
      next.updatedAt = timestamp;
      next.expiresAt = timestamp + PROFILE_TTL_SECONDS * 1000;
      const written = await putObject(profilePath(profileId), next, current.etag, current.value);
      if (written) {
        await deleteObjects(cleanupPaths);
        return { profile: next, value: outcome?.value };
      }
      await new Promise((resolve) => setTimeout(resolve, 60 + 30 * attempt + Math.random() * 100));
    }
    diagnose("cas_conflict", profilePath(profileId));
    failStorage();
  }

  async function createOnly(path, value) {
    return putObject(path, value, null);
  }

  async function writeLocator(path, value) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const existing = await getObject(path);
      if (existing) {
        if (JSON.stringify(existing.value) === JSON.stringify(value)) return;
        failStorage();
      }
      if (await createOnly(path, value)) return;
    }
    failStorage();
  }

  async function consumeRateLimit(req, bucket, limit, windowSeconds) {
    const key = ratePath(bucket, sha(requestIp(req)));
    const windowMs = windowSeconds * 1000;
    const windowStart = Math.floor(now() / windowMs) * windowMs;
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const current = await getObject(key);
      const currentValue = current?.value;
      const active = currentValue && Number(currentValue.windowStart) === windowStart;
      const count = active ? Number(currentValue.count) || 0 : 0;
      if (count >= limit) fail(429, "too_many_attempts");
      const next = { windowStart, count: count + 1, expiresAt: windowStart + windowMs };
      const written = await putObject(key, next, current?.etag, current?.value);
      if (written) return;
    }
    failStorage();
  }

  async function resolvePairOffer(requestTokenOrCode) {
    if (typeof requestTokenOrCode.requestToken === "string" && /^[A-Za-z0-9_-]{40,80}$/.test(requestTokenOrCode.requestToken)) {
      const tokenHash = sha(requestTokenOrCode.requestToken);
      const locator = await getObject(pairTokenPath(tokenHash));
      if (!locator || locator.value.tokenHash !== tokenHash || Number(locator.value.expiresAt) <= now()) fail(410, "pairing_expired");
      return { ...locator.value, tokenHash };
    }
    const code = String(requestTokenOrCode.shortCode || "").toUpperCase();
    if (!/^[A-HJ-NP-Z2-9]{8}$/.test(code)) fail(404, "pairing_not_found");
    const locator = await getObject(pairCodePath(code));
    if (!locator || Number(locator.value.expiresAt) <= now() || !/^[a-f0-9]{64}$/.test(locator.value.tokenHash || "")) fail(410, "pairing_expired");
    return { ...locator.value, tokenHash: locator.value.tokenHash };
  }

  return async function blobProfileHandler(req, res) {
    for (const [key, value] of Object.entries(CORS)) res.setHeader(key, value);
    if (req.method === "OPTIONS") return res.status(204).end();
    try {
      const { op, include } = query(req);
      const body = isRecord(req.body) ? req.body : {};

      if (req.method === "POST" && !op) {
        await consumeRateLimit(req, "create", 8, 3600);
        const displayName = body.displayName == null ? "" : boundedString(body.displayName, 60, "display_name");
        const deviceName = body.deviceName == null ? "This device" : boundedString(body.deviceName, 60, "device_name");
        const tmdbToken = body.tmdbToken == null ? "" : boundedString(body.tmdbToken, 512, "tmdb_token");
        if (!tmdbToken) fail(400, "tmdb_token_required");
        profileMasterKey(env);
        const profileId = crypto.randomBytes(16).toString("hex");
        const deviceId = crypto.randomBytes(12).toString("hex");
        const credential = crypto.randomBytes(32).toString("base64url");
        const credentialHash = sha(credential);
        const timestamp = now();
        const profile = {
          schema: 1, profileId, revision: 0, watchResetRevision: 0, watchClearedAt: 0,
          displayName, createdAt: timestamp, updatedAt: timestamp, expiresAt: timestamp + PROFILE_TTL_SECONDS * 1000,
          devices: { [deviceId]: { deviceId, name: deviceName, active: true, createdAt: timestamp, credentialHash } },
          pendingPairings: {}, pairOffers: {}, checkpoints: {}, sessions: {},
          mutationReceipts: {}, mutationOrder: [],
          library: { saved: {}, watched: {}, history: {}, ratings: {} },
          tmdbTokenCiphertext: encryptToken(tmdbToken, env),
        };
        await writeLocator(credentialPath(credentialHash), { profileId, deviceId });
        if (!(await createOnly(profilePath(profileId), profile))) failStorage();
        return send(res, 201, { credential, profileId, deviceId, revision: 0, snapshot: publicSnapshot(profile, now()) });
      }

      if (req.method === "POST" && op === "pair/claim") {
        await consumeRateLimit(req, "claim", 12, 60);
        const deviceName = body.deviceName == null ? "Device" : boundedString(body.deviceName, 60, "device_name");
        const claimId = uuid(body.claimId, "claim_id");
        const offer = await resolvePairOffer({ requestToken: body.requestToken, shortCode: body.shortCode });
        const key = profileMasterKey(env);
        const requestId = mac(key, `pair-request:${offer.tokenHash}:${claimId}`, "hex").slice(0, 24);
        const pollToken = mac(key, `pair-poll:${requestId}`);
        const claimIdHash = sha(claimId);
        const timestamp = now();
        const updated = await mutateProfile(offer.profileId, null, (profile) => {
          const activeOffer = profile.pairOffers?.[offer.tokenHash];
          if (!activeOffer || activeOffer.tokenHash !== offer.tokenHash || Number(activeOffer.expiresAt) <= timestamp) fail(410, "pairing_expired");
          profile.pendingPairings ||= {};
          const existing = profile.pendingPairings[requestId];
          if (existing) {
            if (existing.claimIdHash !== claimIdHash || existing.pollTokenHash !== sha(pollToken)) fail(409, "pairing_already_claimed");
            return { write: false, value: existing };
          }
          if (activeOffer.claimed) fail(409, "pairing_already_claimed");
          const pendingCount = Object.values(profile.pendingPairings).filter((request) => request.status === "pending" && Number(request.expiresAt) > timestamp).length;
          if (pendingCount >= LIVE_REQUESTS_LIMIT) fail(429, "too_many_pending_pairings");
          const request = {
            requestId, profileId: profile.profileId, deviceName, status: "pending",
            tokenHash: offer.tokenHash, claimIdHash, pollTokenHash: sha(pollToken), createdAt: timestamp,
            expiresAt: Math.min(Number(activeOffer.expiresAt), timestamp + PAIR_TTL_SECONDS * 1000),
          };
          activeOffer.claimed = true;
          profile.pendingPairings[requestId] = request;
          return { value: request };
        });
        await writeLocator(pairRequestPath(requestId), { profileId: offer.profileId, requestId });
        return send(res, 202, { requestId, pollToken, status: "pending", expiresAt: updated.value.expiresAt });
      }

      if (req.method === "POST" && op === "pair/poll") {
        await consumeRateLimit(req, "poll", 60, 60);
        const requestId = boundedString(body.requestId, 120, "request_id");
        if (!ID_RE.test(requestId)) fail(400, "invalid_request_id");
        const pollToken = boundedString(body.pollToken || body.requestToken, 80, "poll_token");
        const locator = await getObject(pairRequestPath(requestId));
        if (!locator || typeof locator.value.profileId !== "string") fail(410, "pairing_expired");
        const found = await getProfile(locator.value.profileId);
        const initialRequest = found.value.pendingPairings?.[requestId];
        if (!initialRequest || Number(initialRequest.expiresAt) <= now()) fail(410, "pairing_expired");
        if (initialRequest.pollTokenHash !== sha(pollToken)) fail(401, "invalid_pairing_token");
        if (initialRequest.status === "pending") return send(res, 202, { status: "pending" });
        if (initialRequest.status !== "approved" && initialRequest.status !== "used") fail(410, "pairing_expired");
        const key = profileMasterKey(env);
        const deterministicCredential = mac(key, `pair-credential:${requestId}`);
        const credentialHash = sha(deterministicCredential);
        const deviceId = mac(key, `pair-device:${requestId}`, "hex").slice(0, 24);
        if (initialRequest.status === "used") {
          const device = found.value.devices?.[deviceId];
          if (!initialRequest.credentialIssued || initialRequest.deviceId !== deviceId || !device?.active || device.credentialHash !== credentialHash) fail(410, "pairing_already_used");
        }
        await writeLocator(credentialPath(credentialHash), { profileId: locator.value.profileId, deviceId });
        const updated = await mutateProfile(locator.value.profileId, null, (profile) => {
          const request = profile.pendingPairings?.[requestId];
          if (!request || Number(request.expiresAt) <= now()) fail(410, "pairing_expired");
          if (request.pollTokenHash !== sha(pollToken)) fail(401, "invalid_pairing_token");
          if (request.status === "pending") return { write: false, value: { status: "pending" } };
          const device = profile.devices?.[deviceId];
          if (request.status === "used" || request.credentialIssued) {
            if (!device?.active || device.credentialHash !== credentialHash) fail(410, "pairing_already_used");
            return { write: false, value: { status: "issued", deviceId } };
          }
          if (request.status !== "approved") fail(410, "pairing_expired");
          if (device) fail(409, "pairing_already_used");
          profile.devices[deviceId] = { deviceId, name: request.deviceName, active: true, createdAt: now(), credentialHash };
          request.status = "used";
          request.credentialIssued = true;
          request.deviceId = deviceId;
          request.issuedAt = now();
          return { value: { status: "issued", deviceId } };
        });
        if (updated.value.status === "pending") return send(res, 202, { status: "pending" });
        return send(res, 200, {
          status: "approved", credential: deterministicCredential,
          profileId: updated.profile.profileId, deviceId, revision: updated.profile.revision,
          snapshot: publicSnapshot(updated.profile, now()),
        });
      }

      const auth = await authenticate(req);
      if (req.method === "GET") {
        const snapshot = publicSnapshot(auth.profile, now());
        if (include === "bootstrapToken") {
          let tmdbToken;
          try { tmdbToken = decryptToken(auth.profile.tmdbTokenCiphertext, env); } catch { fail(503, "profile_encryption_unavailable"); }
          return send(res, 200, { ...snapshot, bootstrapToken: tmdbToken });
        }
        return send(res, 200, snapshot);
      }

      if (req.method === "PATCH" && !op) {
        const mutationId = uuid(body.mutationId, "mutation_id");
        const deviceId = boundedString(body.deviceId, 64, "device_id");
        if (deviceId !== auth.deviceId) fail(403, "device_mismatch");
        const checkpoints = body.checkpoints == null ? [] : body.checkpoints;
        const sessions = body.sessions == null ? [] : body.sessions;
        const supersedesRaw = body.supersedesMutationIds == null ? [] : body.supersedesMutationIds;
        if (!Array.isArray(checkpoints) || checkpoints.length > 80) fail(400, "invalid_checkpoints");
        if (!Array.isArray(sessions) || sessions.length > 80) fail(400, "invalid_sessions");
        if (!Array.isArray(supersedesRaw) || supersedesRaw.length > 30) fail(400, "invalid_supersedes_mutations");
        const patch = {
          mutationId,
          supersedesMutationIds: [...new Set(supersedesRaw.map((value) => uuid(value, "supersedes_mutation_id")))],
          ...(body.displayName !== undefined ? { displayName: boundedString(body.displayName, 60, "display_name") } : {}),
          checkpoints: checkpoints.map(validateCheckpoint),
          sessions: sessions.map(validateSession),
          library: validateLibrary(body.library) || {},
        };
        const encoded = JSON.stringify(patch);
        if (Buffer.byteLength(encoded) > 200_000) fail(413, "patch_too_large");
        const merged = await mutateProfile(auth.profileId, auth, (profile) => {
          const next = mergeProfileSnapshot(profile, patch, { deviceId: auth.deviceId, now: now() });
          if (next === profile || next.revision === profile.revision) return { write: false, value: undefined };
          Object.assign(profile, next);
          return { value: undefined };
        });
        return send(res, 200, { revision: merged.profile.revision, snapshot: publicSnapshot(merged.profile, now()) });
      }

      if (req.method === "POST" && op === "watch/clear") {
        const mutationId = uuid(body.mutationId, "mutation_id");
        const deviceId = boundedString(body.deviceId, 64, "device_id");
        if (deviceId !== auth.deviceId) fail(403, "device_mismatch");
        const timestamp = now();
        const requestedAt = body.clearedAt == null ? timestamp : finite(body.clearedAt, "cleared_at", 0, timestamp + 5 * 60 * 1000);
        const cleared = await mutateProfile(auth.profileId, auth, (profile) => {
          if (profile.mutationReceipts?.[mutationId] || profile.watchClearMutationId === mutationId || requestedAt <= (Number(profile.watchClearedAt) || 0)) return { write: false };
          const cutoff = Math.min(requestedAt, now());
          profile.checkpoints = {};
          profile.sessions = {};
          profile.library.history = {};
          profile.library.watched = {};
          profile.watchResetRevision = (Number(profile.revision) || 0) + 1;
          profile.watchClearedAt = cutoff;
          profile.watchClearMutationId = mutationId;
          profile.mutationReceipts ||= {};
          profile.mutationOrder ||= [];
          profile.mutationReceipts[mutationId] = { revision: profile.watchResetRevision, deviceId };
          profile.mutationOrder.push(mutationId);
          while (profile.mutationOrder.length > 128) delete profile.mutationReceipts[profile.mutationOrder.shift()];
          return { value: undefined };
        });
        return send(res, 200, { ok: true, revision: cleared.profile.revision, snapshot: publicSnapshot(cleared.profile, now()) });
      }

      if (req.method === "POST" && op === "pair/create") {
        const deviceName = body.deviceName == null ? "Device" : boundedString(body.deviceName, 60, "device_name");
        const requestToken = crypto.randomBytes(32).toString("base64url");
        const tokenHash = sha(requestToken);
        const offerExpiresAt = now() + PAIR_TTL_SECONDS * 1000;
        let shortCode;
        let storedCode = false;
        for (let attempt = 0; attempt < 5 && !storedCode; attempt += 1) {
          shortCode = randomCode();
          storedCode = await createOnly(pairCodePath(shortCode), { profileId: auth.profileId, tokenHash, expiresAt: offerExpiresAt });
        }
        if (!storedCode) failStorage();
        const offer = { tokenHash, shortCode, deviceName, createdAt: now(), expiresAt: offerExpiresAt, claimed: false };
        try {
          await writeLocator(pairTokenPath(tokenHash), { profileId: auth.profileId, tokenHash, expiresAt: offerExpiresAt });
          await mutateProfile(auth.profileId, auth, (profile) => {
            profile.pairOffers ||= {};
            const liveOffers = Object.values(profile.pairOffers).filter((entry) => Number(entry.expiresAt) > now()).length;
            if (liveOffers >= LIVE_OFFERS_LIMIT) fail(429, "too_many_pairing_offers");
            profile.pairOffers[tokenHash] = offer;
            return { value: undefined };
          });
        } catch (error) {
          await deleteObjects([pairCodePath(shortCode), pairTokenPath(tokenHash)]);
          throw error;
        }
        return send(res, 201, { requestToken, shortCode, expiresAt: offerExpiresAt });
      }

      if (req.method === "POST" && op === "pair/approve") {
        const requestId = boundedString(body.requestId, 120, "request_id");
        if (!ID_RE.test(requestId)) fail(400, "invalid_request_id");
        const updated = await mutateProfile(auth.profileId, auth, (profile) => {
          const request = profile.pendingPairings?.[requestId];
          if (!request || Number(request.expiresAt) <= now()) fail(410, "pairing_expired");
          if (request.status === "approved") return { write: false };
          if (request.status !== "pending") fail(409, "pairing_not_pending");
          request.status = "approved";
          request.approvedAt = now();
          return { value: undefined };
        });
        return send(res, 200, { ok: true, revision: updated.profile.revision });
      }

      if (req.method === "POST" && op === "revoke") {
        const deviceId = boundedString(body.deviceId, 64, "device_id");
        if (deviceId === auth.deviceId) fail(400, "cannot_revoke_current_device");
        const revoked = await mutateProfile(auth.profileId, auth, (profile) => {
          const target = profile.devices?.[deviceId];
          if (!target?.active) fail(404, "device_not_found");
          target.active = false;
          target.revokedAt = now();
          return { value: undefined };
        });
        return send(res, 200, { ok: true, snapshot: publicSnapshot(revoked.profile, now()) });
      }
      fail(405, "method_not_allowed");
    } catch (error) {
      return send(res, responseStatus(error), { error: responseCode(error) });
    }
  };
}
