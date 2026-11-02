import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect, devices } from "@playwright/test";

let fixtureDir;
let animeFixtureDir;
let prebufferFixtureDir;

test.beforeAll(() => {
  fixtureDir = mkdtempSync(join(tmpdir(), "streambert-player-"));
  execFileSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "color=c=black:s=160x90:r=10:d=100",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=8000:duration=100",
    "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency",
    "-pix_fmt", "yuv420p", "-g", "20", "-sc_threshold", "0",
    "-c:a", "aac", "-b:a", "32k", "-hls_time", "2", "-hls_list_size", "0",
    "-hls_segment_filename", join(fixtureDir, "fixture%03d.ts"),
    join(fixtureDir, "fixture.m3u8"),
  ]);
  animeFixtureDir = mkdtempSync(join(tmpdir(), "streambert-anime-player-"));
  execFileSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "color=c=black:s=160x90:r=2:d=1468",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
    "-g", "360", "-sc_threshold", "0", "-hls_time", "180", "-hls_list_size", "0",
    "-hls_segment_filename", join(animeFixtureDir, "anime-fixture%03d.ts"),
    join(animeFixtureDir, "anime-fixture.m3u8"),
  ]);
  prebufferFixtureDir = mkdtempSync(join(tmpdir(), "streambert-prebuffer-player-"));
  execFileSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y",
    "-f", "lavfi", "-i", "color=c=black:s=160x90:r=10:d=180",
    "-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency",
    "-pix_fmt", "yuv420p", "-g", "20", "-sc_threshold", "0",
    "-hls_time", "2", "-hls_list_size", "0",
    "-hls_segment_filename", join(prebufferFixtureDir, "prebuffer%03d.ts"),
    join(prebufferFixtureDir, "prebuffer.m3u8"),
  ]);
});

test.afterAll(() => {
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
  if (animeFixtureDir) rmSync(animeFixtureDir, { recursive: true, force: true });
  if (prebufferFixtureDir) rmSync(prebufferFixtureDir, { recursive: true, force: true });
});

test("web movie detail prebuffers silently, then starts the same player at the saved position", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("lampa_stream_tmdb_token", "e2e-fake-token");
    localStorage.setItem("streambert_playerSource", JSON.stringify("lampac"));
    localStorage.setItem("streambert_resumeTime", JSON.stringify({ movie_550: 30 }));
    localStorage.setItem("streambert_progress", JSON.stringify({}));
    localStorage.setItem("streambert_history", JSON.stringify([]));
  });
  await page.route("**/api/tmdb/**", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ id: 550, title: "Movie 550", original_title: "Movie 550", runtime: 94, release_date: "1994-01-01", genres: [], credits: [] }),
  }));
  const sourceRequests = [];
  const resolveRequests = [];
  page.on("request", (request) => {
    if (request.url().includes("/api/source-host?op=discover")) sourceRequests.push({ url: request.url(), body: request.postDataJSON() });
  });
  await page.route("**/api/source-host?op=discover", (route) => {
    const body = route.request().postDataJSON();
    const candidateEvent = `event: candidate\ndata: ${JSON.stringify({
      id: "playback-id",
      providerId: "habster:alloha", providerName: "Habster · Alloha",
      voiceId: "voice-original", voiceName: "Original", qualityHint: "Auto",
    })}\n\n`;
    return route.fulfill({ status: 200, contentType: "text/event-stream", body: `${candidateEvent}event: done\ndata: {"candidates":1,"complete":true}\n\n` });
  });
  await page.route("**/api/source-host?op=resolve", (route) => {
    resolveRequests.push(route.request().postDataJSON());
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      kind: "hls", selected: { url: "https://media.test/master.m3u8", label: "360p" },
      qualities: [{ label: "360p", height: 360, url: "https://media.test/master.m3u8" }], subtitles: [], audioNames: [],
    }) });
  });
  const mediaRequests = [];
  await page.route("https://media.test/**", (route) => {
    const pathname = new URL(route.request().url()).pathname;
    mediaRequests.push(pathname);
    if (pathname === "/master.m3u8") return route.fulfill({
      status: 200, contentType: "application/vnd.apple.mpegurl",
      body: "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=350000,RESOLUTION=160x90\nprebuffer.m3u8\n",
    });
    if (pathname === "/prebuffer.m3u8") return route.fulfill({
      status: 200, contentType: "application/vnd.apple.mpegurl",
      body: readFileSync(join(prebufferFixtureDir, "prebuffer.m3u8")),
    });
    return route.fulfill({
      status: 200, contentType: "video/mp2t",
      body: readFileSync(join(prebufferFixtureDir, pathname.split("/").pop())),
    });
  });

  await page.goto("/movie/550", { waitUntil: "domcontentloaded" });
  const watch = page.getByRole("button", { name: "Смотреть", exact: true });
  await expect(watch).toBeVisible();
  await expect.poll(() => sourceRequests.length).toBe(1);
  expect(new URL(sourceRequests[0].url).searchParams.get("op")).toBe("discover");
  expect(sourceRequests[0].body).not.toHaveProperty("prepareOnly");
  await expect.poll(() => resolveRequests.length).toBe(1);
  expect(resolveRequests[0].id).toBe("playback-id");

  const video = page.locator("video");
  await expect(video).toHaveCount(1);
  await expect.poll(() => mediaRequests.some((path) => path.endsWith(".ts"))).toBe(true);
  await expect.poll(() => video.evaluate((element) => element.buffered.length > 0)).toBe(true);
  const before = await page.evaluate(() => {
    const video = document.querySelector("video");
    return {
      src: video.currentSrc,
      paused: video.paused,
      currentTime: video.currentTime,
      bufferedAhead: video.buffered.length ? video.buffered.end(video.buffered.length - 1) - video.currentTime : 0,
      resume: localStorage.getItem("streambert_resumeTime"),
      progress: localStorage.getItem("streambert_progress"),
      history: localStorage.getItem("streambert_history"),
    };
  });
  expect(before.paused).toBe(true);
  expect(before.currentTime).toBeGreaterThanOrEqual(29.5);
  expect(before.currentTime).toBeLessThanOrEqual(30.5);
  expect(before.bufferedAhead).toBeLessThanOrEqual(10);
  expect(before.resume).toBe(JSON.stringify({ movie_550: 30 }));
  expect(before.progress).toBe(JSON.stringify({}));
  expect(before.history).toBe(JSON.stringify([]));
  expect(mediaRequests.filter((path) => path.endsWith(".ts")).length).toBeLessThanOrEqual(5);
  await page.evaluate(() => { window.__prebufferVideo = document.querySelector("video"); });
  const discoversBeforeActivation = sourceRequests.length;

  await watch.click();
  await expect.poll(() => sourceRequests.length).toBe(discoversBeforeActivation);
  await expect.poll(() => video.evaluate((element) => !element.paused && element.currentTime >= 30)).toBe(true);
  await expect.poll(() => video.evaluate((element) => element.getVideoPlaybackQuality().totalVideoFrames)).toBeGreaterThan(0);
  const after = await page.evaluate(() => {
    const video = document.querySelector("video");
    return { sameNode: window.__prebufferVideo === video, src: video.currentSrc };
  });
  expect(after.sameNode).toBe(true);
  expect(after.src).toBe(before.src);
  expect(resolveRequests).toHaveLength(1);
  expect(await video.evaluate((element) => ({ muted: element.muted, volume: element.volume }))).toEqual({ muted: false, volume: 1 });
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem("streambert_history") || "[]").some((entry) => entry.id === 550))).toBe(true);

  // "Сначала" must not lift a deliberate pause.
  await page.locator(".torrplayer-stage video").click();
  await expect.poll(() => video.evaluate((element) => element.paused)).toBe(true);
  await page.getByRole("button", { name: "Сначала", exact: true }).click();
  await page.waitForTimeout(300);
  expect(await video.evaluate((element) => element.paused)).toBe(true);
  await page.goto("/");
  await expect(page.locator("video")).toHaveCount(0);
});

const prebufferRoutes = async (page, { discover } = {}) => {
  await page.addInitScript(() => {
    localStorage.setItem("lampa_stream_tmdb_token", "e2e-fake-token");
    localStorage.setItem("streambert_playerSource", JSON.stringify("lampac"));
  });
  await page.route("**/api/tmdb/**", (route) => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ id: 550, title: "Movie 550", release_date: "1994-01-01", runtime: 94, overview: "", genres: [] }),
  }));
  const counts = { discover: 0, resolve: 0, segments: 0 };
  await page.route("**/api/source-host?op=discover", (route) => {
    counts.discover++;
    if (discover && discover(counts.discover)) return route.fulfill(discover(counts.discover));
    return route.fulfill({ status: 200, contentType: "text/event-stream", body: `event: candidate\ndata: ${JSON.stringify({
      id: "a", providerId: "habster:alloha", providerName: "Habster · Alloha", voiceId: "v", voiceName: "Original",
    })}\n\nevent: done\ndata: {}\n\n` });
  });
  await page.route("**/api/source-host?op=resolve", (route) => {
    counts.resolve++;
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      kind: "hls", selected: { url: "https://media.test/prebuffer.m3u8", label: "360p" },
      qualities: [{ label: "360p", height: 360 }], subtitles: [], audioNames: [],
    }) });
  });
  await page.route("https://media.test/**", (route) => {
    const file = new URL(route.request().url()).pathname.split("/").pop();
    if (file.endsWith(".ts")) counts.segments++;
    return route.fulfill({
      status: 200, contentType: file.endsWith(".ts") ? "video/mp2t" : "application/vnd.apple.mpegurl",
      body: readFileSync(join(prebufferFixtureDir, file)),
    });
  });
  return counts;
};

test("a hidden prebuffer failure does not greet the click: it retries from scratch", async ({ page }) => {
  const counts = await prebufferRoutes(page, {
    discover: (attempt) => (attempt === 1 ? { status: 502, contentType: "application/json", body: "{}" } : null),
  });
  await page.goto("/movie/550", { waitUntil: "domcontentloaded" });
  await expect.poll(() => counts.discover).toBe(1);
  await expect(page.locator("video")).toHaveCount(0);
  await page.waitForTimeout(1500);
  await page.getByRole("button", { name: "Смотреть", exact: true }).click();
  const video = page.locator("video");
  await expect.poll(() => video.evaluate((v) => !v.paused && v.currentTime > 0).catch(() => false), { timeout: 20_000 }).toBe(true);
  expect(counts.discover).toBe(2);
  await expect(page.getByText("Не удалось получить рабочий поток")).toHaveCount(0);
});

test("an old unused prebuffer is dropped, and intent on the button starts a fresh one", async ({ page }) => {
  const counts = await prebufferRoutes(page);
  await page.clock.install();
  await page.goto("/movie/550", { waitUntil: "domcontentloaded" });
  const video = page.locator("video");
  await expect(page.getByRole("button", { name: "Смотреть", exact: true })).toBeVisible();
  await page.clock.fastForward(1300);
  await expect(video).toHaveCount(1);
  await expect.poll(() => counts.resolve).toBe(1);
  await page.clock.fastForward(4 * 60_000 + 1000);
  await expect(video).toHaveCount(0);
  await page.getByRole("button", { name: "Смотреть", exact: true }).hover();
  await expect(video).toHaveCount(1);
  await expect.poll(() => counts.resolve).toBe(2);
});

test("leaving the card inside the app stops the prebuffer", async ({ page }) => {
  const counts = await prebufferRoutes(page);
  await page.goto("/movie/550", { waitUntil: "domcontentloaded" });
  const video = page.locator("video");
  await expect.poll(() => counts.segments, { timeout: 20_000 }).toBeGreaterThan(0);
  await page.getByRole("button", { name: "Каталог", exact: true }).click();
  await expect(page).toHaveURL(/\/discover$/);
  await expect(video).toHaveCount(0);
  const stopped = counts.segments;
  await page.waitForTimeout(1500);
  expect(counts.segments).toBe(stopped);
});

test("rotating a phone on the card does not open the hidden player fullscreen", async ({ browser }, testInfo) => {
  const context = await browser.newContext({ ...devices["Pixel 7 landscape"], baseURL: testInfo.project.use.baseURL, serviceWorkers: "block" });
  const page = await context.newPage();
  await page.addInitScript(() => {
    window.__fullscreenCalls = 0;
    Element.prototype.requestFullscreen = async function requestFullscreen() { window.__fullscreenCalls++; };
  });
  const counts = await prebufferRoutes(page);
  await page.goto("/movie/550", { waitUntil: "domcontentloaded" });
  await expect.poll(() => counts.segments, { timeout: 20_000 }).toBeGreaterThan(0);
  expect(await page.evaluate(() => window.__fullscreenCalls)).toBe(0);
  await page.getByRole("button", { name: "Смотреть", exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__fullscreenCalls)).toBeGreaterThan(0);
  await context.close();
});

test("web movie detail does not prebuffer a glanced card or with data saver on", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("lampa_stream_tmdb_token", "e2e-fake-token");
    localStorage.setItem("streambert_playerSource", JSON.stringify("lampac"));
    if (location.search.includes("saver")) Object.defineProperty(navigator, "connection", { value: { saveData: true } });
  });
  await page.route("**/api/tmdb/**", (route) => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ id: 550, title: "Movie 550", release_date: "1994-01-01", runtime: 94, overview: "", genres: [] }),
  }));
  const discovers = [];
  await page.route("**/api/source-host?op=discover", (route) => {
    discovers.push(route.request().url());
    return route.fulfill({ status: 200, contentType: "text/event-stream", body: "event: done\ndata: {}\n\n" });
  });

  // Leaving before the dwell ends never starts discovery.
  await page.goto("/movie/550", { waitUntil: "domcontentloaded" });
  const watch = page.getByRole("button", { name: "Смотреть", exact: true });
  await expect(watch).toBeVisible();
  await page.goto("/");
  await page.waitForTimeout(1500);
  expect(discovers).toHaveLength(0);

  // Data saver: neither the dwell nor intent on the button prebuffers.
  await page.goto("/movie/550?saver=1", { waitUntil: "domcontentloaded" });
  await expect(watch).toBeVisible();
  await watch.focus();
  await page.waitForTimeout(1500);
  expect(discovers).toHaveLength(0);
  await expect(page.locator("video")).toHaveCount(0);
});

test("a source failing during hidden prebuffer falls over silently and the click plays the next one", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("lampa_stream_tmdb_token", "e2e-fake-token");
    localStorage.setItem("streambert_playerSource", JSON.stringify("lampac"));
    localStorage.setItem("streambert_history", JSON.stringify([]));
  });
  await page.route("**/api/tmdb/**", (route) => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ id: 550, title: "Movie 550", release_date: "1994-01-01", runtime: 94, overview: "", genres: [] }),
  }));
  await page.route("**/api/source-host?op=discover", (route) => route.fulfill({
    status: 200, contentType: "text/event-stream",
    body: ["broken", "good"].map((id) => `event: candidate\ndata: ${JSON.stringify({ id, providerId: id, providerName: id, voiceId: id, voiceName: id })}\n\n`).join("") + "event: done\ndata: {}\n\n",
  }));
  await page.route("**/api/source-host?op=resolve", async (route) => {
    const { id } = route.request().postDataJSON();
    // The broken source must win the parallel automatic resolve.
    if (id === "good") await new Promise((resolve) => setTimeout(resolve, 400));
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      kind: "hls", selected: { url: `https://media.test/${id}/prebuffer.m3u8`, label: "360p" },
      qualities: [{ label: "360p", height: 360 }], subtitles: [], audioNames: [],
    }) });
  });
  await page.route("https://media.test/**", (route) => {
    const [, id, file] = new URL(route.request().url()).pathname.split("/");
    if (file.endsWith(".m3u8")) return route.fulfill({
      status: 200, contentType: "application/vnd.apple.mpegurl",
      body: readFileSync(join(prebufferFixtureDir, "prebuffer.m3u8")),
    });
    if (id === "broken") return route.fulfill({ status: 502, body: "" });
    return route.fulfill({ status: 200, contentType: "video/mp2t", body: readFileSync(join(prebufferFixtureDir, file)) });
  });

  await page.goto("/movie/550", { waitUntil: "domcontentloaded" });
  const video = page.locator("video");
  await expect.poll(() => video.evaluate((v) => v.currentSrc && v.buffered.length > 0).catch(() => false), { timeout: 30_000 }).toBe(true);
  expect(await video.evaluate((v) => v.paused)).toBe(true);
  expect(await page.evaluate(() => localStorage.getItem("streambert_history"))).toBe("[]");

  await page.getByRole("button", { name: "Смотреть", exact: true }).click();
  await expect.poll(() => video.evaluate((v) => !v.paused && v.currentTime > 0)).toBe(true);
  await expect(page.getByText("Не удалось получить рабочий поток")).toHaveCount(0);
  expect(await video.evaluate((v) => ({ muted: v.muted, volume: v.volume }))).toEqual({ muted: false, volume: 1 });
});

const tvEpisodes = (season) => Array.from({ length: 8 }, (_, index) => ({
  id: season * 100 + index + 1, season_number: season, episode_number: index + 1, name: `S${season} episode ${index + 1}`,
  // The last episode has not aired yet.
  air_date: index === 7 ? "2099-01-01" : "2024-01-01", still_path: null, overview: "",
}));

const tvPrebufferRoutes = async (page, { storage = {}, saver = false, holdDiscover = null, failDiscover = null } = {}) => {
  await page.addInitScript(({ storage, saver }) => {
    if (sessionStorage.getItem("tv-prebuffer-fixture")) return;
    sessionStorage.setItem("tv-prebuffer-fixture", "1");
    localStorage.setItem("lampa_stream_tmdb_token", "e2e-fake-token");
    localStorage.setItem("streambert_playerSource", JSON.stringify("lampac"));
    localStorage.setItem("streambert_history", JSON.stringify([]));
    localStorage.setItem("streambert_progress", JSON.stringify(storage.progress || {}));
    localStorage.setItem("streambert_resumeTime", JSON.stringify(storage.resumeTime || {}));
    localStorage.setItem("streambert_watched", JSON.stringify(storage.watched || {}));
    for (const [key, value] of Object.entries(storage.settings || {})) localStorage.setItem(`streambert_${key}`, JSON.stringify(value));
  }, { storage, saver });
  await page.addInitScript((saver) => {
    if (saver) Object.defineProperty(navigator, "connection", { value: { saveData: true } });
    window.__playedVideos = new Set();
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function playAndRecord() {
      window.__playedVideos.add(this);
      return play.call(this);
    };
  }, saver);
  await page.route("**/api/tmdb/**", (route) => {
    const season = /\/season\/(\d+)/.exec(new URL(route.request().url()).pathname)?.[1];
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(season
      ? { id: 1399, season_number: Number(season), episodes: tvEpisodes(Number(season)) }
      : { id: 1399, name: "TV 1399", original_name: "TV 1399", first_air_date: "2024-01-01", overview: "", genres: [], number_of_seasons: 2, external_ids: { imdb_id: "tt0001399" },
        seasons: [1, 2].map((number) => ({ season_number: number, episode_count: 8, name: `Season ${number}` })) }) });
  });
  const log = { discover: [], aborted: [], resolve: [], media: [] };
  page.on("requestfailed", (request) => {
    if (request.url().includes("op=discover")) log.aborted.push(request.postDataJSON()?.episode);
  });
  await page.route("**/api/source-host?op=discover", async (route) => {
    const { season, episode } = route.request().postDataJSON();
    log.discover.push(`s${season}e${episode}`);
    if (failDiscover?.(log.discover.length)) return route.fulfill({ status: 502, contentType: "application/json", body: "{}" });
    if (holdDiscover) await holdDiscover(`s${season}e${episode}`);
    const id = `s${season}e${episode}`;
    return route.fulfill({ status: 200, contentType: "text/event-stream", body: `event: candidate\ndata: ${JSON.stringify({
      id, providerId: "habster:alloha", providerName: "Habster · Alloha", voiceId: "v", voiceName: "Original", season, episode,
    })}\n\nevent: done\ndata: {}\n\n` }).catch(() => {});
  });
  await page.route("**/api/source-host?op=resolve", (route) => {
    const { id } = route.request().postDataJSON();
    log.resolve.push(id);
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
      kind: "hls", selected: { url: `https://media.test/${id}/prebuffer.m3u8`, label: "360p" },
      qualities: [{ label: "360p", height: 360 }], subtitles: [], audioNames: [],
    }) });
  });
  await page.route("https://media.test/**", (route) => {
    const [, id, file] = new URL(route.request().url()).pathname.split("/");
    log.media.push(id);
    return route.fulfill({
      status: 200, contentType: file.endsWith(".ts") ? "video/mp2t" : "application/vnd.apple.mpegurl",
      body: readFileSync(join(prebufferFixtureDir, file)),
    });
  });
  return log;
};

const episodeCard = (page, number) => page.locator(".episode-card").nth(number - 1);
const hiddenPlaybackState = (page) => page.evaluate(() => {
  const video = document.querySelector("video");
  return {
    paused: video.paused, muted: video.muted, currentTime: video.currentTime,
    buffered: video.buffered.length > 0,
    url: location.search,
    history: localStorage.getItem("streambert_history"),
    progress: localStorage.getItem("streambert_progress"),
    resume: localStorage.getItem("streambert_resumeTime"),
    watched: localStorage.getItem("streambert_watched"),
    sessions: Object.keys(JSON.parse(localStorage.getItem("streambert_viewingData") || "{}").sessions || {}),
    checkpoints: Object.keys(JSON.parse(localStorage.getItem("streambert_viewingData") || "{}").checkpoints || {}),
    played: window.__playedVideos.has(video),
  };
});
const expectPlayingFromClick = async (page, { minTime = 0 } = {}) => {
  const video = page.locator("video");
  await expect.poll(() => video.evaluate((v, min) => !v.paused && v.currentTime > min, minTime), { timeout: 20_000 }).toBe(true);
  expect(await video.evaluate((v) => ({ muted: v.muted, volume: v.volume }))).toEqual({ muted: false, volume: 1 });
};
const historyEntry = (page) => page.evaluate(() => {
  const [entry] = JSON.parse(localStorage.getItem("streambert_history") || "[]");
  return entry && { id: entry.id, season: entry.season, episode: entry.episode };
});

test("TV: the unfinished episode prebuffers silently, and its click starts the same player at the saved position", async ({ page }) => {
  const storage = {
    watched: { tv_1399_s1e1: true, tv_1399_s1e2: true },
    progress: { tv_1399_s1e3: 25 },
    resumeTime: { tv_1399_s1e3: 30 },
  };
  const log = await tvPrebufferRoutes(page, { storage });
  await page.goto("/tv/1399", { waitUntil: "domcontentloaded" });
  await expect(page.locator(".episode-card")).toHaveCount(8);
  await expect.poll(() => log.media.length, { timeout: 20_000 }).toBeGreaterThan(1);
  const video = page.locator("video");
  await expect.poll(() => video.evaluate((v) => v.buffered.length > 0)).toBe(true);
  expect(log.discover).toEqual(["s1e3"]);

  const before = await hiddenPlaybackState(page);
  expect(before).toMatchObject({
    paused: true, muted: true, played: false, sessions: [], checkpoints: [], history: "[]",
    progress: JSON.stringify(storage.progress), resume: JSON.stringify(storage.resumeTime), watched: JSON.stringify(storage.watched),
  });
  expect(before.currentTime).toBeGreaterThanOrEqual(29.5);
  expect(before.currentTime).toBeLessThanOrEqual(30.5);
  expect(new URLSearchParams(before.url).has("episode")).toBe(false);
  await expect(page.getByText("Сезон 1 · Э3")).toHaveCount(0);
  await page.evaluate(() => { window.__prebufferVideo = document.querySelector("video"); });

  await episodeCard(page, 3).click();
  await expectPlayingFromClick(page, { minTime: 30 });
  expect(await page.evaluate(() => window.__prebufferVideo === document.querySelector("video"))).toBe(true);
  expect(log.discover).toEqual(["s1e3"]);
  expect(log.resolve).toEqual(["s1e3"]);
  expect(new Set(log.media)).toEqual(new Set(["s1e3"]));
  await expect(page.getByText("Сезон 1 · Э3")).toBeVisible();
  await expect.poll(() => historyEntry(page)).toEqual({ id: 1399, season: 1, episode: 3 });
  await expect(page).toHaveURL(/season=1&episode=3/);
});

test("TV: the route's episode prebuffers exactly, and a season switch drops it for the new season", async ({ page }) => {
  const log = await tvPrebufferRoutes(page);
  await page.goto("/tv/1399?season=2&episode=4", { waitUntil: "domcontentloaded" });
  await expect.poll(() => log.discover, { timeout: 20_000 }).toEqual(["s2e4"]);
  await expect.poll(() => page.locator("video").evaluate((v) => v.buffered.length > 0)).toBe(true);
  await page.evaluate(() => { window.__seasonTwoVideo = document.querySelector("video"); });

  await page.locator(".season-btn").first().click();
  await expect(page.locator(".season-btn.active")).toContainText("Сезон 1");
  await expect.poll(() => page.evaluate(() => !document.querySelector("video") || document.querySelector("video") !== window.__seasonTwoVideo)).toBe(true);
  await expect.poll(() => log.discover, { timeout: 20_000 }).toEqual(["s2e4", "s1e1"]);
  await expect.poll(() => page.locator("video").evaluate((v) => v.buffered.length > 0)).toBe(true);
  const seasonOneStart = log.media.length;

  await episodeCard(page, 1).click();
  await expectPlayingFromClick(page);
  await expect(page.getByText("Сезон 1 · Э1")).toBeVisible();
  await expect.poll(() => historyEntry(page)).toEqual({ id: 1399, season: 1, episode: 1 });
  expect(new Set(log.media.slice(seasonOneStart))).toEqual(new Set(["s1e1"]));
  expect(log.discover).toEqual(["s2e4", "s1e1"]);
});

test("TV: a rest on an episode card prebuffers that episode and the click reuses it", async ({ page }) => {
  const log = await tvPrebufferRoutes(page);
  await page.goto("/tv/1399", { waitUntil: "domcontentloaded" });
  await expect(page.locator(".episode-card")).toHaveCount(8);
  await episodeCard(page, 5).hover();
  await expect.poll(() => log.discover, { timeout: 20_000 }).toContain("s1e5");
  await expect.poll(() => page.locator("video").evaluate((v) => v.buffered.length > 0)).toBe(true);
  // The pointer resting on the card outranks the guess at the next unwatched episode.
  await page.waitForTimeout(1500);
  expect(log.discover).toEqual(["s1e5"]);
  const hidden = await hiddenPlaybackState(page);
  expect(hidden).toMatchObject({ paused: true, muted: true, played: false, checkpoints: [], history: "[]" });
  expect(new URLSearchParams(hidden.url).has("episode")).toBe(false);
  await expect(episodeCard(page, 5)).not.toHaveClass(/playing/);
  await page.evaluate(() => { window.__prebufferVideo = document.querySelector("video"); });

  await episodeCard(page, 5).click();
  await expectPlayingFromClick(page);
  expect(await page.evaluate(() => window.__prebufferVideo === document.querySelector("video"))).toBe(true);
  expect(log.discover).toEqual(["s1e5"]);
  await expect(page.getByText("Сезон 1 · Э5")).toBeVisible();

  // During playback a card under the pointer starts nothing: the visible player owns the page.
  await episodeCard(page, 2).hover();
  await page.waitForTimeout(800);
  expect(log.discover).toEqual(["s1e5"]);
});

test("TV: sweeping over the episode list does not flood discovery", async ({ page }) => {
  const held = [];
  const log = await tvPrebufferRoutes(page, {
    holdDiscover: () => new Promise((resolve) => { held.push(resolve); setTimeout(resolve, 60_000); }),
  });
  await page.setViewportSize({ width: 1280, height: 2400 });
  await page.goto("/tv/1399", { waitUntil: "domcontentloaded" });
  await expect(page.locator(".episode-card")).toHaveCount(8);
  await expect(episodeCard(page, 7)).toBeInViewport();
  const centers = await page.locator(".episode-card").evaluateAll((cards) => cards.map((card) => {
    const box = card.getBoundingClientRect();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }));
  const moveTo = (number) => page.mouse.move(centers[number - 1].x, centers[number - 1].y);

  // A fast sweep rests nowhere. It outlasts the page dwell, and the guess at the
  // next episode must still run once the pointer leaves.
  for (let round = 0; round < 6; round++) {
    for (let number = 1; number <= 7; number++) {
      await moveTo(number);
      await page.waitForTimeout(40);
    }
  }
  await page.mouse.move(0, 0);
  await expect.poll(() => log.discover, { timeout: 5_000 }).toEqual(["s1e1"]);
  await page.waitForTimeout(800);
  expect(log.discover).toEqual(["s1e1"]);

  // Resting 500 ms on each card inside the 3 s cooldown keeps one discovery running.
  await page.waitForTimeout(3100);
  const started = Date.now();
  for (const number of [2, 3, 4, 5, 6, 7]) {
    await moveTo(number);
    await page.waitForTimeout(500);
  }
  const elapsed = Date.now() - started;
  expect(log.discover.length - 1).toBeLessThanOrEqual(Math.ceil(elapsed / 3000) + 1);
  await expect.poll(() => log.discover.at(-1), { timeout: 6_000 }).toBe("s1e7");
  // Every replaced hidden discovery was cancelled: one stays open at most.
  await expect.poll(() => log.aborted.length).toBe(log.discover.length - 1);
  held.forEach((release) => release());
});

test("TV: prebuffers stop after a budget, a click still works", async ({ page }) => {
  const log = await tvPrebufferRoutes(page);
  await page.clock.install();
  await page.goto("/tv/1399", { waitUntil: "domcontentloaded" });
  await expect(page.locator(".episode-card")).toHaveCount(8);
  await page.clock.fastForward(1300);
  await expect.poll(() => log.discover).toEqual(["s1e1"]);
  for (const [index, number] of [2, 3, 4, 5, 6].entries()) {
    await episodeCard(page, number).hover();
    await page.clock.fastForward(3100);
    await expect.poll(() => log.discover).toHaveLength(index + 2);
  }
  expect(log.discover.at(-1)).toBe("s1e6");
  await episodeCard(page, 7).hover();
  await page.clock.fastForward(3100);
  await page.clock.fastForward(3100);
  expect(log.discover).toHaveLength(6);
  await episodeCard(page, 7).click();
  await expect.poll(() => log.discover.at(-1), { timeout: 20_000 }).toBe("s1e7");
});

test("TV: a failed player chunk leaves the page working and the click still plays", async ({ page }) => {
  const log = await tvPrebufferRoutes(page);
  const blockChunk = (route) => route.abort();
  await page.route(/\/OnlinePlayer-[^/]*\.js/, blockChunk);
  await page.goto("/tv/1399", { waitUntil: "domcontentloaded" });
  await expect(page.locator(".episode-card")).toHaveCount(8);
  await page.waitForTimeout(2000);
  await expect(page.locator(".episode-card")).toHaveCount(8);
  await expect(page.locator(".torrplayer-stage")).toHaveCount(0);
  expect(log.discover).toEqual([]);
  await page.unroute(/\/OnlinePlayer-[^/]*\.js/, blockChunk);
  await episodeCard(page, 1).click();
  await expectPlayingFromClick(page);
  expect(log.discover).toEqual(["s1e1"]);
});

test("TV: a series above the age limit starts nothing while its rating is still loading", async ({ page }) => {
  const log = await tvPrebufferRoutes(page, { storage: { settings: { ageLimit: 12 } } });
  // Registered last, so it wins over the generic metadata route of the helper.
  await page.route("**/api/tmdb/**/content_ratings*", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 2500));
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ results: [{ iso_3166_1: "US", rating: "TV-MA" }] }) });
  });
  await page.goto("/tv/1399", { waitUntil: "domcontentloaded" });
  await expect(page.locator(".episode-card")).toHaveCount(8);
  await episodeCard(page, 3).hover();
  await expect(page.locator(".episode-card--restricted").first()).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(1500);
  expect(log.discover).toEqual([]);
  await expect(page.locator(".torrplayer-stage")).toHaveCount(0);
});

test("TV: clicking another episode never reveals the hidden one", async ({ page }) => {
  const log = await tvPrebufferRoutes(page);
  await page.goto("/tv/1399", { waitUntil: "domcontentloaded" });
  await expect.poll(() => log.discover, { timeout: 20_000 }).toEqual(["s1e1"]);
  await expect.poll(() => page.locator("video").evaluate((v) => v.buffered.length > 0)).toBe(true);
  await page.evaluate(() => { window.__hiddenVideo = document.querySelector("video"); });
  const hiddenMedia = log.media.length;

  await episodeCard(page, 6).click();
  await expectPlayingFromClick(page);
  expect(await page.evaluate(() => ({
    replaced: window.__hiddenVideo !== document.querySelector("video"),
    hiddenPlayed: window.__playedVideos.has(window.__hiddenVideo),
  }))).toEqual({ replaced: true, hiddenPlayed: false });
  expect(log.discover).toEqual(["s1e1", "s1e6"]);
  expect(new Set(log.media.slice(hiddenMedia))).toEqual(new Set(["s1e6"]));
  await expect(page.getByText("Сезон 1 · Э6")).toBeVisible();
  await expect.poll(() => historyEntry(page)).toEqual({ id: 1399, season: 1, episode: 6 });
  await expect(page).toHaveURL(/season=1&episode=6/);
});

test("TV: the same episode number in another season is a different episode", async ({ page }) => {
  const log = await tvPrebufferRoutes(page);
  await page.goto("/tv/1399?season=2&episode=4", { waitUntil: "domcontentloaded" });
  await expect.poll(() => log.discover, { timeout: 20_000 }).toEqual(["s2e4"]);
  await expect.poll(() => page.locator("video").evaluate((v) => v.buffered.length > 0)).toBe(true);
  const hiddenMedia = log.media.length;
  await page.locator(".season-btn").first().click();
  await expect(page.locator(".season-btn.active")).toContainText("Сезон 1");
  await expect(page.locator(".episode-card")).toHaveCount(8);
  await episodeCard(page, 4).click();
  await expectPlayingFromClick(page);
  expect(log.discover).toEqual(["s2e4", "s1e4"]);
  expect(new Set(log.media.slice(hiddenMedia))).toEqual(new Set(["s1e4"]));
  await expect(page.getByText("Сезон 1 · Э4")).toBeVisible();
  await expect.poll(() => historyEntry(page)).toEqual({ id: 1399, season: 1, episode: 4 });
});

test("TV: a click during the hidden discovery keeps it and starts when the source arrives", async ({ page }) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const log = await tvPrebufferRoutes(page, { holdDiscover: () => gate });
  await page.goto("/tv/1399", { waitUntil: "domcontentloaded" });
  await expect.poll(() => log.discover, { timeout: 20_000 }).toEqual(["s1e1"]);
  await episodeCard(page, 1).click();
  await expect.poll(() => historyEntry(page)).toEqual({ id: 1399, season: 1, episode: 1 });
  release();
  await expectPlayingFromClick(page);
  expect(log.discover).toEqual(["s1e1"]);
});

test("TV: autoplay continues to the exact next episode after a prebuffered start", async ({ page }) => {
  test.setTimeout(90_000);
  // Starts inside the 20 s end threshold of the 180 s fixture, so the next episode is due at once.
  const log = await tvPrebufferRoutes(page, { storage: {
    progress: { tv_1399_s1e1: 90 }, resumeTime: { tv_1399_s1e1: 165 }, settings: { autoplayNextDuration: 1 },
  } });
  await page.goto("/tv/1399", { waitUntil: "domcontentloaded" });
  await expect.poll(() => log.discover, { timeout: 20_000 }).toEqual(["s1e1"]);
  const video = page.locator("video");
  await expect.poll(() => video.evaluate((v) => v.buffered.length > 0)).toBe(true);
  await page.evaluate(() => { window.__prebufferVideo = document.querySelector("video"); });
  await episodeCard(page, 1).click();
  await expectPlayingFromClick(page, { minTime: 165 });

  await expect(page.getByText("Сезон 1 · Э2")).toBeVisible({ timeout: 45_000 });
  await expect.poll(() => log.discover).toEqual(["s1e1", "s1e2"]);
  await expect.poll(() => historyEntry(page)).toEqual({ id: 1399, season: 1, episode: 2 });
  await expect.poll(() => log.media.includes("s1e2")).toBe(true);
  await expectPlayingFromClick(page);
  // The next episode replaces media in place; fullscreen depends on this node surviving.
  expect(await page.evaluate(() => window.__prebufferVideo === document.querySelector("video"))).toBe(true);
  await expect(page).toHaveURL(/season=1&episode=2/);
});

test("TV: a hidden failure does not retry on its own and the click starts fresh", async ({ page }) => {
  const log = await tvPrebufferRoutes(page, { failDiscover: (attempt) => attempt === 1 });
  await page.goto("/tv/1399", { waitUntil: "domcontentloaded" });
  await expect.poll(() => log.discover, { timeout: 20_000 }).toEqual(["s1e1"]);
  await expect(page.locator(".torrplayer-stage")).toHaveCount(0, { timeout: 15_000 });
  await page.waitForTimeout(2000);
  expect(log.discover).toEqual(["s1e1"]);
  await episodeCard(page, 1).click();
  await expectPlayingFromClick(page);
  expect(log.discover).toEqual(["s1e1", "s1e1"]);
  await expect(page.getByText("Не удалось получить рабочий поток")).toHaveCount(0);
});

test("TV: an old hidden prebuffer is dropped and does not restart without a new intent", async ({ page }) => {
  const log = await tvPrebufferRoutes(page);
  await page.clock.install();
  await page.goto("/tv/1399", { waitUntil: "domcontentloaded" });
  await expect(page.locator(".episode-card")).toHaveCount(8);
  await page.clock.fastForward(1300);
  const video = page.locator("video");
  await expect(video).toHaveCount(1);
  await expect.poll(() => log.discover).toEqual(["s1e1"]);
  await page.clock.fastForward(4 * 60_000 + 1000);
  await expect(video).toHaveCount(0);
  await page.clock.fastForward(5000);
  expect(log.discover).toEqual(["s1e1"]);
  await episodeCard(page, 1).hover();
  await page.clock.fastForward(400);
  await expect.poll(() => log.discover).toEqual(["s1e1", "s1e1"]);
});

test("TV: data saver, unaired episodes and a fully watched season prebuffer nothing", async ({ browser }, testInfo) => {
  const open = async (options) => {
    const context = await browser.newContext({ baseURL: testInfo.project.use.baseURL, serviceWorkers: "block" });
    const page = await context.newPage();
    const log = await tvPrebufferRoutes(page, options);
    await page.goto("/tv/1399?season=1", { waitUntil: "domcontentloaded" });
    await expect(page.locator(".episode-card")).toHaveCount(8);
    return { context, page, log };
  };
  const saver = await open({ saver: true });
  await episodeCard(saver.page, 2).hover();
  await saver.page.waitForTimeout(1700);
  expect(saver.log.discover).toEqual([]);
  await expect(saver.page.locator("video")).toHaveCount(0);
  await saver.context.close();

  const watched = Object.fromEntries(Array.from({ length: 7 }, (_, index) => [`tv_1399_s1e${index + 1}`, true]));
  const finished = await open({ storage: { watched } });
  await episodeCard(finished.page, 8).hover({ force: true });
  await finished.page.waitForTimeout(1700);
  expect(finished.log.discover).toEqual([]);
  await expect(finished.page.locator("video")).toHaveCount(0);
  await finished.context.close();
});

test("TV: a tap on a phone is not a hover, it plays the tapped episode once", async ({ browser }, testInfo) => {
  const context = await browser.newContext({ ...devices["Pixel 7"], baseURL: testInfo.project.use.baseURL, serviceWorkers: "block" });
  const page = await context.newPage();
  const watched = Object.fromEntries(Array.from({ length: 7 }, (_, index) => [`tv_1399_s1e${index + 1}`, true]));
  const log = await tvPrebufferRoutes(page, { storage: { watched } });
  await page.goto("/tv/1399?season=1", { waitUntil: "domcontentloaded" });
  await expect(page.locator(".episode-card")).toHaveCount(8);
  await episodeCard(page, 2).tap();
  await expect.poll(() => log.discover, { timeout: 20_000 }).toEqual(["s1e2"]);
  await expect.poll(() => historyEntry(page)).toEqual({ id: 1399, season: 1, episode: 2 });
  await page.waitForTimeout(1000);
  expect(log.discover).toEqual(["s1e2"]);
  await context.close();
});

test("TV: a tap on the prebuffered episode starts it on a phone", async ({ browser }, testInfo) => {
  const context = await browser.newContext({ ...devices["Pixel 7"], baseURL: testInfo.project.use.baseURL, serviceWorkers: "block" });
  const page = await context.newPage();
  const log = await tvPrebufferRoutes(page);
  await page.goto("/tv/1399?season=1", { waitUntil: "domcontentloaded" });
  await expect.poll(() => log.discover, { timeout: 20_000 }).toEqual(["s1e1"]);
  await expect.poll(() => page.locator("video").evaluate((v) => v.buffered.length > 0)).toBe(true);
  await page.evaluate(() => { window.__prebufferVideo = document.querySelector("video"); });
  await episodeCard(page, 1).tap();
  await expectPlayingFromClick(page);
  expect(await page.evaluate(() => window.__prebufferVideo === document.querySelector("video"))).toBe(true);
  expect(log.discover).toEqual(["s1e1"]);
  await context.close();
});

for (const mode of ["manual", "auto"]) test(`decoded movie playback skips confirmed segments (${mode})`, async ({ page }) => {
  await page.addInitScript((mode) => {
    localStorage.setItem("lampa_stream_tmdb_token", "e2e-fake-token");
    localStorage.setItem("streambert_skipHeuristicMode", JSON.stringify(mode));
    localStorage.setItem("streambert_playerSource", JSON.stringify("online"));
  }, mode);

  await page.route("**/api/tmdb/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = path.includes("external_ids")
      ? { imdb_id: "tt0111161" }
      : {
          id: 550,
          title: "Movie 550",
          poster_path: null,
          backdrop_path: null,
          runtime: 2,
          release_date: "1994-01-01",
          vote_average: 8,
          genres: [],
          credits: { cast: [] },
        };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(json) });
  });
  await page.route("https://api.themoviedb.org/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = path.includes("external_ids")
      ? { imdb_id: "tt0111161" }
      : { id: 550, title: "Movie 550", runtime: 2, genres: [], credits: { cast: [] } };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(json) });
  });
  await page.route("**/api/introdb?**", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      intro: { start_sec: 5, end_sec: 10, confidence: 1 },
      outro: { start_sec: 70, end_sec: 100, confidence: 1 },
      post_credits: { start_sec: 85, end_sec: 95, confidence: 1 },
    }),
  }));
  await page.route("**/fixture.m3u8", (route) => route.fulfill({
    status: 200,
    contentType: "application/vnd.apple.mpegurl",
    body: readFileSync(join(fixtureDir, "fixture.m3u8"), "utf8"),
  }));
  await page.route("**/fixture*.ts", (route) => route.fulfill({
    status: 200,
    contentType: "video/mp2t",
    body: readFileSync(join(fixtureDir, new URL(route.request().url()).pathname.split("/").pop())),
  }));
  await page.route("**/*.jpg", (route) => route.fulfill({ status: 204, body: "" }));

  await page.goto("/movie/550", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Смотреть", exact: true }).waitFor();
  await page.evaluate(() => {
    window.electron.collapsResolve = async () => ({ ok: true, hls: "/fixture.m3u8" });
  });
  await page.getByRole("button", { name: "Смотреть", exact: true }).click();
  await page.getByTitle("Сменить источник").click();
  await page.locator(".source-dropdown__item").filter({ hasText: "Онлайн" }).click();
  const video = page.locator("video");
  await expect(video).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => video.evaluate((v) => v.readyState), { timeout: 20_000 }).toBeGreaterThanOrEqual(2);
  await expect.poll(() => video.evaluate((v) => v.currentTime), { timeout: 10_000 }).toBeGreaterThan(0.5);

  await video.evaluate((v) => { v.currentTime = 5; });
  const skipButton = page.locator(".torrplayer-skip");
  if (mode === "manual") {
    await expect(skipButton).toContainText("ЗАСТАВКУ", { timeout: 5_000 });
    await skipButton.click();
  }
  await expect.poll(() => video.evaluate((v) => v.currentTime), { timeout: 5_000 }).toBeGreaterThanOrEqual(10);

  await video.evaluate((v) => { v.currentTime = 70; });
  if (mode === "manual") {
    await expect(skipButton).toContainText("ТИТРЫ", { timeout: 5_000 });
    await skipButton.click();
  }
  await expect.poll(() => video.evaluate((v) => v.currentTime), { timeout: 5_000 }).toBeGreaterThanOrEqual(85);
  await expect.poll(() => video.evaluate((v) => v.currentTime), { timeout: 2_000 }).toBeLessThan(95);
});

test("decoded movie playback recovers after HTTP and decode failures from manual source switches", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("lampa_stream_tmdb_token", "e2e-fake-token");
    localStorage.setItem("streambert_playerSource", JSON.stringify("lampac"));
  });
  const tmdb = async (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = path.includes("external_ids")
      ? { imdb_id: "tt0111161" }
      : { id: 550, title: "Movie 550", original_title: "Movie 550", imdb_id: "tt0111161", original_language: "en", runtime: 100, release_date: "1994-01-01", genres: [], credits: { cast: [] } };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(json) });
  };
  await page.route("**/api/tmdb/**", tmdb);
  await page.route("https://api.themoviedb.org/**", tmdb);
  let healthyManifestRequests = 0;
  let brokenManifestRequests = 0;
  await page.route("**/fixture.m3u8", (route) => {
    healthyManifestRequests += 1;
    return route.fulfill({
    status: 200,
    contentType: "application/vnd.apple.mpegurl",
    headers: { "access-control-allow-origin": "*" },
    body: readFileSync(join(fixtureDir, "fixture.m3u8"), "utf8"),
    });
  });
  await page.route("**/fixture*.ts", (route) => route.fulfill({
    status: 200,
    contentType: "video/mp2t",
    headers: { "access-control-allow-origin": "*" },
    body: readFileSync(join(fixtureDir, new URL(route.request().url()).pathname.split("/").pop())),
  }));
  await page.route("**/broken-fixture.m3u8", (route) => {
    brokenManifestRequests += 1;
    return route.fulfill({
    status: 200,
    contentType: "application/vnd.apple.mpegurl",
    headers: { "access-control-allow-origin": "*" },
    body: "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\nbroken-fixture.ts\n#EXT-X-ENDLIST\n",
    });
  });
  await page.route("**/broken-fixture.ts", (route) => route.fulfill({
    status: 200,
    contentType: "video/mp2t",
    headers: { "access-control-allow-origin": "*" },
    body: Buffer.alloc(2048, 0),
  }));
  await page.route(/\/api\/source-host\?op=discover(?:&|$)/, async (route) => {
    expect(route.request().method()).toBe("POST");
    const title = route.request().postDataJSON();
    expect(title.type).toBe("movie");
    expect(title.tmdbId).toBe(550);
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: [
        `event: candidate\ndata: ${JSON.stringify({ id: "good", providerId: "testgood", providerName: "Healthy source", voiceName: "Russian dub" })}\n\n`,
        `event: candidate\ndata: ${JSON.stringify({ id: "bad", providerId: "testbad", providerName: "Unavailable source", voiceName: "Russian dub" })}\n\n`,
        `event: candidate\ndata: ${JSON.stringify({ id: "decode-bad", providerId: "testdecode", providerName: "Broken source", voiceName: "Russian dub" })}\n\n`,
        "event: done\ndata: {\"candidates\":3,\"complete\":true}\n\n",
      ].join(""),
    });
  });
  await page.route(/\/api\/source-host\?op=resolve(?:&|$)/, async (route) => {
    const { id } = route.request().postDataJSON();
    if (id === "bad") return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "ENGINE_UNAVAILABLE" }) });
    if (id === "good") return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        kind: "hls",
        selected: { label: "720p", height: 720, url: "https://media.example/fixture.m3u8" },
        qualities: [{ label: "720p", height: 720, url: "https://media.example/fixture.m3u8" }],
      }),
    });
    if (id === "decode-bad") return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        kind: "hls",
        selected: { label: "720p", height: 720, url: "https://media.example/broken-fixture.m3u8" },
        qualities: [{ label: "720p", height: 720, url: "https://media.example/broken-fixture.m3u8" }],
      }),
    });
    return route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "NOT_FOUND" }) });
  });

  await page.goto("/movie/550", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Смотреть", exact: true }).click();
  const video = page.locator("video");
  await expect(video).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => video.evaluate((v) => v.readyState), { timeout: 20_000 }).toBeGreaterThanOrEqual(2);
  await expect.poll(() => video.evaluate((v) => v.currentTime), { timeout: 10_000 }).toBeGreaterThan(0.5);

  const balancer = page.getByRole("button", { name: "Healthy source" });
  await expect(balancer).toBeVisible();
  await balancer.click();
  await page.getByRole("button", { name: "Unavailable source", exact: true }).click();
  await expect.poll(() => video.evaluate((v) => v.currentTime), { timeout: 15_000 }).toBeGreaterThan(1);
  await expect(page.getByRole("button", { name: "Healthy source" })).toBeVisible();
  await expect.poll(() => video.evaluate((v) => v.readyState), { timeout: 15_000 }).toBeGreaterThanOrEqual(2);

  await video.evaluate((v) => { v.currentTime = 30; });
  await expect.poll(() => video.evaluate((v) => v.currentTime), { timeout: 5_000 }).toBeGreaterThanOrEqual(29);
  await page.getByRole("button", { name: "Healthy source" }).click();
  await page.getByRole("button", { name: "Broken source", exact: true }).click();
  await expect.poll(() => brokenManifestRequests, { timeout: 10_000 }).toBeGreaterThan(0);
  await expect.poll(() => healthyManifestRequests, { timeout: 25_000 }).toBeGreaterThan(1);
  await expect.poll(() => video.evaluate((v) => v.readyState), { timeout: 20_000 }).toBeGreaterThanOrEqual(2);
  await expect.poll(() => video.evaluate((v) => v.currentTime), { timeout: 10_000 }).toBeGreaterThanOrEqual(29);
});

test("late 4K sources stay optional and the quality shortcut preserves playback position", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("lampa_stream_tmdb_token", "e2e-fake-token");
    const originalFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      if (String(input).includes("/api/source-host?op=discover")) {
        return Promise.resolve(new Response(new ReadableStream({
          start(controller) {
            const emit = (candidate) => controller.enqueue(new TextEncoder().encode(`event: candidate\ndata: ${JSON.stringify(candidate)}\n\n`));
            emit({ id: "collaps", providerId: "habster:collaps", providerName: "Habster · Collaps", voiceName: "Мультиаудио", qualityHint: "Auto" });
            window.offer4K = () => {
              emit({ id: "vk", providerId: "vkmovie", providerName: "VKMovie", voiceName: "Дубляж", qualityHint: "2160p" });
              controller.enqueue(new TextEncoder().encode("event: done\ndata: {}\n\n"));
              controller.close();
            };
          },
        }), { headers: { "content-type": "text/event-stream" } }));
      }
      return originalFetch(input, init);
    };
  });
  const tmdb = (route) => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ id: 550, title: "Movie 550", original_title: "Movie 550", imdb_id: "tt0111161", runtime: 100, genres: [], credits: { cast: [] } }),
  });
  await page.route("**/api/tmdb/**", tmdb);
  await page.route("https://api.themoviedb.org/**", tmdb);
  const resolutions = [];
  await page.route("**/api/source-host?op=resolve", (route) => {
    const request = route.request().postDataJSON();
    resolutions.push(request);
    const is4K = request.id === "vk";
    const url = `https://media.example/${is4K ? "high" : "low"}-master.m3u8`;
    const selected = { label: is4K ? "2160p" : "auto", height: is4K ? 2160 : 0, url };
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ kind: "hls", selected, qualities: [selected] }) });
  });
  await page.route("**/*-master.m3u8", (route) => {
    const high = route.request().url().includes("high-master");
    const variants = high
      ? "#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=3832x1600\nfixture.m3u8\n"
      : "#EXT-X-STREAM-INF:BANDWIDTH=200000,RESOLUTION=1272x530\nfixture.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=100000,RESOLUTION=640x270\nfixture.m3u8\n";
    return route.fulfill({ status: 200, contentType: "application/vnd.apple.mpegurl", headers: { "access-control-allow-origin": "*" }, body: `#EXTM3U\n${variants}` });
  });
  await page.route("**/fixture.m3u8", (route) => route.fulfill({
    status: 200, contentType: "application/vnd.apple.mpegurl", headers: { "access-control-allow-origin": "*" },
    body: readFileSync(join(fixtureDir, "fixture.m3u8"), "utf8"),
  }));
  await page.route("**/fixture*.ts", (route) => route.fulfill({
    status: 200, contentType: "video/mp2t", headers: { "access-control-allow-origin": "*" },
    body: readFileSync(join(fixtureDir, new URL(route.request().url()).pathname.split("/").pop())),
  }));

  await page.goto("/movie/550", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Смотреть", exact: true }).click();
  const video = page.locator("video");
  await expect.poll(() => video.evaluate((v) => v.currentTime), { timeout: 20_000 }).toBeGreaterThan(0.5);
  await page.locator('[title="Качество (Q)"]').click();
  await expect(page.locator(".torrplayer-audio-menu").getByRole("button", { name: "530p", exact: true })).toBeVisible();
  await expect(page.locator(".torrplayer-audio-menu").getByRole("button", { name: /4K/ })).toHaveCount(0);
  await page.evaluate(() => window.offer4K());
  await expect(page.locator(".torrplayer-audio-menu").getByRole("button", { name: "VKMovie · 4K", exact: true })).toBeVisible();
  expect(resolutions).toHaveLength(1);
  await expect(page.locator('[title="Источник"]')).toContainText("Habster · Collaps");
  await page.locator('[title="Источник"]').click();
  await expect(page.locator(".torrplayer-audio-menu").getByRole("button", { name: "VKMovie · до 4K", exact: true })).toBeVisible();
  await page.locator('[title="Качество (Q)"]').click();
  await video.evaluate((v) => { v.currentTime = 45; v.pause(); });
  await page.locator(".torrplayer-audio-menu").getByRole("button", { name: "VKMovie · 4K", exact: true }).click();
  await expect.poll(() => resolutions.at(-1)?.quality).toBe("2160p");
  expect(resolutions.at(-1)?.id).toBe("vk");
  await expect.poll(() => video.evaluate((v) => v.readyState), { timeout: 20_000 }).toBeGreaterThanOrEqual(2);
  await expect.poll(() => video.evaluate((v) => v.currentTime), { timeout: 10_000 }).toBeGreaterThanOrEqual(44);
  await page.locator(".torrplayer").hover();
  await page.locator('[title="Качество (Q)"]').click();
  await expect(page.locator(".torrplayer-audio-menu").getByRole("button", { name: "4K ⭐", exact: true })).toHaveCount(2);
});

test("late HLS network failures fail over once and preserve the playback position", async ({ page }) => {
  test.setTimeout(180_000);
  await page.addInitScript(() => {
    localStorage.setItem("lampa_stream_tmdb_token", "e2e-fake-token");
    localStorage.setItem("streambert_playerSource", JSON.stringify("lampac"));
  });
  const tmdb = (route) => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ id: 550, title: "Movie 550", original_title: "Movie 550", imdb_id: "tt0111161", original_language: "en", runtime: 100, genres: [], credits: { cast: [] } }),
  });
  await page.route("**/api/tmdb/**", tmdb);
  await page.route("https://api.themoviedb.org/**", tmdb);
  await page.route(/\/api\/source-host\?op=discover(?:&|$)/, (route) => route.fulfill({
    status: 200, contentType: "text/event-stream",
    body: ["first", "second"].map((id) => `event: candidate\ndata: ${JSON.stringify({ id, providerId: "test-provider", providerName: id === "first" ? "First source" : "Second source", voiceName: "Russian dub" })}\n\n`).join("") + "event: done\ndata: {}\n\n",
  }));
  const resolves = [];
  await page.route(/\/api\/source-host\?op=resolve(?:&|$)/, (route) => {
    const { id } = route.request().postDataJSON();
    resolves.push(id);
    const url = `https://media.example/${id}/fixture.m3u8`;
    return route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({ kind: "hls", selected: { label: "720p", height: 720, url }, qualities: [{ label: "720p", height: 720, url }] }),
    });
  });

  let failCurrentSource = false;
  let currentSource = "first";
  let failedSegmentRequests = 0;
  await page.route("https://media.example/**", async (route) => {
    const url = new URL(route.request().url());
    currentSource = url.pathname.split("/")[1];
    if (url.pathname.endsWith(".m3u8")) {
      return route.fulfill({ status: 200, contentType: "application/vnd.apple.mpegurl", headers: { "access-control-allow-origin": "*" }, body: readFileSync(join(fixtureDir, "fixture.m3u8"), "utf8") });
    }
    const segmentIndex = Number(url.pathname.match(/fixture(\d+)\.ts$/)?.[1]);
    if (failCurrentSource && segmentIndex >= (currentSource === "first" ? 30 : 40)) {
      failedSegmentRequests += 1;
      return route.fulfill({ status: 503, contentType: "text/plain", headers: { "access-control-allow-origin": "*" }, body: "temporary segment failure" });
    }
    return route.fulfill({ status: 200, contentType: "video/mp2t", headers: { "access-control-allow-origin": "*" }, body: readFileSync(join(fixtureDir, `fixture${String(segmentIndex).padStart(3, "0")}.ts`)) });
  });

  await page.goto("/movie/550", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Смотреть", exact: true }).click();
  const video = page.locator("video");
  await expect(video).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => video.evaluate((v) => v.getVideoPlaybackQuality().totalVideoFrames), { timeout: 30_000 }).toBeGreaterThan(15);
  await expect.poll(() => video.evaluate((v) => v.currentTime), { timeout: 10_000 }).toBeGreaterThan(1);

  const framesBeforeHandoff = await video.evaluate((v) => v.getVideoPlaybackQuality().totalVideoFrames);
  failCurrentSource = true;
  await video.evaluate((v) => { v.currentTime = 60; });
  await expect.poll(() => failedSegmentRequests, { timeout: 20_000 }).toBeGreaterThan(0);
  await expect.poll(() => resolves.length, { timeout: 75_000 }).toBeGreaterThan(1);
  await expect.poll(() => video.evaluate((v) => v.currentTime), { timeout: 25_000 }).toBeGreaterThan(60.5);
  await expect.poll(() => video.evaluate((v) => v.getVideoPlaybackQuality().totalVideoFrames), { timeout: 15_000 }).toBeGreaterThan(framesBeforeHandoff + 2);
  await expect(page.getByRole("button", { name: "Second source" })).toBeVisible();
  expect(resolves).toEqual(["first", "second"]);

  // The second source proves the pool was used, then the same real segment
  // failure exhausts it. No third resolve/retry loop should follow.
  await video.evaluate((v) => { v.currentTime = 80; });
  await expect.poll(() => failedSegmentRequests, { timeout: 10_000 }).toBeGreaterThan(1);
  await expect(page.getByText(/Поток прерван/)).toBeVisible({ timeout: 75_000 });
  expect(resolves).toEqual(["first", "second"]);
});

test("automatic recovery keeps another voice after HTTP and decode failures in the same provider", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("lampa_stream_tmdb_token", "e2e-fake-token");
    localStorage.setItem("streambert_playerSource", JSON.stringify("lampac"));
    localStorage.setItem("streambert_skipHeuristicMode", JSON.stringify("auto"));
  });
  const tmdb = (route) => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ id: 550, title: "Movie 550", original_title: "Movie 550", imdb_id: "tt0111161", original_language: "en", runtime: 2, release_date: "1994-01-01", genres: [], credits: { cast: [] } }),
  });
  await page.route("**/api/tmdb/**", tmdb);
  await page.route("https://api.themoviedb.org/**", tmdb);
  await page.route("**/api/introdb?**", (route) => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ post_credits: { start_sec: 85, end_sec: 95, confidence: 1 } }),
  }));
  await page.route("**/fixture.m3u8", (route) => route.fulfill({
    status: 200, contentType: "application/vnd.apple.mpegurl", headers: { "access-control-allow-origin": "*" },
    body: readFileSync(join(fixtureDir, "fixture.m3u8"), "utf8"),
  }));
  await page.route("**/fixture*.ts", (route) => route.fulfill({
    status: 200, contentType: "video/mp2t", headers: { "access-control-allow-origin": "*" },
    body: readFileSync(join(fixtureDir, new URL(route.request().url()).pathname.split("/").pop())),
  }));
  await page.route("**/broken-fixture.m3u8", (route) => route.fulfill({
    status: 200, contentType: "application/vnd.apple.mpegurl", headers: { "access-control-allow-origin": "*" },
    body: "#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXTINF:10,\nbroken-fixture.ts\n#EXT-X-ENDLIST\n",
  }));
  await page.route("**/broken-fixture.ts", (route) => route.fulfill({
    status: 200, contentType: "video/mp2t", headers: { "access-control-allow-origin": "*" }, body: Buffer.alloc(2048, 0),
  }));
  const ids = ["http-bad", "decode-bad", "good"];
  await page.route(/\/api\/source-host\?op=discover(?:&|$)/, (route) => route.fulfill({
    status: 200, contentType: "text/event-stream",
    body: ids.map((id) => `event: candidate\ndata: ${JSON.stringify({ id, providerId: "same-provider", providerName: "Test source", voiceName: id })}\n\n`).join("") + "event: done\ndata: {}\n\n",
  }));
  const calls = [];
  await page.route(/\/api\/source-host\?op=resolve(?:&|$)/, (route) => {
    const { id } = route.request().postDataJSON();
    calls.push(id);
    if (id === "http-bad") return route.fulfill({ status: 503, contentType: "application/json", body: '{"error":"MEDIA_UNAVAILABLE"}' });
    const url = `https://media.example/${id === "good" ? "fixture" : "broken-fixture"}.m3u8`;
    return route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({ kind: "hls", selected: { label: "720p", height: 720, url }, qualities: [{ label: "720p", height: 720, url }], skip: [{ start: 70, end: 100 }] }),
    });
  });
  await page.goto("/movie/550", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Смотреть", exact: true }).click();
  const video = page.locator("video");
  await expect(video).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => video.evaluate((v) => v.getVideoPlaybackQuality().totalVideoFrames), { timeout: 30_000 }).toBeGreaterThan(2);
  expect(calls).toEqual(ids);
  await expect(page.locator('[title="Озвучка"]')).toContainText("good");
  await video.evaluate((v) => { v.currentTime = 60; });
  await expect.poll(() => video.evaluate((v) => v.currentTime), { timeout: 10_000 }).toBeGreaterThan(60.5);
  await video.evaluate((v) => { v.currentTime = 71; });
  const skip = page.locator(".torrplayer-skip");
  await expect(skip).toContainText("ФРАГМЕНТ", { timeout: 5_000 });
  expect(await video.evaluate((v) => v.currentTime)).toBeLessThan(80);
  await skip.click();
  await expect.poll(() => video.evaluate((v) => v.currentTime), { timeout: 5_000 }).toBeGreaterThanOrEqual(85);
  expect(await video.evaluate((v) => v.currentTime)).toBeLessThan(95);
});

test("manual source resolution preserves a near-end resume position after the seek watchdog", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("lampa_stream_tmdb_token", "e2e-fake-token");
    localStorage.setItem("streambert_playerSource", JSON.stringify("lampac"));
  });
  const tmdb = async (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = path.includes("external_ids")
      ? { imdb_id: "tt0111161" }
      : { id: 550, title: "Movie 550", original_title: "Movie 550", imdb_id: "tt0111161", original_language: "en", runtime: 100, release_date: "1994-01-01", genres: [], credits: { cast: [] } };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(json) });
  };
  await page.route("**/api/tmdb/**", tmdb);
  await page.route("https://api.themoviedb.org/**", tmdb);
  let manifestRequests = 0;
  await page.route("**/*resume-fixture*.m3u8", async (route) => {
    manifestRequests++;
    await route.fulfill({
      status: 200,
      contentType: "application/vnd.apple.mpegurl",
      headers: { "access-control-allow-origin": "*" },
      body: readFileSync(join(fixtureDir, "fixture.m3u8"), "utf8"),
    });
  });
  await page.route("**/fixture*.ts", (route) => route.fulfill({
    status: 200,
    contentType: "video/mp2t",
    headers: { "access-control-allow-origin": "*" },
    body: readFileSync(join(fixtureDir, new URL(route.request().url()).pathname.split("/").pop())),
  }));

  let startSlowResolve;
  const slowResolveStarted = new Promise((resolve) => { startSlowResolve = resolve; });
  let finishSlowResolve;
  const slowResolveGate = new Promise((resolve) => { finishSlowResolve = resolve; });
  await page.route(/\/api\/source-host\?op=discover(?:&|$)/, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: [
        `event: candidate\ndata: ${JSON.stringify({ id: "fast", providerId: "fast", providerName: "Ready source", voiceName: "Dub" })}\n\n`,
        `event: candidate\ndata: ${JSON.stringify({ id: "slow", providerId: "slow", providerName: "Slow source", voiceName: "Dub" })}\n\n`,
        "event: done\ndata: {\"candidates\":2,\"complete\":true}\n\n",
      ].join(""),
    });
  });
  await page.route(/\/api\/source-host\?op=resolve(?:&|$)/, async (route) => {
    const { id } = route.request().postDataJSON();
    if (id === "slow") {
      startSlowResolve();
      await slowResolveGate;
    }
    const source = id === "slow" ? "slow-resume-fixture" : "fast-resume-fixture";
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        kind: "hls",
        selected: { label: "720p", height: 720, url: `https://media.example/${source}.m3u8` },
        qualities: [{ label: "720p", height: 720, url: `https://media.example/${source}.m3u8` }],
      }),
    });
  });

  await page.goto("/movie/550", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Смотреть", exact: true }).click();
  const video = page.locator("video");
  await expect(video).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => manifestRequests, { timeout: 15_000 }).toBeGreaterThan(0);
  await expect.poll(() => video.evaluate((v) => v.readyState), { timeout: 20_000 }).toBeGreaterThanOrEqual(2);
  await expect.poll(() => video.evaluate((v) => v.currentTime), { timeout: 10_000 }).toBeGreaterThan(0.5);
  await video.evaluate((v) => { v.currentTime = 96; v.pause(); });
  await expect.poll(() => video.evaluate((v) => v.currentTime), { timeout: 5_000 }).toBeGreaterThanOrEqual(95);

  // Advance the browser timers beyond the 14 s seek watchdog while the
  // provider resolve remains pending. This reproduces the cold-start race
  // without adding 14 seconds of wall-clock time to the suite.
  await page.clock.install();
  await page.getByRole("button", { name: "Ready source" }).click();
  await page.getByRole("button", { name: "Slow source", exact: true }).click();
  await slowResolveStarted;
  await page.clock.fastForward(15_000);
  finishSlowResolve();

  await expect.poll(() => manifestRequests, { timeout: 20_000 }).toBeGreaterThan(1);
  await expect.poll(() => video.evaluate((v) => v.readyState), { timeout: 20_000 }).toBeGreaterThanOrEqual(2);
  await expect.poll(() => video.evaluate((v) => v.currentTime), { timeout: 10_000 }).toBeGreaterThanOrEqual(95);
});

test("a timeline seek made during source resolution overrides the captured resume position", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("lampa_stream_tmdb_token", "e2e-fake-token");
    localStorage.setItem("streambert_playerSource", JSON.stringify("lampac"));
  });
  const tmdb = (route) => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ id: 550, title: "Movie 550", original_title: "Movie 550", imdb_id: "tt0111161", original_language: "en", runtime: 100, genres: [], credits: [] }),
  });
  await page.route("**/api/tmdb/**", tmdb);
  await page.route("https://api.themoviedb.org/**", tmdb);
  let manifestRequests = 0;
  await page.route("**/*seek-fixture*.m3u8", async (route) => {
    manifestRequests++;
    await route.fulfill({
      status: 200, contentType: "application/vnd.apple.mpegurl",
      headers: { "access-control-allow-origin": "*" },
      body: readFileSync(join(fixtureDir, "fixture.m3u8"), "utf8"),
    });
  });
  await page.route("**/fixture*.ts", (route) => route.fulfill({
    status: 200, contentType: "video/mp2t",
    headers: { "access-control-allow-origin": "*" },
    body: readFileSync(join(fixtureDir, new URL(route.request().url()).pathname.split("/").pop())),
  }));

  let startResolve;
  const resolveStarted = new Promise((resolve) => { startResolve = resolve; });
  let finishResolve;
  const resolveGate = new Promise((resolve) => { finishResolve = resolve; });
  await page.route(/\/api\/source-host\?op=discover(?:&|$)/, (route) => route.fulfill({
    status: 200, contentType: "text/event-stream",
    body: ["ready", "pending"].map((id) => `event: candidate\ndata: ${JSON.stringify({ id, providerId: id, providerName: id === "ready" ? "Ready source" : "Pending source", voiceName: "Dub" })}\n\n`).join("") + "event: done\ndata: {}\n\n",
  }));
  await page.route(/\/api\/source-host\?op=resolve(?:&|$)/, async (route) => {
    const { id } = route.request().postDataJSON();
    if (id === "pending") { startResolve(); await resolveGate; }
    const source = id === "pending" ? "pending-seek-fixture" : "ready-seek-fixture";
    await route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({ kind: "hls", selected: { label: "720p", height: 720, url: `https://media.example/${source}.m3u8` }, qualities: [{ label: "720p", height: 720, url: `https://media.example/${source}.m3u8` }] }),
    });
  });

  await page.goto("/movie/550", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Смотреть", exact: true }).click();
  const video = page.locator("video");
  await expect(video).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => manifestRequests, { timeout: 15_000 }).toBeGreaterThan(0);
  await expect.poll(() => video.evaluate((v) => v.readyState), { timeout: 20_000 }).toBeGreaterThanOrEqual(2);
  await expect.poll(() => video.evaluate((v) => v.currentTime), { timeout: 10_000 }).toBeGreaterThan(0.5);
  await video.evaluate((v) => { v.currentTime = 70; v.pause(); });
  await expect.poll(() => video.evaluate((v) => v.currentTime), { timeout: 5_000 }).toBeGreaterThanOrEqual(69);

  await page.getByRole("button", { name: "Ready source" }).click();
  await page.getByRole("button", { name: "Pending source" }).click();
  await resolveStarted;
  const seekBar = page.locator(".torrplayer-seek");
  const seekBox = await seekBar.boundingBox();
  await seekBar.click({ position: { x: seekBox.width * 0.4, y: seekBox.height / 2 } });
  await expect.poll(() => video.evaluate((v) => v.currentTime), { timeout: 5_000 }).toBeGreaterThanOrEqual(39);
  finishResolve();

  await expect.poll(() => manifestRequests, { timeout: 20_000 }).toBeGreaterThan(1);
  await expect.poll(() => video.evaluate((v) => v.readyState), { timeout: 20_000 }).toBeGreaterThanOrEqual(2);
  await expect.poll(() => video.evaluate((v) => v.currentTime), { timeout: 10_000 }).toBeGreaterThanOrEqual(39);
  await expect.poll(() => video.evaluate((v) => v.currentTime), { timeout: 2_000 }).toBeLessThan(50);
});

test("Haikyuu season 3 uses mapped AniSkip episode and skips its opening", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("lampa_stream_tmdb_token", "e2e-fake-token");
    localStorage.setItem("streambert_introSkipMode", JSON.stringify("manual"));
    localStorage.setItem("streambert_playerSource", JSON.stringify("lampac"));
  });
  await page.route("**/api/tmdb/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    let json;
    if (path.endsWith("/external_ids")) json = { imdb_id: "tt3398540" };
    else if (path.endsWith("/season/3")) json = {
      season_number: 3,
      episodes: [{
        id: 3001,
        episode_number: 1,
        name: "Greetings",
        overview: "Episode overview",
        air_date: "2016-10-08",
        runtime: 24,
      }],
    };
    else json = {
      id: 60863,
      name: "ハイキュー!!",
      original_name: "ハイキュー!!",
      original_language: "ja",
      genre_ids: [16],
      genres: [{ id: 16, name: "Animation" }],
      seasons: [1, 2, 3].map((season_number) => ({
        season_number,
        episode_count: season_number === 3 ? 1 : 12,
        name: `Season ${season_number}`,
      })),
      number_of_seasons: 3,
      vote_average: 8.5,
      first_air_date: "2014-04-06",
      overview: "Volleyball anime",
    };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(json) });
  });
  await page.route("https://api.themoviedb.org/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const json = path.endsWith("/external_ids")
      ? { imdb_id: "tt3398540" }
      : { id: 60863, name: "ハイキュー!!", original_name: "ハイキュー!!", original_language: "ja", genre_ids: [16], genres: [{ id: 16, name: "Animation" }] };
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(json) });
  });
  await page.route("https://graphql.anilist.co", (route) => route.fulfill({ status: 503, body: "AniList is deliberately unavailable" }));
  await page.route("https://api.aniskip.com/v2/skip-times/**", async (route) => {
    const url = new URL(route.request().url());
    expect(url.pathname).toBe("/v2/skip-times/32935/1");
    expect(url.searchParams.get("episodeLength")).toBe("1468");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ found: true, results: [{
        skipType: "op",
        interval: { startTime: 91.483, endTime: 181.483 },
      }] }),
    });
  });
  await page.route("**/api/introdb?**", (route) => route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({}),
  }));
  await page.route("**/anime-fixture*.ts", (route) => route.fulfill({
    status: 200,
    contentType: "video/mp2t",
    body: readFileSync(join(animeFixtureDir, new URL(route.request().url()).pathname.split("/").pop())),
  }));
  const resolved = [];
  await page.route(/\/api\/source-host\?op=discover(?:&|$)/, async (route) => {
    const title = route.request().postDataJSON();
    expect(title).toMatchObject({ type: "tv", tmdbId: 60863, season: 3, episode: 1, anime: true });
    await route.fulfill({
      status: 200,
      contentType: "text/event-stream",
      body: [
        { id: "anime-original", voiceName: "Original" },
        { id: "anime-dub", voiceName: "Русская озвучка" },
      ].map(({ id, voiceName }) => `event: candidate\ndata: ${JSON.stringify({ id, providerId: "anime-source", providerName: "Anime source", voiceName })}\n\n`).join("")
        + "event: done\ndata: {\"candidates\":2,\"complete\":true}\n\n",
    });
  });
  await page.route(/\/api\/source-host\?op=resolve(?:&|$)/, async (route) => {
    const request = route.request().postDataJSON();
    resolved.push(request);
    const label = request.quality || "720p";
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        kind: "hls",
        selected: { label, height: label === "1080p" ? 1080 : 720, url: `https://media.example/anime-fixture.m3u8?quality=${label}` },
        qualities: [
          { label: "720p", height: 720, url: "https://media.example/anime-fixture.m3u8?quality=720p" },
          { label: "1080p", height: 1080, url: "https://media.example/anime-fixture.m3u8?quality=1080p" },
        ],
      }),
    });
  });
  await page.route("**/anime-fixture.m3u8*", (route) => route.fulfill({
    status: 200,
    contentType: "application/vnd.apple.mpegurl",
    headers: { "access-control-allow-origin": "*" },
    body: readFileSync(join(animeFixtureDir, "anime-fixture.m3u8"), "utf8"),
  }));

  await page.goto("/tv/60863?season=3&episode=1", { waitUntil: "domcontentloaded" });
  await expect(page.locator(".detail-title")).toContainText("ハイキュー!!");
  await expect(page.locator(".episode-card")).toHaveCount(1);
  await page.locator(".episode-card").first().click();
  const video = page.locator("video");
  await expect(video).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => video.evaluate((v) => v.readyState), { timeout: 20_000 }).toBeGreaterThanOrEqual(2);
  await expect.poll(() => video.evaluate((v) => Math.round(v.duration)), { timeout: 20_000 }).toBe(1468);
  await expect.poll(() => video.evaluate((v) => v.currentTime), { timeout: 10_000 }).toBeGreaterThan(0.5);

  await video.evaluate((v) => { v.currentTime = 92; });
  const skipButton = page.locator(".torrplayer-skip");
  await expect(skipButton).toContainText("ОПЕНИНГ", { timeout: 10_000 });
  await skipButton.click();
  await expect.poll(() => video.evaluate((v) => v.currentTime), { timeout: 5_000 }).toBeGreaterThanOrEqual(181.483);

  await video.evaluate((v) => { v.currentTime = 220; });
  await expect.poll(() => video.evaluate((v) => v.currentTime), { timeout: 10_000 }).toBeGreaterThanOrEqual(219);
  await page.locator('[title="Озвучка"]').click();
  await page.locator(".torrplayer-audio-menu").getByRole("button", { name: "Русская озвучка", exact: true }).click();
  await expect.poll(() => resolved.at(-1)?.id, { timeout: 5_000 }).toBe("anime-dub");
  await expect.poll(() => video.evaluate((v) => v.currentTime), { timeout: 15_000 }).toBeGreaterThan(210);
  await page.locator('[title="Качество (Q)"]').click();
  await page.locator(".torrplayer-audio-menu").getByRole("button", { name: "1080p", exact: true }).click();
  await expect.poll(() => resolved.at(-1)?.quality, { timeout: 5_000 }).toBe("1080p");
  await expect.poll(() => video.evaluate((v) => v.currentTime), { timeout: 15_000 }).toBeGreaterThan(210);
});

for (const { kind, recovers } of [{ kind: "file", recovers: true }, { kind: "file", recovers: false }, { kind: "hls", recovers: false }]) test(`source startup watchdog ${kind}: ${recovers ? "keeps delayed healthy playback" : "expires for a stalled stream"}`, async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("lampa_stream_tmdb_token", "e2e-fake-token");
    localStorage.setItem("streambert_playerSource", JSON.stringify("lampac"));
  });
  const tmdb = (route) => route.fulfill({
    status: 200, contentType: "application/json",
    body: JSON.stringify({ id: 550, title: "Movie 550", original_title: "Movie 550", imdb_id: "tt0111161", kinopoisk_id: 361, runtime: 100, genres: [], credits: { cast: [] } }),
  });
  await page.route("**/api/tmdb/**", tmdb);
  await page.route("https://api.themoviedb.org/**", tmdb);
  await page.route(/\/api\/source-host\?op=discover(?:&|$)/, (route) => route.fulfill({
    status: 200, contentType: "text/event-stream",
    body: ["delayed", "fallback"].map((id) => `event: candidate\ndata: ${JSON.stringify({ id, providerId: id, providerName: id, voiceName: "Dub" })}\n\n`).join("") + "event: done\ndata: {}\n\n",
  }));
  const resolutions = [];
  await page.route(/\/api\/source-host\?op=resolve(?:&|$)/, (route) => {
    const { id } = route.request().postDataJSON();
    resolutions.push(id);
    const quality = { label: "720p", height: 720, url: `https://media.example/${id}.mp4` };
    return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ kind, selected: quality, qualities: [quality] }) });
  });
  let releaseMedia;
  const mediaGate = new Promise((resolve) => { releaseMedia = resolve; });
  let mediaRequested;
  const requested = new Promise((resolve) => { mediaRequested = resolve; });
  const mp4 = join(fixtureDir, `metadata-grace-${kind}-${recovers}.mp4`);
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", join(fixtureDir, "fixture.m3u8"), "-c", "copy", "-movflags", "+faststart", mp4]);
  await page.route("**/delayed.mp4", async (route) => {
    mediaRequested();
    await mediaGate;
    await route.fulfill({ status: 200, contentType: "video/mp4", body: readFileSync(mp4) }).catch(() => {});
  });
  await page.route("**/fallback.mp4", (route) => route.fulfill({ status: 200, contentType: "video/mp4", body: readFileSync(mp4) }));
  await page.clock.install();
  await page.goto("/movie/550", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: "Смотреть", exact: true }).click();
  const video = page.locator("video");
  await expect(video).toBeVisible();
  await requested;
  try {
    if (kind === "hls") {
      await page.clock.fastForward(8000);
      await expect.poll(() => resolutions).toEqual(["delayed", "fallback"]);
      return;
    }
    await page.clock.fastForward(9000);
    expect(resolutions).toEqual(["delayed"]);
    if (recovers) {
      releaseMedia();
      await expect.poll(() => video.evaluate((v) => v.getVideoPlaybackQuality().totalVideoFrames)).toBeGreaterThan(3);
      await expect.poll(() => video.evaluate((v) => v.currentTime)).toBeGreaterThan(0.5);
      await page.clock.fastForward(15000);
      expect(resolutions).toEqual(["delayed"]);
    } else {
      await page.clock.fastForward(6000);
      await expect.poll(() => resolutions).toEqual(["delayed", "fallback"]);
    }
  } finally { releaseMedia(); }
});
