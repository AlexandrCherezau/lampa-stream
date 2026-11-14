// Our controls driving an embedded player. The frame is a stand-in that speaks the
// real player's message protocol; the real one needs the separate live check.
import { test, expect } from "@playwright/test";

const EMBED = "https://befriend.stravers.live/?kp=5494049&token=t";
const FRAME = `<!doctype html><body style="background:#123"><button id="native" style="position:fixed;inset:0;width:100%;height:100%">native</button><div id="bar" style="position:fixed;left:0;right:0;bottom:10px;height:40px;pointer-events:none"></div><script>
  let time = 0, playing = false; window.received = [];
  const emit = (event, value = time) => parent.postMessage(JSON.stringify({ event, time: value }), "*");
  document.getElementById("native").onclick = () => { window.clicked = (window.clicked || 0) + 1; playing = true; emit("play"); };
  addEventListener("message", (e) => { const m = JSON.parse(e.data); window.received.push(m);
    if (m.api === "play") { playing = !window.blockAutoplay; if (playing) emit("play"); }
    if (m.api === "pause") { playing = false; emit("pause"); }
    if (m.api === "seek") { time = m.value; emit("seek"); }
    if (m.api === "duration") emit("duration", 7200); });
  setInterval(() => { if (playing && !window.freeze) { time += 0.25; emit("timeupdate"); } }, 250);
  emit("pause");
<\/script>`;

async function open(page, { blockAutoplay = false, frameBody = null, frameDelay = 0 } = {}) {
  await page.addInitScript(() => localStorage.setItem("lampa_stream_tmdb_token", "fixture"));
  await page.addInitScript((candidate) => {
    const originalFetch = window.fetch.bind(window);
    window.fetch = (input, init) => String(input).includes("/api/source-host?op=discover")
      ? Promise.resolve(new Response(`event: candidate\ndata: ${JSON.stringify(candidate)}\n\n`, { headers: { "content-type": "text/event-stream" } }))
      : originalFetch(input, init);
  }, { id: "alloha", providerId: "habster:alloha", providerName: "Habster · Alloha", voiceName: "Озвучки в плеере", qualityHint: "До 4K" });
  await page.route("**/api/tmdb/**", (route) => route.fulfill({ json: { id: 969681, title: "Фильм", original_title: "Film", release_date: "2026-07-31", runtime: 120, imdb_id: "tt22084616", kinopoisk_id: 5494049, genres: [], credits: { cast: [] }, results: [], images: {} } }));
  await page.route("**/api/source-host?op=resolve", (route) => route.fulfill({ json: { kind: "embed", selected: { label: "auto", url: EMBED }, qualities: [], subtitles: [], audioNames: [] } }));
  await page.route("https://befriend.stravers.live/**", async (route) => {
    if (frameDelay) await new Promise((resolve) => setTimeout(resolve, frameDelay));
    return route.fulfill({ contentType: "text/html", body: frameBody || blockAutoplay ? frameBody || FRAME.replace("window.received = [];", "window.received = []; window.blockAutoplay = true;") : FRAME });
  });
  await page.goto("/movie/969681");
  await page.getByRole("button", { name: /^Смотреть/ }).first().click();
  await expect(page.locator(".torrplayer-embed")).toBeVisible();
  return page.frameLocator(".torrplayer-embed");
}
const received = (page) => page.frames().find((frame) => frame.url().startsWith("https://befriend")).evaluate(() => window.received);
const reveal = async (page) => { const box = await page.locator(".torrplayer").boundingBox(); await page.mouse.move(box.x + box.width / 2, box.y + box.height / 3); await page.mouse.move(box.x + box.width / 2 + 20, box.y + box.height / 3); };

test("our controls drive the embedded player and keep the pointer off its own", async ({ page }) => {
  const frame = await open(page);
  await frame.locator("#native").click();
  await expect(page.locator(".torrplayer--embed-start")).toHaveCount(0, { timeout: 15_000 });
  await expect(page.locator(".torrplayer-embed-shield")).toBeVisible();
  await reveal(page);
  await expect(page.locator(".torrplayer-btn--mute")).toBeHidden();
  await page.locator(".torrplayer-btn--play").click();
  await expect.poll(async () => (await received(page)).some((m) => m.api === "pause")).toBe(true);
  await page.locator(".torrplayer-bigplay").click({ timeout: 5000 });
  await expect.poll(async () => (await received(page)).filter((m) => m.api === "play").length).toBeGreaterThan(0);
  await expect(page.locator(".torrplayer-bigplay")).toBeHidden();
  const box = await page.locator(".torrplayer").boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect.poll(async () => (await received(page)).filter((m) => m.api === "pause").length).toBeGreaterThan(1);
  const clicked = await page.frames().find((f) => f.url().startsWith("https://befriend")).evaluate(() => window.clicked || 0);
  expect(clicked).toBe(1);
});

test("the player is never started before the viewer's click", async ({ page }) => {
  await open(page);
  await page.waitForTimeout(3000);
  expect((await received(page)).filter((m) => m.api === "play")).toHaveLength(0);
  await expect(page.locator(".torrplayer--embed-start")).toHaveCount(1);
});

test("before starting, only our button shows and the viewer's click reaches the frame", async ({ page }) => {
  await open(page);
  await expect(page.locator(".torrplayer--embed-start")).toHaveCount(1);
  const playButton = page.locator(".torrplayer-bigplay");
  await expect(playButton).toBeVisible();
  await expect(page.locator(".torrplayer-btn--play")).toBeHidden();
  const box = await playButton.boundingBox();
  const hit = await page.evaluate(([x, y]) => { const e = document.elementFromPoint(x, y); return e.tagName + "." + e.className; }, [box.x + box.width / 2, box.y + box.height / 2]);
  expect(hit).toContain("torrplayer-embed");
  await page.waitForTimeout(500); // a just-loaded frame's first input can be dropped by the browser
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect.poll(() => page.frames().find((f) => f.url().startsWith("https://befriend")).evaluate(() => window.clicked || 0)).toBe(1);
  await expect(page.locator(".torrplayer--embed-start")).toHaveCount(0);
  const clicked = await page.frames().find((f) => f.url().startsWith("https://befriend")).evaluate(() => window.clicked || 0);
  expect(clicked).toBe(1);
});

test("the frame's own bars are cut off by the player's edge while ours are in charge", async ({ page }) => {
  await open(page);
  // Measured together: the page may still be settling between two separate reads.
  const { player, frame } = await page.evaluate(() => {
    const rect = (selector) => { const r = document.querySelector(selector).getBoundingClientRect(); return { y: r.y, height: r.height }; };
    return { player: rect(".torrplayer"), frame: rect(".torrplayer-embed") };
  });
  expect(player.y - frame.y).toBeGreaterThanOrEqual(96);
  expect(frame.y + frame.height - (player.y + player.height)).toBeGreaterThanOrEqual(96);
  expect(frame.y + frame.height / 2).toBeCloseTo(player.y + player.height / 2, 0);
});

test("a player that does not start after the click is shown whole, so an ad can be used", async ({ page }) => {
  test.setTimeout(60_000);
  const frameBody = FRAME.replace('playing = true; emit("play");', 'window.adShown = true;');
  const frame = await open(page, { frameBody });
  await expect(page.locator(".torrplayer--embed-exposed")).toHaveCount(0);
  await frame.locator("#native").click();
  await expect(page.locator(".torrplayer--embed-exposed")).toHaveCount(1, { timeout: 15_000 });
  const player = await page.locator(".torrplayer").boundingBox();
  const shown = await page.locator(".torrplayer-embed").boundingBox();
  expect(shown.y).toBeCloseTo(player.y, 0);
  await expect(page.locator(".torrplayer-embed-shield")).toBeHidden();
});

test("a playing film whose clock stops is shown whole until it moves again", async ({ page }) => {
  test.setTimeout(60_000);
  const frame = await open(page);
  await frame.locator("#native").click();
  await expect(page.locator(".torrplayer--embed-start")).toHaveCount(0);
  await page.frames().find((f) => f.url().startsWith("https://befriend")).evaluate(() => { window.freeze = true; });
  await expect(page.locator(".torrplayer--embed-exposed")).toHaveCount(1, { timeout: 15_000 });
  await page.frames().find((f) => f.url().startsWith("https://befriend")).evaluate(() => { window.freeze = false; });
  await expect(page.locator(".torrplayer--embed-exposed")).toHaveCount(0, { timeout: 5_000 });
});

test("the settings button shows the whole frame and Готово brings ours back", async ({ page }) => {
  const frame = await open(page);
  await frame.locator("#native").click();
  await expect(page.locator(".torrplayer--embed-start")).toHaveCount(0, { timeout: 15_000 });
  await reveal(page);
  await page.locator(".torrplayer-btn--embed-menu").click();
  await expect(page.locator(".torrplayer--embed-front")).toHaveCount(1);
  await frame.locator("#native").click({ position: { x: 20, y: 20 } });
  await page.locator(".torrplayer-embed-back").click();
  await expect(page.locator(".torrplayer--embed-front")).toHaveCount(0);
});

test("native waiting from the hidden video cannot block starting an embed", async ({ page }) => {
  await page.addInitScript(() => {
    const add = HTMLVideoElement.prototype.addEventListener;
    HTMLVideoElement.prototype.addEventListener = function (type, listener, options) {
      add.call(this, type, listener, options);
      if (type === "waiting") this.dispatchEvent(new Event("waiting"));
    };
  });
  await open(page);
  await expect(page.locator(".torrplayer-bigplay")).toBeVisible();
  await page.locator(".torrplayer-video").evaluate((video) => video.dispatchEvent(new Event("waiting")));
  await expect(page.locator(".torrplayer > .torrplayer-spinner")).toHaveCount(0);
  const box = await page.locator(".torrplayer-bigplay").boundingBox();
  await page.waitForTimeout(500);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await expect.poll(() => page.frames().find((f) => f.url().startsWith("https://befriend")).evaluate(() => window.clicked || 0)).toBe(1);
});

test("the loading spinner lets the first click reach the frame", async ({ page }) => {
  await open(page, { frameDelay: 3000 });
  const spinner = page.locator(".torrplayer > .torrplayer-spinner");
  await expect(spinner).toBeVisible();
  const box = await spinner.boundingBox();
  const hit = await page.evaluate(([x, y]) => document.elementFromPoint(x, y).className,
    [box.x + box.width / 2, box.y + box.height / 2]);
  expect(hit).toContain("torrplayer-embed");
  await expect(page.locator(".torrplayer-bigplay")).toBeVisible();
});
