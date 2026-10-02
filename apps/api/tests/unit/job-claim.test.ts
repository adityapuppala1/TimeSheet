/**
 * Every scheduled job runs ONCE PER DEPLOYMENT, however many API replicas are scheduling it.
 *
 * The Helm chart ships two replicas with an autoscaler on top, and every replica starts every cron
 * worker. Before this, each tick ran on every pod: scheduled reports, trial and retention emails and
 * reminders went out twice, and two inbound-mail pollers read the same unseen messages and opened
 * the same ticket twice. Pinned here:
 *  - two replicas firing the same tick run the body once;
 *  - a tick that outlasts its period is not overlapped by another replica's next tick (what each
 *    worker's in-process `running` flag already promised, lifted to the deployment);
 *  - a lease left behind by a replica that died mid-run does not block the job forever;
 *  - a day is the PLATFORM zone's day, not UTC's; a minute or an hour is the UTC instant's, so the
 *    hour a daylight-saving zone repeats in autumn is two periods, not one;
 *  - the claim rows are pruned, so a table written every minute does not grow forever.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Row = { job: string; periodKey: string; claimedAt: Date };
const rows: Row[] = [];
const sameKey = (a: { job: string; periodKey: string }, b: { job: string; periodKey: string }) => a.job === b.job && a.periodKey === b.periodKey;

type Where = { job?: string; periodKey?: string; claimedAt?: Date | { lt: Date } };
function matches(row: Row, where: Where): boolean {
  if (where.job !== undefined && row.job !== where.job) return false;
  if (where.periodKey !== undefined && row.periodKey !== where.periodKey) return false;
  if (where.claimedAt instanceof Date) return row.claimedAt.getTime() === where.claimedAt.getTime();
  if (where.claimedAt?.lt) return row.claimedAt.getTime() < where.claimedAt.lt.getTime();
  return true;
}

/** A primary key that behaves like MySQL's under INSERT IGNORE — with a microtask yield first, so two
 *  concurrent callers interleave the way two replicas do. */
const platformJobClaim = {
  createMany: vi.fn(async ({ data, skipDuplicates }: { data: Array<{ job: string; periodKey: string; claimedAt?: Date }>; skipDuplicates?: boolean }) => {
    await Promise.resolve();
    let count = 0;
    for (const entry of data) {
      if (rows.some((row) => sameKey(row, entry))) {
        if (!skipDuplicates) throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
        continue;
      }
      rows.push({ job: entry.job, periodKey: entry.periodKey, claimedAt: entry.claimedAt ?? new Date() });
      count += 1;
    }
    return { count };
  }),
  deleteMany: vi.fn(async ({ where }: { where: Where }) => {
    await Promise.resolve();
    const before = rows.length;
    for (let i = rows.length - 1; i >= 0; i -= 1) if (matches(rows[i], where)) rows.splice(i, 1);
    return { count: before - rows.length };
  }),
  updateMany: vi.fn(async ({ where, data }: { where: Where; data: { claimedAt: Date } }) => {
    await Promise.resolve();
    const hit = rows.filter((row) => matches(row, where));
    for (const row of hit) row.claimedAt = data.claimedAt;
    return { count: hit.length };
  })
};
vi.mock("../../src/config/control-prisma.js", () => ({ controlPrisma: { platformJobClaim } }));
// The platform's zone, as config/env.ts defaults it: India, UTC+5:30 — far enough from UTC that its
// day and UTC's disagree for five and a half hours of every day.
vi.mock("../../src/config/env.js", () => ({ env: { TZ: "Asia/Kolkata" } }));

const { claimJobPeriod, pruneJobClaims, runOncePerTick, tickPeriodKey } = await import("../../src/services/job-claim.service.js");

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const tick = new Date("2026-10-02T03:40:00Z"); // 09:10 in India

beforeEach(() => {
  rows.length = 0;
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("tickPeriodKey", () => {
  it("names a day by the platform's calendar, and a minute or an hour by the UTC instant", () => {
    expect(tickPeriodKey(tick, "day")).toBe("2026-10-02");
    // 03:40 UTC is 09:10 in India. A minute or an hour is the same length in every zone, so the
    // instant names it — the `Z` says so, and keeps it from ever equalling a key written in the old
    // local-time format (claims made before this changed are pruned like any other, by age).
    expect(tickPeriodKey(tick, "hour")).toBe("2026-10-02T03Z");
    expect(tickPeriodKey(tick, "minute")).toBe("2026-10-02T03:40Z");
  });

  it("rolls the day over at the platform's midnight, not UTC's", () => {
    // 19:00 UTC on the 1st is already 00:30 on the 2nd in India.
    expect(tickPeriodKey(new Date("2026-10-01T19:00:00Z"), "day")).toBe("2026-10-02");
  });

  it("gives the hour a daylight-saving zone repeats in autumn two different minute and hour keys", async () => {
    // 25 Oct 2026, Europe/London: clocks go back at 02:00 BST, so 01:00-01:59 happens twice. Named in
    // local time, the second pass reused the first pass's keys and every minute and hour job (the
    // mail queue, inbound mail, SLA sweeps, backups, scheduled reports) stood down for that hour.
    const { env } = await import("../../src/config/env.js");
    const zone = env.TZ;
    env.TZ = "Europe/London";
    try {
      const firstPass = new Date("2026-10-25T00:30:00Z"); // 01:30 BST
      const secondPass = new Date("2026-10-25T01:30:00Z"); // 01:30 GMT
      expect(tickPeriodKey(secondPass, "minute")).not.toBe(tickPeriodKey(firstPass, "minute"));
      expect(tickPeriodKey(secondPass, "hour")).not.toBe(tickPeriodKey(firstPass, "hour"));
      // One calendar day all the same, so a daily job still runs once.
      expect(tickPeriodKey(secondPass, "day")).toBe(tickPeriodKey(firstPass, "day"));
    } finally {
      env.TZ = zone;
    }
  });
});

describe("claimJobPeriod", () => {
  it("is true once and false after, for the same job and period", async () => {
    expect(await claimJobPeriod("report-subscriptions", "2026-10-02T09")).toBe(true);
    expect(await claimJobPeriod("report-subscriptions", "2026-10-02T09")).toBe(false);
    expect(await claimJobPeriod("report-subscriptions", "2026-10-02T10")).toBe(true);
  });

  it("refuses a key the column would silently truncate into somebody else's", async () => {
    // INSERT IGNORE turns "data too long" into a truncation, so two long names could collide.
    await expect(claimJobPeriod("x".repeat(65), "2026-10-02")).rejects.toThrow(/too long/);
  });
});

describe("runOncePerTick — two replicas, one deployment", () => {
  it("runs the body once when two replicas fire the same tick at the same moment", async () => {
    const body = vi.fn(async () => undefined);

    const [a, b] = await Promise.all([runOncePerTick("trial-lifecycle", "day", body, tick), runOncePerTick("trial-lifecycle", "day", body, tick)]);

    expect(body).toHaveBeenCalledTimes(1);
    expect([a, b].sort()).toEqual([false, true]);
  });

  it("runs the body once when the second replica fires after the first has finished", async () => {
    const body = vi.fn(async () => undefined);

    expect(await runOncePerTick("report-subscriptions", "hour", body, tick)).toBe(true);
    // Clock skew between pods: the second one fires a moment later, after the first released its
    // lease. The period claim is what still says "done".
    expect(await runOncePerTick("report-subscriptions", "hour", body, new Date(tick.getTime() + 900))).toBe(false);

    expect(body).toHaveBeenCalledTimes(1);
  });

  it("runs again on the next period", async () => {
    const body = vi.fn(async () => undefined);
    await runOncePerTick("mail-queue", "minute", body, tick);
    await runOncePerTick("mail-queue", "minute", body, new Date(tick.getTime() + MINUTE));
    expect(body).toHaveBeenCalledTimes(2);
  });

  it("does not let another replica start the next tick while this one is still running", async () => {
    let finish!: () => void;
    const slow = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const next = vi.fn(async () => undefined);

    const first = runOncePerTick("email-intake", "minute", slow, tick);
    await vi.waitFor(() => expect(slow).toHaveBeenCalled());

    // A minute later, on the other pod. Without the lease it would read the same unseen messages the
    // first poll is still working through, and open their tickets a second time.
    expect(await runOncePerTick("email-intake", "minute", next, new Date(tick.getTime() + MINUTE))).toBe(false);
    expect(next).not.toHaveBeenCalled();

    finish();
    expect(await first).toBe(true);
    // Released, so the minute after that runs normally.
    expect(await runOncePerTick("email-intake", "minute", next, new Date(tick.getTime() + 2 * MINUTE))).toBe(true);
  });

  it("releases the lease when the body throws, and lets the error reach the worker's own catch", async () => {
    await expect(runOncePerTick("backup", "hour", async () => Promise.reject(new Error("dump failed")), tick)).rejects.toThrow("dump failed");
    expect(rows.some((row) => row.periodKey === "lease")).toBe(false);
  });

  it("takes over a lease a dead replica left behind, once it has gone stale", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(tick);
    // A pod that was killed mid-run never released this.
    rows.push({ job: "tick:agent-run", periodKey: "lease", claimedAt: new Date(tick.getTime() - 20 * MINUTE) });
    const body = vi.fn(async () => undefined);

    expect(await runOncePerTick("agent-run", "minute", body, tick)).toBe(true);
    expect(body).toHaveBeenCalledTimes(1);
  });

  it("keeps a long run's lease fresh, so it is never mistaken for a dead one", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(tick);
    let finish!: () => void;
    const long = runOncePerTick("backup", "hour", () => new Promise<void>((resolve) => (finish = resolve)), tick);
    await vi.waitFor(() => expect(rows.some((row) => row.periodKey === "lease")).toBe(true));

    // Twenty minutes into a large mysqldump — well past the staleness window.
    await vi.advanceTimersByTimeAsync(20 * MINUTE);
    const intruder = vi.fn(async () => undefined);
    expect(await runOncePerTick("backup", "hour", intruder, new Date(tick.getTime() + 60 * MINUTE))).toBe(false);
    expect(intruder).not.toHaveBeenCalled();

    finish();
    expect(await long).toBe(true);
  });

  it("skips the tick, rather than running it unguarded, when the claim table cannot be reached", async () => {
    platformJobClaim.createMany.mockRejectedValueOnce(new Error("control plane unreachable"));
    const body = vi.fn(async () => undefined);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    expect(await runOncePerTick("sla", "minute", body, tick)).toBe(false);

    expect(body).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it("namespaces its rows, so a job that claims its own periods inside the body is not refused by the wrapper", async () => {
    // signup-digest's body claims ("signup-digest", day) itself; the tick claim must not take that key.
    await runOncePerTick("signup-digest", "day", async () => {
      expect(await claimJobPeriod("signup-digest", "2026-10-02")).toBe(true);
    }, tick);
    expect(rows.map((row) => `${row.job}|${row.periodKey}`).sort()).toEqual(["signup-digest|2026-10-02", "tick:signup-digest|2026-10-02"]);
  });
});

describe("pruneJobClaims", () => {
  it("deletes claims older than the window and keeps recent ones and live leases", async () => {
    const now = new Date("2026-10-10T00:00:00Z");
    rows.push(
      { job: "tick:mail-queue", periodKey: "2026-10-01T09:10", claimedAt: new Date(now.getTime() - 9 * DAY) },
      { job: "signup-digest", periodKey: "2026-10-02", claimedAt: new Date(now.getTime() - 8 * DAY) },
      { job: "tick:mail-queue", periodKey: "2026-10-09T09:10", claimedAt: new Date(now.getTime() - DAY) },
      { job: "tick:backup", periodKey: "lease", claimedAt: new Date(now.getTime() - MINUTE) }
    );

    expect(await pruneJobClaims(now)).toBe(2);
    expect(rows.map((row) => row.periodKey).sort()).toEqual(["2026-10-09T09:10", "lease"]);
  });
});
