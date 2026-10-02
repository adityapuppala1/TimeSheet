/**
 * What /plan-lapsed can reach while the workspace is in GRACE — through the REAL `requireAuth`.
 *
 * THE BUG. The page's "Choose a plan" linked into /app/settings?tab=billing, inside the app shell,
 * whose notifications bell and project sidebar call routes GRACE refuses with a 402 — and the client
 * answers every 402 by navigating to /plan-lapsed. A lapsed trial or a failed renewal could not pay its
 * way out. The page now does everything in place, so every route it calls must answer in GRACE:
 *  - for a SUPER_ADMIN: billing status, checkout, the billing portal and the data exports;
 *  - for EVERYONE: who to ask (`/billing/standing`) — the one billing read a member may make, because
 *    "ask Priya to renew" is the only useful thing that page can tell them;
 *  - for everyone else, everything else stays a 402.
 */
import type { Request, Response } from "express";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeTenantClient } from "../helpers/fake-prisma-client.js";
import { runInTenant } from "../helpers/tenant-context.js";

vi.mock("../../src/services/maintenance.service.js", () => ({ isMaintenanceActive: vi.fn().mockResolvedValue(false) }));
const orgStatus = vi.hoisted(() => ({ value: "GRACE" }));
vi.mock("../../src/services/org-status.service.js", () => ({ getOrgStatus: vi.fn(async () => orgStatus.value), forgetOrgStatus: vi.fn() }));
vi.mock("../../src/config/prisma.js", async () => {
  const { tenantContext } = await import("../../src/config/tenant-context.js");
  return { prisma: new Proxy({} as never, { get: (_t, prop) => (tenantContext.getStore()!.client as never)[prop] }) };
});

const { requireAuth } = await import("../../src/middleware/auth.js");
const { signAccessToken } = await import("../../src/utils/security.js");

const ORG_ID = "org-1";
const USER_ID = "11111111-1111-4111-8111-111111111111";
let client: ReturnType<typeof createFakeTenantClient>;

/** One request to `originalUrl` as `role`, through the real middleware. Resolves to the status the
 *  middleware decided: 200 when it let the request through, otherwise the AppError's status. */
async function gate(role: string, method: string, originalUrl: string): Promise<number> {
  vi.mocked(client.session.findUnique).mockResolvedValue({ revokedAt: null } as never);
  vi.mocked(client.user.findUnique).mockResolvedValue({ id: USER_ID, name: "Ada", email: "ada@acme.test", status: "ACTIVE", deletedAt: null, role: { name: role, permissions: [] } } as never);
  vi.mocked(client.session.update).mockResolvedValue({} as never);
  const req = { method, originalUrl, headers: { authorization: `Bearer ${signAccessToken(USER_ID, `s-${Math.random()}`, ORG_ID)}` } } as unknown as Request;
  try {
    await runInTenant(client, () => requireAuth(req, {} as Response, () => undefined), ORG_ID);
    return 200;
  } catch (error) {
    return (error as { statusCode?: number }).statusCode ?? 500;
  }
}

/** Every route /plan-lapsed calls for the person who can pay. */
const ADMIN_ROUTES: Array<[string, string]> = [
  ["GET", "/api/billing/standing"],
  ["GET", "/api/billing/status"],
  ["POST", "/api/billing/checkout-session"],
  ["POST", "/api/billing/portal-session"],
  ["GET", "/api/reports/export.xlsx"],
  ["GET", "/api/reports/export.csv?from=2026-01-01"]
];

beforeEach(() => {
  client = createFakeTenantClient();
  orgStatus.value = "GRACE";
});

describe("GRACE, as /plan-lapsed meets it", () => {
  it.each(ADMIN_ROUTES)("lets a super admin reach %s %s", async (method, url) => {
    expect(await gate("SUPER_ADMIN", method, url)).toBe(200);
  });

  it("lets every member ask who can renew", async () => {
    for (const role of ["EMPLOYEE", "MANAGER", "ADMIN"]) expect(await gate(role, "GET", "/api/billing/standing")).toBe(200);
  });

  it.each(ADMIN_ROUTES.filter(([, url]) => !url.startsWith("/api/billing/standing")))("refuses anyone else %s %s with a 402", async (method, url) => {
    expect(await gate("EMPLOYEE", method, url)).toBe(402);
    expect(await gate("ADMIN", method, url)).toBe(402);
  });

  it("still refuses the app shell's own reads, even to a super admin", async () => {
    // The notifications bell and the project sidebar — what bounced the admin back to /plan-lapsed.
    expect(await gate("SUPER_ADMIN", "GET", "/api/notifications")).toBe(402);
    expect(await gate("SUPER_ADMIN", "GET", "/api/projects")).toBe(402);
  });

  it("opens only the standing route to members, not a prefix of it", async () => {
    expect(await gate("EMPLOYEE", "GET", "/api/billing/standing-orders")).toBe(402);
  });
});
