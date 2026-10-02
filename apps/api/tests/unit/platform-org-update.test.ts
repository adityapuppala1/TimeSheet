/**
 * PATCH /platform-admin/organizations/:id — what an operator's edit does to a workspace's billing
 * lifecycle, beyond the columns it names.
 *
 *  - An operator who moves the STATUS of a workspace lapsed for non-payment has taken the decision
 *    over: the webhook's "suspended for not paying sub_X" marker goes, so a later payment cannot undo
 *    an operator's suspension. Re-saving the dialog with the status unchanged is not that decision.
 *  - SETTING A PLAN ON A TRIALLING WORKSPACE CONVERTS IT. The PATCH used to write `planTier` and
 *    nothing else, so the trial clock kept running: the customer who had just signed a contract got
 *    "your trial ends in 3 days", then GRACE (a 402 for everyone) the day after `trialEndsAt`, then
 *    SUSPENDED fourteen days later. Now the trial fields are cleared, a trial that had already lapsed
 *    is back to ACTIVE, and the audit trail says it was a conversion.
 *  - An operator can instead EXTEND a trial to a date — the other thing a sales conversation needs.
 */
import express from "express";
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";

const ACTOR = { id: "pa-1", name: "Ops", email: "ops@timesphere.app", role: "OWNER" as const };
const REASON = "Ticket 5120 - customer signed the annual contract";

const control = {
  organization: { findUnique: vi.fn(), update: vi.fn() },
  platformAuditLog: { create: vi.fn() }
};
vi.mock("../../src/config/control-prisma.js", () => ({ controlPrisma: control }));
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
const forgetOrgStatus = vi.fn();
vi.mock("../../src/services/org-status.service.js", () => ({ forgetOrgStatus, getOrgStatus: vi.fn() }));
// Not under test, and they pull in mail + tenant databases at import time.
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

const DAY = 24 * 60 * 60 * 1000;

function org(overrides: Record<string, unknown> = {}) {
  return {
    id: "org-1",
    slug: "acme",
    name: "Acme",
    status: "ACTIVE",
    planTier: "STARTER",
    trialTier: null,
    trialEndsAt: null,
    stripeSubscriptionId: null,
    nonPaymentSubscriptionId: null,
    graceStartedAt: null,
    suspendedReason: null,
    seatLimitOverride: null,
    aiMonthlyBudgetCeilingOverride: null,
    ...overrides
  };
}

const patch = (body: Record<string, unknown>) => request(buildApp()).patch("/api/platform-admin/organizations/org-1").set("X-Platform-Reason", REASON).send(body);
/** The data the route wrote to the organization row. */
const written = () => control.organization.update.mock.calls[0][0].data as Record<string, unknown>;
const auditActions = () => control.platformAuditLog.create.mock.calls.map((call) => call[0].data.action as string);

beforeEach(() => {
  vi.clearAllMocks();
  control.organization.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({ ...org(), ...data }));
  control.platformAuditLog.create.mockResolvedValue({});
});

describe("an operator's status change and the non-payment marker", () => {
  it("clears the marker when an operator suspends a workspace lapsed for non-payment", async () => {
    control.organization.findUnique.mockResolvedValue(
      org({ status: "GRACE", stripeSubscriptionId: "sub_123", nonPaymentSubscriptionId: "sub_123", graceStartedAt: new Date(Date.now() - 3 * DAY) })
    );

    const res = await patch({ status: "SUSPENDED", suspendedReason: "A renewal payment failed." });

    expect(res.status).toBe(200);
    // Now an operator's suspension: a payment arriving later must not lift it.
    expect(written()).toMatchObject({ status: "SUSPENDED", nonPaymentSubscriptionId: null });
  });

  it("keeps the marker when the dialog is re-saved with the status unchanged", async () => {
    control.organization.findUnique.mockResolvedValue(org({ status: "SUSPENDED", stripeSubscriptionId: "sub_123", nonPaymentSubscriptionId: "sub_123" }));

    await patch({ status: "SUSPENDED", seatLimitOverride: 40 });

    expect(written()).not.toHaveProperty("nonPaymentSubscriptionId");
    expect(auditActions()).toContain("organization.updated");
  });
});

/** A self-serve workspace mid-trial: entitled to TEAM until `trialEndsAt`, paying for nothing yet. */
const trialling = (overrides: Record<string, unknown> = {}) =>
  org({ planTier: "STARTER", trialTier: "TEAM", trialEndsAt: new Date(Date.now() + 5 * DAY), ...overrides });
/** The same workspace the day after its trial ended without a subscription. */
const lapsedTrial = (overrides: Record<string, unknown> = {}) =>
  trialling({
    status: "GRACE",
    trialEndsAt: new Date(Date.now() - DAY),
    graceStartedAt: new Date(Date.now() - DAY + 60_000),
    suspendedReason: "Free trial ended without a subscription.",
    ...overrides
  });

describe("setting a plan on a trialling workspace ends the trial", () => {
  it("clears the trial clock, so no more trial warnings and no lapse", async () => {
    control.organization.findUnique.mockResolvedValue(trialling());

    const res = await patch({ planTier: "TEAM" });

    expect(res.status).toBe(200);
    expect(written()).toMatchObject({ planTier: "TEAM", trialEndsAt: null, trialTier: null });
    // Still running, so nothing about its status changes.
    expect(written()).not.toHaveProperty("status");
  });

  it("brings a lapsed trial back to ACTIVE — the console dialog re-sends the unchanged GRACE status", async () => {
    control.organization.findUnique.mockResolvedValue(lapsedTrial());

    // Exactly what the edit dialog sends: every field, including the status it was opened with.
    await patch({ status: "GRACE", planTier: "TEAM", suspendedReason: null, seatLimitOverride: null, aiMonthlyBudgetCeilingOverride: null });

    expect(written()).toMatchObject({ planTier: "TEAM", trialEndsAt: null, trialTier: null, status: "ACTIVE", graceStartedAt: null, suspendedReason: null });
    // Unlocked now, not when the 10-second status cache expires.
    expect(forgetOrgStatus).toHaveBeenCalledWith("org-1");
  });

  it("respects a different status the operator chose in the same edit", async () => {
    control.organization.findUnique.mockResolvedValue(lapsedTrial());

    await patch({ status: "SUSPENDED", planTier: "TEAM", suspendedReason: "Contract signed, awaiting PO" });

    expect(written()).toMatchObject({ status: "SUSPENDED", trialEndsAt: null, trialTier: null });
  });

  it("records WHEN the trial converted, so the console can measure days to convert", async () => {
    control.organization.findUnique.mockResolvedValue(trialling());
    const before = Date.now();

    await patch({ planTier: "TEAM" });

    // Nothing recorded the moment of conversion, so "median days to convert" could never render.
    const at = written().convertedAt as Date;
    expect(at).toBeInstanceOf(Date);
    expect(at.getTime()).toBeGreaterThanOrEqual(before);
  });

  it("keeps the FIRST conversion moment when a converted workspace is edited again", async () => {
    const first = new Date("2026-09-01T10:00:00Z");
    control.organization.findUnique.mockResolvedValue(trialling({ planTier: "TEAM", convertedAt: first }));

    await patch({ planTier: "ENTERPRISE" });

    expect(written().convertedAt).toEqual(first);
  });

  it("writes an audit row that names the conversion", async () => {
    control.organization.findUnique.mockResolvedValue(lapsedTrial());

    await patch({ planTier: "ENTERPRISE" });

    const row = control.platformAuditLog.create.mock.calls.map((call) => call[0].data).find((data) => data.action === "organization.trial_converted");
    expect(row).toBeDefined();
    expect(row.metadata).toMatchObject({ slug: "acme", planTier: "ENTERPRISE", trialTier: "TEAM", restoredFromGrace: true });
    expect(row.reason).toBe(REASON);
  });

  it("is not a conversion to leave the plan on the free tier", async () => {
    control.organization.findUnique.mockResolvedValue(trialling());

    await patch({ planTier: "STARTER", seatLimitOverride: 25 });

    expect(written()).not.toHaveProperty("trialEndsAt");
    expect(auditActions()).not.toContain("organization.trial_converted");
  });

  it("leaves a workspace that never had a trial exactly as it was", async () => {
    control.organization.findUnique.mockResolvedValue(org({ planTier: "TEAM" }));

    await patch({ planTier: "ENTERPRISE" });

    expect(written()).toEqual({ planTier: "ENTERPRISE" });
    expect(auditActions()).toEqual(["organization.updated"]);
  });
});

describe("extending a trial", () => {
  const until = new Date(Date.now() + 14 * DAY);

  it("moves the end date and re-arms the 7/3/1-day warnings for it", async () => {
    control.organization.findUnique.mockResolvedValue(trialling({ trialNoticesSent: [7, 3] }));

    const res = await patch({ trialEndsAt: until.toISOString() });

    expect(res.status).toBe(200);
    expect(written()).toMatchObject({ trialNoticesSent: [] });
    expect((written().trialEndsAt as Date).toISOString()).toBe(until.toISOString());
    expect(auditActions()).toContain("organization.trial_extended");
  });

  it("re-opens a trial that had already lapsed", async () => {
    control.organization.findUnique.mockResolvedValue(lapsedTrial());

    await patch({ trialEndsAt: until.toISOString() });

    expect(written()).toMatchObject({ status: "ACTIVE", graceStartedAt: null, suspendedReason: null });
    expect(forgetOrgStatus).toHaveBeenCalledWith("org-1");
  });

  it("is a billing decision, so a billing-only role may make it", async () => {
    ACTOR.role = "BILLING" as never;
    try {
      control.organization.findUnique.mockResolvedValue(trialling());
      expect((await patch({ trialEndsAt: until.toISOString() })).status).toBe(200);
    } finally {
      ACTOR.role = "OWNER";
    }
  });

  it("refuses a date in the past", async () => {
    control.organization.findUnique.mockResolvedValue(trialling());
    const res = await patch({ trialEndsAt: new Date(Date.now() - DAY).toISOString() });
    expect(res.status).toBe(422);
    expect(control.organization.update).not.toHaveBeenCalled();
  });

  it("refuses a workspace with no trial to extend", async () => {
    control.organization.findUnique.mockResolvedValue(org({ planTier: "TEAM" }));
    const res = await patch({ trialEndsAt: until.toISOString() });
    expect(res.status).toBe(409);
    expect(control.organization.update).not.toHaveBeenCalled();
  });

  it("refuses extending and converting in one edit — they are opposite decisions", async () => {
    control.organization.findUnique.mockResolvedValue(trialling());
    const res = await patch({ planTier: "TEAM", trialEndsAt: until.toISOString() });
    expect(res.status).toBe(422);
    expect(control.organization.update).not.toHaveBeenCalled();
  });
});
