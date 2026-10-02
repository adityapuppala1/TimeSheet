/**
 * /plan-lapsed's decisions, pinned because each one is a door offered (or not) to somebody locked
 * out of their workspace:
 *  - only a super admin is offered anything that takes payment, and which thing depends on WHY the
 *    workspace lapsed — no subscription (a trial ended) buys a plan through Checkout; a subscription
 *    whose renewal failed updates its card in the billing portal instead of buying a second one;
 *  - everybody else is told whom to ask, by name;
 *  - coming back from Stripe, the page waits for the webhook, opens the app once the workspace is
 *    ACTIVE, and says plainly when confirmation is taking too long rather than spinning forever;
 *  - nobody who could renew is left at a dead end: a password an admin set is changed here first, a
 *    billing read that failed says so, and a super admin acting in another role can switch back.
 */
import { describe, expect, it } from "vitest";
import { canSwitchToSuperAdmin, contactLine, lapsedActions, lapsedPageMode, paymentWaitState, PAYMENT_WAIT_TIMEOUT_MS } from "../../src/utils/plan-lapsed";

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

  it("says billing could not be read when the read FAILED, instead of the loading state's lone export buttons", () => {
    // A failed read used to look exactly like a slow one — the export buttons and nothing to pay
    // with, forever. What fails the billing read usually fails the export too.
    expect(lapsedActions("SUPER_ADMIN", undefined, true)).toEqual({ plans: [], portal: false, exports: false, checkoutUnconfigured: false, unavailable: true });
  });
});

describe("canSwitchToSuperAdmin", () => {
  it("offers the switch to somebody who holds super admin but is acting in another role", () => {
    // Only the ACTIVE role reaches billing in GRACE, and the role switcher lives in the app shell
    // this page never mounts — so a multi-role founder acting as ADMIN was shown "ask an admin".
    expect(canSwitchToSuperAdmin({ role: "ADMIN", heldRoles: ["ADMIN", "SUPER_ADMIN"] })).toBe(true);
  });

  it("does not offer it to a super admin already acting as one, or to anyone who does not hold it", () => {
    expect(canSwitchToSuperAdmin({ role: "SUPER_ADMIN", heldRoles: ["SUPER_ADMIN", "ADMIN"] })).toBe(false);
    expect(canSwitchToSuperAdmin({ role: "MANAGER", heldRoles: ["MANAGER", "ADMIN"] })).toBe(false);
    expect(canSwitchToSuperAdmin({ role: "EMPLOYEE", heldRoles: undefined })).toBe(false);
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

  it("holds a session whose password an admin set at the change-password screen, before anything else", () => {
    // The server refuses every call this page makes (403 PASSWORD_CHANGE_REQUIRED) until it is
    // changed. A super admin arriving from the trial-ended email landed on a page whose every button
    // failed, and the screen that would have let them through is mounted only by the app shell.
    expect(lapsedPageMode(null, undefined, true)).toBe("change-password");
    expect(lapsedPageMode("success", "GRACE", true)).toBe("change-password");
    expect(lapsedPageMode(null, "GRACE", false)).toBe("lapsed");
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
