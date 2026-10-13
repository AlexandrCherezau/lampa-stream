import { test, expect } from "@playwright/test";

const card = (id, media_type = "movie") => ({
  id, media_type,
  title: media_type === "movie" ? `CUB фильм ${id}` : undefined,
  name: media_type === "tv" ? `CUB сериал ${id}` : undefined,
  release_date: "2024-01-01", first_air_date: "2024-01-01",
  overview: "Описание CUB", vote_average: 7.1,
  genres: [], credits: { cast: [] }, number_of_seasons: 0, seasons: [],
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

for (const source of ["vi3000", "habster", "zona"]) {
  test(`${source} saved movie keeps provenance through library, reload, playback and history`, async ({ page }) => {
    const id = 550;
    const type = "movie";
    const title = "Бойцовский клуб";
    const kp = 361;
    const imdb = "tt0137523";
    const savedKey = `${type}_${id}`;
    const savedItem = {
      id,
      title,
      poster_path: "/poster.jpg",
      media_type: type,
      vote_average: 8,
      year: "1999",
      catalogSource: source,
      kinopoisk_id: kp,
      imdb_id: imdb,
    };
    await page.addInitScript(({ savedKey, savedItem }) => {
      localStorage.setItem("lampa_stream_tmdb_token", "test-token");
      localStorage.setItem("streambert_saved", JSON.stringify({ [savedKey]: savedItem }));
      localStorage.setItem("streambert_savedOrder", JSON.stringify([savedKey]));
    }, { savedKey, savedItem });
    await page.route("**/api/tmdb/**", (route) => {
      const path = new URL(route.request().url()).pathname;
      const data = /\/movie\/\d+$/.test(path)
        ? {
            ...card(id),
            title,
            catalogSource: undefined,
            kinopoisk_id: undefined,
            imdb_id: undefined,
          }
        : { results: [], images: {} };
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(data) });
    });
    const queries = [];
    await page.route("**/api/source-host?op=discover", (route) => {
      const payload = route.request().postDataJSON();
      if (!payload.prepareOnly) queries.push(payload);
      return route.fulfill({ contentType: "text/event-stream", body: 'event: done\ndata: {"candidates":0,"complete":true}\n\n' });
    });

    await page.goto("/");
    await page.getByRole("button", { name: "Библиотека и история", exact: true }).click();
    await page.locator(".library-section .card").click();
    await expect(page).toHaveURL(new RegExp(`/movie/${id}\\?catalogSource=${source}$`));
    await page.reload();
    await expect(page.locator(".detail-title")).toHaveText(title);
    await page.getByRole("button", { name: "Смотреть", exact: true }).click();

    await expect.poll(() => queries.length).toBe(1);
    expect(queries[0]).toMatchObject({
      catalogSource: source,
      type,
      tmdbId: id,
      kinopoiskId: kp,
      imdbId: imdb,
    });
    const history = await page.evaluate(() => JSON.parse(localStorage.getItem("streambert_history")));
    expect(history[0]).toMatchObject({ id, media_type: type, catalogSource: source, kinopoisk_id: kp, imdb_id: imdb });
  });
}
