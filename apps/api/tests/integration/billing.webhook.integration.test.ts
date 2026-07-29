import request from "supertest";
import { describe, expect, it } from "vitest";
import { controlPrisma } from "../../src/config/control-prisma.js";
import { signWebhookPayload } from "../helpers/stripe-webhook.js";
import { buildBillingWebhookApp } from "../helpers/test-apps.js";

/**
 * Full end-to-end billing-webhook test against a real throwaway control-plane database (see
 * tests/setup/global-setup.integration.ts, which seeds PlatformBillingSettings + one
 * Organization with stripeSubscriptionId "sub_existing_123") — no mocking of `controlPrisma` at
 * all, unlike the unit tier. This is where "the webhook really persists Organization.planTier"
 * gets verified against a real row, not a mock assertion.
 */

const WEBHOOK_SECRET = "whsec_test_fixture_secret";

describe("Stripe billing webhook — real database", () => {
  it("checkout.session.completed really updates Organization.planTier + stripeSubscriptionId", async () => {
    const org = await controlPrisma.organization.create({
      data: { name: "Fresh Checkout Org", slug: "fresh-checkout-org", status: "ACTIVE", planTier: "STARTER" }
    });

    const payload = JSON.stringify({
      id: "evt_int_1",
      type: "checkout.session.completed",
      data: { object: { metadata: { organizationId: org.id, tier: "ENTERPRISE" }, subscription: "sub_new_from_checkout" } }
    });

    const res = await request(buildBillingWebhookApp())
      .post("/billing/webhook")
      .set("Content-Type", "application/json")
      .set("Stripe-Signature", signWebhookPayload(payload, WEBHOOK_SECRET))
      .send(payload);

    expect(res.status).toBe(200);
    const reloaded = await controlPrisma.organization.findUniqueOrThrow({ where: { id: org.id } });
    expect(reloaded.planTier).toBe("ENTERPRISE");
    expect(reloaded.stripeSubscriptionId).toBe("sub_new_from_checkout");
  });

  it("customer.subscription.deleted really resets an existing Organization to STARTER", async () => {
    const payload = JSON.stringify({
      id: "evt_int_2",
      type: "customer.subscription.deleted",
      data: { object: { id: "sub_existing_123" } }
    });

    const res = await request(buildBillingWebhookApp())
      .post("/billing/webhook")
      .set("Content-Type", "application/json")
      .set("Stripe-Signature", signWebhookPayload(payload, WEBHOOK_SECRET))
      .send(payload);

    expect(res.status).toBe(200);
    const reloaded = await controlPrisma.organization.findUniqueOrThrow({ where: { id: "org-billing-test" } });
    expect(reloaded.planTier).toBe("STARTER");
    expect(reloaded.stripeSubscriptionId).toBeNull();
  });
});
