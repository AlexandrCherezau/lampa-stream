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
  });
}

for (const type of ["movie", "tv"]) for (const catalogSource of [null, "vi3000", "habster"]) {
  test(`${type} from ${catalogSource || "TMDB"} starts on source host despite saved legacy source and allows manual choice`, async ({ page }) => {
    await setup(page);
    await page.addInitScript(() => {
      localStorage.setItem("streambert_playerSource", JSON.stringify("online"));
    });
    const item = { ...card(type === "movie" ? 550 : 1396, type), imdb_id: "tt0137523", kinopoisk_id: 361 };
    await page.route("**/api/tmdb/**", (route) => {
      const path = new URL(route.request().url()).pathname;
      const data = /\/(movie|tv)\/\d+$/.test(path) ? item
        : path.endsWith("/external_ids") ? { imdb_id: item.imdb_id }
        : path.endsWith("/season/1") ? { season_number: 1, episodes: [{ id: 1, episode_number: 1, name: "Эпизод 1", runtime: 45 }] }
        : { results: [], images: {} };
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(data) });
    });
    const queries = [];
    await page.route("**/api/source-host?op=discover", (route) => {
      const payload = route.request().postDataJSON();
      if (!payload.prepareOnly) queries.push(payload);
      return route.fulfill({ contentType: "text/event-stream", body: 'event: done\ndata: {"candidates":0,"complete":true}\n\n' });
    });
    await page.goto(`/${type}/${item.id}${catalogSource ? `?catalogSource=${catalogSource}` : ""}`);
    await expect(page.locator(".detail-title")).toHaveText(item.title || item.name);
    await page.evaluate(() => {
      window.legacyResolveCalls = 0;
      window.electron.collapsResolve = async () => {
        window.legacyResolveCalls++;
        throw new Error("Manual legacy source fixture");
      };
    });
    if (type === "movie") await page.getByRole("button", { name: "Смотреть", exact: true }).click();
    else await page.locator(".episode-card").first().click();
    await expect.poll(() => queries.length).toBe(1);
    expect(queries[0]).toMatchObject({ type, tmdbId: item.id, kinopoiskId: 361, ...(type === "tv" ? { season: 1, episode: 1 } : {}) });
    expect(queries[0].catalogSource ?? null).toBe(catalogSource);
    expect(await page.evaluate(() => window.legacyResolveCalls)).toBe(0);
    await expect(page.getByTitle("Сменить источник")).toContainText("Источники");

    await page.getByTitle("Сменить источник").click();
    await page.locator(".source-dropdown__item").filter({ hasText: "Онлайн" }).click();
    await expect.poll(() => page.evaluate(() => window.legacyResolveCalls)).toBe(1);
    await expect(page.getByTitle("Сменить источник")).toContainText("Онлайн");
    expect(queries).toHaveLength(1);
  });
}
