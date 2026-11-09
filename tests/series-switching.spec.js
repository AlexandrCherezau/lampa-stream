import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "@playwright/test";

const FRAME_ORIGIN = "https://befriend.stravers.live";
const FRAME = `<!doctype html><body><button style="position:fixed;inset:0;width:100%;height:100%">Start</button><script>
  window.commands = []; window.time = 0;
  window.emit = (event, time = window.time) => parent.postMessage(JSON.stringify({ event, time }), "*");
  document.querySelector("button").onclick = () => { window.time = 0.25; window.emit("play"); window.emit("timeupdate"); };
  addEventListener("message", ({ data }) => {
    const command = JSON.parse(data); window.commands.push(command);
    if (command.api === "duration") window.emit("duration", 7200);
    if (command.api === "seek") { window.time = command.value; window.emit("seek"); }
    if (command.api === "play" || command.api === "pause") window.emit(command.api);
  });
  window.emit("pause");
<\/script>`;
let fixtureDir;
test.beforeAll(() => {
  fixtureDir = mkdtempSync(join(tmpdir(), "series-switching-"));
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=black:s=160x90:r=10:d=90",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-g", "20", "-sc_threshold", "0",
    "-hls_time", "2", "-hls_list_size", "0", "-hls_segment_filename", join(fixtureDir, "segment%03d.ts"), join(fixtureDir, "series.m3u8")]);
});
test.afterAll(() => { if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true }); });

async function setup(page, { kind = "embed", holdResolve, sameUrl = false, duration = 0, resumeTime = {} } = {}) {
  await page.addInitScript(({ duration, resumeTime }) => {
    localStorage.setItem("lampa_stream_tmdb_token", "series-fixture");
    localStorage.setItem("streambert_playerSource", JSON.stringify("lampac"));
    localStorage.setItem("streambert_autoplayNextDuration", JSON.stringify(duration));
    localStorage.setItem("streambert_resumeTime", JSON.stringify(resumeTime));
    Object.defineProperty(navigator, "connection", { value: { saveData: true } });
  }, { duration, resumeTime });
  await page.route("**/api/tmdb/**", (route) => {
    const season = Number(/\/season\/(\d+)/.exec(new URL(route.request().url()).pathname)?.[1]);
    return route.fulfill({ json: season ? { season_number: season, episodes: [1, 2, 3].map((episode) => ({
      id: season * 10 + episode, season_number: season, episode_number: episode,
      name: `Episode ${season}-${episode}`, air_date: "2024-01-01", still_path: null,
    })) } : {
      id: 1399, name: "Series fixture", original_name: "Series fixture", first_air_date: "2024-01-01", genres: [],
      seasons: [1, 2].map((number) => ({ season_number: number, episode_count: 3 })),
      number_of_seasons: 2, external_ids: { imdb_id: "tt0001399" }, credits: { cast: [] },
    } });
  });
  await page.route("**/api/introdb?*", (route) => route.fulfill({ json: {} }));
  const log = { resolve: [], media: [] };
  await page.route("**/api/source-host?op=discover", (route) => {
    const { season, episode } = route.request().postDataJSON();
    const candidate = { id: `s${season}e${episode}`, providerId: kind === "embed" ? "habster:alloha" : "habster:collaps",
      providerName: kind === "embed" ? "Habster · Alloha" : "Habster · Collaps", voiceId: "v", voiceName: "Original", season, episode };
    return route.fulfill({ contentType: "text/event-stream", body: `event: candidate\ndata: ${JSON.stringify(candidate)}\n\nevent: done\ndata: {}\n\n` });
  });
  await page.route("**/api/source-host?op=resolve", async (route) => {
    const { id } = route.request().postDataJSON();
    log.resolve.push(id);
    if (holdResolve) await holdResolve(id);
    const url = kind === "embed" ? `${FRAME_ORIGIN}/?episode=${sameUrl ? "shared" : id}` : "https://series-media.test/series.m3u8";
    await route.fulfill({ json: { kind, selected: { url, label: "360p" }, qualities: [], subtitles: [], audioNames: [] } }).catch(() => {});
  });
  await page.route(`${FRAME_ORIGIN}/**`, (route) => route.fulfill({ contentType: "text/html", body: FRAME }));
  await page.route("https://series-media.test/**", (route) => {
    const file = new URL(route.request().url()).pathname.split("/").pop();
    log.media.push(file);
    return route.fulfill({ contentType: file.endsWith("ts") ? "video/mp2t" : "application/vnd.apple.mpegurl",
      headers: { "access-control-allow-origin": "*" }, body: readFileSync(join(fixtureDir, file)) });
  });
  return log;
}
const card = (page, episode) => page.locator(".episode-card").nth(episode - 1);
const frame = (page) => page.frames().find((value) => value.url().startsWith(FRAME_ORIGIN));
async function assertEpisode(page, season, episode) {
  await expect(page.locator(".now-playing-row")).toContainText(`Сезон ${season} · Э${episode}`);
  await expect(page.locator(".now-playing-row")).toContainText(`Episode ${season}-${episode}`);
  await expect(page).toHaveURL(new RegExp(`season=${season}&episode=${episode}`));
  await expect(page.locator(".episode-card.playing")).toHaveCount(1);
  await expect(card(page, episode)).toHaveClass(/playing/);
}
async function startEmbed(page) {
  await expect(page.locator(".torrplayer-embed")).toBeVisible();
  await page.frameLocator(".torrplayer-embed").getByRole("button").click();
  await expect(page.locator(".torrplayer--embed-start")).toHaveCount(0);
}
async function ending(page) {
  await frame(page).evaluate(() => { window.time = 7195; window.emit("play"); window.emit("timeupdate"); });
}

test("changing season during playback stops the old episode and keeps the page usable", async ({ page }) => {
  const log = await setup(page);
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/tv/1399?season=1&episode=2");
  await card(page, 2).click();
  await startEmbed(page);
  await page.getByRole("button", { name: "Сезон 2", exact: true }).click();
  await expect(page.locator(".season-btn.active")).toContainText("Сезон 2");
  await expect(page.locator(".episode-card").first()).toContainText("Episode 2-1");
  await expect(page.locator(".torrplayer-embed")).toHaveCount(0);
  await expect(page).toHaveURL(/season=2$/);
  await card(page, 2).click();
  await assertEpisode(page, 2, 2);
  await expect.poll(() => log.resolve.at(-1)).toBe("s2e2");
  await expect(page.locator(".torrplayer-embed")).toHaveAttribute("src", /episode=s2e2/);
  expect(errors).toEqual([]);
});

test("manual Alloha switches reset playback even when episodes resolve to the same URL", async ({ page }) => {
  const log = await setup(page, { sameUrl: true, resumeTime: { tv_1399_s1e1: 300, tv_1399_s1e2: 30 } });
  await page.goto("/tv/1399");
  await card(page, 1).click();
  await startEmbed(page);
  await expect.poll(() => frame(page).evaluate(() => window.time)).toBe(300);
  await card(page, 2).click();
  await assertEpisode(page, 1, 2);
  await expect.poll(() => log.resolve.at(-1)).toBe("s1e2");
  await startEmbed(page);
  await expect.poll(() => frame(page).evaluate(() => window.time)).toBe(30);
  await card(page, 3).click();
  await assertEpisode(page, 1, 3);
  await startEmbed(page);
  expect(await frame(page).evaluate(() => window.time)).toBeLessThan(1);
});

test("a stale episode resolve cannot replace the viewer's latest selection", async ({ page }) => {
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const log = await setup(page, { holdResolve: (id) => id === "s1e2" ? pending : undefined });
  try {
    await page.goto("/tv/1399");
    await card(page, 1).click();
    await startEmbed(page);
    await card(page, 2).click();
    await expect.poll(() => log.resolve).toContain("s1e2");
    await expect(page.locator(".torrplayer-embed")).toHaveCount(0);
    await card(page, 3).click();
    await assertEpisode(page, 1, 3);
    await expect(page.locator(".torrplayer-embed")).toHaveAttribute("src", /episode=s1e3/);
  } finally {
    release();
  }
  await page.waitForTimeout(300);
  await assertEpisode(page, 1, 3);
  await expect(page.locator(".torrplayer-embed")).toHaveAttribute("src", /episode=s1e3/);
});

for (const automatic of [false, true]) {
  test(`Alloha ${automatic ? "autoplay" : "Play Now"} loads the exact next episode without carrying the old position`, async ({ page }) => {
    const log = await setup(page, { duration: automatic ? 1 : 0, resumeTime: { tv_1399_s1e1: 300 } });
    await page.goto("/tv/1399");
    await card(page, 1).click();
    await startEmbed(page);
    await expect.poll(() => frame(page).evaluate(() => window.time)).toBe(300);
    await ending(page);
    if (!automatic) await page.getByRole("button", { name: "Play Now", exact: true }).click();
    await assertEpisode(page, 1, 2);
    await expect.poll(() => log.resolve.at(-1)).toBe("s1e2");
    await expect(page.locator(".torrplayer-embed")).toHaveAttribute("src", /episode=s1e2/);
    await startEmbed(page);
    expect(await frame(page).evaluate(() => window.commands.filter((command) => command.api === "seek" && command.value > 0))).toEqual([]);
  });
}

test("same-URL HLS episodes attach again, reset position, and retain the fullscreen video", async ({ page }) => {
  const log = await setup(page, { kind: "hls", duration: 1, resumeTime: { tv_1399_s1e1: 35 } });
  await page.goto("/tv/1399");
  await card(page, 1).click();
  const video = page.locator(".torrplayer-video");
  await expect.poll(() => video.evaluate((value) => value.currentTime)).toBeGreaterThanOrEqual(35);
  await expect.poll(() => video.evaluate((value) => value.getVideoPlaybackQuality().totalVideoFrames)).toBeGreaterThan(0);
  await video.evaluate((value) => { window.firstEpisodeVideo = value; });
  const requests = log.media.filter((file) => file === "series.m3u8").length;
  await page.locator(".torrplayer").hover();
  await page.locator(".torrplayer-btn--fs").click();
  await expect.poll(() => page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
  // Episode cards are outside fullscreen; end playback through the media event.
  await video.evaluate((value) => { value.currentTime = value.duration - 5; value.dispatchEvent(new Event("timeupdate")); });
  await expect.poll(() => log.resolve.at(-1)).toBe("s1e2");
  await expect.poll(() => log.media.filter((file) => file === "series.m3u8").length).toBeGreaterThan(requests);
  await expect.poll(() => video.evaluate((value) => value.currentTime)).toBeLessThan(10);
  expect(await video.evaluate((value) => value === window.firstEpisodeVideo)).toBe(true);
  expect(await page.evaluate(() => Boolean(document.fullscreenElement))).toBe(true);
  await page.locator(".torrplayer").hover();
  await expect(page.locator(".torrplayer-heading")).toContainText("Сезон 1, серия 2");
  await page.evaluate(() => document.exitFullscreen());
  await assertEpisode(page, 1, 2);
  await expect.poll(() => video.evaluate((value) => !value.paused && value.currentTime > 0 && value.currentTime < 10)).toBe(true);
  const nextRequests = log.media.filter((file) => file === "series.m3u8").length;
  await card(page, 3).click();
  await assertEpisode(page, 1, 3);
  await expect.poll(() => log.media.filter((file) => file === "series.m3u8").length).toBeGreaterThan(nextRequests);
  await expect.poll(() => video.evaluate((value) => !value.paused && value.currentTime > 0 && value.currentTime < 10)).toBe(true);
});
