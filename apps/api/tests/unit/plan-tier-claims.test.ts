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
import { PLAN_TIER_LIMITS, planTiers, UNLIMITED_PLAN_ITEMS, UNLIMITED_SEATS } from "@timesheet/shared";

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
        faceVerificationEnabled: false,
        ganttEnabled: false,
        resourceMgmtEnabled: false,
        approvalsEnabled: false,
        proofingEnabled: false,
        customWorkflowsEnabled: false,
        aiPmCopilotEnabled: false,
        maxPortfolios: 0,
        maxRequestForms: 0,
        maxBlueprints: 0,
        maxCustomFields: 0,
        maxDashboards: 0,
        goalsEnabled: false,
        maxGoals: 0
      },
      TEAM: {
        seatLimit: UNLIMITED_SEATS,
        aiMonthlyBudgetCeilingUsd: 200,
        allowedSsoProviders: ["GOOGLE", "MICROSOFT"],
        allowedChatPlatforms: ["SLACK", "TELEGRAM"],
        faceVerificationEnabled: false,
        ganttEnabled: true,
        resourceMgmtEnabled: false,
        approvalsEnabled: true,
        proofingEnabled: true,
        customWorkflowsEnabled: false,
        aiPmCopilotEnabled: false,
        maxPortfolios: 1,
        maxRequestForms: 5,
        maxBlueprints: 5,
        maxCustomFields: 10,
        maxDashboards: 3,
        // Goals are an everyday alignment surface, not an enterprise luxury: Team gets them with a
        // ceiling, because the measured sources read data the tier already holds.
        goalsEnabled: true,
        maxGoals: 25
      },
      ENTERPRISE: {
        seatLimit: UNLIMITED_SEATS,
        aiMonthlyBudgetCeilingUsd: 5000,
        allowedSsoProviders: ["GOOGLE", "MICROSOFT", "SAML", "LDAP"],
        allowedChatPlatforms: ["SLACK", "MICROSOFT_TEAMS", "GOOGLE_CHAT", "TELEGRAM"],
        faceVerificationEnabled: true,
        ganttEnabled: true,
        resourceMgmtEnabled: true,
        approvalsEnabled: true,
        proofingEnabled: true,
        customWorkflowsEnabled: true,
        aiPmCopilotEnabled: true,
        maxPortfolios: UNLIMITED_PLAN_ITEMS,
        maxRequestForms: UNLIMITED_PLAN_ITEMS,
        maxBlueprints: UNLIMITED_PLAN_ITEMS,
        maxCustomFields: UNLIMITED_PLAN_ITEMS,
        maxDashboards: UNLIMITED_PLAN_ITEMS,
        goalsEnabled: true,
        maxGoals: UNLIMITED_PLAN_ITEMS
      }
    });
  });

  it("keeps every planning capability off on Starter, because they all fail closed", () => {
    // Same argument as the face-verification row above, applied to the whole V6 planning layer:
    // plan-limits.service.ts refuses each of these without the entitlement, so advertising one on
    // a tier that doesn't have it is a promise the product actively declines to keep.
    const starter = PLAN_TIER_LIMITS.STARTER;
    expect(starter.ganttEnabled).toBe(false);
    expect(starter.resourceMgmtEnabled).toBe(false);
    expect(starter.approvalsEnabled).toBe(false);
    expect(starter.proofingEnabled).toBe(false);
    expect(starter.customWorkflowsEnabled).toBe(false);
    expect(starter.aiPmCopilotEnabled).toBe(false);
  });

  it("gates the AI PM copilot behind a non-zero AI budget", () => {
    // The copilot spends real money through the same meter every other AI feature uses. A tier
    // that offered it with a zero ceiling would show the buttons and then refuse every click at
    // preflight — worse than not offering it, because the customer has already been sold it.
    for (const tier of planTiers) {
      if (PLAN_TIER_LIMITS[tier].aiPmCopilotEnabled) {
        expect(PLAN_TIER_LIMITS[tier].aiMonthlyBudgetCeilingUsd, `${tier} AI ceiling`).toBeGreaterThan(0);
      }
    }
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

      // The V6 planning entitlements, checked the same way. Enumerated rather than derived from
      // Object.keys so that adding a boolean/number to PlanTierLimits without listing it here
      // shows up as a deliberate omission at review, not as silently-unchecked surface.
      for (const capability of [
        "ganttEnabled",
        "resourceMgmtEnabled",
        "approvalsEnabled",
        "proofingEnabled",
        "customWorkflowsEnabled",
        "aiPmCopilotEnabled"
      ] as const) {
        if (lower[capability]) expect(higher[capability], `${order[i]} ${capability}`).toBe(true);
      }
      for (const quota of [
        "maxPortfolios",
        "maxRequestForms",
        "maxBlueprints",
        "maxCustomFields",
        "maxDashboards"
      ] as const) {
        expect(higher[quota], `${order[i]} ${quota}`).toBeGreaterThanOrEqual(lower[quota]);
      }
    }
  });
});
