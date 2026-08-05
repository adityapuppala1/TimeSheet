/**
 * Root-level Playwright config — this suite drives the real web app (Vite dev server)
 * against the real API (Express dev server), both started automatically via `webServer`.
 *
 * WHY the RESPONSIVE projects are Chromium-only, with custom viewport sizes rather than
 * Playwright's device presets: those presets default to WebKit, and pinning every size to one
 * engine is what makes a layout difference attributable to the WIDTH rather than to the browser.
 *
 * WHY there are also `firefox` and `webkit` projects: shipping to "all browsers" is a claim, and
 * it is only worth as much as the run behind it. Three engines cover every browser this product
 * is asked about — Chrome, Edge, Opera and Brave are all Chromium; Firefox is Gecko; Safari on
 * both macOS and iOS is WebKit. They run a `crossBrowserMatch` subset rather than everything,
 * because the value is in checking that the app FUNCTIONS on each engine (auth, navigation,
 * ticket flows, settings), not in re-running viewport-overflow assertions three times.
 *
 * WHY `workers: 1` / `fullyParallel: false`: specs share the same seeded MySQL database
 * (no per-test DB isolation), so running them concurrently risks one test's cleanup racing
 * another test's setup. Simpler and more reliable to run serially for now.
 */
import { defineConfig, devices } from "@playwright/test";
import { E2E_BASE_URL } from "./tests/e2e/helpers/base-url";

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
    // Derived, not hardcoded: certificates at apps/web/certs/ flip the dev server to HTTPS-only
    // (see helpers/base-url.ts), and a suite pinned to http:// would fail with connection errors
    // that look nothing like their cause.
    baseURL: E2E_BASE_URL,
    // The dev certificate is mkcert-issued; Chromium trusts the OS store but Playwright's
    // bundled Firefox/WebKit carry their own — without this they'd refuse the local CA.
    ignoreHTTPSErrors: true,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure"
  },
  projects: [
    { name: "setup", testMatch: /.*\.setup\.ts/ },
    /* Engine coverage. Deliberately a subset: face and camera specs are excluded because
       getUserMedia needs a secure context and a real device, and the responsive suite is a
       width question rather than an engine one. */
    {
      name: "firefox",
      use: { ...devices["Desktop Firefox"], viewport: VIEWPORTS.desktop },
      dependencies: ["setup"],
      testMatch: /(auth|tickets|timesheet|dashboard|settings|user-management)\.spec\.ts/
    },
    {
      name: "webkit",
      use: { ...devices["Desktop Safari"], viewport: VIEWPORTS.laptop },
      dependencies: ["setup"],
      testMatch: /(auth|tickets|timesheet|dashboard|settings|user-management)\.spec\.ts/
    },
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
      url: E2E_BASE_URL,
      ignoreHTTPSErrors: true,
      reuseExistingServer: true,
      timeout: 60_000
    }
  ]
});
