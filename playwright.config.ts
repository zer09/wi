import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 8_000 },
  retries: process.env.CI === "true" ? 1 : 0,
  reporter: process.env.CI === "true" ? [["line"], ["html", { open: "never" }]] : "line",
  use: {
    ...devices["Desktop Chrome"],
    // Network traces can retain the HttpOnly bootstrap cookie, so they are disabled by policy.
    trace: "off",
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
