/**
 * The Practice Update's figures against the shared definitions (M10, M6).
 *
 *   - Every hours figure (total, billable, contributors, per project, per activity, the project
 *     owner, the "work done" highlights) counted DRAFT and REJECTED hours. Logged hours are
 *     submitted + approved.
 *   - The ticket "SLA breaches" and per-project overdue counts read `slaBreachAt`, which only the
 *     TICKET_SLA_ENABLED sweep writes; the approval-SLA count read the timesheet sweep's stamp. Both
 *     come from the due date / deadline now.
 *
 * A recording stand-in answers every query with an empty result: what is under test is which rows
 * each figure asks for.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => [] as Array<{ model: string; op: string; args: any }>);

vi.mock("../../src/config/prisma.js", () => {
  const empty = (op: string) => {
    if (op === "count") return 0;
    if (op === "aggregate") return { _sum: { totalHours: 0, costUsdEstimate: null }, _count: 0 };
    if (op === "findUnique" || op === "findFirst") return null;
    return [];
  };
  const model = (name: string) =>
    new Proxy(
      {},
      {
        get: (_t, op: string) => (args: any) => {
          calls.push({ model: name, op, args });
          return Promise.resolve(empty(op));
        }
      }
    );
  // `$queryRaw` is a function, not a model: recorded, and answered with no rows.
  const raw = (name: string) => (query: any) => {
    calls.push({ model: name, op: "raw", args: query });
    return Promise.resolve([]);
  };
  return { prisma: new Proxy({}, { get: (_t, name: string) => (name.startsWith("$") ? raw(name) : model(name)) }) };
});
vi.mock("../../src/services/change.service.js", () => ({ isChangeManagementOn: vi.fn(async () => false) }));
vi.mock("../../src/services/planning.service.js", () => ({
  getPlanningSettings: vi.fn(async () => ({ workingDays: [1, 2, 3, 4, 5], defaultWeeklyCapacityHours: 40 }))
}));

const { buildPracticeUpdateData } = await import("../../src/services/practice-update.service.js");

beforeEach(() => {
  calls.length = 0;
});

const from = new Date("2026-09-21T00:00:00.000Z");
const to = new Date("2026-09-27T00:00:00.000Z");

describe("practice update hours", () => {
  it("counts logged hours only — submitted and approved — in every hours figure", async () => {
    await buildPracticeUpdateData(from, to, "21–27 Sep");
    const hourReads = calls.filter(
      (c) => c.model === "timesheet" && ["aggregate", "groupBy", "findMany"].includes(c.op) && c.args?.where?.workDate
    );
    expect(hourReads.length).toBeGreaterThanOrEqual(8);
    for (const read of hourReads) {
      expect(read.args.where.status, JSON.stringify(read.args.where)).toEqual({ in: ["SUBMITTED", "APPROVED"] });
    }
  });
});

describe("practice update SLA figures", () => {
  it("never reads the sweeps' stamps", async () => {
    await buildPracticeUpdateData(from, to, "21–27 Sep");
    const stamped = calls.filter((c) => c.args?.where?.slaBreachAt);
    expect(stamped).toEqual([]);
  });

  it("counts approval-SLA breaches in the database instead of loading the period's deadlines", async () => {
    await buildPracticeUpdateData(from, to, "21–27 Sep");
    expect(calls.filter((c) => c.model === "timesheet" && c.args?.where?.approvalDeadline)).toEqual([]);
    const counts = calls.filter((c) => c.model === "$queryRaw" && /approvalDeadline/.test(c.args?.sql ?? ""));
    // The period, the period before it, and the per-project breakdown.
    expect(counts.length).toBeGreaterThanOrEqual(2);
    for (const c of counts) expect(c.args.sql).toMatch(/t\.reviewedAt IS NULL OR t\.reviewedAt > t\.approvalDeadline/);
  });

  it("counts a ticket breached when it is open and past its due date", async () => {
    await buildPracticeUpdateData(from, to, "21–27 Sep");
    // Not the "due next week" count (which has a lower bound) and not the critical-only one.
    const breach = calls.find(
      (c) => c.model === "ticket" && c.op === "count" && c.args?.where?.dueAt?.lt && !c.args.where.dueAt.gte && !c.args.where.priority
    );
    expect(breach?.args.where).toMatchObject({ status: { notIn: ["RESOLVED", "CLOSED"] }, dueAt: { lt: expect.any(Date) } });
  });
});
