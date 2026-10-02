/**
 * The Monitoring page's fleet view, as the connection pool sees it (analytics audit M14).
 *
 * The page polls every 60 s, and each pass built a brand-new PrismaClient per workspace for the
 * database metrics AND opened every workspace through the shared 50-entry tenant-client cache for its
 * maintenance phase — so on a fleet of more than fifty, every minute evicted the clients live
 * requests were using. Pinned here:
 *  - every workspace gets ONE short-lived client for the whole read, closed after, and is never
 *    added to the shared cache (`getTenantClient` / `withOrgTenant` are not called);
 *  - a workspace's LIVE cached tenant client is never borrowed for it (H2 review, minor 3): the
 *    metrics read runs five information_schema / SHOW queries at once, which on a pool of five held
 *    every connection live requests were waiting on — and the idle sweeper could close a borrowed
 *    client mid-read;
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

// "live" HAS a cached tenant client, offered under the name the service once borrowed it by — so a
// return to borrowing it would be seen here, not just by a production pool running dry.
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

const { getFleetHealth, getDatabaseMetrics, __resetFleetHealthCacheForTests } = await import("../../src/services/platform-tenant-health.service.js");

beforeEach(() => {
  built.clients = 0;
  built.disconnected = 0;
  vi.clearAllMocks();
  __resetFleetHealthCacheForTests();
});

describe("getFleetHealth — tenant clients", () => {
  it("reads every workspace through ONE short-lived client of its own, never through a live tenant pool", async () => {
    const fleet = await getFleetHealth();
    expect(fleet.rows.map((row) => [row.slug, row.reachable])).toEqual([
      ["live", true],
      ["idle", true]
    ]);
    // Not even for the workspace that HAS a live client: its pool is what its users are waiting on.
    expect(liveClient.$queryRawUnsafe).not.toHaveBeenCalled();
    // One client per workspace — metrics and maintenance phase together — and each was closed.
    expect(built.clients).toBe(2);
    expect(built.disconnected).toBe(2);
    // Never through the shared cache: that would evict the clients live requests are using.
    expect(getTenantClient).not.toHaveBeenCalled();
    expect(withOrgTenant).not.toHaveBeenCalled();
  });

  it("reads one workspace's metrics (the drill-down) through a short-lived client too", async () => {
    await getDatabaseMetrics("live");
    expect(liveClient.$queryRawUnsafe).not.toHaveBeenCalled();
    expect(built.clients).toBe(1);
    expect(built.disconnected).toBe(1);
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
