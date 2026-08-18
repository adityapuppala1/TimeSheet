/**
 * The weekly goal digest, and the judgement that makes it worth receiving: WHICH goals earn a line.
 *
 * V8 shipped Goals with no notification of any kind, and the ordinary failure of OKRs is not wrong
 * numbers — it is that nobody opens the page again after the quarter starts. A digest fixes that only
 * if it stays quiet when there is nothing to say; one that arrives every week regardless teaches people
 * it contains nothing, which is worse than silence.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const goalFindMany = vi.fn().mockResolvedValue([]);
const dispatchNotification = vi.fn().mockResolvedValue(undefined);
const measureGoal = vi.fn();
const isPlanningCapabilityAllowed = vi.fn().mockResolvedValue(true);

vi.mock("../../src/config/prisma.js", () => ({ prisma: { goal: { findMany: (...a: unknown[]) => goalFindMany(...a) } } }));
vi.mock("../../src/config/tenant-context.js", () => ({ requireTenantContext: () => ({ orgId: "org-1", orgSlug: "acme" }) }));
vi.mock("../../src/services/notify.service.js", () => ({ dispatchNotification: (...a: unknown[]) => dispatchNotification(...a) }));
vi.mock("../../src/services/goal-progress.service.js", () => ({ measureGoal: (...a: unknown[]) => measureGoal(...a) }));
vi.mock("../../src/services/plan-limits.service.js", () => ({
  isPlanningCapabilityAllowed: (...a: unknown[]) => isPlanningCapabilityAllowed(...a)
}));

const { sendGoalDigests } = await import("../../src/workers/goal-digest.worker.js");

const NOW = new Date("2026-08-18T08:00:00.000Z");
const owner = { id: "u-1", name: "Priya Raman", status: "ACTIVE", deletedAt: null, isAgent: false };

const goal = (over: Record<string, unknown> = {}) => ({
  id: "g-1",
  title: "Cut SLA breaches by half",
  ownerId: owner.id,
  progressSource: "SLA_ESCALATIONS",
  startDate: new Date("2026-07-01"),
  endDate: new Date("2026-09-30"),
  targetValue: null,
  manualProgressPct: null,
  owner,
  ...over
});

const healthy = { currentValue: 5, progressPct: 60, health: "ON_TRACK", unavailable: false, unavailableReason: null };

beforeEach(() => {
  vi.clearAllMocks();
  isPlanningCapabilityAllowed.mockResolvedValue(true);
  goalFindMany.mockResolvedValue([]);
  measureGoal.mockResolvedValue(healthy);
});

describe("it stays quiet when there is nothing to say", () => {
  it("sends nothing at all when every goal is on track with time left", async () => {
    goalFindMany.mockResolvedValue([goal()]);
    expect(await sendGoalDigests(NOW)).toBe(0);
    expect(dispatchNotification).not.toHaveBeenCalled();
  });

  it("sends nothing when the workspace's plan does not include goals", async () => {
    isPlanningCapabilityAllowed.mockResolvedValue(false);
    goalFindMany.mockResolvedValue([goal()]);
    expect(await sendGoalDigests(NOW)).toBe(0);
    // Not even the in-app row: an entitlement gate that only stopped the email would leave a
    // notification about a feature this workspace cannot open.
    expect(dispatchNotification).not.toHaveBeenCalled();
  });
});

describe("what earns a line", () => {
  it("a goal that is off track, with how far along it is", async () => {
    goalFindMany.mockResolvedValue([goal()]);
    measureGoal.mockResolvedValue({ ...healthy, health: "OFF_TRACK", progressPct: 32 });
    await sendGoalDigests(NOW);
    expect(dispatchNotification.mock.calls[0][0].body).toMatch(/off track, 32% of the way/);
  });

  it("a goal that is fine but whose period closes this week", async () => {
    goalFindMany.mockResolvedValue([goal({ endDate: new Date("2026-08-21T00:00:00.000Z") })]);
    await sendGoalDigests(NOW);
    expect(dispatchNotification.mock.calls[0][0].body).toMatch(/on track, and the period ends in 3 days/);
  });

  it("a goal that cannot be measured says so rather than being dropped", async () => {
    // "We cannot measure this" is information the owner can act on — usually by linking the goal to
    // something. Silently skipping it is how a goal stays unmeasurable all quarter.
    goalFindMany.mockResolvedValue([goal()]);
    measureGoal.mockResolvedValue({ ...healthy, unavailable: true, unavailableReason: "no approved hours in scope" });
    await sendGoalDigests(NOW);
    expect(dispatchNotification.mock.calls[0][0].body).toMatch(/not measurable yet: no approved hours in scope/);
  });
});

describe("who it writes to", () => {
  it("one message per person, however many of their goals need a look", async () => {
    goalFindMany.mockResolvedValue([goal({ id: "g-1" }), goal({ id: "g-2", title: "Ship the rewrite" })]);
    measureGoal.mockResolvedValue({ ...healthy, health: "AT_RISK" });

    await sendGoalDigests(NOW);

    expect(dispatchNotification).toHaveBeenCalledTimes(1);
    expect(dispatchNotification.mock.calls[0][0].title).toMatch(/2 of your goals/);
    expect(dispatchNotification.mock.calls[0][0].email.templateKey).toBe("goal.digest");
  });

  it("never writes to somebody who has left, or to an agent identity", async () => {
    measureGoal.mockResolvedValue({ ...healthy, health: "OFF_TRACK" });
    goalFindMany.mockResolvedValue([
      goal({ id: "g-1", owner: { ...owner, status: "INACTIVE" } }),
      goal({ id: "g-2", owner: { ...owner, id: "u-2", deletedAt: new Date() } }),
      // An identity with no mailbox cannot read a digest, and its goals are not its commitment.
      goal({ id: "g-3", owner: { ...owner, id: "u-3", isAgent: true } })
    ]);

    expect(await sendGoalDigests(NOW)).toBe(0);
    expect(dispatchNotification).not.toHaveBeenCalled();
  });
});
