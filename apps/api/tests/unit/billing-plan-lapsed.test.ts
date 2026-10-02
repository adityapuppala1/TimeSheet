/**
 * The billing routes, as /plan-lapsed uses them for a workspace in GRACE.
 *
 *  - `GET /billing/standing` tells the page what state the workspace is in and who can renew it, so a
 *    member is told "ask Priya" rather than "ask an admin", and the page can poll it after a payment.
 *  - Every hosted Stripe page sends a LAPSED workspace back to /plan-lapsed, never into /app: the app
 *    shell's own requests are what GRACE refuses, and a 402 there navigates straight back — the loop
 *    that stopped a lapsed trial from paying. An ACTIVE workspace still returns to its settings page.
 */
import request from "supertest";
import type express from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { encryptSecret } from "../../src/utils/encryption.js";

const m = vi.hoisted(() => ({
  billingSettings: vi.fn(),
  orgFindUniqueOrThrow: vi.fn(),
  orgFindUnique: vi.fn(),
  orgUpdate: vi.fn(),
  userFindMany: vi.fn(),
  getOrgStatus: vi.fn(),
  checkoutCreate: vi.fn(),
  portalCreate: vi.fn(),
  customersCreate: vi.fn()
}));

vi.mock("stripe", () => ({
  default: class StripeStub {
    customers = { create: m.customersCreate };
    checkout = { sessions: { create: m.checkoutCreate } };
    subscriptions = { retrieve: vi.fn(), update: vi.fn() };
    billingPortal = { sessions: { create: m.portalCreate } };
    invoices = { list: vi.fn() };
  }
}));
vi.mock("../../src/config/control-prisma.js", () => ({
  controlPrisma: {
    platformBillingSettings: { findUnique: m.billingSettings },
    organization: { findUniqueOrThrow: m.orgFindUniqueOrThrow, findUnique: m.orgFindUnique, update: m.orgUpdate }
  }
}));
vi.mock("../../src/config/prisma.js", () => ({ prisma: { user: { findMany: m.userFindMany } } }));
vi.mock("../../src/config/tenant-context.js", () => ({ requireTenantContext: () => ({ orgId: "org-1", orgSlug: "acme" }) }));
vi.mock("../../src/services/seat-count.service.js", () => ({ countActiveSeats: vi.fn(async () => 12) }));
vi.mock("../../src/services/org-status.service.js", () => ({ getOrgStatus: m.getOrgStatus, forgetOrgStatus: vi.fn() }));

const actor = { id: "u-1", name: "Ada", email: "ada@acme.test", role: "SUPER_ADMIN", permissions: [] as string[] };
vi.mock("../../src/middleware/auth.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/middleware/auth.js")>("../../src/middleware/auth.js");
  return {
    ...actual,
    requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
      req.user = { ...actor, permissions: [] } as never;
      next();
    }
  };
});

const { buildBillingApp } = await import("../helpers/test-apps.js");
const ORIGIN = "https://acme.timesphere.test";

beforeEach(() => {
  vi.clearAllMocks();
  actor.role = "SUPER_ADMIN";
  m.billingSettings.mockResolvedValue({
    id: "global",
    encryptedSecretKey: encryptSecret("sk_test_fixture_not_a_real_key"),
    encryptedWebhookSigningSecret: encryptSecret("whsec_x"),
    priceIdTeam: "price_team",
    priceIdEnterprise: "price_ent"
  });
  m.orgFindUniqueOrThrow.mockResolvedValue({ id: "org-1", slug: "acme", name: "Acme", status: "GRACE", stripeCustomerId: "cus_1", stripeSubscriptionId: null, ownerEmail: "priya@acme.test" });
  m.orgFindUnique.mockResolvedValue({ ownerEmail: "priya@acme.test" });
  m.getOrgStatus.mockResolvedValue("GRACE");
  m.checkoutCreate.mockResolvedValue({ url: "https://checkout.stripe.com/c/pay/cs_1" });
  m.portalCreate.mockResolvedValue({ url: "https://billing.stripe.com/p/session/bps_1" });
  m.userFindMany.mockResolvedValue([
    { name: "Sam Lee", email: "sam@acme.test" },
    { name: "Priya Shah", email: "priya@acme.test" }
  ]);
});

describe("GET /billing/standing", () => {
  it("answers any member with the status and who can renew — the owner first", async () => {
    actor.role = "EMPLOYEE";

    const res = await request(buildBillingApp()).get("/billing/standing");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      status: "GRACE",
      contacts: [
        { name: "Priya Shah", email: "priya@acme.test" },
        { name: "Sam Lee", email: "sam@acme.test" }
      ]
    });
    // Only people who can actually renew: active, human super admins.
    expect(m.userFindMany.mock.calls[0][0].where).toMatchObject({ status: "ACTIVE", deletedAt: null, isAgent: false, role: { name: "SUPER_ADMIN" } });
  });

  it("reports the status the auth gate itself uses, so a poll that sees ACTIVE is not bounced by a stale cache", async () => {
    m.getOrgStatus.mockResolvedValue("ACTIVE");
    expect((await request(buildBillingApp()).get("/billing/standing")).body.status).toBe("ACTIVE");
    expect(m.getOrgStatus).toHaveBeenCalledWith("org-1");
  });
});

describe("where Stripe sends a lapsed workspace back to", () => {
  it("returns from Checkout to /plan-lapsed, which waits for the webhook, not into the app shell", async () => {
    const res = await request(buildBillingApp()).post("/billing/checkout-session").set("Origin", ORIGIN).send({ tier: "TEAM" });

    expect(res.status).toBe(200);
    expect(m.checkoutCreate.mock.calls[0][0]).toMatchObject({
      success_url: `${ORIGIN}/plan-lapsed?billing=success`,
      cancel_url: `${ORIGIN}/plan-lapsed?billing=cancelled`
    });
  });

  it("still returns an ACTIVE workspace (an upgrade mid-trial) to its settings page", async () => {
    m.orgFindUniqueOrThrow.mockResolvedValue({ id: "org-1", slug: "acme", name: "Acme", status: "ACTIVE", stripeCustomerId: "cus_1", stripeSubscriptionId: null });

    await request(buildBillingApp()).post("/billing/checkout-session").set("Origin", ORIGIN).send({ tier: "TEAM" });

    expect(m.checkoutCreate.mock.calls[0][0]).toMatchObject({
      success_url: `${ORIGIN}/app/settings?billing=success`,
      cancel_url: `${ORIGIN}/app/settings?billing=cancelled`
    });
  });

  it("returns from the billing portal (updating a failed card) to /plan-lapsed", async () => {
    m.orgFindUniqueOrThrow.mockResolvedValue({ status: "GRACE", stripeCustomerId: "cus_1" });

    const res = await request(buildBillingApp()).post("/billing/portal-session").set("Origin", ORIGIN);

    expect(res.status).toBe(200);
    expect(m.portalCreate.mock.calls[0][0]).toMatchObject({ customer: "cus_1", return_url: `${ORIGIN}/plan-lapsed` });
  });
});
