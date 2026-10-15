import { test, expect } from "@playwright/test";

test.use({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });

test("mobile recap shares a real PNG file and keeps reduced-motion and keyboard behavior", async ({ page }) => {
  const now = Date.now();
  const longTitle = "A Very Long Feature Film Title That Must Remain Readable in the Shared Monthly Cinema Recap Card";
  await page.addInitScript(({ now, longTitle }) => {
    localStorage.setItem("streambert_viewingData", JSON.stringify({
      revision: 0,
      recordingStartedAt: now - 86_400_000,
      checkpoints: {},
      sessions: {
        "e2e-session": {
          sessionId: "e2e-session",
          progressKey: "movie_9821",
          item: { type: "movie", id: "9821", title: longTitle, genres: [{ id: 18, name: "Драма" }] },
          segments: [{ start: now - 3_600_000, end: now - 1_200_000 }],
        },
      },
      library: {
        saved: {}, watched: {}, history: {},
        ratings: {
          movie_9821: { value: { score: 9, ratedAt: now, item: { type: "movie", id: "9821", title: longTitle } }, revision: 1 },
        },
      },
    }));
    Object.defineProperty(navigator, "canShare", { configurable: true, value: ({ files }) => Array.isArray(files) && files.some((file) => file.type === "image/png") });
    Object.defineProperty(navigator, "share", { configurable: true, value: async ({ files }) => {
      const file = files?.find((entry) => entry.type === "image/png");
      if (!file) throw new Error("PNG file missing");
      const header = Array.from(new Uint8Array(await file.slice(0, 8).arrayBuffer()));
      window.__sharedRecap = { name: file.name, type: file.type, size: file.size, header };
    } });
  }, { now, longTitle });

  await page.goto("/recap", { waitUntil: "domcontentloaded" });
  const skip = page.getByRole("button", { name: "Skip for now" });
  if (await skip.isVisible().catch(() => false)) await skip.click();
  await expect(page.getByRole("heading", { name: "Киноитоги" })).toBeVisible();
  await expect(page.getByText("Лучшие оценки")).toBeVisible();
  await expect(page.getByText(/9\/10/)).toBeVisible();

  const actionButton = page.getByRole("button", { name: "Поделиться" });
  await actionButton.focus();
  await page.keyboard.press("Enter");
  await expect.poll(() => page.evaluate(() => window.__sharedRecap?.size || 0)).toBeGreaterThan(1000);
  const shared = await page.evaluate(() => window.__sharedRecap);
  expect(shared.name).toMatch(/\.png$/);
  expect(shared.type).toBe("image/png");
  expect(shared.header).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);

  const reducedMotionTransition = await page.locator(".personal-page button").first().evaluate((element) => getComputedStyle(element).transitionDuration);
  expect(parseFloat(reducedMotionTransition)).toBeLessThanOrEqual(0.001);
});
