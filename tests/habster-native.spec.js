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

async function openDelayedDiscovery(page, { candidate, failure }) {
  await page.addInitScript(async ({ candidate, failure }) => {
    localStorage.setItem("lampa_stream_tmdb_token", "delayed-discovery-fixture");
    localStorage.removeItem("streambert_resumeTime");
    localStorage.removeItem("streambert_progress");
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      if (!String(input).includes("/api/source-host?op=discover")) return originalFetch(input, init);
      await new Promise((resolve) => setTimeout(resolve, 4800));
      if (failure) return new Response(JSON.stringify({ message: failure }), {
        status: 503, headers: { "content-type": "application/json" },
      });
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode(`event: candidate\ndata: ${JSON.stringify(candidate)}\n\n`));
        controller.close();
      } }), { headers: { "content-type": "text/event-stream" } });
    };
  }, { candidate, failure });
  await page.route("**/api/tmdb/**", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({
    id: 969681, title: "Человек-паук: Новый день", original_title: "Spider-Man: Brand New Day", release_date: "2026-07-31",
    runtime: 145, imdb_id: "tt22084616", kinopoisk_id: 5494049, genres: [], credits: { cast: [] }, results: [], images: {},
  }) }));
  await page.route("**/api/source-host?op=resolve", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({
    kind: "hls", selected: { label: "720p", height: 720, url: "https://delayed-media.example/master.m3u8" },
    qualities: [{ label: "720p", height: 720, url: "https://delayed-media.example/master.m3u8" }], subtitles: [], audioNames: [],
  }) }));
  await page.route("https://delayed-media.example/**", (route) => {
    const filename = new URL(route.request().url()).pathname.split("/").pop();
    if (filename === "master.m3u8") return route.fulfill({
      contentType: "application/vnd.apple.mpegurl", headers: { "access-control-allow-origin": "*" },
      body: "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=300000,RESOLUTION=160x90\nfixture.m3u8\n",
    });
    return route.fulfill({
      contentType: filename.endsWith(".m3u8") ? "application/vnd.apple.mpegurl" : "video/mp2t",
      headers: { "access-control-allow-origin": "*" },
      body: readFileSync(join(fixtureDir, filename.endsWith(".m3u8") ? "fixture.m3u8" : filename)),
    });
  });
  await page.goto("/movie/969681");
  await page.getByRole("button", { name: "Смотреть", exact: true }).click();
}

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

test("Lampac discovery stays loading past four seconds and attaches the native stream when a source arrives", async ({ page }) => {
  const candidate = { id: "delayed-source", providerId: "habster:alloha", providerName: "Habster · Alloha", voiceName: "Fixture", qualityHint: "720p" };
  const mediaRequests = [];
  page.on("request", (request) => { if (request.url().startsWith("https://delayed-media.example/")) mediaRequests.push(request.url()); });
  await openDelayedDiscovery(page, { candidate });
  await page.waitForTimeout(4200);
  await expect(page.locator(".torrpicker-error")).toHaveCount(0);
  await expect(page.getByText("Опрашиваем балансеры и ищем фильм…")).toBeVisible();
  const video = page.locator(".torrplayer > video");
  await expect.poll(() => video.evaluate((element) => element.currentSrc.startsWith("blob:") && element.readyState >= 1)).toBe(true);
  await expect.poll(() => mediaRequests.some((url) => url.endsWith("fixture000.ts"))).toBe(true);
});

test("Lampac discovery shows its actual terminal error after a slow server failure", async ({ page }) => {
  await openDelayedDiscovery(page, { failure: "Флот сейчас недоступен" });
  await page.waitForTimeout(4200);
  await expect(page.locator(".torrpicker-error")).toHaveCount(0);
  await expect(page.getByText("Опрашиваем балансеры и ищем фильм…")).toBeVisible();
  await expect(page.locator(".torrpicker-error")).toHaveText("Флот сейчас недоступен", { timeout: 5000 });
});

test("multilevel Habster HLS decodes its first fragment while the next fragment is stalled", async ({ page }) => {
  const candidates = [
    { id: "alloha-dub", providerId: "habster:alloha", providerName: "Habster · Alloha", voiceName: "Red Head Sound", qualityHint: "720p" },
  ];
  await page.addInitScript((candidates) => {
    localStorage.setItem("lampa_stream_tmdb_token", "native-hls-startup-fixture");
    localStorage.removeItem("streambert_resumeTime");
    localStorage.removeItem("streambert_progress");
    const originalFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      if (String(input).includes("/api/source-host?op=discover")) {
        return Promise.resolve(new Response(new ReadableStream({ start(controller) {
          controller.enqueue(new TextEncoder().encode(`event: candidate\ndata: ${JSON.stringify(candidates[0])}\n\n`));
          controller.close();
        } }), { headers: { "content-type": "text/event-stream" } }));
      }
      return originalFetch(input, init);
    };
  }, candidates);
  await page.route("**/api/tmdb/**", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({
    id: 969681, title: "Человек-паук: Новый день", original_title: "Spider-Man: Brand New Day", release_date: "2026-07-31",
    runtime: 145, imdb_id: "tt22084616", kinopoisk_id: 5494049, genres: [], credits: { cast: [] }, results: [], images: {},
  }) }));
  await page.route("**/api/source-host?op=resolve", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({
    kind: "hls", selected: { label: "720p", height: 720, url: "https://startup-media.example/720p/master.m3u8" },
    qualities: [{ label: "720p", height: 720, url: "https://startup-media.example/720p/master.m3u8" }],
    subtitles: ["English", "Русский", "Deutsch", "Русский"].map((label, index) => ({ label, language: "en", url: `/api/source-host?op=media&token=subtitle-${index}-${encodeURIComponent(label)}` })), audioNames: [],
  }) }));
  const fragmentRequests = [];
  const subtitleRequests = [];
  let secondFragmentRequested = false;
  let releaseSecondFragment;
  const secondFragmentGate = new Promise((resolve) => { releaseSecondFragment = resolve; });
  await page.route("https://startup-media.example/**", (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith("master.m3u8")) return route.fulfill({
      contentType: "application/vnd.apple.mpegurl", headers: { "access-control-allow-origin": "*" },
      body: "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=150000,RESOLUTION=160x90\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=450000,RESOLUTION=320x180\nmid.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=1200000,RESOLUTION=640x360\nhigh.m3u8\n",
    });
    if (pathname.endsWith(".m3u8")) return route.fulfill({
      contentType: "application/vnd.apple.mpegurl", headers: { "access-control-allow-origin": "*" },
      body: readFileSync(join(fixtureDir, "fixture.m3u8")),
    });
    fragmentRequests.push(pathname);
    if (pathname.endsWith("fixture001.ts")) {
      secondFragmentRequested = true;
      return secondFragmentGate.then(() => route.fulfill({ contentType: "video/mp2t", headers: { "access-control-allow-origin": "*" },
        body: readFileSync(join(fixtureDir, "fixture001.ts")) }));
    }
    return route.fulfill({ contentType: "video/mp2t", headers: { "access-control-allow-origin": "*" },
      body: readFileSync(join(fixtureDir, pathname.split("/").pop())) });
  });
  await page.route(/\/api\/source-host\?op=media&token=subtitle-/, (route) => {
    const token = new URL(route.request().url()).searchParams.get("token");
    subtitleRequests.push(token);
    return route.fulfill({ contentType: "text/vtt", body: "WEBVTT\n\n00:00:00.000 --> 00:00:05.000\nFixture subtitle\n" });
  });

  await page.goto("/movie/969681");
  await page.getByRole("button", { name: "Смотреть", exact: true }).click();
  const video = page.locator(".torrplayer > video");
  await expect(video).toBeVisible();
  try {
    await expect.poll(() => secondFragmentRequested).toBe(true);
    await expect.poll(() => video.evaluate((value) => value.getVideoPlaybackQuality().totalVideoFrames), { timeout: 2500 }).toBeGreaterThan(0);
    expect(fragmentRequests.filter((path) => path.endsWith("fixture000.ts"))).toHaveLength(1);
    expect(subtitleRequests).toEqual([]);

    await page.locator(".torrplayer").hover();
    await page.getByTitle("Субтитры (C)").click();
    await page.locator(".torrplayer-audio-menu").getByRole("button", { name: "Русский", exact: true }).nth(1).click();
    await expect.poll(() => subtitleRequests).toEqual(["subtitle-3-Русский"]);
    await expect.poll(() => video.evaluate((value) => {
      const tracks = Array.from(value.querySelectorAll("track[data-cc]"));
      return tracks[1].track.mode === "disabled" && tracks[3].track.mode === "showing" && tracks[3].track.cues?.length > 0;
    })).toBe(true);

    await page.locator(".torrplayer").hover();
    await page.getByTitle("Субтитры (C)").click();
    await page.locator(".torrplayer-audio-menu").getByRole("button", { name: "Выключить", exact: true }).click();
    expect(await video.evaluate((value) => Array.from(value.querySelectorAll("track[data-cc]"))[3].track.mode)).toBe("disabled");
    await page.waitForTimeout(250);
    expect(subtitleRequests).toEqual(["subtitle-3-Русский"]);
  } finally {
    releaseSecondFragment();
  }
});

test("initial Lampac HLS limits 502 retries before failing over to a playable source", async ({ page }) => {
  test.setTimeout(30_000);
  const candidates = [
    { id: "alloha-bad-cdn", providerId: "habster:alloha", providerName: "Habster · Alloha", voiceName: "Broken CDN", qualityHint: "720p" },
    { id: "alloha-good-cdn", providerId: "habster:alloha", providerName: "Habster · Alloha", voiceName: "Healthy CDN", qualityHint: "720p" },
  ];
  await page.addInitScript((candidates) => {
    localStorage.setItem("lampa_stream_tmdb_token", "startup-retry-fixture");
    localStorage.removeItem("streambert_resumeTime");
    localStorage.removeItem("streambert_progress");
    const originalFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      if (String(input).includes("/api/source-host?op=discover")) {
        return Promise.resolve(new Response(new ReadableStream({ start(controller) {
          for (const candidate of candidates) controller.enqueue(new TextEncoder().encode(`event: candidate\ndata: ${JSON.stringify(candidate)}\n\n`));
          controller.close();
        } }), { headers: { "content-type": "text/event-stream" } }));
      }
      return originalFetch(input, init);
    };
  }, candidates);
  await page.route("**/api/tmdb/**", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({
    id: 969681, title: "Человек-паук: Новый день", original_title: "Spider-Man: Brand New Day", release_date: "2026-07-31",
    runtime: 145, imdb_id: "tt22084616", kinopoisk_id: 5494049, genres: [], credits: { cast: [] }, results: [], images: {},
  }) }));
  const resolvedIds = [];
  await page.route("**/api/source-host?op=resolve", (route) => {
    const request = route.request().postDataJSON();
    resolvedIds.push(request.id);
    const selected = { label: "720p", height: 720, url: `https://retry-media.example/${request.id}/master.m3u8` };
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({
      kind: "hls", selected, qualities: [selected], subtitles: [], audioNames: [],
    }) });
  });
  let failedSegmentRequests = 0;
  let healthySegmentRequests = 0;
  await page.route("https://retry-media.example/**", (route) => {
    const url = new URL(route.request().url());
    const pathname = url.pathname;
    if (pathname.endsWith("master.m3u8")) return route.fulfill({
      contentType: "application/vnd.apple.mpegurl", headers: { "access-control-allow-origin": "*" },
      body: "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=300000,RESOLUTION=160x90\nfixture.m3u8\n",
    });
    if (pathname.endsWith("fixture.m3u8")) return route.fulfill({
      contentType: "application/vnd.apple.mpegurl", headers: { "access-control-allow-origin": "*" },
      body: readFileSync(join(fixtureDir, "fixture.m3u8")),
    });
    if (pathname.includes("alloha-bad-cdn")) {
      failedSegmentRequests += 1;
      return route.fulfill({ status: 502, contentType: "text/plain", body: "fixture upstream failure" });
    }
    healthySegmentRequests += 1;
    return route.fulfill({ contentType: "video/mp2t", headers: { "access-control-allow-origin": "*" },
      body: readFileSync(join(fixtureDir, pathname.split("/").pop())) });
  });

  await page.goto("/movie/969681");
  const startedAt = Date.now();
  await page.getByRole("button", { name: "Смотреть", exact: true }).click();
  const video = page.locator(".torrplayer > video");
  await expect(video).toBeVisible();
  await expect.poll(() => video.evaluate((value) => value.getVideoPlaybackQuality().totalVideoFrames), { timeout: 7000 }).toBeGreaterThan(0);
  const startupMs = Date.now() - startedAt;
  expect(resolvedIds[0]).toBe("alloha-bad-cdn");
  expect(resolvedIds).toContain("alloha-good-cdn");
  expect(failedSegmentRequests).toBeGreaterThanOrEqual(1);
  expect(failedSegmentRequests).toBeLessThanOrEqual(2);
  expect(healthySegmentRequests).toBeGreaterThan(0);
  expect(startupMs).toBeLessThan(6000);
});

test("a confirmed Lampac session keeps the normal HLS retry budget on quality reattach", async ({ page }) => {
  const candidate = { id: "alloha-late-retry", providerId: "habster:alloha", providerName: "Habster · Alloha", voiceName: "Fixture", qualityHint: "720p" };
  await page.addInitScript((candidate) => {
    localStorage.setItem("lampa_stream_tmdb_token", "late-retry-fixture");
    localStorage.removeItem("streambert_resumeTime");
    localStorage.removeItem("streambert_progress");
    const originalFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      if (String(input).includes("/api/source-host?op=discover")) {
        return Promise.resolve(new Response(new ReadableStream({ start(controller) {
          controller.enqueue(new TextEncoder().encode(`event: candidate\ndata: ${JSON.stringify(candidate)}\n\n`));
          controller.close();
        } }), { headers: { "content-type": "text/event-stream" } }));
      }
      return originalFetch(input, init);
    };
  }, candidate);
  await page.route("**/api/tmdb/**", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({
    id: 969681, title: "Человек-паук: Новый день", original_title: "Spider-Man: Brand New Day", release_date: "2026-07-31",
    runtime: 145, imdb_id: "tt22084616", kinopoisk_id: 5494049, genres: [], credits: { cast: [] }, results: [], images: {},
  }) }));
  const resolvedQualities = [];
  await page.route("**/api/source-host?op=resolve", (route) => {
    const request = route.request().postDataJSON();
    resolvedQualities.push(request.quality || "720p");
    const qualities = ["720p", "1080p"].map((label) => ({ label, height: Number(label.slice(0, -1)),
      url: `https://late-retry.example/${label}/master.m3u8` }));
    const selected = qualities.find((quality) => quality.label === request.quality) || qualities[0];
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ kind: "hls", selected, qualities, subtitles: [], audioNames: [] }) });
  });
  let quality502s = 0;
  let qualityHealthySegments = 0;
  await page.route("https://late-retry.example/**", (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith("master.m3u8")) return route.fulfill({
      contentType: "application/vnd.apple.mpegurl", headers: { "access-control-allow-origin": "*" },
      body: "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=300000,RESOLUTION=160x90\nfixture.m3u8\n",
    });
    if (pathname.endsWith("fixture.m3u8")) return route.fulfill({
      contentType: "application/vnd.apple.mpegurl", headers: { "access-control-allow-origin": "*" },
      body: readFileSync(join(fixtureDir, "fixture.m3u8")),
    });
    if (pathname.includes("1080p") && pathname.endsWith(".ts") && quality502s < 2) {
      quality502s += 1;
      return route.fulfill({ status: 502, contentType: "text/plain", body: "transient quality-switch CDN error" });
    }
    if (pathname.includes("1080p") && pathname.endsWith(".ts")) qualityHealthySegments += 1;
    return route.fulfill({ contentType: "video/mp2t", headers: { "access-control-allow-origin": "*" },
      body: readFileSync(join(fixtureDir, pathname.split("/").pop())) });
  });

  await page.goto("/movie/969681");
  await page.getByRole("button", { name: "Смотреть", exact: true }).click();
  const video = page.locator(".torrplayer > video");
  await expect.poll(() => video.evaluate((value) => value.currentTime)).toBeGreaterThan(0.5);
  // Let the normal time-advance latch confirm real playback before reattaching.
  await page.waitForTimeout(400);
  await page.locator(".torrplayer").hover();
  await page.getByTitle("Качество (Q)").click();
  await page.locator(".torrplayer-audio-menu").getByRole("button", { name: "1080p", exact: true }).click();
  await expect.poll(() => qualityHealthySegments).toBeGreaterThan(0);
  await expect.poll(() => video.evaluate((value) => value.getVideoPlaybackQuality().totalVideoFrames)).toBeGreaterThan(0);
  expect(resolvedQualities.at(-1)).toBe("1080p");
  expect(quality502s).toBe(2);
});
