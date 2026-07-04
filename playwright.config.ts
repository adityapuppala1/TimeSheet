/**
 * Root-level Playwright config — this suite drives the real web app (Vite dev server)
 * against the real API (Express dev server), both started automatically via `webServer`.
 *
 * WHY Chromium-only, with custom viewport sizes instead of Playwright's built-in device
 * presets: the user explicitly asked to test "using chrome browser" across phone/tablet/
 * laptop/desktop/4K. Playwright's iPhone/iPad presets default to the WebKit engine (to
 * emulate Safari faithfully); defining our own viewport sizes on the Chromium engine keeps
 * every project on the same browser while still covering the full size range.
 *
 * WHY `workers: 1` / `fullyParallel: false`: specs share the same seeded MySQL database
 * (no per-test DB isolation), so running them concurrently risks one test's cleanup racing
 * another test's setup. Simpler and more reliable to run serially for now.
 */
import { defineConfig, devices } from "@playwright/test";

const VIEWPORTS = {
  phone: { width: 390, height: 844 }, // iPhone 14-ish
  tablet: { width: 768, height: 1024 }, // iPad portrait
  laptop: { width: 1366, height: 768 },
  desktop: { width: 1920, height: 1080 },
  uhd4k: { width: 3840, height: 2160 }
};

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report" }]],
  timeout: 30_000,
  use: {
    baseURL: "http://localhost:5173",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure"
  },
  projects: [
    { name: "setup", testMatch: /.*\.setup\.ts/ },
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"], viewport: VIEWPORTS.desktop },
      dependencies: ["setup"]
    },
    {
      name: "responsive-phone",
      use: { ...devices["Desktop Chrome"], viewport: VIEWPORTS.phone, isMobile: true, hasTouch: true },
      dependencies: ["setup"],
      testMatch: /responsive\.spec\.ts/
    },
    {
      name: "responsive-tablet",
      use: { ...devices["Desktop Chrome"], viewport: VIEWPORTS.tablet, hasTouch: true },
      dependencies: ["setup"],
      testMatch: /responsive\.spec\.ts/
    },
    {
      name: "responsive-laptop",
      use: { ...devices["Desktop Chrome"], viewport: VIEWPORTS.laptop },
      dependencies: ["setup"],
      testMatch: /responsive\.spec\.ts/
    },
    {
      name: "responsive-4k",
      use: { ...devices["Desktop Chrome"], viewport: VIEWPORTS.uhd4k },
      dependencies: ["setup"],
      testMatch: /responsive\.spec\.ts/
    }
  ],
  webServer: [
    {
      command: "npm run dev -w apps/api",
      url: "http://localhost:4000/health",
      reuseExistingServer: true,
      timeout: 60_000
    },
    {
      command: "npm run dev -w apps/web",
      url: "http://localhost:5173",
      reuseExistingServer: true,
      timeout: 60_000
    }
  ]
});
