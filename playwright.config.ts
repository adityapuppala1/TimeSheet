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
    // Video only where a person is watching. In CI the trace above already carries every frame
    // that matters (DOM snapshots, network, console, a screenshot per action) at a tenth of the
    // size, and a .webm per failed attempt was what made a failing shard's report 25–32 MB of
    // billed artifact storage. Locally, a video is the fastest way to see what a flake looked like.
    video: process.env.CI ? "off" : "retain-on-failure"
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
      // NO SPECIAL VIDEO SETTING HERE ANY MORE. One was added on the theory that turning CI video
      // off had stopped headless WebKit compositing and so starved Playwright's stability check of
      // animation frames; the next run failed identically, so that theory is dead too. It was the
      // third guess about this test, and all three were made without evidence for one reason: every
      // report upload had been failing on "artifact storage quota has been hit", so no trace for
      // the failure was ever stored. The quota is cleared and the upload can no longer fail the
      // job (see ci.yml), so the next failure finally arrives with its trace attached. Guessing
      // again before reading it would be the fourth mistake.
      /**
       * SIXTY SECONDS, AND THIS TIME THERE IS EVIDENCE — the three guesses above were made without
       * any, because every trace upload was failing on an artifact quota. The quota is cleared, and
       * the 2026-09-28 run on main finally gave paired timings for the SAME tests on both engines:
       *
       *     settings.spec.ts:13    firefox 11.0s   webkit 11.7s   (1.06x)
       *     settings.spec.ts:46    firefox 13.8s   webkit 15.1s   (1.09x)
       *     settings.spec.ts:120   firefox 16.0s   webkit 19.9s   (1.24x)
       *     timesheet.spec.ts:130  firefox 14.7s   webkit 23.5s   (1.60x)
       *     tickets.spec.ts:91     firefox 17.1s   webkit 28.6s   (1.67x)  <- passed, with 1.4s spare
       *     tickets.spec.ts:25     firefox 19.1s   webkit 31.9s   FAILED at the 30s cap
       *
       * WebKit is not flaky here; it is systematically slower, and it scales WORSE the more a test
       * does — 1.06x on the lightest, 1.67x on the heaviest. So a 30s budget sized against Firefox's
       * 19s cannot hold WebKit's 32s, and `tickets.spec.ts:25` sat just the wrong side of it while
       * its neighbour passed with 1.4 seconds to spare. That is a budget that was going to fail
       * whichever test drifted first, not a defect in one test.
       *
       * Scoped to this project rather than raised globally: Chromium and Firefox finish inside 30s
       * with room, and a longer cap everywhere would slow down every genuine hang on every engine.
       * A test that is truly stuck still fails here — it just takes a minute to say so.
       */
      timeout: 60_000,
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
