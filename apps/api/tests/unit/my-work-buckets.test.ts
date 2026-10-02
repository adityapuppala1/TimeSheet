/**
 * `computeMyWork` — the My Work page's buckets and the Inbox brief's counts (M1, M6).
 *
 *   - "Today" was UTC's day (`toDay(now)` slices an ISO string), so between 00:00 and 05:30 IST the
 *     page still thought it was yesterday: work due yesterday sat under "Due today", not "Overdue".
 *   - An SLA `dueAt` was turned into its UTC day, and "overdue" was `(endDate ?? dueAt) < today`: a
 *     ticket whose SLA had already passed but whose planned end was later never read as overdue —
 *     while the OVERDUE_ITEMS widget, by the shared rule, counted it.
 *   - Rows came back `dueAt asc`, which MySQL sorts NULLs-first.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ tickets: [] as any[], findArgs: null as any }));

vi.mock("../../src/config/prisma.js", () => ({
  prisma: {
    ticket: {
      findMany: vi.fn(async (args: any) => {
        state.findArgs = args;
        return state.tickets;
      })
    },
    ticketComment: { findMany: vi.fn(async () => []) }
  }
}));

const { computeMyWork } = await import("../../src/services/my-work.service.js");

function ticket(key: string, over: { endDate?: string | null; dueAt?: string | null }) {
  return {
    id: key,
    key,
    title: key,
    startDate: null,
    endDate: over.endDate ? new Date(`${over.endDate}T00:00:00.000Z`) : null,
    dueAt: over.dueAt ? new Date(over.dueAt) : null,
    priority: "MEDIUM",
    status: "OPEN",
    type: "TASK",
    isMilestone: false,
    progressPct: null,
    estimatedHours: null,
    workflowStatus: null,
    project: null,
    linksTo: []
  };
}

// 01:00 IST on Friday 2 October 2026 — still Thursday the 1st in UTC.
const NOW = new Date("2026-10-01T19:30:00.000Z");
const keys = (items: Array<{ key: string }>) => items.map((i) => i.key).sort();

beforeEach(() => {
  state.tickets = [];
});

describe("My Work buckets", () => {
  it("files work by the IST day, so yesterday's work is overdue after midnight IST", async () => {
    state.tickets = [ticket("ENDED-THU", { endDate: "2026-10-01" }), ticket("ENDS-FRI", { endDate: "2026-10-02" })];
    const work = await computeMyWork("u1", NOW);
    expect(keys(work.overdue)).toEqual(["ENDED-THU"]);
    expect(keys(work.today)).toEqual(["ENDS-FRI"]);
  });

  it("calls an SLA that has passed overdue, even when the planned end is later", async () => {
    state.tickets = [ticket("SLA-GONE", { endDate: "2026-10-09", dueAt: "2026-10-01T10:00:00.000Z" })];
    const work = await computeMyWork("u1", NOW);
    expect(keys(work.overdue)).toEqual(["SLA-GONE"]);
  });

  it("dates an SLA instant by its IST day", async () => {
    // 20:00 UTC on the 1st is 01:30 IST on the 2nd: due today, in half an hour.
    state.tickets = [ticket("SLA-SOON", { dueAt: "2026-10-01T20:00:00.000Z" })];
    const work = await computeMyWork("u1", NOW);
    expect(keys(work.today)).toEqual(["SLA-SOON"]);
    expect(work.today[0].deadline).toBe("2026-10-02");
  });

  it("asks for dated work first, never NULLs first", async () => {
    await computeMyWork("u1", NOW);
    expect(state.findArgs.orderBy[0]).toEqual({ dueAt: { sort: "asc", nulls: "last" } });
  });
});
