import { describe, expect, it } from "vitest";
import {
  balanceChange,
  buildIcs,
  canCancel,
  dateRangeText,
  dayLoads,
  excludedText,
  fallsOnNote,
  filterRequests,
  foldIcsLine,
  formatDays,
  groupByMonth,
  negativeBalanceMessage,
  overlapLine,
  relativeDay,
  requestRangeText,
  summaryLine,
  teamMatrix
} from "../../src/lib/leave-ui";
import type { TeamLeaveItem } from "../../src/services/leave-api";

const item = (id: string, userId: string, startDate: string, endDate: string, status: TeamLeaveItem["status"] = "APPROVED"): TeamLeaveItem => ({
  id,
  user: { id: userId, name: `User ${userId}`, email: `${userId}@x.io`, avatarUrl: null },
  leaveType: { id: "t", code: "PL", name: "Privilege leave", colour: "primary", isPaid: true },
  startDate,
  endDate,
  startHalf: "FULL",
  endHalf: "FULL",
  days: 1,
  leaveYear: 2026,
  status,
  approverId: null,
  decidedAt: null,
  overriddenBySuperAdmin: false,
  cancelledAt: null,
  source: "WEB",
  createdAt: "2026-11-01T00:00:00Z"
});

describe("leave wording", () => {
  it("formats days and ranges", () => {
    expect(formatDays(1)).toBe("1 day");
    expect(formatDays(2.5)).toBe("2.5 days");
    expect(formatDays(0.5)).toBe("0.5 days");
    expect(dateRangeText("2026-11-12", "2026-11-12")).toBe("12 Nov");
    expect(dateRangeText("2026-11-12", "2026-11-14")).toBe("12–14 Nov");
    expect(dateRangeText("2026-11-30", "2026-12-02")).toBe("30 Nov – 2 Dec");
    expect(requestRangeText({ startDate: "2026-11-12", endDate: "2026-11-12", startHalf: "FIRST_HALF", endHalf: "FIRST_HALF", days: 0.5 })).toBe(
      "12 Nov (first half) · 0.5 days"
    );
  });
  it("summarises the preview and the balance change", () => {
    expect(summaryLine(null)).toBe("Pick your dates");
    expect(summaryLine({ days: 3, balanceAfter: 3.5, ok: true })).toBe("3 days · balance 3.5");
    expect(balanceChange({ balanceBefore: 6.5, balanceAfter: 3.5 })).toBe("Balance 6.5 → 3.5");
    expect(balanceChange({ balanceBefore: null, balanceAfter: null })).toBeNull();
  });
  it("explains what was excluded, once per label", () => {
    expect(
      excludedText([
        { date: "2026-11-14", reason: "WEEKEND", label: "Saturday" },
        { date: "2026-11-15", reason: "WEEKEND", label: "Sunday" },
        { date: "2026-11-21", reason: "WEEKEND", label: "Saturday" },
        { date: "2026-11-09", reason: "HOLIDAY", label: "Diwali" }
      ])
    ).toBe("excludes Sat, Sun, Diwali");
    expect(excludedText([])).toBeNull();
  });
  it("states the negative-balance policy only when the balance goes below zero", () => {
    expect(negativeBalanceMessage({ balanceAfter: 2, allowNegative: false }, "PL")).toBeNull();
    expect(negativeBalanceMessage({ balanceAfter: -1, allowNegative: false }, "PL")).toMatch(/cannot go below zero/);
    expect(negativeBalanceMessage({ balanceAfter: -1, allowNegative: true }, "PL")).toMatch(/allows that/);
  });
  it("says how far away a day is", () => {
    expect(relativeDay("2026-11-23", "2026-11-23")).toBe("Today");
    expect(relativeDay("2026-11-24", "2026-11-23")).toBe("Tomorrow");
    expect(relativeDay("2026-12-05", "2026-11-23")).toBe("in 12 days");
    expect(relativeDay("2026-11-20", "2026-11-23")).toBe("3 days ago");
  });
});

describe("my requests", () => {
  const rows = [
    { id: "a", status: "PENDING" as const, startDate: "2026-12-01", endDate: "2026-12-02" },
    { id: "b", status: "APPROVED" as const, startDate: "2026-11-02", endDate: "2026-11-03" },
    { id: "c", status: "REJECTED" as const, startDate: "2026-12-10", endDate: "2026-12-10" }
  ];
  it("filters by chip", () => {
    expect(filterRequests(rows, "ALL", "2026-11-23")).toHaveLength(3);
    expect(filterRequests(rows, "PENDING", "2026-11-23").map((r) => r.id)).toEqual(["a"]);
    expect(filterRequests(rows, "PAST", "2026-11-23").map((r) => r.id)).toEqual(["b"]);
  });
  it("lets a pending request be cancelled, an approved one only before it starts", () => {
    expect(canCancel({ status: "PENDING", startDate: "2026-11-01" }, "2026-11-23")).toBe(true);
    expect(canCancel({ status: "APPROVED", startDate: "2026-12-01" }, "2026-11-23")).toBe(true);
    expect(canCancel({ status: "APPROVED", startDate: "2026-11-20" }, "2026-11-23")).toBe(false);
    expect(canCancel({ status: "REJECTED", startDate: "2026-12-01" }, "2026-11-23")).toBe(false);
  });
});

describe("team calendar busy days", () => {
  const days = ["2026-11-23", "2026-11-24", "2026-11-25", "2026-11-28"];
  it("marks a day busy when the configured share of the team is off, not before", () => {
    const items = [
      item("1", "a", "2026-11-24", "2026-11-25"),
      item("2", "b", "2026-11-24", "2026-11-24"),
      item("3", "c", "2026-11-28", "2026-11-28"),
      item("4", "d", "2026-11-28", "2026-11-28")
    ];
    const loads = dayLoads(days, items, 8, 0.25);
    expect(loads.map((l) => l.off)).toEqual([0, 2, 1, 2]);
    // 28 Nov is a Saturday: never busy.
    expect(loads.map((l) => l.busy)).toEqual([false, true, false, false]);
  });
  it("needs at least two people off, and ignores rejected and cancelled leave", () => {
    expect(dayLoads(["2026-11-24"], [item("1", "a", "2026-11-24", "2026-11-24")], 2, 0.25)[0].busy).toBe(false);
    const gone = [item("1", "a", "2026-11-24", "2026-11-24", "REJECTED"), item("2", "b", "2026-11-24", "2026-11-24", "CANCELLED")];
    expect(dayLoads(["2026-11-24"], gone, 3, 0.1)[0].off).toBe(0);
  });
  it("lets pending leave count toward load", () => {
    const items = [item("1", "a", "2026-11-24", "2026-11-24", "PENDING"), item("2", "b", "2026-11-24", "2026-11-24")];
    expect(dayLoads(["2026-11-24"], items, 4, 0.25)[0]).toMatchObject({ off: 2, busy: true });
  });
  it("builds a people-by-day matrix, with people on leave first and approved over pending", () => {
    const m = teamMatrix(
      [
        { id: "z", name: "Zed", avatarUrl: null },
        { id: "a", name: "Ann", avatarUrl: null }
      ],
      [item("1", "z", "2026-11-24", "2026-11-25", "PENDING"), item("2", "z", "2026-11-25", "2026-11-25")]
    );
    expect(m.rows.map((r) => r.id)).toEqual(["z", "a"]);
    expect(m.cell("z", "2026-11-24")!.status).toBe("PENDING");
    expect(m.cell("z", "2026-11-25")!.status).toBe("APPROVED");
    expect(m.cell("a", "2026-11-24")).toBeNull();
  });
});

describe("overlapLine", () => {
  const req = { id: "r", startDate: "2026-11-24", endDate: "2026-11-26", user: { id: "me", name: "Me", email: "", avatarUrl: null } };
  it("counts other people, advisory only, and names the first shared day", () => {
    const team = [
      item("1", "a", "2026-11-25", "2026-11-27"),
      item("2", "b", "2026-11-24", "2026-11-24"),
      item("3", "me", "2026-11-24", "2026-11-26"),
      item("4", "c", "2026-12-10", "2026-12-11")
    ];
    expect(overlapLine(req, team)).toBe("2 others off 24 Nov");
  });
  it("is null when nobody overlaps", () => {
    expect(overlapLine(req, [item("4", "c", "2026-12-10", "2026-12-11")])).toBeNull();
  });
});

describe("holidays", () => {
  it("notes a holiday on a non-working day", () => {
    expect(fallsOnNote("2026-11-22")).toBe("Falls on Sunday");
    expect(fallsOnNote("2026-11-23")).toBeNull();
    expect(fallsOnNote("2026-11-21", [1, 2, 3, 4, 5, 6])).toBeNull();
  });
  it("groups by month in date order", () => {
    const g = groupByMonth([{ date: "2026-12-25" }, { date: "2026-11-01" }, { date: "2026-12-01" }]);
    expect(g.map((x) => [x.month, x.items.length])).toEqual([
      ["2026-11", 1],
      ["2026-12", 2]
    ]);
  });
});

describe("buildIcs", () => {
  const ics = buildIcs(
    [
      { date: "2026-12-25", name: "Christmas, Day; observed", isOptional: false },
      { date: "2026-12-31", name: "New Year Eve", isOptional: true }
    ],
    "India 2026",
    new Date("2026-11-23T10:20:30Z")
  );
  it("is a CRLF calendar with one all-day event per holiday", () => {
    expect(ics.startsWith("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n")).toBe(true);
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(2);
    expect(ics).toContain("DTSTART;VALUE=DATE:20261225");
    expect(ics).toContain("DTEND;VALUE=DATE:20261226");
    expect(ics).toContain("DTEND;VALUE=DATE:20270101");
    expect(ics).toContain("DTSTAMP:20261123T102030Z");
    expect(ics).toContain("X-WR-CALNAME:India 2026");
  });
  it("escapes commas and semicolons and marks optional holidays", () => {
    expect(ics).toContain("SUMMARY:Christmas\\, Day\\; observed");
    expect(ics).toContain("SUMMARY:New Year Eve (optional)");
  });
  it("never leaves a bare newline and folds long lines at 75 octets", () => {
    expect(ics.replaceAll("\r\n", "").includes("\n")).toBe(false);
    const folded = foldIcsLine(`SUMMARY:${"é".repeat(60)}`);
    for (const line of folded.split("\r\n")) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    expect(folded.split("\r\n").slice(1).every((l) => l.startsWith(" "))).toBe(true);
  });
});

describe("sandwichedText (7.0.0)", () => {
  it("says nothing when no day is sandwiched, and counts them otherwise", async () => {
    const { sandwichedText } = await import("../../src/lib/leave-ui");
    expect(sandwichedText(undefined)).toBeNull();
    expect(sandwichedText([])).toBeNull();
    expect(sandwichedText(["2026-11-28"])).toMatch(/1 enclosed weekend or holiday day /);
    expect(sandwichedText(["2026-11-28", "2026-11-29"])).toMatch(/2 enclosed .* days/);
  });
});
