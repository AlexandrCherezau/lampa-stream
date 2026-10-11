import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "@playwright/test";

let fixtureDir;
let animeFixtureDir;

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
});

test.afterAll(() => {
  if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true });
  if (animeFixtureDir) rmSync(animeFixtureDir, { recursive: true, force: true });
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
