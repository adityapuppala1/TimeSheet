/**
 * M6 — the Stripe credentials every customer's payments go through could be swapped by one BILLING
 * operator with no reason given and nobody told. The route's own comment called it "the single most
 * valuable thing anybody could do from this console".
 *
 * Now a change to PATCH /billing-settings needs a written reason (on the audit row like any other),
 * and replacing the secret key or the webhook signing secret emails every active OWNER through the
 * platform mail path — so a swap is noticed by somebody other than the person who made it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

const ACTOR = { id: "pa-1", name: "Fin", email: "billing@timesphere.app", role: "BILLING" as const, mustChangePassword: false, mfaEnrolmentRequired: false };
const REASON = encodeURIComponent("Ticket 5120 — rotating the restricted key after the Stripe audit");

const control = {
  platformBillingSettings: {
    upsert: vi.fn(async () => ({ encryptedSecretKey: "enc", encryptedWebhookSigningSecret: null, priceIdTeam: "price_t", priceIdEnterprise: null }))
  },
  platformAdminUser: {
    findMany: vi.fn(async () => [
      { email: "owner-a@timesphere.app", name: "A" },
      { email: "owner-b@timesphere.app", name: "B" }
    ])
  }
};
vi.mock("../../src/config/control-prisma.js", () => ({ controlPrisma: control }));

vi.mock("../../src/middleware/platform-admin-auth.js", async (importActual) => {
  const actual = await importActual<typeof import("../../src/middleware/platform-admin-auth.js")>();
  return {
    ...actual,
    requirePlatformAdmin: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
      req.platformAdmin = { ...ACTOR };
      req.platformAdminSessionId = "sess-1";
      next();
    }
  };
});

const auditRows: Record<string, unknown>[] = [];
vi.mock("../../src/services/platform-audit.service.js", () => ({
  platformAudit: vi.fn(),
  platformAuditFor: (req: { platformReason?: string }) => async (action: string, entity: string, entityId?: string, metadata?: object) => {
    auditRows.push({ action, entity, entityId, metadata, reason: req.platformReason });
  }
}));
const sendPlatformTemplate = vi.fn(async () => ({ ok: true, status: "SENT", emailLogId: "e", subject: "s" }));
vi.mock("../../src/services/platform-mail.service.js", () => ({ sendPlatformTemplate }));
vi.mock("../../src/services/notify.service.js", () => ({ dispatchTransactional: vi.fn() }));
vi.mock("../../src/services/provisioning.service.js", () => ({ provisionOrganization: vi.fn() }));
vi.mock("../../src/services/platform-admin-analytics.service.js", () => ({ getPlatformAnalytics: vi.fn() }));
vi.mock("../../src/services/org-domain.service.js", () => ({ addDomain: vi.fn(), listDomains: vi.fn(), removeDomain: vi.fn(), verifyDomain: vi.fn() }));
vi.mock("../../src/services/workspace-directory.service.js", () => ({ workspaceUrlForSlug: (slug: string) => `https://${slug}.example.test` }));
vi.mock("../../src/services/audit.service.js", () => ({ audit: vi.fn() }));

const { platformAdminRouter } = await import("../../src/controllers/platform-admin.controller.js");
const { errorHandler } = await import("../../src/middleware/error.js");

const app = express();
app.use(express.json());
app.use("/api/platform-admin", platformAdminRouter);
app.use(errorHandler);

const patch = (body: object, reason: string | null = REASON) => {
  const req = request(app).patch("/api/platform-admin/billing-settings");
  return (reason ? req.set("X-Platform-Reason", reason) : req).send(body);
};

beforeEach(() => {
  vi.clearAllMocks();
  auditRows.length = 0;
});

describe("PATCH /billing-settings", () => {
  it("refuses a change with no reason", async () => {
    const res = await patch({ secretKey: "rk_live_new" }, null);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("REASON_REQUIRED");
    expect(control.platformBillingSettings.upsert).not.toHaveBeenCalled();
  });

  it("records the reason on the audit row", async () => {
    expect((await patch({ secretKey: "rk_live_new" })).status).toBe(200);
    expect(auditRows.find((r) => r.action === "platform_billing.updated")).toMatchObject({ reason: "Ticket 5120 — rotating the restricted key after the Stripe audit" });
  });

  it("emails every active owner when a Stripe credential changes — never the credential itself", async () => {
    await patch({ secretKey: "rk_live_new", webhookSigningSecret: "whsec_new" });
    expect(sendPlatformTemplate).toHaveBeenCalledTimes(2);
    const recipients = sendPlatformTemplate.mock.calls.map((call) => (call as unknown as [string, { to: string }])[1].to);
    expect(recipients.sort()).toEqual(["owner-a@timesphere.app", "owner-b@timesphere.app"]);
    const [key, args] = sendPlatformTemplate.mock.calls[0] as unknown as [string, { vars: Record<string, string> }];
    expect(key).toBe("platform.billing_credentials_changed");
    expect(args.vars).toMatchObject({ actor: "billing@timesphere.app", reason: "Ticket 5120 — rotating the restricted key after the Stripe audit" });
    expect(JSON.stringify(sendPlatformTemplate.mock.calls)).not.toMatch(/rk_live_new|whsec_new/);
  });

  it("does not email anyone for a price-id change", async () => {
    await patch({ priceIdTeam: "price_new" });
    expect(sendPlatformTemplate).not.toHaveBeenCalled();
  });
});
