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
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import request from "supertest";

const state = vi.hoisted(() => ({
  owner: null as null | { id: string; name: string; email: string; role: string; permissions: string[] },
  /** Who is calling the routes — by default the owner after losing reports:view. */
  requester: null as null | { id: string; name: string; email: string; role: string; permissions: string[] },
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
      const anyMatch = where.OR.some(
        (c: any) =>
          (typeof c.status === "string" && u.status === c.status) ||
          (c.status?.not !== undefined && u.status !== c.status.not) ||
          (c.deletedAt?.not === null && u.deletedAt !== null)
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
      req.user = { ...state.requester! };
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
  state.requester = { id: "lead-1", name: "Lee Lead", email: "lee@x.io", role: "EMPLOYEE", permissions: ["timesheets:write"] };
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

  it("keeps an invited colleague who has not finished signing up — only a deactivated or deleted account is dropped", async () => {
    // PENDING_VERIFICATION is somebody on their way IN. `status: { not: "ACTIVE" }` dropped them with
    // the leavers, so a report addressed to a new joiner silently never reached them.
    state.directory.push({ id: "new-1", email: "new@acme.test", managerId: null, status: "PENDING_VERIFICATION", deletedAt: null });
    state.subscription.recipients = ["client@example.com", "new@acme.test", "gone@acme.test"];
    await tickForOneOrg(NOW);
    expect(vi.mocked(sendMail).mock.calls.map((c) => c[0].to)).toEqual(["client@example.com", "new@acme.test"]);
  });

  it("fits a long skipped-recipients note into its 500-character column, so the send is still recorded", async () => {
    // The note went into VarChar(500) unclipped. With enough departed addresses the write threw
    // AFTER the mail had gone out — so lastSentAt was never stamped and the next tick sent again.
    const leavers = Array.from({ length: 30 }, (_, i) => `departed.colleague.number.${i}@acme.test`);
    state.directory.push(...leavers.map((email, i) => ({ id: `left-${i}`, email, managerId: null, status: "INACTIVE", deletedAt: null })));
    state.subscription.recipients = ["client@example.com", ...leavers];
    await tickForOneOrg(NOW);
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect(state.subscription.lastSentAt).toEqual(NOW);
    expect(state.subscription.lastSendError.length).toBeLessThanOrEqual(500);
    expect(state.subscription.lastSendError).toMatch(/^Not sent to departed\.colleague\.number\.0@acme\.test/);
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

  /**
   * Pause and resume (audit 2026-10 R3, finding 4). A delivery the worker paused — the owner lost
   * reports:view, or the upgrade paused it because a manager's report widened to their team's
   * projects — had no way back but delete-and-recreate. The owner can now switch it off and on.
   */
  const toggle = (isActive: unknown, id = "11111111-1111-4111-8111-111111111111") =>
    request(buildApp()).patch(`/api/dashboards/subscriptions/${id}`).send({ isActive });

  it("lets the owner resume a paused delivery, clearing the note that paused it", async () => {
    state.requester = { ...state.requester!, permissions: ["reports:view"] };
    Object.assign(state.subscription, { isActive: false, lastSendError: "Paused after an update: check the recipients, then resume." });
    const res = await toggle(true);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(state.subscription.isActive).toBe(true);
    expect(state.subscription.lastSendError).toBeNull();
    expect(res.body).toMatchObject({ id: "sub-1", isActive: true, lastSendError: null });
  });

  it("refuses to resume while the owner still lacks reports:view — the worker would only pause it again", async () => {
    Object.assign(state.subscription, { isActive: false, lastSendError: "Paused: no reports:view." });
    const res = await toggle(true);
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/reports:view/);
    expect(state.subscription.isActive).toBe(false);
  });

  it("lets the owner pause their own delivery, whatever their permissions", async () => {
    const res = await toggle(false);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(state.subscription.isActive).toBe(false);
  });

  it("is the owner's alone", async () => {
    state.requester = { id: "someone-else", name: "Sam", email: "sam@x.io", role: "SUPER_ADMIN", permissions: ["reports:view", "users:manage"] };
    Object.assign(state.subscription, { isActive: false });
    const res = await toggle(true);
    expect(res.status).toBe(403);
    expect(state.subscription.isActive).toBe(false);
  });

  it("changes nothing but isActive", async () => {
    const res = await request(buildApp())
      .patch("/api/dashboards/subscriptions/11111111-1111-4111-8111-111111111111")
      .send({ isActive: true, recipients: ["attacker@evil.test"] });
    expect(res.status).toBe(422);
    expect(state.subscription.recipients).toEqual(["client@example.com", "gone@acme.test"]);
  });

  it("still needs reports:view to CREATE one", async () => {
    const res = await request(buildApp())
      .post("/api/dashboards/subscriptions")
      .send({ name: "x", dashboardId: "11111111-1111-4111-8111-111111111111", recipients: ["a@b.co"] });
    expect(res.status).toBe(403);
  });
});

/**
 * The upgrade's pause (audit 2026-10 R3, finding 4). A manager's or team lead's emailed dashboard
 * now covers their reports' projects too, so a weekly report to a client could start naming another
 * client's projects. The data-only migration pauses exactly those deliveries that reach an address
 * outside the workspace, with a note saying why, until the owner checks and resumes. It cannot be run
 * here (no database in unit tests), so its decisions are pinned in its text.
 */
describe("the migration that pauses widened manager reports", () => {
  const sql = readFileSync(
    fileURLToPath(new URL("../../prisma/migrations/20261002141000_pause_widened_manager_report_deliveries/migration.sql", import.meta.url)),
    "utf8"
  );
  const code = sql
    .split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");

  it("pauses only ACTIVE deliveries of MANAGER and TEAM_LEAD owners, with the agreed note", () => {
    expect(code).toMatch(/UPDATE `ReportSubscription`/);
    expect(code).toMatch(/SET `rs`\.`isActive` = FALSE/);
    expect(code).toMatch(/WHERE `rs`\.`isActive` = TRUE/);
    expect(code).toMatch(/`role`\.`name` IN \('MANAGER', 'TEAM_LEAD'\)/);
    const note = /`lastSendError` = '((?:[^']|'')*)'/.exec(code)?.[1].replaceAll("''", "'");
    expect(note).toBe(
      "Paused after an update: scheduled reports now cover the same projects as your live dashboard, including your team's. Check the recipients, then resume."
    );
    expect(note!.length).toBeLessThanOrEqual(500);
  });

  it("pauses only a delivery with a recipient who is not a workspace account", () => {
    expect(code).toMatch(/NOT EXISTS \(\s*SELECT 1\s+FROM `User` AS `u`\s+WHERE `u`\.`email` = /);
  });

  it("is data-only, and avoids JSON_TABLE, which MariaDB 10.4 (the local XAMPP engine) does not have", () => {
    expect(code).not.toMatch(/\b(ALTER|CREATE|DROP)\b/i);
    expect(code).not.toMatch(/JSON_TABLE/i);
  });
});
