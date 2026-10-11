import { chromium } from "playwright";

const origin = process.env.PRODUCTION_ORIGIN;
if (!origin) throw new Error("Set PRODUCTION_ORIGIN to the deployed app origin before running this smoke check");
if (!process.env.PLAYER_SMOKE_TMDB_TOKEN) throw new Error("Set PLAYER_SMOKE_TMDB_TOKEN to the TMDB credential used for this smoke session");
const base = new URL(origin);
if (!/^https?:$/.test(base.protocol)) throw new Error("PRODUCTION_ORIGIN must use HTTP(S)");

const cases = [
  { name: "Movie 550", path: "/movie/550", type: "movie" },
  { name: "TV 1396 S1E1", path: "/tv/1396?season=1&episode=1", type: "tv", season: 1, episode: 1 },
  { name: "Anime 60863 S1E14", path: "/tv/60863?season=1&episode=14", type: "tv", season: 1, episode: 14 },
  { name: "Anime 60863 S3E1", path: "/tv/60863?season=3&episode=1", type: "tv", season: 3, episode: 1 },
];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check, description, timeout = 120_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await check();
    if (value) return value;
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function inspectPlayback(page, testCase, timingState) {
  const caseId = ++timingState.caseId;
  timingState.ranges = [];
  await page.goto(new URL(testCase.path, base).toString(), { waitUntil: "domcontentloaded", timeout: 45_000 });
  await page.locator(".detail-title").waitFor({ state: "visible", timeout: 45_000 });

  if (testCase.type === "movie") {
    await page.getByRole("button", { name: "Смотреть", exact: true }).click({ timeout: 30_000 });
  } else {
    await page.locator(".episode-card").filter({ has: page.locator(".episode-num", { hasText: new RegExp(`^E${testCase.episode}$`) }) }).first().click({ timeout: 30_000 });
  }

  const video = page.locator("video");
  await video.waitFor({ state: "visible", timeout: 30_000 });
  await waitFor(() => video.evaluate((element) => element.readyState >= 2), "decoded video data", 180_000);
  await waitFor(() => video.evaluate((element) => element.currentTime > 0.5), "playback progress", 45_000);
  const frameCount = await video.evaluate(async (element) => new Promise((resolve) => {
    let frames = 0;
    const deadline = setTimeout(() => resolve(frames), 5_000);
    const next = () => element.requestVideoFrameCallback(() => {
      frames++;
      if (frames >= 2) { clearTimeout(deadline); resolve(frames); }
      else next();
    });
    if (typeof element.requestVideoFrameCallback !== "function") { clearTimeout(deadline); resolve(0); return; }
    next();
  }));
  if (frameCount < 2) throw new Error(`${testCase.name}: video did not present two decoded frames`);

  const initial = await video.evaluate((element) => ({ time: element.currentTime, duration: element.duration }));
  const seekTarget = Math.min(12, Number.isFinite(initial.duration) ? initial.duration * 0.3 : 12);
  if (seekTarget > 2) {
    await video.evaluate((element, target) => { element.currentTime = target; }, seekTarget);
    await waitFor(() => video.evaluate((element, target) => Math.abs(element.currentTime - target) < 2, seekTarget), "seek to take effect", 15_000);
  }

  let skipControl = false;
  try {
    const range = await waitFor(() => timingState.caseId === caseId && timingState.ranges.find((value) => value.end > value.start && value.end < initial.duration - 5), "a confirmed intro skip interval", 25_000);
    await video.evaluate((element, target) => { element.currentTime = target; }, range.start + 0.1);
    const skipButton = page.locator(".torrplayer-skip");
    await skipButton.waitFor({ state: "visible", timeout: 8_000 });
    await skipButton.click();
    await waitFor(() => video.evaluate((element, end) => element.currentTime >= end - 1, range.end), "skip control to seek to the end of its marked interval", 10_000);
    skipControl = true;
  } catch (error) {
    if (!error.message.startsWith("Timed out waiting for a confirmed intro skip interval")) throw error;
    // Check the remaining titles; anime timing data may be available even if
    // this movie has no confirmed IntroDB marker.
  }

  const controls = page.locator(".torrplayer-controls");
  await controls.hover().catch(() => {});
  const sourceButton = page.locator('.torrplayer-btn[title="Источник"]');
  await sourceButton.waitFor({ state: "visible", timeout: 90_000 });
  await sourceButton.click();
  const sourceMenu = page.locator(".torrplayer-audio-menu--wide").filter({ has: page.locator(".torrplayer-audio-item") }).first();
  await sourceMenu.waitFor({ state: "visible", timeout: 10_000 });
  const sourceNames = await sourceMenu.locator(".torrplayer-audio-item").allTextContents();
  if (!sourceNames.length || await sourceButton.getAttribute("title") !== "Источник") {
    throw new Error(`${testCase.name}: source picker did not expose its Russian UI control`);
  }
  await sourceButton.click();

  const voiceButton = page.locator('.torrplayer-btn[title="Озвучка"]');
  await voiceButton.waitFor({ state: "visible", timeout: 30_000 });
  await voiceButton.click();
  const voiceMenu = page.locator(".torrplayer-audio-menu--wide").filter({ has: page.locator(".torrplayer-audio-item") }).first();
  await voiceMenu.waitFor({ state: "visible", timeout: 10_000 });
  const voices = await voiceMenu.locator(".torrplayer-audio-item").allTextContents();
  if (!voices.length || await voiceButton.getAttribute("title") !== "Озвучка") {
    throw new Error(`${testCase.name}: voice picker did not expose its Russian UI control`);
  }
  await voiceButton.click();

  const qualityButton = page.locator('.torrplayer-btn[title^="Качество"]');
  await qualityButton.waitFor({ state: "visible", timeout: 30_000 });
  await qualityButton.click();
  const qualityMenu = page.locator(".torrplayer-audio-menu").filter({ has: page.locator(".torrplayer-audio-item") }).last();
  await qualityMenu.waitFor({ state: "visible", timeout: 10_000 });
  const qualities = await qualityMenu.locator(".torrplayer-audio-item").allTextContents();
  if (!qualities.some((label) => /\b(?:480|576|720|1080|1440|2160)p?\b|4k/i.test(label))) {
    throw new Error(`${testCase.name}: no selectable stream quality was listed`);
  }

  return { frames: frameCount, advanced: true, seek: seekTarget > 2, skip: skipControl, sources: sourceNames.length, voices: voices.length, qualities: qualities.length };
}

const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PLAYWRIGHT_CHROMIUM || "/usr/bin/chromium",
  args: ["--no-sandbox"],
});
try {
  const context = await browser.newContext();
  await context.addInitScript((token) => {
    localStorage.setItem("streambert_playerSource", JSON.stringify("lampac"));
    localStorage.setItem("streambert_introSkipMode", JSON.stringify("manual"));
    localStorage.setItem("streambert_skipHeuristicMode", JSON.stringify("manual"));
    if (token) localStorage.setItem("lampa_stream_tmdb_token", token);
  }, process.env.PLAYER_SMOKE_TMDB_TOKEN || "");
  const page = await context.newPage();
  const pageErrors = [];
  const timingState = { caseId: 0, ranges: [] };
  page.on("pageerror", (error) => pageErrors.push(error.name || "Error"));
  page.on("response", async (response) => {
    try {
      const caseId = timingState.caseId;
      const url = new URL(response.url());
      const introDbResponse = url.pathname === "/api/introdb";
      const aniSkipResponse = url.hostname === "api.aniskip.com" && /\/v2\/skip-times\//.test(url.pathname);
      if (response.status() >= 400 || (!introDbResponse && !aniSkipResponse)) return;
      const data = await response.json();
      if (caseId !== timingState.caseId) return;
      if (introDbResponse) {
        const intro = data?.intro;
        if (intro) timingState.ranges.push({ start: Number(intro.start_sec ?? intro.startTime), end: Number(intro.end_sec ?? intro.endTime) });
      } else if (aniSkipResponse) {
        const opening = data?.results?.find((entry) => entry.skipType === "op");
        if (opening?.interval) timingState.ranges.push({ start: Number(opening.interval.startTime), end: Number(opening.interval.endTime) });
      }
    } catch { /* Non-JSON and unrelated responses are ignored. */ }
  });

  const results = [];
  for (const testCase of cases) {
    results.push({ title: testCase.name, ...(await inspectPlayback(page, testCase, timingState)) });
  }
  if (!results.some((result) => result.skip)) throw new Error("No title exposed a working Russian skip control");
  if (pageErrors.length) throw new Error(`Browser reported ${pageErrors.length} page errors: ${[...new Set(pageErrors)].join(", ")}`);
  console.log(JSON.stringify({ status: "passed", results }, null, 2));
  await context.close();
} finally {
  await browser.close();
}
