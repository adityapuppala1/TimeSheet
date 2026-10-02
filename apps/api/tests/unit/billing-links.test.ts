/**
 * Every billing link this product sends a LAPSED workspace lands on /plan-lapsed, never inside /app.
 *
 * A workspace in GRACE cannot use the app shell: its own requests are refused with a 402 and the
 * client answers every 402 by navigating to /plan-lapsed. So the failed-payment email's "Update
 * payment method", the trial-ended email's "Choose a plan", the retention reminders' billing link and
 * the reactivation page's sign-in all used to bounce: /app/settings?tab=billing → 402 → /plan-lapsed,
 * which at the time had no way to pay. An ACTIVE workspace's links (trial still running, plan
 * changed) keep pointing at the Billing tab.
 *
 * And the reactivation link signs the owner in with `?next=` — the parameter Login.tsx reads. It sent
 * `?returnTo=`, which nothing reads, so the owner landed on /app and bounced the same way.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
  dispatched: [] as Array<{ templateKey: string; vars: Record<string, string> }>,
  orgFindUnique: vi.fn(),
  orgUpdate: vi.fn()
}));

vi.mock("../../src/config/control-prisma.js", () => ({
  controlPrisma: {
    organization: { findUnique: m.orgFindUnique, update: m.orgUpdate },
    platformRetentionSettings: { findUnique: vi.fn(async () => null), create: vi.fn(async () => ({ enabled: true, feedbackDay: 10, reminderDays: [30, 60, 80, 90], retentionDays: 90, autoDeleteEnabled: true, snapshotDir: null, updatedAt: new Date() })) },
    platformAuditLog: { create: vi.fn() }
  }
}));
vi.mock("../../src/config/prisma.js", () => ({ prisma: { user: { findMany: async () => [{ email: "owner@acme.test" }] } }, disconnectAllTenantClients: vi.fn() }));
vi.mock("../../src/config/with-org-tenant.js", () => ({ withOrgTenant: async (_slug: string, fn: () => Promise<unknown>) => fn() }));
vi.mock("../../src/services/notify.service.js", () => ({
  dispatchTransactional: async (args: { templateKey: string; vars: Record<string, string> }) => {
    m.dispatched.push(args);
    return { ok: true };
  }
}));
vi.mock("../../src/services/platform-mail.service.js", () => ({ sendPlatformTemplate: vi.fn() }));
vi.mock("../../src/services/org-status.service.js", () => ({ forgetOrgStatus: vi.fn() }));
vi.mock("../../src/services/workspace-directory.service.js", () => ({
  workspaceUrlForSlug: (slug: string) => `https://${slug}.example.test`,
  tenantBaseUrl: () => "https://acme.example.test"
}));

const { notifyPaymentFailed, notifyPlanChanged } = await import("../../src/services/billing-notify.service.js");
const { DEFAULT_RETENTION_SETTINGS, reactivateWorkspace, retentionPlan, retentionVars, signPublicToken } = await import("../../src/services/retention.service.js");
const { runTrialLifecycleTick } = await import("../../src/workers/trial-lifecycle.worker.js");

const DAY = 24 * 60 * 60 * 1000;
const now = new Date("2026-10-02T09:30:00Z");
const urlOf = (key: string) => m.dispatched.find((d) => d.templateKey === key)?.vars.billingUrl;

beforeEach(() => {
  m.dispatched.length = 0;
  vi.clearAllMocks();
});

describe("workspace billing emails", () => {
  it("sends a failed renewal to /plan-lapsed — the workspace is in GRACE by the time it is read", async () => {
    await notifyPaymentFailed("acme", "Acme");
    expect(urlOf("billing.payment_failed")).toBe("https://acme.example.test/plan-lapsed");
  });

  it("still sends a plan-change receipt to the Billing tab — that workspace is ACTIVE", async () => {
    await notifyPlanChanged("acme", "Acme", "TEAM");
    expect(urlOf("billing.plan_changed")).toBe("https://acme.example.test/app/settings?tab=billing");
  });
});

describe("the trial lifecycle's emails", () => {
  const trial = (trialEndsAt: Date) => ({ id: "org-1", slug: "acme", name: "Acme", status: "ACTIVE", planTier: "STARTER", trialTier: "TEAM", stripeSubscriptionId: null, trialEndsAt, trialNoticesSent: null });

  it("links 'trial ending' to the Billing tab and 'trial ended' to /plan-lapsed", async () => {
    // Retention programme off (its settings row read throws → false), so this worker sends "ended" itself.
    vi.mocked((await import("../../src/config/control-prisma.js")).controlPrisma.platformRetentionSettings.findUnique).mockRejectedValueOnce(new Error("off"));
    const rows = [trial(new Date(now.getTime() + 2 * DAY)), { ...trial(new Date(now.getTime() - 1000)), id: "org-2" }];
    const control = (await import("../../src/config/control-prisma.js")).controlPrisma as unknown as { organization: Record<string, unknown> };
    control.organization.findMany = vi.fn(async ({ where }: { where: { status: string; trialEndsAt?: { gt?: Date; lte?: Date } } }) =>
      rows.filter((o) => o.status === where.status && (!where.trialEndsAt?.gt || o.trialEndsAt > where.trialEndsAt.gt) && (!where.trialEndsAt?.lte || o.trialEndsAt <= where.trialEndsAt.lte))
    );
    m.orgUpdate.mockResolvedValue({});

    await runTrialLifecycleTick(now.getTime());

    expect(urlOf("billing.trial_ending")).toBe("https://acme.example.test/app/settings?tab=billing");
    expect(urlOf("billing.trial_ended")).toBe("https://acme.example.test/plan-lapsed");
  });
});

describe("the retention programme", () => {
  const org = {
    id: "org-1",
    name: "Acme",
    slug: "acme",
    status: "GRACE" as const,
    planTier: "STARTER" as const,
    trialTier: "TEAM" as const,
    trialStartedAt: new Date(now.getTime() - 50 * DAY),
    trialEndsAt: new Date(now.getTime() - 35 * DAY),
    stripeSubscriptionId: null,
    retentionNoticesSent: {},
    retentionHold: false,
    retentionDeletedAt: null,
    createdAt: new Date(now.getTime() - 50 * DAY)
  };

  it("links a lapsed workspace's reminders to /plan-lapsed", () => {
    const plan = retentionPlan(org, DEFAULT_RETENTION_SETTINGS, now);
    expect(retentionVars(org, plan, DEFAULT_RETENTION_SETTINGS, "30", "Priya", now).billingUrl).toBe("https://acme.example.test/plan-lapsed");
  });

  it("links the mid-trial check-in to the Billing tab — the trial is still running", () => {
    const running = { ...org, status: "ACTIVE" as const, trialEndsAt: new Date(now.getTime() + 4 * DAY) };
    const plan = retentionPlan(running, DEFAULT_RETENTION_SETTINGS, now);
    expect(retentionVars(running, plan, DEFAULT_RETENTION_SETTINGS, "feedback10", "Priya", now).billingUrl).toBe("https://acme.example.test/app/settings?tab=billing");
  });

  it("signs a reactivated owner in with `next=/plan-lapsed`, the parameter the login page reads", async () => {
    m.orgFindUnique.mockResolvedValue({ ...org, status: "SUSPENDED" });
    m.orgUpdate.mockResolvedValue({});
    const token = signPublicToken({ o: "org-1", p: "reactivate", s: "30", e: Date.now() + DAY });

    const result = await reactivateWorkspace(token);

    expect(result.restored).toBe(true);
    const url = new URL(result.url);
    expect(url.pathname).toBe("/login");
    expect(url.searchParams.get("next")).toBe("/plan-lapsed");
    expect(url.searchParams.has("returnTo")).toBe(false);
  });
});
