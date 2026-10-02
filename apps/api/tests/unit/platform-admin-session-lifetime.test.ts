/**
 * M5 — a console session used to live as long as a tenant's: REFRESH_TOKEN_TTL_DAYS, 14 days, and no
 * idle timeout at all. A laptop left open on the console stayed an owner's console for a fortnight.
 *
 * Now it has its own lifetime: PLATFORM_ADMIN_SESSION_TTL_HOURS (default 12) measured from when the
 * session was created and never extended, and PLATFORM_ADMIN_IDLE_TIMEOUT_MINUTES (default 30) since
 * the session last carried a request. Both are enforced on every request and on refresh, so neither
 * a still-valid access token nor a refresh cookie outlives them. Sessions created before the change
 * are held to the same absolute limit from their own creation time.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const ADMIN = "00000000-0000-4000-8000-0000000000a1";
const SESSION = "00000000-0000-4000-8000-0000000000a2";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

let session: Record<string, unknown>;
const control = {
  platformAdminUser: {
    findUnique: vi.fn(async () => ({ id: ADMIN, email: "o@timesphere.app", name: "O", role: "OWNER", status: "ACTIVE", mfaEnabled: true, mustChangePassword: false })),
    update: vi.fn().mockResolvedValue({})
  },
  platformAdminSession: {
    findUnique: vi.fn(async () => session),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: SESSION, ...data })),
    update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      session = { ...session, ...data };
      return session;
    }),
    updateMany: vi.fn().mockResolvedValue({ count: 0 })
  }
};
vi.mock("../../src/config/control-prisma.js", () => ({ controlPrisma: control }));

const { consoleSessionLapse } = await import("../../src/services/platform-session-policy.js");
const { requirePlatformAdmin } = await import("../../src/middleware/platform-admin-auth.js");
const { errorHandler } = await import("../../src/middleware/error.js");
const { signPlatformAdminAccessToken, signPlatformAdminRefreshToken } = await import("../../src/utils/platform-admin-security.js");
const { platformAdminRefresh, platformAdminLogin } = await import("../../src/services/platform-admin-auth.service.js");
const { hashToken, hashPassword } = await import("../../src/utils/security.js");

const POLICY = { ttlHours: 12, idleMinutes: 30 };
const at = (msAgo: number) => new Date(Date.now() - msAgo);

describe("consoleSessionLapse", () => {
  const now = new Date();
  const base = { createdAt: at(HOUR), lastUsedAt: at(MINUTE), expiresAt: new Date(Date.now() + HOUR) };

  it("keeps a session that is inside both limits", () => {
    expect(consoleSessionLapse(base, now, POLICY)).toBeNull();
  });

  it("ends a session past the absolute lifetime however recently it was used", () => {
    expect(consoleSessionLapse({ ...base, createdAt: at(12 * HOUR + MINUTE) }, now, POLICY)).toBe("absolute");
  });

  it("holds a pre-change 14-day session to the same absolute limit from its own creation", () => {
    expect(consoleSessionLapse({ ...base, createdAt: at(13 * HOUR), expiresAt: new Date(Date.now() + 13 * 24 * HOUR) }, now, POLICY)).toBe("absolute");
  });

  it("ends a session idle for longer than the idle timeout", () => {
    expect(consoleSessionLapse({ ...base, lastUsedAt: at(31 * MINUTE) }, now, POLICY)).toBe("idle");
  });

  it("counts a session that has never recorded a request from its creation", () => {
    expect(consoleSessionLapse({ ...base, createdAt: at(31 * MINUTE), lastUsedAt: null }, now, POLICY)).toBe("idle");
  });
});

describe("enforced on every request", () => {
  const app = express();
  app.get("/overview", requirePlatformAdmin, (_req, res) => {
    res.json({ ok: true });
  });
  app.use(errorHandler);
  const call = () => request(app).get("/overview").set("Authorization", `Bearer ${signPlatformAdminAccessToken(ADMIN, SESSION)}`);

  beforeEach(() => {
    vi.clearAllMocks();
    session = { id: SESSION, adminUserId: ADMIN, revokedAt: null, createdAt: at(HOUR), lastUsedAt: at(2 * MINUTE), expiresAt: new Date(Date.now() + HOUR) };
  });

  it("refuses a still-valid access token on an idle session, and revokes the session", async () => {
    session = { ...session, lastUsedAt: at(45 * MINUTE) };
    expect((await call()).status).toBe(401);
    expect(session.revokedAt).toBeInstanceOf(Date);
  });

  it("records activity, so a session in use is never the idle one", async () => {
    expect((await call()).status).toBe(200);
    expect((session.lastUsedAt as Date).getTime()).toBeGreaterThan(Date.now() - 5_000);
  });
});

describe("enforced on refresh", () => {
  it("will not refresh an idle session", async () => {
    const secret = "refresh-secret";
    session = { id: SESSION, adminUserId: ADMIN, revokedAt: null, refreshHash: await hashToken(secret), createdAt: at(HOUR), lastUsedAt: at(45 * MINUTE), expiresAt: new Date(Date.now() + HOUR) };
    await expect(platformAdminRefresh(`${signPlatformAdminRefreshToken(ADMIN, SESSION, 1)}.${secret}`)).rejects.toMatchObject({ statusCode: 401 });
  });
});

describe("a new session's lifetime", () => {
  it("is the console's own TTL, not the tenants' fourteen days", async () => {
    const hash = await hashPassword("Correct-Horse-Battery-9");
    control.platformAdminUser.findUnique.mockResolvedValueOnce({ id: ADMIN, email: "o@timesphere.app", name: "O", role: "OWNER", status: "ACTIVE", mfaEnabled: false, mfaSecret: null, passwordHash: hash, mustChangePassword: false, lockedUntil: null } as never);
    const result = await platformAdminLogin("o@timesphere.app", "Correct-Horse-Battery-9");
    expect(result.mfaRequired).toBe(false);
    const created = control.platformAdminSession.create.mock.calls.at(-1)?.[0] as { data: { expiresAt: Date } };
    const hours = (created.data.expiresAt.getTime() - Date.now()) / HOUR;
    expect(hours).toBeGreaterThan(11.9);
    expect(hours).toBeLessThanOrEqual(12);
  }, 30_000);
});
