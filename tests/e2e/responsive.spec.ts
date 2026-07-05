/**
 * Responsive-layout verification — runs once per viewport-size project defined in
 * playwright.config.ts (phone/tablet/laptop/4K), all on the same Chromium engine.
 * This is the primary verification tool for the mobile-responsive work (Phase G2 of the
 * hardening plan) since no interactive browser tool is available in this environment.
 *
 * This file logs in fresh for every test (via the API, not the UI — fast, no form-filling)
 * rather than reusing the shared `.auth/superadmin.json` snapshot other spec files use. It's
 * the one file in this suite that runs under FIVE separate projects (desktop + 4 viewport
 * sizes), which would otherwise mean five projects' worth of tests all replaying the exact
 * same one-time-rotating refresh secret over a couple of minutes of wall-clock time — well
 * past any reasonable grace window (see auth.service.ts#refresh). A fresh login per test
 * sidesteps that entirely instead of trying to widen the window to cover it.
 */
import { test, expect } from "@playwright/test";

test.beforeEach(async ({ page }) => {
  await page.request.post("/api/auth/login", {
    data: { email: "superadmin@timesheet.local", password: "Admin@12345" }
  });
});

const PAGES = ["/app", "/app/tickets", "/app/timesheet", "/app/insights", "/app/profile"];
const OVERFLOW_TOLERANCE_PX = 4;

async function assertNoOverflow(page: import("@playwright/test").Page) {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth
  }));
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth + OVERFLOW_TOLERANCE_PX);
}

for (const path of PAGES) {
  test(`no horizontal overflow at ${path}`, async ({ page }) => {
    await page.goto(path);
    await page.waitForLoadState("networkidle");
    await assertNoOverflow(page);
  });
}

test("no horizontal overflow on the public landing page", async ({ page }) => {
  await page.goto("/");
  await page.waitForLoadState("networkidle");
  await assertNoOverflow(page);
});

/**
 * Regression test for a real bug found via a live-device screenshot, not by this suite: a long,
 * unbroken ticket title inside a flex row (`SheetTitle`, no `min-width: 0` on the text child)
 * inflated the whole detail sheet wider than the viewport on a real phone. The list/page-level
 * overflow checks above never open this sheet at all, so they never exercised the bug — this
 * test specifically does, with a title long enough to have triggered it.
 */
test("no horizontal overflow with a long ticket title open in the detail sheet", async ({ page }) => {
  const { accessToken } = await (await page.request.post("/api/auth/refresh")).json();
  const headers = { Authorization: `Bearer ${accessToken}` };
  const projects = await (await page.request.get("/api/projects", { headers })).json();
  const longTitle = "A very long ticket title that would never fit on one line on a phone screen without wrapping properly";
  const ticket = await (
    await page.request.post("/api/tickets", {
      headers,
      data: { projectId: projects[0].id, title: longTitle, type: "BUG", priority: "LOW" }
    })
  ).json();

  try {
    await page.goto(`/app/tickets?open=${ticket.id}`);
    await expect(page.getByRole("heading", { name: longTitle })).toBeVisible({ timeout: 10_000 });
    await assertNoOverflow(page);
  } finally {
    await page.request.delete(`/api/tickets/${ticket.id}`, { headers });
  }
});

test("full navigation is reachable at every viewport size", async ({ page }) => {
  const viewport = page.viewportSize();
  await page.goto("/app");

  if (viewport && viewport.width >= 1024) {
    // Desktop/laptop/4K: the persistent sidebar should be visible directly.
    await expect(page.getByRole("link", { name: /workspace settings/i })).toBeVisible();
  } else {
    // Phone/tablet: the persistent sidebar is intentionally hidden; a hamburger/menu
    // trigger must open a drawer that reaches every nav item instead.
    const menuButton = page.getByRole("button", { name: /menu|navigation/i });
    await expect(menuButton).toBeVisible({ timeout: 10_000 });
    await menuButton.click();
    await expect(page.getByRole("link", { name: /workspace settings/i })).toBeVisible({ timeout: 10_000 });
  }
});
