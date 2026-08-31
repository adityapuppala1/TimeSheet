/**
 * POST /platform-admin/organizations/:id/reset-admin-password — the console-side rescue for a
 * workspace whose only super admin is locked out.
 *
 * The route's value is entirely in what it REFUSES. It can reach inside any customer's database,
 * so each guard is tested by trying to get past it:
 *
 *  - not ACTIVE → 409 (no administrator exists yet, or the org is suspended)
 *  - no such account → 404
 *  - an account that is not a SUPER_ADMIN → 403 (this is a lock picked for the owner, not a way
 *    to take over any employee's account from the platform side)
 *
 * And on the happy path: a hash is stored (never the plaintext), `mustChangePassword` is set,
 * every session of the target is revoked, an audit row lands in the TENANT's log, and the
 * plaintext comes back exactly once in the response.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const ORG = { id: "org-1", slug: "acme", status: "ACTIVE" };
/**
 * `role` and `REASON` are 4.1.0 additions and both are load-bearing here.
 *
 * The route now sits behind `requirePlatformCapability(PLATFORM_SUPPORT)` and
 * `requirePlatformReason`. Without a role on the actor the capability guard 403s every test in this
 * file; without the header the reason guard 400s them. SUPPORT rather than OWNER on purpose — this
 * is the least-privileged role that is supposed to be able to run a rescue, so the fixture proves
 * the classification rather than sailing over it with the most powerful role available.
 */
const ACTOR = { id: "pa-1", name: "Ops", email: "ops@timesphere.app", role: "SUPPORT" as const };
const REASON = "Ticket 4192 - their SSO broke and nobody can sign in";

const control = { organization: { findUnique: vi.fn() }, platformAuditLog: { create: vi.fn() } };
vi.mock("../../src/config/control-prisma.js", () => ({ controlPrisma: control }));

/*
 * PARTIAL, VIA `importActual` — deliberately not a one-key factory any more.
 *
 * The previous version returned an object with exactly one key, `requirePlatformAdmin`. That was
 * right when the module exported exactly one thing; the moment the router also imported
 * `requirePlatformCapability` and `requirePlatformReason` from it, the mock made those `undefined`
 * and the file died at ROUTER CONSTRUCTION with an unhelpful "argument handler must be a function".
 *
 * Spreading the real module and overriding only the authentication step is better than adding two
 * more stubs: the capability gate and the reason gate then run FOR REAL on this route, so this file
 * now also pins that a rescue needs `platform:support` and a written justification. Only the "who
 * are you" step is faked, which is the one thing a unit test cannot supply.
 */
vi.mock("../../src/middleware/platform-admin-auth.js", async (importActual) => {
  const actual = await importActual<typeof import("../../src/middleware/platform-admin-auth.js")>();
  return {
    ...actual,
    requirePlatformAdmin: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
      req.platformAdmin = { ...ACTOR };
      req.platformAdminSessionId = "sess-1";
      next();
    }
  };
});

const tenant = {
  user: { findFirst: vi.fn(), update: vi.fn() },
  session: { updateMany: vi.fn() }
};
// withOrgTenant would resolve the org, decrypt its DSN and open a client; here it just runs the
// callback with a fake tenant context, which is the whole contract the route depends on.
vi.mock("../../src/config/with-org-tenant.js", () => ({
  withOrgTenant: vi.fn(async (_slug: string, fn: () => Promise<unknown>) => fn())
}));
vi.mock("../../src/config/tenant-context.js", () => ({
  requireTenantContext: () => ({ orgId: ORG.id, orgSlug: ORG.slug, client: tenant }),
  tenantContext: { getStore: () => ({ orgId: ORG.id, orgSlug: ORG.slug, client: tenant }) }
}));

const audit = vi.fn().mockResolvedValue(undefined);
vi.mock("../../src/services/audit.service.js", () => ({ audit }));
// Not under test, and they pull in mail + prisma at import time.
vi.mock("../../src/services/notify.service.js", () => ({ dispatchTransactional: vi.fn() }));
vi.mock("../../src/services/provisioning.service.js", () => ({ provisionOrganization: vi.fn() }));
vi.mock("../../src/services/platform-admin-analytics.service.js", () => ({ getPlatformAnalytics: vi.fn() }));
vi.mock("../../src/services/org-domain.service.js", () => ({ addDomain: vi.fn(), listDomains: vi.fn(), removeDomain: vi.fn(), verifyDomain: vi.fn() }));
vi.mock("../../src/services/workspace-directory.service.js", () => ({ workspaceUrlForSlug: (slug: string) => `https://${slug}.example.test` }));

const { platformAdminRouter } = await import("../../src/controllers/platform-admin.controller.js");
const { errorHandler } = await import("../../src/middleware/error.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/platform-admin", platformAdminRouter);
  app.use(errorHandler);
  return app;
}

const SUPER = { id: "u-1", name: "Owner", status: "ACTIVE", role: { name: "SUPER_ADMIN" } };

beforeEach(() => {
  vi.clearAllMocks();
  control.organization.findUnique.mockResolvedValue(ORG);
  tenant.user.findFirst.mockResolvedValue(SUPER);
  tenant.user.update.mockResolvedValue(SUPER);
  tenant.session.updateMany.mockResolvedValue({ count: 3 });
});

const call = (body: unknown = { email: "Owner@Acme.com" }) =>
  request(buildApp()).post(`/api/platform-admin/organizations/${ORG.id}/reset-admin-password`).set("X-Platform-Reason", REASON).send(body);

/** The same call with no justification — what an operator's console sends before it asks "why?". */
const callWithoutReason = (body: unknown = { email: "Owner@Acme.com" }) =>
  request(buildApp()).post(`/api/platform-admin/organizations/${ORG.id}/reset-admin-password`).send(body);

describe("reset-admin-password guards", () => {
  it("404s an unknown organisation", async () => {
    control.organization.findUnique.mockResolvedValue(null);
    expect((await call()).status).toBe(404);
    expect(tenant.user.update).not.toHaveBeenCalled();
  });

  it("409s a workspace that is not ACTIVE — there is nobody to reset yet", async () => {
    control.organization.findUnique.mockResolvedValue({ ...ORG, status: "PROVISIONING" });
    const res = await call();
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/provisioning/);
    expect(tenant.user.update).not.toHaveBeenCalled();
  });

  it("404s an address that is not in that workspace", async () => {
    tenant.user.findFirst.mockResolvedValue(null);
    expect((await call()).status).toBe(404);
    expect(tenant.user.update).not.toHaveBeenCalled();
  });

  it("403s an account that is not a super admin — the platform does not reset employees", async () => {
    tenant.user.findFirst.mockResolvedValue({ ...SUPER, role: { name: "MANAGER" } });
    const res = await call();
    expect(res.status).toBe(403);
    expect(tenant.user.update).not.toHaveBeenCalled();
    expect(tenant.session.updateMany).not.toHaveBeenCalled();
  });

  it("refuses without a written reason — this reaches inside a customer's database", async () => {
    const res = await callWithoutReason();
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("REASON_REQUIRED");
    expect(tenant.user.update).not.toHaveBeenCalled();
  });

  it("refuses a role that does not hold platform:support", async () => {
    ACTOR.role = "BILLING" as never;
    try {
      const res = await call();
      expect(res.status).toBe(403);
      expect(tenant.user.update).not.toHaveBeenCalled();
    } finally {
      ACTOR.role = "SUPPORT";
    }
  });

  it("rejects a body that is not just an email — the platform never chooses the password", async () => {
    // validate() answers 422 for a schema miss; `.strict()` is what makes the extra key a miss.
    expect((await call({ email: "owner@acme.com", password: "MyChoice-123456" })).status).toBe(422);
    expect((await call({ email: "not-an-email" })).status).toBe(422);
    expect(tenant.user.update).not.toHaveBeenCalled();
  });
});

describe("reset-admin-password happy path", () => {
  it("issues a one-time password, flags it for change, evicts every session, and audits in the tenant", async () => {
    const res = await call();
    expect(res.status).toBe(200);

    // Lower-cased before lookup, so `Owner@Acme.com` finds `owner@acme.com`.
    expect(tenant.user.findFirst.mock.calls[0][0]).toMatchObject({ where: { email: "owner@acme.com", deletedAt: null } });

    const update = tenant.user.update.mock.calls[0][0] as { where: { id: string }; data: { passwordHash: string; mustChangePassword: boolean } };
    expect(update.where).toEqual({ id: SUPER.id });
    expect(update.data.mustChangePassword).toBe(true);
    // A hash, never the plaintext that went back to the caller.
    expect(update.data.passwordHash).not.toBe(res.body.temporaryPassword);
    expect(update.data.passwordHash.length).toBeGreaterThan(30);

    const revoke = tenant.session.updateMany.mock.calls[0][0] as { where: Record<string, unknown> };
    expect(revoke.where).toMatchObject({ userId: SUPER.id, revokedAt: null });

    // Attributed as a GUEST (a real person, not a member of this tenant) carrying the platform
    // admin's identity in the label — the customer's own log says who did it.
    expect(audit).toHaveBeenCalledWith(
      undefined,
      "user.password_reset_by_platform",
      "User",
      SUPER.id,
      // The operator's OWN words now, not the constant "platform-admin rescue" this used to send:
      // the customer reading their own log deserves to know why somebody outside their workspace
      // reset their owner's password.
      expect.objectContaining({ by: ACTOR.email, reason: REASON }),
      expect.objectContaining({ actorType: "GUEST", actorLabel: `platform-admin:${ACTOR.email}` })
    );

    expect(res.body).toMatchObject({ orgSlug: ORG.slug, email: "owner@acme.com", name: SUPER.name, url: "https://acme.example.test" });
    // 12 CSPRNG characters plus the policy-satisfying tail — the shape generateTempPassword promises.
    expect(res.body.temporaryPassword).toMatch(/^[A-Za-z0-9]{12}!7aQ$/);
  });

  it("re-activates a deactivated owner rather than handing back a password that cannot sign in", async () => {
    tenant.user.findFirst.mockResolvedValue({ ...SUPER, status: "INACTIVE" });
    await call();
    const update = tenant.user.update.mock.calls[0][0] as { data: { status: string } };
    expect(update.data.status).toBe("ACTIVE");
  });
});
