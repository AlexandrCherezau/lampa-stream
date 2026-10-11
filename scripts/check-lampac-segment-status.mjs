import assert from "node:assert/strict";
import { probeMediaUrl } from "../src/utils/lampac-client.js";

const fetch = globalThis.fetch;
const emptyResponse = {
  status: 0,
  headers: { get: () => null },
  body: { getReader: () => ({ read: async () => ({ done: true }) }) },
};
globalThis.fetch = async (url) => {
  const path = new URL(url).pathname;
  if (path.includes("segment") || path.includes("variant")) return emptyResponse;
  const body = path.includes("master")
    ? "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100000,RESOLUTION=640x360\nvariant.m3u8\n"
    : "#EXTM3U\n#EXTINF:10,\nsegment.ts\n";
  return new Response(body, { status: 200, headers: { "content-type": "application/vnd.apple.mpegurl" } });
};

try {
  for (const path of ["media", "master"]) {
    const result = await probeMediaUrl({ url: `https://${path}.test/${path}.m3u8` }, { fast: true });
    assert.equal(result.ok, false, `${path} child request with status 0 must fail`);
    assert.equal(result.reason, "segment-timeout");
  }
} finally {
  globalThis.fetch = fetch;
}

console.log("Lampac playlist child status check passed");
