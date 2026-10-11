import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { streamRewriteM3u8 } from "../api/lampac.js";

class Response extends EventEmitter {
  chunks = [];
  ended = false;
  write(chunk) { this.chunks.push(String(chunk)); }
  end() { this.ended = true; }
  destroy() { this.destroyed = true; }
  text() { return this.chunks.join(""); }
}

const secret = process.env.LAMPAC_PROXY_SECRET;
process.env.LAMPAC_PROXY_SECRET = "";
const base = "https://cdn.example/playlist.m3u8";
const playlist = "#EXTM3U\n#EXTINF:10,\nsegment.ts\n";
const child = `/api/lampac?u=${Buffer.from("https://cdn.example/segment.ts").toString("base64url")}`;
const expected = `#EXTM3U\n#EXTINF:10,\n${child}\n`;
try {
  const completed = new PassThrough();
  completed.end(playlist);
  completed.resume();
  await new Promise((resolve) => completed.once("end", resolve));
  completed.socket = null;
  completed.setTimeout = () => { throw new Error("completed stream has no socket"); };
  const completedRes = new Response();
  streamRewriteM3u8(completed, completedRes, Buffer.from(playlist), base, "");
  assert.equal(completedRes.ended, true, "an already-ended upstream must end the client response");
  assert.equal(completedRes.text(), expected, "the complete playlist must still be rewritten");

  const streaming = new PassThrough();
  const streamingRes = new Response();
  const ended = new Promise((resolve) => streamingRes.once("finish", resolve));
  const end = streamingRes.end.bind(streamingRes);
  streamingRes.end = () => { end(); streamingRes.emit("finish"); };
  streamRewriteM3u8(streaming, streamingRes, Buffer.from("#EXTM3U\n#EXTINF:10,\nseg"), base, "");
  streaming.end("ment.ts\n");
  await ended;
  assert.equal(streamingRes.text(), expected, "a URI split across chunks must be rewritten");
} finally {
  if (secret === undefined) delete process.env.LAMPAC_PROXY_SECRET;
  else process.env.LAMPAC_PROXY_SECRET = secret;
}

console.log("Lampac completed and streaming playlist checks passed");
