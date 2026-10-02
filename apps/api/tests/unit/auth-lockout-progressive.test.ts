/**
 * The per-account lockout escalates instead of resetting (security audit #12).
 *
 * THE DEFECT: five failures armed a five-minute lock — and set the counter back to zero as the lock
 * started. So every five minutes bought five fresh guesses: about 1,440 a day against one account,
 * forever. And the LDAP sign-in route had no per-account lockout at all.
 *
 * NOW: the count survives the lock, so once an account has been locked, each further failure
 * re-locks it — for 5 minutes, then 15, then 60, and never longer than that. A success (or a
 * completed password reset) clears it, and
 * a quiet spell longer than the decay window after the last lock forgives it. The LDAP route shares
 * the same counter: it is the same account.
 *
 * Still in memory, per process (a shared store is a proposal that goes with the multi-replica work).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.setConfig({ testTimeout: 45_000, hookTimeout: 45_000 });
import express from "express";
import request from "supertest";
import type { PrismaClient } from "@prisma/client";
import { createFakeTenantClient } from "../helpers/fake-prisma-client.js";
import { runInTenant } from "../helpers/tenant-context.js";

vi.mock("../../src/config/control-prisma.js", () => ({ controlPrisma: { orgAuthMethod: { findUnique: vi.fn().mockResolvedValue(null) } } }));
vi.mock("../../src/services/maintenance.service.js", () => ({ isMaintenanceActive: vi.fn().mockResolvedValue(false) }));
vi.mock("../../src/services/audit.service.js", () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
const authenticateLdap = vi.fn();
vi.mock("../../src/services/sso.service.js", () => ({ authenticateLdap, recordSsoLoginSuccess: vi.fn() }));

const { login, __resetLoginLockoutsForTests } = await import("../../src/services/auth.service.js");
const { authRouter } = await import("../../src/controllers/auth.controller.js");
const { AppError, errorHandler } = await import("../../src/middleware/error.js");

const MINUTE = 60_000;
let client: ReturnType<typeof createFakeTenantClient>;
let offset = 0;
/** Captured once: re-binding `Date.now` after it is already spied on would make the spy call itself. */
const realNow = Date.now.bind(Date);

/** Moves the clock forward for everything that reads `Date.now`. */
function advance(ms: number) {
  offset += ms;
  vi.spyOn(Date, "now").mockImplementation(() => realNow() + offset);
}

async function passwordAttempt(email = "ada@example.com") {
  try {
    await runInTenant(client, () => login(email, "wrong-password"), "org-1");
    return 200;
  } catch (error) {
    return (error as { statusCode?: number }).statusCode;
  }
}

async function failFiveTimes() {
  for (let i = 0; i < 5; i += 1) expect(await passwordAttempt()).toBe(401);
}

beforeEach(() => {
  __resetLoginLockoutsForTests();
  vi.restoreAllMocks();
  offset = 0;
  client = createFakeTenantClient();
  vi.mocked(client.user.findUnique).mockResolvedValue(null as never);
  authenticateLdap.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe("password sign-in", () => {
  it("does not hand out five fresh guesses when the first lock ends", async () => {
    await failFiveTimes();
    expect(await passwordAttempt()).toBe(429);

    advance(5 * MINUTE + 1_000); // the first lock is served
    expect(await passwordAttempt()).toBe(401); // this guess is evaluated…
    expect(await passwordAttempt()).toBe(429); // …and re-arms the lock at once
  });

  it("escalates the lock: 5 minutes, then 15, then 60", async () => {
    await failFiveTimes();
    advance(5 * MINUTE + 1_000);
    await passwordAttempt(); // second lock: 15 minutes

    advance(14 * MINUTE);
    expect(await passwordAttempt()).toBe(429);
    advance(2 * MINUTE);
    await passwordAttempt(); // third lock: 60 minutes

    advance(59 * MINUTE);
    expect(await passwordAttempt()).toBe(429);
    advance(2 * MINUTE);
    expect(await passwordAttempt()).toBe(401);
  });

  it("never locks an account for longer than an hour, however many failures follow", async () => {
    // The ladder stops at 60 minutes on purpose: every step above it is time a STRANGER can take
    // from the real owner with one wrong guess per lock (the lockout-abuse cost OWASP warns about),
    // and an hour per guess already caps a determined attacker at ~24 guesses a day.
    await failFiveTimes();
    advance(5 * MINUTE + 1_000);
    await passwordAttempt(); // 15
    advance(16 * MINUTE);
    await passwordAttempt(); // 60
    advance(61 * MINUTE);
    await passwordAttempt(); // would have been 4 hours
    advance(61 * MINUTE);
    expect(await passwordAttempt()).toBe(401);
  });

  it("says how long the lock has left", async () => {
    await failFiveTimes();
    advance(5 * MINUTE + 1_000);
    await passwordAttempt();
    await expect(runInTenant(client, () => login("ada@example.com", "wrong-password"), "org-1")).rejects.toThrow(/15 minutes/);
  });

  it("forgives a long enough quiet spell after the last lock", async () => {
    await failFiveTimes();
    advance(5 * MINUTE + 16 * MINUTE); // the lock, then longer than the decay window
    for (let i = 0; i < 4; i += 1) expect(await passwordAttempt()).toBe(401);
  });
});

describe("LDAP sign-in shares the lockout", () => {
  function buildApp() {
    const app = express();
    app.use(express.json());
    app.use((_req, _res, next) => {
      runInTenant(client as PrismaClient, async () => next(), "org-1").catch(next);
    });
    app.use("/api/auth", authRouter);
    app.use(errorHandler);
    return app;
  }
  const ldap = (app: express.Express) => request(app).post("/api/auth/login/ldap").send({ email: "ada@example.com", password: "wrong" });

  it("locks after five failed binds, without reaching the directory again", async () => {
    authenticateLdap.mockRejectedValue(new AppError(401, "Invalid email or password."));
    const app = buildApp();
    for (let i = 0; i < 5; i += 1) expect((await ldap(app)).status).toBe(401);

    const locked = await ldap(app);
    expect(locked.status).toBe(429);
    expect(authenticateLdap).toHaveBeenCalledTimes(5);
  });

  it("does not count a directory outage against the person", async () => {
    authenticateLdap.mockRejectedValue(new AppError(502, "Couldn't reach the directory server."));
    const app = buildApp();
    for (let i = 0; i < 6; i += 1) expect((await ldap(app)).status).toBe(502);
  });

  it("counts LDAP and password failures against the same account", async () => {
    authenticateLdap.mockRejectedValue(new AppError(401, "Invalid email or password."));
    const app = buildApp();
    for (let i = 0; i < 3; i += 1) await ldap(app);
    for (let i = 0; i < 2; i += 1) expect(await passwordAttempt()).toBe(401);
    expect((await ldap(app)).status).toBe(429);
  });
});
