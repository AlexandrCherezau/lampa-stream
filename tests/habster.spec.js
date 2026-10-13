import { test, expect } from "@playwright/test";

const card = (id, media_type) => ({
  id, media_type, ...(media_type === "movie" ? { title: "Бойцовский клуб" } : { name: "Во все тяжкие" }),
  release_date: "1999-01-01", first_air_date: "2008-01-01", vote_average: 8,
  overview: "Описание", genres: [], credits: { cast: [] }, runtime: 139,
  number_of_seasons: 1, seasons: [{ season_number: 1, episode_count: 1, name: "Сезон 1" }],
});

async function setup(page) {
  await page.addInitScript(() => {
    localStorage.setItem("lampa_stream_tmdb_token", "habster-test-token");
    localStorage.setItem("streambert_homeViewMode", JSON.stringify("list"));
  });
  await page.route("**/api/cub?**", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ page: 1, total_pages: 1, results: [] }) }));
}

for (const type of ["movie", "tv"]) test(`Habster exact IMDb mapping keeps ${type} KP provenance through saved, reload and discovery`, async ({ page }) => {
  await setup(page);
  const item = card(type === "movie" ? 550 : 1396, type);
  const kp = type === "movie" ? 361 : 404900;
  const imdb = type === "movie" ? "tt0137523" : "tt0903747";
  await page.route("**/api/habster?**", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({
    page: 1, total_pages: 1, results: [{ kinopoisk_id: kp, imdb_id: imdb, media_type: type }],
  }) }));
  const finds = [];
  await page.route("**/api/tmdb/**", (route) => {
    const url = new URL(route.request().url());
    let data = { results: [], images: {} };
    if (url.pathname.includes("/find/")) {
      finds.push(url.searchParams.get("external_source"));
      data = { movie_results: type === "movie" ? [item] : [], tv_results: type === "tv" ? [item] : [] };
    } else if (/\/(movie|tv)\/\d+$/.test(url.pathname)) data = item;
    else if (url.pathname.endsWith("/season/1")) data = { season_number: 1, episodes: [{ id: 1, episode_number: 1, name: "Эпизод 1", runtime: 45 }] };
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(data) });
  });
  const queries = [];
  await page.route("**/api/source-host?op=discover", (route) => {
    queries.push(route.request().postDataJSON());
    return route.fulfill({ contentType: "text/event-stream", body: 'event: done\ndata: {"candidates":0,"complete":true}\n\n' });
  });
  await page.goto("/");
  await page.getByRole("region", { name: "Habster: Популярное", exact: true }).locator(".card").click();
  expect(finds).toEqual(["imdb_id"]);
  await expect(page).toHaveURL(new RegExp(`/${type}/${item.id}\\?catalogSource=habster$`));
  await page.getByRole("button", { name: "В избранное", exact: true }).click();
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("streambert_saved")));
  expect(saved[`${type}_${item.id}`]).toMatchObject({ catalogSource: "habster", kinopoisk_id: kp, imdb_id: imdb });
  await page.getByRole("button", { name: "Библиотека и история", exact: true }).click();
  await page.locator(".library-section .card").click();
  await page.reload();
  await expect(page.locator(".detail-title")).toHaveText(item.title || item.name);
  if (type === "movie") await page.getByRole("button", { name: "Смотреть", exact: true }).click();
  else await page.locator(".episode-card").first().click();
  await expect.poll(() => queries.length).toBeGreaterThan(0);
  expect(queries[0]).toMatchObject({ catalogSource: "habster", tmdbId: item.id, kinopoiskId: kp, imdbId: imdb, type });
  const history = await page.evaluate(() => JSON.parse(localStorage.getItem("streambert_history")));
  expect(history[0]).toMatchObject({ id: item.id, media_type: type, catalogSource: "habster", kinopoisk_id: kp, imdb_id: imdb });
});

test("Habster skips absent, ambiguous and wrong-type mappings instead of treating KP IDs as TMDB IDs", async ({ page }) => {
  await setup(page);
  const entries = [1, 2, 3, 4].map((n) => ({ kinopoisk_id: 9000 + n, imdb_id: `tt000000${n}`, media_type: "movie" }));
  await page.route("**/api/habster?**", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({
    page: 1, total_pages: 1, unmapped: 2, results: entries,
  }) }));
  await page.route("**/api/tmdb/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    const result = path.endsWith("tt0000001") ? { movie_results: [card(550, "movie")] }
      : path.endsWith("tt0000002") ? { movie_results: [card(551, "movie"), card(552, "movie")] }
      : path.endsWith("tt0000003") ? { movie_results: [], tv_results: [card(1396, "tv")] }
      : { movie_results: [], results: [], images: {} };
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(result) });
  });
  await page.goto("/");
  const row = page.getByRole("region", { name: "Habster: Популярное", exact: true });
  await expect(row.locator(".card")).toHaveCount(1);
  await expect(row.getByText("Некоторые фильмы пока недоступны в каталоге: 5.", { exact: true })).toBeVisible();
});

test("Habster retries a failed catalog request without caching the failure", async ({ page }) => {
  await setup(page);
  let requests = 0;
  await page.route("**/api/habster?**", (route) => {
    requests++;
    return route.fulfill({ status: requests === 1 ? 502 : 200, contentType: "application/json", body: JSON.stringify({ page: 1, total_pages: 1, results: [] }) });
  });
  await page.route("**/api/tmdb/**", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ results: [], images: {} }) }));
  await page.goto("/");
  const row = page.getByRole("region", { name: "Habster: Популярное", exact: true });
  await row.getByRole("button", { name: "Повторить", exact: true }).click();
  await expect(row.getByText("В подборке пока нет фильмов.", { exact: true })).toBeVisible();
  expect(requests).toBe(2);
});
