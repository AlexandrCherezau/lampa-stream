import test from "node:test";
import assert from "node:assert/strict";
import { createSourceSession } from "../src/utils/source-host-client.js";

const candidate = (id, voiceId, voiceName) => ({
  id, providerId: "habster:alloha", providerName: "Habster · Alloha", voiceId, voiceName,
});
const result = (quality = "720p") => ({
  kind: "hls", selected: { label: quality, url: `https://media.invalid/${quality}.m3u8` },
  qualities: [{ label: quality, height: 720 }], subtitles: [], audioNames: [],
});

test("restores a saved stable voice and quality before starting another discovered voice", async () => {
  const calls = [];
  const snapshots = [];
  const session = createSourceSession({
    publish: (state) => snapshots.push(state),
    resolve: async (id, quality) => { calls.push({ id, quality }); return result(quality || "720p"); },
    discover: async (_title, { onEvent }) => {
      onEvent("candidate", candidate("temporary-candidate-a", "default", "Основная озвучка"));
      onEvent("candidate", candidate("temporary-candidate-b", "alloha:7", "Red Head Sound"));
    },
  });
  session.start({ type: "movie", title: "Fixture" }, {
    providerId: "habster:alloha", voiceId: "alloha:7", voiceName: "Red Head Sound", quality: "2160p",
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [{ id: "temporary-candidate-b", quality: "2160p" }]);
  const active = snapshots.at(-1);
  assert.deepEqual(active.sourcePreference, {
    providerId: "habster:alloha", voiceId: "alloha:7", voiceName: "Red Head Sound",
  });
  assert.equal(JSON.stringify(active.sourcePreference).includes("temporary-candidate-b"), false);
  session.stop();
});

test("falls back after discovery if the saved stable voice is no longer available", async () => {
  const calls = [];
  const session = createSourceSession({
    publish() {},
    resolve: async (id, quality) => { calls.push({ id, quality }); return result(); },
    discover: async (_title, { onEvent }) => {
      onEvent("candidate", candidate("temporary-candidate", "default", "Основная озвучка"));
    },
  });
  session.start({ type: "movie", title: "Fixture" }, {
    providerId: "habster:alloha", voiceId: "alloha:7", voiceName: "Red Head Sound", quality: "2160p",
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [{ id: "temporary-candidate", quality: undefined }]);
  session.stop();
});

test("keeps the fast first-candidate path when there is no saved source preference", async () => {
  const calls = [];
  const session = createSourceSession({
    publish() {},
    resolve: async (id, quality) => { calls.push({ id, quality }); return result(); },
    discover: async (_title, { onEvent }) => {
      onEvent("candidate", candidate("temporary-candidate", "default", "Основная озвучка"));
    },
  });
  session.start({ type: "movie", title: "Fixture" }, { audio: { name: "Russian", lang: "ru" } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, [{ id: "temporary-candidate", quality: undefined }]);
  session.stop();
});
