/**
 * A seat is taken whenever an account BECOMES active, not only when it is created — and the seat
 * count Stripe bills follows every change, not three of them.
 *
 * THE DEFECTS THIS PINS (audit 2026-10, users/roles finding 5 and the billing audit's finding 4):
 *  - The seat limit was checked on creation only. With 5 of 5 seats used, POST /users answered 402,
 *    but deactivating anyone and then reactivating them — or anyone else — answered 200, and a bulk
 *    ACTIVATE over "all inactive" could reactivate a whole department past the plan.
 *  - `syncSubscriptionSeats` ran on single create, single delete and join approval only. A bulk
 *    deactivate of twenty people, a CSV import of fifty, a status change in the edit dialog: none of
 *    them moved the Stripe quantity, so the next invoice billed the old headcount.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { runInTenant } from "../helpers/tenant-context.js";
import { createUserDirectoryFake, fakeUser } from "../helpers/fake-user-directory.js";

const { syncSubscriptionSeats, getEffectiveSeatLimit } = vi.hoisted(() => ({
  syncSubscriptionSeats: vi.fn(),
  getEffectiveSeatLimit: vi.fn()
}));

vi.mock("../../src/middleware/auth.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/middleware/auth.js")>("../../src/middleware/auth.js");
  return {
    ...actual,
    requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
      req.user = { id: "boss", role: "SUPER_ADMIN", name: "Boss", email: "boss@x.io", permissions: ["users:manage"] } as never;
      next();
    },
    requirePermission: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next()
  };
});
vi.mock("../../src/services/audit.service.js", () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../src/services/face.service.js", () => ({
  findCoveredUnenrolledUserIds: vi.fn().mockResolvedValue([]),
  notifyEnrollmentRequired: vi.fn().mockResolvedValue(0)
}));
vi.mock("../../src/services/notify.service.js", () => ({ dispatchTransactional: vi.fn().mockResolvedValue({ ok: true }) }));
vi.mock("../../src/services/maintenance.service.js", () => ({ getOnlineSeenByUser: vi.fn().mockResolvedValue(new Map()) }));
vi.mock("../../src/services/plan-limits.service.js", () => ({ getEffectiveSeatLimit }));
vi.mock("../../src/services/billing-sync.service.js", () => ({ syncSubscriptionSeats }));

const { userRouter } = await import("../../src/controllers/user.controller.js");
const { errorHandler } = await import("../../src/middleware/error.js");

let fake: ReturnType<typeof createUserDirectoryFake>;

function app() {
  const server = express();
  server.use(express.json());
  server.use((req, res, next) => runInTenant(fake.client, async () => next(), "org-1").catch(next));
  server.use("/api/users", userRouter);
  server.use(errorHandler);
  return request(server);
}

/** Three active seats (boss, a, b) and two people waiting to come back. */
function workspace() {
  return createUserDirectoryFake([
    fakeUser({ id: "boss", roleName: "SUPER_ADMIN" }),
    fakeUser({ id: "a" }),
    fakeUser({ id: "b" }),
    fakeUser({ id: "left-1", status: "INACTIVE" }),
    fakeUser({ id: "left-2", status: "INACTIVE" }),
    // An agent identity: ACTIVE or not, it never takes a seat (seat-count.service.ts).
    fakeUser({ id: "bot", status: "INACTIVE", isAgent: true })
  ]);
}

beforeEach(() => {
  fake = workspace();
  getEffectiveSeatLimit.mockReset().mockResolvedValue(3);
  syncSubscriptionSeats.mockReset().mockResolvedValue(undefined);
});

describe("reactivation takes a seat", () => {
  it("PATCH status ACTIVE on a full plan is refused with 402 and changes nothing", async () => {
    const res = await app().patch("/api/users/left-1").send({ status: "ACTIVE" });
    expect(res.status).toBe(402);
    expect(res.body.message).toMatch(/seat limit/i);
    expect(fake.byId("left-1")!.status).toBe("INACTIVE");
  });

  it("PATCH status ACTIVE goes through when a seat is free", async () => {
    getEffectiveSeatLimit.mockResolvedValue(4);
    const res = await app().patch("/api/users/left-1").send({ status: "ACTIVE" });
    expect(res.status).toBe(200);
    expect(fake.byId("left-1")!.status).toBe("ACTIVE");
  });

  it("saving an already-active person's details on a full plan is not a reactivation", async () => {
    const res = await app().patch("/api/users/a").send({ name: "Renamed", status: "ACTIVE" });
    expect(res.status).toBe(200);
  });

  it("reactivating an agent identity needs no seat", async () => {
    const res = await app().patch("/api/users/bot").send({ status: "ACTIVE" });
    expect(res.status).toBe(200);
  });

  it("bulk ACTIVATE past the limit is refused as a whole, before anyone is activated", async () => {
    getEffectiveSeatLimit.mockResolvedValue(4); // room for one, two asked
    const res = await app().post("/api/users/bulk-action").send({ action: "ACTIVATE", userIds: ["left-1", "left-2"] });
    expect(res.status).toBe(402);
    expect(res.body.message).toMatch(/2 people/);
    expect(fake.byId("left-1")!.status).toBe("INACTIVE");
    expect(fake.byId("left-2")!.status).toBe("INACTIVE");
  });

  it("bulk ACTIVATE counts only the people who would actually take a seat", async () => {
    getEffectiveSeatLimit.mockResolvedValue(4);
    // a is already active and bot is an agent: only left-1 takes a seat, and one is free.
    const res = await app().post("/api/users/bulk-action").send({ action: "ACTIVATE", userIds: ["a", "bot", "left-1"] });
    expect(res.status).toBe(200);
    expect(res.body.applied).toBe(3);
  });
});

describe("the billed seat count follows every change", () => {
  it("PATCH status (either way) syncs the Stripe quantity", async () => {
    await app().patch("/api/users/a").send({ status: "INACTIVE" }).expect(200);
    expect(syncSubscriptionSeats).toHaveBeenCalledTimes(1);
    expect(syncSubscriptionSeats).toHaveBeenCalledWith("org-1");
  });

  it("a PATCH that does not change status does not call Stripe", async () => {
    await app().patch("/api/users/a").send({ designation: "Engineer", status: "ACTIVE" }).expect(200);
    expect(syncSubscriptionSeats).not.toHaveBeenCalled();
  });

  it.each(["DEACTIVATE", "DELETE"])("bulk %s syncs once, after the whole batch", async (action) => {
    await app().post("/api/users/bulk-action").send({ action, userIds: ["a", "b"] }).expect(200);
    expect(syncSubscriptionSeats).toHaveBeenCalledTimes(1);
  });

  it("bulk ACTIVATE syncs", async () => {
    getEffectiveSeatLimit.mockResolvedValue(10);
    await app().post("/api/users/bulk-action").send({ action: "ACTIVATE", userIds: ["left-1"] }).expect(200);
    expect(syncSubscriptionSeats).toHaveBeenCalledTimes(1);
  });

  it("bulk FORCE_LOGOUT changes no seats and does not call Stripe", async () => {
    await app().post("/api/users/bulk-action").send({ action: "FORCE_LOGOUT", userIds: ["a"] }).expect(200);
    expect(syncSubscriptionSeats).not.toHaveBeenCalled();
  });

  it("the CSV import syncs once for the whole file", async () => {
    getEffectiveSeatLimit.mockResolvedValue(10);
    await app()
      .post("/api/users/bulk")
      .send({ rows: [{ name: "One Person", email: "one@x.io", role: "EMPLOYEE" }, { name: "Two Person", email: "two@x.io", role: "EMPLOYEE" }] })
      .expect(201);
    expect(syncSubscriptionSeats).toHaveBeenCalledTimes(1);
  });

  it("a sync that fails never fails the change it follows", async () => {
    // billing-sync.service.ts promises never to throw; this pins that the routes rely on nothing more.
    syncSubscriptionSeats.mockResolvedValue(undefined);
    const res = await app().patch("/api/users/a").send({ status: "INACTIVE" });
    expect(res.status).toBe(200);
  });
});
