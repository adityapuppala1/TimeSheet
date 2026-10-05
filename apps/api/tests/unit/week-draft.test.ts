/**
 * "Draft my week" allocation (services/week-draft.service.ts#allocateWeekDraft) — the pure rules:
 * fill only the time left in a day, split by activity, quarter hours, never re-suggest a ticket
 * already logged that day, and place rows after what is already logged.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/config/prisma.js", () => ({ prisma: {} }));
const { allocateWeekDraft, activityTypeFor, mondayOf } = await import("../../src/services/week-draft.service.js");

const ticket = (id: string, over: Partial<{ moduleId: string | null; type: string }> = {}) => ({
  id,
  key: `WEB-${id}`,
  title: `Ticket ${id}`,
  type: over.type ?? "TASK",
  projectId: "p1",
  projectName: "Web",
  moduleId: over.moduleId === undefined ? "m1" : over.moduleId,
  moduleName: over.moduleId === null ? null : "Frontend"
});
const act = (day: string, ticketId: string, kind: "change" | "comment" = "change") => ({ day, ticketId, kind, at: new Date(`${day}T10:00:00`) });
const base = (overrides: Partial<Parameters<typeof allocateWeekDraft>[0]> = {}) =>
  allocateWeekDraft({
    activities: [],
    tickets: new Map([["1", ticket("1")], ["2", ticket("2")]]),
    days: [{ day: "2026-10-05", loggedHours: 0, lastEnd: null, loggedTicketIds: [] }],
    dailyCapacityHours: 8,
    fallbackModule: () => ({ id: "m0", name: "General" }),
    ...overrides
  });

describe("allocateWeekDraft", () => {
  it("splits a day's free time by activity, in quarter hours, filling the day exactly", () => {
    const rows = base({ activities: [act("2026-10-05", "1"), act("2026-10-05", "1"), act("2026-10-05", "1"), act("2026-10-05", "2")] });
    expect(rows.map((r) => [r.ticketId, r.hours])).toEqual([["1", 6], ["2", 2]]);
    expect(rows.reduce((s, r) => s + r.hours, 0)).toBe(8);
    for (const r of rows) expect((r.hours * 4) % 1).toBe(0);
  });

  it("only fills what is left of the day, starting after the last logged entry", () => {
    const rows = base({
      activities: [act("2026-10-05", "1")],
      days: [{ day: "2026-10-05", loggedHours: 5, lastEnd: "14:00", loggedTicketIds: [] }]
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ hours: 3, startTime: "14:00", endTime: "17:00" });
  });

  it("suggests nothing for a full day", () => {
    expect(base({ activities: [act("2026-10-05", "1")], days: [{ day: "2026-10-05", loggedHours: 8, lastEnd: "17:00", loggedTicketIds: [] }] })).toEqual([]);
  });

  it("never re-suggests a ticket already logged that day", () => {
    const rows = base({
      activities: [act("2026-10-05", "1"), act("2026-10-05", "2")],
      days: [{ day: "2026-10-05", loggedHours: 2, lastEnd: "11:00", loggedTicketIds: ["1"] }]
    });
    expect(rows.map((r) => r.ticketId)).toEqual(["2"]);
  });

  it("guesses the project's first module for a ticket without one, and says so", () => {
    const rows = base({ tickets: new Map([["3", ticket("3", { moduleId: null })]]), activities: [act("2026-10-05", "3")] });
    expect(rows[0]).toMatchObject({ moduleId: "m0", moduleGuessed: true });
  });

  it("skips a ticket whose project has no module at all", () => {
    const rows = base({ tickets: new Map([["3", ticket("3", { moduleId: null })]]), activities: [act("2026-10-05", "3")], fallbackModule: () => null });
    expect(rows).toEqual([]);
  });

  it("gives at least half an hour each, dropping the least active tickets when time is short", () => {
    const many = new Map(Array.from({ length: 6 }, (_, i) => [String(i), ticket(String(i))]));
    const rows = base({
      tickets: many,
      activities: Array.from({ length: 6 }, (_, i) => act("2026-10-05", String(i))),
      days: [{ day: "2026-10-05", loggedHours: 6.5, lastEnd: "16:00", loggedTicketIds: [] }]
    });
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(r.hours).toBeGreaterThanOrEqual(0.5);
    expect(rows.reduce((s, r) => s + r.hours, 0)).toBeLessThanOrEqual(1.5);
  });

  it("names the evidence in the description and sources", () => {
    const [row] = base({ activities: [act("2026-10-05", "1"), act("2026-10-05", "1", "comment")] });
    expect(row.taskDescription).toBe("WEB-1 — Ticket 1 (1 update, 1 comment)");
    expect(row.sources).toEqual([{ kind: "change", count: 1 }, { kind: "comment", count: 1 }]);
  });
});

describe("helpers", () => {
  it("maps bug-like ticket types to Bug Fixing", () => {
    expect(activityTypeFor("BUG")).toBe("Bug Fixing");
    expect(activityTypeFor("Feature")).toBe("Development");
  });
  it("finds the Monday of any day in the week", () => {
    expect(mondayOf(new Date(2026, 9, 8)).getDate()).toBe(5); // Thu 8 Oct -> Mon 5 Oct
    expect(mondayOf(new Date(2026, 9, 11)).getDate()).toBe(5); // Sun 11 Oct -> Mon 5 Oct
  });
});
