/**
 * The bell's routes (`/api/notifications`), driven through the real router. Pinned:
 *
 * 1. "MARK ALL READ" MARKS WHAT THE BELL SHOWS. The bell lists unhandled rows that are not snoozed;
 *    `/read-all` used to mark EVERY unread row, so a notification snoozed in the Inbox came back
 *    from its snooze already read — no dot, no count, the whole point of snoozing it gone.
 * 2. THE BADGE COUNTS EVERY UNREAD ROW, not just those among the 50 newest the list carries — with
 *    the newest 50 all read and older ones unread, the badge said nothing and "Mark all read" hid.
 * 3. Both stay scoped to the caller.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const actor = { id: "u-1", name: "Emp", email: "e@x.io", role: "EMPLOYEE", permissions: [] as string[] };
const updateMany = vi.fn().mockResolvedValue({ count: 0 });
const findMany = vi.fn().mockResolvedValue([]);
const count = vi.fn().mockResolvedValue(0);

vi.mock("../../src/middleware/auth.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/middleware/auth.js")>("../../src/middleware/auth.js");
  return {
    ...actual,
    requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
      req.user = { ...actor } as never;
      next();
    }
  };
});
vi.mock("../../src/config/prisma.js", () => ({ prisma: { notification: { findMany, count, updateMany } } }));

const { notificationRouter } = await import("../../src/controllers/notification.controller.js");
const { errorHandler } = await import("../../src/middleware/error.js");
const app = () => {
  const a = express();
  a.use(express.json());
  a.use("/notifications", notificationRouter);
  a.use(errorHandler);
  return a;
};

/** What the bell shows: the caller's, not handled, and not still snoozed. */
const visibleTo = (userId: string) => ({
  userId,
  handledAt: null,
  OR: [{ snoozedUntil: null }, { snoozedUntil: { lte: expect.any(Date) } }]
});

beforeEach(() => {
  vi.clearAllMocks();
  findMany.mockResolvedValue([]);
  count.mockResolvedValue(0);
});

describe("mark all read", () => {
  it("marks only what the bell shows — a snoozed or handled row keeps its unread state for later", async () => {
    expect((await request(app()).post("/notifications/read-all")).status).toBe(204);
    expect(updateMany).toHaveBeenCalledWith({ where: { ...visibleTo("u-1"), readAt: null }, data: { readAt: expect.any(Date) } });
  });
});

describe("the badge", () => {
  it("counts every unread row the bell would show, not only those in the 50 it lists", async () => {
    findMany.mockResolvedValue(Array.from({ length: 50 }, (_, i) => ({ id: `n-${i}`, readAt: new Date() })));
    count.mockResolvedValue(7);
    const res = await request(app()).get("/notifications");
    expect(res.body.unread).toBe(7);
    expect(res.body.items).toHaveLength(50);
    expect(count).toHaveBeenCalledWith({ where: { ...visibleTo("u-1"), readAt: null } });
  });
});
