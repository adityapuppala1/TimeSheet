/**
 * Pins the plan-tier limits that the pricing table sells against the values the platform enforces.
 *
 * WHY THIS TEST EXISTS: the marketing comparison table used to restate these numbers from memory,
 * and it drifted in the way that costs money rather than the way that's merely untidy — it
 * advertised face verification on TEAM while the control-plane seed grants it to ENTERPRISE only,
 * and that feature FAILS CLOSED. A customer buying Team partly for that row would have had their
 * admin's attempt to switch it on refused.
 *
 * The structural fix is `PLAN_TIER_LIMITS` in @timesheet/shared: the seed writes it into
 * PlanTierLimit and `PricingDialog.tsx` renders from it, so a table cell and the limit it describes
 * cannot disagree. This test is the second line of defence — it pins the VALUES, so changing what
 * a tier includes is a deliberate act with a failing test attached, not a silent edit.
 *
 * A failure here is not a bug in the code. It means someone changed what a plan includes, and the
 * question to answer is whether the pricing page, the docs, and any signed contracts agree.
 */
import { describe, expect, it } from "vitest";
import { PLAN_TIER_LIMITS, planTiers, UNLIMITED_SEATS } from "@timesheet/shared";

describe("plan tier limits", () => {
  it("matches the tiers the pricing table sells", () => {
    // Written out in full rather than looped: this is a contract, and a reviewer should be able to
    // read what each tier promises without resolving indirection.
    expect(PLAN_TIER_LIMITS).toEqual({
      STARTER: {
        seatLimit: 10,
        aiMonthlyBudgetCeilingUsd: 0,
        allowedSsoProviders: ["GOOGLE"],
        allowedChatPlatforms: [],
        faceVerificationEnabled: false
      },
      TEAM: {
        seatLimit: UNLIMITED_SEATS,
        aiMonthlyBudgetCeilingUsd: 200,
        allowedSsoProviders: ["GOOGLE", "MICROSOFT"],
        allowedChatPlatforms: ["SLACK", "TELEGRAM"],
        faceVerificationEnabled: false
      },
      ENTERPRISE: {
        seatLimit: UNLIMITED_SEATS,
        aiMonthlyBudgetCeilingUsd: 5000,
        allowedSsoProviders: ["GOOGLE", "MICROSOFT", "SAML", "LDAP"],
        allowedChatPlatforms: ["SLACK", "MICROSOFT_TEAMS", "GOOGLE_CHAT", "TELEGRAM"],
        faceVerificationEnabled: true
      }
    });
  });

  it("keeps face verification Enterprise-only, because it fails closed", () => {
    // The specific row that was wrong on the pricing page. Enabling, enrolling and verifying all
    // return 403 without the entitlement, so advertising it on a lower tier is not an
    // over-generous description — it is a promise the product actively refuses to keep.
    expect(PLAN_TIER_LIMITS.STARTER.faceVerificationEnabled).toBe(false);
    expect(PLAN_TIER_LIMITS.TEAM.faceVerificationEnabled).toBe(false);
    expect(PLAN_TIER_LIMITS.ENTERPRISE.faceVerificationEnabled).toBe(true);
  });

  it("gives Starter a zero AI ceiling, which is what makes AI unavailable there", () => {
    // An explicit 0 is a real cap, not "unlimited" (see assertWithinBudget). This is the mechanism
    // behind every "AI: not included" cell in the Starter column — if it ever became null the
    // pricing table would be wrong in the expensive direction.
    expect(PLAN_TIER_LIMITS.STARTER.aiMonthlyBudgetCeilingUsd).toBe(0);
    expect(PLAN_TIER_LIMITS.TEAM.aiMonthlyBudgetCeilingUsd).toBeGreaterThan(0);
  });

  it("only ever widens entitlements as the tier goes up", () => {
    // A cheaper tier must never include something a dearer one lacks — that's incoherent to sell
    // and usually means a typo. Checked as a property so it holds for limits added later too.
    const order = [...planTiers];
    for (let i = 1; i < order.length; i++) {
      const lower = PLAN_TIER_LIMITS[order[i - 1]];
      const higher = PLAN_TIER_LIMITS[order[i]];

      expect(higher.seatLimit, `${order[i]} seats`).toBeGreaterThanOrEqual(lower.seatLimit);
      expect(higher.aiMonthlyBudgetCeilingUsd, `${order[i]} AI ceiling`).toBeGreaterThanOrEqual(lower.aiMonthlyBudgetCeilingUsd);
      for (const provider of lower.allowedSsoProviders) {
        expect(higher.allowedSsoProviders, `${order[i]} SSO`).toContain(provider);
      }
      for (const platform of lower.allowedChatPlatforms) {
        expect(higher.allowedChatPlatforms, `${order[i]} chat`).toContain(platform);
      }
      if (lower.faceVerificationEnabled) expect(higher.faceVerificationEnabled).toBe(true);
    }
  });
});
