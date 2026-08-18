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
import { deleteTicket, withAdminRequest } from "./helpers/admin-request";
import { suspendFaceGate, type FaceGateSnapshot } from "./helpers/face-gate";
import { accessToken } from "./helpers/sign-in";

// Several tests below build their own ticket fixture through the API. When the workspace has
// face verification enabled with enforcementMode ALL — a legitimate, shippable configuration —
// those creations return 428 and the tests fail with symptoms that look nothing like the cause
// (a detail sheet whose ticket never loads). Suspend enforcement for this file and restore the
// exact previous values afterwards; a no-op when the feature is off. See helpers/face-gate.ts.
let faceGate: FaceGateSnapshot;
test.beforeAll(async () => {
  faceGate = await suspendFaceGate();
});
test.afterAll(async () => {
  await faceGate?.restore();
});

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
  // Grew an Activity types card (a wrapping row of chips, each with three icon buttons) — the
  // shape most likely to push a narrow viewport sideways, and it was not swept before.
  "/app/projects",
  "/app/settings",
  // Planning layer (V6). Worth sweeping specifically: the timeline is the widest thing in the
  // app by construction (a date-scaled chart), and adding two buttons to the Tickets view
  // switcher is exactly what pushed that page past 390px the first time.
  "/app/my-work",
  "/app/timeline",
  "/app/portfolio",
  "/app/workload",
  "/app/requests",
  "/app/proposals",
  // The agentic layer (V8). Swept for the same reason the planning layer is: these carry the widest
  // constructions added since — a drag-and-drop canvas, a 30-day bar chart, and two week-column
  // tables — and none of them was covered here when it shipped. A page whose feature is off for this
  // workspace still renders its own empty or upgrade state, which must not overflow either.
  "/app/goals",
  "/app/inbox",
  "/app/agents",
  "/app/studio",
  "/app/ai"
];
const OVERFLOW_TOLERANCE_PX = 4;

async function assertNoOverflow(page: import("@playwright/test").Page) {
  // Offenders are collected up front, not on failure: by the time a bare scrollWidth assertion
  // fails, the ONLY debugging lead is "something somewhere is wide", which costs a manual
  // element-by-element hunt (it did, for the email analytics tab). Naming the widest elements in
  // the failure message turns that hunt into a grep.
  const { scrollWidth, clientWidth, offenders } = await page.evaluate((tolerance) => {
    const cw = document.documentElement.clientWidth;
    const wide: Array<{ width: number; label: string }> = [];
    for (const el of Array.from(document.querySelectorAll("*"))) {
      const rect = el.getBoundingClientRect();
      // right edge, not width: a 300px element positioned at x=900 is what actually stretches
      // scrollWidth, and it has no over-wide ancestor to point at.
      const extent = Math.max(rect.right, rect.width);
      if (extent > cw + tolerance) {
        const cls = String((el as HTMLElement).className)
          .split(/\s+/)
          .slice(0, 5)
          .join(".");
        wide.push({ width: Math.round(extent), label: `${el.tagName.toLowerCase()}${cls ? `.${cls}` : ""}` });
      }
    }
    wide.sort((a, b) => b.width - a.width);
    return {
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: cw,
      offenders: wide.slice(0, 15).map((o) => `${o.width}px ${o.label}`)
    };
  }, OVERFLOW_TOLERANCE_PX);
  expect(
    scrollWidth,
    offenders.length ? `elements wider than the ${clientWidth}px viewport:\n${offenders.join("\n")}` : undefined
  ).toBeLessThanOrEqual(clientWidth + OVERFLOW_TOLERANCE_PX);
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
 * The email templates screen hides its widest content — the analytics tables and charts — behind
 * a second tab, so the PAGES sweep above never exercised it. That is exactly where a real
 * overflow shipped (found via a live-device screenshot of the failure breakdown): a page can only
 * be called viewport-clean if its every tab has been measured.
 */
test("no horizontal overflow on either email-templates tab", async ({ page }) => {
  await page.goto("/app/email-templates");
  await page.waitForLoadState("networkidle");
  await assertNoOverflow(page);

  await page.getByRole("tab", { name: /analytics/i }).click();
  await expect(page.getByRole("heading", { name: /why sends failed/i })).toBeVisible({ timeout: 15_000 });
  await page.waitForLoadState("networkidle");
  await assertNoOverflow(page);

  // The failure that shipped was NOT a static-layout bug: recharts stamps a pixel width onto its
  // svg, and an ancestor chain without min-width:0 then cannot shrink below it when the viewport
  // narrows — DevTools device toggles and phone rotation both hit it. Render wide first, shrink,
  // and re-assert, so the deadlock (not just the happy path) stays covered.
  const original = page.viewportSize();
  await page.setViewportSize({ width: 1280, height: 800 });
  // Proof the wide render actually happened — otherwise this test could pass by shrinking
  // before recharts ever stamped a wide pixel width, which is the very state under test.
  await page.waitForFunction(() => {
    const chart = document.querySelector(".recharts-wrapper");
    return chart instanceof HTMLElement && chart.clientWidth > 600;
  });
  await page.setViewportSize(original ?? { width: 390, height: 844 });
  // Give the ResizeObserver → re-render chain a bounded window to settle; on a healthy layout
  // this resolves almost immediately, and on the deadlock it times out and the assertion below
  // reports WHICH elements are stuck wide.
  await page
    .waitForFunction(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 4,
      undefined,
      { timeout: 4000 }
    )
    .catch(() => undefined);
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
  const headers = await accessToken(page);
  const projects = await (await page.request.get("/api/projects", { headers })).json();
  const longTitle = "A very long ticket title that would never fit on one line on a phone screen without wrapping properly";
  const created = await page.request.post("/api/tickets", {
    headers,
    data: { projectId: projects[0].id, title: longTitle, type: "BUG", priority: "LOW" }
  });
  // ASSERTED, not assumed. Without this a failed create (a 428 from the face gate, a 429 from the
  // login limiter) leaves `ticket.id` undefined, the page opens `?open=undefined`, and the failure
  // surfaces ten seconds later as "heading not found" — pointing at the layout this test is about
  // rather than at the fixture that never existed. Cost a real debugging cycle once.
  expect(created.status(), `ticket fixture should be created: ${await created.text()}`).toBe(201);
  const ticket = await created.json();
  expect(ticket.id, "created ticket should have an id").toBeTruthy();

  try {
    await page.goto(`/app/tickets?open=${ticket.id}`);
    await expect(page.getByRole("heading", { name: longTitle })).toBeVisible({ timeout: 10_000 });
    await assertNoOverflow(page);
  } finally {
    // Superadmin, because `tickets:manage` is ADMIN/SUPER_ADMIN only and this spec's session may
    // not have it — the same silent-403 teardown that let 61 smoke tickets accumulate.
    await deleteTicket(ticket.id);
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
  // Scoped to the FIRST tablist, not every role=tab on the page: panels opened by earlier
  // clicks can mount their own nested tab elements, which shifts a page-wide nth() index
  // mid-loop — and a click resolved against a shifted index lands somewhere it was never
  // aimed. Tab traversal must be able to VIEW every panel while being physically unable to
  // interact with anything inside one.
  const tabs = page.getByRole("tablist").first().getByRole("tab");
  // Readiness first, then enumeration: `count()` samples INSTANTLY, and `networkidle` can fire
  // during the auth-bootstrap gap (refresh POST done, settings queries not yet started) — which
  // once produced a flaky "0 tabs" on a loaded machine. Waiting for the first tab converts the
  // race into an explicit readiness condition.
  await tabs.first().waitFor({ state: "visible", timeout: 15_000 });
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

  // INVARIANT: by the time this spec finishes, maintenance mode must be OFF — whatever armed
  // it. A quick-suite run once had a 3-minute window enabled MID-RUN (audit forensics: a
  // human super-admin manually testing the scheduler in their own browser against the same
  // shared dev stack) and four downstream specs died of lockout in ways that looked nothing
  // like their cause. This check turns any such drift — human, test, or bug — into ONE loud
  // failure with the evidence attached, instead of four misleading ones.
  await withAdminRequest(async (ctx, headers) => {
    const { settings, phase } = await (await ctx.get("/api/maintenance/admin", { headers })).json();
    expect(
      phase,
      `tab traversal must not activate maintenance mode (settings now: ${JSON.stringify(settings)})`
    ).not.toBe("active");
    expect(settings.enabled, "tab traversal must not enable the maintenance window").toBe(false);
  });
});

/**
 * Second-order version of the same trap, and the one that actually shipped a bug.
 *
 * `assertNoOverflow` measures the DOCUMENT, and `overflow-x: clip` on html/body means the document
 * can never report overflow. So when the Face verification panel rendered 512px wide inside a 390px
 * phone — dragging the page header and every sibling out with it — every existing check stayed
 * green and the damage was simply invisible.
 *
 * The cause was a grid track sized to its widest panel's min-content (`min-width: auto` on grid
 * items). Measuring `main.scrollWidth` per tab catches it: content is allowed to scroll INSIDE a
 * panel, but a panel must never widen the page.
 */
test("no Workspace Settings tab widens the page beyond the viewport", async ({ page }, testInfo) => {
  // PHONE ONLY. The bug this guards is a min-content overflow, which by definition only manifests
  // when the viewport is narrower than the content — at 1366px and above there is simply room, so
  // the other four projects spent two minutes each proving nothing. Running it five times also
  // tripled the whole suite's wall-clock, which is its own kind of harm.
  testInfo.skip(testInfo.project.name !== "responsive-phone", "the narrow viewport is the only one that can fail");

  // Fourteen panels, each needing a settle window before it can be measured honestly, does not fit
  // the 30s default. Raised deliberately rather than by shortening the settle: a sample too short
  // to see the late render is a test that passes for the wrong reason, which is exactly the failure
  // this test exists to prevent.
  test.setTimeout(120_000);

  await page.goto("/app/settings");
  await page.waitForLoadState("networkidle");

  const tabs = page.getByRole("tab");
  const count = await tabs.count();
  expect(count).toBeGreaterThan(0);

  for (let i = 0; i < count; i++) {
    const tab = tabs.nth(i);
    const label = (await tab.textContent())?.trim() ?? `tab ${i}`;
    await tab.scrollIntoViewIfNeeded();
    await tab.click({ timeout: 5_000 });
    await page.waitForLoadState("networkidle");

    // SAMPLED OVER TIME, not measured once — and this is the whole reason the test works.
    // `networkidle` resolves BEFORE React Query's data lands and renders, so a single measurement
    // right after it reads 390px and passes. The offending content (the verification log's rows)
    // appeared ~3s later and pushed the page to 512px. Verified by reverting the fix: the
    // measure-once version stayed green, this one fails.
    const worst = await page.evaluate(async () => {
      const clientWidth = document.documentElement.clientWidth;
      let scrollWidth = 0;
      // ~2.4s per panel: long enough to catch the verification log's rows landing at ~3s from
      // click (network idle already absorbed the first second or so of that).
      for (let i = 0; i < 6; i++) {
        scrollWidth = Math.max(scrollWidth, document.querySelector("main")?.scrollWidth ?? 0);
        await new Promise((resolve) => setTimeout(resolve, 400));
      }
      return { scrollWidth, clientWidth };
    });
    expect(worst.scrollWidth, `the "${label}" panel widened the page to ${worst.scrollWidth}px`).toBeLessThanOrEqual(
      worst.clientWidth + 1
    );
  }
});

test("every tab in the ticket detail sheet (7 tabs) is reachable", async ({ page }) => {
  const headers = await accessToken(page);
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

/**
 * The shared timesheet entry dialog, at every width.
 *
 * It is the one surface Approvals, History and the dashboard timeline all open, it holds a
 * two-column labelled grid that collapses below `sm`, and on a phone it is the ONLY view of an
 * entry — the tables collapse to cards. A dialog that overflows there is not "a bit cramped", it
 * is a row of facts the reader cannot reach.
 */
test("the timesheet entry dialog fits, and its actions stay reachable", async ({ page }) => {
  const headers = await accessToken(page);
  const entries: Array<{ id: string }> = await (await page.request.get("/api/timesheets", { headers })).json();
  test.skip(entries.length === 0, "no timesheet entries in the demo data to open");

  await page.goto(`/app/history?entry=${entries[0].id}`);
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  await expect(dialog.getByText("Logged by", { exact: true })).toBeVisible({ timeout: 15_000 });

  await assertNoOverflow(page);

  // Header and footer are pinned and only the middle scrolls, so both must be on screen no matter
  // how much task text the entry carries.
  const viewport = page.viewportSize()!;
  const box = (await dialog.boundingBox())!;
  expect(box.y, "the dialog must not start above the viewport").toBeGreaterThanOrEqual(-1);
  expect(box.y + box.height, "the dialog must not end below the viewport").toBeLessThanOrEqual(viewport.height + 1);
});
