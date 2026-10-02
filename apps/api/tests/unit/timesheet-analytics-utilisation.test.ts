/**
 * Reports → Analytics utilisation, against the shared definitions (services/workspace-metrics.ts).
 *
 * It was wrong four ways at once, and every one of them was quiet:
 *   1. Capacity counted every working day in the range, including the ones still to come. The
 *      panel defaults to the whole month, so on the 2nd a person who had logged both days in full
 *      read about 9%.
 *   2. Only people with rows appeared — so the 0% row, the one a manager most needs, never did.
 *   3. Draft and rejected hours counted as utilisation.
 *   4. Leave was not subtracted (the workload board does subtract it), and capacity was multiplied
 *      by the person's TARGET utilisation while being labelled contracted capacity.
 *
 * The stand-in database evaluates the `where` clauses and the `groupBy` it is given, so these tests
 * check which rows come back, not merely that a query was written.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

type Person = {
  id: string;
  name: string;
  status: "ACTIVE" | "INACTIVE" | "PENDING_VERIFICATION";
  deletedAt: Date | null;
  isAgent: boolean;
  weeklyCapacityHours: number | null;
  plannedUtilizationPct: number | null;
  projects: string[];
};

const ASHA: Person = { id: "asha", name: "Asha", status: "ACTIVE", deletedAt: null, isAgent: false, weeklyCapacityHours: 40, plannedUtilizationPct: 80, projects: ["p1"] };
const BEN: Person = { id: "ben", name: "Ben", status: "ACTIVE", deletedAt: null, isAgent: false, weeklyCapacityHours: null, plannedUtilizationPct: null, projects: ["p2"] };
const BOT: Person = { id: "bot", name: "Triage bot", status: "ACTIVE", deletedAt: null, isAgent: true, weeklyCapacityHours: null, plannedUtilizationPct: null, projects: ["p1"] };
const DANA: Person = { id: "dana", name: "Dana", status: "INACTIVE", deletedAt: null, isAgent: false, weeklyCapacityHours: 40, plannedUtilizationPct: null, projects: ["p1"] };

const state = vi.hoisted(() => ({
  people: [] as any[],
  rows: [] as Array<Record<string, any>>,
  bookings: [] as Array<Record<string, any>>,
  findManyCalls: [] as Array<Record<string, any>>
}));

function inRange(value: Date, cond: any): boolean {
  if (cond === undefined) return true;
  if (cond instanceof Date) return value.getTime() === cond.getTime();
  if (cond.gte && value < cond.gte) return false;
  if (cond.lte && value > cond.lte) return false;
  if (cond.lt && value >= cond.lt) return false;
  if (cond.gt && value <= cond.gt) return false;
  return true;
}

function rowMatches(row: Record<string, any>, where: Record<string, any>): boolean {
  for (const [key, cond] of Object.entries(where ?? {})) {
    if (key === "deletedAt") {
      if (cond === null ? row.deletedAt !== null : true) return false;
    } else if (key === "workDate") {
      if (!inRange(row.workDate, cond)) return false;
    } else if (key === "reviewedAt") {
      if (cond?.not === null ? row.reviewedAt == null : !inRange(row.reviewedAt, cond)) return false;
    } else if (key === "status") {
      if (typeof cond === "string" ? row.status !== cond : !cond.in.includes(row.status)) return false;
    } else if (["userId", "projectId", "moduleId", "ticketId", "activityType", "billable"].includes(key)) {
      if (typeof cond === "object" && cond?.in) {
        if (!cond.in.includes(row[key])) return false;
      } else if (row[key] !== cond) return false;
    } else {
      throw new Error(`the fake timesheet table does not understand \`${key}\``);
    }
  }
  return true;
}

function personMatches(p: any, where: Record<string, any>): boolean {
  for (const [key, cond] of Object.entries(where ?? {})) {
    if (key === "id") {
      if (typeof cond === "string" ? p.id !== cond : !cond.in.includes(p.id)) return false;
    } else if (key === "deletedAt") {
      if (cond === null && p.deletedAt !== null) return false;
    } else if (key === "status") {
      if (typeof cond === "string" ? p.status !== cond : p.status === cond.not) return false;
    } else if (key === "isAgent") {
      if (p.isAgent !== cond) return false;
    } else if (key === "projectAssignments") {
      if (!p.projects.includes(cond.some.projectId)) return false;
    } else {
      throw new Error(`the fake directory does not understand \`${key}\``);
    }
  }
  return true;
}

vi.mock("../../src/config/prisma.js", () => ({
  prisma: {
    timesheet: {
      groupBy: vi.fn(async (args: any) => {
        const groups = new Map<string, any>();
        for (const row of state.rows.filter((r) => rowMatches(r, args.where))) {
          const key = args.by.map((k: string) => String(row[k])).join("|");
          const g = groups.get(key) ?? {
            ...Object.fromEntries(args.by.map((k: string) => [k, row[k]])),
            _sum: { totalHours: 0, billedAmount: null as number | null },
            _count: { _all: 0, billedAmount: 0 }
          };
          g._sum.totalHours += row.totalHours;
          if (row.billedAmount != null) {
            g._sum.billedAmount = (g._sum.billedAmount ?? 0) + row.billedAmount;
            g._count.billedAmount += 1;
          }
          g._count._all += 1;
          groups.set(key, g);
        }
        return [...groups.values()];
      }),
      findMany: vi.fn(async (args: any) => {
        state.findManyCalls.push(args);
        return state.rows.filter((r) => rowMatches(r, args.where));
      })
    },
    user: {
      findMany: vi.fn(async (args: any) => state.people.filter((p) => personMatches(p, args?.where)))
    },
    resourceBooking: {
      findMany: vi.fn(async (args: any) =>
        state.bookings.filter(
          (b) => args.where.userId.in.includes(b.userId) && b.isTimeOff === args.where.isTimeOff && b.startDate <= args.where.startDate.lte && b.endDate >= args.where.endDate.gte
        )
      )
    }
  }
}));

vi.mock("../../src/services/planning.service.js", () => ({
  getPlanningSettings: vi.fn(async () => ({ workingDays: [1, 2, 3, 4, 5], defaultWeeklyCapacityHours: 40 }))
}));

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

function row(userId: string, iso: string, hours: number, over: Record<string, any> = {}) {
  return {
    id: `${userId}-${iso}-${hours}-${over.status ?? "APPROVED"}`,
    userId,
    projectId: "p1",
    moduleId: "m1",
    ticketId: null,
    activityType: "DEVELOPMENT",
    workDate: day(iso),
    totalHours: hours,
    status: "APPROVED",
    billable: true,
    billedAmount: null,
    billedCurrency: null,
    submittedAt: new Date(`${iso}T09:00:00.000Z`),
    reviewedAt: new Date(`${iso}T12:00:00.000Z`),
    reviewedById: "ben",
    approvalDeadline: null,
    slaBreachAt: null,
    deletedAt: null,
    ...over
  };
}

const { buildTimesheetAnalytics } = await import("../../src/services/timesheet-analytics.service.js");

beforeAll(() => {
  // Friday 2 October 2026, 10:00 IST.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-02T04:30:00.000Z"));
});
afterAll(() => vi.useRealTimers());

beforeEach(() => {
  state.people = [ASHA, BEN, BOT, DANA];
  state.rows = [row("asha", "2026-10-01", 8), row("asha", "2026-10-02", 8)];
  state.bookings = [];
  state.findManyCalls = [];
});

const october = { from: "2026-10-01", to: "2026-10-31" };
const rowFor = (result: any, id: string) => result.utilisation.find((r: any) => r.userId === id);

describe("capacity", () => {
  it("counts working days up to today, not the rest of the range", async () => {
    const result = await buildTimesheetAnalytics(october);
    // Thu 1st + Fri 2nd. Counting all 22 working days of October read 16h as 9%.
    expect(result.range.workingDaysToDate).toBe(2);
    expect(rowFor(result, "asha")).toMatchObject({ loggedHours: 16, capacityHours: 16, utilisationPct: 100 });
  });

  it("reports target utilisation beside capacity, never multiplied into it", async () => {
    const result = await buildTimesheetAnalytics(october);
    // Asha's target is 80%. Her capacity is still her contracted 16h, not 12.8h.
    expect(rowFor(result, "asha")).toMatchObject({ capacityHours: 16, targetUtilisationPct: 80 });
    expect(rowFor(result, "ben").targetUtilisationPct).toBe(100);
  });

  it("subtracts time off, as the workload board does", async () => {
    state.bookings = [{ userId: "ben", isTimeOff: true, startDate: day("2026-10-02"), endDate: day("2026-10-02"), hoursPerDay: 8 }];
    const result = await buildTimesheetAnalytics(october);
    expect(rowFor(result, "ben")).toMatchObject({ capacityHours: 8, timeOffHours: 8 });
  });

  it("has no capacity — and so no utilisation — for a range entirely in the future", async () => {
    const result = await buildTimesheetAnalytics({ from: "2026-11-01", to: "2026-11-30" });
    expect(rowFor(result, "ben")).toMatchObject({ capacityHours: null, utilisationPct: null });
  });
});

describe("who is in the table", () => {
  it("includes an active person who logged nothing, at 0%", async () => {
    const result = await buildTimesheetAnalytics(october);
    expect(rowFor(result, "ben")).toMatchObject({ loggedHours: 0, capacityHours: 16, utilisationPct: 0 });
  });

  it("never lists an AI agent identity or a deactivated person", async () => {
    state.rows.push(row("bot", "2026-10-01", 3), row("dana", "2026-10-01", 5));
    const result = await buildTimesheetAnalytics(october);
    expect(result.utilisation.map((r: any) => r.userId).sort()).toEqual(["asha", "ben"]);
    // Their hours are still hours somebody worked: they stay in the totals.
    expect(result.totals.hours).toBe(24);
  });

  it("limits the idle people to the project being reported on", async () => {
    const result = await buildTimesheetAnalytics({ ...october, projectId: "p1" });
    expect(result.utilisation.map((r: any) => r.userId)).toEqual(["asha"]);
  });
});

describe("which hours count", () => {
  it("is submitted + approved; drafts and rejected hours are reported as excluded", async () => {
    state.rows.push(
      row("asha", "2026-10-02", 3, { status: "SUBMITTED" }),
      row("asha", "2026-10-02", 4, { status: "DRAFT" }),
      row("asha", "2026-10-02", 2, { status: "REJECTED" })
    );
    const result = await buildTimesheetAnalytics(october);
    expect(rowFor(result, "asha").loggedHours).toBe(19);
    expect(result.totals.hours).toBe(19);
    expect(result.totals.excluded).toEqual({ draftHours: 4, rejectedHours: 2 });
  });
});

describe("how it reads the table", () => {
  it("aggregates in the database instead of loading every row, and orders the one sample it does load", async () => {
    await buildTimesheetAnalytics(october);
    // The only row-level read is the approval-latency sample: reviewed rows, newest first, columns
    // the latency needs and nothing else. It used to be `take: 20001` of fully-joined rows with no
    // order, so which rows survived the cap was up to the database.
    expect(state.findManyCalls).toHaveLength(1);
    const sample = state.findManyCalls[0];
    expect(sample.orderBy).toEqual({ reviewedAt: "desc" });
    expect(sample.include).toBeUndefined();
    expect(sample.where.reviewedAt).toEqual({ not: null });
  });

  it("prices each activity in its own currency and never adds two currencies together", async () => {
    state.rows = [
      row("asha", "2026-10-01", 8, { billedAmount: 8000, billedCurrency: "INR" }),
      row("asha", "2026-10-02", 2, { billedAmount: 100, billedCurrency: "USD" }),
      row("asha", "2026-10-02", 1, { billedAmount: null, billedCurrency: null })
    ];
    const result = await buildTimesheetAnalytics(october);
    const dev = result.activityMix.find((m: any) => m.activity === "DEVELOPMENT")!;
    expect(dev.hours).toBe(11);
    expect(dev.costByCurrency).toEqual([
      { currency: "INR", amount: 8000 },
      { currency: "USD", amount: 100 }
    ]);
    expect(dev.unratedEntries).toBe(1);
  });
});
