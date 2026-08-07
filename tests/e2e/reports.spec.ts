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
    // "Last year" rather than "Today": this workspace has entries logged today, so that preset
    // would prove nothing. The seeded data is all in the current year, so the previous one is
    // genuinely empty — which is the state under test.
    await page.locator("#report-range").click();
    const rangeDialog = page.getByRole("dialog");
    await expect(rangeDialog).toBeVisible({ timeout: 10_000 });
    await rangeDialog.getByRole("button", { name: "Last year", exact: true }).click();
    await rangeDialog.getByRole("button", { name: "Apply" }).click();
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

  /**
   * The three export buttons, clicked — which the API assertions above cannot cover.
   *
   * These routes need a bearer token, so the page cannot use a bare `<a href>`: it fetches the
   * blob and clicks a synthesised anchor. That indirection is where a browser-side export breaks
   * while the endpoint itself is perfectly healthy — a 401 comes back as a Blob too, gets the same
   * `.xlsx` filename, and downloads without a single error anywhere. So each file is opened and
   * its MAGIC BYTES checked, not just its name.
   */
  test("the CSV, Excel and PDF buttons download real files from the page", async ({ page }) => {
    await signIn(page, "superadmin");
    await page.goto("/app/reports");
    await expect(page.getByRole("heading", { name: /timesheet report/i })).toBeVisible({ timeout: 15_000 });

    const stamp = new Date().toISOString().slice(0, 10);
    const signatures: Array<{ button: string; extension: string; magic: string }> = [
      // BOM-first UTF-8, so Excel does not mangle accented names.
      { button: "CSV", extension: "csv", magic: "efbbbf" },
      // "PK" — every .xlsx is a zip container. A JSON error body starts with "{".
      { button: "Excel", extension: "xlsx", magic: "504b" },
      { button: "PDF", extension: "pdf", magic: "255044462d" }
    ];

    for (const { button, extension, magic } of signatures) {
      const download = page.waitForEvent("download", { timeout: 20_000 });
      await page.getByRole("button", { name: button, exact: true }).click();
      const file = await download;
      expect(file.suggestedFilename()).toBe(`timesheet-report-${stamp}.${extension}`);

      const stream = await file.createReadStream();
      const chunks: Buffer[] = [];
      for await (const chunk of stream) chunks.push(chunk as Buffer);
      const body = Buffer.concat(chunks);
      expect(body.length, `${button} downloaded an empty file`).toBeGreaterThan(0);
      expect(
        body.subarray(0, magic.length / 2).toString("hex"),
        `${button} downloaded something that is not a ${extension}`
      ).toBe(magic);
    }
  });
});

/* ------------------------------------------------------------------------------------------- *
 * Analytics: utilisation, approval latency, activity mix.
 *
 * Every figure here joins the rows against something that can be MISSING — a capacity that was
 * never configured, a submit time from before the column existed, a rate from before snapshots
 * existed. So the assertions are mostly about what happens when the answer is unknown: it must
 * come back null and say so, never as a zero somebody would act on.
 * ------------------------------------------------------------------------------------------- */
test.describe("timesheet analytics", () => {
  const RANGE = "from=2026-01-01&to=2026-12-31";

  test("refuses without a date range instead of inventing a window", async () => {
    await withAdminRequest(async (ctx, headers) => {
      const res = await ctx.get("/api/reports/analytics", { headers });
      // Utilisation is hours over capacity, and capacity only exists relative to a period.
      // Defaulting silently would produce a confident percentage nobody asked for.
      expect(res.status()).toBe(422);
      expect((await res.json()).message).toMatch(/date range/i);
    });
  });

  test("utilisation is null — not zero — when a person has no capacity on file", async () => {
    await withAdminRequest(async (ctx, headers) => {
      const data = await (await ctx.get(`/api/reports/analytics?${RANGE}`, { headers })).json();
      for (const row of data.utilisation) {
        expect(row.loggedHours).toBeGreaterThanOrEqual(0);
        if (row.capacityHours === null) {
          // 0% would read as "this person did nothing", when the truth is "nobody told us their
          // contracted hours".
          expect(row.utilisationPct).toBeNull();
        } else {
          expect(row.capacityHours).toBeGreaterThan(0);
          expect(row.utilisationPct).toBeCloseTo((row.loggedHours / row.capacityHours) * 100, 0);
        }
      }
    });
  });

  test("approval latency reports what it could not measure rather than dropping it", async () => {
    await withAdminRequest(async (ctx, headers) => {
      const { approvalLatency } = await (await ctx.get(`/api/reports/analytics?${RANGE}`, { headers })).json();

      // Entries submitted before the submit timestamp existed cannot be timed. They are counted,
      // not silently excluded — a median over three of two hundred rows is a different claim from
      // one over all two hundred, and nothing on a chart says which.
      expect(typeof approvalLatency.measured).toBe("number");
      expect(typeof approvalLatency.unmeasurable).toBe("number");
      if (approvalLatency.measured === 0) {
        expect(approvalLatency.medianHours).toBeNull();
        expect(approvalLatency.p90Hours).toBeNull();
      } else {
        expect(approvalLatency.medianHours).not.toBeNull();
        expect(approvalLatency.p90Hours).toBeGreaterThanOrEqual(approvalLatency.medianHours);
      }

      // The breach rate reads the approval deadline, which has ALWAYS been stored — so it works
      // from day one even when latency cannot be computed at all.
      if (approvalLatency.breachRatePct !== null) {
        expect(approvalLatency.breachRatePct).toBeGreaterThanOrEqual(0);
        expect(approvalLatency.breachRatePct).toBeLessThanOrEqual(100);
      }
    });
  });

  test("activity shares total exactly 100, never 99.9 or 100.1", async () => {
    await withAdminRequest(async (ctx, headers) => {
      const { activityMix, totals } = await (await ctx.get(`/api/reports/analytics?${RANGE}`, { headers })).json();
      if (activityMix.length === 0) return;

      // Rounding each share independently produces sets that sum to 100.1%. On a labelled pie that
      // reads as an arithmetic error, and a report caught being wrong about something trivial is
      // not trusted about anything else.
      const sum = activityMix.reduce((s: number, a: any) => s + a.sharePct, 0);
      expect(Number(sum.toFixed(4))).toBe(100);

      const hours = activityMix.reduce((s: number, a: any) => s + a.hours, 0);
      expect(hours).toBeCloseTo(totals.hours, 1);
    });
  });

  test("analytics and the grouped report agree on the same range", async () => {
    await withAdminRequest(async (ctx, headers) => {
      const analytics = await (await ctx.get(`/api/reports/analytics?${RANGE}`, { headers })).json();
      const grouped = await (await ctx.get(`/api/reports/timesheets?groupBy=user&${RANGE}`, { headers })).json();
      // Two surfaces over the same filtered rows. If these ever diverge, one of them is lying and
      // the reader has no way to tell which.
      expect(analytics.totals.hours).toBeCloseTo(grouped.totals.hours, 2);
      expect(analytics.totals.entries).toBe(grouped.totals.entries);
    });
  });

  test("the Excel export is a real workbook with a summary and a detail sheet", async () => {
    await withAdminRequest(async (ctx, headers) => {
      const res = await ctx.get("/api/reports/export.xlsx?groupBy=activity", { headers });
      expect(res.status()).toBe(200);
      expect(res.headers()["content-type"]).toContain("spreadsheetml");

      const body = await res.body();
      // xlsx is a zip; "PK" is its magic number. Proves a real workbook rather than an error page
      // served with a hopeful content-type.
      expect(body.subarray(0, 2).toString()).toBe("PK");

      // Entry NAMES sit uncompressed in the zip's directory, so they are readable without
      // unzipping — unlike the sheet titles, which are inside a deflated stream. Two worksheets
      // means the summary sheet exists alongside the raw rows, which is the whole reason this
      // format is offered over CSV.
      const archive = body.toString("latin1");
      expect(archive).toContain("xl/workbook.xml");
      expect(archive.match(/xl\/worksheets\/sheet\d+\.xml/g)?.length ?? 0).toBeGreaterThanOrEqual(2);

      expect(Number(res.headers()["x-report-rows-included"])).toBeGreaterThanOrEqual(0);
    });
  });

  test("the analytics panel renders and states what it cannot compute", async ({ page }) => {
    await signIn(page, "superadmin");
    await page.goto("/app/reports");

    await expect(page.getByRole("heading", { name: /^analytics$/i })).toBeVisible({ timeout: 15_000 });
    await expect(page.locator("#analytics-range")).toBeVisible();

    // The utilisation table is the headline; it must render even when nobody has capacity set.
    // `exact` matters: the card's own description also mentions where the hours went, so a loose
    // match resolves to two elements and fails strict mode.
    await expect(page.getByText("Utilisation — logged hours against contracted capacity", { exact: true })).toBeVisible();
    await expect(page.getByText("Where the hours went", { exact: true })).toBeVisible();
  });
});
