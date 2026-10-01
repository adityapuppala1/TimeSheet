/**
 * Self-serve signup's policy (Phase 0 of the signup-domains work, 2026-10-01), driven through the
 * REAL signup router and the REAL policy service with only the edges faked.
 *
 * What is pinned, and why each is easy to break:
 *  - Signup is CLOSED unless an operator opened it AND the deployment routes workspaces by
 *    subdomain. Before this, the route provisioned a database for anyone, on every deployment, and on
 *    a single-org install it built a workspace nobody could reach.
 *  - The policy FAILS CLOSED. A control-plane hiccup must not read as "signup is open".
 *  - The switch is re-checked on the second step: "off" means no new database from that moment.
 *  - Personal, temporary and operator-blocked domains are refused — rediffmail.com and yahoo.co.in
 *    included, which the first list missed — and re-checked against the PROVEN address.
 *  - Operators are told about every created AND every failed signup; the failure detail goes to
 *    them, never to the stranger on the public page.
 */
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const envMock: Record<string, unknown> = {
  ROOT_DOMAIN: "timesphere.test",
  APP_BASE_URL: "https://timesphere.test",
  JWT_ACCESS_SECRET: "test-secret-test-secret-test-secret"
};
vi.mock("../../src/config/env.js", () => ({ env: new Proxy({}, { get: (_t, k) => envMock[k as string] }) }));

let settingsRow: { enabled: boolean; blockedDomains: unknown; notifyOnSignup: boolean; updatedBy: string | null; updatedAt: Date } | null = null;
const control = {
  platformSignupSettings: {
    findUnique: vi.fn(async () => settingsRow),
    upsert: vi.fn(async ({ create, update }: { create: Record<string, unknown>; update: Record<string, unknown> }) => {
      settingsRow = { ...(settingsRow ?? create), ...update, updatedAt: new Date() } as never;
      return settingsRow;
    })
  },
  organization: {
    findUnique: vi.fn(async () => null),
    create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({ id: "org-new", ...data })),
    delete: vi.fn(async () => ({}))
  }
};
vi.mock("../../src/config/control-prisma.js", () => ({ controlPrisma: control }));

const directory = {
  issueVerificationCode: vi.fn(async () => ({ token: "tok", code: "123456" })),
  checkVerificationCode: vi.fn(async () => ({ ok: true, email: "priya@northwind.co.uk" })),
  rememberWorkspaceMembership: vi.fn(async () => undefined),
  workspaceUrlForSlug: (slug: string) => `https://${slug}.timesphere.test`,
  // The welcome mail's fallback body builds its link through this.
  tenantBaseUrl: () => "https://northwind.timesphere.test"
};
vi.mock("../../src/services/workspace-directory.service.js", () => directory);

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

const { signupRouter, signupStatusHandler } = await import("../../src/controllers/signup.controller.js");
const { errorHandler } = await import("../../src/middleware/error.js");
const { availabilityFrom, getSignupAvailability, normaliseDomainList, signupRefusalFor } = await import(
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
  settingsRow = { enabled: true, blockedDomains: null, notifyOnSignup: true, updatedBy: "ops@timesphere.test", updatedAt: new Date(), ...extra };
};
const completeBody = { token: "tok", code: "123456", workspaceName: "Northwind Logistics", slug: "northwind", adminName: "Priya", adminPassword: "a-long-password" };

beforeEach(() => {
  vi.clearAllMocks();
  settingsRow = null;
  envMock.ROOT_DOMAIN = "timesphere.test";
  directory.checkVerificationCode.mockResolvedValue({ ok: true, email: "priya@northwind.co.uk" });
  provisionOrganization.mockResolvedValue({ organizationId: "org-new" });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("whether signup is open", () => {
  it("is CLOSED on a fresh deployment — nobody has switched it on", async () => {
    const res = await request(buildApp()).get("/api/signup/status");
    expect(res.body).toEqual({ open: false, trialDays: 15, trialTier: "TEAM" });
  });

  it("opens only when an operator switched it on and workspaces have their own addresses", async () => {
    openSignup();
    expect((await request(buildApp()).get("/api/signup/status")).body.open).toBe(true);
  });

  it("stays closed on a single-org install even when switched on — a new workspace would have no address", async () => {
    openSignup();
    envMock.ROOT_DOMAIN = undefined;
    expect((await request(buildApp()).get("/api/signup/status")).body.open).toBe(false);
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

  it("refuses step two if signup was closed after the code went out — no database from that moment", async () => {
    const res = await request(buildApp()).post("/api/signup/complete").send(completeBody);
    expect(res.status).toBe(403);
    expect(directory.checkVerificationCode).not.toHaveBeenCalled();
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

  it("sends a SIGNUP-purpose code to a company address", async () => {
    openSignup();
    const res = await request(buildApp()).post("/api/signup/start").send({ email: "Priya@Northwind.co.uk" });
    expect(res.status).toBe(202);
    expect(directory.issueVerificationCode).toHaveBeenCalledWith("priya@northwind.co.uk", "signup");
    expect(sendPlatformTemplate).toHaveBeenCalledWith("signup.verify", expect.objectContaining({ to: "priya@northwind.co.uk" }));
  });

  it("re-checks the PROVEN address on step two — a domain blocked since the code went out is refused", async () => {
    openSignup({ blockedDomains: ["northwind.co.uk"] });
    const res = await request(buildApp()).post("/api/signup/complete").send(completeBody);
    expect(res.status).toBe(422);
    expect(directory.checkVerificationCode).toHaveBeenCalledWith("tok", "123456", "signup");
    expect(provisionOrganization).not.toHaveBeenCalled();
  });
});

describe("what the operators hear", () => {
  it("records and announces a new workspace", async () => {
    openSignup();
    const res = await request(buildApp()).post("/api/signup/complete").send(completeBody);
    expect(res.status).toBe(201);
    expect(res.body.trialDays).toBe(15);
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

  it("stays quiet when an operator switched notifications off — but still records the signup", async () => {
    openSignup({ notifyOnSignup: false });
    await request(buildApp()).post("/api/signup/complete").send(completeBody);
    expect(sendPlatformTemplate.mock.calls.some(([key]) => key === "platform.signup_created")).toBe(false);
    expect(platformAudit).toHaveBeenCalledWith("CUSTOMER", expect.anything(), "org.signup_completed", "Organization", "org-new", expect.anything());
  });

  it("on a failed provision: apologises to the person, and gives the DETAIL only to the operators", async () => {
    openSignup();
    provisionOrganization.mockRejectedValueOnce(new Error("Access denied for user 'provisioner'@'10.0.0.5' to database 'ts_northwind'"));
    const res = await request(buildApp()).post("/api/signup/complete").send(completeBody);
    expect(res.status).toBe(502);
    // Infrastructure talking to a stranger: hosts, grants and database names stay off the public page.
    expect(res.body.message).not.toMatch(/provisioner|10\.0\.0\.5|ts_northwind/);
    expect(control.organization.delete).toHaveBeenCalledWith({ where: { id: "org-new" } });
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
  });

  it("never lets a broken mail relay turn a successful signup into an error", async () => {
    openSignup();
    sendPlatformTemplate.mockImplementation(async (key: string) => {
      if (key === "platform.signup_created") throw new Error("relay down");
      return { ok: true, status: "SENT", subject: "s" };
    });
    const res = await request(buildApp()).post("/api/signup/complete").send(completeBody);
    expect(res.status).toBe(201);
    sendPlatformTemplate.mockImplementation(async () => ({ ok: true, status: "SENT", subject: "s" }));
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
