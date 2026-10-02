/**
 * DUNNING, end to end through the webhook: a renewal fails, the workspace lapses, and paying brings
 * it back — including after the grace window ran out and the lifecycle worker suspended it.
 *
 * THE BUG. `invoice.paid` restored a workspace only from GRACE. A subscribed workspace whose renewal
 * failed went to GRACE on day 0 and was SUSPENDED by the worker on day 14; when Stripe's next retry
 * succeeded on day 16 (or the customer paid the hosted invoice), the event was ignored. The customer
 * was being charged for a workspace that no longer resolved, and could not sign in to say so.
 *
 * THE LINE IT MUST NOT CROSS. An operator's suspension is a decision — fraud, a contract dispute,
 * a legal hold — and a payment arriving must never undo it. So restoring from SUSPENDED needs the
 * marker only the webhook writes (`nonPaymentSubscriptionId`), naming THIS subscription; the
 * free-text `suspendedReason`, which an operator can type anything into, is not evidence.
 */
import request from "supertest";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { encryptSecret } from "../../src/utils/encryption.js";
import { signWebhookPayload } from "../helpers/stripe-webhook.js";
import { buildBillingWebhookApp } from "../helpers/test-apps.js";

const { mockFindUniquePlatformBillingSettings, mockOrganizationUpdate, mockOrganizationFindUnique, mockForgetOrgStatus } = vi.hoisted(() => ({
  mockFindUniquePlatformBillingSettings: vi.fn(),
  mockOrganizationUpdate: vi.fn(),
  mockOrganizationFindUnique: vi.fn(),
  mockForgetOrgStatus: vi.fn()
}));

vi.mock("../../src/config/control-prisma.js", () => ({
  controlPrisma: {
    platformBillingSettings: { findUnique: mockFindUniquePlatformBillingSettings },
    organization: { update: mockOrganizationUpdate, findUnique: mockOrganizationFindUnique }
  }
}));
vi.mock("../../src/services/billing-notify.service.js", () => ({ notifyPlanChanged: vi.fn(), notifyPaymentFailed: vi.fn() }));
vi.mock("../../src/services/org-status.service.js", () => ({ forgetOrgStatus: mockForgetOrgStatus }));

const WEBHOOK_SECRET = "whsec_test_fixture_secret";

function fakeBillingSettings() {
  return {
    id: "global",
    encryptedSecretKey: encryptSecret("sk_test_fixture_not_a_real_key"),
    encryptedWebhookSigningSecret: encryptSecret(WEBHOOK_SECRET),
    priceIdTeam: "price_team_123",
    priceIdEnterprise: "price_enterprise_456"
  };
}

/** An invoice event in the shape current Stripe API versions send. */
function invoiceEvent(type: "invoice.paid" | "invoice.payment_failed", subscription = "sub_123") {
  return JSON.stringify({ id: "evt_inv", type, data: { object: { id: "in_1", parent: { subscription_details: { subscription } } } } });
}

const post = (payload: string) =>
  request(buildBillingWebhookApp()).post("/billing/webhook").set("Content-Type", "application/json").set("Stripe-Signature", signWebhookPayload(payload, WEBHOOK_SECRET)).send(payload);

function org(overrides: Record<string, unknown> = {}) {
  return { id: "org-1", slug: "acme", name: "Acme", status: "ACTIVE", stripeSubscriptionId: "sub_123", nonPaymentSubscriptionId: null, suspendedReason: null, ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFindUniquePlatformBillingSettings.mockResolvedValue(fakeBillingSettings());
  mockOrganizationUpdate.mockResolvedValue({});
});

describe("invoice.payment_failed", () => {
  it("lapses the workspace AND records which subscription went unpaid", async () => {
    mockOrganizationFindUnique.mockResolvedValue(org());

    expect((await post(invoiceEvent("invoice.payment_failed"))).status).toBe(200);

    expect(mockOrganizationUpdate).toHaveBeenCalledWith({
      where: { id: "org-1" },
      data: expect.objectContaining({ status: "GRACE", nonPaymentSubscriptionId: "sub_123" })
    });
  });
});

describe("invoice.paid", () => {
  const restored = {
    status: "ACTIVE",
    graceStartedAt: null,
    suspendedAt: null,
    suspendedReason: null,
    nonPaymentSubscriptionId: null
  };

  it("restores a workspace still in GRACE for this subscription", async () => {
    mockOrganizationFindUnique.mockResolvedValue(org({ status: "GRACE", nonPaymentSubscriptionId: "sub_123", suspendedReason: "A renewal payment failed." }));

    await post(invoiceEvent("invoice.paid"));

    expect(mockOrganizationUpdate).toHaveBeenCalledWith({ where: { id: "org-1" }, data: restored });
    expect(mockForgetOrgStatus).toHaveBeenCalledWith("org-1");
  });

  it("restores a workspace the worker SUSPENDED for not paying this subscription", async () => {
    // Day 16: the grace window ran out on day 14, and now Stripe's retry has succeeded.
    mockOrganizationFindUnique.mockResolvedValue(
      org({ status: "SUSPENDED", nonPaymentSubscriptionId: "sub_123", suspendedReason: "A renewal payment failed.", suspendedAt: new Date() })
    );

    expect((await post(invoiceEvent("invoice.paid"))).status).toBe(200);

    expect(mockOrganizationUpdate).toHaveBeenCalledWith({ where: { id: "org-1" }, data: restored });
    expect(mockForgetOrgStatus).toHaveBeenCalledWith("org-1");
  });

  it("never lifts an operator's suspension, whatever its reason text says", async () => {
    // The console pre-fills the reason, so an operator suspending a non-payer by hand saves this exact
    // sentence. Without the webhook's marker it is an operator's decision, and a payment does not undo it.
    mockOrganizationFindUnique.mockResolvedValue(org({ status: "SUSPENDED", nonPaymentSubscriptionId: null, suspendedReason: "A renewal payment failed." }));

    expect((await post(invoiceEvent("invoice.paid"))).status).toBe(200);

    expect(mockOrganizationUpdate).not.toHaveBeenCalled();
  });

  it("does not restore a suspension for a different subscription's non-payment", async () => {
    mockOrganizationFindUnique.mockResolvedValue(org({ status: "SUSPENDED", stripeSubscriptionId: "sub_123", nonPaymentSubscriptionId: "sub_old" }));

    await post(invoiceEvent("invoice.paid"));

    expect(mockOrganizationUpdate).not.toHaveBeenCalled();
  });

  it("leaves an ACTIVE workspace alone — a routine renewal is not a restoration", async () => {
    mockOrganizationFindUnique.mockResolvedValue(org());
    await post(invoiceEvent("invoice.paid"));
    expect(mockOrganizationUpdate).not.toHaveBeenCalled();
  });
});
