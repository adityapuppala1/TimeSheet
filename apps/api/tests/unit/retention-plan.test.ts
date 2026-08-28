/**
 * The trial retention schedule, tested where it decides something.
 *
 * `retentionPlan` is pure — an org row, the settings, a clock — so every rule the programme makes
 * a promise about is a case here: what is due on which day, that a backlog is superseded rather
 * than replayed, and above all the deletion guards, each one tried by removing it.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/config/control-prisma.js", () => ({ controlPrisma: {} }));
vi.mock("../../src/config/prisma.js", () => ({ prisma: {}, disconnectAllTenantClients: vi.fn() }));
vi.mock("../../src/config/with-org-tenant.js", () => ({ withOrgTenant: vi.fn() }));
vi.mock("../../src/services/platform-mail.service.js", () => ({ sendPlatformTemplate: vi.fn() }));
vi.mock("../../src/services/workspace-directory.service.js", () => ({ workspaceUrlForSlug: (slug: string) => `https://${slug}.example.test` }));

const { DEFAULT_RETENTION_SETTINGS, isConverted, noticesSent, retentionPlan, signPublicToken, verifyPublicToken } = await import("../../src/services/retention.service.js");

const DAY = 24 * 60 * 60 * 1000;
const T0 = new Date("2026-06-01T09:00:00Z");
const at = (days: number) => new Date(T0.getTime() + days * DAY);

function trialOrg(overrides: Partial<Parameters<typeof retentionPlan>[0]> = {}) {
  return {
    id: "org-1",
    name: "Acme",
    slug: "acme",
    status: "ACTIVE" as const,
    planTier: "STARTER" as const,
    trialTier: "TEAM" as const,
    trialStartedAt: T0,
    trialEndsAt: at(15),
    stripeSubscriptionId: null,
    retentionNoticesSent: null,
    retentionHold: false,
    retentionDeletedAt: null,
    createdAt: T0,
    ...overrides
  };
}

const settings = { ...DEFAULT_RETENTION_SETTINGS };

describe("membership", () => {
  it("a hand-provisioned workspace (no trial clock) is not in the programme", () => {
    const plan = retentionPlan(trialOrg({ trialEndsAt: null, trialTier: null }), settings, at(100));
    expect(plan.inProgramme).toBe(false);
    expect(plan.due).toEqual([]);
    expect(plan.deletionBlockedBy).toBe("not-in-programme");
  });

  it("a paying customer is converted, whatever the clock says", () => {
    expect(isConverted({ trialTier: null, stripeSubscriptionId: null, planTier: "STARTER" })).toBe(true);
    expect(isConverted({ trialTier: "TEAM", stripeSubscriptionId: "sub_1", planTier: "STARTER" })).toBe(true);
    expect(isConverted({ trialTier: "TEAM", stripeSubscriptionId: null, planTier: "ENTERPRISE" })).toBe(true);
    expect(isConverted({ trialTier: "TEAM", stripeSubscriptionId: null, planTier: "STARTER" })).toBe(false);
    const plan = retentionPlan(trialOrg({ status: "SUSPENDED", planTier: "TEAM" }), settings, at(200));
    expect(plan.converted).toBe(true);
    expect(plan.due).toEqual([]);
    expect(plan.deletionDue).toBe(false);
    expect(plan.deletionBlockedBy).toBe("converted");
  });
});

describe("what is due, day by day", () => {
  it("nothing before day 10, the check-in from day 10, never twice", () => {
    expect(retentionPlan(trialOrg(), settings, at(9)).due).toEqual([]);
    expect(retentionPlan(trialOrg(), settings, at(10)).due).toEqual(["feedback10"]);
    expect(retentionPlan(trialOrg({ retentionNoticesSent: { feedback10: at(10).toISOString() } }), settings, at(12)).due).toEqual([]);
  });

  it("the check-in is not sent after the trial has already ended", () => {
    expect(retentionPlan(trialOrg({ status: "GRACE" }), settings, at(16)).due).not.toContain("feedback10");
  });

  it("'ended' goes out once the workspace is lapsed, and within a week of the end", () => {
    // Still ACTIVE at 09:30 on the day it ends means the lifecycle worker has not moved it yet.
    expect(retentionPlan(trialOrg(), settings, at(15)).due).toEqual([]);
    expect(retentionPlan(trialOrg({ status: "GRACE" }), settings, at(15)).due).toEqual(["ended"]);
    expect(retentionPlan(trialOrg({ status: "GRACE" }), settings, at(20)).due).toEqual(["ended"]);
    // Twelve days late is no longer news.
    const late = retentionPlan(trialOrg({ status: "SUSPENDED" }), settings, at(27));
    expect(late.due).toEqual([]);
    expect(late.superseded).toEqual(["ended"]);
  });

  it("reminders land on 30, 60, 80 and 90 days after the trial ended", () => {
    const sentEnded = { ended: at(15).toISOString() };
    const on = (day: number, sent: Record<string, string> = sentEnded) => retentionPlan(trialOrg({ status: "SUSPENDED", retentionNoticesSent: sent }), settings, at(15 + day));
    expect(on(29).due).toEqual([]);
    expect(on(30).due).toEqual(["30"]);
    expect(on(60, { ...sentEnded, "30": "x" }).due).toEqual(["60"]);
    expect(on(80, { ...sentEnded, "30": "x", "60": "x" }).due).toEqual(["80"]);
    expect(on(90, { ...sentEnded, "30": "x", "60": "x", "80": "x" }).due).toEqual(["90"]);
    expect(on(91, { ...sentEnded, "30": "x", "60": "x", "80": "x", "90": "x" }).due).toEqual([]);
  });

  it("a backlog sends only the latest reminder and records the rest as superseded", () => {
    // Programme switched on when this workspace was already 70 days past its trial.
    const plan = retentionPlan(trialOrg({ status: "SUSPENDED" }), settings, at(15 + 70));
    expect(plan.due).toEqual(["60"]);
    expect(plan.superseded).toEqual(["ended", "30"]);
    expect(plan.nextMarker).toEqual({ marker: "80", at: at(15 + 80) });
  });

  it("names the next thing that will happen", () => {
    expect(retentionPlan(trialOrg(), settings, at(3)).nextMarker).toEqual({ marker: "feedback10", at: at(10) });
    expect(retentionPlan(trialOrg({ retentionNoticesSent: { feedback10: "x" } }), settings, at(12)).nextMarker).toEqual({ marker: "ended", at: at(15) });
    expect(retentionPlan(trialOrg({ status: "GRACE", retentionNoticesSent: { ended: "x" } }), settings, at(20)).nextMarker).toEqual({ marker: "30", at: at(45) });
  });
});

describe("deletion — every reason has to be there", () => {
  const allSent = { ended: "x", "30": "x", "60": "x", "80": "x", "90": at(15 + 90).toISOString() };
  const lapsedAt = (day: number, overrides: Partial<Parameters<typeof retentionPlan>[0]> = {}) =>
    retentionPlan(trialOrg({ status: "SUSPENDED", retentionNoticesSent: allSent, ...overrides }), settings, at(15 + day));

  it("is due the day after the final notice, when nothing blocks it", () => {
    const plan = lapsedAt(91);
    expect(plan.deletionDue).toBe(true);
    expect(plan.deletionBlockedBy).toBeNull();
    expect(plan.deleteAt).toEqual(at(15 + 90));
  });

  it("not before the window has passed", () => {
    expect(lapsedAt(89).deletionBlockedBy).toBe("not-yet");
  });

  it("not on the same tick the final notice went out — the customer gets a day with it", () => {
    expect(lapsedAt(90).deletionBlockedBy).toBe("final-notice-today");
  });

  it("not until the final notice has actually been sent", () => {
    expect(lapsedAt(95, { retentionNoticesSent: { ended: "x", "30": "x", "60": "x", "80": "x" } }).deletionBlockedBy).toBe("final-notice-pending");
    expect(lapsedAt(95, { retentionNoticesSent: { ...allSent, "90": "superseded" } }).deletionBlockedBy).toBe("final-notice-pending");
  });

  it("not while a platform admin holds it", () => {
    expect(lapsedAt(95, { retentionHold: true }).deletionBlockedBy).toBe("hold");
  });

  it("not with the kill switch off", () => {
    const plan = retentionPlan(trialOrg({ status: "SUSPENDED", retentionNoticesSent: allSent }), { ...settings, autoDeleteEnabled: false }, at(15 + 95));
    expect(plan.deletionBlockedBy).toBe("auto-delete-off");
  });

  it("not for a workspace that is not lapsed", () => {
    expect(lapsedAt(95, { status: "ACTIVE" }).deletionBlockedBy).toBe("status");
  });

  it("never for a paying customer", () => {
    expect(lapsedAt(95, { stripeSubscriptionId: "sub_1" }).deletionBlockedBy).toBe("converted");
    expect(lapsedAt(95, { planTier: "TEAM" }).deletionBlockedBy).toBe("converted");
  });

  it("never twice", () => {
    const plan = lapsedAt(120, { retentionDeletedAt: at(106), status: "ARCHIVED" });
    expect(plan.stage).toBe("deleted");
    expect(plan.deletionDue).toBe(false);
  });
});

describe("public tokens", () => {
  it("round-trips, and refuses the wrong purpose, a bad signature and an expiry", () => {
    const token = signPublicToken({ o: "org-1", p: "feedback", s: "30", e: Date.now() + DAY });
    expect(verifyPublicToken(token, "feedback")?.o).toBe("org-1");
    expect(verifyPublicToken(token, "reactivate")).toBeNull();
    expect(verifyPublicToken(`${token.slice(0, -1)}0`, "feedback")).toBeNull();
    expect(verifyPublicToken(token, "feedback", Date.now() + 2 * DAY)).toBeNull();
    expect(verifyPublicToken("garbage", "feedback")).toBeNull();
  });
});

describe("noticesSent", () => {
  it("reads only the object-of-strings shape and ignores anything else", () => {
    expect(noticesSent(null)).toEqual({});
    expect(noticesSent(["30"])).toEqual({});
    expect(noticesSent({ "30": "2026-01-01", "60": 7 })).toEqual({ "30": "2026-01-01" });
  });
});
