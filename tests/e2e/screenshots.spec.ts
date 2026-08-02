/**
 * Captures the product screenshots used by the public marketing pages (Landing, PitchDeck).
 *
 * WHY this is a Playwright spec rather than someone taking screenshots by hand: marketing shots go
 * stale silently. A hand-taken PNG of a screen that has since been redesigned keeps selling a
 * product that no longer exists, and nobody notices until a prospect does. Re-running this
 * regenerates every image from the app as it actually is today.
 *
 * SKIPPED BY DEFAULT — it writes files into apps/web/public and adds ~30s, neither of which
 * belongs in a normal test run. To refresh the images:
 *
 *   CAPTURE_SCREENSHOTS=1 npx playwright test screenshots --project=desktop
 *
 * It also fails on console errors while it walks the app, so a refresh doubles as a smoke test of
 * every major screen.
 */
import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

const ENABLED = Boolean(process.env.CAPTURE_SCREENSHOTS);
const OUT_DIR = path.join("apps", "web", "public", "product");

test.use({ storageState: "tests/e2e/.auth/superadmin-settings.json" });
test.describe.configure({ mode: "serial" });

/** Screens worth showing a prospect, in the order the marketing pages use them. */
const SHOTS = [
  { slug: "dashboard", url: "/app", label: "Dashboard" },
  { slug: "tickets", url: "/app/tickets", label: "Tickets" },
  { slug: "insights", url: "/app/insights", label: "Insights" },
  { slug: "timesheet", url: "/app/timesheet", label: "Timesheet" },
  { slug: "security", url: "/app/security-insights", label: "Security insights" },
  { slug: "settings-ai", url: "/app/settings", label: "AI settings" }
];

test.describe("product screenshots", () => {
  test.skip(!ENABLED, "Set CAPTURE_SCREENSHOTS=1 to regenerate marketing images.");

  test.beforeAll(() => {
    fs.mkdirSync(OUT_DIR, { recursive: true });
  });

  for (const shot of SHOTS) {
    test(`capture ${shot.slug}`, async ({ page }) => {
      // Records the failing URL, not just "401" — a bare status tells you nothing about which
      // request broke, and the auth bootstraps 401 by design on every load (see below).
      const failed: string[] = [];
      page.on("response", (res) => {
        if (res.status() >= 400) failed.push(`${res.status()} ${new URL(res.url()).pathname}`);
      });
      const consoleErrors: string[] = [];
      page.on("pageerror", (err) => consoleErrors.push(err.message));

      // Light theme: a screenshot shrunk into a marketing card reads far better light-on-dark
      // than the reverse, and the app defaults to the OS preference which we can't rely on here.
      await page.addInitScript(() => window.localStorage.setItem("timesheet:theme", "light"));
      await page.goto(shot.url);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 15_000 });

      // Let charts finish their entry animation and any lazy panel settle, otherwise the shot
      // catches a half-drawn graph.
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(1200);

      await page.screenshot({ path: path.join(OUT_DIR, `${shot.slug}.png`), fullPage: false });

      // Uncaught exceptions only — this is what makes a refresh double as a smoke test.
      expect(consoleErrors, `page errors on ${shot.url}`).toEqual([]);

      // The platform-admin session probe 401s on every tenant page by design (App.tsx's
      // PlatformAdminAuthBootstrap — "not logged in" is the expected path, not an error).
      // Anything ELSE failing is a real problem worth failing the capture over.
      const unexpected = failed.filter((f) => !f.includes("/platform-admin/auth/"));
      expect(unexpected, `failed requests on ${shot.url}`).toEqual([]);
    });
  }

  test("capture dashboard in dark mode for the hero", async ({ page }) => {
    await page.addInitScript(() => window.localStorage.setItem("timesheet:theme", "dark"));
    await page.goto("/app");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible({ timeout: 15_000 });
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1200);
    await page.screenshot({ path: path.join(OUT_DIR, "dashboard-dark.png"), fullPage: false });
  });
});
