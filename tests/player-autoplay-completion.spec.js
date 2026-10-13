import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "@playwright/test";
import { buildMonthlyRecap } from "../src/utils/viewingStats.js";

let fixtureDir;
const baseURL = process.env.PROFILE_BROWSER_URL || "http://localhost:3000";

test.beforeAll(() => {
  fixtureDir = mkdtempSync(join(tmpdir(), "streambert-autoplay-completion-"));
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=black:s=160x90:r=10:d=30",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=8000:duration=30", "-c:v", "libx264", "-preset", "ultrafast",
    "-pix_fmt", "yuv420p", "-g", "20", "-sc_threshold", "0", "-c:a", "aac", "-hls_time", "2", "-hls_list_size", "0",
    "-hls_segment_filename", join(fixtureDir, "segment%03d.ts"), join(fixtureDir, "fixture.m3u8")]);
});
test.afterAll(() => { if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true }); });

test("TV auto-next on a confirmed outro records completion before switching episodes", async ({ page }) => {
  test.setTimeout(90_000);
  await page.addInitScript(() => {
    localStorage.setItem("lampa_stream_tmdb_token", "autoplay-fixture");
    localStorage.setItem("streambert_autoplayNextDuration", JSON.stringify(5));
  });
  await page.route("**/api/tmdb/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    const isSeason = path.includes("/season/");
    const body = isSeason
      ? { id: 1399, season_number: 1, episodes: [
          { id: 99101, episode_number: 1, season_number: 1, name: "Autoplay pilot", air_date: "2024-01-01", still_path: null },
          { id: 99102, episode_number: 2, season_number: 1, name: "Autoplay next", air_date: "2024-01-01", still_path: null },
        ] }
      : { id: 1399, name: "Autoplay QA series", original_name: "Autoplay QA series", first_air_date: "2024-01-01",
          seasons: [{ season_number: 1, episode_count: 2, name: "Season 1" }], number_of_seasons: 1,
          genres: [{ id: 18, name: "Drama" }], credits: { cast: [] }, external_ids: { imdb_id: "tt0000139" } };
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.route("**/api/introdb?*", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({ outro: { start_sec: 8, end_sec: 29, confidence: 0.99 } }),
  }));
  await page.route("**/api/source-host?op=discover", (route) => route.fulfill({
    contentType: "text/event-stream",
    body: `event: candidate\ndata: ${JSON.stringify({ id: "autoplay-fixture", providerId: "habster:alloha", providerName: "Habster · Alloha", voiceId: "alloha:52", voiceName: "Русская озвучка", qualityHint: "720p" })}\n\nevent: done\ndata: {}\n\n`,
  }));
  await page.route("**/api/source-host?op=resolve", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({
    kind: "hls", selected: { label: "720p", height: 720, url: "https://autoplay-media.example/master.m3u8" },
    qualities: [{ label: "720p", height: 720, url: "https://autoplay-media.example/master.m3u8" }], subtitles: [], audioNames: [],
  }) }));
  await page.route("https://autoplay-media.example/**", (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith("master.m3u8")) return route.fulfill({
      contentType: "application/vnd.apple.mpegurl", headers: { "access-control-allow-origin": "*" },
      body: "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=300000,RESOLUTION=160x90\nfixture.m3u8\n",
    });
    const filename = pathname.split("/").pop();
    return route.fulfill({ contentType: filename.endsWith("m3u8") ? "application/vnd.apple.mpegurl" : "video/mp2t",
      headers: { "access-control-allow-origin": "*" }, body: readFileSync(join(fixtureDir, filename)) });
  });

  await page.goto(new URL("/tv/1399", baseURL).toString());
  await expect(page.locator(".episode-card")).toHaveCount(2);
  await page.locator(".episode-card").first().click();
  const video = page.locator(".torrplayer > video");
  await expect(video).toBeVisible();
  await expect.poll(() => video.evaluate((value) => value.getVideoPlaybackQuality().totalVideoFrames)).toBeGreaterThan(0);
  await expect(page.getByText("Сезон 1 · Э2")).toBeVisible({ timeout: 45_000 });

  const state = await page.evaluate(() => JSON.parse(localStorage.getItem("streambert_viewingData") || "{}"));
  const completed = Object.values(state.sessions || {}).find((session) => session.progressKey === "tv_1399_s1e1");
  expect(completed?.completedAt, "first episode should be completed before auto-next unmounts its player").toBeGreaterThan(0);
  const recap = buildMonthlyRecap({ sessions: state.sessions }, { now: completed.completedAt });
  expect(recap.completedEpisodes).toBe(1);
  expect((completed.segments || []).length).toBeGreaterThan(0);
  const watchedSeconds = completed.segments.reduce((sum, segment) => sum + (segment.end - segment.start) / 1000, 0);
  expect(watchedSeconds).toBeGreaterThanOrEqual(4);
  expect(watchedSeconds).toBeLessThan(15); // confirmed outro, well before the normal end-threshold fallback
});
