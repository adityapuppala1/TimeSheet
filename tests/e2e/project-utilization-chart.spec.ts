/**
 * The dashboard's project-utilization chart, which changes FORM with the viewport.
 *
 * THE BUG IT REPLACES: a vertical column chart in a third-width card. Eight project codes
 * competing for ~350px of x-axis drew on top of each other — "HICS-MEHICS-ERPCS-LeaHICS-POC" —
 * which is the one thing an axis exists to prevent. Widening the card buys headroom without
 * fixing the mechanism: a vertical axis gives each category `width / n` pixels, so the collision
 * returns at fifteen projects or at any width on a phone.
 *
 * So the axis was inverted (horizontal bars: names in a fixed gutter, one per row, unable to
 * collide however many there are) and, where even a gutter is too expensive, replaced by a donut
 * plus a numbered legend.
 *
 * The API response is intercepted rather than seeded: this is about how N projects RENDER, the
 * demo database has one, and writing seven more into a shared workspace to prove a layout point
 * would outlive the test.
 */
import { expect, test, type Page } from "@playwright/test";
import { signIn } from "./helpers/sign-in";

test.use({ storageState: { cookies: [], origins: [] } });

/** Eight projects with long, similar names — the shape that broke the old axis. */
const PROJECTS = [
  ["HICS Learnings & Certifications", "HICS-Learn", 106.2],
  ["HICS PropTech ERP", "HICS-ERP", 70.7],
  ["HICS Meetings", "HICS-MEET", 45.8],
  ["HICS Proof of Concept", "HICS-POC", 39.0],
  ["HICS Website", "HICS-Web", 28.5],
  ["HICS Dine-o-Bot", "HICS-DYNO", 24.0],
  ["HICS Hiring", "HICS-Hire", 13.0],
  ["HICS Internal Tools", "HICS-INT", 1.0]
] as const;

async function openDashboardWithProjects(page: Page, width: number, height = 1400) {
  await signIn(page, "superadmin");
  // The trailing `*` is load-bearing: as of 3.5.0 the home page sends `?from=&to=` on this
  // request, and a glob without it stops matching the moment a query string appears — the
  // interception silently does nothing and the chart renders the real workspace instead of
  // these eight projects. `my-month` in dashboard-project-tickets.spec.ts already had it.
  await page.route("**/api/reports/admin-summary*", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    body.byProject = PROJECTS.map(([project, projectCode, hours]) => ({
      project,
      projectCode,
      _sum: { totalHours: hours }
    }));
    await route.fulfill({ response, json: body });
  });
  await page.setViewportSize({ width, height });
  await page.goto("/app");
}

test.describe("project utilization", () => {
  test("uses horizontal bars on a wide screen, with every project named in full", async ({ page }) => {
    await openDashboardWithProjects(page, 1440);
    const bars = page.getByTestId("project-utilization-bars");
    await expect(bars).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("project-utilization-donut")).toHaveCount(0);

    // Every project's NAME on the axis, not a truncated code.
    for (const [name] of PROJECTS) {
      await expect(bars.locator("text", { hasText: name })).toHaveCount(1);
    }
  });

  /**
   * The regression that matters: axis labels must not overlap. Compared as real bounding boxes,
   * because "the labels look fine" is exactly the judgement that shipped the bug.
   */
  test("axis labels never overlap, however many projects there are", async ({ page }) => {
    await openDashboardWithProjects(page, 1440);
    await expect(page.getByTestId("project-utilization-bars")).toBeVisible({ timeout: 20_000 });

    const boxes = await page.getByTestId("project-utilization-bars").evaluate((root) =>
      Array.from(root.querySelectorAll("g.recharts-yAxis text")).map((node) => {
        const rect = (node as SVGTextElement).getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom, text: node.textContent ?? "" };
      })
    );
    expect(boxes.length).toBe(PROJECTS.length);

    const ordered = [...boxes].sort((a, b) => a.top - b.top);
    for (let i = 1; i < ordered.length; i++) {
      expect(
        ordered[i].top,
        `"${ordered[i - 1].text}" and "${ordered[i].text}" overlap vertically`
      ).toBeGreaterThanOrEqual(ordered[i - 1].bottom - 1);
    }
  });

  /**
   * Values are visible without a hover — an obligation, not a nicety: three light-mode slots in
   * the categorical palette sit below 3:1 against the surface, and the relief for that is visible
   * labels or a table view.
   *
   * This test exists because the labels were briefly INVISIBLE while the DOM insisted they were
   * fine: a `stroke` on the bar's `<Cell>` is spread onto the label text by recharts, and a 2px
   * surface-colored outline around 11px digits erased them to a single dot. Asserting on
   * `textContent` alone would still have passed — so this measures what is actually painted.
   */
  test("prints each bar's hours without a hover, and actually paints them", async ({ page }) => {
    await openDashboardWithProjects(page, 1440);
    const bars = page.getByTestId("project-utilization-bars");
    await expect(bars).toBeVisible({ timeout: 20_000 });

    // Recharts animates the bars in and mounts the label list after; polling for the full set is
    // waiting for the render to settle, not papering over a missing label.
    await expect
      .poll(() => bars.locator("text.recharts-label").count(), { timeout: 15_000 })
      .toBe(PROJECTS.length);

    const labels = await bars.evaluate((root) =>
      Array.from(root.querySelectorAll("text.recharts-label")).map((node) => {
        const el = node as SVGTextElement;
        const style = getComputedStyle(el);
        return {
          text: el.textContent ?? "",
          // A stroke wider than ~1px at this font size is what obliterated the glyphs.
          strokeWidth: style.stroke === "none" ? 0 : parseFloat(style.strokeWidth || "0"),
          stroke: style.stroke,
          width: el.getBBox().width
        };
      })
    );

    expect(labels.length).toBe(PROJECTS.length);
    for (const label of labels) {
      expect(label.text).toMatch(/^\d+(\.\d+)?h$/);
      expect(label.width, `"${label.text}" has no rendered width`).toBeGreaterThan(8);
      expect(
        label.stroke === "none" || label.strokeWidth === 0,
        `"${label.text}" is stroked (${label.stroke} ${label.strokeWidth}px) — that erases 11px glyphs`
      ).toBe(true);
    }
  });

  test("switches to a donut with a numbered legend on a phone", async ({ page }) => {
    await openDashboardWithProjects(page, 390, 1200);
    const donut = page.getByTestId("project-utilization-donut");
    await expect(donut).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("project-utilization-bars")).toHaveCount(0);

    // One legend row per project, each carrying hours AND share — the donut shows the shape, the
    // legend carries the answer, because arc length is a poor way to compare close values.
    const rows = donut.locator("li");
    await expect(rows).toHaveCount(PROJECTS.length);
    await expect(rows.first()).toContainText("HICS Learnings & Certifications");
    await expect(rows.first()).toContainText("106.2h");
    await expect(rows.first()).toContainText("32%");
  });

  /** The form has to follow a resize, not just the width at mount — a laptop user dragging a
   *  window across the breakpoint must get the other chart. */
  test("changes form when the window crosses the breakpoint", async ({ page }) => {
    await openDashboardWithProjects(page, 1440);
    await expect(page.getByTestId("project-utilization-bars")).toBeVisible({ timeout: 20_000 });

    await page.setViewportSize({ width: 390, height: 1200 });
    await expect(page.getByTestId("project-utilization-donut")).toBeVisible({ timeout: 10_000 });

    await page.setViewportSize({ width: 1440, height: 1400 });
    await expect(page.getByTestId("project-utilization-bars")).toBeVisible({ timeout: 10_000 });
  });
});
