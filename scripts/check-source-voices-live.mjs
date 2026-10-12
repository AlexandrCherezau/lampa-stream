import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

// Bounded production smoke: two distinct voices, two extreme qualities, one frame + seek60.
const run = promisify(execFile);
const origin = process.env.SOURCE_FRONTEND_URL || "https://lampa-stream-six.vercel.app";
const output = process.env.SOURCE_VOICES_REPORT || new URL("../docs/source-voices-verification-2026-10-12.json", import.meta.url);
const samples = [
  { name: "Fight Club", type: "movie", title: "Бойцовский клуб", originalTitle: "Fight Club", year: 1999, tmdbId: 550, kinopoiskId: 361, imdbId: "tt0137523", language: "en", providers: ["vibix", "filmix", "cdnvideohub"] },
  { name: "Breaking Bad S1E1", type: "tv", title: "Во все тяжкие", originalTitle: "Breaking Bad", year: 2008, tmdbId: 1396, kinopoiskId: 404900, imdbId: "tt0903747", language: "en", season: 1, episode: 1, providers: ["vibix", "filmix", "hdvb"] },
  { name: "Haikyuu S1E14", type: "tv", title: "Волейбол!!", originalTitle: "ハイキュー!!", year: 2014, tmdbId: 60863, kinopoiskId: 840073, imdbId: "tt3398540", language: "ja", anime: true, season: 1, episode: 14, providers: ["animedia", "kodik"] },
];

function parseCandidates(text) {
  return text.replace(/\r\n/g, "\n").split(/\n\n/).flatMap((block) => {
    if (!/^event:\s*candidate\s*$/m.test(block)) return [];
    const data = block.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
    return [JSON.parse(data)];
  });
}
function voices(candidates, provider) {
  const distinct = new Map();
  for (const candidate of candidates.filter((value) => value.providerId === provider)) {
    if (!distinct.has(candidate.voiceName)) distinct.set(candidate.voiceName, candidate);
  }
  return [...distinct.values()].slice(0, 2);
}
function extremeQualities(data) {
  const distinct = [...new Map((data.qualities || []).map((quality) => [quality.label, quality])).values()];
  const numbered = distinct.filter((quality) => Number(quality.height) > 0)
    .sort((a, b) => Number(a.height) - Number(b.height));
  const values = numbered.length ? numbered : distinct;
  assert.ok(values.length, "Resolve must contain qualities");
  return values.length === 1 ? values : [values[0], values.at(-1)];
}
const decodedFrame = /^\d+,\s*-?\d+,\s*-?\d+,\s*\d+,\s*\d+,\s*[a-f0-9]{32}\s*$/m;
function selfCheck() {
  const candidates = parseCandidates('event: status\r\ndata: {}\r\n\r\nevent: candidate\r\ndata: {"providerId":"vibix",\r\ndata: "voiceName":"A","id":"1"}\r\n\r\n');
  assert.equal(candidates.length, 1);
  assert.deepEqual(voices([...candidates, { ...candidates[0], id: "2" }, { ...candidates[0], voiceName: "B", id: "3" }, { ...candidates[0], voiceName: "C", id: "4" }], "vibix").map((value) => value.id), ["1", "3"]);
  assert.deepEqual(extremeQualities({ qualities: [{ label: "auto" }, { label: "1080p", height: 1080 }, { label: "480p", height: 480 }, { label: "720p", height: 720 }] }).map((value) => value.label), ["480p", "1080p"]);
  assert.deepEqual(extremeQualities({ qualities: [{ label: "auto" }, { label: "auto" }] }).map((value) => value.label), ["auto"]);
  assert.throws(() => extremeQualities({ qualities: [] }));
  assert.match("0, 0, 0, 1, 12, d41d8cd98f00b204e9800998ecf8427e\n", decodedFrame);
  assert.doesNotMatch("# stream metadata only", decodedFrame);
}
selfCheck();
if (process.argv.includes("--self-check")) {
  console.log("Parser, distinct voices, quality extremes and decoded-frame assertions: PASS");
  process.exit(0);
}
const site = new URL(origin);
assert.ok(["https:", "http:"].includes(site.protocol) && !site.username && !site.password, "Valid frontend origin required");
const controller = new AbortController();
const deadline = setTimeout(() => controller.abort(), 300_000);
const cancel = () => controller.abort();
process.once("SIGINT", cancel);
process.once("SIGTERM", cancel);
const privateDir = await mkdtemp(join(tmpdir(), "lampa-voice-smoke-"));
let rawIndex = 0;
const report = { checkedAt: new Date().toISOString(), frontend: site.origin, selfCheck: "PASS", scope: "Three named titles; at most two distinct voices per listed provider and lowest/highest advertised numbered quality. Startup and seek60 decode one video frame each. Not all voices, titles, or browsers.", bounds: { voicesPerProvider: 2, qualitiesPerVoice: 2, decodeConcurrency: 3, ffmpegTimeoutMs: 25_000, totalDeadlineMs: 300_000 }, samples: [] };
async function request(op, body) {
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(op === "discover" ? 90_000 : 45_000)]);
  const response = await fetch(new URL(`/api/source-host?op=${op}`, site), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal });
  const text = await response.text();
  assert.ok(text.length < 2 * 1024 * 1024, "Bounded API response required");
  await writeFile(join(privateDir, `${++rawIndex}-${op}.json`), text, { mode: 0o600 });
  if (!response.ok) throw Object.assign(new Error("api-http-error"), { status: response.status });
  return op === "discover" ? parseCandidates(text) : JSON.parse(text);
}
function reason(error) {
  if (controller.signal.aborted) return "cancelled-or-total-deadline";
  if (error.killed || error.name === "TimeoutError") return "timeout";
  if (error.status) return `api-http-${error.status}`;
  if (error.stderr !== undefined) return "decode-or-seek-failed";
  if (error.name === "AssertionError") return "contract-assertion-failed";
  return "request-or-response-failed";
}
async function decode(data, url, seek) {
  const input = ["-hide_banner", "-loglevel", "error", "-nostdin", "-rw_timeout", "15000000", ...(data.kind === "hls" ? ["-allowed_extensions", "ALL", "-extension_picky", "0"] : [])];
  const start = Date.now();
  const result = await run("ffmpeg", [...input, ...(seek ? ["-ss", "60"] : []), "-i", url, "-frames:v", "1", "-an", "-f", "framemd5", "-"], { signal: controller.signal, timeout: 25_000, killSignal: "SIGKILL", maxBuffer: 100_000 });
  assert.match(result.stdout, decodedFrame, "Must genuinely decode a video frame");
  return Date.now() - start;
}
async function checkVoice(sample, candidate) {
  const result = { provider: candidate.providerId, voice: candidate.voiceName, qualities: [] };
  sample.checks.push(result);
  try {
    if (sample.episode != null) {
      assert.equal(candidate.season, sample.season, "Exact season required");
      assert.equal(candidate.episode, sample.episode, "Exact episode required");
    }
    const start = Date.now();
    const initial = await request("resolve", { id: candidate.id });
    result.resolveMs = Date.now() - start;
    result.advertisedQualities = (initial.qualities || []).map(({ label, height }) => ({ label, height }));
    for (const quality of extremeQualities(initial)) {
      const check = { quality: quality.label, playable: false };
      result.qualities.push(check);
      if (controller.signal.aborted) { check.failure = "cancelled-or-total-deadline"; continue; }
      try {
        const resolveStart = Date.now();
        // Exercise the same quality-selection request as the frontend, including the initially selected quality.
        const data = await request("resolve", { id: candidate.id, quality: quality.label });
        check.qualityResolveMs = Date.now() - resolveStart;
        assert.equal(data.selected?.label, quality.label, "Requested quality must actually be selected");
        assert.ok(["hls", "file"].includes(data.kind), "Supported video kind required");
        const media = new URL(data.selected.url);
        assert.ok(["https:", "http:"].includes(media.protocol) && !media.username && !media.password, "Valid media URL required");
        check.startupMs = await decode(data, media.href, false);
        check.seek60Ms = await decode(data, media.href, true);
        check.playable = true;
      } catch (error) { check.failure = reason(error); }
    }
  } catch (error) { result.failure = reason(error); }
}
try {
  const jobs = [];
  await Promise.all(samples.map(async ({ name, providers, ...title }) => {
    const sample = { name, ...(title.season != null ? { season: title.season, episode: title.episode } : {}), checks: [], missingProviders: [], playable: false };
    report.samples.push(sample);
    try {
      const start = Date.now();
      const candidates = await request("discover", title);
      sample.discoveryMs = Date.now() - start;
      sample.candidateCount = candidates.length;
      for (const provider of providers) {
        const selected = voices(candidates, provider);
        if (!selected.length) sample.missingProviders.push(provider);
        for (const candidate of selected) jobs.push(() => checkVoice(sample, candidate));
      }
    } catch (error) { sample.failure = reason(error); }
  }));
  await Promise.all(Array.from({ length: 3 }, async () => {
    while (jobs.length && !controller.signal.aborted) await jobs.shift()();
  }));
  report.unattemptedVoices = jobs.length;
} finally {
  clearTimeout(deadline);
  process.off("SIGINT", cancel);
  process.off("SIGTERM", cancel);
  for (const sample of report.samples) sample.playable = sample.checks.some((voice) => voice.qualities.some((quality) => quality.playable));
  report.status = report.samples.length === samples.length && report.samples.every((sample) => sample.playable) ? "GREEN" : "RED";
  report.cancelledOrDeadline = controller.signal.aborted;
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
}
assert.equal(report.status, "GREEN", "Every named sample needs at least one decoded startup + seek60 candidate");
