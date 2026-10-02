/**
 * `mustChangePassword` becomes a gate (security audit #11).
 *
 * THE DEFECT: account creation, bulk import and every admin reset set a password the ADMIN knows and
 * flag the account — but the flag was "a prompt, never a gate". The person could work indefinitely
 * on a password somebody else knows, while the Help manual told them they "must change it on first
 * sign-in".
 *
 * THE GATE, and its edges:
 *  - only for a session established by PASSWORD — an SSO or LDAP sign-in never used the admin's
 *    password, so it has nothing to change here; sessions from before the session recorded its
 *    method (NULL) are left alone rather than guessed at;
 *  - while it holds, requireAuth allows only what the forced-change screen needs — `/auth/me`,
 *    `/auth/change-password`, the heartbeat, and the two sign-outs — and answers everything else
 *    403 with code PASSWORD_CHANGE_REQUIRED;
 *  - it lifts the moment the password changes, in the same session.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.setConfig({ testTimeout: 45_000, hookTimeout: 45_000 });
import express from "express";
import request from "supertest";
import type { PrismaClient } from "@prisma/client";
import { createFakeTenantClient } from "../helpers/fake-prisma-client.js";
import { runInTenant } from "../helpers/tenant-context.js";

vi.mock("../../src/config/control-prisma.js", () => ({ controlPrisma: { orgAuthMethod: { findUnique: vi.fn().mockResolvedValue(null) } } }));
vi.mock("../../src/services/maintenance.service.js", () => ({ isMaintenanceActive: vi.fn().mockResolvedValue(false) }));
vi.mock("../../src/services/org-status.service.js", () => ({ getOrgStatus: vi.fn().mockResolvedValue("ACTIVE") }));
vi.mock("../../src/services/audit.service.js", () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
// The "your password was changed" mail is pinned in auth-audit-trail.test.ts; here it must not try.
vi.mock("../../src/services/notify.service.js", () => ({ dispatchTransactional: vi.fn().mockResolvedValue({ ok: true }) }));
vi.mock("../../src/services/workspace-directory.service.js", () => ({
  rememberWorkspaceMembership: vi.fn(),
  tenantBaseUrl: () => "https://acme.timesphere.test"
}));

const { requireAuth } = await import("../../src/middleware/auth.js");
const { authRouter } = await import("../../src/controllers/auth.controller.js");
const { errorHandler } = await import("../../src/middleware/error.js");
const { __resetLoginLockoutsForTests, completeSsoLogin, login } = await import("../../src/services/auth.service.js");
const { hashPassword, signAccessToken } = await import("../../src/utils/security.js");

const USER = "33333333-3333-4333-8333-333333333333";
const SID = "44444444-4444-4444-8444-444444444444";
const PASSWORD = "an-admin-set-one-1";
let passwordHash: string;
let client: ReturnType<typeof createFakeTenantClient> & Record<string, any>;

function userRow(overrides: Record<string, unknown> = {}) {
  return {
    id: USER, name: "Ada", email: "ada@example.com", passwordHash, status: "ACTIVE", deletedAt: null, mustChangePassword: true,
    avatarUrl: null, bio: null, phoneNumber: null, timezone: null, managerId: null, manager: null, appearance: null, aiPreferences: null,
    role: { name: "EMPLOYEE", permissions: [] }, userRoles: [], firstLoginAt: new Date(), isAgent: false,
    ...overrides
  };
}

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((_req, _res, next) => {
    runInTenant(client as PrismaClient, async () => next(), "org-1").catch(next);
  });
  app.use("/api/auth", authRouter);
  // Any ordinary authenticated route stands in for the rest of the product.
  app.get("/api/tickets", requireAuth, (_req, res) => void res.json([]));
  app.use(errorHandler);
  return app;
}

const bearer = () => ({ Authorization: `Bearer ${signAccessToken(USER, SID, "org-1")}` });
const sessionEstablishedBy = (authMethod: string | null) =>
  vi.mocked(client.session.findUnique).mockResolvedValue({ revokedAt: null, authMethod } as never);

beforeEach(async () => {
  __resetLoginLockoutsForTests();
  passwordHash ??= await hashPassword(PASSWORD);
  client = createFakeTenantClient() as typeof client;
  vi.mocked(client.user.findUnique).mockResolvedValue(userRow() as never);
  vi.mocked(client.user.findUniqueOrThrow).mockResolvedValue(userRow() as never);
  vi.mocked(client.session.update).mockResolvedValue({} as never);
  // changePassword voids outstanding reset links; the fake client has no such table of its own.
  client.passwordResetToken = { updateMany: vi.fn().mockResolvedValue({ count: 0 }) };
});

describe("while a password session still uses the admin's password", () => {
  it("everything outside the forced-change screen answers 403 PASSWORD_CHANGE_REQUIRED", async () => {
    sessionEstablishedBy("PASSWORD");
    const res = await request(buildApp()).get("/api/tickets").set(bearer());
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("PASSWORD_CHANGE_REQUIRED");
  });

  it("/auth/me still answers, and says the change is required", async () => {
    sessionEstablishedBy("PASSWORD");
    const res = await request(buildApp()).get("/api/auth/me").set(bearer());
    expect(res.status).toBe(200);
    expect(res.body.passwordChangeRequired).toBe(true);
  });

  it("the heartbeat still answers, so the open tab still learns about a force-logout", async () => {
    sessionEstablishedBy("PASSWORD");
    expect((await request(buildApp()).get("/api/auth/heartbeat").set(bearer())).status).toBe(200);
  });

  it("change-password is reachable — it is the way out", async () => {
    sessionEstablishedBy("PASSWORD");
    const res = await request(buildApp())
      .post("/api/auth/change-password")
      .set(bearer())
      .send({ currentPassword: PASSWORD, nextPassword: "my-own-choice-2026" });
    expect(res.status).toBe(204);
  });

  it("lifts the moment the flag clears, in the same session", async () => {
    sessionEstablishedBy("PASSWORD");
    vi.mocked(client.user.findUnique).mockResolvedValue(userRow({ mustChangePassword: false }) as never);
    expect((await request(buildApp()).get("/api/tickets").set(bearer())).status).toBe(200);
  });
});

describe("sessions the gate leaves alone", () => {
  it("an SSO or LDAP session — the admin's password was never used", async () => {
    sessionEstablishedBy(null);
    expect((await request(buildApp()).get("/api/tickets").set(bearer())).status).toBe(200);
    const me = await request(buildApp()).get("/api/auth/me").set(bearer());
    expect(me.body.passwordChangeRequired).toBe(false);
    // The prompt still has its flag to show.
    expect(me.body.mustChangePassword).toBe(true);
  });
});

describe("how the session learns its method", () => {
  beforeEach(() => {
    client.session.findFirst = vi.fn().mockResolvedValue(null);
    vi.mocked(client.session.findMany).mockResolvedValue([] as never);
    vi.mocked(client.session.create).mockImplementation((async ({ data }: { data: Record<string, unknown> }) => ({ id: SID, ...data })) as never);
    vi.mocked(client.user.update).mockResolvedValue(userRow() as never);
  });

  it("password sign-in records PASSWORD on the session, and tells the SPA the change is required", async () => {
    const result = await runInTenant(client as PrismaClient, () => login("ada@example.com", PASSWORD), "org-1");
    expect(vi.mocked(client.session.create).mock.calls[0][0].data).toMatchObject({ authMethod: "PASSWORD" });
    expect(result.user.passwordChangeRequired).toBe(true);
  });

  it("an SSO sign-in records no password method", async () => {
    await runInTenant(client as PrismaClient, () => completeSsoLogin("org-1", { email: "ada@example.com", name: "Ada" }), "org-1");
    expect(vi.mocked(client.session.create).mock.calls[0][0].data.authMethod ?? null).toBeNull();
  });
});
