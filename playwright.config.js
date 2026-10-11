import { defineConfig, devices } from "@playwright/test";

// E2E smoke for the web build. The app is served by `npm run web:serve`
// (server/index.mjs on :3000) against a production `dist/` build — the same
// contract production has, not a dev server.
export default defineConfig({
  testDir: "./tests",
  timeout: 60_000,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  use: {
    headless: true,
    baseURL: "http://localhost:3000",
    // Network mocks must handle requests instead of the production SW cache.
    serviceWorkers: "block",
    launchOptions: {
      // The Chromium that ships with the environment (no browser download).
      executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined,
      args: ["--no-sandbox"],
    },
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "npm run build && npm run web:serve",
    url: "http://localhost:3000",
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
