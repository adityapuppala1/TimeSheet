/**
 * The on-screen grouped report's cost, per currency (H5). Each entry's cost is frozen at approval in
 * its project's billing currency (`billedCurrency`); the report added them all into one number that
 * the panel printed with no currency at all. `costByCurrency` keeps each currency's total apart.
 */
import { describe, expect, it } from "vitest";
import { groupTimesheetRows, summariseTimesheetRows } from "../../src/services/timesheet-report.service.js";

type Row = Parameters<typeof groupTimesheetRows>[0][number];

function row(over: Partial<Record<string, unknown>>): Row {
  return {
    id: String(Math.random()),
    userId: "u1",
    projectId: "p1",
    moduleId: "m1",
    activityType: "Development",
    workDate: new Date("2026-03-04T00:00:00.000Z"),
    startTime: "09:00",
    endTime: "11:00",
    totalHours: 2,
    billable: true,
    billedAmount: null,
    billedCurrency: null,
    status: "APPROVED",
    user: { id: "u1", name: "Dev Patel", email: "dev@x.com" },
    project: { id: "p1", name: "Apollo", code: "APO" },
    module: { name: "Payments" },
    submodule: null,
    ticket: null,
    ...over
  } as unknown as Row;
}

const rows = [
  row({ billedAmount: 2000, billedCurrency: "INR" }),
  row({ billedAmount: 1000, billedCurrency: "INR" }),
  row({ billedAmount: 50, billedCurrency: "USD", userId: "u2", user: { id: "u2", name: "Ana", email: "a@x.com" } }),
  row({ billedAmount: null })
];

describe("cost per currency", () => {
  it("totals each currency apart, largest first", () => {
    expect(summariseTimesheetRows(rows).costByCurrency).toEqual([
      { currency: "INR", amount: 3000 },
      { currency: "USD", amount: 50 }
    ]);
  });

  it("does the same inside every group", () => {
    const byUser = groupTimesheetRows(rows, "user");
    const dev = byUser.find((g) => g.label === "Dev Patel")!;
    expect(dev.costByCurrency).toEqual([{ currency: "INR", amount: 3000 }]);
    expect(dev.unratedEntries).toBe(1);
  });

  it("is empty — not a zero — when nothing carries a rate", () => {
    expect(summariseTimesheetRows([row({})]).costByCurrency).toEqual([]);
  });
});
