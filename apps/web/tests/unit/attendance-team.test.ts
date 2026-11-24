import { describe, expect, it } from "vitest";
import { groupTimelineByDay, relativeTime, summarizeStatuses } from "../../src/lib/attendance-team";

describe("summarizeStatuses", () => {
  it("counts every status and zero-fills the rest", () => {
    const out = summarizeStatuses([{ status: "PRESENT" }, { status: "PRESENT" }, { status: "ABSENT" }]);
    expect(out).toEqual({ PRESENT: 2, PENDING: 0, ABSENT: 1, HOLIDAY: 0, WEEKEND: 0, LEAVE: 0 });
  });
});

describe("groupTimelineByDay", () => {
  const events = [
    { at: "2026-11-23T10:00:00Z", kind: "b" },
    { at: "2026-11-22T09:00:00Z", kind: "a" },
    { at: "2026-11-23T04:00:00Z", kind: "c" }
  ];

  it("groups newest day first, oldest event first within the day", () => {
    const out = groupTimelineByDay(events, "UTC");
    expect(out.map((d) => d.dateKey)).toEqual(["2026-11-23", "2026-11-22"]);
    expect(out[0].events.map((e) => e.kind)).toEqual(["c", "b"]);
  });

  it("uses the viewer's zone to decide the day", () => {
    // 2026-11-23T04:00Z is still the 22nd in New York.
    const out = groupTimelineByDay(events, "America/New_York");
    expect(out.find((d) => d.dateKey === "2026-11-22")?.events.map((e) => e.kind)).toEqual(["a", "c"]);
  });
});

describe("relativeTime", () => {
  const now = new Date("2026-11-23T12:00:00Z");
  it("reads naturally", () => {
    expect(relativeTime("2026-11-23T11:59:30Z", now)).toBe("just now");
    expect(relativeTime("2026-11-23T11:55:00Z", now)).toBe("5m ago");
    expect(relativeTime("2026-11-23T09:00:00Z", now)).toBe("3h ago");
    expect(relativeTime("2026-11-21T12:00:00Z", now)).toBe("2d ago");
  });
});
