/**
 * Deciding a timesheet: who may, what everyone is told, and what happens when two people decide at
 * once.
 *
 * THE DEFECTS THIS PINS (audit 2026-10, timesheets #1, #2 and #8):
 *  - BULK REJECT TOLD NOBODY. The rejection notification and the per-row `timesheet.rejected` audit
 *    lived only in the single `/:id/reject` route; `decide-bulk` called `rejectCore` directly, so a
 *    manager ticking five rows and rejecting them sent five silent refusals — while the page's toast
 *    promised "each submitter gets the same notification a single decision sends".
 *  - ANYONE WITH `timesheets:approve` COULD APPROVE ANYTHING, including their own entry and their
 *    own manager's. Both cores checked only the status.
 *  - TWO DECISIONS COULD BOTH LAND. The write was `update where { id }` after a status read, so a
 *    double-click, or a manager and an admin deciding together, produced two "approved" emails and
 *    two audits — and approve racing reject left a REJECTED row carrying a billing snapshot.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { PrismaClient } from "@prisma/client";
import { runInTenant } from "../helpers/tenant-context.js";

/** M manages L, L manages E, and M reports to a director D — M needs a manager of their own for
 *  "never someone above you" to apply to them; the top of a tree is anyone's but their own to
 *  decide (timesheet-approval-root.test.ts). A is an admin outside the line. */
const ADMIN = { id: "admin-1", name: "Ada Admin", email: "ada@x.io", role: "ADMIN", permissions: ["timesheets:write", "timesheets:approve", "users:manage"] };
const MANAGER = { id: "mgr-1", name: "Mo Manager", email: "mo@x.io", role: "MANAGER", permissions: ["timesheets:write", "timesheets:approve", "reports:view"] };
const LEAD = { id: "lead-1", name: "Lee Lead", email: "lee@x.io", role: "TEAM_LEAD", permissions: ["timesheets:write", "timesheets:approve", "reports:view"] };
const EMPLOYEE = { id: "emp-1", name: "Eve Employee", email: "eve@x.io", role: "EMPLOYEE", permissions: ["timesheets:write"] };
const DIRECTOR = { id: "dir-1", name: "Dee Director", email: "dee@x.io", role: "EMPLOYEE", permissions: ["timesheets:write"] };

const PEOPLE = [
  { ...ADMIN, managerId: null },
  { ...DIRECTOR, managerId: null },
  { ...MANAGER, managerId: DIRECTOR.id },
  { ...LEAD, managerId: MANAGER.id },
  { ...EMPLOYEE, managerId: LEAD.id }
];

let actor: { id: string; name: string; email: string; role: string; permissions: string[] } = MANAGER;

vi.mock("../../src/middleware/auth.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/middleware/auth.js")>("../../src/middleware/auth.js");
  return {
    ...actual,
    requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
      req.user = { ...actor } as never;
      next();
    },
    requirePermission: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next()
  };
});
vi.mock("../../src/services/audit.service.js", () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../src/services/notify.service.js", () => ({ dispatchNotification: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../src/services/face.service.js", () => ({
  isFaceVerificationRequired: vi.fn().mockResolvedValue(false),
  consumeVerification: vi.fn().mockResolvedValue(null),
  bindVerificationToRecord: vi.fn().mockResolvedValue(undefined),
  unbindTimesheetVerification: vi.fn().mockResolvedValue([]),
  getTimesheetVerificationBadges: vi.fn().mockResolvedValue(new Map())
}));
vi.mock("../../src/services/sla.service.js", () => ({
  computeApprovalDeadline: vi.fn().mockReturnValue(null),
  resolveEscalationsFor: vi.fn().mockResolvedValue(undefined)
}));
vi.mock("../../src/services/billing-rate.service.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/services/billing-rate.service.js")>("../../src/services/billing-rate.service.js");
  return {
    ...actual,
    buildRateSnapshotPatch: vi.fn().mockResolvedValue({ billedRate: 100, billedAmount: 300, billedCurrency: "USD" })
  };
});
vi.mock("../../src/services/domain-events.js", () => ({ emitDomainEvent: vi.fn() }));

const { timesheetRouter } = await import("../../src/controllers/timesheet.controller.js");
const { errorHandler, AppError } = await import("../../src/middleware/error.js");
const { dispatchNotification } = await import("../../src/services/notify.service.js");
const { audit } = await import("../../src/services/audit.service.js");
const face = await import("../../src/services/face.service.js");
const sla = await import("../../src/services/sla.service.js");

const ID_1 = "11111111-1111-4111-8111-111111111111";
const ID_2 = "22222222-2222-4222-8222-222222222222";

interface Row {
  id: string;
  userId: string;
  status: string;
  [key: string]: unknown;
}

let rows: Map<string, Row>;
let client: PrismaClient;

function entry(id: string, userId: string, status = "SUBMITTED"): Row {
  return {
    id,
    userId,
    status,
    projectId: "p-1",
    moduleId: "m-1",
    submoduleId: null,
    activityType: "Development",
    taskDescription: "<p>Built the importer</p>",
    notes: "",
    workDate: new Date("2026-09-28T00:00:00.000Z"),
    startTime: "09:00",
    endTime: "12:00",
    totalHours: 3,
    billable: true,
    deletedAt: null
  };
}

/** Matches the subset of a Prisma `where` the decision cores use. */
function matches(row: Row, where: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(where)) {
    if (key === "deletedAt" && value === null) {
      if (row.deletedAt) return false;
      continue;
    }
    if (row[key] !== value) return false;
  }
  return true;
}

const withRelations = (row: Row) => ({
  ...row,
  project: { id: "p-1", name: "Apollo" },
  module: { name: "Importer" },
  submodule: null,
  user: PEOPLE.find((p) => p.id === row.userId)
});

function fakeClient(): PrismaClient {
  const c = {
    timesheet: {
      findFirst: vi.fn(async ({ where }: any) => {
        const row = rows.get(where.id);
        return row && matches(row, where) ? { ...row } : null;
      }),
      findUniqueOrThrow: vi.fn(async ({ where }: any) => {
        const row = rows.get(where.id);
        if (!row) throw new Error("not found");
        return withRelations(row);
      }),
      updateMany: vi.fn(async ({ where, data }: any) => {
        const row = rows.get(where.id);
        if (!row || !matches(row, where)) return { count: 0 };
        rows.set(row.id, { ...row, ...data });
        return { count: 1 };
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const row = { ...rows.get(where.id)!, ...data };
        rows.set(row.id, row);
        return withRelations(row);
      })
    },
    user: {
      findMany: vi.fn(async () => PEOPLE.map((p) => ({ id: p.id, email: p.email, managerId: p.managerId, status: "ACTIVE", deletedAt: null })))
    },
    project: { findUnique: vi.fn(async () => ({ slaApprovalHours: 48 })) }
  };
  return c as unknown as PrismaClient;
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((_req, _res, next) => runInTenant(client, async () => next(), "org-1").catch(next));
  app.use("/api/timesheets", timesheetRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  actor = MANAGER;
  rows = new Map([[ID_1, entry(ID_1, EMPLOYEE.id)], [ID_2, entry(ID_2, EMPLOYEE.id)]]);
  client = fakeClient();
  vi.mocked(dispatchNotification).mockClear();
  vi.mocked(audit).mockClear();
  vi.mocked(face.isFaceVerificationRequired).mockResolvedValue(false);
  vi.mocked(face.consumeVerification).mockClear();
  vi.mocked(face.unbindTimesheetVerification).mockClear();
  vi.mocked(sla.computeApprovalDeadline).mockClear();
});

const notified = (category: string) => vi.mocked(dispatchNotification).mock.calls.map((c) => c[0]).filter((n) => n.category === category);
const audited = (action: string) => vi.mocked(audit).mock.calls.filter((c) => c[1] === action);

describe("bulk reject tells every submitter, exactly as a single reject does", () => {
  it("notifies the author of every rejected row and audits each one", async () => {
    const res = await request(buildApp())
      .patch("/api/timesheets/decide-bulk")
      .send({ ids: [ID_1, ID_2], decision: "reject", reason: "Logged against the wrong project" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual({ done: 2, failed: [] });

    const rejections = notified("timesheet.rejected");
    expect(rejections).toHaveLength(2);
    expect(rejections.every((n) => n.userId === EMPLOYEE.id)).toBe(true);
    expect(rejections[0].body).toContain("Logged against the wrong project");
    expect(rejections[0].email?.templateKey).toBe("timesheet.rejected");

    // One per row, with the reason — the batch summary row is not a substitute for them.
    expect(audited("timesheet.rejected").map((c) => c[3]).sort()).toEqual([ID_1, ID_2]);
    expect(audited("timesheet.rejected")[0][4]).toEqual({ reason: "Logged against the wrong project" });
  });

  it("still notifies and audits once for a single reject (the route no longer carries its own copy)", async () => {
    const res = await request(buildApp()).patch(`/api/timesheets/${ID_1}/reject`).send({ reason: "Wrong activity type" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(notified("timesheet.rejected")).toHaveLength(1);
    expect(audited("timesheet.rejected")).toHaveLength(1);
  });
});

describe("segregation of duties", () => {
  it("refuses approving your own entry, whatever your role", async () => {
    for (const reviewer of [MANAGER, ADMIN]) {
      actor = reviewer;
      rows.set(ID_1, entry(ID_1, reviewer.id));
      const res = await request(buildApp()).patch(`/api/timesheets/${ID_1}/approve`).send({});
      expect(res.status, `${reviewer.role}: ${JSON.stringify(res.body)}`).toBe(403);
      expect(res.body.message).toMatch(/your own/i);
      expect(rows.get(ID_1)!.status).toBe("SUBMITTED");
    }
  });

  it("refuses rejecting your own entry too", async () => {
    rows.set(ID_1, entry(ID_1, MANAGER.id));
    const res = await request(buildApp()).patch(`/api/timesheets/${ID_1}/reject`).send({ reason: "Changed my mind" });
    expect(res.status).toBe(403);
    expect(rows.get(ID_1)!.status).toBe("SUBMITTED");
  });

  it("refuses deciding an entry by someone above you in your reporting line", async () => {
    // L reports to M. L holds timesheets:approve, but M's hours are not L's to sign off.
    actor = LEAD;
    rows.set(ID_1, entry(ID_1, MANAGER.id));
    const res = await request(buildApp()).patch(`/api/timesheets/${ID_1}/approve`).send({});
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(res.body.message).toMatch(/report/i);
    expect(rows.get(ID_1)!.status).toBe("SUBMITTED");
  });

  it("still lets an approver decide for someone outside their reporting line — no reporting-line rule", async () => {
    // ADMIN manages nobody here; E is not in their line at all. That is how teams use approvals today.
    actor = ADMIN;
    const res = await request(buildApp()).patch(`/api/timesheets/${ID_1}/approve`).send({});
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(rows.get(ID_1)!.status).toBe("APPROVED");
  });

  it("refuses an own entry inside a bulk batch on its own row, and decides the rest", async () => {
    rows.set(ID_2, entry(ID_2, MANAGER.id));
    const res = await request(buildApp()).patch("/api/timesheets/decide-bulk").send({ ids: [ID_1, ID_2], decision: "approve" });
    expect(res.status).toBe(200);
    expect(res.body.done).toBe(1);
    expect(res.body.failed).toEqual([{ id: ID_2, reason: expect.stringMatching(/your own/i) }]);
    expect(rows.get(ID_2)!.status).toBe("SUBMITTED");
  });
});

describe("a decision lands once", () => {
  it("writes conditionally on the entry still being SUBMITTED", async () => {
    await request(buildApp()).patch(`/api/timesheets/${ID_1}/approve`).send({});
    const call = vi.mocked(client.timesheet.updateMany).mock.calls[0][0] as any;
    expect(call.where).toMatchObject({ id: ID_1, status: "SUBMITTED" });
  });

  it("answers 409 to the loser of a race, with no second email or audit", async () => {
    // Both requests read SUBMITTED before either writes — what interleaving under load looks like.
    const stale = { ...rows.get(ID_1)! };
    vi.mocked(client.timesheet.findFirst).mockResolvedValue(stale as never);

    const first = await request(buildApp()).patch(`/api/timesheets/${ID_1}/approve`).send({});
    const second = await request(buildApp()).patch(`/api/timesheets/${ID_1}/approve`).send({});
    expect(first.status).toBe(200);
    expect(second.status).toBe(409);
    expect(second.body.message).toMatch(/already/i);
    expect(notified("timesheet.approved")).toHaveLength(1);
    expect(audited("timesheet.approved")).toHaveLength(1);
  });

  it("cannot reject an entry another reviewer approved a moment ago", async () => {
    const stale = { ...rows.get(ID_1)! };
    vi.mocked(client.timesheet.findFirst).mockResolvedValue(stale as never);

    await request(buildApp()).patch(`/api/timesheets/${ID_1}/approve`).send({});
    const reject = await request(buildApp()).patch(`/api/timesheets/${ID_1}/reject`).send({ reason: "Too late for this" });
    expect(reject.status).toBe(409);
    // The approval stands untouched: no rejection reason grafted onto an approved, rated row.
    expect(rows.get(ID_1)!.status).toBe("APPROVED");
    expect(rows.get(ID_1)!.rejectionReason).toBeUndefined();
    expect(notified("timesheet.rejected")).toHaveLength(0);
  });
});

/**
 * Reopening an APPROVED entry (audit 2026-10, timesheets #4).
 *
 * An approved entry had no way out: PATCH refuses a decided entry, DELETE refuses it even for an
 * approver, and the advised "correcting entry" cannot be logged — negative hours are refused and an
 * overlapping one is a 409. So one mistaken (bulk) approval stood in billedAmount, budget burn and
 * attestations for good. Reopen is the Harvest/Tempo "unapprove": an approver, never the author,
 * sends it back to SUBMITTED with a stated reason; the frozen rate is cleared and the author is told.
 */
describe("reopening an approved entry", () => {
  const approved = () => ({
    ...entry(ID_1, EMPLOYEE.id, "APPROVED"),
    reviewedById: MANAGER.id,
    reviewedAt: new Date("2026-09-29T10:00:00.000Z"),
    billedRate: 100,
    billedAmount: 300,
    billedCurrency: "USD",
    billedRateSource: "USER",
    rateSnapshotAt: new Date("2026-09-29T10:00:00.000Z")
  });
  const reopen = (body: Record<string, unknown> = { reason: "Approved the wrong day by mistake" }) =>
    request(buildApp()).post(`/api/timesheets/${ID_1}/reopen`).send(body);

  beforeEach(() => {
    rows.set(ID_1, approved());
  });

  it("puts it back in the queue as SUBMITTED, with the frozen rate cleared and a fresh review clock", async () => {
    const res = await reopen();
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const row = rows.get(ID_1)!;
    expect(row.status).toBe("SUBMITTED");
    for (const field of ["billedRate", "billedAmount", "billedCurrency", "billedRateSource", "rateSnapshotAt", "reviewedById", "reviewedAt"]) {
      expect(row[field], field).toBeNull();
    }
    expect(row).toHaveProperty("approvalDeadline");
    expect(row.slaBreachAt).toBeNull();
  });

  it("audits who reopened it, why, and what the approval had frozen", async () => {
    await reopen();
    const entryAudit = audited("timesheet.reopened")[0];
    expect(entryAudit[0]).toBe(MANAGER.id);
    expect(entryAudit[4]).toMatchObject({ reason: "Approved the wrong day by mistake", previous: { billedAmount: 300, reviewedById: MANAGER.id } });
  });

  it("tells the author, with the reason", async () => {
    await reopen();
    const note = notified("timesheet.reopened")[0];
    expect(note.userId).toBe(EMPLOYEE.id);
    expect(note.body).toContain("Approved the wrong day by mistake");
  });

  it("requires a reason", async () => {
    const res = await reopen({ reason: "  " });
    expect(res.status).toBe(422);
    expect(rows.get(ID_1)!.status).toBe("APPROVED");
  });

  it("is never the author's to do — not even an approver reopening their own approved hours", async () => {
    actor = MANAGER;
    rows.set(ID_1, { ...approved(), userId: MANAGER.id });
    const res = await reopen();
    expect(res.status).toBe(403);
    expect(rows.get(ID_1)!.status).toBe("APPROVED");
  });

  it("only reopens an APPROVED entry", async () => {
    rows.set(ID_1, entry(ID_1, EMPLOYEE.id, "REJECTED"));
    expect((await reopen()).status).toBe(422);
  });

  it("starts a new review round: submittedAt is now, so approval latency counts this round", async () => {
    const before = Date.now();
    await reopen();
    const submittedAt = rows.get(ID_1)!.submittedAt as Date;
    expect(submittedAt).toBeInstanceOf(Date);
    expect(submittedAt.getTime()).toBeGreaterThanOrEqual(before);
    // The same instant the new deadline is computed from.
    expect(vi.mocked(sla.computeApprovalDeadline).mock.calls[0][0]).toEqual(submittedAt);
  });

  it("unlinks the first approval's identity check, so it is never credited to the next approval", async () => {
    vi.mocked(face.unbindTimesheetVerification).mockResolvedValueOnce(["approval-attempt-1"]);
    await reopen();
    expect(face.unbindTimesheetVerification).toHaveBeenCalledWith(ID_1, "APPROVAL");
    expect(audited("timesheet.reopened")[0][4]).toMatchObject({ approvalVerificationUnlinked: ["approval-attempt-1"] });
  });

  it("lands once: a second reopen racing the first gets 409 and sends nothing", async () => {
    const stale = { ...rows.get(ID_1)! };
    vi.mocked(client.timesheet.findFirst).mockResolvedValue(stale as never);
    expect((await reopen()).status).toBe(200);
    expect((await reopen()).status).toBe(409);
    expect(notified("timesheet.reopened")).toHaveLength(1);
    expect(audited("timesheet.reopened")).toHaveLength(1);
  });
});

/**
 * The approver's identity check is single-use (audit 2026-10 R3, timesheet minors). It used to be
 * spent BEFORE the status and scope checks, so an approval the server then refused — not yours to
 * decide (403), already decided (422) — burned a webcam capture and sent the approver to take
 * another for nothing.
 */
describe("the identity check is spent only on an approval that can land", () => {
  beforeEach(() => {
    vi.mocked(face.isFaceVerificationRequired).mockResolvedValue(true);
  });

  it("is not spent when the entry is the approver's own (403)", async () => {
    rows.set(ID_1, entry(ID_1, MANAGER.id));
    const res = await request(buildApp()).patch(`/api/timesheets/${ID_1}/approve`).send({ faceVerificationId: "attempt-1" });
    expect(res.status).toBe(403);
    expect(face.consumeVerification).not.toHaveBeenCalled();
  });

  it("is not spent when the entry was already decided (422)", async () => {
    rows.set(ID_1, entry(ID_1, EMPLOYEE.id, "APPROVED"));
    const res = await request(buildApp()).patch(`/api/timesheets/${ID_1}/approve`).send({ faceVerificationId: "attempt-1" });
    expect(res.status).toBe(422);
    expect(face.consumeVerification).not.toHaveBeenCalled();
  });

  it("is spent, bound to the entry, on an approval that goes through", async () => {
    const res = await request(buildApp()).patch(`/api/timesheets/${ID_1}/approve`).send({ faceVerificationId: "attempt-1" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(face.consumeVerification).toHaveBeenCalledTimes(1);
    expect(vi.mocked(face.consumeVerification).mock.calls[0][0]).toMatchObject({ verificationId: "attempt-1", context: "APPROVAL", timesheetId: ID_1 });
  });

  it("still refuses an approval without a passing check, writing nothing", async () => {
    vi.mocked(face.consumeVerification).mockRejectedValueOnce(new AppError(428, "Identity verification is required before this can be submitted."));
    const res = await request(buildApp()).patch(`/api/timesheets/${ID_1}/approve`).send({});
    expect(res.status).toBe(428);
    expect(rows.get(ID_1)!.status).toBe("SUBMITTED");
  });

  it("bulk: is not spent when every row is refused", async () => {
    rows.set(ID_1, entry(ID_1, MANAGER.id));
    rows.set(ID_2, entry(ID_2, EMPLOYEE.id, "REJECTED"));
    const res = await request(buildApp()).patch("/api/timesheets/decide-bulk").send({ ids: [ID_1, ID_2], decision: "approve", faceVerificationId: "attempt-1" });
    expect(res.status).toBe(200);
    expect(res.body.done).toBe(0);
    expect(face.consumeVerification).not.toHaveBeenCalled();
  });

  it("bulk: is spent once, on the first row that can land, for the whole batch", async () => {
    rows.set(ID_1, entry(ID_1, MANAGER.id));
    const res = await request(buildApp()).patch("/api/timesheets/decide-bulk").send({ ids: [ID_1, ID_2], decision: "approve", faceVerificationId: "attempt-1" });
    expect(res.body).toMatchObject({ done: 1 });
    expect(face.consumeVerification).toHaveBeenCalledTimes(1);
    expect(vi.mocked(face.consumeVerification).mock.calls[0][0]).toMatchObject({ timesheetId: ID_2 });
  });

  it("bulk: a failed check fails the whole batch, as before, with nothing written", async () => {
    vi.mocked(face.consumeVerification).mockRejectedValueOnce(new AppError(428, "That identity check has expired — please verify again."));
    const res = await request(buildApp()).patch("/api/timesheets/decide-bulk").send({ ids: [ID_1, ID_2], decision: "approve", faceVerificationId: "attempt-1" });
    expect(res.status).toBe(428);
    expect(rows.get(ID_1)!.status).toBe("SUBMITTED");
    expect(rows.get(ID_2)!.status).toBe("SUBMITTED");
  });
});
