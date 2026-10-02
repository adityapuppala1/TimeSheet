/**
 * Insights' two hours figures — the workload heatmap's "hours logged" per person per week, and the
 * estimate-vs-actual table's actuals — against the shared definition: logged hours are SUBMITTED +
 * APPROVED (workspace-metrics.ts). Neither query had a status filter, so a draft somebody was still
 * typing and hours an approver turned down both counted as work logged against the ticket.
 *
 * The stand-in applies the `where` it is given, so a missing status filter shows up as wrong hours.
 */
import { describe, expect, it, vi } from "vitest";

type Entry = { userId: string; ticketId: string; workDate: Date; totalHours: number; status: string; deletedAt: Date | null };

const ENTRIES: Entry[] = [
  { userId: "asha", ticketId: "t1", workDate: new Date("2026-09-30T00:00:00.000Z"), totalHours: 3, status: "APPROVED", deletedAt: null },
  { userId: "asha", ticketId: "t1", workDate: new Date("2026-09-30T00:00:00.000Z"), totalHours: 4, status: "SUBMITTED", deletedAt: null },
  { userId: "asha", ticketId: "t1", workDate: new Date("2026-09-30T00:00:00.000Z"), totalHours: 2, status: "DRAFT", deletedAt: null },
  { userId: "asha", ticketId: "t1", workDate: new Date("2026-09-30T00:00:00.000Z"), totalHours: 1, status: "REJECTED", deletedAt: null }
];

function matches(e: Entry, where: Record<string, any>): boolean {
  for (const [key, cond] of Object.entries(where)) {
    if (key === "deletedAt") {
      if (cond === null && e.deletedAt !== null) return false;
    } else if (key === "status") {
      if (typeof cond === "string" ? e.status !== cond : !cond.in.includes(e.status)) return false;
    } else if (key === "userId" || key === "ticketId") {
      if (!cond.in.includes(e[key])) return false;
    } else if (key === "workDate") {
      if (cond.gte && e.workDate < cond.gte) return false;
    } else {
      throw new Error(`the fake timesheet table does not understand \`${key}\``);
    }
  }
  return true;
}

vi.mock("../../src/config/prisma.js", () => ({
  prisma: {
    ticket: {
      findMany: vi.fn(async (args: any) => {
        if (args.where.assigneeId) return [{ assigneeId: "asha", createdAt: new Date("2026-09-01T00:00:00.000Z"), resolvedAt: null }];
        if (args.where.estimatedHours) return [{ id: "t1", key: "APL-1", title: "Checkout", estimatedHours: 4 }];
        return [];
      }),
      groupBy: vi.fn(async () => [])
    },
    auditLog: { findMany: vi.fn(async () => []) },
    ticketComment: { findMany: vi.fn(async () => []) },
    projectModule: { findMany: vi.fn(async () => []) },
    user: { findMany: vi.fn(async () => [{ id: "asha", name: "Asha" }]) },
    timesheet: {
      findMany: vi.fn(async (args: any) => ENTRIES.filter((e) => matches(e, args.where))),
      groupBy: vi.fn(async (args: any) => {
        const rows = ENTRIES.filter((e) => matches(e, args.where));
        return rows.length ? [{ ticketId: "t1", _sum: { totalHours: rows.reduce((s, e) => s + e.totalHours, 0) } }] : [];
      })
    }
  }
}));

const { buildTicketInsights } = await import("../../src/services/ticket-analytics.service.js");

// Thursday 1 October 2026, 10:00 IST: the current IST week began Monday 28 September.
const NOW = new Date("2026-10-01T04:30:00.000Z");

describe("Insights hours are logged hours", () => {
  it("the heatmap counts submitted and approved hours, not drafts or rejected ones", async () => {
    const insights = await buildTicketInsights(NOW);
    const week = insights.workloadHeatmap.rows[0].cells.find((c: { weekStart: string }) => c.weekStart === "2026-09-28")!;
    expect(week.hoursLogged).toBe(7);
  });

  it("estimate vs actual compares the estimate with logged hours only", async () => {
    const insights = await buildTicketInsights(NOW);
    expect(insights.estimateVsActual).toEqual([
      { ticketKey: "APL-1", title: "Checkout", estimatedHours: 4, actualHours: 7, varianceHours: 3 }
    ]);
  });
});
