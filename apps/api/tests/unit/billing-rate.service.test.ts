/**
 * Unit tests for the billing rate resolution + snapshot logic.
 *
 * WHY these are unit tests rather than live e2e: the approval path they feed is behind this
 * workspace's face-verification gate, and toggling a real security setting just to exercise a
 * billing calculation is not an acceptable trade. The rate logic is pure enough to test directly
 * against the existing fake-Prisma harness, which touches no live state at all.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Prisma } from "@prisma/client";
import { createFakeTenantClient } from "../helpers/fake-prisma-client.js";
import { runInTenant } from "../helpers/tenant-context.js";

const { buildRateSnapshotPatch, computeTimesheetCost, resolveBillingRate } = await import("../../src/services/billing-rate.service.js");

function withRates(client: ReturnType<typeof createFakeTenantClient>, opts: {
  projectRate?: number | null;
  projectCurrency?: string | null;
  userRate?: number | null;
  workspaceCurrency?: string;
}) {
  vi.mocked(client.project.findUnique).mockResolvedValue({
    defaultHourlyRate: opts.projectRate == null ? null : new Prisma.Decimal(opts.projectRate),
    billingCurrency: opts.projectCurrency ?? null
  } as never);
  vi.mocked(client.user.findUnique).mockResolvedValue({
    hourlyRate: opts.userRate == null ? null : new Prisma.Decimal(opts.userRate)
  } as never);
  vi.mocked(client.globalTicketSettings.upsert).mockResolvedValue({
    id: "global",
    defaultCurrency: opts.workspaceCurrency ?? "USD"
  } as never);
}

let client: ReturnType<typeof createFakeTenantClient>;
beforeEach(() => {
  client = createFakeTenantClient();
});

describe("resolveBillingRate", () => {
  it("prefers the project override over the individual's rate", async () => {
    withRates(client, { projectRate: 150, userRate: 80 });
    const result = await runInTenant(client, () => resolveBillingRate({ userId: "u1", projectId: "p1" }));
    expect(result.source).toBe("PROJECT");
    expect(Number(result.rate)).toBe(150);
  });

  it("falls back to the individual's rate when the project has no override", async () => {
    withRates(client, { projectRate: null, userRate: 80 });
    const result = await runInTenant(client, () => resolveBillingRate({ userId: "u1", projectId: "p1" }));
    expect(result.source).toBe("USER");
    expect(Number(result.rate)).toBe(80);
  });

  it("reports NONE (not zero) when no rate is configured anywhere", async () => {
    withRates(client, { projectRate: null, userRate: null });
    const result = await runInTenant(client, () => resolveBillingRate({ userId: "u1", projectId: "p1" }));
    expect(result.source).toBe("NONE");
    // The distinction that matters: "we don't know what this costs" must never be recorded as
    // "this was free", which is what the pre-existing `?? 0` fallback did.
    expect(result.rate).toBeNull();
  });

  it("takes currency from the project, then the workspace default", async () => {
    withRates(client, { projectRate: 150, projectCurrency: "EUR", workspaceCurrency: "GBP" });
    await expect(runInTenant(client, () => resolveBillingRate({ userId: "u1", projectId: "p1" }))).resolves.toMatchObject({
      currency: "EUR"
    });

    const client2 = createFakeTenantClient();
    withRates(client2, { projectRate: 150, projectCurrency: null, workspaceCurrency: "GBP" });
    await expect(runInTenant(client2, () => resolveBillingRate({ userId: "u1", projectId: "p1" }))).resolves.toMatchObject({
      currency: "GBP"
    });
  });
});

describe("buildRateSnapshotPatch", () => {
  it("computes amount as rate x hours and stamps the snapshot time", async () => {
    withRates(client, { projectRate: 150 });
    const patch = await runInTenant(client, () =>
      buildRateSnapshotPatch({ userId: "u1", projectId: "p1", totalHours: 2.5, billable: true })
    );
    expect(Number(patch.billedAmount)).toBe(375);
    expect(patch.billedRateSource).toBe("PROJECT");
    expect(patch.rateSnapshotAt).toBeInstanceOf(Date);
  });

  it("uses exact decimal math, not floating point", async () => {
    // 0.1 * 3 is 0.30000000000000004 in IEEE-754 floats. An artifact a client may audit cannot
    // carry that kind of artefact, so the service works in Prisma.Decimal throughout.
    withRates(client, { projectRate: 0.1 });
    const patch = await runInTenant(client, () =>
      buildRateSnapshotPatch({ userId: "u1", projectId: "p1", totalHours: 3, billable: true })
    );
    expect(patch.billedAmount!.toString()).toBe("0.3");
  });

  it("records a hard zero amount for non-billable work but still keeps the rate", async () => {
    withRates(client, { projectRate: 150 });
    const patch = await runInTenant(client, () =>
      buildRateSnapshotPatch({ userId: "u1", projectId: "p1", totalHours: 4, billable: false })
    );
    expect(Number(patch.billedAmount)).toBe(0);
    expect(Number(patch.billedRate)).toBe(150);
  });

  it("produces a NONE snapshot with a null amount when no rate exists — approval must not block", async () => {
    withRates(client, { projectRate: null, userRate: null });
    const patch = await runInTenant(client, () =>
      buildRateSnapshotPatch({ userId: "u1", projectId: "p1", totalHours: 4, billable: true })
    );
    expect(patch.billedRateSource).toBe("NONE");
    expect(patch.billedAmount).toBeNull();
  });
});

describe("computeTimesheetCost", () => {
  it("prefers the frozen snapshot over any live rate", () => {
    // The whole point of snapshotting: a later raise (liveFallbackRate 999) must not change what
    // already-approved work cost.
    const { amount } = computeTimesheetCost([{ totalHours: 2, billedAmount: 300, liveFallbackRate: 999 }]);
    expect(amount).toBe(300);
  });

  it("falls back to the live rate only for rows with no snapshot (pre-feature history)", () => {
    const { amount } = computeTimesheetCost([{ totalHours: 2, billedAmount: null, billedRate: null, liveFallbackRate: 50 }]);
    expect(amount).toBe(100);
  });

  it("counts hours with no rate as unrated rather than as zero cost", () => {
    const { amount, unratedHours } = computeTimesheetCost([
      { totalHours: 3, billedAmount: null, billedRate: null, liveFallbackRate: null }
    ]);
    expect(amount).toBe(0);
    expect(unratedHours).toBe(3);
  });

  it("skips non-billable rows entirely", () => {
    const { amount, unratedHours } = computeTimesheetCost([{ totalHours: 5, billable: false, billedAmount: 500 }]);
    expect(amount).toBe(0);
    expect(unratedHours).toBe(0);
  });
});
