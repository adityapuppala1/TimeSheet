/**
 * The console's nightly and hourly sweeps run on the PLATFORM's clock (`TZ`, Asia/Kolkata by default),
 * named explicitly in each schedule the way signup-digest.worker.ts names it — not on whatever zone the
 * process happens to start in. The copy says "03:40 IST", so the schedule has to mean it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const scheduled = vi.hoisted(() => [] as Array<{ expression: string; options: { timezone?: string } | undefined }>);

vi.mock("node-cron", () => ({
  default: {
    schedule: (expression: string, _fn: () => unknown, options?: { timezone?: string }) => {
      scheduled.push({ expression, options });
      return { stop: () => undefined };
    },
    validate: () => true
  }
}));
vi.mock("../../src/config/env.js", () => ({ env: { TZ: "Asia/Kolkata" } }));
vi.mock("../../src/services/platform-admin-analytics.service.js", () => ({ captureOrgUsageSnapshots: vi.fn() }));
vi.mock("../../src/services/billing-sync.service.js", () => ({ reconcileSubscriptionSeats: vi.fn() }));
vi.mock("../../src/services/platform-billing-reconcile.service.js", () => ({ reconcileBilledRevenue: vi.fn() }));
vi.mock("../../src/services/tenant-db-metrics.service.js", () => ({ sampleAllTenantDatabases: vi.fn() }));
vi.mock("../../src/services/job-claim.service.js", () => ({ runOncePerTick: vi.fn() }));

beforeEach(() => {
  scheduled.length = 0;
  vi.resetModules();
});

describe("the console's sweeps run on the platform's clock", () => {
  it.each([
    ["usage snapshot", "../../src/workers/org-usage-snapshot.worker.js", "startOrgUsageSnapshotWorker"],
    ["billed revenue", "../../src/workers/billed-revenue-reconcile.worker.js", "startBilledRevenueReconcileWorker"],
    ["database sample", "../../src/workers/tenant-db-sample.worker.js", "startTenantDbSampleWorker"]
  ])("the %s schedule names the platform's zone", async (_name, path, start) => {
    const worker = (await import(path)) as Record<string, () => void>;
    worker[start]();
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].options?.timezone).toBe("Asia/Kolkata");
  });
});
