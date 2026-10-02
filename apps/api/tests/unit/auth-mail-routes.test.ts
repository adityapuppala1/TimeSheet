/**
 * The two unauthenticated routes that send mail to an address the caller types: `/forgot-password`
 * and the workspace finder's `/workspaces/start`. Driven through the real router.
 *
 * Three audit findings meet here:
 *  - #6, TIMING. Both answered only after the lookup, the token write and the SMTP send for a real
 *    account, and after one lookup for an unknown one — so the response TIME said whether the
 *    address existed, even though the body was identical. They now reply 202 first and do the
 *    work afterwards, with every failure caught and logged.
 *  - #5, VOLUME. A per-address cap held in the database (the store every replica shares): three
 *    reset links, or three finder codes, per address per hour. Past it the reply is the same 202
 *    and nothing is sent. (The per-IP limiter that counts every request is pinned in
 *    auth-limits.test.ts.)
 *  - SSO L3. While a workspace has password sign-in switched off, forgot-password sends nothing and
 *    a reset link is refused with a message that says why.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
vi.setConfig({ testTimeout: 30_000 });
import express from "express";
import request from "supertest";
import type { PrismaClient } from "@prisma/client";
import { runInTenant } from "../helpers/tenant-context.js";

const orgAuthMethod = { findUnique: vi.fn() };
vi.mock("../../src/config/control-prisma.js", () => ({
  controlPrisma: { orgAuthMethod, orgSsoConfig: { findMany: vi.fn().mockResolvedValue([]) } }
}));
const dispatchTransactional = vi.fn(async () => ({ ok: true }));
vi.mock("../../src/services/notify.service.js", () => ({ dispatchTransactional }));
vi.mock("../../src/services/audit.service.js", () => ({ audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../src/services/maintenance.service.js", () => ({ isMaintenanceActive: vi.fn().mockResolvedValue(false) }));
vi.mock("../../src/config/with-org-tenant.js", () => ({ withOrgTenant: (_slug: string, fn: () => Promise<unknown>) => fn() }));

const findWorkspacesForEmail = vi.fn(async (): Promise<Array<{ slug: string }>> => []);
const countRecentVerificationCodes = vi.fn(async () => 0);
const storeVerificationCode = vi.fn(async () => undefined);
const issueVerificationCode = vi.fn(async () => ({ token: "tok", code: "123456" }));
vi.mock("../../src/services/workspace-directory.service.js", () => ({
  findWorkspacesForEmail,
  countRecentVerificationCodes,
  storeVerificationCode,
  issueVerificationCode,
  newVerificationCode: () => ({ token: "tok", code: "123456" }),
  checkVerificationCode: vi.fn(),
  tenantBaseUrl: () => "https://acme.timesphere.test",
  rememberWorkspaceMembership: vi.fn()
}));

const { authRouter } = await import("../../src/controllers/auth.controller.js");
const { errorHandler } = await import("../../src/middleware/error.js");

let client: PrismaClient & Record<string, any>;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((_req, _res, next) => {
    runInTenant(client, async () => next(), "org-1").catch(next);
  });
  app.use("/api/auth", authRouter);
  app.use(errorHandler);
  return app;
}

/** A promise the test resolves by hand — what proves the reply did not wait for it. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

/** Lets the work queued after the reply run to completion before a negative assertion. */
const settle = () => new Promise((r) => setTimeout(r, 25));

const ADA = { id: "11111111-1111-4111-8111-111111111111", name: "Ada", email: "ada@example.com", status: "ACTIVE", deletedAt: null };

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks keeps implementations, so the defaults a test may override are restored here.
  orgAuthMethod.findUnique.mockResolvedValue(null);
  countRecentVerificationCodes.mockResolvedValue(0);
  findWorkspacesForEmail.mockResolvedValue([]);
  client = {
    user: { findUnique: vi.fn().mockResolvedValue(ADA) },
    passwordResetToken: {
      create: vi.fn(async ({ data }: { data: unknown }) => data),
      count: vi.fn().mockResolvedValue(0),
      findUnique: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([])
    },
    auditLog: { create: vi.fn() }
  } as unknown as PrismaClient & Record<string, any>;
});

describe("forgot-password", () => {
  it("answers 202 before it has even looked the address up", async () => {
    const lookup = deferred<typeof ADA | null>();
    client.user.findUnique.mockReturnValue(lookup.promise);

    const res = await request(buildApp()).post("/api/auth/forgot-password").send({ email: "ada@example.com" });
    expect(res.status).toBe(202);
    // The reply is already on the wire while the lookup is still pending — so nothing about the
    // account can have shaped how long it took.
    expect(dispatchTransactional).not.toHaveBeenCalled();

    lookup.resolve(ADA);
    await vi.waitFor(() => expect(dispatchTransactional).toHaveBeenCalledTimes(1));
  });

  it("a failure after the reply is caught and logged, never thrown at the client", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    client.user.findUnique.mockRejectedValue(new Error("database went away"));

    const res = await request(buildApp()).post("/api/auth/forgot-password").send({ email: "ada@example.com" });
    expect(res.status).toBe(202);
    await vi.waitFor(() => expect(logged).toHaveBeenCalledWith(expect.stringContaining("database went away")));
  });

  it("sends a link while the address is under its hourly cap", async () => {
    client.passwordResetToken.count.mockResolvedValue(2);
    await request(buildApp()).post("/api/auth/forgot-password").send({ email: "ada@example.com" });
    await vi.waitFor(() => expect(dispatchTransactional).toHaveBeenCalledTimes(1));
  });

  it("past three links in an hour, answers the same 202 and sends nothing", async () => {
    client.passwordResetToken.count.mockResolvedValue(3);
    const res = await request(buildApp()).post("/api/auth/forgot-password").send({ email: "ada@example.com" });

    expect(res.status).toBe(202);
    await vi.waitFor(() => expect(client.passwordResetToken.count).toHaveBeenCalled());
    await settle();
    expect(client.passwordResetToken.count.mock.calls[0][0]).toMatchObject({ where: { userId: ADA.id, createdAt: { gt: expect.any(Date) } } });
    expect(client.passwordResetToken.create).not.toHaveBeenCalled();
    expect(dispatchTransactional).not.toHaveBeenCalled();
  });

  it("sends nothing while the workspace has password sign-in switched off, with the same 202", async () => {
    orgAuthMethod.findUnique.mockResolvedValue({ requireSsoOnly: true, passwordLoginEnabled: true });
    const res = await request(buildApp()).post("/api/auth/forgot-password").send({ email: "ada@example.com" });

    expect(res.status).toBe(202);
    await vi.waitFor(() => expect(orgAuthMethod.findUnique).toHaveBeenCalled());
    await settle();
    expect(client.passwordResetToken.create).not.toHaveBeenCalled();
    expect(dispatchTransactional).not.toHaveBeenCalled();
  });
});

describe("reset-password under SSO-only", () => {
  it("is refused with a message that says why", async () => {
    orgAuthMethod.findUnique.mockResolvedValue({ requireSsoOnly: true, passwordLoginEnabled: true });
    const res = await request(buildApp())
      .post("/api/auth/reset-password")
      .send({ token: `${"s".repeat(16)}.${"v".repeat(48)}`, password: "a-genuinely-new-one" });

    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/single sign-on/i);
    expect(client.passwordResetToken.findUnique).not.toHaveBeenCalled();
  });
});

describe("workspaces/start", () => {
  it("answers 202 with its token before it has looked anything up", async () => {
    const lookup = deferred<Array<{ slug: string }>>();
    findWorkspacesForEmail.mockReturnValue(lookup.promise);

    const res = await request(buildApp()).post("/api/auth/workspaces/start").send({ email: "ada@example.com" });
    expect(res.status).toBe(202);
    expect(res.body.token).toEqual(expect.any(String));
    expect(dispatchTransactional).not.toHaveBeenCalled();

    lookup.resolve([{ slug: "acme" }]);
    await vi.waitFor(() => expect(dispatchTransactional).toHaveBeenCalledTimes(1));
  });

  it("past three codes in an hour for one address, answers the same 202 and sends nothing", async () => {
    findWorkspacesForEmail.mockResolvedValue([{ slug: "acme" }]);
    countRecentVerificationCodes.mockResolvedValue(3);

    const res = await request(buildApp()).post("/api/auth/workspaces/start").send({ email: "ada@example.com" });
    expect(res.status).toBe(202);
    expect(res.body.token).toEqual(expect.any(String));
    await vi.waitFor(() => expect(countRecentVerificationCodes).toHaveBeenCalledWith("ada@example.com", "discover"));
    await settle();
    expect(storeVerificationCode).not.toHaveBeenCalled();
    expect(dispatchTransactional).not.toHaveBeenCalled();
  });

  it("stores the code for a miss too, so the token behaves the same either way", async () => {
    findWorkspacesForEmail.mockResolvedValue([]);
    await request(buildApp()).post("/api/auth/workspaces/start").send({ email: "nobody@example.com" });
    await vi.waitFor(() => expect(storeVerificationCode).toHaveBeenCalledTimes(1));
    expect(dispatchTransactional).not.toHaveBeenCalled();
  });
});
