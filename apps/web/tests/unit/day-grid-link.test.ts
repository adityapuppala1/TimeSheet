import { describe, expect, it } from "vitest";
import { dayLink, dayOffPrompt } from "../../src/lib/day-grid";

const me = { id: "u1", canSeeTeam: false };

describe("dayLink", () => {
  it("links a holiday to the holiday calendar", () => {
    expect(dayLink({ status: "HOLIDAY" } as never, "u2", me)?.to).toBe("/app/attendance/leave/holidays");
  });
  it("links your own leave to your requests", () => {
    expect(dayLink({ status: "LEAVE" } as never, "u1", me)?.to).toBe("/app/attendance/leave/requests");
  });
  it("links someone else's leave only for a viewer who can see the team", () => {
    expect(dayLink({ status: "LEAVE" } as never, "u2", me)).toBeNull();
    expect(dayLink({ status: "LEAVE" } as never, "u2", { id: "u1", canSeeTeam: true })?.to).toBe("/app/attendance/team");
  });
  it("does not link an ordinary day", () => {
    expect(dayLink({ status: "PRESENT" } as never, "u1", me)).toBeNull();
    expect(dayLink(undefined, "u1", me)).toBeNull();
  });
});

describe("dayOffPrompt", () => {
  it("names the leave type or the holiday", () => {
    expect(dayOffPrompt({ status: "LEAVE", leaveTypeCode: "PL" }, true)).toBe("You're on leave today (PL)");
    expect(dayOffPrompt({ status: "LEAVE", leaveTypeCode: "PL" }, false)).toBe("You're on leave on this day (PL)");
    expect(dayOffPrompt({ status: "HOLIDAY", holidayName: "Diwali" }, true)).toBe("Holiday: Diwali");
    expect(dayOffPrompt({ status: "PRESENT" }, true)).toBeNull();
  });
});
