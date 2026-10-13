import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "@playwright/test";

const enabled = process.env.PLAYER_PROFILE_LIVE === "1";
const baseURL = process.env.PROFILE_BROWSER_URL || "http://localhost:3000";
let fixtureDir;
let desktopAuth;
let phoneAuth;

async function api(path, { method = "GET", body, credential } = {}) {
  const response = await fetch(`${baseURL}/api/profile${path}`, {
    method,
    headers: { "content-type": "application/json", ...(credential ? { authorization: `Bearer ${credential}` } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(`Profile API ${method} ${path}: ${response.status} ${value.error || ""}`);
  return value;
}

test.beforeAll(async () => {
  if (!enabled) return;
  fixtureDir = mkdtempSync(join(tmpdir(), "streambert-profile-player-"));
  execFileSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=black:s=160x90:r=10:d=90",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=8000:duration=90", "-c:v", "libx264", "-preset", "ultrafast",
    "-pix_fmt", "yuv420p", "-g", "20", "-sc_threshold", "0", "-c:a", "aac", "-hls_time", "2", "-hls_list_size", "0",
    "-hls_segment_filename", join(fixtureDir, "segment%03d.ts"), join(fixtureDir, "fixture.m3u8")]);

  const owner = await api("", { method: "POST", body: { displayName: `Player QA ${randomUUID().slice(0, 8)}`, deviceName: "QA desktop", tmdbToken: "profile-browser-fixture" } });
  desktopAuth = { credential: owner.credential, profileId: owner.profileId, deviceId: owner.deviceId };
  const pairing = await api("?op=pair/create", { method: "POST", credential: owner.credential, body: { deviceName: "QA phone" } });
  const claim = await api("?op=pair/claim", { method: "POST", body: { shortCode: pairing.shortCode, deviceName: "QA phone" } });
  await api("?op=pair/approve", { method: "POST", credential: owner.credential, body: { requestId: claim.requestId } });
  const grant = await api("?op=pair/poll", { method: "POST", body: { requestId: claim.requestId, pollToken: claim.pollToken } });
  phoneAuth = { credential: grant.credential, profileId: grant.profileId, deviceId: grant.deviceId };
});

test.afterAll(() => { if (fixtureDir) rmSync(fixtureDir, { recursive: true, force: true }); });

async function seedContext(context, auth, { progress = {}, resumeTime = {}, disableAutoplay = false } = {}) {
  await context.addInitScript((value) => {
    localStorage.setItem("streambert_viewingProfileAuth", JSON.stringify(value.auth));
    localStorage.setItem("lampa_stream_tmdb_token", "profile-browser-fixture");
    localStorage.setItem("streambert_playerSource", JSON.stringify("lampac"));
    if (Object.keys(value.progress).length) localStorage.setItem("streambert_progress", JSON.stringify(value.progress));
    if (Object.keys(value.resumeTime).length) localStorage.setItem("streambert_resumeTime", JSON.stringify(value.resumeTime));
    if (value.disableAutoplay) localStorage.setItem("streambert_autoplayNextEnabled", JSON.stringify(false));
  }, { auth, progress, resumeTime, disableAutoplay });
}

async function routePage(page, fixtureDir, resolutions) {
  await page.route("**/api/tmdb/**", (route) => {
    const url = new URL(route.request().url());
    const isTV = url.pathname.includes("/tv/");
    const id = isTV ? 1399 : 969681;
    const result = url.pathname.match(/\/season\/(\d+)/)
      ? { id: 1399, season_number: 1, episodes: [{ id: 99101, episode_number: 1, season_number: 1, name: "QA episode", air_date: "2024-01-01", still_path: null }] }
      : isTV
        ? { id, name: "QA series", original_name: "QA series", first_air_date: "2024-01-01", seasons: [{ season_number: 1, episode_count: 1, name: "Season 1" }], number_of_seasons: 1, genres: [], credits: { cast: [] }, external_ids: {} }
        : { id, title: "QA movie", original_title: "QA movie", release_date: "2024-01-01", runtime: 90, imdb_id: "tt0000001", genres: [], credits: { cast: [] }, external_ids: {} };
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(result) });
  });
  await page.route("**/api/source-host?op=discover", (route) => route.fulfill({
    contentType: "text/event-stream",
    body: [
      { id: "voice-ru", providerId: "habster:alloha", providerName: "Habster · Alloha", voiceId: "alloha:52", voiceName: "Русская озвучка", qualityHint: "4K" },
      { id: "voice-en", providerId: "habster:alloha", providerName: "Habster · Alloha", voiceId: "alloha:98", voiceName: "Eng.Original", qualityHint: "4K" },
    ].map((candidate) => `event: candidate\ndata: ${JSON.stringify(candidate)}\n\n`).join("") + "event: done\ndata: {}\n\n",
  }));
  await page.route("**/api/source-host?op=resolve", async (route) => {
    const request = route.request().postDataJSON();
    resolutions.push(request);
    const levels = [2160, 1080, 720, 480, 360].map((height) => ({ label: `${height}p`, height, url: `https://media.example/${request.id}/${height}p/master.m3u8` }));
    const selected = levels.find((entry) => entry.label === request.quality) || levels[0];
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({
      kind: "hls", selected, qualities: levels,
      subtitles: [{ label: "Русские", language: "ru", url: "https://media.example/subtitles/ru.vtt" }],
      audioNames: [],
    }) });
  });
  await page.route("https://media.example/**", (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname.endsWith(".vtt")) return route.fulfill({ contentType: "text/vtt", body: "WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nQA subtitle\n" });
    if (pathname.endsWith("master.m3u8")) return route.fulfill({
      contentType: "application/vnd.apple.mpegurl", headers: { "access-control-allow-origin": "*" },
      body: "#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=300000,RESOLUTION=160x90\nfixture.m3u8\n",
    });
    const filename = pathname.split("/").pop();
    return route.fulfill({ contentType: filename.endsWith("m3u8") ? "application/vnd.apple.mpegurl" : "video/mp2t",
      headers: { "access-control-allow-origin": "*" }, body: readFileSync(join(fixtureDir, filename)) });
  });
}

async function play(page, type) {
  await page.goto(new URL(type === "movie" ? "/movie/969681" : "/tv/1399", baseURL).toString());
  if (type === "movie") await page.getByRole("button", { name: "Смотреть", exact: true }).click();
  else await page.locator(".episode-card").first().click();
  const video = page.locator(".torrplayer > video");
  await expect(video).toBeVisible();
  await expect.poll(() => video.evaluate((value) => value.getVideoPlaybackQuality().totalVideoFrames)).toBeGreaterThan(0);
  return video;
}

for (const type of ["movie", "tv"]) {
  test(`real profile restores ${type} playback checkpoint and player preferences on another browser context`, { skip: !enabled, timeout: 120_000 }, async ({ browser }) => {
    const desktopContext = await browser.newContext();
    const phoneContext = await browser.newContext();
    await seedContext(desktopContext, desktopAuth);
    await seedContext(phoneContext, phoneAuth);
    const desktop = await desktopContext.newPage();
    const phone = await phoneContext.newPage();
    const desktopResolves = [];
    const phoneResolves = [];
    await routePage(desktop, fixtureDir, desktopResolves);
    await routePage(phone, fixtureDir, phoneResolves);
    const key = type === "movie" ? "movie_969681" : "tv_1399_s1e1";
    const first = await play(desktop, type);
    await expect.poll(() => first.evaluate((value) => value.currentTime)).toBeGreaterThan(2);

    await desktop.locator(".torrplayer").hover();
    await desktop.getByTitle("Озвучка").click();
    await desktop.locator(".torrplayer-audio-menu").getByRole("button", { name: "Eng.Original", exact: true }).click();
    await expect.poll(() => desktopResolves.at(-1)?.id).toBe("voice-en");
    await expect.poll(() => first.evaluate((value) => value.currentTime)).toBeGreaterThan(2);
    await desktop.locator(".torrplayer").hover();
    await desktop.getByTitle("Субтитры (C)").click();
    await desktop.locator(".torrplayer-audio-menu").getByRole("button", { name: "Русские", exact: true }).click();
    await expect.poll(() => first.evaluate((value) => [...value.textTracks].some((track) => track.mode === "showing"))).toBe(true);
    await desktop.locator(".torrplayer").hover();
    const seek = desktop.locator(".torrplayer-seek");
    const seekBox = await seek.boundingBox();
    const duration = await first.evaluate((value) => value.duration);
    await seek.click({ position: { x: seekBox.width * 37.25 / duration, y: seekBox.height / 2 } });
    await expect.poll(() => first.evaluate((value) => !value.seeking && Math.abs(value.currentTime - 37.25) <= 1)).toBe(true);
    await desktop.getByTitle("Пауза (Space / K)").click();
    await expect.poll(() => first.evaluate((value) => value.paused)).toBe(true);

    const checkpoint = await api("", { credential: desktopAuth.credential });
    const saved = checkpoint.checkpoints[key];
    expect(saved, `missing server checkpoint ${key}`).toBeTruthy();
    expect(Math.abs(saved.position - 37.25)).toBeLessThanOrEqual(1);
    expect(saved.preferences.voiceId).toBe("alloha:98");
    expect(saved.preferences.subtitle).toMatchObject({ enabled: true, kind: "external", name: "Русские", lang: "ru" });
    const sessions = Object.values(checkpoint.sessions || {}).filter((session) => session.progressKey === key);
    const watchedSeconds = sessions.flatMap((session) => session.segments).reduce((sum, segment) => sum + (segment.end - segment.start) / 1000, 0);
    expect(watchedSeconds).toBeGreaterThan(0);
    expect(watchedSeconds).toBeLessThan(20); // seeking to 37s contributes no 30s artificial watch time

    const second = await play(phone, type);
    await expect.poll(() => phoneResolves.at(-1)?.id).toBe("voice-en");
    await expect.poll(() => phoneResolves.at(-1)?.quality).toBe("2160p");
    await expect.poll(() => second.evaluate((value, target) => Math.abs(value.currentTime - target) <= 1, saved.position)).toBe(true);
    await expect.poll(() => second.evaluate((value) => value.getVideoPlaybackQuality().totalVideoFrames)).toBeGreaterThan(0);
    await expect.poll(() => second.evaluate((value) => [...value.textTracks].some((track) => track.mode === "showing"))).toBe(true);

    // Turn subtitles off on the phone, pause at a fresh point, then prove OFF is
    // represented semantically in Redis instead of being lost as an absent value.
    await phone.locator(".torrplayer").hover();
    await phone.getByTitle("Субтитры (C)").click();
    await phone.locator(".torrplayer-audio-menu").getByRole("button", { name: "Выключить", exact: true }).click();
    await expect.poll(() => second.evaluate((value) => [...value.textTracks].every((track) => track.mode !== "showing"))).toBe(true);
    await phone.getByTitle("Пауза (Space / K)").click();
    await expect.poll(async () => (await api("", { credential: phoneAuth.credential })).checkpoints[key]?.preferences.subtitle?.enabled).toBe(false);
    const final = await api("", { credential: phoneAuth.credential });
    expect(final.checkpoints[key].preferences.subtitle).toMatchObject({ enabled: false });
    expect(Math.abs(final.checkpoints[key].position - saved.position)).toBeLessThanOrEqual(1);
    await desktopContext.close();
    await phoneContext.close();
  });

  test(`an explicit near-end ${type} checkpoint overrides stale legacy completed progress`, { skip: !enabled, timeout: 120_000 }, async ({ browser }) => {
    const key = type === "movie" ? "movie_969681" : "tv_1399_s1e1";
    const item = type === "movie"
      ? { type: "movie", id: "969681", title: "QA movie", genres: [] }
      : { type: "tv", id: "1399", title: "QA series", season: 1, episode: 1, genres: [] };
    const position = 86.375;
    const current = await api("", { credential: desktopAuth.credential });
    const patched = await api("", { method: "PATCH", credential: desktopAuth.credential, body: {
      mutationId: randomUUID(), deviceId: desktopAuth.deviceId,
      checkpoints: [{ progressKey: key, item, position, duration: 90, baseRevision: current.revision || 0,
        preferences: { providerId: "habster:alloha", voiceId: "alloha:98", voiceName: "Eng.Original", quality: "1080p", subtitle: { enabled: false } } }],
      sessions: [], library: {},
    } });
    expect(patched.snapshot.checkpoints[key].position).toBe(position);

    const context = await browser.newContext();
    await seedContext(context, phoneAuth, { progress: { [key]: 96 }, resumeTime: { [key]: 4 }, disableAutoplay: true });
    const page = await context.newPage();
    const resolutions = [];
    await routePage(page, fixtureDir, resolutions);
    const video = await play(page, type);
    await expect.poll(() => resolutions.at(-1)?.id).toBe("voice-en");
    await expect.poll(() => resolutions.at(-1)?.quality).toBe("1080p");
    await expect.poll(() => video.evaluate((value, target) => Math.abs(value.currentTime - target) <= 1, position)).toBe(true);
    await page.getByTitle("Пауза (Space / K)").click();
    await expect.poll(() => video.evaluate((value) => value.paused)).toBe(true);
    await context.close();
  });

  test(`a genuine native end after a near-end ${type} resume completes the viewing session`, { skip: !enabled, timeout: 120_000 }, async ({ browser }) => {
    const key = type === "movie" ? "movie_969681" : "tv_1399_s1e1";
    const item = type === "movie"
      ? { type: "movie", id: "969681", title: "QA movie", genres: [] }
      : { type: "tv", id: "1399", title: "QA series", season: 1, episode: 1, genres: [] };
    const position = 86.375;
    const current = await api("", { credential: desktopAuth.credential });
    await api("", { method: "PATCH", credential: desktopAuth.credential, body: {
      mutationId: randomUUID(), deviceId: desktopAuth.deviceId,
      checkpoints: [{ progressKey: key, item, position, duration: 90, baseRevision: current.revision || 0,
        preferences: { providerId: "habster:alloha", voiceId: "alloha:98", voiceName: "Eng.Original", quality: "1080p", subtitle: { enabled: false } } }],
      sessions: [], library: {},
    } });
    const priorSnapshot = await api("", { credential: phoneAuth.credential });
    const priorSessionIds = new Set(Object.values(priorSnapshot.sessions || {})
      .filter((session) => session.progressKey === key).map((session) => session.sessionId));

    const context = await browser.newContext();
    await seedContext(context, phoneAuth, { disableAutoplay: true });
    const page = await context.newPage();
    const resolutions = [];
    await routePage(page, fixtureDir, resolutions);
    const video = await play(page, type);
    await expect.poll(() => video.evaluate((value, target) => Math.abs(value.currentTime - target) <= 1, position)).toBe(true);
    await expect.poll(() => video.evaluate((value) => value.ended), { timeout: 25_000 }).toBe(true);
    let endedSession = null;
    await expect.poll(async () => {
      const snapshot = await api("", { credential: phoneAuth.credential });
      const matching = Object.values(snapshot.sessions || {}).filter((session) => session.progressKey === key);
      console.log("API sessions for native-end playback", JSON.stringify(matching.map(({ sessionId, completedAt, segments }) => ({
        sessionId, wasPresentBeforePlayback: priorSessionIds.has(sessionId), completedAt: completedAt || null, segmentCount: segments?.length || 0,
      }))));
      endedSession = matching.find((session) => !priorSessionIds.has(session.sessionId) && session.completedAt) || null;
      return endedSession?.completedAt || 0;
    }, { timeout: 10_000 }).toBeGreaterThan(0);
    expect(endedSession?.segments?.length).toBeGreaterThan(0);
    const watchedSeconds = endedSession.segments.reduce((sum, segment) => sum + (segment.end - segment.start) / 1000, 0);
    expect(watchedSeconds).toBeGreaterThanOrEqual(1.5);
    await context.close();
  });
}
