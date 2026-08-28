/**
 * The two pure functions the whole managed-backup module rests on: when a policy is next due, and
 * which stored backups a retention rule keeps.
 *
 * Both are tested here rather than through the scheduler because they are where a mistake is
 * SILENT. A wrong `nextRunAt` turns a daily backup into an hourly one (or into none) and nothing
 * complains; a wrong `planRetention` deletes the last good copy of a customer's database and the
 * pass reports success. Neither failure surfaces until somebody needs the backup.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/config/control-prisma.js", () => ({ controlPrisma: {} }));
vi.mock("../../src/config/prisma.js", () => ({ prisma: {}, disconnectAllTenantClients: vi.fn() }));
vi.mock("../../src/services/backup-destination.service.js", () => ({ adapterFor: vi.fn() }));
vi.mock("../../src/services/platform-mail.service.js", () => ({ sendPlatformMail: vi.fn() }));
vi.mock("../../src/services/platform-audit.service.js", () => ({ platformAudit: vi.fn() }));

const { nextRunAt, planRetention } = await import("../../src/services/backup.service.js");
const { backupFrequencyAllowed, allowedBackupFrequencies, PLAN_TIER_LIMITS } = await import("@timesheet/shared");

const at = (iso: string) => new Date(iso);

describe("nextRunAt", () => {
  it("returns nothing for a policy that is switched off", () => {
    expect(nextRunAt({ frequency: "NONE", hourUtc: 2, dayOfWeek: 0 }, at("2026-08-29T09:00:00Z"))).toBeNull();
  });

  it("hourly moves to the top of the next hour", () => {
    expect(nextRunAt({ frequency: "HOURLY", hourUtc: 2, dayOfWeek: 0 }, at("2026-08-29T09:41:12Z")).toISOString()).toBe("2026-08-29T10:00:00.000Z");
  });

  it("daily lands on the configured UTC hour, today if it is still ahead", () => {
    expect(nextRunAt({ frequency: "DAILY", hourUtc: 2, dayOfWeek: 0 }, at("2026-08-29T01:10:00Z")).toISOString()).toBe("2026-08-29T02:00:00.000Z");
  });

  it("daily rolls to tomorrow once the hour has passed", () => {
    expect(nextRunAt({ frequency: "DAILY", hourUtc: 2, dayOfWeek: 0 }, at("2026-08-29T09:00:00Z")).toISOString()).toBe("2026-08-30T02:00:00.000Z");
  });

  it("weekly lands on the configured weekday", () => {
    // 2026-08-29 is a Saturday; dayOfWeek 0 is Sunday, so the next one is the 30th.
    expect(nextRunAt({ frequency: "WEEKLY", hourUtc: 3, dayOfWeek: 0 }, at("2026-08-29T09:00:00Z")).toISOString()).toBe("2026-08-30T03:00:00.000Z");
  });

  it("weekly rolls a whole week when today IS the day and the hour has gone", () => {
    // Sunday 09:00, wanting Sunday 03:00 — the slot has passed, so it is next Sunday, not today.
    expect(nextRunAt({ frequency: "WEEKLY", hourUtc: 3, dayOfWeek: 0 }, at("2026-08-30T09:00:00Z")).toISOString()).toBe("2026-09-06T03:00:00.000Z");
  });

  it("is always STRICTLY after the moment asked about", () => {
    // The bug this pins: a boundary-inclusive version re-fires the slot that just ran, turning a
    // daily backup into one per tick for as long as the process stays up.
    const exactly = at("2026-08-29T02:00:00Z");
    expect(nextRunAt({ frequency: "DAILY", hourUtc: 2, dayOfWeek: 0 }, exactly).getTime()).toBeGreaterThan(exactly.getTime());
    expect(nextRunAt({ frequency: "WEEKLY", hourUtc: 2, dayOfWeek: 6 }, exactly).getTime()).toBeGreaterThan(exactly.getTime());
  });
});

/** `n` runs, one per day, newest first. */
function daily(n: number, from = "2026-08-29T02:00:00Z") {
  const start = new Date(from).getTime();
  return Array.from({ length: n }, (_, i) => ({ id: `r${i}`, startedAt: new Date(start - i * 86_400_000), objectKey: `k${i}` }));
}

const RULES = { retentionMode: "COUNT" as const, keepCount: 7, keepDays: 30, gfsDaily: 7, gfsWeekly: 4, gfsMonthly: 12, gfsYearly: 3 };

describe("planRetention — COUNT", () => {
  it("keeps the newest N and drops the rest", () => {
    const decision = planRetention(daily(10), { ...RULES, keepCount: 3 });
    expect(decision.keep.map((k) => k.id)).toEqual(["r0", "r1", "r2"]);
    expect(decision.drop).toHaveLength(7);
  });

  it("keeps everything when there are fewer than the ceiling", () => {
    expect(planRetention(daily(2), { ...RULES, keepCount: 7 }).drop).toEqual([]);
  });
});

describe("planRetention — AGE", () => {
  const now = at("2026-08-29T12:00:00Z");

  it("keeps what is inside the window", () => {
    const decision = planRetention(daily(20), { ...RULES, retentionMode: "AGE", keepDays: 5 }, now);
    expect(decision.keep).toHaveLength(5);
    expect(decision.drop).toHaveLength(15);
  });

  it("NEVER drops the last one, however old it is", () => {
    // The failure this prevents: a workspace goes quiet, every backup ages out, and the policy
    // deletes the only copy of its database on a schedule.
    const ancient = [{ id: "old", startedAt: at("2020-01-01T00:00:00Z"), objectKey: "k" }];
    const decision = planRetention(ancient, { ...RULES, retentionMode: "AGE", keepDays: 7 }, now);
    expect(decision.keep.map((k) => k.id)).toEqual(["old"]);
    expect(decision.drop).toEqual([]);
  });
});

describe("planRetention — GFS", () => {
  const rules = { ...RULES, retentionMode: "GFS" as const, gfsDaily: 3, gfsWeekly: 2, gfsMonthly: 2, gfsYearly: 1 };

  it("promotes one object into each slot rather than keeping four copies", () => {
    const decision = planRetention(daily(60), rules);
    // Three dailies, then the weeklies/monthlies/yearlies the older ones satisfy — never more than
    // the slot budget, and every kept run carries the tag that saved it.
    expect(decision.keep.length).toBeLessThanOrEqual(3 + 2 + 2 + 1);
    expect(decision.keep.every((k) => ["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(k.tag ?? ""))).toBe(true);
    expect(decision.keep.filter((k) => k.tag === "DAILY")).toHaveLength(3);
  });

  it("gives the newest backup the DAILY tag, not a longer-lived one", () => {
    // The newest fills the first slot it can, and the slots are ordered shortest-lived first.
    expect(planRetention(daily(30), rules).keep[0].tag).toBe("DAILY");
  });

  it("keeps only one backup per day, per week, per month", () => {
    // Two runs on the same day: the second cannot take a second DAILY slot.
    const sameDay = [
      { id: "a", startedAt: at("2026-08-29T02:00:00Z"), objectKey: "a" },
      { id: "b", startedAt: at("2026-08-29T14:00:00Z"), objectKey: "b" }
    ];
    const decision = planRetention(sameDay, { ...rules, gfsDaily: 5, gfsWeekly: 0, gfsMonthly: 0, gfsYearly: 0 });
    expect(decision.keep).toHaveLength(1);
    expect(decision.keep[0].id).toBe("b");
    expect(decision.drop.map((d) => d.id)).toEqual(["a"]);
  });

  it("keeps the newest even when every slot budget is zero", () => {
    const decision = planRetention(daily(5), { ...rules, gfsDaily: 0, gfsWeekly: 0, gfsMonthly: 0, gfsYearly: 0 });
    expect(decision.keep).toHaveLength(1);
    expect(decision.drop).toHaveLength(4);
  });

  it("drops nothing when there is nothing to drop", () => {
    expect(planRetention([], rules).keep).toEqual([]);
    expect(planRetention([], rules).drop).toEqual([]);
  });
});

describe("the tier ceiling", () => {
  it("is the shape the plans were asked for: Starter none, Team weekly, Enterprise daily", () => {
    expect(PLAN_TIER_LIMITS.STARTER.backupFrequency).toBe("NONE");
    expect(PLAN_TIER_LIMITS.TEAM.backupFrequency).toBe("WEEKLY");
    expect(PLAN_TIER_LIMITS.ENTERPRISE.backupFrequency).toBe("DAILY");
  });

  it("only Enterprise gets test restores, and only Enterprise gets more than one destination", () => {
    expect(PLAN_TIER_LIMITS.STARTER.backupPitrEnabled).toBe(false);
    expect(PLAN_TIER_LIMITS.TEAM.backupPitrEnabled).toBe(false);
    expect(PLAN_TIER_LIMITS.ENTERPRISE.backupPitrEnabled).toBe(true);
    expect(PLAN_TIER_LIMITS.STARTER.maxBackupDestinations).toBe(0);
    expect(PLAN_TIER_LIMITS.TEAM.maxBackupDestinations).toBe(1);
    expect(PLAN_TIER_LIMITS.ENTERPRISE.maxBackupDestinations).toBeGreaterThan(1);
  });

  it("permits any cadence at or below the ceiling and refuses everything above it", () => {
    expect(backupFrequencyAllowed("WEEKLY", "DAILY")).toBe(true);
    expect(backupFrequencyAllowed("DAILY", "DAILY")).toBe(true);
    expect(backupFrequencyAllowed("HOURLY", "DAILY")).toBe(false);
    expect(backupFrequencyAllowed("WEEKLY", "NONE")).toBe(false);
    // NONE is always allowed — switching the module off is not an upgrade.
    expect(backupFrequencyAllowed("NONE", "NONE")).toBe(true);
  });

  it("offers a tier exactly the cadences it may pick, most frequent first", () => {
    expect(allowedBackupFrequencies("DAILY")).toEqual(["DAILY", "WEEKLY", "NONE"]);
    expect(allowedBackupFrequencies("WEEKLY")).toEqual(["WEEKLY", "NONE"]);
    expect(allowedBackupFrequencies("NONE")).toEqual(["NONE"]);
  });
});
