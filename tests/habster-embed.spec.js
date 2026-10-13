import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "@playwright/test";
import { createSourceSession } from "../src/utils/source-host-client.js";

const embedUrl = "https://befriend.stravers.live/?kp=5494049&token=test-fixture";
const embedResult = (url = embedUrl) => ({
  kind: "embed", source: { providerId: "habster:alloha", catalogSource: "habster", kinopoiskId: 5494049 },
  selected: { label: "Плеер Habster", url }, qualities: [], subtitles: [], audioNames: [],
});
const candidates = [
  { id: "alloha", providerId: "habster:alloha", providerName: "Habster · Alloha", voiceName: "Плеер", qualityHint: "4K" },
  { id: "collaps", providerId: "habster:collaps", providerName: "Habster · Collaps", voiceName: "Мультиаудио", qualityHint: "Auto" },
];

test("embedded Habster is strictly identified and restores on failed manual playback", async () => {
  let state;
  const resolved = [];
  const session = createSourceSession({
    publish: (value) => { state = value; },
    discover: async (_title, { onEvent }) => candidates.forEach((value) => onEvent("candidate", value)),
    resolve: async (id, quality) => {
      resolved.push({ id, quality });
      return id === "alloha" ? embedResult()
        : { kind: "hls", selected: { label: "auto", url: "https://media.test/video.m3u8" }, qualities: [] };
    },
  });
  await session.start({ title: "Film" });
  expect(state.stream).toEqual({ embed: embedUrl });
  session.notePlaying();
  await session.selectBalanser("habster:collaps");
  session.reportPlaybackFailure();
  expect(state.stream).toEqual({ embed: embedUrl });
  await session.selectBalanser("habster:alloha", "2160p");
  expect(resolved.at(-1)).toEqual({ id: "alloha", quality: undefined });
  session.stop();

  for (const result of [
    embedResult("https://befriend.stravers.live.evil.test/?kp=5494049"),
    embedResult("https://user@befriend.stravers.live/?kp=5494049"),
    embedResult("https://befriend.stravers.live/?kp=0"),
    embedResult("https://befriend.stravers.live/?kp=1&kp=2"),
    embedResult("https://befriend.stravers.live/?kp=123"),
    { ...embedResult(), source: { providerId: "other", catalogSource: "habster" } },
  ]) {
    const invalid = createSourceSession({
      publish: (value) => { state = value; },
      discover: async (_title, { onEvent }) => onEvent("candidate", candidates[0]),
      resolve: async () => result,
    });
    await invalid.start({ title: "Film" });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(state.stream).toBeNull();
    expect(state.sourceError).toBeTruthy();
    invalid.stop();
  }
});

let fixtureDir;
test.beforeAll(() => {
  fixtureDir = mkdtempSync(join(tmpdir(), "streambert-embed-"));
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=black:s=160x90:r=10:d=15",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-movflags", "+faststart", join(fixtureDir, "video.mp4")]);
});
test.afterAll(() => { if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true }); });

test("native Habster controls stay mounted during background discovery without invented progress; manual fallback decodes", async ({ page }) => {
  await page.addInitScript((candidates) => {
    localStorage.setItem("lampa_stream_tmdb_token", "embed-test-token");
    localStorage.setItem("streambert_progress", JSON.stringify({ movie_969681: 17 }));
    localStorage.setItem("streambert_resumeTime", JSON.stringify({ movie_969681: 109 }));
    const originalFetch = window.fetch;
    window.fetch = (input, init) => {
      if (String(input).includes("/api/source-host?op=discover")) {
        const encode = (candidate) => new TextEncoder().encode(`event: candidate\ndata: ${JSON.stringify(candidate)}\n\n`);
        return Promise.resolve(new Response(new ReadableStream({ start(controller) {
          controller.enqueue(encode(candidates[0]));
          setTimeout(() => { controller.enqueue(encode(candidates[1])); controller.close(); }, 1500);
        } }), { headers: { "content-type": "text/event-stream" } }));
      }
      return originalFetch(input, init);
    };
  }, candidates);
  await page.route("**/api/tmdb/**", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({
    id: 969681, title: "Человек-паук: Новый день", original_title: "Spider-Man: Brand New Day", release_date: "2026-07-31",
    runtime: 145, imdb_id: "tt22084616", kinopoisk_id: 5494049, genres: [], credits: { cast: [] }, results: [], images: {},
  }) }));
  const resolved = [];
  await page.route("**/api/source-host?op=resolve", (route) => {
    const { id } = route.request().postDataJSON();
    resolved.push(id);
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(id === "alloha" ? embedResult()
      : { kind: "file", selected: { label: "160p", url: "/embed-fixture.mp4" }, qualities: [] }) });
  });
  await page.route("https://befriend.stravers.live/**", (route) => route.fulfill({ contentType: "text/html", body:
    '<html><body style="background:black;color:white"><button>Качество</button><button>2160p 4K</button><button>1440p 2K</button><button>1080p HD</button><script>window.playerMarker=1</script></body></html>' }));
  await page.route("**/embed-fixture.mp4", (route) => route.fulfill({ contentType: "video/mp4", body: readFileSync(join(fixtureDir, "video.mp4")) }));
  await page.goto("/movie/969681");
  await page.getByRole("button", { name: "Смотреть", exact: true }).click();
  const iframe = page.locator('iframe[title="Плеер Habster · Alloha"]');
  await expect(iframe).toBeVisible();
  const frame = page.frameLocator('iframe[title="Плеер Habster · Alloha"]');
  await expect(frame.getByRole("button", { name: "2160p 4K" })).toBeVisible();
  await expect(page.getByTitle("Качество (Q)")).toHaveCount(0);
  await expect(page.locator(".torrplayer-time")).toHaveCount(0);
  await expect(page.locator(".torrplayer > video")).toHaveCount(0);
  const nativeFrame = page.frames().find((value) => value.url() === embedUrl);
  await nativeFrame.evaluate(() => { window.playerMarker = 2; });
  await page.getByTitle("Источник", { exact: true }).click();
  await expect(page.locator(".torrplayer-audio-menu").getByRole("button", { name: "Habster · Collaps", exact: true })).toBeVisible();
  expect(await nativeFrame.evaluate(() => window.playerMarker)).toBe(2);
  expect(resolved).toEqual(["alloha"]);
  // More than the app's progress-save interval: iframe load must never turn
  // cached progress into a fabricated zero or pretend it decoded frames.
  await page.waitForTimeout(5200);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("streambert_progress")))).toEqual({ movie_969681: 17 });
  await page.locator(".torrplayer-audio-menu").getByRole("button", { name: "Habster · Collaps", exact: true }).click();
  await expect(iframe).toHaveCount(0);
  const video = page.locator(".torrplayer > video");
  await expect(video).toBeVisible();
  await expect.poll(() => video.evaluate((value) => value.getVideoPlaybackQuality().totalVideoFrames)).toBeGreaterThan(0);
  await expect(page.getByTitle("Качество (Q)")).toHaveCount(0);
  await page.locator(".torrplayer").hover();
  await page.getByTitle("Источник", { exact: true }).click();
  await page.locator(".torrplayer-audio-menu").getByRole("button", { name: /^Habster · Alloha/ }).click();
  await expect(iframe).toBeVisible();
  await expect(video).toHaveCount(0);
  expect(resolved).toEqual(["alloha", "collaps", "alloha"]);
});
