/**
 * The Inbox's two load-bearing behaviours, driven through the REAL router.
 *
 * 1. OWNERSHIP IS THE AUTHORISATION. A notification is addressed to a person, and there is no
 *    permission that grants access to somebody else's queue — so every write must be filtered on
 *    the owner rather than looked up by id and then checked. `updateMany` with `{ id, userId }` is
 *    what makes a guessed id update zero rows instead of another user's inbox, and that is exactly
 *    the kind of thing a later refactor "simplifies" into `update({ where: { id } })`.
 * 2. A SNOOZE MUST COME BACK BY ITSELF. Hidden from the queue until its time passes, then present
 *    again with nobody re-filing it. A snooze that has to be remembered is a delete.
 *
 * The brief's arithmetic is tested separately in inbox-brief.test.ts, against mocked counts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const actor = { id: "u-1", name: "Emp", email: "e@x.io", role: "EMPLOYEE", permissions: [] as string[] };

const updateMany = vi.fn().mockResolvedValue({ count: 1 });
const findMany = vi.fn().mockResolvedValue([]);
const count = vi.fn().mockResolvedValue(0);

vi.mock("../../src/middleware/auth.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/middleware/auth.js")>("../../src/middleware/auth.js");
  return {
    ...actual,
    requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
      req.user = { ...actor, permissions: [...actor.permissions] } as never;
      next();
    }
  };
});

vi.mock("../../src/config/prisma.js", () => ({
  prisma: {
    notification: { findMany, count, updateMany },
    // Reached only by the brief, which has its own test file.
    timesheet: { count: vi.fn().mockResolvedValue(0) },
    approvalStep: { count: vi.fn().mockResolvedValue(0) },
    projectRiskSnapshot: { findMany: vi.fn().mockResolvedValue([]) },
    ticket: { findMany: vi.fn().mockResolvedValue([]) }
  }
}));

const { inboxRouter } = await import("../../src/controllers/inbox.controller.js");
const { errorHandler } = await import("../../src/middleware/error.js");

function app() {
  const a = express();
  a.use(express.json());
  a.use("/inbox", inboxRouter);
  a.use(errorHandler);
  return a;
}

beforeEach(() => {
  vi.clearAllMocks();
  updateMany.mockResolvedValue({ count: 1 });
  findMany.mockResolvedValue([]);
  count.mockResolvedValue(0);
});

describe("ownership is the authorisation", () => {
  it("scopes every write to the caller, so a guessed id matches nothing", async () => {
    await request(app()).patch("/inbox/someone-elses-id").send({ handled: true });
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "someone-elses-id", userId: "u-1" } })
    );
  });

  it("404s rather than silently succeeding when the row is not the caller's", async () => {
    updateMany.mockResolvedValue({ count: 0 });
    const res = await request(app()).patch("/inbox/not-mine").send({ handled: true });
    expect(res.status).toBe(404);
  });

  it("scopes the list to the caller", async () => {
    await request(app()).get("/inbox");
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ userId: "u-1" }) }));
  });

  it("scopes handle-all to the caller and never deletes", async () => {
    await request(app()).post("/inbox/handle-all");
    const call = updateMany.mock.calls[0][0];
    expect(call.where.userId).toBe("u-1");
    expect(call.data.handledAt).toBeInstanceOf(Date);
    // The row is the record that somebody was told. Clearing an inbox must not destroy it.
    expect(call.data).not.toHaveProperty("delete");
  });
});

describe("the queue's filters", () => {
  it("hides a still-snoozed row from the to-do list, and includes one whose time has passed", async () => {
    await request(app()).get("/inbox?filter=unhandled");
    const where = findMany.mock.calls[0][0].where;
    expect(where.handledAt).toBeNull();
    // Either never snoozed, or snoozed to a moment that has already arrived — the second half is
    // what makes a snooze return on its own.
    expect(where.OR).toEqual([{ snoozedUntil: null }, { snoozedUntil: { lte: expect.any(Date) } }]);
  });

  it("shows only future snoozes under 'snoozed'", async () => {
    await request(app()).get("/inbox?filter=snoozed");
    const where = findMany.mock.calls[0][0].where;
    expect(where.snoozedUntil).toEqual({ gt: expect.any(Date) });
    expect(where.handledAt).toBeNull();
  });

  it("falls back to the to-do list for an unknown filter rather than erroring", async () => {
    const res = await request(app()).get("/inbox?filter=nonsense");
    expect(res.status).toBe(200);
    expect(findMany.mock.calls[0][0].where.handledAt).toBeNull();
  });
});

describe("snoozing", () => {
  it("marks a snoozed row read, because the bell must stop insisting about deferred work", async () => {
    const until = new Date(Date.now() + 3600_000).toISOString();
    await request(app()).patch("/inbox/n-1").send({ snoozeUntil: until });
    const data = updateMany.mock.calls[0][0].data;
    expect(data.snoozedUntil).toEqual(new Date(until));
    expect(data.readAt).toBeInstanceOf(Date);
  });

  it("clamps an absurd snooze to a year rather than accepting a disguised delete", async () => {
    const tenYears = new Date(Date.now() + 3650 * 86_400_000).toISOString();
    await request(app()).patch("/inbox/n-1").send({ snoozeUntil: tenYears });
    const stored = updateMany.mock.calls[0][0].data.snoozedUntil as Date;
    expect(stored.getTime()).toBeLessThan(Date.now() + 366 * 86_400_000);
  });

  it("un-snoozes on null without touching handled state", async () => {
    await request(app()).patch("/inbox/n-1").send({ snoozeUntil: null });
    const data = updateMany.mock.calls[0][0].data;
    expect(data.snoozedUntil).toBeNull();
    expect(data).not.toHaveProperty("handledAt");
  });
});

describe("handled and read are different statements", () => {
  it("marking read does not mark handled", async () => {
    await request(app()).patch("/inbox/n-1").send({ read: true });
    const data = updateMany.mock.calls[0][0].data;
    expect(data.readAt).toBeInstanceOf(Date);
    expect(data).not.toHaveProperty("handledAt");
  });

  it("reopening clears handledAt without marking it unread", async () => {
    await request(app()).patch("/inbox/n-1").send({ handled: false });
    const data = updateMany.mock.calls[0][0].data;
    expect(data.handledAt).toBeNull();
    expect(data).not.toHaveProperty("readAt");
  });

  it("rejects unknown fields rather than ignoring them", async () => {
    // 422, this app's convention for a well-formed request whose contents fail validation — the
    // `.strict()` on the schema is what turns a typo'd field into a refusal instead of a no-op.
    const res = await request(app()).patch("/inbox/n-1").send({ handled: true, deleteIt: true });
    expect(res.status).toBe(422);
    expect(updateMany).not.toHaveBeenCalled();
  });
});

describe("the bell and the inbox agree about one table", () => {
  it("hides handled and still-snoozed rows from the bell, using the inbox's own predicate", async () => {
    // The bug this pins: before it, snoozing an item in the Inbox left it sitting in the bell, which
    // defeats the snooze — two surfaces disagreeing about one table. Nothing is lost; a hidden row is
    // still under Snoozed or Done in the Inbox.
    const { notificationRouter } = await import("../../src/controllers/notification.controller.js");
    const bell = express();
    bell.use(express.json());
    bell.use("/notifications", notificationRouter);
    bell.use(errorHandler);

    findMany.mockResolvedValue([]);
    await request(bell).get("/notifications");

    const where = findMany.mock.calls.at(-1)![0].where;
    expect(where.userId).toBe("u-1");
    expect(where.handledAt).toBeNull();
    expect(where.OR).toEqual([{ snoozedUntil: null }, { snoozedUntil: { lte: expect.any(Date) } }]);
  });
});
