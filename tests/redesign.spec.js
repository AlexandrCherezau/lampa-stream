import { test, expect } from "@playwright/test";

const movies = Array.from({ length: 12 }, (_, i) => ({
  id: 101 + i, media_type: "movie", title: `Фильм ${i + 1}`, poster_path: `/p${i}.svg`, backdrop_path: `/b${i}.svg`,
  vote_average: 7 + i / 10, vote_count: 5000, release_date: "2020-01-01", overview: "Описание", genre_ids: [18], original_language: "en",
}));
const runtime = (id) => (id === 103 ? 200 : id % 2 ? 120 : 140);

async function fixtures(page, seed = {}) {
  await page.addInitScript((seed) => {
    localStorage.setItem("lampa_stream_tmdb_token", "redesign-test");
    localStorage.setItem("streambert_reduceAnimations", "true");
    for (const [key, value] of Object.entries(seed)) localStorage.setItem(key, JSON.stringify(value));
  }, seed);
  const requests = [];
  await page.route("**/api/**", (route) => {
    const url = new URL(route.request().url());
    requests.push(url.pathname + url.search);
    const detail = url.pathname.match(/\/movie\/(\d+)$/);
    let body = { results: [] };
    if (detail) {
      const id = Number(detail[1]);
      body = { ...movies.find((m) => m.id === id), runtime: runtime(id), genres: [{ id: 18, name: "Драма" }] };
    } else if (/trending|top_rated|recommendations|similar|discover/.test(url.pathname)) body = { page: 1, total_pages: 1, results: movies };
    else if (url.pathname.includes("/genre/")) body = { genres: [{ id: 18, name: "Драма" }] };
    return route.fulfill({ json: body });
  });
  await page.route(/\/img\/t\/p\//, (route) => route.fulfill({ contentType: "image/svg+xml", headers: { "access-control-allow-origin": "*" }, body: '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="30"><rect width="20" height="30" fill="#c33"/></svg>' }));
  return requests;
}

const endTimeAfter = (page, minutes) => page.evaluate((m) => new Date(Date.now() + m * 60000).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" }), minutes);

test.describe("home", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("arrows and side posters change the hero, the end time follows the film", async ({ page }) => {
    await fixtures(page);
    await page.clock.setFixedTime(new Date("2026-11-03T20:40:00"));
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.locator(".flow-info__title")).toHaveText("Фильм 1");
    await expect(page.locator(".flow-info__ends")).toHaveText(`Закончите в ${await endTimeAfter(page, 120)}`);
    await page.getByRole("button", { name: "Следующий фильм" }).click();
    await expect(page.locator(".flow-info__title")).toHaveText("Фильм 2");
    await expect(page.locator(".flow-info__ends")).toHaveText(`Закончите в ${await endTimeAfter(page, 140)}`);
    await page.locator(".flow-slide").nth(2).click({ force: true });
    await expect(page.locator(".flow-info__title")).toHaveText("Фильм 3");
    await page.locator(".flow-slide--active").click();
    await expect(page).toHaveURL(/\/movie\/103$/);
  });

  test("only the centre poster is a keyboard stop", async ({ page }) => {
    await fixtures(page);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.locator(".flow-slide--active").waitFor();
    await expect(page.locator('.flow-slide[tabindex="0"]')).toHaveCount(1);
    await expect(page.locator(".flow-slide--active")).toHaveAttribute("aria-label", "Открыть: Фильм 1");
  });

  test("time chips ask the catalogue for that length and drop what does not fit", async ({ page }) => {
    const requests = await fixtures(page);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    const row = page.getByRole("region", { name: "Успею сегодня" });
    await expect(row.locator(".card").first()).toBeVisible();
    await expect(row.locator(".card-title").filter({ hasText: /^Фильм 3$/ })).toHaveCount(0); // 200 minutes
    await expect(row.locator(".card-note").first()).toHaveText(/^до \d\d:\d\d$/);
    await row.getByRole("button", { name: "Около 2 часов" }).click();
    await expect(row.getByRole("button", { name: "Около 2 часов" })).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => requests.some((r) => r.includes("with_runtime.lte=125"))).toBe(true);
    await expect(row.locator(".card").first()).toBeVisible();
    await expect(row.locator(".card-title").filter({ hasText: /^Фильм 2$/ })).toHaveCount(0); // 140 minutes
    await expect(row.locator(".card-title").filter({ hasText: /^Фильм 1$/ })).toHaveCount(1); // 120 minutes
  });

  test("a collection opens the catalogue with its genre selected", async ({ page }) => {
    const requests = await fixtures(page);
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.locator(".deck", { hasText: "Сильные драмы" }).click();
    await expect(page).toHaveURL(/\/discover$/);
    await expect.poll(() => requests.some((r) => r.includes("/discover/movie") && r.includes("with_genres=18") && r.includes("page=1"))).toBe(true);
    await expect(page.locator(".cards-grid .card").first()).toBeVisible();
  });

  test("saved titles open from a popover in the bar", async ({ page }) => {
    await fixtures(page, { streambert_saved: { movie_101: movies[0], movie_102: movies[1] } });
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await expect(page.locator(".sidebar-saved")).toBeHidden();
    await page.getByRole("button", { name: "Сохранённое" }).click();
    await expect(page.locator(".sidebar-saved")).toBeVisible();
    await page.mouse.click(700, 500);
    await expect(page.locator(".sidebar-saved")).toBeHidden();
    await page.getByRole("button", { name: "Сохранённое" }).click();
    await page.locator(".sidebar-saved .saved-thumb").first().click();
    await expect(page).toHaveURL(/\/movie\/10\d$/);
    await expect(page.locator(".sidebar-saved")).toBeHidden();
  });
});

test.describe("movie page", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("promises the saved position and the end time from it", async ({ page }) => {
    await fixtures(page, { streambert_progress: { movie_101: 32 }, streambert_resumeTime: { movie_101: 2890 } });
    await page.goto("/movie/101", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("button", { name: "Смотреть с 48:10" })).toBeVisible();
    await expect(page.locator(".detail-stats")).toContainText(await endTimeAfter(page, 82));
    await expect(page.locator(".detail-stats")).toContainText("осталось 1 ч 22 мин");
  });

  test("without an exact position the button makes no timecode promise", async ({ page }) => {
    await fixtures(page, { streambert_progress: { movie_101: 32 } });
    await page.goto("/movie/101", { waitUntil: "domcontentloaded" });
    await expect(page.getByRole("button", { name: "Смотреть", exact: true })).toBeVisible();
  });
});

test("with an age limit, restricted films stay out of the hero, the time row and collections", async ({ page }) => {
  await fixtures(page, { streambert_ageLimit: 13 });
  await page.route(/\/api\/.*\/movie\/\d+\/release_dates/, (route) => {
    const id = Number(route.request().url().match(/movie\/(\d+)/)[1]);
    const certification = id === 101 ? "R" : "PG";
    return route.fulfill({ json: { results: [{ iso_3166_1: "US", release_dates: [{ certification, type: 3 }] }] } });
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator(".flow-info__title")).toHaveText("Фильм 2");
  await expect(page.locator('.flow-slide[aria-label$=": Фильм 1"]')).toHaveCount(0);
  const row = page.getByRole("region", { name: "Успею сегодня" });
  await expect(row.locator(".card").first()).toBeVisible();
  await expect(row.locator(".card-title").filter({ hasText: /^Фильм 1$/ })).toHaveCount(0);
  await expect(page.locator(".deck").first()).toBeVisible();
  // The R-rated poster /p0.svg must not be in any fan.
  await expect(page.locator('.deck__fan img[src$="/p0.svg"]')).toHaveCount(0);
});

test("a film marked as watched is not offered as a resume in the hero", async ({ page }) => {
  await fixtures(page, { streambert_progress: { movie_101: 40 }, streambert_watched: { movie_101: true } });
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator(".flow-info__title")).toHaveText("Фильм 1");
  await expect(page.locator(".flow-info__actions .btn-primary")).toHaveText(/Смотреть/);
});

test("the top bar fits a tablet: settings stay on screen", async ({ page }) => {
  await fixtures(page, { streambert_saved: { movie_101: movies[0] } });
  for (const width of [769, 810, 981, 1100]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto("/movie/101", { waitUntil: "domcontentloaded" });
    const settings = await page.getByRole("button", { name: "Настройки" }).last().boundingBox();
    expect(settings.x + settings.width).toBeLessThanOrEqual(width);
  }
});

test("the series page shows its poster after loading", async ({ page }) => {
  await fixtures(page);
  await page.route(/\/api\/.*\/tv\/\d+(\?|$)/, (route) => route.fulfill({ json: { ...movies[0], id: 201, name: "Сериал", title: undefined, media_type: "tv", number_of_seasons: 1, seasons: [{ season_number: 1, name: "Сезон 1", episode_count: 1 }], genres: [] } }));
  await page.goto("/tv/201", { waitUntil: "domcontentloaded" });
  await expect(page.locator(".detail-poster img")).toBeVisible();
});

test("a phone on its side reaches the hero button without scrolling", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true, serviceWorkers: "block" });
  const page = await context.newPage();
  await fixtures(page);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const button = await page.locator(".flow-info__actions .btn-primary").boundingBox();
  const dock = await page.locator(".sidebar").boundingBox();
  expect(button.y + button.height).toBeLessThanOrEqual(dock.y);
  await context.close();
});

test("a phone swipe changes the hero", async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, serviceWorkers: "block" });
  const page = await context.newPage();
  await fixtures(page);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator(".flow-info__title")).toHaveText("Фильм 1");
  await page.locator(".flow-stage").evaluate((stage) => {
    const touch = (x) => new Touch({ identifier: 1, target: stage, clientX: x, clientY: 200 });
    stage.dispatchEvent(new TouchEvent("touchstart", { bubbles: true, touches: [touch(300)] }));
    stage.dispatchEvent(new TouchEvent("touchend", { bubbles: true, changedTouches: [touch(120)] }));
  });
  await expect(page.locator(".flow-info__title")).toHaveText("Фильм 2");
  await context.close();
});
