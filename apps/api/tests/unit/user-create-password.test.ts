/**
 * Creating a user, and where that user's first password comes from.
 *
 * The admin "Invite a teammate" form used to pre-fill the password field with the literal
 * "Admin@12345" — the demo credential this repo's own README publishes — and POST /users REQUIRED
 * a password, so the default was the path of least resistance. Every teammate invited without the
 * admin editing that field shared one password the whole internet can read.
 *
 * Every other password path in the controller already generated a random one-time value
 * (bulk RESET_PASSWORD, CSV import, /:id/reset-password). This pins the create route behaving the
 * same way, and pins the second defect found alongside it: the response spread Prisma's whole user
 * record, so the new account's bcrypt hash went to the browser.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { PrismaClient } from "@prisma/client";
import { runInTenant } from "../helpers/tenant-context.js";

const actor = { id: "admin-1", name: "Admin", email: "a@x.io", role: "SUPER_ADMIN", permissions: ["users:manage"] };

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
vi.mock("../../src/services/face.service.js", () => ({
  findCoveredUnenrolledUserIds: vi.fn().mockResolvedValue([]),
  notifyEnrollmentRequired: vi.fn().mockResolvedValue(0)
}));
vi.mock("../../src/services/notify.service.js", () => ({ dispatchTransactional: vi.fn().mockResolvedValue({ ok: true }) }));
vi.mock("../../src/services/maintenance.service.js", () => ({ getOnlineSeenByUser: vi.fn().mockResolvedValue(new Map()) }));
vi.mock("../../src/services/plan-limits.service.js", () => ({ getEffectiveSeatLimit: vi.fn().mockResolvedValue(100) }));
vi.mock("../../src/services/user-welcome.service.js", () => ({
  sendWelcomeEmail: vi.fn().mockResolvedValue({ ok: true, status: "SENT", emailLogId: "log-1" })
}));

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

const NEW_USER = {
  id: "new-1",
  name: "Aanya Sharma",
  email: "aanya@company.com",
  status: "ACTIVE",
  roleId: "role-emp",
  mustChangePassword: true,
  passwordHash: "$2b$12$THIS_MUST_NEVER_REACH_THE_CLIENT"
};

const post = (body: Record<string, unknown>) =>
  request(buildApp()).post("/api/users").send({ name: "Aanya Sharma", email: "aanya@company.com", role: "EMPLOYEE", ...body });

/** What was actually written as the new account's passwordHash. */
const createdHash = () => (vi.mocked(client.user.create).mock.calls[0][0].data as { passwordHash: string }).passwordHash;

beforeEach(() => {
  vi.clearAllMocks();
  client = {
    user: {
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue(NEW_USER),
      count: vi.fn().mockResolvedValue(3)
    },
    role: { findUniqueOrThrow: vi.fn().mockResolvedValue({ id: "role-emp", name: "EMPLOYEE" }) }
  } as unknown as PrismaClient;
});

describe("when the admin supplies no password", () => {
  it("is accepted — the field is optional, so leaving it blank is the normal path", async () => {
    const res = await post({});
    expect(res.status).toBe(201);
  });

  it("generates one and returns it exactly once, the way the reset routes already do", async () => {
    const res = await post({});
    expect(typeof res.body.generatedPassword).toBe("string");
    expect(res.body.generatedPassword.length).toBeGreaterThanOrEqual(12);
  });

  it("never generates the published demo password", async () => {
    // The specific string that shipped as the form default. If this ever passes again, the whole
    // point of the change has been undone.
    const seen = new Set<string>();
    for (let i = 0; i < 25; i += 1) {
      vi.clearAllMocks();
      const res = await post({});
      expect(res.body.generatedPassword).not.toBe("Admin@12345");
      seen.add(res.body.generatedPassword);
    }
    // ...and a different one each time, rather than one constant dressed up as generated.
    expect(seen.size).toBe(25);
  });

  it("stores a hash, never the password itself", async () => {
    const res = await post({});
    expect(createdHash()).toMatch(/^\$2[aby]\$/);
    expect(createdHash()).not.toContain(res.body.generatedPassword);
  });

  it("prompts the person to choose their own at first sign-in", async () => {
    await post({});
    expect((vi.mocked(client.user.create).mock.calls[0][0].data as { mustChangePassword: boolean }).mustChangePassword).toBe(true);
  });
});

describe("when the admin supplies their own password", () => {
  it("uses it, and returns no generated one — they already know it", async () => {
    const res = await post({ password: "Chosen#Pass99" });
    expect(res.status).toBe(201);
    expect(res.body.generatedPassword).toBeNull();
  });

  it("still refuses one that is too short, rather than silently generating instead", async () => {
    // "Optional" must not become "anything goes": a 4-character password that quietly turns into a
    // strong random one would leave the admin telling the person a password that does not work.
    expect((await post({ password: "abc" })).status).toBe(422);
  });
});

describe("what comes back to the browser", () => {
  it("does not include the password hash", async () => {
    // Prisma's create returns every scalar, so spreading the record leaked the new account's
    // bcrypt hash to the admin's browser and any proxy log in between. Every list route in this
    // controller already strips it; this one did not.
    const res = await post({});
    expect(res.body.passwordHash).toBeUndefined();
    expect(JSON.stringify(res.body)).not.toContain("THIS_MUST_NEVER_REACH_THE_CLIENT");
  });

  it("still returns the fields the admin screen needs", async () => {
    const res = await post({});
    expect(res.body).toMatchObject({ id: "new-1", email: "aanya@company.com", name: "Aanya Sharma" });
    expect(res.body.welcomeEmail).toMatchObject({ sent: true });
  });
});
