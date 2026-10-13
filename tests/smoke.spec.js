// E2E smoke: the web build boots, the home page renders with mocked TMDB
// data, a poster navigates to the detail page, and the player mounts. These
// cover the exact paths the perf work touches (lazy player chunks, the
// relay gate removal, the progressive grids) — a regression in any of them
// shows up here as a black screen.
import { test, expect } from "@playwright/test";

const movie = (id) => ({
  id,
  title: `Movie ${id}`,
  name: `Show ${id}`,
  poster_path: `/p${id}.jpg`,
  backdrop_path: `/b${id}.jpg`,
  vote_average: 7.5,
  release_date: "2024-01-01",
  first_air_date: "2024-01-01",
  overview: "Overview text that is long enough to look real in the UI.",
  media_type: "movie",
  original_language: "en",
  runtime: 142,
  genres: [{ id: 1, name: "Drama" }],
  credits: { cast: [] },
});

// A 1x1 GIF — the smallest decodable image, keeps the run offline and fast.
const PIXEL = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64",
);

async function mockTmdb(page, anime = false) {
  const respond = async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    let json;
    if (path.includes("/trending/")) json = { results: Array.from({ length: 20 }, (_, i) => movie(i + 1)) };
    else if (path.includes("/external_ids")) json = { imdb_id: "tt0111161" };
    else if (path.includes("/configuration")) json = { images: { secure_base_url: "https://img.tmdb.org/t/p/", poster_sizes: ["w500"] } };
    else if (/\/movie\/\d+$/.test(path)) json = movie(Number(path.split("/").pop()));
    else if (/\/tv\/\d+\/season\/\d+$/.test(path)) json = {
      season_number: Number(path.split("/").pop()),
      episodes: [1, 2, 3].map((n) => ({ id: n, episode_number: n, name: `Episode ${n}`, runtime: 45, overview: "Episode overview", still_path: `/e${n}.jpg` })),
    };
    else if (/\/tv\/\d+$/.test(path)) json = {
      ...movie(Number(path.split("/").pop())), media_type: "tv", number_of_seasons: 2,
      seasons: [1, 2].map((n) => ({ season_number: n, episode_count: 3, name: `Season ${n}` })),
    };
    else json = { results: Array.from({ length: 20 }, (_, i) => movie(i + 30)), page: 1, total_pages: 3 };
    if (anime && json.id) { json.original_language = "ja"; json.genres = [{ id: 16, name: "Анимация" }]; }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(json) });
  };
  await page.route("**/api/tmdb/**", respond);
  await page.route("https://api.themoviedb.org/**", respond);
  await page.route("**/api/source-host?**", (route) => route.fulfill({ status: 503, body: "Offline test" }));
  await page.route("**/api/cub?**", (route) => route.fulfill({
    contentType: "application/json", body: JSON.stringify({ page: 1, total_pages: 1, results: [] }),
  }));
  await page.route("**/*.jpg", (route) =>
    route.fulfill({ status: 200, contentType: "image/gif", body: PIXEL }),
  );
}

test("boots, renders the home page, navigates to a movie, mounts the player", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));

  // A fake token gets past SetupScreen; TMDB itself is mocked above.
  await page.addInitScript(() => {
    try { localStorage.setItem("lampa_stream_tmdb_token", "e2e-fake-token"); } catch {}
    localStorage.setItem("streambert_playerSource", JSON.stringify("online"));
  });
  await mockTmdb(page);

  await page.goto("/", { waitUntil: "domcontentloaded" });
  await expect(page.locator(".sidebar")).toBeVisible({ timeout: 20_000 });

  // The progressive grid reveals the first batch of cards without mounting all.
  const cards = page.locator(".carousel-item");
  await expect(cards.first()).toBeVisible({ timeout: 20_000 });
  expect(await cards.count()).toBeGreaterThan(0);

  // Click the centre (active) carousel slot → detail page.
  await page.locator(".carousel-poster-wrap").nth(2).click({ force: true });
  await expect(page.getByRole("button", { name: /Смотреть/ })).toBeVisible({ timeout: 20_000 });
  await expect(page).toHaveURL(/\/movie\/\d+$/);

  // Stub resolution so mounting the player does not depend on a live CDN.
  await page.evaluate(() => {
    window.electron.collapsResolve = async () => ({ ok: true, hls: "/test-stream.m3u8" });
  });
  await page.route("**/test-stream.m3u8", (route) => route.fulfill({
    contentType: "application/vnd.apple.mpegurl",
    body: "#EXTM3U\n#EXT-X-TARGETDURATION:1\n#EXT-X-ENDLIST\n",
  }));
  // This checks the lazy player mount, not decoded playback.
  await page.getByRole("button", { name: /Смотреть/ }).click();
  await expect(page.locator("video")).toBeVisible({ timeout: 30_000 });

  expect(errors, `unexpected page errors: ${errors.join(" | ")}`).toEqual([]);
});

test("deep-linked movie URL renders the requested movie after reload", async ({ page }) => {
  await mockTmdb(page);
  await page.addInitScript(() => {
    try { localStorage.setItem("lampa_stream_tmdb_token", "e2e-fake-token"); } catch {}
  });
  const resp = await page.goto("/movie/550", { waitUntil: "domcontentloaded" });
  expect(resp?.status()).toBe(200);
  await expect(page.getByRole("button", { name: "Смотреть", exact: true })).toBeVisible();
  await expect(page.locator(".detail-title")).toHaveText("Movie 550");
  await page.reload();
  await expect(page).toHaveURL(/\/movie\/550$/);
  await expect(page.locator(".detail-title")).toHaveText("Movie 550");
});

test("section URLs survive reload and browser back/forward", async ({ page }) => {
  await mockTmdb(page);
  await page.addInitScript(() => localStorage.setItem("lampa_stream_tmdb_token", "e2e-fake-token"));
  await page.goto("/library");
  await expect(page.getByRole("button", { name: "Библиотека и история", exact: true })).toHaveClass(/active/);
  await page.getByRole("button", { name: "Каталог", exact: true }).click();
  await expect(page).toHaveURL(/\/discover$/);
  await page.getByRole("button", { name: "Настройки", exact: true }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await page.goBack();
  await expect(page).toHaveURL(/\/discover$/);
  await expect(page.getByRole("button", { name: "Каталог", exact: true })).toHaveClass(/active/);
  await page.goForward();
  await expect(page).toHaveURL(/\/settings$/);
  await page.reload();
  await expect(page.getByRole("button", { name: "Настройки", exact: true })).toHaveClass(/active/);
  await page.getByRole("button", { name: "Назад (Ctrl+Z)", exact: true }).click();
  await expect(page).toHaveURL(/\/discover$/);
});

test("series link retains its season and episode after reload", async ({ page }) => {
  await mockTmdb(page);
  await page.addInitScript(() => localStorage.setItem("lampa_stream_tmdb_token", "e2e-fake-token"));
  await page.goto("/tv/9876?season=2&episode=3");
  await expect(page.locator(".detail-title")).toHaveText("Show 9876");
  await expect(page.getByRole("button", { name: "Сезон 2", exact: true })).toHaveClass(/active/);
  await expect(page.locator(".episode-card")).toHaveCount(3);
  await page.reload();
  await expect(page.locator(".episode-card")).toHaveCount(3);
  await expect(page).toHaveURL(/\/tv\/9876\?season=2&episode=3$/);
  await page.locator(".episode-card").nth(1).click();
  await expect(page).toHaveURL(/\/tv\/9876\?season=2&episode=2$/);
  await page.getByRole("button", { name: "Каталог", exact: true }).click();
  await page.goBack();
  await expect(page).toHaveURL(/\/tv\/9876\?season=2&episode=2$/);
  await expect(page.getByRole("button", { name: "Сезон 2", exact: true })).toHaveClass(/active/);
});

test("room invitations still open Watch Together", async ({ page }) => {
  await mockTmdb(page);
  await page.route("**/api/room**", (route) => route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Offline test" }) }));
  await page.addInitScript(() => localStorage.setItem("lampa_stream_tmdb_token", "e2e-fake-token"));
  await page.goto("/?room=ab12cd");
  await expect(page).toHaveURL(/\/together$/);
  await expect(page.getByPlaceholder("ABC123")).toHaveValue("AB12CD");
});

test("saved start page has its own URL and restores on back", async ({ page }) => {
  await mockTmdb(page);
  await page.addInitScript(() => {
    localStorage.setItem("lampa_stream_tmdb_token", "e2e-fake-token");
    localStorage.setItem("streambert_startPage", JSON.stringify("history"));
  });
  await page.goto("/");
  await expect(page).toHaveURL(/\/library$/);
  await page.getByRole("button", { name: "Каталог", exact: true }).click();
  await page.goBack();
  await expect(page).toHaveURL(/\/library$/);
  await expect(page.getByRole("button", { name: "Библиотека и история", exact: true })).toHaveClass(/active/);
});

for (const anime of [false, true]) test(`Own source discovery carries ${anime ? 'anime series' : 'movie'} matching metadata`, async ({ page }) => {
  await mockTmdb(page, anime);
  await page.addInitScript(() => {
    localStorage.setItem("lampa_stream_tmdb_token", "e2e-fake-token");
  });
  const queries = [];
  await page.route("**/api/source-host?op=discover", route => {
    queries.push(route.request().postDataJSON());
    return route.fulfill({ status: 200, contentType: "text/event-stream", body: 'event: done\ndata: {"candidates":0,"complete":true}\n\n' });
  });
  await page.goto(anime ? "/tv/60863?season=3&episode=1" : "/movie/123");
  if (anime) await page.locator(".episode-card").first().click();
  else await page.getByRole("button", { name: "Смотреть", exact: true }).click();
  await expect.poll(() => queries.some(q => q.language === (anime ? "ja" : "en"))).toBe(true);
  const query = queries.find(q => q.language === (anime ? "ja" : "en"));
  expect(query.type).toBe(anime ? "tv" : "movie");
  expect(query.anime).toBe(anime);
  expect(query.tmdbId).toBe(anime ? 60863 : 123);
  expect(Object.hasOwn(query, "catalogSource")).toBe(false);
  if (anime) expect(Object.hasOwn(query, "runtimeMinutes")).toBe(false);
  else expect(query.runtimeMinutes).toBe(142);
});
