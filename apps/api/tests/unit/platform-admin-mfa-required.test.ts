/**
 * H4 — mandatory second factor for the roles that can destroy things.
 *
 * PLATFORM_ADMIN_REQUIRE_MFA (default: on in production, off elsewhere). While it is on, an OWNER
 * or OPERATOR with no factor enrolled is admitted to their own `/auth/*` routes — which is where
 * enrolment lives — and to nothing else, with 403 MFA_ENROLMENT_REQUIRED. The other roles are not
 * gated: they cannot delete, restore, approve or reconfigure, and requiring it of them is a policy
 * choice for later rather than the control this closes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const ADMIN = "00000000-0000-4000-8000-0000000000a1";
const SESSION = "00000000-0000-4000-8000-0000000000a2";

let adminRow: Record<string, unknown>;
const control = {
  platformAdminUser: { findUnique: vi.fn(async () => adminRow) },
  platformAdminSession: {
    findUnique: vi.fn(async () => ({ revokedAt: null, adminUserId: ADMIN, createdAt: new Date(), lastUsedAt: new Date(), expiresAt: new Date(Date.now() + 3_600_000) })),
    update: vi.fn().mockResolvedValue({}),
    updateMany: vi.fn().mockResolvedValue({ count: 0 })
  }
};
vi.mock("../../src/config/control-prisma.js", () => ({ controlPrisma: control }));

const { env } = await import("../../src/config/env.js");
const { requirePlatformAdmin } = await import("../../src/middleware/platform-admin-auth.js");
const { errorHandler } = await import("../../src/middleware/error.js");
const { signPlatformAdminAccessToken } = await import("../../src/utils/platform-admin-security.js");
const { platformAccountGateFor } = await import("../../src/services/platform-account-gate.js");

const app = express();
const router = express.Router();
for (const path of ["/auth/me", "/auth/mfa", "/overview", "/retention/settings"]) {
  router.get(path, requirePlatformAdmin, (req, res) => {
    res.json(req.platformAdmin);
  });
}
router.post("/auth/mfa/begin", requirePlatformAdmin, (_req, res) => {
  res.json({ ok: true });
});
app.use("/api/platform-admin", router);
app.use(errorHandler);

const get = (path: string) =>
  request(app).get(`/api/platform-admin${path}`).set("Authorization", `Bearer ${signPlatformAdminAccessToken(ADMIN, SESSION)}`);

const original = env.PLATFORM_ADMIN_REQUIRE_MFA;
beforeEach(() => {
  env.PLATFORM_ADMIN_REQUIRE_MFA = true;
  adminRow = { id: ADMIN, email: "owner@timesphere.app", name: "Owner", role: "OWNER", status: "ACTIVE", mfaEnabled: false, mustChangePassword: false };
});
afterEach(() => {
  env.PLATFORM_ADMIN_REQUIRE_MFA = original;
});

describe("mandatory MFA for OWNER and OPERATOR", () => {
  it("restricts an unenrolled OWNER to their own account routes", async () => {
    const res = await get("/overview");
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("MFA_ENROLMENT_REQUIRED");
    expect((await get("/auth/mfa")).status).toBe(200);
    expect((await request(app).post("/api/platform-admin/auth/mfa/begin").set("Authorization", `Bearer ${signPlatformAdminAccessToken(ADMIN, SESSION)}`)).status).toBe(200);
  });

  it("restricts an unenrolled OPERATOR the same way", async () => {
    adminRow = { ...adminRow, role: "OPERATOR" };
    expect((await get("/retention/settings")).body.code).toBe("MFA_ENROLMENT_REQUIRED");
  });

  it("reports it on /auth/me so the console can open enrolment", async () => {
    expect((await get("/auth/me")).body.mfaEnrolmentRequired).toBe(true);
  });

  it("admits an enrolled OWNER, and does not gate the roles that cannot destroy anything", async () => {
    adminRow = { ...adminRow, mfaEnabled: true };
    expect((await get("/overview")).status).toBe(200);
    adminRow = { ...adminRow, mfaEnabled: false, role: "SUPPORT" };
    expect((await get("/overview")).status).toBe(200);
  });

  it("does nothing when the deployment has not asked for it", async () => {
    env.PLATFORM_ADMIN_REQUIRE_MFA = false;
    expect((await get("/overview")).status).toBe(200);
    expect((await get("/auth/me")).body.mfaEnrolmentRequired).toBe(false);
  });
});

describe("platformAccountGateFor", () => {
  it("puts the password gate first — enrolling a factor onto somebody else's password proves nothing", () => {
    expect(platformAccountGateFor({ mustChangePassword: true, role: "OWNER", mfaEnabled: false }, { requireMfa: true })?.code).toBe("PASSWORD_ROTATION_REQUIRED");
    expect(platformAccountGateFor({ mustChangePassword: false, role: "OWNER", mfaEnabled: false }, { requireMfa: true })?.code).toBe("MFA_ENROLMENT_REQUIRED");
    expect(platformAccountGateFor({ mustChangePassword: false, role: "OWNER", mfaEnabled: false }, { requireMfa: false })).toBeNull();
  });
});
