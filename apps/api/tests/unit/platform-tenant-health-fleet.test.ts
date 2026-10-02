/**
 * The Monitoring page's fleet view, as the connection pool sees it (analytics audit M14).
 *
 * The page polls every 60 s, and each pass built a brand-new PrismaClient per workspace for the
 * database metrics AND opened every workspace through the shared 50-entry tenant-client cache for its
 * maintenance phase — so on a fleet of more than fifty, every minute evicted the clients live
 * requests were using. Pinned here:
 *  - a workspace with a LIVE cached tenant client is read through it, and nothing new is built;
 *  - an idle workspace gets ONE short-lived client for the whole read, closed after, and is never
 *    added to the shared cache (`getTenantClient` / `withOrgTenant` are not called);
 *  - repeat polls inside a few minutes are answered from the last sweep; `maxAgeMs: 0` reads afresh.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const built = vi.hoisted(() => ({ clients: 0, disconnected: 0 }));

const fakeClient = () => ({
  $queryRawUnsafe: vi.fn(async () => []),
  $disconnect: vi.fn(async () => {
    built.disconnected += 1;
  })
});

vi.mock("@prisma/client", () => ({
  PrismaClient: class {
    constructor() {
      built.clients += 1;
      // A constructor may return an object; the service then holds the fake.
      return fakeClient();
    }
  }
}));

const liveClient = fakeClient();
const peekTenantClient = vi.fn((orgId: string) => (orgId === "live" ? liveClient : null));
const getTenantClient = vi.fn();
vi.mock("../../src/config/prisma.js", () => ({ peekTenantClient, getTenantClient, prisma: {} }));

const withOrgTenant = vi.fn();
vi.mock("../../src/config/with-org-tenant.js", () => ({ withOrgTenant }));
vi.mock("../../src/config/tenant-context.js", () => ({ tenantContext: { run: (_store: unknown, fn: () => unknown) => fn() } }));
vi.mock("../../src/services/maintenance.service.js", () => ({ getMaintenanceSettings: vi.fn(async () => ({ enabled: false })), phaseOf: () => "off" }));
vi.mock("../../src/utils/encryption.js", () => ({ decryptSecret: (value: string) => value }));
vi.mock("../../src/services/system-health.service.js", () => ({ getSystemHealth: vi.fn() }));
vi.mock("../../src/services/service-health.service.js", () => ({ getStatusPage: vi.fn() }));
vi.mock("../../src/services/api-performance.service.js", () => ({ getApiPerformanceOverview: vi.fn() }));

const orgRow = (id: string) => ({ id, name: id.toUpperCase(), slug: id, status: "ACTIVE", planTier: "TEAM", database: { databaseName: `ts_${id}`, host: "db", encryptedDsn: `mysql://${id}` } });
const control = {
  organization: {
    findMany: vi.fn(async () => [orgRow("live"), orgRow("idle")]),
    findUnique: vi.fn(async ({ where }: { where: { id: string } }) => orgRow(where.id))
  }
};
vi.mock("../../src/config/control-prisma.js", () => ({ controlPrisma: control }));

const { getFleetHealth, __resetFleetHealthCacheForTests } = await import("../../src/services/platform-tenant-health.service.js");

beforeEach(() => {
  built.clients = 0;
  built.disconnected = 0;
  vi.clearAllMocks();
  __resetFleetHealthCacheForTests();
});

describe("getFleetHealth — reusing tenant clients", () => {
  it("reads a live workspace through its cached client and an idle one through ONE short-lived client", async () => {
    const fleet = await getFleetHealth();
    expect(fleet.rows.map((row) => [row.slug, row.reachable])).toEqual([
      ["live", true],
      ["idle", true]
    ]);
    expect(liveClient.$queryRawUnsafe).toHaveBeenCalled();
    // One client for the idle workspace — metrics and maintenance phase together — and it was closed.
    expect(built.clients).toBe(1);
    expect(built.disconnected).toBe(1);
    // Never through the shared cache: that would evict the clients live requests are using.
    expect(getTenantClient).not.toHaveBeenCalled();
    expect(withOrgTenant).not.toHaveBeenCalled();
  });

  it("answers a poll inside the window from the last sweep, and reads afresh when asked", async () => {
    await getFleetHealth({ maxAgeMs: 300_000 });
    await getFleetHealth({ maxAgeMs: 300_000 });
    expect(control.organization.findMany).toHaveBeenCalledTimes(1);
    const fresh = await getFleetHealth({ maxAgeMs: 0 });
    expect(control.organization.findMany).toHaveBeenCalledTimes(2);
    expect(typeof fresh.measuredAt).toBe("string");
  });
});
