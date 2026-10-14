import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { createProfileHandler } from "../api/_lib/_profile.mjs";

const token = process.env.PROFILE_BLOB_TEST_TOKEN || "";
const secret = process.env.PROFILE_DATA_SECRET || "";
const enabled = token.length > 20 && /^[0-9a-f]{64}$/i.test(secret);

function call(handler, method, url, { body, credential, ip }) {
  return new Promise(async (resolve) => {
    let status = 200;
    let payload;
    const headers = { "x-real-ip": ip };
    if (credential) headers.authorization = `Bearer ${credential}`;
    await handler({ method, url, headers, body }, {
      setHeader() {},
      status(code) { status = code; return this; },
      json(value) { payload = value; resolve({ status, body: payload }); return this; },
      end() { resolve({ status, body: payload }); return this; },
    });
  });
}

test("linked private Blob store persists profile data through the SDK and cleans up only test objects", { skip: !enabled }, async (t) => {
  const sdk = await import("@vercel/blob");
  const ip = `2001:db8:${crypto.randomBytes(6).toString("hex")}`;
  const ipHash = crypto.createHash("sha256").update(ip).digest("hex");
  const cleanupPaths = [
    `personal-cinema/v1/rates/create/${ipHash}.json`,
    `personal-cinema/v1/rates/claim/${ipHash}.json`,
    `personal-cinema/v1/rates/poll/${ipHash}.json`,
  ];
  t.after(async () => {
    if (cleanupPaths.length) await sdk.del(cleanupPaths, { access: "private", token });
  });
  const env = { PROFILE_STORAGE_BACKEND: "blob", PROFILE_DATA_SECRET: secret, BLOB_READ_WRITE_TOKEN: token };
  const diagnostics = [];
  const handler = createProfileHandler({ env, onStorageDiagnostic: (label, detail) => diagnostics.push({ label, ...detail }) });
  const created = await call(handler, "POST", "/api/profile", { ip, body: { tmdbToken: "qa-only-profile-token", deviceName: "Isolated SDK QA" } });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const credentialHash = crypto.createHash("sha256").update(created.body.credential).digest("hex");
  cleanupPaths.push(`personal-cinema/v1/profiles/${created.body.profileId}.json`, `personal-cinema/v1/credentials/${credentialHash}.json`);
  const profile = await call(handler, "GET", "/api/profile", { ip, credential: created.body.credential });
  assert.equal(profile.status, 200, JSON.stringify(profile.body));
  const bootstrap = await call(handler, "GET", "/api/profile?include=bootstrapToken", { ip, credential: created.body.credential });
  assert.equal(bootstrap.status, 200, JSON.stringify(bootstrap.body));
  assert.equal(bootstrap.body.bootstrapToken, "qa-only-profile-token");

  const pairing = await call(handler, "POST", "/api/profile?op=pair/create", { ip, credential: created.body.credential, body: { deviceName: "Isolated SDK phone" } });
  assert.equal(pairing.status, 201, JSON.stringify(pairing.body));
  const tokenHash = crypto.createHash("sha256").update(pairing.body.requestToken).digest("hex");
  cleanupPaths.push(`personal-cinema/v1/pair-codes/${pairing.body.shortCode}.json`, `personal-cinema/v1/pair-tokens/${tokenHash}.json`);
  const claim = await call(handler, "POST", "/api/profile?op=pair/claim", { ip, body: { shortCode: pairing.body.shortCode, deviceName: "Isolated SDK phone", claimId: crypto.randomUUID() } });
  assert.equal(claim.status, 202, JSON.stringify(claim.body));
  cleanupPaths.push(`personal-cinema/v1/pair-requests/${claim.body.requestId}.json`);
  const approve = await call(handler, "POST", "/api/profile?op=pair/approve", { ip, credential: created.body.credential, body: { requestId: claim.body.requestId } });
  assert.equal(approve.status, 200, `${JSON.stringify(approve.body)} diagnostics=${JSON.stringify(diagnostics)}`);
  const grant = await call(handler, "POST", "/api/profile?op=pair/poll", { ip, body: { requestId: claim.body.requestId, pollToken: claim.body.pollToken } });
  assert.equal(grant.status, 200, JSON.stringify(grant.body));
  const phoneCredentialHash = crypto.createHash("sha256").update(grant.body.credential).digest("hex");
  cleanupPaths.push(`personal-cinema/v1/credentials/${phoneCredentialHash}.json`);

  const movie = { type: "movie", id: "blob-sdk-qa", title: "Isolated SDK QA" };
  const phoneSnapshot = await call(handler, "GET", "/api/profile", { ip, credential: grant.body.credential });
  assert.equal(phoneSnapshot.status, 200, JSON.stringify(phoneSnapshot.body));
  const mutation = await call(handler, "PATCH", "/api/profile", { ip, credential: grant.body.credential, body: {
    mutationId: crypto.randomUUID(), deviceId: grant.body.deviceId,
    checkpoints: [{ progressKey: "movie_blob-sdk-qa", item: movie, position: 42, duration: 120, preferences: {}, baseRevision: phoneSnapshot.body.revision }],
  } });
  assert.equal(mutation.status, 200, JSON.stringify(mutation.body));
  assert.equal(mutation.body.snapshot.checkpoints["movie_blob-sdk-qa"].position, 42);
  const cleared = await call(handler, "POST", "/api/profile?op=watch/clear", { ip, credential: grant.body.credential, body: { mutationId: crypto.randomUUID(), deviceId: grant.body.deviceId } });
  assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
  assert.equal(cleared.body.snapshot.checkpoints["movie_blob-sdk-qa"], undefined);
  const revoked = await call(handler, "POST", "/api/profile?op=revoke", { ip, credential: created.body.credential, body: { deviceId: grant.body.deviceId } });
  assert.equal(revoked.status, 200, JSON.stringify(revoked.body));
  const rejectedPhone = await call(handler, "GET", "/api/profile", { ip, credential: grant.body.credential });
  assert.equal(rejectedPhone.status, 401);
});
