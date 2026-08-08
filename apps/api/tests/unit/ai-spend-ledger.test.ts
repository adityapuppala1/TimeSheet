/**
 * The budget gate as a reservation, not a check.
 *
 * The old `assertWithinBudget` read an aggregate and compared — two calls arriving together both
 * saw the same remaining figure and both spent it. `reserveAiSpend` turns admission into an atomic
 * conditional increment the database serializes. These tests pin the semantics the atomicity rests
 * on: admission is the `updateMany` WHERE clause (count 0 = refused, whatever any earlier read
 * said), settlement replaces the provision with actuals, and a month row is seeded from the
 * reporting aggregate so an upgrade mid-month grants nobody a fresh budget.
 *
 * Test-by-breaking note: the "refused" test fails against the pre-ledger code by construction —
 * there was no reserveAiSpend to refuse anything. The seeding test was verified by removing the
 * aggregate seed (create with 0) and watching it fail.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeTenantClient } from "../helpers/fake-prisma-client.js";
import { runInTenant } from "../helpers/tenant-context.js";
import type { PrismaClient } from "@prisma/client";

const { reserveAiSpend } = await import("../../src/services/ai.service.js");

let client: PrismaClient;

beforeEach(() => {
  client = createFakeTenantClient();
  vi.mocked(client.aiSpendMonth.findUnique).mockResolvedValue({
    id: "2026-08",
    committedUsd: 1,
    reconciledAt: new Date(),
    updatedAt: new Date()
  } as never);
  vi.mocked(client.aiSpendMonth.updateMany).mockResolvedValue({ count: 1 } as never);
  vi.mocked(client.aiSpendMonth.update).mockResolvedValue({} as never);
});

describe("admission", () => {
  it("admits through the conditional increment, not a read", async () => {
    await runInTenant(client, () => reserveAiSpend(10));
    const call = vi.mocked(client.aiSpendMonth.updateMany).mock.calls[0][0] as never as {
      where: { committedUsd: { lt: number } };
      data: { committedUsd: { increment: number } };
    };
    // The WHERE carries the budget and the DATA carries the provision — the comparison and the
    // increment are one statement, which is the entire fix.
    expect(call.where.committedUsd.lt).toBe(10);
    expect(call.data.committedUsd.increment).toBeGreaterThan(0);
  });

  it("refuses with a 402 when the conditional update matched nothing", async () => {
    vi.mocked(client.aiSpendMonth.updateMany).mockResolvedValue({ count: 0 } as never);
    await expect(runInTenant(client, () => reserveAiSpend(10))).rejects.toMatchObject({ statusCode: 402 });
  });

  it("treats a budget of exactly 0 as a hard stop, not as unlimited", async () => {
    // Starter's seeded tier ceiling is exactly 0 — the same trap assertWithinBudget documents.
    vi.mocked(client.aiSpendMonth.updateMany).mockResolvedValue({ count: 0 } as never);
    await expect(runInTenant(client, () => reserveAiSpend(0))).rejects.toMatchObject({ statusCode: 402 });
  });

  it("does not touch the ledger at all when no cap is configured", async () => {
    const settle = await runInTenant(client, () => reserveAiSpend(null));
    await settle(0.01);
    expect(client.aiSpendMonth.findUnique).not.toHaveBeenCalled();
    expect(client.aiSpendMonth.updateMany).not.toHaveBeenCalled();
    expect(client.aiSpendMonth.update).not.toHaveBeenCalled();
  });
});

describe("the month row", () => {
  it("is seeded from the reporting aggregate, so history carries over", async () => {
    vi.mocked(client.aiSpendMonth.findUnique).mockResolvedValue(null as never);
    vi.mocked(client.aIUsageLog.aggregate).mockResolvedValue({ _sum: { costUsdEstimate: 4.2 } } as never);
    vi.mocked(client.aiSpendMonth.create).mockResolvedValue({} as never);

    await runInTenant(client, () => reserveAiSpend(10));

    const created = vi.mocked(client.aiSpendMonth.create).mock.calls[0][0] as never as { data: { committedUsd: number } };
    // Seeding with 0 would hand a workspace that upgraded mid-month a fresh budget for money
    // already spent.
    expect(created.data.committedUsd).toBe(4.2);
  });

  it("survives losing the creation race — the constraint's whole point", async () => {
    vi.mocked(client.aiSpendMonth.findUnique).mockResolvedValue(null as never);
    vi.mocked(client.aIUsageLog.aggregate).mockResolvedValue({ _sum: { costUsdEstimate: 0 } } as never);
    vi.mocked(client.aiSpendMonth.create).mockRejectedValue(new Error("P2002 unique constraint"));

    // The loser proceeds to the conditional increment against the winner's row.
    await expect(runInTenant(client, () => reserveAiSpend(10))).resolves.toBeTypeOf("function");
    expect(client.aiSpendMonth.updateMany).toHaveBeenCalled();
  });
});

describe("settlement", () => {
  it("replaces the provision with the actual estimate", async () => {
    const settle = await runInTenant(client, () => reserveAiSpend(10));
    await runInTenant(client, () => settle(0.03));

    const update = vi.mocked(client.aiSpendMonth.update).mock.calls[0][0] as never as {
      data: { committedUsd: { increment: number } };
    };
    const reserved = (vi.mocked(client.aiSpendMonth.updateMany).mock.calls[0][0] as never as {
      data: { committedUsd: { increment: number } };
    }).data.committedUsd.increment;
    // increment(actual - provision): the ledger converges to what AIUsageLog reports.
    expect(update.data.committedUsd.increment).toBeCloseTo(0.03 - reserved, 10);
  });

  it("releases the whole provision when the call failed", async () => {
    const settle = await runInTenant(client, () => reserveAiSpend(10));
    await runInTenant(client, () => settle(0));
    const update = vi.mocked(client.aiSpendMonth.update).mock.calls[0][0] as never as {
      data: { committedUsd: { increment: number } };
    };
    expect(update.data.committedUsd.increment).toBeLessThan(0);
  });

  it("never fails the caller over an accounting write", async () => {
    vi.mocked(client.aiSpendMonth.update).mockRejectedValue(new Error("deadlock"));
    const settle = await runInTenant(client, () => reserveAiSpend(10));
    await expect(runInTenant(client, () => settle(0.01))).resolves.toBeUndefined();
  });
});

describe("reconciliation", () => {
  it("re-anchors a stale ledger to the reporting aggregate", async () => {
    // A provision leaked by a crash mid-call would otherwise shrink the month forever.
    vi.mocked(client.aiSpendMonth.findUnique).mockResolvedValue({
      id: "2026-08",
      committedUsd: 9.99,
      reconciledAt: new Date(Date.now() - 60 * 60_000),
      updatedAt: new Date()
    } as never);
    vi.mocked(client.aIUsageLog.aggregate).mockResolvedValue({ _sum: { costUsdEstimate: 2.5 } } as never);

    await runInTenant(client, () => reserveAiSpend(10));

    const update = vi.mocked(client.aiSpendMonth.update).mock.calls[0][0] as never as {
      data: { committedUsd: number };
    };
    expect(update.data.committedUsd).toBe(2.5);
  });

  it("leaves a fresh ledger alone", async () => {
    await runInTenant(client, () => reserveAiSpend(10));
    expect(client.aIUsageLog.aggregate).not.toHaveBeenCalled();
  });
});
