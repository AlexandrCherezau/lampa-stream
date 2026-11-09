import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "@playwright/test";

let fixtureDir;
test.beforeAll(() => {
  fixtureDir = mkdtempSync(join(tmpdir(), "nahflix-global-source-"));
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=black:s=160x90:r=10:d=45",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=8000:duration=45", "-c:v", "libx264", "-preset", "ultrafast",
    "-pix_fmt", "yuv420p", "-g", "20", "-sc_threshold", "0", "-c:a", "aac", "-hls_time", "2", "-hls_list_size", "0",
    "-hls_segment_filename", join(fixtureDir, "fixture%03d.ts"), join(fixtureDir, "fixture.m3u8")]);
});
test.afterAll(() => { if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true }); });

async function setup(page) {
  await page.addInitScript(() => {
    localStorage.setItem("lampa_stream_tmdb_token", "global-source-fixture");
    // Keep this check focused on sessions started by the viewer.
    Object.defineProperty(navigator, "connection", { value: { saveData: true }, configurable: true });
  });
  await page.route("**/api/tmdb/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    const id = Number(path.match(/\/(?:movie|tv)\/(\d+)/)?.[1] || 550);
    const tv = path.includes("/tv/");
    const body = path.includes("/season/") ? { season_number: 1, episodes: [1, 2].map((episode_number) => ({
      id: id * 10 + episode_number, episode_number, season_number: 1, name: `Эпизод ${episode_number}`, air_date: "2024-01-01", runtime: 45,
    })) } : /\/(movie|tv)\/\d+$/.test(path) ? {
      id, ...(tv ? { name: `Сериал ${id}`, original_name: `Series ${id}` } : { title: `Фильм ${id}`, original_title: `Movie ${id}` }),
      release_date: "2024-01-01", first_air_date: "2024-01-01", runtime: 90, original_language: "en",
      genres: [], credits: { cast: [] }, external_ids: {}, number_of_seasons: 1,
      seasons: [{ season_number: 1, episode_count: 2, name: "Сезон 1" }],
    } : { results: [], images: {} };
    return route.fulfill({ json: body });
  });
  await page.route("**/api/source-host?op=discover", (route) => {
    const query = route.request().postDataJSON();
    const candidates = ["alloha", "collaps"].map((provider) => ({
      id: `${query.tmdbId}-${query.episode || 0}-${provider}`, providerId: `habster:${provider}`,
      providerName: `Habster · ${provider === "alloha" ? "Alloha" : "Collaps"}`,
      voiceId: "default", voiceName: "Русский", qualityHint: "720p",
    }));
    return route.fulfill({ contentType: "text/event-stream", body: candidates.map((candidate) =>
      `event: candidate\ndata: ${JSON.stringify(candidate)}\n\n`).join("") + "event: done\ndata: {}\n\n" });
  });
  const resolutions = [];
  await page.route("**/api/source-host?op=resolve", (route) => {
    const request = route.request().postDataJSON();
    resolutions.push(request.id);
    const selected = { label: "720p", height: 720, url: `https://global-source-media.example/${request.id}/master.m3u8` };
    return route.fulfill({ json: { kind: "hls", selected, qualities: [selected], subtitles: [], audioNames: [] } });
  });
  await page.route("https://global-source-media.example/**", (route) => {
    const filename = new URL(route.request().url()).pathname.split("/").pop();
    if (filename === "master.m3u8") return route.fulfill({
      contentType: "application/vnd.apple.mpegurl", headers: { "access-control-allow-origin": "*" },
      body: "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=300000,RESOLUTION=160x90\nfixture.m3u8\n",
    });
    return route.fulfill({ contentType: filename.endsWith("m3u8") ? "application/vnd.apple.mpegurl" : "video/mp2t",
      headers: { "access-control-allow-origin": "*" }, body: readFileSync(join(fixtureDir, filename)) });
  });
  return resolutions;
}

async function expectProvider(page, id) {
  const video = page.locator(".torrplayer > video:visible");
  await expect(video).toHaveCount(1);
  await expect.poll(() => video.evaluate((value) => value.getVideoPlaybackQuality().totalVideoFrames)).toBeGreaterThan(0);
  await expect.poll(() => video.evaluate((value) => value.currentSrc)).toContain("blob:");
  await page.locator(".torrplayer:visible").hover();
  if (!await page.locator(".torrplayer-settings:visible").isVisible()) await page.locator(".torrplayer-btn--settings:visible").click();
  await expect(page.getByTitle("Источник", { exact: true })).toContainText(id === "collaps" ? "Collaps" : "Alloha");
}

async function pickCollaps(page) {
  await expectProvider(page, "alloha");
  await page.getByTitle("Источник", { exact: true }).click();
  await page.locator(".torrplayer-audio-menu").getByRole("button", { name: /Habster · Collaps/ }).click();
  await expectProvider(page, "collaps");
}

test("manual provider choice on a movie becomes the default on another movie", async ({ page }) => {
  const resolutions = await setup(page);
  await page.goto("/movie/550");
  await page.getByRole("button", { name: "Смотреть", exact: true }).click();
  await pickCollaps(page);
  await page.goto("/movie/551");
  await page.getByRole("button", { name: "Смотреть", exact: true }).click();
  await expectProvider(page, "collaps");
  expect(resolutions.filter((id) => id.startsWith("551-"))).toEqual(["551-0-collaps"]);
});

test("manual provider choice survives an episode switch and opening another series", async ({ page }) => {
  const resolutions = await setup(page);
  await page.goto("/tv/1396");
  await page.locator(".episode-card").first().click();
  await pickCollaps(page);
  await page.locator(".episode-card").nth(1).click();
  await expect(page.getByText("Сезон 1 · Э2", { exact: true })).toBeVisible();
  await expectProvider(page, "collaps");
  expect(resolutions.filter((id) => id.startsWith("1396-2-"))).toEqual(["1396-2-collaps"]);
  await page.goto("/tv/1397");
  await page.locator(".episode-card").first().click();
  await expectProvider(page, "collaps");
  expect(resolutions.filter((id) => id.startsWith("1397-1-"))).toEqual(["1397-1-collaps"]);
});
