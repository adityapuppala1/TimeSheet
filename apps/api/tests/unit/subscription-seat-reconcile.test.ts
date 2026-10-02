/**
 * The nightly backstop for the billed seat count.
 *
 * WHY IT EXISTS. `syncSubscriptionSeats` runs after each user-lifecycle change, but "each change"
 * is a list somebody has to keep complete — it was three paths long until 2026-10, and first sign-in
 * through SSO still creates accounts without calling it. billing.controller.ts already TOLD readers
 * the count was "reconciled nightly"; nothing did it. This sweep makes that sentence true: once a
 * night, every subscribed workspace's Stripe quantity is brought to its real active-seat count.
 *
 * WHAT IT MUST NOT DO: write when nothing changed (Stripe sends a webhook per update), let one
 * unreachable workspace cost the others their sync, or touch a workspace with no subscription.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { encryptSecret } from "../../src/utils/encryption.js";

interface Org {
  id: string;
  slug: string;
  stripeSubscriptionId: string | null;
  status: string;
  database: { encryptedDsn: string } | null;
}

const { control, retrieve, update, getTenantClient, stripe } = vi.hoisted(() => {
  const retrieve = vi.fn();
  const update = vi.fn();
  return {
    control: { organization: { findMany: vi.fn(), findUnique: vi.fn() } },
    retrieve,
    update,
    getTenantClient: vi.fn(),
    stripe: { configured: true }
  };
});

vi.mock("../../src/config/control-prisma.js", () => ({ controlPrisma: control }));
vi.mock("../../src/services/stripe-client.service.js", () => ({
  resolveStripeClient: vi.fn(async () =>
    stripe.configured ? { stripe: { subscriptions: { retrieve, update } }, settings: { priceIdTeam: "price_team", priceIdEnterprise: "price_enterprise" } } : null
  )
}));
vi.mock("../../src/config/prisma.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getTenantClient
}));

const { reconcileSubscriptionSeats } = await import("../../src/services/billing-sync.service.js");

const db = () => ({ encryptedDsn: encryptSecret("mysql://unused-since-getTenantClient-is-mocked") });

/** Each workspace's tenant database, reduced to the one number the sweep reads. */
const activeSeatsByOrg: Record<string, number> = {};
/** What Stripe currently bills, per subscription. */
const quantityBySubscription: Record<string, number> = {};

function setUp(orgs: Org[]) {
  control.organization.findMany.mockResolvedValue(orgs);
  control.organization.findUnique.mockImplementation(async ({ where }: { where: { id: string } }) => orgs.find((o) => o.id === where.id) ?? null);
}

beforeEach(() => {
  stripe.configured = true;
  for (const key of Object.keys(activeSeatsByOrg)) delete activeSeatsByOrg[key];
  for (const key of Object.keys(quantityBySubscription)) delete quantityBySubscription[key];
  control.organization.findMany.mockReset();
  control.organization.findUnique.mockReset();
  getTenantClient.mockReset().mockImplementation(async (orgId: string) => ({ user: { count: vi.fn(async () => activeSeatsByOrg[orgId]) } }) as unknown as PrismaClient);
  retrieve.mockReset().mockImplementation(async (id: string) => {
    if (!(id in quantityBySubscription)) throw new Error(`No such subscription: ${id}`);
    // One line, at the Team price — the shape Checkout creates.
    return { items: { data: [{ id: `item-${id}`, quantity: quantityBySubscription[id], price: { id: "price_team" } }] } };
  });
  update.mockReset().mockResolvedValue({});
});

describe("reconcileSubscriptionSeats", () => {
  it("sets each subscribed workspace's Stripe quantity to its active-seat count, without proration", async () => {
    setUp([{ id: "acme", slug: "acme", stripeSubscriptionId: "sub_acme", status: "ACTIVE", database: db() }]);
    activeSeatsByOrg.acme = 30;
    quantityBySubscription.sub_acme = 50; // twenty people left; nothing told Stripe

    const result = await reconcileSubscriptionSeats();

    expect(update).toHaveBeenCalledWith("sub_acme", { items: [{ id: "item-sub_acme", quantity: 30 }], proration_behavior: "none" });
    expect(result).toEqual(expect.objectContaining({ configured: true, attempted: 1, updated: 1, failed: [] }));
  });

  it("does not write when Stripe already bills the right number", async () => {
    setUp([{ id: "acme", slug: "acme", stripeSubscriptionId: "sub_acme", status: "ACTIVE", database: db() }]);
    activeSeatsByOrg.acme = 12;
    quantityBySubscription.sub_acme = 12;

    const result = await reconcileSubscriptionSeats();

    expect(update).not.toHaveBeenCalled();
    expect(result.updated).toBe(0);
  });

  it("asks only for subscribed workspaces that are ACTIVE or in GRACE", async () => {
    setUp([]);
    await reconcileSubscriptionSeats();
    expect(control.organization.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { stripeSubscriptionId: { not: null }, status: { in: ["ACTIVE", "GRACE"] } } })
    );
  });

  it("names a workspace it could not reach and carries on with the rest", async () => {
    setUp([
      { id: "broken", slug: "broken", stripeSubscriptionId: "sub_broken", status: "ACTIVE", database: db() },
      { id: "gone", slug: "gone", stripeSubscriptionId: "sub_missing", status: "ACTIVE", database: db() },
      { id: "acme", slug: "acme", stripeSubscriptionId: "sub_acme", status: "GRACE", database: db() }
    ]);
    getTenantClient.mockImplementation(async (orgId: string) => {
      if (orgId === "broken") throw new Error("connect ECONNREFUSED");
      return { user: { count: vi.fn(async () => activeSeatsByOrg[orgId]) } } as unknown as PrismaClient;
    });
    activeSeatsByOrg.gone = 4;
    activeSeatsByOrg.acme = 7;
    quantityBySubscription.sub_acme = 9;

    const result = await reconcileSubscriptionSeats();

    expect(result.failed.map((f) => f.slug)).toEqual(["broken", "gone"]);
    expect(result.failed[1].message).toMatch(/No such subscription/);
    expect(update).toHaveBeenCalledWith("sub_acme", expect.objectContaining({ items: [{ id: "item-sub_acme", quantity: 7 }] }));
  });

  it("skips a subscribed workspace that has no database yet rather than failing it", async () => {
    setUp([{ id: "new", slug: "new", stripeSubscriptionId: "sub_new", status: "ACTIVE", database: null }]);
    const result = await reconcileSubscriptionSeats();
    expect(getTenantClient).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({ attempted: 0, failed: [] }));
  });

  it("does nothing at all on a deployment with no Stripe configured", async () => {
    stripe.configured = false;
    const result = await reconcileSubscriptionSeats();
    expect(result.configured).toBe(false);
    expect(control.organization.findMany).not.toHaveBeenCalled();
  });
});

/**
 * WHICH LINE IS THE SEAT LINE. Checkout creates one line, but an operator can build a subscription
 * by hand in the Stripe dashboard — an add-on, a setup fee, committed seats — and Stripe lists lines
 * in no promised order. Writing `items.data[0]` set whatever line came first to the headcount, every
 * night. The seat line is the one priced at this deployment's Team or Enterprise price; with none, or
 * more than one, there is no right answer to write, so the workspace is skipped and named.
 */
describe("the subscription line the seat count is written to", () => {
  const acme = { id: "acme", slug: "acme", stripeSubscriptionId: "sub_acme", status: "ACTIVE", database: db() };
  const lines = (...items: Array<{ id: string; quantity: number; price: string }>) =>
    retrieve.mockResolvedValue({ items: { data: items.map((item) => ({ id: item.id, quantity: item.quantity, price: { id: item.price } })) } });

  it("is the line priced at a tier price, wherever Stripe lists it", async () => {
    setUp([acme]);
    activeSeatsByOrg.acme = 30;
    lines({ id: "si_setup_fee", quantity: 1, price: "price_onboarding" }, { id: "si_seats", quantity: 50, price: "price_enterprise" });

    await reconcileSubscriptionSeats();

    expect(update).toHaveBeenCalledWith("sub_acme", { items: [{ id: "si_seats", quantity: 30 }], proration_behavior: "none" });
  });

  it("skips and names a workspace whose subscription has no line at a tier price", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    setUp([acme]);
    activeSeatsByOrg.acme = 30;
    lines({ id: "si_committed", quantity: 100, price: "price_committed_seats" });

    await reconcileSubscriptionSeats();

    expect(update).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/acme.*no line/));
  });

  it("skips and names a workspace whose subscription has more than one line at a tier price", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    setUp([acme]);
    activeSeatsByOrg.acme = 30;
    lines({ id: "si_team", quantity: 10, price: "price_team" }, { id: "si_enterprise", quantity: 20, price: "price_enterprise" });

    await reconcileSubscriptionSeats();

    expect(update).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/acme.*2 lines/));
  });
});

describe("the nightly billing pass", () => {
  it("syncs seat quantities BEFORE reading billed revenue, and a failed seat sweep does not cost the night its revenue figures", async () => {
    vi.resetModules();
    const order: string[] = [];
    vi.doMock("../../src/services/billing-sync.service.js", () => ({
      reconcileSubscriptionSeats: vi.fn(async () => {
        order.push("seats");
        throw new Error("control plane unreachable");
      })
    }));
    vi.doMock("../../src/services/platform-billing-reconcile.service.js", () => ({
      reconcileBilledRevenue: vi.fn(async () => {
        order.push("revenue");
        return { configured: true, attempted: 0, reconciled: 0, failed: [], at: "" };
      })
    }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { runNightlyBillingReconcile } = await import("../../src/workers/billed-revenue-reconcile.worker.js");

    await runNightlyBillingReconcile();

    expect(order).toEqual(["seats", "revenue"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("[billed-seats] pass failed"));
    vi.doUnmock("../../src/services/billing-sync.service.js");
    vi.doUnmock("../../src/services/platform-billing-reconcile.service.js");
  });
});
