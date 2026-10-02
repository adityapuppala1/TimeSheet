/**
 * Who may change whose access in User Management — the rule, on every route that changes access.
 *
 * THE DEFECTS THIS PINS (audit 2026-10, users/roles findings 2 and 3):
 *  - "Only a super admin may act on a super admin" lived in bulk-action, force-logout and the role
 *    branch of PATCH, and nowhere else. The worst gap: an ADMIN could POST /users/:id/reset-password
 *    on a SUPER_ADMIN and receive the new password in plaintext — an account takeover from the row
 *    menu. PATCH status/email and DELETE were open the same way, and the plain `role` field accepted
 *    "SUPER_ADMIN" from an ADMIN, including on the ADMIN's own account.
 *  - Nothing stopped anyone deactivating, deleting or demoting THEMSELVES through these routes.
 *  - The last-super-admin guard counted `UserRole` rows only, and the founding super admin of every
 *    workspace provisioned after the multi-role migration has none — so the founder could demote
 *    themselves to zero super admins, and demoting a second super admin was refused while the
 *    founder was still there.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { runInTenant } from "../helpers/tenant-context.js";
import { createUserDirectoryFake, fakeUser, type FakeUser } from "../helpers/fake-user-directory.js";

let actor: { id: string; role: string } = { id: "actor-admin", role: "ADMIN" };

vi.mock("../../src/middleware/auth.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/middleware/auth.js")>("../../src/middleware/auth.js");
  return {
    ...actual,
    requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
      req.user = { ...actor, name: "Actor", email: "actor@x.io", permissions: ["users:manage"] } as never;
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
vi.mock("../../src/services/plan-limits.service.js", () => ({ getEffectiveSeatLimit: vi.fn().mockResolvedValue(100) }));
vi.mock("../../src/services/billing-sync.service.js", () => ({ syncSubscriptionSeats: vi.fn().mockResolvedValue(undefined) }));

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

/** The founder: SUPER_ADMIN by primary role, and — like every workspace seeded after 2026-08-26 —
 *  no `UserRole` row at all. */
const founder = (overrides: Partial<FakeUser> = {}) => fakeUser({ id: "founder", roleName: "SUPER_ADMIN", userRoleNames: [], ...overrides });
const admin = fakeUser({ id: "actor-admin", roleName: "ADMIN" });
const employee = fakeUser({ id: "emp", roleName: "EMPLOYEE" });
/** Holds SUPER_ADMIN through a `UserRole` grant but is currently switched into EMPLOYEE. They can
 *  switch back at will, so for every purpose here they ARE a super admin. */
const dormantSuperAdmin = fakeUser({ id: "dormant", roleName: "EMPLOYEE", userRoleNames: ["EMPLOYEE", "SUPER_ADMIN"] });

beforeEach(() => {
  actor = { id: "actor-admin", role: "ADMIN" };
  fake = createUserDirectoryFake([founder(), admin, employee, dormantSuperAdmin]);
});

describe("an ADMIN cannot act on a super admin's account", () => {
  it("reset-password on a SUPER_ADMIN is refused and no password comes back (account takeover)", async () => {
    const res = await app().post("/api/users/founder/reset-password").send({});
    expect(res.status).toBe(403);
    expect(res.body.generatedPassword).toBeUndefined();
    expect(fake.raw.user.update).not.toHaveBeenCalled();
    expect(fake.raw.session.updateMany).not.toHaveBeenCalled();
  });

  it("reset-password on someone who HOLDS super admin but is switched into another role is refused too", async () => {
    const res = await app().post("/api/users/dormant/reset-password").send({});
    expect(res.status).toBe(403);
    expect(fake.raw.user.update).not.toHaveBeenCalled();
  });

  it("a SUPER_ADMIN may still reset a super admin's password", async () => {
    actor = { id: "dormant", role: "SUPER_ADMIN" };
    const res = await app().post("/api/users/founder/reset-password").send({});
    expect(res.status).toBe(200);
    expect(res.body.generatedPassword).toEqual(expect.any(String));
  });

  it("an ADMIN may still reset an employee's password", async () => {
    const res = await app().post("/api/users/emp/reset-password").send({});
    expect(res.status).toBe(200);
  });

  it.each([
    ["deactivate", { status: "INACTIVE" }],
    ["change the email of", { email: "attacker@evil.example" }],
    ["rename", { name: "Someone Else" }]
  ])("PATCH: may not %s a super admin", async (_label, body) => {
    const res = await app().patch("/api/users/founder").send(body);
    expect(res.status).toBe(403);
    expect(fake.raw.user.update).not.toHaveBeenCalled();
  });

  it("DELETE of a super admin is refused", async () => {
    const res = await app().delete("/api/users/founder");
    expect(res.status).toBe(403);
    expect(fake.byId("founder")!.deletedAt).toBeNull();
  });

  it("force-logout of someone holding super admin through a UserRole grant is refused", async () => {
    const res = await app().post("/api/users/dormant/force-logout");
    expect(res.status).toBe(403);
  });

  it("bulk actions skip an account that holds super admin through a UserRole grant", async () => {
    const res = await app().post("/api/users/bulk-action").send({ action: "RESET_PASSWORD", userIds: ["dormant", "emp"] });
    expect(res.status).toBe(200);
    expect(res.body.applied).toBe(1);
    expect(res.body.skipped).toEqual([expect.objectContaining({ id: "dormant", reason: expect.stringMatching(/super admin/i) })]);
    expect(res.body.generatedPasswords.map((p: { id: string }) => p.id)).toEqual(["emp"]);
  });
});

describe("only a super admin may grant SUPER_ADMIN", () => {
  it("POST /users with role SUPER_ADMIN from an ADMIN is refused", async () => {
    const res = await app().post("/api/users").send({ name: "New Boss", email: "boss@x.io", role: "SUPER_ADMIN" });
    expect(res.status).toBe(403);
    expect(fake.raw.user.create).not.toHaveBeenCalled();
  });

  it("an ADMIN may not promote themselves to SUPER_ADMIN", async () => {
    const res = await app().patch("/api/users/actor-admin").send({ role: "SUPER_ADMIN" });
    expect(res.status).toBe(403);
    expect(fake.byId("actor-admin")!.roleName).toBe("ADMIN");
  });

  it("an ADMIN may not promote an employee to SUPER_ADMIN", async () => {
    const res = await app().patch("/api/users/emp").send({ role: "SUPER_ADMIN" });
    expect(res.status).toBe(403);
  });

  it("an ADMIN keeps every other grant it had — promoting an employee to ADMIN still works", async () => {
    const res = await app().patch("/api/users/emp").send({ role: "ADMIN" });
    expect(res.status).toBe(200);
    expect(fake.byId("emp")!.roleName).toBe("ADMIN");
  });

  it("the CSV import refuses a SUPER_ADMIN row from an ADMIN and still creates the others", async () => {
    const res = await app()
      .post("/api/users/bulk")
      .send({
        rows: [
          { name: "Boss Person", email: "boss@x.io", role: "SUPER_ADMIN" },
          { name: "Plain Person", email: "plain@x.io", role: "EMPLOYEE" }
        ]
      });
    expect(res.status).toBe(201);
    expect(res.body.results[0]).toEqual(expect.objectContaining({ success: false, error: expect.stringMatching(/super admin/i) }));
    expect(res.body.results[1]).toEqual(expect.objectContaining({ success: true }));
    expect(fake.users.find((u) => u.email === "boss@x.io")).toBeUndefined();
  });

  it("a SUPER_ADMIN may grant SUPER_ADMIN", async () => {
    actor = { id: "founder", role: "SUPER_ADMIN" };
    const res = await app().patch("/api/users/emp").send({ role: "SUPER_ADMIN" });
    expect(res.status).toBe(200);
  });
});

describe("nobody locks themselves out through the admin routes", () => {
  it("deactivating your own account is refused with a clear 422", async () => {
    actor = { id: "founder", role: "SUPER_ADMIN" };
    const res = await app().patch("/api/users/founder").send({ status: "INACTIVE" });
    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/your own account/i);
    expect(fake.byId("founder")!.status).toBe("ACTIVE");
  });

  it("an ADMIN deactivating themselves is refused the same way", async () => {
    const res = await app().patch("/api/users/actor-admin").send({ status: "PENDING_VERIFICATION" });
    expect(res.status).toBe(422);
  });

  it("deleting your own account is refused", async () => {
    const res = await app().delete("/api/users/actor-admin");
    expect(res.status).toBe(422);
    expect(fake.byId("actor-admin")!.deletedAt).toBeNull();
  });

  it("demoting yourself is refused", async () => {
    const res = await app().patch("/api/users/actor-admin").send({ role: "EMPLOYEE" });
    expect(res.status).toBe(422);
    expect(fake.byId("actor-admin")!.roleName).toBe("ADMIN");
  });

  it("saving your own details with your role and status echoed back unchanged still works (the edit dialog sends both)", async () => {
    const res = await app().patch("/api/users/actor-admin").send({ name: "Renamed Admin", role: "ADMIN", status: "ACTIVE" });
    expect(res.status).toBe(200);
    expect(fake.byId("actor-admin")!.name).toBe("Renamed Admin");
  });
});

describe("the last-super-admin guard counts the founder, who has no UserRole row", () => {
  it("demoting a second super admin is allowed while the founder is still an active super admin", async () => {
    // The reverse of the lockout: counting rows only, the founder was invisible, so this was 422.
    fake = createUserDirectoryFake([founder(), fakeUser({ id: "second", roleName: "SUPER_ADMIN", userRoleNames: ["SUPER_ADMIN"] })]);
    actor = { id: "founder", role: "SUPER_ADMIN" };
    const res = await app().patch("/api/users/second").send({ role: "EMPLOYEE" });
    expect(res.status).toBe(200);
  });

  it("deactivating the only active super admin is refused", async () => {
    // Reachable only through a path whose actor is not a holder — modelled here with an actor
    // whose ACTIVE role is super admin on a row the fake does not know, which is the guard's own
    // job to catch regardless of who asks.
    actor = { id: "outside-actor", role: "SUPER_ADMIN" };
    fake = createUserDirectoryFake([founder()]);
    const res = await app().patch("/api/users/founder").send({ status: "INACTIVE" });
    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/no super admin/i);
  });

  it("deleting the only active super admin is refused", async () => {
    actor = { id: "outside-actor", role: "SUPER_ADMIN" };
    fake = createUserDirectoryFake([founder()]);
    const res = await app().delete("/api/users/founder");
    expect(res.status).toBe(422);
  });

  it("a super admin held only through a UserRole grant counts as a holder too", async () => {
    actor = { id: "outside-actor", role: "SUPER_ADMIN" };
    fake = createUserDirectoryFake([founder(), dormantSuperAdmin]);
    const res = await app().patch("/api/users/founder").send({ status: "INACTIVE" });
    expect(res.status).toBe(200);
  });

  it("an INACTIVE super admin does not count — deactivating the only ACTIVE one is still refused", async () => {
    actor = { id: "outside-actor", role: "SUPER_ADMIN" };
    fake = createUserDirectoryFake([founder(), fakeUser({ id: "gone", roleName: "SUPER_ADMIN", status: "INACTIVE" })]);
    const res = await app().patch("/api/users/founder").send({ status: "INACTIVE" });
    expect(res.status).toBe(422);
  });

  it("bulk DEACTIVATE skips the last active super admin and names why", async () => {
    actor = { id: "outside-actor", role: "SUPER_ADMIN" };
    fake = createUserDirectoryFake([founder(), employee]);
    const res = await app().post("/api/users/bulk-action").send({ action: "DEACTIVATE", userIds: ["founder", "emp"] });
    expect(res.status).toBe(200);
    expect(res.body.applied).toBe(1);
    expect(res.body.skipped).toEqual([expect.objectContaining({ id: "founder", reason: expect.stringMatching(/no super admin/i) })]);
    expect(fake.byId("founder")!.status).toBe("ACTIVE");
  });
});
