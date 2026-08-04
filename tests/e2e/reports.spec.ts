/**
 * Timesheet reporting: filters, grouping and the two exports.
 *
 * WHAT THESE PIN, and it is not "a file downloaded". Both exports previously took no parameters at
 * all — `async (_req, res)` with `where: { deletedAt: null }` — so "export" meant every timesheet
 * in the workspace, for all time, for everybody. And the PDF capped at 500 rows while printing a
 * total computed from those 500, with nothing saying it had been cut: a document that stated a
 * wrong number confidently, in a file somebody might hand to a client.
 *
 * So the assertions are: the filters actually narrow, every grouping of the same rows agrees on
 * the total, and a truncated export says so in a way a caller can detect without parsing a PDF.
 */
import { expect, test } from "@playwright/test";
import { withAdminRequest } from "./helpers/admin-request";
import { signIn } from "./helpers/sign-in";

test.describe("timesheet reporting", () => {
  test("every grouping of the same rows totals identically", async () => {
    await withAdminRequest(async (ctx, headers) => {
      const groupings = ["user", "project", "activity", "status", "ticket", "day", "week", "month"];
      const totals: number[] = [];

      for (const groupBy of groupings) {
        const report = await (await ctx.get(`/api/reports/timesheets?groupBy=${groupBy}`, { headers })).json();
        expect(Array.isArray(report.groups)).toBe(true);
        // The sum of the parts IS the whole. If a grouping ever drops rows — un-ticketed work was
        // the obvious candidate — this catches it, where eyeballing one report never would.
        const summed = report.groups.reduce((s: number, g: any) => s + g.hours, 0);
        expect(summed).toBeCloseTo(report.totals.hours, 1);
        totals.push(Number(report.totals.hours.toFixed(2)));
      }

      expect(new Set(totals).size, `groupings disagreed on total hours: ${totals.join(", ")}`).toBe(1);
    });
  });

  test("filters narrow the result, and an impossible filter returns nothing rather than everything", async () => {
    await withAdminRequest(async (ctx, headers) => {
      const all = await (await ctx.get("/api/reports/timesheets?groupBy=status", { headers })).json();
      const approved = await (await ctx.get("/api/reports/timesheets?groupBy=status&status=APPROVED", { headers })).json();

      expect(approved.totals.hours).toBeLessThanOrEqual(all.totals.hours);
      for (const group of approved.groups) expect(group.key).toBe("APPROVED");

      // A filter that matches nothing must return an empty report. Falling back to "everything"
      // when a filter matches nothing is the classic way a report silently over-reports.
      const future = await (await ctx.get("/api/reports/timesheets?from=2099-01-01", { headers })).json();
      expect(future.totals.entries).toBe(0);
      expect(future.groups).toHaveLength(0);
      expect(future.totals.hours).toBe(0);
    });
  });

  test("cost is null rather than zero when no entry carries a rate", async () => {
    await withAdminRequest(async (ctx, headers) => {
      const report = await (await ctx.get("/api/reports/timesheets?groupBy=user", { headers })).json();
      for (const group of report.groups) {
        // Zero would claim the work was free. Rows approved before rate snapshots existed have no
        // rate and are deliberately never backfilled, so the honest answer is "unknown".
        if (group.unratedEntries === group.entries) expect(group.cost).toBeNull();
        if (group.cost !== null) expect(group.cost).toBeGreaterThan(0);
      }
    });
  });

  test("the CSV carries the billing and SLA columns, honours filters, and is Excel-safe", async () => {
    await withAdminRequest(async (ctx, headers) => {
      const res = await ctx.get("/api/reports/export.csv", { headers });
      expect(res.status()).toBe(200);
      expect(res.headers()["content-type"]).toContain("text/csv");

      const body = await res.body();
      // A UTF-8 BOM, so Excel does not mangle accented names — the single most common
      // "your export is broken" report.
      expect(body.subarray(0, 3).toString("hex")).toBe("efbbbf");

      const text = body.toString("utf8").replace(/^\uFEFF/, "");
      const [header, ...rows] = text.trim().split("\n");
      // The columns that make an export worth having, none of which were there before.
      for (const column of ["Billable", "Rate", "Amount", "Ticket", "Reviewed by", "SLA breached at"]) {
        expect(header, `CSV is missing the ${column} column`).toContain(column);
      }

      const filtered = await ctx.get("/api/reports/export.csv?status=APPROVED", { headers });
      const filteredRows = (await filtered.text()).replace(/^\uFEFF/, "").trim().split("\n").slice(1);
      expect(filteredRows.length).toBeLessThanOrEqual(rows.length);
    });
  });

  test("the PDF is a real PDF, honours filters, and reports its own row count", async () => {
    await withAdminRequest(async (ctx, headers) => {
      const res = await ctx.get("/api/reports/export.pdf", { headers });
      expect(res.status()).toBe(200);
      expect((await res.body()).subarray(0, 5).toString()).toBe("%PDF-");

      // Machine-readable, because a caller scripting this cannot parse the document to discover
      // it is partial — and "partial" is the thing it must not miss.
      const included = Number(res.headers()["x-report-rows-included"]);
      const matching = Number(res.headers()["x-report-total-matching"]);
      expect(included).toBeLessThanOrEqual(matching);
      expect(res.headers()["x-report-truncated"]).toBe(included < matching ? "true" : undefined);

      const narrow = await ctx.get("/api/reports/export.pdf?from=2099-01-01", { headers });
      expect(Number(narrow.headers()["x-report-rows-included"])).toBe(0);
    });
  });

  test("the reports page filters on screen and the numbers move", async ({ page }) => {
    await signIn(page, "superadmin");
    await page.goto("/app/reports");

    await expect(page.getByRole("heading", { name: /timesheet report/i })).toBeVisible({ timeout: 15_000 });

    const hoursTile = page.locator("p", { hasText: /^Hours$/ }).locator("xpath=following-sibling::p[1]");
    await expect(hoursTile).toBeVisible({ timeout: 15_000 });

    // A date range nothing can match must empty the table rather than silently showing everything.
    await page.locator("#report-from").fill("2099-01-01");
    await expect(page.getByText(/no entries match these filters/i)).toBeVisible({ timeout: 15_000 });
    await expect(hoursTile).toHaveText(/^0\.00h$/);

    await page.getByRole("button", { name: /clear filters/i }).click();
    await expect(page.getByText(/no entries match these filters/i)).toBeHidden({ timeout: 15_000 });

    // Regrouping keeps the same total — the on-screen version of the API assertion above.
    const before = await hoursTile.textContent();
    await page.locator("#report-groupby").click();
    await page.getByRole("option", { name: "Activity" }).click();
    await expect(hoursTile).toHaveText(before ?? "", { timeout: 15_000 });
  });
});
