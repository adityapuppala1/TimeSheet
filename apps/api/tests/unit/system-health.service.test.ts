/**
 * Tests for the server-health snapshot.
 *
 * The property that matters most: getSystemHealth NEVER throws. A health endpoint that 500s
 * when a dependency is down reports nothing exactly when the admin most needs it — every
 * failure must degrade to `ok: false` on that component, with the rest of the snapshot intact.
 * The OS-level numbers (CPU/memory/disk) are only asserted for shape and sane bounds, because
 * they're real measurements of whatever machine runs the test.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeTenantClient } from "../helpers/fake-prisma-client.js";
import { runInTenant } from "../helpers/tenant-context.js";

vi.mock("../../src/config/control-prisma.js", () => ({
  controlPrisma: { $queryRaw: vi.fn() }
}));
vi.mock("../../src/services/mail.service.js", () => ({
  getTransportStatus: vi.fn()
}));

const { controlPrisma } = await import("../../src/config/control-prisma.js");
const { getTransportStatus } = await import("../../src/services/mail.service.js");
const { getSystemHealth } = await import("../../src/services/system-health.service.js");

let client: ReturnType<typeof createFakeTenantClient>;

beforeEach(() => {
  client = createFakeTenantClient();
  vi.mocked(client.$queryRaw).mockResolvedValue([{ 1: 1 }] as never);
  vi.mocked(controlPrisma.$queryRaw).mockResolvedValue([{ 1: 1 }] as never);
  vi.mocked(getTransportStatus).mockResolvedValue({
    configured: true,
    verified: true,
    host: "smtp.example.com",
    port: 587
  } as never);
});

describe("getSystemHealth", () => {
  it("returns a full snapshot with sane bounds when everything is up", async () => {
    const snapshot = await runInTenant(client, () => getSystemHealth());

    expect(snapshot.server.hostname).toBeTruthy();
    expect(snapshot.cpu.cores).toBeGreaterThan(0);
    if (snapshot.cpu.usagePercent !== null) {
      expect(snapshot.cpu.usagePercent).toBeGreaterThanOrEqual(0);
      expect(snapshot.cpu.usagePercent).toBeLessThanOrEqual(100);
    }
    expect(snapshot.memory.usedPercent).toBeGreaterThan(0);
    expect(snapshot.memory.usedPercent).toBeLessThanOrEqual(100);
    expect(snapshot.network.tenantDbPingMs).not.toBeNull();
    expect(snapshot.network.controlDbPingMs).not.toBeNull();

    const names = snapshot.components.map((component) => component.name);
    expect(names).toEqual(["API server", "Tenant database", "Control-plane database", "Mail transport"]);
    expect(snapshot.components.every((component) => component.ok)).toBe(true);
  });

  it("a dead tenant database degrades to ok:false on that component — it never throws", async () => {
    vi.mocked(client.$queryRaw).mockRejectedValue(new Error("ECONNREFUSED 3306"));

    const snapshot = await runInTenant(client, () => getSystemHealth());
    const tenantDb = snapshot.components.find((component) => component.name === "Tenant database")!;
    expect(tenantDb.ok).toBe(false);
    expect(tenantDb.detail).toContain("ECONNREFUSED");
    expect(snapshot.network.tenantDbPingMs).toBeNull();
    // The rest of the snapshot survives — a DB outage must not blind the CPU/memory panel.
    expect(snapshot.components.find((component) => component.name === "Control-plane database")!.ok).toBe(true);
    expect(snapshot.memory.totalBytes).toBeGreaterThan(0);
  });

  it("a broken mail-status check degrades the same way", async () => {
    vi.mocked(getTransportStatus).mockRejectedValue(new Error("boom"));

    const snapshot = await runInTenant(client, () => getSystemHealth());
    const mail = snapshot.components.find((component) => component.name === "Mail transport")!;
    expect(mail.ok).toBe(false);
    expect(mail.detail).toBe("status check failed");
  });

  it("unconfigured mail is reported as such, not conflated with a failure to check", async () => {
    vi.mocked(getTransportStatus).mockResolvedValue({ configured: false, verified: null, host: null, port: null } as never);

    const snapshot = await runInTenant(client, () => getSystemHealth());
    const mail = snapshot.components.find((component) => component.name === "Mail transport")!;
    expect(mail.ok).toBe(false);
    expect(mail.detail).toBe("not configured");
  });
});
