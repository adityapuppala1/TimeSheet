/**
 * The Monday digest's own figures.
 *
 * THE DEFECTS (audit 2026-10, timesheets smaller / notifications minor):
 *  - The in-app line said "Xh approved", but X came from an aggregate with no status filter — drafts,
 *    pending and REJECTED hours included — while the email's own tables count approved hours only.
 *  - The ticket and change counts used UTC-midnight bounds for TIMESTAMPS (`createdAt`,
 *    `resolvedAt`, `updatedAt`): right for `workDate`, a date column stored at UTC midnight, but
 *    5h30 adrift of the worker's own India-local week for anything that is an instant.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  hoursByStatus: [] as Array<{ status: string; hours: number }>
}));

vi.mock("../../src/config/prisma.js", () => ({
  prisma: {
    user: { findMany: vi.fn(async () => [{ id: "emp-1", name: "Eve Employee", _count: { reports: 0 } }]) },
    notification: { count: vi.fn(async () => 0) },
    ticket: { count: vi.fn(async () => 0), findMany: vi.fn(async () => []) },
    timesheet: {
      // The unfiltered total the old code read — every status, rejected included.
      aggregate: vi.fn(async () => ({ _sum: { totalHours: state.hoursByStatus.reduce((s, r) => s + r.hours, 0) } })),
      groupBy: vi.fn(async () => state.hoursByStatus.map((r) => ({ status: r.status, _sum: { totalHours: r.hours } })))
    }
  }
}));
vi.mock("../../src/services/ai.service.js", () => ({
  getGlobalAISettings: vi.fn(async () => ({ weeklyDigestEnabled: true, aiEnabled: false })),
  generateWeeklyDigest: vi.fn()
}));
vi.mock("../../src/services/principal.service.js", () => ({ loadRequestUser: vi.fn(async () => ({ permissions: [] })) }));
vi.mock("../../src/services/notify.service.js", () => ({ dispatchNotification: vi.fn(async () => undefined) }));
vi.mock("../../src/services/weekly-digest-data.service.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/services/weekly-digest-data.service.js")>(
    "../../src/services/weekly-digest-data.service.js"
  );
  return { ...actual, buildDigestTables: vi.fn(async () => "") };
});

const { runWeeklyDigest } = await import("../../src/workers/weekly-digest.worker.js");
const { buildPeriods } = await import("../../src/services/weekly-digest-data.service.js");
const { dispatchNotification } = await import("../../src/services/notify.service.js");

beforeEach(() => {
  vi.mocked(dispatchNotification).mockClear();
});

describe("the in-app digest line", () => {
  it("says approved hours, and counts only approved hours", async () => {
    state.hoursByStatus = [
      { status: "APPROVED", hours: 3 },
      { status: "SUBMITTED", hours: 5 },
      { status: "REJECTED", hours: 4 }
    ];
    await runWeeklyDigest(new Date("2026-10-05T04:30:00.000Z"));
    const body = vi.mocked(dispatchNotification).mock.calls[0][0].body;
    expect(body).toMatch(/^3\.0h approved/);
  });

  it("still sends to an employee whose only hours last week are awaiting approval", async () => {
    state.hoursByStatus = [{ status: "SUBMITTED", hours: 5 }];
    await runWeeklyDigest(new Date("2026-10-05T04:30:00.000Z"));
    expect(dispatchNotification).toHaveBeenCalledTimes(1);
    expect(vi.mocked(dispatchNotification).mock.calls[0][0].body).toMatch(/^0\.0h approved/);
  });
});

describe("digest period bounds", () => {
  it("keeps UTC-midnight days for workDate, and local-midnight instants for timestamps", () => {
    // Monday 5 October 2026, 10:00 in India. Last week is Mon 28 Sep – Sun 4 Oct, India time.
    const now = new Date("2026-10-05T04:30:00.000Z");
    const weekFrom = new Date("2026-09-27T18:30:00.000Z"); // Mon 28 Sep 00:00 IST
    const weekTo = new Date("2026-10-04T18:30:00.000Z"); // Mon 5 Oct 00:00 IST
    const periods = buildPeriods(now, weekFrom, weekTo, "Sep 28 - Oct 4");
    expect(periods.week.from).toEqual(new Date("2026-09-28T00:00:00.000Z"));
    expect(periods.week.to).toEqual(new Date("2026-10-05T00:00:00.000Z"));
    expect(periods.week.fromInstant).toEqual(weekFrom);
    expect(periods.week.toInstant).toEqual(weekTo);
  });
});
