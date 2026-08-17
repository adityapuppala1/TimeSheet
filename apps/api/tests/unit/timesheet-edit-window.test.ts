/**
 * WHO may correct a timesheet entry, and until when.
 *
 * THE LINE IS "UNDECIDED": the author may correct their own DRAFT or SUBMITTED entry, and neither
 * of the two decided states.
 *
 * SUBMITTED is IN because the window originally copied `DELETE`'s, which conflated two different
 * acts — deleting a submitted entry erases a request somebody is being asked to decide on, but
 * fixing a typo in it does not. Excluding it sent the author to their approver to change one word,
 * and an approver's only "send it back" tool is a REJECTION, so a spelling mistake cost a
 * rejection, a notification and a re-submission.
 *
 * APPROVED and REJECTED are both OUT because a reviewer has recorded a decision against them.
 * Approved hours carry a frozen rate and feed cost reports and Verified Work Attestations; a
 * rejected entry carries the reviewer's stated reason, and rewriting the text that reason refers
 * to leaves it attached to something it was never about.
 *
 * AND THE REVIEWER HAS NO EXEMPTION. `TIMESHEETS_APPROVE` originally reached any status, on the
 * argument that whoever decides whether hours are payable can also correct them. That exemption is
 * gone: it undoes precisely what the decision is for, and it would do so under the same audit
 * entry a routine typo fix produces. A correction to a decided entry is a NEW entry.
 *
 * The rule is easy to get subtly wrong in either direction — too narrow and people cannot fix
 * their own work, too wide and decided records rewrite themselves — so every edge is pinned.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { PrismaClient } from "@prisma/client";
import { runInTenant } from "../helpers/tenant-context.js";

const AUTHOR = { id: "author-1", name: "Ava Author", email: "ava@x.io", role: "EMPLOYEE", permissions: ["timesheets:write"] };
const MANAGER = {
  id: "mgr-1",
  name: "Mo Manager",
  email: "mo@x.io",
  role: "MANAGER",
  permissions: ["timesheets:write", "timesheets:approve"]
};

/** Swapped per test — the routes read `req.user`, so this is the whole identity surface. */
let actor: typeof AUTHOR = AUTHOR;

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
  getTimesheetVerificationBadges: vi.fn().mockResolvedValue(new Map())
}));
vi.mock("../../src/services/sla.service.js", () => ({
  computeApprovalDeadline: vi.fn().mockReturnValue(null),
  resolveEscalationsFor: vi.fn().mockResolvedValue(undefined)
}));
vi.mock("../../src/services/domain-events.js", () => ({ emitDomainEvent: vi.fn() }));

const { timesheetRouter } = await import("../../src/controllers/timesheet.controller.js");
const { errorHandler } = await import("../../src/middleware/error.js");
const { dispatchNotification } = await import("../../src/services/notify.service.js");

let client: PrismaClient;

/** An entry owned by AUTHOR, in whatever status the case is about. */
function entryIn(status: string) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    userId: AUTHOR.id,
    status,
    projectId: "22222222-2222-4222-8222-222222222222",
    moduleId: "33333333-3333-4333-8333-333333333333",
    submoduleId: null,
    ticketId: null,
    activityType: "Development",
    taskDescription: "<p>Original description of the work</p>",
    notes: "",
    workDate: new Date("2026-08-10T00:00:00.000Z"),
    startTime: "09:00",
    endTime: "12:00",
    totalHours: 3,
    billable: true,
    billedRate: null,
    deletedAt: null
  };
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => runInTenant(client, async () => next(), "org-1").catch(next));
  app.use("/api/timesheets", timesheetRouter);
  app.use(errorHandler);
  return app;
}

function mockClient(status: string) {
  const entry = entryIn(status);
  return {
    timesheet: {
      // Carries the relations the SUBMIT route asks for (`project` for the SLA hours, `user` +
      // `manager` for the notifications). The PATCH route reads the same row without includes, so
      // the extra fields are harmless there.
      findFirst: vi.fn().mockResolvedValue({
        ...entry,
        project: { id: entry.projectId, name: "Apollo", slaApprovalHours: 48 },
        user: { id: AUTHOR.id, name: AUTHOR.name, email: AUTHOR.email, managerId: MANAGER.id, manager: { id: MANAGER.id, name: MANAGER.name } }
      }),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockImplementation(({ data }: any) => ({
        ...entry,
        ...data,
        workDate: data.workDate ?? entry.workDate,
        project: { id: entry.projectId, name: "Apollo" },
        user: { id: AUTHOR.id, name: AUTHOR.name, email: AUTHOR.email }
      }))
    },
    projectModule: { findFirst: vi.fn().mockResolvedValue({ id: entry.moduleId, projectId: entry.projectId }) },
    projectSubmodule: { findFirst: vi.fn().mockResolvedValue(null) },
    ticket: { findFirst: vi.fn().mockResolvedValue(null) },
    user: { findUnique: vi.fn().mockResolvedValue({ managerId: MANAGER.id }), findMany: vi.fn().mockResolvedValue([]) },
    // The route wraps the overlap check + update in a transaction; run the callback inline.
    $transaction: vi.fn().mockImplementation(async (fn: any) => fn(clientRef))
  } as unknown as PrismaClient;
}

let clientRef: PrismaClient;

beforeEach(() => {
  actor = AUTHOR;
  client = mockClient("DRAFT");
  clientRef = client;
  vi.mocked(dispatchNotification).mockClear();
});

const patch = (body: Record<string, unknown>) =>
  request(buildApp()).patch("/api/timesheets/11111111-1111-4111-8111-111111111111").send(body);

describe("the author's edit window", () => {
  // UNDECIDED is the line. SUBMITTED is in because fixing a typo is not the same as withdrawing
  // the request — excluding it meant a one-word correction cost a rejection and a re-submission.
  for (const status of ["DRAFT", "SUBMITTED"]) {
    it(`lets them correct their own ${status} entry`, async () => {
      client = mockClient(status);
      clientRef = client;
      const response = await patch({ taskDescription: "<p>A corrected description of the work</p>" });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(client.timesheet.update).toHaveBeenCalled();
    });
  }

  // …and both DECIDED states are out, for the same underlying reason: a reviewer has recorded
  // something against the entry, and rewriting it afterwards changes what that decision was about.
  it("stops at APPROVED, and says why rather than just refusing", async () => {
    client = mockClient("APPROVED");
    clientRef = client;
    const response = await patch({ taskDescription: "<p>A corrected description of the work</p>" });
    expect(response.status).toBe(422);
    // The message has to name the reason and the way forward — "forbidden" teaches nothing.
    expect(response.body.message).toMatch(/approved/i);
    expect(response.body.message).toMatch(/billing record|correcting entry/i);
    expect(client.timesheet.update).not.toHaveBeenCalled();
  });

  it("stops at REJECTED, pointing at a fresh entry rather than a rewrite", async () => {
    // Rewriting the text a rejection reason refers to leaves that reason attached to something it
    // was never about. The rejected row stays deletable, so the path forward is a new entry.
    client = mockClient("REJECTED");
    clientRef = client;
    const response = await patch({ taskDescription: "<p>A corrected description of the work</p>" });
    expect(response.status).toBe(422);
    expect(response.body.message).toMatch(/rejected/i);
    expect(response.body.message).toMatch(/fresh entry/i);
    expect(client.timesheet.update).not.toHaveBeenCalled();
  });

  it("refuses somebody else's entry outright", async () => {
    actor = { ...AUTHOR, id: "someone-else" };
    const response = await patch({ taskDescription: "<p>A corrected description of the work</p>" });
    expect(response.status).toBe(403);
    expect(client.timesheet.update).not.toHaveBeenCalled();
  });
});

describe("an approver's edit window", () => {
  it("reaches somebody else's UNDECIDED entry, which is the point of the role", async () => {
    actor = MANAGER;
    client = mockClient("SUBMITTED");
    clientRef = client;
    const response = await patch({ taskDescription: "<p>A corrected description of the work</p>" });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
  });

  // The reviewer has NO exemption from immutability, and this is the test that says so. It began
  // life asserting the opposite: the original rule let TIMESHEETS_APPROVE edit any status, on the
  // argument that whoever decides whether hours are payable can also correct them. That undoes
  // what the decision is for — an approved entry carries a frozen rate a client may already have
  // been shown, and it would change under the same audit entry a routine typo fix produces.
  for (const status of ["APPROVED", "REJECTED"]) {
    it(`cannot edit a ${status} entry either — a decision is a decision`, async () => {
      actor = MANAGER;
      client = mockClient(status);
      clientRef = client;
      const response = await patch({ taskDescription: "<p>A corrected description of the work</p>" });
      expect(response.status, JSON.stringify(response.body)).toBe(422);
      expect(client.timesheet.update).not.toHaveBeenCalled();
    });
  }
});

describe("who changed it is recorded and announced", () => {
  it("stamps the editor on every edit, including the author's own", async () => {
    await patch({ taskDescription: "<p>A corrected description of the work</p>" });
    const data = vi.mocked(client.timesheet.update).mock.calls[0][0].data as Record<string, unknown>;
    expect(data.lastEditedById).toBe(AUTHOR.id);
    expect(data.lastEditedAt).toBeInstanceOf(Date);
  });

  it("tells the approver when the author changes something already in their queue", async () => {
    // The counterpart of widening the author's window past submission: the approver may have read
    // this entry already, so what they are deciding on must not change behind them.
    client = mockClient("SUBMITTED");
    clientRef = client;
    await patch({ taskDescription: "<p>A corrected description of the work</p>" });
    expect(dispatchNotification).toHaveBeenCalledWith(
      expect.objectContaining({ userId: MANAGER.id, category: "timesheet.updated" })
    );
  });

  it("tells the author when a reviewer changes their entry", async () => {
    actor = MANAGER;
    client = mockClient("SUBMITTED");
    clientRef = client;
    await patch({ taskDescription: "<p>A corrected description of the work</p>" });
    expect(dispatchNotification).toHaveBeenCalledWith(
      expect.objectContaining({ userId: AUTHOR.id, category: "timesheet.updated" })
    );
  });

  it("says nothing when nothing actually changed", async () => {
    // A PATCH that re-sends the stored values is a no-op, and notifying on it would train people
    // to ignore the notification that matters.
    await patch({ startTime: "09:00", endTime: "12:00" });
    expect(dispatchNotification).not.toHaveBeenCalled();
  });
});

/**
 * POST /timesheets/:id/submit — the transition that did not exist.
 *
 * `saveTimesheet` only ever CREATES a row, so "Save draft" was a one-way door: a draft could be
 * edited forever and never actually submitted. The only escapes were to delete it and re-type the
 * whole entry, or to leave it in History as permanently unsubmitted work. That also made the
 * widened edit window half a feature — correcting a draft is pointless if the corrected draft
 * cannot go anywhere.
 */
describe("submitting an existing draft", () => {
  const submit = () => request(buildApp()).post("/api/timesheets/11111111-1111-4111-8111-111111111111/submit").send({});

  it("moves a DRAFT into the queue, stamping the submit time and the SLA deadline", async () => {
    const response = await submit();
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const data = vi.mocked(client.timesheet.update).mock.calls[0][0].data as Record<string, unknown>;
    expect(data.status).toBe("SUBMITTED");
    // Both are what make the entry visible to the SLA sweeps and the approval-latency metric —
    // a status flip on its own would be a row nothing downstream can reason about.
    expect(data.submittedAt).toBeInstanceOf(Date);
    expect(data).toHaveProperty("approvalDeadline");
  });

  it("notifies the submitter and their manager, exactly as a fresh submit does", async () => {
    await submit();
    const recipients = vi.mocked(dispatchNotification).mock.calls.map((call) => call[0].userId);
    expect(recipients).toContain(AUTHOR.id);
    expect(recipients).toContain(MANAGER.id);
  });

  for (const status of ["SUBMITTED", "APPROVED", "REJECTED"]) {
    it(`refuses a ${status} entry`, async () => {
      client = mockClient(status);
      clientRef = client;
      const response = await submit();
      expect(response.status).toBe(422);
      expect(client.timesheet.update).not.toHaveBeenCalled();
    });
  }

  it("refuses somebody else's draft when the caller cannot act for others", async () => {
    actor = { ...AUTHOR, id: "someone-else" };
    const response = await submit();
    expect(response.status).toBe(403);
    expect(client.timesheet.update).not.toHaveBeenCalled();
  });

  it("lets an approver submit on the author's behalf", async () => {
    actor = MANAGER;
    const response = await submit();
    expect(response.status, JSON.stringify(response.body)).toBe(200);
  });
});


/**
 * DELETE — and the overlap exclusion that keeps the narrowed rule from becoming a trap.
 *
 * The author's window is DRAFT alone. REJECTED came out of it for the same reason it came out of
 * the edit window: a rejection is a decision with the reviewer's reason attached, and erasing the
 * entry erases the record of that decision.
 *
 * That change is only safe because of one line in the overlap check. A REJECTED entry used to hold
 * its time slot, so an author who could no longer edit it, no longer delete it, AND could not
 * re-log those hours would have been stranded with no way to record work they actually did. The
 * overlap check now ignores refused entries — a refusal is the reviewer saying "this should not
 * stand", not a reservation on the clock.
 */
describe("deleting an entry", () => {
  const remove = () => request(buildApp()).delete("/api/timesheets/11111111-1111-4111-8111-111111111111");

  it("lets the author delete their own DRAFT", async () => {
    const response = await remove();
    expect(response.status, JSON.stringify(response.body)).toBe(204);
    expect(client.timesheet.update).toHaveBeenCalled();
  });

  it("refuses the author's REJECTED entry, and points at logging a fresh one", async () => {
    client = mockClient("REJECTED");
    clientRef = client;
    const response = await remove();
    expect(response.status).toBe(422);
    expect(response.body.message).toMatch(/rejected entry is the record of a decision/i);
    // The message must also say the way forward is not blocked — that is the half a user acts on.
    expect(response.body.message).toMatch(/fresh entry/i);
    expect(client.timesheet.update).not.toHaveBeenCalled();
  });

  for (const status of ["SUBMITTED", "APPROVED"]) {
    it(`refuses a ${status} entry`, async () => {
      client = mockClient(status);
      clientRef = client;
      const response = await remove();
      expect(response.status).toBe(422);
      expect(client.timesheet.update).not.toHaveBeenCalled();
    });
  }

  it("still lets an approver clear a REJECTED entry — the tidy-up case", async () => {
    actor = MANAGER;
    client = mockClient("REJECTED");
    clientRef = client;
    const response = await remove();
    expect(response.status, JSON.stringify(response.body)).toBe(204);
  });
});

describe("a refused entry does not hold its time slot", () => {
  /** The overlap query the create and edit paths run. */
  function overlapWhere(): Record<string, unknown> | undefined {
    const call = vi.mocked(client.timesheet.findMany).mock.calls.at(-1);
    return call?.[0]?.where as Record<string, unknown> | undefined;
  }

  it("excludes REJECTED when an edit re-checks overlap", async () => {
    // Without this, the correcting entry an author is told to log would be refused for clashing
    // with the very entry that was refused — the exact dead end the delete rule would create.
    await patch({ startTime: "10:00", endTime: "11:00" });
    expect(overlapWhere()?.status).toEqual({ not: "REJECTED" });
  });

  it("still counts every other status, so real double-booking is still caught", async () => {
    await patch({ startTime: "10:00", endTime: "11:00" });
    const where = overlapWhere();
    expect(where?.deletedAt).toBeNull();
    // Scoped to the ENTRY'S author, not the editor — a manager fixing someone else's row must not
    // be allowed to push it on top of another of that person's entries.
    expect(where?.userId).toBe(AUTHOR.id);
  });
});
