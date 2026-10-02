/**
 * Scheduled report emails are built — and stopped — on the OWNER's current authority.
 *
 * THE DEFECTS (audit 2026-10, notifications #3 and #4):
 *  - The worker only checked that the owner was ACTIVE. A manager moved to EMPLOYEE kept emailing
 *    the dashboard every Monday, while their own Scheduled delivery tab answered 403 → "Nothing
 *    scheduled." and DELETE answered 403. Only database access could stop it.
 *  - The worker scoped the report to the owner's OWN assignments on their primary role, while the
 *    live dashboard uses `ticketProjectScope` — so a team lead's emailed copy covered fewer projects
 *    than the same dashboard on screen, under a help line saying it is "built with YOUR access".
 *  - `renderHtml` put widget titles, the dashboard name and table rows (ticket titles, which can
 *    come from inbound email subjects) into the email unescaped.
 *  - A former colleague's address on the recipient list kept receiving reports after they left.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const state = vi.hoisted(() => ({
  owner: null as null | { id: string; name: string; email: string; role: string; permissions: string[] },
  subscription: {} as Record<string, any>,
  directory: [] as Array<{ id: string; email: string; managerId: string | null; status: string; deletedAt: Date | null }>,
  assignments: [] as Array<{ userId: string; projectId: string }>,
  widgets: [] as any[]
}));

vi.mock("../../src/config/prisma.js", () => {
  const userMatches = (u: any, where: any) => {
    if (!where) return true;
    if (where.managerId !== undefined && u.managerId !== where.managerId) return false;
    if (where.email?.in && !where.email.in.map((e: string) => e.toLowerCase()).includes(u.email.toLowerCase())) return false;
    if (where.OR) {
      const anyMatch = where.OR.some((c: any) =>
        (c.status?.not !== undefined && u.status !== c.status.not) || (c.deletedAt?.not === null && u.deletedAt !== null)
      );
      if (!anyMatch) return false;
    }
    if (where.deletedAt === null && u.deletedAt !== null) return false;
    return true;
  };
  return {
    prisma: {
      reportSubscription: {
        findMany: vi.fn(async () => [state.subscription]),
        findUnique: vi.fn(async () => state.subscription),
        update: vi.fn(async ({ data }: any) => Object.assign(state.subscription, data)),
        delete: vi.fn(async () => ({}))
      },
      user: { findMany: vi.fn(async ({ where }: any) => state.directory.filter((u) => userMatches(u, where))) },
      userProjectAssignment: {
        findMany: vi.fn(async ({ where }: any) => state.assignments.filter((a) => where.userId.in.includes(a.userId)))
      },
      project: { findMany: vi.fn(async () => [{ id: "p-a" }, { id: "p-b" }, { id: "p-c" }]) }
    }
  };
});
vi.mock("../../src/services/principal.service.js", () => ({ loadRequestUser: vi.fn(async () => state.owner) }));
vi.mock("../../src/services/planning.service.js", () => ({ getPlanningSettings: vi.fn(async () => ({ enablePlanning: true })) }));
vi.mock("../../src/services/dashboard.service.js", () => ({
  resolveDashboard: vi.fn(async () => state.widgets),
  WIDGET_CATALOGUE: [],
  WIDGET_TYPES: []
}));
vi.mock("../../src/services/mail.service.js", () => ({ sendMail: vi.fn(async () => undefined) }));
vi.mock("../../src/services/workspace-directory.service.js", () => ({ tenantBaseUrl: () => "https://acme.test" }));
vi.mock("../../src/services/audit.service.js", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("../../src/middleware/auth.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/middleware/auth.js")>("../../src/middleware/auth.js");
  return {
    ...actual,
    // The REAL requirePermission stays in place — whether the owner's routes still demand
    // reports:view is exactly what is being pinned.
    requireAuth: (req: any, _res: unknown, next: () => void) => {
      req.user = { id: "lead-1", name: "Lee Lead", email: "lee@x.io", role: "EMPLOYEE", permissions: ["timesheets:write"] };
      next();
    }
  };
});

const { tickForOneOrg } = await import("../../src/workers/report-subscription.worker.js");
const { dashboardRouter } = await import("../../src/controllers/dashboard.controller.js");
const { errorHandler } = await import("../../src/middleware/error.js");
const { sendMail } = await import("../../src/services/mail.service.js");
const { resolveDashboard } = await import("../../src/services/dashboard.service.js");

/** Monday 07:05 UTC — the default WEEKLY slot. */
const NOW = new Date("2026-10-05T07:05:00.000Z");

beforeEach(() => {
  vi.mocked(sendMail).mockClear();
  vi.mocked(resolveDashboard).mockClear();
  state.owner = { id: "lead-1", name: "Lee Lead", email: "lee@x.io", role: "TEAM_LEAD", permissions: ["reports:view"] };
  state.subscription = {
    id: "sub-1",
    name: "Monday update",
    cadence: "WEEKLY",
    dayOfWeek: 1,
    dayOfMonth: null,
    hourUtc: 7,
    isActive: true,
    lastSentAt: null,
    lastSendError: null,
    recipients: ["client@example.com", "gone@acme.test"],
    createdById: "lead-1",
    createdBy: { id: "lead-1", status: "ACTIVE", deletedAt: null },
    dashboard: { id: "d-1", name: "Ops <b>weekly</b>", widgets: [] }
  };
  state.directory = [
    { id: "lead-1", email: "lee@x.io", managerId: null, status: "ACTIVE", deletedAt: null },
    { id: "rep-1", email: "rep@acme.test", managerId: "lead-1", status: "ACTIVE", deletedAt: null },
    { id: "gone-1", email: "gone@acme.test", managerId: null, status: "INACTIVE", deletedAt: null }
  ];
  state.assignments = [
    { userId: "lead-1", projectId: "p-a" },
    { userId: "rep-1", projectId: "p-b" }
  ];
  state.widgets = [
    { title: "Open <script>alert(1)</script>", shape: "STAT", value: 3, unit: "", hint: "" },
    { title: "Upcoming", shape: "TABLE", rows: [{ key: "OPS-1", title: "<img src=x onerror=alert(1)>" }] }
  ];
});

describe("the worker, each run", () => {
  it("pauses the delivery, with a reason, when the owner no longer holds reports:view", async () => {
    state.owner = { ...state.owner!, permissions: ["timesheets:write"] };
    await tickForOneOrg(NOW);
    expect(sendMail).not.toHaveBeenCalled();
    expect(state.subscription.isActive).toBe(false);
    expect(state.subscription.lastSendError).toMatch(/reports/i);
  });

  it("scopes the report exactly as the live dashboard does — a team lead's reports' projects included", async () => {
    await tickForOneOrg(NOW);
    const projectIds = vi.mocked(resolveDashboard).mock.calls[0][0].projectIds;
    expect([...projectIds].sort()).toEqual(["p-a", "p-b"]);
  });

  it("escapes every value it puts into the email", async () => {
    await tickForOneOrg(NOW);
    const html = vi.mocked(sendMail).mock.calls[0][0].html as string;
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<b>weekly</b>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("drops a recipient whose address belongs to a deactivated colleague, and says so", async () => {
    await tickForOneOrg(NOW);
    const to = vi.mocked(sendMail).mock.calls.map((c) => c[0].to);
    expect(to).toEqual(["client@example.com"]);
    expect(state.subscription.lastSendError).toMatch(/gone@acme\.test/);
  });
});

describe("the owner's own deliveries", () => {
  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use("/api/dashboards", dashboardRouter);
    app.use(errorHandler);
    return app;
  }

  it("can still be listed after the owner loses reports:view, so a paused one is visible", async () => {
    const res = await request(buildApp()).get("/api/dashboards/subscriptions/all");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it("can still be deleted by the owner without reports:view", async () => {
    const res = await request(buildApp()).delete("/api/dashboards/subscriptions/11111111-1111-4111-8111-111111111111");
    expect(res.status, JSON.stringify(res.body)).toBe(204);
  });

  it("still needs reports:view to CREATE one", async () => {
    const res = await request(buildApp())
      .post("/api/dashboards/subscriptions")
      .send({ name: "x", dashboardId: "11111111-1111-4111-8111-111111111111", recipients: ["a@b.co"] });
    expect(res.status).toBe(403);
  });
});
