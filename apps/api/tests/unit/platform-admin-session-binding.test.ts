/**
 * A console session belongs to ONE admin, and the token that names it must name that admin.
 *
 * THE ATTACK THIS PINS. Access and refresh tokens carry `sub` (the admin) and `sid` (the session).
 * Until this fix nothing checked that the two belonged together: `requirePlatformAdmin` asked only
 * "is this session revoked?" and then loaded whichever admin `sub` named, and the refresh path minted
 * a fresh access token for `payload.sub`. So anybody who learned PLATFORM_ADMIN_JWT_SECRET and held
 * ANY live console session — a READ_ONLY one is plenty — could sign a token pairing their own session
 * id with an OWNER's id and be that OWNER.
 *
 * And the secret itself, which the production boot check did not look at: it can now neither be a
 * placeholder nor be the same value as a tenant secret.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const OWNER = "00000000-0000-4000-8000-0000000000a1";
const READER = "00000000-0000-4000-8000-0000000000b2";
const READER_SESSION = "00000000-0000-4000-8000-0000000000c3";

const sessions = new Map<string, Record<string, unknown>>();
const admins = new Map<string, Record<string, unknown>>();

const control = {
  platformAdminUser: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => admins.get(where.id) ?? null) },
  platformAdminSession: {
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) => sessions.get(where.id) ?? null),
    update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
      const row = { ...sessions.get(where.id)!, ...data };
      sessions.set(where.id, row);
      return row;
    }),
    updateMany: vi.fn().mockResolvedValue({ count: 0 })
  }
};
vi.mock("../../src/config/control-prisma.js", () => ({ controlPrisma: control }));

const { requirePlatformAdmin } = await import("../../src/middleware/platform-admin-auth.js");
const { errorHandler } = await import("../../src/middleware/error.js");
const { signPlatformAdminAccessToken, signPlatformAdminRefreshToken } = await import("../../src/utils/platform-admin-security.js");
const { platformAdminRefresh } = await import("../../src/services/platform-admin-auth.service.js");
const { hashToken } = await import("../../src/utils/security.js");
const { productionSecretsToCheck, reusedSecretProblem } = await import("../../src/config/production-secrets.js");

const app = express();
app.get("/whoami", requirePlatformAdmin, (req, res) => {
  res.json(req.platformAdmin);
});
app.use(errorHandler);

beforeEach(() => {
  vi.clearAllMocks();
  admins.clear();
  sessions.clear();
  admins.set(OWNER, { id: OWNER, email: "owner@timesphere.app", name: "Owner", role: "OWNER", status: "ACTIVE", mfaEnabled: true, mustChangePassword: false });
  admins.set(READER, { id: READER, email: "reader@timesphere.app", name: "Reader", role: "READ_ONLY", status: "ACTIVE", mfaEnabled: true, mustChangePassword: false });
  sessions.set(READER_SESSION, {
    id: READER_SESSION,
    adminUserId: READER,
    revokedAt: null,
    createdAt: new Date(),
    lastUsedAt: new Date(),
    expiresAt: new Date(Date.now() + 3_600_000)
  });
});

describe("requirePlatformAdmin binds the session to the admin it belongs to", () => {
  it("admits a token whose subject owns the session", async () => {
    const res = await request(app).get("/whoami").set("Authorization", `Bearer ${signPlatformAdminAccessToken(READER, READER_SESSION)}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(READER);
  });

  it("refuses a token that pairs somebody else's session with an OWNER's id", async () => {
    // What a holder of the signing secret would mint: their own (READ_ONLY) live session, the owner's id.
    const forged = signPlatformAdminAccessToken(OWNER, READER_SESSION);
    const res = await request(app).get("/whoami").set("Authorization", `Bearer ${forged}`);
    expect(res.status).toBe(401);
    expect(res.body.role).toBeUndefined();
  });
});

describe("refresh binds the session to the admin it belongs to", () => {
  it("refuses a refresh token whose subject is not the session's admin, and mints nothing", async () => {
    const secret = "opaque-refresh-secret";
    sessions.set(READER_SESSION, { ...sessions.get(READER_SESSION)!, refreshHash: await hashToken(secret), previousRefreshHash: null, refreshRotatedAt: null });
    const forged = `${signPlatformAdminRefreshToken(OWNER, READER_SESSION, 1)}.${secret}`;

    await expect(platformAdminRefresh(forged)).rejects.toMatchObject({ statusCode: 401 });
    expect(control.platformAdminSession.update).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ refreshHash: expect.any(String) }) }));
  });
});

describe("the production secret check covers the console's signing secret", () => {
  const base = {
    JWT_ACCESS_SECRET: "a".repeat(8) + "Zq8!xP2#mK9$vL4^nB7&wR3*tY6(uI1)oE5",
    JWT_REFRESH_SECRET: "r".repeat(8) + "Hq3!yT8#pM2$cV7^dN4&fG9*jK1(lZ6)sX5",
    PLATFORM_ADMIN_JWT_SECRET: "p".repeat(8) + "Wq5!eR1#tY7$uI3^oP9&aS2*dF8(gH4)jK6",
    ENCRYPTION_KEY: "6e74a4d4d87c469904ac4d9f7cd499934a54566bf7b8ee322364b36e60f84458"
  };

  it("lists PLATFORM_ADMIN_JWT_SECRET among the secrets whose strength is checked", () => {
    expect(productionSecretsToCheck(base).map(([name]) => name)).toEqual(["JWT_ACCESS_SECRET", "JWT_REFRESH_SECRET", "PLATFORM_ADMIN_JWT_SECRET", "ENCRYPTION_KEY"]);
  });

  it("refuses a console secret that is the same value as a tenant secret", () => {
    expect(reusedSecretProblem(base)).toBeNull();
    expect(reusedSecretProblem({ ...base, PLATFORM_ADMIN_JWT_SECRET: base.JWT_ACCESS_SECRET })).toMatch(/PLATFORM_ADMIN_JWT_SECRET.*JWT_ACCESS_SECRET/);
    expect(reusedSecretProblem({ ...base, PLATFORM_ADMIN_JWT_SECRET: base.JWT_REFRESH_SECRET })).toMatch(/PLATFORM_ADMIN_JWT_SECRET.*JWT_REFRESH_SECRET/);
  });
});
