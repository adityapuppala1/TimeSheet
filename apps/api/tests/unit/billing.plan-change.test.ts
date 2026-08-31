/**
 * THE DOUBLE-SUBSCRIPTION REGRESSION, and the two routes that grew out of fixing it.
 *
 * `POST /billing/checkout-session` used to open a Stripe Checkout session unconditionally. The
 * webhook then overwrote `Organization.stripeSubscriptionId` with whatever that session created —
 * so a paying TEAM customer who pressed "Upgrade to Enterprise" ended up with TWO active
 * subscriptions on one Stripe customer, was billed for both, and the older one kept renewing
 * forever with nothing in this product pointing at it. No error was raised anywhere; the customer's
 * card statement was the only place it showed.
 *
 * The first describe below is the regression test: it fails the moment the existing-subscription
 * branch is removed. The rest pin the fallbacks around it (a stored id Stripe no longer honours
 * must never dead-end the customer), the architectural rule the fix had to preserve (the tier is
 * written by the WEBHOOK, never by this route), and the two read-only surfaces added alongside.
 *
 * The Stripe SDK is mocked here, unlike in billing.webhook.test.ts — there the interesting code was
 * the local HMAC check, which is worth running for real; here every interesting decision is about
 * WHICH Stripe call is made, which is exactly what a mock can answer and a real client cannot.
 */
import request from "supertest";
import type express from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { encryptSecret } from "../../src/utils/encryption.js";

const {
  mockBillingSettingsFindUnique,
  mockOrganizationFindUniqueOrThrow,
  mockOrganizationUpdate,
  mockCountActiveSeats,
  mockCustomersCreate,
  mockCheckoutSessionsCreate,
  mockSubscriptionsRetrieve,
  mockSubscriptionsUpdate,
  mockPortalSessionsCreate,
  mockInvoicesList
} = vi.hoisted(() => ({
  mockBillingSettingsFindUnique: vi.fn(),
  mockOrganizationFindUniqueOrThrow: vi.fn(),
  mockOrganizationUpdate: vi.fn(),
  mockCountActiveSeats: vi.fn(),
  mockCustomersCreate: vi.fn(),
  mockCheckoutSessionsCreate: vi.fn(),
  mockSubscriptionsRetrieve: vi.fn(),
  mockSubscriptionsUpdate: vi.fn(),
  mockPortalSessionsCreate: vi.fn(),
  mockInvoicesList: vi.fn()
}));

/** The controller does `new Stripe(key)` inline with no injectable client, so the CONSTRUCTOR is
 *  what gets replaced — a real class rather than a `vi.fn`, because `new` on an arrow-function mock
 *  is not constructible. Only the five surfaces these routes touch are stubbed; anything else
 *  reaching for Stripe here should fail loudly rather than silently return undefined. */
vi.mock("stripe", () => ({
  default: class StripeStub {
    customers = { create: mockCustomersCreate };
    checkout = { sessions: { create: mockCheckoutSessionsCreate } };
    subscriptions = { retrieve: mockSubscriptionsRetrieve, update: mockSubscriptionsUpdate };
    billingPortal = { sessions: { create: mockPortalSessionsCreate } };
    invoices = { list: mockInvoicesList };
  }
}));

vi.mock("../../src/config/control-prisma.js", () => ({
  controlPrisma: {
    platformBillingSettings: { findUnique: mockBillingSettingsFindUnique },
    organization: { findUniqueOrThrow: mockOrganizationFindUniqueOrThrow, update: mockOrganizationUpdate, findUnique: vi.fn() }
  }
}));

vi.mock("../../src/config/tenant-context.js", () => ({
  requireTenantContext: () => ({ orgId: "org-1", orgSlug: "acme" })
}));

// Seat counting is a tenant-database query. The NUMBER is what matters to these tests: it has to
// reach Stripe on both paths, which is the bug that preceded this one (`quantity: 1` for a
// fifty-person workspace).
vi.mock("../../src/services/seat-count.service.js", () => ({ countActiveSeats: mockCountActiveSeats }));

/**
 * `requireAuth` is replaced — it verifies a JWT against a Session row in a tenant database, which
 * is a different subject entirely. `requireSuperAdmin` is deliberately left REAL: it reads
 * `req.user.role`, and stubbing it would let every test below pass by skipping authorization.
 */
const actor = { id: "u-1", name: "Admin", email: "a@x.io", role: "SUPER_ADMIN", permissions: [] as string[] };
vi.mock("../../src/middleware/auth.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/middleware/auth.js")>("../../src/middleware/auth.js");
  return {
    ...actual,
    requireAuth: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
      req.user = { ...actor, permissions: [...actor.permissions] } as never;
      next();
    }
  };
});

const { buildBillingApp } = await import("../helpers/test-apps.js");

const STRIPE_SECRET_KEY = "sk_test_fixture_not_a_real_key";
const PRICE_TEAM = "price_team_123";
const PRICE_ENTERPRISE = "price_enterprise_456";

function fakeBillingSettings() {
  return {
    id: "global",
    encryptedSecretKey: encryptSecret(STRIPE_SECRET_KEY),
    encryptedWebhookSigningSecret: encryptSecret("whsec_test_fixture_secret"),
    priceIdTeam: PRICE_TEAM,
    priceIdEnterprise: PRICE_ENTERPRISE
  };
}

/** An org row as `findUniqueOrThrow` returns it. `stripeSubscriptionId` is the single field that
 *  decides which of the two plan-change paths runs. */
function fakeOrg(overrides: Record<string, unknown> = {}) {
  return {
    id: "org-1",
    slug: "acme",
    name: "Acme Ltd",
    planTier: "TEAM",
    stripeCustomerId: "cus_123",
    stripeSubscriptionId: null,
    ...overrides
  };
}

/** What `subscriptions.retrieve` answers for a healthy subscription with one line item. */
function liveSubscription(status = "active") {
  return { id: "sub_existing", status, items: { data: [{ id: "si_existing", quantity: 10, price: { id: PRICE_TEAM } }] } };
}

/** Stripe's shape for "that id doesn't exist here". Thrown, not returned. */
function missingResourceError() {
  return Object.assign(new Error("No such subscription: 'sub_existing'"), { statusCode: 404, code: "resource_missing" });
}

const upgrade = (tier = "ENTERPRISE") => request(buildBillingApp()).post("/billing/checkout-session").send({ tier });

beforeEach(() => {
  vi.clearAllMocks();
  actor.role = "SUPER_ADMIN";
  mockBillingSettingsFindUnique.mockResolvedValue(fakeBillingSettings());
  mockOrganizationFindUniqueOrThrow.mockResolvedValue(fakeOrg());
  mockOrganizationUpdate.mockResolvedValue({});
  mockCountActiveSeats.mockResolvedValue(37);
  mockCheckoutSessionsCreate.mockResolvedValue({ id: "cs_1", url: "https://checkout.stripe.com/c/pay/cs_1" });
  mockSubscriptionsRetrieve.mockResolvedValue(liveSubscription());
  mockSubscriptionsUpdate.mockResolvedValue({ id: "sub_existing" });
  mockPortalSessionsCreate.mockResolvedValue({ id: "bps_1", url: "https://billing.stripe.com/p/session/bps_1" });
  mockInvoicesList.mockResolvedValue({ data: [] });
});

describe("POST /billing/checkout-session — an org that already pays is never sent to Checkout again", () => {
  it("changes the EXISTING subscription in place and opens no Checkout session at all", async () => {
    mockOrganizationFindUniqueOrThrow.mockResolvedValue(fakeOrg({ stripeSubscriptionId: "sub_existing" }));

    const res = await upgrade("ENTERPRISE");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ mode: "updated" });
    // THE REGRESSION. A second Checkout here is a second subscription on the same customer, and
    // the webhook would then point the database at it and abandon the one still being billed.
    expect(mockCheckoutSessionsCreate).not.toHaveBeenCalled();
    expect(mockSubscriptionsUpdate).toHaveBeenCalledTimes(1);
  });

  it("swaps the price on the line item the customer already has, rather than adding a second one", async () => {
    mockOrganizationFindUniqueOrThrow.mockResolvedValue(fakeOrg({ stripeSubscriptionId: "sub_existing" }));

    await upgrade("ENTERPRISE");

    expect(mockSubscriptionsUpdate).toHaveBeenCalledWith("sub_existing", {
      // Without `id`, Stripe APPENDS a line and the customer is billed for both plans — the same
      // double-billing this route exists to prevent, one level down.
      items: [{ id: "si_existing", price: PRICE_ENTERPRISE, quantity: 37 }],
      // A mid-cycle move must credit the unused time on the old plan. `none` would silently give
      // away the difference; `always_invoice` would charge for it on the spot.
      proration_behavior: "create_prorations"
    });
  });

  it("carries the CURRENT seat count, so a workspace that grew since it subscribed isn't billed for its old headcount", async () => {
    mockOrganizationFindUniqueOrThrow.mockResolvedValue(fakeOrg({ stripeSubscriptionId: "sub_existing" }));
    mockCountActiveSeats.mockResolvedValue(112);

    await upgrade("ENTERPRISE");

    expect(mockSubscriptionsUpdate.mock.calls[0][1].items[0].quantity).toBe(112);
  });

  it("does NOT write planTier — the webhook is still the only writer", async () => {
    mockOrganizationFindUniqueOrThrow.mockResolvedValue(fakeOrg({ stripeSubscriptionId: "sub_existing" }));

    await upgrade("ENTERPRISE");

    // The in-place update fires `customer.subscription.updated`, which the webhook maps back to a
    // tier. Writing it here as well would mean two writers and a tab closed mid-flow could leave
    // planTier disagreeing with what Stripe actually charges.
    const tierWrites = mockOrganizationUpdate.mock.calls.filter((call) => "planTier" in (call[0]?.data ?? {}));
    expect(tierWrites).toEqual([]);
  });

  it("still updates in place when the subscription is unhealthy but alive (past_due)", async () => {
    // A card that failed is a billing problem, not a reason to sell them a second subscription.
    mockOrganizationFindUniqueOrThrow.mockResolvedValue(fakeOrg({ stripeSubscriptionId: "sub_existing" }));
    mockSubscriptionsRetrieve.mockResolvedValue(liveSubscription("past_due"));

    const res = await upgrade("ENTERPRISE");

    expect(res.body).toEqual({ mode: "updated" });
    expect(mockCheckoutSessionsCreate).not.toHaveBeenCalled();
  });
});

describe("POST /billing/checkout-session — an org with no subscription still gets Checkout", () => {
  it("returns a hosted Checkout URL and touches no subscription", async () => {
    const res = await upgrade("ENTERPRISE");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ mode: "checkout", url: "https://checkout.stripe.com/c/pay/cs_1" });
    expect(mockSubscriptionsUpdate).not.toHaveBeenCalled();
    expect(mockSubscriptionsRetrieve).not.toHaveBeenCalled();
  });

  it("bills the seat count, not one seat", async () => {
    await upgrade("TEAM");

    expect(mockCheckoutSessionsCreate.mock.calls[0][0].line_items).toEqual([{ price: PRICE_TEAM, quantity: 37 }]);
  });

  it("creates the Stripe customer first when the org has never had one", async () => {
    mockOrganizationFindUniqueOrThrow.mockResolvedValue(fakeOrg({ stripeCustomerId: null }));
    mockCustomersCreate.mockResolvedValue({ id: "cus_new" });

    const res = await upgrade("TEAM");

    expect(res.status).toBe(200);
    expect(mockCustomersCreate).toHaveBeenCalledTimes(1);
    expect(mockOrganizationUpdate).toHaveBeenCalledWith({ where: { id: "org-1" }, data: { stripeCustomerId: "cus_new" } });
  });

  it("503s when no Price is configured for the requested tier", async () => {
    mockBillingSettingsFindUnique.mockResolvedValue({ ...fakeBillingSettings(), priceIdEnterprise: null });

    const res = await upgrade("ENTERPRISE");

    expect(res.status).toBe(503);
    expect(mockCheckoutSessionsCreate).not.toHaveBeenCalled();
  });
});

describe("POST /billing/checkout-session — a stale stored subscription id never dead-ends the customer", () => {
  it("falls back to Checkout and clears the column when Stripe says the subscription is cancelled", async () => {
    mockOrganizationFindUniqueOrThrow.mockResolvedValue(fakeOrg({ stripeSubscriptionId: "sub_existing" }));
    mockSubscriptionsRetrieve.mockResolvedValue(liveSubscription("canceled"));

    const res = await upgrade("ENTERPRISE");

    expect(res.body).toEqual({ mode: "checkout", url: "https://checkout.stripe.com/c/pay/cs_1" });
    expect(mockSubscriptionsUpdate).not.toHaveBeenCalled();
    // Cleared BEFORE the new Checkout, so the webhook that lands afterwards writes into an empty
    // column rather than appearing to overwrite a live subscription.
    expect(mockOrganizationUpdate).toHaveBeenCalledWith({ where: { id: "org-1" }, data: { stripeSubscriptionId: null } });
  });

  it("falls back to Checkout when Stripe 404s the stored id (dashboard cancel, restored snapshot, key swap)", async () => {
    mockOrganizationFindUniqueOrThrow.mockResolvedValue(fakeOrg({ stripeSubscriptionId: "sub_existing" }));
    mockSubscriptionsRetrieve.mockRejectedValue(missingResourceError());

    const res = await upgrade("ENTERPRISE");

    expect(res.status).toBe(200);
    expect(res.body.mode).toBe("checkout");
    expect(mockOrganizationUpdate).toHaveBeenCalledWith({ where: { id: "org-1" }, data: { stripeSubscriptionId: null } });
  });

  it("does NOT treat a transient Stripe failure as a missing subscription", async () => {
    // The repair for "gone" is to create a second subscription. Doing that to a customer whose
    // subscription was merely unreachable for a second is the original bug wearing a disguise, so
    // anything that isn't a genuine missing-resource answer has to surface as an error instead.
    mockOrganizationFindUniqueOrThrow.mockResolvedValue(fakeOrg({ stripeSubscriptionId: "sub_existing" }));
    mockSubscriptionsRetrieve.mockRejectedValue(Object.assign(new Error("Stripe is down"), { statusCode: 503 }));

    const res = await upgrade("ENTERPRISE");

    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(mockCheckoutSessionsCreate).not.toHaveBeenCalled();
  });
});

describe("POST /billing/portal-session", () => {
  it("returns Stripe's hosted portal URL", async () => {
    const res = await request(buildBillingApp()).post("/billing/portal-session");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ url: "https://billing.stripe.com/p/session/bps_1" });
    expect(mockPortalSessionsCreate.mock.calls[0][0].customer).toBe("cus_123");
  });

  it("4xx's with a message that names the fix when the workspace has no Stripe customer", async () => {
    mockOrganizationFindUniqueOrThrow.mockResolvedValue(fakeOrg({ stripeCustomerId: null }));

    const res = await request(buildBillingApp()).post("/billing/portal-session");

    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/plan/i);
    // And no pointless round trip to Stripe for a customer that cannot exist.
    expect(mockPortalSessionsCreate).not.toHaveBeenCalled();
  });

  it("is closed to anyone who is not a super admin", async () => {
    actor.role = "MANAGER";

    const res = await request(buildBillingApp()).post("/billing/portal-session");

    expect(res.status).toBe(403);
    expect(mockPortalSessionsCreate).not.toHaveBeenCalled();
  });
});

describe("GET /billing/invoices", () => {
  it("answers [] without calling Stripe when the workspace has never been billed", async () => {
    mockOrganizationFindUniqueOrThrow.mockResolvedValue(fakeOrg({ stripeCustomerId: null }));

    const res = await request(buildBillingApp()).get("/billing/invoices");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
    expect(mockInvoicesList).not.toHaveBeenCalled();
  });

  it("projects Stripe's invoice down to the fields a billing card shows, and leaks nothing else", async () => {
    mockInvoicesList.mockResolvedValue({
      data: [
        {
          id: "in_1",
          number: "ACME-0001",
          created: 1_767_225_600,
          amount_paid: 29_600,
          amount_due: 29_600,
          currency: "usd",
          status: "paid",
          hosted_invoice_url: "https://invoice.stripe.com/i/in_1",
          invoice_pdf: "https://invoice.stripe.com/i/in_1.pdf",
          // Everything below is real Stripe payload that must NOT reach the browser.
          customer_address: { line1: "1 Somewhere St", postal_code: "94105" },
          customer_tax_ids: [{ type: "eu_vat", value: "DE123456789" }],
          payment_intent: "pi_secret_1"
        }
      ]
    });

    const res = await request(buildBillingApp()).get("/billing/invoices");

    expect(res.status).toBe(200);
    expect(res.body).toEqual([
      {
        id: "in_1",
        number: "ACME-0001",
        created: new Date(1_767_225_600 * 1000).toISOString(),
        amountPaid: 29_600,
        amountDue: 29_600,
        currency: "usd",
        status: "paid",
        hostedInvoiceUrl: "https://invoice.stripe.com/i/in_1",
        invoicePdf: "https://invoice.stripe.com/i/in_1.pdf"
      }
    ]);
    // Belt and braces: the exact-equality above already proves it, but this is the sentence that
    // explains why anyone would care if it ever changes.
    expect(JSON.stringify(res.body)).not.toContain("customer_tax_ids");
    expect(JSON.stringify(res.body)).not.toContain("pi_secret_1");
  });

  it("asks for a bounded page — an invoice list is a settings card, not an export", async () => {
    await request(buildBillingApp()).get("/billing/invoices");

    expect(mockInvoicesList).toHaveBeenCalledWith({ customer: "cus_123", limit: 12 });
  });

  it("is closed to anyone who is not a super admin", async () => {
    actor.role = "EMPLOYEE";

    const res = await request(buildBillingApp()).get("/billing/invoices");

    expect(res.status).toBe(403);
    expect(mockInvoicesList).not.toHaveBeenCalled();
  });
});
