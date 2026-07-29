import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { encryptSecret } from "../../src/utils/encryption.js";
import { signWebhookPayload } from "../helpers/stripe-webhook.js";
import { buildBillingWebhookApp } from "../helpers/test-apps.js";

// billing.controller.ts constructs `new Stripe(...)` inline (no injectable client), so mocking
// happens one level down: the control-plane settings lookup that supplies its constructor args.
// `stripe.webhooks.constructEvent` itself is real, local HMAC verification — no network call —
// so it's exercised for real via signWebhookPayload rather than mocked.
const { mockFindUniquePlatformBillingSettings, mockOrganizationUpdate, mockOrganizationFindUnique } = vi.hoisted(() => ({
  mockFindUniquePlatformBillingSettings: vi.fn(),
  mockOrganizationUpdate: vi.fn(),
  mockOrganizationFindUnique: vi.fn()
}));

vi.mock("../../src/config/control-prisma.js", () => ({
  controlPrisma: {
    platformBillingSettings: { findUnique: mockFindUniquePlatformBillingSettings },
    organization: { update: mockOrganizationUpdate, findUnique: mockOrganizationFindUnique }
  }
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
    expect(mockOrganizationUpdate).toHaveBeenCalledWith({
      where: { id: "org-1" },
      data: { planTier: "TEAM", stripeSubscriptionId: "sub_123" }
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
