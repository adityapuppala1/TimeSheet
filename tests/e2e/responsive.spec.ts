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

// Previously only these 5 of ~20 authenticated routes were viewport-tested — /app/settings
// (8 tabs) and /platform-admin/* (see the block below) were exactly where real responsive bugs
// were later found via manual review, precisely because they were never covered here. Expanded
// per docs/ROADMAP.md's production-readiness backlog note.
const PAGES = [
  "/app",
  "/app/tickets",
  "/app/timesheet",
  "/app/insights",
  "/app/profile",
  "/app/history",
  "/app/team",
  "/app/users",
  "/app/settings"
];
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

/**
 * Regression test for the "clipped, not scrolling" class of bug: `overflow-x: clip` on html/body
 * means a TabsList wider than its container is silently clipped, not scrolled — the page-level
 * `assertNoOverflow` checks above pass even when real tabs are permanently unreachable, because
 * `document.documentElement.scrollWidth` never grows (nothing overflows the PAGE, content is
 * just clipped inside one component). Clicking every tab is the only way to actually catch this.
 */
async function assertEveryTabIsReachable(page: import("@playwright/test").Page) {
  const tabs = page.getByRole("tab");
  const count = await tabs.count();
  expect(count).toBeGreaterThan(0);
  for (let i = 0; i < count; i++) {
    const tab = tabs.nth(i);
    await tab.scrollIntoViewIfNeeded();
    await expect(tab).toBeVisible();
    await tab.click({ timeout: 5_000 });
  }
}

test("every tab in Workspace Settings (8 tabs) is reachable", async ({ page }) => {
  await page.goto("/app/settings");
  await page.waitForLoadState("networkidle");
  await assertEveryTabIsReachable(page);
});

test("every tab in the ticket detail sheet (6 tabs) is reachable", async ({ page }) => {
  const { accessToken } = await (await page.request.post("/api/auth/refresh")).json();
  const headers = { Authorization: `Bearer ${accessToken}` };
  const projects = await (await page.request.get("/api/projects", { headers })).json();
  const ticket = await (
    await page.request.post("/api/tickets", {
      headers,
      data: { projectId: projects[0].id, title: "Tab reachability regression check", type: "BUG", priority: "LOW" }
    })
  ).json();

  try {
    await page.goto(`/app/tickets?open=${ticket.id}`);
    await expect(page.getByRole("heading", { name: "Tab reachability regression check" })).toBeVisible({ timeout: 10_000 });
    await assertEveryTabIsReachable(page);
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

/**
 * `/platform-admin/*` previously had ZERO responsive coverage — it's a separate auth stack
 * (own login endpoint, own cookie) from the tenant app, and its layout (PlatformAdminLayout.tsx)
 * had no mobile/tablet treatment at all until that gap was found via manual review, not this
 * suite. Covered as its own describe block since it needs a different login call.
 */
test.describe("platform-admin console", () => {
  test.beforeEach(async ({ page }) => {
    await page.request.post("/api/platform-admin/auth/login", {
      data: { email: "platform-admin@timesphere.local", password: "PlatformAdmin@12345" }
    });
  });

  const PLATFORM_ADMIN_PAGES = ["/platform-admin", "/platform-admin/plan-tiers", "/platform-admin/analytics"];

  for (const path of PLATFORM_ADMIN_PAGES) {
    test(`no horizontal overflow at ${path}`, async ({ page }) => {
      await page.goto(path);
      await page.waitForLoadState("networkidle");
      await assertNoOverflow(page);
    });
  }

  test("hamburger drawer reaches every nav item below lg", async ({ page }) => {
    const viewport = page.viewportSize();
    await page.goto("/platform-admin");

    if (viewport && viewport.width >= 1024) {
      await expect(page.getByRole("link", { name: /analytics/i })).toBeVisible();
    } else {
      const menuButton = page.getByRole("button", { name: /menu/i });
      await expect(menuButton).toBeVisible({ timeout: 10_000 });
      await menuButton.click();
      await expect(page.getByRole("link", { name: /analytics/i })).toBeVisible({ timeout: 10_000 });
    }
  });
});
