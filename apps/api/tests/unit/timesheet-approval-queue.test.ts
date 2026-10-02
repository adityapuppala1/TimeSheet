/**
 * The approvals queue, and the "awaiting review" figures that point at it.
 *
 * THE DEFECT THIS PINS (audit 2026-10, timesheets #3 / notifications #1): the approvals page called
 * `GET /timesheets` with no parameters, which hands a `reports:view` holder the newest 100 rows of
 * EVERY status across the workspace — and then filtered that page for SUBMITTED in the browser. On
 * a workspace logging a few dozen entries a day, an entry submitted on Monday was off the end of the
 * page by Thursday: it existed, it was overdue, the SLA escalation mail linked to the page, and the
 * page could not show it. Meanwhile the Inbox, the reports summary and the queue all counted
 * "awaiting review" differently, so none of the numbers matched the list they linked to.
 *
 * Now the queue is its own route: the server filters, the server pages, and the scope is the one
 * definition in services/timesheet-approval-scope.service.ts — SUBMITTED, not yours, not your
 * managers'. The brief and the reports summary count with the same predicate.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { PrismaClient } from "@prisma/client";
import { runInTenant } from "../helpers/tenant-context.js";

const LEAD = { id: "lead-1", name: "Lee Lead", email: "lee@x.io", role: "TEAM_LEAD", permissions: ["timesheets:write", "timesheets:approve", "reports:view"] };
const PEOPLE = [
  { id: "top-1", managerId: null },
  { id: "mgr-1", managerId: "top-1" },
  { id: LEAD.id, managerId: "mgr-1" },
  { id: "emp-1", managerId: LEAD.id }
];

vi.mock("../../src/middleware/auth.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/middleware/auth.js")>("../../src/middleware/auth.js");
  return {
    ...actual,
    requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
      req.user = { ...LEAD } as never;
      next();
    },
    requirePermission: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next()
  };
});
vi.mock("../../src/services/face.service.js", () => ({
  isFaceVerificationRequired: vi.fn().mockResolvedValue(false),
  consumeVerification: vi.fn(),
  bindVerificationToRecord: vi.fn(),
  unbindTimesheetVerification: vi.fn().mockResolvedValue([]),
  getTimesheetVerificationBadges: vi.fn().mockResolvedValue(new Map())
}));

const { timesheetRouter } = await import("../../src/controllers/timesheet.controller.js");
const { errorHandler } = await import("../../src/middleware/error.js");

let client: PrismaClient;

function fakeClient(total = 0) {
  return {
    timesheet: {
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(total),
      groupBy: vi.fn().mockResolvedValue([])
    },
    project: { findMany: vi.fn().mockResolvedValue([]) },
    user: {
      findMany: vi.fn().mockResolvedValue(PEOPLE.map((p) => ({ ...p, email: `${p.id}@x.io`, status: "ACTIVE", deletedAt: null })))
    }
  } as unknown as PrismaClient;
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((_req, _res, next) => runInTenant(client, async () => next(), "org-1").catch(next));
  app.use("/api/timesheets", timesheetRouter);
  app.use(errorHandler);
  return app;
}

const queue = (query = "") => request(buildApp()).get(`/api/timesheets/approval-queue${query}`);
const listWhere = () => (vi.mocked(client.timesheet.findMany).mock.calls[0][0] as any).where;

beforeEach(() => {
  client = fakeClient(57);
});

describe("GET /timesheets/approval-queue", () => {
  it("asks the server for SUBMITTED entries, excluding your own and your managers'", async () => {
    const res = await queue();
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const where = listWhere();
    expect(where.status).toBe("SUBMITTED");
    expect(where.deletedAt).toBeNull();
    // Yourself and everyone above you who has a manager — but NOT your reports, and no one else.
    // top-1 heads the tree with no manager, so anyone but top-1 may decide their hours (audit
    // 2026-10 R3, finding 1).
    expect([...where.userId.notIn].sort()).toEqual([LEAD.id, "mgr-1"].sort());
  });

  it("pages for real, and reports the full total rather than the page length", async () => {
    const res = await queue("?page=3&pageSize=25");
    const args = vi.mocked(client.timesheet.findMany).mock.calls[0][0] as any;
    expect(args.skip).toBe(50);
    expect(args.take).toBe(25);
    expect(res.body).toMatchObject({ total: 57, page: 3, pageSize: 25 });
  });

  it("caps a page at 100, the most one bulk decision accepts", async () => {
    await queue("?pageSize=500");
    expect((vi.mocked(client.timesheet.findMany).mock.calls[0][0] as any).take).toBe(100);
  });

  it("keeps the table's newest-work-first order, with an id tiebreak so paging is stable", async () => {
    // Two entries with the same day and start time (two people, or one person on two projects) had
    // no defined order between them, so one could appear on page 1 AND page 2 while another
    // appeared on neither.
    await queue();
    expect((vi.mocked(client.timesheet.findMany).mock.calls[0][0] as any).orderBy).toEqual([
      { workDate: "desc" },
      { startTime: "desc" },
      { id: "asc" }
    ]);
  });

  it("applies project, activity, date and search filters on the server, not to one page in the browser", async () => {
    await queue("?projectId=p-9&activityType=Testing&from=2026-09-01&to=2026-09-30&search=importer");
    const where = listWhere();
    expect(where.projectId).toBe("p-9");
    expect(where.activityType).toBe("Testing");
    expect(where.workDate).toEqual({ gte: new Date("2026-09-01T00:00:00.000Z"), lte: new Date("2026-09-30T00:00:00.000Z") });
    expect(JSON.stringify(where.OR)).toContain("importer");
  });

  it("widens to another status, or all of them, when asked — still never your own", async () => {
    await queue("?status=APPROVED");
    expect(listWhere().status).toBe("APPROVED");
    vi.mocked(client.timesheet.findMany).mockClear();
    await queue("?status=ALL");
    expect(listWhere().status).toBeUndefined();
    expect(listWhere().userId.notIn).toContain(LEAD.id);
  });

  it("returns the awaiting-review count with the same predicate, for the page's own badge", async () => {
    const res = await queue("?status=APPROVED");
    expect(res.body.awaitingReview).toBe(57);
    const badgeCall = vi.mocked(client.timesheet.count).mock.calls.find((c) => (c[0] as any).where.status === "SUBMITTED");
    expect(badgeCall).toBeDefined();
    expect((badgeCall![0] as any).where.userId.notIn).toContain(LEAD.id);
  });
});
