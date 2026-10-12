import { test, expect } from "@playwright/test";

async function openSearch(page, respond) {
  await page.addInitScript(() => localStorage.setItem("lampa_stream_tmdb_token", "e2e-fake-token"));
  await page.route("**/api/tmdb/**", respond);
  await page.route("https://api.themoviedb.org/**", respond);
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: /Поиск/ }).click();
  return page.getByPlaceholder("Поиск фильмов и сериалов...");
}

test("search drops stale results on query changes and failures, and clears loading", async ({ page }) => {
  const failedRequests = [];
  page.on("requestfailed", (request) => failedRequests.push(request.url()));
  let releasePending;
  const pendingResponse = new Promise((resolve) => { releasePending = resolve; });
  const requests = [];
  const input = await openSearch(page, async (route) => {
    const url = new URL(route.request().url());
    if (!url.pathname.includes("/search/multi")) {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ results: [] }) });
      return;
    }
    const query = url.searchParams.get("query");
    requests.push(query);
    if (query === "alpha") {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ results: [{ id: 1, title: "Alpha stale", media_type: "movie" }] }) });
    } else if (query === "pending") {
      await pendingResponse;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ results: [] }) });
    } else {
      await route.fulfill({ status: 503, body: "Unavailable" });
    }
  });

  await input.fill("alpha");
  await expect.poll(() => requests).toContain("alpha");
  await expect(page.getByText("Alpha stale")).toBeVisible();
  await page.clock.install();
  await input.fill("beta");
  await expect(page.locator(".loader")).toBeVisible();
  await expect(page.getByText("Alpha stale")).toHaveCount(0);
  await expect(page.getByText("По запросу «beta» ничего не найдено")).toHaveCount(0);
  expect(requests).not.toContain("beta");
  await page.clock.runFor(381);
  await expect.poll(() => requests).toContain("beta");
  await expect(page.getByText("Поиск временно недоступен. Попробуйте ещё раз.")).toBeVisible();
  await expect(page.getByText("По запросу «beta» ничего не найдено")).toHaveCount(0);

  await input.fill("pending");
  await page.clock.runFor(381);
  await expect(page.locator(".loader")).toBeVisible();
  await input.fill("");
  await expect(page.locator(".loader")).toHaveCount(0);
  await expect(page.locator(".search-results .search-result")).toHaveCount(0);
  await expect.poll(() => failedRequests.some((url) => url.includes("pending"))).toBe(true);
  releasePending();
});
