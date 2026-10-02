/**
 * The custom-dashboard widgets against the shared definitions (M7, M1, M6).
 *
 *   - "Open" is not RESOLVED and not CLOSED in every widget. STATUS_MIX, PRIORITY_MIX and PROJECT_MIX
 *     excluded only CLOSED — while their own catalogue comment said they agreed with OPEN_ITEMS.
 *   - VELOCITY fetched 30 days into 5 rolling weekly buckets, so the oldest held about two days.
 *     It is Monday (IST) weeks over whole weeks, like Insights.
 *   - HOURS_LOGGED compared a DATE column with a timestamp (`workDate >= now - 30d`): it missed day
 *     30 and counted future-dated rows.
 *   - OVERDUE_ITEMS compared the `@db.Date` end date with `now`, so a ticket was overdue ON its own
 *     end date from 05:30 IST.
 *   - MY_QUEUE sorted `dueAt asc`, and MySQL puts NULLs first: undated tickets led the queue.
 *   - WORKLOAD_SUMMARY ignored the viewer's project scope, and turned any failure into "Nobody assigned".
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  calls: [] as Array<{ op: string; args: any }>,
  ticketRows: [] as any[],
  workload: null as null | (() => Promise<any>)
}));

vi.mock("../../src/config/prisma.js", () => ({
  prisma: {
    ticket: {
      count: vi.fn(async (args: any) => (state.calls.push({ op: "ticket.count", args }), 0)),
      groupBy: vi.fn(async (args: any) => (state.calls.push({ op: "ticket.groupBy", args }), [])),
      findMany: vi.fn(async (args: any) => (state.calls.push({ op: "ticket.findMany", args }), state.ticketRows))
    },
    timesheet: {
      aggregate: vi.fn(async (args: any) => (state.calls.push({ op: "timesheet.aggregate", args }), { _sum: { totalHours: 0 } }))
    },
    project: { findMany: vi.fn(async () => []) }
  }
}));
vi.mock("../../src/services/workload.service.js", () => ({
  loadWorkload: vi.fn(async (params: any) => {
    state.calls.push({ op: "loadWorkload", args: params });
    return state.workload ? state.workload() : { buckets: [], rows: [], workingDays: [1, 2, 3, 4, 5] };
  })
}));

const { resolveWidget } = await import("../../src/services/dashboard.service.js");
const widget = (type: string, config: Record<string, unknown> = {}) =>
  resolveWidget({ type, config, projectIds: ["p1", "p2"], viewerId: "u1" } as never) as Promise<any>;
const lastCall = (op: string) => [...state.calls].reverse().find((c) => c.op === op)!;

beforeAll(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  // Thursday 1 October 2026, 10:00 IST.
  vi.setSystemTime(new Date("2026-10-01T04:30:00.000Z"));
});
afterAll(() => vi.useRealTimers());
beforeEach(() => {
  state.calls = [];
  state.ticketRows = [];
  state.workload = null;
});

describe("open work", () => {
  for (const type of ["STATUS_MIX", "PRIORITY_MIX", "PROJECT_MIX"]) {
    it(`${type} counts open as not resolved and not closed, like OPEN_ITEMS`, async () => {
      await widget(type);
      expect(lastCall("ticket.groupBy").args.where.status).toEqual({ notIn: ["RESOLVED", "CLOSED"] });
    });
  }
});

describe("OVERDUE_ITEMS", () => {
  it("is overdue the day AFTER its end date, and past its SLA instant", async () => {
    await widget("OVERDUE_ITEMS");
    expect(lastCall("ticket.count").args.where.OR).toEqual([
      { endDate: { lt: new Date("2026-10-01T00:00:00.000Z") } },
      { dueAt: { lt: new Date("2026-10-01T04:30:00.000Z") } }
    ]);
  });
});

describe("HOURS_LOGGED", () => {
  it("covers the last N whole days to today, on the date column, with no future rows", async () => {
    const w = await widget("HOURS_LOGGED", { days: 30 });
    expect(lastCall("timesheet.aggregate").args.where.workDate).toEqual({
      gte: new Date("2026-09-02T00:00:00.000Z"),
      lte: new Date("2026-10-01T00:00:00.000Z")
    });
    expect(w.hint).toMatch(/last 30 days/);
  });
});

describe("VELOCITY", () => {
  it("uses whole Monday weeks on the IST calendar", async () => {
    const w = await widget("VELOCITY", { days: 28 });
    // Four whole weeks, the current one included: Mondays 7, 14, 21 and 28 September.
    expect(w.points.map((p: { label: string }) => p.label)).toEqual(["7 Sept", "14 Sept", "21 Sept", "28 Sept"]);
    const created = state.calls.find((c) => c.op === "ticket.findMany" && c.args.select?.createdAt);
    // The first Monday 00:00 IST.
    expect(created!.args.where.createdAt.gte).toEqual(new Date("2026-09-06T18:30:00.000Z"));
  });
});

describe("MY_QUEUE", () => {
  it("puts the soonest promise first and undated work last", async () => {
    state.ticketRows = [
      { key: "A-1", title: "undated", priority: "HIGH", dueAt: null, endDate: null, status: "OPEN" },
      { key: "A-2", title: "sla friday", priority: "LOW", dueAt: new Date("2026-10-02T10:00:00Z"), endDate: null, status: "OPEN" },
      { key: "A-3", title: "ends wednesday", priority: "LOW", dueAt: new Date("2026-10-20T10:00:00Z"), endDate: new Date("2026-09-30T00:00:00Z"), status: "OPEN" }
    ];
    const w = await widget("MY_QUEUE");
    expect(w.rows.map((r: { key: string }) => r.key)).toEqual(["A-3", "A-2", "A-1"]);
  });
});

describe("WORKLOAD_SUMMARY", () => {
  it("covers the viewer's own projects when no project is configured", async () => {
    await widget("WORKLOAD_SUMMARY");
    expect(lastCall("loadWorkload").args.projectIds).toEqual(["p1", "p2"]);
  });

  it("lets a failure surface as an error, not as 'Nobody assigned'", async () => {
    state.workload = () => Promise.reject(new Error("db down"));
    await expect(widget("WORKLOAD_SUMMARY")).rejects.toThrow("db down");
  });
});
