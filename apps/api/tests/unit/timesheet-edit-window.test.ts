/**
 * WHO may correct a timesheet entry, and until when.
 *
 * THE RULE THAT CHANGED, AND WHY: the author could originally only edit a DRAFT or REJECTED entry
 * — the same window `DELETE` allows. That conflated two different acts. Deleting a SUBMITTED entry
 * erases a request somebody is being asked to decide on; fixing a typo in it does not. The old
 * rule sent the author to their approver to change one word, and the approver's only tool for
 * "send it back" is a REJECTION — so a spelling mistake cost a rejection, a notification and a
 * re-submission.
 *
 * The author's window now runs to APPROVED, and stops there: approved hours carry a frozen rate
 * and feed cost reports and Verified Work Attestations, which is a record a client may already
 * have been shown.
 *
 * The pair of rules is easy to get subtly wrong in either direction — too narrow and people cannot
 * fix their own work, too wide and approved billing rewrites itself — so both edges are pinned.
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
      findFirst: vi.fn().mockResolvedValue(entry),
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
  for (const status of ["DRAFT", "SUBMITTED", "REJECTED"]) {
    it(`lets them correct their own ${status} entry`, async () => {
      client = mockClient(status);
      clientRef = client;
      const response = await patch({ taskDescription: "<p>A corrected description of the work</p>" });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(client.timesheet.update).toHaveBeenCalled();
    });
  }

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

  it("refuses somebody else's entry outright", async () => {
    actor = { ...AUTHOR, id: "someone-else" };
    const response = await patch({ taskDescription: "<p>A corrected description of the work</p>" });
    expect(response.status).toBe(403);
    expect(client.timesheet.update).not.toHaveBeenCalled();
  });
});

describe("an approver's edit window", () => {
  it("reaches an APPROVED entry, which the author's does not", async () => {
    actor = MANAGER;
    client = mockClient("APPROVED");
    clientRef = client;
    const response = await patch({ taskDescription: "<p>A corrected description of the work</p>" });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
  });
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
