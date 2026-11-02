import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect } from "@playwright/test";

const longTitle = "Невероятное путешествие: история длиною в целую жизнь";
const overview = "История о дружбе, новых открытиях и большом путешествии. ".repeat(4);
const movies = Array.from({ length: 12 }, (_, i) => ({
  id: 101 + i, media_type: "movie", title: i === 0 ? longTitle : `Фильм ${i + 1}`, poster_path: "/p.svg", backdrop_path: "/b.svg",
  vote_average: 8.2, release_date: "2025-01-01", overview, genre_ids: [12], original_language: "en",
}));
const shows = movies.map((m, i) => ({ ...m, id: 201 + i, media_type: "tv", name: `Сериал ${i + 1}`, title: undefined, first_air_date: "2024-01-01" }));

let hlsDir;
test.beforeAll(() => {
  hlsDir = mkdtempSync(join(tmpdir(), "streambert-mobile-"));
  execFileSync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=teal:s=320x134:r=10:d=30",
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-g", "20", "-sc_threshold", "0",
    "-hls_time", "2", "-hls_list_size", "0", "-hls_segment_filename", join(hlsDir, "seg%03d.ts"), join(hlsDir, "v.m3u8"),
  ]);
});
test.afterAll(() => { if (hlsDir) rmSync(hlsDir, { recursive: true, force: true }); });

async function fixtures(page, { token = true } = {}) {
  await page.addInitScript(({ movies, token }) => {
    if (token) localStorage.setItem("lampa_stream_tmdb_token", "layout-test");
    localStorage.setItem("streambert_reduceAnimations", "true");
    localStorage.setItem("streambert_playerSource", JSON.stringify("lampac"));
    localStorage.setItem("streambert_history", JSON.stringify(movies.slice(0, 6).map((m) => ({ ...m, watchedAt: Date.now() }))));
    localStorage.setItem("streambert_saved", JSON.stringify(movies.slice(0, 4)));
    localStorage.setItem("streambert_progress", JSON.stringify({ movie_101: 42 }));
  }, { movies, token });
  await page.route("**/api/**", (route) => {
    const { pathname: p } = new URL(route.request().url());
    let body = {};
    if (p.includes("/season/")) body = { episodes: Array.from({ length: 8 }, (_, i) => ({ id: 1000 + i, episode_number: i + 1, name: longTitle, overview, still_path: "/p.svg", air_date: "2025-01-01", runtime: 45 })) };
    else if (/\/(movie|tv)\/\d+$/.test(p)) {
      body = { ...(p.includes("/tv/") ? shows[0] : movies[0]), runtime: 148, genres: [{ id: 12, name: "Приключения" }], number_of_seasons: 8, external_ids: {},
        seasons: Array.from({ length: 8 }, (_, i) => ({ season_number: i + 1, name: `Сезон ${i + 1}`, episode_count: 8 })) };
    } else if (p.includes("/genre/")) body = { genres: [{ id: 12, name: "Приключения" }] };
    else if (/trending/.test(p)) body = { results: [...movies, ...shows] };
    else if (/\/search\//.test(p)) body = { results: [movies[0], shows[0]] };
    else if (/discover|top_rated|recommendations|similar|popular|now_playing|on_the_air/.test(p)) body = { page: 1, total_pages: 25, results: p.includes("/tv") ? shows : movies };
    else if (/release_dates|content_ratings|videos/.test(p)) body = { results: [] };
    return route.fulfill({ json: body });
  });
  await page.route("**/api/source-host?op=discover", (route) => route.fulfill({
    status: 200, contentType: "text/event-stream",
    body: `event: candidate\ndata: ${JSON.stringify({ id: "a", providerId: "habster:alloha", providerName: "Habster · Alloha", voiceId: "v", voiceName: "Многоголосый" })}\n\nevent: done\ndata: {}\n\n`,
  }));
  await page.route("**/api/source-host?op=resolve", (route) => route.fulfill({ json: {
    kind: "hls", selected: { url: "https://media.test/v.m3u8", label: "720p" }, qualities: [{ label: "720p", height: 720 }], subtitles: [], audioNames: [],
  } }));
  await page.route("https://media.test/**", (route) => {
    const file = new URL(route.request().url()).pathname.split("/").pop();
    return route.fulfill({ status: 200, contentType: file.endsWith(".ts") ? "video/mp2t" : "application/vnd.apple.mpegurl", body: readFileSync(join(hlsDir, file)) });
  });
}

// #root clips horizontally, so an overflow never reaches the document: measure the
// scroller itself, and treat only clipping below it as intentional.
const overflowing = (page) => page.evaluate(() => {
  const main = document.querySelector(".main");
  const clipped = (el) => {
    for (let a = el.parentElement; a && a !== main && a !== document.body; a = a.parentElement) {
      if (["auto", "scroll", "hidden", "clip"].includes(getComputedStyle(a).overflowX)) return true;
    }
    return false;
  };
  const found = [...document.querySelectorAll(".main *")].filter((el) => {
    const style = getComputedStyle(el);
    const box = el.getBoundingClientRect();
    if (style.display === "none" || style.visibility === "hidden" || !box.width || !box.height || box.left < -5000) return false;
    return (box.right > innerWidth + 1 || box.left < -1) && style.position !== "fixed" && !el.closest("svg") && !clipped(el);
  }).map((el) => `${el.tagName}.${String(el.className).slice(0, 40)}`);
  return { page: main ? main.scrollWidth - main.clientWidth : 0, elements: [...new Set(found)].slice(0, 8) };
});

test("the overflow check catches content wider than the screen", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 568 });
  await fixtures(page);
  await page.goto("/discover", { waitUntil: "domcontentloaded" });
  await page.locator(".discover-filters").waitFor();
  await page.evaluate(() => { document.querySelector(".discover-filters").parentElement.insertAdjacentHTML("beforeend", '<div style="width:900px;height:10px"></div>'); });
  expect((await overflowing(page)).page).toBeGreaterThan(0);
});

const screens = [
  ["home", "/", ".carousel-item--active"],
  ["catalog", "/discover", ".cards-grid .card"],
  ["movie", "/movie/101", ".detail-title"],
  ["series", "/tv/201", ".episode-card"],
  ["library", "/library", ".library-title"],
  ["downloads", "/downloads", ".dl-page__title"],
  ["together", "/together", ".wt-landing"],
  ["tonight", "/tonight", ".personal-page"],
  ["recap", "/recap", ".personal-page"],
  ["devices", "/devices", ".personal-page"],
  ["settings", "/settings", ".settings-content"],
];

for (const [width, height] of [[320, 740], [390, 844], [844, 390]]) {
  test.describe(`${width}x${height}`, () => {
    test.use({ viewport: { width, height }, isMobile: true, hasTouch: true });

    for (const [name, url, ready] of screens) test(`${name} fits the screen`, async ({ page }) => {
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await fixtures(page);
      await page.goto(url, { waitUntil: "domcontentloaded" });
      await page.locator(ready).first().waitFor();
      await page.waitForTimeout(300);
      expect(await overflowing(page)).toEqual({ page: 0, elements: [] });
      expect(errors).toEqual([]);
    });

    test("first launch fits the screen", async ({ page }) => {
      await fixtures(page, { token: false });
      await page.goto("/", { waitUntil: "domcontentloaded" });
      await page.locator(".apikey-input").waitFor();
      expect(await overflowing(page)).toEqual({ page: 0, elements: [] });
    });

    test("playing a movie pins the player under the top bar with labelled controls", async ({ page }) => {
      await fixtures(page);
      await page.goto("/movie/101", { waitUntil: "domcontentloaded" });
      const watch = page.getByRole("button", { name: "Смотреть", exact: true });
      await watch.waitFor();
      await watch.scrollIntoViewIfNeeded();
      const box = await watch.boundingBox();
      expect(box.y + box.height).toBeLessThanOrEqual(height - 48);
      expect(box.height).toBeGreaterThanOrEqual(44);
      await watch.tap();
      const video = page.locator(".torrplayer-stage video");
      await expect.poll(() => video.evaluate((v) => !v.paused && v.currentTime > 0)).toBe(true);
      const bar = await page.locator(".mobile-topbar").boundingBox();
      const pinned = async () => {
        const wrap = await page.locator(".player-wrap").boundingBox();
        return wrap.y >= bar.y + bar.height - 1 && wrap.y <= bar.y + bar.height + 40;
      };
      await expect.poll(pinned).toBe(true);
      // Between the bars, or the dock covers the controls.
      const dock = await page.locator(".sidebar").boundingBox();
      const wrap = await page.locator(".player-wrap").boundingBox();
      expect(wrap.y + wrap.height).toBeLessThanOrEqual(dock.y + 1);
      expect(await overflowing(page)).toEqual({ page: 0, elements: [] });
    });
  });
}

test.describe("phone details", () => {
  test.use({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true });

  test("the play button comes before the description and ratings are thumb-sized", async ({ page }) => {
    await fixtures(page);
    await page.goto("/movie/101", { waitUntil: "domcontentloaded" });
    const watch = await page.getByRole("button", { name: "Смотреть", exact: true }).boundingBox();
    const text = await page.locator(".detail-overview").boundingBox();
    expect(watch.y).toBeLessThan(text.y);
    expect(watch.y + watch.height).toBeLessThan(812);
    const score = await page.getByRole("button", { name: "1 из 10" }).boundingBox();
    expect(score.height).toBeGreaterThanOrEqual(44);
    expect(score.width).toBeGreaterThanOrEqual(44);
  });

  test("a prebuffered start also pins the player under the top bar", async ({ page }) => {
    await fixtures(page);
    await page.goto("/movie/101", { waitUntil: "domcontentloaded" });
    const watch = page.getByRole("button", { name: "Смотреть", exact: true });
    await watch.waitFor();
    await expect.poll(() => page.evaluate(() => document.querySelector("video")?.buffered.length > 0)).toBe(true);
    await watch.tap();
    const bar = await page.locator(".mobile-topbar").boundingBox();
    await expect.poll(async () => Math.round((await page.locator(".player-wrap").boundingBox()).y - bar.height)).toBeLessThanOrEqual(40);
  });

  test("the player keeps a readable time and quality in portrait", async ({ page }) => {
    await fixtures(page);
    await page.goto("/movie/101", { waitUntil: "domcontentloaded" });
    await page.getByRole("button", { name: "Смотреть", exact: true }).tap();
    const video = page.locator(".torrplayer-stage video");
    await expect.poll(() => video.evaluate((v) => !v.paused && v.currentTime > 0)).toBe(true);
    await video.tap();
    await expect(page.locator(".torrplayer-time")).toBeVisible();
    await expect(page.locator(".torrplayer-controls").getByText("720p")).toBeVisible();
    await expect(page.locator(".torrplayer-btn--pip")).toBeHidden();
  });

  test("the dock names every tab and marks the current one", async ({ page }) => {
    await fixtures(page);
    await page.goto("/discover", { waitUntil: "domcontentloaded" });
    const nav = page.getByRole("navigation", { name: "Основная навигация" });
    for (const label of ["Главная", "Каталог", "Вместе", "Библиотека", "Загрузки"]) await expect(nav.locator(".sidebar-label", { hasText: label })).toBeVisible();
    await expect(nav.getByRole("button", { name: "Каталог", exact: true })).toHaveAttribute("aria-current", "page");
  });
});

test.describe("phone series", () => {
  test.use({ viewport: { width: 320, height: 568 }, isMobile: true, hasTouch: true });

  test("the episode header fits at 320 px while playing", async ({ page }) => {
    await fixtures(page);
    await page.goto("/tv/201", { waitUntil: "domcontentloaded" });
    await page.locator(".episode-card").first().tap();
    await page.locator(".torrplayer-stage video").waitFor();
    await page.waitForTimeout(300);
    expect(await overflowing(page)).toEqual({ page: 0, elements: [] });
  });
});

test.describe("landscape settings", () => {
  test.use({ viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true });

  test("search keeps the current match visible", async ({ page }) => {
    await fixtures(page);
    await page.goto("/settings", { waitUntil: "domcontentloaded" });
    await page.locator(".settings-search-toggle").tap();
    await page.getByRole("textbox", { name: "Поиск по настройкам" }).fill("Субтитр");
    await page.waitForTimeout(500);
    const bar = await page.locator(".settings-topbar").boundingBox();
    // The match is scrolled to the middle of the screen; the bar must end above it.
    expect(bar.y + bar.height).toBeLessThan(390 / 2 - 20);
  });
});

test.describe("desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("keeps the sidebar without phone chrome", async ({ page }) => {
    await fixtures(page);
    await page.goto("/discover", { waitUntil: "domcontentloaded" });
    await page.locator(".cards-grid .card").first().waitFor();
    await expect(page.locator(".mobile-topbar")).toBeHidden();
    await expect(page.locator(".sidebar-label").first()).toBeHidden();
    expect(await overflowing(page)).toEqual({ page: 0, elements: [] });
  });
});
