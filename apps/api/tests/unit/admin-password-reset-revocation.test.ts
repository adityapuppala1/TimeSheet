/**
 * An admin resets somebody's password because the account is suspected compromised. Writing a new
 * `passwordHash` alone evicts nobody: the attacker's Session row is untouched, and its refresh
 * token keeps rotating for the rest of its 30-day life.
 *
 * Both other password-set paths already got this right — auth.service.ts#changePassword (all but
 * the current session) and #resetPassword (all of them). These two are the admin-driven ones, and
 * they mirror the emailed-reset behaviour: ALL sessions, because the actor is the admin, never the
 * person being reset.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { PrismaClient } from "@prisma/client";
import { runInTenant } from "../helpers/tenant-context.js";

const actor = { id: "admin-1", name: "Admin", email: "a@x.io", role: "SUPER_ADMIN", permissions: ["users:manage"] };
const TARGET = "victim-1";

vi.mock("../../src/middleware/auth.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/middleware/auth.js")>("../../src/middleware/auth.js");
  return {
    ...actual,
    requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
      req.user = { ...actor };
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

const { userRouter } = await import("../../src/controllers/user.controller.js");
const { errorHandler } = await import("../../src/middleware/error.js");

let client: PrismaClient;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => runInTenant(client, async () => next(), "org-1").catch(next));
  app.use("/api/users", userRouter);
  app.use(errorHandler);
  return app;
}

/** Every session-revoking write in this controller looks the same; this is what one looks like
 *  for the target of the reset. */
const revocationsFor = (userId: string) =>
  vi.mocked(client.session.updateMany).mock.calls.filter((call) => {
    const where = call[0]?.where as { userId?: string; revokedAt?: unknown } | undefined;
    return where?.userId === userId && where?.revokedAt === null;
  });

beforeEach(() => {
  client = {
    user: {
      update: vi.fn().mockResolvedValue({ id: TARGET }),
      findMany: vi
        .fn()
        .mockResolvedValue([{ id: TARGET, name: "Victim", email: "v@x.io", status: "ACTIVE", role: { name: "EMPLOYEE" } }])
    },
    session: { updateMany: vi.fn().mockResolvedValue({ count: 2 }) }
  } as unknown as PrismaClient;
});

describe("POST /users/:id/reset-password", () => {
  it("ends every session the target has, so the reset actually evicts whoever prompted it", async () => {
    const response = await request(buildApp()).post(`/api/users/${TARGET}/reset-password`).send({});
    expect(response.status).toBe(200);
    expect(revocationsFor(TARGET)).toHaveLength(1);
  });

  it("says so in the response, rather than describing an eviction it didn't do", async () => {
    const response = await request(buildApp()).post(`/api/users/${TARGET}/reset-password`).send({});
    expect(response.body.message).toMatch(/signed out/i);
  });

  it("still returns the generated one-time password exactly once", async () => {
    const response = await request(buildApp()).post(`/api/users/${TARGET}/reset-password`).send({});
    expect(typeof response.body.generatedPassword).toBe("string");
    expect(response.body.generatedPassword.length).toBeGreaterThan(7);
  });
});

describe("POST /users/bulk-action — RESET_PASSWORD", () => {
  it("revokes sessions for each person it resets", async () => {
    const response = await request(buildApp())
      .post("/api/users/bulk-action")
      .send({ action: "RESET_PASSWORD", userIds: [TARGET] });
    expect(response.status).toBe(200);
    expect(revocationsFor(TARGET)).toHaveLength(1);
  });

  it("does not revoke on an action that isn't supposed to — ACTIVATE leaves sessions alone", async () => {
    await request(buildApp()).post("/api/users/bulk-action").send({ action: "ACTIVATE", userIds: [TARGET] });
    expect(revocationsFor(TARGET)).toHaveLength(0);
  });
});
