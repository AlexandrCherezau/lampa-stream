import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "@playwright/test";

let fixtureDir;
test.beforeAll(() => {
  fixtureDir = mkdtempSync(join(tmpdir(), "streambert-habster-native-"));
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=black:s=160x90:r=10:d=100",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=8000:duration=100", "-c:v", "libx264", "-preset", "ultrafast",
    "-pix_fmt", "yuv420p", "-g", "20", "-sc_threshold", "0", "-c:a", "aac", "-hls_time", "2", "-hls_list_size", "0",
    "-hls_segment_filename", join(fixtureDir, "fixture%03d.ts"), join(fixtureDir, "fixture.m3u8")]);
});
test.afterAll(() => { if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true }); });

// Tiny decoded fixtures verify our own player's controls and persisted clocks.
// Actual UHD resolution and the provider protocol require the separate live check.
test("Habster HLS uses our player, full quality ladder, voice switching and saved history", async ({ page }) => {
  test.setTimeout(90_000);
  const candidates = [
    { id: "alloha-dub", providerId: "habster:alloha", providerName: "Habster · Alloha", voiceName: "Red Head Sound", qualityHint: "4K" },
    { id: "alloha-eng", providerId: "habster:alloha", providerName: "Habster · Alloha", voiceName: "Eng.Original", qualityHint: "4K" },
  ];
  await page.addInitScript((candidates) => {
    localStorage.setItem("lampa_stream_tmdb_token", "native-hls-fixture");
    if (!localStorage.getItem("streambert_progress")) localStorage.setItem("streambert_progress", JSON.stringify({ movie_969681: 30 }));
    if (!localStorage.getItem("streambert_resumeTime")) localStorage.setItem("streambert_resumeTime", JSON.stringify({ movie_969681: 30 }));
    const originalFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      if (String(input).includes("/api/source-host?op=discover")) {
        return Promise.resolve(new Response(new ReadableStream({ start(controller) {
          const emit = (candidate) => controller.enqueue(new TextEncoder().encode(`event: candidate\ndata: ${JSON.stringify(candidate)}\n\n`));
          emit(candidates[0]);
          setTimeout(() => { emit(candidates[1]); controller.close(); }, 1000);
        } }), { headers: { "content-type": "text/event-stream" } }));
      }
      return originalFetch(input, init);
    };
  }, candidates);
  await page.route("**/api/tmdb/**", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({
    id: 969681, title: "Человек-паук: Новый день", original_title: "Spider-Man: Brand New Day", release_date: "2026-07-31",
    runtime: 145, imdb_id: "tt22084616", kinopoisk_id: 5494049, genres: [], credits: { cast: [] }, results: [], images: {},
  }) }));
  const resolutions = [];
  await page.route("**/api/source-host?op=resolve", (route) => {
    const request = route.request().postDataJSON();
    resolutions.push(request);
    const qualities = [720, 2160, 1440, 1080, 480, 360].map((height) => ({ label: `${height}p`, height }))
      .map((quality) => ({ ...quality, url: `https://media.example/${request.id}/${quality.label}/master.m3u8` }));
    const selected = qualities.find((quality) => quality.label === request.quality) || qualities[0];
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ kind: "hls", selected, qualities, subtitles: [], audioNames: [] }) });
  });
  const mediaRequests = [];
  await page.route("https://media.example/**", (route) => {
    const pathname = new URL(route.request().url()).pathname;
    mediaRequests.push(pathname);
    if (pathname.endsWith("master.m3u8")) return route.fulfill({
      contentType: "application/vnd.apple.mpegurl", headers: { "access-control-allow-origin": "*" },
      body: `#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=300000,RESOLUTION=${pathname.includes("2160p") ? "3832x1600" : "1280x534"}\nfixture.m3u8\n`,
    });
    const filename = pathname.split("/").pop();
    return route.fulfill({ contentType: filename.endsWith("m3u8") ? "application/vnd.apple.mpegurl" : "video/mp2t",
      headers: { "access-control-allow-origin": "*" }, body: readFileSync(join(fixtureDir, filename)) });
  });

  await page.goto("/movie/969681");
  await page.getByRole("button", { name: "Смотреть", exact: true }).click();
  const video = page.locator(".torrplayer > video");
  await expect(video).toBeVisible();
  await expect(page.locator('iframe[title="Плеер Habster · Alloha"]')).toHaveCount(0);
  await expect.poll(() => video.evaluate((value) => value.getVideoPlaybackQuality().totalVideoFrames)).toBeGreaterThan(0);
  await expect.poll(() => video.evaluate((value) => value.currentTime)).toBeGreaterThanOrEqual(29);
  await page.locator(".torrplayer").hover();
  await page.getByTitle("Качество (Q)").click();
  const menu = page.locator(".torrplayer-audio-menu");
  for (const label of ["1440p", "1080p", "720p", "480p", "360p"]) await expect(menu.getByRole("button", { name: label, exact: true })).toBeVisible();
  await expect(menu.getByRole("button", { name: "4K ⭐", exact: true })).toHaveCount(1);
  await expect(menu.getByRole("button", { name: "Авто", exact: true })).toHaveCount(0);
  await menu.getByRole("button", { name: "4K ⭐", exact: true }).click();
  await expect.poll(() => resolutions.at(-1)?.quality).toBe("2160p");
  await expect.poll(() => video.evaluate((value) => value.currentTime)).toBeGreaterThanOrEqual(29);
  await expect.poll(() => video.evaluate((value) => value.readyState)).toBeGreaterThanOrEqual(2);
  await page.locator(".torrplayer").hover();
  await page.getByTitle("Озвучка", { exact: true }).click();
  await video.evaluate((value) => {
    // Reproduce pause before the coarser timeupdate playback latch fires.
    value.addEventListener("timeupdate", (event) => event.stopImmediatePropagation(), { capture: true });
    value.addEventListener("loadstart", () => { value.dataset.voiceAttachedAt = String(performance.now()); }, { once: true });
  });
  await menu.getByRole("button", { name: "Eng.Original", exact: true }).click();
  await expect.poll(() => resolutions.at(-1)?.id).toBe("alloha-eng");
  expect(resolutions.at(-1)?.quality).toBe("2160p");
  await expect.poll(() => video.evaluate((value) => value.currentTime)).toBeGreaterThanOrEqual(29);
  await expect.poll(() => mediaRequests.some((path) => path.includes("alloha-eng") && path.endsWith(".ts"))).toBe(true);
  await expect.poll(() => video.evaluate((value) => !value.seeking && value.readyState >= 3 && value.getVideoPlaybackQuality().totalVideoFrames >= 3)).toBe(true);
  await page.locator(".torrplayer").hover();
  const seekBar = page.getByTitle("Перемотка (0–9)", { exact: true });
  const box = await seekBar.boundingBox();
  const duration = await video.evaluate((value) => value.duration);
  await seekBar.click({ position: { x: box.width * 60 / duration, y: box.height / 2 } });
  await expect.poll(() => video.evaluate((value) => !value.seeking && value.currentTime >= 59)).toBe(true);
  await page.getByTitle("Пауза (Space / K)", { exact: true }).click();
  expect(await video.evaluate((value) => performance.now() - Number(value.dataset.voiceAttachedAt))).toBeLessThan(7000);
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("streambert_resumeTime"))?.movie_969681)).toBeGreaterThanOrEqual(59);
  await expect.poll(() => page.evaluate(() => {
    // The app debounces the percentage write, and flushes it when leaving.
    window.dispatchEvent(new Event("pagehide"));
    return JSON.parse(localStorage.getItem("streambert_progress"))?.movie_969681;
  }), { timeout: 8000 }).toBeGreaterThanOrEqual(59);
  // The 7s startup deadline must leave an intentionally paused voice intact.
  await page.waitForTimeout(7500);
  expect(await video.evaluate((value) => value.paused)).toBe(true);
  expect(resolutions.at(-1)?.id).toBe("alloha-eng");
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("streambert_resumeTime"))?.movie_969681);
  await page.reload();
  await page.getByRole("button", { name: "Смотреть", exact: true }).click();
  await expect.poll(() => video.evaluate((value) => value.currentTime)).toBeGreaterThanOrEqual(saved - 1);
});
