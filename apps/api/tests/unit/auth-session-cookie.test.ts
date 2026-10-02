/**
 * "Remember me" and the idle limit (security audit #14).
 *
 * THE DEFECT: the refresh cookie always carried an Expires date — 14 days unticked, 30 ticked — so
 * leaving the box unticked still kept the person signed in after the browser was closed, and the box
 * was ticked by default. And `refresh()` never looked at `lastSeenAt`, so a session idle for a
 * fortnight rotated as happily as one used a minute ago.
 *
 * NOW:
 *  - unticked: a browser-session cookie (no Expires), and every refresh keeps it one — the choice is
 *    stored on the Session row, because the refresh request does not carry it;
 *  - ticked: the cookie expires with the session, as before;
 *  - SSO, LDAP and every pre-existing session (rememberMe NULL) keep the expiring cookie they had;
 *  - SESSION_IDLE_TIMEOUT_MINUTES (default 0 = off) makes refresh refuse — and revoke — a session
 *    whose last activity is older than that.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.setConfig({ testTimeout: 45_000, hookTimeout: 45_000 });
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import type { PrismaClient } from "@prisma/client";
import { createFakeTenantClient } from "../helpers/fake-prisma-client.js";
import { runInTenant } from "../helpers/tenant-context.js";

vi.mock("../../src/config/control-prisma.js", () => ({ controlPrisma: { orgAuthMethod: { findUnique: vi.fn().mockResolvedValue(null) } } }));
vi.mock("../../src/services/maintenance.service.js", () => ({ isMaintenanceActive: vi.fn().mockResolvedValue(false) }));
vi.mock("../../src/services/audit.service.js", () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../src/services/workspace-directory.service.js", () => ({
  rememberWorkspaceMembership: vi.fn(),
  tenantBaseUrl: () => "https://acme.timesphere.test"
}));

const { authRouter } = await import("../../src/controllers/auth.controller.js");
const { __resetLoginLockoutsForTests, refresh } = await import("../../src/services/auth.service.js");
const { errorHandler } = await import("../../src/middleware/error.js");
const { hashPassword, hashToken, opaqueToken, signRefreshToken } = await import("../../src/utils/security.js");
const { env } = await import("../../src/config/env.js");

const USER = "33333333-3333-4333-8333-333333333333";
const SID = "44444444-4444-4444-8444-444444444444";
const PASSWORD = "correct-horse-battery-staple";
let passwordHash: string;
let client: ReturnType<typeof createFakeTenantClient> & Record<string, any>;

function buildApp() {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use((_req, _res, next) => {
    runInTenant(client as PrismaClient, async () => next(), "org-1").catch(next);
  });
  app.use("/api/auth", authRouter);
  app.use(errorHandler);
  return app;
}

function userRow() {
  return {
    id: USER, name: "Ada", email: "ada@example.com", passwordHash, status: "ACTIVE", deletedAt: null, mustChangePassword: false,
    avatarUrl: null, bio: null, phoneNumber: null, timezone: null, managerId: null, manager: null,
    role: { name: "EMPLOYEE", permissions: [] }, userRoles: [], firstLoginAt: new Date(), isAgent: false
  };
}

/** The refresh cookie's Set-Cookie line, or undefined when the response set none. */
const refreshCookieOf = (res: request.Response) =>
  ([] as string[]).concat(res.headers["set-cookie"] ?? []).find((line) => line.startsWith("refreshToken="));

beforeEach(async () => {
  __resetLoginLockoutsForTests();
  passwordHash ??= await hashPassword(PASSWORD);
  client = createFakeTenantClient() as typeof client;
  vi.mocked(client.user.findUnique).mockResolvedValue(userRow() as never);
  vi.mocked(client.user.update).mockResolvedValue(userRow() as never);
  vi.mocked(client.session.findMany).mockResolvedValue([] as never);
  // No live session on this device yet, so sign-in creates a row rather than re-using one.
  client.session.findFirst = vi.fn().mockResolvedValue(null);
  vi.mocked(client.session.create).mockImplementation((async ({ data }: { data: Record<string, unknown> }) => ({ id: SID, ...data })) as never);
});

describe("Remember me", () => {
  it("unticked, the refresh cookie lives only as long as the browser does", async () => {
    const res = await request(buildApp()).post("/api/auth/login").send({ email: "ada@example.com", password: PASSWORD, rememberMe: false });
    expect(res.status).toBe(200);
    expect(refreshCookieOf(res)).toBeDefined();
    expect(refreshCookieOf(res)).not.toMatch(/Expires=/i);
    expect(vi.mocked(client.session.create).mock.calls[0][0].data).toMatchObject({ rememberMe: false });
  });

  it("left out of the request, it reads as unticked", async () => {
    const res = await request(buildApp()).post("/api/auth/login").send({ email: "ada@example.com", password: PASSWORD });
    expect(refreshCookieOf(res)).not.toMatch(/Expires=/i);
  });

  it("ticked, the cookie expires with the 30-day session", async () => {
    const res = await request(buildApp()).post("/api/auth/login").send({ email: "ada@example.com", password: PASSWORD, rememberMe: true });
    expect(refreshCookieOf(res)).toMatch(/Expires=/i);
    expect(vi.mocked(client.session.create).mock.calls[0][0].data).toMatchObject({ rememberMe: true });
  });
});

describe("refreshing keeps the cookie the person chose", () => {
  async function sessionRow(rememberMe: boolean | null, extra: Record<string, unknown> = {}) {
    const secret = opaqueToken();
    vi.mocked(client.session.findUnique).mockResolvedValue({
      id: SID, userId: USER, refreshHash: await hashToken(secret), previousRefreshHash: null, refreshRotatedAt: null, revokedAt: null,
      createdAt: new Date(), lastSeenAt: new Date(), expiresAt: new Date(Date.now() + 864e5), rememberMe, ...extra
    } as never);
    vi.mocked(client.session.update).mockResolvedValue({} as never);
    return `refreshToken=${signRefreshToken(USER, SID, 1, "org-1")}.${secret}`;
  }

  it("a browser-session cookie stays one", async () => {
    const res = await request(buildApp()).post("/api/auth/refresh").set("Cookie", await sessionRow(false));
    expect(res.status).toBe(200);
    expect(refreshCookieOf(res)).toBeDefined();
    expect(refreshCookieOf(res)).not.toMatch(/Expires=/i);
  });

  it("a remembered session keeps its expiry", async () => {
    const res = await request(buildApp()).post("/api/auth/refresh").set("Cookie", await sessionRow(true));
    expect(refreshCookieOf(res)).toMatch(/Expires=/i);
  });

  it("a session from before the choice existed (or from SSO) keeps the expiring cookie it always had", async () => {
    const res = await request(buildApp()).post("/api/auth/refresh").set("Cookie", await sessionRow(null));
    expect(refreshCookieOf(res)).toMatch(/Expires=/i);
  });

  it("a grace-window replay (a second tab) sets no cookie at all", async () => {
    const replayed = opaqueToken();
    const cookie = await sessionRow(false, {
      previousRefreshHash: await hashToken(replayed),
      refreshRotatedAt: new Date(Date.now() - 1_000)
    });
    const res = await request(buildApp())
      .post("/api/auth/refresh")
      .set("Cookie", cookie.replace(/\.[^.]+$/, `.${replayed}`));
    expect(res.status).toBe(200);
    expect(res.body.accessToken).toEqual(expect.any(String));
    expect(refreshCookieOf(res)).toBeUndefined();
  });
});

describe("SESSION_IDLE_TIMEOUT_MINUTES", () => {
  const original = env.SESSION_IDLE_TIMEOUT_MINUTES;
  afterEach(() => {
    env.SESSION_IDLE_TIMEOUT_MINUTES = original;
  });

  async function idleSession(lastSeenAt: Date | null, createdAt = new Date()) {
    const secret = opaqueToken();
    vi.mocked(client.session.findUnique).mockResolvedValue({
      id: SID, userId: USER, refreshHash: await hashToken(secret), previousRefreshHash: null, refreshRotatedAt: null, revokedAt: null,
      createdAt, lastSeenAt, expiresAt: new Date(Date.now() + 864e5), rememberMe: true
    } as never);
    vi.mocked(client.session.update).mockResolvedValue({} as never);
    return `${signRefreshToken(USER, SID, 1, "org-1")}.${secret}`;
  }
  const inTenant = <T>(fn: () => Promise<T>) => runInTenant(client as PrismaClient, fn, "org-1");

  it("defaults to off: a session idle for days still refreshes", async () => {
    expect(env.SESSION_IDLE_TIMEOUT_MINUTES).toBe(0);
    const token = await idleSession(new Date(Date.now() - 5 * 24 * 60 * 60_000));
    await expect(inTenant(() => refresh(token))).resolves.toMatchObject({ accessToken: expect.any(String) });
  });

  it("when set, refuses and revokes a session idle for longer", async () => {
    env.SESSION_IDLE_TIMEOUT_MINUTES = 30;
    const token = await idleSession(new Date(Date.now() - 31 * 60_000));
    await expect(inTenant(() => refresh(token))).rejects.toMatchObject({ statusCode: 401 });
    expect(vi.mocked(client.session.update).mock.calls[0][0]).toMatchObject({ where: { id: SID }, data: { revokedAt: expect.any(Date) } });
  });

  it("when set, lets a recently active session through", async () => {
    env.SESSION_IDLE_TIMEOUT_MINUTES = 30;
    const token = await idleSession(new Date(Date.now() - 10 * 60_000));
    await expect(inTenant(() => refresh(token))).resolves.toMatchObject({ accessToken: expect.any(String) });
  });

  it("reads a session never stamped (lastSeenAt NULL) by when it was created", async () => {
    env.SESSION_IDLE_TIMEOUT_MINUTES = 30;
    const token = await idleSession(null, new Date(Date.now() - 2 * 60 * 60_000));
    await expect(inTenant(() => refresh(token))).rejects.toMatchObject({ statusCode: 401 });
  });
});
