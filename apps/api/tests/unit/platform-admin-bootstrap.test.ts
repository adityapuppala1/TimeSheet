/**
 * C1 — a fresh production install must not start with an OWNER whose password is in the repository.
 *
 * The control seed used to create `platform-admin@timesphere.local` with `PlatformAdmin@12345` on
 * every install, production included, and the installers printed it. Now:
 *
 *  - a password handed to the seed explicitly (PLATFORM_ADMIN_BOOTSTRAP_PASSWORD — the installers
 *    generate one, dev and CI pass the known dev value) is used as given and not flagged;
 *  - with none, the seed generates a strong one, prints it once, and flags the account so the
 *    console admits it to nothing but "choose your own password";
 *  - the PUBLIC dev value in a production environment is flagged anyway, because "explicitly
 *    chosen" is not a description of a value that is in every fork of the repository.
 *
 * And the flag is a gate on the server, not a banner: while it is set, every console route except
 * the operator's own `/auth/*` answers 403 PASSWORD_ROTATION_REQUIRED.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

vi.setConfig({ testTimeout: 45_000, hookTimeout: 45_000 });

const ADMIN = "00000000-0000-4000-8000-0000000000a1";
const SESSION = "00000000-0000-4000-8000-0000000000a2";

let adminRow: Record<string, unknown>;
const control = {
  platformAdminUser: {
    findUnique: vi.fn(async () => adminRow),
    update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      adminRow = { ...adminRow, ...data };
      return adminRow;
    })
  },
  platformAdminSession: {
    findUnique: vi.fn(async () => ({ revokedAt: null, adminUserId: ADMIN, createdAt: new Date(), lastUsedAt: new Date(), expiresAt: new Date(Date.now() + 3_600_000) })),
    update: vi.fn().mockResolvedValue({}),
    updateMany: vi.fn().mockResolvedValue({ count: 0 })
  }
};
vi.mock("../../src/config/control-prisma.js", () => ({ controlPrisma: control }));

const { resolveBootstrapPassword } = await import("../../src/services/platform-bootstrap.js");
const { requirePlatformAdmin } = await import("../../src/middleware/platform-admin-auth.js");
const { errorHandler } = await import("../../src/middleware/error.js");
const { signPlatformAdminAccessToken } = await import("../../src/utils/platform-admin-security.js");
const { changePlatformAdminPassword, SEEDED_PLATFORM_ADMIN_PASSWORD } = await import("../../src/services/platform-admin-auth.service.js");
const { hashPassword } = await import("../../src/utils/security.js");

describe("resolveBootstrapPassword", () => {
  it("uses an explicitly provided password as given, unflagged — the dev and CI path", () => {
    const result = resolveBootstrapPassword({ PLATFORM_ADMIN_BOOTSTRAP_PASSWORD: "Installer-Generated-Value-42", NODE_ENV: "production" });
    expect(result).toMatchObject({ password: "Installer-Generated-Value-42", source: "explicit", mustChangePassword: false });
  });

  it("keeps the known dev password unflagged outside production, so the dev scripts can sign in", () => {
    const result = resolveBootstrapPassword({ PLATFORM_ADMIN_BOOTSTRAP_PASSWORD: SEEDED_PLATFORM_ADMIN_PASSWORD, NODE_ENV: "development" });
    expect(result).toMatchObject({ password: SEEDED_PLATFORM_ADMIN_PASSWORD, mustChangePassword: false });
  });

  it("generates a strong password and flags it for rotation when none is provided", () => {
    const a = resolveBootstrapPassword({ NODE_ENV: "production" });
    const b = resolveBootstrapPassword({ PLATFORM_ADMIN_BOOTSTRAP_PASSWORD: "   " });
    expect(a.source).toBe("generated");
    expect(a.mustChangePassword).toBe(true);
    expect(a.password.length).toBeGreaterThanOrEqual(20);
    expect(a.password).not.toBe(SEEDED_PLATFORM_ADMIN_PASSWORD);
    // Random, not a constant that merely moved.
    expect(b.password).not.toBe(a.password);
  });

  it("flags the PUBLIC dev password in production even when it was passed explicitly", () => {
    const result = resolveBootstrapPassword({ PLATFORM_ADMIN_BOOTSTRAP_PASSWORD: SEEDED_PLATFORM_ADMIN_PASSWORD, NODE_ENV: "production" });
    expect(result.mustChangePassword).toBe(true);
    expect(result.warning).toMatch(/public/i);
  });

  it("refuses an explicit password too short to be changed to through the console's own rules", () => {
    expect(() => resolveBootstrapPassword({ PLATFORM_ADMIN_BOOTSTRAP_PASSWORD: "short1!" })).toThrow(/12 characters/);
  });
});

describe("mustChangePassword is a gate on the server", () => {
  const app = express();
  app.use(express.json());
  const router = express.Router();
  router.get("/auth/me", requirePlatformAdmin, (req, res) => {
    res.json(req.platformAdmin);
  });
  router.post("/auth/change-password", requirePlatformAdmin, (_req, res) => {
    res.json({ ok: true });
  });
  router.post("/auth/mfa/begin", requirePlatformAdmin, (_req, res) => {
    res.json({ ok: true });
  });
  router.get("/overview", requirePlatformAdmin, (_req, res) => {
    res.json({ ok: true });
  });
  router.post("/governance/requests/r-1/approve", requirePlatformAdmin, (_req, res) => {
    res.json({ ok: true });
  });
  app.use("/api/platform-admin", router);
  app.use(errorHandler);
  const token = signPlatformAdminAccessToken(ADMIN, SESSION);
  const get = (path: string) => request(app).get(`/api/platform-admin${path}`).set("Authorization", `Bearer ${token}`);
  const post = (path: string) => request(app).post(`/api/platform-admin${path}`).set("Authorization", `Bearer ${token}`).send({});

  beforeEach(() => {
    adminRow = { id: ADMIN, email: "owner@timesphere.app", name: "Owner", role: "OWNER", status: "ACTIVE", mfaEnabled: true, mustChangePassword: true };
  });

  it("refuses the console itself with PASSWORD_ROTATION_REQUIRED", async () => {
    for (const res of [await get("/overview"), await post("/governance/requests/r-1/approve")]) {
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("PASSWORD_ROTATION_REQUIRED");
    }
  });

  it("still admits the operator's own account routes — the way out has to stay open", async () => {
    expect((await get("/auth/me")).status).toBe(200);
    expect((await post("/auth/change-password")).status).toBe(200);
    expect((await post("/auth/mfa/begin")).status).toBe(200);
  });

  it("reports the flag on /auth/me so the console can route the operator to the password form", async () => {
    expect((await get("/auth/me")).body.mustChangePassword).toBe(true);
  });

  it("admits everything once the flag is clear", async () => {
    adminRow = { ...adminRow, mustChangePassword: false };
    expect((await get("/overview")).status).toBe(200);
  });
});

describe("changing the password clears the flag", () => {
  it("writes mustChangePassword: false with the new hash", async () => {
    adminRow = { id: ADMIN, status: "ACTIVE", passwordHash: await hashPassword("Bootstrap-Value-123456"), mustChangePassword: true };
    await changePlatformAdminPassword(ADMIN, SESSION, "Bootstrap-Value-123456", "A-Password-Of-My-Own-99");
    expect(adminRow.mustChangePassword).toBe(false);
  });
});
