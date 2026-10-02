/**
 * Self-serve signup, driven through the REAL signup router, the REAL policy service and the REAL
 * company-domain claims, with only the edges faked (docs/SIGNUP_AND_DOMAINS_PLAN.md).
 *
 * What is pinned, and why each is easy to break:
 *  - Signup is CLOSED unless an operator opened it AND the deployment routes workspaces by
 *    subdomain, and the policy FAILS CLOSED. The switch is re-checked on every step.
 *  - Personal, temporary and operator-blocked domains are refused, and re-checked against the PROVEN
 *    address — never one a later request supplies.
 *  - The code is checked ONCE (/verify), before anything about any workspace is revealed, and
 *    answers with a decision: you are already a member / ask to join your company's workspace /
 *    it is unavailable / create one.
 *  - A taken workspace address does NOT burn the person's verification (it used to).
 *  - Two people from one new company finishing at the same moment get ONE workspace: the unique
 *    domain claim decides, and the loser is told so.
 *  - Operators hear about every created and failed signup in the mode they chose; the failure detail
 *    goes to them, never to the stranger on the public page.
 */
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const envMock: Record<string, unknown> = {
  // The platform's zone, as config/env.ts defaults it.
  TZ: "Asia/Kolkata",
  ROOT_DOMAIN: "timesphere.test",
  APP_BASE_URL: "https://timesphere.test",
  JWT_ACCESS_SECRET: "test-secret-test-secret-test-secret"
};
vi.mock("../../src/config/env.js", () => ({ env: new Proxy({}, { get: (_t, k) => envMock[k as string] }) }));

/* ------------------------------- the control plane, faked ------------------------------- */

let settingsRow: {
  enabled: boolean;
  blockedDomains: unknown;
  notifyMode: string;
  joinRequestTtlDays: number;
  updatedBy: string | null;
  updatedAt: Date;
} | null = null;

type Org = { id: string; name: string; slug: string; status: string; [k: string]: unknown };
const orgs = new Map<string, Org>();
const claims = new Map<string, { domain: string; organizationId: string; source: string }>();
let orgSeq = 0;

const control = {
  platformSignupSettings: {
    findUnique: vi.fn(async () => settingsRow),
    upsert: vi.fn(async ({ create, update }: { create: Record<string, unknown>; update: Record<string, unknown> }) => {
      settingsRow = { ...(settingsRow ?? create), ...update, updatedAt: new Date() } as never;
      return settingsRow;
    })
  },
  organization: {
    findUnique: vi.fn(async ({ where }: { where: { slug?: string; id?: string } }) => {
      for (const org of orgs.values()) if ((where.slug && org.slug === where.slug) || (where.id && org.id === where.id)) return org;
      return null;
    }),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
      for (const org of orgs.values()) {
        if (org.slug === data.slug) throw Object.assign(new Error("Unique constraint failed on slug"), { code: "P2002" });
      }
      orgSeq += 1;
      const org = { id: orgSeq === 1 ? "org-new" : `org-${orgSeq}`, ...data } as Org;
      orgs.set(org.id, org);
      return org;
    }),
    delete: vi.fn(async ({ where }: { where: { id: string } }) => {
      orgs.delete(where.id);
      // ON DELETE CASCADE, as the schema declares it.
      for (const [domain, claim] of claims) if (claim.organizationId === where.id) claims.delete(domain);
      return {};
    })
  },
  orgEmailDomain: {
    findUnique: vi.fn(async ({ where, include }: { where: { domain: string }; include?: unknown }) => {
      const claim = claims.get(where.domain);
      if (!claim) return null;
      return include ? { ...claim, organization: orgs.get(claim.organizationId) ?? null } : claim;
    }),
    create: vi.fn(async ({ data }: { data: { domain: string; organizationId: string; source: string } }) => {
      if (claims.has(data.domain)) throw Object.assign(new Error("Unique constraint failed on domain"), { code: "P2002" });
      claims.set(data.domain, data);
      return data;
    }),
    // Honours the relation filter the way Prisma does: a claim is deleted only when its workspace
    // matches `organization.status`.
    deleteMany: vi.fn(async ({ where }: { where: { domain: string; organization?: { status?: string } } }) => {
      const claim = claims.get(where.domain);
      if (!claim) return { count: 0 };
      if (where.organization?.status && orgs.get(claim.organizationId)?.status !== where.organization.status) return { count: 0 };
      claims.delete(where.domain);
      return { count: 1 };
    })
  },
  // Interactive transaction, with the rollback a real one has: whatever the callback wrote is undone
  // when it throws.
  $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
    const orgSnapshot = new Map(orgs);
    const claimSnapshot = new Map(claims);
    try {
      return await fn(control);
    } catch (error) {
      orgs.clear();
      orgSnapshot.forEach((value, key) => orgs.set(key, value));
      claims.clear();
      claimSnapshot.forEach((value, key) => claims.set(key, value));
      throw error;
    }
  })
};
vi.mock("../../src/config/control-prisma.js", () => ({ controlPrisma: control }));

/* --------------------------------- the other edges --------------------------------- */

const directory = {
  issueVerificationCode: vi.fn(async () => ({ token: "tok", code: "123456" })),
  checkVerificationCode: vi.fn(async (): Promise<{ ok: true; email: string } | { ok: false; reason: string }> => ({ ok: true, email: "priya@northwind.co.uk" })),
  findWorkspacesForEmail: vi.fn(async (): Promise<Array<{ slug: string; name: string; url: string }>> => []),
  issueSignupContinuation: vi.fn(async () => "cont.secret"),
  peekSignupContinuation: vi.fn(async (): Promise<{ ok: true; email: string } | { ok: false }> => ({ ok: true, email: "priya@northwind.co.uk" })),
  redeemSignupContinuation: vi.fn(async () => true),
  rememberWorkspaceMembership: vi.fn(async () => undefined),
  workspaceUrlForSlug: (slug: string) => `https://${slug}.timesphere.test`,
  // The welcome mail's fallback body builds its link through this.
  tenantBaseUrl: () => "https://northwind.timesphere.test"
};
vi.mock("../../src/services/workspace-directory.service.js", () => directory);

const recordSignupStage = vi.fn(async () => undefined);
vi.mock("../../src/services/signup-funnel.service.js", () => ({ recordSignupStage }));

const provisionOrganization = vi.fn(async () => ({ organizationId: "org-new" }));
vi.mock("../../src/services/provisioning.service.js", () => ({ provisionOrganization }));

const sendPlatformTemplate = vi.fn(async () => ({ ok: true, status: "SENT", subject: "s" }));
vi.mock("../../src/services/platform-mail.service.js", () => ({ sendPlatformTemplate }));

const platformAudit = vi.fn(async () => undefined);
vi.mock("../../src/services/platform-audit.service.js", () => ({ platformAudit }));

vi.mock("../../src/services/platform-alerts.service.js", () => ({
  getAlertSettings: vi.fn(async () => ({ recipients: [] })),
  resolveAlertRecipients: vi.fn(async () => ["ops@timesphere.test", "owner@timesphere.test"])
}));
vi.mock("../../src/config/with-org-tenant.js", () => ({ withOrgTenant: vi.fn(async (_s: string, fn: () => Promise<unknown>) => fn()) }));
vi.mock("../../src/services/notify.service.js", () => ({ dispatchTransactional: vi.fn(async () => ({})) }));
const alertIfProvisioningFailing = vi.fn(async () => false);
vi.mock("../../src/services/signup-digest.service.js", () => ({ alertIfProvisioningFailing }));
const createJoinRequest = vi.fn(async (): Promise<{ status: string; id?: string }> => ({ status: "requested", id: "jr-1" }));
// The per-workspace daily cap counts the join requests that exist in the workspace's own database.
let joinRequestsToday = 0;
const countJoinRequestsSince = vi.fn(async () => joinRequestsToday);
vi.mock("../../src/services/join-request.service.js", () => ({ createJoinRequest, countJoinRequestsSince }));
const withOrgTenantMock = (await import("../../src/config/with-org-tenant.js")).withOrgTenant as unknown as ReturnType<typeof vi.fn>;

const { signupRouter, signupStatusHandler } = await import("../../src/controllers/signup.controller.js");
const { errorHandler } = await import("../../src/middleware/error.js");
const { availabilityFrom, getSignupAvailability, getSignupSettings, normaliseDomainList, signupRefusalFor, updateSignupSettings } = await import(
  "../../src/services/platform-signup.service.js"
);

function buildApp() {
  const app = express();
  app.use(express.json());
  app.get("/api/signup/status", signupStatusHandler);
  app.use("/api/signup", signupRouter);
  app.use(errorHandler);
  return app;
}

const openSignup = (extra: Partial<NonNullable<typeof settingsRow>> = {}) => {
  settingsRow = {
    enabled: true,
    blockedDomains: null,
    notifyMode: "DAILY",
    joinRequestTtlDays: 14,
    updatedBy: "ops@timesphere.test",
    updatedAt: new Date(),
    ...extra
  };
};
const addWorkspace = (org: Org, domain?: string) => {
  orgs.set(org.id, org);
  if (domain) claims.set(domain, { domain, organizationId: org.id, source: "SIGNUP" });
};
const completeBody = { continuation: "cont.secret", workspaceName: "Northwind Logistics", slug: "northwind", adminName: "Priya", adminPassword: "a-long-password" };
const verify = () => request(buildApp()).post("/api/signup/verify").send({ token: "tok", code: "123456" });
const stages = () => recordSignupStage.mock.calls.map(([stage]) => stage);

beforeEach(() => {
  vi.clearAllMocks();
  settingsRow = null;
  orgs.clear();
  claims.clear();
  orgSeq = 0;
  joinRequestsToday = 0;
  createJoinRequest.mockResolvedValue({ status: "requested", id: "jr-1" });
  envMock.ROOT_DOMAIN = "timesphere.test";
  directory.checkVerificationCode.mockResolvedValue({ ok: true, email: "priya@northwind.co.uk" });
  directory.findWorkspacesForEmail.mockResolvedValue([]);
  directory.peekSignupContinuation.mockResolvedValue({ ok: true, email: "priya@northwind.co.uk" });
  directory.redeemSignupContinuation.mockResolvedValue(true);
  provisionOrganization.mockResolvedValue({ organizationId: "org-new" });
  sendPlatformTemplate.mockImplementation(async () => ({ ok: true, status: "SENT", subject: "s" }));
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("whether signup is open", () => {
  it("is CLOSED on a fresh deployment — nobody has switched it on", async () => {
    const res = await request(buildApp()).get("/api/signup/status");
    expect(res.body).toEqual({ open: false, trialDays: 15, trialTier: "TEAM", rootDomain: "timesphere.test" });
  });

  it("opens only when an operator switched it on and workspaces have their own addresses", async () => {
    openSignup();
    expect((await request(buildApp()).get("/api/signup/status")).body.open).toBe(true);
  });

  it("stays closed on a single-org install even when switched on — a new workspace would have no address", async () => {
    openSignup();
    envMock.ROOT_DOMAIN = undefined;
    const res = await request(buildApp()).get("/api/signup/status");
    expect(res.body).toMatchObject({ open: false, rootDomain: null });
    expect(availabilityFrom({ enabled: true }, undefined)).toEqual({ open: false, reason: "single-org" });
  });

  it("FAILS CLOSED when the policy cannot be read", async () => {
    control.platformSignupSettings.findUnique.mockRejectedValueOnce(new Error("control plane down"));
    expect(await getSignupAvailability()).toEqual({ open: false, reason: "unavailable" });
  });

  it("refuses step one while closed, before any code is minted or mailed", async () => {
    const res = await request(buildApp()).post("/api/signup/start").send({ email: "priya@northwind.co.uk" });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe("SIGNUP_CLOSED");
    expect(directory.issueVerificationCode).not.toHaveBeenCalled();
    expect(sendPlatformTemplate).not.toHaveBeenCalled();
  });

  it("refuses to verify while closed — the code is not even checked", async () => {
    const res = await verify();
    expect(res.status).toBe(403);
    expect(directory.checkVerificationCode).not.toHaveBeenCalled();
  });

  it("refuses to create if signup was closed after the code went out — no database from that moment", async () => {
    const res = await request(buildApp()).post("/api/signup/complete").send(completeBody);
    expect(res.status).toBe(403);
    expect(directory.peekSignupContinuation).not.toHaveBeenCalled();
    expect(control.organization.create).not.toHaveBeenCalled();
    expect(provisionOrganization).not.toHaveBeenCalled();
  });
});

describe("which addresses may start a workspace", () => {
  it.each(["someone@rediffmail.com", "someone@yahoo.co.in", "someone@gmail.com", "Someone@YMAIL.com"])(
    "refuses the personal address %s",
    async (email) => {
      openSignup();
      const res = await request(buildApp()).post("/api/signup/start").send({ email });
      expect(res.status).toBe(422);
      expect(res.body.message).toMatch(/work email/);
      expect(directory.issueVerificationCode).not.toHaveBeenCalled();
      expect(stages()).toEqual(["REFUSED"]);
    }
  );

  it("refuses a throwaway inbox with its own message — there is no work version of one", async () => {
    openSignup();
    const res = await request(buildApp()).post("/api/signup/start").send({ email: "x@mailinator.com" });
    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/temporary inbox/);
  });

  it("refuses an operator-blocked domain with the personal-address message, so the list stays private", async () => {
    openSignup({ blockedDomains: ["examplemail.in"] });
    const res = await request(buildApp()).post("/api/signup/start").send({ email: "a@examplemail.in" });
    expect(res.status).toBe(422);
    expect(res.body.message).toBe(signupRefusalFor("a@gmail.com", []));
  });

  it("refuses an address that has no company domain at all, before sending a code", async () => {
    openSignup();
    const res = await request(buildApp()).post("/api/signup/start").send({ email: "admin@co.uk" });
    expect(res.status).toBe(422);
    expect(directory.issueVerificationCode).not.toHaveBeenCalled();
  });

  it("sends a SIGNUP-purpose code to a company address, and counts it", async () => {
    openSignup();
    const res = await request(buildApp()).post("/api/signup/start").send({ email: "Priya@Northwind.co.uk" });
    expect(res.status).toBe(202);
    expect(directory.issueVerificationCode).toHaveBeenCalledWith("priya@northwind.co.uk", "signup");
    expect(sendPlatformTemplate).toHaveBeenCalledWith("signup.verify", expect.objectContaining({ to: "priya@northwind.co.uk" }));
    expect(stages()).toEqual(["CODE_SENT"]);
  });

  it("re-checks the PROVEN address at creation — a domain blocked since the code went out is refused", async () => {
    openSignup({ blockedDomains: ["northwind.co.uk"] });
    const res = await request(buildApp()).post("/api/signup/complete").send(completeBody);
    expect(res.status).toBe(422);
    expect(directory.redeemSignupContinuation).not.toHaveBeenCalled();
    expect(provisionOrganization).not.toHaveBeenCalled();
  });
});

describe("verify — the code is checked once, and the answer is a decision", () => {
  beforeEach(() => openSignup());

  it("→ create, with a continuation, when the company has no workspace", async () => {
    const res = await verify();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ next: "create", continuation: "cont.secret" });
    expect(directory.checkVerificationCode).toHaveBeenCalledWith("tok", "123456", "signup");
    expect(directory.issueSignupContinuation).toHaveBeenCalledWith("priya@northwind.co.uk");
    expect(stages()).toEqual(["VERIFIED"]);
  });

  it("→ join, naming ONLY the workspace, when an ACTIVE workspace holds the company domain", async () => {
    addWorkspace({ id: "nw", name: "Northwind", slug: "northwind-hq", status: "ACTIVE" }, "northwind.co.uk");
    directory.checkVerificationCode.mockResolvedValue({ ok: true, email: "sam@eng.northwind.co.uk" });
    const res = await verify();
    expect(res.body).toEqual({ next: "join", workspace: { name: "Northwind" }, continuation: "cont.secret" });
    // Nothing that would help a stranger: no address, no admins, no size.
    expect(JSON.stringify(res.body)).not.toMatch(/northwind-hq|timesphere\.test/);
  });

  it.each(["GRACE", "SUSPENDED", "PROVISIONING"])("→ unavailable for a %s workspace — no continuation, so no request and no new workspace", async (status) => {
    addWorkspace({ id: "nw", name: "Northwind", slug: "northwind-hq", status }, "northwind.co.uk");
    const res = await verify();
    expect(res.body).toEqual({ next: "unavailable", workspace: { name: "Northwind" } });
    expect(directory.issueSignupContinuation).not.toHaveBeenCalled();
    expect(stages()).toEqual(["VERIFIED", "UNAVAILABLE"]);
  });

  it("→ member when the address already belongs to a workspace — no new database", async () => {
    directory.findWorkspacesForEmail.mockResolvedValue([{ slug: "northwind", name: "Northwind", url: "https://northwind.timesphere.test" }]);
    const res = await verify();
    expect(res.body).toEqual({ next: "member", workspaces: [{ slug: "northwind", name: "Northwind", url: "https://northwind.timesphere.test" }] });
    expect(directory.issueSignupContinuation).not.toHaveBeenCalled();
    // Recorded apart, so the console's funnel does not count a member signing in as a prospect.
    expect(stages()).toEqual(["VERIFIED", "EXISTING_MEMBER"]);
  });

  it("answers a wrong or expired code with 400 and too many guesses with 429", async () => {
    directory.checkVerificationCode.mockResolvedValueOnce({ ok: false, reason: "wrong" });
    expect((await verify()).status).toBe(400);
    directory.checkVerificationCode.mockResolvedValueOnce({ ok: false, reason: "exhausted" });
    expect((await verify()).status).toBe(429);
  });
});

describe("complete — creating the workspace", () => {
  beforeEach(() => openSignup());

  it("creates a SELF_SERVE workspace, claims its company domain, and spends the continuation", async () => {
    const res = await request(buildApp()).post("/api/signup/complete").send(completeBody);
    expect(res.status).toBe(201);
    expect(res.body.trialDays).toBe(15);
    expect(orgs.get("org-new")).toMatchObject({ slug: "northwind", createdVia: "SELF_SERVE", ownerEmail: "priya@northwind.co.uk" });
    expect(claims.get("northwind.co.uk")).toMatchObject({ organizationId: "org-new", source: "SIGNUP" });
    expect(directory.redeemSignupContinuation).toHaveBeenCalledWith("cont.secret");
    expect(stages()).toContain("CREATED");
  });

  it.each([
    ["one of the most common passwords", "password1", /common/i],
    ["a password built from the email address", "priya2026!", /email/i]
  ])("refuses %s before anything is created, and keeps the verification", async (_label, adminPassword, reason) => {
    // The founder's password is the first one a workspace has — the same policy as every other
    // password in the app (utils/password-policy.ts), checked before the continuation is spent so
    // choosing a better one costs nothing, and before provisioning, where a refusal would read as a
    // failed workspace and page an operator.
    const res = await request(buildApp()).post("/api/signup/complete").send({ ...completeBody, adminPassword });
    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(reason);
    expect(directory.redeemSignupContinuation).not.toHaveBeenCalled();
    expect(control.organization.create).not.toHaveBeenCalled();
    expect(provisionOrganization).not.toHaveBeenCalled();
  });

  it("a taken address does NOT burn the verification — fix the address and finish", async () => {
    addWorkspace({ id: "other", name: "Other", slug: "northwind", status: "ACTIVE" });
    const first = await request(buildApp()).post("/api/signup/complete").send(completeBody);
    expect(first.status).toBe(409);
    expect(first.body.code).toBe("SLUG_TAKEN");
    expect(directory.redeemSignupContinuation).not.toHaveBeenCalled();

    const second = await request(buildApp()).post("/api/signup/complete").send({ ...completeBody, slug: "northwind-logistics" });
    expect(second.status).toBe(201);
  });

  it("two people from one new company at the same moment: ONE workspace, the other told DOMAIN_CLAIMED", async () => {
    // Different addresses, different workspace names, same company domain.
    directory.peekSignupContinuation
      .mockResolvedValueOnce({ ok: true, email: "priya@northwind.co.uk" })
      .mockResolvedValueOnce({ ok: true, email: "sam@eng.northwind.co.uk" });
    const [a, b] = await Promise.all([
      request(buildApp()).post("/api/signup/complete").send({ ...completeBody, continuation: "a.a", slug: "northwind" }),
      request(buildApp()).post("/api/signup/complete").send({ ...completeBody, continuation: "b.b", slug: "nw-two" })
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 409]);
    expect([a.body.code, b.body.code]).toContain("DOMAIN_CLAIMED");
    expect(provisionOrganization).toHaveBeenCalledTimes(1);
    // The loser left nothing behind: one workspace, one claim.
    expect(orgs.size).toBe(1);
    expect([...claims.keys()]).toEqual(["northwind.co.uk"]);
  });

  it("a company whose old workspace was ARCHIVED can sign up again — the leftover claim does not lock it out", async () => {
    // Archived from the console, which does not release the claim the way retention deletion does.
    addWorkspace({ id: "gone", name: "Northwind (old)", slug: "northwind-old", status: "ARCHIVED" }, "northwind.co.uk");
    expect((await verify()).body).toEqual({ next: "create", continuation: "cont.secret" });
    const res = await request(buildApp()).post("/api/signup/complete").send(completeBody);
    expect(res.status).toBe(201);
    expect(claims.get("northwind.co.uk")).toMatchObject({ organizationId: "org-new" });
  });

  it("never takes a claim from a workspace that is merely suspended — that company still has one", async () => {
    addWorkspace({ id: "nw", name: "Northwind", slug: "northwind-hq", status: "SUSPENDED" }, "northwind.co.uk");
    const res = await request(buildApp()).post("/api/signup/complete").send(completeBody);
    expect(res.status).toBe(409);
    // The truth — that company's workspace is not taking people — not "a colleague just created one".
    expect(res.body.code).toBe("WORKSPACE_UNAVAILABLE");
    expect(claims.get("northwind.co.uk")).toMatchObject({ organizationId: "nw" });
  });

  it("a second submit of the SAME signup (a double click, a second tab) is told about its own workspace", async () => {
    const first = await request(buildApp()).post("/api/signup/complete").send(completeBody);
    expect(first.status).toBe(201);
    // Still provisioning, as a real second click would find it.
    orgs.get("org-new")!.status = "PROVISIONING";
    const sameSlug = await request(buildApp()).post("/api/signup/complete").send(completeBody);
    expect(sameSlug.status).toBe(409);
    expect(sameSlug.body.code).toBe("SIGNUP_IN_PROGRESS");
    const otherSlug = await request(buildApp()).post("/api/signup/complete").send({ ...completeBody, slug: "northwind-two" });
    expect(otherSlug.body.code).toBe("SIGNUP_IN_PROGRESS");
    // Once it is ready, the same submit is simply the success it was.
    orgs.get("org-new")!.status = "ACTIVE";
    const later = await request(buildApp()).post("/api/signup/complete").send(completeBody);
    expect(later.status).toBe(200);
    expect(later.body).toMatchObject({ slug: "northwind", url: "https://northwind.timesphere.test", alreadyCreated: true });
    expect(provisionOrganization).toHaveBeenCalledTimes(1);
    expect(orgs.size).toBe(1);
  });

  it("someone ELSE's workspace at that address is still just a taken address", async () => {
    addWorkspace({ id: "other", name: "Other", slug: "northwind", status: "ACTIVE", ownerEmail: "someone@else.example", createdVia: "SELF_SERVE" });
    const res = await request(buildApp()).post("/api/signup/complete").send(completeBody);
    expect(res.body.code).toBe("SLUG_TAKEN");
  });

  it("refuses an expired continuation, and creates nothing", async () => {
    directory.peekSignupContinuation.mockResolvedValueOnce({ ok: false });
    const res = await request(buildApp()).post("/api/signup/complete").send(completeBody);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("SIGNUP_EXPIRED");
    expect(control.organization.create).not.toHaveBeenCalled();
  });

  it("undoes the workspace if the continuation was spent in the meantime", async () => {
    directory.redeemSignupContinuation.mockResolvedValueOnce(false);
    const res = await request(buildApp()).post("/api/signup/complete").send(completeBody);
    expect(res.status).toBe(400);
    expect(orgs.size).toBe(0);
    expect(claims.size).toBe(0);
    expect(provisionOrganization).not.toHaveBeenCalled();
  });
});

describe("join — asking the company's workspace", () => {
  const joinBody = { continuation: "cont.secret", name: "Sam Patel", message: "Priya said to ask here." };
  const join = (body: Record<string, unknown> = joinBody) => request(buildApp()).post("/api/signup/join").send(body);
  beforeEach(() => {
    openSignup({ joinRequestTtlDays: 21 });
    directory.peekSignupContinuation.mockResolvedValue({ ok: true, email: "sam@eng.northwind.co.uk" });
    addWorkspace({ id: "nw", name: "Northwind", slug: "northwind-hq", status: "ACTIVE" }, "northwind.co.uk");
  });

  it("creates the request in the claimed workspace's database, with the configured expiry", async () => {
    const res = await join();
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ status: "requested", workspace: { name: "Northwind" } });
    expect(withOrgTenantMock).toHaveBeenCalledWith("northwind-hq", expect.any(Function));
    expect(createJoinRequest).toHaveBeenCalledWith({
      email: "sam@eng.northwind.co.uk",
      name: "Sam Patel",
      message: "Priya said to ask here.",
      ttlDays: 21,
      workspaceName: "Northwind"
    });
    expect(directory.redeemSignupContinuation).toHaveBeenCalledWith("cont.secret");
  });

  it("refuses with WORKSPACE_UNAVAILABLE when the workspace stopped being ACTIVE since verify — and keeps the continuation", async () => {
    orgs.get("nw")!.status = "GRACE";
    const res = await join();
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("WORKSPACE_UNAVAILABLE");
    expect(createJoinRequest).not.toHaveBeenCalled();
    expect(directory.redeemSignupContinuation).not.toHaveBeenCalled();
  });

  it("records JOIN_REQUESTED with the organization, for the funnel and the per-day cap", async () => {
    await join();
    expect(recordSignupStage).toHaveBeenCalledWith("JOIN_REQUESTED", { email: "sam@eng.northwind.co.uk", organizationId: "nw" });
  });

  it("does not count a repeat ask, and tells the person it is still waiting", async () => {
    createJoinRequest.mockResolvedValueOnce({ status: "already_pending", id: "jr-1" });
    const res = await join();
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("already_pending");
    expect(stages()).not.toContain("JOIN_REQUESTED");
  });

  it("a workspace past its daily cap of requests gets 429, before the continuation is spent", async () => {
    joinRequestsToday = 25;
    const res = await join();
    expect(res.status).toBe(429);
    // Counted in the claimed workspace's own database, over the last 24 hours.
    expect(withOrgTenantMock).toHaveBeenCalledWith("northwind-hq", expect.any(Function));
    const since = countJoinRequestsSince.mock.calls[0][0] as Date;
    expect(Date.now() - since.getTime()).toBeGreaterThanOrEqual(24 * 60 * 60 * 1000 - 5000);
    expect(createJoinRequest).not.toHaveBeenCalled();
    expect(directory.redeemSignupContinuation).not.toHaveBeenCalled();
  });

  it("refuses an expired continuation, and when the company's workspace has gone since verify", async () => {
    directory.peekSignupContinuation.mockResolvedValueOnce({ ok: false });
    expect((await join()).body.code).toBe("SIGNUP_EXPIRED");
    claims.clear();
    const gone = await join();
    expect(gone.status).toBe(409);
    expect(gone.body.code).toBe("NO_WORKSPACE");
    expect(createJoinRequest).not.toHaveBeenCalled();
  });

  it("refuses while signup is closed", async () => {
    settingsRow!.enabled = false;
    expect((await join()).status).toBe(403);
    expect(directory.peekSignupContinuation).not.toHaveBeenCalled();
  });
});

describe("what the operators hear", () => {
  it("sends NO per-signup email in the default DAILY mode — the daily summary carries it", async () => {
    openSignup();
    const res = await request(buildApp()).post("/api/signup/complete").send(completeBody);
    expect(res.status).toBe(201);
    expect(sendPlatformTemplate.mock.calls.some(([key]) => key === "platform.signup_created")).toBe(false);
    // ...but the record is still written, so the summary and the console have it.
    expect(platformAudit).toHaveBeenCalledWith("CUSTOMER", expect.anything(), "org.signup_completed", "Organization", "org-new", expect.anything());
  });

  it("in EACH mode, records and announces every new workspace", async () => {
    openSignup({ notifyMode: "EACH" });
    const res = await request(buildApp()).post("/api/signup/complete").send(completeBody);
    expect(res.status).toBe(201);
    expect(platformAudit).toHaveBeenCalledWith(
      "CUSTOMER",
      "priya@northwind.co.uk",
      "org.signup_completed",
      "Organization",
      "org-new",
      expect.objectContaining({ slug: "northwind", domain: "northwind.co.uk", trialTier: "TEAM" })
    );
    const created = sendPlatformTemplate.mock.calls.filter(([key]) => key === "platform.signup_created");
    expect(created.map(([, args]) => (args as { to: string }).to)).toEqual(["ops@timesphere.test", "owner@timesphere.test"]);
    expect(created[0][1]).toMatchObject({ vars: { workspaceName: "Northwind Logistics", domain: "northwind.co.uk" } });
  });

  it("dates the trial's end as India sees it, not UTC", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    // 00:30 IST on the 2nd; fifteen days on is 00:30 IST on the 17th — still the 16th in UTC.
    vi.setSystemTime(new Date("2026-10-01T19:00:00Z"));
    try {
      openSignup({ notifyMode: "EACH" });
      await request(buildApp()).post("/api/signup/complete").send(completeBody);
      const created = sendPlatformTemplate.mock.calls.find(([key]) => key === "platform.signup_created");
      expect(created?.[1]).toMatchObject({ vars: { trialEndsAt: "2026-10-17" } });
    } finally {
      vi.useRealTimers();
    }
  });

  it("stays quiet when an operator switched notifications OFF — but still records the signup", async () => {
    openSignup({ notifyMode: "OFF" });
    await request(buildApp()).post("/api/signup/complete").send(completeBody);
    expect(sendPlatformTemplate.mock.calls.some(([key]) => key === "platform.signup_created")).toBe(false);
    expect(platformAudit).toHaveBeenCalledWith("CUSTOMER", expect.anything(), "org.signup_completed", "Organization", "org-new", expect.anything());
  });

  it("on a failed provision: apologises to the person, gives the DETAIL only to the operators, and frees the domain", async () => {
    openSignup({ notifyMode: "EACH" });
    provisionOrganization.mockRejectedValueOnce(new Error("Access denied for user 'provisioner'@'10.0.0.5' to database 'ts_northwind'"));
    const res = await request(buildApp()).post("/api/signup/complete").send(completeBody);
    expect(res.status).toBe(502);
    // Infrastructure talking to a stranger: hosts, grants and database names stay off the public page.
    expect(res.body.message).not.toMatch(/provisioner|10\.0\.0\.5|ts_northwind/);
    expect(control.organization.delete).toHaveBeenCalledWith({ where: { id: "org-new" } });
    // The claim went with the workspace row, so the company can try again.
    expect(claims.has("northwind.co.uk")).toBe(false);
    expect(platformAudit).toHaveBeenCalledWith(
      "CUSTOMER",
      "priya@northwind.co.uk",
      "org.signup_failed",
      "Organization",
      null,
      expect.objectContaining({ error: expect.stringContaining("Access denied") })
    );
    const failed = sendPlatformTemplate.mock.calls.filter(([key]) => key === "platform.signup_failed");
    expect(failed).toHaveLength(2);
    expect(failed[0][1]).toMatchObject({ vars: { error: expect.stringContaining("ts_northwind") } });
    expect(stages()).toContain("FAILED");
    // …and asks whether this is the second failure inside the hour — an outage, not tomorrow's news.
    expect(alertIfProvisioningFailing).toHaveBeenCalledTimes(1);
  });

  it("on a failed provision: says what actually happens next, not 'try again in a few minutes'", async () => {
    // The continuation was spent before provisioning began, so the same request retried is a
    // SIGNUP_EXPIRED. What does work is starting over — the workspace row and its claim are gone.
    openSignup({ notifyMode: "EACH" });
    provisionOrganization.mockRejectedValueOnce(new Error("migrate deploy failed"));
    const res = await request(buildApp()).post("/api/signup/complete").send(completeBody);
    expect(res.status).toBe(502);
    expect(res.body.code).toBe("PROVISIONING_FAILED");
    expect(res.body.message).not.toMatch(/try again in a few minutes/i);
    expect(res.body.message).toMatch(/start again/i);
  });

  it("never lets a broken mail relay turn a successful signup into an error", async () => {
    openSignup({ notifyMode: "EACH" });
    sendPlatformTemplate.mockImplementation(async (key: string) => {
      if (key === "platform.signup_created") throw new Error("relay down");
      return { ok: true, status: "SENT", subject: "s" };
    });
    const res = await request(buildApp()).post("/api/signup/complete").send(completeBody);
    expect(res.status).toBe(201);
  });
});

describe("the settings a business decides", () => {
  it("defaults to a daily summary and 14-day join requests when nobody has saved anything", async () => {
    const settings = await getSignupSettings();
    expect(settings.notifyMode).toBe("DAILY");
    expect(settings.joinRequestTtlDays).toBe(14);
  });

  it("reads an unknown stored mode as DAILY rather than as silence", async () => {
    openSignup({ notifyMode: "WEEKLY" });
    expect((await getSignupSettings()).notifyMode).toBe("DAILY");
  });

  it("clamps the join-request expiry to 1–90 days", async () => {
    expect((await updateSignupSettings({ joinRequestTtlDays: 400 }, "ops@timesphere.test")).joinRequestTtlDays).toBe(90);
    expect((await updateSignupSettings({ joinRequestTtlDays: 0 }, "ops@timesphere.test")).joinRequestTtlDays).toBe(1);
  });

  it("records a change of mode in the audit trail", async () => {
    await updateSignupSettings({ notifyMode: "EACH" }, "ops@timesphere.test");
    expect(platformAudit).toHaveBeenCalledWith(
      "PLATFORM_ADMIN",
      "ops@timesphere.test",
      "signup.settings_updated",
      "PlatformSignupSettings",
      "global",
      expect.objectContaining({ notifyMode: "EACH" })
    );
  });
});

describe("normaliseDomainList — what an operator pastes", () => {
  it("accepts the shapes people actually paste, and keeps one clean copy of each", () => {
    expect(normaliseDomainList("@Rediffmail.com, someone@examplemail.in\nexamplemail.in ; mail.example.org.")).toEqual([
      "examplemail.in",
      "mail.example.org",
      "rediffmail.com"
    ]);
  });

  it("drops what can never match rather than storing it", () => {
    expect(normaliseDomainList(["not a domain", "localhost", "-bad.com", 42, "ok.io"])).toEqual(["ok.io"]);
  });

  it("caps the list so the column cannot become storage", () => {
    const many = Array.from({ length: 800 }, (_, i) => `d${i}.example.com`);
    expect(normaliseDomainList(many)).toHaveLength(500);
  });
});
