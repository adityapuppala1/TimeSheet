/**
 * The daily history behind the metric cards' sparklines.
 *
 * The invariant that matters most is the LAST POINT: it must equal the live count the card prints
 * above the chart. The series is built by walking backwards from that count, so anything that
 * breaks the replay shows up as a chart ending somewhere other than its own headline — which is
 * exactly the kind of wrongness nobody notices, because a sparkline has no axis to check it against.
 *
 * The rest pins the replay itself: undoing a transition puts the ticket back where it came from,
 * undoing a creation removes it entirely, and both have to happen in reverse chronological order or
 * a ticket that moved twice in one window lands in the wrong bucket.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const ticketFindMany = vi.fn().mockResolvedValue([]);
const auditFindMany = vi.fn().mockResolvedValue([]);
const auditCount = vi.fn().mockResolvedValue(0);

vi.mock("../../src/config/prisma.js", () => ({
  prisma: {
    ticket: { findMany: (...a: unknown[]) => ticketFindMany(...a) },
    auditLog: { findMany: (...a: unknown[]) => auditFindMany(...a), count: (...a: unknown[]) => auditCount(...a) }
  }
}));

const { buildTicketMetricSeries, METRIC_WINDOW_DAYS } = await import("../../src/services/ticket-metrics.service.js");

/** `daysAgo` days before today, at midday UTC — safely inside that day whatever the clock says. */
function daysAgo(n: number): Date {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 12));
  d.setUTCDate(d.getUTCDate() - n);
  return d;
}

/**
 * The service issues two `ticket.findMany` calls: [0] tickets created in the window, [1] the
 * visibility check over the ids the audit rows named.
 */
function withTickets(created: unknown[], visible?: unknown[]) {
  ticketFindMany.mockReset();
  ticketFindMany.mockResolvedValueOnce(created).mockResolvedValueOnce(visible ?? []);
}

beforeEach(() => {
  vi.clearAllMocks();
  ticketFindMany.mockResolvedValue([]);
  auditFindMany.mockResolvedValue([]);
  auditCount.mockResolvedValue(0);
});

describe("shape", () => {
  it("returns one point per day, oldest first, ending today", async () => {
    const s = await buildTicketMetricSeries({}, { OPEN: 3 }, { LOW: 3 });
    expect(s.days).toHaveLength(METRIC_WINDOW_DAYS);
    expect(s.byStatus.OPEN).toHaveLength(METRIC_WINDOW_DAYS);
    expect(s.days[s.days.length - 1]).toBe(new Date().toISOString().slice(0, 10));
    expect([...s.days].sort()).toEqual(s.days);
  });

  it("carries every status and priority, including ones sitting at zero today", async () => {
    // A bucket empty NOW may have held tickets last week. Keying the series off the live counts
    // would drop it entirely, and its card would render a blank chart over the movement worth
    // seeing.
    const s = await buildTicketMetricSeries({}, { OPEN: 1 }, { LOW: 1 });
    for (const key of ["OPEN", "IN_PROGRESS", "IN_REVIEW", "RESOLVED", "CLOSED", "REOPENED"]) {
      expect(s.byStatus[key]).toHaveLength(METRIC_WINDOW_DAYS);
    }
    for (const key of ["LOW", "MEDIUM", "HIGH", "CRITICAL"]) {
      expect(s.byPriority[key]).toHaveLength(METRIC_WINDOW_DAYS);
    }
  });

  it("ends on the live count it was seeded with — the invariant the card depends on", async () => {
    withTickets([{ id: "t-1", createdAt: daysAgo(2), status: "OPEN", priority: "HIGH" }]);
    const s = await buildTicketMetricSeries({}, { OPEN: 7, CLOSED: 2 }, { HIGH: 9 });
    expect(s.byStatus.OPEN.at(-1)).toBe(7);
    expect(s.byStatus.CLOSED.at(-1)).toBe(2);
    expect(s.byPriority.HIGH.at(-1)).toBe(9);
    expect(s.total.at(-1)).toBe(9);
  });
});

describe("undoing creations", () => {
  it("removes a ticket from every day before it existed", async () => {
    withTickets([{ id: "t-1", createdAt: daysAgo(3), status: "OPEN", priority: "HIGH" }]);
    const s = await buildTicketMetricSeries({}, { OPEN: 5 }, { HIGH: 5 });

    // Today and the two days after creation still count it; the day before creation does not.
    expect(s.byStatus.OPEN.at(-1)).toBe(5);
    expect(s.byStatus.OPEN.at(-4)).toBe(5);
    expect(s.byStatus.OPEN.at(-5)).toBe(4);
    expect(s.byPriority.HIGH.at(-5)).toBe(4);
  });

  it("never reports a negative count, whatever the events say", async () => {
    // Defensive: an audit trail that disagrees with the live counts (a ticket hard-deleted, an
    // import that back-dated rows) must degrade to zero rather than render a chart below the axis.
    withTickets([
      { id: "t-1", createdAt: daysAgo(1), status: "OPEN", priority: "LOW" },
      { id: "t-2", createdAt: daysAgo(1), status: "OPEN", priority: "LOW" }
    ]);
    const s = await buildTicketMetricSeries({}, { OPEN: 1 }, { LOW: 1 });
    expect(Math.min(...s.byStatus.OPEN)).toBeGreaterThanOrEqual(0);
    expect(Math.min(...s.byPriority.LOW)).toBeGreaterThanOrEqual(0);
  });
});

describe("undoing status transitions", () => {
  it("puts the ticket back in the status it came from", async () => {
    auditFindMany.mockResolvedValue([
      { entityId: "t-1", createdAt: daysAgo(2), metadata: { from: "OPEN", to: "RESOLVED" } }
    ]);
    withTickets([], [{ id: "t-1" }]);

    const s = await buildTicketMetricSeries({}, { OPEN: 4, RESOLVED: 1 }, { LOW: 5 });

    expect(s.byStatus.RESOLVED.at(-1)).toBe(1);
    // Before the transition it was OPEN, so OPEN is one higher and RESOLVED one lower.
    expect(s.byStatus.RESOLVED.at(-4)).toBe(0);
    expect(s.byStatus.OPEN.at(-4)).toBe(5);
    // The total is unchanged by a move — nothing was created or destroyed.
    expect(s.total.at(-4)).toBe(5);
  });

  it("replays two moves on one ticket in the right order", async () => {
    // OPEN -> IN_PROGRESS (4 days ago) -> RESOLVED (2 days ago). Walking backwards must land the
    // ticket in IN_PROGRESS between them, not skip straight to OPEN.
    auditFindMany.mockResolvedValue([
      { entityId: "t-1", createdAt: daysAgo(2), metadata: { from: "IN_PROGRESS", to: "RESOLVED" } },
      { entityId: "t-1", createdAt: daysAgo(4), metadata: { from: "OPEN", to: "IN_PROGRESS" } }
    ]);
    withTickets([], [{ id: "t-1" }]);

    const s = await buildTicketMetricSeries({}, { RESOLVED: 1 }, { LOW: 1 });

    // Every point is the END of its day, so a midday transition already counts on that day:
    // .at(-3) is two days ago (already RESOLVED), .at(-4) is three days ago (still IN_PROGRESS),
    // and OPEN only reappears before the first move, at .at(-6).
    expect(s.byStatus.RESOLVED.at(-1)).toBe(1);
    expect(s.byStatus.RESOLVED.at(-3)).toBe(1);
    expect(s.byStatus.IN_PROGRESS.at(-4)).toBe(1);
    expect(s.byStatus.RESOLVED.at(-4)).toBe(0);
    expect(s.byStatus.OPEN.at(-6)).toBe(1);
    expect(s.byStatus.IN_PROGRESS.at(-6)).toBe(0);
  });

  it("ignores movement on tickets the caller cannot see", async () => {
    // The audit table carries no project, so scope is enforced by vetting the ids it named. Without
    // that, a scoped user's sparkline would be nudged by work in projects they cannot open.
    auditFindMany.mockResolvedValue([
      { entityId: "mine", createdAt: daysAgo(2), metadata: { from: "OPEN", to: "RESOLVED" } },
      { entityId: "theirs", createdAt: daysAgo(2), metadata: { from: "OPEN", to: "RESOLVED" } }
    ]);
    withTickets([], [{ id: "mine" }]);

    const s = await buildTicketMetricSeries({}, { OPEN: 1, RESOLVED: 1 }, { LOW: 2 });

    // Only the visible transition is undone: OPEN 1 -> 2, not 1 -> 3.
    expect(s.byStatus.OPEN.at(-4)).toBe(2);
    expect(s.byStatus.RESOLVED.at(-4)).toBe(0);
  });

  it("skips an audit row whose metadata lost its from/to", async () => {
    auditFindMany.mockResolvedValue([{ entityId: "t-1", createdAt: daysAgo(2), metadata: { to: "RESOLVED" } }]);
    withTickets([], [{ id: "t-1" }]);
    const s = await buildTicketMetricSeries({}, { RESOLVED: 1 }, { LOW: 1 });
    expect(new Set(s.byStatus.RESOLVED)).toEqual(new Set([1]));
  });
});

describe("honesty flags", () => {
  it("marks the priority series approximate when something was re-prioritised in the window", async () => {
    auditCount.mockResolvedValue(3);
    const s = await buildTicketMetricSeries({}, { OPEN: 1 }, { HIGH: 1 });
    expect(s.priorityExact).toBe(false);
  });

  it("reports exact when nothing was re-prioritised", async () => {
    const s = await buildTicketMetricSeries({}, { OPEN: 1 }, { HIGH: 1 });
    expect(s.priorityExact).toBe(true);
    expect(s.truncated).toBe(false);
  });
});
