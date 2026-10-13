import { test, expect } from "@playwright/test";

const card = (id, media_type = "movie") => ({
  id, media_type,
  title: media_type === "movie" ? `CUB фильм ${id}` : undefined,
  name: media_type === "tv" ? `CUB сериал ${id}` : undefined,
  release_date: "2024-01-01", first_air_date: "2024-01-01",
  overview: "Описание CUB", vote_average: 7.1,
  genres: [], credits: { cast: [] }, number_of_seasons: 0, seasons: [],
});

for (const mediaType of ["movie", "tv"]) test(`CUB ${mediaType} forwards recognized provenance and exact external IDs to discovery`, async ({ page }) => {
  // Fixture models normalized CUB provenance with known TMDB/KP/IMDb IDs, not live playback evidence.
  const item = {
    ...card(mediaType === "movie" ? 550 : 1396, mediaType),
    catalogSource: "vi3000", kinopoisk_id: mediaType === "movie" ? 361 : 404900,
    imdb_id: mediaType === "movie" ? "tt0137523" : "tt0903747",
    ...(mediaType === "tv" ? { season: 2, episode: 3, number_of_seasons: 2, seasons: [{ season_number: 2, episode_count: 13, name: "Сезон 2" }] } : {}),
  };
  await page.addInitScript(() => {
    localStorage.setItem("lampa_stream_tmdb_token", "test-token");
    localStorage.setItem("streambert_homeViewMode", JSON.stringify("list"));
  });
  await page.route("**/api/cub?**", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ page: 1, total_pages: 1, results: [item] }) }));
  await page.route("**/api/tmdb/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    const data = /\/tv\/1396\/season\/2$/.test(path)
      ? { season_number: 2, episodes: [{ id: 3, episode_number: 3, name: "Эпизод 3", runtime: 45 }] }
      : /\/(movie|tv)\/\d+$/.test(path) ? { ...item, catalogSource: undefined, kinopoisk_id: undefined, imdb_id: undefined }
      : { results: [], images: {} };
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(data) });
  });
  const queries = [];
  await page.route("**/api/source-host?op=discover", (route) => {
    queries.push(route.request().postDataJSON());
    return route.fulfill({ contentType: "text/event-stream", body: 'event: done\ndata: {"candidates":0,"complete":true}\n\n' });
  });
  await page.goto("/");
  await page.getByRole("region", { name: "CUB: Сейчас смотрят", exact: true }).locator(".card").click();
  await page.getByRole("button", { name: "В избранное", exact: true }).click();
  const saved = await page.evaluate(() => JSON.parse(localStorage.getItem("streambert_saved")));
  expect(saved[`${mediaType}_${item.id}`]).toMatchObject({ catalogSource: "vi3000", kinopoisk_id: item.kinopoisk_id, imdb_id: item.imdb_id });
  await page.getByRole("button", { name: "Библиотека и история", exact: true }).click();
  await page.locator(".library-section .card").click();
  expect(new URL(page.url()).searchParams.get("catalogSource")).toBe("vi3000");
  await page.reload();
  await expect(page.locator(".detail-title")).toHaveText(item.title || item.name);
  expect(new URL(page.url()).searchParams.get("catalogSource")).toBe("vi3000");
  if (mediaType === "movie") await page.getByRole("button", { name: "Смотреть", exact: true }).click();
  else await page.locator(".episode-card").first().click();
  await expect.poll(() => queries.length).toBeGreaterThan(0);
  const query = queries[0];
  expect(query.catalogSource).toBe("vi3000");
  expect(query.tmdbId).toBe(item.id);
  expect(query.kinopoiskId).toBe(item.kinopoisk_id);
  expect(query.imdbId).toBe(item.imdb_id);
  expect(query.type).toBe(mediaType);
  if (mediaType === "tv") {
    expect(query.season).toBe(2);
    expect(query.episode).toBe(3);
  } else {
    expect(Object.hasOwn(query, "season")).toBe(false);
    expect(Object.hasOwn(query, "episode")).toBe(false);
  }
  const history = await page.evaluate(() => JSON.parse(localStorage.getItem("streambert_history")));
  expect(history[0]).toMatchObject({ id: item.id, media_type: mediaType, catalogSource: "vi3000", kinopoisk_id: item.kinopoisk_id, imdb_id: item.imdb_id });
  await page.getByRole("button", { name: "Библиотека и история", exact: true }).click();
  await page.locator(".history-row").click();
  expect(new URL(page.url()).searchParams.get("catalogSource")).toBe("vi3000");
  if (mediaType === "movie") await page.getByRole("button", { name: "Смотреть", exact: true }).click();
  else await page.locator(".episode-card").first().click();
  await expect.poll(() => queries.length).toBeGreaterThan(1);
  expect(queries.at(-1)).toMatchObject({ catalogSource: "vi3000", tmdbId: item.id, kinopoiskId: item.kinopoisk_id, imdbId: item.imdb_id,
    ...(mediaType === "tv" ? { season: 2, episode: 3 } : {}) });
});

for (const source of ["https://other.test", "vi3000"]) test(`movie URL source ${source} ignores unrelated remembered metadata`, async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("lampa_stream_tmdb_token", "test-token");
    history.replaceState({ appRoute: { page: "movie", selected: { id: 551, catalogSource: "vi3000", kinopoisk_id: 361, imdb_id: "tt0137523" } } }, "");
  });
  await page.route("**/api/tmdb/**", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(card(550)) }));
  await page.goto(`/movie/550?catalogSource=${encodeURIComponent(source)}`);
  await expect(page.locator(".detail-title")).toHaveText("CUB фильм 550");
  expect(new URL(page.url()).searchParams.get("catalogSource")).toBe(source === "vi3000" ? "vi3000" : null);
  const selected = await page.evaluate(() => history.state.appRoute.selected);
  expect(Object.hasOwn(selected, "catalogSource")).toBe(source === "vi3000");
  expect(Object.hasOwn(selected, "kinopoisk_id")).toBe(false);
  expect(Object.hasOwn(selected, "imdb_id")).toBe(false);
});

test("CUB rows keep feed pages separate, retry failures, dedupe typed IDs and navigate", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("lampa_stream_tmdb_token", "test-token");
    localStorage.setItem("streambert_homeViewMode", JSON.stringify("list"));
  });
  await page.route("**/api/tmdb/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    const match = path.match(/\/(movie|tv)\/(\d+)$/);
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(
      match ? card(Number(match[2]), match[1]) : { results: [], images: {}, credits: { cast: [] } },
    ) });
  });
  await page.route("**/api/source-host?**", (route) => route.fulfill({ status: 503, body: "Test" }));
  let latestFailed = false;
  const requests = [];
  let releaseFire;
  const firePending = new Promise((resolve) => { releaseFire = resolve; });
  let fireCancelled = false;
  page.on("requestfailed", (request) => {
    const url = new URL(request.url());
    if (url.pathname === "/api/cub" && url.searchParams.get("feed") === "fire" && url.searchParams.get("page") === "2") fireCancelled = true;
  });
  await page.route("**/api/cub?**", async (route) => {
    const query = new URL(route.request().url()).searchParams;
    const feed = query.get("feed");
    const number = Number(query.get("page"));
    requests.push(`${feed}:${number}`);
    if (feed === "fire" && number === 2) {
      await firePending;
      return;
    }
    if (feed === "latest" && !latestFailed) {
      latestFailed = true;
      return route.fulfill({ status: 502, body: "Unavailable" });
    }
    const results = feed === "now_playing"
      ? number === 1 ? [card(550), card(550, "tv")] : [card(550), card(551)]
      : [card({ latest: 552, fire: 553, hundred: 554 }[feed])];
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ page: number, total_pages: 2, results }) });
  });
  await page.goto("/");
  const now = page.getByRole("region", { name: "CUB: Сейчас смотрят", exact: true });
  const latest = page.getByRole("region", { name: "CUB: Новинки", exact: true });
  await expect(now.locator(".card")).toHaveCount(2);
  await expect(page.getByRole("region", { name: /^CUB:/ })).toHaveCount(4);
  await expect(latest.getByRole("alert")).toBeVisible();
  await latest.getByRole("button", { name: "Повторить", exact: true }).click();
  await expect(latest.locator(".card-title")).toHaveText("CUB фильм 552");
  await now.getByRole("button", { name: "Показать ещё", exact: true }).click();
  await expect(now.locator(".card")).toHaveCount(3);
  expect(requests).toContain("now_playing:2");
  expect(requests).not.toContain("latest:2");
  await page.getByRole("region", { name: "CUB: Популярное", exact: true }).getByRole("button", { name: "Показать ещё", exact: true }).click();
  await expect.poll(() => requests.includes("fire:2")).toBe(true);
  await now.getByText("CUB сериал 550", { exact: true }).click();
  await expect(page).toHaveURL(/\/tv\/550$/);
  await expect.poll(() => fireCancelled).toBe(true);
  releaseFire();
  await expect(page.locator(".detail-title")).toHaveText("CUB сериал 550");
  await page.goBack();
  const cachedNow = page.getByRole("region", { name: "CUB: Сейчас смотрят", exact: true });
  await expect(cachedNow.locator(".card")).toHaveCount(2);
  await cachedNow.getByText("CUB фильм 550", { exact: true }).click();
  await expect(page).toHaveURL(/\/movie\/550$/);
  await expect(page.locator(".detail-title")).toHaveText("CUB фильм 550");
});
