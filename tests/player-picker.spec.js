import { test, expect } from "@playwright/test";

const FRAME_ORIGIN = "https://player-picker.example";
const FRAME = `<!doctype html><body style="margin:0;background:#000"><button id="native" style="position:fixed;inset:0;opacity:0">native</button><script>
  window.clicked = 0;
  let playing = false, time = 0;
  const emit = (event, value = time) => parent.postMessage(JSON.stringify({ event, time: value }), "*");
  document.getElementById("native").onclick = () => {
    window.clicked += 1;
    playing = true;
    emit("play");
  };
  addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.api === "play") { playing = true; emit("play"); }
    if (message.api === "pause") { playing = false; emit("pause"); }
    if (message.api === "duration") emit("duration", 7200);
    if (message.api === "seek") { time = message.value; emit("seek"); }
  });
  setInterval(() => { if (playing && !window.freeze) { time += 0.25; emit("timeupdate"); } }, 250);
<\/script>`;

async function setup(page, { holdResolve = false, nativeWaiting = false } = {}) {
  await page.addInitScript(({ nativeWaiting }) => {
    localStorage.setItem("lampa_stream_tmdb_token", "player-picker-fixture");
    Object.defineProperty(navigator, "connection", { value: { saveData: true }, configurable: true });
    if (nativeWaiting) {
      const add = HTMLVideoElement.prototype.addEventListener;
      HTMLVideoElement.prototype.addEventListener = function (type, listener, options) {
        add.call(this, type, listener, options);
        if (type === "waiting") this.dispatchEvent(new Event("waiting"));
      };
    }
  }, { nativeWaiting });
  await page.route("**/api/tmdb/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    const id = Number(path.match(/\/(?:movie|tv)\/(\d+)/)?.[1] || 550);
    const tv = path.includes("/tv/");
    const json = path.includes("/season/") ? {
      season_number: 1, episodes: [{ id: id * 10 + 1, episode_number: 1, season_number: 1, name: "Эпизод 1", air_date: "2024-01-01", runtime: 45 }],
    } : /\/(movie|tv)\/\d+$/.test(path) ? {
      id, ...(tv ? { name: `Сериал ${id}`, original_name: `Series ${id}` } : { title: `Фильм ${id}`, original_title: `Movie ${id}` }),
      release_date: "2024-01-01", first_air_date: "2024-01-01", runtime: 90, original_language: "en",
      genres: [], credits: { cast: [] }, external_ids: {}, number_of_seasons: 1,
      seasons: [{ season_number: 1, episode_count: 1, name: "Сезон 1" }],
    } : { results: [], images: {} };
    return route.fulfill({ json });
  });
  await page.route("**/api/source-host?op=discover", (route) => {
    const query = route.request().postDataJSON();
    const candidates = ["alloha", "collaps"].map((provider) => ({
      id: `${query.tmdbId}-${query.episode || 0}-${provider}`, providerId: `habster:${provider}`,
      providerName: `Habster · ${provider === "alloha" ? "Alloha" : "Collaps"}`,
      voiceId: "default", voiceName: "Русский", qualityHint: "1080p",
    }));
    return route.fulfill({ contentType: "text/event-stream", body: candidates.map((candidate) =>
      `event: candidate\ndata: ${JSON.stringify(candidate)}\n\n`).join("") + "event: done\ndata: {}\n\n" });
  });
  const resolutions = [];
  let releaseResolve;
  const resolveGate = holdResolve ? new Promise((resolve) => { releaseResolve = resolve; }) : Promise.resolve();
  await page.route("**/api/source-host?op=resolve", async (route) => {
    const request = route.request().postDataJSON();
    resolutions.push(request.id);
    await resolveGate;
    return route.fulfill({ json: {
      kind: "embed", selected: { label: "auto", url: `${FRAME_ORIGIN}/${request.id}` },
      qualities: [], subtitles: [], audioNames: [],
    } });
  });
  await page.route(`${FRAME_ORIGIN}/**`, (route) => route.fulfill({ contentType: "text/html", body: FRAME }));
  return { resolutions, releaseResolve };
}

async function open(page, path = "/movie/550") {
  await page.goto(path);
  if (path.startsWith("/tv/")) await page.locator(".episode-card").first().click();
  else await page.getByRole("button", { name: "Смотреть", exact: true }).click();
}

const picker = (page) => page.locator(".torrplayer-provider-picker");
const trigger = (page) => picker(page).getByRole("button", { name: /^Плеер:/ });
const menu = (page) => page.locator(".torrplayer-provider-menu");

async function expectBeforeStart(page) {
  await expect(page.locator(".torrplayer--embed-start")).toHaveCount(1);
  await expect(page.locator(".torrplayer-bigplay")).toBeVisible();
  await expect(trigger(page)).toBeVisible();
  await expect(trigger(page)).toContainText("Habster · Alloha");
  await expect(page.locator(".torrplayer > .torrplayer-spinner")).toHaveCount(0);
  await expect(page.locator(".torrplayer-controls")).toBeHidden();
}

test("the source picker is available while the first source is resolving", async ({ page }) => {
  const fixture = await setup(page, { holdResolve: true });
  try {
    await open(page);
    await expect.poll(() => fixture.resolutions.length).toBeGreaterThan(0);
    await expect(trigger(page)).toBeVisible();
    await trigger(page).click();
    await expect(menu(page).getByRole("button")).toHaveCount(2);
  } finally {
    fixture.releaseResolve();
  }
  await expect(page.locator(".torrplayer-bigplay")).toBeVisible();
});

test("a black series embed keeps play visible and the picker above the frame", async ({ page }) => {
  await setup(page, { nativeWaiting: true });
  await open(page, "/tv/1396");
  await expectBeforeStart(page);
  await page.locator(".torrplayer-video").evaluate((video) => video.dispatchEvent(new Event("waiting")));
  await expectBeforeStart(page);
  await expect(trigger(page)).toHaveAttribute("aria-haspopup", "true");
  await expect(trigger(page)).toHaveAttribute("aria-expanded", "false");
  await trigger(page).click();
  await expect(trigger(page)).toHaveAttribute("aria-expanded", "true");
  const items = menu(page).getByRole("button");
  await expect(items).toHaveCount(2);
  await expect(items.nth(0)).toHaveText(/1\.?\s*Habster · Alloha.*1080p/);
  await expect(items.nth(1)).toHaveText(/2\.?\s*Habster · Collaps.*1080p/);
  await expect(items.nth(0)).toHaveAccessibleName("Плеер 1: Habster · Alloha · до 1080p");
  await expect(items.nth(1)).toHaveAccessibleName("Плеер 2: Habster · Collaps · до 1080p");
  await expect(items.nth(0)).toHaveAttribute("aria-current", "true");
  await trigger(page).press("Escape");
  await expect(menu(page)).toBeHidden();
  await expect(trigger(page)).toHaveAttribute("aria-expanded", "false");
  await page.locator(".torrplayer-bigplay").scrollIntoViewIfNeeded();
  const { x, y, hit } = await page.locator(".torrplayer-bigplay").evaluate((button) => {
    const box = button.getBoundingClientRect();
    const x = box.x + box.width / 2, y = box.y + box.height / 2;
    return { x, y, hit: document.elementFromPoint(x, y).className };
  });
  expect(hit).toContain("torrplayer-embed");
  await page.waitForTimeout(500); // A just-loaded frame can drop its first input.
  await page.mouse.click(x, y);
  await expect.poll(() => page.frames().find((frame) => frame.url().startsWith(FRAME_ORIGIN)).evaluate(() => window.clicked)).toBe(1);
});

test("picking a numbered provider resolves it and keeps the choice on another title", async ({ page }) => {
  const { resolutions } = await setup(page);
  await open(page);
  await expectBeforeStart(page);
  await trigger(page).click();
  await menu(page).getByRole("button", { name: /Habster · Collaps/ }).click();
  await expect(menu(page)).toBeHidden();
  await expect(trigger(page)).toContainText("Habster · Collaps");
  await expect.poll(() => resolutions.includes("550-0-collaps")).toBe(true);
  await expect(page.locator(".torrplayer-embed")).toHaveAttribute("src", `${FRAME_ORIGIN}/550-0-collaps`);
  await open(page, "/movie/551");
  await expect(trigger(page)).toContainText("Habster · Collaps");
  await expect(page.locator(".torrplayer-embed")).toHaveAttribute("src", `${FRAME_ORIGIN}/551-0-collaps`);
  expect(resolutions.filter((id) => id.startsWith("551-"))).toEqual(["551-0-collaps"]);
  await trigger(page).click();
  await expect(menu(page).getByRole("button", { name: /Habster · Collaps/ })).toHaveAttribute("aria-current", "true");
});

test("the menu supports keyboard selection and closes on an outside click", async ({ page }) => {
  await setup(page);
  await open(page);
  await expectBeforeStart(page);
  await trigger(page).focus();
  await trigger(page).press("Enter");
  await expect(menu(page)).toBeVisible();
  const alternate = menu(page).getByRole("button", { name: /Habster · Collaps/ });
  await alternate.focus();
  await alternate.press("Escape");
  await expect(menu(page)).toBeHidden();
  await trigger(page).click();
  await page.locator(".detail-title").click();
  await expect(menu(page)).toBeHidden();
  await trigger(page).click();
  await alternate.focus();
  await alternate.press("Enter");
  await expect(trigger(page)).toContainText("Habster · Collaps");
  await expect(menu(page)).toBeHidden();
});

test("the mobile picker fits beside the page mode switch", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setup(page);
  await open(page);
  await expectBeforeStart(page);
  const bounds = await trigger(page).boundingBox();
  const mode = await page.locator(".player-overlay-group").boundingBox();
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(390);
  const overlapsMode = bounds.x < mode.x + mode.width && bounds.x + bounds.width > mode.x
    && bounds.y < mode.y + mode.height && bounds.y + bounds.height > mode.y;
  expect(overlapsMode).toBe(false);
  await trigger(page).click();
  const list = await menu(page).boundingBox();
  expect(list.x).toBeGreaterThanOrEqual(0);
  expect(list.x + list.width).toBeLessThanOrEqual(390);
  await menu(page).getByRole("button", { name: /Habster · Collaps/ }).click();
  await expect(trigger(page)).toContainText("Habster · Collaps");
});

test("the picker follows playing controls and leaves existing settings and native menus clear", async ({ page }) => {
  await setup(page);
  await open(page);
  await expectBeforeStart(page);
  await page.locator(".torrplayer-bigplay").scrollIntoViewIfNeeded();
  const play = await page.locator(".torrplayer-bigplay").boundingBox();
  await page.waitForTimeout(500);
  await page.mouse.click(play.x + play.width / 2, play.y + play.height / 2);
  await expect(page.locator(".torrplayer--embed-start")).toHaveCount(0);
  await expect(trigger(page)).toBeHidden({ timeout: 6000 });
  const player = await page.locator(".torrplayer").boundingBox();
  await page.mouse.move(player.x + player.width / 2 + 20, player.y + player.height / 3);
  await expect(trigger(page)).toBeVisible();
  await page.locator(".torrplayer-btn--play").click();
  await expect.poll(() => page.locator(".torrplayer-video").evaluate((video) => video.paused)).toBe(true);
  await page.waitForTimeout(3500);
  await expect(trigger(page)).toBeVisible();
  await page.locator(".torrplayer-btn--settings").click();
  await expect(page.locator(".torrplayer-settings.is-open")).toBeVisible();
  await expect(picker(page)).toHaveCount(0);
  await page.getByTitle("Источник", { exact: true }).click();
  const sources = page.locator(".torrplayer-settings .torrplayer-audio-menu");
  await expect(sources.getByRole("button")).toHaveCount(2);
  await expect(sources.getByRole("button", { name: /Habster · Alloha/ })).toBeVisible();
  await expect(sources.getByRole("button", { name: /Habster · Collaps/ })).toBeVisible();
  await expect(menu(page)).toHaveCount(0);
  await page.locator(".torrplayer-btn--settings").click();
  await page.locator(".torrplayer-btn--settings").click();
  await expect(trigger(page)).toBeVisible();
  await page.locator(".torrplayer-btn--embed-menu").click();
  await expect(page.locator(".torrplayer--embed-front")).toHaveCount(1);
  await expect(picker(page)).toHaveCount(0);
  await page.locator(".torrplayer-embed-back").click();
  await expect(page.locator(".torrplayer--embed-front")).toHaveCount(0);
  await expect(trigger(page)).toBeVisible();
});

test("the picker can be revealed and used above an automatically exposed iframe", async ({ page }) => {
  test.setTimeout(60_000);
  await setup(page);
  await open(page);
  await expectBeforeStart(page);
  await page.locator(".torrplayer-bigplay").scrollIntoViewIfNeeded();
  const toggle = await trigger(page).boundingBox();
  const play = await page.locator(".torrplayer-bigplay").boundingBox();
  await page.waitForTimeout(500);
  await page.mouse.click(play.x + play.width / 2, play.y + play.height / 2);
  await expect(page.locator(".torrplayer--embed-start")).toHaveCount(0);
  await expect.poll(() => page.locator(".torrplayer-video").evaluate((video) => video.currentTime)).toBeGreaterThan(0);
  await page.frames().find((frame) => frame.url().startsWith(FRAME_ORIGIN)).evaluate(() => { window.freeze = true; });
  await expect(page.locator(".torrplayer--embed-exposed")).toHaveCount(1, { timeout: 15_000 });
  await expect(trigger(page)).toBeHidden();
  await page.mouse.move(toggle.x + toggle.width / 2, toggle.y + toggle.height / 2);
  await expect(trigger(page)).toBeVisible();
  await trigger(page).click();
  await expect(menu(page).getByRole("button")).toHaveCount(2);
  const hitsMenu = await menu(page).getByRole("button").last().evaluate((button) => {
    const box = button.getBoundingClientRect();
    return !!document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2).closest(".torrplayer-provider-menu");
  });
  expect(hitsMenu).toBe(true);
  await menu(page).getByRole("button", { name: /Habster · Collaps/ }).click();
  await expect(trigger(page)).toContainText("Habster · Collaps");
  await expect(page.locator(".torrplayer-embed")).toHaveAttribute("src", `${FRAME_ORIGIN}/550-0-collaps`);
});
