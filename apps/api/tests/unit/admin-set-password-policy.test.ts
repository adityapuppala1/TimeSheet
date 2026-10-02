/**
 * Passwords an ADMIN types go through the same policy as the ones people choose for themselves.
 *
 * WHY IT MATTERS MORE NOW, NOT LESS. An admin-set password is temporary — the account is flagged and
 * a password session can do nothing but change it (requireAuth's PASSWORD_CHANGE_REQUIRED gate). But
 * that gate lets WHOEVER signs in first choose the real password. A temporary password from the
 * common-password list ("password", "12345678") is therefore an open door between the admin setting
 * it and the person using it: guess it, change it, and the account is the guesser's. So the
 * policy's target-independent checks (blocklist, the 72-byte bcrypt limit) refuse an admin-typed
 * password outright, and its per-person check (not the target's email local part) refuses it for
 * that person. Generated one-time passwords are random and unaffected.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { runInTenant } from "../helpers/tenant-context.js";
import { createUserDirectoryFake, fakeUser } from "../helpers/fake-user-directory.js";

vi.mock("../../src/middleware/auth.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/middleware/auth.js")>("../../src/middleware/auth.js");
  return {
    ...actual,
    requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
      req.user = { id: "actor-admin", role: "ADMIN", name: "Actor", email: "actor@x.io", permissions: ["users:manage"] } as never;
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

const STRONG = "Correct-Horse-Battery-77";

beforeEach(() => {
  fake = createUserDirectoryFake([
    fakeUser({ id: "actor-admin", roleName: "ADMIN" }),
    fakeUser({ id: "emp", roleName: "EMPLOYEE", email: "maria.lopez@x.io" })
  ]);
});

describe("creating a user with a typed password", () => {
  it("refuses a common password and creates nobody", async () => {
    const res = await app().post("/api/users").send({ name: "New Person", email: "new@x.io", role: "EMPLOYEE", password: "password" });
    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/common/i);
    expect(fake.users.find((u) => u.email === "new@x.io")).toBeUndefined();
  });

  it("accepts a strong one", async () => {
    const res = await app().post("/api/users").send({ name: "New Person", email: "new@x.io", role: "EMPLOYEE", password: STRONG });
    expect(res.status).toBe(201);
  });
});

describe("resetting someone's password to a typed one", () => {
  it("refuses a password built from that person's email address", async () => {
    const res = await app().post("/api/users/emp/reset-password").send({ password: "maria.lopez2026" });
    expect(res.status).toBe(422);
    expect(fake.raw.user.update).not.toHaveBeenCalled();
  });

  it("bulk reset refuses a common password up front, touching nobody", async () => {
    const res = await app().post("/api/users/bulk-action").send({ action: "RESET_PASSWORD", userIds: ["emp"], password: "12345678" });
    expect(res.status).toBe(422);
    expect(fake.raw.user.update).not.toHaveBeenCalled();
  });

  it("bulk reset skips, by name, the person whose email the password is built from", async () => {
    const res = await app().post("/api/users/bulk-action").send({ action: "RESET_PASSWORD", userIds: ["emp"], password: "maria.lopez2026" });
    expect(res.status).toBe(200);
    expect(res.body.applied).toBe(0);
    expect(res.body.skipped[0]).toMatchObject({ id: "emp", reason: expect.stringMatching(/email/i) });
  });
});

describe("the CSV import", () => {
  it("fails only the row whose password is common, and still creates the rest", async () => {
    const res = await app()
      .post("/api/users/bulk")
      .send({
        rows: [
          { name: "Weak Row", email: "weak@x.io", role: "EMPLOYEE", password: "password1" },
          { name: "Fine Row", email: "fine@x.io", role: "EMPLOYEE", password: STRONG }
        ]
      });
    expect(res.status).toBe(201);
    expect(res.body.results[0]).toMatchObject({ success: false, error: expect.stringMatching(/common/i) });
    expect(res.body.results[1]).toMatchObject({ success: true });
    expect(fake.users.find((u) => u.email === "weak@x.io")).toBeUndefined();
  });
});
