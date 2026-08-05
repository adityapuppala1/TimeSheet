/**
 * Tests for feature-level health monitoring and the incident lifecycle.
 *
 * WHY THIS IS A UNIT TEST AND NOT AN E2E ONE, which is the more useful lesson: the first version
 * of this coverage was an end-to-end test that forced a real outage by setting the workspace's AI
 * settings to "enabled, no API key". It restored `aiEnabled` afterwards and could not restore the
 * key — the API masks it on read, so the test had no way to put back what it had cleared. It
 * therefore destroyed a real credential on every run and left the workspace's AI permanently down.
 *
 * A test that mutates production-shaped configuration it cannot restore is not a test, it is an
 * outage on a timer. The incident lifecycle is logic, and logic belongs here, where the whole
 * world is a fake and nothing outside it can be harmed.
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
vi.mock("../../src/services/ai.service.js", () => ({
  resolveApiKey: vi.fn()
}));

const { resolveApiKey } = await import("../../src/services/ai.service.js");
const { probeService, runHealthChecks, SERVICES } = await import("../../src/services/service-health.service.js");

let client: ReturnType<typeof createFakeTenantClient>;

beforeEach(() => {
  client = createFakeTenantClient();
  vi.mocked(resolveApiKey).mockReturnValue("sk-test");
});

describe("probeService", () => {
  it("classifies a fast successful probe as OPERATIONAL", async () => {
    const result = await probeService({
      key: "x",
      label: "X",
      description: "",
      degradedMs: 1_000,
      probe: async () => ({ ok: true })
    });
    expect(result.status).toBe("OPERATIONAL");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("classifies a slow-but-working probe as DEGRADED, not DOWN", async () => {
    // The distinction is the whole reason there are three states: "slow" and "gone" call for
    // different reactions, and collapsing them either cries wolf or stays silent through an
    // outage.
    const result = await probeService({
      key: "x",
      label: "X",
      description: "",
      degradedMs: 1,
      probe: async () => {
        await new Promise((r) => setTimeout(r, 20));
        return { ok: true };
      }
    });
    expect(result.status).toBe("DEGRADED");
    expect(result.detail).toMatch(/slow/i);
  });

  it("NEVER throws — a probe that blows up becomes DOWN with the reason attached", async () => {
    // A monitor that fails is not a monitor. This is the property the whole file exists to protect.
    const result = await probeService({
      key: "x",
      label: "X",
      description: "",
      degradedMs: 1_000,
      probe: async () => {
        throw new Error("connection refused");
      }
    });
    expect(result.status).toBe("DOWN");
    expect(result.detail).toMatch(/connection refused/);
  });

  it("treats an unconfigured optional integration as healthy, not as an outage", async () => {
    // A permanent red row for a deliberate choice is how a status page trains people to ignore it.
    const ai = SERVICES.find((s) => s.key === "ai")!;
    vi.mocked(client.globalAISettings.findUnique).mockResolvedValue({ aiEnabled: false } as never);
    const result = await runInTenant(client, () => probeService(ai));
    expect(result.status).toBe("OPERATIONAL");
    expect(result.detail).toMatch(/switched off/i);
  });

  it("asks the real key resolver rather than reading the column, so an env-var fallback is not a false outage", async () => {
    // REGRESSION: this probe used to test `settings.apiKey` directly. A workspace on the ANTHROPIC
    // provider legitimately stores no key and falls back to ANTHROPIC_API_KEY — reading the column
    // reported that perfectly healthy setup as DOWN.
    const ai = SERVICES.find((s) => s.key === "ai")!;
    vi.mocked(client.globalAISettings.findUnique).mockResolvedValue({ aiEnabled: true, apiKey: null } as never);

    vi.mocked(resolveApiKey).mockReturnValue("from-the-environment");
    await expect(runInTenant(client, () => probeService(ai))).resolves.toMatchObject({ status: "OPERATIONAL" });

    vi.mocked(resolveApiKey).mockReturnValue("");
    await expect(runInTenant(client, () => probeService(ai))).resolves.toMatchObject({ status: "DOWN" });
  });
});

describe("runHealthChecks — the incident lifecycle", () => {
  /** Every probe reports healthy, so only the incident bookkeeping is under test. */
  function allHealthy() {
    vi.mocked(client.$queryRaw).mockResolvedValue([{ 1: 1 }] as never);
    vi.mocked(client.session.count).mockResolvedValue(0 as never);
    vi.mocked(client.timesheet.count).mockResolvedValue(0 as never);
    vi.mocked(client.ticket.count).mockResolvedValue(0 as never);
    vi.mocked(client.timesheet.aggregate).mockResolvedValue({ _sum: {} } as never);
    vi.mocked(client.ticketAttachment.count).mockResolvedValue(0 as never);
    vi.mocked(client.outboundWebhook.count).mockResolvedValue(0 as never);
    vi.mocked(client.faceEnrollment.count).mockResolvedValue(0 as never);
    vi.mocked(client.globalAISettings.findUnique).mockResolvedValue({ aiEnabled: false } as never);
    vi.mocked(client.globalFaceVerificationSettings.findUnique).mockResolvedValue({ enabled: false } as never);
    vi.mocked(client.globalPlanningSettings.findUnique).mockResolvedValue({ enablePlanning: false } as never);
    vi.mocked(client.serviceHealthSample.createMany).mockResolvedValue({ count: 13 } as never);
    vi.mocked(client.serviceHealthSample.deleteMany).mockResolvedValue({ count: 0 } as never);
  }

  beforeEach(() => {
    allHealthy();
  });

  it("closes an open incident when the service recovers, and clears its open slot", async () => {
    vi.mocked(client.serviceIncident.findMany).mockResolvedValue([
      { id: "inc-1", service: "database", status: "DOWN", sampleCount: 4 }
    ] as never);

    await runInTenant(client, () => runHealthChecks());

    expect(client.serviceIncident.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "inc-1" },
        // `openKey: null` is what frees the unique slot. Without it the constraint would refuse
        // the NEXT incident for this service forever.
        data: expect.objectContaining({ openKey: null, endedAt: expect.any(Date) })
      })
    );
  });

  it("joins the winner's incident instead of failing when two runs race to open one", async () => {
    // REGRESSION: opening was a check-then-act with nothing enforcing uniqueness, so the
    // five-minute worker overlapping a manual "check now" produced two incidents a millisecond
    // apart and the status page reported one outage twice. The unique index now refuses the
    // second insert; this asserts the loser joins rather than throwing.
    vi.mocked(client.globalAISettings.findUnique).mockResolvedValue({ aiEnabled: true, apiKey: null } as never);
    vi.mocked(resolveApiKey).mockReturnValue("");
    vi.mocked(client.serviceIncident.findMany).mockResolvedValue([] as never);

    const conflict = Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
    vi.mocked(client.serviceIncident.create).mockRejectedValue(conflict as never);
    vi.mocked(client.serviceIncident.findUnique).mockResolvedValue({
      id: "winner",
      service: "ai",
      status: "DOWN",
      sampleCount: 1
    } as never);

    await expect(runInTenant(client, () => runHealthChecks())).resolves.toBeDefined();

    expect(client.serviceIncident.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "winner" },
        data: expect.objectContaining({ sampleCount: { increment: 1 } })
      })
    );
  });

  it("a real error opening an incident still propagates — only the race is forgiven", async () => {
    vi.mocked(client.globalAISettings.findUnique).mockResolvedValue({ aiEnabled: true, apiKey: null } as never);
    vi.mocked(resolveApiKey).mockReturnValue("");
    vi.mocked(client.serviceIncident.findMany).mockResolvedValue([] as never);
    vi.mocked(client.serviceIncident.create).mockRejectedValue(new Error("table is gone") as never);

    await expect(runInTenant(client, () => runHealthChecks())).rejects.toThrow(/table is gone/);
  });

  it("DOWN outranks DEGRADED, so a recovering incident does not read as a mere slowdown", async () => {
    vi.mocked(client.globalAISettings.findUnique).mockResolvedValue({ aiEnabled: true, apiKey: null } as never);
    vi.mocked(resolveApiKey).mockReturnValue("");
    vi.mocked(client.serviceIncident.findMany).mockResolvedValue([
      { id: "inc-ai", service: "ai", status: "DOWN", sampleCount: 2 }
    ] as never);

    await runInTenant(client, () => runHealthChecks());

    expect(client.serviceIncident.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "inc-ai" }, data: expect.objectContaining({ status: "DOWN" }) })
    );
  });

  it("prunes samples older than the retention window", async () => {
    vi.mocked(client.serviceIncident.findMany).mockResolvedValue([] as never);
    await runInTenant(client, () => runHealthChecks());
    expect(client.serviceHealthSample.deleteMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { checkedAt: { lt: expect.any(Date) } } })
    );
  });
});
