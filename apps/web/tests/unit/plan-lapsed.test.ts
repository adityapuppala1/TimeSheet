/**
 * /plan-lapsed's decisions, pinned because each one is a door offered (or not) to somebody locked
 * out of their workspace:
 *  - only a super admin is offered anything that takes payment, and which thing depends on WHY the
 *    workspace lapsed — no subscription (a trial ended) buys a plan through Checkout; a subscription
 *    whose renewal failed updates its card in the billing portal instead of buying a second one;
 *  - everybody else is told whom to ask, by name;
 *  - coming back from Stripe, the page waits for the webhook, opens the app once the workspace is
 *    ACTIVE, and says plainly when confirmation is taking too long rather than spinning forever.
 */
import { describe, expect, it } from "vitest";
import { contactLine, lapsedActions, lapsedPageMode, paymentWaitState, PAYMENT_WAIT_TIMEOUT_MS } from "../../src/utils/plan-lapsed";

const billing = (overrides: Partial<Parameters<typeof lapsedActions>[1] & object> = {}) => ({
  planTier: "STARTER" as const,
  hasStripeCustomer: false,
  hasSubscription: false,
  checkoutAvailable: { TEAM: true, ENTERPRISE: true },
  ...overrides
});

describe("lapsedActions", () => {
  it("offers nothing that takes payment to anyone but a super admin", () => {
    for (const role of ["EMPLOYEE", "MANAGER", "ADMIN", undefined]) expect(lapsedActions(role, billing())).toBeNull();
  });

  it("offers a lapsed trial (no subscription) the plans that can be bought, and the exports", () => {
    expect(lapsedActions("SUPER_ADMIN", billing())).toEqual({ plans: ["TEAM", "ENTERPRISE"], portal: false, exports: true, checkoutUnconfigured: false });
    expect(lapsedActions("SUPER_ADMIN", billing({ checkoutAvailable: { TEAM: false, ENTERPRISE: true } }))?.plans).toEqual(["ENTERPRISE"]);
  });

  it("offers a failed renewal the billing portal, NOT a second Checkout", () => {
    // A second Checkout beside a live (past-due) subscription would be a second subscription.
    expect(lapsedActions("SUPER_ADMIN", billing({ planTier: "TEAM", hasStripeCustomer: true, hasSubscription: true }))).toEqual({
      plans: [],
      portal: true,
      exports: true,
      checkoutUnconfigured: false
    });
  });

  it("says so, rather than showing dead buttons, when no plan can be bought on this deployment", () => {
    expect(lapsedActions("SUPER_ADMIN", billing({ checkoutAvailable: { TEAM: false, ENTERPRISE: false } }))).toMatchObject({ plans: [], checkoutUnconfigured: true });
  });

  it("still offers the exports while billing is loading", () => {
    expect(lapsedActions("SUPER_ADMIN", undefined)).toEqual({ plans: [], portal: false, exports: true, checkoutUnconfigured: false });
  });
});

describe("contactLine", () => {
  it("names who can renew", () => {
    expect(contactLine([{ name: "Priya Shah", email: "priya@acme.test" }])).toBe("Ask Priya Shah (priya@acme.test) to renew it.");
    expect(contactLine([{ name: "Priya Shah", email: "priya@acme.test" }, { name: "Sam Lee", email: "sam@acme.test" }])).toBe(
      "Ask Priya Shah (priya@acme.test) or Sam Lee (sam@acme.test) to renew it."
    );
    expect(
      contactLine([
        { name: "A", email: "a@x.test" },
        { name: "B", email: "b@x.test" },
        { name: "C", email: "c@x.test" }
      ])
    ).toBe("Ask A (a@x.test), B (b@x.test) or C (c@x.test) to renew it.");
  });

  it("falls back to the role when nobody could be named", () => {
    expect(contactLine([])).toBe("Ask a workspace admin to renew it.");
    expect(contactLine(undefined)).toBe("Ask a workspace admin to renew it.");
  });
});

describe("lapsedPageMode", () => {
  it("waits for the payment to land when Stripe sent the browser back", () => {
    expect(lapsedPageMode("success", "GRACE")).toBe("finishing");
    expect(lapsedPageMode("success", undefined)).toBe("finishing");
  });

  it("says the workspace is open again once it is ACTIVE, rather than showing a lock", () => {
    // A stale status cache on another replica can send somebody here a few seconds after paying.
    expect(lapsedPageMode(null, "ACTIVE")).toBe("active");
  });

  it("shows the lapsed page otherwise, including after a cancelled checkout", () => {
    expect(lapsedPageMode(null, "GRACE")).toBe("lapsed");
    expect(lapsedPageMode("cancelled", "GRACE")).toBe("lapsed");
    expect(lapsedPageMode(null, undefined)).toBe("lapsed");
  });
});

describe("paymentWaitState", () => {
  const start = 1_000_000;
  it("is done the moment the workspace is ACTIVE", () => {
    expect(paymentWaitState(start, start + 3_000, "ACTIVE")).toBe("active");
  });

  it("keeps waiting for the webhook, then gives up waiting out loud", () => {
    expect(paymentWaitState(start, start + 3_000, "GRACE")).toBe("waiting");
    expect(paymentWaitState(start, start + PAYMENT_WAIT_TIMEOUT_MS, "GRACE")).toBe("timed-out");
  });
});
