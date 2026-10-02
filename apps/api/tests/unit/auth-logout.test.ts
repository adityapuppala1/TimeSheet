/**
 * Signing out (security audit #9).
 *
 * THE DEFECT: `/logout` sat behind `requireAuth`, which answers 503 to everyone but a super admin
 * during maintenance and 402 on a lapsed plan, and the SPA swallowed any failure and said "Signed
 * out". The httpOnly refresh cookie and the server session both survived, and the next page load
 * refreshed straight back in — on a shared machine, the next person.
 *
 * NOW: the route needs no access token. It revokes the session the refresh COOKIE names (and the
 * one an access token names, if one is sent, expired or not), it always clears the cookie, and it
 * never meets the maintenance or billing gates because it no longer runs `requireAuth` at all.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import jwt from "jsonwebtoken";
import type { PrismaClient } from "@prisma/client";
import { runInTenant } from "../helpers/tenant-context.js";

vi.mock("../../src/config/control-prisma.js", () => ({ controlPrisma: { orgAuthMethod: { findUnique: vi.fn().mockResolvedValue(null) } } }));
// A workspace in maintenance: requireAuth would refuse every non-super-admin. Sign-out must not care.
vi.mock("../../src/services/maintenance.service.js", () => ({ isMaintenanceActive: vi.fn().mockResolvedValue(true) }));
vi.mock("../../src/services/org-status.service.js", () => ({ getOrgStatus: vi.fn().mockResolvedValue("GRACE") }));
vi.mock("../../src/services/audit.service.js", () => ({ audit: vi.fn().mockResolvedValue(undefined) }));

const { authRouter } = await import("../../src/controllers/auth.controller.js");
const { AppError, errorHandler } = await import("../../src/middleware/error.js");
const { signAccessToken, signRefreshToken } = await import("../../src/utils/security.js");
const { env } = await import("../../src/config/env.js");

const USER = "33333333-3333-4333-8333-333333333333";
const SID = "44444444-4444-4444-8444-444444444444";
const OTHER_SID = "55555555-5555-4555-8555-555555555555";

let client: PrismaClient & Record<string, any>;

function buildApp() {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use((_req, _res, next) => {
    runInTenant(client, async () => next(), "org-1").catch(next);
  });
  app.use("/api/auth", authRouter);
  app.use(errorHandler);
  return app;
}

const cookieFor = (sid: string, org = "org-1") => `refreshToken=${signRefreshToken(USER, sid, 14, org)}.secret-part`;
/** The Set-Cookie that deletes the refresh cookie: same name and path, expiry in the past. */
const clearsCookie = (res: request.Response) =>
  ([] as string[]).concat(res.headers["set-cookie"] ?? []).some((c) => /^refreshToken=;/.test(c) && /Path=\/api\/auth/.test(c) && /Expires=Thu, 01 Jan 1970/.test(c));

beforeEach(() => {
  client = {
    session: { updateMany: vi.fn().mockResolvedValue({ count: 1 }), findUnique: vi.fn(), update: vi.fn() },
    user: { findUnique: vi.fn() },
    auditLog: { create: vi.fn() }
  } as unknown as PrismaClient & Record<string, any>;
});

describe("POST /logout", () => {
  it("signs out with only the refresh cookie — no access token, during maintenance, on a lapsed plan", async () => {
    const res = await request(buildApp()).post("/api/auth/logout").set("Cookie", cookieFor(SID));

    expect(res.status).toBe(204);
    expect(clearsCookie(res)).toBe(true);
    expect(client.session.updateMany).toHaveBeenCalledWith({
      where: { id: { in: [SID] }, userId: USER, revokedAt: null },
      data: { revokedAt: expect.any(Date) }
    });
    // requireAuth never ran: it would have looked the user up and refused with 503.
    expect(client.user.findUnique).not.toHaveBeenCalled();
  });

  it("also ends the session an access token names, even one that has already expired", async () => {
    const expired = jwt.sign({ sid: OTHER_SID, org: "org-1" }, env.JWT_ACCESS_SECRET, {
      subject: USER,
      expiresIn: -60,
      algorithm: "HS256",
      issuer: "timesphere-api",
      audience: "timesphere-app"
    });
    await request(buildApp()).post("/api/auth/logout").set("Cookie", cookieFor(SID)).set("Authorization", `Bearer ${expired}`);

    const ids = (client.session.updateMany.mock.calls[0][0].where.id as { in: string[] }).in;
    expect(ids.sort()).toEqual([SID, OTHER_SID].sort());
  });

  it("always clears the cookie, even with no credentials at all", async () => {
    const res = await request(buildApp()).post("/api/auth/logout");
    expect(res.status).toBe(204);
    expect(clearsCookie(res)).toBe(true);
    expect(client.session.updateMany).not.toHaveBeenCalled();
  });

  it("does not honour a cookie minted for another workspace, but still clears it", async () => {
    const res = await request(buildApp()).post("/api/auth/logout").set("Cookie", cookieFor(SID, "org-2"));
    expect(res.status).toBe(204);
    expect(clearsCookie(res)).toBe(true);
    expect(client.session.updateMany).not.toHaveBeenCalled();
  });

  it("ignores a forged cookie (bad signature) and still answers 204", async () => {
    const forged = jwt.sign({ sid: SID, org: "org-1" }, "not-the-real-secret-at-all", { subject: USER, algorithm: "HS256" });
    const res = await request(buildApp()).post("/api/auth/logout").set("Cookie", `refreshToken=${forged}.x`);
    expect(res.status).toBe(204);
    expect(client.session.updateMany).not.toHaveBeenCalled();
  });

  it("still clears the cookie when the revocation itself fails", async () => {
    client.session.updateMany.mockRejectedValue(new Error("deadlock"));
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const res = await request(buildApp()).post("/api/auth/logout").set("Cookie", cookieFor(SID));
    expect(res.status).toBe(204);
    expect(clearsCookie(res)).toBe(true);
  });

  it("an access token alone (no cookie) still works, as it always did", async () => {
    const token = signAccessToken(USER, SID, "org-1");
    const res = await request(buildApp()).post("/api/auth/logout").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(204);
    expect((client.session.updateMany.mock.calls[0][0].where.id as { in: string[] }).in).toEqual([SID]);
  });
});

describe("the cookie is cleared before tenant resolution", () => {
  it("so a sign-out still clears it when the workspace cannot be resolved at all", async () => {
    const { clearRefreshCookieUpFront } = await import("../../src/utils/refresh-cookie.js");
    const app = express();
    app.post("/api/auth/logout", clearRefreshCookieUpFront);
    // Stands in for resolveTenant refusing a suspended or unknown workspace.
    app.use("/api", (_req, _res, next) => next(new AppError(404, "Unknown workspace.")));
    app.use(errorHandler);

    const res = await request(app).post("/api/auth/logout");
    expect(res.status).toBe(404);
    expect(clearsCookie(res)).toBe(true);
  });
});
