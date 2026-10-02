/**
 * Who decides the hours of the person at the TOP of a reporting tree, and of a workspace's only
 * approver.
 *
 * THE DEFECT (audit 2026-10 R3, finding 1): the ruling "never your own, never someone above you"
 * left the root of every reporting tree with no eligible reviewer. The root is above every other
 * approver, so a super admin over admins and managers, a single owner with employees, a solo trial
 * and the shipped seed (Avery → Mira → Dev) all submitted hours nobody could decide — and the same
 * predicate hid them from the approvals queue, the Inbox count and admin-summary. The SLA sweep then
 * escalated the entry to the author, or to a subordinate the decision route would refuse, leaving an
 * Escalation row that could never resolve.
 *
 * THE DECISION (integrator):
 *  - "never someone ABOVE you" applies only when the author HAS a manager. The root may be decided
 *    by any approver except themselves.
 *  - Self-approval stays refused, EXCEPT when the author is the only active, non-agent person who
 *    could decide it. Separation of duties cannot apply to one person; the audit records
 *    `soleApprover: true`.
 *  - The SLA sweep never escalates to the author or to anyone the decision would refuse; with nobody
 *    eligible it escalates to nobody and writes no Escalation row.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { PrismaClient } from "@prisma/client";
import { runInTenant } from "../helpers/tenant-context.js";

interface Person {
  id: string;
  name: string;
  email: string;
  role: string;
  managerId: string | null;
  approver: boolean;
  status?: string;
  isAgent?: boolean;
  deletedAt?: Date | null;
}

const person = (id: string, role: string, managerId: string | null, approver: boolean, extra: Partial<Person> = {}): Person => ({
  id,
  name: id,
  email: `${id}@x.io`,
  role,
  managerId,
  approver,
  ...extra
});

let people: Person[] = [];
let actorId = "";

vi.mock("../../src/middleware/auth.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/middleware/auth.js")>("../../src/middleware/auth.js");
  return {
    ...actual,
    requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
      const me = people.find((p) => p.id === actorId)!;
      req.user = {
        id: me.id,
        name: me.name,
        email: me.email,
        role: me.role,
        permissions: me.approver ? ["timesheets:write", "timesheets:approve"] : ["timesheets:write"]
      } as never;
      next();
    },
    requirePermission: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next()
  };
});
vi.mock("../../src/services/audit.service.js", () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../src/services/notify.service.js", () => ({ dispatchNotification: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../src/services/face.service.js", () => ({
  isFaceVerificationRequired: vi.fn().mockResolvedValue(false),
  consumeVerification: vi.fn().mockResolvedValue("attempt-1"),
  bindVerificationToRecord: vi.fn().mockResolvedValue(undefined),
  unbindTimesheetVerification: vi.fn().mockResolvedValue([]),
  getTimesheetVerificationBadges: vi.fn().mockResolvedValue(new Map())
}));
vi.mock("../../src/services/billing-rate.service.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/services/billing-rate.service.js")>("../../src/services/billing-rate.service.js");
  return { ...actual, buildRateSnapshotPatch: vi.fn().mockResolvedValue({}) };
});
vi.mock("../../src/services/domain-events.js", () => ({ emitDomainEvent: vi.fn() }));

const { timesheetRouter } = await import("../../src/controllers/timesheet.controller.js");
const { errorHandler } = await import("../../src/middleware/error.js");
const { audit } = await import("../../src/services/audit.service.js");
const { dispatchNotification } = await import("../../src/services/notify.service.js");
const { processSlaSweep } = await import("../../src/services/sla.service.js");

const ENTRY_ID = "11111111-1111-4111-8111-111111111111";

interface Row {
  id: string;
  userId: string;
  status: string;
  [key: string]: unknown;
}
let rows: Map<string, Row>;
let client: PrismaClient;
let escalations: Array<Record<string, unknown>>;

function entry(userId: string, status = "SUBMITTED"): Row {
  return {
    id: ENTRY_ID,
    userId,
    status,
    projectId: "p-1",
    moduleId: "m-1",
    activityType: "Development",
    taskDescription: "<p>Built the importer</p>",
    notes: "",
    workDate: new Date("2026-09-28T00:00:00.000Z"),
    startTime: "09:00",
    endTime: "12:00",
    totalHours: 3,
    billable: true,
    deletedAt: null,
    approvalDeadline: new Date("2026-09-29T00:00:00.000Z"),
    slaBreachAt: null
  };
}

const live = (p: Person) => (p.status ?? "ACTIVE") === "ACTIVE" && !p.deletedAt;

/**
 * The directory, answering the two questions the scope service asks of it: everyone's reporting
 * link (no filter), and who currently holds `timesheets:approve` — filtered here by exactly the
 * where clause the service writes, so an agent or a deactivated account is only excluded if the
 * real query excludes it.
 */
function userFindMany({ where }: any = {}) {
  if (!where) {
    return people.map((p) => ({ id: p.id, email: p.email, managerId: p.managerId, status: p.status ?? "ACTIVE", deletedAt: p.deletedAt ?? null }));
  }
  const holdsApprove = where.role?.permissions?.some?.permission?.key === "timesheets:approve";
  return people
    .filter((p) => (holdsApprove ? p.approver : true))
    .filter((p) => (where.status === "ACTIVE" ? (p.status ?? "ACTIVE") === "ACTIVE" : true))
    .filter((p) => (where.deletedAt === null ? !p.deletedAt : true))
    .filter((p) => (where.isAgent === false ? !p.isAgent : true))
    .map((p) => ({ id: p.id, name: p.name, email: p.email, role: { name: p.role } }));
}

function fakeClient(): PrismaClient {
  const withRelations = (row: Row) => ({
    ...row,
    project: { id: "p-1", name: "Apollo" },
    module: { name: "Importer" },
    submodule: null,
    user: people.find((p) => p.id === row.userId)
  });
  const c: any = {
    timesheet: {
      findFirst: vi.fn(async ({ where }: any) => {
        const row = rows.get(where.id);
        return row && !row.deletedAt ? { ...row } : null;
      }),
      findUniqueOrThrow: vi.fn(async ({ where }: any) => withRelations(rows.get(where.id)!)),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const row = rows.get(where.id);
        if (!row || (where.status && row.status !== where.status)) return { count: 0 };
        rows.set(row.id, { ...row, ...data });
        return { count: 1 };
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const row = { ...rows.get(where.id)!, ...data };
        rows.set(row.id, row);
        return withRelations(row);
      }),
      // The SLA sweep's read: every overdue SUBMITTED row, with its author and the author's manager.
      findMany: vi.fn(async () =>
        [...rows.values()]
          .filter((r) => r.status === "SUBMITTED" && !r.slaBreachAt)
          .map((r) => {
            const author = people.find((p) => p.id === r.userId)!;
            const manager = people.find((p) => p.id === author.managerId) ?? null;
            return { ...withRelations(r), user: { ...author, status: author.status ?? "ACTIVE", manager } };
          })
      ),
      count: vi.fn(async () => 0),
      groupBy: vi.fn(async () => [])
    },
    user: {
      findMany: vi.fn(async (args: any) => userFindMany(args)),
      // What the sweep's escalation lookup read before this fix — kept so the old code fails on its
      // ANSWER rather than on a missing method.
      findUnique: vi.fn(async ({ where }: any) => {
        const p = people.find((x) => x.id === where.id);
        if (!p) return null;
        const manager = people.find((x) => x.id === p.managerId) ?? null;
        const grand = manager ? people.find((x) => x.id === manager.managerId) ?? null : null;
        return { ...p, status: p.status ?? "ACTIVE", manager: manager ? { ...manager, status: manager.status ?? "ACTIVE", manager: grand ? { ...grand, status: grand.status ?? "ACTIVE" } : null } : null };
      }),
      findFirst: vi.fn(async ({ where }: any) => {
        const notIn: string[] = where?.id?.notIn ?? [];
        const roles: string[] = where?.role?.name?.in ?? [];
        const hit = people.find((p) => live(p) && roles.includes(p.role) && !notIn.includes(p.id));
        return hit ? { id: hit.id, name: hit.name, email: hit.email } : null;
      })
    },
    escalation: {
      create: vi.fn(async ({ data }: any) => {
        escalations.push(data);
        return data;
      }),
      updateMany: vi.fn(async () => ({ count: 0 }))
    },
    project: { findUnique: vi.fn(async () => ({ slaApprovalHours: 48 })), findMany: vi.fn(async () => []) }
  };
  c.$transaction = vi.fn(async (ops: any) => (typeof ops === "function" ? ops(c) : Promise.all(ops)));
  return c as PrismaClient;
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((_req, _res, next) => runInTenant(client, async () => next(), "org-1").catch(next));
  app.use("/api/timesheets", timesheetRouter);
  app.use(errorHandler);
  return app;
}

const approve = () => request(buildApp()).patch(`/api/timesheets/${ENTRY_ID}/approve`).send({});
const audited = (action: string) => vi.mocked(audit).mock.calls.filter((c) => c[1] === action);

beforeEach(() => {
  escalations = [];
  vi.mocked(audit).mockClear();
  vi.mocked(dispatchNotification).mockClear();
});

describe("the root of a reporting tree can have their hours decided", () => {
  // TOP manages LEAD, LEAD manages EMP. TOP has no manager.
  beforeEach(() => {
    people = [person("TOP", "SUPER_ADMIN", null, true), person("LEAD", "TEAM_LEAD", "TOP", true), person("EMP", "EMPLOYEE", "LEAD", false)];
    rows = new Map([[ENTRY_ID, entry("TOP")]]);
    client = fakeClient();
  });

  it("lets an approver below the root decide the root's entry", async () => {
    actorId = "LEAD";
    const res = await approve();
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(rows.get(ENTRY_ID)!.status).toBe("APPROVED");
  });

  it("lists the root's entries in that approver's queue, which the Inbox and admin-summary count by", async () => {
    actorId = "LEAD";
    const res = await request(buildApp()).get("/api/timesheets/approval-queue");
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const where = (vi.mocked(client.timesheet.findMany).mock.calls[0][0] as any).where;
    expect(where.userId.notIn).toEqual(["LEAD"]);
  });

  it("still refuses an entry by someone above you who HAS a manager", async () => {
    people = [...people, person("MID", "MANAGER", "TOP", true)];
    people.find((p) => p.id === "LEAD")!.managerId = "MID";
    rows = new Map([[ENTRY_ID, entry("MID")]]);
    actorId = "LEAD";
    const res = await approve();
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/report to/i);
  });

  it("still refuses the root deciding their own entry while someone else could", async () => {
    actorId = "TOP";
    const res = await approve();
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/your own/i);
  });
});

describe("a workspace's only approver", () => {
  beforeEach(() => {
    // One owner who approves; everybody else logs time. Plus two identities that hold the approve
    // permission but could never actually decide anything — an agent and a deactivated admin.
    people = [
      person("OWNER", "SUPER_ADMIN", null, true),
      person("E1", "EMPLOYEE", "OWNER", false),
      person("E2", "EMPLOYEE", "OWNER", false),
      person("BOT", "ADMIN", null, true, { isAgent: true }),
      person("GONE", "ADMIN", null, true, { status: "INACTIVE" })
    ];
    rows = new Map([[ENTRY_ID, entry("OWNER")]]);
    client = fakeClient();
    actorId = "OWNER";
  });

  it("may approve their own entry, and the audit records that they were the sole approver", async () => {
    const res = await approve();
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(rows.get(ENTRY_ID)!.status).toBe("APPROVED");
    expect(audited("timesheet.approved")[0][4]).toMatchObject({ soleApprover: true });
  });

  it("sees their own entries in their own queue", async () => {
    await request(buildApp()).get("/api/timesheets/approval-queue");
    const where = (vi.mocked(client.timesheet.findMany).mock.calls[0][0] as any).where;
    expect(where.userId.notIn).not.toContain("OWNER");
  });

  it("loses the exception the moment a second person could decide it", async () => {
    people.push(person("ADMIN2", "ADMIN", null, true));
    const res = await approve();
    expect(res.status).toBe(403);
    expect(rows.get(ENTRY_ID)!.status).toBe("SUBMITTED");
  });

  it("does not record soleApprover on an ordinary decision of somebody else's entry", async () => {
    rows = new Map([[ENTRY_ID, entry("E1")]]);
    await approve();
    expect(audited("timesheet.approved")[0][4]?.soleApprover).toBeUndefined();
  });
});

describe("the SLA sweep escalates only to someone who may decide the entry", () => {
  it("never escalates the root's entry to the root — it goes to an approver who may decide it", async () => {
    // The admin fallback used to be `findFirst` over ADMIN/SUPER_ADMIN with no exclusions, and the
    // only super admin here is the author.
    people = [person("TOP", "SUPER_ADMIN", null, true), person("ADM", "ADMIN", "TOP", true)];
    rows = new Map([[ENTRY_ID, entry("TOP")]]);
    client = fakeClient();
    await runInTenant(client, () => processSlaSweep(new Date("2026-10-02T00:00:00.000Z")), "org-1");
    expect(escalations.map((e) => e.escalatedToId)).toEqual(["ADM"]);
  });

  it("never escalates to a subordinate the decision would refuse — with nobody eligible it writes no Escalation row", async () => {
    // HEAD (no approve right) manages SA, SA manages ADM. SA has a manager, so ADM may not decide
    // SA's hours; HEAD cannot approve at all. SA is the only person who could.
    people = [person("HEAD", "EMPLOYEE", null, false), person("SA", "SUPER_ADMIN", "HEAD", true), person("ADM", "ADMIN", "SA", true)];
    rows = new Map([[ENTRY_ID, entry("SA")]]);
    client = fakeClient();
    // Listed ADM first, so the old fallback's first ADMIN/SUPER_ADMIN is the refused subordinate.
    people = [people[2], people[0], people[1]];
    const result = await runInTenant(client, () => processSlaSweep(new Date("2026-10-02T00:00:00.000Z")), "org-1");
    expect(escalations).toEqual([]);
    expect(result.escalations).toBe(0);
    // The breach is still marked, so the sweep does not re-process the row every tick.
    expect(rows.get(ENTRY_ID)!.slaBreachAt).toEqual(new Date("2026-10-02T00:00:00.000Z"));
  });

  it("still escalates an ordinary entry to the manager's manager", async () => {
    people = [person("TOP", "SUPER_ADMIN", null, true), person("MGR", "MANAGER", "TOP", true), person("EMP", "EMPLOYEE", "MGR", false)];
    rows = new Map([[ENTRY_ID, entry("EMP")]]);
    client = fakeClient();
    await runInTenant(client, () => processSlaSweep(new Date("2026-10-02T00:00:00.000Z")), "org-1");
    expect(escalations.map((e) => e.escalatedToId)).toEqual(["TOP"]);
  });
});
