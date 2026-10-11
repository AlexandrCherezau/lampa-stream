import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const origin = process.env.SOURCE_HOST_URL;
assert.ok(origin, "Set SOURCE_HOST_URL to the running own host");
const headers = { "content-type": "application/json", ...(process.env.SOURCE_API_KEY ? { authorization: `Bearer ${process.env.SOURCE_API_KEY}` } : {}) };
const run = promisify(execFile);
const samples = [
  { name: "Fight Club", type: "movie", title: "Бойцовский клуб", originalTitle: "Fight Club", year: 1999, tmdbId: 550, kinopoiskId: 361, imdbId: "tt0137523", language: "en", providers: ["zetflixdb", "hdvb", "vibix", "phantom", "veoveo"] },
  { name: "Breaking Bad S1E1", type: "tv", title: "Во все тяжкие", originalTitle: "Breaking Bad", year: 2008, tmdbId: 1396, kinopoiskId: 404900, imdbId: "tt0903747", language: "en", season: 1, episode: 1, providers: ["zetflixdb", "hdvb", "vibix", "phantom"] },
  { name: "Haikyuu S1E14", type: "tv", title: "Волейбол!!", originalTitle: "ハイキュー!!", year: 2014, tmdbId: 60863, kinopoiskId: 840073, imdbId: "tt3398540", language: "ja", anime: true, season: 1, episode: 14, providers: ["zetflixdb", "kodik", "animedia"] },
];
let failedSamples = 0;
for (const { name, providers, ...title } of samples) {
  const response = await fetch(new URL("/v1/discover", origin), { method: "POST", headers, body: JSON.stringify(title), signal: AbortSignal.timeout(180_000) });
  assert.equal(response.status, 200, `${name} discovery status`);
  const text = await response.text();
  const candidates = [...text.matchAll(/event: candidate\ndata: (.+)/g)].map((match) => JSON.parse(match[1]));
  let decodedProviders = 0;
  for (const provider of providers) {
    const candidate = candidates.find((value) => value.providerId === provider);
    if (!candidate) { console.log(JSON.stringify({ sample: name, provider, ready: false, reason: "not-found" })); continue; }
    if (title.type === "tv") {
      assert.equal(candidate.season, title.season, `${provider} exact season`);
      assert.equal(candidate.episode, title.episode, `${provider} exact episode`);
    }
    const start = Date.now();
    try {
      const resolved = await fetch(new URL("/v1/resolve", origin), { method: "POST", headers, body: JSON.stringify({ id: candidate.id }), signal: AbortSignal.timeout(180_000) });
      const data = await resolved.json();
      if (!resolved.ok) throw new Error(data.error || `HTTP ${resolved.status}`);
      const url = new URL(data.selected.url, origin).href;
      const input = ["-hide_banner", "-loglevel", "error", "-nostdin", "-rw_timeout", "15000000", ...(data.kind === "hls" ? ["-allowed_extensions", "ALL", "-extension_picky", "0"] : [])];
      await run("ffmpeg", [...input, "-i", url, "-frames:v", "1", "-an", "-f", "null", "-"], { timeout: 35_000, killSignal: "SIGKILL", maxBuffer: 100_000 });
      await run("ffmpeg", [...input, "-ss", "60", "-i", url, "-frames:v", "1", "-an", "-f", "null", "-"], { timeout: 35_000, killSignal: "SIGKILL", maxBuffer: 100_000 });
      decodedProviders++;
      console.log(JSON.stringify({ sample: name, provider, ready: true, decoded: true, seekSeconds: 60, quality: data.selected.label, elapsedMs: Date.now() - start }));
    } catch (error) {
      console.log(JSON.stringify({ sample: name, provider, ready: false, reason: error.killed ? "decode-timeout" : error.stderr ? "decode-or-seek-failed" : error.message.replace(/https?:\/\/\S+/g, "[url]"),
        ...(error.stderr ? { detail: error.stderr.replace(/https?:\/\/\S+/g, "[url]").slice(0, 500) } : {}) }));
    }
  }
  if (!decodedProviders) failedSamples++;
}
assert.equal(failedSamples, 0, "Each sample needs at least one genuinely decoded source, including seek");
