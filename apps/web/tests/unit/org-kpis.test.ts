import { describe, expect, it } from "vitest";
import { deltaPoints, leaveUtilisation, orgKpis, previousRange, sparklinePoints, splitInsightDetail } from "../../src/lib/org-kpis";
import type { OrgAnalytics } from "../../src/services/attendance-api";

const org = (over: Partial<OrgAnalytics> = {}): OrgAnalytics =>
  ({
    audience: "org",
    range: { from: "2026-11-01", to: "2026-11-30", days: 30, workingDays: 20 },
    minGroupSize: 5,
    lateness: { enabled: false, expectedStartMinute: 570 },
    overall: {
      people: 10,
      suppressed: false,
      aggregates: { presenceRate: 0.94, absenceRate: 0.06, punchHistogram: [], presentNoTimesheet: { days: 0, rate: null }, missedReasons: {}, absencesByWeekday: [] }
    },
    trend: [
      { date: "2026-11-02", presenceRate: 0.9, absenceRate: 0.1, present: 9, absent: 1 },
      { date: "2026-11-03", presenceRate: 1, absenceRate: 0, present: 10, absent: 0 }
    ],
    hours: { logged: 36, expected: 40 },
    byManager: [],
    bySource: [],
    face: { suppressed: true, checks: null, passRate: null, flagRate: null },
    loginHistogram: { suppressed: true, hours: null },
    integrations: [],
    holidays: { dates: 0, personDays: 0 },
    upcomingHolidays: [],
    leave: { audience: "org", utilisation: [{ code: "PL", name: "Privilege", days: 20, people: 4 }], upcoming: { requests: 0, people: 0, entries: null }, coverage: null, expiring: null },
    ...over
  }) as OrgAnalytics;

describe("orgKpis", () => {
  it("is four cards at most: attendance, absence, hours, leave", () => {
    const kpis = orgKpis(org());
    expect(kpis.map((k) => k.id)).toEqual(["attendance", "absence", "hours", "leave"]);
    expect(kpis[0]).toMatchObject({ value: "94%", series: [0.9, 1] });
    expect(kpis[2].value).toBe("36 / 40h");
    expect(kpis[2].raw).toBeCloseTo(0.9);
  });
  it("leave utilisation is days over person-working-days", () => {
    expect(leaveUtilisation(org())).toBeCloseTo(20 / (10 * 20));
    expect(orgKpis(org())[3].value).toBe("10%");
  });
  it("shows a dash, never 0%, when the group is suppressed, and drops the leave card when leave is off", () => {
    const suppressed = org({ overall: { people: 3, suppressed: true, aggregates: null }, trend: null, hours: null, leave: null });
    const kpis = orgKpis(suppressed);
    expect(kpis.map((k) => k.id)).toEqual(["attendance", "absence", "hours"]);
    expect(kpis.map((k) => k.value)).toEqual(["—", "—", "—"]);
    expect(kpis[0].series).toBeNull();
  });
});

describe("deltaPoints", () => {
  it("reports percentage points with a direction", () => {
    expect(deltaPoints(0.94, 0.91)).toEqual({ direction: "up", text: "+3 pts" });
    expect(deltaPoints(0.9, 0.925)).toEqual({ direction: "down", text: "−2.5 pts" });
    expect(deltaPoints(0.9, 0.9)).toEqual({ direction: "flat", text: "No change" });
  });
  it("is null when either side is unknown", () => {
    expect(deltaPoints(null, 0.9)).toBeNull();
    expect(deltaPoints(0.9, null)).toBeNull();
  });
});

describe("previousRange", () => {
  it("is the same length, ending the day before", () => {
    expect(previousRange("2026-11-01", "2026-11-30")).toEqual({ from: "2026-10-02", to: "2026-10-31" });
    expect(previousRange("2026-11-24", "2026-11-30")).toEqual({ from: "2026-11-17", to: "2026-11-23" });
  });
});

describe("splitInsightDetail", () => {
  it("makes the last sentence the suggested action", () => {
    expect(splitInsightDetail("Most gaps are forgetfulness. Switching on the reminder usually closes them.")).toEqual({
      evidence: "Most gaps are forgetfulness.",
      action: "Switching on the reminder usually closes them."
    });
  });
  it("keeps a single sentence as evidence only", () => {
    expect(splitInsightDetail("Nothing else to say.")).toEqual({ evidence: "Nothing else to say.", action: null });
  });
});

describe("sparklinePoints", () => {
  it("scales values into the box and needs two points", () => {
    expect(sparklinePoints([1], 10, 10)).toBe("");
    const pts = sparklinePoints([0, 5, 10], 20, 10, 0).split(" ");
    expect(pts).toEqual(["0,10", "10,5", "20,0"]);
  });
});
