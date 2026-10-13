import { test, expect } from "@playwright/test";

const movie = (id) => ({ id, title: `Фильм ${id}`, media_type: "movie", runtime: 100,
  release_date: "1999-01-01", vote_average: 8, genres: [], credits: { cast: [] } });
const entry = (kp, imdb) => ({ kinopoisk_id: kp, imdb_id: imdb, media_type: "movie" });

async function setup(page) {
  await page.addInitScript(() => {
    localStorage.setItem("lampa_stream_tmdb_token", "zona-test-token");
    localStorage.setItem("streambert_homeViewMode", JSON.stringify("list"));
  });
  await page.route("**/api/cub?**", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ page: 1, total_pages: 1, results: [] }) }));
  await page.route("**/api/habster?**", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ page: 1, total_pages: 1, results: [] }) }));
}

test("Zona uses exact IMDb mapping and retains its KP provenance through saving, reload and playback", async ({ page }) => {
  await setup(page);
  const item = movie(550);
  await page.route("**/api/zona?**", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({
    page: 1, total_pages: 1, results: [entry(361, "tt0137523")],
  }) }));
  const finds = [];
  await page.route("**/api/tmdb/**", (route) => {
    const url = new URL(route.request().url());
    let data = { results: [], images: {} };
    if (url.pathname.includes("/find/")) {
      finds.push(url.searchParams.get("external_source"));
      data = { movie_results: [item], tv_results: [] };
    } else if (/\/movie\/\d+$/.test(url.pathname)) data = item;
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(data) });
  });
  const queries = [];
  await page.route("**/api/source-host?op=discover", (route) => {
    const payload = route.request().postDataJSON();
    if (!payload.prepareOnly) queries.push(payload);
    return route.fulfill({ contentType: "text/event-stream", body: 'event: done\ndata: {"candidates":0,"complete":true}\n\n' });
  });
  await page.goto("/");
  await page.getByRole("region", { name: "Zona: Популярное", exact: true }).locator(".card").click();
  expect(finds).toEqual(["imdb_id"]);
  await expect(page).toHaveURL(/\/movie\/550\?catalogSource=zona$/);
  await page.getByRole("button", { name: "В избранное", exact: true }).click();
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("streambert_saved")));
  expect(saved.movie_550).toMatchObject({ catalogSource: "zona", kinopoisk_id: 361, imdb_id: "tt0137523" });
  await page.getByRole("button", { name: "Библиотека и история", exact: true }).click();
  await page.locator(".library-section .card").click();
  await page.reload();
  await page.getByRole("button", { name: "Смотреть", exact: true }).click();
  await expect.poll(() => queries.length).toBe(1);
  expect(queries[0]).toMatchObject({ catalogSource: "zona", type: "movie", tmdbId: 550, kinopoiskId: 361, imdbId: "tt0137523" });
  const history = await page.evaluate(() => JSON.parse(localStorage.getItem("streambert_history")));
  expect(history[0]).toMatchObject({ id: 550, catalogSource: "zona", kinopoisk_id: 361, imdb_id: "tt0137523" });
});

test("Zona pagination retries the same failed page and deduplicates TMDB cards", async ({ page }) => {
  await setup(page);
  const requests = [];
  let failPageTwo = true;
  await page.route("**/api/zona?**", (route) => {
    const page = Number(new URL(route.request().url()).searchParams.get("page"));
    requests.push(page);
    if (page === 2 && failPageTwo) {
      failPageTwo = false;
      return route.fulfill({ status: 502, contentType: "application/json", body: "{}" });
    }
    const results = page === 1 ? [entry(361, "tt0137523")] : [entry(361, "tt0137523"), entry(362, "tt0137524")];
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ page, total_pages: 2, results }) });
  });
  await page.route("**/api/tmdb/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(path.includes("/find/")
      ? { movie_results: [movie(path.endsWith("tt0137524") ? 551 : 550)] } : { results: [], images: {} }) });
  });
  await page.goto("/");
  const row = page.getByRole("region", { name: "Zona: Популярное", exact: true });
  await expect(row.locator(".section-title")).toHaveText("Популярное");
  await expect(row.locator(".card")).toHaveCount(1);
  await row.getByRole("button", { name: "Показать ещё", exact: true }).click();
  await expect(row.locator(".card")).toHaveCount(1);
  await row.getByRole("button", { name: "Повторить", exact: true }).click();
  await expect(row.locator(".card")).toHaveCount(2);
  await expect(row.getByRole("button", { name: "Показать ещё", exact: true })).toHaveCount(0);
  expect(requests).toEqual([1, 2, 2]);
});

test("Zona omits absent, ambiguous and wrong-type IMDb matches", async ({ page }) => {
  await setup(page);
  await page.route("**/api/zona?**", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({
    page: 1, total_pages: 1, results: [1, 2, 3, 4].map((n) => entry(9000 + n, `tt000000${n}`)), unmapped: 2,
  }) }));
  await page.route("**/api/tmdb/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    const data = path.endsWith("tt0000001") ? { movie_results: [movie(550)] }
      : path.endsWith("tt0000002") ? { movie_results: [movie(551), movie(552)] }
      : path.endsWith("tt0000003") ? { movie_results: [], tv_results: [{ id: 1396 }] }
      : { movie_results: [], results: [], images: {} };
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(data) });
  });
  await page.goto("/");
  const row = page.getByRole("region", { name: "Zona: Популярное", exact: true });
  await expect(row.locator(".card")).toHaveCount(1);
  await expect(row.getByText("Некоторые фильмы пока недоступны в каталоге: 5.", { exact: true })).toBeVisible();
});
