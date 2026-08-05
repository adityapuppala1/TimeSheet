/**
 * Tests for the shared timesheet-report filter and grouping.
 *
 * The property worth protecting most: every grouping of the same rows must total to the same
 * hours. A report where "by user" and "by project" disagree is worse than no report — somebody
 * will act on whichever they happened to open, and there is nothing on screen to say the other
 * exists.
 */
import { describe, expect, it } from "vitest";
import {
  buildTimesheetWhere,
  groupTimesheetRows,
  GROUP_BY_KEYS,
  type GroupByKey
} from "../../src/services/timesheet-report.service.js";

type Row = Parameters<typeof groupTimesheetRows>[0][number];

function row(over: Partial<Record<string, unknown>> = {}): Row {
  return {
    id: "t1",
    userId: "u1",
    projectId: "p1",
    moduleId: "m1",
    submoduleId: null,
    ticketId: null,
    activityType: "Development",
    workDate: new Date("2026-03-04T00:00:00.000Z"),
    totalHours: 2,
    billable: true,
    billedAmount: null,
    status: "APPROVED",
    user: { id: "u1", name: "Dev Patel", email: "dev@x.com" },
    project: { id: "p1", name: "Apollo", code: "APO" },
    module: { name: "Payments" },
    submodule: null,
    ticket: null,
    ...over
  } as unknown as Row;
}

describe("buildTimesheetWhere", () => {
  it("always excludes soft-deleted rows, and does not let a caller ask for them", () => {
    // A deleted entry is one somebody retracted. An export that resurrects it into a
    // client-facing document would report work that was explicitly withdrawn.
    const where = buildTimesheetWhere({ status: "APPROVED" } as never);
    expect(where.deletedAt).toBeNull();
    expect(Object.keys(where)).not.toContain("includeDeleted");
  });

  it("treats both date bounds as inclusive whole days", () => {
    // workDate is @db.Date, so `lte` on the `to` day includes that whole day. Adding the usual
    // "+1 day exclusive" here would silently include a day nobody asked for.
    const where = buildTimesheetWhere({ from: "2026-03-01", to: "2026-03-31" });
    expect(where.workDate).toEqual({
      gte: new Date("2026-03-01T00:00:00.000Z"),
      lte: new Date("2026-03-31T00:00:00.000Z")
    });
  });

  it("omits a filter entirely when it wasn't asked for, rather than matching on undefined", () => {
    const where = buildTimesheetWhere({});
    expect(where).toEqual({ deletedAt: null });
  });

  it("distinguishes billable=false from billable unset", () => {
    // `false` is a real question ("show me the non-billable time"), and a truthiness check would
    // silently turn it into "don't filter" — which answers a completely different question.
    expect(buildTimesheetWhere({ billable: false }).billable).toBe(false);
    expect(buildTimesheetWhere({ billable: true }).billable).toBe(true);
    expect(buildTimesheetWhere({}).billable).toBeUndefined();
  });
});

describe("groupTimesheetRows", () => {
  const rows = [
    row({ id: "a", userId: "u1", totalHours: 3, activityType: "Development" }),
    row({ id: "b", userId: "u2", totalHours: 2, activityType: "Testing", user: { id: "u2", name: "Mira", email: "m@x.com" } }),
    row({ id: "c", userId: "u1", totalHours: 1.5, activityType: "Development" })
  ];

  it("totals identically no matter how the same rows are grouped", () => {
    const totals = GROUP_BY_KEYS.map((key: GroupByKey) =>
      groupTimesheetRows(rows, key).reduce((sum, g) => sum + g.hours, 0)
    );
    expect(new Set(totals.map((t) => t.toFixed(2))).size).toBe(1);
    expect(totals[0]).toBeCloseTo(6.5, 5);
  });

  it("counts distinct people per group, not entries", () => {
    const byActivity = groupTimesheetRows(rows, "activity");
    const dev = byActivity.find((g) => g.key === "Development")!;
    expect(dev.entries).toBe(2);
    expect(dev.people).toBe(1);
  });

  it("reports cost as NULL when nothing in the group carries a rate — never zero", () => {
    // £0 reads as "this work was free". Rows approved before rate snapshots existed have no rate
    // and are deliberately never backfilled, so the honest answer is "we don't know".
    const group = groupTimesheetRows([row({ billedAmount: null })], "user")[0];
    expect(group.cost).toBeNull();
    expect(group.unratedEntries).toBe(1);
  });

  it("reports the part it knows when a group is only partly rated, and says how much it doesn't", () => {
    const group = groupTimesheetRows(
      [row({ id: "a", billedAmount: 100 }), row({ id: "b", billedAmount: null })],
      "user"
    )[0];
    expect(group.cost).toBe(100);
    expect(group.unratedEntries).toBe(1);
    expect(group.entries).toBe(2);
  });

  it("keeps un-ticketed work as its own bucket rather than dropping it", () => {
    // For most workspaces this is the majority of hours; excluding it would make every total
    // understate reality while looking complete.
    const groups = groupTimesheetRows([row({ ticketId: null })], "ticket");
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe("No ticket");
  });

  it("separates billable from total hours", () => {
    const group = groupTimesheetRows(
      [row({ id: "a", totalHours: 4, billable: true }), row({ id: "b", totalHours: 3, billable: false })],
      "user"
    )[0];
    expect(group.hours).toBe(7);
    expect(group.billableHours).toBe(4);
  });

  it("orders time buckets chronologically and everything else biggest-first", () => {
    const spread = [
      row({ id: "a", workDate: new Date("2026-03-10T00:00:00.000Z"), totalHours: 1 }),
      row({ id: "b", workDate: new Date("2026-01-05T00:00:00.000Z"), totalHours: 9 })
    ];
    expect(groupTimesheetRows(spread, "month").map((g) => g.key)).toEqual(["2026-01", "2026-03"]);
    // Non-time groupings answer "where did the hours go", so the biggest bucket leads.
    const byUser = groupTimesheetRows(
      [row({ id: "a", userId: "u1", totalHours: 1 }), row({ id: "b", userId: "u2", totalHours: 9, user: { id: "u2", name: "Mira", email: "m@x.com" } })],
      "user"
    );
    expect(byUser[0].hours).toBe(9);
  });

  it("uses Monday as the start of a week", () => {
    // 2026-03-04 is a Wednesday; its week must key to the Monday before it, matching the AI usage
    // trend so two reports on one screen cannot disagree about where a week begins.
    const groups = groupTimesheetRows([row({ workDate: new Date("2026-03-04T00:00:00.000Z") })], "week");
    expect(groups[0].key).toBe("2026-03-02");
  });

  it("records the real first and last date in each group", () => {
    const group = groupTimesheetRows(
      [
        row({ id: "a", workDate: new Date("2026-03-20T00:00:00.000Z") }),
        row({ id: "b", workDate: new Date("2026-03-02T00:00:00.000Z") })
      ],
      "user"
    )[0];
    expect(group.firstDate).toBe("2026-03-02");
    expect(group.lastDate).toBe("2026-03-20");
  });

  it("returns nothing for no rows rather than a zero-filled shell", () => {
    expect(groupTimesheetRows([], "user")).toEqual([]);
  });
});
