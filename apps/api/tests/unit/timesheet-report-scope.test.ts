/**
 * The timesheet exports say what they cover, report how much they cut, and cut the same rows the
 * screen does.
 *
 * THE DEFECTS (audit 2026-10, notifications #6 / analytics M12):
 *  - The "Scope" line printed on the PDF and the workbook covered dates, status, activity and
 *    billable only. Filter to Project = Apollo with no dates and the PDF said "Scope: all entries,
 *    all time" over Apollo's rows alone — confidently asserted wrong information.
 *  - The CSV never set X-Report-Total-Matching, so the download toast read "N of 0".
 *  - No Access-Control-Expose-Headers, so on a split-origin deployment the browser hides every
 *    X-Report-* header and the truncation warning can never fire.
 *  - When truncated, the screen's grouped report kept the OLDEST 20,000 rows and the exports kept
 *    the NEWEST, so "what you see is exactly what the download contains" was false at the cap.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const calls = vi.hoisted(() => [] as Array<{ model: string; method: string; args: any }>);

vi.mock("../../src/config/prisma.js", () => {
  const answer = (model: string, method: string, args: any) => {
    calls.push({ model, method, args });
    if (model === "project" && method === "findUnique") return { name: "Apollo", code: "APO" };
    if (model === "user" && method === "findUnique") return { name: "Eve Employee" };
    if (model === "projectModule" && method === "findUnique") return { name: "Payments" };
    if (model === "ticket" && method === "findUnique") return { key: "OPS-12", title: "Checkout 500" };
    if (method === "count") return 7;
    if (method === "findMany") return [];
    return null;
  };
  const model = (name: string) => new Proxy({}, { get: (_t, method: string) => async (args: any) => answer(name, method, args) });
  return { prisma: new Proxy({}, { get: (_t, name: string) => model(name) }) };
});
vi.mock("../../src/middleware/auth.js", () => ({
  requireAuth: (req: any, _res: unknown, next: () => void) => {
    req.user = { id: "viewer-1", name: "Vi Viewer", email: "vi@x.io", role: "ADMIN", permissions: ["reports:view"] };
    next();
  },
  requirePermission: () => (_req: unknown, _res: unknown, next: () => void) => next()
}));
vi.mock("../../src/services/timesheet-report-xlsx.service.js", () => ({
  buildTimesheetReportWorkbook: vi.fn(() => ({ xlsx: { write: async () => undefined } }))
}));

const { reportRouter } = await import("../../src/controllers/report.controller.js");
const { errorHandler } = await import("../../src/middleware/error.js");
const { describeReportFilters, buildTimesheetReport } = await import("../../src/services/timesheet-report.service.js");
const { buildTimesheetReportWorkbook } = await import("../../src/services/timesheet-report-xlsx.service.js");

function buildApp() {
  const app = express();
  app.use("/api/reports", reportRouter);
  app.use(errorHandler);
  return app;
}

const IDS = "projectId=p-1&userId=u-1&moduleId=m-1&ticketId=t-1";

beforeEach(() => {
  calls.length = 0;
  vi.mocked(buildTimesheetReportWorkbook).mockClear();
});

describe("the printed scope line", () => {
  it("names the project, person, module and ticket it was filtered to", () => {
    const label = describeReportFilters(
      { projectId: "p-1", userId: "u-1", moduleId: "m-1", ticketId: "t-1", status: "APPROVED" },
      { project: "APO — Apollo", user: "Eve Employee", module: "Payments", ticket: "OPS-12" }
    );
    for (const part of ["APO — Apollo", "Eve Employee", "Payments", "OPS-12", "APPROVED"]) expect(label).toContain(part);
    expect(label).not.toMatch(/all entries/);
  });

  it("never prints an id, even when a name cannot be found", () => {
    const label = describeReportFilters({ projectId: "p-1" }, {});
    expect(label).not.toContain("p-1");
    expect(label).toMatch(/project/i);
    expect(label).not.toMatch(/all entries/);
  });

  it("is resolved from the database for the real export", async () => {
    const res = await request(buildApp()).get(`/api/reports/export.xlsx?${IDS}`);
    expect(res.status, res.text).toBe(200);
    const doc = vi.mocked(buildTimesheetReportWorkbook).mock.calls[0][0];
    for (const part of ["APO — Apollo", "Eve Employee", "Payments", "OPS-12"]) expect(doc.scopeLabel).toContain(part);
  });
});

describe("the report headers", () => {
  it("sets X-Report-Total-Matching on the CSV, as on the PDF and the workbook", async () => {
    const res = await request(buildApp()).get("/api/reports/export.csv");
    expect(res.headers["x-report-total-matching"]).toBe("7");
    expect(res.headers["x-report-rows-included"]).toBe("0");
    expect(res.headers["x-report-truncated"]).toBe("true");
  });

  it.each(["export.csv", "export.xlsx", "export.pdf"])("exposes them to a cross-origin page on %s", async (path) => {
    const res = await request(buildApp()).get(`/api/reports/${path}`);
    const exposed = String(res.headers["access-control-expose-headers"] ?? "").toLowerCase();
    for (const header of ["x-report-total-matching", "x-report-rows-included", "x-report-truncated"]) {
      expect(exposed, path).toContain(header);
    }
  });
});

describe("truncation keeps the same rows on screen and in every download", () => {
  it("orders the screen's report newest-first, exactly as the exports do", async () => {
    await buildTimesheetReport({}, "user");
    const screen = calls.find((c) => c.model === "timesheet" && c.method === "findMany")!.args.orderBy;
    calls.length = 0;
    await request(buildApp()).get("/api/reports/export.csv");
    const csv = calls.find((c) => c.model === "timesheet" && c.method === "findMany")!.args.orderBy;
    calls.length = 0;
    await request(buildApp()).get("/api/reports/export.xlsx");
    const xlsx = calls.find((c) => c.model === "timesheet" && c.method === "findMany")!.args.orderBy;
    expect(screen).toEqual(csv);
    expect(xlsx).toEqual(csv);
    expect(screen[0]).toEqual({ workDate: "desc" });
  });
});
