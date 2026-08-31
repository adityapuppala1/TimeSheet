import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { encryptSecret } from "../../src/utils/encryption.js";
import { signWebhookPayload } from "../helpers/stripe-webhook.js";
import { buildBillingWebhookApp } from "../helpers/test-apps.js";

// billing.controller.ts constructs `new Stripe(...)` inline (no injectable client), so mocking
// happens one level down: the control-plane settings lookup that supplies its constructor args.
// `stripe.webhooks.constructEvent` itself is real, local HMAC verification — no network call —
// so it's exercised for real via signWebhookPayload rather than mocked.
const { mockFindUniquePlatformBillingSettings, mockOrganizationUpdate, mockOrganizationFindUnique, mockNotifyPlanChanged, mockNotifyPaymentFailed } =
  vi.hoisted(() => ({
    mockFindUniquePlatformBillingSettings: vi.fn(),
    mockOrganizationUpdate: vi.fn(),
    mockOrganizationFindUnique: vi.fn(),
    mockNotifyPlanChanged: vi.fn(),
    mockNotifyPaymentFailed: vi.fn()
  }));

vi.mock("../../src/config/control-prisma.js", () => ({
  controlPrisma: {
    platformBillingSettings: { findUnique: mockFindUniquePlatformBillingSettings },
    organization: { update: mockOrganizationUpdate, findUnique: mockOrganizationFindUnique }
  }
}));

// The mail itself is a tenant-database round trip (withOrgTenant -> SMTP settings -> EmailLog), so
// it is stubbed here and asserted on as a decision: WHETHER a receipt goes out, and for which tier.
vi.mock("../../src/services/billing-notify.service.js", () => ({
  notifyPlanChanged: mockNotifyPlanChanged,
  notifyPaymentFailed: mockNotifyPaymentFailed
}));

const WEBHOOK_SECRET = "whsec_test_fixture_secret";
const STRIPE_SECRET_KEY = "sk_test_fixture_not_a_real_key";

function fakeBillingSettings(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "global",
    encryptedSecretKey: encryptSecret(STRIPE_SECRET_KEY),
    encryptedWebhookSigningSecret: encryptSecret(WEBHOOK_SECRET),
    priceIdTeam: "price_team_123",
    priceIdEnterprise: "price_enterprise_456",
    ...overrides
  };
}

async function postWebhook(app: ReturnType<typeof buildBillingWebhookApp>, payload: string, signature?: string) {
  const req = request(app).post("/billing/webhook").set("Content-Type", "application/json");
  if (signature) req.set("Stripe-Signature", signature);
  return req.send(payload);
}

beforeEach(() => {
  mockFindUniquePlatformBillingSettings.mockReset();
  mockOrganizationUpdate.mockReset();
  mockOrganizationFindUnique.mockReset();
  mockNotifyPlanChanged.mockReset();
  mockNotifyPaymentFailed.mockReset();
});

describe("POST /billing/webhook — signature verification", () => {
  it("rejects a request with no Stripe-Signature header", async () => {
    mockFindUniquePlatformBillingSettings.mockResolvedValue(fakeBillingSettings());
    const res = await postWebhook(buildBillingWebhookApp(), JSON.stringify({ type: "checkout.session.completed" }));
    expect(res.status).toBe(401);
  });

  it("rejects a request with a tampered signature", async () => {
    mockFindUniquePlatformBillingSettings.mockResolvedValue(fakeBillingSettings());
    const payload = JSON.stringify({ id: "evt_1", type: "checkout.session.completed", data: { object: {} } });
    const badSignature = signWebhookPayload(payload, "the-wrong-secret-entirely");
    const res = await postWebhook(buildBillingWebhookApp(), payload, badSignature);
    expect(res.status).toBe(401);
  });

  it("accepts a genuinely validly-signed request", async () => {
    mockFindUniquePlatformBillingSettings.mockResolvedValue(fakeBillingSettings());
    mockOrganizationUpdate.mockResolvedValue({});
    const payload = JSON.stringify({
      id: "evt_1",
      type: "checkout.session.completed",
      data: { object: { metadata: { organizationId: "org-1", tier: "TEAM" }, subscription: "sub_123" } }
    });
    const res = await postWebhook(buildBillingWebhookApp(), payload, signWebhookPayload(payload, WEBHOOK_SECRET));
    expect(res.status).toBe(200);
  });

  it("404s when billing isn't configured on this deployment yet", async () => {
    mockFindUniquePlatformBillingSettings.mockResolvedValue(null);
    const res = await postWebhook(buildBillingWebhookApp(), JSON.stringify({ type: "checkout.session.completed" }));
    expect(res.status).toBe(404);
  });
});

describe("POST /billing/webhook — event handling", () => {
  it("checkout.session.completed: sets Organization.planTier + stripeSubscriptionId", async () => {
    mockFindUniquePlatformBillingSettings.mockResolvedValue(fakeBillingSettings());
    mockOrganizationUpdate.mockResolvedValue({});
    const payload = JSON.stringify({
      id: "evt_1",
      type: "checkout.session.completed",
      data: { object: { metadata: { organizationId: "org-1", tier: "TEAM" }, subscription: "sub_123" } }
    });

    const res = await postWebhook(buildBillingWebhookApp(), payload, signWebhookPayload(payload, WEBHOOK_SECRET));

    expect(res.status).toBe(200);
    // PAYING ALSO ENDS THE TRIAL AND ANY GRACE STATE, which is why this write carries more than the
    // tier. Without those five fields a customer who buys on day 12 of a 15-day trial is moved to
    // GRACE by the lifecycle worker on day 15 — locked out for non-payment three days after paying.
    expect(mockOrganizationUpdate).toHaveBeenCalledWith({
      where: { id: "org-1" },
      data: {
        planTier: "TEAM",
        stripeSubscriptionId: "sub_123",
        status: "ACTIVE",
        graceStartedAt: null,
        suspendedReason: null,
        trialEndsAt: null,
        trialTier: null
      }
    });
  });

  it("checkout.session.completed: silently no-ops when metadata is missing", async () => {
    mockFindUniquePlatformBillingSettings.mockResolvedValue(fakeBillingSettings());
    const payload = JSON.stringify({ id: "evt_1", type: "checkout.session.completed", data: { object: {} } });

    const res = await postWebhook(buildBillingWebhookApp(), payload, signWebhookPayload(payload, WEBHOOK_SECRET));

    expect(res.status).toBe(200);
    expect(mockOrganizationUpdate).not.toHaveBeenCalled();
  });

  it("customer.subscription.updated: maps price -> tier and updates planTier when active", async () => {
    mockFindUniquePlatformBillingSettings.mockResolvedValue(fakeBillingSettings());
    mockOrganizationFindUnique.mockResolvedValue({ id: "org-1" });
    mockOrganizationUpdate.mockResolvedValue({});
    const payload = JSON.stringify({
      id: "evt_2",
      type: "customer.subscription.updated",
      data: { object: { id: "sub_123", status: "active", items: { data: [{ price: { id: "price_enterprise_456" } }] } } }
    });

    const res = await postWebhook(buildBillingWebhookApp(), payload, signWebhookPayload(payload, WEBHOOK_SECRET));

    expect(res.status).toBe(200);
    expect(mockOrganizationUpdate).toHaveBeenCalledWith({ where: { id: "org-1" }, data: { planTier: "ENTERPRISE" } });
  });

  it("customer.subscription.updated: does NOT update planTier when the subscription isn't active", async () => {
    mockFindUniquePlatformBillingSettings.mockResolvedValue(fakeBillingSettings());
    mockOrganizationFindUnique.mockResolvedValue({ id: "org-1" });
    const payload = JSON.stringify({
      id: "evt_2",
      type: "customer.subscription.updated",
      data: { object: { id: "sub_123", status: "past_due", items: { data: [{ price: { id: "price_enterprise_456" } }] } } }
    });

    const res = await postWebhook(buildBillingWebhookApp(), payload, signWebhookPayload(payload, WEBHOOK_SECRET));

    expect(res.status).toBe(200);
    expect(mockOrganizationUpdate).not.toHaveBeenCalled();
  });

  it("customer.subscription.deleted: resets planTier to STARTER and clears stripeSubscriptionId", async () => {
    mockFindUniquePlatformBillingSettings.mockResolvedValue(fakeBillingSettings());
    mockOrganizationFindUnique.mockResolvedValue({ id: "org-1" });
    mockOrganizationUpdate.mockResolvedValue({});
    const payload = JSON.stringify({ id: "evt_3", type: "customer.subscription.deleted", data: { object: { id: "sub_123" } } });

    const res = await postWebhook(buildBillingWebhookApp(), payload, signWebhookPayload(payload, WEBHOOK_SECRET));

    expect(res.status).toBe(200);
    expect(mockOrganizationUpdate).toHaveBeenCalledWith({
      where: { id: "org-1" },
      data: { planTier: "STARTER", stripeSubscriptionId: null }
    });
  });

  it("customer.subscription.deleted: no-ops when no Organization matches the subscription id", async () => {
    mockFindUniquePlatformBillingSettings.mockResolvedValue(fakeBillingSettings());
    mockOrganizationFindUnique.mockResolvedValue(null);
    const payload = JSON.stringify({ id: "evt_3", type: "customer.subscription.deleted", data: { object: { id: "sub_unknown" } } });

    const res = await postWebhook(buildBillingWebhookApp(), payload, signWebhookPayload(payload, WEBHOOK_SECRET));

    expect(res.status).toBe(200);
    expect(mockOrganizationUpdate).not.toHaveBeenCalled();
  });
});

/**
 * THE RECEIPT, AND THE SPAM IT MUST NOT BECOME.
 *
 * Money moving with nothing arriving in an inbox is how a legitimate charge turns into a
 * chargeback — so a real tier change sends `billing.plan_changed`. But
 * `customer.subscription.updated` is not only a plan-change event: every seat sync in
 * billing-sync.service.ts updates the quantity on the same subscription and fires it too. Sending
 * on all of them means an email per hire, which is the version of this feature people filter.
 * Both halves are pinned, because only sending the first one is very easy to do by accident.
 */
describe("POST /billing/webhook — the plan-change receipt", () => {
  it("checkout.session.completed: emails the workspace's admins the tier that was just bought", async () => {
    mockFindUniquePlatformBillingSettings.mockResolvedValue(fakeBillingSettings());
    // `update` returns the row it wrote — which is where the slug and name for the mail come from,
    // rather than a second query.
    mockOrganizationUpdate.mockResolvedValue({ id: "org-1", slug: "acme", name: "Acme Ltd" });
    const payload = JSON.stringify({
      id: "evt_10",
      type: "checkout.session.completed",
      data: { object: { metadata: { organizationId: "org-1", tier: "TEAM" }, subscription: "sub_123" } }
    });

    const res = await postWebhook(buildBillingWebhookApp(), payload, signWebhookPayload(payload, WEBHOOK_SECRET));

    expect(res.status).toBe(200);
    expect(mockNotifyPlanChanged).toHaveBeenCalledWith("acme", "Acme Ltd", "TEAM");
  });

  it("customer.subscription.updated: emails when the tier actually changed", async () => {
    mockFindUniquePlatformBillingSettings.mockResolvedValue(fakeBillingSettings());
    mockOrganizationFindUnique.mockResolvedValue({ id: "org-1", slug: "acme", name: "Acme Ltd", planTier: "TEAM" });
    mockOrganizationUpdate.mockResolvedValue({});
    const payload = JSON.stringify({
      id: "evt_11",
      type: "customer.subscription.updated",
      data: { object: { id: "sub_123", status: "active", items: { data: [{ price: { id: "price_enterprise_456" } }] } } }
    });

    const res = await postWebhook(buildBillingWebhookApp(), payload, signWebhookPayload(payload, WEBHOOK_SECRET));

    expect(res.status).toBe(200);
    expect(mockOrganizationUpdate).toHaveBeenCalledWith({ where: { id: "org-1" }, data: { planTier: "ENTERPRISE" } });
    expect(mockNotifyPlanChanged).toHaveBeenCalledWith("acme", "Acme Ltd", "ENTERPRISE");
  });

  it("customer.subscription.updated: does NOT email on a quantity-only seat sync", async () => {
    mockFindUniquePlatformBillingSettings.mockResolvedValue(fakeBillingSettings());
    // Already ENTERPRISE. This is the shape of the event billing-sync.service.ts produces every
    // time somebody is hired: same price, new quantity, tier untouched.
    mockOrganizationFindUnique.mockResolvedValue({ id: "org-1", slug: "acme", name: "Acme Ltd", planTier: "ENTERPRISE" });
    mockOrganizationUpdate.mockResolvedValue({});
    const payload = JSON.stringify({
      id: "evt_12",
      type: "customer.subscription.updated",
      data: { object: { id: "sub_123", status: "active", items: { data: [{ id: "si_1", quantity: 51, price: { id: "price_enterprise_456" } }] } } }
    });

    const res = await postWebhook(buildBillingWebhookApp(), payload, signWebhookPayload(payload, WEBHOOK_SECRET));

    expect(res.status).toBe(200);
    expect(mockNotifyPlanChanged).not.toHaveBeenCalled();
  });
});
